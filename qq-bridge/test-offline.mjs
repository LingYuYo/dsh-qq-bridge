/**
 * 离线自测：不连 QQ、不启 NapCat、不碰 DSH 会话。
 * 覆盖：回复审计、消息解析、分片、客户端接口面。
 *   node test-offline.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditReply, Bridge } from './src/bridge.mjs'
import { OneBotClient, parseMessage, splitText, splitBubbles, charCount, typingDelayFor } from './src/onebot.mjs'
import { discoverDshBaseUrl, listLocalListeningPorts, DSH_BASE_HOST } from './src/dsh.mjs'
import { pickHotConfig, applyHotConfig, startConfigPolling, CONFIG_ROUTE_PATH } from './src/runtime-config.mjs'
import { buildBridgeStatus, qqStateFromHealth, QQ_STATES } from './src/status.mjs'
import { acquireInstanceLock, readLiveInstanceLock, lockPath, LOCK_FILE_NAME } from './src/instance-lock.mjs'

let pass = 0, fail = 0
/** 支持同步与异步断言：异步用法必须 `await check(...)`。 */
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

console.log('— 回复审计（命中即整条拦下）—')
await check('干净文本放行', () => assert.equal(auditReply('你好呀，今天天气不错').ok, true))
await check('拦 Windows 路径', () => assert.equal(auditReply('文件在 C:\\Users\\you\\secret.txt').ok, false))
await check('拦 /home/ 路径', () => assert.equal(auditReply('看 /home/user/x').ok, false))
await check('拦 credentials 文件', () => assert.equal(auditReply('读 .credentials.yaml 就行').ok, false))
await check('拦 api_key 赋值', () => assert.equal(auditReply('api_key: sk-abcdefghijklmnop').ok, false))
await check('拦 sk- 前缀 Key', () => assert.equal(auditReply('sk-abcdefghijklmnopqrst').ok, false))
await check('拦桥接令牌', () => assert.equal(auditReply('token 是 s3cr3t-fixture-token', ['s3cr3t-fixture-token']).ok, false))

console.log('\n— OneBot 消息解析（array 格式）—')
await check('纯文本', () => {
  assert.equal(parseMessage([{ type: 'text', data: { text: '在吗' } }]), '在吗')
})
await check('at + 文本 + 图片', () => {
  const r = parseMessage([
    { type: 'at', data: { qq: '12345' } },
    { type: 'text', data: { text: ' 你看这个 ' } },
    { type: 'image', data: { file: 'x.jpg' } },
  ])
  console.log(`      实际解析 -> ${JSON.stringify(r)}`)
  assert.ok(r.includes('你看这个'), '应保留文本')
  assert.ok(r.includes('图片') || r.includes('['), '图片应有占位')
})
await check('face 表情有占位', () => {
  const r = parseMessage([{ type: 'face', data: { id: '1' } }])
  assert.ok(String(r).length > 0, '表情不应解析为空')
})
await check('多段 text 拼接', () => {
  const r = parseMessage([{ type: 'text', data: { text: 'a' } }, { type: 'text', data: { text: 'b' } }])
  assert.equal(r, 'ab')
})
await check('字符串形式的消息也能解析', () => {
  const r = parseMessage('直接是字符串')
  assert.equal(typeof r, "string")
  assert.ok(r.includes('直接是字符串'))
})

console.log('\n— 长文本分片 —')
await check('短文本不分片', () => {
  const parts = splitText('短')
  assert.equal(parts.length, 1)
})
await check('超长文本会分片且拼回一致', () => {
  const s = '这是一句测试。'.repeat(400) // 2800 字
  const parts = splitText(s, 1000)
  assert.ok(parts.length > 1, `应分片，实际 ${parts.length} 段`)
  assert.equal(parts.join(''), s, '拼回应与原文一致')
})
await check('分片优先在标点处断开', () => {
  const s = '第一句。第二句。第三句。'.repeat(100)
  const parts = splitText(s, 100)
  assert.ok(parts.every(p => p.length <= 100), '每段不超过上限')
})

