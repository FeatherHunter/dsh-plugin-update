# #245 研究：失败账本遇上「目标版本事后已装好」

> 只读研究笔记，记录证据与判断，不含实施计划。研究时点 2026-10-23，HEAD `7385e6a`（0.18.38）。

## 结论摘要

- 本仓**没有**为第三态（`installed === true` 且 `installedVersion === job.targetVersion` 且 job 仍 `failed`、重启后 running 也等于目标）写过任何明文契约；有两条既有条文在这里互相拉扯（§1）。
- 但本仓**已有同构判例**：批量层 `reconcileFailed` 就是「账本记 failed、磁盘已是目标版 → 结案为 done，error 留痕」（`src/host/batch/fan-out.ts:388-419`）。它判据宽（只认磁盘）、只写 `batch.json`，从不碰 core 的 `state.json`。
- **该修在视图层，不应改 core 的 healJob**：healJob 对 failed 原样返回（`src/core/service.ts:419`），既无注释也无 ADR 解释；而第三态结案需要「运行版也是目标版」这一同帧事实，它只在快照里（`src/core/service.ts:509`），core 改它会抹掉 #58 的证据链与全部消费面的口径。
- 视图层最小完整改动是**两处**不是一处：view-model 新增第三门（`src/panel/view-model.ts:222-227` 旁）+ mount 的 job-failed 锁存来源判别（`src/panel/mount.ts:1024-1037`）；否则每秒轮询重建的 `lastError` 会让新门失效。入口件/安装按钮件需同步（§6）。
- 最大风险是把 README 的「失败常驻，只读轮询不再洗掉」（`README.md:156`）读成「永不清」，而错过同一句的后半段「保留到……任务态或版本变化」。这两句怎么解释，是本票真正的决策点（§1、末节）。

## 1. 生命周期约定：有常驻条文，也有结束条文，但没有第三态条文

**常驻一侧**（原文）：

- `README.md:156`：「失败横幅常驻：查/装失败后保留到下一次用户主动查/装的新结论、任务态或版本变化，只读轮询不再洗掉；……失败旁有「知道了」可显式确认回到可装页（只清面板提示，不调电话）。」
- `src/panel/failure-latch.ts:53-57`：「用户动作的失败回包冻结成锁存；成功的状态轮询永不清除非瞬态锁存……跨重挂……进程重启即忘。」
- `CHANGELOG.md:838`（#58 原始约定）与上同义。

**结束一侧**（同一句的后半段 + 反证）：

- `README.md:156` 自己写了结束条件：「下一次用户主动查/装的新结论、任务态或版本变化」。它只落在锁存路径：`src/panel/mount.ts:1030`、`:1041` 的 `tripleChanged` 才 `clearLatch`，`:1044-1046` 用户主动查且锁存来源是 check 才清。**快照渲染路径（view-model 直接读 `snapshot.job`）没有对应的「版本变化→结案」规则**——这正是 #245 里进程重启后横幅从 `state.json` 复活的机制。
- `README.md:602`（0.18.12「失败优先于待重启」）给出反向证据：「磁盘版本已到目标版、但 profile 清单没登记该插件……这是『装了但不会生效』，不是『待重启生效』。面板必须先判失败」。即 `installedVersion === targetVersion` **本身不等于成功**。

**没有任何一处**写「目标版本事后已装好 → 失败应结案」，也**没有任何一处**写「失败必须永久常驻」——常驻的边界被「任务态或版本变化」明确留了口子。第三态恰好落在缺口上：任务态没变（job 仍 failed）、版本变了（installedVersion 到了 target）。

## 2. 核心层对账：healJob 只纠「成功但可能失真」的状态

