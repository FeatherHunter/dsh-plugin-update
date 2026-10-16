# 合规降级（年龄门拦住 → 装"满门限的最新版"）与现有框架的贴合度调研

- 日期：2026-10-16；源码版本：`dsh-plugin-update@0.18.5`（`package.json:2`）。
- 方法：只读 `src/`、`tests/`、`docs/`、`package.json`、`README.md`；行号均为当前工作区实测。
- 前置结论先行：**降级设计可整体寄生在现有链路上**，核心新增只有三处（"候选版决议"取数、"按非 latest 版安装"的凭证、降级文案 key）；但**有一处现有框架明确不支持、必须宿主配合**（见 §6.1）。

背景（已确认的合规前提，不属本包）：bypass（调宿主门限）已被否决，fallback（registry `time` 元数据挑版）可行；算法是 `dist-tags.latest` → `time` 倒序取超 24h 的最新版，无满足则如实报告不调门。出处：`docs/research/20261016-minimumReleaseAge-bypass-vs-fallback.md`。

---

## 1. 安装执行链：从按钮到宿主的那条路

### 1.1 五个 RPC 口（宿主侧唯一入口表）

- 电话名只从前缀派生，拼法冻结在 `src/config.ts:161-170`（`buildPhoneNames`）：`{prefix}.updateStatus` / `.updateCheck` / `.updateInstall` / `.updateChangelog` / `.logAppend`。另有 `buildLogAppendPhoneName`（`src/config.ts:173-175`）、`buildChangelogPhoneName`（`src/config.ts:178-180`）、`buildPhoneName`（`src/config.ts:183-185`），面板/批量/HTTP 侧复用，**不写字面量**。
- 宿主侧路由表在 `src/host.ts:1280-1297`：`updateStatus→readStatus`、`updateCheck→readCheck`、`updateInstall→runInstall`、`updateChangelog→readChangelog`、`logAppend→logAppendRows`（后者直进表，不经 `loggedPhone`，`src/host.ts:1229-1232`）。
- `updateStatus/updateCheck/updateInstall` 三支经 `loggedPhone` 包裹（轮询抑制只对 `updateStatus` 生效，`src/host.ts:877-883`）。

### 1.2 一次"按指定版本安装"的完整调用链

面板 `mountUpdatePanel` 内 `case 'install'`（`src/panel.ts:2925-2999`）→ `call(updateInstall, { checkId, requestId, ...queueArgs() })`（`src/panel.ts:2958-2962`）→ 宿主 `runInstall`（`src/host.ts:1152-1215`）→ 核心 `install({ checkId, requestId, from })`（`src/service.ts:887-940`）→ 后台 `runBackground`（`src/service.ts:829-885`）→ `ports.runInstall({ version, profileName, environmentKind, releaseChannel })`（`src/service.ts:833`）→ 默认实现 `createUpdateExecutor`（`src/store.ts:1448-1477`）→ `installRecipe` 定路由（`src/commands.ts:140-180`）→ 三条 runner 之一（`src/store.ts:1433-1437`）：`desktop-service`（`src/store.ts:1215-1233`）、`desktop-manager`（`src/store.ts:1350-1397`）、`cli-process`（`src/store.ts:1401-1426`）。

安装按钮（`install-button` 入口）是**第二条同形链路**：`doInstall`（`src/install-button.ts:843-939`）→ 同样的 `updateCheck`/`updateInstall` 电话（`src/install-button.ts:852/895`）。

### 1.3 `targetVersion` 的流转（冻结证据，不是执行参数）

1. 唯一写入点：核心 `install()` 内 `targetVersion: checked.release.version`（`src/service.ts:916-922`）。**目标版恒等于 check 结论里的 release 版**，调用方传不进来。
2. 执行消费：`runBackground` 把 `job.targetVersion` 交给 `ports.runInstall({ version: job.targetVersion … })`（`src/service.ts:833`）；执行器再经 `installRecipe({ version })` 编成 `pluginArgs: ['add', '--save-exact', '{pkg}@{version}', …]`（桌面/manager 形状见 `src/commands.ts:160-179`）。
3. 队列占位写 `targetVersion: null`（`src/host.ts:1180/1192`，`enqueueInQueue`；注释明示"仅作展示用，不参与身份判定"，`src/queue.ts:126`）。
4. 面板/按钮侧只读：`jobTargetOf(job)` 从快照 `job.targetVersion` 取（`src/panel.ts:2404-2412`），锁存里冻结为"失败那次装的是哪一版"（`src/panel.ts:2071-2072` 注释，写入见 `src/panel.ts:2431/2455`）。
5. 批量侧消费点：`ready/skipped` 相存 `targetVersion: checked.version`（`src/batch-run.ts:175/181`，`src/host-batch.ts:1232-1241/1366-1370`）；面板批量行 CTA 渲染 `@targetVersion`（`src/panel-batch.ts:475-476`，回退 `src/panel-batch.ts:525/1360`）。

