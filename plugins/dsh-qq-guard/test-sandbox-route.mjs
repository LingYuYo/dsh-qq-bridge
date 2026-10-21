/**
 * Host 沙箱路由测试（离线）：
 *   POST /dsh-qq-guard/external-plugins/test
 *
 *   · 只接受同源 POST
 *   · 重新扫描配置的根目录定位模块，不信任客户端路径（dir 注入 → 404）
 *   · 只允许 self-contained + 有入口的模块
 *   · 成功时把沙箱结果原样回传；没有 subprocess 服务时 501
 *
 * 用法：node test-sandbox-route.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
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
const patched = SRC.replace(
  /^import Schema from '@deepseek-ai\/schemastery'$/m,
  `import Schema from ${JSON.stringify('file:///' + resolveSchemastery().replace(/\\/g, '/'))}`,
)
const tmpFile = path.join(HERE, '.tmp-index-sandbox-route.mjs')
fs.writeFileSync(tmpFile, patched)
let mod
try {
  mod = await import('file:///' + tmpFile.replace(/\\/g, '/'))
} finally {
  fs.unlinkSync(tmpFile)
}

/* ── 夹具：一个 QQ Agent 形态的外部根 ─────────────────────── */
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqg-sandbox-route-'))
  const write = (rel, content) => {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  write('package.json', JSON.stringify({ name: 'fixture', type: 'module' }))
  // 自包含、可加载
  write('plugins/ok/plugin.json', JSON.stringify({
    id: 'ok', name: '可加载插件', version: '1.0.0', category: 'utility', entry: 'index.js',
  }))
  write('plugins/ok/index.js', `
    export function setup(api) { api.log('route-ok') }
    export const hooks = { onMessage() {} }
  `)
  // 依赖 node:fs → 受控，路由应拒绝
  write('plugins/fs/plugin.json', JSON.stringify({
    id: 'fs-mod', name: '文件插件', version: '1.0.0', category: 'utility', entry: 'index.js',
  }))
  write('plugins/fs/index.js', "import fs from 'node:fs'\nexport function setup() { void fs }\n")
  // 清单有入口字段但文件不存在
  write('plugins/noentry/plugin.json', JSON.stringify({
    id: 'noentry', name: '缺入口', version: '1.0.0', entry: 'missing.js',
  }))
  return root
}

/* ── 假 subprocess：ready + 成功的 load 响应 ───────────────── */
function frame(body) { return JSON.stringify({ v: 1, ...body }) + '\n' }

function makeFakeSubprocess({ reply = true } = {}) {
  const spawned = []
  return {
    spawned,
    async resolveExecutable() { return process.execPath },
    spawn(spec) {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let settle
      const done = new Promise((resolve) => { settle = resolve })
      const handle = {
        spec, stdin, stdout, stderr, done,
        terminate() { settle({ exitCode: null, signal: 'SIGTERM' }) },
        async waitForExit() { return true },
      }
      spawned.push(handle)
      setTimeout(() => stdout.write(frame({ type: 'ready', payload: { pid: 9001, node: 'fake' } })), 5)
      let buffer = ''
      stdin.on('data', (chunk) => {
        buffer += String(chunk)
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (!line.trim()) continue
          const parsed = JSON.parse(line)
          if (parsed.type !== 'load') continue
          if (!reply) continue
          setTimeout(() => stdout.write(frame({
            type: 'result', id: parsed.id, ok: true,
            payload: {
              moduleId: parsed.payload.moduleId,
              exports: { setup: true, hooks: ['onMessage'] },
              apiCalls: ['log'],
              durationMs: 4,
            },
          })), 5)
        }
      })
      return handle
    },
  }
}

/* ── 假 ctx ─────────────────────────────────────────────────── */
function makeHarness({ config, subprocess, noSubprocess = false } = {}) {
  const routes = new Map()
  const ctx = {
    webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => {} } },
    subprocess: noSubprocess ? undefined : (subprocess ?? makeFakeSubprocess()),
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { return fn() ?? (() => {}) },
    on() { return () => {} },
    inject(_deps, fn) { try { fn(ctx) } catch { /* 设置页服务缺席 */ } },
    get() { return undefined },
  }
  mod.apply(ctx, mod.Config({ role: 'settings', ...(config ?? {}) }))
  return { routes }
}

