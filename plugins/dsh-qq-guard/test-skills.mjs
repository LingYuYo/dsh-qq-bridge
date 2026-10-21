/**
 * 技能 / 插件页的交互逻辑离线测试：拖拽排序、上下移、添加、删除、开关。
 *
 * 做法：把 client.js 里的组件渲染成「元素树」，再直接从树里捞出 onClick / onDrop
 * 回调并调用它们，验证 state 变化后列表顺序与内容确实变了。
 *
 * 用法：node test-skills.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

/* ── 假 React：支持 hooks 与「重渲染」──────────────────────── */
let hookStore = new Map()
let hookKey = 'root'
let hookCursor = 0
const effects = []
const effectCleanups = []
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
  // 真 React 的 effect 在提交后执行。这里只「登记」，不立即执行：
  // 立即执行会让 Modal 的 cleanup 在每次渲染后立刻把 keydown 监听摘掉。
  useEffect(fn) { effects.push(fn) },
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

let mod
// 静音插件自己的 console.error/warn：本测试故意不提供配置通路，
// createRemoteForm 的降级日志会刷屏，但不是被测目标。
const quietConsole = {
  ...console,
  error: () => {}, warn: () => {}, log: (...a) => console.log(...a),
}
const sandbox = {
  window: {
    __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => React) } },
    // 浏览器里 window.setTimeout 存在，goto() 用它等 DOM 挂载后再滚动。
    setTimeout: (fn) => { const t = setTimeout(fn, 0); if (t.unref) t.unref(); return t },
    // Modal 通过 window.addEventListener('keydown') 实现 Esc 关闭，这里记下来供测试调用。
    __keyListeners: [],
    addEventListener(type, fn) { if (type === 'keydown') this.__keyListeners.push(fn) },
    removeEventListener(type, fn) {
      if (type !== 'keydown') return
      const i = this.__keyListeners.indexOf(fn)
      if (i >= 0) this.__keyListeners.splice(i, 1)
    },
  },
  React, console: quietConsole, setTimeout, clearTimeout,
  fetch: async () => { throw new Error('offline') },
  document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} }, getElementById: () => null },
}
vm.createContext(sandbox)
vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })

/* ── 元素树工具 ─────────────────────────────────────────────── */
/** 把元素树展开成「已渲染的节点树」（函数组件就地调用）。 */
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
  return {
    tag: type, props,
    kids: children.map((c, i) => expand(c, `${path}.${type}${i}`)).filter(Boolean),
  }
}

/** 深度优先收集满足条件的节点。 */
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
  // <style> 里的 CSS 也是文本节点，不能算进「页面文案」，否则断言会被样式注释误伤。
  if (node.tag === 'style') return ''
  return (node.kids ?? []).map(textOf).join('')
}

/* ── 装配上下文 ─────────────────────────────────────────────── */
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

