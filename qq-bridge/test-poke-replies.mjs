/**
 * 戳一戳「图文混合回复列表」回归（2026-10-27，离线）。
 *
 * 锁死的约定：
 *   ① `poke.replies` 是 `{ text, image }` 数组，随机挑一条；空数组退回 `replyText`；
 *   ② `mode: 'fixed_text'` 是 `'text'` 的别名（UI 说法），行为完全一致；
 *   ③ 只有文字 → 只发文字；只有图 → 只发图；图文都有 → **先文字、再单独发表情包**；
 *   ④ 表情包必须带 `subType: 1`；
 *   ⑤ 两条之间留间隔（POKE_IMAGE_GAP_MS），不混排成一条；
 *   ⑥ 图片文件不存在 → 能发文字就发文字，绝不静默；
 *   ⑦ 连戳两次不会连续抽中同一条。
 *
 * 运行：node test-poke-replies.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Bridge } from './src/bridge.mjs'

let pass = 0
let fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

/** 造一张最小的合法 PNG（只要魔数对，桥接侧只 stat 不解析）。 */
function makeTempPng() {
  const file = path.join(os.tmpdir(), `qq-poke-img-${process.pid}-${Math.random().toString(36).slice(2)}.png`)
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))
  return file
}

function makeBridge({ poke, allow, nameOf } = {}) {
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: {
        private: ['1000000001'], groups: ['123456'], admins: [],
        allowAllWhenEmpty: false, ...(allow ?? {}),
      },
      sendDelayMs: 0,
      stateFile: path.join(os.tmpdir(), `qq-poke-rpl-state-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
      rhythm: { activityLevel: 3, debounceWindowMs: 0 },
      // 默认关掉随机延迟：这些用例测的是抽取与发送，不该为每条等 200~500ms。
      // 需要测延迟的用例自己传 poke.delayMinMs / delayMaxMs。
      poke: { delayMinMs: 0, delayMaxMs: 0, ...(poke ?? {}) },
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  const calls = { pokes: [], sent: [], images: [], warns: [], order: [] }
  b.dsh = {
    sessionExists: async () => true,
    ensureWorkspace: async () => 'w1',
    createSession: async () => 's1',
    setSessionModel: async () => ({}),
    archiveSession: async () => ({ ok: true }),
    renameSession: async (sid, title) => title,
    sessionTitle: async () => null,
    setSessionPersona: async () => ({ ok: true }),
    promptAndWait: async () => '好',
    call: async () => ({}),
  }
  b.logger = {
    info() {},
    warn: (m) => calls.warns.push(String(m)),
    error() {},
  }
  b.qq.call = async () => ({ status: 'ok', data: {} })
  b.qq.sendPrivate = async (uid, text) => {
    calls.sent.push({ kind: 'private', uid, text })
    calls.order.push({ type: 'text', at: Date.now() })
    return { ok: true }
  }
  b.qq.sendGroup = async (gid, text) => {
    calls.sent.push({ kind: 'group', gid, text })
    calls.order.push({ type: 'text', at: Date.now() })
    return { ok: true }
  }
  b.qq.sendImage = async (kind, target, file, opts) => {
    calls.images.push({ kind, target, file, opts })
    calls.order.push({ type: 'image', at: Date.now() })
    return calls.imageResult ?? { ok: true, via: String(file).startsWith('file:') ? 'file' : 'base64' }
  }
  b.qq.sendPoke = async (kind, target, opts) => {
    calls.pokes.push({ kind, target, opts })
    calls.order.push({ type: 'poke', at: Date.now() })
    return calls.pokeResult ?? { ok: true, action: 'group_poke', retcode: 0 }
  }
  b.qq.nameOf = (scopeKey, qq) => (typeof nameOf === 'function' ? nameOf(scopeKey, qq) : String(nameOf ?? ''))
  b.qq.start = async () => {}
  b.qq._selfId = '999'
  return { b, calls }
}

const pokeNotice = ({ userId = '1000000001', targetId = '999', groupId = '123456', kind = 'poke' } = {}) => ({
  kind, userId, targetId, groupId, selfId: '999', time: 1, raw: {},
})

console.log('戳一戳 · 图文混合回复：')

await check('replies 为空 → 退回 replyText（老配置不迁移也能用）', async () => {
  const { b, calls } = makeBridge({ poke: { mode: 'text', replyText: '戳我干嘛 {qq}' } })
  await b.handleNotice(pokeNotice())
  assert.deepEqual(calls.images, [])
  assert.deepEqual(calls.sent.map((x) => x.text), ['戳我干嘛 1000000001'])
})

await check('纯文字条目 → 只发文字，不调 sendImage', async () => {
  const { b, calls } = makeBridge({
    poke: { mode: 'text', replies: [{ text: '别戳啦 {nick}', image: '' }] },
    nameOf: '小明',
  })
  await b.handleNotice(pokeNotice())
  assert.deepEqual(calls.sent.map((x) => x.text), ['别戳啦 小明'])
  assert.equal(calls.images.length, 0)
})

await check('纯图片条目 → 只发表情，subType 必须是 1', async () => {
  const image = makeTempPng()
  const { b, calls } = makeBridge({ poke: { mode: 'text', replies: [{ text: '', image }] } })
  await b.handleNotice(pokeNotice())
  assert.equal(calls.sent.length, 0, '纯图片不该发文字')
  assert.equal(calls.images.length, 1)
  assert.equal(calls.images[0].opts.subType, 1)
  assert.ok(String(calls.images[0].file).startsWith('file:'), `本地路径应转 file:///，实际 ${calls.images[0].file}`)
  fs.unlinkSync(image)
})

