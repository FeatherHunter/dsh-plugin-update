/**
 * selftest/real-machine/tools/run-base-verify.ts —— base dsh-verify 真机预检命令行入口。
 *
 * 两种用法：
 *
 * A. 预检（既有行为，不变）：
 *   node selftest/real-machine/tools/run-base-verify.ts --home <DSH_HOME 隔离目录> --profile web --out <证据目录>
 *   node selftest/real-machine/tools/run-base-verify.ts --home D:/dsh-plugin/_wt263/runtime/base-verify-integration/source-home --profile web --out D:/dsh-plugin/_wt263/runtime/base-verify-integration/run-1 --tarball dist/dsh-plugin-update-0.18.39.tgz --json
 *
 * B. 场景快速通道（#263）：
 *   node selftest/real-machine/tools/run-base-verify.ts --home <源 DSH_HOME> --profile web --out <证据目录> --scenario verify/scenarios/web-ui-smoke.ts --json
 *   先复制隔离 home，再让 base run 跑场景；截图必须每张都有六字段 sidecar，缺了按 fail 记。
 *
 * 参数：
 *   --home    <dir>  源 DSH_HOME（只读；必须含 profiles/<profile>）
 *   --profile <name> profile 名（如 web）
 *   --out     <dir>  证据输出目录（工具在里面建隔离 home/work/shots/raw 并写汇总）
 *   --tarball <tgz>  可选（仅预检）：本仓 dist tgz；给了就用自写 gzip+tar 读取器解进隔离 profile
 *   --scenario <ts>  可选：改用场景快速通道（run <scenario>）
 *   --playwright <dir> 可选（仅场景）：覆盖 DSH_VERIFY_PLAYWRIGHT
 *   --no-screenshots 可选（仅场景）：无截图不算失败（非 UI 场景用；UI 场景别关）
 *   --json            stdout 只打汇总 JSON
 *
 * 退出码：0=全 pass（skip 允许）；1=有 fail（含证据身份链不一致）；2=blocked/工具错误。
 * 前置：base 的 devDependency 已安装（npm ci），且 --home 里的 profile 已配置好本插件。
 */
import { resolve } from 'node:path'
import { runBaseVerifyPreflight } from '../base-verify/preflight.ts'
import type { BaseVerifySummary } from '../base-verify/preflight.ts'
import { runBaseScenario } from '../base-verify/scenario-run.ts'
import type { BaseScenarioSummary } from '../base-verify/scenario-run.ts'

interface CliOptions {
  readonly home: string
  readonly profile: string
  readonly out: string
  readonly tarball?: string
  readonly scenario?: string
  readonly playwright?: string
  readonly requireScreenshots: boolean
  readonly json: boolean
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>()
  let json = false
  let requireScreenshots = true
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--json') {
      json = true
      continue
    }
    if (item === '--no-screenshots') {
      requireScreenshots = false
      continue
    }
    if (!item.startsWith('--')) continue
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      values.set(item.slice(2), next)
      index += 1
    }
  }
  const home = values.get('home')
  const profile = values.get('profile')
  const out = values.get('out')
  if (!home) throw new Error('必须传 --home <DSH_HOME 隔离目录>')
  if (!profile) throw new Error('必须传 --profile <名>（例如 web）')
  if (!out) throw new Error('必须传 --out <证据目录>')
  const tarball = values.get('tarball')
  const scenario = values.get('scenario')
  const playwright = values.get('playwright')
  if (scenario !== undefined && tarball !== undefined) {
    throw new Error('--scenario 与 --tarball 不能同时用：场景模式不装 tarball')
  }
  return {
    home: resolve(home),
    profile,
    out: resolve(out),
    ...(tarball ? { tarball: resolve(tarball) } : {}),
    ...(scenario ? { scenario: resolve(scenario) } : {}),
    ...(playwright ? { playwright: resolve(playwright) } : {}),
    requireScreenshots,
    json,
  }
}

