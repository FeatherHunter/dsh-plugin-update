# dsh-plugin-update 日志/诊断/打印现状盘点

- 盘点对象：`D:\dsh-plugin\dsh-plugin-update`（npm 包 `dsh-plugin-update@0.14.0`，`package.json:3`）
- 盘点时间：2026-10-14
- 方法：只读代码，逐条 `文件路径:行号` + 关键代码原文；未运行 build/test，未改动任何其它文件
- 背景意图：准备集成 dsh-log 0.3.1 作为统一日志系统，要求（a）每个环节关键信息都能打印，（b）同一 DSH 宿主里多个使用本更新系统的插件日志不互相覆盖
- 标注约定：`src/` 是一手源码；凡引用 `dist/` 的会显式写「（构建产物）」

---

## TL;DR

1. **`src/` 下零 `console.*`、零 `process.stdout/stderr.write`。** 全仓打印只发生在 `build.mjs`（构建脚本）与最终用户的终端提示里；运行时唯一的"打印"是**注入回调** `logCtx.fire`。
2. **现有日志能力只有 3 个事件、4 个发射点。** 事件名单源在 `src/log-events.ts:8-10`：`host.call` / `host.call.fail` / `update.install.exec`；发射点在 `src/host.ts:719`、`src/host.ts:733`、`src/host.ts:823`、`src/host.ts:827`、`src/store.ts:936`。
3. **日志出口是「第二参数注入」而非 ctx。** `createHostUpdate(deps, configInput)`（`src/host.ts:864`）的 `deps.logCtx` 是全包唯一日志入口；`ctx` 只被读 `subprocess` / `desktopProfiles` / `pluginManager` 三个服务（`src/host.ts:206`、`src/host.ts:534-537`），**ctx 里没有任何 logger 能力可借用**。
4. **`logCtx` 落进一个模块级可变单例 `phoneLogCtx`（`src/host.ts:671`），赋值是 last-writer-wins 且从不复位**（`src/host.ts:867` `phoneLogCtx = deps.logCtx ?? phoneLogCtx`）。这是「多插件日志互相覆盖」的**首要真实发生路径**，见第 5、8 节。
5. **不落任何日志文件。** 全包没有任何 `.log` 文件写入（`appendFile` / `writeFile(...log...)` 零命中）；落盘只有 `state.json` / `install.lock` / `before.json` / `queue.json` / `global.lock` / `batch.json` / `inventory.json` / `prefs.json` / `skipped.json`。
6. **Node 侧 5 个文件、客户端侧 21 个文件**，分界判据是 `import ... from 'node:'`。Node 侧 = `host.ts` / `host-batch.ts` / `store.ts` / `reader.ts` / `changelog-io.ts`；dsh-log 若只能在 Node 侧用，**面板打开、自动检查、用户点击、渲染、复制诊断全部环节都打不了日志**。
7. **失败证据 `diag` 是 16 键结构化对象**（`src/diag.ts:59-77`），随失败电话回包内联返回，序列化墙 1024 字节（`src/redaction.ts:47`），构造全程 best-effort（失败即省略 `diag`，`src/host.ts:755-757`）。
8. **脱敏是「构造属性」不是事后过滤**（ADR `docs/adr/0001-diagnostics-redaction-boundary.md:18-24`）：`detail` 是全系统唯一自由文本字段、只有一个产出口（`src/redaction.ts:193` `sanitizeDetail`）；五条具名规则 `R_ABSOLUTE_PATH` / `R_URL_USERINFO` / `R_TOKEN` / `R_CRED_PAIR` / `R_EMAIL`（`src/redaction.ts:64-70`），两占位符 `<路径>` / `<脱敏>`（`src/redaction.ts:50-51`）。绝对路径、URL 账号密码、令牌、凭据键值对、邮箱**绝对不能进日志**。
9. **安装执行是唯一"有据可查"的环节**：`update.install.exec` 带 5 键 `route` / `ok` / `exitCode` / `durationMs` / `pluginId`（`src/store.ts:936-942`），且**明确不记命令、路径、使用范围名原文**（`src/store.ts:923`）。
10. **批量链路（队列两阶段 / 单项失败 / 总账 / 续跑）零日志。** `runBatch` 只把过程写进返回的 `steps` 数组与落盘会话（`src/batch-run.ts:91`、`src/batch-run.ts:124/130/135/141/156/161/168`），没有任何 `logCtx` 出口。
11. **新增中文日志文案会撞双语文案门禁。** `scripts/bilingual-gate.mjs` 规定 `src/` 下中文字符串字面量只许出现在 `src/bilingual.ts`（`scripts/bilingual-gate.mjs:45` `COPY_SOURCE_FILES = ['src/bilingual.ts']`），其余位置按冻结基线 `tests/fixtures/bilingual/copy-baseline.json` 逐条放行、**只许减不许增**。
12. **真正守日志字段基线的是测试不是 `gate.ts`。** `src/gate.ts` 是给第二家自查的纯函数尺子（`src/gate.ts:43` 自陈「不是门禁…不被任何生产代码调用」）；逐字键集断言在 `tests/phones.test.mjs:222`、`tests/phones.test.mjs:232`、`tests/routes.test.mjs:106`。

---

## 1. 代码结构与对外入口

### 1.1 每个 `src/` 文件的职责（引用各文件自陈的一行）

| 文件 | 行数 | 职责（文件自陈） | 侧 |
| --- | --- | --- | --- |
| `src/config.ts` | 159 | 更新包的公共配置面（规格 #591 的字面落实） | 中立 |
| `src/ports.ts` | 224 | 更新模块的插口定义 | 中立 |
| `src/service.ts` | 636 | 更新核心（版本比较/通道判定/registry 查询/状态机） | 中立 |
| `src/reader.ts` | 354 | 把本机真实情况翻译成更新核心要的零件（读取器） | **Node** |
| `src/store.ts` | 1138 | 更新任务的落盘与执行跑腿 | **Node** |
| `src/commands.ts` | 201 | 安装配方与手工兜底命令 | 中立 |
| `src/queue.ts` | 296 | 跨插件单队列串行的纯决策 | 中立 |
| `src/batch.ts` | 281 | 多目标批量更新的会话账本 | 中立 |
| `src/batch-run.ts` | 164 | 批量更新的串行驱动器 | 中立 |
| `src/changelog.ts` | 904 | 包内 `CHANGELOG.md` 的纯解析与面板渲染 | 中立 |
| `src/changelog-io.ts` | 336 | 更新日志的 Node 侧读写 | **Node** |
| `src/redaction.ts` | 329 | 失败详情脱敏规则表 | 中立 |
| `src/diag.ts` | 361 | 电话侧失败证据 `diag` 落地 | 中立 |
| `src/bilingual.ts` | 746 | 集中文案底座与单语语义块渲染 | 中立 |
| `src/lang.ts` | 203 | 语言信号层 | 中立（读 `globalThis`） |
| `src/log-events.ts` | 10 | 日志事件名（单源） | 中立（零导入） |
| `src/gate.ts` | 206 | 事件清单模板检查器（纯函数尺子） | 中立 |
| `src/host.ts` | 1034 | 更新包的宿主入口 | **Node** |
| `src/host-batch.ts` | 1194 | 多目标批量更新的宿主入口 | **Node** |
| `src/panel.ts` | 2876 | 现成整组件（面板） | 客户端 |
| `src/panel-batch.ts` | 2223 | 多目标批量更新的面板组件 | 客户端 |
| `src/entry.ts` | 684 | 更新入口件：按钮/徽标/内嵌三态 | 客户端 |
| `src/entry-batch.ts` | 635 | 批量感知的更新入口件 | 客户端 |
| `src/client.ts` | 87 | 更新包的客户端入口（构建期派生用） | 客户端 |
| `src/http.ts` | 382 | HTTP 万能插头传输 | 客户端 |
| `src/node-ambient.d.ts` | 72 | Node 环境类型补充 | 类型 |
| `src/runtime.d.ts` | 22 | 核心允许触碰的通用运行时形状 | 类型 |

证据：`src/store.ts:2`、`src/config.ts:1`、`src/ports.ts:2`、`src/reader.ts:2`、`src/commands.ts`（`installRecipe`/`manualCommand`）、`src/queue.ts:1`、`src/batch.ts:1`、`src/batch-run.ts:1`、`src/changelog.ts:2`、`src/changelog-io.ts:2`、`src/redaction.ts:2`、`src/diag.ts:2`、`src/bilingual.ts:1`、`src/lang.ts:1`、`src/log-events.ts:2`、`src/gate.ts:1`、`src/host.ts:1`、`src/host-batch.ts:1`、`src/panel.ts:1`、`src/panel-batch.ts:1`、`src/entry.ts:1`、`src/entry-batch.ts:1`、`src/client.ts:1`、`src/http.ts:1`、`src/runtime.d.ts:1-7`。

### 1.2 `package.json` exports → dist 产物 → 源码入口

`package.json:16-50`，`types` 与 `default` 成对：

