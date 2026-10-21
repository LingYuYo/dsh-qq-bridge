/**
 * 布局几何验证（无图模式）：直接在 headless Chrome 里量 DOM 盒子。
 *
 * 背景：当前模型不支持读图，靠截图验收不可行；改成「把几何数据 dump 成 DOM」再读文本。
 * 验证点：
 *   · 左侧导航底部「使用引导」按钮真的沉底（topping bottom ≈ nav bottom）
 *   · 按钮与上方菜单之间有分割线，且不随菜单区滚动
 *   · 全局设置页顶部没有引导卡片/按钮
 *   · 技能卡片：拖拽手柄、齿轮、垃圾桶都在，且互不重叠
 *   · 弹窗：遮罩铺满视口，弹窗居中
 *
 * 用法：node verify-layout.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = new URL('./preview/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const PROBE = `
<script>
window.addEventListener('load', () => {
  const r = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
      bottom: Math.round(b.bottom), right: Math.round(b.right) }
  }
  const cs = (sel, prop) => {
    const el = document.querySelector(sel)
    return el ? getComputedStyle(el)[prop] : null
  }
  const data = {
    nav: r('.qqg-nav'),
    navList: r('.qqg-nav-list'),
    navFoot: r('.qqg-nav-foot'),
    guide: r('.qqg-nav-guide'),
    guideText: document.querySelector('.qqg-nav-guide-text')?.textContent ?? null,
    footBorderTop: cs('.qqg-nav-foot', 'borderTopWidth'),
    footMarginTop: cs('.qqg-nav-foot', 'marginTop'),
    navOverflow: cs('.qqg-nav', 'overflowY'),
    listOverflow: cs('.qqg-nav-list', 'overflowY'),
    mask: r('.qqg-mask'),
    modal: r('.qqg-modal'),
    modalTitle: document.querySelector('.qqg-modal-title')?.textContent ?? null,
    tiles: [...document.querySelectorAll('.qqg-tile')].length,
    drag: r('.qqg-tile .qqg-drag'),
    gear: r('.qqg-tile .qqg-tile-tools button'),
    trash: r('.qqg-tile .qqg-tile-tools button:last-child'),
    tile: r('.qqg-tile'),
    // NapCat 安装目录那一行：输入框 + 浏览按钮
    dirRow: r('.qqg-dir-row'),
    dirInput: r('.qqg-dir-input'),
    browseBtn: r('.qqg-btn-browse'),
    dirCard: r('.qqg-dir-row') ? (() => {
      let el = document.querySelector('.qqg-dir-row')
      while (el && !el.classList.contains('qqg-group')) el = el.parentElement
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { x: Math.round(b.x), w: Math.round(b.width), right: Math.round(b.right) }
    })() : null,
    content: r('.qqg-content'),
    vw: window.innerWidth, vh: window.innerHeight,
  }
  const pre = document.createElement('pre')
  pre.id = 'probe'
  pre.textContent = 'PROBE:' + JSON.stringify(data)
  document.body.appendChild(pre)
})
</script>
`

function probe(file) {
  const src = readFileSync(join(OUT, file), 'utf8')
  const html = src.replace('</body>', PROBE + '</body>')
  const tmp = join(tmpdir(), 'qqg-probe.html')
  writeFileSync(tmp, html)
  const out = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1440,1000', '--virtual-time-budget=1500',
    '--dump-dom', 'file:///' + tmp.replace(/\\/g, '/'),
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const m = out.match(/PROBE:(\{.*?\})<\/pre>/s)
  if (!m) throw new Error(`${file}：没有拿到 PROBE 数据`)
  return JSON.parse(m[1])
}

let pass = 0
const fail = []
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fail.push(name); console.log(`  ✗ ${name}\n    ${e.message}`) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

/* ── 1. 左侧导航底部按钮 ─────────────────────────────────── */
console.log('左侧导航「使用引导」按钮：')
{
  const d = probe('tab-settings.html')
  check('按钮存在且文案正确', () => {
    assert(d.guide, '找不到 .qqg-nav-guide')
    assert(d.guideText === '使用引导', `文案是「${d.guideText}」`)
  })
  check('按钮沉底（底边贴近导航底部）', () => {
    const gap = d.nav.bottom - d.guide.bottom
    assert(gap >= 0 && gap <= 20, `按钮底边距导航底部 ${gap}px（应在 0~20 之间，说明 margin-top:auto 生效）`)
    // 菜单区与按钮之间必须有明显空隙
    const gapToMenu = d.guide.y - d.navList.bottom
    assert(gapToMenu >= 8, `按钮距菜单区仅 ${gapToMenu}px，没有沉底`)
  })
  check('按钮在底部容器内、且有分割线', () => {
    assert(d.navFoot, '找不到 .qqg-nav-foot')
    const border = parseFloat(d.footBorderTop)
    assert(border > 0, `分割线宽 ${d.footBorderTop}`)
  })
  check('滚动发生在菜单区，按钮不跟着滚', () => {
    assert(d.navOverflow === 'visible' || d.navOverflow === 'hidden',
      `nav overflowY=${d.navOverflow}（应不可滚动）`)
    assert(d.listOverflow === 'auto' || d.listOverflow === 'scroll',
      `nav-list overflowY=${d.listOverflow}（应为 auto）`)
  })
  check('按钮尺寸与菜单项一致', () => {
    assert(d.guide.h >= 24 && d.guide.h <= 44, `按钮高度 ${d.guide.h}px，与菜单项(约30~34px)不符`)
    assert(d.guide.w === d.navList.w || Math.abs(d.guide.w - d.navList.w) <= 2,
      `按钮宽 ${d.guide.w} vs 菜单宽 ${d.navList.w}`)
  })
}

