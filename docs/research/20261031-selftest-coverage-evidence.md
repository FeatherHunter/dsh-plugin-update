# 自测覆盖率取证：A–J 十组 × 现有证据层

- 日期：2026-10-31（版本基线 `v0.18.39`，`HEAD` 工作树）
- 上游：wayfinder 地图 #256「更新系统自测插件包源码规划」→ 研究票 #260（把全量场景目录定为 A–J 十组）→ 本笔记服务的消费方是 #261「放行标准：什么算全量、测到哪几道门」
- 取证方式：只读 `src/`、`tests/`（169 个 `*.test.mjs`）、`scripts/`、`selftest/`、`package.json`、`event-list.update.json`、`docs/`；未跑 npm install / build / 全量测试 / 发版。所有命令见 §7。
- 要回答的三个问题：
  1. A–J 每组的行为点落在 `src/` 的哪些 `文件:行号`，现有自动化证据能证到哪一层（L0–L3），GAP 在哪；
  2. 更新系统的对外承诺面（11 个 exports 子路径、两类电话、错误码全集、UI 面、日志契约、核心不变量）分别落在 A–J 哪组——有没有落不进任何组的；
  3. 现有门禁命令各自能证什么、不能证什么。
- **一句话结论**：A–J 十组在仓库内都有自动化证据，但最强只到 L2（仅 J 组的 `scripts/log-smoke.mjs`），7 组停在 L1、2 组停在 L0、L3（真机 / 真 npm registry）全仓为零；且**承诺面严格大于 A–J**——`./client` 子路径零测试引用，面板 / 入口 / 安装按钮 / http 这层 UI 与传输面在 A–J 里没有归属组，日噪声预算与「事件目录完整性」都没有自动化。所以「全量」不能等价于「A–J 全绿」。

## 0. 口径与判定规则

| 层 | 定义 | 本仓的典型形态 |
| --- | --- | --- |
| L0 | 纯单测 / 契约（`node --test`，hermetic，不接宿主） | `tests/phones.test.mjs` 这类用假件直调 `dist/*.js` 公开入口 |
| L1 | 本地闭环（假宿主 / 临时目录 / 假 registry，真落盘） | `tests/batch-e2e.test.mjs`、`tests/queue.test.mjs`：真家目录 + 真 `node_modules` + 假抓取 |
| L2 | 真宿主或真 dist 端到端 | `scripts/log-smoke.mjs`：真 `dist/` + 临时 profile，但传输仍是 `fakeTransport` |
| L3 | 真机 / 真 npm registry（需人工或真实环境） | **本仓零条** |

判定规则（避免把「有测试」读成「证到了」）：

- **组层 = 该组任一行为点达到的最高层**，不是平均值，也不是文档自述；组内没有任何自动化证据才写 `GAP`。
- 只有能经 `npm run test` / `npm run test:batch` / `npm run smoke:log` 执行的证据才算「现有自动化」。`selftest/` 目前**不在任何 npm script 里**（`package.json:86-101`），也没有被 `tsconfig.json:15` 的 `include`（只有 `src/**/*.ts`）覆盖，所以它只能算「已写好的骨架」，不构成放行证据。
- 统计基线：`tests/` 下 **169** 个 `*.test.mjs`，另有 `tests/helpers/batch-log-harness.mjs` 与 `tests/helpers/hub-harness.mjs`。
- 原文引用一律 `文件:行号`；文档与实测冲突时，以源码 / 清单实测为准，并在 §3.8 记偏差。

## 1. 总表：A–J × 最强证据层

| 组 | 场景（#260 口径） | 关键 src 锚点 | 最强层 | 定层证据（谁把它抬到这一层） | 一句话 GAP |
| --- | --- | --- | --- | --- | --- |
| A | 单包主链 | `src/host/factory.ts:673-703`、`src/core/service.ts:636/647/1027`、`src/core/service.ts:822-867` | **L1** | `tests/issue-180-registered.test.mjs`（真临时 profile 造 `registered=false` 盘面） | 没有「查→装→verify→在册翻转」整链的 L2；log-smoke 不证安装结果 |
| B | 码面 | `src/shared/codes.ts:27-40`、`:44-50`、`:58-62`、`:75/78/85` | **L0** | `tests/bilingual-gate.test.mjs`（从 `dist/shared/codes.js` 读码）+ `tests/install-fail.test.mjs` | 码表覆盖 ≠ 每个码都有真实失败场景产出；cross-scope 只在批量假件里触发 |
| C | 三出口 | `src/core/executor.ts:1339-1343`（runner 表）、`:286`、`:1035`、`:1249`、`src/shared/commands.ts:205` | **L1** | `tests/issue-193-desktop-service-timeout.test.mjs`（真临时 profile + 假桌面服务） | 三条出口全假件；无真 pnpm 子进程、无真官方桌面管理器 |
| D | 超时取消 | `src/core/fetch.ts:27`、`src/shared/commands.ts:39`、`src/core/queue/ports.ts:42`、`src/host/http.ts:25-27`、`src/core/executor.ts:37` | **L1** | `tests/issue-193-desktop-service-timeout.test.mjs`（terminate / 宽限 / reject，真盘） | 无真时钟到点（15min 装 / 16min http 真等）；无真子进程被 SIGTERM |
| E | 批量（必须 3 包） | `src/host/batch/fan-out.ts:1303-1311`（七电话名）、`:1333-1340`（handlers）、`:1097` | **L1** | `tests/batch-e2e.test.mjs:246`（pkg-a / pkg-b / pkg-c 三包真目录） | e2e 的 registry 与执行器都是假件：无三包真下载、无真网失败矩阵 |
| F | 队列锁（必须 2 包） | `src/core/queue/ports.ts:42`、`:329`、`src/core/store-base.ts:256`、`src/core/queue/model.ts:12/192/252` | **L1** | `tests/queue.test.mjs:48-56`（真临时目录，pluginId a/b 两包） | 无跨进程真并发抢锁；锁过期靠极小阈值 / 假时钟 |
| G | 中枢（必须 2 包） | `src/host/hub/protocol.ts:19`、`src/core/hub/lease-policy.ts:16/19`、`src/host/hub/registry.ts:272/379`、`src/host/hub/adopt.ts:27` | **L1** | `tests/hub-process.test.mjs:39`（`targets [self,a]`，真盘 + 假时钟） | 无真双进程中枢；协议换代靠同进程 `globalThis` Symbol 槽模拟 |
| H | 在册沉降 | `src/core/service.ts:837-846`、`:305`、`:856-867`、`src/core/reader.ts:433-434`、`src/shared/failure-settled.ts:27` | **L1** | `tests/issue-180-registered.test.mjs`（真盘 `registered` 面） | 没有「真宿主重启后 registered 由 false 变 true」的真进程用例 |
| I | 拓扑补偿（真机） | `src/core/executor.ts:669/693`、`:42`（5s 探测）、`:726`（移除失败补偿）、`:1156-1193`（两步配方） | **L0** | `tests/issue-201-manager-recovery.test.mjs`、`tests/issue-236-manager-remove-failure-restore.test.mjs`（全假管理器） | 真机零覆盖；selftest 骨架也不含拓扑场景 |
| J | 日志面板 | `src/log/manifest.ts:44/72`、`src/log/emit.ts:339`、`src/log/client-queue.ts:105-112`、`src/log/health.ts:161` | **L2** | `scripts/log-smoke.mjs:363-370`（六场景真 `dist/`） | 日噪声预算 50/500 零断言；`docs:log:check` 缺行只警告不失败 |

