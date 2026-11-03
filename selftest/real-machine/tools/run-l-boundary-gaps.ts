/**
 * selftest/real-machine/tools/run-l-boundary-gaps.ts —— 票 #284 B 组（组 L：用户可感知边界缺口）命令行入口。
 *
 * 用法（PowerShell，工作树是 D:/dsh-plugin/_wt263/t13）：
 *   node selftest/real-machine/tools/run-l-boundary-gaps.ts --mode l2 --run-base-dir D:/dsh-plugin/_wt263/runtime/t13-284
 *   --mode l1 | l2 | l3 | l4 | l5 | can-red
 * 可选：--worktree <路径> --verdaccio-install-dir <路径> --esbuild <esbuild.exe> --stamp <YYYYMMDDTHHMMSS>
 *       --maintainer-home <维护者 DSH_HOME> --no-evidence-sync（试错 run：不把证据复制进仓库）
 *
 * 退出码：0=全部 pass（known-red 不影响出口）；1=有 fail/unknown；2=blocked / 工具错误。
 */
import { join } from 'node:path'

import { runLBoundaryScenario } from '../scenarios/l-boundary-gaps.ts'
import type { LBoundaryMode } from '../scenarios/l-boundary-gaps.ts'

interface CliOptions {
  worktree: string
  runBaseDir: string
  verdaccioInstallDir: string
  esbuildPath: string
  stamp?: string
  maintainerHome?: string
  mode: LBoundaryMode
  syncEvidence: boolean
}

function parseMode(value: string | undefined): LBoundaryMode {
  if (value === 'l1' || value === 'l2' || value === 'l3' || value === 'l4' || value === 'l5' || value === 'can-red') return value
  throw new Error('必须传 --mode l1|l2|l3|l4|l5|can-red')
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
  if (!runBaseDir) throw new Error('必须传 --run-base-dir（真机临时目录根，例如 D:/dsh-plugin/_wt263/runtime/t13-284）')
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
  const manifest = await runLBoundaryScenario(options)
  console.log(JSON.stringify({ runDir: join(options.runBaseDir, manifest.runId), verdict: manifest.verdict, exitCode: manifest.exitCode, assertions: manifest.assertions.length, shots: manifest.shots.length }, null, 2))
  process.exit(manifest.exitCode)
}

main().catch((error) => {
  console.error('[run-l-boundary-gaps] 工具错误（blocked）：' + (error instanceof Error ? error.message : String(error)))
  if (error instanceof Error && error.stack) console.error(error.stack)
  process.exit(2)
})
