# #266 / T2：三插件真身份 + 批量更新场景（官方桌面真机）

> 本票在 T1（#265）单包主链之上，把夹具层扩成「A/B 两个批量集成方 + C 纯目标」，并让场景声明成为单一真源。
> 证据：`selftest/evidence/runs/266-20261102T034002`（b pass）、`266-20261102T034912`（c pass）、
> `266-20261102T080334`（b can-red）、`266-20261102T081101`（c can-red）。

## 1. 一句话结论

同一干净 profile 同装三包后：A（fxa，targets=a/b/c）与 B（fxb，targets=b/c）两个批量集成方互相识别、各自批量面板/入口/中枢坞独立；
A 的真 UI「全部更新」把 a/b/c 从 0.0.1 推到 0.0.2（跨官方桌面自重启续跑），B 的视图随后看到 b/c 已是 0.0.2 且能独立发起批量（预查判 current、不重装）；
C 被推到 0.0.2 但自己的页面仍**没有**任何 `.dsh-upd` 面板/入口、manifest 不依赖更新内核、日志里没有 `fxc*` 命名空间。
两场景各有一份真失败 can-red。真机还暴露并最小修了两个产品 BUG（见 §7）。

## 2. 三插件真身份与批量接线

### 2.1 身份单源：`selftest/fixtures/identity/fixture-slots.ts`

- 席位：A / B 为 `role: 'integrator'`，C 为 `role: 'target'`（`batch: null`、`selfTargetPrefix: null`）。
  批量绑定（唯一真源，模板只读它）：
  - A：`prefix: 'fxa'`、`selfKey: 'a'`、`selfOrder: 'first'`、targets = `[{a,fxa-a},{b,fxb-b},{c,fxa-c}]`
  - B：`prefix: 'fxb'`、`selfKey: 'b'`、`selfOrder: 'last'`、targets = `[{b,fxb-b},{c,fxb-c}]`
- `FixtureOverlayPlacement`（#266 新增）：A `right:16/bottom:16/width:520`、B `left:16/top:72/width:520`、C `left:16/bottom:16/width:220`。
  三张夹具卡片同窗互不遮挡 —— 截图 `19-shot`/`52-shot` 能同屏读出两席面板与 C 徽标。
- `FixtureVariantEffect`（#266 新增，场景声明机制的载荷）：
  `{ ui: 'single' | 'batch', titleSuffix, hubDock, hostBehavior, seatLine }`；
  `FixtureChangeClass = 'ui' | 'behavior' | 'metadata'`；
  `fixtureBuildTagsOf(slot, version, effect?)` 用 effect 渲染标题后缀（不传 = T1 旧行为，保证 #265 场景可复跑）。

### 2.2 集成方模板：`selftest/fixtures/templates/integrator/`

- host half（生成物 = 夹具包 `src/index.ts` → esbuild → `lib/index.js`）：
  `createMultiHostUpdate({ ctx, logCtx }, { prefix, targets, selfKey, selfOrder, ... })` 接线七个别名批量电话 + 每目标单插件电话；
  HTTP 桥（同源 `/_dsh/selftest-fixture-<key>`）把 client 的 `call()` 转到 host 电话；
  构建标记电话除 `buildTag/role/packageName` 外回 `behavior`（变体版 `'seat-aware-v2'`、基版 `null`）与 `targetKeys`（自家 targets 的机器可读声明）。
- client half：
  `mountUpdateBatchEntry`（`ui=batch` 时挂，批量入口）、`mountUpdateBatchPanel`（embedded 模式；卡片位置来自 overlay 单源）、
  `effect.hubDock=true` 时再挂 `mountHubProgressDock`（变体版的「新 UI 元素 + 轮询中枢状态」行为变化）；
  渲染 `data-fixture`、`data-fixture-title`、`data-build-tag`、席位行（`批量席位 fxa · 自键 a · 目标 a/b/c`）。

### 2.3 纯目标模板：`selftest/fixtures/templates/target/`

- 只渲染左下徽标，根节点写死 `data-fixture-ui="none"`、`data-update-wiring="none"`；
  不 `require` `dsh-plugin-update` 任何子路径、不挂 `.dsh-upd`/入口/面板；
  manifest 的 `dependencies` 不含更新内核（场景 c 的 `10-assert` 断言 `dependencies={}`，这是「无接线」最硬的证据）。

