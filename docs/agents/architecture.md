# 架构导航（目录地图 + 改一处去哪）

读者从 `AGENTS.md` 的「架构导航」进来。`src/` 已按业务域铺开：根目录只剩**入口壳**，实现全在
`host/ panel/ core/ shared/ log/` 五个域目录。本页回答四件事：**目录怎么分、入口怎么进、
日志与电话怎么串、改一件事动哪几个文件**。

符号名是稳定地标。本文行号按写作时的 HEAD 标注（2026-10-19，`#230` 收口后）；漂了就用
`Select-String -Path src -Pattern '<符号名>'` 重新定位。`src/` 下每个非 ambient 的 `.ts`
（104 个）由 `node build.mjs` 一对一转成 `dist/` 同名 `.js`（2 个 ambient `.d.ts` 只进类型
检查、不产 js；`.d.ts` 由 tsc 随 `npm run build` 产出）。

## 目录地图

```
src/
├─ host.ts               ./              → dist/host.js         单插件宿主入口（转发 host/ 与 log/ 公开面）
├─ host-batch.ts         ./batch         → dist/host-batch.js   批量宿主入口
├─ panel.ts              ./panel         → dist/panel.js        单面板入口
├─ panel-batch.ts        ./panel-batch   → dist/panel-batch.js  批量面板入口
├─ client.ts             ./client        → dist/client.js       客户端入口（电话名/轮询口径）
├─ entry.ts              ./entry         → dist/entry.js        更新入口件（按钮/徽标/内嵌）
├─ entry-batch.ts        ./entry-batch   → dist/entry-batch.js  批量感知入口件
├─ install-button.ts     ./install-button → dist/install-button.js 槽位安装按钮
├─ http.ts               ./http          → dist/http.js         HTTP 万能插头
├─ log/
│  └─ index.ts           ./log           → dist/log/index.js    日志内核公开出口
│                          （另有 ./package.json 直出 package.json，无壳）
│
├─ host/               宿主侧：电话装配、日志接线、环境探测、HTTP 插头（Node 侧）
│  ├─ factory.ts  phones.ts  capabilities.ts  environment.ts  forwarding.ts  http.ts
│  ├─ hub/             进程级更新中枢：协议/异常边界/方案/租约/泵/孤儿接管/换代/只读聚合
│  │  └─ protocol.ts  boundary.ts  handoff.ts  plan-store.ts  lease-store.ts
│  │     json-file.ts  registry.ts  adopt.ts  aggregate.ts
│  └─ batch/           批量宿主：扇出、批内电话语义、续跑、日志接缝
│     └─ fan-out.ts  phones.ts  resume.ts  log.ts
│
├─ panel/              浏览器侧组件（零 node:）：挂载、视图模型、渲染、主题、入口件
│  ├─ mount.ts  render.ts  view-model.ts  theme.ts  archive-theme.ts
│  ├─ failure-latch.ts  skip-store.ts  client.ts  entry.ts
│  └─ batch/           批量面板：helpers → ledger → render → mount 单向依赖
│     └─ helpers.ts  ledger.ts  render.ts  styles.ts  mount.ts  entry-batch.ts
│
├─ core/               业务内核：决策纯函数 + Node 跑腿（reader/disk/executor/io 会碰 node:）
│  ├─ service.ts  reader.ts  disk.ts  executor.ts  store-base.ts  gate.ts
│  ├─ judgment.ts  conclusion.ts  cause.ts  failure.ts  fetch.ts
│  ├─ queue/           跨插件单队列与锁：模型纯函数 + 落盘端口
│  │  └─ model.ts  ports.ts
│  ├─ batch/           批量会话账本与驱动器
│  │  └─ model.ts  run.ts
│  ├─ install-button/  槽位安装按钮：视图模型、渲染、样式、挂载、中立小工具
│  │  └─ widgets.ts  view.ts  render.ts  styles.ts  mount.ts
│  ├─ changelog/       更新日志：纯解析、渲染模型、校验、Node 侧读取
│  │  └─ parse.ts  render-model.ts  validator.ts  io.ts
│  └─ i18n/            文案字典与单语语义块渲染
│     └─ dictionary.ts  text.ts  styles.ts
│
├─ shared/             中立零件：不碰宿主状态，宿主与浏览器同缝（仅 self.ts 读 node:url）
│  └─ codes.ts  ports.ts  redaction.ts  diag.ts  hash.ts  lang.ts  log-events.ts
│     copy.ts  compliant.ts  commands.ts  manual-absent.ts  last-resort.ts
│     failure-settled.ts
│     config.ts  self.ts  node-ambient.d.ts  runtime.d.ts
│
└─ log/                日志内核：发射口、清单、路由/落点、登记表、客户端通道
   └─ emit.ts  manifest.ts  router.ts  sink.ts  registry.ts  namespace.ts
      health.ts  trace.ts  own-version.ts  panel-client.ts  client-queue.ts
```

