/**
 * 图片「准入前处理」：把超长/超大的截图变成 DSH 能收下的图片块。
 *
 * ## 为什么需要（2026-10-27 真机事故）
 * DSH 的附件准入对**源图**有硬上限（`dsh-attachment-local` 默认值）：
 *   · 单边 ≤ 8192 像素       （IMAGE_DIMENSION_TOO_LARGE）
 *   · 总像素 ≤ 64MP          （IMAGE_TOO_MANY_PIXELS）
 *   · 单张 ≤ 20MB            （IMAGE_TOO_LARGE）
 * 手机长截图（1080×10000 这种）第一道就过不去，DSH 回
 * `session/attachment-invalid`；桥接原来把这个错也当成「模型不支持图片输入」，
 * 于是下一轮直接给模型一句「当前模型不支持图片输入」——图片根本没送到。
 *
 * ## 这里的做法
 * 1. 只读文件头拿尺寸（PNG/JPEG/WebP/GIF），不为了「看看多大」去解码整张图；
 * 2. 在源图上限内就原样透传（DSH 自己会按 4MP 归一化，不用我们重复压缩）；
 * 3. 超了就解码 → 按「长边切条」切成每张都安全的小图（相邻条留 64px 重叠，
 *    避免一行字被切两半），输出 PNG；
 * 4. 实在没法处理（格式不支持、解码失败、切完还太多）→ 抛 {@link ImagePrepError}，
 *    由调用方给用户一句准确的话：「图片太长/太大，请拆分后发送」。
 *
 * 零 npm 依赖：解码用本仓库的 png-codec / jpeg-decode，压缩用 node:zlib。
 */

import { decodePng, encodePng, isPng, readPngSize } from './png-codec.mjs'
import { decodeJpeg, isJpeg, readJpegSize } from './jpeg-decode.mjs'
import { isWebp, readWebpSize, isGif, readGifSize } from './image-size.mjs'

/** 与 DSH `dsh-attachment-local` 的默认准入上限对齐（源图）。 */
export const DSH_IMAGE_LIMITS = Object.freeze({
  maxDimension: 8192,
  maxPixels: 64 * 1024 * 1024,
  maxBytes: 20 * 1024 * 1024,
  /** 归一化后的像素预算（超过会被 DSH 自动缩小，这里只用于选切条尺寸）。 */
  normalizedPixels: 4 * 1024 * 1024,
  /** 一条消息最多几张图（DSH 默认 20；桥接自己还有 4 张入站上限）。 */
  maxImagesPerMessage: 20,
})

/** 单张长截图最多切成几条（再多模型也看不过来，还挤上下文）。 */
export const MAX_TILES = 6
/** 切条目标高度：1080 宽的截图 3000 高 ≈ 3.2MP，落在 4MP 预算内，文字仍清楚。 */
export const TILE_TARGET_HEIGHT = 3000
/** 相邻两条的重叠像素：防止一行字正好被切在缝上。 */
export const TILE_OVERLAP = 64
/** 过度缩放会让字糊成一片，低于这个比例就认输（让用户拆图）。 */
export const MIN_READABLE_SCALE = 0.45
/**
 * 解码前的像素上限：再大就不解了。
 * 解码后是 RGBA 缓冲（4 字节/像素），80MP ≈ 320MB —— 桥接跑在 DSH 的 Node 里，
 * 超过这个数直接给「请拆分」，别把宿主内存打爆。
 */
export const MAX_DECODE_PIXELS = 80_000_000

