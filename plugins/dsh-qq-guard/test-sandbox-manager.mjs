/**
 * Host 侧沙箱管理器离线测试（假 subprocess，不真起进程）：
 *   · ready 握手 / 请求 id 关联 / argv 里的 --permission 白名单
 *   · 5s 超时（测试里调小）→ 杀进程 + E_TIMEOUT
 *   · 连续失败熔断 → E_CIRCUIT_OPEN，不再 spawn
 *   · 进程退出 → 在途请求 E_SANDBOX_EXIT
 *   · 单飞：第二个请求 E_BUSY
 *
 * 用法：node test-sandbox-manager.mjs
 */
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { SandboxManager } from './sandbox/manager.mjs'
import { PROTOCOL_VERSION, FRAME, ERR } from './sandbox/protocol.mjs'

const frame = (body) => JSON.stringify({ v: PROTOCOL_VERSION, ...body }) + '\n'

/**
 * 假 subprocess：handle 形状与 dsh-subprocess 一致（stdin/stdout/stderr/done/terminate/waitForExit）。
 *
 * @param {'reply'|'timeout'|'exit'|'reply-slow'} behavior
 */
function makeFakeSubprocess(behavior = 'reply') {
  const spawned = []
  const initFrames = []
  const subprocess = {
    spawned,
    initFrames,
    resolveExecutable: async () => process.execPath,
    spawn(spec) {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let settle
      const done = new Promise((resolve) => { settle = resolve })
      const handle = {
        spec,
        stdin,
        stdout,
        stderr,
        done,
        terminated: false,
        terminate() {
          if (this.terminated) return
          this.terminated = true
          settle({ exitCode: null, signal: 'SIGTERM' })
        },
        async waitForExit() { return true },
        settleWith(outcome) { settle(outcome) },
      }
      spawned.push(handle)

      setTimeout(() => {
        stdout.write(frame({
          type: FRAME.READY,
          payload: {
            pid: 100 + spawned.length,
            node: 'test-node',
            hooks: behavior !== 'old-node',
          },
        }))
      }, 5)

      let buffer = ''
      stdin.on('data', (chunk) => {
        buffer += String(chunk)
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (!line.trim()) continue
          const parsed = JSON.parse(line)
          if (parsed.type === FRAME.INIT) { initFrames.push(parsed); continue }
          if (parsed.type !== FRAME.LOAD) continue
          if (behavior === 'timeout') continue
          if (behavior === 'exit') {
            setTimeout(() => handle.settleWith({ exitCode: 1, signal: null }), 5)
            continue
          }
          const delay = behavior === 'reply-slow' ? 200 : 5
          setTimeout(() => {
            stdout.write(frame({
              type: FRAME.RESULT,
              id: parsed.id,
              ok: true,
              payload: {
                moduleId: parsed.payload.moduleId,
                exports: { setup: true, hooks: ['onMessage'] },
                apiCalls: ['log'],
                durationMs: 2,
              },
            }))
          }, delay)
        }
      })
      return handle
    },
  }
  return subprocess
}

function makeManager(subprocess, options = {}) {
  return new SandboxManager({
    subprocess,
    logger: { info() {}, warn() {}, error() {} },
    getRoots: () => ['C:/fake/root'],
    nodePath: process.execPath,
    requestTimeoutMs: 200,
    readyTimeoutMs: 1000,
    maxFailures: 2,
    breakerCooldownMs: 60_000,
    ...options,
  })
}

const MODULE = {
  id: 'ok-mod',
  dir: 'C:/fake/root/ok-mod',
  entryPath: 'C:/fake/root/ok-mod/index.js',
  format: 'plugin.json',
}

let pass = 0
const fail = []
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail.push(name); console.log(`  ✗ ${name}\n    ${e.message}`) }
}

console.log('沙箱管理器（假 subprocess）：')

await check('加载成功：ready → init → load → result，附沙箱 pid/node', async () => {
  const sub = makeFakeSubprocess('reply')
  const manager = makeManager(sub)
  const outcome = await manager.testLoad(MODULE)
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.equal(outcome.result.moduleId, 'ok-mod')
  assert.equal(outcome.result.exports.setup, true)
  assert.equal(outcome.result.sandbox.pid, 101)
  assert.equal(outcome.result.sandbox.node, 'test-node')
  assert.equal(sub.spawned.length, 1)
  await manager.dispose()
})

