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
import { startProcess, formatError } from '../../tooling/process.ts'
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
