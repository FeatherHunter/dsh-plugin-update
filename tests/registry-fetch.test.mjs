import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as service from '../dist/service.js'
import * as rf from '../dist/registry-fetch.js'

const FACE = [
  'fetchNpmRelease',
  'fetchNpmVersionRelease',
  'fetchPackumentTimes',
  'PACKAGE_NAME',
  'NPM_REGISTRY',
  'CHECK_TIMEOUT_MS',
  'MAX_METADATA_BYTES',
  'INTEGRITY_PATTERN',
]

test('#163 registry 垫片：service 老位置仍是同一份（同一引用），检查结论仍在 service', () => {
  for (const name of FACE) assert.equal(service[name], rf[name], name)
  assert.equal(typeof service.createUpdateCore, 'function')
  assert.equal(rf.createUpdateCore, undefined, '检查结论是 service 的本体，不进 registry')
})

const doc = (body, { ok = true, status = 200 } = {}) => async () => ({
  ok,
  status,
  headers: { get: () => String(JSON.stringify(body).length) },
  text: async () => JSON.stringify(body),
})

const PKG = 'dsh-mattpocock-skills-deck'
const goodRelease = {
  name: PKG,
  version: '1.2.3',
  engines: { node: '>=18' },
  dist: {
    tarball: `https://registry.npmjs.org/${PKG}/-/${PKG}-1.2.3.tgz`,
    integrity: `sha512-${'A'.repeat(86)}==`,
  },
}

test('#163 registry 语义抽查：正常文档收发行信息，名字对不上判无效', async () => {
  const release = await rf.fetchNpmRelease(doc(goodRelease), 1000)
  assert.equal(release.version, '1.2.3')
  assert.equal(release.nodeRange, '>=18')
  await assert.rejects(rf.fetchNpmRelease(doc({ ...goodRelease, name: '别人家的包' }), 1000), /invalid-release/)
})

test('#163 registry 语义抽查：连不上判检查失败并带状态，时间表收 latest＋time', async () => {
  const err = await rf.fetchNpmRelease(doc({}, { ok: false, status: 503 }), 1000).catch((e) => e)
  assert.equal(err.code, 'check-failed')
  assert.equal(err.httpStatus, 503)
  const packument = await rf.fetchPackumentTimes(
    doc({ name: PKG, 'dist-tags': { latest: '1.2.3' }, time: { '1.2.3': '2026-01-02T00:00:00.000Z', 坏条目: 1 } }),
    1000,
  )
  assert.equal(packument.latest, '1.2.3')
  assert.ok(packument.times['1.2.3'] > 0)
})
