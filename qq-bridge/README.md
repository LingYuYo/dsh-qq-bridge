# QQ ↔ DSH 桥接

把 QQ 消息接进 DeepSeek Harness：QQ 好友/群发来的消息变成 DSH 会话里的用户消息，
agent 的回复发回 QQ。

**每个 QQ 会话（私聊/群）对应一个独立的 DSH 会话**，统一归组到「QQ 聊天」工作区。
QQ 会话固定用 **`qq-chat` preset**，它由 `@local/dsh-qq-guard` 提供执行期工具门禁。

> ⚠️ **不要改用 `minimal` preset。** 2026-10-20 实测：DSH 的 agentPreset **不隔断
> 全局工具** —— profile 里全局挂载的 bundle（dsh-ops / dsh-mnemon / agent-team）
> 会把工具**穿透**进每个会话。我建的 `minimal` 会话实际拿到 **35 个工具**，
> 含 `ops_bash`、`pwsh`、`spawn_teammate`；而且 `minimal` 在 Windows 上
> **启用** `terminal-pwsh`/`persistent-pwsh`（bash 那条才被 win32 禁用）。
> 也就是说：只选 preset 挡不住本地执行能力，**必须有 guard**。

```
QQ 消息 ──► NapCat (OneBot v11 正向 WS) ──► 本桥接 ──► DSH Web API (127.0.0.1:<自动探测>)
                                              ▲                    │
                                              └── agent 回复 ────────┘
```

## 依赖

- Node ≥ 22（本机 24.12.0）。**零 npm 依赖**，只用 Node 内置 `WebSocket` / `fetch`。
- 运行中的 NapCat，且开好**正向 WebSocket 服务端**。
- 运行中的 DSH 桌面端。

## 配置

### 1. NapCat：开正向 WS

配置文件（本机实测路径，`napcat.mjs` 把 configPath 定为 `binaryPath\config`）：

```
<NapCat 安装目录>\versions\9.9.33-52230\resources\app\napcat\config\onebot11_<QQ号>.json
```

在 `network.websocketServers` 里加一项（`websocketClients` 是反向 WS，本方案不用）：

```json
{
  "enable": true,
  "name": "dsh-qq-bridge",
  "host": "127.0.0.1",
  "port": 3001,
  "token": "CHANGE_ME_随机令牌",
  "messagePostFormat": "array",
  "reportSelfMessage": false,
  "heartInterval": 30000,
  "reconnectInterval": 3000
}
```

改完**重启 NapCat** 生效。

### 2. 桥接：config.json

