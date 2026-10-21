/**
 * Host 侧 `/dsh-qq-guard/pick-dir` 路由回归（离线，不弹真窗口）。
 *
 * 用假的 directoryPicker 服务走完所有分支：
 *   ① native 后端 + pick 返回路径 → 200 { path }
 *   ② pick 返回 null（用户点取消）→ 200 { cancelled: true }
 *   ③ 没挂 directoryPicker → 501 picker-not-mounted
 *   ④ 挂的是 browse 后端 → 501 picker-not-native（前端据此降级手输）
 *   ⑤ 并发点击 → 第二次 409 busy（原生对话框是模态的，不能叠）
 *   ⑥ 跨站请求 → 403
 *   ⑦ 非 POST → 405
 *   ⑧ pick 抛错 → 500 pick-failed
 *
 * 运行：node test-pickdir.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function resolveSchemastery() {
  if (process.env.QQG_SCHEMASTERY) return process.env.QQG_SCHEMASTERY
  const candidates = [
    path.join(HERE, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
    path.resolve(HERE, '../../node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  console.error('找不到 @deepseek-ai/schemastery；请设 QQG_SCHEMASTERY 指向它的 lib/index.mjs')
  process.exit(2)
}

const SRC = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')
const SM_PATH = resolveSchemastery()
const patched = SRC.replace(
  /^import Schema from '@deepseek-ai\/schemastery'$/m,
  `import Schema from ${JSON.stringify('file:///' + SM_PATH.replace(/\\/g, '/'))}`,
)
const tmpFile = path.join(HERE, '.tmp-index-pickdir.mjs')
fs.writeFileSync(tmpFile, patched)
let mod
try {
  mod = await import('file:///' + tmpFile.replace(/\\/g, '/'))
} finally {
  fs.unlinkSync(tmpFile)
}

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

/** 假 webServer：记录注册的路由，之后可按 path 取出来直接调用。 */
function makeHarness({ picker, config } = {}) {
  const routes = new Map()
  const effects = []
  const ctx = {
    webServer: {
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => { routes.delete(spec.path) }
      },
    },
    subprocess: undefined,
    logger: { info() {}, warn() {}, error() {} },
    effect(fn, label) { effects.push(label); return fn() ?? (() => {}) },
    on() { return () => {} },
    // applySettings 末尾会用 ctx.inject(['settings'], cb) 挂设置页，这里给个直通实现。
    inject(_deps, fn) { try { fn(ctx) } catch { /* 设置页服务缺失不影响路由注册 */ } },
    get(name) { return name === 'directoryPicker' ? picker : undefined },
  }
  if (picker !== undefined) ctx.directoryPicker = picker
  // 必须显式带 role: 'settings'——本插件 role 未声明时会直接跳过全部注册（见 index.js 铁律）。
  mod.apply(ctx, mod.Config({ role: 'settings', ...(config ?? {}) }))
  return { ctx, routes, effects }
}

/** 假 req/res，返回 { status, body }。 */
function call(handler, { method = 'POST', fetchSite = 'same-origin' } = {}) {
  return new Promise((resolve) => {
    const res = {
      status: 0, headers: null, chunks: [],
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(body) { this.chunks.push(body); resolve({ status: this.status, body: JSON.parse(String(body)) }) },
    }
    const req = {
      method,
      url: '/dsh-qq-guard/pick-dir',
      headers: fetchSite === undefined ? {} : { 'sec-fetch-site': fetchSite },
    }
    Promise.resolve(handler(req, res)).catch((error) => {
      resolve({ status: 500, body: { ok: false, reason: 'harness-threw', detail: String(error) } })
    })
  })
}

const PICK_PATH = '/dsh-qq-guard/pick-dir'
const nativePicker = (pick) => ({
  capability: () => ({ kind: 'native', pick }),
})

console.log('Host 路由 /dsh-qq-guard/pick-dir：')

await check('native 后端选中路径 → 200 + 绝对路径', async () => {
  const h = makeHarness({ picker: nativePicker(async () => 'D:\\NapCat.52230.Shell') })
  const r = await call(h.routes.get(PICK_PATH))
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.path, 'D:\\NapCat.52230.Shell')
})

await check('用户取消（pick 返回 null）→ 200 + cancelled', async () => {
  const h = makeHarness({ picker: nativePicker(async () => null) })
  const r = await call(h.routes.get(PICK_PATH))
  assert.equal(r.status, 200)
  assert.equal(r.body.cancelled, true)
  assert.equal(r.body.path, null)
})

await check('没有 directoryPicker 服务 → 501 picker-not-mounted', async () => {
  const h = makeHarness({ picker: undefined })
  const r = await call(h.routes.get(PICK_PATH))
  assert.equal(r.status, 501)
  assert.equal(r.body.reason, 'picker-not-mounted')
})

await check('browse 后端 → 501 picker-not-native', async () => {
  const h = makeHarness({ picker: { capability: () => ({ kind: 'browse', list() {}, createDirectory() {} }) } })
  const r = await call(h.routes.get(PICK_PATH))
  assert.equal(r.status, 501)
  assert.equal(r.body.reason, 'picker-not-native')
  assert.match(r.body.detail, /browse/)
})

await check('并发点击 → 第二次 409 busy', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const h = makeHarness({ picker: nativePicker(() => gate.then(() => 'C:\\picked')) })
  const first = call(h.routes.get(PICK_PATH))
  // 等第一个请求真的进到 pick()（picking=true）里
  await new Promise((r) => setTimeout(r, 10))
  const second = await call(h.routes.get(PICK_PATH))
  assert.equal(second.status, 409)
  assert.equal(second.body.reason, 'busy')
  release()
  const firstResult = await first
  assert.equal(firstResult.status, 200)
  assert.equal(firstResult.body.path, 'C:\\picked')
})

await check('并发结束后可以再次正常选择（picking 已复位）', async () => {
  const h = makeHarness({ picker: nativePicker(async () => 'E:\\again') })
  await call(h.routes.get(PICK_PATH))
  const r = await call(h.routes.get(PICK_PATH))
  assert.equal(r.status, 200)
  assert.equal(r.body.path, 'E:\\again')
})

await check('pick 抛错 → 500 pick-failed', async () => {
  const h = makeHarness({ picker: nativePicker(async () => { throw new Error('dialog crashed') }) })
  const r = await call(h.routes.get(PICK_PATH))
  assert.equal(r.status, 500)
  assert.equal(r.body.reason, 'pick-failed')
  assert.match(r.body.detail, /dialog crashed/)
})

await check('跨站请求 → 403', async () => {
  const h = makeHarness({ picker: nativePicker(async () => 'x') })
  const r = await call(h.routes.get(PICK_PATH), { fetchSite: 'cross-site' })
  assert.equal(r.status, 403)
})

await check('非 POST → 405', async () => {
  const h = makeHarness({ picker: nativePicker(async () => 'x') })
  const r = await call(h.routes.get(PICK_PATH), { method: 'GET' })
  assert.equal(r.status, 405)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
