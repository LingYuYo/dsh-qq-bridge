/**
 * 「模型自己编的舞台提示」清洗（2026-10-27）。
 *
 * ## 为什么 DSH 侧也要做一遍
 * 真机现象：模型调完 `qq_send_image` 之后，会在正文末尾补一句
 * `[无文字回复，已在同一条里发了表情包]`。
 * qq-bridge 发送前已经会清洗（`qq-bridge/src/bridge.mjs` 的 `stripMetaNotes`），
 * 所以 QQ 里看不到这行 —— 但 **DSH 面板显示的是模型原始输出**，那行还挂着，
 * 既难看，又会留在会话历史里被下一轮模型学舌。
 *
 * 修法：把同一条规则搬到 DSH 的模型输出流上（`llm/stream` 里过滤文本增量）。
 * 只作用于桥接接管过的 QQ 会话（见 `model-override.js` 的 `managedEntryFor`），
 * 用户在浏览器里自己聊的会话完全不动。
 *
 * ## 规则（与 qq-bridge 保持一致，宁窄勿宽）
 *   · 一对括号里命中 {@link META_NOTE_KEYWORDS} → 整组删掉；
 *   · 普通方括号内容（`[CQ:at,...]`、`【公告】`、`[图片]`）一律不动。
 *
 * 两份实现（bridge / guard）在两个进程里，不共享模块；改一处要同步改另一处。
 */

/** 只认这些和「发图 / 无文字」有关的词 —— 别的括号内容不碰。 */
export const META_NOTE_KEYWORDS = Object.freeze([
  '无文字回复',
  '已在同一条',
  '已发到 QQ',
  '已发到QQ',
  '已发表情包',
  '已发送表情包',
  '表情包已发送',
  '已发图片',
  '已发送图片',
  '图片已发送',
  '已发图',
])

/** 括号说明的两种外形：半角/全角方括号与圆括号。 */
const BRACKET_GROUP_RE = /[\[【（(][^\[\]【】（）()]*[\]】）)]/gu
const WHOLE_BRACKET_RE = /^[\[【（(][\s\S]*[\]】）)]$/u

/** 括号配对表（流式过滤时按「开括号」找对应的闭括号）。 */
const BRACKET_PAIRS = Object.freeze({ '[': ']', '【': '】', '（': '）', '(': ')' })

/**
 * 一段括号内容是不是「舞台提示」。
 * @param {unknown} text
 * @returns {boolean}
 */
export function looksLikeMetaNote(text) {
  const value = String(text ?? '')
  return META_NOTE_KEYWORDS.some((word) => value.includes(word))
}

/**
 * 清洗一整段文本里舞台提示（与 qq-bridge 的同名函数同口径）。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function stripMetaNotes(text) {
  const lines = String(text ?? '').split(/\r?\n/u)
  const kept = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') { kept.push(''); continue }
    if (WHOLE_BRACKET_RE.test(trimmed) && looksLikeMetaNote(trimmed)) continue
    const cleaned = line.replace(BRACKET_GROUP_RE, (group) => (looksLikeMetaNote(group) ? '' : group))
    if (cleaned.trim() !== '') kept.push(cleaned)
  }
  return kept.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

/**
 * 清洗「整块文本」（`block-end` chunk 里那份最终正文）。
 *
 * 和 {@link stripMetaNotes} 的区别：**绝不重排 / 合并原生换行**（红线：原生换行不合并），
 * 只做两件事：
 *   · 整行都是舞台提示 → 这一行连同换行一起删掉（不留空行）；
 *   · 行内夹着舞台提示 → 只抠掉括号那一段。
 * 为什么必须单独做：适配器可能在 `block-end` 里直接给出拼好的最终正文
 * （dsh-llm 的 `case "block-end"` 优先用 `chunk.block`），只过滤 delta 的话，
 * 面板上的实时文本干净了、落库的最终正文里那行还在，仍然会被学舌。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function stripMetaNotesInBlock(text) {
  const source = String(text ?? '')
  if (source === '') return source
  const kept = []
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '' && WHOLE_BRACKET_RE.test(trimmed) && looksLikeMetaNote(trimmed)) continue
    kept.push(line.replace(BRACKET_GROUP_RE, (group) => (looksLikeMetaNote(group) ? '' : group)))
  }
  return kept.join('\n')
}

/**
 * 一段「可能还没写完」的括号最长允许多少字符。
 *
 * 舞台提示都很短（真机那句 20 来个字）。超过这个长度还没等到闭括号，
 * 说明它本来就不是提示（模型在写代码块、公式、引用…），直接把首字符放出去，
 * 绝不无限期扣着用户可见的输出。
 */
const MAX_PENDING = 160

/**
 * 流式过滤器：`push()` 吐「现在就能安全显示」的文本，`flush()` 吐缓冲区里剩下的。
 *
 * 为什么需要它：`llm/stream` 给的是**增量**文本（`text-delta`），一句提示可能
 * 被拆成好几个 chunk（`[无文字` / `回复，已在同一条` / `里发了表情包]`）。
 * 所以遇到开括号时必须先把这一段扣住，等闭括号到了再决定「删」还是「放」。
 * 扣住的时间 = 一个括号的时间，正常回复（不带括号）是**零延迟**透传。
 */
