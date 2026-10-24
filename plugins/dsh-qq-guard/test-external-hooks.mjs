/**
 * 外部插件 P2 离线用例：常驻沙箱 / hook 路由 / runtime 快照 / 工具代理。
 *
 * 用**假 sandbox manager 注入**（`mod.setSandboxFactoryForTests`）验证 p2-contract §4：
 *   · 无沙箱 / 无启用插件 / 插件没声明 hook → `{ ok:true, modules:[], latencyMs }`，绝不报错；
 *   · hook 结果合并（text / drop / sections）+ 单模块超时参数 + 抛错不冒泡（只 warn 一次）；
 *   · `GET /external/runtime` 快照字段（resident / loaded[].hooks / tools[] / updatedAt）；
 *   · 工具代理 `qq_ext_<slug>` 注册进 preset 作用域，执行转发 `{kind:'tool'}`，
 *     失败抛可读错误；`qq_ext_` 前缀不被执行期白名单误拒；
 *   · parameters 适配（JSON Schema ↔ 作者 spec，不支持类型降级 json）。
 *
 * 假 manager 的 invoke 回包形状与真 child 一致：`{ found, value }`。
 * 运行：node plugins/dsh-qq-guard/test-external-hooks.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
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
const tmpFile = path.join(HERE, `.tmp-external-hooks-${process.pid}.mjs`)
fs.writeFileSync(tmpFile, patched)
let mod
try {
  mod = await import('file:///' + tmpFile.replace(/\\/g, '/'))
} finally {
  try { fs.unlinkSync(tmpFile) } catch { /* 忽略 */ }
}

const HOOK_ROUTE = '/dsh-qq-guard/external/hook'
const RUNTIME_ROUTE = '/dsh-qq-guard/external/runtime'

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

/* ── 夹具：一个真实的外部插件根（scanPluginDir 要能扫到 + 判定自包含）── */

function makeExternalRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqg-external-hooks-'))
  const dir = path.join(root, 'plugins', 'demo-plugin')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id: 'demo-plugin',
    name: '演示插件',
    version: '1.0.0',
    category: 'utility',
    entry: 'index.js',
  }))
  fs.writeFileSync(path.join(dir, 'index.js'), [
    'export function setup() {}',
    'export const hooks = { onMessage() {}, "before-context"() {} }',
    '',
  ].join('\n'))
  return { root, dir }
}

const ROOT = makeExternalRoot()

function defaultTools(module) {
  return [{
    id: `${module.id}__echo`,
    name: 'echo',
    description: '回显参数',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
  }]
}

/**
 * 假 sandbox manager（形状对齐 SandboxManager：state/alive/nodeInfo + ensure/testLoad/invoke/dispose）。
 * `onInvoke` 每个用例现改，模拟插件返回 / 抛错 / 找不到 hook。
 */
function makeFakeManager({ hooks = ['onMessage', 'before-context'], tools = null } = {}) {
  const calls = { ensure: 0, loads: [], invokes: [] }
  const manager = {
    state: 'ready',
    alive: true,
    nodeInfo: { pid: 4242 },
    calls,
    async ensure() { calls.ensure += 1 },
    async testLoad(module) {
      calls.loads.push(module)
      return {
        ok: true,
        result: {
          moduleId: module.id,
          exports: { setup: true, hooks },
          toolCount: 1,
          tools: tools ?? defaultTools(module),
          durationMs: 1,
        },
      }
    },
    async invoke(payload, opts) {
      calls.invokes.push({ payload, opts })
      return manager.onInvoke(payload, opts)
    },
    async dispose() {},
  }
  manager.onInvoke = () => ({ moduleId: 'demo-plugin', kind: 'hook', found: true, value: null })
  return manager
}

/* ── 假 ctx ─────────────────────────────────────────────────────── */

function makeSettingsCtx() {
  const calls = { routes: new Map() }
  const ctx = {
    get() { return undefined },
    on() { return () => {} },
    effect(fn) { try { fn() } catch { /* 忽略 */ } return () => {} },
    inject(_deps, fn) {
      try {
        fn({
          get: () => undefined,
          effect: ctx.effect,
          fiber: {},
          settings: { configure() { return () => {} }, update() { return Promise.resolve() } },
        })
      } catch { /* 忽略 */ }
    },
    webServer: {
      register(spec) {
        calls.routes.set(spec.path, spec.handler)
        return () => {}
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, calls }
}

function makeGuardCtx({ presetId = 'qq-chat' } = {}) {
  const calls = { registeredTools: [], guardFn: null, guard: 0 }
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
        if (names.some((name) => String(name).startsWith('__'))) {
          throw new Error('tools.restrict() names unknown global tool')
        }
        return () => {}
      },
      guard(fn) { calls.guard++; calls.guardFn = fn },
      register(definition) { calls.registeredTools.push(definition); return () => {} },
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, calls }
}

