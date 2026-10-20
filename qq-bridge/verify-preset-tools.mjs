/**
 * 确凿验证：minimal preset 的会话在 Windows 上到底拿到哪些工具。
 * 做法：先订阅 session/follow，再 prompt，从 request/header 事件里读 tools 清单。
 * （bridge-recon 实测发现"先 open 再 prompt"才收得到事件帧。）
 */
import { DshClient } from './src/dsh.mjs'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createHmac, createHash } from 'node:crypto'
import { readBrowserSessionSecret, mintCookie } from './src/dsh.mjs'

const BASE = 'http://127.0.0.1:2852'
const c = new DshClient({ baseUrl: BASE })
const dir = path.join(os.tmpdir(), 'dsh-qq-preset-tools')
fs.mkdirSync(dir, { recursive: true })

const cookie = mintCookie(BASE, readBrowserSessionSecret())
const authority = new URL(BASE).host

const workspaceId = await c.ensureWorkspace(dir, '临时-工具面验证')
const sessionId = await c.createSession(workspaceId, process.argv[2] || 'qq-chat')
console.log('preset =', process.argv[2] || 'qq-chat', '| session =', sessionId)

// 先开 WS 订阅，再投递
const events = []
const ws = new WebSocket(`ws://${authority}/api/remote.mux`, { headers: { cookie } })
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data) } catch { return }
  const v = m?.value
  if (v?.type === 'session/event' && v.sessionId === sessionId) events.push(v.event)
  if (m?.type === 'error') console.log('  stream err:', m.error?.code)
})
await new Promise((res) => {
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      type: 'open', streamId: 'follow-x', endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 100 } } },
    }))
    setTimeout(res, 1200)
  })
})

await c.prompt(sessionId, '不要调用任何工具，只回复两个字：好的')

// 等 request/header 与最终回复
const deadline = Date.now() + 120000
let header = null
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000))
  header = events.find((e) => e.type === 'request/header') ?? header
  const done = events.some((e) => e.type === 'turn/end')
  if (header && done) break
}
ws.close()

const tools = header?.data?.header?.tools?.map((t) => t.name) ?? []
console.log('\n=== 工具清单（来自 request/header 实测）===')
console.log('工具数:', tools.length)
console.log(tools.length ? tools.join('\n  ') : '（未捕获到 request/header）')

const shellish = tools.filter((t) => /bash|pwsh|shell|terminal/i.test(t))
const fsish = tools.filter((t) => /^(read|write|edit|read_image|write_file|edit_file)$/i.test(t))
console.log('\n=== 判定 ===')
console.log('shell 类工具:', shellish.length ? `⚠️ ${shellish.join(', ')}` : '无')
console.log('文件类工具:', fsish.length ? `⚠️ ${fsish.join(', ')}` : '无')
console.log(`结论：${shellish.length === 0 && fsish.length === 0 ? '✅ 无本地工具，安全' : '❌ 存在本地工具，不可直接用于 QQ'}`)

try { await c.call('session/cancel', { sessionId }) } catch {}
await new Promise((r) => setTimeout(r, 2500))
await c.archiveSession(sessionId).catch((e) => console.log('归档:', e.message.slice(0, 90)))
console.log('已清理会话')