export function createMetaNoteStreamFilter() {
  let buffer = ''
  /** 是否正处于「已经放出了开括号之前的内容」的状态（仅调试用，不影响逻辑）。 */
  let stripped = false

  /**
   * 把缓冲区里已经能判定的部分吐出来。
   * @returns {string}
   */
  const drain = () => {
    let out = ''
    while (buffer.length > 0) {
      // 找最早的开括号；它前面的内容一定安全。
      let openAt = -1
      for (let i = 0; i < buffer.length; i++) {
        if (BRACKET_PAIRS[buffer[i]] !== undefined) { openAt = i; break }
      }
      if (openAt === -1) {
        out += buffer
        buffer = ''
        break
      }
      if (openAt > 0) {
        out += buffer.slice(0, openAt)
        buffer = buffer.slice(openAt)
      }
      const opener = buffer[0]
      const closer = BRACKET_PAIRS[opener]
      const closeAt = buffer.indexOf(closer, 1)
      if (closeAt !== -1) {
        const group = buffer.slice(0, closeAt + 1)
        if (looksLikeMetaNote(group)) stripped = true
        else out += group
        buffer = buffer.slice(closeAt + 1)
        continue
      }
      // 还没等到闭括号：太长了说明不是提示，放掉首字符继续。
      if (buffer.length > MAX_PENDING) {
        out += buffer[0]
        buffer = buffer.slice(1)
        continue
      }
      break
    }
    return out
  }

  return {
    /**
     * 喂一段增量，返回可以立刻显示的部分（可能为空串）。
     * @param {unknown} text
     * @returns {string}
     */
    push(text) {
      const value = String(text ?? '')
      if (value === '') return ''
      buffer += value
      return drain()
    },
    /**
     * 流结束 / 遇到非文本 chunk 时把剩下的一股脑放出去（可能是不完整的括号）。
     * @returns {string}
     */
    flush() {
      const out = buffer
      buffer = ''
      return out
    },
    /** 这次流里是否真的删掉过内容（测试与日志用）。 */
    get didStrip() { return stripped },
    /** 当前扣住的字符数（测试用）。 */
    get pending() { return buffer.length },
  }
}

/**
 * 给一条 `llm/stream` 的 chunk 流套上清洗（只动文本内容，不碰结构）。
 *
 * 语义保证：
 *   · 非文本 block 原样透传，**类型 / 字段一个不改**；
 *   · `text-delta` 只改 `text`，`type` / `index` 原样保留；过滤后为空的 chunk 直接丢掉
 *     （空 delta 没有意义）；
 *   · `block-end` 里如果带拼好的最终正文（`chunk.block.text`），同样清洗 ——
 *     dsh-llm 的组装器优先用这份 `block`，不清这里的话面板实时文本干净、落库的正文
 *     还留着那行，下一轮模型照样学舌；
 *   · 顺序：遇到非文本 chunk 前先把扣住的文本放出去，绝不把文字挪到工具调用后面。
 *
 * @param {AsyncIterable<any>} source
 * @returns {AsyncIterable<any>}
 */
export function withMetaNoteFilter(source) {
  return (async function* filtered() {
    const filter = createMetaNoteStreamFilter()
    /** 最近一个文本块的 index（放残留文本时要用它，否则块会挂错位置）。 */
    let lastIndex = 0
    const iterator = source[Symbol.asyncIterator]()
    try {
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        const chunk = next.value
        if (chunk && typeof chunk === 'object' && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          lastIndex = Number.isFinite(chunk.index) ? chunk.index : lastIndex
          let out
          try {
            out = filter.push(chunk.text)
          } catch {
            // 过滤器出任何岔子都退回原文，绝不吞字。
            out = filter.flush() + chunk.text
          }
          if (out !== '') yield { ...chunk, text: out }
          continue
        }
        // 非文本 chunk：先把扣住的半截文本放出去，保住顺序。
        const rest = filter.flush()
        if (rest !== '') yield { type: 'text-delta', index: lastIndex, text: rest }
        // block-end 带最终正文时也要清（见上面注释）。
        if (
          chunk && typeof chunk === 'object'
          && (chunk.type === 'block-end' || chunk.type === 'block-start')
          && chunk.block && typeof chunk.block === 'object'
          && (chunk.block.type === undefined || chunk.block.type === 'text')
          && typeof chunk.block.text === 'string'
        ) {
          const cleaned = stripMetaNotesInBlock(chunk.block.text)
          if (cleaned !== chunk.block.text) {
            yield { ...chunk, block: { ...chunk.block, text: cleaned } }
            continue
          }
        }
        yield chunk
      }
      const rest = filter.flush()
      if (rest !== '') yield { type: 'text-delta', index: lastIndex, text: rest }
    } finally {
      // 消费方提前 return（取消 / 中断）时也要把上游关掉，看门狗同样是不 await 的写法。
      try {
        const closing = iterator.return?.()
        if (closing && typeof closing.catch === 'function') closing.catch(() => {})
      } catch { /* 忽略 */ }
    }
  })()
}
