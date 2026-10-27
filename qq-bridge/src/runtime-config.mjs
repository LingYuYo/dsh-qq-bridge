/**
 * 从 DSH 插件拉取 QQ 桥接运行时配置（批次 4A）。
 *
 * 为什么需要它：桥接是**独立进程**，用户在 DSH 设置页改了参数后，桥接读不到
 * DSH 的内存值。插件 `@local/dsh-qq-guard` 暴露了一条只读路由
 * `GET /dsh-qq-guard/config`，本模块定时轮询它，把新值热应用到一个共享对象上。
 *
 * 设计取舍：
 *   · **轮询而非推送**：桥接是普通 Node 进程，没有与 DSH Host 的事件通道；
 *     轮询 2 秒一次成本可忽略（本地回环 + 几百字节 JSON），且天然自愈
 *     （DSH 重启换端口后靠现有端口探测重新跟上）。
 *   · **失败静默**：DSH 没运行 / 插件没装 / 端口还没探到，都只记一条 debug 日志，
 *     继续用 config.json 的值。绝不能因为拉配置失败而影响收发消息。
 *   · **只覆盖运行时键**：DSH 侧只下发聊天节奏参数，绝不下发 wsUrl / accessToken
 *     这类连接凭据——避免设置页成为改连别的 NapCat 的入口。
 */

/** 允许被 DSH 设置页覆盖的键（白名单，其余一律忽略）。 */
const HOT_KEYS = [
  'bubbleMaxChars',
  'mergeMaxChars',
  'chunkSize',
  'sendIntervalMs',
  'groupAtReply',
  'groupAtPosition',
  // 群聊引用回复（2026-10-27）：quote = 挂原消息引用气泡，at = 只 @ 对方。
  'replyQuoteMode',
  'typingDelay',
  'flypitDelayTiers',
  // 打字延时的字数档位（2026-10-23）：短句上限 / 中等上限 / 长句触发。
  'typingDelayCharTiers',
  'trimEndPunctuation',
  // 批次 4A-UI：白名单与人设也必须热更新。
  'allow',
  // 人设相关字段（P1.5）：桥接层用它们拼最终系统提示词。
  'personaText',
  'personaBotName',
  'personaGroupName',
  'personaParticipation',
  'personaExtraRules',
  'personaSystemPrompt',
  // preset 内置默认人设：preset 里已删静态 persona 行，正文搬到插件 Config。
  // 热同步拿到后 buildPersonaPrompt 才有兜底文本。
  'personaDefault',
  // Phase 4：节奏参数（响应档位/防抖/限频/禁言）必须热更新。
  'rhythm',
  // Phase 6：技能开关（发语音/图片理解/网页搜索/工具门禁）必须热更新 ——
  // 桥接据此决定「要不要把图片喂给模型」「要不要发语音」「防抖/限频是否启用」。
  // features 是 Host 侧按同一份逻辑算好的派生值（skills/plugins → 布尔），
  // 桥接优先用它，避免两个进程各写一套 id 判断而漂移。
  'skills',
  'plugins',
  'features',
  // 语音合成配置（provider / baseUrl / apiKey / voice）：桥接进程负责真正合成。
  'voice',
  // 模型配置（无痕热切换 + 失败降级）：设置页改完，下一条消息就按新配置下发。
  'model',
  'modelFallbacks',
  // 外部插件启用清单（P2）：桥接据此决定要不要发 hook 请求——
  // 没人启用时一条 HTTP 都不发（见 bridge._externalPluginsEnabled）。
  'externalPlugins',
  // 工具能力版本（v0.5.1）：Host 发布新模型工具时递增；桥接据此判断
  // 旧 QQ 会话的 DSH 上下文要不要重建一次（新工具进基线）。
  'toolEpoch',
  // 高级参数（排障/调优）：全部允许热改，改完下一条消息生效。
  'replyTimeoutMs',
  'modelWatchdogMs',
  'antiDebounceMs',
  // 上下文自动清理（2026-10-27）：阈值与策略，设置页改完下一条群消息就按新值判定。
  // ⚠️ 漏加进白名单 = 设置页能存、日志不报错、桥接永远收不到（pickHotConfig 静默丢键）。
  'maxContextTurns',
  'contextClearStrategy',
  // 2026-10-26 体验升级：超时文案 / 人设锁定 / 每小时归纳 / 戳一戳都要热更新
  // （用户在设置页点完开关，不该还要重启桥接才生效）。
  'timeoutReplyText',
  'personaLocked',
  'personaAutoUpdate',
  'poke',
  // 2026-10-27：合并转发读图上限 / 上下文感知（戳一戳「模型回复」注入聊天记录）。
  'quote',
  'contextAware',
  // OneBot 连接信息只用于 UI 展示；WS 连接在启动时建立，改它仍需重启桥接。
  'onebot',
]

