# 日志事件目录：19 环节 → 事件码 / 级别 / 档位 / 字段 / 脱敏

- 日期：2026-10-14（**2026-10-15 契约回填**：本文件的「事件名 / 字段 / 取值」三处与随包清单、实现对齐；见文末 §7。**2026-10-19 二次回填（`#211`）**：五个事件的字段与枚举按随包清单一字回填，错误类别细化见 §8。**2026-10-19 三次回填（`#208`）**：批量三事件补 `sessionHash` / `stage` / `index` / `stoppedBecause`，`host.call.fail` 与批量面板客户端日志接上批量现场；事件名与档位归属不变、字段 +6，见 §9。**2026-10-19 四次回填（`#209`）**：队列 / 锁 / 存储三行补持有者指纹与清理相位、批量异常停止行、轮询失败心跳；事件名与档位归属不变、字段实发 +3（白名单净新增一栏 `update.queue.transition.holderHash`，`update.lock.anomaly.ownerHash` 与 `update.store.fail.dirHash` 原已声明、本票转为实发），见 §10。**2026-10-19 五次回填（`#206` P2-1）**：HEAD（`18df6d7`）重查基线 + 对抗审查 §8.3 五处修正落字，见 §11）
- 本票：[规格定稿](https://github.com/FeatherHunter/dsh-plugin-update/issues/119)（地图 [本包全面集成 dsh-log 0.3.1](https://github.com/FeatherHunter/dsh-plugin-update/issues/117)）
- 上游事实源：`docs/research/20261014-update-logging-inventory.md`（19 环节清单与逐条 `文件:行号`）、`docs/research/20261014-dsh-log-031-api.md`、`docs/research/20261014-dsh-host-logging-surface.md`
- 立规的两份 ADR：[ADR-0005 运行期依赖与落盘归属](https://github.com/FeatherHunter/dsh-plugin-update/blob/main/docs/adr/0005-dsh-log-as-first-runtime-dependency.md)、[ADR-0006 行只承载稳定码](https://github.com/FeatherHunter/dsh-plugin-update/blob/main/docs/adr/0006-log-rows-carry-codes-not-prose.md)
- **本文件是字段与事件名的事实源**：实现票（宿主侧接线 #124、面板侧通道 #122、清单与门禁 #120）正文里若有出入，以此处为准。

## 0. 口径与图例

- **环节 ≠ 事件**：一个事件可以承载多个环节的边沿（例如 `update.panel.mount` 同时是 ① 和面板/入口/批量三处挂载点），一个环节（⑫ 队列与锁）也可以有两个事件。下表每行给出该环节的落点事件与它贡献的字段。
- 档位（dsh-log 的 `kind`）：
  - **resident**——dsh-log 的准入判定对清单声明 `kind:'resident'` 的事件直接放行，**调试开关关着也落盘**，所以必须低频。**「必须边沿触发」不是机器规则**：全仓只有 `update.status.changed` 与 `update.queue.transition` 两条在发射侧做了指纹去重（`src/log/emit.ts` 的 `isEdgeEvent` 只认这两条），其余靠各自的守卫（例如 `guard:'接线一次一条'`）与「一个流程只发一次」的落点纪律；新增常驻事件时**守卫要自己写**，引擎不会拦你。
  - **ondemand**——开关打开才落盘，可以逐次打点；
  - **selfmon**——本包日志接线自身的降级，永不外抛。`update.log.degraded` 是 `warn`，按 dsh-log 的紧急级规则恒放行，不受 `kind` 影响。
- 级别：`error` 用于「本包坏了/渲染失败」；`warn` 用于「这次操作没成，但系统还活着」；`info` 用于「做成了、走到哪一步了」。
- 侧：**Node** = 只许在 `import 'node:'` 的五个文件里发射；**中立** = 不依赖 DOM 也不依赖 node（可两边跑）；**客户端** = 面板/入口件里，只能经本包自己的 `logAppend` 电话（#122）。
- 既有三个事件名（`host.call`、`host.call.fail`、`update.install.exec`）**形状冻结**，被 `tests/phones.test.mjs:222/232`、`tests/routes.test.mjs:106` 逐字锁死：本次只改「发不发」，不改字段。批量电话（`#208`）复用 `host.call.fail`：字段仍是五格，只改「发不发」与去重口径（见 §9.2）。

## 1. 常驻（resident）

| 事件码 | 级别 | 字段白名单 | 说明与脱敏 |
| --- | --- | --- | --- |
| `update.wire.ready` | info | `logSink: 'external'\|'external-unverified'\|'self'\|'off'`、`logDirHash`、`updaterVersion`、`copyLevel`、`hostKind` | 接线自陈（外部实例 / 外部未验证 / 自建 / 关）。目录只给 hash8，不给路径。`updaterVersion`：此刻在说话的本包版本（读不到显式 null）；`copyLevel` 四值 `'profile'`（使用范围级）/`'nested'`（消费方嵌套副本）/`'repo'`（开发仓库）/`'unknown'`；`hostKind` 三值 `'desktop'`/`'desktop-manager'`/`'cli'`。外部落点门径非 `open` 时记 `external-unverified`，不冒充 `external`（门径 = 对方实例 `isEnabled(level, event)` 返回真布尔 `true`；给不出 `isEnabled`、调用抛错或返回 `false` 都算非 open）。注意 `false`（closed）时这一行会被对方准入当场跳过（它拒收的正是同一道门），现场可能**看不到任何接线行**——那时以回包 `logHealth.external` 为准。本包接线时只探门径，**不代查**对方有没有把本包事件清单 merge 进去（README 第 10 节第 ② 条自检） |
| `update.check.done` | info | `ok: true`、`current?`、`latest`、`channel`、`source`、`latencyMs`、`blockedReason`、`fallback`、`dataSource`、`pendingRestart`、`jobState` | 版本号经中央校验器规范化；`source` 只给白名单主机名（复用 `resolveRegistryHost`）、**不带路径与账号**；非默认 registry 且主机名不可写时落 `'custom'` 哨兵（只说明「不是默认源」，不泄露地址）。`current` 可选：运行版本未知时省略（不伪造版号，也不写 null）。`blockedReason`：检查完成后仍挡着安装的原因（`'none'` 或 11 个阻挡码之一）；`fallback: boolean`：这次取数是否走了通道回退；`dataSource: 'npm-version'\|'npm-channel'`：版本号来自正常取数还是通道回退（与 `fallback` 同源） |
| `update.check.fail` | warn | `stage: 'fetch'\|'compare'\|'channel'\|'verify'`、`errorKind`、`httpStatus?`、`latencyMs`、`source` | 无自由文本。**`errorKind` 是失败类别**（十值：`timeout`/`network`/`dns`/`tls`/`http`/`bad-json`/`too-large`/`shape`/`channel`/`unknown`），**不是公开稳定码**——面板与诊断仍用 `code`，判定源见 §8.1。`latencyMs`：从发起取数到失败；`source`：出问题的 registry 主机名（白名单口径同 done 行；非默认源不可写时落 `'custom'`，拿不到时省略）。`stage` 四个值都是**合法值**，但**实际可达三个**：`fetch`（取数失败，`src/service.ts:308`）、`channel`（通道判定不认，`:400/:463/:493` 的 `withStage(..., 'channel')`）、`verify`（`stageOfError()` 的兜底：非 `check-failed` 又没贴阶段）。`compare` 在白名单里但**没有生产者** |
| `update.status.changed` | info | `kind: 'update-available'\|'up-to-date'\|'unknown'`、`latest`、`runningVersion`、`installedVersion`、`registered`、`identity: 'update'\|'first-install'\|'up-to-date'\|'unknown'`、`blockedReason`、`unknownCause?` | 轮询的**边沿**：状态没变就不发（见 §4）；边沿键是整条真值元组（本行八格）的指纹，**任一分量变化发一条**。版本三格（`latest`/`runningVersion`/`installedVersion`）未知时**显式写 null**，不省成假值、不伪装版本号；`registered` 是在册事实（`boolean`，读不到显式 null）；`blockedReason` 固定给值（没挡写 `'none'`）；`identity` 固定给值（判定不了写 `'unknown'`）；`kind: 'unknown'` 时**必须**带 `unknownCause`（`'no-latest'` 没拿到最新版 / `'running-version-unknown'` 运行版未知 / `'compare-failed'` 比较失败），kind 已知时省略 `unknownCause` |
| `update.install.request` | info | `from: 'panel'\|'entry'\|'batch'`、`current?`、`latest`、`checkAgeMs`、`intentHash` | 不含凭证；`checkId`/`requestId` 不进日志（关联靠 `traceId`）。`current` 可选：运行版本未知时省略（不伪造版号） |
| `update.install.verify` | info | `result: 'completed'\|'restart-required'\|'failed'\|'interrupted'`、`installedVersion`、`pendingRestart: boolean` | 枚举 + 版本号 |
| `update.batch.entry.request` | info | `total`、`ownCount`、`foreignCount`、`sessionHash` | 只给数量，不给插件标识清单。`sessionHash`（`#208`）是**批次编号的 hash8**：同一批的入队 / 失败 / 总账三条行靠它串起来（三条行可能落在不同目录，见 §9.1）。落属主（`selfKey` 那家）目录；无属主一行不发 |
| `update.batch.entry.fail` | warn | `targetHash`、`sessionHash`、`errorKind`、`stage`、`index`、`exitCode?` | 目标标识一律 hash8（绝不给包名/路径原文）。`stage` 四值：`check`（查询 / 装前重查失败）、`install`（提交安装失败）、`timeout`（等安装终态超时）、`settle`（收尾：装到终态才失败）；`index` 是该目标在**整批**里的 0 基序号（视图只推进选中行时仍按整批顺序；算不出就整格不出，不拿 0 冒充第一家）；`exitCode` 只在真拿到退出码时出现。**落失败那家自己的插件目录**——与属主无关，无属主也照落（见 §9.1） |
| `update.batch.summary` | info | `total`、`ok`、`failed`、`skipped`、`durationMs`、`sessionAgeMs`、`resumed`、`sessionHash`、`stoppedBecause` | 总账的机器可读版；面板渲染文本不进日志。`stoppedBecause` 七值（`#208` 五值 + `#209` 补 `user-cancel` / `error`）：`finished`（全部跑完，**不代表没失败**）/ `stopped-after-failure`（遇错按策略停）/ `max-steps`（步数预算用完，等下一轮）/ `empty`（没有可推进的目标）/ `queued`（进了队列还没轮到，不是失败）/ `user-cancel`（用户取消整批，会话被清掉前记一条）/ `error`（驱动抛异常，含后台 drain）；值来自最近一次推进的读数（没推进过按 `finished`）。`#209` 起**未跑完就停下**时（`queued` / `stopped-after-failure` / `user-cancel` / `error`）在停下那一刻另记一条同字段行（同一会话同一原因只记一次，见 §10.4），收尾行语义不变。落属主目录；无属主一行不发 |
| `update.queue.transition` | info | `phase: 'queued'\|'running'\|'done'\|'reclaimed'\|'pruned'\|'abandoned'`、`waitedMs?`、`position?`、`holderHash?` | 相位边沿，禁止每次轮询都发。相位是**队列自己的**三相位（取号 / 安装中 / 摘牌）加全局锁陈旧回收成功这一个真跃迁；`#209` 再补两个「待办被摘」相位（`pruned` 意向过期被清理 / `abandoned` 主动放弃，判据见 §10.1），`checking`/`installing`/`settling`/`idle` 是面板任务词，队列里没有这些相位（#124 落地时按实现收紧，见 §3.1）。`holderHash`（`#209`）是行落那一刻**持有队列那家**的 `hash8(pluginId)`（队列空时省略一格格）；同一份队列状态一次写盘可能发多条（多条待办同时被摘时逐条发），每条按「动作方 + 相位 + 逐条待办主体（intentKey）」做指纹去重，所以同相位下不同待办各留一条 |
| `update.lock.anomaly` | warn | `kind: 'stale-owner'\|'release-failed'\|'busy-owner'`、`ageMs?`、`ownerHash?` | 拥有者标识只记 hash8，不记原文。`ownerHash`（`#209` 实发）是锁持有者的 `hash8`（锁内容里 `pluginId`/`id`/`pid`/`startedAt` 有哪格拼哪格，`key:value` 用 `|` 连接后再哈希，取法见 §10.2；缺哪格就少拼哪格，绝不放路径/原文）；`busy-owner`（`#209`）说明锁被**新鲜**持有者占着、本次抢锁当场认输：`ageMs` 是它已持有多久（读得出 `startedAt` 用逻辑钟算，读不出回退文件 mtime 且必须用墙钟——`queueLockAge()`，见 §10.2），同一持有者连续只记首次（换持有者才再记）。`stale-owner` / `release-failed` 一并补 `ownerHash`（读不出锁内容时省略）。`busy-timeout` **仍不做**：本包两条抢锁路径都是「看一眼，不陈旧就当场认输」（`tryAcquireLock` 不等待；`tryAcquireGlobalLock` 的 `timeoutMs` 是**陈旧阈值**不是等待超时），没有「等到超时」这条路径，不为了凑齐词汇造一条（见 §3.1） |
| `update.store.fail` | warn | `op: 'read-job'\|'write-job'\|'acquire-lock'\|'reclaim-stale-owner'\|'release-lock'\|'read-snapshot'\|'write-backup'\|'write-queue'\|'read-global-lock'\|'acquire-global-lock'\|'release-global-lock'`、`reason`、`dirHash` | 现在 `catch {}` 静默吞的点。`op` 是**真正失败的那个动作**（比「state-read/state-write」粗归类更能定位）；`reason` 是 `error.code` 过白名单后的小写稳定码（`enoent`/`eacces`/`eexist`/… 共 25 个），拿不到码退 `'throw'`、连错误对象都不是退 `'unknown'`，绝不放 `message`/路径。同一操作**同一原因**连续失败只记首次（原因变了再记一条，成功即清）。`dirHash`（`#209` 实发）是失败所在目录的 sha256 前 8 位短指纹（磁盘端口取 `updates/<pluginId>/<profileHash>` 目录、队列端口取 `update-queue/<profileHash>` 目录，与 `logDirHash` 同族口径），**绝不入路径原文**；`ownerHash` 归 `update.lock.anomaly`，本事件不声明 |
| `update.panel.mount` | info | `mode`、`theme`、`lang`、`pollMs`、`autoCheck` | 全是枚举与数字。`mode` 的**可达五值**：`'entry'`（`src/entry.ts:590` 的 `clientLog:{mount:'entry'}`）、`'http'`（`src/http.ts:353` 的默认挂载点名）、`'batch'`（批量面板与批量入口件，`#208` 起都传 `clientLog` 报 `'batch'`，见 §9.3）、以及没给挂载点名时退回的面板 `mode` 选项 `'embedded'\|'dialog'`（`src/panel.ts:41` `UpdatePanelMode`）。**`'entry-batch'` 仍不可达**：批量两处挂载点都报 `'batch'`。`autoCheck` 记这面面板/按钮会话挂载后**自动检查有没有跑**：`'started'`（自动查已发起）/ `'recent'`（首刷快照显示 job 在 installing/verifying 或已有动作在飞，再查只会得到同一结论，跳过）/ `'disabled'`（调用方显式关掉自动检查）/ `'failed'`（首刷失败、没拿到状态，自动检查没跑成）；面板行在首次刷新完成或失败之后才发，保证记的是事实而不是预告；安装按钮同口径——`autoCheck:'mount'` 时挂载行等首刷（含首刷触发的自动查）落定后按事实写 `'started'` / `'recent'` / `'failed'`（语义同面板行），`autoCheck:'never'` 时写 `'disabled'` 且不刷新、零请求 |
| `update.panel.action` | info | `action`、`bytes?`、`truncated?`、`ok`、`errorKind?`、`durationMs`、`errorHash?` | `action` 取值**十一**个，与 `src/panel.ts:199-210` 的 `UpdatePanelActionKind` 一字不差：`'check'`、`'install'`、`'skip'`、`'reset-skip'`、`'copy-manual'`、`'copy-diag'`、`'toggle-queue'`、`'toggle-changelog'`、`'restart-hint'`、`'close-view'`、`'dismiss-failure'`。`#208` 起批量面板复用同一事件：`action` 取 `src/panel-batch.ts:166-188` 的 22 个批量动作（`check`/`install`/`resume`/`cancel`/`row-install`/`row-check`/`row-skip`/`row-resume-skip`/`row-cancel-queue`/`row-copy-manual`/`row-copy-diag`/`copy-all-diag`/`copy-all-manual`/`row-fallback`/`row-fallback-confirm`/`batch-fallback-scan`/`batch-fallback-confirm`/`toggle-details`/`detail-close`/`restart`/`close`/`toggle-check-on-open`），`ok` / `errorKind` / `durationMs` 同口径（清单里 `action` 仍是自由字符串，不锁枚举）。复制诊断只记体量与是否截断，**绝不记内容**（`bytes`/`truncated` 只跟着 `'copy-diag'` 走）。`ok`：这次点击的结局（成功 `true`；失败 `false`）；`errorKind`：失败类别——锁存稳定码、动作直接抛错记 `'thrown'`、已有动作在途被拒记 `'busy'`，成功时省略；`durationMs`：从点击到动作落定（含提前 return 的分支）；`errorHash`：失败原文的 8 位指纹，**不落原话** |
| `update.panel.render.fail` | error | `kind: 'container'\|'plugin-id'\|'call'\|'prefix'\|'poll-ms'\|'mode'\|'auto-check'\|'theme'\|'theme-tokens'\|'locale'\|'render'\|'transport'\|'uncaught'\|'unhandled'`、`phase: 'mount'\|'paint'\|'poll'\|'global'`、`errorHash` | 挂载校验、绘制、轮询与全局兜底的四相位失败；无自由文本，`errorHash` 是原话的 8 位指纹（不落原文）。同一 `phase\|kind\|errorHash` 60 秒内至多一行 |
| `update.log.degraded` | warn | `reason: 'no-dsh-log'\|'lease-conflict'\|'write-fail'\|'emit-threw'\|'unknown-event'\|'unknown-field'\|'invalid-enum'\|'client-batch-refused'\|'client-drop-overflow'\|'client-drop-host-refused'\|'client-drop-send-failed'\|'client-drop-disposed'`、`event?`、`field?` | selfmon：日志接线自己的坏消息。`#210` 起字段级漂移不再整行丢：摘掉该字段、整行照落，并记一条带 `event`/`field` 的降级行（两格只放清单内机器标识，非法形状打成 `<event>`/`<field>`，按「原因+事件+字段」只记首次）；未知事件仍整行不落盘。`#214` 起再加客户端丢弃与宿主拒收五类（`client-*`：每因终身至多一条；`client-drop-no-channel` 物理上无投递面，只进内部分计数、不上浮）。清单顶层 `fieldEnums` 是枚举值的机器声明 |

## 2. 按需（ondemand，开关打开才落）

| 事件码 | 级别 | 字段白名单 | 说明与脱敏 |
| --- | --- | --- | --- |
| `update.check.start` | info | `trigger: 'auto'\|'user'\|'batch'\|'entry'`、`source` | ② 的关键：把「用户点了」与「自动触发」分开 |
| `update.registry.fetch` | info | `httpStatus`、`latencyMs`、`registryHost` | 只记白名单主机名与状态码，**不记完整 URL**（ADR-0001 规则 3）。**`cacheHit` 不是字段**：本包的缓存命中发生在取数之前（命中就根本不取数），到了取数点就一定是未命中——恒为 `false` 的格子只是噪声，已从随包清单删除（见 §4 第 2 条） |
| `update.channel.decide` | info | `channel`、`reason: 'stable'\|'prerelease'\|'mismatch'\|'invalid'`、`from`、`to` | 版本号规范化后入行 |
| `update.changelog.parse` | info | `version`、`entries: number`、`truncated: boolean`、`degraded: boolean`、`status`、`cached`、`source` | 解析失败只记 `degraded` + 稳定码；原文留给人话出口。**`source` 恒为 `'npm'`**（`src/host.ts:1071` 写死）：本包只从 npm 取变更日志，`'tarball'`/`'installed'`/`'release'` 三个值从未出现 |
| `update.poll` | info | `state`、`latencyMs` | 轮询全量（排查用）；稳态靠 resident 的 `update.status.changed` |
| `update.lang.applied` | info | `lang`、`source` | 语言标签已规范化。`source` 是**四个值**（`src/lang.ts:77` `LangSignalSource`）：`'override'`（集成方传了 locale）、`'dom'`（`html[lang]`）、`'navigator'`、`'default'`（都没有时的兜底） |
| `update.panel.state` | info | `state: 'ready'\|'busy'\|'error'`、`theme`、`tokensApplied: number`、`fallback: boolean` | 主题只记枚举名与 token 数，**不记 CSS 值原文**（防注入面） |

## 3. 19 环节 × 落点（覆盖 19/19，逐行给全：事件码 / 级别 / 档位 / 接线票）

| # | 环节 | 侧 | 落点事件 | 级别 | 档位 | 接线票 |
| --- | --- | --- | --- | --- | --- | --- |
| ① | 面板打开/挂载（`src/panel.ts:1999`、`src/entry.ts:351`、`src/entry-batch.ts:308`、`src/panel-batch.ts:1533`、`src/http.ts:345/376/408`） | 客户端 | `update.panel.mount`；校验失败 `update.panel.render.fail` | info / error | resident | **#122** |
| ② | 自动检查更新（`src/panel.ts:1981`） | 客户端 | `update.check.start`（`trigger:'auto'`）→ ③ 的 done/fail | info | ondemand | **#122** 打点，**#124** 接宿主侧 |
| ③ | 单插件 check（`src/host.ts:696` → `src/service.ts:424`） | Node + 客户端触发 | `update.check.done` / `update.check.fail` / `update.check.start`；既有 `host.call`·`host.call.fail` 保留 | info / warn | resident + ondemand | **#124** |
| ④ | npm registry 查询（`src/service.ts:274`、`:346`） | 中立 | `update.registry.fetch` | info | ondemand | **#124**（`/http` 变体落 `src/http.ts:230`，走 **#122**） |
| ⑤ | 版本比较/通道判定（`src/service.ts:107`、`:127`、`:147`） | 中立 | `update.channel.decide`；失败码并入 `update.check.fail.stage:'channel'` | info / warn | ondemand + resident | **#124** |
| ⑥ | changelog 获取与解析（`src/changelog-io.ts:265`、`src/changelog.ts:266`） | Node IO + 中立解析 | `update.changelog.parse`；既有 `host.call`（`kind:'update-changelog'`）保留 | info | ondemand | **#124** |
| ⑦ | 用户点击安装（`src/panel.ts:2760` `case 'install'`） | 客户端 | `update.panel.action`（`action:'install'`）+ 宿主侧 `update.install.request` | info | resident | **#122** + **#124** |
| ⑧ | 安装执行（`src/store.ts:1180`，三条路由） | Node | 既有 `update.install.exec`（5 键，形状不动） | info | resident | 已存在；**#124** 只改「发不发」与行列归属 |
| ⑨ | 安装后校验（`src/service.ts:475`、`src/reader.ts:342`） | Node | `update.install.verify` | info | resident | **#124** |
| ⑩ | 失败重试（单插件 `src/panel.ts` 的重试按钮；批量 `src/panel-batch.ts:920` `data-act="row-install"`） | 客户端 | `update.panel.action`（`action:'install'` —— 重试就是再发一次安装；批量侧同一动作）。**没有 `update.install.retry` 这个事件**：本包**没有自动重试**，`attempt`/`of` 那套「第 N 次重试」不存在 | info | resident | **#122** |
| ⑪ | 批量面板入队（`src/host-batch.ts:579`） | Node | `update.batch.entry.request`；挂载点并入 `update.panel.mount` | info | resident | **#124** + **#122**；**#208** 补 `sessionHash` |
| ⑫ | 队列两阶段/全局锁（`src/queue.ts`、`src/store.ts:287/349`） | Node | `update.queue.transition`、`update.lock.anomaly` | info / warn | resident | **#124** |
| ⑬ | 单项失败（批量）（`src/batch-run.ts:122`、`:159`） | 中立 | `update.batch.entry.fail` | warn | resident | **#124**；**#208** 补 `stage` / `index` / `sessionHash` |
| ⑭ | 总账（`src/panel-batch.ts:242`、`:283`） | 客户端渲染 | `update.batch.summary`（宿主侧汇总后发） | info | resident | **#124**；面板只渲染、**不重复发**；**#208** 补 `sessionHash` / `stoppedBecause` |
| ⑮ | 重启宿主（单插件 `src/panel.ts` `case 'restart-hint'`；批量 `src/panel-batch.ts:926` `data-act="restart"`） | 客户端触发 | `update.panel.action`（`action:'restart-hint'`）。**没有 `update.restart.outcome` 这个事件**：宿主没有重启自己的电话（代码原话），本包只做入口、**观测不到重启结果** | info | resident | **#122** |
| ⑯ | 语言选择（`src/lang.ts:80`） | 客户端 | `update.lang.applied` | info | ondemand | **#122** |
| ⑰ | 主题渲染（`src/panel.ts:51`、`:154`、`:1847`） | 客户端 | `update.panel.state`（`theme`/`tokensApplied`/`fallback`）；非法值并入 `update.panel.render.fail` | info / error | ondemand + resident | **#122** |
| ⑱ | 落盘决策（`src/store.ts:62`、`:118`，state/锁/备份） | Node | `update.store.fail`；锁异常 `update.lock.anomaly` | warn | resident | **#124** |
| ⑲ | 复制诊断（`src/panel.ts:450` `buildDiagnosticText`、`:592` `buildUpdateDiagCopy`） | 客户端 | `update.panel.action`（`action:'copy-diag'`，附 `bytes`/`truncated`） | info | resident | **#122** |

**覆盖自查：19 行齐，每行都有事件码、级别、档位、接线票；没有未填项。**

**两条曾登记为「事件」的环节已改判（2026-10-15 契约回填）**：⑩ 失败重试与 ⑮ 重启宿主**都有日志**，但落的是 `update.panel.action` 的对应取值，不是 `update.install.retry` / `update.restart.outcome` —— 后两个名字**从未有过发射点，且它们描述的行为（自动重试的第 N 次、重启的结果）在本包里不存在**（无自动重试；宿主没有重启自己的电话）。这两个事件名已从随包清单 `event-list.update.json` 删除（28 → 26 条）。**原判据「归 #122」是错的**：#122 的客户端白名单恰好 5 个事件，不含这两个名字。

### 3.1 接线状态（#124 落地后：谁在哪个函数里发）

上表的 `文件:行号` 是写目录时的快照，会随实现漂；**认函数名**（下表才是权威落点）。

| 环节 | 事件 | 唯一落点（函数） | 状态 |
| --- | --- | --- | --- |
| ② | `update.check.start` | `src/host.ts` 检查电话包装（调用方报了 `trigger` 才发；面板/入口的「自动」由 #122 在客户端自报） | ✅ 宿主侧可选入参 |
| ③ | `update.check.done` / `update.check.fail` | `src/service.ts` 核心 `check()`（`stage` 四个合法值 `fetch`/`compare`/`channel`/`verify`，取数阶段钉在错误对象上；`httpStatus` 只有真拿到状态码才有）。**可达三值**：`fetch`（`:308`）、`channel`（`:400/:463/:493`）、`verify`（`stageOfError()` 兜底）；`compare` 无生产者。`#211` 起 `check.done` 另带 `blockedReason`/`fallback`/`dataSource`，`check.fail` 另带 `latencyMs`/`source` 且 `errorKind` 改失败类别（见 §8） | ✅ |
| ④ | `update.registry.fetch` | `src/service.ts` 的取数路径（正常取数 + 通道回退，共用 `makeFetchNoter()`）与 `src/changelog-io.ts` 的更新说明 tarball 取数（`#211` 接入：成功 / 失败 / 非 2xx 都发，宿主 `readChangelog` 注入 `emitLog`；`/http` 变体走 #122，Node 侧不重复发） | ✅（`cacheHit` 已从清单删除，见下） |
| ⑤ | `update.channel.decide` | `src/service.ts` 核心 `noteChannelDecision()`（一次成功检查一条；`reason` 四值 `stable`/`prerelease`/`mismatch`/`invalid`） | ✅ |
| ⑥ | `update.changelog.parse` | `src/host.ts` 变更日志电话包装（**`source` 恒 `'npm'`**，`src/host.ts:1071` 写死；`entries`/`truncated`/`degraded` 来自 `parseChangelogReport()`） | ✅ |
| ⑦ | `update.install.request` | `src/service.ts` 核心 `install()`（过闸门之后、开工之前一条） | ✅ |
| ⑧ | `update.install.exec` | 既有 `src/store.ts` 执行器的 `emitInstall()`（形状不动） | 已存在 |
| ⑨ | `update.install.verify` | `src/service.ts` 核心 `runBackground()` 的终态跃迁 + `healedJob()` 的掉线换算（只在真跃迁时发） | ✅ |
| ⑩ | `update.panel.action{action:'install'}` | 客户端按钮动作 → #122 的 `logAppend` 通道落盘（重试按钮就是再发一次安装；**本包没有自动重试**，所以没有「第 N 次」） | 归 #122（宿主不重复发） |
| ⑪ | `update.batch.entry.request` | `src/host-batch.ts` `noteEntryRequest()`（会话建起/复用时一条，按会话编号去重；`#208` 带 `sessionHash` = 批次编号 hash8，落属主目录、无属主不发） | ✅ |
| ⑫ | `update.queue.transition` / `update.lock.anomaly` | `src/store.ts` `writeQueue()`、`tryAcquireLock()`、`tryAcquireGlobalLock()`、`releaseLock()`、`releaseGlobalLock()`（只在乎「真写盘且相位真变」「真删掉旧锁且真抢到手」） | ✅ |
| ⑬ | `update.batch.entry.fail` | `src/batch-run.ts` `noteEntryFail()`（中立文件，落点由 `BatchRunDeps.logFor` 注入；`#208` 带 `sessionHash`，`stage` 由 check、install 两条路径与 `settleInstall()` 给出（四值），`index` 由宿主注入的 `indexOf` 取**整批**序号；落失败那家自己的目录） | ✅ |
| ⑭ | `update.batch.summary` | `src/host-batch.ts` `noteBatchSummary()`（**收尾边沿**：每次从「没收尾」变成「收尾」记一条；用户重试装成后再收尾会再记一条。面板只渲染；`#208` 带 `sessionHash` 与 `stoppedBecause` = `lastRun?.stoppedBecause ?? 'finished'`，落属主目录、无属主不发） | ✅ |
| ⑮ | `update.panel.action{action:'restart-hint'}` | 客户端 → #122 的 `logAppend` 通道落盘（**宿主没有重启自己的电话**，本包只做入口，观测不到重启结果） | 归 #122 |
| ⑯⑰⑲① | `update.lang.applied` / `update.panel.state` / `update.panel.action` / `update.panel.mount` | 客户端 → #122 的 `logAppend` 通道落盘 | 归 #122 |
| ⑱ | `update.store.fail` | `src/store.ts` `createStoreLog().fail()` 的 **16 个落点**（`:303`–`:641`，原 `catch {}` 或「换成归类码」的位置） | ✅ |

**三条落地口径（备案）**

1. **轮询的第一次观测不算事件**：`updateStatus` 的成功行在发射侧一律不发（`src/host.ts` 的电话包装）。判据是「上次算得出指纹、这次算得出、且与上次不同」才留一行；第一次没有可比的上次，所以也不留——这就是 §6「N ≥ 100 次零常驻行」的字面口径（实测 600 次 → 0 行）。指纹算不出来时宁多发一行，不吞变化；失败行 `host.call.fail` 不受影响；名字与五键形状一字不动。
2. `update.registry.fetch.cacheHit` **不存在**：本包的缓存命中发生在取数之前（命中就根本不取数），到了取数点就一定是未命中——恒为 `false` 的格子只是噪声。**2026-10-15 契约回填：已从随包清单 `event-list.update.json` 删除该字段名**（清单是发布的契约，声明一个永不出现的格子会把第三方聚合器带偏）。
3. **只进日志的可选入参**（不改老调用形状、不参与任何决策）：检查电话多认 `trigger`（没自报就不发 `update.check.start`）、安装电话多认 `from`（没自报按 `'panel'`，批量宿主传 `'batch'`）。
4. **缝都在宿主侧接**：中立文件（`service.ts`/`changelog.ts`/`queue.ts`/`batch-run.ts`）不 import node、也不认识插件标识，发射口一律由宿主侧**绑好标识**后注入（`src/host.ts` 的 `logPortFor()`；队列与全局锁按当次动作方取口，行落动作方自己的目录）。批量侧同形：`#208` 修掉 `createUpdateQueuePorts(..., { logFor })` 的漏传，批量队列行同样落动作方目录；批量面板的客户端行走 `<批量前缀>.logAppend`，由批量宿主转发给属主的 `logAppend`（属主存在且接了日志才登记，见 §9.3）。

**实测证据（2026-10-14）**

- 预算装置 `node .tmp/log-verify/run.mjs budget`：**8/8 过**——内核边沿 86400 次 → 1 行；600 次轮询 → **0 行**；稳态 24h 外推 0 行；安装/批量当天事件面 37 行（≤ 500）；按需档开关关着 0 行。
- 缝探针（真 homeDir／真锁／真队列，只假网络与子进程）跑一次完整安装：`update.queue.transition` 三行齐（`queued{position:1}` → `running{waitedMs:8}` → `done`），`update.install.request`、`update.install.verify`、`update.check.done`、`update.channel.decide`、`update.status.changed` 各就其位。
- 逐事件的负向断言：`tests/host-log.test.mjs`、`tests/store-log.test.mjs`、`tests/batch-log.test.mjs`。

## 4. 跨环节的三条全局规则

1. **轮询抑制（噪声的根）**：`updateStatus` 是每 1000ms 一次的既有轮询（`src/panel.ts:2026-2030`）。规则是**边沿触发**——状态与上次相同就一条不发；状态变了发一条 `update.status.changed`；开关打开时另发 `update.poll` 全量。既有 `host.call` 的抑制同理：成功且状态未变时**不发**，**第一次轮询没有可比的上次、同样不发**（所以「N ≥ 100 次连续轮询零常驻行」是字面成立的；名字与字段不变，只改发不发）。
   - 依据：`host.call` 在 dsh-log 内置常驻名单里（43 名之一），集成方清单**改不动**它，因此只能在发射侧治；现场 934 KB/天 的日志里 5309 行是它。
2. **关联**：dsh-log 的**客户端 SDK 写入路径**会自动注入 `traceId`（一次用户意图，如「点了安装」）与 `spanId`（一次尝试，如第 2 次重试），住 `fields` 里（`traceChain` 靠它串链）。**本包自建落点走的是宿主的 `store.log`，不注入这三件套**（实测：真 `createNodeHostLog` + `store.log('error', …)` 落盘行只有调用方给的 `fields`，无 `traceId`/`spanId`/`seq`），所以「每条行都带 `traceId`、形状由本包铸造、由测试锁死」这句话**当前不成立**——只在集成方把 dsh-log 客户端实例当 `logCtx` 传进来时才有。自建路径上的关联暂时靠时间窗 + 事件名 + 稳定码；「本包自己铸链」列为未做（复核报告 §12.3 第 11 条），不许在对外文案里当既有能力写。
3. **脱敏**：按 ADR-0006——行的字段只有「版本号 / 枚举白名单值 / 导出量（hash8、计数、时长、字节、布尔）」三类；路径、URL、令牌、邮箱、宿主原话、命令**根本不出现在日志行里**。落点是发射口 `emitRow()` 的白名单校验 + 每个事件的负向断言用例。

## 5. 客户端侧 11 个落点（`src/` 里打不了日志的地方，逐条点名）

依据 `docs/research/20261014-update-logging-inventory.md` §1.3 的判据（`import 'node:'` 命中即 Node 专属；其余 22 个 `.ts` 可进浏览器闭包）。

| 客户端落点（文件:行号） | 环节 | 走哪条路 |
| --- | --- | --- |
| `src/panel.ts:1999` `mountUpdatePanel` | ① | #122：`update.panel.mount` + 校验失败 `update.panel.render.fail` |
| `src/panel.ts:1981` `pendingAutoCheck` | ② | #122：并入 `update.check.start.trigger='auto'` |
| `src/panel.ts` `case 'restart-hint'` | ⑮ | #122：`update.panel.action{action:'restart-hint'}`。**没有 `update.restart.outcome` 这个事件**：宿主没有重启自己的电话，本包只做入口、观测不到重启结局，「三种结局各一值」不存在 |
| `src/panel.ts:450` `buildDiagnosticText`、`:592` `buildUpdateDiagCopy` | ⑲ | #122：`update.panel.action{action:'copy-diag', bytes, truncated}`；**内容不进日志**（取值是 `'copy-diag'`，不是 `'copy-diagnostics'`） |
| `src/panel.ts:1533` `renderUpdatePanelKernel`、`:1847` `renderUpdatePanelHTML` | ⑰ | #122：`update.panel.state`（主题枚举 + token 数） |
| `src/entry.ts:351` `mountUpdateEntry` | ① | #122：`update.panel.mount{mode:'entry'}`（`src/entry.ts:590` 传 `clientLog:{mount:'entry'}`） |
| `src/entry-batch.ts:308` `mountUpdateBatchEntry` | ① | #122 + **#208**：传 `clientLog:{mount:'batch'}`，行报 `mode:'batch'`（不再是面板 `mode`），挂载 / 动作 / 渲染失败 / 全局兜底四类行经批量宿主的 `<批量前缀>.logAppend` 转发落属主目录 |
| `src/panel-batch.ts:1553` `mountUpdateBatchPanel` | ①⑪ | #122 + **#208**：批量面板自建通道打 `<批量前缀>.logAppend`（宿主转发给属主 `logAppend`），挂载行报 `mode:'batch'`；22 种批量动作行走 `update.panel.action`（`ok` / `errorKind` / `durationMs` 同单面板口径），渲染失败走 `update.panel.render.fail`；入队事实仍由 #124 在宿主侧发 `update.batch.entry.request` |
| `src/panel-batch.ts:242/283` `batchLedgerCounts`/`batchLedgerText` | ⑭ | 客户端**不发**：账本由宿主侧汇总成 `update.batch.summary`（#124）；面板只渲染，避免同一事实两处发 |
| `src/lang.ts:80` `resolveLang` | ⑯ | #122：`update.lang.applied` |
| `src/http.ts:230` `createHttpCall` | ④ | HTTP 变体在客户端闭包里跑：经 #122 的通道发 `update.registry.fetch`；Node 侧同一发射口（#124）不发第二条 |

**为什么必须有自己的通道**：面板侧没有 `ctx`、没有文件系统，dsh-log 的 `./client` 入口也不落盘（它只做内存队列 + 经宿主转发）。所以 #122 新增本包自己的 `<prefix>.logAppend` 电话（批量行、永不抛、回执 `{accepted, dropped}`），宿主半区接到**同一个** log handle——单写者不变。批量面板同一条通道（`#208`）：电话名是 `<批量前缀>.logAppend`，宿主只在属主存在且属主接了 `logAppend` 时登记转发；没登记时面板行投递失败、客户端只累加 `send-failed` 计数（不猜落点）。宿主 `logAppend` 整批拒收时，属主侧另留一条 `update.log.degraded{reason:'client-batch-refused'}`（按实例只记一次）。

## 6. 预算与验收口径

- **稳态**（无操作日）：常驻行 ≤ **50 行/天/插件**。
- **操作日**（一次安装或一次批量）：≤ **500 行/天/插件**。
- 轮询抑制生效的判据：连续 N 次 `updateStatus`（N ≥ 100）**零常驻行**（实测见 §3.1「实测证据」）。
- 每个事件至少一条负向断言用例（ADR-0006 §4）；字段名集合与 `event-list.update.json`（#120 产出）必须完全一致。
- 真机对账口径（#125）：两个假插件 `verify-a` / `verify-b` 各自目录行数 = 各自的发射数，互无 `foreign-write` 诊断。

## 7. 契约回填（2026-10-15）：本文件曾许过、实现没给的四处

本文件是**意图稿**（写于实现之前），随包清单 `event-list.update.json` 是**发布的契约**。定稿后逐条对账，四处对不上，已按实现改正本文件与清单：

| # | 本文件曾写 | 实现实际 | 处理 |
| --- | --- | --- | --- |
| 1 | `update.install.retry`（⑩，`attempt`/`of`） | **无此事件、无此行为**：本包没有自动重试，重试按钮就是再发一次安装 → `update.panel.action{action:'install'}` | 事件名从清单**删除**（28 → 26），本文件 ⑩ 行改判 |
| 2 | `update.restart.outcome`（⑮，三结局） | **无此事件、无此行为**：宿主没有重启自己的电话 → `update.panel.action{action:'restart-hint'}` | 事件名从清单**删除**（28 → 26），本文件 ⑮ 行改判 |
| 3 | `update.registry.fetch.cacheHit: boolean` | 字段**从未出现过**（命中就不取数，到取数点必未命中） | 字段名从清单**删除**，§4 第 2 条改述 |
| 4 | `update.panel.mount.mode: 'embedded'\|'dialog'\|'entry'\|'entry-batch'\|'batch'` | 可达**四值**：`'entry'`、`'http'`、`'embedded'`、`'dialog'`。批量两处挂载点不传 `clientLog`，报的是面板 `mode` | 本文件 §1 与 §5 改正；**清单字段名不变**（`mode` 仍是自由字符串，不锁枚举） |

**同批改正（本文件写错、清单本来就对）**：`update.panel.action.action` 是 **11 值**（原文只列 6 个，`copy-diagnostics` 实为 `copy-diag`）；`update.changelog.parse.source` **恒 `'npm'`**（原文写 `'tarball'`）；`update.check.fail.stage` 四值合法但**可达三值**（`compare` 无生产者）；`update.lang.applied.source` 是**四值**（补 `'default'`）；`update.store.fail` 落点 **16 处**（原文写 13）。

### 7.1 三条已知边界（**记录，不修**）

1. **丢弃计数不接**：dsh-log 的 `getDroppedCount()` / `setOnDrop()` 是 `createLogStore` 的返回方法（`dist/store.d.ts:31/39`），本包自建落点走 `src/log/sink.ts` 的 `sinkFromStore()` 包装、**没有接这两个口**。因此「有多少行被准入拦掉」今天在磁盘上看不见——`emitRow()` 的未登记字段计数走 `update.log.degraded`，但引擎级的 skip 与 drop 不计数。
2. **trace 只有一半**：`buildRowText(level, event, fields)`（`dist/core/row.js:16`）的签名里**没有 trace 槽位**；`store.log(level, event, fields)`（`dist/store.d.ts:23`）是**三参**入口。`traceId`/`spanId` 只由 dsh-log 的**客户端 SDK 写入路径**注入（`dist/client/write.js:110-123` 的 `ensureTraceForLevel`/`ensureSpanId`）。⇒ 本包自建落点的行**永远不带三件套**，`--trace` 在本包自己的行上追不到链。要接得上，只能走集成方传进来的客户端实例（客人模式），或等上游给宿主侧入口。
3. **上游那条路牌是错的**：dsh-log 的 `USAGE` 写 `dsh-log tail <目录...>`，但 `dist/cli.js:31` **没有子命令解析**（`const paths = options.paths.length > 0 ? options.paths : ['.']`）——`tail` 被当成一个不存在的路径，先往 stderr 打 `dsh-log: 没找到日志目录：tail`（**退出码仍为 0，日志照常输出**）。干净形式是 `dsh-log <目录>`。本包已把面板路牌与 README 全部改成无 `tail` 形式（2026-10-15）；上游的 `USAGE` 与解析器不一致**留作上游事项**。
4. **上游导出落地后，路牌怎么指**（一句话备案，不单列工作项）：今天面板错误章的路牌只给**目录** + `dsh-log <目录>`；若上游将来把「打包导出」做成读侧能调的东西（见设计说明 §11.5 ②），路牌应改成指向**那个产物**（一个文件），而不是再加一条命令 —— 判据是「用户拿到手就能贴进 issue」。在那之前不加。

### 7.2 明确不做（本轮已判）

- **跨进程租约**：实测两个进程各写 1200 行 × ~3 KB 到同一目录，**2400 条一条不少**；引擎发 `log.persist.fail{reason:'foreign-write'}`（`warn`，恒放行）可事后诊断，重试缓冲不丢行。这是引擎**有意**的设计（「跨进程可观测」），不是缺陷。
- **清单合并上游化**（`mergeUpdateEvents` 交给 dsh-log 做）：本包已有纯函数实现，属策略问题不是能力缺口。
- **开关热更新**：dsh-log 的开关是**实例级闩锁**（`switch-file.js:25-28` `if (switchLoaded) return getSwitchState()`），改 JSON 是重启级旋钮；且上游口径是「对账以宿主为准」。本包 ADR-0005 已把自己定为**只当客人**，不自建开关通道。

## 8. 二次回填（2026-10-19）：`#211` 的五个事件取值

本文件 §1 的五行为准的字段白名单已按随包清单改写：**只扩字段与取值，不改事件名与档位归属**（条目总数与常驻/按需/自监控分布不变）。完整清单逐条现状以 `event-list.update.json` 为准。

### 8.1 `errorKind`：失败类别，不是公开稳定码

`update.check.fail.errorKind` 从「稳定码」改为**失败类别**（十值），判定分两层：`src/registry-fetch.ts` 在抛错处贴内部成因标记，`src/check-conclusion.ts` 的纯函数做映射，认不出写 `unknown`。

| 类别 | 含义 |
| --- | --- |
| `timeout` | 取数超时（宿主侧时限） |
| `network` | 连接失败 / 连接断开（非 DNS、非 TLS） |
| `dns` | 域名解析失败 |
| `tls` | 证书 / TLS 握手失败 |
| `http` | 拿到了非成功状态码（状态码另见 `httpStatus`） |
| `bad-json` | 响应体不是合法 JSON |
| `too-large` | 响应体超过大小上限 |
| `shape` | JSON 合法但形状不对（缺字段 / 类型不对） |
| `channel` | 通道判定不认（预发布 / 通道不匹配等） |
| `unknown` | 认不出来的兜底 |

**它不是公开稳定码**：错误码（`code`）仍是面板回包、诊断文本与对外文案的判据；`errorKind` 只回答「哪一类失败」，不承诺与 `code` 同级的长期稳定性，面板/诊断分支一律继续用 `code`。

### 8.2 其余四个事件的取值口径

- `update.wire.ready`：`logSink` 扩 `'external-unverified'`（外部落点门径非 `open` 时记它，不冒充 `'external'`；门径 = 对方实例 `isEnabled(level, event)` 返回真布尔 `true`，给不出 `isEnabled`、调用抛错或返回 `false` 都算非 open——与 README 第 10 节的两条自检同口径）。`closed` 时这一行会被对方准入跳过，现场只能靠回包 `logHealth.external` 分辨「明确没放行」；本包接线时**不代查** merge 事件清单。新增 `updaterVersion`（`ownPackageVersion()`，读不到显式 null）、`copyLevel`（`selfCopyLevelOf(packageRoot())`，四值）、`hostKind`（与读取器同一取法：`profileDir` 最后一段归一出使用范围名 → `detectEnvironmentKind()`，三值）。`self` / `off` 两支同样带这三格；每次接线仍只有一条。
- `update.check.done`：新增 `blockedReason`（`'none'` 或阻挡码）、`fallback: boolean`、`dataSource`（`'npm-version'` / `'npm-channel'`）；`current` 维持「运行版本未知则省略」口径（不写 null）；`source` 非默认 registry 且主机名不可写时落 `'custom'`（`check.fail.source` 同口径）。
- `update.status.changed`：八格真值元组即边沿键；版本三格未知显式 null；`blockedReason` 缺省 `'none'`、`identity` 缺省 `'unknown'`；`kind:'unknown'` 必带 `unknownCause`（三值），kind 已知时省略 `unknownCause`。
- `update.panel.mount`：新增 `autoCheck`（`'started'` / `'recent'` / `'disabled'` / `'failed'`）；面板行挪到首次刷新完成/失败之后发，保证「这面面板到底跑没跑自动检查」是事实而不是预告。安装按钮侧同口径：`autoCheck: 'mount'` 时挂载行也等首刷（含首刷触发的自动查）落定后按事实记四态，`autoCheck: 'never'` 记 `'disabled'` 且不刷新、零请求。
- `update.registry.fetch`（按需）：`#211` 起两个原先没留行的取数场景接上发射口——通道回退取数与更新说明 tarball 取数（`src/changelog-io.ts`），两处都只记 `httpStatus` / `latencyMs` / 白名单 `registryHost`，失败也发。它是**按需**事件：默认开关关着时不落盘；常驻的 `check.done.fallback` / `dataSource` 仍能回答「这次走没走回退」（版本回退的取数证据在默认现场不消失）。

## 9. 三次回填（2026-10-19）：`#208` 的批量现场证据

本次**不新增事件、不改档位归属**：条目总数仍 27（常驻 20 / 按需 6 / 自监控 1），字段白名单合计 **+6**（`update.batch.entry.request` +1、`update.batch.entry.fail` +3、`update.batch.summary` +2）。§1 三行、§3 / §3.1 接线列与 §5 客户端落点已同步回填；完整清单以 `event-list.update.json` 为准。

### 9.1 三条批量常驻行的落点与无属主边界

批量行由宿主侧绑好标识后发射，落点判据与全局同一条：**不知道去哪就不猜**（`src/host-batch.ts` 文件头注释：没属主、键不在清单里、没有日志接线，一行不发）。

| 事件 | 落点 | 没指定 `selfKey`（无属主） |
| --- | --- | --- |
| `update.batch.entry.request` | 属主（`selfKey` 那家）插件目录 | **一行不发**（没有已知落点） |
| `update.batch.entry.fail` | **失败那家自己的**插件目录（`logPortFor()` 按目标键取口，与属主无关） | **照落**失败那家目录 |
| `update.batch.summary` | 属主插件目录 | **一行不发** |

- 三条行都带 `sessionHash` = `hash8(批次编号)`：同一批的行可能分散在属主与各失败目标目录里，聚合认这一格，不认目录（`noteEntryRequest()` / `noteEntryFail()` / `noteBatchSummary()` 同一取法）。
- `stoppedBecause` 收尾边沿落行时取 `lastRun?.stoppedBecause ?? 'finished'`；`finished` 是「全部跑完」，`failed` 仍可能非零。`#209` 起未跑完就停下另记一条异常停止行（见 §10.4），§9 的收尾口径不变。
- `entry.fail` 的 `stage` 由 check、install 两条路径与 `settleInstall()` 给出（`check` / `install` / `timeout` / `settle`），`index` 由宿主注入的 `indexOf` 取**整批**序号（`full.order.indexOf(key)`，不是视图序号），`exitCode` 只在真拿到时出现。

### 9.2 `host.call.fail` 的批量语义（字段不变，只改发不发）

七个批量电话失败复用既有 `host.call.fail`（**不新增事件**；五格字段形状冻结，见 §0）。`notePhoneFail()` 在批量宿主里包住七个电话：

| `method`（全名 = `<批量前缀>` + 后缀） | `kind` | 落点 |
| --- | --- | --- |
| `.batchStatus` | `batch-status` | 属主目录 |
| `.batchCheck` | `batch-check` | 属主目录 |
| `.batchInstall` | `batch-install` | 属主目录 |
| `.batchResume` | `batch-resume` | 属主目录 |
| `.batchCancel` | `batch-cancel` | 属主目录 |
| `.batchPrefs` | `batch-prefs` | 属主目录 |
| `.batchPrefsSave` | `batch-prefs-save` | 属主目录 |

- `error` 只认稳定码（`src/codes.ts` 的 `BATCH_REPLY_CODES` 白名单），认不出折 `unknown`；`errorHash` = `hash8(method + '|' + error)`；`pluginId` 是属主标识。
- **去重**：同一 `method` 连续同码只记首次，成功即清记忆（`batchStatus` 每 1.5 秒轮询一次，失败不能灌爆目录）；单插件电话口径不变（一次失败电话一条）。
- **无属主一行不发**（没有落点）。

### 9.3 批量面板的客户端行（`#208` 接上）

- 批量面板与批量入口件都传 `clientLog`，报 `update.panel.mount{mode:'batch'}`；动作行走 `update.panel.action`，`action` 取 `src/panel-batch.ts:166-188` 的 22 个批量动作（见 §1 `update.panel.action` 行）；渲染失败行走 `update.panel.render.fail`（`phase: mount|paint|poll|global`），全局 `onerror` / `unhandledrejection` 兜底与单面板同口径。
- 通道名是 `<批量前缀>.logAppend`：批量宿主**只在属主存在且属主那家接了 `logAppend` 时才登记转发**（`handlers[batchLogAppendName]`，放在逐目标并入之后）。没登记时面板行投递失败，客户端侧只累加 `send-failed` 计数（客户端队列的内存读数，不落行），**宿主侧不产生任何行**。
- 宿主 `logAppend` 整批拒收时，属主侧另留一条 `update.log.degraded{reason:'client-batch-refused'}`（按实例只记一次）。
- 客户端白名单仍是 6 个事件，批量面板不新增可上报事件。

### 9.4 队列行归属（`#208` 修复）

批量宿主创建共享队列端口时漏传 `logFor`，批量路径上的 `update.queue.transition` / `update.store.fail` 落不到正确目录。现与单插件同形注入按动作方取口的 `logFor`（`createUpdateQueuePorts(..., { logFor })`），队列行落**当次动作方**（被装 / 抢锁那家）自己的目录。

## 10. 四次回填（2026-10-19）：`#209` 的队列 / 锁 / 存储颗粒度与常驻 warn 限速

本次**不新增事件、不改档位归属**：条目总数仍 27（常驻 20 / 按需 6 / 自监控 1），字段**实发** +3（白名单净新增 1 格 `update.queue.transition.holderHash`；`update.lock.anomaly` 的 `ownerHash` 与 `update.store.fail` 的 `dirHash` 原已声明，本次由「声明未发」转实发）；枚举扩三处（新增 `update.queue.transition.phase` 与 `update.lock.anomaly.kind` 两个 `fieldEnums`，`update.batch.summary.stoppedBecause` 五值 → 七值，三者都补了负断言用例），`host.call.fail` 只扩 guard（轮询失败限速）、字段与形状不动。
### 10.1 队列跃迁：清理/放弃相位与持有者指纹

- 相位判据在发射侧 `src/store.ts` 的 `queueEdgesOf(previous, next, { now, ttlMs })`：写盘前读到的旧队列与写盘后的新队列逐项比对，**一份状态可以产出多条边**（多条待办同时被摘时逐条发）。
- `done` / `running`：owner 被摘 / 新建或换家（真跃迁），`holderHash` 是该行描述的持有者 `hash8(pluginId)`；`running` 另带 `waitedMs`（从 waiting 占位算起）。
- `queued`：owner 没换、新出现 waiting 意向 → `position` = 该意向在新队列 `waiting` 里的 1 基位置。
- `pruned` / `abandoned`：旧 waiting 里被摘掉、又不是「刚被提升为 owner」的那一格（`#209` 起不再静默）→ 按意向年龄判：`age = now - enqueuedAt` 有限且 `age >= ttlMs` 记 **`pruned`**（过期清理），否则记 **`abandoned`**（取消 / 主动放弃）；行落**被摘那家**自己的目录（动作方），`holderHash` 是摘的那一刻队列持有者（队列空则省略）。逐条待办的边沿带自己的主体验证盐（`intentKey`），所以一次写盘摘掉两条不会互相吃掉。
- `ttlMs` 与 `now` 由调用方注入，默认 `QUEUE_INTENT_TTL_MS` / `Date.now()`；`src/host.ts` 的队列端口接 `{ ttlMs: queueTtlMs, nowImpl: queueNow }`——与 `loadQueuePruned()` 同一读数，prune 与相位判定不会各看各的钟；批量宿主共享队列端口接 `nowImpl: () => now()`，并在宿主覆盖了 `queueTtlMs` 时一并接 `ttlMs`。
- 写盘失败时 `update.store.fail{op:'write-queue'}` 的路由用第一条边的动作方；写盘成功才逐条发 transition。发射侧按「动作方 + 相位 + 逐条待办主体」指纹去重，所以同一份状态重复写不会重发同一相位、同相位下不同待办各留一条。

### 10.2 锁异常：持有者指纹与 `busy-owner`

- 抢锁有两条失败路：①**新鲜持有者占着**（`age === undefined || age <= staleMs`）→ `busy-owner`，`ageMs` 是持有者已持有时间（量不出时省略）、`ownerHash` 是持有者指纹；②读锁 / 回收抛错 → `store.fail{op:'acquire-lock'|'reclaim-stale-owner'}`。回收成功 → `stale-owner`（带被回收者 `ownerHash`），全局锁再补一条 `queue.transition{phase:'reclaimed'}`；放锁 unlink 失败 → `release-failed` + `store.fail{op:'release-lock'}`。
- `acquire-failed` / `busy-wait` **不做**：读锁 / 抢锁异常已经有 `store.fail{op:'acquire-lock'}`（带稳定 reason 与 dirHash），再补一条 lock.anomaly 只是把同一件事写两遍；本包也没有「等待重试到超时」的路径（见 §3.1）。`#209` 的「扩类别」落实为新增 `busy-owner`——它回答的是「谁在占着、多久」。`ownerHash` 与 `queue.transition.holderHash` 同名不同源是**刻意分开**的：前者是锁内容指纹（`hash8(pluginId|id|pid|startedAt)`），后者是队列持有者插件标识指纹（`hash8(pluginId)`），两个事件各用各的名，聚合器不会把两种口径混在一起比。
- `ownerHash` 取法 `lockOwnerHash()`：锁内容里 `pluginId` / `id` / `pid` / `startedAt` 有哪格拼哪格（`key:value` 用 `|` 连接），非空则 `hash8`；读不出锁内容时这一格省略。
- `busy-owner` 去重是**按持有者**：同一动作方连续被同一个持有者挡住只记首次，持有者换了才再记。
- 锁年龄读数（`#209` 修 `#181` 回归）：全局锁年龄统一走 `queueLockAge(probe, nowMs)`——锁里读得出 `startedAt` 就用调用方传入的逻辑钟算（测试可注入假钟）；读不出（空锁 / 坏锁）回退文件 `mtime`，而 mtime 是文件系统**墙钟**，回退分支必须 `Date.now() - mtime`，不能用注入的逻辑钟（否则假钟减真 mtime 得负值，陈旧锁被当成新鲜锁拒绝回收，`tests/issue-181-lock-ttl.test.mjs` 锁死这条）。

### 10.3 存储失败行的目录指纹

- `update.store.fail` 的 `dirHash` 由 `shortHash8()`（sha256 hex 前 8 位）算失败所在目录：磁盘端口 = `paths.directory`（`updates/<pluginId>/<profileHash>`）、队列端口 = `queuePathsForUpdate(...)` 的目录（`update-queue/<profileHash>`）。
- 与 `update.wire.ready.logDirHash` 同属 `H_DIR` 口径（8 位十六进制短指纹），三个事件在契约里共用 `H_DIR` 码；行里**绝不出路径原文**。

### 10.4 批量异常停止行与预查失败行

- 停止行复用 `update.batch.summary`（同字段、同落点属主目录、无属主一行不发）：收尾边沿发 `finished`（现行为）；**未跑完就停下**时在停下那一刻另发一条，`stoppedBecause` ∈ `queued` / `stopped-after-failure` / `user-cancel` / `error`：`queued` 是驱动停在队首阻塞（drain 下一轮还会看见同一个，故按「会话 + 原因」去重只记一次）；`stopped-after-failure` 是 `stopOnFailure` 提前收手；`user-cancel` 是 `cancelPhone` 清会话前记；`error` 是 `installPhone` / `resumePhone` / 后台 `drainOnce` 的驱动抛异常（`catch` 里记，异常原文不进日志）。`max-steps`（队列推进的正常节拍）与 `empty`（没目标）**不发**停止行。
- 预查失败也落 `update.batch.entry.fail`：`precheckSelectedToReady` 里 check 结论 `kind:'failed'` 的目标由宿主直接调驱动侧同一个发射口 `noteBatchEntryFailure()`（`src/batch-run.ts` 导出，宿主与驱动同一行形状），`stage:'check'`、`errorKind` 走稳定码白名单；check 过程抛异常（消息可能含路径 / URL）记 `errorKind:'unknown'`，`index` 仍取整批序号。
- 落点：预查失败行落**失败那家自己**的目录（`logPortFor(key)`），停止行落属主目录（§9.1 判据不变）。

### 10.5 常驻 warn 限速：轮询失败心跳

- `host.call.fail` 对**状态轮询失败**（`method` 以 `.updateStatus` 结尾）限速：同一 (pluginId, method) 的持续失败首次立即记一条；之后每 **5 分钟**至多一条心跳；下一次成功清记忆（再失败重新立即记）。只按时间窗限速——窗口内错误码变化不额外落行，下一次心跳行带当时原因（否则错误码轮换就能绕开限速）。600 次轮询失败 ≤ 12 行/小时（实测 600 次 → 2 行）。
- 非轮询电话（check / install / changelog / logAppend…）口径不变：一次失败电话一条，不做时间窗限速（它们的调用频率由用户动作决定）。
- 时钟取 `readerOverrides.now`（可注入），拿不到或坏了回退 `Date.now()`——宁可多发也不吞失败。
- 字段与形状不变（仍是 `method` / `kind` / `error` / `errorHash` / `pluginId` 五格），只改「发不发」；`host.call` 成功行的轮询抑制（`#124`）不受影响，恢复成功本身**不补行**（成功行本来就抑制）。

## 11. 五次回填（2026-10-19）：HEAD 重查基线 + 对抗审查 §8.3 五处修正（`#206` P2-1）

- HEAD 基线：`18df6d7`（`fix(#209)` 审查跟进之后）。事件总数 **27**（常驻 20 / 按需 6 / 自监控 1），与 §10 口径一致；随包清单 `event-list.update.json` 是唯一事实源（`fieldEnums` 14 组）。核对命令：`node -e "Object.keys(require('./event-list.update.json').events).length"` 应得 27；`npm run docs:log:check` 只查不写；批量相关定向测试 `npm run test:batch`。
- 本节是对抗审查（`docs/research/20261018-日志必要性对抗审查.md`）§8.3 五处修正的落字：旧说法逐条作废，以下为 HEAD 真值；正文旧行保留历史痕迹，读数以本节为准。

### 11.1 `update.check.start` 在本包内不可达（§8.3-①）

- HEAD 真值：`update.check.start` 只在调用方自报了触发方时才发——`src/service.ts:639-645`（`triggerOf(trigger)` 非空才 `emit`）；宿主侧 `src/host.ts:1452-1454` 从电话参数读 `args.trigger`（`readCheck`）。
- 包内调用方（单面板 `src/panel.ts:3580` 的 `act('check')`、入口件 `src/entry.ts:567` 的 `checkNow()`、批量 `src/host-batch.ts:535`）**均不传 `trigger`**，所以本包面板/入口件发起的检查不产生这一行；§3.1 的「② 自动检查更新 … 客户端 `update.check.start(trigger:auto)`」与 §1 的「把「用户点了」与「自动触发」分开」两处旧行作废。
- 自动检查的证据看 `update.panel.mount.autoCheck`（四值 `started` / `recent` / `disabled` / `failed`，见 §5 与 `fieldEnums`），不要等 `check.start`。

### 11.2 批量 `mode:'batch'` 已存在（§8.3-②，为 `#208` 已修复项）

- 旧说法（批量面板以 `mode:'batch'` 上报、而代码零发射）是 `#208` 之前的真值，已被 `#208` 修复：批量入口件 `src/entry-batch.ts:552` 传 `clientLog: { mount: 'batch' }`，批量面板 `src/panel-batch.ts:2868` 落挂载行（`mode:'batch'`，电话名是 `<批量前缀>.logAppend`，由批量宿主转发给属主落盘，无属主时一行不发，见 §9.3）。§1 / §5 / §9.3 的 batch 行是现行真值，无需再改。

### 11.3 trace 覆盖修正（§8.3-③）：自建落点跨异步链成立

- §4.2 的「自建路径上关联靠时间窗 … 本包自己铸链列为未做」作废。HEAD 真值：自建落点上电话链跨异步安装链成立——`src/log/trace.ts`（`AsyncLocalStorage` 跟着 `await` 走）+ 自建 sink 铸链；`update.install.request` 与其后 `install.exec` / `install.verify` 同 `traceId`，`npx dsh-log <dir> --trace <traceId>` 可追完整链（`tests/log-trace.test.mjs:245-272` 锁定「await 之后链仍是自己的」；README §11 亦已按此写）。
- 无链的仍是这五处（已知边界，不是断链）：**外部 `logCtx`**（`sinkFromLogCtx` 不暴露 trace）、**客户端行**（`logAppend` 不在链内）、dsh-log < 0.3.3、旧副本（`#196`）、重启补记行。外部落点的跨行聚合靠 `update.install.request.intentHash`（`hash8(requestId)`），见 §8.2-1 的配套修法。

### 11.4 `install.request` 时机（§8.3-④ / §8.2-1）：闸门之后、开工之前，但中间隔着 acquire + 复核

- §3.1 的「过闸门之后、开工之前一条」细化为准确定位。HEAD 真值（`src/service.ts`）：
  - latest 路径：过完所有闸门、真的要装了才发（`:1055-1064`，注释原话「过完所有闸门、真的要装了才落这一条；被闸门挡掉的请求不算一次意图」），但发完与 `runBackground` 之间还隔着建作业 → `acquire` 抢锁 → 装前复核重读（`:1065-1084`）；
  - 候选（合规版）路径：同样闸门后发（`:932-939`），之后隔着 `acquire` + 同一批次复核（`:947-978`）。
- 后果：日志里可能出现「已发 request、随后 `check-expired`/拒绝」的空请求行；聚合靠 `intentHash`（请求行 / 失败行 / 诊断回包同值），不改发射位置。

### 11.5 事件数与枚举漂移（§8.3-⑤ + `install-button` / `panel.action` 值漂移）

- 「26 事件」「28 事件时代旧编号（`retry` / `restart outcome` …）」一律作废：HEAD 27 事件（§11 基线），`update.changelog.parse` 档位升级与 `update.install.fail` 新增之后即 26→27（§8.5），`#209` 起条目总数仍 27。
- `update.panel.render.fail.kind` 多出的四值（`prefix` / `auto-check` / `theme-tokens` / `locale`）已声明：`fieldEnums['update.panel.render.fail'].kind` 14 值（`#214`），见 §1 常驻表。
- `update.panel.action`：§5 的「11 值」滞后，HEAD 代码 `src/panel.ts:211-225`（`UpdatePanelActionKind`，与面板 HTML `data-action` 一一对应）实际 **14 值**：`check` / `install` / `skip` / `reset-skip` / `copy-manual` / `copy-diag` / `toggle-queue` / `toggle-changelog` / `restart-hint` / `close-view` / `dismiss-failure` / `install-fallback` / `install-fallback-confirm` / `wait-latest`。清单 `fieldEnums` 暂未收录该组（客户端动作名，非日志聚合键），按 ADR-0006「改三处」纪律，后续若进清单需同步事件清单与负断言用例。
