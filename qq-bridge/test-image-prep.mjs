/**
 * 长图 / 多模态降级回归（2026-10-27，离线，零 npm 依赖）。
 *
 * 锁死的约定：
 *   ① 只读文件头就能拿到 PNG/JPEG/GIF/WebP 尺寸（不解码整张图）；
 *   ② 超过 DSH 源图上限（单边 8192 / 64MP / 20MB）的长图会被切成多片、
 *      每片都能被 DSH 收下（尺寸/像素都在预算内），并且相邻片有重叠；
 *   ③ 没超标的图**一个字节都不改**（不做无谓的重编码）；
 *   ④ 切不了（渐进式 JPEG / WebP / 实在太长）→ 抛 ImagePrepError，
 *      提示词里必须是「图片太长/太大，拆成几张再发」，绝不能是「模型不支持」；
 *   ⑤ `attachment-invalid` 不再被当成「模型没视觉能力」；只有
 *      `MODEL_DOES_NOT_SUPPORT_IMAGES` 才算；
 *   ⑥ 能力缓存按 provider/model 分键：一次图片失败不再污染其它模型；
 *   ⑦ 降级重试必须**去掉 content**（否则同一批图会被再拒一遍）。
 *
 * 运行：node test-image-prep.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bridge } from './src/bridge.mjs'
import { encodePng, decodePng } from './src/png-codec.mjs'
import { decodeJpeg, readJpegSize } from './src/jpeg-decode.mjs'
import { readWebpSize, readGifSize } from './src/image-size.mjs'
import {
  DSH_IMAGE_LIMITS, ImagePrepError, MAX_TILES, TILE_OVERLAP, cropImage,
  planTiles, prepareImageParts, readImageInfo, scaleImage,
} from './src/image-prep.mjs'

let pass = 0
let fail = 0
const HERE = path.dirname(fileURLToPath(import.meta.url))
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ } catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

function makeBridge() {
  const b = new Bridge({
    config: {
      dsh: { baseUrl: 'http://127.0.0.1:1', sessionCwd: '.', workspaceTitle: 'x', agentPreset: 'qq-chat' },
      onebot: { wsUrl: 'ws://127.0.0.1:1', accessToken: 't' },
      allow: { private: ['1000000001'], groups: [], allowAllWhenEmpty: false },
      stateFile: path.join(os.tmpdir(), `qq-img-state-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  b.live.features = { ...(b.live.features ?? {}), vision: true }
  b.dsh = { baseUrl: 'http://127.0.0.1:1', ensureCookie: () => 'c=1' }
  return b
}

/** 造一张「聊天截图」：白底 + 横向气泡条；每 120px 一条色带，便于检查切片是否错位。 */
function makeLongPng(width, height) {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const band = Math.floor(y / 120)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      let r = 250; let g = 250; let b = 250
      if (y % 120 < 84 && x > 40 && x < width - 40) {
        r = 200 + (band * 11) % 50
        g = 205 + (band * 7) % 40
        b = 235
      }
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
      data[o + 3] = 255
    }
  }
  return encodePng({ width, height, data }, { alpha: false })
}

console.log('— 文件头尺寸（不解码像素）—')
await check('PNG：读写尺寸一致', () => {
  const png = makeLongPng(120, 90)
  assert.deepEqual(readImageInfo(png), { mediaType: 'image/png', width: 120, height: 90 })
})
await check('JPEG：baseline 夹具尺寸 + 像素可信', () => {
  const buf = fs.readFileSync(path.join(HERE, 'test-fixtures/quad-baseline.jpg'))
  assert.deepEqual(readJpegSize(buf), { width: 64, height: 64 })
  const img = decodeJpeg(buf)
  assert.equal(img.width, 64)
  const px = (x, y) => [img.data[(y * 64 + x) * 4], img.data[(y * 64 + x) * 4 + 1], img.data[(y * 64 + x) * 4 + 2]]
  const near = (a, b, tolerance = 24) => Math.abs(a - b) <= tolerance
  const tl = px(16, 16); const tr = px(48, 16); const bl = px(16, 48); const br = px(48, 48)
  assert.ok(near(tl[0], 220) && near(tl[1], 40), `左上应偏红，实际 ${tl}`)
  assert.ok(near(tr[1], 200) && near(tr[0], 40), `右上应偏绿，实际 ${tr}`)
  assert.ok(near(bl[2], 220) && near(bl[0], 40), `左下应偏蓝，实际 ${bl}`)
  assert.ok(br[0] > 220 && br[1] > 220 && br[2] > 220, `右下应接近白，实际 ${br}`)
})
await check('JPEG：渐进式（SOF2）明确报不支持，不硬解', () => {
  const baseline = fs.readFileSync(path.join(HERE, 'test-fixtures/quad-baseline.jpg'))
  const copy = Buffer.from(baseline)
  // 把 SOF0 改成 SOF2（只动标记，扫描数据不动，够触发拒绝分支）
  for (let i = 2; i + 1 < copy.length; i++) {
    if (copy[i] === 0xff && copy[i + 1] === 0xc0) { copy[i + 1] = 0xc2; break }
  }
  assert.throws(() => decodeJpeg(copy), /渐进式/)
})
await check('GIF / WebP：逻辑屏幕 / VP8X 尺寸', () => {
  const gif = Buffer.alloc(20)
  gif.write('GIF89a', 0, 'ascii')
  gif.writeUInt16LE(320, 6)
  gif.writeUInt16LE(480, 8)
  assert.deepEqual(readGifSize(gif), { width: 320, height: 480 })
  const webp = Buffer.alloc(40)
  webp.write('RIFF', 0, 'ascii')
  webp.write('WEBP', 8, 'ascii')
  webp.write('VP8X', 12, 'ascii')
  const w = 5000 - 1
  const h = 9000 - 1
  webp[24] = w & 0xff; webp[25] = (w >> 8) & 0xff; webp[26] = (w >> 16) & 0xff
  webp[27] = h & 0xff; webp[28] = (h >> 8) & 0xff; webp[29] = (h >> 16) & 0xff
  assert.deepEqual(readWebpSize(webp), { width: 5000, height: 9000 })
})

