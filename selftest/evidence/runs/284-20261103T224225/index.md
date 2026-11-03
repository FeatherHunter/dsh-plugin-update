# 真机证据索引 · m3-owner-a-row-fails-still-alive

- runId：284-20261103T224225
- 票：#284
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T14:42:25.481Z / 2026-11-03T14:44:18.784Z
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
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1, dsh-plugin-update-fixture-b@0.0.1, dsh-plugin-update-fixture-c@0.0.1 | **pass** |
| 09-assert | 建普通 profile（CLI 入口） | createWebProfileInHome 建通道 B 的普通 profile（非 desktop） | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t14-284\284-20261103T224225\os-home\.dsh\profiles\t14hub | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t14-284\284-20261103T224225\os-home\.dsh\profiles\t14hub | **pass** |
| 12-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | 干净 profile 装基版（c） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-c@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-c；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b, dsh-plugin-update-fixture-c]；磁盘版本=0.0.1；exit=0 | **pass** |
| 16-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | ff0a6b1aea9773eced40869b73a2d3a837a9b3e98afd9c900e81d4b158e62b76 | ff0a6b1aea9773eced40869b73a2d3a837a9b3e98afd9c900e81d4b158e62b76（文件数 208 / 工作树 208） | **pass** |
| 18-assert | 更新前基版在盘 | 场景声明 install 里的包 @0.0.1 已装进 profile，SUT 钉版与工作树 dist 一致（M1/M2 的 C 是孤儿目标，初始不在册，由中枢按方案补装，故不参与本断言） | 声明在册包（a,b,c）磁盘版本=0.0.1 | 已声明包全部=0.0.1 | **pass** |
| 20-assert | 变体 0.0.2 已发布 | 场景声明 variants 发布到仓库外 verdaccio | A/B/C 均有 0.0.2，A 变体含批量坞/新版 UI | A=0.0.2；baseline=0.0.1 | **pass** |
| 23-assert | 中枢/批量目录定位 | 按 profileDir 短哈希复算队列目录，并与盘上实际目录对照（首次安装前目录可能尚未创建） | 盘上目录数 ≤1，且存在时=cc6ce59c078ff915e3c9380b | 盘上=[]；复算=cc6ce59c078ff915e3c9380b | **pass** |
| 25-assert | 宿主启动（通道 B，host1） | startCliHost 起 DSH web 宿主（隔离 USERPROFILE/home/profile） | boot 成功、HTTP 电话入口可用、pid>0 | pid=30496，port=55221，bootMs=2193 | **pass** |
| 27-assert | M3 真 UI 已打开（A 的批量入口在真浏览器里） | Playwright 加载宿主页面，等 A 卡片与批量面板挂载 | 卡片与 .dsh-upd-batch 面板存在、三行（a/b/c）挂载 | url=http://127.0.0.1:55221/?token=<redacted>；playwright=D:/2Study/OpenClaw/node_modules/playwright @ C:\Users\辰辰洋洋\AppData\Local\ms-playwright\chromium_headless_shell-1248\chrome-headless-shell-win64\chrome-headless-shell.exe | **pass** |
| 28-assert | M3 批量面板挂载：A 的「全部更新」面板三行齐全 | 真 UI 的面板 DOM 行（不是电话回包） | panel.present=true；行 key 排序后 [a,b,c] | present=true；keys=["a","b","c"] | **pass** |
| 30-assert | M3 就绪态：三行 0.0.1→0.0.2，总账/台账「3 个可更新」 | 真 UI 面板的 ready 读数（与磁盘基版一致） | 三行 cur=0.0.1、new=0.0.2；summary/ledger 含「3 个可更新」；install 可点 | rows=[{"key":"a","cur":"0.0.1","next":"0.0.2","phase":"pending"},{"key":"b","cur":"0.0.1","next":"0.0.2","phase":"pending"},{"key":"c","cur":"0.0.1","next":"0.0.2","phase":"pending"}]；summary="3 个可更新；请选择「全部更新」一次安装完成，也可逐项选择「安装此插件」。"；ledger="3 个可更新" | **pass** |
| 32-assert | M3 故障注入：改坏 A@0.0.2 tarball 字节（版本元数据/integrity 一字不动） | corruptPublishedTarball 翻转 tarball 字节后仍以 200 提供：check 读元数据能过、install 解包必失败 | servedBefore=200、servedAfter=200；sha256 变化；versionDocUnchanged=true；大小不变 | {"servedBefore":200,"servedAfter":200,"sizeBytes":116330,"sha256Before":"58e0a978dc35506e7076dc18179b9fd08aacee7a4c46620693224ba938ebc735","sha256After":"53125b1a760d092db598c121630394c5b81befe3141a33f079311ba2a1190b08","versionDocUnchanged":true} | **pass** |
| 35-assert | M3 真 UI 宏「全部更新」触发了批量会话 | 点击面板 data-act=install 后轮询 <home>/update-queue/<hash>/fxa/batch.json | batch.json 落盘、entries 三行 key=[a,b,c] | file=D:\dsh-plugin\_wt263\runtime\t14-284\284-20261103T224225\os-home\.dsh\update-queue\cc6ce59c078ff915e3c9380b\fxa\batch.json；batchId=mw0srtis-274sja1vqm；keys=["a","b","c"] | **pass** |
| 37-assert | M3 部分失败落定：坏 A 行失败、B/C 照常装成（安装窗只读磁盘/台账） | 点「全部更新」后不依赖 UI/CDP 轮询盘上事实：b/c node_modules=0.0.2，a 仍 0.0.1 且台账 state=failed | b/c=0.0.2；a=0.0.1；fxa-a state=failed targetVersion=0.0.2 | settled=true；a=0.0.1,b=0.0.2,c=0.0.2；fxa-a={"state":"failed","targetVersion":"0.0.2"} | **pass** |
| 40-assert | M3 失败行 truthful：A 行 failed（原因非空、动作含重试），不装成功也不装安装中 | 真 UI 的 A 行 DOM（status/fail/actions） | phase=failed；status 含「失败」；fail 非空（安装失败原因）；actions 含 row-install | {"phase":"failed","status":"最后手段安装失败，请选择「重试」。","fail":"失败 install-failed：安装执行失败，详情见诊断摘要","actions":["toggle-details","row-install","toggle-details"]} | **pass** |
| 41-assert | M3 好行不受坏行影响：B/C 磁盘与 UI 都到 0.0.2 | 坏 A 行不毒化其他行（stopOnFailure 默认 false） | B/C 行 done/current 且 versionCur=0.0.2；磁盘 b/c=0.0.2 | rowB={"phase":"done","cur":"0.0.2"}；rowC={"phase":"done","cur":"0.0.2"}；disk={"a":"0.0.1","b":"0.0.2","c":"0.0.2","dependencies":{"a":"0.0.1","b":"0.0.2","c":"0.0.2"}} | **pass** |
| 42-assert | M3 无全批假成功：总账/台账只说 1 个失败，不出现「已全部为最新/3 个已是最新」 | 部分失败后的 summary/ledger 文案与失败行数一致 | summary 含「1 个插件安装失败」且不含「已全部为最新」；ledger 含「1 个失败」且不含「3 个已是最新」「安装中」 | summary="1 个插件安装失败；请按下方失败提示逐项重试。"；ledger="1 个失败 · 2 个已是最新" | **pass** |
| 43-assert | M3 台账逐行真相：fxa-a 一条 failed、fxa-b/fxa-c 各一条成功终态（无重复/丢行） | <home>/updates/<pluginId>/<hash>/state.json 逐包读取 | fxa-a=1 条 failed target=0.0.2；fxa-b/fxa-c 各 1 条 completed/restart-required | {"fxa-a":[{"file":"D:\\dsh-plugin\\_wt263\\runtime\\t14-284\\284-20261103T224225\\os-home\\.dsh\\updates\\fxa-a\\cc6ce59c078ff915e3c9380b\\state.json","state":"failed","targetVersion":"0.0.2","previousVersion":"0.0.1"}],"fxa-b":[{"file":"D:\\dsh-plugin\\_wt263\\runtime\\t14-284\\284-20261103T224225\\os-home\\.dsh\\updates\\fxa-b\\cc6ce59c078ff915e3c9380b\\state.json","state":"completed","targetVersion":"0.0.2","previousVersion":"0.0.1"}],"fxa-c":[{"file":"D:\\dsh-plugin\\_wt263\\runtime\\t14-284\\284-20261103T224225\\os-home\\.dsh\\updates\\fxa-c\\cc6ce59c078ff915e3c9380b\\state.json","state":"completed","targetVersion":"0.0.2","previousVersion":"0.0.1"}]} | **pass** |
| 45-assert | M3 失败后 A 插件仍活着：宿主进程在、A 的状态/检查电话可达 | A 自己行失败不影响 A 自身存活（web 宿主 pid 仍在；updateStatus/updateCheck 电话正常） | pid 存活；updateStatus.ok=true；updateCheck.ok=true 且 installedVersion=0.0.1 | pid=30496 alive=true；status.ok=true；check.ok=true；installedVersion=0.0.1 | **pass** |
| 46-assert | M3 中枢继续泵、租约未被外来驱动者占用 | A 失败后中枢会话仍可读、没有第二个驱动者；租约要么已释放要么还是本宿主的 | hub.ok=true 且 snapshot 可读；租赁 pid 为空或=30496 | hub.ok=true；session={"sessionId":"mw0srtis-274sja1vqm","owner":"fxa","selfKey":"a","state":"finished","updatedAt":1793717048229,"progress":{"total":3,"done":2,"failed":1,"skipped":0,"current":0,"pending":0,"finished":true},"rows":[{"key":"a","title":"夹具 A 本体","phase":"failed","targetVersion":"0.0.2","installedVersion":"0.0.1","latestVersion":"0.0.2","restartRequired":false,"error":"install-failed"},{"key":"b","title":"夹具 B","phase":"done","targetVersion":"0.0.2","installedVersion":"0.0.1","latestVersion":"0.0.2","restartRequired":false,"error":null},{"key":"c","title":"夹具 C","phase":"done","targetVersion":"0.0.2","installedVersion":"0.0.1","latestVersion":"0.0.2","restartRequired":false,"error":null}],"rowsTotal":3,"rowsTruncated":false}；lease=null | **pass** |
| 48-assert | M3 恢复环境：A@0.0.2 tarball 字节还原（sha 与原始一致、元数据未动） | restoreCorruptedTarball 把备份字节写回 | shaMatches=true；versionDocUnchanged=true | {"restoredStatus":200,"restoredSha256":"58e0a978dc35506e7076dc18179b9fd08aacee7a4c46620693224ba938ebc735","shaMatches":true,"versionDocUnchanged":true} | **pass** |
| 50-assert | M3 清掉坏 tarball 在 run 私有 pnpm store 的失败缓存（环境修复，不动已装包） | K3 实测：坏 tarball 的失败尝试会留下 integrity 不匹配的缓存，不清则恢复后仍反复失败 | reset 前 store 有文件；reset 后目录重建 | filesBefore=343 | **pass** |
| 51-assert | M3 真 UI 行内「重试」点击（只重试 A 行） | 点击 A 行 data-act=row-install（产品按 keys=[a] 复位该行并推进） | 点击前 A 行动作含 row-install；点击成功 | beforeRetryA={"phase":"failed","actions":["toggle-details","row-install","toggle-details"]} | **pass** |
| 53-assert | M3 重试生效：A 行装成 0.0.2、台账转成功终态；B/C 不被重装（仍 0.0.2） | 真 UI 行内重试后，盘上 A 到 0.0.2、fxa-a 台账成功；B/C 磁盘不变 | a=0.0.2；fxa-a state∈{completed,restart-required} target=0.0.2；b/c=0.0.2 | settled=true；disk={"a":"0.0.2","b":"0.0.2","c":"0.0.2","dependencies":{"a":"0.0.2","b":"0.0.2","c":"0.0.2"}}；fxa-a={"state":"completed","targetVersion":"0.0.2"} | **pass** |
| 54-assert | M3 重试成功后宿主仍活着（web 通道自更新不杀进程） | A 自更新成功后宿主 pid 仍在（不是靠换进程掩盖） | pid=30496 存活 | alive=true | **pass** |
| 58-assert | 宿主启动（通道 B，host2） | startCliHost 起 DSH web 宿主（隔离 USERPROFILE/home/profile） | boot 成功、HTTP 电话入口可用、pid>0 | pid=21116，port=64633，bootMs=1927 | **pass** |
| 62-assert | M3 重启后一致：UI 三行终态、台账 3 条成功终态、磁盘三包 0.0.2 | 停掉 A 宿主后重启（同 home/profile），批量会话与台账从盘上恢复后仍一致 | 三行 done/current 0.0.2；磁盘 a/b/c=0.0.2；台账 fxa-a/fxa-b/fxa-c 各 1 条成功终态 target=0.0.2 | {"rows":[{"key":"a","phase":"done","cur":"0.0.2"},{"key":"b","phase":"done","cur":"0.0.2"},{"key":"c","phase":"done","cur":"0.0.2"}],"summary":"已全部为最新，无需操作。","ledger":"3 个已是最新","disk":{"a":"0.0.2","b":"0.0.2","c":"0.0.2","dependencies":{"a":"0.0.2","b":"0.0.2","c":"0.0.2"}},"ledgerRows":{"fxa-a":[{"file":"D:\\dsh-plugin\\_wt263\\runtime\\t14-284\\284-20261103T224225\\os-home\\.dsh\\updates\\fxa-a\\cc6ce59c078ff915e3c9380b\\state.json","state":"completed","targetVersion":"0.0.2","previousVersion":"0.0.1"}],"fxa-b":[{"file":"D:\\dsh-plugin\\_wt263\\runtime\\t14-284\\284-20261103T224225\\os-home\\.dsh\\updates\\fxa-b\\cc6ce59c078ff915e3c9380b\\state.json","state":"completed","targetVersion":"0.0.2","previousVersion":"0.0.1"}],"fxa-c":[{"file":"D:\\dsh-plugin\\_wt263\\runtime\\t14-284\\284-20261103T224225\\os-home\\.dsh\\updates\\fxa-c\\cc6ce59c078ff915e3c9380b\\state.json","state":"completed","targetVersion":"0.0.2","previousVersion":"0.0.1"}]}} | **pass** |
| 64-assert | M3 租约正常释放：重启后中枢空闲时盘上无未归还租约 | hub/pump 收尾会归还自己这一代租约；重启后无活任务时 lease.json 不应残留别人的驾驶位 | lease.json 不存在（或已被正常释放） | lease=null | **pass** |
| 74-assert | 收尾：宿主进程与端口无残留 | 关闭所有宿主后核实 pid 不在、端口空闲 | remainingPids=[]、所有端口 free=true | remainingPids=[]；portChecks=[{"label":"host1","port":55221,"free":true},{"label":"host2","port":64633,"free":true}] | **pass** |
| 76-assert | M3 重试只重跑 A：A 成功自更新恰 1 次（exec ok=1、坏包失败=1），B/C 成功 exec 各恰 1 次无重复 | 停宿主后读最终日志：坏 A 首次 exec 失败 + 恢复后重试 exec 成功；B/C 的安装处于重试窗口之外 | okExecA=1 且 failExecA=1；okExecB=1；okExecC=1；且没有 B/C 的安装失败 entry.fail | okExecA=1；failExecA=1；okExecB=1；okExecC=1；goodRowInstallFails=[] | **pass** |
| 77-assert | M3 失败如实记录：A 的首次失败在批量账本日志里留下 entry.fail（index=0）与 exec 阶段 install.fail | update.batch.entry.fail（errorKind/stage/index）与 update.install.fail（stage=exec）两条独立日志事实，不是靠 UI 文案倒推 | entry.fail 恰 1 条且 index=0、errorKind 非空；exec 阶段 install.fail 至少 1 条（nonzero-exit）；B/C（index 1/2）没有 entry.fail | entryFail=[{"ts":1793717045431,"errorKind":"install-failed","stage":"settle","index":0,"exitCode":null}]；execStageFails=[{"ts":1793717045287,"stage":"exec","code":"install-failed","reason":"nonzero-exit","pluginId":null}]；goodRowInstallFails=[] | **pass** |
| 78-assert | M3 exactly-once：每个目标成功安装至多一次（A/B/C 各 1 次），exec 失败行恰 1 条（A 的坏包首试） | 宿主全关后重读最终日志；A 自更新成功 1 次、B/C 各 1 次；失败只有 A 坏包那一次 | okExecA=1 且 failExecA=1；okExecB=1；okExecC=1；exec 阶段失败行恰 1 条 | okExecA=1；failExecA=1；okExecB=1；okExecC=1；execStageFails=[{"ts":1793717045287,"stage":"exec","code":"install-failed","reason":"nonzero-exit","pluginId":null}] | **pass** |
| 79-assert | M3 批量日志收口：最终 summary total=3 ok=3 failed=0 | update.batch.summary 的最终一条（重试后的收尾） | 存在 total=3、ok=3、failed=0 的 summary | [{"total":3,"ok":2,"failed":1,"stoppedBecause":"finished"},{"total":3,"ok":3,"failed":0,"stoppedBecause":"finished"}] | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 29-shot | m3-10-ready | 真 UI 检查完成后：A 的批量面板三行 0.0.1 → 0.0.2，总账「3 个可更新」，「全部更新」可点 | 每行 cur=0.0.1/new=0.0.2；summary 与 ledger 均含「3 个可更新」；install 宏可点 | rows=[{"key":"a","cur":"0.0.1","next":"0.0.2","phase":"pending"},{"key":"b","cur":"0.0.1","next":"0.0.2","phase":"pending"},{"key":"c","cur":"0.0.1","next":"0.0.2","phase":"pending"}]；summary="3 个可更新；请选择「全部更新」一次安装完成，也可逐项选择「安装此插件」。"；ledger="3 个可更新"；installDisabled=false | **pass** | [shots\29-shot.png](shots\29-shot.png) |
| 34-shot | m3-20-batch-started | 真 UI 点「全部更新」之后：批量会话已落盘（batch.json 三行在飞），面板进入安装中 | batch.json 存在且 entries=[a,b,c]（真 UI 宏→批量入口已触发，不是电话模拟） | batchId=mw0srtis-274sja1vqm；keys=["a","b","c"] | **pass** | [shots\34-shot.png](shots\34-shot.png) |
| 38-shot | m3-30-partial-failure | 部分失败隔离：A 行失败但 A 仍活着，B/C 行完成；失败横幅只说 1 个失败，不谎称全批成功 | A 行 failed 且有 row-install；B/C 行 done/current 且 cur=0.0.2；summary 含「1 个插件安装失败」不含「已全部为最新」；ledger 含「1 个失败」不含「安装中」 | {"rows":[{"key":"a","phase":"failed","cur":"0.0.1","next":"0.0.2","status":"最后手段安装失败，请选择「重试」。","fail":"失败 install-failed：安装执行失败，详情见诊断摘要","actions":["toggle-details","row-install","toggle-details"]},{"key":"b","phase":"done","cur":"0.0.2","next":null,"status":"已安装完成，无需操作。","fail":null,"actions":["toggle-details","toggle-details"]},{"key":"c","phase":"done","cur":"0.0.2","next":null,"status":"已安装完成，无需操作。","fail":null,"actions":["toggle-details","toggle-details"]}],"summary":"1 个插件安装失败；请按下方失败提示逐项重试。","ledger":"1 个失败 · 2 个已是最新","disk":{"a":"0.0.1","b":"0.0.2","c":"0.0.2","dependencies":{"a":"0.0.1","b":"0.0.2","c":"0.0.2"}}} | **pass** | [shots\38-shot.png](shots\38-shot.png) |
| 60-shot | m3-40-after-restart | 重试成功并重启宿主后：三行 done/current 0.0.2，总账/台账「全部为最新/待重启」——UI/台账/磁盘一致 | 三行 phase∈{done,current} 且 cur=0.0.2；summary 含「已全部为最新」或「个已安装完成」；ledger 含「3 个已是最新」或「3 个待重启」 | {"rows":[{"key":"a","phase":"done","cur":"0.0.2"},{"key":"b","phase":"done","cur":"0.0.2"},{"key":"c","phase":"done","cur":"0.0.2"}],"summary":"已全部为最新，无需操作。","ledger":"3 个已是最新","disk":{"a":"0.0.2","b":"0.0.2","c":"0.0.2","dependencies":{"a":"0.0.2","b":"0.0.2","c":"0.0.2"}}} | **pass** | [shots\60-shot.png](shots\60-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [isolation-facts](raw\07-isolation-facts.json)
- [profile-create](raw\08-profile-create.json)
- [m3-pnpm-isolation](raw\10-m3-pnpm-isolation.json)
- [install-baseline](raw\11-install-baseline.json)
- [sut-installed-dist](raw\15-sut-installed-dist.json)
- [baseline-installed](raw\17-baseline-installed.json)
- [fixture-published-variant](raw\19-fixture-published-variant.json)
- [host-env](raw\21-host-env.json)
- [hub-paths](raw\22-hub-paths.json)
- [cli-host-launch-host1](raw\24-cli-host-launch-host1.json)
- [m3-ui-open-initial](raw\26-m3-ui-open-initial.json)
- [m3-registry-tarball-corrupted](raw\31-m3-registry-tarball-corrupted.json)
- [m3-batch-started](raw\33-m3-batch-started.json)
- [m3-partial-settled](raw\36-m3-partial-settled.json)
- [m3-panel-partial](raw\39-m3-panel-partial.json)
- [m3-a-alive-after-failure](raw\44-m3-a-alive-after-failure.json)
- [m3-restore-tarball](raw\47-m3-restore-tarball.json)
- [m3-pnpm-store-reset](raw\49-m3-pnpm-store-reset.json)
- [m3-retry-settled](raw\52-m3-retry-settled.json)
- [m3-ui-close-after-retry](raw\55-m3-ui-close-after-retry.json)
- [host-stop-m3-after-retry](raw\56-host-stop-m3-after-retry.json)
- [cli-host-launch-host2](raw\57-cli-host-launch-host2.json)
- [m3-ui-open-host2](raw\59-m3-ui-open-host2.json)
- [m3-final-state](raw\61-m3-final-state.json)
- [m3-lease-final](raw\63-m3-lease-final.json)
- [m3-ui-close-final](raw\65-m3-ui-close-final.json)
- [host-stop-final](raw\66-host-stop-final.json)
- [log-fxa-a-2026-11-03](raw\67-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\68-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\69-log-fxa-c-2026-11-03.json)
- [log-fxb-b-2026-11-03](raw\70-log-fxb-b-2026-11-03.json)
- [log-fxb-c-2026-11-03](raw\71-log-fxb-c-2026-11-03.json)
- [logs-final](raw\72-logs-final.json)
- [cleanup-verify](raw\73-cleanup-verify.json)
- [m3-log-timeline](raw\75-m3-log-timeline.json)

## 清理

- 进程 cli-host-host1（pid 30496）：停止后存活=false
- 进程 cli-host-host2（pid 21116）：停止后存活=false
- 端口 cli-host-host1-port（55221）：已释放=true
- 端口 cli-host-host2-port（64633）：已释放=true
- 端口 registry（65514）：已释放=true
- 本地 registry：http://127.0.0.1:65514（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- M3 故障注入：检查完成后、点「全部更新」之前，改坏 A@0.0.2 tarball 的字节（版本元数据与 integrity 一字不动），registry 代理实测 servedBefore/After 都是 200：check 能过、install 必在解包阶段失败。
- M3 观察纪律：点「全部更新」后安装窗只轮询磁盘与台账（A 自更新失败不该触发重载，但真 UI 页面仍可能因 fiber 替换失效）；停宿主后才读日志，避免安装窗内 CDP/日志半写。

## 备注

- 本地 registry：http://127.0.0.1:65514（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- M3 故障注入：检查完成后、点「全部更新」之前，改坏 A@0.0.2 tarball 的字节（版本元数据与 integrity 一字不动），registry 代理实测 servedBefore/After 都是 200：check 能过、install 必在解包阶段失败。
- M3 观察纪律：点「全部更新」后安装窗只轮询磁盘与台账（A 自更新失败不该触发重载，但真 UI 页面仍可能因 fiber 替换失效）；停宿主后才读日志，避免安装窗内 CDP/日志半写。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
