# spec #263 全量真机矩阵回归（T11 / #275）

> 本文件由 `selftest/real-machine/tools/run-all.ts` 自动生成（每个 run 完成后重写，可随中断续跑）。

## 结论

| 项 | 值 |
| --- | --- |
| suite runId | `20261103T093814-full` |
| 状态 | 已收尾 |
| 聚合 verdict | `known-red` |
| 退出码 | 0（0=全 pass/仅 known-red；1=fail/unknown；2=blocked） |
| 轮次 | 44 / 44 个计划 run（主链 32 + can-red 12） |
| 通过 / known-red / 失败 / unknown / 注入按预期失败 | 29 / 3 / 0 / 0 / 12 |
| worktree | `D:/dsh-plugin/_wt263/t11`（impl/263-t11 @ bd39b57baa10，dirty 48） |
| 并发 | 桌面官方通道 1（单实例）、dsh-web 通道 3 |
| 记录来源 | 本轮真机重跑 5 / 证据重建 39（重建记录由 `--rebuild-state` 从已定稿证据补回，数据源见各记录备注） |
| startedAt / finishedAt | 2026-11-03T03:25:25.206Z / 2026-11-03T03:56:35.596Z |

## 场景总表（本轮重跑）

| # | 场景 | 票 | 通道 | 证据 run | verdict | 结果 | 断言 通过/失败/known-red/unknown | 截图 | 耗时 | 定稿历史 run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | a-single-package-main-chain | 265 | desktop-official | [`265-20261103T093814-p01`](../265-20261103T093814-p01/)（证据重建） | pass | 通过 | 13/0/0/0 | 4 | 2m6s | `265-20261103T093814-p01` |
| 2 | b-batch-two-integrators | 266 | desktop-official | [`266-20261103T093814-p02`](../266-20261103T093814-p02/)（证据重建） | pass | 通过 | 38/0/0/0 | 7 | 4m47s | `266-20261103T093814-p02` |
| 3 | c-pure-target-no-wiring | 266 | desktop-official | [`266-20261103T093814-p03`](../266-20261103T093814-p03/)（证据重建） | pass | 通过 | 24/0/0/0 | 4 | 3m27s | `266-20261103T093814-p03` |
| 4 | d1-desktop-manager-update-success | 267 | desktop-official | [`267-20261103T093814-p04`](../267-20261103T093814-p04/)（证据重建） | pass | 通过 | 17/0/0/0 | 4 | 3m33s | `267-20261103T093814-p04` |
| 5 | d2-desktop-manager-update-failure | 267 | desktop-official | [`267-20261103T093814-p05`](../267-20261103T093814-p05/)（证据重建） | pass | 通过 | 18/0/0/0 | 3 | 2m36s | `267-20261103T093814-p05` |
| 6 | e1-cli-host-update-success | 267 | dsh-web | [`267-20261103T093814-p06`](../267-20261103T093814-p06/)（证据重建） | pass | 通过 | 22/0/0/0 | 0 | 18s | `267-20261103T093814-p06` |
| 7 | e2-cli-host-update-failure | 267 | dsh-web | [`267-20261103T093814-p07`](../267-20261103T093814-p07/)（证据重建） | pass | 通过 | 25/0/0/0 | 0 | 19s | `267-20261103T093814-p07` |
| 8 | e3-cli-host-install-timeout | 267 | dsh-web | [`267-20261103T093814-p08`](../267-20261103T093814-p08/)（证据重建） | pass | 通过 | 22/0/0/0 | 0 | 17s | `267-20261103T093814-p08` |
| 9 | f1-third-party-desktop-probe | 267 | desktop-official | [`267-20261103T093814-p09`](../267-20261103T093814-p09/)（证据重建） | known-red | known-red | 8/0/2/0 | 1 | 1m22s | `267-20261103T093814-p09` |
| 10 | g1-desktop-manager-install-timeout | 268 | desktop-official | [`268-20261103T093814-p10`](../268-20261103T093814-p10/)（证据重建） | pass | 通过 | 19/0/0/0 | 4 | 4m8s | `268-20261103T093814-p10` |
| 11 | g2-batch-queued-cancel | 268 | desktop-official | [`268-20261103T093814-p11`](../268-20261103T093814-p11/) | pass | 通过 | 28/0/0/0 | 6 | 5m30s | `268-20261102T174922` |
| 12 | g3-desktop-manager-failed-no-retry | 268 | desktop-official | [`268-20261103T093814-p12`](../268-20261103T093814-p12/)（证据重建） | pass | 通过 | 19/0/0/0 | 4 | 4m54s | `268-20261103T093814-p12` |
| 13 | g4-desktop-manager-retry-single-success | 268 | desktop-official | [`268-20261103T093814-p13`](../268-20261103T093814-p13/)（证据重建） | pass | 通过 | 25/0/0/0 | 5 | 6m5s | `268-20261103T093814-p13` |
| 14 | g5-desktop-manager-no-cancel-probe | 268 | desktop-official | [`268-20261103T093814-p14`](../268-20261103T093814-p14/)（证据重建） | known-red | known-red | 11/0/1/0 | 2 | 2m31s | `268-20261103T093814-p14` |
| 15 | e-batch-three-package-upgrade | 269 | desktop-official | [`269-20261103T093814-p15`](../269-20261103T093814-p15/)（证据重建） | pass | 通过 | 16/0/0/0 | 3 | 2m47s | `269-20261103T093814-p15` |
| 16 | e-batch-partial-failure | 269 | desktop-official | [`269-20261103T093814-p16`](../269-20261103T093814-p16/)（证据重建） | pass | 通过 | 17/0/0/0 | 3 | 4m56s | `269-20261103T093814-p16` |
| 17 | e-batch-resume-retry | 269 | desktop-official | [`269-20261103T093814-p17`](../269-20261103T093814-p17/)（证据重建） | pass | 通过 | 22/0/0/0 | 4 | 5m18s | `269-20261103T093814-p17` |
| 18 | h1-queue-lock-concurrent | 270 | dsh-web | [`270-20261103T093814-p18`](../270-20261103T093814-p18/)（证据重建） | pass | 通过 | 25/0/0/0 | 0 | 23s | `270-20261103T093814-p18` |
| 19 | h1b-queue-lock-simultaneous | 270 | dsh-web | [`270-20261103T093814-p19`](../270-20261103T093814-p19/)（证据重建） | pass | 通过 | 25/0/0/0 | 0 | 23s | `270-20261103T093814-p19` |
| 20 | h2-queue-lock-stale-reclaim | 270 | dsh-web | [`270-20261103T093814-p20`](../270-20261103T093814-p20/)（证据重建） | pass | 通过 | 20/0/0/0 | 0 | 17s | `270-20261103T093814-p20` |
| 21 | g6-hub-survives-self-replacement | 271 | dsh-web | [`271-20261103T093814-p21`](../271-20261103T093814-p21/)（证据重建） | pass | 通过 | 32/0/0/0 | 0 | 56s | `271-20261103T093814-p21` |
| 22 | g7-hub-handoff-evidence | 271 | dsh-web | [`271-20261103T093814-p22`](../271-20261103T093814-p22/)（证据重建） | pass | 通过 | 39/0/0/0 | 0 | 1m1s | `271-20261103T093814-p22` |
| 23 | i1-restart-enrollment-truth | 272 | desktop-official | [`272-20261103T093814-p23`](../272-20261103T093814-p23/)（证据重建） | pass | 通过 | 19/0/0/0 | 4 | 3m44s | `272-20261103T093814-p23` |
| 24 | i2-unregistered-honesty | 272 | dsh-web | [`272-20261103T093814-p24`](../272-20261103T093814-p24/)（证据重建） | known-red | known-red | 24/0/1/0 | 0 | 22s | `272-20261103T093814-p24` |
| 25 | i3-topology-compensation | 272 | desktop-official | [`272-20261103T093814-p25`](../272-20261103T093814-p25/)（证据重建） | pass | 通过 | 19/0/0/0 | 1 | 2m13s | `272-20261103T093814-p25` |
| 26 | k-single-panel-happy | 274 | dsh-web | [`274-20261103T093814-p26`](../274-20261103T093814-p26/)（证据重建） | pass | 通过 | 38/0/0/0 | 7 | 49s | `274-20261103T093814-p26` |
| 27 | k-single-panel-failure | 274 | dsh-web | [`274-20261103T093814-p27`](../274-20261103T093814-p27/)（证据重建） | pass | 通过 | 23/0/0/0 | 3 | 1m41s | `274-20261103T093814-p27` |
| 28 | k-batch-panel-states | 274 | dsh-web | [`274-20261103T093814-p28`](../274-20261103T093814-p28/)（证据重建） | pass | 通过 | 38/0/0/0 | 6 | 4m4s | `274-20261103T093814-p28` |
| 29 | k-batch-resume | 274 | dsh-web | [`274-20261103T093814-p29`](../274-20261103T093814-p29/)（证据重建） | pass | 通过 | 24/0/0/0 | 4 | 2m44s | `274-20261103T093814-p29` |
| 30 | j1-log-contract-coverage | 273 | dsh-web | [`273-20261103T093814-p30`](../273-20261103T093814-p30/)（证据重建） | pass | 通过 | 28/0/0/0 | 1 | 41s | `273-20261103T093814-p30` |
| 31 | j2-noise-budget | 273 | dsh-web | [`273-20261103T093814-p31`](../273-20261103T093814-p31/) | pass | 通过 | 16/0/0/0 | 2 | 5m28s | `273-20261103T054531` |
| 32 | j3-namespace-whitelist | 273 | dsh-web | [`273-20261103T093814-p32`](../273-20261103T093814-p32/)（证据重建） | pass | 通过 | 17/0/0/0 | 1 | 22s | `273-20261103T093814-p32` |
| 33 | a-single-package-main-chain（can-red） | 265 | desktop-official | [`265-20261103T093814-r33`](../265-20261103T093814-r33/)（证据重建） | fail | 注入后按预期失败 | 11/2/0/0 | 4 | 3m28s | `265-20261103T093814-p01` |
| 34 | b-batch-two-integrators（can-red） | 266 | desktop-official | [`266-20261103T093814-r34`](../266-20261103T093814-r34/)（证据重建） | fail | 注入后按预期失败 | 34/4/0/0 | 7 | 6m44s | `266-20261103T093814-p02` |
| 35 | c-pure-target-no-wiring（can-red） | 266 | desktop-official | [`266-20261103T093814-r35`](../266-20261103T093814-r35/)（证据重建） | fail | 注入后按预期失败 | 22/2/0/0 | 4 | 3m30s | `266-20261103T093814-p03` |
| 36 | d1-desktop-manager-update-success（can-red） | 267 | desktop-official | [`267-20261103T093814-r36`](../267-20261103T093814-r36/) | fail | 注入后按预期失败 | 15/2/0/0 | 4 | 3m29s | `267-20261103T093814-p04` |
| 37 | e1-cli-host-update-success（can-red） | 267 | dsh-web | [`267-20261103T093814-r37`](../267-20261103T093814-r37/) | fail | 注入后按预期失败 | 21/1/0/0 | 0 | 13s | `267-20261103T093814-p06` |
| 38 | g4-desktop-manager-retry-single-success（can-red） | 268 | desktop-official | [`268-20261103T093814-r38`](../268-20261103T093814-r38/) | fail | 注入后按预期失败 | 24/1/0/0 | 5 | 5m28s | `268-20261103T093814-p13` |
| 39 | e-batch-three-package-upgrade（can-red） | 269 | desktop-official | [`269-20261103T093814-r39`](../269-20261103T093814-r39/)（证据重建） | fail | 注入后按预期失败 | 15/1/0/0 | 3 | 2m45s | `269-20261103T093814-p15` |
| 40 | i1-restart-enrollment-truth（can-red） | 272 | desktop-official | [`272-20261103T093814-r40`](../272-20261103T093814-r40/)（证据重建） | fail | 注入后按预期失败 | 16/1/0/0 | 3 | 2m33s | `272-20261103T093814-p23` |
| 41 | k-single-panel-happy（can-red） | 274 | dsh-web | [`274-20261103T093814-r41`](../274-20261103T093814-r41/)（证据重建） | fail | 注入后按预期失败 | 8/1/0/0 | 2 | 50s | `274-20261103T093814-p26` |
| 42 | j1-log-contract-coverage（can-red） | 273 | dsh-web | [`273-20261103T093814-r42`](../273-20261103T093814-r42/)（证据重建） | fail | 注入后按预期失败 | 13/1/0/0 | 0 | 20s | `273-20261103T093814-p30` |
| 43 | h1-queue-lock-concurrent（can-red） | 270 | dsh-web | [`270-20261103T093814-r43`](../270-20261103T093814-r43/)（证据重建） | fail | 注入后按预期失败 | 11/1/0/0 | 0 | 17s | `270-20261103T093814-p18` |
| 44 | g6-hub-survives-self-replacement（can-red） | 271 | dsh-web | [`271-20261103T093814-r44`](../271-20261103T093814-r44/)（证据重建） | fail | 注入后按预期失败 | 23/1/0/0 | 0 | 1m5s | `271-20261103T093814-p21` |

