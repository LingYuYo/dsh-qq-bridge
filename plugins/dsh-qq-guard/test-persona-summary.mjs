/**
 * persona-summary.js 的离线回归用例（不需要 DSH 进程，假 ctx / 假 llm.stream）。
 *
 * 锁死这几件容易回退的事：
 *   1. 协议：POST + {groupName, currentPersona, messages} → {ok, persona}；
 *      非 POST 405、跨站 403、空消息 400。
 *   2. 拼装：text-delta 分片必须按顺序拼成完整 persona；finish(aborted) 不等于空输出。
 *   3. 路由来源：设置页配的 model 优先，provider 不可路由时退回全局默认；
 *      归纳请求**不带 sessionId**（否则会被 QQ 会话的看门狗误伤）。
 *   4. 收敛：messages ≤ 80 条、正文 ≤ 24000 字符，超出丢最旧的。
 *
 * 运行（环境变量见规格 §0.5）：
 *   node plugins/dsh-qq-guard/test-persona-summary.mjs
 */
import assert from 'node:assert/strict'
import { SUMMARIZE_ROUTE_PATH, handlePersonaSummarizeRoute } from './persona-summary.js'

let pass = 0
let fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (error) { console.log(`  ✗ ${name}\n      ${error.message}`); fail++ }
}

/** 造一条假的 POST 请求（chunks 在注册 data 回调时就吐，和 test-model-override 一致）。 */
function fakeReq({ method = 'POST', url = SUMMARIZE_ROUTE_PATH, body, headers = {} } = {}) {
  let raw
  if (typeof body === 'string') raw = body
  else if (body !== undefined) raw = JSON.stringify(body)
  const chunks = raw === undefined ? [] : [Buffer.from(raw, 'utf8')]
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

/**
 * 造一个假 ctx + 假 llm。
 * @param {object} [options]
 * @param {string[]} [options.providers] 当前可路由的 provider
 * @param {object} [options.defaultSelection] agentDefaultModel.currentSelection() 的返回
 * @param {() => AsyncIterable<any>} [options.makeStream] 每次 llm.stream 用的流工厂
 * @param {boolean} [options.noLlm] 模拟没有 llm 服务
 */
function makeCtx({ providers = ['raccoon', 'workbuddy'], defaultSelection = { provider: 'raccoon', model: 'raccoon-model' }, makeStream, noLlm = false } = {}) {
  const captured = { options: undefined, calls: 0 }
  const llm = {
    listProviders: () => providers.map((id) => ({ id, name: id })),
    stream(options) {
      captured.calls += 1
      captured.options = options
      return makeStream === undefined ? goldenStream() : makeStream()
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return noLlm ? undefined : llm
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => (typeof defaultSelection === 'function' ? defaultSelection() : defaultSelection) }
      }
      return undefined
    },
  }
  return { ctx, captured, llm }
}

