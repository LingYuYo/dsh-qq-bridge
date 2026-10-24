# @local/dsh-qq-guard

DSH 插件：给 QQ 聊天会话装一道**执行期工具门禁**，并提供 QQ 桥接的运行时参数设置页与进程管理。

配套的桥接进程在 [`../../qq-bridge/`](../../qq-bridge/)，两个要一起用。

> **v0.4.0（2026-10-24 正式版）** 一整天三轮真机修复的收口：
> ① guard 在 preset 内整体失活（作用域判定用错 API）→ 修好并加了「真宿主」回归测试；
> ② 人设被宿主注入的 USER.md/MEMORY.md 当 user 消息盖掉 → 在 agent 创建后挂过滤摘掉
>    （**顺带堵了隐私口子**：群友对话原本能让模型读到主人的长期记忆）；
> ③ 微软 Edge 朗读接口 403 → TTS 换 baidu 免 Key 通路，且**真机已打通**
>    （`已发送语音（baidu，96KB，via=base64，retcode=0）`）；
> ④ `qq_send_voice` 改成等桥接回执，失败直接抛错给模型（以前「入队即成功」）；
> ⑤ 网页搜索补上 DeepSeek API Key 的配置入口；另含单群独立响应档位、技能配置真实弹窗。
> 细节见文末两轮「修复记录」。

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

### 「我是不是在 preset 里」必须这么判（2026-10-24 P0 的教训）

`role: guard` 这个实例启动时第一件事就是确认自己装在哪：装错到 profile 顶层会让全局锁死，
**判错成「不在 preset」**则会让下面四件事全部静默跳过（人设 section / `qq_send_voice` /
restrict / 执行期白名单）—— 2026-10-24 就是这么炸的。

```js
// ❌ 旧写法：preset 子行恒返回 undefined
agentPresets.composedPreset(ctx) === undefined → return

// ✅ 现在：detectPresetScope() 两层取或
//   ① composedPreset(ctx) 有非空字符串        → 在 preset 内（agent ctx 场景）
//   ② tools.restrict 探针抛到「名字未知」      → scope 校验已过，在 preset 内
//   其它一切情况（含意外异常）                 → 当作不在 preset，拒绝装载（fail-closed）
```

为什么 ① 单独不够：`composedPreset()` → `generationFor(ctx)` 找的是 **`scopeOf(ctx)` 的父
scope**，而 preset 子行 ctx 的作用域**就是** generation 本身（没有父），所以恒 undefined；
它只对已 `bindScopeParent` 的 `agent.ctx` 成立。探针为什么无副作用：`restrict()` 先校验
scope 再校验工具名，两条 throw 路径都在 `layers.effect()` 之前。
回归用例见 `test-preset-scope.mjs`（真宿主）与 `test-guard-scope.mjs`（假 ctx）。

### restrict 必须重扫

第一版只在 `apply()` 里跑一遍 `tools.restrict()` 并 `catch {}` 静默吞错，结果**部分失效**。原因是 `restrict()` 对当下未注册的名字会抛错（`restrict() names unknown global tool …`），而 preset 子树装载时那些工具还没注册。

现在改成：初次扫一遍 + 监听 `tools/change` 持续重扫（只对尚未成功 deny 的名字重试）。

## 设置页

profile 顶层实例持有配置，投影到「设置 → QQ 桥接」。左侧导航为五个主 Tab：

| Tab | 内容 | 数据来源 |
| --- | --- | --- |
| 运行状态 | 桥接状态 / 启停 / 日志、NapCat 进程状态与启停、**NapCat 日志折叠框**、**登录二维码卡片（图片优先 / ASCII 兜底）**、**系统底层事件折叠面板**、今日用量概览卡、AI 排障助手输入框 | 状态与启停走真实路由；**今日用量卡读真实 `/usage`**；二维码直接读 NapCat 落盘的 `qrcode.png`；AI 框为 **Mock 壳** |
| 会话管理 | 左会话列表（昵称 / 群名、未读红点、最近一条消息预览）+ 右详情（DSH 映射与标题、**单群响应档位**、单人设覆盖、清空上下文、删除会话） | **全部真实**：列表来自桥接上报；清空/删除/单人设/档位走 Host 指令队列 + 桥接 2 秒轮询 |
| 技能与插件 | Skill / Plugin / 外部插件 三组卡片，外部插件带兼容标签与 `[测试运行]`，含版本号、齿轮、垃圾桶、拖拽手柄、上下移 | **全部真实配置读写**（齿轮弹窗按卡片 id 映射到真实 Config 路径）；沙箱测试走真实 Host 路由 |
| 全局设置 | 运行节奏（两个大按钮 → 信息发送配置 / 活跃设置 弹窗）、**模型配置（无痕热切换 + 备用模型）**、**高级参数（折叠）**、人设概览卡（编辑收进弹窗）、白名单、OneBot、NapCat | **全部真实配置读写** |
| 数据与用量 | 近 7 天柱状图 + Token 面积图，按天 / 按模型 / 按会话三张表，外加**峰谷时段设置**与**忙/闲两套单价配置卡** | **全部真实 `/usage` 数据**（5 秒轮询），成本按事件时刻分峰谷计价 |

左下角还有一张**快捷启动卡**（已在导航栏底部、使用引导按钮上方）：状态灯读
`/dsh-qq-guard/bridge` 与 `/dsh-qq-guard/napcat` 的真实进程状态，按钮按
**NapCat → 桥接** 顺序真实拉起、按反向顺序停止；当前模型优先读插件 Config 里真正下发的
`model`（`GET /dsh-qq-guard/config`），没有再显示全局默认。启动失败会显示错误行，绝不假装就绪。

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
2026-10-23 起多了 `typingDelayCharTiers`（短句上限 / 中等上限 / 长句触发三个字数边界，
默认 10 / 14 / 15），三档毫秒字段的标签会跟着这些阈值动态显示。

### Phase 6：技能与插件真实接入（2026-10-23）

12 张卡片里，下面这些不再是空壳（其余在 UI 上标「开发中」）：

