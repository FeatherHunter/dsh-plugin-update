# 蓝图：src 重构目标目录树 + 全量文件映射 + 神文件拆分清单 + 方法职责表

> 票：#224（map #220 子票）｜用户终审通过 2026-10-19（原话“认可你的判断”）
> 配套抛弃式原型：`prototype/blueprint-224.html`（tab A 终版即本蓝图；原型中 panel-batch 六拆与 changelog 待定两处以本文为准，已在原型评审中改判）
> 前置冻结：#159（Q4：10 个 exports 子路径是已发布契约，本次重构不得顺手改，真要动另立发版票；Q1 分阶段纪律经本次终审同步打破，拆文件 + 搬目录一步到位；Q3 tests 用 `../dist/*.js` 深引用策略保留）

行数基准：2026-10-19 实测（`panel.ts` 4226 / `panel-batch.ts` 3624 / `store.ts` 2570 /
`install-button.ts` 1786 / `host.ts` 1716 / `host-batch.ts` 1640 / `changelog.ts` 1645 /
`service.ts` 1101 / `bilingual.ts` 959）。

## 1. 设计结论（先说拍板了什么）

- **方案 A 单根全展开终版**：`src/` 下一级只允许业务域目录（`host/` `panel/` `core/` `shared/`），根目录只留 10 个公开入口壳（9 业务壳 + `log/` 独立壳说明见 §5）。
- **壳 = curated 转出口**：每个壳只做两件事——留公开类型、从新位置 re-export 实现；零逻辑零决策。壳的导出集合冻结为今日各入口的公开名（§6），文件名与 `package.json` `exports` 十个子路径一一对应，一个不动。
- **exports 契约不打破**：npm 已发布版本（0.18.6 起）+ 4 家消费方（deck、life-pack、im-companion、palette）的子路径 import 是真契约；其余（#159 程序性冻结、tests 深引用、文档）都是我方纪律，钥匙在自己手里，本次按 §7 成本表处理。
- **一步到位**：拆文件 + 搬目录一次做完，不经历“拆完还在扁平里”的中间态（同步打破 #159 Q1 分阶段纪律，已获批）。

## 2. 目标目录树（87 文件：54 旧全量 + 33 拆分新增；目录职责一句话）

