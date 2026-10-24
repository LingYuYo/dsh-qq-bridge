/**
 * 外部插件 hook 客户端（P2，2026-10-24）。
 *
 * 桥接只做**客户端**：把 QQ 消息 / 本轮上下文 POST 给 Host 的
 * `POST /dsh-qq-guard/external/hook`，由 Host 的常驻沙箱去调外部插件。
 * 契约见 `.recon/p2-contract.md` 第 4.2 / 4.4 节。
 *
 * 设计取舍：
 *   · **best-effort**：HTTP 失败 / 超时 / `ok:false` 一律只 warn，聊天照常；
 *     桥接绝不因为外部插件而丢消息；
 *   · **负缓存**：路由回 `modules:[]`（没有启用插件 / 该事件没有 hook）后，
 *     该事件 30 秒内不再请求——否则每收一条 QQ 消息就多打一次本地 HTTP；
 *     按事件分开缓存：`message` 没有 hook 不代表 `before-context` 也没有；
 *   · 失败只告警一次（成功即复位），避免日志被刷屏。
 */

/** 与 plugins/dsh-qq-guard/index.js 的 external hook 路由一致。 */
export const EXTERNAL_HOOK_ROUTE = '/dsh-qq-guard/external/hook'
/** 单次 hook 的等待上限（契约 4.4：2.5s）。 */
export const DEFAULT_HOOK_TIMEOUT_MS = 2500
/** 无模块生效时的负缓存时长（契约：30s）。 */
export const NO_MODULE_TTL_MS = 30_000
/** 单次最多接受几段外部上下文（防止外部插件把 prompt 撑爆）。 */
const MAX_SECTIONS = 8
/** 单段外部上下文正文上限（字符）。 */
const MAX_SECTION_CHARS = 20_000

/** 归一化 sections：只收 `{title, text}` 且 text 非空的段。 */
function normalizeSections(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value.slice(0, MAX_SECTIONS)) {
    if (!item || typeof item !== 'object') continue
    const text = String(item.text ?? '').trim()
    if (!text) continue
    out.push({
      title: String(item.title ?? '').trim(),
      text: text.slice(0, MAX_SECTION_CHARS),
    })
  }
  return out
}

/**
 * 外部插件 hook 客户端。
 *
 * @property {() => string} [getBaseUrl] 现读 DSH 地址（端口可能被桥接自愈更新）
 * @property {() => string} [getCookie] 可选的 DSH 会话 Cookie（路由不强制，带上更稳）
 * @property {object} [logger] { warn }
 * @property {number} [timeoutMs=2500]
 * @property {number} [negativeTtlMs=30000]
 * @property {Function} [fetchImpl=fetch] 测试注入
 */
export class ExternalHooksClient {
  constructor({
    getBaseUrl, getCookie, logger,
    timeoutMs = DEFAULT_HOOK_TIMEOUT_MS,
    negativeTtlMs = NO_MODULE_TTL_MS,
    fetchImpl = fetch,
  } = {}) {
    this.getBaseUrl = getBaseUrl
    this.getCookie = getCookie
    this.logger = logger ?? {}
    this.timeoutMs = timeoutMs
    this.negativeTtlMs = negativeTtlMs
    this.fetchImpl = fetchImpl
    /** event -> 负缓存截止时间戳（ms）。 */
    this._negativeUntil = new Map()
    /** 失败只告警一次（成功复位）。 */
    this._warned = false
  }

  /** 当前 baseUrl（去掉尾部斜杠）。 */
  _base() {
    const value = typeof this.getBaseUrl === 'function' ? this.getBaseUrl() : this.getBaseUrl
    return String(value ?? '').replace(/\/+$/, '')
  }

  /** 可选 Cookie；读失败（缺凭据）就当没有，不能因此不发 hook。 */
  _cookie() {
    try {
      const value = typeof this.getCookie === 'function' ? this.getCookie() : this.getCookie
      return typeof value === 'string' ? value : ''
    } catch { return '' }
  }

  _warnOnce(message) {
    if (this._warned) return
    this._warned = true
    this.logger?.warn?.(message)
  }

  /** 该事件当前是否处于负缓存窗口（窗口内一次 HTTP 都不发）。 */
  _cached(event) {
    const until = this._negativeUntil.get(event)
    if (!until) return false
    if (Date.now() < until) return true
    this._negativeUntil.delete(event)
    return false
  }

  /**
   * 触发一次 hook。**永不抛**（失败时 `ok:false`，聊天侧按原样继续）。
   *
   * @param {'message'|'before-context'} event
   * @param {object} [payload] 其余字段（sessionId / key / text / imageCount / user / group）
   * @returns {Promise<{ok:boolean, modules:string[], latencyMs:number,
   *   skipped?:string, error?:string, drop?:boolean, text?:string,
   *   sections?:Array<{title:string, text:string}>}>}
   */
  async invoke(event, payload = {}) {
    const base = this._base()
    if (!base) return { ok: false, modules: [], latencyMs: 0, error: 'no-base' }
    if (this._cached(event)) {
      return { ok: true, modules: [], latencyMs: 0, skipped: 'no-module-cache' }
    }
    const started = Date.now()
    const headers = { 'content-type': 'application/json', accept: 'application/json' }
    const cookie = this._cookie()
    if (cookie) headers.cookie = cookie
    let res
    try {
      res = await this.fetchImpl(`${base}${EXTERNAL_HOOK_ROUTE}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...payload, event }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      this._warnOnce(`外部插件 hook 请求失败（不影响聊天，30s 内只提示一次）：${error?.message ?? error}`)
      return {
        ok: false, modules: [], latencyMs: Date.now() - started,
        error: String(error?.message ?? error),
      }
    }
    const latencyMs = Date.now() - started
    if (!res?.ok) {
      this._warnOnce(`外部插件 hook 返回 HTTP ${res?.status ?? '?'}（不影响聊天，30s 内只提示一次）`)
      return { ok: false, modules: [], latencyMs, error: `HTTP ${res?.status ?? '?'}` }
    }
    const body = await res.json().catch(() => null)
    if (!body || body.ok !== true) {
      this._warnOnce('外部插件 hook 响应格式不符（忽略本次 hook，不影响聊天）')
      return { ok: false, modules: [], latencyMs, error: 'bad-body' }
    }
    const modules = Array.isArray(body.modules) ? body.modules.map(String) : []
    if (modules.length === 0) {
      // 该事件没有生效模块：30 秒内不再请求，省掉每条消息一次本地 HTTP。
      this._negativeUntil.set(event, Date.now() + this.negativeTtlMs)
    } else {
      this._negativeUntil.delete(event)
    }
    this._warned = false
    return {
      ok: true,
      modules,
      latencyMs,
      ...(body.drop === true ? { drop: true } : {}),
      ...(typeof body.text === 'string' ? { text: body.text } : {}),
      sections: normalizeSections(body.sections),
    }
  }
}
