/**
 * QQ 会话「按请求覆写模型」——Host 侧实现骨架。
 *
 * ⚠️ 本文件尚未被 index.js 引用。接线方式见文末注释与 MODEL-OVERRIDE-DESIGN.md。
 *
 * ## 为什么可行（机制，不是猜测）
 *
 * `agent/request` 是 turn 内**每一次** LLM 调用前最后一个可改路由的瀑布：
 *
 *   dsh-agent-loop/lib/index.js:1175  async prepareRequest(turn, step, signal) {
 *   dsh-agent-loop/lib/index.js:1191    const proposedConfig = await this.dispatch.waterfall("agent/request",
 *   dsh-agent-loop/lib/index.js:1191        { turn, step, signal }, () => Promise.resolve(seedConfig))
 *   dsh-agent-loop/lib/index.js:1201    preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
 *
 * 瀑布的返回值**就是**这次请求真正用的 config（provider/model/effort/温度/上限），
 * 之后直接进 `llm.prepareCall` → adapter → HTTP。妥妥的最后一站。
 *
 * 三个容易踩的点，本文件都处理了：
 *
 * 1. **排序**：cordis 瀑布「先注册的在最外层，外层返回值最终生效」
 *    （cordis/src/events.ts:280-292 `cbs.shift()`）。`installModelSelection` 在
 *    agent 创建时才注册（dsh-agent/lib/index.js:181），本插件的钩子在 Host 启动时
 *    注册 —— 天然在外层。仍显式用 `{ prepend: true }`：HMR 重载插件时会重新注册，
 *    不 prepend 就会掉到内层，被 selection 钩子盖掉（这是最难查的隐性失效）。
 *
 * 2. **身份**：payload 里带 `agent` —— `agentEvents` 的 `fused()` 会把 agent 注入
 *    payload（dsh-agent/lib/index.js:255-270），所以 `payload.agent.session.id`
 *    就是会话 id，不需要解析文本、不需要猜。
 *
 * 3. **可见性**：本插件的 ctx 没有 scope tag，`scopeTarget` 的过滤器对
 *    「无 tag 的监听者」一律放行（dsh-scope/lib/index.js:327-338），所以根级监听器
 *    能收到**每一个** agent（含 preset 内、含子代理）的请求 —— 我们只对表里的
 *    sessionId 动手，其它一概透传。
 *
 * ## 代价（必须知道）
 *
 * · 不调 `session/selectModel`，所以 DSH 原生 UI 的模型选择器还是旧值。这是
 *   「不改全局默认」的必然代价。会话的 `request/header` 事件仍会如实记录真实模型，
 *   面板/用量统计读 header 就不会错。
 * · 新会话**第一次**请求时，会话内 selection 还停在全局默认，selection 钩子会在
 *   下一步往对话里塞一条 `[model changed: ...]` 提示。本文件用 pre-step 过滤器
 *   把它摘掉（只摘自己接管了的会话，别的不碰）。
 * · 多模态准入检查（session/prompt 里对 image 的检查）看的是**会话 selection**，
 *   不是本钩子的覆写值。所以「当前 selection 支持图片、我们覆写成纯文本模型」时，
 *   图片会被放行然后被上游拒绝。面板侧要在切模型时自己校验 `input` 能力。
 */

/** 桥接进程读写模型偏好的路由。和 CONFIG_ROUTE_PATH / STATUS_ROUTE_PATH 同一套风格。 */
export const MODEL_ROUTE_PATH = '/dsh-qq-guard/model'

/** 面板读「provider + model + 多模态能力」的只读路由（两接口 join 在 Host 侧做完）。 */
export const MODELS_ROUTE_PATH = '/dsh-qq-guard/models'

/** 面板读「系统底层事件」的只读路由（看门狗/降级/取消等过程，最近 N 条）。 */
export const SYSTEM_EVENTS_ROUTE_PATH = '/dsh-qq-guard/system-events'

/** 事件环形队列长度。 */
const SYSTEM_EVENT_LIMIT = 20

