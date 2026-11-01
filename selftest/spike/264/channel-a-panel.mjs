/** T0 spike 通道 A：在官方桌面版里打开集成方更新面板并点一个入口（throwaway）。逻辑与 channel-b 的 ⑥⑦⑧ 同构。 */
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
function opt(n, d) { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; }
const cdpPort = Number(opt('cdp-port', '0'));
const runDir = opt('run-dir', '');
const RAW = path.join(runDir, 'raw'); const SHOTS = path.join(runDir, 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await connect({ cdpPort });
await client.send('Page.enable', {}); await client.send('Runtime.enable', {});
const log = {};

// 回到会话页（插件入口挂在输入框左侧）
log.backToChat = await client.evaluate("(() => { const bs = Array.from(document.querySelectorAll('button')); const b = bs.find((x) => String(x.innerText || '').replace(/\\s+/g, ' ').trim() === '新会话'); if (!b) return { ok: false }; b.click(); return { ok: true }; })()");
await sleep(2000);
await client.waitFor("document.querySelector('[data-dsh-prompt-entry]') !== null", { timeoutMs: 30000, label: '集成方输入框入口 [data-dsh-prompt-entry]' });
const rect = await client.getRect('[data-dsh-prompt-entry]');
await client.mouseMove(2, 2); await client.mouseMove(rect.cx, rect.cy);
await client.waitFor("document.querySelector('[data-dsh-prompt-panel-root]') !== null", { timeoutMs: 15000, label: '悬停后集成方面板' });
await sleep(500);
log.panel = await client.evaluate("(() => { const bs = Array.from(document.querySelectorAll('[data-dsh-prompt-panel-root] button')); return bs.map((b) => ({ text: String(b.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30), title: String(b.getAttribute('title') || '').slice(0, 60) })).filter((b) => b.text || b.title); })()");
await client.screenshot(path.join(SHOTS, 'a7-desktop-prompt-panel.png'));
const goSet = await client.evaluate("(() => { const bs = Array.from(document.querySelectorAll('[data-dsh-prompt-panel-root] button')); const b = bs.find((x) => /设置|Settings/.test(String(x.getAttribute('title') || '') + ' ' + String(x.innerText || ''))); if (!b) return { ok: false }; b.click(); return { ok: true, title: b.getAttribute('title') }; })()");
log.goSet = goSet;
await client.waitFor("document.querySelector('[data-dsh-prompt-update-entry]') !== null", { timeoutMs: 30000, label: '设置页更新入口' });
await client.evaluate("(() => { const el = document.querySelector('[data-dsh-prompt-update-entry]'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' }); return true; })()");
await sleep(600);
const r2 = await client.evaluate("(() => { const el = document.querySelector('[data-dsh-prompt-update-entry]'); const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, vw: innerWidth, vh: innerHeight, text: String(el.innerText || '').replace(/\\s+/g, ' ').slice(0, 80) }; })()");
log.entry = r2;
await client.screenshot(path.join(SHOTS, 'a8-desktop-settings-entry.png'));
await client.click(r2.x + r2.width / 2, r2.y + r2.height / 2);
await client.waitFor("document.querySelector('.dsh-upd[data-mode=dialog]') !== null", { timeoutMs: 30000, label: '桌面版更新面板 dialog' });
await sleep(800);
const panel = await client.evaluate("(() => { const root = document.querySelector('.dsh-upd[data-mode=dialog]'); const b = root.getBoundingClientRect(); return { rect: { x: b.x, y: b.y, width: b.width, height: b.height }, text: String(root.innerText || '').replace(/\\s+/g, ' ').slice(0, 400), actions: Array.from(root.querySelectorAll('button[data-action]')).map((x) => ({ action: x.getAttribute('data-action'), text: String(x.innerText || '').trim().slice(0, 20), disabled: x.disabled })) }; })()");
log.panelFacts = panel;
await client.screenshot(path.join(SHOTS, 'a9-desktop-update-panel.png'));
const pickExpr = "(() => { const root = document.querySelector('.dsh-upd[data-mode=dialog]'); const bs = Array.from(root.querySelectorAll('button[data-action]')).filter((x) => !x.disabled); const b = bs.find((x) => x.getAttribute('data-action') === 'check') || bs.find((x) => x.getAttribute('data-action') !== 'close-view'); if (!b) return { ok: false }; const r = b.getBoundingClientRect(); return { ok: true, action: b.getAttribute('data-action'), x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()";
let pick = await client.evaluate(pickExpr);
for (let i = 0; !pick.ok && i < 60; i += 1) { await sleep(300); pick = await client.evaluate(pickExpr); }
log.pick = pick;
if (pick.ok) { await client.click(pick.x, pick.y); }
await sleep(150);
log.immediate = await client.evaluate("(() => { const root = document.querySelector('.dsh-upd[data-mode=dialog]'); if (!root) return null; const b = root.querySelector('button[data-action=check]'); return { checkText: b ? String(b.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30) : null, disabled: b ? b.disabled : null }; })()");
await sleep(1500);
await client.screenshot(path.join(SHOTS, 'a10-desktop-after-click.png'));
fs.writeFileSync(path.join(RAW, '25-channel-a-panel.json'), JSON.stringify(log, null, 2));
console.log(JSON.stringify({ entry: r2, panelText: panel.text.slice(0, 200), actions: panel.actions, pick, immediate: log.immediate }, null, 2));
client.close();