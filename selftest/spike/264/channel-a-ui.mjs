/**
 * T0 spike 通道 A 的 UI 驱动小工具（throwaway）：按文本点按钮 / 截图 / 导出 DOM 摘要，逐步记录。
 * 用法：node channel-a-ui.mjs --cdp-port 59333 --run-dir <证据目录> --step <名字> [--click-text 插件] [--shot a1.png] [--wait 1500]
 */
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
function opt(name, fallback) { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : fallback; }
const cdpPort = Number(opt('cdp-port', '0'));
const runDir = opt('run-dir', '');
const stepName = opt('step', 'step');
const clickText = opt('click-text', '');
const shotName = opt('shot', '');
const waitMs = Number(opt('wait', '1500'));
if (!cdpPort || !runDir) { console.error('缺 --cdp-port / --run-dir'); process.exit(2); }
const RAW = path.join(runDir, 'raw');
const SHOTS = path.join(runDir, 'shots');
fs.mkdirSync(RAW, { recursive: true }); fs.mkdirSync(SHOTS, { recursive: true });

const client = await connect({ cdpPort });
await client.send('Page.enable', {});
await client.send('Runtime.enable', {});
await new Promise((r) => setTimeout(r, waitMs));
const dumpExpr = "(() => ({ url: location.href, title: document.title, hasUpdatePanel: Boolean(document.querySelector('.dsh-upd')), hasUpdateEntry: Boolean(document.querySelector('[data-dsh-prompt-update-entry]')), dialogs: Array.from(document.querySelectorAll('[role=dialog],dialog')).map((d) => ({ t: String(d.innerText || '').replace(/\\s+/g, ' ').slice(0, 200), id: d.id || null })), inputs: Array.from(document.querySelectorAll('input,textarea')).map((i) => ({ ph: i.getAttribute('placeholder'), type: i.type, value: String(i.value || '').slice(0, 40) })).slice(0, 20), text: String(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 1500), buttons: Array.from(document.querySelectorAll('button')).map((b) => String(b.innerText || b.getAttribute('aria-label') || b.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 40)).filter(Boolean).slice(0, 120) }))()";
let clickResult = null;
if (clickText) {
  clickResult = await client.evaluate('(() => { const t = ' + JSON.stringify(clickText) + '; const bs = Array.from(document.querySelectorAll(\'button\')); const b = bs.find((x) => String(x.innerText || \'\').replace(/\\s+/g, \' \').trim() === t) || bs.find((x) => String(x.innerText || \'\').includes(t)); if (!b) return { clicked: false, candidates: bs.map((x) => String(x.innerText || \'\').trim().slice(0, 20)).filter(Boolean).slice(0, 40) }; const r = b.getBoundingClientRect(); b.click(); return { clicked: true, text: String(b.innerText || \'\').trim().slice(0, 40), rect: { x: r.x, y: r.y, w: r.width, h: r.height } }; })()');
  await new Promise((r) => setTimeout(r, 1200));
}
const facts = await client.evaluate(dumpExpr);
if (shotName) await client.screenshot(path.join(SHOTS, shotName));
const out = { step: stepName, at: new Date().toISOString(), clickText, clickResult, facts };
fs.writeFileSync(path.join(RAW, '23-channel-a-' + stepName + '.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ step: stepName, clickResult, title: facts.title, hasUpdatePanel: facts.hasUpdatePanel, hasUpdateEntry: facts.hasUpdateEntry, text: facts.text.slice(0, 400) }, null, 2));
client.close();