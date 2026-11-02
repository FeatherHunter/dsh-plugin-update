# #267 T3：三条安装出口真机矩阵（决策笔记）

- 票：#267（规格 #263 的实施票 T3，C 组）；日期：2026-11-02；工作树 `D:\dsh-plugin\_wt263\t3`（分支 `impl/263-t3`，HEAD `cc140e7`）。
- 场景声明：`selftest/fixtures/identity/scenario-declarations.ts`（d1/d2/e1/e2/e3/f1 六条，矩阵行在 `selftest/evidence/coverage-matrix.md`）。
- 证据包：`selftest/evidence/runs/267-*`（8 个定稿 run）；真机 runtime 在仓库外 `D:\dsh-plugin\_wt263\runtime\t3-267`。
- 门禁与合并结果见 §10（跑完后回填）。

## 1. 一句话结论

本机（2026-11-02）**出口二、出口三各拿到成功＋失败真机证据**（出口三另有超时），**出口一因本机没有第三方 Desktop 而不可达**——留三份能力探测原文 + 官方桌面 `hostKind=desktop-manager` 负向证据，登记 known-red，不伪造真机结果。两条宿主通道上「产品给出的人话格手工命令」都被**原样真机执行成功**（exit 0、磁盘到 0.0.2、重启后代码换版）。两条 can-red 真失败 run 分别证明出口二「重启后新版 UI」与出口三「运行代码真的换了版」断言会红。

## 2. 路由判定与宿主通道

- 判定在 `src/host/environment.ts:109-129`：
  - 有 `desktopProfiles` 服务 → `desktop`（出口一，第三方 Desktop）；
  - 否则 `pluginManager.installBundle` 存在且使用范围名恰为 `desktop`（大小写不敏感）→ `desktop-manager`（出口二，官方桌面 in-process 管理器）；
  - 其余 → `cli`（出口三，宿主 spawn CLI 子进程）。
- 本机宿主清单（f1 run `267-20261102T113042`）：只有官方桌面 `D:\DeepseekHarness`；第三方 Desktop 目录/卸载条目/服务计数全 0。
- 通道 A = `desktop-official`：CDP 起官方桌面（隔离 `DSH_HOME` + `--user-data-dir`），证据含 PNG 截图。
- 通道 B = `dsh-web`：官方发行里的 CLI 起普通 DSH web 宿主（`--profile t3cli --port 0 --no-open`，profile 名 ≠ desktop），**无窗口**，UI 证据是 DOM/pageText 原文与电话回包，没有 PNG（见 §4.5）。
- 真机路由观测：d1/d2 日志 `hostKind=desktop-manager` 且 `update.install.exec route=desktop-manager`；e1/e2/e3 `hostKind=cli` 且 `exec route=cli-process`；f1 唯一桌面宿主 `hostKind=desktop-manager`（反向证明 `desktopProfiles` 为空）。

## 3. 矩阵设计

- **声明单源**：`scenario-declarations.ts` 新增六条声明，矩阵行、证据 run 的 `run.json.scenarioId`、夹具版本/效果都从声明来；`fixture-package-plan.test.ts` 继续强制「每条声明 id 在 coverage-matrix.md 有行」。
- **格与 run 一一对应**：每格独立 run、独立断言组（d1 17 条、d2 18 条、e1 22 条、e2 25 条、e3 22 条、f1 10 条）；成功/失败/超时共用同一套基版/变体（A@0.0.1 → A@0.0.2，单面板效果），格间差异只有故障注入与断言组，不掺别的变量。
- **能力探测也走真机**：f1 不是纯静态探测——它按实际宿主启动一遍，用产品日志里的 `hostKind` 作为「本机没有出口一能力」的负向证据；出口一真机更新两格显式 known-red。
- **四态与退出码**：pass/fail/known-red/unknown，总判定取最坏（fail > unknown > known-red > pass）；全 pass 或仅 known-red 退出码 0，有 fail/unknown 退出码 1，blocked 退出码 2（`selftest/evidence/README.md`）。
- **can-red = 真失败 run**：故障注入在 raw 与 notes 写清；不拆断言迁就。两条：d1 的 `--mode can-red`（stale-variant）、e1 的 `--mode can-red`（stale-variant），各自恰好命中目标断言。
- **工具入口**：`tools/run-d-desktop-manager.ts`（--mode success|failure|can-red）、`tools/run-e-cli-host.ts`（--mode success|failure|timeout|can-red）、`tools/run-f-desktop-probe.ts`；共用 `scenarios/t3-common.ts` 的 `openT3Run`（run-layout/evidence/fixture-environment/sut-pin/maintainer-profile 指纹）。
- **证据包只放定稿 run**（8 个），试错 run 只在 §9 记录、不进 `selftest/evidence/runs/`；证据包内只副本 `run.json`+`index.md`+`raw/`+`shots/`（不含隔离 home/fixtures/registry 等临时大目录，raw 内文件副本自足）。