/**
 * 系统底层事件环形队列。
 *
 * 为什么需要：看门狗切断、切备用、取消这一串动作全发生在 Host 进程内，
 * 用户只看到「回复慢」或「突然换了模型」，完全无感。这里记一条带时间戳的轻量事件，
 * 面板轮询展示，排查时不用翻日志。
 *
 * 结构：{ at: ISO 字符串, ts: 毫秒, level: 'warn'|'error'|'info', kind, message, detail? }
 */
const systemEvents = []

/**
 * 记一条系统底层事件。
 * @param {'info'|'warn'|'error'} level
 * @param {string} kind 机器可读类别（watchdog / fallback / agent-error / cancel …）
 * @param {string} message 人话描述
 * @param {object} [detail] 附加字段（provider / model / 耗时…）
 */
function pushSystemEvent(level, kind, message, detail) {
  const now = Date.now()
  systemEvents.push({
    ts: now,
    at: new Date(now).toISOString(),
    level,
    kind,
    message,
    ...(detail === undefined ? {} : { detail }),
  })
  if (systemEvents.length > SYSTEM_EVENT_LIMIT) {
    systemEvents.splice(0, systemEvents.length - SYSTEM_EVENT_LIMIT)
  }
}

/** 目录缓存：resolveModelInfo 是逐模型异步调用，面板一开就全量打一遍太浪费。 */
const CATALOG_TTL_MS = 60_000
let catalogCache = { at: 0, value: undefined }

/** 表上限。QQ 会话会被清理/归档，但桥接可能来不及通知；超限按最近最少使用淘汰。 */
const MAX_ENTRIES = 500

/**
 * sessionId → { provider, model, reasoningEffort?, fallbacks?, updatedAt }
 *
 * 为什么放内存、不放 Config：这是**瞬时协商结果**，不是用户设置。桥接每条消息前
 * 都会重新 POST 一次（幂等、开销可忽略），DSH 重启后自然失效回全局默认，
 * 不会有「配置文件里躺着一条指向已删除会话的偏好吗」这种脏数据。
 * 持久化留在桥接侧的 per-chat 配置里。
 */
const overrides = new Map()

/** 降级游标：`${sessionId}` → 已用掉几个 fallback。成功一轮后由 pre-step 重置。 */
const fallbackCursor = new Map()

/**
 * 判断一条消息是不是 selection 钩子塞的模型切换提示。
 * @param {any} message 候选消息
 * @returns {boolean}
 */
function isModelSwitchNotice(message) {
  const source = message?.source
  return source?.kind === 'model-selection' && source?.form === 'notice'
}

/**
 * 取会话 id。agent 与 session 的 id 在 DSH 里是一致的，两个都兜。
 * @param {any} agent agent/request payload 里的 agent
 * @returns {string|undefined}
 */
