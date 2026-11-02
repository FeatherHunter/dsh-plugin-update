# #273（J 组）日志面板 / 事件目录真机证据（T9）

本笔记记录实施票 #273（parent #263，J 组）在真机上的落地方案、逐格证据、产品真相边界与试错记录。
基线：`integration/spec-263`（含 T0–T8），本票工作树 `D:/dsh-plugin/_wt263/t9`，分支 `impl/263-t9`。
SUT 钉版：`dsh-plugin-update@0.18.39`，dist 指纹 `e8cef960…`（208 文件，tarball sha256 `3502f4da…`）。

## 1. 结论

- 三格全部真机跑通：`j1-log-contract-coverage`（pass，28 断言/1 图/29 raw）、`j2-noise-budget`（pass，16 断言/2 图/21 raw）、`j3-namespace-whitelist`（pass，17 断言/1 图/22 raw），另有 `j1` 的 can-red（fail/退出码 1，14 断言，唯一红 29-assert）。
- 四条定稿 run 都跑在干净 HEAD `cffcf3c`（`run.json.environment.head` 一致），已同步入库 `selftest/evidence/runs`。
- **产品 BUG：无**。本格没有发现需要修 src 的契约/行为缺陷；唯一值得写清的「产品真相」是 web GUI 没有独立的插件日志查看器（见 §7），J 组的 UI 证据面是更新面板 04 诊断章节里的日志路牌 + 日志健康读数，磁盘事件面独立统计。
- 未新增 known-red：J 组没有不可达格；j3 的 UI 对照用真面板内日志健康读数完成，不是降级证据。

## 2. 设计

### 2.1 三格分工

| 格 | 模式 | 取证对象 |
| --- | --- | --- |
| j1 `j1-log-contract-coverage` | `--mode contract-coverage` | 事件目录覆盖、字段/枚举契约、失败事件面、批量 summary、落点/行预算 |
| j2 `j2-noise-budget` | `--mode noise-budget` | 常驻事件噪声预算、状态变化边沿触发（不刷屏） |
| j3 `j3-namespace-whitelist` | `--mode namespace-whitelist` | 日志落点/命名空间、客户端事件白名单、面板健康读数 ↔ 磁盘对账 |
| can-red | `--mode can-red`（复用 j1 流程） | 证明断言会红：run 私有契约副本删掉 `update.install.exec` |

三格共用 setup：`openT3Run`（hostChannel=`dsh-web`，台账 ticket=`273`）→ `osHomeDir=<run>/os-home`、`homeDir=<osHomeDir>/.dsh` → `createWebProfileInHome`（profile：j1=`t9j1`、j2=`t9j2`、j3=`t9j3`、can-red=`t9j1c`）→ `installBaseline` + `verifySutInstalled` → `publishBaseline` + `publishScenarioVariants` → `startCliHost`（通道 B）。

### 2.2 j1 的失败注入为什么用文件锁而不是坏 tarball

最初按 T3 的 `corruptPublishedTarball` 思路做「B 失败、C 成功」的部分失败格。实测失败：本机 pnpm store（`D:/.pnpm-store/v11`）里已有 fixture-b@0.0.2 的正确内容，pnpm 直接 store 命中，坏 tarball 根本没下载——注入生效（raw 里 sha256 变、200/200、versionDocUnchanged=true）但安装成功。这不是产品问题，是 **pnpm store 缓存让「改坏 registry tarball」在同机不可重复**。

改用与 T8 i3 同款的真机故障：对已装 B 的 `<home>/profiles/t9j1/node_modules/dsh-plugin-update-fixture-b/lib/index.js` 起 PowerShell 独占打开（`[System.IO.File]::Open(path,"Open","Read","Read")`，持 180s），并把夹具安装预算压到 `DSH_SELFTEST_INSTALL_TIMEOUT_MS=6000`。这样失败发生在产品执行层：remove 旧包超时 → exec 非零/超时 → `install.fail(stage=exec, reason=timeout, code=install-failed)` → 台账 failed。且因为走整轮批量，批量 summary 会如实落 `failed≥1`。

