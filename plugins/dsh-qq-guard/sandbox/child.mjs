/**
 * 沙箱子进程入口（零外部依赖）。
 *
 * 启动方式（Host 侧 `manager.mjs`）：
 *   node --permission --allow-fs-read=<sandbox 目录> --allow-fs-read=<外部根>
 *        --disallow-code-generation-from-strings ./sandbox/child.mjs
 *
 * 安全边界分四层：
 *   ① 这个进程只通过 stdio 和 Host 通信，绝不在 DSH 主进程里 import 外部代码；
 *   ② Node `--permission` 限制文件读写、子进程、worker 等原生能力；
 *   ③ `module.registerHooks` 拦截 node:fs / child_process / net / vm / module 等
 *      危险内置模块，以及越出允许目录的相对引用（../../src/*）；
 *   ④ 这里补运行期兜底（process.getBuiltinModule、stdout 协议污染）。
 *
 * 协议详见 ./protocol.mjs：ready / init / load / log / result / error。
 *
 * @module qq-guard/sandbox/child
 */

import process from 'node:process'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION, FRAME, ERR, SandboxError, encodeFrame, createLineDecoder } from './protocol.mjs'

/* ── 协议输出：先抓住真实写口，再把 process.stdout 换成日志管道 ────────── */

const rawWrite = process.stdout.write.bind(process.stdout)

/**
 * 往 Host 发一帧。所有协议输出都走这个函数。
 * @param {object} frame
 */
function send(frame) {
  try {
    rawWrite(encodeFrame({ v: PROTOCOL_VERSION, ...frame }))
  } catch {
    // 管道已断（Host 死了/被杀）—— 子进程没有继续存在的意义。
    process.exit(0)
  }
}

// 插件里的 console.log / 直接 process.stdout.write 全部转成 log 帧，
// 否则一行普通文本就会让 Host 的分帧器报协议错误。
process.stdout.write = (chunk, encoding, callback) => {
  send({
    type: FRAME.LOG,
    level: 'stdout',
    message: String(chunk ?? '').replace(/\r?\n$/, ''),
  })
  if (typeof encoding === 'function') encoding()
  else if (typeof callback === 'function') callback()
  return true
}

/** 运行时兜底：阻断绕过 import 拦截直接取内置模块的入口。 */
try { delete process.getBuiltinModule } catch { /* 属性不可删时忽略 */ }

/* ── 允许目录与拦截规则 ────────────────────────────────────────────── */

/** 允许被 import 的根目录（init 帧下发；沙箱自身目录自动加入）。 */
let allowedRoots = []
/** 当前正在加载的模块目录：相对引用只允许落在这里面（拦 ../../src/*）。 */
let activeModuleDir = null
let initialized = false

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))
if (!allowedRoots.includes(SELF_DIR)) allowedRoots.push(SELF_DIR)

/**
 * 判断文件是否在目录内（同盘符、大小写按平台处理交给 path.relative）。
 * @param {string} dir
 * @param {string} file
 * @returns {boolean}
 */
