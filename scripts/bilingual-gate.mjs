#!/usr/bin/env node
/**
 * scripts/bilingual-gate.mjs —— 双语化防倒退门禁（#56；契约源 #53 结论 + #57 规格）。
 *
 * 四道检查（默认只跑前三道，第四道用于合入/发布）：
 *
 * 1. 文案源 grep 门禁（中文只许存文案源）：
 *    src/ 下的**中文字符串字面量**只许出现在文案源（COPY_SOURCE_FILES，当前 src/bilingual.ts）；
 *    其余位置按冻结基线 tests/fixtures/bilingual/copy-baseline.json 逐条放行——只许减，不许增。
 *    注释、正则不入账；日志/抛错等冻结中文若要改，必须同步基线，
 *    让改动在评审 diff 里被看见（#53 立约：注释/日志/抛错不动）。
 *
 * 2. 字典快照（每键 en+zh 非空快照）：
 *    每键 en/zh 非空、英文无汉字、中文有汉字、具名槽中英同名同数、键名合约定、
 *    渲染英文在前中文在后；全量 key→en/zh/draft 冻结在 tests/fixtures/bilingual/strings.snapshot.json，
 *    改文案必须同步快照（diff 里看得见），**改文案不换 key**。
 *
 * 3. 契约测试（14 码分支 + 诊断解析契约）：
 *    14 个稳定码（8 阻塞 + 5 电话 + internal）各有文案且只按码分支；未知码走未来兜底；
 *    诊断解析契约：宽容读 diag 对象（16 键，未知键忽略、错类型忽略、永不抛）＋
 *    两种复制形态（三行块 / 单行）都能解析回同一组字段，字段顺序冻结（码 → 摘要 → 来源 → 怎么办）。
 *
 * 4. 零 draft 放行（--release）：字典里还有 draft 就红。母语 + 域内双签转正才放行合入/发布（#57）。
 *
 * 门槛与走法（仓根）：
 *   node scripts/bilingual-gate.mjs                    # 三道硬门禁（改包必跑，随 npm test 一起）
 *   node scripts/bilingual-gate.mjs --release          # 再加零 draft 放行条件（合入主分支/发版）
 *   node scripts/bilingual-gate.mjs --strict-baseline  # 基线不许留已消失的旧条目（迁移收尾）
 *   node scripts/bilingual-gate.mjs --update-baseline  # 重算散落文案基线（须在评审里看见）
 *   node scripts/bilingual-gate.mjs --update-snapshot  # 重算字典快照（改文案/增删 key 后）
 *   node scripts/bilingual-gate.mjs --root <目录> --baseline <文件> --snapshot <文件> --json
 *
 * 退出码：0 全过；1 有违规；2 用法或环境错（例如没 build 出 dist）。
 *
 * 只读门禁：默认不写任何文件；--update-* 是显式写入，写的是基线/快照两个数据文件本身。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const PKG_DIR = resolve(SCRIPT_DIR, '..')

/** 文案源（中文只许存这里）：迁移把某个表收进集中字典后，把文件加进这张白名单。 */
export const COPY_SOURCE_FILES = ['src/bilingual.ts']

/** 扫描范围：出厂的运行期源码（dist 是 build 产物，不重复扫；开发工具与文档不在扫描面）。 */
export const SCAN_DIRS = ['src']

export const DEFAULT_BASELINE_PATH = join(PKG_DIR, 'tests', 'fixtures', 'bilingual', 'copy-baseline.json')
export const DEFAULT_SNAPSHOT_PATH = join(PKG_DIR, 'tests', 'fixtures', 'bilingual', 'strings.snapshot.json')

/** 14 码契约：8 阻塞 + 5 电话 + internal（#22；未来码不在此列，走兜底）。 */
export const BLOCKED_REASONS = [
  'unknown-profile',
  'source-install',
  'invalid-installation',
  'installation-changed',
  'pending-restart',
  'registry-conflict',
  'incompatible-node',
  'recovery-required',
]
export const PHONE_FAILURE_CODES = ['check-failed', 'invalid-release', 'check-expired', 'update-busy', 'install-failed']
export const INTERNAL_CODE = 'internal'
export const STABLE_CODES = [...BLOCKED_REASONS, ...PHONE_FAILURE_CODES, INTERNAL_CODE]

/** 诊断对象已知键（16 键，宽容读的目录；值与键名都冻结不译）。 */
export const DIAG_KNOWN_KEYS = [
  'v',
  'stage',
  'route',
  'method',
  'httpStatus',
  'exitCode',
  'latencyMs',
  'detail',
  'targetPackageName',
  'runningVersion',
  'latestVersion',
  'environmentKind',
  'requestId',
  'checkId',
  'registryHost',
  'action',
]

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const KEY_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/
const SLOT = /\{([A-Za-z0-9_]+)\}/g
const REGEX_ALLOWED_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>'])
const REGEX_ALLOWED_WORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'instanceof',
  'do',
  'else',
  'yield',
  'await',
  'throw',
])

