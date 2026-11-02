/**
 * selftest/real-machine/tools/run-e-cli-host.ts —— 出口三（普通 DSH 宿主 spawn CLI）命令行入口。
 *
 * 用法（PowerShell）：
 *   node selftest/real-machine/tools/run-e-cli-host.ts --mode success --run-base-dir D:/dsh-plugin/_wt263/runtime/t3-267
 *   node selftest/real-machine/tools/run-e-cli-host.ts --mode failure --run-base-dir ...
 *   node selftest/real-machine/tools/run-e-cli-host.ts --mode timeout --run-base-dir ...
 *   node selftest/real-machine/tools/run-e-cli-host.ts --mode can-red --run-base-dir ...（stale-variant，预期 exit 1）
 * 可选：--worktree <路径> --verdaccio-install-dir <路径> --esbuild <esbuild.exe> --stamp <YYYYMMDDTHHMMSS> --maintainer-home <维护者 DSH_HOME>
 *
 * 退出码：0=全部 pass（known-red 不影响出口）；1=有 fail/unknown；2=blocked / 工具错误。
 */
import { join } from 'node:path'
import { runCliHostExits } from '../scenarios/e-cli-host-exits.ts'
import type { CliHostExitMode } from '../scenarios/e-cli-host-exits.ts'

interface CliOptions {
  worktree: string
  runBaseDir: string
  verdaccioInstallDir: string
  esbuildPath: string
  stamp?: string
  maintainerHome?: string
  mode: CliHostExitMode
}

function parseMode(value: string | undefined): CliHostExitMode {
  if (value === 'success' || value === 'failure' || value === 'timeout' || value === 'can-red') return value
  throw new Error('必须传 --mode success|failure|timeout|can-red')
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
  if (!runBaseDir) throw new Error('必须传 --run-base-dir（真机临时目录根，例如 D:/dsh-plugin/_wt263/runtime/t3-267）')
  return {
    worktree,
    runBaseDir,
    verdaccioInstallDir: values.get('verdaccio-install-dir') || 'D:/dsh-plugin/_wt263/runtime/tools/verdaccio',
    esbuildPath: values.get('esbuild') || join(worktree, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    stamp: values.get('stamp'),
    maintainerHome: values.get('maintainer-home'),
    mode: parseMode(values.get('mode')),
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const manifest = await runCliHostExits(options)
  console.log(JSON.stringify({ runDir: join(options.runBaseDir, manifest.runId), verdict: manifest.verdict, exitCode: manifest.exitCode }, null, 2))
  process.exit(manifest.exitCode)
}

main().catch((error) => {
  console.error('[run-e-cli-host] 工具错误（blocked）：' + (error instanceof Error ? error.message : String(error)))
  if (error instanceof Error && error.stack) console.error(error.stack)
  process.exit(2)
})
