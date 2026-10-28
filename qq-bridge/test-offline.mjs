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
import {
  auditReply, Bridge, matchActivityKeyword, normalizeRhythm,
  normalizeSessionEntry, parseSessionKey, sessionTitleFor, ADMIN_GUARD_NOTE,
  normalizeFeatures, featuresFromManifests, capabilityLines, stripMetaNotes,
  extractBilibiliRefs, fetchBilibiliInfo, formatBilibiliContext,
} from './src/bridge.mjs'
import { planRenames } from './src/rename-plan.mjs'
import {
  OneBotClient, parseMessage, splitText, splitBubbles, charCount, typingDelayFor,
  normalizeTypingCharTiers, normalizeTypingMsTiers, extractImages, imageFileVia,
  extractCardInfo, formatCardSegment,
} from './src/onebot.mjs'
import { ExternalHooksClient } from './src/external-hooks.mjs'
import { buildSsml, synthesizeOpenAI } from './src/tts.mjs'
import { discoverDshBaseUrl, listLocalListeningPorts, DSH_BASE_HOST } from './src/dsh.mjs'
import { pickHotConfig, applyHotConfig, startConfigPolling, syncConfigOnce, CONFIG_ROUTE_PATH } from './src/runtime-config.mjs'
import { buildBridgeStatus, qqStateFromHealth, QQ_STATES } from './src/status.mjs'
import { acquireInstanceLock, readLiveInstanceLock, lockPath, LOCK_FILE_NAME } from './src/instance-lock.mjs'

let pass = 0, fail = 0
/** 支持同步与异步断言：异步用法必须 `await check(...)`。 */
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

console.log('\n— 分享卡片（json / xml 段）—')
await check('B 站结构化卡片：解析出标题 + qqdocurl/jumpUrl，替换 [卡片]', () => {
  const card = {
    app: 'com.tencent.structmsg',
    meta: {
      news: {
        title: '诗朗诵《将进token》',
        desc: '一个关于大模型写诗的整活',
        jumpUrl: 'https://b23.tv/AbCdEf',
        tag: '哔哩哔哩',
      },
    },
    view: 'news',
  }
  const seg = { type: 'json', data: { data: JSON.stringify(card) } }
  assert.deepEqual(extractCardInfo(seg), { title: '诗朗诵《将进token》', url: 'https://b23.tv/AbCdEf' })
  const text = parseMessage([seg])
  assert.equal(text, '[分享卡片: 诗朗诵《将进token》 - https://b23.tv/AbCdEf]')
})
await check('小程序卡片：meta.detail_1 的 title + qqdocurl', () => {
  const card = {
    app: 'com.tencent.miniapp_01',
    meta: {
      detail_1: {
        title: '抽卡模拟器',
        desc: '点我一起抽卡',
        qqdocurl: 'https://m.q.qq.com/a/s/abc123?from=share',
        preview: 'https://x/preview.png',
      },
    },
  }
  const text = parseMessage([{ type: 'text', data: { text: '看这个 ' } }, { type: 'json', data: { data: JSON.stringify(card) } }])
  assert.equal(text, '看这个 [分享卡片: 抽卡模拟器 - https://m.q.qq.com/a/s/abc123?from=share]')
})
await check('卡片 JSON 被 HTML 实体转义过也能解析（&quot; 等）', () => {
  // 单层实体转义（卡片里最常见的形态：标题里带 &amp; / &quot;）
  const escaped = '{"meta":{"news":{"title":"A &amp; B&quot;测试&quot;","jumpUrl":"https://b23.tv/xyz"}}}'
  const text = parseMessage([{ type: 'json', data: { data: escaped } }])
  assert.equal(text, '[分享卡片: A & B"测试" - https://b23.tv/xyz]')
})
await check('xml 卡片：<title> + <qqdocurl>', () => {
  const xml = '<msg serviceID="1" templateID="1" action="web" brief="[分享] 测试">'
    + '<item layout="2"><title><![CDATA[一个 XML 卡片]]></title><summary>摘要</summary></item>'
    + '<source name="哔哩哔哩"/><qqdocurl>https://b23.tv/XmlCard</qqdocurl></msg>'
  const text = parseMessage([{ type: 'xml', data: { data: xml } }])
  assert.equal(text, '[分享卡片: 一个 XML 卡片 - https://b23.tv/XmlCard]')
})
await check('只有标题 / 只有链接 也能给出一半信息', () => {
  assert.equal(
    parseMessage([{ type: 'json', data: { data: JSON.stringify({ meta: { news: { title: '只有标题' } } }) } }]),
    '[分享卡片: 只有标题]',
  )
  assert.equal(
    parseMessage([{ type: 'json', data: { data: JSON.stringify({ meta: { news: { jumpUrl: 'https://b23.tv/OnlyUrl' } } }) } }]),
    '[分享卡片: https://b23.tv/OnlyUrl]',
  )
})
await check('解析失败 / 没有可用字段：退回 [卡片]', () => {
  assert.equal(formatCardSegment({ type: 'json', data: { data: '{这不是 JSON' } }), '[卡片]')
  assert.equal(formatCardSegment({ type: 'json', data: { data: '{}' } }), '[卡片]')
  assert.equal(formatCardSegment({ type: 'json', data: { data: JSON.stringify({ meta: { news: { title: '', jumpUrl: 'javascript:void(0)' } } }) } }), '[卡片]')
  assert.equal(formatCardSegment({ type: 'xml', data: { data: '<msg><item/></msg>' } }), '[卡片]')
  assert.equal(parseMessage([{ type: 'json', data: { data: 'bad' } }]), '[卡片]')
})
await check('卡片段与普通消息混排：顺序和空白正常', () => {
  const card = JSON.stringify({ meta: { news: { title: '混排卡片', jumpUrl: 'https://b23.tv/Mix' } } })
  const text = parseMessage([
    { type: 'at', data: { qq: '1000000001' } },
    { type: 'text', data: { text: ' 看这个 ' } },
    { type: 'json', data: { data: card } },
    { type: 'text', data: { text: ' 挺有意思' } },
  ])
  assert.ok(text.startsWith('@1000000001 看这个 [分享卡片: 混排卡片 - https://b23.tv/Mix]'), text)
  assert.ok(text.endsWith('挺有意思'), text)
})

await check('消息事件：卡片段进 event.text，模型能拿到标题 + 链接', () => {
  const c = new OneBotClient({ logger: undefined })
  const event = c._parseMessageEvent({
    message_type: 'group', group_id: 1, user_id: 2, message_id: 3,
    sender: { nickname: '小明' },
    message: [{
      type: 'json',
      data: { data: JSON.stringify({ meta: { news: { title: '事件里的卡片', jumpUrl: 'https://b23.tv/Event' } } }) },
    }],
  }, 'group')
  assert.equal(event.text, '[分享卡片: 事件里的卡片 - https://b23.tv/Event]')
})