console.log('\n— 分气泡（换行 → 多条消息）—')
await check('无换行 → 单条', () => {
  assert.deepEqual(splitBubbles('就这一句'), ['就这一句'])
})
// 批次3修正：模型原生换行是**强边界**，绝不合并。
await check('原生换行 2 条 → 发 2 条（强边界，不合并）', () => {
  assert.deepEqual(splitBubbles('收到\n马上来'), ['收到', '马上来'])
})
await check('连续 3 条 8 字短行 → 仍 3 条（原生换行不合并）', () => {
  assert.deepEqual(splitBubbles('八个字的一句话\n八个字的二句话\n八个字的三句话'),
    ['八个字的一句话', '八个字的二句话', '八个字的三句话'])
})
await check('超过 15 字的长行不参与合并', () => {
  const a = '这句话已经超过十五个字了真的超了'
  const b = '这句同样超过十五个字了吧确实超了'
  assert.ok(charCount(a) > 15 && charCount(b) > 15, `${charCount(a)}/${charCount(b)}`)
  assert.deepEqual(splitBubbles(a + '\n' + b), [a, b])
})
await check('空行被丢弃，不产生空消息', () => {
  assert.deepEqual(splitBubbles('第一句\n\n第二句\n   \n第三句'), ['第一句', '第二句', '第三句'])
})
await check('每行 trim（清掉行首尾空白）', () => {
  assert.deepEqual(splitBubbles('  甲  \n\t乙\t'), ['甲', '乙'])
})
await check('CRLF 与 CR 都当换行处理', () => {
  assert.deepEqual(splitBubbles('甲\r\n乙\r丙'), ['甲', '乙', '丙'])
})
await check('片尾标点被裁掉（，。默认不保留）', () => {
  assert.deepEqual(splitBubbles('你好，'), ['你好'])
  assert.deepEqual(splitBubbles('正常。'), ['正常'])
})
await check('片尾问号/感叹号保留（keep 可配）', () => {
  assert.deepEqual(splitBubbles('真的假的？'), ['真的假的？'])
  assert.deepEqual(splitBubbles('我超！'), ['我超！'])
  assert.deepEqual(splitBubbles('这啥？！'), ['这啥？！'])
  assert.deepEqual(splitBubbles('真的假的？', { keepEndPunct: [] }), ['真的假的'])
})
await check('单行超长时按语义切且不超限、前片 ≥6 字', () => {
  const long = '这句话很长。'.repeat(200)
  const parts = splitBubbles(long, { chunkSize: 1000 })
  assert.ok(parts.length > 1, '应继续分片')
  assert.ok(parts.every((p) => charCount(p) <= 30), '每片 ≤30 码点')
  assert.ok(parts.every((p, i) => i === 0 || charCount(p) >= 1))
  assert.equal(parts[0].startsWith('这句话很长。'), true, '前片应在句末标点处收尾')
})
await check('换行 + 超长混合', () => {
  const parts = splitBubbles('短句一\n' + '很长。'.repeat(100) + '\n短句二')
  assert.equal(parts[0], '短句一', '短行独立成条（不与超长行混切）')
  assert.equal(parts.at(-1), '短句二')
  assert.ok(parts.every((p) => charCount(p) <= 30))
})
await check('空文本 / 纯空白 → 无消息', () => {
  assert.deepEqual(splitBubbles(''), [])
  assert.deepEqual(splitBubbles('   \n  \n'), [])
})

console.log('\n— 批次2：单行语义切 / 短行合并边界 —')
await check('单行 40 字 → 切 2 条且前片 ≥6 字', () => {
  const s = '这是一句刚好四十个字的测试文本用来验证单行上限处理逻辑到底会不会切开'
  const parts = splitBubbles(s)
  assert.equal(parts.length, 2, `实际 ${parts.length} 条：${JSON.stringify(parts)}`)
  assert.ok(charCount(parts[0]) >= 6, '前片 ≥6 字')
  assert.ok(parts.every((p) => charCount(p) <= 30), '每片 ≤30')
})
await check('≤15 字整块不切', () => {
  assert.deepEqual(splitBubbles('就这一句十五字整块'), ['就这一句十五字整块'])
})
await check('15~30 语义完整优先整块', () => {
  const s = '这句话刚好二十多个字但语义是完整的'
  assert.ok(charCount(s) > 15 && charCount(s) <= 30, `长度 ${charCount(s)}`)
  assert.deepEqual(splitBubbles(s), [s])
})
await check('原生 3 条 8 字短行 → 仍 3 条（换行是强边界）', () => {
  const r = splitBubbles('八个字一句话\n八个字两句话\n八个字三句话')
  assert.equal(r.length, 3, JSON.stringify(r))
  assert.deepEqual(r, ['八个字一句话', '八个字两句话', '八个字三句话'])
})
await check('桥接硬切产生的短碎片才会合并（防刷屏）', () => {
  // 一长行被切出多个短碎片时，相邻短碎片合并
  const s = '短。'.repeat(20)
  const r = splitBubbles(s)
  assert.ok(r.length > 1, '应切')
  assert.ok(r.every((p) => charCount(p) <= 30), JSON.stringify(r.map(charCount)))
})
await check('语气词后接标点才切（且优先句末标点）', () => {
  const s = '今天天气不错吧。明天要不要一起出去走走，顺便看看那边的风景如何'
  assert.ok(charCount(s) > 30, `需 >30 才触发切分，实际 ${charCount(s)}`)
  const parts = splitBubbles(s)
  assert.ok(parts.length >= 2, JSON.stringify(parts))
  assert.equal(parts[0], '今天天气不错吧', '第一片在「吧。」处收尾且裁掉句号')
  assert.ok(parts.every((p) => charCount(p) <= 30))
})
await check('语气词后无标点则不切在那里', () => {
  // 「吧」后面直接跟字（无标点/空白），不该被当切点
  const s = '你就说吧我这边全都听着呢你继续说下去我保证不打断你的话而且会认真听'
  assert.ok(charCount(s) > 30, `需 >30，实际 ${charCount(s)}`)
  const parts = splitBubbles(s)
  assert.ok(parts.length >= 2, JSON.stringify(parts))
  assert.ok(!parts[0].endsWith('吧'), `不该切在「吧」后：${JSON.stringify(parts[0])}`)
})

