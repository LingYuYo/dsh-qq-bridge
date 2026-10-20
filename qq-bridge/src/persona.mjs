/**
 * 人设注入（批次 4A-UI 第 2 项）。
 *
 * ## 为什么不能走 session/prompt
 * `session/prompt` 的严格 schema 只接受
 * `{requestId, sessionId, mode, content, clientTimeZone}` 且 `additionalProperties: false`
 * （证据：dsh-api-session-controller/lib/typert.host.js:1795 的 jsonSchema），
 * **没有 system / persona 参数**。所以人设无法随单条 prompt 覆盖。
 *
 * ## 为什么改 preset 而不是注入 section
 * `@deepseek-ai/dsh-persona` 在 preset 作用域里注册 `deployment:persona-prefix`
 * 段落（dsh-persona/lib/index.js:36-41），且该 preset 用 `complete: true`，
 * 人设是**唯一**系统提示词。改人设只能改这条 preset 行本身。
 *
 * ## 落到哪个文件
 * profile 用户 patch 层 `~/.dsh/profiles/desktop/cordis.patch.yml`，
 * 优先级高于 bundle 层，按 id 覆盖 `preset-qq-chat`。
 *
 * ⚠️ **最关键的安全约束**
 * patch 同 id 的 `config` 是**整体替换**而非深合并。若只写一个只含 persona 的
 * 覆盖块，会把 preset 里其余插件（tool-ask-user / todo / qq-guard / compaction）
 * 全部丢掉 —— QQ 会话会失去工具门禁，这是安全事故。
 * 因此本模块的做法是：
 *   1. 从**插件自己的 bundle patch**（权威来源）读出 preset-qq-chat 的完整定义；
 *   2. 只替换其中 persona.prefix 的文本；
 *   3. 把**完整定义**写进 profile 用户 patch 作为覆盖。
 *
 * ## 生效范围（用户已确认）
 * 只对**新建会话**生效；已有会话保留原人设与上下文，不重建。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

/** qq-chat preset 在 patch 里的 id。 */
export const PRESET_ID = 'preset-qq-chat'
const DEFAULT_PROFILE = 'desktop'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 插件 bundle patch（preset 定义的权威来源）。 */
const BUNDLE_PATCH = path.resolve(HERE, '../../plugins/dsh-qq-guard/cordis.patch.yml')

export function profileDir(profile = process.env.DSH_PROFILE || DEFAULT_PROFILE) {
  return path.join(os.homedir(), '.dsh', 'profiles', profile)
}
export function patchPath(profile) {
  return path.join(profileDir(profile), 'cordis.patch.yml')
}

/**
 * 从 YAML 文本里抠出 `- id: preset-qq-chat` 这一整块（按缩进扫描，不引 YAML 依赖）。
 * @param {string[]} lines
 * @param {number} [from] 起始搜索行
 * @returns {{ start:number, end:number, indent:string }|null} 行区间（end 不含）
 */
export function findBlock(lines, predicate, from = 0) {
  for (let i = from; i < lines.length; i++) {
    if (!predicate(lines[i])) continue
    const indent = /^(\s*)/.exec(lines[i])[1]
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      // 空行与「同级或更浅缩进的注释」都视为块可能结束：
      // 注释不属于上一项，遇到就截断（否则会把后面的说明文字吞进来）。
      if (line.trim() === '') continue
      const ind = /^(\s*)/.exec(line)[1].length
      const isComment = /^\s*#/.test(line)
      if (isComment && ind <= indent.length) { end = j; break }
      if (!isComment && ind <= indent.length && /^-\s/.test(line.slice(ind))) { end = j; break }
    }
    // 回退掉尾部空行
    while (end > i + 1 && lines[end - 1].trim() === '') end--
    return { start: i, end, indent }
  }
  return null
}

