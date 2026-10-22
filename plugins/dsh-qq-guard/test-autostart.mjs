/**
 * 批次 5 回归：bridge.autoStart 自动拉起 + 桥接进程管理的审计修复。
 *
 * 覆盖（离线，全部用假 subprocess，不真起进程）：
 *   ① autoStart:true → 1.5s 后 spawn 桥接（argv/cwd/stdio 正确）
 *   ② autoStart:false → 绝不 spawn
 *   ③ 插件卸载（fiber teardown）会取消未触发的 autoStart → 不留孤儿桥接
 *   ④ 单实例锁：已有活实例 → 跳过 spawn（防两个桥接重复收消息）
 *   ⑤ 桥接自己因单实例让位（exit 0）→ 当作「已在运行」，不报失败
 *   ⑥ 崩溃重启有上限，且不会被每次 start() 清零（起来就崩不会无限重启）
 *
 * 运行：node plugins/dsh-qq-guard/test-autostart.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 同 test-guard-scope.mjs：schemastery 路径由 QQG_SCHEMASTERY 指定或自动探测。
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

// 与 test-guard-scope.mjs 相同：把宿主解析的 schemastery 换成本地绝对路径。
const SRC = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')
const SM_PATH = resolveSchemastery()
const patched = SRC.replace(
  /^import Schema from '@deepseek-ai\/schemastery'$/m,
  `import Schema from ${JSON.stringify('file:///' + SM_PATH.replace(/\\/g, '/'))}`,
)
const tmpFile = path.join(HERE, '.tmp-index-autostart.mjs')
fs.writeFileSync(tmpFile, patched)
let mod
try {
  mod = await import('file:///' + tmpFile.replace(/\\/g, '/'))
} finally {
  fs.unlinkSync(tmpFile)
}

const { BridgeRunner, DEFAULT_BRIDGE_DIR } = await import('./bridge-runner.mjs')

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(10)
  }
  return false
}

/** 假 subprocess：只记录 spawn，不真起进程；done 由测试手动 settle。 */
function makeFakeSubprocess() {
  const spawned = []
  return {
    spawned,
    spawn(spec) {
      let resolveDone
      const done = new Promise((res) => { resolveDone = res })
      const handle = {
        stdout: undefined,
        stderr: undefined,
        done,
        terminate() {},
        async waitForExit() { return true },
        settle(outcome) { resolveDone(outcome) },
      }
      spawned.push({ spec, handle })
      return handle
    },
  }
}

/** 假 ctx：捕获 effect（含 label 与 cleanup）、路由、日志、spawn。 */
function makeCtx() {
  const effects = []
  const routes = []
  const logs = []
  const subprocess = makeFakeSubprocess()
  const logger = {
    info: (m) => logs.push({ level: 'info', text: String(m) }),
    warn: (m) => logs.push({ level: 'warn', text: String(m) }),
    error: (m) => logs.push({ level: 'error', text: String(m) }),
  }
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    effect(fn, label) {
      let cleanup
      try { cleanup = fn() } catch { cleanup = undefined }
      effects.push({ label, cleanup })
      return () => {}
    },
    inject: () => {},
    webServer: {
      register(route) { routes.push(route); return () => {} },
    },
    subprocess,
    logger,
  }
  return { ctx, effects, routes, logs, subprocess }
}

/** 造一个临时「桥接目录」：只需要 start.mjs 存在即可通过入口检查。 */
function makeBridgeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-autostart-'))
  fs.writeFileSync(path.join(dir, 'start.mjs'), '// fake bridge entry\n')
  return dir
}

const loggerNoop = { info() {}, warn() {}, error() {} }

// 与 index.js 里 Symbol.for 的标记一致：每个用例前清掉，模拟「一次新的 DSH 生命周期」。
const AUTO_START_MARK = Symbol.for('@local/dsh-qq-guard:auto-start-honored')
const resetAutoStartMark = () => { delete globalThis[AUTO_START_MARK] }

console.log('— ① autoStart:true → 静默拉起 —')
await check('1.5s 后 spawn 桥接，argv/cwd/stdio 正确', async () => {
  resetAutoStartMark()
  const { ctx, logs, subprocess } = makeCtx()
  // ⚠️ 必须显式给临时目录：默认目录是真实的 qq-bridge，若本机桥接正在运行，
  // BridgeRunner 的单实例检查会正确判成 already-running-external → 不 spawn，
  // 这条用例就会假红。这里要测的是 autoStart 的时序与 argv，不是单实例逻辑。
  const dir = makeBridgeDir()
  mod.apply(ctx, mod.Config({ role: 'settings', bridge: { dir, autoStart: true } }))
  assert.ok(logs.some((l) => l.text.includes('bridge.autoStart=true')), '应记录 autoStart 已开启')
  assert.equal(subprocess.spawned.length, 0, 'apply 当下不该立刻 spawn（要等 DSH 就绪）')
  const ok = await waitFor(() => subprocess.spawned.length === 1, 3000)
  assert.ok(ok, '1.5s 后应 spawn 桥接')
  const { spec } = subprocess.spawned[0]
  assert.equal(spec.argv.length, 2)
  assert.ok(spec.argv[1].endsWith('start.mjs'), `入口不对：${spec.argv[1]}`)
  assert.equal(path.resolve(spec.cwd), path.resolve(dir), `cwd 应为配置的桥接目录，实际 ${spec.cwd}`)
  assert.ok(fs.existsSync(path.join(spec.cwd, 'start.mjs')), '桥接目录里应有 start.mjs')
  assert.equal(spec.stdio.stdout, 'pipe', '★ 桥接日志必须 pipe 出来（唯一排障线索）')
  assert.equal(spec.stdio.stderr, 'pipe')
  // 收尾：把假进程 settle 掉，别留悬空 Promise（不影响断言）
  subprocess.spawned[0].handle.settle({ exitCode: 0, signal: null })
})