function insideDir(dir, file) {
  const target = path.resolve(file)
  const rel = path.relative(path.resolve(dir), target)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

/**
 * 判断文件是否在允许目录内（模块入口 / init 下发的根目录）。
 * @param {string} file
 * @returns {boolean}
 */
function insideAllowed(file) {
  return allowedRoots.some((root) => insideDir(root, file))
}

/**
 * 危险内置模块：命中即抛错（不是 shim，直接让 import 失败，fail-closed）。
 *
 * 为什么不返回假模块：空模块会让插件在运行期拿着 undefined 继续跑，
 * 行为更难预测；直接报 `E_BLOCKED_IMPORT` 才是明确边界。
 */
const BLOCKED_BUILTINS = new Set([
  'fs', 'node:fs', 'fs/promises', 'node:fs/promises',
  'child_process', 'node:child_process',
  'cluster', 'node:cluster',
  'worker_threads', 'node:worker_threads',
  'net', 'node:net', 'tls', 'node:tls', 'dgram', 'node:dgram',
  'http', 'node:http', 'https', 'node:https', 'http2', 'node:http2',
  'inspector', 'node:inspector', 'vm', 'node:vm', 'module', 'node:module',
])

registerHooks({
  resolve(specifier, context, nextResolve) {
    const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier
    if (BLOCKED_BUILTINS.has(specifier) || BLOCKED_BUILTINS.has(bare)) {
      throw new Error(`${ERR.BLOCKED_IMPORT}: sandbox 拦截了对 ${specifier} 的引用`)
    }
    const resolved = nextResolve(specifier, context)
    // 只处理落到真实文件的解析结果（相对路径 / 绝对路径 / file: URL 都覆盖）；
    // 用 resolved.url 判断，避免插件用 `import('file:///...')` 绕过相对路径检查。
    if (typeof resolved?.url === 'string' && resolved.url.startsWith('file:')) {
      let file
      try {
        const url = new URL(resolved.url)
        url.search = ''
        url.hash = ''
        file = fileURLToPath(url)
      } catch {
        return resolved
      }
      if (!insideAllowed(file)) {
        throw new Error(`${ERR.BLOCKED_IMPORT}: 引用越出允许目录 ${file}`)
      }
      // 正在加载某个模块时，文件必须落在该模块目录内：
      // 拦 ../../src/* 这类「仍在应用根、但不是插件自己的代码」的宿主内部引用。
      if (activeModuleDir !== null && !insideDir(activeModuleDir, file)) {
        throw new Error(`${ERR.BLOCKED_IMPORT}: 引用越出模块目录 ${file}`)
      }
    }
    return resolved
  },
})

/* ── 极简 api（只记录，不假装实现）──────────────────────────────────── */

/** 安全 JSON 序列化（循环引用/异常对象不会把日志帧搞炸）。 */
function formatArg(value) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

/**
 * 构造注入给插件的 api。P1 只保证 setup(api) 不因缺方法而抛错：
 * 未实现的能力返回 undefined 并记进 apiCalls，真正的执行留到后续阶段。
 *
 * @param {string} moduleId
 * @param {object} manifest 仅用于 config() 的默认值
 * @param {object[]} tools 收集 registerTool 的声明
 */
function makeApi(moduleId, manifest, tools) {
  const calls = []
  /** 记录插件碰过哪些 api（去重，避免 100 条日志刷满结果）。 */
  const note = (name) => { if (!calls.includes(name)) calls.push(name) }
  const log = (level) => (...args) => {
    note('log')
    send({
      type: FRAME.LOG, level, moduleId, message: args.map(formatArg).join(' '),
    })
  }
  const unsupported = (name) => (...args) => {
    note(`unsupported:${name}`)
    void args
    return undefined
  }
  const memory = new Map()

  return {
    log: log('info'),
    warn: log('warn'),
    error: log('error'),
    config: () => {
      note('config')
      return { ...(manifest?.settings ?? {}) }
    },
    registerTool: (def) => {
      note('registerTool')
      const toolId = `${moduleId}__${String(def?.id ?? def?.name ?? 'tool')}`
      tools.push({ id: toolId, def })
      return toolId
    },
    storage: {
      get: (key) => { note('storage'); return memory.get(String(key)) },
      set: (key, value) => { note('storage'); memory.set(String(key), value) },
      remove: (key) => { note('storage'); memory.delete(String(key)) },
    },
    hasCapability: () => { note('hasCapability'); return false },
    isSkillActive: () => { note('isSkillActive'); return false },
    capability: unsupported('capability'),
    panel: { id: moduleId, prefix: '', url: '', dataUrl: '' },
    fetch: unsupported('fetch'),
    qqCall: unsupported('qqCall'),
    utils: {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Number(ms) || 0)),
      safeJsonParse: (text, fallback) => { try { return JSON.parse(text) } catch { return fallback } },
    },
    // 内部字段：result 里回给 Host / UI，便于确认插件到底碰了哪些能力。
    __calls: calls,
  }
}