分布：L2 一组（J）、L1 七组（A C D E F G H）、L0 两组（B I）、L3 零组。

## 2. 逐组明细

### A 单包主链

| 行为点 | src | 现有证据 | 层 |
| --- | --- | --- | --- |
| 电话名派生与注册 | `src/shared/config.ts:165-175`、`src/host/factory.ts:673-703` | `tests/phones.test.mjs`（入参 / 回参 / 单例隔离）、`tests/diag-phone.test.mjs` | L0 |
| status 真值元组、运行版未知不判待重启 | `src/core/service.ts:636`、`src/core/reader.ts:433-434` | `tests/issue-211-check-truth.test.mjs`、`tests/issue-182-unknown-running-version.test.mjs` | L0 |
| check + 渠道判定 + 10s 取数时限 | `src/core/service.ts:647`、`src/core/fetch.ts:27` | `tests/issue-156-check.test.mjs`、`tests/issue-183-prerelease-latest.test.mjs` | L0 |
| install → 装后校验 → `update.install.verify` | `src/core/service.ts:1027`、`src/core/service.ts:822-867`（`:825` version-mismatch、`:863` 发事件） | `tests/issue-190-verify-state.test.mjs`、`tests/issue-202-noop-install.test.mjs` | L0 |
| changelog 读盘 / 取 release / 解析 | `src/core/changelog/io.ts:87`、`:325`、`src/core/changelog/parse.ts:538` | `tests/changelog.test.mjs`、`changelog-41`、`changelog-auto`、`changelog-fidelity-116`、`changelog-md-render`、`changelog-status`、`changelog-zh-honest` | L0 |
| fallback 降级决议 | `src/core/service.ts:750` | `tests/issue-156-fallback.test.mjs`、`issue-156-fallback-identity`、`issue-156-fallback-slot-survival` | L0 |
| 失败结算判据 | `src/shared/failure-settled.ts:27`（判据 `:11-17`） | `tests/issue-245-failed-ledger-settled.test.mjs` | L0 |
| 真盘单包：新装未登记 / 装前未登记 | `src/core/service.ts:837-846` | `tests/issue-180-registered.test.mjs`（真临时 profile） | L1 |

GAP：没有一条用例在「真 dist + 真 profile」上跑完整链（查 → 装 → verify → registered 翻转）；`scripts/log-smoke.mjs` 只证日志行，不证安装结果。A 组的 L2 需要「真宿主 + 真 dist + 假 registry」的新用例，或真 registry（L3）。

### B 码面

| 行为点 | src | 现有证据 | 层 |
| --- | --- | --- | --- |
| 阻挡码 11 个 | `src/shared/codes.ts:27-40` | `tests/issue-98-channel-mismatch.test.mjs`、`tests/issue-153-dev-source.test.mjs`、`tests/issue-245-failed-ledger-settled.test.mjs` | L0 |
| 电话失败码 5 个 | `src/shared/codes.ts:44-50` | `tests/install-fail.test.mjs`、`tests/issue-100-adversarial.test.mjs`、`tests/routes.test.mjs` | L0 |
| 检查侧失败码 3 个 | `src/shared/codes.ts:58-62` | `tests/issue-150-check-expired.test.mjs`、`tests/issue-151-expiry-refetch.test.mjs` | L0 |
| `internal` / `unsupported` / `cross-scope` | `src/shared/codes.ts:66/69/72` | `tests/last-resort.test.mjs`；cross-scope 见 `tests/batch-host.test.mjs` | L0 |
| 派生集合 STABLE 17 / CORE 16 / BATCH_REPLY 17 | `src/shared/codes.ts:75/78/85` | `tests/bilingual-gate.test.mjs`（从 `dist/shared/codes.js` 读码，不另抄码表）、`tests/gate.test.mjs` | L0 |

GAP：码表有单测 ≠ 每个码都有「真实场景产出」的用例——B 组证的是「码表自洽 + 每个码有文案」，不是「每个码都会在正确的失败现场被发出」。cross-scope 只在批量假件里触发（语义见 `src/host/batch/fan-out.ts:100-101`），没有真宿主跨越范围的证据。

### C 三出口

