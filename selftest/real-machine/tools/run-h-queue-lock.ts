/**
 * selftest/real-machine/tools/run-h-queue-lock.ts —— 票 #270（spec #263 T6 / F 组：队列与锁）的 run 工具。
 *
 * 用法：
 *   node selftest/real-machine/tools/run-h-queue-lock.ts --mode concurrent-lock-window --run-base-dir D:/dsh-plugin/_wt263/runtime/t6-270
 *   node selftest/real-machine/tools/run-h-queue-lock.ts --mode concurrent-simultaneous --run-base-dir ...
 *   node selftest/real-machine/tools/run-h-queue-lock.ts --mode stale-reclaim --run-base-dir ...
 *   node selftest/real-machine/tools/run-h-queue-lock.ts --mode can-red --run-base-dir ...
 *
 * --mode 必传（四个值见 QueueLockMode）。--run-base-dir 必传（真机临时目录根，仓库外）。
 * 试错 run 加 --no-evidence-sync：证据只留仓库外，不复制进 selftest/evidence/runs（定稿 run 不要加）。
 *
 * 退出码：0 = 全部 pass（known-red 不改变出口）；1 = fail 或 unknown；2 = blocked（工具错误）。
 */
import { join } from 'node:path'
import type { QueueLockMode } from '../scenarios/h-queue-lock.ts'
import { runQueueLock } from '../scenarios/h-queue-lock.ts'

interface CliOptions {
  readonly worktree: string
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  readonly maintainerHome?: string
  readonly mode: QueueLockMode
  readonly syncEvidence: boolean
}

const MODES: readonly QueueLockMode[] = ['concurrent-simultaneous', 'concurrent-lock-window', 'stale-reclaim', 'can-red']

function parseMode(value: string | undefined): QueueLockMode {
  if (value === undefined) throw new Error('必须传 --mode（' + MODES.join(' / ') + '）')
  if (MODES.indexOf(value as QueueLockMode) < 0) throw new Error('未知 --mode：' + JSON.stringify(value) + '（允许 ' + MODES.join(' / ') + '）')
  return value as QueueLockMode
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) throw new Error('无法解析参数：' + JSON.stringify(item))
    if (item === '--no-evidence-sync') {
      values.set('no-evidence-sync', 'true')
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      values.set(item.slice(2), next)
      index += 1
    } else {
      values.set(item.slice(2), '')
    }
  }
  const worktree = values.get('worktree') || process.cwd()
  const runBaseDir = values.get('run-base-dir')
  if (runBaseDir === undefined || runBaseDir === '') {
    throw new Error('必须传 --run-base-dir（真机临时目录根，例如 D:/dsh-plugin/_wt263/runtime/t6-270）')
  }
  return {
    worktree,
    runBaseDir,
    verdaccioInstallDir: values.get('verdaccio-install-dir') || 'D:/dsh-plugin/_wt263/runtime/tools/verdaccio',
    esbuildPath: values.get('esbuild') || join(worktree, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    stamp: values.get('stamp') || undefined,
    maintainerHome: values.get('maintainer-home') || undefined,
    mode: parseMode(values.get('mode')),
    syncEvidence: !values.has('no-evidence-sync'),
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const manifest = await runQueueLock(options)
  console.log(
    JSON.stringify(
      { runDir: join(options.runBaseDir, manifest.runId), verdict: manifest.verdict, exitCode: manifest.exitCode },
      null,
      2,
    ),
  )
  process.exit(manifest.exitCode)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error('[run-h-queue-lock] 工具错误（blocked）：' + message)
  console.error(error instanceof Error ? error.stack ?? '' : '')
  process.exit(2)
})
