# 真机证据索引 · k-batch-resume

- runId：274-20261103T093814-p29
- 票：#274
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T01:52:41.405Z / 2026-11-03T01:55:25.713Z
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
| 10-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 11-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 12-assert | 干净 profile 装基版（c） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-c@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-c；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b, dsh-plugin-update-fixture-c]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 15-assert | setup-sut | 通道 B profile 里装的 SUT 与工作树构建一致 | installed distDigest === worktree distDigest | true | **pass** |
| 16-assert | setup-base-disk | 基版安装后磁盘版本与声明一致 | {"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":"0.0.1","dsh-plugin-update-fixture-c":"0.0.1"} | dsh-plugin-update-fixture-a=0.0.1, dsh-plugin-update-fixture-b=0.0.1, dsh-plugin-update-fixture-c=0.0.1 | **pass** |
| 20-assert | k4-01-fault-injection | 改坏 C 的 tarball 字节（元数据/integrity 不动 ⇒ check 能过、install 必失败） | servedBefore/After=200；sha256 变了；versionDocUnchanged=true | {"servedBefore":200,"servedAfter":200,"sizeBytes":1385,"sha256Before":"9aa0079c5a898177aa7efc0c3bda8c69592e0b896590b077aef33e6304a1954a","sha256After":"b2297d24c8496a4fcf44715da8104125452a9913beb2fb610a5bf8711610f33d","versionDocUnchanged":true} | **pass** |
| 22-assert | k4-02-partial-isolated | 部分失败隔离：坏行失败、好行完成、无全批假成功 | a/b 磁盘 0.0.2 且台账成功；c 磁盘 0.0.1 且台账 failed target=0.0.2；summary 含「1 个插件安装失败」、不含「已全部为最新」 | {"disk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.1"},"ledgerA":"completed","ledgerB":"completed","ledgerC":"failed","summary":"1 个插件安装失败；请按下方失败提示逐项重试。","ledger":"1 个失败 · 2 个已是最新"} | **pass** |
| 26-assert | k4-03-kill-truth | 杀宿主后的落盘真相：A/B 已装 0.0.2、C 仍 0.0.1、C 台账 failed、批量会话三行全终态（无在飞安装） | a/b 磁盘 0.0.2；c 磁盘 0.0.1；C 台账 failed；会话三行 phase∈{current,done,failed,skipped} | {"disk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.1"},"batch":[{"key":"a","phase":"done","target":"0.0.2"},{"key":"b","phase":"done","target":"0.0.2"},{"key":"c","phase":"failed","target":"0.0.2"}],"ledgerC":"failed"} | **pass** |
| 28-assert | k4-04-tarball-restored | 还原 C 的 tarball 字节（sha 复原、元数据未动） | shaMatches=true、versionDocUnchanged=true | {"restoredStatus":200,"restoredSha256":"9aa0079c5a898177aa7efc0c3bda8c69592e0b896590b077aef33e6304a1954a","shaMatches":true,"versionDocUnchanged":true} | **pass** |
| 30-assert | k4-05-store-reset | 清空 run 私有 pnpm store 的坏 tarball 失败缓存（续跑要重新拉取好 tarball；环境修复） | reset 前 store 有文件 | filesBefore=343 | **pass** |
| 33-assert | k4-06-restart-truth | 重启首帧：C 的磁盘仍是 0.0.1 时 UI 不把 C 行标成 done/current（真实未完成） | diskC=0.0.1 时 C 行 phase 不为 done/current | {"diskC":"0.0.1","rowC":{"key":"c","phase":"ready","queued":false,"busy":false,"title":"夹具 C","status":"选择「安装此插件」安装 0.0.2","versionCur":"0.0.1","versionNew":"0.0.2","actions":["toggle-details","row-install","toggle-details"],"fail":null}} | **pass** |
| 35-assert | k4-07-resume-offer | 续跑入口出现且文案逐字（A/B 已完成不重复装，C 待续跑） | resume/resumeTitle/cancel 文案逐字、data-confirm 为空；A/B 终态 0.0.2；C ready versionNew=0.0.2 | {"more":{"resume":"继续上次未完成的更新（剩余 1 个）。","resumeTitle":"从上次中断处继续安装，已完成的不会重复安装。","cancel":"丢弃本批未完成的更新（已完成的将保留）。","cancelConfirm":"","cancelDisabled":false,"resumeDisabled":false},"rows":[{"key":"a","phase":"current","cur":"0.0.2","next":null},{"key":"b","phase":"current","cur":"0.0.2","next":null},{"key":"c","phase":"ready","cur":"0.0.1","next":"0.0.2"}]} | **pass** |
| 37-assert | k4-08-frozen | 双闸冻结：续跑入口出现后 8 秒内不自动续跑 | tarball 请求数不变；C 磁盘不变；B/C 台账快照不变；批量会话相位不变 | {"tarballs":[5,5],"diskC":["0.0.1","0.0.1"],"batch":["a:current\|b:current\|c:ready","a:current\|b:current\|c:ready"],"freezeOk":true} | **pass** |
| 39-assert | k4-09-resumed | 续跑完成：C 恢复到 0.0.2，回执与面板一致，续跑区收敛 | notice 含「已继续上次未完成的更新」；三行终态 0.0.2；磁盘三包 0.0.2；more=null | {"notice":"已继续上次未完成的更新（剩余 0 个）。","rows":[{"key":"a","phase":"current","cur":"0.0.2"},{"key":"b","phase":"current","cur":"0.0.2"},{"key":"c","phase":"done","cur":"0.0.2"}],"disk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"},"moreGone":true} | **pass** |
| 42-assert | k4-10-exactly-once | 续跑 exactly-once：A/B 请求各 1 次且台账未被改写；C 恰一次失败 + 恰一次成功 | reqA=1、reqB=1、reqC=2；B/C 各恰 1 次成功 exec；C stage=exec 失败恰 1（install-failed）；A/B 无 stage=exec 失败；A/B 台账 file/id/state/mtime 全不变；audit.nonCheckExpired=1 | {"req":{"a":1,"b":1,"c":2},"execOk":{"a":1,"b":1,"c":1},"execFails":{"a":0,"b":0,"c":1},"aLedgerUntouched":true,"bLedgerUntouched":true,"audit":{"failCount":5,"retryCount":5,"nonCheckExpired":1,"unretried":0,"queuedCount":0,"namespaces":["fxa-a","fxa-b","fxa-c"]},"aExecSwallowed":false} | **pass** |
| 43-assert | k4-11-ledger-rows | 台账逐行真相：每包恰一条记录（同一 profile 只有一份 state.json，续跑覆盖不追加），三包终态成功；C 的失败历史只留在日志计数里 | A/B/C 各 1 条 state.json；state∈{completed,restart-required}；targetVersion=0.0.2；previousVersion=0.0.1 | {"a":[{"file":"fxa-a/db75393863604dbbebc4c7f1/state.json","state":"completed","target":"0.0.2","previous":"0.0.1"}],"b":[{"file":"fxa-b/db75393863604dbbebc4c7f1/state.json","state":"completed","target":"0.0.2","previous":"0.0.1"}],"c":[{"file":"fxa-c/db75393863604dbbebc4c7f1/state.json","state":"completed","target":"0.0.2","previous":"0.0.1"}]} | **pass** |
| 46-assert | k4-12-restart-rows | 重启后批量行相位与版本（UI 与磁盘一致） | 三行 current/done、versionCur=0.0.2 | [{"key":"a","phase":"current","cur":"0.0.2"},{"key":"b","phase":"current","cur":"0.0.2"},{"key":"c","phase":"done","cur":"0.0.2"}] | **pass** |
| 47-assert | k4-13-restart-summary | 重启后总账/台账 | summary 含「已全部为最新」；ledger 含「3 个已是最新」 | {"summary":"已全部为最新，无需操作。","ledger":"3 个已是最新"} | **pass** |
| 48-assert | k4-14-build-tags | 三包运行内容都是 0.0.2 构建（不是版本号假成功） | A/B clientTag/hostTag 与 C clientTag 都等于 0.0.2 变体标记 | {"tagsA":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"tagsB":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"tagsC":{"clientTag":"client v0.0.2","hostTag":null},"expected":{"a":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2","cardTitle":"夹具 A · 更新演示（新版）","fixtureKey":"a"},"b":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2","cardTitle":"夹具 B · 更新演示（新版）","fixtureKey":"b"},"c":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2","cardTitle":"夹具 C · 更新演示（新版）","fixtureKey":"c"}}} | **pass** |
| 49-assert | k4-15-restart-ledger | 重启后台账三包各一条 completed（不重复/不丢） | 三包 state=completed、targetVersion=0.0.2 | {"a":"completed","b":"completed","c":"completed"} | **pass** |
| 50-assert | k4-16-final-disk | 重启后磁盘三包仍 0.0.2（UI/台账/磁盘三处一致） | 三包 versions=0.0.2 | {"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"} | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 21-shot | k4-10-partial-failure | 批量部分失败隔离（杀宿主前的现场）：C 坏 tarball 失败、A/B 已完成；总账/台账不谎称全批成功 | 磁盘 a/b=0.0.2、c=0.0.1；C 台账 failed target=0.0.2；A/B 台账成功终态；summary 含「1 个插件安装失败」且无「已全部为最新」；C 行 failed（最后手段） | {"disk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.1"},"summary":"1 个插件安装失败；请按下方失败提示逐项重试。","ledger":"1 个失败 · 2 个已是最新","banner":{"title":"1 个插件安装失败。","sub":"","list":["夹具 C：install-failed 安装执行失败，详情见诊断摘要"],"rowline":["复制诊断","复制手工命令"]},"rowC":{"phase":"failed","status":"最后手段安装失败，请选择「重试」。","fail":"失败 install-failed：安装执行失败，详情见诊断摘要"},"ledgerC":{"state":"failed","target":"0.0.2"}} | **pass** | [shots\21-shot.png](shots\21-shot.png) |
| 34-shot | k4-20-resume-offer | 重启后续跑入口：A/B 已完成（0.0.2），C 的失败行被自动检查对账成 ready，「继续上次未完成的更新」按钮出现；双闸下没有自动续跑 | resume 文案「继续上次未完成的更新（剩余 n 个）。」、title「从上次中断处继续安装，已完成的不会重复安装。」、cancel「丢弃本批未完成的更新（已完成的将保留）。」、data-confirm 初始为空；A/B 行终态 0.0.2；C 行 ready、versionNew=0.0.2 | {"more":{"resume":"继续上次未完成的更新（剩余 1 个）。","resumeTitle":"从上次中断处继续安装，已完成的不会重复安装。","cancel":"丢弃本批未完成的更新（已完成的将保留）。","cancelConfirm":"","cancelDisabled":false,"resumeDisabled":false},"rows":[{"key":"a","phase":"current","cur":"0.0.2","next":null},{"key":"b","phase":"current","cur":"0.0.2","next":null},{"key":"c","phase":"ready","cur":"0.0.1","next":"0.0.2"}],"disk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.1"}} | **pass** | [shots\34-shot.png](shots\34-shot.png) |
| 38-shot | k4-30-resumed | 点续跑后：C 装到 0.0.2、A/B 不重复安装；回执 + 三行完成 + 续跑区消失 | notice 含「已继续上次未完成的更新」；三行 current/done 0.0.2；磁盘三包 0.0.2；续跑区消失（more=null） | {"notice":"已继续上次未完成的更新（剩余 0 个）。","rows":[{"key":"a","phase":"current","cur":"0.0.2"},{"key":"b","phase":"current","cur":"0.0.2"},{"key":"c","phase":"done","cur":"0.0.2"}],"disk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"},"more":null} | **pass** | [shots\38-shot.png](shots\38-shot.png) |
| 45-shot | k4-40-after-restart | 重启后：批量面板三行 current 0.0.2、总账「已全部为最新」、卡片构建标记 v0.0.2、台账三条 completed | 三行 current 0.0.2；summary 含「已全部为最新」；ledger 含「3 个已是最新」；A/B clientTag/hostTag=v0.0.2、C clientTag=v0.0.2；台账三包 completed | {"rows":[{"key":"a","phase":"current","cur":"0.0.2"},{"key":"b","phase":"current","cur":"0.0.2"},{"key":"c","phase":"done","cur":"0.0.2"}],"summary":"已全部为最新，无需操作。","ledger":"3 个已是最新","tagsA":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"tagsB":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"tagsC":{"clientTag":"client v0.0.2","hostTag":null},"disk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"},"ledgerStates":{"a":"completed","b":"completed","c":"completed"}} | **pass** | [shots\45-shot.png](shots\45-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [tls-registry-front](raw\07-tls-registry-front.json)
- [isolation-facts](raw\08-isolation-facts.json)
- [install-baseline](raw\09-install-baseline.json)
- [sut-installed-dist](raw\13-sut-installed-dist.json)
- [fixture-publication](raw\17-fixture-publication.json)
- [host-launch-k4-gen1](raw\18-host-launch-k4-gen1.json)
- [k4-registry-tarball-corrupted](raw\19-k4-registry-tarball-corrupted.json)
- [k4-before-kill](raw\23-k4-before-kill.json)
- [host-stop-0](raw\24-host-stop-0.json)
- [k4-after-kill](raw\25-k4-after-kill.json)
- [k4-restore-tarball](raw\27-k4-restore-tarball.json)
- [k4-pnpm-store-reset](raw\29-k4-pnpm-store-reset.json)
- [host-launch-k4-gen2](raw\31-host-launch-k4-gen2.json)
- [k4-restart-first-frame](raw\32-k4-restart-first-frame.json)
- [k4-freeze-window](raw\36-k4-freeze-window.json)
- [host-stop-1](raw\40-host-stop-1.json)
- [k4-exactly-once](raw\41-k4-exactly-once.json)
- [host-launch-k4-gen3](raw\44-host-launch-k4-gen3.json)
- [host-stop-2](raw\51-host-stop-2.json)
- [log-fxa-a-2026-11-03](raw\52-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\53-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\54-log-fxa-c-2026-11-03.json)
- [log-fxb-b-2026-11-03](raw\55-log-fxb-b-2026-11-03.json)
- [log-fxb-c-2026-11-03](raw\56-log-fxb-c-2026-11-03.json)
- [cleanup-log-files](raw\57-cleanup-log-files.json)
- [tls-front-stop](raw\58-tls-front-stop.json)

## 清理

- 进程 k4-gen1-host（pid 54732）：停止后存活=false
- 进程 k4-gen2-host（pid 13876）：停止后存活=false
- 进程 k4-gen3-host（pid 34760）：停止后存活=false
- 端口 tls-registry-front（58120）：已释放=false
- 端口 k4-gen1-host-port（54447）：已释放=false
- 端口 k4-gen2-host-port（64963）：已释放=false
- 端口 k4-gen3-host-port（49303）：已释放=false
- 端口 registry（51873）：已释放=true
- 本地 registry：http://127.0.0.1:51873（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 k4-gen1 已起：port=54447，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:58120）
- 宿主 k4-gen2 已起：port=64963，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:58120）
- 宿主 k4-gen3 已起：port=49303，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:58120）

## 维护者 profile 未污染

- 目录：C:/Users/辰辰洋洋/.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:51873（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 k4-gen1 已起：port=54447，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:58120）
- 宿主 k4-gen2 已起：port=64963，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:58120）
- 宿主 k4-gen3 已起：port=49303，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:58120）

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
