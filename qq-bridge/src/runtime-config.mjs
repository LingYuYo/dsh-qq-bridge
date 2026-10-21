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
  'typingDelay',
  'flypitDelayTiers',
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
  // Phase 4：节奏参数（响应档位/防抖/限频/禁言）必须热更新。
  'rhythm',
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
 * 启动轮询。返回停止函数。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl 形如 http://127.0.0.1:6708（已探测的实际端口）
 * @param {string} [opts.cookie] DSH 会话 Cookie（路由不强制鉴权，但带上更稳）
 * @param {object} opts.liveConfig 会被原地更新的配置对象
 * @param {Function} [opts.onSync] 每次成功同步后调用（用于把值刷进客户端实例）
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
      // 人设变了 → 写回 profile 的 preset 覆盖（只对新建会话生效）。
      // 首次同步只**记录**当前值，不写盘（避免每次启动都改 profile）。
      try {
        const signature = personaSignature(hot)
        if (lastPersonaSignature === undefined) {
          lastPersonaSignature = signature
        } else if (signature !== lastPersonaSignature) {
          const r = onPersona?.(hot, { previous: lastPersonaSignature })
          if (r?.ok) {
            lastPersonaSignature = signature
            log.info(r.action === 'removed-override'
              ? '人设已恢复默认（删除 preset 覆盖）'
              : '人设已写入 preset 覆盖（对新建 QQ 会话生效）')
          } else if (r) {
            log.warn?.(`写人设失败（${r.action}）：${r.detail ?? ''}`)
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
