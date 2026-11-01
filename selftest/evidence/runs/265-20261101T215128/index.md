# 真机证据索引 · a-single-package-main-chain

- runId：265-20261101T215128
- 票：#265
- 宿主通道：desktop-official
- 开始/结束：2026-11-01T13:51:29.288Z / 2026-11-01T13:54:51.462Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:\dsh-plugin\_wt263\t1（分支 impl/263-t1，HEAD 0b782f4aadbc4e19f4a3fda551badba88217e5d5）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 951c8dbd61a5165e08517324f0989c01211a37abad29922956cc45cc3fbd68c3
- SUT dist 指纹：44ffc4bbde2f942dcaf3991a2be602f617814f88271db32b916b40df1cfaabb9（208 个文件）
- 安装后 dist 指纹：44ffc4bbde2f942dcaf3991a2be602f617814f88271db32b916b40df1cfaabb9（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 03-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 951c8dbd61a5165e…，dist 208 文件 | **pass** |
| 07-assert | 干净 profile 装 A 旧版 | 隔离 DSH_HOME 的新 desktop profile 里，dsh plugin add 装上 A@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1 | **pass** |
| 09-assert | SUT 钉住核对 | 夹具装进 profile 后，profile/node_modules/dsh-plugin-update/dist 的聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | 44ffc4bbde2f942dcaf3991a2be602f617814f88271db32b916b40df1cfaabb9 | 44ffc4bbde2f942dcaf3991a2be602f617814f88271db32b916b40df1cfaabb9（文件数 208 / 工作树 208） | **pass** |
| 11-assert | 旧版面板（重启后） | 官方桌面里 A 的更新面板显示：运行版 0.0.1、已安装 0.0.1、夹具卡片 client v0.0.1；更新器身份是当前 SUT | 运行版=已安装=0.0.1；client 构建标记=client v0.0.1；updater 含 dsh-plugin-update@0.18.39 | versions=[0.0.1, 0.0.1, 未知]；clientTag=client v0.0.1；updater=dsh-plugin-update@0.18.39 (profile) | **pass** |
| 14-assert | 发布 A 新版（可见变化） | 同一包名发布 0.0.2；新版 client bundle 与 host half 的内容哈希都和 0.0.1 不同（构建标记/卡片标题变化） | client 与 host 的 sha256 都变；registry 可见 0.0.2 | client d9db85a16a93→f0cb943b347f；host 9929c515598c→ee260075ce27 | **pass** |
| 16-assert | 新版在 registry 可见 | 本地 registry 的 A 元数据包含 0.0.1 与 0.0.2（更新系统查到的 latest 就是它） | versions 含 0.0.1、0.0.2 | versions=[0.0.1, 0.0.2]；dist-tags={"latest":"0.0.2"} | **pass** |
| 18-assert | 真 UI 检查更新 | 点面板「检查更新」后，最新版变成 0.0.2，安装按钮可用（数据来自面板 DOM 快照） | 最新版=0.0.2；安装更新按钮 enabled | versions=[0.0.1, 0.0.1, 0.0.2]；install={"text":"安装版本 0.0.2","disabled":false}；seal=可更新 | **pass** |
| 21-assert | 真 UI 安装更新（in-process） | 点「安装更新」后，官方桌面通过 in-process remove→install（或 restart-required）把 profile 磁盘版本换成 0.0.2 | 磁盘 node_modules/<pkg>/package.json version=0.0.2 | 磁盘版本=0.0.2；面板 seal=已是最新；进度=null | **pass** |
| 25-assert | 重启后新版 UI + 可见变化 | 重启隔离桌面后重新加载的是 0.0.2 的 client/host：卡片标题相对旧版发生变化（旧标题→新标题）、client 构建标记、host 桥标记都变成新版 | client v0.0.2；host v0.0.2；标题从「夹具 A · 更新演示」变为另一个值且含「新版」；运行版/已安装=0.0.2 | clientTag=client v0.0.2；hostTag=host v0.0.2；title=夹具 A · 更新演示（新版）（旧：夹具 A · 更新演示）；versions=[0.0.2, 0.0.2, 未知] | **pass** |
| 28-assert | UI/磁盘一致（无虚假成功） | 重启后 UI 显示已安装 0.0.2，且磁盘 profile 的 dependencies 与 node_modules 包版本都是 0.0.2 | diskVersion=0.0.2；dependencies[dsh-plugin-update-fixture-a]=0.0.2 | diskVersion=0.0.2；dependencies="0.0.2" | **pass** |
| 30-assert | 日志摘录（结构化事件） | 临时 DSH_HOME 下找到更新日志，按 JSON 事件核对：检查更新看到 0.0.1→0.0.2、安装电话成功、重启后运行版=0.0.2，且无安装失败事件 | 日志文件存在；含 update.install.request（current=0.0.1, latest=0.0.2）；含 host.call(update-install, ok=true)；含重启后 status.changed(runningVersion=0.0.2)；含 wire.ready(hostKind=desktop-manager，证明走官方桌面 in-process 出口而非 CLI 兜底)；无安装失败事件 | 日志文件 3 个/事件 35 条；条件={"logFilesPresent":true,"installRequest":true,"installCall":true,"restartNewVersion":true,"desktopManagerHost":true,"noInstallFailure":true} | **pass** |
| 31-assert | 宿主通道与安装出口（in-process） | 日志 update.wire.ready 的 hostKind 声明本次更新走的是官方桌面内建插件管理器（desktop-manager，removeBundle→installBundle），不是 CLI 兜底 | hostKind=desktop-manager | hostKind=desktop-manager | **pass** |
| 32-assert | 台账（作业/队列） | 找到更新器落盘的作业状态与跨插件队列台账，核对本次更新记录（0.0.1→0.0.2、completed）与 UI、磁盘一致 | 存在 updates/<目标>/<范围>/state.json 且状态 completed、targetVersion=0.0.2、previousVersion=0.0.1；存在 update-queue/<范围>/queue.json 且 owner=null、waiting=[] | 作业状态文件 1 个；队列文件 1 个；completedState=true；queueDrained=true；记录={"stateFiles":[{"requestId":"rmvxw4lyq5c5rn","message":null,"id":"5f835f3e-7848-4a03-a9a1-7bc6aa003608","state":"completed","targetVersion":"0.0.2","previousVersion":"0.0.1"}],"queueFiles":[{"version":1,"owner":null,"waiting":[]}]} | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 12-shot | 旧版面板 | 官方桌面窗口里的 A 面板：版本条带三个 0.0.1/未知，夹具卡片显示 client v0.0.1，更新器显示 dsh-plugin-update@0.18.39 (profile) | 运行版=已安装=0.0.1，最新版=未知（未检查），卡片 client v0.0.1 | versions=[0.0.1, 0.0.1, 未知]；seal=已是最新；clientTag=client v0.0.1 | **pass** | [shots\12-shot.png](shots\12-shot.png) |
| 19-shot | 检查更新后 | 点击「检查更新」后的面板：最新版显示 0.0.2，出现「安装更新」可用按钮 | 版本条带第三项=0.0.2，安装按钮可用 | versions=[0.0.1, 0.0.1, 0.0.2]；install.disabled=false | **pass** | [shots\19-shot.png](shots\19-shot.png) |
| 22-shot | 安装更新后（重启前） | 安装动作结束后的面板：出现安装结果/待重启状态（面板可能在安装后重挂载，故 clientTag 允许为空）；磁盘已是 0.0.2 | 安装动作结束（seal/进度有终态或面板重挂载）；磁盘已是 0.0.2 | seal=已是最新；clientTag=client v0.0.2；磁盘=0.0.2 | **pass** | [shots\22-shot.png](shots\22-shot.png) |
| 26-shot | 重启后新版面板 | 重启后的官方桌面窗口：卡片标题变为新版变体，client/host 构建标记都是 v0.0.2，面板运行版/已安装=0.0.2 | client v0.0.2 / host v0.0.2 / 标题含「新版」/ 版本条带 0.0.2 | clientTag=client v0.0.2；hostTag=host v0.0.2；title=夹具 A · 更新演示（新版）；versions=[0.0.2, 0.0.2, 未知] | **pass** | [shots\26-shot.png](shots\26-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [fixture-published-old](raw\04-fixture-published-old.json)
- [desktop-first-launch](raw\05-desktop-first-launch.json)
- [install-old](raw\06-install-old.json)
- [sut-installed-dist](raw\08-sut-installed-dist.json)
- [panel-old](raw\10-panel-old.json)
- [fixture-published-new](raw\13-fixture-published-new.json)
- [registry-metadata-new](raw\15-registry-metadata-new.json)
- [panel-after-check](raw\17-panel-after-check.json)
- [panel-after-install](raw\20-panel-after-install.json)
- [profile-manifest-after-update](raw\23-profile-manifest-after-update.json)
- [panel-new](raw\24-panel-new.json)
- [final-disk-facts](raw\27-final-disk-facts.json)
- [logs-and-ledger](raw\29-logs-and-ledger.json)

## 清理

- 进程 desktop-app-bootstrap（pid 61096）：停止后存活=false
- 进程 desktop-app-main（pid 77556）：停止后存活=false
- 进程 desktop-app-restart（pid 31536）：停止后存活=false
- 端口 cdp（0）：已释放=true
- 端口 registry（61855）：已释放=true
- 本地 registry：http://127.0.0.1:61855（仓库外 verdaccio，run 内独立 storage）
- 夹具 dsh-plugin-update-fixture-a@0.0.1（A 案：批量集成方，selfOrder=first，targets=[a,b,c]）

## 维护者 profile 未污染

- 目录：C:\Users\辰辰洋洋\.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:61855（仓库外 verdaccio，run 内独立 storage）
- 夹具 dsh-plugin-update-fixture-a@0.0.1（A 案：批量集成方，selfOrder=first，targets=[a,b,c]）

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
