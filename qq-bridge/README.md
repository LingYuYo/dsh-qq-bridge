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
| `allow.admins` | 管理员 QQ 号数组：只有这些人能发 `/` 开头的指令；其他人直接回「权限不足」，不投递 DSH。管理员不绕过白名单。 |
| `allow.allowAllWhenEmpty` | **默认 `false`（fail-closed）**：白名单为空时谁都不理。 |
| `replyTimeoutMs` | 等回复超时，**默认 20s**。超时会顺手 `session/cancel` 取消 DSH 这一轮（否则前端一直转「深度求索中」），并给 QQ 回一句失败提示。 |
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


### 人设（2026-10-23 改为动态 section）

人设字段：`personaText`（角色设定）、`personaBotName`（机器人名字）、
`personaGroupName`（群内展示名）、`personaParticipation`（quiet / normal / active）、
`personaExtraRules`（管理员附加规则）、`personaSystemPrompt`（系统提示词覆盖）、
`personaDefault`（preset 内置默认正文，来自插件 `cordis.patch.yml` 的 guard 子行）。

`composePersonaPrompt()` 仍在桥接层负责拼最终文本：

1. `personaSystemPrompt` 非空 → 原样覆盖，其余字段不追加；
2. 否则 base = `personaText`，为空回落到 `personaDefault`；
3. 有名字 / 展示名 → 追加身份行，并把默认人设里的 `DeepSeek` 替换成 `personaBotName`；
4. 追加参与度规则；
5. 追加管理员附加规则；
6. 有模型路由时追加【底层模型】行。

**注入方式变了（不再写 profile patch）**：

- preset 里已删掉静态 `dsh-persona` 行；改由 `role: guard` 实例注册
  `deployment:persona-prefix` 动态 section（`complete: true`）。
- 桥接通过 Host 路由 `POST /dsh-qq-guard/persona` 推文本：
  - 全局：启动 / 设置页变化时 `{mode:'default', text}`；
  - 单人设：**每条消息前** `{sessionId, text}`（单人设 > 全局；没配单人设时推全局文本）。
- 为什么每条消息都推：DSH 重启后插件内存态会丢，而桥接不重启；每轮重推即可自愈，
  代价只是一次本地 HTTP。
- 非管理员发言时，推送的文本末尾追加「拒绝清空记忆/重置会话/改配置」的提示
  （`ADMIN_GUARD_NOTE`），所以同一个人设可以按发言人切换行为，不用往对话里塞系统消息。
- **生效范围**：不再是「只对新建会话生效」——动态 section 每次组装现读，保存后下一条消息即生效。
- 「恢复默认人设」= 单人设置空 → 桥接回落到全局 → 全局为空则用 `personaDefault`。

**2026-10-24 补充：人设「被无视」的真因不在这一层。**
实测确认系统提示词里**就是**人设（`system/message` 6554 字，`complete: true` 生效），
provider（opencode-go）也不会覆盖 system 提示词（直连 API 注入人设，模型照做）。
真正盖掉人设的是宿主 `dsh-mnemon`：它在 `agent/pre-step` 里把 USER.md / MEMORY.md 快照当
**user 消息**插进每一步，模型优先照记忆演。guard 现在会把这类消息（`source.kind='dsh-mnemon'`）
从 QQ 会话里摘掉 —— 这同时是隐私修复：群友对话不该带主人的长期记忆。
排查开关：插件 Config `debugPrompt=true` 或 `QQG_PROMPT_DEBUG=1`，会打印
`[Persona Debug] session=… sections=[名字:字数] contexts=[…]`。

### 管理员权限（/ 指令）

- `allow.admins`（数组，设置页「白名单管理 → 管理员 QQ 号」）。
- 收到以 `/` 开头的消息：发送者不在名单 → 回 `⚠️ 权限不足，只有管理员才能执行此指令。`，
  **不投递 DSH**，未读清零；在名单 → 正常投递（等 DSH/后续指令实现处理）。
- 管理员身份**不绕过白名单**：不在 `allow.private` / `allow.groups` 里，普通消息仍会被挡。
- 配置每次现读（热更新），改完下一条生效。

### 会话指令（清空 / 删除 / 单人设保存）

UI 无法直接改 `state/sessions.json`（桥接会覆盖），所以走「队列 + 轮询」：

