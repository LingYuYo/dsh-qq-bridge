/**
 * 本地插件通道（plugin hub，2026-10-26）。
 *
 * 桥接**入站**的一小块 HTTP 面，给 `Dsh-QQ-Mod` 三个插件和 DSH 内的 guard 用：
 *
 *   POST /send/text            插件 → 桥接：发文本（复用 _send 的延迟/失败统计，不 @ 人）
 *   POST /send/record          插件 → 桥接：发语音（qq.sendVoice + state 目录落盘降级）
 *   GET  /plugins/tools        guard → 桥接：聚合各插件的工具清单
 *   POST /plugins/tools/execute guard → 桥接：按名字转发给插件，args 里注入 chatKey
 *   GET  /health               排障用（契约外的便利接口）
 *
 * 另外两块**出站**能力也归这里（不依赖上面的监听端口）：
 *   · `matchAutoReply()`：入站自动回复判定（`handleMessage` 调，契约 §3）；
 *   · `downloadVideos()`：视频落盘（`handleMessage` 调，契约 §6）。
 *
 * 契约：`.recon/plugin-integration-contract.md` §0-§3、§6。设计红线：
 *   · 只绑 127.0.0.1；token 空串 = 不校验（本机默认）；
 *   · 任何失败都回 **HTTP 200 + `{ok:false,error}`**（鉴权/方法错除外：401/405），
 *     调用方（插件 / guard）只关心 body.ok；
 *   · best-effort：插件不可达 / 超时只 warn（30s 负缓存 / 5s 不重复打），聊天照常；
 *   · 默认全关（`pluginHub.enabled=false`，autoReply / video 各自也是 false），
 *     不配置时不改变现有行为。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSessionKey } from './bridge.mjs'

/** 只允许回环地址（契约 §1）。 */
export const PLUGIN_HUB_BIND_HOST = '127.0.0.1'
export const DEFAULT_PLUGIN_HUB_PORT = 39410
/** 普通请求体上限 1MB（契约 §1）。 */
export const BODY_MAX_BYTES = 1024 * 1024
/** /send/record 上限 64MB（base64 后的音频，契约 §1）。 */
export const RECORD_BODY_MAX_BYTES = 64 * 1024 * 1024
/** 拉单个插件工具清单的超时（契约 §2.2：5s）。 */
export const TOOLS_FETCH_TIMEOUT_MS = 5000
/** 插件清单失败后的冷却：5 秒内不重复打（契约 §2.2）。 */
export const TOOLS_RETRY_TTL_MS = 5000
/** 自动回复失败 / 超时的负缓存（契约 §3：30s，口径同 external-hooks.mjs）。 */
export const AUTO_REPLY_NEGATIVE_TTL_MS = 30_000
/** 工具没写 timeoutMs 时的缺省上限（契约 §2.2 的清单字段；任务口径 8s）。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 8000
/** 工具名白名单前缀（契约 §4：guard 按前缀放行）。 */
const TOOL_NAME_PREFIX = 'qq_ext_'
/** 单条消息最多下载几个视频 / 并发几个（防止一条消息塞十个大文件）。 */
const MAX_VIDEO_COUNT = 4
const VIDEO_CONCURRENCY = 2

/** 契约 §2.3 的默认块：全部关闭，不配置时行为与现在完全一致。 */
export const DEFAULT_PLUGIN_HUB = Object.freeze({
  enabled: false,
  port: DEFAULT_PLUGIN_HUB_PORT,
  token: '',
  autoReply: Object.freeze({ enabled: false, url: 'http://127.0.0.1:39411', timeoutMs: 800 }),
  plugins: Object.freeze([
    Object.freeze({ id: 'feiyu-voice', url: 'http://127.0.0.1:39412', timeoutMs: 120000 }),
    Object.freeze({ id: 'video-frames', url: 'http://127.0.0.1:39413', timeoutMs: 30000 }),
  ]),
  video: Object.freeze({ enabled: false, maxBytes: 52428800, timeoutMs: 30000 }),
})

