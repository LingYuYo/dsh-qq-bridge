/**
 * 语音合成（TTS）——「发语音」技能的真实后端。
 *
 * 零 npm 依赖：百度免 Key 接口 / OpenAI 兼容接口都走 Node 内置 fetch，
 * Edge 走 Node 22 内置 WebSocket。
 *
 * 三个 provider：
 *   · baidu  —— 百度翻译的免 Key 朗读接口，**默认**。GET /gettts 直接回 mp3，中文最省事；
 *               单次上限 {@link BAIDU_MAX_CHARS} 字（超出直接报错，不静默截断）。
 *   · openai —— 任意 OpenAI 兼容 `/v1/audio/speech`，需要 baseUrl + apiKey。
 *   · edge   —— 微软 Edge「大声朗读」接口。**2026-10-24 起不可用**：微软把
 *               Sec-MS-GEC 签名升级成 v2 算法，旧版 `1-130.0.2849.68` 握手一律 403。
 *               保留实现（哪天微软回退还能直接用），但失败必须给出人话原因，
 *               不能出现「Edge TTS WebSocket 错误：」这种空尾巴。
 *
 * 产物统一是 **mp3 字节的 base64**：桥接把它塞进 OneBot 的 record 段
 * （`base64://...`），由 NapCat 转码后发 QQ 语音。这里不落盘，避免清理问题
 * （落盘降级只发生在 NapCat 发送失败时，见 onebot.mjs 的 sendVoice）。
 *
 * 已知边界（诚实版）：
 *   · 百度接口是免费公共端点，随时可能限流/改协议；失败会给 HTTP 状态 + 响应体片段。
 *   · mp3 → QQ 语音所需格式的转码由 NapCat 负责；如果 NapCat 版本不支持，
 *     发送会返回失败，桥接把 retcode 原样报给模型。
 */

import { createHash, randomUUID } from 'node:crypto'

const EDGE_TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const EDGE_WSS = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
// 同一个端点的 https 形态：只用来在失败后探一次状态码（真机 403 的确定证据）。
const EDGE_PROBE_URL = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
// Edge 客户端的版本号：参与 Sec-MS-GEC 校验，微软升级后可能需要跟。
// 2026-10-24 真机：上游已升到 v2 算法 + 143 版本号，这里的 1-130 会被 403 拒绝。
const EDGE_SEC_MS_GEC_VERSION = '1-130.0.2849.68'
const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural'
const DEFAULT_TIMEOUT_MS = 20_000
const OPENAI_MODEL = 'tts-1'

/** 默认 provider：edge 已被微软拒（403），中文场景百度的免 Key 通路实测可用。 */
export const DEFAULT_PROVIDER = 'baidu'

/** 百度免 Key 朗读接口（GET，直接返回 audio/mpeg）。 */
const BAIDU_TTS_URL = 'https://fanyi.baidu.com/gettts'
/** 百度接口的实测建议上限：超过 200 字会截断/失败，这里直接报错让模型精简。 */
export const BAIDU_MAX_CHARS = 200
/** 百度语速（1 慢 ~ 15 快，5 接近正常语速）。 */
const BAIDU_SPEED = 5
/** 百度对裸 Node UA 不友好，带一个普通浏览器 UA + referer 更稳。 */
const BAIDU_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

/** 单次合成的文字上限：240 字大约 60 秒，和 QQ 语音条上限对齐。 */
export const TTS_MAX_CHARS = 240

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** XML 转义（SSML 正文 + 属性都只走这一份）。 */
export function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 拼 SSML。
 * @param {string} text
 * @param {string} [voice]
 * @returns {string}
 */
export function buildSsml(text, voice = DEFAULT_VOICE) {
  const name = String(voice ?? '').trim() || DEFAULT_VOICE
  return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>"
    + `<voice name='${escapeXml(name)}'>`
    + `<prosody rate='+0%' pitch='+0Hz'>${escapeXml(text)}</prosody>`
    + '</voice></speak>'
}

/**
 * 计算 Edge 接口要求的 Sec-MS-GEC 签名。
 *
 * 算法（公开实现一致）：把「Unix 时间 + 11644473600 秒」换算成 Windows FILETIME 的
 * 100ns tick，向下取整到 5 分钟，再拼上 TrustedClientToken 做 SHA-256 大写十六进制。
 *
 * @param {number} [nowMs=Date.now()] 便于测试注入
 * @returns {string}
 */
