/**
 * selftest/scenarios/batch-two-targets.ts —— N=2 场景（数据组装，Builder）。
 *
 * 场景：a/b 各自从 0.0.1 到 0.0.2，串行推进；runner 会断言调用记录恰好 1+1 且互不相交
 * （批量账本/队列/日志隔离的最小证据；hub 租约与 failure-settled 留给 C 档）。
 */

import { TARGET_A, TARGET_B } from '../target-definition/target-spec.js'
import type { BatchTwoTargetsParams, ScenarioDeps } from '../scenario-harness/scenario-runner.js'
import { createLocalDirectoryRegistry } from '../scenario-harness/registry-port.js'
import { createFakeHostInstallPort } from '../scenario-harness/host-port.js'

/** Builder：组装 N=2 的参数（两家必须不同，否则 runner 拒跑）。 */
export function buildBatchTwoTargetsParams(): BatchTwoTargetsParams {
  return {
    kind: 'batch',
    id: 'batch-two-targets',
    title: '批量：a/b 各自从 0.0.1 升到 0.0.2，互不干扰',
    first: TARGET_A,
    second: TARGET_B,
    fromVersion: '0.0.1',
    toVersion: '0.0.2',
  }
}

/** Builder：组装 N=2 的依赖（两家 latest 都是 0.0.2；host 共用一个假件以便查隔离）。 */
export function buildBatchTwoTargetsDeps(): ScenarioDeps {
  const host = createFakeHostInstallPort()
  return {
    registry: createLocalDirectoryRegistry({ [TARGET_A.name]: '0.0.2', [TARGET_B.name]: '0.0.2' }),
    host,
  }
}
