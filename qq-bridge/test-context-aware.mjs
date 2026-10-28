/**
 * 上下文感知 / 时间感知 / 聊天记录读图上限（2026-10-27，离线）。
 *
 * 锁死的约定：
 *   ① `quote.forwardMaxImages` 控制合并转发最多读几张图（默认 3，0~10；0 = 只留占位）；
 *   ② `contextAware.pokeTurns` 控制戳一戳「模型回复」注入多少条（旧配置的 `turns` 仍兼容）；
 *   ③ `contextAware.messageTurns` 控制普通消息额外注入多少条（默认 0 = 交给 DSH 原生）；
 *   ④ 注入**严格按会话 key 隔离**（g:群号 / u:QQ号 各自一份，互不串）；
 *   ⑤ `poke.mode = 'model'`：注入 + 调模型 + 发回；模型失败退回固定文案，绝不静默；
 *   ⑥ `timeAware`：静默超过阈值后有人说话，prompt 末尾注入提示（N 替换成实际分钟数）；
 *   ⑦ 本轮自己刚发的消息不会被当成「历史记录」再注入一遍；
 *   ⑧ 注入做**双重截断**（2026-10-27 合并版）：条数上限 ∩ token 预算，超了从最老的开始砍。
 *
 * 运行：node test-context-aware.mjs
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { Bridge, estimateTokens, truncateChatLine } from './src/bridge.mjs'

let pass = 0
let fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

function makeBridge({ poke, quote, contextAware, timeAware, memory } = {}) {
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: {
        private: ['1000000001'], groups: ['123456', '654321'], admins: [],
        allowAllWhenEmpty: false,
      },
      sendDelayMs: 0,
      stateFile: path.join(os.tmpdir(), `qq-ctx-state-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
      rhythm: { activityLevel: 3, debounceWindowMs: 0 },
      poke: { delayMinMs: 0, delayMaxMs: 0, ...(poke ?? {}) },
      ...(quote === undefined ? {} : { quote }),
      ...(contextAware === undefined ? {} : { contextAware }),
      ...(timeAware === undefined ? {} : { timeAware }),
      ...(memory === undefined ? {} : { memory }),
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  const calls = { prompts: [], sent: [], warns: [], sessions: 0 }
  b.dsh = {
    sessionExists: async () => true,
    ensureWorkspace: async () => 'w1',
    createSession: async () => `s${++calls.sessions}`,
    setSessionModel: async () => ({}),
    archiveSession: async () => ({ ok: true }),
    renameSession: async (sid, title) => title,
    sessionTitle: async () => null,
    setSessionPersona: async () => ({ ok: true }),
    promptAndWait: async (sid, text, opts) => {
      calls.prompts.push({ sid, text, opts })
      return calls.reply ?? '好呀'
    },
    call: async () => ({}),
  }
  b.logger = { info() {}, warn: (m) => calls.warns.push(String(m)), error() {} }
  b.qq.call = async () => ({ status: 'ok', data: {} })
  b.qq.sendPrivate = async (uid, text) => { calls.sent.push({ kind: 'private', uid, text }); return { ok: true } }
  b.qq.sendGroup = async (gid, text) => { calls.sent.push({ kind: 'group', gid, text }); return { ok: true } }
  b.qq.sendPoke = async () => ({ ok: true, action: 'group_poke', retcode: 0 })
  b.qq.nameOf = () => '小明'
  b.qq._selfId = '999'
  // 图片理解关掉：这些用例只验证文本上下文，不碰下载 / 多模态。
  b.live.features = { ...(b.live.features ?? {}), vision: false, time: true }
  return { b, calls }
}

/** 造一条通过白名单的普通消息（群聊 / 私聊）。 */
function chatMsg(text, { kind = 'group', id = '123456', userId = '1000000001' } = {}) {
  return {
    kind,
    groupId: kind === 'group' ? id : null,
    userId,
    senderName: '小明',
    text,
    images: [],
    time: Date.now(),
    raw: { message: text ? [{ type: 'text', data: { text } }] : [] },
  }
}

