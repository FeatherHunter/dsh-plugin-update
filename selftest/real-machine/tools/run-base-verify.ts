/**
 * selftest/real-machine/tools/run-base-verify.ts —— base dsh-verify 真机预检命令行入口。
 *
 * 用法（PowerShell，工作树为 D:/dsh-plugin/_wt263/tbase）：
 *   node selftest/real-machine/tools/run-base-verify.ts --home <DSH_HOME 隔离目录> --profile web --out <证据目录>
 *   node selftest/real-machine/tools/run-base-verify.ts --home D:/dsh-plugin/_wt263/runtime/base-verify-integration/source-home --profile web --out D:/dsh-plugin/_wt263/runtime/base-verify-integration/run-1 --tarball dist/dsh-plugin-update-0.18.39.tgz --json
 *
 * 参数：
 *   --home    <dir>  源 DSH_HOME（只读；必须含 profiles/<profile>）
 *   --profile <name> profile 名（如 web）
 *   --out     <dir>  证据输出目录（工具在里面建隔离 home/work/raw 并写汇总）
 *   --tarball <tgz>  可选：本仓 dist tgz；给了就用自写 gzip+tar 读取器解进隔离 profile
 *   --json            stdout 只打汇总 JSON
 *
 * 退出码：0=全 pass（skip 允许）；1=有 fail（含证据身份链不一致）；2=blocked/工具错误。
 * 前置：base 的 devDependency 已安装（npm ci），且 --home 里的 profile 已配置好本插件。
 */
import { resolve } from 'node:path'
import { runBaseVerifyPreflight } from '../base-verify/preflight.ts'
import type { BaseVerifySummary } from '../base-verify/preflight.ts'

interface CliOptions {
  readonly home: string
  readonly profile: string
  readonly out: string
  readonly tarball?: string
  readonly json: boolean
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>()
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--json') {
      json = true
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
  return { home: resolve(home), profile, out: resolve(out), ...(tarball ? { tarball: resolve(tarball) } : {}), json }
}

function printHuman(summary: BaseVerifySummary): void {
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const result = await runBaseVerifyPreflight(options)
  if (options.json) console.log(JSON.stringify(result.summary, null, 2))
  else printHuman(result.summary)
  process.exit(result.exitCode)
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error('[run-base-verify] 工具错误（blocked）：' + message)
  if (error instanceof Error && error.stack) console.error(error.stack)
  process.exit(2)
})
