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
import { startConfigPolling, syncConfigOnce } from './src/runtime-config.mjs'
import { startSessionOpsPolling } from './src/session-ops.mjs'
import { buildBridgeStatus } from './src/status.mjs'
import { acquireInstanceLock } from './src/instance-lock.mjs'
import { PluginHub, normalizePluginHubConfig } from './src/plugin-hub.mjs'

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
// ★ 启动时同步拉一次热配置（v0.5.1）：第一条 QQ 消息可能早于 2s 轮询的第一轮，
//   而 toolEpoch / features 决定「旧会话要不要重建上下文」。晚一拍，重启后的
//   第一条消息仍会落在旧工具基线上（真机踩过：第一句又说「没有发图工具」）。
try {
  const early = await syncConfigOnce({ baseUrl: config.dsh.baseUrl, liveConfig: bridge.live, logger })
  if (early.ok && early.changed.length > 0) {
    logger.info(`启动时已同步 DSH 配置：${early.changed.join('、')}`)
  }
} catch { /* syncConfigOnce 内部已兜住，这里只防御 */ }
await bridge.start()
logger.info('桥接已启动，等待 QQ 消息。按 Ctrl+C 退出。')

// 插件通道（契约 §2/§3/§6）：默认全关（config.pluginHub 缺省 = enabled:false，
// autoReply / video 也各自 false），不配置时行为与现在完全一致。
//
// 生命周期：必须在 bridge.start() 之后起（契约要求），退出时关闭。
// 起不来**只 warn** —— 聊天主链路绝不能因为插件端口被占 / 插件没装而受影响。
// 注意 autoReply 判定与视频落盘是**桥接出站**调用，不依赖这里监听成功：
// 所以即使 start() 抛错，也把 hub 挂在 bridge 上（端口起不来只影响插件→桥接方向）。
let pluginHub = null
try {
  pluginHub = new PluginHub({
    bridge,
    config: normalizePluginHubConfig(config.pluginHub),
    logger,
  })
  bridge.pluginHub = pluginHub
  const hubStarted = await pluginHub.start()
  if (hubStarted.ok) {
    logger.info(`插件通道已启动：http://127.0.0.1:${hubStarted.port}（token=${pluginHub.config.token ? '已配置' : '不校验'}）`)
  } else {
    logger.info('插件通道未启用（config.pluginHub.enabled=false）')
  }
} catch (error) {
  logger.warn(`插件通道启动失败（不影响桥接）：${error?.message ?? error}`)
}

// 人设里现在带【底层模型】一行，必须在第一条消息之前就位。
//
// preset 里已经删掉静态 persona 行，默认人设正文由插件的动态 section 承载：
// 桥接把 buildPersonaPrompt() 的结果 POST 给插件（mode:'default'），
// guard 实例的 section text 每次组装现读，所以**不需要**改 profile 文件，也不受
// 「只对新建会话生效」的限制。
//
// 为什么推两次：
//   ① 启动时 `bridge.live` 还没有 DSH 设置页下发的 `model`（轮询要 2 秒后才有），
//      先用 config.json 的 `dsh.provider/model` 兜底 —— 至少有身份行；
//   ② 首次同步成功后必须**再推一次校准**，否则设置页里配的模型和身份行会不一致。
//
// ⚠️ 必须**返回执行结果** `{ ok, action, detail }`（可以是 Promise）：
//    runtime-config 靠它判断推送是否成功，据此推进 lastPersonaSignature。
//    旧实现写成 `() => { void pushGlobalPersona(...) }`，返回值恒为 undefined →
//    runtime-config 里 `r?.ok` 永远假、签名永不更新 → **每 2 秒重复推送一次**
//    （README【待修复 2】）。
/** 上次真正推给插件的人设正文；内容没变就不重复写（轮询每 2 秒一次）。 */
let pushedPersonaSignature
const pushGlobalPersona = async (label) => {
  const text = bridge.buildPersonaPrompt()
  if (pushedPersonaSignature === text) {
    return { ok: true, action: 'unchanged', detail: '人设内容未变，跳过重复推送' }
  }
  const ok = await bridge.setGlobalPersona(text)
  if (!ok) {
    return { ok: false, action: 'failed', detail: 'setSessionPersona 调用失败（详见上方 warn）' }
  }
  pushedPersonaSignature = text
  // 日志减噪：只有真正变化（含启动首次）才打，不再每 2 秒刷一条。
  logger.info(`全局人设已推送（${label}，${text.length} 字）`)
  return { ok: true, action: 'pushed', detail: `${text.length} 字` }
}
await pushGlobalPersona('含底层模型路由')

let firstSyncDone = false

// 从 DSH 设置页热同步运行期配置（批次 4A）。失败不影响收发，继续用 config.json。
const stopPolling = startConfigPolling({
  baseUrl: config.dsh.baseUrl,
  logger,
  liveConfig: bridge.live,
  onSync: () => {
    bridge._applyLiveToClient()
    if (!firstSyncDone) {
      firstSyncDone = true
      void pushGlobalPersona('首次同步后校准模型身份')
    }
  },
  // 人设变化 → 重拼最终系统提示词（名字/参与度/附加规则/覆盖/模型身份），推给插件。
  // 返回 pushGlobalPersona 的结果对象（异步）—— 不能写成 `() => { void ... }`，
  // 否则 runtime-config 拿不到 ok，签名不更新就会每 2 秒重推。见上方 pushGlobalPersona 的说明。
  onPersona: () => pushGlobalPersona('设置页人设变化'),
  // 顺带把运行状态回推给 DSH 设置页的「运行状态」分类（批次 4A）。
  // 批次 5：**不再用 `qq.connected`（WS 建连瞬间恒 false，且不等于账号在线）**，
  // 改由 health.online 推导四态（online/offline/unverified/disconnected）。
  getStatus: () => buildBridgeStatus({
    health: bridge.qq?.health,
    counts: bridge.stats,
    // 只有桥接进程知道每个 QQ 会话的未读 / 昵称 / DSH 映射，
    // 一起上报给 Host，设置页「会话管理」才有真实数据。
    sessions: bridge.sessionViews(),
    // 操作日志（v2.0 第六步）：内存最近 50 条，设置页「运行状态」直接展示。
    opLog: bridge.opLogViews(),
    // 能走到这里说明刚成功拉过 DSH 的配置路由，链路是通的。
    dshOk: true,
  }),
})

// 会话指令轮询（清空上下文 / 删除会话 / 保存单人设）：
// UI 入队 → 这里每 2 秒取一次并执行，执行结果回传。失败不影响聊天主链路。
// 地址用 getter 现读 bridge.dsh.baseUrl：DSH 重启换端口后桥接已能自愈，轮询器跟着走。
const stopOpsPolling = startSessionOpsPolling({
  getBaseUrl: () => bridge.dsh?.baseUrl,
  bridge,
  logger,
})

let stopping = false
const shutdown = async (sig) => {
  if (stopping) return
  stopping = true
  logger.info(`收到 ${sig}，正在停止…`)
  stopPolling()
  stopOpsPolling()
  // 插件通道先关：别再收插件的发送请求（autoReply 出站调用也随进程一起结束）。
  if (pluginHub) await pluginHub.stop().catch(() => {})
  logger.info(`统计：${JSON.stringify(bridge.stats)}`)
  await bridge.stop().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
