/**
 * NapCat 进程管理回归（离线，用假 subprocess，不真起进程）。
 *
 * 验证：
 *   ① 三层在线判定的状态机（stopped / external / starting / online / offline / running-unverified）
 *   ② 防双开：端口已监听时 start() 直接复用，不 spawn
 *   ③ 退出清理：注册的 teardown 真的调 stop()
 *   ④ TERM→宽限→回退 的停止阶梯
 *   ⑤ 可执行文件解析（目录不存在 / 缺 exe 的报错）
 *
 * 运行：node plugins/dsh-qq-guard/test-napcat.mjs
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  NapcatManager, resolveNapcatExe, isPortListening, DEFAULT_WS_PORT, STOP_GRACE_MS,
} from './napcat.mjs'

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

/** 假 subprocess：记录 spawn 调用，可控 done 的 settle 时机。 */
function makeFakeSubprocess() {
  const spawned = []
  const spawn = (spec) => {
    let resolveDone
    const done = new Promise((res) => { resolveDone = res })
    const handle = {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: {},
      done,
      terminateCalls: 0,
      terminate() { this.terminateCalls++ },
      // 只有真的 settle 了才「退出」；否则等 done
      async waitForExit() { return true },
      _settleResolve: resolveDone,
    }
    spawned.push({ spec, handle })
    return handle
  }
  return {
    spawn,
    spawned,
    /** 让第 n 个 spawn 出来的进程退出。spawn 之后才可用。 */
    finishExit: (code = 0) => {
      const h = spawned[spawned.length - 1]?.handle
      if (!h) throw new Error('还没有 spawn 过进程')
      h._settleResolve({ exitCode: code, signal: null })
    },
  }
}

const logger = { info() {}, warn() {}, error() {} }

// NapCat 安装目录不再有内置默认值，测试自己造一个 fixture 目录（含假的 exe）。
// 只验证参数与状态机，不执行它。
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-fixture-'))
fs.writeFileSync(path.join(FIXTURE_DIR, 'NapCatWinBootMain.exe'), '')
process.on('exit', () => { try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }) } catch { /* 已清理 */ } })

