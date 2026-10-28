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

import fs from 'node:fs'
import path from 'node:path'

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
/**
 * 引用解析（get_msg / get_forward_msg）的单次超时。
 *
 * 为什么不用 10s 的默认值：引用解析是**回复前的阻塞步骤**，NapCat 被风控时
 * 一个请求能挂到天黑。给 5s，超了就静默降级只发当前消息。
 */
const QUOTE_FETCH_TIMEOUT_MS = 5_000
// 打字延时分级：<10 → 200ms；10~14 → 450ms；15+ → 800ms。
// 2026-10-23：三档的**字数边界**与**毫秒基准**都改成可配置（设置页 → 信息发送配置），
// 这里的常量只作兜底，见 typingDelayFor 的第三参。
/** 字数边界默认值（与插件 Config 的 typingDelayCharTiers 默认值保持一致）。 */
export const DEFAULT_TYPING_CHAR_TIERS = Object.freeze({ shortMax: 10, mediumMax: 14, longMin: 15 })
/** 毫秒基准默认值（与插件 Config 的 flypitDelayTiers 默认值保持一致）。 */
export const DEFAULT_TYPING_MS_TIERS = Object.freeze({ short: 200, medium: 450, long: 800 })
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

/** logger 可能为 undefined，字段也可能缺失；一律容错成空操作。
 *  debug 是后加的（2026-10-26，notice 事件只记 debug）：老 logger 没有这个方法时自动退化成空操作。 */
function makeLogger(logger) {
  const bind = (name) => (logger && typeof logger[name] === 'function'
    ? (msg) => { try { logger[name](msg) } catch { /* 日志自身出错不影响主链路 */ } }
    : () => {})
  return { info: bind('info'), warn: bind('warn'), error: bind('error'), debug: bind('debug') }
}

/** 日志里不能出现 access_token。 */
function redactUrl(url) {
  return String(url ?? '').replace(/([?&]access_token=)[^&]*/i, '$1***')
}

/** 防止 NapCat 把文本里的 [CQ: 当 CQ 码解析：冒号换成全角。 */
export function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：')
}

/**
 * 抽出图片段（2026-10-23，任务 5）。
 *
 * OneBot/NapCat 的 image 段通常带 `url`（可直接下载）和 `file`（文件名/本地路径）。
 * 桥接优先用 url；没有 url 时把 file 原样交给下载器（支持 http / file:// / 绝对路径）。
 * 只做结构提取，不在这里发网络请求——下载逻辑在 bridge.mjs，便于注入测试。
 *
 * @param {Array|string} message OneBot 消息段
 * @returns {Array<{url:string, file:string, summary:string, size:number}>}
 */
export function extractImages(message) {
  if (!Array.isArray(message)) return []
  const out = []
  for (const seg of message) {
    if (!seg || seg.type !== 'image') continue
    const data = seg.data && typeof seg.data === 'object' ? seg.data : {}
    const url = String(data.url ?? '').trim()
    const file = String(data.file ?? '').trim()
    const summary = String(data.summary ?? data.sub_type ?? '').trim()
    if (!url && !file) continue
    const size = Number(data.file_size)
    out.push({
      url: url || file,
      file,
      summary,
      size: Number.isFinite(size) && size > 0 ? size : 0,
    })
  }
  return out
}

/**
 * 抽出视频段（2026-10-26，插件联动契约 §6）。
 *
 * OneBot/NapCat 的 video 段通常带 `url`（可直接下载）和 `file`（文件名/本地路径），
 * 部分版本还带 `file_size`。这里只做结构提取，不在这里发网络请求——
 * 下载落盘在 bridge.mjs / plugin-hub.mjs，便于注入测试。
 *
 * @param {Array|string} message OneBot 消息段
 * @returns {Array<{url:string, file:string, fileSize:number}>}
 */
export function extractVideos(message) {
  if (!Array.isArray(message)) return []
  const out = []
  for (const seg of message) {
    if (!seg || seg.type !== 'video') continue
    const data = seg.data && typeof seg.data === 'object' ? seg.data : {}
    const url = String(data.url ?? '').trim()
    const file = String(data.file ?? '').trim()
    if (!url && !file) continue
    const size = Number(data.file_size)
    out.push({
      url: url || file,
      file,
      fileSize: Number.isFinite(size) && size > 0 ? size : 0,
    })
  }
  return out
}

/**
 * 解析 CQ 码里的 `k=v,k=v` 参数段。
 *
 * 值里的逗号/方括号在 CQ 里会被转成 HTML 实体（`&#44;` `&#91;` `&#93;`），
 * 这里只还原这几种——URL 里的 `&` 也是实体，一并处理。
 * @param {string} body
 * @returns {Record<string, string>}
 */
function parseCqParams(body) {
  const out = {}
  for (const part of String(body ?? '').split(',')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    const value = part.slice(eq + 1).trim()
      .replace(/&#91;/gu, '[')
      .replace(/&#93;/gu, ']')
      .replace(/&#44;/gu, ',')
      .replace(/&amp;/gu, '&')
    if (key) out[key] = value
  }
  return out
}

/**
 * 从 **CQ 码字符串**里抽图片（2026-10-27）。
 *
 * 为什么必须支持：`get_forward_msg` 返回的节点，`content` 在部分协议端里是
 * `[CQ:image,file=xxx,url=https://…]` 这种字符串，不是消息段数组。
 * 之前只处理数组，字符串走 `cqToText` 变成 `[图片]`、URL 整个丢掉——
 * 真机表现就是「聊天记录里的图模型完全看不到」。
 *
 * @param {string} text
 * @returns {Array<{url:string, file:string, summary:string, size:number}>}
 */
export function extractImagesFromCq(text) {
  const out = []
  const source = String(text ?? '')
  const re = /\[CQ:image,([^\]]*)\]/gi
  let matched
  while ((matched = re.exec(source)) !== null) {
    const params = parseCqParams(matched[1])
    const url = String(params.url ?? '').trim()
    const file = String(params.file ?? '').trim()
    if (!url && !file) continue
    const size = Number(params.file_size)
    out.push({
      url: url || file,
      file,
      summary: String(params.summary ?? params.sub_type ?? '').trim(),
      size: Number.isFinite(size) && size > 0 ? size : 0,
    })
  }
  return out
}

/** 从 CQ 码字符串里抽视频（同 extractImagesFromCq，但 type 是 video）。 */
export function extractVideosFromCq(text) {
  const out = []
  const source = String(text ?? '')
  const re = /\[CQ:video,([^\]]*)\]/gi
  let matched
  while ((matched = re.exec(source)) !== null) {
    const params = parseCqParams(matched[1])
    const url = String(params.url ?? '').trim()
    const file = String(params.file ?? '').trim()
    if (!url && !file) continue
    const size = Number(params.file_size)
    out.push({
      url: url || file,
      file,
      fileSize: Number.isFinite(size) && size > 0 ? size : 0,
    })
  }
  return out
}

/**
 * 统一入口：数组走 `extractImages`，CQ 字符串走 `extractImagesFromCq`。
 * 调用方不用关心协议端给的是哪种形态（NapCat 各版本 / go-cqhttp 不一致）。
 * @param {Array|string} message
 * @returns {Array<{url:string, file:string, summary:string, size:number}>}
 */
export function extractImagesFromMessage(message) {
  if (Array.isArray(message)) return extractImages(message)
  if (typeof message === 'string') return extractImagesFromCq(message)
  return []
}

/** 统一入口：视频版。 */
export function extractVideosFromMessage(message) {
  if (Array.isArray(message)) return extractVideos(message)
  if (typeof message === 'string') return extractVideosFromCq(message)
  return []
}

/**
 * 从消息段里抽「被引用的消息 / 合并转发」的标识（2026-10-27）。
 *
 * 为什么要单独抽：`parseMessage` 解析时 reply 段必须被丢掉（否则正文会把被引用
 * 内容再念一遍），但桥接需要拿 id 去拉原文（get_msg）和聊天记录（get_forward_msg）。
 *
 * 支持的形态：
 *   · `type:'reply'`  → `data.id` / `data.message_id` = 被引用消息 id
 *   · `type:'forward'`→ `data.id` = 合并转发 id
 *   · `type:'node'`   → NapCat 有时把转发节点内联展开，没有 id，直接给内容
 *   · `type:'json'`   → 少数客户端的「聊天记录」分享会在 JSON 里带 forward_id
 *
 * @param {Array|string} message
 * @returns {{replyId:string, forwardIds:string[], inlineNodes:Array<object>}}
 */
export function parseQuoteSegments(message) {
  const out = { replyId: '', forwardIds: [], inlineNodes: [] }
  if (!Array.isArray(message)) return out
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    const type = String(seg.type ?? '')
    const data = seg.data && typeof seg.data === 'object' ? seg.data : {}
    if (type === 'reply') {
      const id = String(data.id ?? data.message_id ?? '').trim()
      if (id && !out.replyId) out.replyId = id
    } else if (type === 'forward') {
      const id = String(data.id ?? data.forward_id ?? '').trim()
      if (id) out.forwardIds.push(id)
    } else if (type === 'node') {
      if (data && typeof data === 'object') out.inlineNodes.push(data)
    } else if (type === 'json') {
      const id = findForwardIdInCard(data)
      if (id) out.forwardIds.push(id)
    }
  }
  return out
}

