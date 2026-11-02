# #269 T5：批量三包真机场景（升级、部分失败隔离、续跑/重试）决策笔记

日期：2026-11-02。工作树：`D:/dsh-plugin/_wt263/t5`（分支 `impl/263-t5`，基线 HEAD `32a8259` = `integration/spec-263` tip，含 T0–T4 实现与 #265～#268 两个产品 BUG 修复）。定稿证据的 SUT commit：`9c094c7`。

## 1. 一句话结论

在官方桌面真机上，用 A 面板宏「全部更新」把 A/B/C 三个夹具包从 0.0.1 批量升到 0.0.2：三条场景 upsell（全成 / 部分失败隔离 / 恢复后续跑重试）全部 pass，can-red 真失败 run 退出码 1 且恰好 1 条红、红点可归因到断言本身。期间发现并修复 1 个产品 BUG（宿主重载换手窗口的 check-expired 重试不足，`fix 997ad69` + 3 条确定性单测），另解决 1 个夹具环境非确定性（verdaccio 实时拉 npmjs 不稳 → run 内本地镜像，`test 9c094c7`）。

## 2. 设计与路线

- **三包身份**：A=`fxa` 批量集成方（selfOrder=first，targets=[a,b,c]，发起「全部更新」的面板）、B=`fxb` 批量集成方（targets=[b,c]）、C=`fxc` 纯目标（无更新接线）。三条包都装在同一个 `desktop` profile。
- **真实入口**：真 UI 点 A 面板检查更新 → 宏「全部更新」；不直接打 updateInstall 电话。安装窗内只轮询磁盘/台账（每次成功会触发宿主自重启，旧 CDP 失效）；停宿主后再读递归日志与台账。
- **每 run 现场发布**：pinSutForRegistry 钉 SUT → npmjs 依赖镜像（§5）→ 三包 0.0.1 基版 → 带 run stamp 的三包 0.0.2 变体（构建内容变化，tarball sha256 唯一，不依赖 pnpm store 缓存命中）。
- **隔离**：每 run 独立 DSH_HOME（`run.homeDir`）、独立 `--user-data-dir`、独立端口、仓库外 verdaccio（run 内独立 storage）、run 私有 pnpm store（`raw/07-pnpm-store-isolation.json`）；不触碰维护者 DSH_HOME（本组不传 `--maintainer-home`，`maintainerProfile=null`）。
- **四个 mode → 三条声明**（can-red 复用 upgrade 声明，注入点在 run note/raw 标记）：

| mode | 场景声明 id | 用途 |
| --- | --- | --- |
| `three-package-upgrade` | `e-batch-three-package-upgrade` | 三包全成（UI/台账/磁盘/重启四处一致） |
| `partial-failure` | `e-batch-partial-failure` | 改坏 B tarball 字节 → 坏行失败、好行完成、无全批假成功 |
| `resume-retry` | `e-batch-resume-retry` | 恢复 tarball → 产品自动续跑/重试 → A/C 不重复、B 恰一次成功、总账 3 条 |
| `can-red` | `e-batch-three-package-upgrade` | stale-variant C（版本号新、内容旧）→ 预期红 |

- **代码位置**：`selftest/real-machine/scenarios/e-batch-three-package.ts`（`runEBatchScenario`）、`selftest/real-machine/tools/run-e-batch.ts`、`selftest/fixtures/identity/scenario-declarations.ts`（三条 E 声明）、`selftest/fixtures/release/npmjs-mirror.ts`（§5）、`selftest/fixtures/generator/fixture-package-plan.test.ts`（声明/矩阵核对 + 镜像纯函数单测，314 条断言）。

## 3. 逐格做法与证据

三条 pass run 的 `run.json.environment.head` 都是 `9c094c7`，`sut.distDigest=e8cef960ed4baca3…`，`installedDistMatch=true`；`cleanup` 段所有桌面进程 `aliveAfterStop=false`、registry 端口 `released=true`。

### 3.1 E1 三包全成（run `269-20261102T224509`，pass / 退出码 0，16 断言，3 图 25 raw）

