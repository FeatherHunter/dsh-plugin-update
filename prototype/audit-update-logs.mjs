// 一次性审计脚本 v2：本机 <DSH_HOME>/logs 各插件命名空间的「更新事件」按契约对一遍。
// 用法：node prototype/audit-update-logs.mjs [--day 2026-10-20]
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const REPO = process.cwd()
const CONTRACT = JSON.parse(readFileSync(join(REPO, 'event-list.update.json'), 'utf8'))
const EVENTS = CONTRACT.events
const ENUMS = CONTRACT.fieldEnums
const RESERVED = ['traceId', 'spanId', 'seq'] // 引擎注入，见 src/core/gate.ts:295 RESERVED_LOG_FIELDS
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const LOGS = join(HOME, 'logs')
const argv = process.argv.slice(2)
const DAY = argv.includes('--day') ? argv[argv.indexOf('--day') + 1] : new Date().toISOString().slice(0, 10)
const HOUR = 3600 * 1000

const hm = (t) => new Date(t + 8 * HOUR).toISOString().slice(11, 19)
const dayOf = (t) => new Date(t + 8 * HOUR).toISOString().slice(0, 10)
function hash8(v) {
  let t = String(v ?? '')
  let x = 5381
  for (let i = 0; i < t.length; i++) x = ((x << 5) + x + t.charCodeAt(i)) >>> 0
  return ('0000000' + x.toString(16)).slice(-8)
}

// ---------- 读 ----------
const namespaces = readdirSync(LOGS).filter((n) => statSync(join(LOGS, n)).isDirectory()).sort()
const all = []
const bad = []
for (const ns of namespaces) {
  for (const file of readdirSync(join(LOGS, ns)).filter((f) => f.endsWith('.log'))) {
    const lines = readFileSync(join(LOGS, ns, file), 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      if (!line.trim()) return
      let row
      try {
        row = JSON.parse(line)
      } catch {
        bad.push({ ns, file, line: i + 1 })
        return
      }
      const t = Number(row.ts)
      all.push({ ns, file, line: i + 1, row, ts: Number.isFinite(t) ? t : null })
    })
  }
}
const ours = all.filter((x) => EVENTS[x.row.event])
const byNs = new Map()
for (const x of ours) {
  if (!byNs.has(x.ns)) byNs.set(x.ns, [])
  byNs.get(x.ns).push(x)
}
for (const a of byNs.values()) a.sort((p, q) => p.ts - q.ts)

// 命名空间分类（硬编码：本机实际已装插件 11 家 vs 历史测试夹具）。
// 旧判据「全 cli+repo 算夹具」会把 life-* 误判成 real（它们混着旧测试的 cli 行）。
const REAL_NS = [
  'dsh-im-companion',
  'dsh-mattpocock-skills-deck',
  'dsh-opencode-palette',
  'dsh-prompt',
  'life-bill',
  'life-calorie',
  'life-chef',
  'life-home',
  'life-life-pack',
  'life-memo',
  'life-schedule'
]
const FIXTURE_NS = [
  'custom-b', 'life-a', 'life-b', 'life-c', 'life-d', 'life-e', 'life-f', 'life-g',
  'life-bad', 'life-self', 'owner-a-a', 'owner-b-a', 't-a', 't-b',
  'plugin-a', 'plugin-b', 'plugin-c', 'plugin-self'
]
const nsClass = new Map()
for (const ns of namespaces) {
  if (REAL_NS.includes(ns)) nsClass.set(ns, 'real')
  else if (FIXTURE_NS.includes(ns)) nsClass.set(ns, 'fixture')
  else if (!(byNs.get(ns) ?? []).length && bad.some((b) => b.ns === ns)) nsClass.set(ns, 'plain')
  else nsClass.set(ns, 'unknown')
}
const realNs = namespaces.filter((n) => nsClass.get(n) === 'real')
const fixtureNs = namespaces.filter((n) => nsClass.get(n) === 'fixture')