/** 直接往会话缓冲塞记录（模拟群友说过话）。 */
function seedChat(b, key, rows) {
  const now = Date.now()
  b._chatLog.set(key, rows.map((text, i) => ({
    name: `群友${i}`, qq: `100000000${i}`, text, at: now - (rows.length - i) * 1000,
    kind: key.startsWith('u:') ? 'private' : 'group', seq: ++b._chatLogSeq,
  })))
}

const pokeNotice = ({ userId = '1000000001', groupId = '123456' } = {}) => ({
  kind: 'poke', userId, targetId: '999', groupId, selfId: '999', time: 1, raw: {},
})

console.log('上下文感知 / 聊天记录读图上限：')

await check('quote.forwardMaxImages 默认 3；配置 5 就取 5；配置 99 夹到 10', async () => {
  const d = makeBridge()
  assert.equal(d.b._quoteConfig().forwardMaxImages, 3)
  const f = makeBridge({ quote: { forwardMaxImages: 5 } })
  assert.equal(f.b._quoteConfig().forwardMaxImages, 5)
  const big = makeBridge({ quote: { forwardMaxImages: 99 } })
  assert.equal(big.b._quoteConfig().forwardMaxImages, 10)
})

await check('forwardMaxImages = 0 → 一张图都不提取，文本里仍留占位', async () => {
  const { b } = makeBridge({ quote: { forwardMaxImages: 0 } })
  b.qq.getForwardMsg = async () => ({
    ok: true,
    nodes: [{
      sender: { nickname: '张三' },
      content: '[CQ:image,file=a.jpg,url=https://x/a.jpg]',
    }],
  })
  const result = await b._expandForwards({ forwardIds: ['f0'], inlineNodes: [] })
  assert.equal(result.images.length, 0)
  assert.ok(result.text.includes('［图片］'), result.text)
})

await check('forwardMaxImages = 5 → 最多收 5 张（6 张里丢最后一张）', async () => {
  const { b } = makeBridge({ quote: { forwardMaxImages: 5 } })
  b.qq.getForwardMsg = async () => ({
    ok: true,
    nodes: [{
      sender: { nickname: '张三' },
      content: Array.from({ length: 6 }, (_, i) => `[CQ:image,file=${i}.jpg,url=https://x/${i}.jpg]`).join(''),
    }],
  })
  const result = await b._expandForwards({ forwardIds: ['f5'], inlineNodes: [] })
  assert.equal(result.images.length, 5, `应只收 5 张，实际 ${result.images.length}`)
  assert.equal(result.totalImages, 6)
})

await check('_recentChatLines：按 key 隔离，另一个群拿不到本群记录', () => {
  const { b } = makeBridge()
  seedChat(b, 'g:123456', ['A1', 'A2'])
  seedChat(b, 'g:654321', ['B1'])
  assert.deepEqual(b._recentChatLines('g:123456', 15).map((x) => x.split(': ')[1]), ['A1', 'A2'])
  assert.deepEqual(b._recentChatLines('g:654321', 15).map((x) => x.split(': ')[1]), ['B1'])
})

await check('_recentChatLines：turns 只取最近 N 条；0 返回空', () => {
  const { b } = makeBridge()
  seedChat(b, 'g:123456', ['1', '2', '3', '4', '5'])
  assert.equal(b._recentChatLines('g:123456', 2).length, 2)
  assert.ok(b._recentChatLines('g:123456', 2).at(-1).endsWith('5'))
  assert.deepEqual(b._recentChatLines('g:123456', 0), [])
})

await check('model 模式：注入最近记录，并把模型回复发到 QQ', async () => {
  const { b, calls } = makeBridge({ poke: { mode: 'model' } })
  seedChat(b, 'g:123456', ['机器就该像机器那样活着', '你说呢'])
  await b.handleNotice(pokeNotice())
  assert.equal(calls.prompts.length, 1, '应调用一次模型')
  const prompt = calls.prompts[0].text
  assert.ok(prompt.includes('机器就该像机器那样活着'), prompt)
  assert.ok(prompt.includes('你说呢'), prompt)
  assert.deepEqual(calls.sent.map((x) => x.text), ['好呀'])
})