function sessionIdOf(agent) {
  const id = agent?.session?.id ?? agent?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * 读一条偏好，顺带做 LRU 续期。
 * @param {any} agent
 * @returns {{provider:string, model:string, reasoningEffort?:string, fallbacks?:Array<{provider:string,model:string}>}|undefined}
 */
function readOverride(agent) {
  const sessionId = sessionIdOf(agent)
  if (sessionId === undefined) return undefined
  const entry = overrides.get(sessionId)
  if (entry === undefined) return undefined
  // 续期：Map 的插入序就是 LRU 序，删了重插即可。
  overrides.delete(sessionId)
  overrides.set(sessionId, entry)
  const cursor = fallbackCursor.get(sessionId) ?? 0
  const effective = cursor > 0 && Array.isArray(entry.fallbacks) && entry.fallbacks.length >= cursor
    ? { ...entry, ...entry.fallbacks[cursor - 1] }
    : entry
  return effective
}

/** 看门狗判定的超时错误码（故意不是 TIMEOUT：TIMEOUT 在 dsh-llm-retry 的可重试名单里，
 *  会先同模型重试 5 次，把降级推迟到 1 分钟以后；未知码则直接交给我们的降级链）。 */
const WATCHDOG_CODE = 'WATCHDOG_TIMEOUT'

/**
 * 当前被接管的模型路由集合（主模型 + 所有备用）。
 *
 * 看门狗只包这些路由的流 —— 其它会话（浏览器里用户自己的、子代理的）一律不碰，
 * 避免把「长思考不吐字」的正常请求误杀。
 * @returns {Set<string>}
 */
function managedRoutes() {
  const routes = new Set()
  for (const entry of overrides.values()) {
    if (entry.mode === 'default') continue
    if (entry.provider && entry.model) routes.add(`${entry.provider}/${entry.model}`)
    for (const fallback of entry.fallbacks ?? []) routes.add(`${fallback.provider}/${fallback.model}`)
  }
  return routes
}

/**
 * 给一条 chunk 流加「静默看门狗」。
 *
 * 为什么需要它（2026-10-22 真机教训）：主模型把连接挂着不返回（our-free-model 实测 62s
 * 一个 chunk 都没有）时，**适配器不报错、循环不派发 `agent/request-error`**，
 * 于是降级链永远等不到机会，只能等到桥接超时。这里把「静默」翻译成一个终态
 * `finish(error)` chunk —— 循环收到后就会走 request-error 瀑布，备用模型在同一轮内接管。
 *
 * @param {AsyncIterable<any>} source 下游（适配器）的流
 * @param {number} idleMs 允许的最长静默时间
 * @param {string} label 日志用的路由标签
 * @param {() => void} [onIdle] 触发看门狗时的回调（写系统事件用）
 * @returns {AsyncIterable<any>}
 */
function withIdleWatchdog(source, idleMs, label, onIdle) {
  return (async function* watch() {
    const iterator = source[Symbol.asyncIterator]()
    let timer
    let completed = false
    try {
      while (true) {
        const pending = iterator.next()
        // 超时后这个 promise 可能悬空/被 reject，先挂个空 catch，避免 unhandled rejection。
        pending.catch(() => {})
        const raced = await Promise.race([
          pending.then((result) => ({ kind: 'chunk', result })),
          new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: 'idle' }), idleMs) }),
        ])
        clearTimeout(timer)
        if (raced.kind === 'idle') {
          try { onIdle?.() } catch { /* 事件记录失败不能影响主流程 */ }
          // ⚠️ 不能 `await iterator.return()`：适配器卡在 await（不是 yield 点）时，
          // return() 永远不 resolve，看门狗会跟着挂死。发出去就不管了，只挂个 catch。
          try {
            const closing = iterator.return?.()
            if (closing && typeof closing.catch === 'function') closing.catch(() => {})
          } catch { /* 关不掉也要继续收尾 */ }
          completed = true
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                code: WATCHDOG_CODE,
                message: `模型 ${label} ${idleMs}ms 没有任何输出，判定超时`,
              },
            },
          }
          return
        }
        if (raced.result.done) { completed = true; return }
        yield raced.result.value
      }
    } finally {
      clearTimeout(timer)
      if (!completed) {
        // 同超时分支：不 await，避免卡在没反应的适配器上。
        try {
          const closing = iterator.return?.()
          if (closing && typeof closing.catch === 'function') closing.catch(() => {})
        } catch { /* 忽略 */ }
      }
    }
  })()
}

/**
 * provider 当前是否还有 adapter（同步、O(n) 但 n≤20，可忽略）。
 * 没有就**不覆写**：宁可让这一轮走默认模型，也不要让整个 turn 因为
 * `NO_ADAPTER` 直接炸掉。
 * @param {any} llm ctx.llm
 * @param {string} provider
 * @returns {boolean}
 */
function providerRoutable(llm, provider) {
  try {
    return llm.listProviders().some((info) => info.id === provider)
  } catch {
    return false
  }
}

/**
 * 把偏好叠加到一次已解析的 request config 上。
 *
 * 只换 route 三件套，其余（temperature / maxTokens / stop）原样保留；
 * effort 必须显式清掉 —— 上一个模型的 effort id 对新模型未必合法，
 * 清掉等于用新模型自己的默认档，和官方 selection 钩子的做法一致
 * （dsh-agent/lib/index.js:181-191 的 `withoutInheritedEffort`）。
 *
 * @param {any} config 内层（selection 钩子 + 循环种子）解析出的 config
 * @param {{provider:string, model:string, reasoningEffort?:string}} entry 偏好
 * @returns {any} 新的 config
 */