const clampInt = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** 只接受 http(s) 绝对地址；非法值退回落值（配置写错不该让桥接起不来）。 */
const normalizeUrl = (value, fallback) => {
  const raw = String(value ?? '').trim()
  if (!raw) return fallback
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback
    return raw.replace(/\/+$/u, '')
  } catch { return fallback }
}

/**
 * 把 config.json 的 `pluginHub` 段补全成完整配置（浅合并 + 类型夹紧，不改入参）。
 *
 * 为什么放代码里：`enabled` 默认 false，用户不写这段时桥接行为完全不变；
 * 写了一半（比如只开 video）也不会因为缺字段拿到 undefined。
 *
 * @param {unknown} raw
 * @returns {{enabled:boolean, port:number, token:string,
 *   autoReply:{enabled:boolean,url:string,timeoutMs:number},
 *   plugins:Array<{id:string,url:string,timeoutMs:number}>,
 *   video:{enabled:boolean,maxBytes:number,timeoutMs:number}}}
 */
export function normalizePluginHubConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const autoSrc = src.autoReply && typeof src.autoReply === 'object' && !Array.isArray(src.autoReply)
    ? src.autoReply
    : {}
  const videoSrc = src.video && typeof src.video === 'object' && !Array.isArray(src.video)
    ? src.video
    : {}
  const pluginSrc = Array.isArray(src.plugins) ? src.plugins : DEFAULT_PLUGIN_HUB.plugins
  const plugins = []
  const seen = new Set()
  for (const item of pluginSrc) {
    if (!item || typeof item !== 'object') continue
    const id = String(item.id ?? '').trim()
    const url = normalizeUrl(item.url, '')
    if (!id || !url || seen.has(id)) continue
    seen.add(id)
    plugins.push({
      id,
      url,
      timeoutMs: clampInt(item.timeoutMs, 100, 300_000, DEFAULT_TOOL_TIMEOUT_MS),
    })
  }
  return {
    // 只有显式 true 才开（默认关闭 = 保持现有行为）。
    enabled: src.enabled === true,
    port: clampInt(src.port, 0, 65535, DEFAULT_PLUGIN_HUB_PORT),
    token: typeof src.token === 'string' ? src.token.trim() : '',
    autoReply: {
      enabled: autoSrc.enabled === true,
      url: normalizeUrl(autoSrc.url, DEFAULT_PLUGIN_HUB.autoReply.url),
      timeoutMs: clampInt(autoSrc.timeoutMs, 50, 60_000, DEFAULT_PLUGIN_HUB.autoReply.timeoutMs),
    },
    plugins,
    video: {
      enabled: videoSrc.enabled === true,
      maxBytes: clampInt(videoSrc.maxBytes, 1024, 1024 * 1024 * 1024, DEFAULT_PLUGIN_HUB.video.maxBytes),
      timeoutMs: clampInt(videoSrc.timeoutMs, 1000, 600_000, DEFAULT_PLUGIN_HUB.video.timeoutMs),
    },
  }
}

/** `private:<QQ号>` / `group:<群号>`（也容错 `u:`/`g:`）→ 桥接内部 key。 */
const CHAT_KEY_PATTERN = /^(private|group|u|g):(\d+)$/u

/**
 * 插件侧 chatKey → 桥接内部会话 key。
 *
 * 契约 §2.1 写的是 `group:<群号>` / `private:<QQ号>`，而桥接内部实际用
 * `u:` / `g:`（`parseSessionKey` 只认这两个前缀），两套都收，统一折成内部 key。
 *
 * @param {string} chatKey
 * @returns {string} 内部 key（`u:123` / `g:456`）；不认识返回空串
 */
export function toBridgeChatKey(chatKey) {
  const matched = CHAT_KEY_PATTERN.exec(String(chatKey ?? '').trim())
  if (!matched) return ''
  const [, prefix, id] = matched
  return (prefix === 'private' || prefix === 'u') ? `u:${id}` : `g:${id}`
}