await check('model 模式：上下文感知关闭 → 不注入记录', async () => {
  const { b, calls } = makeBridge({ poke: { mode: 'model' }, contextAware: { enabled: false } })
  seedChat(b, 'g:123456', ['不该出现的一句'])
  await b.handleNotice(pokeNotice())
  const prompt = calls.prompts[0].text
  assert.ok(!prompt.includes('不该出现的一句'), prompt)
  assert.ok(prompt.includes('戳了你一下'), prompt)
})

await check('model 模式：turns=0（旧字段）等同关闭注入', async () => {
  const { b, calls } = makeBridge({ poke: { mode: 'model' }, contextAware: { turns: 0 } })
  seedChat(b, 'g:123456', ['也不该出现'])
  await b.handleNotice(pokeNotice())
  assert.ok(!calls.prompts[0].text.includes('也不该出现'))
})

await check('model 模式：pokeTurns=0 等同关闭；messageTurns 不影响戳一戳', async () => {
  const { b, calls } = makeBridge({
    poke: { mode: 'model' },
    contextAware: { pokeTurns: 0, messageTurns: 15 },
  })
  seedChat(b, 'g:123456', ['不该出现在戳一戳里'])
  await b.handleNotice(pokeNotice())
  assert.ok(!calls.prompts[0].text.includes('不该出现在戳一戳里'))
})

await check('model 模式：按会话隔离——群 A 的戳一戳看不到群 B 的记录', async () => {
  const { b, calls } = makeBridge({ poke: { mode: 'model' } })
  seedChat(b, 'g:654321', ['B 群的秘密'])
  await b.handleNotice(pokeNotice({ groupId: '123456' }))
  assert.ok(!calls.prompts[0].text.includes('B 群的秘密'), '不能串群')
})

await check('model 模式：模型失败 → 退回固定文案，不静默', async () => {
  const { b, calls } = makeBridge({
    poke: { mode: 'model', replyText: '（脑子卡住了）' },
  })
  b.dsh.promptAndWait = async () => { throw new Error('TIMEOUT') }
  await b.handleNotice(pokeNotice())
  assert.deepEqual(calls.sent.map((x) => x.text), ['（脑子卡住了）'])
})

await check('model 模式：私聊不注入群聊缓冲', async () => {
  const { b, calls } = makeBridge({ poke: { mode: 'model' } })
  seedChat(b, 'u:1000000001', ['私聊不该有群记录'])
  await b.handleNotice(pokeNotice({ groupId: null }))
  assert.ok(!calls.prompts[0].text.includes('私聊不该有群记录'))
})

await check('withAction 在 model 模式下也生效（先戳再让模型说话）', async () => {
  const { b, calls } = makeBridge({ poke: { mode: 'model', withAction: true } })
  let poked = 0
  b.qq.sendPoke = async () => { poked++; return { ok: true, action: 'group_poke', retcode: 0 } }
  await b.handleNotice(pokeNotice())
  assert.equal(poked, 1, '应先真实回戳')
  assert.equal(calls.prompts.length, 1)
})

console.log('\n上下文感知 messageTurns / 时间感知：')

await check('messageTurns=0（默认）→ 普通消息 prompt 不带聊天记录小节', async () => {
  const { b, calls } = makeBridge()
  seedChat(b, 'g:123456', ['之前的闲聊'])
  await b.handleMessage(chatMsg('在吗'))
  assert.equal(calls.prompts.length, 1)
  assert.ok(!calls.prompts[0].text.includes('之前的闲聊'), calls.prompts[0].text)
})

await check('messageTurns=3 → 注入最近 3 条，且本轮自己那句不重复', async () => {
  const { b, calls } = makeBridge({ contextAware: { messageTurns: 3, smartMatch: false } })
  seedChat(b, 'g:123456', ['旧1', '旧2', '旧3', '旧4'])
  await b.handleMessage(chatMsg('新的一句'))
  const prompt = calls.prompts[0].text
  assert.ok(prompt.includes('本会话最近 3 条聊天记录'), prompt)
  assert.ok(prompt.includes('旧4') && prompt.includes('旧3') && prompt.includes('旧2'), prompt)
  assert.ok(!prompt.includes('旧1'), '只该取最近 3 条')
  assert.equal(prompt.split('新的一句').length - 1, 1, `本轮消息不该出现在历史小节里：${prompt}`)
})

