/**
 * TTS 通路回归（离线，不联网）。
 *
 * 背景（2026-10-24 真机）：微软 Edge 朗读接口一律 403（Sec-MS-GEC 升到 v2），
 * 旧实现还把 WS 失败原因吞成「Edge TTS WebSocket 错误：」；同时语音失败只回
 * ok=false，模型以为发出去了。这里覆盖修完的四件事：
 *   ① baidu 免 Key 通路：URL 拼装 / mp3 校验 / 可读错误；
 *   ② edge 失败原因可读（1006 + 403 翻成人话，不再空尾巴）；
 *   ③ NapCat base64:// 失败 → 落盘 file:// 重发一次，retcode 原样带回；
 *   ④ voice op 的 detail 形状（Host 靠它把失败原因转给模型）+ session-ops 优先回传 detail。
 *
 * 运行：node test-tts.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  synthesizeBaidu, synthesizeEdge, synthesize, describeWsError, describeFetchError, isMp3Buffer,
  BAIDU_MAX_CHARS, TTS_MAX_CHARS,
} from './src/tts.mjs'
import { OneBotClient } from './src/onebot.mjs'
import { Bridge, normalizeSessionEntry, normalizeFeatures } from './src/bridge.mjs'
import { startSessionOpsPolling } from './src/session-ops.mjs'

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} }
const tmpPath = (prefix) => path.join(os.tmpdir(), `qq-${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}`)

/** 一段合法 MP3 帧头（ff f3 = MPEG-1 Layer III）。 */
const MP3_BYTES = Buffer.from([0xff, 0xf3, 0x44, 0xc4, 0x11, 0x22, 0x33, 0x44])
const mp3Buffer = () => MP3_BYTES.buffer.slice(MP3_BYTES.byteOffset, MP3_BYTES.byteOffset + MP3_BYTES.byteLength)

/** 只够 synthesizeBaidu 用的 fetch 桩。 */
const baiduFetch = (impl) => async (url, init) => impl(url, init)