/**
 * 桥接内部会话 key → 插件侧 chatKey（`private:` / `group:`）。
 * 插件（如 feiyu-voice / auto-reply）按前缀判断会话类型，所以对外用契约写法。
 *
 * @param {string} key
 * @returns {string}
 */
export function toPluginChatKey(key) {
  const internal = toBridgeChatKey(key) || String(key ?? '').trim()
  const { kind, qq } = parseSessionKey(internal)
  if (!kind || !/^\d+$/u.test(qq)) return ''
  return kind === 'private' ? `private:${qq}` : `group:${qq}`
}

/** 读请求体并按上限截断（超限抛错，调用方回 `{ok:false}`）。 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const cleanup = () => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
    }
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }
    const onData = (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish(reject, new Error(`请求体超过 ${Math.round(limit / 1024 / 1024)}MB 上限`))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        finish(resolve, {})
        return
      }
      let value
      try {
        value = JSON.parse(text)
      } catch {
        finish(reject, new Error('请求体不是合法 JSON'))
        return
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        finish(resolve, {})
        return
      }
      finish(resolve, value)
    }
    const onError = (error) => finish(reject, error)
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

/** 判断一个错误是不是超时（fetch 的 AbortSignal.timeout 抛 TimeoutError/DOMException）。 */
function isTimeoutError(error) {
  const name = String(error?.name ?? '')
  return name === 'TimeoutError' || name === 'AbortError'
}

const errorText = (error) => String(error?.message ?? error ?? '未知错误')

/**
 * 插件通道。
 *
 * @property {object} bridge 桥接实例（提供 _send / qq / statePath / chatKeyForSession）
 * @property {object} config 见 {@link normalizePluginHubConfig}
 * @property {object} [logger] { info, warn, error }
 * @property {Function} [fetchImpl] 测试注入
 */
export class PluginHub {
  constructor({ bridge, config, logger, fetchImpl = fetch } = {}) {
    this.bridge = bridge
    this.config = normalizePluginHubConfig(config)
    this.logger = logger ?? {}
    this.fetchImpl = fetchImpl
    this.server = null
    this._port = 0
    /** 失败只 warn 一次（key = 用途）；成功即删，恢复后会再报。 */
    this._warned = new Set()
    /** 自动回复失败负缓存截止时间戳（ms）。 */
    this._autoReplyNegativeUntil = 0
    /** 工具清单缓存：{ at, tools }。 */
    this._toolsCache = null
    /** 单个插件的工具清单缓存：id -> { at, result }（失败也缓存 5s，避免反复打）。 */
    this._pluginToolsCache = new Map()
    /** 视频落盘目录：桥接 state 目录下的 media/（与 voice 落盘降级同源）。 */
    const statePath = String(bridge?.statePath ?? '').trim()
    this.stateDir = statePath ? path.dirname(statePath) : path.resolve('state')
    this.mediaDir = path.join(this.stateDir, 'media')
    this._routes = {
      '/health': { method: 'GET', run: async () => ({ ok: true, plugin: 'bridge-plugin-hub', port: this._port || this.config.port }) },
      '/send/text': { method: 'POST', limit: BODY_MAX_BYTES, run: (body) => this.sendText(body) },
      '/send/record': { method: 'POST', limit: RECORD_BODY_MAX_BYTES, run: (body) => this.sendRecord(body) },
      '/plugins/tools': { method: 'GET', run: async () => ({ ok: true, tools: await this.listTools() }) },
      '/plugins/tools/execute': { method: 'POST', limit: BODY_MAX_BYTES, run: (body) => this.executeTool(body) },
    }
  }