/** 找 preset-qq-chat 块。 */
export function findPresetBlock(lines, from = 0) {
  return findBlock(lines, (l) => /^\s*-\s+id:\s*['"]?preset-qq-chat['"]?\s*$/.test(l), from)
}

/** 在给定行区间里找 `prefix: |` 段落的文本范围。 */
export function findPrefixRange(lines, block) {
  for (let i = block.start + 1; i < block.end; i++) {
    const m = /^(\s*)prefix:\s*\|[-+]?\s*$/.exec(lines[i])
    if (!m) continue
    const keyIndent = m[1].length
    let end = i + 1
    while (end < block.end) {
      const line = lines[end]
      if (line.trim() === '') { end++; continue }
      const ind = /^(\s*)/.exec(line)[1].length
      if (ind <= keyIndent) break
      end++
    }
    return { start: i, end, keyIndent }
  }
  return null
}

/** 读出 bundle patch 里 preset 的完整块（去掉末行空行）。 */
export function readBundlePresetBlock(file = BUNDLE_PATCH) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const block = findPresetBlock(lines)
  if (!block) throw new Error(`在 ${file} 里没找到 preset-qq-chat`)
  // 该块以 `- insert:` 为顶层父级；我们把块本身原样取出（含自己的缩进）
  return lines.slice(block.start, block.end)
}

/**
 * 把一块 preset 定义里的 persona.prefix 换成人设文本。
 * @param {string[]} blockLines 完整 preset 块
 * @param {string} personaText
 * @returns {string[]}
 */
export function replacePrefix(blockLines, personaText) {
  const block = findPresetBlock(blockLines, 0)
  if (!block) throw new Error('块里没有 preset-qq-chat 行')
  const range = findPrefixRange(blockLines, block)
  if (!range) throw new Error('块里没有 persona prefix 段落')
  const body = String(personaText).split('\n')
    .map((l) => (l === '' ? '' : ' '.repeat(range.keyIndent + 2) + l))
  return [
    ...blockLines.slice(0, range.start),
    `${' '.repeat(range.keyIndent)}prefix: |-`,
    ...body,
    ...blockLines.slice(range.end),
  ]
}

/** 从块里读出当前的 prefix 文本（去掉公共缩进）。 */
export function extractPrefix(blockLines) {
  const block = findPresetBlock(blockLines, 0)
  if (!block) return ''
  const range = findPrefixRange(blockLines, block)
  if (!range) return ''
  const raw = blockLines.slice(range.start + 1, range.end)
  const nonEmpty = raw.filter((l) => l.trim() !== '')
  if (nonEmpty.length === 0) return ''
  const common = Math.min(...nonEmpty.map((l) => /^(\s*)/.exec(l)[1].length))
  return raw.map((l) => (l.trim() === '' ? '' : l.slice(common))).join('\n').replace(/\n+$/, '')
}

/**
 * 把用户 patch 里的 `- id: preset-qq-chat` 覆盖块整段替换成新的完整定义。
 * @param {string[]} lines
 * @param {string[]} newBlock
 * @returns {string[]}
 */
export function upsertOverride(lines, newBlock) {
  const existing = findPresetBlock(lines)
  // 判断已有的是否为「非 insert 的覆盖行」（不是 bundle 里的 insert 子行）
  if (existing && !/insert:/.test(lines.slice(Math.max(0, existing.start - 6), existing.start).join('\n'))) {
    return [...lines.slice(0, existing.start), ...newBlock, ...lines.slice(existing.end)]
  }
  return [...lines, '', '# ── 人设覆盖（由 QQ 桥接写入；删除本块即恢复 bundle 默认人设）──', ...newBlock]
}

/**
 * 写入人设。
 * @param {string} personaText 空串 = 删除覆盖、恢复默认
 * @param {object} [opts]
 * @returns {{ ok:boolean, action:string, detail?:string }}
 */
export function writePersona(personaText, opts = {}) {
  const file = opts.file ?? patchPath(opts.profile)
  const bundleFile = opts.bundleFile ?? BUNDLE_PATCH
  const text = String(personaText ?? '').trim()

  // 空 = 删除覆盖块（若存在）
  if (text === '') {
    let original
    try { original = fs.readFileSync(file, 'utf8') } catch (error) {
      if (error.code === 'ENOENT') return { ok: true, action: 'noop-default' }
      return { ok: false, action: 'read-failed', detail: error.message }
    }
    const lines = original.split('\n')
    const existing = findPresetBlock(lines)
    if (!existing) return { ok: true, action: 'noop-default' }
    fs.writeFileSync(file, [...lines.slice(0, existing.start), ...lines.slice(existing.end)].join('\n'), 'utf8')
    return { ok: true, action: 'removed-override' }
  }

  // 非空 = 完整覆盖（含其余插件，绝不能只写 persona）
  let block
  try { block = readBundlePresetBlock(bundleFile) } catch (error) {
    return { ok: false, action: 'bundle-read-failed', detail: error.message }
  }
  const withPersona = replacePrefix(block, text)
  // 覆盖行必须去掉 bundle 层的外层缩进，成为 profile patch 的顶层项
  const dedented = dedentBlock(withPersona)

  let original = '[]\n'
  try { original = fs.readFileSync(file, 'utf8') } catch (error) {
    if (error.code !== 'ENOENT') return { ok: false, action: 'read-failed', detail: error.message }
  }
  const next = upsertOverride(original.split('\n'), dedented)
  try {
    fs.writeFileSync(file, next.join('\n'), 'utf8')
  } catch (error) {
    return { ok: false, action: 'write-failed', detail: error.message }
  }
  return { ok: true, action: 'upserted-override' }
}

/** 去掉块内公共缩进，让它成为 profile patch 的顶层项。 */
function dedentBlock(blockLines) {
  const nonEmpty = blockLines.filter((l) => l.trim() !== '')
  if (nonEmpty.length === 0) return blockLines
  const common = Math.min(...nonEmpty.map((l) => /^(\s*)/.exec(l)[1].length))
  return blockLines.map((l) => (l.trim() === '' ? '' : l.slice(common)))
}

/** 读出当前 bundle 的默认人设（给 UI 的「恢复默认」按钮做参考）。 */
export function readDefaultPersona(bundleFile = BUNDLE_PATCH) {
  try { return extractPrefix(readBundlePresetBlock(bundleFile)) } catch { return '' }
}