| 条目 | 真实行为 |
| --- | --- |
| 图片理解 `sk-vision` | 桥接下载 QQ 图片 → base64 → 按 DSH prompt content 的 image part 投递；模型不支持时退回纯文本并如实说明 |
| 网页搜索 `sk-search` | `tools.guard` 放行 `web_search` / `web_fetch`；关闭即执行期拒绝。**需要 DeepSeek API Key**：齿轮弹窗里填（写入 DSH 的 `web-search-deepseek`），没配时工具会报 `WEB_PROVIDER_CREDENTIAL_MISSING` |
| 发语音 `sk-voice` | guard 注册 `qq_send_voice` 工具（**等桥接回执，失败会抛错**）→ 入队 → 桥接 baidu / Edge / OpenAI 兼容 TTS 合成 → NapCat record 段发送（base64 失败自动降级 file://） |
| 工具门禁 `pl-guard` | `tools.guard` 总开关；关闭 = 显式放弃执行期白名单（restrict 仍隐藏全局工具，UI 有红字警告） |
| 防抖合并 `pl-debounce` | 关闭则消息不再攒窗口，立即投递 |
| 频率控制 `pl-ratelimit` | 关闭则不做每会话每分钟限频 |

`GET /dsh-qq-guard/config` 额外返回 `features`（上述六个开关的派生布尔），
桥接与 guard 共用同一份判断，避免两端各写一套 id 逻辑而漂移。桥接每 2 秒热读，
改完下一条消息生效。

语音合成配置在「技能与插件 → 发语音」的齿轮弹窗（也可以去「全局设置 → 语音合成」）：
`voice.provider` = `baidu`（免 Key，**默认**，2026-10-24 起）/ `edge`（微软已端拒，会自动降级到 baidu）
/ `openai`（baseUrl + apiKey）。合成在桥接进程里做，插件只写配置 + 入队；
NapCat 负责 mp3 → QQ 语音的转码，失败会写日志、不影响聊天，**并且会把失败原因回给模型**。

### 2026-10-24：齿轮弹窗接真实 Config（不再是「暂无可配置项」）

以前的设置弹窗读的是卡片上的假 `settings` 数组，所以点进去永远是空的。现在按**卡片 id**
直接映射到真实 Config 路径，读写都走 `get(path)` / `write(path, value)`：

| 卡片 | 字段（＝Config 路径） |
| --- | --- |
| 发语音 `sk-voice` | `voice.provider`（edge / openai）、`voice.voice`（音色，候选随后端切换：Edge 4 个 `zh-CN-*Neural`，OpenAI `alloy/echo/fable/onyx/nova/shimmer`）、`voice.apiKey`（密码框，`role('secret')` 不回显、**留空 = 不改**）、`voice.baseUrl`（仅 openai 时出现） |
| 防抖合并 `pl-debounce` | `rhythm.debounceWindowMs`（0–10000ms，步进 100） |
| 频率控制 `pl-ratelimit` | `rhythm.rateLimit.perMin`（1–120）、`.burst`（0–30）、`.silent`（开关） |
| 其余未实装条目 | **不给假表单**：弹窗直接写「开发中」+ 具体原因（例如「定时提醒还没实装，桥接侧没有对应实现」），齿轮仍可点开看解释 |
| 已接入但无可调项 | 例如 `sk-vision` / `sk-search` / `pl-guard`：显示「无可调配置」+ 说明 |
| 不认识的 id（外部插件 / 自定义条目） | 兜底文案「该条目还没有对应的桥接实现」，不崩、不空弹窗 |

- 「恢复默认」写回 `index.js` 里 Config 的默认值，**但不会清空已保存的 `voice.apiKey`**
  （一键清 Key 是不可逆伤害，弹窗里有说明）。
- `writable=false`（只读配置源）时所有控件与按钮禁用，且点击直接 return，不写盘。
- 保存时逐字段比对，只写真正变化的键；secret 只在输入非空时写。

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
- 「活跃设置」的参数（响应档位、防抖窗口、批次间隔、指令禁言）全部绑到 `rhythm.*` 真实配置，
  改完写盘、桥接 2 秒内热读；滑条用本地草稿跟手，松手才提交（受控 range 直接吃异步回读会「拖不动」）。
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

### NapCat 登录二维码（2026-10-23 掉登录后补）

NapCat 掉登录时，二维码有两种来源，面板**优先用图片**：

1. **NapCat 自己落盘的截图**：`<napcatDir>/versions/<ver>/resources/app/napcat/cache/qrcode.png`
   （147×147 的 1-bit PNG，旧布局 `<napcatDir>/qrcode.png` 也认）。Host 新增只读路由
   `GET /dsh-qq-guard/napcat-qr` 把这张图发给浏览器（同源、no-store、nosniff、realpath 限定在
   NapCat 目录内、4MB 上限）。前端把它放进**白底卡片**、放大 2 倍 + `image-rendering: pixelated`，
   四周用 padding 留出静默区，手机直接扫码。
2. **终端 ASCII 二维码兜底**：NapCat 用 `qrcode-terminal` 的 small 模式打印（字符集只有
   `█ ▀ ▄ 空格`）。Host 在收日志时识别连续方块行（≥6 行），从 `logTail` 里**单独抽出来**，
   存成 `qr.text` 随状态一起上报；前端用「白底黑字 + 等宽 + `line-height: 1` + `letter-spacing: 0`」
   单独渲染。不足 6 行的零散方块会回填日志，绝不吞。

顺带修掉的两个坑：
- 日志进来先 `stripAnsi` 去掉颜色/光标转义，否则 `\x1b[32m` 之类的垃圾会占满日志框；
- 普通日志框也改成严格等宽（Consolas 优先）、`letter-spacing: 0`、行高收紧到 1.2——
  ASCII 方块不会再被压扁。
- 已在线（`state=online`）时**不显示二维码**，避免拿一张过期二维码误导扫码；
  过期图片（>5 分钟）收进折叠框，只在掉登录/未确认/已停止时展示。

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

### 会话管理接真实数据（本批）

「会话管理」不再有本地假数据。链路只有一条：

```
桥接进程（唯一知道 QQ 会话 ↔ DSH 会话映射的地方）
  → POST /dsh-qq-guard/status { ..., sessions: [{key, sessionId, kind, qq, name, title,
      unread, lastAt, lastText, persona, activityLevel}] }
  → Host 白名单收敛（sanitizeSessionRow，最多 100 条，body 上限 64KB）
  → 前端 useBridgeStatus 3 秒轮询 → 列表 / 详情 / 导航红点
```

⚠️ `sanitizeSessionRow()` 是**白名单**：桥接上报了、这里没写，前端就永远读到 `undefined`
（2026-10-24 就是这么丢了 `activityLevel` 与 `persona`，单群档位和单人设回填全显示不出来）。
新增上报字段必须同时改它，并且有测试盯着（`test-guard-scope.mjs` 里三个用例）。