| 行为点 | src | 现有证据 | 层 |
| --- | --- | --- | --- |
| runner 三路由表 | `src/core/executor.ts:1339-1343`（desktop-service / desktop-manager / cli-process） | `tests/routes.test.mjs`、`tests/issue-100-adversarial.test.mjs` | L0 |
| desktop-service（终止 + 3s 宽限） | `src/core/executor.ts:286-352` | `tests/issue-193-desktop-service-timeout.test.mjs`（真临时 profile + 假桌面服务） | L1 |
| desktop-manager（官方管理器两步配方） | `src/core/executor.ts:1035`、`:1154-1193` | `tests/desktop-manager.test.mjs`、`tests/desktop-manager-hmr.test.mjs`（黑箱从 `dist/core/executor.js` 的 `createUpdateExecutor` 进） | L0 |
| cli-process（spawn + 宽限） | `src/core/executor.ts:1249-1312` | `tests/issue-185-cli-timeout.test.mjs`、`tests/issue-237-cli-entry-desktop-runtime.test.mjs`（入口解析） | L0 |
| 安装配方（manager 只收 add+精确 spec；其他带 `--save-exact` 与 `--registry`） | `src/shared/commands.ts:205` | `tests/routes.test.mjs`、`tests/issue-100-adversarial.test.mjs` | L0 |

GAP：三条出口都只有假件；没有真 `pnpm` 子进程、没有真官方桌面管理器。`issue-193` 是「真盘 + 假服务」，只能到 L1；出口三的真机/真 pnpm 是 C 组唯一的 L3 缺口。

### D 超时取消

| 行为点 | src | 现有证据 | 层 |
| --- | --- | --- | --- |
| 检查 10s | `src/core/fetch.ts:27`、`src/shared/config.ts:44` | `tests/http.test.mjs`（把时限调极小驱动）；core 的 10s 常量无独立到点用例 | L0 |
| 安装 15min，且锁陈旧阈值同源 | `src/shared/commands.ts:39`、`src/core/queue/ports.ts:42` | `tests/host-lock-window.test.mjs`、`tests/issue-181-lock-ttl.test.mjs` | L0 |
| HTTP 15s / 16min / 15s | `src/host/http.ts:25-27` | `tests/http.test.mjs`（把时限调极小，短延时驱动） | L0 |
| 无取消能力时的诚实文案 | `src/core/executor.ts:1113` | `tests/issue-184-timeout-honesty.test.mjs` | L0 |
| 到点终止 + 3s 宽限 / 取消能力探测 | `src/core/executor.ts:37`、`:1042`、`:1086-1087` | `tests/issue-185-cli-timeout.test.mjs`（cli 三态）、`tests/issue-193-desktop-service-timeout.test.mjs` | L1 |
| 批量取消 | `src/host/batch/fan-out.ts:1158` | `tests/issue-85-contract.test.mjs`、`tests/batch-host.test.mjs` | L0 |

GAP：没有真时钟到点用例（15 分钟装、16 分钟 http 真等）；`issue-193` 真盘但服务假、阈值被缩小，所以 D 组只能到 L1。「真到点杀真子进程」属于 L2/L3，需真机或真实 pnpm。

### E 批量（必须 3 包）

| 行为点 | src | 现有证据 | 层 |
| --- | --- | --- | --- |
| 七电话名 + handlers | `src/host/batch/fan-out.ts:1303-1311`、`:1333-1340` | `tests/batch-host.test.mjs`、`tests/batch.test.mjs` | L0 |
| 串行驱动、失败即停、续跑 | `src/host/batch/fan-out.ts:1104`（`driveLocked`） | `tests/batch-run.test.mjs`、`tests/batch-host.test.mjs`、`tests/issue-85-contract.test.mjs` | L0 |
| 三包真落盘 e2e | `src/host/batch/fan-out.ts:1097` | `tests/batch-e2e.test.mjs:246`（`pkg-a` / `pkg-b` / `pkg-c`） | L1 |
| 账本 / sessionHash 串联 | `src/host/batch/fan-out.ts:1097` | `tests/batch-session.test.mjs`、`tests/batch-log.test.mjs:57`（三目标 a/b/self） | L0 |
| 自更新排第一、跨范围拒、requestId 复用 | `src/host/batch/fan-out.ts:100-101` | `tests/issue-219-self-order-first.test.mjs`、`tests/issue-218-batch-request-id-reuse.test.mjs` | L0 |
| 批量面板 / 入口 UI | `src/panel/batch/mount.ts:243`、`src/panel/batch/entry-batch.ts:354` | `tests/panel-batch.test.mjs`、`tests/entry-batch.test.mjs` | L0 |

GAP：e2e 的 registry 与执行器都是假件（真 `queue.json` / `global.lock` 落盘、假网），所以「3 包」的包数门槛证到了，但「3 包真下载 / 真网络部分失败」没证。三包中「1 成 2 败 / 2 成 1 败」的真矩阵缺。

### F 队列锁（必须 2 包）

| 行为点 | src | 现有证据 | 层 |
| --- | --- | --- | --- |
| 锁文件 + TTL（= 安装时限单源） | `src/core/queue/ports.ts:42`、`:329`、`src/core/store-base.ts:256` | `tests/queue.test.mjs:48-56`（真临时目录，pluginId a/b）、`tests/host-lock-window.test.mjs` | L1 |
| 公平先进先出 / 队首判定 / 提升 | `src/core/queue/model.ts:12`、`:192`、`:252` | `tests/queue.test.mjs` | L0 |
| 锁 TTL 双向失灵、僵尸等待位、整写 EPERM | `src/core/queue/ports.ts:42` | `tests/issue-181-lock-ttl.test.mjs`、`tests/issue-217-queue-intent-deadlock.test.mjs`、`tests/issue-239-queue-transient-write.test.mjs` | L1 |
| 排队行文案与批量排队行归属 | `src/core/queue/model.ts:252` | `tests/issue-232-batch-queue-copy.test.mjs`、`scripts/log-smoke.mjs` s6 | L2（仅日志行） |

