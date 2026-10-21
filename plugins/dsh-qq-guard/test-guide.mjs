/**
 * 使用引导弹窗的逻辑验证：
 *   · 三步状态分别来自 napcat.dir / allow.* / useBridgeProc(alive)，不是写死的
 *   · 桥接未运行时给「去启动」，点它会真的 POST /dsh-qq-guard/bridge?action=start
 *   · 桥接运行中时显示「已就绪」，不给启动按钮
 *
 * 用法：node test-guide.mjs
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

/* ── 假 fetch：记录调用，返回可控响应 ───────────────────────── */
const calls = []
let bridgeStatus = { ok: true, alive: true, uptimeMs: 65000 }
let startResult = { ok: true, action: 'start' }
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
    if (url.includes('/bridge?action=status')) {
      return { ok: true, status: 200, json: async () => bridgeStatus }
    }
    if (url.includes('/bridge?action=start')) {
      return { ok: true, status: 200, json: async () => startResult }
    }
    // 其它（config 兜底等）一律失败，走离线路径
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
function btnByText(tree, text) {
  return findAll(tree, (n) => n.tag === 'button' && textOf(n).trim() === text)[0]
}
function flushEffects() {
  const pending = effects.splice(0)
  for (const fn of pending) fn()
}

/* ── 装配 ───────────────────────────────────────────────────── */
/** 真实配置里的技能/插件目录 + 节奏字段（测试夹具，形状与 Host 侧 Config 一致）。 */
const CONFIG_CATALOG = {
  skills: [
    { id: 'sk-voice', name: '发语音', icon: 'send', tag: '内置', ver: '1.0.2', enabled: true, desc: '合成语音' },
    { id: 'sk-vision', name: '图片理解', icon: 'image', tag: '内置', ver: '1.3.2', enabled: true, desc: '识别图片' },
    { id: 'sk-search', name: '网页搜索', icon: 'search', tag: '内置', ver: '1.0.4', enabled: true, desc: '联网检索' },
    { id: 'sk-memory', name: '记忆提取', icon: 'memory', tag: '内置', ver: '1.2.0', enabled: true, desc: '抽取长期事实' },
  ],
  plugins: [
    { id: 'pl-debounce', name: '防抖合并', icon: 'activity', tag: '本地', ver: '1.4.0', enabled: true, desc: '合并短消息' },
    { id: 'pl-ratelimit', name: '频率控制', icon: 'shield', tag: '本地', ver: '1.1.0', enabled: true, desc: '按会话限流' },
    { id: 'pl-compact', name: '上下文压缩', icon: 'memory', tag: '内置', ver: '1.4.3', enabled: true, desc: '压缩上下文' },
  ],
  rhythm: { activityLevel: 1, debounceWindowMs: 800, batchIntervalMs: 2500,
    rateLimit: { perMin: 12, burst: 3, silent: true },
    mute: { enabled: true, words: ['闭嘴'], seconds: 60 } },
  externalPlugins: { dirs: [], enabled: [] },
}

let VALUE = {}
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

/** 渲染（guideOpen=true），并执行 useEffect 让 bridge 状态轮询真的发一次请求。 */
async function renderGuide(open) {
  hookStore = new Map([
    ['root:SettingsPanel#1', 'settings'],   // active
    ['root:SettingsPanel#2', open],         // guideOpen
  ])
  effects.length = 0
  let tree = expand(React.createElement(Comp, { remoteForm: form }), 'root')
  flushEffects()
  // 桥接状态轮询的 load 是 async，等它落地后重渲染一次拿到 proc 状态
  await new Promise((r) => setTimeout(r, 20))
  effects.length = 0
  tree = expand(React.createElement(Comp, { remoteForm: form }), 'root')
  return tree
}
async function renderGuideOpen() { return renderGuide(true) }
async function renderGuideClosed() { return renderGuide(false) }

/** 导航底部「x/3」的当前值。 */
function navDone(tree) {
  const node = findAll(tree, (n) => n.props?.className === 'qqg-nav-guide-done')[0]
  return node ? textOf(node) : ''
}

/** 弹窗里的完成度文案，例如「100%（3 / 3）」。 */
function modalProgress(tree) {
  const node = findAll(tree, (n) => n.props?.className === 'qqg-progress')[0]
  return node ? textOf(node) : ''
}

let pass = 0
const fail = []
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fail.push(name); console.log(`  ✗ ${name}\n    ${e.message}`) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

/** 取三步里的某一行。 */
function stepRow(tree, name) {
  return findAll(tree, (n) => n.props?.className === 'qqg-onboard-row')
    .find((r) => textOf(findAll(r, (x) => x.props?.className === 'qqg-onboard-name')[0]) === name)
}

/* ── 用例 ───────────────────────────────────────────────────── */
console.log('使用引导弹窗：')

VALUE = {
  ...CONFIG_CATALOG,
  napcat: { dir: '' }, allow: { private: [], groups: [] }, bridge: { autoStart: false },
  bubbleMaxChars: 30, mergeMaxChars: 15, chunkSize: 1000, sendIntervalMs: 500,
  typingDelay: { enabled: true }, flypitDelayTiers: { short: 200, medium: 450, long: 800 },
  groupAtReply: true, groupAtPosition: 'last', trimEndPunctuation: { enabled: true },
  personaText: '', personaPresetDefault: '', onebot: { wsUrl: '', accessToken: '' },
}
bridgeStatus = { ok: true, alive: true, uptimeMs: 65000 }

const treeEmpty = await renderGuideOpen()
check('NapCat 未配置 → 黄灯 + 去配置', () => {
  const row = stepRow(treeEmpty, 'NapCat 进程')
  assert(row, '找不到 NapCat 行')
  const dot = findAll(row, (n) => n.props?.className?.includes('qqg-dot'))[0].props.className
  assert(dot.includes('qqg-dot-warn'), `状态点是「${dot}」，应为 warn`)
  assert(textOf(row).includes('去配置'), '没有「去配置」按钮')
})

