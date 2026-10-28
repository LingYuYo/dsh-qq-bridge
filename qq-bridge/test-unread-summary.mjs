/**
 * 智能未读归纳（v2.0 第一步，2026-10-28，离线）。
 *
 * 锁死的约定：
 *   ① `/归纳 [N]` 只认整条消息，N 钳在 1~500；只有**主人**（allow.owners）能触发，
 *      管理员也不行；私聊里发只回提示、不跑；
 *   ② 水位 `(lastSummaryAt, lastSummarySeq)` 决定「哪些算没归纳过」，时间优先、序号兜底，
 *      **只在真的发出去之后**推进 —— 失败不推进，重启后不会漏也不会重复；
 *   ③ 转写按 token 预算从**最老的**开始省略，单条按字数截断；
 *   ④ 模型回复切成多个 node → `send_group_forward_msg`；失败**降级纯文本**；
 *   ⑤ 后台失败私聊通知主人，并且有冷却（默认 1 小时）；
 *   ⑥ 归纳跑在**旁路临时会话**里，跑完归档，不碰 QQ 会话的上下文。
 *
 * 运行：node test-unread-summary.mjs
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { Bridge } from './src/bridge.mjs'
import {
  SUMMARY_FOOTER,
  SUMMARY_HARD_LIMIT,
  SUMMARY_NODE_NAME,
  SUMMARY_OVERRIDE_NOTE,
  SUMMARY_PERSONA,
  SUMMARY_TIME_LIMIT_MINUTES,
  buildForwardNodes,
  buildSummaryPrompt,
  fetchHistoryPaged,
  formatTranscript,
  forwardNodeText,
  nextWatermark,
  normalizeHistoryMessage,
  normalizeSummary,
  parseSummaryCommand,
  parseStructuredSummary,
  pickUnread,
  sanitizeSummaryTone,
  splitSummaryNodes,
} from './src/unread-summary.mjs'

let pass = 0
let fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

const OWNER = '1000000001'
const ADMIN = '1000000002'
const GROUP = '123456'
const SELF = '999999'

function makeBridge({ unreadSummary, owners = [OWNER], admins = [ADMIN] } = {}) {
  return new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 'token-for-test' },
      allow: { private: [OWNER, ADMIN], groups: [GROUP], admins, owners, allowAllWhenEmpty: false },
      sendDelayMs: 0,
      stateFile: path.join(os.tmpdir(), `qq-unread-state-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
      rhythm: { activityLevel: 3, debounceWindowMs: 0 },
      ...(unreadSummary === undefined ? {} : { unreadSummary }),
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  })
}

/** 一条群消息（OB11 形态，和 get_group_msg_history 返回的一致）。 */
function rawMsg({ id = 1, qq = '20001', name = '群友A', text = '你好', time = 1_790_000_000, images = [] } = {}) {
  const message = [{ type: 'text', data: { text } }]
  for (let i = 0; i < images.length; i++) message.push({ type: 'image', data: { url: images[i], file: `f${i}.jpg` } })
  return { message_id: id, user_id: qq, time, message, raw_message: text, sender: { user_id: qq, nickname: name }, group_id: GROUP }
}

/** 假 OneBot + 假 DSH：只实现这条链路用到的几个方法。 */
function fakeRuntime(bridge, {
  history = [], reply = '主线：大家在聊搬家。\n---\n有人提到周末下雨。', forwardOk = true,
  promptError = null,
} = {}) {
  const sent = []
  const privates = []
  const forwards = []
  const archive = []
  // v2.0 第三步：记录临时会话的人设推送与调用顺序（断言「先换人设再提问」）。
  const personas = []
  const events = []
  bridge.qq = {
    selfId: SELF,
    groupAtReply: false,
    groupAtPosition: 'last',
    async getGroupMsgHistory() { return { ok: true, messages: history } },
    async call(action, params) {
      if (action === 'get_group_info') return { status: 'ok', data: { group_name: '测试群' } }
      if (action === 'get_group_msg_history') return { status: 'ok', data: { messages: history } }
      return { status: 'ok', data: {} }
    },
    async sendGroup(groupId, text) { sent.push({ groupId, text }); return { ok: true, total: 1 } },
    async sendPrivate(userId, text) { privates.push({ userId, text }); return { ok: true } },
    async sendGroupForward(groupId, nodes) {
      forwards.push({ groupId, nodes })
      events.push(['forward', groupId])
      return forwardOk ? { ok: true, messageId: 'fwd-1' } : { ok: false, reason: 'retcode=100 mock' }
    },
  }
  bridge.dsh = {
    async ensureWorkspace() { return 'ws-1' },
    async createSession() { return 'sess-summary-1' },
    async setSessionModel() { return { ok: true } },
    async setSessionPersona({ sessionId, text }) {
      personas.push({ sessionId, text })
      events.push(['persona', sessionId])
      return { ok: true }
    },
    async promptAndWait(sessionId, prompt, opts) {
      bridge._lastPrompt = prompt
      bridge._lastPromptOpts = opts
      events.push(['prompt', sessionId])
      if (promptError) throw promptError
      return reply
    },
    async archiveSession(id) { archive.push(id); events.push(['archive', id]) },
  }
  return { sent, privates, forwards, archive, personas, events }
}

