import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as panel from '../dist/panel.js'
import * as pc from '../dist/panel-copy.js'

const FACE = [
  'blockedCopy',
  'failureCopy',
  'isKnownFailureCode',
  'failureCodeOf',
  'replyIsCheckExpired',
  'thrownIsCheckExpired',
  'PANEL_DIAG_MAX_CHARS',
  'redactForCopy',
  'buildDiagnosticText',
  'readDiagTolerant',
  'causeRemedyText',
  'buildUpdateDiagCopy',
  'buildHealthyDiagCopy',
  'logHealthText',
]

test('#166 文案垫片：panel 老位置仍是同一份（同一引用），渲染核仍在 panel', () => {
  for (const name of FACE) assert.equal(panel[name], pc[name], name)
  assert.equal(typeof panel.mountUpdatePanel, 'function')
  assert.equal(typeof panel.renderUpdatePanelKernel, 'function')
  assert.equal(pc.mountUpdatePanel, undefined, '渲染核是 panel 的本体，不进 panel-copy')
  assert.equal(pc.renderUpdatePanelKernel, undefined, '渲染核是 panel 的本体，不进 panel-copy')
  assert.equal(typeof pc.queueTextOf, 'function', '内部小工具随文案走')
  assert.equal(panel.queueTextOf, undefined, '内部小工具不进 panel 公共面（面零变化）')
})

test('#166 文案语义抽查：失败码出文案，空码回 null 不猜', () => {
  const failure = pc.failureCopy('channel-mismatch')
  assert.ok(failure && typeof failure.zh === 'string' && typeof failure.act === 'string')
  assert.equal(failure.zh, pc.blockedCopy('channel-mismatch')?.title)
  assert.equal(pc.failureCopy(null), null)
  assert.equal(pc.blockedCopy(null), null)
  assert.equal(pc.blockedCopy('not-a-reason'), null)
})
