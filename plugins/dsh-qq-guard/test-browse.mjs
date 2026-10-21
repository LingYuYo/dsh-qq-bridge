/**
 * 「浏览」按钮（NapCat 安装目录调起系统原生目录选择器）的行为测试。
 *
 * 覆盖：
 *   ① 点击 → POST /dsh-qq-guard/pick-dir
 *   ② 返回绝对路径 → 自动写进 napcat.dir（触发 mutate 保存）
 *   ③ 取消（cancelled）→ 不写任何东西，也不报错
 *   ④ Host 回 501（没挂 native 后端）→ 显示可读错误，不静默
 *   ⑤ 未配置时显示红字警告；配置后警告消失
 *   ⑥ 输入框 placeholder 是 C:\Program Files\NapCat
 *
 * 用法：node test-browse.mjs
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

/* ── 假 fetch ───────────────────────────────────────────────── */
const calls = []
let pickResponse = { status: 200, body: { ok: true, path: 'D:\\NapCat.52230.Shell' } }
const sandbox = {
  window: {
    __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => React) } },
    setTimeout: (fn) => { const t = setTimeout(fn, 0); if (t.unref) t.unref(); return t },
    addEventListener() {}, removeEventListener() {},
  },
  React,
  console: { ...console, error() {}, warn() {}, log: (...a) => console.log(...a) },
  setTimeout, clearTimeout,
  fetch: async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    if (url.includes('/pick-dir')) {
      return { ok: pickResponse.status < 400, status: pickResponse.status, json: async () => pickResponse.body }
    }
    if (url.includes('/napcat?action=status')) {
      return { ok: false, status: 500, json: async () => ({}) }
    }
    return { ok: false, status: 500, json: async () => ({}) }
  },
  document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} }, getElementById: () => null },
}
let mod
vm.createContext(sandbox)
vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })

