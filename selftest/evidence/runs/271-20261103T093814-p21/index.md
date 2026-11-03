# 真机证据索引 · g6-hub-survives-self-replacement

- runId：271-20261103T093814-p21
- 票：#271
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T01:38:51.536Z / 2026-11-03T01:39:47.960Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:/dsh-plugin/_wt263/t11（分支 impl/263-t11，HEAD bd39b57baa10f3c9f128dfd05f66b286d8828045）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c24b0e67a15a3b8dd96584b24d8a68afbaa273c1681d201efc
- SUT dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（208 个文件）
- 安装后 dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c2…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1, dsh-plugin-update-fixture-b@0.0.1, dsh-plugin-update-fixture-c@0.0.1 | **pass** |
| 08-assert | 隔离口径（仓库外 home/profile） | osHomeDir/homeDir/profile 名均落在 run 目录内，两代宿主共用同一 profileDir | homeDir=D:\dsh-plugin\_wt263\runtime\t11-275\271-20261103T093814-p21\os-home\.dsh；profile=t7hub | homeDir=D:\dsh-plugin\_wt263\runtime\t11-275\271-20261103T093814-p21\os-home\.dsh；profileDir=D:\dsh-plugin\_wt263\runtime\t11-275\271-20261103T093814-p21\os-home\.dsh\profiles\t7hub | **pass** |
| 10-assert | 建普通 profile（CLI 入口） | createWebProfileInHome 建通道 B 的普通 profile（非 desktop） | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t11-275\271-20261103T093814-p21\os-home\.dsh\profiles\t7hub | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t11-275\271-20261103T093814-p21\os-home\.dsh\profiles\t7hub | **pass** |
| 12-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | 干净 profile 装基版（c） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-c@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-c；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b, dsh-plugin-update-fixture-c]；磁盘版本=0.0.1；exit=0 | **pass** |
| 16-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 18-assert | 更新前基版在盘 | A/B/C 三包 @0.0.1 已装进 profile，SUT 钉版与工作树 dist 一致 | 三包磁盘版本=0.0.1 | a=0.0.1，b=0.0.1，c=0.0.1 | **pass** |
| 20-assert | 变体 0.0.2 已发布 | 批量三包的 0.0.2 变体发布到仓库外 verdaccio | A/B/C 均有 0.0.2，A 变体含批量坞/新版 UI | A=0.0.2；baseline=0.0.1 | **pass** |
| 22-assert | 宿主安装预算=4s（锁陈旧阈值） | DSH_SELFTEST_INSTALL_TIMEOUT_MS 透传给夹具 host half → deps.config.installTimeoutMs | installTimeoutMs=4000 | DSH_SELFTEST_INSTALL_TIMEOUT_MS=4000 | **pass** |
| 24-assert | 中枢/批量目录定位 | 按 profileDir 短哈希复算队列目录，并与盘上实际目录对照（首次安装前目录可能尚未创建） | 盘上目录数 ≤1，且存在时=39e4a2cc3444907c9a17c7fc | 盘上=[]；复算=39e4a2cc3444907c9a17c7fc | **pass** |
| 26-assert | 第一代宿主启动（通道 B） | startCliHost 起 DSH web 宿主（同 USERPROFILE/home/profile） | boot 成功、HTTP 电话入口可用、pid>0 | pid=67124，port=51834，bootMs=1903 | **pass** |
| 28-assert | 第一代宿主批量面板可读 | batchStatus 电话（批量面板数据源） | ok=true；三包会话可读或空 | ok=true；error=null | **pass** |
| 30-assert | 批量检查电话受理 | fxa.batchCheck 建/读批量会话（A 自键排在第一位） | ok=true；三行 key=[a,b,c]（batchCheck 阶段的 session 骨架可能为空，以 rows 顺序为准） | ok=true；rowKeys=["a","b","c"]；rows=3 | **pass** |
| 32-assert | A 自身检查更新（批量前） | A 的 updateCheck 看到 0.0.2 可更新 | canInstall=true；installedVersion=0.0.1；latestVersion=0.0.2 | canInstall=true；installedVersion=0.0.1；latestVersion=0.0.2 | **pass** |
| 34-assert | 批量安装电话已发出（不等回包） | host1 发 fxa.batchInstall，场景并行观测 batch.json/lease | 电话已发出，批量会话开始推进（A 先换） | at=1793669948352 | **pass** |
| 36-assert | 换手窗口：A 已 done、B/C 未终态 | 轮询 batch.json 捕获第一代推进到「A 已换、B/C 未终态」的窗口 | phase(a)='done' 且 phase(b) 非终态 | phases={"a":"done","b":"installing","c":"ready"}；planSessionId=mw00rxs9-746kzyep5y | **pass** |
| 38-assert | 换手前中枢租约由第一代宿主持有 | hub/lease.json 的 pid/属主与 enhancement | lease.pid=67124（第一代宿主进程） | lease={"pid":67124,"generation":1,"driverId":"dsh-hub:67124:atfc8orz50"} | **pass** |
| 40-assert | 第一代宿主已停（换手注入） | 关掉第一代宿主进程（未等待批量收尾），中枢执行者消失 | pid=67124 不再存活 | alive=false | **pass** |
| 42-assert | 第二代宿主启动（通道 B） | startCliHost 起 DSH web 宿主（同 USERPROFILE/home/profile） | boot 成功、HTTP 电话入口可用、pid>0 | pid=53844，port=57822，bootMs=2485 | **pass** |
| 49-assert | 换手后 batch 三行终态全 done、failed=0 | 不驱动安装，只轮询 batch.json 等第二代把 B/C 推完 | phases={a:'done',b:'done',c:'done'}；无 failed | phases={"a":"done","b":"done","c":"done"}；elapsedMs=32714 | **pass** |
| 50-assert | B/C 在第二代宿主启动后自动续跑（无人工） | B/C 的 update.install.exec ts vs 第二代 host.start ts；换手后场景只发只读查询 | B/C 各有 1 条 exec（route=cli-process、ok=true、exitCode=0），且 ts > 第二代 host.start | host2StartTs=1793669953017；B=[{"ts":1793669984660,"pluginId":"fxa-b","route":"cli-process","ok":true,"exitCode":0,"durationMs":1000}]；C=[{"ts":1793669985746,"pluginId":"fxa-c","route":"cli-process","ok":true,"exitCode":0,"durationMs":1022}]；后置执行数=2；host2 启动后场景驱动电话=[] | **pass** |
| 51-assert | 无安装期硬失败（exec 阶段失败=0） | update.install.fail 里 stage=exec 的行（安装执行失败）必须为 0；gate-refused 只是队列占位恢复的等待噪声 | execFailures=0 | execFailures=0；gateRefused=31（≤30s 的 #217 陈旧占位恢复噪声，见 notes） | **pass** |
| 52-assert | 中枢方案在换手后仍在盘、被第二代接管（同 sessionId） | hub/plans/fxa.json 与 batch.json 的 sessionId 一致，plan 未被换手清掉 | plan 存在且 plan.sessionId=batch.id | plan=D:\dsh-plugin\_wt263\runtime\t11-275\271-20261103T093814-p21\os-home\.dsh\update-queue\39e4a2cc3444907c9a17c7fc\hub\plans\fxa.json；planSessionId=mw00rxs9-746kzyep5y；batchId=mw00rxs9-746kzyep5y；runStart=[{"ts":1793669948363,"trigger":"entry","resumed":false,"total":3},{"ts":1793669953367,"trigger":"resume","resumed":true,"total":3}] | **pass** |
| 54-assert | 第二代宿主上的批量面板三行 done | batchStatus 回包（面板数据源）与磁盘 batch.json 一致 | 三行 phase=done；targetVersion=0.0.2 | ok=true；rows=[{"key":"a","phase":"done","targetVersion":"0.0.2"},{"key":"b","phase":"done","targetVersion":"0.0.2"},{"key":"c","phase":"done","targetVersion":"0.0.2"}]；sessionEntries=[{"key":"a","phase":"done"},{"key":"b","phase":"done"},{"key":"c","phase":"done"}] | **pass** |
| 56-assert | 中枢状态与批量台账一致（finished done3 failed0） | updateHubStatus 回包：state/progress/activeInstall | state='finished'；progress.done=3、failed=0；activeInstall=null | state=finished；progress={"total":3,"done":3,"failed":0,"skipped":0,"current":0,"pending":0,"finished":true}；activeInstall=null | **pass** |
| 58-assert | A 自身换手后状态正确（已是最新） | host2 上 A 的 updateCheck | installedVersion/runningVersion=0.0.2；canInstall=false | installedVersion=0.0.2；runningVersion=0.0.2；canInstall=false | **pass** |
| 59-assert | 磁盘三包一致 0.0.2（profile 未损坏、无双装） | profile package.json dependencies 与 node_modules 实际版本 | A/B/C dependencies+node_modules 都=0.0.2 | dependencies={"a":"0.0.2","b":"0.0.2","c":"0.0.2"}；node_modules={"a":"0.0.2","b":"0.0.2","c":"0.0.2"} | **pass** |
| 60-assert | 台账三包各恰一条成功终态（无重复/丢单） | <home>/updates/<pluginId>/<hash>/state.json | A/B/C 各 1 条：target=0.0.2、previous=0.0.1、state∈{completed,restart-required} | {"fxa-a":[{"state":"completed","targetVersion":"0.0.2","previousVersion":"0.0.1"}],"fxa-b":[{"state":"completed","targetVersion":"0.0.2","previousVersion":"0.0.1"}],"fxa-c":[{"state":"completed","targetVersion":"0.0.2","previousVersion":"0.0.1"}]} | **pass** |
| 62-assert | 中枢租约换手：单一属主，从第一代交到第二代 | 轮询 hub/lease.json 的 pid/generation 序列 | 先见到第一代 pid=67124，再见到第二代 pid=53844 | leasePids=[67124,53844]；afterBatch=null | **pass** |
| 70-assert | 收尾：宿主进程与端口无残留 | 关闭所有宿主后核实 pid 不在、端口空闲 | remainingPids=[]、所有端口 free=true | remainingPids=[]；portChecks=[{"label":"host1","port":51834,"free":true},{"label":"host2","port":57822,"free":true}] | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [isolation-facts](raw\07-isolation-facts.json)
- [profile-create](raw\09-profile-create.json)
- [install-baseline](raw\11-install-baseline.json)
- [sut-installed-dist](raw\15-sut-installed-dist.json)
- [baseline-installed](raw\17-baseline-installed.json)
- [fixture-published-variant](raw\19-fixture-published-variant.json)
- [host-env](raw\21-host-env.json)
- [hub-paths](raw\23-hub-paths.json)
- [cli-host-launch-host1](raw\25-cli-host-launch-host1.json)
- [panel-batch-status-initial](raw\27-panel-batch-status-initial.json)
- [phone-batch-check](raw\29-phone-batch-check.json)
- [phone-a-update-check-before-batch](raw\31-phone-a-update-check-before-batch.json)
- [phone-batch-install-fire](raw\33-phone-batch-install-fire.json)
- [state-at-kill](raw\35-state-at-kill.json)
- [hub-lease-at-kill](raw\37-hub-lease-at-kill.json)
- [host1-stopped](raw\39-host1-stopped.json)
- [cli-host-launch-host2](raw\41-cli-host-launch-host2.json)
- [host2-start-window](raw\43-host2-start-window.json)
- [batch-after-handoff](raw\44-batch-after-handoff.json)
- [install-promise-outcome](raw\45-install-promise-outcome.json)
- [log-timeline](raw\46-log-timeline.json)
- [disk-after-handoff](raw\47-disk-after-handoff.json)
- [ledger-states](raw\48-ledger-states.json)
- [panel-batch-status-final](raw\53-panel-batch-status-final.json)
- [panel-hub-status-final](raw\55-panel-hub-status-final.json)
- [phone-a-update-check-after-handoff](raw\57-phone-a-update-check-after-handoff.json)
- [hub-lease-timeline](raw\61-hub-lease-timeline.json)
- [log-fxa-a-2026-11-03](raw\63-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\64-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\65-log-fxa-c-2026-11-03.json)
- [log-fxb-b-2026-11-03](raw\66-log-fxb-b-2026-11-03.json)
- [log-fxb-c-2026-11-03](raw\67-log-fxb-c-2026-11-03.json)
- [logs-final](raw\68-logs-final.json)
- [cleanup-verify](raw\69-cleanup-verify.json)

