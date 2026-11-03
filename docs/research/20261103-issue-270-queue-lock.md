# #270 T6：两个入口同时更新同一 profile/target 的队列与锁 —— 决策笔记

日期：2026-11-03。工作树：`D:/dsh-plugin/_wt263/t6`（分支 `impl/263-t6`，基线 HEAD `9190365` = `integration/spec-263` tip，T0–T5 已合入）。定稿证据的 SUT commit：`025e50a`（`test(#270)`，场景/声明/工具）。

## 1. 一句话结论

两个**独立 DSH web 宿主进程**（通道 B；同一 USERPROFILE/osHomeDir、同一 `homeDir=osHomeDir/.dsh`、同一 `profile=t6lock`，因而同一 profileDir）对同一 target=A@0.0.2 并发更新：顺序时序 h1 与同时刻 h1b 全部 pass（各 25 断言）——恰一个 `update.install.exec` 真跑（`route=cli-process`、ok、exitCode=0），另一入口被 `update-busy` 稳定拒绝，安装窗落在同一把 `global.lock` 的单一持有区间内，profile 未损坏、台账恰一条成功终态、失败方重试收敛；陈旧锁回收 h2 pass（20 断言）——`stale-owner` anomaly + `queue.transition reclaimed` 后继续装成；can-red 真失败 run（12 断言 = 11 pass + 1 fail，退出码 1）——入口 1 持锁安装中删除两把锁并清空 `queue.json` 后第二安装越过互斥（exec=2、窗口重叠、`admittedB=true`），唯一红可归因。**产品无 BUG，未改 `src/`。**

## 2. 设计与路线

- **为什么用两个通道 B 宿主而不是官方桌面**（Lead 决策 m00192 + P1–P3 探针）：
  - P1（`runtime/t6-270/probes/p1-raw.json`）：官方发行 CLI 载体在隔离 DSH_HOME 跑 `--profile desktop --from-default-profile web --dump-config` → stderr `error: profile "desktop" is managed exclusively by the Electron application`，exitCode=1（对照 `--profile t3probe` exitCode=0）；`dsh plugin --profile desktop list` 要求先打开官方桌面初始化。⇒ headless 通道 B 不能与官方桌面共享 profile desktop。
  - P2：官方桌面 + 共享 `DSH_HOME` + 独立 `--user-data-dir` 可启动（bootMs=457，单个 CDP 目标，无独立 HTTP 电话入口）。
  - P3：两个 cli-host 同 home+profile 同时起成功（无单实例锁；端口 53272 / 63599）⇒ 两个通道 B 宿主进程解析到同一 profileDir，可抢同一把锁。
- **两个真机入口**：`startCliHost()` 起两个独立进程（各自 pid/port/URL）；通道 B 无窗口，电话 `updateCheck/updateInstall/updateStatus` 即真机入口（与 e1 同先例，T6 不借用 UI）。
- **隔离口径**：每 run 独立 `osHomeDir=<run>/os-home`、`homeDir=osHomeDir/.dsh`、`profile=t6lock`；`startCliHost` 设 `USERPROFILE=osHomeDir`，产品按 `homedir()/.dsh` 解析 home ⇒ 两宿主同 home/profile。每 run 独立端口、仓库外 verdaccio（run 内独立 storage）、run 私有 pnpm store。
- **锁/队列路径**（raw/16、raw/22 记录绝对路径，不是推断）：`queuePathsForUpdate(homeDir, profileDir)` = `<home>/update-queue/<shortHash(profileDir)>/{queue.json,global.lock}`（`src/core/queue/ports.ts`，短哈希 = sha256(profileDir) hex 前 24 位，`src/core/store-base.ts`）；基锁 = `<home>/updates/<pluginId>/<同一短哈希>/install.lock`。产品侧 pluginId 用目标前缀 `fxa-a`（不是 packageName）。
- **观测面**（不依赖 UI）：
  - 锁/队列时间线：场景进程 10ms 轮询 `global.lock` 与 `queue.json`，记录 lock present/id/pid/startedAt/pluginId 与 queue owner/waiting 快照（raw 里 `samples`/`lockIds`/`lockIntervals`/`finalQueueRaw`）。
  - 安装窗：`update.install.exec` 日志行原文的 `ts` 与 `durationMs` 还原为 `[ts-durationMs, ts]`；锁区间由轮询样本归并，给 ±1000ms 容忍（raw/53、52 记录 `toleranceMs` 与 note）。
