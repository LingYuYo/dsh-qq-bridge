# @local/dsh-qq-guard

DSH 插件：给 QQ 聊天会话装一道**执行期工具门禁**，并提供 QQ 桥接的运行时参数设置页与进程管理。

配套的桥接进程在 [`../../qq-bridge/`](../../qq-bridge/)，两个要一起用。

## 为什么需要它

DSH 的 `agentPreset` **不隔断全局工具**。2026-10-20 实测：profile 里全局挂载的 bundle（dsh-ops / dsh-mnemon / agent-team）会把工具**穿透**进每个会话 —— 一个 `minimal` preset 的会话实际拿到 **35 个工具**，含 `ops_bash`、`pwsh`、`spawn_teammate`；而且 `minimal` 在 Windows 上还**启用**了 `terminal-pwsh` / `persistent-pwsh`。

也就是说：**只选 preset 挡不住本地执行能力**。QQ 那头连的是真人，必须有硬边界。

## 两层防护

| 层 | 机制 | 覆盖范围 |
| --- | --- | --- |
| schema 隐藏 | `tools.restrict()` | 该作用域**继承来的**工具（含全局层） |
| 执行期拦截 | `tools.guard()`（deny-by-default 白名单） | 所有调用，含 agent-scope 工具 |

诚实版结论：**schema 隐藏能覆盖全局层工具，agent-scope 工具只能靠 guard 拦**。两层都要有。

## 装载位置（这里踩过两次坑，务必先读）

`cordis.patch.yml` 插了**两个** entry，职责不同：

1. **`role: guard`，装在 `qq-chat` preset 的子行里**
   - `tools.guard` 在 plain context 下是**全局**的。装在 profile 顶层会把浏览器里你自己的会话一起管死 —— 2026-10-20 真实发生过：`role` 未声明走了兼容分支，顶层实例装了 `tools.guard`，整个 profile 每个会话的工具全被拒，只能手改 yaml + 重启。
   - 所以守卫必须作为 preset 的子行装载，`ctx` 才是该 preset 的作用域。
2. **`role: settings`，装在 profile 顶层**
   - `dsh-settings` 只投影 **profile 顶层条目**的 Config（`settings.describe()` 遍历 `configEditor.entries()`），preset 子行不在这个集合里 → 设置页看不到。
   - 这条路由需要 `webServer`，preset 子行的 ctx 作用域拿不到它。

两个 role 是同一份代码、不同实例。`role` 未声明会走兼容分支（等于旧行为），所以**别删这个字段**。

### restrict 必须重扫

第一版只在 `apply()` 里跑一遍 `tools.restrict()` 并 `catch {}` 静默吞错，结果**部分失效**。原因是 `restrict()` 对当下未注册的名字会抛错（`restrict() names unknown global tool …`），而 preset 子树装载时那些工具还没注册。

现在改成：初次扫一遍 + 监听 `tools/change` 持续重扫（只对尚未成功 deny 的名字重试）。

## 设置页

profile 顶层实例持有配置，投影到「设置 → QQ 桥接」。左侧导航为五个主 Tab：

| Tab | 内容 | 数据来源 |
| --- | --- | --- |
| 运行状态 | 桥接状态 / 启停 / 日志、NapCat 进程状态与启停、今日用量概览卡、AI 排障助手输入框 | 状态与启停走真实路由；用量卡与 AI 框为 **Mock 壳** |
| 会话管理 | 左会话列表（含未读红点）+ 右详情（单人设覆盖 / 单独白名单 / 记忆提取 / 删除会话）+ `清理失效会话` | 列表 **Mock**；清理按钮走 **真实 Host 路由** |
| 技能与插件 | Skill / Plugin / 外部插件 三组卡片，外部插件带兼容标签与 `[测试运行]`，含版本号、齿轮、垃圾桶、拖拽手柄、上下移 | **全部真实配置读写**；沙箱测试走真实 Host 路由 |
| 全局设置 | 运行节奏（两个大按钮 → 信息发送配置 / 活跃设置 弹窗）、人设概览卡（编辑收进弹窗）、白名单、OneBot、NapCat | **全部真实配置读写** |
| 数据与用量 | 纯 CSS 柱状图 + 面积图，按天 / 按模型 / 按插件三张表 | **全部 Mock** |

### Phase 4：技能与插件接真实配置

清单不再写死在前端，而是配置本身：

