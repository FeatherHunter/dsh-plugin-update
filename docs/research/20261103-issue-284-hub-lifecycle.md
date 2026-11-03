# #284 C 组：中枢生命周期与 profile 隔离 —— 决策笔记

票：[FeatherHunter/dsh-plugin-update#284](https://github.com/FeatherHunter/dsh-plugin-update/issues/284)（父规格 #263，C 组）。实现分支 `impl/284-hub-lifecycle`，基线 `37efcad`（T14 开工时 integration/spec-263 tip）；定稿证据跑在 `2080f29`（test(#284)）构建上，SUT dist 指纹 `ff0a6b1a…`（208 文件），四 run 的 `run.json` 都记录了同值 head/dist。

## 1. 一句话结论

四场景全部真机跑通（M1/M2/M3/M4 pass，共 30+34+36+33 条断言；unknown=0），can-red 真失败 run 为 fail/退出码 1 且唯一红点可归因到注入的「删 hub plan」。**本组真机发现并修复了两处产品缺陷**（续跑行重查把 current/done 当 check-expired 失败而丢行；CLI 安装失败后 profile 依赖边被写到目标版但包没装成、下一行读到坏清单），因此本分支包含 `src/` 改动（`fix(#284)` commit `4858754`），与「只动 selftest」的测试分支不同，见 §4。

## 2. 设计与路线

### 2.1 通道、隔离与夹具

- 通道 B（普通 DSH web 宿主，`selftest/real-machine/host/cli-host.ts` `startCliHost`）：隔离 `os-home/`、`homeDir=os-home/.dsh`、非 desktop 普通 profile（M1–M3 `t14hub`；M4 `t14p1`/`t14p2`），每个 run 用独立 `--user-data-dir`/端口/仓库外 verdaccio（`runtime/t14-284/<runId>/registry`）。
- 每个 run 现场发基版（声明里的 `install`）与带 run stamp 的 0.0.2 变体（`publishScenarioVariants`）；SUT 用工作树 `npm pack` 的 dsh-plugin-update@0.18.39 发布到本地 registry，并在装进 profile 后核对 dist 聚合指纹 = 工作树 dist（`13-sut-installed-dist.json`），防止跑到 npm 上游旧版。
- 隔离安装预算：一般 4s（`DSH_SELFTEST_INSTALL_TIMEOUT_MS`，压锁陈旧阈值才能观察换手）；M3 用 120s（坏 tarball 的 pnpm 失败要 ~73s）；M4 用 30s（两宿主共享 pnpm store，安装更慢）。M4 额外关掉继承自维护者全局 pnpm 配置的 `minimumReleaseAge`（`npm_config_minimum_release_age=0`，`raw/19-m4-pnpm-supply-chain-isolation.json` 记录原因）：现场发布的 fixture/SUT 被判 too-new 是环境噪声，与队列/锁隔离语义无关。

### 2.2 换手注入（M1/M2）

- 第一代宿主上发 A 的批量安装（`fxa.batchInstall`，`selfOrder='first'`，顺序 a→b→c），**不 await 回包**；120ms 轮询盘上 `batch.json` 捕获窗口（`a=done` 且 b/c 非终态），然后 `taskkill /T /F` 杀第一代进程树（`raw/35-host-stop-host1-kill.json`）。
- 用 `dsh plugin remove` 从 profile 摘掉要「不回来」的集成方（M1 摘 B、M2 摘 A），再在同一 home/profile 起第二代宿主（`raw/39-cli-host-launch-host2.json`）。M2 还有第三幕：再把 A 装回、B 摘出，起第三代宿主验证跨宿主方案保留。
- 与官方桌面 relaunch 的等价性：执行者消失、新执行者从盘上 plan/session 恢复。差别如实记录：web 整进程退出会释放 hub 租约，第二代是「租约空 → 重新 acquire generation=1」（`lease.pid` 换成新宿主 pid），不是桌面 relaunch 的 takeover(gen+1)；本票不硬断言 gen+1、不伪造 takeover（与 #271 同口径）。
- 换手窗口与恢复全程只发只读电话（`batchStatus`/`updateHubStatus`/`updateCheck`），不点「继续/重试」、不给 B/C 发任何 drive 电话。

### 2.3 观测面（为什么不是截图）

- 换手窗口内没有可点窗口（web 通道无桌面 UI，第一代随时被杀）：安装窗/续跑判定用 `raw` 里盘上 `batch.json`（逐行 phase/targetVersion）、`hub/plans/*.json`（plan 字节/哈希、sessionId）、`hub/lease.json`（pid/generation/driverId）的**原文快照**，加上产品日志按插件分文件后 `update.install.exec` 的 `ts`/`durationMs`/`route`/`ok`/`exitCode`（exec 窗口 = `[ts-durationMs, ts]`）。
- 台账 = `<home>/updates/<pluginId>/<shortHash(profileDir)>/state.json`（`raw/45/46/58` 复制原文并解析 state/targetVersion/previousVersion）；磁盘 = profile `package.json` dependencies + node_modules 包版本；面板 = 真机电话 `batchStatus` 三行 + `updateHubStatus` snapshot.progress。
- M3 是**真 UI 入口**：Playwright + chromium-headless-shell 打开 web 宿主页面，真实点击 A 面板里的「全部更新」，失败后点行内「重试」（`raw/26-m3-ui-open-initial`、`33-m3-batch-started`、`39-m3-panel-partial`、`55-m3-ui-close-after-retry`）。
- M4 不开浏览器：同 tick 用 HTTP 电话发出两批（面板「全部更新」背后是同一入口），断言对象是更新队列/中枢锁按 profile 隔离与两个安装窗真并发；UI 三包入口证据由 M3 同一面板承担（`addNote` 如实标注）。

### 2.4 断言纪律

每条 `run.record` 都带 `step/what/expected/actual/verdict`；unknown 不算通过（定稿 unknown=0）；can-red 用 `fail` 记录（不是抛异常），run 退出码 1。证据包 `runs/<runId>/{run.json,index.md,shots/,raw/}` 由 `copyRunEvidence` 复制进仓库；试错 run 用 `--no-evidence-sync` 只留仓库外（`runtime/t14-284/quarantine` 等）。

## 3. 逐格证据（全部在 HEAD `2080f29` / dist `ff0a6b1a…` 上跑）

### 3.1 M1 只回来 A（`runs/284-20261103T224027`，pass / 退出码 0，30 断言 / 38 raw，~55s）

- 第一代宿主 pid=21528、port=55228、boot=2145ms；换手窗口 `raw/32-state-at-kill.json`：`plans=["fxa.json","fxb.json"]`、`phasesA={"a":"done","b":"installing","c":"ready"}`、lease `{pid:21528,generation:1}`。
- 杀第一代 → 摘 B（`raw/37-remove-owner-b.json`：bundles 不含 fixture-b，B 目录版本 null）→ 第二代宿主 pid=21500、port=65405（`raw/39`），start ts=1793716846738。
- 自动接管：`update.batch.run.start trigger=resume resumed=true total=3 sessionHash=44cc80da`（ts=1793716846991），与 entry 会话 sessionHash 相同；B/C 各 1 条成功 exec 且都在第二代 start 之后（`raw/44-log-timeline.json`），无安装期 exec 失败。
- A 自键 1 次成功：`installRequestA=1`、`host.call fxa-a.updateInstall ok`；**A 自键没有 exec 行**（产品自更新走 host.call 换载，真机确认）。
- fxb 未被冒领：`fxbHashBefore=fxbHashAfter=55e2b405…`、`fxbExecB/C=[]`、`fxaExecB=1/fxaExecC=1`。
- 终态：面板三行 done、progress `{total:3,done:3,failed:0,finished:true}`；中枢 `state=finished`、`activeInstall=null`；磁盘 dependencies/node_modules 三包 0.0.2；台账 fxa-a `completed target=0.0.2 previous=0.0.1`，fxa-b/fxa-c `completed target=0.0.2 previous=null`（本批首装无旧版）；清理无残留。

### 3.2 M2 只回来 B（`runs/284-20261103T224122`，pass / 退出码 0，34 断言 / 47 raw，~2 分钟含第三幕）

- 第一代 pid=42480；窗口同形（`raw/32`）；摘 A、保留 B；第二代 pid=29248、port=58281。
- 第二幕（只回来 B）：B 续跑自己的 fxb `total=2 sessionHash=e91f19d9`，B/C 的 fxb 行 done；fxa.json 字节/哈希不变、无任何 fxa 行执行（A 的目标 a 不被 B 安装，A 已摘出 profile）；fxb 台账 b/c 各 1 条成功终态。
- 第三幕：只装回 A（B 摘出、A@0.0.2 重新在册），第三代 pid=37868；A 采纳跨宿主 fxa 方案 `resume resumed=true total=3 sessionHash=d84ef6e1`（= act1 entry 的 sessionHash），三行终态无 failed；磁盘 a/b/c 全 0.0.2；台账 fxa-a/fxb-b/fxb-c 各 1 条成功终态，无重复/丢行。
- exactly-once：`{fxbB:1, fxbC:1, fxaB:0, fxaC:0}`（每个目标至多一次成功 exec；中断首试允许恢复重跑一次）。面板/中枢终态与 M1 同形（done3 failed0 activeInstall=null）；清理无残留。

### 3.3 M3 A 行失败但 A 仍活着（`runs/284-20261103T224225`，pass / 退出码 0，36 断言 / 39 raw，~5 分钟）

- 真 UI：chromium-headless-shell 打开 web 宿主页面，A 面板三行齐全、就绪态「3 个可更新」；从面板点「全部更新」发起批量（`raw/33-m3-batch-started.json`）。
- 故障注入（`raw/31-m3-registry-tarball-corrupted.json`）：只改 A@0.0.2 tarball 的 64 字节（offset 58165），`sha256 58e0a978… → 53125b1a…`；**版本元数据/integrity/shasum 一字不动（`versionDocUnchanged=true`），HTTP 仍 200** ⇒ check 能过、install 必失败（不是 check-failed）。
- 部分失败落定（`raw/36-m3-partial-settled.json`）：磁盘 a=0.0.1、b/c=0.0.2；台账 fxa-a `failed target=0.0.2 previous=0.0.1`、fxa-b/fxa-c `completed`；面板 A 行 `phase=failed`、status「最后手段安装失败，请选择「重试」。」、fail 文案含 install-failed；B/C 行 done 0.0.2；总账不出现「已全部为最新/3 个已是最新」。
- A 插件仍活着：宿主进程在、A 的 updateCheck/updateStatus 电话可达；中枢继续泵、租约未被外来驱动者占用（`raw/44`/`63`）。
- 恢复（`raw/47-m3-restore-tarball.json`）：还原 tarball 字节，`restoredSha256=58e0a978…（shaMatches=true）`，元数据未动；清掉 run 私有 pnpm store 的坏缓存；真 UI 点 A 行「重试」（只重试 A）。
- 重试后：磁盘 a/b/c 全 0.0.2；台账三包各 1 条 completed（A 由 failed→completed，B/C 不重复、不重装）；batch entries 三行 done；日志 `execA=[坏包 ok=false exit1 durationMs=72784, 重试 ok=true exit0 durationMs=1038]`、`execB ok 1008ms`、`execC ok 1010ms`；`entryFailRows=[{stage:'settle',index:0,errorKind:'install-failed'}]`、`installFailRows` = gate check-expired ×3 + exec nonzero-exit ×1；两次 summary `total3 ok2 failed1` → `total3 ok3 failed0`。
- 重启后一致（host2 + `raw/61-m3-final-state.json`）：UI 三行 done、A 卡 client v0.0.2/host v0.0.2、账本「3 个已是最新」、summary「已全部为最新，无需操作。」；台账 3 条成功终态；磁盘 0.0.2；租约正常释放（`raw/63`）；清理无残留。

### 3.4 M4 跨 profile 并发（`runs/284-20261103T224418`，pass / 退出码 0，33 断言 / 38 raw，~3 分钟）

- 同 home 两个普通 profile：p1 hash `bd5189e2…`、p2 `a328f0af…`；各装 A/B@0.0.1 基版；两宿主 pid=40412/20304，各自 `hub/lease.json` owning 自己（generation=1）。
- 同一 tick 发两批（settle 时间都是 `1793717079243`）；并发采样 41 帧（`raw/46-m4-concurrency-samples.json`）：`overlapFrame t=1793717079367` 两批都 `active=3`、batchIds `mw0su47h-6j3jtdhxhq` / `mw0su47i-ixf3kjlk8m`；`ownerOverlapFrame t=1793717079734` 两队列 owner 同时为 `pluginId=fxa-a`（不同 jobId，startedAt 1793717079655 / 1793717079617）。
- 两批都三行 done target 0.0.2；磁盘两 profile 三包全 0.0.2；台账按 hash 分组各 3 条（A previous=0.0.1，B/C 本批首装 null），`foreign=[]`；盘上 `update-queue` 正好两套目录（= 两 profile 短哈希），无抢占。
- 日志（`raw/72-m4-log-timeline.json`）：`okExecB=2, okExecC=2, overlapB=1, overlapC=1, busyRows=0`——B 的两个成功 exec 窗口（`[1793717082040-1018,1793717082040]` 与 `[1793717082070-1008,1793717082070]`）交集 30ms，C 约 84ms；说明两 profile 的安装窗真重叠、互不阻塞。两电话回包 ok、面板三行 done、中枢 finished done3 failed0、清理无残留。

## 4. 产品缺陷与修复（真机发现，2 处，均已修 + 回归）

### 4.1 续跑行重查把 current/done 当 check-expired 失败 → 丢行（M2 首跑 `284-20261103T182721` 发现）

- 症状：宿主换手后行是 ready/installing、receipt 丢了；重查时目标可能已被**另一批量的安装**装到目标版（`again.kind=current` 或 `done`），旧代码一律记 `failed(check-expired, stage=check)`，续跑行丢单。
- 修（`src/host/batch/phones.ts` + `fan-out.ts`）：新增 `satisfiedByRecheck`——仅当 `installedVersion >= targetVersion`（`compareReleaseVersions`）才收 `done`，空/更低版本一律仍按失败处理（绝不吞真失败）；默认安装与 check-expired 退避重试两处都接；`fan-out.ts` 把 `targetVersion` 传给 `defaultInstall`。
- 回归：`tests/batch-resume-current.test.mjs`（5 用例：current 收 done、done 透传、低版本仍失败、读不到版本仍失败）。

### 4.2 CLI 安装失败后清单/磁盘撕裂（M3 首跑 `284-20261103T192601` 发现）

- 症状：pnpm 装失败时 `<profile>/package.json` 的依赖边已写到目标版、包却没进 node_modules；批量继续下一行时读到坏清单，B/C 被 A 的坏 tarball 一起拖死，且没有失败补偿。台账 message 原文「install-failed: … ERR_PNPM_TARBALL_INTEGRITY …」。
- 修（`src/shared/ports.ts`、`src/core/service.ts`、`src/core/executor.ts`）：`runInstall` 加可选 `previousVersion`（加法扩展，不传即现状）；`service.ts` 把 `job.previousVersion` 随安装电话交回宿主；`executor.ts` 在 cli 路失败后按依赖边回滚（`rollbackFact`/`runCliRollback`/`cliTargetSpecOf`/`dependencyEdgeOf`/`lockDependencyVersionOf`/`rollbackVerified`），回滚后仍按原语义抛错（不吞失败）；回滚 spawn 经 receiver 绑定（`subprocess.spawn` 直接外传会丢 this，真机表现为「起不了回滚进程」）。
- 回归：`tests/issue-284-cli-rollback.test.mjs`（8 用例，含 `subprocessFor` 假件钉丢 receiver 回归）。
- 修复后真机表现（本 run）：坏 tarball 的 A 行 exec ok=false 73s 后失败，磁盘 a 仍 0.0.1（回滚成功），B/C 不受拖累装成 0.0.2；恢复后重试 A 行 ok=true。

## 5. can-red 真失败（`runs/284-20261103T224448`，fail / 退出码 1，21 断言）

- 注入：M1 换手窗口里 `unlink` `hub/plans/fxa.json`（`raw/39-can-red-plan-before-delete.json` 留删除前 plan 原文与 sessionId `mw0sumhb-vd5npzn1yy`；`40-can-red-plan-deleted.json` 留删除事实）。
- 结果（`raw/49-can-red-verdict-facts.json`）：`phases={a:done,b:installing,c:ready}`、`allTerminal=false`、`elapsedMs=45148`、`runStartRows` 只有 entry（`resumeRunStart=0`）、`execAfterHost2=[]`、`planANamesAfter=["fxb.json"]`。
- 断言口径：`broken = !allTerminal || phases.b!=='done' || phases.c!=='done' || execAfterHost2===0 || resumed===0` → `verdict='fail'`（不是抛异常），run 退出码 1；21 条断言里恰好 1 条红，红点可归因到注入的 plan 丢失，其余 20 条仍 pass（说明红的是被测断言本身，不是环境/工具坏）。

## 6. 限制与诚实标注

- 通道 B 无桌面窗口：`shots/` 为空目录（#267/#271 web 格先例）；M3 的 UI 证据是真实浏览器 DOM/面板文本（不是伪造截图），M4 不开浏览器（UI 入口证据由 M3 承担，raw 已注明）。
- 租约语义：web 整进程退出释放租约，第二代 acquire generation=1；官方桌面 relaunch 是 takeover(gen+1)。本票只记录实测 pid/generation，不硬断言 gen+1。
- 同 home 两宿主共享 `logs/` 文件：M4 停宿主前 sleep 3s（`raw/61-m4-stop-settle.json`）等最后日志行落盘；早期试跑曾出现 C 缺 1 条 exec 日志尾（安装本身成功，由台账按 hash+磁盘补证），定稿 run 已完整（okExecC=2）。
- M4 的 `minimumReleaseAge` 是环境噪声（维护者全局 pnpm 配置泄漏进隔离 os-home 的 carrier 安装），run 内用 `npm_config_minimum_release_age=0` 隔离并在 raw 记原因；不是产品应清洗父环境的结论性证据，只在报告单列观察。
- M1/M2 的「只回来一个」用「杀宿主 + 改 profile 在册 + 重启」构造（web 通道等价形态）；桌面 relaunch 的真实换手证据属 #271/#276 口径，本票不冒充。
- 未跑 `npm run check` 全量之外的门禁均绿（见 §7）；未 push、未 merge（由 Lead/收尾人处理）。

## 7. 复现命令与证据清单

```powershell
$env:DSH_VERIFY_PLAYWRIGHT='D:/2Study/OpenClaw/node_modules/playwright'
$env:DSH_SELFTEST_CHROMIUM_EXECUTABLE="$env:LOCALAPPDATA\ms-playwright\chromium_headless_shell-1248\chrome-headless-shell-win64\chrome-headless-shell.exe"
cd D:/dsh-plugin/_wt263/t14
node selftest/real-machine/tools/run-hub-lifecycle.ts --mode m1 --run-base-dir D:/dsh-plugin/_wt263/runtime/t14-284
# 同 --mode m2 | m3 | m4 | can-red；试错加 --no-evidence-sync（不复制进仓库）
```

定稿证据（`selftest/evidence/runs/`，均含 run.json/index.md/raw/）：

| runId | 场景 | 判定 | 退出码 | 断言 |
| --- | --- | --- | --- | --- |
| 284-20261103T224027 | m1-hub-orphan-only-owner-a-returns | pass | 0 | 30 |
| 284-20261103T224122 | m2-hub-orphan-only-owner-b-returns | pass | 0 | 34 |
| 284-20261103T224225 | m3-owner-a-row-fails-still-alive | pass | 0 | 36 |
| 284-20261103T224418 | m4-cross-profile-concurrency | pass | 0 | 33 |
| 284-20261103T224448 | m1-hub-orphan-only-owner-a-returns（can-red） | fail（预期） | 1 | 21（恰 1 红） |

门禁（定稿 HEAD `2080f29` 上、build 后）：tsc selftest=0、tsc tooling=0、fixture-package-plan.test 绿、`npm run build`=0、`npm run test:batch` 197 pass / 0 fail、`npm run check` exit 0；定向 `node --test tests/issue-284-cli-rollback.test.mjs`（8 pass）、`tests/batch-resume-current.test.mjs`（5 pass）。