/** 空白归一，作为基线比对的键（同一句多行模板不会因为缩进变化而误判）。 */
export function normalizeLiteral(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 抽出源码里的字符串字面量（单引号 / 双引号 / 模板串）。
 * 注释、正则不入账；模板串里的表达式区域照抽其中的嵌套字符串；\uXXXX 转义解出真实字符。
 * 未闭合的普通字符串遇到换行即停，不吞后面的代码。
 */
export function extractStringLiterals(source) {
  const text = String(source ?? '')
  const n = text.length
  const literals = []
  let i = 0
  let line = 1
  let prev = ''
  let prevWord = ''

  function readString() {
    const quote = text[i]
    const startLine = line
    i += 1
    let buf = ''
    while (i < n) {
      const c = text[i]
      if (c === '\\') {
        const esc = text[i + 1]
        if (esc === 'u') {
          const m = /^u\{([0-9a-fA-F]+)\}/.exec(text.slice(i + 1)) || /^u([0-9a-fA-F]{4})/.exec(text.slice(i + 1))
          if (m) {
            buf += String.fromCodePoint(parseInt(m[1], 16))
            i += 1 + m[0].length
            continue
          }
        }
        if (esc === 'n') {
          buf += '\n'
          i += 2
          continue
        }
        if (esc === 't') {
          buf += '\t'
          i += 2
          continue
        }
        if (esc === 'r') {
          buf += '\r'
          i += 2
          continue
        }
        buf += esc === undefined ? '' : esc
        i += 2
        continue
      }
      if (c === quote) {
        i += 1
        break
      }
      if (c === '\n') {
        line += 1
        if (quote !== '`') {
          // 未闭合的普通字符串：不吞掉后面的代码。
          i += 1
          break
        }
        buf += c
        i += 1
        continue
      }
      if (quote === '`' && c === '$' && text[i + 1] === '{') {
        i += 2
        let depth = 1
        while (i < n && depth > 0) {
          const ch = text[i]
          if (ch === '\n') {
            line += 1
            i += 1
            continue
          }
          if (ch === '{') {
            depth += 1
            i += 1
            continue
          }
          if (ch === '}') {
            depth -= 1
            i += 1
            continue
          }
          if (ch === '/' && text[i + 1] === '/') {
            while (i < n && text[i] !== '\n') i += 1
            continue
          }
          if (ch === '/' && text[i + 1] === '*') {
            i += 2
            while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
              if (text[i] === '\n') line += 1
              i += 1
            }
            i += 2
            continue
          }
          if (ch === '"' || ch === "'" || ch === '`') {
            literals.push(readString())
            continue
          }
          i += 1
        }
        buf += ' '
        continue
      }
      buf += c
      i += 1
    }
    return { line: startLine, quote, text: buf }
  }

  function skipRegex() {
    i += 1
    let inClass = false
    while (i < n) {
      const c = text[i]
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '\n') break
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) {
        i += 1
        break
      }
      i += 1
    }
    while (i < n && /[a-z]/i.test(text[i])) i += 1
  }

  while (i < n) {
    const c = text[i]
    if (c === '\n') {
      line += 1
      i += 1
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i += 1
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') line += 1
        i += 1
      }
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      literals.push(readString())
      prev = c
      prevWord = ''
      continue
    }
    if (c === '/' && (REGEX_ALLOWED_AFTER.has(prev) || REGEX_ALLOWED_WORDS.has(prevWord))) {
      skipRegex()
      prev = ')'
      prevWord = ''
      continue
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j += 1
      prevWord = text.slice(i, j)
      prev = 'w'
      i = j
      continue
    }
    prev = c
    prevWord = ''
    i += 1
  }
  return literals
}

/** 源码里含汉字的字符串字面量（行号 + 归一文本）。 */
export function findChineseLiterals(source) {
  return extractStringLiterals(source)
    .filter((l) => CJK.test(l.text))
    .map((l) => ({ line: l.line, quote: l.quote, text: l.text, normalized: normalizeLiteral(l.text) }))
}

/** 列出扫描面上的源文件（仓相对 POSIX 路径，排序稳定）。 */
export function listSourceFiles(root, dirs = SCAN_DIRS) {
  const out = []
  const walk = (absDir, relDir) => {
    if (!existsSync(absDir)) return
    for (const entry of readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relDir ? relDir + '/' + entry.name : entry.name
      const abs = join(absDir, entry.name)
      if (entry.isDirectory()) walk(abs, rel)
      else if (entry.isFile() && rel.endsWith('.ts') && !rel.endsWith('.d.ts')) out.push(rel)
    }
  }
  for (const dir of dirs) walk(join(root, dir), dir)
  return out.sort()
}