## 4. 逐格做法与证据

### 4.1 出口二成功（d1，run `267-20261102T094226`，pass/退出码 0）

- 做法：干净 profile 用 `dsh plugin add` 装 A@0.0.1 → 起官方桌面 → 面板点「检查更新」→ 点「安装更新」→ 关桌面 → 重启看 UI。
- 判据（关键断言）：
  - `08-assert` 基版三处一致（dependencies / bundles / 磁盘 package.json = 0.0.1）；
  - `10-assert` 装进 profile 的 SUT dist 聚合指纹等于工作树构建（真机跑的是当前构建）；
  - **`26-assert` 两步配方硬证据**：`.plugin-manager/logs` 按 `update.install.request → update.install.exec` 时间窗过滤（operation 目录 birthtime/mtime 与 `[from-3s, to+3s]` 相交），**恰好 2 个非空 operation**，先 `remove`（`- dsh-plugin-update-fixture-a 0.0.1`）后 `add`（`+ … 0.0.2`，含 `Done in`），顺序按 birthtime 断言；
  - `27-assert` **already-installed 守卫处理**：窗口内没有第三次 pnpm（宿主 HMR 把首次 `installBundle` 毫秒挡下，本包在该码上走 remove→install）；
  - `31-assert` exec `route=desktop-manager ok=true exitCode=0 durationMs=2587`；`32-assert` 无 `update.install.fail`；`33-assert` 全部 `hostKind=desktop-manager`；
  - `36-assert` 重启后 client v0.0.2 / host v0.0.2 / 标题含「新版」；`39-assert` 磁盘 0.0.2；`41-assert` 台账 completed/target 0.0.2/previous 0.0.1。
- 证据：`runs/267-20261102T094226/`（4 张截图；raw/24、25 是两个 operation 的 `pnpm.log` 原文副本）。

### 4.2 出口二失败（d2，run `267-20261102T110749`，pass/退出码 0）

- **为什么不是「check 后下架」**：首版注入（094809）在 check 后下架 0.0.2，产品候选门 `service.ts:927-1007` 复核元数据不一致，直接 `update.install.fail {stage:'gate', reason:'gate-refused', code:'check-expired'}`——没有进 exec。这是产品**正确**的诚实拒绝，不为了造失败改产品。⇒ 改为「元数据/integrity 不动、只让 pnpm 下载 tarball 失败」。
- 注入 A：失败格变体版 0.0.2 用**带本 run stamp 的注入标记内容**构建（`seatLine/hostBehavior` 加 stamp，构建标记仍是 v0.0.2），tarball integrity 与历史 run 不同 ⇒ 共享 pnpm store 必然 miss，删 tarball 后 pnpm 真的走网络。raw `failure-variant-injection` 记录原因。
- 注入 B：`runtime/registry-faults.ts` 的 `removePublishedTarball` 读元数据取 `dist.tarball` → 备份到 run 内 `registry-tarball-backup/` → 删除 → 复核 served 404 且版本文档 JSON 一字不差；不删版本、不改 integrity，check 能过（`registry-client.ts` 也补了 `unpublishVersion`/`waitForRegistryVersionGone` 能力，但下架会改元数据、撞 check 候选门，故本轮注入不用它）。
- 流程：check 正常看到 0.0.2 → 删 tarball → 点安装 → 管理器`removeBundle` 成功、第二次 `installBundle` 的 pnpm 404 → 失败定局（轮询台账 `state.json` 到 `failed`）→ 恢复 tarball → 执行失败人话格给出的手工命令 → 重启。
- 关键断言：
  - `25-assert` 失败定局后的诚实面：**面板随目标包被移除而消失**（`panelPresent=false`，页面回桌面 home），台账 `state=failed`；不伪造 DOM/截图（产品行为正确：目标包已不在 profile）；
  - `29/30-assert` exec `route=desktop-manager ok=false exitCode=1` + fail 八格 `stage=exec/reason=nonzero-exit/code=install-failed`；
  - `33-assert` operation 2 个：remove 命中 0.0.1 + add 的 pnpm.log 匹配 `ERR_PNPM/404`；
  - `35-assert` 台账 job.message 以 `install-failed:` 开头、含 pnpm 原话摘录、含「目标包已被宿主移除，重装失败」与载体命令 `dsh plugin --profile desktop add --save-exact …@0.0.2 --registry=…`；
  - `37-assert` 磁盘无虚假成功（node_modules/dependencies 里没有 A）；
  - `39-assert` 恢复 tarball 后 200 且元数据不变；
  - **`41-assert` 验收③**：人话格手工命令原样执行 exit 0，磁盘 0.0.2，stdout 含 pnpm 安装摘要；
  - `43-assert` 重启后面板 client/host v0.0.2。