- `skills` / `plugins` 是**对象数组**（`id/name/icon/tag/ver/desc/enabled`），数组顺序 = 展示顺序，
  `enabled` = 开关。拖拽排序、上下移、开关、删除、添加全部走 `form.mutate` 写回 profile 配置；
  前端不再维护第二份状态（`get('skills')` 读什么就渲染什么）。
- **外部插件挂载**：`externalPlugins.dirs` 是扫描目录（留空时自动定位当前 profile 的 `node_modules`——
  判据是该目录里装了 `@local/dsh-qq-guard`）。`GET /dsh-qq-guard/external-plugins` **只读**扫描三种有效形态：
  - `package.json` 里带 `dsh` 字段的 DSH 原生包；
  - QQ Agent 的 `plugin.json` / `skill.json`（`skill.json` 优先，清单允许 UTF-8 BOM）。

  扫描支持平铺目录、`node_modules` 作用域包，以及 QQ Agent 应用根（`<root>/plugins/*`、`<root>/skills/*`）；
  跳过 `@local/*` 和符号链接/junction（本地 `link:` 开发插件不算外部）。
  元数据按规范白名单解析（`id/name/version/category/description/author/requires/...`），
  `settingsUi`/`intercept`/`commands`/`tools` 这类非标字段丢弃，只记在卡片的「已忽略 N 个非标字段」里。
  静态扫描代码依赖给出兼容标签：命中 Node 原生模块、宿主内部引用（`../../src/*`）或裸 npm 包 →
  **只读/受控**；否则标「自包含」；清单坏掉的出红卡（`清单无效`）而不是消失。
  `externalPlugins.enabled` 记录被打开的插件 id，**默认为空 = 全关**。P0 只展示卡片，不加载、不执行任何外部代码。

### P1：外部插件沙箱加载基础链路

自包含卡片上新增 `[测试运行]` 按钮，把模块交给**独立 Node 子进程**加载并执行 `setup(api)`，
结果在弹窗里展示（入口导出、hooks、插件调用过的 api、耗时、沙箱 pid/node）；失败展示稳定错误码。

- 子进程由 `ctx.subprocess.spawn` 拉起，参数带 `--permission`、`--allow-fs-read=<沙箱目录>`、
  `--allow-fs-read=<外部根>`、`--disallow-code-generation-from-strings`；默认**没有写权限、没有子进程权限**。
- 子进程入口 `sandbox/child.mjs` 用 `module.registerHooks` 拦 `node:fs` / `node:child_process` /
  `node:net` / `node:vm` / `node:module` 等危险内置模块；相对引用必须留在**当前模块目录**内
  （`../../src/*` 这类宿主内部引用直接 `E_BLOCKED_IMPORT`）。
- Host `sandbox/manager.mjs` 维护 NDJSON 协议（`sandbox/protocol.mjs`）：ready 握手 5s、单请求 5s、
  超时立即杀进程；连续 5 次失败对模块熔断 5 分钟（`E_CIRCUIT_OPEN`）。同一时刻只允许一个在途请求（`E_BUSY`）。
- 路由 `POST /dsh-qq-guard/external-plugins/test` 只收 `{ id, dir }`，会**重新扫描**配置的根目录定位模块，
  只放行 `self-contained` 且有入口的模块，并对入口做 realpath 越界校验；所有外部代码都不进 DSH 主进程。
- node 来源：`QQG_SANDBOX_NODE` 环境变量 → `ctx.subprocess.resolveExecutable('node')` →
  DSH 自带 runtime → Electron `ELECTRON_RUN_AS_NODE` 兜底。

### P1.5：外部插件卡片收尾

- 描述统一去换行、最多 30 个字符（按 Unicode 码点），超出加省略号；完整描述放在 `title`。
- 新增过滤下拉：`全部 / 自包含 / 受控`（坏清单只在「全部」里出现）。
- 有 `configSchema` 的卡片出现齿轮：按 `boolean / number / string / enum` 动态渲染表单，
  保存到 `externalPlugins.settings[模块 id]`（本插件自己的配置，**不写对方目录**）。
  `action` / `internal` 这类非配置项在 Host 扫描阶段就被丢弃；默认值取清单 `settings` + schema `default`。

### P1.5：人设设置重构

- 「全局设置 → 人设配置」改成**只读概览卡**：机器人名字 / 群内展示名 / 参与度 /
  角色设定前两行；编辑入口收进 `[⚙️ 编辑人设]` 弹窗。
