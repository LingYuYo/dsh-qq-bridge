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

// ── 结构化简报（v2.0 第二步，2026-10-28）─────────────────────────────────
//
// 目标：发到群里的合并转发不是流水账，而是「一条总览 + 每个话题一张卡片 + 一句免责」。
// 解析一律**先严后宽**：认得出结构化格式就走新排版，认不出就原样退回旧的 `---` 切分，
// 绝不让一次格式抽风把整次归纳搞挂。

/** 合并转发里所有 node 的发件人名字（结构化简报统一用它）。 */
export const SUMMARY_NODE_NAME = '群聊小助手'
/** 结构化简报的收尾句。 */
export const SUMMARY_FOOTER = '——由 AI 自动生成，仅供娱乐参考'
/** 手动提前截断留下的前情提要小节标题（注入 Prompt 时用，与生成端共用同一句）。 */
export const BRIEFING_HEADER = '【前情提要（更早对话的压缩版，仅供参考）】'
/** 简报最多几个话题（与 Prompt 里的「3-5 个」对齐）。 */
export const SUMMARY_MAX_TOPICS = 5
/** 话题标题行：`【标题】`，允许前面带 markdown 列表符。 */
const TOPIC_LINE_RE = /^\s*(?:[-*]\s*)?【([^】\n]{1,40})】\s*(.*)$/u
/** 话题里至少要有一行这种字段，才认定模型真的按格式写了。 */
const TOPIC_FIELD_RE = /(?:🕒|👥|📝|💬)/u
/** 模型自己加的免责句：剔掉，避免和我们的 footer 重复。 */
const MODEL_TAIL_RE = /^(?:—+\s*)?(?:由\s*AI\s*自动生成|仅供娱乐)/iu

// ── 「群聊管家」独立人设（v2.0 第三步，2026-10-28）────────────────────
//
// 临时会话会继承 qq-chat preset 的人设（林小鱼的暴躁/傲娇规则），
// 总结出来的东西会带口癖甚至拒答。这里给临时会话**单独推一份系统提示词**：
// 插件的人设 section 按 sessionId 取覆盖，优先级高于全局，会话归档后清掉。
// Prompt 里再追加一句同样的覆写，做双保险（有些模型对 user 末尾指令更敏感）。

/** 用户拍板的覆写句：必须原样出现在系统人设与 Prompt 尾部。 */
export const SUMMARY_OVERRIDE_NOTE = '[系统设定覆写：你现在的身份是“群聊管家”，一个专业、中立、客观的观察者。请忽略之前设定的所有暴躁/傲娇规则，用严谨、中立的语气客观总结群聊。]'

/** 临时会话专用的系统人设（替代 QQ 会话的傲娇人设）。 */
export const SUMMARY_PERSONA = [
  '你是「群聊管家」，一个专业、中立、客观的群聊观察者。',
  SUMMARY_OVERRIDE_NOTE,
  '',
  '工作准则：',
  '1. 只依据给出的聊天记录总结，不编造、不脑补、不评价记录本身。',
  '2. 语气中性克制；不使用辱骂、性暗示或人身攻击词汇，也不模仿群友的脏话（引用时同样要打码）。',
  '3. 不卖萌、不傲娇：不用「哼」「切」「才不是」「笨蛋」这类口癖，不在句尾加波浪号。',
  '4. 不拒绝总结；按用户要求输出结构化简报，话题之间不要重复。',
].join('\n')

/** 生殖器谩骂 / 常见脏话词表（只拦最脏的那一档，避免误伤正常用词）。 */
const PROFANITY_RE = /(傻逼|煞笔|沙比|臭逼|婊子|贱人|狗日的?|鸡巴|鸡吧|几把|屌毛|肏|操你|草你|日你|你妈的|妈的逼)/gu
/** 行首傲娇口癖：「哼，」「切、」「呸！」这类。 */
const TSUNDERE_HEAD_RE = /^(\s*)(?:哼+|切+|呸+|哈？)[\s，,、。.!！?？~～]*/u
/**
 * 行内口癖（带标点才认）：`切、` / `哼，` / `呸！`。
 *
 * 为什么要管行内：锐评那一行常写成 `💬 锐评/金句：切、又在熬夜`，
 * 口癖不在行首。带标点是必要条件，避免把「切割」「切换」这类正常词清掉。
 */
