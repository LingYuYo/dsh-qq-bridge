/**
 * 纯 Node 的 JPEG 解码器（零 npm 依赖）。
 *
 * 只为一件事服务：把「高到超过 DSH 附件准入上限（单边 8192）」的长截图
 * 解成像素再切片/缩放。因此实现范围是有意收窄的：
 *   · 8bit、单帧、baseline / extended sequential（SOF0 / SOF1）；
 *   · Huffman（不支持算术编码）、YCbCr 与灰度；
 *   · 重启间隔（DRI/RSTn）、任意采样因子；
 *   · 渐进式 JPEG（SOF2）、CMYK、多帧一律抛错，调用方降级成「请拆分后发送」。
 *
 * 为什么不做渐进式：解码状态机复杂、静默解错的风险高；宁可给一句准确的
 * 「请拆分」也不能把一张花屏图塞给模型。绝大多数手机截图/QQ 转码图是 baseline。
 *
 * 输出 RGBA8888，与 png-codec 共用后续缩放/切条。
 */

const MARKER = {
  SOI: 0xd8,
  EOI: 0xd9,
  SOS: 0xda,
  DQT: 0xdb,
  DRI: 0xdd,
  DHT: 0xc4,
  SOF0: 0xc0,
  SOF1: 0xc1,
  SOF2: 0xc2,
}

/** 是否像 JPEG（FFD8FF）。 */
export function isJpeg(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
}

/**
 * 只读尺寸（扫 SOFn），不解码像素。
 * @returns {{width:number,height:number}|null}
 */
export function readJpegSize(buffer) {
  if (!isJpeg(buffer)) return null
  let pos = 2
  while (pos + 4 <= buffer.length) {
    if (buffer[pos] !== 0xff) { pos++; continue }
    const marker = buffer[pos + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue }
    if (marker === 0xd9) break
    const size = buffer.readUInt16BE(pos + 2)
    if (pos + 2 + size > buffer.length) break
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buffer.readUInt16BE(pos + 5)
      const width = buffer.readUInt16BE(pos + 7)
      if (width > 0 && height > 0) return { width, height }
      return null
    }
    pos += 2 + size
  }
  return null
}

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
])

/** 标准 Huffman 解码表：按码长展开成查找表（bits → values）。 */
function buildHuffmanTable(counts, values) {
  const table = {
    values: Array.from(values),
    maxCode: new Int32Array(17).fill(-1),
    valPtr: new Int32Array(17),
    minCode: new Int32Array(17),
  }
  let code = 0
  let k = 0
  for (let length = 1; length <= 16; length++) {
    const count = counts[length - 1] ?? 0
    table.minCode[length] = code
    table.valPtr[length] = k
    k += count
    code += count
    table.maxCode[length] = count > 0 ? code - 1 : -1
    code <<= 1
  }
  return table
}

class BitReader {
  constructor(buffer, start, end) {
    this.buffer = buffer
    this.pos = start
    this.end = end
    this.bitBuf = 0
    this.bitCount = 0
  }

  /** 读一个字节（处理 0xFF00 填充）；遇到真正的标记返回 -1。 */
  readByte() {
    if (this.pos >= this.end) return -1
    const b = this.buffer[this.pos]
    if (b !== 0xff) {
      this.pos++
      return b
    }
    const next = this.buffer[this.pos + 1]
    if (next === 0x00) {
      this.pos += 2
      return 0xff
    }
    return -1
  }

  ensure(n) {
    while (this.bitCount < n) {
      const b = this.readByte()
      if (b < 0) throw new Error('JPEG 数据提前结束')
      this.bitBuf = (this.bitBuf << 8) | b
      this.bitCount += 8
    }
  }

  readBit() {
    this.ensure(1)
    this.bitCount--
    return (this.bitBuf >> this.bitCount) & 1
  }

  readBits(n) {
    if (n === 0) return 0
    this.ensure(n)
    this.bitCount -= n
    return (this.bitBuf >> this.bitCount) & ((1 << n) - 1)
  }

  /** 对齐到字节边界，把已读入但未消费的整字节回退。 */
  align() {
    this.pos -= this.bitCount >> 3
    this.bitBuf = 0
    this.bitCount = 0
  }