export function edgeSecMsGec(nowMs = Date.now()) {
  const unixSeconds = Math.floor(nowMs / 1000)
  const rounded = unixSeconds - (unixSeconds % 300)
  const ticks = (BigInt(rounded) + 11644473600n) * 10000000n
  return sha256Upper(`${ticks}${EDGE_TRUSTED_TOKEN}`)
}

/** 纯 JS SHA-256 大写十六进制（只用于几十字节的签名，不引入 crypto 之外的东西）。 */
function sha256Upper(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').toUpperCase()
}

/** 生成 ConnectionId：Edge 要求大写、无连字符。 */
function edgeConnectionId() {
  return randomUUID().replace(/-/g, '').toUpperCase()
}

const EDGE_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const EDGE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * `X-Timestamp` 格式（与 edge-tts 的 date_to_string 一致）：
 * `Thu Oct 23 2025 14:00:00 GMT+0000 (Coordinated Universal Time)`。
 */
function edgeTimestamp(nowMs = Date.now()) {
  const d = new Date(nowMs)
  const pad = (n) => String(n).padStart(2, '0')
  return `${EDGE_WEEKDAYS[d.getUTCDay()]} ${EDGE_MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} `
    + `${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} `
    + 'GMT+0000 (Coordinated Universal Time)'
}

/**
 * 把 WebSocket 的 error 事件翻成可读原因。
 *
 * 真机踩坑（2026-10-24）：微软握手返回 403 时，Node 内置 WebSocket（undici）
 * 的 error 事件 `message` 是**空串**，真实原因藏在 `event.error`（有时还嵌一层
 * `cause`）里；close code 则是 1006。旧实现只读 `event.message`，于是日志变成
 * 「Edge TTS WebSocket 错误：」——用户和模型都看不到任何线索。这里把所有可能
 * 承载原因的位置都读一遍。
 *
 * @param {any} event error 事件对象（浏览器/undici 的 ErrorEvent 或 Error）
 * @returns {string}
 */
export function describeWsError(event) {
  const parts = []
  const push = (value) => {
    const text = String(value ?? '').trim()
    if (text) parts.push(text)
  }
  const err = event?.error
  push(event?.message)
  push(err?.message)
  push(err?.code ? `code=${err.code}` : '')
  const cause = err?.cause
  if (cause) {
    const code = String(cause?.code ?? '').trim()
    const message = String(cause?.message ?? (typeof cause === 'string' ? cause : '')).trim()
    push(`cause=${[code, message].filter(Boolean).join(' ') || '未知'}`)
  }
  return parts.join('；') || '未提供具体原因'
}

/**
 * Edge 合成失败的最终人话。
 *
 * 除了 WS 事件里的原因，再对同一端点做一次 HTTPS 探测拿状态码——
 * 真机上 WS 只给 1006，而裸 HTTPS 握手会稳定回 **403**，这个状态码才是
 * 「微软升级了 Sec-MS-GEC v2 签名」的确定证据（比空白的 1006 有用得多）。
 *
 * @param {string} wsDetail 来自 describeWsError / close 事件的原因片段
 * @param {{fetchImpl?:Function, timeoutMs?:number}} [opts]
 * @returns {Promise<string>}
 */
export async function describeEdgeFailure(wsDetail, { fetchImpl, timeoutMs = 4000 } = {}) {
  const parts = []
  if (wsDetail) parts.push(wsDetail)
  let status = 0
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  if (doFetch) {
    try {
      const res = await doFetch(EDGE_PROBE_URL, {
        method: 'GET',
        headers: { origin: 'https://edge.microsoft.com', 'user-agent': BAIDU_UA },
        signal: AbortSignal.timeout(Math.max(1000, Math.min(timeoutMs, 4000))),
      })
      status = Number(res?.status) || 0
    } catch (error) {
      parts.push(`HTTPS 探测失败：${error?.message ?? error}`)
    }
  }
  if (status === 403) {
    parts.push('微软 edge 朗读接口返回 403（已升级 Sec-MS-GEC v2 签名，旧版 1-130 不再被接受）')
  } else {
    // 探测状态码不一定是 403（同一端点在不同边缘节点上可能回 404），但根因是同一个。
    parts.push('微软 edge 朗读接口当前不可用'
      + `${status ? `（HTTPS 探测 ${status}，握手被拒）` : ''}：`
      + '已知原因＝微软升级了 Sec-MS-GEC v2 签名，旧版 1-130 不再被接受')
  }
  parts.push('请把 TTS 提供方换成 baidu（免 Key，推荐）或 openai')
  return `Edge TTS 失败：${parts.join('；')}`
}

