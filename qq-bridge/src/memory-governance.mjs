/**
 * 记忆治理：回收站（两阶段删除）+ 每日备份 + 一键恢复。
 *
 * 为什么独立成模块：
 *   · 回收站与备份都是「文件生命周期」，和聊天逻辑无关，单独测试更稳；
 *   · bridge 只负责「删哪条、什么时候删」，物理文件交给这里。
 *
 * 两阶段删除：
 *   ① 阶段一（立即）：数据从可见存储移出（L3 条目 / L2 摘要置空），同时把完整
 *      payload 写进 `memory_trash.json` —— 检索与 Prompt 立刻看不到它；
 *   ② 阶段二（5 分钟后）：后台清理任务把过期条目从 trash 物理删除。
 *   窗口期内 `/撤销删除` 可以把 payload 原样放回去。
 *
 * 备份：
 *   `state/backups/backup-YYYYMMDD-HHmmss.json.gz`，内容是 sessions.json 与
 *   global_memory.json 的原始 JSON 快照；保留最近 7 天。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** 回收站文件名。 */
export const TRASH_FILE = 'memory_trash.json'

/** 撤销窗口（毫秒）：默认 5 分钟。 */
export const TRASH_TTL_MS = 5 * 60 * 1000

/** 备份保留天数。 */
export const BACKUP_KEEP_DAYS = 7

/** 备份目录名（state/backups）。 */
export const BACKUP_DIR = 'backups'

const BACKUP_NAME_RE = /^backup-\d{8}-\d{6}\.json\.gz$/u

function normText(value, max = 200) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max)
}