- `src/core/service.ts:403-419 healJob`：`installing/verifying` 非本进程活跃任务 → `interrupted`（`:405-406`）；`restart-required/completed` 先用 `env.installedVersion !== targetVersion` 判 `installation-changed`（`:409-410`），否则按 `postInstallStateOf` 重算（`:413-417`）；**failed 直接 `return job`（`:419`）**，无注释、无 ADR、无 CHANGELOG 解释。
- `src/core/service.ts:298-309 postInstallStateOf`：二态（`completed` / `restart-required`），判据是「磁盘已到目标版（`:306`）**且** 运行版等于目标版（`:307-308`）」。头注释 `:303` 特意说「在册事实不改变这个二值状态……由快照 `registered` 一格单独承载」。
- 关键事实：healJob 在**每次只读轮询**里都会跑并可能回写（`status()` → `healedJob` → `saveJob`，`src/core/service.ts:614-634`、`:636-640`）。所以「轮询不许动账本」不是本仓约束；真正的约束是 #58 的失败常驻语义（`failure-latch.ts:53-57`）与「failed 仍是复制诊断/手工命令的证据源」。
- 本仓对第三态的**既成判例在批量层**：`src/host/batch/fan-out.ts:388-419 reconcileFailed`，头注释原文「事实优先（#27 ②）：账本记 failed，但该家实时快照显示磁盘上已经是目标版——那次装后来其实装上了……把这一行纠成 done，error 留着当痕迹」。判据只有 `entry.phase==='failed' && entry.targetVersion && installed===entry.targetVersion`（`:397-400`）。更严的一条是 `:421-455 reconcileRestart`：要求 `running===target && installed===running` 才敢清「待重启」。
- 因此本仓对「目标已落地」已有两档判据：**宽**（只认磁盘，reconcileFailed）与**严**（运行中就是目标版，reconcileRestart / postInstallStateOf）。#245 两档都满足。

## 3. 视图层现有两道门，第三态两道都不覆盖

- `src/panel/view-model.ts:200-215 staleFailure`（#100）：要求 `compareReleaseVersions(latest, target) === 1`，即 **latest 严格新于 target**。#245 中 `latest === target === 0.2.23`，门为 false。
- `src/panel/view-model.ts:222-227 historicalJobFailure`（#238）：要求 `snapshot.installed === false`。#245 中 installed 为 true，门为 false。
- 失败分支本体 `src/panel/view-model.ts:228-251`：`failedCode` 由 `errorKind || lastError || jobCode` 组成（`:193-199`），任一非空即画 `kind: 'failed'` 的横幅、last-resort 与手工命令。
- 锁存会绕过上面所有门：`src/panel/mount.ts:898-899` 把 `latch.code` 当 `lastError` 传进 view-model；`mount.ts:1032-1036` 在 `job failed/interrupted` 且 `installed !== false` 时**每次轮询都重建设锁存**（`latchFromJob`），「知道了」只清一次（`tests/panel-failure-latch.test.mjs:270-286`），下一秒又回来。这是 #245「点知道了没用」的直接机制，也意味着**只改 view-model 不生效**。
- `tests/issue-238-first-install-stale-failure.test.mjs:97-102` 那条「已装 + 盘上 failed 任务 → 原有失败页不回归」为何不冲突：夹具（同文件 `:30-43`）是 `running/installed = 1.0.0`、`latest = 1.1.0`，用例只覆写 `job.targetVersion = 1.1.0`。即 `installed(1.0.0) !== target(1.1.0)`——失败**还没落地**，与本票第三态（`installed === target`）不是同一个输入。该用例守的恰是「插件已装 ≠ 目标已装」。

## 4. 「持久已读/ack」先例：内存锁存、前端跳过、宿主 skipped.json，各管一段

- 失败锁存是**纯内存**：`src/panel/failure-latch.ts:5`「跨重挂……在模块级存活（宿主进程内），进程重启即忘」，`:78` 就是模块级 `Map`；`tests/panel-failure-latch.test.mjs:290-308` 的「跨重挂存活」也只是同进程重挂。
- 面板跳过是**前端持久**：`src/panel/skip-store.ts:1-14`（localStorage 优先、无环境退内存、写坏吞掉），key 为 `dsh-upd-skipped/<pluginId>`（`:20-22`），按版本记 `{version, skippedAt}`，上限 50（`:18`）。注释明说「宿主侧 skipped.json 是另一套落盘，互不干扰」。
- 宿主侧落盘有「另起文件」的形状先例：`src/shared/config.ts:32-37` 冻结三个名字（`state.json`/`install.lock`/`before.json`）后写「跳过……另起一文件，按插件标识隔离」→ `skipped.json`；目录由 `src/core/disk.ts:59-64` 的 `pathsForUpdate` 决定，读写见 `src/core/disk.ts:613`、`:689`。
- 所以**加 `ack.json` 在形状上有先例**（不动三冻结名），但 `docs/adr/` 只有 0001–0007，没有存储边界或 ack 主题的 ADR；ack 的键（jobId？targetVersion？三元组？）、清理时机、面板（web 侧）与宿主（node 侧）谁写，全是新契约。**不该由一次 bugfix 顺手引入。**

