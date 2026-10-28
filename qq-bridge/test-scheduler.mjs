/**
 * 全局定时任务调度器 / 发送队列的离线用例。
 *
 *   node test-scheduler.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  Scheduler, TaskQueue, nextCronTime, parseCron,
} from './src/scheduler.mjs'

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-scheduler-'))

console.log('— Cron 解析 —')
await check('标准五段式：0 9 * * * / */15 9-17 * * 1-5', () => {
  const daily = parseCron('0 9 * * *')
  assert.ok(daily)
  assert.deepEqual([...daily.minute], [0])
  assert.deepEqual([...daily.hour], [9])
  const work = parseCron('*/15 9-17 * * 1-5')
  assert.ok(work)
  assert.deepEqual([...work.minute], [0, 15, 30, 45])
  assert.equal(work.hour.size, 9)
  assert.deepEqual([...work.dayOfWeek].sort((a, b) => a - b), [1, 2, 3, 4, 5])
})

await check('非法表达式返回 null', () => {
  assert.equal(parseCron('0 9 * *'), null)
  assert.equal(parseCron('61 * * * *'), null)
  assert.equal(parseCron('0 9 * * abc'), null)
  assert.equal(parseCron('*/0 * * * *'), null)
})

await check('nextCronTime：每天 09:00 从 10:00 起算到次日', () => {
  const from = new Date(2026, 0, 1, 10, 0, 0).getTime()
  const next = nextCronTime('0 9 * * *', from)
  const date = new Date(next)
  assert.equal(date.getDate(), 2)
  assert.equal(date.getHours(), 9)
  assert.equal(date.getMinutes(), 0)
})

await check('nextCronTime：*/15 从 10:07 到 10:15', () => {
  const from = new Date(2026, 0, 1, 10, 7, 0).getTime()
  const next = new Date(nextCronTime('*/15 * * * *', from))
  assert.equal(next.getHours(), 10)
  assert.equal(next.getMinutes(), 15)
})

console.log('\n— 调度器 —')
await check('addTask / list / removeTask / 持久化', () => {
  const dir = tmpDir()
  const scheduler = new Scheduler({ dir, exec: async () => ({ ok: true }) })
  const task = scheduler.addTask({ cron: '0 9 * * *', prompt: '发早安', targets: ['g:1'] })
  assert.ok(task)
  assert.equal(scheduler.list().length, 1)
  assert.ok(task.nextRunAt > Date.now())
  scheduler.save()

  const reloaded = new Scheduler({ dir, exec: async () => ({ ok: true }) })
  reloaded.load()
  assert.equal(reloaded.list().length, 1)
  assert.equal(reloaded.list()[0].prompt, '发早安')

  assert.equal(reloaded.removeTask(task.id), true)
  assert.equal(reloaded.list().length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

await check('非法 cron / 空 prompt 不能建任务', () => {
  const dir = tmpDir()
  const scheduler = new Scheduler({ dir, exec: async () => ({ ok: true }) })
  assert.equal(scheduler.addTask({ cron: '0 9 * *', prompt: 'x' }), null)
  assert.equal(scheduler.addTask({ cron: '0 9 * * *', prompt: '  ' }), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

await check('防重启风暴：错过太久顺延，宽限内保留立即跑', () => {
  const dir = tmpDir()
  const now = new Date(2026, 0, 1, 12, 0, 0).getTime()
  const write = (nextRunAt) => fs.writeFileSync(path.join(dir, 'scheduler.json'), JSON.stringify({
    version: 1,
    tasks: [{ id: 't1', cron: '0 9 * * *', prompt: '早安', nextRunAt }],
  }))
  write(now - 10 * 60 * 1000)
  const stale = new Scheduler({ dir, now: () => now, exec: async () => ({ ok: true }) })
  stale.load()
  assert.ok(stale.list()[0].nextRunAt > now, '错过 10 分钟应顺延')

  write(now - 60 * 1000)
  const grace = new Scheduler({ dir, now: () => now, exec: async () => ({ ok: true }) })
  grace.load()
  assert.ok(grace.list()[0].nextRunAt <= now, '宽限内应保留，等 tick 立即补跑')
  fs.rmSync(dir, { recursive: true, force: true })
})

await check('tick：到点执行、记录结果、推进 nextRunAt', async () => {
  const dir = tmpDir()
  let now = new Date(2026, 0, 1, 8, 59, 0).getTime()
  const runs = []
  const scheduler = new Scheduler({
    dir, now: () => now,
    exec: async (task) => { runs.push(task.id); return { ok: true } },
  })
  const task = scheduler.addTask({ cron: '* * * * *', prompt: '每分钟' })
  await scheduler.tick()
  assert.equal(runs.length, 0, '未到点不执行')

  now = task.nextRunAt + 1000
  await scheduler.tick()
  assert.deepEqual(runs, [task.id])
  const after = scheduler.list()[0]
  assert.equal(after.runCount, 1)
  assert.equal(after.lastResult, 'ok')
  assert.ok(after.nextRunAt > now, '执行后要推进到下一次')
  fs.rmSync(dir, { recursive: true, force: true })
})

await check('tick：exec 抛错只记录，不中断调度', async () => {
  const dir = tmpDir()
  let now = Date.now()
  const scheduler = new Scheduler({
    dir, now: () => now,
    exec: async () => { throw new Error('boom') },
  })
  const task = scheduler.addTask({ cron: '* * * * *', prompt: 'x' })
  now = task.nextRunAt + 1000
  await scheduler.tick()
  const row = scheduler.list()[0]
  assert.equal(row.lastResult.includes('boom'), true)
  assert.equal(row.runCount, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log('\n— 发送队列（防风控）—')
await check('单并发 + 间隔 + 每分钟上限', async () => {
  let now = 0
  const sleeps = []
  const queue = new TaskQueue({
    minIntervalMs: 1000,
    jitterMs: 0,
    maxPerMinute: 2,
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms },
    rand: () => 0,
  })
  const order = []
  const run = (id) => queue.enqueue(async () => { order.push(id); return id })
  const promise = Promise.all([run('a'), run('b'), run('c')])
  const result = await promise
  assert.deepEqual(order, ['a', 'b', 'c'], '必须按入队顺序单并发')
  assert.deepEqual(result, ['a', 'b', 'c'])
  assert.ok(sleeps[0] >= 1000, '第一个也要等最小间隔')
  // 第三条要等 60 秒窗口（前两条已占满 2/分钟；窗口从第一条算，剩余约 58 秒）
  assert.ok(sleeps.some((ms) => ms >= 55_000), `应触发分钟限速，实际 ${JSON.stringify(sleeps)}`)
})

await check('积压超上限丢最旧（不会无限堆积）', async () => {
  const queue = new TaskQueue({
    minIntervalMs: 0, jitterMs: 0, maxPerMinute: 100, maxBacklog: 2,
    now: () => 0, sleep: async () => {}, rand: () => 0,
  })
  // 第一个任务占住执行位，后面 3 个排队；队列上限 2，所以最旧的会被丢。
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const first = queue.enqueue(async () => { await gate; return 'first' })
  const second = queue.enqueue(async () => 'second')
  const third = queue.enqueue(async () => 'third')
  const fourth = queue.enqueue(async () => 'fourth')
  release()
  const results = await Promise.all([first, second, third, fourth])
  assert.equal(results[0], 'first')
  assert.ok(results.some((item) => item && item.skipped === true), '应有被丢弃的旧任务')
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
