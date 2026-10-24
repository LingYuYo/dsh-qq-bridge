/**
 * 回归用例：guard 必须在 **qq-chat preset 的真实 cordis 作用域**里生效。
 *
 * 2026-10-24 事故（P0）：线上 QQ 会话的 request/header 里 35 个工具全在、
 * 没有 qq_send_voice、system 还是全局 Harness 提示词。根因是 `applyGuard()`
 * 开头的判定写成了 `agentPresets.composedPreset(ctx)`：
 *
 *   dsh-agent-preset-registry 的 generationFor(ctx) =
 *     `generations.get(scopeParentOf(scopeOf(ctx)))`
 *   而 preset 生成作用域是 `createScope(owner, {})`（key **没有 parent**），
 *   `scopeParentOf(key) === undefined` ⇒ 在 preset 子行的 ctx 上
 *   composedPreset() 恒为 undefined ⇒ applyGuard 直接 return，
 *   人设 section / qq_send_voice / restrict / guard 全部没跑。
 *
 * 只有 agent.ctx 先被 `bindScopeParent(agentKey, generation.key)` 绑过，
 * composedPreset() 才查得到——所以旧判据在 agent 侧看起来是对的，
 * 在 guard 自己的 ctx 上却是恒假的。
 *
 * 本文件用**真实 DSH 包 + 真实 cordis 宿主**（真 Context / 真 dsh-tools /
 * 真 dsh-system-prompt / 真 cordis-plugin-loader / 真 dsh-agent-preset-registry，
 * 走 registry.register → activate → mountPreset 的完整装载路径）跑一遍 preset，
 * 把这些结论钉死：
 *   · composedPreset(presetCtx) === undefined（原判据失效的根因，锁死）
 *   · scopeOf(presetCtx) 有值、scopeParentOf(generation.key) === undefined
 *   · 当前 index.js 的 detectPresetScope 判据在 preset 内为真、在 profile 顶层为假，
 *     且 restrict 抛**非预期错误**时必须 fail-closed（不误判成 preset）
 *   · assemble({scope}) / assemble({agent, scope: agentKey}) 只剩
 *     deployment:persona-prefix 一个 complete section，且正文走 section.text()
 *     （带 agent.session.id 时单人设覆盖生效）
 *   · tools.schemas(presetScope) 里有 qq_send_voice、parameters 根是合法 JSON Schema、
 *     deny 名单里的全局工具不可见
 *   · 执行期 guard 拒绝 ops_bash、放行 qq_send_voice
 *   · 同一个插件装在 profile 顶层（未 scoped）仍然拒绝挂 guard
 *
 * 运行：
 *   QQG_DSH_MODULES=<含 @deepseek-ai/* 的 node_modules 目录> \
 *     node plugins/dsh-qq-guard/test-preset-scope.mjs
 *
 * 找不到 DSH 包（纯离线环境 / 仓库里没有这些依赖）时打印 SKIP 并 exit 0——
 * 不允许因为缺包把回归测试跑红。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PERSONA = 'PERSONA-FROM-PRESET：你是群友，别用助手腔。'
const GLOBAL_PROMPT = 'GLOBAL HARNESS PROMPT — 不该出现在 QQ 会话里'
const DENY_SAMPLE = ['ops_bash', 'ops_glob', 'spawn_teammate', 'mnemon_recall', 'working_directory', 'pwsh']
const ALLOW_SAMPLE = ['web_search', 'qq_safe_test']
const REQUIRED_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/dsh-agent-preset-registry',
]

/* ───────────────────────── 1. 定位 DSH 包（找不到 = SKIP） ───────────────────────── */

function isModulesRoot(dir) {
  try {
    return REQUIRED_PACKAGES.every((pkg) => fs.existsSync(path.join(dir, pkg, 'package.json')))
  } catch {
    return false
  }
}

function normalizeModulesRoot(raw) {
  if (!raw) return undefined
  let dir = path.resolve(raw)
  if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir)
  for (let i = 0; i < 3 && dir && dir !== path.dirname(dir); i++) {
    if (isModulesRoot(dir)) return dir
    const nested = path.join(dir, 'node_modules')
    if (isModulesRoot(nested)) return nested
    if (path.basename(dir) === '@deepseek-ai') dir = path.dirname(path.dirname(dir))
    else break
  }
  return undefined
}

