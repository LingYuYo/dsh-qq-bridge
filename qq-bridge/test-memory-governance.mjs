/**
 * 记忆治理（回收站 / 备份 / 恢复）的离线用例。
 *
 *   node test-memory-governance.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  TrashStore, createBackup, listBackups, pruneBackups, restoreBackup,
} from './src/memory-governance.mjs'

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memgov-'))

console.log('— 回收站（两阶段删除）—')
await check('写入意图 / 列表 / 按 id 取出 / 过期清理', () => {
  const dir = tmpDir()
  let now = 1_000_000
  const trash = new TrashStore({ dir, now: () => now, ttlMs: 5 * 60 * 1000 })
  trash.load()
  const a = trash.add({ kind: 'l3', label: '群友 123', payload: { key: 'qq:123', text: '喜欢小鱼' } })
  const b = trash.add({ kind: 'l2', chatKey: 'g:1', label: '前情提要', payload: { text: '旧提要' } })
  assert.equal(trash.list().length, 2)
  assert.equal(trash.list()[0].id, b.id, '新条目在前')

  now += 60_000
  const taken = trash.take(a.id)
  assert.equal(taken.payload.text, '喜欢小鱼')
  assert.equal(trash.list().length, 1, '取出后回收站里就没有了')

  // b 的 purgeAt = 1_000_000 + 5min；推进到过期
  now = 1_000_000 + 6 * 60 * 1000
  assert.equal(trash.purgeExpired(), 1, '过期条目要物理清理')
  assert.equal(trash.list().length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

await check('落盘后重新加载；损坏文件重置为空', () => {
  const dir = tmpDir()
  const trash = new TrashStore({ dir, now: () => 2_000_000 })
  trash.load()
  trash.add({ kind: 'l3', label: 'x', payload: { key: 'k', text: 'v' } })
  const reloaded = new TrashStore({ dir, now: () => 2_000_001 })
  reloaded.load()
  assert.equal(reloaded.list().length, 1)

  fs.writeFileSync(path.join(dir, 'memory_trash.json'), '{ 坏了')
  const broken = new TrashStore({ dir, now: () => 2_000_002, logger: { warn() {} } })
  broken.load()
  assert.equal(broken.list().length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log('\n— 备份 —')
await check('创建备份：包含 sessions 与 globalMemory，按天保留', () => {
  const dir = tmpDir()
  const stateFile = path.join(dir, 'sessions.json')
  const memoryFile = path.join(dir, 'global_memory.json')
  fs.writeFileSync(stateFile, JSON.stringify({ sessions: { 'g:1': { name: '群' } } }))
  fs.writeFileSync(memoryFile, JSON.stringify({ items: [{ key: 'qq:1', text: '记忆' }] }))

  const out = createBackup({ dir, stateFile, memoryFile, now: () => new Date(2026, 0, 1, 3, 0, 0).getTime() })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.ok(fs.existsSync(out.file))
  const list = listBackups(dir)
  assert.equal(list.length, 1)
  assert.equal(list[0].name.startsWith('backup-20260101-030000'), true)

  // 造 9 个备份文件，prune 后只留 7 个
  const backupDir = path.join(dir, 'backups')
  for (let i = 0; i < 8; i += 1) {
    fs.writeFileSync(path.join(backupDir, `backup-2026010${i + 1}-030000.json.gz`), 'x')
  }
  pruneBackups(backupDir, 7)
  const names = fs.readdirSync(backupDir).filter((name) => name.endsWith('.json.gz')).sort()
  assert.equal(names.length, 7, names.join(','))
  fs.rmSync(dir, { recursive: true, force: true })
})

await check('恢复备份：先留 .pre-restore，再覆盖两个文件', () => {
  const dir = tmpDir()
  const stateFile = path.join(dir, 'sessions.json')
  const memoryFile = path.join(dir, 'global_memory.json')
  fs.writeFileSync(stateFile, JSON.stringify({ sessions: { 'g:1': { name: '旧' } } }))
  fs.writeFileSync(memoryFile, JSON.stringify({ items: [] }))
  const out = createBackup({ dir, stateFile, memoryFile, now: () => new Date(2026, 0, 2, 3, 0, 0).getTime() })
  assert.equal(out.ok, true)

  // 备份之后再改坏当前文件
  fs.writeFileSync(stateFile, JSON.stringify({ sessions: {} }))
  fs.writeFileSync(memoryFile, JSON.stringify({ items: [{ key: 'bad' }] }))

  const restored = restoreBackup({ dir, file: path.basename(out.file), stateFile, memoryFile })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { sessions: { 'g:1': { name: '旧' } } })
  assert.deepEqual(JSON.parse(fs.readFileSync(memoryFile, 'utf8')), { items: [] })
  const preRestore = fs.readdirSync(dir).filter((name) => name.includes('.pre-restore-'))
  assert.equal(preRestore.length, 2, '两个文件都要留恢复前副本')
  fs.rmSync(dir, { recursive: true, force: true })
})

await check('恢复备份：拒绝路径穿越与不存在的文件', () => {
  const dir = tmpDir()
  const stateFile = path.join(dir, 'sessions.json')
  const memoryFile = path.join(dir, 'global_memory.json')
  assert.equal(restoreBackup({ dir, file: '../../etc/passwd', stateFile, memoryFile }).ok, false)
  assert.equal(restoreBackup({ dir, file: 'backup-20260101-030000.json.gz', stateFile, memoryFile }).ok, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
