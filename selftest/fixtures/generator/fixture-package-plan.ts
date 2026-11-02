/**
 * selftest/fixtures/generator/fixture-package-plan.ts —— 纯函数：身份 × 版本 → 夹具包的完整「生成计划」。
 *
 * 计划 = 包清单（manifest）+ 要落盘的源文件 + 构建步骤描述（host/client 两个 esbuild 目标）。
 * 本文件不碰磁盘、不跑进程，所以能在 hermetic 单测里直接断言（generator 单测见同目录 *.test.ts）。
 * 真正的落盘与 esbuild 由 fixture-package-builder.ts 按计划执行。
 */
import type { FixtureSlot, FixtureSutDependency, FixtureVariantEffect } from '../identity/fixture-slots.ts'
import { assertFixtureVersion, fixtureBuildTagsOf, fixtureLegacyEffectOf } from '../identity/fixture-slots.ts'
import type { FixturePackageManifest } from '../templates/package/package-manifest-template.ts'
import { renderPackageManifest } from '../templates/package/package-manifest-template.ts'
import { renderCordisPatch } from '../templates/package/cordis-patch-template.ts'
import { renderIntegratorHostHalf } from '../templates/integrator/integrator-host-half-template.ts'
import { renderIntegratorClientHalf } from '../templates/integrator/integrator-client-half-template.ts'
import { renderTargetHostHalf } from '../templates/target/target-host-half-template.ts'
import { renderTargetClientHalf } from '../templates/target/target-client-half-template.ts'

/** 计划里一个待落盘的文本文件。 */
export interface FixtureSourceFile {
  /** 相对夹具包目录的路径（POSIX 分隔符）。 */
  readonly path: string
  readonly content: string
  /** 文件角色：给人看/给测试断言的标签，不影响落盘。 */
  readonly role: 'manifest' | 'cordis-patch' | 'host-source' | 'client-source'
}

/** 一次 esbuild 构建的入参（builder 负责把 target 映射成真实命令行）。 */
export interface FixtureBuildStep {
  readonly target: 'host' | 'client'
  /** 相对夹具包目录的入口源。 */
  readonly entry: string
  /** 相对夹具包目录的产物。 */
  readonly outfile: string
  /** client 专用：loader 包壳里的模块 id（= pluginId）。 */
  readonly bundleId?: string
}

/** 一个夹具包版本的生成计划（纯数据）。 */
export interface FixturePackagePlan {
  readonly slot: FixtureSlot
  readonly version: string
  readonly packageName: string
  /** 夹具包目录名（= <包名>-<版本>，放 run 目录下，不进仓）。 */
  readonly dirName: string
  readonly manifest: FixturePackageManifest
  readonly sourceFiles: readonly FixtureSourceFile[]
  readonly buildSteps: readonly FixtureBuildStep[]
  /** 生成产物里必须存在的文件（发布前自检用：少一个就是构建坏了）。 */
  readonly expectedArtifacts: readonly string[]
  /** 本计划用的版本变体效果（缺省 = T1 单面板效果；证据里按它写预期）。 */
  readonly effect: FixtureVariantEffect
}

/** 生成计划（纯函数；版本不在声明序列里会立刻抛）。 */
export function planFixturePackage(
  slot: FixtureSlot,
  version: string,
  sut: FixtureSutDependency,
  effect?: FixtureVariantEffect,
): FixturePackagePlan {
  const pinnedVersion = assertFixtureVersion(slot, version)
  // 计划里落一份具体的 effect：证据/单测可以按计划核对「这个版本到底改了什么」，模板不再自己猜默认值。
  const resolvedEffect = effect ?? fixtureLegacyEffectOf(pinnedVersion)
  const buildTags = fixtureBuildTagsOf(slot, pinnedVersion, resolvedEffect)
  // 两个半身的渲染入口按角色分派：加新角色时 tsc 会逼你在这里补分支。
  const hostSource =
    slot.role === 'integrator'
      ? renderIntegratorHostHalf({ slot, version: pinnedVersion, buildTags, effect: resolvedEffect })
      : renderTargetHostHalf({ slot, version: pinnedVersion, buildTags })
  const clientSource =
    slot.role === 'integrator'
      ? renderIntegratorClientHalf({ slot, version: pinnedVersion, buildTags, effect: resolvedEffect })
      : renderTargetClientHalf({ slot, version: pinnedVersion, buildTags, effect: resolvedEffect })
  const manifest = renderPackageManifest(slot, pinnedVersion, sut)
  return {
    slot,
    version: pinnedVersion,
    packageName: slot.packageName,
    dirName: slot.packageName + '-' + pinnedVersion,
    manifest,
    sourceFiles: [
      { path: 'package.json', content: JSON.stringify(manifest, null, 2) + '\n', role: 'manifest' },
      { path: 'cordis.patch.yml', content: renderCordisPatch(slot), role: 'cordis-patch' },
      { path: 'src/index.ts', content: hostSource, role: 'host-source' },
      { path: 'src/client.ts', content: clientSource, role: 'client-source' },
    ],
    buildSteps: [
      { target: 'host', entry: 'src/index.ts', outfile: 'lib/index.js' },
      { target: 'client', entry: 'src/client.ts', outfile: 'lib/client.js', bundleId: slot.pluginId },
    ],
    expectedArtifacts: ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js'],
    effect: resolvedEffect,
  }
}

/** 计划里某个角色的源文件（找不到立刻抛：模板/计划不同步是生成层的硬错误）。 */
export function sourceFileOf(plan: FixturePackagePlan, role: FixtureSourceFile['role']): FixtureSourceFile {
  const file = plan.sourceFiles.find((candidate) => candidate.role === role)
  if (!file) throw new Error('[fixtures] 计划缺少 ' + role + ' 源文件：' + plan.packageName + '@' + plan.version)
  return file
}
