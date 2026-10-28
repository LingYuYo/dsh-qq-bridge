/**
 * 跨群特别记忆（L3）的离线用例。
 *
 *   node test-global-memory.mjs
 *
 * 只测纯逻辑与文件行为：不连 QQ、不启 DSH。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  GlobalMemory, mergeMemoryItem, normalizeMemoryItem, searchMemoryItems, tokenize,
} from './src/global-memory.mjs'

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-global-memory-'))
const person = (qq, text, extra = {}) => ({
  kind: 'person', key: `qq:${qq}`, qq, title: `群友${qq}`, text,
  tags: [], scope: { global: true, groups: [] }, confidence: 0.9,
  source: { by: 'manual' }, ...extra,
})

console.log('— 分词 —')
await check('中文二元组 + 英文词，去重', () => {
  const tokens = tokenize('喜欢被叫小鱼，OpenCode Go 也行')
  assert.ok(tokens.includes('喜欢'))
  assert.ok(tokens.includes('小鱼'))
  assert.ok(tokens.includes('opencode'))
  assert.ok(tokens.includes('go'))
  assert.equal(new Set(tokens).size, tokens.length, '不能有重复 token')
  assert.deepEqual(tokenize('   '), [])
})

console.log('\n— 归一化与合并 —')
await check('非法条目丢弃；正文与标签收敛', () => {
  assert.equal(normalizeMemoryItem({ key: '', text: 'x' }), null)
  assert.equal(normalizeMemoryItem({ key: 'k', text: '   ' }), null)
  const item = normalizeMemoryItem({ key: 'k', kind: 'weird', text: 'a'.repeat(900), tags: ['  x ', 'x', 'y'] })
  assert.equal(item.kind, 'fact', '未知 kind 回落 fact')
  assert.equal(item.text.length, 500, '正文截断到 500')
  assert.deepEqual(item.tags, ['x', 'y'])
  assert.equal(item.scope.global, true, '默认全局可见')
})

await check('同 key 合并：标签并集、正文覆盖、置信度取大、创建时间保留', () => {
  const now = 1000
  const a = normalizeMemoryItem({ key: 'qq:1', text: '旧', tags: ['甲'], confidence: 0.5, createdAt: 10 }, now)
  const b = normalizeMemoryItem({ key: 'qq:1', text: '新', tags: ['乙'], confidence: 0.9 }, now)
  const merged = mergeMemoryItem(a, b, now)
  assert.equal(merged.text, '新')
  assert.deepEqual(merged.tags.sort(), ['乙', '甲'].sort())
  assert.equal(merged.confidence, 0.9)
  assert.equal(merged.createdAt, 10, '创建时间不能被覆盖')
  assert.equal(merged.updatedAt, now)
})

console.log('\n— 检索 —')
const now = 1_800_000_000_000
const items = [
  person('2677321941', '喜欢被叫小鱼，讨厌被叫全名。', { tags: ['主人', '称呼'] }),
  {
    kind: 'fact', key: 'fact:hiking', title: '周末爬山', text: '鱼塘群周末常去西山爬山。',
    tags: ['爬山', '西山'], scope: { global: true, groups: [] }, confidence: 0.7, updatedAt: now,
  },
  {
    kind: 'fact', key: 'fact:secret', title: '另一个群的秘密', text: '这事只在秘密花园群说。',
    tags: ['秘密'], scope: { global: false, groups: ['g:111'] }, confidence: 0.9, updatedAt: now,
  },
  {
    kind: 'fact', key: 'fact:expired', title: '过期', text: '旧活动',
    tags: ['活动'], scope: { global: true, groups: [] }, confidence: 0.9, updatedAt: now, expiresAt: now - 1,
  },
].map((item) => normalizeMemoryItem(item, now))

await check('QQ 强命中：同一个人说话一定带上他的跨群记忆', () => {
  const hits = searchMemoryItems(items, { text: '在吗', senderQq: '2677321941', chatKey: 'g:222', now })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].key, 'qq:2677321941')
})

await check('关键词命中：中文二元组能召回 fact', () => {
  const hits = searchMemoryItems(items, { text: '周末去爬山吗', chatKey: 'g:222', now })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].key, 'fact:hiking')
})

await check('不相关就不注入（0 命中 = 0 token）', () => {
  const hits = searchMemoryItems(items, { text: '今天天气不错', chatKey: 'g:222', now })
  assert.equal(hits.length, 0)
})

await check('scope 过滤：非本群且 global=false 的记忆不可见', () => {
  const hits = searchMemoryItems(items, { text: '秘密花园在聊什么', chatKey: 'g:222', now })
  assert.equal(hits.length, 0)
  const own = searchMemoryItems(items, { text: '秘密花园在聊什么', chatKey: 'g:111', now })
  assert.equal(own.length, 1, '本群可见')
})

await check('过期条目不参与检索', () => {
  const hits = searchMemoryItems(items, { text: '旧活动', chatKey: 'g:222', now })
  assert.equal(hits.length, 0)
})

await check('topK 与预算截断', () => {
  const many = Array.from({ length: 10 }, (_, index) => normalizeMemoryItem({
    key: `k${index}`, text: '爬山'.repeat(100), tags: ['爬山'], confidence: 0.5, updatedAt: now,
  }, now))
  const hits = searchMemoryItems(many, { text: '爬山', chatKey: 'g:1', topK: 3, budgetChars: 300, now })
  assert.ok(hits.length <= 3)
  assert.ok(hits.reduce((sum, item) => sum + item.text.length, 0) <= 300)
})

console.log('\n— 文件与清理 —')
await check('upsert / remove / 落盘 / 重新加载', () => {
  const dir = tmpDir()
  const memory = new GlobalMemory({ dir, now: () => now })
  memory.load()
  const saved = memory.upsert(person('123', '喜欢短句'))
  assert.equal(saved.key, 'qq:123')
  memory.upsert(person('123', '喜欢短句和损人', { tags: ['损'] }))
  assert.equal(memory.list().length, 1, '同 key 只保留一条')
  assert.equal(memory.list()[0].text, '喜欢短句和损人')
  memory.save()

  const reloaded = new GlobalMemory({ dir, now: () => now })
  reloaded.load()
  assert.equal(reloaded.list().length, 1)
  assert.equal(reloaded.list()[0].text, '喜欢短句和损人')

  assert.equal(reloaded.remove('qq:123'), 1)
  assert.equal(reloaded.list().length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

await check('损坏的文件备份成 .bak 并以空表启动', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'global_memory.json')
  fs.writeFileSync(file, '{ 这不是 json')
  const warnings = []
  const memory = new GlobalMemory({ dir, now: () => now, logger: { warn: (m) => warnings.push(m) } })
  memory.load()
  assert.deepEqual(memory.list(), [])
  assert.ok(fs.existsSync(`${file}.bak`), '损坏文件要备份')
  assert.equal(warnings.length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

await check('prune：过期删除 + 超量淘汰低命中旧条目', () => {
  const dir = tmpDir()
  const memory = new GlobalMemory({ dir, maxItems: 3, now: () => now })
  memory.load()
  for (let i = 0; i < 5; i += 1) {
    memory.upsert({ key: `k${i}`, text: `条目${i}`, hits: i, updatedAt: now - 1000 + i })
  }
  assert.equal(memory.list().length, 3, '超量要淘汰')
  const keys = memory.list().map((item) => item.key)
  assert.ok(keys.includes('k4'), '命中高的要留下')
  memory.upsert({ key: 'old', text: '过期', expiresAt: now - 1 })
  assert.equal(memory.list().some((item) => item.key === 'old'), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
