#!/usr/bin/env node
/**
 * T0 spike：维护者 desktop profile 的只读指纹（throwaway）。
 * 用途：证明本票前后「维护者当前 DSH profile 未被改动」。
 * 只读：open/stat/readdir，不写目标目录。
 *
 * 用法： node profile-fingerprint.mjs <profileDir> <out.json>
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const profileDir = process.argv[2];
const outPath = process.argv[3];
if (!profileDir || !outPath) { console.error('用法：node profile-fingerprint.mjs <profileDir> <out.json>'); process.exit(2); }

function sha256File(file) {
  try {
    return { sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), bytes: fs.statSync(file).size, mtime: fs.statSync(file).mtime.toISOString() };
  } catch (e) {
    return { error: String(e?.code ?? e) };
  }
}

function listTop(dir) {
  try {
    const names = fs.readdirSync(dir, { withFileTypes: true })
      .map((d) => ({ name: d.name, kind: d.isDirectory() ? 'dir' : 'file' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { count: names.length, entries: names, digest: crypto.createHash('sha256').update(names.map((n) => n.kind + ':' + n.name).join('\n')).digest('hex') };
  } catch (e) {
    return { error: String(e?.code ?? e) };
  }
}

const files = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const out = {
  capturedAt: new Date().toISOString(),
  profileDir,
  profileDirExists: fs.existsSync(profileDir),
  files: Object.fromEntries(files.map((f) => [f, sha256File(path.join(profileDir, f))])),
  pluginManagerDir: listTop(path.join(profileDir, '.plugin-manager')),
  nodeModulesTop: listTop(path.join(profileDir, 'node_modules')),
};
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(path.resolve(outPath), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ out: path.resolve(outPath), files: Object.fromEntries(Object.entries(out.files).map(([k, v]) => [k, v.sha256 ?? v.error])), pluginManagerCount: out.pluginManagerDir.count, nodeModulesCount: out.nodeModulesTop.count }, null, 2));