console.log('\n— B 站链接解析（直连官方 API）—')
await check('extractBilibiliRefs：长链 / 短链 / 去重 / 非 B 站忽略 / 上限 2 条', () => {
  const refs = extractBilibiliRefs(
    '看这个 https://www.bilibili.com/video/BV1xx411c7mD?p=1 和 https://b23.tv/AbCd，还有 https://example.com/x',
  )
  assert.equal(refs.length, 2)
  assert.equal(refs[0].bvid, 'BV1xx411c7mD')
  assert.equal(refs[1].short, true)
  assert.equal(extractBilibiliRefs('重复 https://b23.tv/AbCd https://b23.tv/AbCd').length, 1)
  assert.deepEqual(extractBilibiliRefs('没有链接的普通消息'), [])
  const many = extractBilibiliRefs(
    'https://b23.tv/A1 https://b23.tv/A2 https://b23.tv/A3',
  )
  assert.equal(many.length, 2, '一条消息最多解析 2 条')
})
await check('fetchBilibiliInfo：直连 x/web-interface/view，取 title / desc / owner', async () => {
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} })
    return {
      ok: true,
      url,
      json: async () => ({ code: 0, data: { title: '测试视频', desc: '这是简介', owner: { name: 'UP主' } } }),
    }
  }
  const info = await fetchBilibiliInfo(
    { url: 'https://www.bilibili.com/video/BV1xx411c7mD', bvid: 'BV1xx411c7mD', short: false },
    { fetchImpl: fakeFetch },
  )
  assert.equal(info.title, '测试视频')
  assert.equal(info.desc, '这是简介')
  assert.equal(info.owner, 'UP主')
  assert.match(calls[0].url, /api\.bilibili\.com\/x\/web-interface\/view\?bvid=BV1xx411c7mD/)
  assert.match(String(calls[0].headers['user-agent']), /Mozilla/)
})
await check('fetchBilibiliInfo：短链先跟 302 拿 BV 号，再查接口', async () => {
  const seen = []
  const fakeFetch = async (url) => {
    seen.push(url)
    if (url.startsWith('https://b23.tv/')) {
      return { ok: true, url: 'https://www.bilibili.com/video/BV1ab411c7mD?share_source=qq', json: async () => ({}) }
    }
    return { ok: true, url, json: async () => ({ code: 0, data: { title: '短链视频', desc: '' } }) }
  }
  const info = await fetchBilibiliInfo({ url: 'https://b23.tv/XyZ', bvid: '', short: true }, { fetchImpl: fakeFetch })
  assert.equal(info.bvid, 'BV1ab411c7mD')
  assert.equal(info.title, '短链视频')
  assert.equal(seen.length, 2, '短链 + API 各一次')
})
await check('fetchBilibiliInfo：code!=0 / 网络异常 / 短链没跳对 → null（永不抛）', async () => {
  const apiRef = { url: 'https://www.bilibili.com/video/BV1xx411c7mD', bvid: 'BV1xx411c7mD', short: false }
  assert.equal(await fetchBilibiliInfo(apiRef, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: -400, message: 'bad' }) }),
  }), null)
  assert.equal(await fetchBilibiliInfo(apiRef, {
    fetchImpl: async () => { throw new Error('offline') },
  }), null)
  assert.equal(await fetchBilibiliInfo({ url: 'https://b23.tv/x', bvid: '', short: true }, {
    fetchImpl: async () => ({ ok: true, url: 'https://b23.tv/login-wall' }),
  }), null)
})
await check('formatBilibiliContext：标题 / 简介 / UP 主 / 链接，空值返回空串', () => {
  const text = formatBilibiliContext({
    title: '标题', desc: '简介', owner: 'UP',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
  })
  assert.match(text, /【B站视频】/)
  assert.match(text, /标题：标题/)
  assert.match(text, /简介：简介/)
  assert.match(text, /UP主：UP/)
  assert.equal(formatBilibiliContext(null), '')
})
await check('_enrichBilibiliLinks：正文追加解析结果；同 BV 命中缓存只请求一次', async () => {
  const { b } = makeBridge()
  let calls = 0
  b.fetchImpl = async (url) => {
    calls++
    return { ok: true, url, json: async () => ({ code: 0, data: { title: '视频标题', desc: '视频简介', owner: { name: 'UP' } } }) }
  }
  const text = '分享 https://www.bilibili.com/video/BV1xx411c7mD 看看'
  const once = await b._enrichBilibiliLinks(text)
  assert.match(once, /【B站视频】/)
  assert.match(once, /标题：视频标题/)
  assert.match(once, /简介：视频简介/)
  assert.equal(calls, 1)
  await b._enrichBilibiliLinks(text)
  assert.equal(calls, 1, '10 分钟内同一 BV 不再请求')
})
await check('_enrichBilibiliLinks：解析失败原样返回；开关关掉一个请求都不发', async () => {
  const { b } = makeBridge()
  b.fetchImpl = async () => { throw new Error('offline') }
  const text = '看 https://b23.tv/xxx'
  assert.equal(await b._enrichBilibiliLinks(text), text)

  const { b: off } = makeBridge()
  off.config.bilibili = { enabled: false }
  let called = 0
  off.fetchImpl = async () => { called++; return { ok: true, json: async () => ({}) } }
  await off._enrichBilibiliLinks('https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(called, 0)
})

console.log('\n— 上下文感知：智能匹配 —')
await check('smartMatch=true 只取最近一段连续对话（>5 分钟断开）', () => {
  const { b } = makeBridge()
  const now = Date.now()
  b._chatLog.set('g:123456', [
    { name: 'A', qq: '1', text: '很早以前', at: now - 30 * 60 * 1000 },
    { name: 'B', qq: '2', text: '最近一', at: now - 3 * 60 * 1000 },
    { name: 'C', qq: '3', text: '最近二', at: now - 2 * 60 * 1000 },
    { name: 'D', qq: '4', text: '最近三', at: now - 60 * 1000 },
  ])
  const smart = b._recentChatLines('g:123456', 15, { smartMatch: true })
  assert.equal(smart.length, 3, smart)
  const plain = b._recentChatLines('g:123456', 15, { smartMatch: false })
  assert.equal(plain.length, 4, plain)
})
await check('上下文感知：按 chatKey 严格隔离，另一个群读不到', () => {
  const { b } = makeBridge()
  const now = Date.now()
  b._chatLog.set('g:123456', [{ name: 'A', qq: '1', text: '本群消息', at: now - 1000 }])
  assert.equal(b._recentChatLines('g:123456', 15).length, 1)
  assert.equal(b._recentChatLines('g:999999', 15).length, 0)
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
// v2.0 第十九步：只合并「明显不该断开」的极短行，其余原生换行仍是强边界。
await check('2~3 字话题标签 + 长句 → 合并成一个泡（帽子/今天天气不错）', () => {
  assert.deepEqual(splitBubbles('帽子\n今天天气不错'), ['帽子今天天气不错'])
})
await check('下一行以逗号开头 → 去标点并入上一行（收到/，马上来）', () => {
  assert.deepEqual(splitBubbles('收到\n，马上来'), ['收到马上来'])
})
await check('刻意断开的应答词 / 短句 / 1 字不合并', () => {
  assert.deepEqual(splitBubbles('嗯\n好'), ['嗯', '好'])
  assert.deepEqual(splitBubbles('收到\n马上来'), ['收到', '马上来'])
  assert.deepEqual(splitBubbles('第一句\n第二句\n第三句'), ['第一句', '第二句', '第三句'])
  assert.deepEqual(splitBubbles('甲\r\n乙\r丙'), ['甲', '乙', '丙'])
})
// v2.0 第二十一步：无标点超长行降级大块，避免 4500 字切成 150 条刷屏。
await check('无标点超长行降级成 chunkSize 大块（4500 字 → 5 条）', () => {
  const parts = splitBubbles('x'.repeat(4500))
  assert.equal(parts.length, 5, `实际 ${parts.length} 条`)
  assert.ok(parts.every((p) => charCount(p) <= 1000), parts.map((p) => charCount(p)).join('/'))
  // 没到阈值仍按拟人短句切
  assert.equal(splitBubbles('x'.repeat(450)).length, 15)
  // 有标点的长文保持短句切分（不被降级影响）
  assert.ok(splitBubbles('内容。'.repeat(750)).length > 50)
})
await check('单行 5000 字代码块 → 按硬上限切开，不整条发', () => {
  const parts = splitBubbles('```\n' + 'x'.repeat(5000) + '\n```', { chunkSize: 1000 })
  assert.ok(parts.length >= 5, `应至少 5 条，实际 ${parts.length}`)
  assert.ok(parts.every((p) => charCount(p) <= 1000), parts.map((p) => charCount(p)).join('/'))
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
// at 后的 text 段必须带一个前导空格（2026-10-23 修复：否则渲染成「@群友收到」）。
const segTextAfterAt = (t) => segText(' ' + t)
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
  assert.deepEqual(segs, [segAt('1000000001'), segTextAfterAt('马上来')])
})

await check('群聊 first：第 1 条带 at，第 2 条纯文本', async () => {
  const sent = await captureSend((c) => c.sendGroup('123456', TWO, { atUserId: '1000000001', atPosition: 'first' }))
  assert.deepEqual(sent[0].message, [segAt('1000000001'), segTextAfterAt('收到')])
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
  assert.deepEqual(sent[0].message, [segAt('1000000001'), segTextAfterAt('收到')])
})

await check('@ 与代码块混合：原子块完整、at 不破坏结构', async () => {
  const code = '```js\nconst a = 1\nconst b = 2\n```'
  const sent = await captureSend((c) => c.sendGroup('123456', '看这个\n' + code, { atUserId: '1000000001', atPosition: 'last' }))
  assert.equal(sent.length, 2, JSON.stringify(sent.map((x) => typeof x.message)))
  const last = sent[1].message
  assert.ok(Array.isArray(last))
  assert.deepEqual(last[0], segAt('1000000001'))
  assert.equal(last[1].type, 'text')
  assert.equal(last[1].data.text, ' ' + code, '代码块原样（前置一个 at 分隔空格），未被 at 破坏')
})

await check('@ 与 URL 混合：URL 不被拆', async () => {
  const url = 'https://example.com/a?b=1&c=2'
  const sent = await captureSend((c) => c.sendGroup('123456', '链接\n' + url, { atUserId: '1000000001', atPosition: 'last' }))
  const last = sent.at(-1).message
  assert.deepEqual(last[0], segAt('1000000001'))
  assert.equal(last[1].data.text, ' ' + url)
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

console.log('\n— 批次3+：群聊引用回复（reply 段，2026-10-27）—')
const segReply = (id) => ({ type: 'reply', data: { id: String(id) } })

await check('引用：第一片最前面是 reply 段，后续片纯文本', async () => {
  const sent = await captureSend((c) => c.sendGroup('123456', TWO, { replyTo: '778899' }))
  assert.equal(sent.length, 2, `实际 ${sent.length} 条`)
  assert.deepEqual(sent[0].message, [segReply('778899'), segText('收到')])
  assert.equal(typeof sent[1].message, 'string', '★ 第二片不再挂引用')
  assert.equal(sent[1].message, '马上来')
})

await check('引用 + at：reply 段排在 at 之前', async () => {
  const sent = await captureSend((c) => c.sendGroup('123456', '收到', {
    replyTo: '778899', atUserId: '1000000001', atPosition: 'first',
  }))
  assert.deepEqual(sent[0].message, [segReply('778899'), segAt('1000000001'), segTextAfterAt('收到')])
})

await check('私聊忽略 replyTo（私聊没有引用气泡）', async () => {
  const sent = await captureSend((c) => c.sendPrivate('1000000001', '收到', { replyTo: '778899' }))
  assert.equal(typeof sent[0].message, 'string')
})

await check('replyTo 为空 / 空白时不生成 reply 段', () => {
  const c = new OneBotClient({ logger: undefined })
  assert.equal(typeof c._buildSegments('group', '你好', { replyTo: '' }), 'string')
  assert.equal(typeof c._buildSegments('group', '你好', { replyTo: '   ' }), 'string')
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
await check('热配置白名单放行 replyQuoteMode（漏加 = 设置页白存）', () => {
  const hot = pickHotConfig({ replyQuoteMode: 'at' })
  assert.equal(hot.replyQuoteMode, 'at')
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
await check('syncConfigOnce：启动时同步拉一次，toolEpoch/features 立即就位（v0.5.1）', async () => {
  const http = await import('node:http')
  const srv = http.createServer((req, res) => {
    if (req.url !== CONFIG_ROUTE_PATH) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      config: { bubbleMaxChars: 15, toolEpoch: 'v0.5.1-test', features: { image: true, voice: true } },
    }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const live = { bubbleMaxChars: 30 }
  try {
    const result = await syncConfigOnce({ baseUrl: `http://127.0.0.1:${port}`, liveConfig: live, timeoutMs: 1000 })
    assert.equal(result.ok, true)
    assert.equal(live.bubbleMaxChars, 15, '普通热配置要一起应用')
    assert.equal(live.toolEpoch, 'v0.5.1-test', '★ 第一条消息前就要有 toolEpoch')
    assert.deepEqual(live.features, { image: true, voice: true })
    // 失败路径：不许抛，返回 ok:false（启动流程继续用 config.json）。
    const bad = await syncConfigOnce({ baseUrl: 'http://127.0.0.1:1', liveConfig: {}, timeoutMs: 200 })
    assert.equal(bad.ok, false)
  } finally { srv.close() }
})

await check('startConfigPolling：features 变化也算人设变化（skill 开关会重推【能力】段）', async () => {
  const http = await import('node:http')
  let payload = { features: { image: false }, personaBotName: '小鱼' }
  const srv = http.createServer((req, res) => {
    if (req.url !== CONFIG_ROUTE_PATH) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, config: payload }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const live = {}
  const calls = []
  let synced = 0
  const stop = startConfigPolling({
    baseUrl: `http://127.0.0.1:${port}`,
    liveConfig: live,
    pollMs: 60,
    timeoutMs: 1000,
    onSync: () => { synced++ },
    onPersona: (hot) => { calls.push(hot); return { ok: true, action: 'pushed' } },
  })
  try {
    const deadline = Date.now() + 3000
    while (synced === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30))
    assert.equal(calls.length, 0, '首次同步只记录签名')
    payload = { ...payload, features: { image: true } }
    while (calls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30))
    assert.equal(calls.length, 1, `打开「发图片」应触发一次人设重推，实际 ${calls.length}`)
  } finally { stop(); srv.close() }
})

await check('pickHotConfig 放行人设新字段（名字/展示名/参与度/附加规则/覆盖）', () => {
  const hot = pickHotConfig({
    personaText: '猫娘',
    personaBotName: '小鱼',
    personaGroupName: '鱼酱',
    personaParticipation: 'quiet',
    personaExtraRules: '别熬夜',
    personaSystemPrompt: '',
  })
  assert.equal(hot.personaBotName, '小鱼')
  assert.equal(hot.personaGroupName, '鱼酱')
  assert.equal(hot.personaParticipation, 'quiet')
  assert.equal(hot.personaExtraRules, '别熬夜')
  assert.equal(hot.personaSystemPrompt, '')
})

await check('startConfigPolling：任意人设字段变化都会触发 onPersona（不只 personaText）', async () => {
  const http = await import('node:http')
  let payload = {
    personaBotName: '小鱼', personaGroupName: '', personaParticipation: 'normal',
    personaText: '', personaExtraRules: '', personaSystemPrompt: '',
  }
  const srv = http.createServer((req, res) => {
    if (req.url !== CONFIG_ROUTE_PATH) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, config: payload }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const live = {}
  const calls = []
  let synced = 0
  const stop = startConfigPolling({
    baseUrl: `http://127.0.0.1:${port}`,
    liveConfig: live,
    pollMs: 80,
    timeoutMs: 1000,
    onSync: () => { synced++ },
    onPersona: (hot) => { calls.push(hot); return { ok: true, action: 'upserted-override' } },
  })
  try {
    const deadline = Date.now() + 3000
    while (synced === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 40))
    assert.equal(calls.length, 0, '首次同步只记录，不应写人设')
    payload = { ...payload, personaParticipation: 'quiet' }
    while (calls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 40))
    assert.equal(calls.length, 1, `onPersona 调用 ${calls.length} 次`)
    assert.equal(calls[0].personaParticipation, 'quiet')
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
await check('Bridge.buildPersonaPrompt 把新字段整合成最终系统提示词', () => {
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:2852', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      stateFile: './state/__verify_absent__.json',
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  b.live.personaText = '你是 DeepSeek，也是群友。'
  b.live.personaBotName = '小鱼'
  b.live.personaGroupName = '鱼酱'
  b.live.personaParticipation = 'quiet'
  b.live.personaExtraRules = '别熬夜'
  const prompt = b.buildPersonaPrompt()
  assert.ok(prompt.includes('【身份】') && prompt.includes('小鱼') && prompt.includes('鱼酱'), prompt)
  assert.equal(prompt.includes('DeepSeek'), false, '名字没被替换')
  assert.ok(prompt.includes('【参与度】') && prompt.includes('【管理员附加规则】'), prompt)
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
/**
 * 给插件侧回归脚本准备的 env。
 *
 * 为什么需要：`test-guard-scope.mjs` / `test-autostart.mjs` 里定位 schemastery 的
 * 兜底值写成了字符串字面量（`'resolveSchemastery()'`，本意是**调用**那个函数），
 * 未设 `QQG_SCHEMASTERY` 时会拼出 `file:///resolveSchemastery()`，
 * 直接抛 ERR_INVALID_FILE_URL_PATH。这里按它们注释里写的办法显式提供路径，
 * **不改插件文件**（那是 Lead 的范围）；插件侧修好后这行自动退化成无害的显式指定。
 */
const pluginTestEnv = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidate = path.resolve(
    here, '../plugins/dsh-qq-guard/node_modules/@deepseek-ai/schemastery/lib/index.mjs')
  return (!process.env.QQG_SCHEMASTERY && fs.existsSync(candidate))
    ? { ...process.env, QQG_SCHEMASTERY: candidate }
    : process.env
})()

await check('plugins/dsh-qq-guard 作用域回归全绿', async () => {
  const { execFileSync } = await import('node:child_process')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const script = path.resolve(here, '../plugins/dsh-qq-guard/test-guard-scope.mjs')
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8', env: pluginTestEnv })
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
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8', env: pluginTestEnv })
  assert.match(out, /结果：\d+ 通过 \/ 0 失败/, `NapCat 回归未全绿：\n${out}`)
})

await check('plugins/dsh-qq-guard bridge.autoStart / 进程管理回归全绿（批次5）', async () => {
  const { execFileSync } = await import('node:child_process')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const script = path.resolve(here, '../plugins/dsh-qq-guard/test-autostart.mjs')
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8', env: pluginTestEnv })
  assert.match(out, /结果：\d+ 通过 \/ 0 失败/, `autoStart 回归未全绿：\n${out}`)
})

await check('qq-bridge 人设写入回归全绿', async () => {
  const { execFileSync } = await import('node:child_process')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const script = path.resolve(here, 'test-persona.mjs')
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8', env: pluginTestEnv })
  assert.match(out, /结果：\d+ 通过 \/ 0 失败/, `人设回归未全绿：\n${out}`)
})

console.log('\n— 插件侧回归：设置页数据通路（remote / HTTP 兜底 / 错误可见）—')
await check('plugins/dsh-qq-guard 设置数据通路回归全绿', async () => {
  const { execFileSync } = await import('node:child_process')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const script = path.resolve(here, '../plugins/dsh-qq-guard/test-settings-data.mjs')
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8', env: pluginTestEnv })
  assert.match(out, /结果：\d+ 通过 \/ 0 失败/, `设置数据通路回归未全绿：\n${out}`)
})

console.log('\n— Phase 4：节奏参数（热配置真实生效）—')
/**
 * 造一个只接假 DSH / 假 QQ 的 Bridge（不建会话、不发消息、不读写真实 state）。
 * 返回 { b, calls }：calls 记录 prompt / archive / 会话创建 / 实际发出的消息。
 */
function makeBridge({ rhythm, dsh: dshCfg, stateFile, allow, personaDefault, capability } = {}) {
  const b = new Bridge({
    config: {
      dsh: {
        baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x',
        agentPreset: 'qq-chat', ...(dshCfg ?? {}),
      },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: { private: ['1000000001'], groups: ['123456'], admins: [], allowAllWhenEmpty: false, ...(allow ?? {}) },
      ...(personaDefault ? { personaDefault } : {}),
      ...(capability ? { capability } : {}),
      sendDelayMs: 0,
      stateFile: stateFile ?? path.join(os.tmpdir(), `qq-bridge-state-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
      ...(rhythm ? { rhythm } : {}),
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  const calls = {
    prompts: [], archived: [], archiveOpts: [], existChecks: [], sent: [], created: 0,
    renamed: [], actions: [], personas: [],
    exists: true,       // sessionExists 的返回值
    archiveFails: [],   // 这些 id 的 archiveSession 会抛错
    groupName: '',      // get_group_info 返回的群名
    privateName: '',    // get_stranger_info 返回的昵称
    reply: '好',
    // 上下文自动清理（2026-10-27）：
    // outline = turnOutline 返回的数组（默认 0 轮，老用例不受自动清理影响）；
    // outlineCalls / compacts 记录调用，用来断言有没有多打 RPC、有没有真走压缩；
    // compactFails：非空 = compactSession 抛这个错误消息；**数组** = 每次调用按顺序取一条
    // （空位表示这次成功），用来模拟「第一次 busy、第二次成功」。
    outline: [],
    outlineCalls: [],
    compacts: [],
    compactFails: null,
    promptFails: null,
  }
  b.dsh = {
    sessionExists: async (id) => { calls.existChecks.push(id); return calls.exists },
    ensureWorkspace: async () => 'w1',
    createSession: async () => `s${++calls.created}`,
    selectModel: async () => {},
    archiveSession: async (id, opts) => {
      calls.archived.push(id)
      calls.archiveOpts.push(opts ?? {})
      if (calls.archiveFails.includes(id)) throw new Error('archive failed')
      return { ok: true }
    },
    renameSession: async (sid, title) => { calls.renamed.push({ sid, title }); return title },
    sessionTitle: async () => null,
    setSessionPersona: async (payload) => { calls.personas.push(payload); return { ok: true } },
    promptAndWait: async (sid, text, opts) => {
      calls.prompts.push({ sid, text, opts })
      // promptFails：数组 = 按次取（shift 掉一条）；字符串 = 每次都抛。用来模拟超时/看门狗。
      const fail = Array.isArray(calls.promptFails) ? calls.promptFails.shift() : calls.promptFails
      if (fail) {
        const err = new Error(fail)
        err.code = /TIMEOUT/i.test(fail) ? 'TIMEOUT' : 'ERR'
        throw err
      }
      return calls.reply
    },
    // 自动清理要读的轮数：假 DSH 直接回放预设数组（真实实现在 dsh.mjs 走 session/projections）。
    turnOutline: async (sid) => { calls.outlineCalls.push(sid); return calls.outline },
    // 原生压缩：真实实现是 commands/execute 投递 /compact，这里只要成败可控。
    compactSession: async (sid) => {
      calls.compacts.push(sid)
      // 数组 = 按次取（shift 掉一条），用来模拟 busy → 重试成功；字符串 = 每次都抛。
      const fail = Array.isArray(calls.compactFails) ? calls.compactFails.shift() : calls.compactFails
      if (fail) throw new Error(fail)
      return { kind: 'success', text: '已压缩' }
    },
  }
  // NapCat 侧：真实 Bridge 会调 get_group_info / get_stranger_info 取名字。
  b.qq.call = async (action, params) => {
    calls.actions.push({ action, params })
    if (action === 'get_group_info') return { status: 'ok', data: { group_name: calls.groupName } }
    if (action === 'get_stranger_info') return { status: 'ok', data: { nickname: calls.privateName } }
    return { status: 'ok', data: {} }
  }
  b.qq.sendPrivate = async (uid, text, opts) => { calls.sent.push({ kind: 'private', uid, text, opts }); return { ok: true, messageIds: ['1'] } }
  b.qq.sendGroup = async (gid, text, opts) => { calls.sent.push({ kind: 'group', gid, text, opts }); return { ok: true, messageIds: ['1'] } }
  b.qq._selfId = '999' // 假装登录的是 999，用于 @ 判定
  return { b, calls }
}

const privMsg = (text, id = 'pm') => ({
  kind: 'private', userId: '1000000001', groupId: null, text, messageId: id,
  raw: { message: [{ type: 'text', data: { text } }] },
})
const groupMsg = (text, { at = false, id = 'gm' } = {}) => ({
  kind: 'group', userId: '1000000001', groupId: '123456', text, messageId: id,
  raw: {
    message: at
      ? [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text } }]
      : [{ type: 'text', data: { text } }],
  },
})

await check('normalizeRhythm 缺字段时补默认值，非法值被夹紧', () => {
  const d = normalizeRhythm(undefined)
  assert.equal(d.activityLevel, 1)
  assert.equal(d.debounceWindowMs, 800)
  assert.equal(d.batchIntervalMs, 2500)
  assert.deepEqual(d.rateLimit, { perMin: 12, burst: 3, silent: true })
  assert.deepEqual(d.mute.words, ['闭嘴', '安静', '别刷屏'])
  assert.equal(d.mute.seconds, 60)
  const c = normalizeRhythm({ activityLevel: 9, debounceWindowMs: -5, rateLimit: { perMin: 0 } })
  assert.equal(c.activityLevel, 3, '上限夹紧')
  assert.equal(c.debounceWindowMs, 0, '下限夹紧')
  assert.equal(c.rateLimit.perMin, 1)
})
await check('关键词匹配是大小写不敏感的子串匹配', () => {
  assert.equal(matchActivityKeyword('DSH 在吗'), 'dsh')
  assert.equal(matchActivityKeyword('叫小鱼出来'), '小鱼')
  assert.equal(matchActivityKeyword('今天天气不错'), null)
  assert.equal(matchActivityKeyword('', ['dsh']), null)
})

await check('热配置改 activityLevel 立即生效（不重启），判否不建会话', async () => {
  const { b, calls } = makeBridge({ rhythm: { activityLevel: 0, debounceWindowMs: 0 } })
  await b.handleMessage(groupMsg('随便聊聊', { id: 'a1' }))
  assert.equal(calls.prompts.length, 0, '0 档群聊未 @ 不该回')
  assert.equal(calls.created, 0, '★ 判否时绝不建会话')
  b.live.rhythm = { ...b.live.rhythm, activityLevel: 3 }
  await b.handleMessage(groupMsg('随便聊聊', { id: 'a2' }))
  assert.equal(calls.prompts.length, 1, '★ 改完不重启，下一句立即按 3 档回复')
  assert.equal(calls.created, 1)
})
await check('activityLevel 0/1/2/3 的群聊判定（私聊永远回）', () => {
  const { b } = makeBridge({ rhythm: { activityLevel: 0 } })
  const plain = groupMsg('今天天气不错')
  const kw = groupMsg('dsh 在吗')
  const at = groupMsg('在吗', { at: true })
  assert.equal(b.shouldRespond(plain, plain.text), false, '0 档：普通消息不回')
  assert.equal(b.shouldRespond(kw, kw.text), false, '0 档：关键词也不回')
  assert.equal(b.shouldRespond(at, at.text), true, '0 档：@ 必回')
  b.live.rhythm = { ...b.live.rhythm, activityLevel: 1 }
  assert.equal(b.shouldRespond(kw, kw.text), true, '1 档：关键词回')
  assert.equal(b.shouldRespond(plain, plain.text), false, '1 档：普通消息不回')
  b.live.rhythm = { ...b.live.rhythm, activityLevel: 2, randomChance: 0.15 }
  assert.equal(b.shouldRespond(kw, kw.text), true, '2 档：关键词仍回')
  b._random = () => 0.01
  assert.equal(b.shouldRespond(plain, plain.text), true, '2 档：概率内随机回')
  b._random = () => 0.99
  assert.equal(b.shouldRespond(plain, plain.text), false, '2 档：概率外不回')
  b.live.rhythm = { ...b.live.rhythm, activityLevel: 3 }
  assert.equal(b.shouldRespond(plain, plain.text), true, '3 档：全回')
  b.live.rhythm = { ...b.live.rhythm, activityLevel: 0 }
  const p = privMsg('随便说说')
  assert.equal(b.shouldRespond(p, p.text), true, '★ 私聊在 0 档也永远回')
})
await check('applyHotConfig 写进 live.rhythm 后判定立即变', () => {
  const { b } = makeBridge({ rhythm: { activityLevel: 0 } })
  const plain = groupMsg('随便')
  assert.equal(b.shouldRespond(plain, plain.text), false)
  applyHotConfig(b.live, pickHotConfig({ rhythm: { activityLevel: 3 } }))
  assert.equal(b.shouldRespond(plain, plain.text), true)
})
await check('防抖：窗口内 3 条合并成 1 次 prompt（换行拼接）', async () => {
  const { b, calls } = makeBridge({ rhythm: { activityLevel: 3, debounceWindowMs: 40 } })
  await b.handleMessage(groupMsg('第一句', { id: 'd1' }))
  await b.handleMessage(groupMsg('第二句', { id: 'd2' }))
  await b.handleMessage(groupMsg('第三句', { id: 'd3' }))
  assert.equal(calls.prompts.length, 0, '窗口内不该立刻投递')
  assert.ok(await waitUntil(() => calls.prompts.length > 0, 2000), '窗口结束后应投递')
  await tick(20) // 给可能的第二次投递留时间
  assert.equal(calls.prompts.length, 1, `实际 ${calls.prompts.length} 次 prompt`)
  // v2.0 第十步：prompt 末尾会追加「本群动态记忆」小节，这里只断言正文开头。
  assert.ok(calls.prompts[0].text.startsWith(
    '[群友 1000000001(1000000001)]: 第一句\n[群友 1000000001(1000000001)]: 第二句\n[群友 1000000001(1000000001)]: 第三句',
  ), `正文不对：${calls.prompts[0].text.slice(0, 120)}`)
})
await check('防抖：超过窗口的两条分别投递', async () => {
  const { b, calls } = makeBridge({ rhythm: { activityLevel: 3, debounceWindowMs: 30 } })
  await b.handleMessage(groupMsg('甲', { id: 'e1' }))
  assert.ok(await waitUntil(() => calls.prompts.length === 1, 1000))
  await b.handleMessage(groupMsg('乙', { id: 'e2' }))
  assert.ok(await waitUntil(() => calls.prompts.length === 2, 1000))
  const texts = calls.prompts.map((p) => p.text)
  assert.ok(texts[0].startsWith('[群友 1000000001(1000000001)]: 甲'), `第 1 条正文不对：${texts[0].slice(0, 80)}`)
  assert.ok(texts[1].startsWith('[群友 1000000001(1000000001)]: 乙'), `第 2 条正文不对：${texts[1].slice(0, 80)}`)
})
await check('热配置改 debounceWindowMs 立即生效', async () => {
  const { b, calls } = makeBridge({ rhythm: { activityLevel: 3, debounceWindowMs: 0 } })
  await b.handleMessage(groupMsg('一', { id: 'w1' }))
  assert.equal(calls.prompts.length, 1, '窗口 0 = 立即投递')
  b.live.rhythm = { ...b.live.rhythm, debounceWindowMs: 40 }
  await b.handleMessage(groupMsg('二', { id: 'w2' }))
  await b.handleMessage(groupMsg('三', { id: 'w3' }))
  assert.equal(calls.prompts.length, 1, '改窗口后应攒着')
  assert.ok(await waitUntil(() => calls.prompts.length === 2, 1000))
  assert.ok(calls.prompts[1].text.startsWith(
    '[群友 1000000001(1000000001)]: 二\n[群友 1000000001(1000000001)]: 三',
  ), `正文不对：${calls.prompts[1].text.slice(0, 100)}`)
})
await check('限频：超过 perMin+burst 静默丢弃（silent=true）', async () => {
  const { b, calls } = makeBridge({
    rhythm: { activityLevel: 3, debounceWindowMs: 0, rateLimit: { perMin: 2, burst: 1, silent: true } },
  })
  for (let i = 0; i < 5; i++) await b.handleMessage(groupMsg(`第${i}条`, { id: `r${i}` }))
  assert.equal(calls.prompts.length, 3, `perMin=2 + burst=1 → 3 条，实际 ${calls.prompts.length}`)
  assert.equal(calls.sent.length, 3, '静默模式下超限不回任何提示')
  assert.equal(b.stats.rateLimited, 2)
  assert.equal(b.stats.replied, 3, '只统计真正回复')
})
await check('限频：silent=false 时回一句提示（提示不计入回复数）', async () => {
  const { b, calls } = makeBridge({
    rhythm: { activityLevel: 3, debounceWindowMs: 0, rateLimit: { perMin: 2, burst: 0, silent: false } },
  })
  for (let i = 0; i < 4; i++) await b.handleMessage(groupMsg(`第${i}条`, { id: `s${i}` }))
  assert.equal(calls.prompts.length, 2)
  assert.equal(b.stats.replied, 2)
  const hints = calls.sent.filter((s) => s.text.includes('慢一点'))
  assert.equal(hints.length, 2, `超限两次应各回一次提示，实际 ${hints.length}`)
})
await check('禁言：命中 words 后静默，期间不回复也不建会话', async () => {
  const { b, calls } = makeBridge({
    rhythm: { activityLevel: 3, debounceWindowMs: 0, mute: { enabled: true, words: ['闭嘴'], seconds: 60 } },
  })
  await b.handleMessage(groupMsg('闭嘴', { id: 'mu1' }))
  assert.equal(calls.prompts.length, 0, '禁言指令本身不回复')
  assert.equal(calls.created, 0, '不建会话')
  await b.handleMessage(groupMsg('还在吗', { id: 'mu2' }))
  assert.equal(calls.prompts.length, 0, '静音期内不回复')
  assert.equal(b.stats.muted, 1)
  // 让静音过期（模拟 60s 到点），再看是否恢复
  b._muted.set('g:123456', Date.now() - 1)
  await b.handleMessage(groupMsg('现在呢', { id: 'mu3' }))
  assert.equal(calls.prompts.length, 1, '静音过期后恢复回复')
})
await check('禁言开关关闭时「闭嘴」照常回复', async () => {
  const { b, calls } = makeBridge({
    rhythm: { activityLevel: 3, debounceWindowMs: 0, mute: { enabled: false, words: ['闭嘴'], seconds: 60 } },
  })
  await b.handleMessage(groupMsg('闭嘴', { id: 'mz1' }))
  assert.equal(calls.prompts.length, 1)
  assert.equal(b._isMuted('g:123456'), false)
})
await check('batchIntervalMs：相邻气泡取 max(原间隔, 批次间隔)', () => {
  const c = new OneBotClient({ logger: undefined, bubbleMaxChars: 30, batchIntervalMs: 2500 })
  assert.equal(c._gapBefore(0, ['x']), 2500)
  assert.ok(c._baseGap(0, ['x']) < 2500, '原间隔仍是分级打字延时')
  const c2 = new OneBotClient({ logger: undefined })
  // 未配置时不是 2500，而是原来的分级打字延时（200ms 档 ±15% 抖动）。
  assert.equal(c2.batchIntervalMs, 0)
  const g = c2._gapBefore(0, ['x'])
  assert.ok(g >= 150 && g <= 231, `未配置批次间隔时应沿用原间隔，实际 ${g}`)
})
await check('热配置改 batchIntervalMs 立即刷进客户端', () => {
  const { b } = makeBridge({ rhythm: { batchIntervalMs: 600 } })
  assert.equal(b.qq.batchIntervalMs, 600)
  b.live.rhythm = { ...b.live.rhythm, batchIntervalMs: 1200 }
  b._applyLiveToClient()
  assert.equal(b.qq.batchIntervalMs, 1200)
})
await check('pickHotConfig 放行 rhythm / dsh.archiveStaleSessions，但拒绝 dsh 连接字段', () => {
  const hot = pickHotConfig({
    rhythm: { activityLevel: 2, rateLimit: { perMin: 5 } },
    dsh: { archiveStaleSessions: false, baseUrl: 'http://evil:1', sessionCwd: 'C:\\evil' },
  })
  assert.equal(hot.rhythm.activityLevel, 2)
  assert.equal(hot.dsh.archiveStaleSessions, false)
  assert.equal('baseUrl' in hot.dsh, false, '★ 连接地址绝不能被设置页覆盖')
  assert.equal('sessionCwd' in hot.dsh, false)
})

console.log('\n— 会话失效自动归档（Phase 4）—')
const makeStateFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-stale-'))
  return { dir, stateFile: path.join(dir, 'sessions.json') }
}

await check('重建失效会话：调用 archiveSession(oldId)，映射更新并落盘', async () => {
  const { dir, stateFile } = makeStateFile()
  try {
    const { b, calls } = makeBridge({ rhythm: { debounceWindowMs: 0 }, stateFile })
    b.state.sessions['g:123456'] = 'old-g'
    calls.exists = false
    const sid = await b.ensureSession('g:123456')
    assert.equal(calls.archived[0], 'old-g', '应归档旧会话 id')
    assert.equal(sid, 's1')
    assert.equal(b.state.sessions['g:123456'].sessionId, 's1')
    assert.deepEqual(b.state.stale, [], '归档成功不进 stale')
    assert.equal(b.state.rebuilds, 1, '重建事件计数')
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.equal(saved.sessions['g:123456'].sessionId, 's1')
    assert.deepEqual(saved.stale, [])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
await check('归档失败仍成功重建，旧 id 进 stale 并落盘', async () => {
  const { dir, stateFile } = makeStateFile()
  try {
    const { b, calls } = makeBridge({ rhythm: { debounceWindowMs: 0 }, stateFile })
    b.state.sessions['u:1000000001'] = 'old-u'
    calls.exists = false
    calls.archiveFails = ['old-u']
    const sid = await b.ensureSession('u:1000000001')
    assert.equal(sid, 's1', '★ 归档失败不能阻塞重建')
    assert.equal(calls.archived[0], 'old-u', '确实尝试过归档')
    assert.deepEqual(b.state.stale, ['old-u'])
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.deepEqual(saved.stale, ['old-u'], 'stale 应落盘')
    assert.equal(saved.sessions['u:1000000001'].sessionId, 's1')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
await check('archiveStaleSessions=false：不归档，只记 stale', async () => {
  const { dir, stateFile } = makeStateFile()
  try {
    const { b, calls } = makeBridge({ dsh: { archiveStaleSessions: false }, stateFile })
    b.state.sessions['g:123456'] = 'old-g'
    calls.exists = false
    await b.ensureSession('g:123456')
    assert.equal(calls.archived.length, 0, '开关关闭时绝不归档')
    assert.deepEqual(b.state.stale, ['old-g'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
await check('stale 去重且最多保留 100 条', () => {
  const { b } = makeBridge({})
  b._noteStale('a')
  b._noteStale('a')
  assert.deepEqual(b.state.stale, ['a'], '去重')
  for (let i = 0; i < 120; i++) b._noteStale(`id-${i}`)
  assert.equal(b.state.stale.length, 100, '上限 100')
  assert.equal(new Set(b.state.stale).size, 100)
  assert.equal(b.state.stale.includes('a'), false, '最老的被挤出去')
})
await check('cleanupStale：成功的移除、失败的保留，返回计数并落盘', async () => {
  const { dir, stateFile } = makeStateFile()
  try {
    const { b, calls } = makeBridge({ stateFile })
    b.state.stale = ['a', 'b', 'c']
    calls.archiveFails = ['c']
    const r = await b.cleanupStale()
    assert.deepEqual(r, { ok: false, archived: 2, failed: 1, remaining: 1 })
    assert.deepEqual(b.state.stale, ['c'])
    assert.deepEqual([...calls.archived].sort(), ['a', 'b', 'c'])
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.deepEqual(saved.stale, ['c'], '清理结果应落盘')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
await check('cleanupStale 全成功：ok=true、stale 清空', async () => {
  const { dir, stateFile } = makeStateFile()
  try {
    const { b, calls } = makeBridge({ stateFile })
    b.state.stale = ['x', 'y']
    const r = await b.cleanupStale()
    assert.deepEqual(r, { ok: true, archived: 2, failed: 0, remaining: 0 })
    assert.deepEqual(b.state.stale, [])
    assert.equal(calls.archived.length, 2)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
await check('cleanupStale({ archive:false }) 只清点不动手', async () => {
  const { b, calls } = makeBridge({})
  b.state.stale = ['x', 'y']
  const r = await b.cleanupStale({ archive: false })
  assert.deepEqual(r, { ok: true, archived: 0, failed: 0, remaining: 2 })
  assert.equal(calls.archived.length, 0)
  assert.deepEqual(b.state.stale, ['x', 'y'], '不动 stale')
})

console.log('\n— 会话管理（schema / 命名 / 未读）—')
await check('旧版 sessions.json（裸 sessionId）读入后自动升级成对象', () => {
  const { dir, stateFile } = makeStateFile()
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ sessions: { 'u:1000000001': 'session-old' }, generation: 0 }), 'utf8')
    const { b } = makeBridge({ stateFile })
    const entry = b.state.sessions['u:1000000001']
    assert.equal(entry.sessionId, 'session-old', '★ 旧映射不能丢')
    assert.equal(entry.unread, 0)
    assert.equal(entry.kind, 'private')
    assert.equal(entry.qq, '1000000001')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
await check('命名规范：私聊-昵称 / 群聊-群名(群号)，昵称缺失退回号码', () => {
  assert.equal(sessionTitleFor('private', '翎羽', '10001'), '私聊-翎羽')
  assert.equal(sessionTitleFor('group', '摸鱼群', '20002'), '群聊-摸鱼群(20002)')
  assert.equal(sessionTitleFor('group', '', '20002'), '群聊-20002')
  assert.equal(sessionTitleFor('private', '', '10001'), '私聊-10001')
  assert.deepEqual(parseSessionKey('g:20002'), { kind: 'group', qq: '20002' })
  assert.deepEqual(parseSessionKey('u:10001'), { kind: 'private', qq: '10001' })
})
await check('建会话后立刻 rename：群聊-群名(群号)，标题已对齐时不再重复改', async () => {
  const { b, calls } = makeBridge({ rhythm: { debounceWindowMs: 0 } })
  calls.groupName = '摸鱼群'
  await b.ensureSession('g:123456', groupMsg('hi'))
  assert.equal(calls.renamed.length, 1, '建完会话必须改一次名')
  assert.equal(calls.renamed[0].title, '群聊-摸鱼群(123456)')
  assert.equal(b.state.sessions['g:123456'].title, '群聊-摸鱼群(123456)')
  await b.ensureSession('g:123456', groupMsg('again', { id: 'g2' }))
  assert.equal(calls.renamed.length, 1, '★ 接管已有会话时标题一致就不该再 resume 一次')
})
await check('私聊用 get_stranger_info 取昵称', async () => {
  const { b, calls } = makeBridge({ rhythm: { debounceWindowMs: 0 } })
  calls.privateName = '翎羽'
  await b.ensureSession('u:1000000001', privMsg('hi'))
  assert.equal(calls.actions[0]?.action, 'get_stranger_info')
  assert.equal(calls.renamed[0].title, '私聊-翎羽')
})
await check('NapCat 取名失败时退回消息里的 senderName / 号码，不阻塞建会话', async () => {
  const { b, calls } = makeBridge({ rhythm: { debounceWindowMs: 0 } })
  b.qq.call = async () => { throw new Error('napcat down') }
  const sid = await b.ensureSession('g:123456', { ...groupMsg('hi'), senderName: '群友甲' })
  assert.equal(sid, 's1')
  assert.equal(calls.renamed[0].title, '群聊-群友甲(123456)')
})
await check('未读：收到 +1，回复成功清零；被档位跳过也计数', async () => {
  const { b, calls } = makeBridge({ rhythm: { activityLevel: 0, debounceWindowMs: 0 } })
  await b.handleMessage(groupMsg('随便聊聊', { id: 'u1' }))
  assert.equal(b.state.sessions['g:123456'].unread, 1, '★ 被档位跳过也要记未读')
  await b.handleMessage(groupMsg('随便聊聊', { id: 'u2' }))
  assert.equal(b.state.sessions['g:123456'].unread, 2)
  b.live.rhythm = { ...b.live.rhythm, activityLevel: 3 }
  await b.handleMessage(groupMsg('在吗', { id: 'u3' }))
  assert.equal(calls.prompts.length, 1)
  assert.equal(b.state.sessions['g:123456'].unread, 0, '回复成功后清零')
})
await check('未读：白名单外的消息不计数', async () => {
  const { b } = makeBridge({})
  await b.handleMessage({ ...privMsg('广告'), userId: '4000000000' })
  assert.equal(b.state.sessions['u:4000000000'], undefined)
})
await check('sessionViews 按最近活动倒序，status 上报带 sessions', () => {
  const { b } = makeBridge({})
  b.state.sessions['u:1000000001'] = normalizeSessionEntry('u:1000000001', { sessionId: 's1', unread: 2, lastAt: 100 })
  b.state.sessions['g:123456'] = normalizeSessionEntry('g:123456', { sessionId: 's2', unread: 0, lastAt: 200 })
  const rows = b.sessionViews()
  assert.deepEqual(rows.map((r) => r.key), ['g:123456', 'u:1000000001'])
  assert.equal(rows[1].unread, 2)
  const status = buildBridgeStatus({ health: { connected: true, online: true }, counts: {}, sessions: rows })
  assert.equal(status.sessions.length, 2)
  assert.equal(status.sessions[0].key, 'g:123456')
})
await check('旧版桥接不报 sessions 时，status 里不能凭空出现空列表', () => {
  const status = buildBridgeStatus({ health: {}, counts: {} })
  assert.equal('sessions' in status, false)
})

console.log('\n— 管理员权限（/ 指令）—')
await check('非管理员发 / 指令：直接拒绝，不投递 DSH，未读清零', async () => {
  const { b, calls } = makeBridge({ rhythm: { debounceWindowMs: 0 }, allow: { admins: ['2000000002'] } })
  await b.handleMessage(privMsg('/clear', 'cmd1'))
  assert.equal(calls.prompts.length, 0, '★ 非管理员指令绝不能发给 DSH（省 token）')
  assert.equal(calls.created, 0, '也不该建会话')
  assert.equal(b.stats.commandsBlocked, 1)
  assert.equal(calls.sent.length, 1)
  assert.match(calls.sent[0].text, /权限不足/, `回复文案「${calls.sent[0].text}」`)
  assert.equal(b.state.sessions['u:1000000001'].unread, 0, '回了提示，红点应清零')
})
await check('管理员发 / 指令：放行投递 DSH', async () => {
  const { b, calls } = makeBridge({ rhythm: { debounceWindowMs: 0 }, allow: { admins: ['1000000001'] } })
  await b.handleMessage(privMsg('/clear', 'cmd2'))
  assert.equal(calls.prompts.length, 1, '管理员指令应进 prompt')
  assert.ok(calls.prompts[0].text.startsWith('/clear'))
  assert.equal(b.stats.commandsBlocked, 0)
})
await check('管理员身份不绕过白名单：不在 allow.private 里仍被拦', async () => {
  const { b, calls } = makeBridge({ allow: { private: [], admins: ['1000000001'] } })
  await b.handleMessage(privMsg('/clear', 'cmd3'))
  assert.equal(calls.prompts.length, 0)
  assert.equal(b.stats.denied, 1, '先被白名单挡掉')
  assert.equal(calls.sent.length, 0, '白名单外连提示都不回')
})
await check('普通消息不受指令拦截影响', async () => {
  const { b, calls } = makeBridge({ rhythm: { debounceWindowMs: 0 }, allow: { admins: [] } })
  await b.handleMessage(privMsg('你好', 'normal'))
  assert.equal(calls.prompts.length, 1)
})
await check('管理员指令不受响应档位限制（群里没 @ 也能执行）', async () => {
  const { b, calls } = makeBridge({
    rhythm: { activityLevel: 0, debounceWindowMs: 0 },
    allow: { admins: ['1000000001'] },
  })
  await b.handleMessage(groupMsg('/reset', { id: 'cmd4' }))
  assert.equal(calls.prompts.length, 1, '★ 管理员指令应放行，不因档位被跳过')
  assert.ok(calls.prompts[0].text.startsWith('/reset'), `指令正文不对：${calls.prompts[0].text.slice(0, 60)}`)
})

console.log('\n— 人设推送（动态 section 的数据源）—')
await check('全局人设推送：mode=default + 文本', async () => {
  const { b, calls } = makeBridge({ personaDefault: '默认人设' })
  assert.equal(b._defaultPersona(), '默认人设')
  await b.setGlobalPersona('全局人设')
  assert.equal(calls.personas[0].mode, 'default')
  assert.equal(calls.personas[0].text, '全局人设')
})
await check('每条消息前推单人设；非管理员追加权限提示，管理员不追加', async () => {
  const { b: nonAdmin, calls: nonAdminCalls } = makeBridge({ rhythm: { debounceWindowMs: 0 }, allow: { admins: [] } })
  await nonAdmin.setGlobalPersona('全局人设')
  await nonAdmin.handleMessage(privMsg('第二句', 'p2'))
  assert.ok(nonAdminCalls.personas.at(-1).text.includes(ADMIN_GUARD_NOTE), '非管理员应追加权限提示')

  const { b: admin, calls: adminCalls } = makeBridge({
    rhythm: { debounceWindowMs: 0 },
    allow: { admins: ['1000000001'] },
  })
  await admin.setGlobalPersona('全局人设')
  await admin.handleMessage(privMsg('管理员的普通消息', 'p3'))
  assert.equal(adminCalls.personas.at(-1).text.includes(ADMIN_GUARD_NOTE), false, '管理员不追加')
})
await check('单人设优先于全局人设；空串回退全局', async () => {
  const { b, calls } = makeBridge({ rhythm: { debounceWindowMs: 0 }, allow: { admins: ['1000000001'] } })
  const entry = b._entryOf('u:1000000001')
  entry.sessionId = 's1'
  entry.persona = '群专属人设'
  await b._applyPersona('u:1000000001', 's1', true)
  assert.equal(calls.personas.at(-1).text, '群专属人设')
  assert.equal(calls.personas.at(-1).text.includes(ADMIN_GUARD_NOTE), false, '管理员不追加提示')
  entry.persona = ''
  await b.setGlobalPersona('全局人设')
  await b._applyPersona('u:1000000001', 's1', true)
  assert.equal(calls.personas.at(-1).text, '全局人设')
})

console.log('\n— 会话指令（清空 / 删除 / 单人设）—')
await check('clear：归档旧会话（stopActivity）→ 建新会话 → 映射更新、未读清零', async () => {
  const { b, calls } = makeBridge({ rhythm: { debounceWindowMs: 0 } })
  const entry = b._entryOf('g:123456')
  entry.sessionId = 'old-g'
  entry.unread = 5
  entry.title = '群聊-旧群(123456)'
  const result = await b.applySessionOp({ op: 'clear', key: 'g:123456' })
  assert.equal(result.ok, true)
  assert.equal(result.archived, true)
  assert.deepEqual(calls.archived, ['old-g'])
  assert.equal(calls.archiveOpts[0].stopActivity, true, '★ 必须带 stopActivity，否则活跃会话归档失败')
  assert.equal(b.state.sessions['g:123456'].sessionId, 's1')
  assert.equal(b.state.sessions['g:123456'].unread, 0)
  assert.ok(calls.renamed.some((r) => r.sid === 's1'), '新会话要重新对齐标题')
})
await check('clear：归档失败也继续建新会话（不把用户卡住）', async () => {
  const { b, calls } = makeBridge({})
  const entry = b._entryOf('u:1000000001')
  entry.sessionId = 'old-u'
  calls.archiveFails = ['old-u']
  const result = await b.applySessionOp({ op: 'clear', key: 'u:1000000001' })
  assert.equal(result.ok, true)
  assert.equal(result.archived, false)
  assert.equal(b.state.sessions['u:1000000001'].sessionId, 's1')
  assert.deepEqual(b.state.stale, ['old-u'], '归档失败记 stale 供清理路由重试')
})
await check('delete：归档（stopActivity）+ 删除本地映射', async () => {
  const { b, calls } = makeBridge({})
  const entry = b._entryOf('g:123456')
  entry.sessionId = 'old-g'
  const result = await b.applySessionOp({ op: 'delete', key: 'g:123456' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.archived, ['old-g'])
  assert.equal(calls.archiveOpts[0].stopActivity, true)
  assert.equal(b.state.sessions['g:123456'], undefined, '映射必须删掉，否则页面删不掉')
})
await check('delete：归档失败仍删映射（用户点了删除就得消失）', async () => {
  const { b, calls } = makeBridge({})
  const entry = b._entryOf('u:1000000001')
  entry.sessionId = 'old-u'
  calls.archiveFails = ['old-u']
  const result = await b.applySessionOp({ op: 'delete', key: 'u:1000000001' })
  assert.equal(result.ok, true)
  assert.equal(b.state.sessions['u:1000000001'], undefined)
})
await check('persona op：写入 state 并立即推送', async () => {
  const { b, calls } = makeBridge({})
  const entry = b._entryOf('g:123456')
  entry.sessionId = 's1'
  const result = await b.applySessionOp({ op: 'persona', key: 'g:123456', text: ' 专属人设 ' })
  assert.equal(result.ok, true)
  assert.equal(b.state.sessions['g:123456'].persona, ' 专属人设 ')
  // 推送前会 trim（系统提示词不该带首尾空白），state 保留原文本由 UI 回显
  assert.equal(calls.personas.at(-1).text, '专属人设')
  const rows = b.sessionViews()
  assert.equal(rows.find((r) => r.key === 'g:123456').persona, ' 专属人设 ')
})
await check('空 persona op = 清除单人设', async () => {
  const { b } = makeBridge({})
  const entry = b._entryOf('g:123456')
  entry.persona = '旧人设'
  await b.applySessionOp({ op: 'persona', key: 'g:123456', text: '' })
  assert.equal(b.state.sessions['g:123456'].persona, '')
})

console.log('\n— 群聊引用回复：桥接侧开关（2026-10-27）—')
await check('默认开启：群聊回复带原消息 id（引用气泡），且不再重复 @', async () => {
  const { b, calls } = makeBridge({ rhythm: { activityLevel: 3, debounceWindowMs: 0 } })
  await b.handleMessage(groupMsg('在吗', { at: true, id: '778899' }))
  assert.equal(calls.sent.length, 1, '应该只回一条')
  assert.equal(calls.sent[0].opts?.replyTo, '778899', '★ 带原消息 id')
  assert.equal(calls.sent[0].opts?.atUserId, undefined, '★ 引用时不再 @')
})

await check("replyQuoteMode='at'：不引用，沿用 @ 发送者（老行为）", async () => {
  const { b, calls } = makeBridge({ rhythm: { activityLevel: 3, debounceWindowMs: 0 } })
  b.live.replyQuoteMode = 'at'
  await b.handleMessage(groupMsg('在吗', { at: true, id: '778899' }))
  assert.equal(calls.sent[0].opts?.replyTo, undefined, '★ 关闭引用')
  assert.equal(calls.sent[0].opts?.atUserId, '1000000001')
  assert.equal(calls.sent[0].opts?.atPosition, 'last')
})

await check('私聊永不引用（引用只对群聊）', async () => {
  const { b, calls } = makeBridge({ rhythm: { activityLevel: 3, debounceWindowMs: 0 } })
  await b.handleMessage(privMsg('在吗', 'p9'))
  assert.equal(calls.sent.length, 1)
  assert.equal(calls.sent[0].kind, 'private')
  assert.equal(calls.sent[0].opts, undefined, '★ 私聊发送不带任何附加段')
})

await check('at:false（插件通道发送）不引用别人的原消息', async () => {
  const { b, calls } = makeBridge({})
  await b._send(groupMsg('x', { id: '778899' }), '插件消息', { at: false })
  assert.equal(calls.sent[0].text, '插件消息')
  assert.equal(calls.sent[0].opts?.replyTo, undefined)
})

await check('入站没有 message_id 时退回 @（不生成空引用段）', async () => {
  const { b, calls } = makeBridge({})
  await b._send({ kind: 'group', userId: '1000000001', groupId: '123456', messageId: '' }, '你好')
  assert.equal(calls.sent[0].opts?.replyTo, undefined)
  assert.equal(calls.sent[0].opts?.atUserId, '1000000001')
})

console.log('\n— 并发隔离：A/B 同时说话不许串台（2026-10-27 真机 Bug）—')
/** 指定发送者的群消息（groupMsg 固定了 userId，这里需要两个人）。 */
const gm = (text, id, userId) => ({
  kind: 'group', userId, groupId: '123456', text, messageId: id,
  raw: { message: [{ type: 'text', data: { text } }] },
})
const sentQuotes = (calls) => calls.sent.map((s) => s.opts?.replyTo)

await check('★ A、B 几乎同时说话：两轮各回各的，引用各自的原消息 id', async () => {
  const { b, calls } = makeBridge({ rhythm: { activityLevel: 3, debounceWindowMs: 40 } })
  await b.handleMessage(gm('你知不知道主人是谁', 'A-id', '1001'))
  await b.handleMessage(gm('甩不了', 'B-id', '1002'))
  await sleep(120)
  assert.equal(calls.prompts.length, 2, `★ 应各成一轮，实际 ${calls.prompts.length}`)
  assert.equal(calls.sent.length, 2)
  assert.deepEqual(sentQuotes(calls), ['A-id', 'B-id'], '★ A 的回 A，B 的回 B')
})

await check('同一个人连发多条仍合并成一轮，引用他最后那条', async () => {
  const { b, calls } = makeBridge({ rhythm: { activityLevel: 3, debounceWindowMs: 40 } })
  await b.handleMessage(gm('在吗', 'A1', '1001'))
  await b.handleMessage(gm('帮我看个东西', 'A2', '1001'))
  await sleep(120)
  assert.equal(calls.prompts.length, 1, '同一个人连发应合并')
  assert.equal(calls.sent.length, 1)
  assert.equal(sentQuotes(calls)[0], 'A2', '引用该发送者最后一条')
  assert.match(calls.prompts[0].text, /在吗[\s\S]*帮我看个东西/, '两条都进了模型正文')
})

await check('★ 上一轮超时：错误提示仍引用本轮原消息，不被下一条抢占', async () => {
  const { b, calls } = makeBridge({ rhythm: { activityLevel: 3, debounceWindowMs: 40 } })
  calls.promptFails = ['TIMEOUT 等待回复超时（20s）']
  await b.handleMessage(gm('你知不知道主人是谁', 'A-id', '1001'))
  await b.handleMessage(gm('甩不了', 'B-id', '1002'))
  await sleep(120)
  assert.equal(calls.sent.length, 2)
  assert.deepEqual(sentQuotes(calls), ['A-id', 'B-id'], '★ 超时那轮的错误提示也得引用 A 自己的消息')
  assert.match(calls.sent[0].text, /卡住|稍后再试/, '第一条是超时提示')
  assert.equal(calls.sent[1].text, calls.reply, '第二条才是正常回复')
})

await check('不同群同时说话：各自引用各自的原消息（跨 key 也不串）', async () => {
  const { b, calls } = makeBridge({
    rhythm: { activityLevel: 3, debounceWindowMs: 0 },
    allow: { groups: ['123456', '654321'] },
  })
  await Promise.all([
    b.handleMessage({ kind: 'group', userId: '1001', groupId: '123456', text: '甲群的问题', messageId: 'G1-id', raw: {} }),
    b.handleMessage({ kind: 'group', userId: '1002', groupId: '654321', text: '乙群的问题', messageId: 'G2-id', raw: {} }),
  ])
  assert.equal(calls.sent.length, 2)
  assert.deepEqual(sentQuotes(calls), ['G1-id', 'G2-id'])
})

console.log('\n— 占位符清洗 + 图文顺序（2026-10-27 真机 Bug）—')
await check('stripMetaNotes：整行括号说明被删，正常正文保留', () => {
  assert.equal(stripMetaNotes('[无文字回复，已在同一条里发了表情包]'), '')
  assert.equal(stripMetaNotes('在吗\n[无文字回复，已在同一条里发了表情包]'), '在吗')
  assert.equal(stripMetaNotes('好（已发图）'), '好')
  assert.equal(stripMetaNotes('哈\n\n[已发送表情包]\n'), '哈')
})
await check('stripMetaNotes：不误伤普通方括号内容', () => {
  assert.equal(stripMetaNotes('[CQ:at,qq=999] 你谁'), '[CQ:at,qq=999] 你谁')
  assert.equal(stripMetaNotes('【公告】今晚八点开会'), '【公告】今晚八点开会')
  assert.equal(stripMetaNotes('正常的一句话'), '正常的一句话')
})

await check('★ 文本+图：文字先发（带引用），350ms 后才是图', async () => {
  const { b } = makeBridge({})
  const order = []
  b.qq.sendGroup = async (gid, text, opts) => { order.push(['text', Date.now(), text, opts?.replyTo]); return { ok: true, messageIds: ['1'] } }
  b.qq.sendImage = async () => { order.push(['image', Date.now()]); return { ok: true, via: 'file' } }
  const entry = b._entryOf('g:123456')
  entry.sessionId = 's1'
  let queuedResult
  b.dsh.promptAndWait = async () => {
    queuedResult = await b.applySessionOp({ op: 'image', sessionId: 's1', url: 'http://x/1.png' })
    return '给'
  }
  await b._processBatch('g:123456', gm('来张图', 'Q1', '1001'), ['来张图'], [])
  assert.equal(queuedResult?.queued, true, '★ 模型中途发的图先排队，不抢跑')
  assert.deepEqual(order.map((o) => o[0]), ['text', 'image'], '★ 先文字后图片')
  assert.equal(order[0][2], '给')
  assert.equal(order[0][3], 'Q1', '文字仍带引用')
  assert.ok(order[1][1] - order[0][1] >= 300, `间隔应 ≥300ms，实际 ${order[1][1] - order[0][1]}`)
})

await check('★ 只有图没有文字：不补占位提示，图片照发', async () => {
  const { b } = makeBridge({})
  const order = []
  b.qq.sendGroup = async (gid, text) => { order.push(['text', text]); return { ok: true, messageIds: ['1'] } }
  b.qq.sendImage = async () => { order.push(['image']); return { ok: true, via: 'file' } }
  const entry = b._entryOf('g:123456')
  entry.sessionId = 's1'
  b.dsh.promptAndWait = async () => {
    await b.applySessionOp({ op: 'image', sessionId: 's1', url: 'http://x/2.png' })
    return '[无文字回复，已在同一条里发了表情包]'
  }
  await b._processBatch('g:123456', gm('发个表情', 'Q2', '1001'), ['发个表情'], [])
  assert.deepEqual(order, [['image']], '★ 只有图，没有文字气泡，也没有中括号提示')
})

await check('本轮既没开图、正文清洗后也空：什么都不发（回归）', async () => {
  const { b, calls } = makeBridge({})
  const entry = b._entryOf('g:123456')
  entry.sessionId = 's1'
  b.dsh.promptAndWait = async () => '（已发图）'
  await b._processBatch('g:123456', gm('嗯', 'Q3', '1001'), ['嗯'], [])
  assert.deepEqual(calls.sent, [], '清洗后为空 → 不发任何文字')
})

console.log('\n— 群聊上下文自动清理（2026-10-27）—')
/** 造一份「已有映射」的 state，让用例能直接指定起始轮数与基线。 */
function seedCtxState(tag, sessions) {
  const file = path.join(os.tmpdir(), `qq-bridge-ctx-${process.pid}-${tag}.json`)
  fs.writeFileSync(file, JSON.stringify({ sessions }))
  return file
}
/**
 * 自动清理专用 Bridge：节奏拉到 3 档 + 不限频，群消息能真的走到投递那一步；
 * `outline` = turnOutline 返回的数组长度（也就是 DSH 侧的当前轮数）。
 */
function ctxBridge({ tag, sessions = {}, outline = 0 } = {}) {
  const stateFile = seedCtxState(tag, sessions)
  const made = makeBridge({
    stateFile,
    rhythm: {
      activityLevel: 3, debounceWindowMs: 0,
      rateLimit: { perMin: 1000, burst: 0, silent: true },
    },
  })
  made.calls.outline = Array.from({ length: outline }, (_, i) => ({
    turn: i + 1, seq: i + 1, prompt: `p${i + 1}`, response: `r${i + 1}`,
  }))
  return { ...made, stateFile }
}

await check('_contextPolicy：默认 compact/30，热配置优先，非法值回退默认', () => {
  const { b } = makeBridge({})
  assert.deepEqual(b._contextPolicy(), { strategy: 'compact', turns: 30 })
  b.live.contextClearStrategy = 'clear'
  b.live.maxContextTurns = 7
  assert.deepEqual(b._contextPolicy(), { strategy: 'clear', turns: 7 }, '设置页热改立即生效')
  b.live.contextClearStrategy = 'nonsense'
  b.live.maxContextTurns = -3
  assert.deepEqual(b._contextPolicy(), { strategy: 'compact', turns: 0 }, '非法策略回默认，负数夹到 0')
})

await check('热配置白名单放行这两个键（漏加 = 设置页白存、桥接永远收不到）', () => {
  const hot = pickHotConfig({ maxContextTurns: 12, contextClearStrategy: 'clear' })
  assert.equal(hot.maxContextTurns, 12)
  assert.equal(hot.contextClearStrategy, 'clear')
})

await check('私聊超阈值也不清理（长期记忆）：会话不变、不归档、连轮数都不查', async () => {
  const { b, calls, stateFile } = ctxBridge({
    tag: 'ctx-priv', outline: 50,
    sessions: { 'u:1000000001': { sessionId: 'priv-s', ctxBaseSessionId: 'priv-s', ctxBaseTurns: 0 } },
  })
  b.live.maxContextTurns = 5
  await b.handleMessage(privMsg('聊了五十来回了', 'cp1'))
  assert.equal(calls.prompts.length, 1)
  assert.equal(calls.prompts[0].sid, 'priv-s', '★ 私聊会话 id 不变')
  assert.equal(b.state.sessions['u:1000000001'].sessionId, 'priv-s')
  assert.deepEqual(calls.archived, [], '★ 不归档私聊会话')
  assert.equal(calls.created, 0, '★ 不新建会话')
  assert.deepEqual(calls.compacts, [], '★ 不压缩')
  assert.deepEqual(calls.outlineCalls, [], '★ 私聊连 turnOutline 都不查（零多余 RPC）')
  fs.rmSync(stateFile, { force: true })
})

await check('群聊超阈值 + compact：调原生压缩，会话不变，基线推到当前轮数', async () => {
  const { b, calls, stateFile } = ctxBridge({
    tag: 'ctx-compact', outline: 12,
    sessions: { 'g:123456': { sessionId: 'g-s', ctxBaseSessionId: 'g-s', ctxBaseTurns: 2 } },
  })
  b.live.maxContextTurns = 5
  b.live.contextClearStrategy = 'compact'
  await b.handleMessage(groupMsg('也就聊了十轮', { id: 'cc1' }))
  assert.deepEqual(calls.compacts, ['g-s'], '★ 走原生压缩，不换会话')
  assert.equal(calls.prompts[0].sid, 'g-s', '压缩后仍在同一会话里回')
  assert.deepEqual(calls.archived, [], '压缩成功就不该归档')
  assert.equal(calls.created, 0)
  assert.equal(b.state.sessions['g:123456'].ctxBaseTurns, 12, '基线推到压缩时的轮数')
  assert.equal(b.state.sessions['g:123456'].ctxBaseSessionId, 'g-s')
  assert.equal(b.state.contextCompacts, 1)
  assert.equal(b.state.contextResets, 0)
  assert.equal(calls.sent.length, 1, '只有这一轮的正常回复')
  assert.equal(calls.sent[0].text, '好')
  fs.rmSync(stateFile, { force: true })
})

await check('压缩成功后基线前移：turnOutline 长度不变也不会每条都压一次', async () => {
  const { b, calls, stateFile } = ctxBridge({
    tag: 'ctx-once', outline: 12,
    sessions: { 'g:123456': { sessionId: 'g-s', ctxBaseSessionId: 'g-s', ctxBaseTurns: 2 } },
  })
  b.live.maxContextTurns = 5
  await b.handleMessage(groupMsg('第一句', { id: 'co1' }))
  assert.equal(calls.compacts.length, 1, '超阈值先压一次')
  await b.handleMessage(groupMsg('第二句', { id: 'co2' }))
  await b.handleMessage(groupMsg('第三句', { id: 'co3' }))
  assert.equal(calls.prompts.length, 3)
  assert.equal(calls.compacts.length, 1, '★ DSH 日志不删事件（轮数不变），靠基线相减避免反复压缩')
  assert.equal(b.state.contextCompacts, 1)
  fs.rmSync(stateFile, { force: true })
})

await check('阈值边界：差值正好等于阈值也触发（>= 语义）', async () => {
  const { b, calls, stateFile } = ctxBridge({
    tag: 'ctx-edge', outline: 10,
    sessions: { 'g:123456': { sessionId: 'g-s', ctxBaseSessionId: 'g-s', ctxBaseTurns: 5 } },
  })
  b.live.maxContextTurns = 5
  await b.handleMessage(groupMsg('刚好五轮', { id: 'ce1' }))
  assert.equal(calls.compacts.length, 1)
  fs.rmSync(stateFile, { force: true })
})

await check('compact 抛错（unknown command）：静默降级归档+新建，清理路径一条消息都不发', async () => {
  const { b, calls, stateFile } = ctxBridge({
    tag: 'ctx-fallback', outline: 20,
    sessions: {
      'g:123456': {
        sessionId: 'old-g', ctxBaseSessionId: 'old-g', ctxBaseTurns: 0, persona: '群专属人设',
      },
    },
  })
  b.live.maxContextTurns = 5
  calls.compactFails = 'unknown method commands/execute'
  const next = await b._maybeRecycleContext('g:123456', groupMsg('超了', { id: 'cf1' }), 'old-g')
  assert.equal(next, 's1', '返回可用的新会话 id')
  assert.deepEqual(calls.compacts, ['old-g'])
  assert.deepEqual(calls.archived, ['old-g'])
  assert.equal(calls.archiveOpts[0].stopActivity, true, '旧会话可能还在跑，归档必须带 stopActivity')
  assert.equal(b.state.sessions['g:123456'].sessionId, 's1')
  assert.equal(b.state.sessions['g:123456'].ctxBaseTurns, 0, '新会话基线归零，不会立刻又清一次')
  assert.equal(b.state.sessions['g:123456'].ctxBaseSessionId, 's1')
  assert.equal(b.state.sessions['g:123456'].persona, '群专属人设', '人设在 state 上，重建不丢')
  assert.equal(b.state.contextResets, 1)
  assert.equal(b._compactSupported, false, '命令不存在要记住，之后不再白试')
  assert.deepEqual(calls.sent, [], '★ 静默红线：清理路径绝不给群里发提示')
  assert.deepEqual(calls.prompts, [], '★ 也没投递任何 prompt')
  fs.rmSync(stateFile, { force: true })
})

/** 真实 DSH 在 agent 未 idle 时回的错误文本（用来命中 busy 分支）。 */
const COMPACT_BUSY_TEXT = 'compaction 失败：busy — Compaction is unavailable because this process '
  + 'has an active compaction, or the agent is not idle.'

await check('compact busy（agent 未 idle）：等 _compactRetryMs 重试一次即成功，会话不变', async () => {
  const { b, calls, stateFile } = ctxBridge({
    tag: 'ctx-busy', outline: 20,
    sessions: { 'g:123456': { sessionId: 'g-s', ctxBaseSessionId: 'g-s', ctxBaseTurns: 0 } },
  })
  b.live.maxContextTurns = 5
  b._compactRetryMs = 1 // 真跑 busy 重试分支，但不等实现里的 1.5s
  calls.compactFails = [COMPACT_BUSY_TEXT] // 第一次 busy，第二次（重试）成功
  await b.handleMessage(groupMsg('超了', { id: 'cb1' }))
  assert.equal(calls.compacts.length, 2, '★ 第一次 busy 抛错、第二次成功')
  assert.equal(b.state.contextCompacts, 1, '只记一次成功压缩')
  assert.equal(calls.prompts[0].sid, 'g-s', '会话不变（压缩不换会话）')
  assert.deepEqual(calls.archived, [], '重试成功就不该降级归档')
  assert.equal(calls.created, 0)
  assert.equal(b.state.sessions['g:123456'].ctxBaseTurns, 20, '基线推到压缩时的轮数')
  assert.equal(calls.sent.length, 1, '只有这一轮的正常回复')
  assert.equal(calls.sent[0].text, '好')
  fs.rmSync(stateFile, { force: true })
})

await check('compact 连续两次 busy：降级归档+新建，全程仍只有正常回复', async () => {
  const { b, calls, stateFile } = ctxBridge({
    tag: 'ctx-busy2', outline: 20,
    sessions: { 'g:123456': { sessionId: 'old-g', ctxBaseSessionId: 'old-g', ctxBaseTurns: 0 } },
  })
  b.live.maxContextTurns = 5
  b._compactRetryMs = 1
  calls.compactFails = [COMPACT_BUSY_TEXT, COMPACT_BUSY_TEXT]
  await b.handleMessage(groupMsg('超了', { id: 'cb2' }))
  assert.equal(calls.compacts.length, 2, '只重试一次，不会无限重试')
  assert.deepEqual(calls.archived, ['old-g'], '两次都 busy → 静默降级为归档重建')
  assert.equal(calls.archiveOpts[0].stopActivity, true)
  assert.equal(calls.prompts[0].sid, 's1', '回复落到新会话上')
  assert.equal(b.state.contextResets, 1)
  assert.equal(b.state.contextCompacts, 0, '没压成功就不该记成功数')
  assert.equal(b._compactSupported, undefined, 'busy 不代表没压缩能力，别记成 false')
  assert.equal(calls.sent.length, 1, '★ 仍然只有一条正常回复，没有清理提示')
  assert.equal(calls.sent[0].text, '好')
  fs.rmSync(stateFile, { force: true })
})

await check('全链路：压缩失败降级重建后照常回复，且只发一条（无「已清理」类提示）', async () => {
  const { b, calls, stateFile } = ctxBridge({
    tag: 'ctx-full', outline: 20,
    sessions: { 'g:123456': { sessionId: 'old-g', ctxBaseSessionId: 'old-g', ctxBaseTurns: 0 } },
  })
  b.live.maxContextTurns = 5
  calls.compactFails = 'compact exploded'
  await b.handleMessage(groupMsg('超了', { id: 'cg1' }))
  assert.equal(calls.prompts.length, 1)
  assert.equal(calls.prompts[0].sid, 's1', '回复落在新会话上')
  assert.equal(calls.sent.length, 1, '★ 只有一条正常回复，没有清理提示')
  assert.equal(calls.sent[0].text, '好')
  assert.deepEqual(calls.archived, ['old-g'])
  fs.rmSync(stateFile, { force: true })
})

await check("strategy='off'：不压缩不归档，连轮数都不查", async () => {
  const { b, calls, stateFile } = ctxBridge({
    tag: 'ctx-off', outline: 40,
    sessions: { 'g:123456': { sessionId: 'g-s', ctxBaseSessionId: 'g-s', ctxBaseTurns: 0 } },
  })
  b.live.contextClearStrategy = 'off'
  b.live.maxContextTurns = 5
  await b.handleMessage(groupMsg('聊很久了', { id: 'cx1' }))
  assert.equal(calls.prompts[0].sid, 'g-s')
  assert.deepEqual(calls.compacts, [])
  assert.deepEqual(calls.archived, [])
  assert.deepEqual(calls.outlineCalls, [], 'off 时不该多打 RPC')
  fs.rmSync(stateFile, { force: true })
})

await check('maxContextTurns=0（不限制）：不触发任何清理', async () => {
  const { b, calls, stateFile } = ctxBridge({
    tag: 'ctx-zero', outline: 40,
    sessions: { 'g:123456': { sessionId: 'g-s', ctxBaseSessionId: 'g-s', ctxBaseTurns: 0 } },
  })
  b.live.maxContextTurns = 0
  await b.handleMessage(groupMsg('聊很久了', { id: 'cz1' }))
  assert.equal(calls.prompts[0].sid, 'g-s')
  assert.deepEqual(calls.compacts, [])
  assert.deepEqual(calls.archived, [])
  assert.equal(calls.created, 0)
  assert.deepEqual(calls.outlineCalls, [])
  fs.rmSync(stateFile, { force: true })
})

await check('旧 state 没有 ctxBase* 字段：补默认，且第一条消息只建基线不清上下文', async () => {
  const { b, calls, stateFile } = ctxBridge({
    tag: 'ctx-legacy', outline: 88,
    sessions: { 'g:123456': { sessionId: 'old-s' } },
  })
  assert.equal(b.state.sessions['g:123456'].ctxBaseTurns, 0, '缺字段补 0')
  assert.equal(b.state.sessions['g:123456'].ctxBaseSessionId, '', '缺字段补空串')
  b.live.maxContextTurns = 5
  await b.handleMessage(groupMsg('历史很长但刚升级', { id: 'cl1' }))
  assert.equal(calls.prompts[0].sid, 'old-s', '★ 不会因为「历史本来就长」立刻清一次')
  assert.deepEqual(calls.compacts, [])
  assert.deepEqual(calls.archived, [])
  assert.equal(b.state.sessions['g:123456'].ctxBaseTurns, 88, '基线初始化为当前轮数')
  assert.equal(b.state.sessions['g:123456'].ctxBaseSessionId, 'old-s')
  fs.rmSync(stateFile, { force: true })
})

await check('normalizeSessionEntry：ctxBaseTurns / ctxBaseSessionId 默认值与脏值兜底', () => {
  const blank = normalizeSessionEntry('g:1', { sessionId: 's' })
  assert.equal(blank.ctxBaseTurns, 0)
  assert.equal(blank.ctxBaseSessionId, '')
  const dirty = normalizeSessionEntry('g:1', { sessionId: 's', ctxBaseTurns: -9, ctxBaseSessionId: 42 })
  assert.equal(dirty.ctxBaseTurns, 0, '负数归 0')
  assert.equal(dirty.ctxBaseSessionId, '', '非字符串归空串')
  const okEntry = normalizeSessionEntry('g:1', { sessionId: 's', ctxBaseTurns: 7.8, ctxBaseSessionId: 's7' })
  assert.equal(okEntry.ctxBaseTurns, 7, '取整')
  assert.equal(okEntry.ctxBaseSessionId, 's7')
})

await check("applySessionOp('clear') 复用 _rebuildSessionContext：ctxBase 归零、计数+1", async () => {
  const { b, calls, stateFile } = ctxBridge({
    tag: 'ctx-clear', sessions: { 'g:123456': { sessionId: 'old-g', ctxBaseSessionId: 'old-g', ctxBaseTurns: 9 } },
  })
  const result = await b.applySessionOp({ op: 'clear', key: 'g:123456' })
  assert.equal(result.ok, true)
  assert.equal(result.action, 'clear')
  assert.equal(result.sessionId, 's1')
  assert.equal(result.archived, true)
  assert.deepEqual(calls.archived, ['old-g'])
  assert.equal(b.state.sessions['g:123456'].ctxBaseTurns, 0)
  assert.equal(b.state.sessions['g:123456'].ctxBaseSessionId, 's1')
  assert.equal(b.state.contextResets, 1)
  assert.equal(b.chatKeyForSession('s1'), 'g:123456', 'sessionId → key 反查表跟着换')
  fs.rmSync(stateFile, { force: true })
})

await check("applySessionOp('clear') 无会话时仍回 no-session（老行为不变）", async () => {
  const { b, calls, stateFile } = ctxBridge({ tag: 'ctx-clear-none' })
  const result = await b.applySessionOp({ op: 'clear', key: 'g:123456' })
  assert.deepEqual(result, { ok: false, error: 'no-session', action: 'clear', key: 'g:123456' })
  assert.equal(calls.created, 0, '不许因为 clear 白建会话')
  assert.deepEqual(calls.archived, [])
  fs.rmSync(stateFile, { force: true })
})

console.log('\n— 批量改名计划 —')
await check('planRenames：只改有映射且标题不符的会话', () => {
  const state = {
    sessions: {
      'u:1000000001': { sessionId: 's1', kind: 'private', qq: '1000000001', name: '翎羽' },
      'g:123456': { sessionId: 's2', kind: 'group', qq: '123456', name: '摸鱼群' },
      'g:999': { sessionId: 's3', kind: 'group', qq: '999', name: '已规范群' },
    },
  }
  const sessions = [
    { sessionId: 's1', cwd: 'D:\\QQChat', projections: { values: { title: '向' } } },
    { sessionId: 's2', cwd: 'D:\\QQChat', projections: { values: { title: '群聊-摸鱼群(123456)' } } },
    { sessionId: 's3', cwd: 'D:\\QQChat', projections: { values: { title: '群聊-已规范群(999)' } } },
    { sessionId: 'x1', cwd: 'D:\\QQChat', projections: { values: { title: '野会话' } } },
    { sessionId: 'sub1', cwd: 'D:\\QQChat', origin: 'subagent', projections: { values: { title: '子代理' } } },
    { sessionId: 'other', cwd: 'D:\\Other', projections: { values: { title: '别的目录' } } },
  ]
  const plan = planRenames({ sessions, state, cwd: 'D:\\QQChat' })
  assert.deepEqual(plan.map((p) => p.action), ['rename', 'skip-unchanged', 'skip-unchanged', 'skip-no-mapping'])
  assert.equal(plan[0].expected, '私聊-翎羽')
})
await check('planRenames：旧版字符串映射也能识别', () => {
  const plan = planRenames({
    sessions: [{ sessionId: 's1', cwd: 'D:\\QQChat', projections: { values: { title: '旧' } } }],
    state: { sessions: { 'u:1000000001': 's1' } },
    cwd: 'D:\\QQChat',
  })
  assert.equal(plan[0].action, 'rename')
  assert.equal(plan[0].expected, '私聊-1000000001')
})

console.log('\n— 会话指令轮询器 —')
await check('轮询：取到 ops → 调 bridge.applySessionOp → POST 回执；可停止', async () => {
  const { startSessionOpsPolling } = await import('./src/session-ops.mjs')
  let delivered = false
  const posted = []
  const seen = []
  const fakeFetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    if (method === 'GET') {
      if (delivered) return { ok: true, json: async () => ({ ok: true, ops: [] }) }
      delivered = true
      return { ok: true, json: async () => ({ ok: true, ops: [{ id: 'op-1', op: 'clear', key: 'u:1' }] }) }
    }
    posted.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const stop = startSessionOpsPolling({
    baseUrl: 'http://127.0.0.1:1',
    bridge: { applySessionOp: async (op) => { seen.push(op); return { ok: true } } },
    logger: { info() {}, warn() {} },
    pollMs: 10,
    fetchImpl: fakeFetch,
  })
  await new Promise((resolve) => setTimeout(resolve, 70))
  stop()
  assert.equal(seen.length, 1, '应执行一次指令')
  assert.equal(seen[0].id, 'op-1')
  assert.equal(posted.length, 1, '应回传一次结果')
  assert.deepEqual(posted[0].results, [{ id: 'op-1', ok: true }])
})
await check('轮询：执行抛错也回执 ok=false，不会卡住队列', async () => {
  const { startSessionOpsPolling } = await import('./src/session-ops.mjs')
  let delivered = false
  const posted = []
  const fakeFetch = async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'GET') {
      if (delivered) return { ok: true, json: async () => ({ ok: true, ops: [] }) }
      delivered = true
      return { ok: true, json: async () => ({ ok: true, ops: [{ id: 'op-2', op: 'delete', key: 'u:2' }] }) }
    }
    posted.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const stop = startSessionOpsPolling({
    baseUrl: 'http://127.0.0.1:1',
    bridge: { applySessionOp: async () => { throw new Error('boom') } },
    logger: { info() {}, warn() {} },
    pollMs: 10,
    fetchImpl: fakeFetch,
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  stop()
  assert.equal(posted[0].results[0].ok, false)
  assert.match(posted[0].results[0].detail, /boom/)
})

console.log('\n— Phase 6：@ 昵称 / 字数档位 / 图片理解 / 语音 / 技能开关 —')
await check('@ 无昵称：@QQ号 + 空格，且与正文之间只留一个空格', () => {
  const r = parseMessage([
    { type: 'at', data: { qq: '1000000001' } },
    { type: 'text', data: { text: ' 你好' } },
  ])
  assert.equal(r, '@1000000001 你好')
})
await check('@ 有昵称：优先 data.name，其次群成员缓存', () => {
  assert.equal(parseMessage([
    { type: 'at', data: { qq: '123', name: '小明' } },
    { type: 'text', data: { text: '早' } },
  ]), '@小明 早')
  assert.equal(parseMessage([
    { type: 'at', data: { qq: '456' } },
    { type: 'text', data: { text: '在吗' } },
  ], '', { resolveAtName: (qq) => (qq === '456' ? '小红' : '') }), '@小红 在吗')
})
await check('@全体成员：带空格', () => {
  assert.equal(parseMessage([{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '开会' } }]), '@全体成员 开会')
})
await check('CQ 字符串里的 at 也带空格', () => {
  assert.equal(parseMessage('[CQ:at,qq=123] 你好'), '@123 你好')
})
await check('消息事件：同群先说话的人，@ 时能解析出昵称', () => {
  const c = new OneBotClient({ logger: undefined })
  const event = c._parseMessageEvent({
    message_type: 'group', group_id: 777, user_id: 42, message_id: 1,
    sender: { nickname: '小明' },
    message: [{ type: 'at', data: { qq: '42' } }, { type: 'text', data: { text: ' 在吗' } }],
  }, 'group')
  assert.equal(event.text, '@小明 在吗')
  assert.equal(event.images.length, 0)
})
await check('消息事件：图片段单独抽出来（url/file/size），文本仍保留 [图片]', () => {
  const c = new OneBotClient({ logger: undefined })
  const event = c._parseMessageEvent({
    message_type: 'private', user_id: 5, message_id: 2,
    message: [
      { type: 'text', data: { text: '看图' } },
      { type: 'image', data: { url: 'https://x/y.png', file: 'y.png', file_size: 123 } },
    ],
  }, 'private')
  assert.equal(event.images.length, 1)
  assert.equal(event.images[0].url, 'https://x/y.png')
  assert.equal(event.images[0].size, 123)
  assert.ok(event.text.includes('[图片]'))
  assert.deepEqual(extractImages([{ type: 'image', data: {} }]), [], '没有 url/file 的图片段应忽略')
})
await check('字数档位：默认仍是 10 / 14 / 15', () => {
  const r = () => 0.5
  assert.equal(typingDelayFor(9, r), 200)
  assert.equal(typingDelayFor(10, r), 450)
  assert.equal(typingDelayFor(14, r), 450)
  assert.equal(typingDelayFor(15, r), 800)
})
await check('字数档位：自定义边界与毫秒基准都生效', () => {
  const r = () => 0.5
  const tiers = {
    charTiers: { shortMax: 12, mediumMax: 18, longMin: 20 },
    msTiers: { short: 300, medium: 600, long: 1000 },
  }
  assert.equal(typingDelayFor(11, r, tiers), 300)
  assert.equal(typingDelayFor(12, r, tiers), 600)
  assert.equal(typingDelayFor(18, r, tiers), 600)
  assert.equal(typingDelayFor(20, r, tiers), 1000)
})
await check('字数档位：非法/倒挂的边界被归一化成单调递增', () => {
  assert.deepEqual(normalizeTypingCharTiers({ shortMax: 20, mediumMax: 10, longMin: 5 }),
    { shortMax: 20, mediumMax: 20, longMin: 21 })
  assert.deepEqual(normalizeTypingMsTiers({ short: -1, medium: 'x', long: 0 }),
    { short: 200, medium: 450, long: 0 })
})
await check('features：Host 下发的派生值优先；缺字段按默认补', () => {
  assert.deepEqual(normalizeFeatures({ vision: false, search: false }), {
    voice: true, vision: false, search: false, guard: true, debounce: true, rateLimit: true,
    image: true, time: true, memory: true, unread: true,
    // v2.0：开发者特权缺字段按关闭（提权通道 fail-closed），不是「缺项按开启」。
    developer: false,
  })
  assert.equal(featuresFromManifests({ skills: [{ id: 'sk-vision', enabled: false }] }).vision, false)
  assert.equal(featuresFromManifests({ skills: [] }).vision, false, '清单里没有 = 关闭')
  assert.equal(featuresFromManifests({}).vision, true, '清单缺失 = 默认开启')
  // P2 兼容（契约 3.1）：老配置的 skills 里没有 sk-image → 按新默认开启；
  // 明确写了 sk-image 且 enabled:false 才算关闭。
  assert.equal(featuresFromManifests({ skills: [{ id: 'sk-voice', enabled: true }] }).image, true,
    '老配置没有 sk-image 时按默认开启')
  assert.equal(featuresFromManifests({ skills: [{ id: 'sk-image', enabled: false }] }).image, false)
})
await check('features.memory：新卡 / 老卡 / 缺项三种清单都算对（2026-10-27 合并）', () => {
  // 缺项（升级前什么都没存）→ 按默认开启。
  assert.equal(featuresFromManifests({ skills: [{ id: 'sk-voice', enabled: true }] }).memory, true)
  assert.equal(featuresFromManifests({}).memory, true)
  // 只有旧卡 sk-context → 沿用用户当时的选择。
  assert.equal(featuresFromManifests({ skills: [{ id: 'sk-context', enabled: true }] }).memory, true)
  assert.equal(featuresFromManifests({ skills: [{ id: 'sk-context', enabled: false }] }).memory, false)
  // 新卡优先。
  assert.equal(featuresFromManifests({
    skills: [{ id: 'sk-context', enabled: false }, { id: 'sk-memory', enabled: true }],
  }).memory, true)
  assert.equal(featuresFromManifests({ skills: [{ id: 'sk-memory', enabled: false }] }).memory, false)
})
await check('能力说明只包含开启的技能', () => {
  const lines = capabilityLines({ vision: false, search: true, voice: false, image: false })
  const text = lines.join('\n')
  assert.ok(text.includes('web_search'))
  assert.ok(!text.includes('图片'))
  assert.ok(!text.includes('qq_send_voice'))
  assert.ok(!text.includes('qq_send_image'), '「发图片」关掉时不能出现能力说明')
  const withImage = capabilityLines({ vision: false, search: false, voice: false, image: true }).join('\n')
  assert.ok(withImage.includes('qq_send_image'), '开启时必须有发图片的能力说明')
})
await check('人设：技能能力段追加在参与度之后、模型行之前', () => {
  const probe = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1' },
      stateFile: path.join(os.tmpdir(), `qq-bridge-state-${process.pid}-cap.json`),
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  // 默认人设正文来自设置页热同步（personaDefault）；能力段只有在这种情况下才
  // 跟着一起覆盖，避免「只有一行工具说明」把默认人设挤掉。
  probe.live.personaDefault = '默认人设正文'
  probe.live.model = { provider: 'raccoon', model: 'x' }
  const out = probe.buildPersonaPrompt()
  assert.ok(out.includes('【能力】'), out)
  assert.ok(out.includes('web_search'))
  assert.ok(out.indexOf('【能力】') < out.indexOf('【底层模型】'))
})
await check('图片理解：技能关闭 → 不下载、纯文本如实说明', async () => {
  const { b } = makeBridge()
  b.live.features = normalizeFeatures({ vision: false })
  const built = await b._buildPromptContent('看图', [{ url: 'data:image/png;base64,AAAA' }])
  assert.equal(built.images, 0)
  assert.match(built.fallbackText, /图片理解.*未开启/)
  assert.equal(built.content[0].type, 'text')
})
await check('图片理解：模型声明不支持 → 纯文本说明，不白下载', async () => {
  const { b } = makeBridge()
  b.live.features = normalizeFeatures({ vision: true })
  b._modelSupportsImages = async () => false
  const built = await b._buildPromptContent('看图', [{ url: 'data:image/png;base64,AAAA' }])
  assert.equal(built.images, 0)
  assert.match(built.fallbackText, /不支持图片/)
})
await check('图片理解：支持下把 data URL 解成 image part；坏图跳过', async () => {
  const { b } = makeBridge()
  b.live.features = normalizeFeatures({ vision: true })
  b._modelSupportsImages = async () => true
  // 1x1 PNG
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const built = await b._buildPromptContent('看图', [
    { url: `data:image/png;base64,${png}` },
    { url: 'data:text/plain;base64,aGVsbG8=' },
  ])
  assert.equal(built.images, 1, '坏格式应被跳过')
  assert.equal(built.content[0].type, 'text')
  assert.equal(built.content[1].type, 'image')
  assert.equal(built.content[1].mediaType, 'image/png')
  assert.equal(built.content[1].data, png)
})
await check('图片理解：纯文字消息不产生 image part', async () => {
  const { b } = makeBridge()
  const built = await b._buildPromptContent('只有文字', [])
  assert.equal(built.images, 0)
  assert.deepEqual(built.content, [{ type: 'text', text: '只有文字' }])
})
await check('防抖合并插件关闭 → 不攒定时器，立即投递', async () => {
  const { b } = makeBridge()
  b.live.features = normalizeFeatures({ debounce: false })
  const processed = []
  b._processBatch = async (key, msg, texts, images) => { processed.push({ texts, images }) }
  await b._enqueue('u:1000000001', { kind: 'private', userId: '1000000001' }, '在吗', [])
  assert.equal(b._debounce.size, 0)
  assert.deepEqual(processed, [{ texts: ['在吗'], images: [] }])
})
await check('发语音：按 sessionId 找到 QQ 会话 → TTS → record 发送', async () => {
  const { b } = makeBridge()
  b.live.features = normalizeFeatures({ voice: true })
  b.state.sessions['u:1000000001'] = normalizeSessionEntry('u:1000000001', { sessionId: 's1', qq: '1000000001' })
  const synth = []
  b.tts = { synthesize: async (text, cfg) => { synth.push({ text, cfg }); return { base64: 'QUJD', bytes: 3, provider: 'stub' } } }
  const voices = []
  b.qq.sendVoice = async (kind, target, data) => { voices.push({ kind, target, data }); return { ok: true } }
  b.live.voice = { provider: 'edge', voice: 'zh-CN-XiaoyiNeural' }
  const result = await b.applySessionOp({ op: 'voice', sessionId: 's1', text: '你好' })
  assert.equal(result.ok, true)
  assert.equal(voices[0].kind, 'private')
  assert.equal(voices[0].target, '1000000001')
  assert.equal(voices[0].data, 'QUJD')
  assert.equal(synth[0].cfg.voice, 'zh-CN-XiaoyiNeural')
  assert.equal(b.stats.voices, 1)
})
await check('发语音：技能关闭 → 拒绝且不调 TTS', async () => {
  const { b } = makeBridge()
  b.live.features = normalizeFeatures({ voice: false })
  b.state.sessions['u:1000000001'] = normalizeSessionEntry('u:1000000001', { sessionId: 's1', qq: '1000000001' })
  let called = false
  b.tts = { synthesize: async () => { called = true; return { base64: 'x' } } }
  const result = await b.applySessionOp({ op: 'voice', sessionId: 's1', text: '你好' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'voice-disabled')
  assert.equal(called, false)
})
await check('发语音：sessionId 没有映射 → no-session，不污染 state', async () => {
  const { b } = makeBridge()
  const before = JSON.stringify(b.state.sessions)
  const result = await b.applySessionOp({ op: 'voice', sessionId: 'nope', text: '你好' })
  assert.equal(result.error, 'no-session')
  assert.equal(JSON.stringify(b.state.sessions), before, 'voice op 不该创建空 key 的垃圾行')
})
await check('TTS：SSML 转义 + OpenAI 兼容请求体', async () => {
  const ssml = buildSsml('a < b & c', 'zh-CN-XiaoyiNeural')
  assert.ok(ssml.includes('a &lt; b &amp; c'))
  let captured
  const fakeFetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body), auth: init.headers.authorization }
    return {
      ok: true,
      headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }
  }
  const out = await synthesizeOpenAI('你好', {
    baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', voice: 'alloy', fetchImpl: fakeFetch,
  })
  assert.equal(out.provider, 'openai')
  assert.equal(out.mediaType, 'audio/mpeg')
  assert.equal(captured.url, 'https://api.example.com/v1/audio/speech')
  assert.equal(captured.body.input, '你好')
  assert.equal(captured.body.voice, 'alloy')
  assert.equal(captured.auth, 'Bearer sk-test')
})
await check('热配置白名单包含 Phase 6 字段（skills/features/voice/字数档位）', () => {
  const hot = pickHotConfig({
    skills: [{ id: 'sk-vision', enabled: false }],
    features: { vision: false },
    voice: { provider: 'edge' },
    typingDelayCharTiers: { shortMax: 12 },
    externalPlugins: { enabled: ['demo.ext'] },
    wsUrl: 'ws://evil',
  })
  assert.equal(hot.features.vision, false)
  assert.equal(hot.voice.provider, 'edge')
  assert.equal(hot.typingDelayCharTiers.shortMax, 12)
  assert.equal(hot.skills[0].id, 'sk-vision')
  assert.equal('wsUrl' in hot, false)
  // P2：外部插件启用清单要热同步给桥接（否则 hook 永远不发）。
  assert.equal(hot.externalPlugins.enabled[0], 'demo.ext')
})

console.log('\n— P2：发图片（qq_send_image 桥接侧）—')

/** 假 NapCat：只记 call，不联网。 */
function makeImageClient() {
  const client = new OneBotClient({
    wsUrl: 'ws://127.0.0.1:1', accessToken: 't', logger: { info() {}, warn() {}, error() {} },
  })
  const sent = []
  client.call = async (action, params) => {
    sent.push({ action, params })
    return { status: 'ok', retcode: 0, data: { message_id: 7 } }
  }
  return { client, sent }
}

await check('sendImage：私聊用 send_private_msg，消息段只有 image，file 原样', async () => {
  const { client, sent } = makeImageClient()
  const r = await client.sendImage('private', '1000000001', 'https://example.invalid/a.png')
  assert.equal(r.ok, true)
  assert.equal(r.via, 'url')
  assert.equal(r.retcode, 0)
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.messageIds, ['7'])
  assert.equal(sent[0].action, 'send_private_msg')
  assert.equal(sent[0].params.user_id, 1000000001)
  assert.deepEqual(sent[0].params.message,
    [{ type: 'image', data: { file: 'https://example.invalid/a.png' } }])
})
await check('sendImage：群聊用 send_group_msg，默认不带 @', async () => {
  const { client, sent } = makeImageClient()
  const r = await client.sendImage('group', '123456', 'base64://QUJD', { atUserId: undefined })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'base64')
  assert.equal(sent[0].action, 'send_group_msg')
  assert.equal(sent[0].params.group_id, 123456)
  assert.deepEqual(sent[0].params.message,
    [{ type: 'image', data: { file: 'base64://QUJD' } }], '群聊图片不带 at 段')
})
await check('imageFileVia：url / base64 / 本地路径分类', () => {
  assert.equal(imageFileVia('https://x/y.png'), 'url')
  assert.equal(imageFileVia('HTTP://x/y.png'), 'url')
  assert.equal(imageFileVia('base64://QUJD'), 'base64')
  assert.equal(imageFileVia('file:///C:/a.png'), 'file')
  assert.equal(imageFileVia('C:\\pics\\a.png'), 'file')
  assert.equal(imageFileVia(''), '')
})
await check('sendImage：retcode 非 0 → ok=false 带 retcode/status/via，不抛', async () => {
  const { client } = makeImageClient()
  client.call = async () => ({ status: 'failed', retcode: 1200, data: null })
  const r = await client.sendImage('private', '1000000001', 'file:///C:/a.png')
  assert.equal(r.ok, false)
  assert.equal(r.via, 'file')
  assert.equal(r.retcode, 1200)
  assert.equal(r.status, 'failed')
  assert.deepEqual(r.messageIds, [])
  assert.match(r.error, /retcode=1200/)
})
await check('sendImage：传输层异常也永不抛（status=exception）', async () => {
  const { client } = makeImageClient()
  client.call = async () => { throw new Error('WebSocket 未连接') }
  const r = await client.sendImage('group', '123456', 'https://example.invalid/a.png')
  assert.equal(r.ok, false)
  assert.equal(r.status, 'exception')
  assert.equal(r.retcode, null)
  assert.match(r.error, /WebSocket 未连接/)
})
await check('sendImage：非法目标 / 空地址在本地拦下，不打 NapCat', async () => {
  const { client, sent } = makeImageClient()
  assert.equal((await client.sendImage('private', '0', 'https://x/y.png')).ok, false)
  assert.equal((await client.sendImage('private', 'abc', 'https://x/y.png')).ok, false)
  assert.equal((await client.sendImage('group', '123456', '   ')).ok, false)
  assert.equal(sent.length, 0)
})

/** 造一个已映射两个会话、sendImage 打桩的 Bridge。 */
function imageBridge({ features } = {}) {
  const { b, calls } = makeBridge()
  b.live.features = normalizeFeatures({ ...(features ?? {}) })
  b.state.sessions['u:1000000001'] = normalizeSessionEntry('u:1000000001', { sessionId: 's1', qq: '1000000001' })
  b.state.sessions['g:123456'] = normalizeSessionEntry('g:123456', { sessionId: 's2', qq: '123456' })
  const sentImages = []
  b.qq.sendImage = async (kind, target, file, opts) => {
    sentImages.push({ kind, target, file, opts })
    return { ok: true, messageIds: ['9'], retcode: 0, status: 'ok', via: imageFileVia(file) }
  }
  return { b, sentImages }
}

await check('image op：私聊成功 → sendImage(private) 且 detail 含 via/retcode', async () => {
  const { b, sentImages } = imageBridge()
  const r = await b.applySessionOp({ op: 'image', sessionId: 's1', url: 'https://example.invalid/a.png' })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'image')
  assert.equal(r.sent, true)
  assert.equal(r.via, 'url')
  assert.equal(r.retcode, 0)
  assert.match(r.detail, /已发送图片（via=url，retcode=0）/)
  assert.equal(sentImages[0].kind, 'private')
  assert.equal(sentImages[0].target, '1000000001')
  assert.equal(sentImages[0].file, 'https://example.invalid/a.png')
  assert.equal(sentImages[0].opts.atUserId, undefined, '私聊不带 @')
  assert.equal(b.stats.images, 1)
})
await check('image op：群聊成功且**不带 @**（atUserId=undefined）', async () => {
  const { b, sentImages } = imageBridge()
  const r = await b.applySessionOp({ op: 'image', sessionId: 's2', file: 'C:\\pics\\a.png' })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'file')
  assert.equal(sentImages[0].kind, 'group')
  assert.equal(sentImages[0].target, '123456')
  assert.equal(sentImages[0].opts.atUserId, undefined, '契约 3.3：群聊图片不带 @')
})
await check('image op：技能关闭 → 拒绝且不调 sendImage', async () => {
  const { b, sentImages } = imageBridge({ features: { image: false } })
  const r = await b.applySessionOp({ op: 'image', sessionId: 's1', url: 'https://x/y.png' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'image-disabled')
  assert.match(r.detail, /设置页/)
  assert.equal(sentImages.length, 0)
})
await check('image op：sessionId 没有映射 → no-session，且不污染 state', async () => {
  const { b } = imageBridge()
  const before = JSON.stringify(b.state.sessions)
  const r = await b.applySessionOp({ op: 'image', sessionId: 'nope', url: 'https://x/y.png' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'no-session')
  assert.match(r.detail, /先发条 QQ 消息/)
  assert.equal(JSON.stringify(b.state.sessions), before, 'image op 不该创建空 key 的垃圾行')
})
await check('image op：url 和 file 都没给 → empty-image', async () => {
  const { b } = imageBridge()
  const r = await b.applySessionOp({ op: 'image', sessionId: 's1' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'empty-image')
})
await check('image op：发送失败 → detail 带 via/retcode，字段原样透出', async () => {
  const { b } = imageBridge()
  b.qq.sendImage = async () => ({
    ok: false, messageIds: [], error: 'retcode=1200 status=failed', retcode: 1200, status: 'failed', via: 'url',
  })
  const r = await b.applySessionOp({ op: 'image', sessionId: 's1', url: 'https://x/y.png' })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'send')
  assert.match(r.detail, /图片发送失败（via=url）/)
  assert.match(r.detail, /retcode=1200/)
  assert.equal(r.detail, r.error)
  assert.equal(r.retcode, 1200)
  assert.equal(r.status, 'failed')
  assert.equal(r.via, 'url')
  assert.equal(b.stats.images, 0)
})

console.log('\n— P2：外部插件 hook（message / before-context）—')

/** 造一个「已启用外部插件」且 hook 打桩的 Bridge。 */
function hookedBridge(invoke) {
  const { b, calls } = makeBridge({ rhythm: { debounceWindowMs: 0 } })
  b.live.externalPlugins = { enabled: ['demo.ext'] }
  b.hooks = { invoke: async (event, payload) => invoke(event, payload) }
  return { b, calls }
}

await check('hook message：改写文本后再入队（入队前生效）', async () => {
  const seen = []
  const { b, calls } = hookedBridge((event, payload) => {
    seen.push({ event, payload: { ...payload } })
    return event === 'message'
      ? { ok: true, text: '改写后的文本', modules: ['demo.ext'] }
      : { ok: true, modules: ['demo.ext'] }
  })
  await b.handleMessage(privMsg('原始文本', 'p2-1'))
  assert.equal(calls.prompts.length, 1)
  assert.ok(calls.prompts[0].text.startsWith('改写后的文本'))
  const msgEvent = seen.find((s) => s.event === 'message')
  assert.equal(msgEvent.payload.key, 'u:1000000001')
  assert.equal(msgEvent.payload.text, '原始文本')
  assert.equal(msgEvent.payload.imageCount, 0)
  assert.equal(msgEvent.payload.user.id, '1000000001')
  assert.equal(msgEvent.payload.user.admin, false)
  assert.equal(msgEvent.payload.group, null)
  assert.ok(b.stats.hookCalls >= 1)
})
await check('hook message：drop → 不入队、计 skipped、记 info', async () => {
  const logs = []
  const { b, calls } = hookedBridge(() => ({ ok: true, drop: true, modules: ['demo.ext'] }))
  b.logger = { info: (m) => logs.push(String(m)), warn() {}, error() {} }
  await b.handleMessage(privMsg('刷屏广告', 'p2-2'))
  assert.equal(calls.prompts.length, 0)
  assert.equal(b.stats.skipped, 1)
  assert.equal(b.stats.hookDrops, 1)
  assert.ok(logs.some((line) => line.includes('丢弃')), `缺 info 日志：${JSON.stringify(logs)}`)
})
await check('hook 失败/抛错 → 原样放行，聊天不中断', async () => {
  const { b, calls } = hookedBridge(() => { throw new Error('hook down') })
  await b.handleMessage(privMsg('还是正常聊', 'p2-3'))
  assert.equal(calls.prompts.length, 1)
  assert.ok(calls.prompts[0].text.startsWith('还是正常聊'))
})
await check('hook 返回 ok:false → 原样放行', async () => {
  const { b, calls } = hookedBridge(() => ({ ok: false, modules: [], error: 'HTTP 500' }))
  await b.handleMessage(privMsg('照常', 'p2-4'))
  assert.ok(calls.prompts[0].text.startsWith('照常'))
})
await check('hook before-context：text 替换正文 + sections 按序追加到正文之后', async () => {
  const { b, calls } = hookedBridge((event) => (event === 'before-context'
    ? {
      ok: true, modules: ['demo.ext'], text: '替换后的正文',
      sections: [
        { title: '记忆', text: '用户喜欢短句' },
        { title: '天气', text: '今天晴' },
        { title: '空段', text: '   ' },
      ],
    }
    : { ok: true, modules: ['demo.ext'] }))
  await b.handleMessage(privMsg('原始', 'p2-5'))
  assert.equal(calls.prompts.length, 1)
  assert.ok(calls.prompts[0].text.startsWith(
    '替换后的正文\n\n[外部上下文：记忆]\n用户喜欢短句\n\n[外部上下文：天气]\n今天晴',
  ), calls.prompts[0].text.slice(0, 120))
})
await check('hook before-context：只给 sections 时追加在原文之后（不替换）', async () => {
  const { b, calls } = hookedBridge((event) => (event === 'before-context'
    ? { ok: true, modules: ['demo.ext'], sections: [{ title: '笔记', text: '甲' }] }
    : { ok: true, modules: ['demo.ext'] }))
  await b.handleMessage(privMsg('原文', 'p2-6'))
  assert.ok(calls.prompts[0].text.startsWith('原文\n\n[外部上下文：笔记]\n甲'),
    calls.prompts[0].text.slice(0, 120))
})
await check('没有启用外部插件 → 一条 hook 都不发', async () => {
  const { b } = makeBridge({ rhythm: { debounceWindowMs: 0 } })
  let called = 0
  b.hooks = { invoke: async () => { called++; return { ok: true, modules: [] } } }
  await b.handleMessage(privMsg('没人启用插件', 'p2-7'))
  assert.equal(called, 0, '★ externalPlugins.enabled 为空时不该发 hook')
  assert.equal(b.stats.hookSkipped, 2, 'message + before-context 各跳过一次')
  assert.equal(b.stats.hookCalls, 0)
})
await check('hook 客户端：modules 空 → 30s 负缓存（按事件分开）', async () => {
  let calls = 0
  const client = new ExternalHooksClient({
    getBaseUrl: () => 'http://127.0.0.1:1',
    logger: { warn() {} },
    fetchImpl: async () => {
      calls++
      return { ok: true, json: async () => ({ ok: true, modules: [], latencyMs: 1 }) }
    },
  })
  const first = await client.invoke('message', { text: 'a' })
  assert.equal(first.ok, true)
  assert.equal(calls, 1)
  const second = await client.invoke('message', { text: 'b' })
  assert.equal(calls, 1, '★ 负缓存窗口内不该再请求')
  assert.equal(second.skipped, 'no-module-cache')
  await client.invoke('before-context', { text: 'c' })
  assert.equal(calls, 2, '负缓存按事件分开：另一个事件仍会请求')
})
await check('hook 客户端：有模块生效不建负缓存；失败只 warn 一次且不缓存', async () => {
  let calls = 0
  const warns = []
  const client = new ExternalHooksClient({
    getBaseUrl: () => 'http://127.0.0.1:1',
    logger: { warn: (m) => warns.push(String(m)) },
    fetchImpl: async () => {
      calls++
      if (calls === 1) throw new Error('ECONNREFUSED')
      if (calls === 2) return { ok: false, status: 500, json: async () => ({}) }
      return {
        ok: true,
        json: async () => ({
          ok: true, modules: ['m1'], text: '外部改写', sections: [{ title: 't', text: 'v' }],
        }),
      }
    },
  })
  assert.equal((await client.invoke('message', { text: 'a' })).ok, false)
  assert.equal((await client.invoke('message', { text: 'b' })).ok, false)
  assert.equal(warns.length, 1, `连续失败只 warn 一次，实际 ${warns.length}`)
  const ok = await client.invoke('message', { text: 'c' })
  assert.equal(ok.ok, true)
  assert.equal(ok.text, '外部改写')
  assert.deepEqual(ok.sections, [{ title: 't', text: 'v' }])
  assert.equal(calls, 3, '失败不进负缓存，下次还会试')
  await client.invoke('message', { text: 'd' })
  assert.equal(calls, 4, '有模块生效时不建负缓存')
})

console.log('\n— P2：性能（去重 / 缓存 / 预取）—')

await check('_applyModel：同签名不重复 POST，换模型自然重发', async () => {
  const { b } = makeBridge({ rhythm: { debounceWindowMs: 0 } })
  let pushes = 0
  b.dsh.setSessionModel = async ({ provider, model }) => { pushes++; return { model: `${provider}/${model}` } }
  b.live.model = { provider: 'p', model: 'm1' }
  await b.handleMessage(privMsg('第一条', 'pm-1'))
  await b.handleMessage(privMsg('第二条', 'pm-2'))
  assert.equal(pushes, 1, `★ 同签名只该推一次，实际 ${pushes}`)
  assert.equal(b.stats.modelPushes, 1)
  assert.ok(b.stats.skippedRequests >= 1)
  b.live.model = { provider: 'p', model: 'm2' }
  await b.handleMessage(privMsg('第三条', 'pm-3'))
  assert.equal(pushes, 2, '★ 设置页换模型后必须重发')
})
await check('_applyPersona：同签名不重复 POST；身份变化/保存人设才重发', async () => {
  const { b } = makeBridge({
    rhythm: { debounceWindowMs: 0 },
    allow: { admins: ['1000000001'] },
    personaDefault: '默认人设',
  })
  const pushes = []
  b.dsh.setSessionPersona = async (payload) => { pushes.push(payload) }
  await b.handleMessage(privMsg('管理员一', 'pp-1'))
  await b.handleMessage(privMsg('管理员二', 'pp-2'))
  assert.equal(pushes.length, 1, `★ 同签名只该推一次，实际 ${pushes.length}`)
  assert.equal(b.stats.personaPushes, 1)
  // 非管理员在群里 @ 桥接：正文相同但追加了权限提示，签名变了 → 必须重发。
  const nonAdmin = { ...groupMsg('群友说话', { at: true, id: 'pp-3' }), userId: '1000000002' }
  await b.handleMessage(nonAdmin)
  assert.equal(pushes.length, 2, '★ 非管理员要重推（人设末尾多了权限提示）')
  assert.ok(String(pushes.at(-1).text).endsWith(ADMIN_GUARD_NOTE))
  // 设置页保存单人设：清缓存后立即重推。
  await b.applySessionOp({ op: 'persona', key: 'u:1000000001', text: '新人设' })
  assert.equal(pushes.length, 3, '保存单人设应立即推送')
  await b.handleMessage(privMsg('管理员三', 'pp-4'))
  assert.equal(pushes.length, 3, '相同人设的下一条消息不该再推')
})
await check('ensureSession：sessionExists 正结果缓存 30s，过期后重查', async () => {
  const { b } = makeBridge({ rhythm: { debounceWindowMs: 0 } })
  b.state.sessions['u:1000000001'] = normalizeSessionEntry('u:1000000001', { sessionId: 's1', qq: '1000000001' })
  let checks = 0
  b.dsh.sessionExists = async () => { checks++; return true }
  await b.handleMessage(privMsg('一', 'sc-1'))
  await b.handleMessage(privMsg('二', 'sc-2'))
  assert.equal(checks, 1, `★ 30s 内只该查一次，实际 ${checks}`)
  assert.equal(b.stats.sessionChecks, 1)
  assert.ok(b.stats.skippedRequests >= 1)
  // 模拟 30s 后缓存过期：必须重新确认，不能永远假存在。
  b._sessionExistsCache.set('s1', 0)
  await b.handleMessage(privMsg('三', 'sc-3'))
  assert.equal(checks, 2, '缓存过期后应重新查')
})
await check('图片预取：ingress 立即后台下载，处理时复用（不重复下载、不阻塞入队）', async () => {
  const { b, calls } = makeBridge({ rhythm: { debounceWindowMs: 120 } })
  b._modelSupportsImages = async () => true
  let downloads = 0
  b._downloadImage = async () => {
    downloads++
    await sleep(40)
    return { base64: 'QUJD', mediaType: 'image/png' }
  }
  const msg = { ...privMsg('看图', 'pf-1'), images: [{ url: 'https://example.invalid/pf.png' }] }
  const started = Date.now()
  await b.handleMessage(msg)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 100, `★ handleMessage 不该等图片下载（${elapsed}ms）`)
  assert.equal(downloads, 1, '★ ingress 收到消息就该开始预取')
  await sleep(320)
  assert.equal(calls.prompts.length, 1)
  assert.equal(downloads, 1, '★ 处理时复用预取的同一个 Promise，不重复下载')
  const content = calls.prompts[0].opts?.content ?? []
  assert.ok(content.some((part) => part.type === 'image'), '图片应作为 image part 交给模型')
})
await check('图片预取：并发 ≤ 2，LRU ≤ 32，TTL 过期会重新下载', async () => {
  const { b } = makeBridge()
  let active = 0
  let maxActive = 0
  let downloads = 0
  b._downloadImage = async () => {
    downloads++
    active++
    maxActive = Math.max(maxActive, active)
    await sleep(15)
    active--
    return { base64: 'QUJD', mediaType: 'image/png' }
  }
  const images = Array.from({ length: 4 }, (_, i) => ({ url: `https://example.invalid/c${i}.png` }))
  b._prefetchImages(images)
  await sleep(250)
  assert.equal(downloads, 4, `4 张图都应预取，实际 ${downloads}`)
  assert.equal(maxActive, 2, `★ 预取并发上限应为 2，实际 ${maxActive}`)
  // 缓存命中：同一批再取不产生新下载。
  await b._loadImageParts(images)
  assert.equal(downloads, 4, '缓存命中不该重复下载')
  // LRU 上限 32。
  let loads = 0
  b._downloadImage = async () => { loads++; return { base64: 'QUJD', mediaType: 'image/png' } }
  for (let i = 0; i < 40; i++) await b._loadImageRef(`https://example.invalid/l${i}.png`)
  assert.ok(b._imageCache.size <= 32, `★ LRU 上限应为 32，实际 ${b._imageCache.size}`)
  // TTL：过期条目必须重新下载。
  b._imageCache.set('https://example.invalid/c0.png',
    { at: Date.now() - 61_000, promise: Promise.resolve({ ok: true, value: { base64: 'x', mediaType: 'image/png' } }) })
  const before = loads
  await b._loadImageRef('https://example.invalid/c0.png')
  assert.equal(loads, before + 1, '★ TTL 过期后必须重新下载')
})

console.log('\n— P2：session-ops 慢 op detached（image 不阻塞同批其它 op）—')
await check('同一批 [image, clear]：image 后台执行、clear 回执先到，image 回执照常到达', async () => {
  const { startSessionOpsPolling, DETACHED_OPS } = await import('./src/session-ops.mjs')
  assert.equal(DETACHED_OPS.has('voice'), true)
  assert.equal(DETACHED_OPS.has('image'), true, '★ image 也必须是 detached op')
  let delivered = false
  const posted = []
  let imageStarts = 0
  const fakeFetch = async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'GET') {
      if (delivered) return { ok: true, json: async () => ({ ok: true, ops: [] }) }
      delivered = true
      return {
        ok: true,
        json: async () => ({
          ok: true,
          ops: [
            { id: 'op-i', op: 'image', sessionId: 's1', url: 'https://example.invalid/a.png' },
            { id: 'op-c', op: 'clear', key: 'u:1000000001' },
          ],
        }),
      }
    }
    posted.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const applySessionOp = async (op) => {
    if (op.op === 'image') {
      imageStarts++
      await sleep(150)
      return { ok: true, action: 'image', key: 'u:1000000001', detail: '已发送图片（via=url，retcode=0）' }
    }
    return { ok: true, action: 'clear', key: op.key }
  }
  const stop = startSessionOpsPolling({
    baseUrl: 'http://127.0.0.1:1',
    bridge: { applySessionOp },
    logger: { info() {}, warn() {} },
    pollMs: 10,
    fetchImpl: fakeFetch,
  })
  await sleep(60)
  assert.equal(posted.length, 1, `★ clear 回执应先到（image 还在跑）：${JSON.stringify(posted)}`)
  assert.deepEqual(posted[0].results.map((r) => r.id), ['op-c'])
  assert.equal(imageStarts, 1, 'image 应已开始执行（detached）')
  await sleep(240)
  stop()
  const receipt = posted.flatMap((p) => p.results).find((r) => r.id === 'op-i')
  assert.ok(receipt, `★ image 回执丢了：${JSON.stringify(posted)}`)
  assert.equal(receipt.ok, true)
  assert.match(receipt.detail, /已发送图片/)
})

console.log('\n— 工具能力升级：旧会话自动重建上下文（v0.5.1）—')
await check('toolEpoch 不一致 → 归档旧会话、建新会话、记录新 epoch（只发生一次）', async () => {
  const stateFile = path.join(os.tmpdir(), `qq-bridge-state-${process.pid}-epoch1.json`)
  fs.writeFileSync(stateFile, JSON.stringify({
    sessions: { 'g:123456': { sessionId: 'old-sess', toolEpoch: 'v0.4.0' } },
  }))
  const { b, calls } = makeBridge({ stateFile })
  b.live.toolEpoch = 'v0.5.1-test'
  const sid = await b.ensureSession('g:123456')
  assert.equal(sid, 's1', '应重建出新会话')
  assert.deepEqual(calls.archived, ['old-sess'], '旧会话必须归档')
  assert.deepEqual(calls.archiveOpts[0], { stopActivity: true }, '归档要带 stopActivity（旧会话可能还在跑）')
  assert.equal(calls.existChecks.length, 0, '能力升级直接重建，不必先查旧会话在不在')
  assert.equal(b.state.sessions['g:123456'].sessionId, 's1')
  assert.equal(b.state.sessions['g:123456'].toolEpoch, 'v0.5.1-test')
  assert.equal(b.stats.capabilityRefreshes, 1)
  // 同一条消息流程里不会二次重建（epoch 已对齐）。
  calls.created = 1
  assert.equal(await b.ensureSession('g:123456'), 's1')
  assert.equal(b.stats.capabilityRefreshes, 1)
  fs.rmSync(stateFile, { force: true })
})

await check('epoch 一致 → 复用原会话，不归档', async () => {
  const stateFile = path.join(os.tmpdir(), `qq-bridge-state-${process.pid}-epoch2.json`)
  fs.writeFileSync(stateFile, JSON.stringify({
    sessions: { 'g:123456': { sessionId: 'same-sess', toolEpoch: 'v0.5.1-test' } },
  }))
  const { b, calls } = makeBridge({ stateFile })
  b.live.toolEpoch = 'v0.5.1-test'
  assert.equal(await b.ensureSession('g:123456'), 'same-sess')
  assert.deepEqual(calls.archived, [], 'epoch 没变就不许重置上下文')
  assert.equal(b.stats.capabilityRefreshes, 0)
  fs.rmSync(stateFile, { force: true })
})

await check('配置 capability.autoRefreshOnUpgrade=false → 保留旧上下文（工具缺失需手动清空）', async () => {
  const stateFile = path.join(os.tmpdir(), `qq-bridge-state-${process.pid}-epoch3.json`)
  fs.writeFileSync(stateFile, JSON.stringify({
    sessions: { 'g:123456': { sessionId: 'keep-sess', toolEpoch: 'v0.4.0' } },
  }))
  const { b, calls } = makeBridge({ stateFile, capability: { autoRefreshOnUpgrade: false } })
  b.live.toolEpoch = 'v0.5.1-test'
  assert.equal(await b.ensureSession('g:123456'), 'keep-sess')
  assert.deepEqual(calls.archived, [])
  assert.equal(b.stats.capabilityRefreshes, 0)
  fs.rmSync(stateFile, { force: true })
})

await check('新建会话即写下当前 epoch（重启后不会反复重建）', async () => {
  const { b } = makeBridge({})
  b.live.toolEpoch = 'v0.5.1-test'
  await b.ensureSession('u:1000000001')
  assert.equal(b.state.sessions['u:1000000001'].toolEpoch, 'v0.5.1-test')
})

await check('normalizeSessionEntry 保留 toolEpoch（_loadState 不再丢字段）', () => {
  const entry = normalizeSessionEntry('g:123456', { sessionId: 's', toolEpoch: 'v0.5.1-test' })
  assert.equal(entry.toolEpoch, 'v0.5.1-test')
  assert.equal(normalizeSessionEntry('g:1', { sessionId: 's' }).toolEpoch, '')
  assert.equal(normalizeSessionEntry('g:1', 'session-abc').toolEpoch, '')
})

await check('热配置轮询把 toolEpoch 计入人设签名（features 变化会重推人设）', () => {
  const hot = pickHotConfig({ toolEpoch: 'v0.5.1-test', features: { image: true } })
  assert.equal(hot.toolEpoch, 'v0.5.1-test')
  assert.deepEqual(hot.features, { image: true })
})

await check('能力说明带权威「工具可用性」块（压掉人设/历史里的旧说法）', () => {
  const on = capabilityLines({ vision: false, search: false, voice: true, image: true }).join('\n')
  assert.match(on, /【工具可用性（以本段为准）】/)
  assert.match(on, /不要回答「没有发图工具」/)
  const off = capabilityLines({ vision: false, search: false, voice: false, image: false }).join('\n')
  assert.ok(!off.includes('工具可用性'), '技能全关时不打权威块')
})

console.log('\n— 单群活跃系数 + 人设重推修复（qq-bridge 独立测试文件）—')
await check('qq-bridge 单群活跃系数回归全绿', async () => {
  const { execFileSync } = await import('node:child_process')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const script = path.resolve(here, 'test-activity.mjs')
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8', env: pluginTestEnv })
  assert.match(out, /结果：\d+ 通过 \/ 0 失败/, `单群活跃系数回归未全绿：\n${out}`)
})

console.log('\n— TTS 通路（baidu / edge 人话错误 / file:// 降级 / op detail）—')
await check('qq-bridge TTS 通路回归全绿', async () => {
  const { execFileSync } = await import('node:child_process')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const script = path.resolve(here, 'test-tts.mjs')
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8', env: pluginTestEnv })
  assert.match(out, /结果：\d+ 通过 \/ 0 失败/, `TTS 通路回归未全绿：\n${out}`)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