  /** 对齐后消费一个 RSTn。 */
  consumeRestart() {
    this.align()
    if (this.buffer[this.pos] !== 0xff) throw new Error('JPEG 重启标记缺失')
    const marker = this.buffer[this.pos + 1]
    if (marker < 0xd0 || marker > 0xd7) throw new Error('JPEG 重启标记非法')
    this.pos += 2
  }
}

function decodeHuffman(reader, table) {
  let code = 0
  for (let length = 1; length <= 16; length++) {
    code = (code << 1) | reader.readBit()
    if (code >= table.minCode[length] && code <= table.maxCode[length]) {
      return table.values[table.valPtr[length] + code - table.minCode[length]]
    }
  }
  throw new Error('JPEG Huffman 码非法')
}

function extend(value, bits) {
  if (bits === 0) return 0
  const threshold = 1 << (bits - 1)
  return value < threshold ? value - (1 << bits) + 1 : value
}

/**
 * 解码 JPEG。
 * @param {Buffer} buffer
 * @param {{maxPixels?:number}} [options]
 * @returns {{width:number,height:number,data:Uint8Array}}
 */
export function decodeJpeg(buffer, { maxPixels = 120_000_000 } = {}) {
  if (!isJpeg(buffer)) throw new Error('不是 JPEG')
  const quantTables = []
  const huffmanDC = []
  const huffmanAC = []
  let frame = null
  let restartInterval = 0
  let adobeTransform = null
  let scanCount = 0

  let pos = 2
  while (pos + 4 <= buffer.length) {
    if (buffer[pos] !== 0xff) { pos++; continue }
    const marker = buffer[pos + 1]
    if (marker === 0xff) { pos++; continue }
    if (marker === MARKER.SOI || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue }
    if (marker === MARKER.EOI) break
    if (pos + 4 > buffer.length) break
    const size = buffer.readUInt16BE(pos + 2)
    const end = pos + 2 + size
    if (size < 2 || end > buffer.length) break
    const seg = buffer.subarray(pos + 4, end)

    if (marker === MARKER.DQT) {
      let p = 0
      while (p < seg.length) {
        const info = seg[p++]
        const precision = info >> 4
        const id = info & 15
        const table = new Int32Array(64)
        for (let i = 0; i < 64; i++) {
          if (precision === 1) {
            table[i] = seg.readUInt16BE(p)
            p += 2
          } else {
            table[i] = seg[p++]
          }
        }
        // DQT 里的 64 个值是**之字形顺序**；系数按自然顺序存（coeffs[zigzag[k]]），
        // 所以先翻回自然顺序，反量化时才能一一对上。
        const natural = new Int32Array(64)
        for (let i = 0; i < 64; i++) natural[ZIGZAG[i]] = table[i]
        quantTables[id] = natural
      }
      pos = end
      continue
    }

    if (marker === MARKER.DHT) {
      let p = 0
      while (p < seg.length) {
        const info = seg[p++]
        const cls = info >> 4
        const id = info & 15
        const counts = seg.subarray(p, p + 16)
        p += 16
        let total = 0
        for (let i = 0; i < 16; i++) total += counts[i]
        const values = seg.subarray(p, p + total)
        p += total
        const table = buildHuffmanTable(counts, values)
        if (cls === 0) huffmanDC[id] = table
        else huffmanAC[id] = table
      }
      pos = end
      continue
    }

    if (marker === MARKER.DRI) {
      restartInterval = seg.readUInt16BE(0)
      pos = end
      continue
    }

    if (marker === 0xee) {
      // APP14 Adobe：transform 0 = RGB/CMYK，1 = YCbCr，2 = YCCK
      if (seg.length >= 12 && seg.subarray(0, 5).toString('ascii') === 'Adobe') adobeTransform = seg[11]
      pos = end
      continue
    }

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const precision = seg[0]
      const height = seg.readUInt16BE(1)
      const width = seg.readUInt16BE(3)
      const count = seg[5]
      if (precision !== 8) throw new Error(`JPEG 位深不支持（${precision}）`)
      if (marker === MARKER.SOF2) throw new Error('渐进式 JPEG 暂不支持')
      if (marker !== MARKER.SOF0 && marker !== MARKER.SOF1) {
        throw new Error(`JPEG 编码方式不支持（SOF 0x${marker.toString(16)}）`)
      }
      if (!(width > 0) || !(height > 0)) throw new Error('JPEG 尺寸非法')
      if (width * height > maxPixels) throw new Error('JPEG 像素数超过安全上限')
      if (count !== 1 && count !== 3) throw new Error(`JPEG 分量数不支持（${count}）`)
      const components = []
      for (let i = 0; i < count; i++) {
        const id = seg[6 + i * 3]
        const hv = seg[7 + i * 3]
        const tq = seg[8 + i * 3]
        components.push({ id, h: hv >> 4, v: hv & 15, tq })
      }
      const maxH = Math.max(...components.map((c) => c.h))
      const maxV = Math.max(...components.map((c) => c.v))
      const mcusPerLine = Math.ceil(width / (maxH * 8))
      const mcusPerColumn = Math.ceil(height / (maxV * 8))
      for (const c of components) {
        // 注意：块网格要按 **MCU 对齐后的尺寸** 分配，不能按可见像素算。
        // 边缘 MCU 里的「补边块」照样带熵编码数据，跳过它们会让码流错位
        // （2026-10-27 实测：257 高的图就是这么把后半段解成垃圾的）。
        c.blocksPerLine = mcusPerLine * c.h
        c.blocksPerColumn = mcusPerColumn * c.v
        c.coefficients = new Int16Array(c.blocksPerLine * c.blocksPerColumn * 64)
      }
      frame = { width, height, components, maxH, maxV, progressive: false }
      pos = end
      continue
    }

    if (marker === MARKER.SOS) {
      if (!frame) throw new Error('JPEG 缺 SOF')
      scanCount++
      const count = seg[0]
      const scanComponents = []
      for (let i = 0; i < count; i++) {
        const cs = seg[1 + i * 2]
        const tables = seg[2 + i * 2]
        const component = frame.components.find((c) => c.id === cs)
        if (!component) throw new Error('JPEG 扫描引用了不存在的分量')
        scanComponents.push({ component, dc: tables >> 4, ac: tables & 15 })
      }
      const dataStart = end
      pos = decodeScan(buffer, dataStart, {
        frame, scanComponents, huffmanDC, huffmanAC, restartInterval,
      })
      continue
    }

    pos = end
  }

  if (!frame || scanCount === 0) throw new Error('JPEG 没有扫描数据')
  return buildPixels(frame, quantTables, adobeTransform)
}

