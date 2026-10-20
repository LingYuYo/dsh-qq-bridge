/**
 * OneBot v11 正向 WebSocket 客户端（NapCat）。
 *
 * 只依赖 Node 内置 WebSocket（Node 22+ 全局可用），不引入任何 npm 依赖。
 * 职责边界：连 NapCat、收发协议包、解析事件、分片发送。
 * 不做白名单 / 会话映射 / 安全拦截 —— 那些在 bridge.mjs 里。
 *
 * 协议要点：
 *   · 调用：{action, params, echo} → {status:'ok'|'failed', retcode, data, echo}
 *   · 事件：{post_type:'message'|'meta_event'|..., ...}，无 echo
 *   · 鉴权：查询串 ?access_token=xxx（每次重连都重建 URL，重新带上）
 */

const DEFAULT_WS_URL = 'ws://127.0.0.1:3001'
const DEFAULT_CALL_TIMEOUT_MS = 10_000
const DEFAULT_RECONNECT_MS = 3_000
const MAX_RECONNECT_MS = 30_000
// QQ 单条消息的**硬上限**（字节层面的安全余量）：只用来防「一条太长发不出去」。
const DEFAULT_CHUNK_SIZE = 1000
// 单行的**语义切分阈值**：换行是气泡边界，但单行超过它就要找语义切点切开。
const DEFAULT_BUBBLE_MAX_CHARS = 30
// 连续短行合并上限：只有 ≤ 这个字数的相邻行才参与合并。
const DEFAULT_MERGE_MAX_CHARS = 15
// 语义切分时，前片至少保留这么多字，避免切出「我」「就」这种碎渣。
const MIN_FIRST_PIECE_CHARS = 6
const DEFAULT_SEND_INTERVAL_MS = 500
const DEFAULT_DEDUP_CAPACITY = 500
// 打字延时分级：<10 → 200ms；10~14 → 450ms；15~30（含更长的原子块）→ 800ms。
const TYPING_DELAY_TIERS = [[10, 200], [15, 450], [Infinity, 800]]
const TYPING_DELAY_JITTER = 0.15
const TYPING_DELAY_MIN_MS = 150
// 片尾标点默认保留「？！」（问号感叹号承载语气，不能裁）。
const DEFAULT_KEEP_END_PUNCT = ['？', '！']
// 单个分片最多发送几次：首次 + 重试 1 次。只对「服务端明确拒绝」
// （有响应且 retcode≠0）重试；传输层异常（连接断开 / 超时）交付结果未知，
// 重试可能把同一条发两遍，所以不重试。
const SEND_ATTEMPTS = 2
// 连接活过这么久才认为「稳定」，断开后把退避重置回 3 秒；
// 否则保持递增，避免「连上就掉」时每 3 秒刷屏重连。
const STABLE_CONNECTION_MS = 5_000

const WS_OPEN = 1

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** logger 可能为 undefined，字段也可能缺失；一律容错成空操作。 */
function makeLogger(logger) {
  const bind = (name) => (logger && typeof logger[name] === 'function'
    ? (msg) => { try { logger[name](msg) } catch { /* 日志自身出错不影响主链路 */ } }
    : () => {})
  return { info: bind('info'), warn: bind('warn'), error: bind('error') }
}

/** 日志里不能出现 access_token。 */
function redactUrl(url) {
  return String(url ?? '').replace(/([?&]access_token=)[^&]*/i, '$1***')
}

/** 防止 NapCat 把文本里的 [CQ: 当 CQ 码解析：冒号换成全角。 */
export function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：')
}

/** 字符串格式消息里的 CQ 码转纯文本（array 格式不走这里）。 */
export function cqToText(text) {
  return String(text ?? '')
    .replace(/\[CQ:at,[^\]]*qq=([^,\]]+)[^\]]*\]/gi, (_, qq) => (String(qq) === 'all' ? '@全体成员' : `@${qq}`))
    .replace(/\[CQ:image[^\]]*\]/gi, '[图片]')
    .replace(/\[CQ:(?:m?face|sface)[^\]]*\]/gi, '[表情]')
    .replace(/\[CQ:record[^\]]*\]/gi, '[语音]')
    .replace(/\[CQ:video[^\]]*\]/gi, '[视频]')
    .replace(/\[CQ:file[^\]]*\]/gi, '[文件]')
    .replace(/\[CQ:forward[^\]]*\]/gi, '[合并转发]')
    .replace(/\[CQ:(?:json|xml)[^\]]*\]/gi, '[卡片]')
    .replace(/\[CQ:(?:reply|poke|shake|anonymous|rps|dice)[^\]]*\]/gi, '')
    .replace(/\[CQ:([a-z]+)[^\]]*\]/gi, (_, type) => `[${type}]`)
    .replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',')
}

/**
 * 消息段转纯文本。
 * text → 原文；image → [图片]；at → @QQ号；其余常见类型给占位符。
 * @param {Array|string} message array 格式消息段，或 CQ 字符串
 * @param {string} [rawMessage] message 为空时兜底
 */