## 清理

- 进程 cli-host-host1（pid 67124）：停止后存活=false
- 进程 cli-host-host2（pid 53844）：停止后存活=false
- 端口 cli-host-host1-port（51834）：已释放=true
- 端口 cli-host-host2-port（57822）：已释放=true
- 端口 registry（55189）：已释放=true
- 本地 registry：http://127.0.0.1:55189（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 换手注入：web 通道没有「应用自重启」，用「杀第一代宿主 + 同 home/profile 起第二代」注入换手，等价于桌面 relaunch 后新 fiber 接管中枢；差别（整进程退出 vs 应用内重启）写进研究笔记。
- 面板恢复口径：web 通道无窗口，g2 用面板电话（batchStatus/updateHubStatus/updateCheck）在「关宿主→重开」后取证，并用宿主页面 HTTP 200 辅助；不冒充桌面真 UI 截图。
- 为什么灌 installTimeoutMs=4000：第一代被强杀会留下陈旧 global.lock/install.lock，第二代的锁回收本身依赖该阈值；不压小则换手要等默认 15min，测不到「无需人工续跑」。

## 维护者 profile 未污染

- 目录：C:/Users/辰辰洋洋/.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:55189（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 换手注入：web 通道没有「应用自重启」，用「杀第一代宿主 + 同 home/profile 起第二代」注入换手，等价于桌面 relaunch 后新 fiber 接管中枢；差别（整进程退出 vs 应用内重启）写进研究笔记。
- 面板恢复口径：web 通道无窗口，g2 用面板电话（batchStatus/updateHubStatus/updateCheck）在「关宿主→重开」后取证，并用宿主页面 HTTP 200 辅助；不冒充桌面真 UI 截图。
- 为什么灌 installTimeoutMs=4000：第一代被强杀会留下陈旧 global.lock/install.lock，第二代的锁回收本身依赖该阈值；不压小则换手要等默认 15min，测不到「无需人工续跑」。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
