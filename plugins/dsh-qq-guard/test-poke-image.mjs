/**
 * 戳一戳表情图上传 / 回读路由（2026-10-27，离线）。
 *
 * 锁死的约定：
 *   ① 只认 PNG / GIF / JPEG / WebP，类型按**魔数**判，不信文件名与 content-type；
 *   ② 上传上限 5MB，超了 413；空 body 400；非图片 415；
 *   ③ 回读只接受 `<sha1>.<ext>` 形状的文件名（杜绝望目录穿越）；
 *   ④ 跨站请求 403（上传会写本机磁盘）；
 *   ⑤ 文件名 = 内容 sha1，同一张图重复上传只落一份；
 *   ⑥ 孤儿清理只删「没被配置引用 + 超过 24 小时」的文件。
 *
 * 全部离线：用 QQG_POKE_IMAGE_DIR 把存储目录指到临时目录，不碰真实 ~/.dsh。
 * 运行：node plugins/dsh-qq-guard/test-poke-image.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqg-poke-img-'))
process.env.QQG_POKE_IMAGE_DIR = TMP_DIR

let pass = 0
let fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

function resolveSchemastery() {
  if (process.env.QQG_SCHEMASTERY) return process.env.QQG_SCHEMASTERY
  const candidates = [
    path.join(HERE, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
    path.resolve(HERE, '../../node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
  ]
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  console.error('找不到 @deepseek-ai/schemastery；请设 QQG_SCHEMASTERY 指向它的 lib/index.mjs')
  process.exit(2)
}

const SRC = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')
const patched = SRC.replace(
  /^import Schema from '@deepseek-ai\/schemastery'$/m,
  `import Schema from ${JSON.stringify('file:///' + resolveSchemastery().replace(/\\/g, '/'))}`,
)
const tmpFile = path.join(HERE, `.tmp-poke-image-${process.pid}.mjs`)
fs.writeFileSync(tmpFile, patched)
let mod
try {
  mod = await import('file:///' + tmpFile.replace(/\\/g, '/'))
} finally {
  try { fs.unlinkSync(tmpFile) } catch { /* 忽略 */ }
}

const { handlePokeImageRoute, sniffPokeImage, cleanupOrphanPokeImages, pokeImageDir } = mod

