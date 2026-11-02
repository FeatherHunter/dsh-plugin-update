# 真机证据索引 · b-batch-two-integrators

- runId：266-20261102T034002
- 票：#266
- 宿主通道：desktop-official
- 开始/结束：2026-11-01T19:40:03.088Z / 2026-11-01T19:45:50.839Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:/dsh-plugin/_wt263/t2（分支 impl/263-t2，HEAD 14e31955c2782e6c8691471bbe066d4023304578）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 d1ed0c40042770cc90f942210464e5d52dad077947354ab8c42ff0f926f4298b
- SUT dist 指纹：efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1（208 个文件）
- 安装后 dist 指纹：efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 03-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，tarball sha256 落盘 | dsh-plugin-update@0.18.39，sha256 d1ed0c40042770cc…，dist 208 文件 | **pass** |
| 06-assert | 发布场景基版（声明驱动） | 场景声明的三个基版都发布到本地 registry 且版本可见（A/B 批量效果、C 纯目标效果） | a/b/c 各自 0.0.1/0.0.1/0.0.1 在 registry 可见 | {"a":["0.0.1"],"b":["0.0.1"],"c":["0.0.1"]} | **pass** |
| 09-assert | 干净 profile 三包同装 | 隔离 DSH_HOME 的新 desktop profile 里同装 A/B/C 基版：三个包都进 dependencies/bundles 且磁盘版本一致（同装互相识别的前提） | a/b/c 依赖版本与磁盘版本都 = 各自基版；三包都在 bundles | a=0.0.1/dep=0.0.1/bundles=true; b=0.0.1/dep=0.0.1/bundles=true; c=0.0.1/dep=0.0.1/bundles=true | **pass** |
| 11-assert | SUT 钉住核对 | 三夹具装进 profile 后，profile/node_modules/dsh-plugin-update/dist 聚合指纹等于工作树 dist | efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1 | efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1（208 文件，一致=true） | **pass** |
| 13-assert | 初始：A 批量席位身份 | A 卡片是真·批量集成方（批量注入 + 自家批量电话前缀 + targets a/b/c），client 构建标记与标题来自场景声明基版 | ui=batch；席位行=批量席位 fxa · 自键 a · 目标 a/b/c；client v0.0.1；标题=夹具 A · 更新演示；批量入口存在；面板 embedded | ui=batch；seatLine=批量席位 fxa · 自键 a · 目标 a/b/c；clientTag=client v0.0.1；title=夹具 A · 更新演示；entry=true；mode=embedded | **pass** |
| 14-assert | 初始：A 批量入口列出三目标 | A 的批量面板行 = A 声明的 targets（a/b/c，顺序即会话顺序），检查前全部 pending（autoCheck=false，不偷跑） | rows=[a,b,c]，phase 全 pending | rows=[a,b,c]；a=pending[0.0.1]; b=pending[0.0.1]; c=pending[0.0.1] | **pass** |
| 15-assert | 初始：B 批量席位身份 | B 卡片是另一个真·批量集成方（自家批量前缀 fxb + targets b/c），与 A 同时加载互相识别、身份不混 | B 席位行=批量席位 fxb · 自键 b · 目标 b/c；client v0.0.1；标题=夹具 B · 更新演示；批量入口存在 | seatLine=批量席位 fxb · 自键 b · 目标 b/c；clientTag=client v0.0.1；title=夹具 B · 更新演示 | **pass** |
| 16-assert | 初始：B 批量入口列出两目标 | B 的批量面板行 = B 声明的 targets（b/c），没有 A 的 a 行（不串 scope） | rows 集合={b,c}（自键因 selfOrder=last 排最后，顺序不敏感），phase 全 pending | rows=[c,b]；c=pending[0.0.1]; b=pending[0.0.1] | **pass** |
| 17-assert | 初始：C 纯目标无更新接线 | C 卡片带 data-update-wiring=none，卡内没有任何 .dsh-upd 面板/批量入口/中枢坞（纯目标不建 hub） | wiring=none；卡内 .dsh-upd=0、dock=0、entry=0；client v0.0.1 | wiring=none；dshUpd=0；dock=0；entry=0；clientTag=client v0.0.1 | **pass** |
| 18-assert | 初始：页面级更新 UI 只属于两席集成方 | 整页只有 A/B 两份批量面板（各一个 .dsh-upd），C 贡献 0；三个夹具包都真加载了 | 3 张夹具卡片；批量面板=2；.dsh-upd=2；中枢坞=0 | fixtures=[c,a,b]；batchPanels=2；dshUpd=2；docks=0 | **pass** |
| 21-assert | 场景声明驱动（单一真源） | 本 run 的安装版本/变体效果/预期全部取自 scenario-declarations.ts 的 b 声明；场景文件不写死版本（版本来自 baselineVersionOf/variantVersionOf） | id=b-batch-two-integrators、install 3 步、variants 3 条、expected 5 条、hostChannel=desktop-official | id=b-batch-two-integrators；install=a@0.0.1,b@0.0.1,c@0.0.1；variants=a@0.0.2[ui+behavior+metadata],b@0.0.2[ui+behavior+metadata],c@0.0.2[behavior+metadata]；expected=5 条 | **pass** |
| 23-assert | 发布 0.0.2 变体（码面真的变了） | 三个变体包内容与基版不同：client.js sha256 变化且 bundle 内带新版构建标记（不是只改版本号） | 3 个非注入变体的 client.js 哈希与基版不同、且内含 client v0.0.2 标记 | {"a":{"clientChanged":true,"hostChanged":null,"clientHasNewTag":true},"b":{"clientChanged":true,"hostChanged":null,"clientHasNewTag":true},"c":{"clientChanged":true,"hostChanged":null,"clientHasNewTag":true}} | **pass** |
| 24-assert | B 码面：集成方变体改可见 UI/行为（非只改版本） | A/B 的 0.0.2 变体在声明里改了 UI+行为+元数据三类：卡片标题后缀、中枢进度坞出现、host 行为字段 seat-aware-v2 | A/B 的 titleSuffix/hubDock/hostBehavior 至少一变，且 hubDock=true、hostBehavior=seat-aware-v2 | A: suffix=（批量新版） hubDock=true behavior=seat-aware-v2；B: suffix=（批量新版） hubDock=true behavior=seat-aware-v2 | **pass** |
| 25-assert | 变体版本在 registry 可见 | 本地 registry 能看到 A 的 0.0.2（真机更新链路的真实来源） | dsh-plugin-update-fixture-a 可见 0.0.2 | versions=0.0.1,0.0.2 | **pass** |
| 28-assert | A 面板检查更新（真 UI 点 [data-act=check]） | A 的批量检查对 targets 逐个查最新版并把结论写进批量知识；三行版本条都出现 0.0.1→0.0.2（版本来自 registry，不是写死） | rows=[a,b,c] 版本条=基版→最新（正常=变体版；can-red skip 注入的席位 next=null） | a=pending[0.0.1→0.0.2]; b=pending[0.0.1→0.0.2]; c=pending[0.0.1→0.0.2] | **pass** |
| 29-assert | A 面板行集合不随更新漂移 | 检查更新后 A 仍只有自己的三个目标行（不混入 B 的席位/不擅自定义目标） | rows=[a,b,c] | rows=[a,b,c] | **pass** |
| 32-assert | A 宏按钮批量更新 a/b/c（真 UI，跨桌面自重启） | 点 A 面板 [data-act=install] 后，批量会话按顺序把 a、b、c 从 0.0.1 真装成 0.0.2；装 A/B 期间官方桌面自重启，批量会话从落盘账本续跑（磁盘为证；若遇产品竞态则按真实用户路径重试一次，两轮 raw 都留） | a=0.0.2；b=0.0.2；c=0.0.2（两轮各 3 分钟内；can-red skip 注入的席位按声明停在基版） | retried=false；versions={"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"} | **pass** |
| 34-assert | C 纯目标被批量推到 0.0.2（磁盘） | A 的批量会话第三个目标是 C（纯目标，不属于任何集成方）；装完后 C 的包版本应为变体版 | dsh-plugin-update-fixture-c=0.0.2 | dsh-plugin-update-fixture-c=0.0.2 | **pass** |
| 36-assert | 安装行态收敛（#152 对账；#266 修复后瞬态应为 false） | 安装 exec 在飞行中换包时，修复前会在同进程误报 recovery-required（真机瞬态，raw 原样留）；#266 修复后应为 transient=false。若仍有失败行（含真实跨进程中断），点一次真 UI「检查更新」，检查结论 current 会把会话行对账回 current，行态与磁盘一致 | 收敛后 rows=[a,b,c] 全部 phase=done\|current、versionCur=声明目标版（安装无瞬态时无需收敛） | transient=false；before=a=done[0.0.2]; b=done[0.0.2]; c=done[0.0.2]；after=a=done[0.0.2]; b=done[0.0.2]; c=done[0.0.2] | **pass** |
| 37-assert | A 面板安装后状态与磁盘一致 | 批量会话三行都变 done\|current（行显示已到 0.0.2），没有 pending/失败行；台账状态与磁盘安装结果一致 | rows=[a,b,c] 全部 phase=done\|current（重试轮预查可判 current）、versionCur=声明目标版（can-red skip 注入的席位=基版） | a=done[0.0.2]; b=done[0.0.2]; c=done[0.0.2] | **pass** |
| 40-assert | B 面板检查（看见 A 的安装结果） | B 自己的批量知识里，b/c 都显示已装 0.0.2、没有待更新（A 装出来的结果对 B 可见）；B 没有 a 行 | rows=[b,c] 全部 versionCur=声明目标版（can-red skip 注入=基版）、无 versionNew | c=pending[0.0.2]; b=pending[0.0.2] | **pass** |
| 42-assert | B 独立发起批量更新：预查判定 b/c 已是最新（没有重装） | A 装完后 B 自己点宏 [data-act=install]（全部更新）：B 的会话两段式预查把 b/c 都判成 current/0.0.2，串行安装没有可装项（不重复安装 A 已装好的包） | rows=[b,c] phase=current 或 done、versionCur=声明目标版 | attempts=1；c=current[0.0.2]; b=current[0.0.2] | **pass** |
| 43-assert | 两席批量视图行集合互不污染 | B 检查后行集合仍恰为 [b,c]，A 的三行不受影响 | B rows=[b,c]；A rows=[a,b,c] | B rows=[c,b]；A rows=[a,b,c] | **pass** |
| 46-assert | 重启后 A 新版可见 UI/行为（更新前 vs 更新后对比） | A 从单卡（0.0.1 无后缀、无坞、行为字段 none）变成：标题带声明后缀、出现中枢进度坞、host 行为字段 seat-aware-v2、client/host 构建标记 0.0.2；三行 current | title=夹具 A · 更新演示（批量新版）；client v0.0.2；host v0.0.2；behavior=seat-aware-v2；dock 存在；三行 current 0.0.2 | title=夹具 A · 更新演示（批量新版）；client=client v0.0.2；host=host v0.0.2；behavior=seat-aware-v2；dock=true；a=done[0.0.2]; b=done[0.0.2]; c=done[0.0.2] | **pass** |
| 47-assert | 重启后 A 更新前后标题对比（B 码面） | 同一张 A 卡片：更新前标题=夹具 A · 更新演示，更新后标题=夹具 A · 更新演示（批量新版）（可见 UI 变化，不只是版本号） | 夹具 A · 更新演示 → 夹具 A · 更新演示（批量新版） | 初始 title=夹具 A · 更新演示；更新后 title=夹具 A · 更新演示（批量新版） | **pass** |
| 48-assert | 重启后 B 新版可见 UI/行为 | B 同样从 0.0.1 升到 0.0.2：标题后缀、坞、行为字段 v2 都出现，两行 current（两个集成方各自独立更新，互不顶替） | B title=夹具 B · 更新演示（批量新版）；client v0.0.2；host v0.0.2；behavior=seat-aware-v2；dock 存在；两行 current | B title=夹具 B · 更新演示（批量新版）；client=client v0.0.2；host=host v0.0.2；behavior=seat-aware-v2；c=current[0.0.2]; b=current[0.0.2] | **pass** |
| 49-assert | 重启后 C 纯目标内容变新（更新前 vs 更新后） | C 被 A 批量推到 0.0.2：徽标文本从旧内容变新内容（C 有行为/元数据变化），但 C 仍然没有更新接线 | badgeText 含 client v0.0.2（新版）；wiring=none | badgeText=夹具 C · client v0.0.2（新版）；wiring=none；clientTag=client v0.0.2 | **pass** |
| 50-assert | C 升级后仍无更新 UI（纯目标不建 hub） | C 自己的卡片里没有 .dsh-upd 面板、没有批量入口、没有中枢坞——C 不建 hub、不接更新内核（manifest 也不依赖 SUT） | C 卡内 .dsh-upd=0、dock=0、entry=0；data-update-wiring=none | dshUpd=0；dock=0；entry=0；wiring=none | **pass** |
| 51-assert | 页面级更新 UI 计数（两席 vs C） | 重启后整页仍只有 A/B 两个集成方的批量 UI：批量面板 2、批量入口 2、中枢坞 2（新版效果）、.dsh-upd 合计 2；C 贡献 0 | batchPanels=2、entries=2、docks=2、dshUpd=2、fixtures=3 | batchPanels=2；entries=2；docks=2；dshUpd=2；fixtures=[c,a,b] | **pass** |
| 55-assert | 最终磁盘：三包都到 0.0.2 | 三个夹具的已装版本（package.json 直读）都 = 声明的变体版 | a=0.0.2、b=0.0.2、c=0.0.2 | {"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"} | **pass** |
| 56-assert | profile 依赖声明与磁盘一致 | desktop profile 的依赖版本都被更新到 0.0.2（更新系统同时维护 dependency 与磁盘） | dependencies 三包=0.0.2 | {"dsh-plugin-update-fixture-a":"0.0.2","dsh-plugin-update-fixture-b":"0.0.2","dsh-plugin-update-fixture-c":"0.0.2"} | **pass** |
| 58-assert | 日志链：批量入口 → 真装 → in-process 宿主 | 日志里能看到批量会话对三个目标的 install.request（current 0.0.1 → latest 0.0.2）、host.call(update-install, ok=true)、update.wire.ready(desktop-manager)、批量 summary；无 error 级；install.fail 只允许设计内的 check-expired 首提拒绝（每条紧跟同命名空间 retry）与 update-busy 排队回执；三目标都已发布/安装，不允许「目标缺失/跨 scope」类检查失败；自重启窗口内的 entry.fail(stage=check\|settle) 是设计内可恢复记录（邻断言的终态行/磁盘为准） | install.request 覆盖 a/b/c 三目标且 ≥3 次；host.call ok；wire=desktop-manager；summary≥1；无 error；非 check-expired 的 install.fail=0 且未 retry 的拒绝=0；无 check.fail / host.call.fail{method:*.updateCheck} | {"installA":true,"installB":true,"installC":true,"installCount":true,"hostCallOk":true,"wireDesktop":true,"batchSummary":true,"noErrorLevel":true,"installFailDesignOnly":true,"noCrossScopeCheckFailure":true}；installAudit={"failCount":2,"retryCount":2,"nonCheckExpired":0,"unretried":0,"queuedCount":2,"namespaces":["fxa-a","fxa-b"]}；installRequests=5；entryFails=["fxa-a:settle:recovery-required","fxa-c:settle:recovery-required"] | **pass** |
| 60-assert | 批量账本按属主隔离（A=fxa 三键、B=fxb 两键） | 磁盘上 A 的批量会话台账恰含 a/b/c，B 的恰含 b/c；两席的 inventory 也各自只含自己的 targets（无跨 scope 污染） | fxa batch/inventory keys=[a,b,c]；fxb batch/inventory keys=[b,c] | fxa batch=[a,b,c] inventory=[a,c,b]；fxb batch=[c,b] inventory=[b,c]；文件=cb4020cb72671312ad08d4bd/fxa/batch.json,cb4020cb72671312ad08d4bd/fxa/inventory.json,cb4020cb72671312ad08d4bd/fxb/batch.json,cb4020cb72671312ad08d4bd/fxb/inventory.json,cb4020cb72671312ad08d4bd/hub/plans/fxa.json,cb4020cb72671312ad08d4bd/hub/plans/fxb.json,cb4020cb72671312ad08d4bd/queue.json | **pass** |
| 61-assert | 根队列：批量结束后无残留等待项/无主占用 | update-queue/<fp>/queue.json 在批量结束后 waiting 为空（批量会话走完串行队列，不留半截队列） | queue.json 存在且 waiting=[] | {"version":1,"owner":null,"waiting":[]} | **pass** |
| 62-assert | 更新中枢席位：两个集成方各一份计划（批结束后无残留租约） | 中枢目录里 fxa、fxb 各有一份 HubPlan（owner/selfKey/sessionId + targets 各自声明），证明两席真的在中枢登记过、C 没有席位；驾驶位租约是瞬时态（进程退出钩子归还），批量全部结束后的终态应无 lease 残留 | hub/plans 含 fxa(selfKey=a, targets=a,b,c)、fxb(selfKey=b, targets=b,c)；结束后 hub/lease.json 不存在（已释放，无残留租约） | planOwners=fxa,fxb；fxa selfKey=a targets=[a,b,c]；fxb selfKey=b targets=[c,b]；lease=null(已释放) | **pass** |
| 63-assert | C 从未出现在任何集成方账本/中枢计划里 | C 作为目标只出现在 A 的 targets 与安装链里；C 自己没有任何批量台账/中枢计划（不是集成方） | 磁盘上没有 owner=fxc 的 batch.json、没有 hub/plans/fxc.json | owners=fxa,fxb；hubPlanOwners=fxa,fxb | **pass** |
| 64-assert | 进程与端口收尾（只清理自己起的） | 场景结束后自己启动的桌面进程全部退出、本地 verdaccio 端口释放；不触碰别的会话进程 | 所有记录进程 aliveAfterStop=false；verdaccio 端口 released=true | processes=[{"label":"desktop-app-bootstrap","pid":61424,"aliveAfterStop":false},{"label":"desktop-app-main-post-install","pid":41216,"aliveAfterStop":false},{"label":"desktop-app-auto-relaunch-post-install#0","pid":41216,"aliveAfterStop":false},{"label":"desktop-app-main","pid":65660,"aliveAfterStop":false},{"label":"desktop-app-final","pid":2464,"aliveAfterStop":false}]；ports=[{"label":"verdaccio","port":61954,"released":true}] | **pass** |
| 65-assert | 维护者 profile 只读核对 | 整个真机跑期间维护者自己的 ~/.dsh（真实 profile）指纹不变：本 run 只用隔离 DSH_HOME + 隔离 user-data-dir | maintainer home 指纹 before=after | homeDir=C:\Users\辰辰洋洋\.dsh；unchanged=true | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 19-shot | 初始：三包同装（两席批量面板 + C 纯目标） | 官方桌面窗口里同时看到：A 批量面板（三行 a/b/c，右下）、B 批量面板（两行 b/c，左上）、C 纯目标徽标（左下，没有任何更新 UI） | A rows=a/b/c、B rows=b/c，C 无面板 | A rows=[a,b,c]；B rows=[c,b]；页面 batchPanels=2；fixtures=[c,a,b] | **pass** | [shots\19-shot.png](shots\19-shot.png) |
| 26-shot | 发布变体后：两席面板仍在、C 仍无更新 UI | 发布 0.0.2 后重新读页面：A/B 批量面板仍在（还未点检查），C 卡片依旧没有任何 .dsh-upd | A panels rows=a/b/c、B rows=b/c、C .dsh-upd=0 | 页面 batchPanels=2 | **pass** | [shots\26-shot.png](shots\26-shot.png) |
| 30-shot | A 面板检查更新后（三行 0.0.1→0.0.2） | A 批量面板三行都显示 当前 0.0.1 → 最新 0.0.2，行状态 ready；B 面板同屏可见但尚未检查 | A rows 全部 ready 且 versionNew=0.0.2 | a=pending[0.0.1→0.0.2]; b=pending[0.0.1→0.0.2]; c=pending[0.0.1→0.0.2] | **pass** | [shots\30-shot.png](shots\30-shot.png) |
| 38-shot | A 批量更新完成（三目标都到 0.0.2） | A 批量面板三行状态 done\|current、版本条 0.0.2；同屏 B 面板（尚未检查）与 C 卡片（旧内容） | A rows 全部 done/current/0.0.2 | a=done[0.0.2]; b=done[0.0.2]; c=done[0.0.2] | **pass** | [shots\38-shot.png](shots\38-shot.png) |
| 44-shot | B 面板看到 b/c 已是最新（A 的安装结果） | B 批量面板两行 phase=current、版本 0.0.2；B 没有 a 行，证明两席各自把 targets 当 scope | B rows=[b,c] current 0.0.2 | c=pending[0.0.2]; b=pending[0.0.2] | **pass** | [shots\44-shot.png](shots\44-shot.png) |
| 52-shot | 重启后整窗：两席新版 UI + 中枢坞，C 仍无更新 UI | A（右下）与 B（左上）卡片标题带批量新版后缀、各有一个更新进度中枢坞；C（左下）只显示新内容徽标，没有任何更新面板/入口 | A/B 新版标题+dock；C 新版徽标、无 .dsh-upd；batchPanels=2 | A title=夹具 A · 更新演示（批量新版）；B title=夹具 B · 更新演示（批量新版）；C badge=夹具 C · client v0.0.2（新版）；batchPanels=2；docks=2 | **pass** | [shots\52-shot.png](shots\52-shot.png) |
| 53-shot | 重启后 C 纯目标特写（新版内容 + 无更新接线） | C 的徽标文本 = 新版内容；卡片上 data-update-wiring=none，卡内无 .dsh-upd；以此证明纯目标被更新但自己不接更新系统 | badgeText 含 client v0.0.2（新版）；C 卡内 .dsh-upd=0 | badgeText=夹具 C · client v0.0.2（新版）；dshUpd=0；dock=0 | **pass** | [shots\53-shot.png](shots\53-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [fixture-published-baseline](raw\04-fixture-published-baseline.json)
- [registry-baseline-visible](raw\05-registry-baseline-visible.json)
- [desktop-first-launch](raw\07-desktop-first-launch.json)
- [install-baseline](raw\08-install-baseline.json)
- [sut-installed-dist](raw\10-sut-installed-dist.json)
- [initial-ui](raw\12-initial-ui.json)
- [scenario-declaration](raw\20-scenario-declaration.json)
- [fixture-published-variants](raw\22-fixture-published-variants.json)
- [a-check-complete](raw\27-a-check-complete.json)
- [a-install-round-1](raw\31-a-install-round-1.json)
- [desktop-relaunch-post-install](raw\33-desktop-relaunch-post-install.json)
- [a-install-complete](raw\35-a-install-complete.json)
- [b-check-complete](raw\39-b-check-complete.json)
- [b-install-settled](raw\41-b-install-settled.json)
- [restart-ui](raw\45-restart-ui.json)
- [final-disk](raw\54-final-disk.json)
- [logs](raw\57-logs.json)
- [batch-disk-facts](raw\59-batch-disk-facts.json)

## 清理

- 进程 desktop-app-bootstrap（pid 61424）：停止后存活=false
- 进程 desktop-app-main-post-install（pid 41216）：停止后存活=false
- 进程 desktop-app-auto-relaunch-post-install#0（pid 41216）：停止后存活=false
- 进程 desktop-app-main（pid 65660）：停止后存活=false
- 进程 desktop-app-final（pid 2464）：停止后存活=false
- 端口 verdaccio（61954）：已释放=true
- 本地 registry：http://127.0.0.1:61954
- 场景声明基版：dsh-plugin-update-fixture-a@0.0.1、dsh-plugin-update-fixture-b@0.0.1、dsh-plugin-update-fixture-c@0.0.1
- 重启后进程 pid=2464

## 维护者 profile 未污染

- 目录：C:\Users\辰辰洋洋\.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:61954
- 场景声明基版：dsh-plugin-update-fixture-a@0.0.1、dsh-plugin-update-fixture-b@0.0.1、dsh-plugin-update-fixture-c@0.0.1
- 重启后进程 pid=2464

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