/**
 * `dsh.*` 下允许热覆盖的子键。
 *
 * 为什么不是整个 `dsh` 进白名单：`dsh.baseUrl` / `sessionCwd` 是连接与落盘
 * 位置，绝不能让设置页改（和第 14 行「拒绝下发连接凭据」同一个理由）。
 * 这里只放行纯行为开关，按子键收窄。
 */
const HOT_DSH_KEYS = ['archiveStaleSessions']

/** 人设相关字段：任何一项变化都要重拼系统提示词（不能只盯 personaText）。 */
const PERSONA_KEYS = [
  'personaText',
  'personaBotName',
  'personaGroupName',
  'personaParticipation',
  'personaExtraRules',
  'personaSystemPrompt',
  // 默认人设变化也要重推（它决定「什么都没自定义」时的人设正文）。
  'personaDefault',
  // 模型路由会注入人设（【底层模型】一行），所以它也是人设签名的一部分：
  // 设置页换模型时必须触发一次重写，否则模型身份会落后于实际请求。
  'model',
  // 技能开关会改变【能力】段（qq_send_voice / qq_send_image / web_search 的说明）。
  // 不把 features 算进签名的话，用户在设置页刚打开「发图片」，人设里那行引导
  // 要等下一次别的变动才会更新（v0.5.1 修）。
  'features',
]

/**
 * 人设字段的稳定签名（用于避免每 2 秒重复写 profile）。
 * @param {object} source
 * @returns {string}
 */
function personaSignature(source) {
  const out = {}
  for (const key of PERSONA_KEYS) out[key] = source?.[key] ?? null
  return JSON.stringify(out)
}

/** 路由路径，与 plugins/dsh-qq-guard/index.js 的 CONFIG_ROUTE_PATH 一致。 */
export const CONFIG_ROUTE_PATH = '/dsh-qq-guard/config'
/** 状态上报路径，与 plugins/dsh-qq-guard/index.js 的 STATUS_ROUTE_PATH 一致。 */
export const STATUS_ROUTE_PATH = '/dsh-qq-guard/status'

const DEFAULT_POLL_MS = 2000
const DEFAULT_TIMEOUT_MS = 1500

/**
 * 从宿主配置里抽出可热应用的那部分（深拷贝，防止外部改到引用）。
 * @param {object} source
 * @returns {object}
 */
export function pickHotConfig(source) {
  const out = {}
  if (!source || typeof source !== 'object') return out
  for (const key of HOT_KEYS) {
    if (!(key in source)) continue
    const value = source[key]
    if (value === undefined) continue
    out[key] = typeof value === 'object' && value !== null ? JSON.parse(JSON.stringify(value)) : value
  }
  // dsh 只挑安全子键（见 HOT_DSH_KEYS），绝不整包透传。
  const dsh = source.dsh
  if (dsh && typeof dsh === 'object' && !Array.isArray(dsh)) {
    const picked = {}
    for (const key of HOT_DSH_KEYS) {
      if (key in dsh && dsh[key] !== undefined) picked[key] = dsh[key]
    }
    if (Object.keys(picked).length > 0) out.dsh = picked
  }
  return out
}

/**
 * 把 DSH 下发的值合并进桥接的运行期配置对象（原地修改，持有者不用换引用）。
 * @param {object} target 桥接的 liveConfig
 * @param {object} hot 来自 pickHotConfig 的值
 * @returns {string[]} 实际变化的键
 */
export function applyHotConfig(target, hot) {
  const changed = []
  for (const [key, value] of Object.entries(hot)) {
    const before = JSON.stringify(target[key])
    const after = JSON.stringify(value)
    if (before === after) continue
    target[key] = value
    changed.push(key)
  }
  return changed
}

