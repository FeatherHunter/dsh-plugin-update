# #275 T11 全量真机矩阵回归、BUG 闭环与门禁签署（2026-11-03）

- 票：#275（父票 #263 T11；由 Lead 复核后关闭本票，本文件是签署素材）
- 工作树：`D:/dsh-plugin/_wt263/t11`，分支 `impl/263-t11`，基线 `integration/spec-263` @ `bd39b57baa10`
- 编排器：`selftest/real-machine/tools/run-all.ts`（新增）；场景声明单源：`selftest/fixtures/identity/scenario-declarations.ts`（32 条，T0–T10 已交付）
- 证据总入口：`selftest/evidence/runs/20261103T093814-full/index.md`（本文件所有数字均可从此目录复核）

## 0. 结论摘要（可签署口径）

- **全量 suite 跑完且 unknown=0**：`20261103T093814-full`，status=finished，verdict=known-red，exitCode=0；44 run = 32 主链 + 12 can-red；pass 29 / known-red 3 / can-red-expected-fail 12 / fail 0 / unknown 0。
- **断言合计**：944 pass / 18 fail（全部是 12 组 can-red 的注入预期红）/ 4 known-red / 0 unknown；run 耗时合计 6,644,398ms（最短 13s，最长 404s；desktop 串行 1、web 并发 3）。
- **12/12 can-red 组按预期红**，0 mismatch、0 unexpected-pass；其中 3 组（d1/e1/g4）因历史断言编号漂移，按断言语义步骤（assertion.step）匹配，漂移写进 suite index 与记录 notes（§4）。
- **known-red 账本 4 条不变、0 新增**：本轮 f1/g5/i2 仍 known-red，i1 本轮 pass（其 known-red 分支在桌面通道不可达）；无任何 fail 被改写为 known-red（§5）。
- **BUG 闭环**：#277/#278（#266 T2 真机暴露）与 #279/#280（T4/#268 真机暴露）全部 CLOSED，修复后的回归场景在本轮全量重放中 pass；本轮全量**未暴露新产品 BUG**，也未新增 known-red（§6）。
- **门禁 8 条全绿**（§7）；假宿主预检 pass；base-verify 补充预检 single-instance unknown 按文档口径如实记录、不计入绿门。
- **隔离与收尾**：每 run 核对维护者 profile（`C:/Users/辰辰洋洋/.dsh`）前后指纹不变；suite cleanup 无残留进程/端口；demo 三夹具 npmjs 均 404（未发布）。

## 1. 编排器设计与复用接口（run-all.ts）

目标：一条命令重放全部场景声明，产出可审阅的四态矩阵，且重复运行/部分重跑/事故恢复都不破坏证据账本。

- **输入**：`SCENARIOS`（32 条声明，字段 id/ticket/hostChannel/install/variants/expected）+ `CAN_RED_SPECS`（12 组：场景 id、历史 can-red runId、注入 mode/fault 参数）+ `TOOL_BY_SCENARIO`（场景→`run-*.ts` 工具与参数映射）。
- **队列**：`desktop-official` 串行 1（官方桌面同一时刻只能有一个隔离实例）；`dsh-web` 并发 3。每个 run 自起 verdaccio、动态端口、私有 pnpm store/home/profile，run 目录 `<runBaseDir>/<ticket>-<stamp>-p|r<order>`。
- **SUT 钉版一致性**：起跑前 `runSuitePrebuild` 统一执行 `npm run build` 一次，记 dist 聚合指纹（`raw/00-suite-prebuild.json`，本轮 e8cef960…/208 文件）；子进程注入 `npm_config_ignore_scripts=true`，避免每个 run 的 `npm pack` 触发 prepack 并发重写 dist（§3d）。每个 run 仍独立记录 SUT tarball sha256 + dist 聚合指纹，并断言等于工作树构建产物。
- **四态判定**：pass / known-red（只认 `selftest/evidence/known-red.md` 账本 id）/ can-red-expected-fail / fail；工具无法完成 → unknown；blocked 也落 unknown，不洗成 pass。suite 退出码：0 = 全 pass/known-red/can-red-expected；1 = 有 fail/mismatch；2 = blocked。
- **can-red 判定**：读历史 fail run 的 `run.json` 红断言集合（ids + step 文本）；本轮红逐条命中历史 id，或 step 文本相等（drift note）；多红/少红 → can-red-mismatch；全绿 → unexpected-pass（算 fail）。历史证据原样保留，不因漂移改旧 run。
- **续跑与重跑**：`--stamp` 固定 suite 与各 run 目录（续跑跳过已 good 记录）；`--only` 定向；`--rerun` 不跳过已完成、按计划重跑；`--rebuild-state` 只从已定稿证据补回缺失聚合记录（不跑真机）。每次执行前先删自己上一轮 runDir（否则 verdaccio 同版本 publish 会 exit 1、raw 会混入旧文件）。
- **证据**：各场景工具用 `copyRunEvidence` 同步证据包；个别 T1/T2 时代工具不自带同步，编排器用 `copyEvidencePackage` 补齐（仅 run.json/index.md/shots/raw，不含 user-data-dir/pack/npm-cache）。
- **index.md 结构**：结论表（含「记录来源：本轮真机重跑 N / 证据重建 M」）→ 44 行场景总表（证据重建标记）→ can-red 期望失败表 → known-red 终账 → 隔离事实 → Web 通道截图说明 → 复跑命令 → 备注。

