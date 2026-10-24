/**
 * 左下角快捷启动卡 + 记忆整理卡的离线回归。
 *
 *   · 启动卡：在 .qqg-nav-foot 里、「使用引导」按钮上方，含状态灯 / 当前模型 / 启动按钮；
 *   · 启动按钮**已接真实路由**：先 `POST /dsh-qq-guard/napcat?action=start`，
 *     再 `POST /dsh-qq-guard/bridge?action=start`；失败要显示错误行、不能假装就绪；
 *   · 状态灯由 `useBridgeProc` / `useNapcatProcess` 轮询真实进程（假 React 里 effect 不跑，
 *     所以这里只断言「不再有本地假动画」和请求顺序）；
 *   · 全局设置「记忆整理」卡：两个开关 + 冷却时间输入，默认 21600000。
 *
 * 用法：node test-shell-ui.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

/* ── 假 React：hooks + 受控的「重渲染」────────────────────────── */
let hookStore = new Map()
let hookKey = 'root'
let hookCursor = 0
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
  useEffect() {},
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

/* ── 加载 client.js；setTimeout 只记录不执行（手动跑 Mock 定时器）── */
let mod
const timers = []
const fetchCalls = []
const quietConsole = {
  ...console,
  error: () => {}, warn: () => {}, log: (...a) => console.log(...a),
}
const sandbox = {
  window: { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => React) } } },
  React, console: quietConsole,
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
  clearTimeout: () => {},
  // 启动卡片现在打真实路由：这里记录调用顺序，按 URL 回成功。
  // `/models` 故意失败（catalog 为空 → 「当前模型」回退到组件 prop）。
  fetch: async (url, init) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' })
    if (String(url).includes('/dsh-qq-guard/models')) {
      return { ok: false, status: 404, json: async () => ({ ok: false, reason: 'offline' }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  },
  document: {
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
    getElementById: () => null,
  },
}
vm.createContext(sandbox)
vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })

/* ── 元素树工具 ───────────────────────────────────────────────── */
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
  if (node.kids) {
    if (pred(node)) out.push(node)
    node.kids.forEach((k) => findAll(k, pred, out))
  } else if (pred(node)) out.push(node)
  return out
}

function textOf(node) {
  if (!node) return ''
  if (node.text !== undefined) return node.text
  if (node.tag === 'style') return ''
  return (node.kids ?? []).map(textOf).join('')
}

/** className 按 token 匹配（`qqg-dot qqg-dot-idle` 这种组合类也要能选中）。 */
const hasClass = (n, cls) => typeof n?.props?.className === 'string'
  && n.props.className.split(/\s+/).includes(cls)
const byClass = (tree, cls) => findAll(tree, (n) => hasClass(n, cls))
const byLabel = (tree, label) => findAll(tree, (n) => n.props?.['aria-label'] === label)

/* ── 装配上下文：设置页只读一张最小配置表 ─────────────────────── */
const VALUE = {
  bubbleMaxChars: 30, mergeMaxChars: 15,
  typingDelay: { enabled: true },
  rhythm: { activityLevel: 1, debounceWindowMs: 800, batchIntervalMs: 2500,
    rateLimit: { perMin: 12, burst: 3, silent: true }, mute: { enabled: true, words: ['闭嘴'], seconds: 60 } },
  skills: [], plugins: [],
  externalPlugins: { dirs: [], enabled: [], settings: {} },
  allow: { private: [], groups: [], allowAllWhenEmpty: false },
  onebot: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '' },
  napcat: { dir: '', quickLoginQQ: '' },
  bridge: { dir: '', autoStart: false },
}
const form = {
  getSnapshot: () => ({ status: 'ready', value: VALUE, writable: true, source: 'remote' }),
  subscribe: () => () => {},
  // 记录每次写盘（ops 数组）并支持模拟失败：乐观更新 / 回滚用例要用。
  mutate: async (ops) => {
    MUTATIONS.push(ops)
    return MUTATE_FAIL !== true
  },
}
let MUTATE_FAIL = false
const MUTATIONS = []

let registered = {}
const ctx = {
  remote: { settings: { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'qq-guard', revision: 1, value: VALUE }] } }) } },
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
if (!Comp) throw new Error('main:qq-bridge 槽位未注册')