### 2.3 j2：噪声预算怎么算真

两个 Playwright 页面同时打开真 UI 面板（每页 5s 一次 `updateStatus` 轮询，`page.on('request')` 实计），静置窗口累计 **≥100 次真实轮询**（实测 100，两页 53/52），窗口内新增日志行必须以 `(source,line)` 指纹判定为 0；随后在真 UI 点「检查更新」让状态真变化，断言恰一条 `update.status.changed(kind=update-available, latest=0.0.2)`；再等 ≥20 次轮询，同指纹仍恰 1 条。

### 2.4 j3：面板健康读数 ↔ 磁盘对账

读面板 04 章两条 `.dsh-upd-log`：日志路牌（`<DSH_HOME>/logs/<derived>` + `npx dsh-log`）与日志健康读数（落点/目录指纹/按需开关/丢弃数/最近事件/事件契约）。逐项对磁盘：`sink=self` 与 `update.wire.ready.logSink` 一致；`dirHash` 与 `logDirHash` 相等；丢弃 0 与无 `client-drop`/降级行互证；最近事件时间与磁盘最新行同窗（实测 deltaMs=56615，阈值 120000）。客户端事件白名单正向：`update.panel.mount`/`update.panel.action` 只落属主 `fxa-a` 且名 ∈ 6 值。负向：直接向属主 `logAppend` 电话伪造 `update.install.exec`，断言 `accepted=0/dropped=1`、磁盘伪造行=0、exec 行数不变。

### 2.5 can-red

仓库 `event-list.update.json` 与 src 一字不动；run 内把它复制到 `<run>/can-red-event-list.json`，删掉 `events['update.install.exec']` 与同名 `fieldEnums`，用这份私有契约校验同一批真日志。前置断言先证明「真安装确实产生了 exec 行」「clean 契约四关全过」，再证明删掉后真 exec 行被判未知事件 → 本 run 必须红。注入前后 diff 进 raw。

## 3. 逐格证据（定稿 run）

### 3.1 j1 `273-20261103T055059`（pass，退出码 0）

- 28 条断言全 pass；1 张截图（`56-panel-after-batch`，批量后真 UI 更新面板：B 失败提示 + C 重新检查中）；29 raw。
- 单包安装：`update.install.exec` 恰 1 行 `route=cli-process ok=true exitCode=0`；`update.install.verify` `result=restart-required pendingRestart=true`（通道 B 不热换）。
- B 失败事件面：exec `{pluginId:fxa-b, ok:false, exitCode:1, durationMs:6047}`；`install.fail {stage:exec, reason:timeout, code:install-failed}`；`verify {result:failed}`。
- 批量 summary（raw 40）：`{total:3, ok:1, failed:2, skipped:0, durationMs:13285, stoppedBecause:finished}`。
- 契约四关（raw 47）：`checkedRows=84, unknownEvents=[], levelMismatches=[], fieldViolations=[], enumViolations=[]`。
- 事件计数（raw 46，89 行）：见 §4 表。`host.start=5` 是非契约事件（清单无此事件，审计白名单排除）。
- 命名空间：`[fxa-a,fxa-b,fxa-c,fxb-b,fxb-c]`，与夹具身份派生集合完全一致；exec 行 ns===pluginId（`execOwnership=[]`）；每 ns 行数 22/31/32/2/2 ≤500；parseFailures=0。
- 台账（raw 44）：A `completed 0.0.2/prev 0.0.1`；B `failed`；C `failed`（B 半删导致级联失败，注入副作用，如实记账；断言口径为「C 无成功记录、每插件 ≤1 条」）。
- 锁注入（raw 30）：`targetPath=…\node_modules\dsh-plugin-update-fixture-b\lib\index.js`、`lockPid=96884`、`probeExitCode=3`（独占打开被拒=锁真生效）、`installTimeoutMs=6000`、`holdSeconds=180`；raw 42 记录释放后进程已死。

### 3.2 j2 `273-20261103T054531`（pass，退出码 0）