## 2. 44 run 矩阵结果

来源：`selftest/evidence/runs/20261103T093814-full/run.json` 与 `index.md`；断言列 = 通过/失败/known-red。

| # | 场景 | 票 | 类型 | 通道 | 证据 run | 判定 | 断言 p/f/k | 耗时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | a-single-package-main-chain | 265 | 主链 | desktop | `265-20261103T093814-p01` | pass | 13/0/0 | 2m06s |
| 2 | b-batch-two-integrators | 266 | 主链 | desktop | `266-20261103T093814-p02` | pass | 38/0/0 | 4m47s |
| 3 | c-pure-target-no-wiring | 266 | 主链 | desktop | `266-20261103T093814-p03` | pass | 24/0/0 | 3m27s |
| 4 | d1-desktop-manager-update-success | 267 | 主链 | desktop | `267-20261103T093814-p04` | pass | 17/0/0 | 3m33s |
| 5 | d2-desktop-manager-update-failure | 267 | 主链 | desktop | `267-20261103T093814-p05` | pass | 18/0/0 | 2m36s |
| 6 | e1-cli-host-update-success | 267 | 主链 | web | `267-20261103T093814-p06` | pass | 22/0/0 | 0m18s |
| 7 | e2-cli-host-update-failure | 267 | 主链 | web | `267-20261103T093814-p07` | pass | 25/0/0 | 0m19s |
| 8 | e3-cli-host-install-timeout | 267 | 主链 | web | `267-20261103T093814-p08` | pass | 22/0/0 | 0m17s |
| 9 | f1-third-party-desktop-probe | 267 | 主链 | desktop | `267-20261103T093814-p09` | known-red | 8/0/2 | 1m22s |
| 10 | g1-desktop-manager-install-timeout | 268 | 主链 | desktop | `268-20261103T093814-p10` | pass | 19/0/0 | 4m08s |
| 11 | g2-batch-queued-cancel | 268 | 主链 | desktop | `268-20261103T093814-p11` | pass | 28/0/0 | 5m30s |
| 12 | g3-desktop-manager-failed-no-retry | 268 | 主链 | desktop | `268-20261103T093814-p12` | pass | 19/0/0 | 4m54s |
| 13 | g4-desktop-manager-retry-single-success | 268 | 主链 | desktop | `268-20261103T093814-p13` | pass | 25/0/0 | 6m05s |
| 14 | g5-desktop-manager-no-cancel-probe | 268 | 主链 | desktop | `268-20261103T093814-p14` | known-red | 11/0/1 | 2m31s |
| 15 | e-batch-three-package-upgrade | 269 | 主链 | desktop | `269-20261103T093814-p15` | pass | 16/0/0 | 2m47s |
| 16 | e-batch-partial-failure | 269 | 主链 | desktop | `269-20261103T093814-p16` | pass | 17/0/0 | 4m56s |
| 17 | e-batch-resume-retry | 269 | 主链 | desktop | `269-20261103T093814-p17` | pass | 22/0/0 | 5m18s |
| 18 | h1-queue-lock-concurrent | 270 | 主链 | web | `270-20261103T093814-p18` | pass | 25/0/0 | 0m23s |
| 19 | h1b-queue-lock-simultaneous | 270 | 主链 | web | `270-20261103T093814-p19` | pass | 25/0/0 | 0m23s |
| 20 | h2-queue-lock-stale-reclaim | 270 | 主链 | web | `270-20261103T093814-p20` | pass | 20/0/0 | 0m17s |
| 21 | g6-hub-survives-self-replacement | 271 | 主链 | web | `271-20261103T093814-p21` | pass | 32/0/0 | 0m56s |
| 22 | g7-hub-handoff-evidence | 271 | 主链 | web | `271-20261103T093814-p22` | pass | 39/0/0 | 1m01s |
| 23 | i1-restart-enrollment-truth | 272 | 主链 | desktop | `272-20261103T093814-p23` | pass | 19/0/0 | 3m44s |
| 24 | i2-unregistered-honesty | 272 | 主链 | web | `272-20261103T093814-p24` | known-red | 24/0/1 | 0m22s |
| 25 | i3-topology-compensation | 272 | 主链 | desktop | `272-20261103T093814-p25` | pass | 19/0/0 | 2m13s |
| 26 | k-single-panel-happy | 274 | 主链 | web | `274-20261103T093814-p26` | pass | 38/0/0 | 0m49s |
| 27 | k-single-panel-failure | 274 | 主链 | web | `274-20261103T093814-p27` | pass | 23/0/0 | 1m41s |
| 28 | k-batch-panel-states | 274 | 主链 | web | `274-20261103T093814-p28` | pass | 38/0/0 | 4m04s |
| 29 | k-batch-resume | 274 | 主链 | web | `274-20261103T093814-p29` | pass | 24/0/0 | 2m44s |
| 30 | j1-log-contract-coverage | 273 | 主链 | web | `273-20261103T093814-p30` | pass | 28/0/0 | 0m41s |
| 31 | j2-noise-budget | 273 | 主链 | web | `273-20261103T093814-p31` | pass | 16/0/0 | 5m28s |
| 32 | j3-namespace-whitelist | 273 | 主链 | web | `273-20261103T093814-p32` | pass | 17/0/0 | 0m22s |
| 33 | a-single-package-main-chain | 265 | can-red | desktop | `265-20261103T093814-r33` | fail | 11/2/0 | 3m28s |
| 34 | b-batch-two-integrators | 266 | can-red | desktop | `266-20261103T093814-r34` | fail | 34/4/0 | 6m44s |
| 35 | c-pure-target-no-wiring | 266 | can-red | desktop | `266-20261103T093814-r35` | fail | 22/2/0 | 3m30s |
| 36 | d1-desktop-manager-update-success | 267 | can-red | desktop | `267-20261103T093814-r36` | fail | 15/2/0 | 3m29s |
| 37 | e1-cli-host-update-success | 267 | can-red | web | `267-20261103T093814-r37` | fail | 21/1/0 | 0m13s |
| 38 | g4-desktop-manager-retry-single-success | 268 | can-red | desktop | `268-20261103T093814-r38` | fail | 24/1/0 | 5m28s |
| 39 | e-batch-three-package-upgrade | 269 | can-red | desktop | `269-20261103T093814-r39` | fail | 15/1/0 | 2m45s |
| 40 | i1-restart-enrollment-truth | 272 | can-red | desktop | `272-20261103T093814-r40` | fail | 16/1/0 | 2m33s |
| 41 | k-single-panel-happy | 274 | can-red | web | `274-20261103T093814-r41` | fail | 8/1/0 | 0m50s |
| 42 | j1-log-contract-coverage | 273 | can-red | web | `273-20261103T093814-r42` | fail | 13/1/0 | 0m20s |
| 43 | h1-queue-lock-concurrent | 270 | can-red | web | `270-20261103T093814-r43` | fail | 11/1/0 | 0m17s |
| 44 | g6-hub-survives-self-replacement | 271 | can-red | web | `271-20261103T093814-r44` | fail | 23/1/0 | 1m05s |

