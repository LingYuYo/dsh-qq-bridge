/**
 * 戳一戳（notice / poke）回归（离线，不连 QQ / 不碰真实 DSH）。
 *
 * 锁死 2026-10-26 的约定（规格 §5.3）：
 *   ① `Bridge.start()` 用 `qq.onNotice(...)` 注册处理器；
 *   ② 只认 `kind === 'poke'`，被戳者必须是**机器人自己**，自己戳自己忽略；
 *   ③ 白名单按群号 / QQ 号走 isAllowed，名单外不回复；
 *   ④ 同一会话 3 秒内最多回一次（节流）；
 *   ⑤ `poke.enabled === false` 完全忽略；
 *   ⑥ `mode: 'poke'` → `qq.sendPoke(kind, target, { userId })`，失败只 warn 不抛；
 *   ⑦ `mode: 'text'` → `_send` 模板，`{nick}` 用 qq.nameOf（取不到退回 QQ 号）、`{qq}`。
 *
 * 运行：node test-poke.mjs
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { Bridge } from './src/bridge.mjs'

let pass = 0
let fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

function makeBridge({ poke, allow, nameOf } = {}) {
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: {
        private: ['1000000001'], groups: ['123456'], admins: [],
        allowAllWhenEmpty: false, ...(allow ?? {}),
      },
      sendDelayMs: 0,
      stateFile: path.join(os.tmpdir(), `qq-poke-state-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
      rhythm: { activityLevel: 3, debounceWindowMs: 0 },
      // 关掉随机延迟（2026-10-27 新增）：这些用例测的是判定与下发，不该每条等 200~500ms。
      poke: { delayMinMs: 0, delayMaxMs: 0, ...(poke ?? {}) },
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  const calls = { pokes: [], sent: [], warns: [], registered: 0 }
  b.dsh = {
    sessionExists: async () => true,
    ensureWorkspace: async () => 'w1',
    createSession: async () => 's1',
    setSessionModel: async () => ({}),
    archiveSession: async () => ({ ok: true }),
    renameSession: async (sid, title) => title,
    sessionTitle: async () => null,
    setSessionPersona: async () => ({ ok: true }),
    promptAndWait: async () => '好',
    call: async () => ({}),
  }
  b.logger = {
    info() {},
    warn: (m) => calls.warns.push(String(m)),
    error() {},
  }
  b.qq.call = async () => ({ status: 'ok', data: {} })
  b.qq.sendPrivate = async (uid, text) => { calls.sent.push({ kind: 'private', uid, text }); return { ok: true } }
  b.qq.sendGroup = async (gid, text) => { calls.sent.push({ kind: 'group', gid, text }); return { ok: true } }
  b.qq.sendPoke = async (kind, target, opts) => {
    calls.pokes.push({ kind, target, opts })
    return calls.pokeResult ?? { ok: true, action: kind === 'group' ? 'group_poke' : 'friend_poke', retcode: 0 }
  }
  b.qq.nameOf = (scopeKey, qq) => (typeof nameOf === 'function' ? nameOf(scopeKey, qq) : String(nameOf ?? ''))
  const register = b.qq.onNotice.bind(b.qq)
  b.qq.onNotice = (handler) => { calls.registered++; return register(handler) }
  b.qq.start = async () => {}
  b.qq._selfId = '999'
  return { b, calls }
}

const pokeNotice = ({ userId = '1000000001', targetId = '999', groupId = '123456', kind = 'poke' } = {}) => ({
  kind, userId, targetId, groupId, selfId: '999', time: 1, raw: {},
})

console.log('戳一戳：')

await check('start() 注册 onNotice；notice 进来后确实走到 handleNotice', async () => {
  const { b, calls } = makeBridge()
  await b.start()
  assert.equal(calls.registered, 1, 'start 必须调 qq.onNotice 注册一次')
  // 通过真实分发路径触发：真实 OneBotClient 的 _noticeHandlers 已被注册。
  b.qq._noticeHandlers?.forEach((handler) => handler(pokeNotice()))
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(calls.pokes.length, 1, `应回戳一次，实际 ${calls.pokes.length}`)
  await b.stop()
})

await check('群聊被戳机器人 → 回戳 group_poke（kind/target/userId 正确）', async () => {
  const { b, calls } = makeBridge()
  await b.handleNotice(pokeNotice())
  assert.deepEqual(calls.pokes, [{ kind: 'group', target: '123456', opts: { userId: '1000000001' } }])
  assert.equal(calls.sent.length, 0, '回戳模式不该发文字')
})

await check('私聊被戳 → 回戳给那个 QQ 号', async () => {
  const { b, calls } = makeBridge()
  await b.handleNotice(pokeNotice({ groupId: null }))
  assert.deepEqual(calls.pokes, [{ kind: 'private', target: '1000000001', opts: { userId: '1000000001' } }])
})

await check('被戳者不是机器人自己 → 忽略', async () => {
  const { b, calls } = makeBridge()
  await b.handleNotice(pokeNotice({ targetId: '1234567890' }))
  assert.equal(calls.pokes.length, 0)
  assert.equal(calls.sent.length, 0)
})

await check('自己戳自己 → 忽略', async () => {
  const { b, calls } = makeBridge()
  await b.handleNotice(pokeNotice({ userId: '999' }))
  assert.equal(calls.pokes.length, 0)
})

await check('非 poke notice（进群/撤回等）→ 忽略', async () => {
  const { b, calls } = makeBridge()
  await b.handleNotice(pokeNotice({ kind: 'group_increase' }))
  await b.handleNotice(null)
  await b.handleNotice({})
  assert.equal(calls.pokes.length, 0)
})

await check('白名单外的群 / 人 → 不回复', async () => {
  const { b, calls } = makeBridge()
  await b.handleNotice(pokeNotice({ groupId: '999999' }))
  await b.handleNotice(pokeNotice({ groupId: null, userId: '3000000003' }))
  assert.equal(calls.pokes.length, 0)
  assert.equal(calls.sent.length, 0)
})

await check('poke.enabled === false → 完全忽略', async () => {
  const { b, calls } = makeBridge({ poke: { enabled: false } })
  await b.handleNotice(pokeNotice())
  assert.equal(calls.pokes.length, 0)
  assert.equal(calls.sent.length, 0)
})

await check('3 秒节流：同一会话连戳只回一次；过了窗口又能回', async () => {
  const { b, calls } = makeBridge()
  await b.handleNotice(pokeNotice())
  await b.handleNotice(pokeNotice())
  assert.equal(calls.pokes.length, 1, '3 秒内只该回一次')
  // 把上次回戳时间拨到 5 秒前，模拟「过了一会儿又戳」。
  b._pokeAt.set('g:123456', Date.now() - 5000)
  await b.handleNotice(pokeNotice())
  assert.equal(calls.pokes.length, 2, '过了节流窗口应再回一次')
})

await check('节流按会话隔离：另一个群不受影响', async () => {
  const { b, calls } = makeBridge({ allow: { groups: ['123456', '654321'] } })
  await b.handleNotice(pokeNotice())
  await b.handleNotice(pokeNotice({ groupId: '654321' }))
  assert.equal(calls.pokes.length, 2, '不同群各自独立节流')
})

await check('mode=text → 发模板，{nick}/{qq} 都被替换', async () => {
  const { b, calls } = makeBridge({
    poke: { mode: 'text', replyText: '{nick}（{qq}）戳我干嘛' },
    nameOf: '小明',
  })
  await b.handleNotice(pokeNotice())
  assert.equal(calls.pokes.length, 0, '文字模式不该回戳')
  assert.deepEqual(calls.sent, [{ kind: 'group', gid: '123456', text: '小明（1000000001）戳我干嘛' }])
})

await check('mode=text 取不到昵称 → 用 QQ 号兜底', async () => {
  const { b, calls } = makeBridge({ poke: { mode: 'text' }, nameOf: '' })
  await b.handleNotice(pokeNotice())
  // 默认模板是「（被戳了一下，戳回去）」，没有占位符也要能正常发。
  assert.deepEqual(calls.sent, [{ kind: 'group', gid: '123456', text: '（被戳了一下，戳回去）' }])
})

await check('mode=text 私聊也走同一个模板', async () => {
  const { b, calls } = makeBridge({
    poke: { mode: 'text', replyText: '别戳了 {qq}' },
    nameOf: '',
  })
  await b.handleNotice(pokeNotice({ groupId: null }))
  assert.deepEqual(calls.sent, [{ kind: 'private', uid: '1000000001', text: '别戳了 1000000001' }])
})

await check('回戳失败只 warn，不抛也不影响后续', async () => {
  const { b, calls } = makeBridge()
  calls.pokeResult = { ok: false, action: 'group_poke', retcode: -1, error: 'group_poke: retcode=-1' }
  await b.handleNotice(pokeNotice())   // 不该抛
  assert.equal(calls.pokes.length, 1)
  assert.ok(calls.warns.some((line) => line.includes('回戳失败')), `应有 warn：${JSON.stringify(calls.warns)}`)
})

await check('stop() 清掉每小时归纳定时器', async () => {
  const { b } = makeBridge()
  await b.start()
  assert.ok(b._summarizeTimer, 'start 应建 1 小时归纳定时器')
  await b.stop()
  assert.equal(b._summarizeTimer, null, 'stop 必须清掉定时器')
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
