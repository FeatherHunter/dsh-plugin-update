#!/usr/bin/env node
/**
 * scripts/rewrite-dist-imports.mjs —— src/ 域化搬家的深引用 codemod（#225 tracer 交付，后续域票复用）。
 *
 * 为什么要有它：tests/ 与 scripts/ 直接按编译产物路径 import（'../dist/panel.js' 一类，实测
 * 335 处字面量 + 23 处 join(PKG_DIR, 'dist', ...)）。蓝图把 src/ 重排成域目录后 dist/ 同构改名，
 * 这些深引用如果靠人手改，一个域票几百行、极易漏改。本脚本把「映射表 + 源码树现状」变成一个命令：
 * 搬之前跑只会报告，搬之后跑只改「已搬」的那些，重复跑零 diff。
 *
 * 用法（仓根）：
 *   node scripts/rewrite-dist-imports.mjs             # 只读报告（默认；含待搬清单、人工清单、源码直读清单）
 *   node scripts/rewrite-dist-imports.mjs --apply     # 真改文件
 *   node scripts/rewrite-dist-imports.mjs --check     # 手动校验：还有该改而未改的引用 / 人工清单非空 → exit 1
 *（本仓地图 Out of scope 明确不加新门禁，故 --check 不接入 npm run check / package.json，只在域票收尾前手动跑。）
 *
 * 判据（唯一的「已搬」定义，与 dist 无关）：
 *   整搬模块：旧 src 文件不存在 且 新 src 文件存在；
 *   拆分模块：旧 src 文件不存在 且 蓝图列出的每个新 src 文件都存在（否则算 partial，不改）。
 * 所以搬迁动作永远是「先 git mv / 先写新文件，再跑本脚本」；脚本本身不搬任何源码。
 *
 * 拆分模块（store / changelog / bilingual）的具名 import 按「新 src 谁导出这个名字」自动分派，
 * 映射在运行时从新文件里解析（含 export { ... } / export * from 链），不手抄导出表：
 *   静态 import { a, b } from '../dist/store.js'      → 按名拆成多条 import
 *   动态 const { a, b } = await import(...)           → 按名拆成多条 const
 *   namespace（import * as / const mod = await import(...)）与读产物文本（readFileSync/new URL）
 *   无法按名分派 → 进人工清单，交给所属域票手改。
 *
 * 公开入口壳（SHELLS）的 dist 路径搬家后不变，深引用本来就零改，脚本不碰它们。
 * 本文件自检：tests/rewrite-dist-imports.test.mjs。
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DIST_PREFIX = '../dist/'

// ---------- 蓝图映射表（唯一真源：docs/research/20261019-src-restructure-blueprint.md §3/§4） ----------

/** 10 个公开入口壳：搬家后 dist 路径不变（exports 十子路径冻结），深引用零改。列出只为报告时说明「为什么不改」。 */
export const SHELLS = [
  'host.js',
  'host-batch.js',
  'panel.js',
  'panel-batch.js',
  'install-button.js',
  'client.js',
  'entry.js',
  'entry-batch.js',
  'http.js',
  'log/index.js',
]

/** 整搬：旧 dist 相对路径 → 新 dist 相对路径（src 路径同构，.js 换 .ts）。 */
export const SINGLE = {
  'batch.js': 'core/batch/model.js',
  'batch-run.js': 'core/batch/run.js',
  'changelog-io.js': 'core/changelog/io.js',
  'check-conclusion.js': 'core/conclusion.js',
  'codes.js': 'shared/codes.js',
  'commands.js': 'shared/commands.js',
  'compliant-version.js': 'shared/compliant.js',
  'config.js': 'shared/config.js',
  'diag.js': 'shared/diag.js',
  'gate.js': 'core/gate.js',
  'hash.js': 'shared/hash.js',
  'host-batch-log.js': 'host/batch/log.js', // 蓝图 §4 待定 #2：暂定 host 域；若最终定 shared/batch-log.ts，改这一行即可
  'host-forwarding.js': 'host/forwarding.js',
  'install-cause.js': 'core/cause.js',
  'install-fail.js': 'core/failure.js',
  'lang.js': 'shared/lang.js',
  'last-resort.js': 'shared/last-resort.js',
  'log-events.js': 'shared/log-events.js',
  'manual-absent.js': 'shared/manual-absent.js',
  'panel-copy.js': 'shared/copy.js',
  'ports.js': 'shared/ports.js',
  'queue.js': 'core/queue/model.js',
  'reader.js': 'core/reader.js',
  'redaction.js': 'shared/redaction.js',
  'registry-fetch.js': 'core/fetch.js',
  'self.js': 'shared/self.js',
  'service.js': 'core/service.js',
  'version-judgment.js': 'core/judgment.js',
}

