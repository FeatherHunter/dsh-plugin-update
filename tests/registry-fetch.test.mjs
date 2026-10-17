import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as service from '../dist/service.js'
import * as rf from '../dist/registry-fetch.js'

const FACE = [
  'fetchNpmRelease',
  'fetchNpmVersionRelease',
  'fetchPackumentTimes',
  'fetchNpmChannelRelease',
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

// ---------- 对抗式审查（2026-10-17）回归：#R1 scoped 包 / #R3 包文档字节墙 / #R5 源地址归一 ----------

const SCOPED = '@xmanrui/dsh-im'
const goodScoped = {
  name: SCOPED,
  version: '4.39.0',
  engines: { node: '>=22' },
  dist: {
    // npm 对 scoped 包：路径最后一段与文件名都**不带** scope（真实 registry 实证）。
    tarball: 'https://registry.npmjs.org/@xmanrui/dsh-im/-/dsh-im-4.39.0.tgz',
    integrity: `sha512-${'B'.repeat(86)}==`,
  },
}

test('#R1 scoped 目标包：按 basename 判发行包地址，正常文档必须收', async () => {
  const release = await rf.fetchNpmRelease(doc(goodScoped), 1000, { targetPackageName: SCOPED })
  assert.equal(release.version, '4.39.0')
  assert.equal(release.nodeRange, '>=22')
  // 版本电话（changelog / 合规版候选）同一判据。
  const versionDoc = await rf.fetchNpmVersionRelease(doc(goodScoped), 1000, {
    targetPackageName: SCOPED,
    version: '4.39.0',
    releaseChannel: 'stable',
  })
  assert.equal(versionDoc.version, '4.39.0')
})

test('#R1 scoped 目标包：文件名里带 scope / 名字对不上，仍判无效', async () => {
  const withScopeInFile = {
    ...goodScoped,
    dist: { ...goodScoped.dist, tarball: 'https://registry.npmjs.org/@xmanrui/dsh-im/-/@xmanrui/dsh-im-4.39.0.tgz' },
  }
  await assert.rejects(rf.fetchNpmRelease(doc(withScopeInFile), 1000, { targetPackageName: SCOPED }), /invalid-release/)
  await assert.rejects(rf.fetchNpmRelease(doc({ ...goodScoped, name: 'dsh-im' }), 1000, { targetPackageName: SCOPED }), /invalid-release/)
})

test('#R5 源地址漏结尾斜杠：取数前归一，不能拼出 registry.npmjs.orgdsh-…', async () => {
  const seen = []
  const fetchImpl = (url) => {
    seen.push(url)
    return doc(goodScoped)()
  }
  await rf.fetchNpmRelease(fetchImpl, 1000, {
    targetPackageName: SCOPED,
    registryUrl: 'https://registry.npmjs.org',
  })
  assert.equal(seen[0], `https://registry.npmjs.org/${encodeURIComponent(SCOPED)}/latest`)
  // 带路径的私有源同理：补斜杠后仍保留原路径；发行包地址按「同源 + 路径后缀」判，
  // 镜像把包挂在 `/mirror/...` 下也必须是可用的（#R5b）。
  seen.length = 0
  const mirrored = {
    ...goodScoped,
    dist: { ...goodScoped.dist, tarball: 'https://npm.example.test/mirror/@xmanrui/dsh-im/-/dsh-im-4.39.0.tgz' },
  }
  await rf.fetchNpmRelease((url) => {
    seen.push(url)
    return doc(mirrored)()
  }, 1000, {
    targetPackageName: SCOPED,
    registryUrl: 'https://npm.example.test/mirror',
  })
  assert.equal(seen[0], `https://npm.example.test/mirror/${encodeURIComponent(SCOPED)}/latest`)
})

test('#R3 全量包文档：超过 256KB 但仍在包文档墙内必须收（真实包 314KB/458KB）', async () => {
  const big = {
    name: PKG,
    'dist-tags': { latest: '1.2.3' },
    time: { '1.2.3': '2026-01-02T00:00:00.000Z' },
    pad: 'x'.repeat(400 * 1024),
  }
  const packument = await rf.fetchPackumentTimes(doc(big), 1000)
  assert.equal(packument.latest, '1.2.3')
  // latest / 版本文档仍守 256KB：同一份大文档喂给 latest 口要判无效。
  await assert.rejects(rf.fetchNpmRelease(doc(big), 1000), /invalid-release/)
})

// ---------- #183：远端 latest 是预发布时，缺省拒绝 / 检查口容忍 ----------

const betaRelease = {
  ...goodRelease,
  version: '1.9.0-beta.2',
  dist: {
    tarball: `https://registry.npmjs.org/${PKG}/-/${PKG}-1.9.0-beta.2.tgz`,
    integrity: `sha512-${'C'.repeat(86)}==`,
  },
}

test('#183 通道外 latest：缺省仍按 invalid-release(stage=channel) 拒绝', async () => {
  const err = await rf.fetchNpmRelease(doc(betaRelease), 1000, { releaseChannel: 'stable' }).catch((e) => e)
  assert.equal(err.code, 'invalid-release')
  assert.equal(err.stage, 'channel')
})

test('#183 检查口容忍：tolerateOutOfChannel 原样交回，形状校验不放松', async () => {
  const release = await rf.fetchNpmRelease(doc(betaRelease), 1000, { releaseChannel: 'stable', tolerateOutOfChannel: true })
  assert.equal(release.version, '1.9.0-beta.2')
  // 容忍只对「通道不符」生效：版本形状坏掉、包地址对不上仍判无效。
  const garbage = { ...betaRelease, version: 'not-a-version' }
  await assert.rejects(rf.fetchNpmRelease(doc(garbage), 1000, { releaseChannel: 'stable', tolerateOutOfChannel: true }), /invalid-release/)
  const wrongTarball = { ...betaRelease, dist: { ...betaRelease.dist, tarball: `https://registry.npmjs.org/${PKG}/-/${PKG}-1.9.0-beta.1.tgz` } }
  await assert.rejects(rf.fetchNpmRelease(doc(wrongTarball), 1000, { releaseChannel: 'stable', tolerateOutOfChannel: true }), /invalid-release/)
})

// ---------- #183 剩余子项：全量包文档里找「本通道最新发行版」 ----------

const stableEntry = (version) => ({
  engines: { node: '>=22' },
  dist: {
    tarball: `https://registry.npmjs.org/${PKG}/-/${PKG}-${version}.tgz`,
    integrity: `sha512-${'D'.repeat(86)}==`,
  },
})

const packumentOf = (versions, name = PKG) => ({ name, 'dist-tags': { latest: '1.9.0-beta.2' }, versions })

test('#183 通道回退：只在通道允许的版本里挑最高发行版，预发布不算', async () => {
  const body = packumentOf({
    '1.2.1': stableEntry('1.2.1'),
    '1.3.0': stableEntry('1.3.0'),
    '1.9.0-beta.2': stableEntry('1.9.0-beta.2'),
    // 不合法版本号（SemVer 不允许 +build 参与发行版判定）：整条跳过。
    '2.0.0+build.1': { ...stableEntry('2.0.0'), dist: { ...stableEntry('2.0.0').dist, tarball: `https://registry.npmjs.org/${PKG}/-/${PKG}-2.0.0.tgz` } },
  })
  const release = await rf.fetchNpmChannelRelease(doc(body), 1000, { releaseChannel: 'stable' })
  assert.equal(release.version, '1.3.0')
  assert.equal(release.nodeRange, '>=22')
  assert.equal(release.dshRange, '*')
  // prerelease 通道同一份文档收得更高：不合法的版本号仍略过。
  const beta = await rf.fetchNpmChannelRelease(doc(body), 1000, { releaseChannel: 'prerelease' })
  assert.equal(beta.version, '1.9.0-beta.2')
})

test('#183 通道回退：坏条目逐条跳过，全坏才判版本信息无效（stage=channel）', async () => {
  const badOrigin = { dist: { tarball: 'https://evil.example.test/x.tgz', integrity: `sha512-${'A'.repeat(86)}==` } }
  const badIntegrity = { ...stableEntry('1.0.1'), dist: { ...stableEntry('1.0.1').dist, integrity: 'sha512-short==' } }
  const body = packumentOf({ '1.0.0': badOrigin, '1.0.1': badIntegrity, '1.0.2': stableEntry('1.0.2'), '1.0.3': { ...stableEntry('1.0.3'), deprecated: '这个版本已弃用' } })
  const release = await rf.fetchNpmChannelRelease(doc(body), 1000)
  assert.equal(release.version, '1.0.2', '坏条目与已弃用版本都跳过')
  // 一个通道内版本都没有 → 版本信息无效，阶段钉在 channel（与 latest 口同一口径）。
  const err = await rf.fetchNpmChannelRelease(doc(packumentOf({ '1.9.0-beta.2': stableEntry('1.9.0-beta.2') })), 1000).catch((e) => e)
  assert.equal(err.code, 'invalid-release')
  assert.equal(err.stage, 'channel')
})

test('#183 通道回退：名字对不上判无效，连不上判检查失败并带状态', async () => {
  await assert.rejects(
    rf.fetchNpmChannelRelease(doc(packumentOf({ '1.0.0': stableEntry('1.0.0') }, '别人家的包')), 1000),
    /invalid-release/,
  )
  const err = await rf.fetchNpmChannelRelease(doc({}, { ok: false, status: 503 }), 1000).catch((e) => e)
  assert.equal(err.code, 'check-failed')
  assert.equal(err.httpStatus, 503)
})