console.log('\n— 批次2：码点计数（emoji 代理对不拆）—')
await check('码点数按 Unicode 计，代理对算 1', () => {
  assert.equal(charCount('🐟'), 1)
  assert.equal(charCount('🐟🐟'), 2)
  assert.equal(charCount('a🐟b'), 3)
})
await check('超长 emoji 行不劈代理对', () => {
  const s = '🐟'.repeat(40)
  const parts = splitBubbles(s)
  assert.ok(parts.length > 1, '应分片')
  for (const p of parts) {
    assert.equal(charCount(p), [...p].length, '每片都是完整码点')
    assert.ok(!/[\uD800-\uDBFF]$/.test(p), '不应以孤立高位代理结尾')
    assert.ok(!/^[\uDC00-\uDFFF]/.test(p), '不应以孤立低位代理开头')
  }
})

console.log('\n— 批次2：原子块保护 —')
await check('20 行代码块原样 1 条，不被语义切碎', () => {
  const code = '```js\n' + Array.from({ length: 18 }, (_, i) => `const v${i} = ${i}`).join('\n') + '\n```'
  const r = splitBubbles('看这个\n' + code)
  assert.equal(r.length, 2, JSON.stringify(r.map((x) => x.slice(0, 20))))
  assert.equal(r[1], code, '代码块原样')
})
await check('小代码块 + 前后文 → 块保持完整', () => {
  const r = splitBubbles('看这段代码\n```js\nconst a = 1\nconst b = 2\n```\n大概就这样')
  const code = r.find((x) => x.includes('```'))
  assert.equal(code, '```js\nconst a = 1\nconst b = 2\n```', '代码块未被拆')
})
await check('行内代码独占行不被拆', () => {
  assert.deepEqual(splitBubbles('用 `npm run build` 就行'), ['用 `npm run build` 就行'])
})
await check('URL 不被拆', () => {
  const u = 'https://example.com/very/long/path?a=1&b=2&c=3'
  const r = splitBubbles('链接在这\n' + u + '\n自己看')
  assert.ok(r.includes(u), JSON.stringify(r))
})
await check('代码块超硬上限时按换行切', () => {
  const code = '```\n' + Array.from({ length: 30 }, (_, i) => `line-${i}-${'x'.repeat(50)}`).join('\n') + '\n```'
  const r = splitBubbles(code, { chunkSize: 200 })
  assert.ok(r.length > 1, '应切')
  assert.ok(r.every((p) => charCount(p) <= 200), '每片不超硬上限')
})
await check('代码块片尾标点不裁（protect）', () => {
  const r = splitBubbles('```js\nconst a = 1;\n```')
  assert.equal(r[0], '```js\nconst a = 1;\n```', '代码块原样保留分号')
})
await check('日志块合成原子块', () => {
  const log = '[12:00:01] 启动完成\n[12:00:02] 连接成功\n[12:00:03] 等待消息'
  const r = splitBubbles(log)
  assert.equal(r.length, 1, JSON.stringify(r))
  assert.equal(r[0], log)
})

console.log('\n— 批次2：分级打字延时 —')
await check('分级延时 200/450/800 且抖动 ±15%、下限 150', () => {
  const t = (n) => typingDelayFor(n, () => 0.5)   // 抖动系数乘 1.0
  assert.equal(t(1), 200)
  assert.equal(t(9), 200)
  assert.equal(t(10), 450)
  assert.equal(t(14), 450)
  assert.equal(t(15), 800)
  assert.equal(t(30), 800)
  for (let n = 0; n <= 60; n++) {
    const lo = Math.max(150, Math.floor((n < 10 ? 200 : n < 15 ? 450 : 800) * 0.85))
    const hi = Math.ceil((n < 10 ? 200 : n < 15 ? 450 : 800) * 1.15)
    for (let k = 0; k < 50; k++) {
      const v = typingDelayFor(n)
      assert.ok(v >= 150, `下限 ${v}`)
      assert.ok(v >= lo && v <= hi, `n=${n} 抖动越界 ${v} 不在 [${lo},${hi}]`)
    }
  }
})
await check('延时按码点算（emoji 不放大档位）', () => {
  assert.equal(typingDelayFor(charCount('🐟'.repeat(9)), () => 0.5), 200)
  assert.equal(typingDelayFor(charCount('🐟'.repeat(10)), () => 0.5), 450)
})

console.log('\n— 批次2：总开关与间隔优先级 —')
await check('typingDelay.enabled=false → 整条 1 条，不分片', async () => {
  const c = new OneBotClient({ typingDelayEnabled: false, chunkSize: 30, sendIntervalMs: 10, logger: undefined })
  const sent = []
  c.call = async (a, p) => { sent.push(p.message); return { status: 'ok', retcode: 0, data: { message_id: 1 } } }
  await c.sendPrivate('1', '第一行\n第二行\n' + '很长'.repeat(40))
  assert.equal(sent.length, 1, `实际 ${sent.length} 条`)
})
await check('typingDelay=true → 仍走分级延时，sendIntervalMs 不生效', async () => {
  const c = new OneBotClient({ typingDelayEnabled: true, bubbleMaxChars: 30, sendIntervalMs: 2000, logger: undefined })
  const times = []
  c.call = async (a, p) => { times.push(Date.now()); return { status: 'ok', retcode: 0, data: { message_id: 1 } } }
  // 两片，各 ≤30（第二片较长 → 800ms 档）
  await c.sendPrivate('1', '一二三四五六七八九十\n' + '这是一句超过十五个字的话用来测试分级延时')
  assert.equal(times.length, 2, `实际 ${times.length} 条`)
  const gap = times[1] - times[0]
  assert.ok(gap < 1000, `片间间隔 ${gap}ms 应走分级延时而非 sendIntervalMs=2000`)
  assert.ok(gap >= 150, `不低于 150ms，实际 ${gap}`)
})
await check('typingDelay=false → 走 sendIntervalMs 兜底', async () => {
  const c = new OneBotClient({ typingDelayEnabled: false, sendIntervalMs: 250, logger: undefined })
  const times = []
  c.call = async (a, p) => { times.push(Date.now()); return { status: 'ok', retcode: 0, data: { message_id: 1 } } }
  // 关总开关只发 1 条 → 直接验证 _gapBefore 的兜底值
  assert.equal(c._gapBefore(0, ['x']), 250)
  assert.equal(c.typingDelayEnabled, false)
})