GAP：没有跨进程真并发（两个进程同时 `install` 抢同一把锁）；锁过期靠极小阈值 / 假时钟，20 分钟级判据没在真时钟下跑过。

### G 中枢（必须 2 包）

| 行为点 | src | 现有证据 | 层 |
| --- | --- | --- | --- |
| 协议版本 v2 + 轮询 1s + 失联判据 | `src/host/hub/protocol.ts:19/22/29` | `tests/issue-254-protocol-handoff.test.mjs` | L1 |
| 租约心跳 5s / 失联 20s | `src/core/hub/lease-policy.ts:16/19` | `tests/hub-lease-policy.test.mjs`（四判决纯函数） | L0 |
| 提交、旧代观察、让位、关闭 | `src/host/hub/registry.ts:272`、`:379`、`:686-712` | `tests/hub-process.test.mjs:39`（两实例 `targets [self,a]`） | L1 |
| 只读全局进度电话 | `src/host/hub/aggregate.ts:57/134`、`src/host/factory.ts:662-672` | `tests/hub-status.test.mjs` | L1 |
| 方案落盘 / 坏文件边界 | `src/host/hub/plan-store.ts:36-70`、`src/host/hub/boundary.ts:47-93` | `tests/hub-snapshot.test.mjs`、`tests/hub-process.test.mjs` | L1 |
| 孤儿接管 | `src/host/hub/adopt.ts:27`、`src/host/batch/fan-out.ts:1372` | `tests/hub-takeover.test.mjs`（`__resetHubRegistryForTests` 模拟重启） | L1 |
| 后台泵异常边界 | `src/host/hub/registry.ts:712` | `tests/issue-253-hub-exception-boundary.test.mjs` | L1 |

GAP：没有真双进程中枢（同一 `globalThis` 内两实例 ≠ 两个宿主进程）；协议换代（v1 → v2 并排空旧任务）靠同进程 Symbol 槽模拟（`src/host/hub/handoff.ts:12/17`），真宿主换代未证；5s / 20s 租约判据没在真时钟下跑过。

### H 在册沉降

| 行为点 | src | 现有证据 | 层 |
| --- | --- | --- | --- |
| 装后未登记 → `not-registered` / `version-mismatch` / `env-blocked` | `src/core/service.ts:825/837/838/846` | `tests/issue-180-registered.test.mjs`、`tests/issue-190-verify-state.test.mjs` | L1 |
| 装后状态投影（完成 / 待重启 / 失败 / 中断） | `src/core/service.ts:305`、`:856-867` | `tests/issue-190-verify-state.test.mjs` | L0 |
| 失败已结算（failed + 目标已达 + 在册 → 不再当失败） | `src/shared/failure-settled.ts:27` | `tests/issue-245-failed-ledger-settled.test.mjs` | L0 |
| 首帧不冒充当前失败、缺席不被旧失败判 recovery | `src/core/reader.ts:433-434` | `tests/issue-238-first-install-stale-failure.test.mjs`、`tests/issue-215-absent-stale-job.test.mjs` | L0 |
| 未安装一等状态、dev-source、channel-mismatch | `src/core/service.ts:837-846` | `tests/issue-134-not-installed.test.mjs`、`tests/issue-153-dev-source.test.mjs`、`tests/issue-98-channel-mismatch.test.mjs` | L0 |
| 失败态轮询不 churn、重启后待重启回查清零、检查按磁盘真相纠正 | `src/core/reader.ts:433-434` | `tests/issue-143-failed-poll-stable.test.mjs`、`tests/issue-91-restart-recheck.test.mjs`、`tests/issue-244-restart-row-reconcile.test.mjs` | L0 |

GAP：在册（`registered`）是**宿主**写的盘面，现有用例全靠「造 profile 文件」模拟；没有真宿主重启 / 真注册表落盘的进程级证据。H 组的 L2 需要真宿主跑一次装 + 重启。

### I 拓扑补偿（真机）

| 行为点 | src | 现有证据 | 层 |
| --- | --- | --- | --- |
| 管理器拓扑探测（listBundles 两格） | `src/core/executor.ts:648-666`、`:669` | `tests/issue-201-manager-recovery.test.mjs`（假管理器） | L0 |
| 带时限探测（5s） | `src/core/executor.ts:42`、`:693` | `tests/issue-201-manager-recovery.test.mjs` | L0 |
| 未选中 → `setBundleEnabled` → remove → install | `src/core/executor.ts:1156-1193` | `tests/issue-201-manager-recovery.test.mjs`、`tests/desktop-manager.test.mjs` | L0 |
| 移除失败后在册补偿（三档结论） | `src/core/executor.ts:726`、`:732`、`:759-766` | `tests/issue-236-manager-remove-failure-restore.test.mjs` | L0 |
| recovery-required 恢复死锁 | `src/core/service.ts:846` | `tests/issue-241-recovery-deadlock.test.mjs`（真临时目录） | L1（仅状态文件） |
| CLI 入口解析（桌面运行时） | `src/core/executor.ts:1249` | `tests/issue-237-cli-entry-desktop-runtime.test.mjs` | L0 |

GAP：**这是 A–J 里唯一被 #260 明确标「真机」的组，而它恰恰零真机覆盖**——所有拓扑用例都用假管理器记录调用序列。`issue-236` 证的是「代码按配方调用了」，不是「真管理器真的先禁用再移除」。真机上的 `listBundles` / `setBundleEnabled` 契约、20s 观察窗口、管理器崩溃恢复，全部未证实。

### J 日志面板