```bash
copy config.example.json config.json
```

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | DSH 地址。端口自动跟随；`2852` 仅作兜底，实际端口以探测结果为准（见 `src/dsh.mjs` 的 `discoverDshBaseUrl`）。 |
| `dsh.sessionCwd` | QQ 会话的工作目录（会被自动创建）。 |
| `dsh.agentPreset` | **必须是 `qq-chat`**，由 `@local/dsh-qq-guard` 提供工具门禁；不要用 `minimal`/`standard`。 |
| `dsh.provider` / `model` / `reasoningEffort` | 会话使用的模型；填错只打警告，不阻塞。 |
| `onebot.wsUrl` / `accessToken` | NapCat 正向 WS 地址与 token，须与 NapCat 配置一致。 |
| `allow.private` | 允许的私聊 QQ 号数组。 |
| `allow.groups` | 允许的群号数组。 |
| `allow.allowAllWhenEmpty` | **默认 `false`（fail-closed）**：白名单为空时谁都不理。 |
| `replyTimeoutMs` | 等回复超时，默认 180s。 |
| `sendDelayMs` | 整条回复发送完后的尾部延时；片间延时见下面「分片与打字延时」。 |
| `chunkSize` | **QQ 单条硬上限**，默认 1000；只用于防「一条太长发不出去」。 |
| `bubbleMaxChars` | 单行**语义切阈值**，默认 30；换行是气泡边界。 |
| `mergeMaxChars` | 参与合并的短行上限，默认 15。 |
| `sendIntervalMs` | **兜底**固定间隔，默认 500ms；仅当 `typingDelay.enabled=false` 时生效。 |
| `typingDelay.enabled` | 打字延时总开关，默认 `true`。见下面「分片与打字延时」。 |
| `trimEndPunctuation.enabled` / `.keep` | 是否裁片尾标点（默认 `true`）；`keep` 默认 `["？","！"]`。 |
| `groupAtReply` | 群聊回复是否 @ 发送者，默认 `true`（私聊永不 @）。 |
| `groupAtPosition` | @ 挂在哪一片：`"last"`（默认）或 `"first"`。 |
| `dsh.archiveStaleSessions` | 会话在 DSH 侧失效时是否自动归档旧会话，默认 `true`。见下面「会话失效自动归档」。 |
| `rhythm.activityLevel` | 响应档位 `0..3`，默认 `1`。`0`=仅 @/私聊，`1`=+关键词，`2`=+随机(0.15)，`3`=全响应。见「响应节奏」。 |
| `rhythm.debounceWindowMs` | 同会话防抖合并窗口（ms），默认 `800`；窗口内连发多条合并成一次 prompt，`0`=关闭。 |
| `rhythm.batchIntervalMs` | 多气泡之间的最小间隔（ms），默认 `2500`；`0`=沿用分级打字延时。 |
| `rhythm.rateLimit.perMin` / `.burst` / `.silent` | 每会话每分钟回复上限（默认 12）、允许突发（默认 3）、超限是否静默（默认 `true`）。 |
| `rhythm.mute.enabled` / `.words` / `.seconds` | 禁言指令开关（默认 `true`）、词表（默认 `["闭嘴","安静","别刷屏"]`）、时长秒（默认 60）。 |

> **优先级**：DSH 设置页 > `config.json`。没有内置默认值，`napcat.dir` 必须显式填。
> 桥接每 2 秒轮询设置页，改完约 2 秒内生效，**不需要重启桥接**。
> `config.json` 里的值只是启动初值与 DSH 不可达时的回退。
> 例外的两类，改动**需要重启桥接**：
> - OneBot 连接（`onebot.*`）：WS 在启动时建立，不做热重连（为 4B 做准备）；
> - DSH 地址（`dsh.*`）：同上。

### 在 DSH 里改参数

设置界面有**三个入口**，都是同一份配置：

| 入口 | 位置 |
| --- | --- |
| **主侧边栏图标**（推荐） | 左侧竖排图标栏，气泡图标「QQ 桥接」，点开后中间是完整面板 |
| **设置面板内页** | 左下角「设置」→ 左侧导航「QQ 桥接」 |
| 插件页卡片 | 设置 → 插件 → QQ 桥接 详情页（二级） |

面板内部是**左侧分类导航 + 右侧内容区**，分类如下：

| 分类 | 内容 |
| --- | --- |
| 运行状态 | 启动/停止/退出桥接三个按钮、桥接进程存活、DSH 连接、NapCat/QQ 在线状态（纯 WS 四态）、收发计数、最近日志 |
| NapCat 管理 | 启动 / 停止按钮、三层在线状态、当前账号、安装目录与快速登录号 |
| OneBot 连接 | WS 地址、Access Token（密码形式，可切换显示）、HTTP API 地址（可选，桥接判断在线已不需要它） |
| 白名单管理 | `allow.private` / `allow.groups` / `allowAllWhenEmpty`（列表可增删） |
| 人设配置 | 只读概览卡（名字 / 展示名 / 参与度 / 角色设定前两行）+「⚙️ 编辑人设」弹窗（人设下拉、名字、展示名、参与度、角色设定、附加规则、系统提示词覆盖） |
| 分片与节奏 | 分片阈值、分级打字延时、群聊 @、片尾标点 |

### 桥接进程管理

**为什么需要**：桥接原来只能手动开一个终端窗口 `node start.mjs`。窗口一关进程就没了，
UI 立刻显示「未知（桥接未上报）」。实测 `start.mjs` 前台能一直跑（NapCat 断开只是退避重连），
所以**不是代码崩溃，而是没有常驻机制**。

现在由插件托管（`plugins/dsh-qq-guard/bridge-runner.mjs`），同样走 `ctx.subprocess`：