**对降级的含义**：`targetVersion` 今天是"查到啥装啥"的单向管道。降级（装一个比 latest 老的版）**不能复用这条赋值**——`service.ts:919` 写死 `checked.release.version`，且宿主 `runInstall` 的 RPC 入参只有 `{ checkId, requestId, from, enqueueOnly, cancelQueued, …队列口径 }`（`src/host.ts:1152-1165`），**没有 version 字段**。降级必须另给"候选版"一条进核心的路（新造，见 §6）。

---

## 2. 检查链：四个版本号谁在何时写

### 2.1 `checked`（核心内存，单槽）与凭证

- `check()` 成功后写单槽 `checked = { release, checkId, checkedAt, expiresAt, installationKey, blockedReason }`（`src/service.ts:786-793`）；`blockedReason` 此处只可能是 `incompatible-node` 或 null（Node 范围判定，`src/service.ts:792`）。
- 凭证只在 `canInstall` 时交（`src/service.ts:794/806`，`toReceipt` 在 `src/service.ts:823-827`）；失败时把旧凭证作废（`src/service.ts:808`）。
- 2 秒内重复查复用上次结果（`RECHECK_WINDOW_MS`，`src/service.ts:34`；`src/config.ts:45` 有同名常量）。

### 2.2 四个版本字段的写入点

| 字段 | 谁写 | 何时 | 行号 |
|---|---|---|---|
| `runningVersion` | `ports.readRunningVersion()`，每次 `buildSnapshot` 现读 | 每次快照 | `src/service.ts:636`；读取器注入见 `src/reader.ts:401` |
| `installedVersion` | `readInstalled()`（读盘：`profileDir/node_modules/{pkg}/package.json` 的 `version`） | 每次 `status/check/install` 入口 | `src/reader.ts:325-349`（`result.installedVersion = …manifest.version` 在 `:349`） |
| `latestVersion` | `checked.release.version` | `buildSnapshot` 组装快照时 | `src/service.ts:669` |
| `job.targetVersion` | `install()` | 安装意图过闸后 | `src/service.ts:919` |

- `canInstall` 五合一（`src/service.ts:657-664`）：`eligible && !blockedReason && !busy && receipt新鲜 && installationKey一致 && (在场 newer / 缺席 remoteOk)`。`newer` 要求远端**严格大于**运行版（`src/service.ts:644-649`）——降级版（老于运行版）天然过不了此门，**需新造判定分支**（见 §6）。
- `runningVersion` vs `installedVersion` 不一致 → `pending-restart` 阻拦（`src/service.ts:631`；读盘侧 `src/reader.ts:394`）。
- 快照恒带 `manual`（手工兜底命令）：`snapWithManual`（`src/host.ts:683-693`）→ `manualOfEnv`（`src/host.ts:660-681`）→ `manualCommand`（`src/commands.ts:189-212`）。注意 `manualCommand` 的 picks 只取 `[latestVersion, jobTargetVersion, installedVersion]` 中**通道允许且 ≥ runningVersion 的最高者**（`src/commands.ts:198-207`），**永不产出降级命令**——降级的手工命令需新逻辑（见 §6）。

---

## 3. 失败证据链

### 3.1 `job.message`：`code: 原话` 单通道

- 后台失败时 `message = code + ': ' + detail`（`src/service.ts:867-869`）；无 detail 即裸码。基码只取三选一（`installation-changed` / `registry-conflict` / `install-failed`，`src/service.ts:863-864`）。
- README 第 12 节明示消费契约："匹配请匹配前缀错误码，不要整串相等"（`README.md:587`）；装不上时任务说明形如 `install-failed: <原话>`（`README.md:462`）。
- 面板从 `message` 反拆：`messageCodeOf` 取冒号前缀（`src/panel.ts:939` 导出，定义在附近）；`latchFromJob` 取冒号后为 `detail`（`src/panel.ts:2442-2443`），`code` 取前缀（`src/panel.ts:2445`）。