const TSUNDERE_INLINE_RE = /(?:哼|切|呸)[，,、。!！]/gu
/**
 * 「拒绝总结」的句式：只在**整段很短、且以拒绝语开头**时判定，
 * 避免把锐评里引用的「关我什么事」误杀成拒答。
 */
const REFUSAL_RE = /^(?:我拒绝|拒绝总结|不想总结|没什么好总结|恕不奉陪|不归我管|自己看记录)/u

/**
 * 输出侧的语气兜底（v2.0 第三步）。
 *
 * 为什么系统人设之外还要清洗：人设是软约束，模型偶尔还是会漏出一句脏话或口癖；
 * 而「总结里出现生殖器谩骂」是红线，不能靠概率。清洗规则故意保守：
 *   · 脏话 → `***`（不整段丢弃，避免一条词毁掉整个话题）；
 *   · 行首口癖 / 行尾波浪号 → 去掉；
 *   · 整段就是拒答 → 返回空串，由调用方按「没有可用内容」处理。
 *
 * @param {string} text
 * @returns {string} 清洗后的文本；空串 = 这段不该发
 */
export function sanitizeSummaryTone(text) {
  const source = String(text ?? '')
  if (source.trim() === '') return ''
  const trimmed = source.trim()
  if (trimmed.length <= 300 && REFUSAL_RE.test(trimmed)) return ''
  const masked = source.replace(PROFANITY_RE, '***')
  const noHead = masked
    .split('\n')
    .map((line) => line.replace(TSUNDERE_HEAD_RE, '$1'))
    .join('\n')
  const noInline = noHead.replace(TSUNDERE_INLINE_RE, '')
  const noTail = noInline
    .split('\n')
    .map((line) => line.replace(/[~～]+$/u, ''))
    .join('\n')
  return noTail.trim()
}

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

/** 时间窗上限：`/归纳 24h` 封顶，防止有人写 999h 把接口翻穿。 */
export const SUMMARY_TIME_LIMIT_MINUTES = 24 * 60
/**
 * `/归纳 [条数 | 时间窗]`。
 *
 * 两种写法都认：`/归纳 50`、`/归纳 1h`、`/归纳 30m`、`/归纳 2 小时`、`/归纳 30 分钟`。
 * 时间窗是给「机器人停机两小时、群里积压几百条」准备的：按条数只能取到最新几十条，
 * 按时间窗会一直翻页到起点（硬上限仍是 {@link SUMMARY_HARD_LIMIT}）。
 */
const SUMMARY_COMMANDS = /^\/(归纳|总结|未读|summary|unread)(?:\s+(\d{1,4})(?:\s*条)?|\s+(\d{1,3})\s*(h|小时|hours?|m|分钟|minutes?))?\s*$/iu

/**
 * 解析 `/归纳 [N | 1h]`。只认**整条消息就是指令**，后面带闲聊不算（避免误触发）。
 *
 * @param {string} text
 * @returns {{matched:boolean, count:number, windowMinutes:number}}
 *   count=0 表示用配置里的默认条数；windowMinutes=0 表示不是时间窗模式
 */