/** 处理失败时给调用方的结构化原因（调用方据此说人话）。 */
export class ImagePrepError extends Error {
  /**
   * @param {'TOO_LONG'|'UNSUPPORTED_FORMAT'|'DECODE_FAILED'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'ImagePrepError'
    this.code = code
  }
}

/**
 * 只读文件头识别尺寸。
 * @param {Buffer} buffer
 * @param {string} [declaredType]
 * @returns {{mediaType:string,width:number,height:number}|null}
 */
export function readImageInfo(buffer, declaredType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null
  const declared = String(declaredType ?? '').toLowerCase().trim()
  if (isPng(buffer) || declared === 'image/png') {
    const size = readPngSize(buffer)
    return size ? { mediaType: 'image/png', ...size } : null
  }
  if (isJpeg(buffer) || declared === 'image/jpeg') {
    const size = readJpegSize(buffer)
    return size ? { mediaType: 'image/jpeg', ...size } : null
  }
  if (isGif(buffer) || declared === 'image/gif') {
    const size = readGifSize(buffer)
    return size ? { mediaType: 'image/gif', ...size } : null
  }
  if (isWebp(buffer) || declared === 'image/webp') {
    const size = readWebpSize(buffer)
    return size ? { mediaType: 'image/webp', ...size } : null
  }
  return null
}

/**
 * 判断一张图是否需要预处理。
 * @param {{width:number,height:number}} size
 * @param {number} bytes
 * @param {object} limits
 * @returns {{needsTile:boolean, needsReencode:boolean, needsShrink:boolean}}
 */
export function inspectImageLimits(size, bytes, limits = DSH_IMAGE_LIMITS) {
  const pixels = size.width * size.height
  return {
    needsTile: size.width > limits.maxDimension || size.height > limits.maxDimension || pixels > limits.maxPixels,
    needsReencode: bytes > limits.maxBytes,
    needsShrink: pixels > limits.normalizedPixels,
  }
}

/**
 * 把一张图准备成可以直接塞进 DSH prompt 的 image part 列表。
 *
 * 返回 `{ parts, transformed, width, height, scale, tiles }`：
 *   · `parts[i] = { mediaType, data: Buffer, base64: string, width, height }`
 *   · 未超标时 `transformed=false`，parts 只有一个、字节与原图完全一致。
 *
 * @param {Buffer} buffer
 * @param {string} mediaType
 * @param {object} [options]
 * @returns {{parts:Array<{mediaType:string,data:Buffer,base64:string,width:number,height:number}>, transformed:boolean, width:number, height:number, scale:number, tiles:number}}
 * @throws {ImagePrepError}
 */
export function prepareImageParts(buffer, mediaType, options = {}) {
  const limits = { ...DSH_IMAGE_LIMITS, ...(options.limits ?? {}) }
  const maxTiles = options.maxTiles ?? MAX_TILES
  const info = readImageInfo(buffer, mediaType)
  if (!info) {
    // 认不出尺寸（测试桩/冷门格式）：别自作主张，原样透传，让 DSH 自己判。
    return {
      parts: [{ mediaType, data: buffer, base64: buffer.toString('base64'), width: 0, height: 0 }],
      transformed: false,
      width: 0,
      height: 0,
      scale: 1,
      tiles: 1,
    }
  }
  const { needsTile, needsReencode } = inspectImageLimits(info, buffer.length, limits)
  if (!needsTile && !needsReencode) {
    return {
      parts: [{ mediaType, data: buffer, base64: buffer.toString('base64'), width: info.width, height: info.height }],
      transformed: false,
      width: info.width,
      height: info.height,
      scale: 1,
      tiles: 1,
    }
  }

  if (info.width * info.height > MAX_DECODE_PIXELS) {
    throw new ImagePrepError('TOO_LONG', `图片像素太多（${info.width}x${info.height}），解码会拖垮桥接`)
  }
  const decoded = decodeAny(buffer, info.mediaType)
  const { width, height, data } = decoded

  if (!needsTile) {
    // 只是文件太大：缩到 DSH 的归一化预算内再编码一次 PNG，体积通常能降一个量级。
    const target = fitWithin(width, height, limits.normalizedPixels)
    const scaled = scaleImage({ width, height, data }, target.width, target.height)
    const png = encodePng(scaled, { alpha: hasAlpha(scaled.data) })
    if (png.length > limits.maxBytes) throw new ImagePrepError('TOO_LONG', '图片重新编码后仍然过大')
    return {
      parts: [{ mediaType: 'image/png', data: png, base64: png.toString('base64'), width: scaled.width, height: scaled.height }],
      transformed: true,
      width,
      height,
      scale: target.width / width,
      tiles: 1,
    }
  }

  const plan = planTiles(width, height, limits, maxTiles)
  if (!plan) throw new ImagePrepError('TOO_LONG', '图片过长，切分后仍然超出范围')
  const source = plan.scale === 1 ? { width, height, data } : scaleImage({ width, height, data }, plan.width, plan.height)
  const parts = []
  for (const range of plan.ranges) {
    const tile = cropImage(source, plan.axis, range.start, range.end)
    const png = encodePng(tile, { alpha: hasAlpha(tile.data) })
    if (png.length > limits.maxBytes) throw new ImagePrepError('TOO_LONG', '图片切分后单片仍然过大')
    parts.push({
      mediaType: 'image/png',
      data: png,
      base64: png.toString('base64'),
      width: tile.width,
      height: tile.height,
    })
  }
  if (parts.length > limits.maxImagesPerMessage) {
    throw new ImagePrepError('TOO_LONG', '图片切分后张数超出单条消息上限')
  }
  return {
    parts,
    transformed: true,
    width,
    height,
    scale: plan.scale,
    tiles: parts.length,
  }
}

/**
 * 解码成 RGBA。
 * @param {Buffer} buffer
 * @param {string} mediaType
 * @returns {{width:number,height:number,data:Uint8Array}}
 */
function decodeAny(buffer, mediaType) {
  try {
    if (mediaType === 'image/png' || isPng(buffer)) return decodePng(buffer)
    if (mediaType === 'image/jpeg' || isJpeg(buffer)) return decodeJpeg(buffer)
  } catch (error) {
    throw new ImagePrepError('DECODE_FAILED', `图片解码失败：${error?.message ?? error}`)
  }
  throw new ImagePrepError('UNSUPPORTED_FORMAT', `暂不支持把 ${mediaType || '该格式'} 压缩成长图切片`)
}

/** 等比缩到像素预算内。 */
export function fitWithin(width, height, maxPixels) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * 规划切条方案：沿长边切，每片都落在单边/像素预算内，最多 maxTiles 片。
 * 片数太多就先整体等比缩小，直到片数够用；缩到看不清就返回 null。
 *
 * @returns {{axis:'y'|'x', scale:number, width:number, height:number, ranges:Array<{start:number,end:number}>}|null}
 */
export function planTiles(width, height, limits = DSH_IMAGE_LIMITS, maxTiles = MAX_TILES) {
  const axis = height >= width ? 'y' : 'x'
  const longSide = axis === 'y' ? height : width
  const shortSide = axis === 'y' ? width : height
  if (shortSide > limits.maxDimension) return null
  // 每片长边上限：既要 ≤ 8192，也要让「短边 × 片高」落在 4MP 归一化预算内。
  const byBudget = Math.floor(limits.normalizedPixels / Math.max(1, shortSide))
  const tileLong = Math.max(256, Math.min(limits.maxDimension, TILE_TARGET_HEIGHT, byBudget))
  const stepSize = tileLong - TILE_OVERLAP
  const estimate = longSide <= tileLong ? 1 : Math.ceil((longSide - TILE_OVERLAP) / stepSize)
  let scale = 1
  if (estimate > maxTiles) {
    scale = (maxTiles * stepSize + TILE_OVERLAP) / longSide
    if (scale < MIN_READABLE_SCALE) return null
  }
  const scaledWidth = Math.max(1, Math.round(width * scale))
  const scaledHeight = Math.max(1, Math.round(height * scale))
  const scaledLong = axis === 'y' ? scaledHeight : scaledWidth
  const scaledShort = axis === 'y' ? scaledWidth : scaledHeight
  const tileLongFinal = Math.max(256, Math.min(limits.maxDimension, TILE_TARGET_HEIGHT, Math.floor(limits.normalizedPixels / Math.max(1, scaledShort))))
  const step = tileLongFinal - TILE_OVERLAP
  const ranges = []
  for (let start = 0; start < scaledLong && ranges.length < maxTiles; start += step) {
    const end = Math.min(scaledLong, start + tileLongFinal)
    ranges.push({ start, end })
    if (end >= scaledLong) break
  }
  if (ranges.length > maxTiles) return null
  const last = ranges[ranges.length - 1]
  if (last && last.end < scaledLong) return null
  return { axis, scale, width: scaledWidth, height: scaledHeight, ranges }
}

/** 按轴切出一片（坐标基于 source 自身尺寸）。 */
export function cropImage(source, axis, start, end) {
  const { width, height, data } = source
  const x = axis === 'y' ? 0 : start
  const y = axis === 'y' ? start : 0
  const w = axis === 'y' ? width : end - start
  const h = axis === 'y' ? end - start : height
  const out = new Uint8Array(w * h * 4)
  for (let row = 0; row < h; row++) {
    const srcOffset = ((y + row) * width + x) * 4
    out.set(data.subarray(srcOffset, srcOffset + w * 4), row * w * 4)
  }
  return { width: w, height: h, data: out }
}

/**
 * 面积平均缩放（缩小）/ 双线性（放大）。截图缩小最怕锯齿，面积平均最稳。
 * @param {{width:number,height:number,data:Uint8Array}} source
 * @returns {{width:number,height:number,data:Uint8Array}}
 */
export function scaleImage(source, targetWidth, targetHeight) {
  const { width, height, data } = source
  const tw = Math.max(1, Math.round(targetWidth))
  const th = Math.max(1, Math.round(targetHeight))
  if (tw === width && th === height) return source
  const out = new Uint8Array(tw * th * 4)
  const xRatio = width / tw
  const yRatio = height / th
  for (let ty = 0; ty < th; ty++) {
    const sy0 = Math.floor(ty * yRatio)
    const sy1 = Math.max(sy0 + 1, Math.min(height, Math.ceil((ty + 1) * yRatio)))
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = Math.floor(tx * xRatio)
      const sx1 = Math.max(sx0 + 1, Math.min(width, Math.ceil((tx + 1) * xRatio)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      for (let sy = sy0; sy < sy1; sy++) {
        let offset = (sy * width + sx0) * 4
        for (let sx = sx0; sx < sx1; sx++) {
          r += data[offset]
          g += data[offset + 1]
          b += data[offset + 2]
          a += data[offset + 3]
          offset += 4
          count++
        }
      }
      const o = (ty * tw + tx) * 4
      out[o] = Math.round(r / count)
      out[o + 1] = Math.round(g / count)
      out[o + 2] = Math.round(b / count)
      out[o + 3] = Math.round(a / count)
    }
  }
  return { width: tw, height: th, data: out }
}

/** 是否真的带透明（全是 255 就输出 RGB PNG，省 25% 体积）。 */
export function hasAlpha(data) {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true
  }
  return false
}
