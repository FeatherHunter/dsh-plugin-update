# 真机证据索引 · j1-log-contract-coverage

- runId：273-20261103T093814-p30
- 票：#273
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T01:41:32.793Z / 2026-11-03T01:42:13.344Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:/dsh-plugin/_wt263/t11（分支 impl/263-t11，HEAD bd39b57baa10f3c9f128dfd05f66b286d8828045）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c24b0e67a15a3b8dd96584b24d8a68afbaa273c1681d201efc
- SUT dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（208 个文件）
- 安装后 dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c2…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1, dsh-plugin-update-fixture-b@0.0.1, dsh-plugin-update-fixture-c@0.0.1 | **pass** |
| 08-assert | 隔离口径（通道 B：普通 DSH web 宿主 + 非 desktop profile） | 每个 run 一个仓库外 home；日志根 = <home>/logs（产品自建落点），命名空间目录按插件身份派生 | homeDir=D:\dsh-plugin\_wt263\runtime\t11-275\273-20261103T093814-p30\os-home\.dsh；profile=t9j1 | osHomeDir=D:\dsh-plugin\_wt263\runtime\t11-275\273-20261103T093814-p30\os-home；homeDir=D:\dsh-plugin\_wt263\runtime\t11-275\273-20261103T093814-p30\os-home\.dsh；profile=t9j1 | **pass** |
| 10-assert | 建普通 profile（通道 B 宿主的使用范围） | 用官方发行 CLI 在隔离 home 建普通 DSH 使用范围 t9j1 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t11-275\273-20261103T093814-p30\os-home\.dsh\profiles\t9j1 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t11-275\273-20261103T093814-p30\os-home\.dsh\profiles\t9j1 | **pass** |
| 12-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | 干净 profile 装基版（c） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-c@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-c；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b, dsh-plugin-update-fixture-c]；磁盘版本=0.0.1；exit=0 | **pass** |
| 16-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 18-assert | 更新前基版在盘 | 隔离 profile 里装着场景声明的基版 0.0.1（日志命名空间随后由它派生） | node_modules/dsh-plugin-update-fixture-a 版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 20-assert | 变体版本已发布（更新目标） | 本地 verdaccio 发布 dsh-plugin-update-fixture-a@0.0.2；其余席位按场景声明一并发布 | dsh-plugin-update-fixture-a@0.0.2；variants=["a","b","c"] | dsh-plugin-update-fixture-a@0.0.2；injected=[] | **pass** |
| 23-assert | 单包入口 check 发现 0.0.2 | 真电话 fxa-a.updateCheck：返回快照与候选凭证 checkId | ok=true；latestVersion=0.0.2；canInstall=true；checkId 非空 | ok=true；latestVersion=0.0.2；canInstall=true；checkId="39a2e7a6-296a-43a9-810b-6dbe4df5ece3" | **pass** |
| 25-assert | 单包安装被受理（快照=安装中，不是终态） | 产品 install() 先 saveJob(installing) 再返回受理快照（src/core/service.ts:1027-1120） | ok=true；job.state ∈ {installing, verifying} | ok=true；job.state=installing；blockedReason=null | **pass** |
| 27-assert | 单包安装恰一次真实执行（route=cli-process / ok=true / exit=0） | 日志 update.install.exec 行即安装窗口事实（比 UI 可靠）；pluginId=目标电话前缀 fxa-a | exec 行数=1；route=cli-process；ok=true；exitCode=0；durationMs>0；ns=fxa-a | [{"ts":1793670109300,"ns":"fxa-a","pluginId":"fxa-a","route":"cli-process","ok":true,"exitCode":0,"durationMs":1101}] | **pass** |
| 29-assert | 安装瞬间的 verify 行说真话（restart-required / pendingRestart=true） | 通道 B 不热换：装好后到重启前，verify 行结果是 restart-required 且 pendingRestart=true | result=restart-required；pendingRestart=true；installedVersion=0.0.2 | result=restart-required；pendingRestart=true；installedVersion=0.0.2 | **pass** |
| 31-assert | 故障注入：B 的已装文件被独占锁拖住（remove 被拖住 → 安装预算 6s 耗尽） | PowerShell 对 profile/node_modules/dsh-plugin-update-fixture-b/lib/index.js 持 FileShare.Read 独占句柄；宿主以 DSH_SELFTEST_INSTALL_TIMEOUT_MS=6000 启动（夹具 installTimeoutMs → 执行器安装预算） | 锁 marker 出现；第二个进程独占打开失败（probeExitCode=3） | lockPid=99848；probeExitCode=3 | **pass** |
| 33-assert | 批量 check 仍能列出 B@0.0.2（注入只锁已装文件，不动 registry） | 真电话 fxa.batchCheck：B 行 canInstall=true，候选门能过 | b.canInstall=true；b.latestVersion=0.0.2 | b={"canInstall":true,"latestVersion":"0.0.2"} | **pass** |
| 35-assert | 批量安装整轮（b 的 remove 被锁拖住 → 超时；批量驱动串行推进所有行直到收尾） | 真电话 fxa.batchInstall {}；批量驱动按会话顺序串行推进，b 在 remove 阶段撞上独占锁 | 电话送达（status=200）；回包 ok=true 或明确忙（update-busy） | status=200；ok=true；error=null | **pass** |
| 37-assert | B 行落定为 failed（remove 超时真失败，不伪装成功） | 批量行 phase 以 batchStatus 会话为准；B 应 failed，别的行不被这一行拖进安装 | timedOut=false；b.phase=failed | phases={"a":"current","b":"failed","c":"done"}；timedOut=false | **pass** |
| 39-assert | B 的失败是「执行失败」事件面：exec ok=false（安装预算超时）+ install.fail stage=exec reason=timeout + verify failed | remove 被独占锁拖住，执行器在安装预算耗尽后判失败（不是 check 拒绝、不是静默跳过）；exec 行 pluginId=批量目标前缀 fxa-b | B exec 失败恰 1；route=cli-process；durationMs≈6000；exitCode=null 或非 0；install.fail.stage=exec reason=timeout code=install-failed；verify.result=failed | bExecFail=[{"ts":1793670118974,"ns":"fxa-b","pluginId":"fxa-b","route":"cli-process","ok":false,"exitCode":1,"durationMs":6040}]；bFail.stage=exec；bFail.reason=timeout；bFail.code=install-failed；bVerify.result=failed | **pass** |
| 41-assert | 批量 summary 如实记失败行（failed≥1，不冒充全绿） | 收尾一条 update.batch.summary：total/failed/stoppedBecause 反映真账本 | 存在 summary 行；failed≥1；total≥1 | fields={"total":3,"ok":1,"failed":2,"skipped":0,"durationMs":13061,"sessionAgeMs":13062,"resumed":false,"sessionHash":"9fa0a31b","stoppedBecause":"finished"} | **pass** |
| 43-assert | 释放注入锁（收尾）：持锁进程退出、文件句柄可再用 | kill + taskkill /T /F 兜底，复核 pid 不再存活 | aliveAfter=false | killed=true；aliveAfter=false | **pass** |
| 45-assert | 台账逐包真相：A 恰一条成功终态；B 失败终态；C 无成功记录（整轮推进过 c，失败是注入级联） | 读 <home>/updates/<pluginId>/<hash>/state.json；成功不重复、失败不丢单；b 半删导致 c 也装不上是故障注入的级联副作用，如实记录不硬断言 c 成功 | A success=1（target=0.0.2 / previous=0.0.1）；B failed=1；C success=0；每插件台账 ≤1 条 | aSuccess=[{"pluginId":"fxa-a","state":"completed","targetVersion":"0.0.2","previousVersion":"0.0.1"}]；bFailed=[{"pluginId":"fxa-b","state":"failed","targetVersion":"0.0.2","previousVersion":"0.0.1"}]；cRows=[{"pluginId":"fxa-c","state":"failed","targetVersion":"0.0.2","previousVersion":"0.0.1"}]；duplicated=[] | **pass** |
| 48-assert | 日志事件契约四关：事件名 ∈ 清单、level 一致、字段名 ∈ 声明、枚举值合法 | 把磁盘日志逐行对 event-list.update.json（fieldEnums 也校验）；未知事件/未知字段/非法枚举都必须为 0 | unknownEvents=0；levelMismatches=0；fieldViolations=0；enumViolations=0；checkedRows>0 | checkedRows=84；unknown=[]；level=0；fields=0；enums=0 | **pass** |
| 49-assert | 必备常驻事件覆盖（真安装/真批量/真失败三处事件面都到齐） | 逐事件计数：覆盖集每项 ≥1；本格不应出现的噪声/失败面必须为 0 | missing=[]；zeroViolations=[] | missing=[]；zeroViolations=[]；counts={"host.start":5,"update.wire.ready":5,"update.status.changed":19,"update.check.done":8,"host.call":17,"update.queue.transition":13,"update.install.request":3,"update.install.exec":3,"update.install.verify":3,"update.batch.entry.request":1,"update.batch.run.start":1,"update.install.fail":4,"host.call.fail":2,"update.install.retry":2,"update.batch.entry.fail":2,"update.batch.summary":1} | **pass** |
| 51-assert | 按需事件（kind=ondemand）零行：默认不写盘，不冒充常驻 | 清单把事件分常驻/按需；本格没开按需开关，按需事件必须一行不落 | ondemand 事件计数全 0 | ondemand=["update.check.start","update.registry.fetch","update.channel.decide","update.poll","update.lang.applied","update.panel.state"]；withRows=[] | **pass** |
| 53-assert | 日志落点：命名空间集合 = 夹具身份派生、exec 行只在属主目录、无解析失败行、每命名空间在预算内 | 命名空间目录只允许由已装夹具批量接线派生的集合（A 的 fxa-* 与 B 的 fxb-*）；exec 行 ns 必须等于其 pluginId；每目录 ≤500 行 | namespaces=["fxa-a","fxa-b","fxa-c","fxb-b","fxb-c"]；execOwnership=[]；parseFailures=0；overBudget=[] | namespaces=["fxa-a","fxa-b","fxa-c","fxb-b","fxb-c"]；nsMatches=true；parseFailures=0；overBudget=[]；execOwnership=[] | **pass** |
| 55-assert | 真 UI 面板挂载（j1-evidence） | Playwright 打开 web 宿主页面：夹具卡片与更新面板真出现，面板开始轮询 updateStatus | .dsh-upd≥1；[data-fixture]≥1；面板开始轮询 updateStatus | counts={"dshUpd":2,"dshUpdLog":0,"fixture":3}；elapsedMs=2 | **pass** |
| 58-assert | 收尾：真 UI 页面与 CLI 宿主全部退出，无残留进程/端口 | 登记每个宿主的 pid/port 并核对退出；端口释放由 run.close 的 cleanup 复核 | 每个宿主 closed=true；pidAlive=false | [{"label":"main","pid":61500,"port":51551,"closed":true,"pidAlive":false}] | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 56-panel-after-batch | 通道 B 宿主 + 三包装好 → 批量 check/install（B 被文件锁拖到 6s 预算超时）→ 轮询到终态 → 打开真 UI 页面截面板 | 真批量跑完（B 超时失败、C 级联失败）之后的真 UI 更新面板：批量结果与更新面板状态同屏 | 面板挂载（.dsh-upd/[data-fixture] 在）；面板文本可读，作为批量结果的视觉对照 | {"counts":{"dshUpd":2,"dshUpdLog":0,"fixture":3},"panelText":"更新档案 · 总账 检查更新 全部更新 1 个插件安装失败；请按下方失败提示逐项重试。 1 个插件安装失败。 夹具 B：install-failed 安装执行失败，详情见诊断摘要 复制诊断 复制手工命令 请逐家使用行内「重试」；若持续，请提交诊断信息至插件作者。 夹具 A 本体 0.0.2 正在查询版本信息，请稍候。 详情 夹具 B 0.0.1 → 0.0.2 安装失败，请选择「重试」。 失败 install-failed：安装执行失败，详情见诊断摘要 重试详情 夹具 C 0.0.2 正在查询版本信息，请稍候。 详情 正在按最新版本重新检查… [x] 打开面板时自动检查更新","logTexts":[]} | **pass** | [shots\56-panel-after-batch.png](shots\56-panel-after-batch.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [isolation-facts](raw\07-isolation-facts.json)
- [profile-create](raw\09-profile-create.json)
- [install-baseline](raw\11-install-baseline.json)
- [sut-installed-dist](raw\15-sut-installed-dist.json)
- [baseline-disk](raw\17-baseline-disk.json)
- [fixture-published-variants](raw\19-fixture-published-variants.json)
- [cli-host-launch-main](raw\21-cli-host-launch-main.json)
- [phone-check-single](raw\22-phone-check-single.json)
- [phone-install-single](raw\24-phone-install-single.json)
- [exec-rows-single](raw\26-exec-rows-single.json)
- [verify-rows-single](raw\28-verify-rows-single.json)
- [file-lock-acquired](raw\30-file-lock-acquired.json)
- [phone-batch-check](raw\32-phone-batch-check.json)
- [phone-batch-install-all](raw\34-phone-batch-install-all.json)
- [batch-b-timeline](raw\36-batch-b-timeline.json)
- [batch-b-failure](raw\38-batch-b-failure.json)
- [batch-summary](raw\40-batch-summary.json)
- [file-lock-release](raw\42-file-lock-release.json)
- [ledger-states](raw\44-ledger-states.json)
- [log-inventory](raw\46-log-inventory.json)
- [contract-report](raw\47-contract-report.json)
- [ondemand-events](raw\50-ondemand-events.json)
- [namespace-landing](raw\52-namespace-landing.json)
- [panel-open-j1-evidence](raw\54-panel-open-j1-evidence.json)
- [cli-host-close-main](raw\57-cli-host-close-main.json)

## 清理

- 进程 file-lock-b（pid 99848）：停止后存活=false
- 进程 cli-host-main（pid 61500）：停止后存活=false
- 端口 cli-host-main-port（51551）：已释放=true
- 端口 registry（59342）：已释放=true
- 本地 registry：http://127.0.0.1:59342（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- J 组判读口径：web GUI 没有独立的插件日志查看器；面板面 = 更新面板第 4 章的日志路牌 + 日志健康读数（.dsh-upd-log），事件契约/噪声预算/命名空间都从 <home>/logs 磁盘原始行独立统计；UI 只作「面板看得见、读数与磁盘一致」的证据。

## 维护者 profile 未污染

- 目录：C:/Users/辰辰洋洋/.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:59342（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- J 组判读口径：web GUI 没有独立的插件日志查看器；面板面 = 更新面板第 4 章的日志路牌 + 日志健康读数（.dsh-upd-log），事件契约/噪声预算/命名空间都从 <home>/logs 磁盘原始行独立统计；UI 只作「面板看得见、读数与磁盘一致」的证据。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