### 2.4 真机观测（b pass `266-20261102T034002`）

| 断言 | actual（原文摘要） |
| --- | --- |
| 13-assert A 身份 | `ui=batch；seatLine=批量席位 fxa · 自键 a · 目标 a/b/c；标题=夹具 A · 更新演示；批量入口存在` |
| 14-assert A 目标 | `rows=[a,b,c]；a/b/c=pending[0.0.1]` |
| 15/16-assert B 身份 | `seatLine=批量席位 fxb · 自键 b · 目标 b/c；rows=[c,b]`（selfOrder=last 把自键排最后，集合={b,c}） |
| 17/50-assert C 无接线 | `wiring=none；dshUpd=0；dock=0；entry=0`（更新前后都是） |
| 18/51-assert 页级计数 | 初始 `batchPanels=2 dshUpd=2 docks=0`；重启后 `batchPanels=2 entries=2 docks=2 dshUpd=2 fixtures=[c,a,b]` |
| 43-assert 行集合隔离 | `B rows=[c,b]；A rows=[a,b,c]`（检查/安装后都不漂移） |
| 60-assert 批量账本隔离 | `fxa batch=[a,b,c] inventory=[a,c,b]；fxb batch=[c,b] inventory=[b,c]`（文件在 `update-queue/<fp>/{fxa,fxb}/batch.json|inventory.json`） |
| 62/63-assert 中枢 | `hub/plans/fxa.json`（selfKey=a，targets=[a,b,c]）、`hub/plans/fxb.json`（selfKey=b，targets=[c,b]）；租约已释放；`owners=fxa,fxb`，**没有** `fxc` |

## 3. 版本化场景声明机制（单一真源，可复用）

### 3.1 声明（`selftest/fixtures/identity/scenario-declarations.ts`）

```ts
interface ScenarioDeclaration { id; ticket; hostChannel: 'desktop-official'; summary;
  install: { slotKey; version; effect }[];          // 干净 profile 预装什么（基版 + 效果）
  variants: { slotKey; version; changeClasses; effect }[];  // 更新时发布/装上什么
  expected: string[] }                               // 矩阵「预期」列的机器可读版本
```

- 三条声明：`SCENARIO_A_SINGLE_PACKAGE`（#265，复用 T1 效果 `legacySingleEffectOf`）、
  `SCENARIO_B_BATCH_TWO_INTEGRATORS`、`SCENARIO_C_PURE_TARGET`；`scenarioOf(id)` 未知 id 立刻抛（防「跑错场景却记成另一个」）。
- 效果函数：`batchEffectOf(slot, variant)`（变体：标题后缀「（批量新版）」+ hubDock + hostBehavior `seat-aware-v2`）、
  `targetEffectOf(version)`（纯目标只有标题后缀/构建标记，接线永不变）。
- **扩展规则**：新增变体 = 在 `variants` 加一条（含 `changeClasses`/`effect`）+ 矩阵行；新增场景 = 加一条 `ScenarioDeclaration`
  + `coverage-matrix.md` 一行 + `selftest/real-machine/tools/run-<x>.ts` 入口。模板/生成器/发布器都不用改。

### 3.2 执行器（`selftest/real-machine/runtime/scenario-runner.ts`）

- `publishScenarioBaseline(scenario, env)`：按 `install` 去重后逐席位 `env.publish(slot, version, { effect })`；
- `publishScenarioVariants(scenario, env, faultInjection?, publishedBaseline?)`：按 `variants` 发布；can-red 注入
  `skip-variant`=不发布该变体、`stale-variant`=用 `staleContentVersion: 基版` 发新版本号（新版本号、旧内容）；
  返回 `{ baseline, variants, injected }`；
- `installScenarioBaseline`（CLI 装进隔离 profile）、`variantVersionOf/baselineVersionOf`（场景写断言用，**场景文件不写死版本号/后缀**）。
- 发布器 `fixture-environment.publish` 的缓存条件是 `existing && !publishOptions`：带 effect 的发布永不命中旧缓存，
  所以同一版本号在不同场景/基版 vs 变体之间不会串内容。

### 3.3 生成器与单测

