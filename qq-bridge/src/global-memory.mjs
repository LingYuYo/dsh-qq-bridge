/**
 * 跨群特别记忆（L3 全局记忆层雏形）—— 独立存储 + 关键词检索。
 *
 * 为什么不塞进 sessions.json：
 *   · 跨群数据要跨会话复用，且 sessions.json 每来一条消息就整文件重写；
 *   · 全局记忆需要自己的容量上限、过期与人工编辑生命周期。
 *
 * 为什么不上向量：
 *   当前规模 ≤ 500 条，桥接又是离线进程（没有 embedding 服务）。
 *   中文用「二元组」切分 + 英文/数字 token 已足够召回；`embedding` 字段先留空，
 *   将来规模上去了再加，`search()` 的调用方接口不变。
 *
 * 设计要点：
 *   · `scope.global = false` 的记忆只对 `scope.groups` 里的群可见（防跨群串台）；
 *   · `expiresAt <= now` 直接不参与检索；
 *   · 检索命中才注入 Prompt，0 命中 = 0 token。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** 默认文件名（放在 state/ 下，与 sessions.json 同级）。 */
export const GLOBAL_MEMORY_FILE = 'global_memory.json'

/** 默认容量上限。 */
export const MAX_GLOBAL_MEMORY_ITEMS = 500

/** 默认检索条数与注入预算。 */
export const DEFAULT_TOP_K = 3
export const DEFAULT_BUDGET_CHARS = 600

/** 单条正文上限（存储与注入都按这个截断）。 */
const TEXT_MAX = 500
const TITLE_MAX = 60
const DAY_MS = 24 * 60 * 60 * 1000

/** 归一化空白。 */
function normText(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

/**
 * 关键词切分：中文按**二元组**（单字词保留单字），英文/数字按词。
 * @param {string} text
 * @returns {string[]} 去重后的 token
 */
export function tokenize(text) {
  const raw = normText(text).toLowerCase()
  if (raw === '') return []
  const tokens = new Set()
  for (const match of raw.matchAll(/[\u4e00-\u9fff]+/gu)) {
    const run = match[0]
    if (run.length === 1) tokens.add(run)
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2))
  }
  for (const match of raw.matchAll(/[a-z0-9_]{2,}/gu)) tokens.add(match[0])
  return [...tokens]
}

/** 归一化一条记忆（字段长度 / 类型全部收敛）。 */
export function normalizeMemoryItem(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const key = normText(value.key).slice(0, 120)
  const text = normText(value.text).slice(0, TEXT_MAX)
  if (key === '' || text === '') return null
  const kind = ['person', 'fact', 'preference'].includes(value.kind) ? value.kind : 'fact'
  const qq = /^\d{1,20}$/u.test(String(value.qq ?? '').trim()) ? String(value.qq).trim() : ''
  const tags = Array.isArray(value.tags)
    ? [...new Set(value.tags.map((tag) => normText(tag).slice(0, 20)).filter(Boolean))].slice(0, 8)
    : []
  const groups = Array.isArray(value.scope?.groups)
    ? [...new Set(value.scope.groups.map((group) => String(group ?? '').trim()).filter(Boolean))].slice(0, 20)
    : []
  const at = Number(value.updatedAt) || now
  return {
    id: typeof value.id === 'string' && value.id !== '' ? value.id : `gm_${randomUUID()}`,
    kind,
    key,
    qq,
    title: normText(value.title).slice(0, TITLE_MAX),
    text,
    tags,
    scope: {
      // 默认全局可见；显式 false 时只对 groups 里的群可见。
      global: value.scope?.global !== false,
      groups,
    },
    source: {
      group: typeof value.source?.group === 'string' ? value.source.group.slice(0, 40) : '',
      at: Number(value.source?.at) || now,
      by: ['manual', 'hourly', 'command'].includes(value.source?.by) ? value.source.by : 'manual',
    },
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0.6)),
    hits: Math.max(0, Math.floor(Number(value.hits) || 0)),
    createdAt: Number(value.createdAt) || now,
    updatedAt: at,
    expiresAt: Number(value.expiresAt) > 0 ? Math.floor(Number(value.expiresAt)) : 0,
    // 预留：将来上向量时填。现在不读写。
    embedding: null,
  }
}

