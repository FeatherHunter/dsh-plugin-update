#!/usr/bin/env node
/**
 * scripts/panel-layout-probe.mjs —— 弹窗高度让渡契约的量盒子仪器（#93）。
 *
 * 为什么要有它：单测断的是字符串，量不出布局。本仓已经为「布局只能靠眼睛」付过账——
 * #72 的诊断留下「修复前窄屏截图未留存」的证据缺口；横幅 `min-height:3.4em`、版本条
 * `min-height:48px` 这类地板，谁被压、压到多少，只有真跑一次浏览器才知道。
 *
 * 它做的事：用 dist/panel.js 渲染真实面板，给每个用例**注入确定性 max-height**（不依赖真实
 * 85vh，也就与窗口尺寸无关），用系统 Chrome headless 量出盒子，按**关系**断言（不比像素金值）：
 *
 *   1. 非滚动区（抬头 / 档案头 / 横幅 / 版本条 / 页脚）高度 ≥ 自然高度——不许被压；
 *   2. 副行盒完整落在横幅内容盒内——不折列、不越界、不被裁；
 *   3. 窗口矮到连框架都放不下时：整面板可滚、页脚可滚达、章节区不低于下限。
 *
 * 批量面板（`.dsh-upd-batch`，没有 `.dsh-upd-body` 滚动区）只落原始量值、不断言：本契约
 * 不扩到它（属 #90/#91 域），这里留数据是为了证明"确实没动它"。
 *
 * 退出码：断言失败 = 1；找不到 Chrome = 跳过（0）——所以它是可选仪器，不是发布门禁。
 *
 * 用法：
 *   node scripts/panel-layout-probe.mjs                  # 跑断言 + 打表格
 *   node scripts/panel-layout-probe.mjs --json out.json  # 顺带落原始量值（前后对比用）
 *   node scripts/panel-layout-probe.mjs --chrome <路径>  # 指定浏览器（缺省自动找系统 Chrome）
 *   node scripts/panel-layout-probe.mjs --keep           # 留临时 HTML，好手开复核
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')

const args = process.argv.slice(2)
const opt = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const KEEP = args.includes('--keep')
const JSON_OUT = opt('--json')
const CHROME_ARG = opt('--chrome')

/** 章节区下限（em）：与 src/panel.ts 的 `.dsh-upd-overlay … > .dsh-upd-body{min-height}` 同源。 */
const BODY_FLOOR_EM = 8
const BODY_FLOOR_PX = BODY_FLOOR_EM * 14 // em 按面板正文字号 14px 算（行高不进 em）
/** 滚动区（本来就该让高度的区）：不进「非滚动区不被压」的比较。 */
const SCROLL_REGIONS = new Set(['dsh-upd-body'])
/** 可用高 ≤ 此值算「矮窗」：契约要求整面板可滚、页脚可滚达（实测接管点约 512）。 */
const SHORT_MAX_HEIGHT = 500
/** 可用高 ≥ 此值算「够高」：契约要求各区不被压（横幅保内容高）。 */
const TALL_MIN_HEIGHT = 450

const BATCH_TITLES = {
  'dsh-mattpocock-skills-deck': '技能甲板', 'dsh-ilife-pack': '爱生活', 'dsh-plugin-update': '更新系统',
  'dsh-im-companion': 'IM 伴侣', 'dsh-opencode-palette': '调色板', 'dsh-memo': '备忘录', 'dsh-schedule': '作息管家',
}
const BATCH_ROWS = [
  { key: 'dsh-mattpocock-skills-deck', title: '技能甲板', phase: 'ready', targetVersion: '1.7.47', restartRequired: false, error: null, snapshot: null },
  { key: 'dsh-ilife-pack', title: '爱生活', phase: 'installing', targetVersion: '0.3.50', restartRequired: false, error: null, snapshot: null },
  { key: 'dsh-plugin-update', title: '更新系统', phase: 'pending', targetVersion: null, restartRequired: false, error: null, snapshot: null },
  { key: 'dsh-im-companion', title: 'IM 伴侣', phase: 'restart-required', targetVersion: '0.2.1', restartRequired: true, error: null, snapshot: null },
  { key: 'dsh-opencode-palette', title: '调色板', phase: 'failed', targetVersion: '0.4.0', restartRequired: false, error: 'install-failed: EACCES', snapshot: null },
  { key: 'dsh-memo', title: '备忘录', phase: 'current', targetVersion: '0.3.49', restartRequired: false, error: null, snapshot: null },
  { key: 'dsh-schedule', title: '作息管家', phase: 'done', targetVersion: '0.3.50', restartRequired: false, error: null, snapshot: null },
]

