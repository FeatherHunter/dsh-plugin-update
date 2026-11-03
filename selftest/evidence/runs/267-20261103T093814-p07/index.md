# 真机证据索引 · e2-cli-host-update-failure

- runId：267-20261103T093814-p07
- 票：#267
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T01:38:15.403Z / 2026-11-03T01:38:34.396Z
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
| 08-assert | 出口三隔离口径（宿主 home = USERPROFILE/.dsh） | 通道 B 宿主与它 spawn 的 CLI 子进程落在同一个 run 内隔离 home：宿主用 DSH_HOME=homeDir，子进程 DSH_* 被剥离后按 USERPROFILE/.dsh 解析 | homeDir=D:\dsh-plugin\_wt263\runtime\t11-275\267-20261103T093814-p07\os-home\.dsh；profileName=t3cli（≠ desktop） | osHomeDir=D:\dsh-plugin\_wt263\runtime\t11-275\267-20261103T093814-p07\os-home；homeDir=D:\dsh-plugin\_wt263\runtime\t11-275\267-20261103T093814-p07\os-home\.dsh；profileName=t3cli | **pass** |
| 10-assert | 通道 B 建普通 profile（CLI 入口） | 用官方发行里的 CLI（dsh --profile <名> --from-default-profile web --dump-config）在隔离 home 建一个普通 DSH 使用范围；范围名不是 desktop，路由才会落到 cli 出口 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t11-275\267-20261103T093814-p07\os-home\.dsh\profiles\t3cli | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t11-275\267-20261103T093814-p07\os-home\.dsh\profiles\t3cli | **pass** |
| 12-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 15-assert | 出口三基版在盘（更新前状态） | 更新前隔离 profile 的 node_modules 里装的是场景声明的基版 0.0.1 | 磁盘版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 18-assert | 变体版发布（更新目标） | 按场景声明发布变体 dsh-plugin-update-fixture-a@0.0.2（UI/行为都随版本变，重启后能自证） | 本地 registry 可见版本含 0.0.2 | registry 版本=["0.0.1","0.0.2"] | **pass** |
| 20-assert | 通道 B 宿主启动（普通 dsh web） | 用官方发行 CLI 起一个普通 DSH web 宿主（--profile t3cli --port 0 --no-open），等它打印 web 地址并 HTTP 探活；这是「普通 DSH 宿主」的真机形态 | 打印 http://127.0.0.1:<port>/?token=… 且探活 status<400 | url=http://127.0.0.1:55439/?token=XZr5j_F2-3fakThfczNjaP5jCfmdIjgmUijx5TIpF3c；bootMs=1933 | **pass** |
| 22-assert | 出口三 check 电话（发现新版） | 夹具电话 updateCheck 从宿主拿到快照：运行版=0.0.1、最新版=0.0.2、可安装 | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true | {"runningVersion":"0.0.1","installed":true,"installedVersion":"0.0.1","latestVersion":"0.0.2","canInstall":true,"blockedReason":null,"job":null,"identity":"update","registered":true} | **pass** |
| 23-assert | check 凭证（checkId） | 安装电话必须带上 check 回包给的候选凭证 checkId（不自己编） | receipt.checkId 非空 | checkId="82ed4275-105f-4fdc-b532-b914d1862bbb"；receipt={"checkId":"82ed4275-105f-4fdc-b532-b914d1862bbb","checkedAt":1793669907309,"expiresAt":1793670507309} | **pass** |
| 25-assert | 失败格故障注入（check 后删 tarball、保元数据） | check 已经看到 0.0.2；随后只删 registry storage 里的 tarball（元数据与 integrity 一字不改）：候选门能过，载体 CLI 子进程里的 pnpm 下载 tarball 时 404 非零退出（真实网络失败，不是注入假回包） | 删前 GET tarball=200 且字节>0；删后=404；元数据版本文档一字不差；依赖 dsh-log@0.3.4 tarball 预热=200 | warm={"url":"http://127.0.0.1:49404/dsh-log/-/dsh-log-0.3.4.tgz","status":200,"bytes":161707}；删前=200/92550B；删后=404；版本文档不变=true | **pass** |
| 27-assert | 安装电话受理（异步：电话先回、exec 后完） | 安装电话只把任务接进来就回 ok:true（job.state=installing），真正的安装由宿主 spawn 的 CLI 子进程异步执行；所以完成判据必须用磁盘与日志，不能拿电话回包当完成 | ok=true；job.state∈{installing,verifying}；回包时长远小于真实安装耗时 | ok=true；job.state=installing；回包时长=55ms | **pass** |
| 33-assert | 出口三路由判定（hostKind=cli / exec route=cli-process） | 产品日志证明本宿主走的是「普通 DSH 宿主 spawn CLI 子进程」出口：update.wire.ready hostKind=cli，update.install.exec route=cli-process | hostKind=cli；exec.route=cli-process | hostKind=["cli","cli","cli"]；exec.route="cli-process" | **pass** |
| 34-assert | 出口三失败：作业失败 + 原话（诚实面） | 载体 CLI 子进程非零退出后，任务以 failed 收场；message 以稳定码 install-failed 开头并带 pnpm 原话（不吞、不美化） | job.state=failed；message 含 install-failed 与 pnpm 原话（ERR_PNPM/No matching version/404） | job.state=failed；job.message="install-failed: Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt): [ERR_PNPM_FETCH_404] GET http://127.0.0.1:49404/dsh-plugin-update-fixture-a/-/dsh-plugin-update-fixture-a-0.0.2.tgz: Not Found - 404 No authorization header…" | **pass** |
| 35-assert | 出口三失败：诚实面不得出现载体命令 | registry 类失败没有可执行的人工补救命令（包被下架，重装同版本也装不上），产品不许在 detail 里塞载体命令 | job.message 不含 "dsh plugin" | job.message="install-failed: Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt): [ERR_PNPM_FETCH_404] GET http://127.0.0.1:49404/dsh-plugin-update-fixture-a/-/dsh-plugin-update-fixture-a-0.0.2.tgz: Not Found - 404 No authorization header…" | **pass** |
| 36-assert | 出口三失败：exec 日志（route/ok/exitCode） | update.install.exec 记录载体 CLI 子进程非零退出（exitCode 是真实子进程退出码） | route=cli-process；ok=false；exitCode 是整数 | {"route":"cli-process","ok":false,"exitCode":1,"durationMs":1143,"pluginId":"fxa-a","traceId":"512f506eda912fd9","spanId":"293501ac","seq":4} | **pass** |
| 37-assert | 出口三失败：install.fail 八格（stage/reason/code） | 失败事件按契约落 stage=exec、reason=nonzero-exit、code=install-failed，其余格（hostCodeHash/check/exitCode/observedVersion/intentHash）都在 | stage=exec；reason=nonzero-exit；code=install-failed；八格齐全 | {"stage":"exec","reason":"nonzero-exit","code":"install-failed","hostCodeHash":"none","check":"none","exitCode":1,"observedVersion":null,"intentHash":"6a8ba8cb","traceId":"512f506eda912fd9","spanId":"293501ac","seq":6} | **pass** |
| 38-assert | 出口三失败：磁盘不变（无虚假成功） | 失败后 profile 里的包仍是基版 0.0.1，没有半装状态 | 磁盘版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 39-assert | 出口三失败：回包手工命令（可执行） | 失败后 updateStatus 回包的 manual 是可执行命令：目标版本 0.0.2、范围 t3cli、源是本地 registry | manual 含 --profile t3cli、dsh-plugin-update-fixture-a@0.0.2、--registry=http://127.0.0.1:49404 | manual="dsh plugin --profile t3cli add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=http://127.0.0.1:49404" | **pass** |
| 41-assert | 恢复 registry tarball（为执行手工命令） | 把备份的 0.0.2 tarball 放回 verdaccio storage，让失败回包给出的手工命令能真跑 | 恢复后 GET tarball=200；元数据版本文档仍不变 | restoredStatus=200；元数据不变=true | **pass** |
| 43-assert | 验收③：失败回包的手工命令真机执行 | 按回包 manual 原文切出 argv（去掉开头的 dsh），用官方发行 CLI 在同一个隔离 home 里真跑一次：命令能执行、把 0.0.2 装上 | 命令可切 argv；exit=0；磁盘版本=0.0.2 | argv=["plugin","--profile","t3cli","add","--save-exact","dsh-plugin-update-fixture-a@0.0.2","--registry=http://127.0.0.1:49404"]；exit=0；durationMs=1261；磁盘=0.0.2 | **pass** |
| 45-assert | 失败格收尾：手工命令真的把更新装上去（重启自证） | 重启宿主后构建标记电话回报 host v0.0.2，证明手工命令不是只读探针、真的更新了运行代码 | buildTag=host v0.0.2 | buildTag="host v0.0.2" | **pass** |
| 47-assert | 出口三台账（作业状态） | 更新器落盘的作业状态记录本次更新：目标版本 0.0.2、前版本 0.0.1、状态=failed | 存在 state.json 且 targetVersion=0.0.2、previousVersion=0.0.1、state∈{failed} | {"id":"64d9715f-88af-42c0-9a6a-dce0808c543a","state":"failed","targetVersion":"0.0.2","message":"install-failed: Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt): [ERR_PNPM_FETCH_404] GET http://127.0.0.1:49404/dsh-plugin-update-fixture-a/-/dsh-plugin-update-fixture-a-0.0.2.tgz: Not Found - 404 No authorization header…","requestId":"t3e-failure-1793669907393","previousVersion":"0.0.1"} | **pass** |
| 48-assert | 收尾（进程与端口） | 所有通道 B 宿主进程都已停止、延迟代理端口已释放（真机一次只起一个宿主；不留孤儿进程） | host pids 全部不在；代理端口空闲 | hostPids=[{"label":"cli-host-main","pid":98920},{"label":"cli-host-restart","pid":67852}]；仍存活=[]；代理端口=null，空闲=n/a | **pass** |

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
- [failure-variant-injection](raw\16-failure-variant-injection.json)
- [fixture-published-variant](raw\17-fixture-published-variant.json)
- [cli-host-launch](raw\19-cli-host-launch.json)
- [phone-update-check](raw\21-phone-update-check.json)
- [registry-tarball-fault](raw\24-registry-tarball-fault.json)
- [phone-update-install](raw\26-phone-update-install.json)
- [phone-status-terminal](raw\28-phone-status-terminal.json)
- [logs-before-stop](raw\29-logs-before-stop.json)
- [log-fxa-a-2026-11-03](raw\30-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\31-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\32-log-fxa-c-2026-11-03.json)
- [registry-tarball-restored](raw\40-registry-tarball-restored.json)
- [manual-command-exec](raw\42-manual-command-exec.json)（命令 dsh plugin --profile t3cli add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=http://127.0.0.1:49404，exit 0）
- [phone-build-tag-after-manual](raw\44-phone-build-tag-after-manual.json)
- [ledger-states](raw\46-ledger-states.json)

