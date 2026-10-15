/**
 * tests/issue-143-outer-scroll.test.mjs —— #143 外层面板根滚动保持。
 *
 * 只测外部行为：调公开入口（mount / setChangelogCollapsed），看滚动位置，
 * 不刺探内部闭包变量。
 *
 * 背景：dialog 下外层面板根（.dsh-upd）与内层滚动区（.dsh-upd-body）同时可滚，
 * 但重绘只保存/恢复内层。语义变化触发必要重绘时，外层滚动归零。
 * 真实 DOM 里整树替换会销毁旧节点：替身容器的 innerHTML 赋值即把两处
 * scrollTop 归零，以此模拟；保持逻辑负责在替换后恢复。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdatePanel } from '../dist/panel.js'

const LOG_MD = '# Changelog\n\n## [0.4.26] - 2026-10-15\n\n### Fixed\n\n- 修了 A\n'

function baseSnapshot() {
  return {
    runningVersion: '0.4.24',
    installedVersion: '0.4.24',
    latestVersion: '0.4.26',
    canInstall: true,
    blockedReason: null,
    job: null,
  }
}

function baseQueue() {
  return { busy: false, owner: null, waiting: [], position: null }
}

function fakeDialogScrollable() {
  const bodyNode = { scrollTop: 0 }
  const rootNode = { scrollTop: 0 }
  const box = {
    _html: '',
    get innerHTML() {
      return this._html
    },
    set innerHTML(v) {
      this._html = v
      bodyNode.scrollTop = 0
      rootNode.scrollTop = 0
    },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll(sel) {
      if (sel === '.dsh-upd-body') return [bodyNode]
      if (sel === '.dsh-upd') return [rootNode]
      return []
    },
    querySelector() {
      return null
    },
  }
  return { box, bodyNode, rootNode }
}

async function settled(ms = 20) {
  await new Promise((r) => setTimeout(r, ms))
}

test('#143 语义重绘后外层与内层滚动都不丢', async () => {
  const g = globalThis
  const hadDoc = Object.prototype.hasOwnProperty.call(g, 'document')
  const prevDoc = g.document
  g.document = { activeElement: null }
  let panel = null
  try {
    const { box, bodyNode, rootNode } = fakeDialogScrollable()
    panel = mountUpdatePanel(box, {
      pluginId: 'issue-143-scroll',
      call: async () => ({ ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: baseQueue() }),
      pollMs: 60000,
      mode: 'dialog',
      autoChangelog: false,
      changelogMarkdown: LOG_MD,
    })
    await settled()
    await settled()
    assert.ok(box.innerHTML.includes('收起更新日志'), '挂载后更新日志应默认展开')
    bodyNode.scrollTop = 45
    rootNode.scrollTop = 123
    await panel.setChangelogCollapsed(true)
    await settled()
    assert.ok(box.innerHTML.includes('展开更新日志'), '语义重绘应已发生（折叠翻转）')
    assert.equal(bodyNode.scrollTop, 45, '内层滚动应保持')
    assert.equal(rootNode.scrollTop, 123, '外层面板根滚动应保持，不归零')
  } finally {
    if (panel) panel.unmount()
    if (hadDoc) g.document = prevDoc
    else delete g.document
  }
})
