/**
 * selftest/real-machine/base-verify/capability.ts —— capability 门：先证明「这是真包」，再跑任何命令。
 *
 * 为什么必须先过这一道：npm 上存在同名无关包 dsh-verify@0.9.6，裸 npx 可能解析到它；
 * 只认 --version 的第二行 `capability real-machine-verification (schema 1)`，不匹配一律 blocked。
 * 这一道判错只会浪费一次真机 run，判漏则会把别的包的报告当成本仓证据。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from '../../tooling/process.ts'
import { commandLine, formatError } from '../../tooling/process.ts'
import type { BaseBlockedReason } from './types.ts'

/** base 包名（devDependency 精确固定版本）。 */
export const BASE_PACKAGE_NAME = 'dsh-featherhunter-plugin-base'

/** capability 行必须逐字一致：它是「真包」的唯一判据。 */
export const EXPECTED_CAPABILITY_LINE = 'capability real-machine-verification (schema 1)'

/** 本仓根目录：从本文件位置反查，不依赖调用方 cwd。 */
export function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
}

/** base 真机 CLI 的入口（bin dsh-verify 指向的文件）。 */
export function baseCliPath(repoRoot: string = repositoryRoot()): string {
  return join(repoRoot, 'node_modules', BASE_PACKAGE_NAME, 'dist', 'real-machine-verification', 'cli', 'main.js')
}

/** capability 门的观测结果。 */
export interface BaseCapability {
  readonly cliPath: string
  readonly version: string
  readonly capabilityLine: string
  readonly output: string
  readonly commandLine: string
}

export type BaseCapabilityResult =
  | { readonly ok: true; readonly value: BaseCapability }
  | { readonly ok: false; readonly blockedReason: BaseBlockedReason }

function blocked(message: string, hint?: string): BaseCapabilityResult {
  return { ok: false, blockedReason: { code: 'prerequisite-missing', message, ...(hint ? { hint } : {}) } }
}

/**
 * 跑 `node <base>/dist/real-machine-verification/cli/main.js --version` 并校验 capability 行。
 * 不用 shell、不裸 npx；进程用当前 node（process.execPath）起，保证与 tsc/测试同一运行时。
 */
export function checkBaseCapability(options: { repoRoot?: string; timeoutMs?: number } = {}): BaseCapabilityResult {
  const cliPath = baseCliPath(options.repoRoot)
  if (!existsSync(cliPath)) {
    return blocked(
      '找不到 base 的验证 CLI：' + cliPath,
      '先在本仓执行 npm ci（devDependency ' + BASE_PACKAGE_NAME + ' 已固定版本，不是全局安装）',
    )
  }
  const args = [cliPath, '--version']
  const rendered = commandLine(process.execPath, args)
  let result
  try {
    result = runCommand(process.execPath, args, { timeoutMs: options.timeoutMs ?? 20000 })
  } catch (error) {
    return blocked('无法执行 capability 探测：' + formatError(error))
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (result.exitCode !== 0) {
    return blocked(
      'capability 探测失败（exit=' + String(result.exitCode) + '）：' + rendered,
      'stderr=' + result.stderr.trim().slice(0, 500),
    )
  }
  const version = lines[0] || ''
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    return blocked('--version 第一行不是版本号：' + JSON.stringify(version), '完整输出=' + JSON.stringify(result.stdout))
  }
  if (lines[1] !== EXPECTED_CAPABILITY_LINE) {
    return blocked(
      'capability 行不匹配：期望 ' + JSON.stringify(EXPECTED_CAPABILITY_LINE) + '，实际 ' + JSON.stringify(lines[1] || ''),
      '这不是 ' + BASE_PACKAGE_NAME + ' 的真机验证 CLI（注意 npm 上的无关同名包 dsh-verify）；' + rendered,
    )
  }
  return {
    ok: true,
    value: { cliPath, version, capabilityLine: lines[1], output: result.stdout, commandLine: rendered },
  }
}
