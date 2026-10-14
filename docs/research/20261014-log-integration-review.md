# 日志系统集成成果 · 独立复核（log-verifier）

> **2026-10-15 契约回填（本文件是快照，不改历史结论）**：复核时随包清单是 28 事件；`0.16.3` 起 `update.install.retry`、`update.restart.outcome` 两个事件名与 `update.registry.fetch.cacheHit` 字段名已从 `event-list.update.json` **删除**，清单现为 **26 条（常驻 18 / 按需 7 / 自监控 1）**。本文件 §1、§4、§5 里「28 条 / 2 条死条目 / 13 处 store.fail」等计数是**复核当时的实测值**，保持原样；现行口径与逐条处理见 `docs/research/20261014-log-event-catalog.md` §7 与 `CHANGELOG.md` 的 `0.16.3` 节。本复核查出的其余条目按「记录不修」备案（见目录 §7.1／§7.2）。

复核对象：`docs/research/20261014-log-integration-report.html`（1051 行）、`docs/research/20261014-log-event-catalog.md`（150 行）、`event-list.update.json`（28 事件）。

**快照与免责**：

- 代码快照 = `git HEAD 798e2ec`（「feat(panel): #123 错误章路牌给出日志目录与现成命令 + 0.16.0 发版定格」），其时工作树**干净**（`git status` 只剩本文件的未跟踪项）。提交链：`798e2ec` → `b81c5d4`（#124 宿主侧接线）→ `34b00e6`（地图 #117 快照）。
- 报告第 12 节写的「`git 34b00e6` 是快照提交」**已过时两跳**：34b00e6 的父提交是 b81c5d4、再上一跳才是 HEAD。
- **本文件所有行号以 2026-10-15T00:18（HEAD 798e2ec）重新逐条钉过**。复核期间仓库被其他 teammate 并发修改并提交过两次（README/host/panel/entry 行号整体漂过 ≥8 行），若后续再改代码，请按表中函数名而非行号定位。
- 复核方式：只读（grep / read / `node` 实跑）。除本文件外**没有修改任何仓库文件**；实跑预算装置只写 `.tmp/`（`.gitignore:13` 已忽略）与 `%TEMP%`。

---

## 1. 28 事件 × 发射点 × 字段 × 级别 × 档位（逐条核对）

档位/级别取自 `event-list.update.json`（20 resident / 7 ondemand / 1 selfmon），字段名逐字对比。✅ = 发射点存在且字段名、级别、档位与清单一致；⚠️ = 有取值面问题；❌ = 不一致。