### 3.2 三条锁存链路的形状差异（panel vs install-button）

面板 `FailureLatch`（`src/panel.ts:2061-2079`，跨重挂模块级 `Map` 存活，`src/panel.ts:2081`）：

- `latchFromReply`（`src/panel.ts:2413-2439`）：失败回包 → `code = failureCodeOf({error, errorKind})`（install 源缺省 `install-failed`），`detail: null`（回包无 detail 位），`diag` 原样保留，`requestId/checkId` 只在 install 源记录，`targetVersion = jobTargetOf(reply.snapshot)`。
- `latchFromJob`（`src/panel.ts:2440-2463`）：后台结局（轮询见 `failed/interrupted`）→ 从 `job.message` 拆 code/detail，`diag` 沿用既有（快照里没有 diag，`src/panel.ts:2448-2449`），`targetVersion = jobTargetOf({job})`，`jobId` 记录。
- `userThrowLatch`（`src/panel.ts:2477-2498`）：抛错 → `code` 按源写死，`detail = thrownDetail(err)`（裸码不算人话，`src/panel.ts:2465-2476`），`targetVersion: null`。
- `volatileLatch`（`src/panel.ts:2499-2519`）：瞬态读失败，成功即治愈。

安装按钮的锁存是**同形子集**（`InstallButtonLatch`，`src/install-button.ts:399-415`，无 `jobId`；另有 `busyAct` 独立、`volatile/atMs` 同理）：关键差异是**抛错锁存的 `targetVersion: null`**（`src/install-button.ts:921`；check 链路同理 `src/install-button.ts:833/872`），而面板在回包/job 两条路上能冻结到来龙去脉的 `targetVersion`。降级设计若要在按钮上展示"降到哪一版失败"，需把面板的 `jobTargetOf` 回填动作抄过去（复用点，见 §5）。

锁存单调性（两边同理，面板为范本）：`applyStatusReply`（`src/panel.ts:2735-2811）——`update-busy` 不锁存不清除（`src/panel.ts:2787-2789`）；后台 `failed/interrupted` 单调置入、同语义去重（`src/panel.ts:2761-2770`，`latchSameFailure` 在 `src/panel.ts:2548-2567`）；三元组变化/成功终态/新一轮在途才清（`src/panel.ts:2755-2783`）；`#100` 回归：三元组变了旧失败不复活（`src/panel.ts:2763-2765`）。

静默续查（两边同形，#150）：至多一次，过期凭证即重查+新凭证重装；查回 ok 却无收据时**绝不伪造 `check-expired`**（面板 `src/panel.ts:2931-2932/2947-2952`；按钮 `src/install-button.ts:844-847/882-887`）。

### 3.3 `detail` 摘要：截断与前置各发生在哪一层

1. **宿主原话入口**：执行器三条 runner 的失败经 `withDetail(fail('install-failed'), detailText(…))` 挂 `error.detail`（manager 路 `src/store.ts:1392/1395`；超时 `src/store.ts:1385`；取消 `src/store.ts:1391`），`createUpdateExecutor` 的 catch 把 `detail` 原样上抛（`src/store.ts:1467-1474`；注释明示"已截断脱敏随错误一起上抛"，`src/store.ts:1469`）。
2. **截断+脱敏**：`sanitizeDetail` = 压平空白 → URL 用户信息命中整项丢弃 → 路径/令牌/键值/邮箱四规则 → **300 字**封顶（`src/redaction.ts:193-198`；预算 `DETAIL_MAX_CHARS = 300` 在 `src/redaction.ts:34`；落刀语义 `truncateToWordBoundary` 在 `src/redaction.ts:160-171`）。
3. **原因行前置**（只对 `install-failed`）：`pickDetail` 内 `hoistCauseLines(rawDetail)` 先行、再 `sanitizeDetail`（`src/diag.ts:303-311`，前置 rito 在 `src/diag.ts:309`）。`hoistCauseLines`（`src/diag.ts:275-299`）按失败标记正则（`CAUSE_LINE_RE`，`src/diag.ts:272-273`）把原因行提前面，其余不动——因为"工具输出头重脚轻而预算截断只保头"（注释 `src/diag.ts:307-308`）。
4. 复制形态用另一预算：`sanitizeForCopy` 同规则同顺序、1500 字（`src/redaction.ts:205-210`；`COPY_BUDGET_CHARS` 在 `src/redaction.ts:1-120` 区，行号以 `redaction.ts:179-181` 的 `truncateForCopy` 为凭）；diag 块整体 1024 字节墙（`enforceBudget`，`src/diag.ts:452-468`；字节长 `diagByteLength` 在 `src/redaction.ts:232-244`）。