- **列表**：昵称或群名、私聊/群聊、未读数、相对时间、最后一条消息预览；按最近活动倒序。
- **详情**：`u:<QQ>` / `g:<群号>` key、DSH 会话 ID、已对齐的 DSH 标题、最近活动、最近消息。
- **空态**：桥接没上报时显示「等待桥接上报」，**绝不用假数据顶上**；桥接在跑但还没会话时显示引导文案。
- **未读口径**：通过白名单的消息 `+1`（包括被响应档位跳过 / 静音 / 限频的），真正把回复发到 QQ 后清零；
  发送失败或超时不清零。
- **单人设 / 清空 / 删除**已解锁（见下文两节）。

桥接侧的命名与状态维护见 `qq-bridge/README.md` 的「会话标题与未读」一节。

### 单群独立响应档位（2026-10-24）

响应档位原来是**全局一个值**（`rhythm.activityLevel`），对一个安静群设 0 档会把所有群一起静音。
现在每个群可以单独覆盖：

- 落盘：`qq-bridge/state/sessions.json` 每条会话多一个 `activityLevel`
  —— `null` = **跟随全局**，`0..3` = 该群独立档位。**私聊不受影响**（永远回）。
- 指令：设置页提交 `{op:'activity', key:'g:<群号>', level: 0|1|2|3|null}`，
  走同一套会话指令队列（Host 队列 → 桥接 2 秒轮询）。非法 level 直接 400 `bad-level`，不静默改写。
- 判定：桥接 `_activityLevelFor(key)` 先读单群、再回退全局；`shouldRespond` 的第三参
  `key` 是可选的（老调用不受影响），命中日志会打印**实际生效**的档位。
- 「先配置、后聊天」也能用：key 还没有会话时 `_entryOf` 会建占位记录，重启后不会因为
  「空壳会话」被清理规则丢掉。
- UI：会话详情右侧「响应档位」卡，`null` 显示「跟随全局（当前 N 档）」；
  覆盖生效时详情头部多一个「单群档位 N 档」标签。

### 单人设覆盖（动态 persona section）

2026-10-23 的架构调整：preset 里**删掉了静态 `dsh-persona` 行**，改由 `role: guard` 实例注册
动态 section。

- section 名 `deployment:persona-prefix`，`complete: true`（唯一系统提示词），`text` 是函数：
  每次组装现读共享状态 → 单人设 > 全局人设 > `personaDefault` 兜底。
  为什么不走 `system-prompt/assemble` 瀑布：preset 的 `complete` section 在瀑布后会被强制还原，
  改 `assembly.sections` 是白改（证据：`dsh-system-prompt/lib/index.js:398-405`）。
- 数据通道：桥接**每条消息前** `POST /dsh-qq-guard/persona {sessionId, text}`（含非管理员提示词）；
  启动 / 设置页改动时 `{mode:'default', text}` 推全局人设。失败只记日志，不阻塞聊天。
- UI：会话详情里的「单人设覆盖」保存后走队列（见下），桥接写入 `sessions.json` 并立即推送；
  下一条消息前还会再推一次，所以 DSH 重启后也能自愈。
- 兜底文本来源：`cordis.patch.yml` 里 guard 子行的 `personaDefault`；
  `/config` 路由会把它合并进返回值，桥接据此拼 `buildPersonaPrompt()`。

### 会话指令队列（清空 / 删除 / 单人设保存）

```
UI POST /dsh-qq-guard/session-ops {op, key, text?, level?}
  → Host 内存队列（同 key+op 去重，50 条上限，5 分钟 TTL）
  → 桥接每 2 秒 GET 同一路由（Host 给 30s 租约，防重复执行非幂等操作）
  → 桥接执行 → POST {results:[...]} → Host 移除
```

- `clear`：归档旧会话（**必须带 `stopActivity:true`**，活跃会话否则 `workspace/session-active`）
  → 同工作区建新会话 → 重新对齐标题 → 未读清零。归档失败也继续建新会话（旧会话记 stale 待清理）。
- `delete`：归档旧会话（同样 stopActivity）+ 从 `sessions.json` 删除映射；归档失败仍删映射，
  否则 UI 上「删不掉」。
- `persona`：写 `sessions.json` 的 `persona` 字段并立即推送；空串 = 恢复全局。
- `activity`：写 `sessions.json` 的 `activityLevel`（`0..3` 或 `null`=跟随全局），见上一节。
  取值校验在 Host 侧（非法返回 400 `bad-level`），桥接侧再按契约归一化一次。
- UI：两个按钮二次确认，提交后显示「已提交，桥接会在 2 秒内执行」，列表随 3 秒轮询更新。

### 管理员权限（`allow.admins`）

- 配置：`allow.admins`（设置页「白名单管理」里的「管理员 QQ 号」列表，回车添加 Tag）。
- 桥接拦截：**以 `/` 开头的消息**只有 `allow.admins` 里的人能发；其他人直接回
  `⚠️ 权限不足，只有管理员才能执行此指令。` 并丢弃，**不投递 DSH**（省 token）。
- 管理员身份**不绕过白名单**：不在 `allow.private/groups` 里照样被挡。
- 非管理员发言时，人设末尾追加一段「拒绝清空记忆/重置会话/改配置」的提示（每轮现拼）。
- 以后加 `/reset`、`/clear`、`/model` 等指令时，只需沿用同一入口即可。

### 历史标题批量修正

```bash
node tools/rename-sessions.mjs            # 预演
node tools/rename-sessions.mjs --apply    # 真改
```

只处理 `sessions.json` 里有映射、且标题不符合「私聊-昵称 / 群聊-群名(群号)」的会话；幂等可重跑。
源码：`tools/rename-sessions.mjs` + `qq-bridge/src/rename-plan.mjs`（计划函数有离线用例）。

版式可用 `node render-preview.mjs` 生成静态 HTML（`preview/tab-*.html`，含深色版），不需要开浏览器就能看布局。

## 模型配置：无痕热切换 + 失败降级

QQ 会话切模型，**不能**走 `session/selectModel` —— 它会顺带 `agentDefaultModel.saveSelection()`
（`dsh-api-session-controller/lib/types/commands.js:175`），也就是**每切一次就把 DSH 桌面端的全局默认改一次**。
所以本插件改成在 `agent/request` 瀑布里覆写**这一次请求**的 route，全程不写任何全局配置。

### 机制

