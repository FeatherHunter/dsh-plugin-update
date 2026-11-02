# 真机证据索引 · e-batch-three-package-upgrade

- runId：269-20261102T224509
- 票：#269
- 宿主通道：desktop-official
- 开始/结束：2026-11-02T14:45:09.876Z / 2026-11-02T14:48:10.342Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:\dsh-plugin\_wt263\t5（分支 impl/263-t5，HEAD 9c094c76938310fcde2b4d6c4038ff0160688904）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 80cbd584d05efe8dd1a14cfc01dcb9149a3bc29e0d8592cff33d8f5896436312
- SUT dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（208 个文件）
- 安装后 dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 80cbd584d05efe8d…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1, dsh-plugin-update-fixture-b@0.0.1, dsh-plugin-update-fixture-c@0.0.1 | **pass** |
| 11-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 12-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | 干净 profile 装基版（c） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-c@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-c；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b, dsh-plugin-update-fixture-c]；磁盘版本=0.0.1；exit=0 | **pass** |
| 15-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 17-assert | 基版 UI（三包 0.0.1） | A 批量面板列出 a/b/c 三行；A/B 卡片与 C 徽标都是 0.0.1（干净 profile 的起点） | rows=a,b,c；A/B clientTag=client v0.0.1/client v0.0.1；C 徽标 client v0.0.1 | {"rows":"a,b,c","cardA":"client v0.0.1","cardB":"client v0.0.1","cardC":"client v0.0.1","disk":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":"0.0.1","dsh-plugin-update-fixture-c":"0.0.1"}} | **pass** |
| 20-assert | 三包 0.0.2 变体发布 | A/B/C 三个夹具的 0.0.2 变体都发到 run 私有 registry，tarball 字节与 0.0.1 基版不同（内容真变，不是只改版本号） | A/B/C 三个 0.0.2 tarball 都可读且 sha256 与各自 0.0.1 不同；无注入时 variants 三席齐全 | {"variantShas":{"a":"b918dd5d494a57d14bc76c0bb701362148a0163c05bba67551576e5a562ee98c","b":"799ea28992729f90d0e6abc0e81a7bc1f2985b42903232fc659197794bdc0437","c":"9aa0079c5a898177aa7efc0c3bda8c69592e0b896590b077aef33e6304a1954a"},"baselineShas":{"a":"31cac26daa2a9b9f269998d97e99177622eb382a56a8cc6ecfc7ee6b3bf8eb84","b":"5b855860cfa2782344a80355f0a0758e6546357f06bd24eda86bde596e0ceed1","c":"f74cbb521e0b34841e2f3b693d7a4c4faee626e21a0e98f1c392ebd5c76dd178"},"injected":[]} | **pass** |
| 22-assert | 真 UI 检查更新（三行都可更新 0.0.2） | A 面板点「检查更新」后，a/b/c 三行的当前版本=0.0.1、新版本=0.0.2 | rows=a,b,c 且每行 versionCur=0.0.1、versionNew=0.0.2 | [{"key":"a","cur":"0.0.1","next":"0.0.2","phase":"pending"},{"key":"b","cur":"0.0.1","next":"0.0.2","phase":"pending"},{"key":"c","cur":"0.0.1","next":"0.0.2","phase":"pending"}] | **pass** |
| 25-assert | 宏批量更新落盘（三包都到 0.0.2） | 真 UI 宏「全部更新」后，磁盘上 A/B/C 的已装版本都变成 0.0.2（不是只改台账） | versions[a]=versions[b]=versions[c]=0.0.2；dependencies 三包=0.0.2 | {"versions":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"},"dependencies":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"},"observed":["a=0.0.1,b=0.0.1,c=0.0.1","a=null,b=0.0.1,c=0.0.1","a=0.0.2,b=0.0.1,c=0.0.1","a=0.0.2,b=null,c=0.0.1","a=0.0.2,b=0.0.2,c=0.0.1","a=0.0.2,b=0.0.2,c=0.0.2"]} | **pass** |
| 27-assert | 台账逐行真相（三包各一条成功终态） | 三个插件（fxa-a/fxa-b/fxa-c）各恰一条 state.json，state∈{completed,restart-required}、targetVersion=0.0.2、previousVersion=0.0.1；总成功条数=3（无丢行/无重复） | 每插件 1 条；成功终态各 1；target=0.0.2；previous=0.0.1 | {"ledgerA":[{"state":"completed","target":"0.0.2","previous":"0.0.1"}],"ledgerB":[{"state":"completed","target":"0.0.2","previous":"0.0.1"}],"ledgerC":[{"state":"completed","target":"0.0.2","previous":"0.0.1"}]} | **pass** |
| 35-assert | 日志链：批量入口 → 三包真装 → in-process 宿主 | 日志里有三包（fxa-a/fxa-b/fxa-c）的 install.request、host.call(update-install, ok=true)、update.wire.ready(desktop-manager)、批量 summary；无 error 级；exec 失败=0；install.fail 只允许设计内 check-expired（每条紧跟 retry）；无 check.fail / host.call.fail{method:*.updateCheck} | 三目标命名空间各有 install.request；host.call ok；wire=desktop-manager；summary≥1；exec 失败=0；非 check-expired 的 fail=0 且未 retry 的拒绝=0；无 error/check.fail | {"requests":3,"requestNs":["fxa-a","fxa-b","fxa-c"],"installAudit":{"failCount":2,"retryCount":2,"nonCheckExpired":0,"unretried":0,"queuedCount":0,"namespaces":["fxa-b","fxa-c"]},"hostCallOk":true,"wireDesktop":true,"batchSummary":1,"execFailCount":0,"checkFailCount":0,"errorCount":0} | **pass** |
| 38-assert | 重启后 UI 一致：三卡片新版 + 三行 current | 重启后 A/B 卡片 clientTag/hostTag 都是 v0.0.2，C 徽标 v0.0.2；A 面板三行都是 current 0.0.2（UI 与磁盘/台账一致） | A=client v0.0.2/host v0.0.2；B=client v0.0.2/host v0.0.2；C=client v0.0.2；三行 current 0.0.2 | {"cardA":{"present":true,"key":"a","ui":"batch","title":"夹具 A · 更新演示（批量新版）","clientTag":"client v0.0.2","hostTag":"host v0.0.2","seatLine":{"attr":"批量席位 fxa · 自键 a · 目标 a/b/c","text":"批量席位 fxa · 自键 a · 目标 a/b/c"},"behavior":{"attr":"seat-aware-v2","text":"宿主行为 seat-aware-v2"},"dockHost":"hub-dock"},"cardB":{"present":true,"key":"b","ui":"batch","title":"夹具 B · 更新演示（批量新版）","clientTag":"client v0.0.2","hostTag":"host v0.0.2","seatLine":{"attr":"批量席位 fxb · 自键 b · 目标 b/c","text":"批量席位 fxb · 自键 b · 目标 b/c"},"behavior":{"attr":"seat-aware-v2","text":"宿主行为 seat-aware-v2"},"dockHost":"hub-dock"},"seatC":{"clientTag":"client v0.0.2","badge":"夹具 C · client v0.0.2（新版）"},"rows":[{"key":"a","phase":"done","cur":"0.0.2"},{"key":"b","phase":"done","cur":"0.0.2"},{"key":"c","phase":"done","cur":"0.0.2"}]} | **pass** |
| 40-assert | 重启后台账/磁盘与 UI 三处一致 | 重启不产生新台账/不回退：三个插件仍各一条成功终态（target=0.0.2），磁盘三包=0.0.2，与 UI 三行 current 一致 | 三插件各 1 条成功终态；磁盘 versions/dependencies 三包=0.0.2 | {"ledgerA":["completed"],"ledgerB":["completed"],"ledgerC":["completed"],"disk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"},"dependencies":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"}} | **pass** |
| 43-assert | 批量账本/中枢/队列：属主 fxa 三键、无跨 scope、无残留等待项 | 磁盘上 A 的批量会话（属主 fxa）batch.json/inventory.json 都恰含 a/b/c 三键；中枢 plans/fxa 的 selfKey=a、targets=a/b/c；根队列 waiting=[]；没有 fxc 属主/计划（C 纯目标不接更新系统） | fxa batch/inventory keys=[a,b,c]；hub plan fxa selfKey=a targets=[a,b,c]；queue.waiting=[]；无 fxc | {"owners":["fxa","fxb"],"fxaBatchKeys":["a","b","c"],"fxaInventoryKeys":["a","b","c"],"hubPlanOwners":["fxa"],"fxaHubSelfKey":"a","fxaHubTargets":["a","b","c"],"waiting":[],"lease":null} | **pass** |
| 44-assert | 桌面实例退出（收尾无人残留） | 场景结束时登记过的桌面进程（含宿主自重启产生的实例）全部已退出，没有残留窗口占用单实例名额 | 登记进程的 kill(pid,0) 全部失败（已退出） | 登记 3 个进程；仍活着=[] | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 18-shot | 基版 UI（三包 0.0.1） | 三包批量场景的初始形态：A 面板三行、A/B 卡片、C 纯目标卡片 | 三行 + 三卡片都在页面上，版本 0.0.1 | rows=a,b,c；A=client v0.0.1；C=client v0.0.1 | **pass** | [shots\18-shot.png](shots\18-shot.png) |
| 23-shot | 真 UI 检查更新（三行都可更新 0.0.2） | A 批量面板三行：当前 0.0.1、可更新 0.0.2 | 三行都显示 0.0.1 → 0.0.2 | a:0.0.1->0.0.2 \| b:0.0.1->0.0.2 \| c:0.0.1->0.0.2 | **pass** | [shots\23-shot.png](shots\23-shot.png) |
| 39-shot | 重启后 UI 一致（三包新版） | 三包更新成功后重启：A/B 卡片新版标记、C 徽标新版、A 面板三行 current | A=client v0.0.2；B=client v0.0.2；C=client v0.0.2 | {"cardA":"client v0.0.2","cardB":"client v0.0.2","seatC":"client v0.0.2"} | **pass** | [shots\39-shot.png](shots\39-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [pnpm-store-isolation](raw\07-pnpm-store-isolation.json)
- [desktop-first-launch](raw\08-desktop-first-launch.json)
- [desktop-stop-bootstrap](raw\09-desktop-stop-bootstrap.json)
- [install-baseline](raw\10-install-baseline.json)
- [sut-installed-dist](raw\14-sut-installed-dist.json)
- [batch-panel-initial](raw\16-batch-panel-initial.json)
- [fixture-published-variants](raw\19-fixture-published-variants.json)
- [a-check-complete](raw\21-a-check-complete.json)
- [batch-settled](raw\24-batch-settled.json)
- [ledger-after-batch](raw\26-ledger-after-batch.json)
- [desktop-stop-after-batch](raw\28-desktop-stop-after-batch.json)
- [log-fxa-a-2026-11-02](raw\29-log-fxa-a-2026-11-02.json)
- [log-fxa-b-2026-11-02](raw\30-log-fxa-b-2026-11-02.json)
- [log-fxa-c-2026-11-02](raw\31-log-fxa-c-2026-11-02.json)
- [log-fxb-b-2026-11-02](raw\32-log-fxb-b-2026-11-02.json)
- [log-fxb-c-2026-11-02](raw\33-log-fxb-c-2026-11-02.json)
- [log-counts](raw\34-log-counts.json)
- [panel-after-batch-restart](raw\36-panel-after-batch-restart.json)
- [final-state](raw\37-final-state.json)
- [desktop-stop-after-final](raw\41-desktop-stop-after-final.json)
- [batch-disk-facts](raw\42-batch-disk-facts.json)

## 清理

- 进程 desktop-bootstrap（pid 62672）：停止后存活=false
- 进程 desktop-main（pid 94252）：停止后存活=false
- 进程 desktop-after-batch-restart（pid 98268）：停止后存活=false
- 端口 registry（64252）：已释放=true
- 本地 registry：http://127.0.0.1:64252（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 每 run 私有 pnpm store：D:\dsh-plugin\_wt263\runtime\t5-269\269-20261102T224509\pnpm-store（从 bootstrap/CLI 基版安装起生效）
- 真 UI 点 A 面板宏「全部更新」；安装窗只轮询磁盘/台账（三包串行安装，每次成功会触发宿主自重启，旧 CDP 失效）

## 备注

- 本地 registry：http://127.0.0.1:64252（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 每 run 私有 pnpm store：D:\dsh-plugin\_wt263\runtime\t5-269\269-20261102T224509\pnpm-store（从 bootstrap/CLI 基版安装起生效）
- 真 UI 点 A 面板宏「全部更新」；安装窗只轮询磁盘/台账（三包串行安装，每次成功会触发宿主自重启，旧 CDP 失效）

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
