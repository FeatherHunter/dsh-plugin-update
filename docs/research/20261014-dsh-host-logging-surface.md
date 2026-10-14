# DSH 宿主插件日志能力与多插件日志呈现调研

日期：2026-10-14
范围：本机 DSH 实现（`D:\DeepseekHarness\resources\app.asar`，asar 内 `dsh/` 前缀）与用户目录 `C:\Users\辰辰洋洋\.dsh\` 的实际安装物。
目的：为 `dsh-plugin-update` 集成 `dsh-log` 0.3.1 做统一日志，摸清宿主侧「插件能拿到什么日志 API」「宿主把日志放哪」「多个插件会不会互相覆盖」。

## 取证方法（读法约定）

- `D:\DeepseekHarness\resources\app.asar\dsh\` **不是真实目录**，是打包进 asar 的虚拟路径，`read`/`grep`/`glob` 工具都读不到它（官方 skill 也确认了这一点，见 §4）。本次用两个自写临时工具读 asar：
  - `D:\dsh-plugin\dsh-plugin-update\.tmp\dsh-host-research\asar-tool.mjs`（`list` / `cat` / `extract`）
  - `D:\dsh-plugin\dsh-plugin-update\.tmp\dsh-host-research\asar-grep.mjs`（不解包直接按正则扫 asar 内文本，跳过二进制与超大文件）
  - asar 头解析：offset 4 = headerSize（pickle），offset 12 = jsonSize，JSON 从 offset 16 开始，`baseOffset = 8 + headerSize`。整个 asar 共 `TOTAL_ENTRIES=12967`。
- 已解包副本放在 `D:\dsh-plugin\dsh-plugin-update\.tmp\dsh-host-research\host-src\`（内部路径前缀被保留，因此副本路径形如 `host-src\@deepseek-ai\<pkg>\dsh\node_modules\@deepseek-ai\<pkg>\lib\index.js`）。
- **本文引用 asar 内文件时一律写 asar 内路径**（如 `app.asar:dsh/node_modules/@deepseek-ai/cordis/src/logger.ts:213`）；引用真实磁盘文件时写绝对路径。
- 教训：本仓 `grep` 工具（ripgrep）会跳过 gitignore 的 `.tmp/`，查解包副本要用 powershell `Select-String`。
- 本次未改动任何仓库文件，未安装任何全局包。

环境事实：
- 宿主应用版本：`app.asar:dsh/package.json` → `@deepseek-ai/dsh-desktop-runtime` `0.2.0-rc.2`。
- Node v24.19.0 / npm 10.9.2；`npm root -g` = `D:\2Study\nodejs\node_modules`。
- 当前 GUI 就是 Desktop 宿主：`http://127.0.0.1:19387`（与 `dsh-desktop-host` 写死的 `--port 19387` 一致，见 §3）。

---

## TL;DR

1. **宿主完全没有 `dsh-log`**：asar 全量正则扫 `dsh-log` → `scanned=11269 hits=0`；`extract dsh/node_modules/@deepseek-ai/dsh-log` → `EXTRACTED=0`；全局 `npm ls -g` 也没有。`dsh-log` 只是**第三方插件自己装的依赖**，本机 profile 里是 **0.2.2**。
2. **插件能拿到的官方日志 API 只有一个**：cordis 的 `ctx.logger`。没有 `ctx.log`、没有 console 包装、没有宿主 stderr 捕获、没有平台日志服务。
3. **`ctx.logger` 默认不输出到任何地方**。全宿主只有两处注册 exporter：cordis 内置的**内存 1000 条环形缓冲**，与 app-boot 的启动诊断收集器。没有 console / stderr / 文件 exporter。
4. **宿主自己只有三类日志文件，全部唯一命名 + 独占创建**：启动失败 `~/.dsh/logs/startup-<时间>-<uuid>.log`（`flag:"wx"`）；Electron 崩溃报告 `<app.getPath("logs")>/crash-<时间>-<来源>.log`（`flag:"wx"`，保留 10 份）；插件管理器 `.plugin-manager/logs/operation-XXXX/pnpm.log`（`mkdtemp`）。
5. **Desktop 下插件 stdout 基本丢弃、stderr 被塞进一个 64 KiB 滚动缓冲**：`child.stdout.pipe(process.stdout)`、`this.stderr = (this.stderr + chunk).slice(-65536)`，全部插件混流、无前缀，且**只在子进程异常退出时**随错误消息露一次。
6. **Web GUI 里没有任何插件日志面板**。客户端唯一的「日志」是 Session Log（对话记录）的上传/下载；官方 README 对插件安装失败的说法就是「Host 日志里有」。
7. 宿主里唯一「按包打前缀」的日志是**动态包沙箱**的 `taggedConsole(id)` → `[cordis:<id>]` 前缀 + write-through console，只适用于模型现写的 `dyn-<n>` 包，**不适用于已安装的 npm 插件**。
8. **「不互相覆盖」在宿主侧没有任何保证**，只能靠每个插件自己的唯一目录名。实测 `C:\Users\辰辰洋洋\.dsh\logs\` 下三个插件三套命名并存、互不覆盖。
9. **dsh-log 自己的目录租约是「模块副本级」的**：同进程两份 dist 互相看不见，跨进程零保护；同一文件并发 append 只有 ≤4096 字节的块才近似原子。
10. **与日志相关的 env 只有 `DSH_HOME`**（外加 `DSH_PROFILE`/`DSH_PROFILE_DIR`、`DSH_TELEMETRY_*`）；**不存在 `DSH_LOG*` / `LOG_LEVEL` / `DSH_DEBUG`**，且 `DSH_` 前缀被 bootstrap 白名单挡住，`.env` 不许设。

---

## 1. 宿主是否内置/依赖 dsh-log

**结论：宿主既不自带、也不依赖、更不 import `dsh-log`。零命中。**

证据（全部为命令输出原文）：

```
$ node asar-grep.mjs 'D:\DeepseekHarness\resources\app.asar' '.' 'dsh-log'
scanned=11269 hits=0

$ node asar-tool.mjs list 'D:\DeepseekHarness\resources\app.asar' 'dsh-log'
TOTAL_ENTRIES=12967 MATCHED=0