// ---------- A. 接线 ----------
const wire = []
for (const ns of realNs) {
  const arr = byNs.get(ns) ?? []
  const rows = arr.filter((x) => x.row.event === 'update.wire.ready')
  if (!rows.length) {
    wire.push({ ns, none: true, ourRows: arr.length, events: [...new Set(arr.map((x) => x.row.event))] })
    continue
  }
  const last = rows[rows.length - 1]
  const f = last.row.fields ?? {}
  wire.push({
    ns,
    day: dayOf(last.ts),
    updaterVersion: f.updaterVersion ?? null,
    copyLevel: f.copyLevel ?? null,
    hostKind: f.hostKind ?? null,
    logSink: f.logSink ?? null,
    wireRows: rows.length,
    ourRows: arr.length,
    events: [...new Set(arr.map((x) => x.row.event))].sort()
  })
}

// ---------- B. 契约违规 ----------
const violations = []
const push = (kind, x, detail) => violations.push({ kind, ns: x.ns, cls: nsClass.get(x.ns), day: dayOf(x.ts), when: hm(x.ts), event: x.row.event, detail })
for (const x of ours) {
  const def = EVENTS[x.row.event]
  const fields = x.row.fields ?? {}
  if (x.row.level !== def.level) push('level-mismatch', x, `契约 ${def.level} / 实落 ${x.row.level}`)
  for (const k of Object.keys(fields)) {
    if (!def.fields.includes(k) && !RESERVED.includes(k)) push('unknown-field', x, `字段 ${k} 未在契约声明`)
  }
  for (const [k, spec] of Object.entries(ENUMS[x.row.event] ?? {})) {
    const v = fields[k]
    if (v === undefined || v === null) continue
    if (Array.isArray(spec) && !spec.includes(v)) push('invalid-enum', x, `${k}=${JSON.stringify(v)} 不在 [${spec.join(',')}]`)
  }
}
// 边沿
const STATUS_TUPLE = ['kind', 'latest', 'runningVersion', 'installedVersion', 'registered', 'identity', 'blockedReason', 'unknownCause']
for (const [ns, arr] of byNs) {
  let prev = null
  for (const x of arr) {
    if (x.row.event === 'update.status.changed') {
      const f = x.row.fields ?? {}
      const t = JSON.stringify(STATUS_TUPLE.map((k) => f[k] ?? null))
      if (prev && prev.t === t && x.ts - prev.ts < 6 * HOUR) push('edge-duplicate', x, `status.changed 元组重复 ${t.slice(0, 120)}`)
      prev = { t, ts: x.ts }
    }
  }
  let lastPhase = null
  for (const x of arr) {
    if (x.row.event !== 'update.queue.transition') continue
    const p = (x.row.fields ?? {}).phase
    if (lastPhase === p) push('edge-duplicate', x, `queue.transition 连续 phase=${p}`)
    lastPhase = p
  }
}
const vSummary = (cls) => {
  const subset = violations.filter((v) => v.cls === cls)
  const m = {}
  for (const v of subset) {
    const key = `${v.ns}|${v.kind}|${v.event}`
    m[key] = (m[key] ?? 0) + 1
  }
  return { total: subset.length, rows: Object.entries(m).sort((a, b) => b[1] - a[1]) }
}

// ---------- C. 每命名空间按日画像 ----------
const profile = []
for (const ns of [...realNs, ...fixtureNs]) {
  const arr = byNs.get(ns) ?? []
  if (!arr.length) continue
  const days = new Map()
  for (const x of arr) {
    const d = dayOf(x.ts)
    if (!days.has(d)) days.set(d, { total: 0, resident: 0, fails: 0, ops: 0, install: [], check: [] })
    const cur = days.get(d)
    cur.total++
    if (EVENTS[x.row.event].kind === 'resident') cur.resident++
    if (x.row.event === 'host.call.fail') cur.fails++
    if (/install|batch|queue/.test(x.row.event)) cur.ops++
    if (/install/.test(x.row.event)) cur.install.push(x.row.event)
    if (/check\.(start|done|fail)/.test(x.row.event)) cur.check.push(x.row.event)
  }
  profile.push({ ns, cls: nsClass.get(ns), days: [...days].sort() })
}

// ---------- D. 今日真实命名空间时间线 ----------
const timelines = []
for (const ns of realNs) {
  const arr = (byNs.get(ns) ?? []).filter((x) => dayOf(x.ts) === DAY)
  const counts = {}
  for (const x of arr) counts[x.row.event] = (counts[x.row.event] ?? 0) + 1
  timelines.push({
    ns,
    counts,
    rows: arr.filter((x) => !['host.call', 'update.poll'].includes(x.row.event)).map((x) => ({ when: hm(x.ts), event: x.row.event, level: x.row.level, fields: x.row.fields }))
  })
}

