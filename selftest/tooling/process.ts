/**
 * selftest/tooling/process.ts —— 工具层共用的进程/等待原语（零依赖，只用 Node 内建）。
 *
 * 为什么单独一层：夹具发布器（release/）与真机 harness（real-machine/）都要起进程、等条件、杀进程树。
 * 这些原语与「测什么」无关，只与操作系统打交道；放在这里避免两份口径各自漂移。
 */
import { spawn, spawnSync } from 'node:child_process'

/** 一次已结束命令的完整记录（证据 raw/ 直接落这个对象）。 */
export interface CommandResult {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

/** 跑命令统一入参。 */
export interface RunCommandOptions {
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  /** 子进程被杀的超时（spawnSync 的 timeout 语义）。 */
  readonly timeoutMs?: number
}

/** 等待（测试里所有轮询的基石；不引第三方 sleep 库）。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 把一段命令行渲染成可复制的文本（证据里给人照着复跑）。 */
export function commandLine(command: string, args: readonly string[]): string {
  const parts = [command, ...args].map((part) => (/[\s"]/.test(part) ? '"' + part.replace(/"/g, '\\"') + '"' : part))
  return parts.join(' ')
}

/** 把 catch 到的东西转成可读文本（Error.message 或 JSON；证据里要原始信息，不吞）。 */
export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 跑一条命令并收完整输出；不抛（调用方按 exitCode 自己判）。 */
export function runCommand(command: string, args: readonly string[], options: RunCommandOptions = {}): CommandResult {
  const cwd = options.cwd || process.cwd()
  const startedAt = Date.now()
  const result = spawnSync(command, args, {
    cwd,
    env: options.env || process.env,
    windowsHide: true,
    stdio: 'pipe',
    timeout: options.timeoutMs,
  })
  const durationMs = Date.now() - startedAt
  if (result.error) {
    return {
      command,
      args,
      cwd,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: String(result.error.message),
      durationMs,
    }
  }
  return {
    command,
    args,
    cwd,
    exitCode: result.status,
    signal: result.signal,
    stdout: String(result.stdout == null ? '' : result.stdout),
    stderr: String(result.stderr == null ? '' : result.stderr),
    durationMs,
  }
}

/** 一个仍在跑的、被本进程托管的子进程。 */
export interface ManagedProcess {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  pid(): number | undefined
  stdout(): string
  stderr(): string
  exitCode(): number | null
  waitForExit(timeoutMs: number): Promise<number | null>
  stop(): Promise<void>
}

/** 起一个长跑进程；stdout/stderr 累积在内存里（证据按需取）。 */
export function startProcess(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): ManagedProcess {
  const cwd = options.cwd || process.cwd()
  const child = spawn(command, args, {
    cwd,
    env: options.env || process.env,
    windowsHide: true,
    stdio: 'pipe',
  })
  let stdoutText = ''
  let stderrText = ''
  let exitCode: number | null = null
  let exited = false
  if (child.stdout) child.stdout.on('data', (chunk: Uint8Array) => { stdoutText += String(chunk) })
  if (child.stderr) child.stderr.on('data', (chunk: Uint8Array) => { stderrText += String(chunk) })
  child.on('exit', (code: number | null) => {
    exited = true
    exitCode = code
  })
  child.on('error', (error: Error) => {
    exited = true
    stderrText += String(error.message)
  })
  const handle: ManagedProcess = {
    command,
    args,
    cwd,
    pid: () => child.pid,
    stdout: () => stdoutText,
    stderr: () => stderrText,
    exitCode: () => exitCode,
    waitForExit: async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs
      while (!exited) {
        if (Date.now() > deadline) throw new Error('[tooling] 等待进程退出超时：' + commandLine(command, args))
        await sleep(120)
      }
      return exitCode
    },
    stop: async () => {
      if (exited) return
      const pid = child.pid
      if (typeof pid === 'number') killProcessTree(pid)
      try {
        child.kill()
      } catch (error) {
        // 已退出/权限不足都不影响清理判定：waitForExit 会给最终答案。
      }
      try {
        await handle.waitForExit(15000)
      } catch (error) {
        throw new Error('[tooling] 进程无法停止：' + commandLine(command, args) + '；' + String(error))
      }
    },
  }
  return handle
}

/**
 * 按 PID 杀整棵树。Windows 用 taskkill /PID <pid> /T /F（只杀自己起的 PID 子树，绝不按镜像名批量杀）；
 * 其它平台 kill(-pid)。
 */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    runCommand('taskkill', ['/PID', String(pid), '/T', '/F'])
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (inner) {
      // 已退出
    }
  }
}

/** 进程还活着吗（零号信号探测，不真杀）。 */
export function isProcessAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0)
  } catch (error) {
    return false
  }
}

/** 轮询等待一个条件成立；超时抛错（错误里带 label 与最后一次观测值）。 */
export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined> | T | null | undefined,
  options: { timeoutMs: number; intervalMs?: number },
): Promise<T> {
  const intervalMs = options.intervalMs || 250
  const deadline = Date.now() + options.timeoutMs
  let lastObservation: string = '（未观测）'
  while (true) {
    const value = await probe()
    if (value !== null && value !== undefined && value !== false) return value as T
    lastObservation = JSON.stringify(value === undefined ? null : value)
    if (Date.now() > deadline) {
      throw new Error('[tooling] 等待超时（' + options.timeoutMs + 'ms）：' + label + '；最后观测=' + lastObservation)
    }
    await sleep(intervalMs)
  }
}
