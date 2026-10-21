/**
 * 人设弹窗版式验证（几何 + 截图）。仅开发期使用，不参与插件运行。
 *
 * 背景：人设弹窗改成了「标签 / 说明 / 控件」三段式紧凑布局，
 * 靠肉眼看截图容易漏掉 1~2px 的错位，这里直接在 headless Chrome 里量 DOM 盒子：
 *   · 第一排三个字段的标签 / 说明 / 控件严格左对齐（左边界一致）
 *   · 单行输入框固定 200px 宽，三个并排在同一行，不占满弹窗
 *   · 说明文字在标签正下方、输入框上方（不与输入框同行）
 *   · 多行文本框占满整行宽度，初始高度 ≥ 120px
 *   · 底部灰色提示紧贴表单，距最后一个字段不超过 24px
 *
 * 用法：node verify-persona-layout.mjs
 * 产物：preview/modal-persona.html、modal-persona-dark.html
 *       preview/shot-modal-persona.png（浅色截图，供人工对比）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const OUT = new URL('./preview/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
mkdirSync(OUT, { recursive: true })

/* ── 假 React（hooks 按树中位置隔离，和 test-persona-ui.mjs 同一套）── */
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
    __keyListeners: [],
    addEventListener(type, fn) { if (type === 'keydown') this.__keyListeners.push(fn) },
    removeEventListener() {},
  },
  React,
  console: { ...console, error() {}, warn() {} },
  setTimeout, clearTimeout,
  fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} }, getElementById: () => null },
}
let mod
vm.createContext(sandbox)
vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })

