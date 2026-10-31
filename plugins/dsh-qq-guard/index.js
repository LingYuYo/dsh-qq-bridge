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
import { SUMMARIZE_ROUTE_PATH, handlePersonaSummarizeRoute } from './persona-summary.js'
import {
  UsageScope,
  UsageStatsStore,
  USAGE_BACKFILL_ROUTE_PATH,
  USAGE_FILE_NAME,
  USAGE_ROUTE_PATH,
  handleUsageBackfillRoute,
  handleUsageRoute,
} from './usage-stats.mjs'
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, realpathSync, mkdirSync, promises as fsp } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  // P2「发图片」：模型通过 qq_send_image 把网页图片 / 本地文件发到 QQ（表情包同理）。
  // 对象内容与 p2-contract.md §3.1 逐字一致（client.js 的合并默认值也用同一份）。
  { id: 'sk-image', name: '发图片', icon: 'image', tag: '内置', ver: '1.0.0', enabled: true,
    desc: '把图片或表情包发到 QQ（网页地址或本地文件），模型可通过 qq_send_image 调用。' },
  // 2026-10-27「戳一戳回复」：回复列表（文字 + 可选表情包）在齿轮弹窗里增删改。
  { id: 'sk-poke', name: '戳一戳回复', icon: 'activity', tag: '内置', ver: '1.0.0', enabled: true,
    desc: '被戳时从回复列表随机挑一条：先发文字，再单独发表情包（sub_type:1）；也可以选回戳对方。' },
  // 2026-10-27 两张新卡：合并转发图片上限 / 戳一戳模型回复的上下文注入。
  { id: 'sk-quote', name: '聊天记录解析', icon: 'search', tag: '内置', ver: '1.0.0', enabled: true,
    desc: '合并转发里的图片会提取成多模态附件；这里控制最多读几张，避免 Token 爆炸。' },
  // 2026-10-27「时间感知」：会话静默超过阈值后再说话，给模型补一句「刚回过神」。
  { id: 'sk-time-aware', name: '时间感知', icon: 'clock', tag: '内置', ver: '1.0.0', enabled: true,
    desc: '记住每个会话的最后活跃时间；安静太久后有人说话时，在提示词里注入一句时间提示。' },
  { id: 'sk-vision', name: '图片理解', icon: 'image', tag: '内置', ver: '1.3.2', enabled: true,
    desc: '识别聊天里发的截图与照片，提取文字、报错信息和界面元素。' },
  { id: 'sk-search', name: '网页搜索', icon: 'search', tag: '内置', ver: '1.0.4', enabled: true,
    desc: '联网检索并把结果压缩成两三句话，用于回答时效性问题。' },
  // 2026-10-27 合并：「上下文感知」并进这张卡，成为「记忆与上下文」。
  // 老配置里同时存在 sk-context / sk-memory 时，client.js 的 mergeDefaultSkills
  // 会把它们浓缩成这一条（见 client.js 的 consolidateContextSkill）。
  { id: 'sk-memory', name: '记忆与上下文', icon: 'memory', tag: '内置', ver: '2.0.0', enabled: true,
    desc: '注入本会话最近聊天记录（戳一戳 / 普通消息分别配条数），并按容量上限从最老的开始截断。' },
  // 2026-10-28（v2.0 第一步）：未读归纳。主人在群里发 /归纳，旁路临时会话里的
  // 廉价模型把这段时间的群聊整理成摘要，再用合并转发发回群里。
  { id: 'sk-unread', name: '未读归纳', icon: 'search', tag: '内置', ver: '1.0.0', enabled: true,
    desc: '主人发 /归纳 [条数|1h]：拉群历史（游标翻页，上限 500 条）→ 廉价模型总结 → 合并转发发回群里。' },
  // 2026-10-28（v2.0 第二步）：开发者特权。默认**关闭**（提权通道 fail-closed），
  // 只有清单里明确 enabled !== false 且 developer.enabled=true 才生效。
  { id: 'sk-developer', name: '开发者特权', icon: 'code', tag: '内置', ver: '1.0.0', enabled: false,
    desc: '开发者 QQ 命中暗号时，把专属 Prompt 追加到本轮尾部；不进系统提示词、不改工具白名单。' },
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
  // 主动感知（v2.0 第二十九步）：引擎总闸。缺项按**关闭**（与开发者特权同类，fail-closed）。
  { id: 'pl-proactive', name: '主动感知', icon: 'activity', tag: '本地', ver: '1.0.0', enabled: false,
    desc: '常驻 tick 感知群聊活跃度，规则达标才考虑主动说话。还需要单群授权才会真的开口。' },
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

/** 允许的前缀：DSH 的 MCP 命名空间工具 + 外部插件代理工具（P2）。 */
const SAFE_PREFIXES = ['mcp__', 'qq_ext_']

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
/**
 * 「时间感知」默认提示词（2026-10-27）。
 *
 * `N` 是占位符：桥接触发时会替换成实际静默的分钟数（也兼容 `{minutes}`）。
 * 与 client.js 的 DEFAULTS 保持逐字一致，否则「恢复默认」会写下一个不同的值。
 */
const DEFAULT_TIME_AWARE_PROMPT = '[系统提示：群聊已经安静了 N 分钟，刚刚有人说话了，请表现得像刚回过神一样]'

