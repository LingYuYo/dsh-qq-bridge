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
    { id: 'sk-memory', name: '记忆与上下文', icon: 'memory', tag: '内置', ver: '2.0.0', enabled: true, desc: '注入聊天记录' },
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
  typingDelayCharTiers: { shortMax: 10, mediumMax: 14, longMin: 15 },
  voice: { provider: 'edge', baseUrl: '', apiKey: '', voice: 'zh-CN-XiaoyiNeural' },
  groupAtReply: true, groupAtPosition: 'last', trimEndPunctuation: { enabled: true },
  personaText: '', personaPresetDefault: '', allow: { private: [], groups: [], allowAllWhenEmpty: false },
  onebot: { wsUrl: '', accessToken: '' }, napcat: { dir: '', quickLoginQQ: '' },
  bridge: { dir: '', autoStart: false },
  // 2026-10-27 新增三张卡用的配置块。
  quote: { forwardMaxImages: 3 },
  contextAware: { enabled: true, pokeTurns: 15, messageTurns: 0, smartMatch: true },
  memory: { enabled: true, pokeMaxTurns: 15, messageMaxTurns: 0, maxContextTokens: 128000, smartMatch: true },
  timeAware: {
    enabled: true,
    silentMinutes: 30,
    promptText: '[系统提示：群聊已经安静了 N 分钟，刚刚有人说话了，请表现得像刚回过神一样]',
  },
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

check('会话管理：桥接未上报时显示等待态，不再有假会话', () => {
  const tree = resetTab('sessions')
  eq(sessionNames(tree).length, 0, '★ 不允许再渲染假的会话列表')
  const joined = textOf(tree)
  if (!joined.includes('等待桥接上报')) throw new Error('没有出现「等待桥接上报」空态')
})

check('会话管理：页面明确说明数据来自桥接进程', () => {
  const tree = resetTab('sessions')
  const joined = textOf(tree)
  if (!joined.includes('桥接进程')) throw new Error('缺少「数据由桥接上报」的说明')
})

