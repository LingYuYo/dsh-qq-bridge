/**
 * 真实用量统计（Host 侧）——「数据与用量」面板的唯一数据源。
 *
 * ## 为什么必须在 Host 进程内拦
 *
 * DSH 没有「带用量的 turn 结束事件」：`turn/end` 只有 `{ turn, reason }`。
 * 真实用量在持久会话事件 `assistant/message.data.usage` 里（重试那次还要看
 * `assistant/attempt.data.stream` 里最后一个 usage chunk）。这些事件在 Host 进程内
 * 通过 `ctx.on('session/event', (session, event) => …)` 就能收到，且是**提交后的
 * 持久事件**——不需要再开一条 WS（`session/follow` 是给远程客户端的），也不需要
 * 自己解多帧 zstd 日志。
 *
 * 数据流：
 *
 *   session/event ──► UsageStatsStore.ingest ──► usage-stats.json（原子写）
 *                                                     │
 *                                       GET /dsh-qq-guard/usage
 *                                                     │
 *                                                面板轮询渲染
 *
 * ## 统计口径（与 DSH token-meter 对齐）
 *
 * - `inputTokens` 是**未命中缓存的输入**；prompt 总量 = input + cacheRead + cacheWrite。
 * - `reasoningTokens` 已包含在 `outputTokens` 里（pi-ai 的 mapUsage 注释写明
 *   reasoning folded into output），只做展示，不重复加进总量。
 * - `assistant/message` = 一次成功的模型调用；`assistant/attempt` = 一次失败/重试的
 *   调用。两者都计「调用次数」，也都可能产生真实费用（上游已经算过 token）。
 * - cache 字段可能缺席（pi-ai 只在非 0 时写），缺席按 0 处理，不伪造。
 *
 * ## 去重（重启 / 回填 / 在线监听三方不重复计）
 *
 * 每个会话记两个水位：
 *   · `liveSeq`      —— 在线监听已经处理到的事件序号（连续）；
 *   · `backfillSeq`  —— 历史回填已经处理到的事件序号（从 0 起连续）。
 *   · `firstLiveSeq` —— 本进程第一次在线收到事件时的 seq；它之前的事件属于「历史」，
 *                       交给回填；它之后的事件由在线监听负责。
 *
 * 回填只读 `[backfillSeq + 1, firstLiveSeq)`；在线监听只处理 seq > liveSeq 的事件。
 * 回填期间在线事件先入内存队列，回填结束后再按 live 模式重放（同一轮事件循环里
 * 同步完成，不会和新的在线事件交错）。这样无论「先回填再收事件」还是「先收事件
 * 再回填」，都不会重复计数。
 *
 * ## 为什么自己维护价目表
 *
 * `token-meter` 只算 token，DSH 里没有任何 `provider/model → 单价` 的元数据。
 * 货币成本由面板配置（Config.usagePricing，单位：元 / 百万 token）在这里估算；
 * 没配单价的路由成本返回 `null`，面板显示「—」，绝不填 0 假装免费。
 */

import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 面板读用量走这条只读路由。 */
export const USAGE_ROUTE_PATH = '/dsh-qq-guard/usage'
/** 手动触发历史回填（POST）。插件启动后会自动跑一次，这条路由只是兜底。 */
export const USAGE_BACKFILL_ROUTE_PATH = '/dsh-qq-guard/usage/backfill'
/** 统计文件：与桥接的 sessions.json 同目录（state/ 已被仓库 ignore）。 */
export const USAGE_FILE_NAME = 'usage-stats.json'
/** 存储格式版本：结构不兼容时整体重来，不做猜测式迁移。v3 = 多段 + 工作日/节假日。 */
export const USAGE_VERSION = 3
export const USAGE_DEFAULT_DAYS = 7
export const USAGE_MAX_DAYS = 90
/** 保留多少天的明细（够面板看趋势即可，别让文件无限长）。 */
export const USAGE_DEFAULT_KEEP_DAYS = 120

/** 落盘防抖：一轮对话可能连续来十几条事件，攒一下再写。 */
const SAVE_DEBOUNCE_MS = 1500
/** bridge config/state 的刷新间隔：每条消息都 stat 两次文件太浪费。 */
const SCOPE_REFRESH_MS = 2000

/* ════════════════════════════════════════════════════════════════
 * 小工具
 * ════════════════════════════════════════════════════════════════ */

const asInt = (value) => (Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0)
const round1 = (value) => Math.round(value * 10) / 10
const round4 = (value) => Math.round(value * 10000) / 10000

function mtimeOf(file) {
  try { return statSync(file).mtimeMs } catch { return -1 }
}

/** Windows 路径大小写不敏感，比较前统一；其它平台保持原样。 */
function normPath(value) {
  if (typeof value !== 'string' || value === '') return ''
  try {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  } catch {
    return ''
  }
}

/** 本地时区的 YYYY-MM-DD（面板按人看的日历天，不是 UTC）。 */
export function dayKeyOf(ms) {
  const date = new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 一个计数桶：调用次数 + 各 token 分项。 */
export function zeroUsage() {
  return { calls: 0, noUsage: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

/** 面板口径的「总 token」：输入 + 输出 + 缓存读写；reasoning 不重复计。 */
export function totalTokenCount(bucket) {
  if (!bucket || typeof bucket !== 'object') return 0
  return asInt(bucket.input) + asInt(bucket.output)
    + asInt(bucket.cacheRead) + asInt(bucket.cacheWrite)
}

/** 把一个桶的计数字段累加进另一个桶（忽略 calls 之外的非数值字段）。 */
function addInto(target, source) {
  if (!target || !source || typeof source !== 'object') return target
  for (const field of ['calls', 'noUsage', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
    target[field] = asInt(target[field]) + asInt(source[field])
  }
  return target
}

/** 记一次模型调用；usage 为 null 时只计调用次数（上游没报用量）。 */
function addEvent(bucket, usage) {
  bucket.calls = asInt(bucket.calls) + 1
  if (!usage) {
    bucket.noUsage = asInt(bucket.noUsage) + 1
    return
  }
  bucket.input = asInt(bucket.input) + asInt(usage.input)
  bucket.output = asInt(bucket.output) + asInt(usage.output)
  bucket.cacheRead = asInt(bucket.cacheRead) + asInt(usage.cacheRead)
  bucket.cacheWrite = asInt(bucket.cacheWrite) + asInt(usage.cacheWrite)
  bucket.reasoning = asInt(bucket.reasoning) + asInt(usage.reasoning)
}

/**
 * 把事件里的 `TokenUsage` 归一成内部字段。
 *
 * 字段名是 DSH 的 `inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens /
 * reasoningTokens`；**没有** promptTokens / completionTokens / cacheHitTokens。
 * @param {unknown} raw
 * @returns {{input:number,output:number,cacheRead:number,cacheWrite:number,reasoning:number}|null}
 */
export function pickUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    input: asInt(raw.inputTokens),
    output: asInt(raw.outputTokens),
    cacheRead: asInt(raw.cacheReadTokens),
    cacheWrite: asInt(raw.cacheWriteTokens),
    reasoning: asInt(raw.reasoningTokens),
  }
}

/**
 * 从 assistant 事件内嵌的 compact stream 里找最后一个 usage chunk。
 *
 * `assistant/attempt` 没有 `data.usage`，用量只藏在 stream 里；格式是
 * `{ type:'chunk', chunk:{ type:'usage', usage } }`（流式 chunk 的紧凑记录）。
 */
export function usageFromStream(stream) {
  if (!Array.isArray(stream)) return null
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i]
    const chunk = record?.chunk ?? record
    if (chunk?.type === 'usage' && chunk.usage) return pickUsage(chunk.usage)
  }
  return null
}

