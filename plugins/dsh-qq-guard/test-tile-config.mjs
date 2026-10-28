/**
 * 「技能与插件」齿轮弹窗（真实 Config 读写）+ 会话管理「响应档位」的离线测试。
 *
 * 做法与 test-skills.mjs 一致：用假 React 把组件渲染成元素树，再从树里捞出
 * onChange / onClick 回调直接调用，最后断言写盘调用的 path 与 value。
 * 配置读写走真实的 get(path) / write(path, value) 通路（form.mutate 被记录）。
 *
 * 用法：node test-tile-config.mjs
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
  // 只登记不执行：本测试不 flush effect（弹窗的草稿重置 effect 在假 React 里
  // 忽略 deps 会每次渲染都清空草稿，真 React 只在换条目时跑）。
  useEffect(fn) { effects.push(fn) },
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

/* ── 配置夹具（形状与 Host 侧 Config 一致）──────────────────── */
let mod
const FEED = []
const MUTATIONS = []
function makeValue() {
  return {
    skills: [
      { id: 'sk-voice', name: '发语音', icon: 'send', tag: '内置', ver: '1.0.2', enabled: true, desc: '合成语音' },
      { id: 'sk-vision', name: '图片理解', icon: 'image', tag: '内置', ver: '1.3.2', enabled: true, desc: '识别图片' },
      { id: 'sk-memory', name: '记忆与上下文', icon: 'memory', tag: '内置', ver: '2.0.0', enabled: true, desc: '注入聊天记录' },
      { id: 'sk-remind', name: '定时提醒', icon: 'clock', tag: '内置', ver: '1.1.0', enabled: false, desc: '到点提醒' },
      { id: 'custom-1700000000000', name: '手动技能', icon: 'spark', tag: '自定义', ver: '0.1.0', enabled: false, desc: '手动添加' },
    ],
    plugins: [
      { id: 'pl-debounce', name: '防抖合并', icon: 'activity', tag: '本地', ver: '1.4.0', enabled: true, desc: '合并短消息' },
      { id: 'pl-ratelimit', name: '频率控制', icon: 'shield', tag: '本地', ver: '1.1.0', enabled: true, desc: '按会话限流' },
    ],
    rhythm: {
      activityLevel: 1, debounceWindowMs: 800, batchIntervalMs: 2500,
      rateLimit: { perMin: 12, burst: 3, silent: true },
      mute: { enabled: true, words: ['闭嘴'], seconds: 60 },
    },
    voice: { provider: 'edge', voice: 'zh-CN-XiaoyiNeural', apiKey: 'sk-already-saved', baseUrl: '' },
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
  fetch: async (url, init) => {
    FEED.push({ url: String(url), init })
    if (String(url).includes('/session-ops')) return { ok: true, json: async () => ({ ok: true }) }
    throw new Error('offline')
  },
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
function render(formOverride) {
  return expand(React.createElement(Comp, { remoteForm: formOverride ?? form }), 'root')
}

/** 从头渲染 skills Tab。 */
function resetSkills(formOverride) {
  hookStore = new Map([['root:SettingsPanel#1', 'skills']])
  return render(formOverride)
}

/** 从头渲染 sessions Tab，并预置桥接上报的会话列表。
 *  会话列表的轮询状态现在只存在于叶子组件 SessionsTab 内部（`#0` = live），
 *  面板层不再持有它（P2 轮询隔离）。 */
function resetSessions(live, formOverride) {
  hookStore = new Map([
    ['root:SettingsPanel#1', 'sessions'],
    ['root.div3.div0:SessionsTab#0', live],
  ])
  return render(formOverride)
}

function modalOf(tree) {
  return findAll(tree, (n) => String(n.props?.className ?? '').split(' ').includes('qqg-modal'))[0]
}
function inModal(tree, pred) { return findAll(modalOf(tree), pred) }
function byAria(tree, label) { return inModal(tree, (n) => n.props?.['aria-label'] === label)[0] }
function btnByText(tree, text) {
  return findAll(modalOf(tree), (n) => n.tag === 'button' && textOf(n).trim() === text)[0]
}
/** 点某张卡片的齿轮。 */
function openGear(tree, name) {
  findAll(tree, (n) => n.tag === 'button' && n.props?.['aria-label'] === `${name} 设置`)[0]
    .props.onClick({ stopPropagation() {} })
}
/** select 的候选值列表。 */
function optionValues(node) {
  return findAll(node, (n) => n.tag === 'option').map((n) => n.props?.value)
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
function lastWrite(path) { const w = writesOf(path); return w.length ? w[w.length - 1].value : undefined }
function reset() { MUTATIONS.length = 0; FEED.length = 0; VALUE = makeValue() }

/* ── 用例：sk-voice 字段集 / 保存 ──────────────────────────── */
console.log('技能弹窗（真实配置）：')

await check('sk-voice：字段集 = 后端 / 音色（Edge 默认不显示 Key 与 baseUrl）', () => {
  reset()
  let tree = resetSkills()
  openGear(tree, '发语音')
  tree = render()
  const provider = byAria(tree, '语音后端')
  truthy(provider, '缺少「语音后端」下拉')
  // 2026-10-24：baidu（免 Key）成为默认后端，候选里排第一；edge 保留但已不可用。
  eq(optionValues(provider), ['baidu', 'edge', 'openai'], '后端候选')
  const voice = byAria(tree, '音色')
  eq(optionValues(voice), ['zh-CN-XiaoyiNeural', 'zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural'], 'Edge 音色候选')
  eq(provider.props.value, 'edge', '初值取真实配置')
  eq(byAria(tree, 'API Key'), undefined, 'provider=edge 时不该出现 Key 输入框')
  eq(byAria(tree, '接口地址 baseUrl'), undefined, 'provider=edge 时不该出现 baseUrl 输入框')
})

await check('sk-voice：切到 openai 后出现 Key / baseUrl，音色候选换成 OpenAI 短名', () => {
  reset()
  let tree = resetSkills()
  openGear(tree, '发语音')
  tree = render()
  byAria(tree, '语音后端').props.onChange({ target: { value: 'openai' } })
  tree = render()
  truthy(byAria(tree, 'API Key'), 'provider=openai 时应出现 Key 输入框')
  truthy(byAria(tree, '接口地址 baseUrl'), 'provider=openai 时应出现 baseUrl 输入框')
  eq(optionValues(byAria(tree, '音色')),
    ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'], 'OpenAI 音色候选')
  eq(byAria(tree, '音色').props.value, 'alloy', '切后端后音色自动落到该后端第一项')
})

await check('sk-voice：保存按路径写回，且 Key 不回显明文', () => {
  reset()
  let tree = resetSkills()
  openGear(tree, '发语音')
  tree = render()
  // 已保存的 Key 不能被回显（输入框初值必须是空串，只给「已保存」提示）。
  byAria(tree, '语音后端').props.onChange({ target: { value: 'openai' } })
  tree = render()
  eq(byAria(tree, 'API Key').props.value, '', 'Key 输入框不能回显已保存的明文')
  eq(byAria(tree, 'API Key').props.type, 'password', 'Key 必须是密码框')
  eq(byAria(tree, 'API Key').props.placeholder, '已保存（留空 = 不修改）', 'Key 占位提示')

  byAria(tree, '音色').props.onChange({ target: { value: 'nova' } })
  byAria(tree, 'API Key').props.onChange({ target: { value: 'sk-new-key' } })
  byAria(tree, '接口地址 baseUrl').props.onChange({ target: { value: 'https://api.example.com/v1' } })
  tree = render()
  btnByText(tree, '保存').props.onClick()
  eq(lastWrite('voice.provider'), 'openai', 'voice.provider')
  eq(lastWrite('voice.voice'), 'nova', 'voice.voice')
  eq(lastWrite('voice.apiKey'), 'sk-new-key', 'voice.apiKey')
  eq(lastWrite('voice.baseUrl'), 'https://api.example.com/v1', 'voice.baseUrl')
  eq(modalOf(render()), undefined, '保存后弹窗关闭')
})

await check('sk-voice：只改后端时，留空的 Key 不会被清掉', () => {
  reset()
  let tree = resetSkills()
  openGear(tree, '发语音')
  tree = render()
  byAria(tree, '语音后端').props.onChange({ target: { value: 'openai' } })
  tree = render()
  btnByText(tree, '保存').props.onClick()
  eq(writesOf('voice.apiKey').length, 0, '留空时不该写 voice.apiKey')
  eq(lastWrite('voice.provider'), 'openai', '其它字段照常写入')
})

/* ── 用例：pl-debounce / pl-ratelimit ─────────────────────── */
await check('pl-debounce：只有防抖窗口一个数字框，保存写 rhythm.debounceWindowMs', () => {
  reset()
  let tree = resetSkills()
  openGear(tree, '防抖合并')
  tree = render()
  const win = byAria(tree, '防抖合并窗口（毫秒）')
  truthy(win, '缺少防抖窗口输入框')
  eq(win.props.type, 'number', '防抖窗口必须是数字框')
  eq(win.props.value, 800, '初值取真实配置')
  win.props.onChange({ target: { value: '1500' } })
  tree = render()
  btnByText(tree, '保存').props.onClick()
  eq(lastWrite('rhythm.debounceWindowMs'), 1500, '写入 1500')
})

await check('pl-ratelimit：三个字段（上限 / 突发 / 静默），保存各写各的路径', () => {
  reset()
  let tree = resetSkills()
  openGear(tree, '频率控制')
  tree = render()
  const perMin = byAria(tree, '每会话每分钟上限')
  const burst = byAria(tree, '允许突发条数')
  const silent = findAll(modalOf(tree), (n) => n.tag === 'button' && n.props?.role === 'switch')[0]
  truthy(perMin && burst && silent, '缺少限流三件套')
  eq(perMin.props.value, 12, '每分钟上限初值')
  eq(burst.props.value, 3, '突发条数初值')
  eq(silent.props['aria-checked'], 'true', '静默开关初值')
  perMin.props.onChange({ target: { value: '30' } })
  burst.props.onChange({ target: { value: '5' } })
  silent.props.onClick()
  tree = render()
  btnByText(tree, '保存').props.onClick()
  eq(lastWrite('rhythm.rateLimit.perMin'), 30, 'perMin')
  eq(lastWrite('rhythm.rateLimit.burst'), 5, 'burst')
  eq(lastWrite('rhythm.rateLimit.silent'), false, 'silent')
})

await check('恢复默认：写回 index.js Config 的默认值（不是清空草稿）', () => {
  reset()
  let tree = resetSkills()
  openGear(tree, '防抖合并')
  tree = render()
  byAria(tree, '防抖合并窗口（毫秒）').props.onChange({ target: { value: '3000' } })
  tree = render()
  btnByText(tree, '恢复默认').props.onClick()
  eq(lastWrite('rhythm.debounceWindowMs'), 800, '恢复默认写成 Config 默认 800')
  tree = render()
  eq(byAria(tree, '防抖合并窗口（毫秒）').props.value, 800, '表单也回到默认值')
})

await check('恢复默认：后端/音色回默认，但不碰已保存的 API Key', () => {
  reset()
  let tree = resetSkills()
  openGear(tree, '发语音')
  tree = render()
  byAria(tree, '语音后端').props.onChange({ target: { value: 'openai' } })
  tree = render()
  btnByText(tree, '恢复默认').props.onClick()
  eq(lastWrite('voice.provider'), 'edge', '后端回到默认 edge')
  eq(lastWrite('voice.voice'), 'zh-CN-XiaoyiNeural', '音色回到默认晓伊')
  eq(writesOf('voice.apiKey').length, 0, '恢复默认不该清掉已保存的 Key')
})

/* ── 用例：开发中 / 无可调配置 / 未知 id 兜底 ───────────────── */
await check('已实装条目（记忆与上下文）：齿轮里是真实表单，不再是「开发中」', () => {
  reset()
  let tree = resetSkills()
  openGear(tree, '记忆与上下文')
  tree = render()
  const joined = textOf(modalOf(tree))
  if (joined.includes('开发中')) throw new Error('合并后的卡片已实装，不该再显示「开发中」')
  truthy(joined.includes('启用记忆与上下文'), `缺少总闸开关，实际：${joined}`)
  eq(btnByText(tree, '保存') !== undefined, true, '已实装条目应有「保存」按钮')
})

await check('未实装条目（定时提醒）：弹窗写「开发中」+ 原因，且没有任何表单控件', () => {
  reset()
  let tree = resetSkills()
  openGear(tree, '定时提醒')
  tree = render()
  const joined = textOf(modalOf(tree))
  truthy(joined.includes('开发中'), '缺少「开发中」标签')
  truthy(joined.includes('定时提醒还没实装'), `缺少具体原因，实际文案：${joined}`)
  eq(findAll(modalOf(tree), (n) => n.tag === 'input' || n.tag === 'select').length, 0,
    '开发中条目不能出现假表单')
  eq(btnByText(tree, '保存'), undefined, '开发中条目不该有「保存」按钮')
  eq(btnByText(tree, '关闭') !== undefined, true, '开发中条目给「关闭」按钮')
})

await check('已接入但无可调项（图片理解）：写「无可调配置」，也不摆假表单', () => {
  reset()
  let tree = resetSkills()
  openGear(tree, '图片理解')
  tree = render()
  const joined = textOf(modalOf(tree))
  truthy(joined.includes('无可调配置'), `缺少「无可调配置」，实际：${joined}`)
  eq(findAll(modalOf(tree), (n) => n.tag === 'input' || n.tag === 'select').length, 0,
    '无可调项条目不能出现假表单')
})

await check('未知 id（手动添加的自定义条目）走兜底：不崩、不空弹窗、无表单', () => {
  reset()
  let tree = resetSkills()
  openGear(tree, '手动技能')
  tree = render()
  const modal = modalOf(tree)
  truthy(modal, '未知 id 也要能弹出弹窗')
  const joined = textOf(modal)
  truthy(joined.includes('开发中'), '未知 id 标「开发中」')
  truthy(joined.includes('没有对应的桥接实现'), `缺少兜底原因，实际：${joined}`)
  eq(findAll(modal, (n) => n.tag === 'input' || n.tag === 'select').length, 0, '未知 id 不能出现表单')
})

/* ── 用例：配置不可写时禁用一切输入 ────────────────────────── */
await check('writable=false：输入与保存/恢复默认按钮全部禁用，且不写盘', () => {
  reset()
  let tree = resetSkills(readonlyForm)
  openGear(tree, '防抖合并')
  tree = render(readonlyForm)
  const win = byAria(tree, '防抖合并窗口（毫秒）')
  eq(win.props.disabled, true, '数字框必须禁用')
  eq(btnByText(tree, '保存').props.disabled, true, '保存必须禁用')
  eq(btnByText(tree, '恢复默认').props.disabled, true, '恢复默认必须禁用')
  // 即便硬调用保存，也不该产生写盘
  btnByText(tree, '保存').props.onClick()
  eq(MUTATIONS.length, 0, '不可写时不能静默写配置')
})

/* ── 用例：会话管理 · 单群响应档位 ─────────────────────────── */
console.log('\n会话管理 · 单群响应档位：')

const LIVE = {
  sessions: [
    { key: 'g:123456', sessionId: 's2', kind: 'group', qq: '123456', name: '摸鱼群',
      title: '群聊-摸鱼群(123456)', unread: 0, lastAt: Date.now(), lastText: '今天这破网',
      persona: '', activityLevel: 2 },
    { key: 'u:1000000001', sessionId: 's1', kind: 'private', qq: '1000000001', name: '翎羽',
      title: '私聊-翎羽', unread: 0, lastAt: 0, lastText: '', persona: '', activityLevel: null },
  ],
}

function levelSelect(tree) {
  return findAll(tree, (n) => n.tag === 'select' && n.props?.['aria-label'] === '单群响应档位')[0]
}

await check('卡片初值取 cur.activityLevel，跟随全局项显示当前全局档位', () => {
  reset()
  const tree = resetSessions(LIVE)
  const sel = levelSelect(tree)
  truthy(sel, '缺少「单群响应档位」下拉')
  eq(sel.props.value, '2', '初值 = cur.activityLevel')
  const followed = findAll(sel, (n) => n.tag === 'option')[0]
  eq(followed.props.value, '', '「跟随全局」用空值表示 null')
  truthy(textOf(followed).includes('跟随全局（当前 1 档）'), `跟随全局文案不对：${textOf(followed)}`)
  eq(optionValues(sel), ['', '0', '1', '2', '3'], '候选 = 跟随全局 + 0..3')
  const joined = textOf(tree)
  truthy(joined.includes('仅艾特与私聊') && joined.includes('+关键词') && joined.includes('+随机')
    && joined.includes('全响应'), '缺少档位中文说明')
})

await check('覆盖生效时详情头部有「单群档位」pill；null 时不显示', () => {
  reset()
  let tree = resetSessions(LIVE)
  const pills = () => findAll(tree, (n) => n.props?.className === 'qqg-pill qqg-pill-accent'
    && textOf(n).includes('单群档位')).map(textOf)
  eq(pills(), ['单群档位 2 档'], '有覆盖的会话要显示 pill')
  // 切到 activityLevel=null 的私聊
  findAll(tree, (n) => String(n.props?.className ?? '').split(' ').includes('qqg-session')
    && typeof n.props?.onClick === 'function')[1].props.onClick()
  tree = render()
  eq(pills(), [], '跟随全局的会话不该有单群档位 pill')
})

await check('保存提交 {op:"activity", key, level}，并给出 notice', async () => {
  reset()
  let tree = resetSessions(LIVE)
  levelSelect(tree).props.onChange({ target: { value: '0' } })
  tree = render()
  findAll(tree, (n) => n.tag === 'button' && textOf(n).trim() === '保存档位')[0].props.onClick()
  await new Promise((r) => setImmediate(r))
  const post = FEED.filter((f) => f.url.includes('/session-ops')).pop()
  truthy(post, '没有提交到 /dsh-qq-guard/session-ops')
  const body = JSON.parse(post.init.body)
  eq(body, { op: 'activity', key: 'g:123456', level: 0 }, '提交 body 形状')
  eq(post.init.method, 'POST', '必须 POST')
  tree = render()
  const joined = textOf(tree)
  truthy(joined.includes('单群响应档位已提交'), `缺少提交成功提示，实际：${joined}`)
})

await check('选「跟随全局」提交 level:null（清掉覆盖）', async () => {
  reset()
  let tree = resetSessions(LIVE)
  levelSelect(tree).props.onChange({ target: { value: '' } })
  tree = render()
  findAll(tree, (n) => n.tag === 'button' && textOf(n).trim() === '保存档位')[0].props.onClick()
  await new Promise((r) => setImmediate(r))
  const body = JSON.parse(FEED.filter((f) => f.url.includes('/session-ops')).pop().init.body)
  eq(body, { op: 'activity', key: 'g:123456', level: null }, '清覆盖时 level 必须是 null')
})

await check('桥接没上报会话时不渲染档位卡片（保持等待态）', () => {
  reset()
  hookStore = new Map([['root:SettingsPanel#1', 'sessions']])
  const tree = render()
  eq(levelSelect(tree), undefined, '没有会话时不该出现档位下拉')
  truthy(textOf(tree).includes('等待桥接上报'), '应保持等待上报空态')
})

/* ── 用例：会话详情四 Tab（v2.0，2026-10-28）────────────────── */
console.log('\n会话管理 · v2.0 四 Tab：')

const LIVE_DETAIL = {
  sessions: [
    {
      key: 'g:123456', sessionId: 's2', kind: 'group', qq: '123456', name: '摸鱼群',
      title: '群聊-摸鱼群(123456)', unread: 1, lastAt: 1700000000000, lastText: '今天这破网',
      persona: '', activityLevel: 2,
      modelRoute: 'deepseek-account/deepseek-flash',
      context: { budget: 128000, enabled: true, turns: 2, tokens: 1234, dropped: 1 },
      summary: { lastAt: 1700000000000, runs: 2, lastError: '' },
      recent: [
        { at: 1700000001000, name: '小明', qq: '1001', kind: 'group', text: '你好呀', quote: '[引用 小红] 原话' },
        { at: 1700000000000, name: '小红', qq: '1002', kind: 'group', text: '在吗', quote: '' },
      ],
      raw: { at: 1700000001000, json: '{"messageId":"m1","text":"你好呀"}' },
    },
    {
      key: 'u:1000000001', sessionId: 's1', kind: 'private', qq: '1000000001', name: '翎羽',
      title: '私聊-翎羽', unread: 0, lastAt: 0, lastText: '', persona: '', activityLevel: null,
      modelRoute: '', context: { budget: 0, enabled: false, turns: 0, tokens: 0, dropped: 0 },
      summary: { lastAt: 0, runs: 0, lastError: '' },
    },
  ],
}

function tabBtn(tree, label) {
  return findAll(tree, (n) => n.tag === 'button' && n.props?.role === 'tab'
    && textOf(n).trim() === label)[0]
}
function btnAnywhere(tree, text) {
  return findAll(tree, (n) => n.tag === 'button' && textOf(n).trim() === text)[0]
}

await check('详情头下方有四个分页，默认停在「基础配置」', () => {
  reset()
  const tree = resetSessions(LIVE_DETAIL)
  const labels = findAll(tree, (n) => n.tag === 'button' && n.props?.role === 'tab').map((n) => textOf(n).trim())
  eq(labels, ['基础配置', '记忆与摘要', '特权与权限', '调试信息'], '四个分页顺序')
  truthy(levelSelect(tree), '基础配置应包含响应档位')
  truthy(btnAnywhere(tree, '保存静态核心'), '基础配置应包含静态核心保存')
  truthy(btnAnywhere(tree, '保存动态记忆'), '基础配置应包含动态记忆保存')
  eq(btnAnywhere(tree, '生成未读归纳'), undefined, '默认不该渲染记忆 Tab')
})

await check('记忆与摘要：上下文占用 + 最近入站（带引用）+ 归纳按钮', () => {
  reset()
  let tree = resetSessions(LIVE_DETAIL)
  tabBtn(tree, '记忆与摘要').props.onClick()
  tree = render()
  const joined = textOf(tree)
  truthy(joined.includes('128,000 token'), '应显示注入预算')
  truthy(joined.includes('1,234 token / 2 条'), `应显示最近一轮注入，实际：${joined}`)
  truthy(joined.includes('引用：[引用 小红] 原话'), '引用摘要要显示出来')
  truthy(joined.includes('你好呀') && joined.includes('在吗'), '最近入站要显示')
  truthy(btnAnywhere(tree, '生成未读归纳'), '缺少归纳按钮')
  eq(levelSelect(tree), undefined, '切到记忆 Tab 后不该再渲染档位下拉')
})

await check('Token 进度条：细条 + 红色填充 + 下方读数（1.2k / 128k）', () => {
  reset()
  let tree = resetSessions(LIVE_DETAIL)
  tabBtn(tree, '记忆与摘要').props.onClick()
  tree = render()
  const track = findAll(tree, (n) => String(n.props?.className ?? '').includes('qqg-tokenbar-track'))[0]
  truthy(track, '缺少进度条')
  eq(track.props.role, 'progressbar', '要有 progressbar 语义')
  const fill = findAll(tree, (n) => String(n.props?.className ?? '').includes('qqg-tokenbar-fill'))[0]
  truthy(fill, '缺少填充部分')
  eq(fill.props.style.width, '1%', '1234 / 128000 ≈ 1%')
  const caption = findAll(tree, (n) => String(n.props?.className ?? '').includes('qqg-tokenbar-caption'))[0]
  eq(textOf(caption), '1.2k / 128k', '读数格式')
})

await check('Token 进度条：还没注入过显示 0 / 预算', () => {
  reset()
  const live = {
    sessions: [{
      ...LIVE_DETAIL.sessions[0],
      context: { budget: 128000, enabled: true, turns: 0, tokens: 0, dropped: 0 },
    }],
  }
  let tree = resetSessions(live)
  tabBtn(tree, '记忆与摘要').props.onClick()
  tree = render()
  eq(textOf(findAll(tree, (n) => String(n.props?.className ?? '').includes('qqg-tokenbar-caption'))[0]),
    '0 / 128k')
  eq(findAll(tree, (n) => String(n.props?.className ?? '').includes('qqg-tokenbar-fill'))[0].props.style.width,
    '0%')
})

await check('Token 进度条：超预算铺满，但数值如实显示', () => {
  reset()
  const live = {
    sessions: [{
      ...LIVE_DETAIL.sessions[0],
      context: { budget: 128000, enabled: true, turns: 9, tokens: 132000, dropped: 0 },
    }],
  }
  let tree = resetSessions(live)
  tabBtn(tree, '记忆与摘要').props.onClick()
  tree = render()
  eq(findAll(tree, (n) => String(n.props?.className ?? '').includes('qqg-tokenbar-fill'))[0].props.style.width,
    '100%', '超出时铺满')
  eq(textOf(findAll(tree, (n) => String(n.props?.className ?? '').includes('qqg-tokenbar-caption'))[0]),
    '132k / 128k', '★ 数值不能被截断')
})

await check('生成未读归纳 → POST {op:"summarize"}，并给出提交提示', async () => {
  reset()
  let tree = resetSessions(LIVE_DETAIL)
  tabBtn(tree, '记忆与摘要').props.onClick()
  tree = render()
  btnAnywhere(tree, '生成未读归纳').props.onClick()
  await new Promise((r) => setImmediate(r))
  const post = FEED.filter((f) => f.url.includes('/session-ops')).pop()
  truthy(post, '没有提交到 /dsh-qq-guard/session-ops')
  eq(JSON.parse(post.init.body), { op: 'summarize', key: 'g:123456' }, '提交 body 形状')
  tree = render()
  truthy(textOf(tree).includes('已提交'), '缺少提交成功提示')
})

await check('提前截断：按钮 → 确认弹窗 → POST manual-summarize', async () => {
  reset()
  let tree = resetSessions(LIVE_DETAIL)
  tabBtn(tree, '记忆与摘要').props.onClick()
  tree = render()
  const button = btnAnywhere(tree, '提前截断')
  truthy(button, '缺少「提前截断」按钮')
  button.props.onClick()
  tree = render()
  const modal = modalOf(tree)
  truthy(modal, '应弹出确认框')
  truthy(textOf(modal).includes('将提炼当前上下文'), `提示文案不对：${textOf(modal)}`)
  const confirm = findAll(modal, (n) => n.tag === 'button' && textOf(n).trim() === '确认截断')[0]
  truthy(confirm, '缺少「确认截断」按钮')
  confirm.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const post = FEED.filter((f) => f.url.includes('/session-ops')).pop()
  truthy(post, '没有提交到 /dsh-qq-guard/session-ops')
  eq(JSON.parse(post.init.body), { op: 'manual-summarize', key: 'g:123456' }, '提交 body 形状')
  tree = render()
  truthy(textOf(tree).includes('已提交'), '缺少提交成功提示')
})

await check('特权与权限：三阶名单只读展示；群会话可加入白名单 / 黑名单', () => {
  reset()
  VALUE.allow = { ...VALUE.allow, developers: ['3300000000'], owners: ['2200000000'], admins: ['1100000000'] }
  let tree = resetSessions(LIVE_DETAIL)
  tabBtn(tree, '特权与权限').props.onClick()
  tree = render()
  const joined = textOf(tree)
  for (const qq of ['3300000000', '2200000000', '1100000000']) {
    truthy(joined.includes(qq), `名单里应显示 ${qq}`)
  }
  truthy(joined.includes('全局生效'), '要说明名单是全局的')
  btnAnywhere(tree, '加入白名单').props.onClick()
  eq(lastWrite('allow.groups'), ['123456'], '群会话加入白名单写 allow.groups')
  btnAnywhere(tree, '加入黑名单').props.onClick()
  eq(lastWrite('allow.deny.groups'), ['123456'], '黑名单写 allow.deny.groups')
})

await check('特权与权限：私聊会话可授予管理员 / 主人 / 开发者', () => {
  reset()
  VALUE.allow = { ...VALUE.allow, developers: [], owners: [], admins: [] }
  let tree = resetSessions(LIVE_DETAIL)
  // 切到私聊会话（第二行）。
  findAll(tree, (n) => String(n.props?.className ?? '').split(' ').includes('qqg-session')
    && typeof n.props?.onClick === 'function')[1].props.onClick()
  tree = render()
  tabBtn(tree, '特权与权限').props.onClick()
  tree = render()
  btnAnywhere(tree, '加入开发者').props.onClick()
  eq(lastWrite('allow.developers'), ['1000000001'], '开发者名单写 allow.developers')
  btnAnywhere(tree, '加入主人').props.onClick()
  eq(lastWrite('allow.owners'), ['1000000001'], '主人名单写 allow.owners')
})

await check('调试信息：sessionId / 模型路由 / 原始 Payload', () => {
  reset()
  VALUE.developer = { debugPayload: true }
  let tree = resetSessions(LIVE_DETAIL)
  tabBtn(tree, '调试信息').props.onClick()
  tree = render()
  const joined = textOf(tree)
  truthy(joined.includes('s2'), '要显示 sessionId')
  truthy(joined.includes('deepseek-account/deepseek-flash'), '要显示实际下发路由')
  truthy(joined.includes('"messageId":"m1"'), '原始 payload 要被渲染出来')
})

await check('调试信息：开关没开时给明确提示，不渲染 payload', () => {
  reset()
  VALUE.developer = { debugPayload: false }
  let tree = resetSessions(LIVE_DETAIL)
  tabBtn(tree, '调试信息').props.onClick()
  tree = render()
  const joined = textOf(tree)
  truthy(joined.includes('未开启'), '要显示未开启状态')
  truthy(!joined.includes('"messageId":"m1"'), '没开就不该显示 payload 内容')
})

/* ── 用例：开发者特权技能卡（v2.0）────────────────────────── */
console.log('\n开发者特权技能卡：')

await check('卡片默认出现（合并默认项），带只读动态记忆预览', () => {
  reset()
  const tree = resetSkills()
  truthy(textOf(tree).includes('开发者特权'), '缺少「开发者特权」卡片')
  truthy(textOf(tree).includes('动态记忆：暂无'), '缺少只读预览占位')
})

await check('弹窗字段：开关 / 触发词 / 专属 Prompt / 原始 Payload 开关 / 只读预览', () => {
  reset()
  let tree = resetSkills()
  openGear(tree, '开发者特权')
  tree = render()
  const modal = modalOf(tree)
  const switches = findAll(modal, (n) => n.tag === 'button' && n.props?.role === 'switch')
  eq(switches.length, 3, '三个开关（暗号 / 普通群友回一句 / 原始 Payload）')
  truthy(byAria(tree, '触发关键词'), '缺少触发关键词编辑器')
  truthy(byAria(tree, '专属 Prompt'), '缺少专属 Prompt 多行框')
  truthy(textOf(modal).includes('暂无（底层还没接入自动提取'), '只读预览要说明接口先留')
  truthy(findAll(modal, (n) => String(n.props?.className ?? '').includes('qqg-devpreview')).length > 0,
    '只读预览必须用 .qqg-devpreview')
})

await check('保存写回 developer.enabled / keywords；只读预览不写盘', () => {
  reset()
  let tree = resetSkills()
  openGear(tree, '开发者特权')
  tree = render()
  // 第 0 个开关 = 启用特权暗号。
  findAll(modalOf(tree), (n) => n.tag === 'button' && n.props?.role === 'switch')[0].props.onClick()
  tree = render()
  byAria(tree, '触发关键词').props.onChange({ target: { value: '/test' } })
  tree = render()
  findAll(modalOf(tree), (n) => n.tag === 'button' && n.props?.['aria-label'] === '触发关键词 添加')[0]
    .props.onClick()
  tree = render()
  btnByText(tree, '保存').props.onClick()
  eq(lastWrite('developer.enabled'), true, '开关写回')
  // 默认值来自 client 的 DEFAULTS（/dev /admin），新增一个后整数组写回。
  eq(lastWrite('developer.keywords'), ['/dev', '/admin', '/test'], '关键词整数组写回')
  eq(lastWrite('developer.memoryNotes'), undefined, '★ 只读预览绝不能写盘')
})

await check('打开暗号但没有开发者 / Prompt 时，弹窗顶部有提示', () => {
  reset()
  VALUE.developer = { enabled: true, prompt: '', keywords: ['/dev'] }
  let tree = resetSkills()
  openGear(tree, '开发者特权')
  tree = render()
  truthy(textOf(modalOf(tree)).includes('专属 Prompt 是空的'), '缺少空 Prompt 提示')
  VALUE.developer = { enabled: true, prompt: '有内容', keywords: ['/dev'] }
  tree = resetSkills()
  openGear(tree, '开发者特权')
  tree = render()
  truthy(textOf(modalOf(tree)).includes('还没有配置开发者 QQ 号'), '缺少空名单提示')
})

/* ── 汇总 ──────────────────────────────────────────────────── */
console.log(`\n结果：${pass} 通过 / ${process.exitCode === 1 ? '≥1' : 0} 失败`)
