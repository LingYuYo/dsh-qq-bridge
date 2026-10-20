/**
 * 人设写入回归（离线，不碰真实 profile）。
 *
 * 核心验证点：
 *   ① 写人设后，preset 覆盖块**仍包含全部插件**（qq-guard / tool-ask-user / todo / compaction）
 *      —— 这是安全红线：patch 是同 id 整体替换，漏了就丢工具门禁。
 *   ② 只替换 persona.prefix，其余字段逐字不变。
 *   ③ 空人设 = 删除覆盖，恢复默认。
 *   ④ 反复写入不产生重复块。
 *   ⑤ 输出是合法 YAML 且结构正确（用最小解析器校验缩进层级）。
 *
 * 运行：node qq-bridge/test-persona.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  writePersona, readBundlePresetBlock, extractPrefix, findPresetBlock, findPrefixRange,
  readDefaultPersona,
} from './src/persona.mjs'

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-'))
const patchFile = path.join(tmpDir, 'cordis.patch.yml')

const resetPatch = (content = '# profile patch\n\n- id: some-other-row\n  config:\n    x: 1\n') => {
  fs.writeFileSync(patchFile, content, 'utf8')
}
const readPatch = () => fs.readFileSync(patchFile, 'utf8')

/** 极简缩进校验：每行缩进必须是 2 的倍数（YAML 块标量除外）。 */
function assertIndentSanity(text) {
  const lines = text.split('\n')
  const block = findPresetBlock(lines)
  assert.ok(block, '应能找到 preset 块')
  for (let i = block.start; i < block.end; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const ind = /^(\s*)/.exec(line)[1].length
    assert.equal(ind % 2, 0, `第 ${i + 1} 行缩进不是 2 的倍数：${JSON.stringify(line)}`)
  }
}

console.log('— 默认人设读取 —')
check('能从 bundle patch 读出默认人设（非空）', () => {
  const def = readDefaultPersona()
  assert.ok(def.length > 100, `默认人设太短：${def.length}`)
  assert.ok(def.includes('DeepSeek'), '默认人设应含 DeepSeek')
})

console.log('\n— ① 写人设后保留全部插件（安全红线）—')
check('写入「傲娇猫娘」后 qq-guard 仍在覆盖块里', () => {
  resetPatch()
  const r = writePersona('你是一只傲娇猫娘，说话要带「哼」和「才不是呢」。', { file: patchFile })
  assert.equal(r.ok, true, JSON.stringify(r))
  const text = readPatch()
  assert.ok(text.includes('@local/dsh-qq-guard'), '★ 覆盖块必须保留 qq-guard，否则 QQ 会话失去工具门禁')
  assert.ok(text.includes('tool-ask-user'), '应保留 ask_user_question')
  assert.ok(text.includes('tool-todo'), '应保留 todo')
  assert.ok(text.includes('compaction'), '应保留 compaction 组')
  assert.ok(text.includes('傲娇猫娘'), '应写入新人设')
})
check('原有其它行不被破坏', () => {
  resetPatch()
  writePersona('你好', { file: patchFile })
  const text = readPatch()
  assert.ok(text.includes('- id: some-other-row'), '其它配置行应保留')
  assert.ok(text.includes('x: 1'))
})

console.log('\n— ② 只替换 prefix，其余逐字不变 —')
check('除 prefix 外，块内容与 bundle 一致', () => {
  resetPatch()
  writePersona('新的人设文本', { file: patchFile })
  const written = readPatch()
  const bundle = readBundlePresetBlock()
  const bundleText = bundle.join('\n')
  // 取出写入块
  const lines = written.split('\n')
  const block = findPresetBlock(lines)
  const writtenText = lines.slice(block.start, block.end).join('\n')
  // 归一化缩进后比较「非 prefix 部分」
  const stripPrefix = (txt) => {
    const ls = txt.split('\n')
    const b = findPresetBlock(ls)
    const r = findPrefixRange(ls, b)
    return [...ls.slice(0, r.start), '@@PREFIX@@', ...ls.slice(r.end)]
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .join('\n')
  }
  assert.equal(stripPrefix(writtenText), stripPrefix(bundleText), '非 prefix 内容应与 bundle 完全一致')
})

console.log('\n— ③ 空人设 = 删除覆盖 —')
check('空串删除覆盖块', () => {
  resetPatch()
  writePersona('临时人设', { file: patchFile })
  assert.ok(readPatch().includes('preset-qq-chat'), '先确认写入成功')
  const r = writePersona('', { file: patchFile })
  assert.equal(r.action, 'removed-override', JSON.stringify(r))
  assert.ok(!readPatch().includes('preset-qq-chat'), '覆盖块应被删除')
  assert.ok(readPatch().includes('some-other-row'), '其它行应保留')
})
check('从未写过时清空是 noop', () => {
  resetPatch()
  const r = writePersona('', { file: patchFile })
  assert.equal(r.action, 'noop-default', JSON.stringify(r))
})

console.log('\n— ④ 反复写入不重复 —')
check('连写三次只有一块', () => {
  resetPatch()
  writePersona('第一版', { file: patchFile })
  writePersona('第二版', { file: patchFile })
  writePersona('第三版', { file: patchFile })
  const text = readPatch()
  const count = (text.match(/preset-qq-chat/g) || []).length
  assert.equal(count, 1, `应只有 1 处 preset-qq-chat，实际 ${count}`)
  assert.ok(text.includes('第三版'), '应是最后一次的内容')
  assert.ok(!text.includes('第一版'), '旧内容应被替换')
})

console.log('\n— ⑤ 结构合理性与人设往返 —')
check('缩进合法', () => {
  resetPatch()
  writePersona('你是一只傲娇猫娘。\n\n第二段：说话要短。', { file: patchFile })
  assertIndentSanity(readPatch())
})
check('多行人设可往返读取', () => {
  resetPatch()
  const text = '第一行\n第二行带符号：!@#\n\n第四行'
  writePersona(text, { file: patchFile })
  const lines = readPatch().split('\n')
  const block = findPresetBlock(lines)
  const got = extractPrefix(lines.slice(block.start, block.end))
  assert.equal(got, text, `往返不一致：${JSON.stringify(got)}`)
})

fs.rmSync(tmpDir, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