function readJsonIfExists(file) {
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * 文案源 grep 门禁：src/ 的中文字面量只许在文案源，或在冻结基线里。
 * 基线里已经消失的条目（迁移删掉了 / 改了措辞）记为 stale：默认只提示，--strict-baseline 才拦。
 */
export function checkCopySource(options = {}) {
  const root = options.root ?? PKG_DIR
  const copySources = options.copySources ?? COPY_SOURCE_FILES
  const baseline = options.baseline ?? readJsonIfExists(options.baselinePath ?? DEFAULT_BASELINE_PATH)
  const allow = (baseline && baseline.files) || {}
  const violations = []
  const stale = []
  const scanned = []

  for (const rel of listSourceFiles(root, options.scanDirs ?? SCAN_DIRS)) {
    scanned.push(rel)
    if (copySources.includes(rel)) continue
    const cjk = findChineseLiterals(readFileSync(join(root, rel), 'utf8'))
    const allowed = new Set((allow[rel] ?? []).map(normalizeLiteral))
    const current = new Set(cjk.map((l) => l.normalized))
    for (const lit of cjk) {
      if (allowed.has(lit.normalized)) continue
      violations.push({
        file: rel,
        line: lit.line,
        text: lit.normalized,
        reason: '散落中文：既不在文案源（' + copySources.join('、') + '），也不在冻结基线里',
      })
    }
    for (const a of allowed) if (!current.has(a)) stale.push({ file: rel, text: a })
  }
  for (const [rel, list] of Object.entries(allow)) {
    if (copySources.includes(rel) || scanned.includes(rel)) continue
    for (const a of list) stale.push({ file: rel, text: normalizeLiteral(a) })
  }
  if (!baseline) {
    violations.push({
      file: options.baselinePath ?? DEFAULT_BASELINE_PATH,
      line: 0,
      text: '',
      reason: '缺冻结基线：先跑 node scripts/bilingual-gate.mjs --update-baseline',
    })
  } else if (Array.isArray(baseline.copySources) && JSON.stringify(baseline.copySources) !== JSON.stringify(copySources)) {
    violations.push({
      file: options.baselinePath ?? DEFAULT_BASELINE_PATH,
      line: 0,
      text: baseline.copySources.join('、'),
      reason: '基线记录的文案源清单与门禁常量不一致（改文案源要两边一起改）：门禁=' + copySources.join('、'),
    })
  }
  return { ok: violations.length === 0, violations, stale, scanned, baseline: baseline ?? null, copySources }
}

function slotsOf(template) {
  const out = []
  for (const m of String(template ?? '').matchAll(SLOT)) out.push(m[1])
  return out.sort()
}

/**
 * 字典快照门禁（v2 单语，#60）：每键 en+zh 非空、语言对得上、具名槽中英同名同数、键名合约定、
 * 渲染只出现当前语言（zh 不含英文/en 不含中文，冻结词元除外）、值与冻结快照逐键一致（改文案必须同步快照）。
 */
export function checkDictionary(options = {}) {
  const dict = options.dictionary
  const snapshot = options.snapshot ?? null
  const renderHtml = options.copyHtml ?? options.renderHtml
  const renderText = options.copyText ?? options.renderText
  const violations = []
  const notes = []
  if (!dict || !dict.strings || typeof dict.strings !== 'object') {
    return {
      ok: false,
      violations: [{ file: 'src/bilingual.ts', line: 0, text: '', reason: '读不到字典（dist 没 build？）' }],
      notes,
      keys: [],
    }
  }
  const keys = Object.keys(dict.strings).sort()
  if (!keys.length) violations.push({ file: 'src/bilingual.ts', line: 0, text: '', reason: '字典为空' })
  if (!dict.version || typeof dict.version !== 'string') {
    violations.push({ file: 'src/bilingual.ts', line: 0, text: '', reason: '字典版本钉（BILINGUAL_DICT_VERSION）缺失' })
  }
  const snapshotKeys = snapshot && snapshot.keys ? Object.keys(snapshot.keys).sort() : []
  if (snapshot && JSON.stringify(keys) !== JSON.stringify(snapshotKeys)) {
    violations.push({
      file: 'tests/fixtures/bilingual/strings.snapshot.json',
      line: 0,
      text: '',
      reason:
        'key 集合与快照不一致（增删 key 必须同步快照）：新增 ' +
        (keys.filter((k) => !snapshotKeys.includes(k)).join('、') || '无') +
        '；消失 ' +
        (snapshotKeys.filter((k) => !keys.includes(k)).join('、') || '无'),
    })
  }
  if (snapshot && snapshot.dictVersion && snapshot.dictVersion !== dict.version) {
    violations.push({
      file: 'tests/fixtures/bilingual/strings.snapshot.json',
      line: 0,
      text: '',
      reason: '字典版本钉与快照不一致：' + snapshot.dictVersion + ' vs ' + dict.version,
    })
  }

  const declaredDrafts = keys.filter((k) => dict.strings[k] && dict.strings[k].draft === true)
  if (typeof options.draftKeys === 'function') {
    const helper = [...options.draftKeys()].sort()
    if (JSON.stringify(helper) !== JSON.stringify(declaredDrafts)) {
      violations.push({
        file: 'src/bilingual.ts',
        line: 0,
        text: '',
        reason: 'draftKeys() 与字典里 draft:true 的键对不上：助手=[' + helper.join('、') + '] 数据=[' + declaredDrafts.join('、') + ']',
      })
    }
  }

  const pairs = new Map()
  for (const key of keys) {
    const entry = dict.strings[key] ?? {}
    const en = typeof entry.en === 'string' ? entry.en.trim() : ''
    const zh = typeof entry.zh === 'string' ? entry.zh.trim() : ''
    const here = 'key ' + key
    if (!KEY_NAME.test(key)) violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: '键名不合约定（area.group.name）' })
    if (!en) violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: here + ' 缺英文（en 非空是硬条件）' })
    if (!zh) violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: here + ' 缺中文（zh 非空是硬条件）' })
    if (en && CJK.test(en)) violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: here + ' 的 en 里有汉字（英文在前说的是真英文）' })
    if (zh && !CJK.test(zh)) violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: here + ' 的 zh 里没有汉字（中文在后说的是真中文）' })
    if (typeof entry.draft !== 'boolean') violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: here + ' 缺 draft 诚实标记' })
    if (en && zh && JSON.stringify(slotsOf(en)) !== JSON.stringify(slotsOf(zh))) {
      violations.push({
        file: 'src/bilingual.ts',
        line: 0,
        text: key,
        reason: here + ' 中英具名槽不同名同数：en=[' + slotsOf(en).join(',') + '] zh=[' + slotsOf(zh).join(',') + ']（语序可不同，槽位必须一样）',
      })
    }
    if (typeof renderHtml === 'function') {
      const vals = { version: '9.9.9', count: '7' }
      let zhHtml = ''
      let enHtml = ''
      try {
        zhHtml = String(renderHtml(key, 'zh', vals) ?? '')
        enHtml = String(renderHtml(key, 'en', vals) ?? '')
      } catch (e) {
        violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: here + ' 单语渲染抛错：' + (e && e.message) })
      }
      if (zhHtml || enHtml) {
        if (!zhHtml.includes('lang="zh"') || zhHtml.includes('lang="en"')) {
          violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: here + ' zh 渲染只许出现当前语言（含 lang="zh" 且不含 lang="en"）' })
        }
        if (!enHtml.includes('lang="en"') || enHtml.includes('lang="zh"')) {
          violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: here + ' en 渲染只许出现当前语言（含 lang="en" 且不含 lang="zh"）' })
        }
        const strip = (h) => String(h ?? '').replace(/<[^>]*>/g, ' ').replace(/&[^;]+;/g, ' ')
        // 冻结词元（#61 #63）：产品名与任务态及电话侧对象名在 zh 里逐字保留，不算混入英文（Node / installing / verifying / diag）。
        const stripFrozen = (s) => String(s ?? '').replace(/Node/g, '').replace(/installing/g, '').replace(/verifying/g, '').replace(/diag/g, '')
        const zhText = stripFrozen(strip(zhHtml).replace(/9\.9\.9/g, '').replace(/7/g, ''))
        const enText = strip(enHtml).replace(/9\.9\.9/g, '').replace(/7/g, '')
        if (/[A-Za-z]/.test(zhText)) {
          violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: here + ' zh 渲染混入英文（冻结词元除外）' })
        }
        if (CJK.test(enText)) {
          violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: here + ' en 渲染混入中文（冻结词元除外）' })
        }
        if (zhHtml && !CJK.test(strip(zhHtml))) {
          violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: here + ' zh 渲染缺中文' })
        }
        if (enHtml && !/[A-Za-z]/.test(strip(enHtml))) {
          violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: here + ' en 渲染缺英文' })
        }
      }
    }
    if (typeof renderText === 'function' && en && zh) {
      const vals = { version: '9.9.9', count: '7' }
      let zhT = ''
      let enT = ''
      try {
        zhT = String(renderText(key, 'zh', vals) ?? '')
        enT = String(renderText(key, 'en', vals) ?? '')
      } catch (e) {
        violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: here + ' 单语纯文本抛错：' + (e && e.message) })
      }
      if (zhT || enT) {
        const zhClean = String(zhT).replace(/9\.9\.9/g, '').replace(/7/g, '').replace(/Node/g, '').replace(/installing/g, '').replace(/verifying/g, '').replace(/diag/g, '')
        const enClean = String(enT).replace(/9\.9\.9/g, '').replace(/7/g, '')
        if (/[A-Za-z]/.test(zhClean)) violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: here + ' 纯文本 zh 混入英文' })
        if (CJK.test(enClean)) violations.push({ file: 'src/bilingual.ts', line: 0, text: key, reason: here + ' 纯文本 en 混入中文' })
      }
    }
    if (en && zh) {
      const pairKey = en + '\u0000' + zh
      if (pairs.has(pairKey)) notes.push('同一对措辞被多个 key 复用：' + pairs.get(pairKey) + ' / ' + key + '（复用要显式声明）')
      else pairs.set(pairKey, key)
    }
    if (snapshot && snapshot.keys && snapshot.keys[key]) {
      const snap = snapshot.keys[key]
      for (const field of ['en', 'zh', 'draft']) {
        if (snap[field] !== entry[field]) {
          violations.push({
            file: 'tests/fixtures/bilingual/strings.snapshot.json',
            line: 0,
            text: key,
            reason:
              here +
              ' 的 ' +
              field +
              ' 与冻结快照不一致（改文案要同步快照，改文案不换 key）：快照=' +
              JSON.stringify(snap[field]) +
              ' 现在=' +
              JSON.stringify(entry[field]),
          })
        }
      }
    }
  }
  return { ok: violations.length === 0, violations, notes, keys }
}

