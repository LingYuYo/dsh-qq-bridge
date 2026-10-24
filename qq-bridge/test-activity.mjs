/**
 * 单群独立活跃系数 + 人设重复推送修复的离线回归。
 *
 * 覆盖：
 *   ① `normalizeSessionEntry` 对 `activityLevel` 的归一化（null / 0..3 / 脏值）；
 *   ② `shouldRespond` 优先读单群档位、null 回退全局、第三参 key 可选；
 *   ③ `applySessionOp({ op:'activity' })` 的返回契约 + 落盘 + 重启后仍在；
 *   ④ `sessionViews()` 上报行带 `activityLevel`（设置页回填用）；
 *   ⑤ `startConfigPolling` 的 onPersona 契约：返回 ok 后签名推进（不再每 2 秒重推），
 *      返回 undefined（契约违例）只 warn 一次。
 *
 * 不连 QQ、不连 DSH、不碰真实 state（全部临时文件 + 桩客户端）。
 * 运行：node test-activity.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Bridge, normalizeSessionEntry } from './src/bridge.mjs'
import { startConfigPolling, CONFIG_ROUTE_PATH } from './src/runtime-config.mjs'

let pass = 0, fail = 0
/** 同步/异步断言都支持；异步用法必须 `await check(...)`。 */
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 轮询等待条件成立（避免写死 sleep 时长导致偶发红灯）。 */
const waitUntil = async (fn, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(20)
  }
  return fn()
}

