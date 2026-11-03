# 真机证据索引 · m4-cross-profile-concurrency

- runId：284-20261103T224418
- 票：#284
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T14:44:19.066Z / 2026-11-03T14:44:48.191Z
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
| 09-assert | 建普通 profile（CLI 入口） | createWebProfileInHome 建通道 B 的普通 profile（非 desktop） | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t14-284\284-20261103T224418\os-home\.dsh\profiles\t14hub | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t14-284\284-20261103T224418\os-home\.dsh\profiles\t14hub | **pass** |
| 11-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 12-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | ff0a6b1aea9773eced40869b73a2d3a837a9b3e98afd9c900e81d4b158e62b76 | ff0a6b1aea9773eced40869b73a2d3a837a9b3e98afd9c900e81d4b158e62b76（文件数 208 / 工作树 208） | **pass** |
| 16-assert | 更新前基版在盘 | 场景声明 install 里的包 @0.0.1 已装进 profile，SUT 钉版与工作树 dist 一致（M1/M2 的 C 是孤儿目标，初始不在册，由中枢按方案补装，故不参与本断言） | 声明在册包（a,b）磁盘版本=0.0.1 | 已声明包全部=0.0.1；未在册=["c"] | **pass** |
| 18-assert | 变体 0.0.2 已发布 | 场景声明 variants 发布到仓库外 verdaccio | A/B/C 均有 0.0.2，A 变体含批量坞/新版 UI | A=0.0.2；baseline=0.0.1 | **pass** |
| 22-assert | 中枢/批量目录定位 | 按 profileDir 短哈希复算队列目录，并与盘上实际目录对照（首次安装前目录可能尚未创建） | 盘上目录数 ≤1，且存在时=3fc2489adb28a86abff9c708 | 盘上=[]；复算=3fc2489adb28a86abff9c708 | **pass** |
| 24-assert | M4 两个普通 profile 就绪（同一 home） | createWebProfileInHome 建 t14p1/t14p2（非 desktop）；两 profileDir 互异 | exit 都为 0；profileDir 互异且都在 <home>/profiles 下 | p1.exit=0；p2.exit=0；p1=D:\dsh-plugin\_wt263\runtime\t14-284\284-20261103T224418\os-home\.dsh\profiles\t14p1；p2=D:\dsh-plugin\_wt263\runtime\t14-284\284-20261103T224418\os-home\.dsh\profiles\t14p2 | **pass** |
| 26-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 27-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 29-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 30-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 33-assert | M4 两个 profile 更新前基版在盘（A/B@0.0.1） | 两个 profile 各自经 CLI 装上 A/B 基版，node_modules 包版本与清单 dependencies 一致 | p1/p2 的 A=0.0.1 且 B=0.0.1；两 profile dependencies 各自含 A/B | p1=0.0.1/0.0.1；p2=0.0.1/0.0.1；deps p1={"a":"0.0.1","b":"0.0.1","c":null}；deps p2={"a":"0.0.1","b":"0.0.1","c":null} | **pass** |
| 35-assert | M4 两 profile 的队列路径互异（按 profileDir 短哈希隔离） | 复算两套 update-queue 路径；profileDir 不同 ⇒ 短哈希不同 | hash1≠hash2；两套 queue/batch/lease 路径互异 | hash1=bd5189e28a3b2dafb88cc9ab；hash2=a328f0af2908efbb800dbcf8；queue 相同=false | **pass** |
| 37-assert | 宿主启动（通道 B，m4-p1） | startCliHost 起 DSH web 宿主（隔离 USERPROFILE/home/profile） | boot 成功、HTTP 电话入口可用、pid>0 | pid=40412，port=60678，bootMs=1931 | **pass** |
| 39-assert | 宿主启动（通道 B，m4-p2） | startCliHost 起 DSH web 宿主（隔离 USERPROFILE/home/profile） | boot 成功、HTTP 电话入口可用、pid>0 | pid=20304，port=60690，bootMs=1911 | **pass** |
| 41-assert | M4 两个宿主各绑一个 profile 同时在线 | 两个 DSH web 宿主同 home、不同 profileName（pid/端口互异） | 两宿主 pid>0 且互异；端口互异 | p1.pid=40412 p1.port=60678；p2.pid=20304 p2.port=60690 | **pass** |
| 43-assert | M4 两个宿主各自的批量检查电话受理（各 3 行 a/b/c） | 两个宿主分别建自己的批量会话（同 home 不同 profile，互不共享会话） | 两宿主 ok=true；rows 各=[a,b,c] | p1.ok=true rows=["a","b","c"]；p2.ok=true rows=["a","b","c"] | **pass** |
| 45-assert | M4 两批批量安装电话已同一 tick 发出（不等回包） | 两个宿主各自开始推进三包批量；之后轮询采样两套盘上状态 | 两批均落盘 batch.json 且曾同时有非终态行（安装窗重叠） | fireAt=1793717079243；hosts=40412/20304 | **pass** |
| 48-assert | M4 两个安装窗真实重叠：采样到两批同时有非终态行（不互斥） | 并发采样两套 batch.json：两批同一时刻都还在装（active>0），证明按 profile 隔离而非串行排队 | 至少一帧 p1.active>0 且 p2.active>0；两批 batchId 互异 | at=1793717079367；p1={"a":"installing","b":"ready","c":"ready"}；p2={"a":"installing","b":"ready","c":"ready"}；batchIds=mw0su47h-6j3jtdhxhq/mw0su47i-ixf3kjlk8m | **pass** |
| 49-assert | M4 两 profile 的队列/corral 各自持有：owner/lease 采样互不占用 | queue.json owner 与 hub/lease.json 按 profile 各有一套；采样到两 owner 同时在、且不属于同一 profile | 至少一帧两 queue owner 同时非空；owner 互异；lease pid 属于各自宿主 | at=1793717079734；owners=[object Object]/[object Object]；leases={"p1":{"pid":40412,"generation":1,"driverId":"dsh-hub:40412:7s7edcqsop"},"p2":{"pid":20304,"generation":1,"driverId":"dsh-hub:20304:zmoedqxk0a"}} | **pass** |
| 50-assert | M4 两批都推进到三行 done（同一 tick 发起、各自装完 0.0.2） | 两套 batch.json 的 entries 全部 phase=done targetVersion=0.0.2 | p1/p2 各 3 行 done 0.0.2；两 batch id 互异 | p1={"id":"mw0su47h-6j3jtdhxhq","phases":{"a":"done","b":"done","c":"done"},"targets":["0.0.2","0.0.2","0.0.2"]}；p2={"id":"mw0su47i-ixf3kjlk8m","phases":{"a":"done","b":"done","c":"done"},"targets":["0.0.2","0.0.2","0.0.2"]} | **pass** |
| 51-assert | M4 两电话回包都 ok（无一方被另一方挡成 busy） | 两批 batchInstall HTTP 电话的最终回包 | 两回包均 ok=true（settle=resolved） | [{"who":"p1","ok":true,"error":null,"rejected":null},{"who":"p2","ok":true,"error":null,"rejected":null}] | **pass** |
| 53-assert | M4 两个 profile 各自的面板批量三行 done 0.0.2 | 两宿主的 batchStatus 回包（各自面板数据源，互不串 profile） | p1.ok/p2.ok=true；各 3 行 done targetVersion=0.0.2 | p1={"ok":true,"rows":[{"key":"a","phase":"done","targetVersion":"0.0.2"},{"key":"b","phase":"done","targetVersion":"0.0.2"},{"key":"c","phase":"done","targetVersion":"0.0.2"}]}；p2={"ok":true,"rows":[{"key":"a","phase":"done","targetVersion":"0.0.2"},{"key":"b","phase":"done","targetVersion":"0.0.2"},{"key":"c","phase":"done","targetVersion":"0.0.2"}]} | **pass** |
| 54-assert | M4 两个中枢各自 finished done3 failed0 activeInstall=null（无虚假 busy/无抢占） | 两宿主 updateHubStatus 回包的中枢状态 | 两中枢 state=finished、progress.done=3、failed=0、activeInstall=null | p1={"ok":true,"sessions":[{"sessionId":"mw0su47h-6j3jtdhxhq","owner":"fxa","selfKey":"a","state":"finished","updatedAt":1793717084054,"progress":{"total":3,"done":3,"failed":0,"skipped":0,"current":0,"pending":0,"finished":true},"rows":[{"key":"a","title":"夹具 A 本体","phase":"done","targetVersion":"0.0.2","installedVersion":"0.0.1","latestVersion":"0.0.2","restartRequired":false,"error":null},{"key":"b","title":"夹具 B","phase":"done","targetVersion":"0.0.2","installedVersion":"0.0.1","latestVersion":"0.0.2","restartRequired":false,"error":null},{"key":"c","title":"夹具 C","phase":"done","targetVersion":"0.0.2","installedVersion":null,"latestVersion":"0.0.2","restartRequired":false,"error":null}],"rowsTotal":3,"rowsTruncated":false}],"activeInstall":null}；p2={"ok":true,"sessions":[{"sessionId":"mw0su47i-ixf3kjlk8m","owner":"fxa","selfKey":"a","state":"finished","updatedAt":1793717083992,"progress":{"total":3,"done":3,"failed":0,"skipped":0,"current":0,"pending":0,"finished":true},"rows":[{"key":"a","title":"夹具 A 本体","phase":"done","targetVersion":"0.0.2","installedVersion":"0.0.1","latestVersion":"0.0.2","restartRequired":false,"error":null},{"key":"b","title":"夹具 B","phase":"done","targetVersion":"0.0.2","installedVersion":"0.0.1","latestVersion":"0.0.2","restartRequired":false,"error":null},{"key":"c","title":"夹具 C","phase":"done","targetVersion":"0.0.2","installedVersion":null,"latestVersion":"0.0.2","restartRequired":false,"error":null}],"rowsTotal":3,"rowsTruncated":false}],"activeInstall":null} | **pass** |
| 57-assert | M4 两个 profile 磁盘各自三包 0.0.2（清单/node_modules 一致） | 两 profile 的 dsh.profile.dependencies 与 node_modules 包版本 | p1/p2 的 a/b/c 包版本与 dependencies 都=0.0.2；manifest 可解析 | p1={"deps":{"a":"0.0.2","b":"0.0.2","c":"0.0.2"},"nodeModules":{"a":"0.0.2","b":"0.0.2","c":"0.0.2"}}；p2={"deps":{"a":"0.0.2","b":"0.0.2","c":"0.0.2"},"nodeModules":{"a":"0.0.2","b":"0.0.2","c":"0.0.2"}} | **pass** |
| 59-assert | M4 两个 profile 台账各自完整：三包各恰 1 条成功终态 target=0.0.2（A previous=0.0.1；B/C 本批首装可 null） | 按 profileDir 短哈希分组读 <home>/updates/<pluginId>/<hash>/state.json | hash1/hash2 各 fxa-a/fxa-b/fxa-c 恰 1 条成功终态；A 的 previous=0.0.1；B/C previous∈{null,0.0.1}；无第三套 hash 的写入 | p1.ok=true；p2.ok=true；foreign=[]；counts={"bd5189e28a3b2dafb88cc9ab":{"fxa-a":1,"fxa-b":1,"fxa-c":1},"a328f0af2908efbb800dbcf8":{"fxa-a":1,"fxa-b":1,"fxa-c":1}} | **pass** |
| 60-assert | M4 盘上正好两套 update-queue 目录（=两 profile 短哈希），没有抢占同一目录 | list <home>/update-queue 与两 profile 短哈希对照 | 盘上目录集=["a328f0af2908efbb800dbcf8","bd5189e28a3b2dafb88cc9ab"] | ["a328f0af2908efbb800dbcf8","bd5189e28a3b2dafb88cc9ab"] | **pass** |
| 71-assert | 收尾：宿主进程与端口无残留 | 关闭所有宿主后核实 pid 不在、端口空闲 | remainingPids=[]、所有端口 free=true | remainingPids=[]；portChecks=[{"label":"m4-p1","port":60678,"free":true},{"label":"m4-p2","port":60690,"free":true}] | **pass** |
| 73-assert | M4 两个 profile 的安装窗在日志里真重叠（B 包两 profile 的成功 exec 时间窗有交集） | 停两宿主后读日志：fxa-b 两 profile 各 1 条 ok exec 且时间窗重叠；fxa-c 至少 1 条（日志行齐全时同样要求重叠） | okExecB=2 且 overlapB≥1；okExecC≥1；okExecC=2 时 overlapC≥1 | okExecB=2；okExecC=2；overlapB=1；overlapC=1 | **pass** |
| 74-assert | M4 无跨 profile busy/抢占：日志里没有 update-busy / busy-owner 异常 | 扫 update.lock.anomaly(busy-owner) 与含 update-busy 的字段；两批都 ok 已完成（上一条） | busyRows=[] | [] | **pass** |

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
- [m4-pnpm-supply-chain-isolation](raw\19-m4-pnpm-supply-chain-isolation.json)
- [host-env](raw\20-host-env.json)
- [hub-paths](raw\21-hub-paths.json)
- [m4-profile-create](raw\23-m4-profile-create.json)
- [install-baseline](raw\25-install-baseline.json)
- [install-baseline](raw\28-install-baseline.json)
- [disk-m4-p1-before](raw\31-disk-m4-p1-before.json)
- [disk-m4-p2-before](raw\32-disk-m4-p2-before.json)
- [m4-isolated-paths](raw\34-m4-isolated-paths.json)
- [cli-host-launch-m4-p1](raw\36-cli-host-launch-m4-p1.json)
- [cli-host-launch-m4-p2](raw\38-cli-host-launch-m4-p2.json)
- [m4-hosts](raw\40-m4-hosts.json)
- [m4-batch-check](raw\42-m4-batch-check.json)
- [m4-batch-install-fire](raw\44-m4-batch-install-fire.json)
- [m4-concurrency-samples](raw\46-m4-concurrency-samples.json)
- [m4-final-batches](raw\47-m4-final-batches.json)
- [m4-panel-finals](raw\52-m4-panel-finals.json)
- [disk-m4-p1-after](raw\55-disk-m4-p1-after.json)
- [disk-m4-p2-after](raw\56-disk-m4-p2-after.json)
- [m4-ledger](raw\58-m4-ledger.json)
- [m4-stop-settle](raw\61-m4-stop-settle.json)
- [host-stop-m4-p1-after-batch](raw\62-host-stop-m4-p1-after-batch.json)
- [host-stop-m4-p2-after-batch](raw\63-host-stop-m4-p2-after-batch.json)
- [log-fxa-a-2026-11-03](raw\64-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\65-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\66-log-fxa-c-2026-11-03.json)
- [log-fxb-b-2026-11-03](raw\67-log-fxb-b-2026-11-03.json)
- [log-fxb-c-2026-11-03](raw\68-log-fxb-c-2026-11-03.json)
- [logs-final](raw\69-logs-final.json)
- [cleanup-verify](raw\70-cleanup-verify.json)
- [m4-log-timeline](raw\72-m4-log-timeline.json)