console.log('\n— ② autoStart:false → 不拉起 —')
await check('默认配置不会 spawn', async () => {
  resetAutoStartMark()
  const { ctx, subprocess } = makeCtx()
  mod.apply(ctx, mod.Config({ role: 'settings' }))
  await sleep(1700)
  assert.equal(subprocess.spawned.length, 0, '★ autoStart 未开启时绝不能起桥接')
})

console.log('\n— ③ teardown 取消未触发的 autoStart —')
await check('插件卸载清理定时器 → 不留孤儿桥接', async () => {
  resetAutoStartMark()
  const { ctx, effects, subprocess } = makeCtx()
  mod.apply(ctx, mod.Config({ role: 'settings', bridge: { autoStart: true } }))
  const entry = effects.find((e) => e.label === 'qq-guard: bridge autostart timer')
  assert.ok(entry, '必须把 autoStart 定时器挂到 fiber 上（ctx.effect）')
  assert.equal(typeof entry.cleanup, 'function', 'effect 应返回清理函数')
  entry.cleanup()   // 模拟插件卸载 / DSH 快速退出
  await sleep(1700)
  assert.equal(subprocess.spawned.length, 0, '★ 卸载后 1.5s 内不能再 spawn 出没人管的桥接')
})

console.log('\n— ③b 配置保存触发插件热重载 → 不重复拉起 —')
await check('同一 DSH 进程内重载插件不会再 spawn 第二个桥接', async () => {
  resetAutoStartMark()
  const { ctx, logs, subprocess } = makeCtx()
  // 同上：临时目录，避免本机真实桥接在跑时被判成 already-running-external。
  const dir = makeBridgeDir()
  const config = mod.Config({ role: 'settings', bridge: { dir, autoStart: true } })
  mod.apply(ctx, config)
  assert.ok(await waitFor(() => subprocess.spawned.length === 1, 3000), '首次装载应拉起桥接')
  // DSH 的 config-editor 保存设置后会 reconcile 并重载本 entry → apply 再来一次
  mod.apply(ctx, config)
  await sleep(1700)
  assert.equal(subprocess.spawned.length, 1, '★ 热重载不能停掉再拉起桥接（改设置不应打断收发）')
  assert.ok(logs.some((l) => l.text.includes('已在本 DSH 进程中执行过')), '应记录「已执行过、跳过」')
  subprocess.spawned[0].handle.settle({ exitCode: 0, signal: null })
})