/** 一条主人发的群指令消息（Bridge 内部看的那套字段）。 */
function ownerMsg(overrides = {}) {
  return {
    kind: 'group', groupId: GROUP, userId: OWNER, senderName: '主人',
    messageId: '500', text: '/归纳', time: 1_790_000_500, images: [], videos: [], quote: {},
    ...overrides,
  }
}

console.log('\n── 一、命令解析 ─────────────────────────────────')

await check('/归纳 / /总结 / /未读 / /summary / /unread 都认', () => {
  for (const text of ['/归纳', '/总结', '/未读', '/summary', '/unread']) {
    assert.equal(parseSummaryCommand(text).matched, true, text)
    assert.equal(parseSummaryCommand(text).count, 0, text)
  }
})

await check('带条数：取数字，0 视作「用配置默认」', () => {
  assert.equal(parseSummaryCommand('/归纳 80').count, 80)
  assert.equal(parseSummaryCommand('/总结 0').count, 0)
})

await check('超过硬上限钳到 500', () => {
  assert.equal(parseSummaryCommand('/归纳 9999').count, SUMMARY_HARD_LIMIT)
  assert.equal(SUMMARY_HARD_LIMIT, 500)
})

await check('不整条匹配就不算指令（避免闲聊误触发）', () => {
  assert.equal(parseSummaryCommand('归纳一下').matched, false)
  assert.equal(parseSummaryCommand('/归纳 一下').matched, false)
  assert.equal(parseSummaryCommand('/clear').matched, false)
})

await check('时间窗写法：/归纳 1h / 30m / 2 小时', () => {
  assert.equal(parseSummaryCommand('/归纳 1h').windowMinutes, 60)
  assert.equal(parseSummaryCommand('/归纳 30m').windowMinutes, 30)
  assert.equal(parseSummaryCommand('/归纳 2 小时').windowMinutes, 120)
  assert.equal(parseSummaryCommand('/归纳 45 分钟').windowMinutes, 45)
  assert.equal(parseSummaryCommand('/归纳 999h').windowMinutes, SUMMARY_TIME_LIMIT_MINUTES, '时间窗也有上限')
  assert.equal(parseSummaryCommand('/归纳 50').windowMinutes, 0, '条数模式没有时间窗')
})

console.log('\n── 二、配置归一化 ───────────────────────────────')

await check('默认值：不检索图片、200 条、6 段、400 字', () => {
  const conf = normalizeSummary({})
  assert.equal(conf.enabled, true)
  assert.equal(conf.includeImages, false)
  assert.equal(conf.maxMessages, 200)
  assert.equal(conf.maxNodes, 6)
  assert.equal(conf.nodeChars, 400)
  assert.equal(conf.notifyCooldownMs, 3_600_000)
})

await check('越界值退回边界，不静默改名语义', () => {
  const conf = normalizeSummary({ maxMessages: 9999, maxNodes: 0, nodeChars: 99999, includeImages: 'yes' })
  assert.equal(conf.maxMessages, 500)
  assert.equal(conf.maxNodes, 1)
  assert.equal(conf.nodeChars, 2000)
  assert.equal(conf.includeImages, false) // 只认严格 true
})

console.log('\n── 三、消息归一与水位筛选 ───────────────────────')

await check('消息段数组转成正文；纯图片消息保留（有 images）', () => {
  const a = normalizeHistoryMessage(rawMsg({ text: '在的' }))
  assert.equal(a.text, '在的')
  assert.equal(a.seq, 1)
  const b = normalizeHistoryMessage(rawMsg({ text: '', images: ['http://x/1.jpg'] }))
  // 纯图片消息的正文会被解析成 `[图片]` 占位，但 images 列表必须保留下来。
  assert.equal(b.text, '[图片]')
  assert.equal(b.images.length, 1)
  assert.equal(normalizeHistoryMessage({ message_id: 1, message: [], raw_message: '' }), null)
})

await check('水位之后的消息才算未读：时间优先、序号兜底', () => {
  const list = [
    rawMsg({ id: 10, text: '旧的', time: 1000 }),
    rawMsg({ id: 11, text: '同一秒但我更早', time: 2000 }),
    rawMsg({ id: 12, text: '同一秒但我更晚', time: 2000 }),
    rawMsg({ id: 13, text: '新的', time: 3000 }),
  ]
  const picked = pickUnread(list, { lastAt: 2000, lastSeq: 11 })
  assert.deepEqual(picked.map((m) => m.text), ['同一秒但我更晚', '新的'])
})

