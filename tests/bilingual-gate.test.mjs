/**
 * tests/bilingual-gate.test.mjs —— 双语门禁（#56）自测：门禁自己的门禁。
 *
 * 门禁本体在 scripts/bilingual-gate.mjs，本文件只做两件事：
 * 1. 证明门禁**抓得住**：注释/正则不误伤；新散落中文、空英文、槽位不齐、顺序反了、解析不回字段、
 *    缺函数、码被判未知……一律在临时目录里造出来，断言红在哪一行（门禁失败可复现）。
 * 2. 证明本仓现在**是绿的**：真仓真件跑三道硬门禁；零 draft 放行条件如实报红（母语评审未到，
 *    转正即绿），两条路都断言，免得门禁变成一句口号。
 *
 * 真件一律从 dist 读（npm test 的 pretest 会先 build）；临时目录只用于造违规，跑完即删。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  BLOCKED_REASONS,
  COPY_SOURCE_FILES,
  DIAG_KNOWN_KEYS,
  PHONE_FAILURE_CODES,
  STABLE_CODES,
  checkCopySource,
  checkDiagParseContract,
  checkDictionary,
  checkStableCodes,
  findChineseLiterals,
  formatReport,
  main,
  parseDiagCopy,
  runGate,
  writeCopyBaseline,
} from '../scripts/bilingual-gate.mjs'
import * as bilingual from '../dist/bilingual.js'
import * as panel from '../dist/panel.js'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_DIR = path.join(PKG_DIR, 'tests', 'fixtures', 'bilingual')

const tempRoots = []
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true })
})

/** 造一个临时仓：{ 'src/x.ts': 文本 }。 */
function makeRoot(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'dpu-bgate-'))
  tempRoots.push(root)
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, text, 'utf8')
  }
  return root
}

function realDeps() {
  return {
    dictionary: {
      version: bilingual.BILINGUAL_DICT_VERSION,
      strings: bilingual.BILINGUAL_STRINGS,
      draftKeys: bilingual.draftKeys,
    },
    copyHtml: bilingual.copyHTML,
    copyText: bilingual.copyText,
    renderHtml: bilingual.copyHTML,
    renderText: bilingual.copyText,
    codes: {
      failureCopy: panel.failureCopy,
      blockedCopy: panel.blockedCopy,
      isKnownFailureCode: panel.isKnownFailureCode,
      failureCodeOf: panel.failureCodeOf,
    },
    diag: { readDiagTolerant: panel.readDiagTolerant, buildUpdateDiagCopy: panel.buildUpdateDiagCopy },
  }
}

function fakeIo() {
  const lines = []
  return { lines, log: (s) => lines.push(String(s)), error: (s) => lines.push('ERR ' + String(s)) }
}

function dictOf(strings, version = 'test-pin') {
  return { version, strings }
}

function renderersOf(strings) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const fmt = (tpl, vals) => String(tpl).replace(/\{([A-Za-z0-9_]+)\}/g, (_, n) => {
    const v = (vals ?? {})[n]
    return v === null || v === undefined ? '' : String(v).trim()
  })
  const norm = (l) => {
    const s = String(l ?? 'zh').trim().toLowerCase().replace(/_/g, '-')
    if (!s) return 'zh'
    if (s === 'zh' || s.startsWith('zh-')) return 'zh'
    if (/^[a-z]{2,3}(-[a-z0-9]+)*$/.test(s)) return 'en'
    return 'zh'
  }
  return {
    copyHtml: (k, lang, vals) => {
      const l = norm(lang ?? 'zh')
      const e = strings[k]
      return '<span class="dsh-upd-bi"><span lang="' + l + '">' + esc(fmt(l === 'en' ? e.en : e.zh, vals)) + '</span></span>'
    },
    copyText: (k, lang, vals) => {
      const l = norm(lang ?? 'zh')
      const e = strings[k]
      return fmt(l === 'en' ? e.en : e.zh, vals)
    },
    renderHtml: (k, lang, vals) => {
      const l = norm(lang ?? 'zh')
      const e = strings[k]
      return '<span class="dsh-upd-bi"><span lang="' + l + '">' + esc(fmt(l === 'en' ? e.en : e.zh, vals)) + '</span></span>'
    },
    renderText: (k, lang, vals) => {
      const l = norm(lang ?? 'zh')
      const e = strings[k]
      return fmt(l === 'en' ? e.en : e.zh, vals)
    },
  }
}