/* ── 元素树 ─────────────────────────────────────────────────── */
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
const mutated = []
const form = {
  getSnapshot: () => ({ status: 'ready', value: VALUE, writable: true, source: 'remote' }),
  subscribe: () => () => {},
  mutate: async (ops) => { mutated.push(ops); return true },
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

let pickNative = undefined   // 注入的 pickDirectory（首选通路）；undefined = 不注入

function renderSettings() {
  hookStore = new Map([['root:SettingsPanel#1', 'settings']])
  effects.length = 0
  const tree = expand(React.createElement(Comp, { remoteForm: form, pickDirectory: pickNative }), 'root')
  return tree
}

function browseBtn(tree) {
  return findAll(tree, (n) => n.tag === 'button' && n.props?.['aria-label'] === '浏览选择 NapCat 安装目录')[0]
}
function dirInput(tree) {
  return findAll(tree, n => n.tag === 'input' && n.props?.['aria-label'] === 'NapCat 安装目录')[0]
}

let pass = 0
const fail = []
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fail.push(name); console.log(`  ✗ ${name}\n    ${e.message}`) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

VALUE = {
  ...CONFIG_CATALOG,
  napcat: { dir: '', quickLoginQQ: '' }, allow: { private: [], groups: [] }, bridge: { autoStart: false },
  bubbleMaxChars: 30, mergeMaxChars: 15, chunkSize: 1000, sendIntervalMs: 500,
  typingDelay: { enabled: true }, flypitDelayTiers: { short: 200, medium: 450, long: 800 },
  groupAtReply: true, groupAtPosition: 'last', trimEndPunctuation: { enabled: true },
  personaText: '', personaPresetDefault: '', onebot: { wsUrl: '', accessToken: '' },
}

console.log('NapCat 安装目录 · 浏览按钮：')

check('placeholder 是 C:\\Program Files\\NapCat', () => {
  const tree = renderSettings()
  const input = dirInput(tree)
  assert(input, '找不到安装目录输入框')
  assert(input.props.placeholder === 'C:\\Program Files\\NapCat',
    `placeholder 是「${input.props.placeholder}」`)
})

check('输入框右侧有「浏览」按钮', () => {
  const tree = renderSettings()
  const btn = browseBtn(tree)
  assert(btn, '找不到浏览按钮')
  assert(textOf(btn) === '浏览', `按钮文案是「${textOf(btn)}」`)
})

check('未配置时显示红字警告', () => {
  const tree = renderSettings()
  const err = findAll(tree, (n) => n.props?.className?.includes('qqg-status-err')
    && textOf(n).includes('未配置安装目录'))
  assert(err.length === 1, `红字警告数量 ${err.length}`)
})

check('点「浏览」会 POST /dsh-qq-guard/pick-dir', async () => {
  const before = calls.filter((c) => c.url.includes('/pick-dir')).length
  const tree = renderSettings()
  browseBtn(tree).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  const after = calls.filter((c) => c.url.includes('/pick-dir')).length
  assert(after === before + 1, `pick-dir 调用次数 ${before} → ${after}`)
  const call = calls.filter((c) => c.url.includes('/pick-dir')).pop()
  assert(call.method === 'POST', `方法应是 POST，实际 ${call.method}`)
})

check('选中后自动写入 napcat.dir（触发保存）', async () => {
  mutated.length = 0
  pickResponse = { status: 200, body: { ok: true, path: 'D:\\NapCat.52230.Shell' } }
  const tree = renderSettings()
  browseBtn(tree).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  assert(mutated.length > 0, '没有触发 mutate 保存')
  const op = mutated[mutated.length - 1][0]
  assert(op.op === 'set', `操作是 ${op.op}`)
  assert(JSON.stringify(op.path) === JSON.stringify(['napcat', 'dir']),
    `写入路径是 ${JSON.stringify(op.path)}`)
  assert(op.value === 'D:\\NapCat.52230.Shell', `写入值是「${op.value}」`)
})

check('取消选择不写配置、不报错', async () => {
  mutated.length = 0
  pickResponse = { status: 200, body: { ok: true, cancelled: true, path: null } }
  const tree = renderSettings()
  browseBtn(tree).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  assert(mutated.length === 0, '取消时不该写配置')
  const tree2 = renderSettings()
  const err = findAll(tree2, (n) => n.props?.className?.includes('qqg-status-err')
    && textOf(n).includes('pick'))
  assert(err.length === 0, '取消时不该显示错误')
})

check('Host 回 501 时提示改用「手输路径」', async () => {
  mutated.length = 0
  pickResponse = { status: 501, body: { ok: false, reason: 'picker-not-native', detail: '当前是 browse 后端' } }
  const tree = renderSettings()
  browseBtn(tree).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  assert(mutated.length === 0, '失败时不该写配置')
  const tree2 = renderSettings()
  const joined = textOf(tree2)
  assert(joined.includes('没有可用的原生目录选择器'), `错误提示不对：${joined.slice(0, 300)}`)
})

check('Host 回 404 时提示「需重启 DSH」', async () => {
  mutated.length = 0
  pickResponse = { status: 404, body: {} }
  const tree = renderSettings()
  browseBtn(tree).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  const tree2 = renderSettings()
  const joined = textOf(tree2)
  assert(joined.includes('重启 DSH'), `404 提示不对：${joined.slice(0, 300)}`)
})

check('已配置时红字警告消失', () => {
  VALUE = { ...VALUE, napcat: { dir: 'D:\\NapCat.52230.Shell', quickLoginQQ: '' } }
  const tree = renderSettings()
  const err = findAll(tree, (n) => n.props?.className?.includes('qqg-status-err')
    && textOf(n).includes('未配置安装目录'))
  assert(err.length === 0, '已配置后仍显示未配置警告')
  const input = dirInput(tree)
  assert(input.props.value === 'D:\\NapCat.52230.Shell', '输入框没显示已保存的路径')
})

/* ── 首选通路：注入的 uiWorkspace.pickDirectory() ───────────── */
console.log('\n首选通路 uiWorkspace.pickDirectory()：')

VALUE = { ...VALUE, napcat: { dir: '', quickLoginQQ: '' } }

check('注入 pickDirectory 时走它，不发 HTTP 请求', async () => {
  calls.length = 0; mutated.length = 0
  let used = 0
  pickNative = async () => { used++; return { ok: true, path: 'E:\\FromUiWorkspace' } }
  const tree = renderSettings()
  browseBtn(tree).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  assert(used === 1, `pickDirectory 调用 ${used} 次`)
  assert(calls.filter((c) => c.url.includes('/pick-dir')).length === 0, '不该再走 HTTP 路由')
  assert(mutated.length === 1, '应写入一次配置')
  assert(mutated[0][0].value === 'E:\\FromUiWorkspace', `写入值 ${mutated[0][0].value}`)
  pickNative = undefined
})

check('pickDirectory 返回 null（取消）→ 不写配置', async () => {
  mutated.length = 0
  pickNative = async () => ({ ok: true, path: null })
  const tree = renderSettings()
  browseBtn(tree).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  assert(mutated.length === 0, '取消时不该写配置')
  pickNative = undefined
})

check('pickDirectory 报错 → 显示错误，不静默', async () => {
  mutated.length = 0
  pickNative = async () => ({ ok: false, reason: 'pick-failed', detail: '对话框被占用' })
  const tree = renderSettings()
  browseBtn(tree).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  assert(mutated.length === 0, '失败时不该写配置')
  const joined = textOf(renderSettings())
  assert(joined.includes('对话框被占用'), `错误没显示：${joined.slice(0, 200)}`)
  pickNative = undefined
})

check('uiWorkspace 没装载（no-ui-workspace）→ 回落到 HTTP 路由', async () => {
  calls.length = 0; mutated.length = 0
  pickNative = async () => ({ ok: false, reason: 'no-ui-workspace' })
  pickResponse = { status: 200, body: { ok: true, path: 'F:\\FromRoute' } }
  const tree = renderSettings()
  browseBtn(tree).props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  assert(calls.filter((c) => c.url.includes('/pick-dir')).length === 1, '没有回落到 HTTP 路由')
  assert(mutated.length === 1 && mutated[0][0].value === 'F:\\FromRoute', '回落写入失败')
  pickNative = undefined
})

console.log(`\n结果：${pass} 通过 / ${fail.length} 失败`)
process.exit(fail.length ? 1 : 0)