await check('没有水位 = 全量；条数上限从最新的往回截', () => {
  const list = Array.from({ length: 10 }, (_, i) => rawMsg({ id: i + 1, text: `m${i + 1}`, time: 1000 + i }))
  assert.equal(pickUnread(list, {}).length, 10)
  const capped = pickUnread(list, { maxMessages: 3 })
  assert.deepEqual(capped.map((m) => m.text), ['m8', 'm9', 'm10'])
})

await check('历史顺序乱了也会按时间重排', () => {
  const list = [rawMsg({ id: 3, text: 'c', time: 3000 }), rawMsg({ id: 1, text: 'a', time: 1000 }), rawMsg({ id: 2, text: 'b', time: 2000 })]
  assert.deepEqual(pickUnread(list, {}).map((m) => m.text), ['a', 'b', 'c'])
})

console.log('\n── 四、转写与预算 ───────────────────────────────')

await check('转写带时间与发言人；自己的消息标「你」', () => {
  const items = pickUnread([
    rawMsg({ id: 1, text: '在吗', qq: '20001', name: '小王', time: 1_790_000_000 }),
    rawMsg({ id: 2, text: '在', qq: SELF, name: '小鱼', time: 1_790_000_060 }),
  ], { selfId: SELF })
  const out = formatTranscript(items)
  assert.match(out.text, /小王\(20001\): 在吗/u)
  assert.match(out.text, /你\(小鱼\): 在/u)
  assert.equal(out.kept, 2)
  assert.equal(out.dropped, 0)
})

await check('预算不够时从最老的开始省，并写明省略了几条', () => {
  const items = pickUnread(Array.from({ length: 60 }, (_, i) => rawMsg({
    id: i + 1, text: `第${i + 1}条` + '填充'.repeat(30), time: 1_790_000_000 + i,
  })), {})
  const out = formatTranscript(items, { budgetTokens: 3000, perMessageChars: 200 })
  assert.ok(out.dropped > 0, '应该省略了一部分')
  assert.match(out.text, /更早的 \d+ 条因预算省略/u)
  assert.match(out.text, /第60条/u, '最新的那条必须还在')
  assert.ok(!/第1条/u.test(out.text), '最老的应该被省掉')
})

await check('单条超字数会被截断加省略号', () => {
  const items = pickUnread([rawMsg({ id: 1, text: '长'.repeat(500), time: 1_000 })], {})
  const out = formatTranscript(items, { perMessageChars: 50 })
  assert.ok(out.text.includes('…'))
  assert.ok(out.text.length < 200)
})

console.log('\n── 五、提示词与节点切分 ─────────────────────────')

await check('提示词已改成结构化简报口径，并写明话题数/字数上限', () => {
  const prompt = buildSummaryPrompt({ groupName: '测试群', total: 12, transcript: 'A: 1', maxNodes: 4, nodeChars: 200 })
  assert.match(prompt, /专业的群聊管家/u)
  // maxNodes=4 → 头部+尾部占 2，最多 2 个话题。
  assert.match(prompt, /最多 2 个话题/u)
  assert.match(prompt, /不超过 200 字|200 字以内/u)
  assert.match(prompt, /只会留文本占位|不要描述图片内容|记录里的图片/u)
  assert.match(prompt, /【群】测试群/u)
})

await check('按 `---` 切段；空段与纯分隔行被丢掉', () => {
  const nodes = splitSummaryNodes('第一段\n---\n\n---\n第二段\n---\n第三段')
  assert.deepEqual(nodes, ['第一段', '第二段', '第三段'])
})

await check('JSON 数组与代码围栏也能解析', () => {
  assert.deepEqual(splitSummaryNodes('```json\n["甲","乙"]\n```'), ['甲', '乙'])
})

await check('段数超上限时并进最后一段（不静默丢内容）', () => {
  const nodes = splitSummaryNodes('一\n---\n二\n---\n三\n---\n四', { maxNodes: 3 })
  assert.equal(nodes.length, 3)
  assert.match(nodes.at(-1), /四/u)
})

await check('单段超字数被截断', () => {
  const nodes = splitSummaryNodes('长'.repeat(900), { nodeChars: 100 })
  assert.equal(nodes.length, 1)
  assert.ok(nodes[0].endsWith('…'))
})

await check('空回复 = 空数组（调用方据此判失败）', () => {
  assert.deepEqual(splitSummaryNodes('   '), [])
  assert.deepEqual(splitSummaryNodes('---'), [])
})

await check('nodes 结构符合 NapCat 的 OB11MessageNodeSchema', () => {
  const nodes = buildForwardNodes(['一', '二'], { botName: '小鱼', botUin: SELF })
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].type, 'node')
  assert.equal(nodes[0].data.nickname, '小鱼')
  assert.equal(nodes[0].data.user_id, SELF)
  assert.equal(nodes[0].data.content[0].type, 'text')
  assert.equal(nodes[0].data.content[0].data.text, '一')
  // 没有 uin 时不能塞一个空串进去
  assert.equal(buildForwardNodes(['一'], {})[0].data.user_id, undefined)
})