/** 调用路由；body 直接作为 JSON 发送。 */
function call(handler, { method = 'POST', body, fetchSite = 'same-origin' } = {}) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = method
    req.url = '/'
    req.headers = fetchSite === undefined ? {} : { 'sec-fetch-site': fetchSite }
    req.destroy = () => {}
    const res = {
      status: 0,
      writeHead(status) { this.status = status },
      end(text) { resolve({ status: this.status, body: JSON.parse(String(text)) }) },
    }
    Promise.resolve(handler(req, res)).catch((error) => {
      resolve({ status: 500, body: { ok: false, error: { message: String(error?.message ?? error) } } })
    })
    if (body !== undefined) {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      req.emit('end')
    }
  })
}

let pass = 0, fail = 0
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`) }
}

console.log('沙箱测试路由：')

const ROOT = makeRoot()
const { routes } = makeHarness({ config: { externalPlugins: { dirs: [ROOT] } } })
const route = routes.get('/dsh-qq-guard/external-plugins/test')

await check('自包含模块 → 200，返回沙箱加载结果', async () => {
  const r = await call(route, { body: { id: 'ok', dir: path.join(ROOT, 'plugins/ok') } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true)
  assert.equal(r.body.result.moduleId, 'ok')
  assert.equal(r.body.result.exports.setup, true)
  assert.equal(r.body.result.sandbox.pid, 9001)
})

await check('只传 id 也能定位（不要求前端给 dir）', async () => {
  const r = await call(route, { body: { id: 'ok' } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true)
})

await check('受控模块（node:fs）→ 400 E_NOT_SELF_CONTAINED，且不 spawn', async () => {
  const before = 0
  const { routes: r2 } = makeHarness({ config: { externalPlugins: { dirs: [ROOT] } } })
  const r = await call(r2.get('/dsh-qq-guard/external-plugins/test'), { body: { id: 'fs-mod' } })
  assert.equal(r.status, 400, JSON.stringify(r.body))
  assert.equal(r.body.error.code, 'E_NOT_SELF_CONTAINED')
  assert.equal(before, 0)
})

await check('缺入口文件 → 400 E_ENTRY_MISSING', async () => {
  const r = await call(route, { body: { id: 'noentry' } })
  assert.equal(r.status, 400, JSON.stringify(r.body))
  assert.equal(r.body.error.code, 'E_ENTRY_MISSING')
})

await check('未知模块 → 404', async () => {
  const r = await call(route, { body: { id: 'not-exist' } })
  assert.equal(r.status, 404, JSON.stringify(r.body))
  assert.equal(r.body.error.code, 'E_NOT_FOUND')
})

await check('dir 注入（不在扫描结果里的目录）→ 404，不按路径加载', async () => {
  const r = await call(route, { body: { id: 'ok', dir: path.join(os.tmpdir(), 'qqg-not-scanned') } })
  assert.equal(r.status, 404, JSON.stringify(r.body))
  assert.equal(r.body.error.code, 'E_NOT_FOUND')
})

await check('缺 id/dir → 400；坏 JSON → 400 E_BODY', async () => {
  const missing = await call(route, { body: {} })
  assert.equal(missing.status, 400)
  const bad = await call(route, { body: '{not json' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'E_BODY')
})

await check('GET → 405；跨站 POST → 403', async () => {
  const get = await call(route, { method: 'GET' })
  assert.equal(get.status, 405)
  const cross = await call(route, { body: { id: 'ok' }, fetchSite: 'cross-site' })
  assert.equal(cross.status, 403)
})

await check('没有 subprocess 服务 → 501', async () => {
  const { routes: r3 } = makeHarness({
    config: { externalPlugins: { dirs: [ROOT] } },
    noSubprocess: true,
  })
  const handler = r3.get('/dsh-qq-guard/external-plugins/test')
  const r = await call(handler, { body: { id: 'ok' } })
  assert.equal(r.status, 501, JSON.stringify(r.body))
  assert.equal(r.body.error.code, 'E_NO_SUBPROCESS')
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
