#!/usr/bin/env node
/**
 * 历史脏标题批量修正（CLI）。
 *
 * 背景：早期会话的标题是 DSH 的标题 LLM 生成的（实测出现过单字「向」），
 * 桥接现在会在建会话/接管时强制命名，但**已经存在的历史会话不会自动改**。
 * 这个脚本把「桥接映射表里的会话」按 `私聊-昵称 / 群聊-群名(群号)` 批量对齐。
 *
 * 用法：
 *   node tools/rename-sessions.mjs               # 预演（默认，只打印计划）
 *   node tools/rename-sessions.mjs --apply       # 真的改
 *   node tools/rename-sessions.mjs --bridge-dir D:\path\to\qq-bridge
 *   node tools/rename-sessions.mjs --cwd D:\other\dir
 *
 * 说明：
 *   · 只处理桥接 sessions.json 里**有映射**的会话，绝不动别的目录/子代理；
 *   · 改名走 DSH 的 `session/rename`，会 resume 目标会话（冷会话会被拉起）；
 *   · 逐条串行 + 小延迟，避免一次拉起几十个会话；
 *   · 幂等：标题已经符合同的会话直接跳过，可以反复跑。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DshClient } from '../qq-bridge/src/dsh.mjs'
import { planRenames } from '../qq-bridge/src/rename-plan.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

/** 解析命令行参数（零依赖）。 */
function parseArgs(argv) {
  const opts = {
    apply: false,
    bridgeDir: path.join(REPO, 'qq-bridge'),
    cwd: '',
    delayMs: 80,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') opts.apply = true
    else if (arg === '--dry-run') opts.apply = false
    else if (arg === '--bridge-dir') opts.bridgeDir = path.resolve(argv[++i] ?? '')
    else if (arg === '--cwd') opts.cwd = argv[++i] ?? ''
    else if (arg === '--delay-ms') opts.delayMs = Math.max(0, Number(argv[++i]) || 0)
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`)
  }
  return opts
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
    return
  }
  const configPath = path.join(opts.bridgeDir, 'config.json')
  const statePath = path.join(opts.bridgeDir, 'state', 'sessions.json')
  if (!fs.existsSync(configPath)) throw new Error(`找不到桥接配置：${configPath}`)
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : { sessions: {} }
  const sessionCwd = opts.cwd || config?.dsh?.sessionCwd || ''
  if (!sessionCwd) throw new Error('桥接 config.json 里没有 dsh.sessionCwd，且没传 --cwd')

  const dsh = new DshClient({ baseUrl: config?.dsh?.baseUrl ?? 'http://127.0.0.1:2852' })
  await dsh.ensureBaseUrl()
  console.log(`DSH：${dsh.baseUrl}`)
  console.log(`工作区：${sessionCwd}`)
  console.log(`模式：${opts.apply ? 'APPLY（真的改）' : 'DRY-RUN（只打印）'}\n`)

  const sessions = await dsh.listSessions()
  const plan = planRenames({ sessions, state, cwd: sessionCwd })
  const renames = plan.filter((row) => row.action === 'rename')
  const noMapping = plan.filter((row) => row.action === 'skip-no-mapping')
  const unchanged = plan.filter((row) => row.action === 'skip-unchanged')

  console.log(`会话总数 ${plan.length}：待改名 ${renames.length}，已规范 ${unchanged.length}，无映射跳过 ${noMapping.length}\n`)
  for (const row of renames) {
    console.log(`  ${row.key ?? '?'}  ${JSON.stringify(row.current)}  ->  ${JSON.stringify(row.expected)}`)
  }
  if (noMapping.length > 0) {
    console.log('\n无映射（不是桥接建的会话，或映射已丢）：')
    for (const row of noMapping.slice(0, 20)) console.log(`  ${row.sessionId}  当前=${JSON.stringify(row.current)}`)
    if (noMapping.length > 20) console.log(`  …还有 ${noMapping.length - 20} 条`)
  }
  if (!opts.apply) {
    console.log('\n预演结束。确认无误后加 --apply 执行。')
    return
  }

  let ok = 0
  const failed = []
  for (const row of renames) {
    try {
      await dsh.renameSession(row.sessionId, row.expected)
      ok++
      console.log(`  ✓ ${row.key} -> ${row.expected}`)
    } catch (error) {
      failed.push({ ...row, error: error?.message ?? String(error) })
      console.log(`  ✗ ${row.key} 失败：${error?.message ?? error}`)
    }
    if (opts.delayMs > 0) await sleep(opts.delayMs)
  }
  console.log(`\n完成：成功 ${ok}，失败 ${failed.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(`失败：${error?.message ?? error}`)
  process.exitCode = 1
})
