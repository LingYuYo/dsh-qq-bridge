/**
 * 沙箱协议（NDJSON / v1）离线测试：分帧、半行、坏帧、超限。
 *
 * 用法：node test-sandbox-protocol.mjs
 */
import assert from 'node:assert/strict'
import {
  PROTOCOL_VERSION, FRAME, ERR, SandboxError, encodeFrame, createLineDecoder,
} from './sandbox/protocol.mjs'

let pass = 0
const fail = []
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail.push(name); console.log(`  ✗ ${name}\n    ${e.message}`) }
}

console.log('沙箱协议：')

check('encodeFrame：一行 JSON + 换行', () => {
  const text = encodeFrame({ v: PROTOCOL_VERSION, type: 'load', id: 'r1' })
  assert.ok(text.endsWith('\n'))
  assert.equal(text.split('\n').length, 2)
  assert.equal(JSON.parse(text).type, 'load')
})

check('解码器：跨 chunk 的半行能拼回完整帧', () => {
  const frames = []
  const decoder = createLineDecoder({ onFrame: (f) => frames.push(f) })
  const line = JSON.stringify({ v: 1, type: 'ready', payload: { pid: 1 } }) + '\n'
  decoder.push(line.slice(0, 7))
  decoder.push(line.slice(7))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].type, 'ready')
})

check('解码器：一次 chunk 里多帧 + CRLF + 空行', () => {
  const frames = []
  const decoder = createLineDecoder({ onFrame: (f) => frames.push(f.type) })
  decoder.push([
    JSON.stringify({ v: 1, type: 'a' }) + '\r\n',
    '',
    JSON.stringify({ v: 1, type: 'b' }) + '\n',
  ].join(''))
  assert.deepEqual(frames, ['a', 'b'])
})

check('坏 JSON → E_PROTOCOL，不抛异常', () => {
  const errors = []
  const decoder = createLineDecoder({ onFrame: () => {}, onError: (e) => errors.push(e) })
  decoder.push('{not json}\n')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, ERR.PROTOCOL)
})

check('版本/type 不合法 → E_PROTOCOL', () => {
  const errors = []
  const decoder = createLineDecoder({ onFrame: () => {}, onError: (e) => errors.push(e) })
  decoder.push(JSON.stringify({ v: 2, type: 'ready' }) + '\n')
  decoder.push(JSON.stringify({ v: 1 }) + '\n')
  assert.equal(errors.length, 2)
  assert.ok(errors.every((e) => e.code === ERR.PROTOCOL))
})

check('单帧超限 → E_FRAME_TOO_LARGE，后续帧仍能解析', () => {
  const frames = []
  const errors = []
  const decoder = createLineDecoder({
    onFrame: (f) => frames.push(f.type),
    onError: (e) => errors.push(e.code),
    maxBytes: 32,
  })
  decoder.push(JSON.stringify({ v: 1, type: 'x'.repeat(64) }) + '\n')
  decoder.push(JSON.stringify({ v: 1, type: 'ok' }) + '\n')
  assert.deepEqual(errors, [ERR.FRAME_TOO_LARGE])
  assert.deepEqual(frames, ['ok'])
})

check('长时间没有换行 → 丢缓冲并报 E_FRAME_TOO_LARGE', () => {
  const errors = []
  const decoder = createLineDecoder({
    onFrame: () => {}, onError: (e) => errors.push(e.code), maxBytes: 8,
  })
  decoder.push('x'.repeat(40))
  assert.equal(errors.length, 1)
  assert.equal(errors[0], ERR.FRAME_TOO_LARGE)
  assert.equal(decoder.pending(), '')
})

check('SandboxError 携带稳定 code', () => {
  const error = new SandboxError(ERR.TIMEOUT, '超时', { detail: 1 })
  assert.equal(error.name, 'SandboxError')
  assert.equal(error.code, ERR.TIMEOUT)
  assert.deepEqual(error.detail, { detail: 1 })
})

check('FRAME 常量稳定（Host/child 共用）', () => {
  assert.equal(FRAME.LOAD, 'load')
  assert.equal(FRAME.RESULT, 'result')
  assert.equal(FRAME.READY, 'ready')
})

console.log(`\n结果：${pass} 通过 / ${fail.length} 失败`)
process.exit(fail.length ? 1 : 0)
