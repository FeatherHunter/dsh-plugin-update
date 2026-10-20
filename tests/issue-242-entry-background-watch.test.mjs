/**
 * tests/issue-242-entry-background-watch.test.mjs —— #242 批量入口按钮卡「正在安装…」。
 *
 * 只测外部行为：挂入口件 → 看容器 HTML / 看电话记录。铁律：入口件不自动安装，
 * 后台跟进只允许打只读的 batchStatus；批量跑完后按钮必须自己刷回来，不许等用户再点。
 *
 * 现场（2026-10-20 16:41-16:48 web profile）：弹窗期间关掉、批量在宿主侧继续跑到结束，
 * 入口件最后一次 refresh 停在 installing 相位 → 按钮永久「正在安装…」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdateBatchEntry } from '../dist/entry-batch.js'

const MIN_POLL = 250

function snapshotOf(overrides = {}) {
  return {
    runningVersion: '0.3.81',
    installedVersion: '0.3.81',
    latestVersion: '0.3.81',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

function rowOf(overrides = {}) {
  return {
    key: 'bill',
    title: '饼干记账',
    phase: 'installing',
    targetVersion: '0.3.81',
    restartRequired: false,
    error: null,
    snapshot: snapshotOf(),
    manual: null,
    queue: null,
    profileName: null,
    ...overrides,
  }
}

/** 未完成会话：一行在 installing（未终态）。 */
function unfinishedSession(updatedAt = 1) {
  return {
    version: 1,
    id: 's-242',
    selfKey: null,
    stopOnFailure: false,
    order: ['bill'],
    entries: [{ key: 'bill', phase: 'installing', requestId: 'batch:s-242:bill', targetVersion: '0.3.81', updatedAt }],
    createdAt: 1,
    updatedAt,
  }
}

/** 已收尾会话：各行全部终态。 */
function finishedSession(updatedAt = 2) {
  return {
    version: 1,
    id: 's-242',
    selfKey: null,
    stopOnFailure: false,
    order: ['bill'],
    entries: [{ key: 'bill', phase: 'done', requestId: 'batch:s-242:bill', targetVersion: '0.3.81', restartRequired: false, updatedAt }],
    createdAt: 1,
    updatedAt,
  }
}

function fakeContainer() {
  const listeners = new Map()
  return {
    innerHTML: '',
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((fn) => fn !== listener))
    },
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 按剧本给 batchStatus：前 `installingReplies` 回报在装，之后回报收尾。 */
function scriptedCall({ installingReplies = 1, rowsWhileInstalling, rowsDone, sessionWhileInstalling, sessionDone }) {
  const log = []
  let statusCalls = 0
  const call = async (name) => {
    log.push(name)
    if (name.endsWith('.batchStatus')) {
      statusCalls += 1
      const installing = statusCalls <= installingReplies
      return {
        ok: true,
        session: installing ? sessionWhileInstalling : sessionDone,
        rows: installing ? rowsWhileInstalling : rowsDone,
        progress: null,
      }
    }
    if (name.endsWith('.logAppend')) return { accepted: 0, dropped: 0 }
    throw new Error('unknown-phone:' + name)
  }
  return {
    call,
    log,
    statusCalls: () => statusCalls,
  }
}

test('#242：后台批量跑完后入口按钮自己刷回来（不需要用户再点/重挂载）', async () => {
  const script = scriptedCall({
    installingReplies: 1,
    rowsWhileInstalling: [rowOf({ phase: 'installing' })],
    rowsDone: [rowOf({ phase: 'done', restartRequired: false, snapshot: snapshotOf({ latestVersion: '0.3.81' }) })],
    sessionWhileInstalling: unfinishedSession(),
    sessionDone: finishedSession(),
  })
  const box = fakeContainer()
  const entry = mountUpdateBatchEntry(box, {
    prefix: 'life',
    call: script.call,
    autoCheck: 'mount',
    pollMs: MIN_POLL,
  })
  await wait(40)
  assert.equal(script.statusCalls(), 1, '挂载只该先查一次')
  assert.match(box.innerHTML, /正在安装/, '首帧读到在装 → 按钮说「正在安装…」')
  assert.doesNotMatch(box.innerHTML, /data-state="idle"/)

  // 200ms 不到两跳 → 等 700ms 足够 2-3 跳；宿主侧已收尾，入口件应自己刷回来。
  await wait(700)
  assert.ok(script.statusCalls() >= 2, '有未完成轮次时必须继续跟进刷新（实际 ' + script.statusCalls() + ' 次）')
  assert.doesNotMatch(box.innerHTML, /正在安装/, '批量结束后按钮不许永久停在「正在安装…」')
  // 注意：<style> 里也有 [data-state="busy"] 选择器，只能断元素属性，不能断裸字符串。
  assert.match(box.innerHTML, /class="dsh-upd-entry"[^>]*data-state="idle"/)
  entry.unmount()
})

test('#242：卸载后必须停掉后台跟进（不再打 batchStatus）', async () => {
  const script = scriptedCall({
    installingReplies: Infinity,
    rowsWhileInstalling: [rowOf({ phase: 'installing' })],
    rowsDone: [rowOf({ phase: 'done' })],
    sessionWhileInstalling: unfinishedSession(),
    sessionDone: finishedSession(),
  })
  const box = fakeContainer()
  const entry = mountUpdateBatchEntry(box, { prefix: 'life', call: script.call, autoCheck: 'mount', pollMs: MIN_POLL })
  await wait(40)
  assert.equal(script.statusCalls(), 1)
  entry.unmount()
  await wait(700)
  assert.equal(script.statusCalls(), 1, '卸载后不许再有后台定时器打宿主')
})

test('#242：已收尾状态下挂载不空转（只有那一次 status）', async () => {
  const script = scriptedCall({
    installingReplies: 0,
    rowsWhileInstalling: [rowOf({ phase: 'done' })],
    rowsDone: [rowOf({ phase: 'done' })],
    sessionWhileInstalling: finishedSession(),
    sessionDone: finishedSession(),
  })
  const box = fakeContainer()
  const entry = mountUpdateBatchEntry(box, { prefix: 'life', call: script.call, autoCheck: 'mount', pollMs: MIN_POLL })
  await wait(800)
  assert.equal(script.statusCalls(), 1, '没有未完成轮次就不该起后台跟进')
  entry.unmount()
})

test('#242：后台跟进只打只读 status，绝不触发安装电话', async () => {
  const script = scriptedCall({
    installingReplies: 1,
    rowsWhileInstalling: [rowOf({ phase: 'installing' })],
    rowsDone: [rowOf({ phase: 'done' })],
    sessionWhileInstalling: unfinishedSession(),
    sessionDone: finishedSession(),
  })
  const box = fakeContainer()
  const entry = mountUpdateBatchEntry(box, { prefix: 'life', call: script.call, autoCheck: 'mount', pollMs: MIN_POLL })
  await wait(700)
  assert.deepEqual(
    script.log.filter((name) => !name.endsWith('.batchStatus') && !name.endsWith('.logAppend')),
    [],
    '后台跟进只许读状态：' + JSON.stringify(script.log),
  )
  entry.unmount()
})
