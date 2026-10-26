/**
 * 人设锁定 / 动态人设 / 每小时归纳 回归（离线，不连 QQ / 不碰真实 DSH）。
 *
 * 锁死 2026-10-26 的约定（规格 §5.4 / §5.5）：
 *   ① `sessions.json` 每条会话新增可选字段 `personaDelta`（老记录缺失 = ''，超 4000 字截掉最旧）；
 *   ② `_applyPersona` 合成：base（entry.persona → 全局 → buildPersonaPrompt）在前，
 *      `【本群动态设定…】` 段 + delta 在后；签名必须含 delta（否则缓存导致不重推）；
 *   ③ 群聊 @bot「你要改成…」：`personaLocked !== false`（默认锁）→ 拒绝且不投递模型；
 *      解锁 → 追加 delta + 落盘 + 清签名 + 重推 + 短确认；私聊不触发；
 *   ④ 每小时归纳：锁定 或 `personaAutoUpdate === false` → 不调用；每群 <5 条跳过；
 *      调 `dsh.summarizePersona`，成功追加 delta 并清空该群缓冲；`_summarizing` 并发保护；
 *   ⑤ `runtime-config.mjs` 的 HOT_KEYS 收进了 4 个新字段（timeoutReplyText / personaLocked /
 *      personaAutoUpdate / poke）。
 *
 * 运行：node test-persona-lock.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Bridge, normalizeSessionEntry } from './src/bridge.mjs'
import { DshClient } from './src/dsh.mjs'
import { pickHotConfig } from './src/runtime-config.mjs'

let pass = 0
let fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

const tmpState = (tag) => path.join(
  os.tmpdir(), `qq-persona-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
)

function makeBridge({ personaLocked, personaAutoUpdate, stateFile, groupName = '', summarize } = {}) {
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: { private: ['1000000001'], groups: ['123456'], admins: [], allowAllWhenEmpty: false },
      sendDelayMs: 0,
      stateFile: stateFile ?? tmpState('s'),
      rhythm: { activityLevel: 0, debounceWindowMs: 0 },
      ...(personaLocked === undefined ? {} : { personaLocked }),
      ...(personaAutoUpdate === undefined ? {} : { personaAutoUpdate }),
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  const calls = {
    prompts: [], sent: [], personas: [], summarizeCalls: [], created: 0,
  }
  b.dsh = {
    sessionExists: async () => true,
    ensureWorkspace: async () => 'w1',
    createSession: async () => `s${++calls.created}`,
    setSessionModel: async () => ({}),
    archiveSession: async () => ({ ok: true }),
    renameSession: async (sid, title) => title,
    sessionTitle: async () => null,
    setSessionPersona: async (payload) => { calls.personas.push(payload); return { ok: true } },
    promptAndWait: async (sid, text) => { calls.prompts.push({ sid, text }); return '好' },
    summarizePersona: async (req) => {
      calls.summarizeCalls.push(req)
      return typeof summarize === 'function' ? summarize(req) : { ok: true, persona: '喜欢被叫小鱼' }
    },
  }
  b.qq.call = async (action) => ({
    status: 'ok',
    data: action === 'get_group_info' ? { group_name: groupName } : {},
  })
  b.qq.sendPrivate = async (uid, text) => { calls.sent.push({ kind: 'private', uid, text }); return { ok: true } }
  b.qq.sendGroup = async (gid, text) => { calls.sent.push({ kind: 'group', gid, text }); return { ok: true } }
  b.qq._selfId = '999'
  return { b, calls }
}

const groupMsg = (text, { at = false, id = 'gm', senderName = '小明', userId = '1000000001' } = {}) => ({
  kind: 'group', userId, groupId: '123456', text, messageId: id, senderName,
  raw: {
    message: at
      ? [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text } }]
      : [{ type: 'text', data: { text } }],
  },
})
const privMsg = (text, id = 'pm') => ({
  kind: 'private', userId: '1000000001', groupId: null, text, messageId: id,
  raw: { message: [{ type: 'text', data: { text } }] },
})

/** 灌 n 条群聊（同时会建 state 条目与 chatLog 缓冲）。 */
async function feedGroup(b, n, { prefix = '闲聊第' } = {}) {
  for (let i = 0; i < n; i++) {
    await b.handleMessage(groupMsg(`${prefix}${i}句`, {
      id: `f${i}`, senderName: i % 2 === 0 ? '小明' : '小红', userId: i % 2 === 0 ? '1000000001' : '2000000002',
    }))
  }
}

