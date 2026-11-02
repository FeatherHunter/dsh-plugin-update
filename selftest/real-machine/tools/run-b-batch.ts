/**
 * selftest/real-machine/tools/run-b-batch.ts —— 场景 b（三包同装：两席批量集成方 + 一纯目标）命令行入口。
 *
 * 用法（PowerShell）：
 *   node selftest/real-machine/tools/run-b-batch.ts --run-base-dir D:/dsh-plugin/_wt263/runtime/t2-266
 * 可选：--worktree <路径> --verdaccio-install-dir <路径> --esbuild <esbuild.exe> --stamp <YYYYMMDDTHHMMSS> --maintainer-home <维护者 DSH_HOME>
 *   --fault <kind>:<slot>  can-red 故障注入（kind ∈ skip-variant,stale-variant；slot ∈ a/b/c），预期整体 fail。
 *
 * 退出码：0=全部 pass（known-red 不影响出口）；1=有 fail/unknown；2=blocked / 工具错误。
 */
import { join } from 'node:path'
import type { ScenarioFaultInjection } from '../runtime/scenario-runner.ts'
import { runBatchTwoIntegrators } from '../scenarios/b-batch-two-integrators.ts'

interface CliOptions {
  worktree: string
  runBaseDir: string
  verdaccioInstallDir: string
  esbuildPath: string
  stamp?: string
  maintainerHome?: string
  fault?: ScenarioFaultInjection
}

function parseFault(raw: string | undefined): ScenarioFaultInjection | undefined {
  if (!raw) return undefined
  const parts = raw.split(':')
  const kind = parts[0]
  const slotKey = parts[1]
  if (kind !== 'skip-variant' && kind !== 'stale-variant') throw new Error('--fault 的 kind 只支持 skip-variant/stale-variant，收到：' + raw)
  if (slotKey !== 'a' && slotKey !== 'b' && slotKey !== 'c') throw new Error('--fault 的 slot 只支持 a/b/c，收到：' + raw)
  return {
    kind: kind as 'skip-variant' | 'stale-variant',
    slotKey: slotKey as 'a' | 'b' | 'c',
    description: raw,
  }
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      values.set(item.slice(2), next)
      index += 1
    }
  }
  const worktree = values.get('worktree') || process.cwd()
  const runBaseDir = values.get('run-base-dir')
  if (!runBaseDir) throw new Error('必须传 --run-base-dir（真机临时目录根，例如 D:/dsh-plugin/_wt263/runtime/t2-266）')
  return {
    worktree,
    runBaseDir,
    verdaccioInstallDir: values.get('verdaccio-install-dir') || 'D:/dsh-plugin/_wt263/runtime/tools/verdaccio',
    esbuildPath: values.get('esbuild') || join(worktree, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    stamp: values.get('stamp'),
    maintainerHome: values.get('maintainer-home'),
    fault: parseFault(values.get('fault')),
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const manifest = await runBatchTwoIntegrators(options)
  console.log(JSON.stringify({ runDir: join(options.runBaseDir, manifest.runId), verdict: manifest.verdict, exitCode: manifest.exitCode, scenarioId: manifest.scenarioId }, null, 2))
  process.exit(manifest.exitCode)
}

main().catch((error) => {
  console.error('[run-b-batch] 工具错误（blocked）：' + (error instanceof Error ? error.message : String(error)))
  if (error instanceof Error && error.stack) console.error(error.stack)
  process.exit(2)
})
