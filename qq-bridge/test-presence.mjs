/**
 * 常驻感知 tick / 主动行为引擎的离线用例。
 *
 *   node test-presence.mjs
 *
 * 全离线：不连 QQ、不调模型、不发消息。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PresenceEngine, blankGroupState, evaluatePresence, applyInbound, applySilent,
  applySpeak, applyTimeout, localDate, normalizeProactive, DEFAULT_PROACTIVE,
} from './src/presence.mjs'

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

const MIN = 60_000
const HOUR = 60 * MIN
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-presence-'))
const conf = (extra = {}) => normalizeProactive({ enabled: true, ...extra })

/** 构造一个「全都过闸门」的感知快照。 */
const goodSense = (now, extra = {}) => ({
  key: 'g:934037176',
  silenceMs: 45 * MIN,
  todayInbound: 40,
  unread: 0,
  taskNearMs: null,
  recentCount: 6,
  lastIsQuestion: true,
  presence: blankGroupState(now),
  ...extra,
})

console.log('— 配置收敛 —')
await check('非法值回落默认；tick 限制在 10~30 秒；默认关闭', () => {
  const base = normalizeProactive({})
  assert.equal(base.enabled, false, '默认必须关闭')
  assert.deepEqual(base.groups, [])
  assert.equal(normalizeProactive({ tickMs: 1000 }).tickMs, 10_000, 'tick 下限 10 秒')
  assert.equal(normalizeProactive({ tickMs: 99999 }).tickMs, 30_000, 'tick 上限 30 秒')
  assert.equal(normalizeProactive({ hourlyLimit: 0 }).hourlyLimit, 1)
  assert.deepEqual(normalizeProactive({ groups: ['g:1', 'bad', 'g:1'] }).groups, ['g:1'])
  assert.equal(DEFAULT_PROACTIVE.dayStartHour, 9)
  assert.equal(DEFAULT_PROACTIVE.dayEndHour, 23)
})

console.log('\n— 闸门（每条都要能单独否掉）—')
const gateAt = new Date(2026, 10, 1, 14, 0, 0).getTime()  // 本地 14:00
await check('关闭状态不是闸门：规则照样跑，交给 dry-run 分支', () => {
  const result = evaluatePresence(goodSense(gateAt), normalizeProactive({}), gateAt)
  assert.equal(result.verdict, 'evaluate', '关闭时仍要评估，才能写 dry-run 日志')
  assert.ok(!/未开启/u.test(result.reason))
})

await check('私聊不参与；休眠不参与', () => {
  const off = evaluatePresence(goodSense(gateAt, { key: 'u:1' }), conf(), gateAt)
  assert.equal(off.verdict, 'skip')
  assert.match(off.reason, /只对群聊/u)
  const asleep = evaluatePresence(goodSense(gateAt, { mutedUntil: gateAt + HOUR }), conf(), gateAt)
  assert.equal(asleep.verdict, 'skip')
  assert.match(asleep.reason, /休眠/u)
})

await check('冷却中 / 本小时超限', () => {
  const cooling = { ...blankGroupState(gateAt), status: 'cooling', coolUntil: gateAt + HOUR / 2 }
  const one = evaluatePresence(goodSense(gateAt, { presence: cooling }), conf(), gateAt)
  assert.equal(one.verdict, 'skip')
  assert.match(one.reason, /冷却/u)

  const busy = { ...blankGroupState(gateAt), speakStamps: [gateAt - 10 * MIN, gateAt - 40 * MIN] }
  const two = evaluatePresence(goodSense(gateAt, { presence: busy }), conf(), gateAt)
  assert.equal(two.verdict, 'skip')
  assert.match(two.reason, /达到上限 2/u)
})

await check('评估节流 / 非白天 / 安静时长越界', () => {
  const recent = { ...blankGroupState(gateAt), lastEvalAt: gateAt - 5 * MIN }
  assert.match(evaluatePresence(goodSense(gateAt, { presence: recent }), conf(), gateAt).reason, /不足 30 分钟/u)

  const night = new Date(2026, 10, 1, 23, 30, 0).getTime()
  assert.match(evaluatePresence(goodSense(night), conf(), night).reason, /不在白天窗口/u)

  const quiet = evaluatePresence(goodSense(gateAt, { silenceMs: 5 * MIN }), conf(), gateAt)
  assert.match(quiet.reason, /不在 30~120/u)
  const dead = evaluatePresence(goodSense(gateAt, { silenceMs: 600 * MIN }), conf(), gateAt)
  assert.match(dead.reason, /不在 30~120/u)
})

