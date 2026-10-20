/**
 * qq-guard 回归用例：把「顶层实例绝不挂 tools.guard」这个事故教训锁死。
 *
 * 2026-10-20 事故：`role` 未声明时走了兼容分支，顶层实例装了 tools.guard，
 * 而 plain-context guard 是**全局**的 → 整个 profile 每个会话的工具全被拒，
 * 用户锁死，只能手改 yaml + 重启。
 *
 * 本文件用**假 ctx** 验证 apply() 的分派逻辑，不需要真实 DSH 进程。
 * 运行：node plugins/dsh-qq-guard/test-guard-scope.mjs
 */
import assert from 'node:assert/strict'
import fs, { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// schemastery 由宿主（profile 的 node_modules）提供；测试时用 QQG_SCHEMASTERY 指定，
// 不写死某台机器的 profile 路径。找不到就跳过用例并给出明确提示。
function resolveSchemastery() {
  if (process.env.QQG_SCHEMASTERY) return process.env.QQG_SCHEMASTERY
  const candidates = [
    path.join(HERE, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
    path.resolve(HERE, '../../node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  console.error('找不到 @deepseek-ai/schemastery；请设 QQG_SCHEMASTERY 指向它的 lib/index.mjs')
  process.exit(2)
}

// 插件本体的 import 需要宿主解析 @deepseek-ai/schemastery；测试时把模块源码
// 里那行 import 换成本地绝对路径，避免依赖 profile 的 node_modules 布局。
const SRC = readFileSync(path.join(HERE, 'index.js'), 'utf8')
const SM_PATH = process.env.QQG_SCHEMASTERY
  || 'resolveSchemastery()'
const patched = SRC.replace(
  /^import Schema from '@deepseek-ai\/schemastery'$/m,
  `import Schema from ${JSON.stringify('file:///' + SM_PATH.replace(/\\/g, '/'))}`,
)
const tmpFile = path.join(HERE, '.tmp-index.mjs')
const { writeFileSync, unlinkSync } = await import('node:fs')
writeFileSync(tmpFile, patched)
let mod
try {
  mod = await import('file:///' + tmpFile.replace(/\\/g, '/'))
} finally {
  unlinkSync(tmpFile)
}

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

/** 造一个假的 ctx，记录所有注册行为。 */
function makeCtx({ presetId, hasWebServer = false, settingsAvailable = false, hasSubprocess = false } = {}) {
  const calls = { restrict: 0, guard: 0, webRoutes: [], effects: [], inj: [], warn: [] }
  const ctx = {
    get(name) {
      if (name === 'agentPresets') {
        return { composedPreset: () => presetId }
      }
      return undefined
    },
    on() { return () => {} },
    effect(fn) { calls.effects.push(fn); try { fn() } catch { /* 忽略 */ } return () => {} },
    inject(_deps, fn) { calls.inj.push(fn); if (settingsAvailable) fn(makeSettingsCtx(calls)) },
    tools: {
      restrict() { calls.restrict++ },
      guard() { calls.guard++ },
    },
    webServer: hasWebServer ? {
      register(route) { calls.webRoutes.push(route); return () => {} },
    } : undefined,
    // NapCat / 桥接管理需要 subprocess；不给的话这两条路由不会注册。
    subprocess: hasSubprocess ? {
      spawn() { throw new Error('test: 不应真的 spawn') },
    } : undefined,
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, calls }
}

function makeSettingsCtx(calls) {
  return {
    fiber: {},
    settings: { configure() { calls.effects.push('configure'); return () => {} } },
    effect(fn) { calls.effects.push(fn); try { fn() } catch { /* 忽略 */ } return () => {} },
  }
}

const Config = mod.Config
const apply = mod.apply
const readRole = mod.readRole
const plainConfig = mod.plainConfig

console.log('— role 解析（.volatile() 是包装对象，必须经 get()）—')
await check('role=guard 能读回字符串', () => {
  assert.equal(readRole(Config({ role: 'guard' })), 'guard')
})
await check('role=settings 能读回字符串', () => {
  assert.equal(readRole(Config({ role: 'settings' })), 'settings')
})
await check('未声明 role → undefined（不是 guard！）', () => {
  assert.equal(readRole(Config({})), undefined)
})
await check('Config schema 里 role 不应有 default', () => {
  const json = JSON.stringify(Config.toJSON())
  assert.ok(!/default"?:?\{?"?:?"?guard/.test(json), 'role 不应有 default: guard')
  const form = JSON.parse(json)
  // 找到 role 节点，确认没有 meta.default
  const walk = (node, key) => {
    if (!node || typeof node !== 'object') return
    if (key === 'role' && node.meta) {
      assert.equal(node.meta.default, undefined, 'role.meta.default 必须不存在')
    }
    for (const [k, v] of Object.entries(node.dict ?? {})) walk(v, k)
  }
  for (const [k, v] of Object.entries(form.refs ?? {})) {
    if (v?.type === 'object') for (const [ck, cv] of Object.entries(v.dict ?? {})) {
      if (ck === 'role') assert.equal(form.refs?.[cv]?.meta?.default, undefined, 'role 不应有默认值')
    }
  }
})
await check('非法 role 值被 schema 拒绝', () => {
  assert.throws(() => Config({ role: 'xxx' }))
})

console.log('\n— plainConfig：volatile 包装必须解包，否则桥接收到空壳 —')
await check('plainConfig 解开 .get() 包装', () => {
  const parsed = Config({ role: 'settings', bubbleMaxChars: 42, typingDelay: { enabled: false } })
  const plain = plainConfig(parsed)
  assert.equal(plain.role, 'settings', 'role 不能是 {}')
  assert.equal(plain.bubbleMaxChars, 42)
  assert.equal(plain.typingDelay?.enabled, false, '嵌套 volatile 也要解包')
  // 关键：序列化后不能出现空壳
  const json = JSON.stringify(plain)
  assert.ok(!json.includes('"role":{}'), `role 序列化成了空壳：${json}`)
  assert.ok(!json.includes('"enabled":{}'), `enabled 序列化成了空壳：${json}`)
})
await check('plainConfig 剥离 Symbol 属性', () => {
  const parsed = Config({ role: 'guard' })
  const plain = plainConfig(parsed)
  assert.deepEqual(Object.getOwnPropertySymbols(plain), [])
})

console.log('\n— 分派：role=undefined 什么都不做（fail-closed）—')
await check('未声明 role → 不调 tools.guard', () => {
  const { ctx, calls } = makeCtx({ presetId: undefined })
  apply(ctx, Config({}))
  assert.equal(calls.guard, 0, '绝不能挂 guard')
  assert.equal(calls.restrict, 0, '也不该挂 restrict')
  assert.equal(calls.webRoutes.length, 0, '不该注册路由')
})
await check('未声明 role + 有 webServer → 仍不注册路由', () => {
  const { ctx, calls } = makeCtx({ presetId: undefined, hasWebServer: true })
  apply(ctx, Config({}))
  assert.equal(calls.guard, 0)
  assert.equal(calls.webRoutes.length, 0)
})

console.log('\n— 分派：role=guard 只在 preset 内生效 —')
await check('顶层 ctx（composedPreset=undefined）+ role=guard → 拒绝挂 guard', () => {
  const { ctx, calls } = makeCtx({ presetId: undefined })
  apply(ctx, Config({ role: 'guard' }))
  assert.equal(calls.guard, 0, '★ 顶层绝不允许挂 tools.guard（事故点）')
  assert.equal(calls.restrict, 0, '顶层也不该 restrict')
})
await check('preset 内 ctx（composedPreset=qq-chat）+ role=guard → 正常挂载', () => {
  const { ctx, calls } = makeCtx({ presetId: 'qq-chat' })
  apply(ctx, Config({ role: 'guard' }))
  assert.ok(calls.restrict > 0, '应注册 restrict')
  assert.equal(calls.guard, 1, '应注册 1 个 guard')
  assert.equal(calls.webRoutes.length, 0, '不该注册路由')
})

console.log('\n— 分派：role=settings 只做设置面 —')
await check('role=settings 有 webServer → 注册 config/status/napcat/bridge 路由，且不挂 guard', () => {
  const { ctx, calls } = makeCtx({ presetId: undefined, hasWebServer: true, settingsAvailable: true, hasSubprocess: true })
  apply(ctx, Config({ role: 'settings' }))
  assert.equal(calls.guard, 0, '★ settings 实例绝不能挂 guard')
  assert.equal(calls.restrict, 0)
  const paths = calls.webRoutes.map((r) => r.path).sort()
  assert.deepEqual(paths, [
    '/dsh-qq-guard/bridge',
    '/dsh-qq-guard/config',
    '/dsh-qq-guard/napcat',
    '/dsh-qq-guard/status',
  ], `路由应为 4 条，实际 ${JSON.stringify(paths)}`)
  assert.ok(calls.webRoutes.every((r) => r.kind === 'exact'))
})
await check('role=settings 无 webServer → 安全跳过', () => {
  const { ctx, calls } = makeCtx({ presetId: undefined, hasWebServer: false })
  apply(ctx, Config({ role: 'settings' }))
  assert.equal(calls.guard, 0)
  assert.equal(calls.webRoutes.length, 0)
})
await check('role=settings 在 preset 内也不挂 guard', () => {
  const { ctx, calls } = makeCtx({ presetId: 'qq-chat', hasWebServer: true })
  apply(ctx, Config({ role: 'settings' }))
  assert.equal(calls.guard, 0)
})

console.log('\n— 路由行为 —')
await check('GET 返回当前 config，非 GET 返回 405', async () => {
  const { ctx, calls } = makeCtx({ presetId: undefined, hasWebServer: true, settingsAvailable: true })
  apply(ctx, Config({ role: 'settings', bubbleMaxChars: 42 }))
  const route = calls.webRoutes[0]
  const mkRes = () => ({
    status: 0, body: '', headers: {},
    writeHead(s) { this.status = s }, end(b) { this.body = b },
  })
  const res1 = mkRes()
  route.handler({ method: 'GET', headers: {} }, res1)
  assert.equal(res1.status, 200)
  const parsed = JSON.parse(res1.body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.config.role, 'settings')
  assert.equal(parsed.config.bubbleMaxChars, 42)

  const res2 = mkRes()
  route.handler({ method: 'POST', headers: {} }, res2)
  assert.equal(res2.status, 405)
})
await check('跨站请求被拒（sec-fetch-site）', async () => {
  const { ctx, calls } = makeCtx({ presetId: undefined, hasWebServer: true, settingsAvailable: true })
  apply(ctx, Config({ role: 'settings' }))
  const route = calls.webRoutes[0]
  const res = { status: 0, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b } }
  route.handler({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }, res)
  assert.equal(res.status, 403)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
