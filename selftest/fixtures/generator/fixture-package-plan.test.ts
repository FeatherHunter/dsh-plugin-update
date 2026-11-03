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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LOCAL_ONLY_PACKAGES, normalizeLocalOnlyPackages, renderVerdaccioConfig } from '../release/verdaccio-runtime.ts'
import {
  compareVersionStrings,
  defaultMirrorCacheDir,
  highestVersion,
  mirrorCacheFileName,
  parseNpmViewVersion,
  readResolvedCache,
  writeResolvedCacheEntry,
} from '../release/npmjs-mirror.ts'
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

// 8.5) #274 K 组（全 UI 状态）的产物守护：CHANGELOG.md 真源、安装按钮、额外目标面板、autoResume。
const k1 = SCENARIOS.find((scenario) => scenario.id === 'k-single-panel-happy')
const k2 = SCENARIOS.find((scenario) => scenario.id === 'k-single-panel-failure')
const k4 = SCENARIOS.find((scenario) => scenario.id === 'k-batch-resume')
assert(k1 !== undefined && k2 !== undefined && k4 !== undefined, '#274 四条 K 场景声明都在 SCENARIOS 里')
if (k1 === undefined || k2 === undefined || k4 === undefined) throw new Error('unreachable')
const k1Variant = k1.variants.find((variant) => variant.slotKey === 'a')
const k2Base = k2.install.find((step) => step.slotKey === 'a')
if (k1Variant === undefined || k2Base === undefined) throw new Error('[fixtures 单测失败] K1 变体 / K2 基版缺失')
const k1Plan = planFixturePackage(FIXTURE_SLOT_A, '0.0.2', SUT, k1Variant.effect)
const changelogFile = sourceFileOf(k1Plan, 'changelog')
assertEqual(changelogFile.path, 'CHANGELOG.md', 'K1 变体计划带 CHANGELOG.md 源文件')
assert(changelogFile.content.includes('## [0.0.2] - 2026-11-03 [YANKED]'), 'CHANGELOG 标题含版本与 [YANKED] 标记')
assert(changelogFile.content.includes('**BREAKING:**'), 'CHANGELOG 含 BREAKING 条目（冒号在粗体内，产品 splitBreakingPrefix 才识别为破坏前缀）')
assert(changelogFile.content.includes('https://example.com/changelog'), 'CHANGELOG 含裸 URL')
assert(changelogFile.content.includes('`updateCheck`'), 'CHANGELOG 含行内 code')
const kVersionHeadings = changelogFile.content.split('\n').filter((line) => line.startsWith('## [')).length
assertEqual(kVersionHeadings, 107, 'CHANGELOG 有 107 个版本节（0.0.2 + 106 占位），越过 100 条版本节上限')
assert(changelogFile.content.length < 64 * 1024, 'CHANGELOG 文本小于 64 KiB（真机取数不会被字节墙先截掉，版本节截断必可达）')
assert(k1Plan.manifest.files.includes('CHANGELOG.md'), 'CHANGELOG.md 进了 package.json files 白名单')
assert(k1Plan.expectedArtifacts.includes('CHANGELOG.md'), 'CHANGELOG.md 进了期望产物清单')
const k1Client = sourceFileOf(k1Plan, 'client-source').content
assert(k1Client.includes("require('dsh-plugin-update/install-button')"), 'K1 client 引入安装按钮挂件')
assert(k1Client.includes('mountInstallButton'), 'K1 client 挂安装按钮')
assert(k1Client.includes("const EXTRA_PLUGIN_ID = '" + FIXTURE_SLOT_C.packageName + "'"), 'K1 client 额外面板绑 C 的包名')
assert(k1Client.includes('const EXTRA_PREFIX = ' + "'fxa-c'"), 'K1 client 额外面板用 fxa-c 前缀')
const k2Plan = planFixturePackage(FIXTURE_SLOT_A, '0.0.1', SUT, k2Base.effect)
const k2Client = sourceFileOf(k2Plan, 'client-source').content
assert(k2Client.includes('mountInstallButton'), 'K2 client 也挂安装按钮（失败面需要按钮入口）')
assert(!k2Client.includes('EXTRA_PLUGIN_ID'), 'K2 不挂额外目标面板（避免无关状态污染失败面）')
const k4Variant = k4.variants.find((variant) => variant.slotKey === 'a')
if (k4Variant === undefined) throw new Error('[fixtures 单测失败] K4 A 变体缺失')
const k4Client = sourceFileOf(planFixturePackage(FIXTURE_SLOT_A, '0.0.2', SUT, k4Variant.effect), 'client-source').content
assert(k4Client.includes('autoResume: false'), 'K4 A 变体的批量面板冻结自动续跑（autoResume: false）')
const k4Base = k4.install.find((step) => step.slotKey === 'a')
if (k4Base === undefined) throw new Error('[fixtures 单测失败] K4 A 基版缺失')
const k4BaseClient = sourceFileOf(planFixturePackage(FIXTURE_SLOT_A, '0.0.1', SUT, k4Base.effect), 'client-source').content
assert(k4BaseClient.includes('autoResume: false'), 'K4 A 基版也冻结自动续跑（换手时若 A 未更新，第二代加载的基版 client 同样不许自动续跑）')
const k4Host = sourceFileOf(planFixturePackage(FIXTURE_SLOT_A, '0.0.2', SUT, k4Variant.effect), 'host-source').content
assert(k4Host.includes('hub: false'), 'K4 A 变体 host half 关闭中枢孤儿接管（hub: false；否则第二代宿主装载即自动续跑，抢跑「继续」按钮）')
const k4BaseHost = sourceFileOf(planFixturePackage(FIXTURE_SLOT_A, '0.0.1', SUT, k4Base.effect), 'host-source').content
assert(!k4BaseHost.includes('hub: false'), 'K4 A 基版 host half 保持中枢缺省开（第一代由它发起批量并落下中枢方案）')

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

