/**
 * 启动入口：读配置 → 起桥接 → 打印状态；Ctrl+C 优雅退出。
 *   node start.mjs            # 用 config.json
 *   node start.mjs --dry-run  # 只校验配置与 DSH 可达性，不连 QQ
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bridge } from './src/bridge.mjs'
import { DshClient } from './src/dsh.mjs'
import { startConfigPolling } from './src/runtime-config.mjs'
import { writePersona } from './src/persona.mjs'
import { buildBridgeStatus } from './src/status.mjs'
import { acquireInstanceLock } from './src/instance-lock.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = process.env.QQ_BRIDGE_CONFIG || path.join(HERE, 'config.json')

const logger = {
  info: (m) => console.log(`[${ts()}] ${m}`),
  warn: (m) => console.warn(`[${ts()}] ⚠️  ${m}`),
  error: (m) => console.error(`[${ts()}] ❌ ${m}`),
}
const ts = () => new Date().toTimeString().slice(0, 8)

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`找不到配置文件：${CONFIG_PATH}\n请先：copy config.example.json config.json`)
    process.exit(1)
  }
  let cfg
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch (e) {
    console.error(`配置文件不是合法 JSON：${e.message}`); process.exit(1)
  }
  if (!cfg.dsh?.baseUrl) { console.error('config.dsh.baseUrl 缺失'); process.exit(1) }
  if (!cfg.onebot?.wsUrl) { console.error('config.onebot.wsUrl 缺失'); process.exit(1) }
  // fail-closed 护栏：白名单为空 + allowAllWhenEmpty 未开 = 谁都不理（这是刻意的默认）。
  const a = cfg.allow ?? {}
  const empty = (a.private ?? []).length === 0 && (a.groups ?? []).length === 0
  if (empty && a.allowAllWhenEmpty !== true) {
    logger.warn('白名单为空且 allowAllWhenEmpty != true：桥接不会响应任何 QQ 消息（fail-closed）。')
  }
  return cfg
}

const config = loadConfig()
logger.info(`配置：${CONFIG_PATH}`)

// 只读预检：先探 DSH 的真实端口（桌面端 webserver 用 port:0，重启会换端口），
// 再确认鉴权成立。这一步不碰 QQ。
const probe = new DshClient({ baseUrl: config.dsh.baseUrl, logger })
try {
  await probe.ensureBaseUrl()
  await probe.call('agentPresets/list', {})
  config.dsh.baseUrl = probe.baseUrl   // 把探到的实际地址带回给 Bridge
  logger.info(`DSH 鉴权通过 ✓（实际地址 ${probe.baseUrl}）`)
} catch (e) {
  logger.error(`DSH 鉴权失败：${e.message}`)
  logger.error('排查：DSH 是否在运行？~/.dsh/.credentials.yaml 是否可读？')
  logger.error('提示：DSH 桌面端的端口是随机分配的，桥接会自动探测；也可用 DSH_BASE_URL 显式指定。')
  process.exit(1)
}

logger.info(`DSH：${config.dsh.baseUrl}｜preset=${config.dsh.agentPreset}｜model=${config.dsh.provider}/${config.dsh.model}`)
logger.info(`QQ：${config.onebot.wsUrl}`)

if (process.argv.includes('--dry-run')) {
  logger.info('--dry-run：不连 QQ，退出。')
  process.exit(0)
}

// 单实例锁（批次 5）：同一个 qq-bridge 目录只允许一个桥接进程。
//
// 为什么必须有：插件 bridge.autoStart / 设置页「启动桥接」可能在已经有一个
// 手动终端实例时再拉起一个。两个桥接都连 NapCat 的同一条正向 WS，**同一条 QQ
// 消息会被两个进程各收一次** → 重复回复、重复建会话。锁文件用 `wx` 原子创建，
// pid 带在内容里；进程异常死亡留下的陈旧锁会被下一次启动清掉。
const lock = acquireInstanceLock(HERE)
if (!lock.ok) {
  logger.info(
    `已有桥接实例在运行（pid=${lock.holder?.pid ?? '未知'}，${lock.reason}），`
    + '本进程退出，不重复接消息。',
  )
  process.exit(0)
}
process.on('exit', () => lock.release())

const bridge = new Bridge({ config, logger })
await bridge.start()
logger.info('桥接已启动，等待 QQ 消息。按 Ctrl+C 退出。')

// 从 DSH 设置页热同步运行期配置（批次 4A）。失败不影响收发，继续用 config.json。
const stopPolling = startConfigPolling({
  baseUrl: config.dsh.baseUrl,
  logger,
  liveConfig: bridge.live,
  onSync: () => bridge._applyLiveToClient(),
  // 人设变化 → 写回 profile 的 preset 覆盖（只对新建会话生效，保留已有会话上下文）。
  onPersona: (text) => writePersona(text),
  // 顺带把运行状态回推给 DSH 设置页的「运行状态」分类（批次 4A）。
  // 批次 5：**不再用 `qq.connected`（WS 建连瞬间恒 false，且不等于账号在线）**，
  // 改由 health.online 推导四态（online/offline/unverified/disconnected）。
  getStatus: () => buildBridgeStatus({
    health: bridge.qq?.health,
    counts: bridge.stats,
    // 能走到这里说明刚成功拉过 DSH 的配置路由，链路是通的。
    dshOk: true,
  }),
})

let stopping = false
const shutdown = async (sig) => {
  if (stopping) return
  stopping = true
  logger.info(`收到 ${sig}，正在停止…`)
  stopPolling()
  logger.info(`统计：${JSON.stringify(bridge.stats)}`)
  await bridge.stop().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