- **mode → 声明**（can-red 复用 h1，注入点在 run notes/raw 标记）：

| mode | 场景声明 id | 用途 |
| --- | --- | --- |
| `concurrent-lock-window` | `h1-queue-lock-concurrent` | 入口 1 受理并持锁后，入口 2 在锁窗内到达（顺序时序） |
| `concurrent-simultaneous` | `h1b-queue-lock-simultaneous` | 两入口同一 Promise.all 批次几乎同刻发安装（同时刻时序） |
| `stale-reclaim` | `h2-queue-lock-stale-reclaim` | 预写 pid 已死/60s 前 `global.lock` + 安装预算 4s → 二次核对回收后继续装 |
| `can-red` | `h1-queue-lock-concurrent` | 删两把锁 + 清空 queue.json → 第二安装越过互斥（预期红） |

- **代码位置**：`selftest/real-machine/scenarios/h-queue-lock.ts`（`runQueueLock`）、`selftest/real-machine/tools/run-h-queue-lock.ts`、`selftest/fixtures/identity/scenario-declarations.ts`（h1/h1b/h2 三条声明）。
- **共享 home 的取舍**：两宿主共享 home 是为共享同一把 `global.lock`；`sessions/storages` 等其它状态串台不在本组断言范围（写进每个 run 的 notes）。

## 3. 逐格做法与证据

三个 pass run 的 `run.json.environment.head` 都是 `025e50a`、`sut.distDigest=e8cef960ed4baca3…`、`installedDistMatch=true`；`cleanup` 段宿主进程 `aliveAfterStop=false`、端口 `released=true`。

### 3.1 h1 顺序时序（run `270-20261103T004659`，pass / 退出码 0，25 断言 / 41 raw，68s）

动作：两宿主起好后各发 `updateCheck`（都发现 0.0.2）→ 入口 1 发 `updateInstall` → 场景进程轮询到 `global.lock` 出现（raw/28：t=1793638077473 首次 present）→ **立刻**入口 2 对同一 target 发 `updateInstall`。

锁/队列时间线（raw/50，10ms 采样）：
- `t=1793638077343` lock absent，queue 尚未写；
- `t=1793638077359` queue `waiting=[{pluginId:"fxa-a",requestId:"h1-a-1793638077342",enqueuedAt:…347}]`，lock absent；
- `t=1793638077374` lock present：`{"id":"58ed5fc7-7f78-451e-bb70-553c631e0ef1","pluginId":"fxa-a","pid":69620,"startedAt":1793638077361}`（pid=宿主 A）；
- `t=1793638077405` queue `owner={pluginId:"fxa-a",jobId:"58ed5fc7-…",requestId:"h1-a-…",targetVersion:"0.0.2"}`、`waiting=[]`。

关键断言：
- `31-assert` 两入口同时抢锁：A `ok=true/job.state=installing`（126ms）；B 外层电话 ok、`reply.ok=false/error=update-busy`（46ms）。
- `52-assert` `update.install.exec` 行数=1，窗口 `[1793638077401, 1793638078963]`（durationMs=1562，route=cli-process，ok=true，exitCode=0）。
- `54-assert` 全局锁 id 唯一（`58ed5fc7-…`），锁区间 `[1793638077374, 1793638079000]`；exec 窗口落在其中 ⇒ 两安装窗不重叠（任一时刻至多一个 pnpm 安装）。
- `56/58-assert` queue.transition phases `{queued:2,running:1,done:1,abandoned:1}`（无 reclaimed）；`busy-owner` anomaly=1、gate-refused=3；拒绝可归因（raw/57 的 refusalCodes：`update-busy/recovery-required/installation-changed/check-expired`）。
- `60/62-assert` 磁盘 dependencies/package.json 可解析/磁盘版本=0.0.2、bundles 完整；台账 `updates/fxa-a/<hash>/state.json` 恰 1 条 `completed`（target=0.0.2、previous=0.0.1、requestId=`h1-a-1793638077342`），无重复/丢单。
- `64-assert` 队列收尾 `owner=null`、`waiting=0`。
- `33/41/43/45-assert` 赢家 completed；重启宿主 C 后 `runningVersion=0.0.2`、`buildTag=host v0.0.2`（profile 未损坏、能正常 boot）；fresh check `canInstall=false`；强制再装诚实拒绝 `check-expired` 且 exec 行数仍=1。
- `66-assert` 三宿主进程全退、端口释放。

