/**
 * usage-stats.mjs 的离线回归用例（不需要 DSH 进程）。
 *
 * 锁死几件容易回退的事：
 *   1. 只统计 QQ 工作区（cwd 命中 / 映射命中），子代理会话与浏览器会话一律排除；
 *   2. 只认 `assistant/message.data.usage` + `assistant/attempt.stream` 里的 usage，
 *      字段名是 inputTokens / outputTokens / cacheReadTokens —— 不是 promptTokens；
 *   3. 去重：同一事件重放不会重复计数；回填与在线监听交错也不会重复；
 *   4. 成本：没配单价返回 null（面板显示「—」），配了按「元 / 百万 token」算；
 *   5. 路由契约：GET /usage、POST /usage/backfill 的状态码与同源检查。
 *
 * 运行：node plugins/dsh-qq-guard/test-usage-stats.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  USAGE_FILE_NAME,
  UsageScope,
  UsageStatsStore,
  costOfBucket,
  costOfModelBucket,
  dayKeyOf,
  handleUsageBackfillRoute,
  handleUsageRoute,
  isPeakMinute,
  normalizeDateKey,
  normalizePricingRules,
  parsePeakHours,
  parsePeakWindows,
  pickUsage,
  priceOf,
  ratesPriced,
  usageFromStream,
  zonedDayKey,
  zonedWeekday,
} from './usage-stats.mjs'

let pass = 0
let fail = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    pass++
  } catch (error) {
    console.log(`  ✗ ${name}\n      ${error?.stack ?? error?.message ?? error}`)
    fail++
  }
}

const quiet = { warn() {}, info() {} }
const DAY = 24 * 60 * 60 * 1000
/** 固定「现在」：2026-10-23 12:00 本地时区（避免测试跨午夜漂移）。 */
const NOW = new Date(2026, 9, 23, 12, 0, 0, 0).getTime()
const QQ_CWD = 'D:\\QQChat'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-usage-'))

/** 造一套桥接目录（config.json + state/sessions.json）。 */
function makeBridge(name, { sessionCwd = QQ_CWD, mapping = {} } = {}) {
  const dir = path.join(tmpRoot, name)
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dsh: { sessionCwd } }), 'utf8')
  fs.writeFileSync(path.join(dir, 'state', 'sessions.json'), JSON.stringify({ sessions: mapping }), 'utf8')
  return dir
}

function makeStore({
  bridgeDir,
  pricing = [],
  peakHours = '08:30-00:30',
  timezone = 'Asia/Shanghai',
  onlyWorkdays = false,
  holidaysFile,
  now = NOW,
  file,
} = {}) {
  const scope = new UsageScope({ bridgeDir, logger: quiet })
  const statsFile = file ?? path.join(bridgeDir, 'state', USAGE_FILE_NAME)
  const store = new UsageStatsStore({
    file: statsFile,
    scope,
    logger: quiet,
    now: () => now,
    getPricing: () => pricing,
    getPeakHours: () => peakHours,
    getPeakOnlyWorkdays: () => onlyWorkdays,
    getTimezone: () => timezone,
    ...(holidaysFile === undefined ? {} : { holidaysFile }),
  })
  return { store, scope, file: statsFile }
}

/** 写一份临时 holidays.json 夹具。 */
function makeHolidays(name, table) {
  const file = path.join(tmpRoot, name, 'holidays.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(table), 'utf8')
  return file
}

const event = (seq, type, data, time) => ({ seq, type, time, data })
const sessionOf = (id, cwd = QQ_CWD, extra = {}) => ({ id, header: { cwd, origin: undefined, createdAt: NOW - DAY, ...extra } })

function lastDay(snapshot) {
  return snapshot.days[snapshot.days.length - 1]
}

/** 把窗口内各天的某个标量加起来（回填的事件可能落在昨天/前天）。 */
function sumDays(snapshot, field) {
  return snapshot.days.reduce((sum, day) => sum + (Number(day?.[field]) || 0), 0)
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(key, value) { this.headers[key] = value },
    end(body) { this.body = body ?? ''; this.writableEnded = true },
  }
}

