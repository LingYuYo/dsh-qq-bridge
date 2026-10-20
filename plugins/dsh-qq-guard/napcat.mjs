/**
 * NapCat 进程生命周期管理（批次 4B，方案 A：插件管理进程，不内置二进制）。
 *
 * ## 为什么必须用 Host 插件而不是桥接
 * 启动/停止需要「与 DSH 同生命周期」的清理：DSH 退出时 NapCat 不能变成孤儿进程。
 * 只有 Host 插件能拿到 `ctx.effect(() => () => stop())` 这层清理钩子。
 * 桥接是独立进程，它退出时管不到 NapCat。
 *
 * ## 用 ctx.subprocess 而不是 node:child_process
 * `@deepseek-ai/dsh-subprocess-local` 在 Windows 上用 **Job Object** 托管整个进程树
 * （证据：lib/index.js:770 `launchWindowsJob`，注释「Launch one target through a runner
 * that uniquely owns its Job handle」），因此 `terminate()` 天然能收掉子孙进程，
 * 不需要我们手工 `taskkill /T`。
 * 另外它**硬编码 `windowsHide: true`**（lib/index.js:781），所以「隐藏窗口」这个
 * 要求不需要调用方传参 —— `SubprocessSpawnSpec` 里根本没有该字段。
 *
 * `graceMs` 就是 TERM→KILL 的宽限期（lib/index.js:948 注释
 * 「TERM-to-KILL and exit-wait grace」），要求里的「5 秒宽限」用它表达。
 *
 * ## 三层在线判定
 *   ① 进程存活（handle 未 done）
 *   ② WS 端口 LISTENING（NapCat 的 OneBot 服务真的起来了）
 *   ③ get_status 返回 online 且带账号
 * 三者**同时**成立才算「在线」。只看进程会把「QQ 掉线但进程还在」误判成在线。
 */

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'

/** 默认 NapCat 目录：留空 = 必须由 Config（设置页 napcat.dir）显式指定。 */
export const DEFAULT_NAPCAT_DIR = ''
/** 默认 OneBot 正向 WS 端口（与 qq-bridge/config.json 的 wsUrl 对应）。 */
export const DEFAULT_WS_PORT = 3001
/** TERM→KILL 宽限（要求：5 秒）。 */
export const STOP_GRACE_MS = 5000
/** 单次 get_status 探测超时。 */
const PROBE_TIMEOUT_MS = 1500

/**
 * 找出真实的可执行文件。
 *
 * ⚠️ `subprocess.spawn` 的 argv[0] 必须是**绝对路径可执行文件**
 * （`resolveExecutable` 明确拒绝带分隔符的相对路径），所以不能直接跑 `napcat.bat`。
 * NapCat 的启动链是 `napcat.bat` → `NapCatWinBootMain.exe [QQ号]`，
 * 我们直接跑后者，把快速登录的 QQ 号作为 argv[1]。
 *
 * @param {string} dir
 * @returns {{ exe: string, dir: string }}
 */
export function resolveNapcatExe(dir = DEFAULT_NAPCAT_DIR) {
  if (!dir) {
    throw new Error('未配置 NapCat 安装目录：请在设置页「QQ 桥接 → NapCat 进程」里填 napcat.dir（含 NapCatWinBootMain.exe 的目录）')
  }
  const base = path.resolve(dir)
  if (!fs.existsSync(base)) throw new Error(`NapCat 目录不存在：${base}`)
  const candidate = path.join(base, 'NapCatWinBootMain.exe')
  if (!fs.existsSync(candidate)) {
    throw new Error(`没找到 NapCatWinBootMain.exe（期望在 ${base}）。NapCat 的目录结构可能变了。`)
  }
  return { exe: candidate, dir: base }
}

/**
 * 探测某个 TCP 端口是否处于 LISTENING。
 * 用「能否建立连接」近似：NapCat 的 WS 服务在监听时能接受连接。
 * @param {number} port
 * @param {string} [host='127.0.0.1']
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function isPortListening(port = DEFAULT_WS_PORT, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* 已关闭 */ }
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    try { socket.connect(port, host) } catch { finish(false) }
  })
}

/**
 * 用 OneBot v11 的 get_status 探测账号在线信息。
 *
 * NapCat 的 HTTP API 若没开就探不到——那就当作「无法确认」，返回 null，
 * 由上层用「进程 + 端口」两层兜底。**不能把探不到当成离线**，
 * 否则没开 HTTP API 的用户会永远显示离线。
 *
 * @param {object} opts
 * @param {string} [opts.baseUrl] 形如 http://127.0.0.1:3000（NapCat 的 HTTP 服务）
 * @param {string} [opts.accessToken]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{online:boolean, selfId:string|null, nickname:string|null}|null>}
 */