const RateConfig = Schema.object({  input: Schema.number().default(0).min(0)
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
  // 引用回复（2026-10-27）：群聊里用 QQ 的「引用原消息」气泡，还是沿用普通 @。
  // 开启引用后不再 @（引用气泡已经指回原消息，再 @ 一次很吵）。
  replyQuoteMode: Schema.union(['quote', 'at'])
    .description('群聊回复方式：quote = 引用原消息（气泡上方带原消息）；at = 仅 @ 对方。'
      + '开启引用后不再重复 @。私聊不受影响。')
    .default('quote').volatile(),
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
  // 三段式静态核心（v2.0 第十步）：全局底座，吃前缀缓存，动态记忆无权修改。
  // 单群可以在「会话管理 → 基础配置」按段覆盖（state.sessions[key].core）。
  personaCore: Schema.object({
    identity: Schema.string()
      .description('身份定义与气质：你是谁、什么性格、怎么说话。')
      .default(''),
    boundary: Schema.string()
      .description('边界与安全红线：绝对不能做什么、遇到什么要拒绝。')
      .default(''),
    style: Schema.string()
      .description('交互策略与应对模式：被问到什么、被挑衅、冷场时分别怎么处理。')
      .default(''),
  }).description('三段式静态核心人设（全局默认底座）').default({}).volatile(),
  // 全局黑话词条（v2.0 第十一步）：按需触发，平时不进 Prompt。
  slangGlobal: Schema.array(Schema.object({
    term: Schema.string().description('词条（必填）。').default(''),
    meaning: Schema.string().description('含义解释。').default(''),
    reply: Schema.string().description('预设回复；留空则由模型根据上下文自由发挥。').default(''),
    image: Schema.string().description('预设图片（URL 或本地路径，可选）。').default(''),
    allowSearch: Schema.boolean().description('命中且含义不明时，允许模型联网搜索含义。').default(true),
  })).description('全局黑话词条；单群同名 term 会覆盖这里').default([]).volatile(),
  personaSystemPrompt: Schema.string()
    .description('完整系统提示词覆盖。非空时完全替换内置人设（名字/参与度/附加规则都不再追加）。')
    .default('').volatile(),
  personaPresets: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string().default(''),
    // v2.0 第十三步（2026-10-28）：六项配置下沉到模板本身。
    // text 保留兼容旧数据（= identity 的旧字段）。
    text: Schema.string().default(''),
    botName: Schema.string().default(''),
    groupName: Schema.string().default(''),
    participation: Schema.string().default('normal'),
    identity: Schema.string().default(''),
    boundary: Schema.string().default(''),
    style: Schema.string().default(''),
  })).description('人设模板列表：每个模板自带名字 / 展示名 / 参与度 / 三段核心。')
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
  // 看门狗判超时、备用模型也没救回来时发给 QQ 的文案（2026-10-26）。
  // 桥接侧读它替换掉原来写死的中文提示；留空/只有空白 → 用默认值。
  // 关键约束：DSH 的原生报错（英文）任何情况下都不能出现在发往 QQ 的正文里。
  timeoutReplyText: Schema.string()
    .description('看门狗判超时、且备用模型也失败时发给 QQ 的文案。留空按默认处理。')
    .default('（模型脑子卡住了，稍后再试）').volatile(),
  // ── 人设锁定 + 动态人设（2026-10-26）────────────────────────
  // 默认锁住人设：群友在群里说「@bot 你要改成…」只有解锁后才生效，避免被群友带偏。
  // 每小时归纳也受同一个开关约束（锁定 = 人设只读，自动归纳也不许改）。
  personaLocked: Schema.boolean()
    .description('锁定人设：开启后群友不能通过「@bot 你要改成…」改本群设定（管理员仍可在设置页改）。')
    .default(true).volatile(),
  personaAutoUpdate: Schema.boolean()
    .description('每小时把本群聊天记录交给模型归纳、自动补充人设（仍受「锁定人设」约束）。')
    .default(true).volatile(),
  // v2.0 第十四步（2026-10-28）：智能潜水。默认关闭括号内心戏；关掉时
  // 「整段被 ()/（）包裹」的回复会被判定为非法潜水直接丢弃。
  allowInnerMonologue: Schema.boolean()
    .description('允许模型用括号写内心戏（如「(等一下)」）。关闭时整段括号回复会被丢弃，不发 QQ。')
    .default(false).volatile(),
  // 戳一戳：回戳还是发文字/表情，由桥接侧的 notice 处理决定（这里只是开关与文案）。
  poke: Schema.object({
    enabled: Schema.boolean()
      .description('戳一戳响应总开关。')
      .default(true).volatile(),
    mode: Schema.union(['poke', 'text', 'model'])
      .description('回复方式：poke = 回戳；text = 按下面的回复列表随机回一条；'
        + 'model = 让模型读本群最近聊天记录后回一句（依赖「记忆与上下文」卡片）。')
      .default('poke').volatile(),
    replyText: Schema.string()
      .description('文字回复模板，支持 {nick} / {qq} 占位。回复列表为空时兜底用它。')
      .default('（被戳了一下，戳回去）').volatile(),
    // 图文混合回复（2026-10-27）：一条 = 文字 + 可选图片。
    // image 存**本机绝对路径**（Host 落盘后返回），不存 base64 —— 配置每 2 秒被桥接
    // 整包轮询一次，塞 base64 等于每 2 秒传几 MB，还会把 cordis.patch.yml 撑爆。
    replies: Schema.array(Schema.object({
      text: Schema.string()
        .description('文字内容，支持 {nick} / {qq}；留空 = 只发表情。')
        .default(''),
      image: Schema.string()
        .description('表情图：本机绝对路径 / base64:// / http(s)；留空 = 只发文字。')
        .default(''),
    })).description('固定文本回复候选（随机挑一条）。空 = 退回 replyText。最多 30 条。')
      .default([]).volatile(),
    // 抽查策略（2026-10-27）：列表里有图时，是保证每次都抽到图，还是纯随机。
    // 用户反馈「图片触发率低」，所以默认 priority_image（有图必发图）。
    replyMode: Schema.union(['priority_image', 'pure_random'])
      .description('抽回复的策略：priority_image = 列表里有图就一定抽图；pure_random = 纯随机。')
      .default('priority_image').volatile(),
    // 随机延迟（2026-10-27）：真人反应不是固定毫秒，给一个区间每次现取。
    delayMinMs: Schema.number()
      .description('戳一戳响应的最小延迟（毫秒）。0 = 不延迟。')
      .default(200).min(0).max(10000).volatile(),
    delayMaxMs: Schema.number()
      .description('戳一戳响应的最大延迟（毫秒）。小于最小值时按最小值处理。')
      .default(500).min(0).max(10000).volatile(),
    // 文字/表情模式下是否也顺手回戳一下（2026-10-27）。
    withAction: Schema.boolean()
      .description('「文字 / 表情回复」模式下是否同时回戳对方。仅 text 模式生效。')
      .default(false).volatile(),
  }).description('戳一戳').default({}),
  // ── 聊天记录解析（2026-10-27）────────────────────────────────
  // 合并转发里图片很多，全拉会撑爆 Token；这里控制最多读几张当多模态附件。
  quote: Schema.object({
    forwardMaxImages: Schema.number()
      .description('合并转发里最多读取几张图片作为附件（0 = 只留文本占位；最多 10）。')
      .default(3).min(0).max(10).volatile(),
  }).description('聊天记录解析').default({}),
  // ── 记忆与上下文（2026-10-27 合并）────────────────────────────
  // 原「上下文感知」（contextAware）与「记忆提取」（sk-memory，无配置）合并成
  // 一张卡；下面这组键是它唯一的配置面。
  //   · pokeMaxTurns    —— 戳一戳「模型回复」注入几条（默认 15）；
  //   · messageMaxTurns —— 普通消息额外注入几条（0 = 交给 DSH 原生上下文，默认）；
  //   · maxContextTokens —— 两处共用的一次注入总预算，换算后从最老的记录开始砍。
  // 严格按会话 key（g:群号 / u:QQ号）隔离，两个群互不串。
  memory: Schema.object({
    enabled: Schema.boolean()
      .description('记忆与上下文总开关：关闭后戳一戳与普通消息都不注入聊天记录。')
      .default(true).volatile(),
    pokeMaxTurns: Schema.number()
      .description('戳一戳「模型回复」时注入多少条最近聊天记录（0 = 不注入；最多 50）。默认 15。')
      .default(15).min(0).max(50).volatile(),
    messageMaxTurns: Schema.number()
      .description('普通消息额外注入多少条最近聊天记录（0 = 交给 DSH 原生上下文管理；最多 50）。默认 0。')
      .default(0).min(0).max(50).volatile(),
    maxContextTokens: Schema.number()
      .description('一次注入的容量上限（token）：与条数上限同时生效，超了从最老的记录开始截断。'
        + '默认 128000（128K），范围 128000~1000000（1M）。')
      .default(128000).min(128000).max(1000000).volatile(),
    smartMatch: Schema.boolean()
      .description('智能匹配：只带最近一段连续对话（相邻两条超过 5 分钟就断开），'
        + '避免把半小时前的闲聊也塞给模型；关闭则纯取最近 N 条。')
      .default(true).volatile(),
  }).description('记忆与上下文').default({}),
  // ── 时间感知（2026-10-27）────────────────────────────────────
  // 每个会话记住最后活跃时间；静默超过阈值后有人说话，就给模型补一句时间提示。
  timeAware: Schema.object({
    enabled: Schema.boolean()
      .description('时间感知开关：关闭后不记录活跃时间、也不注入任何时间提示。')
      .default(true).volatile(),
    silentMinutes: Schema.number()
      .description('静默阈值（分钟）：距离上次活跃超过这个时长才触发提示。默认 30。')
      .default(30).min(1).max(1440).volatile(),
    promptText: Schema.string()
      .description('触发时注入的提示词；N 会被替换成实际静默分钟数。')
      .default(DEFAULT_TIME_AWARE_PROMPT).volatile(),
  }).description('时间感知').default({}),
  // ── 未读归纳（v2.0 第一步，2026-10-28）──────────────────────────
  // 主人在群里发 `/归纳 [条数]`：桥接拉群历史 → 按水位挑新消息 → 旁路临时会话
  // 里的廉价模型总结 → 拼成多个 node 用合并转发发回群里（失败降级纯文本）。
  unreadSummary: Schema.object({
    enabled: Schema.boolean()
      .description('未读归纳总开关：关闭后 `/归纳` 直接回提示，不拉历史也不花 token。')
      .default(true).volatile(),
    includeImages: Schema.boolean()
      .description('图片检索：开启后把消息里的图片一起交给摘要模型（长截图会先切片）。'
        + '默认关 —— 大多数廉价模型不吃图，硬塞只会白花 token。')
      .default(false).volatile(),
    maxMessages: Schema.number()
      .description('一次最多拉取并归纳多少条历史。默认 200，硬上限 500。')
      .default(200).min(10).max(500).volatile(),
    maxImages: Schema.number()
      .description('图片检索开启时，一次最多附几张图。默认 4。')
      .default(4).min(0).max(10).volatile(),
    budgetTokens: Schema.number()
      .description('转写文本的 token 预算：超了从最老的记录开始省略。默认 24000。')
      .default(24000).min(2000).max(200000).volatile(),
    maxNodes: Schema.number()
      .description('合并转发最多拆成几段（node）。默认 6。')
      .default(6).min(1).max(20).volatile(),
    nodeChars: Schema.number()
      .description('每段最多多少字。默认 400。')
      .default(400).min(50).max(2000).volatile(),
    provider: Schema.string()
      .description('摘要用的模型 provider。留空 = 跟随 DSH 全局默认（也可以在桥接 config.json 里配）。')
      .default('').volatile(),
    model: Schema.string()
      .description('摘要用的模型名。留空 = 跟随 DSH 全局默认。')
      .default('').volatile(),
    notifyOwners: Schema.boolean()
      .description('后台失败时私聊通知主人。默认开。')
      .default(true).volatile(),
  }).description('未读归纳').default({}),
  antiDebounceMs: Schema.number()
    .description('消息防抖合并窗口（毫秒）。0 = 沿用「活跃设置」里的 debounceWindowMs（默认 800）。')
    .default(0).min(0).max(60000).volatile(),
  // ── 上下文自动清理（2026-10-27）──────────────────────────────
  // 群聊聊久了上下文会一直涨，这里按「轮数」给一个阈值；私聊永不清理。
  // 桥接侧热读这两个键（见 qq-bridge/src/runtime-config.mjs 的 HOT_KEYS）。
  maxContextTurns: Schema.number()
    .description('群聊上下文自动清理阈值（轮）。0 = 不限制；私聊永不清理。默认 30。')
    .default(30).min(0).max(500).volatile(),
  contextClearStrategy: Schema.union(['compact', 'clear', 'off'])
    .description('超限后的处理方式：compact = DSH 总结压缩后继续同一会话；'
      + 'clear = 归档旧会话并新建同名会话；off = 关闭自动清理。默认 compact。')
    .default('compact').volatile(),
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
    // 主人（2026-10-28）：管理员之上再一阶。主人自动算管理员，
    // 另加一项权限：能触发要花 token 的后台动作（`/归纳`）。
    // 权限只认这里填的 QQ 号，不认昵称、消息文本或模型输出。
    owners: Schema.array(Schema.string())
      .description('主人 QQ 号：管理员全部权限 + 触发后台动作（/归纳）。')
      .default([]).volatile(),
    // 开发者（2026-10-28 v2.0）：三阶权限最高一档（开发者 > 主人 > 管理员）。
    // 开发者自动算主人与管理员，另加一项：命中暗号（developer.keywords）时
    // 把 developer.prompt 追加到本轮 Prompt **尾部**。
    // ⚠️ 数组缺省 / 非数组时桥接自动降级为主人 + 管理员，不会报错。
    developers: Schema.array(Schema.string())
      .description('开发者 QQ 号：主人全部权限 + 暗号提权（尾部追加专属 Prompt）。')
      .default([]).volatile(),
    // 黑名单（v2.0）：桥接侧 _allow() 一直在读 deny.private / deny.groups，
    // 但 Config 一直没声明 —— 设置页的「黑名单」按钮以前写不进去。
    // 语义：deny 优先于 allow（见 bridge.isAllowed）。
    deny: Schema.object({
      private: Schema.array(Schema.string())
        .description('私聊黑名单 QQ 号：命中直接忽略，优先于私聊白名单。')
        .default([]).volatile(),
      groups: Schema.array(Schema.string())
        .description('群黑名单群号：命中直接忽略，优先于群白名单。')
        .default([]).volatile(),
    }).description('黑名单（优先于白名单）').default({}),
    allowAllWhenEmpty: Schema.boolean()
      .description('白名单为空时是否放行所有人。默认 false（fail-closed，安全）。')
      .default(false).volatile(),
  }).description('白名单').default({}),

  // ── 开发者特权（v2.0，2026-10-28）──────────────────────────────
  //
  // 三阶权限（开发者 > 主人 > 管理员）里最高一档的**唯一**特权出口。
  // 红线：
  //   · 只认 allow.developers 里的 QQ 号（isDeveloper，不看昵称/正文/模型输出）；
  //   · 命中触发词时只把 prompt 追加在发给 DSH 的 Prompt **尾部**，
  //     **绝不**写系统提示词 / 人设 section / 工具白名单；
  //   · 默认关闭（fail-closed），并且还要技能卡 sk-developer 同时开着才生效。
  developer: Schema.object({
    enabled: Schema.boolean()
      .description('启用特权暗号：关闭时触发词完全不参与判定（消息原样走普通链路）。默认关。')
      .default(false).volatile(),
    keywords: Schema.array(Schema.string())
      .description('触发关键词（以它开头才算命中，如 /dev、/admin）。区分大小写不敏感由桥接归一。')
      .default(['/dev', '/admin']).volatile(),
    prompt: Schema.string()
      .description('专属 Prompt：命中时追加到本轮 Prompt 尾部（多行，绝不动前缀缓存）。')
      .default('').volatile(),
    strangerReply: Schema.boolean()
      .description('普通群友命中暗号时是否回一句固定文案。默认关 = 静默丢弃，不暴露机制存在。')
      .default(false).volatile(),
    debugPayload: Schema.boolean()
      .description('调试：把每个会话最近一条原始入站 Payload 留在桥接内存并上报（设置页「调试信息」用）。'
        + '默认关；只存内存、截断 2000 字、不落盘。')
      .default(false).volatile(),
    // 只读预览（v2.0 任务三）：模型自动提取的开发者偏好。
    // 当前先留 UI 接口，底层写入逻辑后续补；UI 只读展示，不提供编辑。
    memoryNotes: Schema.array(Schema.object({
      at: Schema.number().default(0),
      text: Schema.string().default(''),
      source: Schema.string().default(''),
    })).description('开发者动态记忆（模型自动提取的偏好，只读预览；底层后续补写入）。')
      .default([]).volatile(),
  }).description('开发者特权（暗号提权）').default({}),
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

  // ── 操作日志（v2.0 第六步，2026-10-28）────────────────────────
  //
  // 桥接把「截断 / 归纳 / 模型报错」这类关键操作按天写进本地文件，
  // 同时在内存留最近 50 条给设置页。三个字段都允许热改（下一条日志生效）。
  // 默认目录 = <qq-bridge>/state/logs；填绝对路径可以直接落到别处。
  logDir: Schema.string()
    .description('操作日志目录。留空 = qq-bridge/state/logs；相对路径按 qq-bridge 目录解析，'
      + '也支持绝对路径。')
    .default('').volatile(),
  logMaxSizeMB: Schema.number()
    .description('单个日志文件上限（MB），达到后自动切分成 bridge-日期_时分秒.log。默认 5。')
    .default(5).min(1).max(100).volatile(),
  logMaxDays: Schema.number()
    .description('日志保留天数：启动与每天清理一次，删除修改时间超过该天数的 .log。默认 15。')
    .default(15).min(1).max(365).volatile(),

  // ── 接入总闸（v2.0 第七步，2026-10-28）──────────────────────
  //
  // false = 桥接连一条消息都不处理（连白名单都不判），但进程与 NapCat 连接照常。
  // 存在 Config 里是为了「重启不自动连回」：profile 配置会持久化，
  // 桥接重启后热同步读到的仍然是 false。
  bridgeEnabled: Schema.boolean()
    .description('接入总闸：关闭后桥接彻底不处理任何消息（含指令），重启后保持关闭。')
    .default(true).volatile(),
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

  // ── QQ 插件 HTTP 工具源（plugin-integration-contract §5，默认关）──
  //
  // 桥接新增的 plugin hub 把三个常驻插件进程（auto-reply / feiyu-voice /
  // video-frames）的工具聚合成 `GET /plugins/tools`；guard 按清单注册**同名**代理
  // 工具（约定 `qq_ext_` 前缀，执行期白名单 SAFE_PREFIXES 已放行），执行时转发到
  // `POST /plugins/tools/execute`，由桥接补 chatKey 再打给插件。
  //
  // 只允许回环地址：这些工具会真的发 QQ 消息、读本机视频文件，指向外部主机
  // 等于把「发消息 / 读文件」的能力借给别人。不是回环就 warn 并跳过。
  httpTools: Schema.object({
    enabled: Schema.boolean()
      .description('是否从桥接 plugin hub 拉取并注册 QQ 插件工具。默认关；关掉时行为与以前完全一致。')
      .default(false).volatile(),
    baseUrl: Schema.string()
      .description('桥接 plugin hub 地址（bridge pluginHub.port）。只接受 127.0.0.1 / localhost。')
      .default('http://127.0.0.1:39410').volatile(),
    token: Schema.string()
      .description('Bearer token，必须与桥接 pluginHub.token 一致；空串 = 不校验（本机默认）。')
      .default('').role('secret').volatile(),
    timeoutMs: Schema.number()
      .description('工具执行超时(ms)。契约 §5 规定执行上限 8s，这里是更严格的收紧值（只能调小）。')
      .default(10000).min(500).max(600000).volatile(),
  }).description('QQ 插件工具源（桥接 plugin hub）').default({}),

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
  proactive: Schema.object({
    engine: Schema.boolean()
      .description('引擎总闸（卡片「主动感知」的开关同步到这里）。关闭 = 引擎停摆，连感知都不跑。')
      .default(false).volatile(),
    enabled: Schema.boolean()
      .description('真实发送开关。关闭 = 演练模式：只写决策日志，不调模型、不发消息。')
      .default(false).volatile(),
    tickMs: Schema.number()
      .description('感知 tick 间隔(ms)：10~30 秒。')
      .default(20000).min(10000).max(30000).volatile(),
    groups: Schema.array(Schema.string())
      .description('参与主动感知的群（g:123456）。留空 = 所有白名单群。')
      .default([]).volatile(),
    dayStartHour: Schema.number().description('白天窗口开始（点）').default(9).min(0).max(23).volatile(),
    dayEndHour: Schema.number().description('白天窗口结束（点，不含）').default(23).min(1).max(24).volatile(),
    minSilenceMin: Schema.number().description('安静甜区下限（分钟）').default(30).min(5).max(1440).volatile(),
    maxSilenceMin: Schema.number().description('安静甜区上限（分钟）').default(120).min(10).max(2880).volatile(),
    minDailyMessages: Schema.number().description('当天至少多少条才算活群').default(20).min(0).max(1000).volatile(),
    evalIntervalMin: Schema.number().description('同一群两次评估的最小间隔（分钟）').default(30).min(5).max(1440).volatile(),
    hourlyLimit: Schema.number().description('单群每小时主动发言上限').default(2).min(1).max(10).volatile(),
    noReplyMinutes: Schema.number().description('多久没人接茬算被无视（分钟）').default(10).min(1).max(120).volatile(),
    cooldownHours: Schema.number().description('连续两次被无视后冷却（小时）').default(4).min(1).max(48).volatile(),
    scoreThreshold: Schema.number().description('打分阈值，达到才会问模型').default(5).min(0).max(20).volatile(),
  }).description('常驻感知 / 主动行为').default({}),
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
/** 路由路径：在系统资源管理器里打开操作日志目录（v2.0 第六步）。 */
const OPEN_LOG_DIR_ROUTE_PATH = '/dsh-qq-guard/open-log-dir'

/**
 * 解析操作日志目录（v2.0 第六步）。
 *
 * 口径必须与桥接 `OpLogFile.directory` 完全一致，否则「打开日志文件夹」会打开
 * 一个空目录：空配置 → `<bridgeDir>/state/logs`；相对路径按 bridgeDir 解析；
 * 绝对路径原样使用。
 *
 * @param {object} cfg 插件配置（已 plainConfig）
 * @param {string} bridgeDir qq-bridge 目录
 * @returns {string} 绝对路径
 */
export function resolveLogDir(cfg, bridgeDir) {
  const raw = String(cfg?.logDir ?? '').trim()
  const base = String(bridgeDir ?? '').trim() || DEFAULT_BRIDGE_DIR
  if (raw === '') return path.join(base, 'state', 'logs')
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw)
}

/**
 * 在系统文件管理器里打开一个目录。
 *
 * macOS / Linux 用 `open` / `xdg-open`；Windows 用绝对路径的 explorer.exe。
 * explorer 即使成功也常返回非 0 退出码，所以**只有 ENOENT**（可执行文件不存在）
 * 才算失败 —— 否则用户会一直看到「打开失败」但窗口其实已经弹出来了。
 *
 * @param {string} target 绝对路径
 * @param {{execFileImpl?:Function}} [opts] 测试注入
 * @returns {Promise<Error|null>} null = 已发起打开；Error = 失败原因
 */