/**
 * 拆分：旧 dist 相对路径 → 新模块 dist 相对路径清单（导出名按运行时新文件解析）。
 * 蓝图 §3.2 已经把三个神文件各拆到哪些新模块定死，所以映射现在就写全；这不是为未发生的搬迁投机，
 * 而是域票搬完当天跑 --apply 就能一次改对（新增/改名导出仍进人工清单）。
 */
export const SPLIT = {
  'bilingual.js': ['core/i18n/dictionary.js', 'core/i18n/text.js', 'core/i18n/styles.js'],
  'changelog.js': [
    'core/changelog/parse.js',
    'core/changelog/render-model.js',
    'core/changelog/validator.js',
  ],
  'store.js': ['core/disk.js', 'core/queue/ports.js', 'core/executor.js'],
}

/** 扫描根：深引用的实际所在地。fixtures / .tmp 里的样例文件不是真引用，跳过。 */
const SCAN_ROOTS = ['tests', 'scripts', 'demo', 'derive-client-values.mjs']

/** 本脚本与它的 fixture 里故意留着旧路径字面量，不能自己改自己。 */
const SCAN_SKIP = new Set(['tests/rewrite-dist-imports.test.mjs', 'scripts/rewrite-dist-imports.mjs'])

// ---------- 纯函数（供测试直接调用） ----------

/** dist 相对路径 → src 相对路径（build.mjs 同构口径）。 */
export function srcFileOf(distRel) {
  return 'src/' + distRel.replace(/\.js$/, '.ts')
}

/**
 * 源码树现状 → 每个模块的状态。
 * 返回 { single: { [旧dist]: 'moved'|'pending' }, split: { [旧dist]: { state, nameIndex?, missing? } } }。
 * nameIndex: Map<导出名, 新dist相对路径>；名字在两处都导出时值为 null（歧义，进人工清单）。
 */
export function buildStatus(root = process.cwd()) {
  const single = {}
  for (const [oldRel, newRel] of Object.entries(SINGLE)) {
    const oldSrc = srcFileOf(oldRel)
    const newSrc = srcFileOf(newRel)
    single[oldRel] = !existsSync(join(root, oldSrc)) && existsSync(join(root, newSrc)) ? 'moved' : 'pending'
  }

  const split = {}
  for (const [oldRel, modules] of Object.entries(SPLIT)) {
    const oldSrc = srcFileOf(oldRel)
    const missing = modules.filter((m) => !existsSync(join(root, srcFileOf(m))))
    if (existsSync(join(root, oldSrc))) {
      split[oldRel] = { state: 'pending' }
    } else if (missing.length) {
      split[oldRel] = { state: 'partial', missing }
    } else {
      split[oldRel] = { state: 'moved', nameIndex: buildNameIndex(root, modules) }
    }
  }

  return { single, split }
}

/**
 * 从「拆分后的新 src 文件」里解析导出名 → 新 dist 路径。
 * 支持 export 声明、export { a, b as c }、export * from './x.js' 链（相对路径递归解析）。
 */
