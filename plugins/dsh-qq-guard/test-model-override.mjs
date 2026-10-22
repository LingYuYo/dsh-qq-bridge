/**
 * model-override.js 的离线回归用例（不需要 DSH 进程）。
 *
 * 锁死 4 件容易回退的事：
 *   1. 顺序：agent/request / agent/pre-step 必须带 `{ prepend: true }`
 *      —— 少了它，HMR 重载后会掉到 selection 钩子内层，覆写静默失效。
 *   2. 透传：没接管的会话，返回值必须和输入是同一个对象（不能顺手改别人的请求）。
 *   3. 降级：provider 从路由表消失时，必须放行默认模型，而不是抛错打断 turn。
 *   4. 路由：非法 provider / model 必须 400，桥接才好在面板上提示。
 *
 * 运行：node plugins/dsh-qq-guard/test-model-override.mjs
 */
import assert from 'node:assert/strict'
import { installModelOverride, MODEL_ROUTE_PATH, MODELS_ROUTE_PATH, SYSTEM_EVENTS_ROUTE_PATH } from './model-override.js'

let pass = 0
let fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (error) { console.log(`  ✗ ${name}\n      ${error.message}`); fail++ }
}

/** 造一个能装钩子、能挂路由的假 ctx。 */
function makeCtx({ providers = ['raccoon', 'workbuddy'], models = { 'raccoon': ['raccoon-model'], 'workbuddy': ['deepseek-v4.1-flash'] }, withWebServer = true } = {}) {
  const listeners = new Map()
  const routes = []
  const warnings = []
  const infos = []
  // 可变的 provider 列表：用来模拟「偏好写进去之后，路由被摘掉」。
  const activeProviders = [...providers]
  const setProviders = (next) => {
    activeProviders.length = 0
    activeProviders.push(...next)
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'raccoon', model: 'raccoon-model', reasoningEffort: 'on' }) }
      return undefined
    },
    on(name, fn, options) {
      const hook = { fn, options: options ?? {} }
      listeners.set(name, [...(listeners.get(name) ?? []), hook])
      return () => {
        const list = listeners.get(name) ?? []
        const index = list.indexOf(hook)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(factory) {
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  const llm = {
    listProviders: () => activeProviders.map((id) => ({ id, name: id })),
    listModels: async (provider) => {
      if (!activeProviders.includes(provider)) throw new Error(`no adapter for "${provider}"`)
      return (models[provider] ?? []).map((id) => ({ id, name: id.toUpperCase() }))
    },
    resolveModelInfo: async (provider, model) => {
      if (!activeProviders.includes(provider)) throw new Error(`no adapter for "${provider}"`)
      const list = models[provider] ?? []
      if (!list.includes(model)) throw new Error(`model "${model}" is not advertised by "${provider}"`)
      return {
        id: model,
        // 名字里带 vision 的当多模态，其余纯文本 —— 测试用。
        inputModalities: model.includes('vision') ? ['text', 'image'] : ['text'],
        context: { contextWindow: 128000 },
        reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
      }
    },
  }
  if (withWebServer) {
    ctx.webServer = {
      register(config) {
        routes.push(config)
        return () => {}
      },
    }
  }
  const logger = {
    warn: (message) => warnings.push(String(message)),
    info: (message) => infos.push(String(message)),
  }
  return { ctx, listeners, routes, warnings, infos, llm, setProviders }
}

/** 取某事件的第一个钩子。 */
function hookOf(listeners, name) {
  const list = listeners.get(name) ?? []
  assert.equal(list.length, 1, `${name} 应恰好注册 1 个钩子，实际 ${list.length}`)
  return list[0]
}

/** 造一个 NPC 请求 payload。 */
const agentOf = (id) => ({ id, session: { id } })

/** 造一条假的 POST 请求。 */
function fakeReq({ method = 'GET', url = MODEL_ROUTE_PATH, body, headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    headers,
    on(event, handler) {
      if (event === 'data') for (const chunk of chunks) handler(chunk)
      if (event === 'end') setImmediate(handler)
      return this
    },
    destroy() {},
  }
}

/** 造一条假的响应，记下 status 与 JSON。 */
function fakeRes() {
  const state = { status: 0, payload: undefined }
  return {
    state,
    writeHead(status) { state.status = status },
    end(text) { state.payload = text === undefined ? undefined : JSON.parse(text) },
  }
}

/** 走一次路由。 */
async function callRoute(route, options) {
  const res = fakeRes()
  await route.handler(fakeReq(options), res)
  return res.state
}

console.log('model-override:')

await check('注册顺序：agent/request 与 agent/pre-step 都带 prepend', () => {
  const { ctx, listeners } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  assert.equal(hookOf(listeners, 'agent/request').options.prepend, true, 'agent/request 必须 prepend')
  assert.equal(hookOf(listeners, 'agent/pre-step').options.prepend, true, 'agent/pre-step 必须 prepend')
  assert.equal(hookOf(listeners, 'agent/request-error').options.prepend, true, 'agent/request-error 必须 prepend')
})

await check('无偏好：agent/request 原样透传（同一个对象）', async () => {
  const { ctx, listeners, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  const resolved = { provider: 'raccoon', model: 'raccoon-model', maxTokens: 4096 }
  const out = await hookOf(listeners, 'agent/request').fn({ turn: 1, step: 1, agent: agentOf('s-1') }, async () => resolved)
  assert.equal(out, resolved, '透传必须是同一引用')
  assert.equal(routes.length, 3, '应注册三条路由：偏好写入 + 模型目录 + 系统事件')
  assert.deepEqual(routes.map((item) => item.path).sort(), [MODEL_ROUTE_PATH, MODELS_ROUTE_PATH, SYSTEM_EVENTS_ROUTE_PATH].sort())
})

await check('有偏好：只换 route 三件套，其它字段保留、旧 effort 被清掉', async () => {
  const { ctx, listeners, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  const post = await callRoute(routes[0], {
    method: 'POST',
    body: { sessionId: 's-1', provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
  })
  assert.equal(post.status, 200)
  assert.equal(post.payload.ok, true)
  const resolved = { provider: 'raccoon', model: 'raccoon-model', reasoningEffort: 'high', maxTokens: 4096, temperature: 0.3 }
  const out = await hookOf(listeners, 'agent/request').fn({ turn: 1, step: 1, agent: agentOf('s-1') }, async () => resolved)
  assert.equal(out.provider, 'workbuddy')
  assert.equal(out.model, 'deepseek-v4.1-flash')
  assert.equal(out.reasoningEffort, undefined, '旧模型的 effort 必须清掉')
  assert.equal(out.maxTokens, 4096, '其它字段必须保留')
  assert.equal(out.temperature, 0.3)
})

await check('有偏好且指定 effort：effort 被写入', async () => {
  const { ctx, listeners, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  await callRoute(routes[0], { method: 'POST', body: { sessionId: 's-1', provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } })
  const out = await hookOf(listeners, 'agent/request').fn({ turn: 1, step: 1, agent: agentOf('s-1') }, async () => ({ provider: 'raccoon', model: 'raccoon-model' }))
  assert.equal(out.reasoningEffort, 'high')
})

await check('provider 消失：放行默认模型并告警，不抛错', async () => {
  // 关键：偏好写入时 workbuddy 还在，写完之后 provider 被摘掉（换 provider / 插件卸载）。
  const { ctx, listeners, routes, warnings, setProviders } = makeCtx()
  installModelOverride(ctx, { logger: { warn: (m) => warnings.push(String(m)), info() {} } })
  await callRoute(routes[0], { method: 'POST', body: { sessionId: 's-1', provider: 'workbuddy', model: 'deepseek-v4.1-flash' } })
  setProviders(['raccoon'])
  const resolved = { provider: 'raccoon', model: 'raccoon-model' }
  const out = await hookOf(listeners, 'agent/request').fn({ turn: 1, step: 1, agent: agentOf('s-1') }, async () => resolved)
  assert.equal(out, resolved, 'provider 不可路由时必须原样透传')
  assert.ok(warnings.some((m) => m.includes('已不在路由表')), '必须留一条警告')
})

await check('pre-step：接管会话里的模型切换提示被摘掉，未接管会话不动', async () => {
  const { ctx, listeners, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  await callRoute(routes[0], { method: 'POST', body: { sessionId: 's-1', provider: 'workbuddy', model: 'deepseek-v4.1-flash' } })
  const notice = { content: [{ type: 'text', text: '[model changed: …]' }], source: { kind: 'model-selection', form: 'notice' } }
  const real = { content: [{ type: 'text', text: 'tool result' }], source: { kind: 'tool' } }
  const decide = async () => ({ kind: 'continue', messages: [real, notice] })
  const managed = await hookOf(listeners, 'agent/pre-step').fn({ turn: 1, step: 2, agent: agentOf('s-1') }, decide)
  assert.equal(managed.messages.length, 1, '接管会话应摘掉 notice')
  assert.equal(managed.messages[0], real)
  const foreign = await hookOf(listeners, 'agent/pre-step').fn({ turn: 1, step: 2, agent: agentOf('s-2') }, decide)
  assert.equal(foreign.messages.length, 2, '未接管会话不得改动')
})

await check('mode:"default"：强制回全局默认（抵消 header 粘性）', async () => {
  const { ctx, listeners, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  const post = await callRoute(routes[0], { method: 'POST', body: { sessionId: 's-1', mode: 'default' } })
  assert.equal(post.status, 200)
  assert.equal(post.payload.entry.mode, 'default')
  // 内层（selection 钩子）已经把 config 钉在 header 记录的旧模型上，我们必须改回默认。
  const stale = { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high', maxTokens: 4096 }
  const out = await hookOf(listeners, 'agent/request').fn({ turn: 2, step: 1, agent: agentOf('s-1') }, async () => stale)
  assert.equal(out.provider, 'raccoon')
  assert.equal(out.model, 'raccoon-model')
  assert.equal(out.reasoningEffort, 'on')
  assert.equal(out.maxTokens, 4096, '其它字段保留')
})

await check('路由校验：未知 provider → 400 provider-unroutable', async () => {
  const { ctx, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  const out = await callRoute(routes[0], { method: 'POST', body: { sessionId: 's-1', provider: 'nope', model: 'x' } })
  assert.equal(out.status, 400)
  assert.equal(out.payload.reason, 'provider-unroutable')
})

await check('路由校验：provider 对但 model 不在目录 → 400 model-unavailable', async () => {
  const { ctx, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  const out = await callRoute(routes[0], { method: 'POST', body: { sessionId: 's-1', provider: 'workbuddy', model: 'nope' } })
  assert.equal(out.status, 400)
  assert.equal(out.payload.reason, 'model-unavailable')
})

await check('路由校验：缺字段 → 400', async () => {
  const { ctx, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  const out = await callRoute(routes[0], { method: 'POST', body: { sessionId: 's-1' } })
  assert.equal(out.status, 400)
})

await check('跨站请求被拒', async () => {
  const { ctx, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  const out = await callRoute(routes[0], { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(out.status, 403)
})

await check('GET / DELETE', async () => {
  const { ctx, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  await callRoute(routes[0], { method: 'POST', body: { sessionId: 's-1', provider: 'workbuddy', model: 'deepseek-v4.1-flash' } })
  const one = await callRoute(routes[0], { method: 'GET', url: `${MODEL_ROUTE_PATH}?sessionId=s-1` })
  assert.equal(one.status, 200)
  assert.equal(one.payload.entry.model, 'deepseek-v4.1-flash')
  const all = await callRoute(routes[0], { method: 'GET' })
  assert.equal(all.payload.entries.length, 1)
  const removed = await callRoute(routes[0], { method: 'DELETE', url: `${MODEL_ROUTE_PATH}?sessionId=s-1` })
  assert.equal(removed.status, 200)
  const after = await callRoute(routes[0], { method: 'GET', url: `${MODEL_ROUTE_PATH}?sessionId=s-1` })
  assert.equal(after.payload.entry, null)
})

await check('模型目录路由：provider / 多模态 / 上下文 一次并好', async () => {
  const { ctx, routes } = makeCtx({
    providers: ['raccoon', 'workbuddy'],
    models: { raccoon: ['raccoon-model'], workbuddy: ['deepseek-v4.1-flash', 'vision-model'] },
  })
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  const route = routes.find((item) => item.path === MODELS_ROUTE_PATH)
  assert.ok(route, '必须注册模型目录路由')
  const out = await callRoute(route, { method: 'GET' })
  assert.equal(out.status, 200)
  assert.equal(out.payload.ok, true)
  assert.equal(out.payload.default.provider, 'raccoon', '应带上全局默认，方便 UI 显示「跟随默认」')
  const workbuddy = out.payload.providers.find((p) => p.id === 'workbuddy')
  const vision = workbuddy.models.find((m) => m.id === 'vision-model')
  assert.deepEqual(vision.input, ['text', 'image'], '多模态能力必须原样带出')
  assert.equal(vision.contextWindow, 128000)
  assert.equal(vision.reasoning.efforts.length, 2)
  const textOnly = workbuddy.models.find((m) => m.id === 'deepseek-v4.1-flash')
  assert.deepEqual(textOnly.input, ['text'], '纯文本模型要能被 UI 识别并警告')
  const rejected = await callRoute(route, { method: 'POST' })
  assert.equal(rejected.status, 405)
})

await check('看门狗：被接管的模型静默超时 → 产出 WATCHDOG_TIMEOUT finish error', async () => {
  const { ctx, listeners, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} }, config: { modelWatchdogMs: 40 } })
  await callRoute(routes[0], { method: 'POST', body: { sessionId: 's-wd-1', provider: 'workbuddy', model: 'deepseek-v4.1-flash' } })

  // 模拟「连接挂着、一个 chunk 都不吐」的适配器流
  async function* hanging() { await new Promise(() => {}) }
  const stream = hookOf(listeners, 'llm/stream').fn(
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    () => hanging(),
  )
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.equal(chunks.length, 1, `超时应只产出一个终态 chunk，实际 ${chunks.length}`)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'WATCHDOG_TIMEOUT', '错误码必须是不可重试的 WATCHDOG_TIMEOUT')
})

await check('看门狗：正常吐字的流原样透传，不误杀', async () => {
  const { ctx, listeners, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} }, config: { modelWatchdogMs: 40 } })
  await callRoute(routes[0], { method: 'POST', body: { sessionId: 's-wd-2', provider: 'workbuddy', model: 'deepseek-v4.1-flash' } })

  async function* steady() {
    yield { type: 'text-delta', text: 'a' }
    await new Promise((r) => setTimeout(r, 10))
    yield { type: 'text-delta', text: 'b' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const stream = hookOf(listeners, 'llm/stream').fn(
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    () => steady(),
  )
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.equal(chunks.length, 3, `不该多也不该少：${chunks.length}`)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

await check('看门狗：没被接管的会话（不同路由）不加表，原样返回', () => {
  const { ctx, listeners, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} }, config: { modelWatchdogMs: 40 } })
  // 没有任何偏好 → managedRoutes 为空
  const marker = { marker: true }
  const out = hookOf(listeners, 'llm/stream').fn(
    { provider: 'raccoon', model: 'raccoon-model' },
    () => marker,
  )
  assert.equal(out, marker, '不该包没接管的流')
  assert.equal(routes.length, 3)
})

await check('系统事件：看门狗触发后 /system-events 能读到（error 级）', async () => {
  const { ctx, listeners, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} }, config: { modelWatchdogMs: 30 } })
  await callRoute(routes[0], { method: 'POST', body: { sessionId: 's-ev-1', provider: 'workbuddy', model: 'deepseek-v4.1-flash' } })

  async function* hanging() { await new Promise(() => {}) }
  const stream = hookOf(listeners, 'llm/stream').fn(
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    () => hanging(),
  )
  // 把流消费到终态（看门狗会在 30ms 后产出 finish 并结束）
  for await (const _chunk of stream) { /* 消费即可 */ }

  const route = routes.find((item) => item.path === SYSTEM_EVENTS_ROUTE_PATH)
  assert.ok(route, '必须注册系统事件路由')
  const out = await callRoute(route, { method: 'GET' })
  assert.equal(out.status, 200)
  assert.equal(out.payload.ok, true)
  const watchdog = out.payload.events.find((event) => event.kind === 'watchdog')
  assert.ok(watchdog, `应记录看门狗事件：${JSON.stringify(out.payload.events)}`)
  assert.equal(watchdog.level, 'error', '看门狗是 error 级（红色）')
  assert.match(watchdog.message, /看门狗/)
  assert.equal(watchdog.detail.route, 'workbuddy/deepseek-v4.1-flash')
  const rejected = await callRoute(route, { method: 'POST' })
  assert.equal(rejected.status, 405)
})

await check('降级链：request-error 返回 retry，下一步用备用模型', async () => {
  const { ctx, listeners, routes } = makeCtx({ models: { raccoon: ['raccoon-model'], workbuddy: ['deepseek-v4.1-flash', 'alt-model'] } })
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  await callRoute(routes[0], {
    method: 'POST',
    body: { sessionId: 's-fb-1', provider: 'workbuddy', model: 'deepseek-v4.1-flash', fallbacks: [{ provider: 'raccoon', model: 'raccoon-model' }] },
  })
  const action = await hookOf(listeners, 'agent/request-error').fn({ turn: 1, step: 1, agent: agentOf('s-fb-1') }, async () => undefined)
  assert.deepEqual(action, { kind: 'retry' }, '没有内层决定时必须返回 retry')
  const out = await hookOf(listeners, 'agent/request').fn({ turn: 1, step: 1, agent: agentOf('s-fb-1') }, async () => ({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }))
  assert.equal(out.provider, 'raccoon')
  assert.equal(out.model, 'raccoon-model', '重跑本步时应切到备用')

  // 切备用必须能在系统事件里看见（面板靠它解释「为什么模型变了」）
  const eventsRoute = routes.find((item) => item.path === SYSTEM_EVENTS_ROUTE_PATH)
  const events = (await callRoute(eventsRoute, { method: 'GET' })).payload.events
  const fallback = events.find((event) => event.kind === 'fallback')
  assert.ok(fallback, `应记录切备用事件：${JSON.stringify(events)}`)
  assert.equal(fallback.level, 'warn', '切备用是 warn 级（黄色）')
  assert.equal(fallback.detail.to, 'raccoon/raccoon-model')
})

await check('降级链：内层已决定重试时不抢', async () => {
  const { ctx, listeners, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  await callRoute(routes[0], { method: 'POST', body: { sessionId: 's-fb-2', provider: 'workbuddy', model: 'deepseek-v4.1-flash', fallbacks: [{ provider: 'raccoon', model: 'raccoon-model' }] } })
  const action = await hookOf(listeners, 'agent/request-error').fn({ turn: 1, step: 1, agent: agentOf('s-fb-2') }, async () => ({ kind: 'retry' }))
  assert.deepEqual(action, { kind: 'retry' })
  const out = await hookOf(listeners, 'agent/request').fn({ turn: 1, step: 1, agent: agentOf('s-fb-2') }, async () => ({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }))
  assert.equal(out.provider, 'workbuddy', '内层重试期间不应提前切备用')
})

await check('降级链：agent/error（抛错路径）推游标，同一 route 重复 POST 不重置', async () => {
  const { ctx, listeners, routes } = makeCtx({ models: { raccoon: ['raccoon-model'], workbuddy: ['deepseek-v4.1-flash', 'alt-model'] } })
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  const body = { sessionId: 's-fb-3', provider: 'workbuddy', model: 'deepseek-v4.1-flash', fallbacks: [{ provider: 'raccoon', model: 'raccoon-model' }] }
  await callRoute(routes[0], { method: 'POST', body })
  // 模拟 adapter 在流开始前抛错：循环只发 agent/error，不走 request-error
  hookOf(listeners, 'agent/error').fn({ turn: 1, step: 1, agent: agentOf('s-fb-3'), error: new Error('boom') })
  // 桥接下一条消息重复 POST 同一偏好：游标必须保留
  await callRoute(routes[0], { method: 'POST', body })
  const out = await hookOf(listeners, 'agent/request').fn({ turn: 2, step: 1, agent: agentOf('s-fb-3') }, async () => ({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }))
  assert.equal(out.provider, 'raccoon', '抛错后下一轮应直接用备用')
  // 换成另一条 route → 游标重置，重新给主模型机会
  await callRoute(routes[0], { method: 'POST', body: { ...body, model: 'alt-model' } })
  const out2 = await hookOf(listeners, 'agent/request').fn({ turn: 3, step: 1, agent: agentOf('s-fb-3') }, async () => ({ provider: 'raccoon', model: 'raccoon-model' }))
  assert.equal(out2.provider, 'workbuddy', '换 route 后应重新尝试新的主模型')
  assert.equal(out2.model, 'alt-model')
})

await check('agent/disposed 清掉偏好', async () => {
  const { ctx, listeners, routes } = makeCtx()
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  await callRoute(routes[0], { method: 'POST', body: { sessionId: 's-1', provider: 'workbuddy', model: 'deepseek-v4.1-flash' } })
  hookOf(listeners, 'agent/disposed').fn({ agent: agentOf('s-1') })
  const after = await callRoute(routes[0], { method: 'GET', url: `${MODEL_ROUTE_PATH}?sessionId=s-1` })
  assert.equal(after.payload.entry, null)
})

await check('没有 llm 服务：装不上但不抛错', () => {
  const { ctx } = makeCtx()
  ctx.get = () => undefined
  const dispose = installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  assert.equal(typeof dispose, 'function')
})

await check('没有 webServer：钩子仍然装上（桥接拿不到路由，走默认模型）', () => {
  const { ctx, listeners } = makeCtx({ withWebServer: false })
  installModelOverride(ctx, { logger: { warn() {}, info() {} } })
  assert.ok(listeners.has('agent/request'), '钩子必须不依赖 webServer')
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