| 行为点 | src | 现有证据 | 层 |
| --- | --- | --- | --- |
| 29 事件清单 / 字段枚举 / 唯一发射口 | `src/log/manifest.ts:44/72`、`src/log/emit.ts:99/133/150/339` | `tests/log-contract.test.mjs`（#210 字段枚举）、`tests/log-kernel.test.mjs`（#121 唯一发射口 + 真装 dsh-log 0.3.4 落文件）、`tests/log-health.test.mjs` | L1 |
| traceId / seq | `src/log/emit.ts:339` | `tests/log-trace.test.mjs` | L0 |
| 客户端白名单 6 事件与投递协议 | `src/log/client-queue.ts:105-112` | `tests/client-log.test.mjs`（环形缓冲 / 批量投递 / `logAppend` 协议面） | L0 |
| 面板 / 批量 / 宿主 / 存储日志 | `src/log/health.ts:161` | `tests/panel-log.test.mjs`、`tests/panel-batch-log.test.mjs`、`tests/host-log.test.mjs`、`tests/store-log.test.mjs`、`tests/panel-render-fail.test.mjs` | L0 |
| 轮询失败心跳 ≤12 行/小时 | `event-list.update.json` 的 `host.call.fail` guard | `tests/host-log.test.mjs:268`（600 次轮询）、`:288`、`:357` | L0 |
| 六场景真 dist 端到端 | `src/host/batch/fan-out.ts:1303-1311` 等 | `scripts/log-smoke.mjs:363-370`（s1 一批三家、s2 prefs 去重、s3 属主转发、s4 无属主、s5 预查抛错、s6 排队行归属） | L2 |
| 面板渲染失败边沿 | `src/panel/mount.ts:148` | `tests/panel-render-fail.test.mjs`（60s 边沿去重） | L0 |

GAP：日噪声预算（稳态 ≤50 行/天/插件、操作日 ≤500 行，`CONTEXT.md:85-86`）**零断言**——自动化只钉了「≤12 行/小时」；`docs:log:check` 只校验目录已有 23 行，29 个事件里 6 个在目录中无行且只警告不失败（见 §3.6）。

## 3. 承诺面盘点（独立于现有测试的义务来源）

### 3.1 11 个 exports 子路径

真源 `package.json:30-72`（第 11 项 `./package.json` 在 `:71`）。下表「测试引用文件数」= 在 `tests/` 里正则扫到 import 对应 `dist/` 产物的文件数（同一文件计一次）。

| 子路径 | 产物 | 测试引用文件数 | 落 A–J | 备注 |
| --- | --- | --- | --- | --- |
| `.` | `dist/index.js` | 59 | A | 宿主半入口，覆盖最厚 |
| `./panel` | `dist/panel.js` | 66 | **落不进**（UI 面） | 面板 DOM 测试很多，但 A–J 没有「面板」组 |
| `./client` | `dist/client.js` | **0** | **落不进任何组** | 冻结壳（`src/client.ts:1-4`：实现已搬进 `panel/client.ts`，逐名转出）；全仓 35 处提及、`tests/` 里 0 处，其余在 docs、README、`prototype/` 草稿、`package.json` 与 `derive-client-values.mjs:89` |
| `./batch` | `dist/batch.js` | 19 | E | |
| `./panel-batch` | `dist/panel-batch.js` | 35 | E / UI | |
| `./entry` | `dist/entry.js` | 13 | A / UI | |
| `./entry-batch` | `dist/entry-batch.js` | 7 | E | |
| `./install-button` | `dist/install-button.js` | 8 | A / UI | |
| `./http` | `dist/http.js` | 2 | **落不进**（传输面） | 三出口是 desktop-service / manager / cli，http 是第四条传输面 |
| `./log` | `dist/log.js` | 8 | J | |
| `./package.json` | 清单本身 | 1 | **落不进**（打包面） | 唯一断言：`tests/entry.test.mjs:574` 查 `manifest.exports['./entry']` 存在 |

结论：11 项里只有 6 项（`.` / `batch` / `panel-batch` / `entry` / `entry-batch` / `log`）能明确落进 A–J；`./client` 零引用、`./http` 与 `./package.json` 无归属组、`./panel` 与 `./install-button` 只有「UI 面」这个没有场景组的名分。

### 3.2 单包 handlers 电话（7 通，不是 6 通）

真源 `src/host/factory.ts:673-703`，返回 `{ phoneNames, handlers, hubStatus }`（`:704`）。名字派生只覆盖 6 个（`src/shared/config.ts:165-175`），第 7 个 hubStatus 名字单独拼（`src/host/factory.ts:662`：`config.prefix + '.updateHubStatus'`）。

| # | 电话（前缀 +） | 注册处 | 落组 |
| --- | --- | --- | --- |
| 1 | `.updateStatus` | `src/host/factory.ts:674` | A |
| 2 | `.updateCheck` | `:683` | A |
| 3 | `.updateInstall` | `:687` | A |
| 4 | `.updateCheckFallback` | `:691` | A / B |
| 5 | `.updateChangelog` | `:695` | A |
| 6 | `.logAppend` | `:699` | J |
| 7 | `.updateHubStatus` | `:662`、`:702` | G |

偏差：`docs/agents/architecture.md:143` 写「handlers 表（6 通：3 主 + changelog + fallback + logAppend）」——实测 7 通，漏了 hubStatus（#250 加的，只读、无条件登记）。承诺面计数必须以 `factory.ts` 为准。

### 3.3 批量电话（7 通 + hubStatus + 属主 logAppend 转发）

真源 `src/host/batch/fan-out.ts`。批量宿主的 handler 面是**动态合成**的，不是固定 7 通：

| 层 | 内容 | 出处 |
| --- | --- | --- |
| 固定 7 通 | `batchStatus` / `batchCheck` / `batchInstall` / `batchResume` / `batchCancel` / `batchPrefs` / `batchPrefsSave` | `:1303-1311`（名）、`:1333-1340`（handlers） |
| 条件 1：hubStatus | 仅当有 `hubScope` 时登记，名 `prefix + '.updateHubStatus'` | `:1343-1347` |
| 条件 2：目标单插件全表 | 把每个目标的单插件 handlers 全表并入（所以批量宿主还会暴露 N 个 `.updateStatus` 等） | `:1349-1354` |
| 条件 3：属主 logAppend 转发 | 有 `selfRuntime` 时登记 `<批量前缀>.logAppend`，转发给属主 | `:1358-1366` |

