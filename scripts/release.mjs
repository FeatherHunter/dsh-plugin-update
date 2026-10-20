#!/usr/bin/env node
/**
 * scripts/release.mjs —— dsh-plugin-update 一键发版编排（prepare → gate → commit → tag → push → publish → Release → verify）。
 *
 * 存在的理由（2026-10-20 retro）：发版是高频动作（两天三版），但每次都由人/AI 现场手写
 * bump、门禁、commit、tag、push、publish、gh release 的顺序与参数——顺序一走神就漏（pack 目录名、
 * 忘记推 tag、Release 说明手抄漂移）。本脚本把「顺序 + 断言」固化成一条命令，把内容判断留给人：
 * 你只负责把本次改动写进 CHANGELOG 的 `## [Unreleased]`，脚本负责把它收口、验证、发布、核对。
 * 发布通道复用仓库既有的 `scripts/publish-token.ps1`（token 无人值守；回执 DONE/POST-OK）。
 *
 * 用法：
 *   node scripts/release.mjs --version 0.18.37              # 计划（只读预检 + 打印将执行的步骤）
 *   node scripts/release.mjs --version 0.18.37 --yes        # 全流程
 *   node scripts/release.mjs --verify 0.18.36               # 只做发布后断言（不改任何东西）
 * 常用旗标：
 *   --skip-check       跳过 `npm run check`（门禁已在别处跑绿时用；默认必跑）
 *   --skip-publish     不发 npm（只到 tag/push 为止）
 *   --skip-push        不 push（本地 commit/tag 演练）
 *   --skip-github      不建 GitHub Release
 *   --allow-dirty      允许工作区有已跟踪改动（默认要求干净，防止把无关改动卷进发版提交）
 *   --allow-branch     允许在非 master 分支发版（默认拒绝，见 docs/maintainers.md「分支口径」）
 *   --message <text>   发版提交信息（默认 `chore(release): <版本> 收口`）
 *   --notes-extra <s>  追加到 GitHub Release 说明末尾的一行（可选）
 *
 * 退出码：0 = 成功/计划通过；1 = 失败（看 FAIL 行）；2 = 用法错误。
 * 日志：控制台 + `.scratch/release-<版本>.log`（含 STAGE 行，可被 Agent/人轮询）。
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PKG_NAME = PKG.name
const CUR_VERSION = PKG.version

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(name)
const optValue = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const VERSION = optValue('--version')
const VERIFY_ONLY = hasFlag('--verify')
const VERIFY_VERSION = VERIFY_ONLY ? (optValue('--verify') ?? VERSION) : null
const YES = hasFlag('--yes')
const SKIP_CHECK = hasFlag('--skip-check')
const SKIP_PUBLISH = hasFlag('--skip-publish')
const SKIP_PUSH = hasFlag('--skip-push')
const SKIP_GITHUB = hasFlag('--skip-github')
const ALLOW_DIRTY = hasFlag('--allow-dirty')
const ALLOW_BRANCH = hasFlag('--allow-branch')
const COMMIT_MESSAGE = optValue('--message', VERSION ? `chore(release): ${VERSION} 收口` : '')
const NOTES_EXTRA = optValue('--notes-extra', '')
const WINDOWS = process.platform === 'win32'
const scratchDir = join(ROOT, '.scratch')
if (!existsSync(scratchDir)) mkdirSync(scratchDir, { recursive: true })
const logFile = join(scratchDir, `release-${VERIFY_VERSION ?? VERSION ?? 'plan'}.log`)
const started = Date.now()

function log(line) {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  const text = `[${stamp}] ${line}`
  console.log(text)
  try { appendFileSync(logFile, text + '\n', 'utf8') } catch { /* 日志写不进去不该拦住发版 */ }
}
function fail(message, code = 1) {
  log('FAIL ' + message)
  process.exit(code)
}
function stage(n, total, title) {
  log(`STAGE ${n}/${total} ${title}`)
}
function elapsed() { return `${((Date.now() - started) / 1000).toFixed(1)}s` }

