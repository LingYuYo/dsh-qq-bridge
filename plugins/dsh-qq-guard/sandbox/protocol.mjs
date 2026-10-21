/**
 * 沙箱通信协议（Host ↔ 子进程，NDJSON / v1）。
 *
 * 设计要点：
 *   · 一行一条 JSON，UTF-8；请求/响应靠 `id` 关联，日志/事件是无 id 的单向帧。
 *   · 协议纯函数、零依赖、node: 内置模块之外不 import 任何东西 —— Host 和
 *     沙箱子进程共用同一份实现，避免两边分帧规则漂移。
 *   · 单帧大小有硬上限：超限按协议错误处理，调用方应当杀掉子进程（fail-closed）。
 *
 * 帧类型：
 *   child → host  ready / log / event / result / error
 *   host → child  init / load / invoke(预留) / shutdown(预留)
 *
 * @module qq-guard/sandbox/protocol
 */

export const PROTOCOL_VERSION = 1

/** 单次请求的默认超时（毫秒）：到点由 Host 杀进程，不等子进程回话。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000
/** 子进程启动后等待 ready 的上限。 */
export const MAX_READY_MS = 5000
/** 单帧字节上限（日志会被截断，协议帧超限直接判错）。 */
export const MAX_FRAME_BYTES = 256 * 1024

export const FRAME = {
  READY: 'ready',
  LOG: 'log',
  EVENT: 'event',
  RESULT: 'result',
  ERROR: 'error',
  INIT: 'init',
  LOAD: 'load',
}

export const ERR = {
  PROTOCOL: 'E_PROTOCOL',
  FRAME_TOO_LARGE: 'E_FRAME_TOO_LARGE',
  TIMEOUT: 'E_TIMEOUT',
  BUSY: 'E_BUSY',
  SANDBOX_START: 'E_SANDBOX_START',
  SANDBOX_EXIT: 'E_SANDBOX_EXIT',
  CIRCUIT_OPEN: 'E_CIRCUIT_OPEN',
  NO_NODE: 'E_NO_NODE',
  ENTRY_MISSING: 'E_ENTRY_MISSING',
  ENTRY_ESCAPE: 'E_ENTRY_ESCAPE',
  BLOCKED_IMPORT: 'E_BLOCKED_IMPORT',
  IMPORT_FAILED: 'E_IMPORT',
  SETUP_FAILED: 'E_SETUP',
  BAD_EXPORTS: 'E_BAD_EXPORTS',
  NOT_SELF_CONTAINED: 'E_NOT_SELF_CONTAINED',
  UNSUPPORTED_API: 'E_UNSUPPORTED_API',
}

/** 沙箱内的可预期错误：带稳定错误码，Host/UI 只认 code，不解析 message。 */
export class SandboxError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {unknown} [detail]
   */
  constructor(code, message, detail) {
    super(message)
    this.name = 'SandboxError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 序列化一帧。
 * @param {object} frame
 * @returns {string} 带换行的一行 JSON
 */
export function encodeFrame(frame) {
  return JSON.stringify(frame) + '\n'
}

/**
 * 行分隔解码器。Host 读子进程 stdout、子进程读 stdin 都用它。
 *
 * 注意：回调是同步的；异步处理（load）由调用方自己排队，避免乱序。
 *
 * @param {object} options
 * @param {(frame:object)=>void} options.onFrame
 * @param {(error:SandboxError)=>void} [options.onError]
 * @param {number} [options.maxBytes]
 * @returns {{push:(chunk:string|Buffer)=>void, pending:()=>string}}
 */
export function createLineDecoder({ onFrame, onError, maxBytes = MAX_FRAME_BYTES }) {
  let buf = ''

  const fail = (code, message) => {
    try { onError?.(new SandboxError(code, message)) } catch { /* 回调本身异常不扩大故障 */ }
  }

  return {
    push(chunk) {
      buf += String(chunk ?? '')
      // 4 倍上限还没出现换行：视为协议失序，直接丢缓冲并报错。
      if (buf.length > maxBytes * 4) {
        buf = ''
        fail(ERR.FRAME_TOO_LARGE, `帧缓冲超过 ${maxBytes * 4} 字节仍未出现换行`)
        return
      }
      let index
      while ((index = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, index).replace(/\r$/, '')
        buf = buf.slice(index + 1)
        if (!line.trim()) continue
        if (line.length > maxBytes) {
          fail(ERR.FRAME_TOO_LARGE, `单帧 ${line.length} 字节，超过 ${maxBytes}`)
          continue
        }
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          fail(ERR.PROTOCOL, '收到非 JSON 行')
          continue
        }
        if (!frame || frame.v !== PROTOCOL_VERSION || typeof frame.type !== 'string') {
          fail(ERR.PROTOCOL, '帧缺少 v/type 或版本不匹配')
          continue
        }
        onFrame(frame)
      }
    },
    pending() { return buf },
  }
}