/** 14 码分支契约：每个码都有文案、都判已知；未知码走兜底；阻塞 8 行复用阻塞表原文。 */
export function checkStableCodes(options = {}) {
  const codes = options.codes ?? {}
  const { failureCopy, blockedCopy, isKnownFailureCode, failureCodeOf } = codes
  const violations = []
  for (const fn of ['failureCopy', 'isKnownFailureCode', 'failureCodeOf']) {
    if (typeof codes[fn] !== 'function') violations.push({ file: 'src/panel.ts', line: 0, text: fn, reason: '面板入口缺函数：' + fn })
  }
  if (violations.length) return { ok: false, violations, notes: [], codes: STABLE_CODES }
  if (typeof blockedCopy !== 'function') {
    violations.push({ file: 'src/panel.ts', line: 0, text: 'blockedCopy', reason: '面板入口缺函数：blockedCopy' })
    return { ok: false, violations, notes: [], codes: STABLE_CODES }
  }
  if (STABLE_CODES.length !== 14) {
    violations.push({ file: 'scripts/bilingual-gate.mjs', line: 0, text: '', reason: '14 码契约表被改动：现在 ' + STABLE_CODES.length + ' 条' })
  }
  if (new Set(STABLE_CODES).size !== STABLE_CODES.length) {
    violations.push({ file: 'scripts/bilingual-gate.mjs', line: 0, text: '', reason: '14 码契约表有重复' })
  }

  for (const code of STABLE_CODES) {
    const copy = failureCopy(code)
    if (!copy || !String(copy.zh || '').trim() || !String(copy.act || '').trim()) {
      violations.push({ file: 'src/panel.ts', line: 0, text: code, reason: '稳定码缺中文一句话或行动句：' + code })
      continue
    }
    if (!CJK.test(copy.zh) || !CJK.test(copy.act)) {
      violations.push({ file: 'src/panel.ts', line: 0, text: code, reason: '稳定码文案必须是中文人话（含汉字）：' + code })
    }
    if (isKnownFailureCode(code) !== true) {
      violations.push({ file: 'src/panel.ts', line: 0, text: code, reason: '14 码必须判为已知：' + code })
    }
  }
  for (const reason of BLOCKED_REASONS) {
    const blocked = blockedCopy(reason)
    const copy = failureCopy(reason)
    if (!blocked || !copy) {
      violations.push({ file: 'src/panel.ts', line: 0, text: reason, reason: '阻塞原因缺文案：' + reason })
      continue
    }
    if (blocked.title !== copy.zh) {
      violations.push({ file: 'src/panel.ts', line: 0, text: reason, reason: '8 行必须复用阻塞表原文，不另起措辞：' + reason })
    }
  }
  const future = 'future-code-not-yet'
  if (isKnownFailureCode(future) !== false) violations.push({ file: 'src/panel.ts', line: 0, text: future, reason: '未来码不许判为已知' })
  const fallback = failureCopy(future)
  if (!fallback || !CJK.test(String(fallback.zh))) {
    violations.push({ file: 'src/panel.ts', line: 0, text: future, reason: '未来码必须走人话兜底' })
  }
  if (failureCopy('') !== null || failureCopy(null) !== null) {
    violations.push({ file: 'src/panel.ts', line: 0, text: '', reason: '空码不猜：failureCopy 应回 null' })
  }
  if (failureCodeOf({ errorKind: 'internal', error: 'check-failed' }) !== 'internal') {
    violations.push({ file: 'src/panel.ts', line: 0, text: 'failureCodeOf', reason: 'errorKind 必须优先于 error（internal 不许被误判为 check-failed）' })
  }
  if (failureCodeOf(null) !== INTERNAL_CODE) {
    violations.push({ file: 'src/panel.ts', line: 0, text: 'failureCodeOf', reason: '缺省回 ' + INTERNAL_CODE })
  }
  return { ok: violations.length === 0, violations, notes: [], codes: STABLE_CODES }
}