| 子路径 | dist 产物 | 源码入口 | 侧 |
| --- | --- | --- | --- |
| `.` | `dist/host.js` / `dist/host.d.ts` | `src/host.ts` | **Node** |
| `./panel` | `dist/panel.js` / `dist/panel.d.ts` | `src/panel.ts` | 客户端 |
| `./client` | `dist/client.js` / `dist/client.d.ts` | `src/client.ts` | 客户端 |
| `./batch` | `dist/host-batch.js` / `dist/host-batch.d.ts` | `src/host-batch.ts` | **Node** |
| `./panel-batch` | `dist/panel-batch.js` / `dist/panel-batch.d.ts` | `src/panel-batch.ts` | 客户端 |
| `./entry` | `dist/entry.js` / `dist/entry.d.ts` | `src/entry.ts` | 客户端 |
| `./entry-batch` | `dist/entry-batch.js` / `dist/entry-batch.d.ts` | `src/entry-batch.ts` | 客户端 |
| `./http` | `dist/http.js` / `dist/http.d.ts` | `src/http.ts` | 客户端 |

证据：`package.json:16-50`。构建为**一对一转译、不打包**：`src/X.ts` → `dist/X.js`（`build.mjs:22-48`、`build.mjs:115-120`），另跑 `tsc` 只产 `.d.ts`（`build.mjs:87-110`）。**注意：`src/queue.ts` / `src/batch.ts` / `src/batch-run.ts` / `src/diag.ts` / `src/redaction.ts` / `src/changelog.ts` 等没有独立 exports 子路径**，它们只能经上表某个入口转出口到达。

### 1.3 Node 侧 vs 客户端侧（对 dsh-log 集成最关键的一节）

**判据**：`import ... from 'node:'` 命中即 Node 专属。全仓仅 5 个文件命中：

- `src/store.ts:20-22` — `node:crypto`、`node:fs/promises`、`node:path`
- `src/host.ts:14-16` — `node:fs/promises`、`node:os`、`node:path`
- `src/host-batch.ts:36` — `node:os`
- `src/changelog-io.ts:19-22` — `node:fs/promises`、`node:path`、`node:crypto`、`node:zlib`
- `src/reader.ts:11-16` — `node:crypto`、`node:fs/promises`、`node:module`、`node:os`、`node:path`、`node:url`

其余 22 个 `.ts` 文件**不含任何 `node:` 导入**，可进浏览器闭包。设计意图在 `src/runtime.d.ts:4-6` 明文：「只有 Node 宿主与浏览器闭包两边都有的能力才允许出现在这里；Node 专属（如 fs、子进程）与浏览器专属一律不加，加了就是破保证。」

**结论（对 dsh-log 集成的直接约束）**：dsh-log 若只能在 Node 侧使用，则下列环节**在 client 侧根本打不了日志**（它们的宿主函数与执行体都在客户端文件里）：

| 客户端文件（行号） | 该文件里打不了日志的环节 |
| --- | --- |
| `src/panel.ts:1999` `mountUpdatePanel` | 面板挂载/打开 |
| `src/panel.ts:1981` `pendingAutoCheck` | 自动检查更新的判定 |
| `src/panel.ts:2760` `case 'restart-hint'` | 重启宿主（面板侧触发） |
| `src/panel.ts:450` `buildDiagnosticText`、`src/panel.ts:592` `buildUpdateDiagCopy` | 复制诊断成文本 |
| `src/panel.ts:1533` `renderUpdatePanelKernel`、`src/panel.ts:1847` `renderUpdatePanelHTML` | 主题渲染 |
| `src/entry.ts:351` `mountUpdateEntry` | 入口件按钮（配置页那颗） |
| `src/entry-batch.ts:308` `mountUpdateBatchEntry` | 批量入口件 |
| `src/panel-batch.ts:1533` `mountUpdateBatchPanel` | 批量面板挂载 |
| `src/panel-batch.ts:242` `batchLedgerCounts`、`src/panel-batch.ts:283` `batchLedgerText` | 总账渲染 |
| `src/lang.ts:80` `resolveLang` | 语言选择 |
| `src/http.ts:230` `createHttpCall` | HTTP 传输封装 |

对照：`src/panel.ts:14` 自陈「DOM 与剪贴板只在 `mountUpdatePanel` 被调用时经 `globalThis` 现取，模块顶层不碰」；`src/entry-batch.ts:35`、`src/panel-batch.ts:34` 同口径。**面板侧不存在任何日志出口**——`src/client.ts:19` 明文自陈：「未新增日志事件：本文件不发日志，三个旧事件的标识字段由宿主入口发出。」

---

## 2. 现有"打印"手段全量

### 2.1 `src/` 下：零 `console.*`、零 `process.stdout/stderr.write`

- 在 `src/` 下搜 `console\.(log|error|warn|info|debug|trace)`：**零命中**
- 全仓 `.ts` 搜 `process\.(stdout|stderr)`：**零命中**

**结论：打印不在 `src/` 里发生。** 真实情况分三处：

#### (a) 构建脚本（不是运行时，也不是宿主）

| 文件:行号 | 打印内容 | 触发场景 |
| --- | --- | --- |
| `build.mjs:82` | `console.log('[dsh-plugin-update] tsc --noEmit 通过')` | `npm run build` 类型检查通过 |
| `build.mjs:109` | `console.log('[dsh-plugin-update] .d.ts 声明已产出 dist/')` | 声明产出成功 |
| `build.mjs:119` | ``console.log(`[dsh-plugin-update] ${u.ts} -> dist/${u.js}（${text.split('\n').length} 行）`)`` | 每个 src 文件转译完成（24 行） |
| `build.mjs:129` | `console.error((e && e.message) \|\| e)` | `main()` 抛错，随后 `process.exit(1)`（`build.mjs:130`） |

#### (b) 运行时唯一的打印通路：`logCtx.fire` 注入回调

`createHostUpdate` 的 `deps.logCtx` 形状（`src/host.ts:670`）：

```ts
type LogCtx = { fire: (level: string, event: string, fields: Record<string, unknown>) => void } | null
```

四个发射点，**全部包在 `try {} catch {}` 里**（日志故障绝不冒泡）：

| 文件:行号 | 事件名（level） | 打印内容（键集） | 触发场景 |
| --- | --- | --- | --- |
| `src/host.ts:719` | `host.call`（info） | `{ method, latencyMs, ok: true, kind, pluginId }` | 任一电话成功返回 |
| `src/host.ts:733` | `host.call.fail`（warn） | `{ method, kind, errorHash, pluginId }` | 任一电话抛错 |
| `src/host.ts:823` | `host.call`（info） | `{ method, latencyMs, ok: true, kind: 'update-changelog', pluginId }` | 更新日志电话成功 |
| `src/host.ts:827` | `host.call.fail`（warn） | `{ method, kind: 'update-changelog', errorHash, pluginId }` | 更新日志电话失败 |
| `src/store.ts:936` | `update.install.exec`（info） | `{ route, ok, exitCode, durationMs, pluginId }` | 安装执行跨边界调用后（成功或失败各一次） |

`errorHash` 是 `hash8(String(error.message || payload.error))`（`src/host.ts:733`、`src/host.ts:827`）——**失败原文不进日志，只进 8 位散列**。

安装执行发射点上下文（`src/store.ts:1191-1207`）：

```ts
    const startedAt = Date.now()
    let exitCode: number | null = null
    try {
      if (!recipe) throw fail('install-failed')
      const runner = INSTALL_RUNNERS[recipe.route] ?? null
      if (!runner) throw fail('install-failed')
      exitCode = await runner(recipe, parts)
      emitInstall(parts, recipe, true, exitCode, Date.now() - startedAt)
    } catch (error) {
      emitInstall(parts, recipe, false, (error as { exitCode?: number })?.exitCode ?? exitCode, Date.now() - startedAt)
```

`emitInstall` 的构造（`src/store.ts:925-944`）与**明文禁令**（`src/store.ts:922-923`）：

```ts
/**
 * 记一行安装执行的跨边界调用与结果（常驻事件，低频，只记路由与退出事实加插件标识）。
 * 日志里只记枚举与数字，不记命令、路径、使用范围名原文。
 */
```

#### (c) 用户可见文本（不是日志，但它是"关键信息回给第三方"的现成载体）

| 文件:行号 | 内容 | 场景 |
| --- | --- | --- |
| `src/panel.ts:450` `buildDiagnosticText` → `src/panel.ts:632` | `` `[update-diag] code=${rawCode} · ${copy.zh} · … · ${provLine} · …` `` | 点「复制诊断」 |
| `src/panel.ts:592` `buildUpdateDiagCopy` → `src/panel.ts:638-640` | 三行块：`摘要:` / `来源:` / `怎么办:` | 复制诊断（块形态） |
| `src/panel.ts:1799-1816` | 面板第 04 章「路牌」：渲染三个事件名与 `pluginId`，教用户去日志里按事件名过滤 | 面板失败页常态 |
| `src/commands.ts:189` `manualCommand` | 手工兜底命令字符串 | 自动装失败时给用户 |

面板路牌的原文出处（`src/panel.ts:1799-1806`）：