/**
 * Edge TTS 合成。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.voice]
 * @param {number} [opts.timeoutMs]
 * @param {typeof WebSocket} [opts.WebSocketImpl]
 * @param {typeof fetch} [opts.fetchImpl] 失败后 HTTPS 探测用（测试注入）
 * @returns {Promise<{base64:string, mediaType:string, bytes:number, provider:'edge'}>}
 */
export async function synthesizeEdge(text, {
  voice = DEFAULT_VOICE, timeoutMs = DEFAULT_TIMEOUT_MS, WebSocketImpl, fetchImpl,
} = {}) {
  const Ws = WebSocketImpl ?? globalThis.WebSocket
  if (typeof Ws !== 'function') throw new Error('当前 Node 没有内置 WebSocket（需要 Node 22+）')

  const input = String(text ?? '').trim()
  if (!input) throw new Error('TTS 文本为空')
  if ([...input].length > TTS_MAX_CHARS) throw new Error(`TTS 文本过长（>${TTS_MAX_CHARS} 字）`)

  const requestId = randomUUID().replace(/-/g, '')
  const url = `${EDGE_WSS}?TrustedClientToken=${EDGE_TRUSTED_TOKEN}`
    + `&ConnectionId=${edgeConnectionId()}`
    + `&Sec-MS-GEC=${edgeSecMsGec()}`
    + `&Sec-MS-GEC-Version=${encodeURIComponent(EDGE_SEC_MS_GEC_VERSION)}`

  const ws = new Ws(url)
  const chunks = []
  let settled = false
  // 失败原因分两处收集：error 事件（常常是空 message）+ close 事件（带 code/reason）。
  let wsErrorDetail = ''
  let errorFallbackTimer = null

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`Edge TTS 超时（${timeoutMs}ms）`)), timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      if (errorFallbackTimer !== null) clearTimeout(errorFallbackTimer)
      try { ws.close() } catch { /* ignore */ }
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      const detail = String(error?.message ?? error ?? '').trim()
      void describeEdgeFailure(detail, { fetchImpl }).then((message) => reject(new Error(message)))
    }
    const done = () => {
      if (settled) return
      settled = true
      cleanup()
      if (chunks.length === 0) { reject(new Error('Edge TTS 没有返回音频数据')); return }
      const buffer = Buffer.concat(chunks)
      resolve({ base64: buffer.toString('base64'), mediaType: 'audio/mpeg', bytes: buffer.byteLength, provider: 'edge' })
    }

    ws.addEventListener('open', () => {
      const config = 'X-Timestamp:' + edgeTimestamp() + '\r\n'
        + 'Content-Type:application/json; charset=utf-8\r\n'
        + 'Path:speech.config\r\n\r\n'
        + JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        })
      try { ws.send(config) } catch (error) { fail(error) ; return }
      const ssml = 'X-RequestId:' + requestId + '\r\n'
        + 'Content-Type:application/ssml+xml\r\n'
        + 'X-Timestamp:' + edgeTimestamp() + '\r\n'
        + 'Path:ssml\r\n\r\n'
        + buildSsml(input, voice)
      try { ws.send(ssml) } catch (error) { fail(error) }
    })

    ws.addEventListener('message', (event) => {
      const data = event?.data
      if (typeof data === 'string') {
        // 文本帧：turn.end 表示合成结束。
        if (data.includes('Path:turn.end')) done()
        return
      }
      // 二进制帧：前 2 字节 = 头部长度（大端），头部里带 Path:audio。
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (buffer.byteLength < 2) return
      const headerLength = buffer.readUInt16BE(0)
      if (buffer.byteLength < 2 + headerLength) return
      const header = buffer.subarray(2, 2 + headerLength).toString('utf8')
      if (!/Path:\s*audio/i.test(header)) return
      chunks.push(buffer.subarray(2 + headerLength))
    })

    ws.addEventListener('error', (event) => {
      wsErrorDetail = describeWsError(event)
      // 不立刻失败：紧跟着的 close 事件才带真实 close code（403 握手失败 → 1006）。
      // 少数实现只发 error 不发 close，留一个很短的兜底，避免白等到超时。
      errorFallbackTimer = setTimeout(() => fail(new Error(wsErrorDetail)), 50)
    })
    ws.addEventListener('close', (event) => {
      // 有些服务端不发 turn.end 直接关连接：已经收到音频就按成功处理。
      if (chunks.length > 0) { done(); return }
      const code = event?.code === undefined ? '?' : String(event.code)
      const reason = String(event?.reason ?? '').trim()
      const closeDetail = `WebSocket 关闭 code=${code}${reason ? ` reason=${reason}` : ''}`
      fail(new Error([wsErrorDetail, closeDetail].filter(Boolean).join('；')))
    })
  })
}