const CASES = [
  { name: 'archive-natural', theme: 'archive', maxHeight: 6000 },
  { name: 'archive-900', theme: 'archive', maxHeight: 900 },
  { name: 'archive-700', theme: 'archive', maxHeight: 700 },
  { name: 'archive-500', theme: 'archive', maxHeight: 500 },
  { name: 'archive-450', theme: 'archive', maxHeight: 450 },
  { name: 'archive-380', theme: 'archive', maxHeight: 380 },
  { name: 'default-natural', theme: 'default', maxHeight: 6000 },
  { name: 'default-900', theme: 'default', maxHeight: 900 },
  { name: 'default-450', theme: 'default', maxHeight: 450 },
  { name: 'batch-natural', kind: 'batch', maxHeight: 6000, record: true },
  { name: 'batch-500', kind: 'batch', maxHeight: 500, record: true },
  { name: 'batch-expanded-500', kind: 'batch', maxHeight: 500, record: true, expandedKey: 'dsh-mattpocock-skills-deck' },
]

function findChrome() {
  if (CHROME_ARG) return existsSync(CHROME_ARG) ? CHROME_ARG : null
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  for (const c of candidates) if (c && existsSync(c)) return c
  return null
}

const MEASURE = `<script>
(function () {
  function run() {
    var out = [];
    var wraps = document.querySelectorAll('.probe-case');
    for (var i = 0; i < wraps.length; i++) {
      var w = wraps[i];
      var panel = w.querySelector('.dsh-upd');
      var banner = w.querySelector('.dsh-upd-banner');
      var body = w.querySelector('.dsh-upd-body');
      var footer = w.querySelector('.dsh-upd-footer');
      var kids = banner ? Array.prototype.slice.call(banner.children) : [];
      function R(el) { if (!el) return null; var r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) }; }
      var pr = panel.getBoundingClientRect();
      var regions = {};
      Array.prototype.slice.call(panel.children).forEach(function (c) {
        var key = String(c.className).split(' ')[0] || c.tagName.toLowerCase();
        regions[key] = Math.round(c.getBoundingClientRect().height);
      });
      var cr = banner ? banner.getBoundingClientRect() : null;
      var cs = banner ? getComputedStyle(banner) : null;
      var contentRight = cr ? cr.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) : null;
      var ar = kids[1] ? kids[1].getBoundingClientRect() : null;
      var fr = footer ? footer.getBoundingClientRect() : null;
      out.push({
        name: w.getAttribute('data-case'),
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        panelH: Math.round(pr.height), panelScrollH: panel.scrollHeight, panelClientH: panel.clientHeight,
        panelOverflowY: getComputedStyle(panel).overflowY,
        outerScroll: panel.scrollHeight > panel.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(panel).overflowY),
        bannerH: cr ? Math.round(cr.height) : null,
        bannerWrap: cs ? cs.flexWrap : null,
        bodyH: body ? Math.round(body.getBoundingClientRect().height) : null,
        footerH: fr ? Math.round(fr.height) : null,
        footerReachable: fr ? (fr.bottom - pr.top <= panel.scrollHeight + 0.5) : null,
        actionSameRow: (ar && kids[0]) ? (ar.top < kids[0].getBoundingClientRect().bottom - 1) : null,
        actionCrossR: ar ? (ar.right > contentRight + 0.5) : null,
        actionWrappedColumn: (ar && kids[0]) ? (ar.left >= kids[0].getBoundingClientRect().right - 1) : null,
        regions: regions,
      });
    }
    var pre = document.createElement('pre');
    pre.id = 'probe-metrics';
    pre.textContent = btoa(unescape(encodeURIComponent(JSON.stringify({ viewport: window.innerWidth + 'x' + window.innerHeight, out: out }))));
    document.body.appendChild(pre);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(run, 0);
  else window.addEventListener('load', function () { setTimeout(run, 0); });
})();
</script>`