/** 装一个 settings 实例（带路由表）。 */
function applySettings(config) {
  const harness = makeSettingsCtx()
  mod.apply(harness.ctx, mod.Config({ role: 'settings', ...config }))
  return harness
}

/** 装一个 guard 实例（preset 内），返回注册的工具。 */
function applyGuard() {
  const harness = makeGuardCtx()
  mod.apply(harness.ctx, mod.Config({ role: 'guard' }))
  return harness
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

const hookBody = (overrides = {}) => ({
  event: 'message',
  sessionId: 'sess-1',
  key: 'g:123456',
  text: '你好呀',
  imageCount: 2,
  user: { id: '10001', name: '群友A', admin: true },
  group: { id: '123456', name: '测试群' },
  ...overrides,
})

/* ── 主链路：启用插件 + 常驻 + 代理工具 ─────────────────────────── */

console.log('外部插件 P2（假 sandbox manager）：')

const fake = makeFakeManager()
mod.setSandboxFactoryForTests(() => fake)
const settings = applySettings({ externalPlugins: { dirs: [ROOT.root], enabled: ['demo-plugin'] } })
// 先装 guard（此时 loaded 还是空）→ 验证 ensure 完成后能通过 appliers 补注册代理工具。
const guard = applyGuard()

const runtimeRes = await callRoute(settings.calls.routes.get(RUNTIME_ROUTE))

await check('GET /external/runtime：resident 三个字段 + loaded 结构符合契约', () => {
  assert.equal(runtimeRes.status, 200)
  assert.equal(runtimeRes.body.ok, true)
  assert.deepEqual(runtimeRes.body.resident, { state: 'ready', pid: 4242, alive: true })
  assert.ok(runtimeRes.body.updatedAt > 0, 'updatedAt 应是加载时间戳')
  assert.equal(runtimeRes.body.loaded.length, 1)
  const plugin = runtimeRes.body.loaded[0]
  assert.equal(plugin.id, 'demo-plugin')
  assert.equal(plugin.name, '演示插件')
  assert.equal(plugin.moduleId, 'demo-plugin')
  assert.ok(plugin.hooks.includes('onMessage'), JSON.stringify(plugin.hooks))
  assert.deepEqual(plugin.tools, [{ id: 'demo-plugin__echo', name: 'echo', description: '回显参数' }],
    'tools[] 只暴露 id/name/description（契约）')
})

await check('常驻：ensure 只跑一次；已启用插件被 load（自包含 + 有入口）', () => {
  assert.ok(fake.calls.ensure >= 1)
  assert.equal(fake.calls.loads.length, 1, `load 次数不对：${JSON.stringify(fake.calls.loads)}`)
  assert.equal(fake.calls.loads[0].id, 'demo-plugin')
  assert.match(String(fake.calls.loads[0].entryPath).replace(/\\/g, '/'), /demo-plugin\/index\.js$/)
})

const proxy = guard.calls.registeredTools.find((item) => item.name.startsWith('qq_ext_'))

await check('工具代理 qq_ext_<slug> 注册进 preset 作用域（按已加载插件补注册）', () => {
  assert.ok(proxy, `没有代理工具：${JSON.stringify(guard.calls.registeredTools.map((t) => t.name))}`)
  assert.equal(proxy.name, 'qq_ext_echo')
  assert.equal(typeof proxy.execute, 'function')
  assert.equal(proxy.parameters?.type, 'object')
  assert.equal(proxy.parameters.properties?.text?.type, 'string')
  assert.deepEqual(proxy.parameters.required, ['text'], 'JSON Schema 的 required 要转成作者 spec 的 required:true')
  assert.equal(proxy.output.schema.type, 'object')
})

await check('执行期白名单：qq_ext_ 前缀放行，其它未知工具仍拒绝', () => {
  assert.equal(guard.calls.guardFn({ name: 'qq_ext_echo' }), undefined, '★ 不认前缀会把自家代理工具拒掉')
  assert.match(String(guard.calls.guardFn({ name: 'ops_bash' })), /白名单/)
})

/* ── hook 路由 ─────────────────────────────────────────────────── */

await check('hook message：请求事件按契约收敛后被转发，结果合并 text', async () => {
  fake.onInvoke = () => ({ moduleId: 'demo-plugin', kind: 'hook', found: true, value: '改写后的正文' })
  const res = await callRoute(settings.calls.routes.get(HOOK_ROUTE), { method: 'POST', body: hookBody() })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.text, '改写后的正文')
  assert.deepEqual(res.body.modules, ['demo-plugin'])
  assert.equal(typeof res.body.latencyMs, 'number')
  const call = fake.calls.invokes.at(-1)
  assert.equal(call.payload.kind, 'hook')
  assert.equal(call.payload.name, 'message')
  assert.equal(call.payload.moduleId, 'demo-plugin')
  assert.equal(call.payload.event.text, '你好呀')
  assert.equal(call.payload.event.imageCount, 2)
  assert.deepEqual(call.payload.event.user, { id: '10001', name: '群友A', admin: true })
  assert.deepEqual(call.payload.event.group, { id: '123456', name: '测试群' })
  assert.ok(call.opts.timeoutMs > 0 && call.opts.timeoutMs <= 1500, `单模块超时应 ≤1500ms，实际 ${call.opts.timeoutMs}`)
})

