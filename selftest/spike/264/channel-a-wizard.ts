#!/usr/bin/env node
/**
 * 通道 A 向导两层取证（#264 T0 补）——用**全新隔离 DSH_HOME + 全新 --user-data-dir** 起官方桌面实例，
 * 让首启「准备可用额度」向导必然出现，然后记录「跳过 → 二次确认『暂时跳过充值?』→ 我知道了」两层点击。
 *
 * 背景：channel-a-deeplink.ts 的 PASS 运行是在已经关过向导的 udd2/home 上重启的，raw/33 只剩
 * 「wizard 已消失」，两层点击的逐轮记录被覆盖；本脚本补一份从首启状态开始的原始证据。
 *
 * 用法：
 *   node channel-a-wizard.ts --run-dir <证据目录> [--home ...] [--user-data-dir ...] [--cdp-port 59346] [--desktop-exe ...] [--keep]
 *
 * 证据：
 *   raw/60-channel-a-wizard-preflight.json / 61-...-launch.json / 62-...-attach.json /
 *   63-...-wizard-skip.json（rounds 逐轮点击）/ 64-...-wizard-cleanup.json / raw/98w-result.json
 *   shots/a30-desktop-wizard-credit.png（跳过前）/ a31-desktop-wizard-confirm.png（二次确认）/ a32-desktop-wizard-closed.png（关掉后）
 *
 * 安全边界：只 spawn 自己这条隔离实例（--user-data-dir 指向 runtime/t0-264-wizard），cleanup 只杀自己进程树；
 * 维护者 DSH 进程只读观测，不写 C:/Users/辰辰洋洋/.dsh。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { killTree, sleep, waitForExit, isPortFree, waitForPortFree, findPortOwner } from './lib/proc.ts';
import { connect } from './lib/cdp.ts';

const MAINTAINER_PKG = 'C:/Users/辰辰洋洋/.dsh/profiles/desktop/package.json';
const MAINTAINER_PIDS = [17020, 39812];

function parseArgs(argv: string[]): { runDir: string; home: string; userDataDir: string; cdpPort: number; desktopExe: string; keep: boolean } {
  const out = {
    runDir: '',
    home: 'D:/dsh-plugin/_wt263/runtime/t0-264-wizard/home',
    userDataDir: 'D:/dsh-plugin/_wt263/runtime/t0-264-wizard/udd',
    cdpPort: 59346,
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
  console.error('用法: node channel-a-wizard.ts --run-dir <证据目录> [--home ...] [--user-data-dir ...] [--cdp-port 59346] [--desktop-exe ...] [--keep]');
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
const steps: any[] = [];
const shots: any[] = [];
const blockers: string[] = [];
const collected: { console: any[]; exception: any[]; log: any[] } = { console: [], exception: [], log: [] };
let seq = 60;
let client: any = null;
let desktopChild: any = null;
let rootPid: number | null = null;
let outFd: number | null = null;
let errFd: number | null = null;
let status = 'PASS';
let viewport: any = null;

function now() { return new Date().toISOString(); }
function rel(p: string) { return path.relative(RUN_DIR, p).split(path.sep).join('/'); }
function writeJson(absPath: string, value: any) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(value, null, 2), 'utf8');
  return absPath;
}
function readTextSafe(file: string, maxChars?: number): string | null {
  try { return fs.readFileSync(file, 'utf8').slice(-(maxChars || 4000)); } catch (e) { return null; }
}
function tailFile(file: string, maxChars?: number) { return readTextSafe(file, maxChars) || '(读不到：' + file + ')'; }
function sha256(file: string): string | null {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (e) { return null; }
}

function recordStep(name: string, data: any) {
  const n = String(seq).padStart(2, '0');
  seq += 1;
  const file = path.join(RAW, n + '-channel-a-wizard-' + name + '.json');
  const payload: any = { step: name, channel: 'A', at: now() };
  const keys = Object.keys(data || {});
  for (let i = 0; i < keys.length; i += 1) payload[keys[i]] = data[keys[i]];
  writeJson(file, payload);
  steps.push({ step: name, file: rel(file), at: payload.at });
  console.log('[step] ' + name + ' -> ' + rel(file));
  return payload;
}

async function shot(name: string, meta: any) {
  const png = path.join(SHOTS, name + '.png');
  let lastError: any = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { await client.screenshot(png, meta.clip || null); lastError = null; break; } catch (e) { lastError = e; await sleep(1200); }
  }
  if (lastError) throw lastError;
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
    viewport: viewport,
    clip: meta.clip || null,
  };
  writeJson(path.join(SHOTS, name + '.json'), payload);
  shots.push({ shot: name + '.png', json: name + '.json', judgement: meta.judgement });
  console.log('[shot] ' + name + ' (' + meta.judgement + ')');
  return payload;
}

// ---------- 页面内取数/点击（不用正则转义：charCode 归一化空白） ----------
const NORM_FN = 'const norm = (s) => Array.from(String(s || "")).map((c) => (c.charCodeAt(0) <= 32 ? " " : c)).join("").replace(/ {2,}/g, " ").trim();';
function expr(body: string) { return '(() => { ' + NORM_FN + ' ' + body + ' })()'; }

const STATE_BODY = [
  'const text = norm(document.body ? document.body.innerText : "");',
  'const dialogs = Array.from(document.querySelectorAll("[role=dialog], dialog")).map((d) => ({ text: norm(d.innerText).slice(0, 500), buttons: Array.from(d.querySelectorAll("button")).map((b) => norm(b.innerText)).filter(Boolean) }));',
  'const composer = Boolean(document.querySelector("[data-dsh-prompt-entry]") || document.querySelector("[contenteditable=true]") || document.querySelector("textarea"));',
  'return { href: location.href, title: document.title, readyState: document.readyState, wizard: /准备可用额度/.test(text), welcome: /欢迎使用 DeepSeek Harness/.test(text) && /开始设置/.test(text), composer: composer, dialogs: dialogs, text: text.slice(0, 900) };',
].join(' ');

async function pageState() { return client.evaluate(expr(STATE_BODY)); }

function clickableExpr(within: string, wanted: string, exact?: boolean) {
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

function jsClickExpr(within: string, wanted: string, exact?: boolean) {
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

async function clickWanted(within: string, wanted: string, opts?: any) {
  const o = opts || {};
  const deadline = Date.now() + (o.timeoutMs || 8000);
  let info: any = null;
  while (Date.now() < deadline) {
    info = await client.evaluate(clickableExpr(within, wanted, o.exact));
    if (info && info.found && info.visible) break;
    await sleep(200);
  }
  if (!info || !info.found || !info.visible) throw new Error('找不到可点元素「' + wanted + '」within=' + within + '；最后=' + JSON.stringify(info));
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

function collectEvent(message: any) {
  const method = message.method;
  if (method === 'Runtime.consoleAPICalled') {
    const p = message.params || {};
    const a = (p.args || []).map((x: any) => (x.value !== undefined ? x.value : (x.description !== undefined ? x.description : x.type)));
    collected.console.push({ at: now(), type: p.type, args: a.slice(0, 12) });
    if (collected.console.length > 500) collected.console.shift();
  } else if (method === 'Runtime.exceptionThrown') {
    const d = (message.params || {}).exceptionDetails || {};
    collected.exception.push({ at: now(), text: String(d.text || ''), description: String((d.exception && d.exception.description) || '').slice(0, 800) });
    if (collected.exception.length > 100) collected.exception.shift();
  } else if (method === 'Log.entryAdded') {
    const e = (message.params || {}).entry || {};
    collected.log.push({ at: now(), level: e.level, source: e.source, text: String(e.text || '').slice(0, 500) });
    if (collected.log.length > 200) collected.log.shift();
  }
}

function listProcs(match: string): any[] {
  const esc = match.replace(/'/g, "''");
  const r = runPs('Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ' + "'*" + esc + "*'" + ' } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress');
  if (!r) return [];
  try {
    const v = JSON.parse(r);
    return Array.isArray(v) ? v : [v];
  } catch (e) { return []; }
}
function runPs(command: string): string | null {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.status !== 0) return null;
  return String(r.stdout || '').trim() || null;
}
function listIsolatedProcs() { return listProcs(USER_DATA_DIR.split(path.sep).join('\\')); }
function listMaintainerProcs() {
  const out: any[] = [];
  for (let i = 0; i < MAINTAINER_PIDS.length; i += 1) {
    const pid = MAINTAINER_PIDS[i];
    const r = runPs('Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime | ConvertTo-Json -Compress');
    if (r) { try { out.push(JSON.parse(r)); } catch (e) { out.push({ pid: pid, raw: r }); } }
  }
  return out;
}

function launchEnv() {
  const env: any = {};
  const removed: string[] = [];
  const keys = Object.keys(process.env);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (key === 'ELECTRON_RUN_AS_NODE' || key.indexOf('DSH_') === 0) { removed.push(key); continue; }
    env[key] = process.env[key];
  }
  env.DSH_HOME = HOME_DIR;
  return { env: env, removed: removed };
}

async function waitForCdp(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError: any = null;
  while (Date.now() < deadline) {
    if (desktopChild && desktopChild.exitCode !== null) {
      throw new Error('桌面实例启动即退出 exitCode=' + desktopChild.exitCode + '；stderr=' + tailFile(path.join(RAW, 'channel-a-wizard-stderr.log'), 2500));
    }
    try {
      const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version', { signal: AbortSignal.timeout(2500) });
      if (res.ok) return await res.json();
    } catch (e) { lastError = e; }
    await sleep(500);
  }
  throw new Error('CDP /json/version 未就绪（' + timeoutMs + 'ms）：' + String(lastError && lastError.message ? lastError.message : lastError));
}

async function closeWizard() {
  const rounds: any[] = [];
  let lastAction = '';
  let lastFingerprint = '';
  for (let i = 0; i < 12; i += 1) {
    const st = await pageState();
    const fp = [st.wizard, st.welcome, st.dialogs.length, st.dialogs.map((d: any) => d.buttons.join('|')).join('||')].join('#');
    const confirm = st.dialogs.find((d: any) => d.text.indexOf('暂时跳过充值') >= 0) || null;
    if (confirm) {
      const clicked = await clickWanted('[role=dialog]', '我知道了', { exact: true, timeoutMs: 8000 });
      rounds.push({ round: i, action: 'confirm-skip', dialog: confirm.text.slice(0, 200), clicked: clicked });
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
      lastAction = 'start-setup';
      lastFingerprint = fp;
      await sleep(1600);
      continue;
    }
    rounds.push({ round: i, action: 'done', state: st.text.slice(0, 240) });
    break;
  }
  const final = await pageState();
  return { rounds: rounds, lastAction: lastAction, final: { href: final.href, wizard: final.wizard, welcome: final.welcome, dialogs: final.dialogs, composer: final.composer, text: final.text.slice(0, 500) } };
}

async function cleanupStep() {
  const out: any = { at: now() };
  out.isolatedBefore = listIsolatedProcs();
  out.portFreeBefore = await isPortFree(CDP_PORT);
  out.maintainerBefore = listMaintainerProcs();
  out.maintainerProfilePkgShaBefore = sha256(MAINTAINER_PKG);
  if (client) { try { await client.close(); } catch (e) { out.clientCloseError = String((e as any).message); } client = null; }
  if (args.keep) { out.kept = true; out.note = '--keep：保留隔离实例，未杀进程'; return out; }
  if (rootPid) killTree(rootPid);
  if (desktopChild) out.exited = await waitForExit(desktopChild, 20000);
  await sleep(1500);
  out.portFree = await waitForPortFree(CDP_PORT, 20000);
  out.portOwnerAfter = out.portFree ? null : findPortOwner(CDP_PORT);
  out.isolatedAfter = listIsolatedProcs();
  out.maintainerAfter = listMaintainerProcs();
  out.maintainerProfilePkgShaAfter = sha256(MAINTAINER_PKG);
  if (outFd !== null) { try { fs.closeSync(outFd); } catch (e) { out.closeOutFdError = String((e as any).message); } outFd = null; }
  if (errFd !== null) { try { fs.closeSync(errFd); } catch (e) { out.closeErrFdError = String((e as any).message); } errFd = null; }
  return out;
}

function writeResult() {
  const result = {
    channel: 'A',
    purpose: '向导两层（跳过 → 我知道了）首启原始证据',
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
    consoleTail: collected.console.slice(-80),
    exceptions: collected.exception.slice(-20),
  };
  writeJson(path.join(RAW, '98w-result.json'), result);
  return result;
}

async function main() {
  // ① 前置：确认是全新隔离状态
  const preflight = {
    at: now(),
    cdpPort: CDP_PORT,
    portFree: await isPortFree(CDP_PORT),
    home: HOME_DIR,
    homeExists: fs.existsSync(HOME_DIR),
    homeProfilePackage: (function () { try { return JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'profiles', 'desktop', 'package.json'), 'utf8')); } catch (e) { return null; } })(),
    userDataDir: USER_DATA_DIR,
    userDataDirExists: fs.existsSync(USER_DATA_DIR),
    parentEnv: { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || null, DSH_HOME: process.env.DSH_HOME || null, DSH_PROFILE: process.env.DSH_PROFILE || null, DSH_SHELL: process.env.DSH_SHELL || null },
    maintainerProcs: listMaintainerProcs(),
    maintainerProfilePkgSha: sha256(MAINTAINER_PKG),
    note: '全新 DSH_HOME + 全新 --user-data-dir ⇒ 首启向导必然出现；本脚本不装插件，只取证向导两层',
  };
  recordStep('preflight', preflight);
  if (!preflight.portFree) throw new Error('调试端口被占用：' + CDP_PORT + ' owner=' + findPortOwner(CDP_PORT));
  // 注意：不要预先创建 HOME_DIR —— 官方桌面用 DSH_HOME 是否存在判断「首启」，预建会跳过欢迎/向导。

  // ② 启动
  const prepared = launchEnv();
  const outLog = path.join(RAW, 'channel-a-wizard-stdout.log');
  const errLog = path.join(RAW, 'channel-a-wizard-stderr.log');
  outFd = fs.openSync(outLog, 'a');
  errFd = fs.openSync(errLog, 'a');
  const argv = ['--user-data-dir=' + USER_DATA_DIR, '--remote-debugging-port=' + CDP_PORT];
  const t0 = Date.now();
  desktopChild = spawn(DESKTOP_EXE, argv, { cwd: path.dirname(DESKTOP_EXE), env: prepared.env, stdio: ['ignore', outFd, errFd], windowsHide: false, detached: false });
  rootPid = desktopChild.pid;
  fs.writeFileSync(path.join(RAW, 'channel-a-wizard-launch.txt'), 'started pid=' + rootPid + String.fromCharCode(10) + 'argv=' + JSON.stringify(argv) + String.fromCharCode(10) + 'DSH_HOME=' + HOME_DIR + String.fromCharCode(10) + 'env_removed=' + JSON.stringify(prepared.removed) + String.fromCharCode(10), 'utf8');
  const version = await waitForCdp(120000);
  const launchMs = Date.now() - t0;
  await sleep(1200);
  recordStep('launch', {
    rootPid: rootPid,
    argv: argv,
    dshHome: HOME_DIR,
    userDataDir: USER_DATA_DIR,
    envRemoved: prepared.removed,
    launchMs: launchMs,
    cdp: { Browser: version.Browser, ProtocolVersion: version['Protocol-Version'], UserAgent: version['User-Agent'] },
    isolatedProcs: listIsolatedProcs(),
    stdoutTail: tailFile(outLog, 1200),
    stderrTail: tailFile(errLog, 1200),
  });

  // ③ 连接 + 等首屏（全新 home 首次初始化可能慢）
  for (let i = 0; i < 30; i += 1) {
    try { client = await connect({ cdpPort: CDP_PORT, timeoutMs: 15000, onEvent: collectEvent }); break; } catch (e) { await sleep(500); }
  }
  if (!client) throw new Error('CDP 连接失败');
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  const readyT0 = Date.now();
  await client.waitFor('document.readyState === "complete" && Boolean(document.body) && document.body.innerText.length > 0', { timeoutMs: 90000, label: '页面加载完成' });
  await client.waitFor('(() => { const t = document.body ? document.body.innerText : ""; return t.indexOf("Loading plugins") < 0 && (t.indexOf("准备可用额度") >= 0 || t.indexOf("开始设置") >= 0 || t.indexOf("新会话") >= 0); })()', { timeoutMs: 180000, label: '应用首屏就绪（插件加载完成）' });
  await sleep(2000);
  viewport = await client.evaluate('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })');
  const attach = { at: now(), appReadyMs: Date.now() - readyT0, href: (await pageState()).href, state: await pageState(), viewport: viewport };
  recordStep('attach', attach);

  // ④ 首启欢迎页 → 「开始设置」进入额度向导
  let st = await pageState();
  const welcomeClicks: any[] = [];
  if (st.welcome) {
    const clicked = await clickWanted('body', '开始设置', { exact: true, timeoutMs: 8000 });
    welcomeClicks.push({ action: 'start-setup', clicked: clicked });
    await sleep(1800);
    st = await pageState();
  }
  // 等额度向导出现（首启才会出现；最多 30s）
  const wizardDeadline = Date.now() + 30000;
  while (!st.wizard && Date.now() < wizardDeadline) { await sleep(500); st = await pageState(); }

  // ⑤ 第 1 层：跳过（截图在点击之前）
  await shot('a30-desktop-wizard-credit', {
    whatToLook: '全新隔离实例首启的「准备可用额度」向导页，底部有「跳过」',
    expected: '向导页出现且「跳过」可点（这是两层里的第一层）',
    actual: 'wizard=' + st.wizard + '；welcome=' + st.welcome + '；text 前 200 字=' + st.text.slice(0, 200),
    judgement: st.wizard ? '符合预期' : '不符合预期',
    note: '全新 DSH_HOME=' + HOME_DIR + '（未预建）＋全新 --user-data-dir=' + USER_DATA_DIR + '；欢迎页点击=' + JSON.stringify(welcomeClicks),
  });
  if (!st.wizard) throw new Error('首启没有出现「准备可用额度」向导：welcome=' + st.welcome + '；text=' + st.text.slice(0, 300));
  const layer1 = await clickWanted('body', '跳过', { exact: true, timeoutMs: 8000 });
  // 等第二层二次确认出现
  let confirmDialog: any = null;
  const confirmDeadline = Date.now() + 12000;
  while (Date.now() < confirmDeadline) {
    st = await pageState();
    confirmDialog = st.dialogs.find((d: any) => d.text.indexOf('暂时跳过充值') >= 0) || null;
    if (confirmDialog) break;
    await sleep(300);
  }

  // ⑥ 第 2 层：二次确认对话框截图 + 点「我知道了」
  await shot('a31-desktop-wizard-confirm', {
    whatToLook: '点「跳过」后是否弹出二次确认「暂时跳过充值?」（两层里的第二层）',
    expected: '出现 [role=dialog]，按钮含「我知道了 / 前往充值」',
    actual: 'dialogs=' + JSON.stringify(st.dialogs.map((d: any) => d.text.slice(0, 160))) + '；buttons=' + JSON.stringify(confirmDialog ? confirmDialog.buttons : null),
    judgement: confirmDialog ? '符合预期' : '不符合预期',
    note: '第一层点击=' + JSON.stringify(layer1),
  });
  if (!confirmDialog) throw new Error('点「跳过」后没有出现二次确认「暂时跳过充值?」：dialogs=' + JSON.stringify(st.dialogs));
  const layer2 = await clickWanted('[role=dialog]', '我知道了', { exact: true, timeoutMs: 8000 });
  const gone = await client.waitFor('document.body.innerText.indexOf("准备可用额度") < 0', { timeoutMs: 10000, label: '点「我知道了」后向导页消失' }).then(() => true).catch(() => false);
  await sleep(800);
  const final = await pageState();
  recordStep('wizard-skip', {
    welcomeClicks: welcomeClicks,
    layer1Skip: layer1,
    layer2Confirm: layer2,
    confirmDialog: { text: confirmDialog.text, buttons: confirmDialog.buttons },
    wizardGone: gone,
    final: { href: final.href, wizard: final.wizard, welcome: final.welcome, dialogs: final.dialogs, composer: final.composer, text: final.text.slice(0, 500) },
  });
  await shot('a32-desktop-wizard-closed', {
    whatToLook: '向导两层点完后是否回到主界面（「准备可用额度」与二次确认都不再出现）',
    expected: 'wizard=false、dialogs=[]、输入框可见',
    actual: 'wizard=' + final.wizard + '；dialogs=' + JSON.stringify(final.dialogs) + '；composer=' + final.composer,
    judgement: final.wizard || final.dialogs.length ? '不符合预期' : '符合预期',
    note: '第一层点击=' + JSON.stringify(layer1) + '；第二层点击=' + JSON.stringify(layer2) + '；wizardGone=' + gone,
  });
  if (final.wizard || final.dialogs.length) throw new Error('向导没关掉：' + JSON.stringify(final.dialogs));
  if (!gone) throw new Error('点「我知道了」后向导页仍在');

}

try {
  await main();
} catch (e) {
  status = 'FAIL';
  const message = String((e as any) && (e as any).stack ? (e as any).stack : e);
  blockers.push(String((e as any) && (e as any).message ? (e as any).message : e));
  console.error('[FAIL] ' + message);
  try {
    const st = client ? await pageState().catch(() => null) : null;
    writeJson(path.join(RAW, 'zz-a-wizard-failure.json'), { at: now(), message: message, state: st });
    if (client) { await client.screenshot(path.join(SHOTS, 'a99-wizard-fail.png'), null).catch(() => {}); }
  } catch (e2) { console.error('[failure-evidence-error] ' + String(e2)); }
}

try {
  const cleanup = await cleanupStep();
  recordStep('cleanup', cleanup);
} catch (e) {
  console.error('[cleanup-error] ' + String(e));
}

writeResult();
console.log('[result] status=' + status + ' steps=' + steps.length + ' shots=' + shots.length + ' blockers=' + JSON.stringify(blockers));
process.exit(status === 'PASS' ? 0 : 1);
