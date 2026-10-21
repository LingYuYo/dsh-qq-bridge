/**
 * Host 侧 Phase 4 路由回归（离线）：
 *   ① /dsh-qq-guard/external-plugins —— 只读扫描、默认全关、@local 跳过
 *   ② /dsh-qq-guard/cleanup-sessions —— 对账并归档 QQ 工作区里的失效会话
 *
 * 用法：node test-host-phase4.mjs
 */
import assert from 'node:assert/strict'
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
  for (const c of candidates) if (fs.existsSync(c)) return c
  console.error('找不到 @deepseek-ai/schemastery；请设 QQG_SCHEMASTERY 指向它的 lib/index.mjs')
  process.exit(2)
}

const SRC = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')
const patched = SRC.replace(
  /^import Schema from '@deepseek-ai\/schemastery'$/m,
  `import Schema from ${JSON.stringify('file:///' + resolveSchemastery().replace(/\\/g, '/'))}`,
)
const tmpFile = path.join(HERE, '.tmp-index-phase4.mjs')
fs.writeFileSync(tmpFile, patched)
let mod
try {
  mod = await import('file:///' + tmpFile.replace(/\\/g, '/'))
} finally {
  fs.unlinkSync(tmpFile)
}

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

/** 假 webServer + 假服务。 */
function makeHarness({ config, services = {} } = {}) {
  const routes = new Map()
  const ctx = {
    webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => {} } },
    subprocess: undefined,
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { return fn() ?? (() => {}) },
    on() { return () => {} },
    inject(_deps, fn) { try { fn(ctx) } catch { /* 设置页服务缺席 */ } },
    get(name) { return services[name] },
  }
  mod.apply(ctx, mod.Config({ role: 'settings', ...(config ?? {}) }))
  return { routes }
}

function call(handler, { method = 'GET', fetchSite = 'same-origin' } = {}) {
  return new Promise((resolve) => {
    const res = {
      status: 0,
      writeHead(status) { this.status = status },
      end(body) { resolve({ status: this.status, body: JSON.parse(String(body)) }) },
    }
    const req = { method, url: '/', headers: fetchSite === undefined ? {} : { 'sec-fetch-site': fetchSite } }
    Promise.resolve(handler(req, res)).catch((e) => resolve({ status: 500, body: { ok: false, detail: String(e) } }))
  })
}

/* ── 临时插件目录 ─────────────────────────────────────────── */
function makePluginDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqg-plugins-'))
  const writePkg = (rel, pkg) => {
    const dir = path.join(root, rel)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  }
  writePkg('dsh-alpha', { name: 'dsh-alpha', version: '1.2.3', description: 'A 插件', dsh: { bundle: { patch: './p.yml' }, client: { platform: 'web' } } })
  writePkg('dsh-beta', { name: 'dsh-beta', version: '0.1.0', description: 'B 插件', dsh: { bundle: { patch: './p.yml' } } })
  writePkg('plain-lib', { name: 'plain-lib', version: '9.9.9', description: '没有 dsh 字段' })
  writePkg('@local/dsh-inner', { name: '@local/dsh-inner', version: '1.0.0', dsh: { client: { platform: 'web' } } })
  writePkg('@scope/dsh-scoped', { name: '@scope/dsh-scoped', version: '2.0.0', dsh: { client: { platform: 'web' } } })
  return root
}

console.log('外部插件扫描：')

await check('scanPluginDir 只收带 dsh 字段的包、跳过 @local 与普通库', () => {
  const dir = makePluginDir()
  const names = mod.scanPluginDir(dir).map((e) => e.name).sort()
  assert.deepEqual(names, ['@scope/dsh-scoped', 'dsh-alpha', 'dsh-beta'],
    `实际 ${JSON.stringify(names)}`)
})

await check('扫描结果带 version / hasClient / hasBundle', () => {
  const dir = makePluginDir()
  const byName = Object.fromEntries(mod.scanPluginDir(dir).map((e) => [e.name, e]))
  assert.equal(byName['dsh-alpha'].version, '1.2.3')
  assert.equal(byName['dsh-alpha'].hasClient, true)
  assert.equal(byName['dsh-alpha'].hasBundle, true)
  assert.equal(byName['dsh-beta'].hasClient, false)
  assert.equal(byName['dsh-beta'].hasBundle, true)
})