/** 从干净 state 渲染「全局设置」Tab；重渲染时保留 state。 */
function renderSettings() {
  const tree = expand(React.createElement(Comp, { remoteForm: form }), 'root')
  return tree
}
function resetSettings() {
  hookStore = new Map([['root:SettingsPanel#1', 'settings']])
  return renderSettings()
}
/** 渲染指定 Tab（用于运行状态页的 pending / spinner 用例）。 */
function resetTab(tab) {
  hookStore = new Map([['root:SettingsPanel#1', tab]])
  return renderSettings()
}
/** 保留 state 重渲染（等价于真 React 的 setState 后重渲染）。 */
function renderTab() {
  return renderSettings()
}

let pass = 0
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1 }
}
/** 异步用例（启动链路真的 await fetch）。 */
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1 }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

/* ── 1. 左下角快捷启动卡 ──────────────────────────────────────── */
console.log('左下角快捷启动卡：')
check('卡片在 .qqg-nav-foot 里，且在「使用引导」上方', () => {
  const tree = resetSettings()
  const nav = byClass(tree, 'qqg-nav')[0]
  assert(nav, '找不到左侧导航')
  const foot = byClass(nav, 'qqg-nav-foot')[0]
  assert(foot, '导航缺少底部容器 .qqg-nav-foot')
  const card = byClass(foot, 'qqg-launch')[0]
  assert(card, '底部容器里没有 .qqg-launch 卡片')
  const guide = byClass(foot, 'qqg-nav-guide')[0]
  assert(guide, '底部容器里没有「使用引导」按钮')
  const kids = foot.kids ?? []
  const idxOf = (node) => kids.findIndex((k) => k === node)
  assert(idxOf(card) >= 0 && idxOf(guide) >= 0, '卡片/引导按钮不是底部容器的直接子节点')
  assert(idxOf(card) < idxOf(guide), '启动卡片应在「使用引导」按钮上方')
})

check('状态灯默认「未就绪」，并显示当前模型', () => {
  const tree = resetSettings()
  const card = byClass(tree, 'qqg-launch')[0]
  const joined = textOf(card)
  assert(joined.includes('未就绪'), `状态灯文案不对：${joined}`)
  assert(byClass(card, 'qqg-dot-idle').length === 1, '未就绪应配 idle 状态灯')
  const model = textOf(byClass(card, 'qqg-launch-model-name')[0])
  assert(model === '跟随全局默认', `当前模型显示为「${model}」`)
  assert(joined.includes('一键启动 QQ + NapCat'), '缺少启动按钮文案')
})

await checkAsync('点启动走真实路由：先 NapCat、后桥接', async () => {
  const tree = resetSettings()
  const card = byClass(tree, 'qqg-launch')[0]
  const btn = byClass(card, 'qqg-launch-btn')[0]
  assert(btn, '找不到启动按钮')
  assert(btn.props.disabled !== true, '初始状态按钮不该禁用')
  fetchCalls.length = 0
  // onClick 是 async：等它走完两段 POST
  await btn.props.onClick()

  const posts = fetchCalls.filter((c) => c.method === 'POST').map((c) => c.url)
  const expected = ['/dsh-qq-guard/napcat?action=start', '/dsh-qq-guard/bridge?action=start']
  assert(JSON.stringify(posts) === JSON.stringify(expected), `启动顺序不对：${JSON.stringify(posts)}`)

  // 状态灯由轮询驱动（effect 在假 React 里是 no-op），这里只断言按钮没进入假「就绪」。
  const next = renderSettings()
  const card2 = byClass(byClass(next, 'qqg-nav-foot')[0], 'qqg-launch')[0]
  assert(!textOf(card2).includes('启动中…'), '请求结束后不应还停在「启动中…」')
  assert(byClass(card2, 'qqg-launch-btn')[0].props.disabled !== true, '未轮询到就绪时按钮应可再点')
})

await checkAsync('启动失败时显示错误行，不假装就绪', async () => {
  const tree = resetSettings()
  const card = byClass(tree, 'qqg-launch')[0]
  const btn = byClass(card, 'qqg-launch-btn')[0]
  const original = sandbox.fetch
  sandbox.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' })
    return { ok: false, status: 500, json: async () => ({ ok: false, detail: 'napcat missing' }) }
  }
  try {
    await btn.props.onClick()
  } finally {
    sandbox.fetch = original
  }
  const next = renderSettings()
  const card2 = byClass(byClass(next, 'qqg-nav-foot')[0], 'qqg-launch')[0]
  assert(textOf(card2).includes('启动失败'), `失败态文案不对：${textOf(card2)}`)
  assert(byClass(card2, 'qqg-launch-err').length === 1, '失败时应显示错误行')
  assert(!textOf(card2).includes('就绪'), '失败时绝不能显示「就绪」')
})

