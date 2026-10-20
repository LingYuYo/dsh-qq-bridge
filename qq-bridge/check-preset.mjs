/**
 * 验证：QQ 会话用的 minimal preset 到底暴露哪些工具。
 * 建一个临时会话，读它的工具面，然后归档。
 * 目的：确认"无本地工具"这个安全承诺是真的，而不是从配置推断的。
 */
import { DshClient } from './src/dsh.mjs'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const c = new DshClient({ baseUrl: 'http://127.0.0.1:2852' })
const dir = path.join(os.tmpdir(), 'dsh-qq-preset-check')
fs.mkdirSync(dir, { recursive: true })

const workspaceId = await c.ensureWorkspace(dir, '临时-preset检查')
console.log('workspace:', workspaceId)

for (const preset of ['minimal', 'standard']) {
  const sessionId = await c.createSession(workspaceId, preset)
  // 触发一次请求头，让会话把工具清单落到 request/header 事件里
  try {
    await c.prompt(sessionId, '不要回复任何内容，直接结束')
  } catch (e) { console.log('  prompt 失败:', e.message) }

  // 轮询直到 turnOutline 出现或超时
  const deadline = Date.now() + 90000
  let outline = []
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000))
    outline = await c.turnOutline(sessionId).catch(() => [])
    if (outline.length > 0 && outline.at(-1).response !== undefined) break
  }

  // 从会话事件里取 request/header 的 tools
  let tools = []
  try {
    const page = await c.call('session/page', { sessionId, limit: 200 }).catch(() => null)
    const events = page?.events ?? page?.items ?? []
    for (const e of events) {
      if (e.type === 'request/header' && e.data?.header?.tools) {
        tools = e.data.header.tools.map(t => t.name)
      }
    }
  } catch { /* page 形状未验证，忽略 */ }

  console.log(`\npreset=${preset}  会话=${sessionId}`)
  console.log(`  回复: ${JSON.stringify(outline.at(-1)?.response ?? '')}`)
  console.log(`  工具数: ${tools.length}`)
  if (tools.length) console.log(`  工具: ${tools.join(', ')}`)
  console.log(`  含 bash/pwsh: ${tools.some(t => /bash|pwsh|shell|terminal/i.test(t)) ? '是 ⚠️' : '否'}`)
  console.log(`  含 文件写/edit: ${tools.some(t => /^(write|edit|write_file|edit_file)$/i.test(t)) ? '是 ⚠️' : '否'}`)

  await c.archiveSession(sessionId).catch(e => console.log('  归档失败:', e.message))
}