落组：E（七通与串行）、G（hubStatus）、J（logAppend 转发）。偏差：`docs/agents/architecture.md:151` 写批量 handlers 在 `src/host/batch/fan-out.ts:1087–1094`——行号已漂移，实测 `:1333-1340`。

### 3.4 错误码全集

真源 `src/shared/codes.ts`（92 行）。

| 集合 | 数量 | 出处 | 落组 |
| --- | --- | --- | --- |
| 阻挡码 `BLOCKED_REASONS` | **11** | `:27-40` | B / H |
| 电话失败码 `PHONE_FAILURE_CODES` | **5** | `:44-50` | B |
| 检查侧失败码 `CHECK_SIDE_FAILURE_CODES` | **3** | `:58-62` | B |
| 单值码 `internal` / `unsupported` / `cross-scope` | 1 + 1 + 1 | `:66` / `:69` / `:72` | B（cross-scope 实为批量语义 → E） |
| `STABLE_CODES` 派生 | **17** = 11 + 5 + 1 | `:75` | B / J |
| `CORE_ERROR_CODES` 派生 | **16** = 5 + 11 | `:78` | B |
| `BATCH_REPLY_CODES` 派生 | **17** = 16 + 1 | `:85` | B / E |

判定函数：`isCoreErrorCode`（`:94`）、`isBatchReplyCode`（`:99`）、`isCheckSideFailureCode`（`:104`）。落组异常：`cross-scope` 是批量专有语义，却和单包码住在同一张表里——B 组（码面）与 E 组（批量）共享一个真源，规划分工时要避免两边都假设对方覆盖。

### 3.5 UI 面

| 面 | 挂载点 | 有测试 | 落组 |
| --- | --- | --- | --- |
| 面板 | `src/panel/mount.ts:148` `mountUpdatePanel` | 是 | **无组**（UI 面） |
| 入口 | `src/panel/entry.ts:368` `mountUpdateEntry` | 是 | **无组** / A 旁支 |
| 批量面板 | `src/panel/batch/mount.ts:243` `mountUpdateBatchPanel` | 是 | E / UI |
| 批量入口 | `src/panel/batch/entry-batch.ts:354` `mountUpdateBatchEntry` | 是 | E / UI |
| 安装按钮 | `src/core/install-button/mount.ts:90` `mountInstallButton` | 是 | A / UI |
| HTTP 传输 | `src/host/http.ts:231/346/379/411` | 是（2 文件） | **无组**（传输面） |
| 中枢进度坞 | `src/panel/batch/dock.ts:531` `mountHubProgressDock` | 是（`tests/panel-dock.test.mjs:16`） | G / UI |

异常：`mountHubProgressDock` **不在 11 个 exports 里**（`package.json:30-72`），却是有测试的 UI 面——「有测试的未承诺面」。反过来，`./panel` 与 `./install-button` 是承诺面却在 A–J 里没有场景组。这两条都说明：A–J 是**功能场景**目录，不是**承诺面**目录，两者只能相交、不能互相替代。

### 3.6 日志契约

| 项 | 文档口径 | 实测 | 证据 |
| --- | --- | --- | --- |
| 随包清单事件数 | `docs/agents/architecture.md:109` 写「27 事件」 | **29** | `event-list.update.json`：resident 22 / ondemand 6 / selfmon 1；顶层 `fieldEnums` 16 组 |
| 事件目录行数 | `docs/research/20261014-log-event-catalog.md` §1 常驻 16 行（`:24-39`）+ §2 按需 7 行（`:45-51`）= 23 行 | 23 行，且缺 6 个事件 | `node scripts/gen-log-catalog.mjs --check` 输出「OK：2 张事件表、23 行前三列一致」+ 6 条缺行警告：`host.call`、`host.call.fail`、`update.install.exec`、`update.install.fail`、`update.batch.run.start`、`update.install.retry` |
| 目录来源 | 生成产物 | 只校验已有行前三列，缺行只 warn 不 fail | `scripts/gen-log-catalog.mjs:252-256`、`:312-323` |
| 客户端白名单 | — | **6**：`update.panel.mount` / `.action` / `.render.fail` / `.state`、`update.lang.applied`、`update.log.degraded` | `src/log/client-queue.ts:105-112` |
| 噪声预算 | `CONTEXT.md:85-86`：稳态 ≤50 行/天/插件、操作日 ≤500 行；轮询失败心跳 5 分钟、≤12 行/小时 | 只有 12 行/小时被断言 | `tests/host-log.test.mjs:268/288/357` |
| 边沿纪律 | 两条边沿事件（`update.status.changed` / `update.queue.transition`）在发射侧做指纹去重 | 与清单 guard 一致 | `src/log/emit.ts:133`（`fieldFingerprint`）、`src/log/manifest.ts:44` |

### 3.7 核心不变量（按 `CONTEXT.md` 与 src 核）