- 统计：pass 29（含 1 条历史 known-red 场景 i1 本轮 pass）、known-red 3（f1/g5/i2）、can-red-expected-fail 12、fail 0、unknown 0。
- 真实时间线：首条记录开始 2026-11-03T01:38:15Z（本地 09:38），末条记录结束 2026-11-03T03:49:06Z（本地 11:49）；期间含一次「记录重建」抢救（§3c）。suite `run.json` 的 startedAt 因重建被重置为 03:25Z，看真实跨度请用场景记录时间或 §3 时间线。
- 环境记录：worktree `D:/dsh-plugin/_wt263/t11`，branch `impl/263-t11`，head `bd39b57baa10`，`dirtyFiles=48`（suite 起跑时 T11 未提交改动，收尾提交后未再重跑全量；证据与工作树内容对应关系见各 run 的 sut 段）。
## 3. 运行期事故与修复（全部属编排器/场景层，不改产品契约）

本 ticket 的目标是「跑通并证明」，不是改产品；下列 7 项都发生在编排器或场景内部，修复后重跑取得正式证据，原始失败 run 的结论在 suite notes 与本表中如实记录，不抹掉。

### 3a. 跨场景误杀：desktop run 启动前清理把并发 web run 的 verdaccio 杀了
- 现象：k-batch-resume（#29）首跑 unknown，`ECONNREFUSED 61031`；该端口是同一时刻另一个 web run 自己的 verdaccio。
- 根因：`killOwnProcesses(opts.runBaseDir)` 泛匹配运行根下所有进程；verdaccio 是 `node.exe`，与桌面 `DeepSeek Harness.exe` 无法用名字区分场景归属。
- 修复：`queryOwnProcesses(runBaseDir, includeVerdict)` 增加开关，desktop 分支只清桌面进程（`killOwnProcesses(runBaseDir, false)`，过滤 `name !== 'node.exe'`）；修复后 k4 重跑 pass。

