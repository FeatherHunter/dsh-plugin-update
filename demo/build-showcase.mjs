/**
 * demo/build-showcase.mjs —— 生成离线体验页 demo/showcase.html
 *
 * 为什么这样做（第一性）：
 *  - UI 验收必须跑**产品真代码**：这里把 src/panel.ts 原样打包进页面，不重画一份 demo UI。
 *  - 只有两个接缝造假，且假件诚实：① registry 数据（固定 JSON）；② 装包执行器（定时推进状态）。
 *    其余（渲染、门控、文案、跳过、排队视图、诊断、脱敏、主题）都是真实现。
 *  - 单文件、离线、双击即开：不依赖任何服务，谁也拦不住你打开它看效果。
 *
 * 跑法：node demo/build-showcase.mjs
 */
import * as esbuild from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

// 打包入口：面板 + 队列视图（canned 宿主用它算出与真宿主同形的 queue 字段）
const entry = `
export { mountUpdatePanel, buildDiagnosticText, renderUpdatePanelHTML } from ${JSON.stringify(resolve(ROOT, 'src/panel.ts'))}
export { visibleQueueFor } from ${JSON.stringify(resolve(ROOT, 'src/queue.ts'))}
export { buildPhoneNames } from ${JSON.stringify(resolve(ROOT, 'src/config.ts'))}
`

const built = await esbuild.build({
  stdin: { contents: entry, resolveDir: ROOT, loader: 'ts', sourcefile: 'showcase-entry.ts' },
  bundle: true,
  format: 'iife',
  globalName: 'UpdPanel',
  platform: 'browser',
  target: 'es2020',
  write: false,
  logLevel: 'warning',
})
const bundle = built.outputFiles[0].text

