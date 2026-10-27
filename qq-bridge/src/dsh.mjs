/**
 * DSH Web API 客户端：离线铸造会话 Cookie + 斜杠 RPC + 会话/投递/取回复。
 *
 * 鉴权依据（2026-10-20 在本机 DSH 0.2.1-rc.2 / http://127.0.0.1:2852 实测）：
 *   · 无 Cookie 打 /api/* → 401
 *   · 用 ~/.dsh/.credentials.yaml 里持久化的 client-connection/browser-session
 *     （32 字节）离线铸造 Cookie → 200
 * Cookie 名与签名载荷都绑定 authority（Host 头），所以 baseUrl 的端口必须与
 * DSH 实际监听端口一致，否则 401。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHmac, createHash, randomUUID } from 'node:crypto'

const BROWSER_SESSION_KEY = 'client-connection/browser-session'
const SECRET_BYTES = 32
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_LIFETIME_MS = 60 * 60 * 1000
const COOKIE_REFRESH_MARGIN_MS = 5 * 60 * 1000
/**
 * 人设归纳路由的超时（2026-10-26）：Host 那边要拿模型跑一轮，比普通 RPC 慢得多。
 * 桥接每小时才调一次，等久一点可以接受；超时只当「本轮没结果」，不影响聊天。
 *
 * 为什么是 70s 而不是 60s：Host 侧归纳路由自己就有 60s 的 AbortController 上限。
 * 两边都卡 60s 的话桥接会**先**断连，日志里只剩「HTTP 超时/断连」看不到真正原因；
 * 多留 10s 余量，让 Host 的 `{ok:false, reason}` 先回来。
 */
const SUMMARIZE_TIMEOUT_MS = 70 * 1000
/**
 * 原生 `/compact` 的等待上限（2026-10-27）。
 *
 * 压缩本身要跑一轮模型总结（DSH 内部 selectCompactableRange → 摘要 → 替换 surface）。
 * 实测：6 轮、约 1200 token 的历史，压缩耗时 33s（走 deepseek-v4.1-flash + high effort）。
 * 30 轮的群聊会更久，所以给 90s —— 超过就放弃压缩、静默降级成「归档 + 新建会话」，
 * 不让群友无限等下去。注意超时只是本地不等了，DSH 侧那次压缩可能仍在收尾。
 */
const COMPACT_TIMEOUT_MS = 90 * 1000
/** 与 plugins/dsh-qq-guard/index.js 的 SUMMARIZE_ROUTE_PATH 一致（规格 §3）。 */
const PERSONA_SUMMARIZE_PATH = '/dsh-qq-guard/persona-summarize'

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** DSH 桌面端 webserver 用 `port: 0`（系统随机分配），重启即换端口。 */
export const DSH_BASE_HOST = '127.0.0.1'

/**
 * 探测 DSH 当前监听的端口。
 *
 * 为什么需要它（2026-10-20 实测教训）：桌面端的 webserver 行配置是
 * `port: 0`，即**每次启动都由系统随机分配**——今天实测从 2852 变成了 6708。
 * 桥接配置里写死 baseUrl 的话，DSH 一重启桥接就失联（QQ 上表现为「发消息没反应」，
 * 而日志里是 ECONNREFUSED）。
 *
 * Cookie 的签名载荷绑定 authority（Host 头），所以端口必须**精确匹配**，
 * 不能猜、也不能用一个错的端口去试。
 *
 * 依据来源（按可靠性排序）：
 *   1. `DSH_BASE_URL` / `DSH_WEB_URL` 环境变量（显式覆盖，最高优先级）
 *   2. 监听 socket 表：枚举本机 LISTENING 端口，逐个用 `/api/*` 的
 *      **401 + 响应体 "unauthorized"** 指纹确认是 DSH（2026-10-20 实测的精确特征）
 *   3. 兜底：配置文件里的 baseUrl（显式固定端口的老部署）
 *
 * @param {object} [opts]
 * @param {string} [opts.prefer]  配置里写的 baseUrl，仅作兜底
 * @param {Array<number>} [opts.candidates] 端口候选（测试用；默认从系统枚举）
 * @param {number} [opts.timeoutMs] 单个端口的探测超时
 * @returns {Promise<string|null>} 形如 `http://127.0.0.1:6708`；找不到返回 null
 */
