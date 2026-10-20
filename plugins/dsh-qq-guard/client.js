/**
 * QQ 桥接设置页（批次 4A）。
 *
 * 挂在 `plugins.bundle.config` 槽位（key = 本包名），出现在 Plugins 设置页本插件的详情页里。
 * 这是 mnemon / dsh-context 用的同一个位置。
 *
 * 数据通路（全部走官方服务，不自己拼 remote 调用）：
 *   - 读/写表单：`ctx.configForms.get(entryId)` 返回 ConfigFormController，
 *     `attach(form)` 后订阅快照，`form.set(field, value)` 写回。
 *     entryId 就是 profile 里本插件的条目 id —— 本包 bundle patch 插入的是
 *     `preset-qq-chat` 与 `qq-guard` 两行；设置项定义在 `qq-guard` 这条顶层行上
 *     （preset 子行拿不到 webServer，且 Config 需要能被 Settings 投影）。
 *   - 持久化：由 dsh-settings + dsh-config-editor 写进 profile 的 cordis.patch.yml，
 *     重启后仍在。
 *
 * 为什么不用 autoGenerate：dsh-settings 的 README 明确写着
 * 「每个表单报告 autoGenerate（默认开启），供按 schema 生成页面的客户端使用；
 *   目前没有已发布的客户端这样做。」——所以必须自带页面。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-qq-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 本插件在 profile 里的顶层条目 id（见 cordis.patch.yml 的 `- id: qq-guard`）。 */
    const ENTRY_ID = 'qq-guard'

    const CSS = `
.qqg-card { display: flex; flex-direction: column; gap: 14px; padding: 2px 0 4px; }
.qqg-group { display: flex; flex-direction: column; gap: 8px; }
.qqg-group-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); letter-spacing: .02em; }
.qqg-row { display: flex; align-items: flex-start; gap: 12px; padding: 7px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.qqg-row:first-of-type { border-top: 0; }
.qqg-label { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.qqg-label-main { font-size: 13px; color: var(--dsw-alias-label-primary); }
.qqg-label-desc { font-size: 11.5px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
.qqg-control { flex: 0 0 148px; display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.qqg-input { box-sizing: border-box; width: 148px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 4px 8px; }
.qqg-input:focus { outline: none; border-color: var(--dsw-alias-label-secondary); }
.qqg-input-num { width: 88px; text-align: right; font-variant-numeric: tabular-nums; }
.qqg-switch { position: relative; width: 36px; height: 20px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); cursor: pointer; padding: 0; transition: background .15s ease, border-color .15s ease; }
.qqg-switch[aria-checked="true"] { background: var(--dsw-alias-button-primary-fill); border-color: transparent; }
.qqg-switch i { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: var(--dsw-alias-label-primary); transition: transform .15s ease; }
.qqg-switch[aria-checked="true"] i { transform: translateX(16px); background: var(--dsw-alias-label-primary-foreground); }
.qqg-status { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.qqg-status-err { color: var(--dsw-alias-state-error-primary); }
.qqg-detail { margin-top: 4px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  white-space: pre-wrap; overflow-wrap: anywhere; }
.qqg-hint { font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2); border-radius: 6px; padding: 7px 10px; }
.qqg-page { box-sizing: border-box; width: 100%; min-width: 0; height: 100%; min-height: 0;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  display: flex; flex-direction: column; overflow: hidden; }
.qqg-pagehead { flex: 0 0 auto; padding: 28px clamp(24px, 4vw, 48px) 0; }
.qqg-pagetitle { margin: 0 0 6px; font-size: 20px; font-weight: 500; line-height: 28px; }
.qqg-pagedesc { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.qqg-pagebody { flex: 1 1 auto; min-height: 0; overflow-y: auto;
  padding: 20px clamp(24px, 4vw, 48px) 48px; }
.qqg-pagebody .qqg-card { max-width: 760px; }

/* ── 左导航 + 右内容（主面板）────────────────────────────── */
.qqg-layout { display: flex; align-items: stretch; width: 100%; min-width: 0; height: 100%; min-height: 0;
  gap: 20px; padding: 24px clamp(20px, 3vw, 40px) 32px; box-sizing: border-box;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.qqg-nav { flex: 0 0 168px; width: 168px; display: flex; flex-direction: column; gap: 2px;
  padding-right: 12px; border-right: 1px solid var(--dsw-alias-border-l1);
  overflow-y: auto; min-height: 0; }
.qqg-nav-item { box-sizing: border-box; width: 100%; text-align: left; font: inherit; font-size: 13px;
  color: var(--dsw-alias-label-secondary); background: transparent; border: 0; border-radius: 6px;
  padding: 7px 10px; cursor: pointer; transition: background .12s ease, color .12s ease; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.qqg-nav-item:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.qqg-nav-item-on, .qqg-nav-item-on:hover { background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-label-primary); font-weight: 600; }
.qqg-content { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 18px; padding-right: 4px; }
.qqg-content .qqg-group { border-top: 0; padding-top: 0; }
.qqg-subgroup { display: flex; flex-direction: column; gap: 8px; }

/* ── 通用控件补充 ─────────────────────────────────────────── */
/* 关键：圆点与文字必须同一条水平线（用户反馈过没居中）*/
.qqg-inline { display: inline-flex; align-items: center; justify-content: flex-start;
  gap: 7px; flex-wrap: wrap; line-height: 1.4; }
.qqg-state { display: inline-flex; align-items: center; line-height: 1.4;
  color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
.qqg-dim { opacity: .75; }
/* 分组标题 + 右上角按钮 */
.qqg-group-head { display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap; }
.qqg-actions { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.qqg-btn-danger { color: var(--dsw-alias-state-error-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
.qqg-btn-danger:hover:enabled { border-color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
/* 桥接日志折叠区 */
.qqg-logbox { margin-top: 4px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.qqg-logbox summary { cursor: pointer; user-select: none; padding: 2px 0; }
.qqg-log { margin: 6px 0 0; padding: 8px 10px; max-height: 220px; overflow: auto;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
/* 状态小标签（NapCat 页「已停止」用）*/
.qqg-tag { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px;
  border-radius: 999px; padding: 1px 9px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.qqg-tag-ok { color: var(--dsw-alias-state-success-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.qqg-tag-err { color: var(--dsw-alias-state-error-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.qqg-tag-warn { color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary));
  border-color: var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary)) 10%, transparent); }
.qqg-mono { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.qqg-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; display: inline-block; }
.qqg-dot-ok { background: var(--dsw-alias-state-success-primary); }
.qqg-dot-err { background: var(--dsw-alias-state-error-primary); }
.qqg-dot-warn { background: var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary)); }
.qqg-dot-idle { background: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); opacity: .5; }
.qqg-btn { box-sizing: border-box; font: inherit; font-size: 12px; line-height: 1.4; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 4px 10px;
  transition: border-color .12s ease, background .12s ease; white-space: nowrap; }
.qqg-btn:hover:enabled { border-color: var(--dsw-alias-label-secondary); }
.qqg-btn:disabled { opacity: .45; cursor: default; }
.qqg-btn-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground);
  border-color: transparent; }
.qqg-btn-primary:hover:enabled { border-color: transparent; filter: brightness(1.06); }
.qqg-input-grow { flex: 1 1 auto; width: auto; min-width: 0; }

/* ── 多行文本框（人设）────────────────────────────────────── */
.qqg-textarea-wrap { display: flex; flex-direction: column; gap: 8px; }
.qqg-textarea { box-sizing: border-box; width: 100%; resize: vertical; font: inherit; font-size: 12px;
  line-height: 1.6; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 8px 10px;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); }
.qqg-textarea:focus { outline: none; border-color: var(--dsw-alias-label-secondary); }
.qqg-textarea:disabled { opacity: .6; }
.qqg-textarea-actions { display: flex; align-items: center; gap: 10px; }

/* ── 白名单列表 ───────────────────────────────────────────── */
.qqg-list { display: flex; flex-direction: column; gap: 8px; }
.qqg-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.qqg-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px; padding: 2px 4px 2px 10px; max-width: 100%; }
.qqg-chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qqg-chip-x { font: inherit; font-size: 13px; line-height: 1; color: var(--dsw-alias-label-secondary);
  background: transparent; border: 0; border-radius: 50%; width: 18px; height: 18px; padding: 0;
  cursor: pointer; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; }
.qqg-chip-x:hover:enabled { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.qqg-chip-x:disabled { opacity: .4; cursor: default; }
.qqg-list-add { display: flex; align-items: center; gap: 8px; }
`

    /** 默认值：与 Host 侧 Config 的 .default() 必须一致。 */
    const DEFAULTS = {
      bubbleMaxChars: 30,
      mergeMaxChars: 15,
      chunkSize: 1000,
      sendIntervalMs: 500,
      groupAtReply: true,
      groupAtPosition: 'last',
      'typingDelay.enabled': true,
      'flypitDelayTiers.short': 200,
      'flypitDelayTiers.medium': 450,
      'flypitDelayTiers.long': 800,
      'trimEndPunctuation.enabled': true,
    }

    /** 按点分路径取值（'typingDelay.enabled' → value.typingDelay.enabled）。 */
    function getPath(obj, path) {
      let cur = obj
      for (const key of path.split('.')) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
        cur = cur[key]
      }
      return cur
    }

    /** 把点分路径拆成 mutate 需要的段数组。 */
    function splitPath(path) {
      return String(path).split('.')
    }

    function useForm(form) {
      const [snap, setSnap] = React.useState(() => (form ? form.getSnapshot() : undefined))
      React.useEffect(() => {
        if (!form) return undefined
        setSnap(form.getSnapshot())
        return form.subscribe(() => setSnap(form.getSnapshot()))
      }, [form])
      return snap
    }

    /**
     * 一个最小的、**不依赖 configForms 服务**的设置表单适配器。
     *
     * 为什么需要它：`settings.section` 槽位的 ownerProps 只有 `{ close }`，
     * 框架**不会**往里传 `form`（对比 `plugins.bundle.config` 的 ownerProps 才有 `form`）。
     * 所以左侧独立入口里必须自己拿配置：读走 `remote.settings.describe()`，
     * 写走 `remote.settings.mutate(ns, ops, revision)`——都是 ui-settings 提供的官方 Remote。
     *
     * 与 configForms 的 ConfigFormController 保持同名接口（getSnapshot/subscribe/mutate），
     * 这样 SettingsPanel 两种来源都能直接用。
     */
    /**
     * 设置数据通路的解析顺序（三重兜底）：
     *   ① ctx.remote.settings.describe() / .mutate() —— 官方 Remote，最稳
     *   ② 只读 HTTP 路由 GET /dsh-qq-guard/config —— 读兜底（Host 会一直提供）
     *   ③ 都没有 → 明确报错，把真实原因打到 console.error
     *
     * 2026-10-20 踩坑记录：
     *   一开始 inject 只写了 `['slots', 'remote']`，漏了 `'remote.settings'`，
     *   于是 `ctx.remote.settings` 是 undefined，页面只显示「服务不可用」。
     *   官方 ui-settings 自己声明的就是 `['remote', 'remote.settings']`
     *   （见 dsh-client-ui-settings/lib/client.js 的 `const inject = [...]`）。
     *   所以 inject 必须补全，并且这里要把真实 error 打出来，不能静默吞。
     */
    const HTTP_CONFIG_PATH = '/dsh-qq-guard/config'

    /** 通过只读 HTTP 路由读一次配置（不需要 remote 服务）。 */
    async function fetchConfigHttp() {
      const res = await fetch(HTTP_CONFIG_PATH, {
        headers: { accept: 'application/json' },
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`GET ${HTTP_CONFIG_PATH} → HTTP ${res.status}`)
      const body = await res.json()
      if (body?.ok !== true || !body.config) throw new Error('HTTP 路由返回格式不符')
      return body.config
    }

    function createRemoteForm(ctx, namespace) {
      let snapshot = { status: 'loading', value: {}, writable: false, revision: undefined, source: undefined, error: undefined }
      const listeners = new Set()
      let revision
      let pending = Promise.resolve()

      const emit = () => { for (const fn of listeners) { try { fn() } catch { /* 订阅方异常不影响其它订阅 */ } } }
      const set = (next) => { snapshot = { ...snapshot, ...next }; emit() }

      /** remote.settings 是否就绪（inject 声明 + 服务实际挂载）。 */
      const remoteSettings = () => {
        try { return ctx?.remote?.settings } catch { return undefined }
      }

      /**
       * 读一次配置。maxTries 用于等 remote 服务就绪：刚打开面板时
       * remote 可能还没 bind 完，前几次失败不该立刻报错。
       */
      const load = async ({ tries = 1, delayMs = 120 } = {}) => {
        let remoteError
        let httpError
        for (let attempt = 1; attempt <= tries; attempt++) {
          // ① 官方 Remote
          const settings = remoteSettings()
          if (settings && typeof settings.describe === 'function') {
            try {
              const res = await settings.describe()
              // 形状：{ ok, value: { namespaces: [{ ns, revision, value }] } }
              if (!res?.ok) throw new Error(`describe 未成功：${JSON.stringify(res?.error ?? res)}`)
              const rows = res.value?.namespaces
              if (!Array.isArray(rows)) throw new Error('describe 返回缺少 namespaces 数组')
              const row = rows.find((r) => r.ns === namespace)
              if (!row) throw new Error(`describe 里没有 ns="${namespace}"（可能该行未被 Settings 投影）`)
              revision = row.revision
              set({ status: 'ready', value: row.value ?? {}, writable: true, source: 'remote', error: undefined, revision: row.revision })
              return
            } catch (error) {
              remoteError = error
              console.error('[qq-guard] remote.settings.describe 失败：', error)
            }
          } else {
            remoteError = new Error(
              'ctx.remote.settings 不可用（inject 里需同时声明 "remote" 与 "remote.settings"）',
            )
            if (attempt === 1) console.error('[qq-guard]', remoteError.message, { hasRemote: !!ctx?.remote })
          }

          // ② 退到只读 HTTP 路由（只读，不能写）
          try {
            const config = await fetchConfigHttp()
            set({ status: 'ready', value: config, writable: false, source: 'http', error: undefined })
            console.warn('[qq-guard] 已退回只读 HTTP 路由；此模式不能修改配置。')
            return
          } catch (error) {
            httpError = error
            console.error('[qq-guard] 只读 HTTP 路由也失败：', error)
          }

          if (attempt < tries) await new Promise((r) => setTimeout(r, delayMs))
        }
        // 两条通路都失败：**优先报告 remote 的错误**——它更具体
        // （例如后端返回的 permission denied / 没被 Settings 投影），
        // HTTP 兜底失败往往只是「顺带也连不上」，信息量更低。
        const primary = remoteError ?? httpError
        const secondary = remoteError && httpError ? httpError : undefined
        const detail = [primary?.message, secondary ? `（HTTP 兜底也失败：${secondary.message}）` : '']
          .filter(Boolean).join(' ')
        console.error('[qq-guard] 读取配置最终失败：', primary, secondary ?? '')
        set({ status: 'error', writable: false, source: undefined, error: detail || String(primary) })
      }

      void load({ tries: 6, delayMs: 150 })

      // 文档更新时（含本插件写入成功后）刷新，保证多端一致。
      ctx.effect(() => ctx.on('settings/document-updated', (ns) => {
        if (ns === namespace) void load()
      }), 'qq-guard: settings document updates')

      return {
        getSnapshot: () => snapshot,
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
        mutate(ops) {
          pending = pending.then(async () => {
            const settings = remoteSettings()
            if (!settings || typeof settings.mutate !== 'function') {
              console.error('[qq-guard] 写入失败：ctx.remote.settings 不可用，只读 HTTP 兜底模式不能写配置')
              return false
            }
            try {
              const res = await settings.mutate(namespace, ops, revision)
              if (!res?.ok) {
                console.error('[qq-guard] mutate 未成功：', res?.error ?? res)
                // 失败时重读，拿到最新 revision 让下一次写入不被拒
                await load()
                return false
              }
              revision = res.value?.revision ?? revision
              await load()
              return true
            } catch (error) {
              console.error('[qq-guard] mutate 抛错：', error)
              return false
            }
          })
          return pending
        },
      }
    }

    /** 侧边栏图标：对话气泡 + 一个桥接弧，纯 SVG（不引外部资源）。 */
    function QqBridgeIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 20
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
      // 左侧气泡
      h('path', { d: 'M3.5 6.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8l-3 2.6V13.5H5.5a2 2 0 0 1-2-2z' }),
      // 右侧气泡（表示来回）
      h('path', { d: 'M15 11.5h3.5a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H16l-2.6 2v-2.6H15a2 2 0 0 1-2-2v-1.4' }))
    }

    /** 主面板：一页标题 + 设置表单。 */
    function BridgePanel(props) {
      // main 槽位也不给 form；用 props 里注入的 remoteForm（见 apply 里的 inject）。
      return h('div', { className: 'qqg-page' },
        h('div', { className: 'qqg-pagehead' },
          h('h1', { className: 'qqg-pagetitle' }, 'QQ 桥接'),
          h('p', { className: 'qqg-pagedesc' }, 'QQ 消息与 DSH 会话之间的桥接参数。改完即时生效，无需重启桥接。')),
        h('div', { className: 'qqg-pagebody' },
          h(SettingsPanel, props)),
      )
    }

    function Row({ label, desc, children }) {
      return h('div', { className: 'qqg-row' },
        h('div', { className: 'qqg-label' },
          h('div', { className: 'qqg-label-main' }, label),
          desc ? h('div', { className: 'qqg-label-desc' }, desc) : null),
        h('div', { className: 'qqg-control' }, children))
    }

    function Switch({ checked, disabled, onChange, ariaLabel }) {
      return h('button', {
        type: 'button',
        className: 'qqg-switch',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': ariaLabel,
        disabled,
        onClick: () => onChange(!checked),
      }, h('i'))
    }

    function NumberField({ value, min, max, disabled, onCommit, ariaLabel }) {
      const [draft, setDraft] = React.useState(String(value ?? ''))
      React.useEffect(() => { setDraft(String(value ?? '')) }, [value])
      const commit = () => {
        const n = Number(draft)
        if (!Number.isFinite(n)) { setDraft(String(value ?? '')); return }
        const clamped = Math.min(max, Math.max(min, Math.trunc(n)))
        setDraft(String(clamped))
        if (clamped !== value) onCommit(clamped)
      }
      return h('input', {
        type: 'number',
        className: 'qqg-input qqg-input-num',
        value: draft,
        min, max,
        disabled,
        'aria-label': ariaLabel,
        onChange: (e) => setDraft(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); e.currentTarget.blur() } },
      })
    }

    /** 内置面板的左侧导航分类。 */
    const SECTIONS = [
      { id: 'status', label: '运行状态' },
      { id: 'napcat', label: 'NapCat 管理' },
      { id: 'onebot', label: 'OneBot 连接' },
      { id: 'allow', label: '白名单管理' },
      { id: 'persona', label: '人设配置' },
      { id: 'split', label: '分片与节奏' },
    ]

    /** 一条「标签 + 说明 + 控件」行。 */
    function Field(props) { return h(Row, props) }

    /** 多行文本框（人设用）。草稿本地保存，失焦或点保存时提交。 */
    function TextArea({ value, disabled, rows, placeholder, onCommit, ariaLabel }) {
      const [draft, setDraft] = React.useState(String(value ?? ''))
      const dirty = draft !== String(value ?? '')
      React.useEffect(() => { setDraft(String(value ?? '')) }, [value])
      return h('div', { className: 'qqg-textarea-wrap' },
        h('textarea', {
          className: 'qqg-textarea',
          value: draft,
          rows: rows ?? 12,
          disabled,
          placeholder,
          'aria-label': ariaLabel,
          onChange: (e) => setDraft(e.target.value),
        }),
        h('div', { className: 'qqg-textarea-actions' },
          h('button', {
            type: 'button',
            className: 'qqg-btn qqg-btn-primary',
            disabled: disabled || !dirty,
            onClick: () => onCommit(draft),
          }, '保存'),
          dirty ? h('span', { className: 'qqg-status' }, '有未保存改动') : null))
    }

    /** 一行一个条目的列表编辑器（白名单用）。 */
    function ListEditor({ items, disabled, placeholder, addLabel, onChange, ariaLabel }) {
      const list = Array.isArray(items) ? items : []
      const [draft, setDraft] = React.useState('')
      const add = () => {
        const v = draft.trim()
        if (!v) return
        if (list.includes(v)) { setDraft(''); return }
        onChange([...list, v])
        setDraft('')
      }
      return h('div', { className: 'qqg-list' },
        list.length === 0
          ? h('div', { className: 'qqg-status' }, '（空）')
          : h('div', { className: 'qqg-chips' }, list.map((item) =>
            h('span', { key: item, className: 'qqg-chip' },
              h('span', { className: 'qqg-chip-text' }, item),
              h('button', {
                type: 'button',
                className: 'qqg-chip-x',
                disabled,
                'aria-label': `删除 ${item}`,
                onClick: () => onChange(list.filter((x) => x !== item)),
              }, '×')))),
        h('div', { className: 'qqg-list-add' },
          h('input', {
            className: 'qqg-input qqg-input-grow',
            value: draft,
            disabled,
            placeholder,
            'aria-label': ariaLabel,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); add() } },
          }),
          h('button', {
            type: 'button',
            className: 'qqg-btn',
            disabled: disabled || !draft.trim(),
            onClick: add,
          }, addLabel ?? '添加')))
    }

    /** 轮询桥接上报的运行状态（桥接 → Host → 这里）。 */
    function useBridgeStatus(enabled) {
      const [status, setStatus] = React.useState(null)
      React.useEffect(() => {
        if (!enabled) return undefined
        let stopped = false
        let timer = null
        const tick = async () => {
          if (stopped) return
          try {
            const res = await fetch('/dsh-qq-guard/status', {
              headers: { accept: 'application/json' },
              credentials: 'include',
            })
            if (res.ok) {
              const body = await res.json()
              setStatus(body?.reported === true ? body.status : null)
            }
          } catch { /* 状态拿不到不影响设置编辑 */ }
          if (!stopped) timer = setTimeout(tick, 3000)
        }
        void tick()
        return () => { stopped = true; if (timer) clearTimeout(timer) }
      }, [enabled])
      return status
    }

    /** 桥接进程状态轮询（用于按钮与状态灯）。 */
    function useBridgeProc(enabled) {
      const [snap, setSnap] = React.useState(null)
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        if (!enabled) return undefined
        let stopped = false
        let timer = null
        const load = async () => {
          try {
            const res = await fetch('/dsh-qq-guard/bridge?action=status', {
              headers: { accept: 'application/json' }, credentials: 'include',
            })
            if (res.ok) setSnap(await res.json())
          } catch { /* 状态查询失败不阻塞 UI */ }
          if (!stopped) timer = setTimeout(load, 3000)
        }
        void load()
        return () => { stopped = true; if (timer) clearTimeout(timer) }
      }, [enabled, tick])
      return [snap, () => setTick((v) => v + 1)]
    }

    function StatusSection({ get, writable }) {
      const live = useBridgeStatus(true)
      const [proc, refreshProc] = useBridgeProc(true)
      const [busy, setBusy] = React.useState(null)
      const [err, setErr] = React.useState(null)

      const dot = (ok) => h('span', {
        className: 'qqg-dot ' + (ok === true ? 'qqg-dot-ok' : ok === false ? 'qqg-dot-err' : 'qqg-dot-idle'),
      })
      const label = (ok) => (ok === true ? '已连接' : ok === false ? '未连接' : '未知（桥接未上报）')

      // 批次 5：桥接改为上报四态 qqState（online/offline/unverified/disconnected）。
      // 旧版桥接只上报 qqConnected 布尔，这里保留回落，避免状态灯显示错。
      const qqState = live && typeof live.qqState === 'string' ? live.qqState : undefined
      const qqText = {
        online: '在线（WS get_status 确认）',
        unverified: '已连接（账号状态未确认）',
        offline: '已连接（QQ 账号离线）',
        disconnected: '未连接',
      }[qqState] ?? (live ? label(live.qqConnected === true) : '未知（桥接未上报）')
      // online=绿；disconnected=红；unverified/offline=黄（连接在，但账号状态没确认/不可用）。
      const qqDotOk = qqState === undefined
        ? (live ? live.qqConnected === true : undefined)
        : (qqState === 'online' ? true : qqState === 'disconnected' ? false : null)
      const dshOk = live ? live.dshOk === true : undefined
      const counts = live?.counts ?? {}
      const countText = live
        ? `收 ${counts.received ?? 0} · 回 ${counts.replied ?? 0} · 拦 ${counts.blocked ?? 0} · 拒 ${counts.denied ?? 0} · 失败 ${counts.failed ?? 0}`
        : '—'

      const alive = proc?.alive === true
      const act = async (action) => {
        setBusy(action); setErr(null)
        try {
          const res = await fetch(`/dsh-qq-guard/bridge?action=${action}`, {
            method: 'POST', credentials: 'include',
            headers: { accept: 'application/json' },
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || !body.ok) setErr(body.detail ?? body.reason ?? `HTTP ${res.status}`)
        } catch (e) { setErr(e?.message ?? String(e)) }
        finally { setBusy(null); refreshProc() }
      }

      return h('div', { className: 'qqg-group' },
        h('div', { className: 'qqg-group-head' },
          h('div', { className: 'qqg-group-title' }, '运行状态'),
          // 三个控制按钮：右上角
          h('div', { className: 'qqg-actions' },
            h('button', {
              type: 'button', className: 'qqg-btn qqg-btn-primary',
              disabled: busy !== null || !writable || alive,
              title: alive ? '桥接已在运行' : '在后台常驻运行桥接',
              onClick: () => act('start'),
            }, busy === 'start' ? '启动中…' : '启动桥接'),
            h('button', {
              type: 'button', className: 'qqg-btn',
              disabled: busy !== null || !writable || !alive,
              title: alive ? '停止桥接进程' : '桥接未运行',
              onClick: () => act('stop'),
            }, busy === 'stop' ? '停止中…' : '停止桥接'),
            h('button', {
              type: 'button', className: 'qqg-btn qqg-btn-danger',
              disabled: busy !== null || !writable,
              title: '彻底退出：停止并禁止自动重启',
              onClick: () => act('exit'),
            }, busy === 'exit' ? '退出中…' : '退出桥接'))),

        h(Field, { label: '桥接进程', desc: '插件托管的常驻进程；关闭 DSH 时会自动清理。' },
          h('div', { className: 'qqg-inline' },
            dot(proc ? alive : undefined),
            h('span', { className: 'qqg-state' }, proc ? (alive ? '运行中' : '已停止') : '查询中…'),
            proc?.uptimeMs ? h('span', { className: 'qqg-mono qqg-dim' }, `已运行 ${Math.round(proc.uptimeMs / 1000)}s`) : null)),

        h(Field, { label: 'DSH 连接', desc: '桥接是否连上本 DSH 实例。' },
          h('div', { className: 'qqg-inline' }, dot(dshOk), h('span', { className: 'qqg-state' }, label(dshOk)))),
        h(Field, { label: 'NapCat / QQ', desc: 'WS 是否连上 NapCat + 由 get_status 确认的 QQ 账号在线状态（纯 WS，不需要 NapCat HTTP API）。' },
          h('div', { className: 'qqg-inline' }, dot(qqDotOk), h('span', { className: 'qqg-state' }, qqText))),
        h(Field, { label: '累计收发', desc: '自桥接启动以来的计数（每 3 秒刷新）。' },
          h('div', { className: 'qqg-inline' }, h('span', { className: 'qqg-mono' }, countText))),

        err ? h('div', { className: 'qqg-status qqg-status-err' }, err) : null,
        proc?.lastError ? h('div', { className: 'qqg-detail' }, `上次错误：${proc.lastError}`) : null,

        proc?.logTail?.length
          ? h('details', { className: 'qqg-logbox' },
            h('summary', null, `桥接最近日志（${proc.logTail.length} 行）`),
            h('pre', { className: 'qqg-log' }, proc.logTail.join('\n')))
          : null,

        h('div', { className: 'qqg-hint' },
          '「启动桥接」会在后台常驻运行 start.mjs，日志可见于上方折叠区。',
          h('br'),
          '「退出桥接」= 停止且不自动重启；DSH 退出时会自动停掉它，不留孤儿进程。'))
    }

    function OneBotSection({ get, write, writable }) {
      const [tokenShown, setTokenShown] = React.useState(false)
      const token = get('onebot.accessToken')
      return h('div', { className: 'qqg-group' },
        h('div', { className: 'qqg-group-title' }, 'OneBot 连接'),
        h(Field, { label: 'WebSocket 地址', desc: 'NapCat 的正向 WS 服务端地址。' },
          h('input', {
            className: 'qqg-input qqg-input-grow',
            value: get('onebot.wsUrl') ?? '',
            disabled: !writable,
            'aria-label': 'WebSocket 地址',
            onChange: (e) => write('onebot.wsUrl', e.target.value),
          })),
        h(Field, { label: 'Access Token', desc: '以密码形式保存，默认不显示明文。' },
          h('div', { className: 'qqg-inline' },
            h('input', {
              className: 'qqg-input qqg-input-grow',
              type: tokenShown ? 'text' : 'password',
              value: token ?? '',
              disabled: !writable,
              'aria-label': 'Access Token',
              onChange: (e) => write('onebot.accessToken', e.target.value),
            }),
            h('button', {
              type: 'button',
              className: 'qqg-btn',
              onClick: () => setTokenShown((v) => !v),
            }, tokenShown ? '隐藏' : '显示'))),
        h('div', { className: 'qqg-hint' },
          '改动会在桥接重启后生效（WS 连接在启动时建立，不做热重连）。'))
    }

    function AllowSection({ get, write, writable, form }) {
      const priv = get('allow.private')
      const groups = get('allow.groups')
      const allowAll = get('allow.allowAllWhenEmpty') === true
      // 数组不能整体 set 后靠路径猜测，这里直接写整段 allow。
      const setAllow = (patch) => {
        if (!form) return
        form.mutate(Object.entries(patch).map(([k, v]) => ({ op: 'set', path: ['allow', k], value: v })))
      }
      return h('div', { className: 'qqg-group' },
        h('div', { className: 'qqg-group-title' }, '白名单管理'),
        h(Field, { label: '允许的私聊 QQ 号', desc: '留空且未开启「放行全部」时，谁都不理（fail-closed）。' },
          h(ListEditor, {
            items: priv, disabled: !writable, placeholder: '输入 QQ 号后回车',
            ariaLabel: '私聊白名单',
            onChange: (next) => setAllow({ private: next }),
          })),
        h(Field, { label: '允许的群号', desc: '群聊同样按此白名单放行。' },
          h(ListEditor, {
            items: groups, disabled: !writable, placeholder: '输入群号后回车',
            ariaLabel: '群白名单',
            onChange: (next) => setAllow({ groups: next }),
          })),
        h(Field, { label: '白名单为空时放行全部', desc: '⚠️ 打开后任何人都能让 bot 回话，慎用。' },
          h(Switch, {
            checked: allowAll, disabled: !writable,
            ariaLabel: '白名单为空时放行全部',
            onChange: (v) => setAllow({ allowAllWhenEmpty: v }),
          })),
        h('div', { className: 'qqg-hint' },
          '白名单每次收到消息都从最新配置现读，保存后下一条消息立即生效，无需重启桥接。'))
    }

    function PersonaSection({ get, write, writable, form }) {
      const text = get('personaText') ?? ''
      const presetDefault = get('personaPresetDefault') ?? ''
      return h('div', { className: 'qqg-group' },
        h('div', { className: 'qqg-group-title' }, '人设配置'),
        h('div', { className: 'qqg-subgroup' },
          h(Field, {
            label: '自定义人设',
            desc: '非空时覆盖 qq-chat preset 的默认人设；留空则使用默认。保存后对新会话生效。',
          }, h('span', { className: 'qqg-mono' }, `${[...text].length} 字`)),
          h(TextArea, {
            value: text, disabled: !writable, rows: 14,
            placeholder: '例如：你是一只傲娇猫娘，说话带「哼」「才不是呢」……',
            ariaLabel: '自定义人设',
            onCommit: (v) => write('personaText', v),
          }),
          h('div', { className: 'qqg-textarea-actions' },
            h('button', {
              type: 'button',
              className: 'qqg-btn',
              disabled: !writable || presetDefault === '',
              title: presetDefault === '' ? '尚未取到 preset 默认人设' : '恢复为 preset 自带人设',
              onClick: () => write('personaText', ''),
            }, '恢复默认人设')),
        ),
        h('div', { className: 'qqg-hint' },
          '留空 = 使用 preset 内置人设。「恢复默认」只是把人设清空后回落到 preset，不会删除 preset 本身。'))
    }

    function SplitSection({ get, write, writable }) {
      return h(React.Fragment, null,
        h('div', { className: 'qqg-group' },
          h('div', { className: 'qqg-group-title' }, '分片'),
          h(Field, { label: '单行语义切阈值', desc: '模型换行仍是强边界；只有单行超过这个字数才按标点切。单位：字（Unicode 码点）。' },
            h(NumberField, {
              value: get('bubbleMaxChars'), min: 1, max: 1000, disabled: !writable,
              ariaLabel: '单行语义切阈值', onCommit: (n) => write('bubbleMaxChars', n),
            })),
          h(Field, { label: '碎片合并上限', desc: '仅合并桥接自己硬切出的碎句，绝不跨模型原生换行合并。' },
            h(NumberField, {
              value: get('mergeMaxChars'), min: 1, max: 1000, disabled: !writable,
              ariaLabel: '碎片合并上限', onCommit: (n) => write('mergeMaxChars', n),
            })),
          h(Field, { label: 'QQ 单条硬上限', desc: '仅用于防「一条太长发不出去」，正常聊天不会触到。' },
            h(NumberField, {
              value: get('chunkSize'), min: 1, max: 100000, disabled: !writable,
              ariaLabel: 'QQ 单条硬上限', onCommit: (n) => write('chunkSize', n),
            }))),
        h('div', { className: 'qqg-group' },
          h('div', { className: 'qqg-group-title' }, '打字延时'),
          h(Field, { label: '启用分级打字延时', desc: '关闭 = 不分片、不延时、整条合并发送。' },
            h(Switch, {
              checked: get('typingDelay.enabled') !== false, disabled: !writable,
              ariaLabel: '打字延时总开关', onChange: (v) => write('typingDelay.enabled', v),
            })),
          h(Field, { label: '短句（<10 字）', desc: '毫秒。实际会在 ±15% 内抖动，且不低于 150ms。' },
            h(NumberField, {
              value: get('flypitDelayTiers.short'), min: 0, max: 60000, disabled: !writable,
              ariaLabel: '短句延时', onCommit: (n) => write('flypitDelayTiers.short', n),
            })),
          h(Field, { label: '中等（10~14 字）', desc: '毫秒。' },
            h(NumberField, {
              value: get('flypitDelayTiers.medium'), min: 0, max: 60000, disabled: !writable,
              ariaLabel: '中等句延时', onCommit: (n) => write('flypitDelayTiers.medium', n),
            })),
          h(Field, { label: '长句（15+ 字）', desc: '毫秒。' },
            h(NumberField, {
              value: get('flypitDelayTiers.long'), min: 0, max: 60000, disabled: !writable,
              ariaLabel: '长句延时', onCommit: (n) => write('flypitDelayTiers.long', n),
            })),
          h(Field, { label: '兜底固定间隔', desc: '毫秒。仅当分级延时关闭时生效。' },
            h(NumberField, {
              value: get('sendIntervalMs'), min: 0, max: 60000, disabled: !writable,
              ariaLabel: '兜底固定间隔', onCommit: (n) => write('sendIntervalMs', n),
            }))),
        h('div', { className: 'qqg-group' },
          h('div', { className: 'qqg-group-title' }, '群聊与标点'),
          h(Field, { label: '群聊回复 @ 发送者', desc: '私聊永不 @。一条回复分多个气泡时只 @ 一次。' },
            h(Switch, {
              checked: get('groupAtReply') !== false, disabled: !writable,
              ariaLabel: '群聊回复 @ 发送者', onChange: (v) => write('groupAtReply', v),
            })),
          h(Field, { label: '@ 位置', desc: 'last = 最后一片带 @；first = 第一片带 @。' },
            h('select', {
              className: 'qqg-input', value: get('groupAtPosition'), disabled: !writable,
              'aria-label': '@ 位置',
              onChange: (e) => write('groupAtPosition', e.target.value),
            }, h('option', { value: 'last' }, '最后一片'), h('option', { value: 'first' }, '第一片'))),
          h(Field, { label: '裁掉片尾标点', desc: '代码块与链接例外，永不裁。' },
            h(Switch, {
              checked: get('trimEndPunctuation.enabled') !== false, disabled: !writable,
              ariaLabel: '裁掉片尾标点', onChange: (v) => write('trimEndPunctuation.enabled', v),
            }))))
    }

    /** NapCat 管理区（批次 4B）：启停 + 三层状态。 */
    function NapcatSection({ get, write, writable }) {
      const [snap, setSnap] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [tick, setTick] = React.useState(0)

      // 每 3 秒拉一次状态（也用 tick 在启停后立刻刷新）
      React.useEffect(() => {
        let stopped = false
        let timer = null
        const load = async () => {
          try {
            const res = await fetch('/dsh-qq-guard/napcat?action=status', {
              headers: { accept: 'application/json' },
              credentials: 'include',
            })
            if (res.ok) { setSnap(await res.json()); setError(null) }
            else setError(`状态查询失败：HTTP ${res.status}`)
          } catch (e) { setError(e?.message ?? String(e)) }
          if (!stopped) timer = setTimeout(load, 3000)
        }
        void load()
        return () => { stopped = true; if (timer) clearTimeout(timer) }
      }, [tick])

      const act = async (action) => {
        setBusy(true); setError(null)
        try {
          const res = await fetch(`/dsh-qq-guard/napcat?action=${action}`, {
            method: 'POST', credentials: 'include',
            headers: { accept: 'application/json' },
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || !body.ok) setError(body.detail ?? body.reason ?? `HTTP ${res.status}`)
        } catch (e) { setError(e?.message ?? String(e)) }
        finally { setBusy(false); setTick((v) => v + 1) }
      }

      const stateText = {
        stopped: '已停止',
        external: '已在运行（非本插件启动）',
        starting: '启动中…',
        online: '在线',
        offline: '进程在跑，QQ 未登录',
        'running-unverified': '运行中（账号未确认）',
      }
      const state = snap?.state
      const dotCls = state === 'online' ? 'qqg-dot-ok'
        : (state === 'stopped' ? 'qqg-dot-idle' : state ? 'qqg-dot-warn' : 'qqg-dot-idle')
      // 状态用彩色小标签呈现，比裸文字更直观，也避免「已停止」旁边空一大块
      const tagCls = state === 'online' ? 'qqg-tag qqg-tag-ok'
        : (state === 'stopped' ? 'qqg-tag' : state ? 'qqg-tag qqg-tag-warn' : 'qqg-tag')

      const canStart = writable && !busy && (state === 'stopped' || state === undefined)
      const canStop = writable && !busy && snap?.managed === true

      return h('div', { className: 'qqg-group' },
        h('div', { className: 'qqg-group-title' }, 'NapCat 进程'),
        h(Field, { label: '当前状态', desc: '三层判定：进程存活 + WS 端口监听 + get_status 在线，三者同时成立才算在线。' },
          h('div', { className: 'qqg-inline' },
            h('span', { className: tagCls },
              h('span', { className: 'qqg-dot ' + dotCls }),
              h('span', null, snap ? (stateText[state] ?? state) : '查询中…')))),
        h(Field, { label: '线程 / 端口', desc: 'WS 端口是否处于 LISTENING。' },
          h('div', { className: 'qqg-inline' },
            h('span', { className: 'qqg-mono' },
              snap
                ? `端口 ${snap.wsPort} ${snap.portListening ? '监听中' : '未监听'} · 进程 ${snap.processAlive ? '存活' : '不在'}`
                : '—'))),
        h(Field, { label: '登录账号', desc: '需要配置 OneBot HTTP API 才能自动识别。' },
          h('div', { className: 'qqg-inline' },
            h('span', { className: 'qqg-mono' },
              snap
                ? (snap.selfId ? `${snap.selfId}${snap.nickname ? `（${snap.nickname}）` : ''}` : (snap.probeAvailable ? '未登录' : '未配置 HTTP API，无法确认'))
                : '—'))),
        h(Field, { label: '操作', desc: '启动前会先探测端口，已在跑就直接复用，不会双开。' },
          h('div', { className: 'qqg-inline' },
            h('button', {
              type: 'button', className: 'qqg-btn qqg-btn-primary',
              disabled: !canStart, onClick: () => act('start'),
            }, busy ? '处理中…' : '启动 NapCat'),
            h('button', {
              type: 'button', className: 'qqg-btn',
              disabled: !canStop, onClick: () => act('stop'),
            }, '停止'))),
        h(Field, { label: '安装目录', desc: '含 NapCatWinBootMain.exe 的目录；留空用内置默认值。' },
          h('input', {
            className: 'qqg-input qqg-input-grow',
            value: get('napcat.dir') ?? '',
            placeholder: 'D:\\...\\NapCat.52230.Shell',
            disabled: !writable,
            'aria-label': 'NapCat 安装目录',
            onChange: (e) => write('napcat.dir', e.target.value),
          })),
        h(Field, { label: '快速登录 QQ 号', desc: '填了就带账号启动（等同 napcat.quick.bat）；留空需手动登录。' },
          h('input', {
            className: 'qqg-input qqg-input-grow',
            value: get('napcat.quickLoginQQ') ?? '',
            placeholder: '例如 1000000001',
            disabled: !writable,
            'aria-label': '快速登录 QQ 号',
            onChange: (e) => write('napcat.quickLoginQQ', e.target.value),
          })),
        error ? h('div', { className: 'qqg-status qqg-status-err' }, error) : null,
        snap?.lastError ? h('div', { className: 'qqg-detail' }, `上次错误：${snap.lastError}`) : null,
        h('div', { className: 'qqg-hint' },
          '停止顺序：先 TERM，5 秒宽限后强制结束进程树。DSH 退出时会自动停掉由本插件启动的 NapCat，不留孤儿进程。'))
    }

    function SettingsPanel(props) {
      // 两种入口来源：
      //   · plugins.bundle.config —— 框架给 form；
      //   · settings.section / main —— 框架不给 form，用我们自己造的 remoteForm。
      const form = props?.form ?? props?.remoteForm
      const snap = useForm(form)
      const value = snap?.value ?? {}
      const writable = snap?.writable === true
      const [active, setActive] = React.useState('status')

      const get = (path) => {
        const v = getPath(value, path)
        return v === undefined ? DEFAULTS[path] : v
      }
      const write = (path, next) => {
        if (!form) return
        // 嵌套字段必须按段拆成数组交给 mutate，带点字符串会落到错误的 key 上。
        form.mutate([{ op: 'set', path: splitPath(path), value: next }])
      }

      if (!form) {
        return h('div', { className: 'qqg-card' },
          h('div', { className: 'qqg-status qqg-status-err' }, '设置表单不可用（组件未拿到数据源）。'),
          h('div', { className: 'qqg-detail' }, '请按 F12 查看 Console 里 [qq-guard] 开头的报错。'))
      }
      if (snap?.status === 'loading') {
        return h('div', { className: 'qqg-card' }, h('div', { className: 'qqg-status' }, '正在读取配置…'))
      }
      if (snap?.status === 'error') {
        return h('div', { className: 'qqg-card' },
          h('div', { className: 'qqg-status qqg-status-err' }, '读取配置失败。'),
          snap.error ? h('div', { className: 'qqg-detail' }, snap.error) : null,
          h('div', { className: 'qqg-detail' }, '按 F12 打开 Console 可看到 [qq-guard] 前缀的完整错误。'))
      }

      const common = { get, write, writable, form }
      let body
      if (active === 'status') body = h(StatusSection, common)
      else if (active === 'napcat') body = h(NapcatSection, common)
      else if (active === 'onebot') body = h(OneBotSection, common)
      else if (active === 'allow') body = h(AllowSection, common)
      else if (active === 'persona') body = h(PersonaSection, common)
      else body = h(SplitSection, common)

      return h('div', { className: 'qqg-layout' },
        h('style', null, CSS),
        h('nav', { className: 'qqg-nav', 'aria-label': 'QQ 桥接设置分类' },
          SECTIONS.map((s) => h('button', {
            key: s.id,
            type: 'button',
            className: 'qqg-nav-item' + (active === s.id ? ' qqg-nav-item-on' : ''),
            'aria-current': active === s.id ? 'page' : undefined,
            onClick: () => setActive(s.id),
          }, s.label))),
        h('div', { className: 'qqg-content' },
          body,
          h('div', { className: 'qqg-hint qqg-hint-bottom' },
            '改动由 config-editor 写入 profile 配置，重启 DSH 后保留。',
            h('br'),
            '桥接进程每 2 秒轮询配置，通常 2 秒内生效，无需重启桥接。'),

          writable ? null : h('div', { className: 'qqg-status qqg-status-err' },
            snap?.source === 'http'
              ? '只读模式：正在用 HTTP 兜底读取，改动无法保存（remote.settings 不可用）。'
              : '当前配置不可写（可能被更高优先级的配置层覆盖）。'),
        ))
    }

    return {
      // ⚠️ 必须同时声明 `remote.settings`：只写 'remote' 时
      // `ctx.remote.settings` 是 undefined（2026-10-20 实测，官方 ui-settings
      // 自己声明的也是 ["remote", "remote.settings"]）。
      inject: ['slots', 'remote', 'remote.settings'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = '@local/dsh-qq-guard'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'qq-guard: settings css')

        // ① 左侧设置导航的**独立入口**（像「养鱼」「侧边卡片」那样）。
        //
        //    `settings.section` 是「一个设置页对应一个左侧菜单项」的槽位：
        //    id 决定路由 key，label 是菜单文字。
        //    ⚠️ 关键差异：这个槽位的 ownerProps 只有 `{ close }`，**不会**传 form
        //       （对比 plugins.bundle.config 才给 form）。所以这里自己用
        //       remote.settings 造一个同接口适配器，不依赖 configForms 服务。
        //
        //    这条入口**不包在 ctx.inject(['configForms']) 里**：左侧导航是主入口，
        //    不能因为 Settings 页服务缺席就整个消失。
        const remoteForm = createRemoteForm(ctx, ENTRY_ID)
        ctx.effect(
          () => ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'qq-bridge',
            order: 6,
            label: () => 'QQ 桥接',
            inject: () => ({ remoteForm }),
          }, SettingsPanel)),
          'qq-guard: settings section',
        )

        // ② 主侧边栏的**独立图标入口**（像「插件」「上下文」「记忆」那样）。
        //
        //    需要成对注册两个槽位，缺一不可（照 dsh-context 的写法）：
        //      · `sidebar.panellist` —— 左侧图标按钮（用 id 寻址，label 是 tooltip）
        //      · `main`              —— 点开后中间的整块面板（用 key 寻址）
        //    两个的 id/key 必须相同，侧边栏靠它把按钮和面板配对。
        const MAIN_KEY = 'qq-bridge'
        ctx.effect(
          () => ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: MAIN_KEY,
            inject: () => ({ remoteForm }),
          }, BridgePanel)),
          'qq-guard: main panel',
        )
        ctx.effect(
          () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: MAIN_KEY,
            order: 26,
            label: () => 'QQ 桥接',
          }, QqBridgeIcon)),
          'qq-guard: sidebar entry',
        )

        // ③ 插件详情页里的配置卡片（与 mnemon / dsh-context 同位置）。
        //    二级入口，左侧导航看不到——留着方便从插件页直达。
        ctx.inject(['configForms'], (inner) => {
          const forms = inner.configForms
          if (forms === undefined || typeof forms.get !== 'function') return
          const form = forms.get(ENTRY_ID)
          if (!form) return
          inner.effect(
            () => inner.slots.inject('plugins.bundle.config', () => inner.slots.register({
              name: 'plugins.bundle.config',
              key: '@local/dsh-qq-guard',
              inject: () => ({ form }),
            }, SettingsPanel)),
            'qq-guard: plugins page card',
          )
        })
      },
    }
  },
})
