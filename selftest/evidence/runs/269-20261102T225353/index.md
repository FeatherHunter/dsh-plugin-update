# 真机证据索引 · e-batch-resume-retry

- runId：269-20261102T225353
- 票：#269
- 宿主通道：desktop-official
- 开始/结束：2026-11-02T14:53:53.153Z / 2026-11-02T15:00:56.179Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:\dsh-plugin\_wt263\t5（分支 impl/263-t5，HEAD 9c094c76938310fcde2b4d6c4038ff0160688904）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 80cbd584d05efe8dd1a14cfc01dcb9149a3bc29e0d8592cff33d8f5896436312
- SUT dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（208 个文件）
- 安装后 dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 80cbd584d05efe8d…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1, dsh-plugin-update-fixture-b@0.0.1, dsh-plugin-update-fixture-c@0.0.1 | **pass** |
| 11-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 12-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | 干净 profile 装基版（c） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-c@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-c；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b, dsh-plugin-update-fixture-c]；磁盘版本=0.0.1；exit=0 | **pass** |
| 15-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 17-assert | 基版 UI（三包 0.0.1） | A 批量面板列出 a/b/c 三行；A/B 卡片与 C 徽标都是 0.0.1（干净 profile 的起点） | rows=a,b,c；A/B clientTag=client v0.0.1/client v0.0.1；C 徽标 client v0.0.1 | {"rows":"a,b,c","cardA":"client v0.0.1","cardB":"client v0.0.1","cardC":"client v0.0.1","disk":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":"0.0.1","dsh-plugin-update-fixture-c":"0.0.1"}} | **pass** |
| 20-assert | 三包 0.0.2 变体发布 | A/B/C 三个夹具的 0.0.2 变体都发到 run 私有 registry，tarball 字节与 0.0.1 基版不同（内容真变，不是只改版本号） | A/B/C 三个 0.0.2 tarball 都可读且 sha256 与各自 0.0.1 不同；无注入时 variants 三席齐全 | {"variantShas":{"a":"b918dd5d494a57d14bc76c0bb701362148a0163c05bba67551576e5a562ee98c","b":"799ea28992729f90d0e6abc0e81a7bc1f2985b42903232fc659197794bdc0437","c":"9aa0079c5a898177aa7efc0c3bda8c69592e0b896590b077aef33e6304a1954a"},"baselineShas":{"a":"31cac26daa2a9b9f269998d97e99177622eb382a56a8cc6ecfc7ee6b3bf8eb84","b":"5b855860cfa2782344a80355f0a0758e6546357f06bd24eda86bde596e0ceed1","c":"f74cbb521e0b34841e2f3b693d7a4c4faee626e21a0e98f1c392ebd5c76dd178"},"injected":[]} | **pass** |
| 22-assert | 故障注入：改坏 B@0.0.2 tarball 字节 | 元数据/versionDoc/dist.integrity 一字不动，只把已发布 tarball 的中点 64 字节翻位 ⇒ 候选门能过（check 照常显示 0.0.2）、pnpm 下载时 integrity 校验必失败（200 + 字节坏，不是 404） | servedBeforeStatus=200；servedAfterStatus=200；tarball 大小不变；sha256 变了；versionDocUnchanged=true；dist.integrity 仍在元数据原文里 | {"servedBefore":200,"servedAfterStatus":200,"sizeBytes":116305,"sha256Before":"799ea28992729f90d0e6abc0e81a7bc1f2985b42903232fc659197794bdc0437","sha256After":"3536eb271f4bbbcd4f5fce5149972e2ec81adf7a72850056339f4666acdbccfe","corruptedOffset":58152,"corruptedLength":64,"versionDocUnchanged":true} | **pass** |
| 24-assert | 真 UI 检查更新（三行都可更新 0.0.2） | A 面板点「检查更新」后，a/b/c 三行的当前版本=0.0.1、新版本=0.0.2；B 的 tarball 虽被改坏，检查只读元数据，所以仍然列出 0.0.2（候选门能过） | rows=a,b,c 且每行 versionCur=0.0.1、versionNew=0.0.2 | [{"key":"a","cur":"0.0.1","next":"0.0.2","phase":"pending"},{"key":"b","cur":"0.0.1","next":"0.0.2","phase":"pending"},{"key":"c","cur":"0.0.1","next":"0.0.2","phase":"pending"}] | **pass** |
| 27-assert | 部分失败隔离：坏行失败、好行完成 | B@0.0.2 tarball 被改坏后，宏批量没有「全批失败」也没有「全批假成功」：A/C 照常到 0.0.2，B 未到 0.0.2 且台账落定 failed | versions[a]=0.0.2；versions[c]=0.0.2；versions[b]≠0.0.2；B 台账 state=failed | {"versions":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":null,"dsh-plugin-update-fixture-c":"0.0.2"},"dependencies":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":null,"dsh-plugin-update-fixture-c":"0.0.2"},"ledgerB":[{"state":"failed","target":"0.0.2","message":"install-failed: Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt): [WARN]；目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制手工命令重新安装 (dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-b@0.0.2 --registry=http://"}],"observed":["a=0.0.1,b=0.0.1,c=0.0.1,bLedger=missing","a=null,b=0.0.1,c=0.0.1,bLedger=missing","a=0.0.2,b=0.0.1,c=0.0.1,bLedger=missing","a=0.0.2,b=0.0.1,c=0.0.1,bLedger=installing","a=0.0.2,b=null,c=0.0.1,bLedger=installing","a=0.0.2,b=null,c=0.0.1,bLedger=failed","a=0.0.2,b=null,c=null,bLedger=failed","a=0.0.2,b=null,c=0.0.2,bLedger=failed"]} | **pass** |
| 28-assert | 坏行台账真相：B 恰一条失败、失败码 install-failed | B 的台账恰一条 state.json，state=failed、targetVersion=0.0.2，message 以 install-failed 开头（bad tarball 是执行失败，不是检查失败） | fxa-b 台账条数=1；state=failed；target=0.0.2；失败码=install-failed | {"count":1,"states":["failed"],"target":"0.0.2","failureCode":"install-failed","message":"install-failed: Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt): [WARN]；目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制手工命令重新安装 (dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-b@0.0.2 --registry=http://127.0.0.1:59821)"} | **pass** |
| 30-assert | 好行台账不受坏行影响（A/C 各一条成功） | 同一个批量会话里，A/C 的台账各恰一条成功终态（target=0.0.2），没有因为 B 失败而丢行或被标失败 | fxa-a/fxa-c 各 1 条成功终态；target=0.0.2 | {"ledgerA":["completed"],"ledgerC":["restart-required"],"targetA":"0.0.2","targetC":"0.0.2"} | **pass** |
| 38-assert | 失败日志：B 恰一次执行失败、无自动重试、A/C 无执行失败 | 递归日志里 B 只有一次 update.install.exec（ok=false，非零退出）、一条 stage=exec 的 install.fail；静置后 exec/fail 计数不增（已失败不自动重试）；A/C 没有任何 exec 失败 | B exec 次数=1 且 ok=false 恰 1、stage=exec 的 fail=1；A/C exec 失败=0；非 check-expired 的 fail 恰 1（就是这个坏 tarball 的真实执行失败）且它没有被自动重试（unretried=1）；其余设计内 check-expired 拒绝都当场 retry | {"countsA":{"requests":1,"execs":1,"execFails":0,"execOks":1},"countsB":{"requests":1,"execs":1,"execFails":1,"execOks":0},"countsC":{"requests":1,"execs":1,"execFails":0,"execOks":1},"bExecFail":[{"ok":false,"exitCode":1,"durationMs":72454}],"bExecStageFails":[{"reason":"nonzero-exit","code":"install-failed"}],"installAudit":{"failCount":5,"retryCount":4,"nonCheckExpired":1,"unretried":1,"queuedCount":0,"namespaces":["fxa-a","fxa-b","fxa-c"]}} | **pass** |
| 41-assert | 重启后如实展示（坏行不谎称成功、不谎称在飞） | 重启后 B 行不显示 done/current/installing，不宣称目标版已装/已是最新/安装完成；页面无「正在安装」；B 台账仍 failed；A/C 磁盘保持 0.0.2，C 徽标新版 | B 行诚实（failed 的 fail 含 install-failed，或按磁盘投影为未安装可装）；页面无「正在安装」；B 台账仍 failed；A/C 磁盘 0.0.2；C clientTag=v0.0.2 | {"rowB":{"key":"b","phase":"ready","queued":false,"busy":false,"title":"夹具 B","status":"选择「安装此插件」安装 0.0.2","versionCur":"未安装","versionNew":"0.0.2","actions":["toggle-details","row-install","toggle-details"],"fail":null},"cardB":{"present":false,"key":null,"ui":null,"title":null,"clientTag":null,"hostTag":null,"seatLine":null,"behavior":null,"dockHost":null},"seatC":{"clientTag":"client v0.0.2","badge":"夹具 C · client v0.0.2（新版）"},"restartDisk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":null,"dsh-plugin-update-fixture-c":"0.0.2"},"restartLedgerB":["failed"],"pageClaimsInstalling":false,"rowHonest":true} | **pass** |
| 52-assert | 恢复 B@0.0.2 tarball（sha 复原、元数据不变） | 把改坏前的 B tarball 备份拷回 registry storage：GET 200、字节 sha256 复原为改坏前、版本文档不变（后续重试用的是好源） | restoredStatus=200；shaMatches=true；versionDocUnchanged=true | {"restoredStatus":200,"restoredSha256":"799ea28992729f90d0e6abc0e81a7bc1f2985b42903232fc659197794bdc0437","shaMatches":true,"versionDocUnchanged":true} | **pass** |
| 56-assert | 恢复后重试/续跑成功落盘（B=0.0.2） | 恢复 tarball 后再起桌面：产品自动续跑未完成批次（开面板行态见 raw 50），或由真 UI 行按钮触发重装；B 最终装成 0.0.2，A/C 磁盘保持 0.0.2（产品路径，不是手工 CLI） | versions[b]=0.0.2；versions[a]/[c] 仍 0.0.2 | versions={"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"}；retryPath=auto-resume；openedRowB={"key":"b","phase":"installing","queued":false,"busy":true,"title":"夹具 B","status":"正在安装，请勿操作。","versionCur":"未安装","versionNew":"0.0.2","actions":["toggle-details","row-install","toggle-details"],"fail":null} | **pass** |
| 66-assert | 续跑语义：A/C 不重复安装、B 恰一次成功 | 重试前后递归日志计数对比：A/C 的安装请求/执行次数完全不变（没有因为 B 重试而重复安装）；B 的请求/执行各恰增 1（失败一次 + 重试成功一次），exec 失败仍是 1（重试没有再失败），exec 成功恰 1（不重复安装） | A/C 的 requests/execs 前后相等；B requests 后=前+1、execs 后=前+1、execFails 后=1（不增）、execOks 后=1；非 check-expired 的 fail 仍恰 1（首次坏 tarball，不因重试增加），且重试后它已被后续 retry 覆盖、不再有未 retry 的拒绝（unretried=0） | {"before":{"a":{"requests":1,"execs":1,"execFails":0,"execOks":1},"b":{"requests":1,"execs":1,"execFails":1,"execOks":0},"c":{"requests":1,"execs":1,"execFails":0,"execOks":1}},"after":{"a":{"requests":1,"execs":1,"execFails":0,"execOks":1},"b":{"requests":2,"execs":2,"execFails":1,"execOks":1},"c":{"requests":1,"execs":1,"execFails":0,"execOks":1}},"retryAudit":{"failCount":5,"retryCount":5,"nonCheckExpired":1,"unretried":0,"queuedCount":0,"namespaces":["fxa-a","fxa-b","fxa-c"]}} | **pass** |
| 69-assert | 重启后 UI 一致（重试成功：三卡片新版 + 三行 current） | 重试成功后重启：A/B 卡片 clientTag/hostTag=v0.0.2、C 徽标 v0.0.2，A 面板三行都 current 0.0.2 | A=client v0.0.2/host v0.0.2；B=client v0.0.2/host v0.0.2；C=client v0.0.2；三行 current | {"cardA":{"present":true,"key":"a","ui":"batch","title":"夹具 A · 更新演示（批量新版）","clientTag":"client v0.0.2","hostTag":"host v0.0.2","seatLine":{"attr":"批量席位 fxa · 自键 a · 目标 a/b/c","text":"批量席位 fxa · 自键 a · 目标 a/b/c"},"behavior":{"attr":"seat-aware-v2","text":"宿主行为 seat-aware-v2"},"dockHost":"hub-dock"},"cardB":{"present":true,"key":"b","ui":"batch","title":"夹具 B · 更新演示（批量新版）","clientTag":"client v0.0.2","hostTag":"host v0.0.2","seatLine":{"attr":"批量席位 fxb · 自键 b · 目标 b/c","text":"批量席位 fxb · 自键 b · 目标 b/c"},"behavior":{"attr":"seat-aware-v2","text":"宿主行为 seat-aware-v2"},"dockHost":"hub-dock"},"seatC":{"clientTag":"client v0.0.2","badge":"夹具 C · client v0.0.2（新版）"},"rows":[{"key":"a","phase":"current","cur":"0.0.2"},{"key":"b","phase":"current","cur":"0.0.2"},{"key":"c","phase":"current","cur":"0.0.2"}]} | **pass** |
| 71-assert | 总账：3 条成功、无重复无丢行（重试后） | 重试成功后的总账 = 三个插件各恰一条成功终态（target=0.0.2，共 3 条成功），没有第二条成功记录、没有丢行、没有残留失败冒充成功；磁盘三包=0.0.2 | A/B/C 三插件各 1 条成功终态；总条数=3；target 都是 0.0.2；磁盘三包=0.0.2 | {"ledgerA":[{"state":"completed","target":"0.0.2"}],"ledgerB":[{"state":"completed","target":"0.0.2"}],"ledgerC":[{"state":"completed","target":"0.0.2"}],"disk":{"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"}} | **pass** |
| 74-assert | 批量账本/中枢/队列：属主 fxa 三键、无跨 scope、无残留等待项 | 磁盘上 A 的批量会话（属主 fxa）batch.json/inventory.json 都恰含 a/b/c 三键；中枢 plans/fxa 的 selfKey=a、targets=a/b/c；根队列 waiting=[]；没有 fxc 属主/计划（C 纯目标不接更新系统） | fxa batch/inventory keys=[a,b,c]；hub plan fxa selfKey=a targets=[a,b,c]；queue.waiting=[]；无 fxc | {"owners":["fxa","fxb"],"fxaBatchKeys":["a","b","c"],"fxaInventoryKeys":["a","b","c"],"hubPlanOwners":["fxa"],"fxaHubSelfKey":"a","fxaHubTargets":["a","b","c"],"waiting":[],"lease":null} | **pass** |
| 75-assert | 桌面实例退出（收尾无人残留） | 场景结束时登记过的桌面进程（含宿主自重启产生的实例）全部已退出，没有残留窗口占用单实例名额 | 登记进程的 kill(pid,0) 全部失败（已退出） | 登记 5 个进程；仍活着=[] | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 18-shot | 基版 UI（三包 0.0.1） | 三包批量场景的初始形态：A 面板三行、A/B 卡片、C 纯目标卡片 | 三行 + 三卡片都在页面上，版本 0.0.1 | rows=a,b,c；A=client v0.0.1；C=client v0.0.1 | **pass** | [shots\18-shot.png](shots\18-shot.png) |
| 25-shot | 真 UI 检查更新（三行都可更新 0.0.2） | A 批量面板三行：当前 0.0.1、可更新 0.0.2 | 三行都显示 0.0.1 → 0.0.2 | a:0.0.1->0.0.2 \| b:0.0.1->0.0.2 \| c:0.0.1->0.0.2 | **pass** | [shots\25-shot.png](shots\25-shot.png) |
| 42-shot | 重启后如实展示（部分失败） | 部分失败后重启：A/C 已新版、B 未完成且 UI 不谎称成功/在飞 | B 行不显示完成/安装中；页面无「正在安装」 | {"rowB":{"key":"b","phase":"ready","queued":false,"busy":false,"title":"夹具 B","status":"选择「安装此插件」安装 0.0.2","versionCur":"未安装","versionNew":"0.0.2","actions":["toggle-details","row-install","toggle-details"],"fail":null},"cardB":{"present":false,"key":null,"ui":null,"title":null,"clientTag":null,"hostTag":null,"seatLine":null,"behavior":null,"dockHost":null}} | **pass** | [shots\42-shot.png](shots\42-shot.png) |
| 70-shot | 重启后 UI 一致（重试成功） | 重试成功并重启：三包都是新版，A 面板三行 current | 三卡片 v0.0.2；三行 current 0.0.2 | {"cardA":"client v0.0.2","cardB":"client v0.0.2","seatC":"client v0.0.2"} | **pass** | [shots\70-shot.png](shots\70-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [pnpm-store-isolation](raw\07-pnpm-store-isolation.json)
- [desktop-first-launch](raw\08-desktop-first-launch.json)
- [desktop-stop-bootstrap](raw\09-desktop-stop-bootstrap.json)
- [install-baseline](raw\10-install-baseline.json)
- [sut-installed-dist](raw\14-sut-installed-dist.json)
- [batch-panel-initial](raw\16-batch-panel-initial.json)
- [fixture-published-variants](raw\19-fixture-published-variants.json)
- [registry-tarball-corrupted](raw\21-registry-tarball-corrupted.json)
- [a-check-complete](raw\23-a-check-complete.json)
- [batch-settled](raw\26-batch-settled.json)
- [ledger-partial-failure](raw\29-ledger-partial-failure.json)
- [desktop-stop-after-batch-failure](raw\31-desktop-stop-after-batch-failure.json)
- [log-fxa-a-2026-11-02](raw\32-log-fxa-a-2026-11-02.json)
- [log-fxa-b-2026-11-02](raw\33-log-fxa-b-2026-11-02.json)
- [log-fxa-c-2026-11-02](raw\34-log-fxa-c-2026-11-02.json)
- [log-fxb-b-2026-11-02](raw\35-log-fxb-b-2026-11-02.json)
- [log-fxb-c-2026-11-02](raw\36-log-fxb-c-2026-11-02.json)
- [failure-log-counts](raw\37-failure-log-counts.json)
- [batch-panel-after-failure](raw\39-batch-panel-after-failure.json)
- [panel-after-failure-restart](raw\40-panel-after-failure-restart.json)
- [desktop-stop-final-partial](raw\43-desktop-stop-final-partial.json)
- [log-fxa-a-2026-11-02](raw\44-log-fxa-a-2026-11-02.json)
- [log-fxa-a-2026-11-02-tail](raw\45-log-fxa-a-2026-11-02-tail.json)
- [log-fxa-b-2026-11-02](raw\46-log-fxa-b-2026-11-02.json)
- [log-fxa-c-2026-11-02](raw\47-log-fxa-c-2026-11-02.json)
- [log-fxb-b-2026-11-02](raw\48-log-fxb-b-2026-11-02.json)
- [log-fxb-c-2026-11-02](raw\49-log-fxb-c-2026-11-02.json)
- [log-counts-before-retry](raw\50-log-counts-before-retry.json)
- [registry-tarball-restored](raw\51-registry-tarball-restored.json)
- [batch-panel-before-retry](raw\53-batch-panel-before-retry.json)
- [panel-before-retry-open](raw\54-panel-before-retry-open.json)
- [disk-after-retry](raw\55-disk-after-retry.json)
- [ledger-after-retry](raw\57-ledger-after-retry.json)
- [desktop-stop-after-retry](raw\58-desktop-stop-after-retry.json)
- [log-fxa-a-2026-11-02](raw\59-log-fxa-a-2026-11-02.json)
- [log-fxa-a-2026-11-02-tail](raw\60-log-fxa-a-2026-11-02-tail.json)
- [log-fxa-b-2026-11-02](raw\61-log-fxa-b-2026-11-02.json)
- [log-fxa-c-2026-11-02](raw\62-log-fxa-c-2026-11-02.json)
- [log-fxb-b-2026-11-02](raw\63-log-fxb-b-2026-11-02.json)
- [log-fxb-c-2026-11-02](raw\64-log-fxb-c-2026-11-02.json)
- [log-counts-after-retry](raw\65-log-counts-after-retry.json)
- [panel-after-retry-restart](raw\67-panel-after-retry-restart.json)
- [final-state-retry](raw\68-final-state-retry.json)
- [desktop-stop-final-retry-end](raw\72-desktop-stop-final-retry-end.json)
- [batch-disk-facts](raw\73-batch-disk-facts.json)

## 清理

- 进程 desktop-bootstrap（pid 102520）：停止后存活=false
- 进程 desktop-main（pid 98440）：停止后存活=false
- 进程 desktop-after-failure（pid 27992）：停止后存活=false
- 进程 desktop-before-retry（pid 75112）：停止后存活=false
- 进程 desktop-final-retry（pid 56700）：停止后存活=false
- 端口 registry（59821）：已释放=true
- 本地 registry：http://127.0.0.1:59821（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 每 run 私有 pnpm store：D:\dsh-plugin\_wt263\runtime\t5-269\269-20261102T225353\pnpm-store（从 bootstrap/CLI 基版安装起生效）
- 部分失败注入：B@0.0.2 tarball 字节改坏（sha256 799ea28992729f90… → 3536eb271f4bbbcd…，元数据/版本文档不变）
- 真 UI 点 A 面板宏「全部更新」；安装窗只轮询磁盘/台账（三包串行安装，每次成功会触发宿主自重启，旧 CDP 失效）
- 重试前日志 raw 日志截断：D:\dsh-plugin\_wt263\runtime\t5-269\269-20261102T225353\home\logs\fxa-a\2026-11-02.log 原始 50527 字节 / 50527 字符，保留前 50000 字符；尾段见 raw\45-log-fxa-a-2026-11-02-tail.json
- 恢复后再起桌面：开面板瞬间的行态记在 raw/panel-before-retry-open（自动续跑时 B 行=正在安装）；安装窗只轮询磁盘/台账
- 重试后日志 raw 日志截断：D:\dsh-plugin\_wt263\runtime\t5-269\269-20261102T225353\home\logs\fxa-a\2026-11-02.log 原始 52041 字节 / 52041 字符，保留前 50000 字符；尾段见 raw\60-log-fxa-a-2026-11-02-tail.json

## 备注

- 本地 registry：http://127.0.0.1:59821（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 每 run 私有 pnpm store：D:\dsh-plugin\_wt263\runtime\t5-269\269-20261102T225353\pnpm-store（从 bootstrap/CLI 基版安装起生效）
- 部分失败注入：B@0.0.2 tarball 字节改坏（sha256 799ea28992729f90… → 3536eb271f4bbbcd…，元数据/版本文档不变）
- 真 UI 点 A 面板宏「全部更新」；安装窗只轮询磁盘/台账（三包串行安装，每次成功会触发宿主自重启，旧 CDP 失效）
- 重试前日志 raw 日志截断：D:\dsh-plugin\_wt263\runtime\t5-269\269-20261102T225353\home\logs\fxa-a\2026-11-02.log 原始 50527 字节 / 50527 字符，保留前 50000 字符；尾段见 raw\45-log-fxa-a-2026-11-02-tail.json
- 恢复后再起桌面：开面板瞬间的行态记在 raw/panel-before-retry-open（自动续跑时 B 行=正在安装）；安装窗只轮询磁盘/台账
- 重试后日志 raw 日志截断：D:\dsh-plugin\_wt263\runtime\t5-269\269-20261102T225353\home\logs\fxa-a\2026-11-02.log 原始 52041 字节 / 52041 字符，保留前 50000 字符；尾段见 raw\60-log-fxa-a-2026-11-02-tail.json

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
