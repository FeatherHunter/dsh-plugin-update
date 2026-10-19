# 6. 日志行只承载稳定码，人话在渲染层产出

- 状态：accepted
- 日期：2026-10-14
- 关联：本票 [规格定稿](https://github.com/FeatherHunter/dsh-plugin-update/issues/119) · 地图 [本包全面集成 dsh-log 0.3.1](https://github.com/FeatherHunter/dsh-plugin-update/issues/117) · ADR-0001（脱敏边界，尤其 `:92-103` 登记的 README 张力）· ADR-0005 · 事件目录 `docs/research/20261014-log-event-catalog.md` · 调研 `docs/research/20261014-dsh-log-031-api.md`
- 决策来源：用户 2026-10-14 把本图的决策整体授权给执行会话（地图 #117 前提 3）

> 路径注：#220（2026-10-19）重构后 `src/` 已按域分目录、根只留入口壳；本 ADR 内 `src/...` 路径为决策当时位置，对照见 [ADR-0007](0007-src-directory-shape.md) 与[蓝图](../research/20261019-src-restructure-blueprint.md) §3。

## 背景

ADR-0001 把 `detail` 定为「全系统唯一自由文本出口」，并登记了一条它自己答不了的前置张力（`docs/adr/0001-diagnostics-redaction-boundary.md:92-103`）：`README.md:260` 教用户 `message` 形如 `install-failed: <宿主原话>`，而 #5 冻结的是「`diagnostic` 永指宿主脏原文、永不过边界」——真实存在的唯一诊断通道恰恰就是宿主原话。

这次要新增一条**长期留存**的出口（日志文件），张力的量级变了：

- `detail` 是一次性的：面板上闪现、复制时按 1500 字预算收口（`src/redaction.ts:40`）。
- 日志行是留存的：按天落盘、14 天保留、第三方会随手贴进 issue、还可能被 `dsh-log tail` 打印到终端。
- 更要紧的是，日志要能被人**聚合与 grep**：`dsh-opencode-palette` 某天的 934 KB 日志里 5309 行是 `host.call`，这种量级只有稳定码才有用；一句中文人话既不能计数也不能跨版本对齐。

若不在日志出口立规矩，最常见的堕落路径是：图省事把 `detail`（宿主原话经 `sanitizeDetail` 收过一遍）塞进 `fields.message`。那样一来，脱敏边界从「生成属性」退化成「运行时兜一下」，而 ADR-0001 明确不要运行时扫描。

## 决策

### 1. 日志行的 `fields` 只许扁平键值，值只许三类

- 类型：`string | number | boolean | null`，**不嵌套对象、不嵌套数组**（与 dsh-log 五键行的形状对齐）。
- 字符串值只许来自四类：
  1. **版本号**——经中央校验器规范化后的 semver 形状；
  2. **枚举白名单值**——每个枚举在事件清单里逐值声明（例见下 §6 受控 cause 枚举白名单；旧例 `channel` / `outcome` 已被清单真实枚举取代，不再引用）；
  3. **导出量**——`hash8` 短哈希、计数、时长（ms）、字节数、布尔。
  4. **契约标识符**（`#210` 增补）——只用于 `update.log.degraded` 的 `event` / `field` 两格：它们是事件名与字段名这类**清单内的机器标识**，由发射口按 `EVENT_NAME_RE` 与标识符形状收敛，非法值一律打成占位符 `<event>` / `<field>`，绝不承载宿主原文；仅此一处，不得作为自由文本的后门。
- 不允许的字符串：宿主原话、错误 `message`、命令行、文件路径、URL、usage 原文、插件标识原文。

### 2. 人话不进日志行，人话在渲染层产出

- 终端：`dsh-log tail` 用 dsh-log 的 `formatRow`/`formatRows`（0.3.1 起从根入口导出，`dist/cli.js` 同源）。
- 面板：走既有文案源 `src/bilingual.ts`（双语门禁守着），键名按 `area.group.name` 约定。
- 渲染层负责把 `{event, fields}` 变成一句人话；**日志行本身不含人话**。

### 3. 字段白名单是登记制的，未登记就是错的

- 每个事件的字段白名单写进随包的 `event-list.update.json`（W5 产出），并在清单里标 `level` 与 `kind: 'resident' | 'ondemand' | 'selfmon'`。
- 字段允许值的机器声明（`#210`）写在清单**顶层 `fieldEnums`**（事件名 → 字段名 → 允许值数组）：不写进事件条目，因为 dsh-log 0.3.4 对条目未知键整份拒收；顶层未知键它收下不用。
- 发射口 `emitRow()`（W2）按清单校验：开发期未登记字段或非法枚举值**抛**，运行期**摘掉该字段并计数**，计数经 `update.log.degraded` 露出（降级行带 `event` / `field` 两格，按「原因+事件+字段」只记首次；未知事件整行不落盘）。
- 事件名同理：未登记的事件名不落盘，未知事件仍算「整行丢弃」。

### 4. 用负向断言测试当门，不建运行时扫描

按 ADR-0001 规则 5（「产物上做负向断言比任何 grep 门禁都强」）：

- 为每个事件构造样例行，断言序列化结果中**不出现**：绝对路径形状、`scheme://` 形状、令牌形状、`键=值` 凭据形状、邮箱形状（复用 `src/redaction.ts` 的五条规则做判据）。
- 断言 `fields` 的值全是上述四类之一（表驱动，新增字段即新增用例）。
- 断言字段名集合与 `event-list.update.json` 完全一致（多一个少一个都红）。

### 5. README 张力的解法定在日志侧，不改 `detail` 口径

- `message` 仍是宿主原话的**受控**出口（经 `sanitizeDetail`），`diagnostic` 仍永不过边界——ADR-0001 有关 `detail` 的全部口径一个字不改。
- 新增的规矩只针对日志：**同一份宿主原话绝不进日志行**。两个出口从此不重叠：要看人话去面板（或将来由渲染层生成），要聚合去日志。
- 因此 README:260 那处措辞不需要为日志而改；W5 只在 README 新增「日志」一节时说明「日志行里只有稳定码，人话在面板」，把两边的关系写清楚。

### 6. 受控 cause 枚举白名单（`#206` P2-1 增补，2026-10-19）

- 「原因」一律是**闭集枚举**，不是自由文本：任何回答「为什么没成 / 为什么没装 / 谁在占着」的中文字段只许出现在面板渲染与回包 `detail`，日志行里只记下表的稳定码。白名单的唯一事实源是随包 `event-list.update.json` 顶层 `fieldEnums`（事件名 → 字段名 → 允许值数组）；发射口 `emitRow()` 按它校验，非法值运行期摘字段 + `update.log.degraded` 计数（见 §3），开发期抛错。
- HEAD（`18df6d7`）闭集一览：
  - 安装失败：`update.install.fail.stage`（`gate` / `exec` / `verify`）、`reason`（12 值：`host-rejected` / `timeout` / `crashed` / `nonzero-exit` / `spawn-failed` / `terminate-failed` / `version-mismatch` / `not-registered` / `env-blocked` / `noop` / `gate-refused` / `unknown`，无法归类时 `unknown` 照记、不静默）、`code`（回包同一稳定码集 + `none`）、`check`（`version` / `registered` / `env` / `none`）；
  - 检查失败：`update.check.fail.errorKind`（失败类别 10 值：`timeout` / `network` / `dns` / `tls` / `http` / `bad-json` / `too-large` / `shape` / `channel` / `unknown`）；
  - 状态与阻拦：`update.status.changed.blockedReason` / `update.check.done.blockedReason`（12 值，`none` = 没有阻挡）、`unknownCause`（`no-latest` / `running-version-unknown` / `compare-failed`）、`identity`（`update` / `first-install` / `up-to-date` / `unknown`）；
  - 批量：`update.batch.summary.stoppedBecause`（7 值：`finished` / `stopped-after-failure` / `user-cancel` / `error` / `queued` / `max-steps` / `empty`，其中 `max-steps` / `empty` 不发停止行）、`update.batch.entry.fail.stage`（`check` / `install` / `timeout` / `settle`）；
  - 队列与锁：`update.queue.transition.phase`（`queued` / `running` / `done` / `reclaimed` / `pruned` / `abandoned`）、`update.lock.anomaly.kind`（`stale-owner` / `release-failed` / `busy-owner`）；
  - 存储与降级：`update.store.fail` 落点只有 `op` + `dirHash`（目录指纹，无原文）；`update.log.degraded.reason`（12 值：`no-dsh-log` / `lease-conflict` / `write-fail` / `emit-threw` / `unknown-event` / `unknown-field` / `invalid-enum` / `client-batch-refused` / `client-drop-overflow` / `client-drop-host-refused` / `client-drop-send-failed` / `client-drop-disposed`）；
  - 校验与更新说明：`update.install.verify.result`（`completed` / `restart-required` / `failed` / `interrupted`）、`update.changelog.parse.status`（`ok` / `empty` / `missing` / `fetch-failed` / `parse-degraded` / `cache-hit`）；
  - 接线与挂载：`update.wire.ready.logSink`（`external` / `external-unverified` / `self` / `off`，`external-unverified` = 门径没通过的未验证态）、`copyLevel`（`profile` / `nested` / `repo` / `unknown`）、`hostKind`；`update.panel.mount.autoCheck`（`started` / `recent` / `disabled` / `failed`）。
- 客户端动作名（`update.panel.action.action` 14 值，`src/panel.ts:211-225`）暂未收进 `fieldEnums`：它是面板 `data-action` 的闭集（代码侧逐字对应），不是日志聚合键；若将来进清单，按本 ADR「改三处」（发射点、事件清单、负向断言）同步。

## 反向范围

- 不改 `detail` / `diagnostic` 的现有口径与脱敏规则（ADR-0001 不动）。
- 不建运行时字段扫描、完备性检查或 grep 门禁。
- 不为「按需事件」新建自由文本字段。
- 不在本 ADR 处理 W5 的 README 文档面（只定原则，落字在 W5）。

## 后果

- 正面：日志可聚合、可跨版本对齐、可长期留存；宿主原话的留存面没被扩大；ADR-0001 的张力在日志侧被绕开而不是被稀释。
- 正面（次生）：新增事件必须同时登记字段，逼迫「环节 → 事件 → 字段」在规格阶段想清楚，这与本图 W1 的事件目录同构。
- 代价：人话要在两条渲染路径各实现一次（命令行与面板），且**新增一个字段要改三处**（发射点、事件清单、负向断言用例）。这是自觉取舍：用写三处换「日志行永不夹带文本」。
- 代价：`fields` 里出现需要人读的细节时（如错误原因），只能给稳定码 + hash8，排查细节要去面板的 `detail` 或工具返回的 `steps[]`。这是有意为之的边界，不是遗漏。
- 回退线：若实测发现某类问题只能靠文本才能查（例如宿主 exit code 之外的诊断），走破冰新增**一个具名字段**（而不是放开任意文本），并同步事件清单与负向断言。
