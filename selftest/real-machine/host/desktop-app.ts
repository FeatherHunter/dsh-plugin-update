/**
 * selftest/real-machine/host/desktop-app.ts —— 官方桌面通道（通道 A）：隔离启动 + CDP 接入 + 收尾。
 *
 * 通道 A 的两个硬坑（T0 宿主矩阵实测）：
 *   1. 宿主进程环境里有 ELECTRON_RUN_AS_NODE=1，不清掉 Electron 会退化成 Node CLI 解析参数并 exit 9；
 *   2. 必须同时给 --user-data-dir（Electron 用户数据）与 DSH_HOME（DSH 的 home/profiles），否则不是隔离实例。
 * 启动后从 /json/list 拿页面目标（URL 形如 dsh-app://app/），再连 CDP。
 */
import { join } from 'node:path'
import type { ManagedProcess } from '../../tooling/process.ts'
import { killProcessTree, runCommand, startProcess, formatError } from '../../tooling/process.ts'
import { findFreePort, waitForPortFree } from '../../tooling/ports.ts'
import { ensureDir } from '../../tooling/fs-utils.ts'
import type { CdpClient, CdpTarget } from '../cdp/cdp-client.ts'
import { CdpClient as CdpClientClass, waitForPageTarget } from '../cdp/cdp-client.ts'
import { DSH_PATHS } from './dsh-cli.ts'

/** 桌面实例启动入参。 */
export interface DesktopLaunchOptions {
  readonly homeDir: string
  readonly userDataDir: string
  readonly remoteDebuggingPort?: number
  /** 额外命令行参数（例如 --no-sandbox；一般不需要）。 */
  readonly extraArgs?: readonly string[]
  /** 额外环境变量；夹具宿主半靠 DSH_SELFTEST_REGISTRY 拿到本地 registry（与注入的 --registry 同一地址）。 */
  readonly extraEnv?: Record<string, string | undefined>
  readonly timeoutMs?: number
}

/** 起好的隔离桌面实例。 */
export interface DesktopSession {
  readonly port: number
  readonly process: ManagedProcess
  readonly cdp: CdpClient
  readonly targets: readonly CdpTarget[]
  /** 子进程输出（证据 raw/ 用）。 */
  stdout(): string
  stderr(): string
  /** 关 CDP → 杀进程树 → 核实调试端口释放。 */
  close(): Promise<void>
}

/** 从维护者环境继承但必须清掉的变量（Electron 模式开关）。 */
export function desktopLaunchEnv(homeDir: string, extraEnv: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  env['DSH_HOME'] = homeDir
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

/** 某调试端口上正在监听的 PID（Windows netstat -ano；用于清理桌面管理器自动重启出来的实例）。 */
export function listeningPidsOfPort(port: number): number[] {
  if (process.platform !== 'win32') return []
  const result = runCommand('netstat', ['-ano', '-p', 'TCP'])
  const pids: number[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.indexOf('LISTENING') < 0) continue
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5) continue
    const local = parts[1] || ''
    if (!local.endsWith(':' + port)) continue
    const pid = Number(parts[4])
    if (Number.isFinite(pid) && pid > 0 && pids.indexOf(pid) < 0) pids.push(pid)
  }
  return pids
}

/**
 * 批量安装时官方桌面会自行重启（desktop-manager 装完插件后 relaunch，复用同一调试端口），
 * 旧的 ManagedProcess 句柄会失效、新实例也不再被它托管。按调试端口找出新实例并杀整棵树，
 * 再正常 launchDesktopApp 起一个被托管的新实例——只杀我们自己隔离实例占用的端口。
 */
export async function stopDesktopByPort(port: number): Promise<number[]> {
  const pids = listeningPidsOfPort(port)
  for (const pid of pids) killProcessTree(pid)
  if (pids.length > 0) {
    const released = await waitForPortFree(port, 30000)
    if (!released) throw new Error('[desktop] 按调试端口停止桌面实例后端口仍在监听：' + port)
  }
  return pids
}

