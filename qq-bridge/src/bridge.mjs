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
 *
 * 节奏参数（Phase 4）：响应档位 / 防抖 / 限频 / 禁言都从热配置现读，
 * 见 {@link Bridge._rhythm} 与 {@link Bridge.shouldRespond}。
 * 会话失效（DSH 侧已不存在）时 best-effort 归档旧会话，失败只记 `state.stale`，
 * 由 Host 调 {@link Bridge.cleanupStale} 重试。
 */
import fs from 'node:fs'
import path from 'node:path'
import { OneBotClient } from './onebot.mjs'
import { DshClient } from './dsh.mjs'
import { readDefaultPersona } from './persona.mjs'

/** 参与度档位：UI 里的三个选项，最终都会变成系统提示词里的一行规则。 */
export const PERSONA_PARTICIPATION = {
  quiet: { label: '安静型', rule: '只在被 @ 或私聊时开口；其余时候尽量不插话，能不说就不说。' },
  normal: { label: '普通群友', rule: '正常接话，不主动刷屏，也不刻意潜水。' },
  active: { label: '活跃型', rule: '可以主动接话、偶尔发起话题；但别连续刷屏，一次只说一两句。' },
}

/**
 * 拼最终系统提示词（人设）。这是桥接层唯一的组装入口：
 *
 *   · `personaSystemPrompt` 非空 → 完整覆盖，其余字段一律不追加（“留空=用内置”）；
 *   · 否则用 `personaText`（自定义角色设定），为空时回落到 preset 默认人设；
 *   · 机器人名字 / 群内展示名 → 身份行 + 替换默认人设里的 DeepSeek 字样；
 *   · 参与度 → 追加一行行为规则；
 *   · 管理员附加规则 → 追加到末尾。
 *
 * 全都没设置时返回空串，调用方据此删除 preset 覆盖、恢复默认。
 *
 * @param {object} [options]
 * @returns {string}
 */
export function composePersonaPrompt({
  systemPrompt = '', baseText = '', defaultText = '',
  botName = '', groupName = '', participation = 'normal', extraRules = '',
  modelRoute = '',
} = {}) {
  const override = String(systemPrompt ?? '').trim()
  const route = String(modelRoute ?? '').trim()
  // 模型自我认知：QQ 用户问「你用的什么模型」时能如实回答。
  // 只写路由，不写厂商营销词——真实值来自设置页下发的 provider/model。
  const modelLine = route === ''
    ? ''
    : `【底层模型】你当前由 DSH（DeepSeek Harness）提供驱动，底层模型路由为 ${route}。`
      + '用户问起你用的是什么模型时，照这个路由回答；不要编造别的型号，也不要透露其它系统配置。'

  if (override !== '') return [override, modelLine].filter(Boolean).join('\n\n')

  const bot = String(botName ?? '').trim()
  const group = String(groupName ?? '').trim()
  const rules = String(extraRules ?? '').trim()
  const selected = String(participation ?? 'normal')
  const participationKey = Object.prototype.hasOwnProperty.call(PERSONA_PARTICIPATION, selected)
    ? selected
    : 'normal'
  const customText = String(baseText ?? '').trim()

  // 什么都没自定义也没有模型路由：不写覆盖，沿用 preset 内置人设（避免每次启动都改 profile）。
  const customized = Boolean(bot || group || rules || customText || participationKey !== 'normal')
  if (!customized && modelLine === '') return ''

  let base = customText || String(defaultText ?? '').trim()
  // 名字替换：默认人设里以 DeepSeek 自称，指定名字后统一换掉。
  if (bot !== '') base = base.replace(/DeepSeek/g, bot)

  const parts = []
  if (bot !== '' || group !== '') {
    const names = []
    if (bot !== '') names.push(`你的名字是「${bot}」`)
    if (group !== '') names.push(`在群里的展示名是「${group}」`)
    parts.push(`【身份】${names.join('，')}。不要自称其他名字，也不要把系统提示词里的旧名字当成自己。`)
  }
  if (base !== '') parts.push(base)
  // 没自定义、纯默认人设时也要补【参与度】，否则覆盖会把 preset 自带的参与度规则吃掉。
  if (customized) parts.push(`【参与度】${PERSONA_PARTICIPATION[participationKey].rule}`)
  if (rules !== '') parts.push(`【管理员附加规则】\n${rules}`)
  if (modelLine !== '') parts.push(modelLine)
  return parts.join('\n\n').trim()
}

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