const VALUE = {
  ...CONFIG_CATALOG,
  bubbleMaxChars: 30, mergeMaxChars: 15, chunkSize: 1000, sendIntervalMs: 500,
  typingDelay: { enabled: true }, flypitDelayTiers: { short: 200, medium: 450, long: 800 },
  groupAtReply: true, groupAtPosition: 'last', trimEndPunctuation: { enabled: true },
  personaText: '', personaPresetDefault: '', allow: { private: [], groups: [], allowAllWhenEmpty: false },
  onebot: { wsUrl: '', accessToken: '' }, napcat: { dir: '', quickLoginQQ: '' },
  bridge: { dir: '', autoStart: false },
}
const form = {
  getSnapshot: () => ({ status: 'ready', value: VALUE, writable: true, source: 'remote' }),
  subscribe: () => () => {},
  // 真实 Config 的 mutate：按 path 写回 VALUE，这样组件重读 get() 就能看到新值。
  mutate: async (ops) => {
    for (const op of ops) {
      if (op.op !== 'set') continue
      const p = op.path
      let cur = VALUE
      for (let i = 0; i < p.length - 1; i++) {
        if (typeof cur[p[i]] !== 'object' || cur[p[i]] === null) cur[p[i]] = {}
        cur = cur[p[i]]
      }
      cur[p[p.length - 1]] = op.value
    }
    return true
  },
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

/** 渲染 skills Tab，返回展开后的树。
 *  注意：hookStore 必须跨渲染保留（等价于真 React 的 state 持久化），
 *  否则每次「重渲染」都会把 state 重置回初值，测不出交互效果。 */
function renderSkills() {
  effects.length = 0
  return expand(React.createElement(Comp, { remoteForm: form }), 'root')
}

/** 从头开始：清空 state，把 active tab 预置成 skills。 */
function resetSkills() {
  // hook 键格式是 `${树中位置}:${组件名}`。BridgePanel 原地返回 SettingsPanel，
  // 两者位置都是 'root'，所以 SettingsPanel 的键是 `root:SettingsPanel`。
  hookStore = new Map([['root:SettingsPanel#1', 'skills']])
  return renderSkills()
}

/** 取当前列表里所有卡片的标题文字。 */
function tileNames(tree) {
  return findAll(tree, (n) => n.props?.className === 'qqg-tile')
    .map((n) => textOf(findAll(n, (x) => x.props?.className === 'qqg-tile-name')[0]))
}

/** 按 aria-label 找按钮。 */
function btn(tree, label) {
  return findAll(tree, (n) => n.tag === 'button' && n.props?.['aria-label'] === label)[0]
}

/** 按可见文字找按钮。 */
function btnByText(tree, text) {
  return findAll(tree, (n) => n.tag === 'button' && textOf(n).trim() === text)[0]
}

let pass = 0
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) {
    console.log(`  ✗ ${name}\n    ${e.message}`)
    process.exitCode = 1
  }
}
function eq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b)
  if (ja !== jb) throw new Error(`${msg ?? ''} 期望 ${jb}，实际 ${ja}`)
}

/* ── 用例 ───────────────────────────────────────────────────── */
console.log('技能与插件页交互：')

check('初始列表是本地业务数据（发语音在前）', () => {
  const names = tileNames(resetSkills())
  eq(names[0], '发语音', '首项')
  if (!names.includes('防抖合并')) throw new Error('插件组缺少「防抖合并」')
})

check('下移：第一张卡移到第二位', () => {
  let tree = resetSkills()
  const before = tileNames(tree)
  btn(tree, `${before[0]} 下移`).props.onClick({ stopPropagation() {} })
  tree = renderSkills()
  const after = tileNames(tree)
  eq(after[0], before[1], '第二位变首位')
  eq(after[1], before[0], '首位下移一位')
})

check('上移：第二张卡移到首位', () => {
  let tree = resetSkills()
  const before = tileNames(tree)
  btn(tree, `${before[1]} 上移`).props.onClick({ stopPropagation() {} })
  tree = renderSkills()
  eq(tileNames(tree)[0], before[1], '上移生效')
})

check('首项「上移」按钮被禁用', () => {
  const tree = resetSkills()
  const first = tileNames(tree)[0]
  eq(btn(tree, `${first} 上移`).props.disabled, true, '首项上移禁用')
})

check('拖拽排序：第 3 张拖到第 1 张位置', () => {
  let tree = resetSkills()
  const before = tileNames(tree)
  const tiles = findAll(tree, (n) => n.props?.className === 'qqg-tile')
  // 模拟：在 tiles[2] 上开始拖，在 tiles[0] 上放下
  tiles[2].props.onDragStart({ dataTransfer: { setData() {}, effectAllowed: '' } })
  tree = renderSkills()
  const tiles2 = findAll(tree, (n) => n.props?.className === 'qqg-tile')
  tiles2[0].props.onDrop({ preventDefault() {} })
  tree = renderSkills()
  const after = tileNames(tree)
  eq(after[0], before[2], '被拖的卡片落到首位')
})

