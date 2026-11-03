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
| 268-20261102T181651 | g1-desktop-manager-install-timeout | desktop-official | pass | 0 | 组 D 超时格正式证据：官方桌面出口二慢安装超时（延迟代理 60s + 夹具 installTimeoutMs=12000） | 19 条断言 / 4 张截图 / 26 raw；`27` 台账 failed/target=0.0.2；`36` exec count=1/ok=false/durationMs=12439；`37` execFailCount=1；`38` 人话格与 cancel 能力一致（claimsNoCancel=false/claimsTerminated=false，message 含「安装已被取消」）；`42` operation 2 个 remove-only；`43` 磁盘 B=null；`46` 重启后台账仍 failed；维护者 profile 指纹不变 |
| 268-20261102T174922 | g2-batch-queued-cancel | desktop-official | pass | 0 | 组 D 取消格正式证据：B 运行时单插件电话占锁 → A 面板真 UI 排队 + 行取消文案诚实 + 「丢弃本批」两步确认清场 | 28 条断言 / 6 张截图 / 36 raw；`27` 占锁方 install 受理（attemptCount=1）；`29` owner=fxb-c；`31/34` C 行 queued/row-cancel-queue/waiting 含 fxa-c；`36` 排队窗内占锁方台账 installing（sharedReader 修复真机回归）；`38` 新文案诚实；`43` 丢弃回执；`46` aSession=null；`48` 8 次采样 waiting 全空；`52` 队列清空；`60-63` A 的 C 无 exec/无台账/磁盘 0.0.1；`65` 占锁方 exec 40391ms 后才 failed；`68` 重启如实 |
| 268-20261102T175424 | g3-desktop-manager-failed-no-retry | desktop-official | pass | 0 | 组 D 已失败不重试格正式证据：check 后删 tarball → 失败落定 → 静置 15s 无第二次尝试 → 重启仍 failed | 19 条断言 / 4 张截图 / 26 raw；`25` tarball 200→404 且版本文档不变；`27` 台账 failed；`29` UI 失败；`34` message=install-failed + 手工命令；`42` execCount=1/okCount=0；`43` exec/fail 八格；`44` 磁盘 B=null；`47` 重启后台账仍 failed、不谎称更新中 |
| 268-20261102T175925 | g4-desktop-manager-retry-single-success | desktop-official | pass | 0 | 组 D 补一次成功格正式证据：失败后恢复 registry → 真 UI 点失败行「重试」→ 成功并重启 | 25 条断言 / 5 张截图 / 43 raw；`52` 磁盘 B=0.0.2；`57` 台账恰一条成功终态；`66` 日志无重复成功/无第二次失败；`70` 重启后 UI 显示已更新；`71` 磁盘与观察者一致（client/host v0.0.2） |
| 268-20261102T180537 | g4-desktop-manager-retry-single-success | desktop-official | fail | 1 | can-red 故障注入（`--mode retry-can-red`，stale 内容：版本号 0.0.2 但构建内容 0.0.1 + run 私有 pnpm store） | 预期失败；恰好 `71-assert` 红（重启后 B 卡片 clientTag=hostTag=v0.0.1、ui=single，而台账 completed/target=0.0.2、磁盘 B=0.0.2），其余 24 条（D3 失败格、D4 台账恰一条成功、无重复、磁盘）仍 pass；注入点与 pnpm-store 隔离见 notes / `raw/pnpm-store-isolation.json` |
| 268-20261102T181106 | g5-desktop-manager-no-cancel-probe | desktop-official | known-red | 0 | 组 D 无终止能力探测格：官方宿主 asar 能力度量 + 库内 L0 诚实文案；真机「无 cancelInstall 宿主」不可达 | 12 条断言 = 11 pass + 1 known-red / 2 张截图 / 12 raw；`22` asarBytes=182766714/counts={pluginManager:724,installBundle:98,cancelInstall:66}；`23` cancelInstall 66 处含片段；`25` L0 exit 0 且 stdout 含「未提供取消能力」；`26` known-red（官方 0.2.1-rc.5 有该能力，需换无能力宿主版本复现；见 known-red.md `t4-268-no-cancel-probe`） |
| 269-20261102T224509 | e-batch-three-package-upgrade | desktop-official | pass | 0 | 组 E 三包批量全成正式证据（A/B/C@0.0.1 → 0.0.2，A 面板真 UI 宏「全部更新」） | 16 条断言 / 3 张截图 / 25 raw；`25` 磁盘三包 0.0.2 且 dependencies 同步；`27` 台账 fxa/fxb/fxc 各恰 1 条 completed（target 0.0.2/previous 0.0.1）；`35` install.request 覆盖 a/b/c、execFail=0、installAudit.nonCheckExpired=0/unretried=0；`38` 重启后三卡片 client/host v0.0.2、A 面板三行 current；`40` 重启后台账/磁盘/UI 一致；`43` 批量账本属主 fxa 三键；head 9c094c7 / distDigest e8cef960… |
| 269-20261102T224810 | e-batch-partial-failure | desktop-official | pass | 0 | 组 E 部分失败隔离正式证据（改坏 B tarball 字节：check 能过、install 必失败） | 17 条断言 / 3 张截图 / 26 raw；`21` B tarball sha 799ea289…→3536eb27…、版本文档不变；`27` A/C 磁盘=0.0.2、B=null；`28` B 台账恰 1 条 failed（install-failed + 可执行手工命令）；`38` B 恰 1 次 exec 失败且无自动重试、A/C execFails=0；`41` 重启后 B 不谎称成功/在飞 |
| 269-20261102T225353 | e-batch-resume-retry | desktop-official | pass | 0 | 组 E 恢复后续跑/重试正式证据（恢复 B tarball → 产品自动续跑 → 三包全成） | 22 条断言 / 4 张截图 / 49 raw；`52` tarball sha 复原、版本文档不变；`56` retryPath=auto-resume 且三包磁盘 0.0.2；`66` A/C 安装请求/执行计数不变，B requests/execs 1→2、execOks 0→1；`71` 三插件各恰 1 条 completed、总账 3 条成功无重复无丢行；`69` 重启后三卡片新版、三行 current |
| 269-20261102T230056 | e-batch-three-package-upgrade | desktop-official | fail | 1 | can-red 故障注入（`--mode can-red`，stale-variant C：发 C@0.0.2 但内容仍是 0.0.1 + run 私有 pnpm store） | 预期失败；恰好 `38-assert` 红（重启后 C 卡片 clientTag=client v0.0.1、徽标仍旧版，而 A/B 卡片 v0.0.2、台账三条成功、磁盘三包 0.0.2），其余 15 条仍 pass；注入点见 run.json notes 与 raw 相关文件 |
| 270-20261103T004659 | h1-queue-lock-concurrent | dsh-web | pass | 0 | 组 F 队列/锁：两个独立 DSH web 宿主同 home+profile，入口 1 受理后锁窗内入口 2 到达（顺序时序）正式证据 | 25 条断言 / 41 raw；`31` A ok/installing、B update-busy；`52` exec=1 route=cli-process ok/exit0 durationMs=1562；`54` 安装窗落在单一 global.lock 区间（锁 id `58ed5fc7…`）；`58` busy-owner=1 + gateRefused=3；`60/62` 磁盘 0.0.2、台账恰 1 条 completed（target 0.0.2/previous 0.0.1）；`64` 队列收尾 owner=null/waiting=0；`41/43/45` 重启后 v0.0.2、失败方重试收敛；head 025e50a / distDigest e8cef960… |
| 270-20261103T004808 | h1b-queue-lock-simultaneous | dsh-web | pass | 0 | 组 F 队列/锁：两个独立 DSH web 宿主同刻（Promise.all）对同一 target 发安装（同时刻时序）正式证据 | 25 条断言 / 40 raw；`30` 同刻 A ok/installing、B update-busy（B 回包 49ms）；`32` 赢家 completed；`51/53` exec=1 落单一锁区间（durationMs=1991，锁 id `07b64a9f…`）；`57` busy-owner=1 + gateRefused=3；`61/63` 台账恰 1 条 completed、队列收尾干净；`40/42` 重启后 v0.0.2；head 025e50a / distDigest e8cef960… |
| 270-20261103T004847 | h2-queue-lock-stale-reclaim | dsh-web | pass | 0 | 组 F 队列/锁：预写 pid 已死/60s 前 global.lock + 安装预算 4s，验证陈旧锁二次核对回收后继续安装 | 20 条断言 / 29 raw；`21` 预写锁 pid=999999、pidAlive=false；`37` stale-owner=1（ageMs=64339、ownerHash=b9ae1254 与 payload 复算一致）、busy-owner=0；`38` reclaimed=1（holderHash=0f7833d2）后 exec=1 ok/exit0；`39` 锁 id 两代（旧 selftest-stale… → 新 a58cb93c…），末次 absent；`43/45` 磁盘 0.0.2、台账恰 1 条 completed；`47` 队列收尾干净；head 025e50a |
| 270-20261103T004915 | h1-queue-lock-concurrent | dsh-web | fail | 1 | 组 F can-red 真失败：入口 1 持 global.lock+install.lock 安装中，harness 删两锁并把 queue.json 置空（模拟锁/队列状态丢失）→ 第二入口越过互斥 | 12 条断言 = 11 pass + 1 fail；唯一红 `38-assert`：admittedB=true、exec 行数=2、两 exec 窗口重叠=true（[8175629,8177424] 与 [8175701,8178362]），A/B 均 ok/installing；其余 11 条（隔离、SUT 钉版、基版安装、变体发布、双宿主启动、清理）仍 pass；注入原始件 `raw/27/28/30/37/39` |
| 271-20261103T015124 | g6-hub-survives-self-replacement | dsh-web | pass | 0 | 换手主格：A 自身先更新期间杀第一代宿主、同 home/profile 起第二代，B/C 无需人工续跑自动完成 | 32 条断言全 pass；换手窗口 a=done/b=installing/c=ready、第一代租约 pid=71848 gen=1；第二代 host.start ts=1793641914345、resume run.start ts=1793641914710（resumed=true）；B/C exec ts=1793641947379/1793641949128 均晚于第二代 host.start，route=cli-process/ok/exit0；batch 三行 done/failed=0；plan sessionId 不变；台账三包各 1 条 completed；磁盘 0.0.2×3；gate-refused 31 次（旧占位 ~30s）为观测事实 |
| 271-20261103T015237 | g7-hub-handoff-evidence | dsh-web | pass | 0 | 页面恢复格：换手完成后关第二代宿主（=关页面）再同 home/profile 重开，面板与台账/磁盘一致 | 39 条断言全 pass；页面 token 握手 303 + cookie、带 cookie GET / =200/38654B；重开后 batchStatus phases=a/b/c=done、progress done3/failed0/finished；hubStatus finished/done3/failed0/activeInstall=null；A updateCheck 显示 0.0.2 已最新；磁盘三包 0.0.2、台账三包 completed；刷新前后一致 |
| 271-20261103T015357 | g6-hub-survives-self-replacement（can-red） | dsh-web | fail | 1 | can-red 真失败：换手窗口删除 hub/plans/fxa.json（raw 记删除前后原文与 state-at-kill），第二代无方案可接管 | 24 条断言 = 23 pass + 1 fail；唯一红 `53-assert`：删 plan 后 B/C 未自动续跑（45s 后 phases=a:done/b:installing/c:ready、resumeRunStart=0、execAfterHost2=0）；其余 23 条（隔离、SUT 钉版、基版安装、变体发布、第一代换手窗口、清理）仍 pass；注入件 `raw/41`/`raw/42`/`raw/52` |