// 10) npmjs 运行时依赖镜像（#269 环境非确定性修复）的纯函数口径：
//     SUT 依赖包在 run 的 verdaccio 里必须「不吃上游」，缓存解析要能容错。
const storageDir = join('D:', 'runtime', 'x', 'verdaccio', 'storage')
const htpasswdFile = join('D:', 'runtime', 'x', 'verdaccio', 'htpasswd')
const baseConfig = renderVerdaccioConfig({ storageDir, htpasswdFile })
assert(baseConfig.includes("'dsh-plugin-update':"), '缺省配置含 SUT 本地规则')
assert(baseConfig.includes("'dsh-plugin-update-fixture-*':"), '缺省配置含夹具本地规则')
assert(baseConfig.includes('proxy: npmjs'), '缺省配置对通配包保留 npmjs 上游')
assert(!baseConfig.includes("'dsh-log':"), '缺省配置不含镜像依赖规则（由调用方追加）')
assertEqual(JSON.stringify(normalizeLocalOnlyPackages(undefined)), JSON.stringify(DEFAULT_LOCAL_ONLY_PACKAGES), '缺省本地规则列表稳定')

const mirrorConfig = renderVerdaccioConfig({
  storageDir,
  htpasswdFile,
  localOnlyPackages: ['dsh-plugin-update', 'dsh-plugin-update-fixture-*', 'dsh-log', 'dsh-log'],
})
assertEqual((mirrorConfig.match(/'dsh-log':/g) || []).length, 1, '镜像包规则去重')
const dshLogRule = mirrorConfig.slice(mirrorConfig.indexOf("'dsh-log':"), mirrorConfig.indexOf("'**':"))
assert(!dshLogRule.includes('proxy'), '镜像包规则不吃 npmjs 上游（避免同名同版本 409）')
assert(dshLogRule.includes('publish: $all'), '镜像包规则允许本地发布')
// 注意 YAML 形状：包名被引号包住，冒号在引号外（"'<包名>':"）。
const ruleOrder = ['dsh-plugin-update', 'dsh-plugin-update-fixture-*', 'dsh-log', '**'].map((key) => mirrorConfig.indexOf("'" + key + "':"))
assert(ruleOrder[0] >= 0 && ruleOrder[0] < ruleOrder[1] && ruleOrder[1] < ruleOrder[2] && ruleOrder[2] < ruleOrder[3], '本地规则在通配规则之前且保持给定顺序')

