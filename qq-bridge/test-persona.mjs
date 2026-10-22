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
import { composePersonaPrompt, PERSONA_PARTICIPATION } from './src/bridge.mjs'

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

console.log('\n— ⑥ 桥接层拼最终系统提示词（P1.5）—')
check('什么都没设置 → 空串（删除覆盖、回落到内置）', () => {
  assert.equal(composePersonaPrompt({ defaultText: '默认人设正文' }), '')
  assert.equal(composePersonaPrompt({ baseText: '  ', defaultText: '默认人设正文', participation: 'normal' }), '')
})

console.log('\n— ⑥b 底层模型自我认知（无痕热切换配套）—')
check('未配置模型 → 不追加任何模型行', () => {
  const out = composePersonaPrompt({ baseText: '设定', modelRoute: '' })
  assert.ok(!out.includes('底层模型'), `不该出现模型行：${out}`)
  assert.ok(!out.includes('DSH'), '不该出现 DSH 字样')
})

check('配置了模型 → 追加【底层模型】行，路由原样带出', () => {
  const out = composePersonaPrompt({ baseText: '设定', modelRoute: 'raccoon/sn-deepseek-v4-1-flash-1017' })
  assert.ok(out.includes('【底层模型】'), `缺少模型行：${out}`)
  assert.ok(out.includes('raccoon/sn-deepseek-v4-1-flash-1017'), '路由没带出来')
  assert.ok(out.includes('DSH'), '应说明由 DSH 提供驱动')
})

check('纯默认人设（没自定义）+ 有模型 → 仍生成覆盖，且带上默认人设正文', () => {
  const out = composePersonaPrompt({ defaultText: '默认人设正文', modelRoute: 'workbuddy/deepseek-v4.1-flash' })
  assert.ok(out.includes('默认人设正文'), '覆盖不能把默认人设正文丢掉')
  assert.ok(out.includes('workbuddy/deepseek-v4.1-flash'), '路由没带出来')
  // 没自定义时不该凭空造【参与度】段（那会让「什么都没改」看起来像改过）
  assert.ok(!out.includes('【参与度】'), `不该追加参与度：${out}`)
})

check('系统提示词覆盖 + 有模型 → 覆盖文本后追加模型行', () => {
  const out = composePersonaPrompt({ systemPrompt: '完整覆盖', modelRoute: 'raccoon/x' })
  assert.ok(out.startsWith('完整覆盖'), '覆盖文本要保留在最前')
  assert.ok(out.includes('raccoon/x'), '模型行没追加')
})

check('模型行与参与度/附加规则的顺序稳定', () => {
  const out = composePersonaPrompt({
    baseText: '设定', participation: 'quiet', extraRules: '规则', modelRoute: 'raccoon/x',
  })
  const iRole = out.indexOf('设定')
  const iPart = out.indexOf('【参与度】')
  const iRule = out.indexOf('【管理员附加规则】')
  const iModel = out.indexOf('【底层模型】')
  assert.ok(iRole < iPart && iPart < iRule && iRule < iModel, `顺序不对：${out}`)
})

check('系统提示词覆盖：非空时原样返回，忽略其它字段', () => {
  const out = composePersonaPrompt({
    systemPrompt: '完整的自定义系统提示词',
    baseText: '角色设定', botName: '小鱼', extraRules: '附加规则', participation: 'active',
  })
  assert.equal(out, '完整的自定义系统提示词')
  assert.ok(!out.includes('小鱼'), '覆盖模式不该追加名字')
})

check('名字替换：默认人设里的 DeepSeek 被替换 + 追加身份行', () => {
  const out = composePersonaPrompt({
    defaultText: '你是 DeepSeek，也是群友。', botName: '林小鱼', groupName: '小鱼',
  })
  assert.ok(out.includes('【身份】'), out)
  assert.ok(out.includes('林小鱼') && out.includes('小鱼'), out)
  assert.ok(!out.includes('DeepSeek'), `旧名字没被替换：${out}`)
})

check('角色设定优先于默认人设', () => {
  const out = composePersonaPrompt({ baseText: '自定义角色', defaultText: '默认角色', participation: 'quiet' })
  assert.ok(out.includes('自定义角色'))
  assert.ok(!out.includes('默认角色'))
  assert.ok(out.includes('【参与度】'))
})

check('参与度三档的规则不同；非法值回退普通群友', () => {
  const quiet = composePersonaPrompt({ baseText: '设定', participation: 'quiet' })
  const active = composePersonaPrompt({ baseText: '设定', participation: 'active' })
  const fallback = composePersonaPrompt({ baseText: '设定', participation: '???', botName: 'x' })
  assert.ok(quiet.includes(PERSONA_PARTICIPATION.quiet.rule))
  assert.ok(active.includes(PERSONA_PARTICIPATION.active.rule))
  assert.ok(fallback.includes(PERSONA_PARTICIPATION.normal.rule), fallback)
})

check('管理员附加规则追加在最后', () => {
  const out = composePersonaPrompt({
    baseText: '角色设定', botName: '小鱼', participation: 'active', extraRules: '凌晨别发言',
  })
  assert.ok(out.trimEnd().endsWith('【管理员附加规则】\n凌晨别发言'), out)
})

fs.rmSync(tmpDir, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
