# 架构导航（改代码前先读这页）

这份仓库 `src/` 有 ~70 个文件、README 是用户手册而不是地图。本页只回答四个问题：
**代码从哪进、电话怎么串、日志怎么落、改一件事该动哪里**。行号会漂，地标给的是符号名；
用 `Select-String`/grep 找符号即可。

## 链路图

```
接入方（宿主插件 / HTTP / 面板直挂）
  │  电话表 handlers + phoneNames（名字全部由 src/config.ts 的 buildPhoneNames 派生）
  ├─ 单插件：createHostUpdate（src/host.ts）
  │    ├─ 业务：updateStatus/updateCheck/updateInstall/updateChangelog/updateCheckFallback
  │    │        → service.ts / reader.ts / changelog.ts / install-*、receipt、queue
  │    └─ 日志：loggedPhone 包一层 → emitUpdateLog 发 host.call / host.call.fail
  │
  ├─ 批量：createMultiHostUpdate（src/host-batch.ts）
  │    ├─ 每目标一份 createHostUpdate（不同前缀、同一使用范围）
  │    ├─ 共享队列端口 createUpdateQueuePorts（src/store.ts）
  │    │    └─ logFor = pluginLogPort（src/host-batch-log.ts）→ update.queue.transition/store.fail 落动作方目录
  │    ├─ 会话账本（src/batch.ts）+ 驱动器 runBatch（src/batch-run.ts）
  │    │    └─ 单项失败：logPortFor → update.batch.entry.fail 落失败那家自己的目录
  │    └─ 批量日志接缝 createBatchLogSeams（src/host-batch-log.ts）
  │         └─ 入队 / 总账 / 为什么停 / 七个电话失败 → 落属主（selfKey）目录；无属主一行不发
  │
  ├─ 单面板：mountUpdatePanel（src/panel.ts）
  │    └─ 客户端日志壳 createPanelClientLogShell（src/log/panel-client.ts）
  │         └─ src/log/client-queue.ts 攒批发送 → 打 <prefix>.logAppend 电话
  └─ 批量面板：mountUpdateBatchPanel（src/panel-batch.ts）＋ mountUpdateBatchEntry（src/entry-batch.ts）
       └─ 同一个 src/log/panel-client.ts（mode:'batch'）；批量宿主把 <批量前缀>.logAppend 转发给属主

日志内核（宿主侧唯一发射口）：emitUpdateLog（src/log/emit.ts）
  → 契约裁剪/降级（src/log/manifest.ts 事件表 + src/gate.ts pruneEventFields）
  → 路由/落盘（src/log/router.ts → src/log/sink.ts → dsh-log）
人读目录：event-list.update.json（契约清单）→ `npm run docs:log` → docs/research/20261014-log-event-catalog.md §1/§2
验证：tests/helpers/batch-log-harness.mjs（批量测试共享夹具）+ scripts/log-smoke.mjs（端到端冒烟）
```

## 地标表

**入口与电话**

| 符号 | 位置 | 用途 |
| --- | --- | --- |
| `mountUpdatePanel` / `renderUpdatePanelHTML` | `src/panel.ts` | 单面板挂载与纯渲染（浏览器安全面，禁 node:） |
| `mountUpdateBatchPanel` / `renderBatchPanelHTML` | `src/panel-batch.ts` | 批量面板（同上；22 个动作 kind 在 `BatchPanelActionKind`） |
| `mountUpdateEntry` / `mountUpdateBatchEntry` | `src/entry.ts` / `src/entry-batch.ts` | 入口件；批量入口件把 `clientLog:{mount:'batch'}` 递给批量面板 |
| `createHostUpdate` | `src/host.ts` | 单插件宿主能力（`phoneNames` + `handlers`） |
| `loggedPhone` | `src/host.ts` 内部 | 电话成功/失败行（host.call / host.call.fail）的唯一发点 |
| `createMultiHostUpdate` | `src/host-batch.ts` | 批量宿主能力；`BatchHostPhoneNames` 7 电话 + 可选 `logAppend` |
| `phone` | `src/host-batch.ts` 内部 | 批量电话外壳：try/catch 回稳定码 + 失败行（去重在接缝里） |
| `buildPhoneNames` / `buildLogAppendPhoneName` | `src/config.ts` | 电话名唯一来源（不许手写 `prefix + '.logAppend'`） |
| `createHttpCall` / `mountUpdatePanelHttp` | `src/http.ts` | HTTP 万能插头（单/批动作表见 `HTTP_PHONE_ACTIONS`/`HTTP_BATCH_ACTIONS`） |

**状态与账本**

| 符号 | 位置 | 用途 |
| --- | --- | --- |
| `createBatchSession` / `markBatchEntry` / `nextBatchKey` / `batchProgress` / `isBatchFinished` | `src/batch.ts` | 批量会话纯函数（相位机） |
| `runBatch` / `noteBatchEntryFailure` / `BatchFailStage` / `BatchStoppedByBecause` | `src/batch-run.ts` | 批量驱动器：查/装循环、单项失败行、停止原因词汇 |
| `createBatchOwnerPorts` / `createUpdateQueuePorts` / `createStoreLog` | `src/store.ts` | 会话账本与队列端口；`logFor` 决定队列行落谁家 |
| `resolveUpdateConfig` / `UpdateConfigInput` | `src/config.ts` | 电话前缀、插件标识、安装时限等派生根 |

**日志**

