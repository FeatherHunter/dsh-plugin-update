# #284 A 组：known-red 转绿（F2 / F3 / G8 / I4）

日期：2026-11-03；分支 `impl/284-known-red-recovery`（工作树 `D:/dsh-plugin/_wt263/t12`，基线 37efcad）。
本组把 `selftest/evidence/known-red.md` 的四条登记（t3-267-exit-one、t4-268-no-cancel-probe、
t8-272-panel-pending-restart-branch、t8-272-i2-runtime-version-not-authoritative）在**本机可构造的等效宿主**上真机转绿。

## 硬约束与做法

维护者要求（m06149）：不得以「本机没有那种宿主 / 那种状态」当结论；允许在 web profile 里用 base 库真机测试，
用产品**文档化入口**构造等效宿主。据此：

- 场景文件 `selftest/real-machine/scenarios/known-red-recovery.ts` 用 `createMultiHostUpdate(deps, ...)` 的
  文档化 `deps.readerOverrides` 注入宿主能力；产品侧路由判定（`src/host/environment.ts:109-129`）、执行器
  （`src/core/executor.ts` `runService` / `runDesktopManager`）、电话、面板、日志全部走真实代码。
- 宿主能力由夹具模板 `selftest/fixtures/templates/integrator/integrator-host-half-template.ts` 的
  `equivalentHostOverridesOf()` 实现：F2/F3 给 `environmentKind:'desktop'` + `desktopProfiles` +
  `desktopPnpm.runPlugin`；G8 给 `environmentKind:'desktop-manager'` + `pluginManager`；I4 给
  `runningVersion`。模板的 `runPlugin` / `installBundle` **真 spawn 官方发行包 CLI**（`D:\DeepseekHarness`
  的 app.asar 内 `@deepseek-ai/dsh-desktop-host/lib/cli.js`）跑 pnpm，落真磁盘，不是假回包；
  raw `equivalent-host/*` 记录每次调用（argv/cwd/exitCode/stdout/stderr）。
- 每个 run.json 加 `equivalentHost{what,why,documentedEntry,realParts,simulatedParts,nonEquivalence}`
  （schemaVersion 仍为 1），notes 与 `raw/equivalent-host-boundary-<n>.json` 写边界，见
  `selftest/real-machine/scenarios/known-red-recovery.ts` 的 `equivalentHostFactsOf()`。

## 四场景与证据

| 场景 | runId（`selftest/evidence/runs/`） | 断言/截图 | 覆盖 |
| --- | --- | --- | --- |
| f2-exit-one-third-party-success | `284-20261103T185513`（pass/0） | 12 / 3 | 出口一成功格：作业 completed 1022ms、磁盘 0.0.2、exec `route=desktop-service ok=true exitCode=0`、无 fail；重启后 hostTag=host v0.0.2 |
| f3-exit-one-third-party-failure | `284-20261103T185533`（pass/0） | 33 / 2 | 出口一失败格：f3a tarball 404 → 真 CLI pnpm 404、failed/install-failed、detail 含 pnpm 原话、无载体命令、面板失败横幅、磁盘 0.0.1、恢复 200；f3b 无 terminate + installTimeoutMs=3000 → 6056ms 收尾、超时文案逐字、不谎称已终止 |
| g8-desktop-manager-no-cancel-timeout | `284-20261103T185608`（pass/0） | 19 / 3 | 出口二无 `cancelInstall`：3s deadline → 6057ms failed；后台 delay 8s 后真装成功、磁盘 0.0.2，但产品仍 failed、面板不谎称成功；exec `route=desktop-manager ok=false`、fail `reason=timeout` |
| i4-pending-restart-panel-truth | `284-20261103T185635`（pass/0） | 15 / 4 | 待重启真相：作业 restart-required、status running 0.0.1 / installed 0.0.2 / pending-restart；摘在册重启不加载（10s 无卡片、电话桥 405）；写回再重启加载变体（双 buildTag v0.0.2）；route=cli-process |
| can-red（预期 fail） | `284-20261103T185708`（fail/1） | 12 / 3 | stale-variant 注入：清单 0.0.2、内容 0.0.1 → 仅「重启后运行代码真换版」红（`33-assert`/`32-shot`） |