/** 极简假 persistence：只为验回填的水位与幂等，不碰真实磁盘格式。 */
function fakePersistence(sessions) {
  return {
    async list() {
      return sessions.map((item) => ({ header: item.header }))
    },
    async open(id) {
      const item = sessions.find((candidate) => candidate.header.id === id)
      if (!item) throw new Error(`not found: ${id}`)
      return {
        async read(offset = 0, length = Number.MAX_SAFE_INTEGER) {
          return {
            eventState: 'materialized',
            events: item.events.slice(offset, offset + length),
          }
        },
        async close() {},
      }
    },
  }
}

try {
  console.log('usage-stats.mjs 离线用例')

  await check('dayKeyOf 用本地时区（不是 UTC）', () => {
    assert.equal(dayKeyOf(new Date(2026, 9, 23, 0, 30, 0).getTime()), '2026-10-23')
    assert.equal(dayKeyOf(new Date(2026, 9, 23, 23, 30, 0).getTime()), '2026-10-23')
  })

  await check('pickUsage / usageFromStream 只认 DSH 字段名', () => {
    const usage = pickUsage({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, reasoningTokens: 4 })
    assert.deepEqual(usage, { input: 11, output: 22, cacheRead: 33, cacheWrite: 0, reasoning: 4 })
    // 没有 DSH 字段名 → 全 0（不把别家的字段硬塞进来）
    assert.deepEqual(pickUsage({ promptTokens: 999 }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
    assert.deepEqual(
      usageFromStream([
        { type: 'chunk', chunk: { type: 'text', text: 'x' } },
        { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 6 } } },
      ]),
      { input: 5, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    )
    assert.equal(usageFromStream([]), null)
  })

  await check('价目表：忙时/闲时两套、精确优先、provider 通配、旧版扁平兼容', () => {
    const rules = normalizePricingRules([
      { provider: 'trae', model: '', peak: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }, offPeak: { input: 0.5, output: 1 } },
      { provider: 'trae', model: 'deepseek-v4.1-flash', peak: { input: 3, output: 4 } },
      { provider: 'raccoon', model: '*', peak: { input: 0 }, offPeak: { output: 0 } },
      // 旧版扁平结构：新 Schema 会给它补上全 0 的 peak/offPeak，仍要按扁平值兼容。
      {
        provider: 'legacy',
        model: '',
        input: 2,
        output: 5,
        peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        offPeak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ])
    assert.equal(rules.length, 4)
    assert.equal(priceOf(rules, 'trae', 'deepseek-v4.1-flash').peak.input, 3)
    assert.equal(priceOf(rules, 'trae', 'deepseek-v4.1-flash').offPeak.input, 0)
    assert.equal(priceOf(rules, 'trae', 'other-model').peak.input, 1)
    assert.equal(priceOf(rules, 'raccoon', 'whatever'), null, '两套全是 0 应视为未配置')
    assert.equal(priceOf(rules, 'nope', 'whatever'), null)
    const legacy = priceOf(rules, 'legacy', 'm')
    assert.equal(legacy.peak.input, 2)
    assert.equal(legacy.offPeak.input, 2, '旧版扁平价应同时套到两套')
    assert.equal(ratesPriced(rules[2].peak), false)

    const cost = costOfBucket(
      { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 0 },
      { input: 3, output: 4, cacheRead: 0.5, cacheWrite: 0 },
    )
    assert.equal(cost, 3 + 2 + 1)
    // 忙时 + 闲时分别计价
    const split = costOfModelBucket(
      { peak: { input: 1_000_000 }, offPeak: { input: 2_000_000 } },
      { peak: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, offPeak: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } },
    )
    assert.equal(split, 12)
  })

  await check('峰谷时段：解析、跨午夜边界、按配置时区取天', () => {
    assert.deepEqual(parsePeakHours('08:30-00:30'), { start: 8 * 60 + 30, end: 30 })
    assert.equal(parsePeakHours('25:00-01:00'), null)
    assert.equal(parsePeakHours('08:30~00:30'), null)
    const window = parsePeakHours('08:30-00:30')
    assert.equal(isPeakMinute(8 * 60 + 29, window), false, '08:29 属于闲时')
    assert.equal(isPeakMinute(8 * 60 + 30, window), true, '08:30 属于忙时（左闭）')
    assert.equal(isPeakMinute(23 * 60 + 59, window), true)
    assert.equal(isPeakMinute(0, window), true, '00:00 仍在忙时（跨午夜）')
    assert.equal(isPeakMinute(30, window), false, '00:30 属于闲时（右开）')
    assert.equal(isPeakMinute(2 * 60, window), false)
    // 同一时刻，上海 02:00 = UTC 前一天 18:00
    const moment = new Date(2026, 9, 23, 2, 0, 0, 0).getTime()
    assert.equal(zonedDayKey(moment, 'Asia/Shanghai'), '2026-10-23')
    assert.equal(zonedDayKey(moment, 'UTC'), '2026-10-22')
    assert.equal(zonedDayKey(moment, 'Not/AZone'), '2026-10-23', '非法时区要退回本地而不是崩')
    assert.equal(zonedWeekday(new Date(2026, 9, 24, 12).getTime(), 'Asia/Shanghai'), 6, '10-24 是周六')
  })

  await check('多段时段：逗号分隔、段间空隙算闲时', () => {
    const windows = parsePeakWindows('09:00-12:00, 14:00-18:00')
    assert.equal(windows.length, 2)
    assert.equal(isPeakMinute(9 * 60, windows), true)
    assert.equal(isPeakMinute(11 * 60 + 59, windows), true)
    assert.equal(isPeakMinute(12 * 60, windows), false, '12:00 是右开边界')
    assert.equal(isPeakMinute(13 * 60, windows), false, '12~14 之间是空闲时')
    assert.equal(isPeakMinute(14 * 60, windows), true)
    assert.equal(isPeakMinute(18 * 60, windows), false)
    // 非法段跳过，合法段保留；全非法 → null（全天忙时兜底）
    assert.equal(parsePeakWindows('09:00-12:00, bad').length, 1)
    assert.equal(parsePeakWindows('bad, worse'), null)
    assert.equal(normalizeDateKey('2026-10-01'), '2026-10-01')
    assert.equal(normalizeDateKey('2026/10/01'), '')
  })

  await check('工作日 / 节假日：workdays 优先，其次 holidays，最后看 onlyWorkdays', () => {
    const bridgeDir = makeBridge('calendar', { mapping: { 'u:10001': 'sess-CAL' } })
    const holidaysFile = makeHolidays('calendar-fixture', {
      workdays: ['2026-10-17'], // 周六调休上班
      holidays: ['2026-10-19'], // 周一放假
    })
    const pricing = [{
      provider: 'trae',
      model: '',
      peak: { input: 10 },
      offPeak: { input: 1 },
    }]
    const { store } = makeStore({
      bridgeDir,
      pricing,
      peakHours: '09:00-12:00',
      onlyWorkdays: true,
      holidaysFile,
    })
    const sess = sessionOf('sess-CAL')
    const at = (monthDay, hour, minute = 0) => {
      const [month, day] = monthDay.split('-').map(Number)
      return new Date(2026, month - 1, day, hour, minute, 0, 0).getTime()
    }
    let seq = 0
    const push = (time) => store.ingest(sess, event(seq++, 'assistant/message', {
      turn: seq,
      step: 1,
      message: { source: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
      usage: { inputTokens: 1_000_000 },
    }, time))

    push(at('10-23', 10)) // 周五工作日 + 窗口内 → 忙时
    push(at('10-17', 10)) // 周六，但 holidays.workdays 调休 → 忙时
    push(at('10-17', 19)) // 周六调休，但 19:00 在窗口外 → 闲时
    push(at('10-18', 10)) // 周日，无调休 → 整天闲时
    push(at('10-19', 10)) // 周一，但 holidays 放假 → 整天闲时

    const snapshot = store.snapshot({ days: 7 })
    const model = snapshot.models[0]
    assert.equal(model.peak.input, 2_000_000, '周五 + 周六调休各一次忙时')
    assert.equal(model.offPeak.input, 3_000_000, '调休日窗口外 + 周日 + 法定节假日')
    // 忙时 2M*10 + 闲时 3M*1 = 23
    assert.equal(model.cost, 23)
  })

  await check('峰谷规则变化：重新加载时自动清空，等回填按新规则重算', () => {
    const bridgeDir = makeBridge('signature', { mapping: { 'u:10001': 'sess-SIG' } })
    const now = NOW
    const first = makeStore({ bridgeDir, peakHours: '09:00-12:00' })
    first.store.ingest(sessionOf('sess-SIG'), event(0, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { source: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
      usage: { inputTokens: 1000 },
    }, new Date(2026, 9, 23, 10, 0, 0, 0).getTime()))
    first.store.save()
    assert.equal(sumDays(first.store.snapshot({ days: 7 }), 'calls'), 1)

    // 规则没变 → 保留原数据
    const same = makeStore({ bridgeDir, peakHours: '09:00-12:00', now })
    assert.equal(sumDays(same.store.snapshot({ days: 7 }), 'calls'), 1)

    // 规则变了 → 自动备份 + 清空（启动回填会按新规则重算）
    const changed = makeStore({ bridgeDir, peakHours: '09:00-12:00, 14:00-18:00', now })
    assert.equal(sumDays(changed.store.snapshot({ days: 7 }), 'calls'), 0)
    assert.ok(fs.existsSync(`${changed.file}.bak`), '旧统计应备份成 .bak')
  })

  await check('rebuild：清空后回填能按新规则重算历史（幂等）', async () => {
    const bridgeDir = makeBridge('rebuild')
    const { store } = makeStore({ bridgeDir, peakHours: '09:00-12:00' })
    const header = { id: 'sess-RB', cwd: QQ_CWD, createdAt: NOW - DAY }
    const events = [0, 1, 2].map((seq) => event(seq, 'assistant/message', {
      turn: 1,
      step: seq + 1,
      message: { source: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
      usage: { inputTokens: 100, outputTokens: 10 },
    }, new Date(2026, 9, 23, 10, seq, 0).getTime()))
    const persistence = fakePersistence([{ header, events }])

    await store.backfillAll(persistence)
    assert.equal(sumDays(store.snapshot({ days: 7 }), 'calls'), 3)
    store.rebuild()
    assert.equal(sumDays(store.snapshot({ days: 7 }), 'calls'), 0, 'rebuild 后聚合成空')
    const second = await store.backfillAll(persistence)
    assert.equal(second.imported, 3)
    assert.equal(sumDays(store.snapshot({ days: 7 }), 'calls'), 3, '重算后历史回来')
  })

  await check('在线拦截：只收 QQ 工作区，按天/模型/会话聚合，忽略重复 seq 与子代理', () => {
    const bridgeDir = makeBridge('live', { mapping: { 'u:10001': 'sess-A' } })
    const { store, scope } = makeStore({ bridgeDir })
    const sessA = sessionOf('sess-A')
    const sessOther = sessionOf('sess-B', 'D:\\OtherWorkspace')
    const sessSub = sessionOf('sess-sub', QQ_CWD, { origin: 'subagent' })

    store.ingest(sessA, event(0, 'request/header', { header: { config: { provider: 'trae', model: 'deepseek-v4.1-flash' } } }, NOW - 1000))
    store.ingest(sessA, event(1, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { source: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200, reasoningTokens: 50 },
    }, NOW - 900))
    store.ingest(sessA, event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, NOW - 800))
    store.ingest(sessA, event(3, 'assistant/attempt', {
      turn: 2,
      step: 1,
      stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 300, outputTokens: 10 } } }],
    }, NOW - 700))
    store.ingest(sessA, event(4, 'turn/end', { turn: 2, reason: { kind: 'error' } }, NOW - 600))
    // 重复事件（重放）不能重复计
    store.ingest(sessA, event(1, 'assistant/message', {
      turn: 1,
      step: 1,
      usage: { inputTokens: 9999, outputTokens: 9999 },
    }, NOW - 900))
    // 非 QQ 会话 / 子代理会话一律不计
    store.ingest(sessOther, event(1, 'assistant/message', { usage: { inputTokens: 7777 } }, NOW - 500))
    store.ingest(sessSub, event(1, 'assistant/message', { usage: { inputTokens: 8888 } }, NOW - 400))

    const snapshot = store.snapshot({ days: 7 })
    const today = lastDay(snapshot)
    assert.equal(today.calls, 2)
    assert.equal(today.input, 1300)
    assert.equal(today.output, 110)
    assert.equal(today.cacheRead, 200)
    assert.equal(today.tokens, 1610)
    assert.equal(today.turnOk, 1)
    assert.equal(today.turnFail, 1)
    assert.equal(today.ok, 50)
    assert.equal(snapshot.models.length, 1)
    assert.equal(snapshot.models[0].name, 'trae/deepseek-v4.1-flash')
    assert.equal(snapshot.models[0].calls, 2)
    assert.equal(snapshot.sessions.length, 1)
    assert.equal(snapshot.sessions[0].key, 'u:10001')
    assert.equal(snapshot.sessions[0].kind, '私聊')
    assert.equal(snapshot.scope.mapped, 1)
    assert.equal(snapshot.pricing.configured, false)
    assert.equal(today.cost, null, '没配单价时成本必须是 null，不能假装 0')
  })

  await check('成本：配了价目表才出数字，单位是元 / 百万 token', () => {
    const bridgeDir = makeBridge('cost', { mapping: { 'g:20002': 'sess-C' } })
    const pricing = [{
      provider: 'trae',
      model: '',
      peak: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 1 },
      offPeak: { input: 1, output: 4, cacheRead: 0.25, cacheWrite: 0.5 },
    }]
    const { store } = makeStore({ bridgeDir, pricing })
    const sess = sessionOf('sess-C')
    store.ingest(sess, event(0, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { source: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 400_000, cacheWriteTokens: 10_000 },
    }, NOW - 1000))

    const snapshot = store.snapshot({ days: 1 })
    const today = lastDay(snapshot)
    // NOW-1000 是本地 11:59:59，属于忙时：1M*2 + 0.1M*8 + 0.4M*0.5 + 0.01M*1
    assert.equal(today.cost, 3.01)
    assert.equal(snapshot.models[0].cost, 3.01)
    assert.equal(snapshot.sessions[0].cost, 3.01)
    assert.equal(snapshot.pricing.configured, true)
    assert.equal(snapshot.pricing.peakHours, '08:30-00:30')
    assert.equal(snapshot.pricing.timezone, 'Asia/Shanghai')
  })

  await check('峰谷计费：按事件时间分桶，缓存写入也计入', () => {
    const bridgeDir = makeBridge('peak', { mapping: { 'u:10001': 'sess-PK' } })
    const pricing = [{
      provider: 'trae',
      model: '',
      peak: { input: 10, output: 20, cacheRead: 2, cacheWrite: 4 },
      offPeak: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
    }]
    const { store } = makeStore({ bridgeDir, pricing })
    const sess = sessionOf('sess-PK')
    const at = (hour, minute) => new Date(2026, 9, 23, hour, minute, 0, 0).getTime()
    let seq = 0
    const push = (time, usage) => store.ingest(sess, event(seq++, 'assistant/message', {
      turn: seq,
      step: 1,
      message: { source: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
      usage,
    }, time))
    push(at(8, 29), { inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 }) // 闲时
    push(at(8, 30), { inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 }) // 忙时
    push(at(23, 59), { inputTokens: 1_000_000 }) // 忙时
    push(at(0, 29), { inputTokens: 1_000_000 }) // 忙时（跨午夜）
    push(at(0, 30), { inputTokens: 1_000_000 }) // 闲时
    push(at(2, 0), { inputTokens: 1_000_000 }) // 闲时

    const snapshot = store.snapshot({ days: 1 })
    const model = snapshot.models[0]
    assert.equal(model.peak.input, 3_000_000)
    assert.equal(model.offPeak.input, 3_000_000)
    assert.equal(model.peak.cacheWrite, 1_000_000)
    assert.equal(model.offPeak.cacheWrite, 1_000_000)
    // 忙时 3M*10 + 1M*4 = 34；闲时 3M*1 + 1M*1 = 4
    assert.equal(model.cost, 38)
    assert.equal(lastDay(snapshot).cost, 38)
  })

  await check('timezone 真的参与峰谷判断（同一时刻、两种时区）', () => {
    const time = new Date(2026, 9, 23, 2, 0, 0, 0).getTime() // 上海 02:00 = UTC 前一天 18:00
    const pricing = [{
      provider: 'trae',
      model: '',
      peak: { input: 10 },
      offPeak: { input: 1 },
    }]
    const costWith = (timezone) => {
      const bridgeDir = makeBridge(`tz-${timezone.replace(/\W/g, '')}`, { mapping: { 'u:10001': 'sess-TZ' } })
      const { store } = makeStore({ bridgeDir, pricing, timezone })
      store.ingest(sessionOf('sess-TZ'), event(0, 'assistant/message', {
        turn: 1,
        step: 1,
        message: { source: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
        usage: { inputTokens: 1_000_000 },
      }, time))
      return store.snapshot({ days: 2 }).days.reduce((sum, day) => sum + (day.cost ?? 0), 0)
    }
    assert.equal(costWith('Asia/Shanghai'), 1, '上海 02:00 是闲时')
    assert.equal(costWith('UTC'), 10, 'UTC 18:00 是忙时')
  })

  await check('落盘 / 重新加载：数据与成本保持一致（不需要回填也算完）', () => {
    const bridgeDir = makeBridge('persist', { mapping: { 'u:10001': 'sess-P' } })
    const pricing = [{ provider: 'trae', model: '', peak: { input: 1, output: 1 }, offPeak: { input: 1, output: 1 } }]
    const first = makeStore({ bridgeDir, pricing })
    const sess = sessionOf('sess-P')
    first.store.ingest(sess, event(0, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { source: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
      usage: { inputTokens: 1000, outputTokens: 100 },
    }, NOW - 1000))
    first.store.save()
    assert.ok(fs.existsSync(first.file), '应该写出 usage-stats.json')

    const second = makeStore({ bridgeDir, pricing })
    const snapshot = second.store.snapshot({ days: 1 })
    assert.equal(lastDay(snapshot).tokens, 1100)
    assert.equal(lastDay(snapshot).calls, 1)
    assert.equal(second.store.backfillState().done, true)
  })

  await check('历史回填：官方接口读 0..N，幂等（跑两次不重复计）', async () => {
    const bridgeDir = makeBridge('backfill')
    const { store } = makeStore({ bridgeDir })
    const header = { id: 'sess-old', cwd: QQ_CWD, createdAt: NOW - 2 * DAY }
    const events = [
      event(0, 'request/header', { header: { config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } }, NOW - 2 * DAY),
      event(1, 'assistant/message', {
        turn: 1,
        step: 1,
        message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
        usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 900 },
      }, NOW - 2 * DAY),
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, NOW - 2 * DAY),
      event(3, 'assistant/message', {
        turn: 2,
        step: 1,
        message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
        usage: { inputTokens: 400, outputTokens: 40 },
      }, NOW - DAY),
    ]
    const persistence = fakePersistence([{ header, events }])

    const first = await store.backfillAll(persistence)
    assert.equal(first.scanned, 1)
    assert.equal(first.imported, 3, '两条 assistant/message + 一条 turn/end，共 3 个统计事件')
    let snapshot = store.snapshot({ days: 7 })
    assert.equal(sumDays(snapshot, 'calls'), 2)
    assert.equal(sumDays(snapshot, 'tokens'), 1890)

    const second = await store.backfillAll(persistence)
    assert.equal(second.scanned, 1)
    assert.equal(second.imported, 0, '第二次回填不应再导入任何事件')
    snapshot = store.snapshot({ days: 7 })
    assert.equal(sumDays(snapshot, 'calls'), 2)
    assert.equal(sumDays(snapshot, 'tokens'), 1890)
  })

  await check('回填与在线交错：先收到 seq 5 再回填 0..4，合计 6 次调用', async () => {
    const bridgeDir = makeBridge('interleave')
    const { store } = makeStore({ bridgeDir })
    const header = { id: 'sess-I', cwd: QQ_CWD, createdAt: NOW - DAY }
    const events = []
    for (let seq = 0; seq <= 4; seq += 1) {
      events.push(event(seq, 'assistant/message', {
        turn: 1,
        step: seq + 1,
        message: { source: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
        usage: { inputTokens: 100, outputTokens: 10 },
      }, NOW - DAY + seq))
    }
    // 在线先看到第 5 条（前面的历史还没回填），firstLiveSeq = 5
    store.ingest(sessionOf('sess-I'), event(5, 'assistant/message', {
      turn: 2,
      step: 1,
      message: { source: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
      usage: { inputTokens: 100, outputTokens: 10 },
    }, NOW - 1000))

    await store.backfillAll(fakePersistence([{ header, events }]))
    const snapshot = store.snapshot({ days: 7 })
    assert.equal(sumDays(snapshot, 'calls'), 6)
    assert.equal(sumDays(snapshot, 'input'), 600)
    assert.equal(sumDays(snapshot, 'output'), 60)
  })

  await check('会话从 seq 0 起就在线：historyComplete，回填不重读', async () => {
    const bridgeDir = makeBridge('live-from-zero')
    const { store } = makeStore({ bridgeDir })
    store.ingest(sessionOf('sess-Z'), event(0, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { source: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
      usage: { inputTokens: 10, outputTokens: 1 },
    }, NOW - 1000))
    const result = await store.backfillAll(fakePersistence([{
      header: { id: 'sess-Z', cwd: QQ_CWD },
      events: [event(0, 'assistant/message', { usage: { inputTokens: 999 } }, NOW - 1000)],
    }]))
    assert.equal(result.imported, 0)
    assert.equal(lastDay(store.snapshot({ days: 1 })).calls, 1)
  })

  await check('GET /usage：200 + 同源检查 + 405', () => {
    const bridgeDir = makeBridge('route', { mapping: { 'u:10001': 'sess-A' } })
    const { store, scope } = makeStore({ bridgeDir })
    store.ingest(sessionOf('sess-A'), event(0, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { source: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
      usage: { inputTokens: 10, outputTokens: 2 },
    }, NOW - 1000))

    const okRes = fakeRes()
    handleUsageRoute({ method: 'GET', url: '/dsh-qq-guard/usage?days=7', headers: {} }, okRes, { store, scope })
    assert.equal(okRes.statusCode, 200)
    const body = JSON.parse(okRes.body)
    assert.equal(body.ok, true)
    assert.equal(body.days.length, 7)
    assert.equal(body.today.calls, 1)

    const badMethod = fakeRes()
    handleUsageRoute({ method: 'POST', url: '/dsh-qq-guard/usage', headers: {} }, badMethod, { store, scope })
    assert.equal(badMethod.statusCode, 405)

    const crossSite = fakeRes()
    handleUsageRoute({ method: 'GET', url: '/dsh-qq-guard/usage', headers: { 'sec-fetch-site': 'cross-site' } }, crossSite, { store, scope })
    assert.equal(crossSite.statusCode, 403)
  })

  await check('POST /usage/backfill：200 + 没有 persistence 时 501', async () => {
    const bridgeDir = makeBridge('route-backfill')
    const { store, scope } = makeStore({ bridgeDir })
    const persistence = fakePersistence([{
      header: { id: 'sess-R', cwd: QQ_CWD },
      events: [event(0, 'assistant/message', {
        turn: 1,
        step: 1,
        message: { source: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
        usage: { inputTokens: 42, outputTokens: 7 },
      }, NOW - 1000)],
    }])

    const okRes = fakeRes()
    await handleUsageBackfillRoute({ method: 'POST', url: '/dsh-qq-guard/usage/backfill', headers: {} }, okRes, {
      store,
      scope,
      getPersistence: () => persistence,
    })
    assert.equal(okRes.statusCode, 200)
    const body = JSON.parse(okRes.body)
    assert.equal(body.ok, true)
    assert.equal(body.backfill.done, true)
    assert.equal(body.today.calls, 1)

    // ?rebuild=1：先清空再回填，用于「改了峰谷规则后重算历史」。
    const rebuildRes = fakeRes()
    await handleUsageBackfillRoute({
      method: 'POST',
      url: '/dsh-qq-guard/usage/backfill?rebuild=1',
      headers: {},
    }, rebuildRes, { store, scope, getPersistence: () => persistence })
    assert.equal(rebuildRes.statusCode, 200)
    const rebuiltBody = JSON.parse(rebuildRes.body)
    assert.equal(rebuiltBody.rebuilt, true)
    assert.equal(rebuiltBody.backfill.imported, 1, 'rebuild 后应重新导入一次')
    assert.equal(rebuiltBody.today.calls, 1)

    const missing = fakeRes()
    await handleUsageBackfillRoute({ method: 'POST', url: '/dsh-qq-guard/usage/backfill', headers: {} }, missing, {
      store,
      scope,
      getPersistence: () => undefined,
    })
    assert.equal(missing.statusCode, 501)
  })
} finally {
  // 用例自己的临时目录，跑完清掉；失败也不影响结论。
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
