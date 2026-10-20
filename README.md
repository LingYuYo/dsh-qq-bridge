# dsh-qq-bridge

把 QQ 接进 [DeepSeek Harness](https://github.com/deepseek-ai)：QQ 私聊/群消息变成 DSH 会话里的用户消息，agent 的回复发回 QQ。

**每个 QQ 会话对应一个独立的 DSH 会话**，统一归组到「QQ 聊天」工作区。QQ 会话固定用 `qq-chat` preset，由本仓库的 `@local/dsh-qq-guard` 插件提供**执行期工具门禁**（deny-by-default），确保 QQ 那头的人拿不到本机执行能力。

```
QQ ──► NapCat (OneBot v11 正向 WS) ──► qq-bridge ──► DSH Web API
                                        ▲                  │
                                        └── agent 回复 ─────┘
```

## 仓库结构

```
plugins/dsh-qq-guard/     DSH 插件（Host + 浏览器半身）
  ├─ index.js             qq-chat preset 的工具门禁 + 设置页数据路由 + 状态路由
  ├─ client.js            设置页 UI（分片节奏 / 群聊 @ / 标点处理 / 进程管理）
  ├─ cordis.patch.yml     bundle patch：插入 qq-chat preset + 顶层 settings 行
  ├─ napcat.mjs           NapCat 进程管理（启动 / 停止 / 三层在线判定）
  ├─ bridge-runner.mjs    桥接进程管理（autoStart / 单实例 / 崩溃重启上限）
  └─ test-*.mjs           离线回归（假 ctx / 假 subprocess，不真起进程）

qq-bridge/                独立桥接进程（零 npm 依赖）
  ├─ start.mjs            入口：读配置 → 起桥接 → 打印状态
  ├─ src/onebot.mjs       OneBot v11 正向 WS 客户端
  ├─ src/dsh.mjs          DSH Web API 客户端（离线铸会话 Cookie）
  ├─ src/bridge.mjs       主逻辑：白名单 / 串行投递 / 回复审计
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
2. **设置页**（`role: settings`，装在 profile 顶层）：分片节奏、气泡长度、群聊 @ 位置、标点处理、白名单、NapCat / 桥接进程管理。
3. **HTTP 路由**：`/dsh-qq-guard/config`（桥接轮询热更新）、`/dsh-qq-guard/status`（状态上报）、`/dsh-qq-guard/napcat`、`/dsh-qq-guard/bridge`。

### `qq-bridge`

- 零 npm 依赖，只用 Node 内置 `WebSocket` / `fetch`（Node ≥ 22）。
- 鉴权不靠抓日志：从 `~/.dsh/.credentials.yaml` 里持久化的 `client-connection/browser-session` 签名密钥**离线铸造**会话 Cookie。权限等同浏览器会话，所以**白名单不是可选项**。
- 安全边界：白名单（fail-closed）+ 回复审计（本机路径 / 凭据特征 / `sk-` Key / 桥接令牌 → 整条不发）+ 同会话串行投递。
- 单实例锁：两个桥接同时连 NapCat 同一条 WS 会重复收消息，所以抢锁失败直接让位。

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

覆盖回复审计、消息解析（array / 字符串 / 混合段）、长文本分片、分气泡、群聊 @、热配置同步、白名单热读、人设写入、DSH 端口自动跟随、在线探测四态、单实例锁，并串跑插件侧四组回归（门禁作用域 / 设置页数据通路 / NapCat 进程管理 / autoStart）。

不连 QQ、不启 NapCat、不碰 DSH 会话。插件侧用例需要 `@deepseek-ai/schemastery`，用 `QQG_SCHEMASTERY` 指向它的 `lib/index.mjs`（不设就自动探测 `node_modules`）。

## 已知限制

- 只处理文本；图片/表情转成 `[图片]` / `[表情]` 占位符，不做图片理解与语音。
- 不把 `ask_user_question` 与工具审批转发到 QQ。
- 未实现 `/reset` 等斜杠命令。
- 人设改动只对**新建** QQ 会话生效，已有会话保留原人设与上下文。
- NapCat 安装目录**必须显式配置**（`napcat.dir`），仓库不含任何机器相关默认值。

## 许可

MIT，见 [LICENSE](LICENSE)。
与腾讯、NapCat、DeepSeek 官方均无隶属关系；用你自己的账号做事，后果自负。