```
桥接每条消息前 → POST /dsh-qq-guard/model {sessionId, provider, model, reasoningEffort?, fallbacks?}
   → 插件内存表 sessionId → 偏好
   → 该会话每次 LLM 调用前：agent/request 瀑布（prepend）→ 返回 {...config, provider, model, effort}
   → 循环拿它去 llm.prepareCall → adapter → 上游
```

- `agent/request` 是发请求前的最后一站（`dsh-agent-loop/lib/index.js:1191`，返回值直接进 `:1201` 的 `prepareCall`），
  所以覆写**真实生效**，不是改配置等重启。
- 必须 `{ prepend: true }`：cordis 瀑布先注册的在最外层、外层返回值最终生效（`cordis/src/events.ts`）。
  插件 HMR 重载后不 prepend 会掉到 selection 钩子内层，覆写静默失效。
- 会话身份从 payload 拿：`agentEvents` 会把 `agent` 注入 payload（`dsh-agent/lib/index.js:255-270`）。
- 根 ctx 的监听器收得到 preset 内会话：`scopeTarget` 对无 scope tag 的监听器一律放行（`dsh-scope/lib/index.js:327-338`）。

### 粘性（实测踩到的坑）

`selection.current` 的回落顺序是「待消费的 `model/selection` → **最近一次 `request/header`** → 全局默认」
（`dsh-api-session-controller/lib/index.js:281-302`）。一旦覆写过，header 里记着新模型，
**删掉偏好也不会自动回默认**。所以：

- 桥接侧**每条消息都回写具体 provider/model**（「跟随默认」= 先从 `session/modelCatalog` 读 `default` 再原样写回）；
- 插件侧支持 `POST {sessionId, mode:"default"}` 强制钉回 `agentDefaultModel.currentSelection()`。

### 失败降级

- **正路**：主模型返回 `finish: error`（超时 / 429 / 5xx / 内容审核）时，循环派发 `agent/request-error`
  （`dsh-agent-loop/lib/index.js:1136`）。内层 `dsh-llm-retry` 先按同一模型重试；它放弃后我们返回 `{kind:'retry'}`，
  循环重跑本步，这次 `agent/request` 用备用模型。**同一轮内自动接管**。
- **兜底网**：adapter 在流开始前就抛错（缺 key / NO_ADAPTER）时不会派发 `request-error`，只发 `agent/error`。
  我们在这里把降级游标推一格；桥接下一条消息重新 POST 同一 route 时**不重置游标**，于是下一轮直接走备用。
- 换 route（用户改主模型）才重置游标；备用最多 4 个，用尽后不再重试。

### UI

「全局设置 → 模型配置」：当前模型下拉（按 provider 分组）、推理档位、备用模型列表（≤4）、能力警告。
数据来自 `GET /dsh-qq-guard/models`（Host 侧把 `llm.listProviders → listModels → resolveModelInfo` join 好，
每个模型自带 `input: ["text","image"]`），**选了纯文本模型会明确警告「发图会被上游拒绝」**。

### 静默看门狗（把「挂着不返回」变成可降级的错误）

**2026-10-22 真机教训**：把主模型设成一个连不上的 provider 时，它把连接挂着、
62 秒一个 chunk 都不吐。这种情况下**适配器不报错、循环不派发 `agent/request-error`**，
降级链永远等不到机会 —— 用户只能干等桥接的 180s 超时。

现在插件在 `llm/stream` 瀑布上加了一层看门狗（`modelWatchdogMs`，默认 8000ms，0=关闭）：
被接管的模型超过这个时间**没有任何 chunk**，就产出终态 `finish(error, code=WATCHDOG_TIMEOUT)`，
循环收到后照常走 `agent/request-error` → 同轮切备用模型。

三个设计要点：

- **只包被接管的流**：`managedRoutes()` 只包含 QQ 会话的主模型 + 备用模型，
  浏览器里的会话、子代理一律原样透传，不会把「长思考不吐字」误杀。
- **错误码故意不叫 `TIMEOUT`**：`TIMEOUT` 在 `dsh-llm-retry` 的可重试名单里，
  会先同模型重试 5 次，把降级推迟到一分钟以后；未知码直接交给降级链。
- **不 `await iterator.return()`**：适配器卡在 `await`（不是 yield 点）时 `return()` 永远不 resolve，
  看门狗会跟着挂死；发出去挂个 `catch` 就够了。

### 系统底层事件（过程可见化）

看门狗切断、切备用、`agent/error` 兜底都发生在 Host 进程内，原本界面上完全无感。
插件现在维护一个**最近 20 条**的环形队列，`GET /dsh-qq-guard/system-events` 暴露：

```json
{ "ok": true, "events": [
  { "ts": 1792..., "at": "2026-10-23T00:16:05.123Z", "level": "error",
    "kind": "watchdog", "message": "触发看门狗：workbuddy/xxx 8s 无响应，强制中断",
    "detail": { "route": "workbuddy/xxx", "idleMs": 8000 } }
] }
```

- `level`：`error`（红，看门狗）/ `warn`（黄，切备用、抛错）/ `info`
- `kind`：`watchdog` / `fallback` / `agent-error`
- 面板「运行状态 → 系统底层事件」折叠面板每 3 秒轮询它；收起时标题里带最新一条。

### 高级参数（折叠卡）

| 字段 | 默认 | 作用 |
|---|---|---|
| `replyTimeoutMs` | 20000 | 桥接等回复上限；超时会 `session/cancel` 并给 QQ 回提示 |
| `modelWatchdogMs` | 8000 | 看门狗切断时间（0=关）；只作用于 QQ 会话下发的路由 |
| `antiDebounceMs` | 0 | 防抖窗口；0 = 沿用「活跃设置」里的 `debounceWindowMs`（默认 800） |

三个都进了 Config（`.volatile()`）、面板「全局设置 → 高级参数」有输入框，
桥接侧通过 `runtime-config.mjs` 的 `HOT_KEYS` 热读 —— 改完保存，下一条消息生效，不用重启桥接。
等待超过看门狗时间还没回复时，桥接日志会打一条 `⏳ 等待回复已超 N 秒，可能正在触发看门狗降级…`。

### 限制

- DSH 原生 UI 的模型选择器不会跟着变（这是不改全局默认的代价）。真实 route 由
  `assistant/message.data.message.source` 记录，用量统计按它归因，不受影响。
- 多模态准入检查看的是会话 selection、不是覆写值（`dsh-api-session-controller/lib/types/commands.js:306-316`），
  所以「默认模型支持图片、覆写成纯文本模型」时图片会被放行然后上游报错 —— 面板要自己拦。
