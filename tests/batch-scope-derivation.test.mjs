/**
 * tests/batch-scope-derivation.test.mjs —— #266 真机暴露的「批量使用范围不反推」回归。
 *
 * 现象（真机 c 场景 266-20261102T002823 原始证据）：集成方按 README 只传 { ctx, logCtx }
 * 接批量，隔离 home 下只有 update-queue/<指纹>/queue.json，没有 batch.json / inventory.json /
 * hub/plans/<属主>.json —— 因为 batchHome/batchProfile 当时只认显式 scope/readerOverrides，
 * 会话退化成内存账本、中枢写不出方案（面板行态重启即失）。
 *
 * 本文件钉住修法：createMultiHostUpdate 的 (homeDir, profileDir) 与单宿主同口径——
 * 显式 scope/readerOverrides → ctx 权威身份（profileContext）→ 显式 env（DSH_PROFILE_DIR）→ 不猜。
 * 反向断言：取不到身份时行为与修复前一致（不落盘、不登记全局进度电话），绝不伪造路径。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { batchPathsForOwner } from '../dist/core/disk.js'
import { hubPathsForUpdate } from '../dist/host/hub/plan-store.js'

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

/** 一个像真机布局的临时使用范围：home/profiles/desktop。 */
async function tempLayout() {
  const homeDir = await mkdtemp(join(tmpdir(), 'batch-scope-'))
  const profileDir = join(homeDir, 'profiles', 'desktop')
  await mkdir(profileDir, { recursive: true })
  return { homeDir, profileDir }
}

/** DSH 在插件挂载前 provide('profileContext', { name, dir }) 的等价假件。 */
function contextWith(profileDir) {
  return {
    get(name) {
      return name === 'profileContext' ? { name: 'desktop', dir: profileDir } : undefined
    },
  }
}

/** 假传输：查得到 0.0.2，装即成功（本测试只关心落盘范围，不关心传输细节）。 */
function fakeTransport() {
  return {
    check: async () => ({ kind: 'update', version: '0.0.2' }),
    install: async () => ({ kind: 'done', restartRequired: false }),
  }
}

function makeHost(deps) {
  return createMultiHostUpdate(deps, {
    prefix: 'fxa',
    targets: [
      { key: 'a', title: '夹具 A', packageName: 'dsh-plugin-update-fixture-a', prefix: 'fxa-a' },
      { key: 'c', title: '夹具 C', packageName: 'dsh-plugin-update-fixture-c', prefix: 'fxa-c' },
    ],
    transport: fakeTransport(),
  })
}

describe('#266 批量使用范围反推（只传 { ctx, logCtx } 的真机接线）', () => {
  it('ctx.profileContext 权威身份 → 账本/知识与中枢方案都落到该使用范围', async () => {
    const { homeDir, profileDir } = await tempLayout()
    // 真机的家目录来自启动器注入的 DSH_HOME（本测试进程可能带着宿主的 DSH_HOME，必须先隔离到临时家）。
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = homeDir
    const host = makeHost({ ctx: contextWith(profileDir), logCtx: null })
    try {
      // 「识别得出使用范围才登记只读全局进度电话」本身就是范围已解析的对外信号（#250）。
      assert.equal(host.phoneNames.hubStatus, 'fxa.updateHubStatus')

      const checked = await host.handlers['fxa.batchCheck']()
      assert.equal(checked.ok, true)
      const ownerPaths = batchPathsForOwner(homeDir, profileDir, 'fxa')
      assert.ok(ownerPaths, '使用范围可派生')
      assert.equal(existsSync(ownerPaths.inventoryFile), true, 'check 的知识账本落到反推出的使用范围')

      const installed = await host.handlers['fxa.batchInstall']({})
      assert.equal(installed.ok, true)
      const sessionPaths = batchPathsForOwner(homeDir, profileDir, 'fxa')
      assert.ok(sessionPaths, '批量账本路径可派生')
      assert.equal(existsSync(sessionPaths.batchFile), true, '批量会话账本落到反推出的使用范围')

      const hubPaths = hubPathsForUpdate(homeDir, profileDir)
      assert.ok(hubPaths, '中枢路径可派生')
      assert.equal(existsSync(join(hubPaths.plansDir, 'fxa.json')), true, '中枢方案落到反推出的使用范围')
    } finally {
      host.dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('显式 env（DSH_HOME + DSH_PROFILE_DIR）也能反推使用范围', async () => {
    const { homeDir, profileDir } = await tempLayout()
    const host = makeHost({
      ctx: null,
      readerOverrides: { env: { DSH_HOME: homeDir, DSH_PROFILE_DIR: profileDir, DSH_PROFILE: 'desktop' } },
      logCtx: null,
    })
    try {
      assert.equal(host.phoneNames.hubStatus, 'fxa.updateHubStatus')
      const installed = await host.handlers['fxa.batchInstall']({})
      assert.equal(installed.ok, true)
      const sessionPaths = batchPathsForOwner(homeDir, profileDir, 'fxa')
      assert.ok(sessionPaths)
      assert.equal(existsSync(sessionPaths.batchFile), true, 'env 注入的 profile 目录同样能落账本')
    } finally {
      host.dispose()
    }
  })

  it('取不到身份时行为与修复前一致：不落盘、不登记全局进度电话（不伪造路径）', async () => {
    const { homeDir } = await tempLayout()
    const host = makeHost({
      ctx: null,
      // 只给家目录、不给 profile 身份：范围解析必须诚实地停在「不可落盘」。
      readerOverrides: { env: { DSH_HOME: homeDir } },
      logCtx: null,
    })
    try {
      assert.equal(host.phoneNames.hubStatus, undefined, '不猜路径，也就不登记全局进度电话')
      await host.handlers['fxa.batchCheck']()
      await host.handlers['fxa.batchInstall']({})
      assert.equal(existsSync(join(homeDir, 'update-queue')), false, '没有使用范围就不落盘（内存账本）')
    } finally {
      host.dispose()
    }
  })
})
