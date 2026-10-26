/**
 * 人设归纳路由 —— 桥接进程请 Host 侧帮忙调一次模型，把群聊记录归纳成「人设补充」。
 *
 * ## 为什么需要这条路由
 *
 * 「每小时动态人设」的归纳逻辑跑在桥接进程（qq-bridge）里，但桥接是**独立进程**，
 * 拿不到 `ctx.llm`，也不能只为了归纳去建一个 DSH 会话（会污染会话列表、白占 token
 * 预算、还得管生命周期）。所以桥接把「群名 + 现有人设 + 最近聊天记录」POST 给 Host，
 * Host 直接用 `ctx.llm` 打一次一次性请求，把文字结果还回去。
 *
 * ## 数据流向
 *
 *   qq-bridge  ──POST /dsh-qq-guard/persona-summarize──▶  本文件
 *                  { groupName, currentPersona, messages }      │
 *   qq-bridge  ◀── { ok: true, persona } ──────────────────────┘
 *
 * ## 几个刻意的设计
 *
 * 1. **一次性流，不挂 sessionId**：`llm.stream` 的 options 就是 GenerateOptions。
 *    这里故意不带 `sessionId` —— 归纳请求不属于任何 QQ 会话，也绝不能被
 *    model-override.js 的静默看门狗当成「被接管会话的请求」切断
 *    （2026-10-26 加看门狗 sessionId 隔离就是为了这类旁路调用）。
 * 2. **路由来源**：优先用插件 Config 里设置页配的 `model.provider/model`
 *    （它没配 provider adapter 时退回全局默认），否则用 `agentDefaultModel.currentSelection()`。
 *    归纳用哪个模型不重要，但**必须能路由**，所以两边都做一次可用性判断。
 * 3. **失败不抛、只回 `{ok:false, reason}`**：桥接拿它当软失败（跳过本轮，下小时再来），
 *    `reason` 是英文/机器可读的，只进日志，永远不进发往 QQ 的正文。
 * 4. **输入收敛**：messages ≤ 80 条、正文 ≤ 24000 字符，超出丢最旧的 ——
 *    群聊刷屏时不能让归纳请求把上游模型的上下文打爆。
 */

/** 路由路径。与 MODEL_ROUTE_PATH / PERSONA_ROUTE_PATH 同一套风格，桥接按常量拼 URL。 */
export const SUMMARIZE_ROUTE_PATH = '/dsh-qq-guard/persona-summarize'

/** 最多看多少条消息（从最新往前取）。 */
const MAX_MESSAGES = 80

/** 消息正文总字符预算（超出丢最旧的）。 */
const MAX_MESSAGE_CHARS = 24_000

/** 请求体上限：32KB。按上面的预算，正常请求远小于这个数。 */
const MAX_BODY_BYTES = 32 * 1024

/** 一次归纳最多等多久（毫秒）。到点 abort，别把 Host 的 HTTP 连接一直挂着。 */
const SUMMARIZE_TIMEOUT_MS = 60_000

/** 返回给桥接的人设文本上限（桥接侧总预算 4000 字，这里先裁一道，防止上游话痨）。 */
const MAX_PERSONA_CHARS = 2_000

/**
 * 归纳用的 system 提示词。
 *
 * 为什么要写得这么「死板」：归纳结果会被**追加进系统提示词**，一旦模型开始自由发挥
 * （解释、编号、「以下是总结」），这段垃圾就会长期影响 QQ 会话的语气。
 * 所以把「只输出设定、1–5 条短句、没有就空串」写死，并且在 Host 侧再做一次截断。
 */
const SYSTEM_PROMPT = [
  '你是一个群聊人设归纳器。根据给出的群聊记录，提炼值得补充进机器人人设的设定。',
  '只输出要补充的设定：1 到 5 条短句，每行一条，用陈述句写。',
  '不要解释、不要编号、不要加引号、不要复述聊天内容、不要写「以下是」这类开场白。',
  '不要重复已有设定；不要写人身攻击、隐私、群友的真实身份信息；',
  '不要写天气、时间、某次具体事件这类闲聊事实——只沉淀长期有效的偏好、称呼与相处方式。',
  '没有值得沉淀的内容就输出空字符串（什么都不输出）。',
].join('\n')

