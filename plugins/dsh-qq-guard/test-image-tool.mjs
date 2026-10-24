/**
 * P2「发图片」工具离线用例（qq_send_image）。
 *
 * 锁死 p2-contract.md §3 的行为：
 *   · `sk-image` 默认技能对象与契约逐字一致；老配置（skills 数组里没有它）按新默认开启；
 *   · 工具注册在 **preset 作用域**（guard 实例），parameters 是合法 JSON Schema、
 *     url / file 都不是必填（二选一由 execute 自己判）；
 *   · 执行期 guard：技能关闭 → 拒绝；开启 → 放行；
 *   · execute：url / file 都不给 → 抛错且不入队；两个都给 → 用 url；
 *     入队 `{op:'image', sessionId, url?|file?}` → 等桥接回执 → 成功返回 sent:true，失败 throw 可读原因。
 *
 * 全部离线（假 ctx / 假 HTTP req-res / 真 schemastery），不联网、不 spawn。
 * 运行：node plugins/dsh-qq-guard/test-image-tool.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function resolveSchemastery() {
  if (process.env.QQG_SCHEMASTERY) return process.env.QQG_SCHEMASTERY
  const candidates = [
    path.join(HERE, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
    path.resolve(HERE, '../../node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
  ]
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  console.error('找不到 @deepseek-ai/schemastery；请设 QQG_SCHEMASTERY 指向它的 lib/index.mjs')
  process.exit(2)
}

const SRC = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')
const patched = SRC.replace(
  /^import Schema from '@deepseek-ai\/schemastery'$/m,
  `import Schema from ${JSON.stringify('file:///' + resolveSchemastery().replace(/\\/g, '/'))}`,
)
const tmpFile = path.join(HERE, `.tmp-image-tool-${process.pid}.mjs`)
fs.writeFileSync(tmpFile, patched)
let mod
try {
  mod = await import('file:///' + tmpFile.replace(/\\/g, '/'))
} finally {
  try { fs.unlinkSync(tmpFile) } catch { /* 忽略 */ }
}

const SESSION_OPS_ROUTE = '/dsh-qq-guard/session-ops'

/** 契约 §3.1 的默认技能对象（逐字对照）。 */
const CONTRACT_SK_IMAGE = {
  id: 'sk-image',
  name: '发图片',
  icon: 'image',
  tag: '内置',
  ver: '1.0.0',
  enabled: true,
  desc: '把图片或表情包发到 QQ（网页地址或本地文件），模型可通过 qq_send_image 调用。',
}

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    pass++
  } catch (error) {
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
    fail++
  }
}

/* ── 假 ctx ─────────────────────────────────────────────────────── */

/**
 * guard 实例的假 ctx（preset 内）。与 test-guard-scope 的假 ctx 同形：
 * 有 scope 才允许 restrict / guard；记录注册的工具与 guardFn。
 */
function makeGuardCtx({ presetId = 'qq-chat' } = {}) {
  const calls = { registeredTools: [], guardFn: null, guard: 0, restrict: 0 }
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { composedPreset: () => presetId }
      return undefined
    },
    on() { return () => {} },
    effect(fn) { try { fn() } catch { /* 忽略 */ } return () => {} },
    inject() {},
    tools: {
      restrict(filter) {
        const names = [...(filter?.allow ?? []), ...(filter?.deny ?? [])]
        if (names.some((name) => name.startsWith('__'))) {
          throw new Error('tools.restrict() names unknown global tool')
        }
        calls.restrict++
        return () => {}
      },
      guard(fn) { calls.guard++; calls.guardFn = fn },
      register(definition) { calls.registeredTools.push(definition); return () => {} },
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, calls }
}

/** settings 实例的假 ctx：带 webServer 路由表，供 session-ops 路由断言入队内容。 */
function makeSettingsCtx() {
  const calls = { routes: new Map(), webRoutes: [] }
  const settingsSecret = {
    configure() { return () => {} },
    update() { return Promise.resolve() },
  }
  const ctx = {
    get() { return undefined },
    on() { return () => {} },
    effect(fn) { try { fn() } catch { /* 忽略 */ } return () => {} },
    inject(deps, fn) {
      // settings / sessionPersistence 都直接喂一个够用的假子 ctx。
      try {
        fn({ get: () => undefined, effect: ctx.effect, fiber: {}, settings: settingsSecret })
      } catch { /* 忽略 */ }
    },
    webServer: {
      register(spec) {
        calls.routes.set(spec.path, spec.handler)
        calls.webRoutes.push(spec)
        return () => {}
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, calls }
}

/** settings + guard 一起装好，并与生产一样共用模块级的会话指令队列。 */
function makeHarness() {
  const settings = makeSettingsCtx()
  mod.apply(settings.ctx, mod.Config({ role: 'settings' }))
  const guard = makeGuardCtx()
  mod.apply(guard.ctx, mod.Config({ role: 'guard' }))
  const tool = guard.calls.registeredTools.find((item) => item.name === mod.IMAGE_TOOL_NAME)
  return { settings, guard, tool }
}

/** 调一个 HTTP 路由（假的 req/res；body 走 JSON）。 */
function callRoute(handler, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = '/'
    req.headers = headers
    req.destroy = () => {}
    const res = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status },
      end(text) {
        this.body = String(text ?? '')
        resolve({ status: this.status, body: this.body === '' ? {} : JSON.parse(this.body) })
      },
    }
    try {
      Promise.resolve(handler(req, res)).catch(reject)
    } catch (error) {
      reject(error)
      return
    }
    if (body !== undefined) {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      req.emit('end')
    } else if (method === 'POST') {
      req.emit('end')
    }
  })
}