export function openInFileManager(target, { execFileImpl = execFile } = {}) {
  const bin = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
    : process.platform === 'darwin' ? 'open' : 'xdg-open'
  return new Promise((resolve) => {
    try {
      execFileImpl(bin, [target], { windowsHide: true }, (error) => {
        resolve(error && error.code === 'ENOENT' ? error : null)
      })
    } catch (error) {
      resolve(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
/** 路由路径：只读扫描外部插件目录（Phase 4）。 */
const EXTERNAL_ROUTE_PATH = '/dsh-qq-guard/external-plugins'
/** 路由路径：在独立沙箱子进程里加载一个外部插件（P1，只读测试）。 */
const EXTERNAL_TEST_ROUTE_PATH = '/dsh-qq-guard/external-plugins/test'
/** 路由路径：外部插件 hook（P2，桥接每条消息前调用，best-effort）。 */
const EXTERNAL_HOOK_ROUTE_PATH = '/dsh-qq-guard/external/hook'
/** 路由路径：外部插件常驻状态快照（P2，面板 / 排障用）。 */
const EXTERNAL_RUNTIME_ROUTE_PATH = '/dsh-qq-guard/external/runtime'
/** 外部插件常驻：同一份配置多久内不重复扫描/加载（hook 每条消息都会触发一次）。 */
const EXTERNAL_RESIDENT_TTL_MS = 30_000
/** 单个外部插件 hook 的超时（p2-contract §4.2）。 */
const EXTERNAL_HOOK_TIMEOUT_MS = 1500
/** 一次 hook 请求的总预算：超过就跳过剩余插件，保证桥接等得起。 */
const EXTERNAL_HOOK_BUDGET_MS = 2000
/** 外部工具代理执行时的默认超时（p2-contract §4.3：10s）。 */
const EXTERNAL_TOOL_TIMEOUT_MS = 10_000
/** QQ 插件工具源：plugin hub 默认地址（bridge pluginHub.port）。 */
export const HTTP_TOOLS_DEFAULT_BASE_URL = 'http://127.0.0.1:39410'
/** QQ 插件工具源：拉清单超时（契约 §5：5s）。 */
const HTTP_TOOLS_MANIFEST_TIMEOUT_MS = 5000
/** QQ 插件工具源：清单没写 timeoutMs 时的兜底执行超时（可被 httpTools.timeoutMs 覆盖）。 */
const HTTP_TOOLS_EXECUTE_TIMEOUT_MS = 8000
/**
 * QQ 插件工具源：执行超时的硬上限。
 *
 * 有些工具本来就慢（肥鱼语音合成清单里声明 120s，服务端排队时更久），
 * 8s 会把它们一刀切死；所以按「清单里的 timeoutMs > 配置的 httpTools.timeoutMs > 8s」
 * 取实际值，再统一钳到这个上限。桥接侧的 pluginHub.plugins[].timeoutMs 也要同步够长。
 */
const HTTP_TOOLS_EXECUTE_MAX_MS = 180_000
/** 单次 execute 最多转几张图片（视频抽帧一次最多 12 张，别把上下文撑爆）。 */
const HTTP_TOOLS_MAX_IMAGES = 8
/** 清单里最多注册多少个工具（防桥接回包异常大）。 */
const HTTP_TOOLS_MAX_TOOLS = 64
/** 工具名合法字符：provider 侧对工具名的容忍度比 DSH 窄，先自己挡一道。 */
const HTTP_TOOLS_NAME_RE = /^[A-Za-z0-9_]{1,64}$/
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
 * 同 {@link itemEnabledIn}，但「配置里已经有数组、却缺这一项」时用传入的 fallback。
 *
 * 专门给 `sk-image` 用（p2-contract §3.1 兼容要求）：老用户的 `skills` 数组里
 * 没有这一项，但新默认是**开启**——不能被当成「用户删了 = 关闭」。
 *
 * @param {unknown} config
 * @param {string} id
 * @param {boolean} fallback 数组存在但缺项时的取值
 * @param {'skill'|'plugin'} [kind]
 */
export function itemEnabledOr(config, id, fallback, kind = 'skill') {
  const cfg = plainConfig(config) ?? {}
  const configured = Array.isArray(kind === 'plugin' ? cfg.plugins : cfg.skills)
  const list = manifestOf(cfg, kind)
  const hit = list.find((item) => item && item.id === id)
  if (hit) return hit.enabled !== false
  if (configured) return fallback === true
  const dflt = (kind === 'plugin' ? DEFAULT_PLUGINS : DEFAULT_SKILLS).find((item) => item.id === id)
  return dflt ? dflt.enabled === true : fallback === true
}

/**
 * 「记忆与上下文」卡片的总开关（2026-10-27 合并后）。
 *
 * 三档兼容，顺序不能换：
 *   ① 清单里有 `sk-memory`（合并后的新卡，或老配置里的「记忆提取」）→ 看它的 enabled；
 *   ② 只有老的 `sk-context`（升级前保存的清单）→ 沿用用户对「上下文感知」的选择；
 *   ③ 两个都没有 → 按新卡默认开启（与 sk-image / sk-time-aware 同一条兼容规则，
 *      不能因为「清单里缺项」就把功能关死）。
 * @param {unknown} config
 */
function memoryFlag(config) {
  const cfg = plainConfig(config) ?? {}
  if (!Array.isArray(cfg.skills)) return true
  const hit = cfg.skills.find((item) => item && item.id === 'sk-memory')
  if (hit) return hit.enabled !== false
  const legacy = cfg.skills.find((item) => item && item.id === 'sk-context')
  if (legacy) return legacy.enabled !== false
  return true
}

/**
 * 当前所有已实装开关的真实状态（guard 每次执行时现算，不缓存）。
 * @param {unknown} [config] 默认读 settings 实例的 Config；测试可注入。
 */
export function readFeatureFlags(config = featureState.source) {
  return {
    voice: itemEnabledIn(config, 'sk-voice'),
    image: itemEnabledOr(config, 'sk-image', true),
    vision: itemEnabledIn(config, 'sk-vision'),
    search: itemEnabledIn(config, 'sk-search'),
    // 新卡（2026-10-27）：老用户的 skills 数组里没有它，但默认是**开启**，
    // 不能被当成「用户删了 = 关闭」（与 sk-image 同一条兼容规则）。
    time: itemEnabledOr(config, 'sk-time-aware', true),
    // 记忆与上下文（2026-10-27 合并）：卡片总开关关掉 = 两处注入全部停。
    memory: memoryFlag(config),
    // 未读归纳（2026-10-28）：老用户的 skills 数组里没有这张卡，但默认**开启**，
    // 与 sk-time-aware / sk-image 同一条兼容规则（缺项不等于用户关掉了它）。
    unread: itemEnabledOr(config, 'sk-unread', true),
    // 开发者特权（v2.0）：与其它新卡相反 —— 缺项按**关闭**，提权通道必须 fail-closed。
    developer: itemEnabledOr(config, 'sk-developer', false),
    // 主动感知（v2.0 第二十九步）：同样是新能力，缺项按**关闭**（fail-closed）。
    // ⚠️ 必须显式传 kind='plugin'：它在 plugins 清单里，默认 kind 是 skill，
    // 传漏了就会去 skills 里找一个不存在的 id，`proactive` 永远是 false，
    // 卡片开了引擎也起不来（v2.0 第三十步修的就是这个）。
    proactive: itemEnabledOr(config, 'pl-proactive', false, 'plugin'),
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
 * @param {string} op clear | delete | persona | voice | image | activity
 * @param {string} key 会话 key（voice / image 为空串：桥接用 sessionId 反查）
 * @param {string} [text]
 * @param {{sessionId?:string, voice?:string, url?:string, file?:string, level?:number|null,
 *   subType?:0|1}} [extra]
 *   `level`：单群响应档位（0..3），null = 跟随全局；只有 activity 指令会带。
 *   `url` / `file`：image 指令二选一的图片来源（P2）。
 *   `subType`：image 指令的呈现形态（0=普通图片，1=表情，2026-10-26）；缺省不带。
 */
function enqueueSessionOp(op, key, text = '', extra = {}) {
  pruneSessionOps()
  // 同一个 key + 同一种操作只保留最新一条（连点两次不要建出两个新会话）。
  // voice / image 按 sessionId 去重，避免模型一次回复里重复调工具刷屏。
  //
  // ⚠️ 只跟**同类** op 去重（2026-10-24 终验修）：以前只比 sessionId，
  // 于是 voice → image → image 会把前两条都删掉——voice/image 两个不同工具
  // 互相踩，等待方要空等到 20/25s 超时才抛「桥接没回执」（错误归因 + 少发一条）。
  // 另外**已下发（lease 非空）的 op 不撤回**：桥接已经拿走了，删除既阻止不了执行，
  // 删了再结算反而会给在途请求报假失败。
  for (const [id, existing] of sessionOpsQueue) {
    if (existing.lease) continue
    const sameTarget = (op === 'voice' || op === 'image')
      ? existing.op === op && existing.sessionId === extra.sessionId
      : existing.op === op && existing.key === key
    if (!sameTarget) continue
    sessionOpsQueue.delete(id)
    // voice / image 的调用方正挂在 waitForOpResult 上：被后来的一次取代时必须
    // 结算，否则只能等超时。明确告诉它「本次未发送」，别假装成功。
    if (op === 'voice' || op === 'image') {
      settleOpResult(id, {
        ok: false,
        detail: `同一会话的同类请求已被后来的一次取代（本次未发送）：${op}`,
      })
    }
  }
  const id = `op-${Date.now().toString(36)}-${++sessionOpsSeq}`
  const level = (typeof extra.level === 'number' || extra.level === null) ? extra.level : undefined
  // subType 只在 image 指令上、且明确是 0/1 时进队（缺省不留字段，老桥接不受影响）。
  const subType = (op === 'image' && (extra.subType === 0 || extra.subType === 1)) ? extra.subType : undefined
  sessionOpsQueue.set(id, {
    id, op, key, text,
    sessionId: typeof extra.sessionId === 'string' ? extra.sessionId : '',
    voice: typeof extra.voice === 'string' ? extra.voice : '',
    url: typeof extra.url === 'string' ? extra.url : '',
    file: typeof extra.file === 'string' ? extra.file : '',
    ...(level === undefined ? {} : { level }),
    ...(subType === undefined ? {} : { subType }),
    // v2.0 第十步：动态记忆编辑（静态核心覆盖 / 黑话列表 / 删除群友档案）。
    ...(extra.core === undefined ? {} : { core: extra.core }),
    ...(extra.slang === undefined ? {} : { slang: extra.slang }),
    // v2.0 第十二步：单群人设覆盖（null 也要保留 = 删除覆盖，重新继承全局）。
    ...(extra.personaOverride === undefined ? {} : { personaOverride: extra.personaOverride }),
    ...(typeof extra.removeProfile === 'string' && extra.removeProfile !== ''
      ? { removeProfile: extra.removeProfile }
      : {}),
    // v2.0 第十八步：L2 摘要重置（恢复自动生成的原文）。
    ...(extra.reset === true ? { reset: true } : {}),
    // v2.0 第二十四步：删除跨群记忆 / 定时任务（id）。
    ...(typeof extra.id === 'string' && extra.id !== '' ? { id: extra.id } : {}),
    ...(typeof extra.field === 'string' && extra.field !== '' ? { field: extra.field } : {}),
    ...(typeof extra.file === 'string' && extra.file !== '' ? { file: extra.file } : {}),
    ...(typeof extra.qq === 'string' && extra.qq !== '' ? { qq: extra.qq } : {}),
    ...(typeof extra.mode === 'string' && extra.mode !== '' ? { mode: extra.mode } : {}),
    ...(extra.enabled === true ? { enabled: true } : {}),
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

// ── 外部插件 P2：常驻沙箱 / hook / 工具代理的跨实例共享状态 ──────────────
//
// settings 实例（profile 顶层）持有 webServer 与沙箱管理器，guard 实例（preset 内）
// 要注册 `qq_ext_*` 代理工具、并在执行时调沙箱里的工具。两个实例是**同一个 ESM
// 模块实例**，所以状态放模块级（和 personaState / featureState 同一个套路）：
//   · manager  —— settings 实例创建的 SandboxManager（测试可注入 fake）；
//   · loaded   —— 已加载的启用插件（id / name / moduleId / hooks / tools）；
//   · appliers —— guard 实例登记的回调：loaded 变化时重注册代理工具。
const externalRuntime = {
  manager: null,
  loaded: [],
  updatedAt: 0,
  /** 上一次扫描时的 enabled 签名（避免每条 hook 都重扫目录）。 */
  signature: '',
  /** guard 实例登记的「刷新代理工具」回调。 */
  appliers: new Set(),
  /** 单飞：并发的 hook / runtime 请求共用一次常驻加载。 */
  ensuring: null,
}

/**
 * 测试注入：替换沙箱管理器工厂（生产路径不调用）。
 * @param {null|((options:object)=>any)} factory
 */
let sandboxFactoryOverride = null
export function setSandboxFactoryForTests(factory) {
  sandboxFactoryOverride = typeof factory === 'function' ? factory : null
}

/** 创建沙箱管理器：测试可注入 fake，生产走真 SandboxManager。 */
function createSandboxManager(options) {
  if (sandboxFactoryOverride !== null) return sandboxFactoryOverride(options)
  return new SandboxManager(options)
}

/** 测试用：清空外部插件常驻状态（生产路径不调用）。 */
export function resetExternalRuntimeForTests() {
  externalRuntime.manager = null
  externalRuntime.loaded = []
  externalRuntime.updatedAt = 0
  externalRuntime.signature = ''
  externalRuntime.appliers.clear()
  externalRuntime.ensuring = null
}

/**
 * `GET /dsh-qq-guard/external/runtime` 的响应体（p2-contract §4.1）。
 * @returns {{ok:true, resident:{state:string, pid:number|null, alive:boolean}, loaded:Array<object>, updatedAt:number}}
 */
export function externalRuntimeSnapshot() {
  const manager = externalRuntime.manager
  const alive = manager?.alive === true
  const rawState = typeof manager?.state === 'string' ? manager.state : ''
  // 契约只允许 ready / dead / stopped：starting 之类中间态按 stopped 报。
  const state = alive || rawState === 'ready' ? 'ready' : (rawState === 'dead' ? 'dead' : 'stopped')
  return {
    ok: true,
    resident: { state, pid: manager?.nodeInfo?.pid ?? null, alive },
    loaded: externalRuntime.loaded.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      moduleId: plugin.moduleId,
      hooks: [...plugin.hooks],
      tools: plugin.tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
      })),
    })),
    updatedAt: externalRuntime.updatedAt,
  }
}

/** hook 事件 → 允许的 hook 名（与 sandbox/child.mjs 的 HOOK_ALIASES 保持一致）。 */
const EXTERNAL_HOOK_ALIASES = {
  message: ['message', 'onMessage', 'beforeContext'],
  'before-context': ['before-context', 'beforeContext', 'onMessage'],
}

/** 加载结果里的 hooks[] 是否覆盖该事件（用于跳过无 hook 模块的 IPC）。 */
function externalPluginHasHook(plugin, event) {
  const names = EXTERNAL_HOOK_ALIASES[event] ?? [event]
  const hooks = Array.isArray(plugin?.hooks) ? plugin.hooks.map((name) => String(name)) : []
  return names.some((name) => hooks.includes(name))
}

/** 收敛桥接发来的 hook 事件：只保留契约字段 + 长度上限。 */
function sanitizeExternalHookEvent(body) {
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
  const idOf = (value, max) => (typeof value === 'string' || typeof value === 'number'
    ? String(value).slice(0, max)
    : '')
  const user = body?.user && typeof body.user === 'object'
    ? { id: idOf(body.user.id, 40), name: text(body.user.name, 80), admin: body.user.admin === true }
    : { id: '', name: '', admin: false }
  const group = body?.group && typeof body.group === 'object'
    ? { id: idOf(body.group.id, 40), name: text(body.group.name, 120) }
    : null
  const imageCount = Number.isFinite(Number(body?.imageCount))
    ? Math.max(0, Math.floor(Number(body.imageCount)))
    : 0
  return {
    event: String(body?.event ?? ''),
    sessionId: text(body?.sessionId, 160),
    key: text(body?.key, 80),
    text: text(body?.text, 20000),
    imageCount,
    user,
    group,
  }
}

/** hook 返回值归一化：字符串 = text；对象取 text / drop / sections。 */
function normalizeExternalHookResult(value) {
  if (typeof value === 'string') return value === '' ? {} : { text: value.slice(0, 20000) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  if (value.drop === true) out.drop = true
  if (typeof value.text === 'string' && value.text !== '') out.text = value.text.slice(0, 20000)
  if (Array.isArray(value.sections)) {
    out.sections = value.sections
      .map((section) => (section && typeof section === 'object'
        ? {
          title: typeof section.title === 'string' ? section.title.slice(0, 200) : '',
          text: typeof section.text === 'string' ? section.text.slice(0, 20000) : '',
        }
        : null))
      .filter((section) => section !== null && (section.title !== '' || section.text !== ''))
  }
  return out
}

// ── 外部工具代理（p2-contract §4.3）───────────────────────────────────

/** 代理工具名前缀：执行期白名单 SAFE_PREFIXES 也认它。 */
export const EXTERNAL_TOOL_PREFIX = 'qq_ext_'
/** slug 长度上限（契约 §4.3）。 */
const EXTERNAL_TOOL_SLUG_MAX = 48

/**
 * 生成 `qq_ext_<slug>`：slug 只留 `[a-z0-9_]`，长度 ≤ 48；重名加 `_2` / `_3`。
 * @param {string} raw 工具名 / id
 * @param {Set<string>} used 已占用的工具名
 */
export function externalToolProxyName(raw, used, fallback = '') {
  /** 摘要成 [a-z0-9_]：中文名会被整段吃掉，所以留一个 ASCII 兜底（toolId）。 */
  const slug = (value) => String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  // 2026-10-27 修：`keyword-reply` 这类插件的中文工具名以前全被摘要成空串，
  // 于是注册出 `qq_ext_tool` / `qq_ext_tool_2`——模型完全看不出是干什么的。
  // 现在名字摘要不出来就退回工具的 ASCII id（`<模块>__<工具>`）。
  const base = (slug(raw) || slug(fallback)).slice(0, EXTERNAL_TOOL_SLUG_MAX) || 'tool'
  let name = EXTERNAL_TOOL_PREFIX + base
  let seq = 2
  while (used.has(name)) {
    const suffix = `_${seq}`
    name = EXTERNAL_TOOL_PREFIX + base.slice(0, Math.max(1, EXTERNAL_TOOL_SLUG_MAX - suffix.length)) + suffix
    seq += 1
  }
  return name
}

/** 外部工具声明里的 type → 作者 spec 的 type（不支持的降级成 json）。 */
function externalSpecType(type) {
  if (Array.isArray(type)) return type.some((item) => String(item).toLowerCase() === 'string') ? 'string' : 'json'
  if (typeof type !== 'string') return 'json'
  const value = type.toLowerCase()
  if (['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(value)) return value
  return 'json'
}

/** 单个 JSON Schema 属性 → 作者 spec 节点。 */
function adaptJsonSchemaProperty(node, required) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return { type: 'json' }
  const out = {}
  if (typeof node.description === 'string' && node.description.trim() !== '') {
    out.description = node.description.trim().slice(0, 400)
  }
  const enumValues = Array.isArray(node.enum)
    ? node.enum.filter((value) => ['string', 'number', 'boolean'].includes(typeof value))
    : []
  if (enumValues.length > 0) {
    out.type = 'string'
    out.enum = enumValues.map((value) => String(value))
  } else {
    out.type = externalSpecType(node.type)
  }
  if (out.type === 'array') {
    if (node.items) out.items = adaptJsonSchemaProperty(node.items, false)
  } else if (out.type === 'object') {
    out.additionalProperties = node.additionalProperties === true
    const properties = node.properties && typeof node.properties === 'object' ? node.properties : {}
    const nestedRequired = new Set(Array.isArray(node.required) ? node.required.map(String) : [])
    out.properties = {}
    for (const [key, value] of Object.entries(properties)) {
      out.properties[key] = adaptJsonSchemaProperty(value, nestedRequired.has(key))
    }
  }
  if (required) out.required = true
  return out
}

/** 单个作者 spec 节点 → 作者 spec 节点（类型不支持的降级成 json）。 */
function adaptAuthorSpecProperty(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return { type: 'json' }
  const out = {}
  if (typeof node.description === 'string' && node.description.trim() !== '') {
    out.description = node.description.trim().slice(0, 400)
  }
  if (typeof node.title === 'string' && node.title.trim() !== '') out.title = node.title.trim().slice(0, 200)
  if (Object.hasOwn(node, 'default')) out.default = node.default
  if (Array.isArray(node.enum)) {
    out.type = 'string'
    out.enum = node.enum.map((value) => String(value))
  } else {
    out.type = externalSpecType(node.type)
  }
  if (out.type === 'array') {
    if (node.items && typeof node.items === 'object') out.items = adaptAuthorSpecProperty(node.items)
  } else if (out.type === 'object') {
    out.additionalProperties = node.additionalProperties === true
    const properties = node.properties && typeof node.properties === 'object' ? node.properties : {}
    const nestedRequired = new Set(Array.isArray(node.required) ? node.required.map(String) : [])
    out.properties = {}
    for (const [key, value] of Object.entries(properties)) {
      out.properties[key] = adaptAuthorSpecProperty(value)
      if (nestedRequired.has(key)) out.properties[key].required = true
    }
  }
  if (node.required === true) out.required = true
  return out
}

/**
 * 把外部工具声明的 parameters 适配成 `buildToolDefinition` 的作者 spec。
 *
 * 两种输入都允许（p2-contract §4.3）：
 *   · JSON Schema：`{ type:'object', properties, required[] }`
 *   · 作者 spec：`{ 参数名: { type, description, required } }`
 * 支持 string / number / integer / boolean / array / object 与 enum；其它类型降级 `type:'json'`。
 *
 * @param {unknown} parameters
 * @returns {Record<string, object>}
 */
export function adaptExternalToolParameters(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return {}
  if (parameters.type === 'object'
    && parameters.properties
    && typeof parameters.properties === 'object'
    && !Array.isArray(parameters.properties)) {
    const required = new Set(Array.isArray(parameters.required) ? parameters.required.map(String) : [])
    const out = {}
    for (const [key, node] of Object.entries(parameters.properties)) {
      out[key] = adaptJsonSchemaProperty(node, required.has(key))
    }
    return out
  }
  const out = {}
  for (const [key, node] of Object.entries(parameters)) {
    out[key] = adaptAuthorSpecProperty(node)
  }
  return out
}

/** 把外部工具返回值渲染成一行文本（模型侧展示用）。 */
function formatExternalToolResult(value) {
  if (value === null || value === undefined) return '（外部插件没有返回内容）'
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

/**
 * P2：把「已启用且已加载」的外部插件工具代理注册进 preset 作用域。
 *
 * 注册时机：applyGuard 时先按当时的 loaded 注册一次；之后 ensureResident 重新加载
 * 会通过模块级 `externalRuntime.appliers` 回调重试（已注册过的按 moduleId+toolId 跳过）。
 *
 * 已知限制（README 里写明）：cordis 没有稳定的「按名字注销工具」入口，插件被关掉后
 * 代理工具可能残留到本次 DSH 生命周期结束；execute 里会再校验模块是否仍加载，
 * 未加载直接抛可读错误，不会真的调到停用的插件。
 *
 * @param {object} ctx guard 实例的 ctx（preset 作用域）
 */
function applyExternalToolProxies(ctx) {
  const tools = ctx.get?.('tools') ?? ctx.tools
  if (!tools || typeof tools.register !== 'function') return
  /** @type {Map<string, {moduleId:string, toolId:string}>} */
  const registered = new Map()

  const applier = () => {
    const used = new Set(registered.keys())
    for (const plugin of externalRuntime.loaded) {
      for (const tool of plugin.tools) {
        if (!tool || !tool.id) continue
        const toolId = String(tool.id)
        const already = [...registered.values()]
          .some((item) => item.moduleId === plugin.moduleId && item.toolId === toolId)
        if (already) continue
        const proxyName = externalToolProxyName(String(tool.name || toolId), used, toolId)
        used.add(proxyName)
        const displayName = String(tool.name || toolId)
        const description = `${String(tool.description ?? '').trim() || `外部插件 ${plugin.name} 提供的工具`}`
          + `（来自外部插件 ${plugin.name}；仅在插件启用且沙箱就绪时可用）`
        const definition = buildToolDefinition({
          name: proxyName,
          description: description.slice(0, 1000),
          parameters: adaptExternalToolParameters(tool.parameters),
          output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: formatExternalToolResult(value?.result) }],
          },
          execute: async (args) => {
            const manager = externalRuntime.manager
            if (!manager || typeof manager.invoke !== 'function') {
              throw new Error(`外部插件沙箱未就绪，${proxyName} 暂时不可用（请先在设置页确认外部插件可用）`)
            }
            const stillLoaded = externalRuntime.loaded
              .some((item) => item.moduleId === plugin.moduleId)
            if (!stillLoaded) {
              throw new Error(`外部插件「${plugin.name}」已停用或未加载，${proxyName} 不可用`)
            }
            try {
              const outcome = await manager.invoke(
                { moduleId: plugin.moduleId, kind: 'tool', name: toolId, args: args ?? {} },
                { timeoutMs: EXTERNAL_TOOL_TIMEOUT_MS },
              )
              return { result: outcome?.found === false ? null : (outcome?.value ?? null) }
            } catch (error) {
              throw new Error(`外部插件工具「${displayName}」执行失败：${error?.message ?? error}`)
            }
          },
        })
        try {
          tools.register(definition)
          registered.set(proxyName, { moduleId: plugin.moduleId, toolId })
          console.info?.(`[qq-guard] 已注册外部插件工具代理 ${proxyName}（${plugin.id}）`)
        } catch (error) {
          console.warn?.(`[qq-guard] 外部工具代理注册失败（${proxyName}）：${error?.message ?? error}`)
        }
      }
    }
  }

  externalRuntime.appliers.add(applier)
  try { applier() } catch (error) {
    console.warn?.(`[qq-guard] 外部工具代理初始化失败：${error?.message ?? error}`)
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { externalRuntime.appliers.delete(applier) }, 'qq-guard: external tool proxies')
  }
}

// ── QQ 插件 HTTP 工具源（plugin-integration-contract §5）───────────────
//
// 桥接新增的 plugin hub（默认 127.0.0.1:39410）把三个常驻插件进程的工具聚合成
// `GET /plugins/tools`。这里按清单注册**同名**代理工具（约定 `qq_ext_` 前缀，
// 执行期白名单 SAFE_PREFIXES 已经放行，不需要改白名单），执行时转发到
// `POST /plugins/tools/execute`，由桥接补 chatKey 再打给插件。
//
// 全部 best-effort：清单拉不到 / 桥接没开只 warn（同一原因限流一次），
// 不影响 guard 的其它功能；下次配置重载时会重新 apply。

/** 清单拉取/执行失败的 warn 去重（同一 key 只打一次，配置变了 key 也会变）。 */
const httpToolsWarned = new Set()

/** 同一个原因只 warn 一次（LOOP，避免每个 QQ 会话/每次重载都刷屏）。 */
function warnHttpToolsOnce(key, message) {
  if (httpToolsWarned.has(key)) return
  httpToolsWarned.add(key)
  while (httpToolsWarned.size > 24) httpToolsWarned.delete(httpToolsWarned.values().next().value)
  console.warn?.(`[qq-guard] ${message}`)
}

/** 测试用的超时覆盖：把 5s / 8s 的固定超时调小，免得用例真的干等。 */
const httpToolsTestOverrides = { manifestTimeoutMs: 0, executeTimeoutMs: 0 }

/**
 * 仅供 `test-http-tools.mjs`：调小清单/执行超时。
 * @param {{manifestTimeoutMs?:number, executeTimeoutMs?:number}} overrides 0 = 恢复默认
 */
export function setHttpToolsTimeoutsForTests(overrides = {}) {
  httpToolsTestOverrides.manifestTimeoutMs = Number(overrides.manifestTimeoutMs) > 0
    ? Math.floor(Number(overrides.manifestTimeoutMs)) : 0
  httpToolsTestOverrides.executeTimeoutMs = Number(overrides.executeTimeoutMs) > 0
    ? Math.floor(Number(overrides.executeTimeoutMs)) : 0
}

const httpToolsManifestTimeout = () => httpToolsTestOverrides.manifestTimeoutMs || HTTP_TOOLS_MANIFEST_TIMEOUT_MS
const httpToolsExecuteCap = () => httpToolsTestOverrides.executeTimeoutMs || HTTP_TOOLS_EXECUTE_TIMEOUT_MS

/**
 * baseUrl 是不是回环地址。
 *
 * 只认 `127.0.0.1` / `localhost`（契约 §1「只绑 127.0.0.1，不接受外部网卡」）：
 * 这些工具能真的发 QQ 消息、读本机视频文件，指向外部主机等于把这能力借出去。
 * @param {unknown} baseUrl
 * @returns {boolean}
 */
export function isLoopbackHttpUrl(baseUrl) {
  let url
  try { url = new URL(String(baseUrl ?? '')) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return host === '127.0.0.1' || host === 'localhost'
}

/**
 * 解析 `httpTools` 配置（解 volatile 包装，给默认值）。
 *
 * 生效优先级：guard 行自己的配置 > 设置页（顶层 settings 实例）的配置。
 * 为什么让设置页也能配：httpTools 的字段是 volatile（设置页只投影 volatile），
 * 用户在设置页打开后，preset 子行未必跟着变 —— 这份兜底让 UI 上的开关不是装饰。
 *
 * @param {unknown} config guard 实例的 Config
 * @param {unknown} [settingsConfig] 顶层 settings 实例的 Config（featureState.source）
 * @returns {{enabled:boolean, baseUrl:string, token:string, timeoutMs:number}}
 */
export function resolveHttpToolsConfig(config, settingsConfig) {
  const read = (source) => {
    const raw = plainConfig(source)?.httpTools
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.trim() !== ''
      ? raw.baseUrl.trim()
      : HTTP_TOOLS_DEFAULT_BASE_URL
    const timeout = Number(raw.timeoutMs)
    return {
      enabled: raw.enabled === true,
      baseUrl,
      token: typeof raw.token === 'string' ? raw.token.trim() : '',
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : HTTP_TOOLS_EXECUTE_TIMEOUT_MS,
    }
  }
  const own = read(config)
  if (own?.enabled) return own
  const shared = read(settingsConfig)
  if (shared?.enabled) return shared
  return own ?? shared ?? {
    enabled: false,
    baseUrl: HTTP_TOOLS_DEFAULT_BASE_URL,
    token: '',
    timeoutMs: HTTP_TOOLS_EXECUTE_TIMEOUT_MS,
  }
}

/** 打桥接 plugin hub 的一个 JSON 接口；HTTP 非 2xx 不抛，交给调用方按状态码给可读原因。 */
async function httpToolsFetchJson(url, { method = 'GET', body, token, timeoutMs, signal } = {}) {
  const headers = { accept: 'application/json' }
  const init = { method, headers }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const signals = []
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  if (signal) signals.push(signal)
  if (signals.length === 1) init.signal = signals[0]
  else if (signals.length > 1) {
    init.signal = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0]
  }
  const response = await fetch(url, init)
  const text = await response.text()
  let data
  try { data = text === '' ? {} : JSON.parse(text) } catch {
    throw new Error(`返回的不是 JSON（HTTP ${response.status}）`)
  }
  return { status: response.status, ok: response.ok, data }
}

/** 网络层失败的「中文可读」原因。 */
function describeHttpFailure(error) {
  const message = String(error?.message ?? error)
  if (error?.name === 'TimeoutError' || /aborted due to timeout|timed? ?out/i.test(message)) {
    return `超过时限没有响应（${message}）`
  }
  return message
}

const isTimeoutFailure = (error) => error?.name === 'TimeoutError'
  || /aborted due to timeout|timed? ?out/i.test(String(error?.message ?? ''))

/**
 * 桥接回包里的图片块 → DSH 认的图片块。
 *
 * ⚠️ 为什么不能把 `{type:'image', data, mimeType}` 原样收下：DSH 模型侧的 image block
 * 是**附件引用** `{type:'image', attachment:{attachmentId, mediaType, bytes, width, height}}`，
 * 证据是 dsh-llm-pi-ai/lib/index.js 的 userContent()：`block.attachment.attachmentId`
 * （collectImageRefs 同样直接取 `.attachment`）。原始 base64 块会让 pi-ai 在拼请求时
 * TypeError，所以这里先落附件存储，拿不到附件服务就把图片降级成一行文字。
 *
 * @param {object} ctx guard 实例 ctx（preset 作用域，向上能找到 profile 顶层的 attachments）
 * @param {object} block 桥接给的 `{type:'image', data, mimeType}`
 * @param {string} label 报错用的「插件 / 工具」标识
 * @returns {Promise<{block?:object, text?:string}>}
 */
async function httpToolImageBlock(ctx, block, label) {
  const rawMime = typeof block?.mimeType === 'string' ? block.mimeType.trim().toLowerCase() : ''
  const mediaType = rawMime !== '' ? rawMime : 'image/jpeg'
  const base64 = typeof block?.data === 'string' ? block.data.trim() : ''
  const bytes = base64 === '' ? 0 : Math.floor((base64.length * 3) / 4)
  const sizeText = bytes > 0 ? `约 ${Math.max(1, Math.round(bytes / 1024))} KB` : '大小未知'
  const fallbackText = `[收到一张图片（${mediaType}，${sizeText}），当前会话没法直接展示图片内容]`
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mediaType)) {
    return { text: `[收到一张 ${mediaType} 的图片，格式不支持展示]` }
  }
  if (base64 === '') return { text: fallbackText }
  const attachments = ctx?.get?.('attachments') ?? ctx?.attachments
  if (!attachments || typeof attachments.saveImage !== 'function') return { text: fallbackText }
  try {
    const buffer = Buffer.from(base64, 'base64')
    if (buffer.byteLength === 0) return { text: fallbackText }
    const ref = await attachments.saveImage({ data: new Uint8Array(buffer), mediaType })
    if (!ref || typeof ref !== 'object' || typeof ref.attachmentId !== 'string') return { text: fallbackText }
    return { block: { type: 'image', attachment: ref } }
  } catch (error) {
    warnHttpToolsOnce(`image:${label}:${String(error?.message ?? error)}`,
      `QQ 插件工具「${label}」返回的图片存不进附件区，已降级成文字：${error?.message ?? error}`)
    return { text: fallbackText }
  }
}

/** 桥接 execute 回包的 content → DSH 工具结果 content blocks（text / 附件图片）。 */
async function httpToolContentBlocks(ctx, content, label) {
  const blocks = []
  let images = 0
  let dropped = 0
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text') {
      blocks.push({ type: 'text', text: String(block.text ?? '') })
      continue
    }
    if (block?.type === 'image') {
      if (images >= HTTP_TOOLS_MAX_IMAGES) { dropped += 1; continue }
      const converted = await httpToolImageBlock(ctx, block, label)
      if (converted.block) { blocks.push(converted.block); images += 1 }
      else if (converted.text) blocks.push({ type: 'text', text: converted.text })
      continue
    }
    blocks.push({ type: 'text', text: `（未知内容块 ${String(block?.type ?? '?')}，已忽略）` })
  }
  if (dropped > 0) blocks.push({ type: 'text', text: `（另外 ${dropped} 张图片超出单次上限，已省略）` })
  if (blocks.length === 0) blocks.push({ type: 'text', text: '（QQ 插件没有返回内容）' })
  return blocks
}

