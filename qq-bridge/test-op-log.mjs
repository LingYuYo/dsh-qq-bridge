/**
 * 操作日志落盘 / 切分 / 清理的离线自测（v2.0 第六步，2026-10-28）。
 *
 *   node test-op-log.mjs
 *
 * 不连 QQ、不启 DSH：只验 op-log.mjs 的文件行为 + Bridge 的内存队列 / 上报字段。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Bridge } from './src/bridge.mjs'
import { OpLogFile, dayKey, formatLogLine, stampOf, DEFAULT_LOG_SUBDIR } from './src/op-log.mjs'
import { buildBridgeStatus } from './src/status.mjs'

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-oplog-'))
const readDir = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith('.log')).sort()

console.log('— 日志格式 —')
await check('formatLogLine：[日期 时间] [级别] 内容，多行逐行加前缀', () => {
  const date = new Date(2026, 9, 28, 15, 4, 5)
  const line = formatLogLine(date, 'warn', '第一行\n第二行')
  assert.equal(line, '[2026-10-28 15:04:05] [WARN] 第一行\n[2026-10-28 15:04:05] [WARN] 第二行\n')
  assert.equal(dayKey(date), '2026-10-28')
  assert.equal(stampOf(date), '2026-10-28 15:04:05')
})

console.log('\n— 落盘与切分 —')
await check('默认目录 + 当天文件名 bridge-YYYY-MM-DD.log', () => {
  const base = tmpDir()
  const log = new OpLogFile({ baseDir: base })
  assert.equal(log.directory, path.join(base, DEFAULT_LOG_SUBDIR))
  log.append('info', '截断完成')
  const names = readDir(log.directory)
  assert.equal(names.length, 1)
  assert.match(names[0], /^bridge-\d{4}-\d{2}-\d{2}\.log$/u)
  const body = fs.readFileSync(path.join(log.directory, names[0]), 'utf8')
  assert.match(body, /\[INFO\] 截断完成/u)
})

await check('绝对路径 logDir 原样使用', () => {
  const base = tmpDir()
  const abs = tmpDir()
  const log = new OpLogFile({ baseDir: base, dir: abs })
  assert.equal(log.directory, path.normalize(abs))
  log.append('error', '模型报错')
  assert.equal(readDir(abs).length, 1)
  assert.equal(readDir(base).length, 0, '不该写进 baseDir')
})

await check('超过单文件上限 → 改名为 bridge-日期_时分秒.log，再开新文件', () => {
  const base = tmpDir()
  const log = new OpLogFile({ baseDir: base, maxSizeMB: 1 })
  // 测试里把上限压到 200 字节，避免真的写 1MB。
  log.maxSizeMB = 0.0002
  const filler = 'x'.repeat(300)
  log.append('info', filler)
  log.append('info', filler)
  const names = readDir(log.directory)
  assert.equal(names.length, 2, `应该切出一个文件，实际 ${names.join(',')}`)
  assert.ok(names.some((name) => /^bridge-\d{4}-\d{2}-\d{2}_\d{6}\.log$/u.test(name)),
    '切分文件名要带 _HHmmss')
  assert.ok(names.some((name) => /^bridge-\d{4}-\d{2}-\d{2}\.log$/u.test(name)),
    '当天文件要继续存在')
})

await check('写盘失败不影响调用方（目录是文件的情况）', () => {
  const base = tmpDir()
  const blocked = path.join(base, 'blocked')
  fs.writeFileSync(blocked, 'not a dir')
  const log = new OpLogFile({ baseDir: base, dir: blocked })
  assert.equal(log.append('info', 'hello'), false, '失败返回 false，不抛错')
})

console.log('\n— 清理 —')
await check('删除修改时间超过 maxDays 的 .log，保留新的和非 log 文件', () => {
  const base = tmpDir()
  const log = new OpLogFile({ baseDir: base, maxDays: 15 })
  fs.mkdirSync(log.directory, { recursive: true })
  const oldFile = path.join(log.directory, 'bridge-2000-01-01.log')
  const freshFile = path.join(log.directory, 'bridge-2099-01-01.log')
  const other = path.join(log.directory, 'keep.txt')
  fs.writeFileSync(oldFile, 'old')
  fs.writeFileSync(freshFile, 'fresh')
  fs.writeFileSync(other, 'keep')
  const twentyDaysAgo = Date.now() - 20 * 24 * 60 * 60 * 1000
  fs.utimesSync(oldFile, twentyDaysAgo / 1000, twentyDaysAgo / 1000)
  const result = log.cleanup()
  assert.equal(result.removed, 1)
  assert.equal(fs.existsSync(oldFile), false, '★ 过期文件要删掉')
  assert.equal(fs.existsSync(freshFile), true, '新文件不能删')
  assert.equal(fs.existsSync(other), true, '非 .log 不碰')
})

await check('目录不存在时清理不报错', () => {
  const log = new OpLogFile({ baseDir: path.join(tmpDir(), 'missing') })
  assert.deepEqual(log.cleanup(), { removed: 0, scanned: 0 })
})

console.log('\n— Bridge 内存队列 / 上报 —')
function makeBridge(logDir) {
  return new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: { private: [], groups: [], allowAllWhenEmpty: false },
      stateFile: path.join(tmpDir(), 'sessions.json'),
      ...(logDir ? { logDir } : {}),
    },
    logger: { info() {}, warn() {}, error() {} },
  })
}

await check('_logOp 同时进内存队列与本地文件', () => {
  const dir = tmpDir()
  const b = makeBridge(dir)
  b._logOp('info', '手动提前截断完成')
  b._logOp('error', '模型偏好下发失败')
  const views = b.opLogViews()
  assert.equal(views.length, 2)
  assert.equal(views[0].level, 'info')
  assert.equal(views[1].level, 'error')
  const body = readDir(dir).map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('')
  assert.match(body, /\[INFO\] 手动提前截断完成/u)
  assert.match(body, /\[ERROR\] 模型偏好下发失败/u)
})

await check('内存队列最多 50 条（旧的先挤掉）', () => {
  const b = makeBridge(tmpDir())
  for (let i = 0; i < 60; i++) b._logOp('info', `第 ${i} 条`, { console: false })
  const views = b.opLogViews()
  assert.equal(views.length, 50)
  assert.equal(views.at(-1).text, '第 59 条')
  assert.equal(views[0].text, '第 10 条')
})

await check('buildBridgeStatus 透传 opLog（最多 50 条）', () => {
  const b = makeBridge(tmpDir())
  for (let i = 0; i < 55; i++) b._logOp('info', `x${i}`, { console: false })
  const status = buildBridgeStatus({ health: { online: true, connected: true }, counts: {}, opLog: b.opLogViews() })
  assert.equal(status.opLog.length, 50)
  assert.equal(status.opLog.at(-1).text, 'x54')
})

await check('logDir 热改后下一个 _logOp 就用新目录', () => {
  const dirA = tmpDir()
  const dirB = tmpDir()
  const b = makeBridge(dirA)
  b.live.logDir = dirB
  b._logOp('info', '切目录后')
  assert.equal(fs.existsSync(path.join(dirB, 'bridge-' + dayKey(new Date()) + '.log')), true)
})

console.log('\n— 接入总闸 / 高级面板字段（v2.0 第七步）—')
await check('总闸关闭：消息直接丢弃并计数；打开后恢复处理', async () => {
  const b = makeBridge(tmpDir())
  const msg = {
    kind: 'group', groupId: '123456', userId: '1000000001', text: 'hi', messageId: 'm1',
    raw: { message: [{ type: 'text', data: { text: 'hi' } }] },
  }
  b.live.bridgeEnabled = false
  await b.handleMessage(msg)
  assert.equal(b.stats.paused, 1, '★ 关闭时要计 paused')
  assert.equal(b.stats.received, 0, '★ 关闭时连 received 都不该加')
  b.live.bridgeEnabled = true
  await b.handleMessage(msg)
  assert.equal(b.stats.received, 1, '打开后恢复正常计数')
})

await check('buildBridgeStatus 透传 enabled / 连接地址', () => {
  const status = buildBridgeStatus({
    health: { online: true, connected: true }, counts: {},
    enabled: false, dshBaseUrl: 'http://127.0.0.1:1234', wsUrl: 'ws://127.0.0.1:3001',
  })
  assert.equal(status.enabled, false)
  assert.equal(status.dshBaseUrl, 'http://127.0.0.1:1234')
  assert.equal(status.wsUrl, 'ws://127.0.0.1:3001')
  const fallback = buildBridgeStatus({ health: {}, counts: {} })
  assert.equal(fallback.enabled, true, '缺省按开启')
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