动作：干净 profile CLI 装 a/b/c@0.0.1 → 起官方桌面 → 发布三包 0.0.2 → A 面板真 UI「检查更新」→ 宏「全部更新」→ 磁盘轮询到三包 0.0.2 → 停宿主读日志/台账/批量账本 → 重启看三卡片与面板。关键断言：

- `25-assert` 宏批量落盘：`versions` 与 `dependencies` 三包都 0.0.2；`observed` 显示串行推进（a→b→c，每次成功宿主自重启后 CDP 重建）。
- `27-assert` 台账逐行真相：fxa/fxb/fxc 三插件各 1 条 `completed`，`target=0.0.2`、`previous=0.0.1`。
- `35-assert` 日志链：`update.install.request` 覆盖 a/b/c 三目标命名空间；`host.call` update-install ok=true；`update.wire.ready` hostKind=desktop-manager；batch summary≥1；exec 失败=0；`installAudit.nonCheckExpired=0`、`unretried=0`；无 error/check.fail。
- `38-assert` 重启后 UI：A/B 卡片 clientTag/hostTag 都是 `client v0.0.2`/`host v0.0.2`，C 徽标 `client v0.0.2`，A 面板三行 `current/done 0.0.2`。
- `40-assert` 重启后台账/磁盘与 UI 三处一致（不产生新台账、不回退）。
- `43-assert` 批量账本/中枢/队列：属主 fxa 三键 `["a","b","c"]`、`hubPlanOwners=["fxa"]`、`waiting=[]`、`lease=null`，无跨 scope 污染。
- `44-assert` 收尾：bootstrap/main/after-batch-restart 三个桌面进程全退，registry 端口释放。

证据：`shots/18-shot.png`（基版 UI）、`23-shot.png`（检查更新后三行可更新）、`39-shot.png`（重启后三包新版）；raw 关键件 `03-dependency-mirror`、`19-fixture-published-variants`、`24-batch-settled`、`26-ledger-after-batch`、`34-log-counts`、`37-final-state`、`42-batch-disk-facts`。

### 3.2 E2 部分失败隔离（run `269-20261102T224810`，pass / 退出码 0，17 断言，3 图 26 raw）

注入：三包 0.0.2 发布后，改坏 B@0.0.2 的 **tarball 字节**（sha256 `799ea28992729f90…` → `3536eb271f4bbbcd…`，元数据/版本文档/dist.integrity 一字不动 ⇒ check 能过、install 必失败）；记录在 `raw/21-registry-tarball-corrupted.json`。

- `27-assert` 部分失败隔离：A/C 磁盘=0.0.2，B 磁盘=null；B 台账 1 条 `failed`（target=0.0.2）；无全批假成功。
- `28-assert` 坏行台账真相：`count=1`、`states=["failed"]`、`failureCode=install-failed`、message 含「目标包已被宿主移除，重装失败…复制手工命令重新安装」，载体命令带 `dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-b@0.0.2 …`。
- `30-assert` 好行不受影响：A/C 各 1 条 `completed`、target=0.0.2。
- `38-assert` 失败日志：B `requests=1/execs=1/execFails=1/execOks=0`（`durationMs=72193`，stage=exec/reason=nonzero-exit/code=install-failed），无自动重试；A/C execFails=0；`installAudit.nonCheckExpired=1`、`unretried=1` 且都属 fxa-b（设计内真失败）。
- `41-assert` 重启后如实展示：B 行不谎称成功、不谎称在飞；台账仍 failed。

证据：`shots/18-shot.png`、`25-shot.png`、`42-shot.png`（重启后部分失败如实展示）。

### 3.3 E3 恢复后重试/续跑（run `269-20261102T225353`，pass / 退出码 0，22 断言，4 图 49 raw）

流程：先跑部分失败前缀 → 停宿主取失败后日志（`raw/50-log-counts-before-retry`）→ 恢复 B@0.0.2 tarball（`52-assert`：HTTP 200、sha 复原、版本文档不变）→ 再起宿主，产品自动续跑未完成批次（`raw/54-panel-before-retry-open`：B 行 `installing`、busy=true）→ B 装成。