await check('路由默认全关，且 @local 不出现在列表里', async () => {
  const dir = makePluginDir()
  const { routes } = makeHarness({ config: { externalPlugins: { dirs: [dir] } } })
  const r = await call(routes.get('/dsh-qq-guard/external-plugins'))
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.scanned, 3)
  assert.equal(r.body.runnable, 3)
  assert.ok(r.body.entries.every((e) => e.enabled === false), '默认必须全关')
  assert.ok(!r.body.entries.some((e) => e.name.startsWith('@local/')), '@local 不该出现')
})

await check('配置里 enabled 的包回显为已开启', async () => {
  const dir = makePluginDir()
  const { routes } = makeHarness({
    config: { externalPlugins: { dirs: [dir], enabled: ['dsh-beta'] } },
  })
  const r = await call(routes.get('/dsh-qq-guard/external-plugins'))
  const beta = r.body.entries.find((e) => e.name === 'dsh-beta')
  const alpha = r.body.entries.find((e) => e.name === 'dsh-alpha')
  assert.equal(beta.enabled, true)
  assert.equal(alpha.enabled, false)
})

await check('目录不存在 → 空列表而不是报错', async () => {
  const { routes } = makeHarness({ config: { externalPlugins: { dirs: [path.join(os.tmpdir(), 'qqg-not-exist-xyz')] } } })
  const r = await call(routes.get('/dsh-qq-guard/external-plugins'))
  assert.equal(r.status, 200)
  assert.equal(r.body.scanned, 0)
})

await check('扫描是只读的：目录内容不变', () => {
  const dir = makePluginDir()
  const before = fs.readdirSync(dir).sort()
  mod.scanPluginDir(dir)
  assert.deepEqual(fs.readdirSync(dir).sort(), before)
})

/* ── QQ Agent 格式（plugin.json / skill.json，BOM 容错）────────── */
/**
 * 摆一个 QQ Agent 形态的应用根：
 *   plugins/<id>/plugin.json、skills/<id>/skill.json，外加坏清单与无清单目录。
 */
function makeAgentRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqg-agent-'))
  const write = (rel, content, { bom = false } = {}) => {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, (bom ? '\uFEFF' : '') + content)
  }
  // 自包含插件：标准字段 + configSchema + 一个非标字段（非标应被丢弃）
  write('plugins/plain-mod/plugin.json', JSON.stringify({
    id: 'plain-mod', name: '纯展示插件', version: '1.2.0', apiVersion: 1,
    category: 'message', description: '自包含模块', author: 'QQ Agent',
    enabledByDefault: true, requires: ['llm.chat'], capabilities: ['demo'],
    permissions: [], entry: 'index.js',
    settings: { reply: '收到', count: 3, on: true, mode: 'b' },
    configSchema: {
      reply: { type: 'string', label: '回复内容', description: '被艾特时回什么。', default: '收到', multiline: true },
      count: { type: 'number', label: '次数', default: 3, min: 1, max: 10, step: 1 },
      on: { type: 'boolean', label: '开关', default: true },
      mode: { type: 'enum', label: '模式', values: ['a', 'b'], default: 'b' },
      token: { type: 'string', label: '令牌', secret: true, default: '' },
      actionEntry: { type: 'action', label: '面板入口', button: '打开', panel: 'p.html' },
      internalNote: { type: 'internal', label: '只说明' },
    },
    settingsUi: { id: 'x', label: '非标', file: 'ui.html' },
  }, null, 2))
  write('plugins/plain-mod/index.js', 'export function setup(api) { api.log("hi") }\n')

  // 依赖 node 原生模块的技能（带 BOM 的 skill.json）
  write('skills/fs-mod/skill.json', JSON.stringify({
    id: 'fs-mod', name: '文件技能', version: '0.3.1',
    category: 'media', description: '用 fs 读写状态', author: 'someone',
    entry: 'index.js',
  }, null, 2), { bom: true })
  write('skills/fs-mod/index.js', "import fs from 'node:fs'\nexport const hooks = {}\n")

  // 引用宿主内部模块（../../src/*）
  write('plugins/host-mod/plugin.json', JSON.stringify({
    id: 'host-mod', name: '宿主模块插件', version: '2.0.0',
    category: 'utility', description: '引用宿主内部实现',
    entry: 'index.js',
  }, null, 2))
  write('plugins/host-mod/index.js', "import { x } from '../../src/app.js'\n")

  // 清单坏了也不能凭空消失：仍要出一张红卡
  write('plugins/broken/plugin.json', '{ this is not json')
  write('plugins/broken/index.js', 'export const hooks = {}\n')

  // 没有清单、只有代码的目录不算插件
  write('plugins/no-manifest/index.js', 'export const hooks = {}\n')

  // 清单 id 与目录名不一致（现场真实存在：voice-reply）
  write('plugins/voice-dir/plugin.json', JSON.stringify({
    id: 'self-trained-voice-reply', name: '语音回复', version: '1.0.0',
    category: 'media', description: 'id 与目录名不一致', entry: 'index.js',
  }, null, 2))
  write('plugins/voice-dir/index.js', 'export function setup() {}\n')
  return root
}