- `generator/fixture-package-plan.ts`：`planFixturePackage(slot, version, sut, effect?)` → manifest + sourceFiles + buildSteps + expectedArtifacts；
  `fixture-package-builder.ts` 落盘 + junction（node_modules/dsh-plugin-update → 工作树）+ esbuild（host ESM / client CJS）。
- `node selftest/fixtures/generator/fixture-package-plan.test.ts`：核对声明里的每个席位/版本都能生成、效果/构建标记与矩阵行一致、
  未知场景 id 抛错、C 的 manifest 无 SUT 依赖（103 条断言，见 §8）。

## 4. 场景 b 证据（两个集成方 + 一个纯目标）

- run：`selftest/evidence/runs/266-20261102T034002`（`verdict=pass`、`exitCode=0`、38 断言、7 张截图）；
  SUT = 当前工作树 `dsh-plugin-update@0.18.39`，tarball sha256 `d1ed0c40…`，dist 聚合指纹 `efddad08…`（安装后一致）。
- 流程：起本地 verdaccio → pack/发布 SUT → 发布三基版（声明驱动）→ 官方桌面首启引导 → CLI 预装 A/B/C 0.0.1 →
  初始 UI 断言（13–18）→ 发布三个 0.0.2 变体并核对可执行内容真的变了（23/24/25）→ A 点「检查更新」（28/29）→
  A 点「全部更新」（32/34，跨官方桌面自重启续跑）→ 行态收敛（36/37）→ B 点「检查更新」（40/43）→
  B 独立点「全部更新」（42，预查判 current）→ 重启后新 UI（46–51）→ 磁盘/依赖/日志/批量账本/中枢/队列（55–63）→
  清理与维护者 profile 指纹（64/65）。
- B 码面（「不只是版本号」的证据）：
  - `23-assert`：三个变体 `client.js` sha256 与基版不同且 bundle 内含 `client v0.0.2` 标记；
  - `47-assert`：同一张 A 卡片更新前标题 `夹具 A · 更新演示` → 更新后 `夹具 A · 更新演示（批量新版）`；
  - `46/48-assert`：重启后 A/B 都出现 `behavior=seat-aware-v2` + 中枢进度坞（host 回包字段，不是编译期文案）；
  - `49-assert`：C 徽标 `夹具 C · client v0.0.1` → `夹具 C · client v0.0.2（新版）`。
- 日志链（`58-assert`）：`installA/installB/installC=true、hostCallOk=true、wireDesktop=true（update.wire.ready hostKind=desktop-manager）、
  noErrorLevel=true、installFailDesignOnly=true、noCrossScopeCheckFailure=true`。
- 自重启与瞬态：安装期间官方桌面自重启，场景用「停旧进程 → 重新 launch → CDP 重连 → 从落盘账本续跑」；
  `36-assert` 记录 `transient=false`（修复后不再出现瞬态 `recovery-required`，见 §7 BUG-266-2）。

## 5. 场景 c 证据（纯目标无更新接线）

- run：`selftest/evidence/runs/266-20261102T034912`（`verdict=pass`、`exitCode=0`、24 断言、4 张截图）；SUT 指纹同 b。
- 流程：发布 A/C 基版 → 桌面首启 → 预装 A+C → 初始 UI（14–16）→ C manifest 无 SUT 依赖（10）→
  发布 C@0.0.2（21）→ A 点「检查更新」（24，C 行版本条 0.0.1→0.0.2）→ A 点「全部更新」（27，磁盘 C=0.0.2）→
  C 行 done、a 行 current（30）→ 重启（32–35）→ 磁盘/依赖/日志（39–43）→ 清理（44/45）。
- 「无接线」的三层证据：
  1. UI：`15/33/50-assert wiring=none、dshUpd=0、dock=0、entry=0`（更新前后都无）；
  2. 包契约：`10-assert C dependencies={}`（不依赖更新内核，不是把 UI 藏起来）；
  3. 日志：`42-assert` C 的安装事件落在 A 的属主命名空间 `fxa-c`，**没有任何 `fxc*` 命名空间**；`43-assert` 本场景未发布/未安装的 b 目标只报 check 失败（warn、`entry.fail{stage:check}`，无 install 尝试），不挡整批。

