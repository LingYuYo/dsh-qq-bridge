/**
 * QQ 插件 HTTP 工具源离线用例（plugin-integration-contract §5）。
 *
 * 用本地临时 HTTP 服务当 **fake 桥接**（plugin hub），覆盖：
 *   · 清单拉取 → 同名代理工具注册（名字 / 描述 / JSON Schema → 作者 spec / Bearer token）；
 *   · execute 转发（`{name,args,sessionId}`、args 原样、sessionId 两种取法）；
 *   · 回包 content blocks：text 直通、image 转**附件引用**块（DSH 只认
 *     `{type:'image',attachment}`，不认裸 base64），拿不到附件服务时降级成文字；
 *   · 401 / 超时 / HTTP 500 / 连不上 → throw 中文可读错误（含插件名与原因）；
 *   · 清单拉取失败只 warn（限流一次）且 apply 不抛；
 *   · baseUrl 非回环 → 跳过（一个请求都不打）；enabled=false → 不请求；
 *   · applyGuard 真链路：`mod.apply(ctx, Config({role:'guard', httpTools}))` 能注册出工具，
 *     且 `qq_ext_` 前缀被执行期白名单放行。
 *
 * 运行：node test-http-tools.mjs
 * （需要 `@deepseek-ai/schemastery`；用 QQG_SCHEMASTERY 给绝对路径，不设就自动探测。）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function resolveSchemastery() {
  if (process.env.QQG_SCHEMASTERY) return process.env.QQG_SCHEMASTERY
  const candidates = [
    path.join(HERE, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
    path.resolve(HERE, '../../node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
  ]
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  console.error('找不到 @deepseek-ai/schemastery；请设 QQG_SCHEMASTERY 指向它的 lib/index.mjs')
  process.exit(2)
}

// 与其它离线用例同款：把 index.js 里的 schemastery 说明符换成本机绝对路径再导入。
const SRC = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')
const patched = SRC.replace(
  /^import Schema from '@deepseek-ai\/schemastery'$/m,
  `import Schema from ${JSON.stringify('file:///' + resolveSchemastery().replace(/\\/g, '/'))}`,
)
if (patched === SRC) {
  console.error('index.js 里没找到 schemastery 的静态 import 行，补丁失败')
  process.exit(2)
}
const tmpFile = path.join(HERE, `.tmp-http-tools-${process.pid}.mjs`)
fs.writeFileSync(tmpFile, patched)
let mod
try {
  mod = await import('file:///' + tmpFile.replace(/\\/g, '/'))
} finally {
  try { fs.unlinkSync(tmpFile) } catch { /* 忽略 */ }
}

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    pass++
  } catch (error) {
    console.log(`  ✗ ${name}\n      ${error?.stack ?? error}`)
    fail++
  }
}

/* ── fake 桥接（plugin hub）─────────────────────────────────────── */

const TOOL_VOICE = {
  name: 'send_custom_voice',
  title: '发语音',
  description: '把一段文字合成语音并以 QQ 语音条发出。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要合成的正文' },
      style: { type: 'string', enum: ['cute', 'gentle'], description: '语气' },
    },
    required: ['text'],
  },
  timeoutMs: 120000,
  plugin: 'feiyu-voice',
}

const TOOL_VIDEO = {
  name: 'read_video',
  title: '读视频',
  description: '抽帧后把画面交给模型。',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string' },
      count: { type: 'integer', description: '抽几帧' },
    },
    required: ['filePath'],
  },
  plugin: 'video-frames',
}

/**
 * 起一个 fake plugin hub，行为可按用例现改。
 * @returns {Promise<{baseUrl:string, state:object, close:Function}>}
 */