```ts
    if ((input as { showLogHint?: unknown }).showLogHint !== false) {
      errLines.push(
        `<div class="dsh-upd-log">${copyText('panel.error.log-hint', l, {
          pluginId: `<code>${escapeHtml(pluginId)}</code>`,
          e1: `<code>${LOG_EVENT_CALL}</code>`,
          e2: `<code>${LOG_EVENT_CALL_FAIL}</code>`,
          e3: `<code>${LOG_EVENT_INSTALL_EXEC}</code>`,
        })}</div>`,
      )
```

### 2.2 `throw` 作为事实上的"错误出口"

全包大量用 `throw` + 稳定码（`Object.assign(new Error(code), { code })`）而非打印。集中构造点：

- `src/store.ts:40-42` — `function fail(code: string): Error & { code: string }`
- `src/service.ts:53` — `export function updateError(code: UpdateErrorCode): Error & { code: UpdateErrorCode }`
- `src/queue.ts:277-281` — `queueFail()` → `'queue-unavailable'`
- `src/host.ts:688-694` — `checkExpiredError()` / `updateBusyError()`
- `src/store.ts:979-982` — `withDetail(error, detail)`
- `src/store.ts:990-1013` — `detailText(error)`（宿主原话经 `sanitizeDetail` 收口，是唯一自由文本通道）

稳定码表（14 个，`src/host.ts:585-600`）：`check-failed` / `invalid-release` / `check-expired` / `update-busy` / `install-failed` / `unknown-profile` / `channel-mismatch` / `source-install` / `invalid-installation` / `installation-changed` / `pending-restart` / `incompatible-node` / `registry-conflict` / `recovery-required`；未命中收敛为 `{ error: 'check-failed', errorKind: 'internal' }`（`src/host.ts:602`）。

### 2.3 自建 logger / `log(` / `debug(` / `trace(` 辅助函数

**没有**。全仓只有一个内部函数 `emitInstall`（`src/store.ts:925`），两个内联 `emit` 闭包（`src/host.ts:708`、`src/host.ts:815`）与一个 `emitInstallLog`（`src/host.ts:674`）。三者做的事完全相同：把参数转交 `phoneLogCtx.fire`，吞掉一切异常。

```ts
function emitInstallLog(level: string, event: string, fields: Record<string, unknown>): void {
  try {
    if (phoneLogCtx && typeof phoneLogCtx.fire === 'function') phoneLogCtx.fire(level, event, fields)
  } catch {}
}
```
（`src/host.ts:673-678`；`src/host.ts:708-712` 与 `src/host.ts:815-819` 是逐字同形的内联版本）

---

## 3. 诊断/失败证据（diag）现状

### 3.1 `diag` 数据结构：16 键目录，线键永不改名

`src/diag.ts:59-77`：

```ts
export const DIAG_KNOWN_TYPES: Record<string, 'number' | 'string'> = {
  v: 'number', stage: 'string', route: 'string', method: 'string',
  httpStatus: 'number', exitCode: 'number', latencyMs: 'number', detail: 'string',
  targetPackageName: 'string', runningVersion: 'string', latestVersion: 'string',
  environmentKind: 'string', requestId: 'string', checkId: 'string',
  registryHost: 'string', action: 'string',
}
export const DIAG_KEYS = Object.keys(DIAG_KNOWN_TYPES)
```

- 对象版本 `DIAG_VERSION = 1`（`src/diag.ts:41`），**面板永不分支于版本**（`src/diag.ts:24`）
- 阶段枚举冻结 6 值（`src/diag.ts:44-51`）：`read-installed` / `fetch-release` / `validate-release` / `preflight` / `exec` / `verify`
- 动作提示冻结 4 值（`src/diag.ts:55`）：`retry` / `manual` / `contact` / `restart`
- （阶段 × 键）期望表 `DIAG_STAGE_EXPECT`（`src/diag.ts:80-87`）
- `queuePos` **永不产出**（`src/diag.ts:14-15` 声明为保留未来键）

### 3.2 构造点与填充路径

构造入口 `buildDiag(input: DiagInput): DiagObject | undefined`（`src/diag.ts:313`），两个调用点都在电话包装层：

- `src/host.ts:742-753`（`loggedPhone` 的 catch 分支）
- `src/host.ts:834-845`（`loggedChangelogPhone` 的 catch 分支）

填充的输入（`src/host.ts:742-753`）：`errorCode`（已收敛的稳定码）、`phoneKind`、`error`、`args`、`targetPackageName`、`registryUrl`、`runningVersion`、`latestVersion`（电话侧恒 `undefined`）、`environmentKind`、`latencyMs`。**全程 best-effort**：组装抛错即 `diag = undefined`，回退旧形状（`src/host.ts:735`、`src/host.ts:755-757`）。

失败回包组装（`src/host.ts:730-733`、`src/host.ts:850`）：

```ts
      const payload = toUpdateErrorPayload(error)
      emit('warn', LOG_EVENT_CALL_FAIL, { method, kind, errorHash: hash8(...), pluginId })
```
```ts
      return { ok: false, ...payload, ...(diag ? { diag } : {}) }
```

**成功回包永不带 `diag`**（`src/host.ts:718` 明文：「成功形状不动（#21）：成功回包永不带 diag，旧面板逐字不变」）。

### 3.3 字节墙与按序丢弃

`DIAG_INLINE_BUDGET_BYTES = 1024`（`src/redaction.ts:47`），运行时强制（`src/diag.ts:367` `enforceBudget` → `src/redaction.ts:295` `enforceDiagBudget`）：

- 永不丢的键（`src/redaction.ts:255`）：`['v', 'code', 'error', 'errorKind', 'stage', 'route', 'method', 'requestId']`
- 按序丢弃名单 `DIAG_DROP_ORDER`（`src/redaction.ts:266`）：`registryHost → action → 版本 → 其余可选`，**`detail` 只截断不丢**（`src/diag.ts:28`）

### 3.4 复制成文本（"复制诊断"）

- 预算 `COPY_BUDGET_CHARS = 1500`（`src/redaction.ts:40`），面板只转出口 `PANEL_DIAG_MAX_CHARS = COPY_BUDGET_CHARS`（`src/panel.ts:413-414`）
- `detail` 封顶 `DETAIL_MAX_CHARS = 300`（`src/redaction.ts:34`），截断在空白边界（`src/redaction.ts:160` `truncateToWordBoundary`）
- 宽容读：`readDiagTolerant`（`src/panel.ts:526-559`）——未知键进 `unknownKeys`、错类型跳过、**永不抛**
- 单行形态与三行块形态共用同一组字段、顺序冻结（码 → 摘要 → 来源 → 怎么办），由 `scripts/bilingual-gate.mjs:19-21` 的第 3 道检查守着

### 3.5 脱敏边界规则（哪些字段绝对不能进日志）

依据 ADR `docs/adr/0001-diagnostics-redaction-boundary.md`：

**规则 1（ADR:18-24）——脱敏是生成属性，具体为「唯一自由文本出口」**：

> `detail` 是全系统**唯一**的自由文本字段，它只有一个产出口。枚举与数字由类型系统管住，关联编号的形状由生成方式保证，两者都不需要运行时过滤。
> **不引入**：运行时事后扫描、逐字段规则清单、完备性检查机制。

代码落点：`src/redaction.ts:193` `sanitizeDetail(text)`、`src/redaction.ts:205` `sanitizeForCopy(text)`；`src/store.ts:985-987` 明文「本文件只经 `sanitizeDetail` 消费它（唯一自由文本出口），不自建规则、不做运行时事后扫描」。

**五条具名规则（`src/redaction.ts:64-70`，顺序即应用顺序，改顺序即改行为）**：

| 规则名 | 正则（`src/redaction.ts`） | 命中后 | 进日志？ |
| --- | --- | --- | --- |
| `R_ABSOLUTE_PATH` | `ABSOLUTE_PATH_RE`（:86-87）Windows 盘符 / UNC 反斜杠 / UNC 斜杠 / POSIX 四形状 | 换 `<路径>` | **绝对路径不得进日志** |
| `R_URL_USERINFO` | `URL_USERINFO_RE`（:90）`scheme://` 后第一个 `/` 前出现 `@` | **整项丢弃**（起止不唯一） | **URL 账号密码不得进日志** |
| `R_TOKEN` | `NPM_TOKEN_RE`/`GITHUB_TOKEN_RE`/`SK_TOKEN_RE`/`BEARER_TOKEN_RE`（:101-104） | 换 `<脱敏>`（Bearer 保留前缀） | **令牌不得进日志** |
| `R_CRED_PAIR` | `CRED_PAIR_RE`（:111-112）键名 `token/password/passwd/pwd/api_key/access_key/auth_token/secret/cookie` + `:`/`=` | 只换值，键名与分隔符保留 | **凭据键值对的值不得进日志** |
| `R_EMAIL` | `EMAIL_RE`（:115）标准形状 | 换 `<脱敏>` | **邮箱不得进日志** |

**占位符只有两个**（`src/redaction.ts:49-51`）：`REDACTED_PATH = '<路径>'`、`REDACTED_SECRET = '<脱敏>'`。

**规则 2（ADR:32-41）——定位得到就替换，定位不到就整项丢弃**：