export function parseSummaryCommand(text) {
  const source = String(text ?? '').trim()
  if (!source.startsWith('/')) return { matched: false, count: 0, windowMinutes: 0 }
  const hit = SUMMARY_COMMANDS.exec(source)
  if (!hit) return { matched: false, count: 0, windowMinutes: 0 }
  const wanted = Number(hit[2] ?? 0)
  const windowRaw = Number(hit[3] ?? 0)
  const unit = String(hit[4] ?? '').toLowerCase()
  const isHour = unit === 'h' || unit === '小时' || unit.startsWith('hour')
  const count = Number.isFinite(wanted) && wanted > 0
    ? Math.min(SUMMARY_HARD_LIMIT, Math.trunc(wanted))
    : 0
  const windowMinutes = Number.isFinite(windowRaw) && windowRaw > 0
    ? Math.min(SUMMARY_TIME_LIMIT_MINUTES, Math.max(1, Math.trunc(windowRaw * (isHour ? 60 : 1))))
    : 0
  return { matched: true, count, windowMinutes }
}

/**
 * 消息去重键：优先 message_id，其次 message_seq，最后时间 + 正文前缀。
 * 翻页时相邻两页常常会重叠一条（接口按「起点那条」算），不去重会把它算两遍。
 */
function historyKey(raw) {
  const id = raw?.message_id
  if (id !== undefined && id !== null && String(id) !== '') return `id:${String(id)}`
  const seq = raw?.message_seq
  if (seq !== undefined && seq !== null && String(seq) !== '') return `seq:${String(seq)}`
  return `time:${Number(raw?.time) || 0}:${String(raw?.raw_message ?? '').slice(0, 40)}`
}

/** 排序 / 游标用的序号：message_seq 优先，退回 message_id。 */
function historySeq(raw) {
  return Number(raw?.message_seq ?? raw?.message_id) || 0
}

/**
 * 游标翻页拉群历史（v2.0 第四步，2026-10-28）。
 *
 * 为什么必须翻页：`get_group_msg_history` 一次只给一页（NapCat 上限 500）。
 * 机器人停机两小时、群里积压两三百条时，只拉一页会漏掉大量更早的消息，
 * 总结出来就成了「只说了最后几句」。
 *
 * 循环规则（对应用户要求，逐条可测）：
 *   ① 每次取回一页，找出**最早的一条**的 `message_seq` 作为下一页游标；
 *   ② 翻到「最早一条的 time < startTimeSec」或凑够 `limit` 条为止；
 *   ③ 空数组立刻 break（没有更早的消息）；
 *   ④ 游标必须推进：下一页游标为空或与当前相同 → break（接口忽略参数时防死循环）；
 *   ⑤ 结果统一按时间正序返回，超过 `limit` 只保留**最新**的那部分。
 *
 * 中途任何一页失败都整体返回 `ok:false`（调用方据此不推水位，下次还能补）。
 *
 * @param {object} options
 * @param {(cursor:string, count:number) => Promise<{ok:boolean, messages?:Array<object>, reason?:string}>} options.fetchPage
 * @param {number} [options.limit] 总条数硬上限（≤ 500）
 * @param {number} [options.startTimeSec] 时间窗起点（秒）；0 = 不限
 * @param {number} [options.pageSize] 单页条数（1..500）
 * @param {number} [options.maxPages] 页数防呆上限
 * @returns {Promise<{ok:boolean, messages:Array<object>, pages:number, reason:string}>}
 */
