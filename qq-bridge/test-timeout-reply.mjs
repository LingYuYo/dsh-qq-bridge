/**
 * 超时自定义回复回归（离线，不连 QQ / 不碰真实 DSH）。
 *
 * 锁死 2026-10-26 的约定（规格 §5.2）：
 *   ① 超时类错误（code==='TIMEOUT'，或消息含 WATCHDOG_TIMEOUT / watchdog / 超时 /
 *      timeout / aborted）→ 发 `timeoutReplyText`；
 *   ② 其它错误仍用原中文提示「（这次处理出错了，稍后再试）」；
 *   ③ `timeoutReplyText` 优先级：live（设置页热配置）→ config.json → 默认
 *      「（模型脑子卡住了，稍后再试）」；trim 后为空也按默认处理；
 *   ④ DSH 的英文报错**任何情况下都不出现在发往 QQ 的正文里**。
 *
 * 运行：node test-timeout-reply.mjs
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

const DEFAULT_TEXT = '（模型脑子卡住了，稍后再试）'
const OTHER_TEXT = '（这次处理出错了，稍后再试）'

/** 造 Bridge：dsh.promptAndWait 按 `thrower` 抛错，记录实际发出去的 QQ 文本。 */
function makeBridge({ thrower, timeoutReplyText, configTimeoutReplyText } = {}) {
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: { private: ['1000000001'], groups: [], admins: [], allowAllWhenEmpty: false },
      sendDelayMs: 0,
      stateFile: path.join(os.tmpdir(), `qq-timeout-state-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
      rhythm: { activityLevel: 3, debounceWindowMs: 0 },
      ...(configTimeoutReplyText === undefined ? {} : { timeoutReplyText: configTimeoutReplyText }),
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  const calls = { sent: [] }
  b.dsh = {
    sessionExists: async () => true,
    ensureWorkspace: async () => 'w1',
    createSession: async () => 's1',
    setSessionModel: async () => ({}),
    archiveSession: async () => ({ ok: true }),
    renameSession: async (sid, title) => title,
    sessionTitle: async () => null,
    setSessionPersona: async () => ({ ok: true }),
    promptAndWait: async () => { throw (typeof thrower === 'function' ? thrower() : thrower) },
  }
  b.qq.call = async () => ({ status: 'ok', data: {} })
  b.qq.sendPrivate = async (uid, text) => { calls.sent.push({ kind: 'private', uid, text }); return { ok: true } }
  b.qq.sendGroup = async (gid, text) => { calls.sent.push({ kind: 'group', gid, text }); return { ok: true } }
  if (timeoutReplyText !== undefined) b.live.timeoutReplyText = timeoutReplyText
  return { b, calls }
}

const privMsg = (text = '在吗', id = 'pm') => ({
  kind: 'private', userId: '1000000001', groupId: null, text, messageId: id,
  raw: { message: [{ type: 'text', data: { text } }] },
})

/** 跑一轮并返回实际发到 QQ 的文本。 */
async function sentText(opts) {
  const { b, calls } = makeBridge(opts)
  await b.handleMessage(privMsg())
  assert.equal(calls.sent.length, 1, `应发出 1 条提示，实际 ${calls.sent.length}`)
  return calls.sent[0].text
}

const timeoutError = () => {
  const error = new Error('等待回复超时（20s）')
  error.code = 'TIMEOUT'
  return error
}

console.log('超时自定义回复：')

await check('code=TIMEOUT → 默认文案「（模型脑子卡住了，稍后再试）」', async () => {
  assert.equal(await sentText({ thrower: timeoutError }), DEFAULT_TEXT)
})

await check('WATCHDOG_TIMEOUT（Host 看门狗切断）→ 同一句默认文案', async () => {
  assert.equal(await sentText({ thrower: () => new Error('WATCHDOG_TIMEOUT: model silent for 8000ms') }), DEFAULT_TEXT)
})

await check('消息里带 aborted / 超时 / timeout 也算超时类', async () => {
  assert.equal(await sentText({ thrower: () => new Error('request aborted') }), DEFAULT_TEXT)
  assert.equal(await sentText({ thrower: () => new Error('等待超时') }), DEFAULT_TEXT)
  assert.equal(await sentText({ thrower: () => new Error('LLM timeout after 60s') }), DEFAULT_TEXT)
})

await check('普通错误仍用原中文提示（不被超时文案吃掉）', async () => {
  assert.equal(await sentText({ thrower: () => new Error('ECONNREFUSED 127.0.0.1:1') }), OTHER_TEXT)
})

await check('live.timeoutReplyText（设置页热配置）优先', async () => {
  assert.equal(await sentText({ thrower: timeoutError, timeoutReplyText: '（卡住了，等我缓一下）' }), '（卡住了，等我缓一下）')
})

await check('live 为空串 → 落到 config.json 的 timeoutReplyText', async () => {
  assert.equal(
    await sentText({ thrower: timeoutError, timeoutReplyText: '', configTimeoutReplyText: '（配置文件里的文案）' }),
    '（配置文件里的文案）',
  )
})

await check('live/config 都是纯空白 → 仍用默认文案（不发空消息）', async () => {
  assert.equal(
    await sentText({ thrower: timeoutError, timeoutReplyText: '   ', configTimeoutReplyText: '\t' }),
    DEFAULT_TEXT,
  )
})

await check('英文报错绝不外泄：发出去的都是中文固定文案', async () => {
  const cases = [
    new Error('WATCHDOG_TIMEOUT: provider=raccoon model=sn-deepseek upstream error 500 Internal Server Error'),
    new Error('session/prompt 失败: gateway/input-invalid invalid prompt content'),
  ]
  for (const error of cases) {
    const text = await sentText({ thrower: () => error })
    assert.equal(text.includes('WATCHDOG'), false, `不该外泄英文：${text}`)
    assert.equal(text.includes('Error'), false, `不该外泄英文：${text}`)
    assert.equal(text.includes('gateway'), false, `不该外泄英文：${text}`)
    assert.equal(text.includes('provider'), false, `不该外泄英文：${text}`)
  }
})

await check('出错回的提示也算「回应过」：未读清零', async () => {
  const { b, calls } = makeBridge({ thrower: timeoutError })
  await b.handleMessage(privMsg())
  assert.equal(calls.sent.length, 1)
  assert.equal(b.state.sessions['u:1000000001'].unread, 0)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