console.log('\n── 六、水位推进 ─────────────────────────────────')

await check('nextWatermark 取最大 (时间, 序号)，空列表保持原值', () => {
  const items = pickUnread([
    rawMsg({ id: 5, time: 1000 }), rawMsg({ id: 9, time: 2000 }),
  ], {})
  assert.deepEqual(nextWatermark(items, {}), { lastSummarySeq: 9, lastSummaryAt: 2000 })
  assert.deepEqual(nextWatermark([], { lastSummarySeq: 9, lastSummaryAt: 2000 }),
    { lastSummarySeq: 9, lastSummaryAt: 2000 })
})

console.log('\n── 七、权限分阶（主人 / 管理员）──────────────────')

await check('主人自动算管理员；管理员不是主人', () => {
  const b = makeBridge()
  assert.equal(b.isOwner({ userId: OWNER }), true)
  assert.equal(b.isAdmin({ userId: OWNER }), true)
  assert.equal(b.isAdmin({ userId: ADMIN }), true)
  assert.equal(b.isOwner({ userId: ADMIN }), false)
  assert.equal(b.isOwner({ userId: '999' }), false)
})

await check('管理员发 /归纳 被拒，且不跑归纳', async () => {
  const b = makeBridge()
  const fake = fakeRuntime(b)
  const handled = await b._handleUnreadSummaryCommand(ownerMsg({ userId: ADMIN }), '/归纳', `g:${GROUP}`)
  assert.equal(handled, true)
  assert.match(fake.sent[0].text, /只有主人/u)
  assert.equal(fake.forwards.length, 0)
})

await check('私聊里发 /归纳 只回提示，不拉历史', async () => {
  const b = makeBridge()
  const fake = fakeRuntime(b)
  await b._handleUnreadSummaryCommand(ownerMsg({ kind: 'private', userId: OWNER }), '/归纳', `u:${OWNER}`)
  assert.match(fake.privates[0].text, /只能在群里用/u)
  assert.equal(fake.forwards.length, 0)
})

await check('技能关掉时回提示、不花 token', async () => {
  const b = makeBridge({ unreadSummary: { enabled: false } })
  const fake = fakeRuntime(b)
  await b._handleUnreadSummaryCommand(ownerMsg(), '/归纳', `g:${GROUP}`)
  assert.match(fake.sent[0].text, /已关闭/u)
  assert.equal(fake.forwards.length, 0)
})

console.log('\n── 八、端到端（假 OneBot / 假 DSH）───────────────')

await check('成功：合并转发 3 段 → 推水位 → 归档临时会话', async () => {
  const b = makeBridge()
  const history = Array.from({ length: 5 }, (_, i) => rawMsg({ id: i + 1, text: `话${i + 1}`, time: 1_790_000_000 + i }))
  const fake = fakeRuntime(b, {
    history,
    reply: '主线：搬家\n---\n周末下雨\n---\n缺人手',
  })
  await b._runUnreadSummary({ msg: ownerMsg(), key: `g:${GROUP}`, count: 50, conf: b._summaryConfig() })
  assert.equal(fake.forwards.length, 1)
  assert.equal(fake.forwards[0].nodes.length, 3)
  const water = b._summaryState(`g:${GROUP}`)
  assert.equal(water.lastSummaryAt, 1_790_000_004)
  assert.equal(water.lastSummarySeq, 5)
  assert.equal(water.runs, 1)
  assert.deepEqual(fake.archive, ['sess-summary-1'])
  assert.match(b._lastPrompt, /【群】测试群/u)
})

await check('合并没有新消息时不动水位、只回一句', async () => {
  const b = makeBridge()
  const history = [rawMsg({ id: 1, text: '旧', time: 1000 })]
  const fake = fakeRuntime(b, { history })
  b._summaryState(`g:${GROUP}`).lastSummaryAt = 5000
  b._summaryState(`g:${GROUP}`).lastSummarySeq = 1
  await b._runUnreadSummary({ msg: ownerMsg(), key: `g:${GROUP}`, count: 50, conf: b._summaryConfig() })
  assert.equal(fake.forwards.length, 0)
  assert.match(fake.sent[0].text, /没有未归纳的新消息/u)
  assert.equal(b._summaryState(`g:${GROUP}`).lastSummaryAt, 5000, '水位不能被推进')
})

await check('合并转发失败 → 降级纯文本，仍旧推进水位', async () => {
  const b = makeBridge()
  const fake = fakeRuntime(b, {
    history: [rawMsg({ id: 7, text: '一句话', time: 2000 })],
    reply: '一段就行',
    forwardOk: false,
  })
  await b._runUnreadSummary({ msg: ownerMsg(), key: `g:${GROUP}`, count: 50, conf: b._summaryConfig() })
  assert.equal(fake.forwards.length, 1)
  assert.equal(fake.sent.length, 1)
  assert.match(fake.sent[0].text, /【群聊归纳】/u)
  assert.match(fake.sent[0].text, /一段就行/u)
  assert.equal(b._summaryState(`g:${GROUP}`).lastSummarySeq, 7)
})