  /** 起监听（`enabled=false` 时什么都不做）。返回 `{ok, port}`，起不来抛可读错误。 */
  async start() {
    if (!this.config.enabled) return { ok: false, reason: 'disabled' }
    if (this.server) return { ok: true, port: this._port }
    const server = http.createServer((req, res) => {
      void this._handle(req, res)
    })
    server.on('clientError', (error, socket) => {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* 连接已经坏了 */ }
    })
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.config.port, PLUGIN_HUB_BIND_HOST)
      })
    } catch (error) {
      const reason = error?.code === 'EADDRINUSE'
        ? `端口 ${this.config.port} 已被占用（改 config.pluginHub.port 或先停掉占用的进程）`
        : `监听失败：${errorText(error)}`
      throw new Error(reason)
    }
    this.server = server
    this._port = Number(server.address()?.port ?? this.config.port)
    return { ok: true, port: this._port }
  }

  /** 关监听（没起过 / 已关掉都安全）。 */
  async stop() {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise((resolve) => {
      server.close(() => resolve())
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
    })
  }

  /** 监听端口（`start()` 后才有意义；测试用）。 */
  get port() { return this._port || this.config.port }

  // ── HTTP 入口 ──────────────────────────────────────────────────────────

  async _handle(req, res) {
    try {
      let pathname = '/'
      try {
        pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
      } catch { /* 用 '/' 兜底 */ }
      if (!this._authorized(req)) {
        this._json(res, 401, { ok: false, error: '未授权：请求头需要 Authorization: Bearer <pluginHub.token>。' })
        return
      }
      const route = this._routes[pathname]
      if (!route) {
        this._json(res, 404, {
          ok: false,
          error: `没有这个接口：${pathname}（可用：${Object.keys(this._routes).join('、')}）`,
        })
        return
      }
      if (String(req.method ?? '').toUpperCase() !== route.method) {
        this._json(res, 405, { ok: false, error: `${pathname} 只接受 ${route.method}` })
        return
      }
      if (route.method === 'GET') {
        this._json(res, 200, await route.run())
        return
      }
      let body
      try {
        body = await readJsonBody(req, route.limit)
      } catch (error) {
        // 超限时读者已经不再取数据，主动排水，避免客户端卡在 half-open 连接上。
        try { req.resume() } catch { /* 已关 */ }
        this._json(res, 200, { ok: false, error: errorText(error) })
        return
      }
      const result = await route.run(body)
      this._json(res, 200, result && typeof result === 'object' ? result : { ok: false, error: '处理结果为空' })
    } catch (error) {
      this.logger?.warn?.(`插件通道请求处理失败：${errorText(error)}`)
      this._json(res, 200, { ok: false, error: `桥接内部错误：${errorText(error)}` })
    }
  }

  _authorized(req) {
    const token = this.config.token
    if (!token) return true
    const header = String(req?.headers?.authorization ?? '').trim()
    return header === `Bearer ${token}`
  }

  _json(res, status, payload) {
    if (!res || res.writableEnded) return
    const body = JSON.stringify(payload ?? {})
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  // ── 插件 → 桥接 ────────────────────────────────────────────────────────

  /**
   * `POST /send/text`：插件让桥接发一条文本。
   *
   * 语义与 `_send` 完全同口径（sendDelayMs 延迟、失败计入 `stats.failed`），
   * 但**不 @ 人**（契约 §2.1：插件发送不 @ 人，与模型的回复区分开）。
   *
   * @param {{chatKey?:string, text?:string}} body
   * @returns {Promise<{ok:boolean, messageIds?:string[], error?:string}>}
   */
  async sendText(body) {
    const { kind, qq } = this._resolveTarget(body?.chatKey)
    if (!kind) return { ok: false, error: 'chatKey 必须是 private:<QQ号> 或 group:<群号>' }
    const text = String(body?.text ?? '').trim()
    if (!text) return { ok: false, error: 'text 不能为空' }
    if (typeof this.bridge?._send !== 'function') return { ok: false, error: '桥接还没准备好发送通道' }
    const msg = { kind, userId: kind === 'private' ? qq : '', groupId: kind === 'group' ? qq : null }
    const result = await this.bridge._send(msg, text, { at: false })
    if (result?.ok === false) return { ok: false, error: String(result.error ?? '发送失败') }
    return { ok: true, messageIds: Array.isArray(result?.messageIds) ? result.messageIds.map(String) : [] }
  }

  /**
   * `POST /send/record`：插件让桥接发一条语音。
   *
   * 走 `qq.sendVoice`（先 base64，失败落盘到桥接 state 目录再 file:// 重发）。
   *
   * ⚠️ 已知偏差：`sendVoice` 的落盘降级文件名固定 `.mp3`（onebot.mjs 既有实现，
   * 本次任务不允许改它的其它行为），所以 `format:'wav'` 只做校验与回执，不决定
   * 降级文件扩展名。NapCat 按内容识别音频，实际不影响发送。
   *
   * @param {{chatKey?:string, base64?:string, format?:'wav'|'mp3'}} body
   * @returns {Promise<{ok:boolean, via?:string, format?:string, messageIds?:string[], error?:string}>}
   */
  async sendRecord(body) {
    const { kind, qq } = this._resolveTarget(body?.chatKey)
    if (!kind) return { ok: false, error: 'chatKey 必须是 private:<QQ号> 或 group:<群号>' }
    const rawFormat = String(body?.format ?? '').trim().toLowerCase()
    const format = rawFormat === '' ? 'mp3' : rawFormat
    if (format !== 'wav' && format !== 'mp3') return { ok: false, error: 'format 只能是 wav 或 mp3' }
    const base64 = String(body?.base64 ?? '').trim()
      .replace(/^data:[^;,]*;base64,/iu, '')
      .replace(/\s+/gu, '')
    if (!base64) return { ok: false, error: 'base64 不能为空' }
    let bytes = 0
    try { bytes = Buffer.from(base64, 'base64').length } catch { bytes = 0 }
    if (bytes <= 0) return { ok: false, error: 'base64 不是合法音频数据' }
    if (typeof this.bridge?.qq?.sendVoice !== 'function') return { ok: false, error: '桥接还没连上 QQ（sendVoice 不可用）' }
    const sent = await this.bridge.qq.sendVoice(kind, qq, base64, { fallbackDir: this.stateDir })
    if (sent?.ok === false) {
      return {
        ok: false,
        error: String(sent.error ?? '语音发送失败'),
        ...(sent.via ? { via: String(sent.via) } : {}),
      }
    }
    return {
      ok: true,
      via: sent?.via ?? 'base64',
      format,
      messageIds: Array.isArray(sent?.messageIds) ? sent.messageIds.map(String) : [],
    }
  }

  /** chatKey → `{kind, qq}`（解析用现成的 parseSessionKey）。 */
  _resolveTarget(chatKey) {
    const internal = toBridgeChatKey(chatKey)
    const { kind, qq } = parseSessionKey(internal)
    if (!kind || !/^\d+$/u.test(String(qq))) return { kind: '', qq: '' }
    return { kind, qq }
  }

  // ── guard → 桥接 ────────────────────────────────────────────────────────

  /**
   * 聚合各插件的工具清单（`GET /plugins/tools` 与 `execute` 共用）。
   *
   * - 单个插件不可达 / 超时：跳过 + warn 一次，5 秒内不重复打；
   * - 只收 `qq_ext_` 开头的工具（guard 白名单按前缀放行，收别的也用不了）；
   * - 同名工具先到先得，后到的忽略。
   *
   * @param {{refresh?:boolean}} [opts]
   * @returns {Promise<Array<{name:string,title:string,description:string,
   *   parameters:object, timeoutMs:number, plugin:string}>>}
   */
  async listTools({ refresh = false } = {}) {
    const now = Date.now()
    if (!refresh && this._toolsCache && now - this._toolsCache.at < TOOLS_RETRY_TTL_MS) {
      return this._toolsCache.tools
    }
    const tools = []
    const seen = new Set()
    for (const plugin of this.config.plugins) {
      const manifest = await this._fetchPluginTools(plugin)
      if (!manifest.ok) continue
      for (const tool of manifest.tools) {
        if (!tool || typeof tool !== 'object') continue
        const name = String(tool.name ?? '').trim()
        if (!name.startsWith(TOOL_NAME_PREFIX) || seen.has(name)) continue
        seen.add(name)
        tools.push({
          name,
          title: String(tool.title ?? '').trim(),
          description: String(tool.description ?? '').trim(),
          parameters: tool.parameters && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters)
            ? tool.parameters
            : { type: 'object', properties: {} },
          // 契约 §2.2：清单里的 timeoutMs 优先，缺了用插件级超时。
          timeoutMs: clampInt(tool.timeoutMs, 100, 300_000, plugin.timeoutMs),
          plugin: plugin.id,
        })
      }
    }
    this._toolsCache = { at: now, tools }
    return tools
  }

  /** 拉单个插件的 `GET /tools`（失败也缓存 5s，warn 只打一次）。 */
  async _fetchPluginTools(plugin) {
    const now = Date.now()
    const cached = this._pluginToolsCache.get(plugin.id)
    if (cached && now - cached.at < TOOLS_RETRY_TTL_MS) return cached.result
    let result
    try {
      const res = await this.fetchImpl(`${plugin.url}/tools`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TOOLS_FETCH_TIMEOUT_MS),
      })
      if (!res?.ok) throw new Error(`HTTP ${res?.status ?? '?'}`)
      const body = await res.json().catch(() => null)
      if (!body || body.ok !== true || !Array.isArray(body.tools)) throw new Error('响应格式不符')
      result = { ok: true, tools: body.tools }
      this._warned.delete(`tools:${plugin.id}`)
    } catch (error) {
      const reason = isTimeoutError(error)
        ? `超时（${TOOLS_FETCH_TIMEOUT_MS}ms）`
        : errorText(error)
      if (!this._warned.has(`tools:${plugin.id}`)) {
        this._warned.add(`tools:${plugin.id}`)
        this.logger?.warn?.(`插件 ${plugin.id} 的工具清单拉不到（跳过，${TOOLS_RETRY_TTL_MS / 1000}s 内不重试）：${reason}`)
      }
      result = { ok: false, tools: [], error: reason }
    }
    this._pluginToolsCache.set(plugin.id, { at: now, result })
    return result
  }

  /**
   * `POST /plugins/tools/execute`：把 guard 的工具调用转发给插件。
   *
   * 关键点（契约 §2.2）：args 里**注入 `chatKey`**（由 sessionId 反查 QQ 会话），
   * 插件自己不知道 DSH 会话对应哪个 QQ 会话；超时按清单里的 `timeoutMs`。
   *
   * @param {{name?:string, args?:object, sessionId?:string}} body
   * @returns {Promise<{ok:boolean, content?:Array<object>, isError?:boolean, error?:string}>}
   */
  async executeTool(body) {
    const name = String(body?.name ?? '').trim()
    if (!name) return { ok: false, error: 'name 不能为空' }
    let tools = await this.listTools()
    let tool = tools.find((item) => item.name === name)
    if (!tool) {
      // 可能是刚起的插件：跳过 5s 缓存再拉一次。
      tools = await this.listTools({ refresh: true })
      tool = tools.find((item) => item.name === name)
    }
    if (!tool) return { ok: false, error: `没有这个工具：${name}（插件通道里没有注册）` }
    const plugin = this.config.plugins.find((item) => item.id === tool.plugin)
    if (!plugin) return { ok: false, error: `工具 ${name} 所属插件 ${tool.plugin} 不在配置里` }
    const chatKey = this._chatKeyForSession(body?.sessionId)
    if (!chatKey) {
      return { ok: false, error: '先让用户发条 QQ 消息，桥接才能定位会话' }
    }
    const rawArgs = body?.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {}
    const args = { ...rawArgs, chatKey }
    const timeout = clampInt(tool.timeoutMs, 100, 300_000, DEFAULT_TOOL_TIMEOUT_MS)
    let res
    try {
      res = await this.fetchImpl(`${plugin.url}/tools`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ name, args }),
        signal: AbortSignal.timeout(timeout),
      })
    } catch (error) {
      const reason = isTimeoutError(error) ? `执行超时（${timeout}ms）` : `不可达：${errorText(error)}`
      this.logger?.warn?.(`插件 ${plugin.id} 工具 ${name} ${reason}`)
      return { ok: false, error: `插件 ${plugin.id} ${reason}` }
    }
    const payload = await res.json().catch(() => null)
    if (!res?.ok) {
      return { ok: false, error: `插件 ${plugin.id} 返回 HTTP ${res?.status ?? '?'}${payload?.error ? `：${payload.error}` : ''}` }
    }
    if (!payload || payload.ok !== true) {
      return { ok: false, error: String(payload?.error ?? '插件没有返回结果（响应格式不符）') }
    }
    return {
      ok: true,
      content: Array.isArray(payload.content) ? payload.content : [],
      ...(payload.isError === true ? { isError: true } : {}),
    }
  }

  /** sessionId → 插件侧 chatKey（桥接会话表反查，找不到返回空串）。 */
  _chatKeyForSession(sessionId) {
    const id = String(sessionId ?? '').trim()
    if (!id) return ''
    let key = ''
    try {
      key = typeof this.bridge?.chatKeyForSession === 'function' ? this.bridge.chatKeyForSession(id) : ''
    } catch { key = '' }
    return key ? toPluginChatKey(key) : ''
  }

  // ── 出站：自动回复判定（契约 §3） ───────────────────────────────────────

  /**
   * 问一下自动回复插件「这条要不要自动回」。
   *
   * **永不抛**：未启用 / 不可达 / 超时 / 格式不符都返回 `{handled:false}`，
   * 让消息照常进 DSH。失败 30 秒负缓存 + warn 一次（口径同 external-hooks.mjs）。
   *
   * @param {{kind:string, qq:string, text:string, senderName?:string,
   *   senderId?:string, groupId?:string}} payload
   * @returns {Promise<{ok:boolean, handled:boolean, reply?:string, reason?:string,
   *   skipped?:string, error?:string}>}
   */
  async matchAutoReply(payload = {}) {
    const config = this.config.autoReply
    if (!config?.enabled) return { ok: false, handled: false, skipped: 'disabled' }
    const now = Date.now()
    if (now < this._autoReplyNegativeUntil) {
      return { ok: false, handled: false, skipped: 'negative-cache' }
    }
    const kind = payload.kind === 'private' ? 'private' : 'group'
    const qq = String(payload.qq ?? '').trim()
    if (!/^\d+$/u.test(qq)) return { ok: false, handled: false, error: 'QQ 号不合法' }
    const body = {
      chatKey: kind === 'private' ? `private:${qq}` : `group:${qq}`,
      text: String(payload.text ?? ''),
      senderName: String(payload.senderName ?? ''),
      senderId: String(payload.senderId ?? ''),
      kind,
      ...(kind === 'group' && payload.groupId ? { groupId: String(payload.groupId) } : {}),
    }
    let res
    try {
      res = await this.fetchImpl(`${config.url}/match`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      })
    } catch (error) {
      return this._autoReplyFailed(isTimeoutError(error)
        ? `超时（${config.timeoutMs}ms）`
        : errorText(error))
    }
    if (!res?.ok) return this._autoReplyFailed(`HTTP ${res?.status ?? '?'}`)
    const parsed = await res.json().catch(() => null)
    if (!parsed || typeof parsed !== 'object') return this._autoReplyFailed('响应格式不符')
    this._autoReplyNegativeUntil = 0
    this._warned.delete('auto-reply')
    if (parsed.handled === true) {
      const reply = String(parsed.reply ?? '').trim()
      if (!reply) return { ok: true, handled: false, reason: 'empty-reply' }
      return { ok: true, handled: true, reply }
    }
    return { ok: true, handled: false, reason: String(parsed.reason ?? 'no-match') }
  }

  /** 自动回复失败：30s 负缓存 + warn 一次。 */
  _autoReplyFailed(reason) {
    this._autoReplyNegativeUntil = Date.now() + AUTO_REPLY_NEGATIVE_TTL_MS
    if (!this._warned.has('auto-reply')) {
      this._warned.add('auto-reply')
      this.logger?.warn?.(
        `自动回复插件不可用（${reason}）：${AUTO_REPLY_NEGATIVE_TTL_MS / 1000}s 内不再尝试，消息照常交给 DSH。`,
      )
    }
    return { ok: false, handled: false, error: reason }
  }

  // ── 出站：视频落盘（契约 §6） ───────────────────────────────────────────

  /**
   * 把消息里的视频段下载到 `state/media/`。
   *
   * 只做本地落盘（NapCat 给的 url 是可直接下载的地址），不碰 NapCat 的 HTTP API；
   * 失败 / 超时 / 超大小只 warn，调用方保持原样继续。并发上限 2。
   *
   * @param {Array<{url?:string, file?:string}>} videos
   * @returns {Promise<{ok:boolean, paths:string[], errors:string[]}>}
   */
  async downloadVideos(videos) {
    const config = this.config.video
    const list = (Array.isArray(videos) ? videos : [])
      .filter((item) => item && typeof item === 'object' && (item.url || item.file))
      .slice(0, MAX_VIDEO_COUNT)
    if (!config?.enabled || list.length === 0) return { ok: true, paths: [], errors: [] }
    try {
      fs.mkdirSync(this.mediaDir, { recursive: true })
    } catch (error) {
      this.logger?.warn?.(`视频落盘目录创建失败（跳过视频）：${errorText(error)}`)
      return { ok: false, paths: [], errors: [errorText(error)] }
    }
    const stamp = Date.now()
    const results = new Array(list.length)
    let cursor = 0
    const worker = async () => {
      while (cursor < list.length) {
        const index = cursor++
        results[index] = await this._downloadVideo(list[index], `video-${stamp}-${index + 1}.mp4`, config)
      }
    }
    await Promise.all(Array.from({ length: Math.min(VIDEO_CONCURRENCY, list.length) }, worker))
    const paths = []
    const errors = []
    for (const result of results) {
      if (result?.ok && result.file) paths.push(result.file)
      else if (result?.error) errors.push(String(result.error))
    }
    return { ok: errors.length === 0, paths, errors }
  }

  /** 下载单个视频（http(s) 或本地 file:///绝对路径），失败只返回原因。 */
  async _downloadVideo(video, name, config) {
    const ref = String(video?.url || video?.file || '').trim()
    const file = path.join(this.mediaDir, name)
    try {
      if (!ref) throw new Error('空地址')
      if (/^https?:\/\//iu.test(ref)) {
        const res = await this.fetchImpl(ref, { signal: AbortSignal.timeout(config.timeoutMs) })
        if (!res?.ok) throw new Error(`HTTP ${res?.status ?? '?'}`)
        const declared = Number(res.headers?.get?.('content-length') ?? 0)
        if (declared > 0 && declared > config.maxBytes) {
          throw new Error(`视频过大（${declared} 字节 > ${config.maxBytes}）`)
        }
        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer.byteLength > config.maxBytes) {
          throw new Error(`视频过大（${buffer.byteLength} 字节 > ${config.maxBytes}）`)
        }
        if (buffer.byteLength === 0) throw new Error('空文件')
        await fs.promises.writeFile(file, buffer)
      } else {
        const source = ref.startsWith('file://') ? fileURLToPath(ref) : ref
        if (!path.isAbsolute(source)) throw new Error(`不支持的视频地址：${ref.slice(0, 80)}`)
        const stat = await fs.promises.stat(source)
        if (!stat.isFile()) throw new Error('不是文件')
        if (stat.size > config.maxBytes) throw new Error(`视频过大（${stat.size} 字节 > ${config.maxBytes}）`)
        await fs.promises.copyFile(source, file)
      }
      return { ok: true, file }
    } catch (error) {
      const reason = isTimeoutError(error) ? `超时（${config.timeoutMs}ms）` : errorText(error)
      this.logger?.warn?.(`视频下载失败（保持原 [视频] 占位，不影响聊天）：${reason}`)
      return { ok: false, error: reason }
    }
  }
}
