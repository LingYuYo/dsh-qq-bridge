/**
 * 「技能与插件 → 网页搜索」齿轮弹窗（真实 Config 读写）的离线测试。
 *
 * 做法与 test-tile-config.mjs 一致：假 React 把组件渲染成元素树，把树里的
 * onChange / onClick 回调捞出来直接调用，最后断言 form.mutate 收到的 path 与 value。
 * 覆盖点：字段集（Key / baseUrl / model）、未配 Key 的提示、代理说明、保存路径、
 * 「留空 = 不改 Key」、恢复默认不碰 Key、writable=false 时全部禁用。
 *
 * 用法：node test-web-config.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

/* ── 假 React：支持 hooks 与「重渲染」──────────────────────── */
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
  // 只登记不执行：弹窗里「换条目清空草稿」的 effect 在假 React 里忽略 deps，
  // 每次渲染都跑会把草稿清掉；真 React 只在换条目时执行。
  useEffect(fn) { effects.push(fn) },
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

/* ── 配置夹具（形状与 Host 侧 Config 一致）──────────────────── */
let mod
const MUTATIONS = []

function makeValue() {
  return {
    skills: [
      { id: 'sk-voice', name: '发语音', icon: 'send', tag: '内置', ver: '1.0.2', enabled: true, desc: '合成语音' },
      { id: 'sk-search', name: '网页搜索', icon: 'search', tag: '内置', ver: '1.0.4', enabled: true,
        desc: '联网检索并把结果压缩成两三句话，用于回答时效性问题。' },
      { id: 'sk-memory', name: '记忆提取', icon: 'memory', tag: '内置', ver: '1.2.0', enabled: true, desc: '抽取长期事实' },
    ],
    plugins: [
      { id: 'pl-debounce', name: '防抖合并', icon: 'activity', tag: '本地', ver: '1.4.0', enabled: true, desc: '合并短消息' },
    ],
    rhythm: {
      activityLevel: 1, debounceWindowMs: 800, batchIntervalMs: 2500,
      rateLimit: { perMin: 12, burst: 3, silent: true },
      mute: { enabled: true, words: ['闭嘴'], seconds: 60 },
    },
    voice: { provider: 'edge', voice: 'zh-CN-XiaoyiNeural', apiKey: '', baseUrl: '' },
    // 网页搜索的三个字段默认全空 = 未配置。
    webSearch: { apiKey: '', baseUrl: '', model: '' },
    externalPlugins: { dirs: [], enabled: [] },
    bubbleMaxChars: 30, mergeMaxChars: 15, chunkSize: 1000, sendIntervalMs: 500,
    groupAtReply: true, groupAtPosition: 'last',
    typingDelay: { enabled: true }, flypitDelayTiers: { short: 200, medium: 450, long: 800 },
    typingDelayCharTiers: { shortMax: 10, mediumMax: 14, longMin: 15 },
    trimEndPunctuation: { enabled: true },
    personaText: '', personaPresetDefault: '',
    allow: { private: [], groups: [], allowAllWhenEmpty: false },
    onebot: { wsUrl: '', accessToken: '' }, napcat: { dir: '', quickLoginQQ: '' },
    bridge: { dir: '', autoStart: false },
  }
}
let VALUE = makeValue()

/** 真实 Config 的 mutate：按 path 写回 VALUE，并把每次写盘记进 MUTATIONS。 */
function makeForm(writable) {
  return {
    getSnapshot: () => ({ status: 'ready', value: VALUE, writable, source: 'remote' }),
    subscribe: () => () => {},
    mutate: async (ops) => {
      for (const op of ops) {
        if (op.op !== 'set') continue
        MUTATIONS.push({ path: op.path.join('.'), value: op.value })
        let cur = VALUE
        for (let i = 0; i < op.path.length - 1; i++) {
          if (typeof cur[op.path[i]] !== 'object' || cur[op.path[i]] === null) cur[op.path[i]] = {}
          cur = cur[op.path[i]]
        }
        cur[op.path[op.path.length - 1]] = op.value
      }
      return true
    },
  }
}
const form = makeForm(true)
const readonlyForm = makeForm(false)

const quietConsole = { ...console, error: () => {}, warn: () => {}, log: (...a) => console.log(...a) }
const sandbox = {
  window: {
    __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => React) } },
    setTimeout: (fn) => { const t = setTimeout(fn, 0); if (t.unref) t.unref(); return t },
    addEventListener() {},
    removeEventListener() {},
  },
  React, console: quietConsole, setTimeout, clearTimeout,
  fetch: async () => { throw new Error('offline') },
  document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} }, getElementById: () => null },
}
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
  return {
    tag: type, props,
    kids: children.map((c, i) => expand(c, `${path}.${type}${i}`)).filter(Boolean),
  }
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

/* ── 装配 / 断言 ────────────────────────────────────────────── */
/** 从头渲染 skills Tab（SettingsPanel 的 #1 是当前页签）。 */
function resetSkills(formOverride) {
  hookStore = new Map([['root:SettingsPanel#1', 'skills']])
  return expand(React.createElement(Comp, { remoteForm: formOverride ?? form }), 'root')
}
function render(formOverride) {
  return expand(React.createElement(Comp, { remoteForm: formOverride ?? form }), 'root')
}