function dictViolations(strings, extra = {}) {
  const got = checkDictionary({ dictionary: dictOf(strings), ...renderersOf(strings), ...extra })
  return got
}

function reasonsOf(got) {
  return got.violations.map((v) => v.reason).join(' | ')
}

// ---------- 扫描器：注释与正则不误伤，字符串不漏 ----------

test('#56 扫描器：注释里的中文不入账（行注释与块注释都放过），行号仍准', () => {
  const src = [
    '// 这里是一行注释，含中文',
    "const a = '有中文'",
    '/* 块注释',
    '   也有中文 */',
    'const b = "另一处中文"',
  ].join('\n')
  const lits = findChineseLiterals(src)
  assert.deepEqual(
    lits.map((l) => l.normalized),
    ['有中文', '另一处中文'],
  )
  assert.deepEqual(
    lits.map((l) => l.line),
    [2, 5],
  )
})

test('#56 扫描器：模板串与表达式里的嵌套字符串都入账', () => {
  const src = 'const s = `前缀 ${ok ? \'甲\' : "乙"} 后缀`\nconst t = `裸中文`'
  const lits = findChineseLiterals(src)
  assert.deepEqual(
    lits.map((l) => l.normalized),
    ['甲', '乙', '前缀 后缀', '裸中文'],
  )
})

test('#56 扫描器：正则里的引号不吃掉后面的代码，正则里的中文不算文案', () => {
  const src = 'const re = /[\'"]/g\nconst cn = /[一-龥]+/\nconst s = \'真正的中文\''
  const lits = findChineseLiterals(src)
  assert.deepEqual(
    lits.map((l) => l.normalized),
    ['真正的中文'],
  )
  assert.equal(lits[0].line, 3)
})

test('#56 扫描器：\\uXXXX 转义解出真实字符（写成转义的文案也算中文）', () => {
  const lits = findChineseLiterals("const s = '\\u4e2d\\u6587'")
  assert.deepEqual(
    lits.map((l) => l.normalized),
    ['中文'],
  )
})

// ---------- 文案源 grep 门禁：中文只许存文案源 ----------

const TREE_WITH_SCATTER = {
  'src/bilingual.ts': "export const D = '文案源里的中文'\n",
  'src/thing.ts': "// 注释中文放过\nconst label = '新加的散落文案'\nexport const ok = 'fine'\n",
}

test('#56 文案源门禁：非文案源文件里的新散落中文红，报文件与行号（门禁失败可复现）', () => {
  const root = makeRoot(TREE_WITH_SCATTER)
  const got = checkCopySource({ root, baseline: { files: {} } })
  assert.equal(got.ok, false)
  assert.equal(got.violations.length, 1)
  assert.equal(got.violations[0].file, 'src/thing.ts')
  assert.equal(got.violations[0].line, 2)
  assert.equal(got.violations[0].text, '新加的散落文案')
  assert.match(got.violations[0].reason, /散落中文/)
})

test('#56 文案源门禁：文案源文件放行，注释不算文案，d.ts 不在扫描面', () => {
  const root = makeRoot({
    ...TREE_WITH_SCATTER,
    'src/thing.d.ts': "export declare const x: '声明里的中文'\n",
  })
  const got = checkCopySource({ root, baseline: { files: { 'src/thing.ts': ['新加的散落文案'] } } })
  assert.equal(got.ok, true, reasonsOf(got))
  assert.ok(got.scanned.includes('src/bilingual.ts'))
  assert.ok(!got.scanned.includes('src/thing.d.ts'))
})

