/**
 * 历史会话批量改名：纯计划函数（不碰网络/磁盘，方便测试）。
 *
 * 输入是「DSH 会话列表」+「桥接 state.sessions 映射」，输出每条会话该不该改名。
 * 真正的 rename 由 tools/rename-sessions.mjs 执行。
 */

import { normalizeSessionEntry, sessionTitleFor } from './bridge.mjs'

/**
 * @param {object} opts
 * @param {Array<object>} opts.sessions DSH `session/list` 的 items
 * @param {object} opts.state 桥接 state（{ sessions: { key: value } }）
 * @param {string} [opts.cwd] 只处理该目录下的会话（桥接 config 的 dsh.sessionCwd）
 * @param {boolean} [opts.includeSubagent=false] subagent 会话默认跳过
 * @returns {Array<{sessionId:string, key:string|null, current:string, expected:string|null, action:string}>}
 */
export function planRenames({ sessions, state, cwd = '', includeSubagent = false } = {}) {
  const list = Array.isArray(sessions) ? sessions : []
  // sessionId → key（映射值可能是旧版字符串或新版对象）
  const bySession = new Map()
  const raw = state && typeof state === 'object' && state.sessions && typeof state.sessions === 'object'
    ? state.sessions
    : {}
  for (const [key, value] of Object.entries(raw)) {
    const entry = normalizeSessionEntry(key, value)
    if (entry.sessionId) bySession.set(entry.sessionId, { key, entry })
  }
  const targetCwd = typeof cwd === 'string' ? cwd.trim() : ''

  const plan = []
  for (const session of list) {
    const sessionId = String(session?.sessionId ?? '')
    if (!sessionId) continue
    const origin = session?.origin
    if (!includeSubagent && origin === 'subagent') continue
    const sessionCwd = typeof session?.cwd === 'string' ? session.cwd : ''
    if (targetCwd && sessionCwd && !samePath(sessionCwd, targetCwd)) continue
    if (targetCwd && !sessionCwd) continue

    const mapped = bySession.get(sessionId)
    const current = titleOf(session)
    if (mapped === undefined) {
      plan.push({ sessionId, key: null, current, expected: null, action: 'skip-no-mapping' })
      continue
    }
    const expected = sessionTitleFor(mapped.entry.kind, mapped.entry.name, mapped.entry.qq)
    let action = 'skip-unchanged'
    if (current !== expected) action = 'rename'
    plan.push({ sessionId, key: mapped.key, current, expected, action })
  }
  return plan
}

/** 从 session/list item 里取标题（冷行可能没有 projections）。 */
export function titleOf(session) {
  const value = session?.projections?.values?.title
  if (typeof value === 'string') return value
  if (typeof value?.title === 'string') return value.title
  return ''
}

function samePath(left, right) {
  const norm = (value) => String(value ?? '').replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase()
  return norm(left) === norm(right)
}