/**
 * 从 json 卡片里找「聊天记录」的 forward_id。
 *
 * 不确定各客户端把 id 放在哪层，直接在序列化后的文本里按字段名抓；
 * 抓不到就返回空串（静默，不影响卡片本身的文字化）。
 * @param {object} data json 段的 data
 * @returns {string}
 */
function findForwardIdInCard(data) {
  const payload = data.data ?? data.content ?? data.value ?? ''
  if (!payload) return ''
  let text = ''
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  } catch {
    return ''
  }
  const matched = /"forward_id"\s*:\s*"([0-9A-Za-z_-]{4,})"/u.exec(text)
  return matched ? matched[1] : ''
}

/**
 * 把 get_forward_msg 返回的一个节点压成纯文本描述。
 *
 * 节点形态在不同实现里不一样（`{data:{content}}` / `{sender, message}`），
 * 这里两条路都认；图片统一写成 `［图片］`（全角方括号是关键——半角 `[图片]`
 * 会被 bridge 的占位清理逻辑当成当前消息的占位删掉，见 `_buildPromptContent`）。
 *
 * @param {object} node
 * @returns {{name:string, userId:string, text:string, images:Array<object>}|null}
 */
export function normalizeForwardNode(node) {
  if (!node || typeof node !== 'object') return null
  // 已经是规范化形态（`get_forward_msg` 内部转过一次，或测试里直接喂的假节点）：
  // 原样返回。**必须**有这个 guard —— 规范化节点没有 content/message 字段，
  // 再转一次会把 name/text/images 全部清空。
  if (typeof node.text === 'string' && Array.isArray(node.images)) return node
  const data = node.data && typeof node.data === 'object' ? node.data : node
  const sender = (node.sender && typeof node.sender === 'object' ? node.sender : null)
    ?? (data.sender && typeof data.sender === 'object' ? data.sender : {})
  const name = String(data.name ?? sender.card ?? sender.nickname ?? sender.name ?? data.uin ?? '').trim()
  const raw = data.content ?? data.message ?? node.message ?? ''
  const message = Array.isArray(raw) ? raw : []
  const text = parseMessage(message, typeof raw === 'string' ? raw : '').trim()
  // 关键：节点内容可能是 CQ 字符串，必须用统一入口，否则图片 URL 会被丢掉
  //（真机表现：聊天记录里的图全变成 `[图片]` 文本，模型看不到）。
  const images = extractImagesFromMessage(raw)
  const videos = extractVideosFromMessage(raw)
  if (!text && images.length === 0 && videos.length === 0) return null
  return {
    name: name || '群友',
    userId: String(data.uin ?? data.user_id ?? sender.user_id ?? ''),
    text,
    images,
    videos,
  }
}

/** 字符串格式消息里的 CQ 码转纯文本（array 格式不走这里）。 */
export function cqToText(text) {  return String(text ?? '')    // @ 后面必须留一个空格：否则「@123你好」会被模型当成一个整体。
    .replace(/\[CQ:at,[^\]]*qq=([^,\]]+)[^\]]*\]/gi, (_, qq) => (String(qq) === 'all' ? '@全体成员 ' : `@${qq} `))
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
    .replace(/[ \t]{2,}/gu, ' ')
    .trim()
}

// ── 分享卡片（json / xml 消息段，2026-10-27）────────────────────────────
//
// 群友分享 B 站/小程序/网页时，NapCat 给的是 json 或 xml 段，里面是一整坨结构化数据。
// 以前一律落成 `[卡片]`，模型只能回"卡片是空的"。这里把 title 和跳转链接抠出来，
// 正文里留下 `[分享卡片: 标题 - 链接]`，模型能据此接话/问要不要展开。
//
// 兼容的常见形态：
//   · 结构化消息 com.tencent.structmsg → meta.news / meta.detail_1 里的 title / jumpUrl
//   · 小程序 com.tencent.miniapp_01  → meta.detail_1.title / qqdocurl / preview
//   · 旧版 xml 卡片（<title>…</title> + <qqdocurl> / <url>）
// 都解析不出来才退回 `[卡片]`，绝不把原始 JSON 塞进 prompt。

const CARD_TITLE_MAX = 120
const CARD_URL_MAX = 500
/** URL 字段优先级：qqdocurl 是 QQ 文档/分享的跳转地址，最准。 */
const CARD_URL_KEYS = ['qqdocurl', 'jumpurl', 'url', 'href', 'link']

/** HTML/XML 实体解码（卡片标题里 &amp;&#39; 很常见）。 */
function decodeCardEntities(text) {
  return String(text ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (whole, hex, dec) => {
      const code = hex ? parseInt(hex, 16) : parseInt(dec, 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try { return String.fromCodePoint(code) } catch { return whole }
    })
}

function cleanCardTitle(value) {
  const title = decodeCardEntities(String(value ?? ''))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return title.length > CARD_TITLE_MAX ? `${title.slice(0, CARD_TITLE_MAX)}…` : title
}

function cleanCardUrl(value) {
  const url = decodeCardEntities(String(value ?? '')).trim()
  // 只认能点开的 http(s)；卡片里还有一堆 `xxx.png` / 内部 scheme。
  if (!/^https?:\/\//i.test(url)) return ''
  return url.length > CARD_URL_MAX ? url.slice(0, CARD_URL_MAX) : url
}

/** 递归收集卡片 JSON 里的标题/链接候选（卡片结构各平台不一样，按字段名找最稳）。 */
function collectCardFields(node, depth, acc) {
  if (!node || typeof node !== 'object' || depth > 8) return acc
  if (Array.isArray(node)) {
    for (const item of node) collectCardFields(item, depth + 1, acc)
    return acc
  }
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === 'object') {
      collectCardFields(value, depth + 1, acc)
      continue
    }
    if (typeof value !== 'string') continue
    const k = String(key).toLowerCase()
    if (k === 'title') acc.titles.push(value)
    else if (k === 'desc' || k === 'summary') acc.summaries.push(value)
    if (CARD_URL_KEYS.includes(k)) acc.urls.push({ key: k, value })
  }
  return acc
}

/** xml 卡片：标签取值（容忍属性、CDATA）。 */
function xmlTagValue(xml, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i')
  const match = re.exec(xml)
  if (!match) return ''
  const raw = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  return decodeCardEntities(raw).trim()
}

/**
 * 从 json / xml 消息段里抽分享卡片的标题和链接。
 *
 * @param {{type?:string, data?:object}} segment OneBot 消息段
 * @returns {{title:string, url:string}|null} 两者都抽不到返回 null
 */
export function extractCardInfo(segment) {
  if (!segment || typeof segment !== 'object') return null
  const type = String(segment.type ?? '')
  if (type !== 'json' && type !== 'xml') return null
  const data = segment.data && typeof segment.data === 'object' ? segment.data : {}

  // NapCat 的 json 段把整张卡片塞在 data 字符串里（字段名就是 data）。
  const payload = data.data ?? data.content ?? data.value ?? ''
  const text = typeof payload === 'string' ? payload : (payload ? JSON.stringify(payload) : '')

  if (type === 'json') {
    let parsed = null
    if (payload && typeof payload === 'object') {
      parsed = payload
    } else if (text.trim()) {
      const candidates = [text, decodeCardEntities(text)]
      for (const candidate of candidates) {
        try { parsed = JSON.parse(candidate); break } catch { /* 换下一种（实体转义后再试） */ }
      }
    }
    if (!parsed || typeof parsed !== 'object') return null
    const acc = { titles: [], summaries: [], urls: [] }
    collectCardFields(parsed, 0, acc)
    const title = cleanCardTitle(acc.titles.find((item) => cleanCardTitle(item)) || acc.summaries.find((item) => cleanCardTitle(item)) || '')
    const url = pickCardUrl(acc.urls)
    if (!title && !url) return null
    return { title, url }
  }

  // xml：标题 + 链接标签，链接常见 <qqdocurl> / <url> / <jumpUrl>。
  if (!text.trim()) return null
  const title = cleanCardTitle(xmlTagValue(text, 'title'))
  let url = ''
  for (const tag of ['qqdocurl', 'jumpUrl', 'url', 'href']) {
    url = cleanCardUrl(xmlTagValue(text, tag))
    if (url) break
  }
  if (!title && !url) return null
  return { title, url }
}