> 判据是机械的——**秘密片段的起止能否被规则无歧义地定位**。
> 路径终止于空白，定位得到，就地替换成 `<路径>`。URL 里的账号密码可能自身含 `@`，起止不唯一，**整项丢弃**。
> **理由**：被替换过的文本，和本来就没有秘密的文本，在产物上无法区分。…替换会把一次泄漏变成一次静默的错——证据被销毁了。

**规则 3（ADR:45-51）——源信息只给本包认可的源**：

> `registryHost` 只给本包认可的源的域名，**不带**账号密码、端口、路径、查询参数。客户端 IP 永不进。
> **省略本身是信息**：它等价于"这不是官方源"。

代码落点：`ENDORSED_REGISTRY_HOSTS = ['registry.npmjs.org']`（`src/redaction.ts:74`）、`resolveRegistryHost`（`src/redaction.ts:217`）。

**规则 4（ADR:53-59）——关联编号由本包铸造**：`requestId` / `checkId` 形状由构造保证、由测试锁死；ADR:59 诚实边界「跨宿主那道边的关联只能尽力而为。宿主若用自己生成的编号覆盖 ours，关联就断了」。

**规则 5（ADR:61-63）——不设运行时扫描，测试当门**：

> 产物上做负向断言（"载荷里不得出现秘密形状"）比任何 grep 门禁都强…grep 门禁因此不建。

**ADR 明确登记的已知缺口（ADR:85-90）**：`file:///tmp/x` 三斜杠形状会被当成 URL 放过（`KNOWN_GAP_FILE_URL_PREFIX`，`src/redaction.ts:58`）；`manualCommand` 的 registry 原样拼接（`src/commands.ts:188-207`）**未经脱敏就进到用户要粘贴的命令串里**。

**ADR 与 README 的未解张力（ADR:92-103）**——集成日志前必须先解开：

> `README.md:260` 教用户：`message` 形如 `install-failed: <宿主原话>`，并说「`message` 可能带详情」。
> 但 #5 冻结的是「`diagnostic` 永指宿主脏原文、永不过边界」，而当前实现里**真实存在的唯一诊断通道恰恰就是宿主原话**…**这是下游做 `detail` 口径前必须先解开的前置。**

---

## 4. 各"环节"清单（入口函数 + 当前可观测性 + 失败证据）

### 4.1 环节逐条

**① 面板打开/挂载**
- 入口：`src/panel.ts:1999` `mountUpdatePanel(container, options)`；入口件 `src/entry.ts:351` `mountUpdateEntry`；批量 `src/panel-batch.ts:1533` `mountUpdateBatchPanel`；HTTP 变体 `src/http.ts:345/376/408`
- 挂载校验直接 `throw`（`src/panel.ts:2000-2037`：容器缺 `innerHTML`、`pluginId` 空、`call` 非函数、`pollMs < 250`、`mode` 非 embedded/dialog、`theme` 非 default/archive）
- **日志：零。** 失败时留下的证据：调用方进程的未捕获异常栈
- 证据：`src/panel.ts:1999-2047`

**② 自动检查更新**
- 入口：`src/panel.ts:1981` `pendingAutoCheck(snapshot, busyAct)`；轮询在 `mountUpdatePanel` 内（`src/panel.ts:2026-2030`）
- `pendingAutoCheck` 只在 `busyAct` 为 check/install 或 job 处于 `installing`/`verifying` 时返回 false（`src/panel.ts:1985-1989`）
- **日志：零。** 无法从日志区分"用户点了"与"自动触发"
- 证据：`src/panel.ts:1978-1990`

**③ 单插件 check**
- 电话包装：`src/host.ts:696` `loggedPhone(method, kind, pluginId, fn, diagCtx)`
- 核心：`src/service.ts:424` `createUpdateCore(ports)`
- **日志：仅完成时一条** `host.call`（成功）或 `host.call.fail`（失败），带 `latencyMs` 但不带阶段细分
- 失败证据：`{ ok:false, error, errorKind, diag? }`（`src/host.ts:850`）
- 证据：`src/host.ts:696-733`

**④ npm registry 查询**
- 入口：`src/service.ts:274` `fetchNpmRelease`、`src/service.ts:346` `fetchNpmVersionRelease`；读取器 `src/reader.ts:245` `createUpdateReader`
- 源常量 `NPM_REGISTRY = 'https://registry.npmjs.org/'`（`src/service.ts:27`）；超时经 `AbortSignal.timeout`（`src/service.ts:248`）
- **日志：零专属事件。** 失败时 `httpStatus` 落进 `diag.httpStatus`（`src/diag.ts:64`、期望表 `fetch-release` 阶段 want `httpStatus`，`src/diag.ts:82`）
- 证据：`src/service.ts:27`、`src/service.ts:248`、`src/service.ts:274`、`src/service.ts:346`

**⑤ 版本比较 / 通道判定（stable/beta）**
- 入口：`src/service.ts:107` `isVersionAllowedInChannel(version, channel='stable')`、`src/service.ts:127` `compareVersions`、`src/service.ts:147` `compareReleaseVersions`、`src/service.ts:102` `isPrereleaseVersion`
- **日志：零。** 失败时只有稳定码 `channel-mismatch` / `invalid-release`（`src/host.ts:587`）
- 证据：`src/service.ts:102-147`

**⑥ changelog 获取与解析**
- 入口：`src/changelog-io.ts:265` `fetchReleaseChangelogText`、`src/changelog-io.ts:197` `extractChangelogFromTar`、`src/changelog-io.ts:70` `readInstalledChangelogText`、`src/changelog.ts:266` `parseChangelog`
- 电话包装：`src/host.ts:804` `loggedChangelogPhone`，`kind` 恒为 `'update-changelog'`
- **日志：两条**，`host.call` / `host.call.fail`（`src/host.ts:823`、`src/host.ts:827`）
- 证据：`src/host.ts:800-851`、`src/changelog-io.ts:265`

**⑦ 用户点击安装**
- 入口：`src/panel.ts:2760` 附近的 action 分发（`data-action="install"`，`src/panel.ts:1594`）；凭证 `checkId`/`requestId` 校验在 `src/service.ts:44` `validRequestId`
- 失败码：`check-expired`（`src/host.ts:688-690`）、`update-busy`（`src/host.ts:692-694`）
- **日志：零专属。** 只有电话层的 `host.call.fail`
- 证据：`src/panel.ts:1589-1615`、`src/host.ts:688-694`

**⑧ 安装执行（宿主命令 / exit code）**—— **当前唯一"有据可查"的环节**
- 入口：`src/store.ts:1180` `createUpdateExecutor(parts)` → 三条路由 `INSTALL_RUNNERS`（`src/store.ts:1165-1169`）：`desktop-service`（`src/store.ts:947` `runDesktopService`）、`desktop-manager`（`src/store.ts:1083-1129` `runDesktopManager`）、`cli-process`（`src/store.ts:1133` `runCliProcess`）
- **日志：`update.install.exec`，5 键**`{ route, ok, exitCode, durationMs, pluginId }`（`src/store.ts:936-942`），成功与失败各发一次（`src/store.ts:1198`、`src/store.ts:1200`）
- 明文禁令：**不记命令、路径、使用范围名原文**（`src/store.ts:923`）
- 失败证据：`detail`（宿主原话，已脱敏）随 error 上抛（`src/store.ts:1203-1206`），「不塞进日志字段」（`src/store.ts:1201`）；子进程 `stdio` 为 `INSTALL_STDIO`（`src/store.ts:1151`），退出码非 0 抛 `withExit(fail('install-failed'), outcome.exitCode)`（`src/store.ts:1156`）
- 证据：`src/store.ts:905-944`、`src/store.ts:1160-1212`

**⑨ 安装后校验**
- 入口：job 状态机在 `src/service.ts:475-490`（`restart-required` / `completed` 判定）、`src/service.ts:602-605`；`pending-restart` 判定在 `src/reader.ts:342-344`
- 状态枚举 `JOB_STATES = ['installing','verifying','restart-required','completed','failed','interrupted']`（`src/store.ts:37`）、`src/ports.ts:76`
- **日志：零。** `diag` 阶段枚举里有 `verify`，但 `src/diag.ts:29-30` 明文「**verify 阶段暂无电话来源**（装后校验走后台异步，不经电话失败回包），枚举保留、电话侧不产出」
- 证据：`src/service.ts:475-490`、`src/reader.ts:342-344`、`src/diag.ts:29-30`

**⑩ 失败重试**
- 入口：面板重试用例 `src/panel.ts:868` `installLabel: copyText('panel.action.retry-install', l)`；批量 `src/panel-batch.ts:926`
- **日志：零专属。** 每次重试都重新发一条 `host.call.fail`，**无法从日志分辨"首次失败"与"第 N 次重试"**
- 证据：`src/panel.ts:868`、`src/panel-batch.ts:926`

