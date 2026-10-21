/**
 * NapCat 启停操作的落点调整（运行状态页）离线测试：
 *   · 「运行状态」页有 NapCat 控制面板：状态 / 端口监听 / 启动 / 停止
 *   · 按钮打到与 Host 相同的路由 /dsh-qq-guard/napcat?action=start|stop
 *   · 启停后立刻重新拉状态，界面跟着刷新
 *   · 「全局设置 → NapCat 进程」只剩输入框，没有启停按钮，有跳转提示
 *   · 设置页不再自己轮询 NapCat 状态（避免两处状态各算各的）
 *
 * 用法：node test-status-napcat.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

/* ── 假 React ───────────────────────────────────────────────── */
let hookStore = new Map()
let hookKey = 'root'
let hookCursor = 0
const effects = []
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length ? children : (props?.children ?? []) },
  }),
  Fragment: Symbol('Fragment'),
  useState(init) {
    const i = hookCursor++
    const k = hookKey + '#' + i
    if (!hookStore.has(k)) hookStore.set(k, typeof init === 'function' ? init() : init)
    return [hookStore.get(k), (next) => {
      hookStore.set(k, typeof next === 'function' ? next(hookStore.get(k)) : next)
    }]
  },
  useEffect(fn) { effects.push(fn) },
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

/* ── 假 fetch：记录调用，NapCat 状态可控 ────────────────────── */
const calls = []
const STOPPED = {
  ok: true, state: 'stopped', managed: false, wsPort: 3001,
  portListening: false, processAlive: false, selfId: '', nickname: '',
  probeAvailable: false, lastError: '',
}
const ONLINE = {
  ok: true, state: 'online', managed: true, wsPort: 3001,
  portListening: true, processAlive: true, selfId: '10001', nickname: '小鱼',
  probeAvailable: true, lastError: '',
}
let napcatStatus = STOPPED

const sandbox = {
  window: {
    __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => React) } },
    setTimeout: (fn) => { const t = setTimeout(fn, 0); if (t.unref) t.unref(); return t },
    __keyListeners: [],
    addEventListener(type, fn) { if (type === 'keydown') this.__keyListeners.push(fn) },
    removeEventListener() {},
  },
  React,
  console: { ...console, error() {}, warn() {}, log: (...a) => console.log(...a) },
  setTimeout, clearTimeout,
  fetch: async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    if (url.includes('/napcat?action=status')) {
      return { ok: true, status: 200, json: async () => napcatStatus }
    }
    if (url.includes('/napcat?action=start')) {
      napcatStatus = ONLINE
      return { ok: true, status: 200, json: async () => ({ ok: true, action: 'start' }) }
    }
    if (url.includes('/napcat?action=stop')) {
      napcatStatus = STOPPED
      return { ok: true, status: 200, json: async () => ({ ok: true, action: 'stop' }) }
    }
    if (url.includes('/bridge?action=status')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, alive: false }) }
    }
    // /dsh-qq-guard/status、/config 等：走空实现，避免干扰
    return { ok: false, status: 500, json: async () => ({}) }
  },
  document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} }, getElementById: () => null },
}
let mod
vm.createContext(sandbox)
vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })

/* ── 元素树工具 ─────────────────────────────────────────────── */
function expand(node, path = 'root') {
  if (node === null || node === undefined || node === false) return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (Array.isArray(node)) return { kids: node.map((n, i) => expand(n, `${path}[${i}]`)).filter(Boolean) }
  const { type, props } = node
  const children = props?.children ?? []
  if (type === React.Fragment) return { kids: children.map((c, i) => expand(c, `${path}.f${i}`)).filter(Boolean) }
  if (typeof type === 'function') {
    const prevKey = hookKey, prevCursor = hookCursor
    hookKey = `${path}:${type.name || 'anon'}`
    hookCursor = 0
    let out
    try { out = type(props) } finally { hookKey = prevKey; hookCursor = prevCursor }
    return expand(out, path)
  }
  return { tag: type, props, kids: children.map((c, i) => expand(c, `${path}.${type}${i}`)).filter(Boolean) }
}
function findAll(node, pred, out = []) {
  if (!node) return out
  if (pred(node)) out.push(node)
  ;(node.kids ?? []).forEach((k) => findAll(k, pred, out))
  return out
}
function textOf(node) {
  if (!node) return ''
  if (node.text !== undefined) return node.text
  if (node.tag === 'style') return ''
  return (node.kids ?? []).map(textOf).join('')
}
function flushEffects() {
  const pending = effects.splice(0)
  for (const fn of pending) {
    const cleanup = fn()
    if (typeof cleanup === 'function') effects.push(cleanup)
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 装配 ───────────────────────────────────────────────────── */
const VALUE = {
  skills: [], plugins: [],
  rhythm: {
    activityLevel: 1, debounceWindowMs: 800, batchIntervalMs: 2500,
    rateLimit: { perMin: 12, burst: 3, silent: true },
    mute: { enabled: true, words: ['闭嘴'], seconds: 60 },
  },
  externalPlugins: { dirs: [], enabled: [] },
  bubbleMaxChars: 30, mergeMaxChars: 15, chunkSize: 1000, sendIntervalMs: 500,
  typingDelay: { enabled: true }, flypitDelayTiers: { short: 200, medium: 450, long: 800 },
  groupAtReply: true, groupAtPosition: 'last', trimEndPunctuation: { enabled: true },
  personaText: '', personaPresetDefault: '',
  allow: { private: [], groups: [], allowAllWhenEmpty: false },
  onebot: { wsUrl: '', accessToken: '' },
  napcat: { dir: 'D:\\NapCat.52230.Shell', quickLoginQQ: '1000000001' },
  bridge: { dir: '', autoStart: false },
}
const form = {
  getSnapshot: () => ({ status: 'ready', value: VALUE, writable: true, source: 'remote' }),
  subscribe: () => () => {},
  mutate: async () => true,
}
const registered = {}
const ctx = {
  remote: { settings: { describe: async () => ({ ok: true, value: { namespaces: [] } }) } },
  effect: (fn) => { fn() },
  on: () => () => {},
  slots: {
    inject: (_n, fn) => fn(),
    register: (d, c) => { registered[d.name + ':' + (d.key ?? d.id ?? '')] = c; return () => {} },
  },
  inject: (_d, fn) => fn({ slots: ctx.slots, effect: ctx.effect, configForms: { get: () => form } }),
  configForms: { get: () => form },
}
mod.apply(ctx)
const Comp = registered['main:qq-bridge']

/** 从干净 state 渲染指定 Tab，并等首次状态查询落地。 */
async function renderTab(tab) {
  hookStore = new Map([['root:SettingsPanel#1', tab]])
  effects.length = 0
  let tree = expand(React.createElement(Comp, { remoteForm: form }), 'root')
  flushEffects()
  await wait(20)
  effects.length = 0
  tree = expand(React.createElement(Comp, { remoteForm: form }), 'root')
  return tree
}
/** 重渲染并「提交」effects（模拟 setState 后再跑一遍轮询）。 */
async function repaintAndFlush() {
  effects.length = 0
  let tree = expand(React.createElement(Comp, { remoteForm: form }), 'root')
  flushEffects()
  await wait(20)
  effects.length = 0
  return expand(React.createElement(Comp, { remoteForm: form }), 'root')
}
function btnByText(tree, text) {
  return findAll(tree, (n) => n.tag === 'button' && textOf(n).trim() === text)[0]
}
function panelOf(tree, title) {
  return findAll(tree, (n) => n.props?.className === 'qqg-group')
    .find((g) => textOf(findAll(g, (x) => x.props?.className === 'qqg-group-title')[0] ?? {}) === title)
}

let pass = 0
const fail = []
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail.push(name); console.log(`  ✗ ${name}\n    ${e.message}`) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

/* ── 运行状态页 ─────────────────────────────────────────────── */
console.log('运行状态页 · NapCat 控制面板：')

napcatStatus = STOPPED
const statusTree = await renderTab('status')

check('「运行状态」页出现 NapCat 进程面板', () => {
  const panel = panelOf(statusTree, 'NapCat 进程')
  assert(panel, '状态页找不到「NapCat 进程」面板')
  assert(textOf(panel).includes('当前状态'), '缺「当前状态」')
  assert(textOf(panel).includes('端口监听'), '缺「端口监听」')
})

check('状态与端口来自真实路由：已停止 / 未监听', () => {
  const panel = panelOf(statusTree, 'NapCat 进程')
  assert(textOf(panel).includes('已停止'), `状态文案「${textOf(panel)}」`)
  assert(textOf(panel).includes('端口 3001 未监听'), '端口监听情况没显示')
  assert(textOf(panel).includes('不在'), '进程存活状态没显示')
})

check('有 [启动 NapCat] 和 [停止] 两个按钮', () => {
  assert(btnByText(statusTree, '启动 NapCat'), '缺启动按钮')
  assert(btnByText(statusTree, '停止'), '缺停止按钮')
})

check('已停止时：启动可点、停止不可点', () => {
  assert(btnByText(statusTree, '启动 NapCat').props.disabled !== true, '启动按钮不该被禁用')
  assert(btnByText(statusTree, '停止').props.disabled === true, '停止按钮应禁用')
})

check('点启动 → POST /dsh-qq-guard/napcat?action=start', async () => {
  const before = calls.filter((c) => c.url.includes('/napcat?action=start')).length
  btnByText(statusTree, '启动 NapCat').props.onClick()
  await wait(30)
  const after = calls.filter((c) => c.url.includes('/napcat?action=start')).length
  assert(after === before + 1, `start 调用 ${before} → ${after}`)
  const call = calls.filter((c) => c.url.includes('/napcat?action=start')).pop()
  assert(call.method === 'POST', `方法应是 POST，实际 ${call.method}`)
})

/* 启停后 refresh() → 重新拉状态；模拟真实 React 的 effect 重跑。 */
const afterStart = await repaintAndFlush()

check('启停后状态实时刷新：在线 / 监听中 / 已登录', () => {
  const panel = panelOf(afterStart, 'NapCat 进程')
  assert(textOf(panel).includes('在线'), `状态没刷新：「${textOf(panel)}」`)
  assert(textOf(panel).includes('端口 3001 监听中'), '端口监听没刷新')
  assert(textOf(panel).includes('10001'), '登录账号没显示')
})

check('在线且由本插件托管时：启动禁用、停止可点', () => {
  assert(btnByText(afterStart, '启动 NapCat').props.disabled === true, '运行中启动应禁用')
  assert(btnByText(afterStart, '停止').props.disabled !== true, '运行中停止应可点')
})

check('点停止 → POST /dsh-qq-guard/napcat?action=stop', async () => {
  const before = calls.filter((c) => c.url.includes('/napcat?action=stop')).length
  btnByText(afterStart, '停止').props.onClick()
  await wait(30)
  const after = calls.filter((c) => c.url.includes('/napcat?action=stop')).length
  assert(after === before + 1, `stop 调用 ${before} → ${after}`)
})

/* ── 全局设置页：只留输入框 ─────────────────────────────────── */
console.log('\n全局设置页 · NapCat 配置：')

napcatStatus = STOPPED
const beforeSettingsCalls = calls.length
const settingsTree = await renderTab('settings')

check('「全局设置 → NapCat 进程」没有启动/停止按钮', () => {
  const panel = panelOf(settingsTree, 'NapCat 进程')
  assert(panel, '设置页找不到「NapCat 进程」卡片')
  assert(!btnByText(panel, '启动 NapCat'), '设置页还留着「启动 NapCat」按钮')
  assert(!btnByText(panel, '停止'), '设置页还留着「停止」按钮')
})

check('只保留输入框：安装目录 + 快速登录 QQ 号', () => {
  const panel = panelOf(settingsTree, 'NapCat 进程')
  const dirInput = findAll(panel, (n) => n.tag === 'input' && n.props?.['aria-label'] === 'NapCat 安装目录')[0]
  const qqInput = findAll(panel, (n) => n.tag === 'input' && n.props?.['aria-label'] === '快速登录 QQ 号')[0]
  assert(dirInput, '缺安装目录输入框')
  assert(qqInput, '缺快速登录 QQ 号输入框')
  assert(dirInput.props.value === 'D:\\NapCat.52230.Shell', '安装目录没绑定配置')
  assert(qqInput.props.value === '1000000001', '快速登录 QQ 号没绑定配置')
  const statusRows = findAll(panel, (n) => n.props?.className === 'qqg-row'
    && ['当前状态', '端口监听', '登录账号', '操作'].some((k) => textOf(n).includes(k)))
  assert(statusRows.length === 0, `设置页还留着状态行 ${statusRows.length} 条`)
})

check('有灰色提示「启动/停止操作请前往「运行状态」页」', () => {
  const panel = panelOf(settingsTree, 'NapCat 进程')
  const hint = findAll(panel, (n) => n.props?.className === 'qqg-hint')[0]
  assert(hint, '缺 qqg-hint 灰字提示')
  assert(textOf(hint).includes('启动/停止操作请前往「运行状态」页'), `提示是「${textOf(hint)}」`)
})

check('设置页不再轮询 NapCat 状态（状态只由运行状态页维护）', () => {
  const statusCalls = calls.slice(beforeSettingsCalls).filter((c) => c.url.includes('/napcat?action=status'))
  assert(statusCalls.length === 0, `设置页发起了 ${statusCalls.length} 次 NapCat 状态查询`)
})

/* ── 安装目录为空：fail-closed ──────────────────────────────── */
console.log('\n安装目录为空：')

VALUE.napcat.dir = ''
napcatStatus = STOPPED
const noDirTree = await renderTab('status')

check('未配置安装目录 → 启动按钮禁用，状态卡提示去设置', () => {
  const start = btnByText(noDirTree, '启动 NapCat')
  assert(start, '找不到启动按钮')
  assert(start.props.disabled === true, '未配置目录时启动按钮应禁用（fail-closed）')
  assert(String(start.props.title).includes('安装目录'), `title 是「${start.props.title}」`)
  const panel = panelOf(noDirTree, 'NapCat 进程')
  assert(textOf(panel).includes('未配置安装目录'), '状态页没有提示未配置安装目录')
})
VALUE.napcat.dir = 'D:\\NapCat.52230.Shell'

console.log(`\n结果：${pass} 通过 / ${fail.length} 失败`)
process.exit(fail.length ? 1 : 0)