/** 按 qqdocurl > jumpUrl > url … 的优先级挑一个能点开的链接。 */
function pickCardUrl(urls) {
  for (const key of CARD_URL_KEYS) {
    for (const item of urls) {
      if (item.key !== key) continue
      const url = cleanCardUrl(item.value)
      if (url) return url
    }
  }
  return ''
}

/**
 * 卡片段 → 正文里的文字。
 *
 * @param {{type?:string, data?:object}} segment
 * @returns {string} 解析成功返回 `[分享卡片: 标题 - 链接]`，失败返回 `[卡片]`
 */
export function formatCardSegment(segment) {
  const card = extractCardInfo(segment)
  if (!card) return '[卡片]'
  if (card.title && card.url) return `[分享卡片: ${card.title} - ${card.url}]`
  return card.title ? `[分享卡片: ${card.title}]` : `[分享卡片: ${card.url}]`
}

/**
 * 消息段转纯文本。
 *
 * @ 的格式（2026-10-23 修）：
 *   · 群里 @ 某人 → `@昵称 `（昵称取自 data.name / 调用方解析器；拿不到就 `@QQ号 `）；
 *   · `@全体成员 `；
 *   · **@ 和后面的正文之间必须有空格**，否则模型看到的是 `@1000000001你好`，
 *     既分不清 @ 目标，也读不出这是两个 token。
 *
 * @param {Array|string} message array 格式消息段，或 CQ 字符串
 * @param {string} [rawMessage] message 为空时兜底
 * @param {{resolveAtName?: (qq:string) => string|undefined}} [options]
 *   昵称解析器：由 OneBotClient 用「群成员发言缓存」实现（不额外打 API）。
 */
/**
 * 剥掉消息**开头**的连续 @（v2.0 第十九步）。
 *
 * 群里先 @bot 再发指令时，`parseMessage` 会把 at 段转成 `@小鱼 `，
 * 文本变成 `@小鱼 /归纳` → `startsWith('/')` 判定失败，指令被当普通聊天。
 * 这里只剥开头、不碰正文里的 @；@ 昵称遇到 `/` 即停，兼容 `@小鱼/归纳` 无空格写法。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripLeadingMentions(text) {
  let out = String(text ?? '')
  for (;;) {
    const next = out.replace(/^\s*@[^\s@/]+\s*/u, '')
    if (next === out) break
    out = next
  }
  return out.trim()
}

export function parseMessage(message, rawMessage = '', options = {}) {
  const resolveAtName = typeof options?.resolveAtName === 'function' ? options.resolveAtName : null
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
          if (qq === 'all') { parts.push('@全体成员 '); break }
          // 昵称优先级：段里自带的 name > 群成员发言缓存 > QQ 号。
          // （OneBot 标准 at 段只有 qq；部分实现会额外带 name。）
          const inline = String(data.name ?? '').trim()
          const cached = inline === '' && resolveAtName ? String(resolveAtName(qq) ?? '').trim() : ''
          parts.push(`@${inline || cached || qq} `)
          break
        }
        case 'face': case 'mface': case 'sface': parts.push('[表情]'); break
        case 'record': parts.push('[语音]'); break
        case 'video': parts.push('[视频]'); break
        case 'file': parts.push('[文件]'); break
        case 'forward': parts.push('[合并转发]'); break
        case 'json': case 'xml': parts.push(formatCardSegment(seg)); break
        // 这些段没有文本价值，直接丢掉（reply 尤其不该把被引用内容重复一遍）
        case 'reply': case 'poke': case 'shake': case 'anonymous': case 'rps': case 'dice': break
        default: parts.push(`[${type}]`)
      }
    }
    // 归一化空白：text 段自己带的空格 + @ 尾巴的空格叠在一起时只留一个。
    return parts.join('').replace(/[ \t]{2,}/gu, ' ').trim() || cqToText(rawMessage).trim()
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

/**
 * 超硬上限的代码块/日志块：优先按换行切。
 *
 * v2.0 第二十步修复：以前单行超过 hard（例如一行 5000 字的代码块）会整条返回，
 * 超过 QQ 单条上限直接发送失败。现在对超长单行再用 `splitText` 兜底切到 hard 以内
 * （优先标点、切不动硬切，不劈代理对）。
 */
function splitByLines(text, hard) {
  const out = []
  const flush = (value) => {
    if (value === '') return
    if (charCount(value) <= hard) { out.push(value); return }
    out.push(...splitText(value, hard))
  }
  let buf = ''
  for (const line of String(text).split('\n')) {
    if (!buf) { buf = line; continue }
    if (charCount(buf) + 1 + charCount(line) <= hard) buf += '\n' + line
    else { flush(buf); buf = line }
  }
  flush(buf)
  return out
}

/**
 * 分级打字延时：按分片**码点**数选档，±15% 抖动，下限 150ms。
 *
 * 档位边界与毫秒基准都可配置（2026-10-23）：
 *   · `charTiers`：{ shortMax, mediumMax, longMin } —— 默认 <10 / 10~14 / 15+；
 *   · `msTiers`：{ short, medium, long } —— 默认 200 / 450 / 800。
 *
 * 兼容旧调用：`typingDelayFor(n, rand)` 仍然走默认档位。
 *
 * @param {number} chars
 * @param {() => number} [rand=Math.random]
 * @param {{charTiers?:object, msTiers?:object}} [tiers]
 */
export function typingDelayFor(chars, rand = Math.random, tiers = {}) {
  const n = Number.isFinite(chars) ? chars : 0
  const charTiers = normalizeTypingCharTiers(tiers?.charTiers)
  const msTiers = normalizeTypingMsTiers(tiers?.msTiers)
  let base
  if (n < charTiers.shortMax) base = msTiers.short
  else if (n <= charTiers.mediumMax || n < charTiers.longMin) base = msTiers.medium
  else base = msTiers.long
  const jitter = 1 + (rand() * 2 - 1) * TYPING_DELAY_JITTER
  return Math.max(TYPING_DELAY_MIN_MS, Math.round(base * jitter))
}

/**
 * 归一化字数档位：任何非法值都回落到默认，且保证边界单调
 * （shortMax ≤ mediumMax < longMin），避免设置页写成 20/10/5 之后分档错乱。
 * @param {unknown} source
 * @returns {{shortMax:number, mediumMax:number, longMin:number}}
 */
export function normalizeTypingCharTiers(source) {
  const raw = source && typeof source === 'object' && !Array.isArray(source) ? source : {}
  const num = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
  }
  const shortMax = num(raw.shortMax, DEFAULT_TYPING_CHAR_TIERS.shortMax)
  const mediumMax = Math.max(shortMax, num(raw.mediumMax, DEFAULT_TYPING_CHAR_TIERS.mediumMax))
  const longMin = Math.max(mediumMax + 1, num(raw.longMin, DEFAULT_TYPING_CHAR_TIERS.longMin))
  return { shortMax, mediumMax, longMin }
}