/** 最小合法图片字节（只要魔数对，路由不解析像素）。 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3])
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8, 0)])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBPVP8 '), Buffer.alloc(6, 0)])

function makeReq({ method = 'POST', url = '/dsh-qq-guard/poke-image', body = Buffer.alloc(0), site = 'same-origin' } = {}) {
  const req = Readable.from(body.length > 0 ? [body] : [])
  req.method = method
  req.url = url
  req.headers = site === null ? {} : { 'sec-fetch-site': site }
  return req
}

function makeRes() {
  const out = { status: 0, headers: null, chunks: [] }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(chunk) { if (chunk) out.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))) },
    get body() { return Buffer.concat(out.chunks) },
  }
}

async function call(opts) {
  const res = makeRes()
  await handlePokeImageRoute(makeReq(opts), res)
  return res
}

const json = (res) => JSON.parse(res.body.toString('utf8'))

console.log('戳一戳表情图：')

await check('pokeImageDir 被测试环境指到临时目录', () => {
  assert.equal(path.resolve(pokeImageDir()), path.resolve(TMP_DIR))
})

await check('魔数识别：PNG / GIF / JPEG / WebP 都能认出来', () => {
  assert.equal(sniffPokeImage(PNG).mime, 'image/png')
  assert.equal(sniffPokeImage(GIF).mime, 'image/gif')
  assert.equal(sniffPokeImage(JPG).mime, 'image/jpeg')
  assert.equal(sniffPokeImage(WEBP).mime, 'image/webp')
})

await check('魔数识别：文本 / 空 buffer 一律拒绝', () => {
  assert.equal(sniffPokeImage(Buffer.from('hello')), null)
  assert.equal(sniffPokeImage(Buffer.alloc(0)), null)
})

await check('上传 PNG → 200，落盘文件名是 sha1.png', async () => {
  const res = await call({ body: PNG })
  assert.equal(res.out.status, 200, res.body.toString())
  const body = json(res)
  assert.equal(body.ok, true)
  assert.ok(/^[a-f0-9]{40}\.png$/u.test(body.name), `文件名不对：${body.name}`)
  assert.equal(fs.existsSync(body.path), true)
  assert.deepEqual(fs.readFileSync(body.path), PNG)
})

await check('同一张图重复上传 → 文件名相同（内容寻址去重）', async () => {
  const first = json(await call({ body: PNG }))
  const second = json(await call({ body: PNG }))
  assert.equal(first.name, second.name)
})

await check('上传 GIF / JPEG / WebP → 扩展名跟着魔数走', async () => {
  assert.match(json(await call({ body: GIF })).name, /\.gif$/u)
  assert.match(json(await call({ body: JPG })).name, /\.jpg$/u)
  assert.match(json(await call({ body: WEBP })).name, /\.webp$/u)
})

await check('上传非图片 → 415', async () => {
  const res = await call({ body: Buffer.from('not an image at all') })
  assert.equal(res.out.status, 415)
})

await check('空 body → 400', async () => {
  const res = await call({ body: Buffer.alloc(0) })
  assert.equal(res.out.status, 400)
})

await check('超过 5MB → 413', async () => {
  const big = Buffer.alloc(5 * 1024 * 1024 + 16, 0x89)
  let status = 0
  // readRawBody 会在超限时 reject 并 destroy，handler 抛出的错误由调用方转成 413。
  try {
    const res = await call({ body: big })
    status = res.out.status
  } catch (e) {
    status = e?.statusCode ?? 0
  }
  assert.equal(status, 413)
})

await check('跨站 POST → 403', async () => {
  const res = await call({ body: PNG, site: 'cross-site' })
  assert.equal(res.out.status, 403)
})

await check('回读：合法名 + 存在 → 200 且 content-type 正确', async () => {
  const uploaded = json(await call({ body: PNG }))
  const res = await call({ method: 'GET', url: `/dsh-qq-guard/poke-image?name=${uploaded.name}` })
  assert.equal(res.out.status, 200)
  assert.equal(res.out.headers['content-type'], 'image/png')
  assert.deepEqual(res.body, PNG)
})

await check('回读：非法文件名（目录穿越）→ 400', async () => {
  for (const bad of ['../config.json', '..%2F..%2Fconfig.json', 'X.png', 'a'.repeat(40) + '.exe']) {
    const res = await call({ method: 'GET', url: `/dsh-qq-guard/poke-image?name=${encodeURIComponent(bad)}` })
    assert.equal(res.out.status, 400, `${bad} 应被拒`)
  }
})

await check('回读：合法名但文件不存在 → 404', async () => {
  const res = await call({ method: 'GET', url: `/dsh-qq-guard/poke-image?name=${'0'.repeat(40)}.png` })
  assert.equal(res.out.status, 404)
})

await check('不支持的 method → 405', async () => {
  const res = await call({ method: 'PUT', body: PNG })
  assert.equal(res.out.status, 405)
})

await check('孤儿清理：只删「没被引用 + 超过 24h」的文件', async () => {
  const dir = pokeImageDir()
  fs.mkdirSync(dir, { recursive: true })
  const oldOrphan = path.join(dir, `${'a'.repeat(40)}.png`)
  const freshOrphan = path.join(dir, `${'b'.repeat(40)}.png`)
  const referenced = path.join(dir, `${'c'.repeat(40)}.png`)
  for (const file of [oldOrphan, freshOrphan, referenced]) fs.writeFileSync(file, PNG)
  const twoDaysAgo = (Date.now() - 48 * 60 * 60 * 1000) / 1000
  fs.utimesSync(oldOrphan, twoDaysAgo, twoDaysAgo)

  const config = { poke: { replies: [{ text: 'x', image: referenced }] } }
  const result = await cleanupOrphanPokeImages(config)
  assert.equal(result.removed, 1, `应只删 1 个，实际 ${result.removed}`)
  assert.equal(fs.existsSync(oldOrphan), false)
  assert.equal(fs.existsSync(freshOrphan), true, '24h 内的孤儿不能删（用户可能还没保存）')
  assert.equal(fs.existsSync(referenced), true, '被引用的文件不能删')
})

fs.rmSync(TMP_DIR, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
