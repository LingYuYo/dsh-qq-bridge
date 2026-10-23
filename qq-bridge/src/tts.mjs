/**
 * 语音合成（TTS）——「发语音」技能的真实后端。
 *
 * 零 npm 依赖：Edge TTS 走 Node 22 内置 WebSocket，OpenAI 兼容接口走内置 fetch。
 *
 * 两个 provider：
 *   · edge   —— 微软 Edge「大声朗读」接口，免 Key。用的公共端点，随时可能变；
 *              失败时只报错，不阻塞聊天。中文默认音色 zh-CN-XiaoyiNeural。
 *   · openai —— 任意 OpenAI 兼容 `/v1/audio/speech`，需要 baseUrl + apiKey。
 *
 * 产物统一是 **mp3 字节的 base64**：桥接把它塞进 OneBot 的 record 段
 * （`base64://...`），由 NapCat 转码后发 QQ 语音。这里不落盘，避免清理问题。
 *
 * 已知边界（诚实版）：
 *   · Edge 端点 2025 年后要求 Sec-MS-GEC 签名，这里按公开实现生成；
 *     若微软再改协议，这里会失败并回一条明确的错误日志。
 *   · mp3 → QQ 语音所需格式的转码由 NapCat 负责；如果 NapCat 版本不支持，
 *     发送会返回失败，桥接日志里能看到 retcode。
 */

import { createHash, randomUUID } from 'node:crypto'

const EDGE_TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const EDGE_WSS = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
// Edge 客户端的版本号：参与 Sec-MS-GEC 校验，微软升级后可能需要跟。
const EDGE_SEC_MS_GEC_VERSION = '1-130.0.2849.68'
const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural'
const DEFAULT_TIMEOUT_MS = 20_000
const OPENAI_MODEL = 'tts-1'

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
 * Edge TTS 合成。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.voice]
 * @param {number} [opts.timeoutMs]
 * @param {typeof WebSocket} [opts.WebSocketImpl]
 * @returns {Promise<{base64:string, mediaType:string, bytes:number, provider:'edge'}>}
 */
export async function synthesizeEdge(text, { voice = DEFAULT_VOICE, timeoutMs = DEFAULT_TIMEOUT_MS, WebSocketImpl } = {}) {
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

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`Edge TTS 超时（${timeoutMs}ms）`)), timeoutMs)
    const cleanup = () => { clearTimeout(timer); try { ws.close() } catch { /* ignore */ } }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
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

    ws.addEventListener('error', (event) => fail(new Error(`Edge TTS WebSocket 错误：${event?.message ?? event?.error?.message ?? '未知'}`)))
    ws.addEventListener('close', () => {
      // 有些服务端不发 turn.end 直接关连接：已经收到音频就按成功处理。
      if (chunks.length > 0) done()
      else fail(new Error('Edge TTS 连接提前关闭，没有收到音频'))
    })
  })
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
 * @param {string} text
 * @param {object} [config] 插件 Config 的 voice 段（热配置）
 * @param {object} [deps] 测试注入 { fetchImpl, WebSocketImpl }
 * @returns {Promise<{base64:string, mediaType:string, bytes:number, provider:string}>}
 */
export async function synthesize(text, config = {}, deps = {}) {
  const provider = String(config?.provider ?? 'edge').trim().toLowerCase()
  const voice = String(config?.voice ?? '').trim() || DEFAULT_VOICE
  if (provider === 'openai') {
    return await synthesizeOpenAI(text, {
      baseUrl: config?.baseUrl,
      apiKey: config?.apiKey,
      voice,
      fetchImpl: deps.fetchImpl,
    })
  }
  return await synthesizeEdge(text, { voice, WebSocketImpl: deps.WebSocketImpl })
}

export { DEFAULT_VOICE, DEFAULT_TIMEOUT_MS, sleep }