| 272-20261103T040926 | i1-restart-enrollment-truth | desktop-official | pass | 0 | I1 重启在册真话正式证据：官方桌面 in-process 热换（装完同进程加载 v0.0.2、安装窗内无 host.start），真重启不回退（client/host/磁盘/在册清单一致） | 19 条断言 / 4 张截图 / 32 raw；`31-assert` 面板「已是最新」且卡片 client/host v0.0.2；`44-assert` 安装窗 host.start=0；`52-assert` 重启后三面 v0.0.2；`46-assert` 台账恰一条成功 |
| 272-20261103T040932 | i2-unregistered-honesty | dsh-web | known-red | 0 | I2 未登记诚实（A-prime，通道 B）：真安装（cli-process）→ verify 行 restart-required → 未重启不热换（磁盘 0.0.2 而 buildTag 仍基版）→ 摘在册真重启不加载 → 写回重启加载 0.0.2 | 25 条断言 = 24 pass + 1 known-red / 37 raw；`33-assert` verify restart-required/pendingRestart=true；`37-assert` known-red（updateStatus 按磁盘宣称 completed，需注入 ReaderOverrides.runningVersion）；`59-assert` 台账恰 1 条 |
| 272-20261103T041348 | i3-topology-compensation | desktop-official | pass | 0 | I3 拓扑补偿正式证据：桌面管理器 remove→install 时已装包文件被独占锁 + 安装预算 4s → remove 超时失败，三档补偿文案与 manifest 在册事实一致（本 run 命中 unverified 档），载体命令可重装恢复 0.0.2 | 19 条断言 / 1 张截图 / 31 raw；`38/39/40-assert` exec ok=false、stage=exec/reason=timeout、台账 failed 带 remove 超时原文；`42/43/44-assert` 文案恰三档之一且与在册/磁盘事实一致；`49-assert` 载体命令重装 exit0 |
| 272-20261103T041611 | i1-restart-enrollment-truth（can-red） | desktop-official | fail | 1 | I1 can-red 真失败：stale-variant 注入（发 A@0.0.2 但内容仍是 0.0.1）→ 面板说「已是最新」而卡片 client/host 仍 v0.0.1，证明断言有牙齿 | 17 条断言 = 16 pass + 1 fail（`31-assert` 预期红）；3 张截图 / 28 raw；安装/台账/清理断言仍 pass |
## 复核入口