await check('QQ Agent 根目录：plugins/ 与 skills/ 都能扫到', () => {
  const dir = makeAgentRoot()
  const entries = mod.scanPluginDir(dir)
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]))
  assert.equal(entries.length, 5, `实际 ${entries.length} 张卡片：${entries.map((e) => e.id)}`)
  assert.ok(byId['plain-mod'], '缺 plugin.json 模块')
  assert.ok(byId['fs-mod'], '缺 skill.json 模块')
  assert.equal(byId['fs-mod'].kind, 'skill', 'skills/ 下的模块 kind 应为 skill')
  assert.equal(byId['plain-mod'].kind, 'plugin')
  assert.ok(!byId['no-manifest'], '没有清单的目录不该出现')
})

await check('元数据按规范解析：版本/分类/作者/依赖声明', () => {
  const dir = makeAgentRoot()
  const entry = mod.scanPluginDir(dir).find((e) => e.id === 'plain-mod')
  assert.equal(entry.name, '纯展示插件')
  assert.equal(entry.version, '1.2.0')
  assert.equal(entry.category, 'message')
  assert.equal(entry.description, '自包含模块')
  assert.equal(entry.author, 'QQ Agent')
  assert.deepEqual(entry.requires, ['llm.chat'])
  assert.deepEqual(entry.capabilities, ['demo'])
  assert.equal(entry.format, 'plugin.json')
  assert.equal(entry.hasEntry, true)
})

await check('非标字段被丢弃，只留计数', () => {
  const entry = mod.scanPluginDir(makeAgentRoot()).find((e) => e.id === 'plain-mod')
  assert.equal(entry.unknownFieldCount, 1, `实际 ${entry.unknownFieldCount}`)
  for (const key of ['settingsUi', 'intercept', 'commands', 'tools']) {
    assert.ok(!(key in entry), `非标字段「${key}」不该出现在卡片数据里`)
  }
})

await check('configSchema 归一化：只留 boolean/number/string/enum', () => {
  const entry = mod.scanPluginDir(makeAgentRoot()).find((e) => e.id === 'plain-mod')
  const schema = entry.configSchema
  assert.deepEqual(Object.keys(schema).sort(), ['count', 'mode', 'on', 'reply', 'token'])
  assert.equal(schema.reply.type, 'string')
  assert.equal(schema.reply.multiline, true)
  assert.equal(schema.count.type, 'number')
  assert.deepEqual([schema.count.min, schema.count.max, schema.count.step], [1, 10, 1])
  assert.equal(schema.on.type, 'boolean')
  assert.deepEqual(schema.mode.values, ['a', 'b'])
  assert.equal(schema.mode.default, 'b')
  assert.equal(schema.token.secret, true)
  assert.ok(!('actionEntry' in schema), 'action 不是配置项，应丢弃')
  assert.ok(!('internalNote' in schema), 'internal 只是说明，应丢弃')
})

await check('settingsDefaults：清单默认值 + schema 默认值合并', () => {
  const entry = mod.scanPluginDir(makeAgentRoot()).find((e) => e.id === 'plain-mod')
  assert.equal(entry.settingsDefaults.reply, '收到')
  assert.equal(entry.settingsDefaults.count, 3)
  assert.equal(entry.settingsDefaults.on, true)
  assert.equal(entry.settingsDefaults.mode, 'b')
  assert.equal(entry.settingsDefaults.token, '')
})

