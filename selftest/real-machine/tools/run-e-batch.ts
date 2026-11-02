/**
 * selftest/real-machine/tools/run-e-batch.ts —— T5（#269）组 E 命令行入口。
 *
 * 用法（PowerShell，工作树是 D:/dsh-plugin/_wt263/t5）：
 *   node selftest/real-machine/tools/run-e-batch.ts --mode three-package-upgrade --run-base-dir D:/dsh-plugin/_wt263/runtime/t5-269
 *   --mode three-package-upgrade | partial-failure | resume-retry | can-red
 * 可选：--worktree <路径> --verdaccio-install-dir <路径> --esbuild <esbuild.exe> --stamp <YYYYMMDDTHHMMSS> --maintainer-home <维护者 DSH_HOME>
 *
 * 退出码：0=全部 pass（known-red 不影响出口）；1=有 fail/unknown；2=blocked / 工具错误。
 */
import { join } from 'node:path'
import { runEBatchScenario } from '../scenarios/e-batch-three-package.ts'
import type { EBatchMode } from '../scenarios/e-batch-three-package.ts'

interface CliOptions {
  worktree: string
  runBaseDir: string
  verdaccioInstallDir: string
  esbuildPath: string
  stamp?: string
  maintainerHome?: string
  mode: EBatchMode
  syncEvidence: boolean
}

function parseMode(value: string | undefined): EBatchMode {
  if (value === 'three-package-upgrade' || value === 'partial-failure' || value === 'resume-retry' || value === 'can-red') return value
  throw new Error('必须传 --mode three-package-upgrade|partial-failure|resume-retry|can-red')
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    if (item === '--no-evidence-sync') {
      values.set('no-evidence-sync', 'true')
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      values.set(item.slice(2), next)
      index += 1
    }
  }
  const worktree = values.get('worktree') || process.cwd()
  const runBaseDir = values.get('run-base-dir')
  if (!runBaseDir) throw new Error('必须传 --run-base-dir（真机临时目录根，例如 D:/dsh-plugin/_wt263/runtime/t5-269）')
  return {
    worktree,
    runBaseDir,
    verdaccioInstallDir: values.get('verdaccio-install-dir') || 'D:/dsh-plugin/_wt263/runtime/tools/verdaccio',
    esbuildPath: values.get('esbuild') || join(worktree, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    stamp: values.get('stamp'),
    maintainerHome: values.get('maintainer-home'),
    mode: parseMode(values.get('mode')),
    syncEvidence: !values.has('no-evidence-sync'),
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const manifest = await runEBatchScenario(options)
  console.log(JSON.stringify({ runDir: join(options.runBaseDir, manifest.runId), verdict: manifest.verdict, exitCode: manifest.exitCode }, null, 2))
  process.exit(manifest.exitCode)
}

main().catch((error) => {
  console.error('[run-e-batch] 工具错误（blocked）：' + (error instanceof Error ? error.message : String(error)))
  if (error instanceof Error && error.stack) console.error(error.stack)
  process.exit(2)
})