- 先看每个 run 的 `index.md`（一页索引），再按需点开 `shots/<id>.json`（看什么/expected/actual/判定）与 `raw/`。
- `run.json` 是机器可读总账；其中 `sut` 段给出「被测系统 = 当前工作树构建产物」的 tarball sha256 与 dist 聚合指纹，
  `cleanup` 段给出进程/端口清理证据，`maintainerProfile` 段给出维护者 DSH_HOME 前后指纹。
- 证据里的绝对路径（`D:/dsh-plugin/_wt263/runtime/t1-265/<runId>/...`）是采集机原始路径，临时目录可删；
  本目录内是完整副本，复核只依赖本目录。
- can-red run 的 `notes` 与 `raw/can-red-fault.json` 写明注入点与预期失败点；与主链 run 对照看即知哪条断言真的会红。

## 复跑

见 `../README.md` §10（主链与 can-red 两条命令）、`docs/research/20261101-issue-265-single-package-main-chain.md` §9，以及 #267 三出口矩阵的 `docs/research/20261101-issue-267-three-install-exits.md` §4（run-d/run-e/run-f 与 can-red 命令）。
| 273-20261103T055059 | j1-log-contract-coverage | dsh-web | pass | 0 | J 组事件目录/契约覆盖正式证据：A 单包真安装 + 三包真批量（B 被文件锁拖到 6s 预算超时）后逐行校验日志契约 | 28 条断言 / 1 张截图（批量后真 UI 面板）/ 32 raw；exec 恰 1 行 route=cli-process ok=true exitCode=0；B exec ok=false durationMs=6035、install.fail stage=exec/reason=timeout、verify failed；batch.summary total=3/ok=1/failed=2/stoppedBecause=finished；契约四关 0 违规（84 行）；命名空间=[fxa-a,fxa-b,fxa-c,fxb-b,fxb-c]；台账 A completed/B failed/C failed（C 为 B 半删级联，如实记账）；每 ns ≤500 行且无解析失败 |
| 273-20261103T054531 | j2-noise-budget | dsh-web | pass | 0 | J 组噪声预算正式证据：两个真 UI 页面同时轮询，静置窗口 ≥100 次轮询零新增，状态变化恰 1 条边沿事件 | 16 条断言 / 2 张截图（点检查更新前/后）/ 23 raw；窗口轮询=100（每页 53/52）、新增行=0（常驻=0）；点检查更新后 update.status.changed(update-available/latest=0.0.2) 恰 1 行；再等 20 次轮询仍 1 行；面板原文「有新版本 0.0.2 可安装（当前版本 0.0.1）」；ns 行数 16/2/2 无解析失败 |
| 273-20261103T054540 | j3-namespace-whitelist | dsh-web | pass | 0 | J 组落点/白名单/UI 对账正式证据：面板日志健康读数 ↔ 磁盘逐项一致；logAppend 伪造宿主事实事件被拒 | 17 条断言 / 1 张截图（面板日志健康区）/ 22 raw；健康读数「落点=self；目录指纹=150c0975；按需开关=关；丢弃 0 行；最近事件=11/3 05:45；契约=正常」= wire.ready.logDirHash/logSink；最近事件 deltaMs=56615；client 事件 [panel.mount,panel.action] 只在 fxa-a；伪造 update.install.exec accepted=0/dropped=1/伪造行=0；收尾无残留 |
| 273-20261103T054614 | j1-log-contract-coverage | dsh-web | fail | 1 | can-red 故障注入：本 run 私有契约副本删掉 `update.install.exec` 事件与同名 fieldEnums（仓库契约/src 不动） | 预期失败；唯一红 `29-assert`（真安装产生的 exec 行被私有契约判成未知事件：removedEvent=true、unknownEvents=["update.install.exec"]、exec 未知行数=1）；前置断言（真安装 exec 行存在、clean 契约四关全过）仍 pass，红点可归因到注入；注入前后 diff 见 raw |
| 274-20261103T085741 | k-single-panel-happy | dsh-web | pass | 0 | K1 单包面板全状态正式证据：未安装/可更新/更新中/已了结/重启后 + changelog + 入口/安装按钮/额外面板（通道 B 真页面，两代宿主） | 38 条断言 / 7 张截图 / 19 raw；`18-assert` 初始 done「已是最新，无需更新。」、`19-assert` C 额外面板「未安装」正反两态；`23-assert` 可更新横幅原文；changelog `27-35-assert`（yanked/截断/分类/markdown/裸 URL/BREAKING）；`37-assert` 安装中横幅原文；`41-assert` 落定 done；`45-assert` install.request 恰 1；`47-assert` 台账 completed/target 0.0.2/prev 0.0.1；`52-assert` 重启后 client/host v0.0.2；`57-assert` C 首次安装横幅；head fb539ec / distDigest e8cef960… |
| 274-20261103T085842 | k-single-panel-failure | dsh-web | pass | 0 | K2 单包失败链正式证据：坏 tarball 字节（元数据/integrity 不动）→ check 仍可更新 → install 失败 → 最后手段/手工命令原文 → 执行面板命令 → 重启了结 | 23 条断言 / 3 张截图 / 23 raw；`17-assert` sha 变/版本文档不变/改坏前后 HTTP 200 且响应字节一致；`22-assert` 失败横幅「更新失败（install-failed）」；`23-assert` 最后手段四条件文案；`24-assert` 手工命令原文（`dsh plugin --profile t10ui add --save-exact …@0.0.2 --registry=https://127.0.0.1:59110`）；`29/30-assert` exec 全败 + fail 八格 stage=exec/reason=nonzero-exit/exitCode=1；`32-assert` 台账 failed/target 0.0.2；`36-assert` 手工命令真机 exit0 装到 0.0.2；`40-assert` 重启后 settled 历史行；head fb539ec / distDigest e8cef960… |
| 274-20261103T090025 | k-batch-panel-states | dsh-web | pass | 0 | K3 批量面板状态矩阵正式证据：三行检查/安装中/部分失败隔离（C 坏 tarball）/复原+清 store/续跑/重启一致（三代宿主同 home/profile） | 38 条断言 / 6 张截图 / 32 raw；`21-assert` 挂载即自动检查（summary「3 个可更新」）；`28-assert` 安装中相位（a installing/b/c ready）；`31-assert` 无全批假成功（「1 个失败 · 2 个已是最新」）；`32/33-assert` 失败横幅 + C 行最后手段文案；`35-assert` 好行不受影响（a/b 磁盘 0.0.2、A/B 台账 completed）；`39-assert` gen1 exec A/B ok=1、C 1 失败；`40-assert` gate check-expired 重试事实；`42-assert` tarball 复原；`44-assert` 清 run 私有 store（343 文件）；`50-assert` 续跑后 C 磁盘 0.0.2；`58-assert` exactly-once（A/B exec=1、C exec=2 且 ok=1）；`59-assert` 台账三包各 1 条 completed；`63/67-assert` gen3 重启三行 current + 磁盘 0.0.2；head fb539ec / distDigest e8cef960… |
| 274-20261103T090421 | k-batch-resume | dsh-web | pass | 0 | K4 跨重启续跑正式证据：C 坏 tarball 部分失败 → 杀宿主 → 复原+清 store → gen2 双闸冻结（无自动推进）→ 真 UI 点续跑 → exactly-once → gen3 重启一致 | 24 条断言 / 4 张截图 / 31 raw；`20-assert` C tarball sha 变、版本文档不变；`22-assert` 部分失败隔离（a/b 0.0.2、C 0.0.1、C 台账 failed）；`26-assert` 杀宿主后落盘真相（batch a/b done、c failed）；`35-assert` 续跑入口文案（「继续上次未完成的更新（剩余 1 个）。」+ title + 丢弃文案）；`37-assert` 冻结 8s（tarball 请求 5→5、C 磁盘/相位不变）；`39-assert` 点续跑后「已继续上次未完成的更新（剩余 0 个）。」+ C 磁盘 0.0.2；`42-assert` exactly-once（reqA=1/reqB=1/reqC=2、A/B 台账未改写、audit.nonCheckExpired=1）；`43-assert` 台账三包各 1 条 completed；`46-48-assert` gen3 重启三行 current + 卡片标记 v0.0.2；head fb539ec / distDigest e8cef960… |
| 274-20261103T090655 | k-single-panel-happy（can-red） | dsh-web | fail | 1 | can-red 真失败：停宿主后改 run 私有已装包 `lib/client.js`，把横幅「已是最新，无需更新。」转义串替换为同串+`RED` | 预期失败；9 条断言 = 8 pass + 唯一红 `can-red-03-banner-exact`（重启后标题「已是最新，无需更新。RED」≠ 精确原文）；`21-assert` 注入生效（occurrences=2、sha256 前后变）；注入原点见 run.json notes 与 raw/can-red-patch.json；head fb539ec / distDigest e8cef960… |


