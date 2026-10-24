/**
 * QQ 聊天会话的工具硬边界（DSH 0.2.1-rc.2）。
 *
 * 为什么需要它（2026-10-20 本机实测的教训）：
 *   在 profile 里全局挂载的 bundle（dsh-ops / dsh-mnemon / experimental-agent-team …）
 *   会把自己的工具**穿透**到每一个会话。实测：新建 `agentPreset: "minimal"` 的会话，
 *   request/header 里出现 **35 个工具**，含 `ops_bash`、`pwsh`、`spawn_teammate`、
 *   `team_task_*`、`mnemon_*`。
 *   也就是说 **preset 本身并不隔断全局工具**，`minimal` 在 Windows 上还会额外启用
 *   `terminal-pwsh` / `persistent-pwsh`（profile 里 bash 被 win32 禁用、pwsh 被启用）。
 *   ⇒ 只靠选 preset，QQ 会话仍然拥有命令执行能力。必须有执行期门禁。
 *
 * 两层防护（缺一不可）：
 *   1) `tools.restrict`：把危险工具从该作用域的**工具清单（schema）**里隐藏。
 *      隐藏比"拒绝执行"更重要——工具还在 schema 里会诱导模型去调它。
 *   2) `tools.guard`：执行期白名单兜底。任何不在允许范围内的调用一律拒绝。
 *      这是最后一道，也是唯一能挡住"绕过 schema 的调用"的。
 *
 * ## 2026-10-20 的第二个教训：restrict 必须**重扫**
 *
 * 第一版只在 `apply()` 里跑一遍 restrict、并 `catch {}` 静默吞错，结果**部分失效**。
 * 实测对比 minimal(35 个工具) 与 qq-chat(20 个工具) 的 request/header：
 * 被藏住的只有 `ops_glob/ops_grep/ops_inspect_local_file/ops_replace` 与大部分
 * `mnemon_*` 写入面；而 **`ops_bash`、`working_directory`、`spawn_teammate`、
 * `team_task_*`、`list_agents`、`send_message`、`wait_agent`、`interrupt_agent`、
 * `mnemon_recall` 等仍然留在 schema 里**——权重最高的那几个反而漏了。
 *
 * 原因之一：`tools.restrict()` 对**当下未注册**的名字会抛错
 * （`restrict() names unknown global tool …`），而 preset 子树装载时，
 * 全局层里那些行还没把自己的工具注册进来。逐个 try/catch 于是把这种"暂时不存在"
 * 与"本版本确实没这个名字"一起吞了 —— 静默失效，正是最危险的失败模式。
 * 现在改成：初次扫一遍 + 监听 `tools/change` 持续重扫（只对尚未成功 deny 的名字重试），
 * 成功与否都记账，失败打日志、不再静默。
 *
 * ## ⚠️ restrict 的能力边界（2026-10-20 二次实测，务必先读）
 *
 * `tools.restrict()` 的 Service 契约写明：它按 `view(scope)` 计算可见集，而
 * 「A restriction filters what a scope inherits — the global layer and every
 * ancestor layer on its chain — and never what its OWN layer registers.」
 *
 * ⇒ **它只能藏掉「继承来的」工具，永远藏不掉「注册进该 scope 自己的」工具。**
 *
 * 实测证据（同一份 qq-chat 会话的 request/header，对比 minimal preset 的 35 个工具）：
 *    · 藏得掉（这些在全局层）：`pwsh`、`ops_glob/grep/inspect_local_file/replace`、
 *      `read_image`、`load_workspace_dependencies`、`mnemon_remember/forget` 等 ✅
 *    · **藏不掉（这些由各插件用 `agent.ctx.tools.register()` 注册进 agent 自己的 scope）**：
 *      `ops_bash`（dsh-ops/session-shells.js：`entry.ctx.tools.register(...)`）、
 *      `working_directory`、`spawn_teammate`/`team_task_*`（dsh-experimental-tool-agent-team：
 *      `const scoped = agent.ctx; scoped.tools.register(...)`）、
 *      `send_message`/`interrupt_agent`/`list_agents`（同上）、
 *      `mnemon_recall/related/status/...`（dsh-mnemon 的 agent 侧注册） ❌
 *
 * 不要把上面那批名字从 DENY_TOOLS 里删掉：它们在这里仍然有用——同一份名单会被
 * **执行期 guard** 使用，而那才是真正兜住 agent-scope 工具的那一层（实测
 * `mnemon_recall` 真被调用过并被 guard 拒绝）。而且一旦 DSH 将来把某个工具挪回
 * 全局层，restrict 就会自动开始生效。
 *
 * 结论（诚实版）：**schema 隐藏能覆盖全局层工具，agent-scope 工具只能靠 guard 拦**。
 * 想让 QQ 会话的 schema 彻底干净，必须让那些插件不要往 agent scope 注册——
 * 那是改 profile 组合的活，不在本插件范围内。
 *
 * 作用域：本插件作为 **agent preset 的子行**装载，因此 `ctx` 是该 preset 的作用域。
 * `tools.restrict` / `tools.guard` 都只作用于这个作用域下的会话，
 * **不会影响浏览器里其它普通会话**（这一点由 Service 契约保证：
 * "one registered through agent.ctx applies only to that agent"）。
 */
export const name = 'dsh-qq-guard'

/**
 * 注入声明。
 *
 * `tools` 是必需的（guard 分支要用）。
 * `webServer` / `subprocess` / `settings` 都是**按需可选**：
 *   - guard 实例（preset 内）不需要它们；
 *   - settings 实例（顶层）需要 webServer；subprocess 用来管 NapCat。
 * 若全写成 required，任一实例都会因缺服务而装载失败。
 */
export const inject = ['tools', 'webServer', 'subprocess']

// Config 用的 Schemastery：官方包，随 DSH 一起解析（本插件不声明依赖）。
import Schema from '@deepseek-ai/schemastery'
import { NapcatManager, DEFAULT_WS_PORT, findQrcodeImage } from './napcat.mjs'
import { BridgeRunner, DEFAULT_BRIDGE_DIR } from './bridge-runner.mjs'
import { SandboxManager } from './sandbox/manager.mjs'
import { installModelOverride } from './model-override.js'
import {
  UsageScope,
  UsageStatsStore,
  USAGE_BACKFILL_ROUTE_PATH,
  USAGE_FILE_NAME,
  USAGE_ROUTE_PATH,
  handleUsageBackfillRoute,
  handleUsageRoute,
} from './usage-stats.mjs'
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs'
import { builtinModules } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 官方 `defineTool`（@deepseek-ai/dsh-tools）。
 *
 * 为什么必须用它：`ctx.tools.register()` 期望的是 **registry-ready definition**：
 *   `parameters` 是编译好的原始 JSON Schema（根 `type:"object"` + `properties` + `required[]`），
 *   `output.schema` 也要过 `assertSupportedJsonSchema`。
 * 直接把手写的「参数 spec 对象」当 parameters 传进去，模型侧拿到的 schema 没有根 type，
 * 工具虽然能注册但不会出现在 request/header 的工具清单里（2026-10-24 真机：
 * 35 个工具里没有 qq_send_voice）。
 * `defineTool()` 负责把 author spec 编译成合法 JSON Schema，并把 execute 包上严格参数校验。
 *
 * 为什么用**动态导入 + 兜底**而不是静态 import：
 *   · 宿主运行时 `@deepseek-ai/dsh-tools` 是能从 DSH 自己的模块图解析到的（同生态插件都这么干）；
 *   · 但本仓库的离线自测（test-*.mjs）是纯 Node 跑的，那里没有 DSH 的 node_modules，
 *     静态 import 会直接 ERR_MODULE_NOT_FOUND 把整套测试带崩。
 *   ⇒ 能拿到就用官方的；拿不到（离线/单测）就用下面 `localDefineTool()` 编出**同构**定义，
 *     两条路径产出的 parameters **语义一致**（同样的 type / properties / required / enum；
 *     对象键序不保证相同，所以别拿 JSON.stringify 直接比字符串），
 *     行为差别只有「参数校验的严格程度」。
 */
let officialDefineTool
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (typeof mod?.defineTool === 'function') officialDefineTool = mod.defineTool
} catch {
  // 离线环境（纯 node 跑自测）会走到这里，属于预期，不报错不警告。
  officialDefineTool = undefined
}

/**
 * 本地兜底：按 `defineTool()` 的编译规则把 author spec 投影成原始 JSON Schema。
 *
 * 规则抄自 dsh-tools/lib/types/schema.js：
 *   · `parameters` 是「属性名 → value schema」的隐式对象，根节点编译成
 *     `{ type:'object', properties }`（**不加 additionalProperties**，与官方一致）；
 *   · 属性节点里的 `required: true` 会被抽出来汇总成根的 `required[]`，节点本身不再带 required；
 *   · object 节点必须显式给 `additionalProperties`；
 *   · 其余只支持 description / title / default / examples 这些注解键。
 *
 * @param {string} path 报错用的位置前缀
 * @param {Record<string, object>} spec 属性表
 * @returns {{type:'object', properties:Record<string,object>, required?:string[]}}
 */
function compileParameterMap(path, spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError(`${path} 必须是「属性名 → value schema」的对象`)
  }
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec)) {
    const compiled = compileValueSchema(`${path}.${key}`, node)
    if (node?.required === true) required.push(key)
    properties[key] = compiled
  }
  return required.length > 0 ? { type: 'object', properties, required } : { type: 'object', properties }
}

/** 单个 value schema 节点 → 原始 JSON Schema。 */
function compileValueSchema(path, node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new TypeError(`${path} 必须是 value schema 对象`)
  }
  const out = {}
  for (const key of ['description', 'title', 'default', 'examples']) {
    if (Object.hasOwn(node, key)) out[key] = node[key]
  }
  const type = Object.hasOwn(node, 'type') ? node.type : undefined
  if (Array.isArray(node.oneOf)) {
    out.oneOf = node.oneOf.map((branch, i) => compileValueSchema(`${path}.oneOf[${i}]`, branch))
    return out
  }
  out.type = type
  if (type === 'json') delete out.type
  if (type === 'object') {
    out.additionalProperties = node.additionalProperties === true
    if (node.properties) Object.assign(out, compileParameterMap(`${path}.properties`, node.properties))
  } else if (type === 'array') {
    if (node.items) out.items = compileValueSchema(`${path}.items`, node.items)
  } else if (Array.isArray(node.enum)) {
    out.enum = [...node.enum]
  }
  return out
}

/**
 * 定义一个模型侧工具：有官方 `defineTool` 就用它，没有就用本地同构编译。
 *
 * @param {{name:string, description:string, parameters:object, output:object, execute:Function,
 *   presentCall?:Function, presentResult?:Function}} options
 * @returns {object} registry-ready definition
 */
function buildToolDefinition(options) {
  if (typeof officialDefineTool === 'function') return officialDefineTool(options)
  const parameters = compileParameterMap('parameters', options.parameters)
  const definition = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: compileValueSchema('output.schema', options.output.schema),
      render: (args, value) => options.output.render(args, value),
    },
    async execute(args, exec) {
      // 官方 defineTool 会在这里做完整 JSON Schema 校验；离线兜底只拦住最常见的两种错法，
      // 真正的内容校验（空文本 / 超长 / 技能开关）下面 execute 里还会再做一次。
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('invalid arguments: 参数必须是对象')
      }
      return options.execute(args, exec)
    },
  }
  if (typeof options.presentCall === 'function') definition.presentCall = (args) => options.presentCall(args)
  if (typeof options.presentResult === 'function') {
    definition.presentResult = (args, result) => options.presentResult(args, result)
  }
  return definition
}

/** 本进程里 qq_send_voice 是用官方 defineTool 还是本地兜底编出来的（自检/日志用）。 */
export function voiceToolDefinitionSource() {
  return typeof officialDefineTool === 'function' ? 'official-defineTool' : 'local-fallback'
}

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 从本插件自带的 cordis.patch.yml 里读 guard 子行的 `personaDefault`。
 *
 * 为什么需要：preset 里已删掉静态 persona 行，默认人设正文只能放在 guard 子行的
 * config 里；但 `/dsh-qq-guard/config` 由**顶层 settings 实例**提供，它的 Config
 * 里没有这个字段。桥接要靠它拼 buildPersonaPrompt()，所以这里直接从自己的 patch
 * 文件读一遍，合并进 /config 的返回值。
 *
 * 只认 `personaDefault: |-` 块标量（我们自己写的格式），不引 YAML 依赖。
 * @returns {string}
 */
export function readGuardPersonaDefault(file = path.join(HERE, 'cordis.patch.yml')) {
  let lines
  try { lines = readFileSync(file, 'utf8').split('\n') } catch { return '' }
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)personaDefault:\s*\|[-+]?\s*$/.exec(lines[i])
    if (!match) continue
    const keyIndent = match[1].length
    const body = []
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === '') { body.push(''); continue }
      const indent = /^(\s*)/.exec(line)[1].length
      if (indent <= keyIndent) break
      body.push(line)
    }
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
    const nonEmpty = body.filter((line) => line.trim() !== '')
    if (nonEmpty.length === 0) return ''
    const common = Math.min(...nonEmpty.map((line) => /^(\s*)/.exec(line)[1].length))
    return body.map((line) => (line.trim() === '' ? '' : line.slice(common))).join('\n')
  }
  return ''
}

/**
 * 技能 / 插件清单的默认值（Phase 4）。
 *
 * 为什么把清单放进 Config 而不是留成前端常量：
 *   用户要求「拖拽排序的结果、开关的切换状态必须真实写回配置」。
 *   那这条数组本身就是配置本体 —— 顺序 = 数组顺序，开关 = `enabled`。
 *   前端只渲染配置里的东西，不再自己维护一份假列表。
 *
 * ⚠️ 改这里的默认值时注意：已经保存过配置的用户不会被覆盖
 * （Config 的 default 只在该字段从未落盘时生效）。
 */
const DEFAULT_SKILLS = [
  { id: 'sk-voice', name: '发语音', icon: 'send', tag: '内置', ver: '1.0.2', enabled: true,
    desc: '把回复文本合成语音，以 QQ 语音条发出；超过 60 秒自动转文字。' },
  { id: 'sk-vision', name: '图片理解', icon: 'image', tag: '内置', ver: '1.3.2', enabled: true,
    desc: '识别聊天里发的截图与照片，提取文字、报错信息和界面元素。' },
  { id: 'sk-search', name: '网页搜索', icon: 'search', tag: '内置', ver: '1.0.4', enabled: true,
    desc: '联网检索并把结果压缩成两三句话，用于回答时效性问题。' },
  { id: 'sk-memory', name: '记忆提取', icon: 'memory', tag: '内置', ver: '1.2.0', enabled: true,
    desc: '从会话里抽取长期事实（偏好、身份、约定），写进记忆空间供后续召回。' },
  { id: 'sk-remind', name: '定时提醒', icon: 'clock', tag: '内置', ver: '1.1.0', enabled: false,
    desc: '按 cron 或「每天早上八点」这类自然语言创建提醒，到点私聊推送。' },
  { id: 'sk-weather', name: '天气查询', icon: 'spark', tag: '实验', ver: '0.9.3', enabled: false,
    desc: '按城市查实时天气与未来三天预报，群聊里需要显式提问才触发。' },
]

const DEFAULT_PLUGINS = [
  { id: 'pl-debounce', name: '防抖合并', icon: 'activity', tag: '本地', ver: '1.4.0', enabled: true,
    desc: '群聊里连续多条短消息先攒一窗口再一次性回复，避免逐条刷屏。' },
  { id: 'pl-ratelimit', name: '频率控制', icon: 'shield', tag: '本地', ver: '1.1.0', enabled: true,
    desc: '按会话限流，超出阈值直接静默丢弃，防止被刷屏或触发风控。' },
  { id: 'pl-compact', name: '上下文压缩', icon: 'memory', tag: '内置', ver: '1.4.3', enabled: true,
    desc: '长会话自动摘要早期内容，控制 token 开销，同时保住关键约定。' },
  { id: 'pl-guard', name: '工具门禁', icon: 'shield', tag: '本地', ver: '1.1.0', enabled: true,
    desc: 'deny-by-default 的工具白名单，把本地执行能力彻底挡在 QQ 会话之外。' },
  { id: 'pl-persona', name: '人设注入', icon: 'spark', tag: '本地', ver: '1.2.1', enabled: true,
    desc: '把全局人设或会话级覆盖注入系统提示词，complete 模式下不掺入任何框架自述。' },
  { id: 'pl-archive', name: '日志归档', icon: 'file', tag: '实验', ver: '0.8.2', enabled: false,
    desc: '把桥接日志与收到的截图按日期归档到工作区，方便事后复盘。' },
]

/**
 * 需要从 schema 隐藏 + 执行期拒绝的工具名。
 *
 * 这些名字是**逐个从本机实际会话的工具清单里核对过的**（2026-10-20 实测记录见文件头），
 * 不是凭印象列举。注意 `tools.restrict()` 的语义：它只能过滤该作用域**继承来的**
 * 全局/祖先层工具，**动不了本 preset 自己注册的**——所以 `ask_user_question`
 * 与 `todo_write`（由 preset 的 tool-ask-user / tool-todo 两行注册）不在此列。
 *
 * 分层：
 *   · 壳/进程：pwsh / bash / ops_bash / terminal_* / persistent_* / working_directory
 *   · 文件：read / write / edit / read_image / ops_inspect_local_file / ops_replace / ops_glob / ops_grep
 *   · 自带运行时（等于把"跑代码"递给模型）：load_workspace_dependencies
 *   · 派生 agent / 编排：spawn_teammate / team_* / interrupt_agent / send_message / wait_agent / list_agents
 *   · 插件装载权（= 任意代码执行）：plugin_manager
 *   · 宿主运行期自省：cordis_inspect_list / cordis_inspect_query
 *   · 记忆面（群友不该驱动长期记忆，读也不必要）：mnemon_*（全部）
 *   · 自我调度：schedule_*
 *   · 后台作业 / 目标 / 交付：job_* / *_goal / present
 *   · MCP 资源读取（可指向任意已配置 MCP server）：read_mcp_resource / list_mcp_resources
 */
const DENY_TOOLS = [
  // ── 壳 / 进程执行 ──────────────────────────────────────────────
  'pwsh', 'bash', 'ops_bash', 'working_directory',
  'terminal_bash', 'terminal_pwsh', 'bash_persistent', 'pwsh_persistent',
  // ── 文件读写与检索 ────────────────────────────────────────────
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  'glob', 'grep',
  'ops_inspect_local_file', 'ops_replace', 'ops_glob', 'ops_grep',
  // ── 自带运行时（Python/Node/pnpm 绝对路径）────────────────────
  'load_workspace_dependencies',
  // ── 派生 agent 与编排（都能间接拿到 shell）────────────────────
  'subagent', 'subagent_fork', 'list_subagent_models', 'subagent_codex', 'subagent_claude_code',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'interrupt_agent', 'send_message', 'wait_agent', 'list_agents',
  'workflow', 'ralph',
  // ── 插件装载权 = 任意代码执行 ─────────────────────────────────
  'plugin_manager',
  // ── 宿主运行期自省（可读进程状态）＋ 技能目录 ──────────────────
  'cordis_inspect_list', 'cordis_inspect_query', 'skill',
  // ── 记忆面：写入与读取全关（QQ 群友不需要长期记忆能力）────────
  'mnemon_remember', 'mnemon_forget', 'mnemon_link',
  'mnemon_memory_body_create', 'mnemon_memory_body_merge', 'mnemon_memory_body_update',
  'mnemon_subagent_result', 'mnemon_view_action', 'mnemon_document_create', 'mnemon_document_manage',
  'mnemon_recall', 'mnemon_related', 'mnemon_status', 'mnemon_memory_bodies',
  'mnemon_document_search', 'mnemon_runtime_memory', 'mnemon_view_route',
  // ── 无人值守自我调度 / 后台作业 / 目标 / 交付 ─────────────────
  'schedule_create', 'schedule_update', 'schedule_delete',
  'job_list', 'job_output', 'job_kill',
  'get_goal', 'create_goal', 'update_goal',
  'present',
  // ── MCP 资源（可指向任意已配置 server）────────────────────────
  'read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates',
]