- 弹窗字段：人设下拉（默认人设 + 自定义列表）、`+ 添加人设`、`删除当前自定义人设`、
  机器人名字、群内展示名、参与度（安静型 / 普通群友 / 活跃型）、角色设定、
  管理员附加规则（追加到系统提示）、系统提示词覆盖（留空=内置）。改动点「保存」才写配置。
- 桥接层 `bridge.mjs` 的 `composePersonaPrompt()` 负责拼最终系统提示词：
  `personaSystemPrompt` 覆盖优先 → 角色设定或 preset 默认人设 → 名字替换 + 身份行 →
  参与度规则 → 管理员附加规则。全空时返回空串，删除 preset 覆盖、回落到内置人设。
- `runtime-config.mjs` 对任一 persona 字段变化都会触发重写（不再只盯 `personaText`），
  首次同步只记录不写盘，避免每次启动都改 profile。

### Phase 4：运行节奏接真实字段

`rhythm.*` 是新增的配置段，桥接每 2 秒轮询 `/dsh-qq-guard/config` 拿它：

| 字段 | 含义 | 默认 |
| --- | --- | --- |
| `activityLevel` | 0 仅艾特/私聊 · 1 +关键词 · 2 +随机 · 3 全响应 | 1 |
| `debounceWindowMs` | 同一会话连续消息的防抖合并窗口 | 800 |
| `batchIntervalMs` | 一轮回复多气泡之间的最小间隔 | 2500 |
| `rateLimit.perMin/burst/silent` | 每会话每分钟上限 / 突发 / 超限静默 | 12 / 3 / true |
| `mute.enabled/words/seconds` | 指令禁言开关 / 指令词 / 时长 | true / 闭嘴等 / 60 |

「信息发送配置」弹窗用的是既有分片字段（`bubbleMaxChars`、`mergeMaxChars`、`chunkSize`、
`typingDelay`、`flypitDelayTiers`、`sendIntervalMs`、`groupAt*`、`trimEndPunctuation`），本来就是真实读写。

### Phase 4：清理失效会话

`POST /dsh-qq-guard/cleanup-sessions` 对账并归档：

1. 读桥接 `state/sessions.json` 拿到当前 QQ→DSH 会话映射，读 `config.json` 的 `dsh.sessionCwd`；
2. 用 Host 的 `sessionController.list()` 列出会话，筛出 **cwd = QQ 工作区 且 不在映射表里 且 非子代理** 的那些；
3. 逐条 `workspaceRegistry.archiveSession()`，返回 `{ candidates, archived, failed }`。

只在 QQ 工作区内动手，不碰你其它目录里的会话；桥接进程没跑也能清理（只用 Host 服务）。

左侧导航底部固定一个 `💡 使用引导` 按钮（`margin-top:auto` 沉底，与菜单区之间有分割线，菜单滚动时不动）。
点开是三步检查清单，状态**实时读取**：

1. **NapCat 进程** — `napcat.dir` 有值 → 绿点；为空 → 黄灯 + `去配置`（滚到 NapCat 卡片）
2. **白名单** — `allow.private` / `allow.groups` 有条目 → 绿点；为空 → 黄灯 + `去配置`（滚到白名单卡片）
3. **桥接进程** — 取 `useBridgeProc` 的真实 `alive`（不是配置里的 `autoStart`）；运行中 → 绿点「已就绪」，
   未运行 → 黄灯 + `去启动`（直接 POST `/dsh-qq-guard/bridge?action=start`，与运行状态页同一路由）

三项状态由 `guideSteps()` 统一派生，弹窗进度条与导航底部按钮的「x/3」读的是**同一份结果**
（桥接状态在面板层轮询一次后共用），不会出现「按钮 2/3、弹窗 3/3」这种两套口径。

交互约定（Phase 3）：

- 通用 `Modal`：遮罩 + 卡片，Esc / 点遮罩 / 右上角 × 三种关闭方式。
- 技能与插件卡片：原生 HTML5 `draggable` 拖拽排序，另有 `↑`/`↓` 按钮作为降级方案（键盘可用）。
- 齿轮打开设置弹窗（左表单 / 右说明），垃圾桶与删除会话走 `ConfirmModal` 二次确认。
- 「活跃设置」的参数（响应档位、防抖窗口、批次间隔、指令禁言）目前只存组件内 state，**不写配置**。
- 「全局设置」页顶部不再有引导卡片或按钮，引导只从左侧导航底部进入。

### NapCat 安装目录的「浏览」按钮

