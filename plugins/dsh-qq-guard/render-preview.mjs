/**
 * 把 SettingsPanel 的 5 个 Tab 渲染成静态 HTML，用于人工/截图验收版式。
 * 仅开发期使用，不参与插件运行。
 *
 * 用法：node render-preview.mjs [outDir]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const OUT = process.argv[2] ?? new URL('./preview/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
mkdirSync(OUT, { recursive: true })

/* ── 极简 React（支持 hooks + 序列化）────────────────────────── */
let hookStore = new Map()
let hookKey = 'root'
let hookCursor = 0
const React = {
  // 与真 React 一致：显式 children 优先，其次保留 props.children
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

let mod
const window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => React) } } }
const sandbox = {
  window, React, console, setTimeout, clearTimeout,
  fetch: async () => { throw new Error('offline preview') },
  document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} }, getElementById: () => null },
}
vm.createContext(sandbox)
vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })

/* ── 序列化成 HTML ──────────────────────────────────────────── */
const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link'])
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function styleAttr(style) {
  if (!style) return ''
  const css = Object.entries(style).map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`).join(';')
  return css ? ` style="${esc(css)}"` : ''
}

function html(node, pos = 'r') {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map((n, i) => html(n, `${pos}.${i}`)).join('')
  const { type, props } = node
  const children = props?.children ?? []
  if (type === React.Fragment) return children.map((c, i) => html(c, `${pos}.f${i}`)).join('')
  if (typeof type === 'function') {
    const prevKey = hookKey, prevCursor = hookCursor
    // 关键：hook 作用域按「树中位置」隔离，否则多个同类型子组件会共用一份 state。
    hookKey = `${pos}:${type.name || 'anon'}`
    hookCursor = 0
    let out
    try { out = type(props) } finally { hookKey = prevKey; hookCursor = prevCursor }
    return html(out, pos)
  }
  // 原生标签
  const attrs = []
  const PASS_THROUGH = new Set([
    'd', 'viewBox', 'width', 'height', 'fill', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin',
    'cx', 'cy', 'r',
    'min', 'max', 'rows', 'tabIndex', 'title', 'placeholder', 'type', 'role', 'disabled', 'checked',
    'draggable', 'value',
  ])
  for (const [k, v] of Object.entries(props)) {
    if (k === 'children' || k === 'key' || v === undefined || v === null || typeof v === 'function') continue
    if (k === 'className') attrs.push(`class="${esc(v)}"`)
    else if (k === 'style') { const s = styleAttr(v); if (s) attrs.push(s.trim()) }
    else if (k === 'ariaLabel') attrs.push(`aria-label="${esc(v)}"`)
    else if (k.startsWith('aria-')) attrs.push(`${k}="${esc(v)}"`)
    else if (k === 'value') attrs.push(`value="${esc(v)}"`)
    else if (PASS_THROUGH.has(k)) {
      const name = k === 'strokeWidth' ? 'stroke-width' : k === 'strokeLinecap' ? 'stroke-linecap'
        : k === 'strokeLinejoin' ? 'stroke-linejoin' : k === 'viewBox' ? 'viewBox' : k.toLowerCase()
      attrs.push(`${name}="${esc(v)}"`)
    }
  }
  const open = `<${type}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  if (VOID.has(type)) return open
  const inner = type === 'style'
    ? children.join('')
    : children.map((c, i) => html(c, `${pos}.${type}${i}`)).join('')
  return `${open}${inner}</${type}>`
}