console.log('\n— 切条规划（每片都必须落在 DSH 准入范围内）—')
await check('1080x10000：切 4 片，均 ≤8192 且 ≤4MP，覆盖全高、相邻重叠', () => {
  const plan = planTiles(1080, 10000)
  assert.equal(plan.axis, 'y')
  assert.equal(plan.scale, 1)
  assert.equal(plan.ranges.length, 4)
  assert.equal(plan.ranges[0].start, 0)
  assert.equal(plan.ranges.at(-1).end, 10000)
  for (let i = 0; i < plan.ranges.length; i++) {
    const { start, end } = plan.ranges[i]
    const h = end - start
    assert.ok(h <= DSH_IMAGE_LIMITS.maxDimension, `片高 ${h} 超单边上限`)
    assert.ok(1080 * h <= DSH_IMAGE_LIMITS.normalizedPixels, `片 ${1080}x${h} 超 4MP 预算`)
    if (i > 0) assert.equal(start, plan.ranges[i - 1].end - TILE_OVERLAP, '相邻片应有 64px 重叠')
  }
})
await check('1080x20000：片数不超过上限，必要时整体缩小', () => {
  const plan = planTiles(1080, 20000)
  assert.ok(plan.ranges.length <= MAX_TILES, `片数 ${plan.ranges.length} 超上限`)
  assert.ok(plan.scale < 1, '这么长应该先缩一点')
  assert.equal(plan.ranges.at(-1).end, Math.round(20000 * plan.scale))
})
await check('1080x120000：缩到看不清就认输（返回 null → 请用户拆图）', () => {
  assert.equal(planTiles(1080, 120000), null)
})
await check('横向超宽图也能切（10000x600）', () => {
  const plan = planTiles(10000, 600)
  assert.equal(plan.axis, 'x')
  assert.ok(plan.ranges.length >= 2)
  assert.equal(plan.ranges.at(-1).end, 10000)
})