await check('messageTurns：私聊也注入（私聊上下文同样有缓冲）', async () => {
  const { b, calls } = makeBridge({ contextAware: { messageTurns: 2, smartMatch: false } })
  seedChat(b, 'u:1000000001', ['私聊上一句'])
  await b.handleMessage(chatMsg('接着聊', { kind: 'private', id: null, userId: '1000000001' }))
  const prompt = calls.prompts[0].text
  assert.ok(prompt.includes('私聊上一句'), prompt)
  assert.ok(prompt.includes('[对方 群友0('), '私聊记录标签应为「对方」')
})

await check('messageTurns：按会话隔离——别的群记录不会混进来', async () => {
  const { b, calls } = makeBridge({ contextAware: { messageTurns: 5, smartMatch: false } })
  seedChat(b, 'g:654321', ['B 群的秘密'])
  await b.handleMessage(chatMsg('这边说话', { id: '123456' }))
  assert.ok(!calls.prompts[0].text.includes('B 群的秘密'))
})

await check('timeAware：静默 45 分钟 → 提示词里的 N 换成 45', async () => {
  const { b, calls } = makeBridge({ timeAware: { enabled: true, silentMinutes: 30 } })
  b._entryOf('g:123456').lastAt = Date.now() - 45 * 60_000
  await b.handleMessage(chatMsg('有人吗'))
  const prompt = calls.prompts[0].text
  assert.ok(prompt.includes('安静了 45 分钟'), prompt)
})

await check('timeAware：没到阈值 → 不注入', async () => {
  const { b, calls } = makeBridge({ timeAware: { enabled: true, silentMinutes: 30 } })
  b._entryOf('g:123456').lastAt = Date.now() - 5 * 60_000
  await b.handleMessage(chatMsg('在吗'))
  assert.ok(!calls.prompts[0].text.includes('安静了'), calls.prompts[0].text)
})

await check('timeAware：齿轮开关关闭 → 不注入', async () => {
  const { b, calls } = makeBridge({ timeAware: { enabled: false, silentMinutes: 1 } })
  b._entryOf('g:123456').lastAt = Date.now() - 60 * 60_000
  await b.handleMessage(chatMsg('在吗'))
  assert.ok(!calls.prompts[0].text.includes('安静了'), calls.prompts[0].text)
})

await check('timeAware：技能卡片总开关 features.time=false → 不注入', async () => {
  const { b, calls } = makeBridge({ timeAware: { enabled: true, silentMinutes: 1 } })
  b.live.features = { ...(b.live.features ?? {}), time: false }
  b._entryOf('g:123456').lastAt = Date.now() - 60 * 60_000
  await b.handleMessage(chatMsg('在吗'))
  assert.ok(!calls.prompts[0].text.includes('安静了'), calls.prompts[0].text)
})

await check('timeAware：自定义提示词 + {minutes} 占位也能替换', async () => {
  const { b, calls } = makeBridge({
    timeAware: { enabled: true, silentMinutes: 10, promptText: '（醒了，{minutes} 分钟没人说话）' },
  })
  b._entryOf('u:1000000001').lastAt = Date.now() - 20 * 60_000
  await b.handleMessage(chatMsg('我回来了', { kind: 'private', id: null, userId: '1000000001' }))
  assert.ok(calls.prompts[0].text.includes('（醒了，20 分钟没人说话）'), calls.prompts[0].text)
})

await check('timeAware：提示只消费一次，下一轮不再重复', async () => {
  const { b, calls } = makeBridge({ timeAware: { enabled: true, silentMinutes: 10 } })
  b._entryOf('g:123456').lastAt = Date.now() - 20 * 60_000
  await b.handleMessage(chatMsg('第一句'))
  await b.handleMessage(chatMsg('第二句'))
  assert.ok(calls.prompts[0].text.includes('安静了 20 分钟'))
  assert.ok(!calls.prompts[1].text.includes('安静了'), calls.prompts[1].text)
})