/**
 * 按清单造一个代理工具定义。
 * @param {object} ctx guard 实例 ctx
 * @param {{name:string,title?:string,description?:string,parameters?:unknown,plugin?:string}} tool 清单项
 * @param {{cfg:{baseUrl:string,token:string,timeoutMs:number}, base:string}} options
 * @returns {object} registry-ready definition
 */
function makeHttpToolDefinition(ctx, tool, { cfg, base, execName }) {
  const name = tool.name
  // 注册名（DSH 可见，带 qq_ext_ 前缀）与执行名（桥接清单里的原名）可能不同：
  // 前缀只用于白名单识别，桥接只认插件自己报的短 id。
  const callName = typeof execName === 'string' && execName.trim() !== '' ? execName.trim() : name
  const pluginName = typeof tool.plugin === 'string' && tool.plugin.trim() !== '' ? tool.plugin.trim() : '未知插件'
  const title = typeof tool.title === 'string' && tool.title.trim() !== '' ? tool.title.trim() : name
  const label = `${pluginName} / ${title}`
  const rawDescription = typeof tool.description === 'string' && tool.description.trim() !== ''
    ? tool.description.trim()
    : 'QQ 插件提供的工具'
  const description = `${rawDescription}（由 QQ 插件「${pluginName}」经桥接提供；桥接或插件没开时会报错）`
  return buildToolDefinition({
    name,
    description: description.slice(0, 1000),
    // 复用外部插件那套 JSON Schema → 作者 spec 的转换，不复制第二份。
    parameters: adaptExternalToolParameters(tool.parameters),
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => (Array.isArray(value?.blocks) && value.blocks.length > 0
        ? value.blocks
        : [{ type: 'text', text: '（QQ 插件没有返回内容）' }]),
    },
    execute: async (args, exec) => {
      // sessionId 是桥接反查 chatKey 的唯一凭据（与 qq_send_voice 同口径）：
      // agent.id 与 agent.session.id 是同一个共享 id，优先取前者。
      const sessionId = String(exec?.agent?.id ?? exec?.agent?.session?.id ?? '').trim()
      // 超时口径：清单里的 timeoutMs 优先（插件自己声明，比如语音合成 120s），
      // 没声明才退回配置的 httpTools.timeoutMs；测试注入的覆盖值仍然生效。
      const declaredMs = Number(tool?.timeoutMs) > 0 ? Math.floor(Number(tool.timeoutMs)) : cfg.timeoutMs
      const executeCap = httpToolsTestOverrides.executeTimeoutMs > 0
        ? httpToolsTestOverrides.executeTimeoutMs
        : HTTP_TOOLS_EXECUTE_MAX_MS
      const timeoutMs = Math.min(Math.max(declaredMs > 0 ? declaredMs : HTTP_TOOLS_EXECUTE_TIMEOUT_MS, 1000), executeCap)
      let response
      try {
        response = await httpToolsFetchJson(`${base}/plugins/tools/execute`, {
          method: 'POST',
          body: { name: callName, args: args ?? {}, sessionId },
          token: cfg.token,
          timeoutMs,
        })
      } catch (error) {
        if (isTimeoutFailure(error)) {
          throw new Error(`QQ 插件工具「${label}」执行超时（${timeoutMs}ms 内没返回）：桥接或插件卡住了，稍后再试`)
        }
        throw new Error(`QQ 插件工具「${label}」执行失败：连不上桥接插件通道（${base}）：${describeHttpFailure(error)}`)
      }
      if (response.status === 401) {
        throw new Error(`QQ 插件工具「${label}」执行失败：桥接返回 401，httpTools.token 与桥接 pluginHub.token 不一致？`)
      }
      if (!response.ok) {
        throw new Error(`QQ 插件工具「${label}」执行失败：桥接返回 HTTP ${response.status}`)
      }
      const data = response.data ?? {}
      if (data.ok !== true) {
        const reason = typeof data.error === 'string' && data.error.trim() !== ''
          ? data.error.trim()
          : '桥接没有给出原因'
        throw new Error(`QQ 插件工具「${label}」执行失败：${reason}`)
      }
      return { blocks: await httpToolContentBlocks(ctx, data.content, label) }
    },
  })
}

