# 真机证据索引 · l5-host-killed-mid-install-recovery

- runId：284-20261103T203000
- 票：#284
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T11:21:49.892Z / 2026-11-03T11:22:40.403Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:\dsh-plugin\_wt263\t13（分支 impl/284-boundary-gaps，HEAD fac03dd754cdc990bd2b7c86f7fa482825e032a7）
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
| 18-assert | l5a-in-flight | taskkill 前安装确在飞（不是空窗杀宿主） | 面板 busy/进度非空且宿主 PID>0 | {"busyObserved":true,"banner":{"kind":"busy","title":"正在安装 0.0.2…关闭面板不会中断。","sub":"进度将自动轮询刷新；重新打开面板将在 1 秒内恢复显示。"},"progress":"正在安装新版本…","pid":57744} | **pass** |
| 21-assert | l5-01-killed-during-install | 安装窗内杀掉整个宿主进程树：taskkill 成功、磁盘仍基版、台账非成功 | taskkill exit=0 且磁盘 A=0.0.1 且台账不为成功 | {"pid":57744,"taskkillExit":0,"disk":{"dsh-plugin-update-fixture-a":"0.0.1"},"ledgerState":"installing"} | **pass** |
| 25-assert | l5-02-restart-truthful | 被杀重启后如实展示：不谎称「已是最新」/完成，台账非成功、磁盘仍基版 | 横幅 kind≠done 且文案不含已最新/成功；台账非成功；磁盘基版 | {"bannerKind":"failed","title":"更新失败（recovery-required）：上次安装异常中断，存在未完成任务。","sub":"重新执行安装；若持续，请按第 6 节排错","errCode":"recovery-required","ledgerState":"interrupted","disk":{"dsh-plugin-update-fixture-a":"0.0.1"}} | **pass** |
| 26-assert | l5-03-residual-evidence | 残留锁/中断可审计：raw 留 lock/queue 原文与台账 state，且面板不伪装完成 | 杀时或重启后存在 queue/lock 文件，或台账为 interrupted；面板非 done | {"killQueueFiles":["1a089baafd2442ab17f9ac25/global.lock","1a089baafd2442ab17f9ac25/queue.json"],"restartQueueFiles":["1a089baafd2442ab17f9ac25/global.lock","1a089baafd2442ab17f9ac25/queue.json"],"lockTail":"1a089baafd2442ab17f9ac25/global.lock\n{\"id\":\"32124fb0-91ab-4841-ab8d-a3be9c77e41f\",\"pluginId\":\"fxa-a\",\"pid\":57744,\"startedAt\":1793704923027}","ledgerState":"interrupted","bannerKind":"failed"} | **pass** |
| 29-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 31-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e280a81080925fdcc76eda4f9edf2559e8ae81b7fce01f326fe301220e119117 | e280a81080925fdcc76eda4f9edf2559e8ae81b7fce01f326fe301220e119117（文件数 208 / 工作树 208） | **pass** |
| 33-assert | l5-second-home | L5b 第二套隔离 home 建好且 SUT 构建一致 | sutOk=true 且基版已装 | {"homeDir":"D:\\dsh-plugin\\_wt263\\runtime\\t13-284\\runs\\284-20261103T203000\\os-home-l5b\\.dsh","sutOk":true} | **pass** |
| 37-assert | l5b-killed-in-window | 短阈值宿主安装窗内被杀（杀前安装确在飞） | busy/进度非空且 taskkill exit=0 | {"busyObserved":true,"taskkillExit":0,"panelBeforeKill":{"present":true,"plugin":"dsh-plugin-update-fixture-a","banner":{"kind":"busy","title":"正在安装 0.0.2…关闭面板不会中断。","sub":"进度将自动轮询刷新；重新打开面板将在 1 秒内恢复显示。"},"errCode":null,"settled":"","lastResort":null,"manual":{"present":true,"heading":"当前没有可用的手工命令。","code":null,"neutral":"当前没有可用的手工命令。"},"strip":["0.0.1","0.0.1","0.0.2"],"actions":[{"action":"check","text":"检查更新","disabled":true},{"action":"install","text":"正在安装…","disabled":true},{"action":"copy-diag","text":"复制诊断","disabled":false},{"action":"toggle-queue","text":"显示其他插件","disabled":false}],"progress":"正在安装新版本…"}} | **pass** |
| 39-assert | l5-04-stale-window | 短阈值下被杀安装留下的陈旧锁：过阈值后仍无假成功、磁盘未变（锁留待回收） | 等 >12000ms 后磁盘 A=0.0.1、台账非成功；lock age 或 elapsed 超阈值 | {"elapsedSinceKillMs":26356,"lockAgeMs":null,"lockFile":"73dfb4db7487fd0abe5b8137/global.lock","disk":{"dsh-plugin-update-fixture-a":"0.0.1"},"ledgerState":"installing"} | **pass** |
| 42-assert | l5b-interrupted-honest | 被杀重启如实展示中断历史（不谎称更新中/已完成） | kind=failed 且标题含「更新失败」 | {"banner":{"kind":"failed","title":"更新失败（recovery-required）：上次安装异常中断，存在未完成任务。","sub":"重新执行安装；若持续，请按第 6 节排错"},"errCode":"recovery-required"} | **pass** |
| 44-assert | l5-05-stale-lock-reclaimed | 陈旧锁被产品自行回收（未人工删锁）：重试真装成 | 重试成功：磁盘 0.0.2 + 台账成功终态，且全程未手工清理锁 | {"disk":{"dsh-plugin-update-fixture-a":"0.0.2"},"ledgerState":"completed","banner":{"kind":"done","title":"已是最新，无需更新。","sub":""}} | **pass** |
| 47-assert | l5-06-exactly-once-success | 被杀后恢复只留一条成功终态、无重复成功记录（恰一次成功） | 成功台账恰 1 份、before.json 恰 1 份、至少一次成功 exec、磁盘 0.0.2 | {"successJobs":1,"beforeFiles":1,"okExecs":1,"requests":2,"disk":{"dsh-plugin-update-fixture-a":"0.0.2"}} | **pass** |
| 49-assert | l5b-07a-restart-honest-unknown | L5b 再次重启后 A 面板首屏：新进程首屏没查过最新版时不得谎称已是最新 | 横幅 kind=idle/unknown、文案含「版本信息未知」、不含「已是最新」，并提供检查更新动作 | {"kind":"idle","title":"版本信息未知，请检查更新。","sub":"检查更新"} | **pass** |
| 51-assert | l5-07-three-faces-consistent | 恢复成功后重启：UI/磁盘/台账三面一致、无重复成功记录 | 面板已了结、build tags 0.0.2、台账恰 1 份成功 | {"banner":{"kind":"done","title":"已是最新，无需更新。","sub":""},"tags":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"successJobs":1,"disk":{"dsh-plugin-update-fixture-a":"0.0.2"}} | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 17-shot | l5a-10-in-flight-before-kill | 真 UI 点安装后安装正在进行（延迟代理拉长安装窗），即将 taskkill 本 run 宿主（外部手段，不改产品代码） | 观测到 busy/进度非空；宿主 PID 可读 | {"busyObserved":true,"panel":{"present":true,"plugin":"dsh-plugin-update-fixture-a","banner":{"kind":"busy","title":"正在安装 0.0.2…关闭面板不会中断。","sub":"进度将自动轮询刷新；重新打开面板将在 1 秒内恢复显示。"},"errCode":null,"settled":"","lastResort":null,"manual":{"present":true,"heading":"当前没有可用的手工命令。","code":null,"neutral":"当前没有可用的手工命令。"},"strip":["0.0.1","0.0.1","0.0.2"],"actions":[{"action":"check","text":"检查更新","disabled":true},{"action":"install","text":"正在安装…","disabled":true},{"action":"copy-diag","text":"复制诊断","disabled":false},{"action":"toggle-queue","text":"显示其他插件","disabled":false}],"progress":"正在安装新版本…"},"pid":57744} | **pass** | [shots\17-shot.png](shots\17-shot.png) |
| 24-shot | l5a-20-restart-after-kill | 被杀后重启：面板如实反映中断（不得谎称「已是最新」/完成），磁盘仍基版、台账非成功；残留锁考虑见 raw | 横幅 kind≠done 且文案不含已最新/更新成功；磁盘 A=0.0.1；台账非成功 | {"banner":{"kind":"failed","title":"更新失败（recovery-required）：上次安装异常中断，存在未完成任务。","sub":"重新执行安装；若持续，请按第 6 节排错"},"errCode":"recovery-required","lastResort":null,"manual":{"present":true,"heading":"手工备用命令（请复制整行执行）：","code":"dsh plugin --profile t13b add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=https://127.0.0.1:54352","neutral":""},"disk":{"dsh-plugin-update-fixture-a":"0.0.1"},"ledgerState":"interrupted","queueFiles":["1a089baafd2442ab17f9ac25/global.lock","1a089baafd2442ab17f9ac25/queue.json"],"lockTail":"1a089baafd2442ab17f9ac25/global.lock\n{\"id\":\"32124fb0-91ab-4841-ab8d-a3be9c77e41f\",\"pluginId\":\"fxa-a\",\"pid\":57744,\"startedAt\":1793704923027}"} | **pass** | [shots\24-shot.png](shots\24-shot.png) |
| 41-shot | l5b-25-restart-interrupted-honest | 短阈值格被杀重启后首屏：如实显示上次安装中断（failed/recovery-required），不谎称更新中/已最新 | 横幅 kind=failed、标题含「更新失败」 | {"banner":{"kind":"failed","title":"更新失败（recovery-required）：上次安装异常中断，存在未完成任务。","sub":"重新执行安装；若持续，请按第 6 节排错"},"errCode":"recovery-required"} | **pass** | [shots\41-shot.png](shots\41-shot.png) |
| 43-shot | l5b-30-recovered-success | 短阈值格：被杀后重启、陈旧锁由产品自行回收（全程未手工删锁/改文件）后重试安装真装成 0.0.2 | 面板已了结、磁盘 0.0.2、台账成功终态 | {"banner":{"kind":"done","title":"已是最新，无需更新。","sub":""},"disk":{"dsh-plugin-update-fixture-a":"0.0.2"},"ledgerState":"completed"} | **pass** | [shots\43-shot.png](shots\43-shot.png) |
| 50-shot | l5b-40-restart-truthful | 恢复成功后再次重启：首屏版本未知（见 l5b-07a）→ 真 UI 检查更新后三面一致（面板已了结 / 运行构建 0.0.2 / 台账恰一条成功），无重复成功记录 | 横幅「已是最新，无需更新。」、clientTag/hostTag=0.0.2、台账恰 1 份成功 | {"banner":{"kind":"done","title":"已是最新，无需更新。","sub":""},"tags":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"ledgerJobs":["completed"]} | **pass** | [shots\50-shot.png](shots\50-shot.png) |

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
- [host-launch-l5a-gen1](raw\16-host-launch-l5a-gen1.json)
- [host-kill-l5a](raw\19-host-kill-l5a.json)
- [l5a-after-kill-facts](raw\20-l5a-after-kill-facts.json)
- [host-launch-l5a-gen2](raw\22-host-launch-l5a-gen2.json)
- [l5a-restart-facts](raw\23-l5a-restart-facts.json)
- [host-stop-1](raw\27-host-stop-1.json)
- [install-baseline](raw\28-install-baseline.json)
- [sut-installed-dist](raw\30-sut-installed-dist.json)
- [l5-second-home](raw\32-l5-second-home.json)
- [host-launch-l5b-gen1](raw\34-host-launch-l5b-gen1.json)
- [host-kill-l5b](raw\35-host-kill-l5b.json)
- [l5b-kill-facts](raw\36-l5b-kill-facts.json)
- [l5b-stale-window](raw\38-l5b-stale-window.json)
- [host-launch-l5b-gen2](raw\40-host-launch-l5b-gen2.json)
- [host-stop-1](raw\45-host-stop-1.json)
- [l5b-facts](raw\46-l5b-facts.json)
- [host-launch-l5b-gen3](raw\48-host-launch-l5b-gen3.json)
- [host-stop-2](raw\52-host-stop-2.json)
- [log-fxa-a-2026-11-03](raw\53-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\54-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\55-log-fxa-c-2026-11-03.json)
- [cleanup-log-files](raw\56-cleanup-log-files.json)
- [log-fxa-a-2026-11-03](raw\57-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\58-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\59-log-fxa-c-2026-11-03.json)
- [cleanup-log-files](raw\60-cleanup-log-files.json)
- [tls-front-stop](raw\61-tls-front-stop.json)