function applyOverride(config, entry) {
  const { reasoningEffort: _inherited, ...rest } = config
  return {
    ...rest,
    provider: entry.provider,
    model: entry.model,
    ...(entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort }),
  }
}

/**
 * 解析「跟随全局默认」的当前值。
 *
 * 为什么需要这个模式（2026-10-22 真机实测发现）：`selection.current` 的回落顺序是
 * 「待消费的 model/selection → **最近一次 request/header** → 全局默认」
 * （dsh-api-session-controller/lib/index.js:281-302）。一旦我们覆写过，header 里就
 * 记着覆写后的模型，此后**即使把偏好删掉，会话也会粘在旧模型上**，不会自动回默认。
 * 所以「跟随默认」必须显式表态：`mode: 'default'` 时每次请求都强制用默认值。
 *
 * @param {any} ctx
 * @returns {{provider:string, model:string, reasoningEffort?:string}|undefined}
 */
function defaultSelection(ctx) {
  const model = ctx.get?.('agentDefaultModel')
  const current = model?.currentSelection?.()
  if (current === undefined || typeof current.provider !== 'string' || typeof current.model !== 'string') return undefined
  return {
    provider: current.provider,
    model: current.model,
    ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }),
  }
}

/**
 * 安装「按会话覆写模型」的全部钩子与路由。
 *
 * 必须在 **role: 'settings'（profile 顶层实例）** 里调用：只有它拿得到根 ctx
 * 与 webServer。`role: 'guard'` 实例活在 preset 作用域里、每条会话一份，
 * 既没有稳定 id 也拿不到 webServer。
 *
 * @param {any} ctx 顶层插件 ctx
 * @param {{logger?: {warn?: Function, info?: Function}}} [options]
 * @returns {() => void} 卸载函数（正常生命周期由 ctx.effect 管理，这里只是方便测试）
 */
