# 真机证据索引 · m1-hub-orphan-only-owner-a-returns

- runId：284-20261103T224448
- 票：#284
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T14:44:48.456Z / 2026-11-03T14:45:53.130Z
- 总判定：**fail**（退出码 1）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:\dsh-plugin\_wt263\t14（分支 impl/284-hub-lifecycle，HEAD 2080f29612bba8b2b7cabf691b19fda491f0b962）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 9535fa5cd7321617dd158d1972f35824f5eea2492ef3e08e53348a426c309eeb
- SUT dist 指纹：ff0a6b1aea9773eced40869b73a2d3a837a9b3e98afd9c900e81d4b158e62b76（208 个文件）
- 安装后 dist 指纹：ff0a6b1aea9773eced40869b73a2d3a837a9b3e98afd9c900e81d4b158e62b76（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 9535fa5cd7321617…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1, dsh-plugin-update-fixture-b@0.0.1 | **pass** |
| 09-assert | 建普通 profile（CLI 入口） | createWebProfileInHome 建通道 B 的普通 profile（非 desktop） | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t14-284\284-20261103T224448\os-home\.dsh\profiles\t14hub | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t14-284\284-20261103T224448\os-home\.dsh\profiles\t14hub | **pass** |
| 11-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 12-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | ff0a6b1aea9773eced40869b73a2d3a837a9b3e98afd9c900e81d4b158e62b76 | ff0a6b1aea9773eced40869b73a2d3a837a9b3e98afd9c900e81d4b158e62b76（文件数 208 / 工作树 208） | **pass** |
| 16-assert | 更新前基版在盘 | 场景声明 install 里的包 @0.0.1 已装进 profile，SUT 钉版与工作树 dist 一致（M1/M2 的 C 是孤儿目标，初始不在册，由中枢按方案补装，故不参与本断言） | 声明在册包（a,b）磁盘版本=0.0.1 | 已声明包全部=0.0.1；未在册=["c"] | **pass** |
| 18-assert | 变体 0.0.2 已发布 | 场景声明 variants 发布到仓库外 verdaccio | A/B/C 均有 0.0.2，A 变体含批量坞/新版 UI | A=0.0.2；baseline=0.0.1 | **pass** |
| 21-assert | 中枢/批量目录定位 | 按 profileDir 短哈希复算队列目录，并与盘上实际目录对照（首次安装前目录可能尚未创建） | 盘上目录数 ≤1，且存在时=47afcf060ff22b781e9832d0 | 盘上=[]；复算=47afcf060ff22b781e9832d0 | **pass** |
| 23-assert | 宿主启动（通道 B，host1） | startCliHost 起 DSH web 宿主（隔离 USERPROFILE/home/profile） | boot 成功、HTTP 电话入口可用、pid>0 | pid=38936，port=50691，bootMs=2022 | **pass** |
| 26-assert | A/B 两个集成方的批量检查电话受理 | fxa.batchCheck / fxb.batchCheck 各建批量会话（A 三行、B 两行） | ok=true；fxa rows=[a,b,c]；fxb rows=[b,c]（行序按声明 targets，不敏感） | fxa.ok=true rows=["a","b","c"]；fxb.ok=true rows=["c","b"] | **pass** |
| 28-assert | A 自身检查更新（批量前） | A 的 updateCheck 看到 0.0.2 可更新 | canInstall=true；installedVersion=0.0.1；latestVersion=0.0.2 | canInstall=true；installedVersion=0.0.1；latestVersion=0.0.2 | **pass** |
| 30-assert | A 批量安装电话已发出（不等回包） | host1 先发 fxa.batchInstall；B 的 fxb.batchInstall 在换手窗口里（A 自键 done 后）再发 | A 的批量开始推进（fxa 方案与 batch.json 落盘） | at=1793717102924 | **pass** |
| 33-assert | 换手窗口：双方案在盘、A 自键已 done、B/C 未终态 | 轮询 hub/plans/ 与 fxa batch.json 捕获第一代推进到「A 已换、B/C 未终态」的窗口；B 的批量在 A 自键 done 后才发，fxb 方案落盘即进窗口 | plans 含 fxa.json/fxb.json；phase(a)='done' 且 b 或 c 非终态；bFiredAt 非空 | plans=["fxa.json","fxb.json"]；phasesA={"a":"done","b":"installing","c":"ready"}；phasesB={"a":null,"b":"ready","c":"ready"}；bFiredAt=1793717104537 | **pass** |
| 34-assert | 换手前中枢租约由第一代宿主持有 | hub/lease.json 的 pid/属主与 generation（只记录实测值） | lease.pid=38936（第一代宿主进程） | lease={"pid":38936,"generation":1,"driverId":"dsh-hub:38936:abwvcw7rvd"} | **pass** |
| 36-assert | 第一代宿主已硬杀（换手注入） | taskkill /T /F 杀掉第一代宿主进程树（未等批量收尾），中枢执行者消失 | pid=38936 不再存活 | pid=38936；alive=false | **pass** |
| 38-assert | 摘掉孤主 B：profile 在册与包目录都不再有 B | CLI plugin remove B；核对 dsh.profile.bundles 与 node_modules | bundles 不含 dsh-plugin-update-fixture-b；B 的包目录/版本读不到 | bundles=["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-plugin-update-fixture-a"]；B 目录版本=null | **pass** |
| 41-assert | can-red 注入：换手窗口删除 hub plan | 删 <home>/update-queue/<hash>/hub/plans/fxa.json，模拟中枢方案丢失 | 删除前 plan 在盘（原文已留 raw），删除后读不到 | deletedAt=1793717105445；after=null | **pass** |
| 43-assert | 宿主启动（通道 B，host2） | startCliHost 起 DSH web 宿主（隔离 USERPROFILE/home/profile） | boot 成功、HTTP 电话入口可用、pid>0 | pid=21284，port=55992，bootMs=1863 | **pass** |
| 50-assert | can-red 红点：换手窗口删 hub plan 后 A 不再自动接管、B/C 未续跑 | 删除中枢方案后启动第二代宿主，观察 B/C 是否仍自动完成（本断言在 can-red 注入下应当红） | A 自动采纳 fxa 方案、B/C 自动续跑完成（正常场景应如此；本 run 人为删 plan 后预期不成立） | phases={"a":"done","b":"installing","c":"ready"}；elapsedMs=45148；resumeRunStart=0；execAfterHost2=0 | **fail** |
| 59-assert | 收尾：宿主进程与端口无残留 | 关闭所有宿主后核实 pid 不在、端口空闲 | remainingPids=[]、所有端口 free=true | remainingPids=[]；portChecks=[{"label":"host1","port":50691,"free":true},{"label":"host2","port":55992,"free":true}] | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [isolation-facts](raw\07-isolation-facts.json)
- [profile-create](raw\08-profile-create.json)
- [install-baseline](raw\10-install-baseline.json)
- [sut-installed-dist](raw\13-sut-installed-dist.json)
- [baseline-installed](raw\15-baseline-installed.json)
- [fixture-published-variant](raw\17-fixture-published-variant.json)
- [host-env](raw\19-host-env.json)
- [hub-paths](raw\20-hub-paths.json)
- [cli-host-launch-host1](raw\22-cli-host-launch-host1.json)
- [panel-batch-status-initial](raw\24-panel-batch-status-initial.json)
- [phone-batch-check](raw\25-phone-batch-check.json)
- [phone-a-update-check-before-batch](raw\27-phone-a-update-check-before-batch.json)
- [phone-batch-install-fire](raw\29-phone-batch-install-fire.json)
- [phone-batch-install-fire-b](raw\31-phone-batch-install-fire-b.json)
- [state-at-kill](raw\32-state-at-kill.json)
- [host-stop-host1-kill](raw\35-host-stop-host1-kill.json)
- [remove-owner-b](raw\37-remove-owner-b.json)
- [can-red-plan-before-delete](raw\39-can-red-plan-before-delete.json)
- [can-red-plan-deleted](raw\40-can-red-plan-deleted.json)
- [cli-host-launch-host2](raw\42-cli-host-launch-host2.json)
- [host2-start-window](raw\44-host2-start-window.json)
- [batch-after-handoff](raw\45-batch-after-handoff.json)
- [install-promise-outcomes](raw\46-install-promise-outcomes.json)
- [log-timeline](raw\47-log-timeline.json)
- [ledger-states](raw\48-ledger-states.json)
- [can-red-verdict-facts](raw\49-can-red-verdict-facts.json)
- [host-stop-final](raw\51-host-stop-final.json)
- [log-fxa-a-2026-11-03](raw\52-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\53-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\54-log-fxa-c-2026-11-03.json)
- [log-fxb-b-2026-11-03](raw\55-log-fxb-b-2026-11-03.json)
- [log-fxb-c-2026-11-03](raw\56-log-fxb-c-2026-11-03.json)
- [logs-final](raw\57-logs-final.json)
- [cleanup-verify](raw\58-cleanup-verify.json)

