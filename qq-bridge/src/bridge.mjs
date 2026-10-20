/**
 * QQ ↔ DSH 桥接主逻辑。
 *
 * 数据流：
 *   QQ 消息 → NapCat(OneBot v11 正向 WS) → onebot.mjs
 *          → 白名单/安全校验 → 每会话一个 DSH 会话 → dsh.mjs 投递
 *          → 轮询 turnOutline 取回复 → 安全审计 → 发回 QQ
 *
 * 安全边界（对齐 qq-bridge 的 RULES.md 思路）：
 *   1. QQ 会话一律用 minimal preset（只有 readImage，无 bash/写文件/edit）
 *   2. 白名单外的一律不理
 *   3. 回复文本含本机路径或凭据特征 → 整条拦下
 *   4. 同一 QQ 会话串行投递（否则回复对不上号）
 */
import fs from 'node:fs'
import path from 'node:path'
import { OneBotClient } from './onebot.mjs'
import { DshClient } from './dsh.mjs'

/** 回复审计：命中即整条不发。宁可少说，不可泄漏。 */
const LEAK_PATTERNS = [
  { re: /[A-Za-z]:\\/, label: '本机路径' },
  { re: /\/(?:home|Users|root)\//i, label: '本机路径' },
  { re: /\.credentials\.ya?ml/i, label: '凭据文件' },
  { re: /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd)\b\s*[:=]\s*\S+/i, label: '凭据特征' },
  { re: /\bsk-[A-Za-z0-9_-]{16,}/, label: 'API Key' },
]

/**
 * @param {string} text 待发回 QQ 的回复
 * @param {string[]} [secrets] 运行时凭据（如 onebot.accessToken）。
 *   出现即整条拦下。不把某个部署的令牌焊进正则，换令牌不用改源码。
 */
export function auditReply(text, secrets = []) {
  for (const { re, label } of LEAK_PATTERNS) {
    if (re.test(text)) return { ok: false, label }
  }
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6 && text.includes(secret)) {
      return { ok: false, label: '桥接令牌' }
    }
  }
  return { ok: true }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 每会话串行队列：同一 key 的投递绝不并发，否则回复会串线。 */
class SerialQueues {
  constructor() { this.map = new Map() }
  run(key, task) {
    const prev = this.map.get(key) ?? Promise.resolve()
    const next = prev.then(task, task)
    // 记录链尾但吞掉异常，避免一次失败卡死后续队列。
    this.map.set(key, next.catch(() => {}))
    return next
  }
  get busy() { return this.map.size }
}

export class Bridge {
  constructor({ config, logger }) {
    this.config = config
    this.logger = logger ?? console
    this.statePath = path.resolve(config.stateFile ?? './state/sessions.json')
    this.state = this._loadState()
    this.queues = new SerialQueues()
    this.inflight = new Map() // 会话 key -> 正在处理的 Promise
    // 运行期配置：config.json 给初值，DSH 设置页可热覆盖（见 startConfigPolling）。
    // 必须是一个**共享的可变对象**——轮询原地改它，各读取点每次现读，无需重建客户端。
    this.live = {
      chunkSize: config.chunkSize,
      bubbleMaxChars: config.bubbleMaxChars,
      mergeMaxChars: config.mergeMaxChars,
      sendIntervalMs: config.sendIntervalMs,
      typingDelay: { enabled: config.typingDelay?.enabled !== false, ...(config.typingDelay ?? {}) },
      flypitDelayTiers: { ...(config.flypitDelayTiers ?? {}) },
      trimEndPunctuation: {
        enabled: config.trimEndPunctuation?.enabled !== false,
        keep: config.trimEndPunctuation?.keep,
      },
      groupAtReply: config.groupAtReply !== false,
      groupAtPosition: config.groupAtPosition === 'first' ? 'first' : 'last',
      // 白名单：每次判定时现读（见 isAllowed），这里给初值。
      allow: {
        private: Array.isArray(config.allow?.private) ? config.allow.private.map(String) : [],
        groups: Array.isArray(config.allow?.groups) ? config.allow.groups.map(String) : [],
        deny: {
          private: Array.isArray(config.allow?.deny?.private) ? config.allow.deny.private.map(String) : [],
          groups: Array.isArray(config.allow?.deny?.groups) ? config.allow.deny.groups.map(String) : [],
        },
        allowAllWhenEmpty: config.allow?.allowAllWhenEmpty === true,
      },
      // 人设：非空时覆盖 preset 默认人设（注入方式见 src/persona.mjs）。
      personaText: typeof config.personaText === 'string' ? config.personaText : '',
      // OneBot 连接信息（只读展示用；改它要重启桥接）。
      onebot: {
        wsUrl: config.onebot?.wsUrl ?? '',
        accessToken: config.onebot?.accessToken ?? '',
      },
    }
    this.dsh = new DshClient({ baseUrl: config.dsh.baseUrl, logger: this.logger })
    this.qq = new OneBotClient({
      wsUrl: config.onebot.wsUrl,
      accessToken: config.onebot.accessToken,
      logger: this.logger,
    })
    // 用 live 里的当前值覆盖客户端的默认值（构造完再同步一次，热更新走同一路径）。
    this._applyLiveToClient()
    this.stats = { received: 0, replied: 0, blocked: 0, denied: 0, failed: 0 }
  }

