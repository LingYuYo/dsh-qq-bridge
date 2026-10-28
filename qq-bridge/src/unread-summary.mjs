/**
 * 智能未读归纳（v2.0 第一步）的纯函数层。
 *
 * 职责边界：
 *   · 这里只做**字符串与数组**的活：命令解析、水位筛选、转写、提示词、节点切分；
 *   · 网络（拉历史 / 发合并转发）、状态（lastSummarySeq 落盘）、会话与模型调度
 *     都在 bridge.mjs 与 onebot.mjs，方便离线测试。
 *
 * 设计约束（与仓库红线一致）：
 *   · 零外部依赖，只用 Node 内置能力；
 *   · 归纳是**旁路**：它不往 QQ 会话的 prompt 里塞任何东西，也不改全局模型；
 *   · 任何一步失败都不往上抛英文错误，只返回可读结果或抛带 code 的中文错误。
 */

import { cqToText, extractImagesFromMessage, parseMessage } from './onebot.mjs'
import { estimateTokens } from './tokens.mjs'

/** 一次归纳最多拉多少条历史（NapCat 侧 count 的硬上限，防止一次请求把内存打满）。 */
export const SUMMARY_HARD_LIMIT = 500

/** 默认参数（设置页「未读归纳」卡片的齿轮里可改）。 */
export const DEFAULT_SUMMARY = Object.freeze({
  enabled: true,
  /** 默认不检索图片：大多数廉价模型不吃图，硬塞只会白花 token。 */
  includeImages: false,
  maxMessages: 200,
  maxImages: 4,
  budgetTokens: 24000,
  perMessageChars: 300,
  maxNodes: 6,
  nodeChars: 400,
  timeoutMs: 150000,
  notifyOwners: true,
  notifyCooldownMs: 3600000,
  /** 留空 = 跟随 DSH 全局默认模型。 */
  provider: '',
  model: '',
})

/** 提示词骨架（说明文字 + 群名 + 时间范围）大概占掉的 token，预算里先扣掉。 */
export const PROMPT_OVERHEAD_TOKENS = 320

const clampInt = (value, fallback, min, max) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(num)))
}

/**
 * 归一化「未读归纳」配置。非法值一律退回默认，宁可保守也不要静默改成别的语义。
 *
 * @param {unknown} source
 * @returns {typeof DEFAULT_SUMMARY}
 */
export function normalizeSummary(source) {
  const raw = source && typeof source === 'object' && !Array.isArray(source) ? source : {}
  return {
    enabled: raw.enabled !== false,
    includeImages: raw.includeImages === true,
    maxMessages: clampInt(raw.maxMessages, DEFAULT_SUMMARY.maxMessages, 10, SUMMARY_HARD_LIMIT),
    maxImages: clampInt(raw.maxImages, DEFAULT_SUMMARY.maxImages, 0, 10),
    budgetTokens: clampInt(raw.budgetTokens, DEFAULT_SUMMARY.budgetTokens, 2000, 200000),
    perMessageChars: clampInt(raw.perMessageChars, DEFAULT_SUMMARY.perMessageChars, 20, 2000),
    maxNodes: clampInt(raw.maxNodes, DEFAULT_SUMMARY.maxNodes, 1, 20),
    nodeChars: clampInt(raw.nodeChars, DEFAULT_SUMMARY.nodeChars, 50, 2000),
    timeoutMs: clampInt(raw.timeoutMs, DEFAULT_SUMMARY.timeoutMs, 5000, 600000),
    notifyOwners: raw.notifyOwners !== false,
    notifyCooldownMs: clampInt(raw.notifyCooldownMs, DEFAULT_SUMMARY.notifyCooldownMs, 60000, 86400000),
    provider: String(raw.provider ?? '').trim(),
    model: String(raw.model ?? '').trim(),
  }
}

const SUMMARY_COMMANDS = /^\/(归纳|总结|未读|summary|unread)(?:\s+(\d{1,4}))?\s*$/iu

/**
 * 解析 `/归纳 [N]`。只认**整条消息就是指令**，后面带闲聊不算（避免误触发）。
 *
 * @param {string} text
 * @returns {{matched:boolean, count:number}} count=0 表示用配置里的默认条数
 */