/* ── 2. 全局设置 · 记忆整理 ───────────────────────────────────── */
console.log('\n全局设置 · 记忆整理：')
function memoryPanel(tree) {
  return findAll(tree, (n) => n.props?.className === 'qqg-panel'
    && textOf(n).includes('记忆整理'))[0]
}

check('「记忆整理」卡片有两个开关 + 冷却时间输入', () => {
  const tree = resetSettings()
  const panel = memoryPanel(tree)
  assert(panel, '「全局设置」里找不到「记忆整理」卡片')
  for (const label of ['启用记忆自动整理', '使用同模型', '整理冷却时间（毫秒）']) {
    assert(byLabel(panel, label).length === 1, `缺少控件「${label}」`)
  }
  const switches = findAll(panel, (n) => n.tag === 'button' && n.props?.role === 'switch')
  assert(switches.length === 2, `应有 2 个开关，实际 ${switches.length}`)
})

check('冷却时间默认 21600000 毫秒', () => {
  const tree = resetSettings()
  const input = byLabel(memoryPanel(tree), '整理冷却时间（毫秒）')[0]
  assert(String(input.props.value) === '21600000', `默认值不对：${input.props.value}`)
})

check('开关可切换；关掉总开关后另外两个控件禁用', () => {
  let tree = resetSettings()
  let panel = memoryPanel(tree)
  const master = byLabel(panel, '启用记忆自动整理')[0]
  assert(master.props['aria-checked'] === 'true', '默认应开启')
  master.props.onClick()

  tree = renderSettings()
  panel = memoryPanel(tree)
  assert(byLabel(panel, '启用记忆自动整理')[0].props['aria-checked'] === 'false', '总开关没切到关闭')
  assert(byLabel(panel, '使用同模型')[0].props.disabled === true, '总开关关闭后「使用同模型」应禁用')
  assert(byLabel(panel, '整理冷却时间（毫秒）')[0].props.disabled === true, '总开关关闭后冷却时间应禁用')
})

check('冷却时间可改：输入 3600000 并在失焦后提交', () => {
  // 先把总开关恢复成开启（上一条用例把它关了；hookStore 在用例间不重置）
  let tree = renderSettings()
  let panel = memoryPanel(tree)
  byLabel(panel, '启用记忆自动整理')[0].props.onClick()
  tree = renderSettings()
  panel = memoryPanel(tree)

  let input = byLabel(panel, '整理冷却时间（毫秒）')[0]
  input.props.onChange({ target: { value: '3600000' } })
  tree = renderSettings()
  panel = memoryPanel(tree)
  input = byLabel(panel, '整理冷却时间（毫秒）')[0]
  input.props.onBlur()
  tree = renderSettings()
  const value = byLabel(memoryPanel(tree), '整理冷却时间（毫秒）')[0].props.value
  assert(String(value) === '3600000', `提交后应为 3600000，实际 ${value}`)
})

/* ── 3. P2 极速：乐观更新 / 失焦保存 / 轮询隔离 / Loading ──────── */
console.log('\nP2 极速（乐观更新 / 失焦保存 / 轮询隔离 / Loading）：')

const spinNodes = (tree) => findAll(tree, (n) => typeof n.props?.className === 'string'
  && n.props.className.split(/\s+/).includes('qqg-spin'))

check('乐观更新：点开关后当场重渲染就是新状态（不等写盘回读）', () => {
  MUTATIONS.length = 0
  MUTATE_FAIL = false
  let tree = resetTab('settings')
  const sw = () => byLabel(tree, 'DSH 启动时自动拉起桥接进程')[0]
  assert(sw().props['aria-checked'] === 'false', '初值应为关')
  sw().props.onClick()
  // 关键：这里**没有 await**，且假 mutate 不会改 VALUE。
  // 界面要是在这一步还是关的，说明仍是「等回读」的旧实现。
  tree = renderTab()
  assert(sw().props['aria-checked'] === 'true', '点击后界面没有立刻变（不是乐观更新）')
  assert(MUTATIONS.length === 1, `应当已静默发一次 mutate，实际 ${MUTATIONS.length}`)
  assert(MUTATIONS[0][0].path.join('.') === 'bridge.autoStart', '写错路径')
  assert(byClass(tree, 'qqg-saving').length === 1, '飞行中应显示「正在保存…」')
})