/** 解码一个 SOS 段之后的熵编码数据，返回下一个标记的位置。 */
function decodeScan(buffer, dataStart, ctx) {
  const { frame, scanComponents, huffmanDC, huffmanAC, restartInterval } = ctx
  // 找扫描区间：从 dataStart 到下一个「真正的标记」（跳过 FF00 与 RSTn）。
  let scanEnd = buffer.length
  for (let i = dataStart; i + 1 < buffer.length; i++) {
    if (buffer[i] !== 0xff) continue
    const next = buffer[i + 1]
    if (next === 0x00) { i++; continue }
    if (next >= 0xd0 && next <= 0xd7) { i++; continue }
    scanEnd = i
    break
  }
  const reader = new BitReader(buffer, dataStart, scanEnd)
  const single = scanComponents.length === 1
  const mcusPerLine = Math.ceil(frame.width / (frame.maxH * 8))
  const mcusPerColumn = Math.ceil(frame.height / (frame.maxV * 8))
  const mcuCount = single
    ? scanComponents[0].component.blocksPerLine * scanComponents[0].component.blocksPerColumn
    : mcusPerLine * mcusPerColumn
  const dcPred = scanComponents.map(() => 0)

  const decodeBlock = (component, blockIndex, componentIndex) => {
    const coeffs = component.coefficients
    const base = blockIndex * 64
    const dcTable = huffmanDC[scanComponents[componentIndex].dc]
    if (!dcTable) throw new Error('JPEG 缺 DC Huffman 表')
    const t = decodeHuffman(reader, dcTable)
    const diff = t === 0 ? 0 : extend(reader.readBits(t), t)
    dcPred[componentIndex] += diff
    coeffs[base] = dcPred[componentIndex]
    const acTable = huffmanAC[scanComponents[componentIndex].ac]
    if (!acTable) throw new Error('JPEG 缺 AC Huffman 表')
    let k = 1
    while (k < 64) {
      const rs = decodeHuffman(reader, acTable)
      const r = rs >> 4
      const s = rs & 15
      if (s === 0) {
        if (r !== 15) break
        k += 16
        continue
      }
      k += r
      if (k > 63) break
      coeffs[base + ZIGZAG[k]] = extend(reader.readBits(s), s)
      k++
    }
  }

  for (let mcu = 0; mcu < mcuCount; mcu++) {
    if (restartInterval > 0 && mcu > 0 && mcu % restartInterval === 0) {
      reader.consumeRestart()
      for (let i = 0; i < dcPred.length; i++) dcPred[i] = 0
    }
    if (single) {
      decodeBlock(scanComponents[0].component, mcu, 0)
      continue
    }
    const mcuX = mcu % mcusPerLine
    const mcuY = Math.floor(mcu / mcusPerLine)
    for (let ci = 0; ci < scanComponents.length; ci++) {
      const { component } = scanComponents[ci]
      for (let v = 0; v < component.v; v++) {
        for (let h = 0; h < component.h; h++) {
          const bx = mcuX * component.h + h
          const by = mcuY * component.v + v
          decodeBlock(component, by * component.blocksPerLine + bx, ci)
        }
      }
    }
  }
  reader.align()
  return reader.pos
}

