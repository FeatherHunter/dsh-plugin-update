# 真机证据索引 · l2-registry-unreachable

- runId：284-20261103T191400
- 票：#284
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T10:50:28.470Z / 2026-11-03T10:51:16.694Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:\dsh-plugin\_wt263\t13（分支 impl/284-boundary-gaps，HEAD 5e3b7d9dcd4203df62463391c185c8677b316aae）
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
| 18-assert | l2-01-check-before-kill | 失败注入前检查更新可用（失败后的可归因性依赖这一格） | 可更新横幅原文精确匹配 | {"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"} | **pass** |
| 21-assert | l2-02-registry-killed | registry 整体不可达（外部注入，真机事实） | 杀前 ping ok=true、杀后 ping ok=false（端口已释放） | {"pingBefore":{"ok":true,"status":200},"pingAfter":{"ok":false,"status":null,"error":"fetch failed"}} | **pass** |
| 23-assert | l2-03-failure-banner | 安装失败面是失败档而不是假成功 | kind=failed、标题含「更新失败」、errCode 非空 | {"banner":{"kind":"failed","title":"更新失败（check-failed）：版本信息查询失败（网络 / 数据源 / 限流）。","sub":"稍后重新查询；若持续，请提交诊断信息至插件作者"},"errCode":"check-failed"} | **pass** |
| 27-assert | l2-04-detail-network-original | 失败说法与真实网络事实一致：人话格指向网络/数据源，注入层原始错误留 raw | 人话格出现「网络/数据源/连接/ECONNREFUSED 类」措辞；注入层 ping 原始错误非空并写 raw | {"humanText":"更新失败（check-failed）：版本信息查询失败（网络 / 数据源 / 限流）。 \| 稍后重新查询；若持续，请提交诊断信息至插件作者 \| ","humanNetwork":true,"injectionError":"fetch failed","detailHasNetwork":true} | **pass** |
| 28-assert | l2-05-exec-and-fail | 失败事件与「走到哪一步」自洽：gate 拒绝不跑 pnpm 不落 job；exec 失败跑过 pnpm 且非零退出、台账 failed | check-failed → stage=gate reason=gate-refused exec=0 且台账无成功终态；install-failed → stage=exec exec≥1 全 false、台账 failed | {"errCode":"check-failed","failStage":"gate","failReason":"gate-refused","failCodeLogged":"check-failed","execs":0,"okExecs":0,"ledgerState":"missing"} | **pass** |
| 29-assert | l2-06-no-retry-storm | 失败后静置 8s 无自动重试（恰一次安装尝试） | update.install.request/fail 各恰 1 条；exec 计数与失败路径一致；前后两次读日志计数不增长 | {"countAtFail":{"requests":1,"execs":0,"fails":1},"countAtWindowEnd":{"requests":1,"execs":0,"fails":1},"liveCountsStable":true} | **pass** |
| 30-assert | l2-07-no-false-success | 无假成功：磁盘仍基版、台账无成功终态、面板失败档 | 磁盘 A=0.0.1、台账 state 不是 completed/restart-required（gate 路径可为 missing，因为没打开 job）、横幅 kind=failed | {"disk":{"dsh-plugin-update-fixture-a":"0.0.1"},"ledgerState":"missing","bannerKind":"failed"} | **pass** |
| 31-assert | l2-08-no-carrier-in-human | #267 诚实面：registry/网络类失败的人话格/台账 detail 不出现载体命令 | 横幅标题+副文案+台账 message 不匹配 dsh plugin --profile … add --save-exact … | {"carrierInHuman":false,"humanText":"更新失败（check-failed）：版本信息查询失败（网络 / 数据源 / 限流）。 \| 稍后重新查询；若持续，请提交诊断信息至插件作者 \| "} | **pass** |
| 33-assert | l2-09-registry-restored | 同 storage/同端口重启本 run 私有 registry（外部恢复手段） | 端口与杀前相同且 /-/ping 恢复 ok | {"samePort":true,"ping":{"ok":true,"status":200}} | **pass** |
| 36-assert | l2-10-retry-check | 恢复后重新检查仍是可更新（不因上一轮失败而谎报最新） | 可更新横幅原文精确匹配 | {"beforeRetry":{"kind":"idle","title":"版本信息未知，请检查更新。","sub":"检查更新"},"afterCheck":{"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"}} | **pass** |
| 38-assert | l2-11-retry-success | 恢复后重试真装成 0.0.2（不是假成功） | 磁盘 A=0.0.2、台账成功终态且 target=0.0.2、面板已了结 | {"disk":{"dsh-plugin-update-fixture-a":"0.0.2"},"ledgerState":"completed","banner":{"kind":"done","title":"已是最新，无需更新。","sub":""}} | **pass** |
| 41-assert | l2-12-single-success-record | 补一次成功后台账只留一条成功终态（无重复成功记录） | A 的 state.json 恰 1 份且 state∈{completed,restart-required}；before.json 恰 1 份 | {"ledgerJobs":[{"file":"fxa-a/6ac707cc17b61675c1631f46/state.json","state":"completed"}],"beforeFiles":["fxa-a/6ac707cc17b61675c1631f46/before.json"]} | **pass** |
| 42-assert | l2-13-attempts | 两次 UI 安装尝试 = 2 条 request、1 条 fail（失败一次 + 成功一次），无额外自动重试 | update.install.request=2、update.install.fail=1（exec 行可能因自更新日志轮换缺失，不作硬断言） | requests=2 fails=1 execs=1 | **pass** |
| 44-assert | l2-14a-restart-honest-unknown | L2 第二次重启后 A 面板首屏：新进程首屏没查过最新版时不得谎称已是最新 | 横幅 kind=idle/unknown、文案含「版本信息未知」、不含「已是最新」，并提供检查更新动作 | {"kind":"idle","title":"版本信息未知，请检查更新。","sub":"检查更新"} | **pass** |
| 46-assert | l2-14-restart-truthful | 重启后如实展示：已最新 0.0.2，不残留失败谎报、无重复成功记录 | 面板已了结、build tags=0.0.2、台账恰 1 份成功 | {"banner":{"kind":"done","title":"已是最新，无需更新。","sub":""},"tags":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"ledgerCount":1,"ledgerState":"completed"} | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 17-shot | l2-10-check-before-kill | 杀 registry 前对照：真 UI 点「检查更新」后面板列出 0.0.2 可更新 | 横幅标题精确等于「有新版本 0.0.2 可安装（当前版本 0.0.1）。」 | {"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"} | **pass** | [shots\17-shot.png](shots\17-shot.png) |
| 20-shot | l2-15-registry-killed | 本 run 私有 verdaccio 已被停（外部手段）：registry 探活从 200 变为不可达；页面仍在但安装将失败 | 杀前 /-/ping 200、杀后连接失败；注入命令与输出入 raw | {"pingBefore":{"ok":true,"status":200},"pingAfter":{"ok":false,"error":"fetch failed"}} | **pass** | [shots\20-shot.png](shots\20-shot.png) |
| 22-shot | l2-20-failure-panel | registry 不可达时真 UI 点安装：失败横幅（人话格）+ 错误码 + 手工备用区（若有） | 横幅 kind=failed、标题含「更新失败」、errCode 非空且指向真实失败类别；不得呈现「已是最新」/更新成功 | {"banner":{"kind":"failed","title":"更新失败（check-failed）：版本信息查询失败（网络 / 数据源 / 限流）。","sub":"稍后重新查询；若持续，请提交诊断信息至插件作者"},"bannerKind":"failed","errCode":"check-failed","manual":{"present":true,"heading":"手工备用命令（请复制整行执行）：","code":"dsh plugin --profile t13b add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=https://127.0.0.1:62521","neutral":""},"lastResort":null} | **pass** | [shots\22-shot.png](shots\22-shot.png) |
| 35-shot | l2-30-retry-check | registry 恢复后重启宿主：面板不再残留失败谎报，重新检查仍如实列出 0.0.2 | 重试前横幅为失败/已了结真相面；点检查后横幅原文「有新版本 0.0.2 可安装（当前版本 0.0.1）。」 | {"before":{"kind":"idle","title":"版本信息未知，请检查更新。","sub":"检查更新"},"check":{"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"}} | **pass** | [shots\35-shot.png](shots\35-shot.png) |
| 37-shot | l2-40-retry-success | 重试安装真装成 0.0.2：面板已了结、磁盘 0.0.2、台账成功终态 | 横幅「已是最新，无需更新。」、磁盘 A=0.0.2、台账 state∈{completed,restart-required} 且 target=0.0.2 | {"banner":{"kind":"done","title":"已是最新，无需更新。","sub":""},"disk":{"dsh-plugin-update-fixture-a":"0.0.2"},"ledger":{"state":"completed","targetVersion":"0.0.2"}} | **pass** | [shots\37-shot.png](shots\37-shot.png) |
| 45-shot | l2-50-restart-settled | 第二次重启后：首屏先如实说版本未知（见 l2-14a），真 UI 检查更新后面板已了结、运行构建 v0.0.2、台账仍恰一条成功终态 | 横幅「已是最新，无需更新。」、clientTag/hostTag=0.0.2、A 的 state.json 恰 1 份且成功 | {"banner":{"kind":"done","title":"已是最新，无需更新。","sub":""},"tags":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"ledgerJobs":[{"file":"fxa-a/6ac707cc17b61675c1631f46/state.json","state":"completed"}]} | **pass** | [shots\45-shot.png](shots\45-shot.png) |

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
- [host-launch-l2-gen1](raw\16-host-launch-l2-gen1.json)
- [l2-registry-kill](raw\19-l2-registry-kill.json)
- [l2-failure-window](raw\24-l2-failure-window.json)
- [host-stop-0](raw\25-host-stop-0.json)
- [l2-failure-facts](raw\26-l2-failure-facts.json)
- [l2-registry-restart](raw\32-l2-registry-restart.json)
- [host-launch-l2-gen2](raw\34-host-launch-l2-gen2.json)
- [host-stop-1](raw\39-host-stop-1.json)
- [l2-success-facts](raw\40-l2-success-facts.json)
- [host-launch-l2-gen3](raw\43-host-launch-l2-gen3.json)
- [host-stop-2](raw\47-host-stop-2.json)
- [l2-restarted-registry-stop](raw\48-l2-restarted-registry-stop.json)
- [log-fxa-a-2026-11-03](raw\49-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\50-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\51-log-fxa-c-2026-11-03.json)
- [cleanup-log-files](raw\52-cleanup-log-files.json)
- [tls-front-stop](raw\53-tls-front-stop.json)

## 清理

- 进程 l2-gen1-host（pid 102680）：停止后存活=false
- 进程 l2-gen2-host（pid 54136）：停止后存活=false
- 进程 l2-gen3-host（pid 43000）：停止后存活=false
- 端口 tls-registry-front（62521）：已释放=false
- 端口 l2-gen1-host-port（57168）：已释放=false
- 端口 verdaccio-killed（55400）：已释放=true
- 端口 l2-gen2-host-port（59955）：已释放=false
- 端口 l2-gen3-host-port（58745）：已释放=false
- 端口 verdaccio-restarted（55400）：已释放=true
- 端口 registry（55400）：已释放=true
- 本地 registry：http://127.0.0.1:55400（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 l2-gen1 已起：port=57168，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:62521）
- 宿主 l2-gen2 已起：port=59955，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:62521）
- 宿主 l2-gen3 已起：port=58745，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:62521）

## 备注

- 本地 registry：http://127.0.0.1:55400（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 l2-gen1 已起：port=57168，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:62521）
- 宿主 l2-gen2 已起：port=59955，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:62521）
- 宿主 l2-gen3 已起：port=58745，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:62521）

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