console.log('— baidu 免 Key 通路 —')
await check('请求 URL 参数正确，成功解析成 base64 + audio/mpeg', async () => {
  let captured
  const fetchImpl = baiduFetch((url, init) => {
    captured = { url, init }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => mp3Buffer(),
    }
  })
  const out = await synthesizeBaidu('你好 世界', { fetchImpl })
  assert.equal(out.provider, 'baidu')
  assert.equal(out.mediaType, 'audio/mpeg')
  assert.equal(out.bytes, MP3_BYTES.byteLength)
  assert.equal(out.base64, MP3_BYTES.toString('base64'))
  const u = new URL(captured.url)
  assert.equal(`${u.origin}${u.pathname}`, 'https://fanyi.baidu.com/gettts')
  assert.equal(u.searchParams.get('lan'), 'zh')
  assert.equal(u.searchParams.get('spd'), '5')
  assert.equal(u.searchParams.get('source'), 'web')
  assert.equal(u.searchParams.get('text'), '你好 世界')
  // 百度对裸 Node UA 会拒，必须带浏览器 UA + referer。
  assert.match(String(captured.init.headers['user-agent']), /Mozilla\/5\.0/)
  assert.match(String(captured.init.headers.referer), /fanyi\.baidu\.com/)
})
await check('HTTP 500 → 错误带状态码和响应体前 120 字', async () => {
  const fetchImpl = baiduFetch(() => ({
    ok: false,
    status: 500,
    headers: { get: () => 'text/html' },
    text: async () => `<html>${'x'.repeat(400)}</html>`,
  }))
  await assert.rejects(
    () => synthesizeBaidu('你好', { fetchImpl }),
    (error) => {
      assert.match(error.message, /百度 TTS HTTP 500/)
      assert.match(error.message, /<html>/)
      const bodyPart = error.message.split('：').slice(1).join('：')
      assert.ok([...bodyPart].length <= 121, `响应体截断应为 120 字，实际 ${[...bodyPart].length}`)
      return true
    },
  )
})
await check('HTTP 200 但正文是 HTML → 报「不是 MP3」而不是把错误页发出去', async () => {
  const html = Buffer.from('<html>blocked</html>')
  const fetchImpl = baiduFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html' },
    arrayBuffer: async () => html.buffer.slice(html.byteOffset, html.byteOffset + html.byteLength),
  }))
  await assert.rejects(() => synthesizeBaidu('你好', { fetchImpl }), /返回的不是 MP3/)
})
await check('0 字节音频 → 明确报错', async () => {
  const fetchImpl = baiduFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'audio/mpeg' },
    arrayBuffer: async () => new ArrayBuffer(0),
  }))
  await assert.rejects(() => synthesizeBaidu('你好', { fetchImpl }), /返回空音频/)
})
await check(`超过 ${BAIDU_MAX_CHARS} 字 → 直接报错且不发起请求`, async () => {
  let called = 0
  const fetchImpl = baiduFetch(() => { called++; return { ok: true, status: 200 } })
  await assert.rejects(
    () => synthesizeBaidu('字'.repeat(BAIDU_MAX_CHARS + 1), { fetchImpl }),
    new RegExp(`单次上限 ${BAIDU_MAX_CHARS} 字`),
  )
  assert.equal(called, 0, '超长应在本地拦下，不该打百度接口')
})
await check('空文本 → 报错', async () => {
  await assert.rejects(() => synthesizeBaidu('   ', { fetchImpl: baiduFetch(() => { throw new Error('不该联网') }) }), /TTS 文本为空/)
})
await check('网络异常 → 错误带 cause（fetch failed 不再是黑箱）', async () => {
  const boom = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', message: 'socket hang up' } })
  await assert.rejects(
    () => synthesizeBaidu('你好', { fetchImpl: baiduFetch(() => { throw boom }) }),
    /百度 TTS 请求失败：fetch failed（cause=ECONNRESET socket hang up）/,
  )
})
await check('超时 → 翻成「请求超时（Nms）」', async () => {
  assert.equal(describeFetchError({ name: 'TimeoutError', message: 'The operation was aborted' }, 5000), '请求超时（5000ms）')
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  await assert.rejects(
    () => synthesizeBaidu('你好', { fetchImpl: baiduFetch(() => { throw timeout }) }),
    /百度 TTS 请求失败：请求超时（20000ms）/,
  )
})
await check('isMp3Buffer：帧同步字 / ID3 认，HTML 不认', () => {
  assert.equal(isMp3Buffer(Buffer.from([0xff, 0xf3, 0x00])), true)
  assert.equal(isMp3Buffer(Buffer.from([0xff, 0xfb, 0x90])), true)
  assert.equal(isMp3Buffer(Buffer.from('ID3')), true)
  assert.equal(isMp3Buffer(Buffer.from('<ht')), false)
  assert.equal(isMp3Buffer(Buffer.from([0xff])), false)
  assert.equal(isMp3Buffer(null), false)
})

console.log('\n— provider 选择 —')
await check('provider 缺省 = baidu（edge 已被 403 拒，默认不再走它）', async () => {
  const out = await synthesize('你好', {}, {
    fetchImpl: baiduFetch(() => ({
      ok: true,
      status: 200,
      headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => mp3Buffer(),
    })),
  })
  assert.equal(out.provider, 'baidu')
})
await check('显式 openai 仍按 openai 走（不回归）', async () => {
  const out = await synthesize('你好', { provider: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' }, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => mp3Buffer(),
    }),
  })
  assert.equal(out.provider, 'openai')
})
await check('未知 provider → 报错并列出可选值', async () => {
  await assert.rejects(() => synthesize('你好', { provider: 'youdao' }), /未知的 TTS provider：youdao.*baidu/)
})

console.log('\n— edge：错误不再被吞 —')
await check('describeWsError 从 event.error / cause 里挖出真实原因', () => {
  const detail = describeWsError({
    message: '',
    error: { message: '', code: 'ERR_WS', cause: { code: 'UND_ERR_SOCKET', message: 'socket hang up' } },
  })
  assert.match(detail, /ERR_WS/)
  assert.match(detail, /cause=UND_ERR_SOCKET socket hang up/)
  assert.equal(describeWsError({}), '未提供具体原因')
  assert.match(describeWsError({ error: { message: '握手失败' } }), /握手失败/)
})

/** 假 WebSocket：按脚本触发事件（不开真连接）。 */
function fakeWsClass(script) {
  return class FakeWs {
    constructor(url) {
      this.url = url
      this.handlers = new Map()
      setTimeout(() => script(this), 0)
    }
    addEventListener(type, fn) {
      const list = this.handlers.get(type) ?? []
      list.push(fn)
      this.handlers.set(type, list)
    }
    emit(type, event) { for (const fn of this.handlers.get(type) ?? []) fn(event) }
    send() {}
    close() { this.closed = true }
  }
}