（证据重建）= 该行聚合记录由 `--rebuild-state` 从已定稿单场景证据（`runs/<runId>/run.json` 与编排 `raw/<key>.log` 的退出码）补回，不是本轮真机重跑；记录本身的数据仍来自真实 run。

## can-red 期望失败表

| # | 场景 | 注入 | 期望红断言（历史 fail run） | 实测红断言 | 结果 | 证据 run |
| --- | --- | --- | --- | --- | --- | --- |
| 33 | a-single-package-main-chain | `--fault stale-variant` | 15-assert、26-assert | 15-assert、26-assert | 注入后按预期失败 | [`265-20261103T093814-r33`](../265-20261103T093814-r33/)（证据重建） |
| 34 | b-batch-two-integrators | `--fault skip-variant:c` | 47-assert、49-assert、50-assert、59-assert | 47-assert、49-assert、50-assert、59-assert | 注入后按预期失败 | [`266-20261103T093814-r34`](../266-20261103T093814-r34/)（证据重建） |
| 35 | c-pure-target-no-wiring | `--fault stale-variant:c` | 22-assert、33-assert | 22-assert、33-assert | 注入后按预期失败 | [`266-20261103T093814-r35`](../266-20261103T093814-r35/)（证据重建） |
| 36 | d1-desktop-manager-update-success | `--mode can-red` | 16-assert、37-assert（本轮编号漂移，按步骤语义匹配） | 17-assert、38-assert | 注入后按预期失败 | [`267-20261103T093814-r36`](../267-20261103T093814-r36/) |
| 37 | e1-cli-host-update-success | `--mode can-red` | 40-assert（本轮编号漂移，按步骤语义匹配） | 41-assert | 注入后按预期失败 | [`267-20261103T093814-r37`](../267-20261103T093814-r37/) |
| 38 | g4-desktop-manager-retry-single-success | `--mode retry-can-red` | 71-assert（本轮编号漂移，按步骤语义匹配） | 72-assert | 注入后按预期失败 | [`268-20261103T093814-r38`](../268-20261103T093814-r38/) |
| 39 | e-batch-three-package-upgrade | `--mode can-red` | 38-assert | 38-assert | 注入后按预期失败 | [`269-20261103T093814-r39`](../269-20261103T093814-r39/)（证据重建） |
| 40 | i1-restart-enrollment-truth | `--mode can-red` | 31-assert | 31-assert | 注入后按预期失败 | [`272-20261103T093814-r40`](../272-20261103T093814-r40/)（证据重建） |
| 41 | k-single-panel-happy | `--mode can-red` | 24-assert | 24-assert | 注入后按预期失败 | [`274-20261103T093814-r41`](../274-20261103T093814-r41/)（证据重建） |
| 42 | j1-log-contract-coverage | `--mode can-red` | 29-assert | 29-assert | 注入后按预期失败 | [`273-20261103T093814-r42`](../273-20261103T093814-r42/)（证据重建） |
| 43 | h1-queue-lock-concurrent | `--mode can-red` | 38-assert | 38-assert | 注入后按预期失败 | [`270-20261103T093814-r43`](../270-20261103T093814-r43/)（证据重建） |
| 44 | g6-hub-survives-self-replacement | `--mode can-red` | 53-assert | 53-assert | 注入后按预期失败 | [`271-20261103T093814-r44`](../271-20261103T093814-r44/)（证据重建） |

