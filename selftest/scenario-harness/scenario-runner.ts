/**
 * selftest/scenario-harness/scenario-runner.ts —— 场景生命周期（Template Method）。
 *
 * 生命周期固定五步（场景只给参数，不给流程）：
 * setup（守卫目标名）→ check（registry 查新版）→ install（host 装整串）→
 * verify（verdict 裁决）→ teardown（本档无状态要清，留钩子给 C 档）。
 *
 * 算法：批量按 TARGET_PAIR 顺序串行推进（不并发）。
 * 并发会引入“谁先写账本”的不确定性，B 档要的是确定性；真并发压测留给 C 档另起场景。
 */

import type { FixtureTargetSpec } from '../target-definition/target-spec.js'
import { assertSelftestTarget } from '../target-definition/target-spec.js'
import type { HostInstallPort } from './host-port.js'
import type { RegistryPort } from './registry-port.js'
import { verifySingleTargetUpdated } from './update-verdict.js'
import type { UpdateVerdict } from './update-verdict.js'

/** 场景入参（数据，不是逻辑）：从哪版到哪版、目标是谁。 */
export interface SingleTargetParams {
  readonly kind: 'single'
  readonly id: string
  readonly title: string
  readonly target: FixtureTargetSpec
  readonly fromVersion: string
  readonly toVersion: string
}

export interface BatchTwoTargetsParams {
  readonly kind: 'batch'
  readonly id: string
  readonly title: string
  readonly first: FixtureTargetSpec
  readonly second: FixtureTargetSpec
  readonly fromVersion: string
  readonly toVersion: string
}

export type ScenarioParams = SingleTargetParams | BatchTwoTargetsParams

export interface ScenarioDeps {
  readonly registry: RegistryPort
  readonly host: HostInstallPort
}

export type ScenarioResult =
  | { readonly kind: 'passed'; readonly id: string; readonly verdict: UpdateVerdict }
  | { readonly kind: 'failed'; readonly id: string; readonly reason: string }

function specOf(target: FixtureTargetSpec, version: string): string {
  return `${target.name}@${version}`
}

/** 模板方法：单目标五步（check  miss 即失败，不 fallback、不猜）。 */
export async function runSingleTargetScenario(
  params: SingleTargetParams,
  deps: ScenarioDeps,
): Promise<ScenarioResult> {
  assertSelftestTarget(params.target.name)
  const latest = await deps.registry.resolveLatest(params.target.name)
  if (latest === null) {
    return { kind: 'failed', id: params.id, reason: `registry miss: ${params.target.name}` }
  }
  if (latest !== params.toVersion) {
    return { kind: 'failed', id: params.id, reason: `registry drift: want ${params.toVersion}, got ${latest}` }
  }
  const spec = specOf(params.target, params.toVersion)
  const installed = await deps.host.install({ spec })
  const verdict = verifySingleTargetUpdated({
    installedVersion: params.toVersion,
    expectedVersion: params.toVersion,
    exitCode: installed.exitCode,
    spec,
  })
  if (verdict.kind === 'updated' || verdict.kind === 'already-latest') {
    return { kind: 'passed', id: params.id, verdict }
  }
  return { kind: 'failed', id: params.id, reason: `verdict: ${verdict.kind}` }
}

/**
 * 模板方法：批量两目标（串行；断言每家恰好一次且互不相交）。
 * 调用记录是“隔离性”的第一证据：a 的 spec 里不许出现 b 的名字，反之亦然。
 */
export async function runBatchTwoTargetsScenario(
  params: BatchTwoTargetsParams,
  deps: ScenarioDeps,
): Promise<ScenarioResult> {
  assertSelftestTarget(params.first.name)
  assertSelftestTarget(params.second.name)
  if (params.first.name === params.second.name) {
    return { kind: 'failed', id: params.id, reason: 'batch targets must differ (need a and b)' }
  }
  const first = await runSingleTargetScenario(
    {
      kind: 'single',
      id: `${params.id}/a`,
      title: params.title,
      target: params.first,
      fromVersion: params.fromVersion,
      toVersion: params.toVersion,
    },
    deps,
  )
  if (first.kind !== 'passed') {
    return { kind: 'failed', id: params.id, reason: `first failed: ${first.reason}` }
  }
  const second = await runSingleTargetScenario(
    {
      kind: 'single',
      id: `${params.id}/b`,
      title: params.title,
      target: params.second,
      fromVersion: params.fromVersion,
      toVersion: params.toVersion,
    },
    deps,
  )
  if (second.kind !== 'passed') {
    return { kind: 'failed', id: params.id, reason: `second failed: ${second.reason}` }
  }
  const calls = deps.host.recordedCalls()
  const specs = calls.map((c) => c.spec)
  const firstSpecs = specs.filter((s) => s.startsWith(`${params.first.name}@`))
  const secondSpecs = specs.filter((s) => s.startsWith(`${params.second.name}@`))
  if (firstSpecs.length !== 1 || secondSpecs.length !== 1 || specs.length !== 2) {
    return { kind: 'failed', id: params.id, reason: `isolation: want 1+1 calls, got [${specs.join(', ')}]` }
  }
  return { kind: 'passed', id: params.id, verdict: second.verdict }
}

/** 分发器：按 `kind` 穷尽分支（加新场景种类时 tsc 会逼你补分支）。 */
export async function runScenario(params: ScenarioParams, deps: ScenarioDeps): Promise<ScenarioResult> {
  switch (params.kind) {
    case 'single':
      return runSingleTargetScenario(params, deps)
    case 'batch':
      return runBatchTwoTargetsScenario(params, deps)
  }
}