export function parseMessage(message, rawMessage = '') {
  if (Array.isArray(message)) {
    const parts = []
    for (const seg of message) {
      if (!seg || typeof seg !== 'object') continue
      const type = String(seg.type ?? '')
      const data = seg.data && typeof seg.data === 'object' ? seg.data : {}
      switch (type) {
        case 'text': parts.push(String(data.text ?? '')); break
        case 'image': parts.push('[图片]'); break
        case 'at': {
          const qq = String(data.qq ?? '')
          parts.push(qq === 'all' ? '@全体成员' : `@${qq}`)
          break
        }
        case 'face': case 'mface': case 'sface': parts.push('[表情]'); break
        case 'record': parts.push('[语音]'); break
        case 'video': parts.push('[视频]'); break
        case 'file': parts.push('[文件]'); break
        case 'forward': parts.push('[合并转发]'); break
        case 'json': case 'xml': parts.push('[卡片]'); break
        // 这些段没有文本价值，直接丢掉（reply 尤其不该把被引用内容重复一遍）
        case 'reply': case 'poke': case 'shake': case 'anonymous': case 'rps': case 'dice': break
        default: parts.push(`[${type}]`)
      }
    }
    return parts.join('').trim() || cqToText(rawMessage).trim()
  }
  if (typeof message === 'string' && message) return cqToText(message).trim()
  if (typeof rawMessage === 'string') return rawMessage.trim()
  return ''
}

/**
 * 长文本分片：优先在换行 / 句末标点处切，切不动就硬切，但绝不在代理对中间下刀
 * （否则 emoji 会被劈成两个孤立代理，两条消息都变乱码方块）。
 * @param {string} text
 * @param {number} [maxChars=1000]
 * @returns {string[]}
 */
export function splitText(text, maxChars = DEFAULT_CHUNK_SIZE) {
  const max = Number.isFinite(maxChars) && maxChars >= 1 ? Math.floor(maxChars) : DEFAULT_CHUNK_SIZE
  const s = String(text ?? '')
  if (!s) return []
  if (s.length <= max) return [s]

  const BOUNDARIES = ['\n', '。', '！', '？', '!', '?', '；', ';', '…']
  const out = []
  let i = 0
  while (i < s.length) {
    let end = Math.min(i + max, s.length)
    if (end < s.length) {
      // 至少用到半片才允许切，避免产生一堆碎消息
      const minPos = Math.floor(max * 0.5)
      const window = s.slice(i, end)
      let cut = -1
      for (const ch of BOUNDARIES) {
        const p = window.lastIndexOf(ch)
        if (p >= minPos && p > cut) cut = p
      }
      if (cut >= 0) {
        end = i + cut + 1 // 含标点本身
      } else if (end - i > 1 && isHighSurrogate(s.charCodeAt(end - 1))) {
        end -= 1
      }
    }
    out.push(s.slice(i, end))
    i = end
  }
  return out.filter((chunk) => chunk.length > 0)
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * 按 Unicode **码点**计长度（emoji 代理对算 1 个字符，不劈代理对）。
 * @param {string} s
 * @returns {number}
 */
export function charCount(s) {
  let n = 0
  const str = String(s ?? '')
  for (let i = 0; i < str.length; i++) {
    if (isHighSurrogate(str.charCodeAt(i)) && i + 1 < str.length && isLowSurrogate(str.charCodeAt(i + 1))) i++
    n++
  }
  return n
}

/** 把字符串按码点切成数组（每个元素是完整的一个码点，代理对不拆）。 */
function toCodePoints(s) {
  const out = []
  const str = String(s ?? '')
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (isHighSurrogate(c) && i + 1 < str.length && isLowSurrogate(str.charCodeAt(i + 1))) {
      out.push(str.slice(i, i + 2)); i++
    } else out.push(str[i])
  }
  return out
}