await check('模型失败 → 私聊通知主人（带冷却）→ 不推水位', async () => {
  const b = makeBridge()
  const fake = fakeRuntime(b, {
    history: [rawMsg({ id: 8, text: '一句话', time: 3000 })],
    promptError: Object.assign(new Error('看门狗切断'), { code: 'WATCHDOG_TIMEOUT' }),
  })
  await b._runUnreadSummary({ msg: ownerMsg(), key: `g:${GROUP}`, count: 50, conf: b._summaryConfig() })
  assert.equal(fake.forwards.length, 0)
  assert.equal(fake.privates.length, 1, '应该只通知一次')
  assert.equal(fake.privates[0].userId, OWNER)
  assert.match(fake.privates[0].text, /WATCHDOG_TIMEOUT/u)
  assert.equal(b._summaryState(`g:${GROUP}`).lastSummarySeq, 0, '失败不能推水位')
  assert.ok(b._summaryState(`g:${GROUP}`).lastError.includes('WATCHDOG_TIMEOUT'))

  // 冷却期内再失败一次：不再私聊
  await b._runUnreadSummary({ msg: ownerMsg(), key: `g:${GROUP}`, count: 50, conf: b._summaryConfig() })
  assert.equal(fake.privates.length, 1, '1 小时内不重复轰炸')
})

await check('拉历史失败 → 通知主人、群里只说人话（不透传英文报错）', async () => {
  const b = makeBridge()
  const fake = fakeRuntime(b)
  b.qq.getGroupMsgHistory = async () => ({ ok: false, messages: [], reason: 'call get_group_msg_history 超时（15000ms）' })
  await b._runUnreadSummary({ msg: ownerMsg(), key: `g:${GROUP}`, count: 50, conf: b._summaryConfig() })
  assert.match(fake.privates[0].text, /HISTORY_FAILED/u)
  assert.match(fake.sent.at(-1).text, /没跑成功/u)
  assert.ok(!/超时|timeout/iu.test(fake.sent.at(-1).text), '群里不能出现技术报错')
})

await check('图片检索默认关：不带 image part', async () => {
  const b = makeBridge()
  const fake = fakeRuntime(b, { history: [rawMsg({ id: 3, text: '看图', time: 4000, images: ['http://x/a.jpg'] })] })
  await b._runUnreadSummary({ msg: ownerMsg(), key: `g:${GROUP}`, count: 50, conf: b._summaryConfig() })
  assert.equal(b._lastPromptOpts.content, null)
  assert.equal(fake.forwards.length, 1)
})

console.log('\n— 结构化简报（v2.0 第二步，2026-10-28）—')

const STRUCTURED_REPLY = [
  '128 条消息，群内氛围热烈，主要围绕 Apex 排位与晚饭。',
  '【Apex 排位组队】',
  '🕒 时间：20:15 - 21:40',
  '👥 参与人：小明、小红',
  '📝 总结：三排冲分两胜一负，约好明晚继续。',
  '💬 锐评/金句：阿强：「再输我就去写作业。」',
  '【晚饭吃什么】',
  '🕒 时间：21:40 - 22:00',
  '👥 参与人：阿强、小明',
  '📝 总结：最后点了烧烤，没分歧。',
  '💬 锐评/金句：废话半小时，饿着点单。',
].join('\n')

await check('Prompt 已换成结构化简报口径（管家 / 总览 / 四行话题 / 禁 Markdown）', () => {
  const prompt = buildSummaryPrompt({ groupName: '鱼塘', total: 50, transcript: '[10-28 20:15] 小明: 上号' })
  assert.match(prompt, /专业的群聊管家/u)
  assert.match(prompt, /先写一句总览/u)
  assert.match(prompt, /🕒 时间：XX:XX - XX:XX/u)
  assert.match(prompt, /最多 3-5 个核心话题/u)
  assert.match(prompt, /不要包含任何多余的 Markdown/u)
})

await check('parseStructuredSummary：总览 + 两个话题，字段原样保留', () => {
  const parsed = parseStructuredSummary(STRUCTURED_REPLY)
  assert.ok(parsed, '应能解析')
  assert.match(parsed.overview, /128 条消息/u)
  assert.equal(parsed.topics.length, 2)
  assert.equal(parsed.topics[0].title, 'Apex 排位组队')
  assert.match(parsed.topics[0].body, /🕒 时间：20:15 - 21:40/u)
})