/** 事件里能拿到的真实路由（assistant message 的 source 最准，fallback 后也正确）。 */
function routeFromEvent(event) {
  if (event?.type === 'assistant/message') {
    const source = event.data?.message?.source
    if (source?.provider && source?.model) return { provider: String(source.provider), model: String(source.model) }
  }
  if (event?.type === 'request/header') {
    const config = event.data?.header?.config
    if (config?.provider && config?.model) return { provider: String(config.provider), model: String(config.model) }
  }
  if (event?.type === 'model/selection') {
    const selection = event.data
    if (selection?.provider && selection?.model) return { provider: String(selection.provider), model: String(selection.model) }
  }
  return null
}

function routeKeyOf(route) {
  if (!route || typeof route !== 'object') return ''
  const provider = typeof route.provider === 'string' ? route.provider.trim() : ''
  const model = typeof route.model === 'string' ? route.model.trim() : ''
  if (!provider || !model) return ''
  return `${provider}/${model}`
}

/** 路由 key 反解；provider 里一般不含 `/`，按第一个 `/` 切。 */
export function parseRouteKey(key) {
  const text = typeof key === 'string' ? key : ''
  const index = text.indexOf('/')
  if (index <= 0) return { provider: text, model: '' }
  return { provider: text.slice(0, index), model: text.slice(index + 1) }
}

/* ════════════════════════════════════════════════════════════════
 * 峰谷时段（Peak / Off-Peak）
 * ════════════════════════════════════════════════════════════════ */

/** 默认忙时：08:30 ~ 次日 00:30（跨午夜）。 */
export const DEFAULT_PEAK_HOURS = '08:30-00:30'
/** 默认时区：与用户本机一致（UTC+8）。 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

const dayFormatters = new Map()
const minuteFormatters = new Map()

function dayFormatter(timeZone) {
  let formatter = dayFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    })
    dayFormatters.set(timeZone, formatter)
  }
  return formatter
}

function minuteFormatter(timeZone) {
  let formatter = minuteFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
    minuteFormatters.set(timeZone, formatter)
  }
  return formatter
}

/**
 * 按指定时区取 YYYY-MM-DD；时区非法/Intl 不支持时退回进程本地时区。
 * @param {number} ms
 * @param {string} [timeZone]
 */
export function zonedDayKey(ms, timeZone = DEFAULT_TIMEZONE) {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : Date.now()
  try {
    const parts = dayFormatter(timeZone).formatToParts(new Date(safeMs))
    const year = parts.find((p) => p.type === 'year')?.value
    const month = parts.find((p) => p.type === 'month')?.value
    const day = parts.find((p) => p.type === 'day')?.value
    if (year && month && day) return `${year}-${month}-${day}`
  } catch { /* 非法时区：退回本地 */ }
  return dayKeyOf(safeMs)
}

/**
 * 按指定时区取「当天第几分钟」（0..1439）；Intl 失败时退回本地时区。
 * @param {number} ms
 * @param {string} [timeZone]
 */
export function zonedMinuteOfDay(ms, timeZone = DEFAULT_TIMEZONE) {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : Date.now()
  try {
    const parts = minuteFormatter(timeZone).formatToParts(new Date(safeMs))
    const hour = Number(parts.find((p) => p.type === 'hour')?.value)
    const minute = Number(parts.find((p) => p.type === 'minute')?.value)
    if (Number.isFinite(hour) && Number.isFinite(minute)) return ((hour % 24) * 60 + minute)
  } catch { /* 非法时区：退回本地 */ }
  const date = new Date(safeMs)
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * 按指定时区取星期几（0 = 周日 … 6 = 周六）。
 * 只关心那一天是星期几，用该时区的日历日期构造本地 Date 取 getDay 即可。
 */
export function zonedWeekday(ms, timeZone = DEFAULT_TIMEZONE) {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : Date.now()
  try {
    const parts = dayFormatter(timeZone).formatToParts(new Date(safeMs))
    const year = Number(parts.find((p) => p.type === 'year')?.value)
    const month = Number(parts.find((p) => p.type === 'month')?.value)
    const day = Number(parts.find((p) => p.type === 'day')?.value)
    if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
      return new Date(year, month - 1, day).getDay()
    }
  } catch { /* 非法时区：退回本地 */ }
  return new Date(safeMs).getDay()
}

/**
 * 解析单段 `HH:MM-HH:MM`。
 *
 * 语义：左闭右开；start > end 表示跨午夜（默认 08:30-00:30 就是跨的）；
 * start === end 视为全天忙时。格式非法返回 null。
 * @param {unknown} raw
 * @returns {{start:number,end:number}|null}
 */
export function parsePeakHours(raw) {
  if (typeof raw !== 'string') return null
  const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(raw)
  if (!match) return null
  const startHour = Number(match[1])
  const startMinute = Number(match[2])
  const endHour = Number(match[3])
  const endMinute = Number(match[4])
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return null
  return { start: startHour * 60 + startMinute, end: endHour * 60 + endMinute }
}

/**
 * 解析多段时段：逗号分隔，例如 `09:00-12:00, 14:00-18:00`。
 * 非法段直接跳过；一段都不合法返回 null（调用方按「全天忙时」兜底，避免低估成本）。
 * @param {unknown} raw
 * @returns {Array<{start:number,end:number}>|null}
 */
export function parsePeakWindows(raw) {
  if (typeof raw !== 'string') return null
  const windows = []
  for (const segment of raw.split(',')) {
    const window = parsePeakHours(segment)
    if (window) windows.push(window)
  }
  return windows.length > 0 ? windows : null
}

/**
 * 某个「当天第几分钟」是否落在任一段忙时窗口内。
 * 兼容传单段对象（旧调用方）与窗口数组。
 */
export function isPeakMinute(minute, windows) {
  if (!windows) return true // 配置坏了按忙时算，避免把成本低估
  const list = Array.isArray(windows) ? windows : [windows]
  if (list.length === 0) return true
  const value = Number.isFinite(minute) ? minute : 0
  return list.some(({ start, end }) => {
    if (start === end) return true
    return start < end
      ? (value >= start && value < end)
      : (value >= start || value < end)
  })
}

/** 规范化 holidays.json 里的日期（只接受 YYYY-MM-DD）。 */
export function normalizeDateKey(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
}

/** 同目录下的节假日/调休表默认路径。 */
export const DEFAULT_HOLIDAYS_FILE = path.join(HERE, 'holidays.json')