**⑪ 批量面板入队**
- 入口：`src/host-batch.ts:579` `createMultiHostUpdate`；七个批量电话的契约在 `src/host-batch.ts:8-17`
- 忙时入队语义：`src/host-batch.ts:32-34`（不再回 `update-busy`，并进当前会话并回 `ok:true`）
- **日志：零。** 注意 `host-batch.ts` **不 import `log-events.js`**，只把 `input.logCtx` 原样透传（`src/host-batch.ts:665`）
- 证据：`src/host-batch.ts:1-60`、`src/host-batch.ts:650-679`

**⑫ 队列两阶段（先全查再串行装）**
- 决策：`src/queue.ts`（纯函数，`emptyQueueState`:53、`enqueueInQueue`:128、`setOwnerIfFree`:202、`queuePositionOf`:230）
- 端口：`src/store.ts:287` `createUpdateQueuePorts(homeDir, profileDir)`；全局锁 `src/store.ts:349-380`
- **日志：零。** 抢占/等待/释放全局锁、陈旧拥有者回收（`src/host.ts:501-505`）全部无声
- 证据：`src/queue.ts:1`、`src/store.ts:287-380`、`src/host.ts:488-522`

**⑬ 单项失败**
- 入口：`src/batch-run.ts:122-127`（查失败）、`src/batch-run.ts:159-164`（装失败）
- **日志：零。** 只落盘进会话（`markBatchEntry(..., { phase: 'failed', error })`）并 push 进 `steps` 数组（`src/batch-run.ts:124`、`src/batch-run.ts:161`）
- 证据：`src/batch-run.ts:116-171`

**⑭ 总账**
- 入口：`src/panel-batch.ts:242` `batchLedgerCounts`、`src/panel-batch.ts:283` `batchLedgerText`
- **日志：零。**
- 证据：`src/panel-batch.ts:242-302`

**⑮ 重启宿主**
- 入口：面板 `src/panel.ts:2760` `case 'restart-hint'`（三种结局：delegated / manual / failed，`src/panel.ts:2764-2769`）；批量 `src/panel-batch.ts:2122-2131`
- **日志：零。** 重启成功/失败/无入口三种结局**完全不可观测**
- 证据：`src/panel.ts:2760-2769`、`src/panel-batch.ts:2122-2131`

**⑯ 语言选择**
- 入口：`src/lang.ts:80` `resolveLang(override?)`、`src/lang.ts:36` `normalizeLangTag`、`src/lang.ts:153` `subscribeLang`
- 信号源：`document.documentElement.lang` / `navigator.languages`（`src/lang.ts:49`、`src/lang.ts:60`、`src/lang.ts:117`），模块级 `let mo`（`src/lang.ts:112`）
- **日志：零。**
- 证据：`src/lang.ts:36-203`

**⑰ 主题渲染**
- 入口：`src/panel.ts:51` `normalizePanelTheme`、`src/panel.ts:133` `isSafeThemeCssValue`、`src/panel.ts:154` `themeTokensStyleFor`、`src/panel.ts:1533` `renderUpdatePanelKernel`、`src/panel.ts:1847` `renderUpdatePanelHTML`
- **日志：零。** 非法主题直接 `throw`（`src/panel.ts:2035-2037`）
- 证据：`src/panel.ts:51-154`、`src/panel.ts:2035-2037`

**⑱ 落盘决策（state.json / 锁 / 备份）**
- 入口：`src/store.ts:62` `pathsForUpdate`、`src/store.ts:118` `createUpdateDiskPorts`
- **日志：零。** 锁抢占/回收/写盘失败全部 `catch {}` 静默（如 `src/store.ts:198-199`、`src/store.ts:215`）
- 证据：`src/store.ts:62-75`、`src/store.ts:161-215`

### 4.2 环节 × 当前可观测性（本次盘点主产出）

图例：**有** = 有专属日志事件；**间接** = 只能靠电话层 `host.call`/`host.call.fail` 的聚合事实反推；**零** = 无任何日志输出。

| # | 环节 | 入口（文件:行号） | 当前日志 | 具体事件/字段 | 失败时留下的证据 | 侧 |
| --- | --- | --- | --- | --- | --- | --- |
| ① | 面板打开/挂载 | `src/panel.ts:1999`、`src/entry.ts:351`、`src/panel-batch.ts:1533` | **零** | — | 调用方未捕获异常栈；挂载校验 `throw` | 客户端 |
| ② | 自动检查更新 | `src/panel.ts:1981` | **零** | — | 无（与手动检查不可区分） | 客户端 |
| ③ | 单插件 check | `src/host.ts:696`→`src/service.ts:424` | **间接** | `host.call`/`host.call.fail` + `latencyMs` | `{ok:false,error,errorKind,diag?}` | Node（电话）/客户端（触发） |
| ④ | npm registry 查询 | `src/service.ts:274`、`:346` | **零专属** | — | `diag.httpStatus`（`fetch-release` 阶段） | 中立 |
| ⑤ | 版本比较/通道判定 | `src/service.ts:107`、`:127`、`:147` | **零** | — | 稳定码 `channel-mismatch`/`invalid-release` | 中立 |
| ⑥ | changelog 获取与解析 | `src/changelog-io.ts:265`、`src/changelog.ts:266` | **有** | `host.call`（`kind:'update-changelog'`） | `host.call.fail` + `diag` | Node（IO）/中立（解析） |
| ⑦ | 用户点击安装 | `src/panel.ts:1594`、`src/panel.ts:2760` | **零专属** | — | 稳定码 `check-expired`/`update-busy` | 客户端 |
| ⑧ | 安装执行（命令/exit code） | `src/store.ts:1180` | **有（最完整）** | `update.install.exec` 5 键 | `exitCode` + `detail`（宿主原话，脱敏） | **Node** |
| ⑨ | 安装后校验 | `src/service.ts:475`、`src/reader.ts:342` | **零** | — | job `state`（`restart-required`/`completed`/`failed`/`interrupted`） | Node |
| ⑩ | 失败重试 | `src/panel.ts:868`、`src/panel-batch.ts:926` | **零专属** | — | 每次重发 `host.call.fail`（无次数信息） | 客户端 |
| ⑪ | 批量面板入队 | `src/host-batch.ts:579` | **零** | — | 会话相位 `ready` + 队列位置 | Node |
| ⑫ | 队列两阶段/全局锁 | `src/store.ts:287`、`:349`、`src/batch-run.ts:82` | **零** | — | `queue.json` / `global.lock` 落盘内容 | **Node** |
| ⑬ | 单项失败（批量） | `src/batch-run.ts:122`、`:159` | **零** | — | 会话 `phase:'failed'` + `steps[]` 返回数组 | 中立 |
| ⑭ | 总账 | `src/panel-batch.ts:242`、`:283` | **零** | — | 面板渲染文本 | 客户端 |
| ⑮ | 重启宿主 | `src/panel.ts:2760`、`src/panel-batch.ts:2122` | **零** | — | 无（三种结局不可分辨） | 客户端 |
| ⑯ | 语言选择 | `src/lang.ts:80` | **零** | — | 无 | 客户端 |
| ⑰ | 主题渲染 | `src/panel.ts:51`、`:154`、`:1847` | **零** | — | 非法值 `throw` | 客户端 |
| ⑱ | 落盘决策/锁 | `src/store.ts:62`、`:118` | **零** | — | 磁盘文件本身（`catch{}` 吞错） | **Node** |
| ⑲ | 复制诊断 | `src/panel.ts:450`、`:592` | **零** | — | 复制出的文本本身 | 客户端 |

**统计：19 个环节中，只有 2 个有专属日志（⑧ 安装执行、⑥ changelog），1 个间接（③ check），16 个为零。**

---

## 5. 多插件共存的现状机制

### 5.1 模块级可变单例（最大风险源）

| 文件:行号 | 声明 | 读点 | 写点 | 复位 | 冲突风险 |
| --- | --- | --- | --- | --- | --- |
| `src/host.ts:671` | `let phoneLogCtx: LogCtx = null` | `:676`、`:710`、`:817` | `:867` `phoneLogCtx = deps.logCtx ?? phoneLogCtx` | **无** | **极高**——见 5.5 |
| `src/host.ts:201` | `let sharedReader: (ReturnType<typeof createUpdateReader> & SharedQueueIO) \| null = null` | `:404` | `:547`、`:1031` | `:1031`（仅测试） | 中——键含插件标识，见 5.4 |
| `src/host.ts:202` | `let sharedReaderKey = ''` | `:404` | `:578`、`:1032` | `:1032`（仅测试） | 中——同上 |
| `src/host.ts:204` | `let sharedDesktopPnpm: unknown = null` | `src/host.ts:535` | `src/host.ts:258`、`src/host.ts:870` | `src/host.ts:1033`（仅测试） | 低 |
| `src/lang.ts:112` | `let mo: { disconnect(): void } \| null = null` | `src/lang.ts:117` 区 | `subscribeLang` 内 | `src/lang.ts:203` `__resetLangState` | 中——模块级媒体查询单例 |

复用判据（`src/host.ts:404`）：

```ts
  if (sharedReader && sharedReaderKey === key) return sharedReader
```

`key` 的构成含插件标识与前缀。测试锁死了这一点（`tests/phones.test.mjs:203-212`）：