各域边界：`host/` 知道宿主事实（家目录、使用范围、dsh-log 落点）；`panel/` 只跑在浏览器里，
运行期只许引 `log/client-queue.ts` 与 `log/panel-client.ts`，`log/` 其余文件只许 `import type`
（`tests/log-kernel.test.mjs` 守这条）；`core/` 只按端口做决定，Node 能力集中在少数跑腿文件；
`shared/` 两边都能进；`log/` 只有 Node 侧与浏览器安全面两条线，中间不许混。

## 入口壳纪律

10 个壳（9 个业务壳 + `log/index.ts`）的纪律只有一条：**壳是公开面，不是实现**。

- 文件名与 `package.json` `exports` 子路径一一对应，导出集冻结（`#159` 决议）；改名或新增
  子路径属于破冰，另起票。
- 壳只做三件事：`export { … } from '域/实现.js'`、`export type { … }`、本壳自己的公开类型
  （类型留壳、实现只向下依赖**值**，用来断循环；实现 `import type` 引用壳的纯类型上行是
  允许的既有写法，如 `src/panel/mount.ts` 引 `../panel.js`）。
- 壳里零逻辑：10 个壳全部 0 个顶层 `function`/`const`/`class` 定义（`Select-String` 实测），
  最长 273 行的 `src/panel.ts` 里也只有类型与 re-export。
- 改壳 = 只改导出清单。实现搬家时壳保持导出集不变，`tests/*.test.mjs` 深引 `../dist/*.js`
  才不用跟着改。
- 特例：`src/log/index.ts` 面向 Node 侧日志集成方，自己就带 `node:` 传递依赖；浏览器闭包
  不许从它进，走 `log/client-queue.ts` 与 `log/panel-client.ts`（`tests/log-kernel.test.mjs` 守这条）。

## 链路图

### 日志内核（宿主侧唯一发射口）

```
业务域发射点（见下）
  emitUpdateLog(level, event, fields, { pluginId })        src/log/emit.ts:339
    ├─ 取当前清单/边沿判定   currentUpdateEventTable()      src/log/manifest.ts:44
    ├─ 字段级裁剪+降级计数   pruneEventFields(...)          src/core/gate.ts:352
    │                        调用点                          src/log/emit.ts:261
    ├─ 找落点（按 pluginId） updateLogRouter.resolve(id)     src/log/router.ts:56
    │                        发射口内                      src/log/emit.ts:238
    ├─ 脱敏 + 边沿指纹       sanitizeLogFields/fieldFingerprint
    │                                                        src/log/emit.ts:99 / :133
    └─ 写一行                sink.fire(level,event,fields)   src/log/sink.ts:27
                             写行入口                        src/log/emit.ts:144
落盘（自建 dsh-log 实例）:  acquireOwnLog                        src/log/registry.ts:186
接线（宿主上电时）      :  wireUpdateLog                        src/host/factory.ts:193
                            acquireOwnLog 调用                   src/host/factory.ts:234
                            updateLogRouter.bind/unbind          src/host/factory.ts:216 / :231 / :253
清单真源                :  event-list.update.json（27 事件；顶层 fieldEnums）
人读目录                :  npm run docs:log → docs/research/20261014-log-event-catalog.md §1/§2
```

发射点 = 调 `emitUpdateLog` 的地方，或经注入的 `UpdateLogPort` 发的地方（端口在宿主侧绑：
单插件 `src/host/capabilities.ts:193`，批量 `src/host/batch/log.ts:38`）：