### 3.4 `diag` 结构与 cause 三键

- `buildDiag`（`src/diag.ts:366-411` 附近，best-effort，异常回 `undefined`，调用方按无 diag 旧形状返回）。
- `stage` 推导（`deriveStage`，`src/diag.ts:164-177`）：status→`read-installed`；check 侧按码分 `fetch-release`/`validate-release`；install 侧 `install-failed`→`exec` 等。
- `route/method` 推导（`src/diag.ts:190-202`）：fetch/validate→`registry/https`；exec→按宿主种类 `desktop-manager/phone`、`desktop-service/service`、`cli-process/spawn`。
- `cause` 三键（`causeKind/causePackage/causeUnlockAt`）**仅当 `stage === 'exec'` 时**才问 `causeInterpreter`（`src/diag.ts:399-411`）；翻译官实现 `src/install-cause.ts`：`CAUSE_KINDS = ['minimum-release-age']` 单枚举（`src/install-cause.ts:18`），token `[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION]`，`interpretInstallCause` 取 `published + N min` 优先、否则 `now - cutoff`（`src/install-cause.ts:45` 附近模式与窗口逻辑），`blameCausePackage` 分 `target/other-package/unknown`（`src/install-cause.ts:102-113`）。
- 面板宽容读：`DIAG_KNOWN_TYPES` 19 键目录（含 `causeUnlockAt: 'number'`，`src/panel.ts:560-569`）；`readDiagTolerant` 未知键忽略记账、错类型丢弃、永不抛（`src/panel.ts:596-632`）。门禁侧同目录复刻 19 键（`scripts/bilingual-gate.mjs:64-84`）。
- 翻译官怎么办句：`causeRemedyText` 按"归因 × 时间可算"四格选 `diag.cause.age.{target,other}.{timed,untimed}`（`src/panel.ts:661-687`）；归因目标只认 `diag.targetPackageName`，不用 `pluginId` 比对（注释 `src/panel.ts:705-707`）；缺席回落通用 `copy.act`（`src/panel.ts:708-712`）。

---

## 4. 文案与门禁

### 4.1 新增"怎么办/选择按钮"文案要动的文件

1. **`src/bilingual.ts`**（唯一文案源）：`BILINGUAL_DICT_VERSION` 版本钉（`src/bilingual.ts:25`）；`BilingualKey` 类型加 key（`src/bilingual.ts:28` 起）；`BILINGUAL_STRINGS` 加 `en/zh/draft` 三元（门禁逐键断言非空，`scripts/bilingual-gate.mjs:451-455`）。分支只认稳定码、本模块不做分支（`src/bilingual.ts:7`）。
2. **`src/panel.ts`**：`failureCopy`（`src/panel.ts:410`）、`blockedCopy`（`src/panel.ts:364`）、`isKnownFailureCode`（`src/panel.ts:399`）——门禁要求三函数存在且覆盖全部稳定码（`scripts/bilingual-gate.mjs:556-649`）；`failureCodeOf` 必须 `errorKind` 优先（`src/panel.ts:427`，门禁钉死 `scripts/bilingual-gate.mjs:642-647`）。
3. **快照**：`tests/fixtures/bilingual/strings.snapshot.json`（改文案/增删 key 必须同步，重算 `--update-snapshot`）。
4. **基线**（如有散落中文）：`tests/fixtures/bilingual/copy-baseline.json`（重算 `--update-baseline`；只许减不许增由评审把关）。

### 4.2 bilingual-gate 的硬门（四道）

门禁实现 `scripts/bilingual-gate.mjs`（用法 `scripts/bilingual-gate.mjs:27-33`；`npm test` 的前置 `pretest → build` 保证读的是 `dist` 真件，`scripts/bilingual-gate.mjs:18-23`）：