async function startFakeBridge() {
  const state = {
    requests: [],
    manifest: { ok: true, tools: [TOOL_VOICE, TOOL_VIDEO] },
    manifestBody: null,       // 直接覆盖回包（坏 JSON / 非对象）
    manifestStatus: 200,
    manifestDelayMs: 0,
    execute: () => ({ ok: true, content: [{ type: 'text', text: '已发送' }] }),
    executeStatus: 200,
    executeDelayMs: 0,
  }
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body
    try { body = raw === '' ? undefined : JSON.parse(raw) } catch { body = raw }
    state.requests.push({ method: req.method, url: req.url, headers: req.headers, body })

    const reply = (status, payload, delayMs = 0) => {
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
      }, delayMs)
    }
    if (req.method === 'GET' && req.url === '/plugins/tools') {
      return reply(state.manifestStatus, state.manifestBody ?? state.manifest, state.manifestDelayMs)
    }
    if (req.method === 'POST' && req.url === '/plugins/tools/execute') {
      const payload = state.execute(body)
      return reply(state.executeStatus, payload, state.executeDelayMs)
    }
    reply(404, { ok: false, error: 'not found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 一个已经关闭的端口（测「连不上桥接」）。 */
async function unusedBaseUrl() {
  const server = http.createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return `http://127.0.0.1:${port}`
}

/* ── 假 ctx ─────────────────────────────────────────────────────── */

function makeGuardCtx({ attachments } = {}) {
  const calls = { registeredTools: [], guardFn: null, guard: 0, disposers: [] }
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { composedPreset: () => 'qq-chat' }
      if (name === 'attachments') return attachments
      if (name === 'tools') return ctx.tools
      return undefined
    },
    on() { return () => {} },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') calls.disposers.push(dispose)
      return () => {}
    },
    inject() {},
    tools: {
      restrict(filter) {
        const names = [...(filter?.allow ?? []), ...(filter?.deny ?? [])]
        if (names.some((name) => String(name).startsWith('__'))) {
          throw new Error('tools.restrict() names unknown global tool')
        }
        return () => {}
      },
      guard(fn) { calls.guard += 1; calls.guardFn = fn },
      register(definition) { calls.registeredTools.push(definition); return () => {} },
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, calls }
}

/** 当前用例的 httpTools 配置（走真实 Config 解析，顺带验证 Schema）。 */
function httpConfig(overrides = {}) {
  return mod.Config({ role: 'guard', httpTools: overrides })
}