check('删除：确认后卡片消失', () => {
  let tree = resetSkills()
  const before = tileNames(tree)
  // 点垃圾桶
  findAll(tree, (n) => n.tag === 'button' && n.props?.['aria-label'] === `删除 ${before[0]}`)[0]
    .props.onClick({ stopPropagation() {} })
  tree = renderSkills()
  // 确认框里点「删除」
  btnByText(tree, '删除').props.onClick()
  tree = renderSkills()
  const after = tileNames(tree)
  if (after.includes(before[0])) throw new Error(`「${before[0]}」没有被删掉`)
  eq(after.length, before.length - 1, '数量减一')
})

check('添加：填名字后插入新卡片', () => {
  let tree = resetSkills()
  const before = tileNames(tree)
  // 点「+ 添加技能」
  btnByText(tree, '+ 添加技能').props.onClick()
  tree = renderSkills()
  // 弹窗里的名称输入框
  const input = findAll(tree, (n) => n.tag === 'input' && n.props?.['aria-label'] === '技能名称')[0]
  input.props.onChange({ target: { value: '表情包生成' } })
  tree = renderSkills()
  btnByText(tree, '添加技能').props.onClick()
  tree = renderSkills()
  const after = tileNames(tree)
  if (!after.includes('表情包生成')) throw new Error('新技能没进列表')
  eq(after.length, before.length + 1, '数量加一')
})

check('齿轮：点开设置弹窗，标题带条目名', () => {
  let tree = resetSkills()
  const first = tileNames(tree)[0]
  findAll(tree, (n) => n.tag === 'button' && n.props?.['aria-label'] === `${first} 设置`)[0]
    .props.onClick({ stopPropagation() {} })
  tree = renderSkills()
  const title = textOf(findAll(tree, (x) => x.props?.className === 'qqg-modal-title')[0])
  if (!title.includes(first)) throw new Error(`弹窗标题「${title}」不含条目名`)
})

check('开关：切换后状态文案变「已停用」', () => {
  let tree = resetSkills()
  const tiles = findAll(tree, (n) => n.props?.className === 'qqg-tile')
  const name = tileNames(tree)[0]
  const sw = findAll(tiles[0], (n) => n.tag === 'button' && n.props?.role === 'switch')[0]
  sw.props.onClick()
  tree = renderSkills()
  const t2 = findAll(tree, (n) => n.props?.className === 'qqg-tile')
  const foot = textOf(findAll(t2[0], (x) => x.props?.className === 'qqg-status')[0])
  if (!foot.includes('已停用')) throw new Error(`状态没变，仍是「${foot}」`)
  if (name !== tileNames(tree)[0]) throw new Error('切换开关不该改变排序')
})

check('插件组与技能组各自独立排序', () => {
  let tree = resetSkills()
  const all = tileNames(tree)
  const pluginFirst = all.find((n) => n === '防抖合并')
  btn(tree, `${pluginFirst} 下移`).props.onClick({ stopPropagation() {} })
  tree = renderSkills()
  // 技能组第一项应该还是「发语音」，不受插件组排序影响
  eq(tileNames(tree)[0], '发语音', '技能组首项未受影响')
})

/* ── 会话管理：删除会话 ─────────────────────────────────────── */
console.log('\n会话管理：')

/** 从干净 state 渲染指定 Tab。 */
function resetTab(tab) {
  hookStore = new Map([['root:SettingsPanel#1', tab]])
  effects.length = 0
  const tree = expand(React.createElement(Comp, { remoteForm: form }), 'root')
  flushEffects()
  return tree
}
/** 重渲染（保留 state，等价于真 React 的 setState 后重渲染）。 */
function renderTab() {
  effects.length = 0
  const tree = expand(React.createElement(Comp, { remoteForm: form }), 'root')
  flushEffects()
  return tree
}

/**
 * 执行本轮登记的 useEffect。
 * 假 React 没有提交阶段，而 Modal 的 Esc 关闭依赖 useEffect 里挂的 keydown 监听，
 * 所以这里手动「提交」一次。
 */