/**
 * QQ 插件工具源：拉清单 → 注册同名代理工具。
 *
 * 注册时机：applyGuard 时（配置重载会重新 apply，旧 fiber 掉了工具也就没了）。
 * 返回「这次拉取 + 注册」的 promise，失败已经内部吞掉（只 warn），主要给测试 await。
 *
 * @param {object} ctx guard 实例 ctx（preset 作用域）
 * @param {unknown} config guard 实例的 Config
 * @returns {Promise<{registered:string[]}>}
 */
export function applyHttpTools(ctx, config) {
  const result = { registered: [] }
  const tools = ctx.get?.('tools') ?? ctx.tools
  if (!tools || typeof tools.register !== 'function') return Promise.resolve(result)
  const cfg = resolveHttpToolsConfig(config, featureState.source)
  if (cfg.enabled !== true) return Promise.resolve(result)
  if (!isLoopbackHttpUrl(cfg.baseUrl)) {
    warnHttpToolsOnce(`non-loopback:${cfg.baseUrl}`,
      `httpTools.baseUrl 不是回环地址（${cfg.baseUrl}），已跳过 QQ 插件工具注册：`
      + '这些工具能真的发 QQ 消息、读本机视频文件，只接受 127.0.0.1 / localhost')
    return Promise.resolve(result)
  }
  if (typeof fetch !== 'function') return Promise.resolve(result)
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const controller = new AbortController()
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => controller.abort(), 'qq-guard: http tools')
    } catch { /* effect 注册失败不影响本次拉取 */ }
  }

  const load = async () => {
    try {
      let response
      try {
        response = await httpToolsFetchJson(`${base}/plugins/tools`, {
          token: cfg.token,
          timeoutMs: httpToolsManifestTimeout(),
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) return
        warnHttpToolsOnce(`manifest:${base}:${String(error?.message ?? error)}`,
          `拉取 QQ 插件工具清单失败（${base}）：${describeHttpFailure(error)}；`
          + 'guard 其它功能不受影响，桥接 plugin hub 起来后重载配置即可重试')
        return
      }
      if (response.status === 401) {
        warnHttpToolsOnce(`manifest:${base}:401`,
          '拉取 QQ 插件工具清单被拒（HTTP 401）：httpTools.token 与桥接 pluginHub.token 不一致？'
          + '已跳过，guard 其它功能不受影响')
        return
      }
      if (!response.ok) {
        warnHttpToolsOnce(`manifest:${base}:http-${response.status}`,
          `拉取 QQ 插件工具清单失败：桥接返回 HTTP ${response.status}，已跳过（guard 其它功能不受影响）`)
        return
      }
      const data = response.data ?? {}
      if (data.ok !== true) {
        warnHttpToolsOnce(`manifest:${base}:ok-${String(data.error ?? '')}`,
          `拉取 QQ 插件工具清单失败：桥接回包 ok!=true（${String(data.error ?? '没有给原因')}），已跳过`)
        return
      }
      if (!Array.isArray(data.tools)) {
        warnHttpToolsOnce(`manifest:${base}:bad-payload`,
          '拉取 QQ 插件工具清单失败：回包里没有 tools 数组，已跳过')
        return
      }
      const used = new Set()
      for (const tool of data.tools.slice(0, HTTP_TOOLS_MAX_TOOLS)) {
        if (controller.signal.aborted) return
        const rawName = typeof tool?.name === 'string' ? tool.name.trim() : ''
        if (rawName === '') {
          warnHttpToolsOnce(`bad-name:${base}:${String(tool?.name)}`,
            `QQ 插件工具清单里有空工具名，已跳过`)
          continue
        }
        // 2026-10-27 改口径：插件清单报**短 id**（send_custom_voice / read_video），
        // 由这里统一加 qq_ext_ 前缀再注册——前缀只属于"执行期白名单标记"，
        // 不该让每个插件自己拼。老插件仍报全名时不再重复加。
        const name = rawName.startsWith(EXTERNAL_TOOL_PREFIX) ? rawName : EXTERNAL_TOOL_PREFIX + rawName
        if (!HTTP_TOOLS_NAME_RE.test(name)) {
          warnHttpToolsOnce(`bad-name:${base}:${name}`,
            `QQ 插件工具清单里有非法工具名（${JSON.stringify(name)}），已跳过`)
          continue
        }
        if (used.has(name)) {
          warnHttpToolsOnce(`duplicate:${base}:${name}`,
            `QQ 插件工具清单里出现重复工具名 ${name}，只注册第一个`)
          continue
        }
        used.add(name)
        try {
          tools.register(makeHttpToolDefinition(ctx, { ...tool, name }, { cfg, base, execName: rawName }))
          result.registered.push(name)
        } catch (error) {
          warnHttpToolsOnce(`register:${base}:${name}`,
            `QQ 插件工具 ${name} 注册失败（已跳过）：${error?.message ?? error}`)
        }
      }
      if (result.registered.length > 0) {
        console.info?.(`[qq-guard] 已从桥接注册 ${result.registered.length} 个 QQ 插件工具（${base}）：`
          + result.registered.join(', '))
      }
    } catch (error) {
      // 兜底：清单处理里的意外错误也只 warn，绝不冒泡到 applyGuard。
      warnHttpToolsOnce(`unexpected:${base}:${String(error?.message ?? error)}`,
        `QQ 插件工具源初始化异常（已忽略）：${error?.message ?? error}`)
    }
  }

  return load().then(() => result)
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

/* ── 戳一戳表情图存储（2026-10-27）──────────────────────────────
 *
 * 为什么落盘而不是把 base64 写进配置：
 *   · 桥接每 2 秒轮询 `GET /dsh-qq-guard/config`，那条路由返回**整包** config；
 *     一张 5MB 图转 base64 是 6.7MB，等于每 2 秒传一次 6.7MB JSON。
 *   · 配置最终写进 profile 的 cordis.patch.yml，多几张图就把文件撑到几十 MB，
 *     DSH 每次启动都要解析它。
 * ⇒ 前端把 File 直接 POST 成二进制，Host 校验魔数后落盘，配置里只留绝对路径。
 *
 * 存储目录固定 `~/.dsh/qq-guard/poke-images/`（与 bili-whale 等自建插件同一习惯）：
 * 换 profile 不丢图，桥接进程同用户同机，`file:///` 能被 NapCat 读到。
 */
const POKE_IMAGE_ROUTE_PATH = '/dsh-qq-guard/poke-image'
// 测试用 QQG_POKE_IMAGE_DIR 指到临时目录，避免离线用例往真实 ~/.dsh 里写图；
// 生产环境不设它，永远落在默认位置。
const POKE_IMAGE_DIR = process.env.QQG_POKE_IMAGE_DIR
  ? path.resolve(process.env.QQG_POKE_IMAGE_DIR)
  : path.join(os.homedir(), '.dsh', 'qq-guard', 'poke-images')
const POKE_IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** 未被配置引用、且超过这个时间的文件才清：避免刚传完还没来得及保存就被删。 */
const POKE_IMAGE_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000
/** 回读只认 sha1 + 白名单扩展名：彻底杜绝望目录穿越。 */
const POKE_IMAGE_NAME_RE = /^[a-f0-9]{40}\.(?:png|gif|jpg|webp)$/u

/** 只认这四种位图；扩展名一律按魔数决定，不信客户端给的文件名。 */
const POKE_IMAGE_TYPES = [
  { mime: 'image/png', ext: 'png', hit: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 },
  { mime: 'image/gif', ext: 'gif', hit: (b) => b.length > 6 && b.subarray(0, 3).toString('ascii') === 'GIF' },
  { mime: 'image/jpeg', ext: 'jpg', hit: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 },
  { mime: 'image/webp', ext: 'webp', hit: (b) => b.length > 12 && b.subarray(8, 12).toString('ascii') === 'WEBP' },
]

/** 表情图目录（导出给测试用，生产代码不要改它）。 */
export function pokeImageDir() {
  return POKE_IMAGE_DIR
}

/**
 * 按魔数认图片类型；不认识的返回 null。
 * @param {Buffer} buffer
 * @returns {{mime:string, ext:string}|null}
 */
export function sniffPokeImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null
  const type = POKE_IMAGE_TYPES.find((item) => item.hit(buffer))
  return type ? { mime: type.mime, ext: type.ext } : null
}