/**
 * 执行期白名单：不在这些范围内的调用一律拒绝。
 *
 * 这是**允许列表**语义（deny-by-default），不是"黑名单"：
 * 就算 DSH 以后新增了某个危险工具、或某个 bundle 把新能力推进全局层，
 * 只要它不在这张表里就会被拒绝 —— 黑名单会漏，白名单不会。
 *
 * 只留 QQ 会话真正需要的两个模型侧工具（都由本 preset 自己注册）：
 * `ask_user_question`（把问题转给管理员/用户）与 `todo_write`（仅本会话的任务列表）。
 * `mcp__` 前缀保留，供未来接入只读的 QQ 工具（如发消息/收消息）使用。
 */
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
])

/** 允许的前缀：DSH 的 MCP 命名空间工具。 */
const SAFE_PREFIXES = ['mcp__']

// ── 桥接运行时配置（批次 4A）─────────────────────────────────────────────
//
// 这些键原本写在 qq-bridge/config.json 里，只能在文件里手改、还得重启桥接。
// 现在搬进 DSH 设置页：本插件声明 Config → Settings 服务把 volatile 字段投影成表单
// → 用户改完由 config-editor 写进 profile 的 cordis.patch.yml（重启后仍在）。
//
// **桥接是独立进程**，读不到 DSH 的内存值，所以本插件额外暴露一条只读 HTTP 路由
// `GET /dsh-qq-guard/config`，桥接定时轮询它做热更新（见 qq-bridge/src/runtime-config.mjs）。
//
// `.volatile()` 是必须的：Settings 的表单只展示 volatile 字段
// （证据：dsh-settings/lib/types/schema.js:43-54 `volatileForm`，非 volatile 直接返回 undefined）。
/**
 * 一档费率：四项均为「元 / 百万 token」。
 *
 * 为什么单独抽出来：闲时 / 忙时结构完全一样，抽一份既少重复，也保证两边字段不漂移
 * （少一个 cacheWrite，成本就会静默漏算缓存写入）。
 */
const RateConfig = Schema.object({
  input: Schema.number().default(0).min(0)
    .description('未命中缓存的输入单价（元 / 百万 token）。'),
  output: Schema.number().default(0).min(0)
    .description('输出单价（元 / 百万 token；reasoning 已包含在 output 里）。'),
  cacheRead: Schema.number().default(0).min(0)
    .description('缓存命中读取单价（元 / 百万 token）。'),
  cacheWrite: Schema.number().default(0).min(0)
    .description('缓存写入单价（元 / 百万 token）。'),
}).description('一档 token 单价')

const Config = Schema.object({
  // ⚠️ 绝对不要给 role 加 .default()。默认值会让「没显式声明的实例」也拿到
  // guard/settings，从而再次触发下面第 1 条讲的全 profile 锁死事故。
  // 未声明 = undefined = 什么都不做（fail-closed）。
  role: Schema.union(['guard', 'settings'])
    .description('本实例的职责：guard = 只在 qq-chat preset 内做工具门禁；settings = profile 顶层持有配置与设置页。')
    .volatile(),
  bubbleMaxChars: Schema.number()
    .description('单行语义切阈值：模型换行仍是强边界，只有单行超过这个字数才按标点切。')
    .default(30).min(1).max(1000).volatile(),
  mergeMaxChars: Schema.number()
    .description('桥接硬切碎片的合并上限：仅作用于同一条原生行切出的碎片，绝不跨原生换行合并。')
    .default(15).min(1).max(1000).volatile(),
  chunkSize: Schema.number()
    .description('QQ 单条硬上限，仅用于防「一条太长发不出去」。')
    .default(1000).min(1).max(100000).volatile(),
  typingDelay: Schema.object({
    enabled: Schema.boolean()
      .description('打字延时总开关。关闭 = 不分片、不延时、整条合并发送。')
      .default(true).volatile(),
  }).description('打字延时').default({}),
  flypitDelayTiers: Schema.object({
    short: Schema.number().description('<短句上限字数 档的基准延时(ms)').default(200).min(0).max(60000).volatile(),
    medium: Schema.number().description('中等档的基准延时(ms)').default(450).min(0).max(60000).volatile(),
    long: Schema.number().description('长句档的基准延时(ms)').default(800).min(0).max(60000).volatile(),
  }).description('分级打字延时的三档基准值').default({}),
  // 字数档位阈值（2026-10-23）：三档边界从写死改成可配置。
  // 语义：字数 < shortMax → 短句；shortMax..mediumMax → 中等；≥ longMin → 长句。
  // 桥接侧 onebot.mjs 从热配置读它，不在这里算延时。
  typingDelayCharTiers: Schema.object({
    shortMax: Schema.number()
      .description('短句上限字数：字数 < 该值走短句档（默认 10）。')
      .default(10).min(1).max(500).volatile(),
    mediumMax: Schema.number()
      .description('中等上限字数：短句上限 ~ 该值（含）走中等档（默认 14）。')
      .default(14).min(1).max(500).volatile(),
    longMin: Schema.number()
      .description('长句触发字数：字数 >= 该值走长句档（默认 15）。')
      .default(15).min(1).max(500).volatile(),
  }).description('打字延时的字数档位阈值').default({}),
  sendIntervalMs: Schema.number()
    .description('兜底固定间隔(ms)：仅当打字延时关闭时生效。')
    .default(500).min(0).max(60000).volatile(),
  groupAtReply: Schema.boolean()
    .description('群聊回复时是否 @ 发送者（私聊永不 @）。')
    .default(true).volatile(),
  groupAtPosition: Schema.union(['last', 'first'])
    .description('@ 挂在哪一片：last = 最后一片，first = 第一片。')
    .default('last').volatile(),
  trimEndPunctuation: Schema.object({
    enabled: Schema.boolean()
      .description('是否裁掉每片末尾的空白与标点。')
      .default(true).volatile(),
    keep: Schema.array(Schema.string())
      .description('片尾要保留的标点（默认保留问号感叹号，语气不能丢）。')
      .default(['？', '！']).volatile(),
  }).description('片尾标点处理').default({}),

  // ── 人设（批次 4A-UI）─────────────────────────────────────────
  // 非空时覆盖 preset 里的默认人设：桥接在发送前把它注入会话
  // （具体注入方式见 qq-bridge/src/persona.mjs 的说明）。
  // 留空 = 用 preset 自带的默认人设。
  personaText: Schema.string()
    .description('自定义人设。非空时覆盖 qq-chat preset 的默认人设；留空则用默认。')
    .default('').volatile(),
  // preset 里不再挂静态 persona 行：默认人设正文存在这里，由 role: guard 实例
  // 动态注册成 `deployment:persona-prefix` section（按会话取覆盖，取不到用这段兜底）。
  // 由 cordis.patch.yml 的 guard 子行提供，正常不需要在设置页改。
  personaDefault: Schema.string()
    .description('preset 内置默认人设（role: guard 动态 section 的兜底文本）。')
    .default('').volatile(),
  personaPresetDefault: Schema.string()
    .description('当前 preset 的默认人设（只读快照，供 UI 的「恢复默认」按钮参考）。')
    .default('').volatile(),
  // P1.5：人设拆成结构化字段，桥接层（bridge.mjs composePersonaPrompt）拼最终系统提示词。
  personaBotName: Schema.string()
    .description('机器人名字。非空时替换默认人设里的 DeepSeek，并追加身份说明。')
    .default('').volatile(),
  personaGroupName: Schema.string()
    .description('群内展示名。非空时追加到身份说明里。')
    .default('').volatile(),
  personaParticipation: Schema.string()
    .description('参与度：quiet=安静型 / normal=普通群友 / active=活跃型。')
    .default('normal').volatile(),
  personaExtraRules: Schema.string()
    .description('管理员附加规则。非空时追加到最终系统提示词末尾。')
    .default('').volatile(),
  personaSystemPrompt: Schema.string()
    .description('完整系统提示词覆盖。非空时完全替换内置人设（名字/参与度/附加规则都不再追加）。')
    .default('').volatile(),
  personaPresets: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string().default(''),
    text: Schema.string().default(''),
  })).description('自定义人设列表（UI 下拉选择用）。')
    .default([]).volatile(),
  personaPresetId: Schema.string()
    .description('当前选中的自定义人设 id；空串 = 使用默认人设。')
    .default('').volatile(),

  // ── 模型（无痕热切换 + 失败降级）────────────────────────────
  // 桥接每条消息前把它 POST 给 `/dsh-qq-guard/model`；插件在 `agent/request` 瀑布里
  // 覆写这一次请求的 route —— 不走 `session/selectModel`，不动 DSH 全局默认。
  // 留空 provider = 不接管，会话仍用它当前的模型。
  model: Schema.object({
    provider: Schema.string()
      .description('QQ 会话使用的 provider id。留空 = 不接管（跟随会话当前模型）。')
      .default('').volatile(),
    model: Schema.string()
      .description('模型 id。provider 非空时必须一起填。')
      .default('').volatile(),
    reasoningEffort: Schema.string()
      .description('推理档位 id（如 off/low/high/max）。留空 = 用该模型的默认档。')
      .default('').volatile(),
  }).description('QQ 会话使用的模型').default({}),
  modelFallbacks: Schema.array(Schema.object({
    provider: Schema.string().required().description('备用 provider id。'),
    model: Schema.string().required().description('备用模型 id。'),
  })).description('备用模型（最多 4 个）。主模型超时/报错时按顺序接管，同一轮内生效。')
    .default([]).volatile(),

  // ── 语音合成（「发语音」技能的真实后端）─────────────────────
  // provider=edge 走微软 Edge 朗读接口（免 Key）；provider=openai 走任意
  // OpenAI 兼容 /v1/audio/speech（需要 baseUrl + apiKey）。合成在桥接进程里做，
  // 通过 NapCat 的 record 段发出去 —— 插件本身不连线，只负责把配置热同步下去。
  voice: Schema.object({
    provider: Schema.union(['baidu', 'edge', 'openai'])
      .description('baidu = 百度免 Key（当前可用，默认）；edge = 微软朗读（2026-10-24 起被拒，403）；'
        + 'openai = OpenAI 兼容 /v1/audio/speech（需要 baseUrl + apiKey）。')
      .default('baidu').volatile(),
    baseUrl: Schema.string()
      .description('OpenAI 兼容接口的 baseUrl（仅 provider=openai 时需要），如 https://api.openai.com/v1。')
      .default('').volatile(),
    apiKey: Schema.string()
      .description('OpenAI 兼容接口的 API Key（仅 provider=openai 时需要）。')
      .default('').role('secret').volatile(),
    voice: Schema.string()
      .description('音色名。Edge：zh-CN-XiaoyiNeural / zh-CN-XiaoxiaoNeural；OpenAI：alloy 等。')
      .default('zh-CN-XiaoyiNeural').volatile(),
  }).description('语音合成（发语音技能）').default({}),

  // ── 网页搜索的 DeepSeek 凭据（2026-10-24：真机 web_search 报 no API key）──
  //
  // `@deepseek-ai/dsh-web-search-deepseek` 的密钥解析顺序：
  //   literal config.apiKey → credentials.resolve('DEEPSEEK_API_KEY') → launch env → 账号登录态
  // 本机 profile 的 credentials 里只有 OPENCODE_GO_API_KEY，所以 QQ 会话里 web_search 直接报
  // WEB_PROVIDER_CREDENTIAL_MISSING。这里给出一个设置页入口：改完 apply 时写进 DSH 的
  // `web-search-deepseek` settings namespace（字段名 baseURL 是大写 URL，别写成 baseUrl）。
  webSearch: Schema.object({
    apiKey: Schema.string()
      .description('DeepSeek Platform 的 API Key（sk-…）。留空 = 不覆盖 DSH 现有配置。'
        + '填了才会写入 web-search-deepseek，web_search 才能用。')
      .default('')
      .role('secret').volatile(),
    baseUrl: Schema.string()
      .description('搜索接口 baseUrl（留空用默认 https://api.deepseek.com/anthropic/v1）。')
      .default('').volatile(),
    model: Schema.string()
      .description('搜索模型 id（留空用 provider 默认）。')
      .default('').volatile(),
  }).description('网页搜索（DeepSeek）').default({}),

  // ── 用量成本价目表（「数据与用量」面板）──────────────────────
  //
  // DSH 只报 token，不报单价（token-meter 没有任何货币概念），所以成本只能自己维护。
  // 单位统一为「元 / 百万 token」；忙时 / 闲时两套费率，某套四项全为 0 = 没配，
  // 面板显示「—」，绝不填 0 假装免费。模型留空表示该 provider 下所有模型都套这一档。
  usagePricing: Schema.array(Schema.object({
    provider: Schema.string().required()
      .description('provider id，例如 trae / opencode-go / raccoon。'),
    model: Schema.string().default('')
      .description('模型 id；留空或 * 表示该 provider 下所有模型通用。'),
    peak: RateConfig.default({})
      .description('忙时（Peak）单价：服务商高峰时段的计费。'),
    offPeak: RateConfig.default({})
      .description('闲时（Off-Peak）单价：服务商非高峰时段的计费。'),
  })).description('用量成本价目表：按 provider + model 配忙时 / 闲时两套单价。')
    .default([]).volatile(),

  // 忙时时段用哪个时区判断。默认跟随本机（UTC+8）；时段格式 HH:MM-HH:MM，可跨午夜。
  peakHours: Schema.string()
    .description('忙时时段：单段或逗号分隔多段（HH:MM-HH:MM，左闭右开，可跨午夜）。'
      + '例如 09:00-12:00, 14:00-18:00。')
    .default('08:30-00:30').volatile(),
  peakOnlyWorkdays: Schema.boolean()
    .description('仅工作日生效：周六/周日整天空闲时（holidays.json 里的 workdays 仍按工作日算）。')
    .default(false).volatile(),
  timezone: Schema.string()
    .description('判断忙时/闲时用的 IANA 时区，默认 Asia/Shanghai（UTC+8）。')
    .default('Asia/Shanghai').volatile(),

  // ── 高级参数（排障 / 调优，一般不用动）──────────────────────
  // 三个都是「响应链路的时间常数」，面板上收进一张折叠卡，桥接侧全部热读。
  replyTimeoutMs: Schema.number()
    .description('桥接等回复上限（毫秒）。超时会取消这一轮并给 QQ 回一句提示。默认 20000。')
    .default(20000).min(1000).max(600000).volatile(),
  modelWatchdogMs: Schema.number()
    .description('静默看门狗：被接管的模型多少毫秒没有任何输出就判定超时、切备用模型（0 = 关闭）。'
      + '只作用于 QQ 会话下发的路由，不影响浏览器里的会话。')
    .default(8000).min(0).max(120000).volatile(),
  antiDebounceMs: Schema.number()
    .description('消息防抖合并窗口（毫秒）。0 = 沿用「活跃设置」里的 debounceWindowMs（默认 800）。')
    .default(0).min(0).max(60000).volatile(),
  debugPrompt: Schema.boolean()
    .description('人设诊断日志：开启后每步打印 system sections / runtime contexts 的名字与字数'
      + '（只在内容变化时打，用于排查「人设没生效」）。默认关。')
    .default(false).volatile(),

  // ── 白名单（批次 4A-UI）──────────────────────────────────────
  // 桥接每处理一条消息都从热配置现读，改完下一条即生效。
  allow: Schema.object({
    private: Schema.array(Schema.string())
      .description('允许的私聊 QQ 号。留空且 allowAllWhenEmpty=false 时谁都不理。')
      .default([]).volatile(),
    groups: Schema.array(Schema.string())
      .description('允许的群号。')
      .default([]).volatile(),
    // 管理员：只有名单里的 QQ 号能触发 `/` 开头的指令（/reset、/clear、/model 等）。
    // 非管理员发指令会被桥接直接拦下并回提示，不会投递给 DSH（省 token）。
    admins: Schema.array(Schema.string())
      .description('管理员 QQ 号：只有这些人能执行 / 开头的指令。')
      .default([]).volatile(),
    allowAllWhenEmpty: Schema.boolean()
      .description('白名单为空时是否放行所有人。默认 false（fail-closed，安全）。')
      .default(false).volatile(),
  }).description('白名单').default({}),

  // ── OneBot 连接（为 4B 做准备）────────────────────────────────
  // 只读展示为主；改了也要重启桥接（WS 连接在启动时建立）。
  onebot: Schema.object({
    wsUrl: Schema.string()
      .description('NapCat 正向 WebSocket 地址，如 ws://127.0.0.1:3001。')
      .default('ws://127.0.0.1:3001').volatile(),
    accessToken: Schema.string()
      .description('NapCat 的 access token。以密码形式保存，读取时不回显明文。')
      .default('').role('secret').volatile(),
    httpUrl: Schema.string()
      .description('NapCat 的 HTTP API 地址（可选，**不填也能判断账号在线**）。'
        + '桥接已改为纯 WS 发 get_status 探在线；这里只作为 NapCat 管理区的额外探测。')
      .default('').volatile(),
  }).description('OneBot 连接').default({}),

  // ── NapCat 进程管理（批次 4B）────────────────────────────────
  napcat: Schema.object({
    dir: Schema.string()
      .description('NapCat 安装目录（含 NapCatWinBootMain.exe）。留空用内置默认值。')
      .default('').volatile(),
    quickLoginQQ: Schema.string()
      .description('快速登录的 QQ 号；留空则启动后需手动扫码/登录。')
      .default('').volatile(),
  }).description('NapCat 进程管理').default({}),

  // ── 桥接进程管理（批次 4B 补充）──────────────────────────────
  // 桥接原本只能手动开终端跑，窗口一关就没了 → UI 显示「未知」。
  bridge: Schema.object({
    dir: Schema.string()
      .description('qq-bridge 目录。留空用默认（与本插件同仓库的 qq-bridge/）。')
      .default('').volatile(),
    autoStart: Schema.boolean()
      .description('DSH 启动时自动拉起桥接（让状态灯常亮）。已有桥接实例在跑时会自动跳过，不会双开。')
      .default(false).volatile(),
  }).description('桥接进程管理').default({}),
  // ── 技能与插件清单（Phase 4：真实读写）──────────────────────
  //
  // 数组顺序 = 界面排序（拖拽/上下移直接写回这个顺序）；
  // `enabled` = 开关状态。前端不再维护自己的假列表。
  skills: Schema.array(Schema.object({
    id: Schema.string().description('稳定标识，改它等于换一条。').required(),
    name: Schema.string().required(),
    icon: Schema.string().default('spark'),
    tag: Schema.string().default('内置'),
    ver: Schema.string().default('1.0.0'),
    desc: Schema.string().default(''),
    enabled: Schema.boolean().default(false),
  })).description('技能清单（顺序即展示顺序）').default(DEFAULT_SKILLS).volatile(),

  plugins: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string().required(),
    icon: Schema.string().default('spark'),
    tag: Schema.string().default('本地'),
    ver: Schema.string().default('1.0.0'),
    desc: Schema.string().default(''),
    enabled: Schema.boolean().default(false),
  })).description('插件清单（顺序即展示顺序）').default(DEFAULT_PLUGINS).volatile(),

  // ── 外部插件挂载（只读扫描，默认全关）───────────────────────
  //
  // 扫描目录里的有效模块：package.json（含 `dsh` 字段）、plugin.json、skill.json
  // （QQ Agent 格式，BOM 容错）。不改目标目录、不装东西、不执行外部代码。
  // `enabled` 记录被打开的外部插件（按名称/id），默认空 = 全关。
  externalPlugins: Schema.object({
    dirs: Schema.array(Schema.string())
      .description('外部插件目录（为空时自动定位当前 profile 的 node_modules）。')
      .default([]).volatile(),
    enabled: Schema.array(Schema.string())
      .description('被启用的外部插件名称/id。默认空 = 全部关闭。')
      .default([]).volatile(),
    // P1.5：外部插件配置项的本地副本（按模块 id 存 configSchema 里的值）。
    // 只写进本插件自己的 profile 配置，**不碰对方的 config.json**。
    settings: Schema.dict(Schema.any())
      .description('外部插件的本地配置（按模块 id 分组，来自各自的 configSchema）。')
      .default({}).volatile(),
  }).description('外部插件挂载').default({}),

  // ── DSH 会话（Phase 4）──────────────────────────────────────
  //
  // 桥接的 pickHotConfig 只放行这个子键（`dsh.baseUrl` / `sessionCwd` 这类
  // 连接参数绝不通过热配置下发），所以开关放在 `dsh.archiveStaleSessions` 上。
  dsh: Schema.object({
    archiveStaleSessions: Schema.boolean()
      .description('桥接发现映射会话失效并重建时，自动归档那条旧会话（防止 DSH 侧会话堆积）。')
      .default(true).volatile(),
  }).description('DSH 会话').default({}),

  // ── 运行节奏（Phase 4：活跃设置弹窗的真实字段）──────────────
  //
  // 桥接每 2 秒轮询 /config 拿这些值，改完下一条消息即按新值处理。
  rhythm: Schema.object({
    activityLevel: Schema.number()
      .description('响应档位：0=仅艾特/私聊，1=+关键词，2=+随机，3=全响应。')
      .default(1).min(0).max(3).volatile(),
    debounceWindowMs: Schema.number()
      .description('防抖合并窗口(ms)：同一会话连续消息在此窗口内合并成一次处理。')
      .default(800).min(0).max(10000).volatile(),
    batchIntervalMs: Schema.number()
      .description('批次间隔(ms)：一轮回复拆成多个气泡时相邻气泡的最小间隔。')
      .default(2500).min(0).max(30000).volatile(),
    rateLimit: Schema.object({
      perMin: Schema.number().description('每会话每分钟回复上限').default(12).min(1).max(120).volatile(),
      burst: Schema.number().description('允许的突发条数').default(3).min(0).max(30).volatile(),
      silent: Schema.boolean().description('超限是否静默（不提示）').default(true).volatile(),
    }).description('频率控制').default({}),
    mute: Schema.object({
      enabled: Schema.boolean().description('指令禁言总开关').default(true).volatile(),
      words: Schema.array(Schema.string())
        .description('禁言指令词，任一命中即静音该会话。')
        .default(['闭嘴', '安静', '别刷屏']).volatile(),
      seconds: Schema.number().description('禁言时长(秒)').default(60).min(5).max(3600).volatile(),
    }).description('指令禁言').default({}),
  }).description('运行节奏').default({}),
}).description('QQ 桥接运行时参数：改完即时生效（桥接轮询本插件的 /dsh-qq-guard/config）。')

