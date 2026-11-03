# #284 补测 Wave 总览：用等效宿主补齐规格 #263 收口前的真机空白

- 票：#284（parent 规格 #263，Type: issue，2026-11-03）
- 状态：13 个真机场景 + 3 条 can-red 全部定稿；unknown=0
- 分组笔记：`docs/research/20261103-issue-284-known-red-recovery.md`（A 组）、`docs/research/20261103-issue-284-boundary-gaps.md`（B 组）、`docs/research/20261103-issue-284-hub-lifecycle.md`（C 组）

## 0. 一句话结论

规格 #263 收口时剩下的 4 条 known-red 与 10 个未覆盖边界，全部用「产品文档化入口构造等效宿主 + 真实产品代码路径」补成了可复核的真机证据：13/13 场景 pass、3/3 can-red 真失败、unknown=0；过程中发现并修复 5 个产品 BUG（B 组 3 处「说了假话」，C 组 2 处状态/回滚缺陷），每个都有修前/修后 run 与回归测试。

## 1. 交付物清单

| 类别 | 内容 |
| --- | --- |
| 定稿证据 | `selftest/evidence/runs/` 下 16 个 284-* run（13 pass + 3 can-red fail），每 run 含 `run.json` / `index.md` / `raw/` / 截图（若有） |
| 账本 | `coverage-matrix.md`：主表新增 13 行（A 4 + B 5 + C 4）、can-red 表新增 3 行、Wave 计划表 13 行全部 ✅；`runs/README.md` 新增 16 行；`known-red.md` 4 条数据行只增不减，状态改写为「已转真机/已被覆盖」并更新复现条件 |
| 产品修复 | 5 处 BUG（见 §5），commit `a587dad` / `1dc4c77` / `b0e4565`（B 组）、`4858754`（C 组 2 处） |
| harness 扩展 | 等效宿主构造（`desktopProfiles` + `desktopPnpm`、`pluginManager` 四方法无 `cancelInstall`、`ReaderOverrides.runningVersion` 注入）、`registry-faults.ts` 坏 tarball 注入、`capturePluginManagerOperations`、通道 B `cli-host.ts`、ACL/延迟代理/硬杀等外部注入工具 |
| 合入 | A 组 `df9b1a6` → integration `2364524`；B 组 `fc3a304` → `4c04192`；C 组 `2b7196f` → `f5c6b16`（均 `--no-ff`，未 push） |

## 2. 场景与证据索引

### A 组：known-red 转真机（等效宿主，4 场景）

| 场景 | 设计一句话 | run | 判定 | 断言/图 | 关键 actual |
| --- | --- | --- | --- | --- | --- |
| f2-exit-one-third-party-success | 等效第三方 Desktop（进程内注入 `desktopProfiles` + `desktopPnpm`）→ 安装出口一成功格 | `284-20261103T185513` | pass/0 | 12/3 | 路由 `desktop-service`；真 spawn 载体 CLI 把 0.0.2 装进真磁盘；重启后 host tag v0.0.2 |
| f3-exit-one-third-party-failure | 同上失败格 + 宿主无终止能力 | `284-20261103T185533` | pass/0 | 33/2 | 失败码/失败格/「无终止能力」文案逐条对齐；不伪造服务 |
| g8-desktop-manager-no-cancel-timeout | 等效 desktop-manager（pluginManager 四方法但无 `cancelInstall`）→ 超时诚实 | `284-20261103T185608` | pass/0 | 19/3 | 超时文案逐字断言；delay 结束后 CLI 真装成 0.0.2，证明「可能仍在后台继续」不是免责话术 |
| i4-pending-restart-panel-truth | 注入 `ReaderOverrides.runningVersion=0.0.1` 造真实 pending-restart 面板分支 + 在册真相 | `284-20261103T185635` | pass/0 | 15/4 | pending-restart 文案诚实；摘在册后「未登记」逐字；真重启不加载；恢复登记后重启加载 0.0.2 |

### B 组：未覆盖边界（真实 web 宿主，5 场景）

