#!/usr/bin/env node
/**
 * T0 spike / 通道 B —— 普通 DSH 宿主（临时 DSH_HOME + 临时 profile + 独立端口）
 *                    + 系统 Chrome（--headless=new，裸 CDP，零第三方依赖）
 *
 * throwaway：只负责把「起宿主 → 装集成方 → 开宿主设置面板 → 点更新入口 → 打开更新面板
 *            → 点面板里的入口 → 截图 → 杀干净」这条回路跑通并留原始证据。
 *            T1 会把它重写成正式 harness（判定模型 / 证据协议 / 清理审计都还没做）。
 *
 * 用法：
 *   node selftest/spike/264/channel-b.mjs --run-dir <证据目录> [--plugin dsh-prompt@0.4.40]
 *        [--dsh-cli <path>] [--browser <chrome.exe>] [--workdir <临时根>] [--keep]
 *
 * 产物：<证据目录>/raw/*.json（每步原始命令/stdout/stderr/退出码/耗时）、
 *      <证据目录>/raw/server.*.log、<证据目录>/shots/*.png
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IS_WIN, findPortOwner, killTree, redactUrl, runCommand, sleep, startLongRunning, waitForExit, waitForPortFree } from './lib/proc.mjs';
import { connect } from './lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DSH = 'D:\\DeepseekHarness\\resources\\runtime\\cli\\bin\\dsh.cmd';
const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = 's263';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args['run-dir']) {
  console.error('缺少 --run-dir <证据目录>');
  process.exit(2);
}
const RUN_DIR = path.resolve(args['run-dir']);
const RAW_DIR = path.join(RUN_DIR, 'raw');
const SHOTS_DIR = path.join(RUN_DIR, 'shots');
fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const dshCli = String(args['dsh-cli'] ?? process.env.DSH_CLI ?? DEFAULT_DSH);
const browser = String(args['browser'] ?? process.env.CHROME_PATH ?? DEFAULT_CHROME);
const pluginSpec = String(args['plugin'] ?? 'dsh-prompt@0.4.40');
const workRoot = path.resolve(String(args['workdir'] ?? path.join(os.tmpdir(), 'dsh-t0-264')));
const homeDir = path.join(workRoot, 'home');
const profileDir = path.join(homeDir, 'profiles', PROFILE);
const browserProfile = path.join(workRoot, 'chrome-profile');

const steps = [];
let stepSeq = 0;
const startedAt = new Date().toISOString();
const CONTAMINATING = ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL'];
function childEnv() {
  const env = { ...process.env, DSH_HOME: homeDir };
  for (const key of CONTAMINATING) delete env[key];
  return env;
}

function writeStepsIndex() {
  fs.writeFileSync(path.join(RAW_DIR, 'run-steps.json'), JSON.stringify({ startedAt, runDir: RUN_DIR, workRoot, homeDir, profileName: PROFILE, pluginSpec, dshCli, browser, steps }, null, 2));
}

async function step(name, fn) {
  stepSeq += 1;
  const slug = String(name).replace(/[^\w.-]+/g, '-');
  const file = path.join(RAW_DIR, String(stepSeq).padStart(2, '0') + '-' + slug + '.json');
  const t0 = Date.now();
  const entry = { seq: stepSeq, name, file: path.basename(file), startedAt: new Date().toISOString() };
  try {
    const data = await fn();
    Object.assign(entry, { ok: true, ms: Date.now() - t0, data });
    fs.writeFileSync(file, JSON.stringify(entry, null, 2));
    steps.push(entry);
    writeStepsIndex();
    console.log('[ok] ' + name + ' (' + entry.ms + 'ms)');
    return data;
  } catch (error) {
    Object.assign(entry, { ok: false, ms: Date.now() - t0, error: String(error && error.stack ? error.stack : error) });
    fs.writeFileSync(file, JSON.stringify(entry, null, 2));
    steps.push(entry);
    writeStepsIndex();
    console.error('[FAIL] ' + name + ' -> ' + String(error && error.message ? error.message : error));
    throw error;
  }
}

let server = null;
let serverPort = null;
let browserChild = null;
let cdpPort = null;
let client = null;

async function cleanup() {
  const record = { at: new Date().toISOString(), server: null, browser: null };
  if (client) { try { await client.close(); } catch { /* ignore */ } }
  if (browserChild) {
    killTree(browserChild.pid);
    const exited = await waitForExit(browserChild, 10_000);
    const portFree = cdpPort ? await waitForPortFree(cdpPort, 8_000) : null;
    record.browser = { pid: browserChild.pid, exited, cdpPort, cdpPortFree: portFree };
  }
  if (server) {
    killTree(server.pid);
    const exited = await waitForExit(server, 15_000);
    let free = serverPort ? await waitForPortFree(serverPort, 10_000) : null;
    let owner = null;
    if (serverPort && !free) {
      owner = findPortOwner(serverPort);
      if (owner) { killTree(owner); free = await waitForPortFree(serverPort, 8_000); }
    }
    record.server = { pid: server.pid, port: serverPort, exited, portFree: free, killedPortOwner: owner };
  }
  record.tempKept = Boolean(args.keep);
  fs.writeFileSync(path.join(RAW_DIR, '99-cleanup.json'), JSON.stringify(record, null, 2));
  console.log('[cleanup] ' + JSON.stringify(record));
}

