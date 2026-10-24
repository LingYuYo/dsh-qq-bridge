/**
 * 会话指令轮询器（清空上下文 / 删除会话 / 保存单人设）。
 *
 * ## 为什么需要它
 * 设置页的按钮在浏览器里，DSH 会话与 `state/sessions.json` 却归桥接进程管理。
 * Host 不能直接改那份 state（桥接的下一次落盘会覆盖），所以选择**队列 + 轮询**：
 *
 *   UI --POST /dsh-qq-guard/session-ops--> Host 内存队列
 *        桥接每 2 秒 GET 同一路由取走 ops（Host 会给 30s 租约，防重复执行）
 *        桥接执行（归档旧会话 / 建新会话 / 写单人设）后 POST 回执
 *
 * 2 秒延迟换来的好处：不加监听端口、不加鉴权面，DSH 重启后桥接自动跟上。
 *
 * ## 失败策略
 * 轮询失败只记一次 warn，绝不影响聊天主链路；执行失败会把 error 回传给 Host，
 * UI 侧只体现为「列表没变化」，日志里能查到原因（桥接日志）。
 */

/** 与 plugins/dsh-qq-guard/index.js 的 SESSION_OPS_ROUTE_PATH 一致。 */
export const SESSION_OPS_ROUTE = '/dsh-qq-guard/session-ops'
/** 默认轮询间隔：2 秒（与配置热更新同节奏）。 */
export const DEFAULT_POLL_MS = 2000
/**
 * 需要脱离串行链执行的 op（慢操作，P2）。
 *
 * `voice`（TTS 合成 + 上传）和 `image`（下载 / 转码 / 上传）都可能要几秒；
 * 串行 await 会让同一批里的 clear / delete / persona 干等，设置页看起来像卡住。
 * 结果仍按 id 单独回传（Host 侧 qq_send_voice / qq_send_image 正等回执）。
 */
export const DETACHED_OPS = new Set(['voice', 'image'])

const timeout = (ms) => AbortSignal.timeout(ms)

/**
 * 从 Host 取出待执行的指令。
 * @param {string} baseUrl
 * @param {{fetchImpl?:Function, timeoutMs?:number}} [opts]
 * @returns {Promise<Array<{id:string, op:string, key:string, text?:string}>>}
 */
export async function fetchSessionOps(baseUrl, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}${SESSION_OPS_ROUTE}`, {
    headers: { accept: 'application/json' },
    signal: timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json().catch(() => ({}))
  if (body?.ok !== true || !Array.isArray(body.ops)) throw new Error('响应格式不符')
  return body.ops
}

/**
 * 回传执行结果（Host 据此把指令从队列里移除）。
 * @param {string} baseUrl
 * @param {Array<{id:string, ok:boolean, detail?:string}>} results
 * @param {{fetchImpl?:Function, timeoutMs?:number}} [opts]
 */
export async function reportSessionOps(baseUrl, results, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}${SESSION_OPS_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ results }),
    signal: timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return true
}

/**
 * 启动轮询。返回停止函数。
 *
 * @param {object} opts
 * @param {string} [opts.baseUrl] 固定地址（与 getBaseUrl 二选一）
 * @param {() => string} [opts.getBaseUrl] 现读地址：DSH 换端口后桥接已自愈，
 *   轮询器跟着 dsh.baseUrl 走，不至于 DSH 一重启就永远取不到指令。
 * @param {object} opts.bridge Bridge 实例（提供 applySessionOp）
 * @param {object} [opts.logger]
 * @param {number} [opts.pollMs]
 * @param {Function} [opts.fetchImpl] 测试注入
 * @returns {() => void}
 */
export function startSessionOpsPolling({
  baseUrl,
  getBaseUrl,
  bridge,
  logger,
  pollMs = DEFAULT_POLL_MS,
  fetchImpl = fetch,
} = {}) {
  let stopped = false
  let timer = null
  let warned = false

  const resolveBase = () => {
    const value = typeof getBaseUrl === 'function' ? getBaseUrl() : baseUrl
    return String(value ?? '').replace(/\/+$/, '')
  }

  /**
   * 把 applySessionOp 的结果统一成回执。
   * detail 优先：voice / image 这类 op 会把「可读原因」写进 detail（error 只留短码），
   * Host 侧 qq_send_voice / qq_send_image 靠它把失败原因回给模型。
   */
  const toReceipt = (op, result) => {
    const ok = result?.ok !== false
    const detail = typeof result?.detail === 'string' && result.detail.trim() !== ''
      ? result.detail
      : (ok ? '' : (result?.error ?? '执行失败'))
    return { id: op.id, ok, ...(detail ? { detail } : {}) }
  }

  /** 执行一条 op；抛错也转成失败回执（绝不让一条 op 的异常打断整批）。 */
  const runOp = async (op) => {
    try {
      return toReceipt(op, await bridge.applySessionOp(op))
    } catch (error) {
      return { id: op.id, ok: false, detail: error?.message ?? String(error) }
    }
  }

  /**
   * 慢 op（voice / image）脱离主串行链执行（P2，见 {@link DETACHED_OPS}）。
   *
   * 为什么：TTS 合成 / 图片下载 + NapCat 上传可能要几秒，而轮询器每 2 秒一轮；
   * 串行 await 会让同一批里的 clear / delete / persona 干等，设置页看起来像卡住。
   * 结果**照常回传**（Host 按 id 消费，qq_send_voice / qq_send_image 正等这一条），
   * 只是不阻塞其它 op。
   */
  const runDetached = (url, op) => {
    const started = Date.now()
    void runOp(op).then(async (receipt) => {
      if (stopped) return
      try {
        await reportSessionOps(url, [receipt], { fetchImpl })
        logger?.info?.(`已回传后台指令 ${op.op}：${receipt.ok ? '✓' : '✗'}（${Date.now() - started}ms）`)
      } catch (error) {
        logger?.warn?.(`后台指令 ${op.op} 回执回传失败：${error?.message ?? error}`)
      }
    })
  }

  const tick = async () => {
    if (stopped) return
    const url = resolveBase()
    if (!url) {
      if (!stopped) timer = setTimeout(tick, pollMs)
      return
    }
    try {
      const ops = await fetchSessionOps(url, { fetchImpl })
      if (ops.length > 0) warned = false
      const results = []
      for (const op of ops) {
        // 慢 op（voice / image）异步执行，不阻塞后面的 op；其余 op 保持串行，语义不变。
        if (DETACHED_OPS.has(op?.op)) {
          runDetached(url, op)
          continue
        }
        results.push(await runOp(op))
      }
      if (results.length > 0) {
        await reportSessionOps(url, results, { fetchImpl })
        logger?.info?.(`已执行 ${results.length} 条会话指令：${results.map((r) => `${r.ok ? '✓' : '✗'}`).join('')}`)
      }
    } catch (error) {
      if (!warned) {
        warned = true
        logger?.warn?.(`读取会话指令失败（不影响聊天，继续重试）：${error?.message ?? error}`)
      }
    }
    if (!stopped) {
      timer = setTimeout(tick, pollMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
  }

  void tick()

  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
}