/** 语气词：只有后面紧跟标点或空白时才允许当切点。 */
const TONE_WORDS = ['吧', '呢', '啊', '呀', '哦', '噢', '嘛', '哈', '呗', '咯', '啦', '欸', '诶', '嘿', '哼']
/** 连接词：在**词前**切，让下一片从连接词开头。 */
const CONNECTIVE_WORDS = ['但是', '不过', '所以', '然后', '而且', '另外', '可是', '因为', '如果', '虽然', '其实', '反正', '要不', '还有', '至于', '再说']
/** 句末标点（语义切点）。 */
const SENTENCE_PUNCT = ['。', '！', '？', '!', '?', '；', ';', '…']
/** 片尾标点（默认裁掉；keep 里的保留）。 */
const TRAILING_PUNCT = /[。，、；：,;:.!?！？…—\-~～"'“”'‘’()（）\[\]【】]+$/u

/**
 * 裁掉一片末尾的空白与标点。
 * @param {string} piece
 * @param {string[]} keep 要保留的结尾标点（如 ['？','！']）
 * @param {boolean} [protect=false] 原子块（代码块/URL）例外，不裁
 */
export function trimEndPunctuation(piece, keep = DEFAULT_KEEP_END_PUNCT, protect = false) {
  const s = String(piece ?? '').replace(/\s+$/u, '')
  if (protect) return s
  const keepSet = new Set(keep ?? [])
  let out = s
  for (;;) {
    const m = TRAILING_PUNCT.exec(out)
    if (!m) break
    const last = m[0].slice(-1)
    if (keepSet.has(last)) break
    out = out.slice(0, m.index).replace(/\s+$/u, '')
    if (!out) break
  }
  return out
}

/**
 * 在窗口里找**语义切点**，返回前片结束位置（切点后一位）。
 * 优先级：句末标点 > 语气词+标点/空白 > 连接词前。
 * 切点必须 ≤ max（「从第 max 字向前找」），前片 ≥ minFirst。
 * @param {string[]} cps 码点数组（已按 max 截断）
 * @param {number} max 切点上限
 * @param {number} minFirst 前片最少码点数
 * @returns {number} -1 表示没找到
 */
function findSemanticCut(cps, max, minFirst) {
  const win = cps.slice(0, max)   // 位置 0..max-1，切点结果必然 ≤ max
  const text = win.join('')
  // 1) 句末标点：取窗口内最靠后的一个（cut = p+1 ≤ max）
  let cut = -1
  for (const ch of SENTENCE_PUNCT) {
    const p = text.lastIndexOf(ch)
    if (p > cut) cut = p
  }
  if (cut + 1 >= minFirst) return cut + 1
  // 2) 语气词后接标点/空白：需要看到词后那一位，故 i+1 ≤ max-1
  for (let i = win.length - 2; i >= minFirst - 1; i--) {
    if (!TONE_WORDS.includes(win[i])) continue
    const next = win[i + 1]
    if (SENTENCE_PUNCT.includes(next) || /\s/u.test(next)) return i + 2
  }
  // 3) 连接词在词前切，且词要完整落在前片内
  for (let i = win.length - 1; i >= minFirst; i--) {
    for (const w of CONNECTIVE_WORDS) {
      if (i + w.length <= win.length && win.slice(i, i + w.length).join('') === w) return i
    }
  }
  // 4) 放宽：句末标点即使早于 minFirst 也认
  if (cut >= 0) return cut + 1
  return -1
}

/**
 * 把一条**单行**按语义切成多片：每片尽量 ≤max，前片 ≥minFirst。
 * @param {string} line
 * @param {number} [max=30]
 * @param {number} [minFirst=6]
 * @returns {string[]}
 */
export function splitLineSemantic(line, max = DEFAULT_BUBBLE_MAX_CHARS, minFirst = MIN_FIRST_PIECE_CHARS) {
  const s = String(line ?? '')
  if (!s) return []
  if (charCount(s) <= max) return [s]

  const cps = toCodePoints(s)
  const out = []
  let i = 0
  while (i < cps.length) {
    const remaining = cps.length - i
    if (remaining <= max) { out.push(cps.slice(i).join('')); break }
    const rel = findSemanticCut(cps.slice(i, i + max), max, minFirst)
    let take = rel >= minFirst && rel <= max ? rel : Math.min(max, remaining)
    if (take < 1) take = 1
    out.push(cps.slice(i, i + take).join(''))
    i += take
  }
  return out.filter((x) => x.length > 0)
}

/** 一行是否像日志：以时间戳或日志级别开头。 */
function isLogLine(line) {
  return /^(\[\d{2}:\d{2}(:\d{2})?\]|\d{2}:\d{2}:\d{2}|\[?(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|TRACE|NOTICE)\]?\b)/iu.test(String(line).trim())
}

/**
 * 识别原子块：围栏代码块 / 行内代码 / URL / 日志块。
 * **在 splitBubbles 入口做**，原子块不进入语义切。
 * @returns {Array<{type:'atomic',kind:string,text:string}|{type:'text',lines:string[]}>}
 */
export function segmentAtoms(lines) {
  const pre = []
  let run = []
  const flushRun = () => { if (run.length) { pre.push({ type: 'text', lines: run }); run = [] } }

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]
    // 围栏代码块
    const fence = /^(```+|~~~+)/.exec(t)
    if (fence) {
      const marker = fence[1][0]
      const block = [t]
      let j = i + 1
      let closed = false
      for (; j < lines.length; j++) {
        block.push(lines[j])
        if (new RegExp(`^${marker === '`' ? '`' : '~'}{3,}`).test(lines[j])) { closed = true; j++; break }
      }
      flushRun()
      pre.push({ type: 'atomic', kind: 'code', text: block.join('\n') })
      i = closed ? j - 1 : lines.length
      continue
    }
    // 行内代码独占整行
    if (/^`[^`]+`$/u.test(t)) { flushRun(); pre.push({ type: 'atomic', kind: 'inline-code', text: t }); continue }
    // URL 独占整行
    if (/^https?:\/\/\S+$/iu.test(t)) { flushRun(); pre.push({ type: 'atomic', kind: 'url', text: t }); continue }
    run.push(t)
  }
  flushRun()

  // 日志块：连续 ≥2 行像日志的一段合成原子块
  const final = []
  for (const seg of pre) {
    if (seg.type !== 'text') { final.push(seg); continue }
    let cur = [], curIsLog = null
    const push = () => {
      if (!cur.length) return
      if (curIsLog && cur.length >= 2) final.push({ type: 'atomic', kind: 'log', text: cur.join('\n') })
      else final.push({ type: 'text', lines: cur })
      cur = []
    }
    for (const line of seg.lines) {
      const isLog = isLogLine(line)
      if (curIsLog === null || isLog === curIsLog) { cur.push(line); curIsLog = isLog }
      else { push(); cur = [line]; curIsLog = isLog }
    }
    push()
  }
  return final
}

/** 把**同一条原生行**被桥接硬切出来的相邻碎片合并，防止刷屏。
 *  注意：只能作用在「桥接自己切出来的碎片」上，绝不能跨模型原生换行合并——
 *  模型输出 `收到\n马上来` 是它主观想发两条，必须尊重（强边界）。 */
function mergeFragments(frags, bubbleMax, mergeMax) {
  const out = []
  for (const f of frags) {
    const prev = out.length ? out[out.length - 1] : null
    // 只有存在「很短的碎片」时才考虑合并，且合并后不得超 bubbleMax
    if (prev !== null
      && (charCount(prev) < mergeMax || charCount(f) < mergeMax)
      && charCount(prev) + charCount(f) <= bubbleMax) {
      out[out.length - 1] = prev + f
    } else out.push(f)
  }
  return out
}