/** 路由路径：桥接据此拉配置。 */
const CONFIG_ROUTE_PATH = '/dsh-qq-guard/config'
/** 路由路径：桥接回推运行状态。 */
const STATUS_ROUTE_PATH = '/dsh-qq-guard/status'
/** 路由路径：NapCat 进程启停与状态（批次 4B）。 */
const NAPCAT_ROUTE_PATH = '/dsh-qq-guard/napcat'
/** 路由路径：NapCat 登录二维码截图（qrcode.png → 浏览器）。 */
const NAPCAT_QR_ROUTE_PATH = '/dsh-qq-guard/napcat-qr'
/** 二维码图片大小上限：正常 147×147 只有几百字节，4MB 是防被替换成巨型文件。 */
const NAPCAT_QR_MAX_BYTES = 4 * 1024 * 1024
/** 路由路径：桥接进程启停与状态（批次 4B 补充）。 */
const BRIDGE_ROUTE_PATH = '/dsh-qq-guard/bridge'
/** 路由路径：调起系统原生「选择文件夹」对话框（NapCat 安装目录的「浏览」按钮）。 */
const PICK_DIR_ROUTE_PATH = '/dsh-qq-guard/pick-dir'
/** 路由路径：只读扫描外部插件目录（Phase 4）。 */
const EXTERNAL_ROUTE_PATH = '/dsh-qq-guard/external-plugins'
/** 路由路径：在独立沙箱子进程里加载一个外部插件（P1，只读测试）。 */
const EXTERNAL_TEST_ROUTE_PATH = '/dsh-qq-guard/external-plugins/test'
/** 路由路径：清理 QQ 工作区里失效的会话（Phase 4）。 */
const CLEANUP_ROUTE_PATH = '/dsh-qq-guard/cleanup-sessions'
/** 路由路径：单人设覆盖（桥接每条消息前 POST；guard 实例只读共享内存）。 */
const PERSONA_ROUTE_PATH = '/dsh-qq-guard/persona'
/** 路由路径：会话指令队列（UI POST 入队，桥接 2 秒轮询取出执行）。 */
const SESSION_OPS_ROUTE_PATH = '/dsh-qq-guard/session-ops'
/** 单人设文本长度上限（字符）：防一条 10MB 的人设把内存和日志撑爆。 */
const PERSONA_MAX_CHARS = 20000
/** 指令队列：最多挂起多少条 / 多久没被桥接取走就作废。 */
const SESSION_OPS_CAP = 50
const SESSION_OPS_TTL_MS = 5 * 60 * 1000

/**
 * 人设共享状态。
 *
 * ⚠️ 为什么是模块级而不是插件实例字段：本插件被装载两次（preset 内的
 * role: guard 与 profile 顶层的 role: settings），两者是**同一个 ESM 模块实例**。
 * 顶层实例（有 webServer）收 HTTP 请求写这份状态，guard 实例注册的
 * system-prompt section 的 text 函数在每次组装时现读 —— 于是改完下一条消息即生效。
 * （同进程共享内存，不落盘；桥接每条消息都会重新 POST，DSH 重启后自然恢复。）
 */
const personaState = {
  /** 全局默认人设（桥接启动/配置变化时推送；空 = 用 preset 的 personaDefault）。 */
  global: '',
  /** sessionId → 单人设文本。 */
  sessions: new Map(),
}

/** 设置全局默认人设（桥接推送）。空串 = 清除，回落到 preset 内置人设。 */
export function setGlobalPersonaText(text) {
  personaState.global = typeof text === 'string' ? text.slice(0, PERSONA_MAX_CHARS) : ''
  return personaState.global
}

/** 设置某会话的单人设；空串 = 恢复全局默认。 */
export function setSessionPersonaText(sessionId, text) {
  const id = String(sessionId ?? '').trim()
  if (!id) return undefined
  const value = typeof text === 'string' ? text.slice(0, PERSONA_MAX_CHARS) : ''
  if (value.trim() === '') personaState.sessions.delete(id)
  else {
    personaState.sessions.set(id, value)
    // 防御：长期运行下会话可能很多；单人设只保留最近 500 个（Map 插入序，删最旧）。
    while (personaState.sessions.size > 500) {
      const oldest = personaState.sessions.keys().next().value
      personaState.sessions.delete(oldest)
    }
  }
  return value
}

/**
 * 取某会话最终人设：单人设 > 全局 > preset 内置兜底。
 * @param {string|undefined} sessionId
 * @param {string} fallback preset 里配置的 personaDefault
 */
export function personaTextForSession(sessionId, fallback = '') {
  const id = String(sessionId ?? '').trim()
  if (id && personaState.sessions.has(id)) return personaState.sessions.get(id)
  if (personaState.global.trim() !== '') return personaState.global
  return String(fallback ?? '')
}

/** 诊断用快照（不含正文，只给长度/数量，避免把大段人设塞进日志）。 */
export function personaStateSnapshot() {
  return {
    globalChars: personaState.global.length,
    sessionCount: personaState.sessions.size,
    sessions: [...personaState.sessions.keys()].slice(0, 50),
  }
}

// ── 技能 / 插件开关的实时投影（Phase 6）───────────────────────────
//
// 为什么放模块级：本模块被装载两次（preset 内的 role: guard / profile 顶层的
// role: settings）。用户在设置页改的是 **settings 实例**的 Config，而工具门禁在
// **guard 实例**里执行。两者是同一个 ESM 模块实例，所以把 settings 的 Config
// 存到模块级、guard 每次执行时现读，开关才不是 UI 装饰。
//
// 注意：必须用 plainConfig 解 volatile 包装，直接读 config.skills 会拿到
// `{get()}` 包装对象（见 readRole 的注释）。
const featureState = {
  /** 顶层 settings 实例的原始 Config（可空：guard 先装载时就是 null，按默认清单算）。 */
  source: null,
}

/** 让 guard 实例读到设置页实例的配置（由 applySettings 写入）。 */
export function bindFeatureConfigSource(config) {
  featureState.source = config ?? null
  return featureState.source
}

/** 取某类清单：配置里没有这个数组时才回落到内置默认清单。 */
function manifestOf(cfg, kind) {
  const raw = kind === 'plugin' ? cfg.plugins : cfg.skills
  if (Array.isArray(raw)) return raw
  return kind === 'plugin' ? DEFAULT_PLUGINS : DEFAULT_SKILLS
}

/**
 * 某个技能/插件条目是否开启（纯函数，离线测试可直接调用）。
 *
 * 语义：
 *   · 配置里有这个数组 → 以数组为准；条目被删掉 = 关闭（用户明确删了它）。
 *   · 配置里没有这个数组（旧配置 / 还没落盘）→ 用内置默认清单的 enabled。
 * @param {unknown} config 插件 Config（可含 volatile 包装）
 * @param {string} id 条目 id，如 sk-voice / pl-guard
 * @param {'skill'|'plugin'} [kind]
 */
export function itemEnabledIn(config, id, kind = 'skill') {
  const cfg = plainConfig(config) ?? {}
  const configured = Array.isArray(kind === 'plugin' ? cfg.plugins : cfg.skills)
  const list = manifestOf(cfg, kind)
  const hit = list.find((item) => item && item.id === id)
  if (hit) return hit.enabled !== false
  if (!configured) {
    const fallback = (kind === 'plugin' ? DEFAULT_PLUGINS : DEFAULT_SKILLS).find((item) => item.id === id)
    if (fallback) return fallback.enabled === true
  }
  return false
}

/**
 * 当前所有已实装开关的真实状态（guard 每次执行时现算，不缓存）。
 * @param {unknown} [config] 默认读 settings 实例的 Config；测试可注入。
 */
export function readFeatureFlags(config = featureState.source) {
  return {
    voice: itemEnabledIn(config, 'sk-voice'),
    vision: itemEnabledIn(config, 'sk-vision'),
    search: itemEnabledIn(config, 'sk-search'),
    guard: itemEnabledIn(config, 'pl-guard', 'plugin'),
    debounce: itemEnabledIn(config, 'pl-debounce', 'plugin'),
    rateLimit: itemEnabledIn(config, 'pl-ratelimit', 'plugin'),
  }
}

// ── 会话指令队列（模块级：设置页路由与 guard 内的语音工具共用）─────────
//
// 原来这套队列定义在 applySettings 里，但「发语音」工具注册在 guard 实例，
// 同一个进程里要让桥接取到工具入队的语音任务，队列必须放在模块作用域。
const sessionOpsQueue = new Map() // id -> { id, op, key, text, sessionId, voice, at, lease }
let sessionOpsSeq = 0

/**
 * 等桥接回执的挂起项（2026-10-24）。
 *
 * 为什么需要：`qq_send_voice` 以前「入队即返回 queued」，桥接那边 Edge TTS 失败、
 * NapCat 拒收时模型完全不知道，还回复「发出去了」（真机就是这么翻车的）。
 * 现在工具会**等到桥接回执**再返回：成功给出 detail，失败把 detail 原样 throw 给模型。
 *
 * key = 会话指令 id，value = { resolve, reject, timer }。
 * 回执由 `POST /dsh-qq-guard/session-ops {results:[{id, ok, detail}]}` 那条链路送回来
 * （桥接侧 session-ops.mjs 每轮把执行结果回传）。
 */
const pendingOpResults = new Map()

/**
 * 等待某条会话指令的桥接回执。
 * @param {string} id 指令 id
 * @param {number} timeoutMs 超时（拿不到回执就 reject，绝不假装成功）
 * @returns {Promise<{ok:boolean, detail?:string}>}
 */
function waitForOpResult(id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingOpResults.delete(id)
      reject(new Error(`桥接没有回执（${timeoutMs}ms 内没等到）：可能桥接没在跑，或这条指令被丢弃了`))
    }, timeoutMs)
    pendingOpResults.set(id, { resolve, reject, timer })
  })
}

/**
 * 收到回执时唤醒挂起的工具调用。
 * @param {string} id 指令 id
 * @param {{ok?:boolean, detail?:string}} result
 * @returns {boolean} 是否命中了一个挂起项
 */
function settleOpResult(id, result) {
  const pending = pendingOpResults.get(id)
  if (pending === undefined) return false
  pendingOpResults.delete(id)
  clearTimeout(pending.timer)
  pending.resolve({
    ok: result?.ok !== false,
    detail: typeof result?.detail === 'string' ? result.detail : '',
  })
  return true
}

/** 清掉过期指令（5 分钟没被桥接取走就作废）。 */
function pruneSessionOps() {
  const now = Date.now()
  for (const [id, op] of sessionOpsQueue) {
    if (now - op.at > SESSION_OPS_TTL_MS) sessionOpsQueue.delete(id)
  }
}

/**
 * 入队一条会话指令。
 * @param {string} op clear | delete | persona | voice | activity
 * @param {string} key 会话 key（voice 为空串：桥接用 sessionId 反查）
 * @param {string} [text]
 * @param {{sessionId?:string, voice?:string, level?:number|null}} [extra]
 *   `level`：单群响应档位（0..3），null = 跟随全局；只有 activity 指令会带。
 */
function enqueueSessionOp(op, key, text = '', extra = {}) {
  pruneSessionOps()
  // 同一个 key + 同一种操作只保留最新一条（连点两次不要建出两个新会话）。
  // voice 按 sessionId + 文本去重，避免模型一次回复里重复调工具刷屏。
  for (const [id, existing] of sessionOpsQueue) {
    const sameTarget = op === 'voice'
      ? existing.sessionId === extra.sessionId
      : existing.op === op && existing.key === key
    if (sameTarget) sessionOpsQueue.delete(id)
  }
  const id = `op-${Date.now().toString(36)}-${++sessionOpsSeq}`
  const level = (typeof extra.level === 'number' || extra.level === null) ? extra.level : undefined
  sessionOpsQueue.set(id, {
    id, op, key, text,
    sessionId: typeof extra.sessionId === 'string' ? extra.sessionId : '',
    voice: typeof extra.voice === 'string' ? extra.voice : '',
    ...(level === undefined ? {} : { level }),
    at: Date.now(), lease: 0,
  })
  while (sessionOpsQueue.size > SESSION_OPS_CAP) {
    const oldest = sessionOpsQueue.keys().next().value
    sessionOpsQueue.delete(oldest)
  }
  return id
}

/** 诊断用：队列长度（不含指令内容）。 */
export function sessionOpsSnapshot() {
  return { queued: sessionOpsQueue.size, ids: [...sessionOpsQueue.keys()] }
}

/**
 * 手动结算一条指令的回执（导出给测试用；生产路径由 session-ops 路由的
 * `{results:[{id, ok, detail}]}` 触发）。
 * @param {string} id
 * @param {{ok?:boolean, detail?:string}} result
 * @returns {boolean} 是否命中挂起项
 */
export function settleSessionOpResult(id, result) {
  return settleOpResult(id, result)
}


/**
 * 定位「当前 profile 的 node_modules」——外部插件扫描的默认目录。
 *
 * 为什么不用 import.meta.url 推：本包是 profile 里的 link 开发插件，
 * import.meta.url 指向源码目录（default-workspace/plugins/...），不是 profile。
 * 所以反过来找：哪个 profile 的 node_modules 里装了 `@local/dsh-qq-guard`，
 * 那个就是当前 profile。
 *
 * @returns {string[]} 候选目录（通常 1 个）
 */
export function findDefaultPluginDirs() {
  const root = path.join(os.homedir(), '.dsh', 'profiles')
  const out = []
  let names
  try { names = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const d of names) {
    if (!d.isDirectory()) continue
    const nm = path.join(root, d.name, 'node_modules')
    if (!existsSync(nm)) continue
    if (existsSync(path.join(nm, '@local', 'dsh-qq-guard'))) out.push(nm)
  }
  return out
}

/* ── 外部插件扫描（P0：只读展示，不加载任何外部代码）─────────────────
 *
 * 兼容两种生态：
 *   ① DSH 原生插件包：`package.json` 里有 `dsh` 字段（bundle / client 入口）；
 *   ② QQ Agent 模块：目录下有 `plugin.json` 或 `skill.json`（`skill.json` 优先，
 *      两者在对方装载器里等价，只是目录语义不同）。清单允许 UTF-8 BOM。
 *
 * 元数据按规范白名单解析，非标字段（settingsUi / intercept / commands / tools …）
 * 一律丢弃，只留一个计数；卡片上要显示的是稳定的那几个字段，不跟对方的补丁走。
 *
 * 兼容性判定只做**静态扫描**：命中 Node 原生模块、宿主内部引用（相对路径越出
 * 模块目录，如 `../../src/*`）或裸 npm 包 → 标「只读/受控」。P0 不执行任何代码，
 * 所以「受控」只是标签，不是执行许可。扫描失败一律 fail-closed 归到受控。
 */

/** QQ Agent 清单文件名：`skill.json` 优先，其次 `plugin.json`。 */
const QQ_MANIFEST_FILES = ['skill.json', 'plugin.json']

/** QQ Agent 清单里保留的标准字段；其余（非标扩展）一律丢弃。 */
const QQ_MANIFEST_FIELDS = new Set([
  'id', 'name', 'version', 'apiVersion', 'enabledByDefault',
  'category', 'description', 'author',
  'requires', 'capabilities', 'permissions',
  'configSchema', 'settings', 'prompt', 'deprecated', 'entry',
])

/** QQ Agent 规范分类枚举；非法值回退 `utility`（与对方的 normalizeManifest 一致）。 */
const QQ_CATEGORIES = new Set(['model', 'message', 'knowledge', 'media', 'utility', 'fun', 'query'])

/** 静态扫描边界：超限即按受控处理（fail-closed，和对方准入闸同款策略）。 */
const EXTERNAL_MAX_FILES = 500
const EXTERNAL_MAX_DEPTH = 12

/** 扫描时跳过的目录：依赖、版本库、产物目录都不是插件本体。 */
const EXTERNAL_SKIP_DIRS = new Set(['node_modules', '.git', '.github', 'coverage'])

/** 从源码里提取模块说明符：from 'x' / import 'x' / import('x') / require('x')。 */
const IMPORT_SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g
/** 运行期动态 import（模板串）：静态扫描看不到目标，按受控处理。 */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*`[^`]*\$\{/
/** Node 22+ 绕过 import/require 的取内置模块方式。 */
const GET_BUILTIN_MODULE_RE = /\bprocess\s*\.\s*getBuiltinModule\b/

/** 读 JSON，容忍 UTF-8 BOM（对方清单允许带 BOM，直接 JSON.parse 会炸）。 */
function readJsonWithBom(file) {
  const text = readFileSync(file, 'utf8')
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
}

/** 判断一个相对说明符是否越出模块目录（宿主内部引用）。 */
function escapesModuleDir(baseDir, spec) {
  const resolved = path.resolve(baseDir, spec)
  const rel = path.relative(baseDir, resolved)
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)
}