/** 造一个只接假 DSH / 假 QQ 的 Bridge（不建真实会话、不读写真实 state）。 */
function makeBridge({ rhythm, stateFile } = {}) {
  const file = stateFile
    ?? path.join(os.tmpdir(), `qq-bridge-activity-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: { private: ['1000000001'], groups: ['123456'], admins: [], allowAllWhenEmpty: false },
      sendDelayMs: 0,
      stateFile: file,
      ...(rhythm ? { rhythm } : {}),
    },
    // 静默 logger：日志不是断言目标（契约违例那条单独注入收集器）。
    logger: { info() {}, warn() {}, error() {} },
  })
  const calls = { prompts: [], sent: [], created: 0, personas: [] }
  b.dsh = {
    sessionExists: async () => true,
    ensureWorkspace: async () => 'w1',
    createSession: async () => `s${++calls.created}`,
    setSessionModel: async () => ({}),
    archiveSession: async () => ({ ok: true }),
    renameSession: async (sid, title) => title,
    setSessionPersona: async (payload) => { calls.personas.push(payload); return { ok: true } },
    promptAndWait: async (sid, text) => { calls.prompts.push({ sid, text }); return '好' },
  }
  // NapCat 侧：取名字的调用一律返回空（退回号码兜底），不联网。
  b.qq.call = async () => ({ status: 'ok', data: {} })
  b.qq.sendPrivate = async (uid, text) => { calls.sent.push({ kind: 'private', uid, text }); return { ok: true } }
  b.qq.sendGroup = async (gid, text) => { calls.sent.push({ kind: 'group', gid, text }); return { ok: true } }
  b.qq._selfId = '999' // 假装登录的是 999，用于 @ 判定
  return { b, calls, stateFile: file }
}

const privMsg = (text, id = 'pm') => ({
  kind: 'private', userId: '1000000001', groupId: null, text, messageId: id,
  raw: { message: [{ type: 'text', data: { text } }] },
})
const groupMsg = (text, { at = false, id = 'gm' } = {}) => ({
  kind: 'group', userId: '1000000001', groupId: '123456', text, messageId: id,
  raw: {
    message: at
      ? [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text } }]
      : [{ type: 'text', data: { text } }],
  },
})

console.log('— state 归一化：activityLevel —')
await check('默认 null（跟随全局）；旧版裸字符串记录也补 null', () => {
  assert.equal(normalizeSessionEntry('g:123456', { sessionId: 's1' }).activityLevel, null)
  assert.equal(normalizeSessionEntry('g:123456', 'session-abc').activityLevel, null)
})
await check('0..3 原样保留，越界夹紧，脏值回退 null', () => {
  assert.equal(normalizeSessionEntry('g:1', { activityLevel: 0 }).activityLevel, 0)
  assert.equal(normalizeSessionEntry('g:1', { activityLevel: 2 }).activityLevel, 2)
  assert.equal(normalizeSessionEntry('g:1', { activityLevel: 3 }).activityLevel, 3)
  assert.equal(normalizeSessionEntry('g:1', { activityLevel: 9 }).activityLevel, 3, '上限夹紧')
  assert.equal(normalizeSessionEntry('g:1', { activityLevel: -1 }).activityLevel, 0, '下限夹紧')
  assert.equal(normalizeSessionEntry('g:1', { activityLevel: 'abc' }).activityLevel, null)
  assert.equal(normalizeSessionEntry('g:1', { activityLevel: '' }).activityLevel, null)
})

console.log('\n— 判定链：单群档位 > 全局 —')
await check('单群 0 档覆盖全局 3 档：不回复（第三参可省略，自动推导 key）', () => {
  const { b } = makeBridge({ rhythm: { activityLevel: 3 } })
  b.state.sessions['g:123456'] = normalizeSessionEntry('g:123456', { activityLevel: 0 })
  const plain = groupMsg('随便聊聊')
  assert.equal(b.shouldRespond(plain, plain.text), false, '缺省 key 时应自行推导出 g:123456')
  assert.equal(b.shouldRespond(plain, plain.text, 'g:123456'), false)
})
await check('单群 3 档覆盖全局 0 档：全回复', () => {
  const { b } = makeBridge({ rhythm: { activityLevel: 0 } })
  b.state.sessions['g:123456'] = normalizeSessionEntry('g:123456', { activityLevel: 3 })
  const plain = groupMsg('随便聊聊')
  assert.equal(b.shouldRespond(plain, plain.text), true)
})
await check('单群 null 回退全局；全局热改后立即跟随', () => {
  const { b } = makeBridge({ rhythm: { activityLevel: 0 } })
  b.state.sessions['g:123456'] = normalizeSessionEntry('g:123456', { activityLevel: null })
  const plain = groupMsg('随便聊聊')
  assert.equal(b.shouldRespond(plain, plain.text), false, 'null → 全局 0 档')
  b.live.rhythm = { ...b.live.rhythm, activityLevel: 3 }
  assert.equal(b.shouldRespond(plain, plain.text), true, '★ 全局热改后 null 群立即跟随')
  assert.equal(b.shouldRespond(plain, plain.text, 'g:654321'), true, '没配过的群也跟随全局')
})
await check('私聊 / @ 不受单群 0 档影响', () => {
  const { b } = makeBridge({ rhythm: { activityLevel: 3 } })
  b.state.sessions['g:123456'] = normalizeSessionEntry('g:123456', { activityLevel: 0 })
  const at = groupMsg('在吗', { at: true })
  assert.equal(b.shouldRespond(at, at.text), true, '@ 必回')
  const p = privMsg('私聊')
  assert.equal(b.shouldRespond(p, p.text), true, '私聊永远回')
})
await check('1/2 档语义仍按单群档位走', () => {
  const { b } = makeBridge({ rhythm: { activityLevel: 3, randomChance: 0.15 } })
  b.state.sessions['g:123456'] = normalizeSessionEntry('g:123456', { activityLevel: 1 })
  assert.equal(b.shouldRespond(groupMsg('dsh 在吗'), 'dsh 在吗'), true, '1 档：关键词回')
  assert.equal(b.shouldRespond(groupMsg('今天天气不错'), '今天天气不错'), false, '1 档：普通不回')
  b.state.sessions['g:123456'] = normalizeSessionEntry('g:123456', { activityLevel: 2 })
  b._random = () => 0.01
  assert.equal(b.shouldRespond(groupMsg('今天天气不错'), '今天天气不错'), true, '2 档：概率内回')
  b._random = () => 0.99
  assert.equal(b.shouldRespond(groupMsg('今天天气不错'), '今天天气不错'), false, '2 档：概率外不回')
})

console.log('\n— 会话指令 op:activity —')
await check('返回契约 + 写入 state（key 还没有会话也能写）', async () => {
  const { b, stateFile } = makeBridge({ rhythm: { activityLevel: 1 } })
  assert.equal(b.state.sessions['g:123456'], undefined)
  const r = await b.applySessionOp({ op: 'activity', key: 'g:123456', level: 2 })
  assert.deepEqual(r, { ok: true, action: 'activity', key: 'g:123456', activityLevel: 2 })
  assert.equal(b.state.sessions['g:123456'].activityLevel, 2)
  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(onDisk.sessions['g:123456'].activityLevel, 2, '★ 必须落盘，不能只在内存')
})
await check('level=null：回退跟随全局并落盘', async () => {
  const { b, stateFile } = makeBridge()
  await b.applySessionOp({ op: 'activity', key: 'g:123456', level: 3 })
  const r = await b.applySessionOp({ op: 'activity', key: 'g:123456', level: null })
  assert.equal(r.ok, true)
  assert.equal(r.activityLevel, null)
  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(onDisk.sessions['g:123456'].activityLevel, null)
  assert.equal(b._activityLevelFor('g:123456'), b._rhythm().activityLevel, '应回退全局')
})
await check('非法 level：拒绝（bad-level）且不覆盖已存值', async () => {
  const { b } = makeBridge()
  await b.applySessionOp({ op: 'activity', key: 'g:123456', level: 1 })
  const r = await b.applySessionOp({ op: 'activity', key: 'g:123456', level: 'abc' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'bad-level')
  assert.equal(b.state.sessions['g:123456'].activityLevel, 1, '不能被脏值覆盖')
})
await check('重启（重新 load state）后设置还在，判定仍按该档位', async () => {
  const { b, stateFile } = makeBridge()
  await b.applySessionOp({ op: 'activity', key: 'g:123456', level: 0 })
  // 这条记录既没有 sessionId 也没有未读：仍必须保留，否则重启就丢配置。
  const reborn = makeBridge({ stateFile }).b
  assert.equal(reborn.state.sessions['g:123456']?.activityLevel, 0)
  assert.equal(reborn.shouldRespond(groupMsg('随便聊聊'), '随便聊聊'), false, '重启后仍按 0 档判定')
})

console.log('\n— 设置页数据 —')
await check('sessionViews 上报行带 activityLevel（没配是 null，不是 undefined）', async () => {
  const { b } = makeBridge()
  b.state.sessions['g:123456'] = normalizeSessionEntry('g:123456', { sessionId: 's1', lastAt: 1, activityLevel: 2 })
  b.state.sessions['u:1000000001'] = normalizeSessionEntry('u:1000000001', { sessionId: 's2', lastAt: 2 })
  const rows = b.sessionViews()
  assert.equal(rows[0].key, 'u:1000000001')
  assert.equal(rows[0].activityLevel, null)
  assert.equal(rows[1].activityLevel, 2)
})

console.log('\n— 判定链（handleMessage 端到端）—')
await check('单群 0 档：不回复也不建会话；改回 null 后下一句立即回', async () => {
  const { b, calls } = makeBridge({ rhythm: { activityLevel: 3, debounceWindowMs: 0 } })
  await b.applySessionOp({ op: 'activity', key: 'g:123456', level: 0 })
  await b.handleMessage(groupMsg('随便聊聊', { id: 'h1' }))
  assert.equal(calls.prompts.length, 0, '单群 0 档不该回')
  assert.equal(calls.created, 0, '★ 判否时绝不建会话')
  await b.applySessionOp({ op: 'activity', key: 'g:123456', level: null })
  await b.handleMessage(groupMsg('随便聊聊', { id: 'h2' }))
  assert.equal(calls.prompts.length, 1, '★ 改回跟随全局（3 档）后下一句立即回')
})
await check('全局 0 档 + 单群 3 档：照常回复', async () => {
  const { b, calls } = makeBridge({ rhythm: { activityLevel: 0, debounceWindowMs: 0 } })
  await b.applySessionOp({ op: 'activity', key: 'g:123456', level: 3 })
  await b.handleMessage(groupMsg('随便聊聊', { id: 'h3' }))
  assert.equal(calls.prompts.length, 1)
})

console.log('\n— 人设推送：onPersona 契约（README【待修复 2】）—')

/**
 * 起一个只回 /config 的桩 HTTP 服务，返回 { url, setPayload, close }。
 * @param {object} initial
 */
async function startConfigStub(initial) {
  let payload = { ...initial }
  const srv = http.createServer((req, res) => {
    if (req.url !== CONFIG_ROUTE_PATH) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, config: payload }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    setPayload: (next) => { payload = { ...payload, ...next } },
    close: () => srv.close(),
  }
}

await check('onPersona 返回 { ok, action, detail }（异步）→ 签名推进，不再每 2 秒重推', async () => {
  const stub = await startConfigStub({ personaBotName: '小鱼', personaParticipation: 'normal' })
  let personaCalls = 0
  let syncs = 0
  const stop = startConfigPolling({
    baseUrl: stub.url,
    liveConfig: {},
    pollMs: 40,
    timeoutMs: 1000,
    logger: { info() {}, warn() {}, error() {} },
    onSync: () => { syncs++ },
    // 模拟 start.mjs 的异步推送：必须返回 { ok, action, detail }
    onPersona: async () => {
      personaCalls++
      return { ok: true, action: 'pushed', detail: '12 字' }
    },
  })
  try {
    assert.ok(await waitUntil(() => syncs > 0, 3000), '首次同步应成功（只记录，不推人设）')
    assert.equal(personaCalls, 0, '首次同步不该推人设')
    stub.setPayload({ personaParticipation: 'quiet' })
    assert.ok(await waitUntil(() => personaCalls > 0, 3000), '人设变化应触发一次推送')
    await sleep(240) // 约 6 个轮询周期
    assert.equal(personaCalls, 1, `签名没推进的话会每 2 秒重推，实际推了 ${personaCalls} 次`)
  } finally { stop(); stub.close() }
})

await check('onPersona 返回 undefined（契约违例）→ 只 warn 一次，也不无限重推', async () => {
  const stub = await startConfigStub({ personaBotName: '小鱼', personaParticipation: 'normal' })
  const warns = []
  let personaCalls = 0
  let syncs = 0
  const stop = startConfigPolling({
    baseUrl: stub.url,
    liveConfig: {},
    pollMs: 40,
    timeoutMs: 1000,
    logger: { info() {}, warn: (m) => warns.push(m), error() {} },
    onSync: () => { syncs++ },
    // 旧实现的写法：忘了 return（这就是每 2 秒重推的根因）
    onPersona: () => { personaCalls++ },
  })
  try {
    assert.ok(await waitUntil(() => syncs > 0, 3000))
    stub.setPayload({ personaParticipation: 'quiet' })
    assert.ok(await waitUntil(() => personaCalls > 0, 3000))
    await sleep(240)
    assert.equal(personaCalls, 1, `契约违例也不该每 2 秒重推，实际 ${personaCalls} 次`)
    assert.equal(warns.filter((m) => String(m).includes('契约')).length, 1, `warn 应只出现一次：${warns.join(' | ')}`)
  } finally { stop(); stub.close() }
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