test('#56 文案源门禁：基线里已消失的条目只提示，--strict-baseline 才拦', async () => {
  const root = makeRoot({ 'src/thing.ts': "const a = '还在'\n" })
  const baseline = { files: { 'src/thing.ts': ['还在', '已经删掉的旧文案'] } }
  const got = checkCopySource({ root, baseline })
  assert.equal(got.ok, true)
  assert.deepEqual(
    got.stale.map((s) => s.text),
    ['已经删掉的旧文案'],
  )

  const strict = await runGate({ root, baseline, deps: realDeps(), strictBaseline: true })
  const section = strict.sections.find((s) => s.id === 'copy-source')
  assert.equal(strict.ok, false)
  assert.ok(section.violations.some((v) => /必须收紧基线/.test(v.reason)))
})

test('#56 文案源门禁：缺基线文件直接红，并给出重算命令', () => {
  const root = makeRoot({ 'src/thing.ts': 'const a = 1\n' })
  const got = checkCopySource({ root, baselinePath: path.join(root, 'tests', 'fixtures', 'bilingual', 'copy-baseline.json') })
  assert.equal(got.ok, false)
  assert.match(got.violations[0].reason, /--update-baseline/)
})

test('#56 文案源门禁：基线记录的文案源清单与门禁常量漂移即红', () => {
  const root = makeRoot({ 'src/thing.ts': "const a = '甲'\n" })
  const got = checkCopySource({ root, baseline: { copySources: ['src/other.ts'], files: { 'src/thing.ts': ['甲'] } } })
  assert.equal(got.ok, false)
  assert.match(reasonsOf(got), /文案源清单与门禁常量不一致/)
})

test('#56 基线生成器：现算的基线喂回门禁即绿（去重、排序、跳过文案源）', () => {
  const root = makeRoot({
    'src/panel.ts': "const a = '甲'\nconst b = '甲'\nconst c = '乙'\n",
    'src/bilingual.ts': "const d = '文案源'\n",
  })
  const out = writeCopyBaseline({ root, baselinePath: path.join(root, 'baseline.json') })
  const payload = JSON.parse(readFileSync(out.file, 'utf8'))
  assert.deepEqual(payload.files['src/panel.ts'].slice().sort(), ['乙', '甲'])
  assert.ok(!('src/bilingual.ts' in payload.files), '文案源不进基线')
  const got = checkCopySource({ root, baselinePath: out.file })
  assert.equal(got.ok, true, reasonsOf(got))
  assert.equal(got.stale.length, 0)
})

// ---------- 字典快照：每键 en+zh 非空 ----------

const GOOD_KEY = { 'entry.label.idle': { en: 'Check for updates', zh: '检查更新', draft: true } }

test('#56 字典门禁：合格字典全绿', () => {
  const got = dictViolations(GOOD_KEY)
  assert.equal(got.ok, true, reasonsOf(got))
  assert.deepEqual(got.keys, ['entry.label.idle'])
})

test('#56 字典门禁：空英文 / 空中文各红一处（非空是硬条件）', () => {
  const noEn = dictViolations({ 'entry.label.idle': { en: '   ', zh: '检查更新', draft: true } })
  assert.equal(noEn.ok, false)
  assert.match(reasonsOf(noEn), /缺英文/)
  const noZh = dictViolations({ 'entry.label.idle': { en: 'Check', zh: '', draft: true } })
  assert.equal(noZh.ok, false)
  assert.match(reasonsOf(noZh), /缺中文/)
})

test('#56 字典门禁：英文里混汉字、中文里没汉字都红（同显说的是两种语言）', () => {
  const enCn = dictViolations({ 'entry.label.idle': { en: 'Check 检查', zh: '检查更新', draft: true } })
  assert.match(reasonsOf(enCn), /en 里有汉字/)
  const zhEn = dictViolations({ 'entry.label.idle': { en: 'Check for updates', zh: 'Check', draft: true } })
  assert.match(reasonsOf(zhEn), /zh 里没有汉字/)
})

test('#56 字典门禁：缺 draft 标记、键名不合约定都红', () => {
  const noDraft = dictViolations({ 'entry.label.idle': { en: 'Check', zh: '检查' } })
  assert.match(reasonsOf(noDraft), /缺 draft/)
  const badKey = dictViolations({ badkey: { en: 'Check', zh: '检查', draft: true } })
  assert.match(reasonsOf(badKey), /键名不合约定/)
})