```js
  it('单例复用键强制含标识：同前缀不同标识不串内存状态', async () => {
```
```js
    assert.equal(outA.snapshot.installedVersion, '1.0.0')
    assert.equal(outB.snapshot.installedVersion, '2.0.0')
```

复位函数（`src/host.ts:1029-1034`）**只复位三个 reader 单例，不复位 `phoneLogCtx`**：

```ts
/** 测试与门禁复位单例（正常运行不调用，规格 #591 第 6 条保留）。 */
export function __resetSharedUpdateReaderForTests(): void {
  sharedReader = null
  sharedReaderKey = ''
  sharedDesktopPnpm = null
}
```

### 5.2 固定文件路径 / 缓存目录（逐个列出）

| 文件:行号 | 路径构造 | 是否跨插件共享 | 冲突风险 |
| --- | --- | --- | --- |
| `src/store.ts:62-67` `pathsForUpdate` | `join(homeDir, 'updates', pluginId, shortHash(profileDir))` → `state.json` / `install.lock` / `before.json` | 否（含 `pluginId`） | **低**——除非两个插件都用默认 `pluginId = 'dsh-mattpocock-skills-deck'`（`LEGACY_PLUGIN_ID`，`src/store.ts:24`、`src/store.ts:35`），则**共用同一目录** |
| `src/store.ts:70-75` `legacyPathsForUpdate` | `join(homeDir, 'updates', 'dsh-mattpocock-skills-deck', shortHash(profileDir))` | **是（全局唯一）** | **中**——永久冻结的只读影子（`src/store.ts:32-34` 明文「永久冻结…永不删除」），读走双读（`src/store.ts:9-10`）；两家插件都会读同一份旧影子 |
| `src/store.ts:265-269` `queuePathsForUpdate` | `join(homeDir, 'update-queue', shortHash(profileDir))` → `queue.json` / `global.lock` | **是，按设计共享** | **高但有意**——`src/store.ts:242-246` 明文「同一 (homeDir, profileDir) 的全部插件共用同一目录…任何插件标识都撞不上」 |
| `src/store.ts:394` `BATCH_FILE = 'batch.json'` | `join(queue.directory, 'batch.json')`（`src/store.ts:407-410`） | **是** | **高**——「全范围唯一的一份」 |
| `src/store.ts:479-480` `INVENTORY_FILE` / `PREFS_FILE` | `batchPathsForOwner(homeDir, profileDir, owner)`（`src/store.ts:498-504`）→ `join(queue.directory, clean)` + `batch.json`/`inventory.json`/`prefs.json` | 按 `owner`（= 批量前缀）分目录 | **高**——`src/store.ts:477` 明文「Owner identity is the batch prefix (unique per integrator)」；两家插件用同一 `batchPrefix` 即共用三个文件 |
| `src/store.ts:741` `skipped.json` | `join(paths.directory, SKIPPED_FILE)`，`paths` 来自 `pathsForUpdate` | 否（含 `pluginId`） | 低 |
| `src/store.ts:815` | `join(directory, 'package.json')` | 否 | 低 |

**无端口、无临时目录、无固定 env 变量、无进程间 socket。** `process.env` 只被**读**（`src/host.ts:360`、`src/reader.ts:255`、`src/host-batch.ts:600`，均为 `overrides.env ?? process.env`），**从不写**。

### 5.3 面板/客户端侧全局注册

- **无自定义元素注册**：`src/` 下搜 `customElements` **零命中**。挂载全靠调用方传入容器（`src/panel.ts:2000` 要求 `typeof container.innerHTML === 'string'`）。
- **无 `window` 挂载点**：搜 `window.__` **零命中**。
- **`globalThis` 全是"现取"只读**，不设全局：`src/lang.ts:49` / `:60` / `:117`（`document.documentElement.lang`、`navigator.languages`）、`src/panel.ts:721`（`localStorage`）、`src/panel.ts:1926` / `:1950` / `:1961`、`src/panel-batch.ts:1334` / `:1509` / `:1679`（剪贴板 / `navigator`）、`src/http.ts:220`（`fetch`）、`src/service.ts:248` 与 `src/changelog-io.ts:58`（`AbortSignal.timeout`）、`src/redaction.ts:235`（`TextEncoder`）。
- 设计意图明文（`src/runtime.d.ts:4-6`、`src/panel.ts:14`、`src/http.ts:6`、`src/entry-batch.ts:35`、`src/panel-batch.ts:34`）：模块顶层不碰 DOM。
- **唯一的客户端持久化竞争**：`localStorage`（`src/panel.ts:713` `createBrowserSkipStore`、`src/panel.ts:721`），键由 `skipKey(pluginId, version)` 派生（`src/store.ts:676`）——含 `pluginId`，**不冲突**。

### 5.4 进程级单例的隔离现状（好的部分）

`host.ts:400-410` 区与 `src/host.ts:578` 的 `sharedReaderKey = key` 保证了：**同前缀不同插件标识不会串内存状态**（测试 `tests/phones.test.mjs:203`）。`src/host-batch.ts:20-21` 明文：

> 每个目标一份 `createHostUpdate`：它的单例复用键含插件标识与前缀（见 host.ts），七个目标各有各的内存状态，不串台。

### 5.5 「多插件互相覆盖」最可能的真实发生路径（机制级）

**路径 A（最可能）：`phoneLogCtx` 模块级 last-writer-wins，日志出口被后注册的插件抢走。**

机制链条：
1. `src/host.ts:671` `let phoneLogCtx: LogCtx = null` 是**模块作用域**变量，不是 per-instance 字段。
2. `src/host.ts:867` 每次 `createHostUpdate` 都执行 `phoneLogCtx = deps.logCtx ?? phoneLogCtx`——**单向覆盖，无栈、无引用计数、无按 pluginId 的路由表**。
3. 三个发射点（`src/host.ts:676`、`:710`、`:817`）与 `emitInstall` 派生的 `emitInstallLog`（`src/host.ts:545`）在**调用时刻**读这同一个变量。
4. 因此：插件 A 先 `createHostUpdate({ctx, logCtx: sinkA}, …)`；插件 B 后 `createHostUpdate({ctx, logCtx: sinkB}, …)`；此后**插件 A 的所有 `host.call` / `host.call.fail` / `update.install.exec` 全部写进 `sinkB`**。A 的安装执行事实与电话延迟，出现在 B 的日志流里。
5. 反向也成立：B 若传 `logCtx: null`，因 `??` 语义（`null ?? phoneLogCtx === phoneLogCtx`）**不会复位成 null，A 的出口继续生效**——B 以为自己没接日志，实际在往 A 的管道写。`src/host-batch.ts:665` 正是传 `input.logCtx ?? null`，所以这条路径在批量入口上已经被走到。
6. **是否真的共用同一个模块实例，取决于包管理器是否 dedupe/hoist**：若两个插件各自在嵌套 `node_modules` 里放一份 `dsh-plugin-update`，则各有独立模块实例、各有独立 `phoneLogCtx`，**不冲突**；一旦 npm/pnpm 把它提升到共享层级（两个插件 `require` 到同一份 `dist/host.js`），**共用同一模块实例，冲突成立**。这一条不受本包控制，也无法从本包内部检测。
7. 需要说明的是：`pluginId` 字段**已经**在每条日志里（`src/host.ts:719`/`:733`/`:823`/`:827`、`src/store.ts:941`），所以"日志里能分辨是谁"已经做到；**做不到的是"每条日志进谁的管道"**。

**路径 B：默认 `pluginId` 相同导致落盘目录合并。**

若两个插件都未显式传 `pluginId`，`resolveUpdateConfig` 落到冻结旧值 `dsh-mattpocock-skills-deck`（`src/store.ts:24`、`src/store.ts:35`），则 `src/store.ts:62-67` 拼出的 `join(homeDir,'updates','dsh-mattpocock-skills-deck', shortHash(profileDir))` **完全重合**——两家共用 `state.json`（任务状态互相覆盖）、`install.lock`（互相以为对方在装）、`before.json`（备份互相覆盖）。这是**数据覆盖**，比日志覆盖更严重。

**路径 C：同一 `batchPrefix` 导致批量账本合并。**

`src/store.ts:477` 注释即承认 owner identity 就是批量前缀；`src/store.ts:498-504` 用它拼 `join(queue.directory, clean)`。两家插件用同一 `batchPrefix`（例如都照抄文档默认值）→ 共用 `batch.json` / `inventory.json` / `prefs.json`，**一家的批量进度会把另一家的覆盖掉**。README 已就此告警（`README.md:547`「电话名串台（两家插件收到对方的电话）：检查两家 `prefix` 是否相同」）。

**路径 D（已由设计规避，记录以排除）**：`sharedReader` 单例键含插件标识（`src/host.ts:404` + 测试 `tests/phones.test.mjs:203`）；`localStorage` 跳过记录键含 `pluginId`（`src/store.ts:676`）；无自定义元素、无 `window` 挂载点。这三处**不构成覆盖路径**。

---

## 6. 宿主交互面

### 6.1 对外的"电话"（host 侧 API）

