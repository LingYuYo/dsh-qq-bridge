/**
 * 「数据与用量」页的数据接线冒烟测试（离线，不连浏览器）。
 *
 * 锁死四件事：
 *   1. useUsage 真的打 `/dsh-qq-guard/usage?days=7`，并 5 秒轮询；
 *   2. 今日概览 / 图表 / 三张表用的都是接口返回的真实字段（不再出现旧 Mock 数字）；
 *   3. 「按会话统计」按接口的 sessions 数组渲染，私聊/群聊标签正确；
 *   4. 单价配置从 `usagePricing` 读值写回；未配单价时成本显示「—」，配了显示金额。
 *
 * 运行：node test-usage-ui.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

/* ── 假 React：useEffect 先收集，渲染完手动跑（这样能等 fetch 回包再重渲染）── */
let hookStore = new Map()
let hookKey = 'root'
let hookCursor = 0
let effects = []
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
  useRef(init) { return { current: init } },
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
}

/* ── 真实接口返回形状（字段来自 usage-stats.mjs 的 snapshot）──────── */
function usagePayload({ configured = true } = {}) {
  const day = (key, calls, tokens, input, output, cacheRead, cost, ok, turnOk, turnFail) => ({
    day: key, calls, noUsage: 0, input, output, cacheRead, cacheWrite: 0, reasoning: 0,
    tokens, cost, turnOk, turnFail, ok,
  })
  const days = [
    day('2026-10-17', 0, 0, 0, 0, 0, configured ? 0 : null, null, 0, 0),
    day('2026-10-18', 0, 0, 0, 0, 0, configured ? 0 : null, null, 0, 0),
    day('2026-10-19', 0, 0, 0, 0, 0, configured ? 0 : null, null, 0, 0),
    day('2026-10-20', 10, 83356, 79601, 3755, 0, configured ? 0.91 : null, 100, 9, 0),
    day('2026-10-21', 14, 215221, 214679, 542, 0, configured ? 2.02 : null, 100, 14, 0),
    day('2026-10-22', 5, 45852, 22835, 233, 22784, configured ? 0.41 : null, 40, 2, 3),
    day('2026-10-23', 14, 339885, 57971, 698, 281216, configured ? 3.21 : null, 92.3, 12, 1),
  ]
  return {
    ok: true,
    version: 1,
    generatedAt: 1792695000000,
    updatedAt: 1792694900000,
    scope: { sessionCwd: 'D:\\QQChat', mapped: 1, sessions: 1 },
    pricing: { configured, rules: configured ? 1 : 0 },
    backfill: { running: false, done: true, at: 1792694000000, scanned: 2, imported: 84, error: null },
    today: days[days.length - 1],
    yesterday: days[days.length - 2],
    trend: { calls: 180, tokens: 641.3, cost: configured ? 682.9 : null },
    days,
    models: [
      {
        key: 'trae/deepseek-v4.1-flash', name: 'trae/deepseek-v4.1-flash',
        provider: 'trae', model: 'deepseek-v4.1-flash',
        calls: 24, noUsage: 0, input: 294280, output: 4297, cacheRead: 0, cacheWrite: 0, reasoning: 3548,
        tokens: 298577, cost: configured ? 2.51 : null, share: 43.6,
      },
    ],
    sessions: [
      {
        groupKey: 'u:10001', sessionId: 'session-test', sessionIds: ['session-test'],
        key: 'u:10001', kind: '私聊', qq: '10001', label: '私聊 10001',
        calls: 43, noUsage: 5, input: 375086, output: 5228, cacheRead: 304000, cacheWrite: 0,
        reasoning: 3548, tokens: 684314, cost: configured ? 3.21 : null, share: 100,
        lastAt: 1792690372290, models: {},
      },
    ],
  }
}

/* ── 加载 client.js ─────────────────────────────────────────── */
let mod
let payload = usagePayload({ configured: true })
const fetchCalls = []
const timers = []
const window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => React) } } }
const sandbox = {
  window,
  React,
  console: { ...console, warn: () => {}, error: () => {} },
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
  clearTimeout: () => {},
  fetch: async (url) => {
    const target = String(url)
    fetchCalls.push(target)
    if (target.includes('/dsh-qq-guard/usage')) {
      return { ok: true, status: 200, json: async () => payload }
    }
    if (target.includes('/dsh-qq-guard/bridge') || target.includes('/dsh-qq-guard/napcat')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    return { ok: false, status: 404, json: async () => ({ ok: false }) }
  },
  document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} }, getElementById: () => null },
}
vm.createContext(sandbox)
vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })

/* ── 渲染工具 ───────────────────────────────────────────────── */
const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link'])
const textSink = []
const elements = []
function render(node, path = 'root') {
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') { textSink.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach((n, i) => render(n, `${path}[${i}]`)); return }
  const { type, props } = node
  const children = props?.children ?? []
  if (type === React.Fragment) { children.forEach((c, i) => render(c, `${path}.f${i}`)); return }
  if (typeof type === 'string') {
    elements.push({ tag: type, props, path })
    children.forEach((c, i) => render(c, `${path}.${type}${i}`))
    return
  }
  if (typeof type === 'function') {
    const prevKey = hookKey
    const prevCursor = hookCursor
    hookKey = path + '.' + (type.name || 'anon')
    hookCursor = 0
    let out
    try { out = type(props) } finally { hookKey = prevKey; hookCursor = prevCursor }
    render(out, path + '.' + (type.name || 'anon'))
    return
  }
  throw new Error(`未知元素类型 ${String(type)}`)
}

function textOf(node) { textSink.length = 0; render(node); return textSink.join(' ') }
function byClass(nodes, className) { return nodes.filter((el) => String(el.props?.className ?? '').includes(className)) }
const contentText = () => textSink.join(' | ')

/* ── 配置表单（含单价规则）────────────────────────────────────── */
function makeForm({ pricing = [], peakHours = '08:30-00:30', peakOnlyWorkdays = false, timezone = 'Asia/Shanghai' } = {}) {
  const VALUE = {
    bubbleMaxChars: 30, mergeMaxChars: 15, chunkSize: 1000, sendIntervalMs: 500,
    typingDelay: { enabled: true }, flypitDelayTiers: { short: 200, medium: 450, long: 800 },
    groupAtReply: true, groupAtPosition: 'last', trimEndPunctuation: { enabled: true, keep: ['？'] },
    personaText: '', personaPresetDefault: '', personaBotName: '', personaGroupName: '',
    personaParticipation: 'normal', personaExtraRules: '', personaSystemPrompt: '',
    personaPresets: [], personaPresetId: '',
    model: { provider: 'trae', model: 'deepseek-v4.1-flash', reasoningEffort: '' },
    modelFallbacks: [], usagePricing: pricing,
    peakHours, peakOnlyWorkdays, timezone,
    allow: { private: ['10001'], groups: [], allowAllWhenEmpty: false },
    onebot: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '' },
    napcat: { dir: 'D:\\NapCat', quickLoginQQ: '' },
    bridge: { dir: '', autoStart: false },
    skills: [], plugins: [],
    externalPlugins: { dirs: [], enabled: [] },
    rhythm: {
      activityLevel: 1, debounceWindowMs: 800, batchIntervalMs: 2500,
      rateLimit: { perMin: 12, burst: 3, silent: true },
      mute: { enabled: true, words: ['闭嘴'], seconds: 60 },
    },
    replyTimeoutMs: 20000, modelWatchdogMs: 8000, antiDebounceMs: 0,
  }
  const form = {
    getSnapshot: () => ({ status: 'ready', value: VALUE, writable: true, source: 'remote' }),
    subscribe: () => () => {},
    ops: [],
    mutate: async (list) => { form.ops.push(...list); return true },
  }
  return form
}

function makeCtx(form) {
  const registered = {}
  const ctx = {
    remote: { settings: { describe: async () => ({ ok: true, value: { namespaces: [] } }) } },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on: () => () => {},
    slots: {
      inject: (_name, fn) => fn(),
      register: (descriptor, component) => {
        registered[descriptor.name + ':' + (descriptor.key ?? descriptor.id ?? '')] = component
        return () => {}
      },
    },
    inject: (_deps, fn) => fn({ slots: ctx.slots, effect: ctx.effect, configForms: { get: () => form } }),
    configForms: { get: () => form },
  }
  return { ctx, registered }
}