| 事件 | 档位 | 级别 | 发射点（文件:行） | 字段名 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `host.call` | resident | info | `src/host.ts:867`、`:970`（成功行） | method/latencyMs/ok/kind/pluginId ✅ | ✅ 轮询首次也抑制（`:863`） |
| `host.call.fail` | resident | warn | `src/host.ts:882`、`:974` | method/kind/errorHash/pluginId ✅ | ✅ |
| `update.install.exec` | resident | info | `src/store.ts` emitInstall（既有，形状冻结） | route/ok/exitCode/durationMs/pluginId ✅ | ✅ |
| `update.wire.ready` | resident | info | `src/host.ts:766/785/790` | logSink/logDirHash ✅ | ✅ |
| `update.check.done` | resident | info | `src/service.ts:778` | ok/current/latest/channel/source/latencyMs ✅ | ✅ |
| `update.check.fail` | resident | warn | `src/service.ts:790` | stage/errorKind/httpStatus ✅（取值面见 D7） | ⚠️ D7 |
| `update.status.changed` | resident | info | `src/service.ts:684` 一带 | kind/latest ✅ | ✅ 清单两条带「边沿触发」之一 |
| `update.install.request` | resident | info | `src/service.ts:884` | from/current/latest/checkAgeMs ✅ | ✅ |
| `update.install.verify` | resident | info | `src/service.ts:724/834/854` | result/installedVersion/pendingRestart ✅ | ✅ |
| `update.install.retry` | resident | warn | **无**（`grep update.install.retry src/` 零命中） | — | ❌ D1 |
| `update.batch.entry.request` | resident | info | `src/host-batch.ts:833` | total/ownCount/foreignCount ✅ | ✅ |
| `update.batch.entry.fail` | resident | warn | `src/batch-run.ts:112`（`:165`、`:203` 调用） | targetHash/errorKind/exitCode ✅ | ✅ |
| `update.batch.summary` | resident | info | `src/host-batch.ts:856` | total/ok/failed/skipped/durationMs ✅ | ✅ |
| `update.queue.transition` | resident | info | `src/store.ts:568`（`:623` reclaimed） | phase/waitedMs/position ✅ | ✅ 另一条带「边沿触发」 |
| `update.lock.anomaly` | resident | warn | `src/store.ts:357/374/380/622/642` | kind/ageMs ✅（ownerHash 不发，与目录 §1:36 一致） | ✅ |
| `update.store.fail` | resident | warn | `src/store.ts:303/316/323/339/348/360/373/379/394/407/564/580/603/613/626/641`（16 处） | op/reason ✅（dirHash 不发，一致） | ⚠️ D10 |
| `update.restart.outcome` | resident | info | **无**（`grep` 零命中；`src/panel.ts:2952` 的 `restart-hint` 分支全程无日志行） | — | ❌ D2 |
| `update.panel.mount` | resident | info | `src/panel.ts:2211` | mode/theme/lang/pollMs ✅（取值面见 D4） | ⚠️ D4 |
| `update.panel.action` | resident | info | `src/panel.ts:2722` | action/bytes/truncated ✅（取值面见 D3） | ⚠️ D3 |
| `update.panel.render.fail` | resident | error | `src/panel.ts:2090/2522` | kind ✅ | ✅ |
| `update.check.start` | ondemand | info | `src/service.ts:757`（`triggerOf` 没自报就不发） | trigger/source ✅ | ✅ |
| `update.registry.fetch` | ondemand | info | **仅** `src/service.ts:337` | httpStatus/latencyMs/registryHost ✅（cacheHit 不发，一致） | ⚠️ D8 |
| `update.channel.decide` | ondemand | info | `src/service.ts:703` | channel/reason/from/to ✅ | ✅ |
| `update.changelog.parse` | ondemand | info | `src/host.ts:1067` | entries/truncated/degraded ✅，**source 见 D5** | ❌ D5 |
| `update.poll` | ondemand | info | `src/service.ts:740` | state/latencyMs ✅ | ✅ |
| `update.lang.applied` | ondemand | info | `src/panel.ts:2173` | lang/source ✅（取值面见 D6） | ⚠️ D6 |
| `update.panel.state` | ondemand | info | `src/panel.ts:2208` | state/theme/tokensApplied/fallback ✅ | ✅ |
| `update.log.degraded` | selfmon | warn | `src/log/emit.ts:137`（+`src/host.ts:780`） | reason ✅ | ✅ |

**小结**：28 条里 **26 条有真实发射点**；`update.install.retry`、`update.restart.outcome` **零发射点** ⇒ 目录 §3:55「覆盖 19/19」与报告 `:568`「28 条事件覆盖 19/19 环节」对 ⑩⑮ 不成立（报告 `:589/:594` 已打星，但 `:568` 总括句与 `:634`「安装链」分组仍把它们算作已覆盖）。
**所有实际发射的字段名都在白名单内**（含 `httpStatus?`/`exitCode?`/`registryHost` 等可选格），未发现白名单外字段名。**字段取值不受清单校验**（清单无 `codes`），因此 D3–D7 的取值不一致**不会拒收，会照原样落盘**。

---

## 2. 不一致清单（报告必须按这些改）

### D1 `update.install.retry` 无发射点，且不在客户端白名单（双重死路）
- 规格：目录 §3:68（⑩ 落点 `src/panel.ts:868`、`src/panel-batch.ts:926`）、§3.1:95「客户端按钮动作 → #122 的 logAppend 通道落盘」；报告 `:589`。
- 实测：`grep -n "update.install.retry" src/` **零命中**；客户端白名单 `CLIENT_LOG_EVENTS`（`src/log/client-queue.ts:100-106`）只有 5 个：`update.panel.mount` / `.action` / `.render.fail` / `.state` / `update.lang.applied`（`isClientLogEvent` 在 `:110`）；宿主侧 `logAppendRows()` 对非白名单事件 `dropped++` **拒收**（`src/host.ts:1213`）。
- ⇒ 该事件当前**不可能落盘**；「⑩ 失败重试」这一环是空的。

