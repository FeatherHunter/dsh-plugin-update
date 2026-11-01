/** T0 spike 通道 A：在桌面壳「添加插件」里装 dsh-prompt（throwaway）。走的是出口二 in-process pluginManager。 */
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './lib/cdp.ts';

const argv = process.argv.slice(2);
function opt(n: string, d: string): string { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; }
const cdpPort: number = Number(opt('cdp-port', '0'));
const runDir = opt('run-dir', '');
const spec = opt('spec', 'dsh-prompt@0.4.40');
const pollOnly = argv.includes('--poll-only');
const RAW = path.join(runDir, 'raw');
const SHOTS = path.join(runDir, 'shots');
const client = await connect({ cdpPort });
await client.send('Runtime.enable', {});

const fillExpr = '(() => { const inp = Array.from(document.querySelectorAll(\'input\')).find((i) => String(i.getAttribute(\'placeholder\') || \'\').includes(\'dsh-plugin-whale-pet\')); if (!inp) return { ok: false, why: \'no-input\' }; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, \'value\').set; setter.call(inp, ' + JSON.stringify(spec) + '); inp.dispatchEvent(new Event(\'input\', { bubbles: true })); return { ok: true, value: inp.value }; })()';
const fill = pollOnly ? { skipped: true } : await client.evaluate(fillExpr);
await new Promise((r) => setTimeout(r, 400));
const clickExpr = "(() => { const dlg = document.querySelector('[role=dialog]'); const bs = Array.from(dlg.querySelectorAll('button')); const b = bs.find((x) => String(x.innerText || '').trim() === '安装'); if (!b) return { clicked: false, candidates: bs.map((x) => String(x.innerText || '').trim().slice(0, 20)).filter(Boolean) }; b.click(); return { clicked: true, disabledAfter: b.disabled }; })()";
const clicked = pollOnly ? { skipped: true } : await client.evaluate(clickExpr);
const dialogText = "(() => { const d = document.querySelector('[role=dialog]'); return d ? String(d.innerText || '').replace(/\\s+/g, ' ').slice(0, 600) : null; })()";
const samples = [];
let done = false;
for (let i = 0; i < 60; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const t = await client.evaluate(dialogText);
  samples.push({ i, t });
  if (t == null) { done = true; break; }
  if (/安装完成|安装失败|已安装完成|应用重启|重启(以|后)生效/.test(t)) { done = true; break; }
  if (!/安装中/.test(t) && /完成|失败|错误/.test(t)) { done = true; break; }
}
await client.screenshot(path.join(SHOTS, 'a5-desktop-install-result.png'));
const out = { spec, fill, clicked, done, last: samples[samples.length - 1], samples: samples.filter((s, i) => i % 3 === 0 || i === samples.length - 1) };
fs.writeFileSync(path.join(RAW, '24-channel-a-install.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ spec, fill, clicked, done, last: out.last }, null, 2).slice(0, 2000));
client.close();