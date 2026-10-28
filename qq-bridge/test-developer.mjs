/**
 * v2.0 开发者特权 / 三阶权限 / 会话详情上报的离线自测。
 *
 *   node test-developer.mjs
 *
 * 不连 QQ、不启 NapCat、不碰 DSH：DSH 与 NapCat 全部用假客户端。
 * 覆盖：
 *   ① 三阶权限继承 + allow.developers 缺省降级（不抛错）
 *   ② 暗号匹配口径（前缀 / 标点 / 长词优先）
 *   ③ 尾部追加（只加尾部，不动人设 / 系统提示词）+ 正文剥离
 *   ④ 非开发者命中：静默 / 可选回一句
 *   ⑤ 会话详情上报：recent / context / modelRoute / summary / raw + 12 条限额
 *   ⑥ applySessionOp('summarize')：控制台触发，不冒充 QQ 号
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import {
  Bridge, DEV_PROMPT_HEADER, DEV_STRANGER_REPLY, DEFAULT_DEVELOPER_KEYWORDS,
  normalizeSessionEntry,
} from './src/bridge.mjs'

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

function makeBridge({ allow, rhythm, developer, features } = {}) {
  const b = new Bridge({
    config: {
      dsh: {
        baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x',
        agentPreset: 'qq-chat',
      },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: {
        private: ['1000000001'], groups: ['123456'], admins: [], owners: [], developers: [],
        allowAllWhenEmpty: false, ...(allow ?? {}),
      },
      sendDelayMs: 0,
      stateFile: path.join(os.tmpdir(), `qq-bridge-dev-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
      ...(rhythm ? { rhythm } : {}),
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  const calls = { prompts: [], personas: [], sent: [], summaries: [] }
  b.dsh = {
    sessionExists: async () => true,
    ensureWorkspace: async () => 'w1',
    createSession: async () => 's1',
    archiveSession: async () => ({ ok: true }),
    renameSession: async (sid, title) => title,
    sessionTitle: async () => null,
    setSessionModel: async () => ({ ok: true, model: 'm' }),
    setSessionPersona: async (payload) => { calls.personas.push(payload); return { ok: true } },
    promptAndWait: async (sid, text, opts) => { calls.prompts.push({ sid, text, opts }); return '好' },
  }
  b.qq.call = async () => ({ status: 'ok', data: {} })
  b.qq.sendGroup = async (gid, text, opts) => { calls.sent.push({ kind: 'group', gid, text, opts }); return { ok: true, messageIds: ['1'] } }
  b.qq.sendPrivate = async (uid, text, opts) => { calls.sent.push({ kind: 'private', uid, text, opts }); return { ok: true, messageIds: ['1'] } }
  b.qq._selfId = '999'
  // 热配置：桥接生产环境由设置页下发，测试里直接写 live。
  if (allow) b.live.allow = { ...b.live.allow, ...allow }
  if (developer) b.live.developer = developer
  b.live.features = { ...(b.live.features ?? {}), ...(features ?? {}) }
  return { b, calls }
}

const groupMsg = (text, { userId = '1000000001', id = 'gm', at = false } = {}) => ({
  kind: 'group', userId, groupId: '123456', text, messageId: id,
  raw: { message: at ? [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text } }] : [{ type: 'text', data: { text } }] },
})

const DEV_PROMPT = '本轮是开发者调试：先给结论，再附内部链路。'
const devConfOn = {
  enabled: true, keywords: ['/dev', '/admin'], prompt: DEV_PROMPT,
  strangerReply: false, debugPayload: false,
}

console.log('— 三阶权限：开发者 > 主人 > 管理员 —')
await check('allow.developers 缺省时自动降级，不抛错', () => {
  const { b } = makeBridge({ allow: { admins: ['2'], owners: ['3'] } })
  const msg = { userId: '3' }
  assert.equal(b.isDeveloper(msg), false, '没配开发者 → 谁都不是开发者')
  assert.equal(b.isOwner(msg), true, '主人仍正常')
  assert.equal(b.isAdmin(msg), true, '主人自动算管理员')
  assert.equal(b.isAdmin({ userId: '2' }), true)
  assert.equal(b.isAdmin({ userId: '4' }), false)
  // 非数组 / null 也不能崩。
  b.live.allow = { ...b.live.allow, developers: 'oops' }
  assert.equal(b.isDeveloper({ userId: '3' }), false)
  b.live.allow = { ...b.live.allow, developers: undefined }
  assert.equal(b.isDeveloper({ userId: '3' }), false)
})
await check('开发者自动继承主人与管理员；反过来不成立', () => {
  const { b } = makeBridge({ allow: { admins: ['11'], owners: ['22'], developers: ['33'] } })
  assert.equal(b.isDeveloper({ userId: '33' }), true)
  assert.equal(b.isOwner({ userId: '33' }), true, '开发者算主人')
  assert.equal(b.isAdmin({ userId: '33' }), true, '开发者算管理员')
  assert.equal(b.isDeveloper({ userId: '22' }), false, '主人不是开发者')
  assert.equal(b.isOwner({ userId: '11' }), false, '管理员不是主人')
})

console.log('\n— 暗号匹配口径 —')
await check('只认前缀；关键词后必须是空白或标点；长词优先', () => {
  const { b } = makeBridge()
  const conf = { ...devConfOn, keywords: [...DEFAULT_DEVELOPER_KEYWORDS].sort((a, b2) => b2.length - a.length) }
  assert.equal(b._matchDeveloperTrigger('/dev 干活', conf)?.text, '干活')
  assert.equal(b._matchDeveloperTrigger('/dev   干活  ', conf)?.text, '干活', '多余空白要 trim')
  assert.equal(b._matchDeveloperTrigger('/dev', conf)?.text, '', '只有关键词 = 空正文')
  assert.equal(b._matchDeveloperTrigger('/dev（现在）', conf)?.text, '（现在）', '全角标点也算分隔')
  assert.equal(b._matchDeveloperTrigger('今天 /dev 挂了', conf), null, '不是开头不命中')
  assert.equal(b._matchDeveloperTrigger('/administrator 你好', conf), null, '不能把 /admin 从长单词里吃掉')
  assert.equal(b._matchDeveloperTrigger('/ADMIN 你好', conf), null, '大小写敏感（避免误伤普通文本）')
  assert.equal(b._matchDeveloperTrigger('/dev 干活', { ...conf, enabled: false }), null, '开关关掉不命中')
  assert.equal(b._matchDeveloperTrigger('', conf), null)
})

console.log('\n— 命中后：剥关键词 + 只追加在 Prompt 尾部 —')
await check('开发者命中：正文剥掉触发词，尾部追加专属 Prompt，人设一个字不动', async () => {
  const { b, calls } = makeBridge({
    allow: { developers: ['1000000001'] },
    rhythm: { activityLevel: 3, debounceWindowMs: 0 },
    developer: devConfOn,
    features: { developer: true },
  })
  await b.handleMessage(groupMsg('/dev 帮我看下引用解析'))
  assert.equal(calls.prompts.length, 1, '应该真的走了一轮模型')
  const prompt = calls.prompts[0].text
  assert.ok(!prompt.startsWith('/dev'), '★ 触发词必须被剥掉（DSH 会当指令）')
  assert.ok(prompt.includes('帮我看下引用解析'), '正文要保留')
  assert.ok(prompt.trimEnd().endsWith(`${DEV_PROMPT_HEADER}\n${DEV_PROMPT}`), '★ 专属 Prompt 必须在最尾部')
  // 人设（系统提示词层）绝不能包含特权文本。
  assert.equal(calls.personas.length, 1)
  assert.ok(!calls.personas[0].text.includes(DEV_PROMPT), '★ 特权文本不能进系统提示词')
  assert.equal(b.stats.devTriggers, 1)
})
await check('只发暗号没有正文：补一句占位，不丢消息', async () => {
  const { b, calls } = makeBridge({
    allow: { developers: ['1000000001'] },
    rhythm: { activityLevel: 3, debounceWindowMs: 0 },
    developer: devConfOn,
    features: { developer: true },
  })
  await b.handleMessage(groupMsg('/dev'))
  assert.equal(calls.prompts.length, 1)
  assert.ok(calls.prompts[0].text.includes('开发者暗号'), '空正文要有占位')
  assert.ok(calls.prompts[0].text.includes(DEV_PROMPT))
})
await check('普通群友命中：默认静默（不进 DSH、不回话、计入 devDenied）', async () => {
  const { b, calls } = makeBridge({
    allow: { developers: ['9999999999'] },
    rhythm: { activityLevel: 3, debounceWindowMs: 0 },
    developer: devConfOn,
    features: { developer: true },
  })
  await b.handleMessage(groupMsg('/dev 帮我看看'))
  assert.equal(calls.prompts.length, 0, '★ 不能进 DSH')
  assert.equal(calls.sent.length, 0, '★ 默认不回话（不暴露机制）')
  assert.equal(b.stats.devDenied, 1)
})
await check('普通群友命中 + strangerReply：回固定文案，仍不进 DSH', async () => {
  const { b, calls } = makeBridge({
    allow: { developers: ['9999999999'] },
    rhythm: { activityLevel: 3, debounceWindowMs: 0 },
    developer: { ...devConfOn, strangerReply: true },
    features: { developer: true },
  })
  await b.handleMessage(groupMsg('/dev 帮我看看'))
  assert.equal(calls.prompts.length, 0)
  assert.equal(calls.sent.length, 1)
  assert.equal(calls.sent[0].text, DEV_STRANGER_REPLY)
})
await check('技能卡关闭（features.developer=false）：暗号不生效，消息原样走', async () => {
  const { b, calls } = makeBridge({
    allow: { developers: ['1000000001'] },
    rhythm: { activityLevel: 3, debounceWindowMs: 0 },
    developer: devConfOn,
    features: { developer: false },
  })
  await b.handleMessage(groupMsg('/dev 帮我看下'))
  assert.equal(calls.prompts.length, 1)
  assert.ok(calls.prompts[0].text.startsWith('/dev'), '没开卡时不做任何处理（含不剥词）')
  assert.ok(!calls.prompts[0].text.includes(DEV_PROMPT), '★ 不能偷偷追加')
  assert.equal(b.stats.devTriggers, 0)
})
await check('developer.enabled=false：不命中，也不追加', async () => {
  const { b, calls } = makeBridge({
    allow: { developers: ['1000000001'] },
    rhythm: { activityLevel: 3, debounceWindowMs: 0 },
    developer: { ...devConfOn, enabled: false, prompt: 'SHOULD-NOT-APPEAR' },
    features: { developer: true },
  })
  await b.handleMessage(groupMsg('/dev 帮我看下'))
  assert.ok(!calls.prompts[0].text.includes('SHOULD-NOT-APPEAR'))
})

console.log('\n— 会话详情上报（recent / context / modelRoute / summary / raw）—')
await check('recent：最新在前、带引用摘要、正文截断', () => {
  const { b } = makeBridge()
  b._noteChatLog('g:123456', groupMsg('第一条'), '第一条', [], '')
  b._noteChatLog('g:123456', groupMsg('第二条'), '第二条', [], '[引用 小明] 原话')
  const entry = b._entryOf('g:123456')
  entry.lastAt = 2
  const row = b.sessionViews().find((item) => item.key === 'g:123456')
  assert.ok(Array.isArray(row.recent))
  assert.equal(row.recent.length, 2)
  assert.equal(row.recent[0].text, '第二条', '最新在前')
  assert.equal(row.recent[0].quote, '[引用 小明] 原话')
  assert.equal(row.recent[1].quote, '')
})
await check('context：注入统计按会话记录', () => {
  const { b } = makeBridge()
  b.live.memory = { enabled: true, messageMaxTurns: 2, maxContextTokens: 128000, smartMatch: false }
  for (let i = 0; i < 4; i++) b._noteChatLog('g:123456', groupMsg(`第${i}条`), `第${i}条`, [], '')
  b._entryOf('g:123456').lastAt = 1
  const sections = b._contextSections('g:123456')
  assert.equal(sections.length, 1)
  const row = b.sessionViews().find((item) => item.key === 'g:123456')
  assert.equal(row.context.enabled, true)
  assert.equal(row.context.budget, 128000)
  assert.equal(row.context.turns, 2, 'messageMaxTurns=2 → 只注入 2 条')
  assert.ok(row.context.tokens >= 0)
})
await check('modelRoute：记录实际下发值，空 = 跟随全局', async () => {
  const { b } = makeBridge()
  const entry = b._entryOf('g:123456')
  entry.sessionId = 's-route'
  entry.lastAt = 1
  b.live.model = { provider: 'deepseek-account', model: 'deepseek-flash' }
  await b._applyModel('s-route')
  let row = b.sessionViews().find((item) => item.key === 'g:123456')
  assert.equal(row.modelRoute, 'deepseek-account/deepseek-flash')
  b.live.model = { provider: '', model: '' }
  await b._applyModel('s-route')
  row = b.sessionViews().find((item) => item.key === 'g:123456')
  assert.equal(row.modelRoute, '', '跟随全局时是空串，不是中文文案')
})
await check('summary：水位字段上报', () => {
  const { b } = makeBridge()
  b._summaryState('g:123456')
  b.state.unreadSummary['g:123456'].lastSummaryAt = 1700000000000
  b.state.unreadSummary['g:123456'].runs = 3
  b._entryOf('g:123456').lastAt = 1
  const row = b.sessionViews().find((item) => item.key === 'g:123456')
  assert.equal(row.summary.lastAt, 1700000000000)
  assert.equal(row.summary.runs, 3)
})
await check('raw：开关关着不上报；开着才有（且不落盘）', async () => {
  const off = makeBridge({
    rhythm: { activityLevel: 3, debounceWindowMs: 0 },
    developer: { ...devConfOn, debugPayload: false },
  })
  await off.b.handleMessage(groupMsg('普通一句话'))
  const offRow = off.b.sessionViews().find((item) => item.key === 'g:123456')
  assert.equal(offRow.raw, undefined, '默认不留、不传')

  const on = makeBridge({
    rhythm: { activityLevel: 3, debounceWindowMs: 0 },
    developer: { ...devConfOn, debugPayload: true },
  })
  await on.b.handleMessage(groupMsg('普通一句话'))
  const onRow = on.b.sessionViews().find((item) => item.key === 'g:123456')
  assert.ok(onRow.raw, '★ 开关打开后要有原始 payload')
  assert.ok(onRow.raw.json.includes('普通一句话'))
  const disk = on.b._saveState // 仅确认字段不在 state 里
  assert.equal(typeof disk, 'function')
  assert.equal(on.b.state.sessions['g:123456'].raw, undefined, '★ 绝不落盘')
})
await check('明细字段只给最近活跃的 12 个会话（第 13 个不带 recent/raw）', () => {
  const { b } = makeBridge({
    developer: { ...devConfOn, debugPayload: true },
  })
  for (let i = 0; i < 13; i++) {
    const key = `g:${1000 + i}`
    b.state.sessions[key] = normalizeSessionEntry(key, { lastAt: i + 1 })
    b._noteChatLog(key, groupMsg(`消息${i}`), `消息${i}`, [], '')
    b._rawInbound.set(key, { at: Date.now(), json: '{"x":1}' })
  }
  const rows = b.sessionViews()
  const withRecent = rows.filter((row) => Array.isArray(row.recent))
  assert.equal(withRecent.length, 12, '★ 只有 12 条带重字段')
  assert.equal(rows[0].key, 'g:1012', '按最近活动倒序')
  assert.ok(rows[0].recent, '最新那条要带 recent')
  assert.equal(rows[12].recent, undefined, '第 13 条不带')
  assert.equal(rows[12].raw, undefined, '第 13 条也不带 raw')
  assert.equal(rows[12].modelRoute, '', '轻量字段仍然有')
})

console.log('\n— 控制台触发未读归纳（不冒充 QQ 号）—')
await check('非群会话拒绝 / 关闭时拒绝', async () => {
  const { b } = makeBridge()
  const bad = await b.applySessionOp({ op: 'summarize', key: 'u:1000000001' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'not-a-group')
  b.live.unreadSummary = { enabled: false }
  const off = await b.applySessionOp({ op: 'summarize', key: 'g:123456' })
  assert.equal(off.ok, false)
  assert.equal(off.error, 'summary-disabled')
})
await check('开启时调用 _runUnreadSummary，origin=console 不伪造主人', async () => {
  const { b } = makeBridge()
  const runs = []
  b._runUnreadSummary = async (args) => { runs.push(args) }
  const result = await b.applySessionOp({ op: 'summarize', key: 'g:123456' })
  await tick()
  assert.equal(result.ok, true)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].key, 'g:123456')
  assert.equal(String(runs[0].msg.userId), '', '★ 合成 msg 的 userId 必须为空（不是任何 QQ 号）')
  assert.equal(String(runs[0].msg.groupId), '123456')
})
await check('正在跑时拒绝重复触发（不双开）', async () => {
  const { b } = makeBridge()
  b._runUnreadSummary = async () => {}
  b._summaryRuns.add('g:123456')
  const result = await b.applySessionOp({ op: 'summarize', key: 'g:123456' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'summary-running')
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
