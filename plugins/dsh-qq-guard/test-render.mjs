/**
 * 离线渲染冒烟测试（不连浏览器）。
 *
 * 用一个极简的假 React 递归展开元素树，把 SettingsPanel 的 5 个 Tab 全渲染一遍，
 * 目的只是抓「组件名写错 / undefined 变量 / 数据结构对不上」这类运行时炸点。
 *
 * 用法：node test-render.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

/* ── 极简 React ─────────────────────────────────────────────── */
// hooks 必须按「组件实例路径」隔离，否则子组件的 useState 会覆盖父组件的。
let hookStore = new Map()
let hookKey = 'root'
let hookCursor = 0
const effects = []
const React = {
  // 与真 React 一致：第三个参数优先，其次保留 props.children（Field 那类透传组件靠它）。
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
  useRef(init) { return { current: init } },
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
}

/* ── 加载 client.js，截获模块定义 ───────────────────────────── */
let mod
const window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => React) } } }
const sandbox = {
  window, React, console, setTimeout, clearTimeout, fetch: async () => { throw new Error('no network in test') },
  document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
}
vm.createContext(sandbox)
vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })

/* ── 递归展开 ───────────────────────────────────────────────── */
const textSink = []
// 记录所有挂到 DOM 的事件处理与可交互元素，用来断言「按钮真的绑了函数」。
const handlers = []
/** 记录所有原生节点（tag + props），供按 aria-label / 文案做断言。 */
const renderedNodes = []
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}
function render(node, path = 'root') {
  if (node === null || node === undefined || node === false) return
  if (typeof node === 'string' || typeof node === 'number') { textSink.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach((n, i) => render(n, `${path}[${i}]`)); return }
  const { type, props } = node
  const children = props?.children ?? []
  if (type === React.Fragment) { children.forEach((c, i) => render(c, `${path}.frag${i}`)); return }
  if (typeof type === 'string') {
    renderedNodes.push({ tag: type, props })
    if (props?.onClick) handlers.push({ tag: type, path, hasOnClick: typeof props.onClick === 'function' })
    children.forEach((c, i) => render(c, `${path}.${type}${i}`))
    return
  }
  if (typeof type === 'function') {
    const prevKey = hookKey
    const prevCursor = hookCursor
    hookKey = path + '.' + (type.name || 'anon')
    hookCursor = 0
    let out
    try {
      out = type(props)
    } catch (error) {
      throw new Error(`渲染 <${type.name || 'anonymous'}> 失败（${path}）：${error.message}`)
    } finally {
      hookKey = prevKey
      hookCursor = prevCursor
    }
    render(out, path + '.' + (type.name || 'anon'))
    return
  }
  throw new Error(`未知元素类型 ${String(type)}（${path}）`)
}

/* ── 假配置表单 ─────────────────────────────────────────────── */
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
  groupAtReply: true, groupAtPosition: 'last', trimEndPunctuation: { enabled: true },
  personaText: '', personaPresetDefault: '预设人设',
  allow: { private: ['10001'], groups: ['20002'], allowAllWhenEmpty: false },
  onebot: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '' },
  napcat: { dir: 'D:\\NapCat', quickLoginQQ: '' },
  bridge: { dir: '', autoStart: true },
}
const form = {
  getSnapshot: () => ({ status: 'ready', value: VALUE, writable: true, source: 'remote' }),
  subscribe: () => () => {},
  mutate: async () => true,
}

/* ── 跑：每个 Tab 都渲染一遍 ───────────────────────────────── */
const exported = mod
if (!exported || typeof exported.apply !== 'function') throw new Error('模块没有导出 apply')

let registered = {}
const ctx = {
  remote: { settings: { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'qq-guard', revision: 1, value: VALUE }] } }) } },
  effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose) },
  on: () => () => {},
  slots: {
    inject: (_name, fn) => fn(),
    register: (descriptor, component) => { registered[descriptor.name + ':' + (descriptor.key ?? descriptor.id ?? '')] = component; return () => {} },
  },
  inject: (_deps, fn) => fn({ slots: ctx.slots, effect: ctx.effect, configForms: { get: () => form } }),
  configForms: { get: () => form },
}
exported.apply(ctx)