- 单插件宿主：`src/host/factory.ts`（:226/:241/:249/:258/:320/:357/:525/:626/:637）、`src/host/phones.ts:167`、`:322`
- 批量宿主：`src/host/batch/log.ts:21`（`emitBatchLog`）、`:38`（`pluginLogPort`）
- 自监控：`src/log/emit.ts` 的降级行走 `writeRow`（`update.log.degraded`）
- 客户端：面板侧 `logClient(...)`，事件必须在 `CLIENT_LOG_EVENTS`（`src/log/client-queue.ts:105`）白名单里

### 客户端日志（面板 → `<prefix>.logAppend` → 宿主发射口）

```
mountUpdatePanel        src/panel/mount.ts:147              （日志壳创建 :162）
mountUpdateBatchPanel   src/panel/batch/mount.ts:237        （日志壳创建 :254，电话名 :260）
  └─ createPanelClientLogShell                 src/log/panel-client.ts:59
       （挂载校验 / 渲染失败 / 轮询失败 / 全局兜底，去重与降级计数都在壳里）
     └─ createClientLogChannel                 src/log/client-queue.ts:174
          （攒批、退避重试、丢弃计数；白名单 CLIENT_LOG_EVENTS:105）
        └─ 呼叫 <prefix>.logAppend（名字由 buildLogAppendPhoneName 派生）
                                   src/shared/config.ts:178
宿主收口：handler src/host/factory.ts:675 → logAppendRows src/host/factory.ts:576
          → 白名单 isClientLogEvent src/log/client-queue.ts:123 → emitUpdateLog
批量宿主把 <批量前缀>.logAppend 转发给属主：src/host/batch/fan-out.ts:1107–1111
```

### 电话（宿主侧分发 → 域实现）

```
接入方（宿主插件 / HTTP 侧 / 面板直挂）
├─ 单插件 createHostUpdate                     src/host/factory.ts:270
│   ├─ 电话名 buildPhoneNames                   src/shared/config.ts:165
│   ├─ handlers 表（6 通：3 主 + changelog + fallback + logAppend）
│   │                                            src/host/factory.ts:649（logAppend :675）
│   └─ loggedPhone 包一层 → host.call / host.call.fail
│                                                src/host/phones.ts:124
│       └─ 域实现：src/core/service.ts（决策）→ src/core/reader.ts（读本机）
│                 → src/core/disk.ts / src/core/executor.ts（跑腿）
├─ 批量 createMultiHostUpdate                   src/host/batch/fan-out.ts:152
│   ├─ phone() 电话外壳                          src/host/batch/fan-out.ts:1067
│   ├─ handlers（7 通批量电话）                  src/host/batch/fan-out.ts:1087–1094
│   ├─ 每目标一份 createHostUpdate（不同前缀、同一使用范围）
│   ├─ 会话账本 src/core/batch/model.ts:128；驱动器 src/core/batch/run.ts:180
│   └─ 日志接缝 createBatchLogSeams              src/host/batch/log.ts:77
│        （挂接 fan-out.ts:299；pluginLogPort :38 给队列端口，队列行落动作方目录）
├─ 队列端口 createUpdateQueuePorts               src/core/queue/ports.ts:166
│   （logFor 由 src/host/capabilities.ts:193 logPortFor 绑定；锁与失败码在 src/core/store-base.ts）
└─ HTTP 插头 createHttpCall                     src/host/http.ts:231
    （动作表 :30 单 / :34 批量；三个直挂 :346 / :379 / :411）
```

## 地标表