/* ════════════════════════════════════════════════════════════════
 * 价目表（忙时 / 闲时两套）
 * ════════════════════════════════════════════════════════════════ */

function zeroRates() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function ratesOf(raw) {
  const rate = (value) => Math.max(0, Number(value) || 0)
  return {
    input: rate(raw?.input),
    output: rate(raw?.output),
    cacheRead: rate(raw?.cacheRead),
    cacheWrite: rate(raw?.cacheWrite),
  }
}

/** 一组费率是否「已配置」（四项全 0 = 没配）。 */
export function ratesPriced(rates) {
  if (!rates) return false
  return rates.input > 0 || rates.output > 0 || rates.cacheRead > 0 || rates.cacheWrite > 0
}

/**
 * 把 Config.usagePricing 归一成稳定规则数组。
 *
 * v2 结构：`{ provider, model, peak:{input,output,cacheRead,cacheWrite}, offPeak:{...} }`。
 * 兼容旧版扁平结构（`{ provider, model, input, output, ... }`）：旧字段同时套到
 * peak / offPeak 两套，避免升级后历史配置直接变成「未配置」。
 * 单位统一为「元 / 百万 token」。
 */
export function normalizePricingRules(raw) {
  if (!Array.isArray(raw)) return []
  const rules = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
    if (!provider) continue
    const legacyFlat = ['input', 'output', 'cacheRead', 'cacheWrite']
      .some((field) => Number(entry[field]) > 0)
    const legacyRates = legacyFlat ? ratesOf(entry) : null
    const peakNested = entry.peak && typeof entry.peak === 'object' ? ratesOf(entry.peak) : null
    const offPeakNested = entry.offPeak && typeof entry.offPeak === 'object' ? ratesOf(entry.offPeak) : null
    // 新 Schema 会把缺失的 peak/offPeak 补成全 0 对象，所以不能只看「有没有对象」，
    // 要看里面有没有非 0 费率；没有就回落到旧版扁平字段（同时套到两套）。
    const peak = ratesPriced(peakNested) ? peakNested : (legacyRates ?? peakNested ?? zeroRates())
    const offPeak = ratesPriced(offPeakNested) ? offPeakNested : (legacyRates ?? offPeakNested ?? zeroRates())
    rules.push({
      provider,
      model: typeof entry.model === 'string' ? entry.model.trim() : '',
      peak,
      offPeak,
    })
  }
  return rules
}

function ruleIsPriced(rule) {
  return ratesPriced(rule?.peak) || ratesPriced(rule?.offPeak)
}

/**
 * 找某条路由的单价：先精确匹配 provider+model，再退到 provider 级（model 留空或 `*`）。
 * 两套费率全 0 / 没配返回 null（面板显示「—」，不假装免费）。
 */
export function priceOf(rules, provider, model) {
  if (!Array.isArray(rules) || rules.length === 0) return null
  let exact
  let wildcard
  for (const rule of rules) {
    if (rule.provider !== provider) continue
    if (rule.model === model && rule.model !== '') exact = exact ?? rule
    else if (rule.model === '' || rule.model === '*') wildcard = wildcard ?? rule
  }
  const hit = exact ?? wildcard
  return hit && ruleIsPriced(hit) ? hit : null
}

/** 一个桶在给定单价下的估算成本（元）。 */
export function costOfBucket(bucket, price) {
  if (!bucket || !price) return null
  return (
    asInt(bucket.input) * price.input
    + asInt(bucket.output) * price.output
    + asInt(bucket.cacheRead) * price.cacheRead
    + asInt(bucket.cacheWrite) * price.cacheWrite
  ) / 1_000_000
}

/**
 * 一个模型桶（含 peak / offPeak 两份明细）按峰谷两套费率算成本。
 * 只要配置了任意一套费率就返回数字；两套都没配返回 null。
 */
export function costOfModelBucket(bucket, rule) {
  if (!bucket || !rule) return null
  let total = 0
  let priced = false
  if (ratesPriced(rule.peak)) {
    total += costOfBucket(bucket.peak, rule.peak) ?? 0
    priced = true
  }
  if (ratesPriced(rule.offPeak)) {
    total += costOfBucket(bucket.offPeak, rule.offPeak) ?? 0
    priced = true
  }
  return priced ? total : null
}

/* ════════════════════════════════════════════════════════════════
 * 统计范围（QQ 工作区）
 * ════════════════════════════════════════════════════════════════ */

/**
 * 判定「哪些会话算 QQ 会话」。
 *
 * 依据两条，命中任一即可：
 *   1. 会话 cwd == 桥接 config.json 的 `dsh.sessionCwd`（历史归档会话也能覆盖到）；
 *   2. 会话 id 出现在桥接 `state/sessions.json` 的映射里（cwd 读不到时兜底）。
 *
 * 子代理会话（`origin === 'subagent'`）一律排除：它们继承 cwd，但不是 QQ 对话本身。
 */
export class UsageScope {
  /**
   * @param {object} options
   * @param {(() => string)|string} options.bridgeDir qq-bridge 目录（支持动态读取）
   * @param {{warn?: Function}} [options.logger]
   */
  constructor({ bridgeDir, logger = console } = {}) {
    this.bridgeDir = bridgeDir
    this.logger = logger
    this.sessionCwd = ''
    this.sessionCwdKey = ''
    /** @type {Map<string, string>} sessionId → 'u:<QQ>' / 'g:<群号>' */
    this.sessionMap = new Map()
    this.refreshedAt = 0
    this._configMtime = -1
    this._stateMtime = -1
  }

  /** 桥接目录（绝对路径）；取不到返回空串。 */
  dir() {
    try {
      const value = typeof this.bridgeDir === 'function' ? this.bridgeDir() : this.bridgeDir
      return typeof value === 'string' && value.trim() ? path.resolve(value.trim()) : ''
    } catch {
      return ''
    }
  }

  /** 读 bridge config.json / state/sessions.json（按 mtime 缓存，2 秒最多一次）。 */
  refresh(force = false) {
    const now = Date.now()
    if (!force && now - this.refreshedAt < SCOPE_REFRESH_MS) return
    this.refreshedAt = now
    const dir = this.dir()
    if (!dir) return

    const configPath = path.join(dir, 'config.json')
    const configMtime = mtimeOf(configPath)
    if (force || configMtime !== this._configMtime) {
      this._configMtime = configMtime
      let cwd = ''
      try {
        const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
        cwd = typeof parsed?.dsh?.sessionCwd === 'string' ? parsed.dsh.sessionCwd : ''
      } catch { /* 没有 config.json：还没初始化，按空处理 */ }
      this.sessionCwd = cwd
      this.sessionCwdKey = normPath(cwd)
    }

    const statePath = path.join(dir, 'state', 'sessions.json')
    const stateMtime = mtimeOf(statePath)
    if (force || stateMtime !== this._stateMtime) {
      this._stateMtime = stateMtime
      const map = new Map()
      try {
        const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
        for (const [key, sessionId] of Object.entries(parsed?.sessions ?? {})) {
          if (typeof sessionId === 'string' && sessionId) map.set(sessionId, key)
        }
      } catch { /* 还没建过会话：映射为空 */ }
      this.sessionMap = map
    }
  }