console.log('\n— 批次3：群聊 @ 回复 —')
const segAt = (qq) => ({ type: 'at', data: { qq: String(qq) } })
const segText = (t) => ({ type: 'text', data: { text: t } })
/** 抓一次 sendGroup/sendPrivate 实际发出的 message 字段。 */
const captureSend = async (fn) => {
  const sent = []
  const c = new OneBotClient({ bubbleMaxChars: 30, mergeMaxChars: 15, typingDelayEnabled: true, logger: undefined })
  c.call = async (a, p) => { sent.push({ action: a, message: p.message }); return { status: 'ok', retcode: 0, data: { message_id: sent.length } } }
  await fn(c)
  return sent
}
const TWO = '收到\n马上来'   // 原生 2 条（强边界）

await check('私聊回复：仍是纯文本，无 at', async () => {
  const sent = await captureSend((c) => c.sendPrivate('1000000001', TWO, { atUserId: '1000000001' }))
  assert.equal(sent.length, 2, `实际 ${sent.length} 条`)
  assert.equal(sent[0].action, 'send_private_msg')
  assert.equal(typeof sent[0].message, 'string', '私聊应是纯文本字符串')
  assert.equal(typeof sent[1].message, 'string')
  assert.equal(sent[0].message, '收到')
  assert.equal(sent[1].message, '马上来')
})

await check('群聊 last：分 2 条，第 1 条纯文本，第 2 条含 at', async () => {
  const sent = await captureSend((c) => c.sendGroup('123456', TWO, { atUserId: '1000000001', atPosition: 'last' }))
  assert.equal(sent.length, 2, `实际 ${sent.length} 条`)
  assert.equal(sent[0].action, 'send_group_msg')
  assert.equal(typeof sent[0].message, 'string', '第 1 条不该带 at')
  assert.equal(sent[0].message, '收到')
  const segs = sent[1].message
  assert.ok(Array.isArray(segs), '第 2 条应是段数组')
  assert.deepEqual(segs, [segAt('1000000001'), segText('马上来')])
})

await check('群聊 first：第 1 条带 at，第 2 条纯文本', async () => {
  const sent = await captureSend((c) => c.sendGroup('123456', TWO, { atUserId: '1000000001', atPosition: 'first' }))
  assert.deepEqual(sent[0].message, [segAt('1000000001'), segText('收到')])
  assert.equal(typeof sent[1].message, 'string')
  assert.equal(sent[1].message, '马上来')
})

await check('groupAtReply=false：纯文本，无 at', async () => {
  const c = new OneBotClient({ bubbleMaxChars: 30, groupAtReply: false, logger: undefined })
  const sent = []
  c.call = async (a, p) => { sent.push(p.message); return { status: 'ok', retcode: 0, data: { message_id: 1 } } }
  await c.sendGroup('123456', TWO, { atUserId: '1000000001', atPosition: 'last' })
  assert.equal(sent.length, 2)
  assert.ok(sent.every((m) => typeof m === 'string'), JSON.stringify(sent))
  assert.equal(c.groupAtReply, false)
})

await check('单条群聊回复（不分片）也带 at', async () => {
  const sent = await captureSend((c) => c.sendGroup('123456', '收到', { atUserId: '1000000001', atPosition: 'last' }))
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].message, [segAt('1000000001'), segText('收到')])
})

await check('@ 与代码块混合：原子块完整、at 不破坏结构', async () => {
  const code = '```js\nconst a = 1\nconst b = 2\n```'
  const sent = await captureSend((c) => c.sendGroup('123456', '看这个\n' + code, { atUserId: '1000000001', atPosition: 'last' }))
  assert.equal(sent.length, 2, JSON.stringify(sent.map((x) => typeof x.message)))
  const last = sent[1].message
  assert.ok(Array.isArray(last))
  assert.deepEqual(last[0], segAt('1000000001'))
  assert.equal(last[1].type, 'text')
  assert.equal(last[1].data.text, code, '代码块原样，未被 at 破坏')
})

await check('@ 与 URL 混合：URL 不被拆', async () => {
  const url = 'https://example.com/a?b=1&c=2'
  const sent = await captureSend((c) => c.sendGroup('123456', '链接\n' + url, { atUserId: '1000000001', atPosition: 'last' }))
  const last = sent.at(-1).message
  assert.deepEqual(last[0], segAt('1000000001'))
  assert.equal(last[1].data.text, url)
})

await check('非法 atUserId 不生成 at 段', () => {
  const c = new OneBotClient({ logger: undefined })
  assert.equal(typeof c._buildSegments('group', '你好', {}), 'string')
  assert.equal(typeof c._buildSegments('group', '你好', { atUserId: 'abc' }), 'string')
  assert.equal(typeof c._buildSegments('group', '你好', { atUserId: 'all' }), 'string', '不支持 @全体')
  assert.ok(Array.isArray(c._buildSegments('group', '你好', { atUserId: '123' })))
})