| 我要找什么 | 去哪 |
| --- | --- |
| 错误码真源（阻塞/电话/内部） | `src/shared/codes.ts`：`PHONE_FAILURE_CODES`（:44）、`STABLE_CODES`（:75）、`CORE_ERROR_CODES`（:78） |
| 电话名拼法 / 前缀 | `src/shared/config.ts`：`buildPhoneNames`（:165）、`buildLogAppendPhoneName`（:178）、`PhoneNames`（:161） |
| diag 证据构造 | `src/shared/diag.ts`：`buildDiag`（:394）；HTTP 侧收窄 `pickHttpDiag`（`src/host/http.ts:159`） |
| 读 diag 的容错解析 | `src/shared/copy.ts`：`readDiagTolerant`（:317） |
| 面板文案族（阻塞/失败/诊断复制） | `src/shared/copy.ts`：`blockedCopy`（:44）、`failureCopy`（:90）、`buildUpdateDiagCopy`（:513） |
| 双语文案字典 + 渲染 | `src/core/i18n/dictionary.ts`：`BILINGUAL_STRINGS`（:452）；`src/core/i18n/text.ts`：`copyText`（:42）/`copyHTML`（:52） |
| 面板渲染（HTML） | `src/panel/render.ts`：`renderUpdatePanelHTML`（:1119）；主题 `src/panel/theme.ts:11` |
| 面板该画什么（视图判定） | `src/panel/view-model.ts`：`panelViewModel`（:106）、`checkPrejudgeOfView`（:403） |
| 面板挂载 / 轮询 / 动作分发 | `src/panel/mount.ts`：`mountUpdatePanel`（:147） |
| 批量面板 | 挂载 `src/panel/batch/mount.ts:237`；渲染 `src/panel/batch/render.ts:104`；总账 `src/panel/batch/ledger.ts`；底座 `src/panel/batch/helpers.ts` |
| 入口件 / 批量入口件 | `src/panel/entry.ts:365` / `src/panel/batch/entry-batch.ts:347` |
| 槽位安装按钮 | `src/core/install-button/`：`mount.ts:89`、`view.ts:48`、`render.ts:18`、`styles.ts`、`widgets.ts` |
| 宿主电话装配 | `src/host/factory.ts:270`（`createHostUpdate`）、`:649`（handlers）；电话日志 `src/host/phones.ts:124` |
| 批量宿主 / 批内电话语义 | `src/host/batch/fan-out.ts:152`；`src/host/batch/phones.ts`：`validateTargets:89`、`callPhone:197`、`defaultCheck:245`、`defaultInstall:315` |
| 批量账本 / 驱动 | `src/core/batch/model.ts:128`（`createBatchSession`）、`src/core/batch/run.ts:180`（`runBatch`） |
| 更新中枢（方案/租约/泵/换代/关停） | 契约 `src/host/hub/protocol.ts`（`HubSeat`，含接手续跑用的 `takeOver`）；异常边界 `src/host/hub/boundary.ts`；协议换代的版本限定 Symbol 与旧代清单 `src/host/hub/handoff.ts`；泵与任务表 `src/host/hub/registry.ts`（`submitHubTask` / `shutdownHubScope` / `releaseHubLeasesOnExit`）；孤儿接管 `src/host/hub/adopt.ts`；纯逻辑 `src/core/hub/` |
| 队列 / 锁 / 磁盘 | 队列 `src/core/queue/ports.ts:166` + `src/core/queue/model.ts`；锁与稳定失败码 `src/core/store-base.ts:256`；磁盘端口 `src/core/disk.ts:122` |
| changelog 解析 / 渲染 / 校验 | `src/core/changelog/parse.ts:538`（`parseChangelogReport`）、`render-model.ts:587`（`renderChangelogHTML`）、`validator.ts:68`、Node 读取 `io.ts:325` |
| 日志清单真源 | `event-list.update.json` + 加载器 `src/log/manifest.ts:72`（`loadUpdateEventTable`） |
| 日志发射口 | `src/log/emit.ts:339`（`emitUpdateLog`）、`:332`（`updateLogEmitter`） |
| 日志契约裁剪 | `src/core/gate.ts:352`（`pruneEventFields`）、`:392`（`lintEventList`） |
| 日志目录 / 命名空间 / 健康 | `src/log/namespace.ts`、`src/log/health.ts:161`（`buildUpdateLogHealth`）、落点目录 `src/host/environment.ts:239` |
| 客户端日志通道 / 面板日志壳 | `src/log/client-queue.ts`（`CLIENT_LOG_EVENTS:105`、`createClientLogChannel:174`）、`src/log/panel-client.ts:59` |
| 自更新检测（这份包是谁、哪一层） | `src/shared/self.ts`：`selfCopyLevelOf`（:38）、`selfCopyInfo`（:51） |
| HTTP 插头与路由 | `src/host/http.ts:231`（`createHttpCall`）；环境探测 `src/host/environment.ts:109` |
| 手动手令 / 无命令原因 | `src/shared/commands.ts:256`（`manualCommand`）、`src/shared/manual-absent.ts` |
| 最后手段判定 | `src/shared/last-resort.ts`（三处渲染点共用的唯一口径） |
| 失败任务是否已了结（#245 第三态） | `src/shared/failure-settled.ts`：`failureSettledOf`（唯一判据，消费方只问它、不各写版本比较） |