手输绝对路径体验差（而且 `C:\Program Files\NapCat` 这种带空格的路径容易打错），所以输入框右侧有 `[浏览]`，
点它弹**系统原生的「选择文件夹」窗口**，选完自动填进 `napcat.dir` 并触发 mutate 保存。

浏览器里 `<input type="file">` 按安全策略拿不到绝对路径，所以必须借 Host 侧能力。两条通路，优先级从高到低：

1. **首选 `uiWorkspace.pickDirectory()`** — 客户端的官方可选服务，由 profile 的 `directory-picker` 行提供
   （Windows 桌面解析成 native 后端）。走的是 DSH 自己那套「子进程 + Win32 文件对话框」实现。
   **不需要 Host 端任何新代码，改完 F5 就可用。**
2. **兜底 `POST /dsh-qq-guard/pick-dir`** — 插件自己的 Host 路由，内部调 `ctx.directoryPicker.capability().pick()`。
   只在 `uiWorkspace` 未装载时使用；⚠️ 新增 Host 路由需要重启 DSH（或把插件关开一次）才会注册。

状态码约定（前端据此给可读提示）：`200` 路径或 `cancelled`、`409` 已有窗口打开、`501` 没有 native 后端、
`500` 选择器报错、`403` 跨站。

输入框用 `flex: 1` + `min-width: 0` 自适应（`.qqg-dir-row`），长路径不会撑破卡片；
`napcat.dir` 为空时输入框下方有红字「未配置安装目录，NapCat 无法启动」，选完自动消失。

### NapCat 启停的位置（运行状态页）

NapCat 的**启停按钮和进程状态只在「运行状态」页**（紧接「实时状态」卡片下方）：

- 显示：当前状态标签（已停止 / 在线 / 进程在跑但 QQ 未登录 / 已运行但非本插件启动）、
  WS 端口是否 LISTENING、进程是否存活、登录账号（需 NapCat HTTP API 才能自动识别）。
- 操作：[启动 NapCat] / [停止]，走 `/dsh-qq-guard/napcat?action=start|stop`，与「实时状态」里的桥接启停同一页。
- 状态每 3 秒轮询 `/dsh-qq-guard/napcat?action=status`；点完启停立刻 refresh，按钮可用性和端口信息随之更新。
- 「全局设置 → NapCat 进程」**只剩输入框**（安装目录 + 快速登录 QQ 号），不再放按钮和状态，
  避免两处各轮询一份状态导致不同步；卡片底部有灰字提示去「运行状态」页操作。

真实配置项（与 Host 侧 Config 一一对应）：

- **分片节奏**：`chunkSize`、`bubbleMaxChars`、`mergeMaxChars`、`sendIntervalMs`、`typingDelay`、`flypitDelayTiers`
- **群聊 @**：`groupAtReply`、`groupAtPosition`
- **标点处理**：`trimEndPunctuation`
- **白名单**：`allow.private` / `allow.groups` / `deny` / `allowAllWhenEmpty`
- **人设**：`personaText`（角色设定，留空用 preset 内置人设）、`personaBotName`（机器人名字）、
  `personaGroupName`（群内展示名）、`personaParticipation`（quiet / normal / active）、
  `personaExtraRules`（管理员附加规则）、`personaSystemPrompt`（系统提示词覆盖，留空=内置）、
  `personaPresets` + `personaPresetId`（UI 的自定义人设列表与当前选择）
- **NapCat 配置**：`napcat.dir`（**必填**，本仓库不含任何机器相关默认值）、`napcat.quickLoginQQ`（启停在运行状态页）
- **桥接进程管理**：`bridge.dir`（留空用同仓库 `qq-bridge/`）、`bridge.autoStart`（「OneBot 连接」卡片里的
  「DSH 启动时自动拉起桥接进程」开关）、启动 / 停止

改完即时生效（桥接轮询 `/dsh-qq-guard/config` 热更新），只有换插件代码才需要重启 DSH。

Mock 部分刻意没有接数据：新增按钮统一绑 `noop`，等第二阶段再逐个接线。版式可用 `node render-preview.mjs`
生成静态 HTML（`preview/tab-*.html`，含深色版），不需要开浏览器就能看布局。

## HTTP 路由