await check('_shouldAt 只在指定片返回 true', () => {
  const c = new OneBotClient({ logger: undefined })
  assert.equal(c._shouldAt('group', 1, 2, '123', 'last'), true)
  assert.equal(c._shouldAt('group', 0, 2, '123', 'last'), false)
  assert.equal(c._shouldAt('group', 0, 2, '123', 'first'), true)
  assert.equal(c._shouldAt('group', 1, 2, '123', 'first'), false)
  assert.equal(c._shouldAt('private', 1, 2, '123', 'last'), false, '私聊永不 @')
})

await check('文本里的 [CQ: 仍被转义（段数组内也转义）', async () => {
  const sent = await captureSend((c) => c.sendGroup('123456', '[CQ:at,qq=999]', { atUserId: '1000000001' }))
  const last = sent.at(-1).message
  assert.equal(last[1].data.text.includes('[CQ：'), true, '应为全角冒号')
})

console.log('\n— 批次4A：DSH 设置热同步 —')
await check('pickHotConfig 只取白名单键', () => {
  const hot = pickHotConfig({
    bubbleMaxChars: 15, groupAtReply: false,
    wsUrl: 'ws://evil:1', accessToken: 'leak', dsh: { baseUrl: 'x' },
  })
  assert.equal(hot.bubbleMaxChars, 15)
  assert.equal(hot.groupAtReply, false)
  assert.equal('wsUrl' in hot, false, '连接凭据绝不能被设置页覆盖')
  assert.equal('accessToken' in hot, false)
  assert.equal('dsh' in hot, false)
})
await check('pickHotConfig 深拷贝，外部改动不影响源', () => {
  const src = { typingDelay: { enabled: false } }
  const hot = pickHotConfig(src)
  hot.typingDelay.enabled = true
  assert.equal(src.typingDelay.enabled, false, '应为深拷贝')
})
await check('applyHotConfig 原地更新并报告变化键', () => {
  const target = { bubbleMaxChars: 30, groupAtReply: true }
  const changed = applyHotConfig(target, { bubbleMaxChars: 15, groupAtReply: true })
  assert.deepEqual(changed, ['bubbleMaxChars'])
  assert.equal(target.bubbleMaxChars, 15, '应原地改')
  assert.deepEqual(applyHotConfig(target, { bubbleMaxChars: 15 }), [], '无变化不报告')
})
await check('startConfigPolling 从桩路由拉到配置并热应用', async () => {
  const http = await import('node:http')
  const srv = http.createServer((req, res) => {
    if (req.url !== CONFIG_ROUTE_PATH) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, config: { bubbleMaxChars: 15, groupAtReply: false, keepEndPunct: ['？'] } }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const live = { bubbleMaxChars: 30, groupAtReply: true }
  let synced = 0
  const stop = startConfigPolling({
    baseUrl: `http://127.0.0.1:${port}`,
    liveConfig: live,
    pollMs: 100,
    timeoutMs: 1000,
    onSync: () => { synced++ },
  })
  try {
    const deadline = Date.now() + 3000
    while (live.bubbleMaxChars !== 15 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.equal(live.bubbleMaxChars, 15, '应同步到 bubbleMaxChars=15')
    assert.equal(live.groupAtReply, false)
    assert.equal('keepEndPunct' in live, false, '非白名单键不写入')
    assert.ok(synced >= 1, 'onSync 应被调用')
  } finally { stop(); srv.close() }
})
await check('startConfigPolling 连不上时静默不抛错', async () => {
  const live = { bubbleMaxChars: 30 }
  const stop = startConfigPolling({
    baseUrl: 'http://127.0.0.1:1', liveConfig: live, pollMs: 50, timeoutMs: 200,
  })
  await new Promise((r) => setTimeout(r, 300))
  stop()
  assert.equal(live.bubbleMaxChars, 30, '失败时保持原值')
})

console.log('\n— 批次4A：Bridge 运行期配置热更新 —')
await check('Bridge.live 有初值，_applyLiveToClient 能刷新客户端', () => {
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:2852', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: { private: ['1'], groups: [], allowAllWhenEmpty: false },
      chunkSize: 1000, bubbleMaxChars: 30, groupAtReply: true,
      stateFile: './state/__verify_absent__.json',
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  assert.equal(b.qq.bubbleMaxChars, 30)
  b.live.bubbleMaxChars = 15
  b.live.groupAtReply = false
  b._applyLiveToClient()
  assert.equal(b.qq.bubbleMaxChars, 15, '热更新应立即作用于客户端')
  assert.equal(b.qq.groupAtReply, false)
})
await check('热更新后发送立即按新阈值分片', async () => {
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:2852', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: { private: ['1'], groups: [], allowAllWhenEmpty: false },
      chunkSize: 1000, bubbleMaxChars: 30, mergeMaxChars: 15,
      typingDelay: { enabled: true }, stateFile: './state/__verify_absent__.json',
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  const sent = []
  b.qq.call = async (a, p) => { sent.push(p.message); return { status: 'ok', retcode: 0, data: { message_id: 1 } } }
  const line = '这是一句二十个字左右的话用来测阈值'
  b.live.bubbleMaxChars = 30
  b._applyLiveToClient()
  await b.qq.sendPrivate('1', line)
  const at30 = sent.length
  sent.length = 0
  b.live.bubbleMaxChars = 15
  b._applyLiveToClient()
  await b.qq.sendPrivate('1', line)
  const at15 = sent.length
  console.log(`      bubbleMaxChars=30 → ${at30} 条；改成 15 → ${at15} 条`)
  assert.equal(at30, 1, '30 阈值下 1 条')
  assert.ok(at15 >= 2, `15 阈值下应切成多条，实际 ${at15}`)
})

console.log('\n— DSH 端口自动跟随 —')
// 这些断言不依赖 DSH 是否在跑：用假 candidate + 本地起一个桩服务来验证判定逻辑。
await check('DSH_BASE_HOST 是本机回环', () => assert.equal(DSH_BASE_HOST, '127.0.0.1'))

await check('环境变量 DSH_BASE_URL 优先', async () => {
  process.env.DSH_BASE_URL = 'http://127.0.0.1:59999'
  const got = await discoverDshBaseUrl({ prefer: 'http://127.0.0.1:1', candidates: [] })
  delete process.env.DSH_BASE_URL
  assert.equal(got, 'http://127.0.0.1:59999', '应直接用环境变量')
})

await check('认 401 + body "unauthorized" 的桩为 DSH', async () => {
  const http = await import('node:http')
  const srv = http.createServer((req, res) => { res.writeHead(401); res.end('unauthorized') })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    const got = await discoverDshBaseUrl({ candidates: [port], timeoutMs: 2000 })
    assert.equal(got, `http://127.0.0.1:${port}`)
  } finally { srv.close() }
})

await check('401 但 body 不是 unauthorized → 不认', async () => {
  const http = await import('node:http')
  const srv = http.createServer((req, res) => { res.writeHead(401); res.end('nope') })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    const got = await discoverDshBaseUrl({ candidates: [port], timeoutMs: 2000 })
    assert.equal(got, null, '不该把别的服务认成 DSH')
  } finally { srv.close() }
})

