/**
 * selftest/fixtures/release/local-registry.ts —— 本次 run 的本地 registry 一键起：进程 + 建号 + npmrc。
 *
 * 这是发布器对外的唯一入口（真机 harness 只认它）；内部细节留在 verdaccio-runtime / registry-client。
 */
import { join } from 'node:path'
import type { VerdaccioHandle } from './verdaccio-runtime.ts'
import { startVerdaccio } from './verdaccio-runtime.ts'
import type { RegistryAccount } from './registry-client.ts'
import { createRegistryUser, writeNpmrc } from './registry-client.ts'
import { ensureDir } from '../../tooling/fs-utils.ts'

/** 起本地 registry 的入参。 */
export interface LocalRegistryOptions {
  /** verdaccio 共享安装目录（runtime/tools/verdaccio）。 */
  readonly installDir: string
  /** 本次 run 目录（storage/config/npmrc/日志都落这里）。 */
  readonly runDir: string
  readonly user?: string
  readonly password?: string
  readonly email?: string
  /** 不吃 npmjs 上游的本地包（缺省 = SUT 与夹具；npmjs 镜像的依赖包需追加）。 */
  readonly localOnlyPackages?: readonly string[]
}

/** 起好的本地 registry（可直接用于发布与安装）。 */
export interface LocalRegistry {
  readonly baseUrl: string
  readonly port: number
  readonly account: RegistryAccount
  readonly npmrcPath: string
  readonly verdaccio: VerdaccioHandle
  /** 子进程输出（证据 raw/ 用）。 */
  stdout(): string
  stderr(): string
  stop(): Promise<void>
}

/** 起 verdaccio → 建号 → 写 npmrc；任何一步失败都先把已起进程停掉再抛。 */
export async function startLocalRegistry(options: LocalRegistryOptions): Promise<LocalRegistry> {
  const user = options.user || 'fixture-publisher'
  const password = options.password || 'fixture-publisher-password'
  const email = options.email || 'fixture-publisher@selftest.invalid'
  const verdaccio = await startVerdaccio({
    installDir: options.installDir,
    runDir: options.runDir,
    localOnlyPackages: options.localOnlyPackages,
  })
  let account: RegistryAccount | null = null
  try {
    account = await createRegistryUser({ baseUrl: verdaccio.baseUrl, user, password, email })
    await ensureDir(join(options.runDir, 'registry'))
    const npmrcPath = await writeNpmrc({
      dir: join(options.runDir, 'registry'),
      registryUrl: verdaccio.baseUrl,
      token: account.token,
    })
    const startedAccount = account
    return {
      baseUrl: verdaccio.baseUrl,
      port: verdaccio.port,
      account: startedAccount,
      npmrcPath,
      verdaccio,
      stdout: () => verdaccio.stdout(),
      stderr: () => verdaccio.stderr(),
      stop: async () => {
        await verdaccio.stop()
      },
    }
  } catch (error) {
    try {
      await verdaccio.stop()
    } catch (inner) {
      // 停不掉也要把最初错误抛出去（清理错误只是附带信息）。
    }
    throw error
  }
}