console.log('\n— 预处理主流程 —')
await check('未超标的图原样透传（字节完全一致，不重编码）', () => {
  const png = makeLongPng(300, 200)
  const result = prepareImageParts(png, 'image/png')
  assert.equal(result.transformed, false)
  assert.equal(result.parts.length, 1)
  assert.equal(result.parts[0].data.equals(png), true)
  assert.equal(result.parts[0].base64, png.toString('base64'))
})
await check('1080x10000 PNG → 4 片 PNG，切片像素与原因子对齐（含重叠）', () => {
  const png = makeLongPng(1080, 10000)
  const result = prepareImageParts(png, 'image/png')
  assert.equal(result.transformed, true)
  assert.equal(result.tiles, 4)
  assert.equal(result.scale, 1)
  const original = decodePng(png)
  let previous = null
  for (const part of result.parts) {
    const decoded = decodePng(part.data)
    assert.equal(decoded.width, part.width)
    assert.equal(decoded.height, part.height)
    assert.ok(decoded.width <= DSH_IMAGE_LIMITS.maxDimension)
    assert.ok(decoded.height <= DSH_IMAGE_LIMITS.maxDimension)
    assert.ok(decoded.width * decoded.height <= DSH_IMAGE_LIMITS.normalizedPixels)
    if (previous) {
      // 上一片最后 64 行 与 这一片最前 64 行 必须一模一样（重叠区）。
      const overlap = TILE_OVERLAP
      const prevData = decodePng(previous.data).data
      const prevH = previous.height
      const prevStart = (prevH - overlap) * previous.width * 4
      const expected = prevData.subarray(prevStart, prevStart + overlap * previous.width * 4)
      const actual = decoded.data.subarray(0, overlap * decoded.width * 4)
      assert.equal(Buffer.compare(Buffer.from(actual), Buffer.from(expected)), 0, '重叠区像素应一致')
    }
    previous = { data: part.data, height: decoded.height, width: decoded.width }
  }
  // 第一片第一行 = 原图第一行
  const firstTile = decodePng(result.parts[0].data)
  assert.equal(Buffer.compare(
    Buffer.from(firstTile.data.subarray(0, firstTile.width * 4)),
    Buffer.from(original.data.subarray(0, original.width * 4)),
  ), 0)
})
await check('WebP 超限 → ImagePrepError(UNSUPPORTED_FORMAT)，不会静默丢图', () => {
  const webp = Buffer.alloc(40)
  webp.write('RIFF', 0, 'ascii')
  webp.write('WEBP', 8, 'ascii')
  webp.write('VP8X', 12, 'ascii')
  const w = 1080 - 1; const h = 12000 - 1
  webp[24] = w & 0xff; webp[25] = (w >> 8) & 0xff; webp[26] = (w >> 16) & 0xff
  webp[27] = h & 0xff; webp[28] = (h >> 8) & 0xff; webp[29] = (h >> 16) & 0xff
  assert.throws(() => prepareImageParts(webp, 'image/webp'), (e) => e instanceof ImagePrepError && e.code === 'UNSUPPORTED_FORMAT')
})
await check('极端长图（1080x120000）→ ImagePrepError(TOO_LONG)', () => {
  const png = makeLongPng(1080, 120000)
  assert.throws(() => prepareImageParts(png, 'image/png'), (e) => e instanceof ImagePrepError && e.code === 'TOO_LONG')
})
await check('scaleImage/cropImage：缩一半尺寸正确、裁剪不越界', () => {
  const png = makeLongPng(200, 200)
  const img = decodePng(png)
  const half = scaleImage(img, 100, 100)
  assert.deepEqual([half.width, half.height], [100, 100])
  const tile = cropImage(img, 'y', 150, 200)
  assert.deepEqual([tile.width, tile.height], [200, 50])
})

console.log('\n— 桥接接线（prompt content / 提示词）—')
await check('长图进 _buildPromptContent：变成多片 image part，token 与片数一一对应', async () => {
  const b = makeBridge()
  b._modelSupportsImages = async () => true
  const png = makeLongPng(1080, 10000)
  b._downloadImage = async () => ({ base64: png.toString('base64'), mediaType: 'image/png' })
  const relayed = []
  b._relayRawImage = async (token) => { relayed.push(token); return true }
  const built = await b._buildPromptContent('看看这张长截图', [{ url: 'https://example.invalid/long.png' }])
  assert.equal(built.images, 4, `应切成 4 片，实际 ${built.images}`)
  assert.equal(built.content.filter((part) => part.type === 'image').length, 4)
  assert.equal(built.rawMarkers.length, 4, '★ 每个 image part 都要有自己的 token（否则插件对不齐）')
  assert.equal(relayed.length, 4)
  for (const part of built.content.filter((item) => item.type === 'image')) {
    assert.equal(part.mediaType, 'image/png')
    const decoded = decodePng(Buffer.from(part.data, 'base64'))
    assert.ok(decoded.width * decoded.height <= DSH_IMAGE_LIMITS.normalizedPixels)
  }
  assert.match(built.content[0].text, /看看这张长截图/u)
})
await check('切不了的长图：提示词准确说「太长/拆开」，绝不甩锅模型', async () => {
  const b = makeBridge()
  b._modelSupportsImages = async () => true
  b._downloadImage = async () => {
    const webp = Buffer.alloc(40)
    webp.write('RIFF', 0, 'ascii')
    webp.write('WEBP', 8, 'ascii')
    webp.write('VP8X', 12, 'ascii')
    webp[24] = 1079 & 0xff; webp[25] = (1079 >> 8) & 0xff
    webp[27] = 12000 & 0xff; webp[28] = (12000 >> 8) & 0xff
    return { base64: webp.toString('base64'), mediaType: 'image/webp' }
  }
  const built = await b._buildPromptContent('看图', [{ url: 'https://example.invalid/tall.webp' }])
  assert.equal(built.images, 0)
  assert.match(built.fallbackText, /太长|太大/u)
  assert.match(built.fallbackText, /拆/u)
  assert.doesNotMatch(built.fallbackText, /不支持图片/u)
  assert.match(built.tooBigText, /太长|太大/u)
})