await check('探不到时回退到 prefer', async () => {
  const got = await discoverDshBaseUrl({ prefer: 'http://127.0.0.1:2852', candidates: [1], timeoutMs: 500 })
  assert.equal(got, 'http://127.0.0.1:2852')
})

await check('listLocalListeningPorts 返回正整数数组', async () => {
  if (process.platform !== 'win32') return // netstat 解析只在 Windows 上有意义
  const ports = await listLocalListeningPorts()
  assert.ok(Array.isArray(ports))
  assert.ok(ports.every((p) => Number.isInteger(p) && p > 0))
})

console.log('\n— 客户端接口面 —')
await check('构造不抛错、接口齐全', () => {
  const c = new OneBotClient({ wsUrl: 'ws://127.0.0.1:3001', accessToken: 't', logger: undefined })
  for (const m of ['start', 'stop', 'sendPrivate', 'sendGroup', 'call', 'onMessage']) {
    assert.equal(typeof c[m], 'function', `缺方法 ${m}`)
  }
  assert.equal(c.connected, false)
  assert.equal(c.selfId, null)
})

console.log('\n— 批次5：纯 WS 探测 QQ 在线状态（不碰 NapCat HTTP 配置）—')
// 用假 WebSocket 驱动 OneBotClient：不真连 NapCat，但走的是真实的事件/协议路径。
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))
const waitUntil = async (fn, timeoutMs = 1500) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await tick(5)
  }
  return false
}

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances = []
  constructor(url) {
    this.url = url
    this.readyState = FakeWebSocket.CONNECTING
    this.sent = []
    this._listeners = new Map()
    FakeWebSocket.instances.push(this)
  }
  addEventListener(type, fn) {
    const list = this._listeners.get(type) ?? []
    list.push(fn)
    this._listeners.set(type, list)
  }
  _emit(type, event) {
    for (const fn of this._listeners.get(type) ?? []) fn(event)
  }
  send(text) { this.sent.push(JSON.parse(String(text))) }
  open() {
    this.readyState = FakeWebSocket.OPEN
    this._emit('open', {})
  }
  /** 模拟 NapCat 侧断开。 */
  closeByServer(code = 1000) {
    this.readyState = FakeWebSocket.CLOSED
    this._emit('close', { code })
  }
  close() { this.closeByServer(1000) }
  reply(payload) { this._emit('message', { data: JSON.stringify(payload) }) }
  lastSent(action) { return [...this.sent].reverse().find((p) => p.action === action) }
}

/** 起一个假客户端，跑完 fn 后自动 stop + 还原全局 WebSocket。 */
async function withFakeClient(fn) {
  const orig = globalThis.WebSocket
  FakeWebSocket.instances = []
  globalThis.WebSocket = FakeWebSocket
  let client
  try {
    client = new OneBotClient({ wsUrl: 'ws://fake.napcat', logger: undefined })
    await client.start()
    const ws = FakeWebSocket.instances.at(-1)
    assert.ok(ws, '应创建 WebSocket')
    ws.open()
    // _onOpen 里同步发出 get_login_info / get_status
    assert.ok(await waitUntil(() => ws.lastSent('get_status') !== undefined), '连上后应立刻发 get_status')
    return await fn({ client, ws })
  } finally {
    try { await client?.stop() } catch { /* 清理失败不影响断言 */ }
    globalThis.WebSocket = orig
  }
}

