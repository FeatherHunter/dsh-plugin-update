#!/usr/bin/env node
// 从 CHANGELOG.md 里取某个版本的该节正文，给 GitHub Release 当说明用。
// 目的：Release 说明与 CHANGELOG 同一份来源，发版时不再手抄一遍（抄就会漂）。
//
// 用法：
//   node scripts/release-notes.mjs 0.16.2           # 打印该节正文（不含标题行）
//   node scripts/release-notes.mjs 0.16.2 --title   # 只打印标题行
//   node scripts/release-notes.mjs 0.16.2 --check   # 只校验该节在不在（在=0，不在=1，不打印）
//
// 退出码：0 = 找到；1 = 没有这一节（或参数不对）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHANGELOG = join(HERE, '..', 'CHANGELOG.md');

/** 取出 `## [<version>] …` 这一节的标题与正文；没有这一节时返回 null。 */
export function releaseNotes(markdown, version) {
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s*\\[${escaped}\\]`);
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return {
    title: lines[start].replace(/^##\s*/, '').trim(),
    body: lines.slice(start + 1, end).join('\n').replace(/^\n+/, '').replace(/\n+$/, ''),
  };
}

function main(argv) {
  const version = argv.find((arg) => !arg.startsWith('--'));
  const wantsTitle = argv.includes('--title');
  const checkOnly = argv.includes('--check');
  if (!version) {
    process.stderr.write('用法：node scripts/release-notes.mjs <版本号> [--title|--check]\n');
    return 1;
  }
  let markdown;
  try {
    markdown = readFileSync(CHANGELOG, 'utf8');
  } catch (error) {
    process.stderr.write(`读不到 CHANGELOG.md：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const section = releaseNotes(markdown, version);
  if (!section) {
    if (!checkOnly) process.stderr.write(`CHANGELOG.md 里没有 [${version}] 这一节\n`);
    return 1;
  }
  if (checkOnly) return 0;
  process.stdout.write(`${wantsTitle ? section.title : section.body}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