### D2 `update.restart.outcome` 无发射点，且不在客户端白名单
- 规格：目录 §3:73、§3.1:100、§5:132（`case 'restart-hint'`）；报告 `:594`。
- 实测：`grep -n "update.restart.outcome" src/` **零命中**；`src/panel.ts:2952` 的 `case 'restart-hint'` 只调 `onRestartRequested` / 提示手动重启 / 失败文案，**全程无日志行**；批量侧 `src/panel-batch.ts:926` 有 `data-act="restart"` 按钮，但该文件**没有任何日志发射**（grep `update.panel.|createClientLogChannel` 零命中）。
- ⇒ 与 D1 同构：⑮ 也是空的，即便发也会被 `src/host.ts:1213` 拒收。

### D3 `update.panel.action.action` 取值集合与目录/报告不一致
- 实际：`action` = `data-action` 属性原样透传（`src/panel.ts:3025` 读属性 → `:3027` `act(kind)`），`UpdatePanelActionKind`（`src/panel.ts:199-210`）= `check | install | skip | reset-skip | copy-manual | copy-diag | toggle-queue | toggle-changelog | restart-hint | close-view | dismiss-failure`（11 值），在 `src/panel.ts:2722` 发。
- 规格/报告：目录 §1:39 与报告 `:586` 写 `check | install | retry | restart | copy-diagnostics | skip`，报告 `:598`（⑲）写 `copy-diagnostics`。
- 逐值冲突：`retry` **从不发射**（面板没有这个动作类别）；`restart` 实际是 `restart-hint`；`copy-diagnostics` 实际是 `copy-diag`；另有 6 个**未登记**取值。
- 测试锁的是实际值：`tests/panel-log.test.mjs:197-199` 断言 `fields.action === 'copy-diag'`。

### D4 `update.panel.mount.mode` 实际会出现 `'http'`；`'entry-batch'`/`'batch'` 无实现
- 实际传名字的只有两处：`src/entry.ts:590` `{ mount: 'entry' }`、`src/http.ts:353` `?? { mount: 'http' }`；`src/panel.ts:2211` 发 `mode: clientLogMountName || mode`（否则是 `embedded`/`dialog`）。
- `src/entry-batch.ts:498` 调 `mountUpdateBatchPanel` **不传 `clientLog`**；`src/panel-batch.ts` 全文**零日志**。
- ⇒ 目录 §1:38 / §5:136-137 与报告 `:590` 宣称的 `mode:'entry-batch'`、`mode:'batch'` **没有实现**；实际会落的 `'http'` 不在声明枚举（`embedded|dialog|entry|entry-batch|batch`）里。批量面板（含入口件的批量形态）不会有任何客户端日志行——同时影响 ①⑪⑭⑮ 的「客户端侧落点」说法。

### D5 `update.changelog.parse.source` 实际发 `'npm'`
- 规格：目录 §2:50 `source: 'tarball'|'installed'|'release'`、§3.1:91「`source:'tarball'`」。
- 实际：`src/host.ts:1067-1072` 发 `source: 'npm'`（`:1071` 逐字）。清单无取值枚举 ⇒ 不拒收，照落。

### D6 `update.lang.applied.source` 实际可能落 `'default'`（第 4 个值）
- 规格：目录 §2:52 只列 `dom|navigator|override`。
- 实际：`src/lang.ts:77` `LangSignalSource = 'override'|'dom'|'navigator'|'default'`，三路无信号时回 `'default'`（`src/lang.ts:101-105`），`src/panel.ts:2173` 原样发。

### D7 `update.check.fail.stage` 声明的 `'compare'`/`'verify'` 没有赋值点
- 规格：目录 §3.1:88 与 `src/service.ts:39` 都声明四值 `fetch|compare|channel|verify`。
- 实际赋值只有两处：`err.stage = 'fetch'`（`src/service.ts:308`）与 `withStage(..., 'channel')`（`src/service.ts:400/463/493`）；全仓没有把 stage 贴成 `'compare'`/`'verify'` 的代码。
- ⇒ 报告 `:584` 要补：另外两个声明值当前不可达（补点名或按实现收窄枚举）。

### D8 `update.registry.fetch` 的 `/http` 变体零接线
- 规格：目录 §3:62、§3.1:89、§5:140 都说 `/http` 变体走 #122。
- 实际：全仓唯一发射点是 `src/service.ts:337`；`src/http.ts` 无任何日志接线（`createHttpCall` 只做 fetch；`src/http.ts:353` 的 `{mount:'http'}` 只覆盖面板挂载点）。且该事件不在客户端白名单 ⇒ 即便在 HTTP 侧发也会被拒收。
- ⇒ 报告 `:583`（④「`/http` 变体走客户端」）必须打星或删。