```
UI → POST /dsh-qq-guard/session-ops {op,key,text?}   （Host 队列，30s 租约，5 分钟 TTL）
桥接每 2s → GET 同一路由 → 执行 → POST {results} 回执
```

- `clear`：归档旧会话（`stopActivity: true`，否则活跃会话归档失败）→ 同工作区建新会话
  → 重新对齐标题 → 未读清零；归档失败也继续建。
- `delete`：归档旧会话（同样 stopActivity）+ 删除本地映射；归档失败仍删映射。
- `persona`：写 `sessions.json` 的 `persona` 并立即推送。
- `activity`：写 `sessions.json` 的 `activityLevel`（`0..3` 或 `null`=跟随全局），见「单群独立响应档位」。
- 轮询器在 `src/session-ops.mjs`，失败只记一次 warn，不影响聊天。

### 批量修正历史标题

```bash
node tools/rename-sessions.mjs            # 预演（默认）
node tools/rename-sessions.mjs --apply    # 真改（逐条串行 + 80ms 间隔）
```

只改有映射且标题不符的会话；计划函数在 `src/rename-plan.mjs`（离线用例覆盖）。

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

## 模型下发（无痕热切换 + 失败降级）

模型**不再**走 `session/selectModel`（那个会顺带把选择落盘成 DSH 全局默认，
`dsh-api-session-controller/lib/types/commands.js:175`）。链路改成：

1. 面板「模型配置」写进插件 Config（`model` / `modelFallbacks`），桥接 2 秒内热同步；
2. 桥接在 `ensureSession()` 和**每条消息 `prompt` 之前**都调一次 `_applyModel(sessionId)`，
   把 `POST {sessionId, provider, model, reasoningEffort?, fallbacks?}` 发给
   `/dsh-qq-guard/model`（幂等；配置留空则发 `{mode:'default'}` 强制跟随全局默认）；
3. 插件在 `agent/request` 瀑布里覆写这一次请求的 route，DSH 全局默认一动不动。

失败降级：主模型超时 / 429 / 5xx / 审核拒绝时，插件用 `agent/request-error` 在同一轮内
切到 `modelFallbacks` 里的下一个（`{kind:'retry'}` 让循环重跑本步）。备用最多 4 个。
下发失败（插件没装 / 旧版本 / 模型不可用）只记一条 warn，**不阻塞聊天**，
这一轮退回会话当前模型。

优先级：设置页的 `model` > `config.json` 里的 `dsh.provider/model/reasoningEffort`（旧配置兜底）。

### 模型自我认知

人设里会动态追加一行：

```
【底层模型】你当前由 DSH（DeepSeek Harness）提供驱动，底层模型路由为 {provider}/{model}。
用户问起你用的是什么模型时，照这个路由回答；不要编造别的型号，也不要透露其它系统配置。
```

`composePersonaPrompt({ modelRoute })` 负责拼这行，`modelRoute` 来自 `bridge._modelRoute()`
（与 `_applyModel` **同一套优先级**，保证「人设里说的」和「实际请求的」一致）。

落地细节：
- 启动时先写一次（用 `config.json` 兜底，DSH 没起来也有身份行）；
- **首次设置同步成功后必须再写一次校准** —— 启动瞬间 `live` 还没有设置页下发的 `model`，
  不校准就会把旧路由写进人设。`start.mjs` 用 `firstSyncDone` 标记做这件事。
- 人设签名（`PERSONA_KEYS`）里含 `model`，设置页换模型会触发热重写。
- 只对**新建** QQ 会话生效；已有会话保留原人设。

### 高级参数（热读）

设置页「全局设置 → 高级参数」有三个时间常数，桥接每 2 秒轮询热读，改完下一条消息生效：

| 字段 | 用法 | 优先级 |
|---|---|---|
| `replyTimeoutMs` | `promptAndWait` 的等待上限（默认 20000） | 设置页 > `config.json` > 20000 |
| `modelWatchdogMs` | 只用于**日志提示**：等待超过它就打 `⏳ 等待回复已超 N 秒，可能正在触发看门狗降级…`（真正的切断在 Host 插件里） | 设置页 > `config.json` > 8000 |
| `antiDebounceMs` | 防抖合并窗口；0 = 沿用 `rhythm.debounceWindowMs` | 高级参数 > 节奏参数 |

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
  **单个群可以覆盖这个档位**（2026-10-24）：见下节。
