# 真机证据索引 · m2-hub-orphan-only-owner-b-returns

- runId：284-20261103T224122
- 票：#284
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T14:41:22.437Z / 2026-11-03T14:42:25.087Z
- 总判定：**pass**（退出码 0）

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
| 09-assert | 建普通 profile（CLI 入口） | createWebProfileInHome 建通道 B 的普通 profile（非 desktop） | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t14-284\284-20261103T224122\os-home\.dsh\profiles\t14hub | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t14-284\284-20261103T224122\os-home\.dsh\profiles\t14hub | **pass** |
| 11-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 12-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | ff0a6b1aea9773eced40869b73a2d3a837a9b3e98afd9c900e81d4b158e62b76 | ff0a6b1aea9773eced40869b73a2d3a837a9b3e98afd9c900e81d4b158e62b76（文件数 208 / 工作树 208） | **pass** |
| 16-assert | 更新前基版在盘 | 场景声明 install 里的包 @0.0.1 已装进 profile，SUT 钉版与工作树 dist 一致（M1/M2 的 C 是孤儿目标，初始不在册，由中枢按方案补装，故不参与本断言） | 声明在册包（a,b）磁盘版本=0.0.1 | 已声明包全部=0.0.1；未在册=["c"] | **pass** |
| 18-assert | 变体 0.0.2 已发布 | 场景声明 variants 发布到仓库外 verdaccio | A/B/C 均有 0.0.2，A 变体含批量坞/新版 UI | A=0.0.2；baseline=0.0.1 | **pass** |
| 21-assert | 中枢/批量目录定位 | 按 profileDir 短哈希复算队列目录，并与盘上实际目录对照（首次安装前目录可能尚未创建） | 盘上目录数 ≤1，且存在时=afe54603808af02737bf8a89 | 盘上=[]；复算=afe54603808af02737bf8a89 | **pass** |
| 23-assert | 宿主启动（通道 B，host1） | startCliHost 起 DSH web 宿主（隔离 USERPROFILE/home/profile） | boot 成功、HTTP 电话入口可用、pid>0 | pid=42480，port=60171，bootMs=2301 | **pass** |
| 26-assert | A/B 两个集成方的批量检查电话受理 | fxa.batchCheck / fxb.batchCheck 各建批量会话（A 三行、B 两行；行序不敏感） | ok=true；fxa rows={a,b,c}；fxb rows={b,c} | fxa.ok=true rows=["a","b","c"]；fxb.ok=true rows=["c","b"] | **pass** |
| 28-assert | A 自身检查更新（批量前） | A 的 updateCheck 看到 0.0.2 可更新 | canInstall=true；installedVersion=0.0.1；latestVersion=0.0.2 | canInstall=true；installedVersion=0.0.1；latestVersion=0.0.2 | **pass** |
| 30-assert | A 批量安装电话已发出（不等回包） | host1 先发 fxa.batchInstall；B 的 fxb.batchInstall 在换手窗口里（A 自键 done 后）再发 | A 的批量开始推进（fxa 方案与 batch.json 落盘） | at=1793716900352 | **pass** |
| 33-assert | 换手窗口：双方案在盘、A 自键已 done、B/C 未终态 | 轮询 hub/plans/ 与 fxa batch.json 捕获第一代推进到「A 已换、B/C 未终态」的窗口；B 的批量在 A 自键 done 后才发，fxb 方案落盘即进窗口 | plans 含 fxa.json/fxb.json；phase(a)='done' 且 b 或 c 非终态；bFiredAt 非空 | plans=["fxa.json","fxb.json"]；phasesA={"a":"done","b":"installing","c":"ready"}；phasesB={"a":null,"b":"ready","c":"ready"}；bFiredAt=1793716902381 | **pass** |
| 34-assert | 换手前中枢租约由第一代宿主持有 | hub/lease.json 的 pid/属主与 generation（只记录实测值） | lease.pid=42480（第一代宿主进程） | lease={"pid":42480,"generation":1,"driverId":"dsh-hub:42480:cju9bqbjt7"} | **pass** |
| 36-assert | 第一代宿主已硬杀（换手注入） | taskkill /T /F 杀掉第一代宿主进程树（未等批量收尾），中枢执行者消失 | pid=42480 不再存活 | pid=42480；alive=false | **pass** |
| 38-assert | 摘掉 A：profile 在册与包目录都不再有 A（B 保留） | CLI plugin remove A；核对 dsh.profile.bundles 与 node_modules | bundles 不含 dsh-plugin-update-fixture-a 且含 dsh-plugin-update-fixture-b；A 的包目录/版本读不到 | bundles=["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-plugin-update-fixture-b"]；A 目录版本=null | **pass** |
| 40-assert | 宿主启动（通道 B，host2） | startCliHost 起 DSH web 宿主（隔离 USERPROFILE/home/profile） | boot 成功、HTTP 电话入口可用、pid>0 | pid=29248，port=58281，bootMs=2345 | **pass** |
| 47-assert | 只回来 B：B 推完自己的 fxb 批次（b/c 均 done） | 不驱动安装，只轮询 fxb/batch.json 等第二代 B 把 b/c 推完 | fxb phases={b:'done',c:'done'}；无 failed | phasesB={"a":null,"b":"done","c":"done"}；elapsedMs=31087；batchFailed=[] | **pass** |
| 48-assert | B 的 fxb 行在第二代宿主启动后由 B 自己续跑（exec 各恰 1 次、ok=true） | fxb-b/fxb-c 的 update.install.exec 行数与 ts vs 第二代 host.start ts | fxb-b、fxb-c 各恰 1 条 exec（route=cli-process、ok=true、exitCode=0）且 ts > 第二代 host.start | host2StartTs=1793716905550；fxb-b=[{"ts":1793716936321,"pluginId":"fxb-b","route":"cli-process","ok":true,"exitCode":0,"durationMs":1298}]；fxb-c=[{"ts":1793716934782,"pluginId":"fxb-c","route":"cli-process","ok":true,"exitCode":0,"durationMs":1391}] | **pass** |
| 49-assert | B 未冒领 A 的 fxa 方案：fxa.json 字节/哈希不变、无 fxa 行执行 | 换手前后 fxa.json sha256 比较；日志里 fxa-b/fxa-c 无 exec 行；fxa batch.json 的 b/c 行保持未终态 | fxa sha256 前后相同；execFxaB=[]、execFxaC=[]；fxa phases 的 b/c 仍非 done/failed | fxaHashBefore=6c90b2561a36ef32091fa0b185c64166fe529f5c63810251633ac6797f640ef5；fxaHashAfter=6c90b2561a36ef32091fa0b185c64166fe529f5c63810251633ac6797f640ef5；execFxaB=[]；execFxaC=[]；fxaPhases={"a":"done","b":"installing","c":"ready"}；planNames=["fxa.json","fxb.json"] | **pass** |
| 50-assert | A 的目标 a 不被 B 安装（A 已摘出 profile） | 磁盘：A 不在 profile dependencies/node_modules；B 的 b/c 到 0.0.2 | dependencies.a=null、nodeModules.a=null；b/c=0.0.2 | dependencies={"a":null,"b":"0.0.2","c":"0.0.2"}；nodeModules={"a":null,"b":"0.0.2","c":"0.0.2"} | **pass** |
| 51-assert | B 的台账：fxb-b/fxb-c 各恰一条成功终态（A 无新台账行） | <home>/updates/<pluginId>/<hash>/state.json：B 自己两行完整、A 不被 B 写 | fxb-b、fxb-c 各 1 条 targetVersion=0.0.2 成功终态；fxa-b/fxa-c 无新增成功行 | {"fxbB":[{"state":"completed","targetVersion":"0.0.2"}],"fxbC":[{"state":"completed","targetVersion":"0.0.2"}],"fxaA":[{"state":"completed","targetVersion":"0.0.2"}]} | **pass** |
| 52-assert | B 按属主采纳自己的 fxb 方案（跨宿主会话保留；不是只读不动、也不是 A 冒领） | fxb.json 的 owner=批量前缀 fxb、sessionId 与 fxb/batch.json 的批次 id 一致；第二代宿主日志出现 fxb 的 resume run.start（total=2、resumed=true、sessionHash 非空）——第一幕 entry 行在硬杀宿主时日志未落盘，本 run 改用「盘上方案/batch 会话 id 跨代不变 + second host 仍按该会话续跑」作为会话保留的客观证据 | fxb owner='fxb'；plan.sessionId=fxb batch.id；resume run.start total=2/resumed=true/sessionHash 非空；fxb 批次 done | fxbOwner=fxb；planSessionId=mw0sqbqo-wldv0qkv68；batchId=mw0sqbqo-wldv0qkv68；entry(未落盘)=null；resume={"ts":1793716905567,"trigger":"resume","resumed":true,"total":2,"sessionHash":"e91f19d9"}；fxbHashBefore=fed24fba4843b8acad523623cf3d640fbbd8da310e0e0672019e234d6722ba5f；fxbHashAfter=24e5d21b1613c313f5fb5b269af0cdf460e4a59d01330f9deb9dfc22554464a7 | **pass** |
| 55-assert | 第三幕：剖面只装回 A（B 摘出、A@0.0.2 重新在册） | CLI plugin remove B + add A@0.0.2；核对 bundles 与磁盘版本 | bundles 含 A 不含 B；node_modules A=0.0.2 | bundles=["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-plugin-update-fixture-c","dsh-plugin-update-fixture-a"]；addA.ok=true | **pass** |
| 57-assert | 宿主启动（通道 B，host3） | startCliHost 起 DSH web 宿主（隔离 USERPROFILE/home/profile） | boot 成功、HTTP 电话入口可用、pid>0 | pid=37868，port=56455，bootMs=2277 | **pass** |
| 61-assert | 第三幕：A 采纳跨宿主的 fxa 方案并收尾（无 failed） | 第三宿主只装 A，轮询 fxa/batch.json 到终态：a 已 done，b/c 已被 B 的 fxb 装到 0.0.2，A 应看到 current/done 而非重装 | phases a='done'；b/c ∈ {done,current}；无 failed | phases={"a":"done","b":"done","c":"done"}；elapsedMs=2034；batchFailed=[] | **pass** |
| 62-assert | 第三幕：A 在第三宿主上 resume（run.start trigger=resume、sessionHash 与 act1 entry 一致） | 日志 run.start：第三宿主出现 resume 行，且与第一幕 entry 的 sessionHash 相同（同一批量会话跨宿主保留） | resume run.start ≥1；resume.sessionHash=d84ef6e1 | resumeRows=[{"ts":1793716942133,"trigger":"resume","resumed":true,"total":3,"sessionHash":"d84ef6e1"}]；allRunStart=[{"ts":1793716900356,"trigger":"entry","resumed":false,"total":3,"sessionHash":"d84ef6e1"},{"ts":1793716905567,"trigger":"resume","resumed":true,"total":2,"sessionHash":"e91f19d9"},{"ts":1793716942133,"trigger":"resume","resumed":true,"total":3,"sessionHash":"d84ef6e1"}] | **pass** |
| 65-assert | 第三幕磁盘：a/b/c 三包都在 0.0.2（a 由 CLI 装回、b/c 由 B 的 fxb 装成） | profile package.json dependencies + node_modules 实际版本 | a/b/c 都是 0.0.2 | dependencies={"a":"0.0.2","b":"0.0.2","c":"0.0.2"}；nodeModules={"a":"0.0.2","b":"0.0.2","c":"0.0.2"} | **pass** |
| 66-assert | 第三幕台账：fxa-a / fxb-b / fxb-c 各恰一条成功终态，目标 0.0.2（无重复/丢行） | <home>/updates/**/state.json：A 的 a 与 B 的 b/c 各恰一条成功终态；A 未给 b/c 写重复成功行 | fxa-a、fxb-b、fxb-c 各 1 条 targetVersion=0.0.2 成功终态 | {"fxaA":[{"state":"completed","targetVersion":"0.0.2"}],"fxbB":[{"state":"completed","targetVersion":"0.0.2"}],"fxbC":[{"state":"completed","targetVersion":"0.0.2"}]} | **pass** |
| 68-assert | 第三幕面板：fxa 三行终态、无 failed（UI/台账/磁盘一致） | batchStatus 回包（面板数据源）与磁盘 batch.json 一致 | 三行 phase ∈ {done,current} 且无 failed | ok=true；rows=[{"key":"a","phase":"done","targetVersion":"0.0.2"},{"key":"b","phase":"done","targetVersion":"0.0.2"},{"key":"c","phase":"done","targetVersion":"0.0.2"}] | **pass** |
| 70-assert | 第三幕中枢状态：fxa 会话 finished、failed=0、activeInstall=null | updateHubStatus 回包：state/progress/activeInstall | state='finished'；progress.failed=0；activeInstall=null | state=finished；progress={"total":3,"done":3,"failed":0,"skipped":0,"current":0,"pending":0,"finished":true}；activeInstall=null | **pass** |
| 79-assert | 收尾：宿主进程与端口无残留 | 关闭所有宿主后核实 pid 不在、端口空闲 | remainingPids=[]、所有端口 free=true | remainingPids=[]；portChecks=[{"label":"host1","port":60171,"free":true},{"label":"host2","port":58281,"free":true},{"label":"host3","port":56455,"free":true}] | **pass** |
| 80-assert | exactly-once：每个目标至多一次成功 exec（无重复成功；中断的首次尝试允许被恢复重跑一次） | 宿主全部关闭后重读最终日志：fxb-b/fxb-c 各恰 1 次成功；fxa-c=0（被 fxb 装好，A 收敛 current 不重装）；fxa-b∈{0,1}（第一幕在装时被杀=中断、无成功记录，第三幕恢复至多成功一次）；任何目标成功 exec 不超过 1 | 成功 exec：fxb-b=1、fxb-c=1、fxa-c=0、fxa-b∈{0,1}；所有目标成功 exec ≤1 | {"fxbB":1,"fxbC":1,"fxaB":0,"fxaC":0} | **pass** |

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
- [remove-owner-a](raw\37-remove-owner-a.json)
- [cli-host-launch-host2](raw\39-cli-host-launch-host2.json)
- [host2-start-window](raw\41-host2-start-window.json)
- [fxb-after-handoff](raw\42-fxb-after-handoff.json)
- [install-promise-outcomes](raw\43-install-promise-outcomes.json)
- [log-timeline-act2](raw\44-log-timeline-act2.json)
- [disk-after-handoff-b](raw\45-disk-after-handoff-b.json)
- [ledger-states-act2](raw\46-ledger-states-act2.json)
- [host-stop-host2-stop-act3](raw\53-host-stop-host2-stop-act3.json)
- [act3-profile-swap](raw\54-act3-profile-swap.json)
- [cli-host-launch-host3](raw\56-cli-host-launch-host3.json)
- [host3-start-window](raw\58-host3-start-window.json)
- [fxa-after-act3](raw\59-fxa-after-act3.json)
- [log-timeline-act3](raw\60-log-timeline-act3.json)
- [disk-after-act3](raw\63-disk-after-act3.json)
- [ledger-states-act3](raw\64-ledger-states-act3.json)
- [panel-batch-status-act3](raw\67-panel-batch-status-act3.json)
- [panel-hub-status-act3](raw\69-panel-hub-status-act3.json)
- [host-stop-final](raw\71-host-stop-final.json)
- [log-fxa-a-2026-11-03](raw\72-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\73-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\74-log-fxa-c-2026-11-03.json)
- [log-fxb-b-2026-11-03](raw\75-log-fxb-b-2026-11-03.json)
- [log-fxb-c-2026-11-03](raw\76-log-fxb-c-2026-11-03.json)
- [logs-final](raw\77-logs-final.json)
- [cleanup-verify](raw\78-cleanup-verify.json)
- [exactly-once-final](raw\81-exactly-once-final.json)