- 真实形态细节：detail 受 300 字预算约束，pnpm 原话被截成 `[ERR_P`；断言按真实形态放宽到「失败码 + 移除事实 + 载体命令」为硬判据，不为了凑完整原文改产品。
- 证据：`runs/267-20261102T110749/`（3 张截图；raw 含 tarball 故障前后 HTTP/元数据、operation 日志、台账、手工命令 stdout）。

### 4.3 出口三成功（e1，run `267-20261102T111047`，pass/退出码 0）

- 通道 B：官方发行 CLI 在隔离 home 建普通 profile `t3cli`（非 desktop）→ 装 A@0.0.1 → 起 `dsh --profile t3cli --port 0 --no-open` → 夹具电话 `updateCheck` → `updateInstall`（异步受理）→ 等磁盘/日志完成 → 重启取 buildTag。
- 关键断言：`29-assert` `hostKind=cli` 且 `update.install.exec route=cli-process`；`32-assert` 磁盘/dependencies=0.0.2；`33-assert` exec ok=true exitCode=0 durationMs=979；`34-assert` 电话回包 42ms ≪ exec 979ms（电话先回、exec 后完，完成判据必须用磁盘+日志）；`39-assert` 重启后 buildTag=host v0.0.2。
- 日志读取教训：产品日志在 `<home>/logs/<pluginId>/<date>.log` 子目录，必须递归读；且**停宿主后**再读（进程收尾才冲刷缓冲）。e1 的 exec 行在本 run 自己目录读到，不借别的 run。
- 证据：`runs/267-20261102T111047/`（22 断言/20 raw；无窗口宿主，UI 证据为原始文本）。

### 4.4 出口三失败（e2，run `267-20261102T111127`）与超时（e3，run `267-20261102T112503`）

- e2：同 d2 的注入 A+B（删 0.0.2 tarball，元数据不动）→ CLI 子进程 pnpm `ERR_PNPM_FETCH_404` 非零退出。断言：`33-assert` job.message 以 install-failed 开头且含 404 原话（这次未截断，完整 pnpm 原话）；`34-assert` **不含载体命令**（registry 类失败没有手工命令）；`35/36-assert` exec `route=cli-process ok=false exitCode=1` + fail 八格；`37-assert` 磁盘仍 0.0.1；`38-assert` 回包 manual 含 `--profile t3cli … @0.0.2 --registry=…`；**`42-assert` 验收③** 原样执行 exit 0、磁盘 0.0.2；`44-assert` 重启 buildTag=host v0.0.2。
- e3：宿主 registry 指向 run 内延迟代理（挂住 pnpm 的 tarball 请求）+ 夹具 `installTimeoutMs=4000`（透传链 `fixtures/templates/integrator/integrator-host-half-template.ts` → `deps.config.installTimeoutMs` → `src/host/capabilities.ts` → `src/core/executor.ts:1363` 的 `recipe.timeoutMs`）→ 到点产品终止 CLI 子进程。断言：`33-assert` job.message=「安装超时，已终止子进程」（`CLI_TIMEOUT_DETAIL`，`src/core/executor.ts:100`）；`34-assert` exec durationMs=4111（预算 4000 + 3s 宽限内）；`35-assert` fail **reason=timeout**；`36-assert` 磁盘 0.0.1；`39-assert` 重启仍 host v0.0.1；`42-assert` 宿主/代理全停、端口释放。
- 无窗口：通道 B 的 UI 证据是 DOM/pageText 原文（电话回包、页面状态、产品日志），没有 PNG 截图；窗口截图证据由出口二 d1/d2 与 T10 UI 组承担（e1/e2/e3 的 run.json 备注、index.md 备注都写明）。