/** 按 action 找到已发出的 echo，回一条 OneBot 响应。 */
function replyStatus(ws, data, { action = 'get_status', status = 'ok', retcode = 0 } = {}) {
  const sent = ws.lastSent(action)
  assert.ok(sent, `应已发出 ${action}`)
  ws.reply({ status, retcode, data, echo: sent.echo })
}

await check('WS 连上后只通过 WS 发 get_status（无 HTTP、无额外配置）', async () => {
  await withFakeClient(async ({ ws }) => {
    const sent = ws.lastSent('get_status')
    assert.ok(sent, '应发 get_status')
    assert.deepEqual(sent.params, {}, 'get_status 不需要参数')
    assert.ok(!ws.url.startsWith('http'), '走的是 WebSocket，不是 HTTP API')
  })
})
await check('get_status online:true → health.online=true，上报 online/qqConnected', async () => {
  await withFakeClient(async ({ client, ws }) => {
    replyStatus(ws, { online: true, good: true })
    assert.ok(await waitUntil(() => client.health.online === true), '应采信 online=true')
    const h = client.health
    assert.equal(h.onlineSource, 'get_status', '来源应标为 get_status')
    assert.equal(h.connected, true)
    assert.equal(qqStateFromHealth(h), 'online')
    const status = buildBridgeStatus({ health: h, counts: {} })
    assert.equal(status.qqState, 'online')
    assert.equal(status.qqConnected, true)
  })
})
await check('get_status online:false → 账号离线（qqConnected 不再误报连接）', async () => {
  await withFakeClient(async ({ client, ws }) => {
    replyStatus(ws, { online: false })
    assert.ok(await waitUntil(() => client.health.online === false), '应采信 online=false')
    const status = buildBridgeStatus({ health: client.health, counts: {} })
    assert.equal(status.qqState, 'offline')
    assert.equal(status.qqConnected, false, '★ 账号离线时不能因为 WS 通就报已连接')
  })
})
await check('响应缺 online 字段 → 保持未确认（不谎报在线/离线）', async () => {
  await withFakeClient(async ({ client, ws }) => {
    replyStatus(ws, { good: true })
    await tick(30)
    assert.equal(client.health.online, null, '★ 探不到就必须是 null，不能猜')
    assert.equal(client.health.connected, true)
    assert.equal(qqStateFromHealth(client.health), 'unverified')
    assert.equal(buildBridgeStatus({ health: client.health, counts: {} }).qqState, 'unverified')
  })
})
await check('get_status 返回 failed → 保持未确认', async () => {
  await withFakeClient(async ({ client, ws }) => {
    replyStatus(ws, {}, { status: 'failed', retcode: 1404 })
    await tick(30)
    assert.equal(client.health.online, null)
    assert.equal(qqStateFromHealth(client.health), 'unverified')
  })
})
await check('心跳里的 status.online 会覆盖 get_status 的旧结论', async () => {
  await withFakeClient(async ({ client, ws }) => {
    replyStatus(ws, { online: true })
    assert.ok(await waitUntil(() => client.health.online === true))
    ws.reply({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      status: { online: false, good: false },
      time: Math.floor(Date.now() / 1000),
    })
    assert.ok(await waitUntil(() => client.health.online === false), '心跳应更新在线状态')
    assert.equal(client.health.onlineSource, 'heartbeat')
    assert.equal(client.health.good, false)
  })
})
await check('断开后 online 归 null → disconnected（不沿用旧结论）', async () => {
  await withFakeClient(async ({ client, ws }) => {
    replyStatus(ws, { online: true })
    assert.ok(await waitUntil(() => client.health.online === true))
    ws.closeByServer(1006)
    await tick(20)
    const h = client.health
    assert.equal(h.connected, false)
    assert.equal(h.online, null, '连接没了，账号状态必须回到未确认')
    assert.equal(qqStateFromHealth(h), 'disconnected')
  })
})
await check('四态取值与 Host 侧白名单一致', () => {
  assert.deepEqual([...QQ_STATES].sort(), ['disconnected', 'offline', 'online', 'unverified'])
  assert.equal(qqStateFromHealth(undefined), 'disconnected')
  assert.equal(qqStateFromHealth({}), 'disconnected')
  assert.equal(qqStateFromHealth({ connected: true, online: null }), 'unverified')
  assert.equal(qqStateFromHealth({ connected: true, online: true }), 'online')
  assert.equal(qqStateFromHealth({ connected: true, online: false }), 'offline')
})