export function installModelOverride(ctx, { logger = console, config } = {}) {
  // 取服务用与 index.js 一致的防御写法：先在本地找，避免未 inject 时属性访问抛错。
  const llm = ctx.get?.('llm')
  if (llm === undefined) {
    logger.warn?.('[qq-guard] installModelOverride: 没有 llm 服务，跳过模型覆写')
    return () => {}
  }

  // ── 1. 最后一站：改这次请求真正用的 provider / model ──────────────
  const disposeRequest = ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const entry = readOverride(payload?.agent)
    if (entry === undefined) return resolved
    // 「跟随全局默认」：显式把当前默认值钉上去，抵消 header 回落造成的粘性。
    if (entry.mode === 'default') {
      const dflt = defaultSelection(ctx)
      return dflt === undefined ? resolved : applyOverride(resolved, dflt)
    }
    if (!providerRoutable(llm, entry.provider)) {
      logger.warn?.(`[qq-guard] 会话 ${sessionIdOf(payload.agent)} 指定的 provider "${entry.provider}" 已不在路由表，本次按默认模型走`)
      return resolved
    }
    return applyOverride(resolved, entry)
  }, { prepend: true })

  // ── 2. 摘掉 selection 钩子为「新会话首次改模型」塞的那条提示 ────────
  // 只在接管了的会话里摘；没接管的会话（用户自己在浏览器里切模型）完全不动。
  const disposeNotice = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject') return decision
    if (readOverride(payload?.agent) === undefined) return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    const kept = messages.filter((message) => !isModelSwitchNotice(message))
    if (kept.length === messages.length) return decision
    return { ...decision, messages: kept }
  }, { prepend: true })

  // ── 3. 清理：进程内的 agent 没了就丢偏好，别让它无限长 ──────────────
  const disposeDisposed = ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    overrides.delete(sessionId)
    fallbackCursor.delete(sessionId)
  })

  // ── 4. 失败换备用模型 ──────────────────────────────────────────────
  // 4a. 走瀑布的正路：叠在 dsh-llm-retry 后面 —— 内层先按同一模型重试，
  //     重试预算耗尽返回 undefined 后，我们再切 fallback 并请求循环重跑本步
  //     （dsh-agent-loop/lib/index.js:1136 `agent/request-error` → {kind:'retry'} → continue）。
  //     真机已验证：坏路由 404 → 同 step 内切到备用模型并拿到回复。
  const disposeFallback = ctx.on('agent/request-error', async (payload, next) => {
    const action = await next()
    if (action !== undefined) return action // 内层已经决定重试，让它重试
    const entry = readOverride(payload?.agent)
    if (entry === undefined || !Array.isArray(entry.fallbacks) || entry.fallbacks.length === 0) return action
    const sessionId = sessionIdOf(payload.agent)
    const used = fallbackCursor.get(sessionId) ?? 0
    if (used >= entry.fallbacks.length) return action
    fallbackCursor.set(sessionId, used + 1)
    const nextRoute = entry.fallbacks[used]
    logger.warn?.(`[qq-guard] 会话 ${sessionId} 主模型失败，切备用 #${used + 1}`)
    pushSystemEvent('warn', 'fallback', `主模型失败，切到备用 #${used + 1} ${nextRoute.provider}/${nextRoute.model}`, {
      sessionId,
      from: `${entry.provider}/${entry.model}`,
      to: `${nextRoute.provider}/${nextRoute.model}`,
      failure: payload?.failure === undefined ? undefined : { code: payload.failure.code, message: payload.failure.message },
    })
    return { kind: 'retry' }
  }, { prepend: true })

  // 4b. 兜底网：adapter 在**流开始之前**就抛错（缺 key、NO_ADAPTER、参数不合法）时，
  //     循环不会派发 `agent/request-error`（它只处理 finish error/aborted，
  //     dsh-agent-loop/lib/index.js:1120-1145），而是直接 throw。
  //     这类失败救不回本轮，但可以把游标推一格：桥接下一条消息重新 POST 同一路由时
  //     不再把游标重置（见 handleModelRoute 的 sameRoute 判断），于是下一轮直接走备用。
  const disposeAgentError = ctx.on('agent/error', (payload) => {
    const entry = readOverride(payload?.agent)
    if (entry === undefined || !Array.isArray(entry.fallbacks) || entry.fallbacks.length === 0) return
    const sessionId = sessionIdOf(payload.agent)
    const used = fallbackCursor.get(sessionId) ?? 0
    if (used >= entry.fallbacks.length) return
    fallbackCursor.set(sessionId, used + 1)
    logger.warn?.(`[qq-guard] 会话 ${sessionId} 本轮抛错（非 finish error），下一轮改用备用 #${used + 1}`)
    pushSystemEvent('warn', 'agent-error', `本轮请求抛错，下一轮改用备用 #${used + 1}`, {
      sessionId,
      error: String(payload?.error?.message ?? payload?.error ?? ''),
    })
  }, { prepend: true })

  // 4c. 静默看门狗：把「模型挂着不返回」翻成终态 finish(error)，好让上面的降级链接管。
  //     只包被接管的路由（主模型 + 备用），其它会话的流原样透传。
  const disposeWatchdog = ctx.on('llm/stream', (options, next) => {
    const idleMs = Number(readVolatile(config?.modelWatchdogMs) ?? 0)
    if (!Number.isFinite(idleMs) || idleMs <= 0) return next()
    const route = `${options?.provider ?? ''}/${options?.model ?? ''}`
    if (!managedRoutes().has(route)) return next()
    const inner = next()
    // 防御：waterfall 下游正常返回 AsyncIterable；不是流就不碰。
    if (inner === null || typeof inner?.[Symbol.asyncIterator] !== 'function') return inner
    return withIdleWatchdog(inner, idleMs, route, () => {
      logger.warn?.(`[qq-guard] 看门狗触发：${route} ${idleMs}ms 无响应`)
      pushSystemEvent('error', 'watchdog', `触发看门狗：${route} ${Math.round(idleMs / 1000)}s 无响应，强制中断`, {
        route,
        idleMs,
      })
    })
  }, { prepend: true })

  // ── 5. 桥接通道：一条写偏好、一条读、一条清；另一条给面板读模型目录 ──
  // 注意：webServer 只在顶层实例可用；没有就只保留钩子（桥接若拿不到路由，
  // 走降级：不写偏好 = 用全局默认）。
  let disposeRoute = () => {}
  if (ctx.webServer !== undefined) {
    disposeRoute = ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: MODEL_ROUTE_PATH,
        handler: (req, res) => handleModelRoute(ctx, llm, req, res, logger),
      }),
      'qq-guard: session model override route',
    )
    const disposeModels = ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: MODELS_ROUTE_PATH,
        handler: (req, res) => handleModelsRoute(ctx, llm, req, res, config),
      }),
      'qq-guard: model catalog route (for the settings card)',
    )
    const disposeEvents = ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: SYSTEM_EVENTS_ROUTE_PATH,
        handler: (req, res) => handleSystemEventsRoute(req, res),
      }),
      'qq-guard: system events route (watchdog / fallback visibility)',
    )
    const baseDispose = disposeRoute
    disposeRoute = () => { baseDispose(); disposeModels(); disposeEvents() }
  } else {
    logger.warn?.('[qq-guard] 没有 webServer，模型偏好只能由 Host 内代码写入')
  }

  // 统一随插件卸载释放（ctx.on / ctx.effect 本身已随 fiber 释放，这里再兜一层便于测试）
  return () => {
    disposeRequest()
    disposeNotice()
    disposeDisposed()
    disposeFallback()
    disposeAgentError()
    disposeWatchdog()
    disposeRoute()
  }
}

