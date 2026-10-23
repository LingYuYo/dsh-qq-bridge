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
/* 模型配置卡：备用模型行 + 能力警告 */
.qqg-hint-warn { color: #b4690e; background: rgba(255, 176, 32, 0.12); }
.qqg-fb-list { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
.qqg-fb-row { display: flex; align-items: center; gap: 8px; }
.qqg-fb-row .qqg-btn { flex: 0 0 auto; }

/* ── 左导航 + 右内容（主面板）────────────────────────────── */
.qqg-layout { display: flex; align-items: stretch; width: 100%; min-width: 0; height: 100%; min-height: 0;
  gap: 20px; padding: 24px clamp(20px, 3vw, 40px) 32px; box-sizing: border-box;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.qqg-nav { flex: 0 0 168px; width: 168px; display: flex; flex-direction: column; gap: 2px;
  padding-right: 12px; border-right: 1px solid var(--dsw-alias-border-l1);
  min-height: 0; }
/* 菜单列表单独滚动，底部引导按钮固定在下方（不被列表滚动带走）。 */
.qqg-nav-list { flex: 1 1 auto; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 2px; }
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
/* ⚠️ .qqg-btn-danger 必须写在 .qqg-btn **之后**：两者特异性相同（都是单个类），
   靠源码顺序决胜负；放前面会被 .qqg-btn 的 color 覆盖，删除按钮就不红了。 */
/* 桥接日志折叠区 */
.qqg-logbox { margin-top: 4px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.qqg-logbox summary { cursor: pointer; user-select: none; padding: 2px 0; }
.qqg-log { margin: 6px 0 0; padding: 8px 10px; max-height: 220px; overflow: auto;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
/* 系统底层事件（看门狗 / 降级 / 抛错）：时间线 + 红黄分级 */
.qqg-events { margin-top: 8px; }
.qqg-event-list { margin: 6px 0 0; padding: 6px 10px; max-height: 220px; overflow: auto;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.qqg-ev { display: flex; align-items: baseline; gap: 8px; padding: 2px 0; line-height: 1.5; }
.qqg-ev-time { flex: 0 0 auto; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.qqg-ev-msg { min-width: 0; font-size: 11.5px; overflow-wrap: anywhere; }
.qqg-ev-error .qqg-ev-msg { color: #b42318; font-weight: 600; }
.qqg-ev-warn .qqg-ev-msg { color: #b4690e; }
.qqg-ev-info .qqg-ev-msg { color: var(--dsw-alias-label-secondary); }
/* 高级参数折叠卡 */
.qqg-advanced { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2); padding: 0 12px; }
.qqg-advanced > summary { cursor: pointer; user-select: none; padding: 10px 0; font-size: 12.5px;
  font-weight: 600; color: var(--dsw-alias-label-primary); }
.qqg-advanced .qqg-group { border: none; padding: 0; margin: 0 0 10px; background: transparent; }
/* 状态小标签（NapCat 页「已停止」用）*/.qqg-tag { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px;
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
/* 危险按钮：必须排在 .qqg-btn / .qqg-btn-primary 之后，否则同特异性下被覆盖。 */
.qqg-btn-danger { color: var(--dsw-alias-state-error-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
.qqg-btn-danger:hover:enabled { color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
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

    /* ═══════════════════════════════════════════════════════════
       Phase 2 · 五 Tab 控制台骨架（Mock 优先）
       本段只加「壳」：卡片、网格、图表、表格、导航。
       真实数据链路（remote.settings / HTTP 兜底 / 热更新 / 启停路由）
       一个字节都没动，全部沿用下面的既有实现。
       ═══════════════════════════════════════════════════════════ */
    const CSS2 = `
/* 主题色：DSH 主题里没有 --dsw-alias-accent，真正带色相的是 state-business-primary
   （浅色 = deepseek-500 #4176e6 / 深色 = deepseek-400 #7aaaff），
   所以按 state-business → button-info-fill → brand-primary 的顺序取。 */
.qqg-layout {
  --qqg-accent: var(--dsw-alias-state-business-primary, var(--dsw-alias-button-info-fill, var(--dsw-alias-brand-primary, #4176e6)));
  /* 卡片：不用 bg-layer-3（浅色下 #f9fafb 与页面底色几乎同色，卡片会「消失」）。
     改成「label-primary 往 bg-base 里叠一点」：浅色=极浅灰、深色=比底色亮一档，
     一套公式同时满足两套主题，不需要给深色单独写覆盖。 */
  --qqg-card-bg: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, var(--dsw-alias-bg-base));
  --qqg-card-bd: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
  /* 卡片内部的「凹陷块」用半透明叠色，深浅两套主题都自动成立。 */
  --qqg-inset-bg: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
}
.qqg-layout .qqg-nav { flex: 0 0 186px; width: 186px; gap: 3px; }
.qqg-nav-brand { display: flex; align-items: center; gap: 8px; padding: 2px 10px 11px;
  margin-bottom: 3px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.qqg-nav-brand-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto;
  background: var(--qqg-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--qqg-accent) 20%, transparent); }
.qqg-nav-brand-text { font-size: 12.5px; font-weight: 600; letter-spacing: .02em; white-space: nowrap; }
.qqg-nav-item { display: flex; align-items: center; gap: 9px; }
.qqg-nav-icon { flex: 0 0 auto; display: inline-flex; opacity: .82; }
.qqg-nav-item-on .qqg-nav-icon { color: var(--qqg-accent); opacity: 1; }
.qqg-nav-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.qqg-nav-badge { flex: 0 0 auto; min-width: 16px; height: 16px; padding: 0 5px; border-radius: 999px;
  background: var(--dsw-alias-state-error-primary); color: #fff; font-size: 10px; line-height: 16px;
  text-align: center; font-variant-numeric: tabular-nums; }
/* 底部「使用引导」：margin-top:auto 沉底，浅色分割线与菜单隔开。
   尺寸/圆角/悬浮效果刻意与 .qqg-nav-item 对齐，只是图标带一点主题色。 */
.qqg-nav-foot { flex: 0 0 auto; margin-top: auto; padding-top: 12px; padding-bottom: 4px;
  border-top: 1px solid var(--dsw-alias-border-l1); }
.qqg-nav-guide { box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 9px;
  text-align: left; font: inherit; font-size: 13px; color: var(--dsw-alias-label-secondary);
  background: transparent; border: 0; border-radius: 6px; padding: 7px 10px; cursor: pointer;
  transition: background .12s ease, color .12s ease; white-space: nowrap; }
.qqg-nav-guide:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.qqg-nav-guide-icon { flex: 0 0 auto; display: inline-flex; color: var(--qqg-accent); }
.qqg-nav-guide-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.qqg-nav-guide-done { flex: 0 0 auto; font-size: 10.5px; color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums; }
/* 左下角快捷启动卡（第一批 UI 壳）：状态灯 + 当前模型 + 一键启动。
   放在 .qqg-nav-foot 里、使用引导按钮上方；尺寸按 186px 导航宽收紧。 */
.qqg-launch { box-sizing: border-box; display: flex; flex-direction: column; gap: 8px;
  margin-bottom: 8px; padding: 10px; border-radius: 10px;
  background: var(--qqg-inset-bg); border: 1px solid var(--dsw-alias-border-l1); }
.qqg-launch-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.qqg-launch-state { font-size: 11.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.qqg-launch-model { display: flex; align-items: baseline; gap: 5px; min-width: 0; }
.qqg-launch-model-label { flex: 0 0 auto; font-size: 10px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.qqg-launch-model-name { min-width: 0; font-size: 10.5px; color: var(--dsw-alias-label-secondary);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qqg-launch-btn { box-sizing: border-box; width: 100%; display: inline-flex; align-items: center;
  justify-content: center; gap: 6px; font: inherit; font-size: 12px; line-height: 1.4;
  padding: 6px 8px; border-radius: 8px; cursor: pointer; white-space: nowrap;
  color: var(--dsw-alias-label-primary-foreground); background: var(--dsw-alias-button-primary-fill);
  border: 1px solid transparent; transition: filter .12s ease; }
.qqg-launch-btn:hover:enabled { filter: brightness(1.06); }
.qqg-launch-btn:disabled { opacity: .55; cursor: default; }
/* 启动失败的错误行：单行省略，完整内容在 title 里 */
.qqg-launch-err { font-size: 10.5px; line-height: 1.4; color: #b42318;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── 卡片 ─────────────────────────────────────────────────── */
/* 卡片底色/描边沿用 DSH 自己的设置卡 token：
   浅色主题下 bg-layer-2 与页面底色同为 #fff，只靠 border-l1(4% 黑) 几乎看不出卡片，
   所以描边取 settings-card-stroke（= border-l4），和官方设置卡视觉一致。 */
.qqg-stack { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.qqg-panel { box-sizing: border-box; display: flex; flex-direction: column; gap: 12px;
  padding: 16px 18px; border-radius: 14px;
  background: var(--qqg-card-bg);
  border: 1px solid var(--qqg-card-bd);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); }
.qqg-panel-accent { border-color: color-mix(in srgb, var(--qqg-accent) 34%, var(--dsw-alias-border-l1));
  background: linear-gradient(158deg, color-mix(in srgb, var(--qqg-accent) 13%, var(--dsw-alias-bg-layer-2)) 0%,
    var(--dsw-alias-bg-layer-2) 64%); }
.qqg-panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.qqg-panel-title { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; letter-spacing: .01em; }
.qqg-panel-title::before { content: ''; width: 3px; height: 13px; border-radius: 2px; flex: 0 0 auto;
  background: var(--qqg-accent); }
.qqg-panel-desc { margin-top: 3px; font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.qqg-anchor { scroll-margin-top: 12px; }
.qqg-pill { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; padding: 1px 8px;
  border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--qqg-inset-bg);
  color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.qqg-pill-accent { color: var(--qqg-accent); border-color: color-mix(in srgb, var(--qqg-accent) 40%, transparent);
  background: color-mix(in srgb, var(--qqg-accent) 10%, transparent); }

/* ── 统计卡 ───────────────────────────────────────────────── */
.qqg-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 12px; }
.qqg-stat { position: relative; overflow: hidden; display: flex; flex-direction: column; gap: 5px;
  padding: 13px 14px; border-radius: 12px; background: var(--qqg-inset-bg);
  border: 1px solid var(--qqg-card-bd); }
.qqg-stat::after { content: ''; position: absolute; right: -34px; bottom: -58px; width: 118px; height: 118px;
  border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle, color-mix(in srgb, var(--qqg-accent) 22%, transparent), transparent 70%); }
.qqg-stat-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.qqg-stat-value { font-size: 22px; font-weight: 600; line-height: 1.15; font-variant-numeric: tabular-nums; }
.qqg-stat-unit { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-secondary); margin-left: 3px; }
.qqg-stat-foot { font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.qqg-up { color: var(--dsw-alias-state-success-primary); }
.qqg-down { color: var(--dsw-alias-state-error-primary); }

/* ── AI 排障助手 ──────────────────────────────────────────── */
.qqg-ai { display: flex; flex-direction: column; gap: 9px; }
.qqg-ai-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.qqg-ai-chip { font: inherit; font-size: 11.5px; padding: 3px 9px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--qqg-inset-bg);
  color: var(--dsw-alias-label-secondary); cursor: pointer; transition: color .12s ease, border-color .12s ease; }
.qqg-ai-chip:hover { color: var(--dsw-alias-label-primary);
  border-color: color-mix(in srgb, var(--qqg-accent) 50%, var(--dsw-alias-border-l2)); }
.qqg-ai-row { display: flex; align-items: flex-end; gap: 8px; }
.qqg-ai-input { flex: 1 1 auto; width: 100%; min-width: 0; box-sizing: border-box; resize: vertical; font: inherit;
  font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-primary);
  background: var(--qqg-inset-bg); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px; padding: 9px 11px; }
.qqg-ai-row .qqg-ai-input { width: auto; }
.qqg-ai-input:focus { outline: none;
  border-color: color-mix(in srgb, var(--qqg-accent) 60%, var(--dsw-alias-border-l2)); }

/* ── 会话管理（左右分栏）───────────────────────────────────── */
.qqg-split { display: grid; grid-template-columns: minmax(232px, 302px) minmax(0, 1fr); gap: 14px; align-items: start; }
@media (max-width: 900px) { .qqg-split { grid-template-columns: minmax(0, 1fr); } }
.qqg-session-list { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 14px;
  max-height: 660px; overflow: auto; background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); }
.qqg-session { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 10px;
  cursor: pointer; border: 1px solid transparent; transition: background .12s ease, border-color .12s ease; }
.qqg-session:hover { background: var(--dsw-alias-interactive-bg-hover); }
.qqg-session-on { background: color-mix(in srgb, var(--qqg-accent) 14%, var(--dsw-alias-bg-layer-2));
  border-color: color-mix(in srgb, var(--qqg-accent) 40%, transparent); }
.qqg-avatar { flex: 0 0 auto; width: 32px; height: 32px; border-radius: 10px; display: flex;
  align-items: center; justify-content: center; font-size: 13px; font-weight: 600; color: #fff;
  background: linear-gradient(135deg, var(--qqg-accent), color-mix(in srgb, var(--qqg-accent) 40%, #7a5cff)); }
.qqg-avatar-lg { width: 44px; height: 44px; border-radius: 12px; font-size: 17px; }
.qqg-session-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.qqg-session-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.qqg-session-name { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qqg-session-time { margin-left: auto; flex: 0 0 auto; font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.qqg-session-preview { font-size: 11.5px; color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qqg-unread { flex: 0 0 auto; min-width: 16px; height: 16px; padding: 0 5px; border-radius: 999px;
  background: var(--dsw-alias-state-error-primary); color: #fff; font-size: 10px; line-height: 16px;
  text-align: center; font-variant-numeric: tabular-nums; }
.qqg-session-detail { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.qqg-detail-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.qqg-detail-meta { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.qqg-detail-name { font-size: 15px; font-weight: 600; }
.qqg-detail-sub { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.qqg-msg { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 10px;
  font-size: 12px; line-height: 1.55; background: var(--qqg-inset-bg); }
.qqg-msg-me { background: color-mix(in srgb, var(--qqg-accent) 14%, var(--qqg-inset-bg)); }
.qqg-msg-meta { font-size: 10.5px; color: var(--dsw-alias-label-secondary); }

/* ── 技能 / 插件卡片网格 ──────────────────────────────────── */
.qqg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 12px; }
.qqg-tile { display: flex; flex-direction: column; gap: 9px; padding: 14px; border-radius: 14px;
  background: var(--qqg-card-bg);
  border: 1px solid var(--qqg-card-bd);
  transition: border-color .15s ease, transform .15s ease; }
.qqg-tile:hover { transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--qqg-accent) 42%, var(--dsw-alias-border-l1)); }
.qqg-tile-top { display: flex; align-items: center; gap: 9px; min-width: 0; }
.qqg-tile-icon { flex: 0 0 auto; width: 32px; height: 32px; border-radius: 9px; display: flex;
  align-items: center; justify-content: center; color: var(--qqg-accent);
  background: color-mix(in srgb, var(--qqg-accent) 14%, var(--qqg-inset-bg));
  border: 1px solid color-mix(in srgb, var(--qqg-accent) 26%, transparent); }
.qqg-tile-name { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qqg-tile-sub { font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.qqg-tile-desc { flex: 1 1 auto; font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.qqg-tile-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }

/* ── 使用引导（导航底部按钮 + 弹窗内的三步清单）────────────── */
.qqg-onboard { display: flex; flex-direction: column; gap: 9px; }
.qqg-onboard-row { display: flex; align-items: center; gap: 10px; padding: 9px 11px; border-radius: 10px;
  background: var(--qqg-inset-bg); border: 1px solid var(--dsw-alias-border-l1); }
.qqg-onboard-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.qqg-onboard-name { font-size: 12.5px; font-weight: 600; }
.qqg-onboard-desc { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.qqg-progress { display: flex; align-items: center; gap: 8px; font-size: 11px;
  color: var(--dsw-alias-label-secondary); }
.qqg-progress-track { flex: 1 1 auto; height: 5px; border-radius: 999px; overflow: hidden;
  background: var(--qqg-inset-bg); }
.qqg-progress-fill { height: 100%; border-radius: 999px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--qqg-accent) 70%, transparent), var(--qqg-accent)); }

/* ── 图表（纯 CSS）────────────────────────────────────────── */
.qqg-chart { display: flex; align-items: flex-end; gap: 10px; height: 188px; padding: 12px 2px 0; }
.qqg-chart-col { flex: 1 1 0; min-width: 0; height: 100%; display: flex; flex-direction: column;
  align-items: center; justify-content: flex-end; gap: 6px; }
.qqg-chart-bar { width: 100%; max-width: 42px; min-height: 6px; border-radius: 8px 8px 3px 3px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--qqg-accent) 88%, #fff 12%) 0%,
    color-mix(in srgb, var(--qqg-accent) 32%, transparent) 100%);
  transition: filter .15s ease; }
.qqg-chart-col:hover .qqg-chart-bar { filter: brightness(1.16); }
.qqg-chart-val { font-size: 10.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.qqg-chart-day { font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.qqg-area-wrap { display: flex; flex-direction: column; gap: 8px; }
.qqg-area { position: relative; height: 168px; margin: 4px 2px 0; }
.qqg-area-stroke, .qqg-area-fill { position: absolute; inset: 0; }
.qqg-area-stroke { background: var(--qqg-accent); }
.qqg-area-fill { background: linear-gradient(180deg,
  color-mix(in srgb, var(--qqg-accent) 42%, transparent) 0%,
  color-mix(in srgb, var(--qqg-accent) 3%, transparent) 100%); }
.qqg-area-dot { position: absolute; width: 6px; height: 6px; margin: -3px 0 0 -3px; border-radius: 50%;
  background: var(--qqg-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--qqg-accent) 22%, transparent); }
.qqg-area-labels { display: flex; justify-content: space-between; padding: 0 2px; font-size: 10.5px;
  color: var(--dsw-alias-label-secondary); }
.qqg-legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.qqg-legend-item { display: inline-flex; align-items: center; gap: 6px; }
.qqg-legend-swatch { width: 9px; height: 9px; border-radius: 3px; background: var(--qqg-accent); }

/* ── 统计表格 ─────────────────────────────────────────────── */
.qqg-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; align-items: start; }
.qqg-table-wrap { overflow: auto; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); }
.qqg-table { width: 100%; border-collapse: collapse; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.qqg-table th { position: sticky; top: 0; z-index: 1; padding: 8px 12px; text-align: left;
  font-weight: 600; white-space: nowrap; color: var(--dsw-alias-label-secondary);
  background: var(--qqg-inset-bg); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.qqg-table td { padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-primary); }
.qqg-table tr:last-child td { border-bottom: 0; }
.qqg-table tbody tr:hover td { background: var(--dsw-alias-interactive-bg-hover); }
.qqg-table .qqg-num { text-align: right; }
.qqg-table .qqg-muted { color: var(--dsw-alias-label-secondary); }
.qqg-share { display: flex; align-items: center; gap: 8px; min-width: 96px; }
.qqg-share-track { flex: 1 1 auto; height: 5px; border-radius: 999px; overflow: hidden;
  background: var(--qqg-inset-bg); }
.qqg-share-fill { height: 100%; border-radius: 999px; background: var(--qqg-accent); opacity: .8; }

/* ── 页面头部 ─────────────────────────────────────────────── */
.qqg-pagehead-tags { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; padding-top: 4px; }
.qqg-tabhead { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
  flex-wrap: wrap; padding-bottom: 2px; }
.qqg-tabhead-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.3; }
.qqg-tabhead-desc { margin: 4px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }

/* ── 全局设置：把既有 .qqg-group 统一成灰色卡片 ─────────────── */
.qqg-anchor { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.qqg-anchor .qqg-group, .qqg-stack > .qqg-group { gap: 10px; padding: 16px 18px; border-radius: 14px;
  background: var(--qqg-card-bg);
  border: 1px solid var(--qqg-card-bd);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); }
.qqg-anchor .qqg-group-title, .qqg-stack > .qqg-group .qqg-group-title { display: flex; align-items: center;
  gap: 8px; font-size: 13.5px; font-weight: 600; color: var(--dsw-alias-label-primary); letter-spacing: .01em; }
.qqg-anchor .qqg-group-title::before, .qqg-stack > .qqg-group .qqg-group-title::before { content: '';
  width: 3px; height: 13px; border-radius: 2px; flex: 0 0 auto; background: var(--qqg-accent); }
.qqg-anchor .qqg-row, .qqg-stack > .qqg-group .qqg-row { padding: 9px 0; }
.qqg-anchor .qqg-hint, .qqg-stack > .qqg-group .qqg-hint { background: var(--qqg-inset-bg); }
.qqg-hint-bottom { margin-top: 4px; }

/* ── 通用模态框（遮罩 + Esc / 点遮罩关闭）──────────────────── */
/* 遮罩用 bg-mask-3（浅色 #0000007a / 深色更沉）：mask-1 在浅色下只有 24%，
   弹窗压不住背后的卡片，看起来像「浮在半空」。 */
.qqg-mask { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center;
  justify-content: center; padding: 24px;
  background: var(--dsw-alias-bg-mask-3, rgba(0, 0, 0, .48)); }
.qqg-modal { box-sizing: border-box; display: flex; flex-direction: column;
  width: min(720px, 100%); max-height: min(86vh, 920px); border-radius: 16px; overflow: hidden;
  background: var(--dsw-alias-bg-base); border: 1px solid var(--qqg-card-bd);
  box-shadow: 0 24px 64px rgba(0, 0, 0, .34); }
.qqg-modal-sm { width: min(420px, 100%); }
.qqg-modal-head { flex: 0 0 auto; display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px; padding: 16px 18px 13px; border-bottom: 1px solid var(--qqg-card-bd); }
.qqg-modal-title { font-size: 14.5px; font-weight: 600; line-height: 1.35; }
.qqg-modal-desc { margin-top: 4px; font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.qqg-modal-x { flex: 0 0 auto; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 7px;
  background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 17px;
  line-height: 1; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.qqg-modal-x:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.qqg-modal-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 16px 18px; }
.qqg-modal-foot { flex: 0 0 auto; display: flex; align-items: center; justify-content: flex-end;
  gap: 8px; padding: 12px 18px 15px; border-top: 1px solid var(--qqg-card-bd); }
/* 弹窗里的分组不做卡片，改成「扁平分段 + 分隔线」，避免卡片套卡片。 */
.qqg-modal-body .qqg-group { gap: 9px; padding: 0; background: transparent; border: 0; box-shadow: none; }
.qqg-modal-body .qqg-group + .qqg-group { margin-top: 15px; padding-top: 15px;
  border-top: 1px solid var(--qqg-card-bd); }
.qqg-modal-body .qqg-group-title { display: flex; align-items: center; gap: 8px; font-size: 12.5px;
  font-weight: 600; color: var(--dsw-alias-label-primary); }
.qqg-modal-body .qqg-group-title::before { content: ''; width: 3px; height: 12px; border-radius: 2px;
  flex: 0 0 auto; background: var(--qqg-accent); }
.qqg-modal-body .qqg-row { padding: 8px 0; }
.qqg-modal-body .qqg-hint { background: var(--qqg-inset-bg); }
.qqg-modal-body .qqg-textarea-actions { margin-top: 2px; }

/* ── 人设弹窗：紧凑左对齐表单 ─────────────────────────────── */
/* 每个字段竖排三段：标签 → 说明 → 控件，标签和说明共用同一条左基线。
   单行字段固定 200px 宽，第一排并排；多行字段占满整行。
   .qqg-prow 默认 align-items:stretch，配合 .qqg-pf-desc 的 flex:1，
   让同一排里说明长两行的字段也能把控件压到底部对齐。 */
.qqg-pform { display: flex; flex-direction: column; gap: 14px; }
.qqg-prow { display: flex; flex-wrap: wrap; align-items: stretch; gap: 12px; }
.qqg-pf { display: flex; flex-direction: column; min-width: 0; }
.qqg-pf-sm { flex: 0 0 200px; width: 200px; }
.qqg-pf-wide { flex: 1 1 100%; width: 100%; }
.qqg-pf-label { font-size: 12.5px; line-height: 1.4; color: var(--dsw-alias-label-primary); }
.qqg-pf-desc { flex: 1 1 auto; margin: 2px 0 5px; font-size: 11px; line-height: 1.45;
  color: var(--dsw-alias-label-secondary); }
.qqg-pf-ctl { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.qqg-pf-sm .qqg-input { box-sizing: border-box; width: 100%; }
.qqg-pf-wide .qqg-textarea { min-height: 120px; }
.qqg-pf-foot { font-size: 10.5px; line-height: 1.4;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; }
@media (max-width: 560px) { .qqg-pf-sm { flex: 1 1 100%; width: 100%; } }

/* ── 大按钮（运行节奏卡片里那两颗）────────────────────────── */
.qqg-actions-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(224px, 1fr)); gap: 12px; }
.qqg-bigbtn { box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 12px;
  padding: 14px 16px; border-radius: 12px; text-align: left; cursor: pointer; font: inherit;
  color: var(--dsw-alias-label-primary); background: var(--qqg-inset-bg);
  border: 1px solid var(--qqg-card-bd); transition: border-color .14s ease, background .14s ease; }
.qqg-bigbtn:hover { border-color: color-mix(in srgb, var(--qqg-accent) 50%, var(--qqg-card-bd));
  background: color-mix(in srgb, var(--qqg-accent) 8%, transparent); }
.qqg-bigbtn-icon { flex: 0 0 auto; width: 34px; height: 34px; border-radius: 10px; display: flex;
  align-items: center; justify-content: center; color: var(--qqg-accent);
  background: color-mix(in srgb, var(--qqg-accent) 14%, transparent); }
.qqg-bigbtn-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.qqg-bigbtn-name { font-size: 13px; font-weight: 600; }
.qqg-bigbtn-desc { font-size: 11px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
.qqg-bigbtn-arrow { flex: 0 0 auto; color: var(--dsw-alias-label-secondary); }

/* ── 卡片工具区（齿轮 / 垃圾桶 / 拖拽手柄 / 上下移）────────── */
.qqg-tile-top { align-items: center; }
.qqg-tile-title { flex: 1 1 auto; min-width: 0; }
.qqg-tile-tools { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 1px; }
.qqg-icon-btn { box-sizing: border-box; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; }
.qqg-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.qqg-icon-btn-danger:hover { color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.qqg-icon-btn:disabled { opacity: .35; cursor: default; }
.qqg-icon-btn:disabled:hover { background: transparent; color: var(--dsw-alias-label-secondary); }
.qqg-drag { flex: 0 0 auto; display: inline-flex; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  cursor: grab; }
.qqg-drag:active { cursor: grabbing; }
.qqg-tile[draggable="true"] { cursor: grab; }
.qqg-tile-dragging { opacity: .4; }
.qqg-tile-over { border-color: var(--qqg-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--qqg-accent) 26%, transparent); }
.qqg-tile-foot .qqg-tile-arrows { display: inline-flex; gap: 1px; }

/* ── 表单控件补充（弹窗内）────────────────────────────────── */
.qqg-field { display: flex; flex-direction: column; gap: 6px; }
.qqg-field + .qqg-field { margin-top: 12px; }
.qqg-field-label { font-size: 12px; color: var(--dsw-alias-label-primary); }
.qqg-field-hint { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
/* 独占一行的字段块（NapCat 安装目录）：标签在上，输入框 + 按钮在下。
   输入框必须 flex:1 + min-width:0，否则长绝对路径会把卡片撑破。 */
.qqg-field-block { display: flex; flex-direction: column; gap: 6px; padding: 9px 0;
  border-top: 1px solid var(--dsw-alias-border-l1); }
.qqg-field-block:first-of-type { border-top: 0; }
.qqg-dir-row { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; }
.qqg-dir-row .qqg-dir-input { flex: 1 1 auto; width: auto; min-width: 0; max-width: 100%; }
.qqg-btn-browse { flex: 0 0 auto; }
.qqg-slider { width: 100%; accent-color: var(--qqg-accent); cursor: pointer; }
.qqg-slider-ticks { display: flex; justify-content: space-between; gap: 4px; margin-top: 2px;
  font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.qqg-slider-ticks span { flex: 1 1 0; text-align: center; }
.qqg-slider-ticks span.on { color: var(--qqg-accent); font-weight: 600; }

/* ── 设置弹窗：左表单 / 右说明 ────────────────────────────── */
.qqg-setgrid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
@media (max-width: 760px) { .qqg-setgrid { grid-template-columns: minmax(0, 1fr); } }
.qqg-setdesc { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: 12px;
  background: var(--qqg-inset-bg); border: 1px solid var(--qqg-card-bd); }
.qqg-setdesc-title { font-size: 12.5px; font-weight: 600; }
.qqg-setdesc-text { font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.qqg-setdesc-list { margin: 0; padding-left: 16px; font-size: 11.5px; line-height: 1.7;
  color: var(--dsw-alias-label-secondary); }
.qqg-kv { display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.qqg-kv b { font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }

/* ── 人设概览卡 + 人设设置弹窗 ─────────────────────────────── */
.qqg-persona-card { display: flex; flex-direction: column; gap: 8px; padding: 13px 14px;
  border-radius: 12px; background: var(--qqg-inset-bg); border: 1px solid var(--qqg-card-bd); }
.qqg-persona-role { display: flex; flex-direction: column; gap: 4px;
  padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.qqg-persona-preview { font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary);
  white-space: pre-line; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; }
.qqg-persona-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding-bottom: 12px; margin-bottom: 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.qqg-persona-select { flex: 1 1 220px; min-width: 0; }
/* toolbar 放进 .qqg-pform 后由父级 gap 控制间距，这里只留分割线内边距。 */
.qqg-pform .qqg-persona-toolbar { margin-bottom: 0; }

/* ── 添加弹窗：文件选择占位 ───────────────────────────────── */
.qqg-dropzone { display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; padding: 22px 16px; border-radius: 12px; text-align: center; cursor: pointer;
  border: 1px dashed var(--qqg-card-bd); background: var(--qqg-inset-bg);
  font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.qqg-dropzone:hover { border-color: color-mix(in srgb, var(--qqg-accent) 55%, var(--qqg-card-bd));
  color: var(--dsw-alias-label-primary); }

/* ── 用量页：峰谷时段 + 单价配置 ──────────────────────────── */
.qqg-peak-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.qqg-peak-field { flex: 1 1 260px; min-width: 0; }
.qqg-peak-toggle { margin-top: 8px; padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l1); }
.qqg-price-list { display: flex; flex-direction: column; }
.qqg-price-row { display: flex; flex-direction: column; gap: 8px; padding: 12px 0;
  border-top: 1px solid var(--dsw-alias-border-l1); }
.qqg-price-row:first-child { border-top: 0; padding-top: 0; }
.qqg-price-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.qqg-price-model { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; min-width: 0; }
.qqg-price-provider { font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.qqg-price-periods { display: flex; flex-direction: column; gap: 6px; }
.qqg-price-period { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
.qqg-price-period-label { flex: 0 0 90px; padding-bottom: 7px; font-size: 10.5px; font-weight: 600;
  color: var(--dsw-alias-label-secondary); }
.qqg-price-field { flex: 1 1 88px; min-width: 74px; display: flex; flex-direction: column; gap: 4px; }
.qqg-price-label { font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.qqg-price-field .qqg-input { width: 100%; font-variant-numeric: tabular-nums; }
.qqg-price-foot { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap;
  font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
`

    /* ══════════ 本地演示数据（只剩「会话管理」页在用）══════════ */
    // 用量数据（今日概览 / 数据与用量）已全部接 Host 的 /dsh-qq-guard/usage，
    // 这里不再保留任何用量假数字。
    const MOCK_SESSIONS = [
      {
        id: 's1', name: '翎羽', qq: '10001', kind: '私聊', initial: '翎', unread: 3,
        time: '14:32', preview: '分片规则改好了吗？', online: true, tag: '白名单',
        persona: '你是一只傲娇猫娘，说话带「哼」，但正经问题会认真答。',
        allow: true,
        messages: [
          { from: 'them', text: '在吗，桥接是不是又断了', time: '14:20' },
          { from: 'me', text: '没断，NapCat 在线，刚重连过 WS。', time: '14:21' },
          { from: 'them', text: '行，那分片规则改好了吗？', time: '14:32' },
        ],
      },
      {
        id: 's2', name: '摸鱼群', qq: '20002', kind: '群聊', initial: '摸', unread: 12,
        time: '14:18', preview: '[图片] 今天这破网又炸了', online: true, tag: '白名单',
        persona: '', allow: true,
        messages: [
          { from: 'them', text: '今天这破网又炸了', time: '14:16' },
          { from: 'them', text: '[图片]', time: '14:18' },
        ],
      },
      {
        id: 's3', name: '硬件折腾群', qq: '20003', kind: '群聊', initial: '硬', unread: 0,
        time: '13:52', preview: '固态换完温度掉了 8 度', online: true, tag: '白名单',
        persona: '', allow: true,
        messages: [{ from: 'them', text: '固态换完温度掉了 8 度', time: '13:52' }],
      },
      {
        id: 's4', name: '路人甲', qq: '30004', kind: '私聊', initial: '路', unread: 0,
        time: '12:07', preview: '你好，请问你是机器人吗', online: false, tag: '未放行',
        persona: '', allow: false,
        messages: [{ from: 'them', text: '你好，请问你是机器人吗', time: '12:07' }],
      },
      {
        id: 's5', name: '电子系毕设群', qq: '20005', kind: '群聊', initial: '电', unread: 0,
        time: '昨天', preview: '答辩时间定了，下周三上午', online: false, tag: '白名单',
        persona: '', allow: true,
        messages: [{ from: 'them', text: '答辩时间定了，下周三上午', time: '昨天' }],
      },
      {
        id: 's6', name: '广告号', qq: '40006', kind: '私聊', initial: '广', unread: 0,
        time: '昨天', preview: '【已拦截】推广内容', online: false, tag: '已拦截',
        persona: '', allow: false,
        messages: [{ from: 'them', text: '【已拦截】推广内容', time: '昨天' }],
      },
    ]

    /** 未接线的按钮统一绑它（本阶段只搭壳）。 */
    const noop = () => {}

    /** 内联 SVG 图标表（stroke 风格，跟随 currentColor）。 */
    const GLYPHS = {
      status: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 7.5V12l3.2 2'],
      sessions: ['M4 5.5h16v9.5H9.5L5 18.5V15H4z'],
      skills: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
      settings: ['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M12 2.5v2.2', 'M12 19.3v2.2',
        'M2.5 12h2.2', 'M19.3 12h2.2', 'M5 5l1.6 1.6', 'M17.4 17.4L19 19', 'M19 5l-1.6 1.6', 'M6.6 17.4L5 19'],
      usage: ['M4 19V11', 'M9.3 19V6', 'M14.6 19v-5', 'M19.9 19V9'],
      memory: ['M12 3.2a6 6 0 0 1 6 6v3.4a6 6 0 0 1-12 0V9.2a6 6 0 0 1 6-6z',
        'M9 9.5h.01', 'M15 9.5h.01', 'M9.6 14.2a3 3 0 0 0 4.8 0'],
      search: ['M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M16 16l4 4'],
      file: ['M6 3.5h7l5 5V20.5H6z', 'M13 3.5v5h5'],
      clock: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 7.5V12l3.2 2'],
      code: ['M9 8l-4 4 4 4', 'M15 8l4 4-4 4'],
      image: ['M4 5h16v14H4z', 'M4 15.5l4.5-4.5 3.5 3.5 3-3L20 16', 'M8.5 9.2h.01'],
      shield: ['M12 3l7 3v5.2c0 4.4-2.9 7.4-7 9-4.1-1.6-7-4.6-7-9V6z'],
      bridge: ['M3.5 6.5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H8l-3 2.4V12.5H5.5a2 2 0 0 1-2-2z',
        'M15 11.5h3.5a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H16l-2.4 2v-2.4H15a2 2 0 0 1-2-2v-2'],
      spark: ['M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z'],
      // ── Phase 3 新增 ──
      gear: ['M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z',
        'M19.1 14.3a1.6 1.6 0 0 0 .32 1.77l.06.06a1.9 1.9 0 1 1-2.7 2.7l-.05-.06a1.6 1.6 0 0 0-1.78-.32 1.6 1.6 0 0 0-.97 1.47V20a1.9 1.9 0 1 1-3.8 0v-.1a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a1.9 1.9 0 1 1-2.7-2.7l.06-.05a1.6 1.6 0 0 0 .32-1.78 1.6 1.6 0 0 0-1.47-.97H4a1.9 1.9 0 1 1 0-3.8h.1a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a1.9 1.9 0 1 1 2.7-2.7l.05.06a1.6 1.6 0 0 0 1.78.32H9.8a1.6 1.6 0 0 0 .97-1.47V4a1.9 1.9 0 1 1 3.8 0v.1a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.78-.32l.05-.06a1.9 1.9 0 1 1 2.7 2.7l-.06.05a1.6 1.6 0 0 0-.32 1.78v.05a1.6 1.6 0 0 0 1.47.97H20a1.9 1.9 0 1 1 0 3.8h-.1a1.6 1.6 0 0 0-1.47.97z'],
      trash: ['M4 6.5h16', 'M9.5 6.5V4.6h5v1.9', 'M6.2 6.5l.9 13a1.6 1.6 0 0 0 1.6 1.5h6.6a1.6 1.6 0 0 0 1.6-1.5l.9-13',
        'M10.2 10.4v6.4', 'M13.8 10.4v6.4'],
      plus: ['M12 5v14', 'M5 12h14'],
      arrowUp: ['M12 19V5', 'M6 11l6-6 6 6'],
      arrowDown: ['M12 5v14', 'M18 13l-6 6-6-6'],
      chevron: ['M9 5.5l6.5 6.5L9 18.5'],
      send: ['M20.5 3.5L11 13', 'M20.5 3.5l-6.2 17-3.3-7.5-7.5-3.3z'],
      activity: ['M3.5 12h3.2l2.6-6.5 4.4 13 2.6-6.5h4.2'],
      bulb: ['M9.2 18h5.6', 'M10 21h4',
        'M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2v.1h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z'],
      check: ['M5 12.5l4.5 4.5L19 7.5'],
      // 快捷启动按钮用的小三角（play）/ 停止用的方块（stop）。
      play: ['M8.5 5.5v13l9.5-6.5z'],
      stop: ['M7 7h10v10H7z'],
      // 六边形点阵拖拽手柄：两列共 6 个实心小圆点。
      dots: ['M9.5 6.5h.01', 'M14.5 6.5h.01', 'M9.5 12h.01', 'M14.5 12h.01', 'M9.5 17.5h.01', 'M14.5 17.5h.01'],
    }

    function Glyph({ name, size = 16 }) {
      const paths = GLYPHS[name] ?? GLYPHS.spark
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      }, paths.map((d, i) => h('path', { key: i, d })))
    }

    /** 卡片描述：去换行 + 最多 30 字 + 省略号（按 Unicode 码点算，中文/emoji 都不会截半个）。 */
    function clipCardText(text, max = 30) {
      const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
      const chars = [...flat]
      return {
        text: chars.length > max ? chars.slice(0, max).join('') + '…' : flat,
        full: flat,
        clipped: chars.length > max,
      }
    }

    /** 六边形点阵拖拽手柄（两列实心点，fill 而非 stroke）。 */
    function DotsHandle({ size = 15 }) {
      const pts = [[9.6, 6.2], [14.4, 6.2], [9.6, 12], [14.4, 12], [9.6, 17.8], [14.4, 17.8]]
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'currentColor', stroke: 'none',
        'aria-hidden': true, style: { display: 'block' },
      }, pts.map(([cx, cy], i) => h('circle', { key: i, cx, cy, r: 1.5 })))
    }

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
      // 与 Host 侧 Config 的 bridge.autoStart 默认值保持一致（默认关，fail-closed）。
      'bridge.autoStart': false,
      // 用量成本价目表默认空 = 未配置，成本显示「—」。
      usagePricing: [],
      // 峰谷判定的默认时段/时区（与 Host 侧 Config 默认值保持一致）。
      peakHours: '08:30-00:30',
      peakOnlyWorkdays: false,
      timezone: 'Asia/Shanghai',
      // 人设参与度默认「普通群友」（与 Host 侧重拼系统提示词时的默认值一致）。
      personaParticipation: 'normal',
      // 高级参数默认值与 Host 侧 Config 保持一致。
      replyTimeoutMs: 20000,
      modelWatchdogMs: 8000,
      antiDebounceMs: 0,
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

    /** 主面板：直接渲染五 Tab 控制台（页头由各 Tab 自己的 TabHead 负责）。 */
    function BridgePanel(props) {
      return h(SettingsPanel, props)
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

    /** 内置面板的左侧导航分类（Phase 2：五个主 Tab）。 */
    const SECTIONS = [
      { id: 'status', label: '运行状态', icon: 'status' },
      { id: 'sessions', label: '会话管理', icon: 'sessions', badge: MOCK_SESSIONS.filter((s) => s.unread > 0).length },
      { id: 'skills', label: '技能与插件', icon: 'skills' },
      { id: 'settings', label: '全局设置', icon: 'settings' },
      { id: 'usage', label: '数据与用量', icon: 'usage' },
    ]

    /** 使用引导弹窗里「去配置」按钮的目标锚点。 */
    const ANCHORS = {
      'set-napcat': 'qqg-anchor-napcat',
      'set-allow': 'qqg-anchor-allow',
      'set-onebot': 'qqg-anchor-onebot',
      'set-split': 'qqg-anchor-split',
      'set-persona': 'qqg-anchor-persona',
    }

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

    /** ISO 时间 → 本地 HH:MM:SS（事件时间线用）。 */
    function clockOf(iso) {
      if (typeof iso !== 'string') return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /**
     * 系统底层事件（看门狗触发 / 切备用模型 / 抛错）：3 秒轮询 Host 的只读路由。
     *
     * 这些动作全在 Host 进程里发生，界面上原本完全无感；面板把它们摊开成时间线，
     * 用户看到「回复慢」时能立刻判断是不是降级链在工作。
     */
    function useSystemEvents(enabled = true) {
      const [events, setEvents] = React.useState([])
      React.useEffect(() => {
        if (!enabled) return undefined
        let stopped = false
        let timer = null
        const load = async () => {
          try {
            const res = await fetch('/dsh-qq-guard/system-events', {
              headers: { accept: 'application/json' }, credentials: 'include',
            })
            if (res.ok) {
              const body = await res.json().catch(() => ({}))
              if (!stopped && Array.isArray(body?.events)) setEvents(body.events)
            }
          } catch { /* 事件读不到不影响主面板 */ }
          if (!stopped) timer = setTimeout(load, 3000)
        }
        void load()
        return () => { stopped = true; if (timer) clearTimeout(timer) }
      }, [enabled])
      return events
    }

    /**
     * 真实用量 hook（Host 的 GET /dsh-qq-guard/usage）。
     *
     * 5 秒轮询：聊天发生在 Host 进程里，浏览器没有对应的推送通道；
     * 轮询是最省事且天然自愈的方式，和桥接状态灯同一个套路。
     * 轮询失败不清空上一份数据（网络抖一下不该让面板闪成空白）。
     */
    function useUsage(days = 7) {
      const [snap, setSnap] = React.useState({ status: 'loading', data: null, error: null })
      React.useEffect(() => {
        let stopped = false
        let timer = null
        const load = async () => {
          try {
            const res = await fetch(`/dsh-qq-guard/usage?days=${days}`, {
              headers: { accept: 'application/json' },
              credentials: 'include',
            })
            const body = await res.json().catch(() => ({}))
            if (stopped) return
            if (!res.ok || body?.ok !== true) {
              setSnap((prev) => (prev.data
                ? { ...prev, status: 'ready' }
                : { status: 'error', data: null, error: body?.detail ?? body?.reason ?? `HTTP ${res.status}` }))
            } else {
              setSnap({ status: 'ready', data: body, error: null })
            }
          } catch (error) {
            if (!stopped) {
              setSnap((prev) => (prev.data
                ? { ...prev, status: 'ready' }
                : { status: 'error', data: null, error: String(error?.message ?? error) }))
            }
          }
          if (!stopped) timer = setTimeout(load, 5000)
        }
        void load()
        return () => { stopped = true; if (timer) clearTimeout(timer) }
      }, [days])
      return snap
    }

    function StatusSection({ get, writable }) {
      const live = useBridgeStatus(true)
      const [proc, refreshProc] = useBridgeProc(true)
      const sysEvents = useSystemEvents(true)
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
          h('div', { className: 'qqg-group-title' }, '实时状态'),
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

        // 系统底层事件：看门狗 / 降级 / 抛错。默认收起，标题里带最新一条，扫一眼就知道有没有事。
        h('details', { className: 'qqg-logbox qqg-events' },
          h('summary', null,
            `系统底层事件（最近 ${sysEvents.length} 条` +
            (sysEvents.length > 0 ? `：${sysEvents.at(-1)?.message ?? ''}` : '，暂无') + '）'),
          sysEvents.length === 0
            ? h('div', { className: 'qqg-hint' }, '还没有底层事件。看门狗触发、切备用模型、请求抛错都会记在这里。')
            : h('div', { className: 'qqg-event-list' },
              [...sysEvents].reverse().map((event, index) => h('div', {
                key: `${event.ts ?? index}-${index}`,
                className: 'qqg-ev qqg-ev-' + (event.level ?? 'info'),
              },
              h('span', { className: 'qqg-ev-time' }, clockOf(event.at)),
              h('span', { className: 'qqg-ev-msg' },
                `${event.level === 'error' ? '⛔' : event.level === 'warn' ? '⚠️' : '·'} ${event.message ?? ''}`))))),

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
        h(SwitchField, {
          label: 'DSH 启动时自动拉起桥接进程',
          hint: '修改插件配置会导致热重载，开启此项可防止桥接掉线。',
          value: get('bridge.autoStart') === true,
          disabled: !writable,
          onChange: (v) => write('bridge.autoStart', v),
        }),
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

    /** 参与度三档：id 与桥接 composePersonaPrompt 的 key 一一对应。 */
    const PERSONA_PARTICIPATION = [
      { id: 'quiet', label: '安静型' },
      { id: 'normal', label: '普通群友' },
      { id: 'active', label: '活跃型' },
    ]
    const personaParticipationLabel = (id) =>
      (PERSONA_PARTICIPATION.find((item) => item.id === id) ?? PERSONA_PARTICIPATION[1]).label

    /**
     * 人设设置弹窗（P1.5 重构）。
     *
     * 所有字段先在本地 draft 里改，点「保存」才一次性 mutate 写回配置；
     * 顶部下拉 = 默认人设 + 自定义人设列表，支持新增 / 删除当前自定义人设。
     * 桥接层会根据这些字段重拼最终系统提示词（名字替换 + 附加规则追加）。
     */
    function PersonaModal({ get, writable, form, onClose }) {
      const readPresets = () => {
        const raw = get('personaPresets')
        return Array.isArray(raw)
          ? raw
            .filter((item) => item && typeof item === 'object')
            .map((item) => ({ id: String(item.id ?? ''), name: String(item.name ?? ''), text: String(item.text ?? '') }))
          : []
      }
      const [draft, setDraft] = React.useState(() => ({
        selected: String(get('personaPresetId') ?? ''),
        botName: String(get('personaBotName') ?? ''),
        groupName: String(get('personaGroupName') ?? ''),
        participation: String(get('personaParticipation') ?? 'normal'),
        text: String(get('personaText') ?? ''),
        extraRules: String(get('personaExtraRules') ?? ''),
        systemPrompt: String(get('personaSystemPrompt') ?? ''),
        presets: readPresets(),
      }))
      const set = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }))
      const selectedPreset = draft.presets.find((item) => item.id === draft.selected) ?? null

      const selectPreset = (id) => {
        if (id === '') {
          setDraft((prev) => ({ ...prev, selected: '', text: '' }))
          return
        }
        const preset = draft.presets.find((item) => item.id === id)
        if (!preset) return
        setDraft((prev) => ({ ...prev, selected: id, text: preset.text }))
      }
      const addPreset = () => {
        const id = `persona-${Date.now()}`
        const preset = { id, name: `人设 ${draft.presets.length + 1}`, text: '' }
        setDraft((prev) => ({ ...prev, presets: [...prev.presets, preset], selected: id, text: '' }))
      }
      const removePreset = () => {
        if (draft.selected === '') return
        setDraft((prev) => ({
          ...prev,
          presets: prev.presets.filter((item) => item.id !== prev.selected),
          selected: '',
          text: '',
        }))
      }
      const save = () => {
        if (!form || !writable) return
        // 选中的自定义人设跟着角色设定文本一起更新。
        const presets = draft.presets.map((item) => (item.id === draft.selected
          ? { ...item, text: draft.text }
          : item))
        form.mutate([
          { op: 'set', path: ['personaBotName'], value: draft.botName.trim() },
          { op: 'set', path: ['personaGroupName'], value: draft.groupName.trim() },
          { op: 'set', path: ['personaParticipation'], value: draft.participation },
          { op: 'set', path: ['personaText'], value: draft.text },
          { op: 'set', path: ['personaExtraRules'], value: draft.extraRules },
          { op: 'set', path: ['personaSystemPrompt'], value: draft.systemPrompt },
          { op: 'set', path: ['personaPresetId'], value: draft.selected },
          { op: 'set', path: ['personaPresets'], value: presets },
        ])
        onClose()
      }

      /** 字数提示：按 Unicode 码点算，中文 / emoji 都按 1 个字计。 */
      const charCount = (text) => [...String(text ?? '')].length

      /** 人设弹窗专用字段块：标签 / 说明 / 控件竖排，三者共用同一条左基线。 */
      const pField = (label, desc, control, wide) => h('div', {
        className: 'qqg-pf' + (wide ? ' qqg-pf-wide' : ' qqg-pf-sm'),
      },
      h('div', { className: 'qqg-pf-label' }, label),
      desc ? h('div', { className: 'qqg-pf-desc' }, desc) : null,
      h('div', { className: 'qqg-pf-ctl' }, control))

      /** 多行文本框 + 框下字数占位提示。 */
      const textarea = (key, ariaLabel, rows, placeholder) => h(React.Fragment, null,
        h('textarea', {
          className: 'qqg-textarea',
          rows,
          value: draft[key],
          disabled: !writable,
          placeholder,
          'aria-label': ariaLabel,
          onChange: (e) => set(key, e.target.value),
        }),
        h('div', { className: 'qqg-pf-foot' },
          charCount(draft[key]) > 0 ? `已填 ${charCount(draft[key])} 字` : '未填写'))

      return h(Modal, {
        open: true,
        title: '人设设置',
        desc: '名字、参与度和附加规则会和角色设定一起拼成最终系统提示词；留空即用内置。',
        onClose,
        footer: [
          h('button', { key: 'c', type: 'button', className: 'qqg-btn', onClick: onClose }, '取消'),
          h('button', {
            key: 's', type: 'button', className: 'qqg-btn qqg-btn-primary',
            disabled: !writable,
            onClick: save,
          }, '保存'),
        ],
      },
      writable ? null : h('div', { className: 'qqg-status qqg-status-err', style: { marginBottom: 10 } },
        '当前配置不可写，下面的内容只能看不能改。'),

      h('div', { className: 'qqg-pform' },

        // 顶部：人设选择 + 新增 / 删除
        h('div', { className: 'qqg-persona-toolbar' },
          h('select', {
            className: 'qqg-input qqg-persona-select',
            value: draft.selected,
            disabled: !writable,
            'aria-label': '选择人设',
            onChange: (e) => selectPreset(e.target.value),
          },
          h('option', { value: '' }, '默认人设（内置）'),
          draft.presets.map((preset) => h('option', { key: preset.id, value: preset.id }, preset.name || preset.id))),
          h('button', {
            type: 'button', className: 'qqg-btn', disabled: !writable,
            onClick: addPreset,
          }, '+ 添加人设'),
          h('button', {
            type: 'button', className: 'qqg-btn', disabled: !writable || draft.selected === '',
            title: draft.selected === '' ? '当前是默认人设，没有可删除的自定义人设' : '删除当前选中的自定义人设',
            onClick: removePreset,
          }, '删除当前自定义人设')),

        // 第一排：名字 / 展示名 / 参与度（固定 200px，并排紧凑，不占满整行）
        h('div', { className: 'qqg-prow' },
          pField('机器人名字', '会替换默认人设里的名字，并追加身份说明。',
            h('input', {
              className: 'qqg-input', value: draft.botName, disabled: !writable,
              placeholder: '例如：林小鱼', 'aria-label': '机器人名字',
              onChange: (e) => set('botName', e.target.value),
            })),
          pField('群内展示名', '群聊里对别人显示的昵称。',
            h('input', {
              className: 'qqg-input', value: draft.groupName, disabled: !writable,
              placeholder: '例如：小鱼', 'aria-label': '群内展示名',
              onChange: (e) => set('groupName', e.target.value),
            })),
          pField('参与度', '决定 bot 在群里主动接话的频率。',
            h('select', {
              className: 'qqg-input', value: draft.participation, disabled: !writable,
              'aria-label': '参与度',
              onChange: (e) => set('participation', e.target.value),
            }, PERSONA_PARTICIPATION.map((item) => h('option', { key: item.id, value: item.id }, item.label))))),

        // 第二~四排：多行文本，整行宽 + 120px 起，框下带字数占位提示
        pField('角色设定', '核心人设正文。留空 = 使用 qq-chat preset 的默认人设。',
          textarea('text', '角色设定', 6, '例如：你是一只傲娇猫娘，说话带「哼」「才不是呢」……'), true),
        pField('管理员附加规则', '可选，追加到系统提示词末尾。',
          textarea('extraRules', '管理员附加规则', 4, '例如：晚上 11 点后说话轻一点。'), true),
        pField('系统提示词覆盖', '留空=使用内置。填了就完全替换上面拼出来的内容。',
          textarea('systemPrompt', '系统提示词覆盖', 4, '整段系统提示词；填写后名字 / 参与度 / 附加规则都不再追加。'), true),

        // 底部提示：紧贴表单下方
        h('div', { className: 'qqg-hint' },
          '改动要点保存才会生效。'
          + (selectedPreset ? `当前选择的自定义人设：${selectedPreset.name || selectedPreset.id}。` : '当前使用默认人设。'))))
    }

    /**
     * 人设概览卡片（只读）：名字 / 展示名 / 参与度 / 角色设定前两行。
     * 编辑入口统一收进弹窗，避免一大块文本框直接铺在设置页上。
     */
    function PersonaSection({ get, write, writable, form }) {
      const [open, setOpen] = React.useState(false)
      const botName = String(get('personaBotName') ?? '').trim()
      const groupName = String(get('personaGroupName') ?? '').trim()
      const participation = String(get('personaParticipation') ?? 'normal')
      const text = String(get('personaText') ?? '')
      const preview = text.replace(/\r/g, '').split('\n').filter((line) => line.trim() !== '').slice(0, 2).join('\n')

      return h('div', { className: 'qqg-group' },
        h('div', { className: 'qqg-group-title' }, '人设配置'),
        h('div', { className: 'qqg-persona-card' },
          h('div', { className: 'qqg-kv' }, h('span', null, '机器人名字'), h('b', null, botName || '未设置（用默认）')),
          h('div', { className: 'qqg-kv' }, h('span', null, '群内展示名'), h('b', null, groupName || '未设置')),
          h('div', { className: 'qqg-kv' }, h('span', null, '参与度'), h('b', null, personaParticipationLabel(participation))),
          h('div', { className: 'qqg-persona-role' },
            h('div', { className: 'qqg-label-desc' }, '角色设定'),
            h('div', { className: 'qqg-persona-preview' },
              preview !== '' ? preview : '未自定义，使用 qq-chat preset 的内置人设。'))),
        h('div', { className: 'qqg-actions' },
          h('button', {
            type: 'button', className: 'qqg-btn qqg-btn-primary',
            onClick: () => setOpen(true),
          }, '⚙️ 编辑人设')),
        open
          ? h(PersonaModal, {
            key: `persona-${botName}-${participation}-${[...text].length}`,
            get, write, writable, form,
            onClose: () => setOpen(false),
          })
          : null)
    }

    /**
     * 模型配置卡片：无痕热切换 + 失败降级 + 多模态拦截。
     *
     * 数据来源：`GET /dsh-qq-guard/models`。Host 侧已经把
     * `llm.listProviders()` → `listModels()` → `resolveModelInfo()` join 好了，
     * 所以每个模型自带 `input`（`["text","image"]`）、`contextWindow`、`reasoning`，
     * 面板不用再拼两个接口。
     *
     * 写入：`write()` → `settings.mutate(ns='qq-guard')` → profile 配置 → 桥接 2 秒内热应用；
     * 桥接每条消息前再 POST 给 `/dsh-qq-guard/model`，插件在 `agent/request` 里覆写单次请求。
     * 全程不碰 `session/selectModel`，**不会改 DSH 全局默认**。
     */
    function ModelSection({ get, write, writable }) {
      const [catalog, setCatalog] = React.useState(null)
      const [error, setError] = React.useState(null)
      React.useEffect(() => {
        let stopped = false
        const load = async () => {
          try {
            const res = await fetch('/dsh-qq-guard/models', {
              headers: { accept: 'application/json' },
              credentials: 'include',
            })
            const body = await res.json().catch(() => ({}))
            if (stopped) return
            if (!res.ok || body?.ok !== true) { setError(body?.reason ?? `HTTP ${res.status}`); return }
            setCatalog(body)
            setError(null)
          } catch (e) { if (!stopped) setError(e?.message ?? String(e)) }
        }
        void load()
        return () => { stopped = true }
      }, [])

      const providers = catalog?.providers ?? []
      const flat = []
      for (const provider of providers) {
        for (const model of provider.models ?? []) {
          flat.push({ ...model, provider: provider.id, providerName: provider.name })
        }
      }
      const byKey = new Map(flat.map((m) => [`${m.provider}/${m.id}`, m]))
      const curProvider = String(get('model.provider') ?? '')
      const curModel = String(get('model.model') ?? '')
      const curKey = curProvider !== '' && curModel !== '' ? `${curProvider}/${curModel}` : ''
      const cur = byKey.get(curKey)
      // 能力未知（模型不在目录里）时不吓唬人：只有明确的 ["text"] 才判定不支持图片。
      const textOnly = Array.isArray(cur?.input) && !cur.input.includes('image')
      const fallbacks = Array.isArray(get('modelFallbacks')) ? get('modelFallbacks') : []
      const defaultLabel = catalog?.default
        ? `全局默认（${catalog.default.provider}/${catalog.default.model}）`
        : '跟随全局默认'

      const optionNodes = (selectedKey) => [
        h('option', { key: '__default', value: '' }, defaultLabel),
        ...providers.map((provider) => h('optgroup', { key: provider.id, label: provider.name || provider.id },
          (provider.models ?? []).map((model) => h('option', {
            key: `${provider.id}/${model.id}`,
            value: `${provider.id}/${model.id}`,
          }, `${model.name || model.id}${Array.isArray(model.input) && !model.input.includes('image') ? '（纯文本）' : ''}`)))),
      ]

      const chooseCurrent = (key) => {
        const target = byKey.get(key)
        if (!target) {
          write('model.provider', '')
          write('model.model', '')
          write('model.reasoningEffort', '')
          return
        }
        write('model.provider', target.provider)
        write('model.model', target.id)
        // 换模型后旧档位可能不合法，清掉让它走新模型的默认档。
        const effortIds = (target.reasoning?.efforts ?? []).map((item) => item.id)
        const effort = String(get('model.reasoningEffort') ?? '')
        if (effort !== '' && !effortIds.includes(effort)) write('model.reasoningEffort', '')
      }

      const pickFallback = (index, key) => {
        const next = fallbacks.slice()
        if (key === '') next.splice(index, 1)
        else {
          const target = byKey.get(key)
          if (!target) return
          next[index] = { provider: target.provider, model: target.id }
        }
        write('modelFallbacks', next)
      }

      const addFallback = () => {
        const used = new Set(fallbacks.map((fb) => `${fb.provider}/${fb.model}`))
        if (curKey !== '') used.add(curKey)
        const candidate = flat.find((m) => !used.has(`${m.provider}/${m.id}`))
        if (!candidate) return
        write('modelFallbacks', [...fallbacks, { provider: candidate.provider, model: candidate.id }])
      }

      const effortNodes = (cur?.reasoning?.efforts ?? []).map((item) =>
        h('option', { key: item.id, value: item.id }, item.name || item.id))

      return h('div', { className: 'qqg-group' },
        h('div', { className: 'qqg-group-title' }, '模型配置'),
        h('div', { className: 'qqg-hint' },
          '无痕热切换：只改 QQ 会话下一次请求用的模型，不动 DSH 全局默认；改完下一条消息生效。'),

        error !== null ? h('div', { className: 'qqg-hint qqg-hint-warn' }, `读取模型目录失败：${error}`) : null,

        h(Field, { label: '当前模型', desc: '留空 = 跟随全局默认（显式下发默认值，避免会话粘在旧模型上）。' },
          h('select', {
            className: 'qqg-input qqg-input-grow', value: curKey,
            disabled: !writable || flat.length === 0,
            'aria-label': '当前模型',
            onChange: (e) => chooseCurrent(e.target.value),
          }, optionNodes(curKey))),

        textOnly
          ? h('div', { className: 'qqg-hint qqg-hint-warn' },
            '⚠️ 该模型不支持图片输入（input 只有 text）：QQ 里发图会被上游拒绝，请换成带「图片」能力的模型。')
          : null,

        cur !== undefined && effortNodes.length > 0
          ? h(Field, { label: '推理档位', desc: '留空 = 用该模型自己的默认档。' },
            h('select', {
              className: 'qqg-input qqg-input-grow',
              value: String(get('model.reasoningEffort') ?? ''),
              disabled: !writable,
              'aria-label': '推理档位',
              onChange: (e) => write('model.reasoningEffort', e.target.value),
            }, h('option', { value: '' }, '模型默认'), effortNodes))
          : null,

        h(Field, {
          label: '备用模型',
          desc: `主模型超时或报错时按顺序接管（同一轮内生效）；最多 4 个，当前 ${fallbacks.length}/4。`,
        },
        h('div', { className: 'qqg-fb-list' },
          fallbacks.map((fb, index) => h('div', { className: 'qqg-fb-row', key: `${index}-${fb.provider}/${fb.model}` },
            h('select', {
              className: 'qqg-input qqg-input-grow',
              value: `${fb.provider}/${fb.model}`,
              disabled: !writable,
              'aria-label': `备用模型 ${index + 1}`,
              onChange: (e) => pickFallback(index, e.target.value),
            }, optionNodes(''), byKey.has(`${fb.provider}/${fb.model}`)
              ? null
              : h('option', { value: `${fb.provider}/${fb.model}` }, `${fb.provider}/${fb.model}（当前不可用）`)),
            h('button', {
              type: 'button', className: 'qqg-btn qqg-btn-ghost',
              disabled: !writable,
              'aria-label': `移除备用模型 ${index + 1}`,
              onClick: () => pickFallback(index, ''),
            }, '移除'))),
          fallbacks.length < 4
            ? h('button', {
              type: 'button', className: 'qqg-btn',
              disabled: !writable || flat.length === 0,
              onClick: addFallback,
            }, '＋ 添加备用模型')
            : h('div', { className: 'qqg-hint' }, '已达上限 4 个。'))))
    }

    /**
     * 高级参数（折叠卡）。
     *
     * 三个「响应链路时间常数」：桥接等待上限、静默看门狗、防抖窗口。
     * 平时不用动；排障时改完保存，桥接 2 秒内热读生效。
     */
    function AdvancedSection({ get, write, writable }) {
      return h('details', { className: 'qqg-advanced' },
        h('summary', null, '高级参数（排障 / 调优，一般不用动）'),
        h('div', { className: 'qqg-group' },
          h(Field, { label: '等待回复上限', desc: '毫秒。桥接等这么久还没回复就取消这一轮并给 QQ 回一句提示。默认 20000。' },
            h(NumberField, {
              value: get('replyTimeoutMs'), min: 1000, max: 600000, disabled: !writable,
              ariaLabel: '等待回复上限', onCommit: (n) => write('replyTimeoutMs', n),
            })),
          h(Field, { label: '看门狗切断时间', desc: '毫秒。QQ 会话用的模型超过这个时间没有任何输出，就判定超时并切备用模型。0 = 关闭。默认 8000。' },
            h(NumberField, {
              value: get('modelWatchdogMs'), min: 0, max: 120000, disabled: !writable,
              ariaLabel: '看门狗切断时间', onCommit: (n) => write('modelWatchdogMs', n),
            })),
          h(Field, { label: '防抖合并窗口', desc: '毫秒。同一人连续短消息在这个窗口内合并成一次请求。0 = 沿用「活跃设置」里的窗口（默认 800）。' },
            h(NumberField, {
              value: get('antiDebounceMs'), min: 0, max: 60000, disabled: !writable,
              ariaLabel: '防抖合并窗口', onCommit: (n) => write('antiDebounceMs', n),
            })),
          h('div', { className: 'qqg-hint' },
            '改完保存即生效：桥接每 2 秒轮询一次配置，下一条消息就按新值走。')))
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

    /** NapCat 进程状态轮询（运行状态页用）：每 3 秒一次；启停后 refresh() 立刻再拉。 */
    function useNapcatProcess(enabled = true) {
      const [snap, setSnap] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        if (!enabled) return undefined
        let stopped = false
        let timer = null
        const load = async () => {
          try {
            const res = await fetch('/dsh-qq-guard/napcat?action=status', {
              headers: { accept: 'application/json' },
              credentials: 'include',
            })
            if (stopped) return
            if (res.ok) { setSnap(await res.json()); setError(null) }
            else setError(`状态查询失败：HTTP ${res.status}`)
          } catch (e) { if (!stopped) setError(e?.message ?? String(e)) }
          if (!stopped) timer = setTimeout(load, 3000)
        }
        void load()
        return () => { stopped = true; if (timer) clearTimeout(timer) }
      }, [enabled, tick])
      return { snap, error, refresh: () => setTick((v) => v + 1) }
    }

    /**
     * NapCat 进程控制面板（「运行状态」页，紧接「实时状态」）。
     *
     * 启停操作从「全局设置」搬到这里：路由仍是 `/dsh-qq-guard/napcat?action=...`，
     * 与「实时状态」里的桥接启停并排；状态每 3 秒轮询一次，点完启停立刻 refresh，
     * 所以按钮状态和端口监听情况会跟着实时变。
     */
    function NapcatProcessSection({ get, writable }) {
      const { snap, error, refresh } = useNapcatProcess(true)
      const [busy, setBusy] = React.useState(false)
      const [actError, setActError] = React.useState(null)
      const napcatDir = String(get('napcat.dir') ?? '').trim()

      const act = async (action) => {
        setBusy(true); setActError(null)
        try {
          const res = await fetch(`/dsh-qq-guard/napcat?action=${action}`, {
            method: 'POST', credentials: 'include',
            headers: { accept: 'application/json' },
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || !body.ok) setActError(body.detail ?? body.reason ?? `HTTP ${res.status}`)
        } catch (e) { setActError(e?.message ?? String(e)) }
        finally { setBusy(false); refresh() }
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
      const tagCls = state === 'online' ? 'qqg-tag qqg-tag-ok'
        : (state === 'stopped' ? 'qqg-tag' : state ? 'qqg-tag qqg-tag-warn' : 'qqg-tag')

      // 安装目录为空时直接禁用启动：Host 端 resolveNapcatExe 会抛「未配置安装目录」，
      // 与其让用户点了看报错，不如在这里就 fail-closed，并把原因写进按钮 title。
      const canStart = writable && !busy && napcatDir !== '' && (state === 'stopped' || state === undefined)
      const canStop = writable && !busy && snap?.managed === true
      const startTitle = napcatDir === ''
        ? '先到「全局设置 → NapCat 进程」填写安装目录'
        : (state === 'stopped' || state === undefined ? '启动 NapCat 进程' : 'NapCat 已在运行')

      return h('div', { className: 'qqg-group' },
        h('div', { className: 'qqg-group-head' },
          h('div', { className: 'qqg-group-title' }, 'NapCat 进程'),
          h('div', { className: 'qqg-actions' },
            h('button', {
              type: 'button', className: 'qqg-btn qqg-btn-primary',
              disabled: !canStart,
              title: startTitle,
              onClick: () => act('start'),
            }, busy ? '处理中…' : '启动 NapCat'),
            h('button', {
              type: 'button', className: 'qqg-btn',
              disabled: !canStop,
              title: snap?.managed === true ? '停止由本插件启动的 NapCat' : '当前进程不是本插件启动的，不能停',
              onClick: () => act('stop'),
            }, '停止'))),

        h(Field, { label: '当前状态', desc: '三层判定：进程存活 + WS 端口监听 + get_status 在线，三者同时成立才算在线。' },
          h('div', { className: 'qqg-inline' },
            h('span', { className: tagCls },
              h('span', { className: 'qqg-dot ' + dotCls }),
              h('span', null, snap ? (stateText[state] ?? state) : '查询中…')))),

        h(Field, { label: '端口监听', desc: 'WS 端口是否处于 LISTENING。' },
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

        napcatDir === ''
          ? h('div', { className: 'qqg-status qqg-status-err' },
            '未配置安装目录，NapCat 无法启动。请到「全局设置 → NapCat 进程」填写安装目录。')
          : null,
        actError ? h('div', { className: 'qqg-status qqg-status-err' }, actError) : null,
        error ? h('div', { className: 'qqg-status qqg-status-err' }, error) : null,
        snap?.lastError ? h('div', { className: 'qqg-detail' }, `上次错误：${snap.lastError}`) : null,

        // NapCat 日志：和桥接日志同一套折叠框。
        // 为什么必须有：端口被占 / QQ 未登录 / 缺运行库这些原因只打在 NapCat 自己的输出里，
        // 进程一退出就什么都不剩，面板不给看就只能靠猜。
        snap?.logTail?.length
          ? h('details', { className: 'qqg-logbox' },
            h('summary', null, `NapCat 最近日志（${snap.logTail.length} 行）`),
            h('pre', { className: 'qqg-log' }, snap.logTail.join('\n')))
          : h('div', { className: 'qqg-hint' }, '还没有 NapCat 日志（进程未启动过）。启动失败时这里会显示它自己的报错。'),

        h('div', { className: 'qqg-hint' },
          '启动前会先探测端口，已在跑就直接复用，不会双开。停止顺序：先 TERM，5 秒宽限后强制结束进程树。'))
    }

    /**
     * NapCat 配置区（「全局设置」页）：**只保留输入框**。
     *
     * 启停按钮与进程状态已经移到「运行状态」页的 NapCat 控制面板，
     * 这里避免两处各放一套按钮、各自轮询造成状态不同步。
     */
    function NapcatSection({ get, write, writable, pickDirectory }) {
      // 「浏览」按钮：picking 期间禁用，避免连点叠出两个原生对话框（Host 也会 409）。
      const [picking, setPicking] = React.useState(false)
      const [pickError, setPickError] = React.useState(null)
      const napcatDir = String(get('napcat.dir') ?? '')

      /**
       * 点「浏览」→ 弹系统「选择文件夹」窗口 → 拿绝对路径直接写进配置。
       * 前端**不碰**文件系统：浏览器的 <input type="file"> 按安全策略拿不到绝对路径。
       * 两条通路（优先级从高到低）：
       *   ① `uiWorkspace.pickDirectory()`（客户端服务，走同一个原生对话框，改完 F5 就可用）
       *   ② `POST /dsh-qq-guard/pick-dir`（我们自己的 Host 路由，需重启 DSH 才注册）
       * 取消不是错误，静默返回。
       */
      const browseDir = async () => {
        if (picking) return
        setPicking(true); setPickError(null)
        try {
          if (typeof pickDirectory === 'function') {
            const result = await pickDirectory()
            if (result?.ok) {
              if (result.path) write('napcat.dir', String(result.path))
              return
            }
            if (result?.reason !== 'no-ui-workspace') {
              setPickError(result?.detail ?? result?.reason ?? '调起选择器失败')
              return
            }
            // uiWorkspace 没装载 → 落到下面的 Host 路由兜底。
          }
          const res = await fetch('/dsh-qq-guard/pick-dir', {
            method: 'POST', credentials: 'include',
            headers: { accept: 'application/json' },
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || !body.ok) {
            // 404：Host 侧路由还没注册（改了 index.js 但没重载插件）。
            // 501：profile 没挂 directory-picker，或当前是 browse 后端没有原生窗口。
            // 两种情况都退化成「手输路径」，把原因说清楚，别只甩个 HTTP 状态码。
            const hint = res.status === 404
              ? 'Host 端还没有 /dsh-qq-guard/pick-dir 路由。插件代码刚更新的话，需要重启 DSH（或在应用内把插件关开一次）才会注册。'
              : res.status === 501
                ? '当前 DSH 没有可用的原生目录选择器，请直接在输入框里填绝对路径。'
                : res.status === 409
                  ? '已经有一个选择窗口开着，先处理它再点。'
                  : null
            setPickError(hint ?? body.detail ?? body.reason ?? `HTTP ${res.status}`)
            return
          }
          if (body.cancelled === true || body.path === null || body.path === undefined) return
          write('napcat.dir', String(body.path))
        } catch (e) {
          setPickError(e?.message ?? String(e))
        } finally {
          setPicking(false)
        }
      }

      return h('div', { className: 'qqg-group' },
        h('div', { className: 'qqg-group-title' }, 'NapCat 进程'),
        // 安装目录：输入框独占一行并 flex:1 自适应（塞进 148px 的 qqg-control 会溢出），
        // 右侧跟「浏览」按钮调系统原生文件夹选择器。
        h('div', { className: 'qqg-field-block' },
          h('div', { className: 'qqg-label-main' }, '安装目录'),
          h('div', { className: 'qqg-label-desc' },
            '含 NapCatWinBootMain.exe 的目录。点「浏览」直接选文件夹，不用手打路径。'),
          h('div', { className: 'qqg-dir-row' },
            h('input', {
              className: 'qqg-input qqg-dir-input',
              value: napcatDir,
              placeholder: 'C:\\Program Files\\NapCat',
              disabled: !writable,
              'aria-label': 'NapCat 安装目录',
              onChange: (e) => write('napcat.dir', e.target.value),
            }),
            h('button', {
              type: 'button',
              className: 'qqg-btn qqg-btn-browse',
              disabled: !writable || picking,
              title: '打开系统的「选择文件夹」窗口',
              'aria-label': '浏览选择 NapCat 安装目录',
              onClick: browseDir,
            }, picking ? '选择中…' : '浏览')),
          pickError ? h('div', { className: 'qqg-status qqg-status-err' }, pickError) : null,
          napcatDir.trim() === ''
            ? h('div', { className: 'qqg-status qqg-status-err' },
              '未配置安装目录，NapCat 无法启动。点「浏览」选择一个文件夹。')
            : null),
        h(Field, { label: '快速登录 QQ 号', desc: '填了就带账号启动（等同 napcat.quick.bat）；留空需手动登录。' },
          h('input', {
            className: 'qqg-input qqg-input-grow',
            value: get('napcat.quickLoginQQ') ?? '',
            placeholder: '例如 1000000001',
            disabled: !writable,
            'aria-label': '快速登录 QQ 号',
            onChange: (e) => write('napcat.quickLoginQQ', e.target.value),
          })),
        h('div', { className: 'qqg-hint' },
          '启动/停止操作请前往「运行状态」页。'))
    }

    /* ══════════ 通用壳组件 ══════════ */
    function Panel({ title, desc, right, accent, children }) {
      return h('section', { className: 'qqg-panel' + (accent ? ' qqg-panel-accent' : '') },
        (title || right)
          ? h('div', { className: 'qqg-panel-head' },
            h('div', null,
              title ? h('div', { className: 'qqg-panel-title' }, title) : null,
              desc ? h('div', { className: 'qqg-panel-desc' }, desc) : null),
            right ?? null)
          : null,
        children)
    }

    function StatCard({ label, value, unit, foot, footCls }) {
      return h('div', { className: 'qqg-stat' },
        h('div', { className: 'qqg-stat-label' }, label),
        h('div', { className: 'qqg-stat-value' }, value,
          unit ? h('span', { className: 'qqg-stat-unit' }, unit) : null),
        foot ? h('div', { className: 'qqg-stat-foot ' + (footCls ?? '') }, foot) : null)
    }

    function TabHead({ title, desc, tags }) {
      return h('div', { className: 'qqg-tabhead' },
        h('div', null,
          h('h2', { className: 'qqg-tabhead-title' }, title),
          desc ? h('p', { className: 'qqg-tabhead-desc' }, desc) : null),
        tags ? h('div', { className: 'qqg-pagehead-tags' }, tags) : null)
    }

    function fmtNum(n) { return n.toLocaleString('zh-CN') }

    /**
     * 成本展示：`null` = 该路由没配单价（Host 端刻意返回 null），显示「—」。
     * 金额可能很小（一次调用几厘钱），小于 1 分时给个区间提示，不四舍五入成 0。
     */
    function fmtCost(cost) {
      if (cost === null || cost === undefined) return '—'
      const value = Number(cost)
      if (!Number.isFinite(value)) return '—'
      if (value > 0 && value < 0.01) return '<¥0.01'
      return '¥' + value.toFixed(2)
    }

    /** 「较昨日 +12.3%」；null（昨天没数据）时返回 null，由调用方决定兜底文案。 */
    function fmtTrend(value) {
      if (value === null || value === undefined) return null
      const n = Number(value)
      if (!Number.isFinite(n)) return null
      if (Math.abs(n) < 0.05) return '与昨日持平'
      return `较昨日 ${n > 0 ? '+' : ''}${n.toFixed(1)}%`
    }

    function trendClass(value) {
      if (value === null || value === undefined) return ''
      return Number(value) >= 0 ? 'qqg-up' : 'qqg-down'
    }

    /** 单段 HH:MM-HH:MM 校验（与 Host parsePeakHours 同口径）。 */
    function isValidPeakSegment(text) {
      const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ''))
      if (!match) return false
      const [startHour, startMinute, endHour, endMinute] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
      return startHour <= 23 && endHour <= 23 && startMinute <= 59 && endMinute <= 59
    }

    /** 多段时段校验：英文逗号分隔，每段都要合法，至少一段。 */
    function isValidPeakHours(text) {
      const segments = String(text ?? '').split(',').map((part) => part.trim()).filter(Boolean)
      return segments.length > 0 && segments.every(isValidPeakSegment)
    }

    /** IANA 时区 → 「UTC+8」这样的展示（取当前时刻的偏移）。 */
    function timezoneOffsetLabel(timeZone) {
      try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
          .formatToParts(new Date())
        const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
        return name.replace('GMT', 'UTC') || String(timeZone)
      } catch {
        return String(timeZone)
      }
    }

    /* ══════════ 通用模态框 ══════════ */
    /**
     * 统一弹窗：遮罩 + 卡片 + 标题栏 + 底部按钮区。
     * 关闭方式三种：右上角 ×、点遮罩、按 Esc。
     * `size='sm'` 用于确认框（窄版）。
     * `footer` 传 null 表示不渲染按钮区。
     */
    function Modal({ open, title, desc, size, onClose, footer, children }) {
      // Esc 关闭。挂 window 而不是元素，否则焦点不在弹窗里就收不到按键。
      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, onClose])
      if (!open) return null
      return h('div', {
        className: 'qqg-mask',
        role: 'presentation',
        // 只在点遮罩本体时关闭；点弹窗内部会冒泡上来，用 target 判断拦住。
        onClick: (e) => { if (e.target === e.currentTarget) onClose() },
      },
      h('div', {
        className: 'qqg-modal' + (size === 'sm' ? ' qqg-modal-sm' : ''),
        role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
      },
      h('div', { className: 'qqg-modal-head' },
        h('div', null,
          h('div', { className: 'qqg-modal-title' }, title),
          desc ? h('div', { className: 'qqg-modal-desc' }, desc) : null),
        h('button', {
          type: 'button', className: 'qqg-modal-x', 'aria-label': '关闭',
          onClick: onClose,
        }, '×')),
      h('div', { className: 'qqg-modal-body' }, children),
      footer === null ? null : h('div', { className: 'qqg-modal-foot' }, footer)))
    }

    /** 确认框：复用 Modal，按钮固定「取消 / 确认」。 */
    function ConfirmModal({ open, title, desc, confirmText, danger, onCancel, onConfirm }) {
      return h(Modal, {
        open, title, desc, size: 'sm', onClose: onCancel,
        footer: [
          h('button', { key: 'c', type: 'button', className: 'qqg-btn', onClick: onCancel }, '取消'),
          h('button', {
            key: 'o', type: 'button',
            className: 'qqg-btn ' + (danger ? 'qqg-btn-danger' : 'qqg-btn-primary'),
            onClick: onConfirm,
          }, confirmText ?? '确认'),
        ],
      })
    }

    /** 单行输入框表单字段。 */
    function TextField({ label, hint, value, placeholder, onChange }) {
      return h('label', { className: 'qqg-field' },
        h('span', { className: 'qqg-field-label' }, label),
        h('input', {
          className: 'qqg-input', style: { width: '100%' }, value,
          placeholder, 'aria-label': label,
          onChange: (e) => onChange(e.target.value),
        }),
        hint ? h('span', { className: 'qqg-field-hint' }, hint) : null)
    }

    /** 下拉选择字段。 */
    function SelectField({ label, hint, value, options, onChange }) {
      return h('label', { className: 'qqg-field' },
        h('span', { className: 'qqg-field-label' }, label),
        h('select', {
          className: 'qqg-input', style: { width: '100%' }, value,
          'aria-label': label,
          onChange: (e) => onChange(e.target.value),
        }, options.map((o) => h('option', { key: o, value: o }, o))),
        hint ? h('span', { className: 'qqg-field-hint' }, hint) : null)
    }

    /** 数字字段。 */
    function NumField({ label, hint, value, min, max, step, onChange }) {
      return h('label', { className: 'qqg-field' },
        h('span', { className: 'qqg-field-label' }, label),
        h('input', {
          type: 'number', className: 'qqg-input', style: { width: '100%' },
          value, min, max, step, 'aria-label': label,
          onChange: (e) => {
            const n = Number(e.target.value)
            onChange(Number.isFinite(n) ? n : value)
          },
        }),
        hint ? h('span', { className: 'qqg-field-hint' }, hint) : null)
    }

    /** 开关字段（一行文字 + 右侧 Switch）。 */
    function SwitchField({ label, hint, value, onChange, disabled }) {
      return h('div', { className: 'qqg-row' },
        h('div', { className: 'qqg-label' },
          h('div', { className: 'qqg-label-main' }, label),
          hint ? h('div', { className: 'qqg-label-desc' }, hint) : null),
        h('div', { className: 'qqg-control' },
          h(Switch, { checked: value === true, ariaLabel: label, onChange, disabled })))
    }

    /** 按 settings 描述数组渲染一组字段（技能 / 插件设置弹窗共用）。 */
    function SettingsFields({ fields, values, onChange }) {
      return h(React.Fragment, null, fields.map((f) => {
        const v = values[f.key] ?? f.value
        const set = (next) => onChange(f.key, next)
        if (f.type === 'switch') return h(SwitchField, { key: f.key, label: f.label, hint: f.hint, value: v, onChange: set })
        if (f.type === 'select') return h(SelectField, { key: f.key, label: f.label, hint: f.hint, value: v, options: f.options, onChange: set })
        if (f.type === 'number') {
          return h(NumField, {
            key: f.key, label: f.label, hint: f.hint, value: v,
            min: f.min, max: f.max, step: f.step, onChange: set,
          })
        }
        return h(TextField, { key: f.key, label: f.label, hint: f.hint, value: v, onChange: set })
      }))
    }


    /** 今日用量概览（真实数据：/dsh-qq-guard/usage?days=2，5 秒刷新）。 */
    function TodayUsage() {
      const usage = useUsage(2)
      const data = usage.data
      const today = data?.today ?? null
      const trend = data?.trend ?? {}
      const priced = data?.pricing?.configured === true
      const pending = usage.status === 'loading'
      const apiFailed = usage.status === 'error'
      const footOf = (value) => fmtTrend(value) ?? (pending ? '统计中…' : '较昨日 —')
      return h(Panel, {
        title: '今日用量概览',
        desc: apiFailed
          ? `用量接口读不到：${usage.error}`
          : '真实数据：Host 拦截 assistant/message 的 usage，每 5 秒刷新。',
        right: h('span', { className: 'qqg-pill qqg-pill-accent' },
          apiFailed ? '接口异常' : (priced ? '今日' : '今日 · 成本未配置')),
      },
      h('div', { className: 'qqg-stats' },
        h(StatCard, {
          label: '调用次数', value: fmtNum(today?.calls ?? 0), unit: '次',
          foot: footOf(trend.calls), footCls: trendClass(trend.calls),
        }),
        h(StatCard, {
          label: 'Token 消耗', value: fmtNum(today?.tokens ?? 0), unit: 'tokens',
          foot: footOf(trend.tokens), footCls: trendClass(trend.tokens),
        }),
        h(StatCard, {
          label: '预估成本', value: fmtCost(today?.cost ?? null),
          foot: priced ? (fmtTrend(trend.cost) ?? '较昨日 —') : '未配置单价（成本显示 —）',
          footCls: priced ? trendClass(trend.cost) : '',
        }),
        h(StatCard, {
          label: '成功回复', value: today?.ok == null ? '—' : today.ok.toFixed(1),
          unit: today?.ok == null ? '' : '%',
          foot: today ? `完成 ${today.turnOk} · 失败 ${today.turnFail}` : (apiFailed ? '接口异常' : '统计中…'),
        })))
    }

    /** AI 排障助手（只有壳）。 */
    function AiAssistant() {
      const [text, setText] = React.useState('')
      return h(Panel, {
        title: 'AI 排障助手',
        desc: '接入日志后可按需诊断；当前仅界面骨架，未连接模型。',
        right: h('span', { className: 'qqg-pill' }, '未接入'),
      },
      h('div', { className: 'qqg-ai' },
        h('div', { className: 'qqg-ai-chips' },
          ['为什么桥接连不上？', 'NapCat 没登录怎么办？', '帮我看看最近报错', '分片太碎了怎么调']
            .map((q) => h('button', {
              key: q, type: 'button', className: 'qqg-ai-chip',
              onClick: () => setText(q),
            }, q))),
        h('div', { className: 'qqg-ai-row' },
          h('textarea', {
            className: 'qqg-ai-input', rows: 2,
            placeholder: '描述现象，例如「群消息收到了但没回复」…',
            value: text,
            'aria-label': 'AI 排障助手输入框',
            onChange: (e) => setText(e.target.value),
          }),
          h('button', {
            type: 'button', className: 'qqg-btn qqg-btn-primary',
            disabled: !text.trim(), onClick: noop,
          }, '分析'))))
    }

    /* ══════════ Tab 2 · 会话管理（Mock）══════════ */
    function SessionsTab() {
      const [list, setList] = React.useState(MOCK_SESSIONS)
      const [selected, setSelected] = React.useState(MOCK_SESSIONS[0].id)
      const [allowOverride, setAllowOverride] = React.useState({})
      const [personaDraft, setPersonaDraft] = React.useState({})
      const [confirmDel, setConfirmDel] = React.useState(false)
      const cur = list.find((s) => s.id === selected) ?? list[0]
      // 删到空列表时不能继续渲染详情，给个空态。
      if (!cur) {
        return h('div', { className: 'qqg-stack' },
          h(TabHead, { title: '会话管理', desc: '本页为 Mock 数据，未接真实会话服务。' }),
          h(Panel, { title: '会话列表为空', desc: 'Mock 阶段删除只影响本次页面状态，刷新即恢复。' },
            h('div', { className: 'qqg-actions' },
              h('button', {
                type: 'button', className: 'qqg-btn qqg-btn-primary',
                onClick: () => { setList(MOCK_SESSIONS); setSelected(MOCK_SESSIONS[0].id) },
              }, '恢复 Mock 数据'))))
      }
      const allow = allowOverride[cur.id] ?? cur.allow
      const persona = personaDraft[cur.id] ?? cur.persona
      const doDelete = () => {
        const rest = list.filter((s) => s.id !== cur.id)
        setList(rest)
        if (rest.length > 0) setSelected(rest[0].id)
        setConfirmDel(false)
      }

      return h('div', { className: 'qqg-stack' },
        h(TabHead, {
          title: '会话管理',
          desc: '按会话覆盖人设与白名单；本页为 Mock 数据，未接真实会话服务。',
          tags: h(React.Fragment, null,
            h('span', { className: 'qqg-pill' }, `${list.length} 个会话`),
            h('span', { className: 'qqg-pill qqg-pill-accent' }, 'Mock')),
        }),
        h('div', { className: 'qqg-split' },
          h('div', { className: 'qqg-session-list', 'aria-label': '会话列表' },
            list.map((s) => h('div', {
              key: s.id,
              className: 'qqg-session' + (s.id === selected ? ' qqg-session-on' : ''),
              role: 'button', tabIndex: 0,
              onClick: () => setSelected(s.id),
              onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') setSelected(s.id) },
            },
            h('div', { className: 'qqg-avatar' }, s.initial),
            h('div', { className: 'qqg-session-main' },
              h('div', { className: 'qqg-session-top' },
                h('span', { className: 'qqg-session-name' }, s.name),
                h('span', { className: 'qqg-session-time' }, s.time)),
              h('div', { className: 'qqg-session-preview' }, s.preview)),
            s.unread > 0 ? h('span', { className: 'qqg-unread' }, s.unread > 99 ? '99+' : s.unread) : null))),

          h('div', { className: 'qqg-session-detail' },
            h(Panel, null,
              h('div', { className: 'qqg-detail-head' },
                h('div', { className: 'qqg-avatar qqg-avatar-lg' }, cur.initial),
                h('div', { className: 'qqg-detail-meta' },
                  h('div', { className: 'qqg-detail-name' }, cur.name),
                  h('div', { className: 'qqg-detail-sub' },
                    h('span', { className: 'qqg-mono' }, cur.qq),
                    h('span', { className: 'qqg-pill' }, cur.kind),
                    h('span', { className: 'qqg-pill ' + (cur.online ? 'qqg-pill-accent' : '') },
                      cur.online ? '在线' : '离线'),
                    h('span', { className: 'qqg-pill' }, cur.tag))),
                h('div', { className: 'qqg-actions' },
                  h('button', { type: 'button', className: 'qqg-btn', onClick: noop }, '打开会话'),
                  h('button', { type: 'button', className: 'qqg-btn', onClick: noop }, '清空上下文'),
                  h('button', {
                    type: 'button', className: 'qqg-btn qqg-btn-danger',
                    onClick: () => setConfirmDel(true),
                  }, '删除会话')))),
            h(Panel, {
              title: '单人设覆盖',
              desc: '留空则沿用全局人设；保存后对该会话生效。',
              right: h('span', { className: 'qqg-pill' }, `${[...persona].length} 字`),
            },
            h('textarea', {
              className: 'qqg-ai-input', rows: 5,
              placeholder: '为该会话单独指定人设…',
              value: persona,
              'aria-label': '单人设覆盖',
              onChange: (e) => setPersonaDraft((m) => ({ ...m, [cur.id]: e.target.value })),
            }),
            h('div', { className: 'qqg-textarea-actions' },
              h('button', { type: 'button', className: 'qqg-btn qqg-btn-primary', onClick: noop }, '保存人设'),
              h('button', {
                type: 'button', className: 'qqg-btn',
                onClick: () => setPersonaDraft((m) => ({ ...m, [cur.id]: '' })),
              }, '恢复全局'))),

            h(Panel, { title: '单独白名单', desc: '关闭后该会话不再进白名单，消息直接丢弃。' },
              h('div', { className: 'qqg-row' },
                h('div', { className: 'qqg-label' },
                  h('div', { className: 'qqg-label-main' }, '允许该会话'),
                  h('div', { className: 'qqg-label-desc' }, '仅对本会话生效，不影响全局白名单。')),
                h('div', { className: 'qqg-control' },
                  h(Switch, {
                    checked: allow, ariaLabel: '单独白名单开关',
                    onChange: (v) => setAllowOverride((m) => ({ ...m, [cur.id]: v })),
                  })))),

            h(Panel, {
              title: '记忆提取',
              desc: '从该会话抽取长期事实写入记忆空间。',
            },
            h('div', { className: 'qqg-actions' },
              h('button', { type: 'button', className: 'qqg-btn qqg-btn-primary', onClick: noop }, '提取记忆'),
              h('button', { type: 'button', className: 'qqg-btn', onClick: noop }, '查看已提取'))),

            h(Panel, { title: '最近消息', desc: 'Mock 展示。' },
              h('div', { className: 'qqg-list' },
                cur.messages.map((m, i) => h('div', {
                  key: i, className: 'qqg-msg' + (m.from === 'me' ? ' qqg-msg-me' : ''),
                },
                h('div', { className: 'qqg-msg-meta' },
                  (m.from === 'me' ? 'bot' : cur.name) + ' · ' + m.time),
                h('div', null, m.text)))))
          )
        ),

        h(ConfirmModal, {
          open: confirmDel,
          title: `删除会话「${cur.name}」？`,
          desc: '会移除该会话的人设覆盖、白名单设置与本地缓存。Mock 阶段只在本次页面状态里删除，刷新即恢复。',
          confirmText: '删除会话',
          danger: true,
          onCancel: () => setConfirmDel(false),
          onConfirm: doDelete,
        })
      )
    }

    /* ══════════ Tab 3 · 技能与插件（Mock）══════════ */
    /**
     * 一张卡片：图标 + 名字 + 版本 + 描述 + 开关，右侧工具区（齿轮 / 垃圾桶 / 拖拽手柄）。
     * 原生 HTML5 拖拽：卡片本身 draggable，手柄只是视觉提示（按住卡片任意位置都能拖）。
     * 上下箭头是拖拽的降级方案，键盘用户也能排序。
     */
    function MockTile({ item, index, total, onToggle, onSettings, onDelete, onMove,
      dragging, dragOver, onDragStart, onDragEnd, onDragOver, onDrop }) {
      const cls = ['qqg-tile']
      if (dragging) cls.push('qqg-tile-dragging')
      if (dragOver) cls.push('qqg-tile-over')
      return h('div', {
        className: cls.join(' '),
        draggable: true,
        onDragStart,
        onDragEnd,
        onDragOver,
        onDrop,
      },
      h('div', { className: 'qqg-tile-top' },
        h('span', { className: 'qqg-drag', title: '拖拽排序', 'aria-hidden': true },
          h(DotsHandle, { size: 15 })),
        h('div', { className: 'qqg-tile-icon' }, h(Glyph, { name: item.icon, size: 17 })),
        h('div', { className: 'qqg-tile-title' },
          h('div', { className: 'qqg-tile-name' }, item.name),
          h('div', { className: 'qqg-tile-sub' }, `${item.tag} · v${item.ver}`)),
        h('div', { className: 'qqg-tile-tools' },
          h('button', {
            type: 'button', className: 'qqg-icon-btn',
            title: '设置', 'aria-label': `${item.name} 设置`,
            onClick: (e) => { e.stopPropagation(); onSettings(item) },
          }, h(Glyph, { name: 'gear', size: 14 })),
          h('button', {
            type: 'button', className: 'qqg-icon-btn qqg-icon-btn-danger',
            title: '删除', 'aria-label': `删除 ${item.name}`,
            onClick: (e) => { e.stopPropagation(); onDelete(item) },
          }, h(Glyph, { name: 'trash', size: 14 })))),
      h('div', { className: 'qqg-tile-desc' }, item.desc),
      h('div', { className: 'qqg-tile-foot' },
        h('span', { className: 'qqg-status' }, item.enabled ? '已启用' : '已停用'),
        h('div', { className: 'qqg-tile-arrows' },
          h('button', {
            type: 'button', className: 'qqg-icon-btn', title: '上移',
            'aria-label': `${item.name} 上移`,
            disabled: index === 0,
            onClick: (e) => { e.stopPropagation(); onMove(index, -1) },
          }, h(Glyph, { name: 'arrowUp', size: 13 })),
          h('button', {
            type: 'button', className: 'qqg-icon-btn', title: '下移',
            'aria-label': `${item.name} 下移`,
            disabled: index === total - 1,
            onClick: (e) => { e.stopPropagation(); onMove(index, 1) },
          }, h(Glyph, { name: 'arrowDown', size: 13 }))),
        h(Switch, {
          checked: item.enabled, ariaLabel: `${item.name} 开关`,
          onChange: () => onToggle(item.id),
        })))
    }

    /** 技能 / 插件设置弹窗：左表单，右说明。 */
    function TileSettingsModal({ target, onClose }) {
      const item = target?.item
      const [values, setValues] = React.useState({})
      // 每次换目标重新灌一遍初值，避免上一个卡片的设置串到下一个。
      React.useEffect(() => { setValues({}) }, [target?.item?.id])
      if (!item) return null
      const fields = item.settings ?? []
      return h(Modal, {
        open: true,
        title: `${item.name} · 设置`,
        desc: `v${item.ver} · ${item.tag} · 最后更新 ${item.updated}`,
        onClose,
        footer: [
          h('button', { key: 'r', type: 'button', className: 'qqg-btn', onClick: () => setValues({}) }, '恢复默认'),
          h('button', { key: 'c', type: 'button', className: 'qqg-btn', onClick: onClose }, '取消'),
          h('button', {
            key: 's', type: 'button', className: 'qqg-btn qqg-btn-primary',
            onClick: () => { onClose() },
          }, '保存'),
        ],
      },
      h('div', { className: 'qqg-setgrid' },
        h('div', null,
          fields.length
            ? h(SettingsFields, { fields, values, onChange: (k, v) => setValues((m) => ({ ...m, [k]: v })) })
            : h('div', { className: 'qqg-hint' }, '该条目暂无可配置项。')),
        h('div', { className: 'qqg-setdesc' },
          h('div', { className: 'qqg-setdesc-title' }, '说明'),
          h('div', { className: 'qqg-setdesc-text' }, item.desc),
          h('div', { className: 'qqg-kv' }, h('span', null, '作者'), h('b', null, item.author)),
          h('div', { className: 'qqg-kv' }, h('span', null, '版本'), h('b', null, 'v' + item.ver)),
          h('div', { className: 'qqg-kv' }, h('span', null, '分类'), h('b', null, item.tag)),
          (item.notes ?? []).length
            ? h('ul', { className: 'qqg-setdesc-list' },
              item.notes.map((n, i) => h('li', { key: i }, n)))
            : null,
          h('div', { className: 'qqg-field-hint' }, 'Mock 阶段：保存只关弹窗，不写任何配置。'))))
    }

    /** 添加技能 / 添加插件弹窗（输入框 + 本地文件选择占位）。 */
    function AddModal({ kind, onClose, onAdd }) {
      const label = kind === 'skill' ? '技能' : '插件'
      const [name, setName] = React.useState('')
      const [desc, setDesc] = React.useState('')
      const [file, setFile] = React.useState('')
      if (!kind) return null
      const submit = () => {
        const n = name.trim()
        if (!n) return
        onAdd({ name: n, desc: desc.trim() || `手动添加的${label}。`, file })
      }
      return h(Modal, {
        open: true,
        title: `添加${label}`,
        desc: `Mock 阶段只往列表里插一条本地数据，不读真实文件、不装任何东西。`,
        size: 'sm',
        onClose,
        footer: [
          h('button', { key: 'c', type: 'button', className: 'qqg-btn', onClick: onClose }, '取消'),
          h('button', {
            key: 'a', type: 'button', className: 'qqg-btn qqg-btn-primary',
            disabled: !name.trim(), onClick: submit,
          }, `添加${label}`),
        ],
      },
      h(TextField, {
        label: `${label}名称`, value: name, onChange: setName,
        placeholder: kind === 'skill' ? '例如：表情包生成' : '例如：消息去重',
      }),
      h('div', { style: { height: 12 } }),
      h(TextField, {
        label: '简介（可选）', value: desc, onChange: setDesc,
        placeholder: '一句话说明它做什么',
      }),
      h('div', { style: { height: 14 } }),
      h('div', { className: 'qqg-dropzone', role: 'button', tabIndex: 0,
        onClick: () => setFile(file ? '' : `${label}-bundle.zip`),
        onKeyDown: (e) => { if (e.key === 'Enter') setFile(file ? '' : `${label}-bundle.zip`) },
      },
      h(Glyph, { name: 'plus', size: 18 }),
      h('span', null, file ? `已选择：${file}（点击清除）` : '点击选择本地文件（.zip / .js，Mock）')))
    }

    /**
     * 外部插件「测试运行」结果弹窗（P1）。
     *
     * 成功：展示入口导出、hooks/providers、插件实际调用过的 api、耗时与沙箱 pid。
     * 失败：展示稳定错误码 + message + Host 收集的 stderr 尾部（含被 registerHooks
     * 拦下的 node:fs 这类信息）。
     */
    function SandboxResultModal({ state, onClose }) {
      const open = state !== null && state !== undefined && state.phase === 'done'
      const ok = state?.ok === true
      const result = state?.result ?? {}
      const info = result.exports ?? {}
      const list = (value) => (Array.isArray(value) && value.length > 0 ? value.join('、') : '（无）')
      const has = (value) => (value === true ? '有' : '无')
      const err = state?.error ?? {}
      const rows = ok
        ? [
          ['模块', result.moduleId ?? state?.name ?? ''],
          ['入口导出', `setup ${has(info.setup)} · register ${has(info.register)} · activate ${has(info.activate)}`],
          ['hooks', list(info.hooks)],
          ['providers', list(info.providers)],
          ['插件用到的 api', list(result.apiCalls)],
          ['耗时', `${result.durationMs ?? '?'} ms`],
          ['沙箱', result.sandbox
            ? `pid ${result.sandbox.pid ?? '?'} · Node ${result.sandbox.node ?? '?'}`
            : '—'],
        ]
        : []

      return h(Modal, {
        open,
        title: ok ? '加载成功' : '加载失败',
        desc: state ? state.name : '',
        onClose,
        footer: [h('button', {
          key: 'ok', type: 'button', className: 'qqg-btn qqg-btn-primary', onClick: onClose,
        }, '知道了')],
      },
      ok
        ? h('div', { className: 'qqg-stack' },
          h('div', { className: 'qqg-status' }, '插件已在独立沙箱子进程中 import 成功，并执行完 setup(api)。'),
          rows.map(([key, value]) => h('div', { key, className: 'qqg-kv' },
            h('span', null, key), h('b', null, String(value)))))
        : h('div', { className: 'qqg-stack' },
          h('div', { className: 'qqg-status qqg-status-err' },
            `${err.code ?? 'E_UNKNOWN'}：${err.message ?? '加载失败'}`),
          err.detail ? h('pre', { className: 'qqg-log' }, String(err.detail)) : null,
          Array.isArray(err.stderrTail) && err.stderrTail.length > 0
            ? h('pre', { className: 'qqg-log' }, err.stderrTail.join('\n'))
            : null))
    }

    /**
     * 把外部插件的 configSchema + 清单默认值 + 本地已保存值合成一份表单初值。
     * 只处理 boolean / number / string / enum；Host 扫描时已经把其他类型丢掉了。
     */
    function buildExternalDraft(module, saved) {
      const schema = module?.configSchema ?? {}
      const defaults = module?.settingsDefaults ?? {}
      const current = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
      const draft = {}
      for (const [key, field] of Object.entries(schema)) {
        let value = current[key]
        if (value === undefined) value = defaults[key]
        if (value === undefined) value = field.default
        if (field.type === 'boolean') draft[key] = value === true
        else if (field.type === 'number') draft[key] = Number.isFinite(Number(value)) ? Number(value) : 0
        else if (field.type === 'string') draft[key] = String(value ?? '')
        else if (field.type === 'enum') {
          const values = Array.isArray(field.values) ? field.values : []
          draft[key] = values.includes(String(value)) ? String(value) : (values[0] ?? '')
        }
      }
      return draft
    }

    /**
     * 外部插件设置弹窗（P1.5）：按 configSchema 动态渲染表单。
     *
     * 配置只写进**本插件自己的** profile 配置（`externalPlugins.settings[模块 id]`），
     * 不碰对方目录里的 config.json；沙箱执行时如何消费这些值留到 P2。
     */
    function ExtSettingsModal({ module, saved, writable, onSave, onClose }) {
      const schema = module?.configSchema ?? {}
      const [draft, setDraft] = React.useState(() => buildExternalDraft(module, saved))
      const setField = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }))

      const control = (key, field) => {
        const value = draft[key]
        const label = field.label || key
        const disabled = !writable
        if (field.type === 'boolean') {
          return h(Switch, {
            checked: value === true, disabled, ariaLabel: label,
            onChange: (next) => setField(key, next),
          })
        }
        if (field.type === 'number') {
          return h('input', {
            type: 'number', className: 'qqg-input qqg-input-num',
            value: value === undefined ? '' : String(value),
            min: field.min, max: field.max, step: field.step,
            disabled, 'aria-label': label,
            onChange: (e) => setField(key, e.target.value === '' ? '' : Number(e.target.value)),
          })
        }
        if (field.type === 'enum') {
          const values = Array.isArray(field.values) ? field.values : []
          return h('select', {
            className: 'qqg-input', value: value ?? '', disabled, 'aria-label': label,
            onChange: (e) => setField(key, e.target.value),
          }, values.map((option) => h('option', { key: option, value: option }, option)))
        }
        if (field.multiline === true) {
          return h('textarea', {
            className: 'qqg-textarea', rows: 3,
            value: String(value ?? ''), disabled, 'aria-label': label,
            onChange: (e) => setField(key, e.target.value),
          })
        }
        return h('input', {
          className: 'qqg-input qqg-input-grow',
          type: field.secret === true ? 'password' : 'text',
          value: String(value ?? ''), disabled, 'aria-label': label,
          onChange: (e) => setField(key, e.target.value),
        })
      }

      const fields = Object.entries(schema)
      const kinds = new Set(fields.map(([, field]) => field.type))
      const skipped = (module?.unknownFieldCount ?? 0)

      return h(Modal, {
        open: true,
        title: `外部插件配置 · ${module?.name || module?.id || ''}`,
        desc: '来自对方的 configSchema，保存到本插件的本地配置；不会写入对方目录。',
        onClose,
        footer: [
          h('button', { key: 'c', type: 'button', className: 'qqg-btn', onClick: onClose }, '取消'),
          h('button', {
            key: 's', type: 'button', className: 'qqg-btn qqg-btn-primary',
            disabled: !writable || fields.length === 0,
            onClick: () => onSave(draft),
          }, '保存'),
        ],
      },
      writable ? null : h('div', { className: 'qqg-status qqg-status-err', style: { marginBottom: 10 } },
        '当前配置不可写，下面的值只能看不能改。'),
      fields.length === 0
        ? h('div', { className: 'qqg-hint' }, '这个插件没有可渲染的配置项。')
        : h('div', { className: 'qqg-stack' }, fields.map(([key, field]) => h(Field, {
          key,
          label: field.label || key,
          desc: field.description || '',
        }, control(key, field)))),
      h('div', { className: 'qqg-hint', style: { marginTop: 10 } },
        `支持的类型：boolean / number / string / enum（共 ${kinds.size} 种）`
        + (skipped > 0 ? `；清单另有 ${skipped} 个非标字段已忽略。` : '。')))
    }

    function SkillsTab({ get, write, writable, pickDirectory }) {
      // 清单本身来自配置：数组顺序 = 展示顺序，enabled = 开关。
      // 不再有前端假列表，所有改动都写回 config（写盘由 config-editor 负责）。
      const skills = Array.isArray(get('skills')) ? get('skills') : []
      const plugins = Array.isArray(get('plugins')) ? get('plugins') : []
      const extEnabled = Array.isArray(get('externalPlugins.enabled')) ? get('externalPlugins.enabled') : []
      const extDirs = Array.isArray(get('externalPlugins.dirs')) ? get('externalPlugins.dirs') : []

      const [settingsTarget, setSettingsTarget] = React.useState(null)
      const [deleteTarget, setDeleteTarget] = React.useState(null)
      const [addKind, setAddKind] = React.useState(null)
      const [drag, setDrag] = React.useState({ from: null, over: null })
      const [dirDraft, setDirDraft] = React.useState('')
      const [scan, setScan] = React.useState(null)
      const [scanError, setScanError] = React.useState(null)
      const [scanBusy, setScanBusy] = React.useState(false)
      // P1：外部插件「测试运行」状态。running 时卡片按钮显示加载中，done 后弹结果。
      const [sandboxRun, setSandboxRun] = React.useState(null)
      // P1.5：外部插件过滤（all / self / controlled）与 configSchema 弹窗目标。
      const [extFilter, setExtFilter] = React.useState('all')
      const [extSettingsTarget, setExtSettingsTarget] = React.useState(null)

      const listOf = (kind) => (kind === 'skill' ? skills : plugins)
      const pathOf = (kind) => (kind === 'skill' ? 'skills' : 'plugins')
      const saveList = (kind, next) => {
        if (!writable) return
        write(pathOf(kind), next)
      }

      const flip = (kind) => (id) => saveList(kind, listOf(kind).map((x) =>
        (x.id === id ? { ...x, enabled: !x.enabled } : x)))

      const moveTo = (kind, from, to) => {
        const list = listOf(kind)
        if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return
        const next = list.slice()
        const [it] = next.splice(from, 1)
        next.splice(to, 0, it)
        saveList(kind, next)
      }

      const remove = (kind) => (id) => saveList(kind, listOf(kind).filter((x) => x.id !== id))

      const add = (kind) => (draft) => {
        const isSkill = kind === 'skill'
        saveList(kind, [...listOf(kind), {
          id: `custom-${Date.now()}`,
          icon: isSkill ? 'spark' : 'bridge',
          name: draft.name,
          desc: draft.desc,
          ver: '0.1.0',
          tag: '自定义',
          enabled: false,
        }])
        setAddKind(null)
      }

      const countOn = (list) => list.filter((x) => x.enabled).length

      /* ── 外部插件：只读扫描 Host 的目录，不改目标、不装包 ── */
      const runScan = async () => {
        setScanBusy(true); setScanError(null)
        try {
          const res = await fetch('/dsh-qq-guard/external-plugins', {
            headers: { accept: 'application/json' }, credentials: 'include',
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || !body.ok) { setScanError(body.detail ?? body.reason ?? `HTTP ${res.status}`); return }
          setScan(body)
        } catch (e) {
          setScanError(e?.message ?? String(e))
        } finally {
          setScanBusy(false)
        }
      }
      React.useEffect(() => { void runScan() }, [JSON.stringify(extDirs)])

      const toggleExternal = (key, name) => {
        if (!writable) return
        // 兼容历史配置：早期只记包名，现在优先记 id（id 与目录名可能不一致）。
        const matches = (x) => x === key || (name !== undefined && x === name)
        const on = extEnabled.some(matches)
        const next = on ? extEnabled.filter((x) => !matches(x)) : [...extEnabled, key]
        write('externalPlugins.enabled', next)
      }

      const addDir = (dir) => {
        const d = String(dir ?? '').trim()
        if (!writable || !d) return
        if (extDirs.includes(d)) return
        write('externalPlugins.dirs', [...extDirs, d])
        setDirDraft('')
      }

      /**
       * P1：把外部插件交给 Host 的独立沙箱子进程加载。
       *
       * 只传 id + dir（Host 会重新扫描校验，不信任前端路径）；
       * 结果弹窗展示导出的 setup/hooks 和插件碰过的 api，失败展示错误码。
       */
      const runSandbox = async (it) => {
        if (sandboxRun?.phase === 'running') return
        setSandboxRun({ id: it.id, name: it.name || it.id, phase: 'running' })
        try {
          const res = await fetch('/dsh-qq-guard/external-plugins/test', {
            method: 'POST',
            credentials: 'include',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ id: it.id, dir: it.dir }),
          })
          const body = await res.json().catch(() => ({}))
          if (res.ok && body?.ok === true) {
            setSandboxRun({ id: it.id, name: it.name || it.id, phase: 'done', ok: true, result: body.result ?? {} })
          } else {
            setSandboxRun({
              id: it.id,
              name: it.name || it.id,
              phase: 'done',
              ok: false,
              error: body?.error ?? { code: `HTTP_${res.status}`, message: '沙箱请求失败' },
            })
          }
        } catch (error) {
          setSandboxRun({
            id: it.id,
            name: it.name || it.id,
            phase: 'done',
            ok: false,
            error: { code: 'E_NETWORK', message: error?.message ?? String(error) },
          })
        }
      }

      const renderGrid = (kind, list) => h('div', { className: 'qqg-grid' },
        list.length === 0
          ? h('div', { className: 'qqg-hint' }, '清单为空。可以点右上角添加，或在配置文件里编辑。')
          : list.map((it, i) => h(MockTile, {
            key: it.id, item: it, index: i, total: list.length,
            onToggle: flip(kind),
            onSettings: (item) => setSettingsTarget({ kind, item }),
            onDelete: (item) => setDeleteTarget({ kind, item }),
            onMove: (index, delta) => moveTo(kind, index, index + delta),
            dragging: drag.from === `${kind}:${it.id}`,
            dragOver: drag.over === `${kind}:${it.id}` && drag.from !== `${kind}:${it.id}`,
            onDragStart: (e) => {
              setDrag({ from: `${kind}:${it.id}`, over: null })
              // 必须 setData，否则 Firefox 不认为这是有效拖拽。
              try { e.dataTransfer.setData('text/plain', it.id) } catch { /* 忽略 */ }
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
            },
            onDragEnd: () => setDrag({ from: null, over: null }),
            onDragOver: (e) => {
              if (!drag.from || !drag.from.startsWith(kind + ':')) return
              e.preventDefault()  // 不 preventDefault 就不会触发 drop
              if (drag.over !== `${kind}:${it.id}`) setDrag((d) => ({ ...d, over: `${kind}:${it.id}` }))
            },
            onDrop: (e) => {
              e.preventDefault()
              const fromKey = drag.from ?? ''
              if (!fromKey.startsWith(kind + ':')) { setDrag({ from: null, over: null }); return }
              const fromId = fromKey.slice(kind.length + 1)
              moveTo(kind, list.findIndex((x) => x.id === fromId), i)
              setDrag({ from: null, over: null })
            },
          })))

      const extEntries = scan?.entries ?? []
      /** 外部模块来源格式 → 卡片文案（三种形态：DSH 包 / QQ 技能 / QQ 插件）。 */
      const FORMAT_LABEL = {
        'package.json': 'DSH 包',
        'skill.json': '技能清单',
        'plugin.json': '插件清单',
      }
      const KIND_LABEL = { package: 'DSH 插件包', skill: '技能', plugin: '插件' }
      /** 兼容等级 → 标签样式：受控黄、无效红、DSH 原生绿、自包含中性。 */
      const compatClass = (tier) => tier === 'controlled' ? 'qqg-tag qqg-tag-warn'
        : tier === 'invalid' ? 'qqg-tag qqg-tag-err'
          : tier === 'native' ? 'qqg-tag qqg-tag-ok' : 'qqg-tag'
      /** 卡片副标题：版本 + 目录语义 + DSH 入口。 */
      const extSub = (it) => {
        const parts = [KIND_LABEL[it.kind] ?? '模块', `v${it.version || '0.0.0'}`]
        if (it.kind === 'package') {
          const entry = `${it.hasClient ? 'UI' : ''}${it.hasBundle ? (it.hasClient ? '+Host' : 'Host') : ''}`
          if (entry) parts.push(entry)
        }
        return parts.join(' · ')
      }
      /** 卡片元数据行：来源格式 / 分类 / 作者 / 被忽略的非标字段数。 */
      const extMeta = (it) => {
        const parts = [FORMAT_LABEL[it.format] ?? it.format]
        if (it.category) parts.push(`分类 ${it.category}`)
        if (it.author) parts.push(`作者 ${it.author}`)
        if (Number(it.unknownFieldCount) > 0) parts.push(`已忽略 ${it.unknownFieldCount} 个非标字段`)
        return parts.join(' · ')
      }
      const compatTitle = (it) => {
        const reasons = Array.isArray(it.compat?.reasons) ? it.compat.reasons : []
        return reasons.length > 0 ? reasons.join('；') : '静态扫描未发现宿主依赖'
      }
      /** 开关状态以配置里的「意图」为准，不靠扫描快照（否则点完不刷新看不到变化）。 */
      const extOn = (it) => extEnabled.includes(it.id) || extEnabled.includes(it.name)
      const extCount = (tier) => extEntries.filter((it) => it.compat?.tier === tier).length
      /** 过滤下拉：全部 / 自包含 / 受控（坏清单只在「全部」里出现）。 */
      const extFiltered = extEntries.filter((it) => {
        if (extFilter === 'self') return it.compat?.tier === 'self-contained'
        if (extFilter === 'controlled') return it.compat?.tier === 'controlled'
        return true
      })
      const extSettingsSaved = get('externalPlugins.settings')
      const savedSettingsOf = (it) => {
        const all = extSettingsSaved && typeof extSettingsSaved === 'object' ? extSettingsSaved : {}
        const saved = all[it.id]
        return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
      }

      return h('div', { className: 'qqg-stack' },
        h('div', { className: 'qqg-tabhead' },
          h('div', null,
            h('h2', { className: 'qqg-tabhead-title' }, '技能与插件'),
            h('p', { className: 'qqg-tabhead-desc' },
              '清单、顺序、开关全部来自真实配置，改完立即写回；外部插件只读扫描、默认全关。')),
          h('div', { className: 'qqg-actions' },
            h('button', {
              type: 'button', className: 'qqg-btn',
              onClick: () => setAddKind('plugin'),
            }, '+ 添加插件'),
            h('button', {
              type: 'button', className: 'qqg-btn qqg-btn-primary',
              onClick: () => setAddKind('skill'),
            }, '+ 添加技能'))),

        h(Panel, {
          title: '技能（Skill）',
          desc: '会话内可调用的能力，按需启用。顺序即展示顺序。',
          right: h('span', { className: 'qqg-pill' }, `${countOn(skills)} / ${skills.length} 已启用`),
        }, renderGrid('skill', skills)),

        h(Panel, {
          title: '插件（Plugin）',
          desc: '消息处理管线上的中间件，改动对桥接即时生效。',
          right: h('span', { className: 'qqg-pill' }, `${countOn(plugins)} / ${plugins.length} 已启用`),
        }, renderGrid('plugin', plugins)),

        // ── 外部插件挂载 ──
        h(Panel, {
          title: '外部插件',
          desc: '只读扫描目录里的有效模块：带 `dsh` 字段的 package.json、QQ Agent 的 plugin.json / skill.json（BOM 容错）。默认全部关闭；P0 只展示卡片，不加载、不执行任何外部代码。',
          right: h('div', { className: 'qqg-actions' },
            h('select', {
              className: 'qqg-input', value: extFilter, disabled: extEntries.length === 0,
              'aria-label': '外部插件过滤',
              onChange: (e) => setExtFilter(e.target.value),
            },
            h('option', { value: 'all' }, `全部 ${extEntries.length}`),
            h('option', { value: 'self' }, `自包含 ${extCount('self-contained')}`),
            h('option', { value: 'controlled' }, `受控 ${extCount('controlled')}`)),
            h('span', { className: 'qqg-pill' },
              scanBusy ? '扫描中…' : `可跑 ${scan?.runnable ?? 0} / ${scan?.scanned ?? 0}`),
            (scan?.controlled ?? 0) > 0
              ? h('span', { className: 'qqg-pill' }, `受控 ${scan.controlled}`)
              : null,
            h('button', { type: 'button', className: 'qqg-btn', onClick: runScan }, '重新扫描')),
        },
        h('div', { className: 'qqg-dir-row', style: { marginBottom: 10 } },
          h('input', {
            className: 'qqg-input qqg-dir-input',
            value: dirDraft,
            placeholder: scan?.dirs?.[0] ?? '外部插件目录（profile 的 node_modules，或 QQ Agent 的 app 根）',
            disabled: !writable,
            'aria-label': '外部插件目录',
            onChange: (e) => setDirDraft(e.target.value),
          }),
          h('button', {
            type: 'button', className: 'qqg-btn qqg-btn-browse',
            disabled: !writable,
            title: '选择目录',
            onClick: async () => {
              if (typeof pickDirectory !== 'function') return
              const r = await pickDirectory()
              if (r?.ok && r.path) addDir(r.path)
            },
          }, '浏览'),
          h('button', {
            type: 'button', className: 'qqg-btn qqg-btn-primary',
            disabled: !writable || !dirDraft.trim(),
            onClick: () => addDir(dirDraft),
          }, '添加目录')),
        extDirs.length > 0
          ? h('div', { className: 'qqg-chips', style: { marginBottom: 10 } },
            extDirs.map((d) => h('span', { key: d, className: 'qqg-chip' },
              h('span', { className: 'qqg-chip-text' }, d),
              h('button', {
                type: 'button', className: 'qqg-chip-x', disabled: !writable,
                'aria-label': `移除目录 ${d}`,
                onClick: () => write('externalPlugins.dirs', extDirs.filter((x) => x !== d)),
              }, '×'))))
          : null,
        scanError ? h('div', { className: 'qqg-status qqg-status-err', style: { marginBottom: 8 } }, scanError) : null,
        extEntries.length === 0
          ? h('div', { className: 'qqg-hint' },
            scan ? '该目录下没有找到 package.json（含 dsh 字段）/ plugin.json / skill.json。' : '正在扫描…')
          : extFiltered.length === 0
            ? h('div', { className: 'qqg-hint' }, '当前筛选下没有插件，切回「全部」看看。')
            : h('div', { className: 'qqg-grid' },
              extFiltered.map((it) => {
                const desc = clipCardText(it.description || '（无描述）')
                const schemaCount = Object.keys(it.configSchema ?? {}).length
                return h('div', { key: it.dir ?? it.id ?? it.name, className: 'qqg-tile' },
                  h('div', { className: 'qqg-tile-top' },
                    h('span', { className: 'qqg-drag' }, h(DotsHandle, { size: 14 })),
                    h('div', { className: 'qqg-tile-icon' }, h(Glyph, { name: 'bridge', size: 16 })),
                    h('div', { className: 'qqg-tile-title' },
                      h('div', { className: 'qqg-tile-name' }, it.name || it.id),
                      h('div', { className: 'qqg-tile-sub' }, extSub(it))),
                    // 配置齿轮（有 configSchema 才有） + 兼容性标签。
                    h('div', { className: 'qqg-tile-tools' },
                      schemaCount > 0
                        ? h('button', {
                          type: 'button', className: 'qqg-icon-btn',
                          title: `配置（${schemaCount} 项，来自 configSchema）`,
                          'aria-label': `${it.name || it.id} 设置`,
                          onClick: () => setExtSettingsTarget(it),
                        }, h(Glyph, { name: 'settings', size: 14 }))
                        : null,
                      h('span', {
                        className: compatClass(it.compat?.tier),
                        title: compatTitle(it),
                      }, it.compat?.label ?? '未判定'))),
                  h('div', {
                    className: 'qqg-tile-desc',
                    title: desc.clipped ? desc.full : undefined,
                  }, desc.text),
                  h('div', { className: 'qqg-tile-sub', style: { marginTop: 4 } }, extMeta(it)),
                  it.error
                    ? h('div', { className: 'qqg-status qqg-status-err', style: { marginTop: 4, fontSize: 10.5 } }, it.error)
                    : null,
                  Array.isArray(it.warnings) && it.warnings.length > 0
                    ? h('div', {
                      className: 'qqg-hint', style: { marginTop: 4, fontSize: 10.5 },
                      title: it.warnings.join('；'),
                    }, `⚠ ${it.warnings.slice(0, 2).join('；')}${it.warnings.length > 2 ? ' …' : ''}`)
                    : null,
                  h('div', { className: 'qqg-tile-foot' },
                    h('div', { className: 'qqg-actions' },
                      h('button', {
                        type: 'button', className: 'qqg-btn',
                        disabled: !it.hasEntry
                          || it.compat?.tier !== 'self-contained'
                          || sandboxRun?.phase === 'running',
                        title: !it.hasEntry
                          ? '该模块没有入口文件，无法加载'
                          : it.compat?.tier !== 'self-contained'
                            ? `「${it.compat?.label ?? '未判定'}」模块 P1 不加载；等沙箱 shim（P2）`
                            : '在独立子进程里加载并执行 setup(api)',
                        onClick: () => runSandbox(it),
                      }, sandboxRun?.phase === 'running' && sandboxRun.id === it.id ? '加载中…' : '测试运行'),
                      h('span', { className: 'qqg-status' },
                        extOn(it) ? '已启用（仅记录意图）' : '已关闭')),
                    h(Switch, {
                      checked: extOn(it),
                      disabled: !writable,
                      ariaLabel: `${it.name || it.id} 开关`,
                      onChange: () => toggleExternal(it.id || it.name, it.name),
                    })))
              }))),

        // P1：沙箱加载结果弹窗
        h(SandboxResultModal, {
          state: sandboxRun,
          onClose: () => setSandboxRun(null),
        }),

        // P1.5：configSchema 动态表单弹窗（按模块挂 key，切换模块时重建初值）
        extSettingsTarget
          ? h(ExtSettingsModal, {
            key: extSettingsTarget.dir ?? extSettingsTarget.id,
            module: extSettingsTarget,
            saved: savedSettingsOf(extSettingsTarget),
            writable,
            onClose: () => setExtSettingsTarget(null),
            onSave: (draft) => {
              const all = extSettingsSaved && typeof extSettingsSaved === 'object' && !Array.isArray(extSettingsSaved)
                ? extSettingsSaved
                : {}
              write('externalPlugins.settings', { ...all, [extSettingsTarget.id]: draft })
              setExtSettingsTarget(null)
            },
          })
          : null,

        h(TileSettingsModal, {
          target: settingsTarget,
          onClose: () => setSettingsTarget(null),
        }),

        h(ConfirmModal, {
          open: deleteTarget !== null,
          title: deleteTarget ? `删除「${deleteTarget.item.name}」？` : '',
          desc: deleteTarget
            ? `${deleteTarget.kind === 'skill' ? '技能' : '插件'}会从配置里移除，写盘后立即生效。`
            : '',
          confirmText: '删除',
          danger: true,
          onCancel: () => setDeleteTarget(null),
          onConfirm: () => {
            if (deleteTarget) remove(deleteTarget.kind)(deleteTarget.item.id)
            setDeleteTarget(null)
          },
        }),

        h(AddModal, {
          kind: addKind,
          onClose: () => setAddKind(null),
          onAdd: (draft) => add(addKind)(draft),
        }))
    }

    /* ══════════ 使用引导（左侧导航底部按钮 + 弹窗）══════════ */
    /**
     * 三步检查清单的**唯一口径**：导航底部「x/3」和弹窗进度条都读这一份。
     *
     * 之前按钮只算了 NapCat / 白名单两项，弹窗却算三项 —— 于是三项全绿时
     * 按钮显示 2/3、弹窗显示 100%（3/3）。现在状态派生集中在这里，
     * 两边只差渲染方式，不再可能出现不同步。
     *
     * @param {(path:string)=>any} get 配置读取
     * @param {object|null} proc useBridgeProc 的实时进程状态（null = 还没查回来）
     */
    function guideSteps(get, proc) {
      const napcatDir = String(get('napcat.dir') ?? '').trim()
      const priv = get('allow.private') ?? []
      const groups = get('allow.groups') ?? []
      const bridgeKnown = proc !== null && proc !== undefined
      const bridgeAlive = proc?.alive === true
      return {
        bridgeKnown,
        bridgeAlive,
        items: [
          {
            id: 'napcat',
            name: 'NapCat 进程',
            ok: napcatDir !== '',
            desc: napcatDir !== '' ? `已配置安装目录：${napcatDir}` : '未填写安装目录，NapCat 无法启动',
          },
          {
            id: 'allow',
            name: '白名单',
            ok: priv.length > 0 || groups.length > 0,
            desc: (priv.length > 0 || groups.length > 0)
              ? `已放行 ${priv.length} 个私聊 / ${groups.length} 个群`
              : '白名单为空，默认谁都不回（fail-closed）',
          },
          {
            id: 'bridge',
            name: '桥接进程',
            ok: bridgeKnown ? bridgeAlive : null,
            desc: !bridgeKnown
              ? '正在查询桥接进程状态…'
              : bridgeAlive
                ? `运行中${proc?.uptimeMs ? `，已运行 ${Math.round(proc.uptimeMs / 1000)}s` : ''}`
                : '未运行，需要启动后才会收发消息',
          },
        ],
      }
    }

    /** 由 guideSteps 派生完成数 / 百分比；弹窗与按钮共用。 */
    function guideProgress(state) {
      const done = state.items.filter((x) => x.ok === true).length
      const total = state.items.length
      return { done, total, pct: Math.round((done / total) * 100) }
    }

    /**
     * 三步检查清单弹窗。
     *
     * 状态全部现读：
     *   ① NapCat  —— napcat.dir 是否已配置
     *   ② 白名单  —— allow.private / allow.groups 是否有条目
     *   ③ 桥接    —— useBridgeProc 的真实进程状态（alive），不是配置里的 autoStart
     *
     * 前两步「去配置」= 关弹窗 + 切到全局设置 + 滚到对应卡片；
     * 第三步「去启动」= 直接 POST /dsh-qq-guard/bridge?action=start（与运行状态页同一个路由）。
     *
     * proc 由 SettingsPanel 统一轮询后传进来：按钮上的计数也要用它，
     * 弹窗自己再轮询一份就会出现两个状态源。
     */
    function OnboardingModal({ open, get, goto, proc, refreshProc, onClose }) {
      const state = guideSteps(get, proc)
      const { done, total, pct } = guideProgress(state)
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState(null)

      const actions = {
        napcat: { action: '去配置', onAction: () => { onClose(); goto('set-napcat') } },
        allow: { action: '去配置', onAction: () => { onClose(); goto('set-allow') } },
        bridge: {
          action: state.bridgeAlive ? null : '去启动',
          onAction: async () => {
            setBusy(true); setErr(null)
            try {
              const res = await fetch('/dsh-qq-guard/bridge?action=start', {
                method: 'POST', credentials: 'include',
                headers: { accept: 'application/json' },
              })
              const body = await res.json().catch(() => ({}))
              if (!res.ok || !body.ok) setErr(body.detail ?? body.reason ?? `HTTP ${res.status}`)
            } catch (e) {
              setErr(e?.message ?? String(e))
            } finally {
              setBusy(false)
              if (typeof refreshProc === 'function') refreshProc()
            }
          },
        },
      }
      const items = state.items.map((it) => ({ ...it, ...(actions[it.id] ?? { action: null, onAction: null }) }))

      const dotOf = (ok) => (ok === true ? 'qqg-dot-ok' : ok === false ? 'qqg-dot-warn' : 'qqg-dot-idle')

      return h(Modal, {
        open, title: '使用引导',
        desc: '三步把 QQ 桥接跑通。状态实时读取当前配置与进程，改完即时刷新。',
        onClose,
        footer: [h('button', { key: 'c', type: 'button', className: 'qqg-btn qqg-btn-primary', onClick: onClose }, '知道了')],
      },
      h('div', { className: 'qqg-progress' },
        h('span', null, '完成度'),
        h('div', { className: 'qqg-progress-track' },
          h('div', { className: 'qqg-progress-fill', style: { width: pct + '%' } })),
        h('span', null, `${pct}%（${done} / ${total}）`)),
      h('div', { className: 'qqg-onboard', style: { marginTop: 12 } },
        items.map((it) => h('div', { key: it.id, className: 'qqg-onboard-row' },
          h('span', { className: 'qqg-dot ' + dotOf(it.ok) }),
          h('div', { className: 'qqg-onboard-main' },
            h('div', { className: 'qqg-onboard-name' }, it.name),
            h('div', { className: 'qqg-onboard-desc' }, it.desc)),
          it.action
            ? h('button', {
              type: 'button',
              className: 'qqg-btn' + (it.id === 'bridge' ? ' qqg-btn-primary' : ''),
              disabled: busy && it.id === 'bridge',
              onClick: it.onAction,
            }, busy && it.id === 'bridge' ? '启动中…' : it.action)
            : h('span', { className: 'qqg-pill qqg-pill-accent' },
              h(Glyph, { name: 'check', size: 11 }), '已就绪')))),
      err ? h('div', { className: 'qqg-status qqg-status-err', style: { marginTop: 10 } }, err) : null,
      h('div', { className: 'qqg-hint', style: { marginTop: 12 } },
        '顺序建议：先填 NapCat 安装目录 → 启动 NapCat 并登录 → 配好白名单 → 启动桥接。'))
    }

    /** 信息发送配置弹窗：分片参数 + 打字延时参数（全部走真实配置读写）。 */
    function SendConfigModal({ open, get, write, writable, form, onClose }) {
      return h(Modal, {
        open,
        title: '信息发送配置',
        desc: '决定回复怎么切片、每条之间等多久。改完桥接 2 秒内热更新，无需重启。',
        onClose,
        footer: [h('button', { key: 'd', type: 'button', className: 'qqg-btn qqg-btn-primary', onClick: onClose }, '完成')],
      },
      writable ? null : h('div', { className: 'qqg-status qqg-status-err', style: { marginBottom: 12 } },
        '当前配置不可写，下面的数值只能看不能改。'),
      h(SplitSection, { get, write, writable, form }))
    }

    /** 响应档位：0 仅艾特 / 1 +关键词 / 2 +随机 / 3 全响应。 */
    const ACTIVITY_LEVELS = [
      { id: 0, label: '仅艾特', desc: '只有被 @ 或私聊才回，群里最安静。' },
      { id: 1, label: '+关键词', desc: '被 @ 或命中关键词才回。' },
      { id: 2, label: '+随机', desc: '在关键词基础上，按概率随机接话。' },
      { id: 3, label: '全响应', desc: '每条消息都可能回，最吵。' },
    ]

    /**
     * 活跃设置弹窗（Phase 4：真实读写）。
     *
     * 全部字段都绑到真实配置 `rhythm.*`，改完写盘 → 桥接 2 秒内轮询到新值。
     * 弹窗里不再保留本地 state 兜底，`get()` 读什么就显示什么。
     */
    function ActiveSettingsModal({ open, get, write, writable, onClose }) {
      const level = Number(get('rhythm.activityLevel') ?? 1)
      const cur = ACTIVITY_LEVELS[level] ?? ACTIVITY_LEVELS[1]
      const debounceMs = Number(get('rhythm.debounceWindowMs') ?? 800)
      const batchMs = Number(get('rhythm.batchIntervalMs') ?? 2500)
      const muteOn = get('rhythm.mute.enabled') !== false
      const muteWords = Array.isArray(get('rhythm.mute.words')) ? get('rhythm.mute.words').join('，') : ''
      const muteSec = Number(get('rhythm.mute.seconds') ?? 60)
      const perMin = Number(get('rhythm.rateLimit.perMin') ?? 12)
      const burst = Number(get('rhythm.rateLimit.burst') ?? 3)
      const silent = get('rhythm.rateLimit.silent') !== false

      const set = (key, value) => { if (writable) write(key, value) }
      const setWords = (text) => set('rhythm.mute.words',
        String(text).split(/[，,]/).map((x) => x.trim()).filter(Boolean))

      return h(Modal, {
        open,
        title: '活跃设置',
        desc: '控制 bot 什么时候接话、接得多快。保存即写盘，桥接 2 秒内热更新。',
        onClose,
        footer: [
          h('button', {
            key: 'r', type: 'button', className: 'qqg-btn', disabled: !writable,
            onClick: () => {
              set('rhythm.activityLevel', 1)
              set('rhythm.debounceWindowMs', 800)
              set('rhythm.batchIntervalMs', 2500)
              set('rhythm.rateLimit.perMin', 12)
              set('rhythm.rateLimit.burst', 3)
              set('rhythm.rateLimit.silent', true)
              set('rhythm.mute.enabled', true)
              set('rhythm.mute.words', ['闭嘴', '安静', '别刷屏'])
              set('rhythm.mute.seconds', 60)
            },
          }, '恢复默认'),
          h('button', { key: 's', type: 'button', className: 'qqg-btn qqg-btn-primary', onClick: onClose }, '完成'),
        ],
      },
      writable ? null : h('div', { className: 'qqg-status qqg-status-err', style: { marginBottom: 12 } },
        '当前配置不可写，下面的值只能看不能改。'),
      h('div', { className: 'qqg-setgrid' },
        // 左：响应档位 + 指令禁言
        h('div', null,
          h('div', { className: 'qqg-group-title' }, '响应档位'),
          h('div', { className: 'qqg-field', style: { marginTop: 10 } },
            h('input', {
              type: 'range', className: 'qqg-slider',
              min: 0, max: ACTIVITY_LEVELS.length - 1, step: 1,
              value: level,
              disabled: !writable,
              'aria-label': '响应档位',
              onChange: (e) => set('rhythm.activityLevel', Number(e.target.value)),
            }),
            h('div', { className: 'qqg-slider-ticks' },
              ACTIVITY_LEVELS.map((l) => h('span', {
                key: l.id, className: level === l.id ? 'on' : '',
              }, l.label))),
            h('div', { className: 'qqg-field-hint', style: { marginTop: 8 } },
              `${cur.label} —— ${cur.desc}`)),
          h('div', { style: { height: 16 } }),
          h(SwitchField, {
            label: '指令禁言', value: muteOn, onChange: (v) => set('rhythm.mute.enabled', v),
            hint: '命中禁言指令词时，该会话静默一段时间不再回复。',
          }),
          muteOn ? h(React.Fragment, null,
            h(TextField, {
              label: '禁言指令词', value: muteWords, onChange: setWords,
              hint: '逗号分隔，任一命中即触发。',
            }),
            h('div', { style: { height: 12 } }),
            h(NumField, {
              label: '禁言时长（秒）', value: muteSec, min: 5, max: 3600,
              onChange: (v) => set('rhythm.mute.seconds', v),
            })) : null),

        // 右：节奏参数 + 说明
        h('div', null,
          h('div', { className: 'qqg-group-title' }, '合并与节奏'),
          h('div', { style: { marginTop: 10 } },
            h(NumField, {
              label: '防抖合并窗口（毫秒）', value: debounceMs, min: 0, max: 10000, step: 50,
              onChange: (v) => set('rhythm.debounceWindowMs', v),
              hint: '同一会话连续发多条时，等这么久再一起处理。',
            }),
            h('div', { style: { height: 12 } }),
            h(NumField, {
              label: '批次间隔（毫秒）', value: batchMs, min: 0, max: 30000, step: 100,
              onChange: (v) => set('rhythm.batchIntervalMs', v),
              hint: '一轮回复分成多个气泡时，相邻气泡的间隔。',
            }),
            h('div', { style: { height: 12 } }),
            h(NumField, {
              label: '每分钟回复上限', value: perMin, min: 1, max: 120,
              onChange: (v) => set('rhythm.rateLimit.perMin', v),
              hint: '按会话独立计数，超出后丢弃。',
            }),
            h('div', { style: { height: 12 } }),
            h(NumField, {
              label: '允许突发条数', value: burst, min: 0, max: 30,
              onChange: (v) => set('rhythm.rateLimit.burst', v),
            }),
            h('div', { style: { height: 8 } }),
            h(SwitchField, {
              label: '超限静默', value: silent,
              onChange: (v) => set('rhythm.rateLimit.silent', v),
              hint: '打开则不回「太频繁」这类提示，避免暴露机器人。',
            })),
          h('div', { className: 'qqg-setdesc', style: { marginTop: 14 } },
            h('div', { className: 'qqg-setdesc-title' }, '当前取值'),
            h('div', { className: 'qqg-kv' }, h('span', null, '响应档位'), h('b', null, cur.label)),
            h('div', { className: 'qqg-kv' }, h('span', null, '合并窗口'), h('b', null, debounceMs + ' ms')),
            h('div', { className: 'qqg-kv' }, h('span', null, '批次间隔'), h('b', null, batchMs + ' ms')),
            h('div', { className: 'qqg-kv' }, h('span', null, '频率上限'), h('b', null, perMin + '/分（突发 ' + burst + '）')),
            h('div', { className: 'qqg-kv' }, h('span', null, '指令禁言'),
              h('b', null, muteOn ? muteSec + 's' : '关')),
            h('ul', { className: 'qqg-setdesc-list' },
              h('li', null, '红线：模型原生换行绝不合并，这里只合并同一个人的连续短消息。'),
              h('li', null, '这些字段桥接每 2 秒轮询一次，保存后通常 2 秒内生效。'))))))
    }

    /**
     * 左下角快捷启动卡（真实链路）。
     *
     * 启动顺序 **NapCat → 桥接**：桥接启动时要连 NapCat 的正向 WS，
     * 顺序反了会先连不上再等重连（虽然能自愈，但启动时间翻倍）。
     * 停止顺序反过来：**桥接 → NapCat**，先断消息源再收容器，避免桥接在
     * NapCat 已死时刷一堆 ECONNREFUSED。
     *
     * 状态灯不自己猜：桥接存活读 `/dsh-qq-guard/bridge` 轮询（useBridgeProc），
     * NapCat 读 `/dsh-qq-guard/napcat` 的三层判定（useNapcatProcess，
     * 进程 + WS 端口 + get_status）。两边都是真实状态，不再有本地假动画。
     */
    function LaunchCard({ model: fallbackModel }) {
      const [proc, refreshProc] = useBridgeProc(true)
      const { snap: napcat, refresh: refreshNapcat } = useNapcatProcess(true)
      const [catalog, setCatalog] = React.useState(null)
      // 插件 Config 里真正下发的 model（比 models 路由更实时，Host 没重启也能读）。
      const [configModel, setConfigModel] = React.useState(null)
      // 'napcat' | 'bridge' | 'stopping' | null：当前正在做哪一步
      const [busy, setBusy] = React.useState(null)
      const [err, setErr] = React.useState(null)

      React.useEffect(() => {
        let stopped = false
        const json = (url) => fetch(url, { headers: { accept: 'application/json' }, credentials: 'include' })
          .then((res) => res.json())
          .catch(() => ({}))
        // 两个来源：
        //   · `/config` —— 插件 Config 的平面快照，带 `model`，**不依赖 Host 是否重启**；
        //   · `/models` —— 模型目录 + 全局默认（Host 侧 join 好的多模态能力）。
        Promise.all([json('/dsh-qq-guard/config'), json('/dsh-qq-guard/models')]).then(([cfg, catalogBody]) => {
          if (stopped) return
          setConfigModel(cfg?.config?.model ?? null)
          if (catalogBody?.ok === true) setCatalog(catalogBody)
        })
        return () => { stopped = true }
      }, [])

      const modelLabel = (() => {
        // 优先读设置页真正下发的 model（桥接实际用的就是这个），其次 models 路由的 configured，
        // 最后才是全局默认 —— 顺序不能反，否则「跟随默认」和「已配置」会显示成同一个。
        const live = configModel
        if (live && live.provider && live.model) return `${live.provider}/${live.model}`
        const configured = catalog?.configured
        if (configured && configured.provider && configured.model) {
          return `${configured.provider}/${configured.model}`
        }
        if (catalog?.default) return `${catalog.default.provider}/${catalog.default.model}（默认）`
        return fallbackModel ?? '跟随全局默认'
      })()

      const post = async (base, action) => {
        const res = await fetch(`${base}?action=${action}`, {
          method: 'POST', credentials: 'include',
          headers: { accept: 'application/json' },
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok || body?.ok === false) {
          throw new Error(body?.detail ?? body?.reason ?? `HTTP ${res.status}`)
        }
        return body
      }

      const napcatState = napcat?.state ?? null
      const napcatUp = napcatState === 'online'
        || napcatState === 'running-unverified'
        || napcatState === 'external'
      const bridgeUp = proc?.alive === true
      const ready = bridgeUp && napcatUp
      const starting = busy !== null

      const launch = async () => {
        if (starting) return
        setErr(null)
        try {
          if (!napcatUp) {
            setBusy('napcat')
            await post('/dsh-qq-guard/napcat', 'start')
          }
          setBusy('bridge')
          await post('/dsh-qq-guard/bridge', 'start')
        } catch (error) {
          setErr(error?.message ?? String(error))
        } finally {
          setBusy(null)
          refreshProc()
          refreshNapcat()
        }
      }

      const shutdown = async () => {
        if (starting) return
        setErr(null)
        try {
          setBusy('stopping')
          if (bridgeUp) await post('/dsh-qq-guard/bridge', 'stop')
          if (napcatUp) await post('/dsh-qq-guard/napcat', 'stop')
        } catch (error) {
          setErr(error?.message ?? String(error))
        } finally {
          setBusy(null)
          refreshProc()
          refreshNapcat()
        }
      }

      const dotCls = err !== null ? 'qqg-dot-err' : starting ? 'qqg-dot-warn' : ready ? 'qqg-dot-ok' : 'qqg-dot-idle'
      const stateText = err !== null
        ? '启动失败'
        : starting
          ? (busy === 'napcat' ? '启动 NapCat…' : busy === 'bridge' ? '启动桥接…' : '停止中…')
          : ready ? '就绪' : napcatState === 'starting' ? 'NapCat 启动中…' : '未就绪'
      const buttonLabel = busy === 'stopping'
        ? '停止中…'
        : starting
          ? '启动中…'
          : ready ? '停止' : '一键启动 QQ + NapCat'

      return h('div', { className: 'qqg-launch' },
        h('div', { className: 'qqg-launch-top' },
          h('span', { className: 'qqg-launch-state' },
            h('span', { className: 'qqg-dot ' + dotCls }),
            stateText)),
        h('div', { className: 'qqg-launch-model', title: `当前模型：${modelLabel}` },
          h('span', { className: 'qqg-launch-model-label' }, '当前模型'),
          h('span', { className: 'qqg-launch-model-name' }, modelLabel)),
        err !== null
          ? h('div', { className: 'qqg-launch-err', title: err }, err.length > 60 ? `${err.slice(0, 60)}…` : err)
          : null,
        h('button', {
          type: 'button', className: 'qqg-launch-btn',
          disabled: starting,
          title: ready
            ? '停止桥接进程与 NapCat（按 桥接 → NapCat 顺序）'
            : '一键启动：先拉起 NapCat，再启动桥接（状态轮询真实进程）',
          onClick: ready ? shutdown : launch,
        },
        h(Glyph, { name: ready ? 'stop' : 'play', size: 12 }),
        buttonLabel))
    }

    /**
     * 全局设置 · 记忆整理（第一批 UI 壳，纯前端 Mock）。
     *
     * 三个控件先用组件内 state；第二批把 state 换成 remote.settings 的
     * `memory.*` 字段（schema 在 index.js 补），开关/输入走 mutate 真实写盘。
     */
    function MemoryPanel() {
      const [enabled, setEnabled] = React.useState(true)
      const [sameModel, setSameModel] = React.useState(true)
      const [cooldownMs, setCooldownMs] = React.useState(21600000)
      return h(Panel, {
        title: '记忆整理',
        desc: '把会话里的长期事实整理进记忆空间。Mock 阶段只切换界面状态，不写配置。',
      },
      h(Field, { label: '启用记忆自动整理', desc: '按冷却时间自动抽取并整理长期记忆。' },
        h(Switch, {
          checked: enabled, ariaLabel: '启用记忆自动整理',
          onChange: (next) => setEnabled(next),
        })),
      h(Field, { label: '使用同模型', desc: '整理时复用当前会话的模型，不再单独指定。' },
        h(Switch, {
          checked: sameModel, disabled: !enabled, ariaLabel: '使用同模型',
          onChange: (next) => setSameModel(next),
        })),
      h(Field, { label: '整理冷却时间（毫秒）', desc: '两次自动整理之间的最小间隔，默认 21600000（6 小时）。' },
        h(NumberField, {
          value: cooldownMs, min: 60000, max: 604800000, disabled: !enabled,
          ariaLabel: '整理冷却时间（毫秒）', onCommit: (next) => setCooldownMs(next),
        })))
    }

    function SettingsTab({ get, write, writable, form, pickDirectory }) {
      const common = { get, write, writable, form, pickDirectory }
      const [sendOpen, setSendOpen] = React.useState(false)
      const [activeOpen, setActiveOpen] = React.useState(false)
      return h('div', { className: 'qqg-stack' },
        h(TabHead, {
          title: '全局设置',
          desc: '改动由 config-editor 写入 profile 配置，桥接每 2 秒轮询，通常 2 秒内生效。',
        }),

        h('div', { id: 'qqg-anchor-split', className: 'qqg-anchor' },
          h(Panel, {
            title: '运行节奏',
            desc: '发送切片与响应时机。点开分别配置。',
            right: h('span', { className: 'qqg-pill' }, '2 组参数'),
          },
          h('div', { className: 'qqg-actions-2' },
            h('button', {
              type: 'button', className: 'qqg-bigbtn',
              onClick: () => setSendOpen(true),
            },
            h('span', { className: 'qqg-bigbtn-icon' }, h(Glyph, { name: 'send', size: 17 })),
            h('span', { className: 'qqg-bigbtn-main' },
              h('span', { className: 'qqg-bigbtn-name' }, '信息发送配置'),
              h('span', { className: 'qqg-bigbtn-desc' },
                `单行阈值 ${get('bubbleMaxChars')} · 合并上限 ${get('mergeMaxChars')} · 打字延时分级`)),
            h('span', { className: 'qqg-bigbtn-arrow' }, h(Glyph, { name: 'chevron', size: 15 }))),
            h('button', {
              type: 'button', className: 'qqg-bigbtn',
              onClick: () => setActiveOpen(true),
            },
            h('span', { className: 'qqg-bigbtn-icon' }, h(Glyph, { name: 'activity', size: 17 })),
            h('span', { className: 'qqg-bigbtn-main' },
              h('span', { className: 'qqg-bigbtn-name' }, '活跃设置'),
              h('span', { className: 'qqg-bigbtn-desc' }, '响应档位 · 防抖合并 · 批次间隔 · 指令禁言')),
            h('span', { className: 'qqg-bigbtn-arrow' }, h(Glyph, { name: 'chevron', size: 15 })))))),

        h(MemoryPanel),

        h('div', { id: 'qqg-anchor-model', className: 'qqg-anchor' }, h(ModelSection, common)),
        h('div', { id: 'qqg-anchor-advanced', className: 'qqg-anchor' }, h(AdvancedSection, common)),
        h('div', { id: 'qqg-anchor-persona', className: 'qqg-anchor' }, h(PersonaSection, common)),
        h('div', { id: 'qqg-anchor-allow', className: 'qqg-anchor' }, h(AllowSection, common)),
        h('div', { id: 'qqg-anchor-onebot', className: 'qqg-anchor' }, h(OneBotSection, common)),
        h('div', { id: 'qqg-anchor-napcat', className: 'qqg-anchor' }, h(NapcatSection, common)),

        h(SendConfigModal, {
          open: sendOpen, get, write, writable, form,
          onClose: () => setSendOpen(false),
        }),
        h(ActiveSettingsModal, {
          open: activeOpen,
          get, write, writable,
          onClose: () => setActiveOpen(false),
        }))
    }

    /* ══════════ Tab 5 · 数据与用量（真实数据）══════════ */
    /**
     * 纯 CSS 柱状图：每根柱子 = 一个 div，高度按数据换算成 px（避免百分比高度在 flex 里失真）。
     * valueOf 取数值（成本可能是 null，按 0 画但标签显示「—」），format 负责显示文案。
     */
    function BarChart({ rows, valueOf, format }) {
      const values = rows.map((row) => Number(valueOf(row)) || 0)
      const max = Math.max(1, ...values)
      const MAX_BAR_PX = 132
      return h('div', { className: 'qqg-chart' },
        rows.map((row) => {
          const value = Number(valueOf(row)) || 0
          const px = Math.max(6, Math.round((value / max) * MAX_BAR_PX))
          const label = format ? format(row) : fmtNum(value)
          return h('div', { key: row.day, className: 'qqg-chart-col', title: `${row.day} · ${label}` },
            h('div', { className: 'qqg-chart-val' }, label),
            h('div', { className: 'qqg-chart-bar', style: { height: px + 'px' } }),
            h('div', { className: 'qqg-chart-day' }, String(row.day).slice(5)))
        }))
    }

    /**
     * 纯 CSS 折线/面积图：
     *   面积 = 一个 div + clip-path polygon（折线点 + 底边闭合）；
     *   折线 = 沿同一组折线点、向下偏移 1.2% 形成的**细带** polygon，
     *          这样不依赖层叠遮挡，放大缩小都不会露出整块实色。
     * 不引任何图表库。
     */
    function AreaChart({ rows, valueKey }) {
      if (rows.length === 0) {
        return h('div', { className: 'qqg-status' }, '最近 7 天还没有用量数据')
      }
      const max = Math.max(...rows.map((row) => row[valueKey]))
      const min = Math.min(...rows.map((row) => row[valueKey]))
      const span = max - min || 1
      const pts = rows.map((row, i) => {
        const x = (i / Math.max(rows.length - 1, 1)) * 100
        const y = 92 - ((row[valueKey] - min) / span) * 76
        return [x, y]
      })
      const areaPoly = ['0% 100%', ...pts.map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`), '100% 100%'].join(', ')
      const linePoly = [
        ...pts.map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`),
        ...pts.slice().reverse().map(([x, y]) => `${x.toFixed(2)}% ${(y + 1.4).toFixed(2)}%`),
      ].join(', ')
      return h('div', { className: 'qqg-area-wrap' },
        h('div', { className: 'qqg-area' },
          h('div', { className: 'qqg-area-fill', style: { clipPath: `polygon(${areaPoly})` } }),
          h('div', { className: 'qqg-area-stroke', style: { clipPath: `polygon(${linePoly})` } }),
          pts.map(([x, y], i) => h('span', {
            key: i, className: 'qqg-area-dot',
            style: { left: x + '%', top: y + '%' },
            title: `${rows[i].day} · ${fmtNum(rows[i][valueKey])}`,
          }))),
        h('div', { className: 'qqg-area-labels' },
          rows.map((row) => h('span', { key: row.day }, String(row.day).slice(5)))))
    }

    function UsageTable({ cols, rows }) {
      return h('div', { className: 'qqg-table-wrap' },
        h('table', { className: 'qqg-table' },
          h('thead', null, h('tr', null,
            cols.map((c) => h('th', { key: c.key, className: c.num ? 'qqg-num' : '' }, c.label)))),
          h('tbody', null, rows.map((r, i) => h('tr', { key: i },
            cols.map((c) => h('td', { key: c.key, className: c.num ? 'qqg-num' : '' },
              c.render ? c.render(r) : r[c.key])))))))
    }

    const shareCell = (r) => {
      const share = Number(r.share)
      const width = Number.isFinite(share) ? Math.max(0, Math.min(share, 100)) : 0
      return h('div', { className: 'qqg-share' },
        h('div', { className: 'qqg-share-track' },
          h('div', { className: 'qqg-share-fill', style: { width: width + '%' } })),
        h('span', { className: 'qqg-muted' }, Number.isFinite(share) ? share + '%' : '—'))
    }

    /** 单价输入：本地 draft + 失焦/回车提交，避免每敲一个字符就写一次 profile 配置。 */
    function PriceInput({ label, value, disabled, onCommit }) {
      const [draft, setDraft] = React.useState(String(value ?? 0))
      React.useEffect(() => { setDraft(String(value ?? 0)) }, [value])
      const commit = () => {
        if (disabled) return
        const n = Number(draft)
        onCommit(Number.isFinite(n) && n >= 0 ? n : 0)
      }
      return h('label', { className: 'qqg-price-field' },
        h('span', { className: 'qqg-price-label' }, label),
        h('input', {
          className: 'qqg-input', type: 'number', min: 0, step: '0.01',
          value: draft, disabled, 'aria-label': label,
          onChange: (e) => setDraft(e.target.value),
          onBlur: commit,
          onKeyDown: (e) => { if (e.key === 'Enter' && e.currentTarget?.blur) e.currentTarget.blur() },
        }))
    }

    /** 两档计费：忙时 / 闲时，各 4 个框。 */
    const PRICE_PERIODS = [
      ['peak', '忙时 Peak'],
      ['offPeak', '闲时 Off-Peak'],
    ]
    const PRICE_FIELDS = [
      ['input', '输入'],
      ['output', '输出'],
      ['cacheRead', '缓存读'],
      ['cacheWrite', '缓存写'],
    ]

    const zeroRateSet = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

    /**
     * 峰谷时段设置：一个时段输入框。
     *
     * 时区不在这里改（默认跟本机 UTC+8，Host 侧配置项仍在），
     * 输入格式与 Host 的 parsePeakHours 同口径，存进 `peakHours`。
     */
    function PeakHoursCard({ get, write, writable }) {
      const configured = String(get('peakHours') ?? '08:30-00:30')
      const timezone = String(get('timezone') ?? 'Asia/Shanghai')
      const onlyWorkdays = get('peakOnlyWorkdays') === true
      const [draft, setDraft] = React.useState(configured)
      const [error, setError] = React.useState('')
      React.useEffect(() => { setDraft(configured); setError('') }, [configured])
      const commit = () => {
        if (!writable) return
        const text = draft.trim()
        if (!isValidPeakHours(text)) {
          setError('格式应为 HH:MM-HH:MM，多段用英文逗号分隔，例如 09:00-12:00, 14:00-18:00')
          return
        }
        setError('')
        if (text !== configured) write('peakHours', text)
      }
      return h(Panel, {
        title: '峰谷时段设置',
        desc: `使用本地时区（${timezoneOffsetLabel(timezone)}，${timezone}）。`
          + '多段用英文逗号分隔，例如 09:00-12:00, 14:00-18:00；跨午夜写 08:30-00:30。',
        right: h('span', { className: 'qqg-pill' + (error ? '' : ' qqg-pill-accent') },
          error ? '格式有误' : '忙时窗口'),
      },
      h('div', { className: 'qqg-peak-row' },
        h('label', { className: 'qqg-field qqg-peak-field' },
          h('span', { className: 'qqg-field-label' }, '忙时时段'),
          h('input', {
            className: 'qqg-input', type: 'text',
            value: draft, disabled: !writable,
            placeholder: '09:00-12:00, 14:00-18:00', 'aria-label': '峰谷时段',
            onChange: (e) => { setDraft(e.target.value); if (error) setError('') },
            onBlur: commit,
            onKeyDown: (e) => { if (e.key === 'Enter' && e.currentTarget?.blur) e.currentTarget.blur() },
          }),
          h('span', { className: 'qqg-field-hint' },
            error || '每段左闭右开；start = end 视为全天忙时。'))),
      h('div', { className: 'qqg-peak-toggle' },
        h(SwitchField, {
          label: '仅在工作日生效',
          hint: '开启后周六 / 周日整天空闲时；节假日与调休读同目录 holidays.json（workdays 优先，其次 holidays）。',
          value: onlyWorkdays,
          disabled: !writable,
          onChange: (next) => { if (writable) write('peakOnlyWorkdays', next === true) },
        })),
      h('div', { className: 'qqg-price-foot' },
        h('span', null, '节假日 / 调休在 holidays.json：workdays = 调休上班日，holidays = 法定节假日。'),
        writable ? null : h('span', null, '当前配置只读，无法保存。')))
    }

    /**
     * 单价配置卡：每一条真实出现过的 provider/model 一块，
     * 忙时 / 闲时各 4 个输入框（输入、输出、缓存读、缓存写），写进 `usagePricing`。
     */
    function PricingCard({ get, write, writable, models, priced }) {
      const rules = Array.isArray(get('usagePricing')) ? get('usagePricing') : []
      const configuredProvider = String(get('model.provider') ?? '')
      const configuredModel = String(get('model.model') ?? '')
      const rows = []
      for (const item of models) {
        if (!item?.provider || !item?.model) continue
        if (rows.some((row) => row.provider === item.provider && row.model === item.model)) continue
        rows.push({ provider: item.provider, model: item.model })
      }
      if (configuredProvider && configuredModel
        && !rows.some((row) => row.provider === configuredProvider && row.model === configuredModel)) {
        rows.unshift({ provider: configuredProvider, model: configuredModel })
      }
      const ruleOf = (provider, model) => rules.find(
        (rule) => String(rule?.provider ?? '') === provider && String(rule?.model ?? '') === model,
      )
      // 旧版扁平结构（升级前已经填过单价的人）读作「peak / offPeak 同价」，
      // 第一次编辑时顺手迁移成嵌套结构，不让已填数字凭空消失。
      // 注意：新 Schema 会把缺失的 peak/offPeak 补成全 0 对象，所以要看「有没有非 0」，
      // 不能只看对象是否存在。
      const flatLegacy = (rule) => ['input', 'output', 'cacheRead', 'cacheWrite']
        .some((field) => Number(rule?.[field]) > 0)
      const pickRates = (source) => ({
        input: Number(source?.input) || 0,
        output: Number(source?.output) || 0,
        cacheRead: Number(source?.cacheRead) || 0,
        cacheWrite: Number(source?.cacheWrite) || 0,
      })
      const ratesSome = (rates) => ['input', 'output', 'cacheRead', 'cacheWrite']
        .some((field) => Number(rates?.[field]) > 0)
      const effectiveRates = (rule, period) => {
        const nested = rule?.[period]
        if (ratesSome(nested)) return pickRates(nested)
        if (flatLegacy(rule)) return pickRates(rule)
        return pickRates(nested)
      }
      const commit = (provider, model, period, field, value) => {
        if (!write) return
        const next = Array.isArray(get('usagePricing')) ? get('usagePricing').map((rule) => ({ ...rule })) : []
        const index = next.findIndex(
          (rule) => String(rule?.provider ?? '') === provider && String(rule?.model ?? '') === model,
        )
        const source = index >= 0 ? next[index] : { provider, model }
        const peak = { ...zeroRateSet(), ...effectiveRates(source, 'peak') }
        const offPeak = { ...zeroRateSet(), ...effectiveRates(source, 'offPeak') }
        const chosen = period === 'peak' ? peak : offPeak
        chosen[field] = value
        const entry = { provider, model, peak, offPeak }
        if (index >= 0) next[index] = entry
        else next.push(entry)
        write('usagePricing', next)
      }
      const rulePriced = (rule) => Boolean(rule)
        && (periodRatesSome(effectiveRates(rule, 'peak')) || periodRatesSome(effectiveRates(rule, 'offPeak')))

      return h(Panel, {
        title: '单价配置',
        desc: '单位：元 / 百万 token（美元请自行换算后填数字）。忙时 / 闲时各一套，四项全为 0 = 未配置，成本列显示「—」。',
        right: h('span', { className: 'qqg-pill' + (priced ? ' qqg-pill-accent' : '') },
          priced ? '已配置' : '未配置'),
      },
      rows.length === 0
        ? h('div', { className: 'qqg-status' },
          '还没有可配的模型：等桥接跑一轮，或先在「全局设置 → 模型」里选一个模型。')
        : h('div', { className: 'qqg-price-list' }, rows.map((item) => {
          const rule = ruleOf(item.provider, item.model)
          return h('div', { className: 'qqg-price-row', key: `${item.provider}/${item.model}` },
            h('div', { className: 'qqg-price-head' },
              h('span', { className: 'qqg-price-model', title: item.model }, item.model),
              h('span', { className: 'qqg-price-provider' }, item.provider),
              h('span', { className: 'qqg-pill' + (rulePriced(rule) ? ' qqg-pill-accent' : '') },
                rulePriced(rule) ? '已配置' : '未配置')),
            h('div', { className: 'qqg-price-periods' }, PRICE_PERIODS.map(([period, periodLabel]) => {
              const rates = effectiveRates(rule, period)
              return h('div', { className: 'qqg-price-period', key: period },
                h('span', { className: 'qqg-price-period-label' }, periodLabel),
                PRICE_FIELDS.map(([field, fieldLabel]) => h(PriceInput, {
                  key: field,
                  label: `${periodLabel}-${fieldLabel}`,
                  value: Number(rates[field] ?? 0),
                  disabled: !writable,
                  onCommit: (value) => commit(item.provider, item.model, period, field, value),
                })))
            })))
        })),
      h('div', { className: 'qqg-price-foot' },
        h('span', null, '输入 = 未命中缓存的 prompt；缓存读 = cacheRead；缓存写 = cacheWrite；输出已含 reasoning。'),
        writable ? null : h('span', null, '当前配置只读，无法保存。')))
    }

    /** 一套费率里是否至少有一个非 0（面板上的「已配置」小标签用）。 */
    function periodRatesSome(rates) {
      if (!rates || typeof rates !== 'object') return false
      return ['input', 'output', 'cacheRead', 'cacheWrite'].some((field) => Number(rates[field]) > 0)
    }

    function UsageTab({ get, write, writable }) {
      const [dim, setDim] = React.useState('calls')
      const usage = useUsage(7)
      const data = usage.data
      const days = Array.isArray(data?.days) ? data.days : []
      const models = Array.isArray(data?.models) ? data.models : []
      const sessions = Array.isArray(data?.sessions) ? data.sessions : []
      const priced = data?.pricing?.configured === true
      const backfill = data?.backfill
      const dimLabel = { calls: '调用次数', tokens: 'Token', cost: '成本' }
      const chartValue = (row) => (dim === 'cost' ? (row.cost ?? 0) : (row[dim] ?? 0))
      const chartLabel = (row) => (dim === 'cost' ? fmtCost(row.cost) : fmtNum(row[dim] ?? 0))
      const hasData = days.some((day) => (day?.calls ?? 0) > 0)
      const statusPill = usage.status === 'error'
        ? h('span', { className: 'qqg-pill qqg-pill-accent' }, '接口异常')
        : h('span', { className: 'qqg-pill' },
          backfill?.running ? '回填中…' : (backfill?.done ? '已回填历史' : '实时统计'))

      return h('div', { className: 'qqg-stack' },
        h(TabHead, {
          title: '数据与用量',
          desc: usage.status === 'error'
            ? `用量接口读不到：${usage.error}`
            : '真实数据来自 Host 的 assistant/message 用量事件；图表与表格每 5 秒刷新。',
          tags: h(React.Fragment, null,
            statusPill,
            h('span', { className: 'qqg-pill' }, '近 7 天')),
        }),
        h(Panel, {
          title: '用量趋势',
          desc: '近 7 天每日用量。柱状图与面积图均为纯 CSS 绘制。',
          right: h('div', { className: 'qqg-actions' },
            ['calls', 'tokens', 'cost'].map((k) => h('button', {
              key: k, type: 'button',
              className: 'qqg-btn' + (dim === k ? ' qqg-btn-primary' : ''),
              disabled: k === 'cost' && !priced,
              title: k === 'cost' && !priced ? '先在下方「单价配置」里填一个非 0 单价' : undefined,
              onClick: () => setDim(k),
            }, dimLabel[k]))),
        },
        h(BarChart, { rows: days, valueOf: chartValue, format: chartLabel }),
        h('div', { className: 'qqg-legend' },
          h('span', { className: 'qqg-legend-item' },
            h('span', { className: 'qqg-legend-swatch' }), dimLabel[dim])),
        hasData ? null : h('div', { className: 'qqg-status' },
          usage.status === 'loading' ? '正在读取用量…' : '最近 7 天还没有用量记录。'),
        h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 14 } },
          h('div', { className: 'qqg-panel-desc' }, 'Token 消耗走势（面积图）'),
          h(AreaChart, { rows: days, valueKey: 'tokens' }))),

        h(PeakHoursCard, { get, write, writable }),
        h(PricingCard, { get, write, writable, models, priced }),

        h('div', { className: 'qqg-cols' },
          h(Panel, { title: '按天统计', desc: '按本地日历天聚合，成功率 = 完成轮次 / 总轮次。' },
            h(UsageTable, {
              cols: [
                { key: 'day', label: '日期', render: (r) => String(r.day).slice(5) },
                { key: 'calls', label: '调用', num: true, render: (r) => fmtNum(r.calls ?? 0) },
                { key: 'input', label: '输入', num: true, render: (r) => fmtNum(r.input ?? 0) },
                { key: 'output', label: '输出', num: true, render: (r) => fmtNum(r.output ?? 0) },
                { key: 'cacheRead', label: '缓存命中', num: true, render: (r) => fmtNum(r.cacheRead ?? 0) },
                { key: 'cost', label: '成本', num: true, render: (r) => fmtCost(r.cost) },
                { key: 'ok', label: '成功率', num: true, render: (r) => (r.ok == null ? '—' : r.ok.toFixed(1) + '%') },
              ],
              rows: days,
            })),
          h(Panel, { title: '按模型统计', desc: '按实际路由归因，备用模型会单独计数。' },
            h(UsageTable, {
              cols: [
                { key: 'name', label: '模型' },
                { key: 'calls', label: '调用', num: true, render: (r) => fmtNum(r.calls ?? 0) },
                { key: 'input', label: '输入', num: true, render: (r) => fmtNum(r.input ?? 0) },
                { key: 'output', label: '输出', num: true, render: (r) => fmtNum(r.output ?? 0) },
                { key: 'cacheRead', label: '缓存命中', num: true, render: (r) => fmtNum(r.cacheRead ?? 0) },
                { key: 'cost', label: '成本', num: true, render: (r) => fmtCost(r.cost) },
                { key: 'share', label: '占比', render: shareCell },
              ],
              rows: models,
            }))),
        h(Panel, { title: '按会话统计', desc: '按 QQ 私聊 / 群聊聚合；重建过的会话会合并到同一个号。' },
          h(UsageTable, {
            cols: [
              { key: 'label', label: '会话' },
              { key: 'kind', label: '类型' },
              { key: 'calls', label: '调用', num: true, render: (r) => fmtNum(r.calls ?? 0) },
              { key: 'tokens', label: 'Token', num: true, render: (r) => fmtNum(r.tokens ?? 0) },
              { key: 'cost', label: '成本', num: true, render: (r) => fmtCost(r.cost) },
              { key: 'share', label: '占比', render: shareCell },
            ],
            rows: sessions,
          })))
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
      const [guideOpen, setGuideOpen] = React.useState(false)
      // 引导按钮上的计数要包含桥接进程的真实状态，所以把轮询提到面板这一层：
      // 弹窗与底部按钮共用同一份 proc，避免两个状态源各算各的。
      const [guideProc, refreshGuideProc] = useBridgeProc(true)

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
      // 引导里的「去配置」：切到全局设置 Tab 并滚到对应卡片。
      const goto = (target) => {
        setActive('settings')
        const id = ANCHORS[target]
        if (!id) return
        // 等 React 把目标 Tab 挂到 DOM 之后再滚，否则拿不到节点。
        window.setTimeout(() => {
          const el = document.getElementById(id)
          if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }, 60)
      }

      // 引导按钮上的「x/3」：与弹窗共用 guideSteps/guideProgress，口径完全一致。
      const guide = guideProgress(guideSteps(get, guideProc))
      // 启动卡的模型兜底：用配置里真实下发的 model（不是假常量）；留空 = 跟随全局默认。
      const launchModel = (() => {
        const provider = String(get('model.provider') ?? '')
        const model = String(get('model.model') ?? '')
        return provider && model ? `${provider}/${model}` : undefined
      })()

      let body
      if (active === 'sessions') body = h(SessionsTab)
      else if (active === 'skills') body = h(SkillsTab, { ...common, pickDirectory: props?.pickDirectory })
      else if (active === 'usage') body = h(UsageTab, common)
      else if (active === 'settings') body = h(SettingsTab, { ...common, pickDirectory: props?.pickDirectory })
      else {
        // 运行状态：既有状态/启停/日志 + 今日用量 + AI 排障助手。
        body = h('div', { className: 'qqg-stack' },
          h(TabHead, {
            title: '运行状态',
            desc: '桥接与 NapCat 的实时状态；启停按钮直接打到 Host 路由。',
            tags: h(React.Fragment, null,
              h('span', { className: 'qqg-pill' }, '每 3 秒刷新'),
              h('span', { className: 'qqg-pill qqg-pill-accent' }, '实时')),
          }),
          h(TodayUsage),
          h(StatusSection, common),
          // NapCat 的状态与启停也放在这一页：和桥接启停挨着，不用再切 Tab。
          h(NapcatProcessSection, common),
          h(AiAssistant))
      }

      return h('div', { className: 'qqg-layout' },
        h('style', null, CSS),
        h('style', null, CSS2),
        h('nav', { className: 'qqg-nav', 'aria-label': 'QQ 桥接控制台导航' },
          h('div', { className: 'qqg-nav-brand' },
            h('span', { className: 'qqg-nav-brand-dot' }),
            h('span', { className: 'qqg-nav-brand-text' }, 'QQ 桥接')),
          // 菜单列表独立滚动；底部引导按钮用 margin-top:auto 沉底，不跟着滚。
          h('div', { className: 'qqg-nav-list' },
            SECTIONS.map((s) => h('button', {
              key: s.id,
              type: 'button',
              className: 'qqg-nav-item' + (active === s.id ? ' qqg-nav-item-on' : ''),
              'aria-current': active === s.id ? 'page' : undefined,
              onClick: () => setActive(s.id),
            },
            h('span', { className: 'qqg-nav-icon' }, h(Glyph, { name: s.icon, size: 15 })),
            h('span', { className: 'qqg-nav-text' }, s.label),
            s.badge ? h('span', { className: 'qqg-nav-badge' }, s.badge) : null))),
          h('div', { className: 'qqg-nav-foot' },
            // 快捷启动卡：模型名由卡内自己从 /config + /models 读真实值；这里只传配置兜底。
            h(LaunchCard, { model: launchModel }),
            h('button', {
              type: 'button', className: 'qqg-nav-guide',
              title: '三步把 QQ 桥接跑通',
              onClick: () => setGuideOpen(true),
            },
            h('span', { className: 'qqg-nav-guide-icon' }, h(Glyph, { name: 'bulb', size: 15 })),
            h('span', { className: 'qqg-nav-guide-text' }, '使用引导'),
            h('span', { className: 'qqg-nav-guide-done' }, `${guide.done}/${guide.total}`)))),
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
        ),
        // 引导弹窗挂在最外层：从任何 Tab 点左下角按钮都能开。
        h(OnboardingModal, {
          open: guideOpen, get, goto,
          proc: guideProc, refreshProc: refreshGuideProc,
          onClose: () => setGuideOpen(false),
        }))
    }

    return {
      // ⚠️ 必须同时声明 `remote.settings`：只写 'remote' 时
      // `ctx.remote.settings` 是 undefined（2026-10-20 实测，官方 ui-settings
      // 自己声明的也是 ["remote", "remote.settings"]）。
      inject: ['slots', 'remote', 'remote.settings'],
      apply(ctx) {
        /**
         * 调起系统原生「选择文件夹」对话框（不经过我们自己的 Host 路由）。
         *
         * 走客户端已装载的 `uiWorkspace.pickDirectory()`（由 profile 的
         * `directory-picker` 行提供，native 后端 —— 我们用 client Slots 的
         * `sidebar.workspaces.directoryFlow` 确认过它的 occupant 是 active 的）。
         * 好处：**不需要 Host 端任何新代码**，改完 F5 就能用；
         * 而 `/dsh-qq-guard/pick-dir` 那条自定义路由要重启 DSH 才会注册，只作兜底。
         *
         * uiWorkspace 是可选服务（`ctx.get` 拿，不做硬 inject），
         * 所以这里延迟解析，避免插件装载顺序影响。
         */
        const pickDirectoryNative = async () => {
          let ws
          try {
            ws = ctx.get?.('uiWorkspace') ?? ctx.uiWorkspace
          } catch { ws = undefined }
          if (!ws || typeof ws.pickDirectory !== 'function') {
            return { ok: false, reason: 'no-ui-workspace' }
          }
          try {
            const path = await ws.pickDirectory()
            return { ok: true, path: path ?? null }
          } catch (error) {
            return { ok: false, reason: 'pick-failed', detail: error?.message ?? String(error) }
          }
        }

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
            inject: () => ({ remoteForm, pickDirectory: pickDirectoryNative }),
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
            inject: () => ({ remoteForm, pickDirectory: pickDirectoryNative }),
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
              inject: () => ({ form, pickDirectory: pickDirectoryNative }),
            }, SettingsPanel)),
            'qq-guard: plugins page card',
          )
        })
      },
    }
  },
})