/** 汇总入口导出的形状（不执行任何导出函数）。 */
function summarizeExports(mod) {
  const hookNames = mod.hooks && typeof mod.hooks === 'object' ? Object.keys(mod.hooks) : []
  return {
    setup: typeof mod.setup === 'function',
    register: typeof mod.register === 'function',
    activate: typeof mod.activate === 'function',
    deactivate: typeof mod.deactivate === 'function',
    dispose: typeof mod.dispose === 'function',
    promptSections: typeof mod.promptSections === 'function',
    available: typeof mod.available === 'function',
    // hook 既可以是 `export const hooks = { onMessage }`，也可以直接顶层导出函数；
    // 两种形态都要报给 Host（Host 据此决定要不要为这条 hook 发 invoke）。
    hooks: [...new Set([
      ...hookNames,
      ...TOP_LEVEL_HOOK_NAMES.filter((name) => typeof mod[name] === 'function'),
    ])],
    providers: mod.providers && typeof mod.providers === 'object' ? Object.keys(mod.providers) : [],
  }
}

/**
 * 顶层导出的 hook 别名（与 `hooks` 对象的键等价）。
 *
 * P2 起 Host 会对每个已加载模块发 `invoke`，child 按这里的顺序找可调用函数；
 * 找不到就回 `found:false`，不算错误。
 */
const TOP_LEVEL_HOOK_NAMES = ['onMessage', 'beforeContext', 'before-context', 'message']

/** 每种事件允许的 hook 名（顺序即优先级，与契约 4.2 一致）。 */
const HOOK_ALIASES = {
  message: ['message', 'onMessage', 'beforeContext'],
  'before-context': ['before-context', 'beforeContext', 'onMessage'],
}

/**
 * 在模块命名空间里找某事件的 hook。
 * @param {object} mod 模块 namespace
 * @param {string} event 事件名
 * @returns {Function|null}
 */
function resolveHook(mod, event) {
  const hooks = mod?.hooks && typeof mod.hooks === 'object' ? mod.hooks : null
  const names = HOOK_ALIASES[event] ?? [String(event)]
  for (const name of names) {
    if (hooks && typeof hooks[name] === 'function') return hooks[name]
  }
  for (const name of names) {
    if (typeof mod?.[name] === 'function') return mod[name]
  }
  return null
}

/**
 * 把 invoke 的返回值压成 JSON 可序列化值（循环引用 / BigInt → E_BAD_RESULT）。
 * @param {unknown} value
 * @returns {unknown}
 */
function toSerializable(value) {
  if (value === undefined) return null
  let json
  try {
    json = JSON.stringify(value)
  } catch (error) {
    throw new SandboxError(ERR.BAD_RESULT, `返回值不能 JSON 序列化：${error?.message ?? error}`)
  }
  if (json === undefined) return null
  try { return JSON.parse(json) } catch (error) {
    throw new SandboxError(ERR.BAD_RESULT, `返回值不能 JSON 序列化：${error?.message ?? error}`)
  }
}

/** registerTool 收集到的声明 → 回给 Host 的工具元数据（供代理工具注册）。 */
function summarizeTools(tools) {
  return tools.map(({ id, def }) => ({
    id,
    name: String(def?.name ?? def?.id ?? id),
    description: String(def?.description ?? ''),
    // parameters 原样回传：既可能是 JSON Schema，也可能是作者 spec，Host 侧适配。
    parameters: def?.parameters ?? def?.inputSchema,
  }))
}

/**
 * 已加载模块缓存：重复点「测试运行」/常驻重载不重复执行 setup。
 *
 * P2 起 value 不再只是回给 Host 的结果，还保留 `ns`（模块命名空间）、`api`
 * 和 `tools`（registerTool 收集到的声明 + handler）：`invoke` 帧要靠它们
 * 找到 hook / 工具并执行。
 *
 * @type {Map<string, {result:object, ns:object, api:object, tools:object[]}>}
 */
const loaded = new Map()

/**
 * 处理 load 请求。
 * @param {object} payload { moduleId, moduleDir, entry, format }
 * @returns {Promise<object>} 回给 Host 的结果 payload
 */