test('#56 字典门禁：中英具名槽不同名同数即红（语序可不同，槽位必须一样）', () => {
  const got = dictViolations({ 'entry.label.has-update': { en: 'Update available {version}', zh: '有新版 {ver}', draft: true } })
  assert.equal(got.ok, false)
  assert.match(reasonsOf(got), /具名槽不同名同数/)
})

test('#60 v2 单语门禁：zh 混英文 / en 混中文即红（冻结词元除外）', () => {
  const strings = GOOD_KEY
  const bothHtml = () => '<span class="dsh-upd-bi"><span lang="en">Check</span><span lang="zh">检查</span></span>'
  const gotHtml = checkDictionary({
    dictionary: dictOf(strings),
    copyHtml: () => bothHtml(),
    copyText: renderersOf(strings).copyText,
  })
  assert.equal(gotHtml.ok, false)
  assert.match(reasonsOf(gotHtml), /只许出现当前语言|混入/)
  const swappedText = {
    copyHtml: renderersOf(strings).copyHtml,
    copyText: (k, lang, vals) => (String(lang).toLowerCase().startsWith('zh') ? strings[k].en : strings[k].zh),
  }
  const gotText = checkDictionary({ dictionary: dictOf(strings), ...swappedText })
  assert.equal(gotText.ok, false)
  assert.match(reasonsOf(gotText), /混入/)
})

test('#56 字典门禁：与冻结快照不一致即红（改文案必须同步快照，改文案不换 key）', () => {
  const strings = GOOD_KEY
  const drift = checkDictionary({
    dictionary: dictOf(strings),
    ...renderersOf(strings),
    snapshot: { dictVersion: 'test-pin', keys: { 'entry.label.idle': { en: 'Check for updates', zh: '检查更新', draft: false } } },
  })
  assert.equal(drift.ok, false)
  assert.match(reasonsOf(drift), /与冻结快照不一致/)

  const missingKey = checkDictionary({
    dictionary: dictOf(strings),
    ...renderersOf(strings),
    snapshot: { dictVersion: 'test-pin', keys: {} },
  })
  assert.match(reasonsOf(missingKey), /key 集合与快照不一致/)
})

test('#56 字典门禁：draftKeys() 与数据对不上即红（放行条件读数据，助手不能自己说了算）', () => {
  const strings = { 'entry.label.idle': { en: 'Check for updates', zh: '检查更新', draft: true } }
  const got = checkDictionary({ dictionary: dictOf(strings), ...renderersOf(strings), draftKeys: () => [] })
  assert.equal(got.ok, false)
  assert.match(reasonsOf(got), /draftKeys\(\) 与字典里 draft:true 的键对不上/)
})

test('#56 字典门禁：同一对措辞被两个 key 复用只提示不拦（复用要显式声明）', () => {
  const got = dictViolations({
    'entry.label.idle': { en: 'Check for updates', zh: '检查更新', draft: true },
    'entry.label.restart': { en: 'Check for updates', zh: '检查更新', draft: true },
  })
  assert.equal(got.ok, true, reasonsOf(got))
  assert.equal(got.notes.length, 1)
  assert.match(got.notes[0], /复用/)
})

test('#56 真字典快照：文件与真字典逐键一致，且每键中英非空', () => {
  const snap = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'strings.snapshot.json'), 'utf8'))
  assert.equal(snap.dictVersion, bilingual.BILINGUAL_DICT_VERSION)
  const keys = Object.keys(bilingual.BILINGUAL_STRINGS).sort()
  assert.deepEqual(Object.keys(snap.keys).sort(), keys)
  for (const key of keys) {
    const entry = bilingual.BILINGUAL_STRINGS[key]
    assert.equal(snap.keys[key].en, entry.en, key + ' 快照英文一致')
    assert.equal(snap.keys[key].zh, entry.zh, key + ' 快照中文一致')
    assert.equal(snap.keys[key].draft, entry.draft, key + ' 快照 draft 一致')
    assert.ok(entry.en.trim(), key + ' 英文非空')
    assert.ok(entry.zh.trim(), key + ' 中文非空')
  }
})