/**
 * 静态扫描模块依赖，产出兼容性判定所需的最小证据。
 *
 * 只读 `.js/.mjs/.cjs`，不 import、不执行；符号链接一律不跟（防环）。
 *
 * @param {string} dir 模块目录
 * @returns {{nodeBuiltins:string[], hostSrc:boolean, bare:string[], dynamic:boolean, files:number, truncated:boolean}}
 */
export function scanModuleDeps(dir) {
  const base = path.resolve(dir)
  const builtins = new Set(builtinModules)
  const nodeBuiltins = new Set()
  const bare = new Set()
  let hostSrc = false
  let dynamic = false
  let files = 0
  let truncated = false

  const walk = (current, depth) => {
    if (truncated) return
    if (depth > EXTERNAL_MAX_DEPTH) { truncated = true; return }
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const item of entries) {
      if (truncated) return
      if (item.name.startsWith('.') || EXTERNAL_SKIP_DIRS.has(item.name)) continue
      if (item.isSymbolicLink()) continue
      const full = path.join(current, item.name)
      if (item.isDirectory()) { walk(full, depth + 1); continue }
      if (!/\.(?:js|mjs|cjs)$/i.test(item.name)) continue
      if (files >= EXTERNAL_MAX_FILES) { truncated = true; return }
      files += 1
      let text
      try { text = readFileSync(full, 'utf8') } catch { continue }
      if (DYNAMIC_IMPORT_RE.test(text) || GET_BUILTIN_MODULE_RE.test(text)) dynamic = true
      for (const match of text.matchAll(IMPORT_SPEC_RE)) {
        const spec = match[1].trim()
        if (!spec) continue
        const name = spec.startsWith('node:') ? spec.slice(5) : spec
        if (spec.startsWith('node:') || builtins.has(name)) { nodeBuiltins.add(spec); continue }
        if (spec.startsWith('.')) {
          if (escapesModuleDir(base, spec)) hostSrc = true
          continue
        }
        if (path.isAbsolute(spec)) { hostSrc = true; continue }
        bare.add(spec)
      }
    }
  }

  walk(base, 0)
  return {
    nodeBuiltins: [...nodeBuiltins].sort(),
    hostSrc,
    bare: [...bare].sort(),
    dynamic,
    files,
    truncated,
  }
}

/**
 * 兼容性分级（P0 只用于打标签）。
 *
 * @returns {{tier:string, label:string, reasons:string[]}}
 */
function classifyExternalCompat({ deps, manifestError = '' }) {
  if (manifestError) return { tier: 'invalid', label: '清单无效', reasons: [manifestError] }
  const reasons = []
  if (deps.nodeBuiltins.length > 0) {
    reasons.push(`依赖 Node 原生模块：${deps.nodeBuiltins.slice(0, 5).join('、')}`)
  }
  if (deps.hostSrc) reasons.push('引用了宿主内部模块（相对路径越出插件目录）')
  if (deps.bare.length > 0) {
    reasons.push(`依赖外部 npm 包：${deps.bare.slice(0, 4).join('、')}`)
  }
  if (deps.dynamic) reasons.push('存在运行期动态 import（静态扫描看不到目标）')
  if (deps.truncated) reasons.push('代码文件数超过扫描上限，按受控处理（fail-closed）')
  if (reasons.length > 0) return { tier: 'controlled', label: '只读/受控', reasons }
  return { tier: 'self-contained', label: '自包含', reasons: [] }
}

/** 入参统一成数组：字符串 → 单元素，null/undefined → 空，数组逐项 String 去重。 */
function asStringArray(value) {
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      const text = String(item ?? '').trim()
      if (text && !out.includes(text)) out.push(text)
    }
    return out
  }
  if (value === null || value === undefined) return []
  const single = String(value).trim()
  return single ? [single] : []
}

/**
 * configSchema 的展示上限：清单来自外部目录，不能让它把设置页撑爆。
 */
const MAX_CONFIG_SCHEMA_FIELDS = 100
const MAX_CONFIG_TEXT = 200
const MAX_CONFIG_ENUM_VALUES = 50

/** 截断展示文本（清单里的 label/description 可能很长或带换行）。 */
function clipConfigText(value, max = MAX_CONFIG_TEXT) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

/**
 * 归一化 QQ Agent 的 configSchema。
 *
 * P1.5 只渲染 4 种类型：boolean / number / string / enum；`action` 是对方控制台的
 * 界面入口、`internal` 只是说明，两者都丢弃（不认识的类型不猜语义）。
 *
 * @param {unknown} raw 清单里的 configSchema
 * @returns {Record<string, object>}
 */
export function normalizeConfigSchema(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  let count = 0
  for (const [key, def] of Object.entries(raw)) {
    if (count >= MAX_CONFIG_SCHEMA_FIELDS) break
    if (!def || typeof def !== 'object' || Array.isArray(def)) continue
    const type = typeof def.type === 'string' ? def.type : ''
    if (!['boolean', 'number', 'string', 'enum'].includes(type)) continue

    const field = { type }
    if (typeof def.label === 'string') field.label = clipConfigText(def.label)
    if (typeof def.description === 'string') field.description = clipConfigText(def.description)

    if (type === 'boolean') {
      field.default = def.default === true
    } else if (type === 'number') {
      field.default = Number.isFinite(Number(def.default)) ? Number(def.default) : 0
      for (const name of ['min', 'max', 'step']) {
        if (Number.isFinite(Number(def[name]))) field[name] = Number(def[name])
      }
    } else if (type === 'string') {
      field.default = typeof def.default === 'string' ? def.default : ''
      if (def.secret === true) field.secret = true
      if (def.multiline === true) field.multiline = true
    } else {
      let values = []
      if (Array.isArray(def.values)) {
        values = def.values.map((value) => String(value)).filter(Boolean)
      } else if (Array.isArray(def.options)) {
        values = def.options
          .filter((option) => option && typeof option === 'object' && option.value !== undefined)
          .map((option) => String(option.value))
      }
      field.values = values.slice(0, MAX_CONFIG_ENUM_VALUES)
      const fallback = field.values.includes(String(def.default))
        ? String(def.default)
        : (field.values[0] ?? '')
      field.default = fallback
    }
    out[key] = field
    count += 1
  }
  return out
}

/**
 * 从清单的 settings 里挑出 configSchema 声明过的默认值。
 *
 * 只收原始类型（字符串/数字/布尔），不把外部清单的任意对象塞进配置。
 *
 * @param {unknown} raw 清单里的 settings
 * @param {Record<string, object>} schema 归一化后的 configSchema
 * @returns {Record<string, string|number|boolean>}
 */
function pickSettingsDefaults(raw, schema) {
  const out = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (!(key in schema)) continue
      if (['string', 'number', 'boolean'].includes(typeof value)) out[key] = value
    }
  }
  for (const [key, field] of Object.entries(schema)) {
    if (!(key in out) && field.default !== undefined) out[key] = field.default
  }
  return out
}

/**
 * 按 QQ Agent 规范归一化清单：补默认值、校验 id、丢弃非标字段。
 *
 * @param {object|null} raw 已解析的清单（解析失败传 null）
 * @param {{dirName:string, moduleDir:string, manifestFile:string, manifestError?:string}} options
 */
export function normalizeQqManifest(raw, { dirName, moduleDir, manifestFile, manifestError = '' }) {
  const problems = []
  const manifest = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null
  if (!manifest) {
    const reason = manifestError || `清单内容不是对象（${manifestFile}）`
    return {
      entry: {
        id: dirName,
        name: dirName,
        version: '0.0.0',
        description: '',
        author: '',
        category: 'utility',
        apiVersion: 1,
        kind: manifestFile === 'skill.json' ? 'skill' : 'plugin',
        format: manifestFile,
        source: manifestFile,
        requires: [],
        capabilities: [],
        permissions: [],
        enabledByDefault: false,
        unknownFieldCount: 0,
        entry: '',
        hasEntry: false,
        configSchema: {},
        settingsDefaults: {},
      },
      problems: [reason],
    }
  }

  const str = (value) => (typeof value === 'string' ? value.trim() : '')
  const rawId = str(manifest.id)
  if (!rawId) problems.push('清单缺少 id，已回退成目录名')
  else if (!/^[a-z0-9][a-z0-9._-]*$/i.test(rawId)) problems.push(`清单 id「${rawId}」不符合规范`)
  const id = rawId || dirName

  const categoryRaw = str(manifest.category)
  const category = QQ_CATEGORIES.has(categoryRaw) ? categoryRaw : 'utility'
  if (categoryRaw && !QQ_CATEGORIES.has(categoryRaw)) {
    problems.push(`分类「${categoryRaw}」非规范值，已回退 utility`)
  }

  const version = str(manifest.version) || '0.0.0'
  const apiVersion = Number.isFinite(Number(manifest.apiVersion)) && Number(manifest.apiVersion) > 0
    ? Number(manifest.apiVersion)
    : 1

  const entryRel = str(manifest.entry) || 'index.js'
  let hasEntry = false
  if (escapesModuleDir(moduleDir, entryRel)) {
    problems.push(`入口「${entryRel}」越出模块目录，已忽略`)
  } else {
    try { hasEntry = existsSync(path.resolve(moduleDir, entryRel)) } catch { hasEntry = false }
    if (!hasEntry) problems.push(`入口文件不存在：${entryRel}`)
  }

  const unknownFieldCount = Object.keys(manifest)
    .filter((key) => !QQ_MANIFEST_FIELDS.has(key)).length
  const configSchema = normalizeConfigSchema(manifest.configSchema)
  const settingsDefaults = pickSettingsDefaults(manifest.settings, configSchema)

  return {
    entry: {
      id,
      name: str(manifest.name) || id,
      version,
      description: str(manifest.description),
      author: str(manifest.author),
      category,
      apiVersion,
      kind: manifestFile === 'skill.json' ? 'skill' : 'plugin',
      format: manifestFile,
      source: manifestFile,
      requires: asStringArray(manifest.requires),
      capabilities: asStringArray(manifest.capabilities),
      permissions: asStringArray(manifest.permissions),
      enabledByDefault: manifest.enabledByDefault !== false,
      unknownFieldCount,
      entry: entryRel,
      hasEntry,
      configSchema,
      settingsDefaults,
    },
    problems,
  }
}

/**
 * 读取单个模块目录的卡片数据；不是插件目录时返回 null。
 *
 * 三种有效形态：
 *   · package.json 且带 `dsh` 字段 → DSH 原生包；
 *   · skill.json                 → QQ Agent 技能；
 *   · plugin.json                → QQ Agent 插件。
 *
 * 清单坏了不丢弃：仍然出一张卡片，带 `compat.tier='invalid'` 和原因。
 */
function readExternalModule(moduleDir, rootDir) {
  const dirName = path.basename(moduleDir)
  const relDir = path.relative(rootDir, moduleDir).split(path.sep).join('/') || '.'

  let pkg = null
  let pkgError = ''
  const pkgPath = path.join(moduleDir, 'package.json')
  if (existsSync(pkgPath)) {
    try { pkg = readJsonWithBom(pkgPath) } catch (error) { pkgError = `解析 package.json 失败：${error?.message ?? error}` }
  }

  const isDshPackage = pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg)
    && pkg.dsh !== undefined && pkg.dsh !== null
  if (isDshPackage) {
    // @local/* 是本仓库 link 出来的开发插件（含本插件自己），不算外部插件。
    if (typeof pkg.name === 'string' && pkg.name.startsWith('@local/')) return null
    return {
      id: String(pkg.name ?? dirName),
      name: String(pkg.name ?? dirName),
      version: String(pkg.version ?? '0.0.0'),
      description: String(pkg.description ?? ''),
      author: typeof pkg.author === 'string' ? pkg.author : '',
      category: '',
      apiVersion: 0,
      kind: 'package',
      format: 'package.json',
      source: 'package.json',
      dir: path.resolve(moduleDir),
      relDir,
      dirName,
      hasClient: Boolean(pkg.dsh?.client),
      hasBundle: Boolean(pkg.dsh?.bundle),
      requires: [],
      capabilities: [],
      permissions: [],
      enabledByDefault: false,
      unknownFieldCount: 0,
      entry: '',
      hasEntry: false,
      configSchema: {},
      settingsDefaults: {},
      deps: { nodeBuiltins: [], hostSrc: false, bare: [], dynamic: false, files: 0, truncated: false },
      compat: { tier: 'native', label: 'DSH 原生', reasons: [] },
      warnings: [],
      error: pkgError,
    }
  }

  // 找 QQ Agent 清单：skill.json 优先，其次 plugin.json。
  let manifestFile = ''
  let manifest = null
  let manifestError = ''
  for (const file of QQ_MANIFEST_FILES) {
    const full = path.join(moduleDir, file)
    if (!existsSync(full)) continue
    manifestFile = file
    try { manifest = readJsonWithBom(full) } catch (error) {
      manifestError = `解析 ${file} 失败：${error?.message ?? error}`
    }
    break
  }
  if (!manifestFile) return null

  const normalized = normalizeQqManifest(manifest, {
    dirName, moduleDir, manifestFile, manifestError,
  })
  const deps = manifestError
    ? { nodeBuiltins: [], hostSrc: false, bare: [], dynamic: false, files: 0, truncated: false }
    : scanModuleDeps(moduleDir)
  const compat = classifyExternalCompat({ deps, manifestError })
  const warnings = [...normalized.problems]
  if (pkgError) warnings.push(pkgError)
  if (normalized.entry.id !== dirName) {
    warnings.push(`清单 id「${normalized.entry.id}」与目录名「${dirName}」不一致`)
  }

  return {
    ...normalized.entry,
    dir: path.resolve(moduleDir),
    relDir,
    dirName,
    hasClient: false,
    hasBundle: false,
    deps,
    compat,
    warnings,
    error: manifestError,
  }
}

/**
 * 只读扫描一个目录，找出所有有效插件模块。
 *
 * 支持三种摆放：
 *   · 目录本身就是模块根（用户直接选了某个插件目录）；
 *   · 目录下平铺模块（node_modules / plugins / skills 这一层）；
 *   · QQ Agent 应用根：`<root>/plugins/*` 与 `<root>/skills/*`。
 *
 * 不写任何文件、不 import 外部代码；符号链接一律跳过（本仓库 link 出去的
 * 开发插件不算「外部安装」）。
 *
 * @param {string} dir 目录（node_modules、QQ Agent 的 app 根，或单个插件目录）
 * @returns {Array<object>} 卡片数据
 */
export function scanPluginDir(dir) {
  const out = []
  const seen = new Set()

  const consider = (moduleDir) => {
    let real
    try { real = path.resolve(moduleDir) } catch { return }
    const key = process.platform === 'win32' ? real.toLowerCase() : real
    if (seen.has(key)) return
    seen.add(key)
    let entry
    try { entry = readExternalModule(moduleDir, dir) } catch { entry = null }
    if (entry) out.push(entry)
  }

  const scanContainer = (container) => {
    let entries
    try { entries = readdirSync(container, { withFileTypes: true }) } catch { return }
    for (const item of entries) {
      if (item.name.startsWith('.') || EXTERNAL_SKIP_DIRS.has(item.name)) continue
      const full = path.join(container, item.name)
      if (item.name.startsWith('@')) {
        let subs
        try { subs = readdirSync(full, { withFileTypes: true }) } catch { continue }
        for (const sub of subs) {
          if (sub.name.startsWith('.')) continue
          consider(path.join(full, sub.name))
        }
        continue
      }
      // 跳过符号链接 / junction：那些是本仓库 `link:` 出去的开发插件
      // （dsh-bili-whale、dsh-ofm-eac-tunnel 之类），不算「外部安装的插件」。
      if (item.isSymbolicLink()) continue
      consider(full)
    }
  }

  // ① 目录自己就是模块根。
  consider(dir)
  // ② 平铺在目录下的模块。
  scanContainer(dir)
  // ③ QQ Agent 应用根：固定两个一级目录（与对方的装载器一致）。
  for (const sub of ['plugins', 'skills']) {
    const container = path.join(dir, sub)
    let stat
    try { stat = statSync(container) } catch { continue }
    if (!stat.isDirectory()) continue
    scanContainer(container)
  }
  return out
}

/**
 * 取 DSH 的目录选择能力（`ctx.directoryPicker`）。
 *
 * 为什么用它而不是自己 spawn 一个 Node 弹窗脚本：
 *   profile 的 `directory-picker` 行挂的是 `dsh-host-directory-picker-auto`，
 *   在 Windows 桌面会解析成 native 后端 —— 它已经实现好了
 *   「独立子进程 + Win32 IFileOpenDialog + 取消/失败语义」，自己再写一份纯属重复踩坑。
 *   契约见 @deepseek-ai/dsh-host-directory-picker：`capability()` 返回
 *   `{ kind: 'native', pick(signal) }` 或 `{ kind: 'browse', ... }`；
 *   `pick()` 解析为绝对路径，取消时解析为 null。
 *
 * @param {object} ctx 插件上下文
 * @returns {object|undefined} 选择器服务；未挂载时为 undefined
 */
function readDirectoryPicker(ctx) {
  try {
    if (ctx?.directoryPicker !== undefined && ctx.directoryPicker !== null) return ctx.directoryPicker
  } catch { /* 服务未挂载时属性访问可能抛错，退回 ctx.get */ }
  try {
    if (typeof ctx?.get === 'function') {
      const viaGet = ctx.get('directoryPicker')
      if (viaGet !== undefined && viaGet !== null) return viaGet
    }
  } catch { /* 同上 */ }
  return undefined
}

/**
 * 桥接上报的 QQ 账号状态四态（批次 5）。
 *
 * 为什么是四态而不是布尔：桥接只凭 WS 无法保证探到 `get_status`（比如 NapCat
 * 版本不回这个 action、或调用超时）。「未确认」必须和「离线」区分开——
 * 把探不到当成离线会冤枉用户，当成在线又是谎报。与
 * `qq-bridge/src/status.mjs` 的 `QQ_STATES` 保持一致（两个进程不共享模块，
 * 故意用同一份字面量，改一处必须同步改另一处，回归用例会锁）。
 */
const QQ_STATES = new Set(['online', 'offline', 'unverified', 'disconnected'])

/**
 * autoStart「本 DSH 生命周期内只执行一次」的进程级标记（批次 5）。
 *
 * 为什么需要：DSH 的配置保存走 `config-editor.edit()`，写盘后会
 * `reconcileProfilePatches(...)` 重建本 entry（热重载）。旧实现每次重载都会
 * 走到 autoStart 分支：旧 fiber 的 teardown 先 `runner.stop()`，新实例 1.5s 后
 * 再 `start()` —— 结果就是**用户每改一个设置，桥接就被停掉重启一次**。
 * 用 `Symbol.for`（进程级全局注册表）打标记，重载不会清掉，DSH 重启才重置。
 */
const AUTO_START_MARK = Symbol.for('@local/dsh-qq-guard:auto-start-honored')


function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 读一个 JSON 请求体（有大小上限）。
 *
 * 为什么要自己写：这个插件没有装 body parser，而 P1 的沙箱测试路由需要
 * `{ id, dir }`。超过上限直接 413，避免有人拿超大 body 拖死 Host。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{maxBytes?:number}} [options]
 * @returns {Promise<object>}
 */
