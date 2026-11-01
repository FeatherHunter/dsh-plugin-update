/**
 * selftest/real-machine/runtime/environment-facts.ts —— run.json 的环境事实（node/平台/工作树/分支/HEAD）。
 *
 * 证据六元组里的「环境 + 版本」由这里提供：分支与 HEAD 必须来自真实 git 命令，不手抄。
 */
import type { RunEnvironmentFacts } from './evidence.ts'
import { runCommand } from '../../tooling/process.ts'

/** 读一条 git 事实（失败返回 'unknown'，不打断 run）。 */
function git(worktree: string, args: readonly string[]): string {
  const result = runCommand('git', ['-C', worktree, ...args], { timeoutMs: 30000 })
  if (result.exitCode !== 0) return 'unknown'
  return result.stdout.trim()
}

/** 收集环境事实（hostChannel 由场景决定：desktop-official / dsh-web）。 */
export function collectEnvironmentFacts(worktree: string, hostChannel: string): RunEnvironmentFacts {
  return {
    node: process.version,
    platform: process.platform,
    worktree,
    branch: git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']),
    head: git(worktree, ['rev-parse', 'HEAD']),
    hostChannel,
  }
}
