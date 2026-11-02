# 真机证据索引 · h1b-queue-lock-simultaneous

- runId：270-20261103T004808
- 票：#270
- 宿主通道：dsh-web
- 开始/结束：2026-11-02T16:48:09.200Z / 2026-11-02T16:48:46.735Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:\dsh-plugin\_wt263\t6（分支 impl/263-t6，HEAD 025e50a2549a862bb1a197264529a02633f88031）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 80cbd584d05efe8dd1a14cfc01dcb9149a3bc29e0d8592cff33d8f5896436312
- SUT dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（208 个文件）
- 安装后 dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 80cbd584d05efe8d…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1 | **pass** |
| 08-assert | 隔离口径（两宿主同 home = 同一 USERPROFILE/.dsh） | 两个通道 B 宿主用同一个 USERPROFILE/osHomeDir 与同一个 homeDir（= osHomeDir/.dsh），profile 名不是 desktop（P1 探针证明 desktop 被官方桌面独占） | homeDir=D:\dsh-plugin\_wt263\runtime\t6-270\270-20261103T004808\os-home\.dsh；profileName=t6lock | osHomeDir=D:\dsh-plugin\_wt263\runtime\t6-270\270-20261103T004808\os-home；homeDir=D:\dsh-plugin\_wt263\runtime\t6-270\270-20261103T004808\os-home\.dsh；profileName=t6lock | **pass** |
| 10-assert | 建普通 profile（CLI 入口） | 用官方发行 CLI 在隔离 home 建普通 DSH 使用范围 t6lock；profileDir 决定 update-queue 的短哈希目录名 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t6-270\270-20261103T004808\os-home\.dsh\profiles\t6lock | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t6-270\270-20261103T004808\os-home\.dsh\profiles\t6lock | **pass** |
| 12-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 15-assert | 更新前基版在盘 | 隔离 profile 的 node_modules 里是场景声明的基版 0.0.1（更新前状态） | 磁盘版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 18-assert | 变体版发布（更新目标） | 按场景声明发布变体 dsh-plugin-update-fixture-a@0.0.2（UI/行为随版本变，重启后可自证） | 本地 registry 可见版本含 0.0.2 | registry 版本=["0.0.1","0.0.2"] | **pass** |
| 22-assert | 两个真机入口（两个独立宿主进程）同 profile | 两个独立的 DSH web 宿主进程用同一 USERPROFILE/.dsh 与同一 profile 名启动，各自暴露 HTTP 电话入口；它们解析到同一 profileDir，因此抢同一把 global.lock、写同一份 queue.json | 两代 pid/port 不同；homeDir/profileDir/queueDirectory 相同 | pidA=84008；portA=54419；pidB=30360；portB=58700；queueDir=D:\dsh-plugin\_wt263\runtime\t6-270\270-20261103T004808\os-home\.dsh\update-queue\ac7600c5c6530399ef16e20f | **pass** |
| 24-assert | 入口 a check 电话（发现新版） | 宿主里的电话入口 updateCheck 返回快照：运行版=0.0.1、最新版=0.0.2、可安装，并给候选凭证 checkId | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true；receipt.checkId 非空 | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true；checkId="705bf075-3c07-41a6-a1c2-68c4e51f670a" | **pass** |
| 26-assert | 入口 b check 电话（发现新版） | 宿主里的电话入口 updateCheck 返回快照：运行版=0.0.1、最新版=0.0.2、可安装，并给候选凭证 checkId | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true；receipt.checkId 非空 | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true；checkId="a36c7b83-0f6c-461c-8a01-03d157a90266" | **pass** |
| 30-assert | 两入口同时抢锁：恰一个受理 | 两个入口几乎同时（不 await 完成）发同一 target 同一版本安装；全局锁 + queue 公平门应当只放一个进来 | 恰一个入口 ok=true 且 job.state ∈ {installing, verifying}；另一个 ok=false（稳定拒绝） | A: ok=true；job.state=installing；error=null；http=200；durationMs=404；B: ok=false；job.state=null；error=update-busy；http=200；durationMs=49 | **pass** |
| 32-assert | 赢家安装到终态 | 轮询赢家宿主的 updateStatus，直到作业进入终态（进程未重启前应为 restart-required） | job.state ∈ {restart-required, completed} | job.state=completed；polls=5；timedOut=false | **pass** |
| 35-assert | 失败方重试（已装待重启）：诚实拒绝且不再装 | 同一 checkId/requestId 的失败意图在赢家装完（restart-required，进程未重启）后重试一次；作业状态门/锁门应稳定拒绝，且不产生第二次安装 | ok=false；error ∈ ["update-busy","check-expired"]（稳定拒绝，不重装）；exec 行数保持 1；台账仍 1 条 | retry: ok=false；job.state=null；error=check-expired；http=200；durationMs=28；exec 行数=1；台账文件数=1 | **pass** |
| 40-assert | 重启后：profile 能正常 boot 且运行版已是变体 | 装完后停掉两个入口宿主，再用同 home/profile 起一个干净宿主：能正常启动、运行版=0.0.2、夹具 buildTag 自证是变体构建（证明 profile 没被并发写坏） | runningVersion=0.0.2；buildTag=host v0.0.2 | runningVersion=0.0.2；buildTag=host v0.0.2 | **pass** |
| 42-assert | 重启后 fresh check：已是最新（失败方收敛） | 重启后的 fresh updateCheck 应报已装=0.0.2、最新=0.0.2、canInstall=false | canInstall=false；installedVersion=0.0.2；latestVersion=0.0.2 | canInstall=false；installedVersion=0.0.2；latestVersion=0.0.2 | **pass** |
| 44-assert | 重启后强行再装：诚实拒绝且不产生新安装 | 已是最新（canInstall=false、fresh check 没有候选凭证）时再发一次 updateInstall，产品应诚实拒绝（check-expired / installation-changed / update-busy 之一），不得再起安装 | ok=false；error ∈ ["installation-changed","check-expired","update-busy"]；exec 行数保持 1 | forced: ok=false；job.state=null；error=check-expired；http=200；durationMs=15；exec 行数=1；台账文件数=1 | **pass** |
| 51-assert | 恰一个真实安装 exec（route=cli-process） | 两个入口同时更新同一 target，日志里应只有一条 update.install.exec（第二个入口没有起 CLI 安装） | update.install.exec 行数=1；route=cli-process；ok=true；exitCode=0；durationMs>0 | exec 行数=1；{"start":1793638115678,"end":1793638117669,"ts":1793638117669,"durationMs":1991,"route":"cli-process","ok":true,"exitCode":0,"pluginId":"fxa-a","source":"fxa-a/2026-11-03.log","line":21} | **pass** |
| 53-assert | 安装窗口落在单一全局锁持有区间内 | 唯一一次真实安装的 exec 窗口 [ts-durationMs, ts] 完整落在一次 global.lock 持有区间内（任一时刻至多一个安装；两安装窗口不重叠） | 锁 id 数=1；持有区间数=1；exec 窗口被该区间包含（±1000ms 轮询误差） | 锁 id=["07b64a9f-75d3-41be-9a99-998e9af452cc"]；区间=[{"from":1793638115548,"to":1793638117714,"ids":["07b64a9f-75d3-41be-9a99-998e9af452cc"]}]；exec 窗口={"start":1793638115678,"end":1793638117669,"ts":1793638117669,"durationMs":1991,"route":"cli-process","ok":true,"exitCode":0,"pluginId":"fxa-a","source":"fxa-a/2026-11-03.log","line":21} | **pass** |
| 55-assert | 队列跃迁：有排入/有运行/有完成、无回收 | queue.json 的跃迁事件如实记录排队/运行/完成；并发格不应出现 reclaimed（没有陈旧锁） | queued≥1；running≥1；done≥1；reclaimed=0 | {"queued":2,"abandoned":2,"running":1,"done":1} | **pass** |
| 57-assert | 第二入口被稳定拒绝且可归因 | 未受理的入口回包 ok=false，且拒绝原因能从日志/回包归因（全局锁 busy-owner 异常、queue 公平门 gate-refused、或回包里的拒绝码之一） | ok=false；lock.anomaly busy-owner ≥1 或 update.install.fail(gate/gate-refused) ≥1 或 拒绝码 ∈ ["update-busy","recovery-required","installation-changed","check-expired"] | loser=b；error=update-busy；anomalies={"busy-owner":1}；gateRefused=3 | **pass** |
| 59-assert | profile 未损坏（after-install） | 更新后 profile 的 package.json 可解析、dependencies 与 node_modules 磁盘版本都是 0.0.2、bundles 仍含该包（无半写/无双装） | dependencies=0.0.2；磁盘版本=0.0.2；bundles 含 dsh-plugin-update-fixture-a | dependencies=0.0.2；磁盘版本=0.0.2；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；package.json 可解析=true | **pass** |
| 61-assert | 台账恰一条成功终态（after-install） | 每个 profile 一份 update 台账（<home>/updates/<pluginId>/<shortHash(profileDir)>/state.json）：恰一条 targetVersion=0.0.2 的成功终态，无重复成功、无丢单 | target 台账=1 条；state ∈ {completed, restart-required}；requestId=h1-a-1793638115501 | target 台账=1；成功终态=1；requestIds=["h1-a-1793638115501"]；全部台账=[{"file":"D:\\dsh-plugin\\_wt263\\runtime\\t6-270\\270-20261103T004808\\os-home\\.dsh\\updates\\fxa-a\\ac7600c5c6530399ef16e20f\\state.json","state":"completed","target":"0.0.2"}] | **pass** |
| 63-assert | 队列收尾：owner=null、无残留占位 | 赢家完成释放 owner，失败方重试（check-expired）时撤销了自己的 waiting 占位；收尾 queue.json 应只剩空队列 | owner=null；waiting=[] | owner=null；waiting 条数=0 | **pass** |
| 65-assert | 收尾（无宿主残留、端口释放） | 两个入口宿主（以及重启校验宿主）都已停止，进程不存在、端口已释放 | 所有宿主 pid 不再存活；所有宿主端口空闲 | 进程=[{"label":"cli-host-a","pid":84008,"aliveAfterStop":false},{"label":"cli-host-b","pid":30360,"aliveAfterStop":false},{"label":"cli-host-c","pid":42628,"aliveAfterStop":false}]；端口=[{"label":"cli-host-a-port","port":54419,"free":true},{"label":"cli-host-b-port","port":58700,"free":true},{"label":"cli-host-c-port","port":57521,"free":true}] | **pass** |

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
- [sut-installed-dist](raw\13-sut-installed-dist.json)
- [queue-lock-paths](raw\16-queue-lock-paths.json)
- [fixture-published-variant](raw\17-fixture-published-variant.json)
- [cli-host-launch-a](raw\19-cli-host-launch-a.json)
- [cli-host-launch-b](raw\20-cli-host-launch-b.json)
- [two-hosts-same-profile](raw\21-two-hosts-same-profile.json)
- [phone-update-check-a](raw\23-phone-update-check-a.json)
- [phone-update-check-b](raw\25-phone-update-check-b.json)
- [phone-update-install-b](raw\27-phone-update-install-b.json)
- [phone-update-install-a](raw\28-phone-update-install-a.json)
- [install-admission](raw\29-install-admission.json)
- [phone-status-terminal](raw\31-phone-status-terminal.json)
- [lock-absent-after-install](raw\33-lock-absent-after-install.json)
- [phone-retry-before-restart](raw\34-phone-retry-before-restart.json)
- [hosts-stopped-before-restart](raw\36-hosts-stopped-before-restart.json)
- [cli-host-launch-c](raw\37-cli-host-launch-c.json)
- [phone-status-after-restart](raw\38-phone-status-after-restart.json)
- [phone-build-tag-after-restart](raw\39-phone-build-tag-after-restart.json)
- [phone-check-after-restart](raw\41-phone-check-after-restart.json)
- [phone-install-after-restart](raw\43-phone-install-after-restart.json)
- [log-fxa-a-2026-11-03](raw\45-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\46-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\47-log-fxa-c-2026-11-03.json)
- [logs-after-install](raw\48-logs-after-install.json)
- [lock-queue-timeline](raw\49-lock-queue-timeline.json)
- [exec-windows](raw\50-exec-windows.json)
- [lock-window-containment](raw\52-lock-window-containment.json)
- [queue-transitions](raw\54-queue-transitions.json)
- [refusal-evidence](raw\56-refusal-evidence.json)
- [disk-after-after-install](raw\58-disk-after-after-install.json)
- [ledger-states](raw\60-ledger-states.json)
- [queue-final](raw\62-queue-final.json)
- [cleanup-facts](raw\64-cleanup-facts.json)

## 清理

- 进程 cli-host-a（pid 84008）：停止后存活=false
- 进程 cli-host-b（pid 30360）：停止后存活=false
- 进程 cli-host-c（pid 42628）：停止后存活=false
- 端口 cli-host-a-port（54419）：已释放=true
- 端口 cli-host-b-port（58700）：已释放=true
- 端口 cli-host-c-port（57521）：已释放=true
- 端口 registry（62679）：已释放=true
- 本地 registry：http://127.0.0.1:62679（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 两个宿主共享同一 home/profile 是为了共享同一把 global.lock；sessions/storages 等其它状态串台不在本组断言范围。
- 安装窗口用 update.install.exec 的 ts 与 durationMs 还原（[ts-durationMs, ts]），锁/队列用 10ms 轮询时间线判定，不用 UI。

## 备注

- 本地 registry：http://127.0.0.1:62679（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 两个宿主共享同一 home/profile 是为了共享同一把 global.lock；sessions/storages 等其它状态串台不在本组断言范围。
- 安装窗口用 update.install.exec 的 ts 与 durationMs 还原（[ts-durationMs, ts]），锁/队列用 10ms 轮询时间线判定，不用 UI。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