function modalOf(tree) {
  return findAll(tree, (n) => String(n.props?.className ?? '').split(' ').includes('qqg-modal'))[0]
}
function inModal(tree, pred) { return findAll(modalOf(tree), pred) }
function byAria(tree, label) { return inModal(tree, (n) => n.props?.['aria-label'] === label)[0] }
function btnByText(tree, text) {
  return findAll(modalOf(tree), (n) => n.tag === 'button' && textOf(n).trim() === text)[0]
}
function openGear(tree, name) {
  findAll(tree, (n) => n.tag === 'button' && n.props?.['aria-label'] === `${name} 设置`)[0]
    .props.onClick({ stopPropagation() {} })
}

let pass = 0
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) {
    console.log(`  ✗ ${name}\n    ${e.message}`)
    process.exitCode = 1
  }
}
function eq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b)
  if (ja !== jb) throw new Error(`${msg ?? ''} 期望 ${jb}，实际 ${ja}`)
}
function truthy(value, msg) { if (!value) throw new Error(msg) }
function writesOf(path) { return MUTATIONS.filter((m) => m.path === path) }
function reset() { MUTATIONS.length = 0; VALUE = makeValue() }

/** 打开「网页搜索」的齿轮弹窗，返回重渲染后的树。 */
function openSearch(formOverride) {
  let tree = resetSkills(formOverride)
  openGear(tree, '网页搜索')
  return render(formOverride)
}

/** 弹窗里所有带 aria-label 的输入控件标签，按出现顺序。 */
function fieldLabels(tree) {
  return inModal(tree, (n) => (n.tag === 'input' || n.tag === 'select') && n.props?.['aria-label'])
    .map((n) => n.props['aria-label'])
}

/* ── 用例 1：字段集 ────────────────────────────────────────── */
console.log('网页搜索弹窗（真实配置）：')

await check('sk-search：齿轮弹窗是真实表单（Key / baseUrl / model），不再是「无可调配置」', () => {
  reset()
  const tree = openSearch()
  truthy(modalOf(tree), '弹窗没打开')
  const joined = textOf(modalOf(tree))
  truthy(!joined.includes('无可调配置'), '不该再显示「无可调配置」')
  eq(fieldLabels(tree), ['DeepSeek API Key', '接口地址 baseUrl', '搜索模型 model'], '字段集与顺序')
})

await check('sk-search：Key 是密码框、不回显已保存明文，baseUrl / model 取真实配置', () => {
  reset()
  VALUE.webSearch = { apiKey: 'sk-already-saved', baseUrl: 'https://relay.example/v1', model: 'deepseek-search' }
  const tree = openSearch()
  const key = byAria(tree, 'DeepSeek API Key')
  eq(key.props.type, 'password', 'Key 必须是密码框')
  eq(key.props.value, '', 'Key 输入框不能回显已保存的明文')
  eq(key.props.placeholder, '已保存（留空 = 不修改）', '已配 Key 时的占位提示')
  truthy(textOf(modalOf(tree)).includes('当前已保存一个 Key'), '应提示已保存')
  eq(byAria(tree, '接口地址 baseUrl').props.value, 'https://relay.example/v1', 'baseUrl 初值取真实配置')
  eq(byAria(tree, '搜索模型 model').props.value, 'deepseek-search', 'model 初值取真实配置')
})

/* ── 用例 2：未配 Key 的提示 ───────────────────────────────── */
await check('未配 Key：左栏顶部给明确提示（含报错码），一开始输入 Key 提示就消失', () => {
  reset()
  let tree = openSearch()
  const alert = findAll(modalOf(tree), (n) => n.props?.className === 'qqg-status qqg-status-err'
    && textOf(n).includes('未配置 Key'))[0]
  truthy(alert, `缺少「未配置 Key」提示，实际弹窗文案：${textOf(modalOf(tree))}`)
  const alertText = textOf(alert)
  truthy(alertText.includes('未配置 Key'), '提示必须写「未配置 Key」')
  truthy(alertText.includes('web_search'), '提示要点名 web_search')
  truthy(alertText.includes('WEB_PROVIDER_CREDENTIAL_MISSING'), '提示要带上真实报错码')
  truthy(alertText.includes('DeepSeek Platform'), '提示要说明 Key 从哪拿')

  byAria(tree, 'DeepSeek API Key').props.onChange({ target: { value: 'sk-typed' } })
  tree = render()
  eq(findAll(modalOf(tree), (n) => n.props?.className === 'qqg-status qqg-status-err'
    && textOf(n).includes('未配置 Key')).length, 0, '开始填 Key 后提示应立刻消失')
})

await check('已配 Key：不再出现「未配置 Key」提示', () => {
  reset()
  VALUE.webSearch = { apiKey: 'sk-already-saved', baseUrl: '', model: '' }
  const tree = openSearch()
  eq(findAll(modalOf(tree), (n) => n.props?.className === 'qqg-status qqg-status-err'
    && textOf(n).includes('未配置 Key')).length, 0, '已配 Key 时不该有该提示')
})