/**
 * 读原始二进制请求体（图片上传用，上限 5MB）。
 * 与 readJsonBody 分开：这里不做 JSON 解析，超限直接 413 并断流。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(Object.assign(new Error(`图片超过 ${Math.floor(maxBytes / 1048576)}MB 上限`), { statusCode: 413 }))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', (error) => reject(error))
  })
}

/**
 * 表情图的上传 / 回读路由。
 *
 *   `POST` 二进制 body → 落盘，返回 `{ ok, path, name, bytes, mime }`
 *   `GET  ?name=<sha1>.<ext>` → 回读原图（UI 预览用）
 *
 * 只允许同源请求（与其它写路由同一套 sec-fetch-site 校验）：
 * 上传会写本机磁盘，不能被任意网页借用户浏览器塞文件。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handlePokeImageRoute(req, res) {
  const fetchSite = req.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
    return
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const name = String(new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? '')
    if (!POKE_IMAGE_NAME_RE.test(name)) {
      sendJson(res, 400, { ok: false, reason: '非法的图片名' })
      return
    }
    const file = path.join(POKE_IMAGE_DIR, name)
    if (!existsSync(file)) {
      sendJson(res, 404, { ok: false, reason: '图片不存在' })
      return
    }
    const ext = name.split('.').pop()
    const mime = POKE_IMAGE_TYPES.find((item) => item.ext === ext)?.mime ?? 'application/octet-stream'
    res.writeHead(200, {
      'content-type': mime,
      'content-length': statSync(file).size,
      // 文件名是内容 sha1，可以放心长缓存；换图必然换名。
      'cache-control': 'private, max-age=86400',
    })
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file))
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, reason: 'method not allowed' })
    return
  }
  const buffer = await readRawBody(req, POKE_IMAGE_MAX_BYTES)
  if (buffer.length === 0) {
    sendJson(res, 400, { ok: false, reason: '空请求体' })
    return
  }
  const type = sniffPokeImage(buffer)
  if (!type) {
    sendJson(res, 415, { ok: false, reason: '只支持 PNG / GIF / JPEG / WebP' })
    return
  }
  await fsp.mkdir(POKE_IMAGE_DIR, { recursive: true })
  // 文件名 = 内容 sha1：同一张图重复上传不会产生第二份。
  const name = `${createHash('sha1').update(buffer).digest('hex')}.${type.ext}`
  const file = path.join(POKE_IMAGE_DIR, name)
  if (!existsSync(file)) await fsp.writeFile(file, buffer)
  sendJson(res, 200, { ok: true, path: file, name, bytes: buffer.length, mime: type.mime })
}

/**
 * 清掉没被任何回复引用的旧图（启动后跑一次即可，不做定时）。
 *
 * 只删「超过 24 小时」的孤儿：用户传完图还没点保存时文件已经在盘上，
 * 立刻清理会把刚选好的图删掉。取消弹窗留下的残留交给下一次启动。
 * @param {object} config 插件 Config（读 `poke.replies[].image`）
 */
export async function cleanupOrphanPokeImages(config) {
  let names = []
  try {
    names = await fsp.readdir(POKE_IMAGE_DIR)
  } catch {
    return { ok: true, removed: 0 }   // 目录还不存在 = 没上传过，什么都不用做
  }
  const cfg = plainConfig(config) ?? {}
  const keep = new Set()
  for (const row of Array.isArray(cfg.poke?.replies) ? cfg.poke.replies : []) {
    const image = typeof row?.image === 'string' ? row.image.trim() : ''
    if (image) keep.add(path.basename(image))
  }
  let removed = 0
  for (const name of names) {
    if (!POKE_IMAGE_NAME_RE.test(name) || keep.has(name)) continue
    const file = path.join(POKE_IMAGE_DIR, name)
    try {
      const stat = await fsp.stat(file)
      if (Date.now() - stat.mtimeMs < POKE_IMAGE_ORPHAN_TTL_MS) continue
      await fsp.unlink(file)
      removed++
    } catch { /* 单个文件清不掉不影响其余，下次再试 */ }
  }
  return { ok: true, removed }
}

/**
 * 收敛「操作日志」单行：at 时间戳、level 三档、text 截断。
 *
 * 为什么不让桥接原样透传：这条路由对任何本机进程开放（无 Cookie），
 * 只收白名单字段是既有原则；顺带把异常 level 归一成 info，前端样式不用兜底。
 * @param {unknown} row
 * @returns {{at:number, level:'info'|'warn'|'error', text:string}|null}
 */
function sanitizeOpLogRow(row) {
  if (!row || typeof row !== 'object') return null
  const at = Number(row.at)
  const level = row.level === 'error' ? 'error' : row.level === 'warn' ? 'warn' : 'info'
  const text = typeof row.text === 'string'
    ? row.text.replace(/\r\n/gu, '\n').slice(0, 1000)
    : ''
  if (text.trim() === '') return null
  return {
    at: Number.isFinite(at) && at > 0 ? Math.min(Math.floor(at), 8.64e15) : 0,
    level,
    text,
  }
}

/**
 * 收敛桥接上报的跨群记忆条目（v2.0 第二十四步）。
 * @param {unknown} value
 */
function sanitizeGlobalMemoryRow(value) {
  if (!value || typeof value !== 'object') return null
  const text = (input, max) => (typeof input === 'string' ? input.replace(/\s+/gu, ' ').trim().slice(0, max) : '')
  const id = text(value.id, 80)
  if (id === '') return null
  return {
    id,
    kind: ['person', 'fact', 'preference'].includes(value.kind) ? value.kind : 'fact',
    title: text(value.title, 60),
    text: text(value.text, 300),
    qq: text(value.qq, 20),
    updatedAt: Number(value.updatedAt) || 0,
  }
}

/**
 * 收敛桥接上报的定时任务（v0.0 第二十四步）。
 * @param {unknown} value
 */
function sanitizeTaskRow(value) {
  if (!value || typeof value !== 'object') return null
  const text = (input, max) => (typeof input === 'string' ? input.replace(/\s+/gu, ' ').trim().slice(0, max) : '')
  const id = text(value.id, 80)
  if (id === '') return null
  return {
    id,
    cron: text(value.cron, 80),
    prompt: text(value.prompt, 200),
    targets: Array.isArray(value.targets)
      ? value.targets.slice(0, 20).map((item) => text(item, 40)).filter(Boolean)
      : [],
    enabled: value.enabled !== false,
    nextRunAt: Number(value.nextRunAt) || 0,
    lastRunAt: Number(value.lastRunAt) || 0,
    lastResult: text(value.lastResult, 200),
  }
}

/**
 * 收敛桥接上报的记忆备份行（v2.0 第二十六步）。
 * @param {unknown} value
 */
function sanitizeBackupRow(value) {
  if (!value || typeof value !== 'object') return null
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, 80) : ''
  if (!/^backup-\d{8}-\d{6}\.json\.gz$/u.test(name)) return null
  return {
    name,
    at: Number(value.at) || 0,
    bytes: Math.max(0, Number(value.bytes) || 0),
  }
}

/**
 * 收敛桥接上报的主动感知视图（v2.0 第二十八步）。
 * @param {unknown} value
 */
function sanitizePresence(value) {
  if (!value || typeof value !== 'object') return null
  const text = (input, max) => (typeof input === 'string' ? input.replace(/\s+/gu, ' ').trim().slice(0, max) : '')
  const num = (input, max) => {
    const parsed = Number(input)
    return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, max) : 0
  }
  // 决策行白名单（单群 Tab 与全局视图共用同一套）。
  const decisionRow = (item) => ({
    at: num(item?.at, 8.64e15),
    key: text(item?.key, 40),
    verdict: ['speak', 'silent', 'skip', 'dry-run', 'send-failed'].includes(item?.verdict)
      ? item.verdict
      : 'skip',
    reason: text(item?.reason, 200),
    score: Math.min(50, num(item?.score, 50)),
    text: text(item?.text, 60),
  })
  const groups = Array.isArray(value.groups)
    ? value.groups.slice(0, 20).map((item) => ({
      key: text(item?.key, 40),
      status: item?.status === 'cooling' ? 'cooling' : 'ready',
      coolUntil: num(item?.coolUntil, 8.64e15),
      waitingSince: num(item?.waitingSince, 8.64e15),
      ignoredStreak: Math.min(10, num(item?.ignoredStreak, 10)),
      speakLastHour: Math.min(20, num(item?.speakLastHour, 20)),
      lastSpeakAt: num(item?.lastSpeakAt, 8.64e15),
      // v2.0 第二十九步：单群决策记录（每群最多 20 条）。
      decisions: Array.isArray(item?.decisions) ? item.decisions.slice(-20).map(decisionRow) : [],
    })).filter((item) => item.key !== '')
    : []
  const decisions = Array.isArray(value.decisions)
    ? value.decisions.slice(-20).map(decisionRow)
    : []
  return {
    // 三层开关（v2.0 第二十九步）：engine=总闸，enabled=真实发送，dryRun=演练中。
    engine: value.engine === true,
    enabled: value.enabled === true,
    dryRun: value.dryRun === true,
    tickMs: num(value.tickMs, 60_000),
    lastTickAt: num(value.lastTickAt, 8.64e15),
    stats: {
      sensed: Math.min(100, num(value?.stats?.sensed, 100)),
      evaluated: Math.min(100, num(value?.stats?.evaluated, 100)),
      spoke: Math.min(100, num(value?.stats?.spoke, 100)),
      skipped: Math.min(100, num(value?.stats?.skipped, 100)),
      candidates: Math.min(100, num(value?.stats?.candidates, 100)),
    },
    groups,
    decisions,
  }
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
    // v2.0 第二十五步：主人级休眠截止时间（ms）。0 = 未休眠。
    mutedUntil: num(row.mutedUntil, 8.64e15),
    // v2.0 第二十七步：单群群友黑名单（QQ 数组，最多 50）。
    userBlacklist: Array.isArray(row.userBlacklist)
      ? [...new Set(row.userBlacklist
        .map((item) => (typeof item === 'string' ? item.trim().slice(0, 20) : ''))
        .filter((qq) => /^\d{5,15}$/u.test(qq)))]
        .slice(0, 50)
      : [],
    // v2.0 第二十九步：单群主动感知授权（第 5 个 Tab 的开关状态）。
    proactiveEnabled: row.proactiveEnabled === true,
    // 单人设回填（会话详情里的输入框要显示已保存的值）。多行不能压成单行，
    // 只裁掉首尾空白与长度，换行原样保留。
    persona: textPreservingLines(row.persona, 20000),
    // 单群响应档位：**null = 跟随全局**，是一个有意义的取值，必须原样保留；
    // 绝不能走上面的 num()（它会把 0 和 null 都压成 0，"仅艾特"和"跟随全局"就分不清了）。
    activityLevel: normalizeActivityLevelInput(row.activityLevel),
    // ── v2.0（2026-10-28）会话详情上报 ──────────────────────────────
    // 轻量字段：每条会话都带。
    modelRoute: text(row.modelRoute, 160),
    context: sanitizeSessionContext(row.context),
    summary: sanitizeSessionSummary(row.summary),
    // 重字段：桥接只给最近活跃的 12 个会话带；缺省时**不写键**，
    // 前端据此区分「不在活跃窗口」和「确实没有消息」。
    ...(Array.isArray(row.recent) ? { recent: sanitizeRecentRows(row.recent) } : {}),
    ...(row.raw && typeof row.raw === 'object' ? { raw: sanitizeRawPayload(row.raw) } : {}),
    // ── v2.0 第十步：双轨制人设 / 动态记忆 ────────────────────────────
    core: sanitizeCore(row.core),
    userProfiles: Array.isArray(row.userProfiles)
      ? row.userProfiles.slice(0, 50).map(sanitizeUserProfile).filter(Boolean)
      : [],
    // v2.0 第十一步：黑话词条（对象数组）+ 合并视图（全局 + 单群，单群覆盖）。
    slang: sanitizeSlang(row.slang),
    mergedSlang: sanitizeSlang(row.mergedSlang),
    // v2.0 第十二步：单群人设覆盖 { templateId, botName, groupName, participation, core }。
    personaOverride: sanitizePersonaOverride(row.personaOverride),
    contextBriefing: typeof row.contextBriefing === 'string' ? row.contextBriefing.slice(0, 4000) : '',
    // v2.0 第十八步：人工编辑标记 + 原始自动文本（UI 角标 / 重置）。
    briefingEdited: row.briefingEdited === true,
    briefingGenerated: typeof row.briefingGenerated === 'string' ? row.briefingGenerated.slice(0, 4000) : '',
  }
}

/** 收敛单群人设覆盖（v2.0 第十二步）。空对象 = null（继承全局）。 */
function sanitizePersonaOverride(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const text = (input, max) => (typeof input === 'string' ? input.trim().slice(0, max) : '')
  // 覆盖对象按「已保存的配置」处理：首尾空白直接裁掉，避免单群把空格带进人设。
  const core = {
    identity: text(value.core?.identity, 4000),
    boundary: text(value.core?.boundary, 4000),
    style: text(value.core?.style, 4000),
  }
  const out = {
    templateId: text(value.templateId, 80),
    botName: text(value.botName, 60),
    groupName: text(value.groupName, 60),
    participation: ['quiet', 'normal', 'active'].includes(value.participation) ? value.participation : '',
    core,
  }
  const has = out.templateId !== '' || out.botName !== '' || out.groupName !== ''
    || out.participation !== '' || core.identity !== '' || core.boundary !== '' || core.style !== ''
  return has ? out : null
}

/** 收敛黑话词条数组（v2.0 第十一步）。 */
function sanitizeSlang(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value.slice(0, 100)) {
    const src = item && typeof item === 'object' && !Array.isArray(item) ? item : {}
    const term = typeof src.term === 'string' ? src.term.replace(/\s+/gu, ' ').trim().slice(0, 60) : ''
    if (term === '') continue
    out.push({
      term,
      meaning: typeof src.meaning === 'string' ? src.meaning.trim().slice(0, 500) : '',
      reply: typeof src.reply === 'string' ? src.reply.trim().slice(0, 1000) : '',
      image: typeof src.image === 'string' ? src.image.trim().slice(0, 1000) : '',
      allowSearch: src.allowSearch !== false,
      scope: src.scope === 'group' ? 'group' : 'global',
    })
  }
  return out
}

/** 收敛单群静态核心（三段，纯文本展示 / 编辑回填）。 */
function sanitizeCore(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const line = (input) => (typeof input === 'string' ? input.slice(0, 4000) : '')
  return { identity: line(src.identity), boundary: line(src.boundary), style: line(src.style) }
}

/** 收敛单条群友档案。 */
function sanitizeUserProfile(value) {
  if (!value || typeof value !== 'object') return null
  const qq = typeof value.qq === 'string' ? value.qq.replace(/\D/gu, '').slice(0, 20) : ''
  if (qq === '') return null
  const text = (input, max) => (typeof input === 'string' ? input.replace(/\s+/gu, ' ').trim().slice(0, max) : '')
  return {
    qq,
    nickname: text(value.nickname, 60),
    lastNickname: text(value.lastNickname, 60),
    role: value.role === 'owner' || value.role === 'admin' ? value.role : 'member',
    tags: Array.isArray(value.tags)
      ? [...new Set(value.tags.map((tag) => text(tag, 40)).filter(Boolean))].slice(0, 5)
      : [],
  }
}

/**
 * 收敛「记忆注入预算 / 最近一轮实际注入」。
 * 全部字段都是展示用数字，非法值一律归零，绝不把 NaN 传给前端。
 * @param {unknown} value
 */
function sanitizeSessionContext(value) {
  const src = value && typeof value === 'object' ? value : {}
  const num = (input, max) => {
    const n = Number(input)
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : 0
  }
  return {
    budget: num(src.budget, 10_000_000),
    enabled: src.enabled !== false,
    // v2.0 第十七步：0 = 不注入桥接记忆（交给 DSH 原生托管），UI 用它选文案。
    messageMaxTurns: num(src.messageMaxTurns, 1000),
    turns: num(src.turns, 1000),
    tokens: num(src.tokens, 10_000_000),
    dropped: num(src.dropped, 100_000),
  }
}

/**
 * 收敛「未读归纳水位」。lastError 是给排障看的，压成单行 + 截断。
 * @param {unknown} value
 */
function sanitizeSessionSummary(value) {
  const src = value && typeof value === 'object' ? value : {}
  const num = (input, max) => {
    const n = Number(input)
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : 0
  }
  return {
    lastAt: num(src.lastAt, 8.64e15),
    runs: num(src.runs, 100_000),
    lastError: typeof src.lastError === 'string'
      ? src.lastError.replace(/\s+/gu, ' ').trim().slice(0, 200)
      : '',
  }
}

/**
 * 收敛「最近入站消息」数组（最多 10 条）。
 *
 * 顺序是**最新在前**（桥接侧已经倒序），这里不再重排；
 * 每条正文 / 引用各自截断，防止桥接未来改大后把状态 POST 撑爆。
 * @param {unknown[]} rows
 */
