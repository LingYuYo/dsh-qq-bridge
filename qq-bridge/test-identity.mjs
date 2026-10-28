/**
 * 身份注入 / 动态记忆 / 三段式静态核心的离线用例（v2.0 第十步）。
 *
 *   node test-identity.mjs
 *
 * 不连 QQ、不启 DSH：只验 bridge 的纯逻辑与 state 行为。
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import {
  Bridge, composePersonaPrompt, normalizeSessionEntry,
} from './src/bridge.mjs'

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

function makeBridge({ core } = {}) {
  return new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: { private: [], groups: [], allowAllWhenEmpty: false },
      ...(core ? { personaCore: core } : {}),
      stateFile: path.join(os.tmpdir(), `qq-identity-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  })
}

const groupMsg = (text, { userId = '1001', senderName = '小明', senderRole = 'member', id = 'm1' } = {}) => ({
  kind: 'group', userId, groupId: '123456', senderName, senderRole, text, messageId: id,
  raw: { message: [{ type: 'text', data: { text } }] },
})

console.log('— 身份前缀与自身认知 —')
await check('_labelForModel：群主 / 管理员 / 群员 前缀', () => {
  const b = makeBridge()
  assert.equal(b._labelForModel(groupMsg('你好', { senderRole: 'owner', senderName: 'AAA王牌黑车', userId: '267234' }), '你好'),
    '[群主 AAA王牌黑车(267234)]: 你好')
  assert.equal(b._labelForModel(groupMsg('你好', { senderRole: 'admin', senderName: '管理' }), '你好'),
    '[管理员 管理(1001)]: 你好')
  assert.equal(b._labelForModel(groupMsg('你好', { senderRole: 'member', senderName: '大肥鱼' }), '你好'),
    '[群员 大肥鱼(1001)]: 你好')
  // role 缺失时退回中性「群友」，不能瞎猜群主
  assert.equal(b._labelForModel(groupMsg('你好', { senderRole: '' }), '你好'), '[群友 小明(1001)]: 你好')
})

await check('composePersonaPrompt：注入真实 QQ 号与「不是群主」', () => {
  const text = composePersonaPrompt({ selfId: '1597725054', selfName: '大肥鱼', core: { identity: '你是鲸鱼娘' } })
  assert.match(text, /你的真实 QQ 号是 1597725054/u)
  assert.match(text, /昵称是「大肥鱼」/u)
  assert.match(text, /不是群主/u)
  assert.match(text, /【身份定义与气质】\n你是鲸鱼娘/u)
})

await check('_effectiveCore：单群填了覆盖全局，留空继承全局', () => {
  const b = makeBridge({ core: { identity: '全局身份', boundary: '全局边界', style: '全局策略' } })
  assert.deepEqual(b._effectiveCore(null), { identity: '全局身份', boundary: '全局边界', style: '全局策略' })
  assert.deepEqual(b._effectiveCore({ identity: '本群身份' }),
    { identity: '本群身份', boundary: '全局边界', style: '全局策略' })
})

console.log('\n— 群友档案与改名感知 —')
await check('首次见只建档；改名时产生一次性事件并保留曾用名', () => {
  const b = makeBridge()
  assert.equal(b._noteProfiles('g:123456', groupMsg('在吗', { senderName: '旧名字', senderRole: 'owner' })), '')
  const entry = b.state.sessions['g:123456']
  assert.equal(entry.userProfiles['1001'].nickname, '旧名字')
  assert.equal(entry.userProfiles['1001'].role, 'owner')
  const event = b._noteProfiles('g:123456', groupMsg('在吗', { senderName: '新名字' }))
  assert.match(event, /群友\(QQ:1001\)/u)
  assert.match(event, /「旧名字」改为了「新名字」/u)
  assert.equal(entry.userProfiles['1001'].lastNickname, '旧名字')
  assert.equal(entry.userProfiles['1001'].nickname, '新名字')
  // 没再改名就不该重复产生事件
  assert.equal(b._noteProfiles('g:123456', groupMsg('在吗', { senderName: '新名字' })), '')
})

await check('动态记忆按群隔离，且只列本群档案', () => {
  const b = makeBridge()
  b._noteProfiles('g:111', groupMsg('在吗', { senderName: '甲' }))
  b._noteProfiles('g:222', groupMsg('在吗', { userId: '2002', senderName: '乙' }))
  b.state.sessions['g:111'].slang = ['上车']
  const one = b._dynamicMemorySection('g:111')
  const two = b._dynamicMemorySection('g:222')
  assert.match(one, /群员 甲\(1001\)/u)
  assert.match(one, /上车/u)
  assert.ok(!two.includes('甲'), '★ 另一个群不能看到甲的档案')
  assert.ok(!two.includes('上车'), '★ 黑话不能跨群')
})

await check('_contextSections：动态记忆在最后，改名事件更靠后', () => {
  const b = makeBridge()
  b._noteProfiles('g:123456', groupMsg('在吗', { senderName: '旧名字' }))
  b.state.sessions['g:123456'].slang = ['润了']
  const sections = b._contextSections('g:123456', { renameEvents: ['[系统事件：改名了]'] })
  assert.match(sections.at(-2), /本群动态记忆/u)
  assert.equal(sections.at(-1), '[系统事件：改名了]')
})

console.log('\n— dynamic 指令 —')
await check('保存三段核心 / 黑话 / 删除档案', async () => {
  const b = makeBridge()
  const key = 'g:123456'
  b.state.sessions[key] = normalizeSessionEntry(key, {
    sessionId: 'sess-1',
    userProfiles: { 1001: { nickname: '小明', role: 'member', tags: [] } },
  })
  const saved = await b.applySessionOp({
    op: 'dynamic', key,
    core: { identity: '本群身份', boundary: '本群边界', style: '' },
    slang: ['上车', '上车', '润了'],
  })
  assert.equal(saved.ok, true)
  assert.equal(b.state.sessions[key].core.identity, '本群身份')
  assert.deepEqual(b.state.sessions[key].slang, ['上车', '润了'])
  const removed = await b.applySessionOp({ op: 'dynamic', key, removeProfile: '1001' })
  assert.equal(removed.ok, true)
  assert.equal(b.state.sessions[key].userProfiles['1001'], undefined)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