/** 默认的成功流：两个 text-delta + 正常结束（v2.0 第十步起输出 JSON）。 */
function* goldenStream() {
  yield { type: 'text-delta', index: 0, text: '{"slang":["喜欢被叫小鱼"],' }
  yield { type: 'text-delta', index: 0, text: '"profiles":[{"qq":"123","tags":["爱开玩笑"]}]}' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

const logger = { warn() {}, info() {} }

/** 走一次路由处理。 */
async function callRoute(options = {}) {
  const {
    body,
    method = 'POST',
    headers = {},
    config = {},
    providers,
    defaultSelection,
    makeStream,
    noLlm,
  } = options
  const { ctx, captured } = makeCtx({ providers, defaultSelection, makeStream, noLlm })
  const res = fakeRes()
  await handlePersonaSummarizeRoute(ctx, config, fakeReq({ method, body, headers }), res, logger)
  return { status: res.state.status, payload: res.state.payload, options: captured.options, calls: captured.calls }
}

/** 一条正常请求体。 */
const bodyOf = (extra = {}) => ({
  groupName: '测试群',
  currentPersona: '已有设定A',
  messages: [{ name: '翎羽', qq: '123', text: '你好呀' }],
  ...extra,
})

/** 取这次请求的 user 正文。 */
const promptOf = (routeOptions) => routeOptions.messages?.[0]?.content?.[0]?.text ?? ''

console.log('persona-summary:')

await check('成功：text-delta 拼成 JSON，返回 {ok:true, slang, profiles}', async () => {
  const out = await callRoute({ body: bodyOf() })
  assert.equal(out.status, 200)
  assert.deepEqual(out.payload, {
    ok: true,
    slang: ['喜欢被叫小鱼'],
    profiles: [{ qq: '123', tags: ['爱开玩笑'] }],
  })
})

await check('协议：system 是动态记忆提取提示词，user 正文带群名/现有人设/发送人标签', async () => {
  const out = await callRoute({
    body: bodyOf({ messages: [{ name: '翎羽', qq: '123', text: '你好呀' }, { name: '', qq: '456', text: '只有 QQ 号' }] }),
  })
  assert.equal(out.options.system.includes('动态记忆提取器'), true, 'system 要讲清角色')
  assert.equal(out.options.system.includes('JSON'), true, 'system 要限制输出形态')
  const prompt = promptOf(out.options)
  assert.match(prompt, /群名：测试群/)
  assert.match(prompt, /已有设定A/)
  assert.match(prompt, /翎羽\(123\): 你好呀/, '带昵称时用 昵称(QQ): 内容')
  assert.match(prompt, /456: 只有 QQ 号/, '没昵称时用 QQ 号当名字')
  assert.equal(out.options.provider, 'raccoon', '没配 model 时用全局默认')
  assert.equal(out.options.model, 'raccoon-model')
})

await check('路由：设置页配的 model 优先', async () => {
  const out = await callRoute({
    body: bodyOf(),
    config: { model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } },
  })
  assert.equal(out.status, 200)
  assert.equal(out.options.provider, 'workbuddy')
  assert.equal(out.options.model, 'deepseek-v4.1-flash')
})

await check('路由：配置里的 provider 不可路由 → 退回全局默认', async () => {
  const out = await callRoute({
    body: bodyOf(),
    config: { model: { provider: 'gone-provider', model: 'x' } },
    providers: ['raccoon', 'workbuddy'],
  })
  assert.equal(out.status, 200)
  assert.equal(out.options.provider, 'raccoon', '不可路由的 provider 不能硬上（会 NO_ADAPTER）')
  assert.equal(out.options.model, 'raccoon-model')
})

await check('路由：归纳请求不带 sessionId（避免被 QQ 会话看门狗误伤）', async () => {
  const out = await callRoute({ body: bodyOf() })
  assert.equal(out.options.sessionId, undefined)
  assert.equal('sessionId' in out.options, false)
})

await check('超时：signal 是 AbortSignal 并传进 llm.stream', async () => {
  const out = await callRoute({ body: bodyOf() })
  assert.ok(out.options.signal instanceof AbortSignal, '必须传 AbortSignal（60s 上限靠它 abort）')
  assert.equal(out.options.signal.aborted, false)
})

await check('finish error → {ok:false, reason:失败码}', async () => {
  const out = await callRoute({
    body: bodyOf(),
    makeStream: () => (async function* () {
      yield { type: 'text-delta', index: 0, text: '半截' }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMITED', message: 'busy' } } }
    })(),
  })
  assert.equal(out.status, 502)
  assert.deepEqual(out.payload, { ok: false, reason: 'RATE_LIMITED' })
})

await check('finish aborted → {ok:false, reason:"aborted"}', async () => {
  const out = await callRoute({
    body: bodyOf(),
    makeStream: () => (async function* () {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'stopped' } } }
    })(),
  })
  assert.equal(out.status, 504)
  assert.equal(out.payload.ok, false)
  assert.equal(out.payload.reason, 'aborted')
})

await check('流直接抛错 → {ok:false, reason:"stream-failed"}，不抛给 Host', async () => {
  const out = await callRoute({
    body: bodyOf(),
    makeStream: () => (async function* () { throw new Error('boom') })(),
  })
  assert.equal(out.status, 502)
  assert.deepEqual(out.payload, { ok: false, reason: 'stream-failed' })
})