$ node asar-tool.mjs extract 'D:\DeepseekHarness\resources\app.asar' 'dsh/node_modules/@deepseek-ai/dsh-log' 'tmp-out'
EXTRACTED=0
```

全局 npm 同样没有：

```
$ npm ls -g --depth=0
D:\2Study\nodejs
+-- @deepseek-harness-tui/dsh-tui@0.11.1
+-- @dsh-so/dshvm@0.2.0
+-- @opencode/cli@2.0.20
+-- corepack@0.35.0
+-- npm@10.9.2
+-- undici@8.10.0
$ npm root -g
D:\2Study\nodejs\node_modules
```

`dsh-log` 出现在**第三方插件**的依赖里，装在本机 profile：

- `C:\Users\辰辰洋洋\.dsh\profiles\desktop\node_modules\dsh-log` 存在，版本 **0.2.2**（`package.json` 的 `version` 字段），是**普通目录（非 symlink）**——即 profile 里被提升的一份共享副本。
- `C:\Users\辰辰洋洋\.dsh\profiles\desktop\pnpm-lock.yaml:823` → `dsh-log@0.2.2:`；`:2350` → `dsh-log@0.2.2: {}`；`:2377`、`:2387` → `dsh-log: 0.2.2`。
- 依赖它的 profile 包只有两个：`dsh-prompt` 与 `dsh-opencode-palette`（`dsh-prompt/package.json` 的 dependencies 里写 `"dsh-log": "^0.2.1"`）。
- `.pnpm` 目录里没有 `dsh-log@*` 条目（`Get-ChildItem .pnpm | Where Name -like '*dsh-log*'` 为空；`.pnpm` 项数=1）——所以同 profile 里两个插件**共用同一份** dsh-log 模块副本。

**与本仓直接相关的约束**：`D:\dsh-plugin\dsh-plugin-update\package.json` 目前**没有任何 runtime dependencies**（`dependencies` 字段不存在，只有 devDependencies `esbuild ^0.28.2`、`typescript 5.6.3`）。集成 `dsh-log` 会成为本包第一个运行时依赖，需要刻意决定它放在 `dependencies`、`peerDependencies` 还是可选导入（现状参考：`dsh-prompt` 用的是 **try/catch 动态 import + 降级**，见 §5）。

宿主自己那套日志（无 dsh-log）：见 §5。

---

## 2. 插件拿到日志的官方途径

**结论：唯一官方途径是 cordis 的 `ctx.logger`（`LoggerService`）。** 全仓搜索没有第二套：没有 `ctx.log`、没有 `console` 包装注册给普通插件、没有把宿主 stderr 暴露给插件的事件流。

### 2.1 精确可用签名（cordis 4.0.4）

来源：`app.asar:dsh/node_modules/@deepseek-ai/cordis/src/logger.ts`（同文件编译产物 `lib/index.js`，类型 `lib/types/logger.js`）。

```ts
// logger.ts:13
export type LoggerType = 'error' | 'info' | 'warn' | 'debug'
// logger.ts:16
export type LoggerMethod = (format: any, ...param: any[]) => void
// logger.ts:22-27
export const enum LoggerLevel { ERROR = 0, INFO = 1, WARN = 2, DEBUG = 3 }
// logger.ts:30-38
export interface Message {
  sn: number; ts: number; name: string; type: LoggerType
  level: number; args: any[]; fiber?: WeakRef<Fiber>
}
// logger.ts:41-47
export interface Exporter {
  colors?: number | false
  maxLength?: number
  levels?: Record<string, number>
  formatters?: Record<string, Formatter>
  export(message: Message): void
}
// logger.ts:64-71
export interface LoggerOptions { name: string; meta?: Partial<Message>; level?: number }
// logger.ts:184-186
export interface LoggerService extends Record<LoggerType, LoggerMethod> {
  (name?: string): Logger
  // + exporter / buffer / bufferSize / level / config / ctx
}
```

- 取子 logger：`lib/index.js:781`（`src/logger.ts` 内 `LoggerService[symbols.invoke]`，`logger.ts:252-262`）——`name ??= config.name ?? hyphenate(fiber.name)`，并挂上 `meta: { fiber: new WeakRef(fiber) }`。所以 `ctx.logger('update')`、`ctx.logger.info(...)` 都合法。
- 注册出口：`logger.ts:232-238` → `exporter(exporter: Exporter)`，内部走 `this.ctx.effect(...)` 返回 disposer，标签 `'ctx.logger.exporter()'`；编译产物在 `lib/index.js:618`。
- 过滤语义（**关键**）：`logger.ts:141-161` 的方法分发里

```js
const targetLevel = exporter.levels?.[this.name] ?? exporter.levels?.default ?? this.level ?? LoggerLevel.INFO
if (targetLevel < level) continue
```

  即 `levels` 只决定**这一个 exporter 自己**收不收，exporter 是叠加的，**一个插件无法通过注册 exporter 压掉别人的日志**。

### 2.2 `ctx.logger` 默认落到哪里：内存缓冲，不打印

`logger.ts:194-271` 的 `LoggerService`：`bufferSize = 1000`、`buffer: Message[]`、`exporters = new Map<number, Exporter>()`；构造函数里注册了**唯一一个内置 exporter**：

```js
// app.asar:dsh/node_modules/@deepseek-ai/cordis/lib/index.js:598-617（源 logger.ts:213-221）
self.exporter({
  colors: 3,
  export: (message) => {
    self.buffer.push(message)
    if (self.buffer.length > self.bufferSize) {
      self.buffer = self.buffer.slice(-self.bufferSize)
    }
  }
})
```

**它只往内存里塞，不写 stdout/stderr/文件。** 全宿主注册 exporter 的地方只有两处：

```
$ node asar-grep.mjs <asar> 'node_modules/@deepseek-ai/' 'logger\.exporter\(|\.exporter\(\{'
dsh/node_modules/@deepseek-ai/cordis/lib/index.js:598
dsh/node_modules/@deepseek-ai/cordis/src/logger.ts:213
dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:4057     ← 启动诊断收集器
（另有 dsh-session-persistence-jsonl/lib/worker.cjs:1215 与
  dsh-web-frontend/dist/assets/index-*.js 里前端打包进来的同一份 cordis 副本）
```

`catalog`/patch yml 里也没有 logger exporter：`grep 'logger' *.yml` 只命中了 `session-log-*` 这类包名。
cordis 的 README 把 console exporter 列为**另一个包**（`README.md:86` 的 `@cordisjs/plugin-logger-console`），该包**不在 DSH 运行时里**；唯一引用它的是 `app.asar:dsh/node_modules/@deepseek-ai/dsh-session-telemetry-otel/package.json:46`，是 `devDependencies`。

⇒ **实际后果**：第三方插件今天写 `ctx.logger.info('...')`，用户在任何地方都看不到（除了那 1000 条内存缓冲，而宿主没有把它暴露成任何服务/命令/GUI 面板 —— 检索未发现读取 `logger.buffer` 的消费者）。

### 2.3 宿主唯一「带包名前缀」的 console：动态包沙箱（不适用于已安装插件）

`app.asar:dsh/node_modules/@deepseek-ai/dsh-cordis-host-runner/lib/types/sandbox.js:16-26`（编译产物同文件 `lib/index.js:1122-1137`）：

```js
/**
 * A write-through console for one package, tagging every line with the package
 * id. Write-through (host stdout/stderr), NOT buffered into the tool result:
 * a registered listener fires long after the run call returned, and its output
 * must land somewhere the user can see — for a terminal entry point, the host terminal.
 */