## 清理

- 进程 cli-host-host1（pid 38936）：停止后存活=false
- 进程 cli-host-host2（pid 21284）：停止后存活=false
- 端口 cli-host-host1-port（50691）：已释放=true
- 端口 cli-host-host2-port（55992）：已释放=true
- 端口 registry（63650）：已释放=true
- 本地 registry：http://127.0.0.1:63650（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 换手注入：web 通道没有「应用自重启」，用「taskkill 硬杀第一代宿主 + 同 home/profile 起第二代」注入换手，等价于桌面 relaunch 后新 fiber 接管中枢；差别（整进程退出 vs 应用内重启）写进研究笔记。
- 「只回来 A」的构造：杀宿主后从 profile 的 dsh.profile.bundles 摘掉 B（CLI plugin remove，并删其 node_modules 包），保留 A；第二代宿主因此只加载 A 这一个批量集成方（其 batch 电话只接 A 的 fxa）。

## 备注

- 本地 registry：http://127.0.0.1:63650（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 换手注入：web 通道没有「应用自重启」，用「taskkill 硬杀第一代宿主 + 同 home/profile 起第二代」注入换手，等价于桌面 relaunch 后新 fiber 接管中枢；差别（整进程退出 vs 应用内重启）写进研究笔记。
- 「只回来 A」的构造：杀宿主后从 profile 的 dsh.profile.bundles 摘掉 B（CLI plugin remove，并删其 node_modules 包），保留 A；第二代宿主因此只加载 A 这一个批量集成方（其 batch 电话只接 A 的 fxa）。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