const targets = [
  ['settings.section:qq-bridge', { remoteForm: form }],
  ['main:qq-bridge', { remoteForm: form }],
]
for (const [key, props] of targets) {
  const Comp = registered[key]
  if (!Comp) throw new Error(`未注册槽位 ${key}（已注册：${Object.keys(registered).join(', ')}）`)
  hookStore = new Map(); effects.length = 0; textSink.length = 0; handlers.length = 0
  render(React.createElement(Comp, props), key)
  console.log(`✓ ${key} 首次渲染通过（文本节点 ${textSink.length}）`)
}

/* ── 逐个 Tab 渲染（把 active 的初始 state 预置成目标 tab）── */
// 注册的是 BridgePanel，它内部渲染 SettingsPanel，所以 hook 作用域是
// `tab:<tab>.BridgePanel.SettingsPanel`；SettingsPanel 里 useForm 的 useState 占 #0，
// active 是 #1（假 React 里 useEffect 不占 useState 序号）。
const Comp = registered['main:qq-bridge']
const allHandlers = []
for (const tab of ['status', 'sessions', 'skills', 'settings', 'usage']) {
  const root = `tab:${tab}`
  hookStore = new Map([[`${root}.BridgePanel.SettingsPanel#1`, tab]])
  effects.length = 0; textSink.length = 0; handlers.length = 0
  render(React.createElement(Comp, { remoteForm: form }), root)
  allHandlers.push(...handlers)
  // 断言每个 Tab 都真的渲染出内容（防「渲染通过但页面空白」）。
  if (textSink.length < 10) throw new Error(`Tab「${tab}」渲染出的文本过少（${textSink.length}），疑似空页面`)
  const joined = textSink.join('|')
  const expect = {
    status: ['今日用量概览', 'AI 排障助手', '启动桥接'],
    // 会话管理已接真实数据：桥接未上报时渲染「等待上报」，不再有假会话。
    sessions: ['会话管理', '等待桥接上报', '运行状态'],
    skills: ['技能（Skill）', '插件（Plugin）', '发语音', '图片理解', '网页搜索', '记忆与上下文',
      '防抖合并', '频率控制', '上下文压缩', '+ 添加插件', '+ 添加技能'],
    // Phase 3：引导改成按钮+弹窗，分片/打字延时合并成「运行节奏」两个大按钮。
    settings: ['运行节奏', '信息发送配置', '活跃设置', '使用引导',
      '人设配置', '白名单管理', '管理员 QQ 号', 'OneBot 连接', 'NapCat 进程'],
    // 用量页已全部接真实数据：假数据删除，新增「峰谷时段设置 / 单价配置 / 按会话统计」。
    usage: ['数据与用量', '按天统计', '按模型统计', '按会话统计', '单价配置', '峰谷时段设置',
      '仅在工作日生效', 'Token 消耗走势'],
  }[tab]
  const missing = expect.filter((k) => !joined.includes(k))
  if (missing.length) throw new Error(`Tab「${tab}」缺少内容：${missing.join('、')}`)
  console.log(`✓ Tab「${tab}」渲染通过（文本节点 ${textSink.length}）`)
}