function readJsonBody(req, { maxBytes = 8 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(Object.assign(new Error(`请求体超过 ${maxBytes} 字节`), { statusCode: 413 }))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }))
      }
    })
    req.on('error', (error) => reject(error))
  })
}

/**
 * 收敛桥接上报的单条会话数据。
 *
 * 桥接是自己人，但**这条路由原则上是「只收白名单字段」**：任何字段、任何长度
 * 都按契约裁一次，防止将来桥接改动或第三方进程伪造把垃圾塞进设置页。
 * 文本一律转成单行字符串再截断，前端 React 会转义，不做 HTML 拼接。
 *
 * ⚠️ 白名单漏字段的后果是**静默的**：桥接上报了但这里裁掉，设置页永远读到 undefined。
 * 2026-10-24 就踩过一次（activityLevel / persona 都被裁掉，单群档位与单人设回填全失效），
 * 所以新增上报字段时必须同步改这里，并有测试盯着。
 *
 * @param {unknown} row
 * @returns {{key:string, sessionId:string, kind:'private'|'group', qq:string,
 *   name:string, title:string, unread:number, lastAt:number, lastText:string,
 *   persona:string, activityLevel:number|null}|null}
 */
function sanitizeSessionRow(row) {
  if (!row || typeof row !== 'object') return null
  const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '')
  const num = (value, max) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : 0
  }
  const key = text(row.key, 80)
  if (!key) return null
  return {
    key,
    sessionId: text(row.sessionId, 160),
    kind: row.kind === 'group' ? 'group' : 'private',
    qq: text(row.qq, 40),
    name: text(row.name, 80),
    title: text(row.title, 120),
    unread: num(row.unread, 9999),
    lastAt: num(row.lastAt, 8.64e15),
    lastText: text(row.lastText, 200),
    // 单人设回填（会话详情里的输入框要显示已保存的值）。多行不能压成单行，
    // 只裁掉首尾空白与长度，换行原样保留。
    persona: textPreservingLines(row.persona, 20000),
    // 单群响应档位：**null = 跟随全局**，是一个有意义的取值，必须原样保留；
    // 绝不能走上面的 num()（它会把 0 和 null 都压成 0，"仅艾特"和"跟随全局"就分不清了）。
    activityLevel: normalizeActivityLevelInput(row.activityLevel),
  }
}

/** 多行文本按原样保留（只 trim + 截断），用于人设这类正文。 */
function textPreservingLines(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** 单群响应档位归一化：0..3 的整数，其余（含 null/undefined/NaN）一律 null。 */
function normalizeActivityLevelInput(value) {
  if (value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (!Number.isInteger(n) || n < 0 || n > 3) return null
  return n
}

/**
 * 插件入口。本插件被装载两次（见 cordis.patch.yml）：
 *   · role: 'guard'    —— 作为 qq-chat preset 的子行，只做工具门禁；
 *   · role: 'settings' —— profile 顶层行，持有 Config / 设置页 / 只读 HTTP 路由。
 *
 * ## 2026-10-20 事故记录（务必先读，别再犯）
 *
 * 第一版允许 `role === undefined` 时"两者都做"，理由是向后兼容旧的单实例装载。
 * 结果：给 profile 顶层加了 `qq-guard` 行后，Schemastery 校验把未声明的 `role`
 * 丢弃成 undefined，走了兼容分支 → `tools.guard()` 挂到**顶层 plain context**上
 * → Service 契约里 "a plain-context guard applies globally" 生效 → **整个 profile
 * 的每一个会话**（包括浏览器里用户自己的会话）的工具全被拒，只剩 ask_user_question
 * 和 todo_write。用户当场锁死，必须手改 yaml + 重启才恢复。
 *
 * 现在的铁律（fail-closed）：
 *   1. `role === undefined` → **什么都不做**，直接 return。绝不"兼容"。
 *   2. `role === 'guard'` → 只允许在 preset 作用域内；顶层一律拒绝装载。
 *   3. `role === 'settings'` → 才碰 UI / 路由。
 * 任何一条不确定，都选择"不挂载"——少一层防护远比锁死整个 profile 可接受。
 */
export function apply(ctx, config) {
  const role = readRole(config)

  if (role === 'guard') {
    applyGuard(ctx, config)
    return
  }
  if (role === 'settings') {
    // 按请求覆写模型（无痕热切换）：必须装在**顶层实例**、且必须在 applySettings 之前。
    // 为什么不放进 applySettings：它开头有 `if (ctx.webServer === undefined) return`，
    // 会让 agent/request 钩子跟着一起被跳过。
    // 传 config 进去：models 路由要把「设置页当前保存的模型」一起回给面板（LaunchCard 展示用）。
    installModelOverride(ctx, { config })
    applySettings(ctx, config ?? {})
    return
  }
  // role 未声明（含被 schema 丢弃、写错、旧配置）：两者都不做。
  // 这里**不抛错**：抛错会让整个 bundle 装载失败，那也是另一种形式的"炸掉用户环境"。
  // 只在控制台留一条线索，便于排查"为什么 guard 没生效"。
  console.warn?.(
    `[qq-guard] 本实例未声明 role（读到 ${JSON.stringify(role)}），已跳过全部注册。`
    + '请在 cordis.patch.yml 里显式写 role: guard（preset 子行）或 role: settings（顶层行）。',
  )
}

/**
 * 取出 Config 里 `role` 的真实字符串值。
 *
 * ⚠️ 坑：`.volatile()` 字段解析后**不是原始值**，而是一个带 `get()` 的
 * 可观察包装对象（实测 2026-10-20：`Config({role:'guard'}).role` 是
 * `{ get: fn, [Symbol(cosmokit.volatile.write)]: fn }`，直接 `=== 'guard'` 恒为 false）。
 * 所以必须经 `.get()` 取值；同时兼容没加 `.volatile()` 的普通值形态，
 * 因为将来若去掉 volatile 这里不能静默失效。
 * @param {unknown} config 插件 Config 解析结果
 * @returns {string|undefined}
 */
export function readRole(config) {
  if (config === null || typeof config !== 'object') return undefined
  const raw = config.role
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') return raw
  if (typeof raw?.get === 'function') {
    const value = raw.get()
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

/**
 * 系统提示词里「部署人设」那一段的稳定 section 名。
 * 与 @deepseek-ai/dsh-system-prompt 的常量一致（不能 import 它：插件不依赖 DSH 包）。
 */
const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

/**
 * 动态人设 section：替换 preset 里原本那条静态 `dsh-persona` 行。
 *
 * - section 名沿用官方常量，作用域是 preset（guard 实例的 ctx），因此遮蔽全局
 *   默认人设，只影响 QQ 会话；
 * - `complete: true` 保证人设是该会话**唯一**系统提示词（Harness 自述等不穿透）；
 * - `text` 是函数：每次组装现读共享人设状态，所以「单人设保存后下一条消息生效」。
 *
 * 人设取不到时依次回退：单人设 → 全局人设 → config.personaDefault。
 *
 * @param {object} ctx guard 实例的 ctx（preset 作用域）
 * @param {unknown} config 插件 Config 解析结果
 */
function applyPersonaSection(ctx, config) {
  const cfg = plainConfig(config) ?? {}
  const fallback = typeof cfg.personaDefault === 'string' ? cfg.personaDefault : ''
  const register = (spCtx) => {
    const systemPrompt = spCtx.get?.('systemPrompt') ?? spCtx.systemPrompt
    if (!systemPrompt || typeof systemPrompt.section !== 'function') {
      console.warn?.('[qq-guard] role=guard 找不到 systemPrompt 服务：动态人设未注册，将沿用全局层默认提示词')
      return
    }
    const order = typeof systemPrompt.getSectionOrder === 'function'
      ? systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')
      : 0
    const text = (context) => personaTextForSession(context?.agent?.session?.id, fallback)
    const effect = typeof spCtx.effect === 'function'
      ? spCtx.effect.bind(spCtx)
      : (fn) => fn()
    effect(
      () => systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: Number.isFinite(order) ? order : 0,
        complete: true,
        text,
      }),
      'qq-guard: dynamic persona section',
    )
    if (typeof systemPrompt.suppressRuntimeContext === 'function') {
      effect(
        () => systemPrompt.suppressRuntimeContext(),
        'qq-guard: persona suppress runtime context',
      )
    }
  }
  if (typeof ctx.inject === 'function') {
    // 服务已就绪就直接用当前 ctx 注册（保证 section 落在 preset 作用域这一层）；
    // 还没就绪才走 inject 等它出现。
    let ready
    try { ready = ctx.get?.('systemPrompt') } catch { ready = undefined }
    if (ready && typeof ready.section === 'function') register(ctx)
    else ctx.inject(['systemPrompt'], register)
  } else {
    register(ctx)
  }
}

/**
 * 探测「本实例是不是在 preset 作用域里」用的假工具名（DSH 里不可能存在）。
 * 用不存在名字探测是**无副作用**的：`restrict()` 先校验 scope、再校验名字，
 * 两条 throw 路径都发生在 `layers.effect()` 之前，不会留下任何限制。
 */
const SCOPE_PROBE_TOOL = '__dsh_qq_guard_scope_probe__'

/**
 * 判定当前 ctx 是否装在 **agent preset** 作用域里（决定要不要挂 guard）。
 *
 * ⚠️ 2026-10-24 的 P0 事故就出在这个判定上：旧实现只看
 * `agentPresets.composedPreset(ctx)`，结果在 preset 自己的子行里**永远**拿到 undefined。
 *
 * 为什么：`composedPreset(ctx)` → `generationFor(ctx)`（dsh-agent-preset-registry/lib/index.js）
 * 的实现是「取 `scopeOf(ctx)` 的**父** scope，去 generations 表里查」。
 * preset 的生成作用域是 `createScope(owner, key)` 造出来的，key **没有 parent**；
 * preset 子行（我们这条 guard）的 ctx 作用域**就是这个 generation 本身**，
 * 所以父 scope 一定查不到 → `composedPreset()` 恒返回 undefined。
 * 它只对「已经 bindScopeParent 到 generation 的 agent.ctx」成立。
 *
 * ⇒ 旧判定把「在 preset 内」误判成「在顶层」，applyGuard 第一步就 return，
 *    后面三层（人设 section / qq_send_voice / restrict）**全部没跑**。
 *    真机症状：system/message 是全局 Harness 提示词、工具清单里没有 qq_send_voice、
 *    连本该被藏的 ops_glob / load_workspace_dependencies 都还在。
 *
 * 现在的判据（两层取或，任一成立即认定「在 preset 内」）：
 *   ① `composedPreset(ctx)` 返回非空字符串 —— agent ctx 场景，保留兼容；
 *   ② ctx 处于 **scoped** 上下文。DSH 里只有两类 scoped ctx：agent.ctx 与
 *      preset 生成作用域；profile 顶层的行装载在**无 scope** 的 ctx 上。
 *      探针用 `tools.restrict()`：它第一行就 `scopeOf(this.ctx)`，
 *      无 scope 时抛 "requires a scoped context"；有 scope 才继续校验工具名。
 *
 * ⚠️ 兜底方向是 **fail-closed**：只有拿得到「正向证据」（composedPreset 有值 /
 *    restrict 已过 scope 校验）才允许挂 guard；其它任何意外（DSH 改错误文案、
 *    版本升级、代理异常）一律当作「不在 preset」拒绝装载。理由：误判成顶层只是
 *    QQ 会话失去门禁（日志可见、可立刻修），误判成 preset 却是全局 guard
 *    把所有浏览器会话锁死 —— 后者正是 2026-10-20 那次事故。
 *
 * @param {object} ctx 插件实例 ctx（preset 子行或 profile 顶层行）
 * @returns {{inPreset:boolean, via:string, presetId?:string, reason?:string}}
 */
function detectPresetScope(ctx) {
  let presetId
  try { presetId = ctx.get?.('agentPresets')?.composedPreset?.(ctx) } catch { presetId = undefined }
  if (typeof presetId === 'string' && presetId !== '') {
    return { inPreset: true, via: 'composedPreset', presetId }
  }

  const tools = ctx.get?.('tools') ?? ctx.tools
  if (!tools || typeof tools.restrict !== 'function') {
    return { inPreset: false, via: 'none', reason: 'tools 服务不可用，无法判定作用域' }
  }
  try {
    const undo = tools.restrict({ deny: [SCOPE_PROBE_TOOL] })
    // 理论上到不了这里（假名字不可能被接受）。真发生了就立刻撤销，绝不留脏限制。
    try { undo?.() } catch { /* 撤销失败也没关系：名字本身不存在 */ }
    return { inPreset: true, via: 'restrict-probe(accepted)' }
  } catch (error) {
    const message = String(error?.message ?? error)
    if (message.includes('requires a scoped context')) {
      // 无 scope = profile 顶层：坚决不挂 guard，否则全局锁死。
      return { inPreset: false, via: 'restrict-probe', reason: message }
    }
    // **只有正向证据才放行**：走到名字校验说明 scope 校验已通过。
    // （这两句文案来自 @deepseek-ai/dsh-tools 的 restrict()：先 scope、再 run_code、
    //   最后 unknown names / no-op。我们传了 deny，所以 no-op 那句实际不会出现，
    //   留着只是为了让「未来 restrict 改成先校验 filter 形状」时不会误判。）
    if (message.includes('names unknown global tool')
      || message.includes('restrict({}) is a no-op')) {
      return { inPreset: true, via: 'restrict-probe' }
    }
    // 其它任何异常（DSH 改文案 / 代理差异 / 版本升级）都**不当作证据**：
    //   · 误判成 top-level → guard 不装，QQ 会话失去门禁（危险，但日志里看得见，可立刻修）；
    //   · 误判成 preset    → 全局 tools.guard 把所有浏览器会话锁死（2026-10-20 事故，用户自己都进不来）。
    // 两害相权，宁可 fail-closed 到「不装」，并把原始 message 带进 warn 里方便定位。
    return { inPreset: false, via: 'restrict-probe', reason: message }
  }
}

/**
 * 宿主注入的「运行时上下文」消息标记。
 *
 * 2026-10-24 真机抓到的人设失效真因：DSH 的 mnemon 插件把 **USER.md / MEMORY.md
 * 的运行时快照当成一条 user 消息**塞进每一步（`agent/pre-step` 里
 * `createPluginMessage(text,'recall')`，source.kind = 'dsh-mnemon'，还有一条
 * form='instructions' 的引导语）。实测该消息 3863 字，内容是「称呼：用户翎羽…
 * 技术任务要求精简…」这类主人格设定 —— 对模型来说**用户消息比系统人设更硬**，
 * 于是它照着 USER.md 演，把我们 `complete: true` 的人设整段无视。
 *
 * 这既是人设问题，也是**隐私问题**：QQ 群友的对话不该带着主人的长期记忆。
 * 所以 QQ 会话里这两类消息一律摘掉（用 source.kind 精确匹配，不靠文本猜）。
 */
const INJECTED_CONTEXT_SOURCES = new Set(['dsh-mnemon', 'mnemon'])
/** 兜底文本标记：source.kind 变了也能认出来（宁可多摘一条，也不要漏）。 */
const INJECTED_CONTEXT_MARKERS = ['MNEMON RUNTIME MEMORY SNAPSHOT', 'Runtime Memory keeps compact hot memory']

/**
 * 这条 pre-step 消息是不是宿主注入的运行时上下文（不是 QQ 那头真说的话）。
 * @param {unknown} message
 * @returns {boolean}
 */
function isInjectedContextMessage(message) {
  const source = message?.source
  if (source && typeof source === 'object' && INJECTED_CONTEXT_SOURCES.has(String(source.kind ?? ''))) {
    return true
  }
  const blocks = Array.isArray(message?.content) ? message.content : []
  for (const block of blocks) {
    const text = typeof block?.text === 'string' ? block.text : ''
    if (text === '') continue
    if (INJECTED_CONTEXT_MARKERS.some((marker) => text.includes(marker))) return true
  }
  return false
}

/**
 * 从 QQ 会话的每一步里摘掉宿主注入的运行时上下文（人设失效 + 隐私）。
 *
 * ⚠️ **顺序是这件事的全部难点，2026-10-24 第一版就栽在这里（prepend 的时机搞反了）。**
 *
 * cordis 瀑布语义：监听器数组按顺序调用，**第一个最外层**（最先拿控制权、最后拿返回值）。
 * `prepend` = unshift（更外层），不 prepend = push（更内层）。
 * `next()` 的返回值会从内层往外层层传递，所以「谁能摘掉 mnemon 追加的消息」取决于
 * 我们是在 mnemon **外面**还是**里面**：
 *   · 我们更内层 → 我们先过滤（此时还没有 mnemon 的消息），返回后 mnemon 才追加 → 白做；
 *   · 我们更外层 → 我们先调 next()，mnemon 追加完才把结果交回来 → 这时候摘才有效。
 *
 * 实测的注册时机（这是关键）：
 *   · mnemon 在 **agent 创建事件里** 对 `agent.ctx` 做 `on(..., {prepend:true})`
 *     —— 它把自己插到最外层；
 *   · 我们的 guard 在 **preset 装载时** 注册（preset 是懒装载的，比 agent 早），
 *     所以无论是否 prepend，注册完都会在 mnemon 之后被 mnemon 的 unshift 顶到里面去。
 *     第一版就是这样静默失效的：真机新会话里 MNEMON 快照照旧出现 3 次。
 *
 * ⇒ 正确做法：**等 agent 创建完之后**，在这个 agent 自己的 ctx 上 `{prepend:true}` 再挂一个
 *    —— 用 `queueMicrotask` 保证落在 mnemon 的同步注册之后，unshift 之后我们就在最外层。
 *    同时保留 preset 作用域上的那个监听做兜底（它现在是内层，通常摘不到东西，但没坏处）。
 *
 * 作用域：监听器带 preset 的 scope 标记，只会收到 qq-chat 的 agent，浏览器会话一条都不碰。
 *
 * @param {object} ctx guard 实例 ctx（preset 作用域）
 */
function applyContextFilter(ctx) {
  /** 真正的过滤器：next() 回来之后再摘。 */
  const filter = async (payload, next) => {
    const decision = await next()
    if (decision === undefined || decision === null || decision.kind === 'reject') return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    if (messages.length === 0) return decision
    const kept = messages.filter((message) => !isInjectedContextMessage(message))
    const dropped = messages.length - kept.length
    if (dropped === 0) return decision
    console.info?.(`[qq-guard] 已摘掉 ${dropped} 条宿主注入上下文（运行时记忆不会进 QQ 会话）`)
    return { ...decision, messages: kept }
  }

  // 兜底：preset 作用域一层（懒装载时可能比 mnemon 更内层，通常摘不到，但不会有害）。
  ctx.on('agent/pre-step', filter)

  // 主力：每个 qq-chat agent 创建后，在它自己的 ctx 上用 prepend 挂到最外层。
  const seen = new WeakSet()
  ctx.on('agent/created', (payload) => {
    const agentCtx = payload?.agent?.ctx
    if (!agentCtx || typeof agentCtx.on !== 'function') return
    if (seen.has(agentCtx)) return
    seen.add(agentCtx)
    // 微任务：确保排在 mnemon 同步注册（以及任何后续同步注册）之后，
    // unshift 才是真正的「最外层」。改成同步会在某些装载顺序下再次失效。
    queueMicrotask(() => {
      try {
        agentCtx.on('agent/pre-step', filter, { prepend: true })
      } catch (error) {
        console.warn?.(`[qq-guard] 给 agent 挂上下文过滤失败（人设可能被记忆盖掉）：${error?.message ?? error}`)
      }
    })
  })
}

/**
 * 人设/上下文诊断日志（老板要求的「暴力日志」，默认关）。
 *
 * 打开方式（任一）：
 *   · 本插件 Config 的 `debugPrompt = true`（设置页「全局设置 → 高级参数」暂未暴露，
 *     但可以在 profile 的 cordis.patch.yml 里手写）；
 *   · 环境变量 `QQG_PROMPT_DEBUG=1`（改完重启 DSH 生效）。
 *
 * 输出：每一步组装后的 system sections（名字 + 字数）+ runtime contexts（名字）+ 人设正文前 120 字。
 * 只在**内容变化**时打，避免每步刷屏。看日志的位置是 DSH 主进程 stdout。
 *
 * @param {object} ctx guard 实例 ctx（preset 作用域）
 * @param {() => boolean} enabled 现读开关
 */
function applyPromptDebug(ctx, enabled) {
  const lastBySession = new Map()
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const out = await next()
    try {
      if (!enabled()) return out
      const sessionId = String(context?.agent?.session?.id ?? context?.agent?.id ?? '-')
      const sections = (out?.sections ?? []).map((section) => ({
        name: String(section?.name ?? '?'),
        chars: String(section?.text ?? '').length,
      }))
      const contexts = (out?.contexts ?? []).map((entry) => String(entry?.name ?? '?'))
      const persona = (out?.sections ?? []).find((s) => s?.name === PERSONA_PREFIX_SECTION)
      const signature = JSON.stringify({ sections, contexts, personaHead: String(persona?.text ?? '').slice(0, 40) })
      if (lastBySession.get(sessionId) === signature) return out
      lastBySession.set(sessionId, signature)
      while (lastBySession.size > 200) lastBySession.delete(lastBySession.keys().next().value)
      console.info(
        `[Persona Debug] session=${sessionId} `
        + `sections=[${sections.map((s) => `${s.name}:${s.chars}`).join(', ')}] `
        + `contexts=[${contexts.join(', ')}] `
        + `personaHead=${JSON.stringify(String(persona?.text ?? '').slice(0, 120))}`,
      )
      if (process.env.QQG_PROMPT_DEBUG === 'dump') {
        console.info('[Persona Debug] full sections:', JSON.stringify(out?.sections ?? []))
      }
    } catch (error) {
      console.warn?.(`[qq-guard] Persona Debug 日志失败（已忽略）：${error?.message ?? error}`)
    }
    return out
  }, { prepend: true })
}