const CANDIDATES = [
  process.env.QQG_DSH_MODULES,
  process.env.DSH_NODE_MODULES,
  path.join(HERE, 'node_modules'),
  path.resolve(HERE, '../../node_modules'),
].filter(Boolean)

const MODULES_ROOT = CANDIDATES.map(normalizeModulesRoot).find(Boolean)

if (!MODULES_ROOT) {
  console.log('SKIP: 找不到 DSH 包（需要 @deepseek-ai/cordis、dsh-tools、dsh-system-prompt、')
  console.log('      cordis-plugin-loader、dsh-agent-preset-registry、dsh-scope）。')
  console.log('      设 QQG_DSH_MODULES 指向含它们的 node_modules 目录即可运行本用例：')
  console.log('        QQG_DSH_MODULES=D:/path/to/node_modules node plugins/dsh-qq-guard/test-preset-scope.mjs')
  console.log('SKIP（exit 0）')
  process.exit(0)
}

/** 解析一个包的入口文件（读 package.json 的 exports["."]，退回 main）。 */
function packageEntry(root, pkg) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, pkg, 'package.json'), 'utf8'))
  const exportsField = manifest.exports?.['.']
  let rel = typeof exportsField === 'string'
    ? exportsField
    : exportsField?.default ?? exportsField?.import ?? manifest.main ?? 'lib/index.js'
  rel = rel.replace(/^\.\//, '')
  return path.join(root, pkg, rel)
}

const importPkg = (pkg) => import(pathToFileURL(packageEntry(MODULES_ROOT, pkg)).href)

/* ───────────────────────── 2. 装载真实宿主 ───────────────────────── */

const { Context, Service } = await importPkg('@deepseek-ai/cordis')
const { scopeOf, scopeParentOf, createScope } = await importPkg('@deepseek-ai/dsh-scope')
const SystemPrompt = (await importPkg('@deepseek-ai/dsh-system-prompt')).default
const ToolRuntime = (await importPkg('@deepseek-ai/dsh-tools')).default
const Loader = (await importPkg('@deepseek-ai/cordis-plugin-loader')).default
const AgentPresetRegistry = (await importPkg('@deepseek-ai/dsh-agent-preset-registry')).default

let pass = 0
let fail = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    pass++
  } catch (error) {
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
    fail++
  }
}

/** 宿主侧服务的占位实现：与本 bug 链路无关（guard 的 guard 分支从不调用它们）。 */
class Stub extends Service {
  constructor(ctx, name) { super(ctx, name) }
}
class WebServer extends Stub { constructor(ctx) { super(ctx, 'webServer') } }
class Subprocess extends Stub { constructor(ctx) { super(ctx, 'subprocess') } }
class SessionProjections extends Stub {
  constructor(ctx) {
    super(ctx, 'sessionProjections')
    this.definitions = new Map()
  }
  register(definition) {
    this.definitions.set(definition.key, definition)
    return () => this.definitions.delete(definition.key)
  }
  stateOf() { return null }
}

/** 最小可注册工具定义（只用于占满全局工具面，不执行）。 */
function toolDefinition(name) {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [],
    },
    async execute() { return {} },
  }
}