await check('群不活跃 / 有未读 / 定时任务临近', () => {
  assert.match(evaluatePresence(goodSense(gateAt, { todayInbound: 3 }), conf(), gateAt).reason, /不活跃/u)
  assert.match(evaluatePresence(goodSense(gateAt, { unread: 5 }), conf(), gateAt).reason, /未读消息/u)
  assert.match(evaluatePresence(goodSense(gateAt, { taskNearMs: 5 * MIN }), conf(), gateAt).reason, /定时任务/u)
  assert.equal(evaluatePresence(goodSense(gateAt), conf(), gateAt).verdict, 'evaluate', '全过时应该评估')
})

console.log('\n— 打分 —')
await check('安静甜区 + 有人说话 + 最后是问句 → 过阈值', () => {
  const result = evaluatePresence(goodSense(gateAt), conf(), gateAt)
  assert.equal(result.verdict, 'evaluate')
  assert.equal(result.score, 7, `3+2+2=7，实际 ${result.score}`)
  assert.match(result.reason, /安静 30~120 分钟/u)
})

await check('最后一条是自己发的 → 扣分到阈值以下', () => {
  const result = evaluatePresence(goodSense(gateAt, { lastIsMine: true }), conf(), gateAt)
  assert.equal(result.score, 5, `7-2=5，实际 ${result.score}`)
  assert.equal(result.verdict, 'evaluate', '刚好到阈值仍算通过')
  const weak = evaluatePresence(goodSense(gateAt, { lastIsMine: true, lastIsQuestion: false }), conf(), gateAt)
  assert.equal(weak.verdict, 'skip', `3+2-2=3 应跳过，实际 ${weak.score}`)
})

await check('阈值可配：调高后同样的快照被跳过', () => {
  const strict = conf({ scoreThreshold: 8 })
  assert.equal(evaluatePresence(goodSense(gateAt), strict, gateAt).verdict, 'skip')
})

console.log('\n— 状态机 —')
await check('说话 → 记账 + 进入等待接茬', () => {
  const state = applySpeak(blankGroupState(gateAt), gateAt)
  assert.deepEqual(state.speakStamps, [gateAt])
  assert.equal(state.waitingSince, gateAt)
  assert.equal(state.lastEvalAt, gateAt)
})

await check('沉默 → 只更新评估时间，不占发言额度', () => {
  const state = applySilent(blankGroupState(gateAt), gateAt)
  assert.deepEqual(state.speakStamps, [])
  assert.equal(state.waitingSince, 0)
  assert.equal(state.lastEvalAt, gateAt)
})

await check('接茬：人类说话清空等待与连击，机器人自己发不算', () => {
  const spoken = applySpeak(blankGroupState(gateAt), gateAt)
  const byBot = applyInbound(spoken, true, gateAt + MIN)
  assert.equal(byBot.waitingSince, gateAt, '★ 机器人自己发的话不能算接茬，等待期要保留')
  assert.equal(byBot.ignoredStreak, 0)

  const waiting = { ...blankGroupState(gateAt), waitingSince: gateAt, ignoredStreak: 1 }
  const byHuman = applyInbound(waiting, false, gateAt + MIN)
  assert.equal(byHuman.waitingSince, 0)
  assert.equal(byHuman.ignoredStreak, 0, '有人接茬要清空连击')
})

await check('连续两次无人接茬 → 冷却 4 小时；到点自动恢复', () => {
  let state = { ...blankGroupState(gateAt), waitingSince: gateAt, ignoredStreak: 1 }
  // 第一次超时：ignoredStreak 1 → 2 → 直接冷却
  state = applyTimeout(state, conf(), gateAt + 11 * MIN)
  assert.equal(state.status, 'cooling')
  assert.equal(state.coolUntil, gateAt + 11 * MIN + 4 * HOUR)
  assert.equal(state.ignoredStreak, 0, '进冷却后连击归零')

  state = applyTimeout(state, conf(), state.coolUntil + MIN)
  assert.equal(state.status, 'ready')
  assert.equal(state.coolUntil, 0)
})

await check('单次未接茬只累计，不冷却', () => {
  const state = applyTimeout({ ...blankGroupState(gateAt), waitingSince: gateAt }, conf(), gateAt + 11 * MIN)
  assert.equal(state.status, 'ready')
  assert.equal(state.ignoredStreak, 1)
})

await check('跨天重置入站计数', () => {
  const yesterday = { ...blankGroupState(gateAt - 24 * HOUR), today: { date: '2026-10-31', inbound: 99 } }
  const next = applyInbound(yesterday, false, gateAt)
  assert.equal(next.today.date, localDate(gateAt))
  assert.equal(next.today.inbound, 1, '换天要从 0 重新数')
})