- `56-assert` 恢复后落盘：三包磁盘=0.0.2，`retryPath=auto-resume`（产品路径，非手工 CLI），开面板瞬间 B 行正在安装。
- `66-assert` 续跑语义：重试前 A/C `requests=1/execs=1`、B `requests=1/execs=1/execOks=0`；重试后 A/C 计数不变，B `requests=2/execs=2`、`execOks=1`；`retryAudit.unretried=0`。即 A/C 不重复安装、B 恰好失败一次成功后一次。
- `71-assert` 总账：fxa/fxb/fxc 各恰 1 条成功终态（`completed`，target=0.0.2），磁盘三包=0.0.2，无重复、无丢行。
- `69-assert` 重启后 UI：三卡片新版、A 面板三行 current 0.0.2；`74/75-assert` 批量账本三键、收尾全退。

说明：B 的「失败一次 + 成功一次」由日志计数（`66-assert`）证明；台账不新增第二条成功记录（同一作业被重试推进为 completed），这正是「终态唯一」的验收点。

### 3.4 can-red（run `269-20261102T230056`，fail / 退出码 1，16 断言 = 15 pass + 1 fail，3 图 25 raw）

注入：C@0.0.2 用 0.0.1 内容构建（`stale-variant C`，版本号新、内容旧；run 私有 pnpm store 防缓存命中）。预期红 = 重启后 C 卡片构建标记仍是旧版，而台账/磁盘都说 0.0.2 成功。

- 唯一红点 `38-assert`「can-red 三包成功诚实性（预期红：C 内容仍旧版）」：actual 显示 A/B 卡片 `client v0.0.2`/`host v0.0.2`、面板三行 `done 0.0.2`，但 `seatC.clientTag="client v0.0.1"`、`badge="夹具 C · client v0.0.1"`。
- 其余 15 条（SUT 钉版、基版安装/UI、三包变体发布、检查更新、批量落盘 0.0.2、台账三条成功、日志链、重启后台账/磁盘一致、批量账本、收尾）仍 pass —— 证明红的是「成功诚实性」断言本身，而不是安装链整体崩掉。
- 注入点与预期失败点写在 run.json `notes` 与该断言的 `note`；`shots/39-shot.png` 是同名失败现场（sidecar 四段含 expected/actual/判定）。

## 4. 产品 BUG：宿主重载换手窗口的 check-expired 重试不足（#269/205101）

**首次证据 run**：`269-20261102T205101`（HEAD `53a35bf`，fail/退出码 1，13 断言）。失败面：`24-assert`（磁盘只有 A=0.0.2，B/C 仍 0.0.1）、`26-assert`（B/C 台账为空，只有 A completed）、`34-assert`（`requests=1` 仅 fxa-a；`installAudit.failCount=5/retryCount=3`；namespaces=[fxa-a,fxa-b,fxa-c]）；`37-assert` unknown（重启后 A 面板三行等 180s 超时，是 #24 的后果，不是第二个 BUG）。

**时间窗（三份递归日志同刻，2026-11-02 12:53）**：

```
27.470 update.batch.entry total=3 pending=3
27.526 fxa-a 首次 install.request → gate 拒 check-expired → 重查重提成功
30.522 update.wire.ready（fxa-a/fxa-b/fxa-c 同刻，宿主重载）
30.538 fxa-a install.exec ok durationMs=2965 → 30.553 verify=restart-required
30.589 fxa-b install.request → 30.592 gate 拒 check-expired
30.604/30.610 status/check.done ok → 30.618 host.call fxa-b.updateCheck ok 17ms
30.625 用新 checkId 重提 → 30.627 **再次 gate 拒 check-expired**
30.635 update.install.retry reason=check-expired attempt2
30.638 update.batch.entry.fail errorKind=check-expired stage=install index=1
         fxa-c 同形：30.654/30.657/30.674/30.688/30.691/30.696/30.698
30.664 update.batch.run.start trigger=resume resumed=true total=3 pending=1
30.706 update.batch.summary total=3 ok=1 failed=2 → 但 B/C 台账目录为空
```