/** 渲染指定 Tab；先跑一遍 effect 拉数据，等微任务后重渲染。 */
async function renderTab(form, tab) {
  const { ctx, registered } = makeCtx(form)
  mod.apply(ctx)
  const Comp = registered['main:qq-bridge']
  assert.ok(Comp, '主面板没注册')
  const root = `tab:${tab}`
  hookStore = new Map([[`${root}.BridgePanel.SettingsPanel#1`, tab]])
  effects = []
  textSink.length = 0
  elements.length = 0
  render(React.createElement(Comp, { remoteForm: form }), root)
  // 执行首轮 effect（useUsage 会发 fetch），等 fetch 的 Promise 落地。
  for (const fn of effects) { try { fn() } catch { /* 其它卡片的状态轮询不参与本用例 */ } }
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  // 用落下来的 state 重渲染。
  effects = []
  textSink.length = 0
  elements.length = 0
  render(React.createElement(Comp, { remoteForm: form }), root)
  return contentText()
}

const renderUsageTab = (form) => renderTab(form, 'usage')

/** 在保留 hookStore（即组件状态）的前提下重渲染一次，用来模拟 onChange 后的新闭包。 */
function rerenderTab(form, tab = 'usage') {
  const { ctx, registered } = makeCtx(form)
  mod.apply(ctx)
  const Comp = registered['main:qq-bridge']
  effects = []
  textSink.length = 0
  elements.length = 0
  render(React.createElement(Comp, { remoteForm: form }), `tab:${tab}`)
  return contentText()
}

let pass = 0
let fail = 0
async function check(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (error) { console.log(`  ✗ ${name}\n      ${error?.stack ?? error?.message ?? error}`); fail++ }
}