function sanitizeRecentRows(rows) {
  const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '')
  const out = []
  for (const row of rows.slice(0, 10)) {
    if (!row || typeof row !== 'object') continue
    const at = Number(row.at)
    out.push({
      at: Number.isFinite(at) && at > 0 ? Math.min(Math.floor(at), 8.64e15) : 0,
      name: text(row.name, 80),
      qq: text(row.qq, 40),
      kind: row.kind === 'private' ? 'private' : 'group',
      text: text(row.text, 200),
      quote: text(row.quote, 160),
    })
  }
  return out
}

/**
 * 收敛「原始入站 Payload」。只接受字符串，长度封顶 2200（桥接截断在 2000）。
 * @param {unknown} value
 */
function sanitizeRawPayload(value) {
  const src = value && typeof value === 'object' ? value : {}
  const at = Number(src.at)
  return {
    at: Number.isFinite(at) && at > 0 ? Math.min(Math.floor(at), 8.64e15) : 0,
    json: typeof src.json === 'string' ? src.json.slice(0, 2200) : '',
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

  // ── 第 0.6 层：发图片工具（P2，同样注册在 preset 作用域）──────────
  applyImageTool(ctx)

  // ── 第 0.7 层：外部插件工具代理（P2，qq_ext_<slug>，按已加载插件注册）──
  applyExternalToolProxies(ctx)

  // ── 第 0.75 层：桥接 plugin hub 的 QQ 插件工具（契约 §5，默认关）──
  // 异步拉清单，拉不到只 warn（限流一次）；返回的 promise 没人等，失败已在内部吞掉。
  void applyHttpTools(ctx, config)

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
    if (toolName === IMAGE_TOOL_NAME) {
      return flags.image ? undefined : '「发图片」技能未开启，qq_send_image 已拒绝'
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

/** 「发图片」工具名（guard 与测试共用）。 */
export const IMAGE_TOOL_NAME = 'qq_send_image'
/**
 * 工具能力版本（v0.5.1）。
 *
 * 为什么需要它：DSH 会话会把**首次 `request/header`** 冻成工具基线，之后新增的工具
 * 只能以 `tool-addition` 增量下发；实测（2026-10-24）在 opencode-go/deepseek 路由上，
 * 老会话的模型会一直认为「没有发图工具」，连显式点名都不调用。只有重建会话
 * （新的基线 header）才拿得到。
 *
 * 所以每次发布**新增/改名模型侧工具**时改一下这个字符串：桥接发现某 QQ 会话的
 * `toolEpoch` 与它不一致，会在下一条消息时把该会话的 DSH 上下文自动重建一次
 * （旧会话归档，不删历史），让新工具进基线。它不是 skill 开关的版本——
 * 用户开关技能不应该重置任何人的上下文。
 */
export const TOOL_CAPABILITY_EPOCH = 'v0.5.1-2026-10-24-qq_send_image'
/**
 * 等桥接回执的上限（毫秒）。
 * 桥接要下网页图片 / 读本地文件 / base64 编码再交给 NapCat，20s 是 p2-contract §3.2 的约定。
 */
export const IMAGE_RECEIPT_TIMEOUT_MS = 20000

/**
 * 注册「发图片」工具（P2）。
 *
 * 与 qq_send_voice 同一条链路：工具只入队 `{op:'image', sessionId, url?|file?}`，
 * 真正的下载与发送在桥接进程（它才有 NapCat 的 WS 连接），等到回执再回答模型。
 *
 * @param {object} ctx guard 实例的 ctx（preset 作用域）
 */
function applyImageTool(ctx) {
  const tools = ctx.get?.('tools') ?? ctx.tools
  if (!tools || typeof tools.register !== 'function') {
    console.warn?.('[qq-guard] 找不到 tools 服务：qq_send_image 未注册')
    return
  }
  const register = () => {
    const definition = buildToolDefinition({
      name: IMAGE_TOOL_NAME,
      description: '把一张图片或表情包发到当前 QQ 聊天。url 与 file 二选一：'
        + 'url 给 http/https 图片地址（NapCat 自己下载），file 给本地绝对路径 / file:// / base64://；'
        + '两个都给时用 url。对方要图片或表情包时**直接调用本工具**，不要回答「没有发图工具」；'
        + '没有可用的图片地址就如实说「给我个图片链接」，不要编造。'
        + 'subType=1 时按表情发（QQ 里是小表情，可长按收藏），缺省按普通图片发。'
        + '**发送失败会抛错**（下载失败或 NapCat 拒收时），失败原因要如实告诉对方。'
        + '调用后**不要**在正文里复述「已发图」「已发表情包」或写方括号说明；'
        + '没有别的话要说就不用输出正文（图片会自动排在文字后面发出去）。',
      parameters: {
        url: {
          type: 'string',
          description: '图片的 http/https 地址（与 file 二选一；两个都给时用 url）。',
        },
        file: {
          type: 'string',
          description: '本地图片：绝对路径 / file:// / base64://（与 url 二选一）。',
        },
        subType: {
          type: 'number',
          description: '1 = 表情（QQ 里显示为小表情，可长按收藏），0 = 普通图片；'
            + '不传按普通图片发。只有确实是表情包时才用 1。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            queued: { type: 'boolean', required: true },
            sent: { type: 'boolean', required: true, description: '桥接是否真的把图片发到了 QQ。' },
            id: { type: 'string', required: true, description: '队列里的任务 id，排障用。' },
            detail: { type: 'string', required: true, description: '桥接回执原文（成功=发送摘要，失败=原因）。' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: (value?.sent === true
            ? `图片已处理：${String(value?.detail ?? '')}`
            : `图片没有发出去：${String(value?.detail ?? '')}`)
            + '（不要在正文里复述发图或写「[已发图]」这类说明。）',
        }],
      },
      execute: async (args, exec) => {
        const flags = readFeatureFlags()
        if (!flags.image) throw new Error('「发图片」技能未开启：请先在 QQ 桥接设置页的「技能与插件」里打开它。')
        if (args?.url !== undefined && typeof args.url !== 'string') throw new Error('url 必须是字符串')
        if (args?.file !== undefined && typeof args.file !== 'string') throw new Error('file 必须是字符串')
        // subType 只认 0 / 1；其它值（含字符串 "1"）直接拒，别把脏字段透给桥接。
        if (args?.subType !== undefined) {
          if (typeof args.subType !== 'number' || (args.subType !== 0 && args.subType !== 1)) {
            throw new Error('subType 只能是 0（普通图片）或 1（表情）')
          }
        }
        const subType = args?.subType === 0 || args?.subType === 1 ? args.subType : undefined
        const url = String(args?.url ?? '').trim()
        const file = String(args?.file ?? '').trim()
        // 契约：恰好给一个；两个都给用 url；都不给直接抛错（不要静默发空气）。
        if (url === '' && file === '') {
          throw new Error('url 与 file 必须给一个（url=http/https 图片地址，file=本地路径 / file:// / base64://）')
        }
        // sessionId 是桥接反查 QQ 会话的唯一凭据（同 qq_send_voice）。
        const sessionId = String(exec?.agent?.id ?? exec?.agent?.session?.id ?? '').trim()
        if (!sessionId) throw new Error('qq_send_image 只能在 QQ 会话内调用（拿不到 sessionId）')
        const id = enqueueSessionOp('image', '', '', {
          sessionId,
          ...(url !== '' ? { url } : { file }),
          // subType 缺省时不带这个字段：老桥接不认识它也不受影响。
          ...(subType !== undefined ? { subType } : {}),
        })
        // ★ 等桥接回执：下载失败 / NapCat 拒收时把真实原因抛给模型，别假装发出去了。
        let receipt
        try {
          receipt = await waitForOpResult(id, IMAGE_RECEIPT_TIMEOUT_MS)
        } catch (error) {
          throw new Error(`图片没有发出去：${error?.message ?? error}`)
        }
        if (!receipt.ok) {
          throw new Error(`图片发送失败：${receipt.detail || '桥接没有给出原因'}`)
        }
        return {
          queued: true,
          sent: true,
          id,
          detail: receipt.detail || '桥接已发送',
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: '发送 QQ 图片',
        kind: 'other',
        rawInput: {
          ...(String(args?.url ?? '').trim() !== '' ? { url: String(args.url).trim() } : {}),
          ...(String(args?.file ?? '').trim() !== '' ? { file: String(args.file).trim() } : {}),
        },
      }),
      presentResult: (args, result) => ({
        card: 'generic',
        title: result?.sent === true ? 'QQ 图片已发送' : 'QQ 图片未发送',
        content: [{
          type: 'text',
          text: result?.sent === true
            ? `已发送：${String(result?.detail ?? '')}`
            : `未发送：${String(result?.detail ?? '无原因')}`,
        }],
      }),
    })
    const registered = tools.register(definition)
    console.info?.(`[qq-guard] qq_send_image 已注册（${voiceToolDefinitionSource()}）`)
    return registered
  }
  if (typeof ctx.effect === 'function') ctx.effect(register, 'qq-guard: qq_send_image tool')
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
 * 表情图孤儿清理的「每 ctx 只跑一次」标记。
 *
 * 为什么不能每次 applySettings 都扫：配置保存会热重载本 entry，
 * 反复 `readdir + stat` 一整目录没必要，而且没必要在用户每次改设置时都扫盘。
 */
const POKE_IMAGE_CLEANED = new WeakSet()

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
            // 工具能力版本（v0.5.1）：新工具/新 skill 上线时改这里。
            // 桥接据此判断「旧会话的工具基线是不是该重建了」——
            // DSH 的会话会把首次 request/header 冻成工具基线，之后新增的工具
            // 只能走 tool-addition 增量，老会话里模型可能一直拿不到新工具。
            toolEpoch: TOOL_CAPABILITY_EPOCH,
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

  // ── 戳一戳表情图：上传落盘 + 回读预览（2026-10-27）──────────────
  //
  // 前端把 File 直接 POST 成二进制（不走 base64），Host 校验魔数后写盘，
  // 配置里只存返回的绝对路径。理由见 POKE_IMAGE_DIR 上方那段注释。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: POKE_IMAGE_ROUTE_PATH,
      handler: (req, res) => {
        handlePokeImageRoute(req, res).catch((error) => {
          sendJson(res, error?.statusCode ?? 500, { ok: false, reason: error?.message ?? String(error) })
        })
      },
    }),
    'qq-guard: poke image route',
  )
  // 启动后清一次「没被任何回复引用」的旧图。延迟 5 秒，别跟启动抢 IO；
  // 用 WeakSet 标记，配置热重载会重复调 applySettings，不能每次都扫盘。
  if (!POKE_IMAGE_CLEANED.has(ctx)) {
    POKE_IMAGE_CLEANED.add(ctx)
    const timer = setTimeout(() => {
      void cleanupOrphanPokeImages(config)
        .then((r) => {
          if (r?.removed > 0) ctx.logger?.info?.(`戳一戳表情图清理：删除 ${r.removed} 个未引用的旧文件`)
        })
        .catch(() => { /* 清理失败不影响任何功能 */ })
    }, 5000)
    if (typeof timer.unref === 'function') timer.unref()
  }

  // ── 人设归纳（每小时动态人设）：桥接 POST 群聊记录，Host 侧调模型归纳 ──────
  //
  // 桥接是独立进程，调不到 ctx.llm；归纳又必须用真实模型。所以由 Host 代劳：
  // 实现与校验都在 persona-summary.js（协议见规格 §3），这里只负责挂路由。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: SUMMARIZE_ROUTE_PATH,
      handler: (req, res) => handlePersonaSummarizeRoute(ctx, config, req, res, ctx.logger ?? console),
    }),
    'qq-guard: persona summarize route',
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
              // 语音/图片任务没有 QQ 会话 key（由 guard 工具按 sessionId 入队），
              // 桥接用 sessionId 反查 state.sessions；voice 可覆盖音色。
              ...(op.sessionId ? { sessionId: op.sessionId } : {}),
              ...(op.voice ? { voice: op.voice } : {}),
              // P2 图片：url / file 二选一（桥接 _applyImageOp 原样取用）。
              ...(op.url ? { url: op.url } : {}),
              ...(op.file ? { file: op.file } : {}),
              // 图片呈现形态（2026-10-26）：0 / 1 是明确语义，0 也要下发，故不能按 truthy 判。
              ...(op.subType === 0 || op.subType === 1 ? { subType: op.subType } : {}),
              // 单群响应档位：null 也要下发（null = 跟随全局，是明确的语义，不是缺省）。
              ...(op.level === undefined ? {} : { level: op.level }),
              // v2.0 第十步：动态记忆编辑字段原样透传给桥接。
              ...(op.core === undefined ? {} : { core: op.core }),
              ...(op.slang === undefined ? {} : { slang: op.slang }),
              ...(op.personaOverride === undefined ? {} : { personaOverride: op.personaOverride }),
              ...(op.removeProfile ? { removeProfile: op.removeProfile } : {}),
              // v2.0 第十八步：L2 摘要重置标记（text 走通用 text 字段）。
              ...(op.reset === true ? { reset: true } : {}),
              ...(typeof op.id === 'string' && op.id !== '' ? { id: op.id } : {}),
              ...(typeof op.field === 'string' && op.field !== '' ? { field: op.field } : {}),
              ...(typeof op.file === 'string' && op.file !== '' ? { file: op.file } : {}),
              ...(typeof op.qq === 'string' && op.qq !== '' ? { qq: op.qq } : {}),
              ...(typeof op.mode === 'string' && op.mode !== '' ? { mode: op.mode } : {}),
              ...(op.enabled === true ? { enabled: true } : {}),
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
        // summarize（v2.0）：设置页「记忆与摘要」的快捷按钮，由桥接按群 key 触发归纳。
        // manual-summarize（v2.0 第五步）：同一位置的「提前截断」按钮，
        // 桥接侧会生成前情提要 → 归档旧会话 → 新建同名会话。
        // 两者都不是 QQ 消息，桥接侧标 origin=console，**不冒充主人**（权限仍只认事件 QQ 号）。
        if (!['clear', 'delete', 'persona', 'activity', 'summarize', 'manual-summarize', 'dynamic', 'briefing',
          'global-memory', 'task', 'forget', 'undo-forget', 'restore-backup', 'user-blacklist',
          'proactive'].includes(op)) {
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
        // v2.0 第十步：动态记忆编辑。core 三段 / slang 字符串数组 / removeProfile（QQ）。
        const extra = op === 'activity' ? { level } : {}
        if (op === 'dynamic') {
          if (body?.core && typeof body.core === 'object' && !Array.isArray(body.core)) {
            const line = (value) => (typeof value === 'string' ? value.slice(0, 4000) : '')
            extra.core = {
              identity: line(body.core.identity),
              boundary: line(body.core.boundary),
              style: line(body.core.style),
            }
          }
          if (Array.isArray(body?.slang)) {
            // v2.0 第十一步：对象数组（term/meaning/reply/image/allowSearch），交给 Host 统一收敛。
            extra.slang = sanitizeSlang(body.slang)
          }
          if (typeof body?.removeProfile === 'string' && /^\d{1,20}$/u.test(body.removeProfile.trim())) {
            extra.removeProfile = body.removeProfile.trim()
          }
          // v2.0 第十二步：单群人设覆盖。null / '' / 空对象 = 删除覆盖（重新继承全局）。
          if (body?.personaOverride !== undefined) {
            extra.personaOverride = (body.personaOverride === null || body.personaOverride === '')
              ? null
              : sanitizePersonaOverride(body.personaOverride)
          }
        }
        // v2.0 第十八步：L2 摘要重置（不传 text 时恢复自动生成的原文）。
        if (op === 'briefing' && body?.reset === true) extra.reset = true
        // v2.0 第二十四步：删除跨群记忆 / 定时任务，只接受明确 id。
        if (op === 'global-memory' || op === 'task') {
          const id = typeof body?.id === 'string' ? body.id.trim().slice(0, 80) : ''
          if (id === '') {
            sendJson(res, 400, { ok: false, reason: 'id required' })
            return
          }
          extra.id = id
        }
        // v2.0 第二十七步：单群群友黑名单增删。
        if (op === 'user-blacklist') {
          const qq = typeof body?.qq === 'string' ? body.qq.trim() : ''
          if (!/^\d{5,15}$/u.test(qq)) {
            sendJson(res, 400, { ok: false, reason: 'bad-qq' })
            return
          }
          extra.qq = qq
          extra.mode = body?.mode === 'remove' ? 'remove' : 'add'
        }
        // v2.0 第二十九步：单群主动感知授权。
        if (op === 'proactive') extra.enabled = body?.enabled === true
        // v2.0 第二十六步：记忆治理。
        if (op === 'forget') {
          const field = typeof body?.field === 'string' ? body.field.trim().slice(0, 40) : ''
          if (field === '') {
            sendJson(res, 400, { ok: false, reason: 'field required' })
            return
          }
          extra.field = field
        }
        if (op === 'undo-forget') {
          const id = typeof body?.id === 'string' ? body.id.trim().slice(0, 80) : ''
          if (id !== '') extra.id = id
        }
        if (op === 'restore-backup') {
          const file = typeof body?.file === 'string' ? body.file.trim().slice(0, 80) : ''
          if (!/^backup-\d{8}-\d{6}\.json\.gz$/u.test(file)) {
            sendJson(res, 400, { ok: false, reason: 'bad-backup-file' })
            return
          }
          extra.file = file
        }
        const id = enqueueSessionOp(
          op, key,
          op === 'persona' || op === 'briefing' ? text : '',
          extra,
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

  // ── 打开操作日志目录（v2.0 第六步，2026-10-28）────────────────
  //
  // 为什么走 Host 而不是桥接：浏览器点按钮时 Host 就在本机；桥接是另一个进程，
  // 为一次「打开文件夹」再排一轮 2 秒轮询不值当。
  // 安全边界：不吃路径参数，只打开配置里的 logDir（或默认 state/logs）；
  // execFile 用数组参数、不经 shell，避免把用户填的路径拼成命令。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: OPEN_LOG_DIR_ROUTE_PATH,
      handler: async (req, res) => {
        const fetchSite = req.headers['sec-fetch-site']
        if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
          sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, reason: 'method not allowed' })
          return
        }
        const cfg = plainConfig(config) ?? {}
        const dir = resolveLogDir(cfg, cfg.bridge?.dir || DEFAULT_BRIDGE_DIR)
        try {
          mkdirSync(dir, { recursive: true })
        } catch (error) {
          sendJson(res, 500, { ok: false, reason: 'mkdir-failed', dir, detail: error?.message ?? String(error) })
          return
        }
        const failure = await openInFileManager(dir)
        if (failure) {
          sendJson(res, 500, { ok: false, reason: 'open-failed', dir, detail: failure.message })
          return
        }
        sendJson(res, 200, { ok: true, dir })
      },
    }),
    'qq-guard: open log dir route',
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
        // P2 常驻触发点之一：打开扫描页时顺带确保一次（配置里 enabled 非空才有动作，
        // TTL 内不重复扫描，所以不影响这条只读路由的响应速度）。
        void ensureResident().catch(() => {})
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

  const sandbox = (sandboxFactoryOverride !== null || ctx.subprocess !== undefined)
    ? createSandboxManager({
      subprocess: ctx.subprocess,
      logger: ctx.logger ?? console,
      getRoots: readExternalRoots,
    })
    : null
  if (sandbox !== null) {
    // P2：管理器归 settings 实例所有，guard 实例通过模块级引用调 invoke。
    // 换了实例（配置保存 → 热重载 → 新沙箱）时清空 loaded，逼下一次 ensure 重新加载。
    if (externalRuntime.manager !== sandbox) {
      externalRuntime.manager = sandbox
      externalRuntime.loaded = []
      externalRuntime.updatedAt = 0
      externalRuntime.signature = ''
    }
    ctx.effect(() => () => {
      void sandbox.dispose?.()
      if (externalRuntime.manager === sandbox) externalRuntime.manager = null
    }, 'qq-guard: sandbox teardown')
  }

  /**
   * 外部插件常驻（P2 / p2-contract §4.1）。
   *
   * `externalPlugins.enabled` 非空时确保沙箱起来，并把每个「已启用 + 自包含 + 有入口」
   * 的插件 load 一次；失败只记日志（连续失败熔断沿用 SandboxManager）。
   * 同一份配置在 {@link EXTERNAL_RESIDENT_TTL_MS} 内不重复扫描（hook 每条消息都会问一次）。
   *
   * @returns {Promise<object>} {@link externalRuntimeSnapshot} 的结果
   */
  const ensureResident = async () => {
    if (sandbox === null) return externalRuntimeSnapshot()
    const cfg = plainConfig(config) ?? {}
    const enabled = asStringArray(cfg.externalPlugins?.enabled)
    if (enabled.length === 0) {
      // 全关 = 没有常驻插件：清空快照，代理工具 execute 会据此拒绝。
      if (externalRuntime.loaded.length > 0) {
        externalRuntime.loaded = []
        externalRuntime.updatedAt = Date.now()
      }
      externalRuntime.signature = ''
      return externalRuntimeSnapshot()
    }

    const signature = enabled.join('\n')
    const managerState = externalRuntime.manager?.state
    const managerAlive = externalRuntime.manager?.alive === true || managerState === 'ready'
    if (externalRuntime.signature === signature
      && externalRuntime.updatedAt > 0
      && Date.now() - externalRuntime.updatedAt < EXTERNAL_RESIDENT_TTL_MS
      && managerAlive) {
      return externalRuntimeSnapshot()
    }
    if (externalRuntime.ensuring) return externalRuntime.ensuring

    externalRuntime.ensuring = (async () => {
      const loadedPlugins = []
      try {
        await sandbox.ensure()
      } catch (error) {
        console.warn?.(`[qq-guard] 外部插件沙箱启动失败（本轮跳过加载）：${error?.message ?? error}`)
        externalRuntime.signature = ''
        return externalRuntimeSnapshot()
      }
      for (const id of enabled) {
        const module = findExternalModule({ id })
        if (module === null) {
          console.warn?.(`[qq-guard] 外部插件未找到（跳过）：${id}`)
          continue
        }
        if (!module.hasEntry || module.compat?.tier !== 'self-contained') {
          console.warn?.(`[qq-guard] 外部插件不可自动加载（只允许自包含且有入口）：${module.id}`)
          continue
        }
        const entryPath = path.resolve(module.dir, module.entry || 'index.js')
        const outcome = await sandbox.testLoad({
          id: module.id,
          dir: module.dir,
          entryPath,
          format: module.format,
        })
        if (!outcome.ok) {
          console.warn?.(`[qq-guard] 外部插件加载失败（${module.id}）：`
            + `${outcome.error?.code ?? '?'} ${outcome.error?.message ?? ''}`)
          continue
        }
        const result = outcome.result ?? {}
        const hooks = Array.isArray(result.exports?.hooks)
          ? result.exports.hooks.map((name) => String(name))
          : []
        const tools = Array.isArray(result.tools)
          ? result.tools
            .filter((tool) => tool && tool.id)
            .map((tool) => ({
              id: String(tool.id),
              name: String(tool.name ?? tool.id),
              description: String(tool.description ?? ''),
              parameters: tool.parameters,
            }))
          : []
        loadedPlugins.push({
          id: module.id,
          name: module.name ?? module.id,
          moduleId: String(result.moduleId ?? module.id),
          hooks,
          tools,
        })
      }
      externalRuntime.loaded = loadedPlugins
      externalRuntime.signature = signature
      externalRuntime.updatedAt = Date.now()
      // 通知 guard 实例重注册代理工具（按 moduleId+toolId 幂等跳过已注册的）。
      for (const applier of [...externalRuntime.appliers]) {
        try { applier() } catch (error) {
          console.warn?.(`[qq-guard] 外部工具代理刷新失败：${error?.message ?? error}`)
        }
      }
      return externalRuntimeSnapshot()
    })().finally(() => { externalRuntime.ensuring = null })
    return externalRuntime.ensuring
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

  // ── 外部插件 hook（P2）──────────────────────────────────────────
  //
  // 桥接每条消息会打两次：`message`（白名单通过、入队之前）与 `before-context`
  // （拼 prompt 之前）。**这条路由永远 best-effort**：没有沙箱 / 没有启用插件 /
  // 插件没声明对应 hook 都返回 `{ ok:true, modules:[], latencyMs }`，插件抛错只 warn
  // 一次，绝不把聊天主链路拖死。
  let hooksWarned = false
  const warnHookOnce = (message) => {
    if (hooksWarned) return
    hooksWarned = true
    console.warn?.(`[qq-guard] 外部插件 hook 失败（只提示一次）：${message}`)
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: EXTERNAL_HOOK_ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const fetchSite = req.headers['sec-fetch-site']
          if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
            sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
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
          const event = typeof body?.event === 'string' ? body.event : ''
          if (EXTERNAL_HOOK_ALIASES[event] === undefined) {
            sendJson(res, 400, {
              ok: false,
              reason: 'bad-event',
              detail: `event 只支持 message / before-context，收到 ${event || '(空)'}`,
            })
            return
          }

          const startedAt = Date.now()
          // 收到 hook 之前先把常驻沙箱准备好（幂等 + 单飞 + TTL；失败只记日志）。
          try { await ensureResident() } catch { /* ensureResident 内部已兜住 */ }
          // 预算从「沙箱已就绪」开始算（终验修）：冷启动 / 刚启用插件时 warmup 可能
          // 吃掉全部 2s，导致本次回 modules:[]，而桥接会把「空」记 30s 负缓存 ——
          // 表现就是「插件刚开，最长约 30s 不生效」。
          const budgetStartedAt = Date.now()
          const eventPayload = sanitizeExternalHookEvent(body)
          const manager = externalRuntime.manager
          const modules = []
          let drop
          let text
          let sections
          if (manager && typeof manager.invoke === 'function') {
            const deadline = budgetStartedAt + EXTERNAL_HOOK_BUDGET_MS
            for (const plugin of externalRuntime.loaded) {
              if (!externalPluginHasHook(plugin, event)) continue
              const remaining = deadline - Date.now()
              if (remaining <= 0) break
              const timeoutMs = Math.min(EXTERNAL_HOOK_TIMEOUT_MS, remaining)
              try {
                const outcome = await manager.invoke({
                  moduleId: plugin.moduleId,
                  kind: 'hook',
                  name: event,
                  event: eventPayload,
                }, { timeoutMs })
                if (outcome?.found === false) continue
                const merged = normalizeExternalHookResult(outcome?.value)
                modules.push(plugin.id)
                if (merged.drop === true) drop = true
                if (typeof merged.text === 'string' && merged.text !== '') text = merged.text
                if (Array.isArray(merged.sections) && merged.sections.length > 0) {
                  sections = [...(sections ?? []), ...merged.sections]
                }
              } catch (error) {
                warnHookOnce(`${plugin.id}/${event}：${error?.message ?? error}`)
              }
            }
          }
          sendJson(res, 200, {
            ok: true,
            ...(drop === true ? { drop: true } : {}),
            ...(typeof text === 'string' ? { text } : {}),
            ...(sections && sections.length > 0 ? { sections } : {}),
            modules,
            latencyMs: Date.now() - startedAt,
          })
        } catch (error) {
          // 绝不能 500：桥接把 5xx 当「hook 坏了」，虽然它会兜住，但没必要制造噪声。
          sendJson(res, 200, { ok: false, reason: 'hook-failed', detail: error?.message ?? String(error) })
        }
      },
    }),
    'qq-guard: external hook route',
  )

  // ── 外部插件常驻快照（P2）───────────────────────────────────────
  //
  // 供面板 / 排障查看：沙箱是否常驻、加载了哪些插件、每个插件声明了哪些 hook / 工具。
  // 顺带触发一次 ensureResident，保证打开面板时看到的不是「还没加载」的空快照。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: EXTERNAL_RUNTIME_ROUTE_PATH,
      handler: async (req, res) => {
        const fetchSite = req.headers['sec-fetch-site']
        if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
          sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, reason: 'method not allowed' })
          return
        }
        try { await ensureResident() } catch { /* ensureResident 内部已兜住 */ }
        sendJson(res, 200, externalRuntimeSnapshot())
      },
    }),
    'qq-guard: external runtime route',
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
              // 一键重启（v2.0 第七步）：底层串起来，避免前端 stop → start 撞竞态。
              : action === 'restart'
                ? runner.stop().then(() => runner.start({ manual: true }))
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
        // 128KB（v2.0）：除了 5 个进程级计数与会话列表，现在还带「最近入站消息」明细
        // （桥接只给最近活跃的 12 个会话带，单条 200 字内）。100 个会话的基础行约 25KB，
        // 明细部分约 30KB，128KB 留一倍余量。超过即拒绝，绝不无限收。
        const chunks = []
        let size = 0
        let aborted = false
        req.on('data', (c) => {
          size += c.length
          if (size > 131072) { aborted = true; try { req.destroy() } catch { /* 已断开就忽略 */ } return }
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
              // 操作日志（v2.0 第六步）：同样按白名单收敛，最多 50 条。
              ...(Array.isArray(body?.opLog)
                ? { opLog: body.opLog.slice(-50).map(sanitizeOpLogRow).filter(Boolean) }
                : {}),
              // 接入总闸 + 实际连接地址（v2.0 第七步，系统日志 → 高级面板）。
              ...(typeof body?.enabled === 'boolean' ? { enabled: body.enabled } : {}),
              ...(typeof body?.dshBaseUrl === 'string'
                ? { dshBaseUrl: body.dshBaseUrl.slice(0, 200) }
                : {}),
              ...(typeof body?.wsUrl === 'string' ? { wsUrl: body.wsUrl.slice(0, 200) } : {}),
              // v2.0 第二十四步：跨群记忆 / 定时任务列表（只读展示与删除用）。
              ...(Array.isArray(body?.globalMemory)
                ? { globalMemory: body.globalMemory.slice(0, 50).map(sanitizeGlobalMemoryRow).filter(Boolean) }
                : {}),
              ...(Array.isArray(body?.tasks)
                ? { tasks: body.tasks.slice(0, 50).map(sanitizeTaskRow).filter(Boolean) }
                : {}),
              // v2.0 第二十六步：记忆备份列表（恢复用），最多 7 条。
              ...(Array.isArray(body?.backups)
                ? { backups: body.backups.slice(0, 7).map(sanitizeBackupRow).filter(Boolean) }
                : {}),
              // v2.0 第二十八步：主动感知视图（tick 状态 / 决策 / 冷却）。
              ...(body?.presence && typeof body.presence === 'object'
                ? { presence: sanitizePresence(body.presence) }
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

  // P2：配置装载完成后拉一次外部插件常驻（异步，失败只记日志）。
  // 配置保存 → DSH 热重载 → 这里再跑一次，代理工具跟着刷新（TTL 内不重复扫描）。
  void ensureResident().catch(() => {})
}

/** 供对账脚本使用：确认名单与 DSH 真实工具名不漂移。 */
export const DENIED_TOOL_NAMES = Object.freeze([...DENY_TOOLS])
export const SAFE_TOOL_NAMES = Object.freeze([...SAFE_EXACT])
/** 会话行白名单收敛（导出仅为测试：漏字段是静默 bug，必须有断言盯着）。 */
export { sanitizeSessionRow }
/** 主动感知视图白名单收敛（导出仅为测试）。 */
export { sanitizePresence }
export { Config }