export function parseSummaryCommand(text) {
  const source = String(text ?? '').trim()
  if (!source.startsWith('/')) return { matched: false, count: 0 }
  const hit = SUMMARY_COMMANDS.exec(source)
  if (!hit) return { matched: false, count: 0 }
  const wanted = Number(hit[2] ?? 0)
  const count = Number.isFinite(wanted) && wanted > 0
    ? Math.min(SUMMARY_HARD_LIMIT, Math.trunc(wanted))
    : 0
  return { matched: true, count }
}

/**
 * 把 `get_group_msg_history` 返回的一条裸消息压成统一结构。
 *
 * 为什么要兼容两种形态：NapCat 的 `message` 可能是消息段数组（本项目
 * `messagePostFormat: 'array'`），也可能是 CQ 码字符串（部分版本/转发节点）。
 * 只处理数组会把图片 URL 整个丢掉（2026-10-27 真机踩过一模一样的坑）。
 *
 * @param {object} raw OneBot v11 消息对象
 * @param {{selfId?:string}} [options]
 * @returns {{id:string, seq:number, time:number, userId:string, name:string, text:string,
 *   images:Array<object>, isSelf:boolean}|null}
 */
export function normalizeHistoryMessage(raw, { selfId = '' } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const id = raw.message_id === undefined || raw.message_id === null ? '' : String(raw.message_id)
  if (!id) return null
  const message = Array.isArray(raw.message) ? raw.message : []
  let text = ''
  try {
    text = message.length > 0
      ? String(parseMessage(message, raw.raw_message ?? '') ?? '').trim()
      : cqToText(raw.raw_message ?? '').trim()
  } catch {
    text = cqToText(raw.raw_message ?? '').trim()
  }
  // 注意：extractImagesFromMessage 只认「消息段数组」或「CQ 码字符串」，
  // 直接丢整个 raw 对象进去会拿到空数组（真机上就是这么丢图的）。
  const imageSource = message.length > 0 ? message : (raw.raw_message ?? '')
  const images = (() => {
    try { return extractImagesFromMessage(imageSource) } catch { return [] }
  })()
  if (!text && images.length === 0) return null
  const sender = raw.sender && typeof raw.sender === 'object' ? raw.sender : {}
  const userId = String(raw.user_id ?? sender.user_id ?? '').trim()
  const name = String(sender.card || sender.nickname || userId || '某人').trim()
  const seq = Number(String(id).replace(/\D/gu, '')) || 0
  return {
    id,
    seq,
    time: Number(raw.time) || 0,
    userId,
    name,
    text,
    images,
    isSelf: selfId !== '' && userId === String(selfId),
  }
}

/**
 * 按水位挑出「上次归纳之后」的消息。
 *
 * 水位是 `(lastSummaryAt, lastSummarySeq)` 二元组：先用时间比，时间相同再比序号。
 * 为什么不用纯序号：`message_id` 是 NapCat 进程内合成的唯一号，重启进程后可能重排，
 * 只存序号会在重启后把整段历史判成「全是新的」。时间戳来自 QQ 服务端，跨重启稳定。
 *
 * @param {Array<object>} rawMessages
 * @param {{lastSeq?:number, lastAt?:number, maxMessages?:number, selfId?:string}} [options]
 * @returns {Array<object>} 时间升序（最早的在前）
 */
export function pickUnread(rawMessages, { lastSeq = 0, lastAt = 0, maxMessages = 200, selfId = '' } = {}) {
  const list = (Array.isArray(rawMessages) ? rawMessages : [])
    .map((raw) => normalizeHistoryMessage(raw, { selfId }))
    .filter(Boolean)
  const seqFloor = Number(lastSeq) || 0
  const atFloor = Number(lastAt) || 0
  const afterFloor = (item) => {
    if (!atFloor && !seqFloor) return true
    if (item.time > atFloor) return true
    if (item.time < atFloor) return false
    return item.seq > seqFloor
  }
  const picked = list.filter(afterFloor)
  // 历史接口的顺序不保证（有的版本给最新在前），一律按时间 + 序号重排。
  picked.sort((a, b) => (a.time - b.time) || (a.seq - b.seq))
  const cap = Math.max(1, Math.trunc(Number(maxMessages) || DEFAULT_SUMMARY.maxMessages))
  return picked.slice(-cap)
}

/**
 * 把消息压成给模型看的转写文本。
 *
 * 预算从**最新**往回算，超了就不再往前加（和「记忆与上下文」的截断方向一致：
 * 宁可丢最老的闲聊，也不要丢刚刚的上下文）。
 *
 * @param {Array<object>} messages `pickUnread` 的结果（时间升序）
 * @param {{perMessageChars?:number, budgetTokens?:number, selfLabel?:string}} [options]
 * @returns {{text:string, kept:number, dropped:number, tokens:number}}
 */