| 场景 | 设计一句话 | run | 判定 | 断言/图 | 关键 actual |
| --- | --- | --- | --- | --- | --- |
| l1-same-process-two-plugins-concurrent | 同一宿主进程两个集成方面板近似同刻点更新 | `284-20261103T191200` | pass/0 | 17/4 | 抢输方诚实忙碌（不假「已更新」）；重试后两包各 0.0.2、各恰一条成功终态；重启后如实 |
| l2-registry-unreachable | 杀本 run 私有 verdaccio → registry 整体不可达 | `284-20261103T191400` | pass/0 | 21/6 | 安装诚实失败、exec=0、不落台账、无载体命令、8s 内无重试风暴；registry 恢复后重试真装成、台账恰 1 条 completed |
| l3-permission-denied | 对 profile 内包目录注入 Windows ACL 拒写 | `284-20261103T200100` | pass/0 | 17/6 | 失败诚实且可归因；解除 ACL 后重试成功 |
| l4-page-close-mid-install | 延迟代理拉宽安装窗，安装中关页面再打开 | `284-20261103T201400` | pass/0 | 13/4 | 宿主侧安装不被页面生命周期左右；重开后状态如实 |
| l5-host-killed-mid-install-recovery | 安装中 `taskkill /T /F` 硬杀宿主 | `284-20261103T203000` | pass/0 | 20/5 | 重启后状态诚实；锁窗口行为（陈旧阈值内拒绝 vs 回收）与文案如实 |

### C 组：中枢生命周期与 profile 隔离（web 通道 + 换手注入，4 场景）

| 场景 | 设计一句话 | run | 判定 | 断言/图 | 关键 actual |
| --- | --- | --- | --- | --- | --- |
| m1-hub-orphan-only-owner-a-returns | 双批量同 tick → 硬杀第一代 → 只回来 A（摘 B） | `284-20261103T224027` | pass/0 | 30/0 | 第二代无需人工续跑即采纳 fxa 推完；`fxb.json` 哈希不变未被冒领；resume sessionHash=44cc80da；台账各恰一条 completed target=0.0.2 |
| m2-hub-orphan-only-owner-b-returns | 只回来 B → 不冒领 A 的孤儿；第三幕 A 回来 | `284-20261103T224122` | pass/0 | 34/0 | fxa 字节/哈希不变；fxb 自续 total=2；第三幕 A resume=84ef6e1 推完 fxa；exactly-once `fxbB=1`、`fxbC=1` |
| m3-owner-a-row-fails-still-alive | 真 UI「全部更新」+ A 的 0.0.2 tarball 字节改坏 | `284-20261103T224225` | pass/0 | 36/4 | A 行诚实失败（exec ok=false 72.8s）但 A 仍活着；B/C 继续完成；恢复 tarball 后行内重试只有 A 重跑（ok 1.0s）；重启后三包 client/host v0.0.2 |
| m4-cross-profile-concurrency | 同 home 两个 profile 各起宿主，同 tick 各发三包批量 | `284-20261103T224418` | pass/0 | 33/0 | 队列按 profileDir 短哈希隔离（`bd5189e2…` / `a328f0af…`）；两批安装窗真重叠（B 间隔 30ms、C 间隔 84ms）；两台账各 3 条 completed、无跨 profile 写入 |

> C 组 M1/M2/M4 无窗口截图（shots=0）：web 通道证据力来自断言与 `raw/`，`selftest/evidence/README.md` 有专段约定，避免把「没有截图」误读成「没有证据」。

## 3. can-red 记录（证明场景会红）

| 场景 | 注入 | run | 红点（恰 1 条） | 其余断言 |
| --- | --- | --- | --- | --- |
| f2-exit-one-third-party-success | stale-variant：SUT 换回旧 dist 变体 | `284-20261103T185708` | 内容哈希未变 + 重启后标记仍旧（33-assert 期望 host v0.0.2 实际 v0.0.1） | 其余 11 条 pass |
| l2-registry-unreachable | 在已装产物上注入「已是最新」谎话 | `284-20261103T205500` | 注入后横幅变成「已是最新，无需更新。（check-failed）：版本信息查询失败」 | 其余 21 条 pass；raw 留恢复前 sha |
| m1-hub-orphan-only-owner-a-returns | 换手窗口删除 `hub/plans/fxa.json` | `284-20261103T224448` | 删 plan 后 A 不再自动接管：phases a=done/b=installing/c=ready、resume=0、execAfterHost2=0 | 其余 20 条 pass |

can-red 均为真实失败 run（退出码 1），不是拆断言或改期望制造的红。

## 4. 等效宿主边界（本 Wave 的方法论核心）

原则：只有本机不可达的**能力形态**才用等效构造；产品代码路径必须真实；等效性逐条写进 `run.json.equivalentHost{what, why, documentedEntry, realParts, simulatedParts, nonEquivalence}`；不伪造宿主服务、不为让场景变绿改产品。