/** 超硬上限的代码块/日志块：按换行切。 */
function splitByLines(text, hard) {
  const out = []
  let buf = ''
  for (const line of String(text).split('\n')) {
    if (!buf) { buf = line; continue }
    if (charCount(buf) + 1 + charCount(line) <= hard) buf += '\n' + line
    else { out.push(buf); buf = line }
  }
  if (buf) out.push(buf)
  return out
}

/**
 * 分级打字延时：按分片**码点**数选基准，±15% 抖动，下限 150ms。
 * <10 → 200ms；10~14 → 450ms；15+ → 800ms。
 * @param {number} chars
 * @param {() => number} [rand=Math.random]
 */
export function typingDelayFor(chars, rand = Math.random) {
  const n = Number.isFinite(chars) ? chars : 0
  let base = TYPING_DELAY_TIERS[TYPING_DELAY_TIERS.length - 1][1]
  for (const [limit, ms] of TYPING_DELAY_TIERS) {
    if (n < limit) { base = ms; break }
  }
  const jitter = 1 + (rand() * 2 - 1) * TYPING_DELAY_JITTER
  return Math.max(TYPING_DELAY_MIN_MS, Math.round(base * jitter))
}

/**
 * 按**换行**把一条回复拆成多条 QQ 消息（"气泡"）。批次 2 规则：
 *
 *   1. 模型换行 = 气泡边界；桥接不二次切（只对超长单行做语义切）
 *   2. 连续 ≤15 字短行合并到 ≤30 再发
 *   3. 原子块（代码块/行内代码/URL/日志块）原样一次发，不参与语义切
 *   4. 片尾裁掉空白与标点，keep 里的保留（代码块/链接例外）
 *   5. 超硬上限时代码块按换行切、URL 原样（不做短链）
 *
 * 向后兼容：`splitBubbles(text, 1000)` 传数字等价于 `{chunkSize:1000}`。
 *
 * @param {string} text
 * @param {object|number} [opts]
 * @returns {string[]}
 */
export function splitBubbles(text, opts = {}) {
  const o = typeof opts === 'number' ? { chunkSize: opts } : (opts ?? {})
  const hard = Number.isFinite(o.chunkSize) && o.chunkSize >= 1 ? Math.floor(o.chunkSize) : DEFAULT_CHUNK_SIZE
  const bubbleMax = Number.isFinite(o.bubbleMaxChars) && o.bubbleMaxChars >= 1 ? Math.floor(o.bubbleMaxChars) : DEFAULT_BUBBLE_MAX_CHARS
  const mergeMax = Number.isFinite(o.mergeMaxChars) && o.mergeMaxChars >= 1 ? Math.floor(o.mergeMaxChars) : DEFAULT_MERGE_MAX_CHARS
  const keep = Array.isArray(o.keepEndPunct) ? o.keepEndPunct : DEFAULT_KEEP_END_PUNCT
  const doTrim = o.trimEndPunctuation !== false

  const s = String(text ?? '').replace(/\r\n?/g, '\n')
  if (!s.trim()) return []

  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean)
  const out = []

  for (const seg of segmentAtoms(lines)) {
    if (seg.type === 'atomic') {
      const kept = doTrim ? trimEndPunctuation(seg.text, keep, true) : seg.text
      if (charCount(kept) > hard) {
        if (seg.kind === 'url' || seg.kind === 'inline-code') out.push(kept)
        else out.push(...splitByLines(kept, hard))
      } else out.push(kept)
      continue
    }
    // 关键：seg.lines 是**模型原生换行**，每一行都是强边界 → 各自独立成泡。
    // 逐行处理，绝不跨行合并（模型写 `收到\n马上来` 就是想发两条）。
    for (const line of seg.lines) {
      // 桥接硬切出的碎片允许合并，防止「短。短。短。」刷屏
      const pieces = mergeFragments(splitLineSemantic(line, bubbleMax, MIN_FIRST_PIECE_CHARS), bubbleMax, mergeMax)
      for (const piece of pieces) {
        if (doTrim) {
          const t = trimEndPunctuation(piece, keep, false)
          if (t) out.push(t)
        } else if (piece) out.push(piece)
      }
    }
  }
  return out.filter((x) => x.length > 0)
}