- 切换会作废前缀缓存，频繁切要算进成本。

## 数据与用量（真实统计）

数据源只有一条：Host 进程内的 `session/event` —— 只认 `assistant/message.data.usage`
（重试那次再读 `assistant/attempt.data.stream` 里最后一个 usage chunk），`turn/end`
只用来算成功率。**不读日志、不走 `session/follow`。**

- **范围**：只统计 QQ 工作区（`cwd === dsh.sessionCwd` 或 `sessions.json` 映射命中），
  `origin === 'subagent'` 与浏览器会话一律排除。
- **口径**：`inputTokens` 是未命中缓存的输入，prompt 总量 = input + cacheRead + cacheWrite；
  `reasoningTokens` 已含在 output 里，不重复加。`assistant/message` 与 `assistant/attempt`
  都计一次调用（失败/重试的上游调用也真实计费）。
- **去重**：每个会话维护 `liveSeq / backfillSeq / firstLiveSeq` 三个水位，重启、重复回填、
  回填与在线监听交错都不会重复计数。
- **回填**：启动 2.5s 后用官方 `ctx.sessionPersistence.list() + open(id,'read')` 扫一遍
  已存在的 QQ 会话；`POST /dsh-qq-guard/usage/backfill` 可手动补跑（幂等）。
- **落盘**：`qq-bridge/state/usage-stats.json`（原子写 + 1.5s 防抖，`state/` 不进仓库）。
  存储版本 v3：模型桶里额外保存 `peak` / `offPeak` 两份 token 明细，成本按事件发生的
  时刻分别套忙时/闲时单价。旧版本文件启动时会被备份成 `.bak` 并靠回填重建。
- **成本（峰谷计价）**：DSH 只报 token、不报单价；面板「单价配置」卡写 `Config.usagePricing`，
  每个 `provider/model` 两套费率：`peak` 与 `offPeak`，各含输入 / 输出 / 缓存读 / 缓存写
  四项，单位「元 / 百万 token」。四项全 0 = 未配置 → 成本显示「—」，不假装免费。
  - 忙时窗口由 `Config.peakHours` 决定（默认 `08:30-00:30`）：**支持逗号分隔多段**，
    例如 `09:00-12:00, 14:00-18:00`；每段左闭右开，`start > end` 表示跨午夜。
  - `Config.timezone`（默认 `Asia/Shanghai`）决定日期与时刻的换算时区。
  - `Config.peakOnlyWorkdays`：开启后周六 / 周日整天空闲时。
  - 节假日 / 调休读同目录的 `holidays.json`（与 `usage-stats.mjs` 同目录）：
    ```json
    { "workdays": ["2026-10-17"], "holidays": ["2026-10-19"] }
    ```
    优先级：`holidays` 命中 → 整天 Off-Peak；否则 `workdays` 命中 → 按工作日走忙时时段；
    都没命中再看 `peakOnlyWorkdays`；最后按时段窗口判断。
  - 缓存写入按 `cacheWrite` 单价单独计费（以前只算读）。
  - 旧版扁平单价（`{ input, output, ... }`）仍兼容：同时套到忙时/闲时两套，面板首次编辑时
    自动迁移成嵌套结构，已填数字不会丢。
  - 峰谷规则是**记录时**分类的。规则变化会写进统计文件签名：重启 DSH 时发现签名不一致会
    自动备份 `.bak`、清空并按新规则回填重算；不想重启也可以手动
    `POST /dsh-qq-guard/usage/backfill?rebuild=1`。

面板侧 `useUsage()` 每 5 秒拉一次 `GET /dsh-qq-guard/usage`，失败保留上一份数据；
「今日用量概览」用 `days=2`（今日 + 昨日算环比），「数据与用量」用 `days=7`。

## HTTP 路由