| 组 | 等效构造 | 文档化入口 | 真实部分 | 非等价部分 |
| --- | --- | --- | --- | --- |
| A（f2/f3/g8/i4） | 进程内构造第三方 Desktop `desktopProfiles` + `desktopPnpm.runPlugin`；构造无 `cancelInstall` 的 `pluginManager`；注入 `ReaderOverrides.runningVersion` | `README.md:527` `readerOverrides.environmentKind`、`:564`/`:600` `runningVersion`、`desktopPnpm`/`desktopProfiles`/`pluginManager` 注入 | 产品路由判定、安装编排、CLI 真 spawn 与真磁盘安装、文案、重启生效 | 真实第三方 Desktop 发行包本体、真实官方发行包的无取消能力形态 |
| B（l1–l5） | 真实 DSH web 宿主 + Playwright 真页面；ACL/延迟代理/`taskkill` 均为真实 OS 层外部注入 | 产品安装电话与真 UI 动作 | 宿主、插件管理、面板渲染、安装执行、状态机 | 桌面窗口壳与「关页面」的真实窗口语义（web 用页面生命周期等价） |
| C（m1–m4） | `taskkill /T /F` 硬杀第一代进程树 + 同 home/profile 起第二代 | 产品中枢租约/方案盘上协议、hook 恢复、批量续跑 | 中枢接管、plan/lease 落盘、pump、exactly-once | 应用内 relaunch 与窗口生命周期（整进程退出 vs 应用内重启） |

明确不做（环境边界，非偷懒）：真实第三方 Desktop 发行包本体、10+ 插件规模、磁盘满。known-red 保留复现条件，不把等效当发行包。

## 5. 产品 BUG 闭环

| # | 症状 | 根因（文件:行号） | 修复 commit | 回归测试 | 证据（修前 → 修后） |
| --- | --- | --- | --- | --- | --- |
| 1 | 新进程/跨目标轮询 latest 未知时，面板与诊断仍说「已是最新，无需更新。」 | `src/panel/view-model.ts:388` done 兜底；`src/shared/copy.ts:628-637` stateLine 兜底；服务层 `src/core/service.ts:512` latest=null 时 :534-551 返回 unknown/no-latest | `a587dad` | `tests/issue-284-unknown-latest.test.mjs` | `284-20261103T151900` → `284-20261103T191200` |
| 2 | 同一宿主轮询两个目标互相挤掉单例 reader，已查到 latest 丢失（放大 #1） | `src/host/capabilities.ts:52-53,210,218-234` 单槽 `sharedReader` 仅 busy 时复用 | `1dc4c77` | `tests/issue-284-reader-cache.test.mjs` | `151900` → `191200`（L1 两目标 latest 各自保留） |
| 3 | 检查后目标被他人改写（`installationKey` 变）→ `canInstall=false` 但 latest>running，面板仍落 done 假最新 | `src/panel/view-model.ts:409-417` done 兜底先于 latest/running 比较；`src/shared/copy.ts:637` 同病 | `b0e4565` | `tests/issue-284-not-installable-tell-truth.test.mjs` | `284-20261103T180549` → `191200` |
| 4 | 批量续跑行重查把 current/done 当 check-expired 失败丢弃（行消失） | `src/host/batch/phones.ts` satisfiedByRecheck 要求 installedVersion>=targetVersion；`fan-out.ts` 传 targetVersion | `4858754` | `tests/batch-resume-current.test.mjs`（5 用例） | C 组 M2 `284-20261103T182721` 发现 → M2 `284-20261103T224122` 复绿 |
| 5 | CLI 安装失败后 profile 依赖边已写目标版但包未装成 → 坏清单拖垮后续行 | `ports.ts` runInstall 可选 `previousVersion`、`service.ts` 传 `job.previousVersion`、`executor.ts` 失败补偿回滚 spawn 绑 receiver | `4858754` | `tests/issue-284-cli-rollback.test.mjs`（8 用例） | C 组 M3 `284-20261103T192601` 发现 → M3 `284-20261103T224225` 复绿 |

A 组无产品改动；B/C 的产品改动仅上述 BUG 修复，未改对外契约、未新开公开子路径（符合规格 #263 约束）。

## 6. 账本与门禁