/**
 * 诊断解析契约：
 * - 宽容读 diag 对象：16 键全读、未知键忽略但记账、错类型忽略、脏输入永不抛；
 * - 两种复制形态都能解析回同一组字段，字段顺序冻结（码 → 摘要 → 来源 → 怎么办）。
 */
export function checkDiagParseContract(options = {}) {
  const diag = options.diag ?? {}
  const violations = []
  const notes = []
  const { readDiagTolerant, buildUpdateDiagCopy } = diag
  for (const fn of ['readDiagTolerant', 'buildUpdateDiagCopy']) {
    if (typeof diag[fn] !== 'function') violations.push({ file: 'src/panel.ts', line: 0, text: fn, reason: '面板入口缺函数：' + fn })
  }
  if (violations.length) return { ok: false, violations, notes }

  const sample = {
    v: 1,
    stage: 'fetch-release',
    route: 'registry',
    method: 'https',
    httpStatus: 404,
    exitCode: 1,
    latencyMs: 120,
    detail: '源返回 404',
    targetPackageName: 'demo-plugin',
    runningVersion: '1.0.0',
    latestVersion: '1.1.0',
    environmentKind: 'desktop',
    requestId: 'req-1',
    checkId: 'chk-1',
    registryHost: 'registry.npmjs.org',
    action: 'retry',
  }
  const tolerant = readDiagTolerant(sample)
  for (const key of DIAG_KNOWN_KEYS) {
    if (tolerant[key] !== sample[key]) {
      violations.push({ file: 'src/panel.ts', line: 0, text: key, reason: '宽容读没有原样读出 diag 键：' + key })
    }
  }
  const dirty = readDiagTolerant({ ...sample, queuePos: 3, v: '1', stage: 7, extra: { a: 1 } })
  const dropped = (x) => x === undefined || x === null
  if (!dropped(dirty.v) || !dropped(dirty.stage)) {
    violations.push({ file: 'src/panel.ts', line: 0, text: 'readDiagTolerant', reason: '错类型必须忽略（v 传字符串、stage 传数字都要丢）' })
  }
  if (dirty.httpStatus !== sample.httpStatus) {
    violations.push({ file: 'src/panel.ts', line: 0, text: 'readDiagTolerant', reason: '同对象里类型对的键仍要读出（错类型不连坐）' })
  }
  if (!dirty.unknownKeys.includes('queuePos') || !dirty.unknownKeys.includes('extra')) {
    violations.push({ file: 'src/panel.ts', line: 0, text: 'readDiagTolerant', reason: '未知键必须记账但不渲染' })
  }
  for (const garbage of [null, undefined, 42, 'x', [], {}, true]) {
    let got
    try {
      got = readDiagTolerant(garbage)
    } catch (e) {
      violations.push({ file: 'src/panel.ts', line: 0, text: String(garbage), reason: '宽容读永不抛：' + (e && e.message) })
      continue
    }
    if (!got || got.stage !== null || !Array.isArray(got.unknownKeys)) {
      violations.push({ file: 'src/panel.ts', line: 0, text: String(garbage), reason: '脏输入必须回空结构，不猜不抛' })
    }
  }

  for (const code of STABLE_CODES) {
    const input = {
      code,
      pluginId: 'demo-plugin',
      detail: '源返回 404',
      runningVersion: '1.0.0',
      installedVersion: '1.0.0',
      latestVersion: '1.1.0',
      hostKind: 'desktop',
      profileName: 'web',
      queuePosition: null,
      requestId: 'req-1',
      route: 'registry',
      checkId: 'chk-1',
      diag: sample,
    }
    for (const format of ['block', 'line']) {
      const text = buildUpdateDiagCopy({ ...input, format })
      const parsed = parseDiagCopy(text)
      const where = code + '/' + format
      if (!parsed) {
        violations.push({ file: 'src/panel.ts', line: 0, text: where, reason: '复制块解析不回字段' })
        continue
      }
      if (parsed.code !== code) violations.push({ file: 'src/panel.ts', line: 0, text: where, reason: '解析出的码对不上：' + parsed.code })
      if (JSON.stringify(parsed.order) !== JSON.stringify(['code', 'summary', 'source', 'remedy'])) {
        violations.push({ file: 'src/panel.ts', line: 0, text: where, reason: '字段顺序不冻结（码→摘要→来源→怎么办）：' + parsed.order.join('→') })
      }
      if (!parsed.summary) violations.push({ file: 'src/panel.ts', line: 0, text: where, reason: '解析不出摘要' })
      if (!parsed.remedy) violations.push({ file: 'src/panel.ts', line: 0, text: where, reason: '解析不出怎么办' })
      for (const field of ['插件', '版本', '宿主', '使用范围', '队列']) {
        if (!(field in parsed.sourceFields)) {
          violations.push({ file: 'src/panel.ts', line: 0, text: where, reason: '来源缺恒显字段：' + field })
        }
      }
    }
  }
  return { ok: violations.length === 0, violations, notes }
}