- 16 条断言全 pass；2 张截图（`27-panel-before-check`、`35-panel-update-available`）；21 raw。
- 静置窗口：轮询 100 次（每页 53/52），新增行 0（常驻 0）。
- 状态变化：`clicked=true`；`update.status.changed(update-available/latest=0.0.2)` 恰 1 行。
- 再等 20 次轮询：同指纹仍 1 行。
- 面板原文：「…有新版本 0.0.2 可安装（当前版本 0.0.1）。…」（截图 actual 同文）。
- 行预算：nsCounts `{fxa-a:16,fxa-b:2,fxa-c:2}`、totalRows=20、parseFailures=0。

### 3.3 j3 `273-20261103T054540`（pass，退出码 0）

- 17 条断言全 pass；1 张截图（`37-panel-log-health`，面板日志路牌+健康读数）；22 raw。
- 健康读数：「日志：落点=self（本包自建落点）；目录指纹=150c0975；按需信息开关=关；启动以来丢弃 0 行；最近事件=11/3 05:45；事件契约=正常」。
- 对账：`sink=self`、`dirHash=150c0975=wire.logDirHash`、`logSink=self`；degraded=0、renderFail=0；最近事件 deltaMs=56615。
- 客户端事件：names=`[update.panel.mount, update.panel.action]`，outside=[]。
- 负向：伪造 `update.install.exec` → `accepted=0, dropped=1`，伪造行=0，execBefore=execAfter=0。
- 收尾：页面/CLI 宿主全退，pidAlive=false、端口释放。

### 3.4 can-red `273-20261103T054614`（fail，退出码 1，预期）

- 14 断言：13 pass + 1 fail。
- 前置 pass：真安装 exec 行数=1、matched=true；clean 契约四关全过（checkedRows=15）。
- 唯一红 `29-assert`：「删掉本 run 私有契约里的 update.install.exec → 真 exec 行必须被判成未知事件」：`removedEvent=true; unknownEvents=["update.install.exec"]; exec 未知行数=1`。
- 红点可归因：仓库契约与 src 未改，注入只发生在 run 私有副本；同一批日志在 clean 契约下四关全过、在删后契约下恰红一处。

## 4. 事件覆盖表（j1 定稿 raw 46，共 89 行）

| 事件 | 次数 | kind | level |
| --- | --- | --- | --- |
| `update.wire.ready` | 5 | resident | info |
| `host.call` | 17 | resident | info |
| `host.call.fail` | 2 | resident | warn |
| `update.check.done` | 8 | resident | info |
| `update.status.changed` | 19 | resident | info |
| `update.install.request` | 3 | resident | info |
| `update.install.exec` | 3 | resident | info |
| `update.install.verify` | 3 | resident | info |
| `update.install.fail` | 4 | resident | warn |
| `update.install.retry` | 2 | resident | info |
| `update.queue.transition` | 13 | resident | info |
| `update.batch.run.start` | 1 | resident | info |
| `update.batch.entry.request` | 1 | resident | info |
| `update.batch.entry.fail` | 2 | resident | warn |
| `update.batch.summary` | 1 | resident | info |
| `host.start` | 5 | —（契约外审计事件） | — |

覆盖结论：本格实际触达的 15 个契约事件全部通过「事件名/level/字段/枚举」四关；必备常驻事件覆盖集合（wire.ready/check.done/status.changed/install.request/install.exec/install.verify/install.fail/batch.run.start/batch.entry.request/batch.entry.fail/batch.summary）每项 ≥1；按需事件（kind=ondemand）零行；本格不应出现的降级/失败面（log.degraded/panel.render.fail/store.fail/check.fail）零行。

## 5. 噪声实测数字

- 静置：100 次真实 `updateStatus` 轮询（两页 53/52，页面开着并在轮询，raw 记轮询样本与窗口起止），新增日志行 **0**。
- 状态变化：恰 1 条 `update.status.changed(update-available, latest=0.0.2)`；随后 ≥20 次轮询不重复。
- 长期预算：每命名空间 ≤500 行（本格最大 32 行）；j2 全程 20 行。
- `host.call` 的轮询静默由产品日志层保证（成功且状态未变的 updateStatus 不落常驻行），J 组用真 UI 页面而不是电话模拟来证明这一点。