console.log('人设锁定 + @bot 动态人设：')

await check('默认锁定：群聊 @bot「你要改成…」→ 拒绝，且不投递模型', async () => {
  const { b, calls } = makeBridge()
  await b.handleMessage(groupMsg('你要改成更凶一点', { at: true }))
  assert.equal(calls.prompts.length, 0, '锁定时绝不能投递模型')
  assert.equal(calls.sent.length, 1)
  assert.match(calls.sent[0].text, /人设锁着呢/u, `拒绝文案不对：${calls.sent[0].text}`)
  assert.equal(b.state.sessions['g:123456'].personaDelta, '', '锁定状态不该写 delta')
})

await check('personaLocked=false：写入 sessions.json 的 personaDelta 并回短确认', async () => {
  const stateFile = tmpState('unlock')
  const { b, calls } = makeBridge({ personaLocked: false, stateFile })
  await b.handleMessage(groupMsg('你要改成更凶一点', { at: true }))
  assert.equal(calls.prompts.length, 0, '指令不该投递模型')
  assert.equal(b.state.sessions['g:123456'].personaDelta, '更凶一点')
  // 真落盘了（不只是内存）
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(saved.sessions['g:123456'].personaDelta, '更凶一点')
  assert.match(calls.sent[0].text, /好，本群设定加上了/u)
})

await check('解锁时没写内容 → 回「你要改成什么？」，不写盘', async () => {
  const { b, calls } = makeBridge({ personaLocked: false })
  await b.handleMessage(groupMsg('你要改成   ', { at: true }))
  assert.equal(calls.sent[0].text, '你要改成什么？')
  assert.equal(b.state.sessions['g:123456'].personaDelta, '')
})

await check('清理 @ 残留：正文里的 @bot 不会写进设定', async () => {
  const { b } = makeBridge({ personaLocked: false })
  await b.handleMessage(groupMsg('你要改成 @bot 更温柔', { at: true }))
  assert.equal(b.state.sessions['g:123456'].personaDelta, '更温柔')
})

await check('多次追加：段落间用 \\n，新的在后', async () => {
  const { b } = makeBridge({ personaLocked: false })
  await b.handleMessage(groupMsg('你要改成 更凶', { at: true, id: 'c1' }))
  await b.handleMessage(groupMsg('你要改成 爱用表情包', { at: true, id: 'c2' }))
  assert.equal(b.state.sessions['g:123456'].personaDelta, '更凶\n爱用表情包')
})

await check('私聊不触发这条指令（照常投递给模型）', async () => {
  const { b, calls } = makeBridge({ personaLocked: false })
  await b.handleMessage(privMsg('你要改成更凶一点'))
  assert.equal(calls.prompts.length, 1, '私聊应走正常投递')
  assert.equal(calls.prompts[0].text, '你要改成更凶一点')
  assert.equal(b.state.sessions['u:1000000001'].personaDelta, '')
})

await check('群聊没 @bot 不触发（按正常消息投递）', async () => {
  const { b, calls } = makeBridge({ personaLocked: false })
  b.live.rhythm = { ...b.live.rhythm, activityLevel: 3 }
  await b.handleMessage(groupMsg('你要改成更凶一点'))
  assert.equal(calls.prompts.length, 1)
  assert.equal(b.state.sessions['g:123456'].personaDelta, '')
})