### 3.2 h1b 同时刻（run `270-20261103T004808`，pass / 退出码 0，25 断言 / 40 raw，38s）

动作：两宿主各自 `updateCheck` 后，`Promise.all` 同时发两个 `updateInstall`（不 await 完成），再各自轮询 `updateStatus` 到终态。

- `22-assert` 两入口同 profile：pidA=84008/portA=54419/bootMs=5235，pidB=30360/portB=58700/bootMs=4876，queueDir=`…/update-queue/ac7600c5c6530399ef16e20f`（两边解析到同一目录）。
- `30-assert` 同刻抢锁：A `ok=true/job.state=installing`（404ms）；B 回包 `{ok:true,reply:{ok:false,error:"update-busy",errorKind:"update-busy",diag:{stage:"preflight",route:"queue",detail:"同一使用范围内存在进行中的安装任务"}}}`（49ms）。
- `51/53-assert` exec=1，窗口 `[1793638115678,1793638117669]`（1991ms）；锁 id 唯一（`07b64a9f-…`），区间 `[1793638115548,1793638117714]`。
- `55/57-assert` phases `{queued:2,abandoned:2,running:1,done:1}`；busy-owner=1、gate-refused=3。
- `61/63-assert` 台账恰 1 条 completed（requestId=`h1-a-1793638115501`）；队列收尾 `owner=null/waiting=0`。
- `32/40/42/44/65-assert` 赢家 completed；重启后 v0.0.2/buildTag=host v0.0.2；fresh check 收敛；强制重装 `check-expired` 且 exec 仍=1；清理干净。

### 3.3 h2 陈旧锁回收（run `270-20261103T004847`，pass / 退出码 0，20 断言 / 29 raw，28s）

动作：基版 + 变体发布后（尚未起宿主）预写 `global.lock`：`{"id":"selftest-stale-20261103T004847","pluginId":"fxa-a","pid":999999(已死),"startedAt":now-60000}`（raw/20，`deadPidAlive=false`、ageMs=60000；payload 形状照 `src/core/queue/ports.ts` 的 `createGlobalLock`）；宿主安装预算压到 4000ms（raw/19 `DSH_SELFTEST_INSTALL_TIMEOUT_MS=4000`，经夹具 `installTimeoutMs` → `src/host/capabilities.ts:296-299` 传给 `tryAcquireGlobalLock`）；起 1 宿主 → `updateCheck` → `updateInstall`。

- `37-assert` `lock.anomaly kind=stale-owner` 恰 1 条：`ageMs=64339`、`ownerHash=b9ae1254`（= 对预写 payload 按 `lockOwnerHash` 复算）；`busy-owner=0`（陈旧锁没被误判新鲜）。
- `38-assert` `queue.transition phase=reclaimed` 恰 1 条（`holderHash=0f7833d2`=hash8(`fxa-a`)），随后 exec=1、ok、exitCode=0。
- `39/34-assert` 锁时间线：锁 id 两代 `[selftest-stale-20261103T004847 → a58cb93c-f0d3-4cf5-be99-ec0f89fab914]`，区间 2 段，末次 `lockPresent=false`（最终释放）。
- `41-assert` phases `{queued:1,reclaimed:1,running:1,done:1}`。
- `43/45/47-assert` 磁盘 0.0.2；台账恰 1 条 completed（requestId=`h2-stale-1793638149507`）；队列收尾干净。
- `49-assert` 宿主停止、端口释放。

### 3.4 can-red 真失败（run `270-20261103T004915`，fail / 退出码 1，12 断言 = 11 pass + 1 fail，29 raw，25s）

动作：两宿主 + 两 `updateCheck` → 入口 1 `updateInstall` 受理 → 场景进程轮询到两把锁都在（raw/27：global `{"id":"2efae2f6-a795-4434-a6c7-bdb32475e383","pluginId":"fxa-a","pid":68072,"startedAt":1793638175600}`，base 同 id、startedAt=1793638175604，`globalOwnerHash=27597cab`）→ harness 在 `deleteAt=1793638175671` 删除 `global.lock` + `install.lock` 并把 `queue.json` 重写为空队列（raw/28：`queueRawBefore` owner=`{jobId:"2efae2f6-…",requestId:"h1-red-a-…5584",targetVersion:"0.0.2"}` → `queueRawAfter` `{"version":1,"owner":null,"waiting":[]}`）→ **立刻**入口 2 发 `updateInstall`。