| 不变量 | 真源 | 现有证据 | 落组 |
| --- | --- | --- | --- |
| 在册 `registered` 是事实（false 是事实，读不到 `null`） | `src/core/service.ts:837-846`、`src/core/reader.ts:433-434` | `tests/issue-180`、`issue-190` | H |
| 装后校验三档（version-mismatch / not-registered / env-blocked） | `src/core/service.ts:825/838/846` | `tests/issue-180`、`issue-190` | A / H |
| 失败已结算（判据唯一位） | `src/shared/failure-settled.ts:27` | `tests/issue-245` | H |
| 队列公平先进先出 | `src/core/queue/model.ts:12/192/252` | `tests/queue.test.mjs` | F |
| 锁 TTL = 安装时限（单源） | `src/core/queue/ports.ts:42`、`src/core/store-base.ts:256` | `tests/host-lock-window`、`issue-181` | D / F |
| 中枢 = 进程级推进者（`hub:false` 回旧路径） | `src/host/batch/fan-out.ts:1097`、`src/host/hub/registry.ts:686-712` | `tests/hub-process` | G |
| 租约 5s 心跳 / 20s 失联 / 接管代次 +1 | `src/core/hub/lease-policy.ts:16/19` | `tests/hub-lease-policy` | G |
| 协议换代 = 带版本 Symbol 槽 | `src/host/hub/handoff.ts:12/17`、`src/host/hub/protocol.ts:19` | `tests/issue-254-protocol-handoff` | G |
| 孤儿接管 | `src/host/hub/adopt.ts:27`、`src/host/batch/fan-out.ts:1372` | `tests/hub-takeover` | G |
| 批量账本 / sessionHash 串联 | `src/host/batch/fan-out.ts:1097` | `tests/batch-session`、`batch-e2e` | E |
| 装后 `registered===false` 时的失败归因 | `src/core/service.ts:837-838` | `tests/issue-180` | H |

### 3.8 落组异常汇总（承诺面 ⊄ A–J）

| # | 异常 | 证据 | 影响 |
| --- | --- | --- | --- |
| 1 | `./client` 子路径零测试引用 | `package.json:41` 声明；`src/client.ts:1-4` 冻结壳；tests 里 `dist/client.js` 0 引用 | 11 项承诺里有 1 项**没有任何自动化冒烟** |
| 2 | `./package.json` 只被数成「10 个 exports」 | `CONTEXT.md:108`、`docs/adr/0007-src-directory-shape.md:11` 与 `:21` 写 10；`package.json:71` 是第 11 项 | 文档计数过时；打包面只有 `tests/entry.test.mjs:574` 一条断言 |
| 3 | UI 面在 A–J 无归属组 | `./panel` 66 个测试文件、`./install-button` 8 个；A–J 十组无「面板」组 | 按 A–J 全绿放行会漏 UI 面 |
| 4 | `/http` 与三出口不是同一维度 | `src/host/http.ts:231/346/379/411`；三出口在 `src/core/executor.ts:1339-1343` | 「三出口」≠ 全部传输面 |
| 5 | 未承诺却有测试：`mountHubProgressDock` | `src/panel/batch/dock.ts:531`、`tests/panel-dock.test.mjs:16` | 承诺面清单需补一项或明确它为内部件 |
| 6 | 架构文档 handlers 6 通 | `docs/agents/architecture.md:143` vs `src/host/factory.ts:673-703`（7 通） | 规划若按 6 通验收会漏 hubStatus |
| 7 | 架构文档批量 handlers 行号漂移 | `docs/agents/architecture.md:151`（`:1087–1094`）vs 实测 `:1333-1340` | 定位失效 |
| 8 | 架构文档 27 事件 | `docs/agents/architecture.md:109` vs `event-list.update.json`（29） | 日志验收按 27 会漏 2 个事件 |

## 4. 门禁命令对照

| 命令 | 实际做什么 | 能证 | 不能证 |
| --- | --- | --- | --- |
| `npm run typecheck` | `tsc -p tsconfig.json`；`include` 只有 `src/**/*.ts`（`tsconfig.json:15`） | `src/` 类型自洽 | 任何行为；`selftest/` 不在范围（它有自己的 `selftest/tsconfig.json`）；不构建 `dist/` |
| `npm run test` | `pretest` 先 `build`（`build.mjs:1-9`：esbuild 一对一 + `tsc --noEmit`），再 `node --test tests/*.test.mjs`（169 文件） | 全部 L0/L1：A–H 的单元与本地闭环、B 的码面、J 的日志契约 | L2（`smoke:log` 不在 test 链里）、L3、`selftest/` |
| `npm run test:batch` | `node --test` 只跑 `batch-*` / `panel-batch*` / `entry-batch*` | E 的账本/串行/宿主/UI、F/G 的批量接线（部分） | A/H/I/J 的其余面；不覆盖单包主链 |
| `npm run check` | `typecheck + build + 全量 test + gate:bilingual`（`package.json:86-101`） | 上述 L0/L1 全量 + 码面文案/字典 | L2/L3；不跑 `smoke:log`、不跑 `probe:layout`、不跑 `selftest/` |
| `npm run smoke:log` | `build` 后 `node scripts/log-smoke.mjs`（真 `dist/` + `tests/helpers/batch-log-harness.mjs` + 临时目录） | J 的六场景：批量三事件同 sessionHash、prefs 去重、属主 logAppend 转发、无属主边界、预查抛错、排队行归属 | 真安装（传输全 `fakeTransport`）；真宿主 / 真 dsh-log 外部实例；日噪声预算 |
| `npm run docs:log:check` | `node scripts/gen-log-catalog.mjs --check` | 目录已有 23 行前三列与清单/源码一致 | **目录完整性**：29 事件里 6 个无行，缺行只 warn 不失败（`:252-256`、`:312-323`） |
| `npm run gate:bilingual` | 四道检查（散落中文基线只许减、字典快照、错误码分支 + 诊断解析、`--release` 零 draft），退出码 0/1/2 | 文案/字典/码面文案不漂；`--release` 发布说明完整 | 任何运行期行为；它读 `dist/shared/codes.js` 但只对码表做契约，不对场景做断言 |
| `npm run probe:layout` | `node scripts/panel-layout-probe.mjs`：`dist/panel.js` 真渲染 + 系统 Chrome headless 量盒子，只断言关系 | 面板布局关系（本机有 Chrome 时） | 功能；**找不到 Chrome 直接跳过、退出码 0**（`scripts/panel-layout-probe.mjs:19`），是可选仪器，不是发布门禁，也不在 `check` 里 |
| （未接线）`selftest/` | 仅 `npx tsc -p selftest/tsconfig.json --noEmit`（`selftest/README.md:48`） | 骨架类型自洽 | 一切运行期结论；不在任何 npm script、不在 `tsconfig.json` 的 include |

