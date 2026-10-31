/**
 * 常驻感知 tick 与主动行为引擎（v2.0 第二十八步）。
 *
 * 设计原则：**先便宜地决定要不要花钱**。
 *   ① 硬闸门（11 条纯规则）：任何一条不过就 0 token 跳过；
 *   ② 打分：只有 score ≥ 阈值才调模型；
 *   ③ 模型只负责「说什么 / 或者闭嘴」，不负责「该不该说话」。
 *
 * 状态机只有两个持久态：`ready` / `cooling`。正在说话是瞬时动作，不占状态。
 *
 * 本模块不依赖 bridge / onebot：感知数据与发送动作都由调用方注入，
 * 规则全是纯函数，可离线单测。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 运行态文件名。 */
export const PRESENCE_FILE = 'presence.json'

/** 决策日志保留条数。 */
const MAX_DECISIONS = 200

/** 默认配置（Host 的 Config 会覆盖，这里只做兜底）。 */
export const DEFAULT_PROACTIVE = {
  /** 引擎总闸（卡片 pl-proactive）：false = 整个 tick 停摆，连感知都不跑。 */
  engine: false,
  /** 真实发送开关：false = 演练模式（只写决策日志，不调模型、不发消息）。 */
  enabled: false,
  tickMs: 20_000,
  groups: [],
  dayStartHour: 9,
  dayEndHour: 23,
  minSilenceMin: 30,
  maxSilenceMin: 120,
  minDailyMessages: 20,
  evalIntervalMin: 30,
  hourlyLimit: 2,
  noReplyMinutes: 10,
  cooldownHours: 4,
  scoreThreshold: 5,
}

/** 每群保留多少条决策（单群 Tab 用）。 */
export const MAX_GROUP_DECISIONS = 20

const HOUR_MS = 60 * 60 * 1000
const MIN_MS = 60 * 1000

/** 收敛配置：非法值一律回落到默认。 */
export function normalizeProactive(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const num = (value, fallback, min, max) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.floor(parsed)))
  }
  return {
    // 三层开关（v2.0 第二十九步）：
    //   engine  = 卡片总闸（引擎跑不跑）
    //   enabled = 真实发送（false = 演练）
    //   单群授权在 sessions[key].proactiveEnabled，见闸门 groupAllowed
    engine: src.engine === true,
    enabled: src.enabled === true,
    // tick 间隔限制在 10~30 秒（太密没必要，太疏感知迟钝）。
    tickMs: num(src.tickMs, DEFAULT_PROACTIVE.tickMs, 10_000, 30_000),
    groups: Array.isArray(src.groups)
      ? [...new Set(src.groups.map((item) => String(item ?? '').trim()).filter((item) => /^g:\d+$/u.test(item)))].slice(0, 50)
      : [],
    dayStartHour: num(src.dayStartHour, DEFAULT_PROACTIVE.dayStartHour, 0, 23),
    dayEndHour: num(src.dayEndHour, DEFAULT_PROACTIVE.dayEndHour, 1, 24),
    minSilenceMin: num(src.minSilenceMin, DEFAULT_PROACTIVE.minSilenceMin, 5, 1440),
    maxSilenceMin: num(src.maxSilenceMin, DEFAULT_PROACTIVE.maxSilenceMin, 10, 2880),
    minDailyMessages: num(src.minDailyMessages, DEFAULT_PROACTIVE.minDailyMessages, 0, 1000),
    evalIntervalMin: num(src.evalIntervalMin, DEFAULT_PROACTIVE.evalIntervalMin, 5, 1440),
    hourlyLimit: num(src.hourlyLimit, DEFAULT_PROACTIVE.hourlyLimit, 1, 10),
    noReplyMinutes: num(src.noReplyMinutes, DEFAULT_PROACTIVE.noReplyMinutes, 1, 120),
    cooldownHours: num(src.cooldownHours, DEFAULT_PROACTIVE.cooldownHours, 1, 48),
    scoreThreshold: num(src.scoreThreshold, DEFAULT_PROACTIVE.scoreThreshold, 0, 20),
  }
}

/** 某群当前状态（缺省就是一个干净的 ready）。 */
export function blankGroupState(now = Date.now()) {
  return {
    status: 'ready',
    coolUntil: 0,
    speakStamps: [],
    waitingSince: 0,
    ignoredStreak: 0,
    lastEvalAt: 0,
    lastSpeakAt: 0,
    today: { date: localDate(now), inbound: 0 },
    // v2.0 第二十九步：决策记录改成**分群存**（单群 Tab 直接读自己的 20 条）。
    decisions: [],
  }
}

