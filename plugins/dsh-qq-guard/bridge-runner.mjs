/**
 * 桥接进程管理（批次 4B 补充：解决「桥接没有常驻机制」）。
 *
 * ## 为什么需要这个模块
 * 之前桥接只能靠人手动开一个终端窗口 `node start.mjs` 跑。
 * 窗口一关（或终端被关掉），进程就跟着没了 —— UI 上于是显示「未知（桥接未上报）」。
 * 这不是桥接代码崩溃（实测 `start.mjs` 前台能一直跑、NapCat 断开只是退避重连），
 * 而是**没有任何常驻/守护机制**。
 *
 * ## 做法
 * 与 NapCat 同一套：用 `ctx.subprocess` 在 DSH 进程里托管，
 * 好处是 DSH 退出时能靠 `ctx.effect` 的清理钩子把它停掉，不留孤儿。
 *
 * 但桥接和 NapCat 有一个关键区别：
 *   · NapCat 是 GUI 程序，stdio 可以全 ignore；
 *   · 桥接是 CLI 服务，**它的日志就是唯一的排障线索**（WebSocket 断开、发送失败、
 *     白名单拦截都打在 stdout）。全 ignore 等于把眼睛蒙上。
 * 所以这里用 `pipe` 收集 stdout/stderr，保留最近 N 行做「最近日志」，
 * 既常驻又可排查。
 *
 * ## 为什么不用 --dry-run 之类的守护循环
 * 桥接自己内部已经处理了重连（NapCat WS 断开指数退避、DSH 端口变化 rebind）。
 * 进程级崩溃（未捕获异常）才需要重启。这里加**有限次自动重启**：
 * 非正常退出（code≠0 且不是主动停止）时最多重启 3 次，避免崩溃循环刷屏。
 *
 * ## 批次 5 审计修复（autoStart 收尾）
 *   ① **单实例**：启动前先只读检查桥接目录的 `.bridge.lock`（格式见
 *      `qq-bridge/src/instance-lock.mjs`）。已有活实例（比如用户自己开终端跑的）
 *      就直接跳过，绝不 spawn 第二个 —— 否则两个桥接都会收到同一条 QQ 消息，
 *      造成重复回复。
 *   ② **崩溃重启计数不再被每次 start() 清零**：只有进程**稳定存活**
 *      `STABLE_UPTIME_MS` 后才把 `autoRestarts` 归零。旧实现 spawn 成功即清零，
 *      「起来 3 秒就崩」会变成无限重启。
 *   ③ 定时器（稳定性计时）在进程退出 / stop / 卸载时清掉，不留悬空回调。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 默认桥接目录（与插件同仓库的 qq-bridge/）。 */
export const DEFAULT_BRIDGE_DIR = path.resolve(HERE, '../../qq-bridge')
/** 保留的日志行数。 */
const LOG_LINES = 40
/** 自动重启上限（崩溃循环保护）。 */
const MAX_AUTO_RESTARTS = 3
/** 与 `qq-bridge/src/instance-lock.mjs` 约定一致的单实例锁文件名。 */
const INSTANCE_LOCK_NAME = '.bridge.lock'
/** 进程稳定存活这么久才把崩溃重启计数清零（避免「起来就崩」无限重启）。 */
const STABLE_UPTIME_MS = 60_000

/**
 * 只读检查桥接目录里的单实例锁（格式见 `qq-bridge/src/instance-lock.mjs`）。
 *
 * 为什么不 import 那个模块：`bridge.dir` 可以配置成任意目录，插件不能假设
 * 桥接工程就在同仓库相对路径上。所以这里按**约定格式**独立实现一份只读检查；
 * 锁文件名/字段一旦改动，两边必须同步（回归用例会覆盖）。
 *
 * @param {string} dir 桥接目录
 * @returns {{pid:number, startedAt:number|null}|null}
 */