- **debounceWindowMs**：同一会话（`u:<QQ号>` / `g:<群号>`）窗口内的连续消息用换行拼接成
  一次 prompt，窗口内没有新消息才投递。串行队列（`queues.run`）语义不变，仍然绝不并发。
  入站合并只影响**发给模型**的文本，与「模型原生换行不合并」的发送红线无关。
- **rateLimit**：每会话 60 秒滑动窗口，容量 = `perMin + burst`；只统计**真正发出去了**
  的回复。超限时 `silent=true` 静默丢弃，`false` 则回一句「慢一点」提示（提示不计入回复数）。
- **mute**：文本命中 `words` 任一词就把该会话静音 `seconds` 秒（内存态，重启清空）。
  禁言指令本身不回复，静音期内所有消息都不回。

### 单群独立响应档位（2026-10-24）

全局 `rhythm.activityLevel` 是**默认值**，每个群可以单独覆盖：

- 字段：`state/sessions.json` 里每条会话多一个 `activityLevel`
  —— `null`（或省略）= 跟随全局，`0..3` = 该群独立档位。`normalizeSessionEntry` 负责归一化，
  脏值（非数字 / 越界）一律退回 `null`，宁可跟随全局也不要被脏数据静音。
- 生效：`Bridge._activityLevelFor(key)` 单群 > 全局；`shouldRespond(msg, text, key?)`
  的 `key` 可选（老调用自动 `keyOf(msg)`），跳过日志里会打印**实际生效**的档位。
- 写入：设置页发 `{op:'activity', key, level}`（Host 队列 → 桥接 2 秒轮询），
  `applySessionOp` 落盘并返回 `{ok:true, action:'activity', key, activityLevel}`；
  非法 level 返回 `{ok:false, error:'bad-level'}`，不静默改成「跟随全局」。
- **先配置、后聊天**也成立：key 还没建会话时 `_entryOf` 建占位记录；
  `_loadState` 的空壳清理规则对「只配了档位」的 key 放行，否则重启一次设置就丢了。
- 上报：`sessionViews()` 的行里带 `activityLevel`，Host 的 `sanitizeSessionRow()` 白名单也要放行它
  （它曾经把这个字段裁掉，导致 UI 永远显示「跟随全局」）。

### 会话失效自动归档

`state.sessions` 里的映射在 DSH 侧已不存在时（`sessionExists` 为 false），重建前会
**best-effort** 归档旧会话：`dsh.archiveSession(oldId)`。规则：

- 归档失败**不阻塞重建**（QQ 用户还在等回复），失败的旧 id 记进 `state.stale`（去重，最多 100 条）；
- `dsh.archiveStaleSessions=false` 时完全不归档，只把 id 记进 `state.stale`；
- 只归档「已失效的旧会话」，**绝不**碰仍映射着的会话，也不清空任何会话历史；
- 重试入口是 `Bridge.cleanupStale({ archive = true })`：遍历 `state.stale` 逐个归档，
  成功的移出，返回 `{ ok, archived, failed, remaining }`（由 Host 设置页路由调用）。

### 会话标题与未读（设置页「会话管理」的真实数据源）

`state/sessions` 的值从「裸 sessionId 字符串」升级成对象；旧文件**读入时自动迁移**，
不丢映射、不需要手工改：

```json
"sessions": {
  "u:1234567890": {
    "sessionId": "session-105cd393-…",
    "unread": 0,
    "kind": "private",
    "qq": "1234567890",
    "name": "翎羽",
    "title": "私聊-翎羽",
    "lastAt": 1792471261621,
    "lastText": "小鱼下午好",
    "nameAt": 1792471261621,
    "activityLevel": null,
    "persona": ""
  }
}
```

`activityLevel`：单群响应档位，`null` = 跟随全局 `rhythm.activityLevel`（见「单群独立响应档位」）。
`persona`：单人设覆盖，空串 = 沿用全局人设。

**强制命名**（`Bridge._ensureSessionTitle`）：

- 规则由 `sessionTitleFor` 统一：`私聊-昵称` / `群聊-群名(群号)`（群号必带，同名群在侧栏无法区分）。
- 建会话后**立刻**调 DSH 的 `session/rename`。一旦标题以 `source: 'user'` 落盘，
  DSH 自己的自动标题（fallback / LLM）就不会再覆盖它；DSH 那个「向」就是这么来的——
  实测日志里 fallback 是「小鱼下午好」，标题 LLM 返回了单字「向」。