/* ── 会话管理：有真实上报数据时的列表 / 详情 ────────────────── */
// SettingsPanel 的 hook 顺序：#0 useForm / #1 active / #2 guideOpen /
// #3-#4 useBridgeProc / #5 useBridgeStatus。把 #5 预置成桥接上报的 payload。
{
  const LIVE = {
    sessions: [
      { key: 'g:123456', sessionId: 's2', kind: 'group', qq: '123456', name: '摸鱼群',
        title: '群聊-摸鱼群(123456)', unread: 3, lastAt: Date.now(), lastText: '今天这破网', persona: '' },
      { key: 'u:1000000001', sessionId: 's1', kind: 'private', qq: '1000000001', name: '翎羽',
        title: '私聊-翎羽', unread: 0, lastAt: 0, lastText: '', persona: '专属人设' },
    ],
  }
  const root = 'live:sessions'
  // P2 轮询隔离：会话列表的状态现在只存在于叶子组件 SessionsTab 内部（#0 = live），
  // 面板层不再持有这份数据。
  hookStore = new Map([
    [`${root}.BridgePanel.SettingsPanel#1`, 'sessions'],
    [`${root}.BridgePanel.SettingsPanel.div3.div0.SessionsTab#0`, LIVE],
  ])
  effects.length = 0; textSink.length = 0; handlers.length = 0; renderedNodes.length = 0
  render(React.createElement(Comp, { remoteForm: form }), root)
  const joined = textSink.join('|')
  for (const k of ['摸鱼群', '翎羽', '群聊-摸鱼群(123456)', '3 条未读', '今天这破网', 'DSH 会话 ID',
    '单人设覆盖', '保存人设', '恢复全局', '清空上下文', '删除会话']) {
    if (!joined.includes(k)) throw new Error(`会话列表（真实数据）缺少「${k}」`)
  }
  if (joined.includes('等待桥接上报')) throw new Error('有数据时不应显示等待态')
  // 本批解锁：按钮与文本框都必须是可用的（不再是置灰占位）
  const textarea = renderedNodes.find((n) => n.props?.['aria-label'] === '单人设覆盖')
  if (!textarea) throw new Error('缺少单人设输入框')
  if (textarea.props.disabled === true) throw new Error('单人设输入框不该置灰')
  const clearBtn = renderedNodes.find((n) => n.tag === 'button' && textOf(n).trim() === '清空上下文')
  if (!clearBtn) throw new Error('缺少「清空上下文」按钮')
  if (clearBtn.props.disabled === true) throw new Error('「清空上下文」按钮不该置灰')
  const deleteBtn = renderedNodes.find((n) => n.tag === 'button' && textOf(n).trim() === '删除会话')
  if (!deleteBtn) throw new Error('缺少「删除会话」按钮')
  if (deleteBtn.props.disabled === true) throw new Error('「删除会话」按钮不该置灰')
  console.log('✓ 会话管理（真实上报数据）渲染通过')
}

/* ── 交互绑定检查：页面上不能有「点了没反应」的按钮 ───────────── */
// 除了明确留空的按钮（「打开会话」「清空上下文」「分析」等，绑的是 noop），
// 所有 button 都应该有 onClick。noop 本身也是函数，所以这里只断言「有绑定」。
{
  const unbound = allHandlers.filter((x) => x.tag === 'button' && x.hasOnClick !== true)
  if (unbound.length) {
    throw new Error(`有 ${unbound.length} 个 button 没绑 onClick：${unbound.slice(0, 3).map((x) => x.path).join(', ')}`)
  }
  console.log(`✓ 交互绑定检查通过（5 个 Tab 共 ${allHandlers.length} 个可点元素全部有 onClick）`)
}

/* ── 弹窗渲染冒烟：把各弹窗的 open 状态直接预置好跑一遍 ────────── */
// 弹窗的开关是 SkillsTab 里的 useState（#2 settingsTarget / #3 deleteTarget / #4 addKind），
// 直接把初始值灌进 hookStore 就能渲染出弹窗本身。
const TEST_SKILL = {
  // 齿轮弹窗按条目 id 映射真实 Config 字段（TILE_FIELDS），所以这里用真实 id。
  id: 'sk-voice', icon: 'send', name: '发语音', ver: '1.0.2', tag: '内置', enabled: true,
  desc: '把回复文本合成语音。', author: 'qq-guard', updated: '2026-10-12',
  notes: ['测试用条目。'],
}
const TEST_PLUGIN = {
  id: 'pl-test', icon: 'activity', name: '防抖合并', ver: '1.4.0', tag: '本地', enabled: true,
  desc: '群聊短消息合并。', author: 'qq-guard', updated: '2026-10-19',
  settings: [], notes: [],
}
const SKILLS_PATH = 'BridgePanel.SettingsPanel.div3.div0.SkillsTab'