- **启动**：`spawn(process.execPath, [<bridge>/start.mjs], { cwd, stdio: {stdout:'pipe', stderr:'pipe'} })`
  —— 桥接日志是唯一排障线索，所以必须 pipe 出来保留最近 40 行，不能 ignore。
- **停止**：`terminate()`，主动停止不触发自动重启。
- **退出**：停止 + 抑制后续自动重启（`runExit`）。
- **自动重启**：非主动停止且 `exitCode !== 0` 时最多重试 3 次（退避 1.5s/3s/4.5s），
  防崩溃循环刷屏；超过上限就停手并把最近日志打到 console 错误。
  **计数只在进程稳定存活 60s 后清零**（批次 5 修复：旧实现每次 `start()` 成功就清零，
  「起来几秒就崩」会变成无限重启）。
- **退出清理**：`ctx.effect(() => () => runner.stop())`，DSH 退出不留孤儿。
- **单实例锁**（批次 5）：桥接目录下的 `.bridge.lock`（原子 `wx` 创建，内容带 pid）。
  插件启动前先只读检查，已有活实例就跳过 spawn；桥接自己启动时也抢同一把锁，
  抢不到就 `exit 0` 让位。**这防的是两个桥接同时连 NapCat 同一条正向 WS → 同一条
  消息被各收一次、重复回复**。陈旧锁（pid 已死）会被下一次启动自动清掉。
- **autoStart**（批次 5 审计）：`bridge.autoStart=true` 时 DSH 启动 1.5s 后静默拉起桥接。
  定时器挂在插件 fiber 上，插件卸载/DSH 快速退出会取消，不会留下没人管的孤儿桥接；
  已有实例在跑时自动跳过（`action: "already-running-external"`）。子进程若因单实例
  主动 `exit 0`，视为「已在运行」而不是启动失败。
  **本 DSH 生命周期内只执行一次**：配置保存会触发 entry 热重载，旧实现每次保存都会
  把桥接停掉再拉起；现在用进程级标记（`Symbol.for`）跳过重载触发的 autoStart，
  改设置不会打断正在收发的桥接。
- 配置项：`bridge.dir`（留空用同仓库 `qq-bridge/`）、`bridge.autoStart`（DSH 启动时自动拉起）。

**真机验证（2026-10-20）**：

```
POST /dsh-qq-guard/bridge?action=start → 200 {"ok":true,"action":"started"}  耗时 2206ms
状态: alive=true, uptime 稳定增长, autoRestarts=0
日志: "DSH 鉴权通过 ✓" → "NapCat WebSocket 已连接" → "已登录 QQ：1000000001（昵称）"
状态上报: GET /dsh-qq-guard/status → reported:true（UI 状态灯亮起）
POST ...action=stop → 200 {"ok":true,"action":"stopped"} → alive=false, managed=false
```

**autoStart 离线验证（2026-10-21）**：`plugins/dsh-qq-guard/test-autostart.mjs`（11/11）
覆盖「1.5s 后 spawn / autoStart=false 不起 / teardown 取消定时器 / 热重载不重复拉起 /
活锁跳过 / 陈旧锁放行 / exit 0 让位 / 崩溃重启上限 / 状态路由四态入库与旧字段兼容」。
真实 DSH 启动路径的 spawn 参数与 2026-10-20 的 `POST action=start` 真机记录同一条代码路径。

### NapCat 进程管理

由**插件**（Host 侧）管进程，不内置二进制。配置项：`napcat.dir`（**必填**，本仓库不含任何机器相关默认值
）、`napcat.quickLoginQQ`。

**为什么在插件里管而不是桥接**：DSH 退出时 NapCat 不能变成孤儿进程，只有 Host 能拿到
`ctx.effect(() => () => stop())` 这层清理钩子；桥接是独立进程，退出时管不到 NapCat。

**用 `ctx.subprocess` 而不是 `node:child_process`**：

- Windows 上用 **Job Object** 托管整棵进程树（`dsh-subprocess-local/lib/index.js:770`
  `launchWindowsJob`），所以 `terminate()` 能连带收掉 NapCat 拉起的 QQ 子进程；
