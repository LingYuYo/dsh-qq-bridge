/**
 * 沙箱子进程真跑测试（真起 node 子进程，离线）：
 *   · 自包含模块：import + setup(api) 成功
 *   · node:fs 被 registerHooks 拦下（E_BLOCKED_IMPORT）
 *   · ../../src/* 越界引用被拦下
 *   · setup 抛错 → E_SETUP；无有效导出 → E_BAD_EXPORTS
 *   · 死循环 → Host 超时杀进程（E_TIMEOUT），之后能重新拉起
 *   · console.log 不会污染协议（转成 log 帧）
 *   · process.getBuiltinModule 已被移除
 *
 * 用法：node test-sandbox-child.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { SandboxManager } from './sandbox/manager.mjs'
import { ERR } from './sandbox/protocol.mjs'

/* ── 真子进程适配器（形状与 dsh-subprocess 一致）────────────────── */
function makeRealSubprocess() {
  return {
    async resolveExecutable(name) {
      return name === 'node' ? process.execPath : null
    },
    spawn({ argv, cwd, graceMs, env }) {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: { ...process.env, ...(env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let exited = false
      let resolveDone
      const done = new Promise((resolve) => { resolveDone = resolve })
      child.on('exit', (code, signal) => { exited = true; resolveDone({ exitCode: code, signal }) })
      child.on('error', (error) => { exited = true; resolveDone({ exitCode: null, signal: null, error }) })
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        done,
        terminated: false,
        terminate() {
          if (this.terminated) return
          this.terminated = true
          try { child.kill('SIGTERM') } catch { /* 已退出 */ }
          const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, Math.max(200, graceMs ?? 1500))
          if (typeof timer.unref === 'function') timer.unref()
        },
        async waitForExit() {
          if (exited) return true
          return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), 3000)
            child.once('exit', () => { clearTimeout(timer); resolve(true) })
          })
        },
      }
    },
  }
}

/* ── 夹具 ───────────────────────────────────────────────────── */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qqg-sandbox-child-'))

function writeModule(name, source, extraFiles = {}) {
  const dir = path.join(ROOT, 'modules', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.js'), source)
  for (const [rel, text] of Object.entries(extraFiles)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, text)
  }
  return { id: name, dir, entryPath: path.join(dir, 'index.js'), format: 'plugin.json' }
}

// 应用根要有 "type":"module"，否则 .js 会按 CJS 解析（和 QQ Agent 的真实布局一致）。
fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({ name: 'sandbox-fixture', type: 'module' }, null, 2))
fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'src', 'x.js'), 'export const x = 1\n')

const MOD_OK = writeModule('ok', `
export function setup(api) {
  api.log('hello-from-ok')
  api.storage.set('k', 1)
}
export const hooks = { onMessage() {} }
`)

const MOD_LOG = writeModule('log', `
console.log('noise-from-console')
export function setup(api) { api.warn('warn-from-plugin') }
`)

const MOD_FS = writeModule('fs-mod', `
import { readFileSync } from 'node:fs'
export function setup() { return readFileSync(import.meta.url) }
`)

const MOD_ESCAPE = writeModule('escape-mod', `
import { x } from '../../src/x.js'
export function setup() { return x }
`)

// 用绝对 file: URL 绕过相对路径检查的尝试也要被拦。
const MOD_FILE_URL = (() => {
  const url = new URL('file:///' + path.join(ROOT, 'src', 'x.js').replace(/\\/g, '/')).href
  return writeModule('file-url-mod', `
export async function setup() { await import(${JSON.stringify(url)}) }
`)
})()

const MOD_THROW = writeModule('throw-mod', `
export function setup() { throw new Error('setup-boom') }
`)

const MOD_BAD_EXPORTS = writeModule('bad-exports', `
export const nothing = 1
`)

const MOD_BUILTIN = writeModule('builtin-mod', `
export function setup() {
  if (typeof process.getBuiltinModule === 'function') throw new Error('getBuiltinModule 仍然可用')
}
`)

