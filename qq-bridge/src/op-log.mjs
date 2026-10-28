/**
 * 桥接操作日志的本地落盘（v2.0 第六步，2026-10-28）。
 *
 * 设计边界：
 *   · 只记录**关键操作**（截断 / 归纳 / 模型报错），不是所有 console 输出；
 *     全量 stdout 仍由 bridge-runner 的环形缓冲负责，别把文件写成第二个日志系统。
 *   · 同步写（appendFileSync）：操作日志频率低（一次操作一行），
 *     换来的是进程崩溃时最后一行不会丢。绝不把日志写失败冒到主链路。
 *   · 切分按「当天文件 + 大小超限改名为带时间戳的文件」，不做跨天合并。
 *   · 清理按文件 mtime，启动时跑一次，之后每天一次（见 bridge 的定时器）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 默认日志子目录（相对 stateFile 所在目录，即 `qq-bridge/state/logs`）。 */
export const DEFAULT_LOG_SUBDIR = 'logs'
/** 单文件默认上限（MB）。 */
export const DEFAULT_LOG_MAX_MB = 5
/** 默认保留天数。 */
export const DEFAULT_LOG_MAX_DAYS = 15

const pad = (n) => String(n).padStart(2, '0')

/** `YYYY-MM-DD`（本地时区，日志文件名用）。 */
export function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `YYYY-MM-DD HH:mm:ss`（本地时区，行首时间戳用）。 */
export function stampOf(date) {
  return `${dayKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 一行日志的规范格式：`[YYYY-MM-DD HH:mm:ss] [LEVEL] 内容`。
 *
 * 多行内容（错误栈 / 模型输出）逐行加前缀，保证 `grep 时间戳` 每行都能对上。
 * @param {Date} date
 * @param {string} level info | warn | error
 * @param {string} text
 * @returns {string} 带结尾换行
 */
export function formatLogLine(date, level, text) {
  const head = `[${stampOf(date)}] [${String(level ?? 'info').toUpperCase()}] `
  return String(text ?? '')
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .map((line) => `${head}${line}`)
    .join('\n') + '\n'
}

/** 数字配置兜底：非法 / 越界一律回默认。 */
function clampNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 单实例文件日志器。
 *
 * 目录解析规则：
 *   · `dir` 为空 → `<baseDir>/logs`（baseDir 由调用方传 state 目录的父级）；
 *   · 相对路径 → 相对 baseDir 解析；
 *   · 绝对路径 → 原样使用（用户拍板支持）。
 */
export class OpLogFile {
  /**
   * @param {object} options
   * @param {string} options.baseDir 默认根目录（通常是 qq-bridge 目录）
   * @param {string} [options.dir] 用户配置的目录（空 = 默认）
   * @param {number} [options.maxSizeMB]
   * @param {number} [options.maxDays]
   * @param {{warn?:Function}} [options.logger] 写盘失败时只 warn 一次
   * @param {() => Date} [options.now] 测试注入
   */
  constructor({ baseDir, dir = '', maxSizeMB = DEFAULT_LOG_MAX_MB, maxDays = DEFAULT_LOG_MAX_DAYS, logger, now } = {}) {
    this.baseDir = String(baseDir ?? process.cwd())
    this.dir = String(dir ?? '').trim()
    this.maxSizeMB = clampNumber(maxSizeMB, DEFAULT_LOG_MAX_MB, 1, 100)
    this.maxDays = clampNumber(maxDays, DEFAULT_LOG_MAX_DAYS, 1, 365)
    this.logger = logger
    this.now = typeof now === 'function' ? now : () => new Date()
    this._warned = false
  }

  /** 解析后的绝对目录。 */
  get directory() {
    if (this.dir === '') return path.resolve(this.baseDir, DEFAULT_LOG_SUBDIR)
    return path.isAbsolute(this.dir) ? path.normalize(this.dir) : path.resolve(this.baseDir, this.dir)
  }

  /** 单文件字节上限。 */
  get maxBytes() {
    return Math.floor(this.maxSizeMB * 1024 * 1024)
  }

  /** 当天日志文件路径。 */
  currentFile(date = this.now()) {
    return path.join(this.directory, `bridge-${dayKey(date)}.log`)
  }

  /**
   * 追加一行（可多行）日志。任何 IO 错误都吞掉，只 warn 一次 ——
   * 日志写不进去，绝不能让截断 / 归纳跟着失败。
   * @param {string} level
   * @param {string} text
   * @returns {boolean} 是否真的写成功
   */
  append(level, text) {
    const body = String(text ?? '').trim()
    if (body === '') return false
    try {
      fs.mkdirSync(this.directory, { recursive: true })
      const now = this.now()
      const line = formatLogLine(now, level, body)
      const file = this.currentFile(now)
      this._rotateIfNeeded(file, now, Buffer.byteLength(line, 'utf8'))
      fs.appendFileSync(file, line, 'utf8')
      return true
    } catch (error) {
      if (!this._warned) {
        this._warned = true
        this.logger?.warn?.(`操作日志写盘失败（后续不再刷屏，功能继续）：${error?.message ?? error}`)
      }
      return false
    }
  }

  /**
   * 当前文件加上即将写入的字节数超过上限 → 把旧文件改名成
   * `bridge-YYYY-MM-DD_HHmmss.log`，下一次 append 自然创建新的当天文件。
   * @param {string} file
   * @param {Date} now
   * @param {number} incoming
   */
  _rotateIfNeeded(file, now, incoming) {
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      return // 文件还不存在，直接写
    }
    if (size === 0) return
    if (size + incoming <= this.maxBytes) return
    const suffix = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const base = path.basename(file, '.log')
    let target = path.join(path.dirname(file), `${base}_${suffix}.log`)
    let seq = 1
    while (fs.existsSync(target)) {
      target = path.join(path.dirname(file), `${base}_${suffix}-${seq}.log`)
      seq += 1
    }
    fs.renameSync(file, target)
  }

  /**
   * 删除修改时间超过 maxDays 的 `.log`。
   *
   * 只删文件、不删目录；不跟随符号链接（只处理 readdir 的直接结果）。
   * 任何一个文件删失败都跳过，不中断其它文件。
   * @param {Date} [date] 测试可注入当前时间
   * @returns {{removed:number, scanned:number, error?:string}}
   */
  cleanup(date = this.now()) {
    const cutoff = date.getTime() - this.maxDays * 24 * 60 * 60 * 1000
    let names = []
    try {
      names = fs.readdirSync(this.directory)
    } catch {
      return { removed: 0, scanned: 0 } // 目录还不存在 = 没东西可清
    }
    let removed = 0
    let scanned = 0
    for (const name of names) {
      if (!/\.log$/iu.test(name)) continue
      const file = path.join(this.directory, name)
      scanned += 1
      try {
        const stat = fs.statSync(file)
        if (!stat.isFile()) continue
        if (stat.mtimeMs >= cutoff) continue
        fs.unlinkSync(file)
        removed += 1
      } catch { /* 单个文件失败不影响其它文件 */ }
    }
    return { removed, scanned }
  }
}