async function handleLoad(payload) {
  const moduleId = String(payload?.moduleId ?? '')
  const moduleDir = path.resolve(String(payload?.moduleDir ?? ''))
  const entry = path.resolve(String(payload?.entry ?? ''))
  if (!moduleId) throw new SandboxError(ERR.PROTOCOL, 'load 缺少 moduleId')
  if (!insideAllowed(moduleDir) || !insideAllowed(entry)) {
    throw new SandboxError(ERR.ENTRY_ESCAPE, '模块目录或入口越出允许目录')
  }
  const rel = path.relative(moduleDir, entry)
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new SandboxError(ERR.ENTRY_ESCAPE, '入口不在模块目录内')
  }

  const cached = loaded.get(moduleId)
  if (cached) return { ...cached.result, cached: true }

  // 从 import 到 setup 结束都锁定「当前模块目录」：期间动态 import 的相对路径
  // 也必须在模块目录内，不能借 ../../src/* 摸回宿主内部模块。
  const previousModuleDir = activeModuleDir
  activeModuleDir = moduleDir
  try {
    const startedAt = Date.now()
    const url = pathToFileURL(entry).href + `?t=${Date.now()}`

    let mod
    try {
      mod = await import(url)
    } catch (error) {
      // registerHooks 抛出的错误会原样到达这里；保留 code 让 Host 区分「被拦」与「代码炸了」。
      const blocked = String(error?.message ?? '').startsWith(ERR.BLOCKED_IMPORT)
      throw new SandboxError(
        blocked ? ERR.BLOCKED_IMPORT : ERR.IMPORT_FAILED,
        `import 失败：${error?.message ?? error}`,
        String(error?.stack ?? '').split('\n').slice(0, 3).join('\n'),
      )
    }

    const summary = summarizeExports(mod)
    if (!summary.setup && !summary.register && !summary.activate
      && summary.hooks.length === 0 && summary.providers.length === 0) {
      throw new SandboxError(ERR.BAD_EXPORTS, '入口没有导出 setup/register/activate/hooks/providers')
    }

    const tools = []
    const api = makeApi(moduleId, {}, tools)
    try {
      if (summary.setup) await mod.setup(api)
      else if (summary.register) await mod.register(api)
    } catch (error) {
      // setup 里的动态 import 也可能被 registerHooks 拦下：保留 E_BLOCKED_IMPORT，
      // 别把它混成「插件代码写错了」。
      const blocked = String(error?.message ?? '').includes(ERR.BLOCKED_IMPORT)
      throw new SandboxError(
        blocked ? ERR.BLOCKED_IMPORT : ERR.SETUP_FAILED,
        `setup 抛出异常：${error?.message ?? error}`,
        String(error?.stack ?? '').split('\n').slice(0, 3).join('\n'),
      )
    }

    const result = {
      moduleId,
      format: String(payload?.format ?? ''),
      exports: summary,
      apiCalls: api.__calls,
      toolCount: tools.length,
      // P2：把注册的工具回给 Host（代理工具 qq_ext_<slug> 靠它建 schema）。
      tools: summarizeTools(tools),
      durationMs: Date.now() - startedAt,
    }
    loaded.set(moduleId, { result, ns: mod, api, tools })
    return result
  } finally {
    activeModuleDir = previousModuleDir
  }
}

/**
 * 处理 invoke 请求（P2）。
 *
 * payload：`{ moduleId, kind:'hook'|'tool', name?, args?, event? }`
 * 回包：`{ moduleId, kind, found, value, durationMs }`；找不到 hook/tool 时
 * `found:false`（不是错误），插件自己抛错则是 `E_INVOKE`。
 *
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function handleInvoke(payload) {
  const moduleId = String(payload?.moduleId ?? '')
  const kind = String(payload?.kind ?? '')
  if (!moduleId) throw new SandboxError(ERR.PROTOCOL, 'invoke 缺少 moduleId')
  const record = loaded.get(moduleId)
  if (!record) throw new SandboxError(ERR.NOT_LOADED, `模块没有加载过：${moduleId}`)
  const startedAt = Date.now()

  if (kind === 'hook') {
    const eventName = String(payload?.name ?? 'message')
    const hook = resolveHook(record.ns, eventName)
    if (hook === null) {
      return { moduleId, kind, found: false, value: null, durationMs: Date.now() - startedAt }
    }
    let value
    try {
      // 同插件契约：hook 是 `(event, apiLike)`。
      value = await hook(payload?.event ?? {}, record.api)
    } catch (error) {
      throw new SandboxError(
        ERR.INVOKE_FAILED,
        `hook ${eventName} 抛出异常：${error?.message ?? error}`,
        String(error?.stack ?? '').split('\n').slice(0, 3).join('\n'),
      )
    }
    return { moduleId, kind, found: true, value: toSerializable(value), durationMs: Date.now() - startedAt }
  }

  if (kind === 'tool') {
    const wanted = String(payload?.name ?? '')
    const tool = record.tools.find((item) => item.id === wanted)
      ?? record.tools.find((item) => String(item.def?.name ?? item.def?.id ?? '') === wanted)
    if (!tool) throw new SandboxError(ERR.NOT_LOADED, `模块 ${moduleId} 没有工具：${wanted || '(空)'}`)
    const def = tool.def
    const handler = def?.handler ?? def?.execute ?? def?.run
    if (typeof handler !== 'function') {
      throw new SandboxError(ERR.NOT_LOADED, `工具 ${wanted} 没有可执行的 handler`)
    }
    let value
    try {
      value = await handler(payload?.args ?? {}, record.api)
    } catch (error) {
      throw new SandboxError(
        ERR.INVOKE_FAILED,
        `工具 ${wanted} 抛出异常：${error?.message ?? error}`,
        String(error?.stack ?? '').split('\n').slice(0, 3).join('\n'),
      )
    }
    return { moduleId, kind, found: true, value: toSerializable(value), durationMs: Date.now() - startedAt }
  }

  throw new SandboxError(ERR.PROTOCOL, `未知的 invoke kind：${kind || '(空)'}`)
}

/* ── stdin 主循环 ───────────────────────────────────────────────────── */