console.log('\n— 错误分类：不许再把「图被拒」当成「模型不行」—')
await check('MODEL_DOES_NOT_SUPPORT_IMAGES → NO_VISION', () => {
  const b = makeBridge()
  const failure = b._classifyPromptImageError(new Error('session/prompt 失败: session/attachment-invalid Model "x" does not support image input. MODEL_DOES_NOT_SUPPORT_IMAGES'))
  assert.equal(failure.kind, 'NO_VISION')
})
await check('IMAGE_DIMENSION_TOO_LARGE → IMAGE_TOO_BIG（且不影响能力）', () => {
  const b = makeBridge()
  const error = new Error('session/prompt 失败: session/attachment-invalid Image exceeds the configured per-side pixel limit.')
  error.details = { reason: 'IMAGE_DIMENSION_TOO_LARGE' }
  const failure = b._classifyPromptImageError(error)
  assert.equal(failure.kind, 'IMAGE_TOO_BIG')
  assert.equal(failure.reason, 'IMAGE_DIMENSION_TOO_LARGE')
})
await check('裸 attachment-invalid → IMAGE_INVALID（不是 NO_VISION）', () => {
  const b = makeBridge()
  assert.equal(b._classifyPromptImageError(new Error('xxx attachment-invalid yyy')).kind, 'IMAGE_INVALID')
})
await check('无关错误 → 原样上抛', async () => {
  const b = makeBridge()
  b.dsh.promptAndWait = async () => { throw new Error('ECONNRESET') }
  await assert.rejects(
    () => b._promptWithImageFallback({ sessionId: 's', built: { images: 1 }, text: 't', promptText: 't', promptOpts: {}, error: new Error('ECONNRESET') }),
    /ECONNRESET/,
  )
})
await check('图片超尺寸被拒：降级重试**不带 content**，能力判定不变，提示「拆开再发」', async () => {
  const b = makeBridge()
  const calls = []
  b.dsh.promptAndWait = async (sessionId, text, opts) => {
    calls.push({ text, opts })
    if (opts?.content) {
      const error = new Error('session/prompt 失败: session/attachment-invalid')
      error.details = { reason: 'IMAGE_DIMENSION_TOO_LARGE' }
      throw error
    }
    return '好'
  }
  const reply = await b._promptWithImageFallback({
    sessionId: 's1',
    built: { images: 2, fallbackText: 'FB', tooBigText: '（图片太长/太大，请拆开再发）' },
    text: '看图', promptText: '看图', promptOpts: { timeoutMs: 1, content: [{ type: 'image' }] },
    error: Object.assign(new Error('session/prompt 失败: session/attachment-invalid'), { details: { reason: 'IMAGE_DIMENSION_TOO_LARGE' } }),
  })
  assert.equal(reply, '好')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].opts?.content, undefined, '★ 重试必须去掉 content')
  assert.match(calls[0].text, /拆开再发/u)
  assert.equal(b._visionProbe, null, '★ 尺寸问题绝不能把能力判成「不支持」')
})
await check('真不支持图片：能力缓存置 false，提示词说「模型不支持」', async () => {
  const b = makeBridge()
  b.dsh.promptAndWait = async (sessionId, text, opts) => {
    if (opts?.content) {
      const error = new Error('session/prompt 失败: session/attachment-invalid Model "x" does not support image input.')
      error.details = { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' }
      throw error
    }
    return '好'
  }
  await b._promptWithImageFallback({
    sessionId: 's1',
    built: { images: 1, fallbackText: '（当前模型不支持图片输入）', tooBigText: 'X' },
    text: '看图', promptText: '看图', promptOpts: { content: [{ type: 'image' }] },
    error: Object.assign(new Error('MODEL_DOES_NOT_SUPPORT_IMAGES'), { details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } }),
  })
  assert.equal(b._visionProbe?.ok, false)
})
await check('能力缓存按 provider/model 分键：换模型立即重新查', async () => {
  const b = makeBridge()
  b.config.dsh.provider = 'p1'
  b.config.dsh.model = 'text-only'
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    calls++
    return {
      ok: true,
      json: async () => ({
        configured: { provider: 'p1', model: 'text-only' },
        providers: [
          { id: 'p1', models: [{ id: 'text-only', input: ['text'] }, { id: 'vision', input: ['text', 'image'] }] },
        ],
      }),
    }
  }
  try {
    b.live = { ...(b.live ?? {}), model: { provider: 'p1', model: 'text-only' } }
    assert.equal(await b._modelSupportsImages(), false)
    assert.equal(await b._modelSupportsImages(), false, '同 route 命中缓存')
    assert.equal(calls, 1)
    // 换到有视觉的模型：键不同，必须重新查
    b.live.model = { provider: 'p1', model: 'vision' }
    assert.equal(await b._modelSupportsImages(), true)
    assert.equal(calls, 2)
    // 实测成功也会把负面结论纠正成正面
    b._noteVisionResult(true)
    assert.equal(b._visionProbe.ok, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