function printPreflightHuman(summary: BaseVerifySummary): void {
  const lines: string[] = []
  lines.push('[run-base-verify] base=' + (summary.baseVersion ?? '（未知）') + '；profile=' + summary.profile)
  lines.push('  隔离 home：' + summary.isolatedHome)
  if (summary.tarball) {
    lines.push(
      '  tarball：' +
        summary.tarball.path +
        ' sha256=' +
        summary.tarball.sha256 +
        '（' +
        summary.tarball.packageName +
        '@' +
        summary.tarball.version +
        '，' +
        summary.tarball.files +
        ' 个文件）',
    )
  }
  for (const command of summary.commands) {
    const tally = command.tally
      ? ' pass=' + command.tally.pass + ' fail=' + command.tally.fail + ' skip=' + command.tally.skip + ' blocked=' + command.tally.blocked
      : ''
    lines.push(
      '  ' +
        command.command +
        ' exit=' +
        String(command.exitCode) +
        ' verdict=' +
        command.verdict +
        tally +
        '（' +
        command.durationMs +
        'ms）',
    )
    if (command.reportSha256) lines.push('    report sha256=' + command.reportSha256)
    if (command.reportPath) lines.push('    report=' + command.reportPath)
    for (const reason of command.blockedReasons ?? []) {
      lines.push('    blocked[' + reason.code + '] ' + reason.message + (reason.hint ? '（' + reason.hint + '）' : ''))
    }
  }
  for (const note of summary.notes) lines.push('  note: ' + note)
  lines.push('  汇总：' + summary.summaryPath)
  lines.push('  判定：verdict=' + summary.verdict + ' exit=' + String(summary.exitCode))
  console.log(lines.join('\n'))
}

function printScenarioHuman(summary: BaseScenarioSummary): void {
  const lines: string[] = []
  lines.push('[run-base-verify] 模式=scenario；base=' + (summary.baseVersion ?? '（未知）') + '；profile=' + summary.profile)
  lines.push('  场景：' + (summary.scenario?.path ?? '（未记录）') + (summary.scenario?.sha256 ? ' sha256=' + summary.scenario.sha256 : ''))
  lines.push('  隔离 home：' + summary.isolatedHome)
  lines.push('  工作目录：' + summary.workRoot)
  for (const command of summary.commands) {
    const tally = command.tally
      ? ' pass=' + command.tally.pass + ' fail=' + command.tally.fail + ' skip=' + command.tally.skip + ' blocked=' + command.tally.blocked
      : ''
    lines.push(
      '  run exit=' + String(command.exitCode) + ' verdict=' + command.verdict + tally + '（' + command.durationMs + 'ms）',
    )
    if (command.reportPath) lines.push('    report=' + command.reportPath)
    if (command.reportSha256) lines.push('    report sha256=' + command.reportSha256)
  }
  lines.push('  截图：' + String(summary.screenshots.length) + ' 张（目录 ' + summary.shotsDir + '）')
  for (const shot of summary.screenshots) {
    lines.push('    ' + shot.id + '.png ' + String(shot.bytes) + ' 字节 verdict=' + shot.verdict + (shot.problems.length ? '（' + shot.problems.join('；') + '）' : ''))
  }
  if (summary.instance) {
    lines.push(
      '  实例：' + summary.instance.instanceId + ' pid=' + String(summary.instance.pid ?? '?') + ' port=' + String(summary.instance.port ?? '?') + ' ready=' + String(summary.instance.readyMs ?? '?') + 'ms',
    )
  }
  for (const note of summary.notes) lines.push('  note: ' + note)
  lines.push('  汇总：' + summary.summaryPath)
  lines.push('  判定：verdict=' + summary.verdict + ' exit=' + String(summary.exitCode))
  console.log(lines.join('\n'))
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.scenario !== undefined) {
    const result = await runBaseScenario({
      home: options.home,
      profile: options.profile,
      scenario: options.scenario,
      out: options.out,
      requireScreenshots: options.requireScreenshots,
      ...(options.playwright ? { playwrightPath: options.playwright } : {}),
    })
    if (options.json) console.log(JSON.stringify(result.summary, null, 2))
    else printScenarioHuman(result.summary)
    process.exit(result.exitCode)
  }
  const result = await runBaseVerifyPreflight(options)
  if (options.json) console.log(JSON.stringify(result.summary, null, 2))
  else printPreflightHuman(result.summary)
  process.exit(result.exitCode)
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error('[run-base-verify] 工具错误（blocked）：' + message)
  if (error instanceof Error && error.stack) console.error(error.stack)
  process.exit(2)
})
