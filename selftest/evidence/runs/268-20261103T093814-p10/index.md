# 真机证据索引 · g1-desktop-manager-install-timeout

- runId：268-20261103T093814-p10
- 票：#268
- 宿主通道：desktop-official
- 开始/结束：2026-11-03T02:03:43.038Z / 2026-11-03T02:07:50.848Z
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
| 08-assert | 慢安装地基 | 延迟代理把 pnpm 请求挂 60s，产品安装预算 12s（经夹具 config.installTimeoutMs 透传） | 代理监听并只延迟 pnpm 请求（产品自己的 check 不延迟） | proxy http://127.0.0.1:61384，delayMs=60000，installTimeoutMs=12000 | **pass** |
| 12-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | 干净 profile 装基版（c） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-c@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-c；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b, dsh-plugin-update-fixture-c]；磁盘版本=0.0.1；exit=0 | **pass** |
| 16-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 18-assert | 基版 UI | A 批量面板列出 a/b/c 三行，B/C 卡片是 0.0.1 | rows=a,b,c；B clientTag=client v0.0.1；C 徽标 0.0.1 | {"rows":"a,b,c","cardB":"client v0.0.1","cardC":{"present":true,"clientTag":"client v0.0.1","badge":"夹具 C · client v0.0.1"},"disk":{"versions":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":"0.0.1","dsh-plugin-update-fixture-c":"0.0.1"},"dependencies":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":"0.0.1","dsh-plugin-update-fixture-c":"0.0.1"}}} | **pass** |
| 21-assert | 变体发布 | B 变体版内容确实换了（client/host bundle sha256 与基版不同） | B 的 client/host bundle sha256 均与 0.0.1 不同 | {"canRed":false,"publishesC":false,"oldHashB":{"client":"652952ca987eac9246b009b1b40cb855f297dbd3ff7393b5f208a818e4960a5a","host":"3b96a7414d552893e5d7f87cf5915b071eaa8ff7601f693839b042f1db321f9e"},"newHashB":{"client":"2dbb3a32bd6d44ea5d6d1f7c0dcc213af097b55d224bf866d82cabd33c8e7e53","host":"95204a4dc2e157285a5130d9217795c0306eb2b8b2e31978cb3c1c653a152869"},"oldHashC":null,"newHashC":null,"canRedStaleHost":null} | **pass** |
| 23-assert | 变体可见 | B 的 0.0.2 已在 registry 可见，C 仍只有 0.0.1（A 面板宏安装只装 B） | B 元数据含 0.0.1 与 0.0.2；C 元数据只有 0.0.1 | {"b":["0.0.1","0.0.2"],"c":["0.0.1"]} | **pass** |
| 25-assert | 真 UI 检查更新 | A 批量面板 B 行读到 0.0.2，C 仍是基版（宏按钮只会装 B） | B 行 versionNew=0.0.2；C 行无 0.0.2 | {"b":{"key":"b","phase":"pending","queued":false,"busy":false,"title":"夹具 B","status":"有新版本 0.0.2","versionCur":"0.0.1","versionNew":"0.0.2","actions":["toggle-details","toggle-details"],"fail":null},"c":{"key":"c","phase":"pending","queued":false,"busy":false,"title":"夹具 C","status":"已是最新，无需操作。","versionCur":"0.0.1","versionNew":null,"actions":["toggle-details","toggle-details"],"fail":null}} | **pass** |
| 28-assert | D1 超时终态 | 慢安装到点后台账落一个 failed 终态（target 0.0.2 / previous 0.0.1） | fxa-b 的 state.json：state=failed，targetVersion=0.0.2，previousVersion=0.0.1 | {"observed":["missing","installing","failed"],"failed":{"file":"D:\\dsh-plugin\\_wt263\\runtime\\t11-275\\268-20261103T093814-p10\\home\\updates\\fxa-b\\2b073346c58fbe2939253f59\\state.json","state":{"id":"fe5e14bb-2613-4f61-8efc-832d9e89b019","state":"failed","targetVersion":"0.0.2","message":"install-failed: 安装已被取消；目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制手工命令重新安装 (dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-b@0.0.2 --registry=http://127.0.0.1:61384)","requestId":"batch-mw01q4kb-zfil9b6few-b-2743fd09","previousVersion":"0.0.1"}}} | **pass** |
| 37-assert | D1 exec 日志 | update.install.exec 记一次 desktop-manager 失败，耗时不短于 12s 安装预算 | route=desktop-manager，ok=false，durationMs≥12000 | {"count":1,"fields":{"route":"desktop-manager","ok":false,"exitCode":null,"durationMs":12547,"pluginId":"fxa-b","traceId":"a23f740845f36b74","spanId":"f81d17ac","seq":4}} | **pass** |
| 38-assert | D1 fail 日志 | update.install.fail 与实际收场一致：exec 收场恰 1 条；前面若出现 gate check-expired，是 #70/ADR-0004 §3 的当场重查重提（≥2 家的批每家首次都会走，src/host/batch/phones.ts:388-410），属同一次安装尝试，不掩盖真实收场 | exec 收场恰 1 条：stage=exec、code=install-failed、reason∈{timeout,host-rejected}；其余 fail 只允许 stage=gate、code=check-expired；最后一条是 exec 收场 | {"count":1,"execFailCount":1,"gateFailCount":0,"last":{"stage":"exec","reason":"host-rejected","code":"install-failed","hostCodeHash":"85037520","check":"none","exitCode":null,"observedVersion":null,"intentHash":"125b357f","traceId":"a23f740845f36b74","spanId":"f81d17ac","seq":6},"gateFails":[]} | **pass** |
| 39-assert | D1 人话格诚实 | 超时人话格与宿主取消能力一致：有 cancelInstall 时要么「已请求宿主取消」、要么宿主真取消后「安装已被取消」；不许说未提供能力或已终止 | message 以 install-failed 开头；不含「未提供取消能力」「已终止」；reason=host-rejected 时日志有 hostCodeHash 且人话含「安装已被取消」 | {"message":"install-failed: 安装已被取消；目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制手工命令重新安装 (dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-b@0.0.2 --registry=http://127.0.0.1:61384)","failReason":"host-rejected","hostCodeHash":"85037520","claimsNoCancel":false,"claimsTerminated":false} | **pass** |
| 43-assert | D1 管理器操作 | plugin-manager 真的走过移除→安装（超时格在安装步挂住） | 操作记录 ≥1 个非空目录，且出现移除 0.0.1 的记录 | {"count":2,"nonEmptyCount":2,"order":"remove-only","operations":[{"dirName":"operation-0IAIaz","createdAt":"2026-11-03T02:05:43.765Z","modifiedAt":"2026-11-03T02:05:43.765Z","pnpmLogBytes":513,"pnpmLog":"[WARN] The store at C:\\Users\\辰辰洋洋\\AppData\\Local\\pnpm\\store\\v11 is not used because packages cannot be hard linked from it into this project. Using the store at D:\\.pnpm-store\\v11 instead. Set storeDir to choose the store.\n? Verifying lockfile against supply-chain policies (5 entries)...\n✓ Lockfile passes supply-chain policies (5 entries in 1ms)\nLockfile is up to date, resolution step is skipped\nAlready up to date\n\ndependencies:\n- dsh-plugin-update-fixture-b 0.0.1\n\nDone in 283ms using pnpm v11.28.5\n","removed":[{"name":"dsh-plugin-update-fixture-b","version":"0.0.1"}],"added":[],"doneIn":"283ms using pnpm v11.28.5","empty":false},{"dirName":"operation-uA0Lnt","createdAt":"2026-11-03T02:05:44.525Z","modifiedAt":"2026-11-03T02:05:44.525Z","pnpmLogBytes":357,"pnpmLog":"[WARN] The store at C:\\Users\\辰辰洋洋\\AppData\\Local\\pnpm\\store\\v11 is not used because packages cannot be hard linked from it into this project. Using the store at D:\\.pnpm-store\\v11 instead. Set storeDir to choose the store.\n? Verifying lockfile against supply-chain policies (4 entries)...\n✓ Lockfile passes supply-chain policies (4 entries in 2ms)\n","removed":[],"added":[],"doneIn":null,"empty":false}]} | **pass** |
| 44-assert | D1 磁盘无虚假成功 | 超时收场后磁盘上 B 仍是 0.0.1（没有出现台账失败但盘上新版的假成功） | versions[B]≠0.0.2 且 dependencies[B]≠0.0.2 | {"versions":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":null,"dsh-plugin-update-fixture-c":"0.0.1"},"dependencies":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":null,"dsh-plugin-update-fixture-c":"0.0.1"},"manifest":{"name":"dsh-profile-desktop","private":true,"dependencies":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-c":"0.0.1"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-plugin-update-fixture-a","dsh-plugin-update-fixture-c"]}}}} | **pass** |
| 47-assert | D1 重启后如实展示 | 重启后台账仍 failed；A 面板 B 行不谎称在飞/成功（管理器移除 B 后，自动检查按磁盘真相把行重算为「未安装/可装 0.0.2」——#152 既有语义） | ledger.state=failed 且 target=0.0.2；rowB 非 done/current/installing/queued、无「已是最新/安装完成/更新成功」、不宣称 0.0.2 已装；页面无「正在安装」 | {"rowB":{"key":"b","phase":"failed","queued":false,"busy":false,"title":"夹具 B","status":"安装失败，请选择「重试」。","versionCur":"未安装","versionNew":"0.0.2","actions":["toggle-details","row-install","toggle-details"],"fail":"失败 install-failed：安装执行失败，详情见诊断摘要"},"ledger":{"file":"D:\\dsh-plugin\\_wt263\\runtime\\t11-275\\268-20261103T093814-p10\\home\\updates\\fxa-b\\2b073346c58fbe2939253f59\\state.json","state":{"id":"fe5e14bb-2613-4f61-8efc-832d9e89b019","state":"failed","targetVersion":"0.0.2","message":"install-failed: 安装已被取消；目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制手工命令重新安装 (dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-b@0.0.2 --registry=http://127.0.0.1:61384)","requestId":"batch-mw01q4kb-zfil9b6few-b-2743fd09","previousVersion":"0.0.1"}},"rowHonest":true,"claimsRunning":false} | **pass** |
| 48-assert | D1 重启后其它席别 | 超时失败没有牵连 C（仍 0.0.1），页面无在飞宣称 | C 徽标 0.0.1；无「正在安装」 | {"cardC":{"present":true,"key":"c","ui":"none","wiring":"none","clientTag":"client v0.0.1","badgeText":"夹具 C · client v0.0.1","dshUpdCount":0,"dockCount":0,"entryCount":0},"claimsRunning":false} | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 19-shot | 基版 UI | A 批量面板与 B/C 卡片的初始形态 | 三行；B/C 0.0.1；面板可见 | rows=a,b,c；B=client v0.0.1；C=client v0.0.1 | **pass** | [shots\19-shot.png](shots\19-shot.png) |
| 26-shot | 真 UI 检查更新 | A 批量面板 B 行已显示可更新到 0.0.2（C 仍基版） | B 行 0.0.2；C 不显示 0.0.2 | versionNew B=0.0.2 C=null | **pass** | [shots\26-shot.png](shots\26-shot.png) |
| 30-shot | D1 超时 UI | A 面板 B 行在超时后显示失败（失败码不是「正在安装」） | phase=failed；红字含 install-failed；页面无「正在安装」 | {"phase":"failed","fail":"失败 install-failed：安装执行失败，详情见诊断摘要","status":"安装失败，请选择「重试」。","busy":false} | **pass** | [shots\30-shot.png](shots\30-shot.png) |
| 49-shot | D1 重启后如实展示 | 重启后台账仍 failed、A 面板 B 行不谎称更新中/已完成（包被管理器移除时行按磁盘投影为未安装可装） | B 行非 done/current/installing、不显示「已是最新/安装完成」；页面无「正在安装」 | {"rowB":{"key":"b","phase":"failed","queued":false,"busy":false,"title":"夹具 B","status":"安装失败，请选择「重试」。","versionCur":"未安装","versionNew":"0.0.2","actions":["toggle-details","row-install","toggle-details"],"fail":"失败 install-failed：安装执行失败，详情见诊断摘要"},"rowHonest":true} | **pass** | [shots\49-shot.png](shots\49-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [delaying-proxy](raw\07-delaying-proxy.json)
- [desktop-first-launch](raw\09-desktop-first-launch.json)
- [desktop-stop-bootstrap](raw\10-desktop-stop-bootstrap.json)
- [install-baseline](raw\11-install-baseline.json)
- [sut-installed-dist](raw\15-sut-installed-dist.json)
- [batch-panel-initial](raw\17-batch-panel-initial.json)
- [fixture-publications](raw\20-fixture-publications.json)
- [registry-metadata-variants](raw\22-registry-metadata-variants.json)
- [panel-after-check](raw\24-panel-after-check.json)
- [ledger-observation-timeout](raw\27-ledger-observation-timeout.json)
- [panel-after-timeout](raw\29-panel-after-timeout.json)
- [desktop-stop-after-timeout](raw\31-desktop-stop-after-timeout.json)
- [log-fxa-a-2026-11-03](raw\32-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\33-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\34-log-fxa-c-2026-11-03.json)
- [log-fxb-b-2026-11-03](raw\35-log-fxb-b-2026-11-03.json)
- [log-fxb-c-2026-11-03](raw\36-log-fxb-c-2026-11-03.json)
- [plugin-manager-operation-operation-0IAIaz](raw\40-plugin-manager-operation-operation-0IAIaz.json)
- [plugin-manager-operation-operation-uA0Lnt](raw\41-plugin-manager-operation-operation-uA0Lnt.json)
- [plugin-manager-operations-timeout](raw\42-plugin-manager-operations-timeout.json)
- [batch-panel-after-restart-timeout](raw\45-batch-panel-after-restart-timeout.json)
- [panel-after-restart-timeout](raw\46-panel-after-restart-timeout.json)
- [desktop-stop-final-timeout](raw\50-desktop-stop-final-timeout.json)

## 清理

- 进程 desktop-bootstrap（pid 62296）：停止后存活=false
- 进程 desktop-main（pid 79688）：停止后存活=false
- 进程 desktop-restart-after-timeout（pid 93992）：停止后存活=false
- 端口 delaying-registry-proxy（61384）：已释放=true
- 端口 registry（57933）：已释放=true
- 本地 registry：http://127.0.0.1:57933（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- D1 超时格：真 UI 点 A 面板宏按钮「全部更新」（此时知识里只有 B 可更新）；安装窗口只轮询磁盘台账（不碰 CDP，宿主移除/重装可能换页面）

## 维护者 profile 未污染

- 目录：C:/Users/辰辰洋洋/.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:57933（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- D1 超时格：真 UI 点 A 面板宏按钮「全部更新」（此时知识里只有 B 可更新）；安装窗口只轮询磁盘台账（不碰 CDP，宿主移除/重装可能换页面）

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