console.log('\n— 引擎（tick 循环）—')
await check('dry-run：闸门通过只记决策，不调模型、不发消息', async () => {
  const dir = tmpDir()
  const now = gateAt
  let decided = 0, sent = 0
  const engine = new PresenceEngine({
    dir,
    getConfig: () => normalizeProactive({ enabled: false }),
    sense: async () => [goodSense(now)],
    decide: async () => { decided += 1; return { speak: true, text: '在吗' } },
    send: async () => { sent += 1; return true },
    now: () => now,
  }).load()
  await engine.tick()
  assert.equal(decided, 0, '★ dry-run 不能调模型')
  assert.equal(sent, 0)
  const last = engine.view().decisions.at(-1)
  assert.equal(last.verdict, 'dry-run')
  assert.match(last.reason, /dry-run/u)
  fs.rmSync(dir, { recursive: true, force: true })
})

await check('enabled：模型说 → 发送 + 记账；模型闭嘴 → 只记 silent', async () => {
  const dir = tmpDir()
  const now = gateAt
  const sentKeys = []
  const engine = new PresenceEngine({
    dir,
    getConfig: () => conf(),
    sense: async () => [goodSense(now)],
    decide: async () => ({ speak: true, text: '有人吗' }),
    send: async (key) => { sentKeys.push(key); return true },
    now: () => now,
  }).load()
  await engine.tick()
  assert.deepEqual(sentKeys, ['g:934037176'])
  assert.equal(engine.groupOf('g:934037176').waitingSince, now)
  assert.equal(engine.view().decisions.at(-1).verdict, 'speak')

  // 第二 tick：还在等待接茬 + 评估节流会拦住，这里直接换一个群验证「模型闭嘴」分支。
  const engine2 = new PresenceEngine({
    dir: tmpDir(),
    getConfig: () => conf(),
    sense: async () => [goodSense(now, { key: 'g:2' })],
    decide: async () => ({ speak: false }),
    send: async () => true,
    now: () => now,
  }).load()
  await engine2.tick()
  assert.equal(engine2.view().decisions.at(-1).verdict, 'silent')
  assert.deepEqual(engine2.groupOf('g:2').speakStamps, [], '闭嘴不该占额度')
  fs.rmSync(dir, { recursive: true, force: true })
})

await check('每 tick 只评估一个群（取最高分）', async () => {
  const dir = tmpDir()
  const now = gateAt
  const evaluated = []
  const engine = new PresenceEngine({
    dir,
    getConfig: () => conf(),
    sense: async () => [
      goodSense(now, { key: 'g:1' }),
      goodSense(now, { key: 'g:2', recentCount: 0, lastIsQuestion: false }),
    ],
    decide: async (sense) => { evaluated.push(sense.key); return { speak: false } },
    send: async () => true,
    now: () => now,
  }).load()
  await engine.tick()
  assert.deepEqual(evaluated, ['g:1'], '高分群优先，且只评一个')
  fs.rmSync(dir, { recursive: true, force: true })
})

await check('发送失败不占发言额度，并记 send-failed', async () => {
  const dir = tmpDir()
  const now = gateAt
  const engine = new PresenceEngine({
    dir,
    getConfig: () => conf(),
    sense: async () => [goodSense(now)],
    decide: async () => ({ speak: true, text: '在吗' }),
    send: async () => false,
    now: () => now,
  }).load()
  await engine.tick()
  assert.equal(engine.view().decisions.at(-1).verdict, 'send-failed')
  assert.deepEqual(engine.groupOf('g:934037176').speakStamps, [])
  fs.rmSync(dir, { recursive: true, force: true })
})

await check('状态落盘 / 重载；损坏文件重置', async () => {
  const dir = tmpDir()
  const now = gateAt
  const engine = new PresenceEngine({
    dir, getConfig: () => conf(), sense: async () => [],
    now: () => now,
  }).load()
  engine.groupOf('g:1')
  engine.groups.set('g:1', applySpeak(blankGroupState(now), now))
  engine.noteDecision({ key: 'g:1', verdict: 'speak', reason: 'x', score: 7 })
  engine.save()

  const reloaded = new PresenceEngine({ dir, getConfig: () => conf(), now: () => now }).load()
  assert.equal(reloaded.groupOf('g:1').speakStamps.length, 1)
  assert.equal(reloaded.view().decisions.length, 1)

  fs.writeFileSync(path.join(dir, 'presence.json'), '{ 坏了')
  const broken = new PresenceEngine({ dir, getConfig: () => conf(), now: () => now, logger: { warn() {} } })
  broken.load()
  assert.equal(broken.groupOf('g:1').status, 'ready')
  fs.rmSync(dir, { recursive: true, force: true })
})

await check('tick 抛异常不影响后续（不中断定时器）', async () => {
  const dir = tmpDir()
  const warnings = []
  const engine = new PresenceEngine({
    dir,
    getConfig: () => conf(),
    sense: async () => { throw new Error('sense boom') },
    now: () => gateAt,
    logger: { warn: (message) => warnings.push(message) },
  }).load()
  await engine.tick()
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /sense boom/u)
  assert.equal(engine._ticking, false, '异常后必须解锁，否则再也不会跑')
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
