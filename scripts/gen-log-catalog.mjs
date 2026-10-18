#!/usr/bin/env node
// 从仓库根的 event-list.update.json（日志契约清单）机器生成事件目录里事件表
// （当前 §1 常驻、§2 按需两张）的前三列：事件码 / 级别 / 字段白名单。第四列「说明与脱敏」是给人读的，一字不动。
//
// 目的（#206）：契约一变，目录的字段列就要手工同步，容易漏；把机器能算的列交给清单，
// 人只维护第四列说明。脚本只按事件名匹配已有行，不负责增删行。
//
// 用法：
//   node scripts/gen-log-catalog.mjs            # 写盘：重生成事件表前三列，打印改写了多少行
//   node scripts/gen-log-catalog.mjs --check    # 只检查：行存在但前三列 drift → exit 1；
//                                              # 清单有事件而目录缺行 → 警告，不失败
//
// 边界（刻意如此，勿随手放宽）：
// - 「事件表」按表头 `| 事件码 | 级别 | 字段白名单 | 说明与脱敏 |` 识别，不按章节号硬编码。
//   当前是 §1 常驻（resident）与 §2 按需（ondemand）两张；§3 / §3.1 / §5 / §7 / §8 / §9 的其它表不碰。
// - 字段列只把「字段集合与顺序」交给清单：清单只声明字段名（外加部分枚举），
//   不声明可选性与类型；列里既有的 `?` / `: '枚举'` / `: boolean` 等注记保留现状，重建会把它们抹掉。
//   新增字段以 `` `字段名` `` 形式补入；清单里没有的字段会被删掉（删字段是真实 drift）。
// - 清单有事件而目录缺行只警告、不自动插行：第四列人话机器造不出来，硬插一行等于编造。
// - 表头、对齐行、其余章节、行尾空白一字不动；没 drift 时不写盘（幂等）。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MANIFEST_PATH = join(ROOT, 'event-list.update.json');
const CATALOG_PATH = join(ROOT, 'docs', 'research', '20261014-log-event-catalog.md');

/** 事件表表头（四列，顺序固定）。只认这一种表，避免误改目录里其它表格。 */
const EVENT_TABLE_HEADER = ['事件码', '级别', '字段白名单', '说明与脱敏'];
/** 字段为空时目录里的写法。 */
const EMPTY_FIELD_CELL = '—';
/** 清单里事件的合法级别。 */
const LEVELS = new Set(['info', 'warn', 'error']);

/**
 * 按未转义的 `|` 切一行 markdown 表格；不是表格行时返回 null。
 * 表格里的转义竖线写作 `\|`，切开时会原样保留，保证字段列能逐字复用。
 */
export function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const cells = [];
  let current = '';
  for (let i = 1; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '\\|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  // 合法的表格行以 `|` 收尾，最后一个竖线之后只剩空白。
  if (current.trim() !== '') return null;
  return cells;
}

/**
 * 拆一行四列事件行：前三格（事件码 / 级别 / 字段白名单）不含裸 `|`，
 * 第四格（说明与脱敏）里可能出现未转义的 `|`（如 update.lock.anomaly 里「用 `|` 连接后哈希」），
 * 所以只在前三个未转义竖线处切，剩余部分整体当说明列，保证第四列逐字复用。
 */
function splitEventRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const cuts = [];
  for (let i = 1; i < trimmed.length && cuts.length < 3; i += 1) {
    if (trimmed[i] === '\\') {
      i += 1;
      continue;
    }
    if (trimmed[i] === '|') cuts.push(i);
  }
  if (cuts.length < 3) return null;
  let description = trimmed.slice(cuts[2] + 1);
  if (description.endsWith('|')) description = description.slice(0, -1);
  return [
    trimmed.slice(1, cuts[0]).trim(),
    trimmed.slice(cuts[0] + 1, cuts[1]).trim(),
    trimmed.slice(cuts[1] + 1, cuts[2]).trim(),
    description.trim(),
  ];
}

/** 对齐行：每格都是 `---` / `:---` / `---:` / `:---:`。 */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/** 找出目录里所有事件表，返回每张表的表头行号与数据行区间（左闭右开，0 基）。 */
export function findEventTables(lines) {
  const tables = [];
  for (let i = 0; i < lines.length; i += 1) {
    const cells = splitTableRow(lines[i]);
    if (!cells || cells.length !== EVENT_TABLE_HEADER.length) continue;
    if (!EVENT_TABLE_HEADER.every((header, index) => cells[index] === header)) continue;
    const separator = splitTableRow(lines[i + 1] ?? '');
    if (!separator || !isSeparatorRow(separator) || separator.length !== cells.length) {
      throw new Error(`第 ${i + 1} 行是事件表表头，但第 ${i + 2} 行不是四列对齐行`);
    }
    let end = i + 2;
    while (end < lines.length && lines[end].trim().startsWith('|')) end += 1;
    tables.push({ headerLineNo: i + 1, firstRowIndex: i + 2, endRowIndex: end });
    i = end - 1;
  }
  return tables;
}