export function buildNameIndex(root, distModules) {
  const cache = new Map()
  const load = (srcRel) => {
    if (cache.has(srcRel)) return cache.get(srcRel)
    const full = join(root, srcRel)
    const entry = { names: new Set(), stars: [] }
    cache.set(srcRel, entry)
    if (!existsSync(full)) return entry
    const text = readFileSync(full, 'utf8')
    for (const m of text.matchAll(/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z0-9_$]+)/g)) {
      entry.names.add(m[1])
    }
    for (const m of text.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g)) {
      for (const item of m[1].split(',')) {
        const parts = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)
        const exported = (parts[1] || parts[0] || '').trim()
        if (exported) entry.names.add(exported)
      }
    }
    for (const m of text.matchAll(/\bexport\s+\*\s+from\s+['"]([^'"]+)['"]/g)) {
      entry.stars.push(posixJoin(dirname(srcRel).split('\\').join('/'), m[1]))
    }
    return entry
  }

  // 第一遍：直接导出（实现就在这个模块）优先落表；两个模块直接导出同名 → 歧义。
  const index = new Map()
  for (const distRel of distModules) {
    for (const name of load(srcFileOf(distRel)).names) {
      const prev = index.has(name) ? index.get(name) : undefined
      if (prev === undefined) index.set(name, distRel)
      else if (prev !== distRel) index.set(name, null)
    }
  }
  // 第二遍：export * 链补「没有直接导出」的名字；链之间冲突才判歧义（直接导出永远优先）。
  const starOwned = new Set()
  const collectStarNames = (srcRel, distRel, seen) => {
    if (seen.has(srcRel)) return
    seen.add(srcRel)
    const entry = load(srcRel)
    for (const name of entry.names) {
      if (!index.has(name)) {
        index.set(name, distRel)
        starOwned.add(name)
      } else if (starOwned.has(name) && index.get(name) !== null && index.get(name) !== distRel) {
        index.set(name, null)
      }
    }
    for (const star of entry.stars) collectStarNames(star, distRel, seen)
  }
  for (const distRel of distModules) {
    for (const star of load(srcFileOf(distRel)).stars) collectStarNames(star, distRel, new Set())
  }
  return index
}