export async function probeOneBotStatus({ baseUrl, accessToken, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (!baseUrl) return null
  try {
    const headers = { accept: 'application/json' }
    if (accessToken) headers.authorization = `Bearer ${accessToken}`
    const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/get_status`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const body = await res.json()
    if (body?.status !== 'ok') return null
    const data = body?.data ?? {}
    const online = data.online === true || data.good === true
    // get_login_info 的账号可能不在 get_status 里；有就带上
    return { online, selfId: data.self_id ? String(data.self_id) : null, nickname: data.nickname ?? null }
  } catch {
    return null
  }
}

/**
 * NapCat 进程管理器。
 *
 * 职责边界：只管「起/停/查」，不碰 QQ 消息收发（那是桥接的事）。
 */
export class NapcatManager {
  /**
   * @param {object} opts
   * @param {object} opts.subprocess ctx.subprocess
   * @param {object} [opts.logger]
   * @param {() => object} [opts.getConfig] 每次现读配置（热更新，不要缓存）
   */
  constructor({ subprocess, logger, getConfig }) {
    this.subprocess = subprocess
    this.log = {
      info: (m) => logger?.info?.(m),
      warn: (m) => logger?.warn?.(m),
      error: (m) => logger?.error?.(m),
    }
    this.getConfig = getConfig ?? (() => ({}))
    /** @type {import('@deepseek-ai/dsh-subprocess-local').SubprocessHandle | null} */
    this.handle = null
    /** 最近一次启动时间（handle 不暴露 pid，所以只记时间）。 */
    this.startedAt = null
    this.lastError = null
    /** 启动/停止串行化，避免连点两次起两个进程。 */
    this._busy = false
  }

  /** 当前配置（每次现读）。 */
  _cfg() {
    const c = this.getConfig() ?? {}
    return {
      napcatDir: c.napcatDir || DEFAULT_NAPCAT_DIR,
      quickLoginQQ: c.quickLoginQQ || '',
      wsPort: Number(c.wsPort) || DEFAULT_WS_PORT,
      onebotHttpUrl: c.onebotHttpUrl || '',
      accessToken: c.accessToken || '',
    }
  }

  /** 进程是否还在（没有 handle 或已退出都不算活）。 */
  get processAlive() {
    if (this.handle === null) return false
    // done 已 settle 就把 handle 清掉；这里用同步标志判断，由 _watchExit 维护
    return this._alive === true
  }

  /**
   * 启动 NapCat。
   * @returns {Promise<{ok:boolean, action:string, pid?:number, detail?:string, reused?:boolean}>}
   */
  async start() {
    if (this._busy) return { ok: false, action: 'busy', detail: '已有启动/停止操作在进行' }
    this._busy = true
    try {
      const cfg = this._cfg()

      // ① 防双开：端口已在监听 → 直接复用，绝不再起一个
      if (await isPortListening(cfg.wsPort)) {
        this.log.info(`NapCat 似乎已在运行（端口 ${cfg.wsPort} 已监听），复用之`)
        return { ok: true, action: 'reused', reused: true }
      }

      // ② 已经在管理一个活进程 → 不复用也不重起
      if (this.processAlive) {
        return { ok: true, action: 'already-running' }
      }

      const { exe, dir } = resolveNapcatExe(cfg.napcatDir)
      const argv = cfg.quickLoginQQ ? [exe, String(cfg.quickLoginQQ)] : [exe]

      this.log.info(`启动 NapCat：${exe}${cfg.quickLoginQQ ? `（快速登录 ${cfg.quickLoginQQ}）` : ''}`)
      // graceMs = 5s 宽限；stdin/stdout/stderr 全部 ignore：
      // NapCat 是 GUI/托盘程序，不需要我们的 stdio，也不需要读它的输出（日志它自己写）。
      const handle = this.subprocess.spawn({
        argv,
        cwd: dir,
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        graceMs: STOP_GRACE_MS,
      })
      this.handle = handle
      this._alive = true
      this.startedAt = Date.now()
      this.lastError = null

      // 观察退出：进程自己挂了就把状态置空，避免 UI 一直显示「运行中」
      handle.done.then((outcome) => {
        this._alive = false
        this.handle = null
        this.log.warn(`NapCat 进程已退出（code=${outcome?.exitCode} signal=${outcome?.signal}）`)
      }).catch((error) => {
        this._alive = false
        this.handle = null
        this.lastError = error?.message ?? String(error)
        this.log.error(`NapCat 进程异常：${this.lastError}`)
      })

      // 等端口真的起来（最多 ~8s），让调用方拿到有意义的结果
      const deadline = Date.now() + 8000
      let listening = false
      while (Date.now() < deadline) {
        if (await isPortListening(cfg.wsPort, '127.0.0.1', 400)) { listening = true; break }
        if (!this.processAlive) break
        await new Promise((r) => setTimeout(r, 400))
      }

      if (!listening && !this.processAlive) {
        return { ok: false, action: 'exited-early', detail: 'NapCat 启动后立即退出，检查目录与 QQ 登录状态' }
      }
      return { ok: true, action: 'started', listening }
    } catch (error) {
      this.lastError = error?.message ?? String(error)
      this.log.error(`启动 NapCat 失败：${this.lastError}`)
      return { ok: false, action: 'failed', detail: this.lastError }
    } finally {
      this._busy = false
    }
  }

  /**
   * 停止 NapCat。
   *
   * 顺序（要求：先 SIGTERM，5 秒宽限后强制杀树）：
   *   ① `handle.terminate()` —— DSH 的 subprocess 在 Windows 上托管 Job Object，
   *      terminate 会按 provider 的 graceMs 先发 TERM、宽限后 KILL，并收整棵树。
   *   ② 若 terminate 后进程仍在（极端情况：Job 未收住），回退到
   *      `taskkill /PID <pid> /T /F` 强杀进程树。
   * @returns {Promise<{ok:boolean, action:string, detail?:string}>}
   */
  async stop() {
    if (this._busy) return { ok: false, action: 'busy', detail: '已有启动/停止操作在进行' }
    this._busy = true
    try {
      const handle = this.handle
      if (handle === null) {
        return { ok: true, action: 'not-managed', detail: '当前没有由本插件管理的 NapCat 进程' }
      }
      this.log.info('停止 NapCat（TERM → 5s 宽限 → KILL）…')
      try {
        handle.terminate()
      } catch (error) {
        this.log.warn(`terminate 调用失败：${error?.message ?? error}`)
      }

      // 等真实退出（terminate 的 graceMs 已含 5s 宽限，这里再给一点余量）
      let exited = false
      try {
        exited = await handle.waitForExit(AbortSignal.timeout(STOP_GRACE_MS + 3000))
      } catch { /* 超时 */ }

      if (!exited) {
        // 回退：强制杀进程树
        this.log.warn('宽限内未退出，回退强制结束进程树')
        await this._taskkill()
        try { await handle.waitForExit(AbortSignal.timeout(3000)) } catch { /* 尽力而为 */ }
      }

      this.handle = null
      this._alive = false
      this.startedAt = null
      this.log.info('NapCat 已停止')
      return { ok: true, action: 'stopped' }
    } catch (error) {
      this.lastError = error?.message ?? String(error)
      this.log.error(`停止 NapCat 失败：${this.lastError}`)
      return { ok: false, action: 'failed', detail: this.lastError }
    } finally {
      this._busy = false
    }
  }

  /**
   * 强制杀进程树（回退路径）。
   *
   * ⚠️ `SubprocessHandle` **不暴露 pid**（只有 terminal handle 有 `pid`），
   * 所以拿不到「本插件起的那个 pid」。回退只能按**映像名**杀：
   * `taskkill /IM NapCatWinBootMain.exe /T /F`。
   * 这是个有副作用的选择（可能命中别人起的同名进程），
   * 因此只在「terminate + 宽限后仍未退出」这种异常路径才走。
   */
  async _taskkill() {
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const run = promisify(execFile)
      await run('taskkill', ['/IM', 'NapCatWinBootMain.exe', '/T', '/F'], { windowsHide: true })
      this.log.warn('已按映像名强制结束 NapCat 进程树（NapCatWinBootMain.exe）')
    } catch (error) {
      // taskkill 在「没有找到该进程」时也会非零退出，这不算失败
      this.log.warn(`taskkill 回退未成功（可能进程已退出）：${error?.message ?? error}`)
    }
  }

  /**
   * 三层在线判定 + 状态快照（给 UI 用）。
   * @returns {Promise<object>}
   */
  async snapshot() {
    const cfg = this._cfg()

    // ① 进程存活
    const processAlive = this.processAlive

    // ② WS 端口 LISTENING
    const portListening = await isPortListening(cfg.wsPort)

    // ③ get_status 在线 + 账号
    const probe = await probeOneBotStatus({
      baseUrl: cfg.onebotHttpUrl || undefined,
      accessToken: cfg.accessToken,
    })

    // 「在线」需要三层同时成立。但 get_status 探不到（没开 HTTP API）时，
    // 我们只有前两层 —— 这时保守判为「进程在跑但账号未确认」，
    // 而不是谎报在线，也不是谎报离线。
    let state
    if (!processAlive && !portListening) state = 'stopped'
    else if (!processAlive && portListening) state = 'external' // 别人的 NapCat 在跑（复用模式）
    else if (processAlive && !portListening) state = 'starting'
    else if (probe === null) state = 'running-unverified'
    else state = probe.online ? 'online' : 'offline'

    return {
      state,
      processAlive,
      portListening,
      wsPort: cfg.wsPort,
      quickLoginQQ: cfg.quickLoginQQ,
      napcatDir: cfg.napcatDir,
      selfId: probe?.selfId ?? null,
      nickname: probe?.nickname ?? null,
      probeAvailable: probe !== null,
      startedAt: this.startedAt,
      lastError: this.lastError,
      managed: this.handle !== null,
    }
  }
}