/* ── 2. 全局设置页顶部已无引导卡 ─────────────────────────── */
console.log('\n全局设置页：')
{
  const src = readFileSync(join(OUT, 'tab-settings.html'), 'utf8')
  check('顶部没有引导卡片/按钮', () => {
    const page = src.slice(src.indexOf('<div class="qqg-content"'))
    const head = page.slice(0, page.indexOf('id="qqg-anchor-split"'))
    assert(!head.includes('新手引导'), '仍含「新手引导」')
    assert(!head.includes('使用引导'), '内容区仍含「使用引导」按钮')
    assert(!head.includes('qqg-onboard-row'), '仍含引导行')
  })
}

/* ── 3. 技能卡片工具区 ───────────────────────────────────── */console.log('\n技能卡片：')
{
  const d = probe('tab-skills.html')
  check('卡片工具齐全：拖拽手柄 / 齿轮 / 垃圾桶', () => {
    assert(d.tiles >= 6, `只渲染了 ${d.tiles} 张卡`)
    assert(d.drag, '缺拖拽手柄')
    assert(d.gear, '缺齿轮按钮')
    assert(d.trash, '缺垃圾桶按钮')
  })
  check('手柄与图标不重叠、都在卡片顶部一行', () => {
    assert(d.drag.x < d.gear.x, '手柄应在齿轮左侧')
    assert(d.gear.x < d.trash.x, '齿轮应在垃圾桶左侧')
    assert(d.drag.y >= d.tile.y - 1 && d.gear.bottom <= d.tile.bottom + 1,
      '工具按钮跑出卡片范围')
  })
}

/* ── 5. NapCat 安装目录：输入框 + 浏览按钮不溢出卡片 ────────── */
console.log('\nNapCat 安装目录：')
{
  // 用超长路径专门压测：如果输入框不是 flex:1 + min-width:0，这里必溢出。
  const LONG = 'D:\\' + 'VeryLongFolderName\\'.repeat(12) + 'NapCat.52230.Shell'
  const src = readFileSync(join(OUT, 'tab-settings.html'), 'utf8')
  const patched = src.replace(/value="D:\\NapCat\.52230\.Shell"/, `value="${LONG}"`)
  writeFileSync(join(OUT, '_longpath.html'), patched)
  const longPage = probe('_longpath.html')

  check('长路径下输入框不撑破卡片', () => {
    assert(longPage.dirRow && longPage.dirCard, '找不到目录行/卡片')
    assert(longPage.dirRow.right <= longPage.dirCard.right + 1,
      `目录行右边界 ${longPage.dirRow.right} 超出卡片 ${longPage.dirCard.right}`)
    assert(longPage.browseBtn.right <= longPage.dirCard.right + 1,
      `浏览按钮右边界 ${longPage.browseBtn.right} 超出卡片 ${longPage.dirCard.right}`)
  })
  check('输入框自适应剩余宽度（不是固定的 148px）', () => {
    assert(longPage.dirInput, '找不到目录输入框')
    assert(longPage.dirInput.w > 200,
      `输入框宽 ${longPage.dirInput.w}px，仍是被压窄的固定宽`)
    assert(longPage.dirRow.w >= longPage.dirInput.w + longPage.browseBtn.w,
      '输入框 + 按钮宽度超过行宽，说明没 flex:1')
  })
  check('浏览按钮在输入框右侧、单一一行', () => {
    assert(Math.abs(longPage.dirInput.y - longPage.browseBtn.y) <= 8,
      `输入框 y=${longPage.dirInput.y}，按钮 y=${longPage.browseBtn.y}，不在同一行`)
    assert(longPage.browseBtn.x >= longPage.dirInput.right - 1,
      '浏览按钮没有排在输入框右侧')
  })
  check('浏览按钮没有被裁掉', () => {
    assert(longPage.browseBtn.w >= 40 && longPage.browseBtn.h >= 20,
      `按钮尺寸异常 ${longPage.browseBtn.w}x${longPage.browseBtn.h}`)
  })
}

/* ── 4. 弹窗几何 ─────────────────────────────────────────── */
console.log('\n弹窗：')
{
  const d = probe('modal-guide.html')
  check('遮罩铺满视口', () => {
    assert(d.mask, '找不到遮罩')
    assert(Math.abs(d.mask.w - d.vw) <= 2 && Math.abs(d.mask.h - d.vh) <= 2,
      `遮罩 ${d.mask.w}x${d.mask.h}，视口 ${d.vw}x${d.vh}`)
  })
  check('弹窗水平垂直居中', () => {
    const cx = d.modal.x + d.modal.w / 2
    const cy = d.modal.y + d.modal.h / 2
    assert(Math.abs(cx - d.vw / 2) <= 3, `水平中心 ${cx} vs ${d.vw / 2}`)
    assert(Math.abs(cy - d.vh / 2) <= 3, `垂直中心 ${cy} vs ${d.vh / 2}`)
  })
  check('弹窗标题是「使用引导」', () => {
    assert(d.modalTitle === '使用引导', `标题是「${d.modalTitle}」`)
  })
}

console.log(`\n结果：${pass} 通过 / ${fail.length} 失败`)
if (fail.length) process.exit(1)