export async function fetchHistoryPaged({
  fetchPage,
  limit = SUMMARY_HARD_LIMIT,
  startTimeSec = 0,
  pageSize = 200,
  maxPages = 100,
} = {}) {
  if (typeof fetchPage !== 'function') {
    throw new TypeError('fetchHistoryPaged 需要 fetchPage(cursor, count)')
  }
  const cap = Math.min(SUMMARY_HARD_LIMIT, Math.max(1, Math.trunc(Number(limit) || SUMMARY_HARD_LIMIT)))
  const size = Math.min(500, Math.max(1, Math.trunc(Number(pageSize) || 200)))
  const floor = Math.max(0, Math.floor(Number(startTimeSec) || 0))
  const pagesCap = Math.max(1, Math.trunc(Number(maxPages) || 100))
  const seen = new Map()
  let cursor = ''
  let pages = 0
  while (pages < pagesCap) {
    if (seen.size >= cap) break
    const want = Math.min(size, cap - seen.size)
    pages += 1
    const res = await fetchPage(cursor, want)
    if (!res || res.ok === false) {
      return { ok: false, messages: [], pages, reason: res?.reason ?? '拉取群历史失败' }
    }
    const list = Array.isArray(res.messages) ? res.messages : []
    // ④ 空页：没有更早的消息（或已经翻到头），立刻退出，绝不空转。
    if (list.length === 0) break
    let oldest = null
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      seen.set(historyKey(raw), raw)
      const time = Number(raw.time) || 0
      const seq = historySeq(raw)
      if (!oldest || time < oldest.time || (time === oldest.time && seq < oldest.seq)) {
        oldest = { time, seq }
      }
    }
    // ② 已经翻到时间窗起点之前：更早的页不用再拉。
    if (floor > 0 && oldest && oldest.time > 0 && oldest.time < floor) break
    // ① 下一页游标 = 本页最早一条的 message_seq。
    const next = oldest && oldest.seq > 0 ? String(oldest.seq) : ''
    // ④ 游标没推进（空 / 与当前相同）→ 立刻退出，防死循环。
    if (next === '' || next === cursor) break
    cursor = next
  }
  const messages = [...seen.values()].sort((left, right) => {
    const byTime = (Number(left.time) || 0) - (Number(right.time) || 0)
    return byTime !== 0 ? byTime : historySeq(left) - historySeq(right)
  })
  // ⑤ 反序拉到的数据统一排序成正序；超上限时保留最新的一段。
  return { ok: true, messages: messages.slice(-cap), pages, reason: '' }
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
 * 从 DSH 的原始会话事件里提取「真实对话」（v2.0 第九步，2026-10-28）。
 *
 * 为什么需要它：手动提前截断不能只靠桥接内存的 `_chatLog`（1 小时窗口，
 * 很可能已经空了）。DSH 的 `session/follow` 快照能拿到整段会话事件，
 * 这里把 user/message 与 assistant/message 压成纯文本对话，作为提要的底料。
 *
 * 过滤规则：
 *   · user/message 只收 `source.kind === 'user'`（真人发的）；
 *     `runtime-context` / `agent-instructions` / 工具结果都是系统注入，不能进提要；
 *   · assistant/message 只取 text 块，reasoning 与 tool-call 跳过；
 *   · 每条截断 2000 字，最终取最近 limit 条（正序）。
 *
 * @param {Array<object>} events DSH 事件数组（含 type / seq / time / data）
 * @param {{limit?:number}} [options]
 * @returns {Array<{role:'user'|'assistant', text:string, at:number}>} 时间正序
 */