function taggedConsole(id) {
    const tag = `[cordis:${id}]`;
    const log = (...args) => { console.log(tag, ...args); };
    const error = (...args) => { console.error(tag, ...args); };
    return { log, info: log, warn: log, debug: log, error };
}
```

它在 `createSandbox(id, harnessExtras)`（`sandbox.js:90-106`）里作为 `console` 注入 vm 上下文。`id` 是动态包 id（`dyn-<n>`）。同一个沙箱还禁掉 `require`/`setTimeout`/`setInterval`/`setImmediate`/`clearTimeout`/`clearInterval`/`fetch`（`sandbox.js:61-71`），并让 `process` 保持 `undefined`。
**适用范围仅限「模型用 cordis 工具现写的动态包」**，不适用于 profile 里安装的 npm 插件——那类插件跑在宿主进程里，用的是真 `console`。

### 2.4 宿主里唯一的 exporter 用法样例（可照抄的形态）

`app.asar:dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:4052-4067`：

```js
const ctx = new Context()
const startupLogs = []
const diagnostics = new Context()
diagnostics.logger = ctx.logger
diagnostics.logger.exporter({
  levels: { default: 2 },                    // 只要 warn(2)/error(0)
  export: ({ ts, name, type, args }) => {
    if (type === 'warn' || type === 'error') startupLogs.push({ ts, name, type, args })
  },
})
```

`finally { await diagnostics.fiber.dispose() }`（`lib/index.js:4107`）——用独立 `Context` + `fiber.dispose()` 把临时 exporter 摘干净，这是宿主自己的做法，也是插件想临时接管日志时唯一可照抄的形态。
配套文档：`app.asar:dsh/node_modules/@deepseek-ai/dsh-app-boot/README.md:92`（中文版 `README.zh.md:92`）说明这个独立 logger exporter 在异步 dispose 期间仍保留 warn/error 记录，并在 `boot()` settle 之前释放。

---

## 3. 宿主如何呈现插件日志

### 3.1 Desktop 拓扑：插件全在 `dsh-desktop-host` 子进程里

`app.asar:lib/lib/main.js:3671-3697`（Electron 主进程）：

```js
const entry = join(this.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
const child = spawn(this.node, ['--expose-internals', ..., entry, this.runtimeDir, this.projectDir, ...], {
  cwd: this.projectDir,
  env: desktopNodeEnvironment(this.node, void 0, this.environment),
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})
this.child = child
child.stderr?.setEncoding('utf8')
child.stderr?.on('data', (chunk) => {
  this.stderr = (this.stderr + chunk).slice(-65536)
})
child.stdout?.pipe(process.stdout)
```

`app.asar:dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js:216-245`：

```js
async function main() {
  const runtimeDir = process.argv[2]
  const projectDir = process.argv[3]
  ...
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: ['--no-open', '--port', '19387'],
    ...
  })