/** 把两种复制形态解析回字段（上游/维护者按同一形状读粘贴来的诊断）。返回 null 表示这不是一段 [update-diag] 文本。 */
export function parseDiagCopy(text) {
  const raw = String(text ?? '')
  const lines = raw.split('\n')
  const first = lines[0] ?? ''
  if (!first.startsWith('[update-diag]')) return null
  const rest = first.slice('[update-diag]'.length).trim()
  if (rest.includes(' · ')) {
    const parts = rest.split(' · ')
    const head = parts.shift() ?? ''
    const m = /^code=(\S+)/.exec(head)
    const pick = (label) => {
      const hit = parts.find((p) => p.startsWith(label + '='))
      return hit ? hit.slice(label.length + 1) : ''
    }
    const sourceStart = parts.findIndex((p) => p.startsWith('插件='))
    const remedyAt = parts.findIndex((p) => p.startsWith('怎么办='))
    const sourceEnd = remedyAt < 0 ? parts.length : remedyAt
    const sourceParts = sourceStart < 0 ? [] : parts.slice(sourceStart, sourceEnd)
    const marks = []
    if (m) marks.push(['code', raw.indexOf('code=')])
    const summaryAt = raw.indexOf('摘要=')
    if (summaryAt >= 0) marks.push(['summary', summaryAt])
    if (sourceStart >= 0) marks.push(['source', raw.indexOf('插件=')])
    if (remedyAt >= 0) marks.push(['remedy', raw.indexOf('怎么办=')])
    return {
      format: 'line',
      code: m ? m[1] : '',
      state: '',
      summary: pick('摘要'),
      source: sourceParts.join(' · '),
      sourceFields: parseSourceFields(sourceParts.join(' · ')),
      remedy: pick('怎么办'),
      order: marks.sort((a, b) => a[1] - b[1]).map((x) => x[0]),
    }
  }
  const head = /^(\S+)\s+—\s+(.*)$/.exec(rest)
  const pickLine = (label) => {
    const hit = lines.find((l) => l.trim().startsWith(label + '：'))
    return hit ? hit.trim().slice(label.length + 1).trim() : ''
  }
  const lineAt = (label) => lines.findIndex((l) => l.trim().startsWith(label + '：'))
  const source = pickLine('来源')
  const marks = []
  if (head) marks.push(['code', 0])
  if (lineAt('摘要') >= 0) marks.push(['summary', lineAt('摘要')])
  if (lineAt('来源') >= 0) marks.push(['source', lineAt('来源')])
  if (lineAt('怎么办') >= 0) marks.push(['remedy', lineAt('怎么办')])
  const order = marks.sort((a, b) => a[1] - b[1]).map((x) => x[0])
  return {
    format: 'block',
    code: head ? head[1] : '',
    state: head ? head[2] : '',
    summary: pickLine('摘要'),
    source,
    sourceFields: parseSourceFields(source),
    remedy: pickLine('怎么办'),
    order,
  }
}

function parseSourceFields(source) {
  const out = {}
  for (const part of String(source ?? '').split(' · ')) {
    const at = part.indexOf('=')
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1)
  }
  return out
}