export class OneBotClient {
  /**
   * @param {object} opts
   * @param {string} [opts.wsUrl] 正向 WS 地址，默认 ws://127.0.0.1:3001
   * @param {string} [opts.accessToken] 鉴权 token，作为查询串 ?access_token= 附加
   * @param {{info:Function,warn:Function,error:Function}} [opts.logger]
   * @param {number} [opts.callTimeoutMs=10000]
   * @param {number} [opts.reconnectDelayMs=3000] 首次重连延迟
   * @param {number} [opts.maxReconnectDelayMs=30000]
   * @param {number} [opts.chunkSize=1000] QQ 单条硬上限
   * @param {number} [opts.bubbleMaxChars=30] 单行语义切阈值
   * @param {number} [opts.mergeMaxChars=15] 参与合并的短行上限
   * @param {number} [opts.sendIntervalMs=500] 分片间隔**兜底**（打字延时关闭时用）
   * @param {boolean} [opts.typingDelayEnabled=true] 打字延时总开关（关闭 = 不分片、不延时、整条发）
   * @param {string[]} [opts.keepEndPunct] 片尾保留标点，默认 ['？','！']
   * @param {boolean} [opts.trimEndPunctuation=true] 是否裁片尾标点
   * @param {boolean} [opts.groupAtReply=true] 群聊回复时是否 @ 发送者
   * @param {'first'|'last'} [opts.groupAtPosition='last'] @ 挂在哪一片
   * @param {number} [opts.dedupCapacity=500]
   */
  constructor({
    wsUrl,
    accessToken,
    logger,
    callTimeoutMs,
    reconnectDelayMs,
    maxReconnectDelayMs,
    chunkSize,
    bubbleMaxChars,
    mergeMaxChars,
    sendIntervalMs,
    typingDelayEnabled,
    keepEndPunct,
    trimEndPunctuation,
    groupAtReply,
    groupAtPosition,
    dedupCapacity,
  } = {}) {
    this.wsUrl = String(wsUrl || DEFAULT_WS_URL)
    this.accessToken = accessToken ? String(accessToken) : ''
    this.log = makeLogger(logger)
    this.callTimeoutMs = positive(callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS)
    this.reconnectDelayMs = positive(reconnectDelayMs, DEFAULT_RECONNECT_MS)
    this.maxReconnectDelayMs = positive(maxReconnectDelayMs, MAX_RECONNECT_MS)
    this.chunkSize = positive(chunkSize, DEFAULT_CHUNK_SIZE)
    this.bubbleMaxChars = positive(bubbleMaxChars, DEFAULT_BUBBLE_MAX_CHARS)
    this.mergeMaxChars = positive(mergeMaxChars, DEFAULT_MERGE_MAX_CHARS)
    this.sendIntervalMs = Number.isFinite(sendIntervalMs) && sendIntervalMs >= 0 ? Number(sendIntervalMs) : DEFAULT_SEND_INTERVAL_MS
    this.typingDelayEnabled = typingDelayEnabled !== false
    this.keepEndPunct = Array.isArray(keepEndPunct) ? keepEndPunct : DEFAULT_KEEP_END_PUNCT
    this.trimEndPunctuation = trimEndPunctuation !== false
    this.groupAtReply = groupAtReply !== false
    this.groupAtPosition = groupAtPosition === 'first' ? 'first' : 'last'
    this.dedupCapacity = positive(dedupCapacity, DEFAULT_DEDUP_CAPACITY)

    this._ws = null
    this._started = false
    this._stopped = true
    this._reconnectTimer = null
    this._reconnectDelay = this.reconnectDelayMs
    this._openedAt = 0
    this._pending = new Map() // echo -> {resolve, reject, timer, action}
    this._seq = 0
    this._handlers = new Set()
    this._seen = new Set()
    this._seenOrder = []
    this._selfId = null
    this._nickname = null
    this._health = {
      // QQ 账号在线状态（三态）：true=在线 / false=离线 / null=未确认。
      // 来源只有两个，都是协议内数据，**不读 NapCat 的本地配置文件、不配 HTTP API**：
      //   ① WS 连上后主动发 `get_status`（见 _fetchStatus）
      //   ② NapCat 每 30s 的一次心跳里的 status.online（免费续命）
      online: null,
      onlineSource: null,  // 'get_status' | 'heartbeat' —— 便于诊断判断从哪来
      good: null,          // 心跳里的 status.good
      lastHeartbeatAt: 0,
      lastPacketAt: 0,
      lastStatusProbeAt: 0, // 最近一次 get_status 调用（无论成败）
      reconnects: 0,
    }
  }

  /** WS 是否处于 OPEN。 */
  get connected() {
    return this._ws?.readyState === WS_OPEN
  }

  /** 登录的 QQ 号（连接成功后由 get_login_info 填充）。 */
  get selfId() {
    return this._selfId
  }

  get nickname() {
    return this._nickname
  }

  /** 连接健康快照。 */
  get health() {
    return {
      connected: this.connected,
      online: this._health.online,
      onlineSource: this._health.onlineSource,
      good: this._health.good,
      lastHeartbeatAt: this._health.lastHeartbeatAt,
      lastPacketAt: this._health.lastPacketAt,
      lastStatusProbeAt: this._health.lastStatusProbeAt,
      reconnects: this._health.reconnects,
      pendingCalls: this._pending.size,
      selfId: this._selfId,
    }
  }

  get status() {
    return this.health
  }

  /**
   * 注册消息处理器。
   * handler({ kind:'private'|'group', userId, groupId, text, messageId, senderName, raw })
   * @returns {Function} 注销函数
   */
  onMessage(handler) {
    if (typeof handler !== 'function') throw new TypeError('onMessage 需要一个函数')
    this._handlers.add(handler)
    return () => this._handlers.delete(handler)
  }

  /** 建立连接并开始自动重连。返回后不代表已连上。 */
  async start() {
    // _stopped 是「已主动停止」标志，与 _started 分开——stop() 之后可以再 start()。
    if (this._started) return
    if (typeof WebSocket === 'undefined') throw new Error('当前 Node 没有内置 WebSocket（需要 Node 22+）')
    this._started = true
    this._stopped = false
    this._connect()
  }

  /** 主动关闭，之后不再重连。 */
  async stop() {
    const wasStarted = this._started
    this._stopped = true
    this._started = false
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    this._rejectAll('客户端已停止')
    const ws = this._ws
    this._ws = null
    if (ws) {
      const closed = new Promise((resolve) => {
        try { ws.addEventListener('close', () => resolve(), { once: true }) } catch { resolve() }
      })
      try { ws.close(1000, 'client stop') } catch { /* 已断开就忽略 */ }
      await Promise.race([closed, sleep(1000)])
    }
    if (wasStarted) this.log.info('OneBot 客户端已停止')
  }