// 变体：SHOWCASE_THEME=d5|default、SHOWCASE_SCENARIO=<场景键>、SHOWCASE_OUT=<文件名>
const THEME = (process.env.SHOWCASE_THEME || 'default') === 'd5' ? 'd5' : 'default'
const SCENARIO = process.env.SHOWCASE_SCENARIO || 'update'
const OUT = process.env.SHOWCASE_OUT || 'showcase.html'

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>更新面板 · 离线体验页（真组件 + 假数据）</title>
<style>
  body{font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:20px 24px;line-height:1.65;color:#111827;background:#fafaf9}
  h1{font-size:20px;margin:0 0 4px}
  .note{background:#fbf0d0;border:1px solid #e3d9c4;border-radius:6px;padding:8px 12px;font-size:13px;margin:10px 0 18px}
  .wrap{display:grid;grid-template-columns:280px minmax(420px,560px) 1fr;gap:20px;align-items:start}
  .card{border:1px solid #e5e7eb;border-radius:8px;background:#fff;padding:12px}
  .scn{display:block;width:100%;text-align:left;margin:4px 0;padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer;font:inherit;font-size:13px}
  .scn[aria-pressed="true"]{background:#111827;color:#fff;border-color:#111827}
  .hint{font-size:12px;color:#6b7280;margin:6px 0 2px}
  .tools{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
  .tools button{font:inherit;font-size:13px;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer}
  pre{background:#0f172a;color:#e2e8f0;padding:10px;border-radius:6px;font-size:12px;overflow:auto;max-height:320px;white-space:pre-wrap}
  .slotwrap{border:1px dashed #cbd5e1;border-radius:8px;padding:10px;background:#fff}
  .slotwrap.narrow{max-width:360px}
  .legend{font-size:12px;color:#6b7280}
</style>
</head>
<body>
<h1>更新面板 · 离线体验页</h1>
<div class="note">页面里跑的是<b>产品真代码</b>（src/panel.ts 原样打包）。只有两处是假数据：远端版本（固定 JSON）与装包执行器（定时推进状态，不真装包）。其余——渲染、安装门控、中文文案、跳过、排队视图、诊断复制、脱敏、主题——全是真的。</div>
<div class="wrap">
  <div class="card">
    <div class="hint">选一个场景，右侧面板立刻进入那个状态：</div>
    <div id="scenarios"></div>
  </div>
  <div>
    <div class="tools">
      <button id="theme">切 D5 档案卷主题</button>
      <button id="narrow">窄屏（360px）</button>
      <button id="mode">切弹窗形态</button>
      <button id="refresh">重查一次</button>
    </div>
    <div class="slotwrap" id="slotwrap"><div id="slot"></div></div>
    <p class="legend">深色主题跟随你的系统设置（页面不强行模拟）。装包是 6 秒演示执行器：点“装上”后能看到 安装中 → 校验中 → 待重启。</p>
  </div>
  <div class="card">
    <div class="hint">宿主真实回包（面板每次打电话的原文，可对照“复制诊断”内容）：</div>
    <pre id="log">（还没打电话）</pre>
  </div>
</div>
<script>${bundle}</script>
<script>
(function(){
  var P = UpdPanel
  var pluginId = 'demo-notes-plugin'
  var prefix = 'demo'
  var phones = P.buildPhoneNames(prefix)
  var INSTALL_MS = 6000
  var host = null, panel = null, d5 = ${THEME === 'd5' ? 'true' : 'false'}, narrow = false, mode = 'embedded'

  function log(name, args, reply){
    document.getElementById('log').textContent =
      name + '  ← ' + JSON.stringify(args) + '\\n\\n' + JSON.stringify(reply, null, 2)
  }

  function queueView(state, showOthers){
    return P.visibleQueueFor(state, pluginId, showOthers, null)
  }

  // ---- 诚实假件：registry 数据 + 装包执行器；其余全真 ----
  function makeHost(scenario){
    var t0 = Date.now()
    var skipped = scenario === 'skipped'
    var h = {
      latest: scenario === 'latest' ? '1.0.0' : '1.1.0',
      installed: '1.0.0',
      job: scenario === 'restart' ? { id:'job-1', state:'restart-required', targetVersion:'1.1.0', message:null, requestId:'req-1' } : (scenario === 'installfail' ? { id:'job-f', state:'failed', targetVersion:'1.1.0', message:'install-failed: 装完校验没过：磁盘上是 1.0.0，目标是 1.1.0', requestId:'req-f' } : null),
      installedTarget: scenario === 'restart' ? '1.1.0' : '1.0.0',
      startedAt: 0
    }

    function snapshot(){
      var pending = h.job && h.job.state === 'restart-required'
      var canInstall = h.latest !== h.installed && !h.job
      return {
        runningVersion: '1.0.0',
        installedVersion: pending ? '1.1.0' : h.installed,
        latestVersion: h.latest === '1.0.0' ? '1.0.0' : '1.1.0',
        canInstall: canInstall,
        blockedReason: pending ? 'pending-restart' : null,
        job: h.job
      }
    }

    function tick(){
      if(!h.job || h.job.state === 'failed' || h.job.state === 'restart-required') return
      var el = Date.now() - h.startedAt
      if(el > INSTALL_MS){ h.job = { id:h.job.id, state:'restart-required', targetVersion:'1.1.0', message:null, requestId:h.job.requestId }; h.installed = '1.1.0' }
      else if(el > INSTALL_MS/2 && h.job.state === 'installing'){ h.job = Object.assign({}, h.job, { state:'verifying' }) }
    }

    var manual = 'dsh plugin --profile demo add --save-exact demo-notes-plugin@1.1.0 --registry=https://registry.npmjs.org/'
    // 宿主 includeEnv 回的「装到哪个使用范围」：跟场景走，好让人看见范围名真的会变
    // （同一个插件在 web / desktop 各装一份，更新必须落到当前这一份）。
    var env = { profileName: scenario === 'desktopprofile' ? 'desktop' : 'web', environmentKind: 'cli' }

    function fail(error, errorKind, diag){
      return { ok:false, error:error, errorKind:errorKind, diag:diag }
    }

    // 失败类场景要有现成的失败文案（挂载即可见）：与真宿主一样，失败回包带稳定码 + diag。
    var diagRate = { v:1, stage:'fetch-release', route:'registry', method:'https', httpStatus:429,
      latencyMs:412, detail:'远端回 429 限流', targetPackageName:pluginId, runningVersion:'1.0.0',
      environmentKind:'cli', requestId:'req-chk-1', checkId:'chk-1', registryHost:'registry.npmjs.org', action:'retry' }
    var diagName = { v:1, stage:'validate-release', route:'registry', method:'https',
      detail:'清单里的包名与目标包对不上', targetPackageName:pluginId, runningVersion:'1.0.0',
      environmentKind:'cli', registryHost:'registry.npmjs.org', action:'contact' }
    var diagBusy = { v:1, stage:'preflight', route:'queue', method:'fs', latencyMs:7,
      detail:'同一使用范围正在装另一个', targetPackageName:pluginId, runningVersion:'1.0.0',
      environmentKind:'cli', requestId:'req-i', checkId:'chk', registryHost:'registry.npmjs.org', action:'retry' }

    return function call(name, args){
      tick()
      var reply
      if(name === phones.updateStatus){
        // 查状态也照实回失败：这样一挂载就能看见失败长什么样（真宿主：查状态确实会因读不到环境而失败）。
        if(scenario === 'ratelimit') reply = fail('check-failed','check-failed', diagRate)
        else if(scenario === 'badname') reply = fail('invalid-release','invalid-release', diagName)
        else if(scenario === 'busy') reply = fail('update-busy','update-busy', diagBusy)
        else reply = { ok:true, snapshot: snapshot(), manual: manual, receipt:null, env: env }
        if(scenario === 'queued' || scenario === 'queued2'){
          var owner = { pluginId:'demo-tasks-plugin', jobId:'job-x', requestId:'req-x', targetVersion:'1.1.0', startedAt: Date.now() }
          var waiting = [{ pluginId: pluginId, requestId:'req-mine', targetVersion:'1.1.0', enqueuedAt: Date.now() }]
          if(scenario === 'queued2') waiting.unshift({ pluginId:'demo-other-plugin', requestId:'req-o', targetVersion:'1.0.0', enqueuedAt: Date.now() })
          reply.queue = queueView({ version:1, owner:owner, waiting:waiting }, !!(args && args.showOthers))
        }
      } else if(name === phones.updateCheck){
        if(scenario === 'ratelimit'){
          reply = fail('check-failed','check-failed',{ v:1, stage:'fetch-release', route:'registry', method:'https', httpStatus:429,
            latencyMs:412, detail:'远端回 429 限流', targetPackageName:pluginId, runningVersion:'1.0.0',
            environmentKind:'cli', requestId:'req-chk-1', checkId:'chk-1', registryHost:'registry.npmjs.org', action:'retry' })
        } else if(scenario === 'badname'){
          reply = fail('invalid-release','invalid-release',{ v:1, stage:'validate-release', route:'registry', method:'https',
            detail:'清单里的包名与目标包对不上', targetPackageName:pluginId, runningVersion:'1.0.0',
            environmentKind:'cli', registryHost:'registry.npmjs.org', action:'contact' })
        } else {
          reply = { ok:true, snapshot: snapshot(), manual: manual, receipt:{ checkId:'chk-demo', checkedAt: Date.now(), expiresAt: Date.now()+3600000 }, env: env }
        }
      } else if(name === phones.updateInstall){
        if(scenario === 'busy'){
          reply = fail('update-busy','update-busy',{ v:1, stage:'preflight', route:'queue', method:'fs', latencyMs:7,
            detail:'同一使用范围正在装另一个', targetPackageName:pluginId, runningVersion:'1.0.0',
            environmentKind:'cli', requestId:(args&&args.requestId)||'req-i', checkId:(args&&args.checkId)||'chk',
            registryHost:'registry.npmjs.org', action:'retry' })
        } else if(scenario === 'installfail'){
          h.job = { id:'job-f', state:'failed', targetVersion:'1.1.0',
            message:'install-failed: 装完校验没过：磁盘上是 1.0.0，目标是 1.1.0', requestId:(args&&args.requestId)||'req-f' }
          reply = { ok:true, snapshot: snapshot(), manual: manual, receipt:null, env: env }
        } else {
          h.job = { id:'job-1', state:'installing', targetVersion:'1.1.0', message:null, requestId:(args&&args.requestId)||'req-1' }
          h.startedAt = Date.now()
          reply = { ok:true, snapshot: snapshot(), manual: manual, receipt:null, env: env }
        }
      } else {
        reply = fail('unknown-phone','internal', null)
      }
      log(name, args || {}, reply)
      return Promise.resolve(reply)
    }
  }

  var SCENARIOS = [
    ['update', '有新版可装（1.0.0 → 1.1.0）'],
    ['latest', '已是最新（无更新）'],
    ['restart', '新版已装，待重启'],
    ['queued', '别人正在装（我排队）'],
    ['queued2', '排队第 3 位（开“看全量”可见他人）'],
    ['skipped', '这一版已跳过（可恢复）'],
    ['busy', '点安装撞忙（update-busy）'],
    ['ratelimit', '查新版被限流（429，带诊断）'],
    ['badname', '包名对不上（invalid-release）'],
    ['installfail', '装完校验没过（install-failed）'],
    ['desktopprofile', '使用范围是 desktop（不是 web）']
  ]

  var Log = document.getElementById('log')

  function mount(scenario){
    var slot = document.getElementById('slot')
    if(panel) { try{ panel.unmount() }catch(e){} }
    slot.innerHTML = ''
    host = makeHost(scenario)
    panel = P.mountUpdatePanel(slot, {
      pluginId: pluginId,
      prefix: prefix,
      mode: mode,
      pollMs: 800,
      showOthers: false,
      theme: d5 ? 'd5-paper' : 'default',
      hostKind: 'cli',
      call: host
    })
    if(scenario === 'skipped'){ /* 面板本地跳过：点一下按钮即可，也可预置 */ }
  }

  var list = document.getElementById('scenarios')
  SCENARIOS.forEach(function(s){
    var b = document.createElement('button')
    b.className = 'scn'; b.type = 'button'; b.textContent = s[1]
    b.onclick = function(){
      Array.prototype.forEach.call(list.children, function(x){ x.setAttribute('aria-pressed','false') })
      b.setAttribute('aria-pressed','true')
      mount(s[0])
    }
    list.appendChild(b)
  })
  document.getElementById('theme').onclick = function(){ d5 = !d5; if(panel) panel.setTheme(d5 ? 'd5-paper' : 'default') }
  document.getElementById('narrow').onclick = function(){ narrow = !narrow; document.getElementById('slotwrap').className = 'slotwrap' + (narrow ? ' narrow' : '') }
  document.getElementById('mode').onclick = function(){ mode = mode === 'embedded' ? 'dialog' : 'embedded'; if(panel) panel.setMode(mode) }
  document.getElementById('refresh').onclick = function(){ if(panel) panel.refresh() }

  var initial = ${JSON.stringify(SCENARIO)}
  var initialIndex = 0
  SCENARIOS.forEach(function(s, i){ if(s[0] === initial) initialIndex = i })
  list.children[initialIndex].setAttribute('aria-pressed','true')
  mount(SCENARIOS[initialIndex][0])
})();
</script>
</body>
</html>
`

mkdirSync(HERE, { recursive: true })
writeFileSync(resolve(HERE, OUT), html, 'utf8')
console.log('[showcase] 已生成 ' + resolve(HERE, OUT) + '（' + Math.round(html.length / 1024) + ' KB，主题=' + THEME + '，场景=' + SCENARIO + '，离线单文件）')