### 3b. 续跑/--rerun 复用旧 runDir：verdaccio 同版本 publish exit 1 + raw 混旧文件
- 现象：j2 首次定向重跑 2.6s 退出 exit 2，`[fixtures] npm publish 失败（exit 1）`；旧 run 目录里 raw 仍是上一轮的（mtime 更早）。
- 根因：executeSpec 只在「上一轮记录非 good 或不存在时才清理」，于是复用旧 runDir；verdaccio 存储里同版本已存在 → 同版本不可重发。
- 修复：无论续跑还是 `--rerun`，执行前都 `rm -rf` 自己的 runDir（只清本 run 自己的目录）；j2 重跑 5m28s pass、16 条断言（此时首轮全量的 26-assert 红被证明是并发页面重挂载噪声，见 §3f）。

### 3c. --rerun 重置聚合记录：suite run.json 只剩 1 条
- 现象：j2 定向重跑后，suite 聚合 run.json 从 44 条记录变成 1 条。
- 根因：`openSuite` 原逻辑「有历史 run.json 且非 --rerun 才加载，否则新建 state」；`--rerun` 本意只是「不跳过已完成」，却把聚合账本重置。
- 修复：只要有已存在的 suite run.json 就加载（`--rerun` 只影响跳过逻辑）；已丢的 43 条用新增的 `--rebuild-state` 从已定稿证据抢救：读每行 `selftest/evidence/runs/<ticket-stamp>/run.json` + 编排 `raw/<key>.log` 的 `[exit] N` 取进程退出码，复用 classifyOutcome 重建记录；每条记录 note 写「聚合记录由证据重建（数据源：…；原因见 suite notes）」。
- 结果：44 条 = 39 条证据重建 + 5 条自然重跑（g2/j2/d1/e1/g4）；index.md 对重建记录标「（证据重建）」并汇总「记录来源」。重建不伪造真机执行：退出码与断言数字都来自已定稿证据本身，标记与数据源逐条可查。

### 3d. 并发 prepack 重建 dist：指纹读到读写竞争快照
- 现象：k3/k4 的 14/15-assert 红：expected worktree dist `47c5587c…` vs installed `e8cef960…`（均 208 文件）；而 raw/02-sut-pin 的 tarball sha256 与首跑一致。
- 根因：每次 run 的 SUT pin 都执行 `npm pack`，触发 prepack=`npm run build`；3 路 web + desktop 并发时多个 run 同时重写同一 worktree `dist/`，directoryFingerprint 读到混合快照。首跑时 worktree dist=e8ce，47c5 是竞争产物。
- 修复：suite 起跑前统一 `npm run build`（`runSuitePrebuild`，写 `raw/00-suite-prebuild.json` 与 isolationFacts.suitePrebuild），并在子进程环境注入 `npm_config_ignore_scripts=true` 让 npm pack 不再触发 prepack。修复后 k3/k4 均 pass（全量记录）。
- 复现要点：必须看两处指纹（expected/installed）与 build 时间线，而不是只看 tarball sha。

### 3e. 并发负载下 g2 的 40s 占锁窗过短（场景计时问题，不是产品回归）
- 现象：g2 首跑（268-20261103T093814-p11）3m50s fail，35/37/40-assert 红：A 宏安装轮到 C 时 40s 占锁方预算已到期（raw/34 显示 owner 已变 fxa-c、开始时间比占锁方晚 40.6s），B 的 fxb-c 台账 state=failed「安装已被取消；目标包已被宿主移除…」。
- 根因：并发负载下 A 的批量 precheck 变慢，排不进 40s 占锁窗；g2 的语义（排队观察 + 行取消 + 丢弃本批）本身仍成立。
- 修复（selftest/real-machine/scenarios/g-timeout-cancel-settlement.ts）：`QUEUE_OCCUPIER_TIMEOUT_MS` 40000→120000；新增 `QUEUE_PROXY_DELAY_MS=240000`，queued-cancel 模式用 `proxyDelayMs`（占锁方仍在预算超时失败，语义不变，只是窗口按并发负载放大）。重跑 5m30s pass。