/** 跑命令并继承 stdio（流式进度给用户看）；失败即 FAIL。 */
function run(title, cmd, args, { allowFail = false } = {}) {
  log('    » ' + title)
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: WINDOWS && !/^(pwsh|node)$/i.test(cmd) })
  if (r.status !== 0 && !allowFail) fail(`${title} 失败（exit ${r.status}）：${cmd} ${args.join(' ')}`)
  return r.status ?? 1
}
/** 静默跑命令，返回 {ok, status, out, err}。 */
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: WINDOWS && !/^(pwsh|node)$/i.test(cmd) })
  return { ok: r.status === 0, status: r.status ?? 1, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() }
}
function mustCapture(title, cmd, args) {
  const r = capture(cmd, args)
  if (!r.ok) fail(`${title} 失败：${cmd} ${args.join(' ')} → ${(r.err || r.out).slice(-400)}`)
  return r.out
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v ?? '').trim())
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? '' } : null
}
function compareVersions(a, b) {
  const x = parseSemver(a), y = parseSemver(b)
  if (!x || !y) return NaN
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k]
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

function gitIsClean() {
  const dirty = capture('git', ['status', '--porcelain']).out.split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l && !l.startsWith('??'))
  return dirty
}
function changelogPath() { return join(ROOT, 'CHANGELOG.md') }
function changelogHas(version) {
  const text = readFileSync(changelogPath(), 'utf8')
  return new RegExp(`^##\\s*\\[${String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'm').test(text)
}
function changelogHasUnreleased() {
  return /^##\s*\[Unreleased\]/m.test(readFileSync(changelogPath(), 'utf8'))
}
function tokenAvailable() {
  if (!WINDOWS) return Boolean(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN)
  const r = capture('pwsh', ['-NoProfile', '-Command',
    "$t=[Environment]::GetEnvironmentVariable('NODE_AUTH_TOKEN','User'); if([string]::IsNullOrWhiteSpace($t)){$t=$env:NODE_AUTH_TOKEN}; if([string]::IsNullOrWhiteSpace($t)){'MISSING'} else {'OK'}"])
  return r.out.includes('OK')
}
function packagePublished(version) {
  const r = capture('npm', ['view', `${PKG_NAME}@${version}`, 'version', '--json'])
  return r.ok && r.out.includes(String(version))
}

// ────────────────────────── 发布后断言（verify） ──────────────────────────
function verifyRelease(version, { total = 6 } = {}) {
  let n = 0
  const assert = (cond, msg) => { n += 1; if (!cond) fail(`断言 ${n} 失败：${msg}`) }
  stage(1, total, `断言 npm 侧：${PKG_NAME}@${version} 可见`)
  let seen = false
  for (let i = 0; i < 40; i += 1) {
    if (packagePublished(version)) { seen = true; break }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000) // 15s 一次，最多 2 分钟
  }
  assert(seen, `npm 上查不到 ${PKG_NAME}@${version}（已受理但未可见？稍后重跑 --verify）`)
  stage(2, total, '断言 npm dist-tag latest 指向本版')
  const latest = capture('npm', ['view', PKG_NAME, 'version'])
  assert(latest.ok && latest.out.trim() === version, `latest=${latest.out.trim() || '(查不到)'} ≠ ${version}`)
  stage(3, total, '断言本地 tag 存在且指向 HEAD')
  const tagList = capture('git', ['tag', '-l', `v${version}`])
  assert(tagList.ok && tagList.out.trim() === `v${version}`, `本地没有 tag v${version}`)
  const tagCommit = capture('git', ['rev-list', '-n', '1', `v${version}`])
  const head = capture('git', ['rev-parse', 'HEAD'])
  assert(tagCommit.ok && head.ok && tagCommit.out.trim() === head.out.trim(), `tag v${version} 不指向 HEAD（tag=${tagCommit.out.slice(0, 12)} head=${head.out.slice(0, 12)}）`)
  if (!SKIP_GITHUB) {
    stage(4, total, '断言 GitHub Release 存在且指向本 tag')
    const rel = capture('gh', ['release', 'view', `v${version}`, '--json', 'tagName,assets'])
    let relTag = ''
    try { relTag = JSON.parse(rel.out || '{}').tagName ?? '' } catch { relTag = '' }
    assert(rel.ok && relTag === `v${version}`, `gh release v${version} 不存在或 tagName 不符（收到 ${relTag || '(空)'}）`)
  }
  stage(5, total, '断言发布产物文件清单包含 dist（npm pack --dry-run）')
  const pack = capture('npm', ['pack', '--dry-run', '--json'])
  if (pack.ok) {
    try {
      // npm pack 的 prepack 构建行会把 `[dsh-plugin-update] …` 打到 stdout，JSON 在最后一段。
      const tail = pack.out.lastIndexOf('\n[')
      const jsonText = tail >= 0 ? pack.out.slice(tail + 1) : pack.out.slice(pack.out.indexOf('['))
      const parsed = JSON.parse(jsonText)
      const info = Array.isArray(parsed) ? parsed.find((x) => x && typeof x === 'object') : parsed
      assert(info?.name === PKG_NAME && info?.version === version, `dry-run 包身份 ${info?.name}@${info?.version} 不符`)
      assert(Array.isArray(info.files) && info.files.some((f) => String(f.path).startsWith('dist/')), 'dry-run 产物里没有 dist/')
    } catch (error) { fail(`解析 npm pack --dry-run 失败：${error instanceof Error ? error.message : String(error)}`) }
  } else {
    fail('npm pack --dry-run 失败：' + (pack.err || pack.out).slice(-300))
  }
  stage(6, total, '发布后断言全部通过')
  log(`VERIFY-OK ${PKG_NAME}@${version}（latest、tag→HEAD、GitHub Release、产物清单）用时 ${elapsed()}`)
}

// ────────────────────────── 计划模式（只读预检） ──────────────────────────
function plan(version, total) {
  log(`PLAN 发版计划：${PKG_NAME} ${CUR_VERSION} → ${version}（未做任何写操作；加 --yes 执行）`)
  const blockers = []
  // 1. 分支
  stage(1, total, '预检：分支口径')
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim()
  log(`   当前分支 ${branch}`)
  if (branch !== 'master' && !ALLOW_BRANCH) blockers.push(`当前不在 master（${branch}）；确认要走这条线就加 --allow-branch`)
  // 2. 工作区干净
  stage(2, total, '预检：工作区干净（未跟踪文件不算）')
  const dirty = gitIsClean()
  if (dirty.length && !ALLOW_DIRTY) blockers.push(`工作区有已跟踪改动：${dirty.slice(0, 5).join(' | ')}（先提交/还原，或加 --allow-dirty）`)
  else log('   工作区干净')
  // 3. CHANGELOG 节
  stage(3, total, '预检：CHANGELOG 有 Unreleased 或目标版本节')
  const hasTarget = changelogHas(version)
  const hasUnreleased = changelogHasUnreleased()
  if (!hasTarget && !hasUnreleased) blockers.push(`CHANGELOG.md 既没有 [${version}] 也没有 [Unreleased]；先写 Changelog`)
  else log(hasTarget ? `   已有 [${version}] 节（直接收口）` : '   有 [Unreleased] 节（将改名为目标版本 + 日期）')
  // 4. 版本号前进方向
  stage(4, total, '预检：版本号大于当前且未被发布')
  const cmp = compareVersions(version, CUR_VERSION)
  if (Number.isNaN(cmp)) blockers.push(`版本号不合规：${version}`)
  else if (cmp <= 0) blockers.push(`版本号必须大于当前 ${CUR_VERSION}（收到 ${version}）`)
  if (packagePublished(version)) blockers.push(`npm 上已存在 ${PKG_NAME}@${version}；换一个版本号`)
  // 5. token / gh
  stage(5, total, '预检：发布通道（token、gh）')
  if (!SKIP_PUBLISH && !tokenAvailable()) blockers.push('缺 NODE_AUTH_TOKEN（User 环境变量或进程环境变量）；见 docs/maintainers.md token 通道')
  if (!SKIP_GITHUB && !capture('gh', ['--version']).ok) blockers.push('找不到 gh CLI（GitHub Release 需要）；或加 --skip-github')
  // 6. 打印将执行的步骤
  stage(6, total, '将执行的步骤（--yes 时逐条执行）')
  const steps = [
    `CHANGELOG: ${hasTarget ? '保留' : '[Unreleased] → '} [${version}] - <今天日期>`,
    `版本号: npm version ${version} --no-git-tag-version（package.json + package-lock.json）`,
    SKIP_CHECK ? '门禁: 跳过（--skip-check）' : '门禁: npm run check（typecheck + build + 1958 例 + bilingual）',
    `提交: git add CHANGELOG.md package.json package-lock.json；git commit -m "${COMMIT_MESSAGE}"`,
    `打标: git tag -a v${version} -m "v${version}"`,
    SKIP_PUSH ? '推送: 跳过（--skip-push）' : '推送: git push origin master && git push origin v' + version,
    SKIP_PUBLISH ? '发布: 跳过（--skip-publish）' : '发布: scripts/publish-token.ps1 -SkipGate -FullPost（token 无人值守）',
    SKIP_GITHUB ? 'Release: 跳过（--skip-github）' : 'Release: gh release create v' + version + '（说明直接取 CHANGELOG 该节，scripts/release-notes.mjs）',
    '断言: npm 可见 + latest + tag→HEAD + Release + 产物清单（同 --verify）',
  ]
  for (const s of steps) log('   - ' + s)
  if (blockers.length) {
    log('PLAN 有阻塞项：')
    for (const b of blockers) log('   ✗ ' + b)
    process.exit(1)
  }
  log(`PLAN 预检通过；用时 ${elapsed()}。加 --yes 执行。`)
}

// ────────────────────────── 执行 ──────────────────────────
function finalizeChangelog(version) {
  const file = changelogPath()
  const text = readFileSync(file, 'utf8')
  if (changelogHas(version)) { log('   CHANGELOG 已有目标版本节，保留原文'); return }
  const date = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-')
  const next = text.replace(/^##\s*\[Unreleased\][^\n]*$/m, `## [${version}] - ${date}`)
  if (next === text) fail('CHANGELOG 收口失败：没找到 [Unreleased] 标题行')
  writeFileSync(file, next, 'utf8')
  log(`   CHANGELOG [Unreleased] → [${version}] - ${date}`)
}
function releaseNotesFor(version) {
  const r = capture('node', ['scripts/release-notes.mjs', version])
  if (!r.ok || !r.out) fail(`取 CHANGELOG[${version}] 节失败（scripts/release-notes.mjs）`)
  return NOTES_EXTRA ? `${r.out}\n\n${NOTES_EXTRA}` : r.out
}
function publishViaToken(version) {
  const wrapper = join(scratchDir, `release-publish-${version}.ps1`)
  const publishLog = join(scratchDir, `publish-token-${version}.log`)
  const scriptPath = join(ROOT, 'scripts', 'publish-token.ps1')
  if (!existsSync(scriptPath)) fail('缺 scripts/publish-token.ps1（token 发布通道）')
  const q = (p) => "'" + String(p).replace(/'/g, "''") + "'"
  writeFileSync(wrapper, [
    '$ErrorActionPreference = "Continue"',
    "$t = [Environment]::GetEnvironmentVariable('NODE_AUTH_TOKEN','User')",
    'if ([string]::IsNullOrWhiteSpace($t)) { $t = $env:NODE_AUTH_TOKEN }',
    'if ([string]::IsNullOrWhiteSpace($t)) { Write-Host "TOKEN-MISSING"; exit 2 }',
    '$env:NODE_AUTH_TOKEN = $t',
    `& ${q(scriptPath)} -SkipGate -FullPost -LogPath ${q(publishLog)}`,
    'exit $LASTEXITCODE',
  ].join('\r\n'), 'utf8')
  try {
    const r = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], { cwd: ROOT, stdio: 'inherit' })
    const logText = existsSync(publishLog) ? readFileSync(publishLog, 'utf8') : ''
    const accepted = /DONE 已发/.test(logText) || /POST-OK|POST 可见/.test(logText) || r.status === 0
    if (r.status !== 0 || !accepted) fail(`publish-token.ps1 未确认受理（exit ${r.status}）；看 ${publishLog}`)
    log('   发布通道已受理（DONE/POST-OK 见上）')
  } finally {
    // wrapper 只含调用参数，不清理也不碍事；publish-token 自己清理临时 npmrc
  }
}
function createGithubRelease(version) {
  const notes = releaseNotesFor(version)
  const notesFile = join(scratchDir, `release-notes-${version}.md`)
  writeFileSync(notesFile, notes + '\n', 'utf8')
  const exists = capture('gh', ['release', 'view', `v${version}`]).ok
  const args = exists
    ? ['release', 'edit', `v${version}`, '--notes-file', notesFile]
    : ['release', 'create', `v${version}`, '--title', `v${version}`, '--notes-file', notesFile]
  const r = spawnSync('gh', args, { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) fail(`GitHub Release ${exists ? 'edit' : 'create'} 失败（exit ${r.status}）`)
  log(`   GitHub Release v${version} ${exists ? '已更新' : '已创建'}`)
}

function execute(version, total) {
  log(`START 发版执行：${PKG_NAME} ${CUR_VERSION} → ${version}（日志 ${logFile}）`)
  stage(1, total, 'CHANGELOG 收口（[Unreleased] → 目标版本 + 日期）')
  finalizeChangelog(version)
  stage(2, total, `版本号抬升：npm version ${version} --no-git-tag-version`)
  run('npm version', 'npm', ['version', version, '--no-git-tag-version'])
  stage(3, total, SKIP_CHECK ? '门禁跳过（--skip-check）' : '门禁：npm run check（typecheck+build+测试+bilingual）')
  if (!SKIP_CHECK) run('npm run check', 'npm', ['run', 'check'])
  stage(4, total, '发版提交（只暂存 CHANGELOG/package.json/package-lock.json）')
  run('git add', 'git', ['add', 'CHANGELOG.md', 'package.json', 'package-lock.json'])
  run('git commit', 'git', ['commit', '-m', COMMIT_MESSAGE])
  stage(5, total, `打 tag v${version}`)
  run('git tag', 'git', ['tag', '-a', `v${version}`, '-m', `v${version}`])
  stage(6, total, SKIP_PUSH ? '推送跳过（--skip-push）' : '推送 master + tag')
  if (!SKIP_PUSH) {
    run('git push master', 'git', ['push', 'origin', 'master'])
    run('git push tag', 'git', ['push', 'origin', `v${version}`])
  }
  stage(7, total, SKIP_PUBLISH ? 'npm 发布跳过（--skip-publish）' : 'npm 发布（token 通道，-FullPost 等到可见）')
  if (!SKIP_PUBLISH) publishViaToken(version)
  stage(8, total, SKIP_GITHUB ? 'GitHub Release 跳过（--skip-github）' : 'GitHub Release（说明取自 CHANGELOG 该节）')
  if (!SKIP_GITHUB) createGithubRelease(version)
  stage(9, total, '发布后断言（npm 可见/latest/tag→HEAD/Release/产物清单）')
  verifyRelease(version, { total: 6 })
  log(`DONE 发版完成 ${PKG_NAME}@${version}，总用时 ${elapsed()}`)
}

// ────────────────────────── main ──────────────────────────
if (VERIFY_ONLY) {
  const version = VERIFY_VERSION ?? CUR_VERSION
  log(`VERIFY 发布后断言：${PKG_NAME}@${version}`)
  verifyRelease(version)
  process.exit(0)
}
if (!VERSION) {
  process.stderr.write('用法：node scripts/release.mjs --version <x.y.z> [--yes]  |  --verify <x.y.z>\n')
  process.exit(2)
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(VERSION)) fail(`版本号不合规：${VERSION}`, 2)
if (compareVersions(VERSION, CUR_VERSION) <= 0) fail(`版本号必须大于当前 ${CUR_VERSION}（收到 ${VERSION}），先改 CHANGELOG/版本再跑`, 2)

if (YES) execute(VERSION, 9)
else plan(VERSION, 6)