// ---------- E. 非本包事件 / 消费方吞事件取证 ----------
const foreignByNs = new Map()
for (const x of all) {
  if (EVENTS[x.row.event]) continue
  if (!foreignByNs.has(x.ns)) foreignByNs.set(x.ns, new Map())
  const m = foreignByNs.get(x.ns)
  m.set(x.row.event, (m.get(x.row.event) ?? 0) + 1)
}
const ALL_EVENT_NAMES = Object.keys(EVENTS)
function decodeHash(h) {
  return ALL_EVENT_NAMES.find((n) => hash8(n) === h) ?? null
}
const consumption = []
for (const ns of realNs) {
  const arr = byNs.get(ns) ?? []
  const seen = new Set(arr.map((x) => x.row.event))
  const missing = ALL_EVENT_NAMES.filter((e) => !seen.has(e))
  const foreign = foreignByNs.get(ns) ?? new Map()
  const decoded = []
  for (const x of arr) {
    const f = x.row.fields ?? {}
    for (const k of ['errorHash', 'eventHash', 'hash']) {
      if (typeof f[k] === 'string') {
        const d = decodeHash(f[k])
        if (d) decoded.push({ event: x.row.event, field: k, hash: f[k], decoded: d, when: hm(x.ts) })
      }
    }
    if (typeof f.reason === 'string' && /unknown-event/.test(JSON.stringify(f))) {
      decoded.push({ event: x.row.event, field: 'reason', hash: f.errorHash ?? null, decoded: decodeHash(f.errorHash) ?? null, when: hm(x.ts) })
    }
  }
  consumption.push({ ns, ourRowCount: arr.length, seenEvents: seen.size, missing, foreignTop: [...foreign].sort((a, b) => b[1] - a[1]).slice(0, 8), decoded })
}

// ---------- F. 磁盘状态 vs 已装版本 ----------
const KNOWN = {
  'dsh-im-companion': 'dsh-im-companion',
  'dsh-mattpocock-skills-deck': 'dsh-mattpocock-skills-deck',
  'dsh-opencode-palette': 'dsh-opencode-palette',
  'dsh-prompt': 'dsh-prompt',
  'life-bill': 'dsh-bill-ilife',
  'life-calorie': 'dsh-calorie',
  'life-chef': 'dsh-chef',
  'life-home': 'dsh-home-ilife',
  'life-life-pack': 'dsh-life-pack',
  'life-memo': 'dsh-memo-ilife',
  'life-schedule': 'dsh-schedule-ilife'
}
const diskState = []
const updatesRoot = join(HOME, 'updates')
if (existsSync(updatesRoot)) {
  for (const pid of readdirSync(updatesRoot)) {
    for (const hash of readdirSync(join(updatesRoot, pid))) {
      const sp = join(updatesRoot, pid, hash, 'state.json')
      if (!existsSync(sp)) continue
      const st = JSON.parse(readFileSync(sp, 'utf8'))
      const pkg = KNOWN[pid] ?? pid
      let installed = null
      try {
        installed = JSON.parse(readFileSync(join(HOME, 'profiles', 'desktop', 'node_modules', pkg, 'package.json'), 'utf8')).version
      } catch {}
      const arr = byNs.get(pid) ?? []
      diskState.push({
        pluginId: pid,
        pkg,
        state: st.state,
        previousVersion: st.previousVersion,
        targetVersion: st.targetVersion,
        installed,
        same: installed === st.targetVersion,
        requestIds: (arr.filter((x) => x.row.event === 'update.install.request').slice(-1)[0]?.row.fields ?? {}).intentHash ?? null,
        verify: arr.filter((x) => x.row.event === 'update.install.verify').map((x) => ({ day: dayOf(x.ts), when: hm(x.ts), result: x.row.fields?.result, v: x.row.fields?.installedVersion, pendingRestart: x.row.fields?.pendingRestart })).slice(-3),
        fail: arr.filter((x) => x.row.event === 'update.install.fail').map((x) => ({ day: dayOf(x.ts), when: hm(x.ts), stage: x.row.fields?.stage, reason: x.row.fields?.reason, code: x.row.fields?.code })).slice(-3),
        message: st.message ? st.message.slice(0, 100) : null
      })
    }
  }
}