  /** 当前映射里的 QQ 会话数。 */
  size() {
    this.refresh()
    return this.sessionMap.size
  }

  /** sessionId → QQ key（'u:<QQ>' / 'g:<群号>'），没有返回 undefined。 */
  keyOf(sessionId) {
    this.refresh()
    return this.sessionMap.get(sessionId)
  }

  /**
   * @param {string} sessionId
   * @param {unknown} cwd 会话 header 里的 cwd
   * @param {unknown} origin 会话 header 里的 origin（'subagent' 排除）
   * @returns {boolean}
   */
  isTarget(sessionId, cwd, origin) {
    if (origin === 'subagent') return false
    this.refresh()
    const cwdKey = normPath(typeof cwd === 'string' ? cwd : '')
    if (cwdKey && this.sessionCwdKey && cwdKey === this.sessionCwdKey) return true
    return typeof sessionId === 'string' && this.sessionMap.has(sessionId)
  }
}

/* ════════════════════════════════════════════════════════════════
 * 存储与聚合
 * ════════════════════════════════════════════════════════════════ */

function emptyState() {
  return { version: USAGE_VERSION, updatedAt: 0, periodSignature: '', days: {}, sessions: {} }
}

function sessionBucket() {
  return { ...zeroUsage(), models: {} }
}

/** 模型桶：总量 + 忙时 / 闲时两份明细（成本按两份分别计价）。 */
function zeroModelBucket() {
  return { ...zeroUsage(), peak: zeroUsage(), offPeak: zeroUsage() }
}

/** 把源模型桶累加进目标模型桶（含 peak / offPeak 明细）。 */
function addModelInto(target, source) {
  addInto(target, source)
  for (const period of ['peak', 'offPeak']) {
    target[period] ??= zeroUsage()
    addInto(target[period], source?.[period])
  }
  return target
}

function normalizeModelBucket(raw) {
  const bucket = zeroModelBucket()
  if (!raw || typeof raw !== 'object') return bucket
  bucket.calls = asInt(raw.calls)
  bucket.noUsage = asInt(raw.noUsage)
  bucket.input = asInt(raw.input)
  bucket.output = asInt(raw.output)
  bucket.cacheRead = asInt(raw.cacheRead)
  bucket.cacheWrite = asInt(raw.cacheWrite)
  bucket.reasoning = asInt(raw.reasoning)
  for (const period of ['peak', 'offPeak']) {
    const source = raw[period]
    if (!source || typeof source !== 'object') continue
    bucket[period].calls = asInt(source.calls)
    bucket[period].input = asInt(source.input)
    bucket[period].output = asInt(source.output)
    bucket[period].cacheRead = asInt(source.cacheRead)
    bucket[period].cacheWrite = asInt(source.cacheWrite)
    bucket[period].reasoning = asInt(source.reasoning)
  }
  return bucket
}

function normalizeState(raw) {
  const state = emptyState()
  if (!raw || typeof raw !== 'object') return state
  state.updatedAt = asInt(raw.updatedAt)
  state.periodSignature = typeof raw.periodSignature === 'string' ? raw.periodSignature : ''
  for (const [day, value] of Object.entries(raw.days ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !value || typeof value !== 'object') continue
    const dayBucket = { turns: {}, sessions: {} }
    for (const [kind, count] of Object.entries(value.turns ?? {})) {
      const n = asInt(count)
      if (n > 0) dayBucket.turns[String(kind)] = n
    }
    for (const [sessionId, session] of Object.entries(value.sessions ?? {})) {
      if (!session || typeof session !== 'object') continue
      const bucket = sessionBucket()
      addInto(bucket, session)
      for (const [route, modelBucket] of Object.entries(session.models ?? {})) {
        if (!modelBucket || typeof modelBucket !== 'object') continue
        bucket.models[String(route)] = normalizeModelBucket(modelBucket)
      }
      dayBucket.sessions[String(sessionId)] = bucket
    }
    state.days[day] = dayBucket
  }
  for (const [sessionId, meta] of Object.entries(raw.sessions ?? {})) {
    if (!meta || typeof meta !== 'object') continue
    state.sessions[String(sessionId)] = {
      backfillSeq: Number.isSafeInteger(meta.backfillSeq) ? meta.backfillSeq : -1,
      firstLiveSeq: Number.isSafeInteger(meta.firstLiveSeq) ? meta.firstLiveSeq : null,
      liveSeq: Number.isSafeInteger(meta.liveSeq) ? meta.liveSeq : -1,
      historyComplete: meta.historyComplete === true,
      firstAt: asInt(meta.firstAt),
      lastAt: asInt(meta.lastAt),
      qqKey: typeof meta.qqKey === 'string' ? meta.qqKey : '',
      kind: typeof meta.kind === 'string' ? meta.kind : '',
    }
  }
  return state
}

function kindOfKey(key) {
  if (typeof key !== 'string' || key === '') return '会话'
  if (key.startsWith('u:')) return '私聊'
  if (key.startsWith('g:')) return '群聊'
  return '会话'
}

function qqOfKey(key) {
  return typeof key === 'string' && /^[ug]:/.test(key) ? key.slice(2) : ''
}

export class UsageStatsStore {
  /**
   * @param {object} options
   * @param {(() => string)|string} options.file usage-stats.json 路径（支持动态读取）
   * @param {() => unknown} [options.getPricing] 读 Config.usagePricing
   * @param {UsageScope} [options.scope]
   * @param {{warn?: Function, info?: Function}} [options.logger]
   * @param {() => number} [options.now]
   * @param {number} [options.keepDays]
   * @param {() => unknown} [options.getPeakHours] 读 Config.peakHours（如 "08:30-00:30"）
   * @param {() => unknown} [options.getTimezone] 读 Config.timezone（如 "Asia/Shanghai"）
   */
  constructor({
    file,
    getPricing = () => [],
    getPeakHours = () => DEFAULT_PEAK_HOURS,
    getTimezone = () => DEFAULT_TIMEZONE,
    scope = null,
    logger = console,
    now = () => Date.now(),
    keepDays = USAGE_DEFAULT_KEEP_DAYS,
    getPeakOnlyWorkdays = () => false,
    holidaysFile = DEFAULT_HOLIDAYS_FILE,
  } = {}) {
    this.fileOf = typeof file === 'function' ? file : () => file
    this.getPricing = getPricing
    this.getPeakHours = getPeakHours
    this.getTimezone = getTimezone
    this.getPeakOnlyWorkdays = getPeakOnlyWorkdays
    this.holidaysFileOf = typeof holidaysFile === 'function' ? holidaysFile : () => holidaysFile
    this.scope = scope
    this.logger = logger
    this.now = now
    this.keepDays = keepDays
    /** 峰谷时段配置缓存（避免每条事件都重新解析日期/正则）。 */
    this._periodCache = {
      key: '',
      peakHours: DEFAULT_PEAK_HOURS,
      windows: parsePeakWindows(DEFAULT_PEAK_HOURS),
      timezone: DEFAULT_TIMEZONE,
      onlyWorkdays: false,
    }
    /** holidays.json 缓存（按 mtime 失效）。 */
    this._holidayCache = { file: '', mtime: -1, workdays: new Set(), holidays: new Set() }
    /** @type {ReturnType<typeof emptyState>} */
    this.state = emptyState()
    /** sessionId → 最近一次请求路由（找 assistant/attempt 的归属用） */
    this.routes = new Map()
    this._buffer = []
    this._buffering = false
    this._saveTimer = null
    this._dirty = false
    this._counted = 0
    /** 当前数据是按哪套峰谷规则分类的（规则变了要重建）。 */
    this._dataSignature = ''
    this._backfill = { running: false, done: false, at: 0, scanned: 0, imported: 0, error: null }
    this._load()
  }