**机制**：宿主重载后新旧 driver 短暂并存（约 200ms），check 与 submit 可能落到不同实例；gate 在 `src/core/service.ts:1064`（`checked.checkId !== checkId || now >= checked.expiresAt`）不认另一实例签发的 checkId；原 `src/host/batch/phones.ts` 的 check-expired 分支只做一次「重查 + 重提」，重提再被拒就直接落 failed（`kind=failed,error=check-expired,stage=install`）。205101 里首次被拒距重载 65–170ms、20ms 内重提仍拒；对照 211934 里重载后 220ms 重提即成功 —— 说明是换手窗口而非凭证 TTL。

**复现率**：4 次真机 upgrade（`193902` pass、`205101` fail、`211934` pass、resume `210718` pass）约 1/3–1/4，未稳定复现；按 known-red 规则（只登记已确认、稳定复现的失败）**不登记 known-red**，以本笔记 + 产品 BUG 报告记录。205101 证据只留在 `runtime/t5-269/269-20261102T205101/`（含失败 raw），不进 runs/ 交付账本。

**修复（`997ad69`）**：

- `src/host/batch/phones.ts:97-102` 新增 `CHECK_EXPIRED_RETRY_LIMIT = 2`、`CHECK_EXPIRED_RETRY_DELAY_MS = 300`（注释写明 205101 换手窗口 <200ms，只把宿主重载当瞬态）。
- `:399-430` 把单次重查重提改为有界循环：最多 2 次重试（总提交 3 次），每次先 `await sleep(300)`，每次照旧发 `update.install.retry{reason:'check-expired',attempt,requestHash}`（attempt 递增 2→3）；最终仍失败才 `failed(error=check-expired,stage=install)`；绝不无限重试。
- `tests/batch-check-expired-backoff.test.mjs` 3 用例（走 dist + 注入电话 handler）：前 2 次拒第 3 次成 → `done/restartRequired=false`、installs 3 次、checks 2 次、retry 行 attempt=[2,3]；3 次全拒 → `failed{error:check-expired,stage:install}`、installs 3 次、checks 2 次；首次即成功 → installs 1 次、checks 0、无 retry 行。
- 边界：双 driver fencing（根治）需改 run.ts + 宿主持久化，超出本票范围，已作为 known issue 报 Lead 另开票；本次修复只把重载换手当瞬态并压低概率。
- 修复后验证：`215242`（pass）、`224100`（pass，镜像后）、定稿 `224509`（pass）连续三次 upgrade 均无未重试的 check-expired 失败。

## 5. 环境非确定性：npmjs 依赖镜像（215839 / 220513 两次 unknown）

**现象**：安装 `dsh-plugin-update-fixture-a@0.0.1` 时，pnpm 经本 run 的 verdaccio 拉 SUT 的运行时依赖 `dsh-log@0.3.4` 失败。SUT `package.json` 的唯一 dependencies 就是 `dsh-log ^0.3.4`，因此每个 run 的基版安装都要过一次 npmjs uplink。

原文（215839，`raw/09-scenario-error.json`）：

```
[WARN] GET http://127.0.0.1:65206/dsh-log error (503). Will retry in 10 seconds. 2 retries left.
[WARN] GET http://127.0.0.1:65206/dsh-log error (503). Will retry in 1 minute. 1 retries left.
[ERR_PNPM_FETCH_404] GET http://127.0.0.1:65206/dsh-log: Not Found - 404
```

原文（220513，`raw/09-baseline-install-retry-1.json` → `10-baseline-install-retry-2.json` → `11-scenario-error.json`）：

```
[WARN] GET http://127.0.0.1:64535/dsh-log/-/dsh-log-0.3.4.tgz error (UND_ERR_SOCKET). Will retry in 10 seconds. 2 retries left.
[WARN] GET http://127.0.0.1:64535/dsh-log/-/dsh-log-0.3.4.tgz error (ERR_PNPM_FETCH_500). Will retry in 1 minute. 1 retries left.
→ attempt2: [WARN] … error (ERR_PNPM_FETCH_TIMEOUT) → [WARN] … (ERR_PNPM_FETCH_500) → [ERR_PNPM_FETCH_500] GET … Internal Server Error - 500
→ 第三次仍 500：[ERR_PNPM_FETCH_500] GET http://127.0.0.1:64535/dsh-log/-/dsh-log-0.3.4.tgz: Internal Server Error - 500
```