await check('结构化回复 → 头部 / 每话题一条 / 尾部，node 数 > 1', () => {
  const nodes = buildForwardNodes(STRUCTURED_REPLY, { botName: SUMMARY_NODE_NAME, maxNodes: 8 })
  assert.ok(nodes.length > 1, `node 数应大于 1，实际 ${nodes.length}`)
  const texts = nodes.map((node) => forwardNodeText(node))
  assert.equal(texts.length, 4, '头部 + 2 话题 + 尾部')
  assert.match(texts[0], /群聊总结报告/u)
  assert.match(texts[0], /128 条消息/u)
  assert.match(texts[1], /【Apex 排位组队】/u)
  assert.match(texts[1], /🕒 时间：/u)
  assert.match(texts[2], /【晚饭吃什么】/u)
  assert.equal(texts[3], SUMMARY_FOOTER)
  for (const node of nodes) {
    assert.equal(node.type, 'node')
    assert.equal(node.data.nickname, SUMMARY_NODE_NAME, '★ 发件人统一为群聊小助手')
  }
})

await check('话题数超过 maxNodes-2：并进最后一条，总 node 数不超上限', () => {
  const many = Array.from({ length: 5 }, (_, i) =>
    `【话题${i + 1}】\n🕒 时间：10:0${i} - 10:1${i}\n📝 总结：第${i + 1}件事。`).join('\n')
  const nodes = buildForwardNodes(`总览一句。\n${many}`, { maxNodes: 6, nodeChars: 2000 })
  assert.ok(nodes.length <= 6, `不能超过 maxNodes，实际 ${nodes.length}`)
  const lastTopic = forwardNodeText(nodes[nodes.length - 2])
  assert.match(lastTopic, /【话题5】/u, '被裁掉的话题要并进最后一条，不能丢')
})

await check('格式不对 → 退回旧的 --- 切分，不报错、不加尾部', () => {
  const nodes = buildForwardNodes('一大段废话，没有标题也没有字段。', { maxNodes: 6 })
  assert.equal(nodes.length, 1)
  assert.match(forwardNodeText(nodes[0]), /一大段废话/u)
  assert.ok(!nodes.map((node) => forwardNodeText(node)).includes(SUMMARY_FOOTER), '降级路径不该凭空加尾部')
})

await check('只有【标题】没有字段 → 也降级（防止把废话加括号当简报）', () => {
  const nodes = buildForwardNodes('【看起来像标题】\n这里是随便一段废话', { maxNodes: 6 })
  assert.equal(nodes.length, 1)
  assert.match(forwardNodeText(nodes[0]), /随便一段废话/u)
})

await check('旧数组入参保持原行为（兼容既有调用）', () => {
  const nodes = buildForwardNodes(['第一段', '第二段'], { botName: '群聊归纳' })
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].data.nickname, '群聊归纳')
})

await check('端到端：模型返回结构化 → 合并转发多段且带时间字段', async () => {
  const b = makeBridge()
  const fake = fakeRuntime(b, {
    history: [rawMsg({ id: 11, text: '上号', time: 5000 }), rawMsg({ id: 12, text: '吃啥', time: 5100 })],
    reply: STRUCTURED_REPLY,
  })
  await b._runUnreadSummary({ msg: ownerMsg(), key: `g:${GROUP}`, count: 50, conf: b._summaryConfig() })
  assert.equal(fake.forwards.length, 1)
  const forwarded = fake.forwards[0].nodes
  assert.ok(forwarded.length > 1, '★ 应切成多段发出')
  const joined = forwarded.map((node) => forwardNodeText(node)).join('\n')
  assert.match(joined, /🕒 时间：/u)
  assert.match(joined, /【Apex/u)
  assert.equal(b._summaryState(`g:${GROUP}`).lastSummarySeq, 12, '多段也要正常推水位')
})

console.log('\n— 「群聊管家」独立人设（v2.0 第三步，2026-10-28）—')

await check('人设与 Prompt 都带覆写句', () => {
  assert.match(SUMMARY_PERSONA, /群聊管家/u)
  assert.ok(SUMMARY_PERSONA.includes(SUMMARY_OVERRIDE_NOTE), '人设里要原样带上覆写句')
  assert.match(SUMMARY_PERSONA, /忽略之前设定的所有暴躁\/傲娇规则/u)
  const prompt = buildSummaryPrompt({ groupName: '鱼塘', total: 10, transcript: 'A: 1' })
  assert.ok(prompt.trimEnd().endsWith(SUMMARY_OVERRIDE_NOTE), '★ Prompt 末尾必须压覆写句')
})

await check('临时会话创建后先推管家人生设，再提问', async () => {
  const b = makeBridge()
  const fake = fakeRuntime(b, {
    history: [rawMsg({ id: 21, text: '上号', time: 6000 })],
    reply: STRUCTURED_REPLY,
  })
  await b._runUnreadSummary({ msg: ownerMsg(), key: `g:${GROUP}`, count: 50, conf: b._summaryConfig() })
  const pushed = fake.personas.filter((p) => p.sessionId === 'sess-summary-1' && p.text !== '')
  assert.equal(pushed.length, 1, '应推一次非空人设')
  assert.match(pushed[0].text, /群聊管家/u)
  const personaAt = fake.events.findIndex((e) => e[0] === 'persona' && e[1] === 'sess-summary-1')
  const promptAt = fake.events.findIndex((e) => e[0] === 'prompt')
  assert.ok(personaAt >= 0 && personaAt < promptAt, '★ 必须先换人设再提问')
  // QQ 群会话自己的单人设不能被写坏（管家只作用在临时会话上）。
  assert.equal(String(b.state.sessions[`g:${GROUP}`]?.persona ?? ''), '')
})