```text
src/
├── host.ts                  # 壳：./host（宿主侧单机编排入口）
├── host-batch.ts            # 壳：./host-batch（宿主侧批量编排入口）
├── panel.ts                 # 壳：./panel（面板侧单机 UI 入口）
├── panel-batch.ts           # 壳：./panel-batch（面板侧批量 UI 入口）
├── entry.ts                 # 壳：./entry（单机条目挂载入口）
├── entry-batch.ts           # 壳：./entry-batch（批量条目挂载入口）
├── install-button.ts        # 壳：./install-button（安装按钮入口）
├── client.ts                # 壳：./client（面板客户端形状入口）
├── http.ts                  # 壳：./http（HTTP 传输挂载入口）
├── log/
│   └── index.ts             # 壳：./log（日志门禁与事件目录入口；独立成壳因为消费方是 host 宿主侧而非面板侧）
├── host/                    # 宿主侧：与宿主进程同命的编排（探测环境、拼电话名、落盘、执行器）
│   ├── factory.ts           # createHostUpdate + HostUpdate 类型 + 端口注入装配
│   ├── phones.ts            # 宿主侧电话名拼装
│   ├── capabilities.ts      # ReaderOverrides 等能力/端口形状
│   ├── environment.ts       # detectEnvironmentKind + 桌面服务 + 日志目录定位
│   ├── forwarding.ts        # 旧 host-forwarding.ts 整搬（垫片聚合）
│   ├── http.ts              # 旧 http.ts 整搬（HTTP 传输与挂载）
│   └── batch/               # 宿主侧批量：多目标编排
│       ├── fan-out.ts       # createMultiHostUpdate + 并发上限
│       ├── phones.ts        # BatchHostPhoneNames + 前缀隔离装配
│       ├── resume.ts        # 会话恢复推进（部分由 createMultiHostUpdate 内恢复分支抽出，见 §4 待定）
│       └── log.ts           # 旧 host-batch-log.ts 整搬
├── panel/                   # 面板侧：跑在浏览器闭包里的 UI（只许碰 log/panel-client.js）
│   ├── types.ts             # 旧 panel.ts L50–347 公开类型整留（壳 re-export，不新建文件）
│   ├── theme.ts             # 主题 token 与安全校验（旧 panel.ts L69–354）
│   ├── view-model.ts        # 视图模型装配（旧 panel.ts L523–891）
│   ├── render.ts            # 渲染函数 + UPDATE_PANEL_CSS（旧 panel.ts L892–2280）
│   ├── archive-theme.ts     # Archive 归档样式（旧 panel.ts L1094–1384 内的 Archive CSS 段）
│   ├── failure-latch.ts     # 失败锁存状态 + formatLatchTime + PanelFailureRef（旧 panel.ts L1385/L1584/L2281–2309）
│   ├── skip-store.ts        # 内存/浏览器跳过存储（旧 panel.ts L348 PanelSkipStore + L398–522）
│   ├── mount.ts             # mountUpdatePanel + pendingAutoCheck（旧 panel.ts L2310–4171）
│   ├── client.ts            # 旧 client.ts 整搬 + 旧 panel.ts L4172–4226 电话名段并入
│   ├── entry.ts             # 旧 entry.ts 整搬
│   └── batch/               # 面板侧批量 UI
│       ├── ledger.ts        # 批量总账函数（旧 panel-batch.ts L254–668）
│       ├── render.ts        # 批量渲染（旧 panel-batch.ts L676–1574）
│       ├── styles.ts        # 批量样式 CSS + ARCHIVE_CSS（旧 panel-batch.ts L1575–1689）
│       ├── mount.ts         # 批量挂载 + 回退/失败文案助手（旧 panel-batch.ts L1690–3624）
│       └── entry-batch.ts   # 旧 entry-batch.ts 整搬
├── core/                    # 两侧共享的纯逻辑：版本判断、结论、队列、执行、网关
│   ├── service.ts           # 旧 service.ts 整搬（核心服务装配，不再拆：CONFIRMATION_TTL_MS/RECHECK_WINDOW_MS/validRequestId/__resetFallbackSlots/createUpdateCore，
│   │                        # 1101 行但无次级截面可锚，硬拆即散装）
│   ├── queue/
│   │   ├── model.ts         # 旧 queue.ts 整搬（队列纯模型）
│   │   └── ports.ts         # 旧 store.ts L656–970 队列端口段
│   ├── batch/
│   │   ├── model.ts         # 旧 batch.ts 整搬（会话纯模型）
│   │   └── run.ts           # 旧 batch-run.ts 整搬（runBatch 步骤机）
│   ├── install-button/      # 安装按钮域
│   │   ├── widgets.ts       # 旧 install-button.ts L173–263 内部小件（无导出，挂载与视图共用）
│   │   ├── view.ts          # installButtonViewModel（旧 install-button.ts L264–315）
│   │   ├── render.ts        # renderInstallButtonHTML（旧 install-button.ts L316–523）
│   │   ├── styles.ts        # 按钮样式（旧 install-button.ts L524–599）
│   │   └── mount.ts         # mountInstallButton（旧 install-button.ts L600–1786）
│   ├── changelog/
│   │   ├── parse.ts         # 解析：常量/正则 + parseChangelogReport/parseChangelog/归类（旧 changelog.ts L29–921）
│   │   ├── render-model.ts  # 渲染：CHANGELOG_MD_INLINE + render*HTML（旧 changelog.ts L922–1495）
│   │   ├── validator.ts     # 校验：ChangelogDiagnostic/Validation/validateChangelog（旧 changelog.ts L1496–1645，原型评审中由“待定”转正）
│   │   └── io.ts            # 旧 changelog-io.ts 整搬
│   ├── i18n/
│   │   ├── dictionary.ts    # BILINGUAL_DICT_VERSION/BilingualKey/BilingualEntry/BILINGUAL_STRINGS（旧 bilingual.ts L1–约400）
│   │   ├── text.ts          # bilingualEntry/copyText/copyHTML/bilingualText/bilingualHTML/isDraft/draftKeys（旧 bilingual.ts 约401–800）
│   │   └── styles.ts        # BILINGUAL_CSS（旧 bilingual.ts 约801–959）
│   ├── judgment.ts          # 旧 version-judgment.ts 整搬
│   ├── conclusion.ts        # 旧 check-conclusion.ts 整搬
│   ├── cause.ts             # 旧 install-cause.ts 整搬
│   ├── failure.ts           # 旧 install-fail.ts 整搬
│   ├── fetch.ts             # 旧 registry-fetch.ts 整搬
│   ├── reader.ts            # 旧 reader.ts 整搬
│   ├── disk.ts              # 落盘端口：旧 store.ts 路径/磁盘/属主清单/偏好/跳过段（L366–655 + L972–1463）
│   ├── executor.ts          # 执行器：resolveCliEntry + ExecutorParts + createUpdateExecutor（旧 store.ts L1464–2570 尾段）
│   └── gate.ts              # 旧 gate.ts 整搬（事件门禁与目录）
└── shared/                  # 无归属小件：两侧都 import 的最小公共层
    ├── codes.ts             # 旧 codes.ts 整搬
    ├── ports.ts             # 旧 ports.ts 整搬
    ├── redaction.ts         # 旧 redaction.ts 整搬
    ├── diag.ts              # 旧 diag.ts 整搬
    ├── hash.ts              # 旧 hash.ts 整搬（单函数）
    ├── lang.ts              # 旧 lang.ts 整搬
    ├── log-events.ts        # 旧 log-events.ts 整搬
    ├── copy.ts              # 旧 panel-copy.ts 整搬
    ├── compliant.ts         # 旧 compliant-version.ts 整搬
    ├── commands.ts          # 旧 commands.ts 整搬
    ├── manual-absent.ts     # 旧 manual-absent.ts 整搬
    ├── last-resort.ts       # 旧 last-resort.ts 整搬
    ├── batch-log.ts         # 旧 host-batch-log.ts 整搬（宿主批量日志；与 host/batch/log.ts 同源二选一，执行时只留一处，见 §4）
    ├── config.ts            # 旧 config.ts 整搬
    └── self.ts              # 旧 self.ts 整搬
```

