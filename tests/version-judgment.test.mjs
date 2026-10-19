// tests/version-judgment.test.mjs —— #165 第二刀：service 判定核独立。
//
// 契约：版本判定纯函数搬新模块后，老位置（dist/core/service.js）经垫片 re-export，外部一切照旧。
// 只测外部行为：抽样判定函数在两边同时存在、恒等（===），并在新地址上锁住关键语义。
// 型导出（ReleaseChannel）由 tsc 覆盖；类型环清零由基线脚本重跑＋tsc 全绿证明（不读源码断言）。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as service from '../dist/core/service.js'
import * as vj from '../dist/core/judgment.js'

const JUDGES = [
  'validVersion',
  'validReleaseChannel',
  'validReleaseVersion',
  'isPrereleaseVersion',
  'isVersionAllowedInChannel',
  'compareVersions',
  'compareReleaseVersions',
  'satisfiesNodeRange',
  'updateError',
  'RELEASE_CHANNELS',
]

describe('service 判定核垫片（#165）', () => {
  it('判定函数：新模块有，老位置恒等', () => {
    for (const name of JUDGES) {
      assert.ok(vj[name] !== undefined, `version-judgment 应导出 ${name}`)
      assert.ok(service[name] !== undefined, `service 应经垫片保留 ${name}`)
      assert.equal(service[name], vj[name], `${name} 两边应恒等（同一引用）`)
    }
  })

  it('新地址锁住关键语义（抽样）', () => {
    assert.equal(vj.compareVersions('1.2.3', '1.2.4'), -1)
    assert.equal(vj.validReleaseVersion('0.2.0-rc.2'), true)
    assert.equal(vj.isVersionAllowedInChannel('1.0.0-rc.1'), false, 'stable 默认不收预发布')
    assert.equal(vj.satisfiesNodeRange('v22.1.0', '>=20'), true)
    assert.equal(vj.updateError('internal').code, 'internal')
  })

  it('非判定实现仍在老位置：createUpdateCore 可建核心', () => {
    assert.equal(typeof service.createUpdateCore, 'function', '编排实现不搬家')
    assert.equal(vj.createUpdateCore, undefined, '判定模块不许顺手带走编排')
  })
})