## 6. can-red（证明场景会红）

can-red 的注入只改**发布内容**，不改断言；红点必须落在被测断言本身，其余环境/清理断言仍 pass。

| 场景 | 注入命令 | 预期失败点 | 证据 |
| --- | --- | --- | --- |
| b-batch-two-integrators | `run-b-batch.ts … --fault skip-variant:c`（不发布 C@0.0.2） | C 到不了 0.0.2 的相关断言（A/B 面板 C 行版本条、C 徽标新版、日志 installC） | `runs/266-20261102T080334/` |
| c-pure-target-no-wiring | `run-c-pure-target.ts … --fault stale-variant:c`（发 0.0.2 但内容取 0.0.1） | C 变体内容哈希未变/无新标记、重启后徽标仍是 `client v0.0.1` | `runs/266-20261102T081101/` |

实测（`run.json.assertions` 的 fail 清单，不是推断）：

- b can-red `266-20261102T080334`：`verdict=fail`、`exitCode=1`，恰好 4 条红 —— `47-assert`（A 重启后行态/版本条：c=`current[0.0.1]`）、
  `49-assert`（B 同）、`50-assert`（C 徽标 `client v0.0.1`）、`59-assert`（日志 `installC=false`，`installRequests=2` 只覆盖 a/b）；
  其余 34 条仍 pass（三包基版安装、a/b 变体发布与新版 UI/行为、磁盘 a/b=0.0.2、批量账本/中枢、清理/维护者指纹）。
  注入点与回滚确认见 `raw/22-can-red-fault.json`（发布列表只有 `a@0.0.2`、`b@0.0.2`）。
- c can-red `266-20261102T081101`：`verdict=fail`、`exitCode=1`，恰好 2 条红 —— `22-assert`（C 变体 `client.js` sha256 未变、
  无 `client v0.0.2` 标记）、`33-assert`（重启后 C 徽标仍是 `client v0.0.1`）；其余 22 条（SUT 钉版、A 批量把「版本号 0.0.2」
  推到位、C 无 `.dsh-upd` 面板/入口、磁盘/日志/清理）仍 pass。注入点见 `raw/20-can-red-fault.json`。
- 说明：两份 `can-red-fault.json` 的 `expected` 文案在生成时按当时场景版本的断言编号书写，本轮实测编号见上面（b 统一 +1 是因为
  之后新增过一条「瞬态行经检查更新对账」记录断言）；场景代码里的该文案已改成编号无关表述，证据 raw 保持 run 时原样。

## 7. 产品 BUG（真机暴露 → 最小修复 + 回归）

### BUG-266-1：批量使用范围不反推 → 批量账本/中枢不落盘

- **现象**：集成方按 README 示例只传 `{ ctx, logCtx }` 调 `createMultiHostUpdate` 时，隔离 home 下只有
  `update-queue/<fp>/queue.json`，**没有** `batch.json/inventory.json/prefs.json`、没有 `hub/plans/*.json`；
  面板行态只活在进程内存，重启即失（b 场景「重启后行态/账本可读」断言本应红）。
- **根因**：`src/host/batch/fan-out.ts:181-199`（修前）的 `batchHome/batchProfile` 只认 `input.scope` / `input.readerOverrides` / `input.config`，
  不像单插件侧 `src/host/capabilities.ts:126-190` 那样从 `ctx.profileContext`（`src/host/environment.ts:68` `profileIdentityFromContext`）反推；
  `profileDir` 为 undefined → `ownerPorts=null`（内存账本）、`hubScope=null`（中枢写不出计划）。
- **修复（最小 diff，不改契约/导出/README）**：`src/host/batch/fan-out.ts:63,185-204` 复用 `profileIdentityFromContext/profileIdentityFromEnv`：
  `profileDir = firstText(scope.profileDir, readerOverrides.profileDir, ctxIdentity.dir, envIdentity.dir)`，`profileName` 同序 + `basename(profileDir)`；
  `homeDir` 仍 `firstText(scope, readerOverrides, config.homeDir) ?? defaultHomeDir(env, homedir())`；取不到身份时行为一字不变（诚实兜底）。