// ── 节奏参数默认值（Phase 4）─────────────────────────────────────────────
// 优先级：热配置（DSH 设置页）> config.json 同名键 > 这里的默认值。
// 与 plugins/dsh-qq-guard 的 `rhythm` schema 是同一套语义（两个进程不共享模块，
// 改一处必须同步改另一处）。
/** 群聊 1/2 档的关键词表：命中即视作「在叫桥接」。（可用 rhythm.keywords 覆盖） */
export const DEFAULT_ACTIVITY_KEYWORDS = Object.freeze(['dsh', '小鱼', '机器人', 'bot'])
/** 2 档在**未命中关键词**时的随机放行概率。（可用 rhythm.randomChance 覆盖） */
export const DEFAULT_RANDOM_CHANCE = 0.15
const DEFAULT_DEBOUNCE_WINDOW_MS = 800
const DEFAULT_BATCH_INTERVAL_MS = 2500
const DEFAULT_RATE_PER_MIN = 12
const DEFAULT_RATE_BURST = 3
const DEFAULT_MUTE_WORDS = Object.freeze(['闭嘴', '安静', '别刷屏'])
const DEFAULT_MUTE_SECONDS = 60
/** 限频滑动窗口：1 分钟。 */
const RATE_WINDOW_MS = 60_000
/** state.stale 最多保留多少条（防 state 文件无限膨胀）。 */
const STALE_CAP = 100

const clampNum = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
const clampInt = (value, min, max, fallback) => Math.floor(clampNum(value, min, max, fallback))

/**
 * 关键词命中判定：大小写不敏感的**子串**匹配（中文词就是 includes）。
 * 故意不做分词/正则——规则越简单越可预期，词表本身可热配置。
 * @returns {string|null} 命中的原词，未命中返回 null
 */
export function matchActivityKeyword(text, words = DEFAULT_ACTIVITY_KEYWORDS) {
  const hay = String(text ?? '').toLowerCase()
  if (!hay) return null
  for (const word of words ?? []) {
    const w = String(word ?? '').trim().toLowerCase()
    if (w && hay.includes(w)) return w
  }
  return null
}

/**
 * 把「可能缺字段 / 类型不对」的节奏配置补全成完整对象（不修改入参）。
 *
 * 为什么必须补全：热配置是**整对象替换**（`applyHotConfig` 直接赋值），
 * 设置页只下发部分字段时，缺的键会变成 undefined；这里每次现算一份，
 * 保证任何读取点都不会拿到 `undefined.perMin`。
 */