function flushEffects() {
  const pending = effects.splice(0)
  for (const fn of pending) {
    const cleanup = fn()
    if (typeof cleanup === 'function') effectCleanups.push(cleanup)
  }
}

function sessionNames(tree) {
  return findAll(tree, (n) => n.props?.className === 'qqg-session-name').map(textOf)
}

check('删除会话：确认后从列表消失', () => {
  let tree = resetTab('sessions')
  const before = sessionNames(tree)
  eq(before.length, 6, '初始 6 条')
  btnByText(tree, '删除会话').props.onClick()
  tree = renderTab()
  // 确认框里的确认按钮文案也是「删除会话」
  const confirmBtns = findAll(tree, (n) => n.tag === 'button' && textOf(n).trim() === '删除会话')
  eq(confirmBtns.length, 2, '页面上有两个同名按钮（触发器 + 确认）')
  confirmBtns[confirmBtns.length - 1].props.onClick()
  tree = renderTab()
  const after = sessionNames(tree)
  eq(after.length, before.length - 1, '数量减一')
  if (after.includes(before[0])) throw new Error(`「${before[0]}」没被删掉`)
})

check('删除全部会话后显示空态', () => {
  let tree = resetTab('sessions')
  for (let i = 0; i < 8; i++) {
    if (sessionNames(tree).length === 0) break
    const delBtns = findAll(tree, (n) => n.tag === 'button' && textOf(n).trim() === '删除会话')
    delBtns[0].props.onClick()
    tree = renderTab()
    const conf = findAll(tree, (n) => n.tag === 'button' && textOf(n).trim() === '删除会话')
    conf[conf.length - 1].props.onClick()
    tree = renderTab()
  }
  const joined = textOf(tree)
  if (!joined.includes('会话列表为空')) throw new Error('没有出现空态')
})

check('取消删除：列表不变', () => {
  let tree = resetTab('sessions')
  const before = sessionNames(tree)
  btnByText(tree, '删除会话').props.onClick()
  tree = renderTab()
  btnByText(tree, '取消').props.onClick()
  tree = renderTab()
  eq(sessionNames(tree), before, '取消后列表不变')
})

/* ── 全局设置：两个弹窗 + 运行节奏大按钮 ───────────────────── */
console.log('\n全局设置：')

/** 左下角「使用引导」按钮（导航底部那颗）。 */
function guideBtn(tree) {
  return findAll(tree, (n) => n.tag === 'button' && n.props?.className === 'qqg-nav-guide')[0]
}

check('「全局设置」页顶部没有引导卡片或按钮', () => {
  const tree = resetTab('settings')
  const joined = textOf(tree)
  if (joined.includes('新手引导')) throw new Error('旧引导卡片还在')
  if (joined.includes('完成度')) throw new Error('引导进度条还在页面里（应只在弹窗内）')
  // 页面里不应再有「使用引导」按钮；它现在只在左侧导航底部。
  const inContent = findAll(tree, (n) => n.tag === 'button'
    && textOf(n).includes('使用引导')
    && n.props?.className !== 'qqg-nav-guide')
  if (inContent.length) throw new Error('「全局设置」内容区还有「使用引导」按钮')
})

check('左侧导航底部有「使用引导」按钮', () => {
  const tree = resetTab('settings')
  const nav = findAll(tree, (n) => n.props?.className === 'qqg-nav')[0]
  if (!nav) throw new Error('找不到左侧导航')
  // 按钮必须在 nav-foot 里（margin-top:auto 沉底），不是普通菜单项
  const foot = findAll(nav, (n) => n.props?.className === 'qqg-nav-foot')[0]
  if (!foot) throw new Error('导航缺少底部容器 .qqg-nav-foot')
  const btn = guideBtn(nav)
  if (!btn) throw new Error('导航底部没有「使用引导」按钮')
  if (!textOf(btn).includes('使用引导')) throw new Error('按钮文案不对')
})

