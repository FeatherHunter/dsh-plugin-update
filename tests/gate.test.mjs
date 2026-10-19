/**
 * tests/gate.test.mjs —— 门禁模板自查（#584 落地门禁模板；#120 迁到日志包 0.3.1 形状）。
 *
 * 给第二个接入更新包的插件照抄：字段白名单两档检查、三类计数现算、整份清单过尺子、
 * 事件表合并、落盘行 v === 3 断言、空模板与本包自己的事件表随包发布、
 * 双前缀串扰（两家同机不串电话名目录锁）、无新依赖、数组无 shell。
 * 只用 Node 自带测试能力（node:test），不引入新的测试框架。
 * 网络、落盘（除隔离断言的临时目录）、子进程、桌面服务全用假件或临时目录，不碰真机。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const gateUrl = pathToFileURL(path.join(PKG_DIR, 'dist', 'gate.js')).href + '?x=' + Date.now()
const gate = await import(gateUrl)
const {
  LOG_ROW_VERSION,
  parseEventListManifest,
  lintEventFields,
  computeEventCounts,
  lintEventList,
  mergeUpdateEvents,
  parseLogRow,
  checkEventFields,
  checkEventCounts
} = gate
const host = await import(pathToFileURL(path.join(PKG_DIR, 'dist', 'host.js')).href + '?x=' + Date.now())
const store = await import(pathToFileURL(path.join(PKG_DIR, 'dist', 'store.js')).href + '?x=' + Date.now())

function shortHash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 24)
}

function readUpdateTable() {
  return JSON.parse(readFileSync(path.join(PKG_DIR, 'event-list.update.json'), 'utf8'))
}

// 一份手写小清单（0.3.1 形状：不写自报计数）：两常驻、一按需、一自监控。
function makeSample() {
  return {
    version: 1,
    pluginId: 'my-plugin',
    events: {
      'host.call': {
        level: 'info',
        kind: 'resident',
        fields: ['method', 'latencyMs', 'ok', 'kind', 'pluginId']
      },
      'update.install.exec': {
        level: 'info',
        kind: 'resident',
        fields: ['route', 'ok', 'exitCode', 'durationMs', 'pluginId'],
        codes: [],
        rules: []
      },
      'chain.cache.miss': {
        level: 'debug',
        kind: 'ondemand',
        fields: ['keyHash', 'lang', 'reason'],
        guard: '按事件，有穿透才记'
      },
      'log.persist.fail': {
        level: 'warn',
        kind: 'selfmon',
        fields: ['op', 'reason', 'dirHash'],
        codes: ['H_CWD']
      }
    }
  }
}

describe('门禁模板：空模板与本包事件表随包发布', () => {
  it('空模板合法：读包内模板，验形通过，三类计数全零（0.3.1 起清单不写自报计数）', () => {
    const raw = readFileSync(path.join(PKG_DIR, 'event-list.template.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal('counts' in parsed, false, '模板不再带自报计数')
    const manifest = parseEventListManifest(parsed)
    assert.equal(manifest.version, 1)
    assert.deepEqual(Object.keys(manifest.events), [])
    assert.deepEqual(computeEventCounts(manifest), { resident: 0, ondemand: 0, selfmon: 0 })
  })

  it('模板与本包事件表都进发布白名单：files 含两份清单与 dist', () => {
    const pkg = JSON.parse(readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'))
    assert.ok(Array.isArray(pkg.files))
    assert.ok(pkg.files.includes('event-list.template.json'))
    assert.ok(pkg.files.includes('event-list.update.json'))
    assert.ok(pkg.files.includes('dist'))
  })

  it('本包事件表过整份尺子全绿：无红无黄，三类条数与现算一致', () => {
    const manifest = parseEventListManifest(readUpdateTable())
    const linted = lintEventList(manifest)
    assert.deepEqual(linted.red, [], '本包事件表不该有红')
    assert.deepEqual(linted.yellow, [], '本包事件表不该有黄')
    assert.equal(linted.ok, true)
    // 0.16.3 契约回填：删掉两条零发射点事件（update.install.retry / update.restart.outcome）
    // 与一个从未出现的字段名（update.registry.fetch.cacheHit），常驻 20 → 18、总数 28 → 26。
    // #213：update.changelog.parse 由按需升常驻（档位 19/7/1 → 20/6/1），事件总数仍 27。
    // #216：补两条真有发射点的常驻事件（update.batch.run.start / update.install.retry），档位 22/6/1、总数 29。
    assert.deepEqual(linted.counts, { resident: 22, ondemand: 6, selfmon: 1 })
    // 冻结的三个旧事件名一字不动；host.call.fail 的字段经 #150 破冰加 `error`
    // （只增稳定码一格，旧读数忽略未知格，见 #150 进度区）：其余两事件字段仍冻结。
    const events = manifest.events
    assert.deepEqual(events['host.call'].fields, ['method', 'latencyMs', 'ok', 'kind', 'pluginId'])
    assert.deepEqual(events['host.call.fail'].fields, ['method', 'kind', 'error', 'errorHash', 'pluginId'])
    assert.deepEqual(events['update.install.exec'].fields, ['route', 'ok', 'exitCode', 'durationMs', 'pluginId'])
    // 契约回填的负向断言：这些样不许再回到清单里（清单是发布出去的契约，声明了就得真发）。
    // #216：update.install.retry 重新有了发射点（批量 check-expired 当场重查重提），按契约登记回来。
    assert.deepEqual(events['update.install.retry'].fields, ['reason', 'attempt', 'requestHash'])
    assert.deepEqual(events['update.batch.run.start'].fields, ['trigger', 'resumed', 'total', 'pending', 'sessionHash'])
    assert.equal(events['update.restart.outcome'], undefined, '零发射点的事件不该留在随包清单里')
    assert.ok(
      !events['update.registry.fetch'].fields.includes('cacheHit'),
      '恒为 false 的字段名不该留在随包清单里'
    )
  })
})

describe('门禁模板：字段白名单两档与三类计数现算', () => {
  it('白名单通过：清单里的事件配清单里的字段，severity 为 none', () => {
    const manifest = parseEventListManifest(makeSample())
    assert.deepEqual(lintEventFields(manifest, 'host.call', ['method', 'latencyMs', 'ok', 'kind', 'pluginId']), {
      ok: true,
      severity: 'none',
      unknownEvent: false,
      unknownFields: []
    })
  })

  it('未知字段算黄：名单带回、不误伤已知字段，且不拦上线（severity 为 warn）', () => {
    const manifest = parseEventListManifest(makeSample())
    const got = lintEventFields(manifest, 'host.call', ['method', 'token'])
    assert.equal(got.ok, false)
    assert.equal(got.severity, 'warn')
    assert.equal(got.unknownEvent, false)
    assert.deepEqual(got.unknownFields, ['token'])
  })

  it('未知事件名算红：拼错名或漏登记都拦下（severity 为 error）', () => {
    const manifest = parseEventListManifest(makeSample())
    assert.deepEqual(lintEventFields(manifest, 'host.call2', ['method']), {
      ok: false,
      severity: 'error',
      unknownEvent: true,
      unknownFields: []
    })
  })

  it('计数现算：三类实际条数按 kind 数出来', () => {
    const manifest = parseEventListManifest(makeSample())
    assert.deepEqual(computeEventCounts(manifest), { resident: 2, ondemand: 1, selfmon: 1 })
  })

  it('旧清单带着自报计数也照收：收下但不参与判断，0.3.1 起不再是必填', () => {
    const sample = makeSample()
    sample.counts = { resident: 2, ondemand: 1, selfmon: 1 }
    const manifest = parseEventListManifest(sample)
    assert.deepEqual(manifest.counts, { resident: 2, ondemand: 1, selfmon: 1 })
    assert.deepEqual(lintEventList(manifest).red, [])
  })

  it('自报计数对不上被揪出：整份尺子给红，弃用壳给 problems', () => {
    const sample = makeSample()
    sample.counts = { resident: 1, ondemand: 1, selfmon: 1 }
    const manifest = parseEventListManifest(sample)
    const linted = lintEventList(manifest)
    assert.equal(linted.ok, false)
    assert.equal(linted.red.length, 1)
    assert.match(linted.red[0], /自报 counts\.resident/)
    const legacy = checkEventCounts(manifest)
    assert.equal(legacy.ok, false)
    assert.equal(legacy.problems.length, 1)
    assert.match(legacy.problems[0], /resident/)
  })

  it('弃用壳行为与旧版一致：清单没写 counts 就直接算过', () => {
    const manifest = parseEventListManifest(makeSample())
    assert.deepEqual(checkEventCounts(manifest), { ok: true, problems: [] })
    assert.deepEqual(checkEventFields(manifest, 'host.call', ['method']), {
      ok: true,
      unknownEvent: false,
      unknownFields: []
    })
    assert.deepEqual(checkEventFields(manifest, 'host.call2', ['method']), {
      ok: false,
      unknownEvent: true,
      unknownFields: []
    })
  })

  it('整份尺子揪出引用名错误：codes 不是代号、rules 引用未登记规则名', () => {
    const sample = makeSample()
    sample.events['log.persist.fail'].codes = ['cwd-hash']
    sample.events['chain.cache.miss'].rules = ['R_NO_SUCH_RULE']
    const linted = lintEventList(parseEventListManifest(sample))
    assert.equal(linted.ok, false)
    assert.equal(linted.red.length, 2)
    assert.match(linted.red.join('\n'), /不是合法的散列或截断代号/)
    assert.match(linted.red.join('\n'), /引用未登记规则名/)
  })

  it('整份尺子给黄：字段里出现自由文本键（ADR-0006 管这条）', () => {
    const sample = makeSample()
    sample.events['chain.cache.miss'].fields = ['keyHash', 'message']
    const linted = lintEventList(parseEventListManifest(sample))
    assert.equal(linted.ok, true, '黄不拦')
    assert.equal(linted.yellow.length, 1)
    assert.match(linted.yellow[0], /自由文本/)
  })

  it('非法形状直接报中文错：级别写错', () => {
    const sample = makeSample()
    sample.events['host.call'].level = 'fatal'
    assert.throws(() => parseEventListManifest(sample), /level 只许/)
  })

  it('非法形状直接报中文错：条目多出不认识的键（多半是拼写错误）', () => {
    const sample = makeSample()
    sample.events['host.call'].fileds = sample.events['host.call'].fields
    assert.throws(() => parseEventListManifest(sample), /不认识的键 fileds/)
  })

  it('路径形式被拦下：包不读盘，调用方自己读成对象再传', () => {
    assert.throws(() => parseEventListManifest('event-list.json'), /自己读成对象再传入/)
  })

  it('数组形式同样被拦下：只收对象，与坏对象同口径', () => {
    assert.throws(() => parseEventListManifest([]), /只收对象形式/)
  })

  it('宿主入口同样导出新检查器与旧壳：包根可达', () => {
    for (const name of [
      'parseEventListManifest',
      'lintEventFields',
      'computeEventCounts',
      'lintEventList',
      'mergeUpdateEvents',
      'parseLogRow',
      'checkEventFields',
      'checkEventCounts'
    ]) {
      assert.equal(typeof host[name], 'function', '包根应导出 ' + name)
    }
    assert.equal(host.LOG_ROW_VERSION, 3)
    assert.deepEqual(host.computeEventCounts(host.parseEventListManifest(makeSample())), {
      resident: 2,
      ondemand: 1,
      selfmon: 1
    })
  })
})

describe('门禁模板：事件表合并与落盘行断言', () => {
  it('合并：本包有、对方没有的事件补进去，对方的清单标识不变', () => {
    const merged = mergeUpdateEvents(makeSample(), readUpdateTable())
    assert.equal(merged.manifest.pluginId, 'my-plugin')
    assert.ok(merged.added.includes('update.check.done'))
    assert.ok(merged.merged.includes('host.call'))
    assert.deepEqual(merged.conflicts, [], '两边声明一致时不该报冲突')
    // 合并结果自己是合法清单：过一遍解析与尺子。
    const reparsed = parseEventListManifest(merged.manifest)
    assert.deepEqual(lintEventList(reparsed).red, [])
  })

  it('合并：两边都有时字段取并集，级别与归类仍按对方声明', () => {
    const sample = makeSample()
    sample.events['update.check.done'] = { level: 'debug', kind: 'ondemand', fields: ['ok', 'extra'] }
    const merged = mergeUpdateEvents(sample, readUpdateTable())
    const entry = merged.manifest.events['update.check.done']
    assert.equal(entry.level, 'debug', '级别按对方')
    assert.equal(entry.kind, 'ondemand', '归类按对方')
    assert.deepEqual(entry.fields, [
      'ok',
      'extra',
      'current',
      'latest',
      'channel',
      'source',
      'latencyMs',
      'blockedReason',
      'fallback',
      'dataSource',
      'pendingRestart',
      'jobState',
    ])
    assert.equal(merged.conflicts.length, 1)
    assert.match(merged.conflicts[0], /update\.check\.done/)
  })

  it('合并：两份都必须是对象形式（更新包不读盘）', () => {
    assert.throws(() => mergeUpdateEvents('mine.json', readUpdateTable()), /自己读成对象再传入/)
    assert.throws(() => mergeUpdateEvents(makeSample(), 'update.json'), /自己读成对象再传入/)
  })

  it('落盘行断言：v === 3 且恒五键，ts 是毫秒数', () => {
    const row = {
      v: LOG_ROW_VERSION,
      ts: 1792009014642,
      level: 'info',
      event: 'update.check.done',
      fields: { ok: true, current: '0.15.0' }
    }
    assert.equal(parseLogRow(row).v, 3)
    assert.equal(parseLogRow(row).ts, 1792009014642)
    assert.equal(LOG_ROW_VERSION, 3)
  })

  it('落盘行断言：版本不是 3、多键、fields 不是对象、ts 不是毫秒数都报中文错', () => {
    const base = { v: 3, ts: 1792009014642, level: 'info', event: 'update.check.done', fields: {} }
    assert.throws(() => parseLogRow({ ...base, v: 2 }), /格式版本 v 只认 3/)
    assert.throws(() => parseLogRow({ ...base, extra: 1 }), /不认识的键 extra/)
    assert.throws(() => parseLogRow({ ...base, fields: [] }), /fields 必须是对象/)
    assert.throws(() => parseLogRow({ ...base, level: 'fatal' }), /level 只许/)
    assert.throws(() => parseLogRow('row.json'), /只收对象/)
    // dsh-log 的行构造器写的是 Date.now()（core/row.js: `ts: Date.now()`）——
    // ISO 字符串看着更像人话，但没有任何一台引擎会写出来，放行它等于把尺子做松。
    assert.throws(() => parseLogRow({ ...base, ts: '2026-10-14T21:00:00.000Z' }), /ts 必须是有限数/)
    assert.throws(() => parseLogRow({ ...base, ts: Number.NaN }), /ts 必须是有限数/)
  })
})

describe('门禁模板：双前缀串扰（两家同机不串电话名目录锁）', () => {
  let homeDir = ''
  let profileDir = ''

  before(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'dpu-gate-home-'))
    profileDir = mkdtempSync(join(tmpdir(), 'dpu-gate-profile-'))
  })

  after(() => {
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(profileDir, { recursive: true, force: true })
  })

  it('电话名互不相撞：默认 wf 与新前缀拼出的名字全不同', () => {
    const { buildPhoneNames } = host
    const first = buildPhoneNames('wf')
    const second = buildPhoneNames('other')
    for (const action of ['updateStatus', 'updateCheck', 'updateInstall', 'updateChangelog', 'updateCheckFallback', 'logAppend']) {
      assert.notEqual(first[action], second[action])
    }
    assert.deepEqual(first, {
      updateStatus: 'wf.updateStatus',
      updateCheck: 'wf.updateCheck',
      updateInstall: 'wf.updateInstall',
      updateChangelog: 'wf.updateChangelog',
      updateCheckFallback: 'wf.updateCheckFallback',
      logAppend: 'wf.logAppend'
    })
  })

  it('落盘目录互不相撞：同机同使用范围下两家目录与锁文件全不同', () => {
    const first = store.pathsForUpdate(homeDir, 'plugin-a', profileDir)
    const second = store.pathsForUpdate(homeDir, 'plugin-b', profileDir)
    assert.notEqual(first.directory, second.directory)
    assert.notEqual(first.state, second.state)
    assert.notEqual(first.lock, second.lock)
    assert.notEqual(first.backup, second.backup)
    assert.equal(first.directory, join(homeDir, 'updates', 'plugin-a', shortHash(profileDir)))
    assert.equal(second.directory, join(homeDir, 'updates', 'plugin-b', shortHash(profileDir)))
  })

  it('锁互不相撞：两家各拿各的锁，互不阻塞', async () => {
    const first = store.createUpdateDiskPorts(homeDir, 'plugin-a', profileDir)
    const second = store.createUpdateDiskPorts(homeDir, 'plugin-b', profileDir)
    assert.notEqual(first.paths.lock, second.paths.lock)
    assert.equal(await first.tryAcquireLock('a-1'), true)
    // 第二家拿自己的锁不受第一家影响。
    assert.equal(await second.tryAcquireLock('b-1'), true)
    await first.releaseLock('a-1')
    await second.releaseLock('b-1')
    // 同一家同一目录复用同一把锁文件（证明同家走同一把锁，不是每调一次换一把）。
    const again = store.createUpdateDiskPorts(homeDir, 'plugin-a', profileDir)
    assert.equal(again.paths.lock, first.paths.lock)
    assert.equal(await again.tryAcquireLock('a-2'), true)
    await again.releaseLock('a-2')
  })
})

describe('门禁模板：无新依赖与数组无 shell', () => {
  it('唯一运行期依赖是 dsh-log：包内不引用别家外部包，且只有日志内核按需取它', async () => {
    const pkg = JSON.parse(readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'))
    const deps = pkg.dependencies || {}
    assert.deepEqual(Object.keys(deps), ['dsh-log'], '运行期依赖只有 dsh-log 一个（ADR-0005）')
    const { readdirSync } = await import('node:fs')
    const srcDir = path.join(PKG_DIR, 'src')
    // 递归扫：日志内核拆进了 src/log/，只扫顶层会把它漏掉。
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
      )
    const files = walk(srcDir).filter((n) => n.endsWith('.ts'))
    assert.ok(files.some((n) => n.endsWith(path.join('log', 'registry.ts'))), '日志内核文件在内')
    for (const file of files) {
      const rel = path.relative(PKG_DIR, file).split(path.sep).join('/')
      const raw = readFileSync(file, 'utf8')
      // 去注释后再扫导入，避免注释里的示例命令被误伤。
      const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^A-Za-z0-9_$:])\/\/.*$/gm, '$1')
      const specs = [
        ...[...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
        ...[...text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ]
      for (const spec of specs) {
        const local = spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('node:')
        // 唯一例外：日志内核按需动态取 dsh-log（拿不到就降级，不外抛）。
        const kernelTakesDshLog = rel.startsWith('src/log/') && (spec === 'dsh-log' || spec.startsWith('dsh-log/'))
        assert.ok(local || kernelTakesDshLog, rel + ' 不引用外部包（命中 ' + spec + '）')
      }
    }
  })

  it('数组无 shell：执行器只走参数数组，不经 shell、不用 PATH 名、不按系统分支', () => {
    const text = readFileSync(path.join(PKG_DIR, 'src', 'store.ts'), 'utf8')
    // 有参数数组的形状。
    assert.match(text, /argv/)
    // 无 shell 字符串、无命令名字段。
    assert.ok(!/shell\s*:/.test(text), '执行器不给子进程能力传 shell 选项')
    assert.ok(!/execFile|execSync/.test(text), '执行器不用裸子进程')
    assert.ok(!/cmd\.exe/.test(text), '执行器不拼 Windows 垫片名')
    // 不按操作系统分支：包内不出现平台分支字面。
    assert.ok(!/process\.platform/.test(text), '执行器不按操作系统分支')
    // 配方侧同样无 shell：复查命令拼接文件。
    const commands = readFileSync(path.join(PKG_DIR, 'src', 'commands.ts'), 'utf8')
    assert.ok(!/shell\s*:/.test(commands))
    assert.ok(!/process\.platform/.test(commands))
  })
})