### D9 「resident ⇒ 边沿触发」不是机器化规则：清单里只有 2/28 带标记
- 目录 §1:13 把它写成铁律；报告不变量 #8（`:899`）说「谁钉住它：清单 `guard` 标注 + 发射口指纹去重」。
- 实测：28 个 `guard` 文本里**只有 `update.status.changed`（「边沿触发：状态未变不发」）与 `update.queue.transition`（「相位边沿触发…」）含那四个字**；`src/log/manifest.ts:96-103` 的 `isEdgeEvent()` 正是按这四个字判定，`src/log/emit.ts:183` 的指纹去重只对 `isEdgeEvent` 为真者生效。
- ⇒ 其余 resident 事件没有清单层标记、也没有发射口去重，全靠各发射点手写（如 `update.panel.state` 键变才发、`update.store.fail` 同因去重 `src/store.ts:143-153`、`update.batch.summary` 收尾边沿）。报告不能把 #8 写成「清单 + 发射口统一钉住」。

### D10 「`catch {}` 静默点共 13 处」须限定语
- 目录 §3.1:102 与报告 `:597` 写「共 13 处」。
- 实测 `storeLog.fail(` 调用点 **16 处**（`Select-String` 计数 16；`git show b81c5d4 -- src/store.ts` 新增行里也是 16 条），分布见 §1 表；11 个 `op` 取值全在声明集合内。
- 13 = 16 − 3（`write-job` `:316`、`read-snapshot` `:394`、`write-queue` `:564` 原本就会抛/换归类码）。⇒ 只有写「原 `catch {}` 静默点 13 处（另有 3 处换归类码），`store.fail` 总调用点 16 处」才准确。

### D11 README 的命名空间算法描述与实际不符（截 32 位 vs 截 24 位）
- `README.md:686` 写「…去首尾 → **截 32 位**；只要这一步有损…补 `-<sha256 原文前 6 位>`」。
- 实际：`src/log/namespace.ts:23` `SLUG_CHARS = 24`，`:73` `slug.slice(0, SLUG_CHARS)` 并去尾部 `-`，再拼 6 位（24+1+6=31 ≤ 32，`:22` 注释写明）。按 README 截 32 位再补 6 位会得 39 字符、越出 `NAMESPACE_SHAPE`（`:19`）。

### D12 「不同 raw 标识永不派生出同一个名字」实测被打破（24 位指纹碰撞）
- `src/log/namespace.ts:9-12` 把该条写成不变量，`README.md:686` 也写「不同 `pluginId` 永不共目录」。
- 实测（`node` 直接引 `dist/log/namespace.js`）：
  - `deriveLogNamespace('plugin-' + 'a'.repeat(30) + '-2888')` → `plugin-aaaaaaaaaaaaaaaaa-1c9b0f`
  - `deriveLogNamespace('plugin-' + 'a'.repeat(30) + '-3218')` → **同一个** `plugin-aaaaaaaaaaaaaaaaa-1c9b0f`
  - 用 `node:crypto` 独立复算：两者 `sha256` 前 6 位都是 `1c9b0f`（完整 8 位 `1c9b0f44` / `1c9b0fd4`，`src/log/namespace.ts:74` 只取 6 位）。
  - 普查：5000 个「前 24 字符相同、总长 > 32」的 raw 里出现 **2 组**撞名（同前缀短 id 之间不会撞，因为前缀本身进了名字）。
- ⇒ 该不变量是**概率性**的（24 bit，生日碰撞约 1/1.67e7 每对），不是数学保证；超长/同前缀 pluginId 是真实风险面。报告不变量 #4（`:895`）必须加「指纹位数/概率性」限定。
- 顺带核实：`My.Plugin` → **`my-plugin-fb637b`**（= `sha256('My.Plugin')` 前 6 位 `fb637b`）；`wf` → `wf` 且开关文件 `log-switch.json`（`src/log/namespace.ts:88-91` 保留分支），其余 `log-switch-<派生名>.json`。

