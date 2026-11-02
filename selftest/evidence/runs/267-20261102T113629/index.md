# 真机证据索引 · e1-cli-host-update-success

- runId：267-20261102T113629
- 票：#267
- 宿主通道：dsh-web
- 开始/结束：2026-11-02T03:36:29.233Z / 2026-11-02T03:36:46.169Z
- 总判定：**fail**（退出码 1）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:/dsh-plugin/_wt263/t3（分支 impl/263-t3，HEAD cc140e7a90b552ae1dd59c06f44c9092204edf7f）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 d1ed0c40042770cc90f942210464e5d52dad077947354ab8c42ff0f926f4298b
- SUT dist 指纹：efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1（208 个文件）
- 安装后 dist 指纹：efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 03-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 d1ed0c40042770cc…，dist 208 文件 | **pass** |
| 05-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1 | **pass** |
| 07-assert | 出口三隔离口径（宿主 home = USERPROFILE/.dsh） | 通道 B 宿主与它 spawn 的 CLI 子进程落在同一个 run 内隔离 home：宿主用 DSH_HOME=homeDir，子进程 DSH_* 被剥离后按 USERPROFILE/.dsh 解析 | homeDir=D:\dsh-plugin\_wt263\runtime\t3-267\267-20261102T113629\os-home\.dsh；profileName=t3cli（≠ desktop） | osHomeDir=D:\dsh-plugin\_wt263\runtime\t3-267\267-20261102T113629\os-home；homeDir=D:\dsh-plugin\_wt263\runtime\t3-267\267-20261102T113629\os-home\.dsh；profileName=t3cli | **pass** |
| 09-assert | 通道 B 建普通 profile（CLI 入口） | 用官方发行里的 CLI（dsh --profile <名> --from-default-profile web --dump-config）在隔离 home 建一个普通 DSH 使用范围；范围名不是 desktop，路由才会落到 cli 出口 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t3-267\267-20261102T113629\os-home\.dsh\profiles\t3cli | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t3-267\267-20261102T113629\os-home\.dsh\profiles\t3cli | **pass** |
| 11-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1 | efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1（文件数 208 / 工作树 208） | **pass** |
| 14-assert | 出口三基版在盘（更新前状态） | 更新前隔离 profile 的 node_modules 里装的是场景声明的基版 0.0.1 | 磁盘版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 17-assert | 变体版发布（更新目标） | 按场景声明发布变体 dsh-plugin-update-fixture-a@0.0.2（UI/行为都随版本变，重启后能自证） | 本地 registry 可见版本含 0.0.2 | registry 版本=["0.0.1","0.0.2"] | **pass** |
| 19-assert | 通道 B 宿主启动（普通 dsh web） | 用官方发行 CLI 起一个普通 DSH web 宿主（--profile t3cli --port 0 --no-open），等它打印 web 地址并 HTTP 探活；这是「普通 DSH 宿主」的真机形态 | 打印 http://127.0.0.1:<port>/?token=… 且探活 status<400 | url=http://127.0.0.1:62818/?token=8rAo_-qavBL6jH3ZbnzeH6c5J9DBdIC8I1HK_m-3V8Q；bootMs=1905 | **pass** |
| 21-assert | 出口三 check 电话（发现新版） | 夹具电话 updateCheck 从宿主拿到快照：运行版=0.0.1、最新版=0.0.2、可安装 | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true | {"runningVersion":"0.0.1","installed":true,"installedVersion":"0.0.1","latestVersion":"0.0.2","canInstall":true,"blockedReason":null,"job":null,"identity":"update","registered":true} | **pass** |
| 22-assert | check 凭证（checkId） | 安装电话必须带上 check 回包给的候选凭证 checkId（不自己编） | receipt.checkId 非空 | checkId="1c1cc83c-6bc0-43f0-9dc5-17d9bf1fe588"；receipt={"checkId":"1c1cc83c-6bc0-43f0-9dc5-17d9bf1fe588","checkedAt":1793590600797,"expiresAt":1793591200797} | **pass** |
| 24-assert | 安装电话受理（异步：电话先回、exec 后完） | 安装电话只把任务接进来就回 ok:true（job.state=installing），真正的安装由宿主 spawn 的 CLI 子进程异步执行；所以完成判据必须用磁盘与日志，不能拿电话回包当完成 | ok=true；job.state∈{installing,verifying}；回包时长远小于真实安装耗时 | ok=true；job.state=installing；回包时长=43ms | **pass** |
| 30-assert | 出口三路由判定（hostKind=cli / exec route=cli-process） | 产品日志证明本宿主走的是「普通 DSH 宿主 spawn CLI 子进程」出口：update.wire.ready hostKind=cli，update.install.exec route=cli-process | hostKind=cli；exec.route=cli-process | hostKind=["cli","cli","cli"]；exec.route="cli-process" | **pass** |
| 31-assert | 出口三成功：作业终态 | 安装任务以成功终态收场（restart-required=磁盘已更新、等重启；completed=已生效），且没有失败 message | job.state∈{restart-required,completed}；job.message 为空 | job.state=completed；job.message=""；轮询=3 次/2033ms | **pass** |
| 33-assert | 出口三成功：磁盘真的换了版（无虚假成功） | 完成判据落在磁盘：profile 的 dependencies 与 node_modules 包版本都变成 0.0.2 | diskVersion=0.0.2；dependencies=0.0.2 | diskVersion=0.0.2；dependencies=0.0.2 | **pass** |
| 34-assert | 出口三成功：exec 日志（route/ok/exitCode/durationMs） | update.install.exec 记录载体 CLI 子进程以 0 收场；durationMs 是真实安装耗时，电话回包时长应远小于它 | ok=true；exitCode=0；durationMs>0 | {"route":"cli-process","ok":true,"exitCode":0,"durationMs":1103,"pluginId":"fxa-a","traceId":"2fe5ab3c8042626d","spanId":"3eef328d","seq":4} | **pass** |
| 35-assert | 电话先回、exec 后完（异步语义） | 安装电话回包时长与真实安装耗时对比：电话不等安装完成 | 电话回包时长 < exec durationMs | 电话=43ms；exec=1103ms | **pass** |
| 36-assert | 出口三成功：无安装失败事件 | 成功格的产品日志里不许出现 update.install.fail | update.install.fail 行数=0 | update.install.fail 行数=0 | **pass** |
| 37-assert | 出口三成功：verify 行（装上的版本） | update.install.verify 记录装完后的版本核对：installedVersion=0.0.2 | result∈{restart-required,completed}；installedVersion=0.0.2 | {"result":"restart-required","installedVersion":"0.0.2","pendingRestart":true,"traceId":"2fe5ab3c8042626d","spanId":"3eef328d","seq":6} | **pass** |
| 40-assert | 出口三成功：重启后 host 代码真的换了版 | 重启宿主后夹具 host half 的构建标记电话回报 host v0.0.1（标记来自新装包的代码，不是旧进程内存），运行版也变成 0.0.2 | buildTag=host v0.0.2；runningVersion=0.0.2 | buildTag="host v0.0.1"；runningVersion=0.0.2 | **fail** |
| 42-assert | 出口三台账（作业状态） | 更新器落盘的作业状态记录本次更新：目标版本 0.0.2、前版本 0.0.1、状态=completed/restart-required | 存在 state.json 且 targetVersion=0.0.2、previousVersion=0.0.1、state∈{completed,restart-required} | {"requestId":"t3e-can-red-1793590600803","message":null,"id":"0f3898d7-517d-40f0-a2ac-dcd8dbf6c20c","state":"completed","targetVersion":"0.0.2","previousVersion":"0.0.1"} | **pass** |
| 43-assert | 收尾（进程与端口） | 所有通道 B 宿主进程都已停止、延迟代理端口已释放（真机一次只起一个宿主；不留孤儿进程） | host pids 全部不在；代理端口空闲 | hostPids=[{"label":"cli-host-main","pid":44936},{"label":"cli-host-restart","pid":10580}]；仍存活=[]；代理端口=null，空闲=n/a | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [fixture-published-baseline](raw\04-fixture-published-baseline.json)
- [isolation-facts](raw\06-isolation-facts.json)
- [profile-create](raw\08-profile-create.json)
- [install-baseline](raw\10-install-baseline.json)
- [sut-installed-dist](raw\12-sut-installed-dist.json)
- [can-red-fault-injection](raw\15-can-red-fault-injection.json)
- [fixture-published-variant](raw\16-fixture-published-variant.json)
- [cli-host-launch](raw\18-cli-host-launch.json)
- [phone-update-check](raw\20-phone-update-check.json)
- [phone-update-install](raw\23-phone-update-install.json)
- [phone-status-terminal](raw\25-phone-status-terminal.json)
- [logs-before-stop](raw\26-logs-before-stop.json)
- [log-fxa-a-2026-11-02](raw\27-log-fxa-a-2026-11-02.json)
- [log-fxa-b-2026-11-02](raw\28-log-fxa-b-2026-11-02.json)
- [log-fxa-c-2026-11-02](raw\29-log-fxa-c-2026-11-02.json)
- [disk-after-success](raw\32-disk-after-success.json)
- [phone-build-tag-after-restart](raw\38-phone-build-tag-after-restart.json)
- [phone-status-after-restart](raw\39-phone-status-after-restart.json)
- [ledger-states](raw\41-ledger-states.json)

## 清理

- 进程 cli-host-main（pid 44936）：停止后存活=false
- 进程 cli-host-restart（pid 10580）：停止后存活=false
- 端口 registry（51085）：已释放=true
- 本地 registry：http://127.0.0.1:51085（仓库外 verdaccio，run 内独立 storage）
- can-red 故障注入：stale-variant——变体版清单是 0.0.2，构建内容仍是 0.0.1；预期 buildTag 断言真红（其余成功面照常）

## 备注

- 本地 registry：http://127.0.0.1:51085（仓库外 verdaccio，run 内独立 storage）
- can-red 故障注入：stale-variant——变体版清单是 0.0.2，构建内容仍是 0.0.1；预期 buildTag 断言真红（其余成功面照常）

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