命名规则（执行票照此落地，不再议）：目录 = 业务域（host/panel/core/shared）；同名文件在不同目录下靠路径区分（如 `host/batch/phones.ts` vs `panel/batch/` vs `core/batch/`），import 一律写全路径，禁止 barrel 转出口（除 10 壳）。

## 3. 全量文件映射（54 旧 → 新路径）

### 3.1 整体搬家（45 个，不拆）

| 旧 `src/*.ts` | 新路径 | 备注 |
|---|---|---|
| batch.ts | core/batch/model.ts | tests 深引 `../dist/batch.js` → codemod 指新路径 |
| batch-run.ts | core/batch/run.ts | 同上 |
| bilingual-copy?（无） | — | — |
| check-conclusion.ts | core/conclusion.ts | 更名仅文件名，方法不重命名 |
| changelog-io.ts | core/changelog/io.ts | |
| client.ts | panel/client.ts（+ 并入 panel.ts 电话名段） | 壳 client.ts 做 export * |
| codes.ts | shared/codes.ts | |
| commands.ts | shared/commands.ts | |
| compliant-version.ts | shared/compliant.ts | |
| config.ts | shared/config.ts | |
| diag.ts | shared/diag.ts | |
| entry.ts | panel/entry.ts | 壳 entry.ts 做 export * |
| entry-batch.ts | panel/batch/entry-batch.ts | 壳 entry-batch.ts 做 export * |
| gate.ts | core/gate.ts | |
| hash.ts | shared/hash.ts | |
| host-batch-log.ts | host/batch/log.ts（与 shared/batch-log.ts 二选一，见 §4） | |
| host-forwarding.ts | host/forwarding.ts | 垫片聚合体（5 组 re-export，内容不动） |
| http.ts | host/http.ts | 壳 http.ts 做 export * |
| install-cause.ts | core/cause.ts | |
| install-fail.ts | core/failure.ts | |
| lang.ts | shared/lang.ts | |
| last-resort.ts | shared/last-resort.ts | |
| log-events.ts | shared/log-events.ts | |
| manual-absent.ts | shared/manual-absent.ts | |
| panel-copy.ts | shared/copy.ts | 已有垫片 |
| ports.ts | shared/ports.ts | |
| queue.ts | core/queue/model.ts | tests 深引 codemod |
| reader.ts | core/reader.ts | |
| redaction.ts | shared/redaction.ts | |
| registry-fetch.ts | core/fetch.ts | 已有垫片 |
| self.ts | shared/self.ts | |
| service.ts | core/service.ts | 整搬不再拆（§2 见由） |
| version-judgment.ts | core/judgment.ts | 已有垫片 |
| log/*（多文件） | log/* 原位不动 | 已是目标形状 |

### 3.2 拆分搬家（9 个神文件 → 33 新文件，见 §4 方法职责表）

panel.ts(4226) → panel/{theme,view-model,render,archive-theme,failure-latch,skip-store,mount,client★}.ts + 壳留 types；
panel-batch.ts(3624) → panel/batch/{ledger,render,styles,mount}.ts（★原型曾列 actions/prefs 六拆，export 盘点无依据，已改判为四拆）；
store.ts(2570) → core/{disk,executor}.ts + core/queue/ports.ts；
install-button.ts(1786) → core/install-button/{widgets,view,render,styles,mount}.ts；
host.ts(1716) → host/{factory,phones,capabilities,environment}.ts + forwarding 现状；
host-batch.ts(1640) → host/batch/{fan-out,phones,resume}.ts；
changelog.ts(1645) → core/changelog/{parse,render-model,validator}.ts；
service.ts(1101) → core/service.ts 整搬（不拆）；
bilingual.ts(959) → core/i18n/{dictionary,text,styles}.ts。

## 4. 方法职责表（只归类不重命名；行号为今日实测锚点）

### panel.ts → 8 去向（含壳）

| 新文件 | 收容（旧 panel.ts 行段） |
|---|---|
| 壳 panel.ts | 公开类型 L50–347（UpdatePanelState/Options/Controller 等）+ `export { isCheckSideFailureCode }`（L41 由 codes 转出口现状保留）+ re-export 各拆出实现 |
| panel/theme.ts | 主题段 L69–354：UpdateThemeTokens/isSafeThemeCssValue/themeTokensStyleFor |
| shared/copy.ts | 文案垫片段 L355–397（已搬：blockedCopy/failureCopy/buildUpdateDiagCopy…，现状为 re-export） |
| panel/skip-store.ts | PanelSkipStore（L348 类型上移）+ 跳过存储段 L398–522：createMemorySkipStore/createBrowserSkipStore |
| panel/view-model.ts | 视图模型段 L523–891 |
| panel/render.ts | 渲染段 L892–2280（含 UPDATE_PANEL_CSS L894；含 PanelFailureRef L1385 上移至 failure-latch，见下） |
| panel/archive-theme.ts | Archive CSS 段（渲染段内 L1094–1384 的归档样式部分） |
| panel/failure-latch.ts | 失败锁存段 L2281–2309（锁存状态）+ PanelFailureRef（L1385）+ formatLatchTime（L1584） |
| panel/mount.ts | 挂载段 L2310–4171：pendingAutoCheck（L2395）+ mountUpdatePanel |
| panel/client.ts | 电话名段 L4172–4226：buildPanelPhoneNames/buildPanelChangelogPhoneName/PANEL_POLL，并入旧 client.ts 内容 |

### panel-batch.ts → 4 去向 + 壳（改判记录）

总账段 L254–668 → panel/batch/ledger.ts；渲染段 L676–1574 → render.ts；
样式段 L1575–1689（含 ARCHIVE_CSS）→ styles.ts；
挂载段 L1690–3624（含 singleFallbackPhoneOf/singleInstallPhoneOf/fallbackOutcomeOf/batchFallbackCauseOf/compliantInstalledOf/batchFailedRows/batchFailedDiagText/batchFailedManualText + mountUpdateBatchPanel）→ mount.ts；
公开类型 L79–253（含 BATCH_PANEL_POLL/buildBatchPhoneNames）→ 壳留存。
**改判**：原型 v4 曾列 `actions.ts`/`prefs.ts` 六拆；export 盘点显示回退/失败助手全部位于挂载段、偏好（BatchPrefs/normalizeBatchPrefs/PREFS_FILE）位于 store.ts（→ core/disk.ts），panel-batch 内无独立截面可锚，故六拆→四拆。

### store.ts → 3 去向（无 [S] 截面，按导出 runs 划分）

core/disk.ts ← UpdatePaths/pathsForUpdate/DiskPortsDeps/createUpdateDiskPorts（L366–655）
+ BatchPaths/BatchPortsDeps/createBatchDiskPorts（L972–1056）
+ 属主/清单/偏好段（L1057–1463：OwnerIdentity/InventoryInput/collectInventory/SKIPPED_FILE/BatchPrefs/normalizeBatchPrefs）
+ 跳过段（L1249–1340：SkippedVersionEntry/createSkipDiskPorts）；
core/queue/ports.ts ← 队列端口段 L656–970（含 QUEUE_DIR_SEGMENT/QueuePaths/QueuePortsDeps/createQueueDiskPorts）；
core/executor.ts ← resolveCliEntry（L1464）+ ExecutorParts（L1507）+ createUpdateExecutor（L2531 起至文件尾）。

### install-button.ts → 5 去向 + 壳

对外类型段 L50–172 → 壳留存；内部小件段 L173–263（无导出，挂载与视图共用）→ core/install-button/widgets.ts；
installButtonViewModel（L295，视图段 L264–315）→ view.ts；renderInstallButtonHTML（L427，渲染段 L316–523）→ render.ts；
按钮样式段 L524–599 → styles.ts；mountInstallButton（L600，挂载段 L600–1786）→ mount.ts。

### host.ts → 4 去向 + 壳

壳 host.ts ← `export * from './host/forwarding.js'` 现状垫片（L83）+ 公开类型；
host/factory.ts ← HostUpdate（L1285）+ createHostUpdate（L1294）+ __resetSharedUpdateReaderForTests（L1711）+ failedJobDiagOf（L694，失败任务诊断，随装配走）；
host/phones.ts ← 宿主侧电话名拼装（位于 createHostUpdate 内的拼装分支，搬家时抽出）；
host/capabilities.ts ← ReaderOverrides（L257，端口注入形状）+ 能力装配分支；
host/environment.ts ← detectEnvironmentKind（L185）+ PhoneEnvView（L736）+ updateLogDirFor（L808）+ 桌面服务段。

### host-batch.ts → 3 去向 + 壳

公开类型段 L93–193（MultiTargetSpec/Options/Timer/Deps/PhoneNames/Update）→ 壳留存；
host/batch/fan-out.ts ← createMultiHostUpdate（L659）+ BATCH_CHECK_CONCURRENCY（L268，并发上限）；
host/batch/phones.ts ← BatchHostPhoneNames（L454）+ 目标前缀隔离装配；
host/batch/resume.ts ← phoneRequestIdOf（L250）+ 会话恢复推进分支（createMultiHostUpdate 内恢复分支，搬家时抽出；**部分待定**：恢复分支边界以执行票动刀时 tracer 先验证为准）。

### changelog.ts → 3 去向（截面实锤）

core/changelog/parse.ts ← L29–921（常量/正则 + parseChangelogReport/parseChangelog/归类）；
core/changelog/render-model.ts ← L922–1495（CHANGELOG_MD_INLINE + render*HTML）；
core/changelog/validator.ts ← L1496–1645（ChangelogDiagnostic/Validation/validateChangelog；原型评审“待定”→ export 盘点转正）。

### bilingual.ts → 3 去向（截面实锤）

core/i18n/dictionary.ts ← BILINGUAL_DICT_VERSION/BilingualKey/BilingualEntry/BILINGUAL_STRINGS；
core/i18n/text.ts ← bilingualEntry/copyText/copyHTML/bilingualText/bilingualHTML/isDraft/draftKeys；
core/i18n/styles.ts ← BILINGUAL_CSS。

### 待定（执行票动刀时由 tracer 先验证，不阻塞蓝图）

1. host/batch/resume.ts 恢复分支边界（上）。
2. host/batch/log.ts vs shared/batch-log.ts 二选一（同源，执行时只留一处）。
3. shared/copy.ts（panel-copy 垫片）与 panel 侧文案的最终归属（现状垫片不动）。

## 5. 10 个入口壳的公开导出清单（冻结集 = 今日各入口公开名）

| 壳（`package.json` 子路径） | 导出内容（实现搬家后 re-export，集合不变） |
|---|---|
| host.ts（`.`） | HostUpdate/createHostUpdate/__resetSharedUpdateReaderForTests/failedJobDiagOf/ReaderOverrides/PhoneEnvView/detectEnvironmentKind…（今日 host.ts 全部公开名） |
| host-batch.ts（`./host-batch`） | MultiTargetSpec/Options/Timer/Deps/PhoneNames/Update/createMultiHostUpdate/BATCH_CHECK_CONCURRENCY/BatchHostPhoneNames… |
| panel.ts（`./panel`） | 公开类型（L50–347）+ 视图/渲染/挂载/主题/跳过存储/电话名全部公开名 + isCheckSideFailureCode 转出口 |
| panel-batch.ts（`./panel-batch`） | 公开类型（L79–253，含 BATCH_PANEL_POLL）+ 总账/渲染/挂载全部公开名 |
| entry.ts（`./entry`） | `export *` panel/entry.ts（EntryVariant/EntryAutoCheck/EntryOpenOn/UpToDateDisplay/EntryTheme/EntryStateKind/UpdateEntryState/EntrySizing/UpdateEntryOptions/UpdateEntryController/entryStateKind/entryBilingual*/entryLabelFor/entrySizingStyleFor/UPDATE_ENTRY_CSS/mountUpdateEntry） |
| entry-batch.ts（`./entry-batch`） | `export *` panel/batch/entry-batch.ts（BatchEntryVariant/BatchEntryAutoCheck/BatchEntryOpenOn/BatchEntryStateKind/UpdateBatchEntryState/BatchEntrySummary/UpdateBatchEntryOptions/UpdateBatchEntryController/batchEntrySummary/batchEntryStateKind/batchEntryLabelFor/batchEntryBilingual*/mountUpdateBatchEntry） |
| install-button.ts（`./install-button`） | 对外类型（L50–172）+ installButtonViewModel/renderInstallButtonHTML/mountInstallButton |
| client.ts（`./client`） | `export *` panel/client.ts（CLIENT_POLL/buildClientPhoneNames/assertPollInterval + 电话名构建组 + manualCommand 转出口） |
| http.ts（`./http`） | `export *` host/http.ts（HTTP_TRANSPORT_FAILED/DEFAULT_HTTP_*_TIMEOUT_MS/HTTP_PHONE_ACTIONS/HttpPhoneAction/HTTP_BATCH_ACTIONS/HttpBatchAction/HttpRoutes/HttpFetch/HttpTimeouts/CreateHttpCallOptions/assertHttpRoutes/resolveHttpPath/httpTransportFailed/pickHttpDiag/shapeHttpReply/createHttpCall/UpdatePanelHttpOptions/mountUpdatePanelHttp/UpdateEntryHttpOptions/mountUpdateEntryHttp/UpdateBatchPanelHttpOptions/mountUpdateBatchPanelHttp/assertPollInterval） |
| log/index.ts（`./log`） | 事件目录与门禁（现 log/ 原位不动；独立成壳因消费方是宿主侧而非面板侧） |