  /** 把 this.live 的当前值同步到 OneBotClient 实例（轮询回调里也会调）。 */
  _applyLiveToClient() {
    const qq = this.qq
    const live = this.live
    if (!qq) return
    qq.chunkSize = live.chunkSize
    qq.bubbleMaxChars = live.bubbleMaxChars
    qq.mergeMaxChars = live.mergeMaxChars
    qq.sendIntervalMs = live.sendIntervalMs
    qq.typingDelayEnabled = live.typingDelay?.enabled !== false
    qq.groupAtReply = live.groupAtReply !== false
    qq.groupAtPosition = live.groupAtPosition === 'first' ? 'first' : 'last'
    if (live.trimEndPunctuation?.keep !== undefined) qq.keepEndPunct = live.trimEndPunctuation.keep
    qq.trimEndPunctuation = live.trimEndPunctuation?.enabled !== false
  }

  _loadState() {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf8')
      const parsed = JSON.parse(raw)
      return { sessions: parsed.sessions ?? {}, generation: parsed.generation ?? 0 }
    } catch { return { sessions: {}, generation: 0 } }
  }

  _saveState() {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
    const tmp = this.statePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    fs.renameSync(tmp, this.statePath)
  }

  /** 会话 key：私聊 u:<QQ号>，群聊 g:<群号>。 */
  keyOf(msg) {
    return msg.kind === 'private' ? `u:${msg.userId}` : `g:${msg.groupId}`
  }

  /**
   * 白名单：deny 优先于 allow；allow 为空且 allowAllWhenEmpty=false 时全部拒绝（fail-closed）。
   *
   * ⚠️ 必须**每次现读**热配置（this.live.allow），不能在构造时缓存：
   * 用户在 DSH 设置页改白名单后，下一条消息就要按新值判定。
   * 只有热配置里没有这个键（从未同步过）时才回落到 config.json。
   */
  isAllowed(msg) {
    const hot = this.live?.allow
    const a = (hot && typeof hot === 'object' && !Array.isArray(hot))
      ? hot
      : (this.config.allow ?? {})
    const norm = (list) => (Array.isArray(list) ? list.map(String) : [])
    if (msg.kind === 'private') {
      if (norm(a.deny?.private).includes(String(msg.userId))) return false
      const wl = norm(a.private)
      if (wl.includes(String(msg.userId))) return true
      return wl.length === 0 && a.allowAllWhenEmpty === true
    }
    if (norm(a.deny?.groups).includes(String(msg.groupId))) return false
    const wl = norm(a.groups)
    if (wl.includes(String(msg.groupId))) return true
    return wl.length === 0 && a.allowAllWhenEmpty === true
  }

  /** 取或建该 QQ 会话对应的 DSH 会话。 */
  async ensureSession(key) {
    const mapped = this.state.sessions[key]
    if (mapped) {
      if (await this.dsh.sessionExists(mapped)) return mapped
      this.logger.warn?.(`会话 ${key} 在 DSH 侧已不存在，重建`)
      delete this.state.sessions[key]
      this._saveState()
    }
    const { sessionCwd, workspaceTitle } = this.config.dsh
    fs.mkdirSync(sessionCwd, { recursive: true })
    const workspaceId = await this.dsh.ensureWorkspace(sessionCwd, workspaceTitle)
    const sessionId = await this.dsh.createSession(workspaceId, this.config.dsh.agentPreset)
    const { provider, model, reasoningEffort } = this.config.dsh
    if (provider && model) {
      await this.dsh.selectModel(sessionId, provider, model, reasoningEffort).catch((e) =>
        this.logger.warn?.(`selectModel 失败（不阻塞）：${e.message}`))
    }
    this.state.sessions[key] = sessionId
    this._saveState()
    this.logger.info?.(`新会话 ${key} -> ${sessionId}`)
    return sessionId
  }

  async handleMessage(msg) {
    this.stats.received++
    if (!this.isAllowed(msg)) {
      this.stats.denied++
      this.logger.warn?.(`白名单外，忽略：${this.keyOf(msg)}`)
      return
    }
    // 空文本（纯图片/表情）暂时只记日志。
    const text = (msg.text ?? '').trim()
    if (!text) {
      this.logger.info?.(`收到空文本消息（${this.keyOf(msg)}），跳过`)
      return
    }
    const key = this.keyOf(msg)
    await this.queues.run(key, async () => {
      const started = Date.now()
      try {
        const sessionId = await this.ensureSession(key)
        const reply = await this.dsh.promptAndWait(sessionId, text, {
          timeoutMs: this.config.replyTimeoutMs ?? 180000,
        })
        const audit = auditReply(reply, [this.config.onebot?.accessToken])
        if (!audit.ok) {
          this.stats.blocked++
          this.logger.warn?.(`回复命中「${audit.label}」，已拦截不发送`)
          await this._send(msg, '（本次回复被安全策略拦截，未发送）')
          return
        }
        const sent = await this._send(msg, reply)
        // replied 只统计**真的发回 QQ 成功**的轮次；发送失败已由 _send 计入 failed。
        if (sent && sent.ok === false) {
          this.logger.warn?.(`回复已生成但 QQ 发送失败 ${key}（${Date.now() - started}ms）`)
        } else {
          this.stats.replied++
          this.logger.info?.(`已回复 ${key}（${Date.now() - started}ms，${reply.length} 字）`)
        }
      } catch (error) {
        this.stats.failed++
        this.logger.error?.(`处理 ${key} 失败：${error?.message ?? error}`)
      }
    })
  }

  async _send(msg, text) {
    const delay = this.config.sendDelayMs ?? 400
    const key = this.keyOf(msg)
    // 群聊 @ 发送者：按 groupAtReply / groupAtPosition 决定，私聊一律不带 @。
    const atOpts = (this.qq.groupAtReply && msg.kind === 'group')
      ? { atUserId: msg.userId, atPosition: this.qq.groupAtPosition }
      : {}
    const result = msg.kind === 'private'
      ? await this.qq.sendPrivate(msg.userId, text)
      : await this.qq.sendGroup(msg.groupId, text, atOpts)
    // 分片级失败：已成功的分片不重复发送，这里只如实上报，不整条重试。
    if (result && result.ok === false) {
      this.stats.failed++
      const at = result.failedIndex === undefined
        ? '（未发出任何分片）'
        : `第 ${result.failedIndex}/${result.total} 片`
      this.logger.error?.(`QQ 发送失败 ${key} ${at}：${result.error ?? '未知原因'}`)
    }
    if (delay > 0) await sleep(delay)
    return result
  }

  async start() {
    // 去重由 OneBotClient 内部按 message_id 负责（_isDuplicate），这里不再重复维护。
    this.qq.onMessage((msg) => {
      this.handleMessage(msg).catch((e) => this.logger.error?.(`handleMessage 异常：${e?.message ?? e}`))
    })
    await this.qq.start()
    // 只做只读探活，确认 DSH 可达；不可达时桥接仍会启动，等 DSH 恢复。
    try {
      await this.dsh.call('agentPresets/list', {})
      this.logger.info?.('DSH 鉴权与连通性检查通过')
    } catch (e) {
      this.logger.warn?.(`DSH 暂不可达：${e.message}（收到消息时会重试）`)
    }
  }

  async stop() {
    await this.qq.stop?.()
  }
}