/* ── 假配置表单 ─────────────────────────────────────────────── */
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
  personaText: '你是一只傲娇猫娘，说话带「哼」和「才不是呢」。\n第二行：正经问题会认真答。', personaPresetDefault: '预设人设',
  personaBotName: '小鲸鱼', personaGroupName: '鲸鱼娘', personaParticipation: 'active',
  personaExtraRules: '', personaSystemPrompt: '', personaPresetId: '',
  personaPresets: [{ id: 'p1', name: '猫娘', text: '你是一只傲娇猫娘。' }],
  allow: { private: ['10001', '10002'], groups: ['20002'], allowAllWhenEmpty: false },
  onebot: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '' },
  napcat: { dir: 'D:\\NapCat.52230.Shell', quickLoginQQ: '1000000001' },
  bridge: { dir: '', autoStart: true },
  model: { provider: 'trae', model: 'deepseek-v4.1-flash', reasoningEffort: '' },
  peakHours: '09:00-12:00, 14:00-18:00',
  peakOnlyWorkdays: true,
  timezone: 'Asia/Shanghai',
  usagePricing: [{
    provider: 'trae',
    model: 'deepseek-v4.1-flash',
    peak: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0.2 },
    offPeak: { input: 1, output: 4, cacheRead: 0.25, cacheWrite: 0.1 },
  }],
}
const form = {
  getSnapshot: () => ({ status: 'ready', value: VALUE, writable: true, source: 'remote' }),
  subscribe: () => () => {},
  mutate: async () => true,
}

/* ── 注册槽位 ───────────────────────────────────────────────── */
let registered = {}
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
if (!Comp) throw new Error('main 槽位未注册')

const THEME_LIGHT = `
body { margin: 0; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  --dsw-alias-bg-base: #fff; --dsw-alias-bg-layer-1: #fff; --dsw-alias-bg-layer-2: #fff;
  --dsw-alias-bg-layer-3: #f9fafb; --dsw-alias-border-l1: #0000000a; --dsw-alias-border-l2: #0000001a;
  --dsw-alias-border-l3: #0000001f; --dsw-alias-label-primary: #0f1115; --dsw-alias-label-secondary: #81858c;
  --dsw-alias-label-tertiary: #adb2b8; --dsw-alias-label-primary-foreground: #fff;
  --dsw-alias-state-business-primary: #4176e6; --dsw-alias-button-info-fill: #4176e6;
  --dsw-alias-brand-primary: #0f1115; --dsw-alias-button-primary-fill: #0f1115;
  --dsw-alias-state-success-primary: #22c55e; --dsw-alias-state-error-primary: #ec1313;
  --dsw-alias-state-warn-primary: #f59e0b; --dsw-alias-interactive-bg-hover: #2631480f;
  --dsw-alias-interactive-bg-active: #2631481a; --dsw-alias-settings-card-fill: #fff;
  --dsw-alias-settings-card-stroke: #00000029;
  background: #fff; color: #0f1115; }
`
const THEME_DARK = `
body[data-ds-dark-theme] { --dsw-alias-bg-base: #151517; --dsw-alias-bg-layer-1: #232324;
  --dsw-alias-bg-layer-2: #2c2c2e; --dsw-alias-bg-layer-3: #353638; --dsw-alias-border-l1: #ffffff0f;
  --dsw-alias-border-l2: #ffffff1f; --dsw-alias-border-l3: #ffffff29; --dsw-alias-label-primary: #f9fafb;
  --dsw-alias-label-secondary: #cfd3d6; --dsw-alias-label-tertiary: #adb2b8;
  --dsw-alias-label-primary-foreground: #0f1115; --dsw-alias-state-business-primary: #7aaaff;
  --dsw-alias-button-info-fill: #7aaaff; --dsw-alias-brand-primary: #f9fafb;
  --dsw-alias-button-primary-fill: #f9fafb; --dsw-alias-state-success-primary: #4ed17e;
  --dsw-alias-state-error-primary: #f25a5a; --dsw-alias-state-warn-primary: #fbbf24;
  --dsw-alias-interactive-bg-hover: #ffffff14; --dsw-alias-interactive-bg-active: #ffffff24;
  background: #151517; color: #f9fafb; }
`

