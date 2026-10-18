/**
 * tests/panel-copy-log-health.test.mjs —— #212 日志健康：单一措辞源与两种复制形态。
 *
 * 只测外部行为：调 logHealthText / buildUpdateDiagCopy / buildHealthyDiagCopy /
 * scripts 里的 parseDiagCopy，断言
 * 1. 没读数（老宿主）回 null，面板与复制「零输出」，老调用一字不差；
 * 2. 四种落点各有措辞，未知一律显式说「未验证」，off 说清「日志目录不会有行」；
 * 3. 分支只认枚举/稳定码，自由文本不进面板；
 * 4. 两形态都带同一句，且解析契约（码→摘要→来源→怎么办）不被破坏，单行封顶后仍可解析。
 * 不测内部实现、不测样式像素。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHealthyDiagCopy, buildUpdateDiagCopy, logHealthText } from '../dist/panel-copy.js'
import { parseDiagCopy } from '../scripts/bilingual-gate.mjs'

const CJK = /[\u4e00-\u9fff]/

function selfHealth(overrides = {}) {
  return {
    sink: 'self',
    dirHash: 'deadbeef',
    switchEnabled: true,
    droppedSinceStart: 0,
    lastEventAt: 1790000000000,
    contract: 'ok',
    external: null,
    reason: null,
    ...overrides,
  }
}

function externalHealth(gate) {
  return { ...selfHealth(), sink: 'external', dirHash: null, switchEnabled: null, lastEventAt: null, external: gate }
}

function offHealth(reason, overrides = {}) {
  return { ...selfHealth(), sink: 'off', dirHash: null, switchEnabled: null, lastEventAt: null, reason, ...overrides }
}

function pendingHealth(overrides = {}) {
  return { ...selfHealth(), sink: 'pending', switchEnabled: null, lastEventAt: null, ...overrides }
}

function failInput(overrides = {}) {
  return {
    pluginId: 'demo-plugin',
    code: 'check-failed',
    detail: '源返回 404',
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    hostKind: 'desktop',
    profileName: 'web',
    queuePosition: null,
    requestId: 'req-1',
    checkId: 'chk-1',
    diag: null,
    ...overrides,
  }
}

const HEALTHY = {
  canInstall: false,
  latestVersion: '1.1.0',
  installed: true,
  runningVersion: '1.0.0',
  installedVersion: '1.0.0',
  queuePosition: null,
  pluginId: 'demo-plugin',
  hostKind: 'desktop',
  profileName: 'web',
  requestId: null,
  checkId: null,
}

// ---------- 没读数 / 坏形状 ----------

test('#212 没读数回 null（老宿主零输出），坏形状不抛也不猜', () => {
  for (const bad of [null, undefined, 0, '', 'x', 42, true]) {
    assert.equal(logHealthText(bad), null, '不是读数的输入必须回 null：' + String(bad))
  }
  // 形状认不出（对象但不是读数）不许崩，也不许假装正常：明说「无法识别」
  for (const weird of [{}, { sink: 'nope' }, { sink: 42 }, []]) {
    const t = logHealthText(weird)
    assert.equal(typeof t, 'string', '认不出的形状要给一句人话，不抛')
    assert.match(t, /无法识别/, '认不出就说认不出：' + t)
    assert.ok(!t.includes('正常'), '认不出时不许显示「正常」')
  }
})

// ---------- 四种落点 ----------

test('#212 self：落点/指纹/开关/丢弃/最近事件/契约六样都在，null 最近事件说「从未」', () => {
  const t = logHealthText(selfHealth())
  assert.equal(typeof t, 'string')
  assert.ok(t.startsWith('日志：'), '同一句自带标签（面板日志区与复制诊断共用）：' + t)
  assert.ok(t.includes('落点=self'), t)
  assert.ok(t.includes('目录指纹=deadbeef'), t)
  assert.ok(t.includes('按需信息开关=开'), t)
  assert.ok(t.includes('启动以来丢弃 0 行'), t)
  assert.ok(t.includes('事件契约=正常'), t)
  assert.ok(t.includes('最近事件='), t)
  assert.ok(!t.includes('从未'), '给了时间就不许说「从未」')

  assert.ok(
    logHealthText(selfHealth({ lastEventAt: null })).includes('最近事件=从未（启动以来没有一行到过落点）'),
    'null = 启动以来一行都没到过落点',
  )
  assert.ok(logHealthText(selfHealth({ switchEnabled: false })).includes('按需信息开关=关'), 'false 不许说成未知')
  assert.ok(logHealthText(selfHealth({ switchEnabled: null })).includes('按需信息开关=未知'), 'null 不许猜成开/关')
  assert.ok(logHealthText(selfHealth({ dirHash: null })).includes('目录指纹=未知'), 'self 没指纹也不许编')
  // 自建落点必须报丢弃数与指纹之外还报契约（缺了契约就无法判断字段门禁这轮有没有尺子）
  assert.ok(logHealthText(selfHealth({ droppedSinceStart: 7 })).includes('启动以来丢弃 7 行'))
})

test('#212 external：open 确认放行 / closed 明确未放行 / unknown 必须出现「未验证」', () => {
  const open = logHealthText(externalHealth('open'))
  assert.ok(open.includes('落点=external'), open)
  assert.ok(open.includes('对方引擎确认放行本包事件'), open)
  assert.ok(open.includes('目录指纹本包不猜'), '对方目录本包不猜：' + open)

  const closed = logHealthText(externalHealth('closed'))
  assert.ok(closed.includes('对方引擎未放行本包事件'), closed)

  for (const h of [externalHealth('unknown'), externalHealth(null), { ...externalHealth('open'), external: 'weird' }]) {
    const t = logHealthText(h)
    assert.ok(t.includes('未验证'), '没判据就是未验证，不能当「有日志」下结论：' + t)
  }
  assert.ok(logHealthText(externalHealth('unknown')).includes('最近事件=从未'), '外部落点也能报最近事件')
  assert.ok(logHealthText({ ...externalHealth('open'), droppedSinceStart: 3 }).includes('启动以来丢弃 3 行'), '发射口丢弃数照报')
})

test('#212 off：三个原因码各有出处，句子里必须有「日志目录不会有行」与带外证据', () => {
  const cases = [
    ['no-dsh-log', '没安装'],
    ['lease-conflict', '同目录写者冲突'],
    ['write-fail', '建库或写盘失败'],
  ]
  for (const [reason, word] of cases) {
    const t = logHealthText(offHealth(reason))
    assert.ok(t.includes('落点=off'), reason + '：' + t)
    assert.ok(t.includes(word), reason + ' 要说清是哪类没接上：' + t)
    assert.ok(t.includes(reason), reason + ' 原因码原样可读（机读真值不译）')
    assert.ok(t.includes('日志目录不会有行'), reason + ' 必须说清日志目录不会有行：' + t)
    assert.ok(t.includes('带外证据'), reason + ' 必须给出替代证据口径：' + t)
    assert.ok(t.includes('更新回包') && t.includes('本面板') && t.includes('复制诊断'), reason + ' 三样带外证据都在：' + t)
  }
  const unknownReason = logHealthText(offHealth('weird-code'))
  assert.ok(unknownReason.includes('原因=未知'), '认不出的原因码不猜：' + unknownReason)
  assert.ok(!unknownReason.includes('weird-code'), '自由文本不进面板（只按稳定码分支）')
  assert.ok(logHealthText(offHealth('no-dsh-log', { contract: 'missing' })).includes('没有尺子'), 'off 也要报契约状态')
})

test('#212 pending：瞬时态说清「接线中，稍后重查」', () => {
  const t = logHealthText(pendingHealth())
  assert.ok(t.includes('落点=pending'), t)
  assert.ok(t.includes('接线中，稍后重查'), t)
  assert.ok(t.includes('目录指纹=abc12345'.replace('abc12345', 'deadbeef')), t)
})

// ---------- 契约状态 ----------

test('#212 契约非 ok 一律点出：missing/invalid 说「没有尺子」，unloaded 说没读进来', () => {
  for (const state of ['missing', 'invalid']) {
    const t = logHealthText(selfHealth({ contract: state }))
    assert.ok(t.includes('没有尺子'), state + '：字段门禁这轮没有尺子要说出来：' + t)
    assert.ok(t.includes(state), state + '：原状态码可读')
  }
  assert.ok(logHealthText(selfHealth({ contract: 'unloaded' })).includes('未加载'), 'unloaded 说清契约没读进来')
  assert.ok(logHealthText(selfHealth({ contract: 'weird' })).includes('事件契约=未知'), '认不出的契约不猜')
})

// ---------- 双语 / 确定性 / 脱敏 ----------

test('#212 纯函数与双语：lang 缺省 zh，同一输入两次一字不差，en 不混汉字', () => {
  const samples = [
    selfHealth(),
    selfHealth({ lastEventAt: null, switchEnabled: null, contract: 'missing' }),
    externalHealth('open'),
    externalHealth('closed'),
    externalHealth('unknown'),
    offHealth('no-dsh-log'),
    offHealth('lease-fail' === 'x' ? 'x' : 'lease-conflict'),
    offHealth('write-fail'),
    pendingHealth(),
    { sink: 'unknown' },
  ]
  for (const h of samples) {
    const zh = logHealthText(h)
    assert.equal(logHealthText(h), zh, '同一输入必须同一串：' + zh)
    assert.equal(logHealthText(h, 'zh'), zh, 'lang 缺省 zh 零回归')
    const en = logHealthText(h, 'en')
    assert.equal(typeof en, 'string')
    assert.ok(en.length > 0, 'en 也要有句子')
    assert.ok(!CJK.test(en), 'en 不许混中文：' + en)
    assert.ok(!CJK.test(logHealthText(h, 'en-US')), 'BCP47 也认 en')
  }
})

test('#212 面板侧只认形状：读数里塞真路径也会被既有脱敏规则收掉', () => {
  const t = logHealthText(selfHealth({ dirHash: 'C:\\Users\\x\\.dsh\\logs\\abc' }))
  assert.ok(!t.includes('C:\\Users'), '日志健康行不外带目录真路径：' + t)
  assert.ok(t.includes('<路径>'), '被收成占位符，可读且不泄路径')
})

// ---------- 复制诊断两形态 ----------

test('#212 失败复制两形态都带同一句，且解析契约与来源顺序不破', () => {
  const health = selfHealth()
  const sentence = logHealthText(health)
  for (const format of ['block', 'line']) {
    const text = buildUpdateDiagCopy({ ...failInput(), format, logHealth: health })
    assert.ok(text.includes(sentence), format + '：必须带同一句（单一措辞源）\n' + text)
    const parsed = parseDiagCopy(text)
    assert.ok(parsed, format + '：仍可解析')
    assert.equal(parsed.code, 'check-failed', format)
    assert.equal(JSON.stringify(parsed.order), JSON.stringify(['code', 'summary', 'source', 'remedy']), format + '：字段顺序冻结')
    assert.ok(parsed.summary, format + '：摘要不许丢')
    assert.ok(parsed.remedy, format + '：怎么办不许丢')
    for (const field of ['插件', '版本', '宿主', '使用范围', '队列']) {
      assert.ok(field in parsed.sourceFields, format + '：来源缺恒显字段 ' + field)
    }
  }
  const block = buildUpdateDiagCopy({ ...failInput(), format: 'block', logHealth: health })
  assert.ok(block.includes('\n  日志：'), '块形态：新起一行，不动码/摘要/来源/怎么办四行')
  const line = buildUpdateDiagCopy({ ...failInput(), format: 'line', logHealth: health })
  assert.ok(!line.includes('\n'), '单行形态不许换行')
  assert.ok(line.includes(' · 日志：'), '单行形态：接在末尾')
})

test('#212 健康态复制也带同一句；off/未验证的诚实句在三种形态里一致', () => {
  const health = offHealth('no-dsh-log')
  const sentence = logHealthText(health)
  for (const format of ['block', 'line']) {
    const healthy = buildHealthyDiagCopy({ ...HEALTHY, format, logHealth: health })
    assert.ok(healthy.includes(sentence), format + '：健康态也带同一句')
  }
  const unverified = externalHealth('unknown')
  const text = buildUpdateDiagCopy({ ...failInput(), format: 'line', logHealth: unverified })
  assert.ok(text.includes('未验证'), '未验证字样要进复制文本：' + text)
})

test('#212 没给读数时复制文本一字不差（老宿主/老调用零回归）', () => {
  for (const format of ['block', 'line']) {
    const base = buildUpdateDiagCopy({ ...failInput(), format })
    assert.equal(buildUpdateDiagCopy({ ...failInput(), format, logHealth: null }), base, format + '：显式 null 不改输出')
    assert.equal(buildUpdateDiagCopy({ ...failInput(), format, logHealth: undefined }), base, format + '：undefined 不改输出')
    assert.ok(!base.includes('日志：'), format + '：没读数就不出现日志健康句')

    const healthyBase = buildHealthyDiagCopy({ ...HEALTHY, format })
    assert.equal(buildHealthyDiagCopy({ ...HEALTHY, format, logHealth: null }), healthyBase, format + '：健康态 null 不改输出')
    assert.equal(buildHealthyDiagCopy({ ...HEALTHY, format, logHealth: undefined }), healthyBase, format + '：健康态 undefined 不改输出')
    assert.ok(!healthyBase.includes('日志：'), format + '：健康态没读数也不出现')
  }
})

test('#212 单行形态封顶 1500 后仍可解析：健康句排在最后，截断只吃新内容', () => {
  const health = selfHealth()
  const sentence = logHealthText(health)
  // 用长摘要把单行顶到接近封顶但不超（长度按当前措辞标定；前提不成立就让断言显式失败，
  // 不许「根本没到封顶」悄悄算过）。
  const padded = { ...failInput(), format: 'line', detail: '很长的说明文字 '.repeat(155) }
  const without = buildUpdateDiagCopy({ ...padded, logHealth: null })
  assert.ok(without.length < 1500, '没读数时这条本来就没到封顶（否则测不到「截断只吃新内容」）：' + without.length)
  assert.ok(
    without.length + sentence.length > 1500,
    '加上健康句必须真的超预算，才算测到截断：' + (without.length + sentence.length),
  )
  const withHealth = buildUpdateDiagCopy({ ...padded, logHealth: health })
  assert.ok(withHealth.length <= 1500, '封顶 1500：' + withHealth.length)
  const parsed = parseDiagCopy(withHealth)
  assert.ok(parsed, '截断后仍可解析')
  assert.equal(parsed.code, 'check-failed')
  assert.equal(JSON.stringify(parsed.order), JSON.stringify(['code', 'summary', 'source', 'remedy']), '冻结的四段顺序不为截断让路')
  assert.ok(parsed.remedy, '怎么办排在健康句之前，截断先吃健康句，不吃冻结契约')
  assert.ok(!withHealth.includes(sentence), '超预算时先舍的正是新加的健康句')
})
