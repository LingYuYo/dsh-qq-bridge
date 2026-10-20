/**
 * 离线验收：设置页的数据通路（不需要浏览器、不需要 DSH）。
 *
 * 验证 client.js 里 `createRemoteForm` 的真实行为：
 *   ① remote.settings 正常 → 走 remote，writable=true
 *   ② remote 缺失、HTTP 可用 → 退回只读，writable=false
 *   ③ 两者都失败 → status=error 且 error 带真实原因（不静默）
 *   ④ mutate 的 revision 语义与只读保护
 *
 * 运行：node plugins/dsh-qq-guard/test-settings-data.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(HERE, 'client.js'), 'utf8')

// 把 client.js 里的 createRemoteForm 单独抽出来测：
// 它在 factory 闭包里，依赖 React 与 window，所以整体加载 client.js
// 但只需捕获 factory 后自行调用 apply。
const fakeReact = {
  createElement: () => null,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
}
let captured
// fetch 用转发器：让测试里替换 globalThis.fetch 能生效
// （直接传固定函数会导致 HTTP 兜底永远失败，之前的用例全卡在 loading）。
const fetchForward = (...args) => globalThis.fetch(...args)

new Function('window', 'document', 'fetch', SRC)(
  { __ModuleLoader__: { load: (m) => { captured = m } } },
  { head: { appendChild() {} }, createElement: () => ({ remove() {}, dataset: {} }) },
  fetchForward,
)
const mod = captured.factory((name) => (name === 'react' ? fakeReact : undefined))
const apply = mod.apply

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}

/** 每个用例独立造 ctx，并捕获 register 时注入的 remoteForm。 */
function makeCtx({ describe, mutate } = {}) {
  const captured = { injections: [], effects: [] }
  const ctx = {
    remote: (describe || mutate) ? {
      settings: { ...(describe ? { describe } : {}), ...(mutate ? { mutate } : {}) },
    } : undefined,
    effect(fn, label) { captured.effects.push(label); try { fn() } catch {} return () => {} },
    on() { return () => {} },
    inject(_deps, fn) { fn(ctx) },
    slots: {
      inject(_slot, fn) { try { fn() } catch {} return () => {} },
      register(opts, comp) { captured.injections.push({ opts, comp }); return () => {} },
    },
  }
  return { ctx, captured }
}

