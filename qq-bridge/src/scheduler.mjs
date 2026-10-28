/**
 * 轻量级全局定时任务调度器（v2.0 第二十四步）。
 *
 * 为什么独立成模块：定时任务有自己的生命周期（加载 / 持久化 / 热更新 / 队列限速），
 * 塞进 6000 行的 bridge 只会更难测。调度器只负责「什么时候跑、跑完记什么」，
 * 具体动作由 bridge 注入的 `exec(task)` 执行。
 *
 * 支持的标准五段式 Cron：`分 时 日 月 周`。
 *   · 通配 `*`、步长 `0-59/15`、单值 `5`、区间 `1-5`、列表 `1,3,5`；
 *   · 周：0~7（0 和 7 都是周日）；
 *   · 日与周同时受限时按 **AND** 处理（比 cron 的 OR 更保守，避免误触发）。
 *
 * 时区：按**进程本地时区**计算（本机就是 Asia/Shanghai）。任务里的 `timezone`
 * 字段仅作展示，跨时区部署时再扩展。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** 调度器持久化文件名（放在 state/ 下）。 */
export const SCHEDULER_FILE = 'scheduler.json'

/** tick 间隔：10 秒足够，误差远小于分钟级任务。 */
const DEFAULT_TICK_MS = 10_000

/** 重启宽限：错过超过这个时间的任务不补跑，直接顺延。 */
const RESTART_GRACE_MS = 5 * 60 * 1000

