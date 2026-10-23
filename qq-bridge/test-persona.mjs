/**
 * 人设回归（离线，不碰真实 profile）。
 *
 * 2026-10-23 起架构变了：preset 里不再挂静态 `dsh-persona` 行，改为 guard 实例
 * 动态注册 `deployment:persona-prefix` section；默认人设正文搬进 guard 子行的
 * `personaDefault: |-`。所以这里只验证两件事：
 *   ① 默认人设能从 cordis.patch.yml 正确读出来（动态 section 的兜底文本来源）；
 *   ② composePersonaPrompt 的拼装规则（覆盖/名字/参与度/规则/模型行的顺序与优先级）。
 *
 * 旧的 writePersona（改写 profile patch）已随静态 persona 行一起废弃，
 * 文件写入相关用例不再有意义。
 *
 * 运行：node qq-bridge/test-persona.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDefaultPersona } from './src/persona.mjs'
import { composePersonaPrompt, PERSONA_PARTICIPATION } from './src/bridge.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

console.log('— 默认人设读取（guard 子行 personaDefault）—')
check('能从 bundle patch 读出默认人设（非空）', () => {
  const file = path.resolve(HERE, '../plugins/dsh-qq-guard/cordis.patch.yml')
  const def = readDefaultPersona(file)
  assert.ok(def.length > 100, `默认人设太短：${def.length}`)
  assert.ok(def.includes('DeepSeek'), '默认人设应含 DeepSeek')
  assert.ok(def.includes('【说话方式】'), '应保留分段标题')
  assert.ok(def.includes('\n\n'), '应保留段落空行')
})
check('读不到文件时返回空串，不抛错', () => {
  assert.equal(readDefaultPersona('D:\\__no_such_patch__.yml'), '')
})

console.log('\n— 拼最终系统提示词 —')
check('什么都没设置 → 空串（回落到插件 personaDefault）', () => {
  assert.equal(composePersonaPrompt({ defaultText: '默认人设正文' }), '')
  assert.equal(composePersonaPrompt({ baseText: '  ', defaultText: '默认人设正文', participation: 'normal' }), '')
})

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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