- 它**硬编码 `windowsHide: true`**（同文件 :781），`SubprocessSpawnSpec` 根本没有该字段；
- `graceMs` 就是 TERM→KILL 宽限期（:948 注释「TERM-to-KILL and exit-wait grace」），
  这里取 5000ms。

**启动**：先探 WS 端口，已在监听就直接复用（`action: "reused"`，不 spawn 第二个）；
否则 `NapCatWinBootMain.exe [QQ号]`（`argv[0]` 必须是绝对路径可执行文件，
`resolveExecutable` 拒绝相对路径，所以不能直接跑 `napcat.bat`）。

**停止阶梯**：`terminate()`（TERM → 5s 宽限 → KILL，含整棵树）→ 若仍未退出，
回退 `taskkill /IM NapCatWinBootMain.exe /T /F`。注意 `SubprocessHandle` **不暴露 pid**，
所以回退只能按映像名杀，属于异常路径。

**三层在线判定（NapCat 管理区专用）**：进程存活 + WS 端口 LISTENING + `get_status` 在线
且带账号，三者同时成立才是 `online`。只看进程会把「QQ 掉线但进程还在」误判成在线。
这里第三层仍走 NapCat 的 **HTTP API**（`onebot.httpUrl`，可选）；没配时状态为
`running-unverified`（**不谎报在线**）。

> 注意区分两个「在线」：**NapCat 管理区**的 `state` 是宿主视角的三层判定（可选 HTTP）；
> **运行状态区**的 `qqState` 是桥接视角，只用 WS（见下方「QQ 账号在线状态」），
> 不需要也没有碰 NapCat 的 `onebot11_xxx.json`。

状态取值：`stopped` / `external`（端口在监听但非本插件启动）/ `starting` /
`online` / `offline`（进程在跑但 QQ 未登录）/ `running-unverified`。

**真机验证记录（2026-10-20）**：

```
启动前  QQ.exe=8  NapCatWinBootMain.exe=0  3001 未监听
启动后  QQ.exe=12 NapCatWinBootMain.exe=1  3001 LISTENING   state=running-unverified
再次启动 → {"ok":true,"action":"reused"}   进程仍是 1 个，PID 不变（防双开 ✓）
停止后  QQ.exe=8  NapCatWinBootMain.exe=0  3001 未监听      state=stopped（干净退出 ✓）
```

QQ 账号 1000000001 由快速登录自动登入（NapCat 生成了 `onebot11_1000000001.json`）。

### QQ 账号在线状态（批次 5：纯 WS，不改 NapCat 配置）

**旧实现的问题**：运行状态里的 `qqConnected` 取自 `bridge.qq.connected`，那是
**WebSocket 的 readyState**。WS 建连瞬间还是 `CONNECTING(0)`，这一刻取值恒为 false；
而且它回答的是「到 NapCat 的管道通不通」，**不是「QQ 账号在不在线」**。

**现在的做法**（`src/onebot.mjs` 的 `_fetchStatus` + `src/status.mjs`）：

1. WS `open` 后，在**同一条连接**上发 `{"action":"get_status"}`，读 `data.online`；
2. NapCat 每 30s 的心跳里的 `status.online` 也会更新（免费续命）；
3. 探不到（响应缺字段 / status≠ok / 超时）→ `online=null`，报 `unverified`，
   **不谎报在线，也不谎报离线**；断开连接则回到 `unverified/disconnected`。

状态四态（上报给 Host 的 `qqState`）：

| qqState | 含义 | UI |
| --- | --- | --- |
| `online` | get_status / 心跳确认 online=true | 在线（绿） |
| `offline` | WS 通，但账号明确离线 | 已连接（QQ 账号离线，黄） |
| `unverified` | WS 通，账号状态探不到 | 已连接（账号状态未确认，黄） |
| `disconnected` | WS 未连接 | 未连接（红） |

`qqConnected` 字段保留兼容，但语义改成「**确认在线**」（只有 `online` 才为 true）。

