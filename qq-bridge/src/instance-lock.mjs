/**
 * 桥接单实例锁（零依赖，纯 node:fs）。
 *
 * ## 为什么需要
 * 桥接可能被两条路径同时拉起：
 *   · 插件 `bridge.autoStart`（DSH 启动时自动起）；
 *   · 用户在设置页点「启动桥接」；
 *   · 用户自己开终端 `node start.mjs`。
 * 两个桥接都连 NapCat 同一条正向 WS，**同一条 QQ 消息会被各收一次**
 * （NapCat 的 messagePostFormat 事件是广播给所有 WS 客户端的）→ 重复回复、
 * 重复建 DSH 会话、白名单/计数也各算各的。
 *
 * ## 做法
 * 在桥接目录下用 `wx`（O_EXCL 语义）原子创建 `.bridge.lock`，内容带 pid。
 *   · 已存在且 pid 还活着 → 判定「已有实例」，本进程不接消息，直接退出；
 *   · 已存在但 pid 已死（kill -9 / 断电）→ 陈旧锁，清掉重抢；
 *   · 正常退出 → 释放（只删自己 pid 的锁，不误删别人的）。
 *
 * 不用 TCP 固定端口做互斥：那要多开一个监听端口，还得防端口被占；
 * 锁文件不需要网络、也不占端口。
 *
 * ## 与插件侧的关系
 * `plugins/dsh-qq-guard/bridge-runner.mjs` 启动前会**只读**同一个锁文件
 * （`readLiveInstanceLock`），发现已有活实例就不 spawn，避免白起一个进程。
 * 两处格式必须一致：`{ pid: number, startedAt: number, cwd: string }`，
 * 文件名 `.bridge.lock`。
 */

import fs from 'node:fs'
import path from 'node:path'

export const LOCK_FILE_NAME = '.bridge.lock'

/** @param {string} dir 桥接目录 */
export function lockPath(dir) {
  return path.join(path.resolve(dir), LOCK_FILE_NAME)
}

/**
 * pid 是否还活着。signal 0 只做存在性检查，不真的发信号。
 * Windows 上 Node 也支持 `process.kill(pid, 0)`：不存在抛 ESRCH，存在但无权限抛 EPERM。
 * @param {number} pid
 * @returns {boolean}
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但没有操作权限（仍然是「活着」）。
    return error?.code === 'EPERM'
  }
}

/**
 * 读锁文件（不判断存活）。
 * @param {string} dir
 * @returns {{pid:number|null, startedAt:number|null, alive:boolean, cwd:string|null}|null}
 */
export function readLock(dir) {
  let raw
  try {
    raw = fs.readFileSync(lockPath(dir), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const pid = Number(parsed.pid)
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      startedAt: Number(parsed.startedAt) || null,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
      alive: pidAlive(Number.isInteger(pid) && pid > 0 ? pid : -1),
    }
  } catch {
    return null
  }
}

/**
 * 只读：返回仍然存活的持有者；没人持有返回 null。
 * @param {string} dir
 */
export function readLiveInstanceLock(dir) {
  const holder = readLock(dir)
  return holder && holder.alive ? holder : null
}

/**
 * 抢单实例锁。
 * @param {string} dir 桥接目录
 * @returns {{ok:true, release:() => void} | {ok:false, reason:string, holder?:object, detail?:string}}
 */
export function acquireInstanceLock(dir) {
  const file = lockPath(dir)
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    cwd: process.cwd(),
  }, null, 2)

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, payload, { encoding: 'utf8', flag: 'wx' })
      return { ok: true, release: makeRelease(file) }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, reason: 'write-failed', detail: error?.message ?? String(error) }
      }
      // 锁已存在：活着就是真的有人；死了就是陈旧锁，清掉再抢一次。
      const holder = readLock(dir)
      if (holder && holder.alive) return { ok: false, reason: 'held', holder }
      try { fs.unlinkSync(file) } catch { /* 别人先清了，下一轮再试 */ }
    }
  }
  const holder = readLock(dir)
  return { ok: false, reason: 'race', holder: holder ?? undefined }
}

/** 生成释放函数：只删属于本进程的锁，避免竞态下误删新持有者的锁。 */
function makeRelease(file) {
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Number(current?.pid) !== process.pid) return
      fs.unlinkSync(file)
    } catch { /* 锁已被删 / 内容不可读：忽略 */ }
  }
}
