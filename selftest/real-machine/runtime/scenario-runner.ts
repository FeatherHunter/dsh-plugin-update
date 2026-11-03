/**
 * selftest/real-machine/runtime/scenario-runner.ts —— 场景声明（identity/scenario-declarations.ts）的执行器。
 *
 * 「声明驱动」意味着：发布哪些版本、装哪些包、每个包渲染成什么效果，全从场景声明读，
 * 场景文件里不许再写死 0.0.1/0.0.2 或「（新版）」这类内容。新增场景/新增变体只改声明。
 *
 * 两个入口：
 *   - publishStrategy(scenario) / publishBaseline：干净 profile 预装的基版（含效果）；
 *   - publishScenarioVariants：更新时发布的变体版（可按 can-red 注入跳过/固化某条）。
 */
import type { FixtureSlotKey } from '../../fixtures/identity/fixture-slots.ts'
import type { ScenarioDeclaration } from '../../fixtures/identity/scenario-declarations.ts'
import type { PublishedFixture } from '../../fixtures/release/fixture-publisher.ts'
import type { FixtureEnvironment } from './fixture-environment.ts'
import { fixtureSpecOf } from './fixture-environment.ts'
import type { InstalledPluginFacts } from '../host/dsh-cli.ts'
import { installPluginIntoProfile } from '../host/isolated-profile.ts'

/** can-red 注入点（b/c 两个场景各用一条；注入必须打在被测断言本身）。 */
export interface ScenarioFaultInjection {
  /** 'skip-variant'：不发布某条变体（例：b 场景不发布 B@0.0.2 → 「三目标都到 0.0.2」必然红）。 */
  readonly kind: 'skip-variant' | 'stale-variant'
  /** 作用在哪个席位的变体上。 */
  readonly slotKey: FixtureSlotKey
  /** 人类可读说明（写进 run.json notes 与 raw/can-red-fault.json）。 */
  readonly description: string
}

/** 一次场景的夹具发布结果（键 = 席位键）。 */
export interface ScenarioPublication {
  readonly baseline: Record<FixtureSlotKey, PublishedFixture>
  readonly variants: Record<FixtureSlotKey, PublishedFixture>
  /** 被 can-red 注入跳过/固化的变体（空 = 正常跑）。 */
  readonly injected: readonly { slotKey: FixtureSlotKey; kind: ScenarioFaultInjection['kind']; spec: string }[]
}

/** 发布场景的基版（按声明顺序去重；同席位同版本只发一次）。 */
export async function publishScenarioBaseline(
  scenario: ScenarioDeclaration,
  env: FixtureEnvironment,
): Promise<Record<FixtureSlotKey, PublishedFixture>> {
  const result = {} as Record<FixtureSlotKey, PublishedFixture>
  for (const step of scenario.install) {
    if (result[step.slotKey]) continue
    const published = await env.publish(step.slotKey, step.version, { effect: step.effect })
    result[step.slotKey] = published
  }
  return result
}

/** 发布场景的变体版；faultInjection 命中时跳过该变体（can-red）或把内容固化成基版（stale-variant）。 */
export async function publishScenarioVariants(
  scenario: ScenarioDeclaration,
  env: FixtureEnvironment,
  faultInjection?: ScenarioFaultInjection,
  publishedBaseline?: Record<FixtureSlotKey, PublishedFixture>,
): Promise<ScenarioPublication> {
  // 调用方若已经发布过基版（场景先在安装阶段发布并装上），直接复用，避免向 verdaccio 重发同版本（同版本不可覆盖）。
  const baseline = publishedBaseline ?? (await publishScenarioBaseline(scenario, env))
  const variants = {} as Record<FixtureSlotKey, PublishedFixture>
  const injected: { slotKey: FixtureSlotKey; kind: ScenarioFaultInjection['kind']; spec: string }[] = []
  for (const variant of scenario.variants) {
    if (faultInjection && faultInjection.slotKey === variant.slotKey && faultInjection.kind === 'skip-variant') {
      injected.push({ slotKey: variant.slotKey, kind: 'skip-variant', spec: variant.slotKey + '@' + variant.version })
      continue
    }
    if (faultInjection && faultInjection.slotKey === variant.slotKey && faultInjection.kind === 'stale-variant') {
      const baseStep = scenario.install.find((step) => step.slotKey === variant.slotKey)
      if (!baseStep) throw new Error('[scenario-runner] stale-variant 需要该席位有基版声明：' + variant.slotKey)
      const published = await env.publish(variant.slotKey, variant.version, { effect: variant.effect, staleContentVersion: baseStep.version })
      variants[variant.slotKey] = published
      injected.push({ slotKey: variant.slotKey, kind: 'stale-variant', spec: fixtureSpecOf(published) })
      continue
    }
    variants[variant.slotKey] = await env.publish(variant.slotKey, variant.version, { effect: variant.effect })
  }
  return { baseline, variants, injected }
}

/** 一次 CLI 预装的结果（按席位）。 */
export interface ScenarioInstallResult {
  readonly slotKey: FixtureSlotKey
  readonly packageName: string
  readonly version: string
  readonly facts: InstalledPluginFacts
  readonly install: { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }
}

/**
 * 把场景基版按声明装进干净 profile（CLI 逐个 add；每装一个立刻核对磁盘三处）。
 * 返回按声明顺序的安装事实（证据 raw 直接落盘）。
 */
export async function installScenarioBaseline(
  scenario: ScenarioDeclaration,
  publication: Record<FixtureSlotKey, PublishedFixture>,
  target: { readonly homeDir: string; readonly profileName: string; readonly registryUrl: string },
): Promise<ScenarioInstallResult[]> {
  const results: ScenarioInstallResult[] = []
  for (const step of scenario.install) {
    const published = publication[step.slotKey]
    if (!published) throw new Error('[scenario-runner] 场景 ' + scenario.id + ' 缺少席位 ' + step.slotKey + ' 的基版发布结果')
    const installed = await installPluginIntoProfile({
      homeDir: target.homeDir,
      profileName: target.profileName,
      packageName: published.plan.packageName,
      version: published.plan.version,
      registryUrl: target.registryUrl,
    })
    results.push({
      slotKey: step.slotKey,
      packageName: published.plan.packageName,
      version: published.plan.version,
      facts: installed.facts,
      install: installed.install,
    })
  }
  return results
}

/** 场景声明里某个席位在变体阶段的预期版本（没有变体则 null）。 */
export function variantVersionOf(scenario: ScenarioDeclaration, slotKey: FixtureSlotKey): string | null {
  const variant = scenario.variants.find((item) => item.slotKey === slotKey)
  return variant ? variant.version : null
}

/** 场景声明里某个席位的基版版本。 */
export function baselineVersionOf(scenario: ScenarioDeclaration, slotKey: FixtureSlotKey): string {
  const step = scenario.install.find((item) => item.slotKey === slotKey)
  if (!step) throw new Error('[scenario-runner] 场景 ' + scenario.id + ' 没有席位 ' + slotKey + ' 的基版')
  return step.version
}