## 改一个日志事件：三处 + 生成目录

ADR-0006 的纪律：**新增字段/枚举要改三处，机械门禁兜底**。

1. **发射点**：在对应域实现里发（宿主侧 `emitUpdateLog`；store/queue/disk/executor 经注入的
   `UpdateLogPort`；客户端走 `logClient(...)` 且事件必须在 `CLIENT_LOG_EVENTS` 白名单里）。
   只在业务发生处发，不为凑日志新增状态。
2. **契约清单**：`event-list.update.json`。事件条目的 `fields` 加字段名；枚举值成组写进**顶层**
   `fieldEnums`（不要塞进条目里）；常驻事件把「一行一条」的口径写进 `guard`。条目只许
   `level/kind/fields/codes/rules/guard` 六个键（dsh-log 0.3.4 对未知键整份拒收）。
3. **负向断言测试**：`tests/log-contract.test.mjs` 的 `makeEmitter`（:72）样板；dev 模式用
   `mode:'throw'`（:197）让表外字段/事件直接炸。表外值必须被摘字段且整行仍落。
4. **人读目录（生成产物，不算手改点）**：`docs/research/20261014-log-event-catalog.md` 的 §1 常驻
   表（:20）与 §2 按需表（:41）。跑 `npm run docs:log` 让事件/级别/字段三列跟清单走，
   「说明与脱敏」列逐字保留；`npm run docs:log:check` 只查不写。

改完按序跑：

```
npm run typecheck
npm run test:batch
npm run docs:log:check
npm run check          # typecheck + build + 全量 + 双语门禁
npm run smoke:log      # 端到端：只打真 dist，6 场景 PASS/PASSED
```

## 常见改动路线

| 改动 | 先读 | 改哪几个文件 | 验证 |
| --- | --- | --- | --- |
| 改用户文案（面板/入口/按钮） | `src/core/i18n/dictionary.ts`（文案源）、`src/shared/copy.ts`（码 → 文案映射） | `dictionary.ts`：key 不改、只改值；必要时 `src/shared/copy.ts` 的映射 | `npm run gate:bilingual`；基线/快照变动须在评审里看见，然后 `npm run check` |
| 加/改错误码 | `src/shared/codes.ts`（唯一真源，类型由数组派生） | `src/shared/codes.ts` + `src/core/i18n/dictionary.ts` + `src/shared/copy.ts` 的码型穷尽映射 | `npm run typecheck && npm run gate:bilingual && npm run check` |
| 改面板渲染 | `src/panel/view-model.ts`（先决定画什么，再画）、`src/panel/render.ts` | `src/panel/render.ts`（纯 HTML）；样式 `src/panel/theme.ts` / `src/panel/archive-theme.ts` | `npm run check` |
| 改批量行为 | `src/core/batch/model.ts`（相位机）、`src/core/batch/run.ts`（驱动） | 账本/驱动 + 宿主扇出 `src/host/batch/fan-out.ts` + 面板 `src/panel/batch/` | `npm run test:batch`，再 `npm run smoke:log` |
| 改宿主电话（入参/回参/新电话） | `src/host/factory.ts:649`（handlers）、`src/host/phones.ts:124`（`loggedPhone`） | `src/host/factory.ts` / `src/host/phones.ts` / 电话名 `src/shared/config.ts:165`；批量另加 `src/host/batch/` | `npm run typecheck && npm run test:batch && npm run check` |
| 改日志事件 | 本页上节「三处」+ `tests/log-contract.test.mjs` | 发射点 + `event-list.update.json` + 负向断言 | `npm run typecheck && npm run test:batch && npm run docs:log:check && npm run check && npm run smoke:log` |
| 改安装按钮 | `src/core/install-button/view.ts`（状态 → 视图模型）、`render.ts` | `view.ts` / `render.ts` / `styles.ts` / `mount.ts`；壳 `src/install-button.ts` 只同步导出清单 | `npm run check`（安装按钮定向测试在 `tests/install-button.test.mjs`） |
| 改 changelog 解析 / 渲染 | `src/core/changelog/parse.ts`（纯解析，零导入） | `parse.ts` + `render-model.ts` + `validator.ts`；Node 读盘 `io.ts` | `npm run check`（changelog 系列测试） |

