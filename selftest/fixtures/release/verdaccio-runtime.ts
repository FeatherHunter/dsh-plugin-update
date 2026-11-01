/**
 * selftest/fixtures/release/verdaccio-runtime.ts —— 仓库外本地 Verdaccio 的生命周期。
 *
 * 为什么用 Verdaccio：夹具必须「按版本从 registry 装」（file: 安装会被 SUT 判成 source-install 而永久挡更新），
 * 而我们又绝不能发布到 npmjs。所以：共享安装目录（runtime/tools/verdaccio，只装一次）+
 * 每次 run 独立 storage/config（干净 registry，每次从 0 开始，发布同名版本不会撞 E409）。
 *
 * 生命周期：写 config → 起进程 → 探活 /-/ping → 用 → stop() 并核实端口已释放（清理证据）。
 */
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ManagedProcess } from '../../tooling/process.ts'
import { formatError, startProcess, waitFor } from '../../tooling/process.ts'
import { directoryExists, ensureDir, fileExists } from '../../tooling/fs-utils.ts'
import { findFreePort, waitForPortFree } from '../../tooling/ports.ts'

/** 本地 registry 的启动参数。 */
export interface VerdaccioOptions {
  /** verdaccio 的安装目录（runtime/tools/verdaccio，含 node_modules/verdaccio）。 */
  readonly installDir: string
  /** 本次 run 专用的目录（storage/config/htpasswd 都落这里）。 */
  readonly runDir: string
  /** 指定端口；省略则自动选空闲端口。 */
  readonly port?: number
}

/** 起好的本地 registry。 */
export interface VerdaccioHandle {
  readonly baseUrl: string
  readonly port: number
  readonly configPath: string
  readonly storageDir: string
  /** 子进程累积输出（证据 raw/ 用）。 */
  stdout(): string
  stderr(): string
  /** 停进程并核实端口释放；失败抛出带原始输出的错误。 */
  stop(): Promise<void>
}

/** 渲染 verdaccio config.yaml（最小可用面：本地 storage + htpasswd + npmjs 上游 + 全开放包权限）。 */
export function renderVerdaccioConfig(options: { storageDir: string; htpasswdFile: string }): string {
  const storage = options.storageDir.split('\\').join('/')
  const htpasswd = options.htpasswdFile.split('\\').join('/')
  return [
    '# [TEST ONLY] #265 本地 registry 配置（生成物，勿手改）',
    'storage: ' + JSON.stringify(storage),
    'auth:',
    '  htpasswd:',
    '    file: ' + JSON.stringify(htpasswd),
    '    max_users: 100',
    'uplinks:',
    '  npmjs:',
    '    url: https://registry.npmjs.org/',
    '    timeout: 60s',
    'packages:',
    // SUT 与夹具用「不吃上游」的专用规则：dsh-plugin-update 同名同版本在 npmjs 上已存在，
    // 若走 proxy 规则，verdaccio 会认为该版本已被上游占用而回 409（this package is already present），
    // 我们就永远无法把当前工作树构建钉成本地版本。夹具包名同理（避免将来与上游撞名）。
    "  'dsh-plugin-update':",
    '    access: $all',
    '    publish: $all',
    '    unpublish: $all',
    "  'dsh-plugin-update-fixture-*':",
    '    access: $all',
    '    publish: $all',
    '    unpublish: $all',
    "  '**':",
    '    access: $all',
    '    publish: $all',
    '    unpublish: $all',
    '    proxy: npmjs',
    'server:',
    '  keepAliveTimeout: 60',
    'log:',
    '  type: stdout',
    '  format: pretty',
    '  level: warn',
    '',
  ].join('\n')
}

/** 起本地 registry 并等到 /-/ping 通。 */
export async function startVerdaccio(options: VerdaccioOptions): Promise<VerdaccioHandle> {
  const port = options.port || (await findFreePort())
  const baseUrl = 'http://127.0.0.1:' + port
  const runDir = options.runDir
  const storageDir = join(runDir, 'verdaccio', 'storage')
  const configPath = join(runDir, 'verdaccio', 'config.yaml')
  const htpasswdFile = join(runDir, 'verdaccio', 'htpasswd')
  const binPath = join(options.installDir, 'node_modules', 'verdaccio', 'bin', 'verdaccio')
  if (!(await directoryExists(options.installDir)) || !(await fileExists(binPath))) {
    throw new Error(
      '[fixtures] 找不到本机 verdaccio：' + binPath +
        '\n先 bootstrap：npm install --prefix "' + options.installDir + '" verdaccio@6 --no-audit --no-fund',
    )
  }
  await ensureDir(storageDir)
  await ensureDir(join(runDir, 'verdaccio'))
  await writeFile(htpasswdFile, '')
  await writeFile(configPath, renderVerdaccioConfig({ storageDir, htpasswdFile }))
  const process_ = startProcess(process.execPath, [binPath, '--config', configPath, '--listen', '127.0.0.1:' + port], {
    cwd: runDir,
  })
  const launchSummary = 'cmd=' + process.execPath + ' ' + binPath + ' --config ' + configPath + ' --listen 127.0.0.1:' + port + ' cwd=' + runDir + ' pid=' + String(process_.pid())
  console.error('[fixtures] verdaccio 启动：' + launchSummary)
  const handle: VerdaccioHandle = {
    baseUrl,
    port,
    configPath,
    storageDir,
    stdout: () => process_.stdout(),
    stderr: () => process_.stderr(),
    stop: async () => {
      try {
        await process_.stop()
      } catch (error) {
        throw new Error(
          '[fixtures] 停止 verdaccio 失败：' + formatError(error) +
            '\nstdout：' + process_.stdout() + '\nstderr：' + process_.stderr(),
        )
      }
      const released = await waitForPortFree(port, 15000)
      if (!released) throw new Error('[fixtures] verdaccio 停止后端口仍在监听：' + port)
    },
  }
  try {
    await waitFor('verdaccio /-/ping', async () => {
      const earlyExit = process_.exitCode()
      if (earlyExit !== null) {
        throw new Error('[fixtures] verdaccio 提前退出：exit=' + String(earlyExit) + ' ' + launchSummary + ' stdout=' + process_.stdout() + ' stderr=' + process_.stderr())
      }
      try {
        const response = await fetch(baseUrl + '/-/ping')
        return response.ok ? true : null
      } catch (error) {
        return null
      }
    }, { timeoutMs: 60000, intervalMs: 300 })
  } catch (error) {
    throw new Error(
      '[fixtures] verdaccio 探活失败：' + formatError(error) +
        '\n' + launchSummary + ' exit=' + String(process_.exitCode()) +
        '\nstdout：' + process_.stdout() + '\nstderr：' + process_.stderr(),
    )
  }
  return handle
}

/** 清理本地 registry 运行目录（run 结束后可留证，不强制删）。 */
export async function removeVerdaccioRunDir(runDir: string): Promise<void> {
  await rm(join(runDir, 'verdaccio'), { recursive: true, force: true })
}