### 3f. j2 并发页面重挂载被算进噪声预算
- 现象：j2 首跑（273-20261103T093814-p31）5m24s fail，26-assert：窗口轮询数=101（每页 53/53）、新增行=6，全是成对 `update.panel.mount`（3 组），无其他新增行。
- 判定：并发负载下 web 客户端页面/面板重挂载产生的常驻事件被算进「静置窗口零新增」；不是轮询刷屏（无 update.status 重复行）。单独重跑 5m28s pass（0 新增）。
- 处置：不记 known-red、不改产品；重跑证据作为正式记录，suite notes 写明该次重跑原因与事实。审查时若质疑，先看单跑 run 的 raw（窗口轮询/新增行原文）。

### 3g. can-red 历史断言编号漂移（3 组）
- 现象：d1 历史 16/37 → 本轮 17/38；e1 40 → 41；g4 71 → 72。语义步骤与 actual 完全一致，差异来自这些场景在历史 run 之后新增过对账断言（编号整体后移）。
- 处置：can-red 匹配同时按 assertion.step 语义命中，note 与 index 标注「本轮编号漂移，按步骤语义匹配」；历史 run 与 expected raw 均不改写。

## 4. can-red 重放强度与结果

- **强度口径**：本轮 12 组 can-red 全部是**故障注入级**（发布器变异 stale-variant / 跳发版本 / 删枢纽 plan / 删锁与队列 / 私有契约副本删事件 / 停宿主后改已装文件），没有在 T11 里做「改产品源码再跑」的 SUT 变异级注入；SUT 变异级的 can-red 证据沿用各 ticket 自己的历史 run（下表「历史 run」列，均在 `selftest/evidence/runs/` 内可复核）。这是本 ticket 证据强度的边界，见 §9。
- **判定规则**：本轮红 = 历史红（id 或 step 语义）才算 expected；多红/少红/全绿都不算通过。12 组全部 expected，且每组「其余断言仍 pass」可按 run.json 的 assertions 数字复核。

| 场景 | 注入（本轮） | 历史 can-red run | 期望红（历史） | 本轮红 | 本轮判定 |
| --- | --- | --- | --- | --- | --- |
| a-single-package-main-chain | `--fault stale-variant` | 265-20261101T214716 | 15/26-assert | 15/26-assert | can-red-expected-fail |
| b-batch-two-integrators | `--fault skip-variant:c` | 266-20261102T080334 | 47/49/50/59-assert | 同左 | can-red-expected-fail |
| c-pure-target-no-wiring | `--fault stale-variant:c` | 266-20261102T081101 | 22/33-assert | 同左 | can-red-expected-fail |
| d1-desktop-manager-update-success | `--mode can-red`（stale） | 267-20261102T113218 | 16/37-assert | 17/38-assert（漂移） | can-red-expected-fail |
| e1-cli-host-update-success | `--mode can-red`（stale） | 267-20261102T113629 | 40-assert | 41-assert（漂移） | can-red-expected-fail |
| g4-desktop-manager-retry-single-success | `--mode retry-can-red` | 268-20261102T180537 | 71-assert | 72-assert（漂移） | can-red-expected-fail |
| e-batch-three-package-upgrade | `--mode can-red`（stale c） | 269-20261102T230056 | 38-assert | 同左 | can-red-expected-fail |
| i1-restart-enrollment-truth | `--mode can-red`（stale a） | 272-20261103T041611 | 31-assert | 同左 | can-red-expected-fail |
| k-single-panel-happy | 停宿主后改已装 `lib/client.js` 横幅 | 274-20261103T090655 | 24-assert（can-red-03-banner-exact） | 同左 | can-red-expected-fail |
| j1-log-contract-coverage | 私有契约副本删事件/枚举 | 273-20261103T054614 | 29-assert | 同左 | can-red-expected-fail |
| h1-queue-lock-concurrent | 安装中删两锁 + 清空 queue | 270-20261103T004915 | 38-assert | 同左 | can-red-expected-fail |
| g6-hub-survives-self-replacement | 换手窗内删 `hub/plans/fxa.json` | 271-20261103T015357 | 53-assert | 同左 | can-red-expected-fail |

注：k 的历史 run 断言 id 是 `can-red-03-banner-exact`，本轮记录为 `24-assert`（两者 step 文本一致，重建记录取的是本轮 id）。本轮 12 组的 shard/注入原始件在各自 run 的 `raw/`（can-red 注入文件）与 `run.json notes` 里，逐组可查。

## 5. known-red 终账