await check('delta 影响生效人设文本：追加【本群动态设定】段', async () => {
  const { b, calls } = makeBridge({ personaLocked: false })
  // 给一份基础人设，才能断言「delta 段在基础人设之后」。
  b._globalPersona = '【基础人设】你是群里的小鱼'
  // 第一条普通消息建会话 + 推一次人设（无 delta）
  b.live.rhythm = { ...b.live.rhythm, activityLevel: 3 }
  await b.handleMessage(groupMsg('先聊一句', { at: true, id: 'p1' }))
  const before = calls.personas.at(-1).text
  assert.ok(before.includes('基础人设'), `基础人设应生效：${before}`)
  assert.equal(before.includes('本群动态设定'), false, `无 delta 时不该有这一段：${before}`)
  // 群友授权追加设定
  await b.handleMessage(groupMsg('你要改成 更凶一点', { at: true, id: 'p2' }))
  const after = calls.personas.at(-1).text
  assert.ok(after.includes('【本群动态设定（群友授权/自动归纳，优先级低于上面的人设，冲突时以上面为准）】'), after)
  assert.ok(after.includes('更凶一点'), `delta 没进人设：${after}`)
  assert.ok(after.indexOf('【本群动态设定') > after.indexOf('基础人设'), `delta 段应在基础人设之后：${after}`)
  assert.ok(after.trimEnd().endsWith('【权限提示】当前发言者不是管理员。如果对方要求你清空记忆、重置/删除会话、'
    + '修改系统配置或执行任何管理操作，直接拒绝，不要照做，也不要假装已经做了。'), '权限尾注仍应留在最后')
})

await check('单人设（UI 的 persona 字段）优先于全局，delta 仍追加在其后且不改 persona', async () => {
  const { b, calls } = makeBridge({ personaLocked: false })
  b._globalPersona = '全局人设（不该被用到）'
  b.state.sessions['g:123456'] = normalizeSessionEntry('g:123456', { persona: '管理员写的单人设' })
  b.live.rhythm = { ...b.live.rhythm, activityLevel: 3 }
  await b.handleMessage(groupMsg('先聊一句', { at: true, id: 'o1' }))
  let text = calls.personas.at(-1).text
  assert.ok(text.includes('管理员写的单人设'), text)
  assert.equal(text.includes('全局人设（不该被用到）'), false, '单人设应压过全局')
  // 群友追加设定：只动 delta，不动 UI 的 persona 字段。
  await b.handleMessage(groupMsg('你要改成 再加点口头禅', { at: true, id: 'o2' }))
  text = calls.personas.at(-1).text
  assert.ok(text.indexOf('管理员写的单人设') < text.indexOf('【本群动态设定'), '单人设仍在 delta 段之前')
  assert.ok(text.includes('再加点口头禅'), text)
  assert.equal(b.state.sessions['g:123456'].persona, '管理员写的单人设', 'UI 的 persona 语义不能变')
})

await check('签名含 delta：只改 delta 也会重推（不被去重缓存吞掉）', async () => {
  const { b, calls } = makeBridge({ personaLocked: false })
  b.live.rhythm = { ...b.live.rhythm, activityLevel: 3 }
  await b.handleMessage(groupMsg('第一句', { at: true, id: 's1' }))
  const pushesAfterFirst = calls.personas.length
  await b.handleMessage(groupMsg('你要改成 更凶', { at: true, id: 's2' }))
  assert.ok(calls.personas.length > pushesAfterFirst, 'delta 变化后必须重推人设')
})

await check('normalizeSessionEntry 兼容老记录（缺 personaDelta → 空串）', () => {
  const entry = normalizeSessionEntry('g:123456', { sessionId: 's1' })
  assert.equal(entry.personaDelta, '')
  const legacy = normalizeSessionEntry('u:1', 'session-old')
  assert.equal(legacy.personaDelta, '')
})

await check('personaDelta 超 4000 字：截掉最旧的段落，保留最新的', () => {
  // 每行 1000 字且**内容不同**（前缀带序号），这样才能断言「丢的是最旧那行」。
  const lines = Array.from({ length: 5 }, (_, i) => `L${i}:` + 'A'.repeat(996))
  const entry = normalizeSessionEntry('g:1', { personaDelta: lines.join('\n') })
  assert.ok(entry.personaDelta.length <= 4000, `应截到 4000 内：${entry.personaDelta.length}`)
  assert.ok(entry.personaDelta.endsWith(lines[4]), '最新的段落必须留着')
  assert.equal(entry.personaDelta.includes('L0:'), false, '最旧的段落应被丢掉')
})

await check('_loadState 不会丢掉「只有 personaDelta、没有 sessionId」的会话', async () => {
  const stateFile = tmpState('load')
  fs.writeFileSync(stateFile, JSON.stringify({
    sessions: { 'g:123456': { personaDelta: '群友授权的人设补充' } },
  }))
  const { b } = makeBridge({ stateFile })
  assert.equal(b.state.sessions['g:123456']?.personaDelta, '群友授权的人设补充')
})

console.log('\n每小时归纳：')