| 路由 | 用途 |
| --- | --- |
| `GET /dsh-qq-guard/config` | 桥接定时轮询，做热配置同步 |
| `GET/POST /dsh-qq-guard/status` | 桥接上报状态，前端读状态灯 |
| `GET/POST /dsh-qq-guard/napcat` | NapCat 进程启停与状态 |
| `GET/POST /dsh-qq-guard/bridge` | 桥接进程启停与状态 |
| `GET /dsh-qq-guard/external-plugins` | 只读扫描外部插件目录，返回卡片数据 |
| `POST /dsh-qq-guard/external-plugins/test` | 在独立沙箱子进程里加载一个自包含外部插件 |
| `GET/POST/DELETE /dsh-qq-guard/model` | 按会话写/读/清模型偏好（无痕热切换，桥接每条消息前 POST） |
| `GET /dsh-qq-guard/models` | 模型目录：provider + 模型 + `input` 多模态能力 + 上下文 + 推理档（面板用） |
| `GET /dsh-qq-guard/system-events` | 系统底层事件：看门狗 / 切备用 / 抛错，最近 20 条（面板用） |
| `GET /dsh-qq-guard/usage?days=7` | 真实用量聚合：今日 / 昨日 / 趋势 / 按天 / 按模型 / 按会话（面板 5 秒轮询） |
| `POST /dsh-qq-guard/usage/backfill` | 手动补跑历史回填（幂等；启动时也会自动跑一次）。带 `?rebuild=1` 时先清空再按当前峰谷规则重算 |

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
node test-guard-scope.mjs     # 门禁作用域 + preset 判定 + 上下文过滤 + 语音回执（38 例）
node test-preset-scope.mjs    # 真宿主：preset 内必须生效 / 顶层必须拒绝（31 例，缺 DSH 包时 SKIP）
node test-model-override.mjs  # 模型无痕热切换 + 降级链 + 静默看门狗 + 系统事件 + 目录 join（假 ctx，23 例）
node test-settings-data.mjs   # 设置页数据通路（remote / HTTP 兜底 / 错误可见）
node test-napcat.mjs          # NapCat 进程管理（假 subprocess，不真起进程）
node test-status-napcat.mjs   # 运行状态页的 NapCat 面板（启停路由 / 状态刷新 / 设置页只留输入框）
node test-autostart.mjs       # autoStart / 单实例 / 崩溃重启上限
node test-render.mjs          # 五个 Tab + 八个弹窗的渲染冒烟（假 React）
node test-tile-config.mjs     # 技能/插件配置弹窗接真实 Config（字段集 / 保存路径 / 开发中 / 只读禁用，17 例）
node test-web-config.mjs      # 网页搜索凭据弹窗（Key 密码框 / 未配提示 / 写入路径 / 代理说明，9 例）
node test-usage-stats.mjs     # 用量拦截 / 去重 / 多段峰谷 / 工作日节假日 / 规则变化重建 / 回填幂等 / 两条路由（19 例）
node test-usage-ui.mjs        # 用量页真实数据接线（轮询 / 图表 / 三表 / 多段峰谷 / 工作日开关 / 单价写回，11 例）
node test-skills.mjs          # 技能页交互逻辑（拖拽排序 / 上下移 / 增删 / 弹窗 / Esc / autoStart 开关）
node test-persona-ui.mjs      # 人设概览卡 + 设置弹窗（名字/展示名/参与度/三块文本/人设增删）
node test-external-ui.mjs     # 外部插件卡片（三种格式 / 兼容标签 / 描述裁剪 / 过滤 / configSchema 弹窗）
node test-guide.mjs           # 使用引导三步状态（配置 + 真实 bridge 进程 + 去启动路由 + 按钮/弹窗同源）
node test-shell-ui.mjs        # 快捷启动卡（真实路由顺序 + 失败态）+ 全局设置「记忆整理」卡
node test-browse.mjs          # 安装目录「浏览」（首选 uiWorkspace / 兜底路由 / 取消 / 失败）
node test-pickdir.mjs         # Host 路由 /dsh-qq-guard/pick-dir（native / 取消 / 并发 / 501 / 403）
node test-host-phase4.mjs     # 外部插件只读扫描（DSH 包 + QQ Agent 清单 + BOM + 兼容标签）+ 清理失效会话
node test-sandbox-protocol.mjs # 沙箱 NDJSON 协议（分帧 / 半行 / 坏帧 / 超限）
node test-sandbox-manager.mjs  # 沙箱管理器（假 subprocess：ready / 超时 / 熔断 / 单飞 / dispose）
node test-sandbox-child.mjs    # 真 node 子进程（setup / fs 拦截 / 越界引用 / 死循环超时）
node test-sandbox-route.mjs    # POST /external-plugins/test 路由（同源 / 路径注入 / 受控拒绝）
node verify-layout.mjs        # 布局几何（左导航底部按钮沉底、输入框不溢出、遮罩铺满、弹窗居中）
node render-preview.mjs       # 生成 preview/*.html 静态版式（含弹窗与深色版；弹窗页带关键文案断言）
```

全部离线，用假 ctx / 假 subprocess / 假 React。`test-guard-scope.mjs` 与 `test-autostart.mjs` 需要
`@deepseek-ai/schemastery`：用 `QQG_SCHEMASTERY` 指向它的 `lib/index.mjs`（**要给绝对路径**），
不设就自动探测 `node_modules`。

`test-preset-scope.mjs` 需要真正的 DSH 包（`@deepseek-ai/cordis` / `dsh-scope` / `dsh-tools` /
`dsh-system-prompt` / `cordis-plugin-loader` / `dsh-agent-preset-registry`）：用 `QQG_DSH_MODULES`
指向一个含这些包的 `node_modules`，**没设或找不到就打 SKIP 并 exit 0**，不会把离线套件弄红。
（这些包在 `DeepSeek Harness/resources/app.asar` 里：读前 16 字节拿 JSON header 长度、再按
`dsh/node_modules/<pkg>/...` 的 offset/size 取文件即可；注意要顺着 import 把依赖闭包一起抽出来，
大约 25 个包。`@deepseek-ai/schemastery` 从插件自己的 `node_modules` 里拿也行。）
它是唯一一条「真宿主 + 真实 mountPreset」的用例 —— 2026-10-24 那个 P0 只有它能拦住，
把判定退回旧写法会红 13 条。

`qq-bridge/test-offline.mjs` 会串跑这四组；桥接侧另有 `test-activity.mjs` / `test-tts.mjs` / `test-persona.mjs` / `test-timeout.mjs`。

2026-10-24 基线（第二轮）：guard 24 个文件 + 桥接 5 个文件全绿 —— `test-guard-scope` 38、
`test-preset-scope` 31【联机】、`test-tile-config` 17、`test-web-config` 9、`test-offline` 168、`test-tts` 29。

## 2026-10-24 修复记录（真机 Bug 清单 → 已修）

> 原文是当天的「只记录不修」现场记录，下面保留症状 + **事后确认的根因**，方便下次复发时对照。

### 0. 真正的根因：guard 在 preset 里根本没跑起来（P0，一次解释完 1/3/4）

- **现象**：三条独立症状同时出现 —— ① 人设 section 没生效（system/message 是全局 Harness
  提示词，10595 字）；② 工具清单里没有 `qq_send_voice`；③ 连 `ops_glob` /
  `load_workspace_dependencies` 这种**本该被 restrict 藏掉的全局层工具**也还在。
- **根因**：`applyGuard()` 第一行的「我是不是装在 preset 里」判定写成了
  `agentPresets.composedPreset(ctx) === undefined → 直接 return`。而
  `composedPreset()` → `generationFor(ctx)` 取的是 **`scopeOf(ctx)` 的父 scope** 去查
  generation 表；preset **子行自身**的 ctx 作用域**就是**那个 generation（没有父），
  于是恒返回 `undefined`。它只对「已经 `bindScopeParent` 到 generation 的 `agent.ctx`」成立。
- **后果**：`applyGuard` 在第一步就 return，人设 section / `qq_send_voice` / restrict /
  执行期白名单**四件事全都没做** —— 也就是说当时 QQ 会话**既没有系统人设、也没有执行期门禁**。
- **修法**：新增 `detectPresetScope(ctx)`，两层判定取或：
  ① `composedPreset(ctx)` 返回非空字符串（agent ctx，保留兼容）；
  ② `tools.restrict({deny:['__dsh_qq_guard_scope_probe__']})` 探针 —— 无 scope 会先抛
  `requires a scoped context`（此时还没做任何变更），抛到「名字未知」就说明 scope 校验已通过。
  **兜底方向 fail-closed**：只有拿到正向证据才挂 guard；其它任何意外一律当作「不在 preset」，
  因为「误判成顶层」只是 QQ 会话失去门禁（日志可见），「误判成 preset」则是全局 guard
  把浏览器会话全锁死 —— 后者正是 2026-10-20 那次事故。
- **验证**：`test-preset-scope.mjs`（真宿主 + 真实 `mountPreset`）：修复后
  `assemble()` 只剩 `deployment:persona-prefix` 一段（带 `agent.session.id` 时单人设覆盖生效）、
  `tools.schemas(presetScope)` 里出现 `qq_send_voice`、deny 名单里的全局工具被隐藏、
  全局视角一段没少；顶层装载仍然被拒绝；把判定换回旧写法 → 该文件红 13 条。
- **上线动作**：Host 侧改动要**重启一次 DSH**（bundle patch 在启动时装载，`cordis.yml` 会重新生成）；
  已经开着的 QQ 会话下一条消息就会走新的 section 组装。

### 1. 人设没进系统提示（P0）→ 根因见上，已修

- 单人设保存链路（UI → session-ops → bridge state → plugin personaState）本来就是通的，
  缺的是 section 承载：guard 不跑，`applyPersonaSection` 自然不执行。
- 现在 section 正常注册（`complete: true`，`text` 是函数每次组装现读），
  兜底链 单人设 > 全局人设 > `personaDefault`；`suppressRuntimeContext()` 也会关掉
  运行时上下文注入，避免 Harness 自述 / Agent Teams / MNEMON 段落穿透进 QQ 会话。

### 2. 人设每 2 秒被重复推送 → 已修（根因比记录多一层）

- 记录里只写了 `onPersona` 返回 `undefined`；实际还有一层：`runtime-config.mjs` 里
  `const r = onPersona?.(...)` **没有 `await`**，异步回调拿到的是 Promise，`r?.ok` 同样恒假。
- 修法：`start.mjs` 的 `pushGlobalPersona` 改 async、返回 `{ok, action, detail}`，
  并在内部按正文签名去重（内容没变返回 `unchanged`，不重复写插件）；
  `onPersona` 返回 Promise，`runtime-config.mjs` 补 `await`；
  `r === undefined` 按契约违例 warn **一次**并推进签名（不再每 2 秒静默重推）。
- 「全局人设已推送」日志现在只在启动（config 兜底 + 首次同步校准）和真正变化时出现。
- **上线动作**：桥接是独立进程，改完要**重启桥接**（设置页「运行状态 → 重启桥接」或手动重启）。

### 3. 发语音失败（P1）→ 已修（工具可见性）

- 头号嫌疑成立：`parameters` 之前是手写的「属性名 → spec」裸对象，没有根 `type: "object"`，
  交给 registry 后模型侧 schema 非法（注册成功但进不了 `request/header` 的工具清单）。
- 现在改用官方 `defineTool()` 编译（`@deepseek-ai/dsh-tools`），
  `parameters` / `output.schema` 都是合法 JSON Schema；`output.schema` 补上了 `id` 字段，
  避免「返回值和声明的 schema 不一致」。
- ⚠️ 插件装载在 profile 的 `node_modules` 里，**生产环境能否解析到 `@deepseek-ai/dsh-tools`
  取决于宿主的模块解析**；拿不到时用 `index.js` 里的 `localDefineTool` 兜底（编译规则逐条对齐
  `dsh-tools/lib/types/schema.js`，产出同构），启动日志会打印用了哪条路径
  （`qq_send_voice 已注册（official-defineTool|local-fallback）`）。
- **次嫌疑仍未验证**：NapCat `record` 段对 `base64://` + mp3 的兼容性、是否必须 silk、
  落盘 mp3 用 `file://` 是否更稳。判据是桥接日志里的 `已发送语音 …` / `语音发送失败 … retcode`，
  这条要在真机上再看一次。