assertEqual(parseNpmViewVersion('"0.3.5"'), '0.3.5', 'npm view 单版本')
assertEqual(parseNpmViewVersion('["0.3.4", "0.3.10", "0.3.5"]'), '0.3.10', 'npm view 多版本取最高（按数字比较，不是字典序）')
assertEqual(highestVersion(['0.3.4', '0.3.10', '0.3.5']), '0.3.10', 'highestVersion 按数字比较')
assert(compareVersionStrings('0.3.5', '0.3.10') < 0, '0.3.5 < 0.3.10')
assert(compareVersionStrings('1.0.0-beta.1', '1.0.0') < 0, '预发布版本低于正式版')
let npmViewParseThrew = false
try {
  parseNpmViewVersion('not-json')
} catch (error) {
  npmViewParseThrew = true
}
assert(npmViewParseThrew, 'npm view 输出不是 JSON 时抛错（错误留在环境层，不静默）')
assertEqual(mirrorCacheFileName('dsh-log', '0.3.5'), 'dsh-log-0.3.5.tgz', '普通包缓存文件名')
assertEqual(mirrorCacheFileName('@scope/pkg', '1.2.3'), 'scope__pkg-1.2.3.tgz', '作用域包缓存文件名展平')
assertEqual(defaultMirrorCacheDir(join('D:', 'runtime', 'tools', 'verdaccio')), join('D:', 'runtime', 'tools', 'npmjs-mirror'), '镜像缓存目录与 verdaccio 安装目录同级')

const cacheTmpDir = mkdtempSync(join(tmpdir(), 'dsh-npmjs-mirror-test-'))
try {
  const resolvedFile = join(cacheTmpDir, 'resolved.json')
  assertEqual(Object.keys(await readResolvedCache(resolvedFile)).length, 0, 'resolved.json 缺失当空缓存')
  writeFileSync(resolvedFile, '{ not valid json')
  assertEqual(Object.keys(await readResolvedCache(resolvedFile)).length, 0, 'resolved.json 坏 JSON 当空缓存（重新联网解析）')
  writeFileSync(
    resolvedFile,
    JSON.stringify({
      'dsh-log': { version: '0.4.1', range: '^0.4.1', sha256: 'abc' },
      bad: { version: 3 },
      num: 1,
    }),
  )
  const cache = await readResolvedCache(resolvedFile)
  const dshLogEntry = cache['dsh-log']
  assertEqual(dshLogEntry ? dshLogEntry.version : null, '0.4.1', 'resolved.json 有效条目可读')
  assertEqual(cache['bad'], undefined, '形状不对的条目被丢弃')
  assertEqual(cache['num'], undefined, '非对象条目被丢弃')
  await writeResolvedCacheEntry(resolvedFile, 'x', { version: '1.0.0', range: '^1.0.0' })
  const merged = JSON.parse(readFileSync(resolvedFile, 'utf8')) as Record<string, { version?: string }>
  assertEqual(merged['dsh-log'] ? merged['dsh-log'].version : null, '0.4.1', '写缓存时保留已有条目')
  assertEqual(merged['x'] ? merged['x'].version : null, '1.0.0', '写缓存时并入新条目')
} finally {
  rmSync(cacheTmpDir, { recursive: true, force: true })
}

console.log('fixture-package-plan.test: OK（' + checked + ' 条断言）')