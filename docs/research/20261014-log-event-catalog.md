# 日志事件目录：19 环节 → 事件码 / 级别 / 档位 / 字段 / 脱敏

- 日期：2026-10-14（**2026-10-15 契约回填**：本文件的「事件名 / 字段 / 取值」三处与随包清单、实现对齐；见文末 §7。**2026-10-19 二次回填（`#211`）**：五个事件的字段与枚举按随包清单一字回填，错误类别细化见 §8）
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
- 既有三个事件名（`host.call`、`host.call.fail`、`update.install.exec`）**形状冻结**，被 `tests/phones.test.mjs:222/232`、`tests/routes.test.mjs:106` 逐字锁死：本次只改「发不发」，不改字段。

## 1. 常驻（resident）

| 事件码 | 级别 | 字段白名单 | 说明与脱敏 |
| --- | --- | --- | --- |
| `update.wire.ready` | info | `logSink: 'external'\|'external-unverified'\|'self'\|'off'`、`logDirHash`、`updaterVersion`、`copyLevel`、`hostKind` | 接线自陈（外部实例 / 外部未验证 / 自建 / 关）。目录只给 hash8，不给路径。`updaterVersion`：此刻在说话的本包版本（读不到显式 null）；`copyLevel` 四值 `'profile'`（使用范围级）/`'nested'`（消费方嵌套副本）/`'repo'`（开发仓库）/`'unknown'`；`hostKind` 三值 `'desktop'`/`'desktop-manager'`/`'cli'`。外部落点门径非 `open` 时记 `external-unverified`，不冒充 `external`（门径 = 对方实例 `isEnabled(level, event)` 返回真布尔 `true`；给不出 `isEnabled`、调用抛错或返回 `false` 都算非 open）。注意 `false`（closed）时这一行会被对方准入当场跳过（它拒收的正是同一道门），现场可能**看不到任何接线行**——那时以回包 `logHealth.external` 为准。本包接线时只探门径，**不代查**对方有没有把本包事件清单 merge 进去（README 第 10 节第 ② 条自检） |
| `update.check.done` | info | `ok: true`、`current?`、`latest`、`channel`、`source`、`latencyMs`、`blockedReason`、`fallback`、`dataSource` | 版本号经中央校验器规范化；`source` 只给白名单主机名（复用 `resolveRegistryHost`）、**不带路径与账号**；非默认 registry 且主机名不可写时落 `'custom'` 哨兵（只说明「不是默认源」，不泄露地址）。`current` 可选：运行版本未知时省略（不伪造版号，也不写 null）。`blockedReason`：检查完成后仍挡着安装的原因（`'none'` 或 11 个阻挡码之一）；`fallback: boolean`：这次取数是否走了通道回退；`dataSource: 'npm-version'\|'npm-channel'`：版本号来自正常取数还是通道回退（与 `fallback` 同源） |
| `update.check.fail` | warn | `stage: 'fetch'\|'compare'\|'channel'\|'verify'`、`errorKind`、`httpStatus?`、`latencyMs`、`source` | 无自由文本。**`errorKind` 是失败类别**（十值：`timeout`/`network`/`dns`/`tls`/`http`/`bad-json`/`too-large`/`shape`/`channel`/`unknown`），**不是公开稳定码**——面板与诊断仍用 `code`，判定源见 §8.1。`latencyMs`：从发起取数到失败；`source`：出问题的 registry 主机名（白名单口径同 done 行；非默认源不可写时落 `'custom'`，拿不到时省略）。`stage` 四个值都是**合法值**，但**实际可达三个**：`fetch`（取数失败，`src/service.ts:308`）、`channel`（通道判定不认，`:400/:463/:493` 的 `withStage(..., 'channel')`）、`verify`（`stageOfError()` 的兜底：非 `check-failed` 又没贴阶段）。`compare` 在白名单里但**没有生产者** |
| `update.status.changed` | info | `kind: 'update-available'\|'up-to-date'\|'unknown'`、`latest`、`runningVersion`、`installedVersion`、`registered`、`identity: 'update'\|'first-install'\|'up-to-date'\|'unknown'`、`blockedReason`、`unknownCause?` | 轮询的**边沿**：状态没变就不发（见 §4）；边沿键是整条真值元组（本行八格）的指纹，**任一分量变化发一条**。版本三格（`latest`/`runningVersion`/`installedVersion`）未知时**显式写 null**，不省成假值、不伪装版本号；`registered` 是在册事实（`boolean`，读不到显式 null）；`blockedReason` 固定给值（没挡写 `'none'`）；`identity` 固定给值（判定不了写 `'unknown'`）；`kind: 'unknown'` 时**必须**带 `unknownCause`（`'no-latest'` 没拿到最新版 / `'running-version-unknown'` 运行版未知 / `'compare-failed'` 比较失败），kind 已知时省略 `unknownCause` |
| `update.install.request` | info | `from: 'panel'\|'entry'\|'batch'`、`current?`、`latest`、`checkAgeMs` | 不含凭证；`checkId`/`requestId` 不进日志（关联靠 `traceId`）。`current` 可选：运行版本未知时省略（不伪造版号） |
| `update.install.verify` | info | `result: 'completed'\|'restart-required'\|'failed'\|'interrupted'`、`installedVersion`、`pendingRestart: boolean` | 枚举 + 版本号 |
| `update.batch.entry.request` | info | `total`、`ownCount`、`foreignCount` | 只给数量，不给插件标识清单 |
| `update.batch.entry.fail` | warn | `targetHash`、`errorKind`、`exitCode?` | 目标标识一律 hash8（绝不给包名/路径原文） |
| `update.batch.summary` | info | `total`、`ok`、`failed`、`skipped`、`durationMs` | 总账的机器可读版；面板渲染文本不进日志 |
| `update.queue.transition` | info | `phase: 'queued'\|'running'\|'done'\|'reclaimed'`、`waitedMs?`、`position?` | 相位边沿，禁止每次轮询都发。相位是**队列自己的**三相位（取号 / 安装中 / 摘牌）加全局锁陈旧回收成功这一个真跃迁；`checking`/`installing`/`settling`/`idle` 是面板任务词，队列里没有这些相位（#124 落地时按实现收紧，见 §3.1） |
| `update.lock.anomaly` | warn | `kind: 'stale-owner'\|'release-failed'`、`ageMs?` | 拥有者标识只记 hash8，不记原文。`busy-timeout` **不做**：本包两条抢锁路径都是「看一眼，不陈旧就当场认输」（`tryAcquireLock` 不等待；`tryAcquireGlobalLock` 的 `timeoutMs` 是**陈旧阈值**不是等待超时），没有「等到超时」这条路径，不为了凑齐词汇造一条（见 §3.1） |
| `update.store.fail` | warn | `op: 'read-job'\|'write-job'\|'acquire-lock'\|'reclaim-stale-owner'\|'release-lock'\|'read-snapshot'\|'write-backup'\|'write-queue'\|'read-global-lock'\|'acquire-global-lock'\|'release-global-lock'`、`reason` | 现在 `catch {}` 静默吞的点。`op` 是**真正失败的那个动作**（比「state-read/state-write」粗归类更能定位）；`reason` 是 `error.code` 过白名单后的小写稳定码（`enoent`/`eacces`/`eexist`/… 共 25 个），拿不到码退 `'throw'`、连错误对象都不是退 `'unknown'`，绝不放 `message`/路径。同一操作**同一原因**连续失败只记首次（原因变了再记一条，成功即清）。`dirHash`/`ownerHash` 是清单里的可选格、**当前不发**：日志本来就按插件分目录（目录即定位），hash8 反向不可用，发了只是噪声 |
| `update.panel.mount` | info | `mode`、`theme`、`lang`、`pollMs`、`autoCheck` | 全是枚举与数字。`mode` 的**可达四值**：`'entry'`（`src/entry.ts:590` 的 `clientLog:{mount:'entry'}`）、`'http'`（`src/http.ts:353` 的默认挂载点名）、以及没给挂载点名时退回的面板 `mode` 选项 `'embedded'\|'dialog'`（`src/panel.ts:41` `UpdatePanelMode`）。**`'batch'` / `'entry-batch'` 不可达**：批量两处挂载点都不传 `clientLog`，报的是面板 `mode`（批量面板传 `'dialog'`）。`autoCheck` 记这面面板/按钮会话挂载后**自动检查有没有跑**：`'started'`（自动查已发起）/ `'recent'`（首刷快照显示 job 在 installing/verifying 或已有动作在飞，再查只会得到同一结论，跳过）/ `'disabled'`（调用方显式关掉自动检查）/ `'failed'`（首刷失败、没拿到状态，自动检查没跑成）；面板行在首次刷新完成或失败之后才发，保证记的是事实而不是预告；安装按钮同口径——`autoCheck:'mount'` 时挂载行等首刷（含首刷触发的自动查）落定后按事实写 `'started'` / `'recent'` / `'failed'`（语义同面板行），`autoCheck:'never'` 时写 `'disabled'` 且不刷新、零请求 |
| `update.panel.action` | info | `action`、`bytes?`、`truncated?`、`ok`、`errorKind?`、`durationMs`、`errorHash?` | `action` 取值**十一**个，与 `src/panel.ts:199-210` 的 `UpdatePanelActionKind` 一字不差：`'check'`、`'install'`、`'skip'`、`'reset-skip'`、`'copy-manual'`、`'copy-diag'`、`'toggle-queue'`、`'toggle-changelog'`、`'restart-hint'`、`'close-view'`、`'dismiss-failure'`。复制诊断只记体量与是否截断，**绝不记内容**（`bytes`/`truncated` 只跟着 `'copy-diag'` 走）。`ok`：这次点击的结局（成功 `true`；失败 `false`）；`errorKind`：失败类别——锁存稳定码、动作直接抛错记 `'thrown'`、已有动作在途被拒记 `'busy'`，成功时省略；`durationMs`：从点击到动作落定（含提前 return 的分支）；`errorHash`：失败原文的 8 位指纹，**不落原话** |
| `update.panel.render.fail` | error | `kind: 'container'\|'plugin-id'\|'call'\|'prefix'\|'poll-ms'\|'mode'\|'auto-check'\|'theme'\|'theme-tokens'\|'locale'\|'render'\|'transport'\|'uncaught'\|'unhandled'`、`phase: 'mount'\|'paint'\|'poll'\|'global'`、`errorHash` | 挂载校验、绘制、轮询与全局兜底的四相位失败；无自由文本，`errorHash` 是原话的 8 位指纹（不落原文）。同一 `phase\|kind\|errorHash` 60 秒内至多一行 |
| `update.log.degraded` | warn | `reason: 'no-dsh-log'\|'lease-conflict'\|'write-fail'\|'emit-threw'\|'unknown-event'\|'unknown-field'\|'invalid-enum'\|'client-batch-refused'\|'client-drop-overflow'\|'client-drop-host-refused'\|'client-drop-send-failed'\|'client-drop-disposed'`、`event?`、`field?` | selfmon：日志接线自己的坏消息。`#210` 起字段级漂移不再整行丢：摘掉该字段、整行照落，并记一条带 `event`/`field` 的降级行（两格只放清单内机器标识，非法形状打成 `<event>`/`<field>`，按「原因+事件+字段」只记首次）；未知事件仍整行不落盘。`#214` 起再加客户端丢弃与宿主拒收五类（`client-*`：每因终身至多一条；`client-drop-no-channel` 物理上无投递面，只进内部分计数、不上浮）。清单顶层 `fieldEnums` 是枚举值的机器声明 |