export async function discoverDshBaseUrl({ prefer, candidates, timeoutMs = 1200 } = {}) {
  // 1) 环境变量显式覆盖
  for (const key of ['DSH_BASE_URL', 'DSH_WEB_URL']) {
    const raw = process.env[key]
    if (raw && /^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '')
  }

  // 2) 逐个探测候选端口，用 401 + body "unauthorized" 确认是 DSH
  const ports = candidates ?? await listLocalListeningPorts().catch(() => [])
  for (const port of ports) {
    const url = `http://${DSH_BASE_HOST}:${port}`
    try {
      const res = await fetch(`${url}/api/agentPresets/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'agentPresets/list', payload: { args: {} } }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status !== 401) continue
      // DSH 无 Cookie 时固定回 "unauthorized"（实测 body 就这一个词）。
      // 认 body 而不是认 header：401 的 header 里没有可依赖的特征。
      const text = (await res.text().catch(() => '')).trim().toLowerCase()
      if (text === 'unauthorized') return url
    } catch { /* 不是 DSH 或没开，换下一个 */ }
  }

  // 3) 兜底：沿用配置里的地址（可能是固定端口的老部署）
  if (prefer) return String(prefer).replace(/\/+$/, '')
  return null
}

/**
 * 枚举本机处于 LISTENING 的端口。
 *
 * 用 `netstat -ano` 而不是 node:net 试连：试连会真的建立连接，
 * 而这里只需要"谁在监听"这份清单。解析失败一律返回空数组（调用方会走兜底）。
 *
 * 实测（Windows netstat 输出）：`  TCP    127.0.0.1:6708    0.0.0.0:0    LISTENING    4792`
 * 只看 TCP（UDP 无 LISTENING 语义），且只接受本机回环/任意地址的本地端。
 * @returns {Promise<number[]>}
 */
export async function listLocalListeningPorts() {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { stdout } = await run('netstat', ['-ano'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  const ports = new Set()
  for (const raw of String(stdout).split(/\r?\n/)) {
    const line = raw.trim()
    if (!/\bLISTENING\b/i.test(line)) continue
    // 形如： TCP  127.0.0.1:6708  0.0.0.0:0  LISTENING  4792
    const m = /^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\b/i.exec(line)
    if (!m) continue
    const host = m[1]
    if (!['127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(host)) continue
    const port = Number(m[2])
    if (Number.isInteger(port) && port > 0) ports.add(port)
  }
  return [...ports]
}

/**
 * 读取 DSH 持久化的浏览器会话签名密钥。
 *
 * 只做定向解析而不引入 YAML 依赖：credentials.yaml 结构固定为
 * records -> 'client-connection/browser-session' -> payload -> secret。
 * @returns {Buffer|null} 32 字节密钥，任何不符都返回 null。
 */
export function readBrowserSessionSecret() {
  try {
    const text = fs.readFileSync(path.join(resolveDshHome(), '.credentials.yaml'), 'utf8')
    let inRecord = false
    let recordIndent = -1
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      const indent = line.search(/\S/)
      const m = /^\s*'?([^':]+)'?:\s*(.*)$/.exec(line)
      if (!m) continue
      const key = m[1].trim()
      if (key === BROWSER_SESSION_KEY) { inRecord = true; recordIndent = indent; continue }
      if (!inRecord) continue
      if (indent <= recordIndent) { inRecord = false; continue }
      if (key === 'secret') {
        const raw = m[2].trim().replace(/^["']|["']$/g, '')
        if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null
        const decoded = Buffer.from(raw.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
        return decoded.byteLength === SECRET_BYTES ? decoded : null
      }
    }
    return null
  } catch {
    return null
  }
}

/** 用签名密钥为指定 DSH 地址铸造会话 Cookie。 */
export function mintCookie(baseUrl, secret, { lifetimeMs = COOKIE_LIFETIME_MS } = {}) {
  const authority = new URL(baseUrl).host
  if (!authority) throw new Error('DSH baseUrl 缺少 authority')
  const issuedAt = Date.now()
  const expiresAt = issuedAt + lifetimeMs
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
  const signature = b64url(createHmac('sha256', secret).update(body).digest())
  const name = COOKIE_PREFIX + b64url(createHash('sha256').update(authority).digest())
  return `${name}=v1.${body}.${signature}`
}

/**
 * 新协议 RPC 的 args 包装：`payload.args.<key> = 原始参数`。
 * `null` 表示该端点没有包装层（payload 就是 `{ args: {} }`）。
 * 这张表在 DSH 0.2.1-rc.2 上逐项实测通过；缺项默认按 'request' 处理。
 */
const METHOD_ARG_WRAPPERS = {
  'session/list': '_request',
  'session/create': 'request',
  'session/prompt': 'request',
  'session/cancel': 'request',
  'session/selectModel': 'request',
  'session/projections': 'request',
  'session/follow': 'request',
  'session/rename': 'request',
  'session/page': 'request',
  'workspace/create': 'request',
  'workspace/rename': 'request',
  'workspace/archiveSession': 'request',
  'agentPresets/list': null,
}

export class DshClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl  DSH 地址，本机为 http://127.0.0.1:2852
   * @param {number} [opts.timeoutMs]
   * @param {object} [opts.logger] { info, warn, error }
   */
  constructor({ baseUrl, timeoutMs = 30000, logger } = {}) {
    // baseUrl 只作兜底：真正的端口在首次调用时探测（DSH 桌面端随机分配端口）。
    this.baseUrl = String(baseUrl || `http://${DSH_BASE_HOST}:2852`).replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.logger = logger ?? { info() {}, warn() {}, error() {} }
    this._secret = undefined
    this._cookie = null
    this._cookieExpiresAt = 0
    this._rebinding = false
    this._rebound = false
  }

  /**
   * 首次使用前把 baseUrl 对齐到 DSH 实际端口（只在第一次真正调用时探）。
   * 之后端口变化由 {@link rebind} 在调用失败时自愈。
   * @returns {Promise<void>}
   */
  async ensureBaseUrl() {
    if (this._rebound) return
    this._rebound = true
    const found = await discoverDshBaseUrl({ prefer: this.baseUrl }).catch(() => null)
    if (found && found !== this.baseUrl) {
      this.logger.info?.(`DSH 实际端口为 ${found}（配置里的 ${this.baseUrl} 已过期），跟随之`)
      this.baseUrl = found
      this._cookie = null
      this._cookieExpiresAt = 0
    }
  }

  /** 签名密钥探测缓存：文件在 DSH 生命周期内不变，探一次即可。 */
  browserSessionSecret() {
    if (this._secret === undefined) this._secret = readBrowserSessionSecret()
    return this._secret
  }

  /** 取得有效 Cookie；到期前 5 分钟主动重铸（纯本地 HMAC，无网络往返）。 */
  ensureCookie() {
    if (this._cookie && Date.now() < this._cookieExpiresAt - COOKIE_REFRESH_MARGIN_MS) return this._cookie
    const secret = this.browserSessionSecret()
    if (!secret) {
      throw new Error(
        `读不到 ${path.join(resolveDshHome(), '.credentials.yaml')} 里的 ` +
        `${BROWSER_SESSION_KEY} 签名密钥（DSH 是否在运行？DSH_HOME 是否指向真正的 .dsh？）`,
      )
    }
    this._cookie = mintCookie(this.baseUrl, secret)
    this._cookieExpiresAt = Date.now() + COOKIE_LIFETIME_MS
    return this._cookie
  }

  /**
   * 调一次一元 RPC。
   *
   * @param {string} method
   * @param {object} [args]
   * @param {{flat?:boolean, timeoutMs?:number}} [opts]
   *   `flat`：args **平铺**直接在 `payload.args` 上（`commands/*` 这类方法就是这样，
   *   套 `{request:{...}}` 会被网关报 `missing "agentId"; unexpected "request"`）。
   *   `timeoutMs`：单次调用的超时（压缩要跑模型，比普通 RPC 慢得多）。
   * @returns {Promise<unknown>} 解包后的 value
   * @throws 当结果是 `{ok:false}` 或 HTTP 非 2xx 时抛错，错误上带 code。
   */
  async call(method, args = {}, { flat = false, timeoutMs = this.timeoutMs } = {}) {
    await this.ensureBaseUrl()
    const wrapKey = Object.hasOwn(METHOD_ARG_WRAPPERS, method) ? METHOD_ARG_WRAPPERS[method] : 'request'
    const payload = flat
      ? { args }
      : (wrapKey === null ? { args: {} } : { args: { [wrapKey]: args } })

    /** 用当前 baseUrl 发一次；返回 Response。 */
    const send = () => fetch(`${this.baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.ensureCookie() },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    let res
    try {
      res = await send()
    } catch (error) {
      // 连不上：DSH 可能重启换了端口（桌面端 port:0 随机分配）。重新探测一次。
      const moved = await this.rebind()
      if (!moved) throw error
      res = await send()
    }

    if (res.status === 401) {
      // 401 有两种成因：① Cookie 失效（DSH 重启换密钥）；② 端口换了（Cookie 绑定 authority）。
      // 先按 ① 重铸 Cookie 重试；仍 401 就按 ② 重新探测端口。
      this._cookie = null
      this._secret = undefined
      const retry = await send()
      if (retry.status !== 401) return this._unwrap(await retry.json().catch(() => ({})), method, retry.status)

      if (await this.rebind()) {
        const after = await send()
        return this._unwrap(await after.json().catch(() => ({})), method, after.status)
      }
      return this._unwrap(await retry.json().catch(() => ({})), method, retry.status)
    }
    return this._unwrap(await res.json().catch(() => ({})), method, res.status)
  }

  /**
   * 重新探测 DSH 的真实端口并切换过去（DSH 重启换端口时自愈）。
   * @returns {Promise<boolean>} 是否成功换到一个**不同**的、可达的地址
   */
  async rebind() {
    if (this._rebinding) return false
    this._rebinding = true
    try {
      const found = await discoverDshBaseUrl({ prefer: undefined, timeoutMs: 1200 }).catch(() => null)
      if (!found || found === this.baseUrl) return false
      this.baseUrl = found
      this._cookie = null
      this._secret = undefined
      this.logger.info?.(`DSH 端口已变化，自动跟随到 ${found}`)
      return true
    } finally {
      this._rebinding = false
    }
  }


  _unwrap(body, method, httpStatus) {
    const result = body?.result
    if (result?.ok) return result.value
    const error = result?.error
    const err = new Error(`${method} 失败: ${error?.code ?? 'unknown'} ${error?.message ?? ''}`.trim())
    err.code = error?.code
    err.httpStatus = httpStatus
    err.details = error?.details
    throw err
  }

  // ── 会话生命周期 ──────────────────────────────────────────────────

  /** 幂等创建工作区，返回 workspaceId。 */
  async ensureWorkspace(dir, title) {
    const value = await this.call('workspace/create', { path: dir })
    const workspaceId = value?.workspace?.workspaceId
    if (!workspaceId) throw new Error('workspace/create 未返回 workspaceId')
    if (value.created && title) {
      await this.call('workspace/rename', { workspaceId, title }).catch((e) =>
        this.logger.warn(`工作区改名失败（可忽略）：${e.message}`))
    }
    return workspaceId
  }

  /** 建会话。agentPreset 必须显式给，绝不让 DSH 回退到 standard。 */
  async createSession(workspaceId, agentPreset) {
    const value = await this.call('session/create', { workspaceId, agentPreset })
    const sessionId = value?.sessionId
    if (!sessionId) throw new Error('session/create 未返回 sessionId')
    return sessionId
  }

  /**
   * ⚠️ 旧路径，仅保留给兼容/排障：`session/selectModel` 会**顺带把新选择写进
   * profile 的 agent-default-model**（dsh-api-session-controller/lib/types/commands.js:175
   * → `agentDefaultModel.saveSelection`），也就是会改 DSH 全局默认。正常聊天不要用，
   * 用 {@link setSessionModel}。
   */
  async selectModel(sessionId, provider, model, reasoningEffort) {
    const args = { sessionId, provider, model }
    if (reasoningEffort) args.reasoningEffort = reasoningEffort
    return this.call('session/selectModel', args)
  }

  /**
   * 把「这个会话该用哪个模型」写给 qq-guard 插件（无痕热切换）。
   *
   * 为什么走插件自己的 HTTP 路由，而不是 `session/selectModel`：
   *   · selectModel 会落盘全局默认（见上）；
   *   · 插件在 `agent/request` 瀑布里覆写**这一次请求**的 route，下一请求即生效，
   *     且完全不动 profile 配置。
   *
   * 协议（见 plugins/dsh-qq-guard/model-override.js）：
   *   POST {sessionId, provider, model, reasoningEffort?, fallbacks?}
   *   POST {sessionId, mode:'default'}   ← 跟随全局默认（抵消会话 header 的粘性）
   *
   * @param {{sessionId:string, provider?:string, model?:string, reasoningEffort?:string, fallbacks?:Array<{provider:string,model:string}>}} request
   * @returns {Promise<object>} 插件回显的 entry
   */
  async setSessionModel({ sessionId, provider, model, reasoningEffort, fallbacks }) {
    const useDefault = !(provider && model)
    const body = useDefault
      ? { sessionId, mode: 'default' }
      : {
        sessionId,
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(Array.isArray(fallbacks) && fallbacks.length > 0 ? { fallbacks } : {}),
      }
    const res = await fetch(`${this.baseUrl}/dsh-qq-guard/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.ensureCookie() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok || payload?.ok !== true) {
      const error = new Error(payload?.detail ?? payload?.reason ?? `HTTP ${res.status}`)
      error.code = payload?.reason
      throw error
    }
    return payload.entry
  }

  /**
   * 会话是否在 DSH 侧仍存在（归档/重启后本地映射会失效）。
   *
   * 实测：`session/projections` 对不存在的会话返回 `null`（不抛 not-found），
   * 所以必须以「有没有拿到投影对象」判定，不能靠捕错。
   */
  async sessionExists(sessionId) {
    const value = await this.call('session/projections', { sessionId, keys: ['title'] })
    return value !== null && value !== undefined
  }

  /**
   * 读会话当前标题（投影里的 `title` 折叠值）。会话不存在返回 null。
   *
   * 实测（DSH 0.2.1-rc.2，2026-10-23）`session/projections` 对 `title` 返回的是
   * **裸字符串**（如 `"向"`）；历史版本/未来的投影 schema 可能给
   * `{ title, messageSeqs, source }` 对象，所以两种形态都认。
   *
   * @param {string} sessionId
   * @returns {Promise<string|null>} 标题；会话不存在时 null
   */
  async sessionTitle(sessionId) {
    const value = await this.call('session/projections', { sessionId, keys: ['title'] })
    if (value === null || value === undefined) return null
    const title = value?.values?.title
    if (typeof title === 'string') return title
    if (typeof title?.title === 'string') return title.title
    return ''
  }

  /**
   * 强制重命名会话（桥接的命名规范靠它落地）。
   *
   * 语义（`dsh-session-title/lib/index.js:295-315` 实测）：
   *   · 先 resolve/resume 该会话，所以**不必**保证它当前活着；
   *   · 标题以 `source: 'user'` 追加 `session/title` 事件并持久化；
   *   · 一旦写成 user 来源，DSH 自己的自动标题（fallback / LLM）不再覆盖它
   *     （`onUserMessage` 里 `source.kind === 'user'` 直接 return）。
   *
   * @param {string} sessionId
   * @param {string} title 规范化后的标题（空标题会被 DSH 拒绝）
   * @returns {Promise<string>} DSH 实际接受的标题
   */
  async renameSession(sessionId, title) {
    const value = await this.call('session/rename', { sessionId, title })
    return typeof value?.title === 'string' ? value.title : String(title)
  }

  /**
   * 投递一条用户消息。
   * requestId 与 mode 在 DSH 0.2.1 上是必填项，缺一个就 gateway/input-invalid。
   *
   * 多模态（2026-10-23）：`content` 可以直接给 DSH 的 prompt content 数组
   * （text / image 混排）。image part 的 wire 形态是
   * `{ type:'image', data:<canonical base64>, mediaType:'image/png' }`，
   * DSH 的 attachments.admitPromptContent 会落盘并换成 attachment ref。
   * 只有当前会话模型声明支持 image 输入时才会被接受，否则报
   * `session/attachment-invalid` + reason `MODEL_DOES_NOT_SUPPORT_IMAGES`。
   *
   * @param {string} sessionId
   * @param {string} text 纯文本兜底（content 未提供时用）
   * @param {{mode?:string, content?:Array<object>}} [opts]
   */
  async prompt(sessionId, text, { mode = 'queue', content } = {}) {
    const parts = Array.isArray(content) && content.length > 0
      ? content
      : [{ type: 'text', text: String(text ?? '') }]
    const value = await this.call('session/prompt', {
      sessionId,
      requestId: randomUUID(),
      mode,
      content: parts,
    })
    if (value?.accepted !== true) throw new Error(`session/prompt 未接受：${JSON.stringify(value)}`)
    return true
  }

  /** 读 turnOutline：[{turn, seq, prompt, response}] */
  async turnOutline(sessionId) {
    const value = await this.call('session/projections', { sessionId, keys: ['turnOutline'] })
    const outline = value?.values?.turnOutline
    return Array.isArray(outline) ? outline : []
  }

  /**
   * 列出该会话当前可用的 slash 命令（`commands/list`）。
   *
   * 用途：探测 DSH 版本有没有 `command-compact`（老版本没有 `/compact`）。
   * 注意 args 是**平铺**的 `{agentId}`，agentId 就是 sessionId（实测同一值）。
   *
   * @param {string} sessionId
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<Array<{name:string, description?:string}>>}
   */
  async listCommands(sessionId, { timeoutMs = this.timeoutMs } = {}) {
    const value = await this.call('commands/list', { agentId: sessionId }, { flat: true, timeoutMs })
    if (Array.isArray(value)) return value
    if (Array.isArray(value?.commands)) return value.commands
    if (Array.isArray(value?.items)) return value.items
    return []
  }

  /**
   * 触发 DSH 原生「上下文压缩」（`/compact` 命令）。
   *
   * 为什么走命令而不是专门 RPC：DSH 没有 `session/compact`（探针实测 404 unknown method），
   * 压缩能力的公开入口只有 `command-compact` 注册的 `/compact` 命令，而命令可以经
   * `commands/execute` 从外部投递（args 同样**平铺**，`submittedAttachments` 必填且必须为空数组）。
   *
   * 语义（2026-10-27 按 dsh-compaction-basic 源码确认）：
   *   · 手动压缩走 `selectCompactableRange(..., 0)` → **能压多少压多少**，
   *     除 system prompt 外把历史折成一条摘要（不是「保留最近 N 轮」）；
   *   · 只在 agent 空闲时可跑，否则报 busy；
   *   · 压缩只 shadow surface，会话日志与 `turnOutline` 轮数**都不变**。
   *
   * @param {string} sessionId
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{kind?:string, text?:string, sourceEventSeq?:number}>}
   * @throws 命令返回 `kind:'error'`（busy / 无可压历史 / 没模型可总结）时抛错，code=COMPACT_FAILED。
   */
  async compactSession(sessionId, { timeoutMs = COMPACT_TIMEOUT_MS } = {}) {
    const value = await this.call('commands/execute', {
      agentId: sessionId,
      line: '/compact',
      submittedAttachments: [],
    }, { flat: true, timeoutMs })
    // 返回结构（2026-10-27 实测）：`{commandId, result:{kind,text,sourceEventSeq?}}`。
    // 早先按裸 `{kind,text}` 写的判断会误判成「没有结果」，这里两种形态都认。
    const outcome = (value && typeof value === 'object' && value.result && typeof value.result === 'object')
      ? value.result
      : value
    const kind = typeof outcome?.kind === 'string' ? outcome.kind : ''
    if (kind === 'error') {
      const error = new Error(`compact 失败：${String(outcome?.text ?? '未知原因')}`)
      error.code = 'COMPACT_FAILED'
      throw error
    }
    // 命令名不在注册表里时网关不回错误、只给 admission miss（value 为空），
    // 这里也当失败处理：让调用方降级成归档重建，而不是误以为压过了。
    if (kind !== 'success') {
      const error = new Error('compact 未产生结果（命令可能不存在或未执行）')
      error.code = 'COMPACT_FAILED'
      throw error
    }
    return { ...outcome, commandId: value?.commandId }
  }

  /**
   * 读会话的原始事件快照（**保留换行**）。
   *
   * 为什么需要它（2026-10-20 实测踩到的坑）：
   *   `turnOutline` 投影里的 `response` 字段是**折叠过的摘要**——它会把模型回复里的
   *   换行压成空格。实测同一条回复：原始事件是 `"在\n\n有事说"`，
   *   而 `turnOutline.response` 给出 `"在 有事说"`。
   *   QQ 上「一条消息一个气泡」完全依赖换行切分，走投影就等于**永远分不了条**，
   *   模型就算乖乖换了行也会被压成一条长消息。
   *
   * 通道选择：`session/page` 要求 `address` + `throughSeq`，而 throughSeq 只能从
   * `session/follow` 的打开帧里拿；`session/follow` 一帧就把完整 snapshot 带回来了
   * （实测 maxMessages=50 时 records 覆盖全场）。所以直接用 follow 的打开帧，一步到位，
   * 不必先 follow 再 page 两次往返。
   *
   * @param {string} sessionId
   * @param {object} [opts]
   * @param {number} [opts.maxMessages=200] 单次带回的消息上限
   * @param {number} [opts.timeoutMs=8000] 等打开帧的时限
   * @returns {Promise<Array<{type:string,seq:number,time:number,data:any}>>} 按 seq 升序的事件
   */
  async snapshotEvents(sessionId, { maxMessages = 200, timeoutMs = 8000 } = {}) {
    const cookie = this.ensureCookie()
    const authority = new URL(this.baseUrl).host
    const ws = new WebSocket(`ws://${authority}/api/remote.mux`, { headers: { cookie } })
    try {
      const records = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 session/follow 快照超时')), timeoutMs)
        const done = (fn) => { clearTimeout(timer); try { ws.close() } catch {} ; fn() }
        ws.addEventListener('open', () => {
          ws.send(JSON.stringify({
            type: 'open', streamId: 'snap', endpoint: 'session/follow',
            payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages } } },
          }))
        })
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data) } catch { return }
          const v = m?.value
          if (v?.type === 'snapshot' && Array.isArray(v.records)) done(() => resolve(v.records))
          else if (m?.type === 'error') done(() => reject(new Error(m.error?.message ?? 'session/follow 出错')))
        })
        ws.addEventListener('error', () => done(() => reject(new Error('session/follow 连接失败'))))
      })
      return records
        .map((r) => (r?.type === 'event' ? r.event : r))
        .filter((e) => e && typeof e.type === 'string')
        .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))
    } finally {
      try { ws.close() } catch {}
    }
  }

  /**
   * 取指定轮次的助手**纯文本**回复（保留换行）。
   *
   * 只取 `assistant/message` 里的 text 块；reasoning 块跳过（那是思考过程）。
   * 同一轮可能有多个 step / 多条 assistant/message，按 seq 顺序用换行拼接。
   *
   * @param {string} sessionId
   * @param {number} turn
   * @returns {Promise<string|null>} 找不到该轮回复时返回 null
   */
  async assistantTextOfTurn(sessionId, turn) {
    const events = await this.snapshotEvents(sessionId)
    const parts = []
    for (const e of events) {
      if (e.type !== 'assistant/message') continue
      if (Number(e.data?.turn) !== Number(turn)) continue
      for (const b of e.data?.message?.content ?? []) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text)
      }
    }
    if (parts.length === 0) return null
    return parts.join('\n')
  }

  /**
   * 投递并等回复。
   *
   * 对齐方式：投递前记下当前 turnOutline 长度，投递后轮询直到出现**新的**
   * 且 response 非空的那一轮；随后**改从原始事件页取正文**，以保留换行
   * （投影的 response 会把换行压平，见 {@link pageEvents} 的说明）。
   * 调用方必须保证同一会话串行，否则会串线。
   *
   * @returns {Promise<string>} 助手回复文本（含换行）；超时抛错。
   */
  async promptAndWait(sessionId, text, { timeoutMs = 20000, pollMs = 1500, slowHintMs = 0, onProgress, content } = {}) {
    const before = await this.turnOutline(sessionId)
    const beforeTurns = before.length
    const beforeSeq = before.at(-1)?.seq ?? -1
    await this.prompt(sessionId, text, content ? { content } : {})

    const started = Date.now()
    const deadline = started + timeoutMs
    let slowHinted = false
    while (Date.now() < deadline) {
      // 慢提示：等待超过看门狗时间还没回复时打一条，用户看日志就知道「不是死机，在降级」。
      if (!slowHinted && slowHintMs > 0 && Date.now() - started >= slowHintMs) {
        slowHinted = true
        const seconds = Math.round((Date.now() - started) / 1000)
        this.logger.warn(`⏳ 等待回复已超 ${seconds} 秒，可能正在触发看门狗降级…`)
      }
      await new Promise((r) => setTimeout(r, pollMs))
      let outline
      try {
        outline = await this.turnOutline(sessionId)
      } catch (e) {
        // 摘要/归档竞态下瞬时读不到：继续等，不当作失败。
        this.logger.warn(`读 turnOutline 失败（继续等）：${e.message}`)
        continue
      }
      if (outline.length <= beforeTurns) continue
      const latest = outline.at(-1)
      // 新轮次以 seq 前进为准；response 可能短暂为空（turn 还在跑）。
      const advanced = (latest.seq ?? -1) > beforeSeq || outline.length > beforeTurns
      if (!advanced) continue
      if (typeof latest.response !== 'string' || !latest.response.trim()) {
        if (onProgress) onProgress(latest)
        continue
      }

      // 关键：投影已确认这一轮有回复，改成读原始事件取回**带换行**的正文。
      try {
        const full = await this.assistantTextOfTurn(sessionId, latest.turn)
        if (full && full.trim()) return full.trim()
      } catch (e) {
        // 读原始页失败（例如该版本没有 session/page）：退回投影文本，宁可丢换行也别丢回复。
        this.logger.warn(`读原始回复失败，退回投影文本：${e.message}`)
      }
      return latest.response.trim()
    }

    // 超时必须**主动取消** DSH 侧这一轮：
    //   不取消的话 turn 还在进程里跑，前端会一直转「深度求索中」，
    //   而且下一次 prompt 会被当成排队消息，看起来像「卡死」。
    // `session/cancel` 会让 turn/end 以 aborted 收尾，前端状态立刻回落。
    let cancelled = false
    try {
      await this.call('session/cancel', { sessionId })
      cancelled = true
    } catch (error) {
      this.logger.warn?.(`取消失败（不影响报错）：${error.message}`)
    }
    const timeoutError = new Error(`等待回复超时（${Math.round(timeoutMs / 1000)}s）`)
    timeoutError.code = 'TIMEOUT'
    timeoutError.cancelled = cancelled
    throw timeoutError
  }

  /**
   * 归档会话（只隐藏，不删历史）。
   *
   * `stopActivity`：会话还在跑（有活 Agent / turn）时，归档默认会被拒绝
   * （`workspace/session-active`）。传 true 让 DSH 先停掉它的工作再归档——
   * 「清空上下文 / 删除会话」必须带这个，否则刚聊完的会话 100% 归档失败。
   *
   * @param {string} sessionId
   * @param {{stopActivity?:boolean}} [opts]
   */
  async archiveSession(sessionId, { stopActivity = false } = {}) {
    return this.call('workspace/archiveSession', {
      sessionId,
      ...(stopActivity ? { stopActivity: true } : {}),
    })
  }

  /**
   * 列出所有可见会话（不 resume Agent）。
   * 返回 items：`[{ sessionId, updatedAt, cwd?, origin?, projections?: { values: { title } } }]`
   * —— `projections.values.title` 是当前标题（裸字符串）。
   *
   * 用于 `tools/rename-sessions.mjs` 的批量改名。
   */
  async listSessions() {
    const value = await this.call('session/list', {})
    return Array.isArray(value?.items) ? value.items : []
  }

  /**
   * 把某会话的人设推给 qq-guard 插件（动态 section 现读）。
   *
   * 协议：POST /dsh-qq-guard/persona
   *   { sessionId, text }        单人设（空串 = 恢复全局）
   *   { mode:'default', text }   全局默认人设
   */
  async setSessionPersona({ sessionId, text, mode } = {}) {
    const body = mode === 'default'
      ? { mode: 'default', text: String(text ?? '') }
      : { sessionId: String(sessionId ?? ''), text: String(text ?? '') }
    const res = await fetch(`${this.baseUrl}/dsh-qq-guard/persona`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok || payload?.ok !== true) {
      const error = new Error(payload?.reason ?? `HTTP ${res.status}`)
      error.code = payload?.reason
      throw error
    }
    return payload
  }

  /**
   * 让 Host 侧用模型归纳「这一小时的群聊该往人设里补什么」（2026-10-26 每小时归纳）。
   *
   * 为什么不在桥接里直接调模型：桥接是独立进程，拿不到 `ctx.llm`；
   * guard 插件在 Host 进程里，所以由它代跑一轮（规格 §3 路由）。
   *
   * 协议：POST /dsh-qq-guard/persona-summarize
   *   { groupName, currentPersona, messages: [{name, qq, text}] }
   *   → { ok:true, persona:'…' } / { ok:false, reason:'…' }
   *
   * ⚠️ **失败不抛**：每小时归纳是锦上添花，插件没装 / DSH 换端口 / 模型报错
   * 都只返回 `{ ok:false, reason }`，由调用方打日志跳过本轮。返回的 reason 是
   * 给日志看的英文原因，**绝不发往 QQ**。
   *
   * @param {{groupName?:string, currentPersona?:string,
   *   messages?:Array<{name?:string, qq?:string, text?:string}>}} request
   * @returns {Promise<{ok:boolean, persona?:string, reason?:string}>}
   */
  async summarizePersona({ groupName = '', currentPersona = '', messages = [] } = {}) {
    try {
      // 端口可能在 DSH 重启后变了：先对齐一次（首次探测后是空操作）。
      await this.ensureBaseUrl()
      const res = await fetch(`${this.baseUrl}${PERSONA_SUMMARIZE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: this.ensureCookie() },
        body: JSON.stringify({
          groupName: String(groupName ?? ''),
          currentPersona: String(currentPersona ?? ''),
          messages: Array.isArray(messages)
            ? messages.map((item) => ({
              name: String(item?.name ?? ''),
              qq: String(item?.qq ?? ''),
              text: String(item?.text ?? ''),
            }))
            : [],
        }),
        // 60s：比普通 RPC 的 timeoutMs 长得多，因为 Host 那边要真跑一轮模型。
        signal: AbortSignal.timeout(SUMMARIZE_TIMEOUT_MS),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok || payload?.ok !== true) {
        return { ok: false, reason: String(payload?.reason ?? `HTTP ${res.status}`) }
      }
      return { ok: true, persona: typeof payload.persona === 'string' ? payload.persona : '' }
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) }
    }
  }
}