async function loadDistDeps(root) {
  const distBilingual = join(root, 'dist', 'bilingual.js')
  const distPanel = join(root, 'dist', 'panel.js')
  if (!existsSync(distBilingual) || !existsSync(distPanel)) {
    const err = new Error('读不到 dist（' + distBilingual + '）：先跑 npm run build')
    err.code = 'NO_DIST'
    throw err
  }
  const stamp = '?g=' + Date.now()
  const bilingual = await import(pathToFileURL(distBilingual).href + stamp)
  const panel = await import(pathToFileURL(distPanel).href + stamp)
  return {
    dictionary: { version: bilingual.BILINGUAL_DICT_VERSION, strings: bilingual.BILINGUAL_STRINGS, draftKeys: bilingual.draftKeys },
    copyHtml: bilingual.copyHTML ?? bilingual.bilingualHTML,
    copyText: bilingual.copyText ?? bilingual.bilingualText,
    renderHtml: bilingual.copyHTML ?? bilingual.bilingualHTML,
    renderText: bilingual.copyText ?? bilingual.bilingualText,
    codes: {
      failureCopy: panel.failureCopy,
      blockedCopy: panel.blockedCopy,
      isKnownFailureCode: panel.isKnownFailureCode,
      failureCodeOf: panel.failureCodeOf,
    },
    diag: { readDiagTolerant: panel.readDiagTolerant, buildUpdateDiagCopy: panel.buildUpdateDiagCopy },
  }
}

/** 跑门禁。默认三道硬门禁；release=true 时加第四道零 draft 放行条件。deps 可注入（测试用假件）；不注入即从 dist 读真件。 */
export async function runGate(options = {}) {
  const root = options.root ?? PKG_DIR
  const baselinePath = options.baselinePath ?? join(root, 'tests', 'fixtures', 'bilingual', 'copy-baseline.json')
  const snapshotPath = options.snapshotPath ?? join(root, 'tests', 'fixtures', 'bilingual', 'strings.snapshot.json')
  const deps = options.deps ?? (await loadDistDeps(PKG_DIR))
  const sections = []

  const copy = checkCopySource({
    root,
    baselinePath,
    copySources: options.copySources ?? COPY_SOURCE_FILES,
    baseline: options.baseline,
  })
  sections.push({
    id: 'copy-source',
    title: '文案源 grep 门禁（中文只许存文案源）',
    ok: copy.ok,
    violations: copy.violations,
    notes: copy.stale.map((s) => '基线可收紧（源里已消失）：' + s.file + ' 「' + s.text + '」'),
    summary:
      '扫描 ' +
      copy.scanned.length +
      ' 个源文件；文案源 ' +
      copy.copySources.join('、') +
      '；违规 ' +
      copy.violations.length +
      ' 处；可收紧 ' +
      copy.stale.length +
      ' 条',
  })

  const dict = checkDictionary({
    dictionary: deps.dictionary,
    snapshot: options.snapshot ?? readJsonIfExists(snapshotPath),
    copyHtml: deps.copyHtml ?? deps.renderHtml,
    copyText: deps.copyText ?? deps.renderText,
    renderHtml: deps.copyHtml ?? deps.renderHtml,
    renderText: deps.copyText ?? deps.renderText,
    draftKeys: deps.dictionary?.draftKeys,
  })
  sections.push({
    id: 'dictionary',
    title: '字典快照（每键 en+zh 非空快照）',
    ok: dict.ok,
    violations: dict.violations,
    notes: dict.notes,
    summary: dict.keys.length + ' 个 key；违规 ' + dict.violations.length + ' 处',
  })

  const codes = checkStableCodes({ codes: deps.codes })
  sections.push({
    id: 'stable-codes',
    title: '14 码分支契约（8 阻塞 + 5 电话 + internal）',
    ok: codes.ok,
    violations: codes.violations,
    notes: codes.notes,
    summary: codes.codes.length + ' 个稳定码；违规 ' + codes.violations.length + ' 处',
  })

  const diag = checkDiagParseContract({ diag: deps.diag })
  sections.push({
    id: 'diag-parse',
    title: '诊断解析契约（宽容读 + 双形态回读 + 顺序冻结）',
    ok: diag.ok,
    violations: diag.violations,
    notes: diag.notes,
    summary: DIAG_KNOWN_KEYS.length + ' 个 diag 键、' + STABLE_CODES.length + ' 码 ×2 形态；违规 ' + diag.violations.length + ' 处',
  })

  const draftStrings = deps.dictionary?.strings ?? {}
  const drafts = Object.keys(draftStrings)
    .filter((k) => draftStrings[k] && draftStrings[k].draft === true)
    .sort()
  const draftsSection = {
    id: 'zero-draft',
    title: '零 draft 放行（合入/发布条件）',
    ok: drafts.length === 0,
    violations: drafts.map((k) => ({
      file: 'src/bilingual.ts',
      line: 0,
      text: k,
      reason: '仍是 draft：无母语 + 域内双签不转正（#53 立约），放行条件未满足',
    })),
    notes: [],
    summary: drafts.length ? drafts.length + ' 个 key 仍 draft（合入条件未满足）' : '零 draft，放行',
  }
  if (options.release) sections.push(draftsSection)

  const strict = !!options.strictBaseline
  if (strict && copy.stale.length) {
    sections[0].ok = false
    sections[0].violations = sections[0].violations.concat(
      copy.stale.map((s) => ({ file: s.file, line: 0, text: s.text, reason: '冻结基线里的条目已消失：--strict-baseline 下必须收紧基线' })),
    )
  }

  const violations = sections.flatMap((s) => s.violations.map((v) => ({ ...v, section: s.id })))
  return {
    ok: sections.every((s) => s.ok),
    root,
    release: !!options.release,
    strictBaseline: strict,
    sections,
    violations,
    drafts,
    draftsSection,
  }
}

