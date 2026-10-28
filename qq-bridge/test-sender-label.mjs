/**
 * 群聊发送人识别回归（离线，不连 QQ / 不碰真实 DSH）。
 *
 * 锁死 2026-10-26 的约定（规格 §5.1）：
 *   ① **只在群聊**给「送进模型的正文」加标签，格式严格 `[群友 昵称(QQ)]: 内容`；
 *   ② 私聊保持原样（不套群聊逻辑）；
 *   ③ 昵称取 `msg.senderName`，空则退回 QQ 号；
 *   ④ 防抖合并时**每条消息各自打标**（不同人各带各的标签，合并后按行拼）；
 *   ⑤ 纯图片消息：标签占文本位置，图片说明句接在后面；
 *   ⑥ 日志 / 未读预览 / 外部插件 hook 的 `text` 仍用**原文**；
 *   ⑦ `/` 开头的管理员指令不打标（DSH 斜杠指令必须仍以 `/` 开头）。
 *
 * 运行：node test-sender-label.mjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 造一个只接假 DSH / 假 QQ 的 Bridge（不建真实会话、不读写真实 state）。 */
function makeBridge({ rhythm = { activityLevel: 3, debounceWindowMs: 0 }, allow } = {}) {
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: {
        private: ['1000000001'], groups: ['123456'], admins: [],
        allowAllWhenEmpty: false, ...(allow ?? {}),
      },
      sendDelayMs: 0,
      stateFile: path.join(os.tmpdir(), `qq-label-state-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
      rhythm,
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  const calls = {
    prompts: [], sent: [], personas: [], created: 0,
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
  }
  b.qq.call = async () => ({ status: 'ok', data: {} })
  b.qq.sendPrivate = async (uid, text) => { calls.sent.push({ kind: 'private', uid, text }); return { ok: true } }
  b.qq.sendGroup = async (gid, text) => { calls.sent.push({ kind: 'group', gid, text }); return { ok: true } }
  b.qq._selfId = '999'
  return { b, calls }
}

const groupMsg = (text, { at = false, id = 'gm', userId = '1000000001', senderName } = {}) => ({
  kind: 'group',
  userId,
  groupId: '123456',
  text,
  messageId: id,
  ...(senderName === undefined ? {} : { senderName }),
  raw: {
    message: at
      ? [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text } }]
      : [{ type: 'text', data: { text } }],
  },
})

const privMsg = (text, id = 'pm', userId = '1000000001') => ({
  kind: 'private', userId, groupId: null, text, messageId: id,
  raw: { message: [{ type: 'text', data: { text } }] },
})

console.log('群聊发送人标签：')

await check('群聊单条：正文带 [群友 昵称(QQ)]: 前缀', async () => {
  const { b, calls } = makeBridge()
  await b.handleMessage(groupMsg('你好呀', { senderName: '小明' }))
  assert.equal(calls.prompts.length, 1)
  assert.ok(calls.prompts[0].text.startsWith('[群友 小明(1000000001)]: 你好呀'))
})

await check('昵称为空 → 用 QQ 号当昵称（格式不变）', async () => {
  const { b, calls } = makeBridge()
  await b.handleMessage(groupMsg('在吗'))
  assert.ok(calls.prompts[0].text.startsWith('[群友 1000000001(1000000001)]: 在吗'))
})

await check('私聊不加标签（保持原样）', async () => {
  const { b, calls } = makeBridge()
  await b.handleMessage(privMsg('私聊的一句话'))
  assert.equal(calls.prompts[0].text, '私聊的一句话')
})

await check('标签格式严格：英文冒号 + 一个空格', async () => {
  const { b, calls } = makeBridge()
  await b.handleMessage(groupMsg('内容', { senderName: '小红' }))
  const text = calls.prompts[0].text
  // v2.0 第十步：prompt 末尾可能追加「本群动态记忆」，标签仍必须严格在第一行。
  assert.match(text, /^\[群友 小红\(1000000001\)\]: 内容/u)
  assert.equal(text.split('\n')[0].includes('：'), false, '不能用全角冒号')
})

await check('防抖合并：同一发送者连发两条 → 各带各的标签，按行拼', async () => {
  const { b, calls } = makeBridge({ rhythm: { activityLevel: 3, debounceWindowMs: 60 } })
  await b.handleMessage(groupMsg('第一句', { id: 'a1', senderName: '小明' }))
  await b.handleMessage(groupMsg('第二句', { id: 'a2', senderName: '小明' }))
  assert.equal(calls.prompts.length, 0, '窗口内不该立刻投递')
  // 等防抖窗口结束
  for (let i = 0; i < 40 && calls.prompts.length === 0; i++) await sleep(20)
  assert.equal(calls.prompts.length, 1)
  assert.ok(calls.prompts[0].text.startsWith(
    '[群友 小明(1000000001)]: 第一句\n[群友 小明(1000000001)]: 第二句',
  ), calls.prompts[0].text.slice(0, 120))
})

await check('不同发送者不合并：换人立刻投递上一批（防引用串台）', async () => {
  const { b, calls } = makeBridge({ rhythm: { activityLevel: 3, debounceWindowMs: 200 } })
  await b.handleMessage(groupMsg('第一句', { id: 'b1', senderName: '小明' }))
  await b.handleMessage(groupMsg('第二句', {
    id: 'b2', userId: '2000000002', senderName: '小红',
  }))
  // 换人时上一批被立刻 flush，不等 200ms 窗口。
  for (let i = 0; i < 20 && calls.prompts.length < 1; i++) await sleep(10)
  assert.equal(calls.prompts.length, 1, '换人应立刻投递上一批')
  assert.ok(calls.prompts[0].text.startsWith('[群友 小明(1000000001)]: 第一句'))
  // 第二批（小红）等自己的窗口到点再发。
  for (let i = 0; i < 40 && calls.prompts.length < 2; i++) await sleep(20)
  assert.ok(calls.prompts[1].text.startsWith('[群友 小红(2000000002)]: 第二句'))
})

await check('纯图片消息：标签占文本位置，图片说明句接在后面', async () => {
  const { b, calls } = makeBridge()
  // 关掉图片理解：_buildPromptContent 会直接返回「说明句」而不去下载图片。
  b.live.features = { ...b.live.features, vision: false }
  await b.handleMessage({
    ...groupMsg('', { id: 'img1', senderName: '小明' }),
    images: [{ url: 'http://127.0.0.1:1/x.png' }],
  })
  assert.equal(calls.prompts.length, 1)
  const text = calls.prompts[0].text
  assert.match(text, /^\[群友 小明\(1000000001\)\]:/u, `标签应在最前：${text}`)
  assert.match(text, /对方发来 1 张图片/u, `图片说明应接在后面：${text}`)
})

await check('未读预览用原文（不加标签）', async () => {
  const { b } = makeBridge()
  await b.handleMessage(groupMsg('这是一句原文', { senderName: '小明' }))
  assert.equal(b.state.sessions['g:123456'].lastText, '这是一句原文')
})

await check('外部插件 hook 的 text 用原文（不加标签）', async () => {
  const { b } = makeBridge()
  const seen = []
  b.hooks = { invoke: async (event, payload) => { seen.push({ event, text: payload.text }); return { ok: false } } }
  b._externalPluginsEnabled = () => true
  await b.handleMessage(groupMsg('hook 看到的应是原文', { senderName: '小明' }))
  const messageEvent = seen.find((item) => item.event === 'message')
  assert.ok(messageEvent, '应触发 message hook')
  assert.equal(messageEvent.text, 'hook 看到的应是原文')
})

await check('/ 开头的管理员指令不打标签（DSH 斜杠指令必须仍以 / 开头）', async () => {
  const { b, calls } = makeBridge({
    allow: { admins: ['1000000001'] },
    rhythm: { activityLevel: 0, debounceWindowMs: 0 },
  })
  await b.handleMessage(groupMsg('/clear', { senderName: '小明' }))
  assert.equal(calls.prompts.length, 1)
  assert.ok(calls.prompts[0].text.startsWith('/clear'))
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
