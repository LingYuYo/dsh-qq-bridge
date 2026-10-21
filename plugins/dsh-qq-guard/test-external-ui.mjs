/**
 * 外部插件卡片（P0 只读展示）的离线渲染测试：
 *   · QQ Agent 的 plugin.json / skill.json 能出卡片（不再报「找不到 dsh 字段」）
 *   · 兼容性标签：依赖 Node 原生模块 / 宿主内部引用 → 只读/受控
 *   · 元数据：来源格式 / 分类 / 作者 / 被忽略的非标字段数
 *   · 默认全关；打开只写 externalPlugins.enabled（记录意图，不执行）
 *   · 坏清单也出红卡
 *
 * 用法：node test-external-ui.mjs
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

/* ── 扫描结果夹具（形状与 Host 路由一致）────────────────────── */
const SCAN = {
  ok: true,
  dirs: ['D:/qq-agent'],
  scanned: 3,
  runnable: 0,
  controlled: 1,
  invalid: 1,
  entries: [
    {
      id: 'plain-mod', name: '纯展示插件', version: '1.2.0',
      description: '第一行描述\n第二行描述，' + '这是一段很长很长的介绍文字，'.repeat(6),
      author: 'QQ Agent', category: 'message', kind: 'plugin', format: 'plugin.json',
      source: 'plugin.json', unknownFieldCount: 1, hasClient: false, hasBundle: false,
      requires: ['llm.chat'], enabled: false, warnings: [], error: '',
      entry: 'index.js', hasEntry: true,
      configSchema: {
        reply: { type: 'string', label: '回复内容', description: '收到时回什么', default: '收到', multiline: true },
        count: { type: 'number', label: '次数', default: 3, min: 1, max: 10 },
        on: { type: 'boolean', label: '开关', default: true },
        mode: { type: 'enum', label: '模式', values: ['a', 'b'], default: 'b' },
      },
      settingsDefaults: { reply: '收到', count: 3, on: true, mode: 'b' },
      dir: 'D:/qq-agent/plugins/plain-mod', relDir: 'plugins/plain-mod', dirName: 'plain-mod',
      compat: { tier: 'self-contained', label: '自包含', reasons: [] },
    },
    {
      id: 'fs-mod', name: '文件技能', version: '0.3.1', description: '用 fs 读写状态',
      author: 'someone', category: 'media', kind: 'skill', format: 'skill.json',
      source: 'skill.json', unknownFieldCount: 0, hasClient: false, hasBundle: false,
      requires: [], enabled: false, warnings: [], error: '',
      entry: 'index.js', hasEntry: true,
      configSchema: {},
      settingsDefaults: {},
      dir: 'D:/qq-agent/skills/fs-mod', relDir: 'skills/fs-mod', dirName: 'fs-mod',
      compat: {
        tier: 'controlled', label: '只读/受控',
        reasons: ['依赖 Node 原生模块：node:fs', '引用了宿主内部模块（相对路径越出插件目录）'],
      },
    },
    {
      id: 'broken', name: 'broken', version: '0.0.0', description: '',
      author: '', category: 'utility', kind: 'plugin', format: 'plugin.json',
      source: 'plugin.json', unknownFieldCount: 0, hasClient: false, hasBundle: false,
      requires: [], enabled: false, warnings: [], error: '解析 plugin.json 失败：Unexpected token',
      entry: '', hasEntry: false,
      configSchema: {},
      settingsDefaults: {},
      dir: 'D:/qq-agent/plugins/broken', relDir: 'plugins/broken', dirName: 'broken',
      compat: { tier: 'invalid', label: '清单无效', reasons: ['解析 plugin.json 失败：Unexpected token'] },
    },
  ],
}

/* P1 沙箱「测试运行」：记录请求体，响应可切换成功/失败。 */
const sandboxCalls = []
let sandboxReply = {
  ok: true,
  result: {
    moduleId: 'plain-mod', format: 'plugin.json',
    exports: { setup: true, register: false, hooks: ['onMessage'] },
    apiCalls: ['log', 'config'], durationMs: 7,
    sandbox: { pid: 4321, node: 'v24.12.0' },
  },
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
  fetch: async (url, init) => {
    // P1 沙箱测试路由要放在 scan 判断之前（前缀重叠）。
    if (url === '/dsh-qq-guard/external-plugins/test') {
      sandboxCalls.push({ url, method: init?.method ?? 'GET', body: init?.body })
      return { ok: sandboxReply.ok === true, status: sandboxReply.ok === true ? 200 : 400, json: async () => sandboxReply }
    }
    if (url.startsWith('/dsh-qq-guard/external-plugins')) {
      return { ok: true, status: 200, json: async () => SCAN }
    }
    if (url.includes('/bridge?action=status')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, alive: false }) }
    }
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