## 2026-11-03 全量矩阵 suite（#275 / T11）

- suite：`20261103T093814-full`（kind=full-matrix-suite，status=finished，verdict=known-red，exitCode=0，finished）
- 聚合：44 run = 32 主链 + 12 can-red；pass 29 / known-red 3 / can-red-expected-fail 12 / fail 0 / unknown 0；断言 944 pass / 18 fail（全部为注入预期红）/ 4 known-red / 0 unknown。
- 索引：`runs/20261103T093814-full/index.md`（结论 → 44 行场景总表（含证据重建标记）→ can-red 表 → known-red 终账 → 隔离/复跑/备注）；机器账本 `runs/20261103T093814-full/run.json`。
- 记录来源：39 条聚合记录由已定稿证据重建（数据源逐条写在记录 notes），5 条为本轮自然重跑（g2/j2/d1/e1/g4）；重建标记见 index.md。
- 说明：本 suite 是本票的「全量可审计」入口；单个 run 的具体证据请进各自目录看 run.json/index.md/shots/raw（与上面逐 run 账本同一契约）。

| # | runId | 场景 | 票 | 通道 | 判定 | 断言 p/f/k | 耗时 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `265-20261103T093814-p01` | a-single-package-main-chain | 265 | desktop | pass | 13/0/0 | 2m06s |
| 2 | `266-20261103T093814-p02` | b-batch-two-integrators | 266 | desktop | pass | 38/0/0 | 4m47s |
| 3 | `266-20261103T093814-p03` | c-pure-target-no-wiring | 266 | desktop | pass | 24/0/0 | 3m27s |
| 4 | `267-20261103T093814-p04` | d1-desktop-manager-update-success | 267 | desktop | pass | 17/0/0 | 3m33s |
| 5 | `267-20261103T093814-p05` | d2-desktop-manager-update-failure | 267 | desktop | pass | 18/0/0 | 2m36s |
| 6 | `267-20261103T093814-p06` | e1-cli-host-update-success | 267 | web | pass | 22/0/0 | 0m18s |
| 7 | `267-20261103T093814-p07` | e2-cli-host-update-failure | 267 | web | pass | 25/0/0 | 0m19s |
| 8 | `267-20261103T093814-p08` | e3-cli-host-install-timeout | 267 | web | pass | 22/0/0 | 0m17s |
| 9 | `267-20261103T093814-p09` | f1-third-party-desktop-probe | 267 | desktop | known-red | 8/0/2 | 1m22s |
| 10 | `268-20261103T093814-p10` | g1-desktop-manager-install-timeout | 268 | desktop | pass | 19/0/0 | 4m08s |
| 11 | `268-20261103T093814-p11` | g2-batch-queued-cancel | 268 | desktop | pass | 28/0/0 | 5m30s |
| 12 | `268-20261103T093814-p12` | g3-desktop-manager-failed-no-retry | 268 | desktop | pass | 19/0/0 | 4m54s |
| 13 | `268-20261103T093814-p13` | g4-desktop-manager-retry-single-success | 268 | desktop | pass | 25/0/0 | 6m05s |
| 14 | `268-20261103T093814-p14` | g5-desktop-manager-no-cancel-probe | 268 | desktop | known-red | 11/0/1 | 2m31s |
| 15 | `269-20261103T093814-p15` | e-batch-three-package-upgrade | 269 | desktop | pass | 16/0/0 | 2m47s |
| 16 | `269-20261103T093814-p16` | e-batch-partial-failure | 269 | desktop | pass | 17/0/0 | 4m56s |
| 17 | `269-20261103T093814-p17` | e-batch-resume-retry | 269 | desktop | pass | 22/0/0 | 5m18s |
| 18 | `270-20261103T093814-p18` | h1-queue-lock-concurrent | 270 | web | pass | 25/0/0 | 0m23s |
| 19 | `270-20261103T093814-p19` | h1b-queue-lock-simultaneous | 270 | web | pass | 25/0/0 | 0m23s |
| 20 | `270-20261103T093814-p20` | h2-queue-lock-stale-reclaim | 270 | web | pass | 20/0/0 | 0m17s |
| 21 | `271-20261103T093814-p21` | g6-hub-survives-self-replacement | 271 | web | pass | 32/0/0 | 0m56s |
| 22 | `271-20261103T093814-p22` | g7-hub-handoff-evidence | 271 | web | pass | 39/0/0 | 1m01s |
| 23 | `272-20261103T093814-p23` | i1-restart-enrollment-truth | 272 | desktop | pass | 19/0/0 | 3m44s |
| 24 | `272-20261103T093814-p24` | i2-unregistered-honesty | 272 | web | known-red | 24/0/1 | 0m22s |
| 25 | `272-20261103T093814-p25` | i3-topology-compensation | 272 | desktop | pass | 19/0/0 | 2m13s |
| 26 | `274-20261103T093814-p26` | k-single-panel-happy | 274 | web | pass | 38/0/0 | 0m49s |
| 27 | `274-20261103T093814-p27` | k-single-panel-failure | 274 | web | pass | 23/0/0 | 1m41s |
| 28 | `274-20261103T093814-p28` | k-batch-panel-states | 274 | web | pass | 38/0/0 | 4m04s |
| 29 | `274-20261103T093814-p29` | k-batch-resume | 274 | web | pass | 24/0/0 | 2m44s |
| 30 | `273-20261103T093814-p30` | j1-log-contract-coverage | 273 | web | pass | 28/0/0 | 0m41s |
| 31 | `273-20261103T093814-p31` | j2-noise-budget | 273 | web | pass | 16/0/0 | 5m28s |
| 32 | `273-20261103T093814-p32` | j3-namespace-whitelist | 273 | web | pass | 17/0/0 | 0m22s |
| 33 | `265-20261103T093814-r33` | a-single-package-main-chain（can-red） | 265 | desktop | fail | 11/2/0 | 3m28s |
| 34 | `266-20261103T093814-r34` | b-batch-two-integrators（can-red） | 266 | desktop | fail | 34/4/0 | 6m44s |
| 35 | `266-20261103T093814-r35` | c-pure-target-no-wiring（can-red） | 266 | desktop | fail | 22/2/0 | 3m30s |
| 36 | `267-20261103T093814-r36` | d1-desktop-manager-update-success（can-red） | 267 | desktop | fail | 15/2/0 | 3m29s |
| 37 | `267-20261103T093814-r37` | e1-cli-host-update-success（can-red） | 267 | web | fail | 21/1/0 | 0m13s |
| 38 | `268-20261103T093814-r38` | g4-desktop-manager-retry-single-success（can-red） | 268 | desktop | fail | 24/1/0 | 5m28s |
| 39 | `269-20261103T093814-r39` | e-batch-three-package-upgrade（can-red） | 269 | desktop | fail | 15/1/0 | 2m45s |
| 40 | `272-20261103T093814-r40` | i1-restart-enrollment-truth（can-red） | 272 | desktop | fail | 16/1/0 | 2m33s |
| 41 | `274-20261103T093814-r41` | k-single-panel-happy（can-red） | 274 | web | fail | 8/1/0 | 0m50s |
| 42 | `273-20261103T093814-r42` | j1-log-contract-coverage（can-red） | 273 | web | fail | 13/1/0 | 0m20s |
| 43 | `270-20261103T093814-r43` | h1-queue-lock-concurrent（can-red） | 270 | web | fail | 11/1/0 | 0m17s |
| 44 | `271-20261103T093814-r44` | g6-hub-survives-self-replacement（can-red） | 271 | web | fail | 23/1/0 | 1m05s |
| 284-20261103T185513 | f2-exit-one-third-party-success | dsh-web（等效第三方 Desktop） | pass | 0 | #284 补测 Wave A 组：出口一成功格正式证据（等效宿主 route=desktop-service，真 spawn 载体 CLI 装成 0.0.2） | 12 断言 / 3 图；等效宿主边界见 run.json equivalentHost 与 raw/equivalent-host-boundary-*；重启后 hostTag=host v0.0.2 |
| 284-20261103T185533 | f3-exit-one-third-party-failure | dsh-web（等效第三方 Desktop） | pass | 0 | #284 补测 Wave A 组：出口一失败格（registry tarball 404 → reason=nonzero-exit/无载体命令）+ 无终止能力超时格 | 33 断言 / 0 图；超时原话逐字「安装超时；宿主未提供终止能力，这次安装可能仍在后台继续」；runPlugin 采集 mode=hang-no-terminate 入 raw |
| 284-20261103T185608 | g8-desktop-manager-no-cancel-timeout | dsh-web（等效 desktop-manager） | pass | 0 | #284 补测 Wave A 组：无 cancelInstall 宿主超时诚实文案正式证据 | 19 断言 / 3 图；原话逐字「安装超时；宿主未提供取消能力，这次安装可能仍在后台继续」；delay 结束后 CLI 真装成 0.0.2，证明「可能仍在后台继续」为真 |
| 284-20261103T185635 | i4-pending-restart-panel-truth | dsh-web（等效集成方注入 runningVersion） | pass | 0 | #284 补测 Wave A 组：pending-restart 面板分支 + 未登记重启不加载正式证据 | 15 断言 / 4 图；blockedReason=pending-restart；摘在册重启 cardSeen=false；恢复登记重启 client+host v0.0.2 |
| 284-20261103T185708 | f2-exit-one-third-party-success | dsh-web（等效第三方 Desktop） | fail | 1 | #284 A 组 can-red：stale-variant（清单 0.0.2、内容 0.0.1）证明「重启后真换版」断言会红 | 预期失败；恰好 `33-assert` 红（hostTag 仍 v0.0.1），其余 11 条 pass；注入细节见 raw/16-can-red-fault-injection.json |
| 284-20261103T191200 | l1-same-process-two-plugins-concurrent | dsh-web | pass | 0 | #284 补测 Wave B 组：同进程两插件并发更新正式证据（A/B@0.0.1→0.0.2，串行/诚实忙碌、无假最新、各恰一条成功终态） | 17 断言 / 4 图；修前假「已是最新」见仓库外 284-20261103T151900；产品修复 a587dad/1dc4c77/b0e4565 |
| 284-20261103T191400 | l2-registry-unreachable | dsh-web | pass | 0 | #284 补测 Wave B 组：registry 不可达失败诚实 + 恢复后重启→检查→重试真装成正式证据 | 21 断言 / 6 图；杀本 run verdaccio 为外部注入，无产品测试钩子；失败格无 exec/无假成功/无自动重试 |
| 284-20261103T200100 | l3-permission-denied | dsh-web | pass | 0 | #284 补测 Wave B 组：Windows ACL 拒绝写真失败 + 撤 ACL 后重试装成正式证据 | 17 断言 / 6 图；icacls (AD,WD) 注入与恢复探针入 raw；pnpm ERR_PNPM_EPERM 原话 |
| 284-20261103T201400 | l4-page-close-mid-install | dsh-web | pass | 0 | #284 补测 Wave B 组：安装中关页面，宿主侧真相不被页面生命周期左右 | 13 断言 / 4 图；延迟代理 8s 拉窗；完成时刻晚于关页面；重开无重复作业 |
| 284-20261103T203000 | l5-host-killed-mid-install-recovery | dsh-web | pass | 0 | #284 补测 Wave B 组：安装中硬杀宿主后的诚实恢复 + 短阈值陈旧锁回收正式证据 | 20 断言 / 5 图；taskkill /T /F 本 run 宿主；L5a 诚实中断、L5b 恰一次成功 |
| 284-20261103T205500 | l2-registry-unreachable | dsh-web | fail | 1 | #284 B 组 can-red：私有已装副本注入谎话横幅，证明失败诚实断言真会红 | 预期失败；恰好 `25-assert` 红（其余 21 pass）；注入/恢复 sha 入 raw，两文件恢复 ok=true |