| 路由 | 用途 |
| --- | --- |
| `GET /dsh-qq-guard/config` | 桥接定时轮询，做热配置同步 |
| `GET/POST /dsh-qq-guard/status` | 桥接上报状态，前端读状态灯 |
| `GET/POST /dsh-qq-guard/napcat` | NapCat 进程启停与状态 |
| `GET/POST /dsh-qq-guard/bridge` | 桥接进程启停与状态 |
| `GET /dsh-qq-guard/external-plugins` | 只读扫描外部插件目录，返回卡片数据 |
| `POST /dsh-qq-guard/external-plugins/test` | 在独立沙箱子进程里加载一个自包含外部插件 |

`status` / `napcat` / `bridge` / `external-plugins` 路由只接受同源请求（校验 `sec-fetch-site`），
非 GET 之外的方法返回 405。

## 进程管理要点

- **用 `ctx.subprocess`，不用 `node:child_process`**：Windows 上它用 Job Object 托管整棵进程树，`terminate()` 能连带收掉 NapCat 拉起的 QQ 子进程；`graceMs` 就是 TERM→KILL 宽限期。
- **NapCat 防双开**：先探 WS 端口，已在监听就直接复用（`action: "reused"`），不 spawn 第二个。
- **三层在线判定**：进程存活 + WS 端口 LISTENING + `get_status` 在线且带账号，三者同时成立才是 `online`。只看进程会把「QQ 掉线但进程还在」误判成在线。没配 HTTP API 时报 `running-unverified`（**不谎报在线**）。
- **桥接 autoStart**：DSH 启动 1.5s 后拉起，定时器挂在插件 fiber 上，卸载会取消。进程级 `Symbol.for` 标记保证**本 DSH 生命周期内只执行一次**，改设置不会打断正在收发的桥接。
- **单实例锁**：两个桥接同时连 NapCat 同一条正向 WS 会重复收消息、重复回复，所以抢不到锁就 `exit 0` 让位。

## 自测

```bash
node test-guard-scope.mjs     # 门禁作用域（防全局锁死）
node test-settings-data.mjs   # 设置页数据通路（remote / HTTP 兜底 / 错误可见）
node test-napcat.mjs          # NapCat 进程管理（假 subprocess，不真起进程）
node test-status-napcat.mjs   # 运行状态页的 NapCat 面板（启停路由 / 状态刷新 / 设置页只留输入框）
node test-autostart.mjs       # autoStart / 单实例 / 崩溃重启上限
node test-render.mjs          # 五个 Tab + 七个弹窗的渲染冒烟（假 React）
node test-skills.mjs          # 技能页交互逻辑（拖拽排序 / 上下移 / 增删 / 弹窗 / Esc / autoStart 开关）
node test-persona-ui.mjs      # 人设概览卡 + 设置弹窗（名字/展示名/参与度/三块文本/人设增删）
node test-external-ui.mjs     # 外部插件卡片（三种格式 / 兼容标签 / 描述裁剪 / 过滤 / configSchema 弹窗）
node test-guide.mjs           # 使用引导三步状态（配置 + 真实 bridge 进程 + 去启动路由 + 按钮/弹窗同源）
node test-browse.mjs          # 安装目录「浏览」（首选 uiWorkspace / 兜底路由 / 取消 / 失败）
node test-pickdir.mjs         # Host 路由 /dsh-qq-guard/pick-dir（native / 取消 / 并发 / 501 / 403）
node test-host-phase4.mjs     # 外部插件只读扫描（DSH 包 + QQ Agent 清单 + BOM + 兼容标签）+ 清理失效会话
node test-sandbox-protocol.mjs # 沙箱 NDJSON 协议（分帧 / 半行 / 坏帧 / 超限）
node test-sandbox-manager.mjs  # 沙箱管理器（假 subprocess：ready / 超时 / 熔断 / 单飞 / dispose）
node test-sandbox-child.mjs    # 真 node 子进程（setup / fs 拦截 / 越界引用 / 死循环超时）
node test-sandbox-route.mjs    # POST /external-plugins/test 路由（同源 / 路径注入 / 受控拒绝）
node verify-layout.mjs        # 布局几何（左导航底部按钮沉底、输入框不溢出、遮罩铺满、弹窗居中）
node render-preview.mjs       # 生成 preview/*.html 静态版式（含弹窗与深色版）
```

全部离线，用假 ctx / 假 subprocess / 假 React。`test-guard-scope.mjs` 与 `test-autostart.mjs` 需要 `@deepseek-ai/schemastery`：用 `QQG_SCHEMASTERY` 指向它的 `lib/index.mjs`，不设就自动探测 `node_modules`。

`qq-bridge/test-offline.mjs` 会串跑这四组。

## 许可

MIT。与 DeepSeek 官方无隶属关系。