await check('argv 带 --permission / --allow-fs-read / 禁用字符串代码生成', async () => {
  const sub = makeFakeSubprocess('reply')
  const manager = makeManager(sub)
  await manager.testLoad(MODULE)
  const argv = sub.spawned[0].spec.argv
  assert.ok(argv.includes('--permission'), argv.join(' '))
  assert.ok(argv.some((a) => a.startsWith('--allow-fs-read=')), '缺少 --allow-fs-read')
  assert.ok(argv.includes('--disallow-code-generation-from-strings'))
  assert.equal(sub.spawned[0].spec.stdio.stdin, 'pipe')
  await manager.dispose()
})

await check('init 帧下发了允许目录（沙箱目录 + 外部根）', async () => {
  const sub = makeFakeSubprocess('reply')
  const manager = makeManager(sub)
  await manager.testLoad(MODULE)
  const init = sub.initFrames[0]
  assert.ok(init, '没有收到 init 帧')
  const roots = init.payload.allowedRoots.map((p) => p.replace(/\\/g, '/').toLowerCase())
  assert.ok(roots.some((p) => p.endsWith('/sandbox')), `缺少沙箱目录：${roots}`)
  assert.ok(roots.some((p) => p.endsWith('/fake/root')), `缺少外部根：${roots}`)
  await manager.dispose()
})

await check('5s 超时（调小）：返回 E_TIMEOUT 并杀进程', async () => {
  const sub = makeFakeSubprocess('timeout')
  const manager = makeManager(sub, { requestTimeoutMs: 120 })
  const outcome = await manager.testLoad(MODULE)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, ERR.TIMEOUT, JSON.stringify(outcome.error))
  assert.equal(sub.spawned[0].terminated, true, '超时后必须 terminate')
  await manager.dispose()
})

await check('连续失败触发熔断：后续请求 E_CIRCUIT_OPEN，不再 spawn', async () => {
  const sub = makeFakeSubprocess('timeout')
  const manager = makeManager(sub, { requestTimeoutMs: 80, maxFailures: 2 })
  const first = await manager.testLoad(MODULE)
  const second = await manager.testLoad(MODULE)
  assert.equal(first.error.code, ERR.TIMEOUT)
  assert.equal(second.error.code, ERR.TIMEOUT)
  const spawnsBefore = sub.spawned.length
  const third = await manager.testLoad(MODULE)
  assert.equal(third.ok, false)
  assert.equal(third.error.code, ERR.CIRCUIT_OPEN, JSON.stringify(third.error))
  assert.equal(sub.spawned.length, spawnsBefore, '熔断期间不该再 spawn')
  await manager.dispose()
})

await check('进程退出：在途请求返回 E_SANDBOX_EXIT', async () => {
  const sub = makeFakeSubprocess('exit')
  const manager = makeManager(sub)
  const outcome = await manager.testLoad(MODULE)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, ERR.SANDBOX_EXIT, JSON.stringify(outcome.error))
  await manager.dispose()
})

await check('单飞：第二个请求 E_BUSY', async () => {
  const sub = makeFakeSubprocess('reply-slow')
  const manager = makeManager(sub, { requestTimeoutMs: 1000 })
  const first = manager.testLoad(MODULE)
  await new Promise((r) => setTimeout(r, 30))     // 等 ready + load 已发出
  const second = await manager.testLoad({ ...MODULE, id: 'second-mod' })
  assert.equal(second.ok, false)
  assert.equal(second.error.code, ERR.BUSY, JSON.stringify(second.error))
  const firstOutcome = await first
  assert.equal(firstOutcome.ok, true)
  await manager.dispose()
})

await check('老 Node（无 registerHooks）→ 拒绝使用并杀进程', async () => {
  const sub = makeFakeSubprocess('old-node')
  const manager = makeManager(sub)
  const outcome = await manager.testLoad(MODULE)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, ERR.NO_NODE, JSON.stringify(outcome.error))
  assert.ok(/registerHooks/.test(outcome.error.message), outcome.error.message)
  await manager.dispose()
})

await check('dispose 会 terminate 并拒绝后续 spawn', async () => {
  const sub = makeFakeSubprocess('reply')
  const manager = makeManager(sub)
  await manager.testLoad(MODULE)
  await manager.dispose()
  assert.equal(sub.spawned[0].terminated, true)
  const outcome = await manager.testLoad({ ...MODULE, id: 'after-dispose' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, ERR.SANDBOX_EXIT)
})

console.log(`\n结果：${pass} 通过 / ${fail.length} 失败`)
process.exit(fail.length ? 1 : 0)
