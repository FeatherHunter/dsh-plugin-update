/**
 * tests/hub-bad-plan.test.mjs —— #246 第 7/8 项：坏方案（hub plans）的电话层与自愈行为。
 *
 * 口径全部来自 ADR / 票面：
 *   #7 坏方案电话层：plans 目录里放损坏 JSON / 非法字段 / 非法属主的方案，批量 install 电话
 *      不抛错、正常返回并正常装完；hub 状态电话同样不被坏文件带病。
 *   #8 坏方案自愈：读不出来当没写过（读坏当没有），本次 submit 会写回一份合法新方案；
 *      非法属主（不安全字符/不匹配的属主）不被接管、不被当成「有人正忙」。
 *
 * L101「同案内容不变不重复写盘」已由 tests/hub-single-writer.test.mjs 覆盖（sameHubPlan），
 * 这里不重复。只用公共入口（dist/host-batch.js + dist/host/hub/plan-store.js）+ 真临时目录。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createMultiHostUpdate } from '../dist/host-batch.js'
import { hubPathsForUpdate, readHubPlan, readHubPlans } from '../dist/host/hub/plan-store.js'
import { __resetHubRegistryForTests } from '../dist/host/hub/registry.js'
import { mkScope, mkTarget, phaseOf, unbindAll } from './helpers/batch-log-harness.mjs'
import { fakeClock, makeHubDeps } from './helpers/hub-harness.mjs'

beforeEach(() => {
  __resetHubRegistryForTests()
})

/** 一份字段齐全的合法方案（坏方案用例的对照组 / 别人家的方案）。 */
function planPayload(overrides = {}) {
  return {
    version: 1,
    sessionId: 'other-session',
    owner: 'other',
    selfKey: null,
    selfOrder: 'last',
    stopOnFailure: false,
    targets: [{ key: 'x', title: 'x', packageName: 'pkg-x', pluginId: 'plugin-x', prefix: 'p-x' }],
    scope: { homeDir: '/tmp/hub-scope-home', profileDir: '/tmp/hub-scope-profile', profileName: 'web' },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** 在真中枢 plans 目录里手写一份文件（坏方案都是这么进去的：外部残留/半写/旧版本）。 */
async function seedPlanFile(scope, name, content) {
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  assert.ok(paths, '真临时目录能派生出中枢路径')
  await mkdir(paths.plansDir, { recursive: true })
  await writeFile(join(paths.plansDir, name), content, 'utf8')
  return paths
}

function countingTransport() {
  const installs = []
  return {
    installs,
    transport: {
      check: async () => ({ kind: 'update', version: '2.0.0' }),
      install: async (key) => {
        installs.push(key)
        return { kind: 'done', restartRequired: false }
      },
    },
  }
}

function installHost(scope, clock, transport) {
  return createMultiHostUpdate(makeHubDeps(scope, clock, transport), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
}

test('#7 坏方案电话层：plans 里的损坏 JSON/非法字段不让批量 install 抛错，装完并写回合法方案', async () => {
  const { scope } = await mkScope('hub-bad-plan-phone-')
  const clock = fakeClock()
  // 三种坏法一起放：损坏 JSON、版本不对、字段非法（sessionId 不是字符串、没有 targets/scope）。
  const paths = await seedPlanFile(scope, 'corrupt.json', '{ "version": 1, "owner": "life"')
  await seedPlanFile(scope, 'life.json', JSON.stringify({ version: 1, sessionId: 42, owner: 'life' }))
  await seedPlanFile(scope, 'future.json', JSON.stringify(planPayload({ version: 2, owner: 'future' })))
  // 读盘口径本身就是「读坏当没有」：这些文件不该被当成合法方案。
  assert.deepEqual(await readHubPlans(paths), [], '坏方案全部跳过（坏文件不能变成合法方案）')

  const { transport, installs } = countingTransport()
  const host = installHost(scope, clock, transport)
  try {
    // 状态电话先答一次：坏文件只影响读方案的人，不该让电话抛错。
    const status = await host.handlers['life.updateHubStatus']({})
    assert.equal(status.ok, true, '中枢状态电话遇坏方案不抛错、正常回')

    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true, '批量 install 电话正常返回')
    assert.equal(phaseOf(reply.session, 'a'), 'done', '坏方案没挡住本次安装，目标正常装完')
    assert.deepEqual(installs, ['a'], '该装的就是装一次（坏方案不被误认领）')

    // 本次 submit 写回自己的合法方案（坏 lives.json 被原子整写覆盖是自愈，不是删除别人的文件）。
    const plan = await readHubPlan(paths, 'life')
    assert.ok(plan, '本次提交后 life 的方案可读（自愈写回）')
    assert.equal(plan.owner, 'life')
    assert.equal(plan.sessionId, reply.session.id, '写回的方案指向本次会话')
    const rawCorrupt = await readFile(join(paths.plansDir, 'corrupt.json'), 'utf8')
    assert.equal(rawCorrupt, '{ "version": 1, "owner": "life"', '别人的坏文件原样保留（只跳过，不删）')
  } finally {
    host.dispose()
    unbindAll()
  }
})

test('#8 坏方案自愈：坏掉的 life 方案当没写过，下一次 submit 写一份新的并正常装', async () => {
  const { scope } = await mkScope('hub-bad-plan-heal-')
  const clock = fakeClock()
  const paths = await seedPlanFile(scope, 'life.json', '这不是 JSON，是一份半写坏文件')
  assert.equal(await readHubPlan(paths, 'life'), null, '坏掉的属主方案读出来就是没有')

  const { transport, installs } = countingTransport()
  const host = installHost(scope, clock, transport)
  try {
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, 'a'), 'done', '坏方案没有把本次装卡在 queued/接管失败')
    assert.deepEqual(installs, ['a'])

    const plan = await readHubPlan(paths, 'life')
    assert.ok(plan, '后续 submit 写了新方案（坏方案不当遗留挡住自愈）')
    assert.equal(plan.sessionId, reply.session.id, '新方案对得上本次会话')
    const raw = JSON.parse(await readFile(join(paths.plansDir, 'life.json'), 'utf8'))
    assert.equal(raw.owner, 'life', '盘上的文件已是可解析的合法方案（读坏当没有 + 写回）')
  } finally {
    host.dispose()
    unbindAll()
  }
})