  get file() {
    try {
      const value = typeof this.fileOf === 'function' ? this.fileOf() : this.fileOf
      return typeof value === 'string' && value.trim() ? path.resolve(value.trim()) : ''
    } catch {
      return ''
    }
  }

  /* ── 持久化 ─────────────────────────────────────────────────── */

  _load() {
    const file = this.file
    if (!file) return
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return // 文件不存在 = 首次启用，空状态即可
    }
    try {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || parsed.version !== USAGE_VERSION) {
        throw new Error(`存储版本不是 ${USAGE_VERSION}`)
      }
      this.state = normalizeState(parsed)
      this._backfill.done = true
      this._backfill.at = asInt(parsed.updatedAt)
      // 峰谷规则（时段 / 仅工作日 / 时区 / holidays.json）决定历史事件被分到哪个桶。
      // 规则一变，旧分类就不对了：直接清空，让启动回填按新规则重算。
      const current = this._periodSignature()
      this._dataSignature = typeof parsed.periodSignature === 'string' && parsed.periodSignature
        ? parsed.periodSignature
        : current
      if (parsed.periodSignature !== current && Object.keys(this.state.days).length > 0) {
        this.logger?.info?.('[qq-guard] 峰谷规则已变化，用量统计将按新规则重建（旧文件备份为 .bak）')
        this._resetForRules(current)
      }
    } catch (error) {
      // 统计文件是派生数据：读坏了不阻塞主流程，但先留一份 .bak 再重来。
      this.logger?.warn?.(`[qq-guard] ${USAGE_FILE_NAME} 读取失败，重新统计：${error?.message ?? error}`)
      try { copyFileSync(file, `${file}.bak`) } catch { /* 备份失败也不影响主流程 */ }
      this._dataSignature = this._periodSignature()
    }
  }

  /** 立即落盘（测试与卸载时用）。 */
  save() {
    const file = this.file
    if (!file) return false
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      this._prune()
      this.state.updatedAt = this.now()
      if (!this._dataSignature) this._dataSignature = this._periodSignature()
      this.state.periodSignature = this._dataSignature
      const temp = `${file}.tmp`
      writeFileSync(temp, JSON.stringify(this.state), 'utf8')
      renameSync(temp, file)
      this._dirty = false
      return true
    } catch (error) {
      this.logger?.warn?.(`[qq-guard] ${USAGE_FILE_NAME} 写入失败：${error?.message ?? error}`)
      return false
    }
  }

  _scheduleSave() {
    this._dirty = true
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      if (this._dirty) this.save()
    }, SAVE_DEBOUNCE_MS)
    this._saveTimer.unref?.()
  }

  /** 卸载前把未落盘的增量写掉（没有改动就不写）。 */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    if (this._dirty) this.save()
  }

  /** 文件别无限长：只保留最近 keepDays 天的明细。 */
  _prune() {
    const cutoff = new Date(this.now())
    cutoff.setHours(0, 0, 0, 0)
    cutoff.setDate(cutoff.getDate() - this.keepDays)
    const cutoffKey = dayKeyOf(cutoff.getTime())
    for (const key of Object.keys(this.state.days)) {
      if (key < cutoffKey) delete this.state.days[key]
    }
  }

  /* ── 在线拦截 ───────────────────────────────────────────────── */

  /**
   * 收一条 Host 内的会话事件。非 QQ 会话直接忽略，异常由调用方兜住。
   * @param {{id?: string, header?: {cwd?: string, origin?: string, createdAt?: number}}} session
   * @param {{seq?: number, time?: number, type?: string, data?: any}} event
   * @returns {boolean} 是否计入统计
   */
  ingest(session, event) {
    const sessionId = typeof session?.id === 'string' ? session.id : ''
    if (!sessionId) return false
    const header = session?.header ?? {}
    if (!this.scope?.isTarget(sessionId, header.cwd, header.origin)) return false
    if (this._buffering) {
      this._buffer.push({ session, event })
      return false
    }
    return this._apply(sessionId, header, event, 'live')
  }

  _meta(sessionId) {
    let meta = this.state.sessions[sessionId]
    if (!meta) {
      meta = {
        backfillSeq: -1,
        firstLiveSeq: null,
        liveSeq: -1,
        historyComplete: false,
        firstAt: 0,
        lastAt: 0,
        qqKey: '',
        kind: '',
      }
      this.state.sessions[sessionId] = meta
    }
    return meta
  }

  _syncMeta(sessionId, header) {
    const meta = this._meta(sessionId)
    const key = this.scope?.keyOf?.(sessionId)
    if (key) {
      meta.qqKey = key
      meta.kind = kindOfKey(key)
    }
    const createdAt = asInt(header?.createdAt)
    if (createdAt > 0 && !(meta.firstAt > 0)) meta.firstAt = createdAt
    return meta
  }

  /**
   * 现读峰谷配置。配置字符串没变就直接用缓存（回填几百条事件时别每条都解析）。
   * @returns {{peakHours:string, windows:Array<{start:number,end:number}>|null, timezone:string, onlyWorkdays:boolean}}
   */
  _periodConfig() {
    let rawPeakHours
    let rawTimezone
    let rawOnlyWorkdays
    try { rawPeakHours = this.getPeakHours() } catch { rawPeakHours = DEFAULT_PEAK_HOURS }
    try { rawTimezone = this.getTimezone() } catch { rawTimezone = DEFAULT_TIMEZONE }
    try { rawOnlyWorkdays = this.getPeakOnlyWorkdays() } catch { rawOnlyWorkdays = false }
    const peakHours = typeof rawPeakHours === 'string' && rawPeakHours.trim() ? rawPeakHours.trim() : DEFAULT_PEAK_HOURS
    const timezone = typeof rawTimezone === 'string' && rawTimezone.trim() ? rawTimezone.trim() : DEFAULT_TIMEZONE
    const onlyWorkdays = rawOnlyWorkdays === true
    const key = `${peakHours}\u0000${timezone}\u0000${onlyWorkdays}`
    if (this._periodCache.key !== key) {
      this._periodCache = {
        key,
        peakHours,
        windows: parsePeakWindows(peakHours),
        timezone,
        onlyWorkdays,
      }
    }
    return this._periodCache
  }

  /**
   * 读同目录的 holidays.json（按 mtime 缓存）：
   * `workdays` = 调休上班日（即使是周末也按工作日走忙时窗口），
   * `holidays` = 法定节假日（整天按 Off-Peak）。
   */
  _holidayConfig() {
    let file = ''
    try {
      const raw = typeof this.holidaysFileOf === 'function' ? this.holidaysFileOf() : this.holidaysFileOf
      file = typeof raw === 'string' ? path.resolve(raw) : ''
    } catch { file = '' }
    if (!file) return this._holidayCache
    const mtime = mtimeOf(file)
    if (this._holidayCache.file === file && this._holidayCache.mtime === mtime) return this._holidayCache
    const workdays = new Set()
    const holidays = new Set()
    if (mtime >= 0) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        for (const date of parsed?.workdays ?? []) {
          const key = normalizeDateKey(date)
          if (key) workdays.add(key)
        }
        for (const date of parsed?.holidays ?? []) {
          const key = normalizeDateKey(date)
          if (key) holidays.add(key)
        }
      } catch (error) {
        this.logger?.warn?.(`[qq-guard] holidays.json 读取失败（按空表继续）：${error?.message ?? error}`)
      }
    }
    this._holidayCache = { file, mtime, workdays, holidays }
    return this._holidayCache
  }

  /** 当前峰谷规则的稳定签名：规则一变，历史分类就得重算。 */
  _periodSignature() {
    const config = this._periodConfig()
    const table = this._holidayConfig()
    const workdays = [...table.workdays].sort().join(',')
    const holidays = [...table.holidays].sort().join(',')
    return `${config.peakHours}|${config.timezone}|${config.onlyWorkdays}|${workdays}|${holidays}`
  }

  /** 备份当前统计文件、清空聚合，并把数据标记成按新规则分类。 */
  _resetForRules(signature = this._periodSignature()) {
    const file = this.file
    if (file) {
      try { copyFileSync(file, `${file}.bak`) } catch { /* 没有旧文件也无所谓 */ }
    }
    this.state = emptyState()
    this.routes.clear()
    this._counted = 0
    this._dataSignature = signature
    this._dirty = true
    this.save()
  }

  /**
   * 某个时间戳属于忙时还是闲时。
   *
   * 优先级（用户定的规则）：
   *   1. holidays.json 命中 `holidays` → 整天闲时；
   *   2. 命中 `workdays` → 按工作日处理（继续走忙时时段）；
   *   3. 没命中时看「仅工作日」开关：周末 → 整天闲时；
   *   4. 其余情况按时段窗口判断（多段取并集）。
   */
  _periodOf(ms) {
    const { windows, timezone, onlyWorkdays } = this._periodConfig()
    const day = zonedDayKey(ms, timezone)
    const holidayTable = this._holidayConfig()
    if (holidayTable.holidays.has(day)) return 'offPeak'
    const workdayOverride = holidayTable.workdays.has(day)
    if (!workdayOverride && onlyWorkdays) {
      const weekday = zonedWeekday(ms, timezone)
      if (weekday === 0 || weekday === 6) return 'offPeak'
    }
    return isPeakMinute(zonedMinuteOfDay(ms, timezone), windows) ? 'peak' : 'offPeak'
  }

  /** 按配置时区取日历天（存储 / 面板都按这个时区分天）。 */
  _dayOf(ms) {
    const { timezone } = this._periodConfig()
    return zonedDayKey(asInt(ms) || this.now(), timezone)
  }

  /**
   * 应用一条事件。
   * @param {'live'|'backfill'} mode
   */
  _apply(sessionId, header, event, mode) {
    const seq = Number(event?.seq)
    if (!Number.isSafeInteger(seq) || seq < 0) return false
    const meta = this._syncMeta(sessionId, header)

    if (mode === 'live') {
      if (seq <= meta.liveSeq) return false
      if (meta.firstLiveSeq === null) meta.firstLiveSeq = seq
      meta.liveSeq = seq
      if (seq === 0) meta.historyComplete = true // 会话从第一条事件起就在线，没有历史可回填
    } else {
      if (meta.historyComplete) return false
      if (meta.firstLiveSeq !== null && seq >= meta.firstLiveSeq) return false // 之后归在线监听
      if (seq <= meta.backfillSeq) return false
      meta.backfillSeq = seq
    }

    const time = asInt(event?.time) || this.now()
    meta.lastAt = Math.max(meta.lastAt, time)

    let counted = false
    const type = event?.type
    if (type === 'request/header' || type === 'model/selection' || type === 'assistant/message') {
      const route = routeFromEvent(event)
      if (route) this.routes.set(sessionId, route)
    }
    if (type === 'assistant/message' || type === 'assistant/attempt') {
      const usage = (type === 'assistant/message' ? pickUsage(event.data?.usage) : null)
        ?? usageFromStream(event.data?.stream)
      const source = type === 'assistant/message' ? routeFromEvent(event) : null
      const route = source ?? this.routes.get(sessionId)
      this._countCall(sessionId, time, route, usage)
      counted = true
    } else if (type === 'turn/end') {
      this._countTurn(time, event)
      counted = true
    }

    if (counted) this._counted += 1
    this._scheduleSave()
    return counted
  }

  _countCall(sessionId, time, route, usage) {
    const day = this._dayBucket(this._dayOf(time))
    const bucket = day.sessions[sessionId] ?? (day.sessions[sessionId] = sessionBucket())
    addEvent(bucket, usage)
    const key = routeKeyOf(route) || 'unknown/unknown'
    const modelBucket = bucket.models[key] ?? (bucket.models[key] = zeroModelBucket())
    addEvent(modelBucket, usage)
    // 成本要按事件发生时刻分峰谷，所以模型桶里额外记一份 peak / offPeak 明细。
    const period = this._periodOf(time)
    addEvent(modelBucket[period], usage)
  }

  _countTurn(time, event) {
    const day = this._dayBucket(this._dayOf(time))
    const kind = typeof event?.data?.reason?.kind === 'string' ? event.data.reason.kind : 'unknown'
    day.turns[kind] = asInt(day.turns[kind]) + 1
  }

  _dayBucket(day) {
    let bucket = this.state.days[day]
    if (!bucket) {
      bucket = { turns: {}, sessions: {} }
      this.state.days[day] = bucket
    }
    return bucket
  }

  /* ── 历史回填（官方 sessionPersistence 接口）─────────────────── */

  backfillState() {
    return { ...this._backfill }
  }

  /**
   * 清空聚合并把历史标记归零，让下一次 `backfillAll()` 从头重算。
   *
   * 为什么要它：峰谷规则（时段 / 仅工作日 / holidays.json）是**在记录时**分类的，
   * 改了规则以后旧数据不会自己变。想按新规则重算历史就调这个再回填一次。
   * 旧文件会先备份成 `.bak`，不会直接删。
   */
  rebuild() {
    const file = this.file
    this._resetForRules()
    return { ok: true, file, signature: this._dataSignature }
  }

  /**
   * 用 DSH 的 `ctx.sessionPersistence` 扫一遍已存在的 QQ 会话，把历史用量补进来。
   *
   * 这是官方读取接口：`list()` 只读 header，`open(id, 'read')` + `read(offset)` 返回
   * 已解码、已做格式迁移的逻辑事件——不用自己解多帧 zstd，也不怕会话格式升级。
   *
   * 幂等：靠每个会话的 backfillSeq / firstLiveSeq / historyComplete 三个水位去重，
   * 重复调用不会重复计数。
   *
   * @param {any} persistence ctx.sessionPersistence
   * @returns {Promise<{running:boolean,done:boolean,at:number,scanned:number,imported:number,error:string|null}>}
   */
  async backfillAll(persistence) {
    if (this._backfill.running) return this.backfillState()
    if (!persistence || typeof persistence.list !== 'function' || typeof persistence.open !== 'function') {
      this._backfill = { ...this._backfill, error: 'no-persistence' }
      return this.backfillState()
    }

    this._backfill = { running: true, done: this._backfill.done, at: this._backfill.at, scanned: 0, imported: 0, error: null }
    // 回填期间把在线事件先攒起来，结束后按 live 模式重放，避免两个来源抢同一段 seq。
    this._buffering = true
    this.scope?.refresh?.(true)
    const countedBefore = this._counted

    let records = []
    try {
      records = await persistence.list()
    } catch (error) {
      this._backfill.error = `list: ${error?.message ?? error}`
      records = []
    }

    const targets = (Array.isArray(records) ? records : []).filter((record) => this.scope?.isTarget(
      record?.header?.id,
      record?.header?.cwd,
      record?.header?.origin,
    ))
    this._backfill.scanned = targets.length

    for (const record of targets) {
      try {
        await this._backfillOne(persistence, record)
      } catch (error) {
        this.logger?.warn?.(`[qq-guard] 会话 ${record?.header?.id} 用量回填失败：${error?.message ?? error}`)
        if (!this._backfill.error) this._backfill.error = `open: ${error?.message ?? error}`
      }
    }

    this._backfill.imported = this._counted - countedBefore
    this._backfill.running = false
    this._backfill.done = true
    this._backfill.at = this.now()

    this._buffering = false
    this._drainBuffer()
    this.save()
    return this.backfillState()
  }

  async _backfillOne(persistence, record) {
    const sessionId = record?.header?.id
    if (typeof sessionId !== 'string' || !sessionId) return
    const meta = this._meta(sessionId)
    if (meta.historyComplete) return
    const header = record.header ?? {}

    const from = Math.max(0, meta.backfillSeq + 1)
    const boundary = meta.firstLiveSeq // 在线事件从这里开始，历史只到它之前
    if (boundary !== null && from >= boundary) {
      meta.historyComplete = true
      return
    }

    const handle = await persistence.open(sessionId, 'read')
    try {
      const length = boundary === null ? Number.MAX_SAFE_INTEGER : Math.max(0, boundary - from)
      const slice = await handle.read(from, length)
      if (slice?.eventState === 'detached') return // 还没落盘的 pending 会话，等下次
      const events = Array.isArray(slice?.events) ? slice.events : []
      for (const event of events) this._apply(sessionId, header, event, 'backfill')

      if (boundary !== null) {
        if (meta.backfillSeq >= boundary - 1) meta.historyComplete = true
      } else {
        // 没有在线事件：读到的就是当前持久尾部，历史到此完整。
        meta.historyComplete = true
      }
    } finally {
      try { await handle.close?.() } catch { /* 只读句柄关不掉不影响统计 */ }
    }
  }

  _drainBuffer() {
    if (this._buffer.length === 0) return
    const pending = this._buffer
    this._buffer = []
    for (const item of pending) {
      try {
        const sessionId = typeof item?.session?.id === 'string' ? item.session.id : ''
        if (!sessionId) continue
        this._apply(sessionId, item.session?.header ?? {}, item.event, 'live')
      } catch { /* 单条坏事件不能中断整批 */ }
    }
  }

  /* ── 面板快照 ───────────────────────────────────────────────── */

  _dayWindow(days) {
    const out = []
    const seen = new Set()
    const end = this.now()
    // 用「当前时刻往前推 N×24h」再按配置时区取日历天；跨夏令时最多偏一小时，
    // 不会漏天（重复的天会去重）。默认 Asia/Shanghai 无夏令时，等价于逐日减。
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const key = this._dayOf(end - offset * 86_400_000)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(key)
    }
    return out
  }

  _costOfModels(models, pricing) {
    let sum = 0
    let priced = false
    for (const [key, bucket] of Object.entries(models ?? {})) {
      const route = parseRouteKey(key)
      const rule = priceOf(pricing, route.provider, route.model)
      if (!rule) continue
      priced = true
      sum += costOfModelBucket(bucket, rule) ?? 0
    }
    return priced ? round4(sum) : null
  }

  /**
   * 生成 `GET /dsh-qq-guard/usage` 的响应体。
   * @param {{days?: number, scope?: UsageScope}} [options]
   */
  snapshot({ days = USAGE_DEFAULT_DAYS, scope = this.scope } = {}) {
    const windowDays = Math.min(USAGE_MAX_DAYS, Math.max(1, Math.trunc(days) || USAGE_DEFAULT_DAYS))
    const pricing = normalizePricingRules(this.getPricing())
    const dayKeys = this._dayWindow(windowDays)

    const modelMap = new Map()
    const sessionMap = new Map()
    const dayRows = []

    for (const key of dayKeys) {
      const source = this.state.days[key]
      const row = {
        day: key,
        ...zeroUsage(),
        tokens: 0,
        cost: null,
        turnOk: 0,
        turnFail: 0,
        ok: null,
      }
      const dayModels = new Map()

      if (source) {
        for (const [sessionId, bucket] of Object.entries(source.sessions ?? {})) {
          addInto(row, bucket)
          const meta = this.state.sessions[sessionId] ?? {}
          const qqKey = (typeof scope?.keyOf === 'function' ? scope.keyOf(sessionId) : '') || meta.qqKey || ''
          const groupKey = qqKey || `session:${sessionId}`
          let sessionRow = sessionMap.get(groupKey)
          if (!sessionRow) {
            sessionRow = {
              groupKey,
              sessionId,
              sessionIds: [],
              key: qqKey,
              kind: qqKey ? kindOfKey(qqKey) : '会话',
              qq: qqOfKey(qqKey),
              label: qqKey ? `${kindOfKey(qqKey)} ${qqOfKey(qqKey)}` : `已归档会话 ${String(sessionId).slice(-8)}`,
              ...zeroUsage(),
              tokens: 0,
              cost: null,
              share: null,
              lastAt: 0,
              models: {},
            }
            sessionMap.set(groupKey, sessionRow)
          }
          if (!sessionRow.sessionIds.includes(sessionId)) sessionRow.sessionIds.push(sessionId)
          addInto(sessionRow, bucket)
          sessionRow.lastAt = Math.max(sessionRow.lastAt, asInt(meta.lastAt))

          for (const [route, modelBucket] of Object.entries(bucket.models ?? {})) {
            addModelInto(sessionRow.models[route] ?? (sessionRow.models[route] = zeroModelBucket()), modelBucket)
            addModelInto(dayModels.get(route) ?? dayModels.set(route, zeroModelBucket()).get(route), modelBucket)
            const global = modelMap.get(route) ?? modelMap.set(route, zeroModelBucket()).get(route)
            addModelInto(global, modelBucket)
          }
        }
        const turns = source.turns ?? {}
        row.turnOk = asInt(turns.completed)
        row.turnFail = Object.entries(turns).reduce(
          (sum, [kind, count]) => (kind === 'completed' ? sum : sum + asInt(count)),
          0,
        )
        row.ok = row.turnOk + row.turnFail > 0 ? round1((row.turnOk / (row.turnOk + row.turnFail)) * 100) : null
      }

      row.tokens = totalTokenCount(row)
      row.cost = this._costOfModels(Object.fromEntries(dayModels), pricing)
      dayRows.push(row)
    }

    const modelRows = [...modelMap.entries()].map(([key, bucket]) => {
      const route = parseRouteKey(key)
      const rule = priceOf(pricing, route.provider, route.model)
      return {
        key,
        name: key,
        provider: route.provider,
        model: route.model,
        calls: asInt(bucket.calls),
        noUsage: asInt(bucket.noUsage),
        input: asInt(bucket.input),
        output: asInt(bucket.output),
        cacheRead: asInt(bucket.cacheRead),
        cacheWrite: asInt(bucket.cacheWrite),
        reasoning: asInt(bucket.reasoning),
        peak: {
          input: asInt(bucket.peak?.input),
          output: asInt(bucket.peak?.output),
          cacheRead: asInt(bucket.peak?.cacheRead),
          cacheWrite: asInt(bucket.peak?.cacheWrite),
        },
        offPeak: {
          input: asInt(bucket.offPeak?.input),
          output: asInt(bucket.offPeak?.output),
          cacheRead: asInt(bucket.offPeak?.cacheRead),
          cacheWrite: asInt(bucket.offPeak?.cacheWrite),
        },
        tokens: totalTokenCount(bucket),
        cost: rule ? round4(costOfModelBucket(bucket, rule) ?? 0) : null,
        share: null,
      }
    }).sort((left, right) => right.tokens - left.tokens)

    const sessionRows = [...sessionMap.values()].map((row) => ({
      ...row,
      tokens: totalTokenCount(row),
      cost: this._costOfModels(row.models, pricing),
    })).sort((left, right) => right.tokens - left.tokens)

    const modelTotal = modelRows.reduce((sum, row) => sum + row.tokens, 0) || 1
    for (const row of modelRows) row.share = round1((row.tokens / modelTotal) * 100)
    const sessionTotal = sessionRows.reduce((sum, row) => sum + row.tokens, 0) || 1
    for (const row of sessionRows) row.share = round1((row.tokens / sessionTotal) * 100)

    const today = dayRows[dayRows.length - 1] ?? null
    const yesterday = dayRows.length > 1 ? dayRows[dayRows.length - 2] : null
    const pct = (current, base) => (base > 0 ? round1(((current - base) / base) * 100) : null)
    const trend = {
      calls: today && yesterday ? pct(today.calls, yesterday.calls) : null,
      tokens: today && yesterday ? pct(today.tokens, yesterday.tokens) : null,
      cost: today && yesterday && today.cost !== null && yesterday.cost !== null && yesterday.cost > 0
        ? pct(today.cost, yesterday.cost)
        : null,
    }

    const priced = pricing.some(ruleIsPriced)
    const period = this._periodConfig()
    return {
      version: USAGE_VERSION,
      generatedAt: this.now(),
      updatedAt: asInt(this.state.updatedAt),
      scope: {
        sessionCwd: typeof scope?.sessionCwd === 'string' ? scope.sessionCwd : '',
        mapped: typeof scope?.size === 'function' ? scope.size() : 0,
        sessions: sessionRows.length,
      },
      pricing: {
        configured: priced,
        rules: pricing.length,
        peakHours: period.peakHours,
        timezone: period.timezone,
      },
      backfill: this.backfillState(),
      today,
      yesterday,
      trend,
      days: dayRows,
      models: modelRows,
      sessions: sessionRows,
    }
  }
}