/**
 * 人设/上下文诊断日志是否开启。
 *
 * 三个来源任一为真即开：环境变量 `QQG_PROMPT_DEBUG`、本行 Config 的 `debugPrompt`、
 * 设置页那份共享 Config 的 `debugPrompt`（guard 子行拿不到设置页配置，所以要读共享源）。
 *
 * @param {unknown} config guard 实例自己的 Config
 * @returns {boolean}
 */
function promptDebugEnabled(config) {
  if (process.env.QQG_PROMPT_DEBUG) return true
  if (plainConfig(config)?.debugPrompt === true) return true
  try { return plainConfig(featureState.source)?.debugPrompt === true } catch { return false }
}

/**
 * 工具门禁：**只能在 preset 作用域里跑**。
 *
 * 为什么必须校验：`ctx.tools.guard` 在 plain context 上是**全局**的
 * （Service 契约："a plain-context guard applies globally"），挂到 profile 顶层
 * 会把浏览器会话一起锁死——2026-10-20 就是这么炸的。
 *
 * 判定见 {@link detectPresetScope}（不要再用 composedPreset 单独下结论）。
 *
 * @param {object} ctx 插件实例 ctx
 * @param {unknown} config 插件 Config
 */
function applyGuard(ctx, config) {
  const detected = detectPresetScope(ctx)

  if (!detected.inPreset) {
    // 顶层 / 非 preset 作用域：坚决不挂 guard。
    console.warn?.(
      '[qq-guard] role=guard 但当前不在任何 agent preset 作用域内'
      + `（检测方式 ${detected.via}：${detected.reason ?? '无 scope'}）；`
      + '已拒绝装载 tools.guard，避免它全局生效锁死整个 profile。'
      + '请把这条行放到 preset 的 plugins[] 子级里。',
    )
    return
  }
  console.info?.(
    `[qq-guard] role=guard 作用域判定通过（${detected.via}`
    + `${detected.presetId ? `, preset=${detected.presetId}` : ''}），开始装配人设/语音工具/工具门禁`,
  )

  // ── 第 0 层：动态人设 section（替代 preset 里原有的静态 dsh-persona 行）──
  //
  // 为什么必须动态：preset 的人设要按会话区分（单人设覆盖），静态 config 文本做不到。
  // 为什么用 `complete: true`：preset 的人设是**唯一**系统提示词；不加的话 profile
  // 全局层的 Harness 自述 / Agent Teams / Shell routing 会穿透进 QQ 会话，模型端出助手腔。
  // 证据：dsh-system-prompt/lib/index.js:380-405（complete section 在瀑布后强制保留为唯一 section）。
  //
  // 兜底链条：单人设（HTTP 推送）> 全局人设（桥接推送）> preset 的 personaDefault。
  // 三者都为空的极端情况下 section 文本为空串 —— 不会崩，但模型会没有身份，
  // 所以 cordis.patch.yml 里 personaDefault 必须始终有内容。
  applyPersonaSection(ctx, config)

  // ── 第 0.2 层：摘掉宿主注入的运行时上下文（人设失效 / 隐私的真正元凶）──
  //
  // 只靠 `complete: true` 的 section 不够：DSH 的 mnemon 插件会把 USER.md / MEMORY.md
  // 的快照当成**一条 user 消息**塞进每一步（source.kind='dsh-mnemon'）。实测 3863 字，
  // 内容就是主人格设定（称呼/说话方式/技术任务要求），模型会优先照它演 ——
  // 表现就是「保存了人设但完全被无视」。顺带也是隐私问题：群友对话不该带上主人的记忆。
  applyContextFilter(ctx)

  // ── 第 0.3 层：人设/上下文诊断日志（默认关，见 applyPromptDebug 注释）──
  applyPromptDebug(ctx, () => promptDebugEnabled(config))

  // ── 第 0.5 层：语音工具（注册在 preset 作用域，不是全局）──────────
  // 注册了就常驻 schema，开关关闭时由下面的 guard 在执行期拒绝。
  // 为什么不动态注册/注销：配置变化没有可靠的低成本回调，频繁 register/unregister
  // 会触发 tools/change 风暴；执行期拒绝 + 描述里写明「技能开启时可用」已经够用。
  applyVoiceTool(ctx)

  // ── 第 1 层：从 schema 隐藏 ────────────────────────────────────
  // `restrict()` 会**整批原子失败**：名单里只要有一个当下未注册的名字就抛错，
  // 整批限制都不生效。所以逐个注册，并且把"失败"记下来——不再静默吞错。
  const denied = new Set()

  /** 对尚未成功 deny 的名字重试一遍；返回本轮新成功的数量。 */
  const restrictAll = (reason) => {
    let applied = 0
    for (const toolName of DENY_TOOLS) {
      if (denied.has(toolName)) continue
      try {
        ctx.tools.restrict({ deny: [toolName] })
        denied.add(toolName)
        applied++
      } catch (error) {
        // 两种情况都会到这里：① 该工具此刻尚未注册（preset 装载早于全局行注册）；
        // ② 本版本确实没有这个名字。①会在后续 tools/change 重扫时补上，
        // ②则会一直重试失败——但不静默，日志里看得见，名单可以据此清理。
        if (reason === 'initial') {
          console.info?.(`[qq-guard] restrict 暂未生效（等重扫）：${toolName}`)
        }
      }
    }
    return applied
  }

  restrictAll('initial')

  // 关键补丁：preset 子树装载时，全局层里 dsh-ops / agent-team / mnemon 的工具
  // 往往还没注册完，上面那一遍会漏掉 ops_bash 这类权重最高的名字。
  // 监听 tools/change 持续重扫，直到名单里的名字全部 deny 成功。
  // 重扫只在真的有新名字成功时才会再触发一次事件，不会自激循环。
  let rescanning = false
  const onToolsChange = () => {
    if (rescanning) return
    rescanning = true
    queueMicrotask(() => {
      rescanning = false
      const applied = restrictAll('rescan')
      if (applied > 0) {
        console.info?.(`[qq-guard] 重扫补藏 ${applied} 个工具；累计 ${denied.size}/${DENY_TOOLS.length}`)
      }
    })
  }
  // 直接 ctx.on(...)：与 DSH 官方插件（dsh-tool-subagent）的写法一致，
  // cordis 的 on() 本身就会把监听器登记到本 fiber 上并随卸载自动清理。
  ctx.on('tools/change', onToolsChange)

  // ── 第 2 层：执行期白名单（最终边界）──────────────────────────
  ctx.tools.guard((exec) => {
    const toolName = exec?.name
    if (typeof toolName !== 'string' || toolName.length === 0) return '工具名无效，已拒绝'

    // 技能开关必须在**执行期**现读：UI 关掉一个技能，模型可能还拿着旧 schema 里的工具名，
    // 只靠 schema 隐藏兜不住；返回字符串即拒绝。
    const flags = readFeatureFlags()
    if (toolName === VOICE_TOOL_NAME) {
      return flags.voice ? undefined : '「发语音」技能未开启，qq_send_voice 已拒绝'
    }
    if (toolName === 'web_search' || toolName === 'web_fetch') {
      return flags.search ? undefined : '「网页搜索」技能未开启，联网工具已拒绝'
    }
    // 「工具门禁」总开关：关掉 = 显式放弃执行期白名单（schema 层的 restrict 仍然生效，
    // 全局危险工具依旧被隐藏；但 agent-scope 工具将不再被这里拦住）。
    // 这是用户明确打开的高风险开关，设置页上有红字警告。
    if (!flags.guard) return undefined
    if (SAFE_EXACT.has(toolName)) return undefined
    if (SAFE_PREFIXES.some((prefix) => toolName.startsWith(prefix))) return undefined
    return `工具 "${toolName}" 不在 QQ 会话白名单内，已拒绝（QQ 聊天会话无本地执行能力）`
  })
}

/** 「发语音」工具名（guard 与测试共用）。 */
export const VOICE_TOOL_NAME = 'qq_send_voice'
/** 单条语音的文字上限：QQ 语音条约 60 秒，中文按 ~4 字/秒估。 */
export const VOICE_MAX_CHARS = 240
/**
 * 等桥接回执的上限（毫秒）。
 * 一条语音 op 的最坏耗时 ≈ TTS 20s 超时 + base64/file 两次发送，25s 是留了余量的上限。
 */
export const VOICE_RECEIPT_TIMEOUT_MS = 25000

/**
 * 注册「发语音」工具（Phase 6）。
 *
 * 工具只负责把任务入队到模块级会话指令队列；真正的合成与发送在桥接进程
 * （它才有 NapCat 的 WS 连接）。这样插件不碰网络以外的凭据，也不引入任何 npm 依赖。
 *
 * @param {object} ctx guard 实例的 ctx（preset 作用域）
 */
function applyVoiceTool(ctx) {
  const tools = ctx.get?.('tools') ?? ctx.tools
  if (!tools || typeof tools.register !== 'function') {
    console.warn?.('[qq-guard] 找不到 tools 服务：qq_send_voice 未注册')
    return
  }
  const register = () => {
    const definition = buildToolDefinition({
    name: VOICE_TOOL_NAME,
    description: '把一段中文文字合成语音，以 QQ 语音条发到当前聊天。'
      + `仅在「发语音」技能开启时可用；单次最多 ${VOICE_MAX_CHARS} 字（QQ 语音条约 60 秒），`
      + '超出请先精简。**发送失败会抛错**（桥接合成或 NapCat 拒收时），别假设一定成功。',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: '要合成语音的正文。纯文本，不要 Markdown / emoji / 颜文字。',
      },
      voice: {
        type: 'string',
        description: '可选，覆盖设置页里的音色名（Edge 如 zh-CN-XiaoyiNeural，OpenAI 如 alloy）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queued: { type: 'boolean', required: true },
          sent: { type: 'boolean', required: true, description: '桥接是否真的把语音发到了 QQ。' },
          chars: { type: 'integer', required: true },
          id: { type: 'string', required: true, description: '队列里的任务 id，排障用。' },
          detail: { type: 'string', required: true, description: '桥接回执原文（成功=发送摘要，失败=原因）。' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value?.sent === true
          ? `语音已发到 QQ（${Number(value?.chars) || 0} 字）：${String(value?.detail ?? '')}`
          : `语音没有发出去（${Number(value?.chars) || 0} 字）：${String(value?.detail ?? '')}`,
      }],
    },
    execute: async (args, exec) => {
      const flags = readFeatureFlags()
      if (!flags.voice) throw new Error('「发语音」技能未开启：请先在 QQ 桥接设置页的「技能与插件」里打开它。')
      const text = String(args?.text ?? '').trim()
      if (!text) throw new Error('text 不能为空')
      // 官方 defineTool 已经校验过类型；离线兜底只做了对象校验，这里补一道。
      if (args?.voice !== undefined && typeof args.voice !== 'string') throw new Error('voice 必须是字符串')
      const chars = [...text].length
      if (chars > VOICE_MAX_CHARS) {
        throw new Error(`文字过长（${chars} > ${VOICE_MAX_CHARS} 字），QQ 语音条放不下，请先精简。`)
      }
      // sessionId 是桥接反查 QQ 会话的唯一凭据。DSH 里 `agent.id` 与 `agent.session.id`
      // 是同一个「共享 agent/session id」（dsh-agent 的 enter() 会校验两者相等），
      // 所以优先取 agent.id、拿不到再退到 session.id。
      const sessionId = String(exec?.agent?.id ?? exec?.agent?.session?.id ?? '').trim()
      if (!sessionId) throw new Error('qq_send_voice 只能在 QQ 会话内调用（拿不到 sessionId）')
      const voice = String(args?.voice ?? '').trim()
      const id = enqueueSessionOp('voice', '', text, {
        sessionId,
        ...(voice !== '' ? { voice } : {}),
      })
      // ★ 等桥接回执再回答模型（2026-10-24 真机教训）：以前「入队即成功」，桥接那边
      //   TTS 403 / NapCat 拒收时模型仍回复「发出去了」，QQ 里其实什么都没有。
      //   一条语音 op 的最坏耗时 ≈ TTS 20s + 两次发送，这里给 25s。
      let receipt
      try {
        receipt = await waitForOpResult(id, VOICE_RECEIPT_TIMEOUT_MS)
      } catch (error) {
        throw new Error(`语音没有发出去：${error?.message ?? error}`)
      }
      if (!receipt.ok) {
        throw new Error(`语音发送失败：${receipt.detail || '桥接没有给出原因'}`)
      }
      return {
        queued: true,
        sent: true,
        chars,
        id,
        detail: receipt.detail || '桥接已发送',
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '发送 QQ 语音',
      kind: 'other',
      rawInput: { chars: [...String(args?.text ?? '')].length },
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result?.sent === true ? 'QQ 语音已发送' : 'QQ 语音未发送',
      content: [{
        type: 'text',
        text: result?.sent === true
          ? `已发送 ${Number(result?.chars) || 0} 字：${String(result?.detail ?? '')}`
          : `未发送 ${Number(result?.chars) || 0} 字：${String(result?.detail ?? '无原因')}`,
      }],
    }),
    })
    const registered = tools.register(definition)
    console.info?.(`[qq-guard] qq_send_voice 已注册（${voiceToolDefinitionSource()}）`)
    return registered
  }
  if (typeof ctx.effect === 'function') ctx.effect(register, 'qq-guard: qq_send_voice tool')
  else register()
}

/**
 * 把 Config 解析结果转成可以 JSON 序列化的普通对象。
 *
 * ⚠️ 必须做：`.volatile()` 字段解析后是 `{get()}` 包装对象（见 readRole 注释），
 * `JSON.stringify` 会把它变成 `{}`，桥接收到 `{"typingDelay":{}}` 这类空壳，
 * 热更新就静默失效了。递归解开 .get() 并剥离 Symbol 属性。
 * @param {unknown} value
 * @returns {unknown}
 */
export function plainConfig(value) {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(plainConfig)
  if (typeof value === 'object') {
    if (typeof value.get === 'function') {
      // volatile 包装：取真值后继续递归
      try { return plainConfig(value.get()) } catch { return undefined }
    }
    const out = {}
    for (const key of Object.keys(value)) {
      // 只取自有可枚举字符串键，Symbol（cosmokit.volatile.write）自动排除
      const child = plainConfig(value[key])
      if (child !== undefined) out[key] = child
    }
    return out
  }
  return value
}

/**
 * 把「网页搜索」的 DeepSeek 凭据同步给 DSH 自己的 provider（2026-10-24）。
 *
 * 为什么需要：`web_search` 用的是 `@deepseek-ai/dsh-web-search-deepseek`，它只认
 * ① 自己的 Config.apiKey ② `credentials.resolve('DEEPSEEK_API_KEY')` ③ launch env。
 * 本机 profile 的 credentials 里没有 DEEPSEEK 键，所以 QQ 会话里搜索直接报
 * WEB_PROVIDER_CREDENTIAL_MISSING。这里把设置页填的 Key 写进 DSH 的
 * `web-search-deepseek` settings namespace（字段名是 **baseURL**，大写 URL）。
 *
 * 触发时机：桥接每 2 秒轮询 `/dsh-qq-guard/config`，顺手调一次 —— 填完 Key 最多 2 秒生效，
 * 不需要重启 DSH。按「上次写过的值」去重，不会每 2 秒重复写盘。
 * Key 留空时**不动** DSH 现有配置（尊重用户在别处配好的凭据）。
 *
 * @param {object} cfg 设置页那份 Config（已 plainConfig）
 */
let webSearchSyncedSignature = ''
async function syncWebSearchCredential(cfg) {
  try {
    const web = cfg?.webSearch
    if (!web || typeof web !== 'object') return
    const apiKey = typeof web.apiKey === 'string' ? web.apiKey.trim() : ''
    if (apiKey === '') return
    const baseUrl = typeof web.baseUrl === 'string' ? web.baseUrl.trim() : ''
    const model = typeof web.model === 'string' ? web.model.trim() : ''
    const signature = `${apiKey.length}:${apiKey.slice(0, 6)}|${baseUrl}|${model}`
    if (signature === webSearchSyncedSignature) return
    const settings = webSearchSyncTarget
    if (!settings || typeof settings.update !== 'function') return
    const section = {
      apiKey,
      ...(baseUrl === '' ? {} : { baseURL: baseUrl }),
      ...(model === '' ? {} : { model }),
    }
    await settings.update('web-search-deepseek', section)
    webSearchSyncedSignature = signature
    console.info?.('[qq-guard] 已把网页搜索凭据写入 DSH 的 web-search-deepseek（web_search 现在可用）')
  } catch (error) {
    // 写失败不能影响配置轮询（桥接靠它热更新）。下次轮询会重试。
    console.warn?.(`[qq-guard] 同步网页搜索凭据失败（下次轮询重试）：${error?.message ?? error}`)
  }
}

/** 设置服务句柄：applySettings 里注入成功后挂上来（syncWebSearchCredential 用）。 */
let webSearchSyncTarget

/**
 * 桥接运行时配置（profile 顶层行）。
 * 只在有 webServer 的顶层 ctx 上跑：注册只读配置路由 + 声明自管设置页。
 */