/** 从 session-ops 队列里取某会话的 op。 */
async function takeOp(routes, sessionId) {
  const response = await callRoute(routes.get(SESSION_OPS_ROUTE))
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return response.body.ops.filter((op) => op.sessionId === sessionId)
}

/* ── 用例 ───────────────────────────────────────────────────────── */

console.log('「发图片」工具（qq_send_image）：')

await check('导出常量与契约一致（IMAGE_TOOL_NAME / IMAGE_RECEIPT_TIMEOUT_MS=20000）', () => {
  assert.equal(mod.IMAGE_TOOL_NAME, 'qq_send_image')
  assert.equal(mod.IMAGE_RECEIPT_TIMEOUT_MS, 20000)
})

await check('工具能力版本 TOOL_CAPABILITY_EPOCH 有值且能从 /config 下发给桥接', async () => {
  assert.equal(typeof mod.TOOL_CAPABILITY_EPOCH, 'string')
  assert.match(mod.TOOL_CAPABILITY_EPOCH, /^v\d/, '格式应是 v 开头的版本串')
  const routeHarness = makeHarness()
  const route = routeHarness.settings.calls.routes.get('/dsh-qq-guard/config')
  assert.ok(route, '设置实例没有注册 /dsh-qq-guard/config 路由')
  const res = await callRoute(route)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body?.config?.toolEpoch, mod.TOOL_CAPABILITY_EPOCH,
    '★ 桥接靠这个字段判断旧会话要不要重建（否则老会话永远拿不到新工具）')
  assert.equal(res.body?.config?.features?.image, true, '默认配置下 features.image 必须是 true')
})

await check('DEFAULT_SKILLS 里有 sk-image，且与契约逐字一致', () => {
  const defaults = mod.plainConfig(mod.Config({ role: 'settings' })).skills
  const image = defaults.find((item) => item.id === 'sk-image')
  assert.ok(image, `默认技能清单里没有 sk-image：${JSON.stringify(defaults.map((item) => item.id))}`)
  assert.deepEqual(image, CONTRACT_SK_IMAGE)
})

console.log('\n— features.image 兼容（老配置缺 sk-image 视为开启）—')

await check('默认配置：image = true', () => {
  assert.equal(mod.readFeatureFlags(mod.Config({ role: 'settings' })).image, true)
})

await check('老配置（skills 数组里没有 sk-image）→ image 仍为 true', () => {
  const cfg = mod.Config({
    role: 'settings',
    skills: [{ id: 'sk-voice', name: '发语音', enabled: false }],
  })
  const flags = mod.readFeatureFlags(cfg)
  assert.equal(flags.image, true, '★ 老配置不能被当成「用户删了 = 关闭」')
  assert.equal(flags.voice, false, '其它技能的显式开关仍然生效')
})

await check('显式关闭 sk-image → image = false', () => {
  const cfg = mod.Config({
    role: 'settings',
    skills: [{ id: 'sk-image', name: '发图片', enabled: false }],
  })
  assert.equal(mod.readFeatureFlags(cfg).image, false)
})

await check('显式开启 sk-image → image = true；空数组（全删）也按新默认 true', () => {
  assert.equal(mod.readFeatureFlags(mod.Config({
    role: 'settings',
    skills: [{ id: 'sk-image', name: '发图片', enabled: true }],
  })).image, true)
  assert.equal(mod.readFeatureFlags(mod.Config({ role: 'settings', skills: [] })).image, true)
})

console.log('\n— 注册与 schema —')

const harness = makeHarness()
const tool = harness.tool

await check('qq_send_image 注册在 preset 作用域（guard 实例）', () => {
  assert.ok(tool, '没有注册 qq_send_image')
  assert.equal(typeof tool.execute, 'function')
})