// ---------------- 主流程 ----------------
let exitCode = 0;
try {
  await step('env-probe', async () => ({
    node: process.version,
    platform: process.platform,
    dshCli,
    dshCliExists: fs.existsSync(dshCli),
    browser,
    browserExists: fs.existsSync(browser),
    workRoot,
    homeDir,
    pluginSpec,
    dshVersion: runCommand(dshCli, ['--version'], { timeoutMs: 60_000 }).stdout.trim(),
  }));

  fs.mkdirSync(path.join(homeDir, 'profiles'), { recursive: true });

  // ① 一次性 web profile 骨架（--dump-config 只写配置、不启动）
  await step('seed-web-profile', async () => {
    const result = runCommand(dshCli, ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], { env: childEnv(), timeoutMs: 180_000, cwd: workRoot });
    const pkgPath = path.join(profileDir, 'package.json');
    const exists = fs.existsSync(pkgPath);
    const pkg = exists ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : null;
    const bundles = pkg ? (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || pkg.bundles || [] : [];
    return { result, profileDir, profilePackageExists: exists, bundles, files: fs.existsSync(profileDir) ? fs.readdirSync(profileDir) : [] };
  });

  // ② 装被测集成方（真实 npm registry）
  await step('install-integrator', async () => {
    const result = runCommand(dshCli, ['plugin', '--profile', PROFILE, 'add', pluginSpec], { env: childEnv(), timeoutMs: 600_000, cwd: workRoot });
    const pkgPath = path.join(profileDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || pkg.bundles || [];
    const installedPkgPath = path.join(profileDir, 'node_modules', 'dsh-prompt', 'package.json');
    const installedVersion = fs.existsSync(installedPkgPath) ? JSON.parse(fs.readFileSync(installedPkgPath, 'utf8')).version : null;
    return { result, dependencies: pkg.dependencies, bundles, installedVersion };
  });

  // ③ 起宿主
  const serverInfo = await step('start-server', async () => {
    const outPath = path.join(RAW_DIR, 'server.out.log');
    const errPath = path.join(RAW_DIR, 'server.err.log');
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');
    const child = startLongRunning(dshCli, ['--profile', PROFILE, '--port', '0', '--no-open'], { cwd: workRoot, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    server = child;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); fs.writeSync(outFd, chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); fs.writeSync(errFd, chunk); });
    const pattern = /dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/;
    const deadline = Date.now() + 120_000;
    let url = null;
    while (Date.now() < deadline) {
      const m = pattern.exec(stdout);
      if (m) { url = m[1]; break; }
      if (child.exitCode !== null) throw new Error('宿主提前退出 exit=' + child.exitCode + ' stderr=' + stderr.slice(-1200));
      await sleep(100);
    }
    if (!url) throw new Error('等不到 web URL；stdout=' + stdout.slice(-1200) + ' stderr=' + stderr.slice(-1200));
    serverPort = Number(new URL(url).port);
    let http = null;
    for (let i = 0; i < 80; i += 1) {
      try {
        const res = await fetch(url, { redirect: 'manual' });
        http = { status: res.status, bytes: (await res.text()).length };
        if (res.status < 400) break;
      } catch (e) { http = { error: String(e?.message ?? e) }; }
      await sleep(250);
    }
    fs.writeFileSync(path.join(RAW_DIR, 'host-url.txt'), redactUrl(url) + '\n');
    return { pid: child.pid, port: serverPort, redactedUrl: redactUrl(url), stdoutTail: stdout.slice(-2000), stderrTail: stderr.slice(-2000), http };
  });
  const url = fs.readFileSync(path.join(RAW_DIR, 'host-url.txt'), 'utf8').trim().replace('token=***', 'token=***');
  // 真实 URL 只留在内存（不落盘），写证据前打码
  const realUrl = (() => {
    const out = fs.readFileSync(path.join(RAW_DIR, 'server.out.log'), 'utf8');
    const m = /dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out);
    return m ? m[1] : null;
  })();
  if (!realUrl) throw new Error('拿不到真实访问 URL（server.out.log 里没有 dsh web:）');

  // ④ 起浏览器（临时 user-data-dir + 随机调试端口）
  const browserInfo = await step('launch-browser', async () => {
    fs.rmSync(browserProfile, { recursive: true, force: true });
    fs.mkdirSync(browserProfile, { recursive: true });
    const chromeArgs = [
      '--headless=new',
      '--remote-debugging-port=0',
      '--user-data-dir=' + browserProfile,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-features=Translate,MediaRouter',
      '--window-size=1440,900',
      'about:blank',
    ];
    const child = startLongRunning(browser, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    browserChild = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const portFile = path.join(browserProfile, 'DevToolsActivePort');
    const deadline = Date.now() + 60_000;
    let port = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('浏览器提前退出 exit=' + child.exitCode + '：' + stderr.slice(-1200));
      try {
        const lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/).filter(Boolean);
        const candidate = Number(lines[0]);
        if (Number.isFinite(candidate) && candidate > 0) { port = candidate; break; }
      } catch { /* 还没写 */ }
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
      if (m) { port = Number(m[1]); break; }
      await sleep(100);
    }
    if (!port) throw new Error('浏览器没写出 DevToolsActivePort：' + portFile);
    cdpPort = port;
    const version = await fetch('http://127.0.0.1:' + port + '/json/version').then((r) => r.json()).catch(() => null);
    return { pid: child.pid, cdpPort: port, version: version ? { Browser: version.Browser, protocol: version['Protocol-Version'] } : null, userDataDir: browserProfile };
  });

  // ⑤ 连页面 + 收启动遮罩 + 等插件入口
  const pageInfo = await step('attach-and-prepare-page', async () => {
    const c = await connect({ cdpPort });
    client = c;
    await c.navigate(realUrl, { timeoutMs: 90_000 });
    await c.waitFor('document.querySelector("[data-dsh-prompt-entry]") !== null', { timeoutMs: 60_000, label: '插件入口 [data-dsh-prompt-entry]' });
    await sleep(800);
    const gateRounds = [];
    for (let round = 0; round < 6; round += 1) {
      const state = await c.evaluate(`(() => {
        const vw = window.innerWidth, vh = window.innerHeight;
        let inert = 0;
        for (const el of Array.from(document.querySelectorAll('[inert]'))) { el.removeAttribute('inert'); inert += 1; }
        const root = document.getElementById('root');
        if (root && root.getAttribute('aria-hidden') === 'true') { root.removeAttribute('aria-hidden'); inert += 1; }
        const gate = Array.from(document.body.children).find((el) => {
          if (!(el instanceof HTMLElement) || el.tagName !== 'DIV') return false;
          const st = getComputedStyle(el);
          if (st.position !== 'fixed' || st.display === 'none') return false;
          const z = Number.parseInt(st.zIndex, 10);
          if (!Number.isFinite(z) || z < 100) return false;
          const r = el.getBoundingClientRect();
          return r.width >= vw * 0.9 && r.height >= vh * 0.9;
        });
        if (!gate) return { gate: false, inert, text: '' };
        const text = String(gate.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const button = Array.from(gate.querySelectorAll('button,[role=button]')).find((b) => /继续|开始使用|Start|Continue|稍后|跳过|Skip|Close|关闭/i.test(String(b.innerText || '')));
        if (button) {
          const r = button.getBoundingClientRect();
          return { gate: true, inert, text, action: 'click', label: String(button.innerText || '').trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        gate.style.display = 'none';
        return { gate: true, inert, text, action: 'hide' };
      })()`);
      gateRounds.push(state);
      if (!state || (!state.gate && !state.inert)) break;
      if (state.action === 'click') { await c.click(state.x, state.y); await sleep(700); }
      else await sleep(250);
    }
    const facts = await c.evaluate(`(() => ({
      title: document.title,
      lang: document.documentElement.lang,
      href: location.href.split('?')[0],
      entryCount: document.querySelectorAll('[data-dsh-prompt-entry]').length,
      composerCount: document.querySelectorAll('[contenteditable="true"]').length,
      bodyText: String(document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
    }))()`);
    await c.screenshot(path.join(SHOTS_DIR, 'b0-host-loaded.png'));
    return { gateRounds, facts };
  });

  // ⑥ 打开集成方面板 → 底栏设置入口
  const panelInfo = await step('open-prompt-panel', async () => {
    const c = client;
    const rect = await c.getRect('[data-dsh-prompt-entry]');
    await c.mouseMove(1, 1);
    await c.mouseMove(rect.cx, rect.cy);
    await c.waitFor('document.querySelector("[data-dsh-prompt-panel-root]") !== null', { timeoutMs: 15_000, label: '悬停后集成方面板打开' });
    await sleep(400);
    const barButtons = await c.evaluate(`(() => Array.from(document.querySelectorAll('[data-dsh-prompt-panel-root] button')).map((b) => ({
      text: String(b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      title: String(b.getAttribute('title') || '').slice(0, 80),
      aria: String(b.getAttribute('aria-label') || '').slice(0, 80),
      action: String(b.getAttribute('data-action') || ''),
      inBar: Boolean(b.closest('[data-dsh-prompt-bar]')),
    })).filter((b) => b.text || b.title || b.aria))()`);
    await c.screenshot(path.join(SHOTS_DIR, 'b1-prompt-panel.png'));
    const target = barButtons.find((b) => /设置|Settings/i.test(b.title) || /设置|Settings/i.test(b.aria) || /设置|Settings/i.test(b.text));
    if (!target) throw new Error('底栏没有设置按钮；候选=' + JSON.stringify(barButtons).slice(0, 1200));
    const clicked = await c.evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('[data-dsh-prompt-panel-root] button'));
      const b = buttons.find((x) => /设置|Settings/i.test(String(x.getAttribute('title') || '') + ' ' + String(x.getAttribute('aria-label') || '') + ' ' + String(x.innerText || '')));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, title: b.getAttribute('title'), text: String(b.innerText || '').trim() };
    })()`);
    await c.click(clicked.x, clicked.y);
    return { barButtons, clicked };
  });

  // ⑦ 等宿主设置面板里出现更新入口并点击
  const updateEntryInfo = await step('open-update-panel', async () => {
    const c = client;
    await c.waitFor('document.querySelector("[data-dsh-prompt-update-entry]") !== null', { timeoutMs: 30_000, label: '设置页里的更新入口 [data-dsh-prompt-update-entry]' });
    await sleep(600);
    const entryFacts = await c.evaluate(`(() => {
      const host = document.querySelector('[data-dsh-prompt-update-entry]');
      const r = host.getBoundingClientRect();
      return {
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        innerText: String(host.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
        buttons: Array.from(host.querySelectorAll('button')).map((b) => ({ text: String(b.innerText || '').trim().slice(0, 40), action: b.getAttribute('data-action') })),
        settingsSectionText: String((document.querySelector('[data-dsh-prompt-update-entry]')?.closest('section,div[role]') || document.body).innerText || '').replace(/\s+/g, ' ').slice(0, 300),
      };
    })()`);
    // 头行入口常常先被滚出设置页可视区：先 scrollIntoView 再取坐标，否则点击落在视口外。
    await c.evaluate("(() => { const el = document.querySelector('[data-dsh-prompt-update-entry]'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' }); return true; })()");
    await sleep(500);
    const r = await c.evaluate("(() => { const el = document.querySelector('[data-dsh-prompt-update-entry]'); const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, vw: innerWidth, vh: innerHeight }; })()");
    await c.screenshot(path.join(SHOTS_DIR, 'b2-settings-with-update-entry.png'));
    if (!(r.width > 0 && r.height > 0)) throw new Error('更新入口没有尺寸：' + JSON.stringify({ entryFacts, r }));
    if (r.x < 0 || r.y < 0 || r.x + r.width > r.vw || r.y + r.height > r.vh) throw new Error('更新入口不在视口内：' + JSON.stringify({ entryFacts, r }));
    await c.click(r.x + r.width / 2, r.y + r.height / 2);
    await c.waitFor("document.querySelector('.dsh-upd[data-mode=dialog]') !== null", { timeoutMs: 30_000, label: '更新面板 dialog' });
    await sleep(500);
    const panelFacts = await c.evaluate(`(() => {
      const root = document.querySelector('.dsh-upd[data-mode="dialog"]');
      const rect = root.getBoundingClientRect();
      return {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        plugin: root.getAttribute('data-plugin'),
        theme: root.getAttribute('data-theme'),
        text: String(root.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
        actions: Array.from(root.querySelectorAll('button[data-action]')).map((b) => ({ action: b.getAttribute('data-action'), text: String(b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40), disabled: b.disabled })),
      };
    })()`);
    await c.screenshot(path.join(SHOTS_DIR, 'b3-update-panel.png'));
    const clip = panelFacts.rect;
    await c.screenshot(path.join(SHOTS_DIR, 'b3-update-panel-crop.png'), { x: Math.max(0, clip.x), y: Math.max(0, clip.y), width: Math.min(clip.width, 1440), height: Math.min(clip.height, 900) });
    return { entryFacts, panelFacts };
  });

  // ⑧ 点一个面板内入口 + 截图
  const clickInfo = await step('click-panel-entry', async () => {
    const c = client;
    const pickScript = `(() => {
      const root = document.querySelector('.dsh-upd[data-mode="dialog"]');
      if (!root) return { action: null, missing: true };
      const primary = ['check', 'install', 'toggle-changelog', 'copy-manual', 'restart-hint', 'skip'];
      const order = window.__s263PickFallback ? primary.concat(['copy-diag', 'close-view']) : primary;
      const buttons = Array.from(root.querySelectorAll('button[data-action]'));
      for (const action of order) {
        const b = buttons.find((x) => x.getAttribute('data-action') === action && !x.disabled);
        if (b) {
          const r = b.getBoundingClientRect();
          return { action, text: String(b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40), title: String(b.getAttribute('title') || '').slice(0, 100), x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return { action: null, available: buttons.map((b) => ({ a: b.getAttribute('data-action'), disabled: b.disabled, text: String(b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30) })) };
    })()`;
    // 面板挂载即自查：check 在查询期间 disable（文案「正在查询版本信息…」），要点得等它转完。
    // 前 60 次（约 18s）只认「真动作」按钮，等自动自查转完；之后才允许退到复制诊断。
    await c.evaluate('window.__s263PickFallback = false, true');
    let pick = await c.evaluate(pickScript);
    const waitLog = [];
    for (let attempt = 0; !pick.action && attempt < 120; attempt += 1) {
      if (attempt === 60) await c.evaluate('window.__s263PickFallback = true, true');
      if (attempt % 10 === 9) waitLog.push({ attempt, pick });
      await sleep(300);
      pick = await c.evaluate(pickScript);
    }
    if (!pick.action) throw new Error('面板里没有可点的入口：' + JSON.stringify({ pick, waitLog }));
    if (!pick.action) throw new Error('面板里没有可点的入口：' + JSON.stringify(pick));
    const before = await c.evaluate("document.querySelector('.dsh-upd[data-mode=dialog]').innerText.replace(/\s+/g,' ').slice(0,300)");
    await c.click(pick.x, pick.y);
    await sleep(150);
    // 点击后的瞬态：check 会立刻转成「正在查询版本信息…」并 disable —— 这一拍是「点击确实生效」的强证据。
    const immediate = await c.evaluate("(() => { const root = document.querySelector('.dsh-upd[data-mode=dialog]'); if (!root) return null; const b = root.querySelector('button[data-action=check]'); return { checkText: b ? String(b.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : null, checkDisabled: b ? b.disabled : null }; })()");
    await sleep(1200);
    const after = await c.evaluate(`(() => {
      const root = document.querySelector('.dsh-upd[data-mode="dialog"]');
      if (!root) return { present: false };
      return {
        present: true,
        text: String(root.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
        actions: Array.from(root.querySelectorAll('button[data-action]')).map((b) => ({ action: b.getAttribute('data-action'), disabled: b.disabled, busy: b.getAttribute('aria-busy') })),
      };
    })()`);
    await c.screenshot(path.join(SHOTS_DIR, 'b4-after-panel-click.png'));
    return { pick, immediate, before, after, changed: JSON.stringify(before) !== JSON.stringify(after.text) };
  });

  await step('page-error-collector', async () => ({ note: '本 spike 未装 Runtime.exceptionThrown 收集器（T1 补），页面错误看 shots 与 raw 文本' }));
} catch (error) {
  exitCode = 1;
  console.error('[fatal] ' + String(error && error.message ? error.message : error));
  if (client) {
    try {
      const shot = path.join(SHOTS_DIR, 'fail-final.png');
      await client.screenshot(shot);
      const dump = await client.evaluate('({ href: location.href.split("?")[0], bodyText: String(document.body.innerText || "").replace(/\s+/g," ").slice(0, 800), buttons: Array.from(document.querySelectorAll("button")).map((b) => ({ t: String(b.innerText || "").trim().slice(0,30), a: b.getAttribute("data-action"), title: String(b.getAttribute("title")||"").slice(0,60) })).slice(0, 60) })');
      fs.writeFileSync(path.join(RAW_DIR, 'zz-failure-dom-dump.json'), JSON.stringify(dump, null, 2));
    } catch (e) { console.error('[fatal] 失败现场采集也失败：' + String(e && e.message ? e.message : e)); }
  }
} finally {
  await cleanup();
}

fs.writeFileSync(path.join(RAW_DIR, '98-result.json'), JSON.stringify({ exitCode, steps: steps.map((s) => ({ seq: s.seq, name: s.name, ok: s.ok, ms: s.ms, error: s.error ? String(s.error).split(String.fromCharCode(10))[0] : null, file: s.file })) }, null, 2));
console.log('RESULT: ' + (exitCode === 0 ? 'OK' : 'FAIL') + ' 证据目录=' + RUN_DIR);
process.exit(exitCode);
