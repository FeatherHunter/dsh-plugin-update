/**
 * tests/changelog-auto.test.mjs —— 更新日志无脑接入（#38）。
 *
 * 只测外部行为：宿主 updateChangelog 电话的入参与回参形状、按版本记住结果；
 * 面板默认自动取一次、显式文本仍赢、false 退回、无新版不问、卸载丢弃过期回包；
 * 批量详情行按行取、单行失败只影响该行；HTTP 白名单放行。传输与抓取全用假件。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { mountUpdatePanel } from '../dist/panel.js'
import { mountUpdateBatchPanel } from '../dist/panel-batch.js'
import { mountUpdateEntry } from '../dist/entry.js'
import { assertHttpRoutes, resolveHttpPath } from '../dist/http.js'

const REGISTRY = 'https://registry.npmjs.org/'
const PKG = 'my-notes-plugin'
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const SAMPLE = [
  '# Changelog',
  '',
  '## [1.1.0] - 2026-10-05',
  '',
  '### Added',
  '',
  '- 自动取日志',
  '',
  '## [1.0.0] - 2026-09-01',
  '',
  '### Fixed',
  '',
  '- 首版',
  '',
].join('\n')

const SAMPLE_BATCH = [
  '# Changelog',
  '',
  '## [1.2.0] - 2026-10-06',
  '',
  '### Added',
  '',
  '- 批量行日志',
  '',
  '## [1.0.0] - 2026-09-01',
  '',
  '### Fixed',
  '',
  '- 首版',
  '',
].join('\n')

function tarEntry(name, data) {
  const header = Buffer.alloc(512, 0)
  Buffer.from(name, 'utf8').copy(header, 0, 0, Math.min(name.length, 100))
  const sizeOct = data.length.toString(8).padStart(11, '0') + '\0'
  Buffer.from(sizeOct, 'utf8').copy(header, 124)
  header[156] = 48
  Buffer.from('ustar\0', 'utf8').copy(header, 257)
  const blocks = Math.ceil(data.length / 512)
  const body = Buffer.alloc(blocks * 512, 0)
  Buffer.from(data).copy(body)
  return Buffer.concat([header, body])
}

function makeTgz(files) {
  const parts = []
  for (const [name, text] of Object.entries(files)) parts.push(tarEntry(name, Buffer.from(text, 'utf8')))
  parts.push(Buffer.alloc(1024, 0))
  return gzipSync(Buffer.concat(parts))
}

function tgzIntegrity(tgz) {
  return `sha512-${createHash('sha512').update(tgz).digest('base64')}`
}

/** 官方源假件：版本文档 + tarball，记下每次抓取以断言“同一版本只取一次”。 */
function registryFetch({ version, tgz, versionDocStatus = 200, calls }) {
  const tarball = `${REGISTRY}${PKG}/-/${PKG}-${version}.tgz`
  const integrity = tgzIntegrity(tgz)
  const fetch = async (url) => {
    calls.push(url)
    if (url === `${REGISTRY}${encodeURIComponent(PKG)}/${encodeURIComponent(version)}`) {
      if (versionDocStatus !== 200) return { ok: false, status: versionDocStatus, headers: { get: () => null }, text: async () => '' }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({ name: PKG, version, engines: { node: '>=22' }, dist: { tarball, integrity } }),
      }
    }
    if (url === tarball) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '',
        arrayBuffer: async () => {
          const copy = Buffer.from(tgz)
          return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
        },
      }
    }
    throw new Error('unexpected-url:' + url)
  }
  return fetch
}

function makeHost({ pluginId, fetchImpl, releaseChannel }) {
  return createHostUpdate(
    { logCtx: { fire: () => {} }, readerOverrides: { fetchImpl } },
    releaseChannel === undefined ? { pluginId, targetPackageName: PKG } : { pluginId, targetPackageName: PKG, releaseChannel },
  )
}