/** 归一化三档毫秒基准（负数/非数字回落默认）。 */
export function normalizeTypingMsTiers(source) {
  const raw = source && typeof source === 'object' && !Array.isArray(source) ? source : {}
  const num = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  return {
    short: num(raw.short, DEFAULT_TYPING_MS_TIERS.short),
    medium: num(raw.medium, DEFAULT_TYPING_MS_TIERS.medium),
    long: num(raw.long, DEFAULT_TYPING_MS_TIERS.long),
  }
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
/** 极短气泡阈值（v2.0 第十九步）：单个泡小于这个码点数时，尝试与相邻行合并。 */
export const MIN_BUBBLE_CHARS = 4

/**
 * 无标点超长行的降级阈值（v2.0 第二十一步）。
 *
 * 一行超过这个长度且**一个标点都没有**（乱码 / 无断句的长串）时，
 * 放弃「拟人短句」切分，改用 chunkSize 发大块 —— 否则 4500 字会切成
 * 150 条 30 字消息，既刷屏又容易触发风控。
 */
export const LONG_LINE_NO_PUNCT_CHARS = 500

/** 判断一行里有没有任何断句标点（中文 / 英文都算）。 */
const HAS_SENTENCE_PUNCT = /[。！？!?；;…，,、：:]/u

/** 独立应答词：即使是极短行也**不合并**（模型可能就是想单发一个「嗯」）。 */
const STANDALONE_SHORT = new Set([
  '嗯', '嗯嗯', '哦', '噢', '好', '好的', '行', '行吧', '对', '是', '在', '在的', '收到', '知道了', '明白',
  '哈哈', '哈', '嘿', '嗨', '诶', '欸', '草', '来了', '？', '！', '…',
])

/** 极短行只有和「下一行的长句」组合时才合并（2~3 字话题标签 + 正文），下一行至少这么长。 */
const NEXT_LINE_MIN_CHARS = 6

/** 片头标点：出现时并入上一泡（去掉标点），避免「，继续」单独成泡。 */
const LEADING_PUNCT = /^[，,、；;：:]+/u

/**
 * 跨行后处理（v2.0 第十九步）：**只处理「明显不该断开」的相邻行**，
 * 原生换行仍是强边界。
 *
 *   ① 下一行以逗号类标点开头 → 去标点并入上一行（「收到\n，马上来」→「收到马上来」）；
 *   ② 某行只有一个极短片段（< MIN_BUBBLE_CHARS）且不是独立应答词 →
 *      优先并入上一行；没有上一行则前置到下一行（「帽子\n今天天气不错」→ 一个泡）；
 *   ③ 上一行以句末标点结尾时不合并（尊重刻意断句）。
 *
 * @param {string[][]} groups 每行的片段数组
 * @param {{bubbleMax:number, minBubble:number}} opts
 * @returns {string[]}
 */
function mergeAcrossLines(groups, { bubbleMax, minBubble }) {
  const list = groups.map((pieces) => [...pieces])
  const endsSentence = (text) => /[。！？!?…]$/u.test(text)

  // 第一轮：片头标点 → 并入上一行
  for (let i = 0; i < list.length; i++) {
    if (list[i].length === 0) continue
    const raw = list[i][0]
    const stripped = raw.replace(LEADING_PUNCT, '')
    if (stripped === raw) continue
    const prev = i > 0 ? list[i - 1] : null
    const prevLast = prev?.[prev.length - 1]
    if (prevLast && !endsSentence(prevLast)
      && charCount(prevLast) + charCount(stripped) <= bubbleMax) {
      prev[prev.length - 1] = prevLast + stripped
      list[i].shift()
    } else {
      list[i][0] = stripped
    }
  }

  // 第二轮：极短行（2~3 字）后面紧跟长句 → 视为「话题标签 + 正文」，前置合并。
  // 刻意断开的短句（「收到」「嗯」「第一句」这类）保持独立：
  //   · 1 字不参与；独立应答词不参与；下一行太短（< NEXT_LINE_MIN_CHARS）不参与。
  for (let i = 0; i < list.length; i++) {
    if (list[i].length !== 1) continue
    const short = list[i][0]
    const shortChars = charCount(short)
    if (shortChars < 2 || shortChars >= minBubble) continue
    if (STANDALONE_SHORT.has(short.trim())) continue
    const next = i + 1 < list.length ? list[i + 1] : null
    if (!next || next.length === 0) continue
    if (charCount(next[0]) < NEXT_LINE_MIN_CHARS) continue
    if (shortChars + charCount(next[0]) > bubbleMax) continue
    next[0] = short + next[0]
    list[i] = []
  }

  return list.flat().filter((x) => x.length > 0)
}

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
    // v2.0 第十九步：只对「明显不该断开」的相邻行做后处理（见 mergeAcrossLines）。
    const lineGroups = []
    for (const line of seg.lines) {
      // v2.0 第二十一步：无标点超长行（乱码 / 长串）降级成 chunkSize 大块，
      // 不再按 30 字拟人短句切，避免 4500 字变 150 条刷屏。
      if (charCount(line) > LONG_LINE_NO_PUNCT_CHARS && !HAS_SENTENCE_PUNCT.test(line)) {
        for (const chunk of splitText(line, hard)) lineGroups.push([chunk])
        continue
      }
      // 桥接硬切出的碎片允许合并，防止「短。短。短。」刷屏
      const pieces = mergeFragments(splitLineSemantic(line, bubbleMax, MIN_FIRST_PIECE_CHARS), bubbleMax, mergeMax)
      const cleaned = []
      for (const piece of pieces) {
        if (doTrim) {
          const t = trimEndPunctuation(piece, keep, false)
          if (t) cleaned.push(t)
        } else if (piece) cleaned.push(piece)
      }
      if (cleaned.length > 0) lineGroups.push(cleaned)
    }
    out.push(...mergeAcrossLines(lineGroups, { bubbleMax, minBubble: MIN_BUBBLE_CHARS }))
  }
  return out.filter((x) => x.length > 0)
}

/**
 * 图片地址分类（只用于回执里的 `via`，不影响实际发送）：
 * http(s) → `url`；`base64://` → `base64`；其余（file:/// 绝对路径）→ `file`。
 * @param {string} file
 * @returns {'url'|'file'|'base64'|''}
 */