await check('hook before-context：drop / sections / text 合并', async () => {
  fake.onInvoke = () => ({
    moduleId: 'demo-plugin',
    kind: 'hook',
    found: true,
    value: { drop: true, text: '替换正文', sections: [{ title: '外部上下文', text: '补充段落' }] },
  })
  const res = await callRoute(settings.calls.routes.get(HOOK_ROUTE), {
    method: 'POST',
    body: hookBody({ event: 'before-context', group: null }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.drop, true)
  assert.equal(res.body.text, '替换正文')
  assert.deepEqual(res.body.sections, [{ title: '外部上下文', text: '补充段落' }])
  assert.deepEqual(res.body.modules, ['demo-plugin'])
  const call = fake.calls.invokes.at(-1)
  assert.equal(call.payload.name, 'before-context')
  assert.equal(call.payload.event.group, null, '群聊信息为空时必须是 null')
})

await check('hook：插件没这个 hook（found:false）→ modules 里不出现', async () => {
  fake.onInvoke = () => ({ moduleId: 'demo-plugin', kind: 'hook', found: false, value: null })
  const res = await callRoute(settings.calls.routes.get(HOOK_ROUTE), { method: 'POST', body: hookBody() })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(res.body.modules, [])
  assert.equal(res.body.text, undefined)
})

await check('hook：插件抛错不冒泡，响应仍 200 ok:true（只 warn 一次）', async () => {
  fake.onInvoke = () => { throw new Error('插件内部异常 boom') }
  const warns = []
  const originalWarn = console.warn
  console.warn = (...args) => { warns.push(args.map(String).join(' ')) }
  try {
    const first = await callRoute(settings.calls.routes.get(HOOK_ROUTE), { method: 'POST', body: hookBody() })
    const second = await callRoute(settings.calls.routes.get(HOOK_ROUTE), { method: 'POST', body: hookBody() })
    for (const res of [first, second]) {
      assert.equal(res.status, 200)
      assert.equal(res.body.ok, true, 'hook 失败不能把桥接拖挂')
      assert.deepEqual(res.body.modules, [])
      assert.equal(typeof res.body.latencyMs, 'number')
    }
  } finally {
    console.warn = originalWarn
  }
  assert.equal(warns.filter((line) => line.includes('外部插件 hook 失败')).length, 1, '抛错只 warn 一次')
})

await check('hook：坏 event → 400；GET → 405；跨站 → 403', async () => {
  const bad = await callRoute(settings.calls.routes.get(HOOK_ROUTE), { method: 'POST', body: { event: 'nope' } })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.reason, 'bad-event')
  const wrongMethod = await callRoute(settings.calls.routes.get(HOOK_ROUTE), { method: 'GET' })
  assert.equal(wrongMethod.status, 405)
  const cross = await callRoute(settings.calls.routes.get(HOOK_ROUTE), {
    method: 'POST',
    body: hookBody(),
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(cross.status, 403)
})

/* ── 工具代理执行 ──────────────────────────────────────────────── */

await check('工具代理 execute：转发 {kind:"tool", name:toolId}，结果包成 { result }', async () => {
  fake.onInvoke = (payload) => ({
    moduleId: 'demo-plugin',
    kind: 'tool',
    found: true,
    value: { echoed: payload.args?.text ?? null },
  })
  const value = await proxy.execute({ text: '回显我' }, {})
  assert.deepEqual(value, { result: { echoed: '回显我' } })
  const call = fake.calls.invokes.at(-1)
  assert.equal(call.payload.kind, 'tool')
  assert.equal(call.payload.name, 'demo-plugin__echo')
  assert.deepEqual(call.payload.args, { text: '回显我' })
  assert.equal(call.opts.timeoutMs, 10000, '工具代理默认超时 10s')
  const rendered = proxy.output.render({}, value)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /回显我/)
})

await check('工具代理 execute：执行失败 → throw 可读错误', async () => {
  fake.onInvoke = () => { throw new Error('插件执行超时（10000ms）') }
  await assert.rejects(
    () => proxy.execute({ text: 'x' }, {}),
    /外部插件工具「echo」执行失败：.*超时/,
  )
})

await check('外部工具 parameters 适配：JSON Schema → 作者 spec', () => {
  const spec = mod.adaptExternalToolParameters({
    type: 'object',
    properties: {
      text: { type: 'string', description: '文本' },
      count: { type: 'integer' },
      ratio: { type: 'number' },
      on: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } },
      meta: {
        type: 'object',
        additionalProperties: false,
        properties: { nested: { type: 'boolean' } },
        required: ['nested'],
      },
    },
    required: ['text'],
  })
  assert.equal(spec.text.type, 'string')
  assert.equal(spec.text.required, true)
  assert.equal(spec.text.description, '文本')
  assert.equal(spec.count.type, 'integer')
  assert.equal(spec.count.required, undefined)
  assert.equal(spec.ratio.type, 'number')
  assert.equal(spec.on.type, 'boolean')
  assert.equal(spec.tags.type, 'array')
  assert.equal(spec.tags.items.type, 'string')
  assert.equal(spec.meta.type, 'object')
  assert.equal(spec.meta.additionalProperties, false)
  assert.equal(spec.meta.properties.nested.type, 'boolean')
  assert.equal(spec.meta.properties.nested.required, true)
})

