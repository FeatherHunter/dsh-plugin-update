/**
 * T0 spike 通道 A：官方桌面版 Electron 的 CDP 驱动（throwaway，T1 重写成正式 harness）。
 * 只做三件事：列 target、截整窗图、导出可视文本与按钮（判断桌面壳里能不能走到插件管理/更新面板）。
 *
 * 用法：node channel-a.mjs --cdp-port 59333 --run-dir <证据目录>
 * 前置：桌面版必须以独立 --user-data-dir + --remote-debugging-port 启动，且启动前清掉 ELECTRON_RUN_AS_NODE。
 */
import fs from 'node:fs';
import path from 'node:path';
import { listTargets, connect } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
function opt(name, fallback) { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : fallback; }
const cdpPort = Number(opt('cdp-port', '0'));
const runDir = opt('run-dir', '');
if (!cdpPort || !runDir) { console.error('用法：node channel-a.mjs --cdp-port <端口> --run-dir <证据目录>'); process.exit(2); }
const RAW = path.join(runDir, 'raw');
const SHOTS = path.join(runDir, 'shots');
fs.mkdirSync(RAW, { recursive: true }); fs.mkdirSync(SHOTS, { recursive: true });

const targets = await listTargets(cdpPort);
fs.writeFileSync(path.join(RAW, '20-channel-a-targets.json'), JSON.stringify(targets, null, 2));
console.log('targets=' + targets.length);
for (const t of targets) console.log('  ' + t.type + ' ' + t.url + '  [' + (t.title || '') + ']');

const page = targets.find((t) => t.type === 'page' && /dsh-app|localhost|127\.0\.0\.1/.test(t.url)) || targets.find((t) => t.type === 'page');
if (!page) { console.error('没有 page target'); process.exit(3); }
const client = await connect({ cdpPort });
await client.send('Page.enable', {});
await client.send('Runtime.enable', {});
await new Promise((r) => setTimeout(r, 2500));
const url = await client.evaluate('location.href');
const facts = await client.evaluate("(() => ({ title: document.title, text: String(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 1200), buttons: Array.from(document.querySelectorAll('button')).map((b) => String(b.innerText || b.getAttribute('aria-label') || b.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 30)).filter(Boolean).slice(0, 80), hasUpdatePanel: Boolean(document.querySelector('.dsh-upd')), hasPluginUi: /插件|Plugins/i.test(String(document.body.innerText || '')) }))()");
await client.screenshot(path.join(SHOTS, 'a0-desktop-window.png'));
const out = { cdpPort, url, facts };
fs.writeFileSync(path.join(RAW, '21-channel-a-window.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2).slice(0, 2500));
client.close();