### 4.5 出口一探测（f1，run `267-20261102T113042`，known-red/退出码 0）

- 三项探测原文进 raw：文件系统（Program Files / Program Files(x86) / LOCALAPPDATA / APPDATA，深度 2；盘根深度 1；名字同族 `/dsh|deepseek|harness/i`）、注册表卸载表（HKLM/WOW6432Node/HKCU `Uninstall\*`，DisplayName 同族）、服务（Name/DisplayName 同族）。
- **假阳性修正**：首版按名字判同族命中 25 个「第三方目录」+ 1 个卸载条目，其实都是用户数据目录（`AppData\Roaming\@deepseek-ai\dsh-desktop`、`dsh-harness-desktop`）、临时探针目录、单文件 `D:\dshvm\dshvm-ui.exe`（无 Electron 发行结构）等。改为结构判据：`desktopLike = (resources/app.asar 或 resources/app 存在) && 同族 exe 存在`；nearMiss 单列原因，不算第三方。
- 结果：官方 1 / 第三方 0 / nearMiss 25（目录）；卸载表 3 条 / 第三方 0 / nearMiss 2；服务 0。官方 exe 与 asar 内 cli.js 均存在（asar 虚拟路径用 `ELECTRON_RUN_AS_NODE=1` 的探针脚本读，普通 node 的 stat 看不见，首跑因此红过）。
- 负向证据：本机唯一桌面宿主启动后 `hostKind=desktop-manager`（`24-assert`）⇒ `desktopProfiles` 为空，路由不可能落出口一。
- `25-assert`（出口一成功格）/ `26-assert`（失败格）known-red，note 写可复现条件；账本行 `selftest/evidence/known-red.md` 的 `t3-267-exit-one`。

## 5. 手工命令可执行性（验收③）

- 两个来源：安装电话回包 `manual`（`src/shared/commands.ts:256-288`）与失败码人话格里的载体命令（`src/core/executor.ts:884-892/:1065-1069`，仅 already-installed/bundle-in-use/not-removable 三码 + 启用步失败）。
- 真机执行方式：把命令原文按空白切分，要求前两 token 是 `dsh plugin`，**保留 `plugin` 子命令**后交给 `runDshCli`（`exe --expose-internals cli.js plugin --profile … add --save-exact … --registry=…`，与产品 spawn 的 argv 一字不差）。
- 实测：d2 `41-assert` 执行面板命令 exit 0、磁盘 0.0.2、重启 v0.0.2；e2 `42-assert` 执行回包 manual exit 0、磁盘 0.0.2、重启 buildTag v0.0.2。两者 stdout 均有 pnpm 的 `Packages: +3` / `Done in` 摘要。
- 教训：首版把 `dsh plugin` 两个 token 都切掉（`slice(2)`），CLI 走 profile boot 分支报 `profile "desktop" is managed exclusively by the Electron application`；改为 `slice(1)` 后正常。手工命令的执行方式也要与命令本身同口径，否则测的是另一条路。

## 6. known-red 条件（出口一）