await check('临时会话归档后人设条目被清掉（不堆内存）', async () => {
  const b = makeBridge()
  const fake = fakeRuntime(b, { history: [rawMsg({ id: 22, text: '在', time: 7000 })] })
  await b._runUnreadSummary({ msg: ownerMsg(), key: `g:${GROUP}`, count: 50, conf: b._summaryConfig() })
  await new Promise((r) => setImmediate(r))
  assert.ok(fake.personas.some((p) => p.sessionId === 'sess-summary-1' && p.text === ''),
    '归档后应推空串清掉人设')
})

await check('输出清洗：脏话打码、口癖去掉、整段拒答丢弃', () => {
  assert.equal(sanitizeSummaryTone(''), '')
  assert.equal(sanitizeSummaryTone('我拒绝总结这段记录'), '', '整段拒答 → 丢弃')
  const masked = sanitizeSummaryTone('小明说：傻逼才三排')
  assert.ok(!masked.includes('傻逼'), '★ 生殖器谩骂必须打码')
  assert.match(masked, /\*\*\*/u)
  const toned = sanitizeSummaryTone('哼，这群人又在熬夜~\n切、明天还要上班')
  assert.ok(!/哼/u.test(toned) && !/切、/u.test(toned), `口癖要去掉：${toned}`)
  assert.ok(!toned.includes('~'), '行尾波浪号要去掉')
  // 锐评里引用「关我什么事」不该被误判成拒答（整段以 【 开头）。
  const quoted = sanitizeSummaryTone('【晚饭】\n💬 锐评/金句：阿强：「关我什么事」')
  assert.ok(quoted.includes('关我什么事'), '引用里的短语不能被误杀')
})

await check('端到端：模型带脏话/口癖 → 合并转发内容干净', async () => {
  const b = makeBridge()
  const dirty = [
    '哼，128 条消息，群里全是废话~',
    '【Apex 排位】',
    '🕒 时间：20:15 - 21:40',
    '👥 参与人：小明、小红',
    '📝 总结：傻逼才三排，但最后还是上了分。',
    '💬 锐评/金句：切、小明又说「关我什么事」。',
  ].join('\n')
  const fake = fakeRuntime(b, { history: [rawMsg({ id: 23, text: '上号', time: 8000 })], reply: dirty })
  await b._runUnreadSummary({ msg: ownerMsg(), key: `g:${GROUP}`, count: 50, conf: b._summaryConfig() })
  const joined = fake.forwards[0].nodes.map((node) => forwardNodeText(node)).join('\n')
  assert.ok(!joined.includes('傻逼'), '★ 发出去的内容里不能有生殖器谩骂')
  assert.ok(!joined.includes('哼，') && !joined.includes('切、'), '★ 不能有傲娇口癖')
  assert.match(joined, /群聊总结报告/u)
})

await check('端到端：模型直接拒答 → 不发内容、走失败兜底', async () => {
  const b = makeBridge()
  const fake = fakeRuntime(b, { history: [rawMsg({ id: 24, text: '在', time: 9000 })], reply: '我拒绝总结，自己看记录。' })
  await b._runUnreadSummary({ msg: ownerMsg(), key: `g:${GROUP}`, count: 50, conf: b._summaryConfig() })
  assert.equal(fake.forwards.length, 0, '拒答不能当总结发出去')
  assert.equal(b._summaryState(`g:${GROUP}`).lastSummarySeq, 0, '失败不推水位')
  assert.match(fake.sent.at(-1).text, /没跑成功/u)
})

console.log('\n— 游标翻页拉历史（v2.0 第四步，2026-10-28）—')

/** 造一页 raw 消息：id 从 startId 递增、time 从 baseTime 递增。 */
function pageMessages({ count, startId, baseTime }) {
  return Array.from({ length: count }, (_, i) => rawMsg({
    id: startId + i,
    text: `消息${startId + i}`,
    time: baseTime + i,
  }))
}