### 4. 网页搜索没接上（P2）→ 已修（是没挂载，不是白名单）

- 根因：`@deepseek-ai/dsh-tool-web` 是 agent 侧插件，`qq-chat` preset 里**没有这一行**，
  所以 QQ 会话的工具面里根本没有 `web_search`。guard 的白名单（`features.search`）只是第二道。
- 修法：`cordis.patch.yml` 的 `qq-chat` preset 加 `- id: tool-web / name: '@deepseek-ai/dsh-tool-web'`；
  `ctx.web` 与搜索/抓取后端都在 profile 顶层装着，preset 子行继承即可，不用再装后端。
- 技能页「网页搜索」关掉后，guard 会在**执行期**拒绝 `web_search` / `web_fetch`（schema 常驻）。
- ⚠️ **离线只能验到「同名全局工具不会被误伤 / 不会溢出全局」**（真宿主 harness 里没有
  `dsh-web` / `dsh-tool-web`）。`web_search` 真的出现在 QQ 会话 schema 里，需要在真 profile
  重启 DSH 后开一条 QQ 会话看 `request/header` —— 这是下一次真机验收的第一条。

### 5. 顺手修掉的两个静默 bug

- **`sanitizeSessionRow()` 白名单漏字段**：Host 收敛桥接上报时只留了 10 个字段，
  `activityLevel` 与 `persona` 被裁掉 → 单群档位保存了也看不出效果、单人设回填永远空。
  现在两个都补上（`null` 原样保留，不走 `num()`），并有 3 条测试盯着。
- **`render-preview.mjs` 的 hook 序号漂移**：三张弹窗预览一直渲染成「添加技能」。
  已对齐 `useState` 顺序，并给 `emit()` 加了关键文案断言，下次再漂会直接报错而不是默默出空弹窗。

## 2026-10-24 第二轮真机修复：人设 / TTS / 网页搜索

> 上一轮把 guard 装回来了（工具清单 35 → 15，`qq_send_voice` / `web_search` 都在），
> 但真机复测还剩三件事。下面每条都先给**实测证据**，再给修法。

### 1. 人设「保存了但模型无视」→ 是宿主把记忆当 user 消息塞进来了

- **证据链**（全部来自会话日志与会话现场，不是猜）：
  1. 重启后该 QQ 会话的最近一条 `system/message` 就是我们的 `deployment:persona-prefix`
     （6554 字，`complete: true` 生效，全局 Harness 自述没穿透）；
  2. 直接打 `https://opencode.ai/zen/go/v1/chat/completions`（provider=opencode-go，
     `system` 写一段人设）→ 模型**照做人设**（回了「我是牛头…[PERSONA-OK]」）
     ⇒ 上游没有覆盖系统提示词；
  3. 但会话日志里 `MNEMON RUNTIME MEMORY SNAPSHOT` 出现 **23 次**、`USER.md` **55 次**，
     而且它们不是系统提示词 —— 是 `source.kind = "dsh-mnemon"` 的**user 消息**
     （`form:"recall"` 的 3863 字快照 + `form:"instructions"` 的引导语）。
     模型在思维链里直接引用 USER.md 的「称呼：翎羽 / 自称小鱼」→ 它在照记忆演。