/**
 * 系统底层事件（只读）：看门狗触发、切备用、抛错等过程，最近 20 条。
 *
 * 为什么要暴露：这些都是 Host 进程内的动作，用户只能感觉到「慢」或「模型变了」。
 * 面板轮询这条路由展示成时间线，排查时不用让人去翻日志文件。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function handleSystemEventsRoute(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, reason: 'method not allowed' })
    return
  }
  const fetchSite = req.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
    return
  }
  sendJson(res, 200, { ok: true, events: [...systemEvents] })
}

/**
 * 模型目录（只读）。把「哪些 provider 能路由 + 每个模型的多模态/上下文/推理档」一次并好，
 * 面板只发一个请求就够。
 *
 * @param {any} ctx
 * @param {any} llm
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleModelsRoute(ctx, llm, req, res, config) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, reason: 'method not allowed' })
    return
  }
  const fetchSite = req.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
    return
  }
  const now = Date.now()
  if (catalogCache.value !== undefined && now - catalogCache.at < CATALOG_TTL_MS) {
    sendJson(res, 200, { ok: true, cached: true, ...catalogCache.value })
    return
  }

  const providers = []
  for (const provider of llm.listProviders()) {
    let models = []
    try {
      models = await llm.listModels(provider.id)
    } catch (error) {
      providers.push({ id: provider.id, name: provider.name, models: [], error: String(error?.message ?? error) })
      continue
    }
    const entries = []
    for (const model of models) {
      let info
      try {
        info = await llm.resolveModelInfo(provider.id, model.id)
      } catch {
        info = undefined
      }
      const input = info?.inputModalities ?? model.inputModalities
      entries.push({
        id: model.id,
        name: model.name ?? model.id,
        ...(model.description === undefined ? {} : { description: model.description }),
        ...(Array.isArray(input) ? { input: [...input] } : {}),
        ...(info?.context?.contextWindow === undefined ? {} : { contextWindow: info.context.contextWindow }),
        ...(info?.maxTokens === undefined && model.maxTokens === undefined ? {} : { maxTokens: info?.maxTokens ?? model.maxTokens }),
        ...(info?.reasoning === undefined ? {} : { reasoning: info.reasoning }),
      })
    }
    providers.push({ id: provider.id, name: provider.name, models: entries })
  }

  const value = {
    default: defaultSelection(ctx) ?? null,
    // 设置页当前保存的 QQ 模型（LaunchCard 上显示「当前模型」用）：
    // provider/model 都为空 = 跟随全局默认。
    configured: readConfiguredModel(config),
    providers,
  }
  catalogCache = { at: now, value }
  sendJson(res, 200, { ok: true, ...value })
}

/**
 * 读 schemastery volatile 字段的当前值：`.volatile()` 解析后是带 `get()` 的包装对象，
 * 直接比较会恒为 false（2026-10-20 实测，见 index.js 的 readRole 注释）。
 * @param {any} value
 * @returns {any}
 */