/* ── 用例 3：代理说明（只说明，不写盘）────────────────────── */
await check('代理说明：弹窗右栏写明只读启动环境变量 + HTTPS_PROXY 重启办法', () => {
  reset()
  const tree = openSearch()
  const note = inModal(tree, (n) => n.props?.className === 'qqg-setdesc-note')[0]
  truthy(note, '缺少右栏代理说明块')
  const text = textOf(note)
  truthy(text.includes('web_fetch'), `代理说明要提到 web_fetch，实际：${text}`)
  truthy(text.includes('HTTPS_PROXY'), '代理说明要给出 HTTPS_PROXY')
  truthy(text.includes('HTTPS_PROXY=http://127.0.0.1:7890'), '代理说明要给出完整重启变量')
  truthy(text.includes('启动环境变量') || text.includes('启动时'), '代理说明要说清只读启动环境变量')
  truthy(text.includes('重启 DSH'), '代理说明要说清需要重启 DSH')
  // 说明块不是配置字段：点保存也不该出现任何代理相关的写盘。
  btnByText(tree, '保存').props.onClick()
  eq(MUTATIONS.filter((m) => /proxy/i.test(m.path)).length, 0, '说明块不能写任何代理配置')
})

/* ── 用例 4：保存路径 ─────────────────────────────────────── */
await check('保存：Key / baseUrl / model 分别写 webSearch.apiKey / webSearch.baseUrl / webSearch.model', () => {
  reset()
  let tree = openSearch()
  byAria(tree, 'DeepSeek API Key').props.onChange({ target: { value: 'sk-new-key' } })
  byAria(tree, '接口地址 baseUrl').props.onChange({ target: { value: 'https://api.deepseek.com' } })
  byAria(tree, '搜索模型 model').props.onChange({ target: { value: 'deepseek-chat' } })
  tree = render()
  btnByText(tree, '保存').props.onClick()
  eq(lastWriteOf('webSearch.apiKey'), 'sk-new-key', 'webSearch.apiKey')
  eq(lastWriteOf('webSearch.baseUrl'), 'https://api.deepseek.com', 'webSearch.baseUrl')
  eq(lastWriteOf('webSearch.model'), 'deepseek-chat', 'webSearch.model')
  eq(modalOf(render()), undefined, '保存后弹窗关闭')
})

await check('保存：Key 留空时只写 baseUrl / model，绝不清掉已保存的 Key', () => {
  reset()
  VALUE.webSearch = { apiKey: 'sk-already-saved', baseUrl: '', model: '' }
  let tree = openSearch()
  byAria(tree, '搜索模型 model').props.onChange({ target: { value: 'deepseek-chat' } })
  tree = render()
  btnByText(tree, '保存').props.onClick()
  eq(writesOf('webSearch.apiKey').length, 0, '留空时不能写 webSearch.apiKey')
  eq(lastWriteOf('webSearch.model'), 'deepseek-chat', 'model 照常写入')
  eq(lastWriteOf('webSearch.baseUrl'), undefined, '没改的 baseUrl 不写')
})

await check('恢复默认：baseUrl / model 回到空串（插件默认），也不碰已保存的 Key', () => {
  reset()
  VALUE.webSearch = { apiKey: 'sk-already-saved', baseUrl: 'https://relay.example/v1', model: 'deepseek-search' }
  let tree = openSearch()
  btnByText(tree, '恢复默认').props.onClick()
  eq(lastWriteOf('webSearch.baseUrl'), '', 'baseUrl 回默认空串')
  eq(lastWriteOf('webSearch.model'), '', 'model 回默认空串')
  eq(writesOf('webSearch.apiKey').length, 0, '恢复默认不能清掉已保存的 Key')
  tree = render()
  eq(byAria(tree, '搜索模型 model').props.value, '', '表单也回到默认值')
})

/* ── 用例 5：配置不可写 ───────────────────────────────────── */
await check('writable=false：三个字段 + 保存 / 恢复默认全部禁用，硬点保存也不写盘', () => {
  reset()
  const tree = openSearch(readonlyForm)
  for (const label of ['DeepSeek API Key', '接口地址 baseUrl', '搜索模型 model']) {
    eq(byAria(tree, label).props.disabled, true, `${label} 必须禁用`)
  }
  eq(btnByText(tree, '保存').props.disabled, true, '保存必须禁用')
  eq(btnByText(tree, '恢复默认').props.disabled, true, '恢复默认必须禁用')
  btnByText(tree, '保存').props.onClick()
  eq(MUTATIONS.length, 0, '不可写时不能静默写配置')
})

/* ── 汇总 ──────────────────────────────────────────────────── */
function lastWriteOf(path) {
  const w = writesOf(path)
  return w.length ? w[w.length - 1].value : undefined
}

console.log(`\n结果：${pass} 通过 / ${process.exitCode === 1 ? '≥1' : 0} 失败`)