账本：`selftest/evidence/known-red.md`（本轮未改动，0 新增）。判定口径：只登记已确认可稳定复现、且当前证据无法在真机兑现的既有失败；修复后标已修复（棘轮只增不减）。

| known-red id | 场景 | 首见 run | 本轮 run/结果 | 结论 |
| --- | --- | --- | --- | --- |
| t3-267-exit-one | f1-third-party-desktop-probe | 267-20261102T113042 | 267-20261103T093814-p09：known-red（8 pass + 2 known-red） | 本机无第三方 Desktop 宿主/desktopProfiles 服务，出口一真机格不可达；探测原文与负向证据仍每轮复采 |
| t4-268-no-cancel-probe | g5-desktop-manager-no-cancel-probe | 268-20261102T181106 | 268-20261103T093814-p14：known-red（11 pass + 1 known-red） | 官方 0.2.1-rc.5 有 cancelInstall 能力，造不出「无 cancelInstall 宿主」；能力度量（asar 66 处命中）与 L0 诚实措辞每轮复采 |
| t8-272-panel-pending-restart-branch | i1-restart-enrollment-truth | 272-20261103T040926 | 272-20261103T093814-p23：**pass** | 桌面通道 in-process 热换使「面板 pending-restart 分支」不可达；本轮 19 条全 pass，known-red 记录保留（棘轮），不当作新增失败 |
| t8-272-i2-runtime-version-not-authoritative | i2-unregistered-honesty | 272-20261103T040932 | 272-20261103T093814-p24：known-red（24 pass + 1 known-red） | 未注入 ReaderOverrides.runningVersion 时 updateStatus 按磁盘宣称 completed，属产品真话边界；场景 33-assert 记录该边界 |

- **fail 洗白检查**：suite 内 0 条 fail；18 条红全部属于 12 组 can-red 的预期红（逐条在 index.md can-red 表与 run.json redIds 中列明）；无「把 fail 写成 known-red」的改动，known-red.md 本轮 diff 为空。
- 3 个 known-red 场景的「其余断言 pass」分别可复核：f1 8/10、g5 11/12、i2 24/25。

## 6. BUG 闭环（#277–#280）

来源：GitHub issues（本轮用 `gh issue view` 复核状态）。修复全部在 T2/T4 票内完成并合入 `integration/spec-263`；T11 的工作是把它们的回归场景放回全量矩阵重放，证明没有回归。

| 票 | 现象 | 根因（文件:行） | 修复 | 回归测试 | 修复前 run → 修复后 run | 状态/提交 |
| --- | --- | --- | --- | --- | --- | --- |
| #277 | 集成方 ctx 接入时批量账本/中枢不落盘（真机暴露） | `src/host/batch/fan-out.ts:181-199` 修复前只认 `input.scope`/`readerOverrides`/`config`，不反推 `ctx.profileContext` | 复用 `profileIdentityFromContext`/`profileIdentityFromEnv` 反推范围 | `tests/batch-scope-derivation.test.mjs` | 266-20261102T002823 → 266-20261102T034002 | CLOSED 2026-11-02T00:23:10Z；commit cf4dbc4，merge cc140e7 |
| #278 | 读取器换代丢掉在飞安装任务 → 瞬态 recovery-required | `src/core/service.ts:403-406` `healJob` + `src/host/capabilities.ts:193-194` 缓存键含 runningVersion | `capabilities.ts:195-208,451-457` 复用 `sameReaderExceptRunningVersion` | `tests/reader-rotation-inflight.test.mjs` | 266-20261102T021151 → 266-20261102T034002 | CLOSED 2026-11-02T00:23:19Z；cf4dbc4/cc140e7 |
| #279 | 跨目标电话挤占 sharedReader 单例槽 → 在飞安装被误判中断、队列 owner 提前释放 | `src/host/capabilities.ts`（recentReaders 身份含 runningVersion） | 身份=缓存键去掉 runningVersion，上限 16，仅 installing/verifying 复用 | `tests/reader-rotation-inflight.test.mjs` | 268-20261102T153751 → 268-20261102T165202 | CLOSED 2026-11-02T10:41:24Z；commit b68940c（impl/263-t4） |
| #280 | 行取消排队回执谎称「此插件将不再等待」 | `src/core/i18n/dictionary.ts:843` `batch.toast.cancel-ok` 文案 | 改文案 + 双语快照 | `tests/panel-batch.test.mjs` + `tests/fixtures/bilingual/strings.snapshot.json` | g2 场景（268-20261102T174922）的文案断言 | CLOSED 2026-11-02T10:42:22Z；commit 3adbf51 |