const MOD_LOOP = writeModule('loop-mod', `
export function setup() { while (true) { /* 故意卡死，考验 Host 超时熔断 */ } }
`)

/* ── 跑 ─────────────────────────────────────────────────────── */
const manager = new SandboxManager({
  subprocess: makeRealSubprocess(),
  logger: { info() {}, warn() {}, error() {} },
  getRoots: () => [ROOT],
  nodePath: process.execPath,
  requestTimeoutMs: 800,
  readyTimeoutMs: 5000,
  maxFailures: 5,
  breakerCooldownMs: 60_000,
})

let pass = 0
const fail = []
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail.push(name); console.log(`  ✗ ${name}\n    ${e.message}`) }
}

console.log('沙箱子进程（真 node）：')

await check('自包含模块：import + setup(api) 成功，exports/hooks 正确', async () => {
  const outcome = await manager.testLoad(MOD_OK)
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error))
  assert.equal(outcome.result.moduleId, 'ok')
  assert.equal(outcome.result.exports.setup, true)
  assert.deepEqual(outcome.result.exports.hooks, ['onMessage'])
  assert.ok(outcome.result.apiCalls.includes('log'), JSON.stringify(outcome.result.apiCalls))
  assert.ok(outcome.result.sandbox.pid > 0, '没有回传沙箱 pid')
  const logs = manager.snapshot().logTail.join('\n')
  assert.ok(logs.includes('hello-from-ok'), `日志没有回传：${logs}`)
})

await check('console.log 不污染协议：转成 log 帧，加载仍成功', async () => {
  const outcome = await manager.testLoad(MOD_LOG)
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error))
  const logs = manager.snapshot().logTail.join('\n')
  assert.ok(logs.includes('noise-from-console'), `console.log 没被转成 log 帧：${logs}`)
  assert.ok(logs.includes('warn-from-plugin'), 'api.warn 没进日志')
})

await check('node:fs 被 registerHooks 拦截 → E_BLOCKED_IMPORT', async () => {
  const outcome = await manager.testLoad(MOD_FS)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, ERR.BLOCKED_IMPORT, JSON.stringify(outcome.error))
  assert.ok(/node:fs/.test(outcome.error.message), outcome.error.message)
})

await check('../../src/* 越界引用被拦截 → E_BLOCKED_IMPORT', async () => {
  const outcome = await manager.testLoad(MOD_ESCAPE)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, ERR.BLOCKED_IMPORT, JSON.stringify(outcome.error))
  assert.ok(/越出(允许目录|模块目录)/.test(outcome.error.message), outcome.error.message)
})

await check('绝对 file: URL 绕路也被拦截 → E_BLOCKED_IMPORT', async () => {
  const outcome = await manager.testLoad(MOD_FILE_URL)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, ERR.BLOCKED_IMPORT, JSON.stringify(outcome.error))
  assert.ok(/越出模块目录/.test(outcome.error.message), outcome.error.message)
})

await check('setup 抛错 → E_SETUP（错误信息带 setup-boom）', async () => {
  const outcome = await manager.testLoad(MOD_THROW)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, ERR.SETUP_FAILED, JSON.stringify(outcome.error))
  assert.ok(outcome.error.message.includes('setup-boom'), outcome.error.message)
})

await check('入口没有有效导出 → E_BAD_EXPORTS', async () => {
  const outcome = await manager.testLoad(MOD_BAD_EXPORTS)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, ERR.BAD_EXPORTS, JSON.stringify(outcome.error))
})

await check('process.getBuiltinModule 已被移除', async () => {
  const outcome = await manager.testLoad(MOD_BUILTIN)
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error))
})

await check('死循环：Host 超时杀进程 → E_TIMEOUT', async () => {
  const outcome = await manager.testLoad(MOD_LOOP)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, ERR.TIMEOUT, JSON.stringify(outcome.error))
})

await check('超时杀进程后能重新拉起并加载成功', async () => {
  const outcome = await manager.testLoad(MOD_OK)
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error))
})

await manager.dispose()

console.log(`\n结果：${pass} 通过 / ${fail.length} 失败`)
process.exit(fail.length ? 1 : 0)