await check('BOM 容错：带 BOM 的 skill.json 也能解析', () => {
  const entry = mod.scanPluginDir(makeAgentRoot()).find((e) => e.id === 'fs-mod')
  assert.ok(entry, '带 BOM 的清单被整条丢掉了')
  assert.equal(entry.name, '文件技能')
  assert.equal(entry.version, '0.3.1')
})

await check('兼容性打标：node 原生模块 / 宿主内部引用 → 只读/受控', () => {
  const dir = makeAgentRoot()
  const byId = Object.fromEntries(mod.scanPluginDir(dir).map((e) => [e.id, e]))
  assert.equal(byId['plain-mod'].compat.tier, 'self-contained')
  assert.equal(byId['plain-mod'].compat.label, '自包含')
  assert.equal(byId['fs-mod'].compat.tier, 'controlled')
  assert.equal(byId['fs-mod'].compat.label, '只读/受控')
  assert.ok(byId['fs-mod'].compat.reasons.some((r) => r.includes('node:fs')),
    JSON.stringify(byId['fs-mod'].compat.reasons))
  assert.equal(byId['host-mod'].compat.tier, 'controlled')
  assert.ok(byId['host-mod'].compat.reasons.some((r) => r.includes('宿主内部')),
    JSON.stringify(byId['host-mod'].compat.reasons))
})

await check('坏清单：出红卡而不是消失', () => {
  const entry = mod.scanPluginDir(makeAgentRoot()).find((e) => e.dirName === 'broken')
  assert.ok(entry, '坏清单条目被丢掉了')
  assert.equal(entry.compat.tier, 'invalid')
  assert.ok(entry.error.includes('plugin.json'), entry.error)
})

await check('清单 id 与目录名不一致时留告警', () => {
  const entry = mod.scanPluginDir(makeAgentRoot()).find((e) => e.dirName === 'voice-dir')
  assert.equal(entry.id, 'self-trained-voice-reply')
  assert.ok(entry.warnings.some((w) => w.includes('目录名')), JSON.stringify(entry.warnings))
})

await check('直接选 plugins/ 目录（平铺）也能扫', () => {
  const root = makeAgentRoot()
  const ids = mod.scanPluginDir(path.join(root, 'plugins')).map((e) => e.id).sort()
  assert.deepEqual(ids, ['broken', 'host-mod', 'plain-mod', 'self-trained-voice-reply'])
})

await check('路由：全部默认关闭；受控/坏清单只展示不执行', async () => {
  const dir = makeAgentRoot()
  const { routes } = makeHarness({ config: { externalPlugins: { dirs: [dir] } } })
  const r = await call(routes.get('/dsh-qq-guard/external-plugins'))
  assert.equal(r.status, 200)
  assert.equal(r.body.scanned, 5)
  assert.equal(r.body.runnable, 0, 'QQ Agent 模块在 P0 没有可执行入口')
  assert.equal(r.body.controlled, 2)
  assert.equal(r.body.invalid, 1)
  assert.ok(r.body.entries.every((e) => e.enabled === false), '默认必须全关')
  assert.ok(!r.body.entries.some((e) => e.format === 'package.json'))
})

await check('路由：配置里按 id 打开也能回显', async () => {
  const dir = makeAgentRoot()
  const { routes } = makeHarness({
    config: { externalPlugins: { dirs: [dir], enabled: ['fs-mod'] } },
  })
  const r = await call(routes.get('/dsh-qq-guard/external-plugins'))
  const fsMod = r.body.entries.find((e) => e.id === 'fs-mod')
  const plain = r.body.entries.find((e) => e.id === 'plain-mod')
  assert.equal(fsMod.enabled, true)
  assert.equal(plain.enabled, false)
})

/* ── 清理失效会话 ─────────────────────────────────────────── */
console.log('\n清理失效会话：')

function makeBridgeState({ sessionCwd, mapped, configDir }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqg-bridge-'))
  const stateDir = path.join(dir, 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'sessions.json'), JSON.stringify({
    sessions: Object.fromEntries(mapped.map((id, i) => [`k${i}`, id])),
    generation: 1,
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dsh: { sessionCwd } }, null, 2))
  return dir
}

