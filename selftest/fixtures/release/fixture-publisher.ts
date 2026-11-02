/**
 * selftest/fixtures/release/fixture-publisher.ts —— 「夹具身份 × 版本」→ 本地 registry 上的可装版本。
 *
 * 一条流水线：生成计划 → 落盘 + esbuild 两条构建 → npm publish → 等 registry 可见。
 * 只发本地 registry（调用方必须传 registryUrl；本文件没有任何「默认 npmjs」的分支）。
 */
import { join } from 'node:path'
import type { FixtureSlotKey, FixtureSutDependency, FixtureVariantEffect } from '../identity/fixture-slots.ts'
import { assertFixtureVersion, fixtureSlotOf } from '../identity/fixture-slots.ts'
import type { FixturePackagePlan } from '../generator/fixture-package-plan.ts'
import { planFixturePackage } from '../generator/fixture-package-plan.ts'
import type { BuiltFixturePackage } from '../generator/fixture-package-builder.ts'
import { buildFixturePackage } from '../generator/fixture-package-builder.ts'
import type { NpmRunResult } from './registry-client.ts'
import { publishFailure, publishPackageDirectory, waitForRegistryVersion } from './registry-client.ts'

/** 发布一个夹具版本的全部入参。 */
export interface PublishFixtureInput {
  readonly slotKey: FixtureSlotKey
  readonly version: string
  /** 产物根目录（run 专属；夹具包落 <workDir>/fixtures/<包名>-<版本>）。 */
  readonly workDir: string
  readonly esbuildPath: string
  /** dsh-plugin-update 工作树根（client bundle 构建期解析 panel/entry）。 */
  readonly sutRoot: string
  /** 夹具 dependencies 里钉住的 SUT 版本（= 就地发布到本 registry 的那个版本）。 */
  readonly sut: FixtureSutDependency
  readonly registryUrl: string
  readonly npmrcPath: string
  /** can-red 故障注入：用这个旧版本的内容构建，但按 version 发布（版本号变了、内容没变）。 */
  readonly staleContentVersion?: string
  /** 版本变体效果（场景声明提供；缺省 = T1 单面板效果）。 */
  readonly effect?: FixtureVariantEffect
}

/** 发布成功的夹具版本。 */
export interface PublishedFixture {
  readonly plan: FixturePackagePlan
  readonly built: BuiltFixturePackage
  readonly publish: NpmRunResult
}

/** 生成 + 构建 + 发布 + 等可见。 */
export async function publishFixtureVersion(input: PublishFixtureInput): Promise<PublishedFixture> {
  const slot = fixtureSlotOf(input.slotKey)
  const version = assertFixtureVersion(slot, input.version)
  const plan = planFixturePackage(slot, version, input.sut, input.effect)
  // can-red：内容用旧版本的（构建标记/标题都是旧的），清单版本号仍是新版本 —— 用来验证
  // 「重启后确实换上了新版内容」这类断言真的会红，而不是只看版本号字符串。
  const contentPlan = input.staleContentVersion ? planFixturePackage(slot, assertFixtureVersion(slot, input.staleContentVersion), input.sut) : null
  const effectivePlan: FixturePackagePlan = contentPlan
    ? {
        ...contentPlan,
        version: plan.version,
        dirName: plan.dirName,
        manifest: { ...contentPlan.manifest, version: plan.version },
        // 清单源文件也要按新版本号重渲染：npm publish 读的是落盘的 package.json，改 plan.manifest 不改源文件会发成旧版本。
        sourceFiles: contentPlan.sourceFiles.map((file) =>
          file.role === 'manifest' ? { ...file, content: JSON.stringify({ ...contentPlan.manifest, version: plan.version }, null, 2) + '\n' } : file,
        ),
      }
    : plan
  const outDir = join(input.workDir, 'fixtures', effectivePlan.dirName)
  const built = await buildFixturePackage({
    plan: effectivePlan,
    outDir,
    esbuildPath: input.esbuildPath,
    sutRoot: input.sutRoot,
  })
  const publish = publishPackageDirectory({
    cwd: built.dir,
    registryUrl: input.registryUrl,
    npmrcPath: input.npmrcPath,
  })
  if (publish.exitCode !== 0) throw publishFailure(publish)
  await waitForRegistryVersion({
    baseUrl: input.registryUrl,
    packageName: effectivePlan.packageName,
    version: effectivePlan.version,
  })
  return { plan: effectivePlan, built, publish }
}
