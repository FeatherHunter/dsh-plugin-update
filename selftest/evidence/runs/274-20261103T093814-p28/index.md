# 真机证据索引 · k-batch-panel-states

- runId：274-20261103T093814-p28
- 票：#274
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T01:52:41.400Z / 2026-11-03T01:56:45.435Z
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
| 20-assert | k3-01-mount-rows | 批量面板挂载即有三行 a/b/c（顺序稳定） | 三行 key=a,b,c 且相位已渲染 | rows=a,b,c；phases=["pending","pending","pending"] | **pass** |
| 21-assert | k3-02-auto-check-on-open | 产品默认打开面板即自动检查（初始「尚未查询」只是首帧，不能当稳定态断言） | summary 非空且报「待查询/检查中/可更新」之一；若报可更新，行 versionNew=0.0.2 | summary="3 个可更新；请选择「全部更新」一次安装完成，也可逐项选择「安装此插件」。"；ledger="3 个可更新" | **pass** |
| 23-assert | k3-03-ready-rows | 检查更新后三行的当前/新版本 | 三行 cur=0.0.1、new=0.0.2 | [{"key":"a","cur":"0.0.1","next":"0.0.2"},{"key":"b","cur":"0.0.1","next":"0.0.2"},{"key":"c","cur":"0.0.1","next":"0.0.2"}] | **pass** |
| 24-assert | k3-04-ready-summary | 就绪态总账/台账一致 | summary 含「3 个可更新」；ledger 含「3 个可更新」 | summary="3 个可更新；请选择「全部更新」一次安装完成，也可逐项选择「安装此插件」。"；ledger="3 个可更新" | **pass** |
| 26-assert | k3-05-fault-injection | 改坏 C 的 tarball 字节（元数据一字不动） | servedBefore/After=200；大小不变；sha256 变了；versionDocUnchanged=true | {"servedBefore":200,"servedAfter":200,"sizeBytes":1385,"sha256Before":"9aa0079c5a898177aa7efc0c3bda8c69592e0b896590b077aef33e6304a1954a","sha256After":"b2297d24c8496a4fcf44715da8104125452a9913beb2fb610a5bf8711610f33d","versionDocUnchanged":true} | **pass** |
| 28-assert | k3-06-installing | 安装窗：批量面板如实显示安装中 | 存在 installing/queued 行或 summary/ledger 含「安装中」 | {"rows":[{"key":"a","phase":"installing","queued":false},{"key":"b","phase":"ready","queued":false},{"key":"c","phase":"ready","queued":false}],"summary":"正在安装 1 个；队列里还有 2 个，会自动依次安装。","ledger":"2 个可更新 · 1 个安装中"} | **pass** |
| 31-assert | k3-07-no-full-fake-success | 部分失败后总账/台账不出现「全批成功」 | summary 不含「已全部为最新」；ledger 不含「3 个已是最新」 | summary="1 个插件安装失败；请按下方失败提示逐项重试。"；ledger="1 个失败 · 2 个已是最新" | **pass** |
| 32-assert | k3-08-failed-banner | 失败横幅：标题/名单/动作提示 | 标题「1 个插件安装失败。」；名单恰 1 条含夹具 C；动作含复制诊断/复制手工命令 | {"title":"1 个插件安装失败。","sub":"","list":["夹具 C：install-failed 安装执行失败，详情见诊断摘要"],"rowline":["复制诊断","复制手工命令"]} | **pass** |
| 33-assert | k3-09-failed-row | C 行失败态 truthful（最后手段 + 可重试，不谎称安装中/成功） | phase=failed；status 含「最后手段」「安装失败，请选择「重试」」；fail 含 install-failed；actions 含 row-install | {"key":"c","phase":"failed","queued":false,"busy":false,"title":"夹具 C","status":"最后手段安装失败，请选择「重试」。","versionCur":"0.0.1","versionNew":"0.0.2","actions":["toggle-details","row-install","toggle-details"],"fail":"失败 install-failed：安装执行失败，详情见诊断摘要"} | **pass** |
| 34-assert | k3-10-summary-ledger-partial | 总账/台账逐行计数与失败横幅一致 | summary 含「1 个插件安装失败」且无「安装中」；ledger 含「1 个失败」且无「安装中」 | summary="1 个插件安装失败；请按下方失败提示逐项重试。"；ledger="1 个失败 · 2 个已是最新" | **pass** |
| 35-assert | k3-11-good-rows-unaffected | 好行不受坏行影响（A/B 磁盘与台账都到目标版） | a/b 磁盘=0.0.2；A/B 台账成功终态 target=0.0.2 | {"disk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.1"},"ledgerA":"completed","ledgerB":"completed"} | **pass** |
| 36-assert | k3-12-bad-ledger-failed | 坏行台账真相：failed + 目标版本 0.0.2 | state=failed、targetVersion=0.0.2 | {"state":"failed","target":"0.0.2"} | **pass** |
| 39-assert | k3-13-exec-generated | 第一代宿主：A/B 各恰一次成功执行，C 恰一次失败执行（坏 tarball 只在执行阶段失败） | A/B exec=1 且 ok=1；C exec=1 且 ok=0；stage=exec 的 install.fail 恰 1 条 code=install-failed | execA=1 okA=1 execB=1 okB=1 execC=1 okC=0 stageExecFails=[{"code":"install-failed","reason":"nonzero-exit","exitCode":1}] | **pass** |
| 40-assert | k3-14-gate-retry-fact | 记录产品 gate 重试事实（A 自更新成功会触发宿主重载，后续行的 gate 可能 check-expired 一次后重试成功；不算安装失败） | stage=gate 的失败都是 check-expired；安装执行失败只算 C 的那 1 条 | [{"stage":"gate","code":"check-expired","reason":"gate-refused"},{"stage":"gate","code":"check-expired","reason":"gate-refused"}] | **pass** |
| 42-assert | k3-15-tarball-restored | 还原 C 的 tarball 字节（恢复后 sha 与原始一致、元数据未动） | shaMatches=true、versionDocUnchanged=true | {"restoredStatus":200,"restoredSha256":"9aa0079c5a898177aa7efc0c3bda8c69592e0b896590b077aef33e6304a1954a","shaMatches":true,"versionDocUnchanged":true} | **pass** |
| 44-assert | k3-16-store-reset | 清空 run 私有 pnpm store 的坏 tarball 失败缓存（环境修复，只清缓存不动已装包） | reset 前 store 有文件，reset 后目录存在 | filesBefore=343 | **pass** |
| 47-assert | k3-17-restart-truth | 重启后首帧：C 磁盘仍旧版时 UI 不得把 C 行标成 done/current（另有未完成续跑路径） | disk c=0.0.1 时 C 行 phase 不为 done/current | {"diskC":"0.0.1","rowC":{"key":"c","phase":"ready","queued":false,"busy":false,"title":"夹具 C","status":"选择「安装此插件」安装 0.0.2","versionCur":"0.0.1","versionNew":"0.0.2","actions":["toggle-details","row-install","toggle-details"],"fail":null},"more":{"resume":"继续上次未完成的更新（剩余 1 个）。","resumeTitle":"从上次中断处继续安装，已完成的不会重复安装。","cancel":"丢弃本批未完成的更新（已完成的将保留）。","cancelConfirm":"","cancelDisabled":false,"resumeDisabled":false},"notice":""} | **pass** |
| 50-assert | k3-18-resume-effect | 未完成批次在第二代宿主里被继续（默认自动续跑；冻结时真 UI 点续跑/行内重试） | C 磁盘到 0.0.2 | path=manual；diskC=0.0.2 | **pass** |
| 52-assert | k3-19-resume-rows | 续跑后三行 done/current 0.0.2、失败横幅消失 | 三行 done/current、versionCur=0.0.2；failed=null | [{"key":"a","phase":"current","cur":"0.0.2"},{"key":"b","phase":"current","cur":"0.0.2"},{"key":"c","phase":"done","cur":"0.0.2"}] | **pass** |
| 53-assert | k3-20-resume-summary | 续跑后总账/台账转完成 | summary 含「已全部为最新」或「个已安装完成」；ledger 含「3 个已是最新」或「3 个待重启」 | summary="已全部为最新，无需操作。"；ledger="3 个已是最新" | **pass** |
| 54-assert | k3-21-resume-bad-ledger | C 台账续跑成功终态（目标 0.0.2） | state∈{completed,restart-required}、targetVersion=0.0.2 | {"state":"completed","target":"0.0.2"} | **pass** |
| 55-assert | k3-22-good-rows-not-reinstalled | 好行不被续跑重复安装（A/B 台账仍是成功终态） | A/B 台账成功终态 target=0.0.2 | {"a":"completed","b":"completed"} | **pass** |
| 58-assert | k3-23-exactly-once | 续跑/重试语义：A/B 不重复安装、C 恰一次失败 + 恰一次成功 | A/B exec=1 且 ok=1；C exec=2（1 失败 1 成功）；stage=exec 的 install.fail 恰 1 且 code=install-failed | execA=1 okA=1 execB=1 okB=1 execC=2 okC=1 stageExecFails=[{"code":"install-failed","reason":"nonzero-exit"}] | **pass** |
| 59-assert | k3-24-ledger-rows | 台账逐行真相：每包恰一条记录（同一 profile 只有一份 state.json，重试覆盖不追加），三包终态成功；C 的失败历史由日志计数承载 | A/B/C 各 1 条 state.json；state∈{completed,restart-required}；targetVersion=0.0.2；previousVersion=0.0.1 | {"a":[{"file":"fxa-a/6f47dce0930c0a192b550a83/state.json","state":"completed","target":"0.0.2","previous":"0.0.1"}],"b":[{"file":"fxa-b/6f47dce0930c0a192b550a83/state.json","state":"completed","target":"0.0.2","previous":"0.0.1"}],"c":[{"file":"fxa-c/6f47dce0930c0a192b550a83/state.json","state":"completed","target":"0.0.2","previous":"0.0.1"}]} | **pass** |
| 60-assert | k3-25-fail-audit | 失败审计：唯一真失败是坏 tarball 在 C 上的执行失败（无其它未归因失败） | nonCheckExpired=1 | {"failCount":5,"retryCount":5,"nonCheckExpired":1,"unretried":0,"queuedCount":0,"namespaces":["fxa-a","fxa-b","fxa-c"]} | **pass** |
| 63-assert | k3-26-restart-rows | 重启后批量行相位与版本（UI 与磁盘一致） | 三行 current/done、versionCur=0.0.2 | [{"key":"a","phase":"current","cur":"0.0.2"},{"key":"b","phase":"current","cur":"0.0.2"},{"key":"c","phase":"current","cur":"0.0.2"}] | **pass** |
| 64-assert | k3-27-restart-summary | 重启后总账/台账 | summary 含「已全部为最新」；ledger 含「3 个已是最新」 | {"summary":"已全部为最新，无需操作。","ledger":"3 个已是最新"} | **pass** |
| 65-assert | k3-28-build-tags | 三包运行内容都是 0.0.2 构建（不是版本号假成功） | A/B clientTag/hostTag 与 C clientTag 都等于 0.0.2 变体标记 | {"tagsA":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"tagsB":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"tagsC":{"clientTag":"client v0.0.2","hostTag":null},"expected":{"a":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2","cardTitle":"夹具 A · 更新演示（新版）","fixtureKey":"a"},"b":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2","cardTitle":"夹具 B · 更新演示（新版）","fixtureKey":"b"},"c":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2","cardTitle":"夹具 C · 更新演示（新版）","fixtureKey":"c"}}} | **pass** |
| 66-assert | k3-29-restart-ledger | 重启后台账三包各一条 completed（不重复/不丢） | 三包 state=completed、targetVersion=0.0.2 | {"a":"completed","b":"completed","c":"completed"} | **pass** |
| 67-assert | k3-30-final-disk | 重启后磁盘三包仍 0.0.2（UI/台账/磁盘三处一致） | 三包 versions=0.0.2 | {"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"} | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 19-shot | k3-10-mount | 批量面板挂载首帧：三行 a/b/c 与总账/台账（产品默认「打开面板时自动检查」，「尚未查询」只存在于自动检查完成前的首帧） | rows=a,b,c；行相位/总账/台账自洽（自动检查前或检查后均可，但不得出现与磁盘不符的「已是最新」） | rows=a,b,c；phases=["pending","pending","pending"]；summary="3 个可更新；请选择「全部更新」一次安装完成，也可逐项选择「安装此插件」。"；ledger="3 个可更新" | **pass** | [shots\19-shot.png](shots\19-shot.png) |
| 22-shot | k3-20-ready | 检查更新后：三行都列出 0.0.1 → 0.0.2，总账「3 个可更新」，「全部更新」可点 | 每行 cur=0.0.1、new=0.0.2；summary 含「3 个可更新」；ledger 含「3 个可更新」；install 宏可点 | rows=[{"key":"a","cur":"0.0.1","next":"0.0.2","phase":"pending"},{"key":"b","cur":"0.0.1","next":"0.0.2","phase":"pending"},{"key":"c","cur":"0.0.1","next":"0.0.2","phase":"pending"}]；summary="3 个可更新；请选择「全部更新」一次安装完成，也可逐项选择「安装此插件」。"；ledger="3 个可更新"；installDisabled=false | **pass** | [shots\22-shot.png](shots\22-shot.png) |
| 27-shot | k3-30-installing | 宏「全部更新」后：批量面板进入安装中（行 installing/queued，总账报安装中） | 存在 installing/queued 行或总账含「安装中」；安装宏禁用 | rows=[{"key":"a","phase":"installing","queued":false,"status":"正在安装，请勿操作。"},{"key":"b","phase":"ready","queued":false,"status":"已在队列 · 会自动依次安装"},{"key":"c","phase":"ready","queued":false,"status":"已在队列 · 会自动依次安装"}]；summary="正在安装 1 个；队列里还有 2 个，会自动依次安装。"；ledger="2 个可更新 · 1 个安装中" | **pass** | [shots\27-shot.png](shots\27-shot.png) |
| 30-shot | k3-40-partial-failure | 部分失败隔离：1 个失败横幅 + C 行最后手段可重试，A/B 照常完成；总账/台账不谎称全批成功 | 横幅「1 个插件安装失败。」名单含夹具 C、行内动作含「复制诊断/复制手工命令」；C 行 failed 且 status 含「最后手段」「安装失败，请选择「重试」」、fail 含 install-failed、有 row-install；summary 含「1 个插件安装失败」；ledger 含「1 个失败」且无「安装中」；磁盘 a/b=0.0.2、c=0.0.1；无全批假成功 | {"failedBanner":{"title":"1 个插件安装失败。","sub":"","list":["夹具 C：install-failed 安装执行失败，详情见诊断摘要"],"rowline":["复制诊断","复制手工命令"]},"rows":[{"key":"a","phase":"done","cur":"0.0.2","next":null,"status":"已安装完成，无需操作。","fail":null,"actions":["toggle-details","toggle-details"]},{"key":"b","phase":"done","cur":"0.0.2","next":null,"status":"已安装完成，无需操作。","fail":null,"actions":["toggle-details","toggle-details"]},{"key":"c","phase":"failed","cur":"0.0.1","next":"0.0.2","status":"最后手段安装失败，请选择「重试」。","fail":"失败 install-failed：安装执行失败，详情见诊断摘要","actions":["toggle-details","row-install","toggle-details"]}],"summary":"1 个插件安装失败；请按下方失败提示逐项重试。","ledger":"1 个失败 · 2 个已是最新","disk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.1"},"ledgerC":{"state":"failed","target":"0.0.2"}} | **pass** | [shots\30-shot.png](shots\30-shot.png) |
| 51-shot | k3-50-after-resume | 续跑完成：C 行转 done/current，失败横幅消失，三行 0.0.2；总账/台账与磁盘一致 | 三行 done/current 0.0.2；summary 含「已全部为最新」或「个已安装完成」；ledger 含「3 个已是最新」或「3 个待重启」；磁盘三包 0.0.2；C 台账成功终态；notice 含「已继续上次未完成的更新」 | {"rows":[{"key":"a","phase":"current","cur":"0.0.2"},{"key":"b","phase":"current","cur":"0.0.2"},{"key":"c","phase":"done","cur":"0.0.2"}],"summary":"已全部为最新，无需操作。","ledger":"3 个已是最新","disk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"},"ledgerC":{"state":"completed","target":"0.0.2"},"notice":"已继续上次未完成的更新（剩余 0 个）。","failed":null} | **pass** | [shots\51-shot.png](shots\51-shot.png) |
| 62-shot | k3-60-after-restart | 重启后：批量面板三行 current 0.0.2、总账「已全部为最新」、卡片构建标记 v0.0.2、台账三条 completed | 三行 current 0.0.2；summary 含「已全部为最新」；ledger 含「3 个已是最新」；A/B clientTag/hostTag=v0.0.2、C clientTag=v0.0.2；台账三包 completed | {"rows":[{"key":"a","phase":"current","cur":"0.0.2"},{"key":"b","phase":"current","cur":"0.0.2"},{"key":"c","phase":"current","cur":"0.0.2"}],"summary":"已全部为最新，无需操作。","ledger":"3 个已是最新","tagsA":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"tagsB":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"tagsC":{"clientTag":"client v0.0.2","hostTag":null},"disk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"},"ledgerStates":{"a":"completed","b":"completed","c":"completed"}} | **pass** | [shots\62-shot.png](shots\62-shot.png) |

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
- [host-launch-k3-gen1](raw\18-host-launch-k3-gen1.json)
- [k3-registry-tarball-corrupted](raw\25-k3-registry-tarball-corrupted.json)
- [k3-partial-settled](raw\29-k3-partial-settled.json)
- [host-stop-0](raw\37-host-stop-0.json)
- [k3-gen1-backend](raw\38-k3-gen1-backend.json)
- [k3-restore-tarball](raw\41-k3-restore-tarball.json)
- [k3-pnpm-store-reset](raw\43-k3-pnpm-store-reset.json)
- [host-launch-k3-gen2](raw\45-host-launch-k3-gen2.json)
- [k3-restart-before-resume](raw\46-k3-restart-before-resume.json)
- [k3-manual-resume-offer](raw\48-k3-manual-resume-offer.json)
- [k3-resume-path](raw\49-k3-resume-path.json)
- [host-stop-1](raw\56-host-stop-1.json)
- [k3-final-backend](raw\57-k3-final-backend.json)
- [host-launch-k3-gen3](raw\61-host-launch-k3-gen3.json)
- [host-stop-2](raw\68-host-stop-2.json)
- [log-fxa-a-2026-11-03](raw\69-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\70-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\71-log-fxa-c-2026-11-03.json)
- [log-fxb-b-2026-11-03](raw\72-log-fxb-b-2026-11-03.json)
- [log-fxb-c-2026-11-03](raw\73-log-fxb-c-2026-11-03.json)
- [cleanup-log-files](raw\74-cleanup-log-files.json)
- [tls-front-stop](raw\75-tls-front-stop.json)

## 清理

- 进程 k3-gen1-host（pid 77424）：停止后存活=false
- 进程 k3-gen2-host（pid 88908）：停止后存活=false
- 进程 k3-gen3-host（pid 71572）：停止后存活=false
- 端口 tls-registry-front（55525）：已释放=false
- 端口 k3-gen1-host-port（54446）：已释放=false
- 端口 k3-gen2-host-port（64962）：已释放=false
- 端口 k3-gen3-host-port（51285）：已释放=false
- 端口 registry（51872）：已释放=true
- 本地 registry：http://127.0.0.1:51872（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 k3-gen1 已起：port=54446，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:55525）
- 宿主 k3-gen2 已起：port=64962，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:55525）
- 宿主 k3-gen3 已起：port=51285，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:55525）

## 维护者 profile 未污染

- 目录：C:/Users/辰辰洋洋/.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:51872（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 k3-gen1 已起：port=54446，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:55525）
- 宿主 k3-gen2 已起：port=64962，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:55525）
- 宿主 k3-gen3 已起：port=51285，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:55525）

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
