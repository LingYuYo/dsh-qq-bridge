/**
 * 桥接等待超时回归（离线，不发任何网络请求）。
 *
 * 锁死 2026-10-22 的教训：
 *   ① 默认等待时间必须是 20s，不是 180s（用户等不起，前端也会一直转圈）；
 *   ② 超时必须主动 `session/cancel`，否则 DSH 侧 turn 还在跑，界面卡在「深度求索中」；
 *   ③ 抛出的错误要带 `code: 'TIMEOUT'`，桥接据此回一句「模型没及时响应」。
 *
 * 运行：node qq-bridge/test-timeout.mjs
 */
import assert from 'node:assert/strict'
import { DshClient } from './src/dsh.mjs'

let pass = 0
let fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

/** 造一个只走内存的客户端：网络方法全部打桩。 */
function makeClient({ outline = [], onCall } = {}) {
  const calls = []
  const client = new DshClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 1000 })
  client.turnOutline = async () => outline
  client.prompt = async () => true
  client.call = async (method, args) => {
    calls.push({ method, args })
    onCall?.(method, args)
    return {}
  }
  return { client, calls }
}

console.log('桥接等待超时：')

await check('默认等待 20s（不是 180s）', async () => {
  const source = (await import('node:fs')).readFileSync(new URL('./src/dsh.mjs', import.meta.url), 'utf8')
  assert.match(source, /timeoutMs = 20000/, 'promptAndWait 的默认值应为 20000')
  assert.ok(!/timeoutMs = 180000/.test(source), '不能残留 180s 默认值')
})

await check('超时后主动 session/cancel，并抛出 TIMEOUT', async () => {
  const { client, calls } = makeClient({ outline: [] })
  const started = Date.now()
  await assert.rejects(
    () => client.promptAndWait('s-1', 'hi', { timeoutMs: 80, pollMs: 10 }),
    (error) => {
      assert.equal(error.code, 'TIMEOUT', `错误码应为 TIMEOUT，实际 ${error.code}`)
      assert.match(error.message, /等待回复超时/)
      return true
    },
  )
  assert.ok(Date.now() - started < 2000, '不该真的等满默认值')
  const cancel = calls.find((c) => c.method === 'session/cancel')
  assert.ok(cancel, '超时后必须调用 session/cancel，否则 DSH 前端一直转圈')
  assert.equal(cancel.args.sessionId, 's-1')
})

await check('取消失败也不能吞掉超时错误', async () => {
  const { client } = makeClient({ outline: [] })
  client.call = async () => { throw new Error('DSH 暂时不可达') }
  await assert.rejects(
    () => client.promptAndWait('s-2', 'hi', { timeoutMs: 60, pollMs: 10 }),
    (error) => {
      assert.equal(error.code, 'TIMEOUT')
      assert.equal(error.cancelled, false, '取消失败时应如实标记 cancelled=false')
      return true
    },
  )
})

await check('正常拿到回复时不取消、不报错', async () => {
  // 第二轮有回复：turnOutline 从空变成一条带 response 的记录
  let outlined = 0
  const { client, calls } = makeClient({})
  client.turnOutline = async () => {
    outlined++
    return outlined === 1 ? [] : [{ turn: 1, seq: 5, response: '收到' }]
  }
  client.assistantTextOfTurn = async () => '收到'
  const text = await client.promptAndWait('s-3', 'hi', { timeoutMs: 2000, pollMs: 10 })
  assert.equal(text, '收到')
  assert.ok(!calls.some((c) => c.method === 'session/cancel'), '正常回复不该取消')
})

await check('慢提示：等待超过看门狗时间时打一条 ⏳ 日志（只打一次）', async () => {
  const { client } = makeClient({ outline: [] })
  const logs = []
  client.logger = { info() {}, warn: (m) => logs.push(String(m)), error() {} }
  await assert.rejects(
    () => client.promptAndWait('s-4', 'hi', { timeoutMs: 220, pollMs: 20, slowHintMs: 60 }),
    (error) => error.code === 'TIMEOUT',
  )
  const hints = logs.filter((line) => line.includes('⏳'))
  assert.equal(hints.length, 1, `慢提示应只打一次，实际 ${hints.length}：${JSON.stringify(logs)}`)
  assert.match(hints[0], /看门狗降级/, `提示文案不对：${hints[0]}`)
})

await check('slowHintMs=0（默认）时不打慢提示', async () => {
  const { client } = makeClient({ outline: [] })
  const logs = []
  client.logger = { info() {}, warn: (m) => logs.push(String(m)), error() {} }
  await assert.rejects(
    () => client.promptAndWait('s-5', 'hi', { timeoutMs: 120, pollMs: 20 }),
    (error) => error.code === 'TIMEOUT',
  )
  assert.equal(logs.filter((line) => line.includes('⏳')).length, 0)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