## 2. 按需（ondemand，开关打开才落）

| 事件码 | 级别 | 字段白名单 | 说明与脱敏 |
| --- | --- | --- | --- |
| `update.check.start` | info | `trigger: 'auto'\|'user'\|'batch'\|'entry'`、`source` | ② 的关键：把「用户点了」与「自动触发」分开 |
| `update.registry.fetch` | info | `httpStatus`、`latencyMs`、`registryHost` | 只记白名单主机名与状态码，**不记完整 URL**（ADR-0001 规则 3）。**`cacheHit` 不是字段**：本包的缓存命中发生在取数之前（命中就根本不取数），到了取数点就一定是未命中——恒为 `false` 的格子只是噪声，已从随包清单删除（见 §4 第 2 条） |
| `update.channel.decide` | info | `channel`、`reason: 'stable'\|'prerelease'\|'mismatch'\|'invalid'`、`from`、`to` | 版本号规范化后入行 |
| `update.changelog.parse` | info | `entries: number`、`truncated: boolean`、`degraded: boolean`、`source` | 解析失败只记 `degraded` + 稳定码；原文留给人话出口。**`source` 恒为 `'npm'`**（`src/host.ts:1071` 写死）：本包只从 npm 取变更日志，`'tarball'`/`'installed'`/`'release'` 三个值从未出现 |
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
| ⑪ | 批量面板入队（`src/host-batch.ts:579`） | Node | `update.batch.entry.request`；挂载点并入 `update.panel.mount` | info | resident | **#124** + **#122** |
| ⑫ | 队列两阶段/全局锁（`src/queue.ts`、`src/store.ts:287/349`） | Node | `update.queue.transition`、`update.lock.anomaly` | info / warn | resident | **#124** |
| ⑬ | 单项失败（批量）（`src/batch-run.ts:122`、`:159`） | 中立 | `update.batch.entry.fail` | warn | resident | **#124** |
| ⑭ | 总账（`src/panel-batch.ts:242`、`:283`） | 客户端渲染 | `update.batch.summary`（宿主侧汇总后发） | info | resident | **#124**；面板只渲染、**不重复发** |
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
| ⑪ | `update.batch.entry.request` | `src/host-batch.ts` `noteEntryRequest()`（会话建起/复用时一条，按会话编号去重） | ✅ |
| ⑫ | `update.queue.transition` / `update.lock.anomaly` | `src/store.ts` `writeQueue()`、`tryAcquireLock()`、`tryAcquireGlobalLock()`、`releaseLock()`、`releaseGlobalLock()`（只在乎「真写盘且相位真变」「真删掉旧锁且真抢到手」） | ✅ |
| ⑬ | `update.batch.entry.fail` | `src/batch-run.ts` `noteEntryFail()`（中立文件，落点由 `BatchRunDeps.logFor` 注入） | ✅ |
| ⑭ | `update.batch.summary` | `src/host-batch.ts` `noteBatchSummary()`（**收尾边沿**：每次从「没收尾」变成「收尾」记一条；用户重试装成后再收尾会再记一条。面板只渲染） | ✅ |
| ⑮ | `update.panel.action{action:'restart-hint'}` | 客户端 → #122 的 `logAppend` 通道落盘（**宿主没有重启自己的电话**，本包只做入口，观测不到重启结果） | 归 #122 |
| ⑯⑰⑲① | `update.lang.applied` / `update.panel.state` / `update.panel.action` / `update.panel.mount` | 客户端 → #122 的 `logAppend` 通道落盘 | 归 #122 |
| ⑱ | `update.store.fail` | `src/store.ts` `createStoreLog().fail()` 的 **16 个落点**（`:303`–`:641`，原 `catch {}` 或「换成归类码」的位置） | ✅ |