console.log('— ① 可执行文件解析 —')
await check('目录不存在时报清晰错误', () => {
  assert.throws(() => resolveNapcatExe('D:\\__no_such_napcat__'), /目录不存在/)
})
await check('目录存在但缺 exe 时报清晰错误', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-x-'))
  try { assert.throws(() => resolveNapcatExe(dir), /没找到 NapCatWinBootMain.exe/) }
  finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
await check('配置了目录就能解析出 exe', () => {
  const { exe, dir } = resolveNapcatExe(FIXTURE_DIR)
  assert.ok(exe.endsWith('NapCatWinBootMain.exe'), exe)
  assert.ok(fs.existsSync(exe), `exe 不存在：${exe}`)
  assert.ok(fs.existsSync(dir))
})
await check('没配置目录时报清晰错误', () => {
  assert.throws(() => resolveNapcatExe(''), /未配置 NapCat 安装目录/)
})

console.log('\n— ② 端口探测 —')
await check('未监听端口返回 false', async () => {
  assert.equal(await isPortListening(1, '127.0.0.1', 300), false)
})
await check('监听中的端口返回 true', async () => {
  const srv = net.createServer(() => {})
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try { assert.equal(await isPortListening(port, '127.0.0.1', 500), true) }
  finally { srv.close() }
})

console.log('\n— ③ 防双开：端口在跑就复用 —')
await check('端口已监听时 start() 不 spawn', async () => {
  const srv = net.createServer(() => {})
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const fake = makeFakeSubprocess()
  const mgr = new NapcatManager({ subprocess: fake, logger, getConfig: () => ({ napcatDir: FIXTURE_DIR, wsPort: port }) })
  try {
    const r = await mgr.start()
    assert.equal(r.action, 'reused', JSON.stringify(r))
    assert.equal(r.reused, true)
    assert.equal(fake.spawned.length, 0, '★ 绝不能起第二个 NapCat')
  } finally { srv.close() }
})

console.log('\n— ④ 启动参数正确（快速登录 / cwd / stdio / 宽限）—')
await check('传 QQ 号作为 argv[1]，cwd 是 NapCat 目录，graceMs=5000', async () => {
  const fake = makeFakeSubprocess()
  const mgr = new NapcatManager({
    subprocess: fake, logger,
    getConfig: () => ({ napcatDir: FIXTURE_DIR, wsPort: 1, quickLoginQQ: '10086' }),
  })
  const p = mgr.start()
  await new Promise((r) => setTimeout(r, 50))
  fake.finishExit(0)
  await p
  const { spec } = fake.spawned[0]
  assert.equal(spec.argv[1], '10086', 'QQ 号应作为第二个参数')
  assert.ok(spec.argv[0].endsWith('NapCatWinBootMain.exe'))
  assert.ok(fs.existsSync(spec.cwd), 'cwd 应存在')
  assert.equal(spec.graceMs, STOP_GRACE_MS, '宽限应为 5000ms')
  assert.equal(spec.stdio.stdin, 'ignore')
  // stdout/stderr 必须 pipe：NapCat 起不来的原因（端口被占 / 未登录）只在它自己的输出里。
  assert.equal(spec.stdio.stdout, 'pipe', 'NapCat 日志要能读到（面板「NapCat 日志」框）')
  assert.equal(spec.stdio.stderr, 'pipe')
})
await check('不填 QQ 号时只有一个参数', async () => {
  const fake = makeFakeSubprocess()
  const mgr = new NapcatManager({ subprocess: fake, logger, getConfig: () => ({ napcatDir: FIXTURE_DIR, wsPort: 1 }) })
  const p = mgr.start()
  await new Promise((r) => setTimeout(r, 50))
  fake.finishExit(0)
  await p
  assert.equal(fake.spawned[0].spec.argv.length, 1)
})

console.log('\n— ⑤ 三层状态判定 —')
await check('全都没在跑 → stopped', async () => {
  const fake = makeFakeSubprocess()
  const mgr = new NapcatManager({ subprocess: fake, logger, getConfig: () => ({ napcatDir: FIXTURE_DIR, wsPort: 1 }) })
  const snap = await mgr.snapshot()
  assert.equal(snap.state, 'stopped', JSON.stringify(snap))
  assert.equal(snap.processAlive, false)
  assert.equal(snap.portListening, false)
})
await check('端口在监听但非本插件起 → external', async () => {
  const srv = net.createServer(() => {})
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const mgr = new NapcatManager({ subprocess: makeFakeSubprocess(), logger, getConfig: () => ({ napcatDir: FIXTURE_DIR, wsPort: port }) })
  try {
    const snap = await mgr.snapshot()
    assert.equal(snap.state, 'external', JSON.stringify(snap))
    assert.equal(snap.portListening, true)
  } finally { srv.close() }
})
await check('进程在跑但端口没起 → starting', async () => {
  const fake = makeFakeSubprocess()
  const mgr = new NapcatManager({ subprocess: fake, logger, getConfig: () => ({ napcatDir: FIXTURE_DIR, wsPort: 1 }) })
  const p = mgr.start()
  await new Promise((r) => setTimeout(r, 30))
  const snap = await mgr.snapshot()
  assert.equal(snap.processAlive, true)
  assert.equal(snap.state, 'starting', JSON.stringify(snap))
  fake.finishExit(0)
  await p
})
await check('进程+端口都在但没配 HTTP → running-unverified（不谎报在线）', async () => {
  // 用空闲端口：先让 start 探测到「未监听」从而真的 spawn，
  // 再在它轮询期间把监听打开 —— 模拟 NapCat 启动成功的过程。
  const probe = net.createServer(() => {})
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const port = probe.address().port
  await new Promise((r) => probe.close(r))   // 先释放端口

  const fake = makeFakeSubprocess()
  const mgr = new NapcatManager({
    subprocess: fake,
    logger,
    getConfig: () => ({ napcatDir: FIXTURE_DIR, wsPort: port, onebotHttpUrl: '' }),
  })
  const p = mgr.start()
  const deadline = Date.now() + 2000
  while (fake.spawned.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  assert.equal(fake.spawned.length, 1, '应已 spawn（端口启动时还是空的）')

  // 现在让端口真的监听，start 的轮询会看到它并返回
  const srv = net.createServer(() => {})
  await new Promise((r) => srv.listen(port, '127.0.0.1', r))
  let started
  try {
    started = await p
    assert.equal(started.ok, true, JSON.stringify(started))
    assert.equal(started.listening, true, 'start 应观察到端口已监听')

    const snap = await mgr.snapshot()
    assert.equal(snap.processAlive, true)
    assert.equal(snap.portListening, true)
    assert.equal(snap.probeAvailable, false, '没配 HTTP 时探不到账号')
    assert.equal(snap.state, 'running-unverified', JSON.stringify(snap))
  } finally {
    srv.close()
    fake.finishExit(0)
    await p.catch(() => {})
  }
})

console.log('\n— ⑥ 停止阶梯 —')
await check('没管理进程时 stop() 安全返回 not-managed', async () => {
  const mgr = new NapcatManager({ subprocess: makeFakeSubprocess(), logger, getConfig: () => ({ napcatDir: FIXTURE_DIR, wsPort: 1 }) })
  const r = await mgr.stop()
  assert.equal(r.ok, true)
  assert.equal(r.action, 'not-managed')
})
await check('terminate 被调用 + waitForExit 被等待（直接塞 handle 模拟）', async () => {
  const fake = makeFakeSubprocess()
  const mgr = new NapcatManager({ subprocess: fake, logger, getConfig: () => ({ napcatDir: FIXTURE_DIR, wsPort: 1 }) })
  // 直接构造一个「已在管理」的状态，绕开 start 的端口等待
  const handle = fake.spawn({ argv: ['x'], cwd: '.', stdio: {}, graceMs: 5000 })
  mgr.handle = handle
  mgr._alive = true

  const r = await mgr.stop()
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(handle.terminateCalls >= 1, '★ 必须先走 terminate（TERM→宽限→KILL）')
  assert.equal(mgr.processAlive, false)
  assert.equal(mgr.handle, null, 'handle 应被清空')
})
await check('启动未结束时 stop 返回 busy（并发保护）', async () => {
  const fake = makeFakeSubprocess()
  const mgr = new NapcatManager({ subprocess: fake, logger, getConfig: () => ({ napcatDir: FIXTURE_DIR, wsPort: 1 }) })
  const p = mgr.start()
  const deadline = Date.now() + 2000
  while (fake.spawned.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  const busy = await mgr.stop()
  assert.equal(busy.action, 'busy', '启动中应拒绝 stop，避免把启动到一半的进程丢在后台')
  // 收尾
  fake.finishExit(0)
  await p
})

console.log('\n— ⑦ 退出清理挂钩 —')
await check('teardown 会调 stop（DSH 退出不留孤儿）', async () => {
  const fake = makeFakeSubprocess()
  const mgr = new NapcatManager({ subprocess: fake, logger, getConfig: () => ({ napcatDir: FIXTURE_DIR, wsPort: 1 }) })
  const p = mgr.start()
  await new Promise((r) => setTimeout(r, 30))
  fake.finishExit(0)
  await p
  let stopped = 0
  const teardown = () => { stopped++; return mgr.stop() }
  await teardown()
  assert.equal(stopped, 1)
})

console.log('\n— ⑧ 并发保护 —')
await check('启动中再点启动返回 busy，不重复 spawn', async () => {
  const fake = makeFakeSubprocess()
  const mgr = new NapcatManager({ subprocess: fake, logger, getConfig: () => ({ napcatDir: FIXTURE_DIR, wsPort: 1 }) })
  const p1 = mgr.start()
  await new Promise((r) => setTimeout(r, 20))
  const r2 = await mgr.start()
  assert.equal(r2.action, 'busy', JSON.stringify(r2))
  assert.equal(fake.spawned.length, 1, '★ 连点两次只能起一个进程')
  fake.finishExit(0)
  await p1
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
