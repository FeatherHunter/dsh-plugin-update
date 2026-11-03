# 真机证据索引 · l1-same-process-two-plugins-concurrent

- runId：284-20261103T191200
- 票：#284
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T10:48:52.626Z / 2026-11-03T10:50:14.442Z
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
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1, dsh-plugin-update-fixture-b@0.0.1 | **pass** |
| 10-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 11-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e280a81080925fdcc76eda4f9edf2559e8ae81b7fce01f326fe301220e119117 | e280a81080925fdcc76eda4f9edf2559e8ae81b7fce01f326fe301220e119117（文件数 208 / 工作树 208） | **pass** |
| 14-assert | setup-sut | 通道 B profile 里装的 SUT 与工作树构建一致 | installed distDigest === worktree distDigest | true | **pass** |
| 15-assert | setup-base-disk | 基版安装后磁盘版本与声明一致 | {"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":"0.0.1"} | dsh-plugin-update-fixture-a=0.0.1, dsh-plugin-update-fixture-b=0.0.1 | **pass** |
| 19-assert | l1-01-both-checked | 并发注入前两个目标都可安装 | A/B 可更新横幅原文精确匹配 | {"a":{"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"},"b":{"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"}} | **pass** |
| 22-assert | l1-02-race-serialized-or-honest-busy | 同进程两插件并发安装：串行落定或后到者诚实忙碌（不谎称已更新） | 并发窗口内 exec 总数<=1 或出现队列事件；后到者横幅为忙碌/失败/排队/阻挡档，或诚实 idle（明确说有新版但当前装不了/版本信息未知），或仍诚实显示「有新版本可安装」且其磁盘/台账未变（轮询未回填，非假最新） | {"raceExecTotal":1,"raceSerialized":true,"raceLooserKind":"idle","raceLooserTitle":"有新版本 0.0.2，但当前无法安装；请重新检查更新后重试。","raceLooserUpdateHonest":false,"queueEvents":4,"lockAnomalies":0} | **pass** |
| 23-assert | l1-03-no-fake-latest-at-race | 并发现场无假最新：后到面板在自己磁盘未变时不得显示「已是最新」 | 后到者 kind!==done 且文案不含「已是最新」（其磁盘仍是 0.0.1；修后诚实档为「有新版本 X，但当前无法安装」） | {"raceDisk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.1"},"raceWinner":"dsh-plugin-update-fixture-a","raceLooserKind":"idle","raceLooserTitle":"有新版本 0.0.2，但当前无法安装；请重新检查更新后重试。"} | **pass** |
| 24-assert | l1-retry-ui-dsh-plugin-update-fixture-b-click | L1 后到者 B：面板给出可点的安装按钮并在 90s 内点下 | install 按钮可用（不可用时先点检查更新、等检查回填）；点击成功 | {"clickedAt":"2026-11-03T10:49:23.345Z","lastKind":"update","lastTitle":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","timeoutMs":90000} | **pass** |
| 25-assert | l1-retry-ui-dsh-plugin-update-fixture-b-accepted | L1 后到者 B：点击后宿主真的接单（不是按钮没接线的空点） | 90s 内面板进入在飞/排队档，或日志出现该包的 update.install.request（若此前被自己的陈旧排队意图挡住，产品回收后重试点击） | {"acceptedKind":"busy","requestCount":0,"acceptAttempts":2} | **pass** |
| 29-assert | l1-04-each-one-success | 两包各恰一次成功、各一条成功台账、无重复成功记录、无跨目标污染 | A/B 各恰 1 份成功 state.json + 1 份 before.json；target 各为 0.0.2；磁盘各 0.0.2 | {"jobsA":1,"successJobsA":1,"targetA":"0.0.2","jobsB":1,"successJobsB":1,"targetB":"0.0.2","beforeA":1,"beforeB":1,"disk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2"}} | **pass** |
| 30-assert | l1-05-attempts-and-tags | 并发窗口只产生必要尝试，无重试风暴与假失败；两包客户端构建都是 0.0.2（宿主侧旧构建等重启后换，见 l1-06） | install.request 总数<=3（两包各首次 + 至多一次后到者重试）；失败行只允许真实忙碌拒绝（gate-refused/update-busy）；两包 clientTag=0.0.2 | {"requestTotal":2,"failTotal":3,"failCodes1":["update-busy/gate-refused","update-busy/gate-refused","update-busy/gate-refused"],"tags":{"a":{"clientTag":"client v0.0.2","hostTag":"host v0.0.1"},"b":{"clientTag":"client v0.0.2","hostTag":"host v0.0.1"}}} | **pass** |
| 32-assert | l1-06a-restart-honest-unknown | L1 重启后 A 面板首屏：新进程首屏没查过最新版时不得谎称已是最新 | 横幅 kind=idle/unknown、文案含「版本信息未知」、不含「已是最新」，并提供检查更新动作 | {"kind":"idle","title":"版本信息未知，请检查更新。","sub":"检查更新"} | **pass** |
| 33-assert | l1-06b-restart-honest-unknown | L1 重启后 B 面板首屏：新进程首屏没查过最新版时不得谎称已是最新 | 横幅 kind=idle/unknown、文案含「版本信息未知」、不含「已是最新」，并提供检查更新动作 | {"kind":"idle","title":"版本信息未知，请检查更新。","sub":"检查更新"} | **pass** |
| 35-assert | l1-06-restart-truthful | 重启后真 UI 检查更新，不回退、不重复成功记录（首屏诚实性见 l1-06a/b） | 两面板已了结、build tags=0.0.2、两包各 1 条成功台账 | {"tags":{"a":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"b":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"}},"jobsA":["completed"],"jobsB":["completed"]} | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 18-shot | l1-10-both-checked | 同一宿主进程内 A、B 两个单包面板都检查到 0.0.2 可更新（并发点安装前的对照） | 两个面板横幅都精确等于「有新版本 0.0.2 可安装（当前版本 0.0.1）。」 | {"a":{"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"},"b":{"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"}} | **pass** | [shots\18-shot.png](shots\18-shot.png) |
| 21-shot | l1-20-race-observed | 同一宿主进程里两个面板几乎同时点安装后的现场：一个安装已落定/进行中，另一个诚实忙碌/失败（不谎称已更新） | 并发窗口内恰一个安装真跑（或第二个进队列），后到者不得显示「已是最新」而磁盘未变；面板时间线与日志/磁盘一致 | {"raceDisk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.1"},"raceWinner":"dsh-plugin-update-fixture-a","raceLooser":{"kind":"idle","title":"有新版本 0.0.2，但当前无法安装；请重新检查更新后重试。","errCode":null,"actions":["check","install","copy-manual","copy-diag","toggle-queue"]},"raceExecTotal":1,"raceSerialized":true,"queueEvents":4,"lockAnomalies":0} | **pass** | [shots\21-shot.png](shots\21-shot.png) |
| 26-shot | l1-25-both-settled | 后到者重试/自动续跑完成：A、B 两个面板都已了结，磁盘 0.0.2，台账各一条成功终态 | 装完首屏诚实未知（读取器换代）→ 真 UI 各点一次检查更新后两面板「已是最新，无需更新。」、磁盘 A/B=0.0.2、台账各一条成功终态且 target=0.0.2 | {"bannerA":{"kind":"done","title":"已是最新，无需更新。","sub":""},"bannerB":{"kind":"done","title":"已是最新，无需更新。","sub":""},"tags":{"a":{"clientTag":"client v0.0.2","hostTag":"host v0.0.1"},"b":{"clientTag":"client v0.0.2","hostTag":"host v0.0.1"}},"ledgerA":"completed","ledgerB":"completed"} | **pass** | [shots\26-shot.png](shots\26-shot.png) |
| 34-shot | l1-30-restart-truthful | 重启宿主后：首屏先如实说「版本信息未知」（已由 l1-06a/b 断言），真 UI 点检查更新后 A/B 两面板均「已是最新」，运行构建 0.0.2，两包台账仍各恰一条成功终态 | 首屏不谎称已是最新；检查后两面板已了结、clientTag/hostTag=0.0.2、A/B 各恰 1 份成功 state.json | {"a":{"kind":"done","title":"已是最新，无需更新。","sub":""},"b":{"kind":"done","title":"已是最新，无需更新。","sub":""},"tags":{"a":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"b":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"}},"jobsA":1,"jobsB":1} | **pass** | [shots\34-shot.png](shots\34-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [tls-registry-front](raw\07-tls-registry-front.json)
- [isolation-facts](raw\08-isolation-facts.json)
- [install-baseline](raw\09-install-baseline.json)
- [sut-installed-dist](raw\12-sut-installed-dist.json)
- [fixture-publication](raw\16-fixture-publication.json)
- [host-launch-l1-gen1](raw\17-host-launch-l1-gen1.json)
- [l1-race-observations](raw\20-l1-race-observations.json)
- [host-stop-0](raw\27-host-stop-0.json)
- [l1-final-facts](raw\28-l1-final-facts.json)
- [host-launch-l1-gen2](raw\31-host-launch-l1-gen2.json)
- [host-stop-1](raw\36-host-stop-1.json)
- [log-fxa-a-2026-11-03](raw\37-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\38-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\39-log-fxa-c-2026-11-03.json)
- [log-fxb-b-2026-11-03](raw\40-log-fxb-b-2026-11-03.json)
- [log-fxb-c-2026-11-03](raw\41-log-fxb-c-2026-11-03.json)
- [cleanup-log-files](raw\42-cleanup-log-files.json)
- [tls-front-stop](raw\43-tls-front-stop.json)

## 清理

- 进程 l1-gen1-host（pid 105568）：停止后存活=false
- 进程 l1-gen2-host（pid 90344）：停止后存活=false
- 端口 tls-registry-front（52603）：已释放=false
- 端口 l1-gen1-host-port（49609）：已释放=false
- 端口 l1-gen2-host-port（50362）：已释放=false
- 端口 registry（58709）：已释放=true
- 本地 registry：http://127.0.0.1:58709（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 l1-gen1 已起：port=49609，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:52603）
- L1 同一 evaluate tick 点击 A/B 安装：{"a":true,"b":true}
- L1 后到者 B：第 1 次点安装（此前未被接单，面板 update；距上次 1793702967373ms）
- L1 后到者 B：第 2 次点安装（此前未被接单，面板 update；距上次 1793703002516ms）
- L1 后到者 B：重试安装已把 dsh-plugin-update-fixture-b 装到 0.0.2
- 宿主 l1-gen2 已起：port=50362，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:52603）

## 备注

- 本地 registry：http://127.0.0.1:58709（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 l1-gen1 已起：port=49609，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:52603）
- L1 同一 evaluate tick 点击 A/B 安装：{"a":true,"b":true}
- L1 后到者 B：第 1 次点安装（此前未被接单，面板 update；距上次 1793702967373ms）
- L1 后到者 B：第 2 次点安装（此前未被接单，面板 update；距上次 1793703002516ms）
- L1 后到者 B：重试安装已把 dsh-plugin-update-fixture-b 装到 0.0.2
- 宿主 l1-gen2 已起：port=50362，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:52603）

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