const decoder = createLineDecoder({
  onFrame(frame) {
    if (frame.type === FRAME.INIT) {
      const roots = Array.isArray(frame.payload?.allowedRoots) ? frame.payload.allowedRoots : []
      for (const root of roots) {
        if (typeof root !== 'string' || !root) continue
        const resolved = path.resolve(root)
        if (!allowedRoots.includes(resolved)) allowedRoots.push(resolved)
      }
      initialized = true
      return
    }

    if (frame.type !== FRAME.LOAD && frame.type !== FRAME.INVOKE) {
      // 其它帧（shutdown 等）留给后续阶段，明确报未实现而不是静默。
      if (frame.id !== undefined) {
        send({
          type: FRAME.ERROR, id: frame.id, ok: false,
          error: { code: ERR.PROTOCOL, message: `暂不支持的帧类型：${frame.type}` },
        })
      }
      return
    }

    // load / invoke 串行执行：同一时刻只处理一个（Host 侧本来也是单飞）。
    if (!initialized) {
      send({
        type: FRAME.ERROR, id: frame.id, ok: false,
        error: { code: ERR.PROTOCOL, message: '沙箱尚未收到 init 帧' },
      })
      return
    }

    const task = frame.type === FRAME.INVOKE
      ? handleInvoke(frame.payload)
      : handleLoad(frame.payload)
    void task.then(
      (payload) => send({ type: FRAME.RESULT, id: frame.id, ok: true, payload }),
      (error) => send({
        type: FRAME.ERROR,
        id: frame.id,
        ok: false,
        error: {
          code: error?.code ?? ERR.PROTOCOL,
          message: error?.message ?? String(error),
          stack: String(error?.stack ?? '').split('\n').slice(0, 3).join('\n'),
        },
      }),
    )
  },
  onError(error) {
    send({ type: FRAME.LOG, level: 'error', message: error.message })
  },
})

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => decoder.push(chunk))
process.stdin.on('end', () => process.exit(0))
process.stdin.on('error', () => process.exit(0))

process.on('unhandledRejection', (reason) => {
  send({ type: FRAME.EVENT, name: 'unhandled-rejection', payload: { message: String(reason) } })
})
process.on('uncaughtException', (error) => {
  send({
    type: FRAME.EVENT,
    name: 'uncaught-exception',
    payload: { message: error?.message ?? String(error) },
  })
  // 未捕获异常后进程状态不可信：让 Host 看到退出并重新拉起，而不是带病继续跑。
  setTimeout(() => process.exit(1), 0)
})

send({
  type: FRAME.READY,
  payload: {
    pid: process.pid,
    node: process.version,
    protocol: PROTOCOL_VERSION,
    // Node < 22.15 没有 module.registerHooks，沙箱无法保证拦截边界；Host 收到 false 会拒绝使用。
    hooks: typeof registerHooks === 'function',
  },
})