/** 队列默认：相邻发送至少 3 秒 + 0~30 秒抖动；每分钟最多 6 条。 */
export const DEFAULT_QUEUE = {
  minIntervalMs: 3000,
  jitterMs: 30_000,
  maxPerMinute: 6,
  maxBacklog: 20,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 解析单个 cron 字段为允许值集合。
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @returns {Set<number>|null} null = 非法
 */
function parseCronField(field, min, max) {
  const text = String(field ?? '').trim()
  if (text === '') return null
  const values = new Set()
  for (const part of text.split(',')) {
    const piece = part.trim()
    if (piece === '') return null
    // 纯通配：整段范围。
    if (piece === '*') {
      for (let value = min; value <= max; value += 1) values.add(value)
      continue
    }
    const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/u.exec(piece)
    if (stepMatch) {
      const step = Number(stepMatch[2])
      if (!Number.isInteger(step) || step <= 0) return null
      let start = min
      let end = max
      if (stepMatch[1] !== '*') {
        const range = stepMatch[1].split('-').map(Number)
        start = range[0]
        end = range.length > 1 ? range[1] : max
      }
      if (start < min || end > max || start > end) return null
      for (let value = start; value <= end; value += step) values.add(value)
      continue
    }
    const rangeMatch = /^(\d+)(?:-(\d+))?$/u.exec(piece)
    if (!rangeMatch) return null
    const start = Number(rangeMatch[1])
    const end = rangeMatch[2] === undefined ? start : Number(rangeMatch[2])
    if (start < min || end > max || start > end) return null
    for (let value = start; value <= end; value += 1) values.add(value)
  }
  return values.size > 0 ? values : null
}

/**
 * 解析五段式 cron。
 * @param {string} expression
 * @returns {{minute:Set<number>,hour:Set<number>,dayOfMonth:Set<number>,month:Set<number>,dayOfWeek:Set<number>}|null}
 */
export function parseCron(expression) {
  const parts = String(expression ?? '').trim().split(/\s+/u)
  if (parts.length !== 5) return null
  const minute = parseCronField(parts[0], 0, 59)
  const hour = parseCronField(parts[1], 0, 23)
  const dayOfMonth = parseCronField(parts[2], 1, 31)
  const month = parseCronField(parts[3], 1, 12)
  const dayOfWeek = parseCronField(parts[4], 0, 7)
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null
  // 7 与 0 都是周日：统一折成 0。
  if (dayOfWeek.has(7)) { dayOfWeek.delete(7); dayOfWeek.add(0) }
  return { minute, hour, dayOfMonth, month, dayOfWeek }
}

/**
 * 从 `afterMs` 之后找下一次触发时间（严格大于 afterMs，按分钟对齐）。
 * @param {string} expression
 * @param {number} [afterMs]
 * @returns {number} 毫秒时间戳；cron 非法或 4 年内无匹配返回 0
 */
export function nextCronTime(expression, afterMs = Date.now()) {
  const cron = parseCron(expression)
  if (!cron) return 0
  const date = new Date(afterMs)
  date.setSeconds(0, 0)
  date.setMinutes(date.getMinutes() + 1)
  const limit = 366 * 4 * 24 * 60
  for (let i = 0; i < limit; i += 1) {
    if (cron.minute.has(date.getMinutes())
      && cron.hour.has(date.getHours())
      && cron.month.has(date.getMonth() + 1)
      && cron.dayOfMonth.has(date.getDate())
      && cron.dayOfWeek.has(date.getDay())) {
      return date.getTime()
    }
    date.setMinutes(date.getMinutes() + 1)
  }
  return 0
}

/** 给任务补默认值并收敛字段。 */
function normalizeTask(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const cron = String(value.cron ?? '').trim()
  if (!cron || !parseCron(cron)) return null
  const prompt = String(value.prompt ?? '').trim().slice(0, 2000)
  if (prompt === '') return null
  const targets = Array.isArray(value.targets)
    ? [...new Set(value.targets.map((item) => String(item ?? '').trim()).filter((item) => /^g:\d+$/u.test(item)))].slice(0, 50)
    : []
  return {
    id: typeof value.id === 'string' && value.id !== '' ? value.id : `task_${randomUUID()}`,
    cron,
    // 空数组 = 所有白名单群（执行时由 bridge 展开）。
    targets,
    prompt,
    at: value.at === true,
    enabled: value.enabled !== false,
    createdBy: value.createdBy === 'developer' ? 'developer' : 'owner',
    createdAt: Number(value.createdAt) || now,
    lastRunAt: Number(value.lastRunAt) || 0,
    nextRunAt: Number(value.nextRunAt) || 0,
    lastResult: typeof value.lastResult === 'string' ? value.lastResult.slice(0, 200) : '',
    runCount: Math.max(0, Math.floor(Number(value.runCount) || 0)),
  }
}

/**
 * 定时任务调度器。
 *
 * 只做「时间到了就调 exec」；exec 由 bridge 注入（发送 / 生成文本 / 记录）。
 */
export class Scheduler {
  /**
   * @param {object} options
   * @param {string} options.dir state 目录
   * @param {(task:object)=>Promise<{ok:boolean,error?:string}>} options.exec
   * @param {() => number} [options.now]
   * @param {{warn?:Function,info?:Function}} [options.logger]
   * @param {number} [options.tickMs]
   * @param {string} [options.fileName]
   */
  constructor({ dir, exec, now, logger, tickMs = DEFAULT_TICK_MS, fileName = SCHEDULER_FILE } = {}) {
    this.dir = path.resolve(String(dir ?? './state'))
    this.file = path.join(this.dir, fileName)
    this.exec = typeof exec === 'function' ? exec : async () => ({ ok: false, error: 'no-exec' })
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.logger = logger
    this.tickMs = Math.max(1000, Number(tickMs) || DEFAULT_TICK_MS)
    this.tasks = new Map()
    this._timer = null
    this._ticking = false
    this._warned = false
  }

  /** 加载并修复运行态（防重启风暴）。 */
  load() {
    try {
      if (!fs.existsSync(this.file)) return this
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const list = Array.isArray(parsed?.tasks) ? parsed.tasks : []
      const now = this.now()
      for (const raw of list) {
        const task = normalizeTask(raw, now)
        if (!task) continue
        if (task.nextRunAt <= 0) task.nextRunAt = nextCronTime(task.cron, now)
        // 错过太久（重启/停机）不补跑，直接顺延，避免重启风暴。
        if (task.nextRunAt > 0 && task.nextRunAt < now - RESTART_GRACE_MS) {
          task.nextRunAt = nextCronTime(task.cron, now)
        }
        this.tasks.set(task.id, task)
      }
      return this
    } catch (error) {
      this.logger?.warn?.(`定时任务文件损坏，已备份并重新开始：${error?.message ?? error}`)
      try { fs.renameSync(this.file, `${this.file}.bak`) } catch { /* ignore */ }
      this.tasks.clear()
      return this
    }
  }

  /** 原子写盘。 */
  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: this.now(), tasks: [...this.tasks.values()] }, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (error) {
      if (!this._warned) {
        this._warned = true
        this.logger?.warn?.(`定时任务写盘失败（不影响聊天）：${error?.message ?? error}`)
      }
    }
  }

  /** 新建任务；cron 非法返回 null。 */
  addTask(input = {}) {
    const now = this.now()
    const task = normalizeTask({ ...input, id: input.id || `task_${randomUUID()}` }, now)
    if (!task) return null
    task.nextRunAt = nextCronTime(task.cron, now)
    if (task.nextRunAt <= 0) return null
    this.tasks.set(task.id, task)
    this.save()
    return { ...task }
  }

  /** 更新任务（保留运行态字段）。 */
  updateTask(id, patch = {}) {
    const current = this.tasks.get(String(id))
    if (!current) return null
    const merged = normalizeTask({ ...current, ...patch, id: current.id }, this.now())
    if (!merged) return null
    if (patch.cron !== undefined && patch.cron !== current.cron) {
      merged.nextRunAt = nextCronTime(merged.cron, this.now())
    }
    this.tasks.set(merged.id, merged)
    this.save()
    return { ...merged }
  }

  removeTask(id) {
    const removed = this.tasks.delete(String(id))
    if (removed) this.save()
    return removed
  }

  list() {
    return [...this.tasks.values()].map((task) => ({ ...task }))
  }

  start() {
    if (this._timer) return
    // 启动后先 tick 一次：宽限期内错过的任务应立刻补跑。
    void this.tick()
    this._timer = setInterval(() => { void this.tick() }, this.tickMs)
    if (typeof this._timer.unref === 'function') this._timer.unref()
  }

  stop() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
  }

  /** 到点任务逐个执行；同一任务上一轮没结束不重入。 */
  async tick() {
    if (this._ticking) return
    this._ticking = true
    try {
      const now = this.now()
      for (const task of this.tasks.values()) {
        if (!task.enabled || task.nextRunAt <= 0 || task.nextRunAt > now) continue
        let result = { ok: false, error: 'unknown' }
        try {
          result = await this.exec(task)
        } catch (error) {
          result = { ok: false, error: String(error?.message ?? error) }
        }
        task.lastRunAt = this.now()
        task.lastResult = result?.ok ? 'ok' : String(result?.error ?? 'error').slice(0, 200)
        task.runCount += 1
        task.nextRunAt = nextCronTime(task.cron, this.now())
        this.save()
        this.logger?.info?.(`定时任务 ${task.id} 执行${result?.ok ? '成功' : `失败：${task.lastResult}`}`)
      }
    } finally {
      this._ticking = false
    }
  }
}