async function main() {
  const panelMod = await import(new URL('../dist/panel.js', import.meta.url).href).catch(() => null)
  const batchMod = await import(new URL('../dist/panel-batch.js', import.meta.url).href).catch(() => null)
  if (!panelMod || !batchMod) {
    console.error('[panel-layout-probe] 缺 dist/：先跑 npm run build')
    process.exit(1)
  }
  const chrome = findChrome()
  if (!chrome) {
    console.log('[panel-layout-probe] 没找到 Chrome → 跳过（可传 --chrome <路径> 或设 CHROME_PATH）')
    process.exit(0)
  }

  const snapshot = {
    runningVersion: '1.7.46', installedVersion: '1.7.46', latestVersion: '1.7.47',
    canInstall: false, blockedReason: null,
    job: { id: 'j', state: 'installing', targetVersion: '1.7.47', message: null, requestId: 'r' },
  }
  const baseInput = {
    snapshot, manual: null, queue: null, skippedLatest: false, lastError: null,
    mode: 'dialog', showOthers: false, pluginId: 'dsh-mattpocock-skills-deck', copyNotice: null, profileName: 'desktop',
  }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-probe-'))
  let page = ''
  CASES.forEach((c, i) => {
    const id = 'case' + i
    const html = c.kind === 'batch'
      ? batchMod.renderBatchPanelHTML({
          rows: BATCH_ROWS, titles: BATCH_TITLES, loaded: true, theme: c.theme ?? 'default', mode: 'dialog',
          expandedKey: c.expandedKey ?? null,
        }, 'zh')
      : panelMod.renderUpdatePanelHTML({ ...baseInput, theme: c.theme }, 'zh')
    const css = '#' + id + ' .dsh-upd-overlay{position:static;inset:auto;background:transparent}'
      + '#' + id + ' .dsh-upd{max-height:' + c.maxHeight + 'px}'
    page += '<div class="probe-case" id="' + id + '" data-case="' + c.name + '"><style>' + css + '</style>' + html + '</div>\n'
  })
  page = '<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body style="margin:0;background:#111">'
    + page + MEASURE + '</body></html>'
  const file = join(dir, 'probe.html')
  writeFileSync(file, page, 'utf8')

  const url = 'file:///' + file.replace(/\\/g, '/')
  const run = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--user-data-dir=' + join(dir, 'profile'), '--virtual-time-budget=4000', '--dump-dom', url,
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const dom = String(run.stdout ?? '')
  const m = dom.match(/<pre id="probe-metrics">([A-Za-z0-9+/=]+)<\/pre>/)
  if (!m) {
    console.error('[panel-layout-probe] 没量到盒子：Chrome 退出码 ' + run.status + '，stderr 头部：')
    console.error(String(run.stderr ?? '').slice(0, 400))
    process.exit(1)
  }
  const data = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'))
  const byName = new Map(data.out.map((o) => [o.name, o]))
  const natural = { archive: byName.get('archive-natural'), default: byName.get('default-natural') }

  const failures = []
  const check = (cond, msg) => { if (!cond) failures.push(msg) }
  const pad = (s, n) => String(s).padEnd(n)

  console.log('[panel-layout-probe] 视口 ' + data.viewport + '（约束由注入的 max-height 制造，与视口无关）')
  console.log(pad('case', 20) + pad('panelH', 7) + pad('overflowY', 10) + pad('可滚', 6) + pad('bannerH', 8) + pad('bodyH', 6) + pad('footer', 7) + pad('sameRow', 8) + pad('crossR', 7) + 'col2')
  for (const o of data.out) {
    console.log(pad(o.name, 20) + pad(o.panelH, 7) + pad(o.panelOverflowY, 10) + pad(o.outerScroll, 6) + pad(o.bannerH, 8) + pad(o.bodyH, 6) + pad(o.footerReachable, 7)
      + pad(o.actionSameRow, 8) + pad(o.actionCrossR, 7) + String(o.actionWrappedColumn))
  }

  // —— 断言 1/2：单面板（有滚动区的弹窗帧）——
  for (const c of CASES) {
    if (c.record || c.kind === 'batch') continue
    const o = byName.get(c.name)
    const nat = natural[c.theme]
    check(!!o, c.name + '：没量到')
    if (!o || !nat) continue
    if (c.maxHeight >= TALL_MIN_HEIGHT) {
      check(o.bannerH === nat.bannerH, c.name + '：横幅被压（' + o.bannerH + ' ≠ 自然 ' + nat.bannerH + '）')
      check(o.actionCrossR === false, c.name + '：副行越出横幅内容右边界')
      check(o.actionWrappedColumn === false, c.name + '：副行折到了第二列')
      for (const [key, h] of Object.entries(nat.regions)) {
        if (SCROLL_REGIONS.has(key)) continue // 滚动区本来就该让高度，不在"不被压"之列
        check((o.regions[key] ?? 0) >= h - 1, c.name + '：非滚动区 ' + key + ' 被压（' + (o.regions[key] ?? 0) + ' < 自然 ' + h + '）')
      }
    } else {
      check(o.outerScroll === true, c.name + '：窗口矮到框架放不下，整面板必须可滚')
      check(o.footerReachable === true, c.name + '：页脚必须可滚达')
      check(o.bannerH === nat.bannerH, c.name + '：横幅仍被压（' + o.bannerH + ' ≠ 自然 ' + nat.bannerH + '）')
      check((o.bodyH ?? 0) >= Math.round(BODY_FLOOR_PX) - 1, c.name + '：章节区低于下限（' + o.bodyH + ' < ' + Math.round(BODY_FLOOR_PX) + '）')
    }
  }

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(data, null, 1), 'utf8')
    console.log('[panel-layout-probe] 原始量值已落 ' + JSON_OUT)
  }
  if (!KEEP) rmSync(dir, { recursive: true, force: true })
  else console.log('[panel-layout-probe] 临时页留在这里：' + file)

  if (failures.length) {
    console.error('\n[panel-layout-probe] 不通过 ' + failures.length + ' 条：')
    for (const f of failures) console.error('  ✗ ' + f)
    process.exit(1)
  }
  console.log('\n[panel-layout-probe] 全通过：非滚动区不被压、副行不折列不越界、矮窗可滚可达。')
}

main().catch((e) => { console.error('[panel-layout-probe] 内部错误：' + (e && e.stack ? e.stack : e)); process.exit(1) })
