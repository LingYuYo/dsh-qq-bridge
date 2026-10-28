/**
 * 人设设置 UI 离线测试（紧凑概览卡 + 弹窗表单）：
 *   · 概览卡只读展示：机器人名字 / 群内展示名 / 参与度 / 角色设定前两行
 *   · 弹窗字段齐全：人设下拉、添加、删除、名字、展示名、参与度、三块文本域
 *   · 保存才写配置；取消不写
 *   · 自定义人设的增加 / 删除 / 选择回填
 *
 * 用法：node test-persona-ui.mjs
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
  fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
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

/* ── 装配 ───────────────────────────────────────────────────── */
const VALUE = {
  skills: [], plugins: [],
  rhythm: {
    activityLevel: 1, debounceWindowMs: 800, batchIntervalMs: 2500,
    rateLimit: { perMin: 12, burst: 3, silent: true },
    mute: { enabled: true, words: ['闭嘴'], seconds: 60 },
  },
  externalPlugins: { dirs: [], enabled: [], settings: {} },
  bubbleMaxChars: 30, mergeMaxChars: 15, chunkSize: 1000, sendIntervalMs: 500,
  typingDelay: { enabled: true }, flypitDelayTiers: { short: 200, medium: 450, long: 800 },
  groupAtReply: true, groupAtPosition: 'last', trimEndPunctuation: { enabled: true },
  // 人设夹具
  personaBotName: '林小鱼',
  personaGroupName: '小鱼',
  personaParticipation: 'active',
  personaCore: {
    identity: '第一行角色设定。\n第二行角色设定。\n第三行不该出现在概览里。',
    boundary: '',
    style: '',
  },
  personaText: '',
  personaExtraRules: '',
  personaSystemPrompt: '',
  personaPresets: [{
    id: 'p1',
    name: '猫娘',
    text: '你是一只傲娇猫娘。',
    botName: '猫猫',
    groupName: '喵',
    participation: 'active',
    identity: '你是一只傲娇猫娘。',
    boundary: '不咬人',
    style: '被摸头就哼',
  }],
  personaPresetId: '',
  personaPresetDefault: '默认人设正文',
  allow: { private: [], groups: [], allowAllWhenEmpty: false },
  onebot: { wsUrl: '', accessToken: '' },
  napcat: { dir: '', quickLoginQQ: '' },
  bridge: { dir: '', autoStart: false },
}
const mutations = []
const form = {
  getSnapshot: () => ({ status: 'ready', value: VALUE, writable: true, source: 'remote' }),
  subscribe: () => () => {},
  mutate: async (ops) => {
    mutations.push(ops)
    for (const op of ops) {
      if (op.op !== 'set') continue
      let cur = VALUE
      const p = op.path
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

function renderSettings() {
  hookStore = new Map([['root:SettingsPanel#1', 'settings']])
  effects.length = 0
  const tree = expand(React.createElement(Comp, { remoteForm: form }), 'root')
  flushEffects()
  return tree
}
function repaint() {
  effects.length = 0
  return expand(React.createElement(Comp, { remoteForm: form }), 'root')
}
function btnByText(tree, text) {
  return findAll(tree, (n) => n.tag === 'button' && textOf(n).trim() === text)[0]
}
function modalTitle(tree) {
  return textOf(findAll(tree, (n) => n.props?.className === 'qqg-modal-title')[0])
}
function overview() {
  return findAll(renderSettings(), (n) => n.props?.className === 'qqg-persona-card')[0]
}

let pass = 0
const fail = []
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail.push(name); console.log(`  ✗ ${name}\n    ${e.message}`) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

/* ── 用例 ───────────────────────────────────────────────────── */
console.log('人设设置（概览卡 + 弹窗）：')

check('概览卡只读展示名字 / 展示名 / 参与度', () => {
  const card = overview()
  assert(card, '找不到人设概览卡')
  const text = textOf(card)
  for (const key of ['林小鱼', '小鱼', '活跃型']) assert(text.includes(key), `缺「${key}」：${text}`)
})

check('角色设定只截前两行', () => {
  const card = overview()
  const preview = textOf(findAll(card, (n) => n.props?.className === 'qqg-persona-preview')[0])
  assert(preview.includes('第一行角色设定'), preview)
  assert(preview.includes('第二行角色设定'), preview)
  assert(!preview.includes('第三行'), `预览里出现了第三行：${preview}`)
})

check('概览卡有 [⚙️ 编辑人设] 按钮，且不再铺开大文本框', () => {
  const tree = renderSettings()
  assert(btnByText(tree, '⚙️ 编辑人设'), '缺编辑按钮')
  const textareas = findAll(tree, (n) => n.tag === 'textarea')
  assert(textareas.length === 0, `设置页仍有 ${textareas.length} 个直接铺开的文本框`)
})

check('点编辑 → 弹窗包含全部字段与提示语', () => {
  let tree = renderSettings()
  btnByText(tree, '⚙️ 编辑人设').props.onClick()
  tree = repaint()
  assert(modalTitle(tree) === '人设设置', `弹窗标题「${modalTitle(tree)}」`)
  for (const label of ['选择人设', '机器人名字', '群内展示名', '参与度',
    '身份定义与气质', '边界与安全红线', '交互策略与应对模式']) {
    const found = findAll(tree, (n) => n.props?.['aria-label'] === label)[0]
    assert(found, `缺字段「${label}」`)
  }
  for (const label of ['+ 添加人设', '删除当前自定义人设', '保存', '取消']) {
    assert(btnByText(tree, label), `缺按钮「${label}」`)
  }
  assert(textOf(tree).includes('改动要点保存才会生效'), '缺底部提示语')
})

check('参与度下拉有三档', () => {
  let tree = renderSettings()
  btnByText(tree, '⚙️ 编辑人设').props.onClick()
  tree = repaint()
  const select = findAll(tree, (n) => n.tag === 'select' && n.props?.['aria-label'] === '参与度')[0]
  const labels = findAll(select, (n) => n.tag === 'option').map(textOf)
  assert(JSON.stringify(labels) === JSON.stringify(['安静型', '普通群友', '活跃型']), JSON.stringify(labels))
})

check('编辑并保存 → 六项写进当前模板与全局，弹窗关闭', () => {
  mutations.length = 0
  let tree = renderSettings()
  btnByText(tree, '⚙️ 编辑人设').props.onClick()
  tree = repaint()
  const change = (label, value) => {
    const node = findAll(tree, (n) => (n.tag === 'input' || n.tag === 'textarea' || n.tag === 'select')
      && n.props?.['aria-label'] === label)[0]
    assert(node, `找不到字段「${label}」`)
    node.props.onChange({ target: { value } })
    tree = repaint()
  }
  // v2.0 第十三步：默认内置时六项禁用；先选一个模板再改。
  findAll(tree, (n) => n.tag === 'select' && n.props?.['aria-label'] === '选择人设')[0]
    .props.onChange({ target: { value: 'p1' } })
  tree = repaint()
  change('机器人名字', '深海小鱼')
  change('群内展示名', '小鱼酱')
  change('参与度', 'quiet')
  change('身份定义与气质', '新的角色设定\n第二行')
  change('边界与安全红线', '别说脏话')
  change('交互策略与应对模式', '被骂就损回去')
  btnByText(tree, '保存').props.onClick()
  tree = repaint()
  assert(VALUE.personaBotName === '深海小鱼', VALUE.personaBotName)
  assert(VALUE.personaGroupName === '小鱼酱', VALUE.personaGroupName)
  assert(VALUE.personaParticipation === 'quiet', VALUE.personaParticipation)
  assert(VALUE.personaCore.identity === '新的角色设定\n第二行', JSON.stringify(VALUE.personaCore))
  assert(VALUE.personaCore.boundary === '别说脏话')
  assert(VALUE.personaCore.style === '被骂就损回去')
  assert(VALUE.personaText === '', '旧大文本框应被清空，避免两套设定叠加')
  // 六项必须完整写进 p1 模板本身
  const preset = VALUE.personaPresets.find((item) => item.id === 'p1')
  assert(preset.botName === '深海小鱼', JSON.stringify(preset))
  assert(preset.groupName === '小鱼酱')
  assert(preset.participation === 'quiet')
  assert(preset.identity === '新的角色设定\n第二行')
  assert(preset.boundary === '别说脏话')
  assert(preset.style === '被骂就损回去')
  assert(VALUE.personaPresetId === 'p1')
  assert(!modalTitle(tree).includes('人设设置'), '保存后弹窗没关')
})

check('切换模板 / 新建 / 回到默认内置：六项完整重置，不残留', () => {
  // 上一个用例改过 p1，这里先重置夹具，保证断言的是固定数据。
  const p1 = VALUE.personaPresets.find((item) => item.id === 'p1')
  Object.assign(p1, {
    botName: '猫猫', groupName: '喵', participation: 'active',
    identity: '你是一只傲娇猫娘。', boundary: '不咬人', style: '被摸头就哼',
  })
  let tree = renderSettings()
  btnByText(tree, '⚙️ 编辑人设').props.onClick()
  tree = repaint()
  const field = (label) => findAll(tree, (n) => (n.tag === 'input' || n.tag === 'textarea' || n.tag === 'select')
    && n.props?.['aria-label'] === label)[0]
  const snapshot = () => ['机器人名字', '群内展示名', '参与度', '身份定义与气质', '边界与安全红线', '交互策略与应对模式']
    .map((label) => String(field(label).props.value ?? ''))
  const choose = (id) => {
    findAll(tree, (n) => n.tag === 'select' && n.props?.['aria-label'] === '选择人设')[0]
      .props.onChange({ target: { value: id } })
    tree = repaint()
  }
  // 选 p1 → 六项 = 模板数据
  choose('p1')
  assert(JSON.stringify(snapshot()) === JSON.stringify(['猫猫', '喵', 'active', '你是一只傲娇猫娘。', '不咬人', '被摸头就哼']),
    JSON.stringify(snapshot()))
  // 回到默认内置 → 六项全空且禁用
  choose('')
  assert(JSON.stringify(snapshot()) === JSON.stringify(['', '', 'normal', '', '', '']), JSON.stringify(snapshot()))
  assert(field('身份定义与气质').props.disabled === true, '默认内置时正文应禁用')
  // 新建 → 六项全空、可编辑
  choose('p1')
  btnByText(tree, '+ 添加人设').props.onClick()
  tree = repaint()
  assert(JSON.stringify(snapshot()) === JSON.stringify(['', '', 'normal', '', '', '']),
    `新建后应全空，实际 ${JSON.stringify(snapshot())}`)
  assert(field('身份定义与气质').props.disabled !== true, '新建模板应可编辑')
})

check('取消不写配置', () => {
  const before = VALUE.personaBotName
  let tree = renderSettings()
  btnByText(tree, '⚙️ 编辑人设').props.onClick()
  tree = repaint()
  findAll(tree, (n) => n.tag === 'input' && n.props?.['aria-label'] === '机器人名字')[0]
    .props.onChange({ target: { value: '不该保存' } })
  tree = repaint()
  btnByText(tree, '取消').props.onClick()
  tree = repaint()
  assert(VALUE.personaBotName === before, `取消后仍被改成「${VALUE.personaBotName}」`)
})

check('添加人设 → 下拉多一项，保存后写入列表并选中', () => {
  let tree = renderSettings()
  btnByText(tree, '⚙️ 编辑人设').props.onClick()
  tree = repaint()
  btnByText(tree, '+ 添加人设').props.onClick()
  tree = repaint()
  const select = findAll(tree, (n) => n.tag === 'select' && n.props?.['aria-label'] === '选择人设')[0]
  const options = findAll(select, (n) => n.tag === 'option').map(textOf)
  assert(options.length === 3, JSON.stringify(options)) // 默认 + 猫娘 + 新人设
  findAll(tree, (n) => n.tag === 'textarea' && n.props?.['aria-label'] === '身份定义与气质')[0]
    .props.onChange({ target: { value: '新人设正文' } })
  tree = repaint()
  btnByText(tree, '保存').props.onClick()
  tree = repaint()
  assert(VALUE.personaPresets.length === 2, JSON.stringify(VALUE.personaPresets))
  const added = VALUE.personaPresets.find((p) => p.identity === '新人设正文')
  assert(added, '新人设没写进列表')
  assert(VALUE.personaPresetId === added.id, `选中 id 是「${VALUE.personaPresetId}」`)
})

check('选择已有自定义人设 → 六项完整回填', () => {
  const p1 = VALUE.personaPresets.find((item) => item.id === 'p1')
  Object.assign(p1, {
    botName: '猫猫', groupName: '喵', participation: 'active',
    identity: '你是一只傲娇猫娘。', boundary: '不咬人', style: '被摸头就哼',
  })
  let tree = renderSettings()
  btnByText(tree, '⚙️ 编辑人设').props.onClick()
  tree = repaint()
  findAll(tree, (n) => n.tag === 'select' && n.props?.['aria-label'] === '选择人设')[0]
    .props.onChange({ target: { value: 'p1' } })
  tree = repaint()
  const valueOf = (label) => findAll(tree, (n) => n.tag === 'textarea' || n.tag === 'input' || n.tag === 'select')
    .find((n) => n.props?.['aria-label'] === label)
  assert(valueOf('身份定义与气质').props.value === '你是一只傲娇猫娘。', valueOf('身份定义与气质').props.value)
  assert(valueOf('机器人名字').props.value === '猫猫', valueOf('机器人名字').props.value)
  assert(valueOf('群内展示名').props.value === '喵')
  assert(valueOf('参与度').props.value === 'active')
  assert(valueOf('边界与安全红线').props.value === '不咬人')
  assert(valueOf('交互策略与应对模式').props.value === '被摸头就哼')
  btnByText(tree, '取消').props.onClick()
})

check('自定义人设可改名，保存写回 personaPresets[].name', () => {
  let tree = renderSettings()
  btnByText(tree, '⚙️ 编辑人设').props.onClick()
  tree = repaint()
  const nameInput = () => findAll(tree, (n) => n.tag === 'input'
    && n.props?.['aria-label'] === '人设名称')[0]
  // 先切回默认人设：默认人设没有名字可改，输入框不该出现。
  findAll(tree, (n) => n.tag === 'select' && n.props?.['aria-label'] === '选择人设')[0]
    .props.onChange({ target: { value: '' } })
  tree = repaint()
  assert(!nameInput(), '默认人设下不该显示「人设名称」输入框')
  // 选自定义人设 → 出现改名输入框，初值是当前 name。
  findAll(tree, (n) => n.tag === 'select' && n.props?.['aria-label'] === '选择人设')[0]
    .props.onChange({ target: { value: 'p1' } })
  tree = repaint()
  assert(nameInput(), '选中自定义人设后缺「人设名称」输入框')
  const toolbar = findAll(tree, (n) => n.props?.className === 'qqg-persona-toolbar')[0]
  assert(findAll(toolbar, (n) => n.props?.['aria-label'] === '人设名称').length === 1,
    '「人设名称」输入框应在人设工具栏里')
  assert(nameInput().props.value === '猫娘', `初始名称不对：${nameInput().props.value}`)
  nameInput().props.onChange({ target: { value: '傲娇猫娘' } })
  tree = repaint()
  // 下拉选项文案跟着 draft 同步（保存前就该看到新名字）。
  const options = findAll(tree, (n) => n.tag === 'option').map(textOf)
  assert(options.includes('傲娇猫娘'), `下拉没同步新名字：${options.join('、')}`)
  btnByText(tree, '保存').props.onClick()
  tree = repaint()
  const preset = VALUE.personaPresets.find((p) => p.id === 'p1')
  assert(preset && preset.name === '傲娇猫娘', `改名没写回：${JSON.stringify(VALUE.personaPresets)}`)
})

check('删除当前自定义人设 → 清空选择并回落到默认', () => {
  let tree = renderSettings()
  btnByText(tree, '⚙️ 编辑人设').props.onClick()
  tree = repaint()
  findAll(tree, (n) => n.tag === 'select' && n.props?.['aria-label'] === '选择人设')[0]
    .props.onChange({ target: { value: 'p1' } })
  tree = repaint()
  btnByText(tree, '删除当前自定义人设').props.onClick()
  tree = repaint()
  const textarea = findAll(tree, (n) => n.tag === 'textarea' && n.props?.['aria-label'] === '身份定义与气质')[0]
  assert(textarea.props.value === '', `删除后身份定义应为空，实际「${textarea.props.value}」`)
  btnByText(tree, '保存').props.onClick()
  tree = repaint()
  assert(VALUE.personaPresetId === '', `选中 id 应为空，实际「${VALUE.personaPresetId}」`)
  assert(!VALUE.personaPresets.some((p) => p.id === 'p1'), 'p1 没被删掉')
})

console.log(`\n结果：${pass} 通过 / ${fail.length} 失败`)
process.exit(fail.length ? 1 : 0)