/* ── 反量化 + IDCT + 上采样 ─────────────────────────────────────────── */

const IDCT_COS = (() => {
  const table = new Float64Array(64)
  for (let x = 0; x < 8; x++) {
    for (let u = 0; u < 8; u++) {
      const cu = u === 0 ? Math.SQRT1_2 : 1
      table[x * 8 + u] = (cu / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)
    }
  }
  return table
})()

function inverseDct(block, quant, output, outStride, outOffset) {
  const tmp = new Float32Array(64)
  for (let i = 0; i < 64; i++) tmp[i] = block[i] * (quant ? quant[i] : 1)
  const rows = new Float32Array(64)
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0
      for (let u = 0; u < 8; u++) sum += IDCT_COS[x * 8 + u] * tmp[y * 8 + u]
      rows[y * 8 + x] = sum
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0
      for (let v = 0; v < 8; v++) sum += IDCT_COS[y * 8 + v] * rows[v * 8 + x]
      const value = Math.max(0, Math.min(255, Math.round(sum + 128)))
      output[outOffset + y * outStride + x] = value
    }
  }
}

function buildPixels(frame, quantTables, adobeTransform) {
  const { width, height, components, maxH, maxV } = frame
  const planes = []
  for (const component of components) {
    const planeW = component.blocksPerLine * 8
    const planeH = component.blocksPerColumn * 8
    const plane = new Uint8Array(planeW * planeH)
    const quant = quantTables[component.tq]
    if (!quant) throw new Error('JPEG 缺量化表')
    for (let by = 0; by < component.blocksPerColumn; by++) {
      for (let bx = 0; bx < component.blocksPerLine; bx++) {
        const blockIndex = by * component.blocksPerLine + bx
        const block = component.coefficients.subarray(blockIndex * 64, blockIndex * 64 + 64)
        inverseDct(block, quant, plane, planeW, by * 8 * planeW + bx * 8)
      }
    }
    planes.push({ width: planeW, height: planeH, data: plane, h: component.h, v: component.v })
  }

  const out = new Uint8Array(width * height * 4)
  const sample = (plane, x, y) => {
    const sx = Math.min(plane.width - 1, Math.floor((x * plane.h) / maxH))
    const sy = Math.min(plane.height - 1, Math.floor((y * plane.v) / maxV))
    return plane.data[sy * plane.width + sx]
  }
  if (planes.length === 1) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = sample(planes[0], x, y)
        const o = (y * width + x) * 4
        out[o] = out[o + 1] = out[o + 2] = v
        out[o + 3] = 255
      }
    }
    return { width, height, data: out, planes }
  }

  const rgbDirect = adobeTransform === 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (rgbDirect) {
        out[o] = sample(planes[0], x, y)
        out[o + 1] = sample(planes[1], x, y)
        out[o + 2] = sample(planes[2], x, y)
      } else {
        const yv = sample(planes[0], x, y)
        const cb = sample(planes[1], x, y) - 128
        const cr = sample(planes[2], x, y) - 128
        out[o] = clamp8(yv + 1.402 * cr)
        out[o + 1] = clamp8(yv - 0.344136 * cb - 0.714136 * cr)
        out[o + 2] = clamp8(yv + 1.772 * cb)
      }
      out[o + 3] = 255
    }
  }
  return { width, height, data: out, planes }
}

function clamp8(value) {
  const v = Math.round(value)
  return v < 0 ? 0 : v > 255 ? 255 : v
}