await check('上下文注入不会把多模态正文换成「没能作为图像」降级文案', async () => {
  const { b, calls } = makeBridge({
    contextAware: { messageTurns: 2, smartMatch: false },
    timeAware: { enabled: true, silentMinutes: 1 },
  })
  b.live.features = { ...(b.live.features ?? {}), vision: true, time: true }
  b._modelSupportsImages = async () => true
  // 1x1 PNG（canonical base64），走真实的 image part 组装，不做网络请求。
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  b._downloadImage = async () => ({ base64: png, mediaType: 'image/png' })
  b._relayRawImage = async () => false
  seedChat(b, 'g:123456', ['上一句', '再上一句'])
  b._entryOf('g:123456').lastAt = Date.now() - 10 * 60_000
  await b.handleMessage({ ...chatMsg('看图'), images: [{ url: 'https://example.invalid/a.png' }] })
  const prompt = calls.prompts[0]
  const textPart = prompt.opts?.content?.[0]?.text ?? ''
  assert.ok(prompt.opts?.content?.some((part) => part.type === 'image'), '应有 image part')
  assert.ok(textPart.includes('看图'), `正文应保留原话：${textPart}`)
  assert.ok(!textPart.includes('没能作为图像交给模型'), `不能把降级文案当正文：${textPart}`)
  assert.ok(textPart.includes('安静了 10 分钟'), `时间提示应拼进正文：${textPart}`)
})

console.log('\n记忆与上下文：双重截断（条数 ∩ token）——2026-10-27 合并版')

await check('estimateTokens：CJK 按字算、非 CJK 按 0.3 算，空串为 0', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('abcd'), 2) // ceil(4 * 0.3) = 2
  assert.ok(estimateTokens('你好 hello') > estimateTokens('hello'), '中文比同长度英文贵')
})

await check('truncateChatLine：超预算时保前缀 + 加省略号，且不超预算', () => {
  const line = '[群友 小明(1000000001)]: ' + '这是一句很长的话'.repeat(20)
  const budget = 40
  const out = truncateChatLine(line, budget)
  assert.ok(out.startsWith('[群友 小明(1000000001)]: '), `前缀要保住：${out}`)
  assert.ok(out.endsWith('…'), '应加省略号表示截断')
  assert.ok(estimateTokens(out) <= budget, `截断后仍超预算：${estimateTokens(out)} > ${budget}`)
})

await check('_recentChatLines：只给条数上限时行为不变（token 预算不参与）', () => {
  const { b } = makeBridge()
  seedChat(b, 'g:123456', ['1', '2', '3', '4', '5'])
  assert.equal(b._recentChatLines('g:123456', 3).length, 3)
  assert.ok(b._recentChatLines('g:123456', 3).at(-1).endsWith('5'))
})

await check('_recentChatLines：token 超预算 → 从最老的开始砍，只留装得下的尾部', () => {
  const { b } = makeBridge()
  // 每条记录 ≈「[群友 群友0(1000000000)]: 」+ 80 个汉字，粗估 100 token 左右。
  const rows = Array.from({ length: 10 }, (_, i) => `第${i}条：` + '字'.repeat(60))
  seedChat(b, 'g:123456', rows)
  const all = b._recentChatLines('g:123456', 10)
  const budget = estimateTokens(all[9]) + estimateTokens(all[8]) + 70 // 标题预留 64 + 两条
  const kept = b._recentChatLines('g:123456', 10, { maxContextTokens: budget })
  assert.ok(kept.length >= 2 && kept.length < 10, `应砍掉一部分，实际留了 ${kept.length}`)
  assert.ok(kept.at(-1).endsWith('第9条：' + '字'.repeat(60)), '最新的那条必须在')
  assert.ok(!kept.some((line) => line.includes('第0条')), '最老的必须被砍掉')
  assert.ok(estimateTokens(kept.join('\n')) <= budget - 64, '保留部分不该超预算')
})

await check('_recentChatLines：条数先到 → 不再往里塞（两者取交集）', () => {
  const { b } = makeBridge()
  seedChat(b, 'g:123456', Array.from({ length: 20 }, (_, i) => `第${i}条`))
  // 预算极大，只受条数限制。
  const kept = b._recentChatLines('g:123456', 4, { maxContextTokens: 1000000 })
  assert.equal(kept.length, 4)
  assert.ok(kept.at(-1).endsWith('第19条'))
})