## known-red 终账（只允许 selftest/evidence/known-red.md 已登记条件）

| 编号 | 场景 | 首次发现 run | 本轮观察 | 状态 |
| --- | --- | --- | --- | --- |
| t3-267-exit-one | f1-third-party-desktop-probe | `267-20261102T113042` | run 267-20261103T093814-p09：known-red（known-red） | documented-unreachable |
| t4-268-no-cancel-probe | g5-desktop-manager-no-cancel-probe | `268-20261102T181106` | run 268-20261103T093814-p14：known-red（known-red） | documented-unreachable |
| t8-272-panel-pending-restart-branch | i1-restart-enrollment-truth | `272-20261103T040926` | run 272-20261103T093814-p23：pass（pass） | documented-unreachable |
| t8-272-i2-runtime-version-not-authoritative | i2-unregistered-honesty | `272-20261103T040932` | run 272-20261103T093814-p24：known-red（known-red） | documented-unreachable |

## 隔离事实

- pnpm/npm 缓存：每个 run 私有 `D:\dsh-plugin\_wt263\runtime\t11-275\_pkgcache/<ticket>-<stamp>`（`pnpm_config_cache_dir`、`npm_config_cache`、`npm_config_store_dir` 三键同指）。T10 坑：共享 D:/caches/pnpm 的缓存键含 registry origin+端口，复用会命中旧 packument → ERR_PNPM_TARBALL_INTEGRITY 假红；本 suite 每个 run 独立 pnpm_config_cache_dir/npm_config_cache/npm_config_store_dir
- SUT dist：`e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc`（208 文件，suite 起跑前统一构建）。子进程带 `npm_config_ignore_scripts=true`，SUT pin 的 `npm pack` 跳过 prepack 重建——并发 run 各自 prepack 会同时重写同一个 `dist/`，指纹会在读写竞争下漂移。
- 本地 registry：每个场景子进程自起本地 verdaccio（动态端口），suite 不复用 registry。
- 维护者 profile：`C:/Users/辰辰洋洋/.dsh`（只读指纹核对，各工具清理步骤记录在各自 run.json 的 maintainerProfile 段）。
- Playwright（k/j 组 UI 场景）：`D:/dsh-plugin/dsh-mattpocock-skills-deck/node_modules/playwright`。k/j 组 UI 场景通过子进程环境 DSH_VERIFY_PLAYWRIGHT=D:/dsh-plugin/dsh-mattpocock-skills-deck/node_modules/playwright 加载（仓库外已装，不进 package.json）
- 官方桌面：官方桌面发行包隔离实例（`--user-data-dir` + `DSH_HOME` 落在每个 run 目录），桌面通道串行。

