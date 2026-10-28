/**
 * GIF / WebP 文件头尺寸解析（零依赖、零解码）。
 *
 * 桥接只靠它判断「这张图是不是超过 DSH 的单边上限」；真正的缩放/切条只对
 * PNG/JPEG 做（聊天里 99% 是这两种），GIF/WebP 超限时老实报「请拆分后发送」。
 */

/** `GIF8` 开头。 */
export function isGif(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 10
    && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38
}

/** GIF 逻辑屏幕尺寸（bytes 6-9，小端）。 */
export function readGifSize(buffer) {
  if (!isGif(buffer)) return null
  const width = buffer.readUInt16LE(6)
  const height = buffer.readUInt16LE(8)
  return width > 0 && height > 0 ? { width, height } : null
}

/** `RIFF....WEBP`。 */
export function isWebp(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 16
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
}

/**
 * WebP 尺寸：VP8（有损）/ VP8L（无损）/ VP8X（扩展）三种头。
 * @returns {{width:number,height:number}|null}
 */
export function readWebpSize(buffer) {
  if (!isWebp(buffer)) return null
  const chunk = buffer.subarray(12, 16).toString('ascii')
  if (chunk === 'VP8 ') {
    // 帧头：3 字节 tag + 3 字节起始码 9D 01 2A，然后 14bit 宽 / 14bit 高
    if (buffer.length < 30) return null
    if (!(buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a)) return null
    const width = buffer.readUInt16LE(26) & 0x3fff
    const height = buffer.readUInt16LE(28) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (chunk === 'VP8L') {
    if (buffer.length < 25 || buffer[20] !== 0x2f) return null
    const bits = buffer.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    if (buffer.length < 30) return null
    const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1
    const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1
    return width > 0 && height > 0 ? { width, height } : null
  }
  return null
}