- **回归**：`tests/batch-scope-derivation.test.mjs` 3 用例：ctx 权威身份 → `batch.json/inventory.json/hub/plans/fxa.json` 真落盘；
  显式 env `DSH_HOME+DSH_PROFILE_DIR+DSH_PROFILE` 也能反推；反向「无 ctx 不落盘」（`hubStatus` undefined、home 下无 update-queue）。
- **真机前后**：修复前 c run `266-20261102T002823` 的隔离 home 只有 `queue.json`；修复后 b pass `266-20261102T034002`
  `raw/59-batch-disk-facts.json` 有 fxa/fxb 的 batch/inventory/prefs + hub/plans + 已释放租约（60/62/63 断言）。

### BUG-266-2：读取器换代丢掉在飞安装任务 → 瞬态 `recovery-required`

- **现象**：安装 exec 在飞行中换包，目标包清单版本变化 → `getSharedReader` 缓存键（含 runningVersion）变化 → 同进程新建 reader
  （`activeJobId=null`）→ `healJob` 把磁盘上仍在 `installing/verifying` 的同进程任务误判成「上一个进程世代遗留」→
  合成 `interrupted/recovery-required` → 批量 `settleInstall` 读到这一瞬就记 failed；约 1.2s 后 exec 却 ok。
  真机 run `266-20261102T021151`：39-assert c 行 `failed[recovery-required]`，而重启后 A/B 面板 a/b/c 全 `current[0.0.2]`（瞬态）。
- **根因链**：`src/core/service.ts:403-406`（healJob 用实例内 `activeJobId` 判进程世代）+
  `src/host/capabilities.ts:193-194`（共享 reader 键含 runningVersion）+ `src/host/batch/phones.ts:290-328`（settleInstall 读瞬态）。
- **修复（最小 diff，不改契约）**：`src/host/capabilities.ts:195-208` 在共享 reader 键命中前加一道判断：
  若「同使用范围、仅 runningVersion 不同」（helper `sameReaderExceptRunningVersion`，`src/host/capabilities.ts:451-457`）
  且旧实例 `status().job.state ∈ installing/verifying`，先复用旧实例；任务收尾后再按新键换代。
  曾尝试在 `src/core/service.ts` 加进程级在飞任务表，但既有测试（`tests/background.test.mjs:184`、`tests/issue-179-job-persistence.test.mjs:173`）
  明确契约「新 service 实例 = 新进程世代」，该修法已被打红并回退，最终落在读取器缓存层。
- **回归**：`tests/reader-rotation-inflight.test.mjs` 2 用例：换包后同范围再次取 reader 仍复用且任务状态未被误判
  （`installing`/`restart-required`，不是 `interrupted`）；reset 后新 reader 对崩溃任务仍诚实报 `recovery-required`（反向不回归）。
  test-the-test：把 dist 里的在飞判定改成 `false` → 测试必红（`reader2 !== reader1`，`tests/reader-rotation-inflight.test.mjs:170`）。
- **真机前后**：修复前 `266-20261102T021151`（39-assert 瞬态失败）；修复后 b pass `266-20261102T034002` `36-assert transient=false`、
  rows 全 `done[0.0.2]`。

### 设计内行为（不记 known-red）

- `update.install.fail{code:'check-expired'}` 首提拒绝：≥2 家批量时每家首次提交都会凭证过期，安装器当场重查、换 checkId 重提
  （`src/host/batch/phones.ts:388-414`，#70/ADR-0004 §3 A 案）；场景口径 = 只允许 `check-expired` 且同命名空间紧跟 `update.install.retry`
  （`selftest/real-machine/scenarios/batch-helpers.ts` `auditInstallFails`），不是产品失败。
- `update-busy` → `{kind:'queued'}`：排队语义（`src/host/batch/phones.ts:415-419`），不算安装失败。
- 未发布/未安装目标（c 场景的 b 行）：check 失败 warn + `entry.fail{stage:check}`，不挡整批（`src/host/batch/fan-out.ts:1032` 只有传输异常才抛）。

## 8. 门禁结果