test('#56 真基线文件：现仓 src/ 逐条对上（新散落中文必须显式进基线）', () => {
  const payload = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'copy-baseline.json'), 'utf8'))
  assert.deepEqual(payload.copySources, COPY_SOURCE_FILES)
  const got = checkCopySource({ root: PKG_DIR, baseline: payload })
  assert.equal(got.ok, true, reasonsOf(got))
  assert.equal(got.stale.length, 0, '基线有已消失条目就该收紧：' + JSON.stringify(got.stale.slice(0, 5)))
  assert.ok(got.scanned.length >= 20)
})

// ---------- 14 码分支契约 ----------

test('#56 14 码契约：8 阻塞 + 5 电话 + internal，真件逐码有文案有分支', () => {
  assert.equal(BLOCKED_REASONS.length, 8)
  assert.equal(PHONE_FAILURE_CODES.length, 5)
  assert.equal(STABLE_CODES.length, 14)
  assert.equal(new Set(STABLE_CODES).size, 14)
  const got = checkStableCodes({ codes: realDeps().codes })
  assert.equal(got.ok, true, reasonsOf(got))
})

test('#56 14 码契约：码被判成未知即红（防倒退抓得住）', () => {
  const got = checkStableCodes({ codes: { ...realDeps().codes, isKnownFailureCode: () => false } })
  assert.equal(got.ok, false)
  assert.equal(got.violations.filter((v) => /判为已知/.test(v.reason)).length, 14)
})

test('#56 14 码契约：入口缺函数直接报缺件，不静默通过', () => {
  const got = checkStableCodes({ codes: {} })
  assert.equal(got.ok, false)
  assert.ok(got.violations.some((v) => /缺函数/.test(v.reason)))
})

// ---------- 诊断解析契约 ----------

test('#56 诊断解析契约：真件全绿（16 键宽容读 + 14 码 ×2 形态回读 + 顺序冻结）', () => {
  assert.equal(DIAG_KNOWN_KEYS.length, 16)
  const got = checkDiagParseContract({ diag: realDeps().diag })
  assert.equal(got.ok, true, reasonsOf(got))
})

test('#56 诊断解析：三行块与单行都解析回同一组字段，顺序冻结', () => {
  const source = '插件=demo · 版本=1.0.0→1.1.0 · 宿主=desktop · 使用范围=web · 源=未知 · 队列=不在队列里'
  const block = [
    '[update-diag] install-failed — 装不上（详见诊断摘要）',
    '  摘要：源返回 404',
    '  来源：' + source,
    '  怎么办：先看复制诊断',
  ].join('\n')
  const line =
    '[update-diag] code=install-failed · 装不上（详见诊断摘要） · 摘要=源返回 404 · ' + source + ' · 怎么办=先看复制诊断'
  for (const [format, text] of [
    ['block', block],
    ['line', line],
  ]) {
    const parsed = parseDiagCopy(text)
    assert.equal(parsed.format, format)
    assert.equal(parsed.code, 'install-failed')
    assert.equal(parsed.summary, '源返回 404')
    assert.equal(parsed.remedy, '先看复制诊断')
    assert.deepEqual(parsed.order, ['code', 'summary', 'source', 'remedy'])
    assert.equal(parsed.sourceFields['插件'], 'demo')
    assert.equal(parsed.sourceFields['版本'], '1.0.0→1.1.0')
    assert.equal(parsed.sourceFields['队列'], '不在队列里')
  }
})

test('#56 诊断解析：不是 [update-diag] 段就回 null，不猜', () => {
  assert.equal(parseDiagCopy('普通文本'), null)
  assert.equal(parseDiagCopy(''), null)
  assert.equal(parseDiagCopy(null), null)
})

test('#56 诊断解析契约：复制块丢了怎么办就红（抓得住）', () => {
  const broken = { ...realDeps().diag, buildUpdateDiagCopy: (input) => '[update-diag] ' + input.code + ' — 一句话' }
  const got = checkDiagParseContract({ diag: broken })
  assert.equal(got.ok, false)
  assert.ok(got.violations.some((v) => /解析不出摘要|字段顺序不冻结/.test(v.reason)))
})