- **根因**：`dsh-mnemon` 在 `agent/pre-step` 瀑布里 `createPluginMessage(text,'recall')`
  把 USER.md / MEMORY.md 快照当普通 user 消息插进每一步。对模型来说**user 消息比系统人设更硬**，
  我们的人设就被整段无视了。`suppressRuntimeContext()` 管不了它（那是 system-prompt 的
  context 面，而这是 pre-step 的消息面）。
- **修法**：`applyContextFilter(ctx)` —— 调完 `next()` 后按 `source.kind === 'dsh-mnemon'`
  （外加文本标记兜底）把这些消息摘掉。**难点全在监听器的注册时机**：
  - cordis 瀑布里「数组第一个」= 最外层（最先拿控制权、最后拿返回值），`prepend` 是 unshift；
  - `next()` 之后才追加消息的插件（mnemon 就是这样）只有让我们「站在它外面」才摘得掉；
  - mnemon 在 **agent 创建事件**里对 `agent.ctx` 做 `prepend` → 它占据最外层；
  - 我们如果在 preset 装载时注册（早于 agent 创建），无论 prepend 还是 push，都会被 mnemon
    的 unshift 顶到里面去 → **静默失效**（第一版就是这样：真机新会话里 MNEMON 照样出现 3 次）；
  - 正确做法：监听 `agent/created`，在这个 agent 自己的 ctx 上用 `queueMicrotask` +
    `{prepend:true}` 再挂一次 —— 落在 mnemon 的同步注册之后，unshift 后就是最外层。
- **这条顺序陷阱有专门的证据**（真 cordis 跑的三种注册方式对照）：
  装载时 prepend → 泄漏；装载时 push → **同样泄漏**；agent 创建后 prepend → 干净。
  仓库里 `test-guard-scope.mjs` 用断言把「agent/created 之后必须 prepend 挂到 agent ctx」锁死了。
- 顺带解决**隐私问题**：QQ 群友的对话不该带着主人的长期记忆（本轮之前模型能直接读到 USER.md）。
- **诊断开关**：Config `debugPrompt = true`（或环境变量 `QQG_PROMPT_DEBUG=1`）会打印
  `[Persona Debug] session=… sections=[名字:字数] contexts=[…] personaHead="…"`，
  只在内容变化时打，用来确认「组装出来的到底有没有人设」。

### 2. TTS：微软 Edge 朗读已被端拒 → 换 baidu 免 Key 通路，失败必回模型

- **证据**：
  - 桥接日志 `[13:03:39] ⚠️ 语音合成失败 …：Edge TTS WebSocket 错误：`（错误被吞）；
  - 直跑 `synthesizeEdge()`：WS close code **1006**，error event 的 `message` 是空串；
  - 裸 https 握手探测 `speech.platform.bing.com/.../edge/v1`：带不带 `Sec-MS-GEC`、带 Origin、
    Chromium 128/130/143 都 **403**。上游 edge-tts 已改用 `Sec-MS-GEC v2`
    （DRM 魔改 SHA256 + CS64），旧算法不再被接受。
  - 对照组：`https://fanyi.baidu.com/gettts?lan=zh&text=…&spd=5&source=web` → 200 + `audio/mpeg`
    + 合法 MP3（magic `fff3`）。
- **修法**：
  - 新增 TTS provider **`baidu`（免 Key，默认）**；`edge` 保留，但失败信息翻成人话
    （含状态码 + 「已升级 v2」的已知根因）。v2 算法没实现（魔改 SHA256 移植成本高、随时还会变）。
  - 配置里仍是 `edge` 的用户，桥接会**自动降级到 baidu 重试一次**，日志与回执都写明降级。
  - **失败必须回到模型**：`qq_send_voice` 以前「入队即返回 queued」，模型以为发出去了而 QQ 里什么都没有。
    现在工具**等桥接回执**（`POST /dsh-qq-guard/session-ops {results}` 的 `{ok, detail}`）：
    成功返回 `{sent:true, detail}`，失败 `throw new Error('语音发送失败：<detail>')`，
    25s 拿不到回执照样抛错。detail 带 provider / 体积 / via / retcode，够模型跟用户解释。
  - NapCat `record` 段：`base64://` 失败会自动落盘 `state/voice-<ts>.mp3` 用 `file://` 重发一次，
    两次都失败保留文件并带回两次 retcode。
- **真机已验证（2026-10-24 16:5x，新会话）**：
  模型调用 `qq_send_voice` → 工具回执 `语音已发到 QQ（49 字）：已发送语音（baidu，96KB，via=base64，retcode=0）`
  → QQ 收到语音条。也就是**合成、回执、NapCat 转码三段全通了**（`retcode=0`，走的 base64 没降级）。

### 3. 网页搜索：不是白名单，是缺 DeepSeek API Key；web_fetch 是个别站点被墙

- **证据**：`web_search` 报 `DeepSeek search has no API key for "DEEPSEEK_API_KEY"…`；
  `~/.dsh/.credentials.yaml` 里只有 `OPENCODE_GO_API_KEY`，没有任何 DEEPSEEK 键。
  `web_fetch` 本身没坏：`https://techcrunch.com/` 成功；`https://news.ycombinator.com/`
  **TCP 443 直接超时**（站点级不可达，不是证书、不是插件 bug）。
- **修法**：Config 新增 `webSearch.{apiKey, baseUrl, model}`，
  「技能与插件 → 网页搜索」齿轮弹窗里可填；桥接每 2 秒轮询 `/config` 时顺手把 Key 写进
  DSH 的 `web-search-deepseek` settings namespace（字段名是 **baseURL**，大写 URL），
  填完最多 2 秒生效、不用重启。Key 留空则**不动** DSH 现有配置。
  弹窗里同时说明：web_fetch 走 DSH 的代理策略，而策略只读**启动环境变量** ——
  想让本机代理（如 `127.0.0.1:7890`）生效，得用 `HTTPS_PROXY=…` 重启 DSH，插件改不了运行中的进程。
- **前提**：DeepSeek 搜索要 DeepSeek Platform 的 Key（或用 DeepSeek 账号登录的会话）。
  没有 Key 时把「网页搜索」技能关掉更诚实，模型会直接说搜不了。

## 许可

MIT。与 DeepSeek 官方无隶属关系。
