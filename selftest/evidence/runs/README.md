# 已提交的真机 run 账本

本目录只放**已提交**的真机证据包（一次 run 一个目录，目录名 = run.json 的 `runId`）。
格式契约见 `../README.md`；场景声明见 `../coverage-matrix.md`。

| runId | 场景 | 宿主通道 | 总判定 | 退出码 | 用途 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 265-20261101T215128 | a-single-package-main-chain | desktop-official | pass | 0 | 主链正式证据（A@0.0.1 → A@0.0.2，官方桌面真机） | 13 条断言 / 4 张截图；in-process 安装出口由日志 `hostKind=desktop-manager` 证明；维护者 profile 指纹不变 |
| 265-20261101T214716 | a-single-package-main-chain | desktop-official | fail | 1 | can-red 故障注入（`--fault stale-variant`：发布 0.0.2 但内容是 0.0.1） | 预期失败；失败点 `15-assert`（内容哈希未变）与 `26-assert`（重启后 client/host 仍是 v0.0.1）；其余断言仍 pass，说明红的是被测断言本身 |
| 264-20261101T194628 | 宿主矩阵 spike（#264，T0） | desktop-official + dsh-web | 混合（A 部分通、B 全通） | — | #264 官方桌面通道可行性研究，为 #265 主链铺路 | 非 #265 场景行；保留原始 A/B 双通道探测证据（向导、插件管理器、CDP、清理），主链选通道 A 的依据之一 |
| 266-20261102T034002 | b-batch-two-integrators | desktop-official | pass | 0 | 三插件真身份 + 两集成方真 UI 批量更新正式证据（A/B/C@0.0.1 → A/B@0.0.2，C 由 A 推到 0.0.2） | 38 条断言 / 7 张截图；A 批量跨官方桌面自重启续跑，B 独立批量预查判 current；两席账本/中枢按属主隔离；维护者 profile 指纹不变 |
| 266-20261102T034912 | c-pure-target-no-wiring | desktop-official | pass | 0 | 纯目标无接线正式证据（A@0.0.1 + C@0.0.1 → A 批量把 C 推到 0.0.2） | 24 条断言 / 4 张截图；C 页 `wiring=none`、无 `.dsh-upd` 面板/入口、manifest `dependencies={}`、日志无 `fxc*` 命名空间 |
| 266-20261102T080334 | b-batch-two-integrators | desktop-official | fail | 1 | can-red 故障注入（`--fault skip-variant:c`：不发布 C@0.0.2） | 预期失败；恰好 `47/49/50/59-assert` 红（A/B 面板 C 行 0.0.1、C 徽标仍旧、installC=false），其余 34 条仍 pass；注入点见 `raw/22-can-red-fault.json` |
| 266-20261102T081101 | c-pure-target-no-wiring | desktop-official | fail | 1 | can-red 故障注入（`--fault stale-variant:c`：发 0.0.2 但内容取 0.0.1） | 预期失败；恰好 `22/33-assert` 红（C 内容哈希未变、重启后徽标仍旧），其余 22 条仍 pass；注入点见 `raw/20-can-red-fault.json` |
| 267-20261102T094226 | d1-desktop-manager-update-success | desktop-official | pass | 0 | 出口二（官方桌面 in-process 插件管理器）成功格正式证据：A@0.0.1 → A@0.0.2 | 17 条断言 / 4 张截图；窗口内恰好 2 个非空 operation（先 remove 0.0.1、后 add 0.0.2，pnpm.log 原文见 raw/24、25）；already-installed 守卫处理后无第三次 pnpm；exec `route=desktop-manager ok=true exitCode=0`；重启后 client/host v0.0.2；台账 completed |
| 267-20261102T110749 | d2-desktop-manager-update-failure | desktop-official | pass | 0 | 出口二失败格正式证据：check 后删 registry tarball → 管理器移除步成功、重装 pnpm 404 → 诚实失败 + 手工命令可执行 | 18 条断言 / 3 张截图；`29/30` exec+fail 八格（stage=exec/reason=nonzero-exit/exitCode=1）；`33` operation 2 个（remove 0.0.1 + add 404）；面板随目标包移除而消失（页面回桌面 home，不伪造 DOM）；`35` 人话格含「目标包已被宿主移除」+ 载体命令；`41` 手工命令真机 exit0 并装回 0.0.2；重启后 v0.0.2 |
| 267-20261102T111047 | e1-cli-host-update-success | dsh-web | pass | 0 | 出口三（普通 DSH 宿主 spawn CLI 子进程）成功格正式证据 | 22 条断言 / 20 raw / 0 截图；`29` hostKind=cli 且 exec `route=cli-process`；`32` 磁盘 0.0.2；`33` exec ok=true exitCode=0 durationMs=979；`34` 电话回包 42ms < exec 979ms（异步语义）；`39` 重启后 buildTag=host v0.0.2；通道 B 无窗口，UI 证据为 DOM/文本原文（见 index.md 备注） |
| 267-20261102T111127 | e2-cli-host-update-failure | dsh-web | pass | 0 | 出口三失败格正式证据：check 后删 tarball → CLI 子进程 pnpm 404 非零退出 → 失败面不给载体命令，回包 manual 可执行 | 25 条断言 / 22 raw；`33` job.message=install-failed + `ERR_PNPM_FETCH_404 … 404` 原话；`34` 无载体命令；`35/36` exec+fail 八格；`37` 磁盘仍 0.0.1；`42` 手工命令真机 exit0 装到 0.0.2；`44` 重启 buildTag=host v0.0.2 |
| 267-20261102T112503 | e3-cli-host-install-timeout | dsh-web | pass | 0 | 出口三超时格正式证据：宿主 registry 指向延迟代理 + 夹具 `installTimeoutMs=4000` → 产品到点终止 CLI 子进程 | 22 条断言 / 20 raw；`33` job.message=「安装超时，已终止子进程」；`34` exec route=cli-process ok=false exitCode=1 durationMs=4111（预算 4000 + 3s 宽限内）；`35` fail 八格 reason=timeout；`36` 磁盘 0.0.1；`39` 重启仍 host v0.0.1；`42` 宿主/代理全停、端口释放 |
| 267-20261102T113042 | f1-third-party-desktop-probe | desktop-official | known-red | 0 | 出口一（第三方 Desktop / desktopProfiles）能力探测与不可达兜底 | 10 条断言 = 8 pass + 2 known-red / 1 张截图 / 15 raw；三份探测原文（文件系统/卸载表/服务）+ 结构判据分类（第三方 0，nearMiss 25 条单列）；`24` 本机唯一桌面宿主 hostKind=desktop-manager（desktopProfiles 为空的反证）；`25/26` 出口一真机更新成功/失败格 known-red，note 写「需第三方 Desktop 宿主 + desktopProfiles 服务」复现条件 |
| 267-20261102T113218 | d1-desktop-manager-update-success | desktop-official | fail | 1 | can-red 故障注入（`--mode can-red`，stale-variant：发 A@0.0.2 但内容仍是 0.0.1） | 预期失败；恰好 `16/37-assert` 红（内容哈希未变、重启后 client/host 仍 v0.0.1 标题未变），其余 15 条（真 UI 安装、两步 operation、exec、磁盘 0.0.2、台账 completed）仍 pass；注入点见 `raw/can-red-fault-injection.json` |
| 267-20261102T113629 | e1-cli-host-update-success | dsh-web | fail | 1 | can-red 故障注入（`--mode can-red`，stale-variant：发 A@0.0.2 但内容是 0.0.1） | 预期失败；恰好 `40-assert` 红（重启后 buildTag=host v0.0.1，而 runningVersion 已是 0.0.2），其余 21 条仍 pass；注入点见 `raw/can-red-fault-injection.json` |

## 复核入口

- 先看每个 run 的 `index.md`（一页索引），再按需点开 `shots/<id>.json`（看什么/expected/actual/判定）与 `raw/`。
- `run.json` 是机器可读总账；其中 `sut` 段给出「被测系统 = 当前工作树构建产物」的 tarball sha256 与 dist 聚合指纹，
  `cleanup` 段给出进程/端口清理证据，`maintainerProfile` 段给出维护者 DSH_HOME 前后指纹。
- 证据里的绝对路径（`D:/dsh-plugin/_wt263/runtime/t1-265/<runId>/...`）是采集机原始路径，临时目录可删；
  本目录内是完整副本，复核只依赖本目录。
- can-red run 的 `notes` 与 `raw/can-red-fault.json` 写明注入点与预期失败点；与主链 run 对照看即知哪条断言真的会红。

## 复跑

见 `../README.md` §10（主链与 can-red 两条命令）、`docs/research/20261101-issue-265-single-package-main-chain.md` §9，以及 #267 三出口矩阵的 `docs/research/20261101-issue-267-three-install-exits.md` §4（run-d/run-e/run-f 与 can-red 命令）。