- `30-assert`（raw）A/B 均被受理：A `ok=true/job.state=installing`（82ms），B `ok=true/job.state=installing`（169ms，job id `72e4ba24-…`）⇒ `admittedB=true`。
- `37-assert`（raw）`update.install.exec`=2，窗口 `[1793638175629,1793638177424]`（1795ms）与 `[1793638175701,1793638178362]`（2661ms），`overlap=true`。
- `38-assert`（唯一红，预期红）：`admittedB=true；exec 行数=2；重叠=true`；其余 11 条（隔离口径、SUT 钉版、基版安装、变体发布、双宿主启动、清理）仍 pass ⇒ 红点可归因 =「删锁 + 清队列后第二安装越过互斥」。
- `39-assert`（raw，附带证据）台账只剩 B 的 request `completed`（A 的丢了），磁盘 deps=0.0.2，`lockIds` 两代，`finalQueue` 空。
- 本 run 是**断言会红的证明**（故障注入造成互斥失效），不是产品 BUG。

## 4. 产品 BUG

**无。** 真机未暴露需要改生产代码的缺陷，本票未改 `src/`。

附带记录（语义事实，写清避免后来者误判，均非 BUG）：
1. **电话回包双层信封**：外层 `ok` 只表示电话送达；业务受理/拒绝看 `reply.ok`（拒绝时 `reply.error/errorKind`）。h1/h1b 的 B 入口被拒是 `{ok:true,reply:{ok:false,error:"update-busy"}}`。T6 harness 初版把外层 ok 当受理，导致 `003534` 三条假红（§6）。
2. **锁 + 公平门是两层保护**：只删 `global.lock`/`install.lock` 时，第二入口仍会被 queue 公平门拒绝（日志 `update.install.fail` stage=gate、reason=gate-refused），can-red 必须同时清空 `queue.json` 才能测到「锁互斥被破坏」。产品是先到先得，行为正确。
3. **重试语义**：赢家安装完成后，失败方用旧 `checkId/requestId` 重试实测 `error="check-expired"`（check 被赢家安装作废），不是 `update-busy`；空 checkId 强制再装同样 `check-expired`。均诚实拒绝且不产生第二次 exec，失败方随后 fresh check 即收敛（`canInstall=false/installedVersion=0.0.2`）。
4. **陈旧判据只认 payload 的 `startedAt`**（`src/core/store-base.ts` `lockAgeMs`，不检查 pid 是否活着）；回收前有第二次 `probeGlobalLock` + `sameLockGeneration` 核对（`src/core/queue/ports.ts` `tryAcquireGlobalLock`），才记 `stale-owner` + `reclaimed`。h2 与断言的 ageMs/ownerHash 复算与此一致。
5. **失败占位 TTL**：未消费的失败占位在 `owner=null` 时按 30s 过期（`src/core/queue/model.ts` `pruneExpiredIntents`）；本组观察 retry 后 `waiting=[]`、收尾 `owner=null/waiting=0`。

## 5. 环境非确定性

- **共享 home 的状态串台**：两宿主共享 home 只为共享同一把锁，`sessions/storages` 等其它状态串台不在本组断言范围（每 run notes 已写明）。正式场景不启动官方桌面，只起 cli-host。
- **Windows pnpm rename EPERM**（appendix 记录的 rare transient）：本组 4 个定稿 run + 5 个试错 run 均未复现；若复现先重跑，不当并发写坏。
- **探针残留**：P2/P3 探针用 `child_process.spawn` 起的子进程会随 run_code 程序结束被杀，曾留下孤儿桌面进程（已清 PID 74280；维护者官方桌面 PID 91572 未触碰）。正式场景/工具用 `pwsh run_in_background` 托管，单 run 实测 25–68s（预算 ≤15 分钟）。
- **端口/进程清理**：各 run 收尾断言宿主与 registry 端口释放、进程不在（h1 `66-assert`、h1b `65-assert`、h2 `49-assert`、can-red `41-assert`）。

## 6. 试错 run 记录（全部在仓库外 `D:/dsh-plugin/_wt263/runtime/t6-270/`，`--no-evidence-sync`，未复制进仓库）