## 6. 落点与白名单事实

- 日志根：`<DSH_HOME>/logs/<namespace>/<YYYY-MM-DD>.log`；本格命名空间集合由夹具身份派生：A 集成方 `fxa-a/fxa-b/fxa-c`，B 集成方 `fxb-b/fxb-c`。即使只装 A，A 的批量接线也会把 B/C 的 runtime 登记进来，各写自己命名空间——不是串台。
- 属主判定：`update.install.exec` 行的 `ns` 必须等于其 `pluginId`（本格 execOwnership=[]）。
- 客户端事件白名单（`src/log/client-queue.ts`，6 值）：`update.panel.mount`/`update.panel.action`/`update.panel.render.fail`/`update.panel.state`/`update.lang.applied`/`update.log.degraded`；本格磁盘客户端事件为前两个，全在属主 `fxa-a`。
- 白名单负向：`logAppend` 电话只收客户端事件；伪造宿主事实事件 `update.install.exec` 被协议拒收（accepted=0/dropped=1），不落盘、不冒充宿主事实。

## 7. 产品真相与 UI 口径（重要）

- **web GUI 没有独立的插件日志查看器**。仓库旧研究（`docs/research/20261014-dsh-host-logging-surface.md`、`docs/adr/0005-dsh-log-as-first-runtime-dependency.md`）已证宿主没有通用日志面板；本票真机复探（runtime 下 probe5）确认导航只有 插件/自动化任务/更多，没有日志页。
- 面板上确实存在的「日志面」是更新面板 04 诊断章节：日志路牌（`src/panel/render.ts:1035-1067`，文案 `shared/copy.ts:431`）与日志健康读数（`src/log/health.ts` + `dictionary.ts:655-660`）。j3 用真 UI 断言这两行与磁盘日志同源；这不等于「有日志查看器」，笔记与矩阵都按此口径写。
- 04 诊断章节只在失败/待重启/受阻/可更新等横幅状态渲染。j1 批量后 A 行处于「正在查询版本信息」状态，页面无 04 章节，故 `.dsh-upd-log=0`——这是产品设计，不是证据缺失（j1 的硬断言在日志/台账/电话，j3 单独硬断言健康卡）。openPanel 的通用挂载断言因此只要求 `.dsh-upd` + `[data-fixture]`。
- 通道 B（CLI 宿主）安装不热换：`update.install.verify.result=restart-required / pendingRestart=true` 是安装瞬间的真话（与 T8 i2 一致）。

## 8. 产品 BUG

**无**。J 组未发现需要修 src 的行为/契约缺陷；上述「面板无独立日志查看器」「04 章节按状态渲染」「通道 B 不热换」都是既有产品设计，已在证据与文档中如实记录。

## 9. 试错记录

1. 首跑 `fixtures 未知场景 id`：声明文件还没加 J 三条就跑了；先加声明再跑。
2. **坏 tarball 注入被 pnpm store 命中**：corruptPublishedTarball 改字节成功（sha 变/200/200/versionDocUnchanged），但本机 store 已有正确 0.0.2，pnpm 直接命中 → B 安装成功、j1 五红。结论：同机不可重复的注入不能当失败格；改独占文件锁 + 6s 预算。
3. `batchInstall {keys:['b']}` 单行重试时批量会话不收尾（a/c 仍 pending），产品不落 `update.batch.summary`——产品真话不是 bug。j1 改为 `batchInstall {}` 整轮，批量 summary 才有 `failed≥1`。
4. 整轮批量会继续推 C（B 半删级联失败，C 也有 failed 台账）。断言从「C 行数=0」改为「C 无成功记录、每插件 ≤1 条」，note 写明注入副作用。
5. j3 首跑健康读数解析出 `落点= elf`：页面脚本是模板串，`/\s+/g` 被模板串吃成 `/s+/g`，DOM 文本里的字母 s 被替换成空格（self→" elf"）。修法：脚本里写 `\\s+`。证据类 bug，已修并复跑。
6. j1 加图后 55-assert 红（`.dsh-upd-log=0`）：见 §7 的 04 章节渲染条件。openPanel 挂载断言改为 `.dsh-upd`+`[data-fixture]`，j1 截图 verdict 同步调整。
7. 声明文件被一次错误的 splice（end 索引 -1）截断成 31807 字符。恢复：从 git HEAD 取基线（30322 字符），重新插入 J 常量/三声明/SCENARIOS 三行，重建后 34065 字符、两套 tsc 全绿。
8. （环境）早期并行探针/试错曾撞同一秒 run 目录导致 verdaccio 建号冲突；定稿改为错峰启动（本次 j2/j3 相隔 9s、j1/can-red 单独跑），四份定稿 run 目录互不冲突。