await checkAsync('乐观更新失败：回滚原值 + 红字错误提示', async () => {
  MUTATIONS.length = 0
  MUTATE_FAIL = true
  let tree = resetTab('settings')
  const sw = () => byLabel(tree, 'DSH 启动时自动拉起桥接进程')[0]
  sw().props.onClick()
  tree = renderTab()
  assert(sw().props['aria-checked'] === 'true', '点击后应先乐观置为开')
  await new Promise((r) => setTimeout(r, 0))
  tree = renderTab()
  assert(sw().props['aria-checked'] === 'false', '写盘失败后必须回滚成关闭')
  const err = byClass(tree, 'qqg-status-err').map(textOf).join('|')
  assert(err.includes('保存失败'), `缺少失败提示，实际：${err.slice(0, 120)}`)
  MUTATE_FAIL = false
})

check('文本输入：击键不写盘，失焦才 mutate（OneBot WebSocket 地址）', () => {
  MUTATIONS.length = 0
  MUTATE_FAIL = false
  let tree = resetTab('settings')
  const input = () => byLabel(tree, 'WebSocket 地址')[0]
  input().props.onChange({ target: { value: 'ws://127.0.0.1:9777' } })
  assert(MUTATIONS.length === 0, '击键阶段不该写盘（会每敲一个字刷一次配置）')
  tree = renderTab()
  assert(input().props.value === 'ws://127.0.0.1:9777', '打字期间输入框应显示草稿')
  input().props.onBlur()
  assert(MUTATIONS.length === 1, '失焦后应写一次')
  assert(MUTATIONS[0][0].path.join('.') === 'onebot.wsUrl', '写错路径')
})

/* 轮询隔离：静态检查（结构约束，树级别测不出「父级是否持有 state」） */
function fnBody(name) {
  const start = SOURCE.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`找不到函数 ${name}`)
  const next = SOURCE.indexOf('\n    function ', start + 10)
  return SOURCE.slice(start, next > 0 ? next : undefined)
}
check('轮询隔离：SettingsPanel 不持有任何轮询 state', () => {
  const body = fnBody('SettingsPanel')
  for (const hook of ['useBridgeStatus(', 'useBridgeProc(', 'useSystemEvents(']) {
    assert(!body.includes(hook), `SettingsPanel 里还有 ${hook}：每次轮询都会把整个面板带着重渲染`)
  }
})
check('轮询隔离：状态/日志/进程数据只在叶子组件里 setState', () => {
  assert(fnBody('SessionsBadge').includes('useBridgeStatus(true)'), 'SessionsBadge 应自己轮询会话未读')
  assert(fnBody('GuideNavButton').includes('useBridgeProc(true)'), 'GuideNavButton 应自己轮询桥接进程')
  assert(fnBody('StatusLive').includes('useBridgeStatus(true)'), 'StatusLive 应自己轮询运行状态')
  assert(fnBody('SessionsTab').includes('useBridgeStatus(true)'), 'SessionsTab 应自己轮询会话列表')
  assert(fnBody('OnboardingModal').includes('useBridgeProc('), 'OnboardingModal 应自己轮询进程状态')
})

await checkAsync('Loading：耗时按钮 pending 时出现纯 CSS spinner + 按钮禁用', async () => {
  assert(SOURCE.includes('@keyframes qqg-spin'), '缺少 spinner 的 CSS 动画')
  assert(SOURCE.includes('.qqg-spin {'), '缺少 .qqg-spin 样式')
  let tree = resetTab('status')
  const startBtn = findAll(tree, (n) => n.tag === 'button' && textOf(n).includes('启动桥接'))[0]
  assert(startBtn, '运行状态页找不到「启动桥接」')
  const pending = startBtn.props.onClick()
  tree = renderTab()
  const busyBtn = findAll(tree, (n) => n.tag === 'button' && textOf(n).includes('启动中'))[0]
  assert(busyBtn, '点击后没有进入「启动中…」态')
  assert(busyBtn.props.disabled === true, 'pending 时按钮必须禁用（防重复点击）')
  assert(spinNodes(busyBtn).length === 1, 'pending 按钮里没有 .qqg-spin')
  await pending
})

console.log(`\n结果：${pass} 通过 / ${process.exitCode ? 1 : 0} 失败`)
process.exit(process.exitCode ?? 0)