## 验证阶梯

| 顺序 | 命令 | 何时用 |
| --- | --- | --- |
| 1 | `npm run typecheck` | 改一行就跑（`tsc -p tsconfig.json`，秒级） |
| 2 | `npm run test:batch` | 碰批量宿主 / 批量面板 / 批量日志接缝（`batch-*`、`panel-batch*`、`entry-batch` 三组） |
| 3 | `npm run check` | 提交前聚合门禁：typecheck + build + `tests/*.test.mjs` 全量 + 双语门禁；**全绿口径** |
| 4 | `npm run smoke:log` | 碰日志端到端与批量落点归属时：先 build，再用真 dist 跑 `scripts/log-smoke.mjs` 六场景 |

补充：

- `npm run build` 单独用：测试 import `dist/`，不 build 测的是旧产物；`check` 与 `smoke:log` 已内含 build。
- `npm run docs:log` 生成事件目录、`npm run docs:log:check` 只查不写，见「改一个日志事件」。
- 契约全绿口径固定为 `npm run check`；批量定向 `npm run test:batch`；端到端日志 `npm run smoke:log`。

## 读代码顺序（约 30 分钟）

1. `package.json` 的 `exports` → 按你要的入口读对应壳（26–273 行，全是导出清单）。
2. `src/host.ts` → `src/host/forwarding.ts`（转发表）→ `src/host/factory.ts:270` 的 `createHostUpdate`
   与 `:649` 的 handlers（宿主能力面）。
3. `src/core/service.ts`（决策骨架）→ `src/core/reader.ts`（本机真相）→ `src/core/disk.ts` /
   `src/core/executor.ts`（跑腿）；日志从 `src/log/emit.ts:339` 往上追。
4. 面板：`src/panel.ts` 壳 → `src/panel/mount.ts:147` → `src/panel/view-model.ts:106` →
   `src/panel/render.ts:1119`。
5. 批量：`src/host-batch.ts` 壳 → `src/host/batch/fan-out.ts:152` → `src/core/batch/model.ts:128` /
   `src/core/batch/run.ts:180` → `src/host/batch/log.ts:77`；行为对照
   `tests/helpers/batch-log-harness.mjs` 与 `scripts/log-smoke.mjs`。

## 常被其它文档引用的门径

| 门径 | 用途 |
| --- | --- |
| `docs/research/20261014-log-event-catalog.md` | 人读事件目录：§1 常驻 / §2 按需，事件/级别/字段三列由 `npm run docs:log` 生成 |
| `tests/helpers/batch-log-harness.mjs` | 批量日志测试共享夹具（bind/collector/rowsOf/fakeTransport/mkTarget/mkScope/seedQueue） |
| `tests/helpers/hub-harness.mjs` | 中枢宿主测试共享夹具（fakeClock/makeHubDeps/waitForPhase/trackUnhandledRejections） |
| `scripts/log-smoke.mjs` | 端到端日志冒烟：真 dist，六场景，`PASS`/`SMOKE PASSED` |
| `tests/log-contract.test.mjs` | 清单与发射口契约（含负断言样板 `makeEmitter`） |
| `tests/gate.test.mjs` | `lintEventList` 与门禁；递归扫 `src/` 全树的依赖纪律 |
| `tests/log-kernel.test.mjs` | 日志内核与浏览器闭包边界 |
| `scripts/panel-layout-probe.mjs` | 弹窗布局量盒子（#93 / #240 契约）：`npm run probe:layout`，需系统 Chrome |
| `src/panel/render.ts` 顶部样式契约注释 | 改弹窗布局/CSS 前先读（#93 高度让渡、弹窗是 flex 列容器、`overflow` 只能落在外层），别只凭肉眼 |
| `scripts/release.mjs` | 一键发版（计划/执行/`--verify` 自检），口径见 `docs/maintainers.md` |
| `npm run check` | 改契约后的聚合验证全绿口径 |