- `coverage-matrix.md`：主表 13 行（A 4 + B 5 + C 4）、can-red 表 3 行、Wave 计划表 13 行 ✅（段标题注明 13 场景全部定稿）。
- `runs/README.md`：16 行定稿 run。
- `known-red.md`：4 条数据行只增不减；`t3-267-exit-one`/`t4-268-no-cancel-probe`/`t8-272-panel-pending-restart-branch` 改写为「已转真机（等效宿主）」并附 run id 与等效边界；`t8-272-i2-runtime-version-not-authoritative` 改写为「已由 G8 + I4 覆盖两个可观测面」，known-red 语义与修复方向保留。
- 分组门禁（各分支定稿 HEAD，build 后）：两套 tsc、fixture-package-plan 单测、`npm run build`、`npm run test:batch`、`npm run check` 全绿（A 组另跑定向单测 7/7；B 组 test:batch 192 pass/0 fail；C 组 197 pass/0 fail、定向单测 13 pass）。
- 收口门禁在 integration `f5c6b16` 上由 Lead 统一复跑（2026-11-03 23:05）：`npx tsc -p selftest/tsconfig.json --noEmit`=0、`npx tsc -p selftest/tsconfig.tooling.json`=0、`fixture-package-plan.test.ts`=0（1 test file 全绿）、`npm run build`=0、`npm run test:batch`=0（197 pass / 0 fail）、`npm run check`=0（2141 tests、2140 pass、0 fail，1 todo）、`npm run docs:log:check`=0、`npm run smoke:log`=0（s1–s6 PASS）。

### 6.1 复跑命令（仓库外 runtime 目录）

```powershell
# A 组（等效宿主）
node selftest/real-machine/tools/run-known-red-recovery.ts --mode f2 --run-base-dir <runtime>/a
node selftest/real-machine/tools/run-known-red-recovery.ts --mode f3 --run-base-dir <runtime>/a
node selftest/real-machine/tools/run-known-red-recovery.ts --mode g8 --run-base-dir <runtime>/a
node selftest/real-machine/tools/run-known-red-recovery.ts --mode i4 --run-base-dir <runtime>/a
node selftest/real-machine/tools/run-known-red-recovery.ts --mode can-red --run-base-dir <runtime>/a

# B 组（真实 web 宿主）
node selftest/real-machine/tools/run-l-boundary-gaps.ts --mode l1 --run-base-dir <runtime>/b
# ... l2 / l3 / l4 / l5 / can-red

# C 组（中枢生命周期）
node selftest/real-machine/tools/run-hub-lifecycle.ts --mode m1 --run-base-dir <runtime>/c
# ... m2 / m3 / m4 / can-red
```

试错 run 加 `--no-evidence-sync`（只留仓库外，不复制进 `selftest/evidence/runs`）；定稿 run 不要加。

## 7. 已知限制与残余风险

- 真实第三方 Desktop 发行包本体未验（本机环境边界）：f2/f3 用文档化入口构造等效宿主，known-red 保留「换真实发行包后复现」条件。
- #281（换手窗口双 driver fencing）与 #283（换手恢复被旧队列占位拖慢约 30s）仍 open：本 Wave 覆盖正确性（exactly-once、不冒领、单属主），但双 driver 同时驱动的竞争窗口仍有理论风险；约 30s 延迟是换手恢复的可观测性能问题，建议后续单独评估。
- 集成方不注入 `runningVersion` 时运行版不可权威（`src/host/capabilities.ts:142-168`、`src/core/reader.ts:434`）：`t8-272-i2` 的 known-red 语义保留，修复方向（CLI/离位安装由集成方注入或读启动标记）不变。
- 通道 B 的 web 宿主无桌面窗口壳（C 组 M1/M2/M4 shots=0），页面生命周期与窗口语义的差别已在等效边界里写明。
- M4 的 `npm_config_minimum_release_age=0` 是隔离环境继承维护者全局 pnpm 配置的噪声（`raw/19-m4-pnpm-supply-chain-isolation.json` 记原因与隔离方式），不是产品结论。

## 8. 复核路径

1. 逐 run：`selftest/evidence/runs/<runId>/index.md`（看什么 / 步骤 / expected / actual / 判定 / 备注），需要原始观测再看 `raw/`。
2. 分组细节：三份 `docs/research/20261103-issue-284-*.md`（设计、构造、注入、BUG、残余风险）。
3. 断言原话：`run.json.assertions[]`；SUT 指纹：`run.json.environment` / `run.json.sut`（distDigest、distFiles、installedDistMatch 非空）。
4. 账本：`selftest/evidence/coverage-matrix.md`、`selftest/evidence/runs/README.md`、`selftest/evidence/known-red.md`。