## 5. GAP 清单

| # | GAP | 证据 | 影响组 |
| --- | --- | --- | --- |
| G1 | **L3 全仓为零**：无真 npm registry、无真机/真官方桌面管理器自动化 | 无一条用例真连 registry：`registry.npmjs.org` 只作 URL 常量喂给假抓取（`tests/batch-e2e.test.mjs:23`，`fetchImpl` 仅 2 处注入）；`selftest/README.md:12-16` 把真 registry e2e 列为「未来 C 档」 | 全部，尤其 C / I |
| G2 | `selftest/` 骨架未接线：不在任何 npm script、不在 `tsconfig.json`、只有 tsc 检查；且其两包设定（`selftest/README.md:4`）小于 E 组的 3 包门槛 | `package.json:86-101`、`tsconfig.json:15`、`selftest/README.md:4` | E / 全量 |
| G3 | `./client` 子路径零测试引用 | `package.json:41`、`src/client.ts:1-4` | 承诺面 |
| G4 | 日噪声预算（≤50 行/天、≤500 行/操作日）零断言 | `CONTEXT.md:85-86`；tests 只断言 ≤12 行/小时（`tests/host-log.test.mjs:268/288/357`） | J |
| G5 | `docs:log:check` 缺行只警告；目录 23 行 vs 清单 29 事件 | `scripts/gen-log-catalog.mjs:252-256`、`:312-323`；`node scripts/gen-log-catalog.mjs --check` 的 6 条警告 | J |
| G6 | 架构文档三处计数过时（10 exports / 6 通 handlers / 27 事件） | `CONTEXT.md:108`、`docs/adr/0007-src-directory-shape.md:11`；`docs/agents/architecture.md:143/151/109` | 承诺面 / 放行判据 |
| G7 | 三出口无真子进程；I 组无真机 | `src/core/executor.ts:1339-1343`；`tests/issue-201`、`issue-236` 全假管理器 | C / I |
| G8 | 无跨进程真并发：锁/租约/中枢都在单进程内、假时钟 | `src/core/queue/ports.ts:42`、`src/core/hub/lease-policy.ts:16/19`、`tests/hub-process.test.mjs:39` | F / G |
| G9 | 协议换代只同进程 `globalThis` Symbol 槽模拟 | `src/host/hub/handoff.ts:12/17`、`tests/issue-254-protocol-handoff` | G |
| G10 | 无真时钟到点（15min 装 / 16min http） | `src/shared/commands.ts:39`、`src/host/http.ts:26` | D |
| G11 | UI 面（面板/入口/安装按钮/http）不在 A–J 任何组 | §3.5 表 | 承诺面 / 放行标准 |

## 6. 对放行标准（#261）的含义

1. **「全量」不能定义为「A–J 全绿」**。A–J 是功能场景目录，承诺面严格大于它：11 个 exports 里 5 项无组归属（`./panel`、`./client`、`./http`、`./install-button`、`./package.json`）。放行口径建议写成两维乘积：**A–J × 组内最强层** + **承诺面映射表无未归属项**。
2. **当前可达的门是 L2，不是 L3**。除 J 组外没有一组能靠现有命令走到 L2；因此「自测包全绿」最多证明到「本地闭环 + 日志真 dist」，不证明发布可用。放行标准必须显式列出「L3 人工/真机清单」，否则等于把 L3 的缺口藏进 L0/L1 的绿灯里。
3. **I 组（拓扑补偿）是唯一的真空档，而且它不属于「插件个数」维度**。#260 标它「真机」，现有拓扑证据全在 L0（假管理器；`issue-241` 只有状态文件恢复到 L1）；2–3 个自测包无论怎么设计都覆盖不了真官方管理器的拓扑契约。规划里必须把 I 组单列为「真机验证项」，不能算进自测包覆盖率。
4. **最小包数门槛与现有证据是对齐的，但方向要写清**：E 组 3 包在 `tests/batch-e2e.test.mjs:246` 有真盘用例，G 组 2 包在 `tests/hub-process.test.mjs:39`、F 组 2 包在 `tests/queue.test.mjs:48-56` 有真盘用例——「3 包够」在 E 上有证据，「2 包够」在 F/G 上有证据，但都是假网/假时钟。自测包规划要自带「真 registry」这一步才能把这三组抬到 L3。
5. **两个计数必须先修正再验收**：事件数 29（不是 27，`docs/agents/architecture.md:109`）、单包 handlers 7 通（不是 6，`architecture.md:143`）。否则新自测包会按错数字验收，且 `docs:log:check` 的「23 行 OK」会给出虚假完整感。
6. **建议的放行判据草案**（供 #261 取用）：
   - A–J 十组每组至少一条自动化证据达到「该组声明层」，且组层分布（L0×2 / L1×7 / L2×1）写进放行说明，不隐藏；
   - 承诺面 11 项逐项有 ≥1 条测试引用或明确标注为「内部件/打包面」；
   - `./client` 至少一条冒烟（当前 0）；
   - 日噪声预算至少一条自动化（当前 0），或明确改为人工验收项；
   - I 组与 C 组的真机/真 pnpm 单列人工放行清单，L3 由人签字而不是由绿色测试代签。

## 7. 取证复现（只读）

- 事件目录自检：`node scripts/gen-log-catalog.mjs --check`（输出 2 张表 23 行 OK + 6 条缺行警告）
- 测试体量：`Get-ChildItem tests/*.test.mjs`（169 个）
- 事件清单：`event-list.update.json` 解析 `events`（29 个：resident 22 / ondemand 6 / selfmon 1）
- 电话与码表：`src/host/factory.ts:662-704`、`src/shared/codes.ts`、`src/host/batch/fan-out.ts:1303-1366`
- 门禁定义：`package.json:86-101`
- 未运行：`npm run build` / `npm run test` / `npm run check` / `npm run smoke:log` / `npm run probe:layout`（按任务硬约束，本次不跑构建与全量测试）