check('「使用引导」弹窗：三步 + 弹窗内去配置/去启动', () => {
  let tree = resetTab('settings')
  guideBtn(tree).props.onClick()
  tree = renderTab()
  eq(findAll(tree, (n) => n.props?.className === 'qqg-mask').length, 1, '出现一个遮罩')
  const joined = textOf(tree)
  for (const k of ['NapCat 进程', '白名单', '桥接进程']) {
    if (!joined.includes(k)) throw new Error(`引导弹窗缺「${k}」`)
  }
  if (!joined.includes('去配置')) throw new Error('引导弹窗缺「去配置」')
})

check('「去配置」会关弹窗并切到全局设置', () => {
  let tree = resetTab('status')
  guideBtn(tree).props.onClick()
  tree = renderTab()
  eq(findAll(tree, (n) => n.props?.className === 'qqg-mask').length, 1, '弹窗已开')
  btnByText(tree, '去配置').props.onClick()
  tree = renderTab()
  eq(findAll(tree, (n) => n.props?.className === 'qqg-mask').length, 0, '弹窗已关')
  // 应该已经切到「全局设置」Tab
  const on = findAll(tree, (n) => n.props?.className?.includes('qqg-nav-item-on'))
  const label = on.length ? textOf(on[0]) : ''
  if (!label.includes('全局设置')) throw new Error(`未切到全局设置，当前选中「${label}」`)
})

check('「运行节奏」卡片只有两个大按钮', () => {
  const tree = resetTab('settings')
  const bigs = findAll(tree, (n) => n.props?.className === 'qqg-bigbtn')
  eq(bigs.map((b) => textOf(findAll(b, (x) => x.props?.className === 'qqg-bigbtn-name')[0])),
    ['信息发送配置', '活跃设置'], '两个大按钮')
})

check('点「信息发送配置」打开分片+打字延时弹窗', () => {
  let tree = resetTab('settings')
  findAll(tree, (n) => n.props?.className === 'qqg-bigbtn')[0].props.onClick()
  tree = renderTab()
  const joined = textOf(tree)
  for (const k of ['单行语义切阈值', '碎片合并上限', 'QQ 单条硬上限', '分级打字延时', '短句（<10 字）']) {
    if (!joined.includes(k)) throw new Error(`发送配置弹窗缺「${k}」`)
  }
})

check('点「活跃设置」打开档位+防抖+禁言弹窗', () => {
  let tree = resetTab('settings')
  findAll(tree, (n) => n.props?.className === 'qqg-bigbtn')[1].props.onClick()
  tree = renderTab()
  const joined = textOf(tree)
  for (const k of ['响应档位', '仅艾特', '+关键词', '+随机', '全响应',
    '防抖合并窗口', '批次间隔', '指令禁言', '禁言指令词', '禁言时长']) {
    if (!joined.includes(k)) throw new Error(`活跃设置弹窗缺「${k}」`)
  }
  const slider = findAll(tree, (n) => n.tag === 'input' && n.props?.type === 'range')[0]
  if (!slider) throw new Error('缺少响应档位滑动条')
  eq([slider.props.min, slider.props.max], [0, 3], '滑条范围 0~3')
})

check('活跃设置：滑条写回 rhythm.activityLevel（真实配置）', () => {
  let tree = resetTab('settings')
  findAll(tree, (n) => n.props?.className === 'qqg-bigbtn')[1].props.onClick()
  tree = renderTab()
  const slider = findAll(tree, (n) => n.tag === 'input' && n.props?.type === 'range')[0]
  if (!slider) throw new Error('缺少响应档位滑条')
  slider.props.onChange({ target: { value: '3' } })
  if (VALUE.rhythm.activityLevel !== 3) throw new Error('没写回配置，实际 ' + VALUE.rhythm.activityLevel)
  tree = renderTab()
  const joined = textOf(tree)
  if (!joined.includes('全响应')) throw new Error('界面没跟着配置更新')
})

