/**
 * selftest/fixtures/generator/fixture-package-plan.test.ts —— 生成层 + 场景声明纯函数单测（无真机 IO）。
 *
 * 运行：node selftest/fixtures/generator/fixture-package-plan.test.ts
 * 这是工具层自测，不是根仓 hermetic 的 selftest 层；失败即抛（Node 非零退出）。
 *
 * #266 T2 新增的守护点（「版本化场景机制可复用」的廉价哨兵）：
 *   - 场景声明里的每个版本变体都能生成计划、且变更类别/效果与模板产物一致；
 *   - 变体效果确实改变产物（UI/行为），不是只改版本号；
 *   - 每条场景 id 在 coverage-matrix.md 里都有对应的矩阵行（加场景=加声明+加矩阵行，两边不许脱节）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURE_SLOT_A, FIXTURE_SLOT_B, FIXTURE_SLOT_C, FIXTURE_SLOT_PACKAGE_NAMES } from '../identity/fixture-slots.ts'
import { SCENARIOS } from '../identity/scenario-declarations.ts'
import { planFixturePackage, sourceFileOf } from './fixture-package-plan.ts'

let checked = 0
function assert(condition: unknown, message: string): void {
  checked += 1
  if (!condition) throw new Error('[fixtures 单测失败] ' + message)
}
function assertEqual(actual: unknown, expected: unknown, message: string): void {
  assert(actual === expected, message + '（actual=' + String(actual) + ' expected=' + String(expected) + '）')
}

const SUT = { name: 'dsh-plugin-update', version: '0.18.39' }

// 1) 三个席位都能生成计划；包名/pluginId 一致、清单形状固定；更新内核依赖按角色接线。
for (const slot of [FIXTURE_SLOT_A, FIXTURE_SLOT_B, FIXTURE_SLOT_C]) {
  const plan = planFixturePackage(slot, '0.0.1', SUT)
  assertEqual(plan.packageName, slot.packageName, 'plan.packageName = 席位包名')
  assertEqual(plan.dirName, slot.packageName + '-0.0.1', '目录名 = 包名-版本')
  assertEqual(plan.manifest.name, slot.packageName, 'manifest.name')
  assertEqual(plan.manifest.version, '0.0.1', 'manifest.version')
  if (slot.role === 'integrator') {
    assertEqual(plan.manifest.dependencies['dsh-plugin-update'], '0.18.39', '集成方依赖钉住更新内核版本')
  } else {
    assertEqual(Object.keys(plan.manifest.dependencies).length, 0, '纯目标不依赖更新内核（无更新接线）')
  }
  assertEqual(plan.manifest.dsh.client.platform, 'web', 'client.platform = web')
  assertEqual(plan.manifest.exports['./client'], './lib/client.js', '导出 ./client')
  assertEqual(plan.manifest.main, './lib/index.js', 'main 指 host 产物')
  assertEqual(plan.manifest.files.join(','), 'lib,cordis.patch.yml', 'files 只带产物与 patch')
  // 计划里落了一份具体 effect（发布器/场景/证据都按它走，模板不自己猜）。
  assertEqual(plan.effect.ui, 'single', '缺省 effect = T1 单面板布局')
}

// 2) 集成方 single 布局（T1 兼容）：host 引批量 API 并带自键/目标前缀；client 带 loader 常量与 self 前缀。
const planA = planFixturePackage(FIXTURE_SLOT_A, '0.0.2', SUT)
const hostA = sourceFileOf(planA, 'host-source').content
assert(hostA.includes("from 'dsh-plugin-update/batch'"), '集成方 host half 从 dsh-plugin-update/batch 引入批量 API')
assert(hostA.includes("prefix: 'fxa'"), '集成方 host half 用批量前缀 fxa')
assert(hostA.includes("selfKey: 'a'"), '集成方 host half 指定自键 a')
assert(hostA.includes("selfOrder: 'first'"), 'A 席位自更新排第一')
assert(hostA.includes("key: 'c'") && hostA.includes("prefix: 'fxa-c'"), 'A 的目标表含 C（前缀 fxa-c）')
assert(hostA.includes('behavior'), 'host half 回包带 behavior 字段（行为变化的后端凭据）')
assert(hostA.includes('buildTag'), 'host half 暴露 buildTag 电话（版本可见变化的后端凭据）')
const clientA = sourceFileOf(planA, 'client-source').content
assert(clientA.includes("const PREFIX = 'fxa-a'"), 'client half 用「自己」目标前缀 fxa-a')
assert(clientA.includes("require('dsh-plugin-update/panel')"), 'single 布局 client half 引入 panel')
assert(clientA.includes("require('dsh-plugin-update/entry')"), 'single 布局 client half 引入 entry')
assert(clientA.includes('mountUpdatePanel') && clientA.includes('mountUpdateEntry'), 'single 布局挂入口件+面板')
assert(clientA.includes("'shell.overlay'"), 'client half 挂 shell.overlay 常驻')
assert(clientA.includes('pointerEvents') && clientA.includes("'auto'"), '根节点 pointer-events:auto')
assert(clientA.includes('client v0.0.2'), 'client 构建标记随版本变化（真 UI 可见）')
assert(!clientA.includes('slotTitle') && !clientA.includes('TODO'), '生成源码里不残留模板占位符')

// 3) 纯目标：无批量 API、无更新接线（S2 已批准）；卡片写死 data-update-wiring="none"。
const planC = planFixturePackage(FIXTURE_SLOT_C, '0.0.1', SUT)
const hostC = sourceFileOf(planC, 'host-source').content
assert(!hostC.includes('createMultiHostUpdate'), '纯目标 host half 不接更新电话')
assert(!hostC.includes('mountUpdatePanel'), '纯目标不挂更新面板')
const clientC = sourceFileOf(planC, 'client-source').content
assert(clientC.includes('dsh-fixture-target'), '纯目标 client 有可识别的夹具标记')
assert(clientC.includes('client v0.0.1'), '纯目标 client 构建标记可见')
assert(clientC.includes("'data-update-wiring': 'none'"), '纯目标根节点声明无更新接线（场景 c 的断言点）')
assert(!clientC.includes("require('dsh-plugin-update"), '纯目标 client 不 require 更新内核任何子路径')

// 4) cordis.patch.yml 必须是顶层 YAML 数组（exploration 实测：写成映射会被 dsh plugin add 回滚）。
const patch = sourceFileOf(planA, 'cordis-patch').content
assert(patch.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'))[0] === '- insert:', 'cordis.patch.yml 首个有效行是顶层数组项')
assert(patch.includes('id: ' + FIXTURE_SLOT_A.packageName), 'patch id = 包名')
assert(patch.includes('name: ' + FIXTURE_SLOT_A.packageName), 'patch name = 包名')

// 5) package.json 清单与 plan 里的 manifest 是同一份（落盘内容就是清单，不二次拼装）。
const manifestFile = sourceFileOf(planA, 'manifest').content
assertEqual(manifestFile, JSON.stringify(planA.manifest, null, 2) + '\n', 'manifest 源文件 = JSON.stringify(manifest)')

// 6) 版本序列之外的版本立刻抛（防止手滑发一个不存在的「变体版」）。
let threw = false
try {
  planFixturePackage(FIXTURE_SLOT_A, '0.9.9', SUT)
} catch {
  threw = true
}
assert(threw, '未声明版本必须拒绝生成')

// 7) 包名集合互不相同（同一个 registry 里三个夹具不能撞名）。
const names = FIXTURE_SLOT_PACKAGE_NAMES
assertEqual(new Set(names).size, names.length, '三个席位包名互不相同')

// 8) 场景声明机制（#266）：声明里的每个基版/变体都能生成计划，效果按声明落到产物。
for (const scenario of SCENARIOS) {
  assert(scenario.id.length > 0, '场景 ' + scenario.id + ' 有 id')
  assert(scenario.expected.length > 0, '场景 ' + scenario.id + ' 声明了预期')
  for (const step of scenario.install) {
    const installSlot = step.slotKey === 'a' ? FIXTURE_SLOT_A : step.slotKey === 'b' ? FIXTURE_SLOT_B : FIXTURE_SLOT_C
    const plan = planFixturePackage(installSlot, step.version,
      SUT,
      step.effect,
    )
    assertEqual(plan.effect.ui, step.effect.ui, '场景 ' + scenario.id + ' 基版 ' + step.slotKey + ' 的 effect.ui 落到计划')
  }
  for (const variant of scenario.variants) {
    const slot = variant.slotKey === 'a' ? FIXTURE_SLOT_A : variant.slotKey === 'b' ? FIXTURE_SLOT_B : FIXTURE_SLOT_C
    const plan = planFixturePackage(slot, variant.version, SUT, variant.effect)
    assert(variant.changeClasses.length > 0, '变体 ' + variant.slotKey + '@' + variant.version + ' 声明了变更类别')
    assertEqual(plan.effect.titleSuffix, variant.effect.titleSuffix, '变体标题后缀进计划')
    assertEqual(plan.effect.hubDock, variant.effect.hubDock, '变体中枢坞开关进计划')
    assertEqual(plan.effect.hostBehavior, variant.effect.hostBehavior, '变体 host 行为字段进计划')
    // 变体必须真的改可见行为/UI（不能只是版本号）：标题/坞/行为字段至少一个变。
    if (slot.role === 'integrator') {
      const base = scenario.install.find((item) => item.slotKey === variant.slotKey)
      if (!base) throw new Error('[fixtures 单测失败] 集成方变体必须有基版可对比')
      const basePlan = planFixturePackage(slot, base.version, SUT, base.effect)
      const changed = plan.effect.titleSuffix !== basePlan.effect.titleSuffix || plan.effect.hubDock !== basePlan.effect.hubDock || plan.effect.hostBehavior !== basePlan.effect.hostBehavior
      assert(changed, '集成方变体 ' + variant.slotKey + '@' + variant.version + ' 必须改 UI/行为，不能只改版本号')
      const clientVariant = sourceFileOf(plan, 'client-source').content
      const clientBase = sourceFileOf(basePlan, 'client-source').content
      assert(clientVariant !== clientBase, '集成方变体 client 源与基版不同（真·内容变化）')
      assert(plan.effect.hubDock ? clientVariant.includes('mountHubProgressDock') : !clientVariant.includes('mountHubProgressDock'), '中枢坞开关与 client 源码一致')
    }
  }
}

// 9) 声明 ↔ 矩阵行不许脱节：每条场景 id 在 coverage-matrix.md 里都有一行（新增场景=加声明+加矩阵行）。
const matrixPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'evidence', 'coverage-matrix.md')
const matrix = readFileSync(matrixPath, 'utf8')
for (const scenario of SCENARIOS) {
  assert(matrix.includes(scenario.id), '矩阵 coverage-matrix.md 有场景行 ' + scenario.id)
}
// 反向：b/c 两行属于本票（矩阵行的 id 必须出现在声明里，防止矩阵写了场景但没实现声明）。
for (const id of ['b-batch-two-integrators', 'c-pure-target-no-wiring']) {
  assert(SCENARIOS.some((scenario) => scenario.id === id), '矩阵行 ' + id + ' 有对应场景声明')
}

console.log('fixture-package-plan.test: OK（' + checked + ' 条断言）')