/* ── 装配（与 test-skills 同款的最小配置表单）────────────────── */
const VALUE = {
  skills: [], plugins: [],
  rhythm: {
    activityLevel: 1, debounceWindowMs: 800, batchIntervalMs: 2500,
    rateLimit: { perMin: 12, burst: 3, silent: true },
    mute: { enabled: true, words: ['闭嘴'], seconds: 60 },
  },
  externalPlugins: { dirs: ['D:/qq-agent'], enabled: [], settings: {} },
  bubbleMaxChars: 30, mergeMaxChars: 15, chunkSize: 1000, sendIntervalMs: 500,
  typingDelay: { enabled: true }, flypitDelayTiers: { short: 200, medium: 450, long: 800 },
  groupAtReply: true, groupAtPosition: 'last', trimEndPunctuation: { enabled: true },
  personaText: '', personaPresetDefault: '',
  allow: { private: [], groups: [], allowAllWhenEmpty: false },
  onebot: { wsUrl: '', accessToken: '' }, napcat: { dir: '', quickLoginQQ: '' },
  bridge: { dir: '', autoStart: false },
}
const form = {
  getSnapshot: () => ({ status: 'ready', value: VALUE, writable: true, source: 'remote' }),
  subscribe: () => () => {},
  mutate: async (ops) => {
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

/** 渲染 skills Tab；等扫描 fetch 落地后再重渲染一次拿到 entries。 */
async function renderSkills() {
  hookStore = new Map([['root:SettingsPanel#1', 'skills']])
  effects.length = 0
  let tree = expand(React.createElement(Comp, { remoteForm: form }), 'root')
  flushEffects()
  await new Promise((r) => setTimeout(r, 25))
  effects.length = 0
  tree = expand(React.createElement(Comp, { remoteForm: form }), 'root')
  return tree
}
/** 保留 state 的重渲染（等价 setState 后重渲染）。 */
function repaint() {
  effects.length = 0
  return expand(React.createElement(Comp, { remoteForm: form }), 'root')
}

/** 外部插件卡片（tile 里含 compat 标签的）。 */
function extTiles(tree) {
  return findAll(tree, (n) => n.props?.className === 'qqg-tile')
}
function tileByText(tree, text) {
  return extTiles(tree).find((t) => textOf(t).includes(text))
}

let pass = 0
const fail = []
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail.push(name); console.log(`  ✗ ${name}\n    ${e.message}`) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

/* ── 用例 ───────────────────────────────────────────────────── */
console.log('外部插件卡片（P0 只读展示）：')

const tree = await renderSkills()

check('三种形态都出卡片：plugin.json / skill.json / 坏清单', () => {
  const tiles = extTiles(tree)
  assert(tiles.length === 3, `卡片数 ${tiles.length}，应为 3`)
  for (const name of ['纯展示插件', '文件技能', 'broken']) {
    assert(tileByText(tree, name), `缺卡片「${name}」`)
  }
})

check('自包含模块 → 「自包含」标签', () => {
  const tile = tileByText(tree, '纯展示插件')
  assert(textOf(tile).includes('自包含'), '没有「自包含」标签')
})

check('依赖 node 原生 / 宿主内部 → 「只读/受控」标签 + 原因', () => {
  const tile = tileByText(tree, '文件技能')
  assert(textOf(tile).includes('只读/受控'), '没有「只读/受控」标签')
  const tag = findAll(tile, (n) => n.props?.className?.includes('qqg-tag-warn'))[0]
  assert(tag, '受控标签没有用警示样式')
  assert(String(tag.props.title).includes('node:fs'), `标签 title 缺原因：${tag.props.title}`)
})

check('坏清单 → 「清单无效」红卡 + 错误原文', () => {
  const tile = tileByText(tree, 'broken')
  assert(textOf(tile).includes('清单无效'), '没有「清单无效」标签')
  assert(textOf(tile).includes('解析 plugin.json 失败'), '没有显示错误原文')
})

check('元数据行：来源格式 / 分类 / 作者 / 非标字段数', () => {
  const plain = textOf(tileByText(tree, '纯展示插件'))
  assert(plain.includes('插件清单'), '缺来源格式')
  assert(plain.includes('分类 message'), '缺分类')
  assert(plain.includes('作者 QQ Agent'), '缺作者')
  assert(plain.includes('已忽略 1 个非标字段'), '缺非标字段计数')
})

check('默认全关：每张卡片都是「已关闭」且开关 aria-checked=false', () => {
  const switches = findAll(tree, (n) => n.tag === 'button' && n.props?.role === 'switch')
  assert(switches.length === 3, `开关数 ${switches.length}`)
  for (const sw of switches) assert(sw.props['aria-checked'] === 'false', `「${sw.props['aria-label']}」不是关`)
  assert(textOf(tree).includes('已关闭'), '没有「已关闭」文案')
})

check('面板顶部统计：可跑 0 / 3、受控 1', () => {
  const joined = textOf(tree)
  assert(joined.includes('可跑 0 / 3'), '缺「可跑 0 / 3」')
  assert(joined.includes('受控 1'), '缺「受控 1」')
})

check('打开开关只写 externalPlugins.enabled（按 id）', () => {
  const tile = tileByText(tree, '文件技能')
  const sw = findAll(tile, (n) => n.tag === 'button' && n.props?.role === 'switch')[0]
  sw.props.onClick()
  assert(JSON.stringify(VALUE.externalPlugins.enabled) === JSON.stringify(['fs-mod']),
    `实际 ${JSON.stringify(VALUE.externalPlugins.enabled)}`)
})

check('重渲染后显示「已启用（仅记录意图）」', () => {
  const next = repaint()
  const tile = tileByText(next, '文件技能')
  const foot = findAll(tile, (n) => n.props?.className === 'qqg-status')[0]
  assert(textOf(foot).includes('已启用（仅记录意图）'), `实际「${textOf(foot)}」`)
  // 其它卡片仍然是关的
  const plainFoot = findAll(tileByText(next, '纯展示插件'), (n) => n.props?.className === 'qqg-status')[0]
  assert(textOf(plainFoot).includes('已关闭'), '不该连带打开其它插件')
})

/* ── P1.5：描述裁剪 / 过滤 / configSchema 弹窗 ───────────────── */
console.log('\n外部插件 · P1.5 展示与配置：')

let p15Tree = await renderSkills()

check('描述去换行 + 最多 30 字 + 省略号，title 保留全文', () => {
  const tile = tileByText(p15Tree, '纯展示插件')
  const node = findAll(tile, (n) => n.props?.className === 'qqg-tile-desc')[0]
  const text = textOf(node)
  assert(!text.includes('\n'), '描述里仍有换行')
  assert(text.endsWith('…'), `没有省略号：${text}`)
  assert([...text].length === 31, `实际 ${[...text].length} 字：${text}`)
  assert(String(node.props.title).startsWith('第一行描述 第二行描述'), `title 不是全文：${node.props.title}`)
})

check('过滤下拉：全部 / 自包含 / 受控', () => {
  const filter = findAll(p15Tree, (n) => n.tag === 'select' && n.props?.['aria-label'] === '外部插件过滤')[0]
  assert(filter, '找不到过滤下拉')
  const labels = findAll(filter, (n) => n.tag === 'option').map(textOf)
  assert(JSON.stringify(labels) === JSON.stringify(['全部 3', '自包含 1', '受控 1']), JSON.stringify(labels))
})

check('筛选「自包含」只留下自包含卡片', () => {
  const filter = findAll(p15Tree, (n) => n.tag === 'select' && n.props?.['aria-label'] === '外部插件过滤')[0]
  filter.props.onChange({ target: { value: 'self' } })
  p15Tree = repaint()
  const names = extTiles(p15Tree).map((tile) => textOf(findAll(tile, (x) => x.props?.className === 'qqg-tile-name')[0]))
  assert(JSON.stringify(names) === JSON.stringify(['纯展示插件']), JSON.stringify(names))
})

check('筛选「受控」只留下受控卡片（坏清单隐藏）', () => {
  const filter = findAll(p15Tree, (n) => n.tag === 'select' && n.props?.['aria-label'] === '外部插件过滤')[0]
  filter.props.onChange({ target: { value: 'controlled' } })
  p15Tree = repaint()
  const names = extTiles(p15Tree).map((tile) => textOf(findAll(tile, (x) => x.props?.className === 'qqg-tile-name')[0]))
  assert(JSON.stringify(names) === JSON.stringify(['文件技能']), JSON.stringify(names))
})

check('齿轮：按 configSchema 渲染 boolean / number / string / enum', () => {
  // 回到「全部」，打开配置弹窗
  findAll(p15Tree, (n) => n.tag === 'select' && n.props?.['aria-label'] === '外部插件过滤')[0]
    .props.onChange({ target: { value: 'all' } })
  p15Tree = repaint()
  const gear = findAll(tileByText(p15Tree, '纯展示插件'),
    (n) => n.tag === 'button' && n.props?.['aria-label'] === '纯展示插件 设置')[0]
  assert(gear, '自包含卡片没有配置齿轮')
  gear.props.onClick()
  p15Tree = repaint()
  assert(modalTitle(p15Tree).includes('外部插件配置'), `弹窗标题「${modalTitle(p15Tree)}」`)
  for (const label of ['回复内容', '次数', '开关', '模式']) {
    const control = findAll(p15Tree, (n) =>
      (n.tag === 'input' || n.tag === 'select' || n.tag === 'textarea'
        || (n.tag === 'button' && n.props?.role === 'switch'))
      && n.props?.['aria-label'] === label)[0]
    assert(control, `缺字段「${label}」`)
  }
})

check('受控卡片没有配置齿轮（configSchema 为空）', () => {
  const tile = tileByText(p15Tree, '文件技能')
  const gear = findAll(tile, (n) => n.tag === 'button' && n.props?.['aria-label'] === '文件技能 设置')
  assert(gear.length === 0, '受控卡片不该有齿轮')
})

check('编辑并保存 → 写入 externalPlugins.settings[模块 id]', () => {
  const setInput = (label, value) => {
    findAll(p15Tree, (n) => (n.tag === 'input' || n.tag === 'textarea')
      && n.props?.['aria-label'] === label)[0]
      .props.onChange({ target: { value } })
    p15Tree = repaint()
  }
  setInput('回复内容', '自定义回复')
  setInput('次数', '7')
  // boolean：点 switch
  findAll(p15Tree, (n) => n.tag === 'button' && n.props?.role === 'switch'
    && n.props?.['aria-label'] === '开关')[0].props.onClick()
  p15Tree = repaint()
  // enum：改下拉
  findAll(p15Tree, (n) => n.tag === 'select' && n.props?.['aria-label'] === '模式')[0]
    .props.onChange({ target: { value: 'a' } })
  p15Tree = repaint()

  findAll(p15Tree, (n) => n.tag === 'button' && textOf(n).trim() === '保存')[0].props.onClick()
  p15Tree = repaint()
  const saved = VALUE.externalPlugins.settings['plain-mod']
  assert(saved, '没有写入 settings')
  assert(saved.reply === '自定义回复' && saved.count === 7 && saved.on === false && saved.mode === 'a',
    JSON.stringify(saved))
  assert(!modalTitle(p15Tree).includes('外部插件配置'), '保存后弹窗没关')
})

check('重新打开：表单回填已保存的值', () => {
  findAll(tileByText(p15Tree, '纯展示插件'),
    (n) => n.tag === 'button' && n.props?.['aria-label'] === '纯展示插件 设置')[0].props.onClick()
  p15Tree = repaint()
  const reply = findAll(p15Tree, (n) => (n.tag === 'input' || n.tag === 'textarea')
    && n.props?.['aria-label'] === '回复内容')[0]
  const count = findAll(p15Tree, (n) => n.tag === 'input' && n.props?.['aria-label'] === '次数')[0]
  assert(reply.props.value === '自定义回复', `实测「${reply.props.value}」`)
  assert(String(count.props.value) === '7', `实测「${count.props.value}」`)
  findAll(p15Tree, (n) => n.tag === 'button' && textOf(n).trim() === '取消')[0].props.onClick()
  p15Tree = repaint()
})

/* ── P1：测试运行按钮 + 结果弹窗 ─────────────────────────────── */
console.log('\n外部插件 · 测试运行（沙箱）：')

/** 卡片里的某个按钮（按可见文字）。 */
function tileButton(tile, text) {
  return findAll(tile, (n) => n.tag === 'button' && textOf(n).trim() === text)[0]
}

/** 弹窗标题。 */
function modalTitle(tree) {
  return textOf(findAll(tree, (n) => n.props?.className === 'qqg-modal-title')[0])
}

let p1Tree = await renderSkills()

check('自包含卡片有 [测试运行]；受控 / 无入口卡片置灰', () => {
  const plainBtn = tileButton(tileByText(p1Tree, '纯展示插件'), '测试运行')
  assert(plainBtn, '自包含卡片没有「测试运行」按钮')
  assert(plainBtn.props.disabled !== true, '自包含卡片按钮不该禁用')

  const fsBtn = tileButton(tileByText(p1Tree, '文件技能'), '测试运行')
  assert(fsBtn, '受控卡片缺少按钮（应置灰而不是消失）')
  assert(fsBtn.props.disabled === true, '受控卡片按钮应禁用')
  assert(String(fsBtn.props.title).includes('P1'), `受控按钮 title 不对：${fsBtn.props.title}`)

  const brokenBtn = tileButton(tileByText(p1Tree, 'broken'), '测试运行')
  assert(brokenBtn && brokenBtn.props.disabled === true, '坏清单卡片按钮应禁用')
})

const callsBefore = sandboxCalls.length

// 点击按钮（异步动作放在 check 外面，避免假 React 的同步 check 抢跑）
tileButton(tileByText(p1Tree, '纯展示插件'), '测试运行').props.onClick()
await new Promise((r) => setTimeout(r, 40))

check('点击后 POST /external-plugins/test，body 带 id + dir', () => {
  const call = sandboxCalls[sandboxCalls.length - 1]
  assert(sandboxCalls.length === callsBefore + 1, `请求数 ${callsBefore} → ${sandboxCalls.length}`)
  assert(call.method === 'POST', `方法 ${call.method}`)
  const body = JSON.parse(call.body)
  assert(body.id === 'plain-mod', `id 是「${body.id}」`)
  assert(body.dir === 'D:/qq-agent/plugins/plain-mod', `dir 是「${body.dir}」`)
})

check('加载成功 → 「加载成功」弹窗展示 setup/hooks/api/pid', () => {
  p1Tree = repaint()
  assert(modalTitle(p1Tree) === '加载成功', `弹窗标题「${modalTitle(p1Tree)}」`)
  const text = textOf(p1Tree)
  for (const key of ['setup 有', 'onMessage', 'log、config', 'pid 4321', 'v24.12.0']) {
    assert(text.includes(key), `弹窗缺「${key}」：${text.slice(-300)}`)
  }
})

// 关闭弹窗
findAll(p1Tree, (n) => n.tag === 'button' && textOf(n).trim() === '知道了')[0].props.onClick()
p1Tree = repaint()
check('关闭弹窗后不再显示结果', () => {
  assert(!textOf(p1Tree).includes('加载成功'), '弹窗没关掉')
})

// 第二次：失败路径
sandboxReply = { ok: false, error: { code: 'E_BLOCKED_IMPORT', message: 'sandbox 拦截了对 node:fs 的引用' } }
tileButton(tileByText(p1Tree, '纯展示插件'), '测试运行').props.onClick()
await new Promise((r) => setTimeout(r, 40))
check('失败 → 「加载失败」+ 错误码与原因', () => {
  p1Tree = repaint()
  assert(modalTitle(p1Tree) === '加载失败', `弹窗标题「${modalTitle(p1Tree)}」`)
  const text = textOf(p1Tree)
  assert(text.includes('E_BLOCKED_IMPORT'), `没有显示错误码：${text.slice(-300)}`)
  assert(text.includes('node:fs'), '没有显示错误原因')
})

console.log(`\n结果：${pass} 通过 / ${fail.length} 失败`)
process.exit(fail.length ? 1 : 0)