**三条落地口径（备案）**

1. **轮询的第一次观测不算事件**：`updateStatus` 的成功行在发射侧一律不发（`src/host.ts` 的电话包装）。判据是「上次算得出指纹、这次算得出、且与上次不同」才留一行；第一次没有可比的上次，所以也不留——这就是 §6「N ≥ 100 次零常驻行」的字面口径（实测 600 次 → 0 行）。指纹算不出来时宁多发一行，不吞变化；失败行 `host.call.fail` 不受影响；名字与五键形状一字不动。
2. `update.registry.fetch.cacheHit` **不存在**：本包的缓存命中发生在取数之前（命中就根本不取数），到了取数点就一定是未命中——恒为 `false` 的格子只是噪声。**2026-10-15 契约回填：已从随包清单 `event-list.update.json` 删除该字段名**（清单是发布的契约，声明一个永不出现的格子会把第三方聚合器带偏）。
3. **只进日志的可选入参**（不改老调用形状、不参与任何决策）：检查电话多认 `trigger`（没自报就不发 `update.check.start`）、安装电话多认 `from`（没自报按 `'panel'`，批量宿主传 `'batch'`）。
4. **缝都在宿主侧接**：中立文件（`service.ts`/`changelog.ts`/`queue.ts`/`batch-run.ts`）不 import node、也不认识插件标识，发射口一律由宿主侧**绑好标识**后注入（`src/host.ts` 的 `logPortFor()`；队列与全局锁按当次动作方取口，行落动作方自己的目录）。

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
| `src/entry-batch.ts:308` `mountUpdateBatchEntry` | ① | #122：**不传 `clientLog`**，所以报的是面板 `mode`（`'dialog'` 或 `'embedded'`），**不是 `'entry-batch'`** |
| `src/panel-batch.ts:1553` `mountUpdateBatchPanel` | ①⑪ | #122：**不传 `clientLog`**，报面板 `mode`（`'dialog'` 或 `'embedded'`），**不是 `'batch'`**；入队事实由 #124 在宿主侧发 `update.batch.entry.request` |
| `src/panel-batch.ts:242/283` `batchLedgerCounts`/`batchLedgerText` | ⑭ | 客户端**不发**：账本由宿主侧汇总成 `update.batch.summary`（#124）；面板只渲染，避免同一事实两处发 |
| `src/lang.ts:80` `resolveLang` | ⑯ | #122：`update.lang.applied` |
| `src/http.ts:230` `createHttpCall` | ④ | HTTP 变体在客户端闭包里跑：经 #122 的通道发 `update.registry.fetch`；Node 侧同一发射口（#124）不发第二条 |

**为什么必须有自己的通道**：面板侧没有 `ctx`、没有文件系统，dsh-log 的 `./client` 入口也不落盘（它只做内存队列 + 经宿主转发）。所以 #122 新增本包自己的 `<prefix>.logAppend` 电话（批量行、永不抛、回执 `{accepted, dropped}`），宿主半区接到**同一个** log handle——单写者不变。

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
