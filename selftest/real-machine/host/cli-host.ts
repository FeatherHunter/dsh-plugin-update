/**
 * selftest/real-machine/host/cli-host.ts —— 通道 B：普通 DSH 宿主（spawn CLI，出口三）驱动。
 *
 * 与官方桌面（通道 A，CDP）不同，这里起的是一个真正的 dsh web 宿主进程：更新动作由
 * 宿主 spawn 载体 CLI 子进程执行（src/core/executor.ts 的 runCliProcess），路由判据是
 * environment.ts:109-129 的 cli 分支（profile 名不能是 desktop）。
 *
 * 隔离硬约束（T3 探针实测，见 docs/research/20261101-issue-267-three-install-exits.md）：
 *   - 产品执行席 spawn CLI 子进程走 @deepseek-ai/dsh-subprocess 的 scrubbedParentEnv，
 *     所有 DSH_* 环境变量被剥掉，子进程按 homedir()/.dsh 解析 home；
 *   - 所以宿主 homeDir 必须正好等于 USERPROFILE/.dsh（本文件把 USERPROFILE 指到 run 内
 *     假用户目录），否则安装会落到默认 home、verify version-mismatch；
 *   - 父进程的 DSH_PROFILE / DSH_PROFILE_DIR / DSH_SESSION_ID / DSH_WEB_URL 必须清掉。
 */
import { join } from 'node:path'
import type { ManagedProcess } from '../../tooling/process.ts'
import { startProcess, waitFor } from '../../tooling/process.ts'
import { waitForPortFree } from '../../tooling/ports.ts'
import { ensureDir } from '../../tooling/fs-utils.ts'
import { DSH_PATHS, dshCliEnv } from './dsh-cli.ts'

/** 起一个通道 B 宿主进程的入参。 */
export interface CliHostOptions {
  /** 宿主 DSH_HOME（必须等于 osHomeDir/.dsh，见文件头隔离约束）。 */
  readonly homeDir: string
  /** 本次 run 的假用户目录（USERPROFILE；子进程默认 home = 它/.dsh）。 */
  readonly osHomeDir: string
  /** 普通 DSH 宿主的使用范围名；不能是 desktop（那会落到出口二）。 */
  readonly profileName: string
  /** 额外环境变量（DSH_SELFTEST_REGISTRY / DSH_SELFTEST_INSTALL_TIMEOUT_MS / pnpm store 等）。 */
  readonly extraEnv?: Record<string, string | undefined>
  readonly bootTimeoutMs?: number
}

/** 一次宿主电话回包。 */
export interface CliHostPhoneReply {
  readonly status: number
  readonly body: any
  readonly durationMs: number
}

/** 一个已就绪的通道 B 宿主。 */
export interface CliHostSession {
  readonly profileName: string
  readonly url: string
  readonly port: number
  readonly token: string | null
  readonly bootMs: number
  readonly proc: ManagedProcess
  stdout(): string
  stderr(): string
  pid(): number | undefined
  /** 走夹具 host half 的 HTTP 桥发一条电话（body: {phone,args}）。 */
  postPhone(route: string, phone: string, args?: Record<string, unknown>): Promise<CliHostPhoneReply>
  /** 停宿主并等端口释放（close 可重复调用）。 */
  close(): Promise<void>
}

/** 从宿主 stdout 里认 web 地址（dsh web: http://127.0.0.1:<port>/?token=...）。 */
const HOST_URL_PATTERN = /dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/

/** 起通道 B 宿主：等 URL → 等 HTTP 探活 → 返回可发电话的会话。 */
export async function startCliHost(options: CliHostOptions): Promise<CliHostSession> {
  await ensureDir(options.osHomeDir)
  await ensureDir(options.homeDir)
  const env = dshCliEnv({ homeDir: options.homeDir, extraEnv: options.extraEnv })
  // 产品子进程按 homedir()/.dsh 解析 home（DSH_* 被剥离）：把 USERPROFILE 指到 run 内假用户目录，
  // 并令 homeDir = osHomeDir/.dsh，宿主与 CLI 子进程就落在同一个隔离 home 上。
  env['USERPROFILE'] = options.osHomeDir
  delete env['DSH_PROFILE']
  delete env['DSH_PROFILE_DIR']
  delete env['DSH_SESSION_ID']
  delete env['DSH_WEB_URL']
  const startedAt = Date.now()
  const proc = startProcess(
    DSH_PATHS.exePath,
    ['--expose-internals', DSH_PATHS.cliJsPath, '--profile', options.profileName, '--port', '0', '--no-open'],
    { cwd: options.homeDir, env },
  )
  const url = await waitFor(
    '通道 B 宿主 web 地址',
    () => {
      const match = HOST_URL_PATTERN.exec(proc.stdout())
      return match ? match[1] : null
    },
    { timeoutMs: options.bootTimeoutMs || 120000, intervalMs: 250 },
  )
  const parsed = new URL(url)
  const port = Number(parsed.port)
  const token = parsed.searchParams.get('token')
  await waitFor(
    '通道 B 宿主 HTTP 探活',
    async () => {
      try {
        const response = await fetch(url, { redirect: 'manual' })
        return response.status < 400
      } catch (error) {
        return false
      }
    },
    { timeoutMs: 60000, intervalMs: 250 },
  )
  let closed = false
  return {
    profileName: options.profileName,
    url,
    port,
    token,
    bootMs: Date.now() - startedAt,
    proc,
    stdout: () => proc.stdout(),
    stderr: () => proc.stderr(),
    pid: () => proc.pid(),
    postPhone: async (route, phone, args = {}) => {
      const suffix = token ? '?token=' + encodeURIComponent(token) : ''
      const phoneStartedAt = Date.now()
      const response = await fetch('http://127.0.0.1:' + String(port) + route + suffix, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, args }),
      })
      const text = await response.text()
      let body: any = null
      try {
        body = text.length > 0 ? JSON.parse(text) : null
      } catch (error) {
        body = { rawText: text }
      }
      return { status: response.status, body, durationMs: Date.now() - phoneStartedAt }
    },
    close: async () => {
      if (closed) return
      closed = true
      proc.stop()
      await proc.waitForExit(15000)
      await waitForPortFree(port, 20000)
    },
  }
}