/**
 * 启动时**同步拉一次**热配置（v0.5.1）。
 *
 * 为什么需要：桥接启动后的第一条 QQ 消息可能早于 2 秒轮询的第一轮。
 * 而 `toolEpoch` 决定「旧会话要不要重建上下文」——晚一拍就会让第一条消息
 * 仍落在旧工具基线上（真机踩过：重启后第一条消息依然说「没有发图工具」）。
 * 启动时拉一次，bridge.live 从 t0 起就有完整的 features / toolEpoch。
 *
 * 失败不阻塞启动：DSH 没起 / 插件没装就继续用 config.json。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} [opts.cookie]
 * @param {object} opts.liveConfig 会被原地更新的配置对象
 * @param {number} [opts.timeoutMs=1500]
 * @param {object} [opts.logger]
 * @returns {Promise<{ok:boolean, changed:string[], error?:string}>}
 */
export async function syncConfigOnce({ baseUrl, cookie, liveConfig, timeoutMs = DEFAULT_TIMEOUT_MS, logger } = {}) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '')
  if (!base) return { ok: false, changed: [], error: '缺少 baseUrl' }
  try {
    const headers = { accept: 'application/json' }
    if (cookie) headers.cookie = cookie
    const res = await fetch(`${base}${CONFIG_ROUTE_PATH}`, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    if (body?.ok !== true || !body.config) throw new Error('响应格式不符')
    const hot = pickHotConfig(body.config)
    const changed = applyHotConfig(liveConfig, hot)
    return { ok: true, changed }
  } catch (error) {
    logger?.warn?.(`启动时同步 DSH 配置失败（继续用 config.json，2 秒轮询会重试）：${error?.message ?? error}`)
    return { ok: false, changed: [], error: error?.message ?? String(error) }
  }
}

/**
 * 启动轮询。返回停止函数。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl 形如 http://127.0.0.1:6708（已探测的实际端口）
 * @param {string} [opts.cookie] DSH 会话 Cookie（路由不强制鉴权，但带上更稳）
 * @param {object} opts.liveConfig 会被原地更新的配置对象
 * @param {Function} [opts.onSync] 每次成功同步后调用（用于把值刷进客户端实例）
 * @param {Function} [opts.onPersona] 人设字段变化时调用，**必须返回（或 resolve 出）**
 *   `{ ok, action, detail }`：本模块靠 ok 推进签名，返回 undefined 会按契约违例处理。
 * @param {Function} [opts.getStatus] 返回要回推给 Host 的运行状态快照（缺省则跳过上报）
 * @param {number} [opts.pollMs=2000]
 * @param {number} [opts.timeoutMs=1500]
 * @param {{info?:Function,warn?:Function,error?:Function}} [opts.logger]
 * @returns {() => void}
 */