| 文件:行号 | 导出 | 返回形状 |
| --- | --- | --- |
| `src/host.ts:864` | `createHostUpdate(deps, configInput): HostUpdate` | `interface HostUpdate { phoneNames; handlers }`（`src/host.ts:855-858`） |
| `src/host-batch.ts:579` | `createMultiHostUpdate(...)` | 七个批量电话（契约 `src/host-batch.ts:8-17`） |
| `src/config.ts:153`（经 `src/host.ts:52` 转出口，调用点 `src/host.ts:873`） | `buildPhoneNames(prefix)` | 四电话名（status/check/install/changelog） |
| `src/client.ts:84` | `buildClientPhoneNames(prefix)` | 同上（客户端侧拼法） |
| `src/panel-batch.ts:198` | `buildBatchPhoneNames(prefix)` | 七批量电话名 |
| `src/host-batch.ts:242` | `phoneRequestIdOf(batchRequestId)` | 请求编号 |

电话处理器包装层：`src/host.ts:696` `loggedPhone`（查状态/查新版/装更新）、`src/host.ts:804` `loggedChangelogPhone`（更新日志）。

### 6.2 返回值里已有的"可读文本"（第三方可直接贴给我们的现成载体）

| 字段 | 文件:行号 | 内容 | 可读性 |
| --- | --- | --- | --- |
| `manual` | `src/host.ts:723`、`src/commands.ts:189` | 手工兜底命令全文（精确版本 + 官方源 + `--save-exact`） | **高**——可直接粘终端 |
| `diag.detail` | `src/diag.ts:67`、`src/redaction.ts:193` | 已脱敏宿主原话，≤300 字 | 高（ADR 未解张力，见 3.5） |
| `diag.action` | `src/diag.ts:75` | `retry`/`manual`/`contact`/`restart` | 枚举 |
| `diag.stage`/`route`/`method` | `src/diag.ts:61-63` | 阶段与路由方法（正交，不拼串） | 枚举 |
| `diag.requestId`/`checkId` | `src/diag.ts:72-73` | 关联编号（本包铸造） | **高**——凭它对日志 |
| `snapshot` | `src/host.ts:722` | 六字段快照（`README.md:447` §5.1） | 结构化 |
| `message` | job 内，`README.md:555` | 形如 `install-failed: <宿主原话>` | 高（README 教「匹配前缀错误码，不要整串相等」） |
| `env` / `queue` | `src/host.ts:726-728` | 使用范围一栏、队列视图（调用方显式要才带） | 结构化 |
| `buildDiagnosticText` | `src/panel.ts:450` | `[update-diag] code=… · …` 单行 | **高**——设计给第三方贴 |
| `buildUpdateDiagCopy` | `src/panel.ts:592` | 三行块（摘要/来源/怎么办） | **高**——同上 |

### 6.3 ctx 里有没有 logger 能力可借用？

**没有。** `src/host.ts:206` 的 `ctxService(ctx, name)` 是唯一读 ctx 的口子，全包只读三个服务名：

- `subprocess`（`src/host.ts:534`）
- `desktopProfiles`（`src/host.ts:536`、`src/host.ts:228`）
- `pluginManager`（`src/host.ts:537`、`src/host.ts:230`）

在 `src/` 下搜 `logger|Logger|LogFn|LogLevel` **零命中**；搜 `\blog\b\s*[?:]`（类型定义形态）只命中两处：`src/store.ts:918` `log?: (level, event, fields) => void`（`ExecutorParts` 的注入点，由 `src/host.ts:545` 喂 `emitInstallLog`）与 `src/host.ts:670` 的 `LogCtx`。

**结论：本包不与 ctx 上任何既有 logger 打通；日志能力的唯一注入通道是 `createHostUpdate` 第二参数的 `deps.logCtx`。** 若 dsh-log 的接入形态是"宿主把 logger 挂在 ctx 上"，本包当前**读不到**它——需要新增 ctx 探测或要求调用方显式传 `logCtx`。

---

## 7. 测试与门禁现状

### 7.1 与日志/诊断直接相关的测试

| 文件:行号 | 断言内容 | 是否"上膛" |
| --- | --- | --- |
| `tests/phones.test.mjs:216-224` | 成功事件 5 键：`assert.deepEqual(Object.keys(calls[0].fields).sort(), ['kind','latencyMs','method','ok','pluginId'])` | **是（真门禁）** |
| `tests/phones.test.mjs:226-234` | 失败事件 4 键：`['errorHash','kind','method','pluginId']` | **是（真门禁）** |
| `tests/routes.test.mjs:104-108` | 执行事件 5 键：`['durationMs','exitCode','ok','pluginId','route']` + `route === 'desktop-service'` | **是（真门禁）** |
| `tests/desktop-manager.test.mjs:155`、`:163` | 同上，`update.install.exec` 过滤 | 是 |
| `tests/panel-failure-latch.test.mjs:531-540` | 路牌三事件名来自 `dist/log-events.js` 共享常量 | 是 |
| `tests/gate.test.mjs:36-42`、`:85-99`、`:120-131` | 事件清单解析、字段白名单、计数核对、路径形式拒绝 | 是（测 `src/gate.ts` 本身） |
| `tests/diag-phone.test.mjs`（470 行）、`tests/issue-45-diag-complete.test.mjs`（168 行） | `diag` 构造与完整性 | 是 |
| `tests/detail-redaction.test.mjs`（314 行）、`tests/redaction-single.test.mjs`（355 行）、`tests/issue-84-detail-matrix.test.mjs`（296 行） | 五条脱敏规则与单源收敛 | 是 |
| `tests/panel-diag-22.test.mjs`（323 行） | 面板侧 `diag` 宽容读与复制形态 | 是 |
| `tests/queue.test.mjs:325` | 队列路径下的 `logCtx.fire` 收集 | 是 |
| `tests/changelog-auto.test.mjs:115`、`tests/issue-98-channel-mismatch.test.mjs:100/190/218`、`tests/issue-100-prerelease-install.test.mjs:221`、`tests/issue-45-diag-complete.test.mjs:60` | `logCtx: { fire: () => {} }` 占位（**只填空实现，不断言**） | 否（占位） |

测试总数 69 个 `.test.mjs`（`package.json:68` `node --test tests/*.test.mjs`）。

### 7.2 门禁脚本与新增日志的相互影响

**`scripts/bilingual-gate.mjs`（1060 行）—— 新增日志文案的硬约束。** 四道检查（`scripts/bilingual-gate.mjs:5-23`）：

1. **文案源 grep 门禁**：`src/` 下**中文字符串字面量只许出现在文案源**；`export const COPY_SOURCE_FILES = ['src/bilingual.ts']`（`scripts/bilingual-gate.mjs:45`）；其余位置按冻结基线 `tests/fixtures/bilingual/copy-baseline.json` 逐条放行——**只许减，不许增**。
   - 门禁自陈（`scripts/bilingual-gate.mjs:10-11`）：「注释、正则不入账；**日志/抛错等冻结中文若要改，必须同步基线**，让改动在评审 diff 里被看见（#53 立约：注释/日志/抛错不动）」
   - **影响**：若 dsh-log 集成要新增中文日志文案，必须（a）加进 `src/bilingual.ts` 字典并同步 `tests/fixtures/bilingual/strings.snapshot.json`，或（b）同步 `copy-baseline.json`——**两条路都会在评审 diff 里露出来**。
2. **字典快照**：每键 en+zh 非空、英文无汉字、中文有汉字、具名槽中英同名同数、**改文案不换 key**（`scripts/bilingual-gate.mjs:13-16`）。新文案键全部标 `draft: true`（如 `src/bilingual.ts:365`），**`--release` 时还有 draft 就红**（`scripts/bilingual-gate.mjs:23`）。
3. **契约测试**：15 个稳定码各有文案且只按码分支；诊断解析契约（16 键宽容读、两种复制形态、字段顺序冻结）（`scripts/bilingual-gate.mjs:18-21`）。
4. **零 draft 放行**（`--release`）。

命令（`package.json:69-70`）：`npm run gate:bilingual`、`npm run gate:bilingual:release`；用法说明 `scripts/bilingual-gate.mjs:26-31`；退出码 0/1/2（`scripts/bilingual-gate.mjs:33`）。

**`src/gate.ts` 不是门禁**（`src/gate.ts:43` 自陈，ADR:28 同）：

> 诚实边界（#19）：本文件是给第二个接入方自查用的尺子，不是门禁——`checkEventFields` 是纯函数（不抛错、不记日志、不被任何生产代码调用），真正在守日志字段基线的是 `tests/phones.test.mjs` 与 `tests/routes.test.mjs` 里的逐字键集断言。

配套空模板 `event-list.template.json`（6 行，`counts` 全 0、`events` 空；**#120 起模板已删去 `counts`**，形状以包内模板与 `event-list.update.json` 为准）。
**其余 `scripts/`**：`panel-layout-probe.mjs`、`gen-batch-detail-dialog-prototype.mjs`、`gen-batch-detail-landing-108.mjs`、`publish-token.ps1`、`publish-window.ps1`——均与日志/诊断无关。

### 7.3 README 面向第三方开发者的接入章节（新增日志能力该补哪里）