关键断言编号：F2 `04/13/14/22/23/27/28/32`；F3 f3a `22/24/25/26/27/28/30/32/35/37/38/39/40`、
f3b `42/48/49/50/51/52/53/55/58/60/61/62/63`；G8 `22/23/24/25/26/28/29/30/34/35/41/42`；
I4 `23/24/27/34/41/42/46/47`；can-red 红点 `33-assert`。

## 关键设计点

1. **HMR 会掩盖「待重启」**：DSH web 宿主内建 HMR，插件写盘后热重载新代码，首跑 I4 观测到 pending-restart
   窗口只有约 9ms。按 `@deepseek-ai/dsh-hmr` README 的**文档化 profile patch**（`cordis.patch.yml` 追加
   `- id: hmr` + `disabled: true`）在 I4 的三个宿主代全程关闭 HMR；这是测试隔离手段，不是产品开关。
   patch 写入处理空数组占位 `[]`（`applyHmrPatch()`，有单测）。
2. **运行版本权威性**：desktop-manager 等效宿主同时注入 `runningVersion`（= 该代宿主构建版本），否则产品会
   用磁盘 `installedVersion` 冒充运行版，把超时失败误判成「历史失败已结算」（`src/shared/failure-settled.ts:27-46`，
   首跑 G8 即被面板「已是最新」抓出，见 #272-i2 缺口）。注入后 G8 面板在后台真装成功后仍诚实报失败。
3. **f2 日志竞态**：电话回包早于 `update.install.exec` 落盘；F2 停宿主前用 `waitForPackageExec()` 轮询到 exec
   事件出现（raw `f2-exec-log-wait`），否则 route 断言会假红（首轮定稿 284-20261103T184726 实证）。
4. **端口释放证据**：`registerPort` 是在进程启动时测端口的，直接登记必然 `released=false`。改为进程真停后
   `recordPortRelease()` → `waitForPortFree(port,5000)` 再登记；五 run 的 cleanup.ports 全部 released=true。
5. **can-red 不拆断言**：`--mode can-red` 用 `stale-variant` 故障（publish 0.0.2 但构建内容 0.0.1），F2 其余
   断言仍全 pass，只让「重启后运行代码真换版」红，证明断言有牙。

## 门禁与边界

- 门禁（2026-11-03 19:00 串行跑，全 exit 0）：`npx tsc -p selftest/tsconfig.json --noEmit`；
  `npx tsc -p selftest/tsconfig.tooling.json --noEmit`；`node --test selftest/fixtures/generator/fixture-package-plan.test.ts`
  （612 条断言 pass）；`npm run build`；`node --test tests/known-red-recovery-scenario.test.mjs`（7/7 pass）；
  `npm run test:batch`（192 tests / 50 suites 全 pass）。
- 不覆盖：真实第三方 Desktop 发行包本身（发现/启动/升级/卸载）、官方桌面插件管理器的 `not-removable` /
  `bundle-in-use` / pendingBuilds 批准流程与「第二步失败」的真实宿主拓扑，仍按库内测试 + known-red 处理
  （`tests/desktop-manager*.test.mjs`、`tests/issue-194-pending-builds.test.mjs`、
  `tests/issue-236-manager-remove-failure-restore.test.mjs`）。
- 环境隔离：runtime `D:/dsh-plugin/_wt263/runtime/t12-284/<runId>`，DSH_HOME/USERPROFILE/pnpm store/registry
  storage/浏览器 user-data 全在仓库外；维护者真实 `~/.dsh` 前后指纹一致（run.json maintainerProfile）。