await check(`edge 文本超过 ${TTS_MAX_CHARS} 字 → 本地报错，连 WS 都不建`, async () => {
  let constructed = 0
  const Ws = fakeWsClass(() => {})
  class CountingWs extends Ws {
    constructor(url) { super(url); constructed++ }
  }
  await assert.rejects(
    () => synthesizeEdge('字'.repeat(TTS_MAX_CHARS + 1), { WebSocketImpl: CountingWs }),
    /TTS 文本过长/,
  )
  assert.equal(constructed, 0)
})
await check('403 握手失败（error message 空 + close 1006）→ 人话：403 + 换 baidu', async () => {
  const Ws = fakeWsClass((ws) => {
    // 真机复现：message 是空串，原因在 error.cause；紧跟着 close 1006。
    ws.emit('error', { message: '', error: { message: '', cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } } })
    ws.emit('close', { code: 1006, reason: '' })
  })
  const probe = async () => ({ ok: false, status: 403, text: async () => '' })
  await assert.rejects(
    () => synthesizeEdge('测试一下', { WebSocketImpl: Ws, fetchImpl: probe, timeoutMs: 2000 }),
    (error) => {
      assert.match(error.message, /^Edge TTS 失败：/)
      assert.match(error.message, /1006/, '必须带 close code')
      assert.match(error.message, /UND_ERR_SOCKET/, '必须带被吞的 cause')
      assert.match(error.message, /403/, '必须带 HTTPS 探测到的状态码')
      assert.match(error.message, /Sec-MS-GEC v2/)
      assert.match(error.message, /baidu/)
      return true
    },
  )
})
await check('edge 正常返回音频的路径没被改坏（二进制帧 + turn.end）', async () => {
  const audio = Buffer.from([1, 2, 3, 4, 5])
  const header = Buffer.from('Path:audio\r\n', 'utf8')
  const len = Buffer.alloc(2)
  len.writeUInt16BE(header.byteLength, 0)
  const frame = Buffer.concat([len, header, audio])
  const Ws = fakeWsClass((ws) => {
    ws.emit('open', {})
    ws.emit('message', { data: new Uint8Array(frame) })
    ws.emit('message', { data: 'X-RequestId:x\r\nPath:turn.end' })
  })
  const out = await synthesizeEdge('你好', { WebSocketImpl: Ws, fetchImpl: async () => ({ ok: false, status: 403 }) })
  assert.equal(out.provider, 'edge')
  assert.equal(out.bytes, audio.byteLength)
  assert.equal(out.base64, audio.toString('base64'))
})

console.log('\n— NapCat record：base64 失败 → file:// 降级 —')
const makeClient = () => new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', accessToken: 't', logger: quietLogger })
const voiceBase64 = MP3_BYTES.toString('base64')

