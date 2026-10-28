/**
 * 桥接运行状态 → 上报给 DSH 的纯数据（批次 5：修 qqConnected 上报 Bug）。
 *
 * ## 旧实现的 Bug（2026-10-21 报告）
 * `start.mjs` 里写的是 `qqConnected: bridge.qq?.connected === true`，而
 * `OneBotClient.connected` 只是 `_ws?.readyState === OPEN`：
 *   1. **WS 建连瞬间** readyState 还是 CONNECTING(0)，这一刻取值恒为 false；
 *   2. 更要命的是它回答的是「到 NapCat 的管道通不通」，**不是**「QQ 账号在不在线」。
 *      NapCat 进程活着、WS 通、但 QQ 账号掉线时，旧实现会报「已连接」——谎报在线。
 *
 * ## 现在的口径（纯 WS，不碰 NapCat 的 onebot11 配置、不配 HTTP API）
 *   1. WS 连上后立刻发 `{"action":"get_status"}`，读 `data.online`（见 onebot.mjs）；
 *   2. 心跳里的 `status.online` 作为免费续命；
 *   3. 探不到 → `online = null` → 报 `unverified`（账号未确认），
 *      **不谎报在线，也不谎报离线**。
 *
 * ## 状态机
 *   online        确认在线（get_status / 心跳明确 online=true）
 *   offline       WS 通，但账号明确离线（online=false）
 *   unverified    WS 通，账号状态探不到（没回 / 缺字段 / 调用超时）
 *   disconnected  WS 未连接
 *
 * `runtime-config.mjs` 与 `start.mjs` 共用本文件；测试 `test-offline.mjs` 直接验状态机。
 */

/** 允许上报给 Host 的 qqState 取值（Host 侧也按这张表校验，防止任意字符串入库）。 */
export const QQ_STATES = Object.freeze(['online', 'offline', 'unverified', 'disconnected'])

/**
 * 由 OneBotClient 的 health 快照推导四态。
 * @param {object|undefined|null} health `client.health`
 * @returns {'online'|'offline'|'unverified'|'disconnected'}
 */
export function qqStateFromHealth(health) {
  const h = health && typeof health === 'object' ? health : {}
  if (h.online === true) return 'online'
  if (h.online === false) return 'offline'
  // 探不到：只有 WS 真的连着才算「未确认」；连都没连上就是「未连接」。
  return h.connected === true ? 'unverified' : 'disconnected'
}

/**
 * 组装 POST /dsh-qq-guard/status 的请求体。
 *
 * `qqConnected` 保留是为了兼容旧版 Host / 旧版前端，但语义已改成
 * **「确认在线」**（只有 online 才算 true），不再是「WS 连上了」。
 * 新前端请优先读 `qqState`。
 *
 * @param {object} [opts]
 * @param {object} [opts.health] OneBotClient.health
 * @param {object} [opts.counts] bridge.stats
 * @param {boolean} [opts.dshOk=true] 能调用本函数说明刚成功拉过 DSH 配置，链路是通的
 * @param {Array<object>} [opts.sessions] 「会话管理」用的真实列表（见 Bridge.sessionViews）
 * @param {Array<object>} [opts.opLog] 操作日志环形队列（见 Bridge.opLogViews，最近 50 条）
 * @param {boolean} [opts.enabled] 接入总闸（false = 暂停消息处理，重启后仍保持）
 * @param {string} [opts.dshBaseUrl] 桥接实际连的 DSH 地址（高级面板显示端口）
 * @param {string} [opts.wsUrl] 桥接实际连的 NapCat WS 地址
 * @returns {{qqConnected:boolean, qqState:string, dshOk:boolean, counts:object,
 *   sessions?:Array<object>, opLog?:Array<object>, enabled?:boolean,
 *   dshBaseUrl?:string, wsUrl?:string}}
 */
export function buildBridgeStatus({
  health, counts, dshOk = true, sessions, opLog,
  enabled = true, dshBaseUrl = '', wsUrl = '',
  globalMemory, tasks,
} = {}) {
  const qqState = qqStateFromHealth(health)
  return {
    qqConnected: qqState === 'online',
    qqState,
    dshOk: dshOk === true,
    counts: counts && typeof counts === 'object' ? counts : {},
    // 接入总闸：缺省 true（旧版桥接不报这个键时按「正常处理」）。
    enabled: enabled !== false,
    // 高级面板展示用；空串表示还没连上 / 拿不到。
    ...(typeof dshBaseUrl === 'string' && dshBaseUrl !== '' ? { dshBaseUrl: dshBaseUrl.slice(0, 200) } : {}),
    ...(typeof wsUrl === 'string' && wsUrl !== '' ? { wsUrl: wsUrl.slice(0, 200) } : {}),
    // 会话列表是设置页「会话管理」的唯一真实数据源。旧版桥接不报这个字段，
    // Host / 前端必须把「缺省」当成「没有数据」，不能当成「空列表」覆盖掉。
    ...(Array.isArray(sessions) ? { sessions: sessions.slice(0, 100) } : {}),
    // 操作日志（v2.0 第六步）：只给最近 50 条；旧版桥接不报这个键，前端按空处理。
    ...(Array.isArray(opLog) ? { opLog: opLog.slice(-50) } : {}),
    // 跨群记忆 / 定时任务（v2.0 第二十四步）：设置页列表用，最多 50 条。
    ...(Array.isArray(globalMemory) ? { globalMemory: globalMemory.slice(0, 50) } : {}),
    ...(Array.isArray(tasks) ? { tasks: tasks.slice(0, 50) } : {}),
  }
}
