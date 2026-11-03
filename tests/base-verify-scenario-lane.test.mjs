/**
 * tests/base-verify-scenario-lane.test.mjs —— base run 场景快速通道的 hermetic 定向测试。
 *
 * 只测纯函数与「不需要起宿主」的编排路径：参数拼装、四态映射、token 脱敏、截图 sidecar 校验、
 * 滚动判定、以及 capability 门 blocked 时早退的 summary 形状。真机证明在仓库外跑，不在 npm test 里。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildScenarioArgs,
  classifyScenarioExit,
  redactTokenUrl,
  rollupScenarioVerdict,
  runBaseScenario,
  validateShotSidecars,
  SHOT_SIDECAR_KEYS,
} from '../selftest/real-machine/base-verify/scenario-run.ts'
import { buildShotSidecar, looksLikeAuthRequired, AUTH_REQUIRED_MARKER } from '../selftest/real-machine/base-verify/web-ui.ts'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 每例一个临时目录；测试结束删干净。 */
async function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'base-lane-'))
  try {
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 写一张合法 PNG（只需魔数，校验器不解析像素）+ 可选 sidecar。 */
function writeShot(shotsDir, id, sidecar) {
  mkdirSync(shotsDir, { recursive: true })
  writeFileSync(join(shotsDir, id + '.png'), PNG_MAGIC)
  if (sidecar !== undefined) writeFileSync(join(shotsDir, id + '.json'), JSON.stringify(sidecar))
}

const validSidecar = {
  看什么: '首屏',
  步骤: 'launch → goto tokenUrl → 截图',
  expected: '真 UI 渲染',
  actual: '插件面板可见',
  判定: 'pass',
  备注: null,
}

test('buildScenarioArgs：场景文件作位置参数，profile/work-root 是旗标', () => {
  const invocation = buildScenarioArgs({
    scenarioPath: 'verify/scenarios/web-ui-smoke.ts',
    profile: 'web',
    workRoot: 'D:/tmp/work',
  })
  assert.equal(invocation.command, 'run')
  assert.deepEqual(invocation.args, [
    'verify/scenarios/web-ui-smoke.ts',
    '--profile',
    'web',
    '--work-root',
    'D:/tmp/work',
  ])
})

test('classifyScenarioExit：四态映射与工具错误的边界', () => {
  const facts = (exitCode, durationMs = 1000) => ({ exitCode, signal: null, durationMs })
  // 0 + 报告 => pass（报告形状只需 state 字段）
  assert.equal(classifyScenarioExit(facts(0), { state: 'passed' }).verdict, 'pass')
  // 0 但没报告 => unknown（不能把「没输出」当通过）
  const noReport = classifyScenarioExit(facts(0), undefined)
  assert.equal(noReport.verdict, 'unknown')
  assert.ok(noReport.toolError)
  // 1 => fail
  assert.equal(classifyScenarioExit(facts(1), { state: 'failed' }).verdict, 'fail')
  // 2 + blocked => unknown（blocked 是「没观测到」，不是产品红）
  assert.equal(classifyScenarioExit(facts(2), { state: 'blocked' }).verdict, 'unknown')
  // 2 其它 => unknown + toolError
  const odd = classifyScenarioExit(facts(2), { state: 'failed' })
  assert.equal(odd.verdict, 'unknown')
  assert.ok(odd.toolError)
  // 进程没退出码（被 kill / 起不来）=> unknown
  assert.equal(classifyScenarioExit(facts(null), undefined).verdict, 'unknown')
})

test('redactTokenUrl：token 打码，其它查询参数与 origin 保留', () => {
  assert.equal(
    redactTokenUrl('http://127.0.0.1:5055/?token=secret123&x=1'),
    'http://127.0.0.1:5055/?token=***&x=1',
  )
  assert.equal(redactTokenUrl('http://host/?a=1&token=abc#frag'), 'http://host/?a=1&token=***#frag')
  assert.equal(redactTokenUrl('http://host/path'), 'http://host/path')
})

test('validateShotSidecars：合法 png+六字段 sidecar 通过', async () => {
  await withTempDir(async (dir) => {
    const shotsDir = join(dir, 'shots')
    writeShot(shotsDir, 'one', validSidecar)
    const result = await validateShotSidecars(shotsDir)
    assert.equal(result.problems.length, 0)
    assert.equal(result.shots.length, 1)
    assert.equal(result.shots[0].id, 'one')
    assert.equal(result.shots[0].verdict, 'pass')
    assert.equal(result.shots[0].bytes, PNG_MAGIC.length)
  })
})

test('validateShotSidecars：缺 sidecar 与缺字段都判 fail（不静默）', async () => {
  await withTempDir(async (dir) => {
    const shotsDir = join(dir, 'shots')
    writeShot(shotsDir, 'no-sidecar')
    const missing = await validateShotSidecars(shotsDir)
    assert.equal(missing.problems.length, 1)
    assert.equal(missing.shots[0].verdict, 'fail')
    assert.match(missing.problems[0], /sidecar/)

    const partial = { ...validSidecar }
    delete partial.expected
    writeShot(shotsDir, 'partial', partial)
    const incomplete = await validateShotSidecars(shotsDir)
    assert.ok(incomplete.problems.length >= 1)
    const partialShot = incomplete.shots.find((shot) => shot.id === 'partial')
    assert.equal(partialShot.verdict, 'fail')
    assert.ok(partialShot.problems.some((problem) => problem.includes('expected')))
  })
})

test('validateShotSidecars：判定列只认四态；备注允许 null 或字符串', async () => {
  await withTempDir(async (dir) => {
    const shotsDir = join(dir, 'shots')
    writeShot(shotsDir, 'bad-verdict', { ...validSidecar, 判定: 'green' })
    writeShot(shotsDir, 'note-number', { ...validSidecar, 备注: 3 })
    const result = await validateShotSidecars(shotsDir)
    assert.equal(result.shots.length, 2)
    for (const shot of result.shots) assert.equal(shot.verdict, 'fail')
    assert.ok(result.problems.some((problem) => problem.includes('判定')))
    assert.ok(result.problems.some((problem) => problem.includes('备注')))
  })
})

test('validateShotSidecars：空目录默认是问题，可显式关掉', async () => {
  await withTempDir(async (dir) => {
    const shotsDir = join(dir, 'shots')
    mkdirSync(shotsDir, { recursive: true })
    assert.ok((await validateShotSidecars(shotsDir)).problems.length > 0)
    assert.equal((await validateShotSidecars(shotsDir, { requireAtLeastOne: false })).problems.length, 0)
    // 目录根本不存在（没有启动提示时）也按「没有截图」记
    assert.ok((await validateShotSidecars(join(dir, 'absent'))).problems.length > 0)
  })
})

test('buildShotSidecar 与校验器同口径：六键齐、captureShot 的旁注能被复核', async () => {
  await withTempDir(async (dir) => {
    const shotsDir = join(dir, 'shots')
    const sidecar = buildShotSidecar({
      what: '首屏',
      steps: 'launch → goto tokenUrl',
      expected: '真 UI',
      actual: '插件面板可见',
      verdict: 'pass',
      note: '说明',
    })
    assert.deepEqual(Object.keys(sidecar), [...SHOT_SIDECAR_KEYS])
    writeShot(shotsDir, 'built', sidecar)
    const result = await validateShotSidecars(shotsDir)
    assert.equal(result.problems.length, 0)
    assert.equal(result.shots[0].verdict, 'pass')
  })
})

test('looksLikeAuthRequired：只认未认证页的症状', () => {
  assert.equal(looksLikeAuthRequired('dsh web authentication required; reopen the URL printed by dsh web.'), true)
  assert.equal(looksLikeAuthRequired('插件面板 会话 设置'), false)
  assert.equal(looksLikeAuthRequired(''), false)
  assert.equal(AUTH_REQUIRED_MARKER, 'authentication required')
})

test('rollupScenarioVerdict：证据问题/截图失败优先，blocked 不冒充 pass', () => {
  assert.deepEqual(rollupScenarioVerdict({ commandVerdict: 'pass', evidenceProblems: [], shots: [], requireScreenshots: false }), {
    verdict: 'pass',
    exitCode: 0,
    reasons: [],
  })
  const failedCommand = rollupScenarioVerdict({ commandVerdict: 'fail', evidenceProblems: [], shots: [], requireScreenshots: false })
  assert.equal(failedCommand.verdict, 'fail')
  assert.equal(failedCommand.exitCode, 1)

  const unknown = rollupScenarioVerdict({ commandVerdict: 'unknown', evidenceProblems: [], shots: [], requireScreenshots: false })
  assert.equal(unknown.verdict, 'unknown')
  assert.equal(unknown.exitCode, 2)
  assert.equal(rollupScenarioVerdict({ evidenceProblems: [], shots: [], requireScreenshots: false }).verdict, 'unknown')

  const evidence = rollupScenarioVerdict({ commandVerdict: 'pass', evidenceProblems: ['身份链不一致'], shots: [], requireScreenshots: false })
  assert.equal(evidence.verdict, 'fail')
  assert.equal(evidence.exitCode, 1)

  const badShot = rollupScenarioVerdict({
    commandVerdict: 'pass',
    evidenceProblems: [],
    shots: [{ id: 'x', png: '', sidecar: '', bytes: 1, verdict: 'fail', problems: ['缺字段'] }],
    requireScreenshots: true,
  })
  assert.equal(badShot.verdict, 'fail')

  const missingShots = rollupScenarioVerdict({ commandVerdict: 'pass', evidenceProblems: [], shots: [], requireScreenshots: true })
  assert.equal(missingShots.verdict, 'fail')
  assert.equal(missingShots.exitCode, 1)
})

test('runBaseScenario：capability 门 blocked 时早退，summary 形状完整且落盘', async () => {
  await withTempDirAsync(async (dir) => {
    const outDir = join(dir, 'out')
    const result = await runBaseScenario({
      home: join(dir, 'no-source-home'),
      profile: 'web',
      scenario: 'verify/scenarios/web-ui-smoke.ts',
      out: outDir,
      repoRoot: join(dir, 'no-such-repo'),
      requireScreenshots: true,
    })
    assert.equal(result.exitCode, 2)
    const summary = result.summary
    assert.equal(summary.schemaVersion, 1)
    assert.equal(summary.tool, 'run-base-verify')
    assert.equal(summary.mode, 'scenario')
    assert.equal(summary.verdict, 'unknown')
    assert.equal(summary.exitCode, 2)
    assert.equal(summary.profile, 'web')
    assert.deepEqual(summary.commands, [])
    assert.deepEqual(summary.screenshots, [])
    assert.ok(summary.notes.some((note) => note.includes('capability 门未通过')))
    const written = JSON.parse(readFileSync(summary.summaryPath, 'utf8'))
    assert.equal(written.verdict, 'unknown')
    assert.equal(written.mode, 'scenario')
    assert.equal(written.schemaVersion, 1)
  })
})

/** 异步版 withTempDir：回调里 await，结束后删目录。 */
async function withTempDirAsync(run) {
  const dir = mkdtempSync(join(tmpdir(), 'base-lane-'))
  try {
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