await check('base64 成功：via=base64、retcode=0、不落盘', async () => {
  const client = makeClient()
  const sent = []
  client.call = async (action, params) => {
    sent.push({ action, params })
    return { status: 'ok', retcode: 0, data: { message_id: 111 } }
  }
  const dir = tmpPath('voice-nofile')
  const out = await client.sendVoice('group', '123456', voiceBase64, { atUserId: '1000000001', fallbackDir: dir })
  assert.equal(out.ok, true)
  assert.equal(out.via, 'base64')
  assert.equal(out.retcode, 0)
  assert.deepEqual(out.messageIds, ['111'])
  assert.equal(fs.existsSync(dir), false, '成功时不该落盘')
  const message = sent[0].params.message
  assert.equal(message[0].type, 'at', '群聊 + atUserId 仍要带 @ 段')
  assert.match(message.at(-1).data.file, /^base64:\/\//)
})
await check('base64 被拒 → 落盘 file:// 重发成功，临时文件删除', async () => {
  const client = makeClient()
  const files = []
  client.call = async (action, params) => {
    const file = params.message.at(-1).data.file
    files.push(file)
    if (file.startsWith('base64://')) return { status: 'failed', retcode: 100, data: null }
    return { status: 'ok', retcode: 0, data: { message_id: 222 } }
  }
  const dir = tmpPath('voice-fallback')
  const out = await client.sendVoice('private', '1000000001', voiceBase64, { fallbackDir: dir })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.via, 'file')
  assert.equal(out.retcode, 0)
  assert.equal(files.length, 2, '应只重发一次')
  assert.match(files[1], /^file:\/\/\/[A-Za-z]:.*voice-\d+\.mp3$/, `实际 ${files[1]}`)
  const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')) : []
  assert.deepEqual(leftovers, [], '成功后临时文件必须删掉')
})
await check('两次都失败 → 两次 retcode 都带回，临时文件保留供排查', async () => {
  const client = makeClient()
  client.call = async (action, params) => {
    const file = params.message.at(-1).data.file
    return file.startsWith('base64://')
      ? { status: 'failed', retcode: 100, data: null }
      : { status: 'failed', retcode: 1404, data: null }
  }
  const dir = tmpPath('voice-fail')
  const out = await client.sendVoice('private', '1000000001', voiceBase64, { fallbackDir: dir })
  assert.equal(out.ok, false)
  assert.equal(out.via, 'file')
  assert.equal(out.retcode, 1404)
  assert.equal(out.firstRetcode, 100)
  assert.match(out.error, /retcode=100/)
  assert.match(out.error, /retcode=1404/)
  assert.ok(out.file && fs.existsSync(out.file), '两次都失败时保留临时文件，路径要在返回值里')
  fs.rmSync(dir, { recursive: true, force: true })
})
await check('没给 fallbackDir → 不降级，只发一次 base64', async () => {
  const client = makeClient()
  let count = 0
  client.call = async () => { count++; return { status: 'failed', retcode: 100, data: null } }
  const out = await client.sendVoice('private', '1000000001', voiceBase64)
  assert.equal(out.ok, false)
  assert.equal(count, 1)
  assert.equal(out.via, 'base64')
  assert.match(out.error, /retcode=100/)
})

console.log('\n— voice op 的 detail 形状（Host 等回执用）—')
function makeBridge({ voice, stateFile } = {}) {
  const file = stateFile ?? `${tmpPath('bridge-tts')}.json`
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: { private: ['1000000001'], groups: ['123456'], admins: [], allowAllWhenEmpty: false },
      sendDelayMs: 0,
      stateFile: file,
    },
    logger: quietLogger,
  })
  b.state.sessions['g:123456'] = normalizeSessionEntry('g:123456', { sessionId: 's1', qq: '123456' })
  b.live.features = normalizeFeatures({ voice: true })
  b.live.voice = voice ?? {}
  return b
}