## 6. 风险表

| # | 风险 | 位置/量级 | 对策（执行票落地） |
|---|---|---|---|
| R1 | 类型循环引用 | 1 处：panel 渲染 ↔ 挂载经共享类型 | 类型上移壳（panel/types 留壳），实现只向下依赖；`npm run check` 门禁 |
| R2 | 端口注入装配点 | ReaderOverrides（host.ts L257 → host/capabilities.ts）+ store 三类 create*DiskPorts | 装配只收敛到 factory/disk 两处；测试端口注入用例先行（tracer 第一刀） |
| R3 | tests 深引 `../dist/*.js` | 约 228 处（#159 Q3 策略） | codemod 批量改路径，一次改完当天跑绿；批量相关定向 `npm run test:batch` |
| R4 | `../src/` 直读 | 4 处（derive-client-values.mjs 等“在消费方仓库跑”的脚本） | 路径同步改 + 消费方重新生成派生文件（半外部成本，提前通知四家） |
| R5 | 浏览器闭包体积 | panel 侧只许碰 log/panel-client.js（门禁测试锁死） | 切分即隔离边界：entry 并进 panel 会让闭包含多余代码，故不合并入口；门禁测试保留 |
| R6 | bilingual 门禁成本 | text.ts 拆出后文案 key 增删仍走门禁 | 门禁测试随文件搬家不断；key 变更流程不变 |
| R7 | #196 部署偏斜 | 部分消费方钉旧 minor，吃不到新版 | 本次零 breaking（§5 冻结集），偏斜消费方无感；发版说明注明最低可用版本 |

## 7. 契约调查结论（根壳为什么动不得，本次怎么处理）

四层契约自硬至软：① npm 已发布版本 + 四家消费方子路径 import（真契约，钥匙不在我方——**本次不动**，§5 冻结）；
② #159 Q4 冻结决议（程序性契约，钥匙在用户手里——本次遵守，不另立发版票）；
③ tests 约 228 处深引用（内部成本——执行票 codemod，R3）；
④ README/maintainers 纸面契约（同步改）+ derive-client-values.mjs 半外部成本（R4）。
#159 Q1 分阶段纪律（先拆文件后搬目录）经本次终审同步打破，一步到位（§1）。

## 8. 执行顺序建议（给后续执行票，不在本票动工）

1. Tracer 第一刀：host/capabilities.ts（ReaderOverrides 端口注入）+ 对应测试先行，验证“装配收敛”方法。
2. 薄切第二刀：core/i18n 三拆（dictionary/text/styles，截面最干净，无外部引用）。
3. 神文件按 store → changelog → bilingual → install-button → panel-batch → panel → host-batch → host 顺序动刀（被引用少者先行）。
4. 最后 codemod tests 深引（R3）+ 全量 `npm run check` + `npm run test:batch` + `npm run smoke:log`。