## 清理

- 进程 cli-host-m4-p1（pid 40412）：停止后存活=false
- 进程 cli-host-m4-p2（pid 20304）：停止后存活=false
- 端口 cli-host-m4-p1-port（60678）：已释放=true
- 端口 cli-host-m4-p2-port（60690）：已释放=true
- 端口 registry（61698）：已释放=true
- 本地 registry：http://127.0.0.1:61698（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- M4 并发注入：同一 home、两个非 desktop 普通 profile（t14p1/t14p2）各起一个 web 宿主；两批 batchInstall 在同一 tick 用 HTTP 电话发出（面板「全部更新」按钮背后是同一入口）。本格不开浏览器：断言对象是更新队列/中枢锁按 profile 隔离与两个安装窗真并发，UI 三包入口证据由 M3 的同一面板承担。

## 备注

- 本地 registry：http://127.0.0.1:61698（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- M4 并发注入：同一 home、两个非 desktop 普通 profile（t14p1/t14p2）各起一个 web 宿主；两批 batchInstall 在同一 tick 用 HTTP 电话发出（面板「全部更新」按钮背后是同一入口）。本格不开浏览器：断言对象是更新队列/中枢锁按 profile 隔离与两个安装窗真并发，UI 三包入口证据由 M3 的同一面板承担。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