// ---------- 跑起来的门禁：真仓绿、放行条件如实红 ----------

test('#56 真仓真件：三道硬门禁全绿（文案源 + 快照 + 14 码 + 诊断解析）', async () => {
  const result = await runGate({ root: PKG_DIR, deps: realDeps() })
  assert.equal(result.ok, true, formatReport(result))
  assert.deepEqual(
    result.sections.map((s) => s.id),
    ['copy-source', 'dictionary', 'stable-codes', 'diag-parse'],
  )
})

test('#56 零 draft 放行：还有 draft 就红并逐 key 报出（现在如实红，母语评审未到）', async () => {
  const result = await runGate({ root: PKG_DIR, deps: realDeps(), release: true })
  const drafts = [...bilingual.draftKeys()].sort()
  assert.equal(result.ok, drafts.length === 0)
  assert.deepEqual(result.drafts, drafts)
  const zero = result.sections.find((s) => s.id === 'zero-draft')
  assert.ok(zero, 'release 模式必须带上零 draft 放行节')
  assert.equal(zero.ok, drafts.length === 0)
  assert.deepEqual(
    zero.violations.map((v) => v.text),
    drafts,
  )
})

test('#56 零 draft 放行：字典转正后即绿（放行条件真能被满足）', async () => {
  const strings = { 'entry.label.idle': { en: 'Check for updates', zh: '检查更新', draft: false } }
  const result = await runGate({
    root: PKG_DIR,
    deps: { ...realDeps(), dictionary: dictOf(strings) },
    release: true,
    snapshot: { dictVersion: 'test-pin', keys: { 'entry.label.idle': { en: 'Check for updates', zh: '检查更新', draft: false } } },
  })
  assert.equal(result.ok, true, formatReport(result))
  assert.equal(result.drafts.length, 0)
})

test('#56 跑起来的门禁：临时根里种违规即红，报告点名文件（失败可复现）', async () => {
  const root = makeRoot({ 'src/panel.ts': "const a = 1\nconst b = '新散落文案'\n" })
  const result = await runGate({ root, baseline: { files: { 'src/panel.ts': [] } }, deps: realDeps() })
  assert.equal(result.ok, false)
  const report = formatReport(result)
  assert.match(report, /src\/panel\.ts:2/)
  assert.match(report, /新散落文案/)
})

// ---------- CLI：退出码就是门禁的判据 ----------

test('#56 CLI：--help 退 0，不认识的参数退 2', async () => {
  assert.equal(await main(['--help'], fakeIo()), 0)
  assert.equal(await main(['--nope'], fakeIo()), 2)
})

test('#56 CLI：真仓默认三道门禁退 0（改包必跑的那条）', async () => {
  const io = fakeIo()
  const code = await main([], io)
  const text = io.lines.join('\n')
  assert.equal(code, 0, text)
  assert.match(text, /双语门禁（#56）—— 通过/)
})

test('#56 CLI：临时根里种散落中文即退 1，报告点名文件与行号', async () => {
  const root = makeRoot({ 'src/panel.ts': "const a = 1\nconst b = '新散落文案'\n" })
  const baseline = path.join(root, 'baseline.json')
  writeFileSync(baseline, JSON.stringify({ files: { 'src/panel.ts': [] } }), 'utf8')
  const io = fakeIo()
  const code = await main(['--root', root, '--baseline', baseline], io)
  const text = io.lines.join('\n')
  assert.equal(code, 1, text)
  assert.match(text, /src\/panel\.ts:2/)
  assert.match(text, /新散落文案/)
})

test('#56 CLI：--update-baseline 现算基线后同一条不再红', async () => {
  const root = makeRoot({ 'src/panel.ts': "const b = '既有散落文案'\n" })
  const baseline = path.join(root, 'baseline.json')
  const io = fakeIo()
  assert.equal(await main(['--root', root, '--baseline', baseline, '--update-baseline'], io), 0, io.lines.join('\n'))
  const payload = JSON.parse(readFileSync(baseline, 'utf8'))
  assert.deepEqual(payload.files['src/panel.ts'], ['既有散落文案'])
})
