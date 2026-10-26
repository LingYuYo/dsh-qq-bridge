/**
 * OneBot notice（戳一戳）事件 + 回戳 API 的离线回归（2026-10-26，规格 §6）。
 *
 * 覆盖：
 *   ① `_dispatchEvent` 的 notice 分支：群聊/私聊 poke 字段、self_id / sender_id 容错、
 *      自己戳自己忽略、非 poke 通知静默、处理器抛错不外溢；
 *   ② `sendPoke` 的 action 选择：group_poke / friend_poke 首选 → send_poke 兜底，
 *      失败返回对象且**永不抛**；
 *   ③ `nameOf` 暴露昵称缓存（兼容桥接 `g:` / `u:` 会话 key）；
 *   ④ notice 分支不串台：普通 message 事件仍只走 onMessage。
 *
 * 不连 NapCat、不连 DSH：事件直接喂 `_onRaw(JSON.stringify(packet))`，
 * API 调用把实例的 `call` 打桩（记录 action/params）。
 * 运行：node test-notice-poke.mjs
 */
import assert from 'node:assert/strict'
import { OneBotClient } from './src/onebot.mjs'

let pass = 0
let fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

/** 静默 logger；要断言日志时自己传收集器。 */
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} }

/**
 * 造一个纯内存客户端：`call` 换成可编程桩（默认全 ok），并按需假装已登录 selfId。
 * @param {{call?:Function, logOverrides?:object, selfId?:string}} [opts]
 */
function makeClient({ call, logOverrides, selfId = '999' } = {}) {
  const calls = []
  const logs = { info: [], warn: [], error: [], debug: [] }
  const collect = {}
  for (const name of Object.keys(logs)) collect[name] = (msg) => logs[name].push(String(msg))
  const client = new OneBotClient({ logger: { ...quietLogger, ...collect, ...(logOverrides ?? {}) } })
  client.call = async (action, params) => {
    calls.push({ action, params })
    return call ? call(action, params) : { status: 'ok', retcode: 0, data: {} }
  }
  if (selfId !== null) client._selfId = selfId
  return { client, calls, logs }
}

/** 喂一个事件包（走真实 _onRaw 解析路径，不起 WebSocket）。 */
const feed = (client, packet) => client._onRaw(JSON.stringify(packet))

const pokePacket = (over = {}) => ({
  post_type: 'notice',
  notice_type: 'notify',
  sub_type: 'poke',
  time: 1730000000,
  self_id: 999,
  user_id: 1000000001,
  target_id: 999,
  group_id: 123456,
  ...over,
})

/** 收集 notice 事件的注册器。 */
function collectNotices(client) {
  const got = []
  client.onNotice((ev) => got.push(ev))
  return got
}

console.log('OneBot 戳一戳（notice / sendPoke / nameOf）：')

console.log('\n— 接口面 —')
await check('三个新接口都在，构造不抛错', () => {
  const { client } = makeClient()
  for (const m of ['onNotice', 'sendPoke', 'nameOf']) {
    assert.equal(typeof client[m], 'function', `缺方法 ${m}`)
  }
})
await check('onNotice 传非函数抛 TypeError', () => {
  const { client } = makeClient()
  assert.throws(() => client.onNotice('不是函数'), /需要一个函数/)
})
await check('onNotice 返回注销函数，注销后不再触发', () => {
  const { client } = makeClient()
  let n = 0
  const off = client.onNotice(() => { n++ })
  feed(client, pokePacket())
  assert.equal(n, 1)
  assert.equal(off(), true)
  feed(client, pokePacket())
  assert.equal(n, 1, '注销后不该再收到')
})