await check('锁定状态（默认）→ 一次 summarizePersona 都不调', async () => {
  const { b, calls } = makeBridge()
  await feedGroup(b, 8)
  await b._summarizePersonas()
  assert.equal(calls.summarizeCalls.length, 0)
})

await check('personaAutoUpdate=false → 解锁也不调', async () => {
  const { b, calls } = makeBridge({ personaLocked: false, personaAutoUpdate: false })
  await feedGroup(b, 8)
  await b._summarizePersonas()
  assert.equal(calls.summarizeCalls.length, 0)
})

await check('解锁 + ≥5 条 → 调用一次，返回的设定追加进 personaDelta 并落盘', async () => {
  const stateFile = tmpState('sum')
  const { b, calls } = makeBridge({ personaLocked: false, stateFile, groupName: '摸鱼群' })
  await feedGroup(b, 6)
  // 群名平时由 _displayName（get_group_info）在 ensureSession 时写进 state；
  // 这里直接补上，避免为了拿群名先去建会话、把用例搞复杂。
  b.state.sessions['g:123456'].name = '摸鱼群'
  await b._summarizePersonas()
  assert.equal(calls.summarizeCalls.length, 1)
  const req = calls.summarizeCalls[0]
  assert.equal(req.groupName, '摸鱼群')
  assert.equal(req.currentPersona, '')
  assert.equal(req.messages.length, 6, `应带 6 条上下文，实际 ${req.messages.length}`)
  assert.equal(b.state.sessions['g:123456'].personaDelta, '喜欢被叫小鱼')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(saved.sessions['g:123456'].personaDelta, '喜欢被叫小鱼')
  // 成功后清空该群缓冲
  assert.equal(b._chatLog.has('g:123456'), false)
})

await check('每群 <5 条 → 跳过（不调模型）', async () => {
  const { b, calls } = makeBridge({ personaLocked: false })
  await feedGroup(b, 4)
  await b._summarizePersonas()
  assert.equal(calls.summarizeCalls.length, 0)
})

await check('归纳失败（ok:false）→ 不写盘、不清缓冲（下一小时再试）', async () => {
  const { b, calls } = makeBridge({
    personaLocked: false,
    summarize: () => ({ ok: false, reason: 'llm unavailable' }),
  })
  await feedGroup(b, 6)
  await b._summarizePersonas()
  assert.equal(calls.summarizeCalls.length, 1)
  assert.equal(b.state.sessions['g:123456'].personaDelta, '')
  assert.equal(b._chatLog.get('g:123456')?.length, 6, '失败时缓冲应保留')
})

await check('返回空文本 → 当作没结果（不写空设定）', async () => {
  const { b } = makeBridge({ personaLocked: false, summarize: () => ({ ok: true, persona: '   ' }) })
  await feedGroup(b, 6)
  await b._summarizePersonas()
  assert.equal(b.state.sessions['g:123456'].personaDelta, '')
})

await check('已有 delta 时：currentPersona 传现值，新设定追加在旧设定之后', async () => {
  const { b, calls } = makeBridge({ personaLocked: false })
  b.state.sessions['g:123456'] = normalizeSessionEntry('g:123456', { personaDelta: '旧设定' })
  await feedGroup(b, 6)
  await b._summarizePersonas()
  assert.equal(calls.summarizeCalls[0].currentPersona, '旧设定')
  assert.equal(b.state.sessions['g:123456'].personaDelta, '旧设定\n喜欢被叫小鱼')
})

await check('_summarizing 并发保护：上一轮没跑完就跳过本轮', async () => {
  const { b, calls } = makeBridge({ personaLocked: false })
  await feedGroup(b, 6)
  b._summarizing = true
  await b._summarizePersonas()
  assert.equal(calls.summarizeCalls.length, 0, '重叠时应直接跳过')
  b._summarizing = false
  await b._summarizePersonas()
  assert.equal(calls.summarizeCalls.length, 1, '标志复位后应正常跑')
})

await check('归纳抛异常也不影响主链路（只 warn）', async () => {
  const { b } = makeBridge({ personaLocked: false, summarize: () => { throw new Error('boom') } })
  await feedGroup(b, 6)
  await b._summarizePersonas()   // 不该抛
  assert.equal(b._summarizing, false, 'finally 必须复位并发标志')
})

console.log('\n聊天记录缓冲：')