- 本轮对应回归：#277/#278 的 b/c 三包与批量场景 pass；#279 的 g2 场景本轮重跑 pass（占锁方台账 installing 断言复核 sharedReader 行为）；#280 的 g2 文案断言 pass。
- 本轮全量**未发现新产品 BUG**：44 run 中 0 条非预期红、0 unknown；2 处并发负载现象（§3e/§3f）已定位为场景计时/观测噪声，不是产品缺陷。
## 7. 预检与门禁

### 7.1 假宿主预检（T11 要求的绿门之一）
```
node selftest/real-machine/tools/preflight-fixture-install.ts \
  --worktree D:/dsh-plugin/_wt263/t11 \
  --run-base-dir D:/dsh-plugin/_wt263/runtime/t11-275-preflight
→ verdict=pass, exit 0, runId 265-20261103T115708（verdaccio 端口 60586）
   notes：「本地 registry 已停止，端口已释放」
```
证明：干净 profile 下「真实本地 registry + SUT 钉版 + 三夹具发布 + CLI 安装」链路可用，不依赖真机窗口。证据目录：`selftest/evidence/runs/265-20261103T115708/`。

### 7.2 base-verify 补充预检（如实记录，不计绿门）
- 打包：`npm pack --ignore-scripts --pack-destination D:/dsh-plugin/_wt263/runtime/t11-275-preflight/pack` → `dsh-plugin-update-0.18.39.tgz`（215 files，sha1 `a92c2e443bf283ac0442237c6b5cec6cba30cac6`）。
- 运行：`node selftest/real-machine/tools/run-base-verify.ts --home D:/dsh-plugin/_wt263/runtime/base-verify-integration/source-home --profile web --out D:/dsh-plugin/_wt263/runtime/t11-275-preflight/base-verify --tarball …/pack/dsh-plugin-update-0.18.39.tgz --json`。
- 结果：self-check **pass**（5 pass / 3 skip）；single-instance **unknown**，summary exitCode=2，blockedReasons=`[prerequisite-missing（profile 未声明 pluginCacheDir）, adapter-missing（找不到 playwright；verify/browser.mjs Cannot find module 'playwright'）]`。
- 口径：按 `docs/maintainers.md` §151-186，blocked=unknown 不算通过；该检查也不是 T11 绿门（绿门是「假宿主预检」= preflight-fixture-install）。因此不伪造 pass、不为绿改场景，如实记录在案。

### 7.3 门禁（串行执行，全绿）

| # | 命令 | 结果 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `node selftest/fixtures/generator/fixture-package-plan.test.ts` | 通过 | OK，568 条断言 |
| 2 | `npx tsc -p selftest/tsconfig.json --noEmit` | 通过 | exit 0 |
| 3 | `npx tsc -p selftest/tsconfig.tooling.json --noEmit` | 通过 | exit 0 |
| 4 | `npm run build` | 通过 | exit 0（dist 聚合指纹 e8cef960…/208 文件） |
| 5 | `npm run test:batch` | 通过 | 192 tests / 192 pass / 0 fail（4704ms） |
| 6 | `npm run check` | 通过 | exit 0（双语门禁通过；416 个 draft key 仅提示不拦） |
| 7 | `npm run docs:log:check` | 通过 | exit 0（2 张事件表 23 行一致；6 个清单缺行仅警告） |
| 8 | `npm run smoke:log` | 通过 | PASS s1–s6 |

### 7.4 其他核实
- demo 三夹具未发布 npmjs：`npm view dsh-plugin-update-fixture-a/b/c version` → 全部 `E404 Not Found`（registry.npmjs.org）。
- SUT tarball 白名单：`tar -tzf` 215 entries，bad=0（无 src/tests/selftest/docs/scripts/node_modules）。
- 维护者 profile：每个 run 记录 `maintainerProfile` 前后指纹，全部 unchanged=true；suite cleanup 无残留进程、无占用端口。
- 证据工件：`selftest/evidence/runs/` 下 45 个目录（44 run + 1 suite），共约 30.7MB；每个目录都有 run.json + index.md + shots/ + raw/，无嵌套拷贝、无大文件。

## 8. 复跑与审查入口