- 接管已有会话时只在「标题没对齐过」时再改一次；DSH 每次 rename 都会 resume 会话，不能每轮都调。
- 昵称 / 群名来源：私聊 `get_stranger_info`（失败退消息事件里的 `sender.card||nickname`），
  群聊 `get_group_info`（群名不在消息事件里）。缓存 `NAME_TTL_MS=30min`，
  失败退回号码，**命名失败绝不阻塞聊天**。

**未读**（`_noteIncoming` / `_noteReplied`）：

- 通过白名单的消息一律 `unread+1` 并更新 `lastAt` / `lastText`（80 字预览），
  包括随后被响应档位跳过 / 静音 / 限频的——红点语义是「有人找你」，不是「模型回没回」。
- 只有**真的发到 QQ** 才清零；发送失败、超时、被安全策略拦下（但仍回了提示语）都按实际发送结果处理。
- 数据随 `/dsh-qq-guard/status` 的 `sessions` 字段上报（`buildBridgeStatus`），Host 再给设置页轮询。

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
6. **打字延时**：按分片**码点数**分级 —— 默认 <10 字 200ms / 10~14 字 450ms /
   15+ 字 800ms，±15% 抖动，下限 150ms。emoji 代理对算 1 个码点、不拆。
   三档的**字数边界**（`typingDelayCharTiers.shortMax/mediumMax/longMin`）与
   **毫秒基准**（`flypitDelayTiers.short/medium/long`）都可在设置页改，桥接 2 秒内热读；
   边界写反（如 20/10/5）会被归一化成单调递增，不会出现分档错乱。

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
  { "type": "text", "data": { "text": " 这一片的正文" } }
]
```

注意 `text` 段**开头有一个空格**（2026-10-23 修）：OneBot 的 at 段本身不携带空白，
两个段紧挨着会渲染成「@群友收到」，模型和群友都会看错。

不带 @ 的分片仍是纯文本字符串。代码块 / URL 作为原子块原样放进 `text` 段，不被破坏。

**入站 @**（也是 2026-10-23 修）：收到群消息时，`at` 段转成 `@昵称 `（拿不到昵称就
`@QQ号 `，`@all` → `@全体成员 `），与后面的正文之间一定有空格。昵称来源是
「同一个群里最近说过话的人」的内存缓存，不额外打 NapCat API；没说过话就退回 QQ 号。


**间隔优先级**：`typingDelay.enabled=true`（默认）走上面的**分级延时**，
`sendIntervalMs` 不生效；置 `false` 时不分片、不延时、整条合并发送，
`sendIntervalMs` 作为兜底固定间隔（此时只剩 1 条，实际用不到）。

`rhythm.batchIntervalMs`（默认 2500ms）是**下限**：相邻气泡取
`max(原间隔, batchIntervalMs)`，所以调整它不会让气泡发得比分级延时更快。
重试同一片时用原间隔，不受批次间隔影响。

> 审计顺序不变：**先对全文做审计，命中则整条不发**，之后才拆分。

## 图片理解 / 发语音 / 技能开关（Phase 6，2026-10-23）

设置页「技能与插件」的开关不再只是 UI：Host 把六个已实装开关算成 `features`
（`voice / vision / search / guard / debounce / rateLimit`）随 `/dsh-qq-guard/config`
下发，桥接每 2 秒热读。未同步到时按默认（全开）走。

### 图片理解（sk-vision）

- 收到 `type: "image"` 段时，`onebot.mjs` 把它单独抽成 `images[]`（`url` / `file` / `size`），
  `text` 里仍保留 `[图片]` 占位（日志/审计用）。
- 桥接按 `url`（没有就 `file`）下载：支持 http(s) / `data:` / `base64://` / `file://` /
  绝对路径；单张 ≤ 8MB，一条消息最多 4 张；只接受 PNG / JPEG / GIF / WebP（DSH 附件的白名单）。
- 下载后转成 DSH prompt content 的 image part：
  `[{ type:'text', text }, { type:'image', data:<canonical base64>, mediaType }]`，
  走 `session/prompt` 投递给模型。
- 三道闸：技能关闭 / 模型未声明支持 image / 图片下载失败 → **退回纯文本**并附一句
  「你看不到图片内容，别编造」，绝不让模型假装看见。