/** 生成一个回收站条目 id。 */
function trashId(now) {
  return `trash_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 回收站：保存被删除数据的完整 payload，5 分钟后物理丢弃。
 */
export class TrashStore {
  /**
   * @param {object} options
   * @param {string} options.dir state 目录
   * @param {number} [options.ttlMs]
   * @param {() => number} [options.now]
   * @param {{warn?:Function}} [options.logger]
   */
  constructor({ dir, ttlMs = TRASH_TTL_MS, now, logger } = {}) {
    this.dir = path.resolve(String(dir ?? './state'))
    this.file = path.join(this.dir, TRASH_FILE)
    this.ttlMs = Math.max(1000, Number(ttlMs) || TRASH_TTL_MS)
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.logger = logger
    this.entries = []
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return this
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.entries = Array.isArray(parsed?.entries)
        ? parsed.entries.filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string')
        : []
      this.purgeExpired()
      return this
    } catch (error) {
      this.logger?.warn?.(`回收站文件损坏，已重置：${error?.message ?? error}`)
      this.entries = []
      return this
    }
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: this.now(), entries: this.entries }, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (error) {
      this.logger?.warn?.(`回收站写盘失败（不影响聊天）：${error?.message ?? error}`)
    }
  }

  /**
   * 记录一次删除意图。
   * @param {{kind:'l2'|'l3', chatKey?:string, label?:string, payload:object}} input
   */
  add({ kind, chatKey = '', label = '', payload }) {
    const now = this.now()
    const entry = {
      id: trashId(now),
      kind: kind === 'l2' ? 'l2' : 'l3',
      chatKey: normText(chatKey, 40),
      label: normText(label, 120),
      payload: payload && typeof payload === 'object' ? payload : {},
      deletedAt: now,
      purgeAt: now + this.ttlMs,
    }
    this.entries.push(entry)
    this.save()
    return { ...entry }
  }

  /** 最近的条目（新在前；同一毫秒时按写入顺序，后写的在前）。 */
  list(limit = 20) {
    return this.entries
      .slice()
      .reverse()
      .sort((left, right) => right.deletedAt - left.deletedAt)
      .slice(0, Math.max(1, limit))
      .map((entry) => ({ ...entry }))
  }

  /** 取一条（按 id 或最近一条）。 */
  get(id = '') {
    const target = String(id ?? '')
    if (target === '') {
      const sorted = this.list(1)
      return sorted.length > 0 ? sorted[0] : null
    }
    return this.entries.find((entry) => entry.id === target) || null
  }

  /** 撤销：取出条目并从回收站移除（物理副本交给调用方恢复）。 */
  take(id = '') {
    const target = String(id ?? '')
    const index = target === ''
      ? this.entries.reduce((best, entry, i) => (entry.deletedAt > (this.entries[best]?.deletedAt ?? -1) ? i : best), 0)
      : this.entries.findIndex((entry) => entry.id === target)
    if (index < 0 || index >= this.entries.length) return null
    const [entry] = this.entries.splice(index, 1)
    this.save()
    return { ...entry }
  }

  /** 物理清理过期条目；返回清理数量。 */
  purgeExpired() {
    const now = this.now()
    const before = this.entries.length
    this.entries = this.entries.filter((entry) => Number(entry.purgeAt) > now)
    const removed = before - this.entries.length
    if (removed > 0) this.save()
    return removed
  }
}

/** 备份文件名（本地时间）。 */
function backupName(now) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  return `backup-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.json.gz`
}

/**
 * 创建一次备份（sessions.json + global_memory.json 的原始快照）。
 * @param {object} options
 * @param {string} options.dir state 目录
 * @param {string} options.stateFile sessions.json 路径
 * @param {string} options.memoryFile global_memory.json 路径
 * @param {() => number} [options.now]
 * @returns {{ok:boolean, file?:string, bytes?:number, error?:string}}
 */
export function createBackup({ dir, stateFile, memoryFile, now } = {}) {
  try {
    const root = path.resolve(String(dir ?? './state'))
    const backupDir = path.join(root, BACKUP_DIR)
    fs.mkdirSync(backupDir, { recursive: true })
    const snapshot = {
      version: 1,
      at: (typeof now === 'function' ? now() : Date.now()),
      sessions: fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null,
      globalMemory: fs.existsSync(memoryFile) ? JSON.parse(fs.readFileSync(memoryFile, 'utf8')) : null,
    }
    const file = path.join(backupDir, backupName(snapshot.at))
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'))
    fs.writeFileSync(file, gz)
    pruneBackups(backupDir)
    return { ok: true, file, bytes: gz.length }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 只保留最近 N 天（按文件名日期，不依赖 mtime）。 */
export function pruneBackups(backupDir, keepDays = BACKUP_KEEP_DAYS) {
  try {
    const files = fs.readdirSync(backupDir).filter((name) => BACKUP_NAME_RE.test(name)).sort()
    const keep = Math.max(1, Number(keepDays) || BACKUP_KEEP_DAYS)
    for (const name of files.slice(0, Math.max(0, files.length - keep))) {
      fs.rmSync(path.join(backupDir, name), { force: true })
    }
  } catch { /* 清理失败不影响备份本身 */ }
}

/**
 * 列出可用备份（新在前）。
 * @param {string} dir state 目录
 * @returns {Array<{file:string, name:string, at:number, bytes:number}>}
 */
export function listBackups(dir) {
  const backupDir = path.join(path.resolve(String(dir ?? './state')), BACKUP_DIR)
  try {
    return fs.readdirSync(backupDir)
      .filter((name) => BACKUP_NAME_RE.test(name))
      .sort()
      .reverse()
      .map((name) => {
        const file = path.join(backupDir, name)
        const stat = fs.statSync(file)
        const match = /^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/u.exec(name)
        const at = match
          ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
            Number(match[4]), Number(match[5]), Number(match[6])).getTime()
          : stat.mtimeMs
        return { file, name, at, bytes: stat.size }
      })
  } catch {
    return []
  }
}

/**
 * 恢复一个备份：先给当前文件存 `.pre-restore-<ts>`，再写回快照。
 * @param {object} options
 * @param {string} options.dir state 目录
 * @param {string} options.file 备份文件名（只允许 basename，防路径穿越）
 * @param {string} options.stateFile
 * @param {string} options.memoryFile
 * @returns {{ok:boolean, restored?:{sessions:boolean, globalMemory:boolean}, error?:string}}
 */
export function restoreBackup({ dir, file, stateFile, memoryFile } = {}) {
  try {
    const name = path.basename(String(file ?? ''))
    if (!BACKUP_NAME_RE.test(name)) return { ok: false, error: '备份文件名不合法' }
    const backupDir = path.join(path.resolve(String(dir ?? './state')), BACKUP_DIR)
    const full = path.join(backupDir, name)
    if (!fs.existsSync(full)) return { ok: false, error: '备份文件不存在' }
    const snapshot = JSON.parse(zlib.gunzipSync(fs.readFileSync(full)).toString('utf8'))
    if (!snapshot || typeof snapshot !== 'object') return { ok: false, error: '备份内容不是合法 JSON' }
    const stamp = Date.now()
    const backupCurrent = (target) => {
      if (target && fs.existsSync(target)) {
        try { fs.copyFileSync(target, `${target}.pre-restore-${stamp}`) } catch { /* 备份当前失败也继续 */ }
      }
    }
    const restored = { sessions: false, globalMemory: false }
    if (snapshot.sessions && typeof snapshot.sessions === 'object') {
      backupCurrent(stateFile)
      fs.writeFileSync(stateFile, JSON.stringify(snapshot.sessions, null, 2))
      restored.sessions = true
    }
    if (snapshot.globalMemory && typeof snapshot.globalMemory === 'object') {
      backupCurrent(memoryFile)
      fs.writeFileSync(memoryFile, JSON.stringify(snapshot.globalMemory, null, 2))
      restored.globalMemory = true
    }
    return { ok: true, restored }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}