function applySettings(ctx, config) {
  // 把 settings 实例的 Config 暴露给 guard 实例（技能开关 / 工具门禁的实时来源）。
  // 必须在 `webServer` 检查之前绑定：没有 webServer 的环境里 guard 也要能读到开关。
  bindFeatureConfigSource(config)
  // 把运行时配置暴露给桥接进程（批次 4A）。
  // 桥接是独立进程，拿不到这里的内存值；它轮询这条只读路由做热更新。
  if (ctx.webServer === undefined) return
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, reason: 'method not allowed' })
          return
        }
        // 只读、无凭据、无副作用：内容仅是聊天节奏参数，泄漏风险可忽略。
        // 仍然拒绝跨站浏览器请求，避免任意网页借用户浏览器探测本机。
        const fetchSite = req.headers['sec-fetch-site']
        if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
          sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
          return
        }
        // personaDefault 存在 guard 子行的 config 里，顶层实例拿不到；
        // 从自己的 patch 文件读出来合并进去，桥接才能拼出带默认人设的 prompt。
        const cfg = plainConfig(config) ?? {}
        // 顺带把网页搜索的 DeepSeek 凭据同步给 DSH 自己的 provider：
        // 桥接每 2 秒轮询这条路由，等于「设置页填完 Key，2 秒内生效」，不用重启 DSH。
        void syncWebSearchCredential(cfg)
        sendJson(res, 200, {
          ok: true,
          config: {
            ...cfg,
            personaDefault: readGuardPersonaDefault(),
            // Phase 6：技能/插件开关的**派生结果**。guard 与桥接共用同一份判断逻辑，
            // 避免「UI 写着已开启、桥接按 id 算出来却是关」这类漂移。
            features: readFeatureFlags(config),
          },
        })
      },
    }),
    'qq-guard: bridge runtime config route',
  )

  // ── 单人设覆盖（桥接每条消息前 POST；guard 实例注册的 section 现读）────
  //
  // 刻意把「写」也放在这条路由上：桥接是独立进程，没有浏览器 Cookie，
  // 所以不校验 cookie，只拒绝跨站（sec-fetch-site: cross-site）。
  // 内容本身没有执行能力，最坏情况只是改变 QQ 会话的人设文本。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: PERSONA_ROUTE_PATH,
      handler: async (req, res) => {
        const fetchSite = req.headers['sec-fetch-site']
        if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
          sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
          return
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          sendJson(res, 200, { ok: true, ...personaStateSnapshot() })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, reason: 'method not allowed' })
          return
        }
        let body
        try {
          body = await readJsonBody(req, { maxBytes: 64 * 1024 })
        } catch (error) {
          sendJson(res, error?.statusCode ?? 400, { ok: false, reason: error?.message ?? 'invalid json' })
          return
        }
        const text = typeof body?.text === 'string' ? body.text : ''
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
        if (body?.mode === 'default' || sessionId === '') {
          // 全局默认人设：桥接启动 / 设置页改动时推送。
          setGlobalPersonaText(text)
          sendJson(res, 200, { ok: true, scope: 'global', chars: personaStateSnapshot().globalChars })
          return
        }
        setSessionPersonaText(sessionId, text)
        sendJson(res, 200, { ok: true, scope: 'session', sessionId, chars: Math.min(text.length, PERSONA_MAX_CHARS) })
      },
    }),
    'qq-guard: persona route',
  )

  // ── 会话指令队列（清空 / 删除 / 单人设）────────────────────────
  //
  // 为什么需要队列：桥接是独立进程，`state/sessions.json` 与 DSH 会话都是它在管，
  // Host 直接改文件会被桥接的下一次落盘覆盖。所以 UI 只入队，桥接 2 秒轮询执行，
  // 执行结果再回传（不追求强一致，追求「点了真的会生效且不会双开」）。
  //
  // 租约（LEASE_MS）：GET 取走时打租约，租约期内不再投递，避免桥接重复执行
  // 「清空」这种非幂等操作；桥接崩了租约过期后重新投递。
  //
  // 队列本体在模块作用域（sessionOpsQueue）：guard 实例里的「发语音」工具
  // 也要往同一个队列塞任务，所以不能再定义在这个闭包里。
  const SESSION_OPS_LEASE_MS = 30_000
  const validSessionKey = (key) => typeof key === 'string' && /^[ug]:\d{1,20}$/.test(key)

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: SESSION_OPS_ROUTE_PATH,
      handler: async (req, res) => {
        const fetchSite = req.headers['sec-fetch-site']
        if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
          sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
          return
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          // 桥接来取指令：给租约，租约内不重复投递。
          pruneSessionOps()
          const now = Date.now()
          const ops = []
          for (const op of sessionOpsQueue.values()) {
            if (op.lease && now - op.lease < SESSION_OPS_LEASE_MS) continue
            op.lease = now
            ops.push({
              id: op.id, op: op.op, key: op.key,
              ...(op.text ? { text: op.text } : {}),
              // 语音任务没有 QQ 会话 key（由 guard 工具按 sessionId 入队），
              // 桥接用 sessionId 反查 state.sessions；voice 可覆盖音色。
              ...(op.sessionId ? { sessionId: op.sessionId } : {}),
              ...(op.voice ? { voice: op.voice } : {}),
              // 单群响应档位：null 也要下发（null = 跟随全局，是明确的语义，不是缺省）。
              ...(op.level === undefined ? {} : { level: op.level }),
            })
          }
          sendJson(res, 200, { ok: true, ops })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, reason: 'method not allowed' })
          return
        }
        let body
        try {
          body = await readJsonBody(req, { maxBytes: 128 * 1024 })
        } catch (error) {
          sendJson(res, error?.statusCode ?? 400, { ok: false, reason: error?.message ?? 'invalid json' })
          return
        }
        // 桥接回执：{ results: [{ id, ok, detail }] }
        if (Array.isArray(body?.results)) {
          let removed = 0
          let settled = 0
          for (const result of body.results.slice(0, 100)) {
            const id = typeof result?.id === 'string' ? result.id : ''
            if (id && sessionOpsQueue.delete(id)) removed++
            // 唤醒在等回执的工具调用（qq_send_voice）：成功/失败/原因都要传回去。
            if (id && settleOpResult(id, result)) settled++
          }
          sendJson(res, 200, { ok: true, removed, settled })
          return
        }
        // UI 入队：{ op, key, text?, level? }
        const op = typeof body?.op === 'string' ? body.op : ''
        if (!['clear', 'delete', 'persona', 'activity'].includes(op)) {
          sendJson(res, 400, { ok: false, reason: 'unknown-op', detail: `未知操作：${op || '(空)'}` })
          return
        }
        const key = typeof body?.key === 'string' ? body.key.trim() : ''
        if (!validSessionKey(key)) {
          sendJson(res, 400, { ok: false, reason: 'bad-key', detail: '会话 key 必须是 u:<QQ号> 或 g:<群号>' })
          return
        }
        // 单群响应档位：0..3 的整数，或 null = 跟随全局。
        let level
        if (op === 'activity') {
          const raw = body?.level
          if (raw === null || raw === undefined) level = null
          else if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 3) level = raw
          else {
            sendJson(res, 400, { ok: false, reason: 'bad-level', detail: 'level 必须是 0~3 的整数或 null' })
            return
          }
        }
        const text = typeof body?.text === 'string' ? body.text.slice(0, PERSONA_MAX_CHARS) : ''
        const id = enqueueSessionOp(
          op, key,
          op === 'persona' ? text : '',
          op === 'activity' ? { level } : {},
        )
        sendJson(res, 200, { ok: true, id, queued: sessionOpsQueue.size, note: '桥接 2 秒内轮询执行' })
      },
    }),
    'qq-guard: session ops route',
  )

  // ── 真实用量统计（「数据与用量」面板）────────────────────────────
  //
  // 数据源只有一个：Host 进程内的 `session/event`。`assistant/message.data.usage`
  // 是 DSH 里唯一带真实 token 的地方（`turn/end` 没有用量）；`session/follow` 是给
  // 远程客户端的，日志又是多帧 zstd——在这里拦最省事、最准、也最实时。
  // 细节（字段语义 / 去重 / 回填）见 usage-stats.mjs 文件头。
  const usageLogger = ctx.logger ?? console
  const usageScope = new UsageScope({
    bridgeDir: () => (plainConfig(config)?.bridge?.dir || DEFAULT_BRIDGE_DIR),
    logger: usageLogger,
  })
  const usageStore = new UsageStatsStore({
    file: () => path.join(usageScope.dir(), 'state', USAGE_FILE_NAME),
    getPricing: () => plainConfig(config)?.usagePricing ?? [],
    getPeakHours: () => plainConfig(config)?.peakHours ?? '08:30-00:30',
    getPeakOnlyWorkdays: () => plainConfig(config)?.peakOnlyWorkdays === true,
    getTimezone: () => plainConfig(config)?.timezone ?? 'Asia/Shanghai',
    scope: usageScope,
    logger: usageLogger,
  })

  // 统计失败绝不能影响对话：逐条兜住，只留日志。
  ctx.on('session/event', (session, event) => {
    try {
      usageStore.ingest(session, event)
    } catch (error) {
      usageLogger.warn?.(`[qq-guard] 用量事件处理失败（已忽略）：${error?.message ?? error}`)
    }
  })

  const runUsageBackfill = async (persistence) => {
    try {
      const result = await usageStore.backfillAll(persistence)
      if (result.error) {
        usageLogger.warn?.(`[qq-guard] 用量回填未完全成功：${result.error}`)
      } else {
        usageLogger.info?.(`[qq-guard] 用量回填完成：扫描 ${result.scanned} 个 QQ 会话，导入 ${result.imported} 个事件`)
      }
    } catch (error) {
      usageLogger.warn?.(`[qq-guard] 用量回填失败（不影响在线统计）：${error?.message ?? error}`)
    }
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: USAGE_ROUTE_PATH,
      handler: (req, res) => handleUsageRoute(req, res, { store: usageStore, scope: usageScope }),
    }),
    'qq-guard: usage stats route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: USAGE_BACKFILL_ROUTE_PATH,
      handler: (req, res) => {
        // 路由 handler 可能是同步调用，这里自己吃掉 Promise，避免 unhandled rejection。
        Promise.resolve(handleUsageBackfillRoute(req, res, {
          store: usageStore,
          scope: usageScope,
          getPersistence: () => ctx.get?.('sessionPersistence'),
        })).catch((error) => {
          if (res.writableEnded) return
          try {
            res.statusCode = 500
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ ok: false, reason: 'internal', detail: String(error?.message ?? error) }))
          } catch { /* 连接已断开 */ }
        })
      },
    }),
    'qq-guard: usage backfill route',
  )

  // 卸载/热重载前把未落盘的增量写掉。
  ctx.effect(() => () => { usageStore.flush() }, 'qq-guard: usage flush on unload')

  // 历史回填：等 sessionPersistence 就绪后延后 2.5s 跑一次，避开启动时的会话恢复 I/O。
  // 只用官方接口（list + open('read') + read），不自己解 zstd、不读盘上格式。
  ctx.inject(['sessionPersistence'], (persistenceCtx) => {
    const timer = setTimeout(() => {
      const persistence = persistenceCtx.get('sessionPersistence')
      if (persistence) void runUsageBackfill(persistence)
    }, 2500)
    persistenceCtx.effect(() => () => clearTimeout(timer), 'qq-guard: usage backfill timer')
  })

  // ── 原生目录选择器（NapCat 安装目录的「浏览」按钮）──────────────
  //
  // 前端拿不到 `<input type="file">` 选中的绝对路径（安全限制），所以手输路径
  // 是唯一的路 —— 体验极差。这里在 Host 侧调 DSH 官方的 directoryPicker seam，
  // 由它弹系统原生的「选择文件夹」窗口，把绝对路径回给前端。
  //
  // 状态码约定（前端据此决定要不要降级成手输）：
  //   200        { ok:true, path } 或 { ok:true, cancelled:true, path:null }
  //   409        已经有一个选择窗口开着（原生对话框是模态的，不能叠）
  //   501        profile 没挂 directory-picker，或挂的是 browse 后端（没有原生窗口）
  //   500        选择器自己报错
  let picking = false
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: PICK_DIR_ROUTE_PATH,
      handler: async (req, res) => {
        const fetchSite = req.headers['sec-fetch-site']
        if (typeof fetchSite === 'string' && fetchSite !== 'same-origin') {
          sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, reason: 'method not allowed' })
          return
        }
        const picker = readDirectoryPicker(ctx)
        if (picker === undefined) {
          sendJson(res, 501, {
            ok: false, reason: 'picker-not-mounted',
            detail: 'DSH 没有挂载 directoryPicker 服务（profile 里缺 directory-picker 行）',
          })
          return
        }
        let capability
        try {
          capability = picker.capability()
        } catch (error) {
          sendJson(res, 500, { ok: false, reason: 'capability-failed', detail: error?.message ?? String(error) })
          return
        }
        if (capability?.kind !== 'native' || typeof capability.pick !== 'function') {
          sendJson(res, 501, {
            ok: false, reason: 'picker-not-native',
            detail: `当前 directoryPicker 是 ${capability?.kind ?? '未知'} 后端，调不起系统对话框；请手输路径`,
          })
          return
        }
        if (picking) {
          sendJson(res, 409, { ok: false, reason: 'busy', detail: '已经有一个目录选择窗口开着，请先处理它' })
          return
        }
        picking = true
        try {
          const picked = await capability.pick()
          if (picked === null || picked === undefined) {
            sendJson(res, 200, { ok: true, cancelled: true, path: null })
            return
          }
          sendJson(res, 200, { ok: true, path: String(picked) })
        } catch (error) {
          sendJson(res, 500, { ok: false, reason: 'pick-failed', detail: error?.message ?? String(error) })
        } finally {
          picking = false
        }
      },
    }),
    'qq-guard: native directory picker route',
  )

  // ── 外部插件扫描（Phase 4 / P0）───────────────────────────────
  //
  // 只读扫描，不 import 外部代码、不写目标目录、不装包：
  //   · package.json 里带 `dsh` 字段的 DSH 原生包；
  //   · QQ Agent 的 plugin.json / skill.json（BOM 容错）。
  // `@local/*` 是本仓库的 link 开发插件（含本插件自己），不算「外部」，跳过。
  // 所有条目默认 enabled:false —— 配置里显式打开才回显为 true，但 P0 不执行。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: EXTERNAL_ROUTE_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, reason: 'method not allowed' })
          return
        }
        const fetchSite = req.headers['sec-fetch-site']
        if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
          sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
          return
        }
        const cfg = plainConfig(config) ?? {}
        const configured = Array.isArray(cfg.externalPlugins?.dirs) ? cfg.externalPlugins.dirs : []
        const dirs = configured.length > 0 ? configured : findDefaultPluginDirs()
        const enabled = new Set(Array.isArray(cfg.externalPlugins?.enabled) ? cfg.externalPlugins.enabled : [])
        const entries = []
        const seen = new Set()
        for (const dir of dirs) {
          for (const entry of scanPluginDir(dir)) {
            // 同一目录只出现一次（app 根 + plugins/ 两种入口可能扫到同一个模块）。
            const key = process.platform === 'win32' ? entry.dir.toLowerCase() : entry.dir
            if (seen.has(key)) continue
            seen.add(key)
            entries.push({ ...entry, enabled: enabled.has(entry.name) || enabled.has(entry.id) })
          }
        }
        entries.sort((a, b) => a.name.localeCompare(b.name))
        const controlled = entries.filter((e) => e.compat?.tier === 'controlled').length
        const invalid = entries.filter((e) => e.compat?.tier === 'invalid').length
        sendJson(res, 200, {
          ok: true,
          dirs,
          scanned: entries.length,
          // 「能跑的」= 有 bundle patch 或 client 入口，缺这两个的包挂上去也没东西可跑。
          runnable: entries.filter((e) => e.hasClient || e.hasBundle).length,
          // P0 只读展示：受控 / 清单无效的条目只在卡片上出现，不会被加载。
          controlled,
          invalid,
          entries,
        })
      },
    }),
    'qq-guard: external plugin scan route',
  )

  // ── 外部插件沙箱加载测试（P1）─────────────────────────────────
  //
  // 只干一件事：把扫描到的「自包含」模块交给独立子进程，执行它的 setup/register，
  // 把结果（导出了什么、碰了哪些 api）回给 UI。外部代码永远不进 DSH 主进程。
  //
  // 安全约束：
  //   · 客户端只能传 { id, dir }，Host **重新扫描**配置里的根目录来定位模块，
  //     绝不按客户端给的路径直接 import；
  //   · 只放行 compat.tier === 'self-contained' 的模块（受控模块等 P2 的 shim）；
  //   · 入口必须存在、realpath 必须仍在模块目录内（防符号链接逃逸）；
  //   · 子进程由 SandboxManager 统一加 --permission / registerHooks 拦截。
  const readExternalRoots = () => {
    const cfg = plainConfig(config) ?? {}
    const configured = Array.isArray(cfg.externalPlugins?.dirs) ? cfg.externalPlugins.dirs : []
    return configured.length > 0 ? configured : findDefaultPluginDirs()
  }

  /** 按 id/dir 在配置的根目录里找模块（重新扫描，不信任客户端路径）。 */
  const findExternalModule = (query) => {
    const wantedDir = typeof query.dir === 'string' && query.dir
      ? path.resolve(query.dir)
      : ''
    const wantedId = typeof query.id === 'string' ? query.id : ''
    const seen = new Set()
    for (const root of readExternalRoots()) {
      for (const entry of scanPluginDir(root)) {
        const key = process.platform === 'win32' ? entry.dir.toLowerCase() : entry.dir
        if (seen.has(key)) continue
        seen.add(key)
        if (wantedDir) {
          const entryDir = process.platform === 'win32' ? entry.dir.toLowerCase() : entry.dir
          if (entryDir === (process.platform === 'win32' ? wantedDir.toLowerCase() : wantedDir)) return entry
          continue
        }
        if (wantedId && (entry.id === wantedId || entry.name === wantedId)) return entry
      }
    }
    return null
  }

  /** 沙箱错误码 → HTTP 状态码。 */
  const sandboxStatus = (code) => {
    if (code === 'E_TIMEOUT') return 504
    if (code === 'E_BUSY' || code === 'E_CIRCUIT_OPEN') return 429
    if (code === 'E_ENTRY_MISSING' || code === 'E_ENTRY_ESCAPE' || code === 'E_NOT_SELF_CONTAINED') return 400
    if (code === 'E_NO_NODE' || code === 'E_SANDBOX_START') return 503
    return 502
  }

  const sandbox = ctx.subprocess !== undefined
    ? new SandboxManager({
      subprocess: ctx.subprocess,
      logger: ctx.logger ?? console,
      getRoots: readExternalRoots,
    })
    : null
  if (sandbox !== null) {
    ctx.effect(() => () => { void sandbox.dispose() }, 'qq-guard: sandbox teardown')
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: EXTERNAL_TEST_ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const fetchSite = req.headers['sec-fetch-site']
          if (typeof fetchSite === 'string' && fetchSite !== 'same-origin') {
            sendJson(res, 403, { ok: false, error: { code: 'E_CROSS_SITE', message: 'cross-site request refused' } })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'E_METHOD', message: 'method not allowed' } })
            return
          }
          if (sandbox === null) {
            sendJson(res, 501, {
              ok: false,
              error: { code: 'E_NO_SUBPROCESS', message: 'DSH 没有挂载 subprocess 服务，沙箱不可用' },
            })
            return
          }

          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            sendJson(res, error?.statusCode ?? 400, {
              ok: false,
              error: { code: 'E_BODY', message: error?.message ?? String(error) },
            })
            return
          }

          const id = typeof body?.id === 'string' ? body.id.trim() : ''
          const dir = typeof body?.dir === 'string' ? body.dir.trim() : ''
          if (!id && !dir) {
            sendJson(res, 400, {
              ok: false,
              error: { code: 'E_BAD_REQUEST', message: '需要 id 或 dir 来定位外部插件' },
            })
            return
          }

          const module = findExternalModule({ id, dir })
          if (module === null) {
            sendJson(res, 404, {
              ok: false,
              error: { code: 'E_NOT_FOUND', message: '没有在已配置的外部插件目录里找到这个模块' },
            })
            return
          }
          if (!module.hasEntry) {
            sendJson(res, 400, {
              ok: false,
              error: { code: 'E_ENTRY_MISSING', message: `入口文件不存在：${module.entry || 'index.js'}` },
            })
            return
          }
          if (module.compat?.tier !== 'self-contained') {
            sendJson(res, 400, {
              ok: false,
              error: {
                code: 'E_NOT_SELF_CONTAINED',
                message: `该模块是「${module.compat?.label ?? '未判定'}」，P1 只允许加载自包含模块`,
                detail: Array.isArray(module.compat?.reasons) ? module.compat.reasons.join('；') : undefined,
              },
            })
            return
          }

          let entryPath = path.resolve(module.dir, module.entry || 'index.js')
          if (!existsSync(entryPath)) {
            sendJson(res, 400, {
              ok: false,
              error: { code: 'E_ENTRY_MISSING', message: `入口文件不存在：${entryPath}` },
            })
            return
          }
          // realpath 二次确认：清单里的 entry 不能借符号链接跳出模块目录。
          try {
            const realDir = realpathSync(module.dir)
            const realEntry = realpathSync(entryPath)
            if (realEntry !== realDir && !realEntry.startsWith(realDir + path.sep)) {
              sendJson(res, 400, {
                ok: false,
                error: { code: 'E_ENTRY_ESCAPE', message: '入口文件经 realpath 后越出模块目录' },
              })
              return
            }
            entryPath = realEntry
          } catch (error) {
            sendJson(res, 400, {
              ok: false,
              error: { code: 'E_ENTRY_MISSING', message: `解析入口失败：${error?.message ?? error}` },
            })
            return
          }

          const outcome = await sandbox.testLoad({
            id: module.id,
            dir: module.dir,
            entryPath,
            format: module.format,
          })
          if (outcome.ok) {
            sendJson(res, 200, outcome)
          } else {
            sendJson(res, sandboxStatus(outcome.error?.code), outcome)
          }
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: { code: 'E_HOST', message: error?.message ?? String(error) },
          })
        }
      },
    }),
    'qq-guard: external plugin sandbox test route',
  )

  // ── 清理失效会话（Phase 4）───────────────────────────────────
  //
  // DSH 左侧会话堆积的根因：桥接按 QQ 会话建 DSH 会话，映射失效后会重建一条，
  // 旧的那条如果还活着就永远留在列表里。
  // 这里做的是「对账」：把**QQ 工作区里、当前映射表里没有的** DSH 会话归档掉。
  //
  // 只用 Host 自己的服务（sessionController.list + workspaceRegistry.archiveSession），
  // 不依赖桥接进程在跑，所以桥接挂了也能清理。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: CLEANUP_ROUTE_PATH,
      handler: async (req, res) => {
        const fetchSite = req.headers['sec-fetch-site']
        if (typeof fetchSite === 'string' && fetchSite !== 'same-origin') {
          sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, reason: 'method not allowed' })
          return
        }
        const sessionController = ctx.get?.('sessionController')
        const workspaceRegistry = ctx.get?.('workspaceRegistry')
        if (typeof sessionController?.list !== 'function' || typeof workspaceRegistry?.archiveSession !== 'function') {
          sendJson(res, 501, {
            ok: false, reason: 'not-available',
            detail: '当前 DSH 没有暴露 sessionController / workspaceRegistry，无法清理',
          })
          return
        }
        const cfg = plainConfig(config) ?? {}
        const bridgeDir = cfg.bridge?.dir || DEFAULT_BRIDGE_DIR
        const statePath = path.join(bridgeDir, 'state', 'sessions.json')
        const bridgeConfigPath = path.join(bridgeDir, 'config.json')
        let mapped = []
        try {
          const state = JSON.parse(readFileSync(statePath, 'utf8'))
          // 新版桥接的 values 是对象（{ sessionId, unread, ... }），旧版是裸字符串。
          // 两种都认，否则升级后「清理失效会话」会把所有在用的会话当孤儿归档。
          mapped = Object.values(state?.sessions ?? {})
            .map((value) => (typeof value === 'string' ? value : value?.sessionId))
            .filter((id) => typeof id === 'string' && id)
        } catch { /* 没有状态文件 = 还没建过会话，映射为空 */ }
        let sessionCwd = ''
        try {
          sessionCwd = JSON.parse(readFileSync(bridgeConfigPath, 'utf8'))?.dsh?.sessionCwd ?? ''
        } catch { /* 读不到就只能清 stale 列表 */ }
        if (!sessionCwd) {
          sendJson(res, 400, { ok: false, reason: 'no-session-cwd', detail: '桥接 config.json 里没有 dsh.sessionCwd' })
          return
        }
        const norm = (p) => (typeof p === 'string' && p ? path.resolve(p).toLowerCase() : '')
        const target = norm(sessionCwd)
        const mappedSet = new Set(mapped)
        let value
        try {
          value = await sessionController.list({}, new AbortController().signal)
        } catch (error) {
          sendJson(res, 500, { ok: false, reason: 'list-failed', detail: error?.message ?? String(error) })
          return
        }
        const items = Array.isArray(value?.items) ? value.items : []
        // 只在「QQ 工作区」范围内对账，绝不碰用户在别的目录里的会话。
        const orphans = items.filter((it) => norm(it?.cwd) === target
          && it?.origin !== 'subagent'
          && !mappedSet.has(String(it?.sessionId)))
        let archived = 0
        const failed = []
        for (const it of orphans) {
          try {
            await workspaceRegistry.archiveSession(it.sessionId)
            archived++
          } catch (error) {
            failed.push({ sessionId: String(it.sessionId), reason: error?.message ?? String(error) })
          }
        }
        sendJson(res, 200, {
          ok: true,
          sessionCwd,
          mapped: mapped.length,
          candidates: orphans.length,
          archived,
          failed,
        })
      },
    }),
    'qq-guard: session cleanup route',
  )

  // ── NapCat 进程管理（批次 4B）─────────────────────────────────
  //
  // 为什么必须在 Host 插件里管进程：
  //   DSH 退出时 NapCat 不能变成孤儿进程 —— 只有 Host 能拿到
  //   `ctx.effect(() => () => stop())` 这条清理钩子。
  //
  // 用 ctx.subprocess 而不是 node:child_process：
  //   Windows 上它在 Job Object 里托管整棵进程树（terminate 能收子孙），
  //   且**硬编码 windowsHide: true**，不需要调用方传参。
  // 没装 subprocess 时优雅降级：不提供启停，只保留状态查询。
  const cfgView = () => {
    const c = plainConfig(config) ?? {}
    return {
      napcatDir: c.napcat?.dir || undefined,
      quickLoginQQ: c.napcat?.quickLoginQQ || '',
      wsPort: (() => {
        // 从 onebot.wsUrl 里解析端口，与桥接实际连接保持一致
        try { return Number(new URL(c.onebot?.wsUrl ?? '').port) || DEFAULT_WS_PORT } catch { return DEFAULT_WS_PORT }
      })(),
      onebotHttpUrl: c.onebot?.httpUrl || '',
      accessToken: c.onebot?.accessToken || '',
    }
  }

  if (ctx.subprocess !== undefined) {
    const manager = new NapcatManager({
      subprocess: ctx.subprocess,
      logger: ctx.logger ?? console,
      getConfig: cfgView,
    })

    // 退出清理：DSH 退出（或插件卸载）时停掉 NapCat，绝不留孤儿进程。
    ctx.effect(() => () => manager.stop(), 'qq-guard: napcat teardown')

    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: NAPCAT_ROUTE_PATH,
        handler: (req, res) => {
          // 同一 origin 才允许（浏览器点按钮）；
          // 桥接进程没有 origin/sec-fetch-site，走 `none` 分支放行以便查询。
          const fetchSite = req.headers['sec-fetch-site']
          if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
            sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://x')
          const action = url.searchParams.get('action') ?? 'status'

          if (req.method === 'GET' || req.method === 'HEAD') {
            manager.snapshot()
              .then((snap) => sendJson(res, 200, { ok: true, ...snap }))
              .catch((error) => sendJson(res, 500, { ok: false, reason: error?.message ?? String(error) }))
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, reason: 'method not allowed' })
            return
          }
          // 启停是**有副作用**的操作：要求同源（浏览器发起的 POST 一定带 sec-fetch-site）。
          if (fetchSite !== 'same-origin' && fetchSite !== undefined) {
            sendJson(res, 403, { ok: false, reason: 'state-changing request must be same-origin' })
            return
          }
          const run = action === 'start'
            ? manager.start()
            : action === 'stop'
              ? manager.stop()
              : Promise.resolve({ ok: false, action: 'unknown', detail: `未知 action：${action}` })
          run
            .then((r) => sendJson(res, r.ok ? 200 : 500, r))
            .catch((error) => sendJson(res, 500, { ok: false, reason: error?.message ?? String(error) }))
        },
      }),
      'qq-guard: napcat control route',
    )
  } else {
    ctx.logger?.warn?.('[qq-guard] 未注入 subprocess，NapCat 启停功能不可用（仍可查看状态）')
  }

  // ── NapCat 登录二维码（qrcode.png → 浏览器）────────────────────
  //
  // 为什么需要：NapCat 掉登录时会把二维码打到终端，同时落一张
  // `<napcatDir>/versions/<ver>/resources/app/napcat/cache/qrcode.png`（147×147）。
  // ASCII 二维码在日志框里只要字体/行高差一点就扫不出来（2026-10-23 实测），
  // 所以前端优先展示这张原图。
  //
  // 安全边界：只按**固定候选路径**找图（不接客户端传路径）、realpath 必须仍在
  // NapCat 目录内、限 4MB、同源 GET、no-sniff。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: NAPCAT_QR_ROUTE_PATH,
      handler: (req, res) => {
        const fetchSite = req.headers['sec-fetch-site']
        if (typeof fetchSite === 'string' && fetchSite !== 'same-origin') {
          sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, reason: 'method not allowed' })
          return
        }
        const cfg = plainConfig(config) ?? {}
        const napcatDir = cfg.napcat?.dir || ''
        const image = findQrcodeImage(napcatDir)
        if (image === null) {
          sendJson(res, 404, { ok: false, reason: 'qr-not-found' })
          return
        }
        if (image.size > NAPCAT_QR_MAX_BYTES) {
          sendJson(res, 413, { ok: false, reason: 'qr-too-large', size: image.size })
          return
        }
        try {
          // realpath 二次确认：候选路径是固定的，但仍防 NapCat 目录里放符号链接逃逸。
          const realDir = realpathSync(path.resolve(napcatDir))
          const realFile = realpathSync(image.file)
          if (realFile !== realDir && !realFile.startsWith(realDir + path.sep)) {
            sendJson(res, 403, { ok: false, reason: 'qr-path-escape' })
            return
          }
          const buffer = readFileSync(realFile)
          res.writeHead(200, {
            'content-type': 'image/png',
            'content-length': String(buffer.length),
            // 二维码每次刷新都会重写同名文件：绝不能缓存，否则用户扫到上一张。
            'cache-control': 'no-store, max-age=0',
            'x-content-type-options': 'nosniff',
          })
          res.end(req.method === 'HEAD' ? undefined : buffer)
        } catch (error) {
          sendJson(res, 500, { ok: false, reason: 'qr-read-failed', detail: error?.message ?? String(error) })
        }
      },
    }),
    'qq-guard: napcat qr route',
  )

  // ── 桥接进程管理（批次 4B 补充）───────────────────────────────
  //
  // 桥接原本没有常驻机制：只能手动开终端 `node start.mjs`，窗口一关进程就没了，
  // UI 于是显示「未知（桥接未上报）」。这里和 NapCat 一样由插件托管，
  // 并加**有限次自动重启**防崩溃循环。
  const runner = new BridgeRunner({
    subprocess: ctx.subprocess,
    logger: ctx.logger ?? console,
    getConfig: () => {
      const c = plainConfig(config) ?? {}
      return { bridgeDir: c.bridge?.dir || undefined }
    },
  })
  ctx.effect(() => () => runner.stop(), 'qq-guard: bridge teardown')

  // 可选：DSH 启动时自动拉起桥接，让状态灯常亮（批次 4B / 批次 5 审计修复）。
  //
  // 为什么延后 1.5s：插件装载时 DSH 自身的 webServer / 端口探测刚就绪，
  // 桥接启动第一件事是探 DSH 端口；立刻起会和 DSH 启动流程抢时序。
  //
  // ⚠️ 定时器必须挂在本 fiber 上（ctx.effect）：
  // 插件被卸载 / DSH 快速退出时若不清掉，1.5s 后仍会 spawn 出一个
  // **没人托管的孤儿桥接**（teardown 已经跑过，不会再有 stop 来收它）。
  //
  // `manual: false`：autoStart 不重置崩溃重启计数，避免「一启动就崩」被
  // 静默无限重启（计数只在进程稳定存活后清零，见 bridge-runner.mjs）。
  const bridgeCfg = plainConfig(config) ?? {}
  if (bridgeCfg.bridge?.autoStart === true) {
    if (globalThis[AUTO_START_MARK] === true) {
      // 配置保存/插件重载：本进程已经执行过 autoStart，不能把用户正在用的
      // 桥接停掉再拉一次（见 AUTO_START_MARK 注释）。
      ctx.logger?.info?.('[qq-guard] bridge.autoStart 已在本 DSH 进程中执行过，本次重载不再重复拉起')
    } else {
      globalThis[AUTO_START_MARK] = true
      ctx.logger?.info?.('[qq-guard] bridge.autoStart=true：1.5s 后自动拉起桥接')
      const timer = setTimeout(() => {
        runner.start({ manual: false })
          .then((result) => {
            if (result?.ok) {
              ctx.logger?.info?.(`[qq-guard] 桥接自动拉起成功（${result.action}）`)
            } else {
              ctx.logger?.warn?.(`[qq-guard] 桥接自动拉起失败（${result.action}）：${result.detail ?? ''}`)
            }
          })
          .catch((error) => {
            ctx.logger?.error?.(`[qq-guard] 桥接自动拉起异常：${error?.message ?? error}`)
          })
      }, 1500)
      ctx.effect(() => () => clearTimeout(timer), 'qq-guard: bridge autostart timer')
    }
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: BRIDGE_ROUTE_PATH,
      handler: (req, res) => {
        const fetchSite = req.headers['sec-fetch-site']
        if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
          sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://x')
        const action = url.searchParams.get('action') ?? 'status'

        if (req.method === 'GET' || req.method === 'HEAD') {
          sendJson(res, 200, { ok: true, ...runner.snapshot() })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, reason: 'method not allowed' })
          return
        }
        if (fetchSite !== 'same-origin' && fetchSite !== undefined) {
          sendJson(res, 403, { ok: false, reason: 'state-changing request must be same-origin' })
          return
        }
        const run = action === 'start'
          ? runner.start({ manual: true })
          : action === 'stop'
            ? runner.stop()
            : action === 'exit'
              ? runner.exit()
              : Promise.resolve({ ok: false, action: 'unknown', detail: `未知 action：${action}` })
        run
          .then((r) => sendJson(res, r.ok ? 200 : 500, r))
          .catch((error) => sendJson(res, 500, { ok: false, reason: error?.message ?? String(error) }))
      },
    }),
    'qq-guard: bridge control route',
  )

  // ── 状态上报（批次 4A-UI）─────────────────────────────────────
  //
  // 桥接是独立进程，前端（浏览器）读不到它的内存。链路是**反转的**：
  //   桥接 --POST /dsh-qq-guard/status--> 本插件（存在内存里）
  //   前端 --GET  /dsh-qq-guard/status--> 本插件
  // 这样 `main` 面板的「运行状态」才有真实数据（NapCat 在线 / 收发条数）。
  // 桥接 5 秒没上报就视为「未知」，避免显示过期数据。
  const STATUS_ROUTE_PATH = '/dsh-qq-guard/status'
  const STATUS_TTL_MS = 15_000
  let lastStatus = null
  let lastStatusAt = 0

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: STATUS_ROUTE_PATH,
      handler: (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const fresh = lastStatus !== null && (Date.now() - lastStatusAt) <= STATUS_TTL_MS
          sendJson(res, 200, {
            ok: true,
            reported: fresh,
            ageMs: lastStatus === null ? null : Date.now() - lastStatusAt,
            status: fresh ? lastStatus : null,
          })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, reason: 'method not allowed' })
          return
        }
        // 只接受本机桥接进程上报：它没有浏览器 Cookie，所以不做 origin 校验，
        // 改为限制请求体大小 + 只收白名单字段（不允许任意写）。
        //
        // 64KB：除了 5 个进程级计数，现在还带一份会话列表（未读/昵称/最近消息），
        // 100 个会话约 15~25KB，留一倍余量。超过即拒绝，绝不无限收。
        const chunks = []
        let size = 0
        let aborted = false
        req.on('data', (c) => {
          size += c.length
          if (size > 65536) { aborted = true; try { req.destroy() } catch { /* 已断开就忽略 */ } return }
          chunks.push(c)
        })
        req.on('end', () => {
          if (aborted) { sendJson(res, 413, { ok: false, reason: 'body too large' }); return }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            // qqState 只接受四个已知取值；非法/缺省时不入库（旧版桥接只上报
            // qqConnected，前端会回落到旧字段，不会显示错状态）。
            const rawState = typeof body?.qqState === 'string' ? body.qqState : ''
            const qqState = QQ_STATES.has(rawState) ? rawState : undefined
            lastStatus = {
              // 兼容字段：语义已改成「确认在线」（桥接侧只有 online 才给 true）。
              qqConnected: body?.qqConnected === true,
              ...(qqState === undefined ? {} : { qqState }),
              dshOk: body?.dshOk === true,
              counts: {
                received: Number(body?.counts?.received) || 0,
                replied: Number(body?.counts?.replied) || 0,
                blocked: Number(body?.counts?.blocked) || 0,
                failed: Number(body?.counts?.failed) || 0,
                denied: Number(body?.counts?.denied) || 0,
              },
              // 会话列表：白名单字段 + 类型收敛。缺省时**不写**这个键（旧版桥接），
              // 前端据此区分「没有数据」和「确实一个会话都没有」。
              ...(Array.isArray(body?.sessions)
                ? { sessions: body.sessions.slice(0, 100).map(sanitizeSessionRow).filter(Boolean) }
                : {}),
            }
            lastStatusAt = Date.now()
            sendJson(res, 200, { ok: true })
          } catch (error) {
            sendJson(res, 400, { ok: false, reason: error?.message ?? 'invalid json' })
          }
        })
      },
    }),
    'qq-guard: bridge status route',
  )

  // 自带设置页：告诉 Settings 别用 schema 自动生成（官方明确没有客户端实现 autoGenerate）。
  // 这几行必须放在 ctx.inject(['settings'], ...) 子级里，否则 profile 没装 Settings 时插件会挂。
  ctx.inject(['settings'], (settingsCtx) => {
    // 网页搜索凭据同步要写别的 namespace，句柄挂到模块级（见 syncWebSearchCredential）。
    webSearchSyncTarget = settingsCtx.settings
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, settingsCtx.fiber),
      'qq-guard: settings page policy',
    )
  })
}

/** 供对账脚本使用：确认名单与 DSH 真实工具名不漂移。 */
export const DENIED_TOOL_NAMES = Object.freeze([...DENY_TOOLS])
export const SAFE_TOOL_NAMES = Object.freeze([...SAFE_EXACT])
/** 会话行白名单收敛（导出仅为测试：漏字段是静默 bug，必须有断言盯着）。 */
export { sanitizeSessionRow }
export { Config }