/* ════════════════════════════════════════════════════════════════
 * HTTP 路由（挂在 ctx.webServer 上）
 * ════════════════════════════════════════════════════════════════ */

function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  } catch {
    try { res.statusCode = 500; res.end('{"ok":false}') } catch { /* 连接已断开 */ }
  }
}

/** 只接受同源浏览器请求（与插件其它只读路由一致）。 */
function sameOrigin(req) {
  const site = req?.headers?.['sec-fetch-site']
  return typeof site !== 'string' || site === 'same-origin' || site === 'none'
}

/**
 * GET /dsh-qq-guard/usage?days=7 —— 面板轮询这条。
 */
export function handleUsageRoute(req, res, { store, scope } = {}) {
  if (req?.method !== 'GET' && req?.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, reason: 'method not allowed' })
    return
  }
  if (!sameOrigin(req)) {
    sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
    return
  }
  if (!store) {
    sendJson(res, 501, { ok: false, reason: 'no-store' })
    return
  }
  let days = USAGE_DEFAULT_DAYS
  try {
    const url = new URL(req?.url ?? '/', 'http://localhost')
    const raw = Number(url.searchParams.get('days'))
    if (Number.isFinite(raw) && raw > 0) days = Math.min(USAGE_MAX_DAYS, Math.max(1, Math.trunc(raw)))
  } catch { /* 没有 query 就用默认 7 天 */ }
  sendJson(res, 200, { ok: true, ...store.snapshot({ days, scope }) })
}

