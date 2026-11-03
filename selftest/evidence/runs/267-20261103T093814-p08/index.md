# 真机证据索引 · e3-cli-host-install-timeout

- runId：267-20261103T093814-p08
- 票：#267
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T01:38:15.402Z / 2026-11-03T01:38:32.528Z
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
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1 | **pass** |
| 08-assert | 出口三隔离口径（宿主 home = USERPROFILE/.dsh） | 通道 B 宿主与它 spawn 的 CLI 子进程落在同一个 run 内隔离 home：宿主用 DSH_HOME=homeDir，子进程 DSH_* 被剥离后按 USERPROFILE/.dsh 解析 | homeDir=D:\dsh-plugin\_wt263\runtime\t11-275\267-20261103T093814-p08\os-home\.dsh；profileName=t3cli（≠ desktop） | osHomeDir=D:\dsh-plugin\_wt263\runtime\t11-275\267-20261103T093814-p08\os-home；homeDir=D:\dsh-plugin\_wt263\runtime\t11-275\267-20261103T093814-p08\os-home\.dsh；profileName=t3cli | **pass** |
| 10-assert | 通道 B 建普通 profile（CLI 入口） | 用官方发行里的 CLI（dsh --profile <名> --from-default-profile web --dump-config）在隔离 home 建一个普通 DSH 使用范围；范围名不是 desktop，路由才会落到 cli 出口 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t11-275\267-20261103T093814-p08\os-home\.dsh\profiles\t3cli | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t11-275\267-20261103T093814-p08\os-home\.dsh\profiles\t3cli | **pass** |
| 12-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 15-assert | 出口三基版在盘（更新前状态） | 更新前隔离 profile 的 node_modules 里装的是场景声明的基版 0.0.1 | 磁盘版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 17-assert | 变体版发布（更新目标） | 按场景声明发布变体 dsh-plugin-update-fixture-a@0.0.2（UI/行为都随版本变，重启后能自证） | 本地 registry 可见版本含 0.0.2 | registry 版本=["0.0.1","0.0.2"] | **pass** |
| 19-assert | 超时格故障注入（延迟代理 + 4s 安装预算） | 在 verdaccio 前面挂延迟代理：只有 pnpm 的请求被挂起 15000ms（产品自己的 check 不受影响）；宿主通过 DSH_SELFTEST_REGISTRY 指向代理、通过 DSH_SELFTEST_INSTALL_TIMEOUT_MS 把安装预算降到 4000ms | 代理端口=52181；upstream=http://127.0.0.1:49403 | 代理 baseUrl=http://127.0.0.1:52181；delayMs=15000 | **pass** |
| 21-assert | 通道 B 宿主启动（普通 dsh web） | 用官方发行 CLI 起一个普通 DSH web 宿主（--profile t3cli --port 0 --no-open），等它打印 web 地址并 HTTP 探活；这是「普通 DSH 宿主」的真机形态 | 打印 http://127.0.0.1:<port>/?token=… 且探活 status<400 | url=http://127.0.0.1:55441/?token=IETbv5Gaz3hiZfSyTyFm0Bcc1Ll5Cg0mrH9zUYE16eY；bootMs=1930 | **pass** |
| 23-assert | 出口三 check 电话（发现新版） | 夹具电话 updateCheck 从宿主拿到快照：运行版=0.0.1、最新版=0.0.2、可安装 | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true | {"runningVersion":"0.0.1","installed":true,"installedVersion":"0.0.1","latestVersion":"0.0.2","canInstall":true,"blockedReason":null,"job":null,"identity":"update","registered":true} | **pass** |
| 24-assert | check 凭证（checkId） | 安装电话必须带上 check 回包给的候选凭证 checkId（不自己编） | receipt.checkId 非空 | checkId="16a8cdaf-0bfa-4129-b970-ba7b37dbfc7d"；receipt={"checkId":"16a8cdaf-0bfa-4129-b970-ba7b37dbfc7d","checkedAt":1793669907323,"expiresAt":1793670507323} | **pass** |
| 26-assert | 安装电话受理（异步：电话先回、exec 后完） | 安装电话只把任务接进来就回 ok:true（job.state=installing），真正的安装由宿主 spawn 的 CLI 子进程异步执行；所以完成判据必须用磁盘与日志，不能拿电话回包当完成 | ok=true；job.state∈{installing,verifying}；回包时长远小于真实安装耗时 | ok=true；job.state=installing；回包时长=57ms | **pass** |
| 33-assert | 出口三路由判定（hostKind=cli / exec route=cli-process） | 产品日志证明本宿主走的是「普通 DSH 宿主 spawn CLI 子进程」出口：update.wire.ready hostKind=cli，update.install.exec route=cli-process | hostKind=cli；exec.route=cli-process | hostKind=["cli","cli","cli"]；exec.route="cli-process" | **pass** |
| 34-assert | 出口三超时：作业失败 + 超时原话 | 安装预算 4000ms 到点后产品按超时定局，人话（job.message）给超时原话；允许宿主未提供终止能力时的 no-terminate 变体 | job.state=failed；message 含「安装超时，已终止子进程」或「安装超时；宿主未提供终止能力，这次安装可能仍在后台继续」 | job.state=failed；job.message="install-failed: 安装超时，已终止子进程" | **pass** |
| 35-assert | 出口三超时：exec durationMs 落在预算+宽限内（配置透传生效） | update.install.exec 的 durationMs 证明宿主真的用了 4s 预算（产品默认预算远大于它）：到点终止子进程，再给最多 3s 宽限 | durationMs∈[4000, 12000) | durationMs=4040；fields={"route":"cli-process","ok":false,"exitCode":1,"durationMs":4040,"pluginId":"fxa-a","traceId":"d049c717533f6173","spanId":"353c891d","seq":4} | **pass** |
| 36-assert | 出口三超时：install.fail（reason=timeout / code=install-failed） | 失败事件按契约落 reason=timeout、code=install-failed | reason=timeout；code=install-failed | {"stage":"exec","reason":"timeout","code":"install-failed","hostCodeHash":"none","check":"none","exitCode":1,"observedVersion":null,"intentHash":"bffd0c08","traceId":"d049c717533f6173","spanId":"353c891d","seq":6} | **pass** |
| 37-assert | 出口三超时：磁盘不变（无虚假成功） | 超时终止后 profile 里的包仍是基版 0.0.1 | 磁盘版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 39-assert | 出口三超时：故障注入真的挂住了 pnpm（原始请求日志） | 延迟代理请求日志证明：pnpm 的 registry 请求被挂起（delayMs=15000），而产品自己的 check 请求没被延迟（所以 check 能正常发现新版） | 被延迟的 pnpm 请求 ≥1；未被延迟、命中包名的 check 请求 ≥1 | 总请求=3；被延迟的 pnpm 请求=1；未延迟的包名请求=2 | **pass** |
| 40-assert | 出口三超时：运行代码没变（同宿主自证） | 超时后同一个宿主进程里的夹具 host half 仍报基版构建标记（磁盘没换、进程也没重载） | buildTag=host v0.0.1 | buildTag="host v0.0.1" | **pass** |
| 42-assert | 出口三台账（作业状态） | 更新器落盘的作业状态记录本次更新：目标版本 0.0.2、前版本 0.0.1、状态=failed | 存在 state.json 且 targetVersion=0.0.2、previousVersion=0.0.1、state∈{failed} | {"id":"a4efb30c-0d79-42d2-9aea-a64ff5b27264","state":"failed","targetVersion":"0.0.2","message":"install-failed: 安装超时，已终止子进程","requestId":"t3e-timeout-1793669907328","previousVersion":"0.0.1"} | **pass** |
| 43-assert | 收尾（进程与端口） | 所有通道 B 宿主进程都已停止、延迟代理端口已释放（真机一次只起一个宿主；不留孤儿进程） | host pids 全部不在；代理端口空闲 | hostPids=[{"label":"cli-host-main","pid":59100}]；仍存活=[]；代理端口=52181，空闲=true | **pass** |

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
- [fixture-published-variant](raw\16-fixture-published-variant.json)
- [delaying-proxy-launch](raw\18-delaying-proxy-launch.json)
- [cli-host-launch](raw\20-cli-host-launch.json)
- [phone-update-check](raw\22-phone-update-check.json)
- [phone-update-install](raw\25-phone-update-install.json)
- [phone-status-terminal](raw\27-phone-status-terminal.json)
- [phone-build-tag-after-timeout](raw\28-phone-build-tag-after-timeout.json)
- [logs-before-stop](raw\29-logs-before-stop.json)
- [log-fxa-a-2026-11-03](raw\30-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\31-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\32-log-fxa-c-2026-11-03.json)
- [delaying-proxy-requests](raw\38-delaying-proxy-requests.json)
- [ledger-states](raw\41-ledger-states.json)

## 清理

- 进程 cli-host-main（pid 59100）：停止后存活=false
- 进程 cli-host-main（pid 59100）：停止后存活=false
- 端口 delaying-proxy（52181）：已释放=true
- 端口 registry（49403）：已释放=true
- 本地 registry：http://127.0.0.1:49403（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 通道 B 是无窗口 CLI 宿主：本场景的 UI 证据是 DOM/pageText 原文（电话回包、页面状态、产品日志摘录），没有 PNG 截图；官方桌面的窗口截图证据由 d1/d2（出口二）与 T10 UI 组承担。

## 维护者 profile 未污染

- 目录：C:/Users/辰辰洋洋/.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:49403（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 通道 B 是无窗口 CLI 宿主：本场景的 UI 证据是 DOM/pageText 原文（电话回包、页面状态、产品日志摘录），没有 PNG 截图；官方桌面的窗口截图证据由 d1/d2（出口二）与 T10 UI 组承担。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
