# #271 T7：更新中枢不断链（G 组）—— 决策笔记

票：[FeatherHunter/dsh-plugin-update#271](https://github.com/FeatherHunter/dsh-plugin-update/issues/271)（父规格 #263）。实现分支 `impl/263-t7`，基线 `04f9f9f`（T6 合并后的 integration/spec-263 tip）。

## 1. 一句话结论

以 A 为批量中枢发起者、A 自身先被替换（换手窗口：A 行已 `done`、B/C 未终态）后，盘上的 hub plan 与 batch session 足以让第二代宿主**自动接管**：B/C 无需任何人工「继续/重试」即完成 0.0.2，batch 三行 `done`/`failed=0`、中枢 `finished done3 failed0`、台账三包各恰一条成功终态、磁盘三包 0.0.2；换手后关页面再重开，面板批量/中枢/A 状态与台账、磁盘一致，刷新前后相同，不是断线或假绿。can-red 在换手窗口删除 `hub/plans/fxa.json` 后 B/C **不再**续跑，run 真红（`fail` / 退出码 1）且唯一红点可归因到被删的方案。**无产品 BUG，未改 `src/`。**

## 2. 设计与路线

### 2.1 入口与注入

- 通道 B（普通 DSH web 宿主，`selftest/real-machine/host/cli-host.ts` `startCliHost`）：同一假用户目录下 `homeDir = osHomeDir/.dsh`、同一 profile（`t7hub`），先建 profile、装 A/B/C@0.0.1 基版并钉住 SUT，再起**第一代**宿主。
- 换手注入 = 在第一代宿主上发批量安装（`fxa.batchInstall`，A 的 `selfOrder='first'`，顺序 a→b→c），**不 await 回包**；场景 120ms 轮询 `batch.json`，当 `a=done` 且 B/C 未终态时停第一代宿主，立刻在**同一 home/profile** 起第二代宿主。全程只发只读查询（`batchStatus`/`updateHubStatus`/A `updateCheck`），不点「继续/重试」，不向 B/C 发任何 drive 电话。
- 为什么用 web 双宿主：P1 定论官方桌面 `profile desktop` 被 Electron 独占，headless 通道 B 不能共享该 profile；T6 P3 已证两个通道 B 宿主可同开同一 home/profile、解析到同一 `profiles/t7hub`、同一 `<home>/update-queue/<shortHash(profileDir)>/`（hub plan/lease 与根队列都在这里）。本场景把「两个自带 HTTP 电话入口的独立宿主进程」串行换代，换手前后共享盘上状态，正是「中枢执行者消失后由后来者续跑」的最小真实形态。

### 2.2 与 ADR-0008 桌面 relaunch 的等价性与差别

- 官方桌面的 A 自更新会触发宿主 relaunch：同一个应用自重启，hub 执行 fiber 消失、新 fiber 起，盘上 plan/session 是续跑依据（ADR-0008：推进寿命 ≠ 发起 fiber）。
- web 注入是**杀进程 + 起新进程**：第一代退出钩子会释放它持有的 hub 租约（`src/host/hub/registry.ts:670` `releaseIfOwner`、`:741` `process.once('exit', releaseHubLeasesOnExit)`、`:748`），因此第二代是**租约空 → 重新 acquire generation=1**，不是桌面 relaunch 的 `takeover`（generation+1）。
- 等价的部分：执行者消失、新执行者从盘上 plan/session 恢复、B/C 无需人工续跑。差别的部分：租约代次（web=release+acquire gen1、桌面=takeover gen+1）。本票**如实记录实际 generation/pid 变化，不硬断言 gen+1，也不伪造 takeover**；桌面侧换手的现成白盒证据引用 T5 定稿 run（见 §6）。
- `installTimeoutMs` 通过夹具环境变量 `DSH_SELFTEST_INSTALL_TIMEOUT_MS=4000` 压到 4s（产品的锁陈旧阈值同源），否则产品默认 15min 的锁陈旧窗口会让「旧占位/旧锁」观察不到。

### 2.3 观测面（为什么不是 UI 截图）

- 换手窗口内没有窗口可点（通道 B 无桌面 UI；第一代随时被杀），所以安装窗口/续跑判定用**原始日志行 ts + `update.install.exec` 的 `durationMs`**（exec 窗口 = `[ts-durationMs, ts]`）、`batch.json` 每行 phase、`host.start` 行 ts、`update.batch.run.start` 的 trigger/resumed。
- 页面恢复格用**页面 HTTP 的真实握手**证明「页面可重开」：带 token 的根请求 → 303 + 签名 cookie → 带 cookie 的 `/` → 200 页面 HTML；再叠面板电话（`batchStatus`/`updateHubStatus`/`updateCheck`）与台账/磁盘一致性。浏览器截图不在本票证据口径内（见 §9）。

## 3. 逐格做法与证据

三个定稿 run 均在干净 HEAD `5bbc166` 上跑、未用 `--no-evidence-sync`，已复制进 `selftest/evidence/runs/`。

### 3.1 g6 换手主格（`runs/271-20261103T015124`，pass / 退出码 0，32 断言 / 38 raw，66.5s）

- 换手窗口（`raw/35-state-at-kill.json`，ts=1793641911245）：batch phases `{a:done, b:installing, c:ready}`；第一代租约 `{driverId:'dsh-hub:71848:a8baaata9e', pluginId:'fxa', pid:71848, generation:1, startedAt/heartbeatAt:1793641908730}`；hub plan `sessionId=mvzk2y8h-zeuz50e76f, owner=fxa, selfKey=a, targets=[a,b,c]`。
- 第一代宿主 pid=71848、port=58983、boot 2861ms；停于 ts=1793641911783（`raw/39-host1-stopped.json`）。
- 第二代宿主 pid=54096、port=51620、boot 2925ms；`host.start` ts=1793641914345（`raw/46-log-timeline.json` 的 `host2StartTs`）。
- 第二代启动后立即从盘上恢复：`update.batch.run.start trigger=resume resumed=true total=3` ts=1793641914710（`raw/46-log-timeline.json`）。
- 自动续跑：B `update.install.exec` ts=1793641947379、durationMs=1951；C ts=1793641949128、durationMs=1553；均 `route='cli-process', ok=true, exitCode=0`，且都晚于第二代 `host.start` ts（1793641914345）。A 自身的 exec 行为 ts=1793641910667、durationMs=1567（A 在换手前完成）。
- 终态：batch 三行 `done`、progress `{total:3,done:3,failed:0,finished:true}`；hubStatus `state=finished, progress done3 failed0`、`activeInstall=null`；plan 文件仍在且 `sessionId` 不变（`raw/53-panel-batch-status-final.json`、`raw/55-panel-hub-status-final.json`）。
- 磁盘：profile manifest `dependencies={a:0.0.2,b:0.0.2,c:0.0.2}`、node_modules 同、bundles 含三包（`raw/47-disk-after-handoff.json`）；台账三包各恰一条 `state=completed, targetVersion=0.0.2, previousVersion=0.0.1`（`raw/48-ledger-states.json`）。
- 断言口径（32 条全 pass）：换手窗口成立、第一代停、第二代起、batch 三行 done、B/C exec 晚于第二代 host.start 且第二代后无 drive 电话、无 exec 阶段失败、plan 同 sessionId、中枢/面板/磁盘/台账一致、租约单一属主（先 71848 后 54096）、清理无残留。

### 3.2 g7 页面恢复格（`runs/271-20261103T015237`，pass / 退出码 0，39 断言 / 46 raw，72.4s）

- 在 g6 换手完成（三包 0.0.2）后，关第二代宿主（pid=71556，ts=1793642024265，=关页面），同 home/profile 起第三代宿主（pid=90780、port=52521、boot 3301ms，`raw/63`/`raw/64`）。
- 页面可加载（`raw/66-panel-page-http.json`）：带 token 根请求 `status=303, location='./'` 且下发签名 cookie；带 cookie 的 `/` 请求 `status=200, bytes=38654`（页面 HTML）。
- 面板恢复：`batchStatus` 三行 `a/b/c=done`、reply 顶层 `progress={total:3,done:3,failed:0,finished:true}`；`updateHubStatus` `finished, done3 failed0, activeInstall=null`；A `updateCheck` `installedVersion=runningVersion=0.0.2, canInstall=false`（`raw/68`/`raw/72`/`raw/74`）。
- 刷新一致：同一宿主内间隔 1s 再取 `batchStatus`，phases 与首次完全相同；磁盘/台账与换手后一致，重开后无新增 exec（39 条全 pass）。

### 3.3 can-red 真失败（`runs/271-20261103T015357`，fail / 退出码 1，24 断言 = 23 pass + 1 fail，37 raw，约 76s）

- 注入：换手窗口内（第一代已停、第二代未起）删除盘上 hub 方案 `<home>/update-queue/c03223ba263d0daf99dbd45d/hub/plans/fxa.json`；`raw/41-can-red-plan-before-delete.json` 存删除前原文（`sessionId=mvzk670t-51nurbhq9z, owner=fxa, targets=[a,b,c]`），`raw/42-can-red-plan-deleted.json` 记删除时刻（ts=1793642063226）与删除后不存在。
- 第二代宿主正常启动（host.start ts=1793642065685），但盘上已无方案可接管：45s 预算内 B/C 不续跑（`raw/52-can-red-verdict-facts.json`）：`phases={a:done,b:installing,c:ready}`、`resumeRunStart=0`、`execAfterHost2=0`、`allTerminal=false`。
- 唯一红点 `53-assert`：「can-red 红点：换手窗口删 hub plan 后 B/C 未自动续跑」；其余 23 条（隔离、SUT 钉版、基版安装、变体发布、第一代换手窗口成立、清理）仍 pass。红点可归因到注入的 plan 丢失，不是 unknown、不是环境噪声。

## 4. 产品 BUG

**无。** 本票未改 `src/`，无 fix commit。真机暴露的现象都能用既有设计解释：

- 换手后 B/C 实际约 32s 才开始安装（见 §5），是 `queue.json` 里旧占位的 TTL 行为（#217），不是断链；最终自动完成。
- web 注入为 `release+acquire generation=1` 而非桌面 `takeover generation+1`，是注入方式（杀进程 vs 应用自重启）的差别，已如实记录，非产品缺陷。

## 5. 租约时间线与 #217 的 ~30s 等待（观测事实，不是断言契约）

- 租约时间线（`raw/61-hub-lease-timeline.json`，71 个采样，约 500ms 一次）：先见第一代 `pid=71848, generation=1`（ts=1793641914711），随后 lease 文件消失（第一代退出钩子释放）；第二代 `pid=54096, generation=1` 首见于 ts=1793641922233；此后 lease 在每次 pump 结束被 `releaseIfOwner` 释放（采样常为 null），下一任务再 acquire，故采样里 pid 序列为 `71848 → null → 54096 → null …`，`generation` 始终 `{1}`，无第二驾驶者。
- 30s 量级延迟：第二代启动后立刻 `update.batch.run.start trigger=resume`（ts=1793641914710），但 B/C exec 到 ts=1793641947379/1793641949128 才发生；其间日志出现 31 条 `update.install.fail {stage:'gate', reason:'gate-refused', code:'update-busy'}`（首条 ts=1793641908754 是换手前旧一代的 `check-expired` 噪声，末条 ts=1793641944354 为 `update-busy`）。机制是 `queue.json` 在 `owner=null` 时 `pruneExpiredIntents` 的 `effectiveTtl=min(QUEUE_INTENT_TTL_MS, QUEUE_INTENT_STALE_MS=30000)`：旧占位过期后公平门放行，安装继续。
- 结论：这是 #217 的既有设计行为（30s 恢复延迟），本票把它作为**观测事实**记入研究笔记与 run 备注，**不断言成产品契约**；若未来要求更快接管，需要另开票改设计。

## 6. 与 E 组共享的换手窗口（桌面侧证据引用）

T5 定稿 run `selftest/evidence/runs/269-20261102T224509` 的 `43-assert`（磁盘上 A 的批量会话 `batch.json`/`inventory.json` 恰含 a/b/c 三键；中枢 `plans/fxa` 的 `selfKey=a`、`targets=a/b/c`；根队列 `waiting=[]`）× `40-assert`（重启不产生新台账/不回退）× `44-assert`（含宿主自重启产生的实例全部退出）就是「官方桌面 A 自更新触发 relaunch 后中枢计划仍在、B/C 完成」的现成白盒证据。该窗口曾暴露 `check-expired` 竞态（T5 记录 205101），已由 `997ad69`（`src/host/batch/phones.ts:97-102` 有界重试，最多 2 次、300ms 退避）修复。本票的 web 双宿主 run 补的是**lease 时间线 + orphan 接管（adoptOrphanPlan）细节**；桌面 relaunch 的 gen+1 takeover 仍以 T5 证据为准，本票未重复注入。

## 7. 环境非确定性

- **日志落盘竞态**：`batch.json` 落 `done` 与 exec 日志行落盘有毫秒级先后。试错 `271-20261103T013804` 因此误报「C exec 缺失」（实际 exec ts=1793641141696 在 batch 之后才可读）。定稿场景在正常格用 `waitForExecRows`（300ms 轮询、最多 20s）等 B/C exec 行出现；can-red 分支按设计直接读。
- **Node fetch 不保存 cookie**：默认跟随 303 但不持久化 Set-Cookie，直接 GET 带 token URL 会被重定向到无 token 的 `/` 并 401。页面恢复格改为显式两步握手（303+cookie → 带 cookie 200），与浏览器行为一致。
- **PowerShell 包装脚本的返回码捕获**：门禁脚本一次性运行 6 个门禁时，函数输出与返回码混在管道里导致汇总行误报 fails，实际每个门禁的 `EXIT=0` 行才权威（见 §10）。
- 本票运行期未遇到 pnpm rename `EPERM` 瞬态；单场景 66–76s，远低于 15 分钟预算。

## 8. 试错 run 记录（全部在仓库外 `D:/dsh-plugin/_wt263/runtime/t7-271/`，`--no-evidence-sync`，未复制进仓库）

| 试错 run | 模式 | 结果 | 修掉的问题 |
| --- | --- | --- | --- |
| 271-20261103T013215 | handoff | fail | 4 个 harness 问题：①队列目录断言在首次安装前误判（目录未创建）②`batchCheck` 回包 `session.order` 在检查阶段为空，改断 `rows` 三键 ③B 的 exec 过滤误用 `fxb-b`，改用 A 的 `batch.targets` 前缀映射 ④抓日志 helper 提前关掉第二代宿主，导致后续面板电话 fetch failed，拆成收尾统一 `finalizeHosts` |
| 271-20261103T013804 | handoff | fail（仅 #50） | C exec 日志行落盘晚于 batch done（见 §7），加 `waitForExecRows` |
| 271-20261103T013946 | handoff | pass（32 断言/38 raw） | — |
| 271-20261103T014054 | page-recovery | fail（#67/#69） | ①Node fetch 跟随重定向丢 token → 401，改两步握手 ②`batchStatus` 的 `progress` 在 reply 顶层而非 `session.progress` |
| 271-20261103T014736 | page-recovery | pass（39 断言/46 raw） | — |
| 271-20261103T014857 | can-red | fail/1（24=23+1，预期） | — |

试错期另有一次参数属性 TS 语法崩溃（无 run 目录，Node 24 strip-only 不支持 constructor 参数属性）。

## 9. 证据卫生与边界

- **共享 home/profile 的取舍**：两个宿主同 home/profile 是为了共享同一把全局锁、同一个 hub 目录与同一份台账；由此 `sessions/`、`storages/` 等非本票观察面可能串台，**不在本组断言范围**，已在每个 run 的 note 与声明里写明。
- **shots=0**：通道 B 无桌面窗口，页面恢复用 HTTP 握手 + 面板电话证明，不用截图冒充 UI；g7 的宿主通道声明也是 `dsh-web`。
- **时间窗口径**：`readLogEvents` 丢 `ts`，场景自己递归读原始日志行保留 `ts`；exec 窗口 = `[ts-durationMs, ts]`，锁/队列时间线用 120ms/500ms 采样。
- **raw 原文**：换手前后 `lease.json`、`hub/plans/*.json`、`batch.json`、`queue` 目录快照与两代 pid/port/start 时间线都在 `raw/`；can-red 存删前/删后 plan 原文与 `state-at-kill`。
- **试错 run 不入库**：所有试错都带 `--no-evidence-sync`；提交 `test(#271)` 前核对过 `selftest/evidence/runs` 无 `271-*`，定稿三 run 才复制入库。
- **台账路径**：`<home>/updates/<pluginId>/<shortHash(profileDir)>/state.json`，`pluginId` 是目标前缀（`fxa-a/fxa-b/fxa-c`），不是包名；租约/plan 在 `<home>/update-queue/<shortHash(profileDir)>/hub/`。

## 10. 门禁

在定稿证据与声明/矩阵改动就位后串行执行（脚本 `D:/dsh-plugin/_wt263/runtime/t7-271/gates.ps1`，日志 `gates.log`），六个门禁逐条 `EXIT=0`：

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| tsc（selftest） | `npx tsc -p selftest/tsconfig.json --noEmit` | exit 0 |
| tsc（tooling） | `npx tsc -p selftest/tsconfig.tooling.json --noEmit` | exit 0 |
| fixture 计划单测 | `node --test selftest/fixtures/generator/fixture-package-plan.test.ts` | 1 test / 1 pass / 0 fail（395 条断言；含声明↔矩阵反向校验） |
| build | `npm run build` | exit 0 |
| 批量定向测试 | `npm run test:batch`（build 之后） | 192 tests / 192 pass / 0 fail |
| 聚合检查 | `npm run check` | exit 0（2092 tests：2091 pass / 1 skip / 0 fail） |

未出现 E3b 既有 flake，无需重跑。

## 11. 提交与合并

本分支（`impl/263-t7`）提交：

- `5bbc166` `test(#271): add hub continuity scenarios (g6/g7) and runner`（`scenario-declarations.ts` 两条声明、`h-hub-continuity.ts`、`run-g-hub.ts`、coverage-matrix g6/g7/can-red 行占位）。
- 本笔记 + 证据账本更新（coverage-matrix 状态列、runs/README 三行、`selftest/evidence/runs/271-*` 三个定稿 run）随 `docs(#271)` commit 提交。
- 未改 `src/`（无产品 BUG），无 fix commit。
- 合并：`git merge --no-ff impl/263-t7` 进 `D:/dsh-plugin/_wt263/integration`（分支 `integration/spec-263`），未 push；合并 commit hash 见最终报告与 `git log -1`。