### D13 `traceId`/`spanId` 的归因错误（报告差异 #4 的结论站不住）
- 报告 `:935-937` 说「规格要求每条行带 traceId/spanId；`src/` grep 零命中 ⇒ 按 trace 追链的能力**不具备**」。
- 实测与源码：这两个字段**由 dsh-log 自动注入，但只在它的客户端 SDK 写入路径**——`node_modules/dsh-log/dist/client/write.js:108-127`（`ensureTraceForLevel(level)` 后写 `out.traceId`/`out.spanId`/`out.seq`）；dsh-log 自己的文档也只在客户端语境写这件事（`node_modules/dsh-log/README.md:498`、`:326`）。
- 宿主侧 `store.log(level, event, fields)` **不注入**：`node_modules/dsh-log/dist/store.js` 无任何 trace 代码；本包自建实例正是走 `src/log/sink.ts:56-63` → `store.log`。实测探针（真 `createNodeHostLog`，临时目录）：`store.log('error','update.verify.error',{probe:2})` 落盘行是 `{"probe":2}` —— **无 traceId/spanId/seq**（探针另注：开关关着时 `store.log('info',…)` 回执 `skipped`，`error` 回执 `queued`）。
- ⇒ 正确说法：**本包自建落点与自建客户端通道（`src/log/client-queue.ts`）产出的行不带 trace 三件套（实测），只有集成方传入 dsh-log 客户端实例的 `logCtx` 时才有**；`npx dsh-log tail <dir> --trace` 在自建路径上追不到链。不能说「本包规格承诺了实现没做」——本包从未铸造它，目录 §4 规则 2（`:121`「traceId 形状由本包铸造、由测试锁死」）本身与依赖实现不符。

---

## 3. 票 #124 已知缺口复核（逐条：缺口是否还在）

| # | 票面缺口 | 复核结论 | 证据（HEAD 798e2ec） |
| --- | --- | --- | --- |
| 1 | `entry.fail.exitCode` 真路径未实测 | **成立**（须写明链路已接） | `src/batch-run.ts:203` 传 `installed.exitCode` → `:112` 发字段；来源 `src/host-batch.ts:248-251` `exitCodeOf(reply) = reply.diag.exitCode`（`:604` 调用）；测试用**注入假回包**（`tests/batch-log.test.mjs:131/156/159/227/289/305` 断言 7/5/3），`tests/diag-phone.test.mjs:258-281` 证明 exec 阶段 diag 带 exitCode ⇒ 缺的是「真装失败」端到端一条 |
| 2 | `from:'batch'` 缺端到端断言 | **须限定**：不是「完全没测」 | `src/host-batch.ts:594` 真传 `from:'batch'` → `src/host.ts:1115/1145/1158` → `src/service.ts:884`；**已有电话层断言** `tests/host-log.test.mjs:216-226`（`fields.from === 'batch'`）。缺的只是 `createMultiHostUpdate → 批量链 → 落盘行` 一条 |
| 3 | `releaseLock` unlink 真失败内层分支无测试 | **成立** | 内层分支 `src/store.ts:370-375`（锁读得出来、unlink 抛）无用例；`tests/store-log.test.mjs:121-141` 把锁路径做成**目录** ⇒ 读锁即抛 EISDIR ⇒ 走外层 `src/store.ts:377-381`（断言 `{op:'release-lock',reason:'eisdir'}`，`:135`） |
| 4 | `cacheHit` 不发 | **成立且一致** | 发射字段 `src/service.ts:337-342`；目录 §3.1:107 |
| 5 | `busy-timeout` 不做 | **成立且一致** | `src/store.ts:60-61` 只有 `stale-owner`/`release-failed`；目录 §1:35 |

**票外发现**：D1/D2 说明「28 事件」里有 2 条死条目；这两个事件在 `tests/` 全仓**零引用**（grep 只命中清单、目录、报告），目录 §6:149「每个事件至少一条负向断言用例」对它们不成立。

---

## 4. 文档声明 vs 代码（逐条）

