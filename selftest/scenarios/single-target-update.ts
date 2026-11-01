/**
 * selftest/scenarios/single-target-update.ts —— N=1 场景（数据组装，Builder）。
 *
 * 场景：target-a 从 0.0.1 到 0.0.2（registry 预置 latest=0.0.2，host 预置成功）。
 * 本文件只组装“参数 + 依赖”，不跑流程（跑是 runner 的事）；依赖全是 B 档假件，不联网。
 */

import { TARGET_A } from '../target-definition/target-spec.js'
import type { SingleTargetParams, ScenarioDeps } from '../scenario-harness/scenario-runner.js'
import { createLocalDirectoryRegistry } from '../scenario-harness/registry-port.js'
import { createFakeHostInstallPort } from '../scenario-harness/host-port.js'

/** Builder：组装 N=1 的参数（版本号非法即抛，不组装“看起来能跑但语义错”的场景）。 */
export function buildSingleTargetUpdateParams(): SingleTargetParams {
  return {
    kind: 'single',
    id: 'single-target-update',
    title: '单目标：a 从 0.0.1 升到 0.0.2',
    target: TARGET_A,
    fromVersion: '0.0.1',
    toVersion: '0.0.2',
  }
}

/** Builder：组装 N=1 的依赖（registry/host 都是假件，确定性最高）。 */
export function buildSingleTargetUpdateDeps(): ScenarioDeps {
  return {
    registry: createLocalDirectoryRegistry({ [TARGET_A.name]: '0.0.2' }),
    host: createFakeHostInstallPort(),
  }
}