// ---------- 输出 ----------
const out = []
const A = (s = '') => out.push(s)
A(`# 本机更新日志审计`)
A(`生成时间 ${new Date().toISOString()}  DSH_HOME=${HOME}  DAY=${DAY}`)
A(`命名空间 ${namespaces.length} 个（real ${realNs.length} / fixture ${fixtureNs.length} / 其他 ${namespaces.length - realNs.length - fixtureNs.length}）`)
A(`日志行 ${all.length}（本包事件 ${ours.length} / 非本包 ${all.length - ours.length} / 坏行 ${bad.length}）`)
A(`\n## 0. 命名空间分类`)
A(`- real: ${realNs.join(', ')}`)
A(`- fixture: ${fixtureNs.join(', ')}`)
A(`- 其他: ${namespaces.filter((n) => !realNs.includes(n) && !fixtureNs.includes(n)).join(', ') || '无'}`)
A(`- 坏行来源: ${[...new Set(bad.map((b) => b.ns + '/' + b.file))].slice(0, 5).join(', ')}`)
A(`\n## A. 真实命名空间：谁在写、写了哪些事件`)
for (const w of wire) {
  if (w.none) A(`- ${w.ns}: 无 wire.ready 行 | 本包行 ${w.ourRows} | 见过事件 ${w.events.join(',')}`)
  else A(`- ${w.ns}: 末条 wire ${w.day} updater=${w.updaterVersion} copy=${w.copyLevel} host=${w.hostKind} sink=${w.logSink} | wire行 ${w.wireRows} 本包行 ${w.ourRows} | 事件(${w.events.length}): ${w.events.join(',')}`)
}
A(`\n## B. 契约违规（real / fixture 分开）`)
for (const cls of ['real', 'fixture', 'unknown']) {
  const s = vSummary(cls)
  A(`\n### ${cls} 共 ${s.total}`)
  for (const [k, n] of s.rows.slice(0, 15)) A(`- ${k} x${n}`)
}
A(`\n## C. 每命名空间按日画像（total/resident/fails/ops）`)
for (const p of profile) {
  A(`- ${p.ns} [${p.cls}]: ` + p.days.map(([d, c]) => `${d.slice(5)}:${c.total}/${c.resident}/${c.fails}/${c.ops}`).join('  '))
}
A(`\n## D. 今日时间线（真实命名空间，去掉 host.call/poll）`)
for (const t of timelines) {
  if (!Object.keys(t.counts).length) { A(`\n### ${t.ns}: 今日无本包事件行`); continue }
  A(`\n### ${t.ns}  ${JSON.stringify(t.counts)}`)
  for (const r of t.rows.slice(0, 30)) A(`- ${r.when} ${r.level} ${r.event} ${JSON.stringify(r.fields)}`)
  if (t.rows.length > 30) A(`- … 省略 ${t.rows.length - 30} 行`)
}
A(`\n## E. 消费方桥：见过/缺失/指纹解码`)
for (const c of consumption) {
  A(`\n### ${c.ns}: 本包行 ${c.ourRowCount}，见过 ${c.seenEvents}/29 事件`)
  A(`- 缺失: ${c.missing.join(', ')}`)
  A(`- 消费方自有事件 top: ${c.foreignTop.map(([k, v]) => `${k}(${v})`).join(', ')}`)
  if (c.decoded.length) A(`- 指纹解码: ${JSON.stringify(c.decoded.slice(-6))}`)
}
A(`\n## F. 磁盘状态 vs 已装版本`)
for (const d of diskState) {
  A(`- ${d.pluginId} → ${d.pkg}: state=${d.state} ${d.previousVersion}→${d.targetVersion} 已装=${d.installed}${d.same ? ' ✓' : ' ⚠不一致'}`)
  A(`    verify=${JSON.stringify(d.verify)} fail=${JSON.stringify(d.fail)}${d.message ? ' | ' + d.message : ''}`)
}
const report = out.join('\n')
const outFile = join(REPO, 'prototype', `audit-${DAY}.md`)
writeFileSync(outFile, report, 'utf8')
console.log(report)
console.log(`\n[report written] ${outFile}`)
