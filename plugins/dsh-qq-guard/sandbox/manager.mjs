/**
 * Host 侧沙箱管理器。
 *
 * 职责（P1）：
 *   · 用 `ctx.subprocess` 拉起独立的 Node 子进程（绝不 import 外部代码进 DSH）；
 *   · 给子进程加 `--permission` / `--allow-fs-read` / `--disallow-code-generation-from-strings`；
 *   · 管理 NDJSON 请求/响应、5 秒超时、进程崩溃与熔断；
 *   · 对外动作：`testLoad(moduleInfo)`（加载并执行 setup）与
 *     `invoke(payload, opts)`（P2：调已加载模块的 hook / 工具）。
 *
 * 进程模型：全局共享一个沙箱进程，子进程内按 `moduleId` 缓存已加载模块。
 * 一个模块超时/崩溃会连累同一个进程里的其它模块（它们本来也还没执行 hook），
 * 下次请求惰性重启即可；换来的是不用为 14 个模块各开一个进程。
 *
 * @module qq-guard/sandbox/manager
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROTOCOL_VERSION,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_READY_MS,
  FRAME,
  ERR,
  SandboxError,
  encodeFrame,
  createLineDecoder,
} from './protocol.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CHILD_ENTRY = path.join(HERE, 'child.mjs')

/** 连续失败多少次触发熔断。 */
export const MAX_CONSECUTIVE_FAILURES = 5
/** 熔断冷却时间（对齐侦察报告 §12.6）。 */
export const BREAKER_COOLDOWN_MS = 5 * 60_000
/** invoke 的默认超时：hook 由调用方传 1500ms，工具代理传 10s，这里只是兜底。 */
export const DEFAULT_INVOKE_TIMEOUT_MS = 5000
const STDERR_TAIL_LINES = 40
const LOG_TAIL_LINES = 50

export class SandboxManager {
  /**
   * @param {object} options
   * @param {object} options.subprocess ctx.subprocess
   * @param {object} [options.logger]
   * @param {() => string[]} [options.getRoots] 允许 import 的外部根目录（每次 spawn 现读）
   * @param {string} [options.nodePath] 测试/覆盖用；不传则走 resolveNode 链
   * @param {object} [options.nodeEnv] 配合 nodePath 的额外 env
   * @param {number} [options.requestTimeoutMs]
   * @param {number} [options.readyTimeoutMs]
   * @param {number} [options.maxFailures]
   * @param {number} [options.breakerCooldownMs]
   * @param {(frame:object)=>void} [options.onFrame] 观察日志/事件（可选）
   */
  constructor({
    subprocess,
    logger,
    getRoots,
    nodePath,
    nodeEnv,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    readyTimeoutMs = MAX_READY_MS,
    maxFailures = MAX_CONSECUTIVE_FAILURES,
    breakerCooldownMs = BREAKER_COOLDOWN_MS,
    onFrame,
  }) {
    this.subprocess = subprocess
    this.logger = logger ?? { info() {}, warn() {}, error() {} }
    this.getRoots = getRoots ?? (() => [])
    this.nodeOverride = nodePath ? { execPath: nodePath, env: nodeEnv ?? {} } : null
    this.requestTimeoutMs = requestTimeoutMs
    this.readyTimeoutMs = readyTimeoutMs
    this.maxFailures = maxFailures
    this.breakerCooldownMs = breakerCooldownMs
    this.onFrame = onFrame

    /** @type {'stopped'|'starting'|'ready'|'dead'} */
    this.state = 'stopped'
    /** @type {object|null} */
    this.handle = null
    this.starting = null
    /** @type {{execPath:string, env:object}|null} */
    this.node = null
    /** @type {object|null} ready 帧里的 pid/node 信息 */
    this.nodeInfo = null
    this.seq = 0
    /** @type {null|{id:string,type:string,timer:any,resolve:Function,reject:Function,startedAt:number}} */
    this.inflight = null
    /** @type {Map<string, number>} moduleId → 连续失败次数 */
    this.failures = new Map()
    /** @type {Map<string, number>} moduleId → 熔断截止时间戳 */
    this.breakerUntil = new Map()
    /** @type {string[]} */
    this.stderrTail = []
    /** @type {string[]} */
    this.logTail = []
    this._readyWaiter = null
    this._disposed = false
  }