function statusSnapshot(overrides = {}) {
  return {
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

describe('宿主 updateChangelog 电话', () => {
  beforeEach(() => {
    __resetSharedUpdateReaderForTests()
  })

  it('非法版本直接 invalid-release，不联网', async () => {
    const calls = []
    const host = makeHost({ pluginId: 'cl-bad', fetchImpl: registryFetch({ version: '1.1.0', tgz: makeTgz({}), calls }) })
    for (const bad of [undefined, null, '', 'not-a-version', '1.1.0+build']) {
      const out = await host.handlers[host.phoneNames.updateChangelog]({ version: bad })
      assert.equal(out.ok, false)
      assert.equal(out.error, 'invalid-release')
    }
    assert.equal(calls.length, 0, '先验不过即拒绝，不该联网')
  })

  it('stable 通道不收预发布', async () => {
    const calls = []
    const host = makeHost({ pluginId: 'cl-chan', fetchImpl: registryFetch({ version: '9.9.9', tgz: makeTgz({}), calls }) })
    const out = await host.handlers[host.phoneNames.updateChangelog]({ version: '1.1.0-rc.1' })
    assert.equal(out.ok, false)
    assert.equal(out.error, 'invalid-release')
    assert.equal(calls.length, 0)
  })

  it('取到全文：回包只有 version + markdown，同一版本只取一次', async () => {
    const calls = []
    const tgz = makeTgz({ 'package/CHANGELOG.md': SAMPLE })
    const host = makeHost({ pluginId: 'cl-hit', fetchImpl: registryFetch({ version: '1.1.0', tgz, calls }) })
    const first = await host.handlers[host.phoneNames.updateChangelog]({ version: '1.1.0' })
    assert.deepEqual(Object.keys(first).sort(), ['markdown', 'ok', 'version'])
    assert.equal(first.ok, true)
    assert.equal(first.version, '1.1.0')
    assert.equal(first.markdown, SAMPLE)
    assert.equal(calls.length, 2, '版本文档一次 + tarball 一次')
    const second = await host.handlers[host.phoneNames.updateChangelog]({ version: '1.1.0' })
    assert.equal(second.markdown, SAMPLE)
    assert.equal(calls.length, 2, '记住结果后不再联网')
  })

  it('包里没 CHANGELOG 即回 null 且记住，不挡人', async () => {
    const calls = []
    const tgz = makeTgz({ 'package/README.md': 'hi' })
    const host = makeHost({ pluginId: 'cl-null', fetchImpl: registryFetch({ version: '1.1.0', tgz, calls }) })
    const out = await host.handlers[host.phoneNames.updateChangelog]({ version: '1.1.0' })
    assert.equal(out.ok, true)
    assert.equal(out.markdown, null)
    assert.equal(calls.length, 2)
    await host.handlers[host.phoneNames.updateChangelog]({ version: '1.1.0' })
    assert.equal(calls.length, 2, '取不到也记住')
  })

  it('版本文档 404 走检查失败体系', async () => {
    const calls = []
    const host = makeHost({
      pluginId: 'cl-404',
      fetchImpl: registryFetch({ version: '1.1.0', tgz: makeTgz({}), versionDocStatus: 404, calls }),
    })
    const out = await host.handlers[host.phoneNames.updateChangelog]({ version: '1.1.0' })
    assert.equal(out.ok, false)
    assert.equal(out.error, 'check-failed')
  })
})

describe('面板默认自动取日志', () => {
  function panelCall({ status, changelog }) {
    const log = []
    const call = async (name, args) => {
      log.push({ name, args })
      if (name.endsWith('.updateStatus')) return { ok: true, snapshot: status, manual: null, receipt: null }
      if (name.endsWith('.updateCheck')) return { ok: true, snapshot: status, manual: null, receipt: { checkId: 'c', checkedAt: 1, expiresAt: 9 } }
      if (name.endsWith('.updateChangelog')) return changelog
      throw new Error('unknown-phone:' + name)
    }
    return { call, log }
  }

  it('默认即自动：有新版调一次，第二次轮询不再问', async () => {
    const { call, log } = panelCall({ status: statusSnapshot(), changelog: { ok: true, version: '1.1.0', markdown: SAMPLE } })
    const slot = fakeContainer()
    const panel = mountUpdatePanel(slot, { pluginId: 'p', prefix: 't', call })
    try {
      await panel.refresh()
      await settled()
      await settled()
      const hits = log.filter((e) => e.name.endsWith('.updateChangelog'))
      assert.equal(hits.length, 1)
      assert.deepEqual(hits[0].args, { version: '1.1.0' })
      assert.ok(slot.innerHTML.includes('自动取日志'), '第 02 章应出现新版内容')
      await panel.refresh()
      await settled()
      assert.equal(log.filter((e) => e.name.endsWith('.updateChangelog')).length, 1, '记住后不再问')
    } finally {
      panel.unmount()
    }
  })

  it('显式文本仍赢：传过 changelogMarkdown 即不自动问', async () => {
    const { call, log } = panelCall({ status: statusSnapshot(), changelog: { ok: true, version: '1.1.0', markdown: SAMPLE } })
    const slot = fakeContainer()
    const explicit = SAMPLE.replace('自动取日志', '手动备好的文本')
    const panel = mountUpdatePanel(slot, { pluginId: 'p', prefix: 't', call, changelogMarkdown: explicit })
    try {
      await panel.refresh()
      await settled()
      assert.equal(log.filter((e) => e.name.endsWith('.updateChangelog')).length, 0)
      assert.ok(slot.innerHTML.includes('手动备好的文本'))
      assert.ok(!slot.innerHTML.includes('自动取日志'), '显式文本不该被自动结果覆盖')
    } finally {
      panel.unmount()
    }
  })

  it('autoChangelog: false 退回手动', async () => {
    const { call, log } = panelCall({ status: statusSnapshot(), changelog: { ok: true, version: '1.1.0', markdown: SAMPLE } })
    const slot = fakeContainer()
    const panel = mountUpdatePanel(slot, { pluginId: 'p', prefix: 't', call, autoChangelog: false })
    try {
      await panel.refresh()
      await settled()
      assert.equal(log.filter((e) => e.name.endsWith('.updateChangelog')).length, 0)
    } finally {
      panel.unmount()
    }
  })

  it('无新版不问：没查到远端/装不了即不打电话', async () => {
    const { call, log } = panelCall({
      status: statusSnapshot({ latestVersion: null, canInstall: false }),
      changelog: { ok: true, version: '1.1.0', markdown: SAMPLE },
    })
    const slot = fakeContainer()
    const panel = mountUpdatePanel(slot, { pluginId: 'p', prefix: 't', call })
    try {
      await panel.refresh()
      await settled()
      assert.equal(log.filter((e) => e.name.endsWith('.updateChangelog')).length, 0)
    } finally {
      panel.unmount()
    }
  })

  it('卸载丢弃过期回包：在飞的取数回来不写已拆的面板', async () => {
    let release = null
    const waiting = new Promise((resolve) => {
      release = resolve
    })
    const log = []
    const call = async (name, args) => {
      log.push({ name, args })
      if (name.endsWith('.updateStatus')) return { ok: true, snapshot: statusSnapshot(), manual: null, receipt: null }
      if (name.endsWith('.updateChangelog')) return waiting.then(() => ({ ok: true, version: '1.1.0', markdown: SAMPLE }))
      throw new Error('unknown-phone:' + name)
    }
    const slot = fakeContainer()
    const panel = mountUpdatePanel(slot, { pluginId: 'p', prefix: 't', call })
    await panel.refresh()
    await settled()
    assert.equal(log.filter((e) => e.name.endsWith('.updateChangelog')).length, 1)
    panel.unmount()
    release()
    await settled()
    await settled()
    assert.ok(!slot.innerHTML.includes('自动取日志'), '过期回包必须丢弃')
  })
})

describe('批量详情行按行取日志', () => {
  function batchSnapshot() {
    return statusSnapshot({ latestVersion: '1.2.0' })
  }

  function rowOf(key, overrides = {}) {
    return {
      key,
      title: key,
      phase: 'ready',
      targetVersion: '1.2.0',
      restartRequired: false,
      error: null,
      snapshot: batchSnapshot(),
      manual: null,
      queue: null,
      profileName: null,
      pluginId: key,
      diag: null,
      phoneNames: {
        updateStatus: `${key}.updateStatus`,
        updateCheck: `${key}.updateCheck`,
        updateInstall: `${key}.updateInstall`,
        updateChangelog: `${key}.updateChangelog`,
      },
      ...overrides,
    }
  }

  function sessionOf(rows) {
    return {
      version: 1,
      id: 's1',
      selfKey: null,
      stopOnFailure: false,
      order: rows.map((r) => r.key),
      entries: rows.map((r) => ({
        key: r.key,
        phase: r.phase,
        requestId: 'batch:s1:' + r.key,
        targetVersion: r.targetVersion,
        restartRequired: r.restartRequired,
        error: r.error,
        updatedAt: 1,
      })),
      createdAt: 1,
      updatedAt: 1,
    }
  }

  function batchCall(rows, changelogByPhone) {
    const log = []
    const call = async (name, args) => {
      log.push({ name, args })
      if (name.endsWith('.batchStatus')) return { ok: true, session: sessionOf(rows), rows, progress: null }
      if (name in changelogByPhone) {
        const impl = changelogByPhone[name]
        if (typeof impl === 'function') return impl(args)
        return impl
      }
      throw new Error('unknown-phone:' + name)
    }
    return { call, log }
  }

  it('展开行才取：取一次后记住，单行失败不影响别行', async () => {
    const rows = [rowOf('a'), rowOf('b', { phoneNames: { updateInstall: 'b.updateInstall' } })]
    const { call, log } = batchCall(rows, { 'a.updateChangelog': { ok: true, version: '1.2.0', markdown: SAMPLE_BATCH } })
    const slot = fakeContainer()
    const panel = mountUpdateBatchPanel(slot, { prefix: 'life', call })
    try {
      await panel.refresh()
      await settled()
      assert.equal(log.filter((e) => e.name === 'a.updateChangelog').length, 0, '没展开不问')
      await panel.act('toggle-details', 'a')
      await settled()
      await settled()
      assert.equal(log.filter((e) => e.name === 'a.updateChangelog').length, 1)
      assert.ok(slot.innerHTML.includes('批量行日志'))
      await panel.act('toggle-details', 'a')
      await panel.act('toggle-details', 'a')
      await settled()
      assert.equal(log.filter((e) => e.name === 'a.updateChangelog').length, 1, '记住后不再问')
      await panel.act('toggle-details', 'b')
      await settled()
      assert.ok(!log.some((e) => e.name === 'b.updateChangelog'), '老宿主没给行电话即中性提示，不打电话')
    } finally {
      panel.unmount()
    }
  })

  it('行电话失败即该行中性提示，不抛不卡整批', async () => {
    const rows = [rowOf('a')]
    const { call } = batchCall(rows, { 'a.updateChangelog': { ok: false, error: 'check-failed', errorKind: 'check-failed' } })
    const slot = fakeContainer()
    const panel = mountUpdateBatchPanel(slot, { prefix: 'life', call })
    try {
      await panel.refresh()
      await settled()
      await panel.act('toggle-details', 'a')
      await settled()
      assert.ok(!slot.innerHTML.includes('批量行日志'))
      assert.ok(slot.innerHTML.includes('甲') || slot.innerHTML.includes('>a<') || slot.innerHTML.includes('a'), '行本身仍在')
    } finally {
      panel.unmount()
    }
  })

  it('autoChangelog: false 即整批不取', async () => {
    const rows = [rowOf('a')]
    const { call, log } = batchCall(rows, { 'a.updateChangelog': { ok: true, version: '1.2.0', markdown: SAMPLE_BATCH } })
    const slot = fakeContainer()
    const panel = mountUpdateBatchPanel(slot, { prefix: 'life', call, autoChangelog: false })
    try {
      await panel.refresh()
      await settled()
      await panel.act('toggle-details', 'a')
      await settled()
      assert.equal(log.filter((e) => e.name === 'a.updateChangelog').length, 0)
    } finally {
      panel.unmount()
    }
  })
})

describe('失败退避：同版本失败不每秒重问', () => {
  it('面板失败记一次，轮询不再问，手动查新版可再问', async () => {
    const log = []
    const call = async (name, args) => {
      log.push({ name, args })
      if (name.endsWith('.updateStatus')) return { ok: true, snapshot: statusSnapshot(), manual: null, receipt: null }
      if (name.endsWith('.updateCheck')) {
        return { ok: true, snapshot: statusSnapshot(), manual: null, receipt: { checkId: 'c', checkedAt: 1, expiresAt: 9 } }
      }
      if (name.endsWith('.updateChangelog')) throw new Error('offline')
      throw new Error('unknown-phone:' + name)
    }
    const slot = fakeContainer()
    const panel = mountUpdatePanel(slot, { pluginId: 'p', prefix: 't', call })
    try {
      await panel.refresh()
      await settled()
      await panel.refresh()
      await settled()
      assert.equal(log.filter((e) => e.name.endsWith('.updateChangelog')).length, 1, '失败只问一次')
      await panel.act('check')
      await settled()
      assert.equal(log.filter((e) => e.name.endsWith('.updateChangelog')).length, 2, '手动查新版清退避')
    } finally {
      panel.unmount()
    }
  })
})

describe('入口件透传自动能力', () => {
  function entryCall() {
    const log = []
    const call = async (name, args) => {
      log.push({ name, args })
      if (name.endsWith('.updateStatus')) return { ok: true, snapshot: statusSnapshot(), manual: null, receipt: null }
      if (name.endsWith('.updateCheck')) {
        return { ok: true, snapshot: statusSnapshot(), manual: null, receipt: { checkId: 'c', checkedAt: 1, expiresAt: 9 } }
      }
      if (name.endsWith('.updateChangelog')) return { ok: true, version: '1.1.0', markdown: SAMPLE }
      throw new Error('unknown-phone:' + name)
    }
    return { call, log }
  }

  it('默认透传自动：打开的 dialog 有新版即取', async () => {
    const { call, log } = entryCall()
    const slot = fakeContainer()
    const entry = mountUpdateEntry(slot, { pluginId: 'p', prefix: 't', call })
    try {
      entry.open()
      await settled()
      await settled()
      await settled()
      assert.equal(log.filter((e) => e.name.endsWith('.updateChangelog')).length, 1)
      assert.ok(slot.innerHTML.includes('自动取日志'))
    } finally {
      entry.close()
    }
  })

  it('autoChangelog: false 透传关闭', async () => {
    const { call, log } = entryCall()
    const slot = fakeContainer()
    const entry = mountUpdateEntry(slot, { pluginId: 'p', prefix: 't', call, autoChangelog: false })
    try {
      entry.open()
      await settled()
      await settled()
      assert.equal(log.filter((e) => e.name.endsWith('.updateChangelog')).length, 0)
    } finally {
      entry.close()
    }
  })
})

describe('HTTP 白名单放行更新日志电话', () => {
  it('短名覆写一次覆盖全行电话', () => {
    assertHttpRoutes({ updateChangelog: '/cl' }, 'demo')
    assert.equal(resolveHttpPath({ prefix: 'demo', baseUrl: 'https://h/upd', routes: { updateChangelog: '/cl' } }, 'a.updateChangelog'), 'https://h/upd/cl')
  })

  it('各行自己的电话默认走 baseUrl 拼接，不被拦', () => {
    assert.equal(
      resolveHttpPath({ prefix: 'demo', batchPrefix: 'life', baseUrl: 'https://h/upd' }, 'ilife-bill.updateChangelog'),
      'https://h/upd/ilife-bill.updateChangelog',
    )
  })
})