1. **文案源 grep 门**（`checkCopySource`，`scripts/bilingual-gate.mjs:329-375`）：`src/` 中文字符面量只许在 `COPY_SOURCE_FILES = ['src/bilingual.ts']`（`scripts/bilingual-gate.mjs:47`），其余按冻结基线逐条放行。**降级文案一律进字典，不许在面板里写中文**。
2. **字典快照门**（`checkDictionary`，`scripts/bilingual-gate.mjs:387-548`）：每键 en+zh 非空、英文无汉字、中文有汉字、具名槽中英同名同数、键名 `area.group.name`、单语渲染只出现当前语言、与快照逐键一致（改文案不换 key）。
3. **稳定码契约门**（`checkStableCodes`，`scripts/bilingual-gate.mjs:556-649`）：真源是 `src/codes.ts`（`BLOCKED_REASONS` 10 个、`PHONE_FAILURE_CODES` 5 个、`STABLE_CODES = 阻塞 + 电话 + internal`），门禁从 `dist/codes.js` 读、不另抄（`scripts/bilingual-gate.mjs:55-59`）。每码都要有 `panel.failure.{code}.title/.action`（阻塞码是 `panel.blocked.{code}.*`），阻塞行必须复用阻塞表原文（`scripts/bilingual-gate.mjs:604-606`）；字典里出现真源没有的码族即红（孤儿键检查，`scripts/bilingual-gate.mjs:623-630`）。
4. **诊断解析契约门**（`checkDiagParseContract`，`scripts/bilingual-gate.mjs:674-778`）：双形态（block/line）回读同字段；字段顺序冻结 **`code → summary → source → remedy`**（`scripts/bilingual-gate.mjs:765`）；来源恒显五字段 `插件/版本/宿主/使用范围/队列`（`scripts/bilingual-gate.mjs:770-774`）。
5. （发布才拦）**零 draft 放行** `--release`（`scripts/bilingual-gate.mjs:961-978`）。

### 4.3 复制诊断块的字段顺序规矩

- 大顺序：码 → 摘要 → 来源 → 怎么办（门禁冻结，`scripts/bilingual-gate.mjs:765`；组装注释 `src/panel.ts:690-696`；机读 tag `[update-diag]/code=/·/—` 冻结在代码不进字典，`src/panel.ts:693-695`）。
- 来源内顺序：插件 → 版本 → 目标 → 宿主 → 使用范围 → 路由 → 阶段 → 方法 → HTTP/exit/耗时 → 源 → 建议 → 请求/检查 → 队列；缺省省略，插件/版本/宿主/使用范围/队列恒显（`src/panel.ts:723-739`；`buildUpdateDiagCopy` 在 `src/panel.ts:698` 起）。
- 复制按钮：`data-action="copy-manual"` / `data-action="copy-diag"`（`src/panel.ts:1773/1788`）；复制诊断永不隐藏（注释 `src/panel.ts:1374`）；动作行常驻、每点记一条（`src/panel.ts:2880`，按钮实现 `src/panel.ts:3021-3102`）；按钮侧 `diagText()` 经 `buildUpdateDiagCopy` 组串（`src/install-button.ts:941-967`），动作为 `copy-manual/copy-diag`（`src/install-button.ts:969`）。

---

## 5. 复用点现货清单

### 5.1 版本比较 / 校验

- `validReleaseVersion`（`src/service.ts:131-141`，stable 只要纯三段）——降级候选版的形状门可直接用。
- `compareReleaseVersions`（SemVer11，`src/service.ts:189-219`）——"比运行版老/新"的比较现货。
- `isVersionAllowedInChannel`（`src/service.ts:149-152`）——通道门现货；`versionAllowed`（commands 侧同政策，`src/commands.ts:153/198` 经由）。
- `registrySpec`（`src/reader.ts:160-168`）、`profileNameValid`（`src/reader.ts:141-150`）——源码安装判别与范围名校验现货。
- **注意反例**：`manualCommand` 的"取最高且 ≥ 运行版"排序（`src/commands.ts:198-207`）**不可复用**于降级（它被明确设计为永不降级，注释 `src/commands.ts:199-200`）；降级需另写 picks（`latestVersion` 换成"决议出的 fallback 版"）或另起函数。

### 5.2 时间格式化

- `formatUnlockAt(ms, lang)`：zh `10月17日 13:58` / en `Oct 17 01:58 PM`（`src/install-cause.ts:116-132`）——降级"何时满门限/何时可装最新版"的时间显示可直接用。
- `blameCausePackage`（`src/install-cause.ts:102-113`）——肇事包归因现货（降级页"是谁太新"一句可复用同一口径）。

