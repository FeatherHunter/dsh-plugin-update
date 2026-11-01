/**
 * selftest/fixtures/generator/fixture-package-plan.test.ts —— 生成层纯函数单测（无 IO、无进程）。
 *
 * 运行：node selftest/fixtures/generator/fixture-package-plan.test.ts
 * 这是工具层自测，不是根仓 hermetic 的 selftest 层；失败即抛（Node 非零退出）。
 */
import { FIXTURE_SLOT_A, FIXTURE_SLOT_B, FIXTURE_SLOT_C, FIXTURE_SLOT_PACKAGE_NAMES } from '../identity/fixture-slots.ts'
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

// 1) 三个席位都能生成计划；包名/pluginId 一致且能过包名正则。
for (const slot of [FIXTURE_SLOT_A, FIXTURE_SLOT_B, FIXTURE_SLOT_C]) {
  const plan = planFixturePackage(slot, '0.0.1', SUT)
  assertEqual(plan.packageName, slot.packageName, 'plan.packageName = 席位包名')
  assertEqual(plan.dirName, slot.packageName + '-0.0.1', '目录名 = 包名-版本')
  assertEqual(plan.manifest.name, slot.packageName, 'manifest.name')
  assertEqual(plan.manifest.version, '0.0.1', 'manifest.version')
  assertEqual(plan.manifest.dependencies['dsh-plugin-update'], '0.18.39', '夹具依赖钉住 SUT 版本')
  assertEqual(plan.manifest.dsh.client.platform, 'web', 'client.platform = web')
  assertEqual(plan.manifest.exports['./client'], './lib/client.js', '导出 ./client')
  assertEqual(plan.manifest.main, './lib/index.js', 'main 指 host 产物')
  assertEqual(plan.manifest.files.join(','), 'lib,cordis.patch.yml', 'files 只带产物与 patch')
}

// 2) 集成方：host half 引批量 API 并带自键/目标前缀；client half 带 loader 常量与 self 前缀。
const planA = planFixturePackage(FIXTURE_SLOT_A, '0.0.2', SUT)
const hostA = sourceFileOf(planA, 'host-source').content
assert(hostA.includes("from 'dsh-plugin-update/batch'"), '集成方 host half 从 dsh-plugin-update/batch 引入批量 API')
assert(hostA.includes("prefix: 'fxa'"), '集成方 host half 用批量前缀 fxa')
assert(hostA.includes("selfKey: 'a'"), '集成方 host half 指定自键 a')
assert(hostA.includes("selfOrder: 'first'"), 'A 席位自更新排第一')
assert(hostA.includes("key: 'c'") && hostA.includes("prefix: 'fxa-c'"), 'A 的目标表含 C（前缀 fxa-c）')
assert(hostA.includes('buildTag'), 'host half 暴露 buildTag 电话（版本可见变化的后端凭据）')
const clientA = sourceFileOf(planA, 'client-source').content
assert(clientA.includes("const PREFIX = 'fxa-a'"), 'client half 用「自己」目标前缀 fxa-a')
assert(clientA.includes("require('dsh-plugin-update/panel')"), 'client half 引入 panel')
assert(clientA.includes("require('dsh-plugin-update/entry')"), 'client half 引入 entry')
assert(clientA.includes('mountUpdatePanel') && clientA.includes('mountUpdateEntry'), 'client half 挂入口件+面板')
assert(clientA.includes("'shell.overlay'"), 'client half 挂 shell.overlay 常驻')
assert(clientA.includes('pointerEvents') && clientA.includes("'auto'"), '根节点 pointer-events:auto')
assert(clientA.includes('client v0.0.2'), 'client 构建标记随版本变化（真 UI 可见）')
assert(!clientA.includes('slotTitle') && !clientA.includes('TODO'), '生成源码里不残留模板占位符')

// 3) 纯目标：无批量 API、无更新接线（S2 已批准）。
const planC = planFixturePackage(FIXTURE_SLOT_C, '0.0.1', SUT)
const hostC = sourceFileOf(planC, 'host-source').content
assert(!hostC.includes('createMultiHostUpdate'), '纯目标 host half 不接更新电话')
assert(!hostC.includes('mountUpdatePanel'), '纯目标不挂更新面板')
const clientC = sourceFileOf(planC, 'client-source').content
assert(clientC.includes('dsh-fixture-target'), '纯目标 client 有可识别的夹具标记')
assert(clientC.includes('client v0.0.1'), '纯目标 client 构建标记可见')

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

// 7) 霍然：包名集合互不相同（同一个 registry 里三个夹具不能撞名）。
const names = FIXTURE_SLOT_PACKAGE_NAMES
assertEqual(new Set(names).size, names.length, '三个席位包名互不相同')

console.log('fixture-package-plan.test: OK（' + checked + ' 条断言）')
