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
const SM_PATH = resolveSchemastery()
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

/** 造一个假的 ctx，记录所有注册行为。
 *
 * `scoped` 模拟「这个 ctx 是否处在 dsh-scope 的作用域里」：
 *   · preset 子行 / agent.ctx → 有 scope；
 *   · profile 顶层行 → 没有 scope。
 * 真实 DSH 的 `tools.restrict()` 第一行就检查 scope：无 scope 抛
 * "requires a scoped context"，有 scope 才继续校验工具名（假名字 →
 * "names unknown global tool"）。guard 的「我到底在不在 preset 里」判定就靠
 * 这个差异（见 index.js detectPresetScope），所以假 ctx 必须照着抛。
 */
function makeCtx({ presetId, scoped = presetId !== undefined, hasWebServer = false, settingsAvailable = false, hasSubprocess = false, systemPrompt = undefined } = {}) {
  const calls = { restrict: 0, guard: 0, guardFn: null, registeredTools: [], webRoutes: [], effects: [], inj: [], warn: [] }
  const ctx = {
    get(name) {
      if (name === 'agentPresets') {
        return { composedPreset: () => presetId }
      }
      if (name === 'systemPrompt') return systemPrompt
      return undefined
    },
    on() { return () => {} },
    effect(fn) { calls.effects.push(fn); try { fn() } catch { /* 忽略 */ } return () => {} },
    inject(deps, fn) {
      calls.inj.push(fn)
      // systemPrompt 是全局服务：这里模拟「注入成功后拿到子 ctx」。
      if (Array.isArray(deps) && deps.includes('systemPrompt') && systemPrompt) {
        fn({
          get: (name) => (name === 'systemPrompt' ? systemPrompt : ctx.get(name)),
          effect: ctx.effect,
          inject: ctx.inject,
        })
      } else if (settingsAvailable) fn(makeSettingsCtx(calls))
    },
    tools: {
      restrict(filter) {
        // 与 @deepseek-ai/dsh-tools 的真实顺序一致：先 scope、后工具名。
        if (!scoped) {
          throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent')
        }
        const names = [...(filter?.allow ?? []), ...(filter?.deny ?? [])]
        const unknown = names.filter((n) => n.startsWith('__'))
        if (unknown.length > 0) {
          throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map((n) => `"${n}"`).join(', ')}`)
        }
        calls.restrict++
        return () => {}
      },
      guard(fn) { calls.guard++; calls.guardFn = fn },
      register(definition) { calls.registeredTools.push(definition); return () => {} },
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
    // 这个假 ctx 同时被当作 `sessionPersistence` 等注入服务的 ctx 用：
    // 真 ctx 一定有 get()，而用量回填的 2.5s 定时器会去 `persistenceCtx.get(...)`，
    // 少了它就会在测试跑完之后抛 uncaughtTypeError（2026-10-24 踩到）。给个空实现。
    get() { return undefined },
    settings: {
      configure() { calls.effects.push('configure'); return () => {} },
      // 网页搜索凭据同步会调 settings.update(ns, section)；假实现按需记账即可。
      update(ns) { calls.settingsUpdates = calls.settingsUpdates ?? []; calls.settingsUpdates.push(ns); return Promise.resolve() },
    },
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
// ★ 2026-10-24 P0 回归：真机上 preset 子行的 composedPreset() **恒为 undefined**
//   （generationFor 找的是 scopeOf(ctx) 的父 scope，而子行 ctx 的作用域就是 generation
//   本身），旧实现据此判定「不在 preset」直接 return，人设/语音工具/restrict 全没跑。
//   新判定用 restrict 的 scoped 错误区分，所以这条必须挂载成功。
await check('preset 子行（composedPreset=undefined 但 ctx 有 scope）→ 仍然挂载（P0 回归）', () => {
  const { ctx, calls } = makeCtx({ presetId: undefined, scoped: true })
  apply(ctx, Config({ role: 'guard' }))
  assert.equal(calls.guard, 1, '★ 有 scope 就是 preset 内，必须挂 guard')
  assert.ok(calls.restrict > 0, '人设/语音工具不该被这层判定拦下')
  const tool = calls.registeredTools.find((t) => t.name === 'qq_send_voice')
  assert.ok(tool, '★ 真机症状之一：qq_send_voice 没注册上来')
})
await check('无 scope 且 composedPreset=undefined → 仍拒绝（顶层事故防线不放松）', () => {
  const { ctx, calls } = makeCtx({ presetId: undefined, scoped: false })
  apply(ctx, Config({ role: 'guard' }))
  assert.equal(calls.guard, 0, '顶层依然不许挂')
  assert.equal(calls.restrict, 0)
  assert.equal(calls.registeredTools.length, 0, '顶层也不该注册 qq_send_voice')
})

console.log('\n— 分派：role=settings 只做设置面 —')
await check('role=settings 有 webServer → 注册全部设置面路由，且不挂 guard', () => {
  const { ctx, calls } = makeCtx({ presetId: undefined, hasWebServer: true, settingsAvailable: true, hasSubprocess: true })
  apply(ctx, Config({ role: 'settings' }))
  assert.equal(calls.guard, 0, '★ settings 实例绝不能挂 guard')
  assert.equal(calls.restrict, 0)
  const paths = calls.webRoutes.map((r) => r.path).sort()
  assert.deepEqual(paths, [
    '/dsh-qq-guard/bridge',
    // 清理 QQ 工作区里的失效会话（Phase 4）
    '/dsh-qq-guard/cleanup-sessions',
    '/dsh-qq-guard/config',
    // 只读扫描外部插件目录（Phase 4）
    '/dsh-qq-guard/external-plugins',
    // P1：外部插件沙箱加载测试
    '/dsh-qq-guard/external-plugins/test',
    '/dsh-qq-guard/napcat',
    // NapCat 登录二维码截图（qrcode.png → 浏览器）
    '/dsh-qq-guard/napcat-qr',
    // 单人设覆盖（桥接每条消息前 POST；guard 实例动态 section 现读）
    '/dsh-qq-guard/persona',
    // 原生目录选择器（NapCat 安装目录的「浏览」按钮）
    '/dsh-qq-guard/pick-dir',
    // 会话指令队列（清空 / 删除 / 单人设；桥接 2 秒轮询）
    '/dsh-qq-guard/session-ops',
    '/dsh-qq-guard/status',
    // 真实用量统计（数据与用量面板）+ 历史回填
    '/dsh-qq-guard/usage',
    '/dsh-qq-guard/usage/backfill',
  ], `路由应为 13 条，实际 ${JSON.stringify(paths)}`)
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
await check('GET /config 带 features（桥接与 guard 共用同一份开关判断）', () => {
  const { ctx, calls } = makeCtx({ presetId: undefined, hasWebServer: true, settingsAvailable: true })
  apply(ctx, Config({ role: 'settings' }))
  const route = calls.webRoutes[0]
  const res = { status: 0, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b } }
  route.handler({ method: 'GET', headers: {} }, res)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.config.features.voice, true)
  assert.equal(parsed.config.features.vision, true)
  assert.equal(parsed.config.features.search, true)
  assert.equal(parsed.config.features.guard, true)
})
await check('跨站请求被拒（sec-fetch-site）', async () => {
  const { ctx, calls } = makeCtx({ presetId: undefined, hasWebServer: true, settingsAvailable: true })
  apply(ctx, Config({ role: 'settings' }))
  const route = calls.webRoutes[0]
  const res = { status: 0, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b } }
  route.handler({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }, res)
  assert.equal(res.status, 403)
})

console.log('\n— 会话上报字段白名单（漏字段 = 设置页静默失效）—')
await check('sanitizeSessionRow：activityLevel 保留 0 与 null 的区别', () => {
  const { sanitizeSessionRow } = mod
  const zero = sanitizeSessionRow({ key: 'g:1', activityLevel: 0 })
  assert.equal(zero.activityLevel, 0, '0 档（仅艾特）必须能上报')
  const three = sanitizeSessionRow({ key: 'g:1', activityLevel: 3 })
  assert.equal(three.activityLevel, 3)
  const follow = sanitizeSessionRow({ key: 'g:1', activityLevel: null })
  assert.equal(follow.activityLevel, null, 'null = 跟随全局，不能退化成 0')
  assert.equal(sanitizeSessionRow({ key: 'g:1' }).activityLevel, null, '缺省也是 null')
  assert.equal(sanitizeSessionRow({ key: 'g:1', activityLevel: 9 }).activityLevel, null, '越界按未配置')
  assert.equal(sanitizeSessionRow({ key: 'g:1', activityLevel: 1.5 }).activityLevel, null, '非整数拒绝')
})
await check('sanitizeSessionRow：persona 原样保留换行且截断', () => {
  const { sanitizeSessionRow } = mod
  const row = sanitizeSessionRow({ key: 'u:1', persona: '第一行\n第二行' })
  assert.equal(row.persona, '第一行\n第二行', '单人设回填不能被压成单行')
  assert.equal(sanitizeSessionRow({ key: 'u:1' }).persona, '')
  assert.equal(sanitizeSessionRow({ key: 'u:1', persona: 'x'.repeat(30000) }).persona.length, 20000)
})
await check('POST /status 会话行带 activityLevel（端到端不丢）', async () => {
  const { ctx, calls } = makeCtx({ presetId: undefined, hasWebServer: true, settingsAvailable: true })
  apply(ctx, Config({ role: 'settings' }))
  const route = calls.webRoutes.find((r) => r.path === '/dsh-qq-guard/status')
  assert.ok(route, '没有注册 status 路由')
  const payload = JSON.stringify({
    qqState: 'online',
    sessions: [{ key: 'g:123456', kind: 'group', qq: '123456', activityLevel: 2, persona: '单人设' }],
  })
  const req = {
    method: 'POST', headers: {},
    on(evt, fn) {
      if (evt === 'data') fn(Buffer.from(payload))
      if (evt === 'end') fn()
    },
  }
  const res = { status: 0, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b } }
  route.handler(req, res)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(res.status, 200)
  const getRes = { status: 0, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b } }
  route.handler({ method: 'GET', headers: {} }, getRes)
  const parsed = JSON.parse(getRes.body)
  const row = parsed.status.sessions.find((s) => s.key === 'g:123456')
  assert.ok(row, 'status 里应有这条会话')
  assert.equal(row.activityLevel, 2, '★ 档位必须在 Host 侧存活')
  assert.equal(row.persona, '单人设', '★ 单人设回填也要存活')
})

console.log('\n— 动态人设 section（替代 preset 里的静态 persona 行）—')
await check('guard 注册 deployment:persona-prefix，complete:true + 动态 text', () => {
  const sections = []
  const fakePrompt = {
    section(spec) { sections.push(spec); return () => {} },
    getSectionOrder() { return 0 },
    suppressRuntimeContext() { sections.push('suppress'); return () => {} },
  }
  const { ctx } = makeCtx({ presetId: 'qq-chat', systemPrompt: fakePrompt })
  apply(ctx, Config({ role: 'guard', personaDefault: '默认人设正文' }))
  const section = sections.find((s) => typeof s === 'object' && s.name === 'deployment:persona-prefix')
  assert.ok(section, '没有注册 persona section')
  assert.equal(section.complete, true, '必须是 complete section（唯一系统提示词）')
  assert.equal(typeof section.text, 'function', 'text 必须是函数才能按会话动态')
  assert.equal(section.text({ agent: { session: { id: 's-other' } } }), '默认人设正文', '没单人设时回落到 personaDefault')
  assert.ok(sections.includes('suppress'), '应关掉运行时上下文注入')
})
await check('单人设覆盖优先；清空后回退全局/默认', () => {
  const sections = []
  const fakePrompt = {
    section(spec) { sections.push(spec); return () => {} },
    getSectionOrder() { return 0 },
    suppressRuntimeContext() { return () => {} },
  }
  const { ctx } = makeCtx({ presetId: 'qq-chat', systemPrompt: fakePrompt })
  apply(ctx, Config({ role: 'guard', personaDefault: '默认人设正文' }))
  const section = sections.find((s) => typeof s === 'object' && s.name === 'deployment:persona-prefix')
  mod.setGlobalPersonaText('全局人设')
  mod.setSessionPersonaText('g:123456', '群专属人设')
  assert.equal(section.text({ agent: { session: { id: 'g:123456' } } }), '群专属人设')
  assert.equal(section.text({ agent: { session: { id: 'u:1' } } }), '全局人设')
  mod.setSessionPersonaText('g:123456', '')
  assert.equal(section.text({ agent: { session: { id: 'g:123456' } } }), '全局人设')
  mod.setGlobalPersonaText('')
  assert.equal(section.text({ agent: { session: { id: 'u:1' } } }), '默认人设正文')
})

console.log('\n— Phase 6：技能/插件开关 → 工具门禁真实响应 —')
await check('itemEnabledIn：没配置数组时用默认清单（技能默认开启）', () => {
  const cfg = Config({ role: 'settings' })
  assert.equal(mod.itemEnabledIn(cfg, 'sk-voice'), true)
  assert.equal(mod.itemEnabledIn(cfg, 'pl-guard', 'plugin'), true)
})
await check('itemEnabledIn：配置了数组就以数组为准，删掉 = 关闭', () => {
  const cfg = Config({
    role: 'settings',
    skills: [{ id: 'sk-voice', name: '发语音', enabled: false }],
    plugins: [{ id: 'pl-guard', name: '工具门禁', enabled: true }],
  })
  assert.equal(mod.itemEnabledIn(cfg, 'sk-voice'), false)
  assert.equal(mod.itemEnabledIn(cfg, 'sk-search'), false, '数组里没有 = 用户删了 = 关闭')
  assert.equal(mod.itemEnabledIn(cfg, 'pl-guard', 'plugin'), true)
})
await check('readFeatureFlags：把开关聚合成桥接/guard 共用的布尔', () => {
  const cfg = Config({ role: 'settings' })
  const flags = mod.readFeatureFlags(cfg)
  assert.deepEqual(flags, {
    voice: true, vision: true, search: true, guard: true, debounce: true, rateLimit: true,
  })
})
await check('guard：网页搜索开启 → web_search 放行；关闭 → 执行期拒绝', () => {
  const { ctx, calls } = makeCtx({ presetId: 'qq-chat' })
  mod.bindFeatureConfigSource(Config({ role: 'settings' }))
  apply(ctx, Config({ role: 'guard' }))
  assert.equal(calls.guardFn({ name: 'web_search' }), undefined, '技能开启时应放行')
  assert.equal(calls.guardFn({ name: 'web_fetch' }), undefined)

  mod.bindFeatureConfigSource(Config({
    role: 'settings',
    skills: [{ id: 'sk-search', name: '网页搜索', enabled: false }],
  }))
  assert.match(String(calls.guardFn({ name: 'web_search' })), /网页搜索/, '关掉后必须执行期拒绝')
})
await check('guard：工具门禁插件关闭 → 不再做 deny-by-default 拦截', () => {
  const { ctx, calls } = makeCtx({ presetId: 'qq-chat' })
  mod.bindFeatureConfigSource(Config({
    role: 'settings',
    plugins: [{ id: 'pl-guard', name: '工具门禁', enabled: false }],
  }))
  apply(ctx, Config({ role: 'guard' }))
  assert.equal(calls.guardFn({ name: 'ops_bash' }), undefined, '开关关闭 = 用户明确放弃执行期白名单')
  // 恢复默认，避免污染后续用例
  mod.bindFeatureConfigSource(null)
})
await check('qq_send_voice 注册在 preset 作用域（guard 实例自己注册，不是全局）', () => {
  const { ctx, calls } = makeCtx({ presetId: 'qq-chat' })
  apply(ctx, Config({ role: 'guard' }))
  const tool = calls.registeredTools.find((t) => t.name === 'qq_send_voice')
  assert.ok(tool, '没有注册 qq_send_voice')
  assert.equal(typeof tool.execute, 'function')
  // ★ 2026-10-24 修复：parameters 必须是**合法 JSON Schema**（根 type:"object" + properties），
  //   不能再是手写的「属性名 → spec」裸对象 —— 那样模型侧 schema 没有根 type，
  //   工具虽然注册了却不会出现在 request/header 的工具清单里。
  assert.equal(tool.parameters?.type, 'object', 'parameters 根必须是 object')
  assert.ok(tool.parameters.properties?.text, '参数里应有 text')
  assert.deepEqual(tool.parameters.required, ['text'], 'text 应为必填')
  assert.equal(tool.parameters.properties.text.type, 'string')
  // output.schema 同理必须可被 assertSupportedJsonSchema 接受。
  assert.equal(tool.output?.schema?.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, false)
  assert.equal(typeof tool.output.render, 'function')
})
await check('qq_send_voice：技能关闭 → 执行抛错且不入队', async () => {
  mod.bindFeatureConfigSource(Config({
    role: 'settings',
    skills: [{ id: 'sk-voice', name: '发语音', enabled: false }],
  }))
  const { ctx, calls } = makeCtx({ presetId: 'qq-chat' })
  apply(ctx, Config({ role: 'guard' }))
  const tool = calls.registeredTools.find((t) => t.name === 'qq_send_voice')
  const before = mod.sessionOpsSnapshot().queued
  await assert.rejects(() => tool.execute({ text: '你好' }, { agent: { id: 's-1' } }), /发语音/)
  assert.equal(mod.sessionOpsSnapshot().queued, before, '关掉的技能不该入队')
})
await check('qq_send_voice：开启 → 入队 + 等桥接回执成功', async () => {
  mod.bindFeatureConfigSource(Config({ role: 'settings' }))
  const { ctx, calls } = makeCtx({ presetId: 'qq-chat' })
  apply(ctx, Config({ role: 'guard' }))
  const tool = calls.registeredTools.find((t) => t.name === 'qq_send_voice')
  const before = mod.sessionOpsSnapshot().queued
  const pending = tool.execute({ text: '你好呀' }, { agent: { id: 'session-abc' } })
  // 等入队落定，再从队列里拿到 id 模拟桥接回执（真实路径是 session-ops 的 results POST）。
  const opId = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const ids = mod.sessionOpsSnapshot().ids
      if (ids.length > before) { clearInterval(timer); resolve(ids[ids.length - 1]) }
    }, 5)
  })
  assert.ok(opId, '应该拿到会话指令 id')
  mod.settleSessionOpResult(opId, { ok: true, detail: '已发送语音（baidu，16KB，via=base64，retcode=0）' })
  const value = await pending
  assert.equal(value.queued, true)
  assert.equal(value.sent, true, '★ 只有桥接真的发出去才算成功')
  assert.match(String(value.detail), /已发送语音/)
  assert.equal(value.chars, 3)
  mod.bindFeatureConfigSource(null)
})
await check('qq_send_voice：桥接回执失败 → 工具抛错（不再假装成功）', async () => {
  mod.bindFeatureConfigSource(Config({ role: 'settings' }))
  const { ctx, calls } = makeCtx({ presetId: 'qq-chat' })
  apply(ctx, Config({ role: 'guard' }))
  const tool = calls.registeredTools.find((t) => t.name === 'qq_send_voice')
  const before = mod.sessionOpsSnapshot().queued
  const pending = tool.execute({ text: '再说一句' }, { agent: { id: 'session-def' } })
  const opId = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const ids = mod.sessionOpsSnapshot().ids
      if (ids.length > before) { clearInterval(timer); resolve(ids[ids.length - 1]) }
    }, 5)
  })
  mod.settleSessionOpResult(opId, { ok: false, detail: '语音发送失败（baidu，via=file）：retcode=1404' })
  await assert.rejects(() => pending, /语音发送失败/)
  mod.bindFeatureConfigSource(null)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