await check('图文条目 → 先文字、再表情，且间隔 ≥ 300ms', async () => {
  const image = makeTempPng()
  const { b, calls } = makeBridge({
    poke: { mode: 'text', replies: [{ text: '送你一个表情', image }] },
  })
  await b.handleNotice(pokeNotice())
  assert.deepEqual(calls.order.map((x) => x.type), ['text', 'image'])
  const gap = calls.order[1].at - calls.order[0].at
  assert.ok(gap >= 300, `间隔应 ≥300ms，实际 ${gap}ms`)
  fs.unlinkSync(image)
})

await check('mode: fixed_text 等同 text', async () => {
  const { b, calls } = makeBridge({
    poke: { mode: 'fixed_text', replies: [{ text: '别名也认', image: '' }] },
  })
  await b.handleNotice(pokeNotice())
  assert.deepEqual(calls.sent.map((x) => x.text), ['别名也认'])
})

await check('图片文件不存在 → 有文字就发文字，只记 warn', async () => {
  const { b, calls } = makeBridge({
    poke: { mode: 'text', replies: [{ text: '图挂了但话还在', image: '/no/such/file.png' }] },
  })
  await b.handleNotice(pokeNotice())
  assert.deepEqual(calls.sent.map((x) => x.text), ['图挂了但话还在'])
  assert.equal(calls.images.length, 0)
  assert.ok(calls.warns.some((line) => /表情不可用|表情发送失败/u.test(line)), JSON.stringify(calls.warns))
})

await check('只有图且文件不存在 → 不发，warn 里带具体原因', async () => {
  const { b, calls } = makeBridge({ poke: { mode: 'text', replies: [{ text: '', image: '/no/such/file.png' }] } })
  await b.handleNotice(pokeNotice())
  assert.equal(calls.sent.length, 0)
  assert.equal(calls.images.length, 0)
  assert.ok(calls.warns.some((line) => /表情不可用|表情发送失败/u.test(line)), JSON.stringify(calls.warns))
  // 2026-10-27：失败原因必须能看出是「文件读不到」，不能只给一句「图片不可用」。
  assert.ok(calls.warns.some((line) => line.includes('文件读不到')), JSON.stringify(calls.warns))
})

await check('连戳两次不抽同一条（随机固定也避开上一次）', async () => {
  const rows = [{ text: 'A', image: '' }, { text: 'B', image: '' }, { text: 'C', image: '' }]
  const { b, calls } = makeBridge({ poke: { mode: 'text', replies: rows } })
  const original = Math.random
  Math.random = () => 0.1   // 永远命中下标 0
  try {
    await b.handleNotice(pokeNotice())
    b._pokeAt.set('g:123456', 0)   // 绕过 3 秒节流
    await b.handleNotice(pokeNotice())
  } finally {
    Math.random = original
  }
  assert.deepEqual(calls.sent.map((x) => x.text), ['A', 'B'], '第二次应顺延到 B')
})

await check('空条目被丢弃：两个字段都空不会发空消息', async () => {
  const { b, calls } = makeBridge({
    poke: { mode: 'text', replyText: '兜底一句', replies: [{ text: '   ', image: '' }, { text: '', image: '' }] },
  })
  await b.handleNotice(pokeNotice())
  assert.deepEqual(calls.sent.map((x) => x.text), ['兜底一句'])
})