  /** 当前是否有一个活着的沙箱进程。 */
  get alive() {
    return this.state === 'ready' && this.handle !== null
  }

  /**
   * 找 node 可执行文件：显式覆盖 → resolveExecutable → DSH 自带 runtime
   * → Electron 自身（ELECTRON_RUN_AS_NODE）。
   *
   * @returns {Promise<{execPath:string, env:object}>}
   */
  async resolveNode() {
    if (this.node) return this.node
    if (this.nodeOverride) {
      this.node = this.nodeOverride
      return this.node
    }

    const candidates = []
    if (typeof process.env.QQG_SANDBOX_NODE === 'string' && process.env.QQG_SANDBOX_NODE) {
      candidates.push({ execPath: process.env.QQG_SANDBOX_NODE, env: {} })
    }
    try {
      if (typeof this.subprocess?.resolveExecutable === 'function') {
        const resolved = await this.subprocess.resolveExecutable('node')
        if (resolved) candidates.push({ execPath: resolved, env: {} })
      }
    } catch { /* PATH 里没有 node，继续试其它来源 */ }
    if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
      candidates.push({
        execPath: path.join(
          process.resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin',
          process.platform === 'win32' ? 'node.exe' : 'node',
        ),
        env: {},
      })
    }
    if (process.versions?.electron) {
      candidates.push({ execPath: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } })
    }

    for (const candidate of candidates) {
      try {
        if (candidate.execPath && fs.statSync(candidate.execPath).isFile()) {
          this.node = candidate
          return candidate
        }
      } catch { /* 下一个候选 */ }
    }
    throw new SandboxError(ERR.NO_NODE, '找不到可用的 node 可执行文件')
  }

  /** 组装 spawn 参数；权限白名单只给「沙箱目录 + 外部根」，默认无写权限。 */
  _spawnSpec(node) {
    const roots = this.getRoots()
      .filter((root) => typeof root === 'string' && root)
      .map((root) => path.resolve(root))
    const readRoots = [...new Set([HERE, ...roots])]
    return {
      argv: [
        node.execPath,
        '--permission',
        ...readRoots.map((root) => `--allow-fs-read=${root}`),
        '--disallow-code-generation-from-strings',
        CHILD_ENTRY,
      ],
      cwd: HERE,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 1500,
      env: node.env,
    }
  }

  /** 拉起子进程并等待 ready；超时/提前退出都会杀进程。 */
  async _spawn() {
    if (this._disposed) throw new SandboxError(ERR.SANDBOX_EXIT, '沙箱管理器已销毁')
    const node = await this.resolveNode()
    const spec = this._spawnSpec(node)
    this.stderrTail = []
    this.logTail = []
    this.state = 'starting'

    let handle
    try {
      handle = this.subprocess.spawn(spec)
    } catch (error) {
      this.state = 'dead'
      throw new SandboxError(ERR.SANDBOX_START, `spawn 失败：${error?.message ?? error}`)
    }
    if (!handle || !handle.stdout || !handle.stdin) {
      this.state = 'dead'
      try { handle?.terminate?.() } catch { /* 尽力 */ }
      throw new SandboxError(ERR.SANDBOX_START, 'subprocess 句柄缺少 stdin/stdout（需要 pipe 模式）')
    }
    this.handle = handle

    const ready = new Promise((resolve, reject) => {
      this._readyWaiter = { resolve, reject, settled: false }
    })
    const settleReady = (error) => {
      const waiter = this._readyWaiter
      if (!waiter || waiter.settled) return
      waiter.settled = true
      if (error) waiter.reject(error)
      else waiter.resolve()
    }

    const decoder = createLineDecoder({
      onFrame: (frame) => this._onFrame(frame),
      onError: (error) => {
        this._pushLog(`[protocol] ${error.message}`)
        this._kill('protocol-error')
      },
    })
    handle.stdout.setEncoding?.('utf8')
    handle.stdout.on('data', (chunk) => decoder.push(chunk))
    handle.stdout.on?.('error', () => { /* 进程退出时流会报错，忽略 */ })
    if (handle.stderr) {
      handle.stderr.setEncoding?.('utf8')
      handle.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (!line) continue
          this.stderrTail.push(line)
          if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
        }
      })
      handle.stderr.on?.('error', () => { /* 忽略 */ })
    }

    handle.done.then(
      (outcome) => this._onExit(handle, outcome),
      (error) => this._onExit(handle, { error }),
    )

    const timer = setTimeout(() => {
      settleReady(new SandboxError(ERR.SANDBOX_START, `沙箱 ${this.readyTimeoutMs}ms 内未就绪`))
      this._kill('ready-timeout')
    }, this.readyTimeoutMs)

    try {
      await ready
      this.state = 'ready'
      // ready 之后先把允许目录下发下去，再允许 load。
      const roots = [...new Set([HERE, ...this.getRoots().map((root) => path.resolve(root))])]
      this._write({ v: PROTOCOL_VERSION, type: FRAME.INIT, payload: { allowedRoots: roots } })
    } finally {
      clearTimeout(timer)
      if (this._readyWaiter) this._readyWaiter = null
    }
  }

  /** 确保沙箱就绪（并发调用复用同一个 starting Promise）。 */
  async ensure() {
    if (this.state === 'ready' && this.handle) return
    if (this.starting) return this.starting
    this.starting = this._spawn()
      .catch((error) => {
        this.state = 'dead'
        this.handle = null
        throw error
      })
      .finally(() => { this.starting = null })
    return this.starting
  }

  /** 往子进程写一帧（失败按进程已退出处理）。 */
  _write(frame) {
    if (!this.handle) throw new SandboxError(ERR.SANDBOX_EXIT, '沙箱进程不在')
    try {
      this.handle.stdin.write(encodeFrame(frame))
    } catch (error) {
      throw new SandboxError(ERR.SANDBOX_EXIT, `写入沙箱失败：${error?.message ?? error}`)
    }
  }

  /** 处理子进程发来的一帧。 */
  _onFrame(frame) {
    if (frame.type === FRAME.READY) {
      this.nodeInfo = frame.payload ?? null
      const waiter = this._readyWaiter
      if (frame.payload?.hooks === false) {
        // 老 Node 没有 module.registerHooks：拦截边界不成立，宁可不可用也不降级成「裸跑」。
        if (waiter && !waiter.settled) {
          waiter.settled = true
          waiter.reject(new SandboxError(
            ERR.NO_NODE,
            `node ${frame.payload?.node ?? '?'} 不支持 module.registerHooks（需要 >= 22.15）`,
          ))
        }
        this._kill('node-too-old')
        return
      }
      if (waiter && !waiter.settled) {
        waiter.settled = true
        waiter.resolve()
      }
      return
    }

    if (frame.type === FRAME.LOG || frame.type === FRAME.EVENT) {
      if (frame.type === FRAME.LOG) {
        this._pushLog(`[${frame.level ?? 'info'}] ${frame.message ?? ''}`)
      } else {
        this._pushLog(`[event:${frame.name}] ${frame.payload?.message ?? ''}`)
      }
      try { this.onFrame?.(frame) } catch { /* 观察者异常不影响链路 */ }
      return
    }

    const pending = this.inflight
    if (!pending) return
    if (frame.id !== undefined && frame.id !== pending.id) return
    clearTimeout(pending.timer)
    this.inflight = null
    if (frame.type === FRAME.RESULT) {
      pending.resolve(frame.payload)
    } else {
      pending.reject(new SandboxError(
        frame.error?.code ?? ERR.PROTOCOL,
        frame.error?.message ?? '插件执行失败',
        frame.error?.stack,
      ))
    }
  }

  /**
   * 发一个请求并等待响应（单飞）。超时立即杀进程。
   *
   * @param {string} type
   * @param {object} payload
   * @param {{timeoutMs?:number}} [options]
   * @returns {Promise<object>}
   */
  async request(type, payload, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.inflight) throw new SandboxError(ERR.BUSY, '沙箱正忙，已有在途请求')
    await this.ensure()
    const id = `r${++this.seq}`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.inflight || this.inflight.id !== id) return
        this.inflight = null
        reject(new SandboxError(ERR.TIMEOUT, `${type} 超过 ${timeoutMs}ms 未返回（已终止沙箱）`))
        this._kill(`timeout:${type}`)
      }, timeoutMs)
      this.inflight = { id, type, timer, resolve, reject, startedAt: Date.now() }
      try {
        this._write({ v: PROTOCOL_VERSION, id, type, payload })
      } catch (error) {
        clearTimeout(timer)
        this.inflight = null
        reject(error)
      }
    })
  }

  /**
   * P2：调用一个已加载模块的 hook / 工具（单飞 + 超时 + 熔断沿用）。
   *
   * 与 testLoad 的差别：失败**直接抛** SandboxError（调用方是 hook 路由 / 工具代理，
   * 需要拿到可读错误），成功时返回子进程的 invoke 回包：
   * `{ moduleId, kind, found, value, durationMs }`。
   *
   * @param {{moduleId:string, kind:'hook'|'tool', name?:string, args?:object, event?:object}} payload
   * @param {{timeoutMs?:number}} [options]
   * @returns {Promise<object>}
   */
  async invoke(payload, { timeoutMs = DEFAULT_INVOKE_TIMEOUT_MS } = {}) {
    const moduleId = String(payload?.moduleId ?? '')
    if (!moduleId) throw new SandboxError(ERR.PROTOCOL, 'invoke 缺少 moduleId')
    const until = this.breakerUntil.get(moduleId) ?? 0
    if (Date.now() < until) {
      throw new SandboxError(
        ERR.CIRCUIT_OPEN,
        `该插件连续失败已熔断，约 ${Math.ceil((until - Date.now()) / 1000)}s 后重试`,
      )
    }
    try {
      const result = await this.request(FRAME.INVOKE, payload, { timeoutMs })
      this.failures.delete(moduleId)
      this.breakerUntil.delete(moduleId)
      return result
    } catch (error) {
      this._noteFailure(moduleId)
      throw error
    }
  }

  /** 记一次失败，达到阈值就熔断（testLoad / invoke 共用）。 */
  _noteFailure(moduleId) {
    const fails = (this.failures.get(moduleId) ?? 0) + 1
    this.failures.set(moduleId, fails)
    if (fails >= this.maxFailures) {
      this.breakerUntil.set(moduleId, Date.now() + this.breakerCooldownMs)
      this.failures.set(moduleId, 0)
    }
  }

  /**
   * P1 唯一对外动作：加载模块并执行 setup/register。
   *
   * @param {{id:string, dir:string, entryPath:string, format?:string}} moduleInfo
   * @returns {Promise<{ok:true,result:object}|{ok:false,error:object}>}
   */
  async testLoad(moduleInfo) {
    const moduleId = String(moduleInfo?.id ?? '')
    const until = this.breakerUntil.get(moduleId) ?? 0
    if (Date.now() < until) {
      return {
        ok: false,
        error: {
          code: ERR.CIRCUIT_OPEN,
          message: `该插件连续失败已熔断，约 ${Math.ceil((until - Date.now()) / 1000)}s 后重试`,
        },
      }
    }

    const startedAt = Date.now()
    try {
      const result = await this.request(FRAME.LOAD, {
        moduleId,
        moduleDir: moduleInfo.dir,
        entry: moduleInfo.entryPath,
        format: moduleInfo.format ?? '',
      })
      this.failures.delete(moduleId)
      this.breakerUntil.delete(moduleId)
      return {
        ok: true,
        result: {
          ...result,
          wallMs: Date.now() - startedAt,
          sandbox: {
            pid: this.nodeInfo?.pid ?? null,
            node: this.nodeInfo?.node ?? null,
          },
        },
      }
    } catch (error) {
      this._noteFailure(moduleId)
      return {
        ok: false,
        error: {
          code: error?.code ?? ERR.PROTOCOL,
          message: error?.message ?? String(error),
          detail: error?.detail,
          stderrTail: this.stderrTail.slice(-8),
        },
      }
    }
  }

  /**
   * 进程退出：清句柄、拒绝在途请求、把 ready waiter 叫醒。
   *
   * ⚠️ 必须按 handle 身份判断：超时杀掉旧进程后可能已经拉起了新进程，
   * 旧 handle 的 done 晚到不能把新句柄清掉（否则下一次请求会莫名 E_SANDBOX_EXIT）。
   */
  _onExit(handle, outcome) {
    if (handle !== this.handle) return
    const wasReady = this.state === 'ready'
    this.handle = null
    this.state = 'dead'
    const waiter = this._readyWaiter
    if (waiter && !waiter.settled) {
      waiter.settled = true
      waiter.reject(new SandboxError(ERR.SANDBOX_EXIT, '沙箱进程提前退出'))
    }
    if (this.inflight) {
      clearTimeout(this.inflight.timer)
      this.inflight.reject(new SandboxError(ERR.SANDBOX_EXIT, '沙箱进程已退出'))
      this.inflight = null
    }
    if (wasReady) {
      const detail = outcome?.error ? `：${outcome.error?.message ?? outcome.error}` : `（code=${outcome?.exitCode ?? '?'}）`
      this._pushLog(`[sandbox] 进程已退出${detail}`)
    }
  }

  /** 主动杀进程（超时/协议错误/dispose）。 */
  _kill(reason) {
    this._pushLog(`[sandbox] 终止：${reason}`)
    const handle = this.handle
    this.handle = null
    this.state = 'stopped'
    const waiter = this._readyWaiter
    if (waiter && !waiter.settled) {
      waiter.settled = true
      waiter.reject(new SandboxError(ERR.SANDBOX_EXIT, `沙箱已终止：${reason}`))
    }
    try { handle?.terminate?.() } catch { /* 已死 */ }
  }

  _pushLog(line) {
    const text = String(line ?? '').trimEnd()
    if (!text) return
    this.logTail.push(text)
    if (this.logTail.length > LOG_TAIL_LINES) this.logTail.shift()
    this.logger?.info?.(`[qq-guard][sandbox] ${text}`)
  }

  /** 给 UI/诊断用的快照。 */
  snapshot() {
    return {
      state: this.state,
      alive: this.alive,
      pid: this.nodeInfo?.pid ?? null,
      node: this.nodeInfo?.node ?? null,
      busy: this.inflight !== null,
      logTail: [...this.logTail],
      stderrTail: [...this.stderrTail],
      breaker: [...this.breakerUntil.entries()].map(([id, until]) => ({ id, until })),
    }
  }

  /** 插件卸载/DSH 退出时清理，绝不留孤儿进程。 */
  async dispose() {
    this._disposed = true
    const handle = this.handle
    this._kill('dispose')
    if (handle && typeof handle.waitForExit === 'function') {
      try { await handle.waitForExit(AbortSignal.timeout(2000)) } catch { /* 宽限内没退就算了 */ }
    }
  }
}