**为什么不用 HTTP**：NapCat 的 HTTP API 要改它的 `onebot11_<QQ号>.json` —— 那是
第三方软件的本地配置，本项目红线禁止改。正向 WS 本来就连着，OneBot v11 的 action
调用走同一根连接即可，零额外配置。

**进程级验证（2026-10-21）**：用最小 WebSocket 服务端模拟 NapCat
（`tmp/verify-ws-online.mjs`，仅测试用），真桥接连上后日志：

```
NapCat WebSocket 已连接
已登录 QQ：1000000001（昵称）
QQ 账号在线（WS get_status 确认）
```

同时 `GET /dsh-qq-guard/status` 返回 `qqConnected:true`；第二个桥接实例启动会打印
`已有桥接实例在运行（pid=…），本进程退出，不重复接消息` 并 `exit 0`；
杀掉第一个后残留锁的 pid 已死，下一个桥接会自动清理并正常连上。


### 人设

人设字段（P1.5 起）：`personaText`（角色设定）、`personaBotName`（机器人名字）、
`personaGroupName`（群内展示名）、`personaParticipation`（quiet / normal / active）、
`personaExtraRules`（管理员附加规则）、`personaSystemPrompt`（系统提示词覆盖）。
桥接层 `composePersonaPrompt()` 负责拼出最终系统提示词：

1. `personaSystemPrompt` 非空 → 原样覆盖，其余字段不追加；
2. 否则 base = `personaText`，为空回落到 preset 默认人设；
3. 有名字 / 展示名 → 追加身份行，并把默认人设里的 `DeepSeek` 替换成 `personaBotName`；
4. 追加参与度规则；
5. 追加管理员附加规则。

全空时返回空串 = 删除 preset 覆盖、回落到内置人设。

**注入方式**（踩过坑，记录原因）：

- `session/prompt` **不支持**单次覆盖 system prompt —— 它的严格 schema 只接受
  `{requestId, sessionId, mode, content, clientTimeZone}` 且 `additionalProperties: false`
  （证据：`dsh-api-session-controller/lib/typert.host.js:1795`）。所以人设不可能随单条消息注入。
- 人设只能改 preset：preset 的 persona 行注册 `deployment:persona-prefix` 段落，
  且该 preset 用 `complete: true`，人设即唯一系统提示词。
- 因此桥接在检测到任一 persona 字段变化时，先 `bridge.buildPersonaPrompt()` 拼好文本，
  再**写回 profile 的用户 patch 层** `~/.dsh/profiles/<profile>/cordis.patch.yml`，
  以同 id 覆盖 `preset-qq-chat`（见 `src/persona.mjs`）。
- ⚠️ **安全约束**：patch 里同 id 的 `config` 是**整体替换**而非深合并。如果只写一个
  只含 persona 的覆盖块，会把 preset 里其余插件（`tool-ask-user` / `todo_write` /
  `qq-guard` / `compaction`）全部丢掉——**QQ 会话会失去工具门禁**。
  所以 `persona.mjs` 的做法是：从插件自己的 bundle patch 读出 preset **完整定义**，
  只替换 `persona.prefix`，再把完整定义写进用户 patch。回归用例
  `test-persona.mjs` 专门锁死这条红线（断言 `@local/dsh-qq-guard` 仍在覆盖块里）。
- **生效范围**：只对**新建** QQ 会话生效。已有会话保留原人设与上下文，不重建。
  想让老会话也用新人设：删掉 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里的人设覆盖块
  并重启 DSH，或在 DSH 里归档该会话后重发消息（会重建）。
- 「恢复默认人设」= 删除用户 patch 里的覆盖块，回落到 bundle 层默认人设。

### 实现要点（插件侧）

- Host 侧 `export const Config` 声明字段，字段必须加 `.volatile()` 才能进设置表单
  （证据：`dsh-settings` 的 `volatileForm`，非 volatile 直接返回 undefined）。
- 官方 `autoGenerate` 虽默认开启，但**目前没有已发布的客户端实现它**，所以本插件
  自带 React 页面。