## 清理

- 进程 cli-host-host1（pid 42480）：停止后存活=false
- 进程 cli-host-host2（pid 29248）：停止后存活=false
- 进程 cli-host-host3（pid 37868）：停止后存活=false
- 端口 cli-host-host1-port（60171）：已释放=true
- 端口 cli-host-host2-port（58281）：已释放=true
- 端口 cli-host-host3-port（56455）：已释放=true
- 端口 registry（52976）：已释放=true
- 本地 registry：http://127.0.0.1:52976（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 换手注入同 M1：taskkill 硬杀第一代宿主 + 同 home/profile 起第二代；「只回来 B」= 杀宿主后从 profile 摘掉 A（CLI plugin remove），保留 B。
- 第三幕「装回 A」：关掉第二代宿主后 CLI plugin remove B、add A@0.0.2 回 profile，起第三宿主——A 按盘上仍是原来那份 fxa.json 采纳续跑（跨宿主方案保留有效）。

## 备注

- 本地 registry：http://127.0.0.1:52976（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 换手注入同 M1：taskkill 硬杀第一代宿主 + 同 home/profile 起第二代；「只回来 B」= 杀宿主后从 profile 摘掉 A（CLI plugin remove），保留 B。
- 第三幕「装回 A」：关掉第二代宿主后 CLI plugin remove B、add A@0.0.2 回 profile，起第三宿主——A 按盘上仍是原来那份 fxa.json 采纳续跑（跨宿主方案保留有效）。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