/**
 * 判断一段字节像不像 MP3。
 *
 * 为什么要校验：百度接口失败时有时 HTTP 200 但正文是 HTML/JSON 错误页；
 * 不校验就会把一堆文本当音频发给 NapCat，报错点跑到更远的地方去。
 * MP3 帧同步字 = 0xFF 后跟 3 个 1 位段（(b1 & 0xE0) === 0xE0），或 ID3 头。
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {boolean}
 */
export function isMp3Buffer(buffer) {
  if (!buffer || buffer.byteLength < 3) return false
  const b0 = buffer[0]
  const b1 = buffer[1]
  if (b0 === 0x49 && b1 === 0x44 && buffer[2] === 0x33) return true // 'ID3'
  return b0 === 0xff && (b1 & 0xe0) === 0xe0
}

/**
 * 把 fetch 抛出来的错误翻成一句能看懂的话。
 *
 * 典型：`TypeError: fetch failed` 本身没有信息量，真正原因在 `error.cause.code`
 * （ECONNRESET / ENOTFOUND / CERT_*…）；超时则是 `TimeoutError`。
 *
 * @param {any} error
 * @param {number} timeoutMs
 * @returns {string}
 */
export function describeFetchError(error, timeoutMs) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return `请求超时（${timeoutMs}ms）`
  const cause = error?.cause
  const causeText = cause
    ? [cause.code, cause.message].filter(Boolean).join(' ')
    : ''
  const head = String(error?.message ?? error ?? '').trim() || '未知错误'
  return causeText ? `${head}（cause=${causeText}）` : head
}

/**
 * 百度免 Key 朗读接口（GET /gettts）。
 *
 * 实测（2026-10-24）：`lan=zh&spd=5&source=web` + 普通浏览器 UA → 200 /
 * `audio/mpeg` / 约 16KB mp3。零 Key、零依赖，中文默认走它。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.spd] 语速 1..15（默认 5）
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{base64:string, mediaType:string, bytes:number, provider:'baidu'}>}
 */