/**
 * 拆字段列：`` `字段` `` / `` `字段?` `` / `` `字段: 注记` `` 以「、」连接；空列写作 `—`。
 * 只取字段名（base）用于和清单比对，整段 token 原样保留，注记不重建。
 */
export function parseFieldCell(cell) {
  const trimmed = cell.trim();
  if (trimmed === '' || trimmed === EMPTY_FIELD_CELL) return [];
  return trimmed.split('、').map((raw) => {
    const token = raw.trim();
    const match = /^`([A-Za-z][A-Za-z0-9]*)([^`]*)`$/.exec(token);
    if (!match) {
      throw new Error(`字段列片段不是「反引号包字段名」的形式：${JSON.stringify(token)}`);
    }
    return { base: match[1], token };
  });
}

/** 按清单字段（顺序）重排字段列；命名字段保留原 token，新字段以纯字段名补入。 */
export function renderFieldCell(existingTokens, fields) {
  if (fields.length === 0) return EMPTY_FIELD_CELL;
  const tokenByBase = new Map(existingTokens.map((token) => [token.base, token]));
  return fields
    .map((field) => {
      const existing = tokenByBase.get(field);
      return existing ? existing.token : '`' + field + '`';
    })
    .join('、');
}

/** 解析事件表里的一行数据；第一列必须是反引号包的事件名。 */
function parseEventRow(line, lineNo) {
  const cells = splitEventRow(line);
  if (!cells) {
    throw new Error(`第 ${lineNo} 行不是四列事件行：${JSON.stringify(line)}`);
  }
  const match = /^`([a-z][a-z0-9.-]*)`$/.exec(cells[0]);
  if (!match) {
    throw new Error(`第 ${lineNo} 行的事件码不是「反引号包事件名」的形式：${JSON.stringify(cells[0])}`);
  }
  return {
    lineNo,
    event: match[1],
    eventCell: cells[0],
    level: cells[1],
    fieldCell: cells[2],
    description: cells[3],
  };
}

/** 把字段列的差异说成人话：补了哪些字段、删了哪些字段、顺序是否变了。 */
function describeFieldDrift(currentTokens, expectedTokens) {
  const currentBases = currentTokens.map((token) => token.base);
  const expectedBases = expectedTokens.map((token) => token.base);
  const added = expectedBases.filter((field) => !currentBases.includes(field));
  const removed = currentBases.filter((field) => !expectedBases.includes(field));
  const parts = [];
  if (added.length > 0) parts.push(`补字段 ${added.map((field) => '`' + field + '`').join('、')}`);
  if (removed.length > 0) parts.push(`删字段 ${removed.map((field) => '`' + field + '`').join('、')}`);
  const currentCommon = currentBases.filter((field) => expectedBases.includes(field));
  const expectedCommon = expectedBases.filter((field) => currentBases.includes(field));
  if (added.length === 0 && removed.length === 0 && currentCommon.join(',') !== expectedCommon.join(',')) {
    parts.push(`字段顺序 ${currentCommon.map((field) => '`' + field + '`').join('、')} → ${expectedCommon.map((field) => '`' + field + '`').join('、')}`);
  }
  return `字段列 ${parts.length > 0 ? parts.join('；') : '（列内容与清单不一致）'}`;
}

/** 校验清单形状，坏清单早失败，别拿半张表去改文档。 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || !manifest.events || typeof manifest.events !== 'object') {
    throw new Error('event-list.update.json 缺少 events 对象');
  }
  for (const [name, entry] of Object.entries(manifest.events)) {
    if (!LEVELS.has(entry?.level)) {
      throw new Error(`清单事件 ${name} 的 level 非法：${JSON.stringify(entry?.level)}`);
    }
    if (!Array.isArray(entry.fields) || !entry.fields.every((field) => typeof field === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(field))) {
      throw new Error(`清单事件 ${name} 的 fields 不是字段名数组`);
    }
    if (new Set(entry.fields).size !== entry.fields.length) {
      throw new Error(`清单事件 ${name} 的 fields 有重复`);
    }
  }
}

/**
 * 比对清单与目录，返回：要改的行、缺行的警告、行数统计。不落盘。
 * @returns {{ eol: string, lines: string[], tables: object[], rows: object[], changes: object[], warnings: string[] }}
 */
export function planCatalog(manifest, catalogText) {
  const eol = catalogText.includes('\r\n') ? '\r\n' : '\n';
  const lines = catalogText.split(eol);
  const tables = findEventTables(lines);
  if (tables.length === 0) {
    throw new Error('目录里没有找到四列事件表（表头：| 事件码 | 级别 | 字段白名单 | 说明与脱敏 |）');
  }
  const changes = [];
  const warnings = [];
  const rows = [];
  const seenEvents = new Set();
  for (const table of tables) {
    for (let index = table.firstRowIndex; index < table.endRowIndex; index += 1) {
      const row = parseEventRow(lines[index], index + 1);
      rows.push(row);
      if (seenEvents.has(row.event)) {
        warnings.push(`第 ${row.lineNo} 行的事件 ${row.event} 在目录里重复出现（仍按清单校正）`);
      }
      seenEvents.add(row.event);
      const entry = manifest.events[row.event];
      if (!entry) {
        warnings.push(`第 ${row.lineNo} 行的事件 ${row.event} 不在契约清单中（跳过，不失败）`);
        continue;
      }
      const expectedLevel = entry.level;
      const currentTokens = parseFieldCell(row.fieldCell);
      const expectedFieldCell = renderFieldCell(currentTokens, entry.fields);
      const expectedTokens = parseFieldCell(expectedFieldCell);
      const diffs = [];
      if (row.level !== expectedLevel) {
        diffs.push(`级别 ${row.level} → ${expectedLevel}`);
      }
      if (row.fieldCell !== expectedFieldCell) {
        diffs.push(describeFieldDrift(currentTokens, expectedTokens));
      }
      if (diffs.length > 0) {
        changes.push({
          lineNo: row.lineNo,
          lineIndex: index,
          event: row.event,
          diffs,
          level: expectedLevel,
          fieldCell: expectedFieldCell,
          description: row.description,
        });
      }
    }
  }
  for (const name of Object.keys(manifest.events)) {
    if (!seenEvents.has(name)) {
      warnings.push(`清单事件 ${name} 在目录中没有行（缺行只警告，不失败）`);
    }
  }
  return { eol, lines, tables, rows, changes, warnings };
}

/** 把计划里的改动写回行数组（只重建被改的那几行，其余行一字不动）。 */
export function applyChanges(lines, changes) {
  const next = [...lines];
  for (const change of changes) {
    next[change.lineIndex] = '| `' + change.event + '` | ' + change.level + ' | ' + change.fieldCell + ' | ' + change.description + ' |';
  }
  return next;
}

function printUsage() {
  process.stderr.write('用法：node scripts/gen-log-catalog.mjs [--check]\n');
}

function main(argv) {
  const unknown = argv.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    process.stderr.write(`不认识的参数：${unknown.join(' ')}\n`);
    printUsage();
    process.exitCode = 1;
    return;
  }
  const checkOnly = argv.includes('--check');

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    validateManifest(manifest);
  } catch (error) {
    process.stderr.write(`读不了契约清单 event-list.update.json：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  let catalogText;
  try {
    catalogText = readFileSync(CATALOG_PATH, 'utf8');
  } catch (error) {
    process.stderr.write(`读不了事件目录 docs/research/20261014-log-event-catalog.md：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  let plan;
  try {
    plan = planCatalog(manifest, catalogText);
  } catch (error) {
    process.stderr.write(`解析事件目录失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    if (checkOnly) {
      if (plan.changes.length === 0) {
        process.stdout.write(`OK：${plan.tables.length} 张事件表、${plan.rows.length} 行前三列与 event-list.update.json 一致。\n`);
        process.exitCode = 0;
      } else {
        process.stdout.write(`检测到 ${plan.changes.length} 行与契约清单不一致（drift）：\n`);
        for (const change of plan.changes) {
          process.stdout.write(`  ${change.event}（第 ${change.lineNo} 行）\n`);
          for (const diff of change.diffs) process.stdout.write(`    - ${diff}\n`);
        }
        process.exitCode = 1;
      }
    } else if (plan.changes.length === 0) {
      process.stdout.write(`无变化：${plan.tables.length} 张事件表、${plan.rows.length} 行前三列已与契约清单一致，未写盘。\n`);
      process.exitCode = 0;
    } else {
      writeFileSync(CATALOG_PATH, applyChanges(plan.lines, plan.changes).join(plan.eol), 'utf8');
      process.stdout.write(`已改写 ${plan.changes.length} 行（共 ${plan.tables.length} 张事件表、${plan.rows.length} 行）：\n`);
      for (const change of plan.changes) {
        process.stdout.write(`  ${change.event}（第 ${change.lineNo} 行）：${change.diffs.join('；')}\n`);
      }
      process.stdout.write(`已写回 ${CATALOG_PATH}\n`);
      process.exitCode = 0;
    }
  } catch (error) {
    process.stderr.write(`写回事件目录失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  for (const warning of plan.warnings) {
    process.stderr.write(`警告：${warning}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