- 槽位选择很关键（踩过坑）：
  - `sidebar.panellist`（id）+ `main`（key）**必须成对注册**，两者 id/key 相同，
    侧边栏才把图标和面板配上对 —— 这是「独立左侧入口」。
  - `settings.section`（id + label）是设置面板内的左侧导航项。
  - `plugins.bundle.config` 是插件详情页里的卡片，**左侧导航看不到**。
  - `settings.section` / `main` 的 ownerProps **不提供 `form`**（只有 `close`），
    所以这两个入口里改用 `remote.settings.describe()` / `.mutate()` 自建适配器；
    `plugins.bundle.config` 才由框架注入 `form`。
  - 客户端 `inject` 必须写成 `['slots', 'remote', 'remote.settings']`：
    只写 `'remote'` 时 `ctx.remote.settings` 是 `undefined`（2026-10-20 实测）。
- 跨进程两条路由（都在 Host 插件里）：
  - `GET /dsh-qq-guard/config` —— 桥接拉运行期配置（只读）；
  - `POST /dsh-qq-guard/status` + `GET` —— 桥接回推运行状态，供面板显示。
  读取有 HTTP 兜底：remote 不可用时前端改用 `GET config` 只读展示（不能改）。

## 响应节奏（Phase 4）

`rhythm.*` 每次判定都**现读热配置**（`Bridge._rhythm()`），改完下一句消息即生效，
不需要重启桥接。处理顺序固定为：

```
白名单 → 禁言指令 → 静音期丢弃 → 响应档位 → 防抖合并 → 限频 → 建会话/prompt → 审计 → 发送
```

任何一步判否都**不回复、不创建会话**（避免白给 DSH 堆会话）。

- **activityLevel**（群聊；私聊 0..3 档都永远回）：
  - `0`：只有被 @ 才回；
  - `1`：@ 或命中关键词才回（默认词表 `dsh` / `小鱼` / `机器人` / `bot`，可用 `rhythm.keywords` 覆盖）；
  - `2`：在 1 档基础上，未命中关键词时按 `rhythm.randomChance`（默认 0.15）随机回；
  - `3`：群里所有消息都回。
  @ 的判定看 OneBot 消息段里的 `at.qq` 是否等于桥接登录号；拿不到登录号时「有 at 段就算被叫」。
- **debounceWindowMs**：同一会话（`u:<QQ号>` / `g:<群号>`）窗口内的连续消息用换行拼接成
  一次 prompt，窗口内没有新消息才投递。串行队列（`queues.run`）语义不变，仍然绝不并发。
  入站合并只影响**发给模型**的文本，与「模型原生换行不合并」的发送红线无关。
- **rateLimit**：每会话 60 秒滑动窗口，容量 = `perMin + burst`；只统计**真正发出去了**
  的回复。超限时 `silent=true` 静默丢弃，`false` 则回一句「慢一点」提示（提示不计入回复数）。
- **mute**：文本命中 `words` 任一词就把该会话静音 `seconds` 秒（内存态，重启清空）。
  禁言指令本身不回复，静音期内所有消息都不回。

### 会话失效自动归档

`state.sessions` 里的映射在 DSH 侧已不存在时（`sessionExists` 为 false），重建前会
**best-effort** 归档旧会话：`dsh.archiveSession(oldId)`。规则：

- 归档失败**不阻塞重建**（QQ 用户还在等回复），失败的旧 id 记进 `state.stale`（去重，最多 100 条）；
- `dsh.archiveStaleSessions=false` 时完全不归档，只把 id 记进 `state.stale`；
- 只归档「已失效的旧会话」，**绝不**碰仍映射着的会话，也不清空任何会话历史；
- 重试入口是 `Bridge.cleanupStale({ archive = true })`：遍历 `state.stale` 逐个归档，
  成功的移出，返回 `{ ok, archived, failed, remaining }`（由 Host 设置页路由调用）。

## 分片与打字延时

**模型换行 = 气泡边界**：模型用换行分段时，桥接**不二次切**，直接按行发多条。
只有单行本身超长时才按语义切。

1. **单行超长兜底**：> `bubbleMaxChars`(30) 才切——从第 30 字向前按优先级找切点，
   前片 ≥6 字；找不到就强制 30 字切。≤15 字整块；15~30 语义完整优先整块。
