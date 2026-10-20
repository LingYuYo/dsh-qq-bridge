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
import { NapcatManager, DEFAULT_WS_PORT } from './napcat.mjs'
import { BridgeRunner } from './bridge-runner.mjs'

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
    short: Schema.number().description('<10 字档的基准延时(ms)').default(200).min(0).max(60000).volatile(),
    medium: Schema.number().description('10~14 字档的基准延时(ms)').default(450).min(0).max(60000).volatile(),
    long: Schema.number().description('15+ 字档的基准延时(ms)').default(800).min(0).max(60000).volatile(),
  }).description('分级打字延时的三档基准值').default({}),
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
  personaPresetDefault: Schema.string()
    .description('当前 preset 的默认人设（只读快照，供 UI 的「恢复默认」按钮参考）。')
    .default('').volatile(),

  // ── 白名单（批次 4A-UI）──────────────────────────────────────
  // 桥接每处理一条消息都从热配置现读，改完下一条即生效。
  allow: Schema.object({
    private: Schema.array(Schema.string())
      .description('允许的私聊 QQ 号。留空且 allowAllWhenEmpty=false 时谁都不理。')
      .default([]).volatile(),
    groups: Schema.array(Schema.string())
      .description('允许的群号。')
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
}).description('QQ 桥接运行时参数：改完即时生效（桥接轮询本插件的 /dsh-qq-guard/config）。')

/** 路由路径：桥接据此拉配置。 */
const CONFIG_ROUTE_PATH = '/dsh-qq-guard/config'
/** 路由路径：桥接回推运行状态。 */
const STATUS_ROUTE_PATH = '/dsh-qq-guard/status'
/** 路由路径：NapCat 进程启停与状态（批次 4B）。 */
const NAPCAT_ROUTE_PATH = '/dsh-qq-guard/napcat'
/** 路由路径：桥接进程启停与状态（批次 4B 补充）。 */
const BRIDGE_ROUTE_PATH = '/dsh-qq-guard/bridge'

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
    applyGuard(ctx)
    return
  }
  if (role === 'settings') {
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
 * 工具门禁：**只能在 preset 作用域里跑**。
 *
 * 为什么必须校验：`ctx.tools.guard` 在 plain context 上是**全局**的
 * （Service 契约："a plain-context guard applies globally"），挂到 profile 顶层
 * 会把浏览器会话一起锁死——2026-10-20 就是这么炸的。
 *
 * 判定依据：`agentPresets.composedPreset(ctx)` 返回 ctx 所属的 preset id，
 * 顶层 ctx 没有 generation → 返回 undefined。
 * （证据：dsh-agent-preset-registry/lib/types/index.js:326
 *   `composedPreset(ctx) { return this.generationFor(ctx)?.mount.presetId; }`）
 */
function applyGuard(ctx) {
  const agentPresets = ctx.get?.('agentPresets')
  const presetId = agentPresets?.composedPreset?.(ctx)

  if (presetId === undefined) {
    // 顶层 / 非 preset 作用域：坚决不挂 guard。
    console.warn?.(
      '[qq-guard] role=guard 但当前不在任何 agent preset 作用域内（composedPreset 返回 undefined）；'
      + '已拒绝装载 tools.guard，避免它全局生效锁死整个 profile。'
      + '请把这条行放到 preset 的 plugins[] 子级里。',
    )
    return
  }

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
    if (SAFE_EXACT.has(toolName)) return undefined
    if (SAFE_PREFIXES.some((prefix) => toolName.startsWith(prefix))) return undefined
    return `工具 "${toolName}" 不在 QQ 会话白名单内，已拒绝（QQ 聊天会话无本地执行能力）`
  })
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
 * 桥接运行时配置（profile 顶层行）。
 * 只在有 webServer 的顶层 ctx 上跑：注册只读配置路由 + 声明自管设置页。
 */
function applySettings(ctx, config) {
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
        sendJson(res, 200, { ok: true, config: plainConfig(config) })
      },
    }),
    'qq-guard: bridge runtime config route',
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
        const chunks = []
        let size = 0
        let aborted = false
        req.on('data', (c) => {
          size += c.length
          if (size > 8192) { aborted = true; try { req.destroy() } catch { /* 已断开就忽略 */ } return }
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
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, settingsCtx.fiber),
      'qq-guard: settings page policy',
    )
  })
}

/** 供对账脚本使用：确认名单与 DSH 真实工具名不漂移。 */
export const DENIED_TOOL_NAMES = Object.freeze([...DENY_TOOLS])
export const SAFE_TOOL_NAMES = Object.freeze([...SAFE_EXACT])
export { Config }