await check('parameters 是合法 JSON Schema：根 object + url/file 均为 string 且非必填', () => {
  assert.equal(tool.parameters?.type, 'object')
  assert.equal(tool.parameters.properties?.url?.type, 'string')
  assert.equal(tool.parameters.properties?.file?.type, 'string')
  const required = Array.isArray(tool.parameters.required) ? tool.parameters.required : []
  assert.ok(!required.includes('url'), 'url 不应是必填（二选一由 execute 判断）')
  assert.ok(!required.includes('file'), 'file 不应是必填')
})

await check('output.schema 合法（object + additionalProperties:false）且 render 可输出文本', () => {
  assert.equal(tool.output?.schema?.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, false)
  assert.equal(typeof tool.output.render, 'function')
  const rendered = tool.output.render({}, { queued: true, sent: true, id: 'op-1', detail: '已发送图片（via=url，retcode=0）' })
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /已发到 QQ/)
})

console.log('\n— 执行期 guard：技能开关 —')

await check('image 开启 → qq_send_image 在执行期放行', () => {
  mod.bindFeatureConfigSource(mod.Config({ role: 'settings' }))
  assert.equal(harness.guard.calls.guardFn({ name: 'qq_send_image' }), undefined)
})

await check('image 关闭 → 执行期拒绝（原因可读）', () => {
  mod.bindFeatureConfigSource(mod.Config({
    role: 'settings',
    skills: [{ id: 'sk-image', name: '发图片', enabled: false }],
  }))
  const reason = harness.guard.calls.guardFn({ name: 'qq_send_image' })
  assert.equal(typeof reason, 'string')
  assert.match(reason, /发图片/)
  mod.bindFeatureConfigSource(null)
})

console.log('\n— execute：参数二选一 —')

await check('技能关闭 → 抛错且不入队', async () => {
  mod.bindFeatureConfigSource(mod.Config({
    role: 'settings',
    skills: [{ id: 'sk-image', name: '发图片', enabled: false }],
  }))
  const before = mod.sessionOpsSnapshot().queued
  await assert.rejects(
    () => tool.execute({ url: 'https://example.com/a.png' }, { agent: { id: 'sess-off' } }),
    /发图片/,
  )
  assert.equal(mod.sessionOpsSnapshot().queued, before, '关掉的技能不该入队')
  mod.bindFeatureConfigSource(null)
})

await check('url / file 都不给 → 抛错且不入队', async () => {
  const before = mod.sessionOpsSnapshot().queued
  await assert.rejects(() => tool.execute({}, { agent: { id: 'sess-empty' } }), /必须给一个/)
  await assert.rejects(() => tool.execute({ url: '   ', file: '  ' }, { agent: { id: 'sess-empty' } }), /必须给一个/)
  assert.equal(mod.sessionOpsSnapshot().queued, before, '没图源时不该入队')
})

await check('拿不到 sessionId → 抛错（只能在 QQ 会话内调用）', async () => {
  await assert.rejects(() => tool.execute({ url: 'https://example.com/a.png' }, {}), /只能在 QQ 会话内调用/)
})

await check('url 非字符串 / file 非字符串 → 抛错', async () => {
  await assert.rejects(() => tool.execute({ url: 42 }, { agent: { id: 'sess-bad' } }), /url 必须是字符串/)
  await assert.rejects(() => tool.execute({ file: {} }, { agent: { id: 'sess-bad' } }), /file 必须是字符串/)
})

console.log('\n— execute：入队 → 桥接回执 —')

await check('两个都给 → 用 url 入队（op:image，不带 file）', async () => {
  mod.bindFeatureConfigSource(mod.Config({ role: 'settings' }))
  const pending = tool.execute(
    { url: 'https://example.com/a.png', file: 'C:/tmp/b.png' },
    { agent: { id: 'sess-image-both' } },
  )
  const [op] = await takeOp(harness.settings.calls.routes, 'sess-image-both')
  assert.ok(op, '没有入队 image op')
  assert.equal(op.op, 'image')
  assert.equal(op.url, 'https://example.com/a.png')
  assert.equal(op.file, undefined, '两个都给时只带 url')

  // 走真实的回执路径（POST session-ops {results}）→ 唤醒工具调用。
  const ack = await callRoute(harness.settings.calls.routes.get(SESSION_OPS_ROUTE), {
    method: 'POST',
    body: { results: [{ id: op.id, ok: true, detail: '已发送图片（via=url，retcode=0）' }] },
  })
  assert.equal(ack.status, 200, JSON.stringify(ack.body))
  assert.equal(ack.body.settled, 1)
  const value = await pending
  assert.deepEqual(value, {
    queued: true,
    sent: true,
    id: op.id,
    detail: '已发送图片（via=url，retcode=0）',
  })
})

