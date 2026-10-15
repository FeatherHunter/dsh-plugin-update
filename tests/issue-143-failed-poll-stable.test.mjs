/**
 * tests/issue-143-failed-poll-stable.test.mjs —— #143 失败态轮询不 churn。
 *
 * 只测外部行为：调公开入口（mount / refresh），看整面板 HTML，
 * 不刺探内部闭包变量。
 *
 * 背景：install-failed 后只读轮询每次用“当前时间”重建失败锁存 atMs，
 * 04 章“失败于 HH:MM:SS”每过一秒就变，整树 innerHTML 每秒替换，
 * dialog 外层滚动随之归位。同一失败语义的重复轮询应输出一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdatePanel } from '../dist/panel.js'

function baseSnapshot(job) {
  return {
    runningVersion: '0.4.24',
    installedVersion: '0.4.24',
    latestVersion: '0.4.26',
    canInstall: true,
    blockedReason: null,
    job,
  }
}

function baseQueue() {
  return { busy: false, owner: null, waiting: [], position: null }
}

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

function failedJob() {
  return {
    id: 'job-143',
    state: 'failed',
    targetVersion: '0.4.26',
    message: 'install-failed: 宿主执行失败',
    requestId: 'req-143',
  }
}

async function settled(ms = 20) {
  await new Promise((r) => setTimeout(r, ms))
}

function failedTimeText(html) {
  const m = html.match(/失败时间 \d{1,2}:\d{2}:\d{2}/)
  return m ? m[0] : null
}

test('#143 同失败快照连轮两次：HTML 一致，失败时刻不漂移', async () => {
  const realNow = Date.now
  let now = 1_769_999_000_000
  Date.now = () => now
  let panel = null
  try {
    const snap = () => baseSnapshot(failedJob())
    const box = fakeContainer()
    panel = mountUpdatePanel(box, {
      pluginId: 'issue-143-stable',
      call: async (name) => {
        if (name.endsWith('.updateStatus')) {
          return { ok: true, snapshot: snap(), manual: null, receipt: null, queue: baseQueue() }
        }
        if (name.endsWith('.updateCheck')) {
          return {
            ok: true,
            snapshot: snap(),
            manual: null,
            receipt: { checkId: 'check-143', checkedAt: 1, expiresAt: 9999999999999 },
            queue: baseQueue(),
          }
        }
        throw new Error('unexpected-phone:' + name)
      },
      pollMs: 60000,
      autoChangelog: false,
    })
    await settled()
    await settled()
    await settled()
    const html1 = box.innerHTML
    assert.match(html1, /更新失败/, '失败态应有失败横幅')
    assert.ok(failedTimeText(html1), '失败态应带失败时刻，实际=' + JSON.stringify(html1.slice(0, 200)))
    now += 2500
    await panel.refresh()
    await settled()
    const html2 = box.innerHTML
    now += 2500
    await panel.refresh()
    await settled()
    const html3 = box.innerHTML
    assert.equal(failedTimeText(html2), failedTimeText(html1), '轮询后失败时刻不应漂移')
    assert.equal(html2, html1, '同语义失败快照重复轮询不应重绘整树')
    assert.equal(html3, html1, '第三轮轮询仍应与首轮一致')
  } finally {
    Date.now = realNow
    if (panel) panel.unmount()
  }
})