/**
 * 读 schemastery volatile 字段的当前值。
 *
 * 与 model-override.js / index.js 里的写法一致：`.volatile()` 解析后是带 `get()` 的
 * 包装对象（见 index.js readRole 注释），直接读会拿到对象而不是值。
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
 * provider 当前是否还有 adapter。没有就**不要**选它：
 * 直接调会以 NO_ADAPTER 结束，还不如退回全局默认。
 * @param {any} llm
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
 * 定这次归纳用哪条 route。
 *
 * 优先级：设置页配的 `model.provider/model`（且 provider 可路由）→ 全局默认模型。
 * @param {any} ctx
 * @param {any} config 插件 Config
 * @param {any} llm
 * @returns {{provider:string, model:string}|undefined}
 */
function resolveRoute(ctx, config, llm) {
  const model = config?.model ?? {}
  const provider = String(readVolatile(model.provider) ?? '').trim()
  const modelId = String(readVolatile(model.model) ?? '').trim()
  if (provider !== '' && modelId !== '' && providerRoutable(llm, provider)) {
    return { provider, model: modelId }
  }
  const current = ctx.get?.('agentDefaultModel')?.currentSelection?.()
  if (typeof current?.provider === 'string' && current.provider !== ''
    && typeof current?.model === 'string' && current.model !== '') {
    return { provider: current.provider, model: current.model }
  }
  return undefined
}

/**
 * 收敛消息列表：类型校验 → 取最近 MAX_MESSAGES 条 → 按字符预算从新到旧保留。
 *
 * 为什么从**最新**往前保留：归纳要的是「这个群最近在聊什么/怎么聊」，
 * 一小时里最早那几句的参考价值最低，预算不够时先丢它。
 * @param {unknown} raw 请求体里的 messages
 * @returns {Array<{name:string, qq:string, text:string}>}
 */
function normalizeMessages(raw) {
  if (!Array.isArray(raw)) return []
  const items = []
  for (const row of raw) {
    if (row === null || typeof row !== 'object') continue
    const text = typeof row.text === 'string' ? row.text.trim() : ''
    if (text === '') continue
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    const qq = typeof row.qq === 'string'
      ? row.qq.trim()
      : (typeof row.qq === 'number' ? String(row.qq) : '')
    items.push({ name, qq, text })
  }
  const recent = items.slice(-MAX_MESSAGES)
  let budget = MAX_MESSAGE_CHARS
  const kept = []
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const item = recent[index]
    if (item.text.length > budget) {
      // 单条就吃满预算：截断它保留前段（这条已经是能留下的最新一条了）。
      if (kept.length === 0) kept.unshift({ ...item, text: item.text.slice(0, budget) })
      break
    }
    budget -= item.text.length
    kept.unshift(item)
    if (budget <= 0) break
  }
  return kept
}

/**
 * 拼给模型的 user 正文。返回 undefined = 没有可归纳的内容（调用方回 400）。
 * @param {any} body
 * @returns {string|undefined}
 */
function buildPrompt(body) {
  const groupName = typeof body?.groupName === 'string' && body.groupName.trim() !== ''
    ? body.groupName.trim().slice(0, 100)
    : '（未命名群聊）'
  const currentPersona = typeof body?.currentPersona === 'string'
    ? body.currentPersona.trim().slice(0, 4_000)
    : ''
  const messages = normalizeMessages(body?.messages)
  if (messages.length === 0) return undefined
  const lines = messages.map((item) => {
    // 有昵称 → `昵称(QQ): 内容`；只有 QQ 号 → `QQ: 内容`（不写成 `456(456)`）。
    if (item.name !== '' && item.qq !== '') return `${item.name}(${item.qq}): ${item.text}`
    if (item.name !== '') return `${item.name}: ${item.text}`
    if (item.qq !== '') return `${item.qq}: ${item.text}`
    return `群友: ${item.text}`
  })
  return [
    `群名：${groupName}`,
    '',
    '已有设定（不要重复）：',
    currentPersona === '' ? '（无）' : currentPersona,
    '',
    `最近 ${lines.length} 条群聊记录（从旧到新）：`,
    ...lines,
  ].join('\n')
}