| 门禁 | 结果 |
| --- | --- |
| `npx tsc -p selftest/tsconfig.json --noEmit` | ✅ EXIT 0 |
| `npx tsc -p selftest/tsconfig.tooling.json --noEmit` | ✅ EXIT 0 |
| `node selftest/fixtures/generator/fixture-package-plan.test.ts` | ✅ `fixture-package-plan.test: OK（103 条断言）` |
| `npm run build` | ✅ EXIT 0（`tsc --noEmit` 通过 + dist 产出） |
| `npm run test:batch` | ✅ EXIT 0（tests 2088 / pass 2087 / fail 0 / skipped 1） |
| `npm run check`（typecheck + build + `node --test tests/*.test.mjs` + bilingual gate） | ✅ EXIT 0（tests 2088 / pass 2087 / fail 0 / skipped 1；双语门禁通过；E3b 既有 flake 本次未出现） |

## 9. 从零复跑

前置：本工作树已 `npm ci`；esbuild 用工作树自带的 `node_modules/@esbuild/win32-x64/esbuild.exe`（工具入口会解析）；
真机 = 官方桌面 `D:\DeepseekHarness\DeepSeek Harness.exe`（隔离 `--user-data-dir` + 隔离 `DSH_HOME`），本地 registry = 每次自动起的 verdaccio。

```powershell
cd D:/dsh-plugin/_wt263/t2

# b 场景（两集成方批量更新；pass 预期 exit 0）
node selftest/real-machine/tools/run-b-batch.ts `
  --worktree D:/dsh-plugin/_wt263/t2 `
  --run-base-dir D:/dsh-plugin/_wt263/runtime/t2-266

# c 场景（纯目标无接线；pass 预期 exit 0）
node selftest/real-machine/tools/run-c-pure-target.ts `
  --worktree D:/dsh-plugin/_wt263/t2 `
  --run-base-dir D:/dsh-plugin/_wt263/runtime/t2-266

# can-red（预期 fail / exit 1；失败点见 §6）
node selftest/real-machine/tools/run-b-batch.ts --worktree D:/dsh-plugin/_wt263/t2 `
  --run-base-dir D:/dsh-plugin/_wt263/runtime/t2-266 --fault skip-variant:c
node selftest/real-machine/tools/run-c-pure-target.ts --worktree D:/dsh-plugin/_wt263/t2 `
  --run-base-dir D:/dsh-plugin/_wt263/runtime/t2-266 --fault stale-variant:c
```

- 可选参数：`--verdaccio-install-dir`（复用已装好的 verdaccio）、`--esbuild <path>`、`--stamp`（固定 runId 供复跑对照）、
  `--maintainer-home`（默认 `C:\Users\辰辰洋洋\.dsh`，只读指纹核对）、`--fault <kind>:<slot>`（kind ∈ skip-variant/stale-variant，slot ∈ a/b/c）。
- 每次 run 的产物：`<run-base-dir>/<runId>/`（runtime，含隔离 home/profile/user-data-dir/registry）+
  自动采集的证据包 `selftest/evidence/runs/<runId>/`（`run.json`、`index.md`、`shots/`、`raw/`）。
  失败 run 不进 `runs/`（本次时间线里的诊断 run 留在 runtime 即可删）。
- 清理：工具退出前自己停桌面进程树、放 verdaccio 端口；`run.json.cleanup` 里 `aliveAfterStop=false`/`released=true` 为证。
  进程卫生：只杀自己起的进程（`stopDesktopByUserDataDir` 只匹配本次隔离 user-data-dir）。

## 10. 未做 / 边界

- 批量场景只覆盖通道 A（官方桌面 `desktop-official`）；通道 B（`dsh-web`）的批量面板/中枢未在真机覆盖（矩阵行也未声明）。
- b 场景中 B 的独立批量是「预查判 current、不重装」的快路径（A 已先装好）；没有另做一个「B 先装、A 后装」的镜像场景。
- C 的无接线证明是 UI/manifest/日志命名空间三层；C 被外部代码强行驱动更新内核（没有 UI）不在本场景范围。
- 已知既有 flake：`tests/batch-e2e.test.mjs` E3b（「运行版还是旧的 → 待重启」）在并行全量跑时偶发，属 T0/T1 记录在案的既有 flake；
  本次门禁若遇到，重跑一次并把两次结果都记录在 §8；**不把它记成 known-red，也不改该测试**。
- known-red 账本（`selftest/evidence/known-red.md`）无新增行：本次未发现「已确认可稳定复现」的既有失败。