2. **切点优先级**：句末标点 > 语气词后接标点/空白 > 连接词（在词前切）。
3. **合并只作用于桥接硬切的碎片**：模型**原生换行是强边界**，`收到\n马上来` 一定发 2 条，
   绝不合并；只有当一条长行被桥接切出多个短碎片时，相邻短碎片才合并（≤`bubbleMaxChars`）
   防刷屏。
4. **原子块保护**：围栏代码块、行内代码、URL、日志块（连续以时间戳/级别开头）
   **原样一次发**，不参与语义切。超 `chunkSize` 时代码块/日志块按换行切，
   URL 不拆（不做短链）。识别在 `splitBubbles` 入口做。
5. **结尾标点**：发送层裁掉每片末尾空白与标点，`？`/`！` 默认保留（可配
   `trimEndPunctuation.keep`）；代码块、链接例外。
6. **打字延时**：按分片**码点数**分级 —— <10 字 200ms / 10~14 字 450ms /
   15~30 字 800ms，±15% 抖动，下限 150ms。emoji 代理对算 1 个码点、不拆。

### 群聊 @ 回复

群聊回复默认 **@ 发送者**（私聊永不 @）。一条回复可能分成多个气泡，全 @ 会刷屏，
所以只 @ 一次：

- `groupAtReply`（默认 `true`）：群聊回复时是否 @ 发送者。
- `groupAtPosition`（默认 `"last"`，可选 `"first"`）：@ 挂在哪一片。
  `"last"` = 最后一片带 @，`"first"` = 第一片带 @。

带 @ 的那一片用 OneBot 11 **消息段数组**发送（`message` 直接传数组，比拼 CQ 码字符串稳）：

```json
[
  { "type": "at",   "data": { "qq": "发送者QQ号" } },
  { "type": "text", "data": { "text": "这一片的正文" } }
]
```

不带 @ 的分片仍是纯文本字符串。代码块 / URL 作为原子块原样放进 `text` 段，不被破坏。


**间隔优先级**：`typingDelay.enabled=true`（默认）走上面的**分级延时**，
`sendIntervalMs` 不生效；置 `false` 时不分片、不延时、整条合并发送，
`sendIntervalMs` 作为兜底固定间隔（此时只剩 1 条，实际用不到）。

`rhythm.batchIntervalMs`（默认 2500ms）是**下限**：相邻气泡取
`max(原间隔, batchIntervalMs)`，所以调整它不会让气泡发得比分级延时更快。
重试同一片时用原间隔，不受批次间隔影响。

> 审计顺序不变：**先对全文做审计，命中则整条不发**，之后才拆分。

## 运行

```bash
node start.mjs --dry-run   # 只校验配置 + DSH 鉴权，不连 QQ
node start.mjs             # 正式启动
```

`--dry-run` 会读 `~/.dsh/.credentials.yaml` 里的持久化签名密钥离线铸会话 Cookie，
再只读调一次 `agentPresets/list`。这一步不连 QQ、不发消息。

## 鉴权原理

DSH 0.1.7 起进程启动 token 只在内存、不落盘，旧版「从日志抓 token」已失效。
本桥接改用 `~/.dsh/.credentials.yaml` 里**持久化**的 `client-connection/browser-session`
签名密钥（32 字节）**离线铸造**会话 Cookie：

```
name  = dsh-auth-<base64url(sha256(authority))>
value = v1.<base64url(JSON{version,authority,issuedAt,expiresAt})>.<base64url(HMAC-SHA256)>
```

服务端只要求 cookie 名与载荷里的 `authority` 匹配 Host 头、且在有效期内。
权限与浏览器会话相同（等同 owner），所以**白名单不是可选项**。

## 安全边界

1. QQ 会话固定 `qq-chat` preset，由 `@local/dsh-qq-guard` 做两层防护：
   - `tools.restrict`：把危险工具从该作用域的**工具清单**里隐藏；
   - `tools.guard`：**执行期白名单**（deny-by-default），不在白名单内的调用一律拒绝。
