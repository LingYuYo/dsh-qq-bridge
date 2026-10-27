# dsh-qq-bridge

把 QQ 接进 [DeepSeek Harness](https://github.com/deepseek-ai)：QQ 私聊/群消息变成 DSH 会话里的用户消息，agent 的回复发回 QQ。

**每个 QQ 会话对应一个独立的 DSH 会话**，统一归组到「QQ 聊天」工作区。QQ 会话固定用 `qq-chat` preset，由本仓库的 `@local/dsh-qq-guard` 插件提供**执行期工具门禁**（deny-by-default），确保 QQ 那头的人拿不到本机执行能力。

```
QQ ──► NapCat (OneBot v11 正向 WS) ──► qq-bridge ──► DSH Web API
                                        ▲                  │
                                        └── agent 回复 ─────┘
```

## 版本演进

当前版本：**v0.5.5**（2026-10-27）

**本版做了什么**：修两个丢人的体验 Bug —— 模型把「内部说明」当正文发到群里、
表情包抢在文字前面弹出。

- **占位符泄露**：真机发过 `[无文字回复，已在同一条里发了表情包]`。这不是桥接文案，
  是模型看到 `qq_send_image` 的工具结果后自己编的舞台提示。两道防线：提示词与工具
  描述明确禁止复述发图 / 写方括号说明；发送前 `stripMetaNotes()` 兜底清洗，整行括号
  说明整行删、行内括号说明抠掉，清洗后为空就不发文字（只发图，**不补占位提示**）。
  普通方括号内容（`[CQ:...]`、`【公告】`）不动。
- **图文顺序**：模型是在一轮进行途中调发图工具的，旧逻辑立刻发 → 群里先弹表情包、
  后弹文字。现在本轮内收到的图片任务先排队（工具回执说「已排队」），本轮文字发完后
  隔 350ms 再发；本轮没文字就只发图。戳一戳那条链路本来就是这个顺序。
- **回归**：离线自测 247 条全绿（新增 5 条：清洗规则 2 条、文字→350ms→图、
  只有图不补提示、清洗后为空什么都不发）。

上一版（v0.5.4，2026-10-27）：修引用回复的**并发串台** —— 群里 A、B 几乎同时说话时，回复可能引用错人，
或者干脆没有引用。

- **根因**：不是变量污染，是**防抖合并**。旧逻辑把窗口内**不同人**的消息并进同一轮 prompt，
  而一轮回复只能挂一个 `reply` 段 —— 于是「引用了 B 的原消息，回答的却是 A 那句」；
  回复再被拆成多个气泡时只有第一片带引用，第二片看起来就「没有引用」。
- **修法 1（分批）**：`_enqueue` 发现**发送者换了**就先把上一批立即投递，再单开新的一批；
  同一个人连发多条仍然合并（那本来就是他一个人的一轮）。
- **修法 2（快照）**：投递前把 `msg` / `texts` / `images` 各拷一份交给 `_processBatch`，
  本轮引用的 `message_id` 在投递那一刻就固定下来；之后再进新消息只会开新 entry，
  绝不可能改到这一轮。超时 / 报错提示走的也是同一份快照。
- **回归**：离线自测 242 条全绿（新增 4 条并发用例：A/B 同时说话各引各的、跨群并发、
  同一人连发仍合并、上一轮超时错误提示仍引 A 的消息）。

上一版（v0.5.3，2026-10-27）：群聊**引用回复** —— 群友 @ 机器人时，回复改成 QQ 的「引用气泡」（气泡上方带原消息），
同时保留「仅 @ 对方」的旧模式，做成设置页开关。

- **配置**：「全局设置 → 群聊与标点」新增 `replyQuoteMode`（`quote` 引用原消息（默认）/ `at` 仅 @），
  2 秒热同步，改完下一条消息生效。
- **入站**：`onebot.mjs` 解析消息时本来就带 `message_id`，这次把它透传到发送侧。
- **出站**：`bridge._send` 判断开关后给 `sendGroup` 传 `replyTo`，`_buildSegments` 在段数组
  **最前面**插 `{ type:'reply', data:{ id } }`；分片回复只有第一片带引用，后续纯文本。
- **互斥**：引用模式下不再重复 @（引用气泡已经指回原消息）；拿不到 `message_id` 时自动退回 @。
  私聊不受影响（私聊没有引用气泡）。
- **回归**：离线自测 238 条全绿（新增 10 条：段顺序 / 只挂第一片 / 私聊忽略 / 空 id 兜底 /
  开关热读 / 白名单）。

上一版（v0.5.2，2026-10-27）：群聊**上下文自动清理** —— 群聊攒到 150 轮以上（累计近 4M token）时模型回复
会飙到 20s+，现在按轮数设闸门，到点自动压缩或清空，**只对群聊生效，私聊永不清理**。

- **配置**：设置页「全局设置 → 高级参数」新增 `maxContextTurns`（默认 30 轮，0 = 不限制）与
  `contextClearStrategy`（`compact` 自动总结压缩（默认）/ `clear` 自动清空 / `off` 关闭），
  跟其它高级参数一样 2 秒热同步，改完下一条群消息生效。
- **触发点**：桥接在 `_processBatch` 里、**准备发给模型之前**才查一次轮数（
  `session/projections` 的 `turnOutline`），不开任何后台定时器。
- **压缩优先**：DSH 有原生 `/compact`（`@deepseek-ai/dsh-command-compact` + `dsh-compaction-basic`），
  桥接通过 `commands/execute` 投递该命令（RPC `session/compact` 并不存在）。压缩是**同一会话内**
  把历史折成一条摘要，所以标题 / 模型 / 人设 / 单群配置全都不用搬，群友无感。实测 6 轮 / 约 1200 token
  压一次 33s（那一条回复会明显变慢，上限 90s）。
- **降级**：本机 DSH 没装压缩、压缩报错（busy / 摘要不比原文小）或超时 → **静默**降级成
  「归档旧会话 + 新建同名会话」，人设 / 模型 / 单群活跃配置照旧继承，全程不给群里发任何提示。
- **为什么要基线**：DSH 压缩只 shadow prompt surface，日志与 `turnOutline` 轮数**都不会变短**；
  所以阈值用 `ctxBaseTurns` 快照相减，否则压缩完每句话都会再清一次。
- **回归**：离线自测 228 条 bridge 断言全绿（新增 16 条：私聊不触发 / 压缩成功 / busy 重试 /
  两次 busy 降级 / 基线前移 / 阈值边界 / 静默红线 / 旧 state 兼容 / clear 复用不变），
  guard 侧 20 + 9 条全绿。

上一版（v0.5.1，2026-10-24）：修 v0.5.0 的真机盲点——**老 QQ 会话拿不到新工具**（模型说「没有发图工具」）。

- **根因**：DSH 会把每个会话**首次 `request/header`** 冻成工具基线，之后新增的工具只以
  `tool-addition` 增量下发。v0.5.0 之前建的 QQ 会话，基线里没有 `qq_send_image`；在
  `opencode-go/deepseek` 这条路由上模型始终看不到它（真机验证：同一句话在**新建** qq-chat
  会话里模型会正常调用 `qq_send_image`，在老会话里连显式点名都拒绝）。重启 DSH **不够**——
  工具基线随会话历史持久化。
- **修复**：guard 的 `/config` 新增 `toolEpoch`（工具能力版本）；桥接给每条会话记下建会话时的
  epoch，发现不一致就在**下一条消息**时把该会话的 DSH 上下文自动重建一次（旧会话归档、**不删历史**），
  新工具随之进入基线。启动时会**同步拉一次热配置**，避免重启后第一条消息仍落在旧基线。
- **顺带**：人设签名纳入 `features`（设置页刚打开技能时【能力】段会立刻重推）；系统提示词新增
  【工具可用性（以本段为准）】权威块，压掉自定义人设/历史里「这里没有发语音/发图工具」这类过时说法；
  `qq_send_image` 描述明确「对方要图就直接调用，别回答没有发图工具」。
- **开关**：不想自动重置上下文的话，在 `qq-bridge/config.json` 写
  `{ "capability": { "autoRefreshOnUpgrade": false } }`，之后需要自己「清空上下文」一次。
- **回归**：离线自测 204 条 bridge 断言 + guard 全量全绿（新增 epoch 重建 / 权威能力段 / 启动同步 9 条）。

上一版（v0.5.0，2026-10-24）：四项 P2 收口 —— 发图片、外部插件真实生效、桥接性能、UI 手感。

- **发图片 / 表情包**：新增 `qq_send_image` 工具（官方 `defineTool` 编译参数，`url` / `file` 二选一），
  桥接用 OneBot `image` 段发送并**等回执**再回答模型（下载/拒收的失败原因原样抛给模型）。
  设置页「技能与插件」新增 `sk-image`（老配置里没有也显示，默认开），系统提示词同步引导模型使用。
- **外部插件真实生效（P2）**：启用「自包含」外部插件后沙箱进程常驻；桥接收消息时把
  `message` / `before-context` 事件转发进沙箱执行插件 hook（可改写文本、丢弃消息、追加外部上下文）；
  插件 `registerTool()` 注册的工具自动代理成 `qq_ext_<slug>` 暴露给 QQ 会话（沙箱单飞 + 10s 超时）。
  失败一律 best-effort，不影响聊天；`GET /dsh-qq-guard/external/runtime` 可看常驻状态 / 已加载 hook 与工具。
- **桥接性能**：模型路由 / 人设下发按签名去重（配置没变不再每条消息 POST）、会话存在性正结果缓存 30s、
  图片 ingress 后台预取（并发 2 / LRU 32 / TTL 60s，复用 in-flight Promise）、TTS 语音指令脱离主串行链。
- **UI 手感**：开关与保存改为**乐观更新**（点击立刻生效，写盘失败回滚并报错）、输入框改失焦 / 回车保存、
  2–3 秒轮询全部下沉到叶子组件（切 Tab / 轮询不再带着整个面板重渲染）、耗时按钮加纯 CSS spinner。
- **回归**：离线自测扩到 260+ 条（新增发图 / hook / 性能 / 乐观更新断言），全绿。

上一版（v0.4.0，正式版，2026-10-24）：把 QQ 桥接从「能跑但一堆静默失效」推到「人设、语音、搜索三条主链路都真机打通」。

- **人设真的生效了（两轮才查到底）**：
  - 第一轮的 P0 —— guard 的 preset 作用域判定用错 API，`applyGuard()` 第一步就 return，
    人设 section / `qq_send_voice` / restrict / 执行期白名单**四件事全没跑**（当时 QQ 会话
    既没有系统人设、也没有执行期门禁）。改成 `composedPreset` + `restrict` 探针两层判定、
    兜底 fail-closed，并新增「真宿主 + 真实 mountPreset」的回归测试。
  - 第二轮 —— 系统提示词里确实是我们的 `complete` 人设（6554 字实锤），provider 也不覆盖
    system（直连 API 验证）。真正盖掉它的是 `dsh-mnemon`：把 USER.md / MEMORY.md 快照当
    **user 消息**插进每一步。现在 guard 在 **agent 创建之后**用 `{prepend:true}` 挂到
    `agent.ctx` 上，把这类消息摘掉。**这也是隐私修复**：此前群友对话能让模型读到主人的长期记忆。
    （顺序陷阱有真 cordis 对照实验：装载时 prepend / push 都会泄漏，只有「agent 创建后 prepend」干净。）
- **语音真机打通**：微软 Edge 朗读接口已被端拒（握手 403 / WS 1006，上游改用 `Sec-MS-GEC v2`）。
  换成免 Key 的 **baidu** provider（默认），edge 失败自动降级；`qq_send_voice` 改成**等桥接回执**，
  失败直接抛错给模型。真机回执：`已发送语音（baidu，96KB，via=base64，retcode=0）` → QQ 收到语音条。
- **网页搜索可配**：根因不是白名单，是缺 `DEEPSEEK_API_KEY`。「网页搜索」齿轮里可填
  Key / baseUrl / model，经 `/config` 热同步写进 DSH 的 `web-search-deepseek`，2 秒生效。
- **单群独立响应档位**：每个群可单独配 0–3 档（落盘 `sessions.json` 的 `activityLevel`，
  `null` = 跟随全局），私聊不受影响。
- **技能与插件齿轮接真实 Config**：发语音（后端 / 音色 / Key）、防抖、频控、网页搜索都能在卡片里改；
  未实装条目明确标「开发中」并给出原因。
- **其它**：`qq_send_voice` 用官方 `defineTool()` 编译参数、`web_search` 补挂载、
  人设不再每 2 秒重复推送、Host 会话上报白名单补齐 `persona`/`activityLevel`。

上一版（v0.3.1-alpha，同日早些时候）：guard 在 preset 内整体失活（P0）、`qq_send_voice`
非法 schema、`web_search` 未挂载、人设每 2 秒重复推送、单群独立响应档位、技能配置弹窗。

更早（v0.3.0-alpha）：

- **多模态与交互**
  - **群聊 @ 文本格式修复**：入站把 `at` 段转成 `@昵称 `（拿不到昵称退回 `@QQ号 `），并保证与正文之间有一个空格。
  - **图片理解实装**：下载 QQ 图片转 Base64（或直接使用 URL），按 DSH 多模态格式投递；带模型能力探测与纯文本降级。
  - **TTS 发语音工具注册（WIP）**：`qq_send_voice` + Edge TTS / OpenAI 兼容 TTS，经 NapCat `record` 段发送。
- **配置自由度**
  - **打字延时分档阈值可自定义**：短句上限 / 中等上限 / 长句触发三个字数边界（默认 10 / 14 / 15）与三档毫秒基准都能在设置页改。
  - **人设支持自定义命名**：选中自定义人设后可直接改名字，保存写回 `personaPresets`。
  - **活跃设置防抖 / 限频实装**：防抖窗口、每分钟上限、超限静默、指令禁言全部按真实配置生效；并受「防抖合并 / 频率控制」插件开关控制。

上一版（v0.2.0-beta.1）：

- **模型无痕热切换**：`agent/request` 瀑布里按会话覆写本次请求的 provider/model，不碰 `session/selectModel`、不改 DSH 全局默认；`POST /dsh-qq-guard/model` 为桥接下发的入口。
- **静默看门狗 + 失败降级**：`llm/stream` 上看门狗把「模型挂着不吐字」翻成终态错误，`agent/request-error` 在同一轮内切到备用模型；`GET /dsh-qq-guard/system-events` 暴露最近 20 条底层事件。
- **模型自我认知**：人设里动态注入【底层模型】路由行，QQ 里问「你用的什么模型」能如实回答。
- **NapCat 日志可见**：stdout/stderr 接环形缓冲，面板可看「起不来」的真实原因。
- **一键启动接真实路由**：左下角卡片按 NapCat → 桥接顺序拉起，状态灯读真实进程。
- **高级参数**：`replyTimeoutMs` / `modelWatchdogMs` / `antiDebounceMs` 进配置与设置页，桥接热读。

更早（v0.1.1-beta.1）：

- **外部插件兼容层**：只读扫描 QQ Agent 格式（`plugin.json` / `skill.json`），支持动态配置表单，默认全部关闭。
- **沙箱执行基础链路（P1）**：`ctx.subprocess` 独立进程 + `--permission` + `module.registerHooks` 拦截 `node:fs` / `node:child_process` / 越界引用，支持对自包含模块执行 `setup()` 冒烟测试。
- **人设系统重构**：概览卡片 + 独立编辑弹窗，支持机器人名字、参与度、管理员附加规则、系统提示词覆盖，桥接层拼接逻辑同步更新。
- **UI 布局收尾**：左下角一键启动卡片、记忆整理面板、外部插件卡片描述裁剪与过滤。

## 已知问题 (Known Issues)

> 2026-10-24 的四个真机 Bug **已全部修复**，根因与验证见
> [`plugins/dsh-qq-guard/README.md`](plugins/dsh-qq-guard/README.md) 的「2026-10-24 修复记录」一节。
> 下面保留现状待办，都是「离线验不到、必须真机跑一次」的项目。

- **语音链路已真机跑通**（2026-10-24 16:5x）：`已发送语音（baidu，96KB，via=base64，retcode=0）`，
  NapCat 收 mp3 base64 并转成 QQ 语音条。若哪天换 edge/openai 后端失败，失败原因会经回执
  回到模型与日志（不会静默）。
- **`web_search` 要 DeepSeek API Key**：已在「技能与插件 → 网页搜索」加了配置入口
  （写入 DSH 的 `web-search-deepseek`），没配 Key 时工具会如实报
  `WEB_PROVIDER_CREDENTIAL_MISSING`，别把它当「插件没接上」。
- **个别站点 web_fetch 连不上是网络层**（如 news.ycombinator.com TCP 超时）。
  DSH 的代理策略只读启动环境变量，要用本机代理得 `HTTPS_PROXY=…` 重启 DSH。
- **人设的上下文过滤要重启 DSH 才生效**（Host 侧改动）：第二轮修法是通过
  `agent/created` 给每个 agent 挂监听，插件热重载不会重挂已存在的 agent，
  必须重启一次让新会话走新代码。验证看 QQ 会话是否还会冒出 USER.md 的内容。
- **桥接进程改完要重启一次**：TTS provider、回执 detail、单群档位都是桥接侧改动，
  进程不重启还是旧逻辑（设置页改完能落盘，但旧进程不认新字段）。

## 仓库结构

```
plugins/dsh-qq-guard/     DSH 插件（Host + 浏览器半身）
  ├─ index.js             qq-chat preset 的工具门禁 + 设置页数据路由 + 状态路由
  ├─ client.js            设置页 UI（分片节奏 / 群聊 @ / 标点处理 / 进程管理）
  ├─ cordis.patch.yml     bundle patch：插入 qq-chat preset + 顶层 settings 行
  ├─ napcat.mjs           NapCat 进程管理（启动 / 停止 / 三层在线判定）
  ├─ bridge-runner.mjs    桥接进程管理（autoStart / 单实例 / 崩溃重启上限）
  ├─ sandbox/             外部插件沙箱执行链路
  │   ├─ protocol.mjs     Host ↔ 子进程的 NDJSON 协议（零依赖、两侧共用）
  │   ├─ manager.mjs      Host 侧：拉起子进程 / 超时 / 熔断 / testLoad + invoke
  │   └─ child.mjs        子进程入口：--permission + registerHooks 拦危险内置模块
  └─ test-*.mjs           离线回归（假 ctx / 假 subprocess，不真起进程）

qq-bridge/                独立桥接进程（零 npm 依赖）
  ├─ start.mjs            入口：读配置 → 起桥接 → 打印状态
  ├─ src/onebot.mjs       OneBot v11 正向 WS 客户端（文本分片 / 语音 / 图片）
  ├─ src/dsh.mjs          DSH Web API 客户端（离线铸会话 Cookie）
  ├─ src/bridge.mjs       主逻辑：白名单 / 串行投递 / 回复审计 / 图片预取
  ├─ src/external-hooks.mjs  外部插件 hook 客户端（message / before-context，best-effort）
  ├─ src/runtime-config.mjs  从插件轮询热配置
  └─ test-offline.mjs     离线自测（不连 QQ、不启 NapCat、不碰 DSH 会话）
```

两份代码要一起用：插件负责门禁和设置页，桥接负责收发消息。

## 两个组件各自做什么

### `plugins/dsh-qq-guard`

1. **工具门禁**（`role: guard`，装在 `qq-chat` preset 内）
   - `tools.restrict`：把危险工具从该作用域的工具清单里隐藏；
   - `tools.guard`：执行期白名单兜底，任何不在白名单内的调用一律拒绝。
   - **必须装在 preset 子行**：顶层 `tools.guard` 是全局的，会把浏览器里的正常会话一起锁死。这个坑在代码注释里写了来龙去脉。
2. **设置页**（`role: settings`，装在 profile 顶层）：分片节奏、气泡长度、群聊 @ 位置、标点处理、白名单、人设、外部插件、NapCat / 桥接进程管理。
3. **HTTP 路由**：`/dsh-qq-guard/config`（桥接轮询热更新）、`/dsh-qq-guard/status`（状态上报）、`/dsh-qq-guard/napcat`、`/dsh-qq-guard/bridge`、`/dsh-qq-guard/external-plugins/test`（沙箱冒烟测试）、`/dsh-qq-guard/external/hook`（桥接转发的插件 hook，best-effort）、`/dsh-qq-guard/external/runtime`（常驻沙箱快照）。
4. **沙箱**：外部插件一律在独立子进程里加载执行，绝不 import 进 DSH 主进程。P2 起启用的自包含插件会**常驻**，hook 调用与 `registerTool()` 的工具执行都只在子进程内发生（单飞 + 超时熔断）。

### `qq-bridge`

- 零 npm 依赖，只用 Node 内置 `WebSocket` / `fetch`（Node ≥ 22）。
- 鉴权不靠抓日志：从 `~/.dsh/.credentials.yaml` 里持久化的 `client-connection/browser-session` 签名密钥**离线铸造**会话 Cookie。权限等同浏览器会话，所以**白名单不是可选项**。
- 安全边界：白名单（fail-closed）+ 回复审计（本机路径 / 凭据特征 / `sk-` Key / 桥接令牌 → 整条不发）+ 同会话串行投递。
- 单实例锁：两个桥接同时连 NapCat 同一条 WS 会重复收消息，所以抢锁失败直接让位。
- **发图片 / 表情包**：`qq_send_image` 入队 → 桥接用 OneBot `image` 段发送（http(s) URL 由 NapCat 下载，也接受 `base64://` / `file:///` / 绝对路径），**等回执**才算成功，失败原因回给模型。
- **外部插件 hook**：`message` / `before-context` 事件转发给 Host 常驻沙箱执行（可改写文本 / 丢弃消息 / 追加外部上下文），HTTP 失败或超时一律按原样放行。
- **性能**：模型路由与人设下发按签名去重、会话存在性正结果缓存 30s、图片 ingress 预取（并发 2 / LRU 32 / TTL 60s）不阻塞主队列、语音指令脱离主串行链。

## 安装

**前提**：Node ≥ 22、运行中的 NapCat（开好正向 WS 服务端）、运行中的 DSH 桌面端。

```bash
# 1) 插件：以 link 方式装进 profile（路径换成你放本仓库的位置）
dsh plugin --profile desktop add "link:<本仓库>/plugins/dsh-qq-guard"

# 2) 重启 DSH（bundle 层要重启才组装）

# 3) 桥接：复制配置再改
cp qq-bridge/config.example.json qq-bridge/config.json
node qq-bridge/start.mjs --dry-run   # 只校验配置 + DSH 鉴权，不连 QQ
node qq-bridge/start.mjs             # 正式启动
```

`qq-chat` preset 由 `cordis.patch.yml` 自动插入，不需要手改 profile yaml。

### 配置要点

`qq-bridge/config.json`：

| 字段 | 说明 |
| --- | --- |
| `dsh.sessionCwd` | QQ 会话落在哪个工作区目录（必填） |
| `onebot.wsUrl` / `onebot.accessToken` | NapCat 正向 WS 地址与令牌，两边必须一致 |
| `allow.private` / `allow.groups` | 白名单。**留空 = 谁都不理**（刻意的默认值） |
| `deny` | 黑名单，优先级高于白名单 |

插件设置页的优先级高于 `config.json`：桥接每条消息现读热配置，改设置不用重启。

## 自测

```bash
node qq-bridge/test-offline.mjs
```

覆盖回复审计、消息解析（array / 字符串 / 混合段）、长文本分片、分气泡、群聊 @、热配置同步、白名单热读、人设写入、DSH 端口自动跟随、在线探测四态、单实例锁、图片发送、外部插件 hook、模型/人设去重与图片预取，并串跑插件侧回归（门禁作用域 / 设置页数据通路 / NapCat 进程管理 / autoStart / 沙箱协议与子进程 / 外部插件扫描与卡片 / 发图片工具 / 外部 hook 与工具代理）。

不连 QQ、不启 NapCat、不碰 DSH 会话。插件侧用例需要 `@deepseek-ai/schemastery`，用 `QQG_SCHEMASTERY` 指向它的 `lib/index.mjs`（不设就自动探测 `node_modules`）。

## 已知限制

- 图片 / 表情包**发送**已实装（`qq_send_image`）；接收侧表情等仍以 `[表情]` 占位符进入文本。
- 不把 `ask_user_question` 与工具审批转发到 QQ。
- 未实现 `/reset` 等斜杠命令。
- 人设改动只对**新建** QQ 会话生效，已有会话保留原人设与上下文。
- NapCat 安装目录**必须显式配置**（`napcat.dir`），仓库不含任何机器相关默认值。
- **外部插件只允许「自包含」模块常驻 / 执行**，受控模块仍需 shim 才能加载。工具代理在 DSH 生命周期内没有可靠的注销入口：停用插件后 `qq_ext_*` 可能残留在工具清单里（执行时会校验加载状态并拒绝）。
- **外部插件 hook 是 best-effort**：沙箱没起 / 插件没声明对应 hook / 超时，都按原样继续，不保证执行；单插件 1.5s、整体 2s 预算。
- **沙箱是单进程串行的**：某个插件的 hook / tool 死循环会把后续 invoke 一起拖到超时，直到熔断（5 分钟）或重启沙箱才恢复。
- **沙箱不提供网络能力**：子进程没有 `net` / `http` / `fetch` 的放行，外部插件不能联网。

## 参考项目与致谢

- [**K0nd1us/QQ-agent**](https://github.com/K0nd1us/QQ-agent) —— 「立志做使用起来最简单、功能最全面的 LLM 机器人」，MIT。
  一个跑在自己电脑上的 QQ 群聊机器人，Electron 桌面壳 + 事件驱动 / 无状态会话架构，控制台零编程门槛。
  本项目的**外部插件清单格式（`plugin.json` / `skill.json`）**与「测试运行」交互参考了它的设计。
- [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) —— QQ Agent 的上游原型，OneBot 桥接的最初形态。

感谢这些项目把踩过的坑摊在明面上。

## 许可

MIT，见 [LICENSE](LICENSE)。
与腾讯、NapCat、DeepSeek 官方均无隶属关系；使用你自己的账号接入 QQ 所产生的一切后果，由你自行承担。

## 开发流程（本仓库是唯一写入点）

改代码只在这个仓库里改，线上运行的那两份是从这里同步过去的副本：

```powershell
# 1. 在仓库里改，跑测试
node qq-bridge/test-offline.mjs        # 要 0 失败

# 2. 提交
git add -A; git commit -m "..."; git push

# 3. 同步到线上（默认预演，只打印差异不动文件）
..\sync-to-live.ps1
..\sync-to-live.ps1 -Apply             # 真同步：先跑测试，绿了才写，写前自动备份
```

同步脚本在**工作区根**（不在本仓库里），因为它要同时知道仓库和线上两边的位置。
它会：跳过 `qq-bridge/config.json` 与 `state/`、把 `cordis.patch.yml` 里的占位符
回填成线上的真实值、覆盖前备份到 `<线上>/.sync-backup/<时间戳>/`。
