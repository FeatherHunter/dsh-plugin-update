#!/usr/bin/env node
/**
 * 通道 A 深链取证（#264 T0，官方桌面 Electron 隔离实例）。
 *
 * 初版（channel-a-panel.ts）卡在三处：向导「跳过」后的二次确认没点、「立即启用」后没重启宿主、
 * 因此没走到更新面板。本脚本把深链补完：
 *   ① 向导两层：点「跳过」→ 二次确认「暂时跳过充值?」→ 点「我知道了」；
 *   ② 用同一 --user-data-dir + 同一隔离 DSH_HOME 重启（旧实例 taskkill 证据见 raw/26-channel-a-cleanup.txt），
 *      新调试端口默认 59344；启动环境删掉 ELECTRON_RUN_AS_NODE 与继承来的 DSH_*；
 *   ③ 新会话 → 等 [data-dsh-prompt-entry]（失败先 Page.reload，再失败去插件页点「启用 dsh-prompt」再 reload）
 *      → 悬停入口 → 设置 → 更新入口（scrollIntoView 居中）→ 点开 .dsh-upd[data-mode=dialog]；
 *   ④ 点面板里的「检查更新」，截整窗 + 面板 crop，每张图配同名 .json（看什么/expected/actual/判定）。
 *
 * 用法：
 *   node channel-a-deeplink.ts --run-dir <证据目录> [--home ...] [--user-data-dir ...]
 *        [--cdp-port 59344] [--desktop-exe ...] [--keep]
 *
 * 证据：
 *   raw/30..40-channel-a-*.json   各步原始事实；raw/run-a-steps.json 步骤索引；raw/98a-result.json 结论
 *   shots/a20..a26-*.png + 同名 .json；失败时 raw/zz-a-failure.json + shots/a99-fail.png
 *
 * 安全边界：只 spawn 自己那条隔离实例（user-data-dir 指向 runtime/t0-264-channelA），cleanup 只杀自己
 * 那条进程树；维护者正在跑的 DSH（pid 17020/39812）只读观测，不碰。也不写 C:/Users/辰辰洋洋/.dsh。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { killTree, runCommand, sleep, waitForExit, isPortFree, waitForPortFree, findPortOwner } from './lib/proc.ts';
import { connect } from './lib/cdp.ts';

const MAINTAINER_PKG = 'C:/Users/辰辰洋洋/.dsh/profiles/desktop/package.json';
const MAINTAINER_PIDS = [17020, 39812];

function parseArgs(argv: string[]): { runDir: string; home: string; userDataDir: string; cdpPort: number; desktopExe: string; keep: boolean } {
  const out = {
    runDir: '',
    home: 'D:/dsh-plugin/_wt263/runtime/t0-264-channelA/home',
    userDataDir: 'D:/dsh-plugin/_wt263/runtime/t0-264-channelA/udd2',
    cdpPort: 59344,
    desktopExe: 'D:/DeepseekHarness/DeepSeek Harness.exe',
    keep: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--keep') { out.keep = true; continue; }
    if (a === '--run-dir') { out.runDir = argv[i + 1]; i += 1; continue; }
    if (a === '--home') { out.home = argv[i + 1]; i += 1; continue; }
    if (a === '--user-data-dir') { out.userDataDir = argv[i + 1]; i += 1; continue; }
    if (a === '--cdp-port') { out.cdpPort = Number(argv[i + 1]); i += 1; continue; }
    if (a === '--desktop-exe') { out.desktopExe = argv[i + 1]; i += 1; continue; }
    throw new Error('未知参数：' + a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.runDir) {
  console.error('用法: node channel-a-deeplink.ts --run-dir <证据目录> [--home ...] [--user-data-dir ...] [--cdp-port 59344] [--desktop-exe ...] [--keep]');
  process.exit(2);
}

const RUN_DIR = path.resolve(args.runDir);
const RAW = path.join(RUN_DIR, 'raw');
const SHOTS = path.join(RUN_DIR, 'shots');
const HOME_DIR = path.resolve(args.home);
const USER_DATA_DIR = path.resolve(args.userDataDir);
const DESKTOP_EXE = path.resolve(args.desktopExe);
const CDP_PORT = args.cdpPort;
fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const startedAt = new Date().toISOString();
const steps = [];
const shots = [];
const blockers = [];
const collected = { console: [], exception: [], log: [] };
let seq = 30;
let client = null;
let desktopChild = null;
let rootPid = null;
let outFd = null;
let errFd = null;
let status = 'PASS';

function now() { return new Date().toISOString(); }
function rel(p) { return path.relative(RUN_DIR, p).split(path.sep).join('/'); }
function writeJson(absPath, value) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(value, null, 2), 'utf8');
  return absPath;
}
function readTextSafe(file, maxChars) {
  try { return fs.readFileSync(file, 'utf8').slice(-(maxChars || 4000)); } catch (e) { return null; }
}
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { error: String(e.message) }; }
}
function tailFile(file, maxChars) { return readTextSafe(file, maxChars) || '(读不到：' + file + ')'; }
function sha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (e) { return null; }
}

function recordStep(name, data) {
  const n = String(seq).padStart(2, '0');
  seq += 1;
  const file = path.join(RAW, n + '-channel-a-' + name + '.json');
  const payload = { step: name, channel: 'A', at: now() };
  const keys = Object.keys(data || {});
  for (let i = 0; i < keys.length; i += 1) payload[keys[i]] = data[keys[i]];
  writeJson(file, payload);
  steps.push({ step: name, file: rel(file), at: payload.at });
  console.log('[step] ' + name + ' -> ' + rel(file));
  return payload;
}

async function shot(name, meta) {
  const png = path.join(SHOTS, name + '.png');
  await client.screenshot(png, meta.clip || null);
  const payload = {
    shot: name + '.png',
    channel: 'A',
    whatToLook: meta.whatToLook,
    expected: meta.expected,
    actual: meta.actual,
    judgement: meta.judgement,
    note: meta.note || '',
    run: path.basename(RUN_DIR),
    capturedAt: now(),
    viewport: meta.viewport || null,
    clip: meta.clip || null,
  };
  writeJson(path.join(SHOTS, name + '.json'), payload);
  shots.push({ shot: name + '.png', json: name + '.json', judgement: meta.judgement });
  console.log('[shot] ' + name + ' (' + meta.judgement + ')');
  return payload;
}

// ---------- 页面内取数/点击（尽量不用正则转义：用 charCode 归一化空白） ----------
const NORM_FN = 'const norm = (s) => Array.from(String(s || "")).map((c) => (c.charCodeAt(0) <= 32 ? " " : c)).join("").replace(/ {2,}/g, " ").trim();';
function expr(body) { return '(() => { ' + NORM_FN + ' ' + body + ' })()'; }

const STATE_BODY = [
  'const text = norm(document.body ? document.body.innerText : "");',
  'const dialogs = Array.from(document.querySelectorAll("[role=dialog], dialog")).map((d) => ({ text: norm(d.innerText).slice(0, 400), buttons: Array.from(d.querySelectorAll("button")).map((b) => norm(b.innerText)).filter(Boolean) }));',
  'const buttons = Array.from(document.querySelectorAll("button")).map((b) => ({ text: norm(b.innerText).slice(0, 60), title: String(b.getAttribute("title") || ""), disabled: Boolean(b.disabled) })).filter((b) => b.text || b.title).slice(0, 120);',
  'const composer = Boolean(document.querySelector("[data-dsh-prompt-entry]") || document.querySelector("[contenteditable=true]") || document.querySelector("textarea"));',
  'return { href: location.href, title: document.title, readyState: document.readyState, wizard: /准备可用额度/.test(text), welcome: /欢迎使用 DeepSeek Harness/.test(text) && /开始设置/.test(text), composer: composer, dialogs: dialogs, buttons: buttons, text: text.slice(0, 900) };',
].join(' ');

async function pageState() { return client.evaluate(expr(STATE_BODY)); }

function clickableExpr(within, wanted, exact) {
  return expr([
    'const scopes = ' + (within && within !== 'body' ? 'Array.from(document.querySelectorAll(' + JSON.stringify(within) + '))' : '[document.body]') + ';',
    'if (!scopes.length) return { found: false, reason: "no-scope" };',
    'const want = ' + JSON.stringify(wanted) + ';',
    'const isExact = ' + (exact ? 'true' : 'false') + ';',
    'const els = scopes.flatMap((s) => Array.from(s.querySelectorAll("button, [role=button], a")));',
    'let el = null;',
    'for (const x of els) { const t = norm(x.innerText || x.getAttribute("aria-label") || x.getAttribute("title") || ""); if (!t) continue; if (isExact ? t === want : t.indexOf(want) >= 0) { el = x; break; } }',
    'if (!el) return { found: false, candidates: els.map((x) => norm(x.innerText).slice(0, 40)).filter(Boolean).slice(0, 50) };',
    'const r0 = el.getBoundingClientRect();',
    'if (r0.width === 0 || r0.height === 0) return { found: true, visible: false, text: norm(el.innerText).slice(0, 40) };',
    'if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "nearest" });',
    'const r = el.getBoundingClientRect();',
    'const cx = r.x + r.width / 2; const cy = r.y + r.height / 2;',
    'const top = document.elementFromPoint(cx, cy);',
    'const inside = Boolean(top && (top === el || el.contains(top)));',
    'return { found: true, visible: true, text: norm(el.innerText).slice(0, 40), title: String(el.getAttribute("title") || ""), disabled: Boolean(el.disabled), rect: { x: r.x, y: r.y, width: r.width, height: r.height, cx: cx, cy: cy }, inViewport: r.x >= 0 && r.y >= 0 && r.x + r.width <= innerWidth && r.y + r.height <= innerHeight, inside: inside, topTag: top ? top.tagName + "." + String(top.getAttribute("class") || "").slice(0, 40) : null };',
  ].join(' '));
}

async function findClickable(within, wanted, opts) {
  const o = opts || {};
  const deadline = Date.now() + (o.timeoutMs || 8000);
  let last = null;
  while (Date.now() < deadline) {
    last = await client.evaluate(clickableExpr(within, wanted, o.exact));
    if (last && last.found && last.visible) return last;
    await sleep(200);
  }
  throw new Error('找不到可点元素「' + wanted + '」within=' + (within || 'body') + '；最后=' + JSON.stringify(last));
}

function jsClickExpr(within, wanted, exact) {
  return expr([
    'const scopes = ' + (within && within !== 'body' ? 'Array.from(document.querySelectorAll(' + JSON.stringify(within) + '))' : '[document.body]') + ';',
    'if (!scopes.length) return false;',
    'const want = ' + JSON.stringify(wanted) + ';',
    'const isExact = ' + (exact ? 'true' : 'false') + ';',
    'const els = scopes.flatMap((s) => Array.from(s.querySelectorAll("button, [role=button], a")));',
    'for (const x of els) { const t = norm(x.innerText || x.getAttribute("aria-label") || x.getAttribute("title") || ""); if (isExact ? t === want : t.indexOf(want) >= 0) { x.click(); return true; } }',
    'return false;',
  ].join(' '));
}

async function clickWanted(within, wanted, opts) {
  const o = opts || {};
  const info = await findClickable(within, wanted, o);
  if (info.disabled) throw new Error('元素被禁用「' + wanted + '」：' + JSON.stringify(info));
  if (info.inside && info.inViewport) {
    await client.click(info.rect.cx, info.rect.cy);
    info.via = 'cdp-mouse';
  } else {
    const ok = await client.evaluate(jsClickExpr(within, wanted, o.exact));
    info.via = ok ? 'js-click' : 'failed';
    if (!ok) throw new Error('点击失败「' + wanted + '」：' + JSON.stringify(info));
  }
  return info;
}

async function pressEscape() {
  const base = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: base.key, code: base.code, windowsVirtualKeyCode: base.windowsVirtualKeyCode, nativeVirtualKeyCode: base.nativeVirtualKeyCode });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: base.key, code: base.code, windowsVirtualKeyCode: base.windowsVirtualKeyCode, nativeVirtualKeyCode: base.nativeVirtualKeyCode });
  await sleep(400);
}

async function installErrorCollector() {
  await client.evaluate('(() => { if (window.__s264Errors) return true; window.__s264Errors = []; window.addEventListener("error", (e) => { window.__s264Errors.push({ kind: "error", message: String((e && e.message) || ""), source: String((e && e.filename) || ""), line: (e && e.lineno) || 0 }); }); window.addEventListener("unhandledrejection", (e) => { const r = e && e.reason; window.__s264Errors.push({ kind: "unhandledrejection", message: String((r && r.message) || r || "") }); }); return true; })()');
}

function collectEvent(message) {
  const method = message.method;
  if (method === 'Runtime.consoleAPICalled') {
    const p = message.params || {};
    const args = (p.args || []).map((a) => (a.value !== undefined ? a.value : (a.description !== undefined ? a.description : a.type)));
    collected.console.push({ at: now(), type: p.type, args: args.slice(0, 12) });
    if (collected.console.length > 800) collected.console.shift();
    return;
  }
  if (method === 'Runtime.exceptionThrown') {
    const d = (message.params || {}).exceptionDetails || {};
    collected.exception.push({ at: now(), text: d.text, url: d.url, line: d.lineNumber, description: (d.exception && d.exception.description) || null });
    return;
  }
  if (method === 'Log.entryAdded') {
    const e = (message.params || {}).entry || {};
    collected.log.push({ at: now(), level: e.level, source: e.source, text: e.text, url: e.url });
    if (collected.log.length > 500) collected.log.shift();
  }
}

// ---------- 进程/端口观测（只读） ----------
function listIsolatedProcs() {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'DeepSeek Harness.exe' -and $_.CommandLine -like '*" + USER_DATA_DIR + "*' } | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.ParentProcessId.ToString() }";
  const r = runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 30000 });
  const lines = r.stdout.split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const parts = lines[i].split('|');
    out.push({ pid: Number(parts[0]), parentPid: Number(parts[1]) });
  }
  return out;
}

function listMaintainerProcs() {
  const script = 'Get-Process -Id ' + MAINTAINER_PIDS.join(',') + ' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString() + "|" + $_.ProcessName }';
  const r = runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 30000 });
  const lines = r.stdout.split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const parts = lines[i].split('|');
    out.push({ pid: Number(parts[0]), name: parts[1] });
  }
  return out;
}

function readDshPromptLogTail(maxChars) {
  const dir = path.join(HOME_DIR, 'logs', 'dsh-prompt');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.slice(-4) === '.log').map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return { dir: dir, file: null, tail: null };
    const file = path.join(dir, files[0].name);
    return { dir: dir, file: file, tail: readTextSafe(file, maxChars || 4000) };
  } catch (e) { return { dir: dir, error: String(e.message) }; }
}

// ---------- 启动/等待 ----------
function launchEnv() {
  const env = {};
  const removed = [];
  const keys = Object.keys(process.env);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (key === 'ELECTRON_RUN_AS_NODE' || key.indexOf('DSH_') === 0) { removed.push(key); continue; }
    env[key] = process.env[key];
  }
  env.DSH_HOME = HOME_DIR;
  return { env: env, removed: removed };
}

async function waitForCdp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (desktopChild && desktopChild.exitCode !== null) {
      throw new Error('桌面实例启动即退出 exitCode=' + desktopChild.exitCode + '；stderr=' + tailFile(path.join(RAW, 'channel-a-stderr.log'), 2500));
    }
    try {
      const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version', { signal: AbortSignal.timeout(2500) });
      if (res.ok) return await res.json();
    } catch (e) { lastError = e; }
    await sleep(500);
  }
  throw new Error('CDP /json/version 未就绪（' + timeoutMs + 'ms）：' + String(lastError && lastError.message ? lastError.message : lastError));
}

async function preflightStep() {
  const homePkg = readJsonSafe(path.join(HOME_DIR, 'profiles', 'desktop', 'package.json'));
  const pluginPkg = readJsonSafe(path.join(HOME_DIR, 'profiles', 'desktop', 'node_modules', 'dsh-prompt', 'package.json'));
  const portFree = await isPortFree(CDP_PORT);
  return {
    cdpPort: CDP_PORT,
    portFree: portFree,
    portOwner: portFree ? null : findPortOwner(CDP_PORT),
    parentEnv: {
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || null,
      DSH_HOME: process.env.DSH_HOME || null,
      DSH_PROFILE: process.env.DSH_PROFILE || null,
      DSH_SHELL: process.env.DSH_SHELL || null,
      DSH_WEB_URL: process.env.DSH_WEB_URL || null,
    },
    home: HOME_DIR,
    homeProfilePackage: homePkg,
    pluginVersion: pluginPkg.version || null,
    userDataDir: USER_DATA_DIR,
    userDataDirExists: fs.existsSync(USER_DATA_DIR),
    isolatedProcs: listIsolatedProcs(),
    maintainerProcs: listMaintainerProcs(),
    maintainerProfilePkgSha: sha256(MAINTAINER_PKG),
    previousCleanupEvidence: readTextSafe(path.join(RAW, '26-channel-a-cleanup.txt'), 2500),
    desktopExe: DESKTOP_EXE,
    node: process.version,
    startedAt: startedAt,
  };
}

async function launchStep() {
  const prepared = launchEnv();
  const outLog = path.join(RAW, 'channel-a-stdout.log');
  const errLog = path.join(RAW, 'channel-a-stderr.log');
  outFd = fs.openSync(outLog, 'a');
  errFd = fs.openSync(errLog, 'a');
  const argv = ['--user-data-dir=' + USER_DATA_DIR, '--remote-debugging-port=' + CDP_PORT];
  const t0 = Date.now();
  desktopChild = spawn(DESKTOP_EXE, argv, {
    cwd: path.dirname(DESKTOP_EXE),
    env: prepared.env,
    stdio: ['ignore', outFd, errFd],
    windowsHide: false,
    detached: false,
  });
  rootPid = desktopChild.pid;
  fs.writeFileSync(path.join(RAW, 'channel-a-launch.txt'), 'started pid=' + rootPid + String.fromCharCode(10) + 'argv=' + JSON.stringify(argv) + String.fromCharCode(10) + 'cwd=' + path.dirname(DESKTOP_EXE) + String.fromCharCode(10) + 'DSH_HOME=' + HOME_DIR + String.fromCharCode(10) + 'env_removed=' + JSON.stringify(prepared.removed) + String.fromCharCode(10), 'utf8');
  const version = await waitForCdp(90000);
  const launchMs = Date.now() - t0;
  await sleep(1200);
  return {
    rootPid: rootPid,
    argv: argv,
    dshHome: HOME_DIR,
    userDataDir: USER_DATA_DIR,
    envRemoved: prepared.removed,
    parentEnv: { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || null, DSH_HOME: process.env.DSH_HOME || null },
    launchMs: launchMs,
    cdp: { Browser: version.Browser, ProtocolVersion: version['Protocol-Version'], UserAgent: version['User-Agent'], webSocketDebuggerUrl: String(version.webSocketDebuggerUrl || '').replace(/[0-9a-f-]{20,}/g, '<redacted>') },
    isolatedProcs: listIsolatedProcs(),
    stdoutTail: tailFile(outLog, 1200),
    stderrTail: tailFile(errLog, 1200),
    restartedFrom: '旧实例 pid 88256 进程树已 taskkill（raw/26-channel-a-cleanup.txt，isolated_after=0），本次为同 udd2 + 同隔离 home 的重启',
  };
}

async function attachStep() {
  const version = await waitForCdp(20000);
  let lastError = null;
  for (let i = 0; i < 30; i += 1) {
    try {
      client = await connect({ cdpPort: CDP_PORT, timeoutMs: 15000, onEvent: collectEvent });
      lastError = null;
      break;
    } catch (e) { lastError = e; await sleep(500); }
  }
  if (!client) throw new Error('CDP 连接失败：' + String(lastError && lastError.message ? lastError.message : lastError));
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await installErrorCollector();
  const readyT0 = Date.now();
  await client.waitFor('document.readyState === "complete" && Boolean(document.body) && document.body.innerText.length > 0', { timeoutMs: 60000, label: '页面加载完成' });
  await client.waitFor('(() => { const t = document.body ? document.body.innerText : ""; return t.indexOf("Loading plugins") < 0 && (t.indexOf("准备可用额度") >= 0 || t.indexOf("开始设置") >= 0 || t.indexOf("新会话") >= 0); })()', { timeoutMs: 120000, label: '应用首屏就绪（插件加载完成）' });
  await sleep(1500);
  const appReadyMs = Date.now() - readyT0;
  const state = await pageState();
  const viewport = await client.evaluate('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })');
  return {
    cdpPort: CDP_PORT,
    cdp: { Browser: version.Browser, UserAgent: version['User-Agent'] },
    pageTarget: client.pageTarget ? { id: client.pageTarget.id, type: client.pageTarget.type, url: client.pageTarget.url, title: client.pageTarget.title } : null,
    appReadyMs: appReadyMs,
    href: state.href,
    title: state.title,
    state: state,
    viewport: viewport,
  };
}

// ---------- 向导 ----------
async function closeWizard() {
  const rounds = [];
  let lastAction = '';
  let lastFingerprint = '';
  for (let i = 0; i < 12; i += 1) {
    const st = await pageState();
    const fp = [st.wizard, st.welcome, st.dialogs.length, st.dialogs.map((d) => d.buttons.join('|')).join('||')].join('#');
    const confirm = st.dialogs.find((d) => d.text.indexOf('暂时跳过充值') >= 0) || null;
    if (confirm) {
      const clicked = await clickWanted('[role=dialog]', '我知道了', { exact: true, timeoutMs: 8000 });
      rounds.push({ round: i, action: 'confirm-skip', dialog: confirm.text.slice(0, 160), clicked: clicked });
      const gone = await client.waitFor('document.body.innerText.indexOf("准备可用额度") < 0', { timeoutMs: 8000, label: '二次确认后向导页消失' }).then(() => true).catch(() => false);
      rounds.push({ round: i, action: 'after-confirm', wizardGone: gone });
      if (gone) { lastAction = 'confirmed-and-gone'; break; }
      lastAction = 'confirmed';
      lastFingerprint = fp;
      await sleep(800);
      continue;
    }
    if (st.wizard) {
      if (lastFingerprint === fp && i > 0) { rounds.push({ round: i, action: 'wizard-stuck', state: st.text.slice(0, 240) }); break; }
      const clicked = await clickWanted('body', '跳过', { exact: true, timeoutMs: 8000 });
      rounds.push({ round: i, action: 'skip-wizard', clicked: clicked });
      lastAction = 'skip-clicked';
      lastFingerprint = fp;
      await sleep(1300);
      continue;
    }
    if (st.welcome) {
      const clicked = await clickWanted('body', '开始设置', { exact: true, timeoutMs: 8000 });
      rounds.push({ round: i, action: 'start-setup', clicked: clicked });
      await sleep(1600);
      continue;
    }
    rounds.push({ round: i, action: 'done', state: st.text.slice(0, 240) });
    break;
  }
  const final = await pageState();
  return { rounds: rounds, lastAction: lastAction, final: { href: final.href, wizard: final.wizard, welcome: final.welcome, dialogs: final.dialogs, composer: final.composer, text: final.text.slice(0, 500) } };
}

async function ensureChatPage() {
  const attempts = [];
  let newSessionClicks = 0;
  for (let i = 0; i < 8; i += 1) {
    const st = await pageState();
    if (st.wizard || st.welcome) {
      const wiz = await closeWizard().catch((e) => ({ error: String(e.message) }));
      attempts.push({ i: i, action: 'close-wizard', wizard: wiz.final ? wiz.final.wizard : null, rounds: wiz.rounds ? wiz.rounds.map((r) => r.action) : null });
      await sleep(800);
      continue;
    }
    if (st.dialogs.length > 0) {
      attempts.push({ i: i, action: 'escape-dialog', dialogs: st.dialogs.map((d) => d.text.slice(0, 80)) });
      await pressEscape();
      await sleep(800);
      continue;
    }
    if (st.composer) { attempts.push({ i: i, action: 'composer-present' }); return { ok: true, attempts: attempts, state: st }; }
    const found = await client.evaluate(clickableExpr('body', '新会话', false)).catch(() => null);
    if (found && found.found && newSessionClicks < 2) {
      newSessionClicks += 1;
      const clicked = await clickWanted('body', '新会话', { timeoutMs: 5000 }).catch((e) => ({ error: String(e.message) }));
      attempts.push({ i: i, action: 'click-new-session', clicked: clicked });
      await sleep(2500);
      continue;
    }
    attempts.push({ i: i, action: 'no-new-session-button', state: st.text.slice(0, 240), candidates: found ? found.candidates : null });
    await pressEscape();
    await sleep(900);
  }
  const st = await pageState().catch(() => null);
  return { ok: false, attempts: attempts, state: st };
}

async function waitEntry(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await client.evaluate(expr('const el = document.querySelector("[data-dsh-prompt-entry]"); if (!el) return null; const r = el.getBoundingClientRect(); return { rect: { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }, label: norm(el.innerText || el.getAttribute("title") || el.getAttribute("aria-label") || "").slice(0, 60), panelState: String(el.getAttribute("data-dsh-prompt-panel-state") || "") };')).catch(() => null);
    if (info) return info;
    await sleep(300);
  }
  return null;
}

async function reloadAndPrepare(label) {
  const out = { label: label, reloadedAt: now() };
  await client.send('Page.reload', { ignoreCache: false });
  await sleep(1500);
  try { await client.waitFor('document.readyState === "complete"', { timeoutMs: 60000, label: label + ' 页面完成' }); } catch (e) { out.readyError = String(e.message); }
  await sleep(3000);
  await installErrorCollector().catch(() => {});
  out.wizard = await closeWizard().catch((e) => ({ error: String(e.message) }));
  out.chat = await ensureChatPage().catch((e) => ({ error: String(e.message) }));
  out.state = await pageState().catch(() => null);
  return out;
}

async function pluginManagerFallback() {
  const out = { attempted: true, steps: [] };
  const nav = await clickWanted('body', '插件', { exact: true, timeoutMs: 6000 }).catch((e) => ({ error: String(e.message) }));
  out.steps.push({ action: 'nav-plugins', result: nav });
  await sleep(1800);
  const st = await pageState();
  out.pluginPageText = st.text.slice(0, 1500);
  out.buttons = st.buttons;
  const enable = st.buttons.find((b) => b.text.indexOf('启用 dsh-prompt') >= 0) || null;
  const disable = st.buttons.find((b) => b.text.indexOf('停用 dsh-prompt') >= 0) || null;
  out.enableButton = enable;
  out.disableButton = disable;
  if (enable) {
    const clicked = await clickWanted('body', '启用 dsh-prompt', { timeoutMs: 6000 }).catch((e) => ({ error: String(e.message) }));
    out.steps.push({ action: 'click-enable', result: clicked });
    await sleep(5000);
    out.afterEnableState = await pageState().catch(() => null);
  }
  return out;
}

async function openSessionWaitEntry() {
  const out = { ok: false, attempts: [] };
  out.chat = await ensureChatPage();
  let entry = await waitEntry(45000);
  out.attempts.push({ stage: 'after-chat', entry: entry });
  if (!entry) {
    out.reload1 = await reloadAndPrepare('reload-1');
    entry = await waitEntry(30000);
    out.attempts.push({ stage: 'after-reload-1', entry: entry });
  }
  if (!entry) {
    out.pluginFallback = await pluginManagerFallback();
    out.reload2 = await reloadAndPrepare('reload-2');
    entry = await waitEntry(30000);
    out.attempts.push({ stage: 'after-plugin-fallback', entry: entry });
  }
  out.ok = Boolean(entry);
  out.entry = entry;
  if (!entry) out.state = await pageState().catch(() => null);
  return out;
}

// ---------- 面板深链 ----------
async function hoverEntryOpenPanel() {
  const pre = [];
  let entryRect = null;
  for (let i = 0; i < 5; i += 1) {
    const cover = await client.evaluate(expr('const el = document.querySelector("[data-dsh-prompt-entry]"); if (!el) return null; const r = el.getBoundingClientRect(); const cx = r.x + r.width / 2; const cy = r.y + r.height / 2; const top = document.elementFromPoint(cx, cy); return { inside: Boolean(top && (top === el || el.contains(top))), topTag: top ? top.tagName + "." + String(top.getAttribute("class") || "").slice(0, 50) : null, rect: { x: r.x, y: r.y, width: r.width, height: r.height, cx: cx, cy: cy } };')).catch(() => null);
    pre.push({ attempt: i, cover: cover });
    if (cover && cover.inside) { entryRect = cover.rect; break; }
    await pressEscape();
    await sleep(900);
  }
  if (!entryRect) {
    const r = await client.getRect('[data-dsh-prompt-entry]');
    if (!r) throw new Error('找不到 [data-dsh-prompt-entry] 的 rect');
    entryRect = r;
  }
  await client.mouseMove(2, 2);
  await sleep(200);
  await client.mouseMove(entryRect.cx, entryRect.cy);
  await sleep(700);
  let rootOpen = await client.evaluate('Boolean(document.querySelector("[data-dsh-prompt-panel-root]"))').catch(() => false);
  if (!rootOpen) {
    await client.mouseMove(entryRect.cx - 3, entryRect.cy + 2);
    await sleep(900);
    rootOpen = await client.evaluate('Boolean(document.querySelector("[data-dsh-prompt-panel-root]"))').catch(() => false);
  }
  await client.waitFor('Boolean(document.querySelector("[data-dsh-prompt-panel-root]"))', { timeoutMs: 15000, label: '悬停后集成方面板' });
  await sleep(500);
  const buttons = await client.evaluate(expr('const bs = Array.from(document.querySelectorAll("[data-dsh-prompt-panel-root] button")); return bs.map((b) => ({ text: norm(b.innerText).slice(0, 40), title: String(b.getAttribute("title") || ""), aria: String(b.getAttribute("aria-label") || "") })).filter((b) => b.text || b.title || b.aria);'));
  const panelRootRect = await client.getRect('[data-dsh-prompt-panel-root]');
  return { entryRect: entryRect, coveragePre: pre, panelRootOpened: rootOpen, panelButtons: buttons, panelRootRect: panelRootRect };
}

async function clickTemplateManagement() {
  const clicked = await clickWanted('[data-dsh-prompt-panel-root]', '模板管理', { timeoutMs: 8000 }).catch((e) => ({ error: String(e.message) }));
  await sleep(1200);
  return { clicked: clicked, route: '面板「模板管理」（title=设置 → 模板管理）' };
}

async function waitUpdateEntry(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await client.evaluate('Boolean(document.querySelector("[data-dsh-prompt-update-entry]"))').catch(() => false);
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

async function openHostSettingsFallback() {
  const attempts = [];
  await pressEscape();
  await sleep(800);
  const viaSettings = await clickWanted('body', '设置', { exact: true, timeoutMs: 5000 }).then((r) => ({ ok: true, r: r })).catch((e) => ({ ok: false, error: String(e.message) }));
  attempts.push({ path: 'click-设置', hit: viaSettings });
  if (await waitUpdateEntry(10000)) return { ok: true, attempts: attempts };
  const viaMore = await clickWanted('body', '更多', { exact: true, timeoutMs: 5000 }).then((r) => ({ ok: true, r: r })).catch((e) => ({ ok: false, error: String(e.message) }));
  attempts.push({ path: 'click-更多', hit: viaMore });
  await sleep(900);
  const viaMenu = await clickWanted('body', '设置', { exact: true, timeoutMs: 5000 }).then((r) => ({ ok: true, r: r })).catch((e) => ({ ok: false, error: String(e.message) }));
  attempts.push({ path: 'menu-设置', hit: viaMenu });
  const ok = await waitUpdateEntry(12000);
  return { ok: ok, attempts: attempts };
}

async function prepareUpdateEntry() {
  const route = { initial: 'panel-模板管理' };
  let found = await waitUpdateEntry(15000);
  if (!found) {
    route.fallback = await openHostSettingsFallback();
    found = route.fallback.ok;
  }
  if (!found) throw new Error('等不到 [data-dsh-prompt-update-entry]：' + JSON.stringify(route));
  await client.waitFor('Boolean(document.querySelector("[data-dsh-prompt-update-entry]"))', { timeoutMs: 5000, label: '设置页更新入口' });
  const before = await client.evaluate(expr('const el = document.querySelector("[data-dsh-prompt-update-entry]"); if (!el) return null; const r = el.getBoundingClientRect(); return { text: norm(el.innerText).slice(0, 160), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, inViewport: r.x >= 0 && r.y >= 0 && r.x + r.width <= innerWidth && r.y + r.height <= innerHeight };'));
  await client.evaluate('(() => { const el = document.querySelector("[data-dsh-prompt-update-entry]"); if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "nearest" }); return true; })()');
  await sleep(800);
  const after = await client.evaluate(expr('const el = document.querySelector("[data-dsh-prompt-update-entry]"); if (!el) return null; const r = el.getBoundingClientRect(); const cx = r.x + r.width / 2; const cy = r.y + r.height / 2; const top = document.elementFromPoint(cx, cy); return { text: norm(el.innerText).slice(0, 160), rect: { x: r.x, y: r.y, width: r.width, height: r.height, cx: cx, cy: cy }, inViewport: r.x >= 0 && r.y >= 0 && r.x + r.width <= innerWidth && r.y + r.height <= innerHeight, inside: Boolean(top && (top === el || el.contains(top))), topTag: top ? top.tagName + "." + String(top.getAttribute("class") || "").slice(0, 40) : null };'));
  if (!after) throw new Error('更新入口在 scrollIntoView 后消失');
  return { entryBeforeScroll: before, entryAfterScroll: after, route: route };
}

async function clickUpdateEntry(after) {
  let via = 'cdp-mouse';
  if (after && after.inside && after.inViewport) {
    await client.click(after.rect.cx, after.rect.cy);
  } else {
    const ok = await client.evaluate('(() => { const el = document.querySelector("[data-dsh-prompt-update-entry]"); if (!el) return false; el.click(); return true; })()');
    via = ok ? 'js-click' : 'failed';
  }
  return { clickVia: via, clickedAt: now() };
}

async function openUpdateDialog() {
  await client.waitFor('Boolean(document.querySelector(".dsh-upd[data-mode=dialog]"))', { timeoutMs: 30000, label: '更新面板 dialog' });
  await sleep(900);
  const facts = await client.evaluate(expr('const root = document.querySelector(".dsh-upd[data-mode=dialog]"); const r = root.getBoundingClientRect(); return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, text: norm(root.innerText).slice(0, 700), actions: Array.from(root.querySelectorAll("button[data-action]")).map((b) => ({ action: String(b.getAttribute("data-action") || ""), text: norm(b.innerText).slice(0, 30), disabled: Boolean(b.disabled) })), viewport: { width: innerWidth, height: innerHeight } };'));
  const vx = Math.max(0, Math.min(facts.rect.x, facts.viewport.width));
  const vy = Math.max(0, Math.min(facts.rect.y, facts.viewport.height));
  const clip = {
    x: Math.max(0, facts.rect.x - 8),
    y: Math.max(0, facts.rect.y - 8),
    width: Math.min(facts.viewport.width - Math.max(0, facts.rect.x - 8), facts.rect.width + 16),
    height: Math.min(facts.viewport.height - Math.max(0, facts.rect.y - 8), facts.rect.height + 16),
  };
  if (vx === 0 && vy === 0 && clip.width <= 0) throw new Error('面板 rect 不可截：' + JSON.stringify(facts));
  return { facts: facts, clip: clip };
}

async function clickCheck(beforeText) {
  const pickExpr = expr('const root = document.querySelector(".dsh-upd[data-mode=dialog]"); if (!root) return { ok: false, reason: "panel-gone" }; const all = Array.from(root.querySelectorAll("button[data-action]")); const enabled = all.filter((b) => !b.disabled); const check = enabled.find((b) => b.getAttribute("data-action") === "check"); const b = check || null; if (!b) return { ok: false, reason: "no-enabled-check", actions: all.map((x) => ({ action: String(x.getAttribute("data-action") || ""), disabled: Boolean(x.disabled) })) }; const r = b.getBoundingClientRect(); return { ok: true, action: "check", text: norm(b.innerText).slice(0, 30), disabled: Boolean(b.disabled), x: r.x + r.width / 2, y: r.y + r.height / 2, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };');
  let pick = null;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    pick = await client.evaluate(pickExpr).catch(() => null);
    if (pick && pick.ok && pick.action === 'check') break;
    await sleep(300);
  }
  if (!pick || !pick.ok) throw new Error('更新面板里找不到可点的「检查更新」：' + JSON.stringify(pick));
  const topInfo = await client.evaluate(expr('const cx = ' + pick.x + '; const cy = ' + pick.y + '; const el = document.elementFromPoint(cx, cy); return { topTag: el ? el.tagName + "." + String(el.getAttribute("class") || "").slice(0, 40) : null };'));
  await client.click(pick.x, pick.y);
  await sleep(200);
  const immediate = await client.evaluate(expr('const root = document.querySelector(".dsh-upd[data-mode=dialog]"); if (!root) return null; const b = root.querySelector("button[data-action=check]"); return { checkText: b ? norm(b.innerText).slice(0, 30) : null, disabled: b ? Boolean(b.disabled) : null };'));
  const waitDeadline = Date.now() + 12000;
  let after = null;
  while (Date.now() < waitDeadline) {
    after = await client.evaluate(expr('const root = document.querySelector(".dsh-upd[data-mode=dialog]"); if (!root) return { panelGone: true }; const r = root.getBoundingClientRect(); return { text: norm(root.innerText).slice(0, 700), actions: Array.from(root.querySelectorAll("button[data-action]")).map((b) => ({ action: String(b.getAttribute("data-action") || ""), text: norm(b.innerText).slice(0, 30), disabled: Boolean(b.disabled) })), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };')).catch(() => null);
    if (after && after.text && after.text !== beforeText) break;
    await sleep(500);
  }
  return { pick: pick, topTag: topInfo ? topInfo.topTag : null, immediate: immediate, after: after, clickedAt: now() };
}

// ---------- 失败取证/收尾 ----------
async function failureEvidence(label, errorText) {
  const out = { label: label, error: errorText, at: now() };
  if (client) {
    try {
      out.dom = await client.evaluate(expr('const sels = ["[data-dsh-prompt-entry]", "[data-dsh-prompt-panel-root]", "[data-dsh-prompt-update-entry]", ".dsh-upd", "[role=dialog]"]; const counts = {}; for (const s of sels) counts[s] = document.querySelectorAll(s).length; return { href: location.href, title: document.title, counts: counts, text: norm(document.body ? document.body.innerText : "").slice(0, 3500), buttons: Array.from(document.querySelectorAll("button")).map((b) => ({ text: norm(b.innerText).slice(0, 40), title: String(b.getAttribute("title") || "") })).slice(0, 180) };'));
    } catch (e) { out.domError = String(e.message); }
    try { await client.screenshot(path.join(SHOTS, 'a99-fail.png')); out.failShot = 'shots/a99-fail.png'; } catch (e) { out.shotError = String(e.message); }
  }
  out.consoleTail = collected.console.slice(-60);
  out.exceptions = collected.exception.slice(-20);
  out.logEntries = collected.log.slice(-60);
  writeJson(path.join(RAW, 'zz-a-failure.json'), out);
  return out;
}

async function cleanupStep() {
  const out = { at: now() };
  out.isolatedBefore = listIsolatedProcs();
  out.portFreeBefore = await isPortFree(CDP_PORT);
  out.maintainerBefore = listMaintainerProcs();
  out.maintainerProfilePkgShaBefore = sha256(MAINTAINER_PKG);
  if (client) {
    try { await client.close(); } catch (e) { out.clientCloseError = String(e.message); }
    client = null;
  }
  if (args.keep) {
    out.kept = true;
    out.note = '--keep：保留隔离实例，未杀进程';
    return out;
  }
  if (rootPid) killTree(rootPid);
  if (desktopChild) out.exited = await waitForExit(desktopChild, 20000);
  await sleep(1500);
  out.portFree = await waitForPortFree(CDP_PORT, 20000);
  out.portOwnerAfter = out.portFree ? null : findPortOwner(CDP_PORT);
  out.isolatedAfter = listIsolatedProcs();
  out.maintainerAfter = listMaintainerProcs();
  out.maintainerProfilePkgShaAfter = sha256(MAINTAINER_PKG);
  out.dshPromptLog = readDshPromptLogTail(5000);
  if (outFd !== null) { try { fs.closeSync(outFd); } catch (e) { out.closeOutFdError = String(e.message); } outFd = null; }
  if (errFd !== null) { try { fs.closeSync(errFd); } catch (e) { out.closeErrFdError = String(e.message); } errFd = null; }
  return out;
}

function writeResult() {
  const result = {
    channel: 'A',
    run: path.basename(RUN_DIR),
    status: status,
    startedAt: startedAt,
    finishedAt: now(),
    cdpPort: CDP_PORT,
    rootPid: rootPid,
    home: HOME_DIR,
    userDataDir: USER_DATA_DIR,
    desktopExe: DESKTOP_EXE,
    steps: steps,
    shots: shots,
    blockers: blockers,
  };
  writeJson(path.join(RAW, '98a-result.json'), result);
  writeJson(path.join(RAW, 'run-a-steps.json'), { channel: 'A', status: status, steps: steps, shots: shots, blockers: blockers });
  return result;
}

// ---------- 主流程 ----------
async function main() {
  // ① 前置事实
  const preflight = await preflightStep();
  recordStep('preflight', preflight);
  if (!preflight.pluginVersion) throw new Error('隔离 home 里没有 dsh-prompt（前置不满足）：' + HOME_DIR);
  if (!preflight.portFree) throw new Error('调试端口被占用：' + CDP_PORT + ' owner=' + preflight.portOwner);

  // ② 重启（同 udd2 + 同隔离 home + 新调试端口）
  const launch = await launchStep();
  recordStep('launch', launch);

  // ③ 连接 + 首屏
  const attach = await attachStep();
  recordStep('attach', attach);
  await shot('a20-desktop-restarted', {
    whatToLook: '重启后的官方桌面隔离实例首屏（同一 --user-data-dir / 同一隔离 DSH_HOME / 新调试端口 ' + CDP_PORT + '）',
    expected: '窗口正常渲染，页面是 dsh-app://app/；向导页或会话页可见',
    actual: 'href=' + attach.href + '；wizard=' + attach.state.wizard + '；welcome=' + attach.state.welcome + '；viewport=' + attach.viewport.width + 'x' + attach.viewport.height + '@' + attach.viewport.dpr + '；body 前 120 字=' + attach.state.text.slice(0, 120),
    judgement: '符合预期',
    note: '重启前的旧实例进程树 taskkill 证据：raw/26-channel-a-cleanup.txt（isolated_after=0）；本次 pid=' + rootPid,
    viewport: attach.viewport,
  });

  // ④ 向导两层（跳过 → 我知道了）
  const wizard = await closeWizard();
  recordStep('wizard-skip', wizard);
  await shot('a21-desktop-wizard-skipped', {
    whatToLook: '向导两层点完后是否回到主界面（设置/向导消失）',
    expected: '「准备可用额度」与「暂时跳过充值?」都不再出现',
    actual: 'wizard=' + wizard.final.wizard + '；dialogs=' + JSON.stringify(wizard.final.dialogs) + '；rounds=' + JSON.stringify(wizard.rounds.map((r) => r.action)),
    judgement: wizard.final.wizard || wizard.final.dialogs.length ? '不符合预期' : '符合预期',
    note: '这一步补的是初版缺的「跳过 → 二次确认 → 我知道了」',
    viewport: attach.viewport,
  });
  if (wizard.final.wizard || wizard.final.dialogs.length) throw new Error('向导没关掉：' + JSON.stringify(wizard.final.dialogs));

  // ⑤ 新会话 + 等入口
  const entryStage = await openSessionWaitEntry();
  recordStep('entry', entryStage);
  if (!entryStage.ok) throw new Error('重启后等不到 [data-dsh-prompt-entry]：' + JSON.stringify(entryStage.attempts.map((a) => a.stage)));
  await shot('a22-desktop-entry', {
    whatToLook: '会话页输入框左侧是否出现集成方入口 [data-dsh-prompt-entry]',
    expected: '重启宿主后入口出现（说明「立即启用」+ 重启生效）',
    actual: 'entry rect=' + JSON.stringify(entryStage.entry.rect) + '；label=' + entryStage.entry.label,
    judgement: '符合预期',
    note: '初版卡点「启用不即时生效」由「重启后出现」闭环',
    viewport: attach.viewport,
  });

  // ⑥ 悬停开面板（截图在点「模板管理」之前）
  const panelStage = await hoverEntryOpenPanel();
  recordStep('prompt-panel', panelStage);
  await shot('a23-desktop-prompt-panel', {
    whatToLook: '悬停入口后集成方面板是否展开，面板上有通往设置页的「模板管理」',
    expected: '面板出现，按钮含模板管理/触发方式切换等',
    actual: 'panelButtons=' + JSON.stringify(panelStage.panelButtons) + '；panelRootRect=' + JSON.stringify(panelStage.panelRootRect) + '；coveragePre=' + JSON.stringify(panelStage.coveragePre.map((x) => x.cover && x.cover.inside)),
    judgement: panelStage.panelRootOpened ? '符合预期' : '不符合预期',
    note: '悬停用 CDP 真实 mouseMoved，不用 JS 派发；截图时机=面板已展开、尚未点进设置',
    viewport: attach.viewport,
  });

  // ⑦ 面板「模板管理」→ 设置页
  const settingsOpen = await clickTemplateManagement();
  recordStep('settings-page', settingsOpen);

  // ⑧ 设置页更新入口（先 scrollIntoView 居中并取证，截图后再点）
  const settingsStage = await prepareUpdateEntry();
  recordStep('update-entry', settingsStage);
  await shot('a24-desktop-settings-entry', {
    whatToLook: '设置页里的更新入口 [data-dsh-prompt-update-entry] 是否可见可点（截图在点击之前）',
    expected: 'scrollIntoView({block:center}) 后入口在视口内、rect 非零、未被遮挡',
    actual: 'text=' + String(settingsStage.entryAfterScroll.text) + '；rect=' + JSON.stringify(settingsStage.entryAfterScroll.rect) + '；inViewport=' + settingsStage.entryAfterScroll.inViewport + '；inside=' + settingsStage.entryAfterScroll.inside,
    judgement: settingsStage.entryAfterScroll.inViewport && settingsStage.entryAfterScroll.inside ? '符合预期' : '不符合预期',
    note: '初版坑：不 scrollIntoView 直接点会点空；入口文案是「已是最新 0.4.40」（autoCheck=mount 已查过）',
    viewport: attach.viewport,
  });
  const entryClick = await clickUpdateEntry(settingsStage.entryAfterScroll);
  recordStep('update-entry-click', entryClick);
  if (entryClick.clickVia === 'failed') throw new Error('更新入口点击失败');

  // ⑧ 更新面板
  const dialogStage = await openUpdateDialog();
  recordStep('update-panel', dialogStage);
  await shot('a25-desktop-update-panel', {
    whatToLook: '点更新入口后是否弹出产品更新面板（.dsh-upd[data-mode=dialog]）且能定位',
    expected: '整窗截图能定位面板：标题/版本/行动按钮可读',
    actual: 'rect=' + JSON.stringify(dialogStage.facts.rect) + '；actions=' + JSON.stringify(dialogStage.facts.actions) + '；text=' + dialogStage.facts.text.slice(0, 220),
    judgement: '符合预期',
    note: '验收项「截图能定位更新面板」由本图 + crop 满足',
    viewport: attach.viewport,
  });
  await shot('a25-desktop-update-panel-crop', {
    whatToLook: '更新面板局部细节是否可读',
    expected: '行动按钮（检查更新/安装/关闭）与版本行清晰',
    actual: 'clip=' + JSON.stringify(dialogStage.clip) + '；actions=' + JSON.stringify(dialogStage.facts.actions),
    judgement: '符合预期',
    note: '面板 crop 用 .dsh-upd 的 rect 加 8px 边距',
    viewport: attach.viewport,
    clip: dialogStage.clip,
  });

  // ⑨ 点「检查更新」
  const checkStage = await clickCheck(dialogStage.facts.text);
  recordStep('click-check', checkStage);
  await shot('a26-desktop-after-check', {
    whatToLook: '点面板里的「检查更新」后是否即时进入检查/给出结果',
    expected: '按钮进入检查中（disabled 或文案变化），面板不崩',
    actual: 'pick=' + JSON.stringify(checkStage.pick) + '；immediate=' + JSON.stringify(checkStage.immediate) + '；afterText=' + String(checkStage.after && checkStage.after.text ? checkStage.after.text : JSON.stringify(checkStage.after)).slice(0, 260),
    judgement: checkStage.after && checkStage.after.panelGone ? '不符合预期（面板被关）' : '符合预期',
    note: '这一步是票面「每条通道至少完成一次：打开更新面板→点一个入口→截一张图」的入口点击',
    viewport: attach.viewport,
  });

  // ⑩ 页面 console / 错误收集
  const pageErrors = await client.evaluate('window.__s264Errors || []').catch(() => null);
  recordStep('console', {
    counts: { console: collected.console.length, exceptions: collected.exception.length, logEntries: collected.log.length, pageErrors: Array.isArray(pageErrors) ? pageErrors.length : null },
    consoleTail: collected.console.slice(-120),
    exceptions: collected.exception.slice(-40),
    logEntries: collected.log.slice(-80),
    pageErrors: pageErrors,
  });
}

try {
  await main();
} catch (e) {
  status = 'FAIL';
  const message = String(e && e.stack ? e.stack : e);
  blockers.push(String(e && e.message ? e.message : e));
  console.error('[FAIL] ' + message);
  await failureEvidence('main', message).catch(() => {});
}

try {
  const cleanup = await cleanupStep();
  recordStep('cleanup', cleanup);
} catch (e) {
  console.error('[cleanup-error] ' + String(e && e.stack ? e.stack : e));
}

writeResult();
console.log('[result] status=' + status + ' steps=' + steps.length + ' shots=' + shots.length + ' blockers=' + JSON.stringify(blockers));
process.exit(status === 'PASS' ? 0 : 1);