check('活跃设置：禁言开关写回 rhythm.mute.enabled', () => {
  let tree = resetTab('settings')
  findAll(tree, (n) => n.props?.className === 'qqg-bigbtn')[1].props.onClick()
  tree = renderTab()
  const sw = findAll(tree, (n) => n.tag === 'button' && n.props?.role === 'switch' && n.props?.['aria-label'] === '指令禁言')[0]
  if (!sw) throw new Error('找不到「指令禁言」开关')
  sw.props.onClick()
  if (VALUE.rhythm.mute.enabled !== false) throw new Error('没写回配置，实际 ' + VALUE.rhythm.mute.enabled)
})

check('活跃设置：防抖窗口写回 rhythm.debounceWindowMs', () => {
  let tree = resetTab('settings')
  findAll(tree, (n) => n.props?.className === 'qqg-bigbtn')[1].props.onClick()
  tree = renderTab()
  const input = findAll(tree, (n) => n.tag === 'input' && n.props?.['aria-label'] === '防抖合并窗口（毫秒）')[0]
  if (!input) throw new Error('找不到防抖窗口输入框')
  input.props.onChange({ target: { value: '1200' } })
  if (VALUE.rhythm.debounceWindowMs !== 1200) throw new Error('没写回配置，实际 ' + VALUE.rhythm.debounceWindowMs)
})

check('Esc 关闭弹窗（模拟 keydown）', () => {
  let tree = resetTab('settings')
  guideBtn(tree).props.onClick()
  tree = renderTab()
  eq(findAll(tree, (n) => n.props?.className === 'qqg-mask').length, 1, '弹窗已开')
  const listeners = sandbox.window.__keyListeners ?? []
  if (listeners.length === 0) throw new Error('Modal 没有注册 keydown 监听')
  listeners[listeners.length - 1]({ key: 'Escape' })
  tree = renderTab()
  eq(findAll(tree, (n) => n.props?.className === 'qqg-mask').length, 0, 'Esc 后弹窗关闭')
})

/* ── 全局设置：bridge.autoStart 开关 ────────────────────────── */
console.log('\n全局设置 · 自动拉起桥接：')

/** 按 aria-label 找 switch。 */
function switchByLabel(tree, label) {
  return findAll(tree, (n) => n.tag === 'button' && n.props?.role === 'switch'
    && n.props?.['aria-label'] === label)[0]
}

check('「OneBot 连接」里有 autoStart 开关，默认关', () => {
  VALUE.bridge.autoStart = false
  const tree = resetTab('settings')
  const sw = switchByLabel(tree, 'DSH 启动时自动拉起桥接进程')
  if (!sw) throw new Error('找不到「DSH 启动时自动拉起桥接进程」开关')
  eq(sw.props['aria-checked'], 'false', '默认应为关闭')
})

check('autoStart 说明文案包含热重载提醒', () => {
  const tree = resetTab('settings')
  const joined = textOf(tree)
  if (!joined.includes('修改插件配置会导致热重载，开启此项可防止桥接掉线。')) {
    throw new Error('缺少说明文案「修改插件配置会导致热重载，开启此项可防止桥接掉线」')
  }
})

check('切换 autoStart 写回 bridge.autoStart（真实配置）', () => {
  VALUE.bridge.autoStart = false
  let tree = resetTab('settings')
  switchByLabel(tree, 'DSH 启动时自动拉起桥接进程').props.onClick()
  eq(VALUE.bridge.autoStart, true, '配置没写回')
  tree = renderTab()
  eq(switchByLabel(tree, 'DSH 启动时自动拉起桥接进程').props['aria-checked'], 'true', '界面没跟着更新')
})

console.log(`\n结果：${pass} 通过 / ${process.exitCode ? 1 : 0} 失败`)
// client.js 里的 createRemoteForm 会起重试定时器（真实环境靠 fiber 卸载清理），
// 这里必须显式退出，否则 node 会一直等定时器。
process.exit(process.exitCode ?? 0)