## 清理

- 进程 l5a-gen1-host（pid 57744）：停止后存活=false
- 进程 l5a-gen2-host（pid 99036）：停止后存活=false
- 进程 l5b-gen1-host（pid 58456）：停止后存活=false
- 进程 l5b-gen2-host（pid 70808）：停止后存活=false
- 进程 l5b-gen3-host（pid 103096）：停止后存活=false
- 端口 tls-registry-front（54352）：已释放=false
- 端口 l5a-gen1-host-port（50584）：已释放=false
- 端口 l5a-gen2-host-port（52786）：已释放=false
- 端口 l5b-gen1-host-port（58689）：已释放=false
- 端口 l5b-gen2-host-port（55390）：已释放=false
- 端口 l5b-gen3-host-port（60649）：已释放=false
- 端口 registry（63745）：已释放=true
- 本地 registry：http://127.0.0.1:63745（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 l5a-gen1 已起：port=50584，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:54352）
- 宿主 l5a-gen2 已起：port=52786，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:54352）
- 宿主 l5b-gen1 已起：port=58689，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:54352）
- 宿主 l5b-gen2 已起：port=55390，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:54352）
- 宿主 l5b-gen3 已起：port=60649，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:54352）

## 备注

- 本地 registry：http://127.0.0.1:63745（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 l5a-gen1 已起：port=50584，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:54352）
- 宿主 l5a-gen2 已起：port=52786，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:54352）
- 宿主 l5b-gen1 已起：port=58689，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:54352）
- 宿主 l5b-gen2 已起：port=55390，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:54352）
- 宿主 l5b-gen3 已起：port=60649，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:54352）

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