### 5.3 fetch 能力：面板侧能否直连 registry

- **面板侧没有直连 registry 的现成封装**。面板只调电话（`call(updateCheck/updateInstall/updateChangelog…)`），取数全在宿主侧 Node 里经注入的 `fetchImpl` 发出（读取器组装 `src/reader.ts:400-420`；无注入且无全局 fetch 即抛，`src/reader.ts:266-268`）。
- `src/http.ts` 只是"电话 over HTTP"的传输（`createHttpCall` 全透传，`src/http.ts:230-250`；按电话名选超时，`src/http.ts:203-217`），**不是 registry 客户端**——面板经它调的是自家网关，不是 `registry.npmjs.org`。降级若想"面板直连 registry 查 time"，今天没有封装、没有 CORS 评估、也没有白名单之外的源处理（源主机白名单 `ENDORSED_REGISTRY_HOSTS` + `resolveRegistryHost` 在 `src/redaction.ts:217-227`；`registryHost` 由 Node 侧解析注入，`src/service.ts:546/560-563`）。
- **结论**：降级取数（packument `time`）应走**宿主侧既有 `fetchImpl` 通道**（随 `check` 或新增只读电话），不要新开面板直连。

### 5.4 现有取数函数的复用与缺口

- `fetchNpmRelease` 取 `{registry}{pkg}/latest` 版本文档（`src/service.ts:355-433`，GET 在 `src/service.ts:375`；含 tarball/integrity 形状校验 `src/service.ts:413-424`，`MAX_METADATA_BYTES` 封顶）。
- `fetchNpmVersionRelease` 取 `{registry}{pkg}/{version}`（`src/service.ts:443-523`，GET 在 `src/service.ts:468`；更新日志电话用）。
- **缺口**：全量 packument（`/{pkg}`，带 `time` 与 `dist-tags`）**今天没有任何函数取**，`src/` 内无 `packument` 引用、无对 `time` 字段的解析（grep 确认零命中）。`Cache-Control: max-age=300` 一类头也不在现有读取面内。这是降级必须新造的取数（但可复用同一 `fetchImpl` + `timeoutSignal` + `MAX_METADATA_BYTES` + `makeFetchNoter` 日志格，`src/service.ts:335-346`）。

---

## 6. 需要新造 vs 可直接复用 vs 需宿主配合

### 6.1 需要新造（按贴合度排序，最贴合在前）

1. **Fallback 候选版决议**（取 packument → `dist-tags.latest` → `time` 倒序 → 首个超 24h 的版；无满足如实报告）：新函数，建议落在 `src/service.ts` `fetchNpmRelease` 旁，复用 `fetchImpl/timeoutSignal/MAX_METADATA_BYTES/makeFetchNoter`（`src/service.ts:335-375`）。`validReleaseVersion` + `compareReleaseVersions` + `isVersionAllowedInChannel` 三现货直接用（§5.1）。
2. **"按非 latest 版安装"的凭证/任务入口**：今天 `install()` 只认 `checked.release.version`（`src/service.ts:919`），`canInstall` 要求严格 newer（`src/service.ts:644-649/657-664`）。最小侵入是在核心侧加"降级检查结论"第二槽（与单槽 `checked` 并存，`src/service.ts:565/786`），或给 `install()` 加受约束的版本参数；`UpdateJob.targetVersion` 结构不动（`src/ports.ts:83-86` 已有 `targetVersion` 格）。
3. **降级文案 key**（怎么办句 + "装这个版本"选择按钮 + 无满足版的人话）：进 `src/bilingual.ts`，过 §4.2 四道门；`causeRemedyText` 四格模式（`src/panel.ts:661-687`）是现成的句式范本。
4. **降级手工命令**：`manualCommand` 永不降级（`src/commands.ts:198-207`），需另起 picks（fallback 版替代 latest 位）或另起函数；宿主侧 `manualOfEnv`（`src/host.ts:660-681`）透传。
5. **`CAUSE_KINDS` 扩展评估**：今天单枚举（`src/install-cause.ts:18`）；若降级失败要进 diag 机读，需加新 kind 并同步 19 键目录（`src/panel.ts:560-569`）与门禁目录（`scripts/bilingual-gate.mjs:64-84`）。不进机读则不碰。