export function conversationFromEvents(events, { limit = 50 } = {}) {
  const list = Array.isArray(events) ? events : []
  const takeText = (content) => (Array.isArray(content) ? content : [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter((text) => text !== '')
    .join('\n')
    .slice(0, 2000)
  const out = []
  for (const event of list) {
    if (!event || typeof event !== 'object') continue
    const time = Number(event.time)
    // time 可能是秒也可能是毫秒：> 1e12 按毫秒，否则按秒。
    const at = Number.isFinite(time) && time > 0
      ? (time > 1e12 ? Math.floor(time) : Math.floor(time * 1000))
      : 0
    if (event.type === 'user/message') {
      const kind = typeof event.data?.source?.kind === 'string' ? event.data.source.kind : ''
      if (kind !== '' && kind !== 'user') continue
      const text = takeText(event.data?.content)
      if (text !== '') out.push({ role: 'user', text, at })
      continue
    }
    if (event.type === 'assistant/message') {
      const text = takeText(event.data?.message?.content)
      if (text !== '') out.push({ role: 'assistant', text, at })
    }
  }
  const cap = Math.max(1, Math.trunc(Number(limit) || 50))
  return out.slice(-cap)
}

/**
 * 把 DSH 历史与桥接 L1 合并成一份提要底料（v2.0 第九步）。
 *
 * 同一条消息往往两边都有（L1 是最近 1 小时的镜像），按「正文前 40 字」去重：
 * DSH 在前（更早）、L1 在后（更新），重复时**保留 L1**（它带昵称与真实时间）。
 *
 * @param {Array<{text:string, at?:number, name?:string, qq?:string}>} dshItems
 * @param {Array<{text:string, at?:number, name?:string, qq?:string}>} l1Items
 * @param {{limit?:number}} [options]
 * @returns {Array<object>} 时间正序、去重后的条目
 */
export function mergeBriefingHistory(dshItems, l1Items, { limit = 60 } = {}) {
  const norm = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim()
  const keyOf = (item) => norm(item?.text).slice(0, 40)
  const merged = new Map()
  for (const item of Array.isArray(dshItems) ? dshItems : []) {
    const key = keyOf(item)
    if (key === '') continue
    merged.set(key, { ...item, text: norm(item.text), at: Number(item.at) || 0 })
  }
  // L1 覆盖同文条目：昵称 / 时间更准。
  for (const item of Array.isArray(l1Items) ? l1Items : []) {
    const key = keyOf(item)
    if (key === '') continue
    merged.set(key, { ...item, text: norm(item.text), at: Number(item.at) || 0 })
  }
  const list = [...merged.values()].sort((left, right) => (left.at || 0) - (right.at || 0))
  const cap = Math.max(1, Math.trunc(Number(limit) || 60))
  return list.slice(-cap)
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
 * 输出必须是**结构化简报**（总览 + 若干【话题】卡片），这样合并转发才能一条话题一张卡。
 * 为什么不用 JSON：廉价模型对 JSON 的稳定性差；而「标题 + emoji 字段」这种格式即使
 * 被写歪一点，也能靠宽松解析兜住，最差退回旧的整段切分。
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
  // 头部 + 尾部各占一条 node，剩下才是话题；最少 1 个、最多 5 个。
  const topics = Math.max(1, Math.min(SUMMARY_MAX_TOPICS, nodes - 2))
  return [
    '你是一个专业的群聊管家。请阅读以下群聊记录，提取核心信息并输出一份高密度的简报。要求：',
    '',
    '1. 先写一句总览（如：XXX条消息，群内氛围热烈，主要涉及XX话题）。',
    '2. 提取最多 3-5 个核心话题，每个话题严格按以下格式输出（必须换行）：',
    '【话题标题】（如：Apex排位组队）',
    '🕒 时间：XX:XX - XX:XX',
    '👥 参与人：群友A、群友B',
    '📝 总结：（30字以内概括聊了什么、结论是什么）',
    '💬 锐评/金句：（挑一句好玩的话，或者用一句话吐槽）',
    '',
    '【补充约束】记录里没说的不要编；时间、人名一律照记录写，拿不准就写「不确定」。',
    includeImages
      ? '随消息附了图片，只写你能确认的画面内容；看不清就别猜。'
      : '记录里的图片只有占位，不要描述图片内容。',
    `每个话题连同四行信息控制在 ${chars} 字以内，最多 ${topics} 个话题。`,
    '',
    '请只输出上述文本，不要包含任何多余的 Markdown 符号（如 **、# 等）。',
    '',
    `【群】${groupName || '（未命名群）'}`,
    `【消息条数】${total}`,
    '',
    '【聊天记录】',
    transcript,
    '',
    // 双保险：系统人设已经换成管家，这里再压一句覆写（部分模型对末尾指令更敏感）。
    SUMMARY_OVERRIDE_NOTE,
  ].join('\n')
}

/**
 * 拼「前情提要」提示词（手动提前截断用，v2.0 第五步）。
 *
 * 与未读归纳的区别：那份是发给全群的「话题简报」，这份是留给**下一条消息**接续用的
 * 压缩记忆，所以要有约定 / 待办 / 人物称呼，不要话题卡和时间线。
 *
 * @param {{groupName?:string, total?:number, transcript:string}} input
 * @returns {string}
 */
export function buildBriefingPrompt({ groupName = '', total = 0, transcript = '' } = {}) {
  return [
    '你是「群聊管家」。请把下面这段聊天记录压缩成一份**前情提要**，供之后接续对话使用。',
    '',
    '要求：',
    '1. 250~400 字，分 3~6 点，每点用「· 」起头；不要写标题、不要用 Markdown。',
    '2. 保留：正在聊什么、已经定下的事 / 约定、待办与时间、人物关系与称呼。',
    '3. 不逐条复述，不编造记录里没有的内容；拿不准就写「不确定」。',
    '4. 不评价记录本身，不写「以上」「综上」这类套话，也不要加免责声明。',
    '',
    `【群】${groupName || '（未命名群）'}`,
    `【消息条数】${total}`,
    '',
    '【聊天记录】',
    transcript,
  ].join('\n')
}

/** 模型回复的通用清洗：去掉代码围栏、加粗、标题符号。 */function cleanModelText(reply) {
  return String(reply ?? '')
    .replace(/^```[a-z]*\s*/iu, '')
    .replace(/```\s*$/u, '')
    .replace(/\*\*/gu, '')
    .replace(/^#{1,6}\s*/gmu, '')
    .trim()
}

/**
 * 把模型的「结构化简报」解析成总览 + 话题数组。
 *
 * 判定标准（任一不满足就算没按格式写 → 返回 null，由调用方降级）：
 *   · 至少有一个 `【标题】` 行；
 *   · 至少一个话题里出现 🕒 / 👥 / 📝 / 💬 之一（否则只是把废话加了几个括号）。
 *
 * @param {string} reply
 * @returns {{overview:string, topics:Array<{title:string, body:string}>}|null}
 */
export function parseStructuredSummary(reply) {
  const body = cleanModelText(reply)
  if (body === '') return null
  const lines = body.split(/\r?\n/u)
  const overviewLines = []
  const topics = []
  let current = null
  for (const line of lines) {
    const hit = TOPIC_LINE_RE.exec(line)
    if (hit) {
      current = { title: String(hit[1]).trim(), lines: [] }
      const inline = String(hit[2] ?? '').trim()
      if (inline !== '') current.lines.push(inline)
      topics.push(current)
      continue
    }
    if (current) current.lines.push(line)
    else overviewLines.push(line)
  }
  if (topics.length === 0) return null
  const dropTail = (list) => list.filter((line) => !MODEL_TAIL_RE.test(String(line).trim()))
  const overview = dropTail(overviewLines).join('\n').trim()
  const cleanedTopics = topics.map((topic) => ({
    title: topic.title,
    body: dropTail(topic.lines).join('\n').replace(/\n{3,}/gu, '\n\n').trim(),
  })).filter((topic) => topic.title !== '')
  if (cleanedTopics.length === 0) return null
  if (!cleanedTopics.some((topic) => TOPIC_FIELD_RE.test(topic.body))) return null
  return { overview, topics: cleanedTopics }
}

/** `2026-10-28`（本地时区）。 */
function formatDayLabel(ms) {
  const date = new Date(Number(ms) || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 结构化简报 → 合并转发的 node 文本。
 *
 * 排版约定：
 *   ① 头部：`📋 群聊总结报告 · 群名 · 日期` + 总览；
 *   ② 每个话题一条：`【标题】` + 四行字段；
 *   ③ 尾部：{@link SUMMARY_FOOTER}。
 * `maxNodes` 装不下时把多余话题并进最后一条（和旧切分同一条原则：宁可啰嗦别丢话题）。
 *
 * @param {string} reply
 * @param {{groupName?:string, date?:string|number, maxNodes?:number, nodeChars?:number}} [options]
 * @returns {string[]|null} null = 不是结构化格式（调用方走旧切分）
 */
export function buildStructuredSummaryNodes(reply, {
  groupName = '',
  date = '',
  maxNodes = DEFAULT_SUMMARY.maxNodes,
  nodeChars = DEFAULT_SUMMARY.nodeChars,
} = {}) {
  const parsed = parseStructuredSummary(reply)
  if (!parsed || parsed.topics.length === 0) return null
  const cap = Math.max(1, Math.trunc(Number(maxNodes) || DEFAULT_SUMMARY.maxNodes))
  // 头部 + 1 话题 + 尾部 = 3；比这还小就说明配置不适合结构化，老实走旧切分。
  if (cap < 3) return null
  const chars = Math.max(50, Math.trunc(Number(nodeChars) || DEFAULT_SUMMARY.nodeChars))
  const allowed = Math.max(1, Math.min(SUMMARY_MAX_TOPICS, cap - 2, parsed.topics.length))
  const kept = parsed.topics.slice(0, allowed)
  const overflow = parsed.topics.slice(allowed)
  const topicTexts = kept.map((topic) => `【${topic.title}】${topic.body ? `\n${topic.body}` : ''}`)
  if (overflow.length > 0 && topicTexts.length > 0) {
    const extra = overflow.map((topic) => `【${topic.title}】${topic.body ? `\n${topic.body}` : ''}`).join('\n\n')
    topicTexts[topicTexts.length - 1] = `${topicTexts[topicTexts.length - 1]}\n\n${extra}`
  }
  const day = String(date ?? '').trim() || formatDayLabel(Date.now())
  const title = groupName ? `${groupName} · ${day}` : day
  const overview = parsed.overview || `本段时间共整理出 ${parsed.topics.length} 个话题。`
  const header = clampByTokens(`📋 群聊总结报告 · ${title}\n\n${overview}`, chars)
  const body = topicTexts.map((text) => clampByTokens(text, chars))
  return [header, ...body, SUMMARY_FOOTER]
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
 * 入参两种形态：
 *   · **字符串**（生产路径）：先按「结构化简报」切（头部 / 每话题一条 / 尾部）；
 *     认不出结构化格式就原样退回旧的 `---` 切分，绝不报错。
 *   · **字符串数组**（旧调用 / 测试）：原样一条一段，兼容既有行为。
 *
 * NapCat 的节点 schema（`packages/napcat-onebot/types/message.ts` 的
 * `OB11MessageNodeSchema`）：`{type:'node', data:{nickname, user_id?, content}}`，
 * 且整条消息**只能全是 node**，混普通段会被拒。
 *
 * @param {string|string[]} input
 * @param {{botName?:string, botUin?:string, groupName?:string, date?:string|number,
 *   maxNodes?:number, nodeChars?:number}} [options]
 * @returns {Array<object>}
 */
export function buildForwardNodes(input, {
  botName = '',
  botUin = '',
  groupName = '',
  date = '',
  maxNodes = DEFAULT_SUMMARY.maxNodes,
  nodeChars = DEFAULT_SUMMARY.nodeChars,
} = {}) {
  const name = String(botName ?? '').trim() || '群聊归纳'
  const uin = String(botUin ?? '').trim()
  let texts
  if (Array.isArray(input)) {
    texts = input.map((text) => String(text ?? '').trim()).filter(Boolean)
  } else {
    const raw = String(input ?? '').trim()
    if (raw === '') return []
    const structured = buildStructuredSummaryNodes(raw, { groupName, date, maxNodes, nodeChars })
    texts = structured ?? splitSummaryNodes(raw, { maxNodes, nodeChars })
  }
  // 输出侧语气兜底：脏话打码、口癖清掉、整段拒答丢弃（见 sanitizeSummaryTone）。
  texts = texts.map((text) => sanitizeSummaryTone(text)).filter((text) => text !== '')
  return texts
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

/** 从 node 里取回纯文本（审计 / 纯文本降级用）。 */
export function forwardNodeText(node) {
  const content = node?.data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((seg) => seg && seg.type === 'text')
    .map((seg) => String(seg.data?.text ?? ''))
    .join('')
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