await check('正常结束但没吐字 → ok:true + 空列表', async () => {
  const out = await callRoute({
    body: bodyOf(),
    makeStream: () => (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })
  assert.equal(out.status, 200)
  assert.deepEqual(out.payload, { ok: true, slang: [], profiles: [] })
})

await check('缺 llm → 503，且不调 stream', async () => {
  const out = await callRoute({ body: bodyOf(), noLlm: true })
  assert.equal(out.status, 503)
  assert.equal(out.payload.ok, false)
  assert.equal(out.payload.reason, 'llm-unavailable')
  assert.equal(out.calls, 0)
})

await check('没有可用的模型路由 → 503 no-route', async () => {
  const out = await callRoute({ body: bodyOf(), defaultSelection: null })
  assert.equal(out.status, 503)
  assert.equal(out.payload.reason, 'no-route')
  assert.equal(out.calls, 0)
})

await check('跨站请求 403，且不调 stream', async () => {
  const out = await callRoute({ body: bodyOf(), headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(out.status, 403)
  assert.equal(out.payload.ok, false)
  assert.equal(out.calls, 0)
})

await check('method 非 POST → 405', async () => {
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
    const out = await callRoute({ method })
    assert.equal(out.status, 405, `${method} 应 405`)
    assert.equal(out.payload.ok, false)
    assert.equal(out.calls, 0)
  }
})

await check('没有消息 → 400 messages required', async () => {
  for (const body of [bodyOf({ messages: [] }), bodyOf({ messages: undefined }), bodyOf({ messages: [{ bad: true }] })]) {
    const out = await callRoute({ body })
    assert.equal(out.status, 400)
    assert.equal(out.payload.ok, false)
    assert.equal(out.payload.reason, 'messages required')
  }
})

await check('非法 JSON → 400，不炸路由', async () => {
  const out = await callRoute({ body: '{不是 json' })
  assert.equal(out.status, 400)
  assert.equal(out.payload.ok, false)
})

await check('请求体超 32KB → 413', async () => {
  const out = await callRoute({ body: bodyOf({ messages: [{ name: 'a', qq: '1', text: 'x'.repeat(40000) }] }) })
  assert.equal(out.status, 413)
  assert.equal(out.payload.ok, false)
})

await check('收敛：消息超过 80 条时只保留最近 80 条', async () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({ name: '群友', qq: String(index), text: `第${index}条` }))
  const out = await callRoute({ body: bodyOf({ messages }) })
  const prompt = promptOf(out.options)
  assert.match(prompt, /第99条/, '最新一条必须在')
  assert.match(prompt, /第20条/, '最近 80 条 = 20..99，第 20 条要在')
  assert.equal(prompt.includes('第19条'), false, '更旧的必须被丢弃')
  assert.equal(prompt.includes('第0条'), false)
  assert.match(prompt, /最近 80 条群聊记录/)
})

await check('收敛：正文超过 24000 字符时丢最旧的（70 条 × 400 字 → 保留后面 60 条）', async () => {
  const messages = Array.from({ length: 70 }, (_, index) => ({ name: '群友', qq: '1', text: `M${index}:${'x'.repeat(400)}` }))
  const out = await callRoute({ body: bodyOf({ messages }) })
  const prompt = promptOf(out.options)
  assert.match(prompt, /M69:/, '最新一条必须在')
  assert.equal(prompt.includes('M9:'), false, '超出字符预算的最旧消息必须丢掉')
  assert.ok(prompt.length < 24_000 + 1_000, `正文应被压到 24000 字符量级，实际 ${prompt.length}`)
})

await check('模型输出超量 → slang 截到 5 条、profiles 每人 tags 截到 3 条', async () => {
  const out = await callRoute({
    body: bodyOf(),
    makeStream: () => (async function* () {
      yield {
        type: 'text-delta',
        index: 0,
        text: JSON.stringify({
          slang: Array.from({ length: 20 }, (_, i) => `梗${i}`),
          profiles: [{ qq: '123', tags: Array.from({ length: 10 }, (_, i) => `特征${i}`) }],
        }),
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })
  assert.equal(out.status, 200)
  assert.equal(out.payload.slang.length, 5)
  assert.equal(out.payload.profiles[0].tags.length, 3)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
