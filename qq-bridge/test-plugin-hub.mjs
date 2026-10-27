/**
 * 插件通道离线自测（契约 `.recon/plugin-integration-contract.md` §0-§3、§6）。
 *
 * 不连 QQ、不碰 NapCat、不启 DSH：用本地临时 HTTP 服务当 fake 插件（/tools、
 * /match、/health），用假的 qq / dsh 依赖跑真实 Bridge + PluginHub。
 *
 *   node test-plugin-hub.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Bridge } from './src/bridge.mjs'
import { extractVideos, parseMessage } from './src/onebot.mjs'
import {
  PluginHub, normalizePluginHubConfig, toBridgeChatKey, toPluginChatKey,
  BODY_MAX_BYTES, AUTO_REPLY_NEGATIVE_TTL_MS,
} from './src/plugin-hub.mjs'

let pass = 0, fail = 0
/** 支持同步与异步断言：异步用法必须 `await check(...)`。 */
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 所有临时资源（hub / fake 插件 / 临时目录）都登记在这里，最后统一清理。 */
const cleanups = []
const addCleanup = (fn) => cleanups.push(fn)
const tmpDir = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qq-bridge-hub-${label}-`))
  addCleanup(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ } })
  return dir
}
const quietLogger = () => {
  const logs = { warns: [], infos: [], errors: [] }
  const logger = {
    info: (m) => logs.infos.push(String(m)),
    warn: (m) => logs.warns.push(String(m)),
    error: (m) => logs.errors.push(String(m)),
  }
  return { logs, logger }
}

/**
 * fake 插件服务：实现契约 §4 的 GET /health、GET /tools、POST /tools、POST /match。
 * `state.requests` 记录所有收到的请求，便于断言「5s 不重打」「负缓存」。
 */
async function startFakePlugin({ tools = [], match = null, execute = null, delay = {} } = {}) {
  const state = { requests: [], lastMatch: null, lastExecute: null, toolsFetches: 0, matchCalls: 0 }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => { void handle(req, res, chunks) })
  })
  const json = (res, value, status = 200) => {
    if (!res || res.writableEnded || res.destroyed) return
    const body = JSON.stringify(value)
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(body)
    } catch { /* 客户端已经断开（超时测试） */ }
  }
  const handle = async (req, res, chunks) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    let body = {}
    try {
      body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    } catch { body = {} }
    state.requests.push({ method: req.method, path: url.pathname, body })
    if (url.pathname === '/health') return json(res, { ok: true, plugin: 'fake', version: '0.0.1' })
    if (url.pathname === '/tools' && req.method === 'GET') {
      state.toolsFetches++
      if (delay.tools) await sleep(delay.tools)
      return json(res, { ok: true, tools })
    }
    if (url.pathname === '/tools' && req.method === 'POST') {
      state.lastExecute = body
      if (delay.execute) await sleep(delay.execute)
      if (execute) return json(res, execute(body))
      return json(res, { ok: true, content: [{ type: 'text', text: 'ok' }] })
    }
    if (url.pathname === '/match' && req.method === 'POST') {
      state.matchCalls++
      state.lastMatch = body
      if (delay.match) await sleep(delay.match)
      return json(res, match ? match(body) : { handled: false, reason: 'no-match' })
    }
    return json(res, { ok: false, error: '没有这个接口' }, 404)
  }
  server.on('clientError', (error, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* 忽略 */ }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = Number(server.address()?.port ?? 0)
  addCleanup(() => new Promise((resolve) => {
    server.close(() => resolve())
    server.closeIdleConnections?.()
  }))
  return { port, url: `http://127.0.0.1:${port}`, state }
}

/** 造一个只接假 DSH / 假 QQ 的 Bridge（沿用 test-offline.mjs 的 makeBridge 口径）。 */
function makeBridge({ stateFile, sessions, rhythm } = {}) {
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: { private: ['1000000001'], groups: ['123456'], admins: [], allowAllWhenEmpty: false },
      sendDelayMs: 0,
      stateFile: stateFile ?? path.join(tmpDir('state'), 'sessions.json'),
      rhythm: { debounceWindowMs: 0, activityLevel: 3, ...(rhythm ?? {}) },
    },
    logger: quietLogger().logger,
  })
  const calls = {
    prompts: [], sent: [], voices: [], actions: [], created: 0, reply: '好',
  }
  b.dsh = {
    sessionExists: async () => true,
    ensureWorkspace: async () => 'w1',
    createSession: async () => `s${++calls.created}`,
    selectModel: async () => {},
    archiveSession: async () => ({ ok: true }),
    renameSession: async (sid, title) => title,
    sessionTitle: async () => null,
    setSessionPersona: async () => ({ ok: true }),
    promptAndWait: async (sid, text, opts) => { calls.prompts.push({ sid, text, opts }); return calls.reply },
  }
  b.qq.call = async (action, params) => {
    calls.actions.push({ action, params })
    if (action === 'get_group_info') return { status: 'ok', data: { group_name: '测试群' } }
    if (action === 'get_stranger_info') return { status: 'ok', data: { nickname: '小明' } }
    return { status: 'ok', data: {} }
  }
  b.qq.sendPrivate = async (uid, text) => {
    calls.sent.push({ kind: 'private', uid, text })
    return { ok: true, messageIds: ['m1'] }
  }
  b.qq.sendGroup = async (gid, text, opts) => {
    calls.sent.push({ kind: 'group', gid, text, opts })
    return { ok: true, messageIds: ['m2'] }
  }
  b.qq.sendVoice = async (kind, target, base64, opts) => {
    calls.voices.push({ kind, target, base64, opts })
    return { ok: true, messageIds: ['v1'], via: 'base64', retcode: 0, status: 'ok' }
  }
  b.qq.groupAtReply = true
  b.qq.groupAtPosition = 'last'
  b.qq._selfId = '999'
  if (sessions) b.state.sessions = sessions
  return { b, calls }
}