/** 把一段 PowerShell 脚本以 -EncodedCommand 方式执行（避免 Windows 命令行引号转义问题）。 */
function runPowerShell(script: string, timeoutMs: number): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const result = runCommand('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeoutMs })
  return result.stdout
}

/**
 * 按隔离实例的 --user-data-dir 找「DeepSeek Harness.exe」进程并杀整棵树。
 * 为什么需要它：desktop-manager 装完插件后会 relaunch 官方桌面；新实例可能换调试端口（或旧实例已退出），
 * 只按调试端口找会漏。user-data-dir 是本 run 独有的路径（D:\dsh-plugin\_wt263\runtime\...），不会误伤别的实例。
 */
export async function stopDesktopByUserDataDir(userDataDir: string): Promise<number[]> {
  if (process.platform !== 'win32') return []
  const pattern = userDataDir.replace(/'/g, "''")
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" |" +
      " Where-Object { $_.CommandLine -like '*" + pattern + "*' } |" +
      ' ForEach-Object { $_.ProcessId }',
  ].join('\n')
  const stdout = runPowerShell(script, 30000)
  const pids: number[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const pid = Number(line.trim())
    if (Number.isFinite(pid) && pid > 0 && pids.indexOf(pid) < 0) pids.push(pid)
  }
  for (const pid of pids) killProcessTree(pid)
  if (pids.length > 0) await new Promise<void>((resolve) => setTimeout(() => resolve(), 1000))
  return pids
}

/** 起官方桌面（隔离 home + 独立 user-data-dir + 调试端口），等页面目标并连 CDP。 */
export async function launchDesktopApp(options: DesktopLaunchOptions): Promise<DesktopSession> {
  await ensureDir(options.homeDir)
  await ensureDir(options.userDataDir)
  const port = options.remoteDebuggingPort || (await findFreePort())
  const args = ['--user-data-dir=' + options.userDataDir, '--remote-debugging-port=' + port, ...(options.extraArgs || [])]
  const child = startProcess(DSH_PATHS.exePath, args, {
    cwd: join(options.userDataDir, '..'),
    env: desktopLaunchEnv(options.homeDir, options.extraEnv || {}),
  })
  let cdp: CdpClient | null = null
  try {
    const target = await waitForPageTarget(port, { timeoutMs: options.timeoutMs || 180000, urlIncludes: 'dsh-app://' })
    cdp = await CdpClientClass.connect(target.webSocketDebuggerUrl as string, { timeoutMs: 30000 })
    await cdp.enableEventCollection()
    // Page 域必须先开：官方桌面首启不 enable 时 Page.captureScreenshot 不回包（实测 60s 超时）。
    await cdp.send('Page.enable', {}, { timeoutMs: 30000 })
    const targets = await (async () => {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list')
      return (await response.json()) as CdpTarget[]
    })()
    const session: DesktopSession = {
      port,
      process: child,
      cdp,
      targets,
      stdout: () => child.stdout(),
      stderr: () => child.stderr(),
      close: async () => {
        cdp!.close()
        try {
          await child.stop()
        } catch (error) {
          throw new Error('[desktop] 停止桌面实例失败：' + formatError(error) + '\nstdout：' + child.stdout() + '\nstderr：' + child.stderr())
        }
        const released = await waitForPortFree(port, 20000)
        if (!released) throw new Error('[desktop] 桌面实例停止后调试端口仍在监听：' + port)
      },
    }
    return session
  } catch (error) {
    cdp?.close()
    try {
      await child.stop()
    } catch (inner) {
      // 清理失败只作为附带信息
    }
    throw new Error(
      '[desktop] 启动官方桌面失败：' + formatError(error) +
        '\n命令：' + DSH_PATHS.exePath + ' ' + args.join(' ') +
        '\nstdout：' + child.stdout() + '\nstderr：' + child.stderr(),
    )
  }
}