| 声明 | 结论 | 证据（HEAD 798e2ec） |
| --- | --- | --- |
| README §10（`README.md:678` 起）落点 `<homeDir>/logs/<派生命名空间>/` | ✅ 一致 | `src/host.ts:726-728` `updateLogRootDir = join(homeDir,'logs')` + `src/log/registry.ts:145` `join(logsRoot, namespace)` |
| README §10 开关文件 `log-switch-<派生名>.json` | ✅ 一致（含保留分支） | `src/log/namespace.ts:88-91`；`src/log/registry.ts:179` 传给 dsh-log |
| README §10「轮询看状态一条常驻行都不落——第一次也不算事件」 | ✅ 一致 | `src/host.ts:863` `pollSuppressed = pollNoise && fingerprint !== null && (previous === null \|\| previous === fingerprint)`；失败行不受影响（`:882`）。**注意** `src/host.ts:804` 的注释仍写「第一次…照常落一行」，是过时注释（与实现相反） |
| README §10「失败退避重试 2 次后丢弃并计数」「一批 50 行、间隔 1 秒、环形 200 行」 | ✅ 一致 | `src/log/client-queue.ts:84-89`：`CLIENT_LOG_MAX_QUEUE=200`、`BATCH_SIZE=50`、`FLUSH_MS=1000`、`MAX_RETRIES=2`、`RETRY_DELAYS_MS=[250,1000]`、`SEND_TIMEOUT_MS=5000`；后台切换立即冲刷 `:349-365` |
| README §10 客户端只收 5 个事件 | ✅ 一致 | `src/log/client-queue.ts:100-106`；`src/host.ts:1213` 拒收非白名单 |
| README §10（`:690`）「稳态一天不超过 50 行，一个操作日不超过 500 行」 | ✅ 装置实测通过（**带限定语**） | 我实跑 `node .tmp/log-verify/run.mjs budget` → `pass 8/8`：A1/A2 86400 次同状态/同相位 → 1 行；A3 稳态 24h 常驻 2 行；B1 600 次轮询 → 0 行；C1/C2「安装/批量当天」= **事件面模型 37 行**（不是真安装，见 `docs/research/20261014-log-isolation-verification.md` §5）；D1 开关关着 50 条 ondemand info 全 `skipped`。报告若写「实测一次真安装 ≤500 行」就是夸大 |
| README `:13`「零运行时依赖。当前版本 `0.10.0`」 | ✅ 复核后已修（原 ❌ 过期） | 原状：`package.json:3` `"version": "0.16.0"`；`package.json:81-83` `dependencies: { "dsh-log": "^0.3.1" }`（`:82`）；`README.md:680` 自己已写「`0.15.0` 起 dsh-log 是第一个运行期依赖」。已改为「要求 Node 22 或更高。当前版本 `0.16.0`，运行期依赖只有一个：`dsh-log ^0.3.1`（0.15.0 起，见第 10 节）」，同屏 `:17`「四个电话」→「五个电话」（补 `logAppend`）、`:570`「四个电话名」→「五个电话名」。**发布物仍未修**：npm 上 0.16.0 tarball 里的 README 还是旧行——仓库修好 ≠ npm 页修好，要重新发一版才生效 |
| `src/` 下零 `console.*` | ✅ 一致 | `grep -n "console\." src/` 零命中 |

---

## 5. 我实际跑过的检查（命令 + 输出要点）

1. `git log --oneline -3` → `798e2ec`(HEAD) / `b81c5d4` / `34b00e6`；`git status --porcelain` → 复核末期工作树干净（仅本文件未跟踪）。
2. `node` 引 `dist/log/namespace.js` → `My.Plugin → my-plugin-fb637b`；`wf → wf` + `log-switch.json`；70000 个有损 id 普查（5000 个同前缀超长 id 里 2 组撞名，给出可复现 pair）；`node:crypto` 复算确认 sha256 前 6 位相同。
3. `node` 引 `dist/node.js` 真建 `createNodeHostLog`（临时目录）→ `store.log('error',…)` 落盘行 `{"probe":2}`（**无 traceId/spanId/seq**）；`log('info',…)` 回执 `skipped`，开关 `{"enabled":false}`。
4. `node .tmp/log-verify/run.mjs budget` → `budget: pass（8/8 条过）`、`总判定：pass`、`跑动期间 dist 未被改写：true`、`dsh-plugin-update@0.16.0 · dsh-log@0.3.1`。
5. grep 普查：`update.install.retry`/`update.restart.outcome` 在 `src/` 零命中；`CLIENT_LOG_EVENTS` 恰 5 条；`storeLog.fail(` 16 处；28 条清单的 level/kind/guard 全量 dump（只有 2 条 guard 含「边沿触发」）；`src/panel-batch.ts` 零日志发射；`src/http.ts` 无 registry.fetch 接线；`src/` 零 `console.*`。
6. 阅读报告全文（19 环节表 `:576-600`、缺口表 `:912-952`、不变量表 `:889-906`、复现命令 `:976-984`）与目录 §1–§6 逐行；对报告每一条关键声明回头 grep 代码验证。