try {
  console.log('数据与用量 · 前端接线用例')

  await check('useUsage 打的是 /usage?days=7，且 5 秒轮询', async () => {
    const form = makeForm()
    payload = usagePayload({ configured: true })
    fetchCalls.length = 0
    timers.length = 0
    await renderUsageTab(form)
    assert.ok(fetchCalls.some((url) => url.includes('/dsh-qq-guard/usage?days=7')),
      `没有请求 usage 接口：${fetchCalls.join(', ')}`)
    assert.ok(timers.some((timer) => timer.ms === 5000), '没有 5 秒轮询定时器')
  })

  await check('今日概览（运行状态页）：真实调用数 / Token / 成本 / 成功率', async () => {
    const form = makeForm()
    payload = usagePayload({ configured: true })
    const text = await renderTab(form, 'status')
    assert.ok(text.includes('339,885'), `Token 不是接口值：${text.includes('Token 消耗') ? text.slice(0, 300) : '缺今日卡'}`)
    assert.ok(text.includes('¥3.21'), '成本没有按真实值显示')
    assert.ok(text.includes('92.3'), '成功率没显示')
    assert.ok(text.includes('较昨日 +180.0%'), '调用次数趋势没显示')
    // 旧 Mock 数字必须彻底消失
    for (const stale of ['386,420', '1,284', '4.82']) assert.ok(!text.includes(stale), `还在渲染 Mock 数字 ${stale}`)
  })

  await check('图表：7 天柱状图 + Token 面积图用真实按天数据', async () => {
    const form = makeForm()
    payload = usagePayload({ configured: true })
    const text = await renderUsageTab(form)
    for (const day of ['10-17', '10-20', '10-23']) assert.ok(text.includes(day), `图表缺少日期 ${day}`)
    // 表格里的真实输入/缓存数字（面积图本身只有日期标签）
    assert.ok(text.includes('57,971'), '按天表缺少今日输入 token')
    assert.ok(text.includes('281,216'), '按天表缺少今日缓存命中')
  })

  await check('三张表：按天 / 按模型 / 按会话（含真实私聊标签）', async () => {
    const form = makeForm()
    payload = usagePayload({ configured: true })
    const text = await renderUsageTab(form)
    assert.ok(text.includes('按天统计'))
    assert.ok(text.includes('按模型统计'))
    assert.ok(text.includes('按会话统计'))
    assert.ok(!text.includes('按插件统计'), '旧「按插件统计」还在')
    assert.ok(text.includes('私聊 10001'), '会话表没有渲染真实 QQ 号')
    assert.ok(text.includes('trae/deepseek-v4.1-flash'), '模型表没有渲染真实路由')
  })

  await check('峰谷时段卡：回填 peakHours、多段 Placeholder、展示 UTC+8，失焦写回', async () => {
    const form = makeForm({ peakHours: '08:30-00:30' })
    payload = usagePayload({ configured: true })
    const text = await renderUsageTab(form)
    assert.ok(text.includes('峰谷时段设置'), '缺少峰谷时段卡')
    assert.ok(text.includes('UTC+8'), '没有显示本地时区 UTC+8')
    const input = () => elements.find((el) => el.tag === 'input' && el.props?.['aria-label'] === '峰谷时段')
    assert.ok(input(), '找不到峰谷时段输入框')
    assert.equal(input().props.placeholder, '09:00-12:00, 14:00-18:00', 'Placeholder 不是多段示例')
    assert.equal(String(input().props.value), '08:30-00:30', '没有回填 peakHours')
    input().props.onChange({ target: { value: '09:00-12:00, 14:00-18:00' } })
    rerenderTab(form)
    input().props.onBlur()
    const op = form.ops[0]
    assert.ok(op, '失焦后没有写配置')
    assert.deepEqual([...op.path], ['peakHours'])
    assert.equal(op.value, '09:00-12:00, 14:00-18:00', '多段时段没有按原样写回')
  })

  await check('峰谷时段卡：「仅在工作日生效」开关写回 peakOnlyWorkdays', async () => {
    const form = makeForm({ peakHours: '09:00-12:00', peakOnlyWorkdays: false })
    payload = usagePayload({ configured: true })
    const text = await renderUsageTab(form)
    assert.ok(text.includes('仅在工作日生效'), '缺少「仅在工作日生效」开关')
    const toggle = () => elements.find((el) => el.tag === 'button' && el.props?.['aria-label'] === '仅在工作日生效')
    assert.ok(toggle(), '找不到工作日开关')
    assert.equal(toggle().props['aria-checked'], 'false', '初始应为关闭')
    toggle().props.onClick()
    const op = form.ops[0]
    assert.ok(op, '切换开关没有写配置')
    assert.deepEqual([...op.path], ['peakOnlyWorkdays'])
    assert.equal(op.value, true)
  })

  await check('峰谷时段卡：非法格式（含多段里有一段坏）不写配置', async () => {
    const form = makeForm({ peakHours: '08:30-00:30' })
    payload = usagePayload({ configured: true })
    await renderUsageTab(form)
    const input = () => elements.find((el) => el.tag === 'input' && el.props?.['aria-label'] === '峰谷时段')
    input().props.onChange({ target: { value: '09:00-12:00, bad' } })
    rerenderTab(form)
    input().props.onBlur()
    assert.equal(form.ops.length, 0, '多段里有一段非法也不应写配置')
    const errorText = rerenderTab(form)
    assert.ok(errorText.includes('格式应为'), '非法格式应显示错误提示')
  })

  await check('单价配置：忙时/闲时各 4 个输入框，按 usagePricing 回填', async () => {
    const form = makeForm({
      pricing: [{
        provider: 'trae',
        model: 'deepseek-v4.1-flash',
        peak: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0.2 },
        offPeak: { input: 1, output: 4, cacheRead: 0.25, cacheWrite: 0.1 },
      }],
    })
    payload = usagePayload({ configured: true })
    const text = await renderUsageTab(form)
    assert.ok(text.includes('单价配置'), '缺少单价配置卡')
    const inputs = elements.filter((el) => el.tag === 'input' && el.props?.type === 'number')
    const labels = inputs.map((el) => el.props?.['aria-label'])
    for (const label of ['忙时 Peak-输入', '忙时 Peak-输出', '忙时 Peak-缓存读', '忙时 Peak-缓存写',
      '闲时 Off-Peak-输入', '闲时 Off-Peak-输出', '闲时 Off-Peak-缓存读', '闲时 Off-Peak-缓存写']) {
      assert.ok(labels.includes(label), `缺少「${label}」单价输入框`)
    }
    assert.equal(inputs.length, 8, `应正好 8 个单价输入框，实际 ${inputs.length}`)
    assert.equal(String(inputs.find((el) => el.props?.['aria-label'] === '忙时 Peak-输入').props.value), '2')
    assert.equal(String(inputs.find((el) => el.props?.['aria-label'] === '闲时 Off-Peak-缓存写').props.value), '0.1')
    assert.ok(text.includes('已配置'))
  })

  await check('旧版扁平单价：两套都显示，首次编辑迁移成嵌套结构', async () => {
    const form = makeForm({
      pricing: [{
        provider: 'trae',
        model: 'deepseek-v4.1-flash',
        input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0,
        // 新 Schema 会把缺失的两套补成全 0 对象，旧版数值在顶层。
        peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        offPeak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    })
    payload = usagePayload({ configured: true })
    const text = await renderUsageTab(form)
    const inputs = () => elements.filter((el) => el.tag === 'input' && el.props?.type === 'number')
    for (const label of ['忙时 Peak-输入', '闲时 Off-Peak-输入', '忙时 Peak-输出', '闲时 Off-Peak-输出']) {
      assert.ok(inputs().some((el) => el.props?.['aria-label'] === label), `缺少「${label}」输入框`)
    }
    assert.equal(String(inputs().find((el) => el.props?.['aria-label'] === '闲时 Off-Peak-输入').props.value), '2',
      '旧版扁平 input 应同时显示在闲时')
    assert.ok(text.includes('已配置'), '旧版扁平配置应视为已配置')
    // 改闲时输出 → 写回时迁移成嵌套结构（扁平字段不再保留）
    inputs().find((el) => el.props?.['aria-label'] === '闲时 Off-Peak-输出').props.onChange({ target: { value: '9' } })
    rerenderTab(form)
    elements.find((el) => el.props?.['aria-label'] === '闲时 Off-Peak-输出').props.onBlur()
    const rules = form.ops[0]?.value
    assert.ok(Array.isArray(rules) && rules.length === 1)
    assert.equal(rules[0].offPeak.output, 9)
    assert.equal(rules[0].offPeak.input, 2, '其余字段要迁移过来')
    assert.equal(rules[0].peak.input, 2, '忙时那套也要迁移')
    assert.equal(rules[0].peak.output, 8)
  })

  await check('未配单价：成本显示 —，成本维度按钮被禁用', async () => {
    const form = makeForm({ pricing: [] })
    payload = usagePayload({ configured: false })
    const text = await renderUsageTab(form)
    assert.ok(text.includes('—'), '未配置单价时成本应显示 —')
    assert.ok(text.includes('未配置'))
    const costButton = elements.find((el) => el.tag === 'button' && String(el.props?.children ?? '').includes('成本'))
    assert.ok(costButton, '找不到成本维度按钮')
    assert.equal(costButton.props.disabled, true, '成本维度未配单价时应禁用')
  })

  await check('单价输入失焦后写回 usagePricing 的对应时段（真实配置写路径）', async () => {
    const form = makeForm({
      pricing: [{
        provider: 'trae',
        model: 'deepseek-v4.1-flash',
        peak: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0.2 },
        offPeak: { input: 1, output: 4, cacheRead: 0.25, cacheWrite: 0.1 },
      }],
    })
    payload = usagePayload({ configured: true })
    await renderUsageTab(form)
    const inputs = () => elements.filter((el) => el.tag === 'input' && el.props?.type === 'number')
    const target = inputs().find((el) => el.props?.['aria-label'] === '闲时 Off-Peak-输出')
    assert.ok(target, '找不到闲时输出输入框')
    target.props.onChange({ target: { value: '9' } })
    // onChange 更新 draft 后重渲染，拿到带新 draft 的 onBlur 闭包。
    rerenderTab(form)
    const next = () => elements.find((el) => el.tag === 'input' && el.props?.['aria-label'] === '闲时 Off-Peak-输出')
    next().props.onBlur()
    const op = form.ops[0]
    assert.ok(op, '失焦后没有写配置')
    assert.equal(op.op, 'set')
    assert.deepEqual([...op.path], ['usagePricing'])
    const rules = op.value
    assert.ok(Array.isArray(rules) && rules.length === 1, `写回值不是规则数组：${JSON.stringify(rules)}`)
    assert.equal(rules[0].provider, 'trae')
    assert.equal(rules[0].model, 'deepseek-v4.1-flash')
    assert.equal(rules[0].offPeak.output, 9, '闲时输出没有写回')
    assert.equal(rules[0].offPeak.input, 1, '同时段其它字段不能被覆盖丢')
    assert.equal(rules[0].peak.output, 8, '忙时那套不能被覆盖丢')
    assert.equal(rules[0].peak.cacheWrite, 0.2)
  })
} finally {
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}