`README.md` 共 641 行，28 个小节：

| 行号 | 小节标题 | 与日志/诊断的关系 |
| --- | --- | --- |
| `README.md:24` | `## 1. 安装` | — |
| `README.md:35` | `## 2. 三步接入` | 总纲 |
| `README.md:40` | `### 第 1 步：装包` | — |
| `README.md:44` | `### 第 2 步：宿主侧接线` | **★ 日志接线该补这里**——`{ ctx, logCtx }` 就在 `README.md:50`、`:68`、`:73` |
| `README.md:80` | `### 四个电话的入参与回参` | 回包字段（`diag` 在此） |
| `README.md:96` | `### 第 3 步：面板侧接线（构建期派生）` | — |
| `README.md:123` | `### 第 4 步：面板侧挂载整组件（一个挂载点即跑）` | — |
| `README.md:196` | `### 第 2.5 节：更新入口件（配置页上那一颗按钮）` | — |
| `README.md:243` | `#### 批量感知的入口件（一颗按钮看 N 家，点开即批量面板）` | — |
| `README.md:266` | `### 第 2.6 节：多目标批量更新（一个插件管 N 个插件的更新）` | 批量电话契约（含 `logCtx` 透传，`README.md:276`） |
| `README.md:355` | `### 第 2.7 节：更新日志自动展示（告诉用户更新了什么）` | 「更新日志」≠ 运行日志，易混 |
| `README.md:379` | `### 升级本包（已经接入过的项目）` | — |
| `README.md:394` | `## 3. 配置` | — |
| `README.md:427` | `## 4. 安装是怎么执行的` | 三条路由 |
| `README.md:445` | `## 5. 用户会看到什么` | — |
| `README.md:447` | `### 5.1 快照六字段` | — |
| `README.md:460` | `### 5.2 九种装不了的原因` | 稳定码 |
| `README.md:487` | `### 5.3 手工兜底命令` | `manual` 字段 |
| `README.md:500` | `### 5.4 ⚠️ 待重启提示（必须做）` | `pending-restart` |
| `README.md:510` | `### 5.5 轮询与凭证` | — |
| `README.md:516` | `### 5.6 跳过与版本通道` | — |
| `README.md:522` | `### 5.7 跨插件单队列` | 队列可见性 |
| `README.md:528` | `### 5.8 更新说明` | — |
| `README.md:542` | `## 6. 排错` | **★★ 最该补日志文档的地方**——已有第 11 条（`README.md:556`）：「还定位不到：打开调试日志，按插件标识过滤 `host.call`、`host.call.fail`、`update.install.exec` 三个事件，看 `pluginId` 与 `route`、`exitCode` 字段；日志里不记命令与路径原文。」 |
| `README.md:560` | `## 7. 接入自检清单` | 第 4 条（`README.md:567`）已含多插件隔离验收 |
| `README.md:570` | `## 8. 包还导出什么` | **★ 新增导出该补这里**（`README.md:572` 起列 `panel`/`entry`/`http`/`client`） |
| `README.md:637` | `## 9. 兼容与稳定性` | 契约冻结说明 |

**补文档建议落点**（依 `AGENTS.md`：「README 是面向集成方的用户手册、不放设计意图」）：
- 接线与配置 → `README.md:44` `### 第 2 步：宿主侧接线`（`logCtx` 目前只在 `README.md:50/68/73` 以参数形式出现，**没有任何一节解释它是什么、字段有哪些、多插件该如何传**）
- 新增导出/事件目录 → `README.md:570` `## 8. 包还导出什么`
- 排错与"把日志交给我们" → `README.md:542` `## 6. 排错` 第 11 条扩写
- 设计与理由 → `docs/adr/`（新 ADR），不放 README

---

## 8. 环节 × 当前可观测性（表格汇总）

见 **§4.2**（同一张表，含 19 个环节的入口行号、日志现状、失败证据、所属侧）。核心数字：**19 个环节 → 2 个有专属日志、1 个间接、16 个为零**。

---

## 9. 多插件共存风险清单（表格汇总）

| # | 机制 | 文件:行号 | 共享范围 | 覆盖后果 | 风险 | 是否本包可控 |
| --- | --- | --- | --- | --- | --- | --- |
| A | `phoneLogCtx` 模块级 last-writer-wins | `src/host.ts:671`、`:867`、读点 `:676`/`:710`/`:817`/`:545` | **同一模块实例的全部插件** | 插件 A 的 `host.call` / `host.call.fail` / `update.install.exec` 全部写进插件 B 的日志管道；`logCtx: null` **不复位**仍写入 A 的管道（`src/host-batch.ts:665` 已传 null） | **极高** | 是（改 per-instance 即可） |
| A′ | 是否共用模块实例取决于包管理器 dedupe/hoist | —（包外） | 提升到共享层级时成立 | 决定 A 是否真的发生 | 高 | 否（但可在 A 修好后免疫） |
| B | 默认 `pluginId` 相同 → 落盘目录合并 | `src/store.ts:24`、`:35`、`:62-67` | 两家都用默认标识时**完全重合** | `state.json` 任务状态互相覆盖、`install.lock` 互锁、`before.json` 备份互相覆盖 | **高（数据覆盖）** | 是（强制显式 pluginId） |
| B′ | 旧只读影子目录全局唯一 | `src/store.ts:70-75` | 全部插件共读 `updates/dsh-mattpocock-skills-deck/<hash>` | 只读不写（`src/store.ts:9-10`），不改数据；仅可能读到别家的旧状态 | 中 | 是 |
| C | 同一 `batchPrefix` → 批量账本合并 | `src/store.ts:477`、`:498-504` | 同前缀的全部批量属主 | `batch.json` / `inventory.json` / `prefs.json` 被互相覆盖 | **高** | 是（校验前缀唯一） |
| D | 跨插件队列目录按设计共享 | `src/store.ts:265-269`、`:242-246` | 同一 `(homeDir, profileDir)` 的全部插件 | `queue.json` / `global.lock` 单份——**有意设计**（强制串行）；面板侧用 `visibleQueueFor` 裁剪可见性（`src/queue.ts:287`） | 低（有意） | 是 |
| E | 面板电话名串台 | `README.md:547`、`src/config.ts:153` | 同前缀 | 两家收到对方的电话 | 中 | 是（README 已告警） |
| F | `sharedReader` 单例 | `src/host.ts:201-202`、`:404`、`:578` | 键含插件标识与前缀 | **不覆盖**（测试 `tests/phones.test.mjs:203` 锁死） | 低（已规避） | — |
| G | `localStorage` 跳过记录 | `src/panel.ts:713`、`:721`、`src/store.ts:676` | 键含 `pluginId` | **不覆盖** | 低（已规避） | — |
| H | 自定义元素 / `window` 挂载点 | 搜索 `customElements` / `window.__` **零命中** | — | 不存在 | 无 | — |
| I | `process.env` | `src/host.ts:360`、`src/reader.ts:255`、`src/host-batch.ts:600` | 只读不写 | 不存在写冲突 | 无 | — |
| J | 端口 / 临时目录 / 固定 env | 无 | — | 不存在 | 无 | — |
| K | `lang.ts` 模块级媒体查询单例 | `src/lang.ts:112`、`:203` | 同模块实例的全部面板 | 语言订阅被后挂载者扰动 | 低 | 是 |

---

## 10. 集成决策的直接输入（结论性观察，非建议）

1. **唯一可用的日志注入点**是 `createHostUpdate(deps, …)` 的 `deps.logCtx`（`src/host.ts:864`、`src/host.ts:670`）与 `createMultiHostUpdate` 的同名字段（`src/host-batch.ts:131`、`:665`）。ctx 上无 logger。
2. **事件面只有 3 个名字**（`src/log-events.ts:8-10`），字段基线 5/4/5 键，由 `tests/phones.test.mjs:222`、`:232`、`tests/routes.test.mjs:106` 逐字锁死——**扩字段会立刻红**，扩字段必须同步改这三处断言。
3. **16/19 个环节当前完全不可观测**，且其中 11 个在 **client 侧**（§1.3），dsh-log 若只在 Node 侧可用则结构性打不到。
4. **脱敏是不可绕过的构造约束**（ADR 0001，§3.5）：新增任何自由文本字段必须走 `sanitizeDetail`（`src/redaction.ts:193`）这唯一出口；`detail` 300 字、`diag` 1024 字节、复制文本 1500 字是三处硬预算。
5. **ADR:92-103 的未解张力是前置阻塞**：README 教用户 `message` 带宿主原话（`README.md:555`），而 ADR 冻结「`diagnostic` 永不过边界」——做 `detail` 口径前必须先回答"这到底是有意保留的逃生口还是历史遗留"。
6. **新增中文日志文案会撞双语文案门禁**（`scripts/bilingual-gate.mjs:45`），必须进 `src/bilingual.ts` 或同步 `copy-baseline.json`。
7. **`src/log-events.ts:6` 明文「本文件零导入，宿主/面板同缝（与 redaction 同口径）」**——它被设计成两端共享的常量单源，是新增事件名最自然的落点。