---

## 6. 建议：报告里不能写 / 必须带限定语的句子

**绝对不能写（写了就是错）**
1. 「28 条事件覆盖 19/19 环节」→ ⑩⑮ 零发射点（D1/D2）。
2. 「`update.install.retry` / `update.restart.outcome` 由客户端经 `logAppend` 落盘」→ 没发射点、不在白名单，会被 `src/host.ts:1213` 拒收。
3. 「`update.panel.action` 的值是 `install/retry/restart`」或「`copy-diagnostics`」→ 没有 `retry`，实际 `restart-hint`、`copy-diag`（D3）。
4. 「`update.panel.mount{mode:'batch'|'entry-batch'}`」→ 无实现；实际会出现未登记的 `'http'`（D4）。
5. 「`update.changelog.parse{source:'tarball'}`」→ 实际 `'npm'`（D5）。
6. 「每条行带 `traceId`/`spanId`，本包已铸造 / 未实现」→ 两个方向都错（D13）。
7. 「不同 pluginId 永不共目录」作为绝对不变量 → 实测可撞（D12），只能写「24 位指纹，概率性隔离」。

**必须带限定语**
- 「操作日 ≤ 500 行」→ 加「装置按**事件面模型** 37 行外推（非真安装）」。
- 「resident 事件必须边沿触发」→ 加「清单层标记 + 发射口指纹去重**只覆盖 2 条**，其余靠发射点手写去重」。
- 「原 `catch {}` 静默点 13 处」→ 加「`store.fail` 总调用点 16 处，其中 13 处原先静默」。
- 「`from:'batch'` 无测试」→ 加「电话层已有断言（`tests/host-log.test.mjs:216-226`），缺的是批量链端到端一条」。
- 「快照提交 `34b00e6`」→ 改为「`798e2ec`（其后两次提交：`b81c5d4` #124、`798e2ec` #123 发版定格）」。
- 引用 README §10 的命名空间算法时别照抄「截 32 位」→ 实际截 24 位（D11）。

---

## 7. 复核后的处置（本轮已落，收口清单）

**已在仓库改掉（本轮）**

- D11/D12（命名空间口径）：`README.md:686` 按实现改写（无损分支原样通过；有损分支截 24 位 + `-hash6`，合计 ≤31），并把「不同 `pluginId` 永不共目录」限定为「无损分支保证；有损分支 24 位指纹概率性隔离」；同处更正 `README.md:640`、`CONTEXT.md:26`、`CHANGELOG.md:59`（0.15.0 条目原文）、`src/log/namespace.ts:9-12` 的不变量注释。
- D13（追链口径）：`README.md:562` 与 `README.md:703` 不再把 `--trace <traceId>` 当既有能力；事件目录 §4 规则 2 改成「三件套只由 dsh-log 客户端 SDK 注入，本包自建落点不带」。
- 第一屏（报告 §12.3 第 15 条）：`README.md:13` 由「零运行时依赖。当前版本 `0.10.0`」改为「要求 Node 22 或更高。当前版本 `0.16.0`，运行期依赖只有一个：`dsh-log ^0.3.1`（0.15.0 起）」；`README.md:17` 四个电话 → 五个电话、`README.md:570` 四个电话名 → 五个电话名。

**明确仍未做（留给下一版，别在文案里当既有能力写）**

- npm 上已发布的 `0.16.0` tarball 内 README 仍是旧行：要 npm 页正确，必须再发一版（`0.16.1` 一类的文档补丁版）。
- 发布门禁没有「README 声明的版本／依赖面与 `package.json` 一致」「文档枚举值与 `event-list.update.json` 一致」这两道检查（报告 §12.3 的建议）。
- 自建落点的 `traceId`/`spanId` 铸造（要追链就得改走 SDK 建链包装 + 字段白名单加两格）。
- 报告 §12.3 第 16 条里写到的 `update.panel.mount{mode:'http'}` 未登记、`update.changelog.parse{source}` 实际值 `'npm'` 等事件清单层的小差异（D4/D5），本轮未动。
