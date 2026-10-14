# 日志事件目录：19 环节 → 事件码 / 级别 / 档位 / 字段 / 脱敏

- 日期：2026-10-14
- 本票：[规格定稿](https://github.com/FeatherHunter/dsh-plugin-update/issues/119)（地图 [本包全面集成 dsh-log 0.3.1](https://github.com/FeatherHunter/dsh-plugin-update/issues/117)）
- 上游事实源：`docs/research/20261014-update-logging-inventory.md`（19 环节清单与逐条 `文件:行号`）、`docs/research/20261014-dsh-log-031-api.md`、`docs/research/20261014-dsh-host-logging-surface.md`
- 立规的两份 ADR：[ADR-0005 运行期依赖与落盘归属](https://github.com/FeatherHunter/dsh-plugin-update/blob/main/docs/adr/0005-dsh-log-as-first-runtime-dependency.md)、[ADR-0006 行只承载稳定码](https://github.com/FeatherHunter/dsh-plugin-update/blob/main/docs/adr/0006-log-rows-carry-codes-not-prose.md)
- **本文件是字段与事件名的事实源**：实现票（宿主侧接线 #124、面板侧通道 #122、清单与门禁 #120）正文里若有出入，以此处为准。

## 0. 口径与图例

- **环节 ≠ 事件**：一个事件可以承载多个环节的边沿（例如 `update.panel.mount` 同时是 ① 和面板/入口/批量三处挂载点），一个环节（⑫ 队列与锁）也可以有两个事件。下表每行给出该环节的落点事件与它贡献的字段。
- 档位（dsh-log 的 `kind`）：
  - **resident**——调试开关关着也落盘，因此**必须边沿触发**（不变量，铁律）；
  - **ondemand**——开关打开才落盘，可以逐次打点；
  - **selfmon**——本包日志接线自身的降级，永不外抛。
- 级别：`error` 用于「本包坏了/渲染失败」；`warn` 用于「这次操作没成，但系统还活着」；`info` 用于「做成了、走到哪一步了」。
- 侧：**Node** = 只许在 `import 'node:'` 的五个文件里发射；**中立** = 不依赖 DOM 也不依赖 node（可两边跑）；**客户端** = 面板/入口件里，只能经本包自己的 `logAppend` 电话（#122）。
- 既有三个事件名（`host.call`、`host.call.fail`、`update.install.exec`）**形状冻结**，被 `tests/phones.test.mjs:222/232`、`tests/routes.test.mjs:106` 逐字锁死：本次只改「发不发」，不改字段。

## 1. 常驻（resident）

| 事件码 | 级别 | 字段白名单 | 说明与脱敏 |
| --- | --- | --- | --- |
| `update.wire.ready` | info | `logSink: 'external'\|'self'\|'off'`、`logDirHash` | 接线自陈（外部实例/自建/关）。目录只给 hash8，不给路径 |
| `update.check.done` | info | `ok: true`、`current`、`latest`、`channel`、`source`、`latencyMs` | 版本号经中央校验器规范化；`source` 只给白名单主机名（复用 `resolveRegistryHost`）、**不带路径与账号** |
| `update.check.fail` | warn | `stage: 'fetch'\|'compare'\|'channel'\|'verify'`、`errorKind`、`httpStatus?` | 稳定码，无自由文本 |
| `update.status.changed` | info | `kind: 'update-available'\|'up-to-date'\|'unknown'`、`latest?` | 轮询的**边沿**：状态没变就不发（见 §4） |
| `update.install.request` | info | `from: 'panel'\|'entry'\|'batch'`、`current`、`latest`、`checkAgeMs` | 不含凭证；`checkId`/`requestId` 不进日志（关联靠 `traceId`） |
| `update.install.verify` | info | `result: 'completed'\|'restart-required'\|'failed'\|'interrupted'`、`installedVersion`、`pendingRestart: boolean` | 枚举 + 版本号 |
| `update.install.retry` | warn | `attempt: number`、`of: number`、`errorKind`、`waitedMs?` | 把「第 N 次重试」与首次失败分开，无需新增标识 |
| `update.batch.entry.request` | info | `total`、`ownCount`、`foreignCount` | 只给数量，不给插件标识清单 |
| `update.batch.entry.fail` | warn | `targetHash`、`errorKind`、`exitCode?` | 目标标识一律 hash8（绝不给包名/路径原文） |
| `update.batch.summary` | info | `total`、`ok`、`failed`、`skipped`、`durationMs` | 总账的机器可读版；面板渲染文本不进日志 |
| `update.queue.transition` | info | `phase: 'queued'\|'checking'\|'installing'\|'settling'\|'done'\|'idle'`、`waitedMs?`、`position?` | 相位边沿，禁止每次轮询都发 |
| `update.lock.anomaly` | warn | `kind: 'stale-owner'\|'busy-timeout'\|'release-failed'`、`ageMs?` | 拥有者标识只记 hash8，不记原文 |
| `update.store.fail` | warn | `op: 'state-read'\|'state-write'\|'lock-acquire'\|'lock-release'\|'backup-write'\|'queue-write'`、`reason: 'enoent'\|'eacces'\|'eext'\|'lease-conflict'\|'unknown'` | 现在 `catch {}` 静默吞的点；路径只给 `${dirHash}`，绝不落原文 |
| `update.restart.outcome` | info | `outcome: 'delegated'\|'manual'\|'failed'`、`route?` | `route` 只给枚举名，不给宿主 URL |
| `update.panel.mount` | info | `mode: 'embedded'\|'dialog'\|'entry'\|'entry-batch'\|'batch'`、`theme`、`lang`、`pollMs` | 全是枚举与数字 |
| `update.panel.action` | info | `action: 'check'\|'install'\|'retry'\|'restart'\|'copy-diagnostics'\|'skip'`、`bytes?`、`truncated?` | 复制诊断只记体量与是否截断，**绝不记内容** |
| `update.panel.render.fail` | error | `kind: 'container'\|'plugin-id'\|'call'\|'poll-ms'\|'mode'\|'theme'\|'unknown'` | 挂载校验 `throw` 的六种原因 + 渲染期兜底；无自由文本 |
| `update.log.degraded` | warn | `reason: 'no-dsh-log'\|'lease-conflict'\|'write-fail'\|'emit-threw'\|'unknown-field'\|'unknown-event'` | selfmon：日志接线自己的坏消息（含字段白名单丢弃计数） |

## 2. 按需（ondemand，开关打开才落）

| 事件码 | 级别 | 字段白名单 | 说明与脱敏 |
| --- | --- | --- | --- |
| `update.check.start` | info | `trigger: 'auto'\|'user'\|'batch'\|'entry'`、`source` | ② 的关键：把「用户点了」与「自动触发」分开 |
| `update.registry.fetch` | info | `httpStatus`、`latencyMs`、`cacheHit: boolean` | 只记白名单主机名与状态码，**不记完整 URL**（ADR-0001 规则 3） |
| `update.channel.decide` | info | `channel`、`reason: 'stable'\|'prerelease'\|'mismatch'\|'invalid'`、`from`、`to` | 版本号规范化后入行 |
| `update.changelog.parse` | info | `entries: number`、`truncated: boolean`、`degraded: boolean`、`source: 'tarball'\|'installed'\|'release'` | 解析失败只记 `degraded` + 稳定码；原文留给人话出口 |
| `update.poll` | info | `state`、`latencyMs` | 轮询全量（排查用）；稳态靠 resident 的 `update.status.changed` |
| `update.lang.applied` | info | `lang`、`source: 'dom'\|'navigator'\|'override'` | 语言标签已规范化 |
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
| ⑦ | 用户点击安装（`src/panel.ts:1594`、`:2760`） | 客户端 | `update.panel.action`（`action:'install'\|'retry'\|'restart'`）+ 宿主侧 `update.install.request` | info | resident | **#122** + **#124** |
| ⑧ | 安装执行（`src/store.ts:1180`，三条路由） | Node | 既有 `update.install.exec`（5 键，形状不动） | info | resident | 已存在；**#124** 只改「发不发」与行列归属 |
| ⑨ | 安装后校验（`src/service.ts:475`、`src/reader.ts:342`） | Node | `update.install.verify` | info | resident | **#124** |
| ⑩ | 失败重试（`src/panel.ts:868`、`src/panel-batch.ts:926`） | 客户端 | `update.install.retry`（`attempt`/`of`） | warn | resident | **#124** + **#122**（按钮动作） |
| ⑪ | 批量面板入队（`src/host-batch.ts:579`） | Node | `update.batch.entry.request`；挂载点并入 `update.panel.mount`（`mode:'batch'`） | info | resident | **#124** + **#122** |
| ⑫ | 队列两阶段/全局锁（`src/queue.ts`、`src/store.ts:287/349`） | Node | `update.queue.transition`、`update.lock.anomaly` | info / warn | resident | **#124** |
| ⑬ | 单项失败（批量）（`src/batch-run.ts:122`、`:159`） | 中立 | `update.batch.entry.fail` | warn | resident | **#124** |
| ⑭ | 总账（`src/panel-batch.ts:242`、`:283`） | 客户端渲染 | `update.batch.summary`（宿主侧汇总后发） | info | resident | **#124**；面板只渲染、**不重复发** |
| ⑮ | 重启宿主（`src/panel.ts:2760`、`src/panel-batch.ts:2122`） | 客户端触发 | `update.restart.outcome` | info | resident | **#122** 发 → **#124** 落盘 |
| ⑯ | 语言选择（`src/lang.ts:80`） | 客户端 | `update.lang.applied` | info | ondemand | **#122** |
| ⑰ | 主题渲染（`src/panel.ts:51`、`:154`、`:1847`） | 客户端 | `update.panel.state`（`theme`/`tokensApplied`/`fallback`）；非法值并入 `update.panel.render.fail` | info / error | ondemand + resident | **#122** |
| ⑱ | 落盘决策（`src/store.ts:62`、`:118`，state/锁/备份） | Node | `update.store.fail`；锁异常 `update.lock.anomaly` | warn | resident | **#124** |
| ⑲ | 复制诊断（`src/panel.ts:450`、`:592`） | 客户端 | `update.panel.action`（`action:'copy-diagnostics'`，附 `bytes`/`truncated`） | info | resident | **#122** |

**覆盖自查：19 行齐，每行都有事件码、级别、档位、接线票；没有未填项、没有推迟到实现票再定的事件。**

## 4. 跨环节的三条全局规则

1. **轮询抑制（噪声的根）**：`updateStatus` 是每 1000ms 一次的既有轮询（`src/panel.ts:2026-2030`）。规则是**边沿触发**——状态与上次相同就一条不发；状态变了发一条 `update.status.changed`；开关打开时另发 `update.poll` 全量。既有 `host.call` 的抑制同理：成功且状态未变时**不发**（名字与字段不变，只改发不发）。
   - 依据：`host.call` 在 dsh-log 内置常驻名单里（43 名之一），集成方清单**改不动**它，因此只能在发射侧治；现场 934 KB/天 的日志里 5309 行是它。
2. **关联**：每条行带 `traceId`（一次用户意图，如「点了安装」）与 `spanId`（一次尝试，如第 2 次重试），住 `fields` 里（dsh-log 的 `traceChain` 靠它串链）。`traceId` 形状由本包铸造、由测试锁死（沿用 ADR-0001 规则 4 的口径）。
3. **脱敏**：按 ADR-0006——行的字段只有「版本号 / 枚举白名单值 / 导出量（hash8、计数、时长、字节、布尔）」三类；路径、URL、令牌、邮箱、宿主原话、命令**根本不出现在日志行里**。落点是发射口 `emitRow()` 的白名单校验 + 每个事件的负向断言用例。

## 5. 客户端侧 11 个落点（`src/` 里打不了日志的地方，逐条点名）

依据 `docs/research/20261014-update-logging-inventory.md` §1.3 的判据（`import 'node:'` 命中即 Node 专属；其余 22 个 `.ts` 可进浏览器闭包）。

| 客户端落点（文件:行号） | 环节 | 走哪条路 |
| --- | --- | --- |
| `src/panel.ts:1999` `mountUpdatePanel` | ① | #122：`update.panel.mount` + 校验失败 `update.panel.render.fail` |
| `src/panel.ts:1981` `pendingAutoCheck` | ② | #122：并入 `update.check.start.trigger='auto'` |
| `src/panel.ts:2760` `case 'restart-hint'` | ⑮ | #122：`update.restart.outcome`（三种结局各一值） |
| `src/panel.ts:450` `buildDiagnosticText`、`:592` `buildUpdateDiagCopy` | ⑲ | #122：`update.panel.action{action:'copy-diagnostics', bytes, truncated}`；**内容不进日志** |
| `src/panel.ts:1533` `renderUpdatePanelKernel`、`:1847` `renderUpdatePanelHTML` | ⑰ | #122：`update.panel.state`（主题枚举 + token 数） |
| `src/entry.ts:351` `mountUpdateEntry` | ① | #122：`update.panel.mount{mode:'entry'}` |
| `src/entry-batch.ts:308` `mountUpdateBatchEntry` | ① | #122：`update.panel.mount{mode:'entry-batch'}` |
| `src/panel-batch.ts:1533` `mountUpdateBatchPanel` | ①⑪ | #122：`update.panel.mount{mode:'batch'}`；入队事实由 #124 在宿主侧发 `update.batch.entry.request` |
| `src/panel-batch.ts:242/283` `batchLedgerCounts`/`batchLedgerText` | ⑭ | 客户端**不发**：账本由宿主侧汇总成 `update.batch.summary`（#124）；面板只渲染，避免同一事实两处发 |
| `src/lang.ts:80` `resolveLang` | ⑯ | #122：`update.lang.applied` |
| `src/http.ts:230` `createHttpCall` | ④ | HTTP 变体在客户端闭包里跑：经 #122 的通道发 `update.registry.fetch`；Node 侧同一发射口（#124）不发第二条 |

**为什么必须有自己的通道**：面板侧没有 `ctx`、没有文件系统，dsh-log 的 `./client` 入口也不落盘（它只做内存队列 + 经宿主转发）。所以 #122 新增本包自己的 `<prefix>.logAppend` 电话（批量行、永不抛、回执 `{accepted, dropped}`），宿主半区接到**同一个** log handle——单写者不变。

## 6. 预算与验收口径

- **稳态**（无操作日）：常驻行 ≤ **50 行/天/插件**。
- **操作日**（一次安装或一次批量）：≤ **500 行/天/插件**。
- 轮询抑制生效的判据：连续 N 次 `updateStatus`（N ≥ 100）**零常驻行**。
- 每个事件至少一条负向断言用例（ADR-0006 §4）；字段名集合与 `event-list.update.json`（#120 产出）必须完全一致。
- 真机对账口径（#125）：两个假插件 `verify-a` / `verify-b` 各自目录行数 = 各自的发射数，互无 `foreign-write` 诊断。