| 符号 | 位置 | 用途 |
| --- | --- | --- |
| `emitUpdateLog` | `src/log/emit.ts` | 宿主侧唯一发射口（裁剪、降级、sink） |
| `updateLogManifest` / `currentUpdateEventTable` / `primeUpdateEventTable` | `src/log/manifest.ts` | 随包事件表与测试预热 |
| `pruneEventFields` | `src/gate.ts` | 契约裁剪：未知字段摘、非法枚举摘字段并计降级行 |
| `createUpdateLogRouter` / `updateLogRouter` | `src/log/router.ts` | 按 pluginId 路由 sink |
| `createClientLogChannel` / `CLIENT_LOG_EVENTS` | `src/log/client-queue.ts` | 客户端攒批通道（浏览器安全面） |
| `createPanelClientLogShell` | `src/log/panel-client.ts` | 两面板共享日志壳：mount/action/render.fail/全局兜底/去重 |
| `createBatchLogSeams` / `pluginLogPort` / `emitBatchLog` | `src/host-batch-log.ts` | 批量日志状态（入队去重/总账边沿/为什么停/电话失败去重） |

**契约与验证**

| 文件 | 用途 |
| --- | --- |
| `event-list.update.json` | 日志契约清单：27 事件、顶层 `fieldEnums`、每事件 `level/kind/fields/codes/rules/guard` |
| `docs/research/20261014-log-event-catalog.md` | 人读事件目录（§1/§2 表的事件/级别/字段三列由 `npm run docs:log` 生成，说明列手写） |
| `tests/log-contract.test.mjs` | 清单/发射口契约测试（含负断言样板 `makeEmitter`） |
| `tests/gate.test.mjs` | `lintEventList` 与门禁 |
| `tests/helpers/batch-log-harness.mjs` | 批量日志测试共享夹具（bind/collector/rowsOf/fakeTransport/mkTarget/mkScope） |
| `scripts/log-smoke.mjs` | 端到端日志冒烟（6 个场景，PASS/SMOKE PASSED） |

## 改日志事件：三处 + 一条命令

ADR-0006 的纪律：**新增字段/枚举要改三处，并由机械门禁兜底**。

1. **发射点**：宿主侧 `emitUpdateLog(...)`（`src/host.ts` / `src/host-batch-log.ts` / `src/store.ts` 的端口接线）；
   客户端行走 `panel-client.ts` 的 `logClient(...)`（事件必须在 `CLIENT_LOG_EVENTS` 白名单里）。
2. **契约清单**：`event-list.update.json`——事件的 `fields` 加字段名；枚举值成组写进**顶层** `fieldEnums`
   （不要塞进条目里）；常驻事件 guard 写清「一行一条」的口径。
3. **人读目录**：`docs/research/20261014-log-event-catalog.md`——跑 `npm run docs:log` 让 §1/§2 两张事件表的
   机器列（事件/级别/字段）跟清单走，手写「触发与语义」列；`npm run docs:log:check` 只查不写。
4. **负断言测试**：`tests/log-contract.test.mjs` 的 `makeEmitter` 样板——表外值必须被摘字段且整行仍落；
   事件目录缺口只警告不失败。

改完跑（由快到全）：

```
npm run typecheck
npm run test:batch       # 批量相关定向
npm run docs:log:check   # 只查事件目录与清单的漂移
npm run check            # typecheck + build + 全量 + 双语门禁
```

## 常见改动路线

- **改单面板行为**：`src/panel.ts` 的 `mountUpdatePanel`（挂载校验、`refresh`/`act`/`render` 三个发射点），
  面板日志壳已抽到 `src/log/panel-client.ts`——改形状先改壳，两份面板一起受益。
- **改批量面板行为**：`src/panel-batch.ts` 的 `mountUpdateBatchPanel`；动作壳 `act` 会把宿主 `ok:false`
  回包映射成 `ok:false + 稳定码`（`failureLatch`），别绕过它直接调 `phone`。
- **改批量电话/落点**：`phoneNames` 在 `src/host-batch.ts` 的 `createMultiHostUpdate` 尾部；
  日志去重/边沿在 `src/host-batch-log.ts`；队列行归属只看 `createUpdateQueuePorts({logFor})`。
- **改批量驱动阶段**：`src/batch-run.ts` 的 `BatchFailStage`（check/install/timeout/settle）以及
  `src/host-batch.ts` 的 `defaultCheck`/`defaultInstall`/`settleInstall` 注入点。
- **改双语/文案**：`src/bilingual.ts` + `tests/fixtures/bilingual/copy-baseline.json`，改完 `npm run gate:bilingual`，
  基线变更用 `node scripts/bilingual-gate.mjs --update-baseline`。

## 验证阶梯

1. `npm run typecheck` —— 最快。
2. `npm run build` —— 测试 import `dist/`，不 build 测的是旧产物。
3. `npm run test:batch` —— 批量/面板定向（几十个文件里的 6 个）。
4. `npm run smoke:log` —— 真 dist 端到端 6 场景（含队列归属、无属主退化、阶段注入）。
5. `npm run check` —— 提交前全量（typecheck + build + `tests/*.test.mjs` + 双语门禁）。

## 读代码顺序（新人 30 分钟版）

1. 本页链路图 → 2. `src/config.ts` 的 `buildPhoneNames`（电话长什么样）→ 3. `src/host.ts` 的 `createHostUpdate`
   （单插件能力面）→ 4. `src/batch.ts` 的相位机 → 5. `src/batch-run.ts` 的 `runBatch` → 6. `src/host-batch.ts` 的
   `createMultiHostUpdate`（重点看 `driveLocked`/`installPhone`/`phoneNames`）→ 7. `src/log/emit.ts` +
   `event-list.update.json`（日志契约）→ 8. `tests/batch-log.test.mjs`（行为怎么验）。