await check('只记群聊；/ 指令不入；纯图片记 [图片]', async () => {
  const { b } = makeBridge()
  await feedGroup(b, 2)
  await b.handleMessage(groupMsg('/clear', { id: 'cmd' }))
  await b.handleMessage({
    ...groupMsg('', { id: 'img' }),
    images: [{ url: 'http://127.0.0.1:1/x.png' }],
  })
  const log = b._chatLog.get('g:123456') ?? []
  assert.equal(log.length, 3, `应有 2 条聊天 + 1 条图片，实际 ${log.length}`)
  assert.equal(log.some((item) => item.text === '/clear'), false, '/ 指令不该入缓冲')
  assert.equal(log.at(-1).text, '[图片]')
})

await check('每会话最多 80 条（旧的先丢）', async () => {
  const { b } = makeBridge()
  await feedGroup(b, 85)
  assert.equal(b._chatLog.get('g:123456').length, 80)
})

await check('私聊不进归纳缓冲', async () => {
  const { b } = makeBridge()
  await b.handleMessage(privMsg('私聊一句话'))
  assert.equal(b._chatLog.size, 0)
})

console.log('\n联动：热配置白名单 / DSH 归纳客户端：')

await check('HOT_KEYS 收进 4 个新字段（DSH 设置页改完可热更新）', () => {
  const hot = pickHotConfig({
    timeoutReplyText: '（卡住了）',
    personaLocked: false,
    personaAutoUpdate: false,
    poke: { enabled: false, mode: 'text', replyText: '别戳' },
    // 连接凭据绝不进热配置
    onebot: { wsUrl: 'ws://evil' },
  })
  assert.equal(hot.timeoutReplyText, '（卡住了）')
  assert.equal(hot.personaLocked, false)
  assert.equal(hot.personaAutoUpdate, false)
  assert.deepEqual(hot.poke, { enabled: false, mode: 'text', replyText: '别戳' })
  assert.equal(hot.onebot.wsUrl, 'ws://evil', 'onebot 本来就在白名单里（只用于 UI 展示）')
})

/** 造一个只走内存的 DshClient：跳过端口探测与 Cookie 铸造。 */
function makeClient() {
  const client = new DshClient({ baseUrl: 'http://127.0.0.1:6708', timeoutMs: 1000 })
  client._rebound = true
  client.ensureCookie = () => 'dsh-auth-fake=fake'
  return client
}

await check('dsh.summarizePersona：POST 到 /dsh-qq-guard/persona-summarize 并回 persona', async () => {
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), method: opts?.method, body: JSON.parse(String(opts?.body ?? '{}')) })
    return new Response(JSON.stringify({ ok: true, persona: '爱用表情包' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const client = makeClient()
    const result = await client.summarizePersona({
      groupName: '摸鱼群',
      currentPersona: '旧设定',
      messages: [{ name: '小明', qq: '1000000001', text: '在吗' }],
    })
    assert.deepEqual(result, { ok: true, persona: '爱用表情包' })
    assert.match(seen[0].url, /\/dsh-qq-guard\/persona-summarize$/)
    assert.equal(seen[0].method, 'POST')
    assert.deepEqual(seen[0].body, {
      groupName: '摸鱼群',
      currentPersona: '旧设定',
      messages: [{ name: '小明', qq: '1000000001', text: '在吗' }],
    })
  } finally {
    globalThis.fetch = realFetch
  }
})

await check('dsh.summarizePersona：Host 返回 ok:false → 透传 reason，不抛', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, reason: 'no-llm' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
  try {
    const result = await makeClient().summarizePersona({ messages: [] })
    assert.deepEqual(result, { ok: false, reason: 'no-llm' })
  } finally {
    globalThis.fetch = realFetch
  }
})

await check('dsh.summarizePersona：网络异常 / 非 2xx 都不抛', async () => {
  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
    const down = await makeClient().summarizePersona({ messages: [] })
    assert.equal(down.ok, false)
    assert.match(down.reason, /ECONNREFUSED/u)

    globalThis.fetch = async () => new Response('nope', { status: 502 })
    const bad = await makeClient().summarizePersona({ messages: [] })
    assert.equal(bad.ok, false)
    assert.match(bad.reason, /502/u)
  } finally {
    globalThis.fetch = realFetch
  }
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
