/**
 * 纯 Node 的 PNG 编解码（零 npm 依赖，只用 node:zlib）。
 *
 * 为什么桥接需要它：DSH 的附件准入对**源图**有硬上限（单边 ≤ 8192 像素、
 * ≤ 64MP、≤ 20MB），超了直接 `session/attachment-invalid`，长截图就是这么被
 * 挡在门外的。手机截图基本是 PNG，所以先在桥接层把它切成「每张都在安全范围内」
 * 的竖条，模型才能真正看到内容。
 *
 * 支持范围（够聊天截图用，不求做通用解码器）：
 *   · 非隔行（interlace=0）；
 *   · 位深 1/2/4/8/16（<8 只对灰度/调色板合法，16 取高字节）；
 *   · 颜色类型 0/2/3/4/6（灰 / RGB / 调色板 / 灰+α / RGBA）；
 *   · 输出统一 RGBA8888，方便和 JPEG 解码共用后续缩放/切片。
 * 隔行 PNG（Adam7）极少见，直接抛错，调用方降级成「请拆分后发送」。
 */

import zlib from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 是否为 PNG（只看 8 字节签名）。 */
export function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)
}

/** 读 IHDR：`{ width, height }`；非 PNG / 截断返回 null。 */
export function readPngSize(buffer) {
  if (!isPng(buffer) || buffer.length < 24) return null
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (!(width > 0) || !(height > 0)) return null
  return { width, height }
}

/* ── CRC32（PNG 每个 chunk 都要）──────────────────────────────────────── */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 解码 PNG 成 RGBA8888。
 * @param {Buffer} buffer
 * @returns {{width:number,height:number,data:Uint8Array}} data 长度 = w*h*4
 */
export function decodePng(buffer) {
  if (!isPng(buffer)) throw new Error('不是 PNG')
  let offset = 8
  let header = null
  let palette = null
  const idat = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const start = offset + 8
    const end = start + length
    if (end + 4 > buffer.length) throw new Error('PNG chunk 截断')
    const data = buffer.subarray(start, end)
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      }
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset = end + 4
  }
  if (!header) throw new Error('PNG 缺 IHDR')
  const { width, height, bitDepth, colorType, interlace } = header
  if (header.compression !== 0 || header.filter !== 0) throw new Error('PNG 压缩/滤波方式不支持')
  if (interlace !== 0) throw new Error('隔行 PNG 暂不支持')
  const channels = colorType === 0 ? 1
    : colorType === 2 ? 3
      : colorType === 3 ? 1
        : colorType === 4 ? 2
          : colorType === 6 ? 4 : 0
  if (channels === 0) throw new Error(`PNG 颜色类型不支持（${colorType}）`)
  if (colorType === 3 && !palette) throw new Error('PNG 调色板缺失')

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bitsPerPixel = channels * bitDepth
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8))
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const expected = height * (stride + 1)
  if (raw.length < expected) throw new Error('PNG 像素数据截断')

  const recon = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const dst = recon.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? recon.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? dst[x - bpp] : 0
      const up = prev ? prev[x] : 0
      const upLeft = prev && x >= bpp ? prev[x - bpp] : 0
      let value = src[x]
      if (filter === 1) value = value + left
      else if (filter === 2) value = value + up
      else if (filter === 3) value = value + ((left + up) >> 1)
      else if (filter === 4) value = value + paeth(left, up, upLeft)
      else if (filter !== 0) throw new Error(`PNG 行滤波类型不支持（${filter}）`)
      dst[x] = value & 0xff
    }
  }

  const out = new Uint8Array(width * height * 4)
  const maxVal = (1 << bitDepth) - 1
  const readSample = (row, index) => {
    if (bitDepth === 8) return recon[row * stride + index]
    if (bitDepth === 16) return recon[row * stride + index * 2]
    // 1/2/4 bit：按位取（只对灰度/调色板出现）
    const perByte = 8 / bitDepth
    const byte = recon[row * stride + Math.floor(index / perByte)]
    const shift = 8 - bitDepth * ((index % perByte) + 1)
    return (byte >> shift) & maxVal
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (colorType === 3) {
        const index = readSample(y, x)
        const p = index * 3
        out[o] = palette[p] ?? 0
        out[o + 1] = palette[p + 1] ?? 0
        out[o + 2] = palette[p + 2] ?? 0
        out[o + 3] = 255
      } else if (colorType === 0) {
        const value = bitDepth === 16 ? readSample(y, x * 2) : readSample(y, x)
        const scale = bitDepth < 8 ? Math.round((value * 255) / maxVal) : value
        out[o] = out[o + 1] = out[o + 2] = scale
        out[o + 3] = 255
      } else if (colorType === 4) {
        const i = bitDepth === 16 ? x * 4 : x * 2
        const gray = readSample(y, i)
        out[o] = out[o + 1] = out[o + 2] = gray
        out[o + 3] = readSample(y, i + (bitDepth === 16 ? 2 : 1))
      } else if (colorType === 2) {
        const i = bitDepth === 16 ? x * 6 : x * 3
        out[o] = readSample(y, i)
        out[o + 1] = readSample(y, i + (bitDepth === 16 ? 2 : 1))
        out[o + 2] = readSample(y, i + (bitDepth === 16 ? 4 : 2))
        out[o + 3] = 255
      } else {
        const i = bitDepth === 16 ? x * 8 : x * 4
        out[o] = readSample(y, i)
        out[o + 1] = readSample(y, i + (bitDepth === 16 ? 2 : 1))
        out[o + 2] = readSample(y, i + (bitDepth === 16 ? 4 : 2))
        out[o + 3] = readSample(y, i + (bitDepth === 16 ? 6 : 3))
      }
    }
  }
  return { width, height, data: out }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * 把 RGBA8888 编码成 PNG。
 * @param {{width:number,height:number,data:Uint8Array}} image
 * @param {{alpha?:boolean}} [options] alpha=false → 输出 RGB（体积小 25%）
 * @returns {Buffer}
 */
export function encodePng({ width, height, data }, { alpha = true } = {}) {
  if (!(width > 0) || !(height > 0)) throw new Error('PNG 尺寸非法')
  const channels = alpha ? 4 : 3
  const stride = width * channels
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0 // filter: None（截图线条多，None + deflate 已经够）
    const src = y * width * 4
    const dst = rowStart + 1
    if (alpha) {
      for (let x = 0; x < width; x++) {
        raw[dst + x * 4] = data[src + x * 4]
        raw[dst + x * 4 + 1] = data[src + x * 4 + 1]
        raw[dst + x * 4 + 2] = data[src + x * 4 + 2]
        raw[dst + x * 4 + 3] = data[src + x * 4 + 3]
      }
    } else {
      for (let x = 0; x < width; x++) {
        raw[dst + x * 3] = data[src + x * 4]
        raw[dst + x * 3 + 1] = data[src + x * 4 + 1]
        raw[dst + x * 3 + 2] = data[src + x * 4 + 2]
      }
    }
  }
  const idat = zlib.deflateSync(raw, { level: 6 })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = alpha ? 6 : 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])), 0)
  return Buffer.concat([head, data, crc])
}