await check('只给 file → 入队 file；回执失败 → throw 可读原因（不再假装成功）', async () => {
  const pending = tool.execute(
    { file: 'file:///C:/tmp/c.png' },
    { agent: { id: 'sess-image-file' } },
  )
  const [op] = await takeOp(harness.settings.calls.routes, 'sess-image-file')
  assert.ok(op, '没有入队 image op')
  assert.equal(op.file, 'file:///C:/tmp/c.png')
  assert.equal(op.url, undefined)

  mod.settleSessionOpResult(op.id, { ok: false, detail: '下载图片失败（via=url）：HTTP 404' })
  await assert.rejects(() => pending, /图片发送失败：下载图片失败/)
})

await check('桥接没回执（超时）→ throw「图片没有发出去」', async () => {
  // 不真的等 20s：把 20s 级的 setTimeout 临时压成 0ms（只影响本用例，结束立刻还原），
  // 走的是 waitForOpResult 真实的超时分支。
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Number(ms) >= 20000 ? 0 : ms, ...args)
  try {
    await assert.rejects(
      () => tool.execute({ url: 'https://example.com/slow.png' }, { agent: { id: 'sess-image-timeout' } }),
      /图片没有发出去：桥接没有回执/,
    )
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

await check('顶层（非 preset）apply role=guard → 不注册 qq_send_image', () => {
  // presetId 传空串：composedPreset 拿不到 preset；restrict 再抛「requires a scoped context」。
  const { ctx, calls } = makeGuardCtx({ presetId: '' })
  // 顶层假 ctx 没有 scope：restrict 应抛 requires a scoped context
  ctx.tools.restrict = () => { throw new Error('tools.restrict() requires a scoped context (agent.ctx)') }
  mod.apply(ctx, mod.Config({ role: 'guard' }))
  assert.equal(calls.registeredTools.length, 0, '顶层不该注册任何 QQ 工具')
  assert.equal(calls.guard, 0, '顶层也不许挂 guard')
})

console.log('\n— 队列去重：不同工具互不踩 + 同类去重不空等 —')

await check('voice 与 image 同 sessionId 共存（跨 op 不许互相删除）', async () => {
  mod.bindFeatureConfigSource(mod.Config({ role: 'settings' }))
  const voice = harness.guard.calls.registeredTools.find((item) => item.name === mod.VOICE_TOOL_NAME)
  assert.ok(voice, '没有注册 qq_send_voice')
  const sessionId = 'sess-mixed-tools'
  const voicePending = voice.execute({ text: '在吗' }, { agent: { id: sessionId } })
  const imagePending = tool.execute({ url: 'https://example.com/mixed.png' }, { agent: { id: sessionId } })
  try {
    const ops = await takeOp(harness.settings.calls.routes, sessionId)
    // ★ 回归点：以前按 sessionId 跨 op 删除，voice 会被后到的 image 删掉。
    assert.deepEqual(ops.map((op) => op.op).sort(), ['image', 'voice'], `同会话两种工具必须都在：${JSON.stringify(ops.map((op) => op.op))}`)
    for (const op of ops) mod.settleSessionOpResult(op.id, { ok: true, detail: `${op.op} 已发送` })
    const [voiceValue, imageValue] = await Promise.all([voicePending, imagePending])
    assert.equal(voiceValue.sent, true)
    assert.equal(imageValue.sent, true)
  } finally {
    // 兜底：任何 assert 失败也把挂起的工具调用结算掉，不留 25s 定时器。
    for (const op of mod.sessionOpsSnapshot().ids) mod.settleSessionOpResult(op, { ok: false, detail: 'cleanup' })
  }
})

await check('同类 image 连发：旧请求立刻失败（取代），新请求保留并可成功', async () => {
  mod.bindFeatureConfigSource(mod.Config({ role: 'settings' }))
  const sessionId = 'sess-dup-image'
  const first = tool.execute({ url: 'https://example.com/first.png' }, { agent: { id: sessionId } })
    .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))
  const second = tool.execute({ url: 'https://example.com/second.png' }, { agent: { id: sessionId } })
  // 等第一条真的被后到的那条取代（settleOpResult 是同步的，微任务后就能看到）。
  const firstOutcome = await first
  assert.equal(firstOutcome.ok, false, '被取代的旧请求不能假装成功')
  assert.match(String(firstOutcome.error?.message ?? ''), /取代/, '旧请求必须立刻收到可读的取代原因，而不是空等 20s')
  const ops = await takeOp(harness.settings.calls.routes, sessionId)
  assert.equal(ops.length, 1, `同类去重后只该剩 1 条，实际 ${ops.length}`)
  assert.equal(ops[0].url, 'https://example.com/second.png')
  mod.settleSessionOpResult(ops[0].id, { ok: true, detail: '已发送图片（via=url，retcode=0）' })
  const value = await second
  assert.equal(value.sent, true)
  assert.equal(value.detail, '已发送图片（via=url，retcode=0）')
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