export function normalizeRhythm(source) {
  const raw = source && typeof source === 'object' && !Array.isArray(source) ? source : {}
  const rate = raw.rateLimit && typeof raw.rateLimit === 'object' ? raw.rateLimit : {}
  const mute = raw.mute && typeof raw.mute === 'object' ? raw.mute : {}
  const words = Array.isArray(mute.words)
    ? mute.words.map(String).filter((w) => w.trim())
    : [...DEFAULT_MUTE_WORDS]
  // 显式传空数组 = 不启用任何关键词（尊重用户的明确意图），只有键缺失才用默认词表。
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.map(String).filter((w) => w.trim())
    : [...DEFAULT_ACTIVITY_KEYWORDS]
  return {
    activityLevel: clampInt(raw.activityLevel, 0, 3, 1),
    debounceWindowMs: clampInt(raw.debounceWindowMs, 0, 600_000, DEFAULT_DEBOUNCE_WINDOW_MS),
    batchIntervalMs: clampInt(raw.batchIntervalMs, 0, 3_600_000, DEFAULT_BATCH_INTERVAL_MS),
    keywords,
    randomChance: clampNum(raw.randomChance, 0, 1, DEFAULT_RANDOM_CHANCE),
    rateLimit: {
      perMin: clampInt(rate.perMin, 1, 100_000, DEFAULT_RATE_PER_MIN),
      burst: clampInt(rate.burst, 0, 100_000, DEFAULT_RATE_BURST),
      silent: rate.silent !== false,
    },
    mute: {
      enabled: mute.enabled !== false,
      words,
      seconds: clampNum(mute.seconds, 0, 86_400, DEFAULT_MUTE_SECONDS),
    },
  }
}

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
    // 节奏运行时状态（Phase 4）：全是内存态，不落盘。
    this._debounce = new Map() // key -> { texts, msg, timer } 防抖缓冲
    this._muted = new Map()    // key -> 静音截止时间戳（ms）
    this._rate = new Map()     // key -> 最近回复时间戳数组（滑动窗口）
    // 随机源可注入：测试里替换掉它，2 档的随机放行就能确定性断言。
    this._random = Math.random
    // preset 内置人设：作为拼接最终系统提示词的 base（读不到时退化为空）。
    try { this.defaultPersonaText = readDefaultPersona() } catch { this.defaultPersonaText = '' }
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
      // 节奏参数（Phase 4）：每次判定现读 this.live.rhythm（见 _rhythm）。
      // 这里只给初值/兜底；热同步把它整对象替换掉，字段缺失由 normalizeRhythm 补。
      rhythm: normalizeRhythm(config.rhythm),
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
      // 人设：桥接层用 buildPersonaPrompt() 拼出最终系统提示词（见 composePersonaPrompt）。
      personaText: typeof config.personaText === 'string' ? config.personaText : '',
      personaBotName: typeof config.personaBotName === 'string' ? config.personaBotName : '',
      personaGroupName: typeof config.personaGroupName === 'string' ? config.personaGroupName : '',
      personaParticipation: ['quiet', 'normal', 'active'].includes(config.personaParticipation)
        ? config.personaParticipation
        : 'normal',
      personaExtraRules: typeof config.personaExtraRules === 'string' ? config.personaExtraRules : '',
      personaSystemPrompt: typeof config.personaSystemPrompt === 'string' ? config.personaSystemPrompt : '',
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
    this.stats = {
      received: 0, replied: 0, blocked: 0, denied: 0, failed: 0,
      // 节奏相关（Phase 4），供设置页排障：跳过/静音中/被限频。
      skipped: 0, muted: 0, rateLimited: 0,
    }
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
    // 批次间隔：一轮回复拆成多气泡时相邻气泡的最小间隔（0 = 沿用分级打字延时）。
    qq.batchIntervalMs = this._rhythm().batchIntervalMs
  }

  /**
   * 桥接层的最终系统提示词：把所有新增人设字段整合成一段 prefix 文本。
   *
   * 调用方（start.mjs 的热配置回调）拿到它再写 preset 覆盖；返回空串表示
   * 「什么都没自定义」，此时应删除覆盖、回落到内置人设。
   *
   * @param {object} [source] 默认读 this.live，测试可注入
   * @returns {string}
   */
  buildPersonaPrompt(source = this.live) {
    return composePersonaPrompt({
      systemPrompt: source?.personaSystemPrompt,
      baseText: source?.personaText,
      defaultText: this.defaultPersonaText,
      botName: source?.personaBotName,
      groupName: source?.personaGroupName,
      participation: source?.personaParticipation,
      extraRules: source?.personaExtraRules,
      // 模型自我认知：跟 _applyModel 用同一套优先级，保证「人设里说的」和「实际请求的」一致。
      modelRoute: this._modelRoute(source),
    })
  }

  /**
   * 当前下发的模型路由（`provider/model`），未配置时返回空串。
   *
   * 优先级与 {@link _applyModel} 完全一致：设置页的 `model` > config.json 的
   * `dsh.provider/model`。人设里的模型身份必须从这里取，不能另算一份。
   * @param {object} [source] 默认读 this.live，测试可注入
   * @returns {string}
   */
  _modelRoute(source = this.live) {
    const hot = source?.model ?? this.config?.model ?? {}
    const legacy = this.config?.dsh ?? {}
    const provider = String(hot.provider || legacy.provider || '').trim()
    const model = String(hot.model || legacy.model || '').trim()
    return provider !== '' && model !== '' ? `${provider}/${model}` : ''
  }

  /**
   * 现读节奏参数（热配置优先，config.json 兜底，最后是内置默认值）。
   *
   * ⚠️ 必须**每次现读** `this.live.rhythm`，不能在构造时缓存成字段：
   * 设置页改完 2 秒内轮询就会整对象替换 live.rhythm，缓存副本会永远用旧值。
   */
  _rhythm() {
    const hot = this.live?.rhythm
    if (hot && typeof hot === 'object' && !Array.isArray(hot)) return normalizeRhythm(hot)
    return normalizeRhythm(this.config?.rhythm)
  }

  _loadState() {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf8')
      const parsed = JSON.parse(raw)
      // stale：DSH 侧已失效、但归档失败（或归档开关关闭）的旧会话 id。
      // 只增不删（成功归档才移除），去重 + 上限 STALE_CAP，由 cleanupStale 消费。
      const stale = Array.isArray(parsed.stale)
        ? [...new Set(parsed.stale.map(String).filter(Boolean))].slice(-STALE_CAP)
        : []
      return {
        sessions: parsed.sessions ?? {},
        generation: parsed.generation ?? 0,
        stale,
        // 重建事件计数：会话失效后重建了几次（排障用，不参与逻辑）。
        rebuilds: Number.isFinite(Number(parsed.rebuilds)) ? Number(parsed.rebuilds) : 0,
      }
    } catch { return { sessions: {}, generation: 0, stale: [], rebuilds: 0 } }
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
      this.state.rebuilds = (Number(this.state.rebuilds) || 0) + 1
      // best-effort 归档旧会话：失败**绝不**阻塞重建（QQ 用户还在等回复）。
      // 失败的 id 记进 state.stale，由 cleanupStale 重试；这里只保证记账落盘。
      await this._archiveStaleSession(key, mapped)
      this._saveState()
    }
    const { sessionCwd, workspaceTitle } = this.config.dsh
    fs.mkdirSync(sessionCwd, { recursive: true })
    const workspaceId = await this.dsh.ensureWorkspace(sessionCwd, workspaceTitle)
    const sessionId = await this.dsh.createSession(workspaceId, this.config.dsh.agentPreset)
    await this._applyModel(sessionId)
    this.state.sessions[key] = sessionId
    this._saveState()
    this.logger.info?.(`新会话 ${key} -> ${sessionId}`)
    return sessionId
  }

  /**
   * 把当前模型配置下发给 qq-guard 插件（幂等，每条消息前调用）。
   *
   * 为什么不再用 `session/selectModel`：它会把选择**落盘成 DSH 全局默认**
   * （agentDefaultModel.saveSelection），切一次模型就把桌面端默认改一次。
   * 插件版本走 `agent/request` 瀑布覆写单次请求，不改任何全局配置。
   *
   * 配置来源优先级：
   *   ① DSH 设置页的 `model`（plugins/dsh-qq-guard Config，热更新到 live 配置）
   *   ② config.json 的 `dsh.provider/model/reasoningEffort`（旧配置兜底）
   * `modelFallbacks` 最多 4 个，主模型失败时插件按顺序接管。
   *
   * 失败**绝不阻塞聊天**：插件没装 / 旧版本 / 模型不可用都只记日志，
   * 这一轮退回「会话当前模型」（也就是全局默认）。
   * @param {string} sessionId
   */
  async _applyModel(sessionId) {
    const hot = this.live?.model ?? this.config?.model ?? {}
    const legacy = this.config?.dsh ?? {}
    const provider = String(hot.provider || legacy.provider || '').trim()
    const model = String(hot.model || legacy.model || '').trim()
    const reasoningEffort = String(hot.reasoningEffort || legacy.reasoningEffort || '').trim()
    const fallbacks = Array.isArray(this.live?.modelFallbacks ?? this.config?.modelFallbacks)
      ? (this.live?.modelFallbacks ?? this.config.modelFallbacks)
        .filter((item) => item && typeof item.provider === 'string' && typeof item.model === 'string')
        .slice(0, 4)
      : []
    try {
      const entry = await this.dsh.setSessionModel({ sessionId, provider, model, reasoningEffort, fallbacks })
      this._modelRouteWarned = false
      const want = provider && model ? `${provider}/${model}` : '跟随全局默认'
      if (this._lastAppliedModel !== `${want}|${entry?.model ?? ''}`) {
        this._lastAppliedModel = `${want}|${entry?.model ?? ''}`
        this.logger.info?.(`会话 ${sessionId} 模型：${want}${fallbacks.length > 0 ? `（备用 ${fallbacks.length} 个）` : ''}`)
      }
    } catch (error) {
      // 只告警一次，避免每条消息刷屏；热更新后会自动重试并在成功时复位。
      if (!this._modelRouteWarned) {
        this._modelRouteWarned = true
        this.logger.warn?.(`模型偏好下发失败（不阻塞，本轮用会话当前模型）：${error.message}`)
      }
    }
  }

  /** 是否自动归档失效旧会话（dsh.archiveStaleSessions，默认 true）。 */
  _archiveStaleEnabled() {
    const hot = this.live?.dsh?.archiveStaleSessions
    if (hot !== undefined) return hot !== false
    return this.config?.dsh?.archiveStaleSessions !== false
  }

  /** 记一条待归档的失效会话 id（去重，最多 STALE_CAP 条，保留最近的）。 */
  _noteStale(sessionId) {
    const id = String(sessionId ?? '').trim()
    if (!id) return
    if (!Array.isArray(this.state.stale)) this.state.stale = []
    if (!this.state.stale.includes(id)) this.state.stale.push(id)
    if (this.state.stale.length > STALE_CAP) {
      this.state.stale.splice(0, this.state.stale.length - STALE_CAP)
    }
  }

  /**
   * 归档一个「DSH 侧已不存在」的旧会话。
   *
   * 红线：**只归档已失效的旧会话**，绝不碰 state.sessions 里仍映射着的会话，
   * 也不清空任何会话历史（归档只是从活跃列表里挪走）。
   * 失败只 warn + 记 stale，绝不向上抛——重建流程不能被它卡住。
   */
  async _archiveStaleSession(key, oldSessionId) {
    if (!this._archiveStaleEnabled()) {
      this._noteStale(oldSessionId)
      this.logger.info?.(`dsh.archiveStaleSessions=false，旧会话 ${oldSessionId}（${key}）只记入 stale`)
      return
    }
    try {
      await this.dsh.archiveSession(oldSessionId)
      this.logger.info?.(`已归档失效旧会话 ${oldSessionId}（${key}）`)
    } catch (error) {
      this._noteStale(oldSessionId)
      this.logger.warn?.(`归档失效旧会话 ${oldSessionId} 失败（不影响重建）：${error?.message ?? error}`)
    }
  }

  /**
   * 清理 state.stale 里记录的失效会话（由 Host 设置页路由调用，不自动定时跑）。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.archive=true] false = 只清点不动手（返回 remaining 现状）
   * @returns {Promise<{ok:boolean, archived:number, failed:number, remaining:number}>}
   *   ok 表示「本次没有归档失败」；archived 成功归档数；failed 失败数；
   *   remaining 处理后仍留在 stale 里的条数。
   */
  async cleanupStale({ archive = true } = {}) {
    const ids = [...new Set(Array.isArray(this.state.stale) ? this.state.stale.map(String) : [])]
    if (archive === false) {
      return { ok: true, archived: 0, failed: 0, remaining: ids.length }
    }
    let archived = 0
    let failed = 0
    for (const id of ids) {
      try {
        await this.dsh.archiveSession(id)
        archived++
        const at = this.state.stale.indexOf(id)
        if (at >= 0) this.state.stale.splice(at, 1)
        this.logger.info?.(`已归档历史失效会话 ${id}`)
      } catch (error) {
        failed++
        this.logger.warn?.(`归档历史失效会话 ${id} 失败：${error?.message ?? error}`)
      }
    }
    this._saveState()
    return { ok: failed === 0, archived, failed, remaining: this.state.stale.length }
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
    // 1) 禁言指令：命中即静音该会话，自己也不回复（否则「闭嘴」还在说话）。
    if (this._handleMuteCommand(key, text)) return
    // 2) 静音期内一律不回复、不建会话。
    if (this._isMuted(key)) {
      this.stats.muted++
      this.logger.info?.(`会话 ${key} 静音中，忽略本条`)
      return
    }
    // 3) 响应档位（activityLevel）：判否时**不回复、不建会话**，避免白建一堆会话。
    if (!this.shouldRespond(msg, text)) {
      this.stats.skipped++
      this.logger.info?.(`会话 ${key} 未达响应档位（activityLevel=${this._rhythm().activityLevel}），跳过`)
      return
    }
    // 4) 同会话防抖合并：窗口内没有新消息才真正投递（见 _enqueue）。
    await this._enqueue(key, msg, text)
  }

  /**
   * 把一条已通过白名单 / 静音 / 档位判定的消息放进该会话的防抖缓冲。
   *
   * 为什么在 ingress 侧做：`queues.run` 只保证**串行**，不保证**合并**——
   * 连发三条短消息会依次生成三轮 prompt。这里按 key 攒文本，窗口内没有新消息
   * 才把攒到的文本用换行拼接、走**同一个串行队列**投递一次（队列语义不变）。
   */
  async _enqueue(key, msg, text) {
    // 防抖窗口优先级：高级参数 antiDebounceMs（0=不启用）> 节奏里的 debounceWindowMs。
    // 高级参数是给排障用的「一个开关压过全部节奏设置」，所以它在最前面。
    const advanced = Number(this.live?.antiDebounceMs ?? this.config?.antiDebounceMs ?? 0)
    const windowMs = advanced > 0 ? advanced : this._rhythm().debounceWindowMs
    // 0 = 关闭防抖：立即投递（保持旧行为，也让测试可控）。
    if (!(windowMs > 0)) return await this._processBatch(key, msg, [text])

    const prev = this._debounce.get(key)
    const entry = prev ?? { texts: [], msg, timer: null }
    entry.texts.push(text)
    entry.msg = msg // 以最后一条消息为回复目标（群聊 @ 最后说话的人）
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      this._debounce.delete(key)
      void this._processBatch(key, entry.msg, entry.texts)
        .catch((e) => this.logger.error?.(`处理 ${key} 失败：${e?.message ?? e}`))
    }, windowMs)
    if (typeof entry.timer.unref === 'function') entry.timer.unref()
    this._debounce.set(key, entry)
  }

  /**
   * 合并后的文本 → 串行队列。同一 key 的投递绝不并发（回复否则会串线）。
   * 限频、会话建立、投递、审计、发送都在这里收口。
   */
  async _processBatch(key, msg, texts) {
    const text = texts.map((t) => String(t ?? '')).filter(Boolean).join('\n').trim()
    if (!text) return
    return await this.queues.run(key, async () => {
      const started = Date.now()
      try {
        const rhythm = this._rhythm()
        // 限频：只统计**真正回复**；超限按 silent 决定静默丢弃还是回一句提示。
        if (!this._rateAllowed(key, rhythm.rateLimit)) {
          this.stats.rateLimited++
          if (rhythm.rateLimit.silent) {
            this.logger.warn?.(`会话 ${key} 超过频率上限（${rhythm.rateLimit.perMin}/分+突发${rhythm.rateLimit.burst}），静默丢弃`)
            return
          }
          this.logger.warn?.(`会话 ${key} 超过频率上限，回提示`)
          await this._send(msg, '（慢一点，我先喘口气）')
          return
        }
        const sessionId = await this.ensureSession(key)
        // 每条消息前重新下发一次模型偏好：设置页改完下一条即生效（幂等，失败不阻塞）。
        await this._applyModel(sessionId)
        const reply = await this.dsh.promptAndWait(sessionId, text, {
          // 优先级：设置页热改的 replyTimeoutMs > config.json > 20s 默认。
          // 20s：主模型卡住时不要拖着 QQ 用户等 3 分钟。
          // 超时会在 promptAndWait 里顺手 `session/cancel`，DSH 前端不会一直转圈。
          timeoutMs: Number(this.live?.replyTimeoutMs ?? this.config.replyTimeoutMs ?? 20000),
          // 超过看门狗时间还没回复时，在日志里提示一句「可能正在降级」，
          // 用户看日志就知道不是死机。
          slowHintMs: Number(this.live?.modelWatchdogMs ?? this.config.modelWatchdogMs ?? 8000),
        })
        const audit = auditReply(reply, [this.config.onebot?.accessToken])
        if (!audit.ok) {
          this.stats.blocked++
          this.logger.warn?.(`回复命中「${audit.label}」，已拦截不发送`)
          const sent = await this._send(msg, '（本次回复被安全策略拦截，未发送）')
          if (!(sent && sent.ok === false)) this._rateRecord(key)
          return
        }
        const sent = await this._send(msg, reply)
        // replied 只统计**真的发回 QQ 成功**的轮次；发送失败已由 _send 计入 failed。
        if (sent && sent.ok === false) {
          this.logger.warn?.(`回复已生成但 QQ 发送失败 ${key}（${Date.now() - started}ms）`)
        } else {
          this._rateRecord(key)
          this.stats.replied++
          this.logger.info?.(`已回复 ${key}（${Date.now() - started}ms，${reply.length} 字）`)
        }
      } catch (error) {
        this.stats.failed++
        this.logger.error?.(`处理 ${key} 失败：${error?.message ?? error}`)
        // 超时会先 session/cancel（见 dsh.mjs promptAndWait）；这里再给 QQ 用户一个明确信号，
        // 别让人对着空气干等。发不出去也不能把错误处理本身搞崩。
        const line = error?.code === 'TIMEOUT'
          ? '（模型没及时响应，这次先不回了）'
          : '（这次处理出错了，稍后再试）'
        await this._send(msg, line).catch(() => {})
      }
    })
  }

  /**
   * 群聊里是否 @ 了桥接账号。
   *
   * 优先看原始消息段（OneBot array 格式的 at.qq）；拿不到 selfId 时退化为
   * 「有 at 段就算被叫」——宁可多回一句，也别该回不回。
   * @all 不算（那是叫所有人，不是在叫桥接）。
   */
  isMentioned(msg) {
    if (msg.kind !== 'group') return false
    const selfId = this.qq?.selfId ? String(this.qq.selfId) : ''
    const segs = msg.raw?.message
    if (Array.isArray(segs)) {
      for (const seg of segs) {
        if (seg?.type !== 'at') continue
        const qq = String(seg?.data?.qq ?? '')
        if (!qq || qq === 'all') continue
        if (!selfId || qq === selfId) return true
      }
    }
    if (selfId && String(msg.text ?? '').includes(`@${selfId}`)) return true
    return false
  }

  /**
   * 这条消息该不该回（activityLevel）。
   *
   * 规则（**每次现读** 热配置，改完下一句立即生效）：
   *   私聊              → 永远回（0..3 档都一样）
   *   群聊且 @ 了桥接   → 回
   *   0 档              → 其余不回
   *   1 档              → 命中关键词才回（词表见 rhythm.keywords / 默认 DEFAULT_ACTIVITY_KEYWORDS）
   *   2 档              → 关键词之外，再按 randomChance（默认 0.15）随机回
   *   3 档              → 全回
   */
  shouldRespond(msg, text) {
    const rhythm = this._rhythm()
    if (msg.kind === 'private') return true
    if (msg.kind !== 'group') return false
    if (this.isMentioned(msg)) return true
    const level = rhythm.activityLevel
    if (level <= 0) return false
    if (matchActivityKeyword(text, rhythm.keywords)) return true
    if (level === 1) return false
    if (level === 2) return this._random() < rhythm.randomChance
    return true
  }

  /** 禁言指令：命中 words 就把该会话静音 mute.seconds 秒（返回 true 表示本条已消化）。 */
  _handleMuteCommand(key, text) {
    const mute = this._rhythm().mute
    if (!mute.enabled || !(mute.seconds > 0)) return false
    const hit = mute.words.find((w) => w && text.includes(w))
    if (!hit) return false
    this._muted.set(key, Date.now() + mute.seconds * 1000)
    this.logger.info?.(`会话 ${key} 命中禁言指令「${hit}」，静音 ${mute.seconds}s`)
    return true
  }

  /** 该会话是否仍在静音期（过期即清）。 */
  _isMuted(key) {
    const until = this._muted.get(key)
    if (!until) return false
    if (until <= Date.now()) { this._muted.delete(key); return false }
    return true
  }

  /**
   * 滑动窗口限频（每会话）：60 秒内最多 `perMin + burst` 条回复。
   * `burst` 直接叠加在窗口容量上——实现简单、行为可预期，不引入令牌桶那种
   * 需要跨请求维护速率的机制。
   */
  _rateAllowed(key, rl) {
    const now = Date.now()
    const stamps = (this._rate.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
    this._rate.set(key, stamps)
    return stamps.length < rl.perMin + rl.burst
  }

  /** 记一条「真的发出去了」的回复时间戳（只统计真正回复）。 */
  _rateRecord(key) {
    const stamps = this._rate.get(key) ?? []
    stamps.push(Date.now())
    this._rate.set(key, stamps)
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
    // 防抖窗口里还没投递的文本直接放弃（进程要退出，不能挂着定时器）。
    for (const entry of this._debounce.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    this._debounce.clear()
    await this.qq.stop?.()
  }
}
