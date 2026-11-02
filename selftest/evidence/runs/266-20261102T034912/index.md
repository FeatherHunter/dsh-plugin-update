# 真机证据索引 · c-pure-target-no-wiring

- runId：266-20261102T034912
- 票：#266
- 宿主通道：desktop-official
- 开始/结束：2026-11-01T19:49:12.468Z / 2026-11-01T19:53:52.002Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:/dsh-plugin/_wt263/t2（分支 impl/263-t2，HEAD 14e31955c2782e6c8691471bbe066d4023304578）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 d1ed0c40042770cc90f942210464e5d52dad077947354ab8c42ff0f926f4298b
- SUT dist 指纹：efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1（208 个文件）
- 安装后 dist 指纹：efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 03-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 的 dsh-plugin-update，发本地 registry；C 的更新由它驱动 | 本地 registry 可见 dsh-plugin-update@0.18.39 | dsh-plugin-update@0.18.39，sha256 d1ed0c40042770cc… | **pass** |
| 05-assert | 发布场景基版（声明驱动） | 场景声明的 A/C 基版发布到本地 registry（本场景只装这两包；B 只是 A targets 里的一个未安装目标） | A@0.0.1、C@0.0.1 都发布 | dsh-plugin-update-fixture-a@0.0.1、dsh-plugin-update-fixture-c@0.0.1 | **pass** |
| 08-assert | 干净 profile 装 A（批量）+ C（纯目标） | 隔离 profile 装入两个夹具包：A 进入批量席位，C 作为纯目标被安装（C 在自己的 dependencies 里不依赖更新内核） | A@0.0.1、C@0.0.1 依赖与磁盘一致且都在 bundles | a=0.0.1/dep=0.0.1/bundles=true; c=0.0.1/dep=0.0.1/bundles=true | **pass** |
| 10-assert | C 的包 manifest 不依赖更新内核 | C 作为纯目标，package.json dependencies 里没有 dsh-plugin-update（无接线的最硬证据，不是只在 UI 上藏起来） | C dependencies 不含 dsh-plugin-update | dependencies={} | **pass** |
| 12-assert | SUT 钉住核对 | profile 内 dsh-plugin-update/dist 聚合指纹等于工作树 dist（更新内核是当前构建） | efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1 | efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1（一致=true） | **pass** |
| 14-assert | 初始：A 批量面板三行（含未安装的 B 目标） | A 是批量集成方，targets 来自声明 a/b/c；b 本场景不装，但 A 的批量视图仍按 targets 列出三行（scope 由声明决定，不因目标未装缩水） | rows=[a,b,c]；phase 全 pending | rows=[a,b,c]；a=pending; b=pending; c=pending | **pass** |
| 15-assert | 初始：C 是纯目标（无更新接线） | C 卡片 data-update-wiring=none，卡内没有 .dsh-upd 面板/批量入口/中枢坞；C 不是集成方 | wiring=none；卡内 dshUpd=0/dock=0/entry=0；client v0.0.1 | wiring=none；dshUpd=0；dock=0；entry=0；clientTag=client v0.0.1 | **pass** |
| 16-assert | 初始：整页更新 UI 只有 A 一席 | 只装了一个集成方 A：页面只有 1 份批量面板、1 个 .dsh-upd；C 贡献 0；两个夹具包都真加载 | batchPanels=1、dshUpd=1、fixtures=2 | fixtures=[c,a]；batchPanels=1；dshUpd=1；docks=0 | **pass** |
| 19-assert | 场景声明驱动（单一真源） | 本 run 的安装版本/变体/预期全部取自 scenario-declarations.ts 的 c 声明；文件内不写死版本 | id=c-pure-target-no-wiring、install 2 步、variants 1 条（c）、expected 4 条 | id=c-pure-target-no-wiring；install=a@0.0.1,c@0.0.1；variants=c@0.0.2[behavior+metadata]；expected=4 条 | **pass** |
| 21-assert | 发布 C 的 0.0.2 变体（码面真的变了） | C 的变体包 client.js 哈希与基版不同、bundle 内含 client v0.0.2 标记：内容是新的（不是只改版本号） | client.js sha256 变化且含 client v0.0.2 | old=702b04232df1f4a5…，new=22caabb86a7b8d3b…；hasNewTag=true | **pass** |
| 22-assert | A 在本场景不被更新（只更新 C） | 声明里 c 场景的变体只有 C；A 仍停在基版，用来证明「纯目标自己的更新不会顺带改集成方」 | variants=c@0.0.2[behavior+metadata]（不含 a） | variants=c | **pass** |
| 24-assert | A 批量面板检查更新（真 UI 点 [data-act=check]） | A 的批量检查把结论写进批量知识：C 行版本条显示当前 0.0.1 → 最新 0.0.2（版本来自 registry，不是写死） | C 行版本条 0.0.1→0.0.2 | C 行 phase=pending 0.0.1→0.0.2；b 行=pending/null→null | **pass** |
| 27-assert | A 批量面板「全部更新」把 C 推到 0.0.2（真 UI） | 在 A 的批量面板点 [data-act=install]（全部更新）后，批量会话两段式预查（a current / b failed / c ready）并串行真装 C（磁盘为证；in-process host.call） | dsh-plugin-update-fixture-c=0.0.2（5 分钟内） | {"dsh-plugin-update-fixture-c":"0.0.2"} | **pass** |
| 30-assert | 安装后 A 面板状态与磁盘一致 | A 台账里 C 行变 done 且显示 0.0.2；a 行 current（预查判定已是最新，没有被顺带安装）；三行行集合不漂移 | C 行 done/0.0.2；a 行 current/0.0.1；rows=[a,b,c] | C 行=done/0.0.2；a 行=current/0.0.1；rows=[a,b,c] | **pass** |
| 32-assert | 重启后 C 内容变新（更新前 vs 更新后对比） | C 被 A 的批量面板推到 0.0.2 后，徽标文本出现 0.0.2 新版内容（行为/元数据变化可见） | badgeText 含 client v0.0.2（新版） | badgeText=夹具 C · client v0.0.2（新版）；clientTag=client v0.0.2 | **pass** |
| 33-assert | 重启后 C 仍没有任何更新 UI（纯目标不建 hub） | C 更新到新版后，卡内仍无 .dsh-upd 面板、无批量入口、无中枢坞；data-update-wiring 仍 none（C 自己不接更新系统） | wiring=none；卡内 dshUpd=0/dock=0/entry=0 | wiring=none；dshUpd=0；dock=0；entry=0；clientTag=client v0.0.2 | **pass** |
| 34-assert | A 未被这次 C 更新顺带升级 | 更新只作用于目标 C：A 仍是 0.0.1（标题无新版后缀、没有坞），证明批量行级更新只动选中目标 | A client v0.0.1；dock 不存在；标题=基版标题 | A client=client v0.0.1；dock=false；title=夹具 A · 更新演示 | **pass** |
| 35-assert | 页面级计数：仍只有 A 一个更新入口 | C 升级后整页仍只有 A 一席批量 UI（面板 1、入口 1、.dsh-upd 1、坞 0）；C 贡献 0 | batchPanels=1、entries=1、docks=0、dshUpd=1、fixtures=2 | batchPanels=1；entries=1；docks=0；dshUpd=1；fixtures=[c,a] | **pass** |
| 39-assert | 最终磁盘：C 0.0.2、A 仍 0.0.1 | 已装版本直读：C 到变体版、A 停在基版（只更新目标，不连带更新集成方） | C=0.0.2、A=0.0.1 | {"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-c":"0.0.2"} | **pass** |
| 40-assert | profile 依赖声明与磁盘一致 | desktop profile 的 C 依赖被更新成 0.0.2，A 依赖仍是 0.0.1 | dependencies: C=0.0.2、A=0.0.1 | {"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-c":"0.0.2"} | **pass** |
| 42-assert | 日志：C 的安装由 A 的批量会话驱动、C 自己没有更新命名空间 | 日志里有 C 目标命名空间(fxa-c)的 install.request、host.call(ok)、wire.ready(desktop-manager)；install.fail 只允许设计内的 check-expired 首提拒绝且每条都紧跟同命名空间 retry；无 error 级；没有任何 fxc* 命名空间（C 不是集成方） | install.request 命中 fxa-c；host.call ok；wire=desktop-manager；非 check-expired 的 install.fail=0 且未 retry 的拒绝=0；无 error；无 fxc* 日志 | {"installC":true,"hostCallOk":true,"wireDesktop":true,"noErrorLevel":true,"installFailDesignOnly":true,"cHasNoOwnNamespace":true}；installAudit={"failCount":1,"retryCount":1,"nonCheckExpired":0,"unretried":0,"queuedCount":0,"namespaces":["fxa-c"]}；installRequests=1；logFiles=fxa-a/2026-11-02.log,fxa-b/2026-11-02.log,fxa-c/2026-11-02.log | **pass** |
| 43-assert | 未发布/未安装目标（B）的诚实失败：只报 check 失败、不尝试安装、不挡整批 | A 的 targets 声明含 b，但本场景没发布也没安装 B（registry 里没有它的版本）：批量检查对 b 行报 check 失败（fxa-b 命名空间）+ entry.fail{stage:check}，warn 级；没有任何 fxa-b 的 install.request；同一批仍把 C 装到变体版 | fxa-b check.fail 存在；fxa-b entry.fail stage=check 存在；fxa-b 无 install.request；b 失败非 error 级；同批 C 装成 | {"bCheckFail":true,"bEntryFailAtCheck":true,"bNeverInstallAttempted":true,"bFailNotErrorLevel":true,"cInstalledBySameBatch":true}；checkFails=["fxa-b:","fxa-b:","fxa-b:"]；entryFails=["fxa-b:check"] | **pass** |
| 44-assert | 进程与端口收尾（只清理自己起的） | 自己启动的桌面进程全部退出、verdaccio 端口释放 | 所有记录进程 aliveAfterStop=false；verdaccio 端口 released=true | processes=[{"label":"desktop-app-bootstrap","pid":72204,"aliveAfterStop":false},{"label":"desktop-app-main","pid":2480,"aliveAfterStop":false},{"label":"desktop-app-auto-relaunch#0","pid":2480,"aliveAfterStop":false},{"label":"desktop-app-final","pid":13696,"aliveAfterStop":false}]；ports=[{"label":"verdaccio","port":60575,"released":true}] | **pass** |
| 45-assert | 维护者 profile 只读核对 | 整个真机跑期间维护者自己的 ~/.dsh 指纹不变（隔离 DSH_HOME + 隔离 user-data-dir） | maintainer home 指纹 before=after | homeDir=C:\Users\辰辰洋洋\.dsh；unchanged=true | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 17-shot | 初始：A 批量面板 + C 纯目标（无更新 UI） | 官方桌面窗口：A 批量面板三行（b 目标未安装行也在）、C 徽标右下/左下且没有任何更新 UI | A rows=a/b/c；C 无 .dsh-upd；batchPanels=1 | A rows=[a,b,c]；batchPanels=1；fixtures=[c,a] | **pass** | [shots\17-shot.png](shots\17-shot.png) |
| 25-shot | A 面板检查后：C 行 0.0.1→0.0.2 待装 | A 批量面板三行；C 行版本条显示当前 0.0.1 → 最新 0.0.2；b 行（未安装目标）显示未能查询，a 行已是最新 | C 行版本条 0.0.1→0.0.2；行集合=a/b/c | C 行=pending 0.0.1→0.0.2；rows=[a,b,c] | **pass** | [shots\25-shot.png](shots\25-shot.png) |
| 36-shot | 重启后整窗：C 新版内容、无更新 UI；A 仍旧版 | 官方桌面：C 徽标显示 client v0.0.2（新版），卡片无任何更新面板/入口；A 仍是 0.0.1 的旧集成方（无坞）；整页只有 A 一份批量面板 | C badge=client v0.0.2（新版） 且 C .dsh-upd=0；A 旧版；batchPanels=1 | C badge=夹具 C · client v0.0.2（新版）；C dshUpd=0；A client=client v0.0.1；batchPanels=1 | **pass** | [shots\36-shot.png](shots\36-shot.png) |
| 37-shot | 重启后 C 特写（新版内容 + data-update-wiring=none） | C 徽标文本是新版内容，卡片上 data-update-wiring=none、无 .dsh-upd：被更新了但自己不接更新系统 | badgeText 含 client v0.0.2（新版）；C wiring=none、dshUpd=0 | badgeText=夹具 C · client v0.0.2（新版）；wiring=none；dshUpd=0 | **pass** | [shots\37-shot.png](shots\37-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [fixture-published-baseline](raw\04-fixture-published-baseline.json)
- [desktop-first-launch](raw\06-desktop-first-launch.json)
- [install-baseline](raw\07-install-baseline.json)
- [c-manifest](raw\09-c-manifest.json)
- [sut-installed-dist](raw\11-sut-installed-dist.json)
- [initial-ui](raw\13-initial-ui.json)
- [scenario-declaration](raw\18-scenario-declaration.json)
- [fixture-published-variant-c](raw\20-fixture-published-variant-c.json)
- [a-check-complete](raw\23-a-check-complete.json)
- [a-install-c-poll](raw\26-a-install-c-poll.json)
- [post-install-relaunch](raw\28-post-install-relaunch.json)
- [a-install-complete](raw\29-a-install-complete.json)
- [restart-ui](raw\31-restart-ui.json)
- [final-disk](raw\38-final-disk.json)
- [logs](raw\41-logs.json)

## 清理

- 进程 desktop-app-bootstrap（pid 72204）：停止后存活=false
- 进程 desktop-app-main（pid 2480）：停止后存活=false
- 进程 desktop-app-auto-relaunch#0（pid 2480）：停止后存活=false
- 进程 desktop-app-final（pid 13696）：停止后存活=false
- 端口 verdaccio（60575）：已释放=true
- 本地 registry：http://127.0.0.1:60575
- 场景声明基版：dsh-plugin-update-fixture-a@0.0.1、dsh-plugin-update-fixture-c@0.0.1

## 维护者 profile 未污染

- 目录：C:\Users\辰辰洋洋\.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:60575
- 场景声明基版：dsh-plugin-update-fixture-a@0.0.1、dsh-plugin-update-fixture-c@0.0.1

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