/**
 * 全局广播队列（防风控）：单并发 + 间隔 + 抖动 + 每分钟上限。
 *
 * 所有「定时任务主动发消息」都必须经过它；普通聊天回复不走这里。
 */
export class TaskQueue {
  /**
   * @param {object} [options]
   * @param {number} [options.minIntervalMs]
   * @param {number} [options.jitterMs]
   * @param {number} [options.maxPerMinute]
   * @param {number} [options.maxBacklog]
   * @param {() => number} [options.now]
   * @param {(ms:number)=>Promise<void>} [options.sleep]
   * @param {() => number} [options.rand]
   */
  constructor({
    minIntervalMs = DEFAULT_QUEUE.minIntervalMs,
    jitterMs = DEFAULT_QUEUE.jitterMs,
    maxPerMinute = DEFAULT_QUEUE.maxPerMinute,
    maxBacklog = DEFAULT_QUEUE.maxBacklog,
    now,
    sleep: sleepImpl,
    rand,
  } = {}) {
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0)
    this.jitterMs = Math.max(0, Number(jitterMs) || 0)
    this.maxPerMinute = Math.max(1, Number(maxPerMinute) || 1)
    this.maxBacklog = Math.max(1, Number(maxBacklog) || 1)
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.sleep = typeof sleepImpl === 'function' ? sleepImpl : sleep
    this.rand = typeof rand === 'function' ? rand : Math.random
    this._backlog = []
    this._stamps = []
    this._draining = false
  }

  /** 队列长度（排障用）。 */
  get size() {
    return this._backlog.length
  }

  /**
   * 入队一个发送动作；返回该动作的结果。
   * 积压超过上限时丢最旧的（resolve `{ skipped: true }`），保证不无限堆积。
   */
  enqueue(runner) {
    return new Promise((resolve, reject) => {
      if (this._backlog.length >= this.maxBacklog) {
        const dropped = this._backlog.shift()
        dropped.resolve({ skipped: true, reason: 'backlog-full' })
      }
      this._backlog.push({ runner, resolve, reject })
      void this._drain()
    })
  }

  async _drain() {
    if (this._draining) return
    this._draining = true
    try {
      while (this._backlog.length > 0) {
        const job = this._backlog.shift()
        await this._waitSlot()
        this._stamps.push(this.now())
        this._trimStamps()
        try {
          job.resolve(await job.runner())
        } catch (error) {
          job.reject(error)
        }
      }
    } finally {
      this._draining = false
    }
  }

  _trimStamps() {
    const cutoff = this.now() - 60_000
    while (this._stamps.length > 0 && this._stamps[0] <= cutoff) this._stamps.shift()
  }

  async _waitSlot() {
    const last = this._stamps.length > 0 ? this._stamps[this._stamps.length - 1] : 0
    const gap = this.minIntervalMs + Math.floor(this.rand() * (this.jitterMs + 1))
    const waitGap = Math.max(0, last + gap - this.now())
    if (waitGap > 0) await this.sleep(waitGap)
    this._trimStamps()
    if (this._stamps.length >= this.maxPerMinute) {
      const waitMinute = Math.max(0, this._stamps[0] + 60_000 - this.now())
      if (waitMinute > 0) await this.sleep(waitMinute)
    }
  }
}