await check('TTS 失败：stage=tts、provider 带出、error 与 detail 都是可读原因', async () => {
  const b = makeBridge()
  b.tts = { synthesize: async () => { throw new Error('百度 TTS HTTP 403：forbidden') } }
  const r = await b.applySessionOp({ op: 'voice', sessionId: 's1', text: '你好' })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'tts')
  assert.equal(r.provider, 'baidu', 'provider 缺省应兜底成 baidu')
  assert.match(r.error, /语音合成失败（baidu）：百度 TTS HTTP 403/)
  assert.equal(r.detail, r.error, 'detail 要和 error 一致，旧 Host 只看 error 也能拿到原因')
})
await check('发送失败：detail 带 retcode/status/via，字段原样透出', async () => {
  const b = makeBridge()
  b.tts = { synthesize: async () => ({ base64: 'QUJD', bytes: 3, provider: 'baidu' }) }
  b.qq.sendVoice = async () => ({
    ok: false, error: 'retcode=100 status=failed', retcode: 100, status: 'failed', via: 'base64',
  })
  const r = await b.applySessionOp({ op: 'voice', sessionId: 's1', text: '你好' })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'send')
  assert.match(r.detail, /语音发送失败（baidu，via=base64）/)
  assert.match(r.detail, /retcode=100/)
  assert.equal(r.retcode, 100)
  assert.equal(r.status, 'failed')
  assert.equal(r.via, 'base64')
})
await check('发送成功：detail 含 provider/体积/via/retcode，sent=true', async () => {
  const b = makeBridge()
  b.tts = { synthesize: async () => ({ base64: 'QUJD', bytes: 16 * 1024, provider: 'baidu' }) }
  let opts
  b.qq.sendVoice = async (kind, target, data, passed) => {
    opts = { kind, target, data, passed }
    return { ok: true, via: 'file', retcode: 0, status: 'ok', messageIds: ['1'] }
  }
  const r = await b.applySessionOp({ op: 'voice', sessionId: 's1', text: '你好' })
  assert.equal(r.ok, true)
  assert.equal(r.sent, true)
  assert.equal(r.via, 'file')
  assert.equal(r.retcode, 0)
  assert.match(r.detail, /已发送语音（baidu，16KB，via=file，retcode=0）/)
  // 落盘降级目录必须是桥接 state/ 所在目录（见 sendVoice 的 fallbackDir 契约）。
  assert.equal(opts.passed.fallbackDir, path.dirname(b.statePath))
})
await check('provider=edge 合成失败 → 自动降级 baidu 并成功发送（2026-10-24 微软 403）', async () => {
  const b = makeBridge({ voice: { provider: 'edge' } })
  const tried = []
  b.tts = {
    synthesize: async (_text, cfg) => {
      tried.push(cfg.provider)
      if (cfg.provider === 'edge') throw new Error('Edge TTS 失败：WebSocket 关闭 code=1006')
      return { base64: 'QUJD', bytes: 2048, provider: 'baidu' }
    },
  }
  b.qq.sendVoice = async () => ({ ok: true, via: 'base64', retcode: 0, status: 'ok', messageIds: ['7'] })
  const r = await b.applySessionOp({ op: 'voice', sessionId: 's1', text: '你好' })
  assert.deepEqual(tried, ['edge', 'baidu'], '先试配置里的 edge，失败后用 baidu 重试一次')
  assert.equal(r.ok, true)
  assert.equal(r.provider, 'baidu', 'detail 里必须是实际生效的 provider')
  assert.match(r.detail, /已发送语音（baidu/)
})
await check('provider=edge 且 baidu 也失败 → 失败 detail 报 edge 的原因', async () => {
  const b = makeBridge({ voice: { provider: 'edge' } })
  b.tts = {
    synthesize: async (_text, cfg) => {
      if (cfg.provider === 'edge') throw new Error('Edge TTS 失败：WebSocket 关闭 code=1006')
      throw new Error('百度 TTS HTTP 500')
    },
  }
  const r = await b.applySessionOp({ op: 'voice', sessionId: 's1', text: '你好' })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'tts')
  assert.match(r.detail, /语音合成失败（edge）/, '降级也没成时必须报原始 provider 的原因')
  assert.match(r.detail, /1006/)
})

await check('voice-disabled 保留短码，同时给可读 detail', async () => {
  const b = makeBridge()
  b.live.features = normalizeFeatures({ voice: false })
  const r = await b.applySessionOp({ op: 'voice', sessionId: 's1', text: '你好' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'voice-disabled')
  assert.match(r.detail, /技能/)
})
await check('_voiceConfig：单次音色覆盖进合成配置，provider 缺省不硬塞', async () => {
  const b = makeBridge({ voice: { provider: 'baidu', voice: 'zh-CN-XiaoyiNeural' } })
  let cfg
  b.tts = { synthesize: async (text, c) => { cfg = c; return { base64: 'QUJD', bytes: 3, provider: 'baidu' } } }
  await b.applySessionOp({ op: 'voice', sessionId: 's1', text: '你好', voice: 'alloy' })
  assert.equal(cfg.voice, 'alloy')
  assert.equal(cfg.provider, 'baidu')
})

console.log('\n— session-ops：回执优先带 detail —')
await check('失败回执把 detail 原样交给 Host（模型能看到原因）', async () => {
  let delivered = false
  const posted = []
  const fakeFetch = async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'GET') {
      if (delivered) return { ok: true, json: async () => ({ ok: true, ops: [] }) }
      delivered = true
      return { ok: true, json: async () => ({ ok: true, ops: [{ id: 'op-v', op: 'voice', sessionId: 's1', text: '你好' }] }) }
    }
    posted.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const stop = startSessionOpsPolling({
    baseUrl: 'http://127.0.0.1:1',
    bridge: { applySessionOp: async () => ({ ok: false, error: 'tts-failed', detail: '语音合成失败（baidu）：百度 TTS HTTP 403' }) },
    logger: quietLogger,
    pollMs: 10,
    fetchImpl: fakeFetch,
  })
  await sleep(70)
  stop()
  assert.equal(posted[0].results[0].ok, false)
  assert.equal(posted[0].results[0].detail, '语音合成失败（baidu）：百度 TTS HTTP 403')
})
await check('成功回执也带 detail（Host 可回给模型「已发出」的凭据）', async () => {
  let delivered = false
  const posted = []
  const fakeFetch = async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'GET') {
      if (delivered) return { ok: true, json: async () => ({ ok: true, ops: [] }) }
      delivered = true
      return { ok: true, json: async () => ({ ok: true, ops: [{ id: 'op-v2', op: 'voice', sessionId: 's1', text: '你好' }] }) }
    }
    posted.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const stop = startSessionOpsPolling({
    baseUrl: 'http://127.0.0.1:1',
    bridge: { applySessionOp: async () => ({ ok: true, detail: '已发送语音（baidu，16KB，via=base64，retcode=0）' }) },
    logger: quietLogger,
    pollMs: 10,
    fetchImpl: fakeFetch,
  })
  await sleep(70)
  stop()
  assert.deepEqual(posted[0].results[0], {
    id: 'op-v2', ok: true, detail: '已发送语音（baidu，16KB，via=base64，retcode=0）',
  })
})

