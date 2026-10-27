/**
 * 上下文感知 + 聊天记录读图上限（2026-10-27，离线）。
 *
 * 锁死的约定：
 *   ① `quote.forwardMaxImages` 控制合并转发最多读几张图（默认 3，0~10；0 = 只留占位）；
 *   ② `contextAware.enabled` / `contextAware.turns` 控制「模型回复」注入多少条记录；
 *   ③ 注入**严格按会话 key 隔离**（g:群号 各自一份，互不串）；
 *   ④ `poke.mode = 'model'`：注入 + 调模型 + 发回；模型失败退回固定文案，绝不静默；
 *   ⑤ 私聊没有群聊缓冲，不注入。
 *
 * 运行：node test-context-aware.mjs
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

function makeBridge({ poke, quote, contextAware } = {}) {
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
  return { b, calls }
}

/** 直接往会话缓冲塞记录（模拟群友说过话）。 */
function seedChat(b, key, rows) {
  const now = Date.now()
  b._chatLog.set(key, rows.map((text, i) => ({
    name: `群友${i}`, qq: `100000000${i}`, text, at: now - (rows.length - i) * 1000,
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

await check('model 模式：turns=0 等同关闭注入', async () => {
  const { b, calls } = makeBridge({ poke: { mode: 'model' }, contextAware: { turns: 0 } })
  seedChat(b, 'g:123456', ['也不该出现'])
  await b.handleNotice(pokeNotice())
  assert.ok(!calls.prompts[0].text.includes('也不该出现'))
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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