test('#8 非法属主：不安全属主/不匹配属主的方案不被接管、不被当成有人正忙', async () => {
  const { scope } = await mkScope('hub-bad-plan-owner-')
  const clock = fakeClock()
  // 文件名安全但内容属主不安全：normalize 读坏当没有。
  const paths = await seedPlanFile(
    scope,
    'bad-owner.json',
    JSON.stringify(planPayload({ owner: 'bad owner!', sessionId: 'ghost-session' })),
  )
  // 合法方案但属主是别人（other）：不该被 life 的批量安装接管，也不该让 life 变忙。
  const otherPlan = JSON.stringify(planPayload({ owner: 'other', sessionId: 'other-session' }), null, 2)
  await seedPlanFile(scope, 'other.json', otherPlan)

  const plans = await readHubPlans(paths)
  assert.deepEqual(
    plans.map((plan) => plan.owner),
    ['other'],
    '不安全属主的方案被丢掉；别人家的合法方案留下（但不该被 life 接管）',
  )
  assert.equal(await readHubPlan(paths, 'life'), null, '没有可接管的 life 方案')

  const { transport, installs } = countingTransport()
  const host = installHost(scope, clock, transport)
  try {
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, 'a'), 'done', '非法属主方案没让 life 被误判成忙碌（不排 queued、不干等）')
    assert.deepEqual(installs, ['a'], '安装照常发生一次')

    const lifePlan = await readHubPlan(paths, 'life')
    assert.ok(lifePlan, 'life 自己的新方案写上了')
    assert.equal(lifePlan.owner, 'life')
    // 别人家的方案原样保留（不接管、不改写）。
    assert.equal(await readFile(join(paths.plansDir, 'other.json'), 'utf8'), otherPlan, '别人的方案没被改写')
  } finally {
    host.dispose()
    unbindAll()
  }
})