## Web 通道证据说明（UI 截图 vs 电话/原始文件）

- 以下 web 通道 run 没有 UI 截图（`shots=0`，E/F/G/H/I/J 组按设计走电话/原始文件）：`267-20261103T093814-p06`、`267-20261103T093814-p07`、`267-20261103T093814-p08`、`270-20261103T093814-p18`、`270-20261103T093814-p19`、`270-20261103T093814-p20`、`271-20261103T093814-p21`、`271-20261103T093814-p22`、`272-20261103T093814-p24`、`267-20261103T093814-r37`、`273-20261103T093814-r42`、`270-20261103T093814-r43`、`271-20261103T093814-r44`。
- 其证据力来自 `run.json` 的断言与各自运行目录 `raw/*.json`（电话回执、台账/队列/日志原始文件、宿主进程状态），不是 UI 截图。

## 复跑命令

```powershell
node selftest/real-machine/tools/run-all.ts --worktree D:/dsh-plugin/_wt263/t11 --run-base-dir D:/dsh-plugin/_wt263/runtime/t11-275 --stamp 20261103T093814 --maintainer-home C:/Users/辰辰洋洋/.dsh
```

- 同一 `--stamp` 重跑 = 续跑（复用已完成记录，补跑未完成/blocked/unknown）；`--rerun` 表示不跳过已完成、按计划重跑（不重置聚合记录，`--only` 部分重跑安全）。
- 单场景重跑：`--only <场景 id>`；can-red 单组：`--only can-red:<场景 id>`。
- 聚合记录抢救：`--rebuild-state`（只从已定稿证据补回缺失聚合记录，不跑真机；记录注明数据源）。