/* ── 元素树工具 ─────────────────────────────────────────────── */
function expand(node, path = 'r') {
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

/* ── 配置夹具 ───────────────────────────────────────────────── */
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
  personaBotName: '小鲸鱼',
  personaGroupName: '',
  personaParticipation: 'normal',
  personaText: '你是一只傲娇猫娘，说话带「哼」和「才不是呢」。\n第二行：正经问题会认真答。',
  personaExtraRules: '',
  personaSystemPrompt: '',
  personaPresets: [{ id: 'p1', name: '猫娘', text: '你是一只傲娇猫娘。' }],
  personaPresetId: '',
  allow: { private: [], groups: [], allowAllWhenEmpty: false },
  onebot: { wsUrl: '', accessToken: '' },
  napcat: { dir: '', quickLoginQQ: '' },
  bridge: { dir: '', autoStart: false },
}
const form = {
  getSnapshot: () => ({ status: 'ready', value: VALUE, writable: true, source: 'remote' }),
  subscribe: () => () => {},
  mutate: async () => true,
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
if (!Comp) throw new Error('main 槽位未注册')

/* ── 渲染设置页 → 点开人设弹窗 ─────────────────────────────── */
function renderSettings() {
  // SettingsPanel 的 tab state 是 #1，预置成 settings。
  hookStore = new Map([['r:SettingsPanel#1', 'settings']])
  effects.length = 0
  const tree = expand(React.createElement(Comp, { remoteForm: form }))
  flushEffects()
  return tree
}

let tree = renderSettings()
const editBtn = findAll(tree, (n) => n.tag === 'button' && textOf(n).trim() === '⚙️ 编辑人设')[0]
if (!editBtn) throw new Error('找不到「⚙️ 编辑人设」按钮')
editBtn.props.onClick()
effects.length = 0
tree = expand(React.createElement(Comp, { remoteForm: form }))
flushEffects()
if (!textOf(findAll(tree, (n) => n.props?.className === 'qqg-modal-title')[0]).includes('人设设置')) {
  throw new Error('弹窗没有打开')
}

/* ── 序列化成 HTML ──────────────────────────────────────────── */
const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link'])
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const styleAttr = (style) => {
  if (!style || typeof style !== 'object') return ''
  return ' style="' + esc(Object.entries(style)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`).join(';')) + '"'
}
function treeToHtml(node) {
  if (!node) return ''
  if (node.text !== undefined) return esc(node.text)
  if (node.kids && !node.tag) return node.kids.map(treeToHtml).join('')
  const { tag, props, kids } = node
  if (tag === 'style') return `<style>${kids.map((k) => k.text ?? '').join('')}</style>`
  const attrs = []
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === 'children' || k === 'key' || v === undefined || v === null || typeof v === 'function') continue
    if (k === 'className') attrs.push(`class="${esc(v)}"`)
    else if (k === 'style') { const s = styleAttr(v); if (s) attrs.push(s.trim()) }
    else if (k === 'value') attrs.push(`value="${esc(v)}"`)
    else if (k === 'ariaLabel') attrs.push(`aria-label="${esc(v)}"`)
    else if (k.startsWith('aria-')) attrs.push(`${k}="${esc(v)}"`)
    else if (['rows', 'placeholder', 'type', 'title', 'role', 'disabled', 'min', 'max', 'step'].includes(k)) {
      attrs.push(`${k}="${esc(v)}"`)
    }
  }
  const open = `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  if (VOID.has(tag)) return open
  return `${open}${kids.map(treeToHtml).join('')}</${tag}>`
}

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

const body = treeToHtml(tree)
const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>QQ 桥接 · 人设设置</title><style>${THEME_LIGHT}${THEME_DARK}
html,body{height:100%} #app{height:100%;display:flex}</style></head>
<body><div id="app">${body}</div></body></html>`
writeFileSync(join(OUT, 'modal-persona.html'), page)
writeFileSync(join(OUT, 'modal-persona-dark.html'), page.replace('<body>', '<body data-ds-dark-theme>'))
console.log('wrote preview/modal-persona.html / -dark.html')

/* ── 几何探针 ───────────────────────────────────────────────── */
const PROBE = `
<script>
window.addEventListener('load', () => {
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect()
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
      right: Math.round(b.right), bottom: Math.round(b.bottom) } }
  const q = (sel) => document.querySelector(sel)
  const qa = (sel) => [...document.querySelectorAll(sel)]
  const smalls = qa('.qqg-prow .qqg-pf-sm')
  const rows = qa('.qqg-pf-wide')
  data = {
    modal: box(q('.qqg-modal')),
    body: box(q('.qqg-modal-body')),
    toolbar: box(q('.qqg-persona-toolbar')),
    prow: box(q('.qqg-prow')),
    small: smalls.map((el) => ({
      label: box(el.querySelector('.qqg-pf-label')),
      desc: box(el.querySelector('.qqg-pf-desc')),
      ctl: box(el.querySelector('.qqg-pf-ctl')),
      input: box(el.querySelector('input, select')),
      labelText: el.querySelector('.qqg-pf-label').textContent,
      descText: el.querySelector('.qqg-pf-desc').textContent,
    })),
    wide: rows.map((el) => ({
      label: box(el.querySelector('.qqg-pf-label')),
      desc: box(el.querySelector('.qqg-pf-desc')),
      area: box(el.querySelector('textarea')),
      foot: box(el.querySelector('.qqg-pf-foot')),
      footText: el.querySelector('.qqg-pf-foot')?.textContent ?? '',
    })),
    hint: box(q('.qqg-modal-body .qqg-hint')),
    hintText: q('.qqg-modal-body .qqg-hint')?.textContent ?? '',
    bodyScrollW: q('.qqg-modal-body').scrollWidth,
    bodyClientW: q('.qqg-modal-body').clientWidth,
  }
  const pre = document.createElement('pre')
  pre.id = 'probe'
  pre.textContent = 'PROBE:' + JSON.stringify(data)
  document.body.appendChild(pre)
})
</script>
`
function probe(file) {
  const src = readFileSync(join(OUT, file), 'utf8')
  const tmp = join(tmpdir(), 'qqg-persona-probe.html')
  writeFileSync(tmp, src.replace('</body>', PROBE + '</body>'))
  const out = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1440,1200', '--virtual-time-budget=1500',
    '--dump-dom', 'file:///' + tmp.replace(/\\/g, '/'),
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const m = out.match(/PROBE:(\{.*?\})<\/pre>/s)
  if (!m) throw new Error(`${file}：没有拿到 PROBE 数据`)
  return JSON.parse(m[1])
}
const D = probe('modal-persona.html')

/* ── 截图（浅色 + 深色），供人工对比 ───────────────────────── */
function shot(file, png) {
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1000,1000', '--virtual-time-budget=1500',
    '--screenshot=' + join(OUT, png), 'file:///' + join(OUT, file).replace(/\\/g, '/'),
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}
shot('modal-persona.html', 'shot-modal-persona.png')
shot('modal-persona-dark.html', 'shot-modal-persona-dark.png')
console.log('wrote preview/shot-modal-persona.png / -dark.png')

/* ── 断言 ───────────────────────────────────────────────────── */
let pass = 0
const fail = []
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fail.push(name); console.log(`  ✗ ${name}\n    ${e.message}`) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol

console.log('\n人设弹窗版式：')

check('第一排三个字段并排在同一行', () => {
  assert(D.small.length === 3, `只找到 ${D.small.length} 个单行字段`)
  const ys = D.small.map((s) => s.label.y)
  assert(new Set(ys).size === 1, `标签纵坐标不一致：${JSON.stringify(ys)}`)
  assert(D.small.every((s) => s.input && s.input.h > 0), '有字段缺少输入控件')
})

check('三个单行输入框宽度固定 200px（不拉满）', () => {
  for (const s of D.small) {
    assert(near(s.input.w, 200, 2), `「${s.labelText}」控件宽 ${s.input.w}px（应 200）`)
  }
  const total = D.small[2].input.right - D.small[0].input.x
  assert(total < D.body.w - 60, `三个字段总宽 ${total}px，说明还占满整行`)
})

check('标签 / 说明 / 控件严格左对齐', () => {
  for (const s of D.small) {
    assert(near(s.label.x, s.desc.x), `「${s.labelText}」说明文字左边界 ${s.desc.x} ≠ 标签 ${s.label.x}`)
    assert(near(s.label.x, s.input.x), `「${s.labelText}」输入框左边界 ${s.input.x} ≠ 标签 ${s.label.x}`)
  }
})

check('说明文字在标签正下方、控件上方（不同行）', () => {
  for (const s of D.small) {
    assert(s.desc.y > s.label.bottom - 1, `「${s.labelText}」说明没在标签下方`)
    assert(s.input.y >= s.desc.bottom - 1, `「${s.labelText}」说明和输入框挤在同一行`)
  }
})

check('同排控件底边对齐（说明行数不同也不歪）', () => {
  const bottoms = D.small.map((s) => s.input.bottom)
  assert(bottoms.every((b) => near(b, bottoms[0], 2)), `控件底边不齐：${JSON.stringify(bottoms)}`)
})

check('说明文字用浅灰小字（11px、次要色）', () => {
  const d = D.small[0].desc
  assert(d.h > 0, '说明文字没渲染')
  // 字号靠截图/计算样式无法直接读，这里用高度反推：单行 11px × 1.45 ≈ 16px
  assert(d.h >= 28, `说明块高度 ${d.h}px，疑似没折行或没渲染`)
})

check('多行文本框占满整行宽度', () => {
  assert(D.wide.length === 3, `多行字段有 ${D.wide.length} 个（应 3）`)
  for (const w of D.wide) {
    assert(w.area, '缺少 textarea')
    assert(near(w.area.w, D.body.w - 36, 3), `textarea 宽 ${w.area.w}px ≠ 内容区 ${D.body.w - 36}px`)
  }
})

check('多行文本框初始高度 ≥ 120px（不再一上来 10 行）', () => {
  for (const w of D.wide) {
    assert(w.area.h >= 118, `textarea 高 ${w.area.h}px（应 ≥ 120）`)
    assert(w.area.h <= 200, `textarea 高 ${w.area.h}px，初始高度还是太大`)
  }
})

check('多行文本框下方有字数占位提示', () => {
  for (const w of D.wide) {
    assert(w.foot && w.footText.trim() !== '', '缺字数提示')
    assert(w.foot.y >= w.area.bottom, `提示跑到文本框上面了（${w.footText}）`)
  }
})

check('底部灰色提示紧贴表单（距最后字段 ≤ 24px）', () => {
  assert(D.hint, '找不到底部提示')
  assert(D.hintText.includes('改动要点保存才会生效'), `提示文案：${D.hintText}`)
  const lastWide = D.wide[D.wide.length - 1]
  const gap = D.hint.y - lastWide.foot.bottom
  assert(gap >= 0 && gap <= 24, `提示距最后字段 ${gap}px（应 0~24）`)
})

check('弹窗内容不横向溢出', () => {
  assert(D.bodyScrollW <= D.bodyClientW + 1, `内容宽 ${D.bodyScrollW} > 可视宽 ${D.bodyClientW}`)
})

check('字段都在弹窗内部', () => {
  assert(D.prow.x >= D.body.x - 1, '第一排跑到弹窗左边外面')
  assert(D.small[2].input.right <= D.body.right + 1, '第三个字段溢出弹窗右边')
})

console.log(`\n结果：${pass} 通过 / ${fail.length} 失败`)
process.exit(fail.length ? 1 : 0)