console.log('\n— 批次5：桥接单实例锁（防两个桥接重复收消息）—')
const makeLockDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-lock-'))
await check('抢锁成功；第二个实例被拒（活 pid 可见）', () => {
  const dir = makeLockDir()
  try {
    assert.equal(fs.existsSync(lockPath(dir)), false)
    const first = acquireInstanceLock(dir)
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(fs.existsSync(path.join(dir, LOCK_FILE_NAME)), true, '锁文件应落盘')
    const holder = readLiveInstanceLock(dir)
    assert.equal(holder?.pid, process.pid, '应读到自己的 pid')
    const second = acquireInstanceLock(dir)
    assert.equal(second.ok, false)
    assert.equal(second.reason, 'held', JSON.stringify(second))
    first.release()
    assert.equal(readLiveInstanceLock(dir), null, '释放后应无持有者')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
await check('陈旧锁（pid 已死）可被清掉重抢', () => {
  const dir = makeLockDir()
  try {
    fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 2147483646, startedAt: 1 }))
    assert.equal(readLiveInstanceLock(dir), null, '死 pid 不算活持有者')
    const r = acquireInstanceLock(dir)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(readLiveInstanceLock(dir)?.pid, process.pid)
    r.release()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
await check('release 只删自己 pid 的锁（不误删新持有者）', () => {
  const dir = makeLockDir()
  try {
    const r = acquireInstanceLock(dir)
    assert.equal(r.ok, true)
    // 模拟竞态：锁已被别的进程接管
    fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 2147483646, startedAt: 2 }))
    r.release()
    assert.equal(fs.existsSync(lockPath(dir)), true, '★ 别的进程的锁不能被删')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

console.log('\n— 插件侧回归：qq-guard 作用域（防再次全局锁死）—')
await check('plugins/dsh-qq-guard 作用域回归全绿', async () => {
  const { execFileSync } = await import('node:child_process')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const script = path.resolve(here, '../plugins/dsh-qq-guard/test-guard-scope.mjs')
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8' })
  assert.match(out, /结果：\d+ 通过 \/ 0 失败/, `插件回归未全绿：\n${out}`)
})

console.log('\n— 批次4A-UI：白名单热读 / 人设写入 —')
await check('白名单从 live 现读（改完立即生效）', () => {
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:2852', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      // 启动时白名单为空（fail-closed）
      allow: { private: [], groups: [], allowAllWhenEmpty: false },
      stateFile: './state/__verify_absent__.json',
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  const msg = { kind: 'private', userId: '1000000001', groupId: null, text: 'hi', messageId: 'm1' }
  assert.equal(b.isAllowed(msg), false, '空名单应拒绝')
  // 模拟 UI 改了白名单
  b.live.allow = { private: ['1000000001'], groups: [], allowAllWhenEmpty: false }
  assert.equal(b.isAllowed(msg), true, '★ 加进白名单后应立即放行，不需要重建 Bridge')
  // 再清空
  b.live.allow = { private: [], groups: [], allowAllWhenEmpty: false }
  assert.equal(b.isAllowed(msg), false, '★ 清空后应立即拒绝')
})
await check('白名单 allowAllWhenEmpty 热读', () => {
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:2852', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: { private: [], groups: [], allowAllWhenEmpty: false },
      stateFile: './state/__verify_absent__.json',
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  const msg = { kind: 'private', userId: '999', groupId: null, text: 'hi', messageId: 'm2' }
  assert.equal(b.isAllowed(msg), false)
  b.live.allow = { private: [], groups: [], allowAllWhenEmpty: true }
  assert.equal(b.isAllowed(msg), true)
})
await check('群白名单热读', () => {
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:2852', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: { private: [], groups: [], allowAllWhenEmpty: false },
      stateFile: './state/__verify_absent__.json',
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  const g = { kind: 'group', userId: '1', groupId: '123456', text: 'hi', messageId: 'm3' }
  assert.equal(b.isAllowed(g), false)
  b.live.allow = { private: [], groups: ['123456'], allowAllWhenEmpty: false }
  assert.equal(b.isAllowed(g), true)
})
await check('hot 配置含 personaText / allow / onebot 白名单键', () => {
  const hot = pickHotConfig({
    personaText: '猫娘', allow: { private: ['1'], groups: [], allowAllWhenEmpty: false },
    onebot: { wsUrl: 'ws://x', accessToken: 'secret' },
  })
  assert.equal(hot.personaText, '猫娘')
  assert.deepEqual(hot.allow.private, ['1'])
  assert.equal(hot.onebot.wsUrl, 'ws://x')
})
console.log('\n— 插件侧回归：NapCat 进程管理（批次 4B）—')
await check('plugins/dsh-qq-guard NapCat 管理回归全绿', async () => {
  const { execFileSync } = await import('node:child_process')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const script = path.resolve(here, '../plugins/dsh-qq-guard/test-napcat.mjs')
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8' })
  assert.match(out, /结果：\d+ 通过 \/ 0 失败/, `NapCat 回归未全绿：\n${out}`)
})

await check('plugins/dsh-qq-guard bridge.autoStart / 进程管理回归全绿（批次5）', async () => {
  const { execFileSync } = await import('node:child_process')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const script = path.resolve(here, '../plugins/dsh-qq-guard/test-autostart.mjs')
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8' })
  assert.match(out, /结果：\d+ 通过 \/ 0 失败/, `autoStart 回归未全绿：\n${out}`)
})

await check('qq-bridge 人设写入回归全绿', async () => {
  const { execFileSync } = await import('node:child_process')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const script = path.resolve(here, 'test-persona.mjs')
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8' })
  assert.match(out, /结果：\d+ 通过 \/ 0 失败/, `人设回归未全绿：\n${out}`)
})

console.log('\n— 插件侧回归：设置页数据通路（remote / HTTP 兜底 / 错误可见）—')
await check('plugins/dsh-qq-guard 设置数据通路回归全绿', async () => {
  const { execFileSync } = await import('node:child_process')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const script = path.resolve(here, '../plugins/dsh-qq-guard/test-settings-data.mjs')
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8' })
  assert.match(out, /结果：\d+ 通过 \/ 0 失败/, `设置数据通路回归未全绿：\n${out}`)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