- DSH 的 admission 按**会话当前选择**的模型校验图片能力（无痕模型覆写不改会话选择），
  所以被拒时会自动降级重试一次纯文本。新会话的**第一条**消息如果就是图片，可能会
  走到这条降级；先聊一句文字后就会按覆写路由放行。
- 纯图片消息（没有文字）不再被丢弃：文本兜底为「（对方只发了图片，没有文字）」。

### 发语音（sk-voice）

- guard 实例在 preset 作用域注册 `qq_send_voice` 工具（`text` 必填，`voice` 可选），
  执行时只把任务入队（`sessionId + text + voice`）——插件不碰 NapCat。
  **2026-10-24 起工具会等桥接回执**：入队后阻塞到 `session-ops` 的 `{results:[{id,ok,detail}]}`
  回来，成功返回 `{sent:true, detail}`，失败直接 `throw`，25s 没回执也抛错。
  以前「入队即成功」害模型在语音其实没发出去时回复「发出去了」。
- 桥接轮询会话指令时执行 `voice` op：按 `sessionId` 反查 QQ 会话 key → TTS 合成 →
  `send_group_msg` / `send_private_msg` 的 `record` 段（`base64://...`）发送；
  base64 失败会自动落盘 `state/voice-<ts>.mp3` 用 `file://` 重发一次，
  两次都失败保留文件并把两次 retcode 一起带回。
- TTS 实现 `src/tts.mjs`，零 npm 依赖：
  - **`baidu`（默认，免 Key）**：`GET https://fanyi.baidu.com/gettts?lan=zh&...`，回 mp3；
    单次上限 200 字（超限本地报错，不静默截断）；
  - `edge`：微软 Edge 朗读 WebSocket。**2026-10-24 起被微软端拒**（握手 403 / WS 1006，
    上游已改用 `Sec-MS-GEC v2` 签名）；配置里还是 edge 时桥接会**自动降级 baidu 重试一次**，
    日志与回执都写明降级；
  - `openai`：任意 OpenAI 兼容 `POST /v1/audio/speech`（baseUrl + apiKey）。
- 单条上限 240 字（约 60 秒）。mp3 → QQ 语音的转码由 NapCat 完成；NapCat 不支持时
  发送会失败，失败原因经回执回到模型（provider / 体积 / via / retcode 都在 detail 里）。
- 技能关闭时工具执行期直接拒绝（guard 层）。

### 发图片 / 表情包（sk-image，P2）

- guard 实例在 preset 作用域注册 `qq_send_image` 工具（`url` / `file` 二选一），
  执行时只把任务入队（`sessionId + url/file`），跟 `qq_send_voice` 一样**等桥接回执**
  （20s 上限）：成功回 `{queued, sent, id, detail}`，失败直接抛，detail 是可读原因。
- 桥接轮询到 `op:'image'` 后：按 `sessionId` 反查 QQ 会话 key → `features.image` 门禁 →
  `send_group_msg` / `send_private_msg` 发 `[{ type:'image', data:{ file } }]`。
  `file` 原样交给 NapCat：http(s) URL 由它自己下载，`base64://` / `file:///` / 绝对路径同样原样传。
- **图片不参与文本分片、不碰换行**；群聊发图**不带 @**（图片不需要 @ 人也看得见）。
- 成功 detail 例：`已发送图片（via=url，retcode=0）`；失败 detail 带 `via` + `retcode`/`status`。
- 找回会话失败（刚 delete / 重建）时 detail 会提示「让用户先发条 QQ 消息」。
- 开关：设置页「技能与插件 → 发图片」；老配置里没有 `sk-image` 时按**默认开启**兼容
  （`normalizeFeatures` 缺 `image` 也是 true），关闭时工具执行期直接拒绝。

### 网页搜索（sk-search）

- 开启：guard 执行期放行 `web_search` / `web_fetch`（DSH 原生联网工具）；
- 关闭：执行期拒绝。人设里也会多一行「可以联网检索」的能力说明，只在开启时出现。
- **2026-10-24：web_search 要 DeepSeek API Key**。`dsh-web-search-deepseek` 的密钥顺序是
  literal `apiKey` → `credentials.resolve('DEEPSEEK_API_KEY')` → launch env → DeepSeek 账号登录态；
  本机 credentials 只有 OPENCODE_GO_API_KEY，所以补了设置页入口：插件 Config 的
  `webSearch.{apiKey,baseUrl,model}`，通过 `/config` 热同步时写进 DSH 的
  `web-search-deepseek` settings namespace（字段名 `baseURL`），填完 2 秒生效。