/** 人读报告（中文；本包开发工具口径）。 */
export function formatReport(result) {
  const lines = []
  lines.push('双语门禁（#56）—— ' + (result.ok ? '通过' : '不通过') + (result.release ? '（含零 draft 放行）' : ''))
  for (const section of result.sections) {
    lines.push((section.ok ? '[通过] ' : '[不通过] ') + section.title + '：' + section.summary)
    for (const v of section.violations) {
      lines.push('    ✗ ' + (v.line ? v.file + ':' + v.line + ' ' : v.file + ' ') + (v.text ? '「' + v.text + '」 ' : '') + v.reason)
    }
    for (const n of section.notes ?? []) lines.push('    · ' + n)
  }
  if (!result.release) {
    const s = result.draftsSection
    lines.push('[提示] ' + s.title + '：' + s.summary + '（加 --release 才拦）')
    for (const v of s.violations.slice(0, 8)) lines.push('    · ' + v.text)
    if (s.violations.length > 8) lines.push('    · …还有 ' + (s.violations.length - 8) + ' 个')
  }
  return lines.join('\n')
}

function parseArgs(argv) {
  const opts = { release: false, strictBaseline: false, updateBaseline: false, updateSnapshot: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const at = arg.indexOf('=')
    const name = at >= 0 ? arg.slice(0, at) : arg
    const inline = at >= 0 ? arg.slice(at + 1) : null
    const next = () => (inline === null ? argv[++i] : inline)
    if (name === '--release') opts.release = true
    else if (name === '--strict-baseline') opts.strictBaseline = true
    else if (name === '--update-baseline') opts.updateBaseline = true
    else if (name === '--update-snapshot') opts.updateSnapshot = true
    else if (name === '--json') opts.json = true
    else if (name === '--root') opts.root = resolve(next())
    else if (name === '--baseline') opts.baselinePath = resolve(next())
    else if (name === '--snapshot') opts.snapshotPath = resolve(next())
    else if (name === '-h' || name === '--help') opts.help = true
    else throw new Error('不认识的参数：' + arg)
  }
  return opts
}

/** 重算散落文案基线（显式写入；只许减不许增由评审把关）。 */
export function writeCopyBaseline(options = {}) {
  const root = options.root ?? PKG_DIR
  const file = options.baselinePath ?? DEFAULT_BASELINE_PATH
  const files = {}
  for (const rel of listSourceFiles(root, options.scanDirs ?? SCAN_DIRS)) {
    if ((options.copySources ?? COPY_SOURCE_FILES).includes(rel)) continue
    const cjk = findChineseLiterals(readFileSync(join(root, rel), 'utf8'))
    if (!cjk.length) continue
    files[rel] = [...new Set(cjk.map((l) => l.normalized))].sort()
  }
  const before = readJsonIfExists(file)
  const payload = {
    note: '冻结散落文案基线（#56 门禁）：src/ 下不在文案源里的中文字符串字面量快照，只许减不许增。用户可见文案进 src/bilingual.ts；日志/抛错等冻结文案要改，须同步本文件并在评审里看见。--update-baseline 重算。',
    copySources: options.copySources ?? COPY_SOURCE_FILES,
    files,
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return { file, before, after: payload }
}

/** 重算字典快照（显式写入）。 */
export function writeDictionarySnapshot(options = {}) {
  const file = options.snapshotPath ?? DEFAULT_SNAPSHOT_PATH
  const dict = options.dictionary
  if (!dict) throw new Error('写字典快照需要字典（dist 没 build？）')
  const keys = {}
  for (const key of Object.keys(dict.strings).sort()) {
    const e = dict.strings[key]
    keys[key] = { en: e.en, zh: e.zh, draft: !!e.draft }
  }
  const before = readJsonIfExists(file)
  const payload = {
    note: '字典快照（#56 门禁）：每个 key 的 en/zh/draft 冻结在此。改文案必须同步本文件（diff 里看得见），改文案不换 key；增删 key 同样要同步。--update-snapshot 重算。',
    dictVersion: dict.version,
    keys,
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return { file, before, after: payload }
}

/** CLI 入口：返回退出码（不直接 process.exit，便于测试）。 */
export async function main(argv = process.argv.slice(2), io = console) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    io.error(String((e && e.message) || e))
    return 2
  }
  if (opts.help) {
    io.log('用法：node scripts/bilingual-gate.mjs [--release] [--strict-baseline] [--update-baseline] [--update-snapshot] [--root <目录>] [--baseline <文件>] [--snapshot <文件>] [--json]')
    return 0
  }
  let deps
  try {
    deps = await loadDistDeps(PKG_DIR)
  } catch (e) {
    io.error(String((e && e.message) || e))
    return 2
  }
  if (opts.updateBaseline) {
    const w = writeCopyBaseline({ root: opts.root, baselinePath: opts.baselinePath, copySources: COPY_SOURCE_FILES, scanDirs: SCAN_DIRS })
    io.log('已重算散落文案基线：' + w.file)
  }
  if (opts.updateSnapshot) {
    const w = writeDictionarySnapshot({ snapshotPath: opts.snapshotPath, dictionary: deps.dictionary })
    io.log('已重算字典快照：' + w.file)
  }
  const result = await runGate({ ...opts, deps })
  if (opts.json) {
    io.log(
      JSON.stringify(
        {
          ok: result.ok,
          release: result.release,
          sections: result.sections.map((s) => ({ id: s.id, ok: s.ok, summary: s.summary, violations: s.violations })),
        },
        null,
        2,
      ),
    )
  } else {
    io.log(formatReport(result))
  }
  return result.ok ? 0 : 1
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  process.exitCode = await main()
}