function renderSkillsWith(stateIndex, value, tag) {
  const root = `modal:${tag}`
  hookStore = new Map([
    [`${root}.BridgePanel.SettingsPanel#1`, 'skills'],
    [`${root}.${SKILLS_PATH}#${stateIndex}`, value],
  ])
  effects.length = 0; textSink.length = 0
  render(React.createElement(Comp, { remoteForm: form }), root)
  return textSink.join('|')
}

{
  const joined = renderSkillsWith(0, { kind: 'skill', item: TEST_SKILL }, 'tile-settings')
  for (const k of ['设置', '说明', '恢复默认', '保存', '语音后端', '音色']) {
    if (!joined.includes(k)) throw new Error(`技能设置弹窗缺少「${k}」`)
  }
  console.log('✓ 弹窗「技能设置」渲染通过')
}

{
  const joined = renderSkillsWith(1, { kind: 'plugin', item: TEST_PLUGIN }, 'tile-delete')
  for (const k of ['删除「', '取消', '删除']) {
    if (!joined.includes(k)) throw new Error(`删除确认框缺少「${k}」`)
  }
  console.log('✓ 弹窗「删除确认」渲染通过')
}

{
  const joined = renderSkillsWith(2, 'skill', 'tile-add')
  for (const k of ['添加技能', '本地文件']) {
    if (!joined.includes(k)) throw new Error(`添加弹窗缺少「${k}」`)
  }
  console.log('✓ 弹窗「添加技能」渲染通过')
}

/* ── 会话删除确认框已随「删除会话」功能排到下一批 ─────────────── */
/* （本批只接真实列表与未读，按钮保持置灰；等归档 + 指令队列落地后补回用例。） */

/* ── 全局设置页的两个弹窗 ───────────────────────────────────── */
// SettingsTab hook 顺序：#0 sendOpen / #1 activeOpen
for (const [idx, label, expectText] of [
  [0, '信息发送配置', ['信息发送配置', '单行语义切阈值', '分级打字延时']],
  [1, '活跃设置', ['活跃设置', '响应档位', '防抖合并窗口', '指令禁言']],
]) {
  const root = `modal:settings-${idx}`
  hookStore = new Map([
    [`${root}.BridgePanel.SettingsPanel#1`, 'settings'],
    [`${root}.BridgePanel.SettingsPanel.div3.div0.SettingsTab#${idx}`, true],
  ])
  effects.length = 0; textSink.length = 0
  render(React.createElement(Comp, { remoteForm: form }), root)
  const joined = textSink.join('|')
  for (const k of expectText) {
    if (!joined.includes(k)) throw new Error(`${label} 弹窗缺少「${k}」`)
  }
  console.log(`✓ 弹窗「${label}」渲染通过`)
}

/* ── 使用引导弹窗（已挪到左侧导航底部按钮）─────────────────── */
// SettingsPanel hook 顺序：#0 useForm 的 snapshot / #1 active / #2 guideOpen
{
  const root = 'modal:guide'
  hookStore = new Map([
    [`${root}.BridgePanel.SettingsPanel#2`, true],
  ])
  effects.length = 0; textSink.length = 0
  render(React.createElement(Comp, { remoteForm: form }), root)
  const joined = textSink.join('|')
  for (const k of ['使用引导', 'NapCat 进程', '白名单', '桥接进程']) {
    if (!joined.includes(k)) throw new Error(`使用引导弹窗缺少「${k}」`)
  }
  // 桥接进程还没查回来时不该直接给「去启动」或「已就绪」的错误结论
  console.log('✓ 弹窗「使用引导」渲染通过')
}

console.log('\n全部渲染冒烟测试通过。')