## 5. 宿主契约：没有「手工补装后通知本包」这回事

- `docs/host-install-exits.md:1-13` 自述是「只读抄件」；出口二 `installBundle` 的契约是**调用返回** `ChangeResult{ application: applied|restart-required|overridden|failed|cancelled }`（`:39-52`），「预期失败不 reject……本包只按 application 判成败」（`:51-52`）。
- 全文**无**「安装完成后宿主推送事件/回执」，**无**「外部（用户手工）装好后通知本包」。源码侧也没有宿主事件订阅：全仓只有语言 locale 订阅与 DOM 监听（`src/shared/lang.ts`），状态来源只有轮询 `updateStatus`（`docs/agents/architecture.md:170` 指向 `src/panel/mount.ts:147`）。
- 手工补装的唯一后果：下一次 `updateStatus` 里 `readInstalled()` 的读数更新 `env`（installed/running），`state.json` 一字不动。**结论：无此契约；本包只能靠下一次轮询的快照自己推导「目标已落地」。**

## 6. 消费面：第三态会影响哪些渲染/派生

| 位置 | 第三态行为 |
| --- | --- |
| `src/panel/view-model.ts:193-199`、`:228-251` | 单品横幅 = 失败 + last-resort + 手工命令 |
| `src/panel/mount.ts:313` | 日志 panel state 恒记 `error` |
| `src/panel/mount.ts:1024-1037` | 每秒重建 job 锁存，「知道了」无效 |
| `src/panel/mount.ts:1586-1624` | 复制诊断走失败卷宗 |
| `src/panel/entry.ts:180-192` | 入口件/槽位判 `failed`（`:184`） |
| `src/core/install-button/mount.ts:491-507`、`view.ts:62-63` | 安装按钮件也走失败分支 |
| `src/panel/render.ts:502-516`、`:740-742` | 只认 `installing/verifying`，**不受影响** |
| `src/panel/batch/helpers.ts:263-278` `jobFailureOf`、`:184-194` `batchFailedRows` | 批量行失败文案 / 失败清单 |
| `src/panel/batch/render.ts:628-645`、`:653-685` | 批量行 last-resort / 收尾事实（`compliantInstalledOf` 只认 restart-required/completed，`helpers.ts:156-176`，**不含 failed**） |

- 批量**详情弹窗就是单插件内核本身**（`src/panel/batch/render.ts:652` 注释），故单品视图一改，批量详情同步变；但批量**行相位**来自 `batch.json`，除非 `reconcileFailed` 纠过，否则可能出现「行仍红、点开详情已绿」。这是需要一起定的口径。
- #231/#232 的既有修复（`CHANGELOG.md:84-85`，0.18.31）处理的是「旧账本/复查帧」的显示，票面 state 是 `ready-for-human`；两者不涉及「failed 是否结案」，代码上无直接冲突，但共用「旧账本 vs 现状」的判据语汇，新门应复用 `fan-out.ts:388-419`「事实优先」的说法，别再发明第三套。

## 仍未决 / 需要维护者拍板

1. **判据取宽还是严**：像 `reconcileFailed` 只认 `installed === target`，还是像 `reconcileRestart` / `postInstallStateOf` 要求 `running === target`？`README.md:602` 的「装了但不生效」说明只看磁盘不够；#245 现场重启后 running 已是 0.2.23，两档都过。
2. **结案记在哪**：只在渲染层让位（不改 `state.json`，重启后仍靠读数推导），还是新增 `ack.json`（沿用 `skipped.json` 形状；新落盘契约、无 ADR、需定义键与清理）。
3. **批量口径是否同步**：单品结案后，批量行相位（`batch.json` 的 failed）要不要在同一判据下收敛，「行红详情绿」是否可接受；要不要顺带对齐 #231/#232 的验收。