/**
 * 合并同 key 的记忆：正文以新值为准，标签并集，置信度取大，创建时间保留。
 * @param {object} existing
 * @param {object} incoming 已归一化
 * @param {number} [now]
 */
export function mergeMemoryItem(existing, incoming, now = Date.now()) {
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    key: existing.key,
    title: incoming.title || existing.title,
    text: incoming.text || existing.text,
    tags: [...new Set([...(existing.tags ?? []), ...(incoming.tags ?? [])])].slice(0, 8),
    scope: {
      global: incoming.scope.global,
      groups: [...new Set([...(existing.scope?.groups ?? []), ...(incoming.scope.groups ?? [])])].slice(0, 20),
    },
    confidence: Math.max(Number(existing.confidence) || 0, Number(incoming.confidence) || 0),
    hits: Math.max(Number(existing.hits) || 0, Number(incoming.hits) || 0),
    createdAt: existing.createdAt || incoming.createdAt || now,
    updatedAt: now,
    expiresAt: incoming.expiresAt || existing.expiresAt || 0,
  }
}

/**
 * 计算单条记忆对当前上下文的匹配分。返回 null = 不参与。
 * @param {object} item
 * @param {{tokens:string[], senderQq:string, chatKey:string, now:number}} query
 * @returns {number|null}
 */
export function scoreMemoryItem(item, query) {
  const now = query.now
  if (item.expiresAt > 0 && item.expiresAt <= now) return null
  const groups = item.scope?.groups ?? []
  if (item.scope?.global === false && groups.length > 0 && !groups.includes(query.chatKey)) return null

  let score = 0
  // 1) QQ 强命中：同一个人在不同群的记忆，只要他说话就该带上。
  const strong = item.kind === 'person' && item.qq !== '' && item.qq === query.senderQq
  if (strong) score += 10

  // 2) 关键词命中（标题 / 标签 / 正文）。
  const hay = tokenize(`${item.title} ${(item.tags ?? []).join(' ')} ${item.text}`)
  const haySet = new Set(hay)
  let hits = 0
  for (const token of query.tokens) {
    if (haySet.has(token)) hits += 1
  }
  if (hits > 0) score += Math.min(6, hits * 2)

  // 没有任何实质命中时，置信度再高也不该被检索出来（0 命中 = 0 token）。
  if (!strong && hits === 0) return null

  // 3) 群相关 + 置信度 - 时间衰减。
  if (groups.includes(query.chatKey)) score += 1
  score += Math.max(0, Math.min(1, Number(item.confidence) || 0))
  if (now - (Number(item.updatedAt) || 0) > 90 * DAY_MS) score -= 1

  return score > 0 ? score : null
}

/**
 * 纯函数版检索（测试与类共用）。
 * @param {object[]} items
 * @param {{text?:string, senderQq?:string, chatKey?:string, topK?:number, budgetChars?:number, now?:number}} query
 * @returns {object[]} 命中条目（已截断正文）
 */
export function searchMemoryItems(items, query = {}) {
  const now = Number(query.now) || Date.now()
  const tokens = tokenize(query.text)
  const senderQq = String(query.senderQq ?? '').trim()
  const chatKey = String(query.chatKey ?? '')
  const topK = Math.max(1, Math.floor(Number(query.topK) || DEFAULT_TOP_K))
  const budgetChars = Math.max(1, Math.floor(Number(query.budgetChars) || DEFAULT_BUDGET_CHARS))

  const scored = []
  for (const item of Array.isArray(items) ? items : []) {
    const score = scoreMemoryItem(item, { tokens, senderQq, chatKey, now })
    if (score === null) continue
    scored.push({ item, score })
  }
  scored.sort((left, right) => right.score - left.score
    || (Number(right.item.updatedAt) || 0) - (Number(left.item.updatedAt) || 0))

  const out = []
  let used = 0
  for (const { item } of scored) {
    if (out.length >= topK) break
    const text = normText(item.text).slice(0, 200)
    if (text === '') continue
    if (used + text.length > budgetChars) continue
    used += text.length
    out.push({ ...item, text })
  }
  return out
}

/** 淘汰排序：命中少、更新旧、置信度低的先删。 */
function evictionRank(item) {
  return (Number(item.hits) || 0) * 1000 - (Number(item.confidence) || 0) * 10
    - (Number(item.updatedAt) || 0) / 1e12
}