/** 跑一次 apply，等 load 完成，返回注入的 form。 */
async function boot({ describe, mutate } = {}, { waitMs = 2500 } = {}) {
  const { ctx, captured } = makeCtx({ describe, mutate })
  apply(ctx)
  // apply 是同步注册的；先取到 form，再等它把异步 load 跑完。
  let form
  for (const { opts } of captured.injections) {
    const injected = typeof opts.inject === 'function' ? opts.inject() : undefined
    if (injected && (injected.remoteForm || injected.form)) { form = injected.remoteForm ?? injected.form; break }
  }
  // 轮询直到不再是 loading（最多 waitMs），避免用固定 sleep 猜时间。
  const deadline = Date.now() + waitMs
  while (form && form.getSnapshot().status === 'loading' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  if (process.env.QQG_DEBUG) console.log('  [boot]', !!form, form?.getSnapshot().status, form?.getSnapshot().error)
  return form
}

const origFetch = globalThis.fetch
const withFetch = async (impl, fn) => { globalThis.fetch = impl; try { return await fn() } finally { globalThis.fetch = origFetch } }

console.log('— inject 声明 —')
await check('inject 必须同时含 remote 与 remote.settings', () => {
  const inj = mod.inject
  assert.ok(Array.isArray(inj))
  assert.ok(inj.includes('slots'))
  assert.ok(inj.includes('remote'))
  assert.ok(inj.includes('remote.settings'), '★ 缺 remote.settings 时 ctx.remote.settings 为 undefined（本次 bug 根因）')
})

console.log('\n— ① remote 正常 —')
await check('从 {ok,value:{namespaces}} 按 ns 取值，writable=true', async () => {
  const form = await boot({
    describe: async () => ({
      ok: true,
      value: { namespaces: [
        { ns: 'other', revision: 3, value: { x: 1 } },
        { ns: 'qq-guard', revision: 7, value: { bubbleMaxChars: 15, groupAtReply: false } },
      ] },
    }),
    mutate: async () => ({ ok: true, value: { revision: 8 } }),
  })
  assert.ok(form, '应注入 form')
  const snap = form.getSnapshot()
  assert.equal(snap.status, 'ready', `status=${snap.status} err=${snap.error}`)
  assert.equal(snap.writable, true)
  assert.equal(snap.source, 'remote')
  assert.equal(snap.value.bubbleMaxChars, 15, '应按 ns 取到 qq-guard 的值而非 other')
  assert.equal(snap.revision, 7, '应记录 revision')
})

console.log('\n— ② remote 缺失 → HTTP 兜底 —')
await check('remote undefined 时退回 HTTP，writable=false', async () => {
  await withFetch(
    async (url) => {
      assert.ok(String(url).includes('/dsh-qq-guard/config'), `应请求配置路由，实际 ${url}`)
      return { ok: true, json: async () => ({ ok: true, config: { bubbleMaxChars: 20 } }) }
    },
    async () => {
      const form = await boot({})
      assert.ok(form)
      const snap = form.getSnapshot()
      assert.equal(snap.status, 'ready', `status=${snap.status} err=${snap.error}`)
      assert.equal(snap.source, 'http')
      assert.equal(snap.writable, false, 'HTTP 兜底必须只读')
      assert.equal(snap.value.bubbleMaxChars, 20)
    },
  )
})

console.log('\n— ③ 都失败 → 真实 error —')
await check('remote 与 HTTP 都挂时 status=error 且 error 含原因', async () => {
  await withFetch(
    async () => { throw new Error('ECONNREFUSED') },
    async () => {
      const form = await boot({})
      const snap = form.getSnapshot()
      assert.equal(snap.status, 'error')
      assert.ok(typeof snap.error === 'string' && snap.error.length > 0, 'error 不能为空')
      assert.ok(/ECONNREFUSED|不可用|失败/.test(snap.error), `error 应含真实原因，实际：${snap.error}`)
      console.log(`      实际 error → ${snap.error}`)
    },
  )
})
await check('describe 抛错不被静默吞掉', async () => {
  await withFetch(
    async () => { throw new Error('net down') },
    async () => {
      const form = await boot({
        describe: async () => { throw new Error('rpc timeout') },
        mutate: async () => ({ ok: true, value: {} }),
      })
      const snap = form.getSnapshot()
      assert.equal(snap.status, 'error')
      assert.ok(snap.error.length > 0)
      console.log(`      实际 error → ${snap.error}`)
    },
  )
})
await check('describe 返回 ok:false 时报出 error 内容', async () => {
  await withFetch(
    async () => { throw new Error('http down') },
    async () => {
      const form = await boot({
        describe: async () => ({ ok: false, error: { message: 'permission denied' } }),
        mutate: async () => ({ ok: true, value: {} }),
      })
      const snap = form.getSnapshot()
      assert.equal(snap.status, 'error')
      assert.ok(snap.error.includes('permission denied'), `应带后端 error，实际：${snap.error}`)
    },
  )
})

console.log('\n— ④ mutate 语义 —')
await check('只读模式（HTTP 兜底）写入返回 false 且不抛错', async () => {
  await withFetch(
    async () => ({ ok: true, json: async () => ({ ok: true, config: {} }) }),
    async () => {
      const form = await boot({})
      const ok = await form.mutate([{ op: 'set', path: ['bubbleMaxChars'], value: 9 }])
      assert.equal(ok, false, '只读应返回 false')
    },
  )
})
await check('remote 模式写入成功、revision 前进', async () => {
  let rev = 1
  const form = await boot({
    describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'qq-guard', revision: rev, value: { bubbleMaxChars: 30 } }] } }),
    mutate: async (_ns, _ops, expected) => {
      assert.equal(expected, rev, '应以当前 revision 作为 expectedRevision')
      rev += 1
      return { ok: true, value: { revision: rev } }
    },
  })
  const before = form.getSnapshot().revision
  const ok = await form.mutate([{ op: 'set', path: ['bubbleMaxChars'], value: 9 }])
  assert.equal(ok, true)
  assert.ok(form.getSnapshot().revision > before, 'revision 应前进')
})
await check('写入被拒（ok:false）时返回 false 并重新对齐 revision', async () => {
  let rev = 5
  const form = await boot({
    describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'qq-guard', revision: rev, value: {} }] } }),
    mutate: async () => { rev = 9; return { ok: false, error: { message: 'stale revision' } } },
  })
  const ok = await form.mutate([{ op: 'set', path: ['bubbleMaxChars'], value: 9 }])
  assert.equal(ok, false)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(form.getSnapshot().revision, 9, '失败后应重读拿到最新 revision')
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