console.log('\n— session-ops：voice detached，不阻塞其它 op（P2）—')
await check('voice 慢执行不阻塞同批 clear 回执，voice 回执照常回传', async () => {
  let delivered = false
  const posted = []
  let voiceStarts = 0
  const fakeFetch = async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'GET') {
      if (delivered) return { ok: true, json: async () => ({ ok: true, ops: [] }) }
      delivered = true
      return {
        ok: true,
        json: async () => ({
          ok: true,
          ops: [
            { id: 'op-v', op: 'voice', sessionId: 's1', text: '你好' },
            { id: 'op-c', op: 'clear', key: 'u:1000000001' },
          ],
        }),
      }
    }
    posted.push({ at: Date.now(), results: JSON.parse(init.body).results })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const applySessionOp = async (op) => {
    if (op.op === 'voice') {
      voiceStarts++
      await sleep(150)
      return { ok: true, detail: '已发送语音（baidu，8KB，via=base64，retcode=0）' }
    }
    return { ok: true }
  }
  const stop = startSessionOpsPolling({
    baseUrl: 'http://127.0.0.1:1',
    bridge: { applySessionOp },
    logger: quietLogger,
    pollMs: 10,
    fetchImpl: fakeFetch,
  })
  await sleep(60)
  assert.equal(posted.length, 1, `★ clear 回执应先到（voice 还在跑）：${JSON.stringify(posted)}`)
  assert.deepEqual(posted[0].results.map((r) => r.id), ['op-c'])
  assert.equal(voiceStarts, 1, 'voice 应已开始执行（detached）')
  await sleep(240)
  stop()
  assert.ok(posted.length >= 2, '★ voice 回执照常回传')
  const voiceReceipt = posted.flatMap((p) => p.results).find((r) => r.id === 'op-v')
  assert.ok(voiceReceipt, `voice 回执丢了：${JSON.stringify(posted)}`)
  assert.equal(voiceReceipt.ok, true)
  assert.match(voiceReceipt.detail, /已发送语音/)
})
await check('voice 后台抛错 → 仍回执 ok=false + 可读 detail', async () => {
  let delivered = false
  const posted = []
  const fakeFetch = async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'GET') {
      if (delivered) return { ok: true, json: async () => ({ ok: true, ops: [] }) }
      delivered = true
      return { ok: true, json: async () => ({ ok: true, ops: [{ id: 'op-v2', op: 'voice', sessionId: 's1', text: 'x' }] }) }
    }
    posted.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const stop = startSessionOpsPolling({
    baseUrl: 'http://127.0.0.1:1',
    bridge: { applySessionOp: async () => { throw new Error('tts boom') } },
    logger: quietLogger,
    pollMs: 10,
    fetchImpl: fakeFetch,
  })
  await sleep(60)
  stop()
  const receipt = posted.flatMap((p) => p.results).find((r) => r.id === 'op-v2')
  assert.ok(receipt, `voice 失败回执丢了：${JSON.stringify(posted)}`)
  assert.equal(receipt.ok, false)
  assert.match(receipt.detail, /tts boom/)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