export function imageFileVia(file) {
  const ref = String(file ?? '').trim()
  if (!ref) return ''
  if (/^https?:\/\//i.test(ref)) return 'url'
  if (/^base64:\/\//i.test(ref)) return 'base64'
  return 'file'
}

/** 取前 24 个 base64 字符解码，看是不是 GIF 魔数（GIF87a / GIF89a）。 */
function base64HeadIsGif(text) {
  try {
    const head = Buffer.from(String(text ?? '').slice(0, 24), 'base64')
    return head.length >= 3 && head.subarray(0, 3).toString('ascii') === 'GIF'
  } catch {
    return false
  }
}

/**
 * 这个图片引用是不是 GIF（只看后缀与魔数，不打网络）。
 *
 * 为什么要判：`sub_type:1` 的表情段里，GIF 还要带 `summary:'[动画表情]'`，
 * QQ 才按动画表情渲染；静态图不需要这个字段，多给反而可能干扰。
 * @param {string} file 图片地址（url / data: / base64:// / file:/// / 绝对路径）
 * @returns {boolean}
 */
export function imageRefLooksGif(file) {
  const ref = String(file ?? '').trim()
  if (!ref) return false
  if (/^base64:\/\//i.test(ref)) return base64HeadIsGif(ref.slice('base64://'.length))
  if (/^data:/i.test(ref)) {
    const comma = ref.indexOf(',')
    return comma >= 0 && base64HeadIsGif(ref.slice(comma + 1))
  }
  // http(s) / file:/// / 绝对路径：只看路径部分的扩展名（忽略 ?query / #hash）。
  const pathPart = ref.split(/[?#]/)[0]
  return /\.gif$/i.test(pathPart)
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
   * @param {number} [opts.batchIntervalMs=0] 相邻气泡的**最小**间隔（节奏批次间隔；0=不限制）
   * @param {boolean} [opts.typingDelayEnabled=true] 打字延时总开关（关闭 = 不分片、不延时、整条发）
   * @param {string[]} [opts.keepEndPunct] 片尾保留标点，默认 ['？','！']
   * @param {boolean} [opts.trimEndPunctuation=true] 是否裁片尾标点
   * @param {boolean} [opts.groupAtReply=true] 群聊回复时是否 @ 发送者
   * @param {'first'|'last'} [opts.groupAtPosition='last'] @ 挂在哪一片
   * @param {object} [opts.typingDelayCharTiers] 字数档位边界 { shortMax, mediumMax, longMin }
   * @param {object} [opts.typingDelayMsTiers] 三档毫秒基准 { short, medium, long }
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
    batchIntervalMs,
    typingDelayEnabled,
    typingDelayCharTiers,
    typingDelayMsTiers,
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
    // 节奏批次间隔（Phase 4）：多气泡之间的**最小**间隔，由 bridge 从热配置刷进来。
    // 0/未设 = 不额外限制，完全沿用原来的分级打字延时（保持旧行为）。
    this.batchIntervalMs = Number.isFinite(batchIntervalMs) && batchIntervalMs > 0 ? Number(batchIntervalMs) : 0
    this.typingDelayEnabled = typingDelayEnabled !== false
    // 字数档位 / 毫秒基准（2026-10-23）：由 bridge 从热配置刷进来；
    // 未设时用默认值，行为与旧版一致（<10 / 10~14 / 15+，200 / 450 / 800ms）。
    this.typingDelayCharTiers = normalizeTypingCharTiers(typingDelayCharTiers)
    this.typingDelayMsTiers = normalizeTypingMsTiers(typingDelayMsTiers)
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
    // notice 处理器（2026-10-26，戳一戳）：和消息处理器分开，避免桥接的 message
    // 回调被通知事件串到（签名也不同）。
    this._noticeHandlers = new Set()
    this._seen = new Set()
    this._seenOrder = []
    // 群成员昵称缓存（2026-10-23）：@ 段通常只有 QQ 号，没有昵称。
    // 这里记录「最近说过话的人」的显示名，parseMessage 遇到 @ 时按 key 查。
    // 只做内存缓存，不额外打 NapCat API；30 分钟没说话就自然淘汰。
    this._atNames = new Map() // `${groupId|'u'}:${qq}` -> { name, at }
    this._atNamesCap = 2000
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

  /**
   * 注册 notice 处理器（2026-10-26，目前只有戳一戳）。
   * handler({ kind:'poke', userId, targetId, groupId, selfId, time, raw })
   * @returns {Function} 注销函数
   */
  onNotice(handler) {
    if (typeof handler !== 'function') throw new TypeError('onNotice 需要一个函数')
    this._noticeHandlers.add(handler)
    return () => this._noticeHandlers.delete(handler)
  }

  /**
   * 已知昵称查询（群成员 / 好友缓存），取不到返回 ''。
   *
   * 缓存本身由消息事件顺手填（`_rememberName`），这里只是暴露给桥接（戳一戳文案
   * 要拿戳的人昵称）。scopeKey 容错两种写法：
   *   · OneBot 原生作用域：群号 / `'u'`（私聊只有一个桶）；
   *   · 桥接的会话 key：`g:<群号>` / `u:<QQ号>`（bridge.keyOf 的格式）。
   * 这样 §5.3 里不管桥接传哪种都能取到名字，取不到就让调用方退回 QQ 号。
   * @param {string} scopeKey
   * @param {string|number} qq
   * @returns {string}
   */
  nameOf(scopeKey, qq) {
    const scope = String(scopeKey ?? '').trim()
    const id = String(qq ?? '').trim()
    if (!scope || !id) return ''
    const candidates = [scope]
    if (/^g:/iu.test(scope)) candidates.push(scope.slice(2))
    else if (/^u:/iu.test(scope)) candidates.push('u')
    else if (/^\d+$/u.test(scope)) candidates.push('u') // 私聊只有一个桶，群号是数字时也兜一下
    for (const key of candidates) {
      const name = this._nameOf(key, id)
      if (name) return name
    }
    return ''
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
   *
   * @param {string} action
   * @param {object} [params]
   * @param {{timeoutMs?:number}} [options] 单次超时覆盖（引用解析用短超时，
   *   不能让它拖住正常回复；见 bridge 的 QUOTE_FETCH_* 常量）。
   */
  async call(action, params = {}, options = {}) {
    const name = String(action ?? '')
    if (!name) throw new Error('call: action 不能为空')
    const ws = this._ws
    if (!ws || ws.readyState !== WS_OPEN) throw new Error(`call ${name}: WebSocket 未连接`)
    const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : this.callTimeoutMs

    const echo = `dshqq-${++this._seq}`
    const payload = JSON.stringify({ action: name, params: params ?? {}, echo })
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(echo)
        reject(new Error(`call ${name} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
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

  /**
   * 拉一条历史消息的完整内容（引用解析用，2026-10-27）。
   *
   * 为什么需要：被引用原消息里的图片/视频/合并转发**不会**随当前消息一起下发，
   * 只给一个 reply 段 id。不主动 get_msg，模型就只看到「引用了一条消息」。
   *
   * 永不抛：超时/撤回/风控一律返回 `{ ok:false, reason }`，由调用方静默降级。
   * @param {string|number} messageId
   * @returns {Promise<{ok:boolean, reason?:string, messageId?:string, userId?:string,
   *   senderName?:string, text?:string, images?:Array<object>, videos?:Array<object>,
   *   quote?:{replyId:string,forwardIds:string[],inlineNodes:Array<object>}, raw?:object}>}
   */
  async getMessage(messageId) {
    const id = String(messageId ?? '').trim()
    if (!/^\d+$/u.test(id)) return { ok: false, reason: `非法的 message_id：${id.slice(0, 40)}` }
    try {
      const res = await this.call('get_msg', { message_id: Number(id) }, { timeoutMs: QUOTE_FETCH_TIMEOUT_MS })
      const data = res?.data && typeof res.data === 'object' ? res.data : null
      if (!data) return { ok: false, reason: `get_msg 返回空（retcode=${res?.retcode}）` }
      const raw = data.message ?? data.raw_message ?? ''
      const message = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? raw : [])
      const sender = data.sender && typeof data.sender === 'object' ? data.sender : {}
      // @ 昵称解析用消息所在群的缓存；私聊用 'u'（和 _parseMessageEvent 一致）。
      const scopeKey = data.group_id == null ? 'u' : String(data.group_id)
      return {
        ok: true,
        messageId: id,
        userId: String(data.user_id ?? sender.user_id ?? ''),
        senderName: String(sender.card || sender.nickname || ''),
        text: parseMessage(message, data.raw_message, {
          resolveAtName: (qq) => this._nameOf(scopeKey, qq),
        }).trim(),
        images: extractImagesFromMessage(raw),
        videos: extractVideosFromMessage(raw),
        quote: parseQuoteSegments(message),
        raw: data,
      }
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) }
    }
  }

  /**
   * 拉一条合并转发（聊天记录）的内容（2026-10-27）。
   *
   * 返回的节点已压成 `{ name, userId, text, images }`，拼接格式由 bridge 决定。
   * 同样永不抛：失败返回 `{ ok:false, nodes: [] }`。
   * @param {string} forwardId
   * @returns {Promise<{ok:boolean, reason?:string, nodes:Array<object>}>}
   */
  async getForwardMsg(forwardId) {
    const id = String(forwardId ?? '').trim()
    if (!id) return { ok: false, reason: '空的 forward_id', nodes: [] }
    try {
      const res = await this.call('get_forward_msg', { id }, { timeoutMs: QUOTE_FETCH_TIMEOUT_MS })
      const data = res?.data ?? res
      const list = Array.isArray(data?.messages) ? data.messages
        : Array.isArray(data?.message) ? data.message
          : Array.isArray(data) ? data
            : []
      const nodes = list.map((node) => normalizeForwardNode(node)).filter(Boolean)
      return { ok: true, nodes }
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error), nodes: [] }
    }
  }

  /**
   * 拉群历史消息（`get_group_msg_history`，NapCat 的 go-cqhttp 兼容动作，2026-10-28）。
   *
   * NapCat 侧语义（packages/napcat-onebot/action/go-cqhttp/GetGroupMsgHistory.ts）：
   *   · 不给 `message_seq` → `getAioFirstViewLatestMsgs(count)`，即**最近 count 条**；
   *   · 给 `message_seq` → 以该序号为起点往回拉 count 条；
   *   · 群号在 schema 里是 `Type.String`，必须按字符串传；
   *   · 空历史 / 序号不存在时**直接抛错**（`消息X不存在`），不是返回空列表。
   *
   * 返回的 `messages` 是完整 OB11 消息对象；**顺序不保证**，由调用方按时间重排。
   *
   * @param {string|number} groupId
   * @param {number} [count] 1..500
   * @param {{timeoutMs?:number, messageSeq?:string|number}} [opts]
   *   `messageSeq` 是**游标**：不传拿最新 count 条；传了就从该序号往前拉
   *   （v2.0 翻页拉取用，见 unread-summary 的 fetchHistoryPaged）。
   * @returns {Promise<{ok:boolean, messages:Array<object>, reason?:string}>}
   */
  async getGroupMsgHistory(groupId, count = 200, { timeoutMs = 15_000, messageSeq = '' } = {}) {
    const gid = String(groupId ?? '').trim()
    if (!/^\d+$/u.test(gid)) return { ok: false, messages: [], reason: `非法的群号：${gid.slice(0, 20)}` }
    const size = Math.min(500, Math.max(1, Math.trunc(Number(count) || 200)))
    const cursor = String(messageSeq ?? '').trim()
    // NapCat 的 schema 里 message_seq 是数字；空串表示「从最新开始」，绝不能传 ""。
    const seq = cursor !== '' && /^\d+$/u.test(cursor) ? Number(cursor) : undefined
    try {
      const res = await this.call('get_group_msg_history', {
        group_id: gid,
        count: size,
        ...(seq === undefined ? {} : { message_seq: seq }),
      }, { timeoutMs })
      if (res?.status && res.status !== 'ok') {
        return { ok: false, messages: [], reason: `retcode=${res?.retcode ?? '?'} ${res?.wording ?? ''}`.trim() }
      }
      const data = res?.data
      const list = Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : []
      return { ok: true, messages: list }
    } catch (error) {
      const message = error?.message ?? String(error)
      // 「没有消息」在这条动作里是抛错，不是空数组：不当失败处理。
      if (/不存在/u.test(message)) return { ok: true, messages: [] }
      return { ok: false, messages: [], reason: message }
    }
  }

  /**
   * 发群合并转发（`send_group_forward_msg`，2026-10-28）。
   *
   * 约束（NapCat `SendMsg.ts:138-142`）：一条消息里**只能全是 node**，
   * 混普通消息段会被直接拒；节点 schema 见 `OB11MessageNodeSchema`
   * （`nickname` 必填，`user_id` / `uin` 可省，`content` 是 OB11MessageMixType）。
   *
   * @param {string|number} groupId
   * @param {Array<object>} nodes buildForwardNodes() 的产物
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{ok:boolean, messageId?:string, reason?:string}>}
   */
  async sendGroupForward(groupId, nodes, { timeoutMs = 15_000 } = {}) {
    const gid = String(groupId ?? '').trim()
    if (!/^\d+$/u.test(gid)) return { ok: false, reason: `非法的群号：${gid.slice(0, 20)}` }
    if (!Array.isArray(nodes) || nodes.length === 0) return { ok: false, reason: '空的合并转发节点' }
    try {
      const res = await this.call('send_group_forward_msg', { group_id: gid, messages: nodes }, { timeoutMs })
      const retcode = res?.retcode === undefined ? null : Number(res.retcode)
      if (res?.status === 'failed' || (retcode !== null && retcode !== 0)) {
        const detail = res?.wording ?? res?.message ?? ''
        return { ok: false, reason: `retcode=${res?.retcode ?? '?'} ${detail}`.trim() }
      }
      const id = res?.data?.message_id ?? res?.data?.messageId
      return { ok: true, messageId: id === undefined ? undefined : String(id) }
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) }
    }
  }

  /** 私聊发送（自动分片，逐条，固定 sendIntervalMs 兜底）。 */
  async sendPrivate(userId, text, opts = {}) {
    return await this._sendText('private', userId, text, opts)
  }

  /**
   * 群发送（自动分片）。群聊可带发送者 @。
   * @param {string} groupId
   * @param {string} text
   * @param {object} [opts]
   * @param {string} [opts.atUserId] 要 @ 的 QQ 号（发送者）；不传则不 @
   * @param {'first'|'last'} [opts.atPosition='last'] 只在哪一片 @（一条回复可能多片，全 @ 会刷屏）
   * @param {string} [opts.replyTo] 要引用的原消息 `message_id`（群聊）；
   *   只挂在第一片，且排在 at 之前（NapCat 要求 reply 段在最前面）
   */
  async sendGroup(groupId, text, opts = {}) {
    // 总开关兜底：即使调用方传了 atUserId，groupAtReply=false 也一律不带 @。
    const at = this.groupAtReply ? opts : { ...opts, atUserId: undefined }
    return await this._sendText('group', groupId, text, at)
  }

  /**
   * 回戳（戳一戳，2026-10-26）。
   *
   * NapCat 的戳一戳 action 名声不统一，按「首选 + 兜底」两段打：
   *   · 群聊：`group_poke` `{group_id, user_id}` → 失败再试 `send_poke` `{user_id, group_id}`；
   *   · 私聊：`friend_poke` `{user_id}` → 失败再试 `send_poke` `{user_id}`。
   * 「失败」包括 retcode 非 0 / status 非 ok / 传输层抛错。**永不抛**：全部失败
   * 也返回对象，由桥接自己决定只 warn 还是提示（戳一戳失败不该影响主链路）。
   *
   * @param {'private'|'group'} kind
   * @param {string|number} target 群号（group）或对方 QQ 号（private）
   * @param {{userId?:string|number}} [opts] 被戳的人（回戳时就是戳你的人）
   * @returns {Promise<{ok:boolean, action:string, retcode:number|null, error?:string}>}
   */
  async sendPoke(kind, target, { userId } = {}) {
    const isGroup = kind === 'group'
    const targetId = String(target ?? '').trim()
    const poker = String(userId ?? (isGroup ? '' : targetId)).trim()
    if (!/^\d+$/u.test(targetId) || targetId === '0') {
      return {
        ok: false, action: '',
        error: `${isGroup ? 'group_id' : 'user_id'} 必须是正整数：${target}`,
        retcode: null,
      }
    }
    if (!/^\d+$/u.test(poker) || poker === '0') {
      return { ok: false, action: '', error: `user_id 必须是正整数：${userId}`, retcode: null }
    }

    // 首选按协议扩展分叉；兜底统一走 send_poke（部分实现只有这一个）。
    const attempts = isGroup
      ? [
        { action: 'group_poke', params: { group_id: Number(targetId), user_id: Number(poker) } },
        { action: 'send_poke', params: { user_id: Number(poker), group_id: Number(targetId) } },
      ]
      : [
        { action: 'friend_poke', params: { user_id: Number(poker) } },
        { action: 'send_poke', params: { user_id: Number(poker) } },
      ]

    const failures = []
    let lastRetcode = null
    let lastAction = ''
    for (const attempt of attempts) {
      lastAction = attempt.action
      try {
        const res = await this.call(attempt.action, attempt.params)
        const retcode = Number.isFinite(Number(res?.retcode)) ? Number(res.retcode) : null
        const ok = res?.status === 'ok' && retcode === 0
        if (ok) {
          this.log.info(`回戳成功（${attempt.action} ${isGroup ? `group:${targetId}` : `private:${targetId}`} → ${poker}）`)
          return { ok: true, action: attempt.action, retcode }
        }
        lastRetcode = retcode
        failures.push(`${attempt.action}: retcode=${res?.retcode} status=${res?.status}`)
        this.log.warn(`回戳被拒（${attempt.action}）：retcode=${res?.retcode} status=${res?.status}，尝试兜底 action`)
      } catch (err) {
        lastRetcode = null
        failures.push(`${attempt.action}: ${err?.message ?? String(err)}`)
        this.log.warn(`回戳异常（${attempt.action}）：${err?.message ?? err}，尝试兜底 action`)
      }
    }
    return { ok: false, action: lastAction, error: failures.join('；'), retcode: lastRetcode }
  }

  /**
   * 发一张图片 / 表情包（image 段，P2「发图片」技能）。
   *
   * `file` **原样**交给 NapCat：http(s) URL 由它自己下载；`base64://` / `file:///` /
   * 绝对路径也原样传（各版本接受度不一致，由调用方决定给哪种）。
   * 与文本发送完全解耦：不分片、不碰换行（图片没有换行语义）。
   *
   * 永不抛：传输层异常也转成 `{ok:false, status:'exception'}`，由上层写进 op 的
   * detail（模型能看到失败原因，而不是以为发出去了）。
   *
   * @param {'private'|'group'} kind
   * @param {string|number} targetId QQ 号 / 群号
   * @param {string} file 图片地址（url / file:/// / base64:// / 绝对路径）
   * @param {{atUserId?:string, subType?:0|1, position?:'before'|'after'}} [opts]
   *   群聊可带 @（发图片默认不 @，见 _applyImageOp）；
   *   `subType`：0=普通图片，1=表情（NapCat 按 `sub_type` 升成表情包，GIF 再补 summary）；
   *   `position`：只写进回执 detail 便于排障，不改变发送时机（见 p2-contract，避免引入队列等待）。
   * @returns {Promise<{ok:boolean, messageIds:string[], error?:string,
   *   retcode:number|null, status:string, via:'url'|'file'|'base64'|''}>}
   */
  async sendImage(kind, targetId, file, { atUserId, subType, position } = {}) {
    const id = String(targetId ?? '').trim()
    const ref = String(file ?? '').trim()
    const via = imageFileVia(ref)
    if (!/^\d+$/.test(id) || id === '0') {
      return {
        ok: false, messageIds: [],
        error: `${kind === 'private' ? 'user_id' : 'group_id'} 必须是正整数：${targetId}`,
        retcode: null, status: '', via,
      }
    }
    if (!ref) return { ok: false, messageIds: [], error: '图片内容为空', retcode: null, status: '', via }
    const message = []
    // 群聊 + 明确给了 atUserId 才带 @；桥接的 image op 固定不传（契约：群聊不带 @）。
    if (kind === 'group' && atUserId !== undefined && atUserId !== null
      && /^\d+$/.test(String(atUserId).trim())) {
      message.push({ type: 'at', data: { qq: String(atUserId).trim() } })
      message.push({ type: 'text', data: { text: ' ' } })
    }
    // sub_type 只在调用方明确给了 0/1 时下发：缺省保持老消息段形状，不改变既有行为。
    const hasSubType = subType === 0 || subType === 1
    const imageData = { file: ref, ...(hasSubType ? { sub_type: subType } : {}) }
    // 表情 + GIF 才补 summary：NapCat 认这个字段，静态图加了反而可能被当成表情包。
    if (subType === 1 && imageRefLooksGif(ref)) imageData.summary = '[动画表情]'
    message.push({ type: 'image', data: imageData })
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg'
    const params = kind === 'private' ? { user_id: Number(id), message } : { group_id: Number(id), message }
    try {
      const res = await this.call(action, params)
      const ok = res?.status === 'ok' && Number(res?.retcode) === 0
      const mid = res?.data?.message_id
      return {
        ok,
        messageIds: ok && mid !== undefined && mid !== null ? [String(mid)] : [],
        retcode: Number.isFinite(Number(res?.retcode)) ? Number(res.retcode) : null,
        status: String(res?.status ?? ''),
        via,
        ...(ok ? {} : { error: `retcode=${res?.retcode} status=${res?.status}` }),
      }
    } catch (error) {
      return {
        ok: false, messageIds: [], error: error?.message ?? String(error),
        retcode: null, status: 'exception', via,
      }
    }
  }

  /**
   * 发一条 QQ 语音（record 段，2026-10-23「发语音」技能）。
   *
   * 双通道（2026-10-24 真机加固）：
   *   ① 先 `base64://`（不落盘、不依赖桥接与 NapCat 共享文件系统）；
   *   ② base64 被拒且传了 `fallbackDir` 时，把 mp3 写到 `state/voice-<ts>.mp3`，
   *      改用 `file://` 绝对路径**重发一次**。NapCat 各版本对 base64 的接受度
   *      不一致，这个降级能把「合成成功但发不出去」救回来。
   *
   * 两种方式都失败时，两次的 retcode/status 原样带回，由上层写进 op 的 detail
   * （模型能看到失败原因，而不是以为发出去了）。
   *
   * @param {'private'|'group'} kind
   * @param {string|number} targetId QQ 号 / 群号
   * @param {string} base64 纯 base64（不带 data: 前缀），mp3 字节
   * @param {{atUserId?:string, fallbackDir?:string}} [opts]
   *   `fallbackDir`：允许落盘降级时的目录（通常是桥接的 state/）；不传则不降级
   * @returns {Promise<{ok:boolean, messageIds:string[], error?:string, bytes?:number,
   *   via?:'base64'|'file', retcode?:number|null, status?:string, file?:string}>}
   */
  async sendVoice(kind, targetId, base64, { atUserId, fallbackDir } = {}) {
    const id = String(targetId ?? '').trim()
    if (!/^\d+$/.test(id) || id === '0') {
      return { ok: false, messageIds: [], error: `${kind === 'private' ? 'user_id' : 'group_id'} 必须是正整数：${targetId}` }
    }
    const data = String(base64 ?? '').trim()
    if (!data) return { ok: false, messageIds: [], error: '语音内容为空' }

    /** 按给定 file 字段拼消息并发一次；永远 resolve（失败也带 retcode/status）。 */
    const attempt = async (file) => {
      const message = []
      if (kind === 'group' && atUserId !== undefined && /^\d+$/.test(String(atUserId).trim())) {
        message.push({ type: 'at', data: { qq: String(atUserId).trim() } })
        message.push({ type: 'text', data: { text: ' ' } })
      }
      message.push({ type: 'record', data: { file } })
      const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg'
      const params = kind === 'private' ? { user_id: Number(id), message } : { group_id: Number(id), message }
      try {
        const res = await this.call(action, params)
        const ok = res?.status === 'ok' && Number(res?.retcode) === 0
        const mid = res?.data?.message_id
        return {
          ok,
          messageIds: ok && mid !== undefined && mid !== null ? [String(mid)] : [],
          retcode: Number.isFinite(Number(res?.retcode)) ? Number(res.retcode) : null,
          status: String(res?.status ?? ''),
          ...(ok ? {} : { error: `retcode=${res?.retcode} status=${res?.status}` }),
        }
      } catch (error) {
        return { ok: false, messageIds: [], retcode: null, status: 'exception', error: error?.message ?? String(error) }
      }
    }

    const first = await attempt(`base64://${data}`)
    if (first.ok) {
      return {
        ok: true, messageIds: first.messageIds, bytes: data.length,
        via: 'base64', retcode: first.retcode, status: first.status,
      }
    }
    // 没给落盘目录（或 base64 本身非法）就如实返回第一次失败，不做降级。
    const dir = String(fallbackDir ?? '').trim()
    if (!dir) {
      return {
        ok: false, messageIds: [], error: first.error,
        retcode: first.retcode, status: first.status, via: 'base64',
      }
    }

    // 降级 ②：落盘 + file:// 重发一次。
    let filePath = ''
    try {
      fs.mkdirSync(dir, { recursive: true })
      filePath = path.join(dir, `voice-${Date.now()}.mp3`)
      fs.writeFileSync(filePath, Buffer.from(data, 'base64'))
    } catch (error) {
      return {
        ok: false, messageIds: [],
        error: `base64 发送失败（${first.error}）；落盘降级也失败：${error?.message ?? error}`,
        retcode: first.retcode, status: first.status, via: 'base64',
      }
    }
    // Windows 绝对路径 C:\a\b.mp3 → file:///C:/a/b.mp3（OneBot 的 file 上传协议）。
    const fileUrl = `file:///${path.resolve(filePath).replace(/\\/gu, '/')}`
    const second = await attempt(fileUrl)
    if (second.ok) {
      try { fs.unlinkSync(filePath) } catch { /* 删不掉不影响已经发出去了 */ }
      return {
        ok: true, messageIds: second.messageIds, bytes: data.length,
        via: 'file', retcode: second.retcode, status: second.status,
      }
    }
    // 两次都失败：保留临时文件供排查（日志里带路径），两次的 retcode 都带回去。
    return {
      ok: false, messageIds: [],
      error: `base64 发送失败（${first.error}）→ file:// 重发失败（${second.error}）`,
      retcode: second.retcode, firstRetcode: first.retcode,
      status: second.status, via: 'file', file: filePath,
    }
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
  _buildSegments(kind, text, { atUserId, atPosition, replyTo } = {}) {
    const needAt = kind === 'group'
      && atUserId !== undefined && atUserId !== null
      && /^\d+$/.test(String(atUserId).trim())
    // 引用回复（2026-10-27）：`reply` 段必须挂在**段数组最前面**（at 之前），
    // 否则 QQ 客户端认不出来；只对群聊生效（私聊没有「引用」这一说）。
    // id 用入站事件的 message_id 原值，NapCat 侧按它找回原消息。
    const replyId = kind === 'group' && replyTo !== undefined && replyTo !== null
      ? String(replyTo).trim()
      : ''
    if (!needAt && !replyId) return escapeCqText(text)
    // at 放文本**前面**：QQ 客户端里 @ 会高亮成「@昵称」，正文跟在其后读起来自然。
    // at 与正文之间必须有一个空格（2026-10-23 修）：OneBot 的 at 段本身不负责空白，
    // 两个段紧挨着渲染出来就是「@群友你好」，模型和群友都会看错。
    const body = escapeCqText(String(text ?? '').replace(/^[ \t]+/u, ''))
    const segments = []
    if (replyId) segments.push({ type: 'reply', data: { id: replyId } })
    if (needAt) segments.push({ type: 'at', data: { qq: String(atUserId).trim() } })
    segments.push({ type: 'text', data: { text: needAt ? ' ' + body : body } })
    return segments
  }

  /** 决定第 index 片是否要挂 @。 */
  _shouldAt(kind, index, total, atUserId, atPosition) {
    if (kind !== 'group') return false
    if (atUserId === undefined || atUserId === null || !/^\d+$/.test(String(atUserId).trim())) return false
    const pos = atPosition === 'first' ? 'first' : 'last'
    return pos === 'first' ? index === 0 : index === total - 1
  }

  async _sendText(kind, targetId, text, { atUserId, atPosition = 'last', replyTo, singleBubble = false } = {}) {
    const id = String(targetId ?? '').trim()
    if (!/^\d+$/.test(id) || id === '0') {
      return { ok: false, messageIds: [], error: `${kind === 'private' ? 'user_id' : 'group_id'} 必须是正整数：${targetId}` }
    }
    const body = String(text ?? '').trim()
    if (!body) return { ok: false, messageIds: [], error: '消息内容为空' }

    // 总开关关闭 / 调用方要求整条：不分片、不延时、整条合并发送
    //（审计仍在上游对全文做，顺序不变）。
    const chunks = (this.typingDelayEnabled && singleBubble !== true)
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
      // 引用也只挂**第一片**：分片回复后面几条纯文本，不然每个气泡都顶着一个引用很刷屏。
      const withReply = kind === 'group' && i === 0 && replyTo !== undefined && replyTo !== null
        && String(replyTo).trim() !== ''
        ? String(replyTo).trim()
        : ''
      const message = this._buildSegments(kind, chunks[i], {
        ...(withAt ? { atUserId, atPosition } : {}),
        ...(withReply ? { replyTo: withReply } : {}),
      })
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
          // 重试同一片不是「新气泡」，用原间隔，不吃 batchIntervalMs 的 2.5 秒。
          await sleep(this._baseGap(i, chunks))
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
   * 下一片之前的等待。
   *
   * 两段取**较大值**：
   *   ① 原值：打字延时开启时按分级延时（看上一片的码点数）；关闭时用 sendIntervalMs；
   *   ② `batchIntervalMs`（节奏批次间隔，来自热配置 rhythm.batchIntervalMs）：
   *      一轮回复拆成多个气泡时，相邻气泡的最小间隔。0 = 不限制（保持旧行为）。
   */
  _gapBefore(index, chunks) {
    const base = this._baseGap(index, chunks)
    return this.batchIntervalMs > 0 ? Math.max(base, this.batchIntervalMs) : base
  }

  /** 原间隔计算（不含批次间隔）：重试等待也用它，别把重试拖成 2.5 秒。 */
  _baseGap(index, chunks) {
    if (!this.typingDelayEnabled) return this.sendIntervalMs
    return typingDelayFor(charCount(chunks[index] ?? ''), Math.random, {
      charTiers: this.typingDelayCharTiers,
      msTiers: this.typingDelayMsTiers,
    })
  }

  /**
   * 记一个群成员/私聊对象的显示名，供 @ 解析用。
   * 只在消息事件里顺手记，不发额外请求。
   * @param {string} scopeKey 群号或 'u'
   * @param {string} qq
   * @param {string} name
   */
  _rememberName(scopeKey, qq, name) {
    const key = `${scopeKey}:${qq}`
    const value = String(name ?? '').trim()
    if (!value) return
    this._atNames.delete(key) // 重新插入到 Map 尾部，保持 LRU 顺序
    this._atNames.set(key, { name: value, at: Date.now() })
    while (this._atNames.size > this._atNamesCap) {
      this._atNames.delete(this._atNames.keys().next().value)
    }
  }

  /** 查群成员昵称；超过 30 分钟没说话就当未知（可能已改名/退群）。 */
  _nameOf(scopeKey, qq) {
    const hit = this._atNames.get(`${scopeKey}:${qq}`)
    if (!hit) return ''
    if (Date.now() - hit.at > 30 * 60 * 1000) {
      this._atNames.delete(`${scopeKey}:${qq}`)
      return ''
    }
    return hit.name
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

    // 通知事件（2026-10-26，戳一戳）：必须放在「非 message 直接 return」之前，
    // 否则 notice 全被吞掉。只认 notify/poke，其余交给 _dispatchNotice 静默。
    if (postType === 'notice') {
      this._dispatchNotice(packet)
      return
    }

    if (postType !== 'message') return // request 等事件暂不处理

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

  /**
   * notice 事件分发（2026-10-26，戳一戳）。
   *
   * 只认 `notice_type === 'notify' && sub_type === 'poke'`，其他通知只记 debug 并丢弃
   * —— 通知类事件绝不能抛错把消息主链路带崩（`_onRaw` 在 WS 回调里同步调用）。
   *
   * 字段容错（NapCat 各版本 / go-cqhttp 系实现不一致）：
   *   · 戳的人：`user_id`，老实现可能只给 `sender_id`；
   *   · 被戳的人：`target_id`，缺了就空串（桥接侧再判是不是自己）；
   *   · 机器人自己：`self_id`，缺了回落到 get_login_info 得到的 `_selfId`。
   * 自戳（`userId === selfId`）直接丢：NapCat 会把机器人自己的操作也回灌成事件。
   * @param {object} packet
   */
  _dispatchNotice(packet) {
    const noticeType = String(packet.notice_type ?? '')
    const subType = String(packet.sub_type ?? '')
    if (noticeType !== 'notify' || subType !== 'poke') {
      this.log.debug(`忽略通知事件：notice_type=${noticeType || '?'} sub_type=${subType || '?'}`)
      return
    }
    const userId = String(packet.user_id ?? packet.sender_id ?? '')
    const selfId = String(packet.self_id ?? this._selfId ?? '')
    if (!userId) {
      this.log.debug('戳一戳事件缺 user_id/sender_id，已忽略')
      return
    }
    if (selfId && userId === selfId) {
      this.log.debug(`自己戳自己已忽略（${userId}）`)
      return
    }
    const event = {
      kind: 'poke',
      userId,
      targetId: String(packet.target_id ?? ''),
      groupId: packet.group_id == null ? null : String(packet.group_id),
      selfId,
      time: Number.isFinite(Number(packet.time)) ? Number(packet.time) : null,
      raw: packet,
    }
    for (const handler of this._noticeHandlers) {
      try {
        const ret = handler(event)
        if (ret && typeof ret.then === 'function') {
          ret.catch((err) => this.log.error(`notice 处理器异常：${err?.message ?? err}`))
        }
      } catch (err) {
        this.log.error(`notice 处理器异常：${err?.message ?? err}`)
      }
    }
  }

  _parseMessageEvent(packet, kind) {
    const rawSender = packet.sender && typeof packet.sender === 'object' ? packet.sender : {}
    const userId = String(packet.user_id ?? rawSender.user_id ?? '')
    if (!userId) return null
    // 群成员昵称缓存：先记下当前发言人，parseMessage 解析 @ 时就能把
    // 「@1000000001」变成「@小明」。私聊用 'u' 作为作用域。
    const scopeKey = kind === 'group' ? String(packet.group_id ?? '') : 'u'
    const senderName = String(rawSender.card || rawSender.nickname || '')
    // 群成员身份（v2.0 第十步）：NapCat 的 sender.role 是 owner/admin/member。
    // 只在群聊里认；私聊一律空串，避免把好友当成群主。
    const roleRaw = String(rawSender.role ?? '').toLowerCase()
    const senderRole = kind === 'group' && (roleRaw === 'owner' || roleRaw === 'admin' || roleRaw === 'member')
      ? roleRaw
      : ''
    if (scopeKey) this._rememberName(scopeKey, userId, senderName)
    const message = packet.message
    return {
      kind,
      userId,
      groupId: kind === 'group' ? String(packet.group_id ?? '') || null : null,
      text: parseMessage(message, packet.raw_message, {
        resolveAtName: (qq) => this._nameOf(scopeKey, qq),
      }),
      // 图片段单独抽出来：text 里仍保留 [图片] 占位（审计/日志用），
      // 但桥接要拿 url 去下载，喂给支持多模态的模型（2026-10-23，任务 5）。
      // 用统一入口：NapCat 少数版本给的是 CQ 码字符串，只处理数组会丢图。
      images: extractImagesFromMessage(message),
      // 视频段同理（契约 §6）：桥接据 url 下载到 state/media/，追加本地路径给模型。
      videos: extractVideosFromMessage(message),
      // 引用 / 合并转发的标识（2026-10-27）：桥接拿 id 去 get_msg / get_forward_msg
      // 拉原文，把被引用的图片与聊天记录补进上下文。这里只抽 id，不发请求。
      quote: parseQuoteSegments(message),
      messageId: packet.message_id === undefined || packet.message_id === null ? '' : String(packet.message_id),
      senderName,
      // 群身份（owner/admin/member；私聊为空）。Prompt 里按它打前缀，模型才不会瞎认群主。
      senderRole,
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