| run | 场景/mode | 结果 | 说明 |
| --- | --- | --- | --- |
| `270-20261103T003534` | h1 lock-window | fail/1（24 断言） | `callPhone` 把电话外层 ok 当业务受理，B 被拒场景断言误判；改为取 `reply.ok/error` 后重跑。不是产品问题。 |
| `270-20261103T003720` | h1 lock-window | pass/0（25） | 修正后首个绿。 |
| `270-20261103T003808` | h1b simultaneous | pass/0（25） | 同时刻格；确认产品 pluginId 口径=目标前缀 `fxa-a`。 |
| `270-20261103T003955` | h2 stale-reclaim | pass/0（20） | 预写死锁 + 4s 预算；`stale-owner` ageMs=64340、ownerHash 与 payload 复算一致。 |
| `270-20261103T004141` | can-red | fail/1（12=11+1） | 注入定稿（删两锁 + 清 queue.json）后预期红：`admittedB=true/exec=2/overlap=true`。 |

另有一次 `constructor(private …)` 参数属性语法崩溃（Node 24 strip-only 不支持），无 run 目录；场景代码已改为显式字段赋值。

## 7. 证据卫生与日志截断

- 4 个定稿 run 全部入库 `selftest/evidence/runs/<runId>/`：`run.json`（断言/raw/cleanup/notes）、`index.md`、`raw/`（41 / 40 / 29 / 29 个原文片段）；通道 B 无窗口，与 e1 同，不产截图。
- raw 关键件：队列/锁路径与短哈希（`16-queue-lock-paths`、`21/22-two-hosts-same-profile`）、锁首次出现原文（`28-lock-first-present`）、两入口安装回包（`27/28/29/30`，随时序不同）、锁/队列时间线（`50/49/34/36`）、exec 窗口（`51/50/35/37`）、锁区间包含关系（`53/52`）、queue 跃迁（`55/54/40`）、拒绝归因（`57/56`）、台账（`61/60/44/39`）、清理（`65/64/48/40`）。
- 判定只依赖日志原文 `ts`+`durationMs` 与 10ms 锁轮询时间线，不依赖 UI；轮询区间给 ±1000ms 容忍并在 raw 记录 `toleranceMs/note`。
- 日志按 `captureLogFiles` 契约落 raw（整份拷贝，超限另存 tail）；本组日志以 `raw/log-fxa-a-<date>.json` 等原件保留，安装窗/事件均可在原文复核。
- 试错证据只在仓库外 `runtime/t6-270/`；已确认 `selftest/evidence/runs` 下 `270-*` 只有上述 4 个定稿目录。

## 8. 门禁

在 `025e50a` + 本笔记改动上串行执行（脚本 `D:/dsh-plugin/_wt263/runtime/t6-270/gates.ps1`，日志 `gates.log`），全部退出码 0：

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| tsc（selftest） | `npx tsc -p selftest/tsconfig.json --noEmit` | exit 0 |
| tsc（tooling） | `npx tsc -p selftest/tsconfig.tooling.json --noEmit` | exit 0 |
| fixture 计划单测 | `node --test selftest/fixtures/generator/fixture-package-plan.test.ts` | 1 test / 1 pass / 0 fail（347 条断言；含声明↔矩阵反向校验） |
| build | `npm run build` | exit 0 |
| 批量定向测试 | `npm run test:batch`（build 之后） | 192 tests / 192 pass / 0 fail |
| 聚合检查 | `npm run check` | exit 0（2092 tests：2091 pass / 1 skip / 0 fail；双语门禁通过） |

未出现 E3b 既有 flake，无需重跑。

## 9. 提交与合并

本分支（`impl/263-t6`）提交：

- `025e50a` `test(#270): 组 F 队列/锁双入口真机场景与运行工具`（scenario-declarations 三条声明 / `h-queue-lock.ts` / `run-h-queue-lock.ts`）。
- 本笔记与证据账本（coverage-matrix 三场景行状态 + can-red 行、runs/README 四行、`selftest/evidence/runs/270-*` 四个定稿 run）随 docs(#270) commit 提交。
- 未改 `src/`（无产品 BUG），无 fix commit。

合并：`git merge --no-ff impl/263-t6` 进 `D:/dsh-plugin/_wt263/integration`（分支 `integration/spec-263`），未 push；合并 commit hash 见最终报告与 `git log -1`。