/**
 * 全局记忆文件。
 *
 * 只做 IO + 内存表；检索/合并是上面的纯函数，方便单测。
 */
export class GlobalMemory {
  /**
   * @param {object} options
   * @param {string} options.dir 状态目录（与 sessions.json 同级）
   * @param {string} [options.fileName]
   * @param {number} [options.maxItems]
   * @param {() => number} [options.now]
   * @param {{warn?:Function}} [options.logger]
   */
  constructor({ dir, fileName = GLOBAL_MEMORY_FILE, maxItems = MAX_GLOBAL_MEMORY_ITEMS, now, logger } = {}) {
    this.dir = path.resolve(String(dir ?? './state'))
    this.file = path.join(this.dir, fileName)
    this.maxItems = Math.max(1, Math.floor(Number(maxItems) || MAX_GLOBAL_MEMORY_ITEMS))
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.logger = logger
    this.items = []
    this._warned = false
    this._dirty = false
    this._saveTimer = null
  }

  /** 从磁盘加载；损坏时备份成 .bak 并以空表启动。 */
  load() {
    try {
      if (!fs.existsSync(this.file)) {
        this.items = []
        return this
      }
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed?.items) ? parsed.items : []
      this.items = list
        .map((item) => normalizeMemoryItem(item, this.now()))
        .filter(Boolean)
      this.prune()
      return this
    } catch (error) {
      this.logger?.warn?.(`跨群记忆文件损坏，已备份并重新开始：${error?.message ?? error}`)
      try {
        fs.renameSync(this.file, `${this.file}.bak`)
      } catch { /* 备份失败也不阻塞启动 */ }
      this.items = []
      return this
    }
  }

  /** 原子写盘。失败只 warn（不影响聊天）。 */
  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: this.now(), items: this.items }, null, 2))
      fs.renameSync(tmp, this.file)
      this._dirty = false
    } catch (error) {
      if (!this._warned) {
        this._warned = true
        this.logger?.warn?.(`跨群记忆写盘失败（不影响聊天）：${error?.message ?? error}`)
      }
    }
  }

  /** 延迟落盘（检索会累加 hits，没必要每条消息都写）。 */
  _scheduleSave() {
    this._dirty = true
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      if (this._dirty) this.save()
    }, 5000)
    if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref()
  }

  /** 立即落盘并清掉待写计时器（进程退出用）。 */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    if (this._dirty) this.save()
  }

  list() {
    return this.items.map((item) => ({ ...item }))
  }

  /**
   * 写入或合并一条记忆（同 key 合并）。
   * @param {object} entry
   * @returns {object|null} 写入后的条目
   */
  upsert(entry) {
    const incoming = normalizeMemoryItem(entry, this.now())
    if (!incoming) return null
    const index = this.items.findIndex((item) => item.key === incoming.key)
    if (index >= 0) {
      this.items[index] = mergeMemoryItem(this.items[index], incoming, this.now())
    } else {
      this.items.push(incoming)
    }
    this.prune()
    this.save()
    return index >= 0 ? { ...this.items[index] } : { ...incoming }
  }

  /** 按 id 或 key 删除。 */
  remove(idOrKey) {
    const target = String(idOrKey ?? '')
    const before = this.items.length
    this.items = this.items.filter((item) => item.id !== target && item.key !== target)
    if (this.items.length !== before) this.save()
    return before - this.items.length
  }

  /**
   * 检索：命中才返回，0 命中 = 空数组。
   * @param {object} query 见 searchMemoryItems
   */
  search(query = {}) {
    const hits = searchMemoryItems(this.items, { ...query, now: this.now() })
    if (hits.length > 0) {
      const byId = new Map(hits.map((item) => [item.id, item]))
      for (const item of this.items) {
        if (byId.has(item.id)) item.hits += 1
      }
      this._scheduleSave()
    }
    return hits
  }

  /** 清理过期 + 超量淘汰。 */
  prune() {
    const now = this.now()
    const before = this.items.length
    this.items = this.items.filter((item) => !(item.expiresAt > 0 && item.expiresAt <= now))
    if (this.items.length > this.maxItems) {
      this.items.sort((left, right) => evictionRank(right) - evictionRank(left))
      this.items = this.items.slice(0, this.maxItems)
    }
    if (this.items.length !== before) this._dirty = true
    return before - this.items.length
  }
}
