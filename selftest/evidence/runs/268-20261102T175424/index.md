# 真机证据索引 · g3-desktop-manager-failed-no-retry

- runId：268-20261102T175424
- 票：#268
- 宿主通道：desktop-official
- 开始/结束：2026-11-02T09:54:24.504Z / 2026-11-02T09:59:25.003Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:/dsh-plugin/_wt263/t4（分支 impl/263-t4，HEAD b57fd1903fa1b90216cb2885da3738ae4e5843f9）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 795c5746976b5d43f34b2b221e2772f637551129898c2b7d56c92f5c1829822a
- SUT dist 指纹：25f1970da9af6a36eac92a2bd84b5b4fa0839fbb54de0411a17b60f308e15b28（208 个文件）
- 安装后 dist 指纹：25f1970da9af6a36eac92a2bd84b5b4fa0839fbb54de0411a17b60f308e15b28（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 03-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 795c5746976b5d43…，dist 208 文件 | **pass** |
| 05-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1, dsh-plugin-update-fixture-b@0.0.1, dsh-plugin-update-fixture-c@0.0.1 | **pass** |
| 09-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 10-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 11-assert | 干净 profile 装基版（c） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-c@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-c；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b, dsh-plugin-update-fixture-c]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | 25f1970da9af6a36eac92a2bd84b5b4fa0839fbb54de0411a17b60f308e15b28 | 25f1970da9af6a36eac92a2bd84b5b4fa0839fbb54de0411a17b60f308e15b28（文件数 208 / 工作树 208） | **pass** |
| 15-assert | 基版 UI | A 批量面板列出 a/b/c 三行，B/C 卡片是 0.0.1 | rows=a,b,c；B clientTag=client v0.0.1；C 徽标 0.0.1 | {"rows":"a,b,c","cardB":"client v0.0.1","cardC":{"present":true,"clientTag":"client v0.0.1","badge":"夹具 C · client v0.0.1"},"disk":{"versions":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":"0.0.1","dsh-plugin-update-fixture-c":"0.0.1"},"dependencies":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":"0.0.1","dsh-plugin-update-fixture-c":"0.0.1"}}} | **pass** |
| 18-assert | 变体发布 | B 变体版内容确实换了（client/host bundle sha256 与基版不同） | B 的 client/host bundle sha256 均与 0.0.1 不同 | {"canRed":false,"publishesC":false,"oldHashB":{"client":"fb45379759000e9f28a542c4bd1321b57f66d9dc6914fcf43a1f2a9831a9481e","host":"3b96a7414d552893e5d7f87cf5915b071eaa8ff7601f693839b042f1db321f9e"},"newHashB":{"client":"5568a4fa5586eb966a86fc3555341243aa1086e81753d8cbd1ff28bf88aeb130","host":"2fe19363fa6cef330a2fbd5ccff98896f1a34d0e04f6e2d535d6506d149afa84"},"oldHashC":null,"newHashC":null,"canRedStaleHost":null} | **pass** |
| 20-assert | 变体可见 | B 的 0.0.2 已在 registry 可见，C 仍只有 0.0.1（A 面板宏安装只装 B） | B 元数据含 0.0.1 与 0.0.2；C 元数据只有 0.0.1 | {"b":["0.0.1","0.0.2"],"c":["0.0.1"]} | **pass** |
| 22-assert | 真 UI 检查更新 | A 批量面板 B 行读到 0.0.2，C 仍是基版（宏按钮只会装 B） | B 行 versionNew=0.0.2；C 行无 0.0.2 | {"b":{"key":"b","phase":"pending","queued":false,"busy":false,"title":"夹具 B","status":"有新版本 0.0.2","versionCur":"0.0.1","versionNew":"0.0.2","actions":["toggle-details","toggle-details"],"fail":null},"c":{"key":"c","phase":"pending","queued":false,"busy":false,"title":"夹具 C","status":"已是最新，无需操作。","versionCur":"0.0.1","versionNew":null,"actions":["toggle-details","toggle-details"],"fail":null}} | **pass** |
| 25-assert | 失败注入 | 删掉 B@0.0.2 的 tarball、保留版本文档（让候选门能过、pnpm 下载 404） | 删前 200 非空；删后 404；版本文档一字不差 | {"servedBeforeStatus":200,"servedBeforeBytes":110047,"servedAfterStatus":404,"versionDocUnchanged":true} | **pass** |
| 27-assert | D3 已失败落定 | 失败安装落一个 failed 终态（不是 interrupted/成功） | fxa-b state.json：state=failed，targetVersion=0.0.2 | {"observed":["missing","installing","failed"],"failed":{"file":"D:\\dsh-plugin\\_wt263\\runtime\\t4-268\\268-20261102T175424\\home\\updates\\fxa-b\\ebfbb0014c0c0156c05840fd\\state.json","state":{"id":"868125b0-cae5-4749-ae4c-f051a5cc6458","state":"failed","targetVersion":"0.0.2","message":"install-failed: Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt): [ERR_P；目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制手工命令重新安装 (dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-b@0.0.2 --registry=http://127.0.0.1:59475)","requestId":"batch-mvz34845-uwv5gngt19-b-a1a1a300","previousVersion":"0.0.1"}}} | **pass** |
| 29-assert | D3 UI 显示失败 | A 面板 B 行显示诚实失败码（install-failed，或宿主换代瞬间的 recovery-required；不是「正在安装」/成功） | phase=failed；红字含 install-failed 或 recovery-required；页面无「正在安装」/成功说法 | {"rowB":{"key":"b","phase":"failed","queued":false,"busy":false,"title":"夹具 B","status":"安装失败，请选择「重试」。","versionCur":"未安装","versionNew":"0.0.2","actions":["toggle-details","row-install","toggle-details"],"fail":"失败 install-failed：安装执行失败，详情见诊断摘要"},"rowCode":"install-failed","pageTextTail":null} | **pass** |
| 32-assert | D3 UI 失败面 + 手工命令可得 | 失败行详情能取到手工命令；或按产品既有语义（T3 e2 先例、#177 手工命令可信来源）失败面不画载体命令、退化为「复制诊断」，此时可执行命令必须仍在台账人话里供复制 —— 两种形态都要求失败面如实可取证，不伪造 DOM | 详情含 dsh plugin --profile desktop add --save-exact 或按钮 row-copy-manual；否则：详情必有 row-copy-diag，且台账 message 里能取出可执行手工命令 | {"detailLoaded":true,"hasManualCommand":false,"actions":["row-install","row-check","row-copy-diag","detail-close"],"uiOffersManual":false,"uiOffersDiag":true,"ledgerManualCommand":"dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-b@0.0.2 --registry=http://127.0.0.1:59475","detailTail":"fxa-b\n使用范围 desktopprofile\n更新失败（install-failed）：安装执行失败，详情见诊断摘要。\n请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者\n运行版\n未知\n已安装\n未安装\n最新版\n未知\n重试检查更新复制诊断\n01\n检查与安装\n02\n更新日志\n尚未查询到新版本；查询到后将显示更新日志。\n03\n更新队列\n当前无排队任务；同一使用范围同时仅安装一项。\n04\n错误信息\n稳定码 install-failed：上方中文说明即需执行的操作；如需向上游反馈，请使用「复制诊断」整段粘贴（已脱敏）。\n请查看日志：<DSH_HOME>/logs/<derived>（一个插件一棵目录，互不覆盖）。一条命令看：npx dsh-log <log-dir>；按插件标识 fxa-b 筛选 host.call、host.call.fail、update.install.exec 事件。\n05\n手工命令\n当前没有可用的手工命令。读不到正在运行的版本号，无法保证给出的命令不会降级。重启宿主后再查一次；若仍读不到，请把复制诊断发给插件作者。\n关闭窗口，更新不受影响，可随时返回查看。\n关闭"} | **pass** |
| 34-assert | D3 台账人话格 | 失败台账 message 以 install-failed 开头、带 pnpm 原话与可执行重装命令（UI 复制按钮的源） | 前缀 install-failed；含手工命令 dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-b@0.0.2 | {"message":"install-failed: Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt): [ERR_P；目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制手工命令重新安装 (dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-b@0.0.2 --registry=http://127.0.0.1:59475)","manualCommand":"dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-b@0.0.2 --registry=http://127.0.0.1:59475"} | **pass** |
| 42-assert | D3 无自动重试 | 失败落定后静置 15s，只发生一次真实安装尝试：1 条 exec、exec 收场 1 条 fail；前面的 gate check-expired 是 #70 当场重查重提（同一次尝试，src/host/batch/phones.ts:388-410），不是第二次安装；静置期间没有新增 exec | update.install.exec 条数=1；exec 收场 fail 恰 1 条；ok=true 条数=0；其余 fail 只允许 gate/check-expired | {"execCount":1,"failCount":1,"execFailCount":1,"gateFailCount":0,"okCount":0,"durations":[2728]} | **pass** |
| 43-assert | D3 失败八格 | exec/fail 日志字段自洽（出口二失败：route=desktop-manager、stage=exec、退出码非 0） | exec.route=desktop-manager；exec.ok=false；exec.exitCode 为整数；fail.stage=exec；fail.reason=nonzero-exit；fail.code=install-failed | {"exec":{"route":"desktop-manager","ok":false,"exitCode":1,"durationMs":2728,"pluginId":"fxa-b","traceId":"6e82108e14f97fca","spanId":"46f9c7e4","seq":4},"fail":{"stage":"exec","reason":"nonzero-exit","code":"install-failed","hostCodeHash":"none","check":"none","exitCode":1,"observedVersion":null,"intentHash":"361d8f0b","traceId":"6e82108e14f97fca","spanId":"46f9c7e4","seq":6}} | **pass** |
| 44-assert | D3 磁盘无虚假成功 | 失败后磁盘 B 不是 0.0.2（没有出现台账失败但盘上新版的假成功） | versions[B]≠0.0.2；dependencies[B]≠0.0.2 | {"versions":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":null,"dsh-plugin-update-fixture-c":"0.0.1"},"dependencies":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":null,"dsh-plugin-update-fixture-c":"0.0.1"},"manifest":{"name":"dsh-profile-desktop","private":true,"dependencies":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-c":"0.0.1"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-plugin-update-fixture-a","dsh-plugin-update-fixture-c"]}}}} | **pass** |
| 47-assert | D3 重启后如实展示 | 重启后台账仍 failed；B 行不谎称更新中/已完成（失败不自动重试，重启也不改写台账；#152 检查把行按磁盘真相重算），C 仍 0.0.1 | ledger.state=failed 且 target=0.0.2；rowB 非 done/current/installing/queued、无「已是最新/安装完成/更新成功」、不宣称 0.0.2 已装；页面无「正在安装」；C 0.0.1 | {"rowB":{"key":"b","phase":"ready","queued":false,"busy":false,"title":"夹具 B","status":"选择「安装此插件」安装 0.0.2","versionCur":"未安装","versionNew":"0.0.2","actions":["toggle-details","row-install","toggle-details"],"fail":null},"ledger":{"file":"D:\\dsh-plugin\\_wt263\\runtime\\t4-268\\268-20261102T175424\\home\\updates\\fxa-b\\ebfbb0014c0c0156c05840fd\\state.json","state":{"id":"868125b0-cae5-4749-ae4c-f051a5cc6458","state":"failed","targetVersion":"0.0.2","message":"install-failed: Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt): [ERR_P；目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制手工命令重新安装 (dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-b@0.0.2 --registry=http://127.0.0.1:59475)","requestId":"batch-mvz34845-uwv5gngt19-b-a1a1a300","previousVersion":"0.0.1"}},"rowHonest":true,"claimsRunning":false,"cardC":{"present":true,"key":"c","ui":"none","wiring":"none","clientTag":"client v0.0.1","badgeText":"夹具 C · client v0.0.1","dshUpdCount":0,"dockCount":0,"entryCount":0}} | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 16-shot | 基版 UI | A 批量面板与 B/C 卡片的初始形态 | 三行；B/C 0.0.1；面板可见 | rows=a,b,c；B=client v0.0.1；C=client v0.0.1 | **pass** | [shots\16-shot.png](shots\16-shot.png) |
| 23-shot | 真 UI 检查更新 | A 批量面板 B 行已显示可更新到 0.0.2（C 仍基版） | B 行 0.0.2；C 不显示 0.0.2 | versionNew B=0.0.2 C=null | **pass** | [shots\23-shot.png](shots\23-shot.png) |
| 31-shot | D3 行详情 | 失败行详情弹窗里的失败码、诊断入口与手工命令（按产品真实能力：读不到运行版时 05 段会明说「当前没有可用的手工命令」并指引重启/复制诊断） | 详情含可复制手工命令（或按钮 row-copy-manual）；否则至少有 row-copy-diag 且台账 message 带可执行命令 | {"hasManualCommand":false,"actions":["row-install","row-check","row-copy-diag","detail-close"],"textTail":"fxa-b\n使用范围 desktopprofile\n更新失败（install-failed）：安装执行失败，详情见诊断摘要。\n请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者\n运行版\n未知\n已安装\n未安装\n最新版\n未知\n重试检查更新复制诊断\n01\n检查与安装\n02\n更新日志\n尚未查询到新版本；查询到后将显示更新日志。\n03\n更新队列\n当前无排队任务；同一使用范围同时仅安装一项。\n04\n错误信息\n稳定码 install-failed：上方中文说明即需执行的操作；如需向上游反馈，请使用「复制诊断」整段粘贴（已脱敏）。\n请查看日志：<DSH_HOME>/logs/<derived>（一个插件一棵目录，互不覆盖）。一条命令看：npx dsh-log <log-dir>；按插件标识 fxa-b 筛选 host.call、host.call.fail、update.install.exec 事件。\n05\n手工命令\n当前没有可用的手工命令。读不到正在运行的版本号，无法保证给出的命令不会降级。重启宿主后再查一次；若仍读不到，请把复制诊断发给插件作者。\n关闭窗口，更新不受影响，可随时返回查看。\n关闭"} | **pass** | [shots\31-shot.png](shots\31-shot.png) |
| 48-shot | D3 重启后如实展示 | 重启后台账仍 failed、B 行不谎称更新中/已完成（包被移除时按磁盘投影为未安装可装） | B 行非 done/current/installing、不显示「已是最新/安装完成」；页面无「正在安装」 | {"rowB":{"key":"b","phase":"ready","queued":false,"busy":false,"title":"夹具 B","status":"选择「安装此插件」安装 0.0.2","versionCur":"未安装","versionNew":"0.0.2","actions":["toggle-details","row-install","toggle-details"],"fail":null},"rowHonest":true} | **pass** | [shots\48-shot.png](shots\48-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [fixture-published-baseline](raw\04-fixture-published-baseline.json)
- [desktop-first-launch](raw\06-desktop-first-launch.json)
- [desktop-stop-bootstrap](raw\07-desktop-stop-bootstrap.json)
- [install-baseline](raw\08-install-baseline.json)
- [sut-installed-dist](raw\12-sut-installed-dist.json)
- [batch-panel-initial](raw\14-batch-panel-initial.json)
- [fixture-publications](raw\17-fixture-publications.json)
- [registry-metadata-variants](raw\19-registry-metadata-variants.json)
- [panel-after-check](raw\21-panel-after-check.json)
- [registry-tarball-fault](raw\24-registry-tarball-fault.json)
- [ledger-observation-failure](raw\26-ledger-observation-failure.json)
- [panel-after-failure](raw\28-panel-after-failure.json)
- [row-detail-after-failure](raw\30-row-detail-after-failure.json)
- [failure-human-message](raw\33-failure-human-message.json)
- [desktop-stop-after-failure](raw\35-desktop-stop-after-failure.json)
- [log-fxa-a-2026-11-02](raw\36-log-fxa-a-2026-11-02.json)
- [log-fxa-b-2026-11-02](raw\37-log-fxa-b-2026-11-02.json)
- [log-fxa-c-2026-11-02](raw\38-log-fxa-c-2026-11-02.json)
- [log-fxb-b-2026-11-02](raw\39-log-fxb-b-2026-11-02.json)
- [log-fxb-c-2026-11-02](raw\40-log-fxb-c-2026-11-02.json)
- [failure-log-counts](raw\41-failure-log-counts.json)
- [batch-panel-after-restart-failure](raw\45-batch-panel-after-restart-failure.json)
- [panel-after-restart-failure](raw\46-panel-after-restart-failure.json)
- [desktop-stop-final-failure](raw\49-desktop-stop-final-failure.json)

## 清理

- 进程 desktop-bootstrap（pid 30388）：停止后存活=false
- 进程 desktop-main（pid 86344）：停止后存活=false
- 进程 desktop-restart-after-failure（pid 45456）：停止后存活=false
- 端口 registry（59475）：已释放=true
- 本地 registry：http://127.0.0.1:59475（仓库外 verdaccio，run 内独立 storage）
- D3 失败格：真 UI 点 A 面板宏按钮「全部更新」（此时知识里只有 B 可更新）；安装窗口只轮询磁盘台账
- D3 静置 15000ms，验证已失败不被自动重试

## 维护者 profile 未污染

- 目录：C:\Users\辰辰洋洋\.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:59475（仓库外 verdaccio，run 内独立 storage）
- D3 失败格：真 UI 点 A 面板宏按钮「全部更新」（此时知识里只有 B 可更新）；安装窗口只轮询磁盘台账
- D3 静置 15000ms，验证已失败不被自动重试

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
