/**
 * selftest/fixtures/templates/package/package-manifest-template.ts —— 可安装插件包 package.json 的模板（#265 A 案）。
 *
 * 只产数据、不落盘：生成器拿到 manifest 再 JSON.stringify 写文件，单测可直接断言字段。
 * 形状来源：exploration/T1-wiring-notes.md §2.2（真机实测过的最小可安装契约）。
 */
import type { FixtureSlot, FixtureSutDependency, FixtureVariantEffect } from '../../identity/fixture-slots.ts'
import { FIXTURE_EVIDENCE_TAG } from '../../identity/fixture-slots.ts'

/** 夹具包的 package.json 形状（字段顺序即落盘顺序，便于人读 diff）。 */
export interface FixturePackageManifest {
  readonly name: string
  readonly version: string
  readonly private: false
  readonly type: 'module'
  readonly description: string
  readonly license: 'MIT'
  readonly main: string
  readonly exports: {
    readonly '.': string
    readonly './client': string
    readonly './package.json': string
  }
  readonly files: readonly string[]
  readonly engines: { readonly dsh: string }
  readonly dependencies: Record<string, string>
  readonly dsh: {
    readonly client: { readonly platform: 'web'; readonly inject: readonly string[] }
    readonly bundle: { readonly patch: string }
  }
}

/** 夹具包对宿主的版本要求（与 T1-wiring-notes 实测一致）。 */
export const FIXTURE_DSH_ENGINE_RANGE = '>=0.2.0-rc.2 <0.3.0-0'

/** 生成 package.json 数据（纯函数）。effect 只管 CHANGELOG.md 是否随包发布（#274 K 组）。 */
export function renderPackageManifest(
  slot: FixtureSlot,
  version: string,
  sut: FixtureSutDependency,
  effect?: FixtureVariantEffect,
): FixturePackageManifest {
  return {
    name: slot.packageName,
    version,
    private: false,
    type: 'module',
    description: slot.description + ' [' + FIXTURE_EVIDENCE_TAG + ']',
    license: 'MIT',
    main: './lib/index.js',
    exports: {
      '.': './lib/index.js',
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    files: effect?.changelogMarkdown ? ['lib', 'cordis.patch.yml', 'CHANGELOG.md'] : ['lib', 'cordis.patch.yml'],
    engines: { dsh: FIXTURE_DSH_ENGINE_RANGE },
    // #266 纯目标 C 不接更新链：清单里不依赖被测更新系统（场景 c 按这个字段断言「无更新接线」）。
    // 集成方 A/B 必须依赖它，才装得上更新内核并发起批量。
    dependencies: slot.role === 'integrator' ? { [sut.name]: sut.version } : {},
    dsh: {
      client: { platform: 'web', inject: [] },
      bundle: { patch: './cordis.patch.yml' },
    },
  }
}