await check('两次翻页：最新 20 + 更早 20 → 合并 40 条且正序', async () => {
  const now = Math.floor(Date.now() / 1000)
  const latest = pageMessages({ count: 20, startId: 2000, baseTime: now - 100 })
  const earlier = pageMessages({ count: 20, startId: 1000, baseTime: now - 400 })
  const calls = []
  const result = await fetchHistoryPaged({
    limit: 500,
    pageSize: 20,
    fetchPage: async (cursor, count) => {
      calls.push({ cursor, count })
      if (cursor === '') return { ok: true, messages: latest }
      if (cursor === '2000') return { ok: true, messages: earlier }
      return { ok: true, messages: [] }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.messages.length, 40, '★ 两页必须合并成 40 条')
  assert.equal(result.pages, 3, '第三次空页用于确认翻到头')
  assert.deepEqual(calls.map((item) => item.cursor), ['', '2000', '1000'],
    '游标应按「本页最早一条的 message_seq」推进')
  const times = result.messages.map((message) => Number(message.time))
  assert.deepEqual([...times].sort((a, b) => a - b), times, '★ 输出必须是正序')
})

await check('空页立刻停（不空转）', async () => {
  let calls = 0
  const result = await fetchHistoryPaged({
    limit: 500,
    pageSize: 20,
    fetchPage: async () => { calls += 1; return { ok: true, messages: [] } },
  })
  assert.equal(result.ok, true)
  assert.equal(result.messages.length, 0)
  assert.equal(calls, 1, '★ 空数组必须立刻 break')
})

await check('游标不推进 → 立刻 break（防死循环）', async () => {
  let calls = 0
  const same = pageMessages({ count: 5, startId: 3000, baseTime: 1000 })
  const result = await fetchHistoryPaged({
    limit: 500,
    pageSize: 20,
    fetchPage: async () => { calls += 1; return { ok: true, messages: same } },
  })
  assert.equal(result.messages.length, 5)
  assert.ok(calls <= 2, `接口忽略游标时最多再打一次，实际 ${calls} 次`)
})

await check('达到 limit 就停，且只保留最新的一段', async () => {
  const pages = {
    '': pageMessages({ count: 20, startId: 5000, baseTime: 500 }),
    5000: pageMessages({ count: 20, startId: 4000, baseTime: 400 }),
  }
  let calls = 0
  const result = await fetchHistoryPaged({
    limit: 25,
    pageSize: 20,
    fetchPage: async (cursor) => {
      calls += 1
      return { ok: true, messages: pages[cursor] ?? [] }
    },
  })
  assert.equal(result.messages.length, 25, '★ 不能超过 limit')
  assert.equal(calls, 2)
  const ids = result.messages.map((message) => Number(message.message_id))
  assert.ok(ids.includes(5000) && ids.includes(5019), '最新一页要保留')
  assert.ok(!ids.includes(4000), '更旧的被截掉')
})

await check('翻到 startTime 之前就停（时间窗模式）', async () => {
  const pages = {
    '': pageMessages({ count: 20, startId: 7000, baseTime: 2000 }),
    7000: pageMessages({ count: 20, startId: 6000, baseTime: 1000 }),
  }
  let calls = 0
  const result = await fetchHistoryPaged({
    limit: 500,
    pageSize: 20,
    startTimeSec: 1500,
    fetchPage: async (cursor) => {
      calls += 1
      return { ok: true, messages: pages[cursor] ?? [] }
    },
  })
  assert.equal(calls, 2, '第二页已越过起点，不该再请求第三页')
  assert.equal(result.messages.length, 40, '越界那页仍保留（交给水位再筛）')
})

await check('中途某页失败 → ok:false，不返回半截数据', async () => {
  const result = await fetchHistoryPaged({
    limit: 100,
    pageSize: 20,
    fetchPage: async (cursor) => (cursor === ''
      ? { ok: true, messages: pageMessages({ count: 20, startId: 1, baseTime: 1 }) }
      : { ok: false, messages: [], reason: 'retcode=1200' }),
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.messages, [], '半截数据会让水位误推进，必须整次失败')
  assert.match(result.reason, /1200/u)
})

await check('端到端：/归纳 1h 翻两页，40 条都进 prompt', async () => {
  const b = makeBridge()
  const now = Math.floor(Date.now() / 1000)
  const latest = pageMessages({ count: 20, startId: 2000, baseTime: now - 100 })
  const earlier = pageMessages({ count: 20, startId: 1000, baseTime: now - 400 })
  const calls = []
  const fake = fakeRuntime(b, { history: [], reply: STRUCTURED_REPLY })
  b.qq.getGroupMsgHistory = async (gid, count, opts = {}) => {
    const cursor = String(opts.messageSeq ?? '')
    calls.push({ gid, count, cursor })
    if (cursor === '') return { ok: true, messages: latest }
    if (cursor === '2000') return { ok: true, messages: earlier }
    return { ok: true, messages: [] }
  }
  await b._handleUnreadSummaryCommand(ownerMsg({ text: '/归纳 1h' }), '/归纳 1h', `g:${GROUP}`)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.match(fake.sent[0].text, /1 小时/u, 'ack 要说清楚是时间窗')
  assert.equal(fake.forwards.length, 1)
  assert.match(b._lastPrompt, /【消息条数】40/u, '★ 两页 40 条都要进 prompt')
  assert.deepEqual(calls.map((item) => item.cursor), ['', '2000', '1000'])
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