/** 挂一个 hub 到桥接上（`start` 才真监听；出站调用不需要监听）。 */
async function attachHub(bridge, config, { start = false, logger } = {}) {
  const hub = new PluginHub({
    bridge,
    config: normalizePluginHubConfig(config),
    logger: logger ?? quietLogger().logger,
  })
  bridge.pluginHub = hub
  if (start) await hub.start()
  addCleanup(() => hub.stop().catch(() => {}))
  return hub
}

/** 打一次桥接的插件通道 HTTP。 */
async function api(hub, route, { method = 'GET', body, token } = {}) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`http://127.0.0.1:${hub.port}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { payload = null }
  return { status: res.status, body: payload, text }
}

const privMsg = (text, { id = 'pm', videos } = {}) => ({
  kind: 'private', userId: '1000000001', groupId: null, text, messageId: id,
  ...(videos ? { videos } : {}),
})
const groupMsg = (text, { id = 'gm', videos } = {}) => ({
  kind: 'group', userId: '1000000001', groupId: '123456', text, messageId: id,
  ...(videos ? { videos } : {}),
})

// ── 配置与基础工具 ────────────────────────────────────────────────────────
console.log('— 配置默认值（契约 §2.3）—')

await check('默认全关，且带 §2.3 的默认块', () => {
  const config = normalizePluginHubConfig(undefined)
  assert.equal(config.enabled, false)
  assert.equal(config.port, 39410)
  assert.equal(config.token, '')
  assert.deepEqual(config.autoReply, { enabled: false, url: 'http://127.0.0.1:39411', timeoutMs: 800 })
  assert.deepEqual(config.plugins.map((item) => item.id), ['feiyu-voice', 'video-frames'])
  assert.equal(config.plugins[0].url, 'http://127.0.0.1:39412')
  assert.equal(config.plugins[0].timeoutMs, 120000)
  assert.equal(config.plugins[1].timeoutMs, 30000)
  assert.deepEqual(config.video, { enabled: false, maxBytes: 52428800, timeoutMs: 30000 })
})

await check('浅合并：只写部分字段也能补全；脏值夹紧/丢弃', () => {
  const config = normalizePluginHubConfig({
    enabled: true,
    port: 40000,
    autoReply: { enabled: true },
    plugins: [
      { id: 'a', url: 'http://127.0.0.1:1/' },
      { id: 'a', url: 'http://127.0.0.1:2' }, // 重名去掉
      { id: '', url: 'http://127.0.0.1:3' },  // 缺 id 去掉
      { id: 'b', url: 'ftp://x' },            // 非 http(s) 去掉
    ],
    video: { enabled: true, maxBytes: 999999999999 },
  })
  assert.equal(config.enabled, true)
  assert.equal(config.port, 40000)
  assert.equal(config.autoReply.enabled, true)
  assert.equal(config.autoReply.url, 'http://127.0.0.1:39411', '缺省 url 用默认值')
  assert.deepEqual(config.plugins.map((item) => item.id), ['a'])
  assert.equal(config.plugins[0].url, 'http://127.0.0.1:1', '尾部斜杠被去掉')
  assert.equal(config.plugins[0].timeoutMs, 8000, '缺省工具超时 8s')
  assert.equal(config.video.maxBytes, 1024 * 1024 * 1024, '上限被夹紧')
})

await check('未配置时一次 HTTP 都不发：enabled=false 的 hub 起不来、match 直接跳过', async () => {
  const { b } = makeBridge()
  const { logger } = quietLogger()
  const hub = new PluginHub({ bridge: b, config: {}, logger })
  const started = await hub.start()
  assert.equal(started.ok, false)
  assert.equal(started.reason, 'disabled')
  const matched = await hub.matchAutoReply({ kind: 'private', qq: '1000000001', text: '在吗' })
  assert.equal(matched.handled, false)
  assert.equal(matched.skipped, 'disabled')
})

console.log('\n— chatKey 两套写法（契约 §2.1 的 private:/group: ↔ 内部 u:/g:）—')

await check('插件 chatKey → 桥接内部 key', () => {
  assert.equal(toBridgeChatKey('private:1000000001'), 'u:1000000001')
  assert.equal(toBridgeChatKey('group:123456'), 'g:123456')
  assert.equal(toBridgeChatKey('u:1'), 'u:1')
  assert.equal(toBridgeChatKey('g:2'), 'g:2')
  assert.equal(toBridgeChatKey('12345'), '')
  assert.equal(toBridgeChatKey('private:abc'), '')
})

await check('桥接内部 key → 插件 chatKey（feiyu/auto-reply 按前缀判断类型）', () => {
  assert.equal(toPluginChatKey('u:1000000001'), 'private:1000000001')
  assert.equal(toPluginChatKey('g:123456'), 'group:123456')
  assert.equal(toPluginChatKey(''), '')
})

console.log('\n— onebot：video 段提取（契约 §6）—')

await check('video 段解出 url/file/fileSize，文本仍保留 [视频] 占位', () => {
  const segments = [
    { type: 'text', data: { text: '看这个 ' } },
    { type: 'video', data: { url: 'http://127.0.0.1/x.mp4', file: 'x.mp4', file_size: '2048' } },
  ]
  assert.equal(parseMessage(segments), '看这个 [视频]')
  const videos = extractVideos(segments)
  assert.deepEqual(videos, [{ url: 'http://127.0.0.1/x.mp4', file: 'x.mp4', fileSize: 2048 }])
  assert.deepEqual(extractVideos([{ type: 'text', data: { text: 'x' } }]), [])
})

// ── 插件 → 桥接的发送接口 ────────────────────────────────────────────────
console.log('\n— POST /send/text —')

await check('私聊/群聊发送复用 _send（不 @ 人），回 messageIds', async () => {
  const { b, calls } = makeBridge()
  const hub = await attachHub(b, { enabled: true, port: 0, plugins: [] }, { start: true })
  const privateRes = await api(hub, '/send/text', {
    method: 'POST',
    body: { chatKey: 'private:1000000001', text: '插件说的' },
  })
  assert.equal(privateRes.status, 200)
  assert.equal(privateRes.body.ok, true)
  assert.deepEqual(privateRes.body.messageIds, ['m1'])
  assert.deepEqual(calls.sent[0], { kind: 'private', uid: '1000000001', text: '插件说的' })

  const groupRes = await api(hub, '/send/text', {
    method: 'POST',
    body: { chatKey: 'group:123456', text: '群里的' },
  })
  assert.equal(groupRes.body.ok, true)
  const groupCall = calls.sent[1]
  assert.equal(groupCall.kind, 'group')
  assert.equal(groupCall.gid, '123456')
  assert.equal(groupCall.text, '群里的')
  assert.equal(groupCall.opts?.atUserId, undefined, '插件发送不 @ 人（契约 §2.1）')
})

await check('chatKey / text 非法时回 {ok:false,error}（HTTP 200）', async () => {
  const { b } = makeBridge()
  const hub = await attachHub(b, { enabled: true, port: 0, plugins: [] }, { start: true })
  const badKey = await api(hub, '/send/text', { method: 'POST', body: { chatKey: '12345', text: 'x' } })
  assert.equal(badKey.status, 200)
  assert.equal(badKey.body.ok, false)
  assert.match(badKey.body.error, /chatKey/u)
  const empty = await api(hub, '/send/text', { method: 'POST', body: { chatKey: 'private:1', text: '   ' } })
  assert.equal(empty.body.ok, false)
  assert.match(empty.body.error, /text/u)
})

await check('方法不对回 405；未知接口回 404', async () => {
  const { b } = makeBridge()
  const hub = await attachHub(b, { enabled: true, port: 0, plugins: [] }, { start: true })
  const wrong = await api(hub, '/send/text')
  assert.equal(wrong.status, 405)
  assert.equal(wrong.body.ok, false)
  const missing = await api(hub, '/nope')
  assert.equal(missing.status, 404)
})

console.log('\n— POST /send/record —')

await check('走 qq.sendVoice，fallbackDir 指向桥接 state 目录，format 默认 mp3', async () => {
  const { b, calls } = makeBridge()
  const hub = await attachHub(b, { enabled: true, port: 0, plugins: [] }, { start: true })
  const base64 = Buffer.from('fake-wav-bytes').toString('base64')
  const res = await api(hub, '/send/record', {
    method: 'POST',
    body: { chatKey: 'group:123456', base64, format: 'wav' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.format, 'wav')
  assert.equal(res.body.via, 'base64')
  assert.deepEqual(res.body.messageIds, ['v1'])
  const voice = calls.voices[0]
  assert.equal(voice.kind, 'group')
  assert.equal(voice.target, '123456')
  assert.equal(voice.base64, base64)
  assert.equal(voice.opts.fallbackDir, path.dirname(b.statePath), '落盘降级目录 = 桥接 state 目录')

  const defaultFormat = await api(hub, '/send/record', {
    method: 'POST',
    body: { chatKey: 'private:1000000001', base64: Buffer.from('abc').toString('base64') },
  })
  assert.equal(defaultFormat.body.ok, true)
  assert.equal(defaultFormat.body.format, 'mp3')
})

await check('format 非法 / base64 为空时回可读错误', async () => {
  const { b } = makeBridge()
  const hub = await attachHub(b, { enabled: true, port: 0, plugins: [] }, { start: true })
  const badFormat = await api(hub, '/send/record', {
    method: 'POST',
    body: { chatKey: 'private:1', base64: 'AAAA', format: 'ogg' },
  })
  assert.equal(badFormat.body.ok, false)
  assert.match(badFormat.body.error, /wav|mp3/u)
  const empty = await api(hub, '/send/record', {
    method: 'POST',
    body: { chatKey: 'private:1', base64: '' },
  })
  assert.equal(empty.body.ok, false)
  assert.match(empty.body.error, /base64/u)
})

console.log('\n— 鉴权 / 请求体上限（契约 §1）—')

await check('token 配置后：无 token / 错 token 都 401，对的放行', async () => {
  const { b, calls } = makeBridge()
  const hub = await attachHub(b, { enabled: true, port: 0, token: 's3cr3t-token', plugins: [] }, { start: true })
  const body = { chatKey: 'private:1000000001', text: 'hi' }
  const none = await api(hub, '/send/text', { method: 'POST', body })
  assert.equal(none.status, 401)
  assert.equal(none.body.ok, false)
  const wrong = await api(hub, '/send/text', { method: 'POST', body, token: 'nope' })
  assert.equal(wrong.status, 401)
  const ok = await api(hub, '/send/text', { method: 'POST', body, token: 's3cr3t-token' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(calls.sent.length, 1, '只有带对 token 的那次真的发了')
  const toolsNoAuth = await api(hub, '/plugins/tools')
  assert.equal(toolsNoAuth.status, 401)
})

await check('请求体超过 1MB 上限回 {ok:false}（HTTP 200）', async () => {
  const { b } = makeBridge()
  const hub = await attachHub(b, { enabled: true, port: 0, plugins: [] }, { start: true })
  const oversized = 'x'.repeat(BODY_MAX_BYTES + 1024)
  const res = await api(hub, '/send/text', {
    method: 'POST',
    body: { chatKey: 'private:1000000001', text: oversized },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, false)
  assert.match(res.body.error, /上限/u)
})

// ── guard → 桥接的工具接口 ───────────────────────────────────────────────
console.log('\n— GET /plugins/tools（聚合 + 不可达跳过 + 5s 不重打）—')

const fakeTools = [
  {
    name: 'fake_echo',
    title: '回声',
    description: '把参数回显',
    parameters: { type: 'object', properties: { x: { type: 'number' } }, required: [] },
    timeoutMs: 120000,
  },
  {
    name: 'fake_slow',
    title: '慢工具',
    description: '永远超时',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 100,
  },
  // 名字非法的（含空格）不下发；合法的短 id 由 guard 统一加 qq_ext_ 前缀。
  { name: 'evil tool', title: '不该出现', parameters: { type: 'object', properties: {} } },
]

await check('聚合多个插件：名字校验（短 id 原样下发）、timeoutMs 取清单值、plugin 标来源', async () => {
  const fake = await startFakePlugin({ tools: fakeTools })
  const logs = quietLogger()
  const { b } = makeBridge()
  const hub = await attachHub(b, {
    enabled: true,
    port: 0,
    plugins: [
      { id: 'fake-a', url: fake.url, timeoutMs: 5000 },
      { id: 'dead', url: 'http://127.0.0.1:1', timeoutMs: 300 },
    ],
  }, { start: true, logger: logs.logger })
  const res = await api(hub, '/plugins/tools')
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  const names = res.body.tools.map((tool) => tool.name)
  assert.deepEqual(names, ['fake_echo', 'fake_slow'])
  const echo = res.body.tools[0]
  assert.equal(echo.plugin, 'fake-a')
  assert.equal(echo.title, '回声')
  assert.equal(echo.description, '把参数回显')
  assert.equal(echo.timeoutMs, 120000)
  assert.deepEqual(echo.parameters, fakeTools[0].parameters)
  assert.equal(res.body.tools[1].timeoutMs, 100)
  assert.ok(logs.logs.warns.some((line) => line.includes('dead')), '不可达插件只 warn，不失败')

  // 5 秒内再拉一次：不再打插件（契约 §2.2）。
  const before = fake.state.toolsFetches
  const again = await api(hub, '/plugins/tools')
  assert.equal(again.body.tools.length, 2)
  assert.equal(fake.state.toolsFetches, before, '5s 内不重复打插件')
})

console.log('\n— POST /plugins/tools/execute（注入 chatKey + 原样透传）—')

await check('私聊 sessionId → args.chatKey=private:<QQ号>，content 原样透传', async () => {
  const fake = await startFakePlugin({
    tools: fakeTools,
    execute: (body) => ({
      ok: true,
      content: [{ type: 'text', text: `echo ${body.name} ${body.args?.x} ${body.args?.chatKey}` }],
    }),
  })
  const { b } = makeBridge({ sessions: { 'u:1000000001': { sessionId: 'sess-private', unread: 0 } } })
  const hub = await attachHub(b, { enabled: true, port: 0, plugins: [{ id: 'fake-a', url: fake.url }] }, { start: true })
  const res = await api(hub, '/plugins/tools/execute', {
    method: 'POST',
    body: { name: 'fake_echo', args: { x: 7 }, sessionId: 'sess-private' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.content[0].text, 'echo fake_echo 7 private:1000000001')
  assert.equal(fake.state.lastExecute.name, 'fake_echo')
  assert.equal(fake.state.lastExecute.args.x, 7)
  assert.equal(fake.state.lastExecute.args.chatKey, 'private:1000000001')
})

await check('群聊 sessionId → args.chatKey=group:<群号>', async () => {
  const fake = await startFakePlugin({
    tools: fakeTools,
    execute: (body) => ({ ok: true, content: [{ type: 'text', text: String(body.args?.chatKey) }] }),
  })
  const { b } = makeBridge({ sessions: { 'g:123456': { sessionId: 'sess-group', unread: 0 } } })
  const hub = await attachHub(b, { enabled: true, port: 0, plugins: [{ id: 'fake-a', url: fake.url }] }, { start: true })
  const res = await api(hub, '/plugins/tools/execute', {
    method: 'POST',
    body: { name: 'fake_echo', args: {}, sessionId: 'sess-group' },
  })
  assert.equal(res.body.ok, true)
  assert.equal(res.body.content[0].text, 'group:123456')
})

await check('sessionId 反查不到 → 可读错误（不发插件请求）', async () => {
  const fake = await startFakePlugin({ tools: fakeTools })
  const { b } = makeBridge()
  const hub = await attachHub(b, { enabled: true, port: 0, plugins: [{ id: 'fake-a', url: fake.url }] }, { start: true })
  const res = await api(hub, '/plugins/tools/execute', {
    method: 'POST',
    body: { name: 'fake_echo', args: {}, sessionId: 'unknown-session' },
  })
  assert.equal(res.body.ok, false)
  assert.match(res.body.error, /先让用户发条 QQ 消息/u)
  assert.equal(fake.state.lastExecute, null)
})

await check('工具名不存在 → {ok:false,error}', async () => {
  const fake = await startFakePlugin({ tools: fakeTools })
  const { b } = makeBridge({ sessions: { 'u:1000000001': { sessionId: 'sess-private', unread: 0 } } })
  const hub = await attachHub(b, { enabled: true, port: 0, plugins: [{ id: 'fake-a', url: fake.url }] }, { start: true })
  const res = await api(hub, '/plugins/tools/execute', {
    method: 'POST',
    body: { name: 'not_there', args: {}, sessionId: 'sess-private' },
  })
  assert.equal(res.body.ok, false)
  assert.match(res.body.error, /没有这个工具/u)
})

await check('插件执行超时按清单 timeoutMs 截断，回可读错误', async () => {
  // 慢工具：服务端 400ms 才回，清单里 timeoutMs=100 → 桥接侧必须按 100ms 截断。
  const slowFake = await startFakePlugin({
    tools: fakeTools,
    delay: { execute: 400 },
    execute: () => ({ ok: true, content: [{ type: 'text', text: '迟到' }] }),
  })
  const { b } = makeBridge({ sessions: { 'u:1000000001': { sessionId: 'sess-private', unread: 0 } } })
  const hub = await attachHub(b, { enabled: true, port: 0, plugins: [{ id: 'fake-slow', url: slowFake.url }] }, { start: true })
  const started = Date.now()
  const res = await api(hub, '/plugins/tools/execute', {
    method: 'POST',
    body: { name: 'fake_slow', args: {}, sessionId: 'sess-private' },
  })
  assert.equal(res.body.ok, false)
  assert.match(res.body.error, /超时/u)
  assert.ok(Date.now() - started < 3000, '按 timeoutMs 截断，不该等满 400ms 以上太久')
})

await check('插件不可达：清单拉不到 → 工具不存在（不抛错）', async () => {
  const logs = quietLogger()
  const { b } = makeBridge({ sessions: { 'u:1000000001': { sessionId: 'sess-private', unread: 0 } } })
  const hub = await attachHub(b, {
    enabled: true,
    port: 0,
    plugins: [{ id: 'dead', url: 'http://127.0.0.1:1', timeoutMs: 200 }],
  }, { start: true, logger: logs.logger })
  const res = await api(hub, '/plugins/tools/execute', {
    method: 'POST',
    body: { name: 'anything', args: {}, sessionId: 'sess-private' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, false)
  assert.match(res.body.error, /没有这个工具/u)
  assert.ok(logs.logs.warns.length >= 1)
})

// ── 入站自动回复（桥接侧拦截，契约 §3） ──────────────────────────────────
console.log('\n— auto-reply 前置拦截（契约 §3）—')

await check('命中：直接发送、计 stats.autoReplies、不进 DSH、不建会话', async () => {
  const fake = await startFakePlugin({
    match: (body) => (String(body.text).includes('在吗')
      ? { handled: true, reply: '在的呀' }
      : { handled: false, reason: 'no-match' }),
  })
  const { b, calls } = makeBridge()
  const hub = await attachHub(b, {
    enabled: false,
    port: 0,
    plugins: [],
    autoReply: { enabled: true, url: fake.url, timeoutMs: 500 },
  })
  await b.handleMessage(privMsg('在吗'))
  assert.equal(b.stats.autoReplies, 1)
  assert.equal(calls.sent.length, 1)
  assert.deepEqual(calls.sent[0], { kind: 'private', uid: '1000000001', text: '在的呀' })
  assert.equal(calls.prompts.length, 0, '★ 命中不进 DSH')
  assert.equal(calls.created, 0, '★ 命中不建会话')
  assert.equal(fake.state.matchCalls, 1)
  assert.equal(fake.state.lastMatch.chatKey, 'private:1000000001')
  assert.equal(fake.state.lastMatch.senderId, '1000000001')
})

await check('未命中：照常交给 DSH', async () => {
  const fake = await startFakePlugin({ match: () => ({ handled: false, reason: 'no-match' }) })
  const { b, calls } = makeBridge()
  await attachHub(b, {
    enabled: false,
    port: 0,
    plugins: [],
    autoReply: { enabled: true, url: fake.url, timeoutMs: 500 },
  })
  await b.handleMessage(privMsg('今天天气不错'))
  assert.equal(b.stats.autoReplies, 0)
  assert.equal(calls.prompts.length, 1)
  assert.match(calls.prompts[0].text, /今天天气不错/u)
  assert.equal(calls.sent.length, 1, 'DSH 回复照常发出')
  assert.equal(calls.sent[0].text, '好')
})

await check('不受静音 / 响应档位影响（群聊 0 档 + 静音中仍然自动回复）', async () => {
  const fake = await startFakePlugin({ match: () => ({ handled: true, reply: '自动的' }) })
  const { b, calls } = makeBridge()
  b.live.rhythm = { ...b.live.rhythm, activityLevel: 0 }
  b._muted.set('g:123456', Date.now() + 60_000)
  await attachHub(b, {
    enabled: false,
    port: 0,
    plugins: [],
    autoReply: { enabled: true, url: fake.url, timeoutMs: 500 },
  })
  await b.handleMessage(groupMsg('随便聊聊'))
  assert.equal(b.stats.autoReplies, 1)
  assert.equal(calls.sent.length, 1)
  assert.equal(calls.sent[0].kind, 'group')
  assert.equal(calls.sent[0].text, '自动的')
  assert.equal(calls.prompts.length, 0)
})

await check('autoReply.enabled=false：一条 /match 都不发', async () => {
  const fake = await startFakePlugin({ match: () => ({ handled: true, reply: '不该出现' }) })
  const { b, calls } = makeBridge()
  await attachHub(b, { enabled: false, port: 0, plugins: [], autoReply: { enabled: false, url: fake.url } })
  await b.handleMessage(privMsg('在吗'))
  assert.equal(fake.state.matchCalls, 0)
  assert.equal(b.stats.autoReplies, 0)
  assert.equal(calls.prompts.length, 1)
})

await check('超时：消息照常进 DSH，warn 一次 + 30s 负缓存（不重复打）', async () => {
  const logs = quietLogger()
  const fake = await startFakePlugin({
    delay: { match: 400 },
    match: () => ({ handled: true, reply: '迟到的回复' }),
  })
  const { b, calls } = makeBridge()
  await attachHub(b, {
    enabled: false,
    port: 0,
    plugins: [],
    autoReply: { enabled: true, url: fake.url, timeoutMs: 100 },
  }, { logger: logs.logger })
  await b.handleMessage(privMsg('第一条'))
  assert.equal(calls.prompts.length, 1, '超时不影响聊天')
  assert.equal(b.stats.autoReplies, 0)
  assert.equal(fake.state.matchCalls, 1)
  assert.equal(logs.logs.warns.length, 1, '失败只 warn 一次')

  await b.handleMessage(privMsg('第二条', { id: 'pm2' }))
  assert.equal(fake.state.matchCalls, 1, '负缓存窗口内不再请求')
  assert.equal(calls.prompts.length, 2)
  assert.equal(AUTO_REPLY_NEGATIVE_TTL_MS, 30_000)
})

await check('插件不可达：只 warn，消息照常进 DSH', async () => {
  const logs = quietLogger()
  const { b, calls } = makeBridge()
  await attachHub(b, {
    enabled: false,
    port: 0,
    plugins: [],
    autoReply: { enabled: true, url: 'http://127.0.0.1:1', timeoutMs: 200 },
  }, { logger: logs.logger })
  await b.handleMessage(privMsg('在吗'))
  assert.equal(calls.prompts.length, 1)
  assert.equal(b.stats.autoReplies, 0)
  assert.equal(logs.logs.warns.length, 1)
  assert.match(logs.logs.warns[0], /自动回复/u)
})

// ── 视频落盘（契约 §6） ──────────────────────────────────────────────────
console.log('\n— 视频落盘（契约 §6）—')

await check('本地临时文件当 url 源：落到 state/media/，正文追加本地绝对路径', async () => {
  const sourceDir = tmpDir('video-src')
  const sourceFile = path.join(sourceDir, 'clip.mp4')
  const payload = Buffer.alloc(2048, 7)
  fs.writeFileSync(sourceFile, payload)
  const stateFile = path.join(tmpDir('video-state'), 'sessions.json')
  const { b, calls } = makeBridge({ stateFile })
  await attachHub(b, {
    enabled: false,
    port: 0,
    plugins: [],
    video: { enabled: true, maxBytes: 1024 * 1024, timeoutMs: 5000 },
  })
  await b.handleMessage(privMsg('[视频]', { videos: [{ url: sourceFile, file: 'clip.mp4', fileSize: payload.length }] }))
  assert.equal(calls.prompts.length, 1)
  const prompt = calls.prompts[0].text
  assert.ok(prompt.includes('[视频]'), '原占位保留')
  const matched = /\[视频\]（本地文件：([^）]+)）/.exec(prompt)
  assert.ok(matched, `正文里应有本地路径，实际：${prompt}`)
  const localFile = matched[1]
  assert.ok(path.isAbsolute(localFile), '应是绝对路径')
  assert.ok(localFile.startsWith(path.join(path.dirname(stateFile), 'media') + path.sep), '应落在 state/media/')
  assert.ok(fs.existsSync(localFile), '文件应已落盘')
  assert.deepEqual(fs.readFileSync(localFile), payload, '内容一致')
})

await check('video.enabled=false：不下载、正文不加路径', async () => {
  const sourceDir = tmpDir('video-src-off')
  const sourceFile = path.join(sourceDir, 'clip.mp4')
  fs.writeFileSync(sourceFile, Buffer.alloc(64, 1))
  const stateFile = path.join(tmpDir('video-state-off'), 'sessions.json')
  const { b, calls } = makeBridge({ stateFile })
  await attachHub(b, { enabled: false, port: 0, plugins: [], video: { enabled: false } })
  await b.handleMessage(privMsg('[视频]', { videos: [{ url: sourceFile }] }))
  assert.equal(calls.prompts.length, 1)
  assert.ok(!calls.prompts[0].text.includes('本地文件'))
  assert.equal(fs.existsSync(path.join(path.dirname(stateFile), 'media')), false)
})

await check('下载失败（源不存在）：只 warn，保持原 [视频] 占位', async () => {
  const logs = quietLogger()
  const stateFile = path.join(tmpDir('video-state-fail'), 'sessions.json')
  const { b, calls } = makeBridge({ stateFile })
  await attachHub(b, {
    enabled: false,
    port: 0,
    plugins: [],
    video: { enabled: true, maxBytes: 1024, timeoutMs: 2000 },
  }, { logger: logs.logger })
  await b.handleMessage(privMsg('[视频]', { videos: [{ url: path.join(tmpDir('video-missing'), 'nope.mp4') }] }))
  assert.equal(calls.prompts.length, 1)
  assert.equal(calls.prompts[0].text, '[视频]')
  assert.ok(logs.logs.warns.some((line) => line.includes('视频下载失败')))
})

await check('超过 maxBytes：不落盘（失败只 warn）', async () => {
  const sourceDir = tmpDir('video-src-big')
  const sourceFile = path.join(sourceDir, 'big.mp4')
  fs.writeFileSync(sourceFile, Buffer.alloc(4096, 3))
  const { b, calls } = makeBridge({ stateFile: path.join(tmpDir('video-state-big'), 'sessions.json') })
  await attachHub(b, {
    enabled: false,
    port: 0,
    plugins: [],
    video: { enabled: true, maxBytes: 1024, timeoutMs: 2000 },
  })
  await b.handleMessage(privMsg('[视频]', { videos: [{ url: sourceFile }] }))
  assert.equal(calls.prompts[0].text, '[视频]')
})

// ── 视频抽帧（2026-10-27 真机 Bug：发 MP4 模型只看到「[视频]」）────────────────
console.log('\n— 视频抽帧（video-frames 微服务）—')

/** 造一个「抽帧成功」的假 video-frames：返回 1 条 text + N 个 image block。 */
const framesPlugin = (frames) => ({
  tools: [{ name: 'read_video', title: '看视频（抽帧）', parameters: { type: 'object', properties: {} } }],
  execute: (body) => ({
    ok: true,
    content: [
      { type: 'text', text: `已抽 ${frames.length} 帧` },
      ...frames.map((buf) => ({ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' })),
    ],
  }),
})

await check('★ 下载成功后把本地路径交给抽帧服务，帧以 image part 塞进 prompt content', async () => {
  const frames = [Buffer.alloc(64, 1), Buffer.alloc(64, 2), Buffer.alloc(64, 3)]
  const fake = await startFakePlugin(framesPlugin(frames))
  const sourceDir = tmpDir('video-frame-src')
  const sourceFile = path.join(sourceDir, 'clip.mp4')
  fs.writeFileSync(sourceFile, Buffer.alloc(2048, 7))
  const { b, calls } = makeBridge({ stateFile: path.join(tmpDir('video-frame-state'), 'sessions.json') })
  await attachHub(b, {
    enabled: false,
    port: 0,
    plugins: [{ id: 'video-frames', url: fake.url, timeoutMs: 5000 }],
    video: { enabled: true, maxBytes: 1024 * 1024, timeoutMs: 5000 },
  })
  await b.handleMessage(privMsg('[视频]', { videos: [{ url: sourceFile, file: 'clip.mp4' }] }))

  // 1）抽帧请求打的是 POST /tools，名字与参数都对
  const execute = fake.state.lastExecute
  assert.equal(execute?.name, 'read_video', '应调用抽帧工具')
  assert.ok(path.isAbsolute(String(execute.args?.filePath)), '参数应是桥接下载后的本地绝对路径')
  assert.ok(fs.existsSync(execute.args.filePath), '交给服务前文件必须已落盘')

  // 2）帧变成了 prompt 里的 image part（底座是 data URL → 解码成纯 base64）
  const prompt = calls.prompts[0]
  assert.ok(prompt.text.includes('[视频]（本地文件：'), '原占位与本地路径都保留')
  assert.ok(prompt.text.includes('已抽成 3 张截图'), `正文应说明给的是截图，实际：${prompt.text}`)
  const parts = Array.isArray(prompt.opts?.content) ? prompt.opts.content : []
  const images = parts.filter((part) => part?.type === 'image')
  assert.equal(images.length, 3, `应有 3 张截图，实际 ${images.length}`)
  assert.equal(images[0].data, frames[0].toString('base64'), '第 1 帧内容要对得上')
  assert.equal(images[0].mediaType, 'image/jpeg')
  assert.equal(parts[0].type, 'text', '文本段在最前面')
})

await check('抽帧服务不可达：只 warn，保留 [视频] 纯文本占位（不抛）', async () => {
  const logs = quietLogger()
  const sourceDir = tmpDir('video-frame-down-src')
  const sourceFile = path.join(sourceDir, 'clip.mp4')
  fs.writeFileSync(sourceFile, Buffer.alloc(1024, 5))
  const { b, calls } = makeBridge({ stateFile: path.join(tmpDir('video-frame-down-state'), 'sessions.json') })
  await attachHub(b, {
    enabled: false,
    port: 0,
    plugins: [{ id: 'video-frames', url: 'http://127.0.0.1:1', timeoutMs: 300 }],
    video: { enabled: true, maxBytes: 1024 * 1024, timeoutMs: 3000 },
  }, { logger: logs.logger })
  await b.handleMessage(privMsg('[视频]', { videos: [{ url: sourceFile }] }))
  const prompt = calls.prompts[0]
  assert.ok(prompt.text.includes('[视频]'), '原占位保留')
  assert.ok(!prompt.opts?.content, '没有帧就不该有 image part')
  assert.ok(logs.logs.warns.some((line) => line.includes('视频抽帧')), '应留下一条可读的 warn')
})

await check('抽帧服务报错（ok:false）：正文补一句「看不到画面」，不编造', async () => {
  const fake = await startFakePlugin({
    tools: [{ name: 'read_video', parameters: { type: 'object', properties: {} } }],
    execute: () => ({ ok: false, error: '未找到 ffmpeg（抽帧需要它）' }),
  })
  const sourceDir = tmpDir('video-frame-err-src')
  const sourceFile = path.join(sourceDir, 'clip.mp4')
  fs.writeFileSync(sourceFile, Buffer.alloc(512, 9))
  const { b, calls } = makeBridge({ stateFile: path.join(tmpDir('video-frame-err-state'), 'sessions.json') })
  await attachHub(b, {
    enabled: false,
    port: 0,
    plugins: [{ id: 'video-frames', url: fake.url, timeoutMs: 5000 }],
    video: { enabled: true, maxBytes: 1024 * 1024, timeoutMs: 5000 },
  })
  await b.handleMessage(privMsg('[视频]', { videos: [{ url: sourceFile }] }))
  const prompt = calls.prompts[0]
  assert.ok(prompt.text.includes('没能抽帧'), `应如实说明抽帧失败，实际：${prompt.text}`)
  assert.ok(!prompt.opts?.content, '没有帧就不该有 image part')
})

// ── sessionId → chatKey 反查（ensureSession 时记录） ─────────────────────
console.log('\n— sessionId→chatKey 反查表 —')

await check('ensureSession 建会话后 chatKeyForSession 能反查到', async () => {
  const { b } = makeBridge()
  await b.handleMessage(privMsg('你好'))
  assert.equal(b.chatKeyForSession('s1'), 'u:1000000001')
  assert.equal(b.chatKeyForSession(''), '')
  assert.equal(b.chatKeyForSession('nope'), '')
})

// ── 生命周期 ────────────────────────────────────────────────────────────
console.log('\n— hub 生命周期 —')

await check('enabled=true 能起监听、stop 后端口释放', async () => {
  const { b } = makeBridge()
  const hub = new PluginHub({ bridge: b, config: { enabled: true, port: 0, plugins: [] }, logger: quietLogger().logger })
  const started = await hub.start()
  assert.equal(started.ok, true)
  assert.ok(started.port > 0)
  const health = await api(hub, '/health')
  assert.equal(health.body.ok, true)
  assert.equal(health.body.plugin, 'bridge-plugin-hub')
  await hub.stop()
  await hub.stop() // 重复 stop 不炸
})

// 统一清理临时资源（hub / fake 插件 / 临时目录）。
for (const cleanup of cleanups.reverse()) {
  try { await cleanup() } catch { /* 清理失败不影响结论 */ }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
