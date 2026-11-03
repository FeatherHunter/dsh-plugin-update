# 真机证据索引 · g2-batch-queued-cancel

- runId：268-20261102T174922
- 票：#268
- 宿主通道：desktop-official
- 开始/结束：2026-11-02T09:49:22.918Z / 2026-11-02T09:54:24.179Z
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
| 07-assert | 慢安装地基 | 延迟代理把 pnpm 请求挂 60s，产品安装预算 40s（经夹具 config.installTimeoutMs 透传） | 代理监听并只延迟 pnpm 请求（产品自己的 check 不延迟） | proxy http://127.0.0.1:50386，delayMs=60000，installTimeoutMs=40000 | **pass** |
| 11-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 12-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | 干净 profile 装基版（c） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-c@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-c；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b, dsh-plugin-update-fixture-c]；磁盘版本=0.0.1；exit=0 | **pass** |
| 15-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | 25f1970da9af6a36eac92a2bd84b5b4fa0839fbb54de0411a17b60f308e15b28 | 25f1970da9af6a36eac92a2bd84b5b4fa0839fbb54de0411a17b60f308e15b28（文件数 208 / 工作树 208） | **pass** |
| 17-assert | 基版 UI | A 批量面板列出 a/b/c 三行，B/C 卡片是 0.0.1 | rows=a,b,c；B clientTag=client v0.0.1；C 徽标 0.0.1 | {"rows":"a,b,c","cardB":"client v0.0.1","cardC":{"present":true,"clientTag":"client v0.0.1","badge":"夹具 C · client v0.0.1"},"disk":{"versions":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":"0.0.1","dsh-plugin-update-fixture-c":"0.0.1"},"dependencies":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":"0.0.1","dsh-plugin-update-fixture-c":"0.0.1"}}} | **pass** |
| 20-assert | 变体发布 | C 变体版内容确实换了（client bundle sha256 与基版不同；该格只发 C） | C 的 client sha256 与基版不同；B 未发布 0.0.2 | {"canRed":false,"publishesC":true,"oldHashB":{"client":"fb45379759000e9f28a542c4bd1321b57f66d9dc6914fcf43a1f2a9831a9481e","host":"3b96a7414d552893e5d7f87cf5915b071eaa8ff7601f693839b042f1db321f9e"},"newHashB":null,"oldHashC":{"client":"702b04232df1f4a555693f4ddeb438d4e6eec482ef021d04df9548441a28d306","host":"dbc9e7763edb5b044442684e2d25b2641a5c093e7cbf135ad53de12272124260"},"newHashC":{"client":"7314eee4792c7aeca029db45b872fc5434d7e1739ece5c6e663ba2df62bcd8cf","host":"ca9c615e7f36884f6709a13eb64181eb42a9d3d6610a469492f2a6d3bab1c545"},"canRedStaleHost":null} | **pass** |
| 22-assert | 变体可见 | C 的 0.0.2 已在 registry 可见，B 仍只有 0.0.1（A 面板宏安装只会轮到 C） | C 元数据含 0.0.1 与 0.0.2；B 元数据只有 0.0.1 | {"b":["0.0.1"],"c":["0.0.1","0.0.2"]} | **pass** |
| 24-assert | 真 UI 检查更新 | A 批量面板 C 行读到 0.0.2，B 仍是基版（宏按钮只会轮到 C 被排队门挡下） | C 行 versionNew=0.0.2；B 行无 0.0.2 | {"b":{"key":"b","phase":"pending","queued":false,"busy":false,"title":"夹具 B","status":"已是最新，无需操作。","versionCur":"0.0.1","versionNew":null,"actions":["toggle-details","toggle-details"],"fail":null},"c":{"key":"c","phase":"pending","queued":false,"busy":false,"title":"夹具 C","status":"有新版本 0.0.2","versionCur":"0.0.1","versionNew":"0.0.2","actions":["toggle-details","toggle-details"],"fail":null}} | **pass** |
| 27-assert | D2 占锁方受理 | B 的夹具桥打单插件电话 fxb-c.updateCheck/updateInstall：拿到 checkId、安装电话受理（电话先回，慢安装 exec 在后台跑）；check-expired 按产品批量电话口径重查重提 | check 回包 reply.ok=true 且有 receipt.checkId；install 回包 reply.ok=true（最多 5 次，同一次 read 内 check 后立即 install） | {"accepted":true,"attemptCount":1,"checkId":"ba6b3263-b624-413c-af8f-813ac1a2aba1","requestId":"g2-occupier-20261102T174922-1","lastAttempt":{"attempt":1,"check":{"route":"/_dsh/selftest-fixture-b","envelopeOk":true,"reply":{"ok":true,"snapshot":{"runningVersion":"0.0.1","installed":true,"installedVersion":"0.0.1","latestVersion":"0.0.2","canInstall":true,"blockedReason":null,"job":null,"identity":"update","registered":true},"manual":"dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-c@0.0.2 --registry=http://127.0.0.1:50386","receipt":{"checkId":"ba6b3263-b624-413c-af8f-813ac1a2aba1","checkedAt":1793613127305,"expiresAt":1793613727305},"queue":{"busy":false,"owner":null,"waiting":[],"position":null},"env":{"profileName":"desktop","environmentKind":"desktop-manager","registered":true,"updaterVersion":"0.18.39","updaterCopyLevel":"profile"}},"error":null},"install":{"route":"/_dsh/selftest-fixture-b","envelopeOk":true,"reply":{"ok":true,"snapshot":{"runningVersion":"0.0.1","installed":true,"installedVersion":"0.0.1","latestVersion":"0.0.2","canInstall":false,"blockedReason":null,"job":{"id":"5171375d-787d-4368-bf88-2d3c26e55f8b","state":"installing","targetVersion":"0.0.2","message":null,"requestId":"g2-occupier-20261102T174922-1","previousVersion":"0.0.1"},"identity":"update","registered":true},"manual":"dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-c@0.0.2 --registry=http://127.0.0.1:50386","receipt":null},"error":null},"accepted":true}} | **pass** |
| 29-assert | D2 队列占用 | 单插件安装电话先起的 C 慢安装已占住全局执行锁（queue.json 的 owner 是 B 运行时里的 C 目标 fxb-c） | owner.pluginId=fxb-c | {"present":true,"owner":{"pluginId":"fxb-c","jobId":"5171375d-787d-4368-bf88-2d3c26e55f8b","requestId":"g2-occupier-20261102T174922-1","targetVersion":"0.0.2","startedAt":1793613127332},"waiting":[],"raw":{"version":1,"owner":{"pluginId":"fxb-c","jobId":"5171375d-787d-4368-bf88-2d3c26e55f8b","requestId":"g2-occupier-20261102T174922-1","targetVersion":"0.0.2","startedAt":1793613127332},"waiting":[]}} | **pass** |
| 31-assert | D2 真 UI 排队 | 第二个安装进队列：A 面板 C 行 data-queued=1 且出现「取消排队」按钮 | rowC.queued=true；actions 含 row-cancel-queue | {"key":"c","phase":"ready","queued":true,"busy":false,"title":"夹具 C","status":"已排队 · 前方还有 1 项","versionCur":"0.0.1","versionNew":"0.0.2","actions":["toggle-details","row-cancel-queue","toggle-details"],"fail":null} | **pass** |
| 34-assert | D2 队列落盘 | queue.json 的 waiting 里有 A 会话 C 的占位（requestId 是出发安装时排上的） | waiting 含 pluginId=fxa-c | {"present":true,"owner":{"pluginId":"fxb-c","jobId":"5171375d-787d-4368-bf88-2d3c26e55f8b","requestId":"g2-occupier-20261102T174922-1","targetVersion":"0.0.2","startedAt":1793613127332},"waiting":[{"pluginId":"fxa-c","requestId":"batch-mvz2y2t0-nbw8blbu8g-c-800d95ec","targetVersion":null,"enqueuedAt":1793613127937}],"raw":{"version":1,"owner":{"pluginId":"fxb-c","jobId":"5171375d-787d-4368-bf88-2d3c26e55f8b","requestId":"g2-occupier-20261102T174922-1","targetVersion":"0.0.2","startedAt":1793613127332},"waiting":[{"pluginId":"fxa-c","requestId":"batch-mvz2y2t0-nbw8blbu8g-c-800d95ec","targetVersion":null,"enqueuedAt":1793613127937}]}} | **pass** |
| 36-assert | D2 排队窗内占锁方未被误判中断 | 排队窗内 A 侧电话持续换 sharedReader 槽：占锁方 fxb-c 台账仍是 installing（不是 interrupted/recovery-required），执行锁仍被它持有（上一条 owner 断言） | fxb-c 台账恰 1 条且 state=installing；无 interrupted | {"aC":"fxa-c","bC":"fxb-c","ownerLedger":[{"file":"D:\\dsh-plugin\\_wt263\\runtime\\t4-268\\268-20261102T174922\\home\\updates\\fxb-c\\3fa834a7715fea4219cbe846\\state.json","state":{"id":"5171375d-787d-4368-bf88-2d3c26e55f8b","state":"installing","targetVersion":"0.0.2","message":null,"requestId":"g2-occupier-20261102T174922-1","previousVersion":"0.0.1"}}]} | **pass** |
| 38-assert | D2 行取消排队文案诚实 | 点 C 行「取消排队」：回执如实说明只撤本次等待占位、本批仍会继续尝试安装、不会终止在飞安装（不谎称「不再等待」） | notice 含「已取消排队」与「继续」；不含「不再等待/已终止/已请求终止」 | {"notice":"已取消排队：本次等待占位已撤掉，本批仍会继续尝试安装（不会终止正在安装的项）。","rowC":{"key":"c","phase":"ready","queued":false,"busy":false,"title":"夹具 C","status":"选择「安装此插件」安装 0.0.2","versionCur":"未安装","versionNew":"0.0.2","actions":["toggle-details","row-install","toggle-details"],"fail":null}} | **pass** |
| 43-assert | D2 真 UI 丢弃本批（两步确认） | 两步确认真 UI 点「丢弃本批未完成的更新」：回执如实说已丢弃未完成项（已完成的将保留），C 行不再排队/不在安装，页面不谎称已终止在飞安装 | 第一次点击进入 data-confirm=1 上膛；第二次点击后 notice 含「已丢弃」；rowC 不 queued/installing；无终止假话 | {"notice":"已丢弃本批未完成的更新（已完成的将保留）。","rowC":{"key":"c","phase":"pending","queued":false,"busy":false,"title":"夹具 C","status":"有新版本 0.0.2","versionCur":"0.0.1","versionNew":"0.0.2","actions":["toggle-details","toggle-details"],"fail":null},"attempts":1} | **pass** |
| 46-assert | D2 丢弃后批量会话清空 | 「丢弃本批」把 A 会话从磁盘清掉（不产生成功/失败终态）；C 行在任何残留会话里都不是 done/failed | 磁盘上不存在含 A entry 的批量会话；C 行 phase 不为 done/failed | {"aSession":null,"cPhase":null} | **pass** |
| 48-assert | D2 丢弃后不再排队 | 丢弃后 8 次队列采样（约 4s）：A 会话 C 的 waiting 占位没有再出现；owner 只允许 null（丢弃清场后的正常态）或仍为占锁方 | 全部采样 waiting 不含 fxa-c；owner ∈ {null, fxb-c} | {"noRequeue":true,"ownerReleasedOrOccupier":true,"samples":[{"atMs":2,"ownerId":null,"waitingIds":[]},{"atMs":505,"ownerId":null,"waitingIds":[]},{"atMs":1008,"ownerId":null,"waitingIds":[]},{"atMs":1511,"ownerId":null,"waitingIds":[]},{"atMs":2016,"ownerId":null,"waitingIds":[]},{"atMs":2518,"ownerId":null,"waitingIds":[]},{"atMs":3021,"ownerId":null,"waitingIds":[]},{"atMs":3523,"ownerId":null,"waitingIds":[]}]} | **pass** |
| 50-assert | D2 占位者收局（噪声） | 占锁方的 C 慢安装真的以它自己的安装预算超时失败落定（证明取消期间执行锁确被占用；本格判据只看 A 的 C 不装） | fxb-c 台账 state=failed；从占锁开始到失败 ≥ 产品安装预算 40000ms（远大于本格取消排队发生的时刻） | {"observed":["failed"],"entry":{"file":"D:\\dsh-plugin\\_wt263\\runtime\\t4-268\\268-20261102T174922\\home\\updates\\fxb-c\\3fa834a7715fea4219cbe846\\state.json","state":{"id":"5171375d-787d-4368-bf88-2d3c26e55f8b","state":"failed","targetVersion":"0.0.2","message":"install-failed: 安装已被取消；目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制手工命令重新安装 (dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-c@0.0.2 --registry=http://127.0.0.1:50386)","requestId":"g2-occupier-20261102T174922-1","previousVersion":"0.0.1"}},"elapsedMs":68134} | **pass** |
| 52-assert | D2 队列清空 | 占位者收局后 queue.json 没有残留占位：owner 释放、waiting 为空（撤销与收尾都留下了账） | owner=null 且 waiting 为空 | {"present":true,"owner":null,"waiting":[],"raw":{"version":1,"owner":null,"waiting":[]}} | **pass** |
| 60-assert | D2 丢弃后不安装 | A 会话的 C 从未开始安装：没有 update.install.exec（丢弃的是未完成批次，不是终止在飞安装） | fxa-c 的 update.install.exec 条数=0 | {"aExecCount":0,"events":[]} | **pass** |
| 61-assert | D2 排队/丢弃不算失败 | A 的 C 的 update.install.fail 只允许排队门拒绝（stage=gate；code∈{check-expired,update-busy}；首提当场重查重提与公平门都是设计内事件；核心 acquire 立即忙时工厂公平门不会发这行，所以空列表也算诚实），不允许 install-failed | A 的 C 的 fail 事件为空或全部 stage=gate code∈{check-expired,update-busy} | {"count":4,"fields":[{"stage":"gate","reason":"gate-refused","code":"check-expired","hostCodeHash":"none","check":"none","exitCode":null,"observedVersion":null,"intentHash":"a18a71f1","traceId":"bc994d557f5e58c0","spanId":"942d17dc","seq":1},{"stage":"gate","reason":"gate-refused","code":"update-busy","hostCodeHash":"none","check":"none","exitCode":null,"observedVersion":null,"intentHash":"a18a71f1","traceId":"6b9829699dac9e87","spanId":"0d3062aa","seq":3},{"stage":"gate","reason":"gate-refused","code":"update-busy","hostCodeHash":"none","check":"none","exitCode":null,"observedVersion":null,"intentHash":"a18a71f1","traceId":"5da6ebb65e50f767","spanId":"448d6cc7","seq":1},{"stage":"gate","reason":"gate-refused","code":"update-busy","hostCodeHash":"none","check":"none","exitCode":null,"observedVersion":null,"intentHash":"a18a71f1","traceId":"da0e6e11c9d414f6","spanId":"668001ff","seq":2}]} | **pass** |
| 62-assert | D2 无虚假终态 | A 的 C 没有台账记录（排队撤销后没有启动安装，不存在成功/失败终态） | fxa-c 的 state.json 条数=0 | {"aLedger":[]} | **pass** |
| 63-assert | D2 丢弃不产生 0.0.2 安装 | 丢弃没有造成任何 0.0.2 安装副作用（占锁方慢安装超时后已被宿主移除并重装失败，磁盘 C 不是 0.0.2） | versions[C]≠0.0.2；dependencies[C]≠0.0.2 | {"versions":null,"dependencies":null,"disk":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":"0.0.1","dsh-plugin-update-fixture-c":null}} | **pass** |
| 65-assert | D2 取消未终止在飞安装 | 占锁方的 update.install.exec 跑满自己的安装预算才收尾（取消排队只撤 waiting 占位，没有终止正在跑的安装） | bExec 恰 1 条且 durationMs ≥ 40000ms（ok=false） | {"count":1,"durationMs":40391,"ok":false,"route":"desktop-manager"} | **pass** |
| 68-assert | D2 重启后如实展示 | 重启后 A 面板 C 行不再排队/不在安装、页面无「正在安装」，C 目标卡不谎称 0.0.2（磁盘如实：占锁方的超时失败移除了 C） | rowC.queued=false 且 phase≠installing；无「正在安装」；C 卡不显示 client v0.0.2 | {"rowC":{"key":"c","phase":"pending","queued":false,"busy":false,"title":"夹具 C","status":"有新版本 0.0.2","versionCur":"0.0.1","versionNew":"0.0.2","actions":["toggle-details","toggle-details"],"fail":null},"claimsRunning":false,"cardC":{"present":false,"key":null,"ui":null,"wiring":null,"clientTag":null,"badgeText":null,"dshUpdCount":0,"dockCount":0,"entryCount":0},"diskC":null} | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 18-shot | 基版 UI | A 批量面板与 B/C 卡片的初始形态 | 三行；B/C 0.0.1；面板可见 | rows=a,b,c；B=client v0.0.1；C=client v0.0.1 | **pass** | [shots\18-shot.png](shots\18-shot.png) |
| 25-shot | 真 UI 检查更新 | A 批量面板 C 行已显示可更新到 0.0.2（B 仍基版） | C 行 0.0.2 | versionNew B=null C=0.0.2 | **pass** | [shots\25-shot.png](shots\25-shot.png) |
| 32-shot | D2 真 UI 排队 | A 面板 C 行排队中（有取消排队按钮） | C 行 queued + row-cancel-queue | {"key":"c","phase":"ready","queued":true,"busy":false,"title":"夹具 C","status":"已排队 · 前方还有 1 项","versionCur":"0.0.1","versionNew":"0.0.2","actions":["toggle-details","row-cancel-queue","toggle-details"],"fail":null} | **pass** | [shots\32-shot.png](shots\32-shot.png) |
| 39-shot | D2 行取消排队文案诚实 | 行取消排队回执（钉住 #268 文案修复后的诚实措辞） | 已取消排队 + 本批仍会继续尝试 + 不终止在飞安装 | {"notice":"已取消排队：本次等待占位已撤掉，本批仍会继续尝试安装（不会终止正在安装的项）。","rowC":{"key":"c","phase":"ready","queued":false,"busy":false,"title":"夹具 C","status":"选择「安装此插件」安装 0.0.2","versionCur":"未安装","versionNew":"0.0.2","actions":["toggle-details","row-install","toggle-details"],"fail":null}} | **pass** | [shots\39-shot.png](shots\39-shot.png) |
| 44-shot | D2 真 UI 丢弃本批（两步确认） | 丢弃本批后的面板（回执 + C 行状态） | 已丢弃本批未完成的更新；C 行不再排队/安装 | {"notice":"已丢弃本批未完成的更新（已完成的将保留）。","rowC":{"key":"c","phase":"pending","queued":false,"busy":false,"title":"夹具 C","status":"有新版本 0.0.2","versionCur":"0.0.1","versionNew":"0.0.2","actions":["toggle-details","toggle-details"],"fail":null}} | **pass** | [shots\44-shot.png](shots\44-shot.png) |
| 69-shot | D2 重启后如实展示 | 重启后 A 面板 C 行未在排队/安装，C 目标卡不谎称已到 0.0.2 | C 行不排队、不安装；C 卡不显示 v0.0.2 | {"rowC":{"key":"c","phase":"pending","queued":false,"busy":false,"title":"夹具 C","status":"有新版本 0.0.2","versionCur":"0.0.1","versionNew":"0.0.2","actions":["toggle-details","toggle-details"],"fail":null},"cardC":{"present":false,"key":null,"ui":null,"wiring":null,"clientTag":null,"badgeText":null,"dshUpdCount":0,"dockCount":0,"entryCount":0}} | **pass** | [shots\69-shot.png](shots\69-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [fixture-published-baseline](raw\04-fixture-published-baseline.json)
- [delaying-proxy](raw\06-delaying-proxy.json)
- [desktop-first-launch](raw\08-desktop-first-launch.json)
- [desktop-stop-bootstrap](raw\09-desktop-stop-bootstrap.json)
- [install-baseline](raw\10-install-baseline.json)
- [sut-installed-dist](raw\14-sut-installed-dist.json)
- [batch-panel-initial](raw\16-batch-panel-initial.json)
- [fixture-publications](raw\19-fixture-publications.json)
- [registry-metadata-variants](raw\21-registry-metadata-variants.json)
- [panel-after-check](raw\23-panel-after-check.json)
- [occupier-phone-replies](raw\26-occupier-phone-replies.json)
- [queue-owner-before](raw\28-queue-owner-before.json)
- [panel-after-queue](raw\30-panel-after-queue.json)
- [queue-before-cancel](raw\33-queue-before-cancel.json)
- [queue-window-owner-ledger](raw\35-queue-window-owner-ledger.json)
- [panel-after-row-cancel](raw\37-panel-after-row-cancel.json)
- [row-cancel-reenqueue-timeline](raw\40-row-cancel-reenqueue-timeline.json)
- [discard-armed-1](raw\41-discard-armed-1.json)
- [panel-after-discard](raw\42-panel-after-discard.json)
- [batch-ledger-after-discard](raw\45-batch-ledger-after-discard.json)
- [queue-after-discard](raw\47-queue-after-discard.json)
- [owner-failed-noise](raw\49-owner-failed-noise.json)
- [queue-settled](raw\51-queue-settled.json)
- [desktop-stop-after-cancel](raw\53-desktop-stop-after-cancel.json)
- [log-fxa-a-2026-11-02](raw\54-log-fxa-a-2026-11-02.json)
- [log-fxa-b-2026-11-02](raw\55-log-fxa-b-2026-11-02.json)
- [log-fxa-c-2026-11-02](raw\56-log-fxa-c-2026-11-02.json)
- [log-fxb-b-2026-11-02](raw\57-log-fxb-b-2026-11-02.json)
- [log-fxb-c-2026-11-02](raw\58-log-fxb-c-2026-11-02.json)
- [cancel-outcome](raw\59-cancel-outcome.json)
- [occupier-exec-duration](raw\64-occupier-exec-duration.json)
- [batch-panel-after-restart-cancel](raw\66-batch-panel-after-restart-cancel.json)
- [panel-after-restart-cancel](raw\67-panel-after-restart-cancel.json)
- [desktop-stop-final-cancel](raw\70-desktop-stop-final-cancel.json)

## 清理

- 进程 desktop-bootstrap（pid 53316）：停止后存活=false
- 进程 desktop-main（pid 75480）：停止后存活=false
- 进程 desktop-restart-after-cancel（pid 51224）：停止后存活=false
- 端口 delaying-registry-proxy（50386）：已释放=true
- 端口 registry（58828）：已释放=true
- 本地 registry：http://127.0.0.1:58828（仓库外 verdaccio，run 内独立 storage）
- D2 行取消只撤占位：实测 撤销后 2ms 同一插件占位又被中枢重推；因此改用「丢弃本批」作终态取消。

## 维护者 profile 未污染

- 目录：C:\Users\辰辰洋洋\.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:58828（仓库外 verdaccio，run 内独立 storage）
- D2 行取消只撤占位：实测 撤销后 2ms 同一插件占位又被中枢重推；因此改用「丢弃本批」作终态取消。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