await check('归档 QQ 工作区里不在映射表里的会话', async () => {
  const cwd = path.join(os.tmpdir(), 'QQChat-test-a')
  const bridgeDir = makeBridgeState({ sessionCwd: cwd, mapped: ['s-keep'] })
  const archived = []
  const services = {
    sessionController: {
      list: async () => ({
        items: [
          { sessionId: 's-keep', cwd },
          { sessionId: 's-orphan-1', cwd },
          { sessionId: 's-orphan-2', cwd },
          { sessionId: 's-other-workspace', cwd: path.join(os.tmpdir(), 'SomewhereElse') },
          { sessionId: 's-sub', cwd, origin: 'subagent' },
        ],
      }),
    },
    workspaceRegistry: {
      archiveSession: async (id) => { archived.push(id) },
    },
  }
  const { routes } = makeHarness({ config: { bridge: { dir: bridgeDir } }, services })
  const r = await call(routes.get('/dsh-qq-guard/cleanup-sessions'), { method: 'POST' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.candidates, 2, `候选 ${r.body.candidates}`)
  assert.equal(r.body.archived, 2)
  assert.deepEqual(archived.sort(), ['s-orphan-1', 's-orphan-2'],
    '只归档 QQ 工作区的孤儿会话，映射内的、别的目录的、子代理的都不能动')
})

await check('映射表外的会话已不存在时 archived=0', async () => {
  const cwd = path.join(os.tmpdir(), 'QQChat-test-b')
  const bridgeDir = makeBridgeState({ sessionCwd: cwd, mapped: ['s-keep'] })
  const services = {
    sessionController: { list: async () => ({ items: [{ sessionId: 's-keep', cwd }] }) },
    workspaceRegistry: { archiveSession: async () => { throw new Error('不该被调用') } },
  }
  const { routes } = makeHarness({ config: { bridge: { dir: bridgeDir } }, services })
  const r = await call(routes.get('/dsh-qq-guard/cleanup-sessions'), { method: 'POST' })
  assert.equal(r.status, 200)
  assert.equal(r.body.candidates, 0)
  assert.equal(r.body.archived, 0)
})

await check('归档失败计入 failed，不中断其余会话', async () => {
  const cwd = path.join(os.tmpdir(), 'QQChat-test-c')
  const bridgeDir = makeBridgeState({ sessionCwd: cwd, mapped: [] })
  const services = {
    sessionController: { list: async () => ({ items: [{ sessionId: 'bad', cwd }, { sessionId: 'good', cwd }] }) },
    workspaceRegistry: {
      archiveSession: async (id) => { if (id === 'bad') throw new Error('locked') },
    },
  }
  const { routes } = makeHarness({ config: { bridge: { dir: bridgeDir } }, services })
  const r = await call(routes.get('/dsh-qq-guard/cleanup-sessions'), { method: 'POST' })
  assert.equal(r.body.archived, 1)
  assert.equal(r.body.failed.length, 1)
  assert.equal(r.body.failed[0].sessionId, 'bad')
})

await check('DSH 没暴露服务 → 501', async () => {
  const { routes } = makeHarness({ services: {} })
  const r = await call(routes.get('/dsh-qq-guard/cleanup-sessions'), { method: 'POST' })
  assert.equal(r.status, 501)
  assert.equal(r.body.reason, 'not-available')
})

await check('缺 sessionCwd → 400，不误删', async () => {
  const bridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqg-bridge-nocwd-'))
  fs.writeFileSync(path.join(bridgeDir, 'config.json'), JSON.stringify({ dsh: {} }, null, 2))
  const services = {
    sessionController: { list: async () => ({ items: [] }) },
    workspaceRegistry: { archiveSession: async () => {} },
  }
  const { routes } = makeHarness({ config: { bridge: { dir: bridgeDir } }, services })
  const r = await call(routes.get('/dsh-qq-guard/cleanup-sessions'), { method: 'POST' })
  assert.equal(r.status, 400)
  assert.equal(r.body.reason, 'no-session-cwd')
})

await check('GET cleanup-sessions → 405；跨站 → 403', async () => {
  const { routes } = makeHarness({ services: {} })
  const g = await call(routes.get('/dsh-qq-guard/cleanup-sessions'), { method: 'GET' })
  assert.equal(g.status, 405)
  const x = await call(routes.get('/dsh-qq-guard/cleanup-sessions'), { method: 'POST', fetchSite: 'cross-site' })
  assert.equal(x.status, 403)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