check('管理员 QQ 号：输入后添加/删除，写回 allow.admins', () => {
  VALUE.allow.admins = []
  let tree = resetTab('settings')
  const input = () => findAll(tree, (n) => n.tag === 'input' && n.props?.['aria-label'] === '管理员 QQ 号')[0]
  if (!input()) throw new Error('缺「管理员 QQ 号」输入框')
  input().props.onChange({ target: { value: '1000000001' } })
  tree = renderTab()
  btn(tree, '管理员 QQ 号 添加').props.onClick()
  tree = renderTab()
  eq(VALUE.allow.admins, ['1000000001'], '写回 allow.admins')
  const remove = findAll(tree, (n) => n.tag === 'button' && n.props?.['aria-label'] === '删除 1000000001')[0]
  if (!remove) throw new Error('缺删除管理员按钮')
  remove.props.onClick()
  tree = renderTab()
  eq(VALUE.allow.admins, [], '删除后清空')
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
  // 毫秒档标签跟随字数档位当前值，期望文案按夹具动态拼。
  const tiers = VALUE.typingDelayCharTiers
  for (const k of ['单行语义切阈值', '碎片合并上限', 'QQ 单条硬上限', '分级打字延时',
    `短句（<${tiers.shortMax} 字）`, `中等（${tiers.shortMax}~${tiers.mediumMax} 字）`, `长句（${tiers.longMin}+ 字）`,
    '短句上限字数', '中等上限字数', '长句触发字数']) {
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

check('活跃设置：滑条拖动只改草稿，松手才写回 rhythm.activityLevel', () => {
  let tree = resetTab('settings')
  findAll(tree, (n) => n.props?.className === 'qqg-bigbtn')[1].props.onClick()
  tree = renderTab()
  const slider = findAll(tree, (n) => n.tag === 'input' && n.props?.type === 'range')[0]
  if (!slider) throw new Error('缺少响应档位滑条')
  eq([slider.props.min, slider.props.max], [0, 3], '滑条范围 0~3')
  // 模拟拖到 3：拖动过程中只更新本地草稿，不写配置（否则会因异步回读把 thumb 弹回）。
  slider.props.onInput({ target: { value: '3' } })
  eq(VALUE.rhythm.activityLevel, 1, '拖动过程中不该写配置')
  slider.props.onPointerUp()
  eq(VALUE.rhythm.activityLevel, 3, '松手后应写回配置')
  tree = renderTab()
  const joined = textOf(tree)
  if (!joined.includes('全响应')) throw new Error('界面没跟着配置更新')
})

check('打字延时：三个字数档位可改并写回 typingDelayCharTiers.*', () => {
  let tree = resetTab('settings')
  findAll(tree, (n) => n.props?.className === 'qqg-bigbtn')[0].props.onClick()
  tree = renderTab()
  const field = (label) => findAll(tree, (n) => n.tag === 'input'
    && n.props?.['aria-label'] === label)[0]
  const shortNode = field('短句上限字数')
  if (!shortNode) throw new Error('缺少「短句上限字数」输入框')
  eq(String(shortNode.props.value), '10', '短句上限默认 10')
  const commit = (label, value) => {
    let node = field(label)
    if (!node) throw new Error(`缺少「${label}」`)
    node.props.onChange({ target: { value } })
    tree = renderTab()
    node = field(label)
    node.props.onBlur()
    tree = renderTab()
  }
  commit('短句上限字数', '12')
  commit('中等上限字数', '18')
  commit('长句触发字数', '20')
  eq(VALUE.typingDelayCharTiers, { shortMax: 12, mediumMax: 18, longMin: 20 }, '字数档位写回')
  // 毫秒档标签要跟着新边界走，不能停在默认的 10 / 14 / 15。
  const joined = textOf(tree)
  for (const k of ['短句（<12 字）', '中等（12~18 字）', '长句（20+ 字）']) {
    if (!joined.includes(k)) throw new Error(`毫秒档标签没跟随配置更新：缺「${k}」`)
  }
})

check('语音合成：默认 Edge 隐藏 baseUrl / Key，切到 openai 后可写回 voice.*', () => {
  VALUE.voice = { provider: 'edge', baseUrl: '', apiKey: '', voice: 'zh-CN-XiaoyiNeural' }
  let tree = resetTab('settings')
  const voiceSelect = () => findAll(tree, (n) => n.tag === 'select'
    && n.props?.['aria-label'] === '语音引擎')[0]
  if (!voiceSelect()) throw new Error('缺少「语音引擎」下拉')
  eq(voiceSelect().props.value, 'edge', '默认 Edge')
  if (findAll(tree, (n) => n.props?.['aria-label'] === '接口地址（baseUrl）').length) {
    throw new Error('Edge 模式不该显示 baseUrl')
  }
  voiceSelect().props.onChange({ target: { value: 'openai' } })
  eq(VALUE.voice.provider, 'openai', '写回 voice.provider')
  tree = renderTab()
  const input = (label) => findAll(tree, (n) => n.tag === 'input'
    && n.props?.['aria-label'] === label)[0]
  // P2：文本输入改成「失焦才保存」，所以要先 onChange 更新草稿、重渲染拿到新闭包，
  // 再 onBlur 提交。击键阶段绝不能写盘。
  const commitText = (label, value) => {
    let node = input(label)
    if (!node) throw new Error(`缺少「${label}」`)
    node.props.onChange({ target: { value } })
    tree = renderTab()
    input(label).props.onBlur()
    tree = renderTab()
  }
  // P2：击键阶段只改草稿，绝不写盘；失焦才提交。
  input('接口地址（baseUrl）').props.onChange({ target: { value: 'https://api.openai.com/v1' } })
  eq(VALUE.voice.baseUrl, '', '击键阶段不该写盘（应等 onBlur）')
  tree = renderTab()
  input('接口地址（baseUrl）').props.onBlur()
  eq(VALUE.voice.baseUrl, 'https://api.openai.com/v1', '失焦后写回 voice.baseUrl')
  tree = renderTab()
  const apiKey = input('语音 API Key')
  if (!apiKey) throw new Error('openai 模式缺少 API Key')
  eq(apiKey.props.type, 'password', 'API Key 应为密码框')
  commitText('语音 API Key', 'sk-test')
  eq(VALUE.voice.apiKey, 'sk-test', '失焦后写回 voice.apiKey')
  commitText('音色', 'alloy')
  eq(VALUE.voice.voice, 'alloy', '失焦后写回 voice.voice')
})

check('技能卡片：已实装显示「已接入」，其余显示「开发中」', () => {
  // 前面的排序 / 删除用例会改 VALUE.skills；这里先还原夹具，避免依赖执行顺序。
  VALUE.skills = CONFIG_CATALOG.skills.map((x) => ({ ...x }))
  VALUE.plugins = CONFIG_CATALOG.plugins.map((x) => ({ ...x }))
  const tree = resetSkills()
  const tileOf = (name) => findAll(tree, (n) => n.props?.className === 'qqg-tile')
    .find((t) => textOf(findAll(t, (x) => x.props?.className === 'qqg-tile-name')[0]) === name)
  const tagOf = (name) => {
    const tile = tileOf(name)
    if (!tile) throw new Error(`找不到卡片「${name}」`)
    return findAll(tile, (n) => typeof n.props?.className === 'string'
      && n.props.className.split(' ').includes('qqg-pill'))[0]
  }
  const textOfTag = (name) => textOf(tagOf(name))
  eq(textOfTag('发语音'), '已接入', 'sk-voice')
  eq(textOfTag('图片理解'), '已接入', 'sk-vision')
  eq(textOfTag('网页搜索'), '已接入', 'sk-search')
  // 2026-10-27 合并：这张卡现在有真实字段（总闸 / 条数 / 容量 / 智能匹配），标「已接入」。
  eq(textOfTag('记忆与上下文'), '已接入', 'sk-memory')
  eq(textOfTag('防抖合并'), '已接入', 'pl-debounce')
  eq(textOfTag('频率控制'), '已接入', 'pl-ratelimit')
  eq(textOfTag('上下文压缩'), '开发中', 'pl-compact')
  // 用 CSS class 区分状态：已接入带 qqg-pill-ok，开发中不带。
  const hasOkClass = (name) => tagOf(name).props.className.split(' ').includes('qqg-pill-ok')
  if (!hasOkClass('发语音')) throw new Error('「已接入」标签缺少 qqg-pill-ok')
  if (!hasOkClass('记忆与上下文')) throw new Error('「记忆与上下文」应标为已接入')
  if (hasOkClass('上下文压缩')) throw new Error('「开发中」标签不该带 qqg-pill-ok')
  // 旧的「上下文感知」卡已合并，不应该再出现在列表里。
  if (tileOf('上下文感知')) throw new Error('sk-context 应已合并进「记忆与上下文」，不该单独成卡')
})

/* ── P2：默认技能 sk-image（发图片）的合并与写回 ───────────── */
console.log('\nP2 · 默认技能「发图片」（sk-image）：')

/** 取某个标题的卡片节点。 */
function tileOf(tree, name) {
  return findAll(tree, (n) => n.props?.className === 'qqg-tile')
    .find((t) => textOf(findAll(t, (x) => x.props?.className === 'qqg-tile-name')[0]) === name)
}

check('老配置里没有 sk-image → 面板补出「发图片」且默认启用', () => {
  VALUE.skills = CONFIG_CATALOG.skills.map((x) => ({ ...x }))  // 夹具里不含 sk-image
  const tree = resetSkills()
  if (!tileNames(tree).includes('发图片')) throw new Error('没有合并默认技能「发图片」')
  const tile = tileOf(tree, '发图片')
  const sw = findAll(tile, (n) => n.tag === 'button' && n.props?.role === 'switch')[0]
  if (!sw) throw new Error('「发图片」卡片没有开关')
  eq(sw.props['aria-checked'], 'true', '默认项应默认启用')
  // 它是 P2 实装的技能，标签应为「已接入」。
  const pill = findAll(tile, (n) => typeof n.props?.className === 'string'
    && n.props.className.split(' ').includes('qqg-pill'))[0]
  eq(textOf(pill), '已接入', 'sk-image 应标为已接入')
})

check('切「发图片」开关 → 写回整数组（含 sk-image，enabled=false）', () => {
  VALUE.skills = CONFIG_CATALOG.skills.map((x) => ({ ...x }))
  let tree = resetSkills()
  const tile = tileOf(tree, '发图片')
  const sw = findAll(tile, (n) => n.tag === 'button' && n.props?.role === 'switch')[0]
  sw.props.onClick()
  // 写回后重渲染：状态行跟着配置走。
  // （「乐观更新在写盘前就生效」由 test-shell-ui 的 overrides 用例覆盖——这里的假
  //  form.mutate 是同步写值，所以本用例只能证明写回内容正确，不能证明乐观时序。）
  tree = renderSkills()
  const after = findAll(tileOf(tree, '发图片'), (n) => n.props?.className === 'qqg-status')[0]
  if (!textOf(after).includes('已停用')) throw new Error(`开关没立刻生效：${textOf(after)}`)
  const written = VALUE.skills
  const sk = written.find((x) => x.id === 'sk-image')
  if (!sk) throw new Error('写回的数组里没有 sk-image（老配置点一下就丢了默认项）')
  eq(sk.enabled, false, '写回的 sk-image.enabled')
  // 2026-10-27 合并后：默认技能补 sk-poke / sk-quote / sk-memory / sk-time-aware；
  // 2026-10-28（v2.0）再补 sk-unread，合并后是 catalog + 5。
  // （夹具里本来就有 sk-memory 一条，所以只补 5 个。）
  eq(written.length, CONFIG_CATALOG.skills.length + 5, '写回的是合并后的整数组（补 5 个内置技能）')
  for (const id of ['sk-poke', 'sk-quote', 'sk-memory', 'sk-time-aware', 'sk-unread']) {
    if (!written.find((x) => x.id === id)) throw new Error(`写回的数组里没有 ${id}（新默认项丢了）`)
  }
  // 合并迁移：写回的清单里不能再留着旧的 sk-context。
  if (written.find((x) => x.id === 'sk-context')) throw new Error('写回的数组里不该再有 sk-context')
})

check('老配置里没有 sk-poke → 面板补出「戳一戳回复」卡片', () => {
  VALUE.skills = CONFIG_CATALOG.skills.map((x) => ({ ...x }))
  const tree = resetSkills()
  if (!tileNames(tree).includes('戳一戳回复')) throw new Error('没有合并默认技能「戳一戳回复」')
  const tile = tileOf(tree, '戳一戳回复')
  const pill = findAll(tile, (n) => typeof n.props?.className === 'string'
    && n.props.className.split(' ').includes('qqg-pill'))[0]
  eq(textOf(pill), '已接入', 'sk-poke 应标为已接入')
})

check('老配置里没有 sk-time-aware → 面板补出「时间感知」卡片，且标为已接入', () => {
  VALUE.skills = CONFIG_CATALOG.skills.map((x) => ({ ...x }))
  const tree = resetSkills()
  if (!tileNames(tree).includes('时间感知')) throw new Error('没有合并默认技能「时间感知」')
  const tile = tileOf(tree, '时间感知')
  const pill = findAll(tile, (n) => typeof n.props?.className === 'string'
    && n.props.className.split(' ').includes('qqg-pill'))[0]
  eq(textOf(pill), '已接入', 'sk-time-aware 应标为已接入')
})

check('戳一戳回复：齿轮弹窗 → 列表可增删，保存写回 poke.replies', () => {
  VALUE.skills = [
    ...CONFIG_CATALOG.skills.map((x) => ({ ...x })),
    { id: 'sk-poke', name: '戳一戳回复', icon: 'activity', tag: '内置', ver: '1.0.0',
      enabled: true, desc: '被戳时回一条' },
  ]
  VALUE.poke = { enabled: true, mode: 'text', replyText: '兜底一句', replies: [] }
  let tree = resetSkills()
  btn(tree, '戳一戳回复 设置').props.onClick({ stopPropagation() {} })
  tree = renderSkills()
  // mode=text 才显示列表；空列表给「没有回复」的提示。
  const action = btnByText(tree, '+ 添加一条回复')
  if (!action) throw new Error('弹窗里没有「+ 添加一条回复」')
  action.props.onClick()
  tree = renderSkills()
  if (!btnByText(tree, '删除')) throw new Error('加了一条之后没有「删除」按钮')
  // 保存 → 整数组写回 poke.replies（草稿是空图文条目）。
  btnByText(tree, '保存').props.onClick()
  eq(VALUE.poke.replies, [{ text: '', image: '' }], '保存应写回整数组')
})

check('戳一戳回复：mode=poke 时列表字段隐藏（回戳用不上）', () => {
  VALUE.skills = [
    ...CONFIG_CATALOG.skills.map((x) => ({ ...x })),
    { id: 'sk-poke', name: '戳一戳回复', icon: 'activity', tag: '内置', ver: '1.0.0',
      enabled: true, desc: '被戳时回一条' },
  ]
  VALUE.poke = { enabled: true, mode: 'poke', replyText: '兜底一句', replies: [] }
  let tree = resetSkills()
  btn(tree, '戳一戳回复 设置').props.onClick({ stopPropagation() {} })
  tree = renderSkills()
  if (btnByText(tree, '+ 添加一条回复')) throw new Error('mode=poke 不该显示回复列表')
})

check('配置里已有 sk-image → 不重复追加', () => {
  VALUE.skills = [
    ...CONFIG_CATALOG.skills.map((x) => ({ ...x })),
    { id: 'sk-image', name: '发图片', icon: 'image', tag: '内置', ver: '1.0.0', enabled: false, desc: '已有条目' },
  ]
  const tree = resetSkills()
  const count = tileNames(tree).filter((n) => n === '发图片').length
  eq(count, 1, '「发图片」出现了多张')
  const sw = findAll(tileOf(tree, '发图片'), (n) => n.tag === 'button' && n.props?.role === 'switch')[0]
  eq(sw.props['aria-checked'], 'false', '应沿用配置里的 enabled=false')
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

check('活跃设置：防抖窗口失焦后写回 rhythm.debounceWindowMs（击键不写盘）', () => {
  let tree = resetTab('settings')
  findAll(tree, (n) => n.props?.className === 'qqg-bigbtn')[1].props.onClick()
  tree = renderTab()
  const input = () => findAll(tree, (n) => n.tag === 'input' && n.props?.['aria-label'] === '防抖合并窗口（毫秒）')[0]
  if (!input()) throw new Error('找不到防抖窗口输入框')
  input().props.onChange({ target: { value: '1200' } })
  if (VALUE.rhythm.debounceWindowMs !== 800) throw new Error('击键阶段不该写盘，实际 ' + VALUE.rhythm.debounceWindowMs)
  tree = renderTab()
  input().props.onBlur()
  if (VALUE.rhythm.debounceWindowMs !== 1200) throw new Error('失焦后没写回配置，实际 ' + VALUE.rhythm.debounceWindowMs)
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

// ── 2026-10-27 真机 Bug：在输入框里长按拖拽、滑到弹窗外松手，弹窗被误关 ──
check('★ 遮罩只在「按下 + 松开都在遮罩上」时才关闭（拖拽误关回归）', () => {
  VALUE.skills = [
    ...CONFIG_CATALOG.skills.map((x) => ({ ...x })),
    { id: 'sk-quote', name: '聊天记录解析', icon: 'search', tag: '内置', ver: '1.0.0',
      enabled: true, desc: '合并转发读图' },
  ]
  VALUE.quote = { forwardMaxImages: 3 }
  const maskOf = (t) => findAll(t, (n) => n.props?.className === 'qqg-mask')[0]
  let tree = resetSkills()
  btn(tree, '聊天记录解析 设置').props.onClick({ stopPropagation() {} })
  tree = renderSkills()
  let mask = maskOf(tree)
  eq(Boolean(mask), true, '齿轮弹窗应已打开')
  const input = findAll(mask, (n) => n.tag === 'input')[0]
  if (!input) throw new Error('弹窗里没有输入框')

  // ① 输入框里按下 → 拖到遮罩上松手：浏览器会把 click 派发到共同祖先（遮罩），
  //    旧实现只看 click.target 就直接关了 → 必须不关。
  mask.props.onMouseDown({ target: input, currentTarget: mask })
  mask.props.onMouseUp({ target: mask, currentTarget: mask })
  mask.props.onClick({ target: mask, currentTarget: mask })
  tree = renderSkills()
  eq(findAll(tree, (n) => n.props?.className === 'qqg-mask').length, 1,
    '输入框拖到遮罩松手不能关弹窗')

  // ② 反过来：遮罩上按下 → 拖进弹窗内容里松手，click 仍落在遮罩 → 也不该关。
  mask = maskOf(tree)
  mask.props.onMouseDown({ target: mask, currentTarget: mask })
  mask.props.onMouseUp({ target: input, currentTarget: mask })
  mask.props.onClick({ target: mask, currentTarget: mask })
  tree = renderSkills()
  eq(findAll(tree, (n) => n.props?.className === 'qqg-mask').length, 1,
    '遮罩按下、内容里松手也不该关')

  // ③ 按下和松开都在遮罩上 → 正常关闭。
  mask = maskOf(tree)
  mask.props.onMouseDown({ target: mask, currentTarget: mask })
  mask.props.onMouseUp({ target: mask, currentTarget: mask })
  mask.props.onClick({ target: mask, currentTarget: mask })
  tree = renderSkills()
  eq(findAll(tree, (n) => n.props?.className === 'qqg-mask').length, 0, '正常点遮罩应关闭')
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

check('聊天记录解析卡片：齿轮里能改「最大读取图片数」并写回', () => {
  VALUE.skills = [
    ...CONFIG_CATALOG.skills.map((x) => ({ ...x })),
    { id: 'sk-quote', name: '聊天记录解析', icon: 'search', tag: '内置', ver: '1.0.0',
      enabled: true, desc: '合并转发读图' },
  ]
  VALUE.quote = { forwardMaxImages: 3 }
  let tree = resetSkills()
  btn(tree, '聊天记录解析 设置').props.onClick({ stopPropagation() {} })
  tree = renderSkills()
  const input = findAll(tree, (n) => n.tag === 'input'
    && n.props?.['aria-label'] === '聊天记录最大读取图片数')[0]
  if (!input) throw new Error('缺少「聊天记录最大读取图片数」输入框')
  input.props.onChange({ target: { value: '5' } })
  tree = renderSkills()
  btnByText(tree, '保存').props.onClick()
  eq(VALUE.quote.forwardMaxImages, 5, '应写回 quote.forwardMaxImages')
})

check('记忆与上下文卡片：总闸 / 两个条数 / 智能匹配分别写回', () => {
  VALUE.skills = [
    ...CONFIG_CATALOG.skills.map((x) => ({ ...x })),
  ]
  VALUE.memory = { enabled: true, pokeMaxTurns: 15, messageMaxTurns: 0, maxContextTokens: 128000, smartMatch: true }
  let tree = resetSkills()
  btn(tree, '记忆与上下文 设置').props.onClick({ stopPropagation() {} })
  tree = renderSkills()
  const pokeInput = findAll(tree, (n) => n.tag === 'input'
    && n.props?.['aria-label'] === '戳一戳读取轮次')[0]
  if (!pokeInput) throw new Error('缺少「戳一戳读取轮次」输入框')
  pokeInput.props.onChange({ target: { value: '8' } })
  tree = renderSkills()
  const msgInput = findAll(tree, (n) => n.tag === 'input'
    && n.props?.['aria-label'] === '普通消息读取轮次')[0]
  if (!msgInput) throw new Error('缺少「普通消息读取轮次」输入框')
  msgInput.props.onChange({ target: { value: '4' } })
  tree = renderSkills()
  // 智能匹配开关：默认开 → 关掉后保存要写回 memory.smartMatch=false
  const smart = switchByLabel(tree, '智能匹配')
  if (!smart) throw new Error('缺少「智能匹配」开关')
  eq(smart.props['aria-checked'], 'true', '智能匹配默认应为开启')
  smart.props.onClick()
  tree = renderSkills()
  btnByText(tree, '保存').props.onClick()
  eq(VALUE.memory.pokeMaxTurns, 8, '应写回 memory.pokeMaxTurns')
  eq(VALUE.memory.messageMaxTurns, 4, '应写回 memory.messageMaxTurns')
  eq(VALUE.memory.enabled, true, '开关保持开启')
  eq(VALUE.memory.smartMatch, false, '应写回 memory.smartMatch')
})

check('记忆与上下文：容量滑条 128K~1M 共 8 档，拖动实时显示读数，松手才写回', () => {
  VALUE.skills = CONFIG_CATALOG.skills.map((x) => ({ ...x }))
  VALUE.memory = { enabled: true, pokeMaxTurns: 15, messageMaxTurns: 0, maxContextTokens: 128000, smartMatch: true }
  let tree = resetSkills()
  btn(tree, '记忆与上下文 设置').props.onClick({ stopPropagation() {} })
  tree = renderSkills()
  const slider = findAll(tree, (n) => n.tag === 'input'
    && n.props?.type === 'range' && n.props?.['aria-label'] === '上下文容量')[0]
  if (!slider) throw new Error('缺少「上下文容量」滑条')
  eq([slider.props.min, slider.props.max, slider.props.step], [1, 8, 1], '滑条是 1~8 档')
  // 默认 128000 落在第 1 档。
  eq(slider.props.value, 1, '默认 128K 应对应第 1 档')
  const tickText = textOf(findAll(tree, (n) => n.props?.className === 'qqg-slider-ticks-ends')[0])
  if (!tickText.includes('128K') || !tickText.includes('1M')) {
    throw new Error(`刻度两端应为 128K / 1M，实际：${tickText}`)
  }
  // 读数：未拖动时显示真实值的 K 记法。
  const valueOf = () => textOf(findAll(tree, (n) => n.props?.className === 'qqg-slider-value')[0])
  eq(valueOf(), '128K', '初始读数')
  // 拖到第 4 档（512K）：拖动过程中只刷新读数，不写配置。
  slider.props.onInput({ target: { value: '4' } })
  tree = renderSkills()
  eq(valueOf(), '512K', '拖动中读数应实时刷新')
  eq(VALUE.memory.maxContextTokens, 128000, '拖动过程中不该写配置')
  // 松手：同一实例上先 move 再 commit（重渲染会换实例，pending 归位）。
  const slider2 = findAll(tree, (n) => n.tag === 'input'
    && n.props?.type === 'range' && n.props?.['aria-label'] === '上下文容量')[0]
  slider2.props.onInput({ target: { value: '4' } })
  slider2.props.onPointerUp()
  tree = renderSkills()
  btnByText(tree, '保存').props.onClick()
  eq(VALUE.memory.maxContextTokens, 512000, '松手后写回 512000（第 4 档）')
})

check('时间感知卡片：开关 + 静默阈值 + 多行提示词都能写回', () => {
  VALUE.skills = [
    ...CONFIG_CATALOG.skills.map((x) => ({ ...x })),
    { id: 'sk-time-aware', name: '时间感知', icon: 'clock', tag: '内置', ver: '1.0.0',
      enabled: true, desc: '静默提示' },
  ]
  VALUE.timeAware = {
    enabled: true,
    silentMinutes: 30,
    promptText: '[系统提示：群聊已经安静了 N 分钟，刚刚有人说话了，请表现得像刚回过神一样]',
  }
  let tree = resetSkills()
  btn(tree, '时间感知 设置').props.onClick({ stopPropagation() {} })
  tree = renderSkills()
  const minutes = findAll(tree, (n) => n.tag === 'input'
    && n.props?.['aria-label'] === '静默阈值（分钟）')[0]
  if (!minutes) throw new Error('缺少「静默阈值（分钟）」输入框')
  minutes.props.onChange({ target: { value: '45' } })
  tree = renderSkills()
  const prompt = findAll(tree, (n) => n.tag === 'textarea'
    && n.props?.['aria-label'] === '触发提示词')[0]
  if (!prompt) throw new Error('缺少「触发提示词」多行输入框')
  prompt.props.onChange({ target: { value: '醒了醒了，安静了 N 分钟了' } })
  tree = renderSkills()
  btnByText(tree, '保存').props.onClick()
  eq(VALUE.timeAware.silentMinutes, 45, '应写回 timeAware.silentMinutes')
  eq(VALUE.timeAware.promptText, '醒了醒了，安静了 N 分钟了', '应写回 timeAware.promptText')
  eq(VALUE.timeAware.enabled, true, '开关保持开启')
})

console.log(`\n结果：${pass} 通过 / ${process.exitCode ? 1 : 0} 失败`)
// client.js 里的 createRemoteForm 会起重试定时器（真实环境靠 fiber 卸载清理），
// 这里必须显式退出，否则 node 会一直等定时器。
process.exit(process.exitCode ?? 0)