function readLiveInstanceLock(dir) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, INSTANCE_LOCK_NAME), 'utf8'))
  } catch {
    return null
  }
  const pid = Number(parsed?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return null
  let alive = false
  try {
    process.kill(pid, 0)
    alive = true
  } catch (error) {
    // EPERM = 进程存在但没有操作权限（仍然算活着）。
    alive = error?.code === 'EPERM'
  }
  return alive ? { pid, startedAt: Number(parsed?.startedAt) || null } : null
}

/**
 * 桥接进程管理器。
 */
export class BridgeRunner {
  /**
   * @param {object} opts
   * @param {object} opts.subprocess ctx.subprocess
   * @param {object} [opts.logger]
   * @param {() => object} [opts.getConfig] 现读配置（热更新）
   * @param {string} [opts.nodePath] node 可执行文件（默认当前进程的 execPath）
   * @param {number} [opts.readyWaitMs=2000] 启动后等待「确认还活着」的时长（测试可调小）
   * @param {number} [opts.stableUptimeMs=60000] 稳定存活多久才清零崩溃重启计数
   * @param {number} [opts.restartBaseDelayMs=1500] 自动重启的基础退避（第 n 次 = n × 它）
   */
  constructor({ subprocess, logger, getConfig, nodePath, readyWaitMs, stableUptimeMs, restartBaseDelayMs }) {
    this.subprocess = subprocess
    this.log = {
      info: (m) => logger?.info?.(m),
      warn: (m) => logger?.warn?.(m),
      error: (m) => logger?.error?.(m),
    }
    this.getConfig = getConfig ?? (() => ({}))
    this.nodePath = nodePath ?? process.execPath
    this.readyWaitMs = Number.isFinite(readyWaitMs) && readyWaitMs >= 0 ? Number(readyWaitMs) : 2000
    this.stableUptimeMs = Number.isFinite(stableUptimeMs) && stableUptimeMs >= 0 ? Number(stableUptimeMs) : STABLE_UPTIME_MS
    this.restartBaseDelayMs = Number.isFinite(restartBaseDelayMs) && restartBaseDelayMs >= 0
      ? Number(restartBaseDelayMs)
      : 1500
    this.handle = null
    this._alive = false
    this.startedAt = null
    this.lastError = null
    this.lastExit = null
    this.autoRestarts = 0
    this._stopping = false
    this._busy = false
    /** @type {NodeJS.Timeout|null} 稳定存活计时器（到点清零 autoRestarts）。 */
    this._stableTimer = null
    /** @type {string[]} 最近日志行（环形） */
    this.logTail = []
  }

  _cfg() {
    const c = this.getConfig() ?? {}
    return {
      bridgeDir: c.bridgeDir || DEFAULT_BRIDGE_DIR,
      entry: c.bridgeEntry || 'start.mjs',
    }
  }

  get processAlive() {
    return this._alive === true
  }

  /** 追加一行日志到环形缓冲。 */
  _push(line) {
    const text = String(line ?? '').replace(/\r?\n$/, '')
    if (!text) return
    this.logTail.push(text)
    if (this.logTail.length > LOG_LINES) this.logTail.splice(0, this.logTail.length - LOG_LINES)
  }