export function startConfigPolling({
  baseUrl, cookie, liveConfig, onSync, getStatus, onPersona,
  pollMs = DEFAULT_POLL_MS, timeoutMs = DEFAULT_TIMEOUT_MS, logger,
}) {
  const log = {
    info: (m) => logger?.info?.(m),
    warn: (m) => logger?.warn?.(m),
    error: (m) => logger?.error?.(m),
  }
  let stopped = false
  let timer = null
  // 第一次拉取前不打「配置未变」这类噪音；首次成功后记一条，说明链路通了。
  let syncedOnce = false
  // 上次写入 preset 的人设签名：避免每 2 秒重复写盘。
  let lastPersonaSignature = undefined
  // onPersona 契约违例只告警一次，避免每 2 秒刷屏（见下方 r === undefined 分支）。
  let personaContractWarned = false
  // 状态上报失败只告警一次，避免每 2 秒刷屏。
  let statusReportWarned = false
  let statusReportedOnce = false

  const url = `${String(baseUrl).replace(/\/+$/, '')}${CONFIG_ROUTE_PATH}`

  const tick = async () => {
    if (stopped) return
    try {
      const headers = { accept: 'application/json' }
      if (cookie) headers.cookie = cookie
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body?.ok !== true || !body.config) throw new Error('响应格式不符')

      const hot = pickHotConfig(body.config)
      const changed = applyHotConfig(liveConfig, hot)
      if (changed.length > 0) {
        log.info(`已从 DSH 设置同步配置：${changed.join('、')}`)
      } else if (!syncedOnce) {
        log.info('已连上 DSH 设置路由（配置无变化）')
      }
      syncedOnce = true
      // 值已写进 liveConfig；让持有者把它刷进客户端实例。
      try { onSync?.(changed) } catch (error) {
        log.warn?.(`应用热配置失败：${error?.message ?? error}`)
      }
      // 人设变了 → 重拼最终系统提示词（名字/参与度/附加规则/覆盖/模型身份），推给插件。
      // 首次同步只**记录**当前值，不推送（避免每次启动都白推一次）。
      try {
        const signature = personaSignature(hot)
        if (lastPersonaSignature === undefined) {
          lastPersonaSignature = signature
        } else if (signature !== lastPersonaSignature) {
          // ⚠️ 必须 await：onPersona 允许是异步的（start.mjs 的推送就是 async）。
          // 不 await 时拿到的是 Promise，`r?.ok` 恒假 → 签名永不更新 → 每 2 秒重复推送。
          const r = await onPersona?.(hot, { previous: lastPersonaSignature })
          if (r === undefined) {
            // 契约违例：onPersona 必须返回（或 resolve 出）{ ok, action, detail }。
            // 旧 start.mjs 写的是 `() => { void pushGlobalPersona(...) }`，返回 undefined，
            // 于是每 2 秒重复推一次人设（README【待修复 2】）。
            // 这里 warn 一次并推进签名：不再静默无限重试，等下次人设真的变化再推。
            if (!personaContractWarned) {
              personaContractWarned = true
              log.warn?.('人设推送回调未返回结果（契约要求 { ok, action, detail }）：'
                + '本次按已生效处理，下次人设变化才重推')
            }
            lastPersonaSignature = signature
          } else if (r?.ok) {
            lastPersonaSignature = signature
            // unchanged = 内容其实没变（例如改的字段被「系统提示词覆盖」吃掉）：不推送、不打日志。
            if (r.action !== 'unchanged') {
              log.info(r.action === 'removed-override'
                ? '人设已恢复默认（删除 preset 覆盖）'
                : `人设已推送到 guard 动态 section（${r.detail || '下一条消息生效'}）`)
            }
          } else {
            log.warn?.(`写人设失败（${r?.action}）：${r?.detail ?? ''}`)
          }
        }
      } catch (error) {
        log.warn?.(`应用人设失败：${error?.message ?? error}`)
      }
      // 顺带把运行状态回推给 Host，供 DSH 设置页的「运行状态」显示。
      // 复用同一个 baseUrl / cookie，失败不影响主链路 ——
      // 但**失败要能看见**（否则 UI 永远「未知」而日志无迹可寻）。
      try {
        const status = typeof getStatus === 'function' ? getStatus() : undefined
        if (status) {
          const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}${STATUS_ROUTE_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(status),
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (!res.ok) {
            if (!statusReportWarned) {
              statusReportWarned = true
              log.warn?.(`状态上报失败：HTTP ${res.status}（UI 会显示「未知」）`)
            }
          } else if (!statusReportedOnce) {
            statusReportedOnce = true
            log.info('运行状态已开始上报给 DSH（UI 状态灯应亮起）')
          }
        } else if (!statusReportWarned) {
          statusReportWarned = true
          log.warn?.('状态上报跳过：getStatus 未提供或返回空')
        }
      } catch (error) {
        if (!statusReportWarned) {
          statusReportWarned = true
          log.warn?.(`状态上报异常：${error?.message ?? error}`)
        }
      }
    } catch (error) {
      // 首次失败说明可能是 DSH 没跑/插件没装/端口变了，提示一次即可；
      // 之后静默重试，避免每 2 秒刷一条 warn 把日志淹了。
      if (!syncedOnce) log.warn?.(`尚无法从 DSH 读取配置（继续用 config.json）：${error?.message ?? error}`)
    }
    if (!stopped) timer = setTimeout(tick, pollMs)
  }

  // 立即拉一次，再开始定时。
  void tick()

  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
}