## 10. 证据卫生

- 全部试错 run 一律 `--no-evidence-sync`，定稿前 `git status` + `selftest/evidence/runs` 检查无任何 `273-*` 残骸（仓库内首次出现 273 目录即四份定稿同步）。
- 定稿 run 目录只由 harness 自动复制：`run.json`（断言/截图索引/environment.head=cffcf3c）+ `index.md` + `shots/`（png+六字段 sidecar）+ `raw/`（22–29 份原始记录）。
- 试错 run 全部留在仓库外 `D:/dsh-plugin/_wt263/runtime/t9-273/`，未入库。

## 11. 门禁

在干净 HEAD `cffcf3c` + 证据/文档改动的工作树上串行跑（2026-11-03 05:52–05:53，脚本 `runtime/t9-273/gates.ps1`），整链 exit 0：

- `npx tsc -p selftest/tsconfig.json --noEmit`：exit 0。
- `npx tsc -p selftest/tsconfig.tooling.json --noEmit`：exit 0。
- `node --test selftest/fixtures/generator/fixture-package-plan.test.ts`：exit 0（声明 ↔ 矩阵双向校验含本票 3 行）。
- `npm run build`：exit 0。
- `npm run test:batch`：exit 0（E3b 既有 flake 未出现）。
- `npm run check`：exit 0；`tests 2103 / pass 2102 / fail 0 / skipped 1`（该 skipped 为仓库既有跳过用例）；双语、文案源 grep、字典快照、错误码分支契约（17 码）、诊断解析契约（20 键 ×17 码）全部 `[通过]`，违规 0。
- `npm run docs:log:check`：exit 0（对 `host.call`/`update.install.exec` 等清单事件缺行只告警、不失败）。
- `npm run smoke:log`：exit 0（端到端日志冒烟通过）。

## 12. 提交与合并

- `cffcf3c` `test(#273): add J log-panel scenarios (j1/j2/j3) and runner`（4 files, +1927：声明 3 条 + 矩阵行、场景 `j-log-panel.ts`、工具 `run-j-log.ts`；定稿 run 都跑在这个干净 HEAD）。
- 定稿证据 4 个 run + 账本（coverage-matrix / runs README / can-red 表）+ 本笔记随后以 `docs(#273)` 提交。
- 合并：`git merge --no-ff` 到 `integration/spec-263`（不 push）；合并 SHA 见交付报告。

## 13. 盲区与残余风险

- 「日志面板」没有独立查看器，J 组 UI 证据只能取面板内日志路牌/健康读数；若集成方期望完整事件浏览 UI，属产品范围外（本票不新开公开子路径）。
- 每命名空间 ≤500 行是自定预算阈值，不是产品契约；产品侧没有强制行数上限，长期运行需靠 resident/ondemand 分流与轮询抑制。
- j1 的 C 级联失败是锁注入副作用，不能读成「C 自己坏了」；j1 断言已按「C 无成功记录」如实限定。
- `host.start` 是宿主审计事件、不在 `event-list.update.json` 内；契约校验对它是白名单排除，不是漏检。
- web UI 驱动依赖 Playwright（`DSH_VERIFY_PLAYWRIGHT`），headless 渲染与真实桌面窗口仍有差异；本票 UI 证据以 DOM 文本/截图为准。