console.log('\n— notice 解析 —')
await check('群聊戳一戳：字段齐全（kind/userId/targetId/groupId/selfId/time/raw）', () => {
  const { client } = makeClient()
  const got = collectNotices(client)
  const packet = pokePacket()
  feed(client, packet)
  assert.equal(got.length, 1)
  assert.deepEqual(
    {
      kind: got[0].kind, userId: got[0].userId, targetId: got[0].targetId,
      groupId: got[0].groupId, selfId: got[0].selfId, time: got[0].time,
    },
    { kind: 'poke', userId: '1000000001', targetId: '999', groupId: '123456', selfId: '999', time: 1730000000 },
  )
  assert.deepEqual(got[0].raw, packet, 'raw 应是原始事件包的内容')
})
await check('私聊戳一戳：groupId 为 null', () => {
  const { client } = makeClient()
  const got = collectNotices(client)
  feed(client, pokePacket({ group_id: null }))
  assert.equal(got.length, 1)
  assert.equal(got[0].groupId, null)
})
await check('缺 user_id 时回落 sender_id', () => {
  const { client } = makeClient()
  const got = collectNotices(client)
  feed(client, pokePacket({ user_id: undefined, sender_id: 1000000002 }))
  assert.equal(got.length, 1)
  assert.equal(got[0].userId, '1000000002')
})
await check('缺 self_id 时回落已登录的 _selfId', () => {
  const { client } = makeClient({ selfId: '888' })
  const got = collectNotices(client)
  feed(client, pokePacket({ self_id: undefined, target_id: 888 }))
  assert.equal(got.length, 1)
  assert.equal(got[0].selfId, '888')
})
await check('自己戳自己（userId === selfId）直接丢', () => {
  const { client } = makeClient({ selfId: '999' })
  const got = collectNotices(client)
  feed(client, pokePacket({ user_id: 999, target_id: 999 }))
  assert.equal(got.length, 0)
})
await check('缺 user_id / sender_id 的 poke 忽略（不构造空事件）', () => {
  const { client } = makeClient()
  const got = collectNotices(client)
  feed(client, pokePacket({ user_id: undefined, sender_id: undefined }))
  assert.equal(got.length, 0)
})
await check('非 poke notice（入群/撤回等）忽略且不抛，只记 debug', () => {
  const { client, logs } = makeClient()
  const got = collectNotices(client)
  assert.doesNotThrow(() => {
    feed(client, { post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve', time: 1, self_id: 999, user_id: 1000000001 })
    feed(client, { post_type: 'notice', notice_type: 'group_recall', time: 1, self_id: 999 })
    feed(client, { post_type: 'notice', notice_type: 'notify', sub_type: 'honor', time: 1, self_id: 999 })
  })
  assert.equal(got.length, 0)
  assert.equal(logs.debug.length, 3, `应各记一条 debug，实际 ${JSON.stringify(logs.debug)}`)
})
await check('notice 处理器抛错不外溢（记 error 后继续）', () => {
  const { client, logs } = makeClient()
  let n = 0
  client.onNotice(() => { n++; throw new Error('处理器炸了') })
  client.onNotice(() => { n++ })
  assert.doesNotThrow(() => feed(client, pokePacket()))
  assert.equal(n, 2, '前一个抛错不能挡住后一个')
  assert.ok(logs.error.some((line) => line.includes('处理器炸了')), '应记 error 日志')
})
await check('notice 分支不串台：message 事件仍只走 onMessage', () => {
  const { client } = makeClient()
  const notices = collectNotices(client)
  const messages = []
  client.onMessage((ev) => messages.push(ev))
  feed(client, {
    post_type: 'message', message_type: 'group', self_id: 999, user_id: 1000000001,
    group_id: 123456, message_id: 7001, time: 1730000000,
    sender: { user_id: 1000000001, nickname: '小明' },
    message: [{ type: 'text', data: { text: '你好' } }],
  })
  assert.equal(messages.length, 1, '消息事件应正常派发')
  assert.equal(notices.length, 0, 'notice 处理器不该收到消息事件')
  // 反向：notice 也不该触发 message 处理器
  feed(client, pokePacket())
  assert.equal(messages.length, 1)
  assert.equal(notices.length, 1)
})

console.log('\n— sendPoke：action 选择 —')
await check('群聊首选 group_poke（{group_id, user_id}），成功即返回', async () => {
  const { client, calls } = makeClient()
  const res = await client.sendPoke('group', '123456', { userId: '1000000001' })
  assert.deepEqual(res, { ok: true, action: 'group_poke', retcode: 0 })
  assert.equal(calls.length, 1, `只该调一次，实际 ${JSON.stringify(calls)}`)
  assert.deepEqual(calls[0], { action: 'group_poke', params: { group_id: 123456, user_id: 1000000001 } })
})
await check('私聊首选 friend_poke（{user_id}），不带 group_id', async () => {
  const { client, calls } = makeClient()
  const res = await client.sendPoke('private', '1000000001', { userId: '1000000001' })
  assert.deepEqual(res, { ok: true, action: 'friend_poke', retcode: 0 })
  assert.deepEqual(calls[0], { action: 'friend_poke', params: { user_id: 1000000001 } })
})
await check('group_poke retcode 非 0 → 兜底 send_poke（{user_id, group_id}）', async () => {
  const { client, calls } = makeClient({
    call: (action) => (action === 'group_poke'
      ? { status: 'failed', retcode: 1404, data: null }
      : { status: 'ok', retcode: 0, data: {} }),
  })
  const res = await client.sendPoke('group', 123456, { userId: 1000000001 })
  assert.deepEqual(res, { ok: true, action: 'send_poke', retcode: 0 })
  assert.deepEqual(calls.map((c) => c.action), ['group_poke', 'send_poke'])
  assert.deepEqual(calls[1].params, { user_id: 1000000001, group_id: 123456 })
})
await check('friend_poke status=failed（retcode 其实是 0）也兜底', async () => {
  const { client, calls } = makeClient({
    call: (action) => (action === 'friend_poke'
      ? { status: 'failed', retcode: 0, data: null }
      : { status: 'ok', retcode: 0, data: {} }),
  })
  const res = await client.sendPoke('private', '1000000001', { userId: '1000000001' })
  assert.equal(res.ok, true)
  assert.equal(res.action, 'send_poke')
  assert.deepEqual(calls.map((c) => c.action), ['friend_poke', 'send_poke'])
})
await check('首选抛传输层异常 → 仍兜底，不抛出去', async () => {
  const { client, calls } = makeClient({
    call: (action) => {
      if (action === 'group_poke') throw new Error('WebSocket 未连接')
      return { status: 'ok', retcode: 0, data: {} }
    },
  })
  const res = await client.sendPoke('group', '123456', { userId: '1000000001' })
  assert.equal(res.ok, true)
  assert.equal(res.action, 'send_poke')
  assert.deepEqual(calls.map((c) => c.action), ['group_poke', 'send_poke'])
})
await check('两个 action 都失败 → ok:false + retcode + error，永不抛', async () => {
  const { client } = makeClient({ call: () => ({ status: 'failed', retcode: 1200, data: null }) })
  const res = await client.sendPoke('group', '123456', { userId: '1000000001' })
  assert.equal(res.ok, false)
  assert.equal(res.action, 'send_poke')
  assert.equal(res.retcode, 1200)
  assert.match(res.error, /group_poke/, '错误里应带首选 action 的失败原因')
  assert.match(res.error, /send_poke/)
})
await check('两个都抛异常 → 也返回对象（不 reject）', async () => {
  const { client } = makeClient({ call: () => { throw new Error('断线') } })
  const res = await client.sendPoke('private', '1000000001', { userId: '1000000001' })
  assert.equal(res.ok, false)
  assert.equal(res.retcode, null)
  assert.match(res.error, /断线/)
})
await check('非法 target / userId 直接失败，不发任何 action', async () => {
  const { client, calls } = makeClient()
  const badTarget = await client.sendPoke('group', 'abc', { userId: '1000000001' })
  assert.equal(badTarget.ok, false)
  assert.match(badTarget.error, /group_id/)
  const badUser = await client.sendPoke('group', '123456', { userId: '' })
  assert.equal(badUser.ok, false)
  assert.match(badUser.error, /user_id/)
  const zero = await client.sendPoke('private', '0')
  assert.equal(zero.ok, false)
  assert.equal(calls.length, 0, `不该发出任何调用，实际 ${JSON.stringify(calls)}`)
})
await check('私聊不传 userId 时用 target 当被戳者', async () => {
  const { client, calls } = makeClient()
  const res = await client.sendPoke('private', '1000000001')
  assert.equal(res.ok, true)
  assert.deepEqual(calls[0].params, { user_id: 1000000001 })
})

console.log('\n— nameOf：昵称缓存 —')
await check('群聊作用域命中（群号）', () => {
  const { client } = makeClient()
  client._rememberName('123456', '1000000001', '小明')
  assert.equal(client.nameOf('123456', '1000000001'), '小明')
  assert.equal(client.nameOf('123456', '1000000002'), '', '没聊过的人应返回空串')
})
await check('兼容桥接会话 key：g:<群号> / u:<QQ号>', () => {
  const { client } = makeClient()
  client._rememberName('123456', '1000000001', '小明')
  client._rememberName('u', '1000000001', '小明')
  assert.equal(client.nameOf('g:123456', '1000000001'), '小明', 'g: 前缀应能剥成群号')
  assert.equal(client.nameOf('u:1000000001', '1000000001'), '小明', 'u: 前缀应回落到私聊桶')
})
await check('超 30 分钟没说话 → 当未知（返回空串）', () => {
  const { client } = makeClient()
  client._rememberName('123456', '1000000001', '小明')
  client._atNames.get('123456:1000000001').at = Date.now() - 31 * 60 * 1000
  assert.equal(client.nameOf('123456', '1000000001'), '')
})
await check('参数非法 / 空昵称不留缓存', () => {
  const { client } = makeClient()
  assert.equal(client.nameOf('', '1001'), '')
  assert.equal(client.nameOf('123456', ''), '')
  assert.equal(client.nameOf(undefined, undefined), '')
  client._rememberName('123456', '1001', '   ')
  assert.equal(client.nameOf('123456', '1001'), '', '空昵称不该写进缓存')
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