function readVolatile(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value.get === 'function') {
    try { return value.get() } catch { return undefined }
  }
  return value
}

/**
 * 从插件 Config 读出「当前下发的模型」。
 * @param {any} config 插件 Config（可能为 undefined：测试 / 老装配）
 * @returns {{provider:string, model:string, reasoningEffort:string, fallbacks:Array<{provider:string,model:string}>}}
 */
function readConfiguredModel(config) {
  const model = config?.model ?? {}
  const provider = String(readVolatile(model.provider) ?? '').trim()
  const modelId = String(readVolatile(model.model) ?? '').trim()
  const reasoningEffort = String(readVolatile(model.reasoningEffort) ?? '').trim()
  const rawFallbacks = readVolatile(config?.modelFallbacks)
  const fallbacks = Array.isArray(rawFallbacks)
    ? rawFallbacks
      .filter((item) => item && typeof item.provider === 'string' && typeof item.model === 'string')
      .slice(0, 4)
      .map((item) => ({ provider: item.provider, model: item.model }))
    : []
  return { provider, model: modelId, reasoningEffort, fallbacks }
}

/**
 * 路由处理。
 *
 *   POST   /dsh-qq-guard/model   {sessionId, provider, model, reasoningEffort?, fallbacks?}
 *   GET    /dsh-qq-guard/model?sessionId=…     读一条
 *   GET    /dsh-qq-guard/model                 读全部（调试用）
 *   DELETE /dsh-qq-guard/model?sessionId=…     清一条
 *
 * 鉴权沿用本插件现有约定：不设 token（本机回环），只拒跨站浏览器请求。
 *
 * @param {any} ctx
 * @param {any} llm
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{warn?: Function}} logger
 */