/** 捕获 console.warn（部分用例断言「只 warn 一次」）。 */
async function captureWarns(fn) {
  const warns = []
  const originalWarn = console.warn
  console.warn = (...args) => { warns.push(args.map(String).join(' ')) }
  try {
    await fn(warns)
  } finally {
    console.warn = originalWarn
  }
  return warns
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时（${timeoutMs}ms）`)
}

const ping = (tool, args = {}, exec = {}) => tool.execute(args, exec)

console.log('QQ 插件 HTTP 工具源（fake plugin hub）：')

/* ── 0. 外部插件代理命名（2026-10-27 回归：中文工具名曾退化成 qq_ext_tool） ── */

await check('externalToolProxyName：中文名用 ASCII id 兜底，不再变成 qq_ext_tool / _2', () => {
  const first = mod.externalToolProxyName('关键词自动回复', new Set(), 'keyword-reply__keyword_reply')
  assert.equal(first, 'qq_ext_keyword_reply__keyword_reply')
  const second = mod.externalToolProxyName('查看关键词列表', new Set([first]), 'keyword-reply__keyword_reply_list')
  assert.equal(second, 'qq_ext_keyword_reply__keyword_reply_list')
  assert.notEqual(second, 'qq_ext_tool_2')
  // 连 ASCII 兜底都没有时才退回 tool（最后一道保险）
  assert.equal(mod.externalToolProxyName('中文', new Set()), 'qq_ext_tool')
})

/* ── 1. 清单 → 注册 ─────────────────────────────────────────────── */

const bridge = await startFakeBridge()
{
  const { ctx, calls } = makeGuardCtx()
  const result = await mod.applyHttpTools(ctx, httpConfig({
    enabled: true,
    baseUrl: bridge.baseUrl,
    token: 'secret-token',
  }))

  await check('清单拉取：GET /plugins/tools 带 Bearer token，注册同名工具', () => {
    const manifestReq = bridge.state.requests.find((req) => req.url === '/plugins/tools')
    assert.ok(manifestReq, '没有请求清单')
    assert.equal(manifestReq.method, 'GET')
    assert.equal(manifestReq.headers.authorization, 'Bearer secret-token')
    assert.deepEqual(result.registered, ['qq_ext_send_custom_voice', 'qq_ext_read_video'])
    assert.deepEqual(calls.registeredTools.map((tool) => tool.name), result.registered)
  })

  const voice = calls.registeredTools.find((tool) => tool.name === 'qq_ext_send_custom_voice')
  const video = calls.registeredTools.find((tool) => tool.name === 'qq_ext_read_video')

  await check('描述：保留清单原文 + 标明来源插件', () => {
    assert.match(voice.description, /把一段文字合成语音/)
    assert.match(voice.description, /feiyu-voice/)
    assert.match(video.description, /video-frames/)
  })

  await check('parameters：JSON Schema → 作者 spec（required / enum / integer 都对）', () => {
    assert.equal(voice.parameters.type, 'object')
    assert.equal(voice.parameters.properties.text.type, 'string')
    assert.equal(voice.parameters.properties.text.description, '要合成的正文')
    assert.deepEqual(voice.parameters.required, ['text'])
    assert.equal(voice.parameters.properties.style.type, 'string')
    assert.deepEqual(voice.parameters.properties.style.enum, ['cute', 'gentle'])
    assert.deepEqual(video.parameters.required, ['filePath'])
    assert.equal(video.parameters.properties.count.type, 'integer')
  })

  await check('output：schema 是对象，render 把 value.blocks 原样展开；空值有兜底文案', () => {
    assert.equal(voice.output.schema.type, 'object')
    assert.deepEqual(
      voice.output.render({}, { blocks: [{ type: 'text', text: '喂' }] }),
      [{ type: 'text', text: '喂' }],
    )
    assert.deepEqual(voice.output.render({}, {}), [{ type: 'text', text: '（QQ 插件没有返回内容）' }])
  })

  /* ── 2. execute 转发 ──────────────────────────────────────────── */

  await check('execute：POST /plugins/tools/execute，body {name,args,sessionId}，args 原样', async () => {
    const value = await ping(voice, { text: '你好呀', style: 'cute' }, { agent: { id: 'sess-42' } })
    const request = bridge.state.requests.filter((req) => req.url === '/plugins/tools/execute').at(-1)
    assert.deepEqual(request.body, {
      // 执行时发给桥接的是清单里的**原名**（短 id），前缀只是 DSH 侧的白名单标记
      name: 'send_custom_voice',
      args: { text: '你好呀', style: 'cute' },
      sessionId: 'sess-42',
    })
    assert.equal(request.headers.authorization, 'Bearer secret-token')
    assert.deepEqual(value, { blocks: [{ type: 'text', text: '已发送' }] })
  })

  await check('execute：sessionId 取不到 agent.id 时退到 agent.session.id', async () => {
    await ping(voice, { text: '再来一条' }, { agent: { session: { id: 'sess-99' } } })
    const request = bridge.state.requests.filter((req) => req.url === '/plugins/tools/execute').at(-1)
    assert.equal(request.body.sessionId, 'sess-99')
  })

  await check('execute：桥接回 ok:false → throw 中文错误（含插件名与原因）', async () => {
    bridge.state.execute = () => ({ ok: false, error: 'TTS 合成失败了' })
    try {
      bridge.state.executeStatus = 200
      await ping(voice, { text: 'x' }, { agent: { id: 'sess-1' } })
      assert.fail('应该抛错')
    } catch (error) {
      assert.match(error.message, /feiyu-voice/)
      assert.match(error.message, /TTS 合成失败了/)
    }
  })

  await check('execute：401 → 可读错误（提到 token 不一致）', async () => {
    bridge.state.executeStatus = 401
    bridge.state.execute = () => ({ ok: false, error: 'unauthorized' })
    try {
      await ping(voice, { text: 'x' }, { agent: { id: 'sess-1' } })
      assert.fail('应该抛错')
    } catch (error) {
      assert.match(error.message, /401/)
      assert.match(error.message, /token/)
    }
  })

  await check('execute：HTTP 500 → 可读错误', async () => {
    bridge.state.executeStatus = 500
    bridge.state.execute = () => ({ ok: false, error: 'boom' })
    try {
      await ping(voice, { text: 'x' }, { agent: { id: 'sess-1' } })
      assert.fail('应该抛错')
    } catch (error) {
      assert.match(error.message, /HTTP 500/)
      assert.match(error.message, /feiyu-voice/)
    }
  })

  await check('execute：超时 → 可读错误（上限可收紧）', async () => {
    bridge.state.executeStatus = 200
    bridge.state.execute = () => ({ ok: true, content: [{ type: 'text', text: '慢' }] })
    bridge.state.executeDelayMs = 1500
    // 超时口径（2026-10-26 改）：工具的 timeoutMs 优先（语音合成 120s 不再被 8s 切死），
    // 只有清单没写时才用 httpTools.timeoutMs；测试这里用注入的覆盖值来收紧上限。
    mod.setHttpToolsTimeoutsForTests({ executeTimeoutMs: 500 })
    const { ctx: slowCtx, calls: slowCalls } = makeGuardCtx()
    const slowResult = await mod.applyHttpTools(slowCtx, httpConfig({
      enabled: true,
      baseUrl: bridge.baseUrl,
    }))
    assert.equal(slowResult.registered.length, 2, '工具要先注册出来')
    const slowVoice = slowCalls.registeredTools.find((tool) => tool.name === 'qq_ext_send_custom_voice')
    try {
      await ping(slowVoice, { text: 'x' }, { agent: { id: 'sess-1' } })
      assert.fail('应该抛错')
    } catch (error) {
      assert.match(error.message, /执行超时/)
      assert.match(error.message, /500ms/)
    } finally {
      bridge.state.executeDelayMs = 0
      mod.setHttpToolsTimeoutsForTests({})
    }
  })

  await check('execute：连不上（端口没人监听）→ 清单拉不到，apply 不抛', async () => {
    const deadBase = await unusedBaseUrl()
    const { ctx: deadCtx } = makeGuardCtx()
    const result = await mod.applyHttpTools(deadCtx, httpConfig({ enabled: true, baseUrl: deadBase }))
    assert.deepEqual(result.registered, [], '连不上时拉不到清单，自然没有工具')
    // 执行期「注册时桥接在、执行时桥接挂了」的现场由下面「桥接关掉后」的用例覆盖。
  })
}

/* ── 3. 图片块 → 附件引用 / 降级文字 ────────────────────────────── */

const imageBridge = await startFakeBridge()
{
  const jpegBase64 = Buffer.from('fake-jpeg-bytes').toString('base64')
  const savedInputs = []
  const attachments = {
    async saveImage(input) {
      savedInputs.push(input)
      return { attachmentId: 'sha256:abc123', mediaType: input.mediaType, bytes: input.data.byteLength, width: 2, height: 2 }
    },
  }
  const { ctx, calls } = makeGuardCtx({ attachments })
  await mod.applyHttpTools(ctx, httpConfig({ enabled: true, baseUrl: imageBridge.baseUrl }))
  const video = calls.registeredTools.find((tool) => tool.name === 'qq_ext_read_video')

  await check('图片块：落附件存储，返回 DSH 的 {type:"image",attachment} 块', async () => {
    imageBridge.state.execute = () => ({
      ok: true,
      content: [
        { type: 'text', text: '抽了 1 帧：' },
        { type: 'image', data: jpegBase64, mimeType: 'image/jpeg' },
      ],
    })
    const value = await ping(video, { filePath: 'D:/x.mp4', count: 1 }, { agent: { id: 'sess-1' } })
    assert.deepEqual(value.blocks[0], { type: 'text', text: '抽了 1 帧：' })
    assert.deepEqual(value.blocks[1], {
      type: 'image',
      attachment: { attachmentId: 'sha256:abc123', mediaType: 'image/jpeg', bytes: 15, width: 2, height: 2 },
    })
    assert.equal(savedInputs.length, 1)
    assert.equal(savedInputs[0].mediaType, 'image/jpeg')
    assert.ok(savedInputs[0].data instanceof Uint8Array)
    assert.equal(Buffer.from(savedInputs[0].data).toString(), 'fake-jpeg-bytes')
    // 真的过了 DSH 的 render 通道也不会丢块
    assert.deepEqual(video.output.render({}, value), value.blocks)
  })

  await check('图片块：附件服务不可用 → 降级成一行文字（不抛错）', async () => {
    const { ctx: plainCtx, calls: plainCalls } = makeGuardCtx()
    await mod.applyHttpTools(plainCtx, httpConfig({ enabled: true, baseUrl: imageBridge.baseUrl }))
    const plainVideo = plainCalls.registeredTools.find((tool) => tool.name === 'qq_ext_read_video')
    imageBridge.state.execute = () => ({
      ok: true,
      content: [{ type: 'image', data: jpegBase64, mimeType: 'image/jpeg' }],
    })
    const value = await ping(plainVideo, { filePath: 'D:/x.mp4' }, { agent: { id: 'sess-1' } })
    assert.equal(value.blocks.length, 1)
    assert.equal(value.blocks[0].type, 'text')
    assert.match(value.blocks[0].text, /收到一张图片/)
    assert.match(value.blocks[0].text, /image\/jpeg/)
  })

  await check('未知内容块 → 忽略并注明；空 content → 兜底文案', async () => {
    imageBridge.state.execute = () => ({ ok: true, content: [{ type: 'video', data: 'x' }] })
    const value = await ping(video, { filePath: 'D:/x.mp4' }, { agent: { id: 'sess-1' } })
    assert.match(value.blocks[0].text, /未知内容块/)

    imageBridge.state.execute = () => ({ ok: true, content: [] })
    const empty = await ping(video, { filePath: 'D:/x.mp4' }, { agent: { id: 'sess-1' } })
    assert.deepEqual(empty.blocks, [{ type: 'text', text: '（QQ 插件没有返回内容）' }])
  })
}

/* ── 4. 清单失败：只 warn、限流一次、不影响 apply ───────────────── */

const badBridge = await startFakeBridge()
{
  await check('清单 401：不注册、不抛错、只 warn 一次（同因去重）', async () => {
    badBridge.state.manifestStatus = 401
    badBridge.state.manifest = { ok: false, error: 'unauthorized' }
    const warns = await captureWarns(async () => {
      for (let i = 0; i < 2; i++) {
        const { ctx, calls } = makeGuardCtx()
        const result = await mod.applyHttpTools(ctx, httpConfig({ enabled: true, baseUrl: badBridge.baseUrl }))
        assert.deepEqual(result.registered, [])
        assert.deepEqual(calls.registeredTools, [])
      }
    })
    const hits = warns.filter((line) => line.includes('拉取 QQ 插件工具清单被拒'))
    assert.equal(hits.length, 1, `401 只该 warn 一次，实际 ${hits.length}：${JSON.stringify(warns)}`)
  })

  await check('清单 ok:false / 无 tools 数组：warn 但不抛', async () => {
    badBridge.state.manifestStatus = 200
    badBridge.state.manifest = { ok: false, error: '插件全挂' }
    const warns = await captureWarns(async () => {
      const { ctx, calls } = makeGuardCtx()
      const result = await mod.applyHttpTools(ctx, httpConfig({ enabled: true, baseUrl: badBridge.baseUrl }))
      assert.deepEqual(result.registered, [])
      assert.deepEqual(calls.registeredTools, [])
    })
    assert.ok(warns.some((line) => line.includes('插件全挂')), JSON.stringify(warns))

    badBridge.state.manifest = { ok: true, tools: 'nope' }
    const warns2 = await captureWarns(async () => {
      const { ctx } = makeGuardCtx()
      const result = await mod.applyHttpTools(ctx, httpConfig({ enabled: true, baseUrl: badBridge.baseUrl }))
      assert.deepEqual(result.registered, [])
    })
    assert.ok(warns2.some((line) => line.includes('tools 数组')), JSON.stringify(warns2))
  })

  await check('清单超时（5s 硬上限可被测试调小）：warn 不抛', async () => {
    badBridge.state.manifest = { ok: true, tools: [TOOL_VOICE] }
    badBridge.state.manifestDelayMs = 300
    mod.setHttpToolsTimeoutsForTests({ manifestTimeoutMs: 100 })
    try {
      const warns = await captureWarns(async () => {
        const { ctx } = makeGuardCtx()
        const result = await mod.applyHttpTools(ctx, httpConfig({ enabled: true, baseUrl: badBridge.baseUrl }))
        assert.deepEqual(result.registered, [])
      })
      assert.ok(warns.some((line) => line.includes('拉取 QQ 插件工具清单失败')), JSON.stringify(warns))
    } finally {
      mod.setHttpToolsTimeoutsForTests({})
      badBridge.state.manifestDelayMs = 0
    }
  })

  await check('清单里坏名字 / 重名：跳过并容错，能用的照注册', async () => {
    badBridge.state.manifest = {
      ok: true,
      tools: [
        { ...TOOL_VOICE, plugin: 'feiyu-voice' },
        { ...TOOL_VOICE },
        { ...TOOL_VOICE, name: 'qq ext 带空格', title: '坏名字' },
        { ...TOOL_VIDEO },
      ],
    }
    const warns = await captureWarns(async () => {
      const { ctx, calls } = makeGuardCtx()
      const result = await mod.applyHttpTools(ctx, httpConfig({ enabled: true, baseUrl: badBridge.baseUrl }))
      assert.deepEqual(result.registered, ['qq_ext_send_custom_voice', 'qq_ext_read_video'])
      assert.equal(calls.registeredTools.length, 2)
    })
    assert.ok(warns.some((line) => line.includes('重复工具名')), JSON.stringify(warns))
    assert.ok(warns.some((line) => line.includes('非法工具名')), JSON.stringify(warns))
  })

  await check('桥接整个没起（端口关闭）：apply 不抛、warn 一次', async () => {
    const deadBase = await unusedBaseUrl()
    const warns = await captureWarns(async () => {
      const { ctx } = makeGuardCtx()
      const result = await mod.applyHttpTools(ctx, httpConfig({ enabled: true, baseUrl: deadBase }))
      assert.deepEqual(result.registered, [])
    })
    assert.ok(warns.some((line) => line.includes('拉取 QQ 插件工具清单失败')), JSON.stringify(warns))
  })

  await check('注册时桥接在、执行时桥接挂了 → execute 抛「连不上桥接插件通道」', async () => {
    const doomed = await startFakeBridge()
    const { ctx, calls } = makeGuardCtx()
    await mod.applyHttpTools(ctx, httpConfig({ enabled: true, baseUrl: doomed.baseUrl }))
    const doomedVoice = calls.registeredTools.find((tool) => tool.name === 'qq_ext_send_custom_voice')
    assert.ok(doomedVoice, '工具没注册出来')
    await doomed.close()
    try {
      await ping(doomedVoice, { text: 'x' }, { agent: { id: 'sess-1' } })
      assert.fail('应该抛错')
    } catch (error) {
      assert.match(error.message, /连不上桥接插件通道/)
      assert.match(error.message, /feiyu-voice/)
    }
  })
}

/* ── 5. 开关 / 回环限制 ─────────────────────────────────────────── */

const gateBridge = await startFakeBridge()
{
  await check('enabled=false（默认）：一个请求都不打', async () => {
    const before = gateBridge.state.requests.length
    const { ctx, calls } = makeGuardCtx()
    const result = await mod.applyHttpTools(ctx, httpConfig({ enabled: false, baseUrl: gateBridge.baseUrl }))
    assert.deepEqual(result.registered, [])
    assert.deepEqual(calls.registeredTools, [])
    assert.equal(gateBridge.state.requests.length, before)
  })

  await check('baseUrl 非回环：warn 并跳过（绝不请求外部主机）', async () => {
    const before = gateBridge.state.requests.length
    const warns = await captureWarns(async () => {
      const { ctx, calls } = makeGuardCtx()
      const result = await mod.applyHttpTools(ctx, httpConfig({ enabled: true, baseUrl: 'http://192.168.1.5:39410' }))
      assert.deepEqual(result.registered, [])
      assert.deepEqual(calls.registeredTools, [])
    })
    assert.equal(gateBridge.state.requests.length, before, '非回环地址一个请求都不许打')
    assert.ok(warns.some((line) => line.includes('不是回环地址')), JSON.stringify(warns))
  })

  await check('isLoopbackHttpUrl：只认 127.0.0.1 / localhost 的 http(s)', () => {
    assert.equal(mod.isLoopbackHttpUrl('http://127.0.0.1:39410'), true)
    assert.equal(mod.isLoopbackHttpUrl('http://localhost:39410'), true)
    assert.equal(mod.isLoopbackHttpUrl('http://LocalHost:39410/x'), true)
    assert.equal(mod.isLoopbackHttpUrl('http://192.168.1.5:39410'), false)
    assert.equal(mod.isLoopbackHttpUrl('http://127.0.0.1.evil.com:39410'), false)
    assert.equal(mod.isLoopbackHttpUrl('https://example.com'), false)
    assert.equal(mod.isLoopbackHttpUrl('ftp://127.0.0.1'), false)
    assert.equal(mod.isLoopbackHttpUrl('not a url'), false)
    assert.equal(mod.isLoopbackHttpUrl(''), false)
  })

  await check('resolveHttpToolsConfig：默认关闭 + 设置页那份可兜底启用', () => {
    const dflt = mod.Config({ role: 'guard' })
    const resolved = mod.resolveHttpToolsConfig(dflt)
    assert.equal(resolved.enabled, false)
    assert.equal(resolved.baseUrl, 'http://127.0.0.1:39410')
    assert.equal(resolved.timeoutMs, 10000)

    const fromSettings = mod.resolveHttpToolsConfig(dflt, mod.Config({
      role: 'settings',
      httpTools: { enabled: true, baseUrl: 'http://127.0.0.1:39999', token: 'abc' },
    }))
    assert.equal(fromSettings.enabled, true)
    assert.equal(fromSettings.baseUrl, 'http://127.0.0.1:39999')
    assert.equal(fromSettings.token, 'abc')

    const ownWins = mod.resolveHttpToolsConfig(
      mod.Config({ role: 'guard', httpTools: { enabled: true, baseUrl: 'http://127.0.0.1:39410' } }),
      mod.Config({ role: 'settings', httpTools: { enabled: true, baseUrl: 'http://127.0.0.1:39999' } }),
    )
    assert.equal(ownWins.baseUrl, 'http://127.0.0.1:39410')
  })
}

/* ── 6. 真链路：applyGuard 里会被调用 ──────────────────────────── */

await check('applyGuard 挂上 httpTools：注册出工具，且 qq_ext_ 前缀白名单放行', async () => {
  const before = gateBridge.state.requests.length
  const { ctx, calls } = makeGuardCtx()
  const httpToolNames = () => calls.registeredTools
    .map((tool) => tool.name)
    .filter((name) => name.startsWith('qq_ext_'))
  const warns = await captureWarns(async () => {
    mod.apply(ctx, mod.Config({
      role: 'guard',
      httpTools: { enabled: true, baseUrl: gateBridge.baseUrl, token: 'tk' },
    }))
    await waitFor(() => httpToolNames().length >= 2)
  })
  assert.deepEqual(httpToolNames().sort(), [
    'qq_ext_read_video',
    'qq_ext_send_custom_voice',
  ])
  assert.ok(gateBridge.state.requests.length > before, 'applyGuard 没去拉清单')
  assert.ok(calls.guardFn, 'tools.guard 没注册')
  assert.equal(calls.guardFn({ name: 'qq_ext_send_custom_voice' }), undefined, 'qq_ext_ 应被执行期白名单放行')
  assert.match(String(calls.guardFn({ name: 'ops_bash' })), /白名单/)
  assert.ok(!warns.some((line) => line.includes('拉取 QQ 插件工具清单失败')))
})

console.log('')
console.log(`结果：${pass} 通过 / ${fail} 失败`)

await bridge.close()
await imageBridge.close()
await badBridge.close()
await gateBridge.close()
process.exit(fail === 0 ? 0 : 1)