  /**
   * 从 subprocess 的 collect 读取器里增量拉日志。
   * @param {object} handle
   * @param {import('node:stream').Readable|undefined} stream 备用：pipe 模式下直接读流
   */
  _attachLogs(handle) {
    const wire = (stream) => {
      if (!stream || typeof stream.on !== 'function') return
      stream.setEncoding?.('utf8')
      let buf = ''
      stream.on('data', (chunk) => {
        buf += String(chunk)
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) this._push(line)
        if (buf.length > 4000) { this._push(buf); buf = '' }
      })
      stream.on('error', () => { /* 进程退出时流会报错，忽略 */ })
    }
    wire(handle.stdout)
    wire(handle.stderr)
  }

  /** 清掉「稳定存活」计时器。 */
  _clearStableTimer() {
    if (this._stableTimer !== null) {
      clearTimeout(this._stableTimer)
      this._stableTimer = null
    }
  }

  /**
   * 进程起来后开始计时：**稳定存活**才把崩溃重启计数清零。
   *
   * 旧实现是在 start() 返回前无条件 `autoRestarts = 0`，于是「起来几秒就崩」
   * 每轮都会把计数清零 → 实际可以无限重启，与「最多 3 次」的注释不符。
   */
  _scheduleStableReset() {
    this._clearStableTimer()
    const timer = setTimeout(() => {
      this._stableTimer = null
      if (!this.processAlive) return
      this.autoRestarts = 0
    }, this.stableUptimeMs)
    // 不要因为这个计时器让宿主/测试进程退不出去。
    if (typeof timer.unref === 'function') timer.unref()
    this._stableTimer = timer
  }

  /**
   * 启动桥接。
   * @param {object} [opts]
   * @param {boolean} [opts.manual=false] 用户手动点「启动桥接」→ 重置崩溃重启计数
   * @returns {Promise<{ok:boolean, action:string, detail?:string}>}
   */
  async start({ manual = false } = {}) {
    if (this._busy) return { ok: false, action: 'busy', detail: '已有启动/停止操作在进行' }
    this._busy = true
    try {
      if (this.processAlive) return { ok: true, action: 'already-running' }
      if (manual) this.autoRestarts = 0

      const cfg = this._cfg()
      const dir = path.resolve(cfg.bridgeDir)
      if (!fs.existsSync(dir)) {
        return { ok: false, action: 'dir-missing', detail: `桥接目录不存在：${dir}` }
      }
      const entry = path.join(dir, cfg.entry)
      if (!fs.existsSync(entry)) {
        return { ok: false, action: 'entry-missing', detail: `找不到入口：${entry}` }
      }

      // 单实例：已有活实例（用户自己在终端跑的 / 另一个 DSH 拉的）就不 spawn。
      // 否则两个桥接都连 NapCat 的同一根 WS，同一条消息会被各收一次 → 重复回复。
      const holder = readLiveInstanceLock(dir)
      if (holder !== null) {
        this.log.info(`已有桥接实例在运行（pid=${holder.pid}），跳过启动，避免重复接消息`)
        return {
          ok: true,
          action: 'already-running-external',
          detail: `已有桥接实例在运行（pid=${holder.pid}）`,
        }
      }

      this.log.info(`启动桥接：${this.nodePath} ${entry}（cwd=${dir}）`)
      const handle = this.subprocess.spawn({
        argv: [this.nodePath, entry],
        cwd: dir,
        // 桥接的日志是唯一排障线索：必须 pipe 出来，不能 ignore。
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 5000,
      })
      this.handle = handle
      this._alive = true
      this.startedAt = Date.now()
      this.lastError = null
      this.lastExit = null   // 清掉上一轮的退出记录，避免「启动即失败」误读成上轮的 exit 0
      this._stopping = false
      this._attachLogs(handle)

      handle.done.then((outcome) => {
        this._alive = false
        this.handle = null
        this.startedAt = null
        this._clearStableTimer()
        this.lastExit = { code: outcome?.exitCode ?? null, signal: outcome?.signal ?? null, at: Date.now() }
        const wasStopping = this._stopping
        this._stopping = false
        this.log.warn(`桥接进程已退出（code=${outcome?.exitCode} signal=${outcome?.signal}${wasStopping ? '，主动停止' : ''}）`)

        // 非主动停止 + 非零退出 → 视为崩溃，有限次自动重启
        const crashed = !wasStopping && outcome?.exitCode !== 0
        if (crashed && this.autoRestarts < MAX_AUTO_RESTARTS) {
          this.autoRestarts++
          const delay = this.restartBaseDelayMs * this.autoRestarts
          this.log.warn(`桥接异常退出，${Math.round(delay / 1000)}s 后自动重启（第 ${this.autoRestarts}/${MAX_AUTO_RESTARTS} 次）`)
          // 若崩溃发生在 start() 的「确认存活」窗口内，_busy 还是 true；
          // 直接调 start() 会被并发保护挡掉，重启就丢了 → 等它空闲再补一次。
          const attempt = () => {
            if (this._stopping || this.processAlive) return
            if (this._busy) {
              const retry = setTimeout(attempt, this.restartBaseDelayMs)
              if (typeof retry.unref === 'function') retry.unref()
              return
            }
            void this.start()
          }
          const timer = setTimeout(attempt, delay)
          if (typeof timer.unref === 'function') timer.unref()
        } else if (crashed) {
          this.log.error(`桥接已连续崩溃 ${MAX_AUTO_RESTARTS} 次，停止自动重启。最近日志：`)
          for (const line of this.logTail.slice(-10)) this.log.error(`  ${line}`)
        }
      }).catch((error) => {
        this._alive = false
        this.handle = null
        this._clearStableTimer()
        this.lastError = error?.message ?? String(error)
        this.log.error(`桥接进程异常：${this.lastError}`)
      })

      // 给它一点时间真起来（桥接启动会先探 DSH 端口，最多 ~1.2s×N）
      const deadline = Date.now() + Math.max(6000, this.readyWaitMs * 3)
      while (Date.now() < deadline) {
        if (!this.processAlive) break
        await new Promise((r) => setTimeout(r, 300))
        // 进程还活着就先返回，避免 UI 等太久
        if (Date.now() - this.startedAt > this.readyWaitMs) break
      }
      if (!this.processAlive) {
        // 退出码 0 = 桥接自己发现已有实例并主动让位（单实例锁），不是故障。
        if (this.lastExit?.code === 0) {
          return {
            ok: true,
            action: 'already-running',
            detail: '桥接检测到已有实例，已主动退出（不会重复接消息）',
          }
        }
        return {
          ok: false,
          action: 'exited-early',
          detail: this.lastExit
            ? `启动后立即退出（code=${this.lastExit.code}）`
            : '启动后立即退出',
        }
      }
      // 注意：这里不再无条件清零 autoRestarts，交给稳定存活计时器。
      this._scheduleStableReset()
      return { ok: true, action: 'started' }
    } catch (error) {
      this.lastError = error?.message ?? String(error)
      this.log.error(`启动桥接失败：${this.lastError}`)
      return { ok: false, action: 'failed', detail: this.lastError }
    } finally {
      this._busy = false
    }
  }

  /**
   * 停止桥接（主动停止，不触发自动重启）。
   */
  async stop() {
    if (this._busy) return { ok: false, action: 'busy', detail: '已有启动/停止操作在进行' }
    this._busy = true
    try {
      this._clearStableTimer()
      const handle = this.handle
      if (handle === null) return { ok: true, action: 'not-managed', detail: '当前没有由本插件管理的桥接进程' }
      this._stopping = true
      this.log.info('停止桥接…')
      try { handle.terminate() } catch (error) { this.log.warn(`terminate 失败：${error?.message ?? error}`) }
      let exited = false
      try { exited = await handle.waitForExit(AbortSignal.timeout(8000)) } catch { /* 超时 */ }
      if (!exited) this.log.warn('桥接未在宽限内退出，可能仍在运行')
      this.handle = null
      this._alive = false
      this.startedAt = null
      this.log.info('桥接已停止')
      return { ok: true, action: 'stopped' }
    } catch (error) {
      this.lastError = error?.message ?? String(error)
      return { ok: false, action: 'failed', detail: this.lastError }
    } finally {
      this._busy = false
    }
  }

  /** 彻底退出：停进程 + 清空自动重启计数（用于「退出桥接」按钮）。 */
  async exit() {
    this.autoRestarts = MAX_AUTO_RESTARTS   // 阻止任何后续自动重启
    const r = await this.stop()
    return { ...r, action: r.action === 'not-managed' ? 'already-exited' : 'exited' }
  }

  /** 状态快照（给 UI）。 */
  snapshot() {
    const cfg = this._cfg()
    return {
      alive: this.processAlive,
      managed: this.handle !== null,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : null,
      bridgeDir: cfg.bridgeDir,
      entry: cfg.entry,
      lastError: this.lastError,
      lastExit: this.lastExit,
      autoRestarts: this.autoRestarts,
      logTail: [...this.logTail],
    }
  }
}