## 清理

- 进程 cli-host-main（pid 98920）：停止后存活=false
- 进程 cli-host-restart（pid 67852）：停止后存活=false
- 端口 registry（49404）：已释放=true
- 本地 registry：http://127.0.0.1:49404（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 通道 B 是无窗口 CLI 宿主：本场景的 UI 证据是 DOM/pageText 原文（电话回包、页面状态、产品日志摘录），没有 PNG 截图；官方桌面的窗口截图证据由 d1/d2（出口二）与 T10 UI 组承担。
- 失败格故障注入 A：变体版 0.0.2 内容带本 run 注入标记（seatLine/hostBehavior 含 stamp），使 tarball integrity 与历史 run 不同、pnpm store 必然 miss；构建标记仍为 v0.0.2
- 失败格故障注入：check 后只删 registry storage 里的 0.0.2 tarball（元数据不动），CLI 子进程 pnpm 下载时 404；备份在 run 内 registry-tarball-backup/，恢复后再执行手工命令

## 维护者 profile 未污染

- 目录：C:/Users/辰辰洋洋/.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:49404（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 通道 B 是无窗口 CLI 宿主：本场景的 UI 证据是 DOM/pageText 原文（电话回包、页面状态、产品日志摘录），没有 PNG 截图；官方桌面的窗口截图证据由 d1/d2（出口二）与 T10 UI 组承担。
- 失败格故障注入 A：变体版 0.0.2 内容带本 run 注入标记（seatLine/hostBehavior 含 stamp），使 tarball integrity 与历史 run 不同、pnpm store 必然 miss；构建标记仍为 v0.0.2
- 失败格故障注入：check 后只删 registry storage 里的 0.0.2 tarball（元数据不动），CLI 子进程 pnpm 下载时 404；备份在 run 内 registry-tarball-backup/，恢复后再执行手工命令

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