/**
 * POST /dsh-qq-guard/usage/backfill —— 手动再跑一次历史回填（幂等）。
 * 插件启动 2.5 秒后会自动跑一次，这条路由只是排障/补跑用。
 */
export async function handleUsageBackfillRoute(req, res, { store, scope, getPersistence } = {}) {
  if (req?.method !== 'POST') {
    sendJson(res, 405, { ok: false, reason: 'method not allowed' })
    return
  }
  if (!sameOrigin(req)) {
    sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
    return
  }
  if (!store) {
    sendJson(res, 501, { ok: false, reason: 'no-store' })
    return
  }
  const persistence = typeof getPersistence === 'function' ? getPersistence() : undefined
  if (!persistence || typeof persistence.list !== 'function' || typeof persistence.open !== 'function') {
    sendJson(res, 501, {
      ok: false,
      reason: 'no-persistence',
      detail: '当前 DSH 没有挂载 ctx.sessionPersistence，无法回填历史会话',
    })
    return
  }
  // ?rebuild=1：先清空聚合（规则改了、想按新峰谷规则重算历史时用）。
  let rebuild = false
  try {
    const url = new URL(req?.url ?? '/', 'http://localhost')
    rebuild = url.searchParams.get('rebuild') === '1'
  } catch { /* 没有 query 就按普通回填 */ }
  const rebuilt = rebuild ? store.rebuild() : null
  const backfill = await store.backfillAll(persistence)
  sendJson(res, 200, { ok: true, rebuilt: rebuilt !== null, backfill, ...store.snapshot({ days: USAGE_DEFAULT_DAYS, scope }) })
}