export function formatTranscript(messages, {
  perMessageChars = DEFAULT_SUMMARY.perMessageChars,
  budgetTokens = DEFAULT_SUMMARY.budgetTokens,
  selfLabel = '你',
} = {}) {
  const list = Array.isArray(messages) ? messages : []
  const budget = Math.max(200, (Number(budgetTokens) || DEFAULT_SUMMARY.budgetTokens) - PROMPT_OVERHEAD_TOKENS)
  const perChar = Math.max(20, Math.trunc(Number(perMessageChars) || DEFAULT_SUMMARY.perMessageChars))
  const lines = []
  let used = 0
  let dropped = 0
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]
    const body = String(item.text ?? '').replace(/\s*\n\s*/gu, ' ').slice(0, perChar)
    const who = item.isSelf ? `${selfLabel}(${item.name})` : `${item.name}(${item.userId || '?'})`
    const stamp = formatStamp(item.time)
    const line = `[${stamp}] ${who}: ${body}${body.length >= perChar ? '…' : ''}`
    const cost = estimateTokens(line)
    if (used + cost > budget) {
      dropped = i + 1
      break
    }
    lines.push(line)
    used += cost
  }
  lines.reverse()
  const header = dropped > 0 ? [`（更早的 ${dropped} 条因预算省略）`] : []
  return {
    text: [...header, ...lines].join('\n'),
    kept: lines.length,
    dropped,
    tokens: used,
  }
}