pnpm.log 路径：`operation-bIXqIz`（215839）、`operation-xCq81N` / `operation-DdoZkw`（220513）。

**判定**：verdaccio 到 `registry.npmjs.org` 的 uplink 流式 tarball 拉取不稳（当天已跑 30+ run，每 run 现拉 npmjs，触发限流/慢）；本机直连 `npm view` / curl 同时刻 200（22:16 已恢复）。**不是产品 BUG**，也不是 SUT 回归；只加基版安装重试（`128ee88`）只降低概率，不消除对 npmjs 实时可达的依赖。

**修法（`9c094c7`）**：`selftest/fixtures/release/npmjs-mirror.ts` ——

1. 从 SUT `package.json` 的 dependencies 解析镜像包（当前仅 `dsh-log ^0.3.4`）。
2. `resolveNpmjsMirror`：`npm view '<name>@<range>' version --json --registry=https://registry.npmjs.org` 解析确切版本（**唯一联网步骤**），结果写 `runtime/tools/npmjs-mirror/resolved.json` 缓存，后续 run 直接读缓存不联网；`npm pack <name>@<version>` 缓存 tarball 到 `runtime/tools/npmjs-mirror/<name>-<version>.tgz`（仓库外），记录 sha256 与来源。
3. `publishNpmjsMirror`：复用 `registry-client.publishTarball`（`--ignore-scripts`）+ `waitForRegistryVersion` 发布进本 run verdaccio。
4. `verdaccio-runtime.renderVerdaccioConfig` 新增 `localOnlyPackages`：镜像包 + 现有 `dsh-plugin-update*` / `fixture*` 生成**不带 proxy npmjs** 的规则（否则同名同版本本地发布会被上游 409 拒）；缺省值 `DEFAULT_LOCAL_ONLY_PACKAGES`。
5. `createFixtureEnvironment` 在起 registry **前** resolve 依赖计划（config 需要知道镜像包名）、起 registry 后 pin SUT 之后 publish；`raw/03-dependency-mirror.json` 记每依赖 range/resolved/source/cachePath/sha256/publish exit/registry 可见版本；解析/打包失败 fail-fast 成工具错误（不会拖到基版安装里变成 unknown）。

单测（`fixture-package-plan.test.ts` 第 10 节，+25 断言 → 314 条）：localOnly 规则（无 proxy、去重、顺序在 `**` 前）、npm view 版本解析（单版本/多版本取最高/非 JSON 抛错）、缓存文件名（普通/作用域）、默认缓存目录、`resolved.json` 缺失/坏 JSON/坏条目容错、写缓存保留旧条目。

**效果**：定稿四 run（`224100`/四个 22:44–23:00 的 run）`03-dependency-mirror.json` 全部 `resolvedFrom="cache"`、`publish.exitCode=0`，基版安装零 uplink 实时依赖。

**对 T6–T11 的复用**：任何走 `createFixtureEnvironment` 的真机场景自动继承镜像；SUT 新增 dependencies 会自动进镜像计划（无需改场景）；缓存目录跨 run 共享（仓库外，可删）；首次联网失败（缓存未建立时）表现为工具错误 exit 2，重跑即可，缓存建立后完全离线。

## 6. 试错 run 记录（全部仓库外，不入证据包）

`runtime/t5-269/evidence-quarantine/`（12 个目录，试错或环境失败）：

- `269-20261102T192950` upgrade unknown：重启后谓词只收 `row.phase==='current'`，产品实测可能是 `done` → 修 selftest 谓词为 `current||done`。
- `269-20261102T193902` upgrade pass 试跑。
- `269-20261102T194226` 早期崩溃（无 run.json）。
- `269-20261102T195427` partial fail 试跑；`200030` partial pass。
- `269-20261102T200532` resume unknown；`201519` resume fail；`202332` resume fail（Windows 瞬态 `[EPERM] rename … package.json.261308548 -> … package.json`，非产品）；`203534` resume pass。
- `269-20261102T204325` can-red 试跑：重启后 C 卡片旧版恰好 1 条红，验证 can-red 设计。
- `269-20261102T220513` unknown：npmjs uplink（§5）；`221439` upgrade pass 试跑（镜像前 HEAD）。