const TABS = ['status', 'sessions', 'skills', 'settings', 'usage']
function pageOf(tab, title) {
  const body = html(React.createElement(Comp, { remoteForm: form }))
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>QQ 桥接 · ${title}</title><style>${THEME_LIGHT}${THEME_DARK}
html,body{height:100%} #app{height:100%;display:flex}</style></head>
<body><div id="app">${body}</div></body></html>`
}
function emit(name, tab, title) {
  const page = pageOf(tab, title)
  writeFileSync(`${OUT}/${name}.html`, page)
  writeFileSync(`${OUT}/${name}-dark.html`, page.replace('<body>', '<body data-ds-dark-theme>'))
  console.log('wrote', `${name}.html`, `${(page.length / 1024).toFixed(0)}KB`)
}

for (const tab of TABS) {
  // SettingsPanel 里 useForm 先占 useState #0，active 是 #1（根节点 pos = 'r'）。
  hookStore = new Map([[`r:SettingsPanel#1`, tab]])
  emit(`tab-${tab}`, tab, tab)
}

/* ── 弹窗预览：把弹窗开关的初始 state 预置成打开 ─────────────── */
// 假 React 的 hook 作用域键是 `${树中位置}:${组件名}#${序号}`。
// qqg-content 下的第一个子节点位置固定为 `r.div3.div0`。
const TAB_POS = 'r.div3.div0'

const TEST_SKILL = {
  id: 'sk-test', icon: 'send', name: '发语音', ver: '1.0.2', tag: '内置', enabled: true,
  desc: '把回复文本合成语音，以 QQ 语音条发出；超过 60 秒自动转文字。',
  author: 'qq-guard', updated: '2026-10-12',
  settings: [
    { key: 'a', label: '语音引擎', type: 'select', value: 'sherpa-onnx', options: ['sherpa-onnx', '系统 TTS'] },
    { key: 'b', label: '单条最长（秒）', type: 'number', value: 60, min: 5, max: 300 },
    { key: 'c', label: '语速倍率', type: 'number', value: 1.0, min: 0.5, max: 2.0, step: 0.1 },
  ],
  notes: ['语音条在部分 QQ 版本会被压缩，超长句子建议先切片。'],
}
const TEST_PLUGIN = {
  id: 'pl-test', icon: 'activity', name: '防抖合并', ver: '1.4.0', tag: '本地', enabled: true,
  desc: '群聊里连续多条短消息先攒一窗口再一次性回复。',
  author: 'qq-guard', updated: '2026-10-19', settings: [], notes: [],
}

const MODALS = [
  { name: 'modal-tile-settings', tab: 'skills', idx: 2, value: { kind: 'skill', item: TEST_SKILL }, title: '技能设置' },
  { name: 'modal-tile-delete', tab: 'skills', idx: 3, value: { kind: 'plugin', item: TEST_PLUGIN }, title: '删除确认' },
  { name: 'modal-tile-add', tab: 'skills', idx: 4, value: 'skill', title: '添加技能' },
  { name: 'modal-session-delete', tab: 'sessions', idx: 4, value: true, title: '会话删除' },
  // 引导弹窗已挪到左侧导航底部，开关是 SettingsPanel 的 #2（guideOpen），不在 SettingsTab 里。
  { name: 'modal-guide', tab: 'settings', panelHook: 2, value: true, title: '使用引导' },
  // SettingsTab：分片/打字延时已合并成两个大按钮，弹窗开关是 #0 sendOpen / #1 activeOpen。
  { name: 'modal-send', tab: 'settings', idx: 0, value: true, title: '信息发送配置' },
  { name: 'modal-active', tab: 'settings', idx: 1, value: true, title: '活跃设置' },
]
const TAB_COMP = { skills: 'SkillsTab', sessions: 'SessionsTab', settings: 'SettingsTab' }
for (const m of MODALS) {
  const store = new Map([['r:SettingsPanel#1', m.tab]])
  if (m.panelHook !== undefined) store.set(`r:SettingsPanel#${m.panelHook}`, m.value)
  else store.set(`${TAB_POS}:${TAB_COMP[m.tab]}#${m.idx}`, m.value)
  hookStore = store
  emit(m.name, m.tab, m.title)
}