## 备注

- SUT dist：suite 起跑前在 worktree 统一 npm run build 一次（聚合指纹 e8cef960ed4baca3…，208 文件），所有 run 子进程带 npm_config_ignore_scripts=true，SUT pin 的 npm pack 不再并发触发 prepack 重建 dist/（避免并发写同一个 dist 造成指纹漂移）。
- 编排器运行期修复（事后追记，真机结论不受影响）：①桌面 run 启动前清理曾泛匹配运行根，误杀并发 web run 自己的 verdaccio → 只清理官方桌面进程；②续跑/--rerun 执行前先删除自己上一轮运行目录（否则 verdaccio 存储残留同版本 tarball 致 publish exit 1、新旧 raw 混在一起）；③--rerun 不再重置聚合记录，并新增 --rebuild-state 从已定稿证据补回记录。
- can-red 编号漂移匹配（修复后重跑）：红断言除编号外还按 assertion.step 语义比对历史红点；d1/e1/g4 三组因此判 can-red-expected-fail（历史 → 本轮编号 16/37→17/38、40→41、71→72，步骤原文一致），并非放宽判定——多余红断言仍判 mismatch。
- 证据重建起因：一次 --rerun（修复前版本）曾把聚合记录清到 1 条，随后用 --rebuild-state 从定稿单场景证据补回 43 条；此后 j2/g2/d1/e1/g4 为自然重跑，当前 39 条为证据重建记录（每行证据链接带标记、数据源写在各记录备注）。
- 记录重建（--rebuild-state）：最近一次补回 0 条、保留已有 44 条（当前共 39 条为证据重建记录，每条注明数据源；不是重跑结果）。