`runtime/t5-269/` 下另有定稿前 run（保留原始证据、不复制进仓库）：`205101`（产品 BUG 证据，§4）、`210134`（partial fail：台账读时序，后加 `waitLedgerTerminal` 修复）、`210718` resume pass 试跑、`211306` can-red 试跑、`211934` upgrade pass 复现试跑、`212948` unknown（`dsh-log` 404 瞬时，同 §5）、`213843` partial pass 试跑、`215242/215839/220513/221439/224100`（见上）。

只有定稿四 run 进 `selftest/evidence/runs/`；试错 run 用 `--no-evidence-sync` 跑、或事后移出仓库（本次已把误入仓库的试错副本移到 quarantine）。

## 7. 证据卫生与日志截断

- 安装窗只轮询磁盘/台账（每次成功触发宿主自重启，旧 CDP 失效）；停宿主后再读递归日志/台账，避免活进程的瞬时租约/缓存。
- 日志 >50000 字符截断，尾段另存 `raw/*-tail.json`（resume run 的 `45-log-fxa-a-2026-11-02-tail`、`60-log-fxa-a-2026-11-02-tail`），run.json/index.md 标注截断量。
- 定稿四 run 的 `environment.head=9c094c7`、`sut.distDigest=e8cef960ed4baca3…` 完全一致；`cleanup` 段桌面进程 `aliveAfterStop=false`、registry 端口 `released=true`。
- 本组不采集维护者 profile 指纹（未传 `--maintainer-home`，`maintainerProfile=null`），不触碰维护者 DSH_HOME。
- 证据副本完整（raw 里的绝对路径是采集机原路径，复核只依赖 `runs/` 目录内副本）。

## 8. 门禁

在 `9c094c7` 上串行执行（脚本 `D:\dsh-plugin\_wt263\runtime\t5-269\gates.ps1`），全部退出码 0：

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| tsc（selftest） | `npx tsc -p selftest/tsconfig.json --noEmit` | exit 0 |
| tsc（tooling） | `npx tsc -p selftest/tsconfig.tooling.json` | exit 0 |
| fixture 计划单测 | `node --test selftest/fixtures/generator/fixture-package-plan.test.ts` | 1 test / 1 pass / 0 fail（314 条断言） |
| build | `npm run build` | exit 0 |
| 批量定向测试 | `npm run test:batch`（build 之后） | 192 pass / 0 fail（50 suites） |
| 聚合检查 | `npm run check` | exit 0（2092 tests：2091 pass / 1 skip / 0 fail；双语门禁通过） |

## 9. 提交与合并

本分支（`impl/263-t5`）提交：

- `53a35bf` `test(#269): 组 E 批量三包真机场景与运行工具`（scenario-declarations / registry-faults / e-batch-three-package / run-e-batch / coverage-matrix 三行）。
- `7892f4d` `test(#269): 批量三包场景台账读等终态、桌面重载清理与重启加固`。
- `997ad69` `fix(#269): 宿主重载换手窗口的 check-expired 有界退避重试`（phones.ts + tests/batch-check-expired-backoff.test.mjs）。
- `128ee88` `test(#269): 组 E 基版安装对 registry 上游瞬态做有界重试`。
- `9c094c7` `test(#269): npmjs 依赖镜像，真机 run 不再依赖上游实时可达`（npmjs-mirror + verdaccio-runtime/local-registry/registry-client/fixture-environment/t3-common + 单测）。
- 本笔记与证据账本（coverage-matrix E 行状态 + can-red 行、runs/README 四行、`selftest/evidence/runs/269-*` 四 run）随 docs(#269) commit 提交。

合并：`git merge --no-ff impl/263-t5` 进 `D:\dsh-plugin\_wt263\integration`（分支 `integration/spec-263`），未 push；合并 commit hash 见最终报告与 `git log -1`。