/**
 * 人设归纳路由处理。
 *
 *   POST /dsh-qq-guard/persona-summarize
 *   body: { groupName, currentPersona, messages: [{ name, qq, text }] }
 *   → { ok: true, persona: "……" }  |  { ok: false, reason: "..." }
 *
 * 鉴权沿用本插件约定：本机回环、不设 token，只拒跨站浏览器请求。
 *
 * @param {any} ctx 插件 ctx（要能 get('llm') / get('agentDefaultModel')）
 * @param {any} config 插件 Config（读 model.provider/model）
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{warn?: Function, info?: Function}} [logger]
 * @returns {Promise<void>}
 */
export async function handlePersonaSummarizeRoute(ctx, config, req, res, logger = console) {
  const fetchSite = req.headers?.['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, reason: 'method not allowed' })
    return
  }

  let body
  try {
    body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES })
  } catch (error) {
    sendJson(res, error?.statusCode ?? 400, { ok: false, reason: String(error?.message ?? error) })
    return
  }

  const prompt = buildPrompt(body)
  if (prompt === undefined) {
    sendJson(res, 400, { ok: false, reason: 'messages required' })
    return
  }

  const llm = ctx.get?.('llm')
  if (llm === undefined) {
    logger.warn?.('[qq-guard] 人设归纳：没有 llm 服务，跳过本次归纳')
    sendJson(res, 503, { ok: false, reason: 'llm-unavailable' })
    return
  }
  const route = resolveRoute(ctx, config, llm)
  if (route === undefined) {
    logger.warn?.('[qq-guard] 人设归纳：没有可用的模型路由，跳过本次归纳')
    sendJson(res, 503, { ok: false, reason: 'no-route' })
    return
  }

  // 一次性超时：60s 还不出结果就当失败，别让桥接的 60s HTTP 超时先到（那样只看得到断连）。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SUMMARIZE_TIMEOUT_MS)
  timer.unref?.()

  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      // 刻意不带 sessionId：这是旁路归纳，不属于任何 QQ 会话（见文件头注释 1）。
      signal: controller.signal,
    })
    // 防御：契约是 AsyncIterable，但中间件/测试替身也可能给同步可迭代；两者 for-await 都吃。
    const isIterable = stream !== null && typeof stream === 'object'
      && (typeof stream[Symbol.asyncIterator] === 'function' || typeof stream[Symbol.iterator] === 'function')
    if (!isIterable) {
      logger.warn?.('[qq-guard] 人设归纳：llm.stream 没返回流')
      sendJson(res, 502, { ok: false, reason: 'no-stream' })
      return
    }

    let text = ''
    let failure
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        continue
      }
      if (chunk?.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') {
          const reason = kind === 'aborted' || controller.signal.aborted
            ? 'aborted'
            : String(chunk.reason?.failure?.code ?? 'error')
          failure = { reason, detail: String(chunk.reason?.failure?.message ?? '') }
        }
        // finish 是终态：继续消费也没内容了，但让循环自然结束更稳（下游可能还有收尾 chunk）。
      }
    }

    if (failure !== undefined) {
      logger.warn?.(`[qq-guard] 人设归纳失败：${failure.reason}${failure.detail === '' ? '' : `（${failure.detail}）`}`)
      sendJson(res, failure.reason === 'aborted' ? 504 : 502, { ok: false, reason: failure.reason })
      return
    }

    logger.info?.(`[qq-guard] 人设归纳完成：${route.provider}/${route.model}，输入 ${prompt.length} 字符，输出 ${text.length} 字符`)
    sendJson(res, 200, { ok: true, persona: text.trim().slice(0, MAX_PERSONA_CHARS) })
  } catch (error) {
    // 适配器在流开始前抛错、或消费者侧异常：都算软失败，桥接跳过本轮。
    const reason = controller.signal.aborted ? 'aborted' : 'stream-failed'
    logger.warn?.(`[qq-guard] 人设归纳失败：${reason}（${error?.message ?? error}）`)
    sendJson(res, controller.signal.aborted ? 504 : 502, { ok: false, reason })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 摘一份 JSON 请求体（有上限）。
 * 与 index.js 的实现保持一致；本文件独立导出，方便测试直接打路由。
 * @param {import('node:http').IncomingMessage} req
 * @param {{maxBytes?: number}} [options]
 * @returns {Promise<any>}
 */
function readJsonBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(Object.assign(new Error(`body exceeds ${maxBytes} bytes`), { statusCode: 413 }))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch {
        reject(Object.assign(new Error('invalid json'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/** 与 index.js 的 sendJson 同形。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}
