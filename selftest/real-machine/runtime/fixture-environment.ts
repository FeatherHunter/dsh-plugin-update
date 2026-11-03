/**
 * selftest/real-machine/runtime/fixture-environment.ts —— 一次真机 run 的「可装夹具环境」。
 *
 * 组成（全部落 run 目录，互不污染）：
 *   - 本地 verdaccio（仓库外共享安装，本 run 独立 storage）+ 建号 + npmrc；
 *   - SUT 钉版：工作树 npm pack 成 tarball，以工作树版本号发布到本地 registry（真机测的是当前构建）；
 *   - 夹具发布：按需发布任意席位/版本（A 0.0.1 / A 0.0.2 …）。
 * 场景只跟本对象打交道；registry/SUT/发布三段细节各自封装在上层模块。
 */
import { join } from 'node:path'
import type { RunLayout } from './run-layout.ts'
import type { FixtureSlotKey, FixtureSutDependency, FixtureVariantEffect } from '../../fixtures/identity/fixture-slots.ts'
import type { LocalRegistry } from '../../fixtures/release/local-registry.ts'
import { startLocalRegistry } from '../../fixtures/release/local-registry.ts'
import type { SutPin } from '../../fixtures/release/sut-pin.ts'
import { pinSutForRegistry } from '../../fixtures/release/sut-pin.ts'
import type { PublishedFixture } from '../../fixtures/release/fixture-publisher.ts'
import { publishFixtureVersion } from '../../fixtures/release/fixture-publisher.ts'
import type { NpmjsMirrorFacts, NpmjsMirrorPlan } from '../../fixtures/release/npmjs-mirror.ts'
import { defaultMirrorCacheDir, publishNpmjsMirror, resolveNpmjsMirror } from '../../fixtures/release/npmjs-mirror.ts'
import { DEFAULT_LOCAL_ONLY_PACKAGES } from '../../fixtures/release/verdaccio-runtime.ts'
import type { CommandResult } from '../../tooling/process.ts'

/** 起环境入参。 */
export interface FixtureEnvironmentOptions {
  readonly layout: RunLayout
  /** verdaccio 共享安装目录（runtime/tools/verdaccio）。 */
  readonly verdaccioInstallDir: string
  /** dsh-plugin-update 工作树根。 */
  readonly sutRoot: string
  /** esbuild 平台二进制路径。 */
  readonly esbuildPath: string
  /** npmjs 依赖镜像缓存目录（缺省：与 verdaccio 共享安装目录同级，即 runtime/tools/npmjs-mirror）。 */
  readonly mirrorCacheDir?: string
}

/** 已就绪的夹具环境。 */
export interface FixtureEnvironment {
  readonly layout: RunLayout
  readonly registry: LocalRegistry
  readonly sut: SutPin
  /** SUT 依赖声明（夹具 package.json 里钉的版本）。 */
  readonly sutDependency: FixtureSutDependency
  /** npmjs 运行时依赖镜像事实（本次 run 的 registry 里已发布，装夹具不再回源 npmjs）。 */
  readonly npmjsMirror: NpmjsMirrorFacts
  /** 已发布过的夹具版本（键：席位@版本；重复调用复用，不重复发布——verdaccio 不允许同名版本覆盖）。 */
  published(): PublishedFixture[]
  /** 发布夹具版本；options.staleContentVersion 用于 can-red 故障注入（版本号新、内容旧），不进缓存。 */
  publish(slotKey: FixtureSlotKey, version: string, options?: { readonly staleContentVersion?: string; readonly effect?: FixtureVariantEffect }): Promise<PublishedFixture>
  /** registry 原始输出（raw 证据）。 */
  registryOutput(): { stdout: string; stderr: string }
  stop(): Promise<void>
}

/**
 * 起 registry → 钉 SUT → 发布 npmjs 依赖镜像（不预发夹具；夹具按场景需要再发）。
 *
 * 镜像顺序有依赖：必须先解析镜像包名（决定 verdaccio 哪些包「不吃上游」），再起 registry；
 * 而镜像发布要等 registry 起来、且在 SUT 钉版之后、任何夹具发布/安装之前完成。
 */
export async function createFixtureEnvironment(options: FixtureEnvironmentOptions): Promise<FixtureEnvironment> {
  const mirrorCacheDir = options.mirrorCacheDir || defaultMirrorCacheDir(options.verdaccioInstallDir)
  const mirrorPlan: NpmjsMirrorPlan = await resolveNpmjsMirror({ sutRoot: options.sutRoot, cacheDir: mirrorCacheDir })
  const registry = await startLocalRegistry({
    installDir: options.verdaccioInstallDir,
    runDir: options.layout.registryDir,
    user: 'selftest-publisher',
    password: 'selftest-publisher-password',
    email: 'selftest-publisher@selftest.invalid',
    localOnlyPackages: [...DEFAULT_LOCAL_ONLY_PACKAGES, ...mirrorPlan.dependencies.map((dependency) => dependency.name)],
  })
  try {
    const sut = await pinSutForRegistry({
      sutRoot: options.sutRoot,
      packDir: options.layout.packDir,
      registryUrl: registry.baseUrl,
      npmrcPath: registry.npmrcPath,
    })
    const npmjsMirror = await publishNpmjsMirror({
      plan: mirrorPlan,
      registryUrl: registry.baseUrl,
      npmrcPath: registry.npmrcPath,
    })
    const published: PublishedFixture[] = []
    const effectSignature = (effect: FixtureVariantEffect | undefined): string => (effect ? JSON.stringify(effect) : 'legacy')
    const publish = async (
      slotKey: FixtureSlotKey,
      version: string,
      publishOptions?: { readonly staleContentVersion?: string; readonly effect?: FixtureVariantEffect },
    ): Promise<PublishedFixture> => {
      const signature = effectSignature(publishOptions ? publishOptions.effect : undefined)
      const existing = published.find((item) => item.plan.slot.key === slotKey && item.plan.version === version && effectSignature(item.plan.effect) === signature)
      if (existing && !publishOptions) return existing
      const result = await publishFixtureVersion({
        slotKey,
        version,
        workDir: options.layout.root,
        esbuildPath: options.esbuildPath,
        sutRoot: options.sutRoot,
        sut: { name: sut.name, version: sut.version },
        registryUrl: registry.baseUrl,
        npmrcPath: registry.npmrcPath,
        staleContentVersion: publishOptions ? publishOptions.staleContentVersion : undefined,
        effect: publishOptions ? publishOptions.effect : undefined,
      })
      if (!publishOptions) published.push(result)
      return result
    }
    return {
      layout: options.layout,
      registry,
      sut,
      sutDependency: { name: sut.name, version: sut.version },
      npmjsMirror,
      published: () => published.slice(),
      publish,
      registryOutput: () => ({ stdout: registry.stdout(), stderr: registry.stderr() }),
      stop: async () => {
        await registry.stop()
      },
    }
  } catch (error) {
    try {
      await registry.stop()
    } catch (inner) {
      // 停不掉也要把最初错误抛出去
    }
    throw error
  }
}

/** 一条已发布夹具的安装 spec（<包名>@<版本>）。 */
export function fixtureSpecOf(published: PublishedFixture): string {
  return published.plan.packageName + '@' + published.plan.version
}