2. 白名单 + 黑名单，`deny` 优先；默认 fail-closed（白名单空 = 谁都不理）。
3. **回复审计**：文本含本机路径（`C:\`、`/home/`）、凭据特征（`api_key`/`secret`/`password`）、
   `sk-` Key、桥接令牌 → **整条拦下不发送**。
4. 同一 QQ 会话**串行投递**（否则回复对不上号）。
5. 日志不打印完整 Cookie 与签名密钥。

### 门禁的实测证据（2026-10-20）

用临时探针插件**绕过模型**、直接在指定 agent 作用域内调 `ctx.tools.execute()`：

| 作用域 | 执行 `ops_bash "echo CONTROL_OK"` | 结果 |
| --- | --- | --- |
| QQ 会话（`qq-chat`） | `Error: 工具 "ops_bash" 不在 QQ 会话白名单内，已拒绝` | 🛡️ 拦截 |
| 对照会话（`minimal`） | 实际执行，输出 `CONTROL_OK` | ✅ 放行 |

`pwsh` / `ops_glob` / `write` 同样逐个验证被拒。
**结论**：guard 拦得住，且**只作用于 QQ 会话**，不误伤浏览器里的正常会话。

> 为什么必须绕过模型验证：两次诱导 QQ 会话执行 `whoami`（第二次伪装成
> 「系统联调指令」），模型都基于人设直接拒绝了，**连 tool/call 都没产生** ——
> 那种「通过」只证明人设生效，证明不了 guard。所以用了进程内直调的方式取证。

复现方式：需要一个**临时诊断探针**插件，在指定 agent 作用域里直接调 `ctx.tools.execute()`。
本仓库**不提供**它 —— 探针本身会开一个能执行 shell 的 HTTP 端点，长期挂着等于开后门，
不适合随仓库分发。要复现就临时写一个、验证完立刻卸载。

## 自测

```bash
node test-offline.mjs
```

覆盖回复审计、消息解析（array / 字符串 / 混合段）、长文本分片、分气泡（强边界 / 语义切 /
原子块 / 分级延时）、群聊 @ 回复、DSH 设置热同步、白名单热读、人设写入、DSH 端口自动跟随、
客户端接口面、**纯 WS 在线探测四态（批次 5）**、**单实例锁（批次 5）**，并串跑插件侧回归：
`plugins/dsh-qq-guard/test-guard-scope.mjs`（防全局锁死）、
`plugins/dsh-qq-guard/test-settings-data.mjs`（设置页数据通路）、
`plugins/dsh-qq-guard/test-napcat.mjs`（NapCat 进程管理）、
`plugins/dsh-qq-guard/test-autostart.mjs`（autoStart / 单实例 / 崩溃重启上限）、
`test-persona.mjs`（人设写入不丢插件）。
**不连 QQ、不启 NapCat、不碰 DSH 会话。** 当前基线：`92 通过 / 0 失败`。

## 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动即 `DSH 鉴权失败` | DSH 没运行、端口探测失败且兜底 baseUrl 不可达、或 `~/.dsh/.credentials.yaml` 不可读。 |
| `QQ 上毫无反应` | 白名单为空且 `allowAllWhenEmpty=false`（看日志的 warn）；或 NapCat 正向 WS 没开/端口不符。 |
| 收到消息但从不回复 | 看日志有没有 `处理 ... 失败`；多半是 DSH 侧会话创建失败或等回复超时。 |
| 回复被拦 | 日志会写命中哪条规则（`本机路径`/`凭据特征`…），这是有意的。 |

## 已知限制

- 只处理文本（图片/表情转成 `[图片]`/`[表情]` 占位符），不做图片理解与语音。
- 不转发 `ask_user_question` 提问与工具审批到 QQ（与 qq-bridge 不同，本期未实现）。
- 未实现 `/reset` 等斜杠命令。
- 会话映射存 `state/sessions.json`，DSH 侧会话被归档后会自动重建。
- 人设改动**只对新建会话生效**：已有 QQ 会话保留原人设与上下文，不会被重建或 recompose；
  想让老会话换人设需归档会话后重发消息（或删 profile patch 里的人设覆盖块并重启 DSH）。