console.log('\n— ④ 单实例：已有活实例就跳过 —')
await check('桥接目录的 .bridge.lock 指向活进程 → 不 spawn', async () => {
  const dir = makeBridgeDir()
  fs.writeFileSync(path.join(dir, '.bridge.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
  const subprocess = makeFakeSubprocess()
  const runner = new BridgeRunner({ subprocess, logger: loggerNoop, getConfig: () => ({ bridgeDir: dir }) })
  try {
    const result = await runner.start()
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.action, 'already-running-external', JSON.stringify(result))
    assert.equal(subprocess.spawned.length, 0, '★ 已有实例时绝不能起第二个（会重复回复）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('陈旧锁（pid 已死）不会阻止启动（由桥接自己清理）', async () => {
  const dir = makeBridgeDir()
  // 用一个几乎不可能存在的 pid 造陈旧锁
  fs.writeFileSync(path.join(dir, '.bridge.lock'), JSON.stringify({ pid: 2147483646, startedAt: 1 }))
  const subprocess = makeFakeSubprocess()
  const runner = new BridgeRunner({
    subprocess, logger: loggerNoop,
    getConfig: () => ({ bridgeDir: dir }), readyWaitMs: 0,
  })
  try {
    const p = runner.start()
    await waitFor(() => subprocess.spawned.length === 1, 1000)
    assert.equal(subprocess.spawned.length, 1, '陈旧锁应允许启动')
    subprocess.spawned[0].handle.settle({ exitCode: 0, signal: null })
    await p
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

console.log('\n— ⑤ 桥接主动让位（exit 0）不当作失败 —')
await check('已有实例 → 子进程 exit 0 → action=already-running', async () => {
  const dir = makeBridgeDir()
  const subprocess = makeFakeSubprocess()
  const runner = new BridgeRunner({
    subprocess, logger: loggerNoop,
    getConfig: () => ({ bridgeDir: dir }), readyWaitMs: 0,
  })
  try {
    const p = runner.start()
    // 子进程在 start() 的「确认还活着」窗口内就以 exit 0 退出（模拟单实例让位）。
    const got = await waitFor(() => subprocess.spawned.length === 1, 1000)
    assert.ok(got, '应 spawn 一次')
    subprocess.spawned[0].handle.settle({ exitCode: 0, signal: null })
    const settled = await p
    assert.equal(settled.ok, true, JSON.stringify(settled))
    assert.equal(settled.action, 'already-running', JSON.stringify(settled))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

console.log('\n— ⑥ 崩溃重启上限不被 start() 清零 —')
await check('连续崩溃 4 次 → 只 spawn 4 个（1 次首发 + 3 次重启）', async () => {
  const dir = makeBridgeDir()
  const subprocess = makeFakeSubprocess()
  const logs = []
  const runner = new BridgeRunner({
    subprocess,
    logger: { info() {}, warn() {}, error: (m) => logs.push(String(m)) },
    getConfig: () => ({ bridgeDir: dir }),
    readyWaitMs: 0,
    stableUptimeMs: 60_000,   // 远大于本用例时长：期间不许清零
    restartBaseDelayMs: 20,   // 加速重启退避
  })
  try {
    const first = await runner.start()
    assert.equal(first.action, 'started', JSON.stringify(first))

    for (let i = 1; i <= 4; i++) {
      const got = await waitFor(() => subprocess.spawned.length >= i, 2000)
      assert.ok(got, `第 ${i} 次 spawn 没出现`)
      subprocess.spawned[i - 1].handle.settle({ exitCode: 1, signal: null })
      if (i < 4) {
        const next = await waitFor(() => subprocess.spawned.length >= i + 1, 2000)
        assert.ok(next, `第 ${i} 次崩溃后应自动重启`)
      }
    }
    await sleep(250)
    assert.equal(subprocess.spawned.length, 4, `★ 应停在第 4 个（1+3），实际 ${subprocess.spawned.length}`)
    assert.equal(runner.autoRestarts, 3)
    assert.ok(logs.some((m) => m.includes('连续崩溃')), '达到上限应打错误日志')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

console.log('\n— ⑦ Host 状态路由：四态入库 + 旧字段兼容 —')
const makeRes = () => ({
  status: 0,
  body: '',
  headers: {},
  writeHead(s) { this.status = s },
  end(b) { this.body = b },
})
const makeReq = (method, bodyText) => {
  const handlers = {}
  const req = {
    method,
    headers: {},
    on(ev, fn) { handlers[ev] = fn; return req },
    destroy() {},
  }
  if (bodyText !== undefined) {
    setImmediate(() => {
      handlers.data?.(Buffer.from(bodyText))
      handlers.end?.()
    })
  }
  return req
}
async function postStatus(routes, payload) {
  const route = routes.find((r) => r.path === '/dsh-qq-guard/status')
  assert.ok(route, '应注册 /dsh-qq-guard/status')
  const res = makeRes()
  route.handler(makeReq('POST', JSON.stringify(payload)), res)
  await waitFor(() => res.body !== '', 1000)
  return { res, body: JSON.parse(res.body || '{}') }
}
function getStatus(routes) {
  const route = routes.find((r) => r.path === '/dsh-qq-guard/status')
  const res = makeRes()
  route.handler({ method: 'GET', headers: {} }, res)
  return JSON.parse(res.body)
}

await check('qqState=unverified 原样入库，qqConnected=false', async () => {
  const { ctx, routes } = makeCtx()
  mod.apply(ctx, mod.Config({ role: 'settings' }))
  const { res } = await postStatus(routes, {
    qqConnected: false, qqState: 'unverified', dshOk: true, counts: { received: 1 },
  })
  assert.equal(res.status, 200)
  const status = getStatus(routes)
  assert.equal(status.reported, true)
  assert.equal(status.status.qqState, 'unverified')
  assert.equal(status.status.qqConnected, false)
  assert.equal(status.status.counts.received, 1)
})
await check('非法 qqState 被丢弃（不会把任意字符串写进状态）', async () => {
  const { ctx, routes } = makeCtx()
  mod.apply(ctx, mod.Config({ role: 'settings' }))
  await postStatus(routes, { qqConnected: true, qqState: 'evil-state' })
  const status = getStatus(routes)
  assert.equal(status.status.qqConnected, true, '旧字段照常入库')
  assert.equal('qqState' in status.status, false, '★ 非法状态必须丢弃')
})
await check('旧版桥接只报 qqConnected 时仍兼容（不回退成错误状态）', async () => {
  const { ctx, routes } = makeCtx()
  mod.apply(ctx, mod.Config({ role: 'settings' }))
  await postStatus(routes, { qqConnected: true, dshOk: true, counts: {} })
  const status = getStatus(routes)
  assert.equal(status.status.qqConnected, true)
  assert.equal('qqState' in status.status, false, '缺 qqState 时前端走旧字段回落')
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