await check('_recentChatLines：最新一条自己就超预算 → 截正文，不整条丢', () => {
  const { b } = makeBridge()
  seedChat(b, 'g:123456', ['短的一句', '超长的一句' + '字'.repeat(500)])
  // 直接给内部预算（128000 是配置下限，为了测「单条超预算」这条路径，这里传小值）。
  const kept = b._recentChatLines('g:123456', 5, { maxContextTokens: 120 })
  assert.equal(kept.length, 1, `只应留最新那条，实际 ${kept.length}`)
  assert.ok(kept[0].includes('超长的一句'), '最新那条的正文开头要保住')
  assert.ok(kept[0].endsWith('…'), '超预算的记录应被截断')
  assert.ok(estimateTokens(kept[0]) <= 120 - 64, `截断后仍超预算：${estimateTokens(kept[0])}`)
})

await check('_recentChatLines：非档位的容量值也按真实预算算（195000）', () => {
  const { b } = makeBridge({ memory: { maxContextTokens: 195000 } })
  assert.equal(b._memoryConfig().maxContextTokens, 195000, '区间内的值不该被吸附到档位')
})

await check('_memoryConfig：默认 128000；越界夹到 [128000, 1000000]；旧字段名仍兼容', () => {
  const d = makeBridge()
  assert.equal(d.b._memoryConfig().maxContextTokens, 128000)
  assert.equal(d.b._memoryConfig().pokeMaxTurns, 15)
  assert.equal(d.b._memoryConfig().messageMaxTurns, 0)
  const low = makeBridge({ memory: { maxContextTokens: 1000 } })
  assert.equal(low.b._memoryConfig().maxContextTokens, 128000, '低于下限夹到 128000')
  const high = makeBridge({ memory: { maxContextTokens: 9999999 } })
  assert.equal(high.b._memoryConfig().maxContextTokens, 1000000, '高于上限夹到 1M')
  const big = makeBridge({ memory: { pokeMaxTurns: 999 } })
  assert.equal(big.b._memoryConfig().pokeMaxTurns, 50, '条数夹到 50')
  // 旧配置（合并前的 contextAware）仍在读，不能因为改名把人家的开关丢了。
  const legacy = makeBridge({ contextAware: { enabled: false, pokeTurns: 6 } })
  assert.equal(legacy.b._memoryConfig().enabled, false)
  assert.equal(legacy.b._memoryConfig().pokeMaxTurns, 6)
})

await check('model 模式：容量上限 → 戳一戳的注入也被同一份预算截断', async () => {
  const { b, calls } = makeBridge({
    poke: { mode: 'model' },
    memory: { pokeMaxTurns: 20, maxContextTokens: 128000, smartMatch: false },
  })
  // 6 条 × 30000 汉字 ≈ 18 万 token，远超 128K 预算 → 必然砍掉最老的那几条。
  seedChat(b, 'g:123456', Array.from({ length: 6 }, (_, i) => `记录${i}：` + '字'.repeat(30000)))
  await b.handleNotice(pokeNotice())
  const prompt = calls.prompts[0].text
  const injected = prompt.split('\n').filter((line) => line.startsWith('[群友 '))
  assert.ok(injected.length > 0 && injected.length < 6,
    `应按 token 预算截断一部分（实际 ${injected.length} 条，共 6 条）`)
  assert.ok(prompt.includes('记录5'), '最新的那条必须还在')
  assert.equal(b._lastMemoryTrim.budget, 128000, '预算应等于配置值')
})

await check('普通消息：memory.enabled=false → 两处都不注入', async () => {
  const { b, calls } = makeBridge({
    memory: { enabled: false, messageMaxTurns: 3, smartMatch: false },
  })
  seedChat(b, 'g:123456', ['不该出现'])
  await b.handleMessage(chatMsg('在吗'))
  assert.ok(!calls.prompts[0].text.includes('不该出现'), calls.prompts[0].text)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