### 8.1 复跑命令（在 `D:/dsh-plugin/_wt263/t11`，先 `npm ci && npm run build`）
```powershell
# 全量（新 stamp；desktop 串行 + web 并发 3，约 2h）
node selftest/real-machine/tools/run-all.ts --worktree D:/dsh-plugin/_wt263/t11 \
  --run-base-dir D:/dsh-plugin/_wt263/runtime/t11-275 --stamp <新stamp>

# 定向重跑（不重置聚合记录；--only 逗号分隔）
node selftest/real-machine/tools/run-all.ts ... --stamp 20261103T093814 \
  --rerun --only b-batch-two-integrators,can-red:e1-cli-host-update-success

# 只补聚合记录（不跑真机；从已定稿证据重建）
node selftest/real-machine/tools/run-all.ts ... --stamp 20261103T093814 --rebuild-state

# 单场景（各自工具的 CLI 与 T1/T2 相同，见 selftest/evidence/README.md §10）
node selftest/real-machine/tools/run-b-batch.ts --worktree D:/dsh-plugin/_wt263/t11 \
  --run-base-dir D:/dsh-plugin/_wt263/runtime/t11-275
```
续跑说明：同一 `--stamp` 会跳过已 pass/known-red/can-red-expected 的记录；本 suite 的 44 条记录来源已在 index.md「记录来源」行与每条记录 notes 中标注。

### 8.2 审查顺序（建议）
1. `selftest/evidence/runs/20261103T093814-full/index.md`：结论表 → 记录来源 → 44 行场景总表（重建标记）→ can-red 表 → known-red 终账 → 备注。
2. 任选一主链行点进 `run.json`/`index.md`/`shots/`/`raw/`；断言 actual 字段与截图 sidecar 的「看什么/expected/actual/判定」逐条对照。
3. can-red 行：先看 `run.json.redIds` 与历史 `expectedRedIds`，再看该 run 的注入 raw，确认「其余断言仍 pass」。
4. 并发相关争议（§3e/§3f）：先看单跑重跑证据，再看首跑 raw，确认是并发负载/页面重挂载而非产品行为变化。
5. 已知边界（§9）逐条核对是否为可接受限制。

## 9. 限制与边界（签署前应知情）

1. **can-red 强度**：本轮 12 组都是故障注入级，不是 SUT 源码变异级；后者证据沿用各 ticket 历史 run（§4 表）。若签署要求「本轮也做 SUT 变异」，需另开一次性注入 run（本 ticket 未做，如实声明）。
2. **web 通道无窗口截图**：16 个 dsh-web 主链场景（e/g/h/i/j/k 组）没有真窗口，证据是 DOM/文本原文 + Playwright 页面截图（有 k/j 组 shots）；README §11 已有口径：web 通道的「真 UI」证据是页面 DOM 文本，不是桌面截图。
3. **39 条聚合记录为证据重建**：数据源 = 各已定稿 run 的 run.json + 编排 raw 日志的 `[exit] N`；重建记录在 run.json notes 与 index.md 都有标记；5 条自然重跑（g2/j2/d1/e1/g4）有实时 processExitCode。suite run.json 的 startedAt/finishedAt 因重建被重置（真实时间线见 §2）。
4. **suite 起跑时工作树未提交**（dirtyFiles=48）：T11 的证据采集先于提交；提交后未再重跑全量（避免 2h 重复真机成本），工作树内容与 run 内 sut.distDigest 的对应关系见各 run 的 sut/head 段。若要求「提交后全量重跑」需另排时间窗。
5. **官方桌面单实例**：desktop 队列串行 1，避免两个隔离实例争用宿主全局资源；因此 desktop 组耗时相加 ≈ 6,644,398ms 的大部分。
6. **并发负载露面 2 次**：j2（§3f）与 g2（§3e）首跑红均由并发负载引出，重跑 pass 且说明了机制；没有把首跑红抹掉（run 记录/notes 保留）。
7. **base-verify single-instance unknown**：受 profile 声明与 playwright 缺失限制（§7.2），按文档口径不算通过、未计入绿门。
8. **demo 插件未发布**：三夹具仅存在本地 verdaccio（每个 run 自起自清），npmjs 404 已核实。

## 10. 提交与合并

- `2593530` `fix(#275): 并发负载下 g2 占锁窗与延迟代理按负载放大（语义不变）`
- `0f892b2` `test(#275): 全量矩阵编排器与 44 run 真机证据入库`（run-all.ts + 45 个证据目录 + runs/README + coverage-matrix + evidence README §11）
- `docs(#275)`：本文件（决策/结果/门禁/边界记录）
- 基线：`integration/spec-263` @ `bd39b57`（merge #274 / T10）；收尾时把 `integration/spec-263` 最新 tip 合入本分支取平，再以 `--no-ff` 合回 `integration/spec-263`，合并结果见 `git log --oneline --first-parent` 与最终报告。
- 复跑审查入口：`selftest/evidence/runs/20261103T093814-full/index.md`；suite 机器账本 `.../run.json`；本文件 §8 命令可直接复跑。
