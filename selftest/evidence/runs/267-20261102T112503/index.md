# 真机证据索引 · e3-cli-host-install-timeout

- runId：267-20261102T112503
- 票：#267
- 宿主通道：dsh-web
- 开始/结束：2026-11-02T03:25:03.810Z / 2026-11-02T03:25:23.337Z
- 总判定：**pass**（退出码 0）

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
| 07-assert | 出口三隔离口径（宿主 home = USERPROFILE/.dsh） | 通道 B 宿主与它 spawn 的 CLI 子进程落在同一个 run 内隔离 home：宿主用 DSH_HOME=homeDir，子进程 DSH_* 被剥离后按 USERPROFILE/.dsh 解析 | homeDir=D:\dsh-plugin\_wt263\runtime\t3-267\267-20261102T112503\os-home\.dsh；profileName=t3cli（≠ desktop） | osHomeDir=D:\dsh-plugin\_wt263\runtime\t3-267\267-20261102T112503\os-home；homeDir=D:\dsh-plugin\_wt263\runtime\t3-267\267-20261102T112503\os-home\.dsh；profileName=t3cli | **pass** |
| 09-assert | 通道 B 建普通 profile（CLI 入口） | 用官方发行里的 CLI（dsh --profile <名> --from-default-profile web --dump-config）在隔离 home 建一个普通 DSH 使用范围；范围名不是 desktop，路由才会落到 cli 出口 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t3-267\267-20261102T112503\os-home\.dsh\profiles\t3cli | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t3-267\267-20261102T112503\os-home\.dsh\profiles\t3cli | **pass** |
| 11-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1 | efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1（文件数 208 / 工作树 208） | **pass** |
| 14-assert | 出口三基版在盘（更新前状态） | 更新前隔离 profile 的 node_modules 里装的是场景声明的基版 0.0.1 | 磁盘版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 16-assert | 变体版发布（更新目标） | 按场景声明发布变体 dsh-plugin-update-fixture-a@0.0.2（UI/行为都随版本变，重启后能自证） | 本地 registry 可见版本含 0.0.2 | registry 版本=["0.0.1","0.0.2"] | **pass** |
| 18-assert | 超时格故障注入（延迟代理 + 4s 安装预算） | 在 verdaccio 前面挂延迟代理：只有 pnpm 的请求被挂起 15000ms（产品自己的 check 不受影响）；宿主通过 DSH_SELFTEST_REGISTRY 指向代理、通过 DSH_SELFTEST_INSTALL_TIMEOUT_MS 把安装预算降到 4000ms | 代理端口=54969；upstream=http://127.0.0.1:49544 | 代理 baseUrl=http://127.0.0.1:54969；delayMs=15000 | **pass** |
| 20-assert | 通道 B 宿主启动（普通 dsh web） | 用官方发行 CLI 起一个普通 DSH web 宿主（--profile t3cli --port 0 --no-open），等它打印 web 地址并 HTTP 探活；这是「普通 DSH 宿主」的真机形态 | 打印 http://127.0.0.1:<port>/?token=… 且探活 status<400 | url=http://127.0.0.1:58427/?token=udgIg1_nStbuHLNu_DWQes3gnCEToMnhmk93Rlr1ERE；bootMs=2276 | **pass** |
| 22-assert | 出口三 check 电话（发现新版） | 夹具电话 updateCheck 从宿主拿到快照：运行版=0.0.1、最新版=0.0.2、可安装 | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true | {"runningVersion":"0.0.1","installed":true,"installedVersion":"0.0.1","latestVersion":"0.0.2","canInstall":true,"blockedReason":null,"job":null,"identity":"update","registered":true} | **pass** |
| 23-assert | check 凭证（checkId） | 安装电话必须带上 check 回包给的候选凭证 checkId（不自己编） | receipt.checkId 非空 | checkId="6bd8610a-acfa-4cff-8c64-b276bbd32859"；receipt={"checkId":"6bd8610a-acfa-4cff-8c64-b276bbd32859","checkedAt":1793589917854,"expiresAt":1793590517854} | **pass** |
| 25-assert | 安装电话受理（异步：电话先回、exec 后完） | 安装电话只把任务接进来就回 ok:true（job.state=installing），真正的安装由宿主 spawn 的 CLI 子进程异步执行；所以完成判据必须用磁盘与日志，不能拿电话回包当完成 | ok=true；job.state∈{installing,verifying}；回包时长远小于真实安装耗时 | ok=true；job.state=installing；回包时长=116ms | **pass** |
| 32-assert | 出口三路由判定（hostKind=cli / exec route=cli-process） | 产品日志证明本宿主走的是「普通 DSH 宿主 spawn CLI 子进程」出口：update.wire.ready hostKind=cli，update.install.exec route=cli-process | hostKind=cli；exec.route=cli-process | hostKind=["cli","cli","cli"]；exec.route="cli-process" | **pass** |
| 33-assert | 出口三超时：作业失败 + 超时原话 | 安装预算 4000ms 到点后产品按超时定局，人话（job.message）给超时原话；允许宿主未提供终止能力时的 no-terminate 变体 | job.state=failed；message 含「安装超时，已终止子进程」或「安装超时；宿主未提供终止能力，这次安装可能仍在后台继续」 | job.state=failed；job.message="install-failed: 安装超时，已终止子进程" | **pass** |
| 34-assert | 出口三超时：exec durationMs 落在预算+宽限内（配置透传生效） | update.install.exec 的 durationMs 证明宿主真的用了 4s 预算（产品默认预算远大于它）：到点终止子进程，再给最多 3s 宽限 | durationMs∈[4000, 12000) | durationMs=4111；fields={"route":"cli-process","ok":false,"exitCode":1,"durationMs":4111,"pluginId":"fxa-a","traceId":"cd4c2f12ec7b2e0d","spanId":"da14e1cf","seq":4} | **pass** |
| 35-assert | 出口三超时：install.fail（reason=timeout / code=install-failed） | 失败事件按契约落 reason=timeout、code=install-failed | reason=timeout；code=install-failed | {"stage":"exec","reason":"timeout","code":"install-failed","hostCodeHash":"none","check":"none","exitCode":1,"observedVersion":null,"intentHash":"2416730b","traceId":"cd4c2f12ec7b2e0d","spanId":"da14e1cf","seq":6} | **pass** |
| 36-assert | 出口三超时：磁盘不变（无虚假成功） | 超时终止后 profile 里的包仍是基版 0.0.1 | 磁盘版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 38-assert | 出口三超时：故障注入真的挂住了 pnpm（原始请求日志） | 延迟代理请求日志证明：pnpm 的 registry 请求被挂起（delayMs=15000），而产品自己的 check 请求没被延迟（所以 check 能正常发现新版） | 被延迟的 pnpm 请求 ≥1；未被延迟、命中包名的 check 请求 ≥1 | 总请求=3；被延迟的 pnpm 请求=1；未延迟的包名请求=2 | **pass** |
| 39-assert | 出口三超时：运行代码没变（同宿主自证） | 超时后同一个宿主进程里的夹具 host half 仍报基版构建标记（磁盘没换、进程也没重载） | buildTag=host v0.0.1 | buildTag="host v0.0.1" | **pass** |
| 41-assert | 出口三台账（作业状态） | 更新器落盘的作业状态记录本次更新：目标版本 0.0.2、前版本 0.0.1、状态=failed | 存在 state.json 且 targetVersion=0.0.2、previousVersion=0.0.1、state∈{failed} | {"id":"f07f27d0-0319-4fc7-a8b8-efab3275dd38","state":"failed","targetVersion":"0.0.2","message":"install-failed: 安装超时，已终止子进程","requestId":"t3e-timeout-1793589917860","previousVersion":"0.0.1"} | **pass** |
| 42-assert | 收尾（进程与端口） | 所有通道 B 宿主进程都已停止、延迟代理端口已释放（真机一次只起一个宿主；不留孤儿进程） | host pids 全部不在；代理端口空闲 | hostPids=[{"label":"cli-host-main","pid":17168}]；仍存活=[]；代理端口=54969，空闲=true | **pass** |

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
- [fixture-published-variant](raw\15-fixture-published-variant.json)
- [delaying-proxy-launch](raw\17-delaying-proxy-launch.json)
- [cli-host-launch](raw\19-cli-host-launch.json)
- [phone-update-check](raw\21-phone-update-check.json)
- [phone-update-install](raw\24-phone-update-install.json)
- [phone-status-terminal](raw\26-phone-status-terminal.json)
- [phone-build-tag-after-timeout](raw\27-phone-build-tag-after-timeout.json)
- [logs-before-stop](raw\28-logs-before-stop.json)
- [log-fxa-a-2026-11-02](raw\29-log-fxa-a-2026-11-02.json)
- [log-fxa-b-2026-11-02](raw\30-log-fxa-b-2026-11-02.json)
- [log-fxa-c-2026-11-02](raw\31-log-fxa-c-2026-11-02.json)
- [delaying-proxy-requests](raw\37-delaying-proxy-requests.json)
- [ledger-states](raw\40-ledger-states.json)

## 清理

- 进程 cli-host-main（pid 17168）：停止后存活=false
- 进程 cli-host-main（pid 17168）：停止后存活=false
- 端口 delaying-proxy（54969）：已释放=true
- 端口 registry（49544）：已释放=true
- 本地 registry：http://127.0.0.1:49544（仓库外 verdaccio，run 内独立 storage）

## 备注

- 本地 registry：http://127.0.0.1:49544（仓库外 verdaccio，run 内独立 storage）
- 通道 B 是无窗口 CLI 宿主：本场景的 UI 证据是 DOM/pageText 原文（电话回包、页面状态、产品日志摘录），没有 PNG 截图；官方桌面的窗口截图证据由 d1/d2（出口二）与 T10 UI 组承担。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