/** `10-28 11:20`；拿不到时间就写「未知时间」。 */
function formatStamp(seconds) {
  const value = Number(seconds) || 0
  if (value <= 0) return '未知时间'
  const date = new Date(value * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 拼归纳用的提示词。
 *
 * 要求模型输出「多段、`---` 分隔」而不是 JSON：廉价模型对 JSON 的稳定性差，
 * 而分隔符解析失败时还能退化成单段纯文本，不会一个字都发不出去。
 *
 * @param {{groupName?:string, total?:number, transcript:string,
 *   nodeChars?:number, maxNodes?:number, includeImages?:boolean}} input
 * @returns {string}
 */
export function buildSummaryPrompt({
  groupName = '',
  total = 0,
  transcript = '',
  nodeChars = DEFAULT_SUMMARY.nodeChars,
  maxNodes = DEFAULT_SUMMARY.maxNodes,
  includeImages = false,
} = {}) {
  const nodes = Math.max(1, Math.trunc(Number(maxNodes) || DEFAULT_SUMMARY.maxNodes))
  const chars = Math.max(50, Math.trunc(Number(nodeChars) || DEFAULT_SUMMARY.nodeChars))
  return [
    '你是一个群聊记录整理员。下面是一段 QQ 群里的聊天记录，请把它归纳成可以直接发回群里的「聊天记录摘要」。',
    '',
    '输出要求（必须遵守）：',
    `1. 分成 1~${nodes} 段，段与段之间单独一行写 \`---\`。`,
    '2. 第一段用一两句话写这段时间的主线（大家在聊什么、有没有结论）。',
    '3. 后面按话题分段，每段一件事；有人名就用记录里的名字，别改。',
    `4. 每段不超过 ${chars} 字，像群友说话，不要写「首先/其次/综上」。`,
    '5. 不要逐条复述，不要加序号、不要加 Markdown、不要输出思考过程。',
    '6. 记录里没说的事不要编；拿不准就用「好像」「不确定」。',
    includeImages ? '7. 随消息附了图片，只写你能确认的画面内容；看不清就别猜。' : '7. 记录里的图片只有占位，不要描述图片内容。',
    '',
    `【群】${groupName || '（未命名群）'}`,
    `【消息条数】${total}`,
    '',
    '【聊天记录】',
    transcript,
  ].join('\n')
}

/** 按显示宽度截断（用 token 估，CJK 1 字 1 token，非 CJK 约 0.3）。 */
function clampByTokens(text, limit) {
  const source = String(text ?? '')
  const budget = Math.max(1, Math.trunc(Number(limit) || 1))
  if (estimateTokens(source) <= budget) return source
  let left = budget - 1
  let out = ''
  for (const ch of source) {
    const cost = estimateTokens(ch)
    if (cost > left) break
    out += ch
    left -= cost
  }
  return `${out}…`
}

/**
 * 把模型回复切成合并转发的节点文本。
 *
 * 解析顺序（先严后宽，任何一步成功就停）：
 *   ① JSON 数组（模型偶尔会自觉得很）；
 *   ② 单独的 `---` 分隔行；
 *   ③ 整段当一条。
 * 每段再按 `nodeChars` 截断，超出 `maxNodes` 的并进最后一段（不让信息静默消失）。
 *
 * @param {string} reply
 * @param {{maxNodes?:number, nodeChars?:number}} [options]
 * @returns {string[]} 空数组 = 没有任何可用内容
 */
export function splitSummaryNodes(reply, { maxNodes = DEFAULT_SUMMARY.maxNodes, nodeChars = DEFAULT_SUMMARY.nodeChars } = {}) {
  const raw = String(reply ?? '').trim()
  if (!raw) return []
  const body = raw
    .replace(/^```(?:json|markdown|md)?\s*/iu, '')
    .replace(/```$/u, '')
    .trim()
  let pieces = []
  if (body.startsWith('[')) {
    try {
      const parsed = JSON.parse(body)
      if (Array.isArray(parsed)) pieces = parsed.map((item) => String(item ?? ''))
    } catch { /* 解析失败就走分隔符 */ }
  }
  if (pieces.length === 0) {
    pieces = body.split(/\n\s*-{3,}\s*\n|\n\s*= {3,}\s*\n|\n\s*={3,}\s*\n/u)
    // 单行分隔的情况（模型写成 `内容 --- 内容`）也认，但不吃正文里的破折号。
    if (pieces.length === 1 && /\n\s*-{3,}\s*$/mu.test(body)) pieces = body.split(/\n\s*-{3,}\s*\n?/u)
  }
  const cleaned = pieces
    .map((item) => String(item ?? '').replace(/^\s*-{3,}\s*/gmu, '').trim())
    .filter((item) => item !== '' && item !== '---')
    .map((item) => clampByTokens(item, nodeChars))
  if (cleaned.length === 0) return []
  const cap = Math.max(1, Math.trunc(Number(maxNodes) || DEFAULT_SUMMARY.maxNodes))
  if (cleaned.length <= cap) return cleaned
  // 段数超了：前 cap-1 段原样，剩下的并进最后一段（宁可啰嗦也别丢话题）。
  const head = cleaned.slice(0, cap - 1)
  const tail = cleaned.slice(cap - 1).join(' ')
  return [...head, tail]
}

/**
 * 组 `send_group_forward_msg` 的 nodes。
 *
 * NapCat 的节点 schema（`packages/napcat-onebot/types/message.ts` 的
 * `OB11MessageNodeSchema`）：`{type:'node', data:{nickname, user_id?, content}}`，
 * 且整条消息**只能全是 node**，混普通段会被拒。
 *
 * @param {string[]} nodes
 * @param {{botName?:string, botUin?:string}} [options]
 * @returns {Array<object>}
 */
export function buildForwardNodes(nodes, { botName = '', botUin = '' } = {}) {
  const name = String(botName ?? '').trim() || '群聊归纳'
  const uin = String(botUin ?? '').trim()
  return (Array.isArray(nodes) ? nodes : [])
    .map((text) => String(text ?? '').trim())
    .filter(Boolean)
    .map((text) => ({
      type: 'node',
      data: {
        nickname: name,
        ...(uin ? { user_id: uin } : {}),
        content: [{ type: 'text', data: { text } }],
      },
    }))
}

/**
 * 算新的水位。只在**成功发出**之后调用，失败不推进（下次还能补上）。
 *
 * @param {Array<object>} messages 已归一化的消息
 * @param {{lastSummarySeq?:number, lastSummaryAt?:number}} [prev]
 * @returns {{lastSummarySeq:number, lastSummaryAt:number}}
 */
export function nextWatermark(messages, prev = {}) {
  let seq = Number(prev.lastSummarySeq) || 0
  let at = Number(prev.lastSummaryAt) || 0
  for (const item of Array.isArray(messages) ? messages : []) {
    const time = Number(item?.time) || 0
    const id = Number(item?.seq) || 0
    if (time > at || (time === at && id > seq)) {
      at = time
      seq = id
    }
  }
  return { lastSummarySeq: seq, lastSummaryAt: at }
}
