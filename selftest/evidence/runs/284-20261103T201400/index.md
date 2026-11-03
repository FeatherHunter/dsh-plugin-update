# 真机证据索引 · l4-page-close-mid-install

- runId：284-20261103T201400
- 票：#284
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T11:15:44.772Z / 2026-11-03T11:16:46.400Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:\dsh-plugin\_wt263\t13（分支 impl/284-boundary-gaps，HEAD 1734155b93395b81f27b23247513149f48f3e109）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 0261815ccdf01683e6194b0b53c70dac7a282bf001740b3242da55e8ae3b9755
- SUT dist 指纹：e280a81080925fdcc76eda4f9edf2559e8ae81b7fce01f326fe301220e119117（208 个文件）
- 安装后 dist 指纹：e280a81080925fdcc76eda4f9edf2559e8ae81b7fce01f326fe301220e119117（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 0261815ccdf01683…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1 | **pass** |
| 10-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 12-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e280a81080925fdcc76eda4f9edf2559e8ae81b7fce01f326fe301220e119117 | e280a81080925fdcc76eda4f9edf2559e8ae81b7fce01f326fe301220e119117（文件数 208 / 工作树 208） | **pass** |
| 13-assert | setup-sut | 通道 B profile 里装的 SUT 与工作树构建一致 | installed distDigest === worktree distDigest | true | **pass** |
| 14-assert | setup-base-disk | 基版安装后磁盘版本与声明一致 | {"dsh-plugin-update-fixture-a":"0.0.1"} | dsh-plugin-update-fixture-a=0.0.1 | **pass** |
| 18-assert | l4-01-check-before-close | 关页面前提：检查可用、安装窗被延迟代理拉长 | 可更新横幅原文精确匹配 | {"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"} | **pass** |
| 20-assert | l4-02-install-in-flight | 关页面前安装真的在飞（不是空窗关页面） | 面板出现 busy/进度非空 | {"busyObserved":true,"banner":{"kind":"busy","title":"正在安装 0.0.2…关闭面板不会中断。","sub":"进度将自动轮询刷新；重新打开面板将在 1 秒内恢复显示。"},"progress":"正在安装新版本…"} | **pass** |
| 23-assert | l4-03-host-side-after-page-close | 页面关闭不影响宿主侧安装：磁盘/台账真到位，完成时刻晚于关闭时刻 | 磁盘 0.0.2、台账成功终态、closedBeforeCompleted=true | {"closedAt":"2026-11-03T11:15:59.623Z","completedAt":"2026-11-03T11:16:40.462Z","closedBeforeCompleted":true,"disk":{"dsh-plugin-update-fixture-a":"0.0.2"},"ledgerState":"restart-required"} | **pass** |
| 25-assert | l4-04-reopen-truthful | 重开页面与宿主侧真相一致：无永远更新中、无重复作业入口 | 面板已了结、build tags=0.0.2 | {"banner":{"kind":"done","title":"已是最新，无需更新。","sub":""},"tags":{"clientTag":"client v0.0.2","hostTag":"host v0.0.1"}} | **pass** |
| 28-assert | l4-05-exactly-once | 关页面/重开期间 exactly-once：安装请求恰 1 次、无失败、台账恰一条成功 | install.request=1、install.fail=0、成功台账 1 份、before.json 1 份 | {"requests":1,"fails":0,"execs":1,"okExecs":1,"successJobs":1,"beforeFiles":1} | **pass** |
| 30-assert | l4-06a-restart-honest-unknown | L4 重启后 A 面板首屏：新进程首屏没查过最新版时不得谎称已是最新 | 横幅 kind=idle/unknown、文案含「版本信息未知」、不含「已是最新」，并提供检查更新动作 | {"kind":"idle","title":"版本信息未知，请检查更新。","sub":"检查更新"} | **pass** |
| 32-assert | l4-06-restart-truthful | 重启后仍一致、不回退、无重复成功记录 | 面板已了结、build tags=0.0.2、台账恰 1 份成功 | {"banner":{"kind":"done","title":"已是最新，无需更新。","sub":""},"tags":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"ledgerCount":1} | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 17-shot | l4-10-slow-window-check | 延迟代理拉长安装窗前的对照：真 UI 检查到 0.0.2 可更新（产品 check 不走 pnpm，不受延迟影响） | 可更新横幅原文精确匹配 | {"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"} | **pass** | [shots\17-shot.png](shots\17-shot.png) |
| 19-shot | l4-20-busy-before-close | 真 UI 点安装后、关页面前的现场：安装正在宿主侧进行（进度/忙碌档），页面即将被关闭 | 观测到安装进行中（busy/进度非空）；页面仍未关闭 | {"busyObserved":true,"panel":{"present":true,"plugin":"dsh-plugin-update-fixture-a","banner":{"kind":"busy","title":"正在安装 0.0.2…关闭面板不会中断。","sub":"进度将自动轮询刷新；重新打开面板将在 1 秒内恢复显示。"},"errCode":null,"settled":"","lastResort":null,"manual":{"present":true,"heading":"当前没有可用的手工命令。","code":null,"neutral":"当前没有可用的手工命令。"},"strip":["0.0.1","0.0.1","0.0.2"],"actions":[{"action":"check","text":"检查更新","disabled":true},{"action":"install","text":"正在安装…","disabled":true},{"action":"copy-diag","text":"复制诊断","disabled":false},{"action":"toggle-queue","text":"显示其他插件","disabled":false}],"progress":"正在安装新版本…"}} | **pass** | [shots\19-shot.png](shots\19-shot.png) |
| 24-shot | l4-30-reopened-truthful | 关页面后重开：首屏先诚实说版本未知（新面板实例没查过最新版）→ 真 UI 点检查更新后面板已「已是最新」、运行构建 0.0.2，与宿主侧磁盘/台账真相一致 | 首屏诚实未知、检查更新后横幅「已是最新，无需更新。」、clientTag/hostTag=0.0.2 | {"banner":{"kind":"done","title":"已是最新，无需更新。","sub":""},"tags":{"clientTag":"client v0.0.2","hostTag":"host v0.0.1"}} | **pass** | [shots\24-shot.png](shots\24-shot.png) |
| 31-shot | l4-40-restart-truthful | 重启宿主后：首屏版本未知（见 l4-06a）→ 真 UI 检查更新后面板已了结、运行构建 0.0.2、台账仍恰一条成功终态 | 横幅「已是最新，无需更新。」、clientTag/hostTag=0.0.2、台账恰 1 份成功 | {"banner":{"kind":"done","title":"已是最新，无需更新。","sub":""},"tags":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"ledgerJobs":["completed"]} | **pass** | [shots\31-shot.png](shots\31-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [tls-registry-front](raw\07-tls-registry-front.json)
- [isolation-facts](raw\08-isolation-facts.json)
- [install-baseline](raw\09-install-baseline.json)
- [sut-installed-dist](raw\11-sut-installed-dist.json)
- [fixture-publication](raw\15-fixture-publication.json)
- [host-launch-l4-gen1](raw\16-host-launch-l4-gen1.json)
- [l4-page-closed](raw\21-l4-page-closed.json)
- [l4-host-completion-while-page-closed](raw\22-l4-host-completion-while-page-closed.json)
- [host-stop-0](raw\26-host-stop-0.json)
- [l4-final-facts](raw\27-l4-final-facts.json)
- [host-launch-l4-gen2](raw\29-host-launch-l4-gen2.json)
- [host-stop-1](raw\33-host-stop-1.json)
- [log-fxa-a-2026-11-03](raw\34-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\35-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\36-log-fxa-c-2026-11-03.json)
- [cleanup-log-files](raw\37-cleanup-log-files.json)
- [tls-front-stop](raw\38-tls-front-stop.json)

## 清理

- 进程 l4-gen1-host（pid 104344）：停止后存活=false
- 进程 l4-gen2-host（pid 42064）：停止后存活=false
- 端口 tls-registry-front（51859）：已释放=false
- 端口 l4-gen1-host-port（52694）：已释放=false
- 端口 l4-gen2-host-port（59204）：已释放=false
- 端口 registry（65438）：已释放=true
- 本地 registry：http://127.0.0.1:65438（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 l4-gen1 已起：port=52694，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:51859）
- 宿主 l4-gen2 已起：port=59204，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:51859）

## 备注

- 本地 registry：http://127.0.0.1:65438（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 l4-gen1 已起：port=52694，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:51859）
- 宿主 l4-gen2 已起：port=59204，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:51859）

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