export async function synthesizeBaidu(text, {
  spd = BAIDU_SPEED, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl,
} = {}) {
  const input = String(text ?? '').trim()
  if (!input) throw new Error('TTS 文本为空')
  const chars = [...input].length
  if (chars > BAIDU_MAX_CHARS) {
    throw new Error(`百度 TTS 单次上限 ${BAIDU_MAX_CHARS} 字（当前 ${chars} 字），请精简后再发`)
  }
  const doFetch = fetchImpl ?? fetch
  const judge = Math.min(15, Math.max(1, Math.floor(Number(spd) || BAIDU_SPEED)))
  const url = `${BAIDU_TTS_URL}?lan=zh&spd=${judge}&source=web&text=${encodeURIComponent(input)}`
  let res
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: {
        'user-agent': BAIDU_UA,
        accept: '*/*',
        referer: 'https://fanyi.baidu.com/',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`百度 TTS 请求失败：${describeFetchError(error, timeoutMs)}`)
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    const body = String(raw ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120)
    throw new Error(`百度 TTS HTTP ${res.status}${body ? `：${body}` : '（响应体为空）'}`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.byteLength === 0) throw new Error('百度 TTS 返回空音频（HTTP 200 但 0 字节）')
  if (!isMp3Buffer(buffer)) {
    const body = buffer.toString('utf8').replace(/\s+/gu, ' ').trim().slice(0, 120)
    throw new Error(`百度 TTS 返回的不是 MP3（前 8 字节 ${buffer.subarray(0, 8).toString('hex')}${body ? `，正文开头：${body}` : ''}）`)
  }
  const contentType = String(res.headers?.get?.('content-type') ?? '').toLowerCase()
  const mediaType = contentType.startsWith('audio/') ? contentType.split(';')[0] : 'audio/mpeg'
  return { base64: buffer.toString('base64'), mediaType, bytes: buffer.byteLength, provider: 'baidu' }
}

/**
 * OpenAI 兼容 TTS（POST /audio/speech）。
 *
 * @param {string} text
 * @param {object} opts
 * @param {string} opts.baseUrl 例如 https://api.openai.com/v1
 * @param {string} opts.apiKey
 * @param {string} [opts.voice='alloy']
 * @param {string} [opts.model='tts-1']
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{base64:string, mediaType:string, bytes:number, provider:'openai'}>}
 */
export async function synthesizeOpenAI(text, {
  baseUrl, apiKey, voice = 'alloy', model = OPENAI_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl,
} = {}) {
  const input = String(text ?? '').trim()
  if (!input) throw new Error('TTS 文本为空')
  if ([...input].length > TTS_MAX_CHARS) throw new Error(`TTS 文本过长（>${TTS_MAX_CHARS} 字）`)
  const root = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!root) throw new Error('OpenAI TTS 需要配置 baseUrl')
  if (!apiKey) throw new Error('OpenAI TTS 需要配置 apiKey')
  const doFetch = fetchImpl ?? fetch
  const res = await doFetch(`${root}/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, voice, input, response_format: 'mp3' }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`OpenAI TTS HTTP ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.byteLength === 0) throw new Error('OpenAI TTS 返回空音频')
  const contentType = String(res.headers?.get?.('content-type') ?? '').toLowerCase()
  const mediaType = contentType.startsWith('audio/') ? contentType.split(';')[0] : 'audio/mpeg'
  return { base64: buffer.toString('base64'), mediaType, bytes: buffer.byteLength, provider: 'openai' }
}

/**
 * 按设置页配置选 provider 并合成。
 *
 * provider 缺省 = {@link DEFAULT_PROVIDER}（baidu）：edge 已被微软 403 拒掉，
 * 免 Key 通路里只有百度还能用。显式配置 edge/openai 时尊重用户选择（失败原因可读）。
 *
 * @param {string} text
 * @param {object} [config] 插件 Config 的 voice 段（热配置）
 * @param {object} [deps] 测试注入 { fetchImpl, WebSocketImpl }
 * @returns {Promise<{base64:string, mediaType:string, bytes:number, provider:string}>}
 */
export async function synthesize(text, config = {}, deps = {}) {
  const rawProvider = String(config?.provider ?? '').trim().toLowerCase()
  const provider = rawProvider || DEFAULT_PROVIDER
  const voice = String(config?.voice ?? '').trim() || DEFAULT_VOICE
  if (provider === 'baidu') {
    return await synthesizeBaidu(text, { fetchImpl: deps.fetchImpl, spd: config?.spd })
  }
  if (provider === 'openai') {
    return await synthesizeOpenAI(text, {
      baseUrl: config?.baseUrl,
      apiKey: config?.apiKey,
      voice,
      fetchImpl: deps.fetchImpl,
    })
  }
  if (provider === 'edge') {
    return await synthesizeEdge(text, {
      voice,
      WebSocketImpl: deps.WebSocketImpl,
      fetchImpl: deps.fetchImpl,
    })
  }
  throw new Error(`未知的 TTS provider：${provider}（可选 baidu / openai / edge）`)
}

export { DEFAULT_VOICE, DEFAULT_TIMEOUT_MS, sleep }