/* ── 2026-10-27：真实回戳 / 随机延迟 / 抽图策略 ─────────────── */

await check('withAction：延迟后先真实回戳，紧接着发文字', async () => {
  const { b, calls } = makeBridge({
    poke: { mode: 'text', withAction: true, replies: [{ text: '戳回去', image: '' }] },
  })
  await b.handleNotice(pokeNotice())
  assert.equal(calls.pokes.length, 1, 'withAction 必须真的调 sendPoke')
  assert.deepEqual(calls.pokes[0], { kind: 'group', target: '123456', opts: { userId: '1000000001' } })
  assert.deepEqual(calls.order.map((x) => x.type), ['poke', 'text'], '顺序：先戳再发')
})

await check('withAction=false → 只发文字，不调 sendPoke', async () => {
  const { b, calls } = makeBridge({
    poke: { mode: 'text', withAction: false, replies: [{ text: '只说话', image: '' }] },
  })
  await b.handleNotice(pokeNotice())
  assert.equal(calls.pokes.length, 0)
  assert.equal(calls.sent.length, 1)
})

await check('withAction 回戳失败不影响后面的文字', async () => {
  const { b, calls } = makeBridge({
    poke: { mode: 'text', withAction: true, replies: [{ text: '照样发', image: '' }] },
  })
  calls.pokeResult = { ok: false, action: 'group_poke', retcode: -1, error: 'group_poke: retcode=-1' }
  await b.handleNotice(pokeNotice())
  assert.equal(calls.pokes.length, 1)
  assert.deepEqual(calls.sent.map((x) => x.text), ['照样发'])
})

await check('_pokeDelay：落在 [min,max]，max<min 按 min，0/0 不延迟', () => {
  const { b } = makeBridge()
  const original = Math.random
  try {
    Math.random = () => 0
    assert.equal(b._pokeDelay({ delayMinMs: 200, delayMaxMs: 500 }), 200)
    Math.random = () => 0.9999999
    assert.equal(b._pokeDelay({ delayMinMs: 200, delayMaxMs: 500 }), 500)
    Math.random = () => 0.5
    const mid = b._pokeDelay({ delayMinMs: 200, delayMaxMs: 500 })
    assert.ok(mid >= 200 && mid <= 500, `应在区间内：${mid}`)
  } finally {
    Math.random = original
  }
  assert.equal(b._pokeDelay({ delayMinMs: 0, delayMaxMs: 0 }), 0)
  assert.equal(b._pokeDelay({ delayMinMs: 500, delayMaxMs: 200 }), 500, 'max<min 应按 min')
  assert.equal(b._pokeDelay(undefined), 0, '缺配置不应抛')
})

await check('随机延迟真的等：delays 都是 80ms 时至少等 70ms', async () => {
  const { b, calls } = makeBridge({
    poke: { mode: 'text', delayMinMs: 80, delayMaxMs: 80, replies: [{ text: '慢一点', image: '' }] },
  })
  const started = Date.now()
  await b.handleNotice(pokeNotice())
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 70, `应至少等 ~80ms，实际 ${elapsed}ms`)
  assert.equal(calls.sent.length, 1)
})

await check('priority_image：列表里有图就必抽图（多次都不例外）', async () => {
  const image = makeTempPng()
  const rows = [{ text: 'A', image: '' }, { text: 'B', image: '' }, { text: 'C', image }]
  const { b, calls } = makeBridge({
    poke: { mode: 'text', replyMode: 'priority_image', replies: rows },
  })
  for (let i = 0; i < 6; i++) {
    b._pokeAt.set('g:123456', 0)
    await b.handleNotice(pokeNotice())
  }
  assert.equal(calls.images.length, 6, `每次都该抽到带图那条，实际 ${calls.images.length}`)
  assert.equal(calls.sent.filter((x) => x.text === 'A' || x.text === 'B').length, 0, '不该抽到纯文字条目')
  fs.unlinkSync(image)
})

await check('pure_random：多次抽取能出现纯文字条目', async () => {
  const image = makeTempPng()
  const rows = [{ text: 'A', image: '' }, { text: 'B', image: '' }, { text: 'C', image }]
  const { b, calls } = makeBridge({
    poke: { mode: 'text', replyMode: 'pure_random', replies: rows },
  })
  for (let i = 0; i < 12; i++) {
    b._pokeAt.set('g:123456', 0)
    await b.handleNotice(pokeNotice())
  }
  assert.ok(calls.sent.length > 0, '纯随机应该能抽到文字条目')
  fs.unlinkSync(image)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