await check('外部工具 parameters 适配：作者 spec 输入 / enum / 不支持类型降级 json', () => {
  const spec = mod.adaptExternalToolParameters({
    choice: { type: 'string', enum: ['a', 'b'], required: true, description: '选项' },
    weird: { type: 'weird-type' },
    raw: { type: 'json' },
  })
  assert.deepEqual(spec.choice.enum, ['a', 'b'])
  assert.equal(spec.choice.type, 'string')
  assert.equal(spec.choice.required, true)
  assert.equal(spec.weird.type, 'json', '不支持的类型必须降级成 json')
  assert.equal(spec.raw.type, 'json')
})

/* ── 无插件 / 无沙箱 / 没声明 hook ─────────────────────────────── */

await check('插件没声明该 hook → 不发 invoke，直接 modules:[]', async () => {
  const fake2 = makeFakeManager({ hooks: ['before-context'] })
  mod.setSandboxFactoryForTests(() => fake2)
  const settings2 = applySettings({ externalPlugins: { dirs: [ROOT.root], enabled: ['demo-plugin'] } })
  await callRoute(settings2.calls.routes.get(RUNTIME_ROUTE))
  const res = await callRoute(settings2.calls.routes.get(HOOK_ROUTE), { method: 'POST', body: hookBody() })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.modules, [])
  assert.equal(fake2.calls.invokes.length, 0, '没声明 hook 的模块不该收到 invoke')
})

await check('没有启用插件（enabled 空）→ ok:true modules:[]', async () => {
  const fake3 = makeFakeManager()
  mod.setSandboxFactoryForTests(() => fake3)
  const settings3 = applySettings({ externalPlugins: { dirs: [ROOT.root], enabled: [] } })
  const res = await callRoute(settings3.calls.routes.get(HOOK_ROUTE), { method: 'POST', body: hookBody() })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(res.body.modules, [])
  assert.equal(fake3.calls.loads.length, 0, '无启用插件时不该 load 任何模块')
})

await check('没有沙箱（无 subprocess）→ ok:true modules:[]，不报错', async () => {
  mod.resetExternalRuntimeForTests()
  mod.setSandboxFactoryForTests(null)
  const settings4 = applySettings({ externalPlugins: { dirs: [ROOT.root], enabled: ['demo-plugin'] } })
  const runtime = await callRoute(settings4.calls.routes.get(RUNTIME_ROUTE))
  assert.equal(runtime.status, 200)
  assert.equal(runtime.body.resident.state, 'stopped')
  assert.equal(runtime.body.resident.alive, false)
  assert.deepEqual(runtime.body.loaded, [])
  const res = await callRoute(settings4.calls.routes.get(HOOK_ROUTE), { method: 'POST', body: hookBody() })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.modules, [])
})

await check('runtime 路由：POST → 405，跨站 → 403', async () => {
  const settings5 = applySettings({ externalPlugins: { dirs: [], enabled: [] } })
  const route = settings5.calls.routes.get(RUNTIME_ROUTE)
  const post = await callRoute(route, { method: 'POST' })
  assert.equal(post.status, 405)
  const cross = await callRoute(route, { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(cross.status, 403)
})

// 收尾：清掉注入的假沙箱，避免影响同进程里的后续用例。
mod.resetExternalRuntimeForTests()
mod.setSandboxFactoryForTests(null)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