async function handleModelRoute(ctx, llm, req, res, logger) {
  const fetchSite = req.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')

  if (req.method === 'GET' || req.method === 'HEAD') {
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null) {
      sendJson(res, 200, {
        ok: true,
        entries: [...overrides].map(([id, value]) => ({ sessionId: id, ...value })),
      })
      return
    }
    const entry = overrides.get(sessionId)
    sendJson(res, 200, entry === undefined ? { ok: true, entry: null } : { ok: true, entry: { sessionId, ...entry } })
    return
  }

  if (req.method === 'DELETE') {
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null) {
      sendJson(res, 400, { ok: false, reason: 'sessionId required' })
      return
    }
    overrides.delete(sessionId)
    fallbackCursor.delete(sessionId)
    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, reason: 'method not allowed' })
    return
  }

  let body
  try {
    body = await readJsonBody(req, { maxBytes: 16 * 1024 })
  } catch (error) {
    sendJson(res, error?.statusCode ?? 400, { ok: false, reason: 'invalid body', detail: String(error?.message ?? error) })
    return
  }

  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
  const model = typeof body?.model === 'string' ? body.model.trim() : ''
  const followDefault = body?.mode === 'default'
  if (sessionId === '' || (!followDefault && (provider === '' || model === ''))) {
    sendJson(res, 400, { ok: false, reason: 'sessionId 必填；要么给 provider + model，要么给 mode: "default"' })
    return
  }

  if (followDefault) {
    overrides.delete(sessionId)
    overrides.set(sessionId, { mode: 'default', updatedAt: new Date().toISOString() })
    fallbackCursor.delete(sessionId)
    logger.info?.(`[qq-guard] 会话 ${sessionId} 的模型改为「跟随全局默认」`)
    sendJson(res, 200, { ok: true, entry: { sessionId, mode: 'default' } })
    return
  }

  // 写之前校验：provider 必须已挂 adapter，model 必须在该 provider 的目录里。
  // 这一步是为了让**面板**能立刻拿到明确错误，而不是等下一轮 turn 才炸。
  if (!providerRoutable(llm, provider)) {
    sendJson(res, 400, {
      ok: false,
      reason: 'provider-unroutable',
      detail: `provider "${provider}" 当前没有已注册的 adapter`,
      providers: llm.listProviders().map((info) => info.id),
    })
    return
  }
  try {
    await llm.resolveModelInfo(provider, model)
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      reason: 'model-unavailable',
      detail: String(error?.message ?? error),
    })
    return
  }

  const fallbacks = Array.isArray(body?.fallbacks)
    ? body.fallbacks
      .filter((item) => typeof item?.provider === 'string' && typeof item?.model === 'string')
      .slice(0, 4)
      .map((item) => ({ provider: item.provider.trim(), model: item.model.trim() }))
    : undefined

  const entry = {
    provider,
    model,
    ...(typeof body?.reasoningEffort === 'string' && body.reasoningEffort.length > 0
      ? { reasoningEffort: body.reasoningEffort }
      : {}),
    ...(fallbacks === undefined ? {} : { fallbacks }),
    updatedAt: new Date().toISOString(),
  }

  // 游标保留策略：只有**换了一条 route** 才重置降级游标。
  // 桥接每发一条消息都会重新 POST 同一个偏好；如果这里无条件重置，那么
  // 「主模型抛错 → agent/error 把游标推到备用」的成果会被下一条消息抹掉，
  // 表现为每条消息都先撞一次墙。同一 route 重复 POST = 沿用当前降级进度。
  const previous = overrides.get(sessionId)
  const sameRoute = previous !== undefined && previous.provider === provider && previous.model === model
  overrides.delete(sessionId)
  overrides.set(sessionId, entry)
  if (!sameRoute) fallbackCursor.delete(sessionId)
  while (overrides.size > MAX_ENTRIES) {
    const oldest = overrides.keys().next().value
    overrides.delete(oldest)
    fallbackCursor.delete(oldest)
  }
  logger.info?.(`[qq-guard] 会话 ${sessionId} 的模型改为 ${provider}/${model}`)
  sendJson(res, 200, { ok: true, entry: { sessionId, ...entry } })
}

/**
 * 摘一份 JSON 请求体（有上限）。与 index.js 里同名工具保持一致，
 * 接线时可直接复用 index.js 的实现、删掉这里的副本。
 * @param {import('node:http').IncomingMessage} req
 * @param {{maxBytes?: number}} [options]
 * @returns {Promise<any>}
 */
function readJsonBody(req, { maxBytes = 16 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        const error = new Error(`body exceeds ${maxBytes} bytes`)
        error.statusCode = 413
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** 与 index.js 的 sendJson 同形。接线时复用 index.js 的，删掉这里的副本。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/* ────────────────────────────────────────────────────────────────
 * 接线（3 处改动，确认后再做）
 *
 * 1) index.js 顶部：
 *      import { installModelOverride } from './model-override.js'
 *
 * 2) apply() 里 role === 'settings' 分支：
 *      if (role === 'settings') {
 *        installModelOverride(ctx)          // ← 新增：与 webServer 无关，先装
 *        applySettings(ctx, config ?? {})
 *        return
 *      }
 *    ⚠️ 不要放进 applySettings()：它开头有 `if (ctx.webServer === undefined) return`，
 *       会让钩子跟着一起被跳过。
 *
 * 3) package.json 的 dsh.files 里加 "model-override.js"（本机 link 安装不影响，发版要用）。
 *
 * 桥接侧（每条消息、prompt 之前）：
 *      await fetch(`http://127.0.0.1:${dshPort}${MODEL_ROUTE_PATH}`, {
 *        method: 'POST',
 *        headers: { 'content-type': 'application/json' },
 *        body: JSON.stringify({ sessionId, provider, model, reasoningEffort }),
 *      })
 *   —— 幂等；返回 400 就当「这条偏好在当前路由下不可用」，降级到全局默认并在 QQ 面板提示。
 * ──────────────────────────────────────────────────────────────── */