/** 装载 guard 源码。临时副本放在本目录：相对 import 与 cordis.patch.yml 都照常可用。 */
async function loadGuard() {
  const source = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')
  const schemastery = [
    path.join(HERE, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
    path.join(MODULES_ROOT, '@deepseek-ai/schemastery/lib/index.mjs'),
  ].find((candidate) => fs.existsSync(candidate))
  if (!schemastery) throw new Error('找不到 @deepseek-ai/schemastery（guard 的静态依赖）')
  const patched = source.replace(
    /^import Schema from '@deepseek-ai\/schemastery'$/m,
    `import Schema from ${JSON.stringify(pathToFileURL(schemastery).href)}`,
  )
  if (patched === source) throw new Error('index.js 里找不到 schemastery 的 import 行，源码结构变了')
  const tmpFile = path.join(HERE, `.tmp-preset-scope-${process.pid}.mjs`)
  fs.writeFileSync(tmpFile, patched)
  try {
    return await import(pathToFileURL(tmpFile).href)
  } finally {
    try { fs.unlinkSync(tmpFile) } catch { /* 忽略 */ }
  }
}

const guardModule = await loadGuard()

/* ───────────────────────── 3. 建宿主 + 真实 mountPreset ───────────────────────── */

const consoleLines = { warn: [], info: [] }
const originals = { warn: console.warn, info: console.info }
// 只在内存里收集：guard 在初始装载时会为「尚未注册」的工具打一串 info，全部转发会淹没断言。
console.warn = (...args) => { consoleLines.warn.push(args.map(String).join(' ')) }
console.info = (...args) => { consoleLines.info.push(args.map(String).join(' ')) }

const root = new Context()
// 真实宿主由 host runner 在 root ctx 上设 baseUrl；preset 子树靠继承它解析行名。
root.baseUrl = pathToFileURL(HERE + path.sep).href

await root.plugin(WebServer)
await root.plugin(Subprocess)
await root.plugin(SessionProjections)
await root.plugin(SystemPrompt, {
  includeHarnessIdentity: true,
  includeRuntimeContext: true,
  personaPrefix: GLOBAL_PROMPT,
  personaSuffix: 'GLOBAL SUFFIX',
})
await root.plugin(ToolRuntime, { mode: 'native' })
await root.plugin(Loader, { baseUrl: root.baseUrl })
await root.plugin(AgentPresetRegistry, { default: 'qq-chat', selectedDefault: 'qq-chat' })

const registry = root.agentPresets
const tools = root.tools
const systemPrompt = root.systemPrompt

// 全局层（profile 顶层）注册的工具：guard 的 restrict 就该从这里隐藏它们。
for (const name of [...DENY_SAMPLE, ...ALLOW_SAMPLE]) tools.register(toolDefinition(name))

// 行名用绝对 file: URL，避免依赖宿主 profile 的 node_modules 链接方式。
const guardRowName = pathToFileURL(path.join(HERE, 'index.js')).href
await registry.register({
  id: 'qq-chat',
  plugins: [{ id: 'qq-guard', name: guardRowName, config: { role: 'guard', personaDefault: PERSONA } }],
})

const generation = [...registry.generations.values()].find((g) => g.mount.presetId === 'qq-chat')
const entry = generation === undefined
  ? undefined
  : [...generation.mount.tree.entries()].find((item) => item.options?.name === guardRowName)
const presetCtx = entry?.fiber?.ctx

console.log('— 真实宿主 + 真实 mountPreset —')
await check('qq-chat preset 真实装载成功（generation 存在）', () => {
  assert.ok(generation !== undefined, 'preset 没装载成功')
})
await check('guard 行由真实 Loader 装载并激活（fiber 存在）', () => {
  assert.ok(entry?.fiber !== undefined, 'guard 行没有激活（fiber 为 undefined）')
})

console.log('\n— 作用域事实：为什么 composedPreset 在 preset 子行上恒为 undefined —')
await check('scopeOf(guard ctx) 有值（它确实在 preset 作用域里）', () => {
  assert.notEqual(scopeOf(presetCtx), undefined)
})
await check('scopeOf(guard ctx) === generation.key', () => {
  assert.equal(scopeOf(presetCtx), generation.key)
})
await check('scopeParentOf(generation.key) === undefined（preset 生成作用域是根，没有 parent）', () => {
  assert.equal(scopeParentOf(generation.key), undefined)
})
await check('composedPreset(guard ctx) === undefined ← 旧判据失效的根因（锁死）', () => {
  assert.equal(registry.composedPreset(presetCtx), undefined)
})
let agentScopeCtx
let agentScopeKey
await check('对照：agent ctx 被 bindScopeParent 到 generation 后 composedPreset 才返回 qq-chat', () => {
  const agentScope = createScope(root, { tag: 'agent-key' })
  agentScopeCtx = agentScope.ctx
  agentScopeKey = scopeOf(agentScope.ctx)
  registry.join(agentScopeCtx, agentScopeKey, generation)
  assert.equal(registry.composedPreset(agentScopeCtx), 'qq-chat')
  assert.equal(scopeParentOf(agentScopeKey), generation.key)
})

console.log('\n— detectPresetScope 判据：preset 内为真、profile 顶层为假 —')
await check('preset 内没有早退警告（applyGuard 没有在判定处 return）', () => {
  const early = consoleLines.warn.find((line) => line.includes('role=guard 但当前不在任何 agent preset 作用域内'))
  assert.equal(early, undefined, `出现早退警告：${early}`)
})
await check('preset 内有「作用域判定通过」日志', () => {
  assert.ok(consoleLines.info.some((line) => line.includes('role=guard 作用域判定通过')))
})

console.log('\n— 系统提示词：complete 人设 section 生效 —')
const scopedAssembly = await systemPrompt.assemble({ scope: generation.key })
await check('assemble({scope: gen.key}) 只剩一个 section', () => {
  assert.deepEqual(scopedAssembly.sections.map((section) => section.name), ['deployment:persona-prefix'])
})
await check('人设正文来自 preset 的 personaDefault', () => {
  assert.ok(String(scopedAssembly.sections[0]?.text ?? '').includes(PERSONA))
})
await check('全局 Harness 提示词没有穿透进 QQ 会话', () => {
  assert.ok(!String(scopedAssembly.sections[0]?.text ?? '').includes(GLOBAL_PROMPT))
})
await check('全局视角不受影响（3 个全局 section 仍在）', async () => {
  assert.deepEqual((await systemPrompt.assemble({})).sections.map((section) => section.name), [
    'harness:identity',
    'deployment:persona-prefix',
    'deployment:persona-suffix',
  ])
})

console.log('\n— 人设正文走 section.text()（assemble 的 context 要能拿到 agent.session.id）—')
// 必须用 Loader 真实装载的那个模块实例（entry.moduleNamespace）：personaState 是模块级状态，
// 临时副本 guardModule 是另一个实例，改它不会影响 preset 里跑着的 guard。
const guardNs = entry.moduleNamespace ?? guardModule
const sessionId = 'sess-preset-scope-test'
await check('带 agent.session.id → 单人设覆盖生效', async () => {
  assert.equal(typeof guardNs.setSessionPersonaText, 'function', 'guard 没有导出 setSessionPersonaText')
  assert.equal(typeof guardNs.setGlobalPersonaText, 'function', 'guard 没有导出 setGlobalPersonaText')
  guardNs.setSessionPersonaText(sessionId, 'SESSION-OVERRIDE：单人设')
  guardNs.setGlobalPersonaText('GLOBAL-OVERRIDE：全局人设')
  const assembly = await systemPrompt.assemble({ scope: generation.key, agent: { session: { id: sessionId } } })
  assert.equal(assembly.sections.length, 1)
  assert.ok(String(assembly.sections[0]?.text ?? '').includes('SESSION-OVERRIDE'))
})
await check('不带 agent → 回落全局人设（不是 Harness 自述）', async () => {
  const assembly = await systemPrompt.assemble({ scope: generation.key })
  assert.equal(assembly.sections.length, 1)
  assert.ok(String(assembly.sections[0]?.text ?? '').includes('GLOBAL-OVERRIDE'))
})
await check('清空覆盖后回落到 preset 的 personaDefault', async () => {
  guardNs.setGlobalPersonaText('')
  guardNs.setSessionPersonaText(sessionId, '')
  const assembly = await systemPrompt.assemble({ scope: generation.key })
  assert.ok(String(assembly.sections[0]?.text ?? '').includes(PERSONA))
})
await check('生产形态：assemble({agent, scope: agentKey}) 也能沿 scope 链拿到人设 section', async () => {
  // dsh-agent 的 assembleContextFor: { agent, scope: agent }，agent 自己的对象就是 scope key，
  // 链上挂着 generation.key。section 注册在 generation 层，合并时沿链取到。
  const assembly = await systemPrompt.assemble({
    scope: agentScopeKey,
    agent: { session: { id: sessionId } },
  })
  assert.equal(assembly.sections.length, 1)
  assert.equal(assembly.sections[0]?.name, 'deployment:persona-prefix')
  assert.ok(String(assembly.sections[0]?.text ?? '').includes(PERSONA))
})

console.log('\n— 工具 schema 面：restrict 生效 + qq_send_voice 注册 —')
const scopedSchemas = tools.schemas(generation.key).map((schema) => schema.name)
await check('preset 视角出现 qq_send_voice', () => {
  assert.ok(scopedSchemas.includes('qq_send_voice'), `实际 schema：${scopedSchemas.join(', ')}`)
})
await check('qq_send_voice.parameters 根是合法 JSON Schema 对象（type:"object" + required:["text"]）', () => {
  const voice = tools.schemas(generation.key).find((schema) => schema.name === 'qq_send_voice')
  const parameters = voice?.parameters
  assert.equal(parameters?.type, 'object')
  assert.equal(parameters?.properties?.text?.type, 'string')
  assert.ok(Array.isArray(parameters?.required) && parameters.required.includes('text'), 'required 应含 text')
  assert.equal(parameters?.properties?.voice?.type, 'string')
})
await check('deny 名单里的全局工具全部被隐藏', () => {
  const leaked = DENY_SAMPLE.filter((name) => scopedSchemas.includes(name))
  assert.deepEqual(leaked, [], `仍可见：${leaked.join(', ')}`)
})
await check('未进 deny 名单的全局工具不受影响', () => {
  assert.deepEqual(ALLOW_SAMPLE.filter((name) => !scopedSchemas.includes(name)), [])
})
await check('restrict 没有溢出到全局层', () => {
  const rootSchemas = tools.schemas(undefined).map((schema) => schema.name)
  assert.deepEqual(DENY_SAMPLE.filter((name) => !rootSchemas.includes(name)), [])
})

console.log('\n— 执行期 guard —')
await check('ops_bash 在执行期被白名单拒绝', () => {
  const reason = tools.guardReason({ name: 'ops_bash', agent: generation.key })
  assert.equal(typeof reason, 'string')
  assert.ok(reason.includes('白名单'), `拒绝原因不对：${reason}`)
})
await check('qq_send_voice 在执行期放行（默认 sk-voice 开启）', () => {
  assert.equal(tools.guardReason({ name: 'qq_send_voice', agent: generation.key }), undefined)
})

console.log('\n— profile 顶层（未 scoped）装载仍然拒绝挂 guard —')
const topWarnBefore = consoleLines.warn.length
await root.plugin(guardModule, { role: 'guard', personaDefault: PERSONA })
await check('同一个插件装在顶层被拒绝（有明确 warn）', () => {
  const warned = consoleLines.warn.slice(topWarnBefore)
    .find((line) => line.includes('role=guard 但当前不在任何 agent preset 作用域内'))
  assert.ok(warned !== undefined, '顶层没有拒绝装载的警告')
})
await check('顶层没有安装全局 guard（全局层 guardReason === undefined）', () => {
  assert.equal(tools.guardReason({ name: 'ops_bash' }), undefined)
})
await check('顶层装载后全局工具面不变（ops_bash 仍可见）', () => {
  assert.ok(tools.schemas(undefined).map((schema) => schema.name).includes('ops_bash'))
})

console.log('\n— 「是否 scoped」探针契约（检测方案依赖它，锁死）—')
const probe = (ctx) => {
  try {
    ctx.tools.restrict({})
    return 'no-throw'
  } catch (error) {
    const message = String(error?.message ?? error)
    if (message.includes('requires a scoped context')) return 'UNSCOPED'
    if (message.includes('no-op')) return 'SCOPED'
    return `other:${message}`
  }
}
await check('scoped ctx 与 unscoped ctx 的 restrict 报错可区分', () => {
  assert.equal(probe(presetCtx), 'SCOPED')
  assert.equal(probe(root), 'UNSCOPED')
})
await check('探针不改变工具面', () => {
  assert.deepEqual(tools.schemas(generation.key).map((schema) => schema.name), scopedSchemas)
})

console.log('\n— fail-closed 兜底：restrict 抛非预期错误时不得误判成 preset —')
const originalRestrict = ToolRuntime.prototype.restrict
ToolRuntime.prototype.restrict = function simulatedDrift() {
  throw new Error('simulated DSH drift: unexpected restrict failure')
}
try {
  const topWarnBeforeDrift = consoleLines.warn.length
  await root.plugin(guardModule, { role: 'guard', personaDefault: PERSONA })
  await check('未知错误 → 拒绝装载（不挂全局 guard）', () => {
    const warned = consoleLines.warn.slice(topWarnBeforeDrift)
      .find((line) => line.includes('role=guard 但当前不在任何 agent preset 作用域内'))
    assert.ok(warned !== undefined, '未知错误被误判成 preset（fail-open）')
    assert.ok(warned.includes('simulated DSH drift'), 'warn 里应带上原始错误信息')
  })
  await check('没有安装全局 guard', () => {
    assert.equal(tools.guardReason({ name: 'ops_bash' }), undefined)
  })
} finally {
  ToolRuntime.prototype.restrict = originalRestrict
}

console.warn = originals.warn
console.info = originals.info

// 失败时把收集到的日志尾巴倒出来，方便定位（通过时不刷屏）。
if (fail > 0) {
  for (const line of consoleLines.warn.slice(-8)) console.log(`  [warn] ${line}`)
  for (const line of consoleLines.info.slice(-8)) console.log(`  [info] ${line}`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败${fail === 0 ? '' : '（guard 在 preset 内的作用域判定又坏了）'}`)
process.exit(fail === 0 ? 0 : 1)