check('白名单为空 → 黄灯 + 去配置', () => {
  const row = stepRow(treeEmpty, '白名单')
  const dot = findAll(row, (n) => n.props?.className?.includes('qqg-dot'))[0].props.className
  assert(dot.includes('qqg-dot-warn'), `状态点是「${dot}」`)
  assert(textOf(row).includes('去配置'), '没有「去配置」按钮')
})

check('桥接运行中（proc.alive=true）→ 绿点 + 已就绪', () => {
  const row = stepRow(treeEmpty, '桥接进程')
  assert(row, '找不到桥接行')
  const dot = findAll(row, (n) => n.props?.className?.includes('qqg-dot'))[0].props.className
  assert(dot.includes('qqg-dot-ok'), `状态点是「${dot}」，应取 useBridgeProc 的 alive=true`)
  assert(textOf(row).includes('已就绪'), '没有「已就绪」标记')
  assert(!textOf(row).includes('去启动'), '运行中不该给「去启动」')
})

check('桥接状态来自 /dsh-qq-guard/bridge?action=status（不是配置项）', () => {
  const hit = calls.filter((c) => c.url.includes('/bridge?action=status'))
  assert(hit.length > 0, '没有请求过 bridge status 路由')
})

/* 把桥接改成未运行，再看按钮 */
bridgeStatus = { ok: true, alive: false, uptimeMs: 0 }
const treeStopped = await renderGuideOpen()
check('桥接未运行 → 黄灯 + 去启动', () => {
  const row = stepRow(treeStopped, '桥接进程')
  const dot = findAll(row, (n) => n.props?.className?.includes('qqg-dot'))[0].props.className
  assert(dot.includes('qqg-dot-warn'), `状态点是「${dot}」`)
  assert(textOf(row).includes('去启动'), '没有「去启动」按钮')
})

check('点「去启动」真的 POST start 路由', async () => {
  const before = calls.filter((c) => c.url.includes('action=start')).length
  const btn = findAll(stepRow(treeStopped, '桥接进程'), (n) => n.tag === 'button')[0]
  assert(btn, '找不到启动按钮')
  btn.props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  const after = calls.filter((c) => c.url.includes('action=start')).length
  assert(after === before + 1, `start 路由调用次数 ${before} → ${after}`)
})

/* 配置齐全 + 桥接在跑 → 3/3 */
VALUE = {
  ...CONFIG_CATALOG,
  ...VALUE,
  napcat: { dir: 'D:\\NapCat' },
  allow: { private: ['10001'], groups: ['20002'] },
}
bridgeStatus = { ok: true, alive: true, uptimeMs: 120000 }
const treeFull = await renderGuideOpen()
check('配置齐全 + 桥接运行 → 100%（3/3）', () => {
  const joined = textOf(treeFull)
  assert(joined.includes('100%'), '进度不是 100%')
  const rows = findAll(treeFull, (n) => n.props?.className === 'qqg-onboard-row')
  rows.forEach((r) => {
    const dot = findAll(r, (n) => n.props?.className?.includes('qqg-dot'))[0].props.className
    assert(dot.includes('qqg-dot-ok'), `「${textOf(findAll(r, (x) => x.props?.className === 'qqg-onboard-name')[0])}」不是绿点`)
  })
})

check('导航底部按钮显示 3/3（三项全绿，与弹窗一致）', () => {
  // 桥接进程状态现在已经提到面板层轮询，底部按钮能拿到真实状态：
  // 配置齐全 + 桥接运行 → 必须和弹窗一样算 3/3，不能再停留在 2/3。
  const nav = navDone(treeFull)
  assert(nav === '3/3', `显示「${nav}」，应为 3/3`)
  const progress = modalProgress(treeFull)
  assert(progress.includes('100%'), `弹窗进度「${progress}」`)
})

check('按钮计数与弹窗判定完全同源（同一次渲染）', () => {
  const nav = navDone(treeFull)
  const progress = modalProgress(treeFull)
  // 从弹窗文案「100%（3 / 3）」里取完成数，和导航按钮的 x/3 对比。
  const m = progress.match(/(\d+)\s*\/\s*(\d+)/)
  assert(m, `弹窗进度文案里没有 x / y：${progress}`)
  assert(`${m[1]}/${m[2]}` === nav,
    `按钮「${nav}」与弹窗「${m[1]}/${m[2]}」不一致`)
})

/* 配置齐全但桥接未运行 → 按钮与弹窗都必须算 2/3。 */
bridgeStatus = { ok: true, alive: false, uptimeMs: 0 }
const treePartial = await renderGuideOpen()
check('桥接未运行：按钮 2/3，弹窗 67%（2 / 3）', () => {
  const nav = navDone(treePartial)
  assert(nav === '2/3', `显示「${nav}」，应为 2/3`)
  const progress = modalProgress(treePartial)
  assert(progress.includes('67%'), `弹窗进度「${progress}」`)
})

/* 配置齐全 + 桥接运行 → 关闭弹窗后按钮仍应为 3/3。 */
bridgeStatus = { ok: true, alive: true, uptimeMs: 120000 }
const treeClosed = await renderGuideClosed()
check('弹窗关闭时按钮也显示 3/3（不是只在弹窗里才对）', () => {
  const nav = navDone(treeClosed)
  assert(nav === '3/3', `显示「${nav}」，应为 3/3`)
})

console.log(`\n结果：${pass} 通过 / ${fail.length} 失败`)
process.exit(fail.length ? 1 : 0)