function posixJoin(dir, rel) {
  const parts = (dir + '/' + rel).split('/')
  const out = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

function isMoved(status, oldRel) {
  return status.single[oldRel] === 'moved'
}

/** 'a, b as c' → [{ imported: 'a', local: 'a' }, { imported: 'b', local: 'c' }] */
export function parseSpecifiers(text) {
  const out = []
  for (const raw of text.split(',')) {
    const item = raw.trim().replace(/^type\s+/, '')
    if (!item) continue
    const parts = item.split(/\s+as\s+/)
    const imported = parts[0].trim()
    const local = (parts[1] || parts[0]).trim()
    if (imported) out.push({ imported, local })
  }
  return out
}

/** 'a, b: c'（解构）→ [{ imported: 'a', local: 'a' }, { imported: 'b', local: 'c' }] */
function parseDestructured(text) {
  const out = []
  for (const raw of text.split(',')) {
    const item = raw.trim()
    if (!item) continue
    const parts = item.split(':')
    const imported = parts[0].trim()
    const local = (parts[1] || parts[0]).trim()
    if (imported) out.push({ imported, local })
  }
  return out
}

function specifiersText(items) {
  return items.map((s) => (s.imported === s.local ? s.imported : s.imported + ' as ' + s.local)).join(', ')
}

/**
 * 拆分模块的具名条目按导入名分派到新模块（静态 import 与动态解构共用；条目形状都是 { imported, local }）。
 * 任一条目找不到（或同名多处 = 歧义）→ 返回 null，整条引用保持原文并记人工清单，交给所属域票手改。
 */
function groupByExport(items, split, oldRel, manual) {
  const groups = new Map()
  for (const item of items) {
    const target = split.nameIndex.get(item.imported)
    if (!target) {
      manual.push({ kind: 'split-name', file: null, line: null, oldRel, name: item.imported, why: '新模块里找不到（或有多处）这个导出名' })
      return null
    }
    if (!groups.has(target)) groups.set(target, [])
    groups.get(target).push(item)
  }
  return groups
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

function lineTextAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1
  const end = text.indexOf('\n', index)
  return text.slice(start, end === -1 ? text.length : end).trim()
}

/** join(BASE, 'dist', 'x.js') 形态：捕获 base 与后续段（base 只认裸标识符链，复杂表达式留给人工清单）。 */
const JOIN_DIST_RE = /(\bjoin\(\s*)([A-Za-z0-9_$.]+)(\s*,\s*)(['"])dist\4((?:\s*,\s*['"][^'"]*['"])+)/g

/**
 * join 形态里认哪些 base 是「仓库根」：只认显式仓库根常量（PKG_DIR / ROOT …）。
 * 测试会造**假安装副本**（临时目录变量 pkg / root）并在里面写 dist/self.js 一类假产物：
 * 那不是本包产物，路径里的 dist 段不能按搬家映射改（改了会变成不存在的 dist/shared/… 直接 ENOENT）。
 * #225 Spec review 实测：self.js→shared/self.js 后 join(pkg,'dist','self.js') 会被误改。
 * 代价：真仓里若出现别名 base（const D = PKG_DIR）的 join 不会被改写——报告里对应模块的深引计数仍可见。
 */
const JOIN_REPO_BASES = new Set(['PKG_DIR', 'ROOT', 'ROOT_DIR', 'PKG_ROOT', 'REPO_ROOT'])

/** 静态具名 import：import { a, b } from '../dist/x.js'（可跨行）。 */
const STATIC_NAMED_RE = /(^|\n)([ \t]*)import\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])(\.\.\/dist\/[^'"]+)\5[ \t]*;?/g

/** 动态解构 import：const { a, b } = await import('../dist/x.js')（可跨行）。 */
const DYN_DESTRUCT_RE = /(^|\n)([ \t]*)(const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*(['"])(\.\.\/dist\/[^'"]+)\5\s*\)([ \t]*;?)/g

/**
 * 核心：把一段文本里对「已搬模块」的深引用改到新路径。
 * 返回 { text, applied: [...], manual: [...], changed }；纯函数，不碰文件系统。
 */
export function rewriteText(text, status) {
  let out = text
  const applied = []
  const manual = []

  // 1) 整搬模块：字面量替换（静态 import / 动态 import / new URL / readFileSync 全覆盖）
  for (const [oldRel, newRel] of Object.entries(SINGLE)) {
    if (!isMoved(status, oldRel)) continue
    for (const quote of ["'", '"']) {
      const needle = quote + DIST_PREFIX + oldRel + quote
      if (!out.includes(needle)) continue
      out = out.split(needle).join(quote + DIST_PREFIX + newRel + quote)
      applied.push({ kind: 'single', from: oldRel, to: newRel })
    }
  }

  // 2) 整搬模块：join(BASE, 'dist', 'x.js') → 按新路径拆段
  out = out.replace(JOIN_DIST_RE, (match, head, base, sep, distQuote, rest) => {
    if (!JOIN_REPO_BASES.has(base)) return match
    const segs = []
    for (const m of rest.matchAll(/['"]([^'"]*)['"]/g)) segs.push(m[1])
    const oldRel = segs.join('/')
    if (!isMoved(status, oldRel)) return match
    const newRel = SINGLE[oldRel]
    applied.push({ kind: 'join', from: oldRel, to: newRel })
    const parts = ['dist', ...newRel.split('/')].map((p) => "'" + p + "'").join(', ')
    return head + base + sep + parts
  })

  // 3) 拆分模块：静态具名 import 按导出名分派
  out = out.replace(STATIC_NAMED_RE, (match, lead, indent, typeKw, namesText, quote, spec) => {
    const oldRel = spec.slice(DIST_PREFIX.length)
    const split = status.split[oldRel]
    if (!split || split.state !== 'moved') return match
    const items = parseSpecifiers(namesText)
    if (!items.length) return match
    const groups = groupByExport(items, split, oldRel, manual)
    if (!groups) return match
    const lines = []
    for (const [target, group] of groups) {
      lines.push('import ' + (typeKw || '') + '{ ' + specifiersText(group) + " } from '.." + '/dist/' + target + "'")
      applied.push({ kind: 'split-static', from: oldRel, to: target, names: group.map((g) => g.imported) })
    }
    return lead + indent + lines.join('\n' + indent)
  })

  // 4) 拆分模块：动态解构 import 按导出名分派
  out = out.replace(DYN_DESTRUCT_RE, (match, lead, indent, kind, namesText, quote, spec, tail) => {
    const oldRel = spec.slice(DIST_PREFIX.length)
    const split = status.split[oldRel]
    if (!split || split.state !== 'moved') return match
    const items = parseDestructured(namesText)
    if (!items.length) return match
    const groups = groupByExport(items, split, oldRel, manual)
    if (!groups) return match
    const lines = []
    for (const [target, group] of groups) {
      lines.push(kind + ' { ' + specifiersText(group) + " } = await import('" + DIST_PREFIX + target + "')")
      applied.push({ kind: 'split-dynamic', from: oldRel, to: target, names: group.map((g) => g.imported) })
    }
    lines[lines.length - 1] += tail || ''
    return lead + indent + lines.join('\n' + indent)
  })

  // 5) 拆分模块里改不动的引用：留在文本里 → 人工清单（所属域票手改）
  for (const [oldRel, split] of Object.entries(status.split)) {
    if (split.state !== 'moved') continue
    const needle = DIST_PREFIX + oldRel
    let idx = out.indexOf(needle)
    while (idx !== -1) {
      const line = lineTextAt(out, idx)
      pushManual(manual, { kind: classifySplitRef(line), line: lineOf(out, idx), oldRel, snippet: line })
      idx = out.indexOf(needle, idx + needle.length)
    }
  }
  // join(BASE, 'dist', '<拆分模块>') 形态没有 '../dist/' 字面量，单独抓（同样只认仓库根 base）
  for (const m of out.matchAll(JOIN_DIST_RE)) {
    if (!JOIN_REPO_BASES.has(m[2])) continue
    const segs = []
    for (const sm of m[5].matchAll(/'([^']*)'|"([^"]*)"/g)) segs.push(sm[1] ?? sm[2])
    const oldRel = segs.join('/')
    const split = status.split[oldRel]
    if (!split || split.state !== 'moved') continue
    pushManual(manual, {
      kind: 'split-join',
      line: lineOf(out, m.index),
      oldRel,
      snippet: lineTextAt(out, m.index),
    })
  }

  return { text: out, applied, manual, changed: out !== text }
}

function pushManual(list, item) {
  if (list.some((m) => m.line === item.line && m.kind === item.kind && m.oldRel === item.oldRel)) return
  list.push(item)
}

function classifySplitRef(line) {
  if (/import\s*\*/.test(line)) return 'split-namespace-static'
  if (/readFileSync|new URL/.test(line)) return 'split-text-read'
  if (/\bjoin\(/.test(line)) return 'split-join'
  if (/await\s+import|import\(/.test(line)) return 'split-namespace-dynamic'
  return 'split-unhandled'
}

/** 引用计数（报告用）：字面量 + join 段形态。 */
export function countRefs(text, oldRel) {
  let n = 0
  for (const quote of ["'", '"']) {
    const needle = quote + DIST_PREFIX + oldRel + quote
    let idx = text.indexOf(needle)
    while (idx !== -1) {
      n += 1
      idx = text.indexOf(needle, idx + needle.length)
    }
  }
  for (const m of text.matchAll(JOIN_DIST_RE)) {
    if (!JOIN_REPO_BASES.has(m[2])) continue
    const segs = []
    for (const sm of m[5].matchAll(/['"]([^'"]*)['"]/g)) segs.push(sm[1])
    if (segs.join('/') === oldRel) n += 1
  }
  return n
}

// ---------- 文件遍历与主流程 ----------

const ROOT_DIR = process.cwd()

function collectFiles(root) {
  const files = []
  for (const rel of SCAN_ROOTS) {
    const full = join(root, rel)
    if (!existsSync(full)) continue
    if (statSync(full).isFile()) {
      if (!SCAN_SKIP.has(rel)) files.push(rel)
      continue
    }
    walk(root, rel, files)
  }
  return files
}

function walk(root, rel, files) {
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const childRel = rel + '/' + entry.name
    if (entry.isDirectory()) {
      // 点目录（含 .tmp）与 node_modules 不扫；tests/fixtures 是样例/临时目录，里面的 ../dist/ 不是真引用
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (childRel === 'tests/fixtures') continue
      walk(root, childRel, files)
    } else if (/\.(mjs|cjs|js)$/.test(entry.name)) {
      if (SCAN_SKIP.has(childRel)) continue
      files.push(childRel)
    }
  }
}

/** 源码直读清单（本 codemod 不改它们；留给所属域票：读产物断言 / fake 目录除外）。 */
function collectSrcReads(root, files) {
  const reads = []
  const patterns = [
    /join\(\s*(?:PKG_DIR|ROOT|root|pkgDir)\s*,\s*['"]src['"]/,
    /resolve\(\s*(?:PKG_DIR|ROOT)\s*,\s*['"]src\//,
    /\bCOPY_SOURCE_FILES\b/,
  ]
  for (const rel of files) {
    const text = readFileSync(join(root, rel), 'utf8')
    text.split('\n').forEach((line, i) => {
      if (patterns.some((re) => re.test(line))) reads.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 160) })
    })
  }
  return reads
}

function summarizeStatus(status, fileTexts) {
  const pendingRefs = new Map()
  for (const [oldRel, state] of Object.entries(status.single)) {
    if (state === 'pending') {
      let n = 0
      for (const text of fileTexts) n += countRefs(text, oldRel)
      if (n) pendingRefs.set(oldRel, n)
    }
  }
  const moved = Object.entries(status.single).filter(([, s]) => s === 'moved').map(([k]) => k)
  return { moved, pendingRefs }
}

function main() {
  const argv = process.argv.slice(2)
  const mode = argv.includes('--apply') ? 'apply' : argv.includes('--check') ? 'check' : 'report'
  const root = ROOT_DIR
  const status = buildStatus(root)
  const files = collectFiles(root)
  const fileTexts = []
  const changedFiles = []
  const appliedAll = []
  const manualAll = []

  for (const rel of files) {
    const text = readFileSync(join(root, rel), 'utf8')
    fileTexts.push(text)
    const result = rewriteText(text, status)
    for (const m of result.manual) m.file = rel
    if (result.applied.length) appliedAll.push({ file: rel, applied: result.applied })
    if (result.manual.length) manualAll.push(...result.manual)
    if (result.changed) {
      changedFiles.push(rel)
      if (mode === 'apply') writeFileSync(join(root, rel), result.text, 'utf8')
    }
  }

  const { moved, pendingRefs } = summarizeStatus(status, fileTexts)
  const splitLines = Object.entries(status.split).map(([oldRel, s]) => {
    if (s.state === 'moved') return oldRel + ' → ' + SPLIT[oldRel].join(' + ') + '（已拆，导出名 ' + s.nameIndex.size + ' 个）'
    if (s.state === 'partial') return oldRel + ' → 缺新 src：' + s.missing.join(', ')
    return oldRel + ' → 待拆'
  })

  console.log('== rewrite-dist-imports（' + mode + '）==')
  console.log('映射：整搬 ' + Object.keys(SINGLE).length + ' / 拆分 ' + Object.keys(SPLIT).length + ' / 壳留根 ' + SHELLS.length)
  console.log('扫描：' + files.length + ' 个文件（' + SCAN_ROOTS.join(', ') + '）')
  console.log('已搬整搬模块：' + (moved.length ? moved.join(', ') : '（无）'))
  if (pendingRefs.size) {
    console.log('待搬模块仍有深引用（正常，等所属域票搬）：')
    for (const [rel, n] of [...pendingRefs].sort((a, b) => b[1] - a[1])) console.log('  ' + rel + ' ×' + n)
  }
  console.log('拆分模块：' + splitLines.join('；'))
  if (appliedAll.length) {
    console.log((mode === 'apply' ? '已改' : '待改') + ' ' + changedFiles.length + ' 个文件：')
    for (const { file, applied } of appliedAll) console.log('  ' + file + '（' + applied.length + ' 处）')
  } else {
    console.log('深引用：无待改（已全部对齐当前源码树）')
  }
  const reads = collectSrcReads(root, files)
  if (reads.length) {
    console.log('源码直读清单（本 codemod 不改；留给所属域票改读产物或改路径）：')
    for (const r of reads) console.log('  ' + r.file + ':' + r.line + ' ' + r.snippet)
  }
  if (manualAll.length) {
    console.log('人工清单（拆分后无法按名分派，所属域票手改）：')
    for (const m of manualAll) console.log('  ' + m.file + ':' + (m.line ?? '?') + ' ' + m.kind + ' ' + (m.name || m.oldRel) + ' ' + (m.snippet || ''))
  }

  if (mode === 'check') {
    if (changedFiles.length || manualAll.length) {
      console.log('✗ check 失败：还有 ' + changedFiles.length + ' 个文件该改、' + manualAll.length + ' 条人工清单')
      process.exitCode = 1
    } else {
      console.log('✓ check 通过（手动校验）：深引用与源码树一致，无人工清单')
    }
  }
  if (mode === 'apply' && manualAll.length) {
    console.log('注意：仍有 ' + manualAll.length + ' 条人工清单需要所属域票处理（见上）')
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) main()
