/**
 * 引用消息 / 合并转发深度解析回归（2026-10-27，离线）。
 *
 * 锁死的约定：
 *   ① `parseQuoteSegments` 能从 reply / forward / node / json 段里抽出 id 与内联节点；
 *   ② 引用纯文本 → 正文前面拼 `[引用 昵称] 原文`；
 *   ③ 引用图片 → 图片追加进多模态 images，正文里给一句「已一并附上」；
 *   ④ 引用 / 自带的合并转发 → 展开成 `[聊天记录] 张三: … [结束]`；
 *   ⑤ 聊天记录里的图片写成全角 `［图片］`（躲开 _buildPromptContent 的占位清理）；
 *   ⑥ get_msg / get_forward_msg 失败 → 静默降级：正文里不出现任何「失败/撤回」字样；
 *   ⑦ 同一条被引用多次 → 只真的拉一次（Promise 缓存）；
 *   ⑧ 只引用图片、自己没打字 → 仍然投递（不能当空消息丢掉）。
 *
 * 运行：node test-quote-parse.mjs
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { Bridge } from './src/bridge.mjs'
import { parseQuoteSegments, normalizeForwardNode } from './src/onebot.mjs'

let pass = 0
let fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

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
      stateFile: path.join(os.tmpdir(), `qq-quote-state-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
      rhythm,
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  const calls = { prompts: [], getMsg: 0, getFwd: 0 }
  b.dsh = {
    sessionExists: async () => true,
    ensureWorkspace: async () => 'w1',
    createSession: async () => 's1',
    setSessionModel: async () => ({}),
    archiveSession: async () => ({ ok: true }),
    renameSession: async (sid, title) => title,
    sessionTitle: async () => null,
    setSessionPersona: async () => ({ ok: true }),
    promptAndWait: async (sid, content) => {
      calls.prompts.push({ sid, text: typeof content === 'string' ? content : JSON.stringify(content) })
      return '好'
    },
  }
  b.qq.call = async () => ({ status: 'ok', data: {} })
  b.qq.sendPrivate = async () => ({ ok: true })
  b.qq.sendGroup = async () => ({ ok: true })
  b.qq._selfId = '999'
  // 默认没有引用解析能力：只有显式打开才能看到效果（旧版客户端就是这种状态）。
  b.qq.getMessage = async (id) => { calls.getMsg++; return { ok: false, reason: '未注入' } }
  b.qq.getForwardMsg = async () => { calls.getFwd++; return { ok: false, nodes: [] } }
  // 关掉图片下载：只验证「上下文里有什么」，不碰网络。
  b.live.features = { ...(b.live.features ?? {}), vision: false }
  return { b, calls }
}

const groupMsg = (text, { id = 'gm', quote, images } = {}) => ({
  kind: 'group',
  userId: '1000000001',
  groupId: '123456',
  text,
  messageId: id,
  senderName: '小明',
  ...(quote === undefined ? {} : { quote }),
  ...(images === undefined ? {} : { images }),
  raw: { message: [{ type: 'text', data: { text } }] },
})

const replyQuote = (replyId) => ({ replyId, forwardIds: [], inlineNodes: [] })

console.log('引用消息深度解析：')

await check('parseQuoteSegments：reply / forward / node / json 都认得', () => {
  const parsed = parseQuoteSegments([
    { type: 'reply', data: { id: '123456' } },
    { type: 'forward', data: { id: 'fwd-abc' } },
    { type: 'node', data: { name: '张三', content: [{ type: 'text', data: { text: '你好' } }] } },
    { type: 'json', data: { data: '{"meta":{"detail":{"forward_id":"card-fwd"}}}' } },
  ])
  assert.equal(parsed.replyId, '123456')
  assert.deepEqual(parsed.forwardIds.sort(), ['card-fwd', 'fwd-abc'])
  assert.equal(parsed.inlineNodes.length, 1)
})

await check('parseQuoteSegments：普通消息返回空结构（不误伤）', () => {
  const parsed = parseQuoteSegments([{ type: 'text', data: { text: '嗨' } }])
  assert.deepEqual(parsed, { replyId: '', forwardIds: [], inlineNodes: [] })
  assert.deepEqual(parseQuoteSegments('not-an-array'), { replyId: '', forwardIds: [], inlineNodes: [] })
})

await check('normalizeForwardNode：文本与图片都能压平', () => {
  const node = normalizeForwardNode({
    sender: { nickname: '李四' },
    message: [
      { type: 'text', data: { text: '看图' } },
      { type: 'image', data: { url: 'http://x/1.png' } },
    ],
  })
  assert.equal(node.name, '李四')
  assert.equal(node.text, '看图[图片]')
  assert.equal(node.images.length, 1)
})

await check('引用纯文本 → 正文前拼 [引用 昵称] 原文', async () => {
  const { b, calls } = makeBridge()
  b.qq.getMessage = async (id) => {
    calls.getMsg++
    return { ok: true, messageId: id, senderName: '小红', text: '被引用的原话', images: [], videos: [], quote: {} }
  }
  await b.handleMessage(groupMsg('我同意', { quote: replyQuote('111') }))
  assert.equal(calls.prompts.length, 1)
  const text = calls.prompts[0].text
  assert.ok(text.includes('[引用 小红] 被引用的原话'), text)
  assert.ok(text.includes('我同意'), text)
})

await check('引用图片 → 追加进 images，正文给「已一并附上」', async () => {
  const { b, calls } = makeBridge()
  b.qq.getMessage = async (id) => ({
    ok: true, messageId: id, senderName: '小红', text: '',
    images: [{ url: 'http://127.0.0.1:1/a.png' }], videos: [], quote: {},
  })
  await b.handleMessage(groupMsg('这图啥意思', { quote: replyQuote('222') }))
  assert.equal(calls.prompts.length, 1)
  const text = calls.prompts[0].text
  assert.ok(text.includes('引用的消息里有 1 张图片'), text)
  // vision 关着时 _buildPromptContent 会补一句「对方发来 1 张图片」。
  assert.ok(/对方发来 1 张图片/u.test(text), text)
})

await check('引用里的合并转发 → 展开成 [聊天记录] … [结束]', async () => {
  const { b, calls } = makeBridge()
  b.qq.getMessage = async (id) => ({
    ok: true, messageId: id, senderName: '小红', text: '',
    images: [], videos: [], quote: { replyId: '', forwardIds: ['fwd-1'], inlineNodes: [] },
  })
  b.qq.getForwardMsg = async () => ({
    ok: true,
    nodes: [
      { name: '张三', text: '你好', images: [] },
      { name: '李四', text: '', images: [{ url: 'http://x/2.png' }] },
    ],
  })
  await b.handleMessage(groupMsg('你看这个', { quote: replyQuote('333') }))
  const text = calls.prompts[0].text
  assert.ok(text.includes('[聊天记录]'), text)
  assert.ok(text.includes('张三: 你好'), text)
  assert.ok(text.includes('李四: ［图片］'), text, '聊天记录里的图片要用全角占位')
  assert.ok(text.includes('[结束]'), text)
})

await check('当前消息自带合并转发 → 也能展开（空文本也不跳过）', async () => {
  const { b, calls } = makeBridge()
  b.qq.getForwardMsg = async () => ({ ok: true, nodes: [{ name: '王五', text: '记录内容', images: [] }] })
  await b.handleMessage(groupMsg('', {
    quote: { replyId: '', forwardIds: ['fwd-2'], inlineNodes: [] },
  }))
  assert.equal(calls.prompts.length, 1, '纯转发消息不能被当成空消息丢掉')
  assert.ok(calls.prompts[0].text.includes('王五: 记录内容'), calls.prompts[0].text)
})

await check('拉取失败 → 静默降级，正文里不出现失败/撤回字样', async () => {
  const { b, calls } = makeBridge()
  b.qq.getMessage = async () => ({ ok: false, reason: '消息已被撤回' })
  b.qq.getForwardMsg = async () => ({ ok: false, nodes: [] })
  await b.handleMessage(groupMsg('还在吗', { quote: replyQuote('444') }))
  assert.equal(calls.prompts.length, 1)
  const text = calls.prompts[0].text
  assert.ok(text.includes('还在吗'))
  assert.ok(!/撤回|读取失败|获取失败/u.test(text), `不该把失败原因写给模型：${text}`)
})

await check('同一条被引用两次 → 只拉一次（Promise 缓存）', async () => {
  const { b, calls } = makeBridge()
  b.qq.getMessage = async (id) => {
    calls.getMsg++
    return { ok: true, messageId: id, senderName: '小红', text: '同一句', images: [], videos: [], quote: {} }
  }
  await b.handleMessage(groupMsg('第一次', { id: 'm1', quote: replyQuote('555') }))
  await b.handleMessage(groupMsg('第二次', { id: 'm2', quote: replyQuote('555') }))
  assert.equal(calls.getMsg, 1, `应只拉一次，实际 ${calls.getMsg}`)
  assert.ok(calls.prompts[1].text.includes('[引用 小红] 同一句'))
})

await check('引用视频 → 交给视频下载链路，路径拼在正文里', async () => {
  const { b, calls } = makeBridge()
  b.qq.getMessage = async (id) => ({
    ok: true, messageId: id, senderName: '小红', text: '',
    images: [], videos: [{ url: 'http://x/v.mp4' }], quote: {},
  })
  b.pluginHub = {
    config: { video: { enabled: true } },
    downloadVideos: async (videos) => ({ paths: videos.map(() => '/tmp/a.mp4') }),
  }
  await b.handleMessage(groupMsg('这视频', { quote: replyQuote('666') }))
  assert.ok(calls.prompts[0].text.includes('[视频]（本地文件：/tmp/a.mp4）'), calls.prompts[0].text)
})

await check('斜杠指令带引用 → 不拼引用块，也不去拉原消息', async () => {
  const { b, calls } = makeBridge({
    allow: { admins: ['1000000001'] },
    rhythm: { activityLevel: 0, debounceWindowMs: 0 },
  })
  let fetched = 0
  b.qq.getMessage = async () => { fetched++; return { ok: true, text: '不该出现', images: [], videos: [], quote: {} } }
  await b.handleMessage(groupMsg('/clear', { quote: replyQuote('777') }))
  assert.ok(calls.prompts[0].text.startsWith('/clear'), 'DSH 只认以 / 开头的 prompt')
  assert.equal(fetched, 0, '斜杠指令不该浪费一次 get_msg')
})

await check('转发记录里的图片 → 提取 URL 进多模态附件（最多 3 张）', async () => {
  const { b, calls } = makeBridge()
  b.qq.getForwardMsg = async () => ({
    ok: true,
    nodes: [
      { name: '张三', text: '看图', images: [{ url: 'http://x/1.png' }] },
      { name: '李四', text: '', images: [{ url: 'http://x/2.png' }, { url: 'http://x/3.png' }] },
    ],
  })
  await b.handleMessage(groupMsg('他们发了啥', {
    quote: { replyId: '', forwardIds: ['f-img'], inlineNodes: [] },
  }))
  const text = calls.prompts[0].text
  assert.ok(text.includes('聊天记录里的 3 张图片已作为附件一并附上'), text)
  assert.ok(/对方发来 3 张图片/u.test(text), `图片应进 images：${text}`)
  assert.ok(text.includes('李四: ［图片×2］'), `多图节点应标数量：${text}`)
})

await check('转发记录超过 3 张图 → 只附前 3 张，正文如实说明', async () => {
  const { b, calls } = makeBridge()
  b.qq.getForwardMsg = async () => ({
    ok: true,
    nodes: [{
      name: '张三', text: '',
      images: [1, 2, 3, 4, 5].map((i) => ({ url: `http://x/${i}.png` })),
    }],
  })
  await b.handleMessage(groupMsg('图真多', {
    quote: { replyId: '', forwardIds: ['f-many'], inlineNodes: [] },
  }))
  const text = calls.prompts[0].text
  assert.ok(text.includes('另有 2 张因数量限制没有附上'), text)
  assert.ok(/对方发来 3 张图片/u.test(text), `最多 3 张附件：${text}`)
  assert.ok(text.includes('［图片×5］'), '文本占位仍按原始张数标注')
})

await check('节点文本里的多个 [图片] → 纯图行合成 ［图片×2］，图文混排保持原样', () => {
  const { b } = makeBridge()
  const text = b._formatForwardLog([
    { name: '李四', text: '看[图片][图片]', images: [{ url: '1' }, { url: '2' }] },
    { name: '王五', text: '[图片][图片]', images: [{ url: '3' }, { url: '4' }] },
  ])
  assert.ok(text.includes('李四: 看［图片］［图片］'), text)
  assert.ok(text.includes('王五: ［图片×2］'), text)
})

await check('CQ 字符串节点：图片 URL 也能提取（真机形态）', () => {
  // NapCat 少数版本的 get_forward_msg 节点 content 是 CQ 码字符串，不是段数组。
  const node = normalizeForwardNode({
    sender: { nickname: '张三' },
    content: '[CQ:image,file=abc.jpg,url=https://multimedia.example.com/a?x=1&#44;y=2]',
  })
  assert.equal(node.images.length, 1, 'CQ 字符串里的图片必须被抽出来')
  assert.ok(node.images[0].url.startsWith('https://multimedia.example.com/a'), node.images[0].url)
  assert.equal(node.images[0].file, 'abc.jpg')
})

await check('get_forward_msg 给 CQ 字符串 → 图片进本轮 images', async () => {
  const { b, calls } = makeBridge()
  b.qq.getForwardMsg = async () => ({
    ok: true,
    nodes: [{
      sender: { nickname: '张三' },
      content: '[CQ:image,file=a.jpg,url=https://example.invalid/a.jpg]',
    }],
  })
  await b.handleMessage(groupMsg('看看这个', {
    quote: { replyId: '', forwardIds: ['f-cq'], inlineNodes: [] },
  }))
  const text = calls.prompts[0].text
  assert.ok(/对方发来 1 张图片/u.test(text), `CQ 字符串里的图应进 images：${text}`)
})

await check('图片全部下载失败 → 占位改写成「链接已过期」', async () => {
  const { b } = makeBridge()
  b.live.features = { ...b.live.features, vision: true }
  b._modelSupportsImages = async () => true
  b._loadImageRef = async () => ({ ok: false, error: new Error('HTTP 403') })
  const built = await b._buildPromptContent('[聊天记录]\n群友: ［图片］', [{ url: 'https://x/expired.png' }])
  assert.equal(built.images, 0)
  assert.ok(built.fallbackText.includes('［图片(链接已过期，无法查看)］'), built.fallbackText)
  assert.ok(built.fallbackText.includes('链接已过期'), built.fallbackText)
})

await check('部分失败 → 正文末尾说明还有几张看不到', async () => {
  const { b } = makeBridge()
  b.live.features = { ...b.live.features, vision: true }
  b._modelSupportsImages = async () => true
  let callsDone = 0
  b._loadImageRef = async () => {
    callsDone++
    if (callsDone === 1) return { ok: true, value: { base64: 'QUJD', mediaType: 'image/png' } }
    return { ok: false, error: new Error('HTTP 403') }
  }
  const built = await b._buildPromptContent('看看', [
    { url: 'https://x/1.png' },
    { url: 'https://x/2.png' },
  ])
  assert.equal(built.images, 1)
  // 说明进的是主体文本（content[0].text）；fallbackText 是给「本轮没带图」重试用的。
  assert.ok(String(built.content[0].text).includes('另有 1 张图片链接已过期'), built.content[0].text)
})

await check('_expandForwards 对有图片的节点必须返回非空 images', async () => {
  const { b } = makeBridge()
  b.qq.getForwardMsg = async () => ({
    ok: true,
    nodes: [{ sender: { nickname: '张三' }, content: '[CQ:image,file=a.jpg,url=https://x/a.jpg]' }],
  })
  const result = await b._expandForwards({ forwardIds: ['f-img-assert'], inlineNodes: [] })
  assert.ok(result.images.length > 0, `转发记录里的图片必须进 images，实际 ${result.images.length}`)
  assert.ok(result.text.includes('张三'), result.text)
})

await check('聊天记录过长 → 只展开 40 条并注明截断', () => {
  const { b } = makeBridge()
  const nodes = Array.from({ length: 60 }, (_, i) => ({ name: `人${i}`, text: `第${i}句`, images: [] }))
  const text = b._formatForwardLog(nodes)
  assert.ok(text.includes('人0: 第0句'))
  assert.ok(text.includes('人39: 第39句'))
  assert.ok(!text.includes('人40: 第40句'), '超过 40 条不该再展开')
  assert.ok(text.includes('聊天记录过长'))
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