### 6.2 可直接复用（不动）

- 安装执行整条：`installRecipe` 路由与参数数组形状（`src/commands.ts:140-180`）、三 runner（`src/store.ts:1215-1426`）、精确版 `--save-exact` + 官方源政策（注释 `src/commands.ts:137`）。
- 失败证据整条：`job.message` 前缀契约（`src/service.ts:868-869` + `README.md:462/587`）、`hoistCauseLines + sanitizeDetail`（`src/diag.ts:309` + `src/redaction.ts:193-198`）、`buildDiag` stage/route 推导（`src/diag.ts:164-215`）、锁存单调性与续查逻辑（`src/panel.ts:2735-2811/2931-2982`，按钮侧 `src/install-button.ts:843-939`）。
- 复制块顺序与恒显字段（`src/panel.ts:698-739` + 门禁 `scripts/bilingual-gate.mjs:765-774`）。
- `formatUnlockAt`、`blameCausePackage`、`validReleaseVersion`、`compareReleaseVersions`、`isVersionAllowedInChannel`、`resolveRegistryHost`（行号见 §5）。
- 批量侧 `targetVersion` 展示位（`src/panel-batch.ts:475-476`）——降级版可直接落进去。

### 6.3 现有框架不支持、需宿主配合的缺口（至少一条）

1. **（主缺口）宿主 pnpm 的 `minimumReleaseAge` 是宿主进程的配置，包侧无写通道**。`runDesktopManager` 只收 `installBundle(spec, { requestId, registry })`（`src/store.ts:1352-1364`），`runDesktopService` 只交参数数组（`src/store.ts:1227`），`runCliProcess` 只拼 argv（`src/store.ts:1411`）——三条路都没有"调门限/传 grace"的位置；`installRecipe` 五键冻结（`src/ports.ts:137` 起，`InstallRecipe`），改形状要同时改 `managerSpecOf`（注释 `src/commands.ts:161-163` + `src/store.ts:1284-1285`）。含义：**降级装上之后、门限过去之前，宿主侧是否会再次拦截、以及"满 24h 后自动装回最新"由谁触发，包侧决定不了**——需宿主明确：是宿主放宽执行期门限，还是包侧只管装旧版、回升由下一次正常检查完成。前置报告同样结论（bypass 否决的理由即"配额所有权在宿主"）。
2. **（次缺口）`updateInstall` RPC 无版本参数**（`src/host.ts:1152-1165`）：降级若要"用户点选某版安装"，要么加可选参数（老调用不动，参考 `from`/`enqueueOnly` 的加法扩展先例，`src/host.ts:1157-1161`），要么新增只读决议电话 + 复用安装电话。这需要宿主发版配合（电话形状是两边契约，HTTP 网关 `routes` 断言同理，`src/http.ts:245`）。
3. **（取数缺口，非宿主，是包内新造）**：packument 抓取与 `time` 解析今天不存在（§5.4），且 `time` 只在**完整 packument** 有、abbreviated 精简版没有——请求头（`Accept`）与体积预算（`MAX_METADATA_BYTES` 是否够装 packument）需实测后定，这部分工作宿主帮不上。

---

## 附：关键测试锚点（改动时先看）

- `tests/target-resolution.test.mjs`：目标包解析契约（降级不碰它，但别回归）。
- `tests/panel-failure-latch.test.mjs`：锁存单调性（§3.2 改渲染先跑它）。
- `tests/issue-154-install-diag.test.mjs` + `tests/issue-45-diag-complete.test.mjs`：diag 完整度（cause 三键的门）。
- `tests/detail-redaction.test.mjs` + `tests/redaction-single.test.mjs`：截断脱敏（300/1500/1024 三预算）。
- `tests/bilingual-gate.test.mjs` + `tests/bilingual-foundation.test.mjs`：门禁（新增 key 先看快照更新流程）。
- `tests/install-cause.test.mjs`：翻译官（`formatUnlockAt`/`blameCausePackage` 改动先跑它）。
- `tests/issue-150-check-expired.test.mjs` + `tests/issue-151-expiry-refetch.test.mjs`：静默续查（降级凭证逻辑别走样）。
- `tests/issue-100-prerelease-install.test.mjs` + `tests/skip-channel.test.mjs`：通道门（降级 picks 别和通道判定打架）。