- 登记：`selftest/evidence/known-red.md` 行 `t3-267-exit-one`（首次发现 run `267-20261102T113042`，SUT commit `cc140e7`）。
- 复现条件：一台装有**第三方 Desktop 发行包**、且其 launcher 在 Loader entry 挂载前注册 `desktopProfiles` 服务的机器；届时出口一成功格应走 `desktopProfiles.runPlugin(args, 使用范围目录, undefined)`（`done:Promise<{exitCode}>`、超时自设 deadline、无 terminate 如实写），失败格应覆盖宿主失败码/人话格/手工命令。
- 本机探测证据位置：`runs/267-20261102T113042/raw/capability-probe-{filesystem,uninstall-registry,services,classification}.json`、`raw/desktop-host-kind-negative.json`、run.json `25/26-assert`。
- 不伪造：没有第三方宿主就没有该出口的真机截图/日志；known-red 只记探测原文与可复现条件。

## 7. 边界与未做

- **出口二失败码真机不可控**：`not-removable`、`bundle-in-use`、`pendingBuilds` 批准流程、「移除步之后第二次安装失败」之外的管理器内部失败，需要特殊宿主状态或夹具 postinstall，本票未做真机注入；按库内测试与 known-red 口径处理（`tests/desktop-manager.test.mjs`、`tests/desktop-manager-hmr.test.mjs`、`tests/issue-194-pending-builds.test.mjs`、`tests/issue-236-manager-remove-failure-restore.test.mjs`）。d2 覆盖的是 HMR 宿主上「移除成功后重装失败」这一条真机可达路径。
- **removeBundle 后 bundle 次序**：d1 只记录更新后 `dsh.profile.bundles`（raw/34），未与更新前逐位对比；次序风险（文档 :196-199 的推断）仍未实测验证。
- **出口三 DSH_HOME 边界**：产品 spawn 的 CLI 子进程走 `@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv()`，剥掉全部 `DSH_*` 与 `/KEY|PASSWORD|SECRET|TOKEN/i` 环境名；子进程按 `homedir()/.dsh` 解析 home。⇒ 隔离测试里宿主 `DSH_HOME` 必须与 `USERPROFILE` 对齐（`homeDir=<run>/os-home/.dsh`、`USERPROFILE=<run>/os-home`），否则 CLI 装到默认 home、产品 verify 报 version-mismatch。普通用户 home 未被覆盖时两者天然一致，因此这是测试隔离口径，不是用户态产品缺陷；本票未改产品源码。
- **出口三失败覆盖**：只覆盖 registry 类（tarball 404）与超时；spawn-failed（CLI 入口缺失）没有真机注入路径。
- **pnpm 共享 store**：失败格必须让 tarball integrity 与本机缓存不同（注入标记内容），否则删 tarball 后 pnpm 命中缓存会假装成功；这一点写进了 raw 与 notes，评审可复核。
- **证据包范围**：只副本 `run.json/index.md/raw/shots`，隔离 home/fixtures/registry 等临时目录在 runtime，不入库；raw 里引用的绝对路径是采集机路径，复核以包内副本为准。
- **T10 UI 组**承担官方桌面窗口截图证据；本票只对出口二自带截图（d1 4 张、d2 3 张、can-red 4 张、f1 1 张）。

## 8. 复跑命令

工作树 `D:\dsh-plugin\_wt263\t3` 先 `npm ci` + `npm run build`；verdaccio/esbuild 用 runtime 工具目录（默认值见各 tool 的参数默认）。

```
# 出口二成功 / 失败 / can-red
node selftest/real-machine/tools/run-d-desktop-manager.ts --mode success --run-base-dir D:/dsh-plugin/_wt263/runtime/t3-267 --worktree D:/dsh-plugin/_wt263/t3 --verdaccio-install-dir D:/dsh-plugin/_wt263/runtime/tools/verdaccio --esbuild D:/dsh-plugin/_wt263/t3/node_modules/@esbuild/win32-x64/esbuild.exe
node selftest/real-machine/tools/run-d-desktop-manager.ts --mode failure  ...（同上）
node selftest/real-machine/tools/run-d-desktop-manager.ts --mode can-red ...（同上）

# 出口三成功 / 失败 / 超时 / can-red
node selftest/real-machine/tools/run-e-cli-host.ts --mode success ...（同上）
node selftest/real-machine/tools/run-e-cli-host.ts --mode failure ... / --mode timeout ... / --mode can-red ...

# 出口一探测 + known-red
node selftest/real-machine/tools/run-f-desktop-probe.ts --run-base-dir D:/dsh-plugin/_wt263/runtime/t3-267 --worktree D:/dsh-plugin/_wt263/t3 --verdaccio-install-dir D:/dsh-plugin/_wt263/runtime/tools/verdaccio --esbuild D:/dsh-plugin/_wt263/t3/node_modules/@esbuild/win32-x64/esbuild.exe
```

