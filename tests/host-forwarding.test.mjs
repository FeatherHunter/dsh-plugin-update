// tests/host-forwarding.test.mjs —— #162 tracer 首刀（#164 规格）：宿主转发表剥离。
//
// 契约：转发表搬新模块后，老包根（dist/host.js）经垫片 re-export，外部一切照旧。
// 只测外部行为：抽样各来源家族的值导出在两边同时存在且恒等（===）。
// 型导出由 tsc 覆盖（本包 typecheck 全绿即 type 垫片不断）。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as host from '../dist/host.js'
import * as fwd from '../dist/host-forwarding.js'

// [来源家族 → 抽样值导出]：每家至少一个函数＋一个常量（如有），搬家漏项即红。
const SAMPLES = [
  ['config', ['buildPhoneNames', 'resolveUpdateConfig']],
  ['gate', ['LOG_ROW_VERSION', 'lintEventFields']],
  ['reader', ['resolveTargetPackage', 'defaultHomeDir']],
  ['redaction', ['sanitizeDetail', 'REDACTED_SECRET']],
  ['diag', ['buildDiag', 'DIAG_KEYS']],
  ['install-cause', ['interpretInstallCause']],
  ['compliant-version', ['resolveCompliantVersion']],
  ['changelog', ['parseChangelog', 'changelogForUpdate']],
  ['changelog-io', ['fetchReleaseChangelogText']],
  ['store', ['createUpdateQueuePorts', 'QUEUE_FILE']],
  ['service', ['validReleaseVersion', 'compareReleaseVersions']],
  ['queue', ['enqueueInQueue', 'QUEUE_INTENT_TTL_MS']],
]

describe('host 转发表垫片（#162/#164）', () => {
  for (const [family, names] of SAMPLES) {
    it(`${family}：新模块有，老包根恒等`, () => {
      for (const name of names) {
        assert.ok(fwd[name] !== undefined, `host-forwarding 应转出 ${name}`)
        assert.ok(host[name] !== undefined, `host 应经垫片保留 ${name}`)
        assert.equal(host[name], fwd[name], `${name} 两边应恒等（同一引用）`)
      }
    })
  }

  it('宿主真实现仍在老包根：createHostUpdate 可建能力', () => {
    assert.equal(typeof host.createHostUpdate, 'function', '真实现不搬家')
    assert.equal(fwd.createHostUpdate, undefined, '转发表不许顺手带走真实现')
  })
})
