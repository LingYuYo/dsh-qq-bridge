/**
 * Token 粗估与单行截断（从 bridge.mjs 抽出来的公共件）。
 *
 * 为什么要单独一个文件：桥接与「智能未读归纳」都要按预算裁上下文，
 * 放在 bridge.mjs 里会形成 bridge ↔ unread-summary 的循环 import。
 * 这里只放纯函数，零依赖、不碰状态。
 */

/**
 * 粗估一段文本的 token 数（**故意偏保守，宁可高估**）。
 *
 * 为什么不接真 tokenizer：桥接是零依赖的独立进程，拉 tiktoken 进来等于给
 * 一次「估个预算」引入一个二进制依赖；而这里只需要「别超太多」。
 * 经验值：CJK 每字约 1 token，非 CJK（英文/数字/符号）约 0.3 token/字符。
 *
 * @param {string} text
 * @returns {number} 非负整数
 */
export function estimateTokens(text) {
  const source = String(text ?? '')
  if (source === '') return 0
  // CJK 统一表意文字 + 中日韩标点 + 全角符号：按字算。
  const cjk = (source.match(/[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/gu) ?? []).length
  const rest = source.length - cjk
  // 向上取整：宁可多留余量，也不要估低了把 prompt 撑爆。
  return cjk + Math.ceil(rest * 0.3)
}

/**
 * 按 token 预算截断单条聊天记录（**只截正文，保留发言人头**）。
 *
 * 场景：最新一条记录自己就超预算了。整条丢会让模型完全没有上下文，
 * 所以保留 `[群友 昵称(QQ)]: ` 前缀 + 正文开头，末尾加省略号。
 *
 * @param {string} line 已格式化的 `[群友 昵称(QQ)]: 正文`
 * @param {number} budget 这条记录可用的 token
 * @returns {string}
 */
export function truncateChatLine(line, budget) {
  const source = String(line ?? '')
  const limit = Math.max(1, Math.floor(Number(budget) || 0))
  if (estimateTokens(source) <= limit) return source
  // 前缀（`[群友 名字(QQ)]: `）尽量保住：模型靠它分辨谁说的。
  const match = /^(\[[^\]]*\]:\s)([\s\S]*)$/u.exec(source)
  const prefix = match ? match[1] : ''
  const body = match ? match[2] : source
  const prefixCost = estimateTokens(prefix)
  if (prefixCost >= limit) return `${prefix.slice(0, Math.max(1, limit))}…`
  let left = limit - prefixCost - 1 // 给省略号留 1 token
  let out = ''
  for (const ch of body) {
    const cost = estimateTokens(ch)
    if (cost > left) break
    out += ch
    left -= cost
  }
  return `${prefix}${out}…`
}