每条 run 结束打印 `{runDir, verdict, exitCode}`；证据包在 `<run-base-dir>/<runId>/`。真机一次只起一个官方桌面实例，run 前确认无残留桌面/verdaccio 进程。

## 9. 迭代记录（试错 run，不入证据包）

- `probe-20261102T083954`：通道 B 探针首次跑通宿主启动/电话，但安装落到维护者真实 home——根因是 `scrubbedParentEnv` 剥 `DSH_HOME`，脚手架按 `homedir()/.dsh` 解析；随后回滚被污染的维护者 profile，并把隔离口径改成 `USERPROFILE` 对齐（§7）。
- `267-20261102T094055`（d1 首跑）：`npm publish` 同版本 E409——`openT3Run` 已发布基版、`installBaseline` 又发一次，且带 publishOptions 的发布不缓存。修 `t3-common.ts` 加 `publishBaseline()` 单次缓存。
- `267-20261102T094809`（d2 首跑）：check 后下架触发产品候选门 `check-expired`（诚实拒绝，不是失败格想要的 exec 失败）→ 改「删 tarball、元数据不动」注入。
- `267-20261102T105106`（d2 次跑）：25-assert 把「可安装态本来就有 manual」误判成失败面；43-assert 用批量面板 effect 注入导致 `waitForFixtureLoaded` 等不到单面板版本条带（DOM 探针实测面板 class=`dsh-upd dsh-upd-batch`）。修：失败面以台账定局 + 面板 present 分支；注入效果改回 `legacySingleEffectOf`。
- `267-20261102T112620`（f1 首跑）：asar 虚拟路径普通 node 不可读（cli.js=false）+ 名字同族假阳性 25 个 → 改 ELECTRON_RUN_AS_NODE 探针与结构判据。
- `267-20261102T113558`（e can-red 首跑）：42-assert 台账期望没算 can-red 模式（期望 failed，实际 completed）→ 场景修期望，重跑 `267-20261102T113629` 后只剩 40-assert 预期红。
- 临时探针文件 `selftest/real-machine/tools/t3-probe1.ts`、`t3-dom-probe.ts` 收尾前删除；runtime 日志不入 git。

## 10. 门禁与提交

2026-11-02 串行执行（工作树 `D:\dsh-plugin\_wt263\t3`，与其他真机 run 不并行）：

| 门禁 | 结果 |
| --- | --- |
| `node selftest/fixtures/generator/fixture-package-plan.test.ts` | 通过（162 条断言；9 条场景声明与矩阵行一一对应） |
| `npx tsc -p selftest/tsconfig.json --noEmit` | 通过（exit 0） |
| `npx tsc -p selftest/tsconfig.tooling.json --noEmit` | 通过（exit 0） |
| `npm run build` | 通过（exit 0，dist + .d.ts 产出） |
| `npm run test:batch` | 通过（189 个 test / 49 suites，fail 0） |
| `npm run check` | 通过（exit 0；typecheck + build + 全量 tests + 双语门禁；本次未出现 E3b flake，故无重跑记录） |

- 提交（`impl/263-t3`，message 带 #267，只暂存本票路径）：`test(#267): 三出口真机矩阵场景与证据包`（夹具/场景/宿主驱动/工具/证据 runs + 矩阵行）/ `docs(#267): 三出口真机事实、known-red 与决策笔记`（host-install-exits 订正、known-red.md、runs/README、research 笔记）。
- 合并：`integration/spec-263` tip 先 merge 进 `impl/263-t3` 消分叉，再 `--no-ff` 合回 `integration/spec-263`；冲突停下报告。