  /**
   * 通用 OneBot API 调用（echo 关联 + 超时）。
   * 解析为完整响应对象 {status, retcode, data, echo}；status='failed' 也照样 resolve，
   * 由调用方自己看 retcode。只有传输层问题（未连接 / 发送失败 / 超时）才 reject。
   */
  async call(action, params = {}) {
    const name = String(action ?? '')
    if (!name) throw new Error('call: action 不能为空')
    const ws = this._ws
    if (!ws || ws.readyState !== WS_OPEN) throw new Error(`call ${name}: WebSocket 未连接`)

    const echo = `dshqq-${++this._seq}`
    const payload = JSON.stringify({ action: name, params: params ?? {}, echo })
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(echo)
        reject(new Error(`call ${name} 超时（${this.callTimeoutMs}ms）`))
      }, this.callTimeoutMs)
      this._pending.set(echo, { resolve, reject, timer, action: name })
      try {
        ws.send(payload)
      } catch (err) {
        clearTimeout(timer)
        this._pending.delete(echo)
        reject(new Error(`call ${name} 发送失败：${err?.message ?? err}`))
      }
    })
  }

  /** 私聊发送（自动分片，逐条，固定 sendIntervalMs 兜底）。 */
  async sendPrivate(userId, text) {
    return await this._sendText('private', userId, text)
  }

  /**
   * 群发送（自动分片）。群聊可带发送者 @。
   * @param {string} groupId
   * @param {string} text
   * @param {object} [opts]
   * @param {string} [opts.atUserId] 要 @ 的 QQ 号（发送者）；不传则不 @
   * @param {'first'|'last'} [opts.atPosition='last'] 只在哪一片 @（一条回复可能多片，全 @ 会刷屏）
   */
  async sendGroup(groupId, text, opts = {}) {
    // 总开关兜底：即使调用方传了 atUserId，groupAtReply=false 也一律不带 @。
    const at = this.groupAtReply ? opts : { ...opts, atUserId: undefined }
    return await this._sendText('group', groupId, text, at)
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────

  /**
   * 把一片纯文本包装成 OneBot 11 消息段数组。
   *
   * - 私聊：保持纯文本（字符串），不加任何段。
   * - 群聊 + 需要 @：返回 `[{type:'at',data:{qq}},{type:'text',data:{text}}]`；
   *   OneBot/NapCat 接受 `message` 直接传段数组，比拼 CQ 码字符串稳（不受文本里
   *   `[CQ:` 转义问题影响，也不用手工拼 `&#91;` 之类的实体）。
   * @returns {string|Array<object>}
   */
  _buildSegments(kind, text, { atUserId, atPosition } = {}) {
    const needAt = kind === 'group'
      && atUserId !== undefined && atUserId !== null
      && /^\d+$/.test(String(atUserId).trim())
    if (!needAt) return escapeCqText(text)
    // at 放文本**前面**：QQ 客户端里 @ 会高亮成「@昵称」，正文跟在其后读起来自然。
    return [
      { type: 'at', data: { qq: String(atUserId).trim() } },
      { type: 'text', data: { text: escapeCqText(text) } },
    ]
  }

  /** 决定第 index 片是否要挂 @。 */
  _shouldAt(kind, index, total, atUserId, atPosition) {
    if (kind !== 'group') return false
    if (atUserId === undefined || atUserId === null || !/^\d+$/.test(String(atUserId).trim())) return false
    const pos = atPosition === 'first' ? 'first' : 'last'
    return pos === 'first' ? index === 0 : index === total - 1
  }

  async _sendText(kind, targetId, text, { atUserId, atPosition = 'last' } = {}) {
    const id = String(targetId ?? '').trim()
    if (!/^\d+$/.test(id) || id === '0') {
      return { ok: false, messageIds: [], error: `${kind === 'private' ? 'user_id' : 'group_id'} 必须是正整数：${targetId}` }
    }
    const body = String(text ?? '').trim()
    if (!body) return { ok: false, messageIds: [], error: '消息内容为空' }

    // 总开关关闭：不分片、不延时、整条合并发送
    //（审计仍在上游对全文做，顺序不变）。
    const chunks = this.typingDelayEnabled
      ? splitBubbles(body, {
        chunkSize: this.chunkSize,
        bubbleMaxChars: this.bubbleMaxChars,
        mergeMaxChars: this.mergeMaxChars,
        keepEndPunct: this.keepEndPunct,
        trimEndPunctuation: this.trimEndPunctuation,
      })
      : [body]
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg'
    const messageIds = []
    let ok = true
    let error
    let failedIndex

    for (let i = 0; i < chunks.length; i++) {
      // @ 只挂一片（first/last），避免多个气泡全 @ 刷屏。
      const withAt = this._shouldAt(kind, i, chunks.length, atUserId, atPosition)
      const message = this._buildSegments(kind, chunks[i], withAt ? { atUserId, atPosition } : {})
      const params = kind === 'private'
        ? { user_id: Number(id), message }
        : { group_id: Number(id), message }
      let res
      let chunkError

      for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
        try {
          res = await this.call(action, params)
          if (res?.status === 'ok' && Number(res?.retcode) === 0) { chunkError = undefined; break }
          chunkError = `retcode=${res?.retcode} status=${res?.status}`
        } catch (err) {
          // 传输层异常：交付结果未知，不重试（重试可能重复投递）。
          res = undefined
          chunkError = err?.message ?? String(err)
          break
        }
        if (attempt < SEND_ATTEMPTS) {
          this.log.warn(`QQ 发送被拒（${kind}:${id} 第 ${i + 1}/${chunks.length} 片）：${chunkError}，重试一次`)
          await sleep(this._gapBefore(i, chunks))
        }
      }

      if (chunkError !== undefined) {
        ok = false
        error = chunkError
        failedIndex = i + 1
        this.log.warn(`QQ 发送失败（${kind}:${id} 第 ${i + 1}/${chunks.length} 片）：${chunkError}`)
        break // 中途失败就不再发后续分片，否则顺序错乱
      }

      const mid = res?.data?.message_id
      if (mid !== undefined && mid !== null) messageIds.push(String(mid))
      if (i < chunks.length - 1 && this.typingDelayEnabled) await sleep(this._gapBefore(i, chunks))
    }
    return { ok, messageIds, error, failedIndex, total: chunks.length }
  }

  /**
   * 下一片之前的等待：打字延时开启时按**分级延时**（看上一片的码点数），
   * 关闭时用 `sendIntervalMs` 兜底固定间隔。
   */
  _gapBefore(index, chunks) {
    if (!this.typingDelayEnabled) return this.sendIntervalMs
    return typingDelayFor(charCount(chunks[index] ?? ''))
  }

  _buildUrl() {
    let url = this.wsUrl
    if (this.accessToken) {
      const parsed = new URL(url)
      parsed.searchParams.set('access_token', this.accessToken)
      url = parsed.toString()
    }
    return url
  }

  _connect() {
    if (this._stopped || this._ws) return
    let ws
    try {
      const url = this._buildUrl()
      ws = new WebSocket(url)
      this.log.info(`连接 NapCat：${redactUrl(url)}`)
    } catch (err) {
      this.log.error(`建立 WebSocket 失败：${err?.message ?? err}`)
      this._scheduleReconnect()
      return
    }

    this._ws = ws
    ws.addEventListener('open', () => { if (this._ws === ws) this._onOpen() })
    ws.addEventListener('message', (ev) => { if (this._ws === ws) this._onRaw(ev?.data) })
    ws.addEventListener('error', (ev) => {
      // close 会紧跟其后，重连逻辑放在 _onClose，这里只记一笔
      this.log.warn(`WebSocket 错误：${ev?.message ?? ev?.error?.message ?? '未知'}`)
    })
    ws.addEventListener('close', (ev) => { if (this._ws === ws) this._onClose(ev) })
  }

  _onOpen() {
    this._openedAt = Date.now()
    this.log.info('NapCat WebSocket 已连接')
    void this._fetchLoginInfo()
    // 关键：连上 ≠ 账号在线。立刻用同一条 WS 问一次 get_status。
    // 不依赖 NapCat 的 HTTP API（那要改它的 onebot11 配置，本项目红线）。
    void this._fetchStatus()
  }

  /**
   * 纯 WS 探测 QQ 账号在线状态。
   *
   * 为什么必须这样做（2026-10-21）：
   *   · `bridge.qq.connected` 只反映 WS 的 readyState，建连瞬间还是 CONNECTING(0)，
   *     那一刻取值恒为 false；它也无法回答「账号是否在线」。
   *   · 之前要么拿 WS 的 connected 冒充「在线」（不准确），要么让用户去开 NapCat
   *     的 HTTP API —— 后者要改第三方软件的本地配置，本项目红线禁止。
   *   · 正向 WS 本来就连着，OneBot v11 的 action 调用走同一根连接即可，零额外配置。
   *
   * 语义（关键）：**探不到 ≠ 离线**。
   *   · `status=ok` 且 `data.online` 是布尔 → 采信（true 在线 / false 离线）
   *   · 响应缺 online 字段 / status≠ok / 超时 / 发送失败 → online 保持 null，
   *     上层显示「账号状态未确认（unverified）」，绝不谎报在线或离线。
   */
  async _fetchStatus() {
    this._health.lastStatusProbeAt = Date.now()
    try {
      const res = await this.call('get_status')
      if (res?.status !== 'ok') {
        this.log.warn(`get_status 失败：retcode=${res?.retcode}（账号状态保持未确认）`)
        return
      }
      const data = res.data && typeof res.data === 'object' ? res.data : {}
      if (typeof data.online === 'boolean') {
        this._health.online = data.online
        this._health.onlineSource = 'get_status'
        this.log.info(`QQ 账号${data.online ? '在线' : '离线'}（WS get_status 确认）`)
      } else {
        this.log.warn('get_status 响应没有 online 字段，账号状态保持未确认')
      }
      if (typeof data.good === 'boolean') this._health.good = data.good
      // get_status 里带 self_id 时顺手补上（get_login_info 并行时可能还没回来）。
      if ((data.self_id !== undefined && data.self_id !== null) && !this._selfId) {
        this._selfId = String(data.self_id)
      }
    } catch (err) {
      // 探不到不能当离线：保持 null，UI 显示「账号状态未确认」。
      this.log.warn(`get_status 探测失败：${err?.message ?? err}（账号状态保持未确认）`)
    }
  }

  async _fetchLoginInfo() {
    try {
      const res = await this.call('get_login_info')
      if (res?.status !== 'ok') {
        this.log.warn(`get_login_info 失败：retcode=${res?.retcode}`)
        return
      }
      const data = res.data && typeof res.data === 'object' ? res.data : {}
      if (data.user_id !== undefined && data.user_id !== null) this._selfId = String(data.user_id)
      if (data.nickname) this._nickname = String(data.nickname)
      this.log.info(`已登录 QQ：${this._selfId ?? '未知'}${this._nickname ? `（${this._nickname}）` : ''}`)
    } catch (err) {
      this.log.warn(`get_login_info 异常：${err?.message ?? err}`)
    }
  }

  _onClose(ev) {
    this._ws = null
    // 连接没了，账号状态就失去依据 → 回到「未确认」，不能沿用上一次的结论。
    this._health.online = null
    this._health.onlineSource = null
    this._health.good = null
    this._rejectAll('连接已断开')
    const reason = ev?.code === undefined ? '未知' : `${ev.code}${ev.reason ? ` ${ev.reason}` : ''}`
    if (this._stopped) {
      this.log.info(`NapCat WebSocket 已关闭（${reason}）`)
      return
    }
    // 活得够久才算稳定，断开后重新从 3 秒起步；短命连接则继续退避
    if (this._openedAt && Date.now() - this._openedAt >= STABLE_CONNECTION_MS) {
      this._reconnectDelay = this.reconnectDelayMs
    }
    this._openedAt = 0
    const waitMs = this._reconnectDelay
    this.log.warn(`NapCat WebSocket 断开（${reason}），${Math.round(waitMs / 1000)}s 后重连`)
    this._scheduleReconnect()
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this._health.reconnects += 1
      this._reconnectDelay = Math.min(this.maxReconnectDelayMs, this._reconnectDelay * 2)
      this._connect() // 每次重连都重建 URL，access_token 重新带上
    }, this._reconnectDelay)
    if (typeof this._reconnectTimer.unref === 'function') this._reconnectTimer.unref()
  }

  _rejectAll(reason) {
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`${entry.action} 中断：${reason}`))
    }
    this._pending.clear()
  }

  _onRaw(data) {
    this._health.lastPacketAt = Date.now()
    let text
    if (typeof data === 'string') text = data
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data)
    else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data)
    else text = String(data ?? '')

    let packet
    try {
      packet = JSON.parse(text)
    } catch {
      this.log.warn(`收到非 JSON 数据（已丢弃，${text.length} 字符）`)
      return
    }
    if (!packet || typeof packet !== 'object') return

    // API 响应：有 echo、没有 post_type
    if (packet.echo !== undefined && packet.echo !== null && packet.post_type === undefined) {
      this._resolveEcho(packet)
      return
    }
    this._dispatchEvent(packet)
  }

  _resolveEcho(packet) {
    const key = String(packet.echo)
    const entry = this._pending.get(key)
    if (!entry) {
      this.log.warn(`收到未知 echo 的响应：${key}`)
      return
    }
    clearTimeout(entry.timer)
    this._pending.delete(key)
    entry.resolve(packet)
  }

  _dispatchEvent(packet) {
    const postType = packet.post_type

    if (postType === 'meta_event') {
      if (packet.meta_event_type === 'heartbeat') {
        const status = packet.status && typeof packet.status === 'object' ? packet.status : {}
        if (typeof status.online === 'boolean') {
          this._health.online = status.online
          this._health.onlineSource = 'heartbeat'
        }
        if (typeof status.good === 'boolean') this._health.good = status.good
        this._health.lastHeartbeatAt = Date.now()
      } else if (packet.meta_event_type === 'lifecycle') {
        this.log.info(`NapCat 生命周期事件：${packet.sub_type ?? 'unknown'}`)
      }
      return
    }

    if (postType !== 'message') return // notice / request 暂不处理

    const kind = packet.message_type
    if (kind !== 'private' && kind !== 'group') return

    const event = this._parseMessageEvent(packet, kind)
    if (!event) return

    // 自己发的消息会被 NapCat 回灌成事件，直接丢掉，避免自问自答
    const selfId = event.selfId ?? this._selfId
    if (selfId && event.userId && event.userId === selfId) return

    if (this._isDuplicate(event.messageId)) {
      this.log.info(`重复消息已忽略（message_id=${event.messageId}）`)
      return
    }

    for (const handler of this._handlers) {
      try {
        const ret = handler(event)
        if (ret && typeof ret.then === 'function') {
          ret.catch((err) => this.log.error(`消息处理器异常：${err?.message ?? err}`))
        }
      } catch (err) {
        this.log.error(`消息处理器异常：${err?.message ?? err}`)
      }
    }
  }

  _parseMessageEvent(packet, kind) {
    const rawSender = packet.sender && typeof packet.sender === 'object' ? packet.sender : {}
    const userId = String(packet.user_id ?? rawSender.user_id ?? '')
    if (!userId) return null
    return {
      kind,
      userId,
      groupId: kind === 'group' ? String(packet.group_id ?? '') || null : null,
      text: parseMessage(packet.message, packet.raw_message),
      messageId: packet.message_id === undefined || packet.message_id === null ? '' : String(packet.message_id),
      senderName: String(rawSender.card || rawSender.nickname || ''),
      sender: rawSender,
      selfId: packet.self_id === undefined || packet.self_id === null ? null : String(packet.self_id),
      time: Number.isFinite(Number(packet.time)) ? Number(packet.time) : null,
      raw: packet,
    }
  }

  /** 按 message_id 去重，只保留最近 dedupCapacity 个。 */
  _isDuplicate(messageId) {
    const key = messageId === undefined || messageId === null ? '' : String(messageId)
    if (!key) return false // 没有 message_id 就不去重，宁可重复也不丢
    if (this._seen.has(key)) return true
    this._seen.add(key)
    this._seenOrder.push(key)
    while (this._seenOrder.length > this.dedupCapacity) {
      const oldest = this._seenOrder.shift()
      this._seen.delete(oldest)
    }
    return false
  }
}

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Number(value) : fallback
}