- `web_fetch` 不需要 Key，但它走 DSH 的代理策略（`@deepseek-ai/dsh-http-proxy`），
  而策略只读**启动环境变量**（`http_proxy`/`https_proxy`/`no_proxy`）：
  个别站点（如 news.ycombinator.com）在本机直连是 TCP 超时，要让本机代理生效只能
  `HTTPS_PROXY=http://127.0.0.1:7890` 重启 DSH —— 插件改不了运行中的进程环境。

### 工具门禁 / 防抖 / 限频（pl-*）

- `pl-guard` 关闭 = **显式放弃执行期白名单**（schema 层 `restrict` 仍隐藏全局危险工具，
  但 agent-scope 工具不再被 guard 拦）。设置页有高风险提示，默认开启。
- `pl-debounce` 关闭：不再攒防抖窗口，消息立即投递。
- `pl-ratelimit` 关闭：不做每会话每分钟限频。

## 外部插件 hook（P2，2026-10-24）

设置页「外部插件」里 `externalPlugins.enabled` 非空时，桥接会在两个时机 POST
`${dsh.baseUrl}/dsh-qq-guard/external/hook`（Host 的常驻沙箱去调插件）：

| event | 时机 | 能做什么 |
|---|---|---|
| `message` | 通过白名单后、入队/防抖之前 | `text` 改写本轮正文；`drop:true` 直接丢弃（计 `stats.skipped`，记一条 info） |
| `before-context` | `_processBatch` 拼好 prompt、真正投递之前 | `text` 替换本轮正文；`sections:[{title,text}]` 按顺序拼成 `\n\n[外部上下文：<title>]\n<text>` 追加到正文**之后**（不动人设） |

设计取舍：

- **best-effort**：HTTP 失败 / 超时（2.5s）/ `ok:false` 一律只 warn（连续失败只提示一次），
  聊天照常，绝不因为外部插件丢消息；
- **两条 HTTP 上限**：`externalPlugins.enabled` 为空时一条都不发；路由回 `modules:[]`
  后该事件 30 秒内不再请求（按事件分开缓存，`message` 没有 hook 不影响 `before-context`）；
- 桥接**不做工具代理**：`qq_ext_*` 由 Host 在 preset 作用域自行注册。

## 桥接性能（P2，2026-10-24）

目标：无效网络请求清零、慢操作不阻塞主链路。全部是内存态，重启即清。

- **模型 / 人设去重**：`_applyModel` 按 `sessionId|provider/model|effort|fallbacks` 签名，
  `_applyPersona` 按 `sessionId + 人设正文 + 是否管理员` 签名；同签名直接跳过 POST。
  设置页改配置 / 新建会话自然换签名；保存单人设时清对应缓存立即重推。失败不写签名 → 下条消息重试。
- **会话存在性缓存**：`ensureSession` 的 `sessionExists` **正结果**缓存 30 秒
  （负结果不缓存，失效要立刻重建）；重建 / clear / delete 清对应 sessionId。
- **图片 ingress 预取**：收到消息立刻后台下载（最多并发 2、LRU 32、TTL 60s），
  `_loadImageParts` 复用同一个 in-flight Promise，不重复下载、不阻塞入队；
  失败按 TTL 缓存并在组装 prompt 时 warn 跳过。
- **voice / image op detached**：`session-ops` 轮询器里 `voice`（TTS 合成 + 上传）与
  `image`（下载 / 转码 / 上传）都不再串行阻塞 `clear` / `delete` / `persona`；
  两者完成后回执照常单独回传（Host 按 id 消费，`DETACHED_OPS` 定义在 session-ops.mjs）。
- 统计计数（`bridge.stats`，测试与排障用）：`modelPushes` / `personaPushes` /
  `sessionChecks` / `skippedRequests`（被去重或缓存省掉的请求数）/ `hookCalls` /
  `hookDrops` / `hookSkipped`。
- 红线不变：换行 / 分片逻辑（`splitBubbles` / `_buildSegments`）一行没动；
  `promptAndWait` 轮询节奏也没动。