/** 本地日期 `YYYY-MM-DD`（跨天重置用，不依赖 UTC）。 */
export function localDate(now) {
  const date = new Date(Number(now) || Date.now())
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 闸门 + 打分（纯函数，不调模型、不发消息）。
 *
 * @param {object} sense 单个群的感知快照
 * @param {object} conf normalizeProactive 的结果
 * @param {number} now
 * @returns {{verdict:'skip'|'evaluate', reason:string, score:number, gates:object}}
 */
export function evaluatePresence(sense, conf, now = Date.now()) {
  const gates = {
    // v2.0 第二十九步：两层授权排在最前。
    //   engine       = 卡片总闸（normalize 后 conf.engine）
    //   groupAllowed = 单群授权（sessions[key].proactiveEnabled）
    // 授权不是条件：它比「今天够不够活跃」更根本，理由也更好懂。
    engine: conf.engine === true,
    groupAllowed: sense?.proactiveEnabled === true,
    groupChat: String(sense?.key ?? '').startsWith('g:'),
    awake: !(Number(sense?.mutedUntil) > now),
    notCooling: true,
    underHourly: true,
    evalGap: true,
    daytime: true,
    silenceRange: true,
    aliveGroup: true,
    noUnread: true,
    noTaskNear: true,
  }
  const group = sense?.presence ?? blankGroupState(now)
  const stamps = Array.isArray(group.speakStamps) ? group.speakStamps : []

  gates.notCooling = !(group.status === 'cooling' && Number(group.coolUntil) > now)
  gates.underHourly = stamps.filter((stamp) => now - stamp < HOUR_MS).length < conf.hourlyLimit
  gates.evalGap = now - (Number(group.lastEvalAt) || 0) >= conf.evalIntervalMin * MIN_MS
  const hour = new Date(now).getHours()
  gates.daytime = conf.dayEndHour <= 24
    ? hour >= conf.dayStartHour && hour < conf.dayEndHour
    : hour >= conf.dayStartHour
  const silenceMin = Math.floor(Number(sense?.silenceMs) || 0) / MIN_MS
  gates.silenceRange = silenceMin >= conf.minSilenceMin && silenceMin <= conf.maxSilenceMin
  gates.aliveGroup = (Number(sense?.todayInbound) || 0) >= conf.minDailyMessages
  gates.noUnread = (Number(sense?.unread) || 0) === 0
  // taskNearMs：null / undefined / 0 都表示「附近没有定时任务」。
  gates.noTaskNear = !(Number(sense?.taskNearMs) > 0)

  // 按顺序找第一条否掉的闸门，理由要能直接看懂。
  // 注意：`enabled`（真实发送）不是闸门。演练模式下引擎照样跑规则、写 dry-run 日志，
  // 只是不调模型、不发送 —— 这就是「先跑几晚看日志」的模式。
  const order = [
    ['engine', '主动感知总闸未开启'],
    ['groupAllowed', '本群未授权主动感知'],
    ['groupChat', '只对群聊生效'],
    ['awake', '本群休眠中'],
    ['notCooling', `冷却中（至 ${group.coolUntil > 0 ? new Date(group.coolUntil).toLocaleString('zh-CN') : '—'}）`],
    ['underHourly', `本小时已主动发言 ${stamps.length} 次，达到上限 ${conf.hourlyLimit}`],
    ['evalGap', `距上次评估不足 ${conf.evalIntervalMin} 分钟`],
    ['daytime', `不在白天窗口 ${conf.dayStartHour}-${conf.dayEndHour} 点`],
    ['silenceRange', `安静 ${Math.round(silenceMin)} 分钟，不在 ${conf.minSilenceMin}~${conf.maxSilenceMin} 的甜区`],
    ['aliveGroup', `今天只有 ${Number(sense?.todayInbound) || 0} 条消息，群不活跃`],
    ['noUnread', '还有未读消息待归纳'],
    ['noTaskNear', '定时任务即将触发，本轮让位'],
  ]
  for (const [gate, reason] of order) {
    if (!gates[gate]) return { verdict: 'skip', reason, score: 0, gates }
  }

  // 打分（只用于排序/阈值，仍然不调模型）。
  let score = 0
  const reasons = []
  if (silenceMin >= 30 && silenceMin <= 120) { score += 3; reasons.push('安静 30~120 分钟') }
  if ((Number(sense?.recentCount) || 0) >= 5) { score += 2; reasons.push('近 30 分钟有 5+ 条') }
  if (sense?.lastIsQuestion === true) { score += 2; reasons.push('最后一条是问句且无人接') }
  if (sense?.memoryHit === true) { score += 1; reasons.push('最近消息命中跨群记忆') }
  if (sense?.lastIsMine === true) { score -= 2; reasons.push('最后一条是我自己发的') }
  if (hour < conf.dayStartHour || hour >= 22) { score -= 1; reasons.push('时段偏晚') }

  const pass = score >= conf.scoreThreshold
  return {
    verdict: pass ? 'evaluate' : 'skip',
    reason: `${reasons.join('；') || '无加分项'}（分数 ${score}，阈值 ${conf.scoreThreshold}）`,
    score,
    gates,
  }
}

/**
 * 模型决定说话后的状态更新（纯函数）。
 * @param {object} group 当前状态
 * @param {number} now
 * @returns {object} 新状态
 */
export function applySpeak(group, now) {
  const state = { ...blankGroupState(now), ...group }
  state.speakStamps = [...(state.speakStamps ?? []), now].filter((stamp) => now - stamp < HOUR_MS)
  state.waitingSince = now
  state.lastSpeakAt = now
  state.lastEvalAt = now
  return state
}

/** 模型决定沉默：只更新评估时间，不影响发言计数。 */
export function applySilent(group, now) {
  return { ...blankGroupState(now), ...group, lastEvalAt: now }
}

/**
 * 收到人类消息：等待期内的第一次说话就算「接茬」。
 * @param {object} group
 * @param {boolean} fromBot 机器人自己发的不算
 * @param {number} now
 */
export function applyInbound(group, fromBot, now) {
  const state = { ...blankGroupState(now), ...group }
  if (state.waitingSince > 0 && fromBot !== true) {
    state.waitingSince = 0
    state.ignoredStreak = 0
  }
  if (state.today?.date !== localDate(now)) {
    state.today = { date: localDate(now), inbound: 0 }
  }
  state.today.inbound += fromBot === true ? 0 : 1
  return state
}

/**
 * 结算等待期：超时没等到接茬 → 记录被无视；连续两次 → 冷却。
 * @param {object} group
 * @param {object} conf
 * @param {number} now
 */
export function applyTimeout(group, conf, now) {
  const state = { ...blankGroupState(now), ...group }
  if (state.waitingSince > 0 && now - state.waitingSince >= conf.noReplyMinutes * MIN_MS) {
    state.waitingSince = 0
    state.ignoredStreak = (Number(state.ignoredStreak) || 0) + 1
    if (state.ignoredStreak >= 2) {
      state.ignoredStreak = 0
      state.status = 'cooling'
      state.coolUntil = now + conf.cooldownHours * HOUR_MS
    }
  }
  if (state.status === 'cooling' && now >= state.coolUntil) {
    state.status = 'ready'
    state.coolUntil = 0
  }
  return state
}

/**
 * 感知引擎：持有 tick 定时器与运行态，规则/状态由上面的纯函数决定。
 */
export class PresenceEngine {
  /**
   * @param {object} options
   * @param {string} options.dir state 目录
   * @param {() => object} options.getConfig 返回 normalizeProactive 的结果
   * @param {() => Promise<object[]>} options.sense 返回每个群的感知快照
   * @param {(sense:object, decision:object) => Promise<{speak:boolean, text?:string, error?:string}>} options.decide
   * @param {(key:string, text:string) => Promise<boolean>} options.send
   * @param {(row:object) => void} [options.log]
   * @param {() => number} [options.now]
   * @param {{warn?:Function, info?:Function}} [options.logger]
   */
  constructor({ dir, getConfig, sense, decide, send, log, now, logger } = {}) {
    this.dir = path.resolve(String(dir ?? './state'))
    this.file = path.join(this.dir, PRESENCE_FILE)
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => normalizeProactive({})
    this.sense = typeof sense === 'function' ? sense : async () => []
    this.decide = typeof decide === 'function' ? decide : async () => ({ speak: false })
    this.send = typeof send === 'function' ? send : async () => false
    this.log = typeof log === 'function' ? log : () => {}
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.logger = logger
    this.groups = new Map()
    this.lastTickAt = 0
    this.lastTickStats = { sensed: 0, evaluated: 0, spoke: 0, skipped: 0 }
    this._timer = null
    this._ticking = false
    this._dirty = false
    this._warned = false
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return this
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const groups = parsed?.groups && typeof parsed.groups === 'object' ? parsed.groups : {}
      for (const [key, value] of Object.entries(groups)) {
        if (!value || typeof value !== 'object') continue
        const state = { ...blankGroupState(this.now()), ...value }
        // 决策分群存（v2.0 第二十九步）：每群只留最近 20 条。
        state.decisions = Array.isArray(value.decisions)
          ? value.decisions.slice(-MAX_GROUP_DECISIONS)
          : []
        this.groups.set(key, state)
      }
      // 旧版（顶层 decisions 全局数组）迁移成分群：按 key 拆到各自的群，然后丢弃顶层。
      const legacy = Array.isArray(parsed?.decisions) ? parsed.decisions : []
      for (const row of legacy.slice(-MAX_DECISIONS)) {
        if (!row || typeof row !== 'object' || typeof row.key !== 'string') continue
        const state = this.groupOf(row.key)
        state.decisions = [...(state.decisions ?? []), row].slice(-MAX_GROUP_DECISIONS)
        this.groups.set(row.key, state)
      }
      return this
    } catch (error) {
      this.logger?.warn?.(`主动感知状态文件损坏，已重置：${error?.message ?? error}`)
      try { fs.renameSync(this.file, `${this.file}.bak`) } catch { /* ignore */ }
      this.groups.clear()
      return this
    }
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({
        version: 2,
        updatedAt: this.now(),
        groups: Object.fromEntries(this.groups),
      }, null, 2))
      fs.renameSync(tmp, this.file)
      this._dirty = false
    } catch (error) {
      if (!this._warned) {
        this._warned = true
        this.logger?.warn?.(`主动感知写盘失败（不影响聊天）：${error?.message ?? error}`)
      }
    }
  }

  /** 取某群状态（缺省即新建）。 */
  groupOf(key, now = this.now()) {
    let state = this.groups.get(key)
    if (!state) {
      state = blankGroupState(now)
      this.groups.set(key, state)
    }
    return state
  }

  /** 收到人类消息的接茬钩子（bridge 在 handleMessage 里调用，只动内存）。 */
  noteInbound(key, fromBot = false) {
    const now = this.now()
    this.groups.set(key, applyInbound(this.groupOf(key, now), fromBot, now))
    this._dirty = true
  }

  /** 记录一条决策（写进该群自己的 20 条）。 */
  noteDecision({ key, verdict, reason, score = 0, text = '' }) {
    const state = this.groupOf(key)
    const row = {
      at: this.now(), verdict, reason, score,
      ...(text === '' ? {} : { text: text.slice(0, 60) }),
    }
    state.decisions = [...(state.decisions ?? []), row].slice(-MAX_GROUP_DECISIONS)
    this.groups.set(key, state)
    this._dirty = true
    this.log?.({ key, verdict, reason, score, text })
  }

  start() {
    if (this._timer) return
    const conf = this.getConfig()
    this._timer = setInterval(() => { void this.tick() }, conf.tickMs)
    if (typeof this._timer.unref === 'function') this._timer.unref()
    this.logger?.info?.(`主动感知已启动（tick ${conf.tickMs / 1000}s，enabled=${conf.enabled}）`)
  }

  stop() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
    if (this._dirty) this.save()
  }

  /** 配置变更：tick 间隔变了就重建定时器。 */
  reconfigure() {
    if (!this._timer) return
    clearInterval(this._timer)
    this._timer = null
    this.start()
  }

  /** 一轮感知。同一刻只允许一个 tick 在跑。 */
  async tick() {
    if (this._ticking) return
    this._ticking = true
    const now = this.now()
    try {
      const conf = this.getConfig()
      this.lastTickAt = now
      const stats = { sensed: 0, evaluated: 0, spoke: 0, skipped: 0 }
      // 总闸未开 = 引擎停摆：连感知都不跑，也不写日志（避免满屏无意义 skip）。
      if (conf.engine !== true) {
        this.lastTickStats = stats
        return
      }
      const snaps = await this.sense()
      stats.sensed = Array.isArray(snaps) ? snaps.length : 0
      if (!Array.isArray(snaps) || snaps.length === 0) {
        this.lastTickStats = stats
        return
      }
      // 先结算所有等待期 / 冷却，再挑候选。
      for (const snap of snaps) {
        const state = applyTimeout(this.groupOf(snap.key, now), conf, now)
        this.groups.set(snap.key, state)
        snap.presence = state
      }
      // 每 tick 最多评估一个群（取分数最高，且必须过闸门）。
      const candidates = []
      for (const snap of snaps) {
        const result = evaluatePresence(snap, conf, now)
        if (result.verdict === 'evaluate') candidates.push({ snap, result })
        else stats.skipped += 1
      }
      stats.candidates = candidates.length
      if (candidates.length === 0) {
        this.lastTickStats = stats
        if (this._dirty) { this.save() }
        return
      }
      candidates.sort((left, right) => right.result.score - left.result.score)
      const best = candidates[0]
      // 闸门通过但 dry-run：只记决策，不调模型、不发消息。
      if (conf.enabled !== true) {
        this.noteDecision({
          key: best.snap.key,
          verdict: 'dry-run',
          reason: `[dry-run] ${best.result.reason}`,
          score: best.result.score,
        })
        this.lastTickStats = stats
        this.save()
        return
      }
      stats.evaluated += 1
      const decision = await this.decide(best.snap, best.result)
      if (decision?.speak === true && decision.text && decision.text.trim() !== '') {
        const ok = await this.send(best.snap.key, decision.text)
        if (ok) {
          this.groups.set(best.snap.key, applySpeak(this.groupOf(best.snap.key, now), now))
          stats.spoke += 1
          this.noteDecision({
            key: best.snap.key, verdict: 'speak', reason: best.result.reason,
            score: best.result.score, text: decision.text,
          })
        } else {
          this.groups.set(best.snap.key, applySilent(this.groupOf(best.snap.key, now), now))
          this.noteDecision({
            key: best.snap.key, verdict: 'send-failed',
            reason: `发送失败：${decision.error ?? 'unknown'}`, score: best.result.score,
          })
        }
      } else {
        this.groups.set(best.snap.key, applySilent(this.groupOf(best.snap.key, now), now))
        this.noteDecision({
          key: best.snap.key, verdict: 'silent',
          reason: decision?.error ? `模型未回话：${decision.error}` : '模型选择沉默',
          score: best.result.score,
        })
      }
      this.lastTickStats = stats
      this.save()
    } catch (error) {
      this.logger?.warn?.(`主动感知 tick 异常（本轮跳过）：${error?.message ?? error}`)
    } finally {
      this._ticking = false
    }
  }

  /**
   * UI 视图。
   *
   * v2.0 第二十九步：决策改成**分群存**——
   *   · `groups[i].decisions` 给单群 Tab（每群最近 20 条）；
   *   · `decisions` 是全局视图的合并摘要（按时间倒序取最近 limit 条）。
   */
  view(limit = 20) {
    const conf = this.getConfig()
    const now = this.now()
    const groups = [...this.groups.entries()].slice(0, 20).map(([key, state]) => ({
      key,
      status: state.status,
      coolUntil: Number(state.coolUntil) || 0,
      waitingSince: Number(state.waitingSince) || 0,
      ignoredStreak: Number(state.ignoredStreak) || 0,
      speakLastHour: (state.speakStamps ?? []).filter((stamp) => now - stamp < HOUR_MS).length,
      lastEvalAt: Number(state.lastEvalAt) || 0,
      lastSpeakAt: Number(state.lastSpeakAt) || 0,
      decisions: (state.decisions ?? []).slice(-MAX_GROUP_DECISIONS),
    }))
    // 全局视图：从各群合并，按时间倒序。
    const merged = []
    for (const [key, state] of this.groups) {
      for (const row of state.decisions ?? []) merged.push({ ...row, key })
    }
    merged.sort((left, right) => (Number(right.at) || 0) - (Number(left.at) || 0))
    return {
      engine: conf.engine === true,
      enabled: conf.enabled === true,
      // 演练 = 引擎开着但真实发送关着。
      dryRun: conf.engine === true && conf.enabled !== true,
      tickMs: conf.tickMs,
      lastTickAt: this.lastTickAt,
      stats: { ...this.lastTickStats },
      groups,
      decisions: merged.slice(0, Math.max(1, limit)),
    }
  }
}
