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

profile 顶层实例持有配置，投影到「设置 → QQ 桥接」：

- **分片节奏**：`chunkSize`、`bubbleMaxChars`、`mergeMaxChars`、`sendIntervalMs`、`typingDelay`、`flypitDelayTiers`
- **群聊 @**：`groupAtReply`、`groupAtPosition`
- **标点处理**：`trimEndPunctuation`
- **白名单**：`allow.private` / `allow.groups` / `deny` / `allowAllWhenEmpty`
- **人设**：`personaText`（留空用 preset 内置人设）
- **NapCat 进程管理**：`napcat.dir`（**必填**，本仓库不含任何机器相关默认值）、`napcat.quickLoginQQ`、启动 / 停止
- **桥接进程管理**：`bridge.dir`（留空用同仓库 `qq-bridge/`）、`bridge.autoStart`、启动 / 停止

改完即时生效（桥接轮询 `/dsh-qq-guard/config` 热更新），只有换插件代码才需要重启 DSH。

## HTTP 路由

| 路由 | 用途 |
| --- | --- |
| `GET /dsh-qq-guard/config` | 桥接定时轮询，做热配置同步 |
| `GET/POST /dsh-qq-guard/status` | 桥接上报状态，前端读状态灯 |
| `GET/POST /dsh-qq-guard/napcat` | NapCat 进程启停与状态 |
| `GET/POST /dsh-qq-guard/bridge` | 桥接进程启停与状态 |

`status` / `napcat` / `bridge` 路由只接受同源请求（校验 `sec-fetch-site`），非 GET 之外的方法返回 405。

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
node test-autostart.mjs       # autoStart / 单实例 / 崩溃重启上限
```

全部离线，用假 ctx / 假 subprocess。`test-guard-scope.mjs` 与 `test-autostart.mjs` 需要 `@deepseek-ai/schemastery`：用 `QQG_SCHEMASTERY` 指向它的 `lib/index.mjs`，不设就自动探测 `node_modules`。

`qq-bridge/test-offline.mjs` 会串跑这四组。

## 许可

MIT。与 DeepSeek 官方无隶属关系。