## 工具能力升级：旧会话自动重建上下文（v0.5.1）

**症状**：v0.5.0 后，**已有的 QQ 会话**里模型坚持说「没有发图工具」。

**根因**：DSH 会话把**首次 `request/header`** 冻成工具基线，之后新增工具只以 `tool-addition`
增量下发；`opencode-go/deepseek` 路由上模型拿不到增量声明。重启 DSH 不会重建基线
（它跟会话历史一起持久化），只有新建会话（清空上下文）才有效。

**桥接的处理**：

- Host `/config` 下发 `toolEpoch`（发布新工具时递增，当前 `v0.5.1-2026-10-24-qq_send_image`）。
- `state/sessions.json` 每条会话记 `toolEpoch`；`ensureSession` 发现不一致 →
  **归档旧会话 + 重建上下文一次**（不删历史，`stats.capabilityRefreshes++`），新工具进基线。
- `start.mjs` 启动时 `syncConfigOnce()` 先同步拉一次热配置，重启后的第一条消息就能触发重建。
- 新建 / 清空上下文的会话立即写入当前 epoch，不会反复重建。
- 关掉自动重建：`config.json` 加 `{ "capability": { "autoRefreshOnUpgrade": false } }`
  （之后需要自己在设置页「清空上下文」一次）。

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
node test-offline.mjs   # 主回归（含 P2：发图片 / 外部 hook / 性能去重）
node test-tts.mjs       # TTS 通路 + voice op detail + voice detached 不阻塞
node test-timeout.mjs   # 等待超时：默认 20s / 超时必 session/cancel / 错误码 TIMEOUT
```

覆盖回复审计、消息解析（array / 字符串 / 混合段）、长文本分片、分气泡（强边界 / 语义切 /
原子块 / 分级延时）、群聊 @ 回复、DSH 设置热同步、白名单热读、人设写入、DSH 端口自动跟随、
客户端接口面、**纯 WS 在线探测四态（批次 5）**、**单实例锁（批次 5）**、
**P2 发图片 / 外部插件 hook / 请求去重与图片预取**，并串跑插件侧回归：
`plugins/dsh-qq-guard/test-guard-scope.mjs`（防全局锁死）、
`plugins/dsh-qq-guard/test-settings-data.mjs`（设置页数据通路）、
`plugins/dsh-qq-guard/test-napcat.mjs`（NapCat 进程管理）、
`plugins/dsh-qq-guard/test-autostart.mjs`（autoStart / 单实例 / 崩溃重启上限）、
`test-persona.mjs`（人设写入不丢插件）。
**不连 QQ、不启 NapCat、不碰 DSH 会话。** 当前基线（2026-10-24 v0.5.1）：`204 通过 / 0 失败`
（bridge 五个测试文件：204 / 16 / 31 / 13 / 6，全绿）。

## 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动即 `DSH 鉴权失败` | DSH 没运行、端口探测失败且兜底 baseUrl 不可达、或 `~/.dsh/.credentials.yaml` 不可读。 |
| `QQ 上毫无反应` | 白名单为空且 `allowAllWhenEmpty=false`（看日志的 warn）；或 NapCat 正向 WS 没开/端口不符。 |
| 收到消息但从不回复 | 看日志有没有 `处理 ... 失败`；多半是 DSH 侧会话创建失败或等回复超时。 |
| 回复被拦 | 日志会写命中哪条规则（`本机路径`/`凭据特征`…），这是有意的。 |

## 已知限制

- 只处理文本（图片/表情转成 `[图片]`/`[表情]` 占位符），不做图片理解与语音。
  2026-10-23 已接图片理解与 TTS（WIP），真机问题见插件 README 的
  「待修复（2026-10-24 真机测试记录）」——人设 section 未生效、人设每 2 秒重复推送、
  `qq_send_voice` 不在工具列表、`web_search` 未接上。明天继续。
- 不转发 `ask_user_question` 提问与工具审批到 QQ（与 qq-bridge 不同，本期未实现）。
- 未实现 `/reset` 等斜杠命令。
- 会话映射存 `state/sessions.json`，DSH 侧会话被归档后会自动重建。
- 人设改动**只对新建会话生效**：已有 QQ 会话保留原人设与上下文，不会被重建或 recompose；
  想让老会话换人设需归档会话后重发消息（或删 profile patch 里的人设覆盖块并重启 DSH）。