```

⇒ Desktop 宿主其实是一个跑在 `127.0.0.1:19387` 的**普通 Web 宿主**，profile 里所有插件（含第三方）都在这个子进程内挂载。
⇒ 插件里的 `console.log` / `process.stdout.write` 走 `child.stdout.pipe(process.stdout)`：**打包后的 Windows GUI 应用没有控制台，这部分输出等于丢弃**；`console.error` / stderr 进 `this.stderr` 这**一个 64 KiB 滚动缓冲**，末尾内容只在异常退出时被拼进错误消息（`lib/main.js:3722-3724`）：

```js
child.once('close', (code) => {
  const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
  if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with ${String(code)}${suffix}`))
```

⇒ **全部插件的 stderr 混流、无插件名前缀、只保留最后 64 KiB、只在崩溃时可见。**

Web（`dsh web`）模式另有一条：`app.asar:dsh/node_modules/@deepseek-ai/dsh-web-app/lib/index.js:154` → `if (launcherStderr !== '') process.stderr.write(launcherStderr)`，即宿主把它捕获到的启动 stderr 再转写到自己的 stderr（终端里可见）。
另外注意：`@deepseek-ai/dsh-web` 这个包**不是 Web 宿主**，它是 `ctx.web`（网页搜索/抓取）能力服务（`dsh-web/lib/index.js:41` `class WebRuntime extends Service`）——别被包名误导。

### 3.2 宿主日志文件路径与命名规则

**(a) CLI 启动失败诊断** —— `app.asar:dsh/lib/bin.js:158-194`：

```js
export async function reportStartupFailure(error, context, write = writeStderr) {
  ...
  const logDir = join(context.home, 'logs')
  const logPath = join(logDir, `startup-${now.replaceAll(':', '-')}-${randomUUID()}.log`)
  ...
  await mkdir(logDir, { recursive: true, mode: 0o700 })
  ...
  await writeFile(logPath, report, { flag: 'wx', mode: 0o600 })
```

调用点 `bin.js:223-231`（runCli 捕获后 `process.exit(1)`）。报告头部带原文警告：`WARNING: Raw diagnostics may contain configuration or credential values from plugin errors. Review before sharing.`
⇒ 一次启动失败一个文件，**`wx` 独占创建 + UUID**，不可能互相覆盖；`~/.dsh/logs/` 根下。

**(b) Electron 崩溃报告** —— `app.asar:lib/lib/main.js:7702-7717`：

```js
async function writeCrashReport(directory, input) {
  const path = join(directory, crashReportFileName(input.time, input.source))
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(path, renderCrashReport(input), { mode: 0o600, flag: 'wx' })
    return path
  } catch (error) { console.error('dsh desktop: crash report could not be written', path, error); return }
}
```

命名规则 `lib/main.js:7609`：

```js
const CRASH_REPORT_NAME = /^crash-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(?:host|web-boot|renderer|main)\.log$/u
```

目录是 `app.getPath("logs")`（调用点 `lib/main.js:10990`、`:11182`），保留 10 份（`pruneCrashReports(directory, retained = 10)`，`lib/main.js:7726-7742`，只删匹配 `CRASH_REPORT_NAME` 的）。本机 `C:\Users\辰辰洋洋\AppData\Roaming\DeepSeek Harness\logs` **当前不存在**（还没崩过）。

**(c) 插件管理器（安装/删除/github 探测）** —— `app.asar:dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:441-447`：

```js
const logRoot = join(dir, '.plugin-manager', 'logs')
...
const logPath = join(await mkdtemp(join(logRoot, 'operation-')), 'pnpm.log')
const log = await open(logPath, 'wx', 0o600)
```

github 连接检查同理：`lib/index.js:973-979` → `mkdtemp(join(logRoot, 'github-connection-'))`，`git.log` 用 `'ax+'` 打开。
文档：`app.asar:dsh/node_modules/@deepseek-ai/dsh-plugin-manager/README.md:133` —— "Diagnostic logs remain under the profile's `.plugin-manager/logs` directory."（中文 `README.zh.md:133` 同义）。
本机实测存在 `C:\Users\辰辰洋洋\.dsh\profiles\desktop\.plugin-manager\logs\operation-*\` 与 `github-connection-*\`。
失败时给模型的提示就是指向该文件：`app.asar:dsh/lib/plugin-BGnVfe_D.js:96` → `process.stderr.write(\`dsh: plugin command failed; diagnostics: ${result.logPath}\`)`。

**(d) 判断：会不会写进同一个文件、是否交错、有无前缀**

| 宿主自有的落点 | 命名 | 是否可能撞车 | 有无插件前缀 |
|---|---|---|---|
| `~/.dsh/logs/startup-*.log` | 时间+UUID，`wx` | 不可能 | 无（内容是宿主诊断报告） |
| `<app logs>/crash-*.log` | 时间+来源，`wx` | 不可能（同毫秒同来源才可能，`wx` 会 throw 而不是覆盖） | 无 |
| `<profile>/.plugin-manager/logs/operation-*/pnpm.log` | `mkdtemp` 唯一目录 | 不可能 | 无（按次操作分目录） |
| Desktop 子进程 stderr | 无文件，64 KiB 内存环形 | **必然混流** | **无前缀** |
| Desktop 子进程 stdout | 无文件，pipe 到 Electron stdout | GUI 下丢弃 | 无 |
| `ctx.logger.*` | 无文件，1000 条内存环形 | 共用一个缓冲，会互相挤出 | `Message.name` 字段有名字，但没人展示 |

### 3.3 Web GUI：没有插件日志面板

- 客户端包里唯一和「日志」有关的设置界面是 `@deepseek-ai/dsh-client-ui-settings-session-log`，它只是**「在使用官方模型 API 时上传 Session Log」的开关**（`app.asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-session-log/lib/client.js:115-127`，中文文案 `"title": "在使用官方模型 API 时上传 Session Log"`）。Session Log 指的是**对话记录**，不是插件诊断日志。
- 客户端里唯一另一个「日志」是下载对话日志：`app.asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-commands/lib/client.js:91` → `"label.export": "下载日志"`（对应 `@deepseek-ai/dsh-session-log-export`，导出 Session 记录）。
- 官方对「插件安装失败在 GUI 里看不到原因」的说法：`app.asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/README.zh.md:150` ——
  > - **行只显示阶段，不显示原因**——失败的行只显示为失败，没有 Host 的错误文本；Host 日志里有。
- 宿主**没有**给插件 stdout/stderr 做任何 console 劫持：`grep 'console\.(log|info|warn|error)\s*=|globalThis\.console'` 扫 `@deepseek-ai/*` → `scanned=2606 hits=0`。

⇒ 插件想在 GUI 里露出日志，只能自己走 Client 半（slot / 自己的 UI），宿主不提供现成面板。

---

## 4. DSH 官方文档/约定

宿主随包发的「官方文档」就是各包的 `README.md` / `README.zh.md`（本次解包范围内有 57 份 md），以及 `dsh-agent-preset` 里给 agent 用的 skill：

**(a) 插件开发 skill** —— `app.asar:dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/SKILL.md`（50 行）
**通篇没有一句讲日志**（全文没有 `logger`/`log`/`console` 相关指引；grep 该 skill 目录下所有 md，只有 `cordis-composition-reference/references/packages.md` 里把 `*session-log*` 当包名列出）。与日志最相关的三条原文：

- `SKILL.md:32`
  > Source: installed packages ship built `lib/index.js` and `lib/types/**/*.d.ts` with JSDoc under that same `packageDir`, not `src/`; a source checkout of DSH has `packages/<group>/<name>/src`. Read them when inspection and the README leave a question open, and start source-level diagnosis from a concrete installation or runtime failure.
- `SKILL.md:34`
  > `DSH_PROFILE` (profile name) and `DSH_PROFILE_DIR` (its directory, whose `node_modules` holds only profile-installed bundles) are set in every shell call of a profile-launched Harness and absent when the Harness was booted without a profile.
- `SKILL.md:38`（解释了为什么 asar 读不到，也是本文取证的依据）
  > In Desktop the directory sits inside `app.asar`, which only the Host process's own file reads can open; shell commands (`ls`, `cat`, `cp`, `cmp`), the glob and search tools (they run a native ripgrep process), `node`, and pnpm all fail on it.
- 同目录其它参考：`references/host-plugin.md`、`references/ui-plugin.md`、`references/mcp-bundle.md`、`references/practices.md`、`references/user-actions.md`、`references/verification.md`、`templates/decoration/*`。
- `references/practices.md:7`
  > 1. **The session log is the only source of truth.** Anything the model sees must be reconstructable from committed session events; fork, resume, and replay derive from the log. Plugin memory is a derived cache.
  （这里的 "session log" 是会话事件日志，同样不是插件诊断日志；插件日志在官方文档里没有位置。）
- 另一份参考：`app.asar:dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md`（38782 B）是包目录表；`.../cordis-composition-reference/SKILL.md`、`.../editing-cordis-compositions/SKILL.md` 讲 loader patch 方言。

**(b) 各包 README 里与日志有关的段落**
- `app.asar:dsh/node_modules/@deepseek-ai/dsh-app-boot/README.md:92`：独立 logger exporter 在异步 dispose 期间保留 warn/error 记录，并在 boot 之前释放（§2.4 已引）。
- `app.asar:dsh/node_modules/@deepseek-ai/dsh-plugin-manager/README.md:133`：诊断日志留在 profile 的 `.plugin-manager/logs`。
- `app.asar:dsh/node_modules/@deepseek-ai/dsh-plugin-manager/README.md:150`：恢复操作只改两个快照文件，诊断日志与 pnpm 下载物不动。
- `app.asar:dsh/node_modules/@deepseek-ai/dsh-fs-sandbox/README.md:46` / `:75`：`workspace-write` 只允许写到 workspace 根之下或平台临时区（`/tmp`、`os.tmpdir()`），可写集由唯一的 `writableRoots` 派生，与 Seatbelt profile 共享 —— 这解释了为什么插件不能靠 `ctx.fs` 写 `~/.dsh`（§5 里 dsh-prompt 的注释也这么说）。

**(c) 没有的东西**：宿主没有 `docs/*.md` 形式的插件日志约定，没有 `dsh-log` 的官方集成说明，也没有「插件日志级别」这套配置。

---

## 5. dsh-log 在宿主里的真实用法样例

**宿主没有用 dsh-log，也没有等价的「宿主日志库」给插件用。** 宿主自己的日志实现就是 §2.2 的 cordis `LoggerService`（内存缓冲 + 可注册 exporter）加 §3.2 的三个落点。

要在宿主里落盘，**当前只有第三方插件自己那套**。本机唯一可考的完整实现是 `dsh-prompt`：

文件：`C:\Users\辰辰洋洋\.dsh\profiles\desktop\node_modules\dsh-prompt\lib\log\index.js`（397 行）

最小可复制形态（**已按真实调用顺序摘录**）：

```js
// :5    —— 设计立场
// （`console.*` 与 `ctx.logger.*` 一律收敛到这里，事件清单见仓库根 `event-list.dsh-prompt.json`）。

// :35-37 —— 每个插件一个自己的目录名
const PLUGIN_ID = 'dsh-prompt'
/** 显式覆盖：默认派生是 `logs-dsh-prompt`，本插件要的是 `<home>/logs/dsh-prompt`。 */
const LOG_DIR_NAME = 'dsh-prompt'

// :51-55 —— 自己解析 DSH_HOME（不依赖平台库）
function resolveDshHome(env) {
  const raw = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (raw) return path.resolve(raw)
  return path.join(homedir(), '.dsh')
}

// :67-68 —— 主目录 + 降级目录
const primaryDir = path.join(home, 'logs')
const fallbackDir = options.fallbackDir ?? path.join(tmpdir(), PLUGIN_ID)

// :209-231 —— 动态 import + 建库（deps 形状按 dsh-log INTEGRATION.md 步骤 2）
try { mod = await import('dsh-log/host') }
catch (e) { warnOnce('dep-missing', `dsh-log 装不上（${e?.message || e}），本次不落盘。`); return degradedCapability(...) }

hostLog = mod.createHostLog(
  { fs: sink.fs, getCacheDir: sink.getCacheDir, getPlatform: sink.getPlatform, DEFAULT_CWD: process.cwd() },
  { pluginId: PLUGIN_ID, logDirName: LOG_DIR_NAME, eventList: loaded.ok ? loaded.raw : undefined },
)

// :238 —— 注册「电话」（客户端 → 宿主的调用名）
const phoneNames = mod.registerHostLogPhones(registry, hostLog)

// :249-258 —— 唯一对外写入口
log(event, fields) {
  const res = gate.filter(event, fields)      // 事件闸门：白名单字段，未声明事件整条丢，>1KB 整条丢
  if (!res.ok) return false
  try { store.log(res.level, event, res.fields); return true } catch (e) { return false }
}
```

同一文件里三条对本仓集成**极重要**的原文：

- `:8-11`（为什么不走 `ctx.fs`）
  > 1) 落盘适配器 `createLogSink`：用 `node:fs/promises` 自建 dsh-log 要的文件服务，落 `~/.dsh/logs`。
  >    为什么不走 `ctx.fs`：它的围栏只挂 `writeText`/`editText`，workspace-write 的可写集不含 `~/.dsh`，
  >    而且它连 `mkdir`/`unlink` 都没有（建目录与清空都做不到）。依据：ADR 0001 与 #46 调研。
  >    主目录写不进去就降级到 `os.tmpdir()/dsh-prompt`，再失败就彻底不落盘、只往 stderr 告警一次。
- `:21-22`（失败语义）
  > 失败语义：日志能力**不许拖垮插件**。dsh-log 装不上、清单读不出、目录写不进，都只降级或往 stderr 告警一次；
  > 调用方拿到的实例永远可用（最差是空操作），HTTP 路由据此回一个明确的失败结构，不静默。
- `:389`（多实例立场）
  > （dsh-log 明确警告多实例同写会写坏文件；本仓既有做法见 lib/index.js 的 STORE_KEY）。

相关配套：`dsh-prompt\lib\log\gate.js`（10814 B，事件闸门：字段白名单、未声明事件整条丢弃、单条 >1KB 丢弃、清单不可用时「失败关闭」只放行事件名与级别）；`dsh-prompt\lib\log\index.js:33` → `export const LOG_ROUTE_PATH = '/_dsh/dsh-prompt/log'`（客户端经 HTTP 桥把日志交回宿主）；单例键 `:38` `const SINGLETON_KEY = '__dshPromptLogCapability'`。

### dsh-log 0.3.1 的对外形态（集成目标版本）

来源：`D:\dsh-plugin\dsh-plugin-update\.tmp\dsh-log-research\pkg\package\dist\host.d.ts`

```ts
export interface HostLog { store: LogStore; phoneNames: PhoneNameMap }
export declare function createHostLog(deps: LogStoreDeps, configInput: HostLogConfigInput): HostLog
export declare function registerHostLogPhones(registry: PhoneRegistry, hostLog: HostLog): PhoneNameMap
export declare const HOST_LOG_PHONE_ACTIONS: readonly
  ['logBatch','logExport','logClear','logGetSwitch','logSetSwitch','logQuery']
export { LOG_DIR_NAME, LOG_SWITCH_FILE, formatDailyFileName, formatLogFileName, createLogStore }
```

- 常量：`dist/config/constants.js:20` → `export const LEGACY_LOG_DIR_NAME = 'logs'`；`dist/store.js:25-26` → `export const LOG_DIR_NAME = LEGACY_LOG_DIR_NAME`、`export const LOG_SWITCH_FILE = LEGACY_SWITCH_FILE_NAME`。
- Node 入口（0.2.2 实物，`C:\Users\辰辰洋洋\.dsh\profiles\desktop\node_modules\dsh-log\dist\node.js:78-119`）：
  `createNodeHostLog(deps, configInput)` 强制要求 `deps.cacheDir` 为非空字符串，否则抛
  `"[dsh-log] 建 Node 日志库必须给 cacheDir：日志写到哪由调用方决定，本入口不猜位置"`；
  随后 `await mkdir(cacheDir, {recursive:true})` → `createHostLog({ fs, timer, getCacheDir, DEFAULT_CWD: cacheDir }, configInput)` → `await store.loadSwitch()` → 返回 `{ store, phoneNames, ready }`，
  `ready` 会写一条 `log.flush.marker` 事件并最多 6×10ms 重试 `flushNow()`（落盘自证）。
- 开关文件名派生（0.2.2 `dist/config.js:25`）：`switchFileName = input.switchFileName ?? (pluginId === 'wf' ? LEGACY_SWITCH_FILE_NAME : 'log-switch-' + pluginId + '.json')`，`LEGACY_SWITCH_FILE_NAME = 'log-switch.json'`。
- 一句话记法：`dsh-log/host` 里的「host」是**插件自己的宿主半（Node 侧）**，不是 DSH 应用；客户端半走「电话」（phone）名注册 + HTTP 桥回传。

---

## 6. 环境变量与全局约定

**搜索结论：与日志直接相关的 env 只有 `DSH_HOME`；不存在 `DSH_LOG*`、`LOG_LEVEL`、`DSH_DEBUG`、`DSH_TRACE`、`DSH_VERBOSE`。**

```
$ node asar-grep.mjs <asar> '.' 'DSH_LOG|LOG_LEVEL|DSH_DEBUG|DSH_TRACE|DSH_VERBOSE'
scanned=11269 hits=23   ← 全部落在 vendored 第三方（@modelcontextprotocol 的 LOG_LEVEL_META_KEY、
                          execa 文档里的 LOG_LEVELS 表、一个 @mixmark-io/domino bundle）
```

### 6.1 真正相关的变量

| 变量 | 作用 | 读取位置 |
|---|---|---|
| `DSH_HOME` | Harness home；`~/.dsh` 的覆盖值（空白视为未设置） | `app.asar:dsh/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js:15`（`DSH_HOME_ENV = "DSH_HOME"`）、`:73-84`（`resolveDshHome(configured?, env = process.env)`）、`:91-94`（`dshCachePath`）、`:103-105`（`dshHomeDisplay` → `~/.dsh` 或 `$DSH_HOME`）；宿主把它发布成插件服务：`app.asar:dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:4071` → `ctx.provide("dshHomePath", dshHomePath)` |
| `DSH_PROFILE` / `DSH_PROFILE_DIR` | profile 名与其目录（其 `node_modules` 只放 profile 装的 bundle） | `app.asar:dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/SKILL.md:34` |
| `DSH_TELEMETRY_OTLP_URL` | Session-log OTLP 端点覆盖 | `app.asar:dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:211` → `url: !!js process.env.DSH_TELEMETRY_OTLP_URL ?? 'https://dsh-otel-collector.deepseeksvc.com/v1/logs'` |
| `DSH_TELEMETRY_DISABLED` | 非空即退出遥测（含 `'0'`/`'false'`） | 同上 `:193-196` 注释原文：`A non-empty DSH_TELEMETRY_DISABLED — any value, including '0'/'false' — opts the process out (the launchers patch the row disabled; config cannot disable a row).` |
| `DSH_TELEMETRY_MODE` | Session-log 采集模式，默认 `FEEDBACK_ONLY` | 同上 `:207` → `mode: !!js process.env.DSH_TELEMETRY_MODE \|\| 'FEEDBACK_ONLY'`；`:191-192` 注释：`OTel releases a Session-log prefix only after explicit user feedback, regardless of model provider.` |
| `DSH_PRODUCT_ANALYTICS_OTLP_URL`、`DSH_ANALYTICS*` 一类 | 产品分析上报 | `dsh-host-product-telemetry-otel` |
| `ELECTRON_RUN_AS_NODE`、`DSH_DESKTOP_NODE_EXECUTABLE`、`PATH` | Desktop 子进程环境（不是日志开关，但决定了子进程怎么起） | `app.asar:dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js:236-244` |
| `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER` | `ctx.web` 提供方（无关日志，列出以免误认） | `app.asar:dsh/node_modules/@deepseek-ai/dsh-web/lib/index.js:44-46`、`:57-58` |

全量 `DSH_*` 名单（本次从 asar 内 `@deepseek-ai/*` 抽出的 74 个，供判断命名空间占用）：`DSH_AGENTS_HOME, DSH_APP_VERSION, DSH_BOOT__, DSH_BOOT_READY__, DSH_BUNDLED_PRIMARY_RUNTIME, DSH_BUNDLED_SKILL_DIR, DSH_CLIENT_BUILD_PROFILE, DSH_CLIENT_COMMIT_HASH, DSH_CLIENT_GIT_DIRTY, DSH_CLIENT_TITLE, DSH_CLIENT_VERSION, DSH_CODE_ICON_INSTANCE__, DSH_CONNECTION_RECOVERY__, DSH_CONTACT_CONFIG__, DSH_CONTEXT_WINDOW, DSH_DEPLOYMENT_REGION, DSH_DESKTOP_NODE_EXECUTABLE, DSH_DIALOG_TITLE, DSH_DIRECTORY_PICKER__, DSH_DOCUMENT_PREVIEW_CONFIG__, DSH_ENV_PREFIX, DSH_FILE_UPLOAD__, DSH_HOME, DSH_HOME_DIR_NAME, DSH_HOME_DISPLAY, DSH_HOME_ENV, DSH_HOST_PATHS__, DSH_LAUNCH_ENVIRONMENT_KEY, DSH_LOCALE__, DSH_MAX_TOKENS_AS_SUCCESS, DSH_MODELS_ONBOARDING__, DSH_PERMISSION_MODE, DSH_PERSISTENT_BASH_END_, DSH_PERSISTENT_BASH_START_, DSH_PERSISTENT_PWSH_END_, DSH_PERSISTENT_PWSH_START_, DSH_PLATFORM_ALLOW_LOOPBACK_HTTP, DSH_PLATFORM_COOKIE, DSH_PLATFORM_ORIGIN, DSH_PRIMARY_RUNTIME, DSH_PROCESS_INFORMATION, DSH_PRODUCT_ANALYTICS_OTLP_URL, DSH_PROFILE, DSH_PROFILE_DIR, DSH_PROFILE_DIR_KEY, DSH_PROFILE_KEY, DSH_PTC_RUNTIME_NODE, DSH_PTY_SESSION_ID, DSH_RANK, DSH_REGION, DSH_SESSION_ID, DSH_SESSION_ID_KEY, DSH_SHELL, DSH_SHELL_KEY, DSH_SHORTCUTS_CONFIG__, DSH_SNAPSHOT, DSH_SPEECH_TOKEN, DSH_STARTUPINFOW, DSH_SUBPROCESS_CONTROL, DSH_SUBPROCESS_RUNNER, DSH_SYSTEM_PROMPT, DSH_TELEMETRY_DISABLED, DSH_TELEMETRY_MODE, DSH_TELEMETRY_OTLP_URL, DSH_TOOLS_MODE, DSH_TRANSPORT__, DSH_WEB_FETCH_PROVIDER, DSH_WEB_MODE, DSH_WEB_SEARCH_PROVIDER, DSH_WEB_URL`
→ **`DSH_LOG*` 完全空闲**（但见 6.2 的限制）。

### 6.2 `.env` 能不能设 `DSH_*`：不能

`app.asar:dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:3299-3305`：

```js
function loadEnv(binName, dir = process.cwd(), warn = (line) => void process.stderr.write(line)) {
  try { process.loadEnvFile(resolve(dir, '.env')) }
  catch (error) { if (error?.code !== 'ENOENT') warn(`${binName}: failed to load .env: ${String(error)}\n`) }
}
```

`:3307-3364` 定义 `BOOTSTRAP_NAMES`（含 `NODE_OPTIONS`、`PATH`、各语言注入类变量）与

```js
const BOOTSTRAP_PREFIXES = ['DSH_', 'XDG_', 'DYLD_', 'BASH_FUNC_']
```

`:3385-3388` `isBootstrapOnly(name)`；`:3399+` `readEnvLayer(binName, dir, warn, home)` 在**解析阶段**就拒掉这些名字（发现目录的 `.env` 不许设 `DSH_*`）。
唯一豁免：`DSH_HOME/.env` 可以设 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY`（`:3372-3377` 的 `HOME_LAYER_PROXY_NAMES`）。
⇒ **任何「用 .env 开插件日志开关」的设计在宿主里都不成立**，只能读继承来的进程环境。

### 6.3 分层与快照

`app.asar:dsh/node_modules/@deepseek-ai/dsh-launch-environment/lib/index.js:10-14`：

```js
const SOURCE_ORDER = ['process', 'project-env', 'user-env']
```

`:56` `DSH_LAUNCH_ENVIRONMENT_KEY = 'launchEnvironment'`；`:63-68` `launchEnvironmentOf(ctx)` → `ctx.get('launchEnvironment') ?? 单层 process.env 快照`。
插件应通过它读环境（而不是直接 `process.env`），但日志类开关目前没有任何东西在读。

### 6.4 本机实测的日志落点（第三方插件现状）

```
C:\Users\辰辰洋洋\.dsh\logs\
  dsh-opencode-palette\2026-10-14.log        NDJSON
  dsh-prompt\2026-10-14.log                  NDJSON
  vision-router\vision-router.log            单文件文本（不带日期）
  log-switch-dsh-prompt.json                 {"enabled":false,"sampleRate":1}
  log-switch-dsh-opencode-palette.json       {"enabled":true,"sampleRate":1}
```

三个插件各自的文件首行原文：

```
dsh-opencode-palette\2026-10-14.log:
{"ts":1791916838429,"level":"info","event":"host.call","fields":{"method":"ilife-bill.updateStatus","latencyMs":569,"ok":true,"kind":"update-status","pluginId":"life-bill"}}

dsh-prompt\2026-10-14.log:
{"ts":1791917296758,"level":"info","event":"host.start","fields":{"pid":26392,"startedAt":"2026-10-13T18:48:16.758Z","dir":"C:\\Users\\辰辰洋洋\\.dsh\\logs"}}

vision-router\vision-router.log:
[2026-10-01T16:22:27.804Z] [INFO] vision-router: diagnostics log enabled at C:\Users\辰辰洋洋\.dsh\logs\vision-router\vision-router.log (plugin=2.3.0 node=v24.18.1 platform=win32/x64)
```

两点观察：
1. **没有互相覆盖**，因为每个插件用了**自己的目录名**（三套命名、两种格式并存）。
2. `pluginId` 是**行内字段**、不是文件名：`dsh-opencode-palette` 的日志里在记**别的插件**的宿主调用（`"method":"ilife-bill.updateStatus" ... "pluginId":"life-bill"`）。⇒ 文件按「写者」分，不按「被记录者」分。

另一例（另一个插件自己的方案，非宿主）：`C:\Users\辰辰洋洋\.dsh-mattskillsdeck-cache\logs\` 用 `.2026-10-14.log.32988.<uuid>.tmpdir` 这种 lock 目录。

---

## 7. 风险点：多插件并行时「日志互相覆盖」的真实机制

逐条给证据；推不出的标「未证实」。

### 7.1 已证实：dsh-log 自己的目录租约**不跨进程、也不跨模块副本**

`D:\dsh-plugin\dsh-plugin-update\.tmp\dsh-log-research\pkg\package\dist\engine\dir-lease.js:4-8`（原文注释）：

> // S4 第一块：从 store.ts 原样搬出，行为零变化。它是**模块副本级**状态：每个模块副本一份登记表，
> // 同进程里两份 dist 互相看不见，跨进程更是零保护（README 已如实写明这是风险提示而非保证）。

```js
const dirHolders = new Map()       // :8   登记表就是这一个模块级 Map
export const DIR_LEASE_WAIT_MS = 200   // :13  写盘租约等待预算
```

- `normalizeLogDir(dir)`（`:17-54`）在 Windows 上把 key 转小写，注释（`:14-16`）说明理由：
  > 同一目录的不同写法必须撞成同一个键：否则同一文件会被当成两个目录各自加锁，两个活跃写者并发读改写它，后落盘的那次整篇快照会静默覆盖前一次（两侧丢弃计数都是 0，没有任何提示）。
- 冲突文案（`:56-59`）：
  > `'[dsh-log] 该' + (noun || '目录') + '已有活跃写者：' + dir + '；同一目录多实例会互相覆盖日志。若上一个实例已结束，请先 release() 再接管。'`
- 登记时机（`dist/store.js:391-418`）：建库最后一步，**日志目录**与**开关文件**各占一份常驻持有，各自 `otherHolderKind(...)` 撞车即抛，且「两份持有必须一起成功或一起失败」（否则抛错的目录被永久毒化）。
  `store.js:393` 注释：`不同 pluginId 派生到不同目录，照常并存`。

⇒ 只要两个插件把 `pluginId`（进而派生的目录）设成不同值，dsh-log 层面就互不干扰；**同样的 pluginId / 同一个日志目录 / 同一个 cacheDir 的两个实例，同进程同副本会被租约挡住抛错，跨进程或跨副本（pnpm 装出两份 dsh-log）则完全无保护。**

### 7.2 已证实：同一文件并发 append 只有 ≤4096 字节才近似原子

`...\.tmp\dsh-log-research\pkg\package\dist\engine\io.js:5-13`（原文注释）：

> // 为什么要有它：`appendText` 走的是 O_APPEND 写，而**大块写不保证原子**——两个进程各自
> // `appendFile` 一大段时，一个的字节会被插进另一个中间，落成半行 JSON。实测
> // （`.local/probe-append-big.mjs`，两个真子进程、各 20 行、每行 pad 到 64KB）：40 行里 2 行读不出来；

```js
export const APPEND_ATOMIC_MAX = 4096   // :13
export function splitForAppend(text)    // :20-45  按行边界切到 ≤4096 字节
```

⇒ 这是**缓解**不是保证：两个写者写同一文件仍然会互相插字节（只是缩到 4KB 以内）。

### 7.3 已证实（宿主侧）：所有插件的 stderr 共用一个 64 KiB 环形缓冲

`app.asar:lib/lib/main.js:3693-3696` `this.stderr = (this.stderr + chunk).slice(-65536)`；
`:3697` `child.stdout?.pipe(process.stdout)`；
`:3722-3724` 只在退出码非 0 时把 `this.stderr` 拼进错误消息。
⇒ **后写的把先写的挤掉（last-writer-wins，按字节）**，且没有插件名前缀，无法归因。这是"多插件并行时日志互相覆盖"在宿主侧的**真实机制**。

### 7.4 已证实（宿主侧）：所有 `ctx.logger` 消息共用一个 1000 条环形缓冲

`app.asar:dsh/node_modules/@deepseek-ai/cordis/src/logger.ts:213-221`（编译产物 `lib/index.js:598-617`）：

```js
self.exporter({
  colors: 3,
  export: (message) => {
    self.buffer.push(message)
    if (self.buffer.length > self.bufferSize) self.buffer = self.buffer.slice(-self.bufferSize)
  }
})
```

`bufferSize = 1000`。⇒ 一个话多的插件会把别的插件的记录**挤出缓冲**。`Message.name`（`:30-38`）确实带 fiber 名，但宿主没有把它暴露给任何消费方（未发现读取 `logger.buffer` 的服务/命令/GUI 面板）。

### 7.5 未证实/不成立的风险（排除项）

- **「注册一个 exporter 会压掉别人的日志」——不成立。** `logger.ts:141-161` 的 `targetLevel` 只看 exporter 自己的 `levels?.[name] ?? levels?.default ?? this.level ?? INFO`，每个 exporter 独立判定，叠加注册互不影响。
- **「宿主会劫持 console」——不成立**（`grep 'console\.(log|info|warn|error)\s*=|globalThis\.console'` over `@deepseek-ai/*` → `hits=0`）。
- **「宿主的日志文件互相覆盖」——不成立/未证实**：三个落点分别是 `flag:'wx'` + UUID、`flag:'wx'` + 时间戳 + 来源、`mkdtemp` 唯一目录（§3.2）。唯一理论缺口是「同一毫秒、同一来源同时写两份崩溃报告」，此时 `wx` 会抛错而不是覆盖（`lib/main.js:7709-7712`）。
- **「GUI 只显示最后一条日志」——未证实**：GUI 里根本没有插件日志显示面（§3.3），问题不存在。
- **「都用同一个 env 变量做开关」——未证实**：宿主没有任何插件日志开关 env（§6.1/6.2 全量名单）。开关是各插件自己的东西（本机实测：`log-switch-<pluginId>.json`，见 6.4）。

### 7.6 结论：不互相覆盖的唯一可靠做法

宿主不提供隔离，**唯一被实测验证有效的机制是「每个插件一个唯一的目录名 / 文件名」**：
`<home>/logs/<pluginId>/<date>.log`（dsh-log 的 `pluginId` + 显式 `logDirName`），开关文件也按 `pluginId` 分开（`log-switch-<pluginId>.json`），同一进程内再叠一层单例键（`dsh-prompt` 的 `SINGLETON_KEY = '__dshPromptLogCapability'`）。

---

## 证据索引

**asar 内路径**（前缀 `D:\DeepseekHarness\resources\app.asar\`；解包副本在 `D:\dsh-plugin\dsh-plugin-update\.tmp\dsh-host-research\host-src\`）

- `dsh/package.json` — 宿主版本 `0.2.0-rc.2`
- `dsh/lib/bin.js:142-149`（writeStderr）、`:158-194`（reportStartupFailure，`~/.dsh/logs/startup-*.log` + `wx`）、`:223-231`（runCli 调用点）
- `dsh/lib/plugin-BGnVfe_D.js:96` — `dsh: plugin command failed; diagnostics: ${result.logPath}`
- `dsh/node_modules/@deepseek-ai/cordis/src/logger.ts:13,16,22-27,30-38,41-47,64-71,141-161,184-186,194-271,213-221,232-238,252-262`
- `dsh/node_modules/@deepseek-ai/cordis/lib/index.js:598-617,618`
- `dsh/node_modules/@deepseek-ai/cordis/README.md:47,86`
- `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:3299-3305,3307-3364,3372-3377,3385-3388,3399+,4052-4067,4071,4107`
- `dsh/node_modules/@deepseek-ai/dsh-app-boot/README.md:92`（`README.zh.md:92`）
- `dsh/node_modules/@deepseek-ai/dsh-cordis-host-runner/lib/types/sandbox.js:16-26,61-71,90-106`（`lib/index.js:1122-1137`）
- `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js:216-245,236-244`
- `dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:188-218`（otel / session-telemetry-otel / `DSH_TELEMETRY_*`）
- `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/SKILL.md:32,34,38`
- `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:7,26`
- `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md`（包目录，含 `dsh-client-ui-settings-session-log`、`dsh-session-log-export`、`dsh-otel`）
- `dsh/node_modules/@deepseek-ai/dsh-fs-sandbox/README.md:46,75`（`README.zh.md:75`）— `workspace-write` 可写集不含 `~/.dsh`
- `dsh/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js:11,15,73-84,91-94,103-105`
- `dsh/node_modules/@deepseek-ai/dsh-launch-environment/lib/index.js:10-14,56,63-68`
- `dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:441-447,973-979`；`README.md:133,150`（`README.zh.md:133`）
- `dsh/node_modules/@deepseek-ai/dsh-web/lib/index.js:41,44-46,57-58`（`ctx.web`，非 Web 宿主）
- `dsh/node_modules/@deepseek-ai/dsh-web-app/lib/index.js:154`（launcherStderr）
- `dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-session-log/lib/client.js:115-127`
- `dsh/node_modules/@deepseek-ai/dsh-client-ui-commands/lib/client.js:91`（`"label.export": "下载日志"`）
- `dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/README.zh.md:150`
- `dsh/node_modules/@deepseek-ai/dsh-session-telemetry-otel/package.json:46`（`cordis-plugin-logger-console` 只在 devDependencies）
- `lib/lib/main.js:3671-3697,3693-3696,3697,3722-3724,7598-7609,7647,7702-7717,7726-7742,10990,11182`

**磁盘绝对路径**

- `C:\Users\辰辰洋洋\.dsh\profiles\desktop\node_modules\dsh-log\dist\node.js:78-119`（`createNodeHostLog` + cacheDir 强制）
- `C:\Users\辰辰洋洋\.dsh\profiles\desktop\node_modules\dsh-log\dist\config.js:25`（`switchFileName` 派生）
- `C:\Users\辰辰洋洋\.dsh\profiles\desktop\node_modules\dsh-prompt\lib\log\index.js:5,8-11,21-22,33,35-38,51-55,67-68,93-104,209-231,238,249-258,389`
- `C:\Users\辰辰洋洋\.dsh\profiles\desktop\node_modules\dsh-prompt\lib\log\gate.js`（事件闸门）
- `C:\Users\辰辰洋洋\.dsh\profiles\desktop\pnpm-lock.yaml:823,2350,2377,2387`（`dsh-log@0.2.2`）
- `C:\Users\辰辰洋洋\.dsh\logs\{dsh-prompt,dsh-opencode-palette,vision-router}\`、`log-switch-*.json`（§6.4 实测）
- `D:\dsh-plugin\dsh-plugin-update\package.json`（无 runtime dependencies）
- `D:\dsh-plugin\dsh-plugin-update\.tmp\dsh-log-research\pkg\package\dist\{host.d.ts, store.js:25-26,391-418, config/constants.js:20, engine/dir-lease.js:4-8,13,14-16,17-54,56-59, engine/io.js:5-13,20-45}\`
- `D:\dsh-plugin\dsh-plugin-update\.tmp\dsh-host-research\{asar-tool.mjs, asar-grep.mjs, host-src\}`（本次取证工具与解包副本）

**命令输出原文**

- `node asar-grep.mjs <asar> '.' 'dsh-log'` → `scanned=11269 hits=0`
- `node asar-tool.mjs list <asar> 'dsh-log'` → `TOTAL_ENTRIES=12967 MATCHED=0`
- `node asar-tool.mjs extract <asar> 'dsh/node_modules/@deepseek-ai/dsh-log' ...` → `EXTRACTED=0`
- `node asar-grep.mjs <asar> 'node_modules/@deepseek-ai/' 'console\.(log|info|warn|error)\s*=|globalThis\.console'` → `scanned=2606 hits=0`
- `node asar-grep.mjs <asar> '.' 'DSH_LOG|LOG_LEVEL|DSH_DEBUG|DSH_TRACE|DSH_VERBOSE'` → `scanned=11269 hits=23`（全部 vendored 第三方）
- `node asar-grep.mjs <asar> 'node_modules/@deepseek-ai/' 'logger\.exporter\(|\.exporter\(\{'` → 仅 cordis 内置缓冲 + `dsh-app-boot/lib/index.js:4057`（+ 前端 bundle 内的 cordis 副本、session-persistence worker 副本）
- `npm ls -g --depth=0`、`npm root -g` → 见 §1（无 dsh-log）
