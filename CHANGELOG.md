# Changelog

格式为 Keep-a-Changelog 子集：`Added/Fixed/Changed` 必写，`Deprecated/Removed/Security` 有则透传，`Unreleased` 面板忽略，禁止 git-log 直倒。面板缺日志时中性提示，不挡安装。

版本号按**已发布**口径读：`0.14.0` 与 `0.15.0` 没有单独发到 npm（registry 上从 `0.13.0` 直接到 `0.16.0`），那两节的内容随 `0.16.0` 首发；`0.16.1` 起是发布后的补丁。

## [Unreleased]

### Added
- **开发工具：一键发版脚本 + 布局探针进仓（#208 复盘：编排税 / 复现税）**：`scripts/release.mjs`（`npm run release`）把「门禁 → CHANGELOG 定格 → 版本号 → commit/tag/push → token 发布 → 可见性轮询 → GitHub Release」固化成一条命令，默认**计划模式只读**、`--yes` 才执行、`--verify <版本>` 做发布后自检（npm 可见 / latest / tag 指向 / GitHub Release / tarball 布局）；`scripts/panel-layout-probe.mjs`（`npm run probe:layout`）用系统 Chrome 渲染真面板量盒子，断言 #93 单面板布局契约与 #240 批量盘弹窗契约（横幅不被压扁、复制按钮不越框、内容超高时自身可滚且末行可达）。口径写进 `docs/maintainers.md`，`docs/agents/architecture.md` 门径表同步指路。

## [0.18.36] - 2026-10-20

### Fixed
- **#241 recovery-required 死锁：宿主插件未加载（运行版 0.0.0）≠ 盘上版时，安装/重试全被同一拦截拒绝，只能重启宿主（真机 2026-10-20 14:23 爱生活面板「饼干记账」升级卡死）**：集成方拿不到宿主半区运行版时会注入占位版号 `0.0.0`（#216 只挡了显示层）。核心把它当真实版本判「运行版 ≠ 盘上版」，于是任务中断后派生 `recovery-required`；同一个拦截又拒绝 canInstall，形成「想恢复必须重试、重试被恢复态挡住」的自锁。现在：①`src/shared/version.ts`（新）提供 `normalizeRunningVersion`，读取器与核心把非字符串/空串/占位 `0.0.0` 一律归一为「未知」（null）；②`buildSnapshot` 增恢复豁免——任务已中断/失败、运行版未知、盘上版本比目标旧时允许发起重试安装（这一次重试就是恢复动作），但仍不宣称「有更新」（#182 的 unknown 状态判定照旧）；已知运行版时豁免不生效，#179/#215 判定不回归。异动文件：`src/shared/version.ts`、`src/core/reader.ts`、`src/core/service.ts`。
- **#238 单品面板进入时先渲染上一次失败账本：首次安装前先弹「更新失败」误导帧（真机 2026-10-20 14:11 web profile 首装「饼干记账」一进页签就吃 13:19 的旧失败横幅）**：目标从未装过（磁盘没有）时，盘上残留的 failed/interrupted 任务只是历史账本；面板把任务态直接当「当前失败」渲染，还把它铺进 mount 的 job-failed 锁存。现在：①`src/panel/view-model.ts` 区分「新鲜失败」（本回包 errorKind/lastError、会话锁存）与 `historicalJobFailure`（未装 + 盘上旧任务），后者不再进失败页；②`src/panel/mount.ts` 的 job-failed 锁存对「未装 + 无新鲜锁存」让位，等首装/未装视图。
- **#239 队列整写瞬时 EPERM 被误判成「上次安装异常中断」（真机 2026-10-20 14:16 web profile「卡路里」首装与 CLI 并发写同一份队列账本）**：`writeQueue` 整写队列账本（写临时文件 + rename），Windows 上句柄短占会偶发 EPERM/EACCES/EBUSY/ENOTEMPTY/EMFILE；写入被拒即抛，上层把「没写进去」落成 interrupted + recovery-required。现在：`src/core/queue/ports.ts` 对可判定的瞬时写错误做小步重试（瞬时错误码集合、最多 3 次、25ms 间隔、重试前清残留临时文件），非瞬时错误照旧立即失败；`createUpdateQueuePorts` 增 `writeFileImpl`/`renameImpl` 注入缝（只给测试用）。
- **#240 批量面板失败横幅被压扁：「复制诊断/复制手工命令」越出红框（真机 2026-10-20 14:17 web profile「更新档案·总账」8 行批量面板，窗口 CSS 高约 542）**：批量弹窗根没有 `.dsh-upd-body` 滚动区，内核 #93 弹窗契约（`:has(>.dsh-upd-body)`）刻意不覆盖它；内容高过 85vh 时纵向 flex 按比例压子项，横排且显式 `min-height:3.4em` 的失败横幅先被压到地板，名单行与按钮越框。现在：`src/panel/batch/styles.ts` 增批量弹窗高度契约——`.dsh-upd-overlay .dsh-upd.dsh-upd-batch` 自己滚（`overflow-y:auto`）、child 一律 `flex:none`；契约只挂 overlay 作用域且只认批量根，内核面板与 embedded 形态零影响。

### Tests
- 新增 `tests/issue-241-recovery-deadlock.test.mjs` 4 例（占位 0.0.0 归一未知、中断任务可恢复重试、未知运行版不伪造 pending-restart、已知运行版时豁免不生效）；`tests/issue-238-first-install-stale-failure.test.mjs` 8 例（首帧不渲染旧失败账本、新鲜失败仍显示、锁存让位、历史帧让位后新失败照常回归）；`tests/issue-239-queue-transient-write.test.mjs` 4 例（瞬时 EPERM 重试成功、非瞬时立即失败、重试耗尽如实失败、只读队列不受影响）；`tests/issue-240-batch-dialog-height-contract.test.mjs` 7 例（两条契约存在、只挂 overlay+batch 根、内核 #93 契约不扩到批量、dialog/embedded DOM 形状不回归、失败横幅与复制按钮组形状不变）。

门禁（**发版定格**）：`npm run check` **全绿**——`node --test tests/*.test.mjs` **1958 例：1957 过 / 0 失败 / 1 跳过**；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（88 个源文件、413 个 key、17 错误码、20 diag 键，违规 0）；`npm run docs:log:check` 过（6 条缺行警告是既有缺行，只警告不失败）；`npm publish --dry-run` **183 文件**（`dsh-plugin-update@0.18.36`，517.3 kB 压缩 / 1.7 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（413 个 key 仍全是 `draft: true`（合入条件未满足））。

## [0.18.35] - 2026-10-20

### Fixed
- **#237 CLI 路：官方桌面运行时里的 `dsh web` / CLI 模式使用范围，安装第一步就 `spawn-failed`（真机 2026-10-20 13:19 爱生活面板「首次安装」点下去 2ms 失败）**：普通 DSH 宿主这条路由靠反查 `process.argv[1]` 找 CLI 的 JS 入口，旧实现只认 npm 布局（包名 `@deepseek-ai/dsh` + 清单声明 `bin.dsh`/`bin`）。而官方桌面运行时里 `dsh web` 的 CLI 入口是运行时自带的 `…\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`——该包没有 `bin` 字段、包名也不同，反查永远返回 null，执行器 2ms 内如实失败 `spawn-failed`（面板显示「安装执行失败」），web profile 里爱生活对单品的「安装 / 升级」全部走不通。现在：反查同时认官方桌面运行时布局——向上找到包名 `@deepseek-ai/dsh-desktop-host` 时，入口必须正好是该包的 `lib/cli.js`；npm 布局、无关包、入口对不上返回 null 的既有语义不变，仍不猜 `PATH` 上的 `dsh` 命令名。桌面使用范围走管理器路，行为不变。
- 测试：新增 `tests/issue-237-cli-entry-desktop-runtime.test.mjs` 4 例（桌面运行时布局返回入口；同包但入口不是 `lib/cli.js` 返回 null；npm 布局不回归；无关包仍 null）。

门禁（**发版定格**）：`npm run check` **全绿**——`node --test tests/*.test.mjs` **1935 例：1934 过 / 0 失败 / 1 跳过**；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（87 个源文件、413 个 key、17 错误码、20 diag 键，违规 0）；`npm run docs:log:check` 过（6 条缺行警告是既有缺行，只警告不失败）；`npm publish --dry-run` **181 文件**（`dsh-plugin-update@0.18.35`，513.1 kB 压缩 / 1.7 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（413 个 key 仍全是 `draft: true`）。

## [0.18.34] - 2026-10-20

### Fixed
- **#236 管理器路：宿主在移除步失败时把在册的插件从 `dsh.profile.bundles` 摘掉却不回滚，更新后插件页显示「关闭」，只能用户手动启用（真机 2026-10-20 04:12 六个 life-* 批量更新全部 `bundle-in-use`）**：宿主 `removeBundle` 对在册的 bundle 是「先 `selectBundle(false)`（立即写盘）再重载卸载」，活 fiber 没卸掉就抛 `bundle-in-use`；`change()` 只把结果标 `failed`，那次取消在册没有任何回滚——本包看到「移除失败」时，插件已经装着、却不在 `dsh.profile.bundles` 里（词义见 `CONTEXT.md` 的「在册」），重启也不会加载。现在：①`#201` 的拓扑探测顺带留下「移除前是否在册」快照；**移除前探到在册的包**在移除失败/超时（含 `removeBundle` 同步抛错）后先带时限复探一次，**确认已被移出**才用宿主 `setBundleEnabled(name, true)` 尽力恢复，恢复后再带时限复探一次，只有明确回到在册才说「已恢复在册」；恢复被拒说「恢复在册未成功」；前置结论不明、恢复调用超时或宿主没有 `setBundleEnabled` 时说「无法确认」——绝不把「可能」写成事实，也不宣称一次没发起的尝试；②装前本来未在册（`#201` 先恢复在册再移除）的失败**不恢复**，回到用户原本状态，不擅自改拓扑；③老宿主没有 `listBundles` / `setBundleEnabled`、或探测抛错时一律不猜拓扑、行为与从前一致，只把 `bundle-in-use` 的误导提示（「请先在宿主插件页停用后再更新」——方向反了）换成可操作的两步（重启 DSH 后重试、插件页显示关闭就重新启用）；④原失败码、`reason`/`hostCode` 与详情语义不变，尾部追加 ≤300 字的事实（已恢复在册 / 恢复在册未成功 / 无法确认三档）；原文超预算时按上限截断原文、优先保住这条事实；更新本身仍是失败，绝不自动重试 remove→install、也不把补偿成功当成更新成功。⑤移除失败路径多一发 `setBundleEnabled` 与至多三次 `listBundles`（两次复探各 ≤5s）；恢复调用额度取 max(剩余配方额度, 终止宽限) 再给一次终止宽限，成功路径的调用次数与总上界不变。
- 测试：新增 `tests/issue-236-manager-remove-failure-restore.test.mjs` 11 例（在册失败后恢复并复探、恢复被拒如实报、恢复后复探仍关闭不谎报、装前未在册不二次改拓扑、老宿主无探测不猜、探测抛错不猜、移除超时仍补偿、无 `setBundleEnabled` 不宣称尝试、复探失效说无法确认不写事实、`removeBundle` 同步抛错仍补偿、长原话截断仍保住事实并守 300 字）；双语基线随 `bundle-in-use` 提示与新事实句更新。

门禁（**发版定格**）：`npm run check` **全绿**——`node --test tests/*.test.mjs` **1931 例：1930 过 / 0 失败 / 1 跳过**（主树 `41f7454` + 本批发版文件上实测；一次并发全量下 `tests/batch-e2e.test.mjs` 的 E3b 曾红，单跑与重跑即绿，属已知负载敏感，已在两轮全量中复现并确认与本次改动无关）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（87 个源文件、413 个 key、17 错误码、20 diag 键，违规 0）；`npm run docs:log:check` 过（6 条缺行警告是既有缺行，只警告不失败）；`npm publish --dry-run` **181 文件**（`dsh-plugin-update@0.18.34`，512.9 kB 压缩 / 1.7 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（413 个 key 仍全是 `draft: true`）。

## [0.18.33] - 2026-10-20

### Changed
- **发布线（0.18.26～0.18.32）整体并入 master，本版第一次「合体发版」（#234）**：这一线修的 #215～#232（缺席目标不再被旧失败任务判 recovery-required、批量面板三处显示缺陷、批次停下清自家排队占位、批次续跑换号重提、在装按钮动效、旧账本误导帧、忙时队列行文案、本体排第一）原先只活在发布分支，master 上没有——现已并入 master，master 成为唯一可信基线。合并以 master 的目录拆分重构（`src/` 拆进 `core/` `host/` `panel/` `shared/` 域目录）为底座，把发布线的行为改动逐条移植进拆分后的文件；公开面（导出名字与形状）零变。本版与 0.18.32 的差别只有一处：npm 上此前最新的 0.18.32 只含发布线、不含重构，0.18.33 两者都有，运行时行为与 0.18.32 相同。
- **内部目录拆分（#220/#221/#222/#225～#230）首次随包发出**：`src/` 从平铺目录拆进四个域目录——`core/`（服务、账本、队列、批运行）、`host/`（宿主电话、批量宿主、环境与能力）、`panel/`（单面板、批量面板、主题与视图模型）、`shared/`（哈希等共用件）；旧路径保留兼容壳（如 `src/host.ts`、`src/panel.ts`、`src/host-batch.ts`、`src/panel-batch.ts`），包出口的 11 个子路径与导出名一字未改。事件契约、日志行字段、诊断键均未变；域目录与壳的对应关系见 `docs/adr/`。

### Fixed
- **#233 CHANGELOG 在 master 线上缺 0.18.26～0.18.28 三节**：这一线的正文曾只留在 GitHub Release；现按票拆回各自版本节（0.18.26=#215/#214/#213、0.18.27=#216、0.18.28=#217、0.18.29=#209/#208/#211/#218），正文一字未改，只做整行搬移。0.18.26 一节的原发版全量例数未逐字留存，故该节门禁行如实写「不编数字」。

门禁（**发版定格**）：`npm test` **1920 例：1919 过 / 0 失败 / 1 跳过**（主树 `84e4aeb` + 本批发版文件上实测）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（87 个源文件、413 个 key、17 错误码、20 diag 键，违规 0）；`npm run docs:log:check` 过（6 条缺行警告是既有缺行，只警告不失败）；`npm publish --dry-run` **181 文件**（`dsh-plugin-update@0.18.33`，510.4 kB 压缩 / 1.7 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（413 个 key 仍全是 `draft: true`）。

## [0.18.32] - 2026-10-19

### Changed
- 版本号推进，供集成方（爱生活 / OpenCode 调色板 / IM 机器人 / dsh-prompt）统一跟随：代码与 0.18.31 相同，无行为变化；本版只把「当前已验收的修复线」作为一个明确的依赖版本发出来，避免各集成仓继续钉在旧引擎上（旧仓里还有钉 `0.18.25` 的）。

门禁（**发版定格**）：`npm test` **1904 例：1903 过 / 0 失败 / 1 跳过**（主树 `c564ccd` + 本批发版文件上实测）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（52 个源文件、413 个 key、17 错误码、20 diag 键，违规 0）；`npm publish --dry-run` **111 文件**（`dsh-plugin-update@0.18.32`，482.0 kB 压缩 / 1.7 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（413 个 key 仍全是 `draft: true`）。

## [0.18.31] - 2026-10-19

### Fixed
- **#232 批量面板在「有安装在跑」时把已在批次队列里的行说成「加入队列」，还挂「（上次未完成）」，像要手动逐个入池**：真机（2026-10-19 17:53 desktop，爱生活 0.3.74 + 更新器 0.18.30）一次「全部更新」里六家其实早已全部进批次账本（`batch.json`，单消费者逐个装），但未轮到行的按钮在忙时退化成「加入队列」、状态词带「（上次未完成）」，顶部还写「另有 N 个可选择『加入队列』等待」——看起来像生产者-消费者池要人手逐个投递；更早还同屏出现过「已自动继续上次未完成的更新（剩余 0 个）」与「继续上次未完成的更新（剩余 0 个）」。现在：①忙时轮次中未轮到行不再给行内按钮（本来就在队列里、会自动轮到），状态词改「已在队列 · 会自动依次安装」；②原「加入队列」动作更名「优先安装」，只在失败重试等真属于本行的场景出现；③「（上次未完成）」只保留给失败重试行，pending / ready / skipped 不再加尾注；④顶部提示按队列事实写「正在安装 N 个；队列里还有 M 个，会自动依次安装。」；⑤「继续上次未完成的更新（剩余 N）」只在真有未完成行时渲染，`剩余 0` 不再出现。事件契约无变化。
- **#231 重启后首帧先渲染上一轮旧账本，「已安装完成」「N 个已是最新」挂在屏幕上，几秒后自动检查才改口**：真机（2026-10-19 重启后）看到六家写「已安装完成，无需操作」、页脚「1 个待重启 · 6 个已是最新」，但磁盘其实已是新版本、只差重启且仍在自动复查中——旧快照先上屏、新结论后到，用户读到的是过期事实。现在：自动检查在飞且尚无结论时，旧账本不再摆作结果——已完成 / 已最新行显示「正在查询版本信息」，总账改「正在按最新版本重新检查…」；仅在**没有未完成行**时进入这个复查帧（有未完成批次照旧走执行态），检查成功或失败落地后立即恢复原渲染。事件契约无变化。
- 测试：新增 `tests/issue-232-batch-queue-copy.test.mjs` 4 例（忙时轮次中行无按钮且文案为「已在队列」、忙时全屏不出现「加入队列」、旧账本复查帧与「剩余 0」不渲染、「优先安装」只在批量外场景出现）；`tests/panel-batch.test.mjs` / `tests/issue-71-batch-rows.test.mjs` / `tests/batch-detail-dialog-108.test.mjs` 同步更新期望；双语字典新增两个键（`batch.row.batch-queued` / `batch.ledger.checking`，全表 413 个 key 仍全 `draft: true`）；全量 `node --test tests/*.test.mjs` 1904 例：1903 过 / 0 失败 / 1 跳过（一次全量并行下状态采样竞态曾红 1 例，单跑与重跑即绿，属已知负载敏感）；`npm run typecheck` 与 `npm run gate:bilingual` 三道硬门禁过。

门禁（**发版定格**）：`npm test` **1904 例：1903 过 / 0 失败 / 1 跳过**（主树 `c0ce71f` + 本批发版文件上实测）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（52 个源文件、413 个 key、17 错误码、20 diag 键，违规 0）；`npm publish --dry-run` **111 文件**（`dsh-plugin-update@0.18.31`，482.0 kB 压缩 / 1.7 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（413 个 key 仍全是 `draft: true`）。

## [0.18.30] - 2026-10-19

### Fixed
- **#219 批量「正在安装…」按钮出现两枚转圈；爱生活本体被强制排在批量面板最后一行**：真机（2026-10-19 desktop，爱生活 0.3.73 + 更新器 0.18.29）看到在装按钮左右各一枚旋转指示——单面板主题对任何 `[aria-busy="true"]` 按钮自带一枚 `::after` 转圈，批量在装按钮自己还有一枚 `::before` 转圈，两枚叠在同一按钮里；同时用户要求「爱生活本体」作为批量面板第一行，而 `orderTargets` 一直强制 `selfKey` 排最后（自更新安全口径），本体只能出现在最后一行。现在：①批量 CSS 对在装按钮显式关掉主题那枚 `::after`（`content:none;display:none`），整屏只保留一枚 `::before` 转圈（`aria-busy` 语义保留，`prefers-reduced-motion` 照旧关动效）；②`orderTargets` / `createBatchSession` 新增 `selfOrder?: 'last' | 'first'`（默认 `'last'`，自更新安全行为不变），`createMultiHostUpdate` 新增 `selfOrder` 选项透传到会话创建与追加目标，集成方传 `'first'` 后本体占第一行。事件契约无变化。
- 测试：新增 `tests/issue-219-self-order-first.test.mjs` 4 例（`orderTargets` 默认最后 / `first` 第一 / 未知 `selfKey` 不影响顺序 / 去重；`createBatchSession` 的 `order` 与 `entries` 首行；批量宿主 `selfOrder:'first'` 时第一行是本体、缺省仍最后；批量 CSS 关停 `::after` 且 `::before` 转圈只一条）；全量 `node --test tests/*.test.mjs` 1900 例：1899 过 / 0 失败 / 1 跳过；`npm run typecheck` 与 `npm run gate:bilingual` 三道硬门禁过。

门禁（**发版定格**）：`npm test` **1900 例：1899 过 / 0 失败 / 1 跳过**（主树 `1ef7a47` + 本批发版文件上实测）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（52 个源文件、411 个 key、17 错误码、20 diag 键，违规 0）；`npm publish --dry-run` **111 文件**（`dsh-plugin-update@0.18.30`，480.2 kB 压缩 / 1.6 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（411 个 key 仍全是 `draft: true`）。

## [0.18.29] - 2026-10-19

### Added
- **#209 队列与锁卡住时只知道 `update-busy`，批量停下 / 卡住 / 超时都说不清阶段与原因，断网时持续失败的常驻 `warn` 又灌爆目录**：同一使用范围里两个插件撞车时，现场只有一句 `update-busy`——不知道锁被谁持有、已持有多久；陈旧锁回收、意向过期清理、主动放弃排队在日志里都不留行；`update.lock.anomaly` 声明了 `ownerHash`、`update.store.fail` 声明了 `dirHash` 却从不发射，清单与现场对不上。批量驱动更黑：预查失败的目标只改内存相位，驱动抛异常、用户取消整批、队首阻塞都只留在内存里，`stopOnFailure` 停手后连「为什么停」都没有行。断网 / 代理坏时面板每秒轮询一次状态，`host.call.fail` 每失败一次落一行，一天可上万行，真信号被淹。现在：①队列跃迁补齐现场：`update.queue.transition` 增 `holderHash`（行落那一刻持有队列那家的 `hash8(pluginId)`；队列空则省略；与 `lock.anomaly` 的 `ownerHash` 刻意不同名，免得聚合器把两种指纹混着比），`phase` 扩 `pruned`（意向过期被清理）与 `abandoned`（主动放弃）——按意向年龄与 TTL 判定，行落**被摘动作方**自己的目录，同一份队列状态一次写盘可发多条边（逐条待办各自成边沿，同相位、同一家的两条待办各留一行）；`ttlMs` 与时钟由宿主注入（与 pruned 清理同一读数）。②锁异常实发持有者指纹并扩类别：`update.lock.anomaly` 的 `ownerHash` 由声明转实发（锁内容里 `pluginId` / `id` / `pid` / `startedAt` 的 `hash8`），新增 `busy-owner`——抢锁遇到**新鲜持有者**时记 `ageMs`（它已持有多久）与 `ownerHash`，同一动作方被同一持有者连续挡住只记首次、换持有者才再记；`stale-owner` / `release-failed` 一并补指纹。锁年龄读数统一走 `queueLockAge()`：读得出 `startedAt` 跟注入逻辑钟，读不出回退文件 mtime 时**必须用墙钟**（否则注入假钟减真 mtime 得负值，陈旧锁被误判新鲜——修掉本项引入的 #181 回归）。③`update.store.fail` 实发 `dirHash`（sha256 前 8 位目录短指纹，与 `logDirHash` 同族，绝不入路径原文），磁盘端口与队列端口各按自己的目录算。④批量驱动四类停下各有 1 行：预查失败落 `update.batch.entry.fail{stage:'check'}`（宿主与驱动走同一个发射口 `noteBatchEntryFailure()`，抛异常时 `errorKind:'unknown'`、`index` 仍取整批序号）；驱动抛异常、用户取消、队首阻塞各落一条 `update.batch.summary` 停止行（`stoppedBecause` 扩 `user-cancel` / `error`；`queued` / `stopped-after-failure` 在「没跑完就停下」时也补一条，同一会话同一原因只记一次，`max-steps` / `empty` 不发；停止行的计数取**记行那一刻的最新账本**——驱动异常前已装好的家不会被算成没装）。⑤常驻 `warn` 限速：状态轮询失败按 (pluginId, method) 的 5 分钟时间窗 **首次一条、持续失败每 5 分钟一条心跳（窗口内错误码变化不额外落行，心跳行带当时原因）、下一次成功清记忆**——600 次轮询失败 ≤ 12 行/小时（实测 2 行）；非轮询电话保持一次失败一条，字段与形状不动。事件契约同步：事件总数与档位归属不变（27，常驻 20 / 按需 6 / 自监控 1），字段实发 +3（白名单净新增 1 格 `update.queue.transition.holderHash`；`update.lock.anomaly.ownerHash` 与 `update.store.fail.dirHash` 原已声明，由「声明未发」转实发），枚举扩三处（新增 `update.queue.transition.phase` 六值、`update.lock.anomaly.kind` 三值两个 `fieldEnums`，`update.batch.summary.stoppedBecause` 五值 → 七值；三者都配了负断言用例）；`host.call.fail` 只扩 guard（轮询失败限速），字段与形状不动。
- 测试：`tests/store-log.test.mjs` 扩到 14 例（队列 `pruned` / `abandoned` 相位与 `holderHash`、一次写盘摘掉同一家两条待办时各留一行（逐条待办主体做指纹盐）、锁 `busy-owner` 的 `ageMs` / `ownerHash` 与「同一持有者只记首次、换持有者再记」、`stale-owner` 的 `ownerHash`、`store.fail.dirHash`、与真发射口 11 行逐字段对账且逐相位指纹不同、两个新枚举的负断言（表外 `phase` / `kind` 被摘字段、整行其余字段照落，`holderHash` 与 `ownerHash` 串名按未知字段摘掉））；`tests/batch-log.test.mjs` 扩到 20 例（预查失败一行的五格字段、驱动异常停止行且计数取最新账本（先装好的家算 ok 不是 0）、队首阻塞停止行、用户取消停止行且再取消不重复、7 值 `stoppedBecause` 枚举负断言）；`tests/host-log.test.mjs` 扩到 12 例（600 次轮询失败只 2 行且字段形状不变、5 分钟心跳窗口内不重复、成功清记忆后再次失败重新记一条、错误码中途换掉仍不额外落行、非轮询电话不受限速）；`tests/issue-181-lock-ttl.test.mjs` 既有回归继续通过（注入假钟 + 空锁 mtime 一小时前，陈旧全局锁仍能被回收——本项引入的时钟回归曾让它变红，修复后才全绿）。
- **#208 批量更新出问题时，日志里拼不出「这一批」**：批量面板空白 / 某一行失败不知道为什么 / 「全部更新」一直转圈时，现场只有零散行——批量面板与批量入口件不传 `clientLog`，挂载、点击、渲染失败在客户端零行；三条批量常驻行彼此没有关联字段，说不清是不是同一批；失败行只有错误码，分不出是查询、提交安装、等终态超时还是收尾失败，也不知道是哪一家（视图只推进选中行时更对不上序号）；总账只给计数，不回答「为什么停」；批量队列端口漏传 `logFor`，`update.queue.transition` / `update.store.fail` 落不到动作方目录；七个批量电话失败在批量侧一行不留。现在：①批量面板接入面板同一条客户端日志通道：挂载行报 `mode:'batch'`、22 种批量动作行带 `ok` / `errorKind` / `durationMs`、渲染失败行走 `phase: mount|paint|poll|global` 与全局 `onerror` / `unhandledrejection` 兜底；面板自建通道打 `<批量前缀>.logAppend`，由批量宿主转发给属主插件的 `logAppend`（属主存在且接了日志才登记；批量入口件同报 `mode:'batch'`）。②三条批量行都带 `sessionHash`（批次编号的 8 位指纹）：同一批的入队 / 失败 / 总账可聚合，行分散在不同目录也认得出。③`update.batch.entry.fail` 扩 `stage`（`check` / `install` / `timeout` / `settle`）与 `index`（该目标在**整批**里的 0 基序号，视图过滤不串号；算不出就省略，不拿 0 冒充第一家），`exitCode` 维持「真拿到才有」。④`update.batch.summary` 扩 `stoppedBecause` 五值：`finished`（全部跑完，**不代表没失败**，失败数看 `failed`）/ `stopped-after-failure` / `max-steps` / `empty` / `queued`（进了队列还没轮到，不是失败）；值取最近一次推进的读数，没推进过按 `finished`。⑤批量共享队列端口补上按动作方取口的 `logFor`，队列行落「被装 / 抢锁那家」自己的目录（与单插件同形状）。⑥七个批量电话失败各留一行 `host.call.fail`（`method` 全名如 `life.batchCheck`、`kind` 短名、`error` 只认稳定码），同一 `method` 连续同码只记首次、成功即清记忆——`batchStatus` 每 1.5 秒轮询失败也不会刷爆目录。**没指定 `selfKey`（无属主）时的行为一并写清**：批量级两行（入队 / 总账）与七个电话失败行**一行不发**；失败行仍落失败那家自己的目录；批量面板客户端行因宿主不登记 `<批量前缀>.logAppend` 而落不下来（面板侧只计传输失败 / 丢弃，不落行，主流程不受影响）；队列行照旧落动作方目录。事件契约同步：三个批量事件合计新增 6 个字段格（`sessionHash` 三处、`stage`、`index`、`stoppedBecause` 各一处）并新增两个 `fieldEnums` 枚举，事件总数与档位归属不变（27，常驻 20 / 按需 6 / 自监控 1）；`host.call.fail` 只扩 guard（批量电话才去重），字段与形状不动。
- 测试：新增 `tests/batch-session.test.mjs`（三条批量行共享 `sessionHash`、失败行 `stage` / `index` 覆盖四阶段与整批序号、总账 `stoppedBecause` 与最近一次推进一致、无属主时零行边界）、`tests/panel-batch-log.test.mjs`（批量面板挂载 `mode:'batch'`、22 种动作行、渲染失败四 `phase` 与全局兜底、无属主时客户端只计数不落行）；`tests/batch-log.test.mjs` 扩七个批量电话失败行、同 method 连续同码去重与成功清记忆、批量队列行落动作方目录。
- **#211 多源真相缺字段：重启后到底加载了哪一代、失败是网络还是通道、数据源与回退走到了哪，日志回答不了**：用户报「装完还是旧版 / 检查失败 / 版本回退没生效 / 日志是空的」时，常驻行只有零散几格，维护者得靠猜。现在一次补齐五类「为什么」，以 `unknown` 显式记录未知（版本/来源未知写 `null`，枚举指不清写 `'unknown'`，不省略成假值）：①`update.status.changed` 从「只看 `kind`」扩成**八格真值元组**（`kind`/`latest`/`runningVersion`/`installedVersion`/`registered`/`identity`/`blockedReason`/`unknownCause`），边沿键就是整条元组的指纹——运行版变、磁盘版变、在册变、身份变、阻挡原因变都各发一条，`kind:'unknown'` 必带 `unknownCause`（`no-latest` / `running-version-unknown` / `compare-failed`）。②`update.wire.ready` 带更新器版本（`updaterVersion`）、副本层级（`copyLevel` 四值：`profile`/`nested`/`repo`/`unknown`）与宿主形态（`hostKind` 三值：`desktop`/`desktop-manager`/`cli`，与读取器同一取法归一使用范围名）；外部落点门径没验过不再自称 `external`，记 `external-unverified`（`logSink` 枚举扩值）——`false`（closed）时这一行会被对方准入跳过，属如实边界，现场以 `logHealth.external` 为准。③`update.panel.mount` 带 `autoCheck` 四态事实：`started`（自动查已发起）/`recent`（首刷快照已有结论或任务在飞，跳过）/`disabled`（调用方 `autoCheck:false`）/`failed`（首刷失败没拿到状态）；面板行与安装按钮挂载行都挪到首刷（含首刷触发的自动查）落定之后发，保证记的是「跑没跑」而不是预告（面板挂载项新增可选 `autoCheck?: boolean`）。④`update.check.fail` 带 `latencyMs` 与 `source`，`errorKind` 从稳定码改成**失败类别十值**（`timeout`/`network`/`dns`/`tls`/`http`/`bad-json`/`too-large`/`shape`/`channel`/`unknown`，由取数处不可枚举成因标记 + 纯函数映射；面板/诊断仍用 `code`，该格不是公开稳定码）；非默认 registry 且主机名不可写时 `source` 落 `'custom'` 哨兵（不泄露地址，只说明非默认源）。⑤`update.check.done` 带 `blockedReason`（`'none'` 或阻挡码）、`fallback`（这次取数走没走通道回退）与 `dataSource`（`npm-version`/`npm-channel`）；通道回退取数与更新说明 tarball 取数（`src/changelog-io.ts`）接上 `update.registry.fetch`（成功/失败/非 2xx 都留行；它是按需事件，默认开关关着不落盘，但常驻的 `fallback`/`dataSource` 仍能回答走没走回退）。⑥短命进程：新增公开入口 `flushUpdateLog({ timeoutMs? })`（包根与 `dsh-plugin-update/log` 都能引），冲刷本插件自建落点的全部在册实例、有界等待、**永不抛**，返回 `{ flushed, timedOut, pending, stores }` 读数；外部落点归集成方自己冲。README 同步写清多进程 / 多副本边界（同进程按目录复用，跨进程共用目录不在承诺内，靠 `updaterVersion`/`copyLevel` 定位写者）与短命进程边界（`info` 行约 1 秒去抖窗口、`warn`/`error` 直通），外部落点两条自检校正为「接线只查门径、merge 清单查不了」。**已知边界（记录，不修）**：`external` + `closed` 时接线行本身被对方准入跳过（没有行可看）；按需取数行默认不落；`flushUpdateLog` 不碰外部实例；2 秒内重复点检查复用上一次结论时不补 `check.done` 行。
- 测试：新增 `tests/issue-211-check-truth.test.mjs`（状态行八格与真值元组边沿、`unknownCause` 三因、`check.done` 阻挡/回退/数据源、`check.fail` 十类失败类别与延迟/来源、非白名单源 `'custom'`）、`tests/issue-211-wire.test.mjs`（三支接线行身份三格、`external-unverified` 口径、`hostKind` 三值含 `profileDir`-only 归一）、`tests/issue-211-flush.test.mjs`（`flushUpdateLog` 读数、超时不抛、无落点返回零）、`tests/issue-211-panel-mount.test.mjs`（面板与安装按钮 `autoCheck` 四态都记事实、`never` 零请求、首刷失败记 `failed`）；`tests/host-log` / `tests/log-contract` / `tests/panel-log` / `tests/gate` / `tests/log-kernel` 同步扩断言（含「契约清单 `fieldEnums` 与实现十值一致」「版本非 semver 不冒充」两处负断言）。

### Fixed
- **#218 批量续跑沿用旧 `requestId`，宿主按编号幂等直接回上一轮的旧任务——账本记「已安装完成」，磁盘其实没装**：真机（2026-10-19 09:24 desktop，爱生活 0.3.73 + 更新器 0.18.28）点「全部更新」后，六个单品账本全 `done` / `targetVersion 0.3.73`，面板行显示「已安装完成，无需操作」，绿色合规横幅却说「已装 0.3.72，不是最新 0.3.73（最新版没装成）」——同屏两套事实；实际日志里 5 家只有 `queue.transition`，没有 `update.install.request` / `update.install.exec` / `update.install.verify`，`updateInstall` 6–8ms 就回 ok；只有作息管家真装（exec 5348ms + verify）。根因两层：①核心 `attemptInstall` 对同一 `requestId` 的重复提交**直接回上一轮 job 快照、不重装**（`src/service.ts`：`previous?.requestId === requestId` 时直接回 `buildSnapshot(env, previous)`）——这是防重复提交的既定语义；②批量账本的 `requestId` 由「会话编号 + 目标 key」派生（`batchRequestId`），续跑会话沿用旧编号，与上一轮已 completed 的 job 编号完全相同，宿主命中的是**上一轮**（装到 0.3.72 那次）的快照；`settleInstall` 又把 `completed` 一律当 `done` 收尾，于是没装也记成功。装成功后自家排队意向也没人撤，下一轮还可能被公平门判 `update-busy`。现在：①驱动层识别「同编号旧任务」的回包：旧任务 completed 的目标版本 ≠ 本次目标版，或旧任务是 **failed / interrupted**，就换一次尝试编号重提（编号形状仍是核心收的不透明串），并落一行 `update.install.retry{reason:'stale-request-id'}` 说明换过号——崩溃续跑同一尝试仍稳定可认；②收尾核对真值：`done` 一律要求回包快照里的 `installedVersion` === 本次目标版，对不上按 `install-failed{stage:'settle'}` 记失败，不再拿旧快照冒充成功；③宿主安装成功后撤掉自家的排队意向，不留到下一轮。事件契约：`update.install.retry.reason` 枚举扩一值（`check-expired` → `check-expired` / `stale-request-id`），事件总数、字段白名单与其余枚举不变。
- 测试：新增 `tests/issue-218-batch-request-id-reuse.test.mjs` 4 例（幂等命中的三种陈旧形状（completed 别版本 / failed / interrupted）与不误伤 in-flight；尝试编号稳定不重复；端到端「旧 completed 任务同编号 + 新目标 2.0.0」必须换号真装——磁盘真到 2.0.0、账本才记 `done` 且 `restartRequired:true`，并落 `stale-request-id` 重试行与新的 `update.install.request`）；对修复前的 0.18.28 代码实测复现「账本 `done` / 磁盘仍 1.0.0 / 无安装事件」，修后 4 绿；全量 `node --test tests/*.test.mjs` 1896 例：1895 过 / 0 失败 / 1 跳过；`npm run typecheck` 与 `npm run gate:bilingual` 三道硬门禁过。

### Changed
- **开发体验：改日志事件、查日志链路，每次都要重读巨型文件并手工同步目录**：仓库 `src/` 近 70 个文件、单文件最大 238KB，没有一张「电话进来 → 日志落盘」的地图——改一个事件要先在 `host.ts` / `host-batch.ts` / `panel.ts` / `panel-batch.ts` 之间找发射点，再读 `event-list.update.json` 与事件目录核口径，最后手抄目录表格。两面板各有一份同源客户端日志壳，批量日志状态混在 `host-batch.ts` 的 1600+ 行闭包里（一次会话实测 `host-batch.ts` 被读 39 次、共 204K 字符）。现在：①新增 `docs/agents/architecture.md`——链路图、地标表（按符号名，不按行号）、「改一个日志事件要动的三处 + 命令」、验证阶梯、30 分钟读码顺序，`AGENTS.md` 加一行指针；②两面板共享客户端日志壳 `src/log/panel-client.ts`（`createPanelClientLogShell`：挂载行 / 动作行 / `render.fail` 四相位与 60 秒去重 / 全局兜底 / 自建通道生命周期），`panel.ts` 与 `panel-batch.ts` 只留接线；③批量日志状态抽到 `src/host-batch-log.ts`（`createBatchLogSeams` / `pluginLogPort` / `emitBatchLog`：入队去重、总账边沿、为什么停、批量电话失败去重），`host-batch.ts` 减约 150 行；④`scripts/gen-log-catalog.mjs` 与 `npm run docs:log` 从清单生成事件目录 §1/§2 表的事件 / 级别 / 字段三列（`docs:log:check` 只查漂移、`--check` 同义，说明列仍手写）；⑤新增 `tests/helpers/batch-log-harness.mjs` 批量测试共享夹具与 `scripts/log-smoke.mjs` 真 dist 六场景端到端冒烟（多目标 stage/index/sessionHash、电话失败去重、属主 `logAppend` 转发、无属主零行、预查失败→resume、队列归属）；⑥`package.json` 加 `test:batch` / `smoke:log` / `docs:log` / `check` 聚合脚本（`check` = typecheck + build + 全量测试 + 双语门禁）。均不改变运行时行为，也不改事件契约。
- 测试：`tests/batch-log.test.mjs` / `tests/batch-session.test.mjs` 改用共享夹具（断言行不变，24 例）；`tests/log-kernel.test.mjs` 浏览器安全面断言扩到 `panel-client.ts`；`scripts/gen-log-catalog.mjs` 回填事件目录 2 行既有漂移（`update.install.request.intentHash`、`update.changelog.parse.version/status/cached`）。

门禁（**发版定格**）：`npm test` **1896 例：1895 过 / 0 失败 / 1 跳过**（主树 `69899d0` + 本批发版文件上实测）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（52 个源文件、411 个 key、17 错误码、20 diag 键，违规 0）；`npm publish --dry-run` **111 文件**（`dsh-plugin-update@0.18.29`，478.9 kB 压缩 / 1.6 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（411 个 key 仍全是 `draft: true`）。

## [0.18.28] - 2026-10-19

### Fixed
- **#217 批次停下时把排队占位留在共享队列里，之后每次安装都被公平门判 `update-busy`（面板看起来「点全部更新毫无反应」）**：真机（2026-10-19 desktop）批量升 0.3.73 时，上一轮续跑把待装行的排队意向写进共享 `queue.json`（`owner` 为空、`waiting` 里两条），随后因「非队首」停手（`stoppedBecause:'queued'`），而队首那条对应的任务其实已经结束——没人清掉它。`QUEUE_INTENT_TTL_MS` 是 10 分钟，这期间任何安装进公平门都读到「前方还有人」→ `update-busy`，用户点「全部更新」「安装」都只看到毫无反应，重试永远同样结果。现在：①批量每次开跑（用户点全部更新 / 重试建会话、`batchResume` 续跑、drain 每轮推进）先扫掉**自己**（本批次目标且 `requestId` 以 `batch-` 开头）的遗留意向，再走检查 / 安装；②停下时不扫——留下的占位还要给面板显示「前方还有 N 个」并允许「取消排队」（#25 契约不变），用户取消整批时随取消一并清理；③截断兜底：`owner` 为空时意向的过期阈值从 10 分钟收紧到 30 秒（新增 `QUEUE_INTENT_STALE_MS`），`owner` 在位时仍用完整 TTL（正在装的那家不该被抢）。只清自己的意向，别家的一条不动；事件契约无变化。
- 测试：新增 `tests/issue-217-queue-intent-deadlock.test.mjs` 3 例（`owner` 为空 30 秒即过期、`owner` 在位仍按完整 TTL；`updateCheck` 顺带剪掉过期占位并回写、年轻意向保留；批次再开跑前扫掉自家遗留占位、别家意向不动且该行照常装完）；`tests/batch-host.test.mjs` 既有「单插件装电话回 `update-busy`：该家 ready（不是 failed）并带出队列位置」继续通过（停下不扫、取消排队、位置可见都保持）；全量 `node --test tests/*.test.mjs` 1892 例：1891 过 / 0 失败 / 1 跳过；`npm run typecheck` 与 `npm run gate:bilingual` 三道硬门禁过。

门禁（**发版定格**）：`npm test` **1892 例：1891 过 / 0 失败 / 1 跳过**；`npm run typecheck` 过；`npm run gate:bilingual` 三道硬门禁过。

## [0.18.27] - 2026-10-19

### Fixed
- **#216 批量面板说不清「装到哪一步」，批次日志也对不上现场**：真机（2026-10-19 desktop）点「检查更新 → 全部更新」后：①作息管家从 `0.0.0 → 0.3.72` 却显示「已是最新，无需操作。」——实际刚装好、只差重启，`0.0.0` 还是集成方 `MISSING_RUNNING_VERSION` 注入的占位运行版；②备忘录 / 居家管家 / 私家大厨行的「加入队列」按钮文字几乎看不见（档案卷主题把行内按钮底色改成透明，却仍按主按钮规则用白字）；③卡路里「正在安装…」是静态置灰按钮、没有动效，分不清真在装还是卡死。日志侧同样拼不出这一批：07:54:19–07:54:48 装完 7 家（5 家待重启 / 2 家当前）本身没错，但 `update.batch.summary` 的 `durationMs` 按会话创建时刻算（00:48 建的会话收尾报成 25581920ms ≈ 7 小时 20 分），没有「这批从哪来、是续跑还是新点」的起点行；`update.check.done` 不记任务态；`check-expired` 首次提交被设计内自动重查重提却没有一行说明；客户端丢弃只留 `reason`、不记被丢的是哪条事件。现在：①批量检查新增 `done{restartRequired}` 结论——「磁盘已到目标版、只是还没重启」不再落入 current，行状态自动显示「已安装完成，重启宿主后生效」，检查 / 预查 / 对账三处一致；②版本列统一不采信占位版 `0.0.0`（运行版与已装版都跳过，回退另一格或未知），集成方仍传占位也不再冒出来；③档案卷透明底规则排除主按钮与在装按钮并补 `--dsh-update-button-bg`（浅 `#fbf6ec` / 深 `#2a2419`），两处「正在安装」按钮改 `dsh-upd-busy-btn` + `data-busy="1"` + `aria-busy="true"`，带 spinner 与呼吸脉冲（`prefers-reduced-motion` 下自动关）；④日志补现场：新增 `update.batch.run.start{trigger,resumed,total,pending,sessionHash}`（用户入口 / 续跑 / 后台推进各一行）、`update.install.retry{reason,attempt,requestHash}`（check-expired 重查重提不是环境坏了）；`update.batch.summary` 的 `durationMs` 改为**本次推进活跃时长**并新增 `sessionAgeMs` / `resumed`；`update.check.done` 增 `pendingRestart` / `jobState`；`update.log.degraded` 的客户端丢弃行带上被丢事件名。事件契约：总数 27 → 29（新增两条常驻事件），字段白名单净增 12 格（两条新事件 8 格 + `check.done` 2 格 + `summary` 2 格），枚举新增 `jobState` 七值 / `run.start.trigger` 三值 / `install.retry.reason` 一值；事件目录按 `npm run docs:log` 同步。
- 测试：新增 `tests/issue-216-batch-display-log.test.mjs` 7 例（已装待重启 → `done` 且不误判 current、`checkPhone` 对账把旧批次 failed 行改成 done 并带 restartRequired、版本列不出现 `0.0.0`、两处在装按钮带 `data-busy` / `aria-busy`、档案卷 CSS 放过主按钮与在装按钮且含 spinner 关键帧、`run.start` 的 trigger / resumed 与 `summary` 的 `sessionAgeMs` / `resumed`、`check.done` 的 `pendingRestart` / `jobState`、`install.retry` 与 `degraded` 的被丢事件名）；`tests/batch-log` / `gate` / `host-log` / `log-contract` / `changelog-status` / `issue-211-check-truth` 六处契约断言同步扩展（事件总数 27 → 29、档位 22 / 6 / 1、`check.done` 字段与 `jobState` 枚举逐字对账）；全量 `node --test tests/*.test.mjs` 1889 例：1888 过 / 0 失败 / 1 跳过；`npm run typecheck` 与 `npm run gate:bilingual` 三道硬门禁过。

门禁（**发版定格**）：`npm test` **1889 例：1888 过 / 0 失败 / 1 跳过**；`npm run typecheck` 过；`npm run gate:bilingual` 三道硬门禁过。

## [0.18.26] - 2026-10-19

### Fixed
- **#215 缺席目标被旧失败任务判 recovery-required，复制诊断还带 `0.0.0` 假运行版**：真机（2026-10-19 desktop）批量「全部更新」时，昨天那批安装失败留下的 `state.json`（`state:"failed"`）还在，而两个生活类包其实已被卸掉（磁盘与清单都没有）；集成方 `dsh-life-pack@0.3.71` 又按 `MISSING_RUNNING_VERSION` 给缺席目标注入占位运行版 `0.0.0`。老 `buildSnapshot` 的两条任务/版本派生阻拦没有「目标在场」这个前提，`runningVersion !== null && installedVersion !== runningVersion` 在缺席时恒成立，于是「未安装」被误判成「安装现场被弄脏」：检查失败 `recovery-required`、「全部更新」整行报错（本可一次从零装回），复制诊断还把旧任务的 `install-failed` 原话与当帧占位版拼成「运行版：0.0.0 / 已安装：未知 / 最新版：未查过」——与 `CONTEXT.md`「未安装不是任何阻塞原因」和 README「不要伪造 `0.0.0` 之类的占位版号」相抵。现在：①任务/运行版派生的 `recovery-required` / `pending-restart` 只在目标在场时判；②缺席目标快照的 `runningVersion` 恒为 `null`（占位版不进快照、不参与比较，复制诊断/手工命令/日志同源）；③批量复制诊断与宿主失败诊断对「缺席 + 带占位版」的旧形状兜底，显示「运行版：未知」。修复后缺席目标照常可查、可按首次安装从零装好（旧失败任务被本次安装覆盖）。
- 测试：新增 `tests/issue-215-absent-stale-job.test.mjs` 4 例（缺席 + 旧失败任务 + 注入 `0.0.0`：不阻塞、快照无占位版、能按首次安装从零装好；批量复制诊断不含 `0.0.0` 且在场行照常显示真运行版；在场 + 旧失败任务仍判 `recovery-required`，即 #179 不回归）；对修复前源码实测 2 红 2 绿，修后 4 绿。

### Added
- **#214 单面板 UI 故障在默认集成下留不下证据，客户端日志桥的丢弃又悄悄消失**：面板空白 / 白块 / 点哪都没反应时，最关键的证据都在半路丢掉了——挂载校验抛错发生在日志通道创建之前（默认路径 0 行）；`paint()` 异常只留一条没类别、没指纹的 `render.fail{kind:'unknown'}`；`refresh()` 传输失败只锁存不落行；动作行只有 `action`、没有成败与耗时；客户端队列五种丢弃（no-channel / overflow / host-refused / send-failed / disposed）只累加内存计数，宿主 `logAppend` 拒收也不留痕；`dispose()` 直接清缓冲、不冲刷。现在：①挂载校验重排为「先校验 options 与 `call` → 用合法前缀（非法则回落 `wf`）建自建通道 → 再校验 container / pluginId / prefix / pollMs / mode / theme / themeTokens / locale」，失败统一落 `update.panel.render.fail{phase:'mount',kind,errorHash}`（`errorHash` 是 8 位指纹）并尽快冲刷；默认集成（无注入通道）也留得下证据。安装按钮同构（多一格 `auto-check`）。②`update.panel.action` 扩 `ok` / `errorKind` / `durationMs`：成功是 `true` / `null`；失败按锁存稳定码、抛错记 `thrown`、忙时记 `busy`（`bytes` / `truncated` 仍只随 copy-diag 带）。③`render.fail` 扩 `phase: mount|paint|poll|global` 与 `errorHash`：paint 失败、轮询传输失败（`phase:'poll'`、`kind:'transport'`，并累计连续失败次数）、`window.onerror` / `unhandledrejection` 全局兜底（只留指纹、不落原话）；同一 `phase|kind|errorHash` 60 秒内至多一行。④客户端队列白名单 5→6，允许发 `update.log.degraded`：`overflow` / `host-refused` / `send-failed` 每种原因终身各上浮一条 `client-drop-*`；`no-channel` / `disposed` 物理上没有投递面，只记 `droppedByReason()` 计数（copy-diag 可见）。`dispose()` 改为先尽量 final flush 再计弃置。宿主 `logAppend` 拒收时上浮一条 `client-batch-refused`（按实例只记一次，防每秒轮询刷爆）。⑤copy-diag 增「连接」尾段：连续传输失败次数 + 客户端丢弃行数，两值皆 0 时不追加（旧输出逐字不变；HTTP 直挂传输失败由此进计数段，不承诺落盘）。事件契约同步：`update.log.degraded.reason` 枚举 7→12（`client-batch-refused` + 四种上浮的 `client-drop-*`；`client-drop-no-channel` 物理上没有投递面，只进内部分计数、不进枚举），`update.panel.action` / `update.panel.render.fail` 字段与边沿去重声明随清单更新。
- 测试：新增 `tests/client-drop-upward.test.mjs`（五种丢弃原因、每因至多上浮一次、dispose 尽量冲刷、无通道/销毁只计数）、`tests/panel-mount-order.test.mjs`（注入通道 9 种 + 默认集成 8 种挂载校验失败各恰好 1 行、非法前缀回落 `wf`、安装按钮同构）、`tests/panel-render-fail.test.mjs`（paint/poll 同指纹去重、全局 error/unhandled 只留 hash、连接段进 copy-diag、卸载拆监听）；`tests/client-log` / `tests/panel-log` / `tests/log-contract` 同步扩断言，装载/卸载用例区分「轮询电话」与「卸载前日志冲刷电话」。

### Changed
- **#213 有新版，但更新说明一片空白时分不清是谁的锅**：`update.changelog.parse` 由按需升为常驻 + 边沿（清单档位 19/7/1 → 20/6/1，事件总数仍 27），并扩 `version` / `status` / `cached` 三格——`status ∈ ok|empty|missing|fetch-failed|parse-degraded|cache-hit`，前五格是内容成因（解析出了结构 / 文件在但是空的 / 包里没这个文件 / 取数这步没成 / 有内容但解析不出结构），`cache-hit` 只表示这一帧回的是宿主缓存；缓存命中同样发一行，边沿指纹含 `version`（两个版本即使行字段完全同形也各发各的，同版本同组合不重复）。宿主 `updateChangelog` 回包新增 `status` 与 `cached`（`markdown` 形状不变）：缓存命中时回包的 `status` 仍是那次取数的**原始内容态**，不会被重算成「包里没这个文件」。面板空白说明按 `status` 分四种文案（作者没写 / 文件是空的 / 取数失败 / 解析不出结构），不再一律说「作者未提供更新说明」（分档话术落在**单插件面板**；批量面板的说明链路是 #208 的范围，本项未动）。`degraded` 位随之明确成「这一版没有可用内容」（`status !== 'ok'`）：老写法 `markdown === null` 只在 `parse-degraded` 那一格与它不同（老写法说 false，现在说 true），其余四态结论一致，字段名与类型都没变。顺手堵一格：宿主给了**结论性**分档（空 / 缺 / 取不到）却没有正文时，面板不再把上一版的正文留在新版标题下（那会让空白区既拿不到分档话术、还可能把旧版说明冒充新版）。闸门比的是「屏上正文所属版本 vs 当前新版」，不是「回包版本 vs 当前新版」——升版会另发一通取数电话，慢的那通可能是**上一版**的迟到答案：回的正是屏上这一版就不许清（否则会把新版刚上屏的正文擦掉），屏上正文更旧则要清（连跳两版时中间那版的空白也算数）；显式文本不绑版本，永不参与该判断；版本号**暂时**读不到那一帧（重查在飞、快照里没新版）也不作废已记的分档——那一帧本来就不渲染，作废只会让同一版的话术凭空丢掉，等版本号回来再按「同版保留、异版作废」判。判不出分档的老宿主行为一字不变。**已知边界（本项取舍，verify-213 N2）**：版本号暂缺那一帧里若到达的是**另一版**的结论性空白，屏上那段更旧正文仍会被清掉——版本随后若回到那一段所属的旧版本，正文要等面板重挂才回来（那期间显示通用句，不是错正文）；反向取「null 帧不清」会让旧正文挂在新版标题下（G1 同族），更重，故取「清」。**另一条已知边界（父版本即有，本项不覆盖）**：正文本身仍未与版本绑定，升版窗口里上一版正文的迟到回包仍可能短暂盖掉屏上这一版的正文，直到当前新版的回包到达才纠正。取数层新增 `fetchReleaseChangelogOutcome`（成因与文本一起回），`fetchReleaseChangelogText` 保留为兼容口、公开契约一字不变。顺手修 `truncated` 位：老写法 `report.truncation ? true : false` 恒为真，改成按截断台账计数判定。**已知边界（本项不覆盖）**：版本文档（registry JSON）那一步没成时走既有检查失败体系（回包 `ok:false` / `check-failed`，日志留一行 `host.call.fail`），不发 changelog 行——那是元数据没取到，不是「说明文件」的成因，重查即可。
- 测试：新增 `tests/changelog-status.test.mjs`（六例：五种内容成因各恰好一行 + 缓存边沿只发一次、空白三态互不同形、跨版本不互相抑制、行内不出现路径/URL/凭据、清单档位与字段冻结），`tests/panel-changelog-status.test.mjs`（分档四句话术各上各的、老宿主/认不出/`ok`/`cache-hit` 逐字节保持旧文案、显式文本永不被覆盖、新版空白回复清掉上一版正文），`tests/gate.test.mjs` 的档位断言同步到 20/6/1。

门禁（**发版定格**）：`npm test`、`npm run typecheck`、`npm run gate:bilingual` 三道硬门禁过（各票用例数见本节各条「测试：」行；**本节为 #233 回填**，原发版时的全量例数未逐字留存，故此处不编数字）。

## [0.18.25] - 2026-10-18

### Fixed
- **#174 失败之后还剩不剩路，面板从不区分**：装不了时，有时还有自动救援（重新查询、等忙任务退出、重启宿主、切通道、修清单、升级运行时、装合规版），有时只剩一条手工命令，有时连命令都没有——三处渲染点此前一律按「失败」平铺，用户分不清是该点重试还是该去复制命令。现在新增纯派生模块 `src/last-resort.ts`（单一真源，不动 `src/codes.ts` 码值、不加快照字段、不改 verify 事件）：`lastResortVerdictOf` 给出四态 `last-resort` / `salvageable` / `dead-end` / `unknown`，救援路径表用穷尽 `Record<BlockedReason, …>` 收口（新增阻塞码不登记会直接编译红，测试再遍历 `BLOCKED_REASONS` 兜底）：安装失败有合规版决议 → `install-compliant`；查侧三码与 `pending-restart` 的运行版未知 → `recheck`；`update-busy` → `wait-retry`；`pending-restart` → `restart-host`（`registered === false` 时改 `select-in-host`，不把未证明的登记当事实）；`channel-mismatch` → `switch-channel`；`registry-conflict` → `fix-manifest`；`incompatible-node` / `incompatible-dsh` → `upgrade-runtime`；`invalid-installation` / `installation-changed` / `unknown-profile` / `source-install` / `dev-source` / `recovery-required` 与 `internal` 认不出 → 按证据落 `dead-end` / `unknown`。**只有**「没有救援 + 当帧命令可信」才判 `last-resort` 并高亮；没有救援也没有命令（`dead-end`）保留 #92 的 05 章原因说明，绝不画一条空的红色高亮。三处落点同形：单插件面板失败块顶行、批量失败行状态区与展开详情、槽位安装按钮的手工命令折叠区——A′ 形态（左侧红轨 + 行内 SVG 警示图标 + 「最后手段」徽标 + 状态短语 + 归因句 + 紧凑主按钮），`data-last-resort="<kind>"` 是统一钩子、语义类 `.dsh-upd-lastresort` 只在 `last-resort` 出现；命令正文仍留在「05 手工命令」章，标题旁加小徽标，不重复塞进条里。批量行内不新增按钮（沿用详情既有的复制手工命令），行状态区只加轻量标记。
- **#177 失败回包沿用旧命令，被当成当帧事实展示/复制/高亮**：`manual` 此前只要非空就展示与复制，但失败回包里的值是上一帧沿用的旧读数，可能已经过期甚至指向旧版本；更糟的是「沿用旧值」与「当帧确认没有命令」在渲染侧无法区分。现在 `manual` 的可信度按渲染帧判定（`frame` / `carried-over` / `null`）：单插件面板、槽位安装按钮、批量（`host-batch` 的 `RowCache` 逐行记录）一致——只有与当前快照同一份成功回包且回包带 `manual` 键才算 `frame`；失败回包沿用旧值即 `carried-over`，三处 fail-closed：不展示命令、不给复制、不高亮，改显示「手工命令尚未按当帧读数确认，重新查询后再复制」。失败回包之后面板静默补读一次 `updateStatus`（只读、只应用成功的读数、不写失败锁存、不重试、不制造新失败帧）：补到当帧命令就恢复 `frame` 并按最后手段渲染，补不到就保持失败帧等下一次轮询。宿主成功回包不带 `manual` 键时一律按「当帧没有命令」处理（老宿主同样诚实口径），不再让旧命令无限续命。
- **#174 复制成功反馈改在按钮之外（按 #172 定案的交互口径）**：原先复制成功会把按钮文案换成「已复制」，按钮的可访问名与图标跟着跳变，想再复制一次还得等它换回来。现在按钮文案与图标前后一字不变，改为在按钮正上方浮出「已复制」气泡（`role="status"`，`position: fixed` 按按钮矩形定位、不挤动布局，约 1.4 秒消失，`prefers-reduced-motion` 下直接出现/消失）。同时按同一口径补齐按钮交互：hover 有主色边框 + 2px 外环（不再只靠 `brightness`，主按钮 hover 仍保持白字对比）、`active` 下压、`focus-visible` 用外环而非去掉 outline；`forced-colors` 下用系统色描边。
- **#204 宿主内解析使用范围（profile）只靠目标包反推目录**：`getSharedReader` 此前只有「显式 `readerOverrides.profileDir`」与「从已定位目标包目录反推」两条路，插件明明跑在某个 profile 内也会报 `unknown-profile` / `dev-source`；默认集成只传 `ctx`，因此直接受影响。现在增加 DSH 权威身份解析链：显式 `profileDir` / `profileName` → `ctx.profileContext`（DSH 在插件挂载前注入，含 `name` 与 `dir`）→ 第三方 Desktop 的 `ctx.desktopProfiles.current`（`{ name, dir }`）→ 显式传入的 `readerOverrides.env.DSH_PROFILE_DIR`（名字取 `DSH_PROFILE`）→ 目标包反推兜底；只有完全没有 profile 上下文、也没显式覆盖且反推不到的嵌入场景才保留 `unknown-profile`（开发态挂载的 `dev-source` 语义不变）。解析出的名字用于环境判定、读取器、安装执行器、手工命令 `--profile` 与共享读取器键；不读隐式 `process.env`、不新增端口。
- **#92 手工命令为空时只剩一句含糊话**：`manual` 为空时 05 章只写「使用范围无法识别或源码安装场景不提供」，把「源码安装 / 开发态挂载 / 认不出范围 / 运行版本未知 / 没有安全候选」五类原因混成一句，用户猜不到该做什么。现在按快照事实分因：新增 `manualAbsentReasonOf` 纯函数（单一真源），单插件 05 章、批量失败横幅的置灰说明、批量「复制手工命令」聚合注释行都按原因写清下一步（批量注释逐家写，整段仍可安全粘终端）。给不给命令的政策不变（#98 不降级 / #153 不覆盖源码安装 / #182 运行版未知不猜 / #201 命令必须可执行）——本项只改「为什么没有」的话术。审查后收紧：源码安装 / 开发态 / 范围认不出三类的判据与 `manualCommand` 早退共用 `manualCommandSuppressedBy` 单一 predicate，不再两处各抄；旧快照缺 `runningVersion` 格视为判不出给兜底句，空串按「运行版未知」；批量置灰说明只在整批原因一致时点名原因，混杂时中性一句；聚合注释行只写原因句、不套整句抬头；「没有安全候选」与 dev-source 文案按对抗审查改成可能式说法（不再断言未验证的原因，也不再说「生效」）；`verify-*.html` 验资页面里的旧句同步替换（`docs/research/52-inventory.md` 属历史清点快照，保留原样）。

### Changed
- 公开面（加法扩展）：新增内部纯派生模块 `src/last-resort.ts`（不新开包导出子路径）；对外在既有 `./panel` / `./install-button` 子路径增加可选入参与类型转出——`LastResortKind` / `RescueRouteKey` / `ManualSource` / `LastResortVerdict` 等类型可被消费者命名；`PanelRenderInput` 新增可选 `manualSource` / `fallbackAvailable` / `runningVersionKnown` / `copyBubble`，`renderInstallButtonHTML` 的 opts 新增可选 `manualSource` / `failureCode` / `fallbackAvailable`，批量行视图新增可选 `manualSource`。全部可选，不传即旧行为。
- 契约（只增不改）：新增双语 key `panel.lastresort.badge` / `.status` / `.reason` / `.copy` / `.copied`、`batch.lastresort.row-badge` 与 `panel.manual.stale`，以及 #92 空态分因的 `panel.manual.absent.unknown-profile` / `.source-install` / `.dev-source` / `.running-unknown` / `.no-safe-candidate` 与 `panel.manual.absent-comment` / `panel.manual.absent-comment-unknown`（`draft: true`；中文不含冻结词）；快照字段、verify 事件字段、`manualCommand` 安全政策与 `src/codes.ts` 码值全部不变。批量行回包新增可选 `manualSource`（加法扩展，旧宿主无此格按未知处理）。
- 测试：新增 `tests/last-resort.test.mjs` 31 例（四态 × 命令来源三态、11 个 `BlockedReason` 与 5 个电话失败码逐项遍历、错误输入 → `unknown`、`pending-restart` 的 `registered` 分叉）与 `tests/issue-174-last-resort-render.test.mjs` 14 例（单面板 / 批量行与详情 / 槽位三处 A′ 形态与钩子、carried-over fail-closed、无命令不出空高亮、补读成功/失败两例、复制气泡与按钮文案不变、CSS 令牌与无障碍降级）；`tests/install-button.test.mjs` 另补槽位补读成功/失败两例；`tests/batch-host.test.mjs` 的字段冻结清单按 #177 增补 `manualSource`（只增不改）。全部先红后绿。
- 文档：README §5.3 改为「成功后刷新；失败回包后先补一次当帧读数，补不到不展示旧命令、只给重新查询」，新增 §5.10 说明四态判定、三处落点、A′ 形态与无障碍/交互约定（集成方手册口径，不写票号与设计理由）。
- 文档：README §2 补使用范围（profile）解析顺序与 `unknown-profile` 边界，排错第 13 条按新来源改写。
- 测试：新增 `tests/issue-204-profile-identity.test.mjs` 6 例（`profileContext` / `desktopProfiles.current` / 显式 `env` 三来源各一例；无来源仍如实 `unknown-profile`；开发态外部目录仍 `dev-source`；相对路径目录跳过不崩），先红后绿。
- 文档：README §5.3 重写「手工命令为空」的五类原因与下一步，排错第 7 条同步。
- 测试：新增 `tests/issue-92-manual-absent.test.mjs` 18 例（分类纯函数 3 + 单插件 05 章 9 + 批量面板 6，覆盖五类原因、兜底、有命令回归、已最新不硬套、混杂原因中性置灰、判不出原因写「原因未知」）；`tests/issue-176-batch-copy-all.test.mjs` 两条断言按新文案更新。

- `package-lock.json` 的 `version` 与 `package.json` 对齐：此前锁文件停在 `0.16.4`（只影响本地 `npm ci` 的元数据，不影响发布内容），本次发版一并校正到 `0.18.25`。

门禁（**发版定格**）：`npm test` **1646 例：1645 过 / 0 失败 / 1 跳过**（主树 `0e1d043` + 本批发版文件上实测）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（47 个 src 文件、387 个 key、17 错误码、19 diag 键，违规 0）；`npm publish --dry-run` **101 文件**（`dsh-plugin-update@0.18.25`，413.7 kB 压缩 / 1.4 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（387 个 key 仍全是 `draft: true`）。

## [0.18.24] - 2026-10-18

### Fixed
- **#194 审查跟进（Spec 轴 HARD）**：①旧实现在长名单退让时只在第一条候选里带 `approve-builds` 命令，名单一长就退到一句「去宿主插件页批准后重试」——而宿主页的批准入口只出现在宿主自己的安装失败页，本包的 `updateInstall` 走不到，等于告诉用户一个不存在的按钮；现在批准命令（没有命令时是诚实的宿主页说法）是**每条候选的固定部分**，退让只发生在「点名多少个包」（全名单 → 少点几个 →「首个 等 N 个」→「有构建脚本被忽略」），命令不再丢。②`stale-approval` 的文案与文档原写「重试一次即可」自相矛盾（宿主对不在 pending 名单里的名字会再次抛 `stale-approval`）——改为「名单已过期（宿主已重新记录），重新发起安装、不要沿用上次的名单」；同时补文档：带 `approvedBuilds` 重试必须换**新的 `requestId`**（同一个 id 会被去重直接返回旧失败快照，不会重试）。
- 批准名单归一收紧：`normalizeApprovedBuilds` 从纯 shell 白名单改为「npm 包名文法 + shell 安全」双重过滤——`../x`、`a/b/c`、`包@版本` 这类不是包名的字符串不再交回宿主（scoped 名 `@scope/name` 仍支持）。
- **#197 同一颗「安装」按钮三种身份不可辨别**：查新版时由核心按「磁盘在场 + profile 清单登记 + 版本比较」判定安装身份，写进快照新增的 `identity` 格——`update`（磁盘装着旧版、清单在册：正常换版，官方桌面版走 remove→install，失败如实报）、`first-install`（磁盘没有、清单也没登记：**新增依赖的首次安装**，装完要重启宿主才会加载，不是换版）、`up-to-date`（磁盘已是远端这一版：直接说「已是最新」，不再发起一次注定空转/被拒的安装）。判定不了为 `null`（例如清单登记了但磁盘缺失——那是修复现场），**绝不冒充**「首次安装」。面板按身份给三张不同的脸与按钮文字（此前首次安装被说成「有新版本…（当前版本 未安装）」）。
- 读取器在「目标包磁盘缺失」的早退分支也带上清单登记态（此前该分支把 `registered` 留成 `null`）：身份判定与 `includeEnv` 都靠它区分「新增依赖」与「登记了但磁盘缺失」。
- **#198 带凭据 URL 触发时整条失败详情被丢弃**：脱敏规则对 URL 用户信息（`https://user:token@…`）原本「整项丢弃、退到裸短码」，实际详情只剩 `install-failed: operation-error`——用户看不到阶段 / 路由 / 宿主原话，也没有下一步（C 线 F6 探针 `probe-b.mjs` S6）。现在只把 userinfo 那段换成 `<脱敏>@`（`https://<脱敏>@mirror.example.com/pkg`），scheme / 主机 / 路径 / 查询与其余原文照旧保留；命中时在详情末尾追加「（原话里的账号密码已隐去；请核对源地址里的凭据后重试）」——原文在前、建议在后，且被替换过的文本与原样文本从此可区分（正面回应 ADR-0001 决策 2 的旧理由）。300 字 / 复制 1500 字预算与占位符（`<路径>` / `<脱敏>`）行为不变；`file:///` 这类定位不到的已知形状仍原样放过。
- **#182 运行版本未知被伪造成 `0.0.0`**：集成方拿不到「正在跑的版本」时用占位版号交进来，本包原样采用、写进事件 `update.check.done.current` 还参与新旧比较（B 线 R6，真机日志出现两行 `current:"0.0.0"` 随后真跑 pnpm）。现在端口 `readRunningVersion(): string | null` 把「未知」显式化：`null` / 空串 / 非版本一律归一为未知，**不再抛 `unknown-profile` 挡掉整次查询**，也不伪造占位版号。检查 / 决策 / 事件 / 面板统一按未知呈现——快照 `runningVersion` 为 `null`、不宣称「有新版」、不判 `pending-restart`、`update.check.done` 不落 `current`，面板明说「运行版本未知」且不冒充「已是最新」；**入口件、批量面板、复制诊断与手工命令跟同一口径**（未知时不给手工命令、批量详情不退回「正在读取」）；首次安装照常可装；安装路径不再拿未知去比大小（已装时退回磁盘版本这条可靠事实，防降级但不无据拒绝）。
- **#195 新版本声明的 `engines.dsh` 被忽略**：取数层只读 `engines.node`，远端包要求更高 DSH 时检查层认为可装，点装后宿主按 `incompatible-version` 拒绝，用户只见裸码（B 线 R4）。现在两处取数口都读 `engines.dsh`（缺省 `*`），并新增可选端口 `readDshVersion`（集成方注入当前 DSH 版本）：拿得到且不满足 → 检查层提前给 `blockedReason: 'incompatible-dsh'`（加法扩展，双语 / 面板 / 诊断同步）；拿不到就不猜、不误拦（宿主没有公开的 DSH 版本端口）。DSH 自身在 0.x，范围判定按 npm 语义收 caret 上界（`^0.2.0` 不认可 `0.3.x`、`^0.0.3` 不认可 `0.0.4`），预发布目标（`>=0.2.0-rc.2`）按发行版语义比较。宿主真拒绝时把管理器回包的 `error.incompatible[]`（键是 `engines.dsh` 或 DSH peer 包名，`runtimeVersion` 即当前 DSH 版本）翻成「要求 ≥X（当前 Y）」拼在原文之后（原文在前、建议在后，宿主文本仍走脱敏出口，总长仍守 300 字）；CLI 路只拿得到子进程文本，没有结构化明细可翻，如实保留原话。
- **#183 剩余子项：stable 通道遇到 latest 是预发布时永远查不到更新**：远端 `dist-tags.latest` 指向预发布（默认目标 deck 的真实形态）时，检查按旧纪律问 `/latest` 得到 `invalid-release(stage=channel)`——已装稳定版的用户会一直看到「检查失败」。现在检查路径在「latest 不在本通道、但已装版本在通道内」时退回全量包文档，在本通道允许的版本里挑最高发行版（新增取数口 `fetchNpmChannelRelease`，与 `/latest` 同一信任根：名字、包地址、完整性、`engines` 类型逐条校验，坏条目与已标记弃用的版本跳过，4MB 包文档墙）：本通道有更新的正式版就正常给更新（可装），没有就诚实呈现「已是最新」；全量包文档取不到照样大声 `check-failed`，绝不悄悄画成已是最新。已装版本不在通道内 / 未安装时原有的容忍分支不变，`prerelease` 通道不变；装前复核走同一「有效远端版」入口，避免把「本通道最新发行版」误判成远端变了。
- **#185 cli 路超时被折成「普通安装失败」**：出口三到点确实终止了子进程，但 `awaitOutcome` 把「超时」与 `done` reject 都折成 `timedOut:true`，调用方只拿抓取读数当详情——没有输出就是空；用户读到通用兜底文案，既不知道是超时，也不知道进程已被终止（A 线 R4，探针 `hasDetail:false`、`terminateCalls:1`；同一件事在出口二早有冻结中文）。现在结局三态分开（自己收尾 / 崩了 / 到点）：超时详情点名「安装超时，已终止子进程」，宿主没给 `terminate` 就如实说「宿主未提供终止能力，这次安装可能仍在后台继续」；`done` reject 是崩溃、不是超时，立即失败并写「宿主子进程能力异常，安装未完成」；到点后仍给 3 秒终止宽限，宽限内以 `exitCode 0` 收尾按成功算；抓取读数原文永远在超时口径之前（总长仍守 300 字）。没超时的非零退出保持原有形状。宽限内自己收尾（非零/崩溃）不再谎称「可能仍在后台继续」，改写「任务随后退出，安装未完成」；`terminate` 调用抛错也不许说「已终止」，改写「终止进程失败，这次安装可能仍在后台继续」；出口一（桌面服务）同步这一矩阵（`tests/issue-193-desktop-service-timeout.test.mjs` 相应补两例）。
- **#190 「装完待重启」三处口径不一致、文案对「重启也不会加载」说满（S3）**：装后任务状态一直硬编码 `restart-required`，日志 `update.install.verify.result` 却按运行版区分 `completed` / `restart-required`，面板待重启判定又是第三处口径（0.13.0 起长期存在）；同时 verify 只证磁盘顶层副本换了版，没核对「在册」——profile 清单未登记该插件时文案仍说「重启宿主后生效」，而重启也不会加载。现在装后状态收敛到一处真源 `postInstallStateOf`（磁盘 / 运行两事实）：磁盘已到目标版且运行版也换成目标版才 `completed`，运行版未知 / 还是旧的 / 磁盘没到目标版一律 `restart-required`；任务持久状态、`update.install.verify` 的 `result` / `pendingRestart`（历史持久任务重算时同样走它；运行版未知时从 `completed` 回落 `restart-required`，与 #182 同向）与面板待重启判定全部由它派生，不再出现「日志说 completed、任务说 restart-required」。「在册」不改变这个二值状态（未登记是另一根轴），单独由快照新增的 `registered` 格承载（`dsh.profile.bundles` 选中名单，老 / 最小清单退回 `dependencies`；`false`＝磁盘换版也不等于重启后会加载，读不到为 `null` 未知）：单插件待重启横幅在 `registered === false` 时改说「未登记，重启也不会加载」并给「先在宿主插件页选中」的下一步；批量面板的行状态、总账档位（新增「另有 N 个未登记」）、入口摘要标签（待重启 / 未登记分开数，不再把未登记算进「待重启」）与重启横幅（分别计数、全部未登记时不画重启按钮也不给「重启以加载新版本」的假指令）同一口径；`registered` 为 `null` 不冒充事实，沿用原文案。README §5.1 / §5.4 / §9 与 CONTEXT.md 词表同步。

### Changed
- `runInstall` 的类型声明（`src/host.ts` 的读取器覆盖、`src/reader.ts`）补上 `approvedBuilds`，与运行时的透明转发一致。
- 测试：`tests/issue-194-pending-builds.test.mjs` 扩到 12 例（长名单退让后命令仍在、两步配方两次 `installBundle` 都带批准名单、归一上限/保序、路径片段与 `包@版本` 被拒）；`tests/issue-202-noop-install.test.mjs` 的候选（带 `version`）路径补「批准名单转发」断言。
- 文档：README §2 电话入参表、§5.9、`docs/host-install-exits.md` 出口二同步新口径（命令始终保留、`stale-approval` 重新发起、重试换新 `requestId`）。
- 快照形状：七个核心字段 + `identity` + `registered`（`#197` 起加 `identity`、`#190` 起加 `registered`；字段只增不改，老调用方不读也能用）。README §5.1 / §5.4 / §9 同步；`tests/diag-phone.test.mjs`、`tests/phones.test.mjs`、`tests/queue.test.mjs` 的快照形状断言按新契约更新（九字段，属有意的公开形状扩展）。
- 公开契约（加法扩展）：`UpdateSnapshot.registered`（可选格；在册事实，布尔或 `null`，未知为 `null`，老读取器/旧快照没有这一格与 `null` 同义）；装后状态由 `postInstallStateOf` 一处派生（磁盘 / 运行两事实，任务状态 / `update.install.verify` / 面板待重启判定同口径；「在册」不改变二值状态，单独由快照 `registered` 承载），事件字段形状不变；`BatchLedgerCounts.restartUnregistered` 与 `BatchEntrySummary.restartUnregistered` 两格、入口徽标 / 一句话总账 / 分类总账 / 印章新增的「未登记」档（`batch-entry.label.restart-unregistered` / `batch-entry.label.restart-mixed` / `batch.row.unregistered-suffix` / `batch.hint.restart-unregistered` 四个新 key），老调用方不读照旧。
- 测试（#190）：新增 `tests/issue-190-verify-state.test.mjs` 7 例（运行版已换 ⇒ 任务 / verify / 快照 / 面板四处 `completed`；运行版仍旧 ⇒ 四处一致待重启；宿主未登记 ⇒ 快照 `registered: false` 且面板改说「重启不会加载」；正常登记 ⇒ 旧文案一字不变；批量一半 / 全部未登记（全部未登记时不许画重启按钮 / 给假指令）/ 在册未知时沿用原文案）；对 `0.18.24` 源码实测 7 红，修后 7 绿；`tests/{diag-phone,phones,queue}.test.mjs` 的快照形状标题按九字段叫法修正；双语字典快照按新 key / 改后文案重算（373 key，无新增散落中文）。文档：`CONTEXT.md` 词表补「在册（`registered`）」，README 同步。
- README §5.3 修正过期口径：手工命令在范围名含空白 / `$`、反引号、引号、`&`、`;` 等 shell 元字符时**只省略、不给假命令**（`0.18.21` 起的实现；旧文写「会自动加引号」）。
- 测试：新增 `tests/issue-197-install-identity.test.mjs` 6 例（三态身份 + 「未选中但装着」「登记但磁盘缺失」两种不可冒充形态 + 面板三张脸），对 `0.18.24` 源码实测 **6 红**，修后 6 绿。
- 文档：`docs/adr/0001-diagnostics-redaction-boundary.md` 决策 2 修订——URL 用户信息由「整项丢弃」改为「只遮盖 userinfo 段」，并说明末尾说明句为何让「被替换」与「本来干净」可区分；`src/diag.ts`、`src/panel-copy.ts`、`src/store.ts` 的注释同步新语义。
- 测试：`tests/detail-redaction.test.mjs` 与 `tests/redaction-single.test.mjs` 的「整项丢弃」断言改为「只遮盖 userinfo、保留可定位原文 + 末尾说明」；新增超长 fixture 断言（300 字截断后说明仍在末尾、占位符完整）；`tests/fixtures/bilingual/copy-baseline.json` 增加 `src/redaction.ts` 的新中文说明句。
- 测试（#182 / #195）：新增 `tests/issue-182-unknown-running-version.test.mjs` 5 例（未知运行版不伪造 / 不宣称有新版 / 不判待重启 / 事件无 `current` / 面板说「未知」；首次安装照常；入口件与服务端主状态一致；未知时不给手工命令）与 `tests/issue-195-engines-dsh.test.mjs` 9 例（`engines.dsh` 满足 / 不满足 / 预发布比较 / 0.x caret 上界 / 拿不到不猜 / 面板文案；宿主 `incompatible[]` 翻译含 `engines.dsh` 与 peer 包名两种键），先红后绿。`tests/issue-98-channel-mismatch.test.mjs` 三条「分叉守住」按新语义更新（未知运行版不再坍缩成 `unknown-profile`；坏包体按 `invalid-installation` 如实说）；`tests/panel-healthy-diag.test.mjs` 的「运行 null」冻结串改为「运行 未知」。
- 公开契约（加法扩展，字段只增不改）：端口 `readRunningVersion(): string | null` 与可选 `readDshVersion`；`ReleaseInfo.dshRange`（可选，缺省 `*`）；`UpdateSnapshot.runningVersion` 允许 `null`；新 `blockedReason` 取值 `incompatible-dsh`；`readerOverrides.runningVersion` 接受 `null`、新增可选 `readerOverrides.dshVersion`。双语快照与散落文案基线按新 key / 新文案重算（362 key、17 错误码）。
- 公开面（加法）：`registry-fetch` 新增 `fetchNpmChannelRelease`（`service` 垫片同步导出）；既有取数口、事件与快照形状不变。
- 文档：README §5.6 补稳定通道遇到 `latest` 指向预发布时的语义（回退全量包文档找本通道最新发行版；取不到则大声失败），§5.1 `latestVersion` 说明为「本通道最新发行版，不一定是注册表 `latest` 标签」。
- 测试（#183）：`tests/issue-183-prerelease-latest.test.mjs` 由 3 例扩到 6 例（已装 beta 的容忍分支不额外取数 / 本通道无更新→已是最新 / 本通道有更新的正式版→可装 / 装前复核走同一入口、不误报 `check-expired` / 全量包文档 503→大声 `check-failed` / prerelease 通道不变）；`tests/registry-fetch.test.mjs` 新增 3 例（通道回退挑最高发行版、坏条目逐条跳过、名字对不上与连不上分别判无效与检查失败）；`tests/skip-channel.test.mjs` 核心默认通道用例改为回退语义（不再断言 `invalid-release`）。
- 文档：README §3 补「运行版本未知」与「DSH 运行时版本」两条集成口径；§5.1 `runningVersion` 可为 `null`；§5.2 增 `incompatible-dsh` 行；§5.4 待重启辅助判据加未知守卫；§9 兼容扩展清单同步。`docs/maintainers.md` 门禁计数改为 17 码 / 11 阻塞，`docs/research/20261014-log-event-catalog.md` 把 `current` 标为可选（未知时省略），`src/diag.ts` 的 §7.1 行数注释同步。
- 文档：README 第 4 节时间口径补普通 DSH 宿主的终止能力分支与「超时是独立结局」；`docs/host-install-exits.md` 出口三补超时政策（2026-10-18，#185）。
- 测试（#185）：新增 `tests/issue-185-cli-timeout.test.mjs` 10 例（有 / 无 `terminate` 两种超时人话、被终止后落到非零或空退出码仍点名超时、宽限内 `exitCode 0` 收尾按成功算、宽限内自己以非零退出收尾改写口径、`terminate` 抛错改写口径、`done` reject 不算超时、抓取读数原文在前口径在后、接近 300 字时脱敏说明不被剪半、普通非零退出形状不变），`tests/issue-193-desktop-service-timeout.test.mjs` 补 2 例（宽限内非零收尾仍点名超时、`terminate` 抛错如实说终止失败），先红后绿；`tests/fixtures/bilingual/copy-baseline.json` 增加 `src/store.ts` 的四条新中文冻结句。
- **发布口径**：`0.18.12`～`0.18.24` 各段此前均未单独发到 npm（registry 上最近发布是 `0.18.11`，`0.18.8`～`0.18.10` 的内容随它首发）；本次首次把这一整段一次性发成 `0.18.24`，并包含 `0.18.24` 提交之后的 #197/#198/#182/#183/#185/#190 修复。嵌套副本的消费方需自行把 `dsh-plugin-update` 依赖范围抬到 `^0.18.0` 或更新，否则吃不到本版修复（`0.18.16` 起 #196）。

门禁（**发版定格**）：`npm test` **1574 例：1573 过 / 0 失败 / 1 跳过**；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（45 个 src 文件、373 个 key、17 错误码、19 diag 键，违规 0）；`npm publish --dry-run` **97 文件**（`dsh-plugin-update@0.18.24`，394.3 kB 压缩 / 1.4 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（373 个 key 仍全是 `draft: true`）。

## [0.18.23] - 2026-10-18

### Fixed
- **#194 需要批准的构建脚本被静默吞掉**：宿主 pnpm 失败且输出里有被忽略的构建脚本（`postinstall`/原生模块）时，管理器先 `recordPendingBuilds()` 把「等待构建决策」的精确包名写进 `result.pendingBuilds` 再抛；`change()` 把部分结果折进 resolve 出来的失败回包（`…/lib/index.js:1121-1129`、`:2053-2061`、`:2373-2401`），但本包 `ManagerChangeResult` 只抄了 `application` / `error` / `packageResult`，这格被丢弃——用户只看到 `install-failed: <pnpm 原文>`，也永远没有「批准后再试」的通道。现在：失败人话格在宿主原话之后点名需要批准的包（「需要批准构建脚本：<包名…>；在宿主插件页批准后重试，或运行 `dsh plugin --profile <范围> approve-builds`」）；用户批准后把同一批包名随安装请求带回（`approvedBuilds`），宿主先 `approveBuilds()` 再跑 pnpm（`:1992-1995`；认不出/已过期抛 `stale-approval`，重试一次即可）。

### Changed
- `updateInstall` 电话新增可选入参 `approvedBuilds`（`src/ports.ts` 的 `runInstall`/`install` 形状、`src/host.ts` 电话入口归一、`src/service.ts` 透明转发、`src/store.ts` 执行器与管理器 `installBundle` 选项）：形状归一只认安全包名（非字符串、通配、`-` 开头、含 shell 元字符一律丢弃，去重保序、上限 32），只对本次安装调用生效——不进任务、不落盘、不跨请求复用。不传即老形状一字不动。
- 人话格预算：待批名单按宿主给出的精确包名顺序点名；超 300 字时退成「首个 等 N 个」，**批准路径始终保留**（命令只在预算够时附上）；全部候选都放不下时只留截断原文，绝不越界。两步配方第二次安装失败会同时保住「批准建议」与「包已被移除」两条事实。
- 文档：README 第 2 节电话入参表、§5.9 新增「需要批准的构建脚本」条、§9 形状扩展清单（`0.18.23` 起 `updateInstall` 接受可选 `approvedBuilds`）；`docs/host-install-exits.md` 出口二新增同主题契约条目。
- 测试：新增 `tests/issue-194-pending-builds.test.mjs` 10 例（点名与批准路径/批准名单原样进宿主选项/畸形名单过滤/长名单守 300 字/普通失败不误报/两步配方第二次安装保留「包已被移除」事实/电话入参送进 `runInstall` 端口/两步配方 + 长 pnpm 原文时「批准建议」与「包已被移除」两条事实同时存活/首装长原文时批准建议不被截/批准名单不进任务不落盘）；其中先写的 8 例对 `0.18.22` 源码实测 **6 红 2 绿**（绿的两例是「无待批构建不误报」「全无效批准名单不传选项」，旧版本就没有这两条行为）；审查追加的两条长原文回归用例在旧实现上同样红（截断会吞掉建议），修复后全绿。`tests/fixtures/bilingual/copy-baseline.json` +5 行新中文。
- **发布口径提醒**：`0.18.8`～`0.18.23` 十六段都还没发到 npm（registry 最新仍是 `0.18.7`），发版以 `0.18.23` 一次带走即可。

门禁（**发版定格**）：`npm test` **1525 例：1524 过 / 0 失败 / 1 跳过**（干净发版树 + 本批 11 个文件上实测）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（45 个 src 文件、354 个 key、16 错误码、19 diag 键，违规 0）；`npm publish --dry-run` **97 文件**（`dsh-plugin-update@0.18.23`，376.8 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（354 个 key 仍全是 `draft: true`）。

## [0.18.22] - 2026-10-18

### Fixed
- **#203 状态落盘跨插件污染：取消旧字面目录的回退读取**：`createUpdateDiskPorts` 原来在「自己目录没有 `state.json`」时回退读冻结字面 `~/.dsh/updates/dsh-mattpocock-skills-deck/<指纹>`。新版里这个字面**就是默认标识自己的实时目录**：别的插件读到的其实是默认标识正在跑的任务，`healJob`（`restart-required`/`completed` 与自己的已装版对不上 ⇒ `interrupted` + `installation-changed`）顺手把它写回自己目录。真机证据（2026-10-18 01:25）：同一个 deck 任务（job id `aaf9ea32-…`、requestId `rmvco30gx8wcv9`、target `1.9.0-beta.4`）出现在 `life-life-pack`、`dsh-prompt`、`life-calorie` 三个目录，而三份 `before.json` 的 jobId 各不相同——证明它们没有各自跑过安装，只是读别家任务后回写。现在任务与锁都只读自己的新路径；冻结节文字面保留（`legacyPathsForUpdate` 只作迁移与诊断常量，不参与任何读写）。

### Changed
- 兼容说明：从旧版升级的**非默认标识**插件，旧字面目录里的历史任务不再被采信（那份目录现在是默认标识的实时目录，无法区分「自己的老任务」与「别家现任务」）；默认标识不受影响（旧字面即其新路径）。老版本已经污染出来的 `state.json` 无法自动识别归属（老文件没有插件标识字段），下次任务覆盖或手工删除即可。
- `tests/paths.test.mjs`：「读走双读」契约改写为「旧字面不被别的标识采信」，并删除 `ports.legacyPaths` 断言。
- 新增 `tests/issue-203-state-isolation.test.mjs`：真实磁盘端口、同一家目录与使用范围下的两个插件实例——①默认标识跑完的任务不被别家读成自己的（对 `0.18.21` 实测红：读到 deck 任务 `interrupted`/`installation-changed`、`previousVersion` 被补成 1.0.0）；②两个插件各自更新时同一 requestId 只落一个标识目录；③默认标识重启后仍读回自己目录的任务。
- **发布口径提醒**：`0.18.8`～`0.18.22` 十五段都还没发到 npm（registry 最新仍是 `0.18.7`），发版以 `0.18.22` 一次带走即可。

门禁（**发版定格**）：`npm test` **1515 例：1514 过 / 0 失败 / 1 跳过**（干净发版树 + 本批 6 个文件上实测）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（45 个 src 文件、354 个 key、16 错误码、19 diag 键，违规 0）；`npm publish --dry-run` **97 文件**（`dsh-plugin-update@0.18.22`，373.1 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（354 个 key 仍全是 `draft: true`）。

## [0.18.21] - 2026-10-18

### Fixed
- **#201 审查 HARD：候选（合规版）路径的锁后空更新哨兵移到指纹/环境闸门之前**：`installCandidate` 在重取环境后先查 `installationKey`/`eligible`，再判「目标=已装」，等锁期间磁盘被别处换成目标版时会先报一句没有 detail 的 `installation-changed`；#202 的「目标版本与已装版本相同，无需安装」在 `updateInstall(version)` 这条路径上不可达。现在与 latest 路径同序：最诚实的事实（没东西可装）先说。
- **#201 审查 HARD：命令必须可执行，否则宁可不给**：`carrierAddCommand` 原来对使用范围名用 `JSON.stringify` 加引号——那不是 shell 引号（`$`/反引号在 PowerShell/bash 里仍会展开、甚至执行），源地址也是裸拼（含空格/`&` 会被截断）。现在所有插值统一过 `shellSafeArg` 保守白名单（`src/commands.ts` 导出）：使用范围名 / 源 / 规格里出现空白、`$`、反引号、引号、`&`、`;` 等任意一个字符就整条命令省略；`manualCommand` 同一政策，不再返回会被展开/截断的命令串。
- **#168 重装失败详情不再重复同一命令**：`failureOf` 已补过载体命令、`withRemovalFact` 又补一次时，按「原文里已含该命令」去重（`withCarrierHint` 同口径），人话格只出现一份。

### Changed
- `README.md`：§5.9 救急命令形状补 `--registry=<源>`、说明范围名与源取本次配方真实值；「无 `setBundleEnabled`」口径改为「有 `listBundles` 但无启用能力 ⇒ 诚实失败 + 命令」（只有无 `listBundles` 才退回老两步）；新增「宁可不给命令，也不给假命令」条。
- `docs/host-install-exits.md`：出口二命令条补 `--registry=<源>` 与来源说明；新增「命令必须可执行，否则宁可不给」子条（各平台 shell 引号规则不同、`JSON.stringify` 不是 shell 引号）。
- 测试：`tests/routes.test.mjs` 新增使用范围名/源含 shell 元字符 ⇒ `manualCommand` 返回 `null` 的用例（3 例）；`tests/issue-201-manager-recovery.test.mjs` 扩到 12 例（命令带 `--registry=`、范围名/源取配方真实值、不安全插值不编命令）；`tests/desktop-manager-hmr.test.mjs` #168 两例断言完整命令（含 `--registry=`）并新增命令单源用例；`tests/issue-202-noop-install.test.mjs` 新增候选路径锁后竞态 + 正常候选安装 2 例（现 5 例）。
- **发布口径提醒**：`0.18.8`～`0.18.21` 十四段都还没发到 npm（registry 最新仍是 `0.18.7`），发版以 `0.18.21` 一次带走即可。

门禁（**发版定格**）：`npm test` **1512 例：1511 过 / 0 失败 / 1 跳过**（干净发版树 + 本批 11 个文件上实测）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（45 个 src 文件、354 个 key、16 错误码、19 diag 键，违规 0）；`npm publish --dry-run` **97 文件**（`dsh-plugin-update@0.18.21`，372.1 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（354 个 key 仍全是 `draft: true`）。

## [0.18.20] - 2026-10-18

### Fixed
- **#201 启用步的失败/超时也补载体 CLI 命令（Spec 轴 HARD ①）**：原来「换通道」命令被三个宿主拒绝码闸住，恢复选中失败的 `permission`、启用步超时、启用返回 `failed` 这三类都没有下一步；现在一律在原文之后追加同一条 `dsh plugin --profile <范围> add --save-exact <包>@<版本>` 命令（仍原文在前、建议在后、总长守 300 字符）。
- **#201 无 `setBundleEnabled` 不再合成 `bundle-in-use`（Spec 轴 HARD ②）**：宿主没有恢复选中能力时，人话格改说「宿主不支持恢复选中，无法安全更新已装包，请用载体 CLI 原地更新」并补命令，不再复制宿主的「还有别的层在用这个插件」原因——真实原因是能力缺失，和活 fiber 无关。
- **300 字详情上限的越界保护（Spec 轴 JUDGEMENT）**：`withCarrierHint` / `withRemovalFact` 在命令本身超预算（`room <= 0`）时改为只保留截断后的原文，不再把整段事实拼回去；214 字符的长包名不再产出 300+ 字的 detail。

### Changed
- `src/bilingual.ts`：`panel.blocked.installation-changed.action` 文案补「若说明已是最新则无需操作」，消除 #202 空更新哨兵与面板动作「若持续，请重新安装」的语义冲突（key 不变，字典快照同步）。
- `tests/issue-201-manager-recovery.test.mjs`：扩到 10 例（恢复选中失败补命令、恢复选中超时补人话格、无 `setBundleEnabled` 不合成 `bundle-in-use`、`listBundles` 抛错退回旧两步、长包名守 300 字）；对 `0.18.19` 源码实测红基线 4 红（含长包名一例）。
- `README.md`：§5.9 补「恢复选中这一步的失败/超时也补同一条命令」「宿主无 `setBundleEnabled` 时诚实说明书原因」；在册核实条补「装前读取器没给 `registered` 而后为 `false` 仍判失败（无法证明不是新装，保守方向）」。
- **发布口径提醒**：`0.18.8`～`0.18.20` 十三段都还没发到 npm（registry 最新仍是 `0.18.7`），发版以 `0.18.20` 一次带走即可。

门禁（**发版定格**）：`npm test` **1504 例：1503 过 / 0 失败 / 1 跳过**（干净发版树 + 本批 9 个文件上实测）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（45 个 src 文件、354 个 key、16 错误码、19 diag 键，违规 0）；`npm publish --dry-run` **97 文件**（`dsh-plugin-update@0.18.20`，370.2 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（354 个 key 仍全是 `draft: true`）。

## [0.18.19] - 2026-10-18

### Fixed
- **#201 / #202 / #180 的 Standards 轴审查跟进**：
  1. **载体 CLI 命令收成单源**：原来三处人话格各拼一份，移除超时/重装失败两处硬编码 `--profile desktop`、都缺 `--save-exact` 与 `--registry=`、使用范围名含空格时不加引号。现在统一由 `carrierAddCommand(范围名, spec, 源)` 产出，形状与 `src/commands.ts` 的 `manualCommand` 一致（`add --save-exact <包>@<版本> --registry=<源>`，范围名按 shell 需要加引号），三处共用。
  2. **空更新哨兵补锁后重读（#202）**：等锁期间磁盘被别处换成目标版时，原实现先撞安装指纹闸门报 `installation-changed`；现在锁后重读环境先判「目标=已装 ⇒ 没东西可装」，与入口哨兵同口径（放在指纹闸门之前，最诚实的事实优先）。
  3. **`ManagerBundleTopology` 收窄**：删掉从未被读取的 `installed` 格；`listBundles()` 只认宿主证据里出现过的「直接回数组」形状（无证据的 `{ bundles: [...] }` 包装不再猜，形状不符即退回旧两步）。

### Changed
- `README.md`：§9 的 `registered` 冻结文本补 `0.18.18` 语义收窄条款（形状不变、语义=「登记不许倒退」）；§5.9 把 `not-removable` 改称「人话格原因（对外错误码仍是 `install-failed`）」；兜底口径改准确（无 `listBundles` ⇒ 退回老两步盲删，而不是「宁可诚实失败也不盲删」）。
- `docs/host-install-exits.md`：出口二的超时额度表述从「三步共用」改为「四条宿主调用（首装、启用、移除、重装）共用一个额度」。
- 测试：`tests/issue-202-noop-install.test.mjs` 新增「过了入口哨兵、等锁期间磁盘被换成目标版」竞态用例（现 3 例）；失败回包断言从 `JSON.stringify` 松匹配改为精确 `diag.detail`，并断言不建任务（回包不带快照）。
- **发布口径提醒**：`0.18.8`～`0.18.19` 十二段都还没发到 npm（registry 最新仍是 `0.18.7`），发版以 `0.18.19` 一次带走即可。

门禁（**发版定格**）：`npm test` **1500 例：1499 过 / 0 失败 / 1 跳过**（干净发版树 + 本批 8 个文件上实测）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（45 个 src 文件、354 个 key、16 错误码、19 diag 键，违规 0）；`npm publish --dry-run` **97 文件**（`dsh-plugin-update@0.18.19`，369.2 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（354 个 key 仍全是 `draft: true`）。

## [0.18.18] - 2026-10-18

### Fixed
- **#201 桌面管理器路由：已装但未选中的包不再毫秒级撞 `bundle-in-use`**：真机十一件里六件（`dsh-chef`、`dsh-home-ilife`、`dsh-memo-ilife`、`dsh-schedule-ilife`、`dsh-calorie`、`dsh-im-companion`）装着、在跑、但不在 profile 的 `dsh.profile.bundles` 选中名单里；宿主 `removeBundle` 只在目标 bundle `enabled` 时才 deselect + reload，于是活 fiber 还在，移除被 `bundle-in-use` 拒绝（真机 2–3ms 返回）。现在两步配方在移除前先用 `listBundles()` 探一次拓扑：`removable === false` 直接诚实失败（不白跑移除）；`enabled === false` 先 `setBundleEnabled(name, true)` 恢复选中（宿主 `installBundle` 默认也做这一步）再 `removeBundle` → `installBundle`；旧宿主没有这些能力就按老两步走或诚实失败，绝不盲删。
- **#201 失败人话格补「换通道」命令**：`already-installed` / `bundle-in-use` / `not-removable` 这三个码意味着管理器路走不通，失败详情尾部补 ASCII 命令 ` (dsh plugin --profile <范围> add --save-exact <包名>@<版本>)`（仍是原文在前、建议在后、总长守 300 字符）——官方桌面版机器上的载体 CLI 是唯一能原地换版的用户通道。
- **#202 空更新哨兵**：安装请求的目标版本与磁盘已装版本相同时直接回 `installation-changed`（详情写「目标版本与已装版本相同，无需安装」），不建任务、不启动安装。批量行或旧快照拿已装版当目标时，不再等到装后校验才报一个含混的「安装位置变了」。
- **#180 装后「在册」核实收窄为「登记不许倒退」**：新装仍必须进 `dsh.profile.bundles`（或老清单的 `dependencies`），否则 `install-failed`；但更新一个装前就未登记的包不再因为「装完仍未登记」判失败——真机那六件只有就地换版通道，要求登记等于永远升不了级（#201 真机形态）；装前登记过、装后清单里丢了（倒退）仍然失败。

### Changed
- 测试：新增 `tests/issue-201-manager-recovery.test.mjs`（6 例：探拓扑后恢复选中再两步、已选中不碰选中名单、不可移除不盲删、无 `listBundles` 老宿主走旧两步、有探测无 `setBundleEnabled` 诚实失败并给命令、清单行缺 `enabled`/`removable` 格时不拿缺省当否）与 `tests/issue-202-noop-install.test.mjs`（2 例：查完后磁盘被换成目标版 ⇒ 拒绝且一次都不装、对照目标确实更新 ⇒ 正常待重启）；改写 `tests/issue-180-registered.test.mjs`（8 例：新装未登记失败、装前未登记更新成功 ×3 形态、登记倒退失败、正常形态、老清单退回 deps ×2）。未修树红基线实测 8 红（#201 4 红 + #202 1 红 + #180 3 红）。
- `README.md`：新增 §5.9「桌面管理器路由的两步配方（`0.18.18` 起）」（拓扑探测、救急命令、空更新哨兵、在册核实口径）；§5.2 补 `installation-changed` 的「无需安装」子形态。
- `docs/host-install-exits.md`：出口二补「移除前先探拓扑（#201）」与「失败人话格加换通道命令（#201）」两条，写明宿主拒绝次序与真机六件的形态。
- bilingual：新增散落中文 2 条进 `tests/fixtures/bilingual/copy-baseline.json`（启用超时人话、「无需安装」人话）；字典 key 数不变（354）。
- **发布口径提醒**：`0.18.8`～`0.18.18` 十一段都还没发到 npm（registry 最新仍是 `0.18.7`），发版时以 `0.18.18` 一次带走即可。

门禁（**发版定格**）：`npm test` **1499 例：1498 过 / 0 失败 / 1 跳过**（干净发版树 `e2c003a` + 本批 7 个文件上实测）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（45 个 src 文件、354 个 key、16 错误码、19 diag 键，违规 0）；`npm publish --dry-run` **97 文件**（`dsh-plugin-update@0.18.18`，368.2 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（354 个 key 仍全是 `draft: true`）。

## [0.18.17] - 2026-10-18

### Fixed
- **#196 双轴审查跟进（Standards + Spec）**：
  1. **README 不再把 npm 读者指向未随包发布的维护者文档**（Standards 硬违规：`docs/` 不在 `files` 白名单，`npm` 页上那个指针是死链；`AGENTS.md` 也规定 README 是集成方手册、不放仓库内流程）。
  2. **嵌套副本升级指引说实话**：原来只要有使用范围名就渲染「…请先更新该插件，或运行：<命令>」，读起来像载体 CLI 能替代更新所属插件——其实把本包装到使用范围级并不会换掉这个面板正在跑的那份嵌套副本（只让共用使用范围级副本的其他插件先换新）。现在措辞改准确，且**没有使用范围名时不再渲染「或运行：」半句**（原来会留下指向空命令的半句话）；新增 `panel.manual.updater-nested-nocmd`。
  3. **身份在任意面板可见**：footer 身份只在 dialog + 有动作面时画；embedded 与只读渲染（`actions:'none'`）由 05 章兜底一行 ASCII 身份，兑现验收「真机上任意宿主插件面板能看到本面板跑的是哪一份副本」。
  4. 删掉未接线的 `selfUpgradeCommand` 导出（死 API，面板才是唯一实现）；抽 `panel-copy.updaterPartsOf` 统一面板身份 / 诊断行 / 05 章三处「版本 + 层级」规范化，`includeEnv` 两处解析收成 `updaterSelfOfEnv`。

### Changed
- 测试：`tests/issue-196-self-copy.test.mjs` 13 例（新增「无使用范围名不编命令」与「embedded 由 05 章兜底显示身份」；删除死 API 直测）；面板相关回归 82/82。
- `src/bilingual.ts`：`panel.manual.updater-nested` 文案改准确、新增 `panel.manual.updater-nested-nocmd`（354 key），`tests/fixtures/bilingual/strings.snapshot.json` 同步。
- CSS：`.dsh-upd-updater-nested` / `.dsh-upd-updater-id` 补规则，footer 身份字号与 `.dsh-upd-foot-note` 统一 12px。
- `docs/maintainers.md` 发布流程新增预检条：核对已知消费方的 `dsh-plugin-update` 依赖范围；本包自更新走常规面板路径（不在 profile `dependencies` 键里，守卫不拦）。
- **发布口径提醒**：`0.18.8`～`0.18.17` 十段都还没发到 npm（registry 最新仍是 `0.18.7`），发版时以 `0.18.17` 一次带走即可。

门禁（**发版定格**）：`npm test` **1489 例：1488 过 / 0 失败 / 1 跳过**（干净发版树 `7ec97b3` + 本批 10 个文件上实测）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（45 个 src 文件、354 个 key、16 错误码、19 diag 键，违规 0）；`npm publish --dry-run` **97 文件**（`dsh-plugin-update@0.18.17`，365.2 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（354 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.16] - 2026-10-18

### Added
- **更新器自检：面板知道自己现在跑的是哪一份副本（#196，S1，审查 D 线部署偏斜）**：同一台机器上本包可能有多份副本（使用范围级、各消费方 `node_modules` 里的嵌套副本、开发仓库），而修复只随版本走——面板里看到的故障可能来自一份旧副本，用户与集成方都无从分辨。现在（`src/self.ts`）从 `import.meta.url` 定位包根读出版本号与层级（`profile` 使用范围级 / `nested` 消费方嵌套 / `repo` 开发仓库 / `unknown`），并经 `includeEnv` 的环境视图多带两格：`updaterVersion`、`updaterCopyLevel`（不回任何路径）。面板据此：① dialog 页脚显示 ASCII 身份 `dsh-plugin-update@<版本> (<层级>)`；② 「复制诊断」在「宿主」行后多一行「更新器=版本（层级）」（健康态与失败态都带，旧覆盖实现不给则整行省略）；③ 05 章手工命令在嵌套副本时追加一句「本面板的更新器是嵌套副本（版本），被声明它的插件钉住；请先更新该插件，或运行：`dsh plugin --profile <使用范围> add --save-exact dsh-plugin-update@latest`」（使用范围级不画这行）。
- **发布侧依赖治理（#196，`docs/maintainers.md` 新增「发布侧依赖治理」节）**：记录已知消费方的声明范围快照（`dsh-opencode-palette@2.0.28 → ^0.13.0` 钉死旧 minor、`dsh-life-pack`/`dsh-mattpocock-skills-deck → ^0.18.6`、`dsh-im-companion → 精确 0.18.7`）、建议范围 `^0.18.0`（0.x 的 caret 只锁 minor）、以及「本包不能从面板升级嵌套副本，必须先由消费方发版抬范围或用户走载体 CLI」的边界。

### Changed
- 测试：新增 `tests/issue-196-self-copy.test.mjs`（12 例，先红后绿——未修树红基线是 `ERR_MODULE_NOT_FOUND dist/self.js`，覆盖层级判据四态、真实 dist 自检、嵌套/使用范围两级在面板与诊断里的表现、`includeEnv` 两格、页脚身份、05 章命令只在嵌套时出现）。
- `tests/panel-prototype-skeleton.test.mjs`：`includeEnv` 期望补 `updaterVersion`（随 `package.json` 动态读）与 `updaterCopyLevel: 'repo'`。
- `src/bilingual.ts`：+2 key（`panel.manual.updater-nested`、`panel.diag.copy.field.updater`，`en`/`zh` 成对），字典 353 key；`tests/fixtures/bilingual/strings.snapshot.json` 同步 +2 key（--update-snapshot）。
- `README.md` §9：形状扩展补 `0.18.16` 两格环境字段与面板渲染选项 `updater`、兼容扩展清单同步、新增「给消费方插件的依赖声明建议」段。
- **发布口径提醒**：`0.18.8`～`0.18.16` 九段都还没发到 npm（registry 最新仍是 `0.18.7`），发版时以 `0.18.16` 一次带走即可。

门禁（**发版定格**）：`npm test` **1488 例：1487 过 / 0 失败 / 1 跳过**（干净发版树 `02307ec` + 本批 12 个文件上实测；本批新增 12 例，均先红后绿）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（45 个 src 文件、353 个 key、16 错误码、19 diag 键，违规 0；本批新增 2 key、零新增散落中文）；`npm publish --dry-run` **97 文件**（`dsh-plugin-update@0.18.16`，364.1 kB 压缩 / 1.3 MB 解包；比上版多 2 个文件 = `dist/self.js` + `dist/self.d.ts`）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（353 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.15] - 2026-10-18

### Fixed
- **两步配方第二步失败/超时：详情点明「目标包已被宿主摘掉」并给可重装命令（#168，S1，verify-hmr 独立验证）**：`desktop-manager` 路由更新已装包时，#167 的配方先 `removeBundle` 再 `installBundle`；移除成功、重装失败时，失败详情只有第二次的宿主原话，没有一句话告诉用户「目标包现在不在 profile 里」。用户看到的是「安装失败、可以重试」，实际状态是「什么都没装、必须先重装」——两者处置完全不同。现在（含重装**超时**）详情在第二次宿主原话之后补：「目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制手工命令重新安装 (`dsh plugin --profile desktop add --save-exact <包名>@<版本>`)」。宿主原话在前、本包补记在后，总长仍封顶 300 字。
  票面列过三个方向（补话术 / 结构化 diag / 回滚重装）：本版选①补话术——②要占公开形状并给面板新出口，③会引入「回滚本身也可能失败」的第二层状态；①能把状态与下一步一次说清且改动面最小，②留待面板需要「一键重装」出口时再提。

### Changed
- 测试：`tests/desktop-manager-hmr.test.mjs` 新增 2 例**先红后绿**（移除成功后重装失败：原文在前 + 点明不在册 + 可执行重装命令 + 300 字封顶；重装**超时**同样补事实与命令）。
- `tests/fixtures/bilingual/copy-baseline.json`：+1 条冻结抛错文案。
- `docs/host-install-exits.md` 出口二补「两步配方第二步失败的人话格（#168）」；末节「残留风险」改为已修记录。
- **发布口径提醒**：`0.18.8`～`0.18.15` 八段都还没发到 npm（registry 最新仍是 `0.18.7`），发版时以 `0.18.15` 一次带走即可。

门禁（**发版定格**）：`npm test` **1476 例：1475 过 / 0 失败 / 1 跳过**（干净发版树 `499b23d` + 本批 9 个文件上实测；本批新增 2 例，均先红后绿）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、351 个 key、16 错误码、19 diag 键，违规 0；本批零新增 key，`copy-baseline.json` +1 条冻结抛错文案）；`npm publish --dry-run` **95 文件**（`dsh-plugin-update@0.18.15`，359.9 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（351 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.14] - 2026-10-18

### Fixed
- **出口一（第三方 Desktop 的 `desktopPnpm` 服务）补上安装时限（#193，S1，审查 A 线 R3）**：原来 `runDesktopService` 只 `await handle.done`，配方里的 `timeoutMs` 只对另两条路由生效——宿主服务不收尾时作业永久停在 `installing`（审查探针：注入 300ms 额度、假服务永不落定，5 秒后仍未收场），之后所有动作 `update-busy`，用户只能重启宿主。现在照出口二（#184）的纪律补上 deadline + 终止 + 终止宽限：
  1. `done` 带 `terminate` ⇒ 到点调一次，人话格「安装超时，已请求宿主终止」；
  2. 不带 `terminate` ⇒ 一次终止都没发过，人话格「安装超时；宿主未提供终止能力，这次安装可能仍在后台继续」，不谎称已请求终止；
  3. 到点后再给 3 秒终止宽限，宽限内以 `exitCode 0` 收尾按成功算（不把已经落地的改动记成失败），非 0 按失败并带真实退码；
  4. `done` 直接 reject（宿主安装服务崩了）⇒ 立即失败并写「宿主安装服务异常退出」，不伪装成超时。
  失败详情都守「宿主原文在前、下一步在后」，总长仍封顶 300 字。

### Changed
- 测试：新增 `tests/issue-193-desktop-service-timeout.test.mjs`（5 例，先红后绿——未修树五条全红：无 `terminate` 时永久挂住、有 `terminate` 却从不调、宽限内成功被挂住、reject 被拖成超时且无详情、宿主机级作业 12 秒不收尾）。
- `tests/fixtures/bilingual/copy-baseline.json`：+3 条新冻结抛错文案（两条超时口径 + 服务异常退出）。
- `README.md` §5.2 时间口径补第三方 Desktop 的 terminate/宽限说明；`docs/host-install-exits.md` 出口一新增「超时政策」条目（含 `done` reject 口径）。
- **发布口径提醒**：`0.18.8`～`0.18.14` 七段都还没发到 npm（registry 最新仍是 `0.18.7`），发版时以 `0.18.14` 一次带走即可。

门禁（**发版定格**）：`npm test` **1474 例：1473 过 / 0 失败 / 1 跳过**（干净发版树 `58442a0` + 本批 9 个文件上实测；本批新增 1 个测试文件、5 例，均先红后绿）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、351 个 key、16 错误码、19 diag 键，违规 0；本批零新增 key，`copy-baseline.json` +3 条冻结抛错文案）；`npm publish --dry-run` **95 文件**（`dsh-plugin-update@0.18.14`，359.2 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（351 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.13] - 2026-10-18

### Fixed
- **超时语义诚实化（#184，S1，审查 A 线 R5）**：
  1. 安装步超时原来无条件写「安装超时，已请求宿主取消」。管理器**没有** `cancelInstall` 能力时，本包一次取消都没发过（审查探针：`cancelCalls: 0` 却自称已请求），且被判定「超时」的那次安装 20ms 后真的落地（`lateSettleLanded: true`）——用户被告知失败、实际装上了。现在按能力分支：有取消能力保持原文；没有则写「安装超时；宿主未提供取消能力，这次安装可能仍在后台继续」。
  2. 移除步超时原来只说「移除已装包超时，未继续安装」。移除请求可能已经生效：审查实测超时后清单 `dependencies: []`（包已被摘掉）却没有重装，用户以为包还在。现在超时的人话格写明「移除已装包超时，未继续安装；目标包可能已不在册，请重启宿主检查并按手工命令重装」。
  3. 移除超时后的环境读取能看出「已摘选中」（`env.registered === false`，磁盘还在），且 `includeEnv` 带回的使用范围视图也转发同一格（`registered: true|false|null`，旧覆盖实现不给按 `null` 未知）——集成方面板据此识别「包被摘下但没重装」，不再以为包还在（依赖 `0.18.12` 的 `env.registered`）。
- **04 错误信息长行换行（#199）**：单插件面板 04「错误信息」区的日志指引行（中文说明 + 日志路径占位符 + 查看命令 + 插件标识与事件名混排）超宽时被右边框硬裁。现在日志/错误行容器补 `overflow-wrap:anywhere`（与版本号行、批量状态列、安装按钮状态行同风格），内核层一次覆盖双主题；纵滚区横向裁断策略不动，不开横向滚动。只改显示不断数据，「复制诊断」文本逐字节不变。新增 `tests/panel-err-wrap-199.test.mjs`（3 例，先红后绿）。

### Changed
- 测试：新增 `tests/issue-184-timeout-honesty.test.mjs`（3 例，先红后绿——未修树三条全红：无取消能力却声称已请求取消、移除超时不点明包可能已不在册、`includeEnv` 回包不带 `registered`；「有取消能力时口径不变 / 移除超时后不许重装」已由既有 `tests/desktop-manager-hmr.test.mjs` 钉着，不重复）；`tests/panel-prototype-skeleton.test.mjs` 的 `includeEnv` 期望补 `registered: null`（旧覆盖实现不给这格 ⇒ 按未知转发）。
- `tests/fixtures/bilingual/copy-baseline.json`：+1 条新冻结抛错文案、1 条原位改写（散落中文基线「只许减不许增」，新增须在评审里看见）。
- `README.md` §9 补「`0.18.13` 起 `includeEnv` 带回的使用范围视图也带出 `registered`」；`docs/host-install-exits.md` 出口二契约里新增「本包超时人话格」条目（按能力分支 + 移除超时的「可能已不在册」提示 + 可执行重装命令）。
- **发布口径提醒**：`0.18.8`～`0.18.13` 六段都还没发到 npm（registry 最新仍是 `0.18.7`），发版时以 `0.18.13` 一次带走即可。

门禁（**发版定格**）：`npm test` **1469 例：1468 过 / 0 失败 / 1 跳过**（干净发版树 `d071a40` + 本批 9 个文件上实测；本批新增 1 个测试文件、3 例，均先红后绿；本版还带上 `d071a40` 的 #199 面板换行修复，其 3 例已含在总数里）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、351 个 key、16 错误码、19 diag 键，违规 0；本批零新增 key，`copy-baseline.json` +1/改 1 条冻结抛错文案）；`npm publish --dry-run` **95 文件**（`dsh-plugin-update@0.18.13`，358.1 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（351 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.12] - 2026-10-17

### Added
- **装后按「在册」核实（#180，S0）**：装后校验原来只比 `node_modules/<目标包>/package.json` 的版本——磁盘换到目标版本就报 `restart-required`。可「磁盘上有」不等于「重启后会加载」：官方桌面版 profile 的加载名单是清单里的 `dsh.profile.bundles`，宿主只把包体与依赖落盘、没把包重新登记回选中名单时（审查期 probe-b S2/S3 形态：`bundles=[]` + 磁盘已到目标版本；宿主 `removeBundle` 先摘选中、重装又失败），面板会拿到「待重启」的假成功，重启后插件直接消失。现在读取器把在册事实算进环境视图（`env.registered`）：清单有 `dsh.profile.bundles` 就以它为准（目标包名在不在选中名单里）；没有这一层概念的老/最小清单退回 `dependencies` 键。装后校验明确 `registered === false` 即走 `install-failed` 分支，细节写「装完校验没过：profile 未登记该插件（重启后不会加载）」；旧覆盖实现省略本格按未知，不据此判失败（向后兼容）。

### Changed
- 测试：新增 `tests/issue-180-registered.test.mjs`（6 例，先红后绿——未修树红在四种形态：①宿主 applied 但清单没登记（磁盘到目标版、`bundles` 里没有）②`dependencies` 更新了但 `bundles` 仍没有 ③`bundles` 层在但读不成数组（`null`，不退回 `dependencies` 洗成成功）④老/最小清单装后清单里没有该包（证明读的是装后清单）；修复后转绿，另两例钉正常形态与老/最小清单退回 `dependencies` 的成功路径）。`tests/fixtures/bilingual/copy-baseline.json` 只增 1 条新冻结抛错文案（散落中文基线「只许减不许增」，新增须在评审里看见）。
- `README.md`：§9 形状扩展按版本列新增 `0.18.12` 的 `env.registered`，并把「新增可选环境字段」列进向后兼容扩展；§5.4 补「失败优先于待重启」——装后校验失败时快照会同时带 `blockedReason: 'pending-restart'` 与 `job.state: 'failed'`，面板必须先展示失败横幅，不能按待重启说「重启后生效」（本包自己面板已是这个优先级）。
- **发布口径提醒**：`0.18.8`～`0.18.12` 五段都还没发到 npm（registry 最新仍是 `0.18.7`），发版时以 `0.18.12` 一次带走即可。

门禁（**发版定格**）：`npm test` **1463 例：1462 过 / 0 失败 / 1 跳过**（干净发版树 `d803ec9` + 本批 8 个文件上实测；本批新增 1 个测试文件、6 例，均先红后绿）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、351 个 key、16 错误码、19 diag 键，违规 0；本批零新增 key，`copy-baseline.json` +1 条冻结抛错文案）；`npm publish --dry-run` **95 文件**（`dsh-plugin-update@0.18.12`，356.4 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（351 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.11] - 2026-10-17

### Added
- **批量失败横幅两枚批量复制按钮（#176）**：多家安装失败时，失败名单下方多一行——`复制诊断`一次复制全部失败行的诊断文本（按面板顺序逐块 `diagTextOf` 拼接、块间空行，已脱敏），`复制手工命令`一次复制全部失败行的手工命令（有命令的原样一行，缺命令的用 `# <插件名>：无手工命令` 注释行占位，整段可安全粘终端）。集合单一真源 `batchFailedRows`（失败且非排队占位、非待重启、非已装合规版），横幅与两枚按钮永远同口径；一条可执行命令都没有时按钮置灰。新增 `batchFailedRows / batchFailedDiagText / batchFailedManualText` 三个纯函数与两枚 `data-act`（`copy-all-diag / copy-all-manual`），回执带 `{n}` 计数。

### Fixed
- **安装锁自愈（#181）**：旧判据 `if (!current || (job && job.id === current.id)) return false` 拿 `state.json` 当「锁是不是同一任务的」证据，而 0.18.10 之前宿主从不写 `state.json`（#179）——`job` 恒 `null` ⇒ 判据退化成「锁文件能解析就抢」：①1 小时前的崩溃遗留锁会被下一次安装抢走；②别人 `startedAt=现在` 的活锁同样被抢，两进程并发写同一使用范围的 `node_modules`；③空文件/半截 JSON/`null` 锁反而永久 `update-busy`，无 TTL 无自愈，只能手删 `install.lock`（空文件正是 `open(wx)` 之后、写内容之前崩溃的形态）。现在判据只看**时间 + 可解析性**：锁里 `startedAt`（读不出就看文件 `mtime`）早于安装额度 ⇒ 回收并记 `stale-owner`；判不了年龄或未超龄 ⇒ 拒（`update-busy`，且不动别人的锁）。陈旧额度与 `installTimeoutMs` 同源（内置端口由宿主注入，默认 15 分钟），显式注入的 `tryAcquireLock` 保持单参（覆盖实现的旧口径不变）。
- **锁写入原子化（#181 同批）**：建锁改为「同目录写临时文件 → `link` 到锁位」——`link` 在目标已存在时回 `EEXIST`，天然互斥；锁位要么不存在、要么是完整内容，本包再不会留下空锁。不吃硬链接的盘（个别网络盘/FAT）退回 `open(wx)+write`，可用优先。回收与重建之间被别人抢先时直接认输（`update-busy`），不递归重抬。
- **坏锁不再堵死状态读取**：`readJob` 遇到不可解析的锁（空文件/半截 JSON）不再让整次读取失败，而是当「没有锁」继续，把「陈旧与否、要不要回收」留给抢锁那一步判——否则坏锁在快照层就永远 `update-busy`，永远走不到 TTL 回收。
- **锁判据单源化（#181 同批跟进）**：安装锁与跨插件全局锁共用同一套「时间 + 可解析性」实现（`probeLockFile / lockAgeOf / createLockAtomically` 三 helpers；全局锁旧的「读 `startedAt` 差值」分支并入同一判据）。回收动手前加「同代二次核对」（`mtime + size` 未变才删），缩小「判陈旧 → 删锁」之间被别人重建的竞态窗口；`QUEUE_LOCK_STALE_MS` 直接取安装时限默认值，两处额度单源。

### Changed
- 测试：新增 `tests/issue-176-batch-copy-all.test.mjs`（19 例，先红后绿——覆盖按钮出现/消失、失败集合三类排除、无命令置灰、两段聚合文本顺序与块间空行、点击复制回执、双主题成组）与 `tests/issue-181-lock-ttl.test.mjs`（11 例，先红后绿——未修树红在「空文件/非法 JSON/`null` 旧锁永久 `update-busy`」与「别人正在装的活锁被抢走」；覆盖陈旧可解析/空文件旧 mtime/非法 JSON 旧 mtime/`null` 旧 mtime 回收 + 新鲜可解析/新鲜空文件拒绝 + 可解析锁年龄口径（`startedAt` 优先、缺格退回 mtime）+ 坏锁不堵死只读读取 + 全局锁同判据，并断言成功路径放锁、不留 `*.tmp`；首例成功断言加锁释放轮询，消灭并行满载下落锁未放的偶发红）。`tests/store-log.test.mjs` 的锁断言按新判据更新（陈旧改由注入额度造；旧「任务不在而锁还在 ⇒ 立刻回收」的断言反转为「仍拒」——那正是 #181 要改的语义）。
- 验收证据：审查期探针 `.tmp/audit/state/probe-d.mjs` 的 T8 对当前 `dist` 复跑——「1 小时前崩溃遗留锁」被回收且装成（`restart-required`、锁已放）；「`startedAt=现在` 的活锁」被拒 `update-busy`（修复前会被抢走）。空文件/非法 JSON/`null` 三种**新鲜**形态仍按「判不了年龄」保守拒绝，但不再永久：超过 `installTimeoutMs` 后由 TTL 回收（新增测试用 `utimes` 造旧 mtime 覆盖该路径）。T8 探针里「堵死了」的旧提示文字指修复前形态，探针本体未改，以本节与测试为准。
- `README.md` §2.6：批量失败横幅补两枚批量复制按钮口径（与横幅同生灭、无命令置灰）；§3：落盘段补安装锁自愈口径（陈旧阈值 = `installTimeoutMs`；不再需要手工删 `install.lock`）。
- **发布口径提醒**：`0.18.8`～`0.18.11` 四段都还没发到 npm（registry 最新仍是 `0.18.7`），发版时以 `0.18.11` 一次带走即可。

门禁（**发版定格**）：`npm test` **1457 例：1456 过 / 0 失败 / 1 跳过**（干净发版树 `245be3a` + 本批 12 个文件上实测；本批新增 2 个测试文件、30 例，均先红后绿）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、351 个 key、16 错误码、19 diag 键，违规 0；本批新增 2 文案键已进字典+快照，`copy-baseline.json` 未动）；`npm publish --dry-run` **95 文件**（`dsh-plugin-update@0.18.11`，354.6 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（351 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.10] - 2026-10-17

### Added
- **任务状态落盘、崩溃后可恢复（#179）**：宿主默认接线原来把任务读写接在**内存镜像**上（`mirroredReadJob/mirroredWriteJob`），`createUpdateDiskPorts` 的 `readJob/writeJob` 全仓无人消费——真机 `~/.dsh/updates/<插件>/<hash>/` 9/9 只有 `before.json`、没有 `state.json`。后果：①进程一崩任务即失，安装中的任务重启后变成「没有任务」，`recovery-required` 永不点亮，半装态（磁盘已换版、运行版未换）还会被环境比较画成 `pending-restart`，用户看到的是「待重启」而不是「上次安装没完成」；②失败原文与诊断跨进程即失；③`store` 里坏状态/双读/旧影子回退的既有语义全成死代码。现在写任务时**同时落盘**（显式注入照旧优先；写盘失败不挡安装，`store` 已记 `store.fail`），冷启动首次读任务从盘上取回初值，既有 `corrupt → interrupted`、`recovery-required` 换算接上。

### Fixed
- **前版本保真（#186，并入 #179 同批）**：安装开始时把「动手之前」磁盘上的版本记进任务（`previousVersion`；未安装或读不到即为 null，不拿运行版顶替），`before.json` 与 `state.json` 都带上；读回时保留这一格并把非字符串脏值归一为 null；老形状 `state.json` 缺这一格时，状态读取路径从**同一条任务**（`jobId` 对得上才采信）的 `before.json` 补读。两条安装入口共用同一个 `rememberPreviousVersion`，动作不分叉。

### Changed
- 测试：新增 `tests/issue-179-job-persistence.test.mjs`（3 例，先红后绿——未修树红在「安装中必须留下 state.json」「重启后任务必须还在」「before.json 必须记住前版本」）。用例只用公开电话 + 真实临时家目录/临时使用范围，**不注入** `readJob/writeJob`，强制走真实磁盘端口，否则测的又是内存镜像本身。
- `README.md`：§5.1 补任务形状新增的可选 `previousVersion`；§9 的「唯一形状扩展」改为按版本列出（`0.18.7` 的 `diag`、`0.18.10` 的 `job.previousVersion`），并把「新增可选任务字段」列进向后兼容扩展——公开形状变了，集成方手册必须同步，CHANGELOG 披露替不了。
- 验收证据：审查期探针 `.tmp/audit/state/probe-d.mjs` 的 T9 已对新代码复跑转绿——安装失败后磁盘 `state.json` 存在；「重启后」（新宿主实例）`job` 仍在（`failed`，`message` 带宿主原文）、`previousVersion=2.0.28`、`failedJobDiagOf` 仍取得到失败原文（复制诊断不再跨进程即失）。修复前同一探针红在「磁盘没有 state.json / 重启后 job=null」。T8（锁）与 T9 同文件但属 #181，本批未动，锁的语义仍按票面待修。
- **发布口径提醒**：`0.18.8`、`0.18.9`、`0.18.10` 三段都还没发到 npm（registry 最新仍是 `0.18.7`），发版时以 `0.18.10` 一次带走即可；本批不改变既有快照/电话/字段形状，`UpdateJob` 只增 `previousVersion?` 一格。

门禁（**发版定格**）：`npm test` **1427 例：1426 过 / 0 失败 / 1 跳过**（干净发版树 `b44d2c5` + 本批 8 个文件上实测；本批新增 1 个测试文件、3 例，均先红后绿）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、349 个 key、16 错误码、19 diag 键，违规 0；本批零新增冻结中文，`copy-baseline.json` 未动）；`npm publish --dry-run` **95 文件**（`dsh-plugin-update@0.18.10`，349.7 kB 压缩 / 1.2 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（349 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.9] - 2026-10-17

### Added
- **对抗式审查报告（#178）**：`docs/research/20261017-更新系统对抗审查.md`——按「副本 / 取数 / 决策 / 路由 / 宿主能力 / 状态诊断」六层列失效面，S0-S3 分级、可达性（已爆/可爆/不可达）、确定性分档（证实/推断/未证），并按票号挂到地图 #178 的 14 张子票上（#179-#197）。审查本身只写 `.tmp/audit/` 与报告，不改行为。
- **宿主管理器拒绝码的中文下一步（A 线 R1/R2）**：`already-installed` / `not-removable` / `management-required` / `not-bundle` / `bundle-in-use` / `stop-profile` / `stale-approval` / `incompatible-version` / `build-blocked` / `pnpm-missing` / `disk-full` / `permission` 十二个宿主码不再只回裸码——原文在前、一句「下一步」在后，总长仍守 300 字；未知码一字不加，不编造。

### Fixed
- **scoped 目标包永远 `invalid-release`（B 线 R1）**：发行包地址的形状校验原来拿**带 scope 的全名**拼 `/@scope/name/-/@scope/name-<ver>.tgz`，而真实 registry 对 scoped 包用的是 basename（`/@xmanrui/dsh-im/-/dsh-im-4.39.0.tgz`）——于是所有 scoped 目标（如 `@xmanrui/dsh-im`）在检查阶段就判「版本信息无效」，更新日志与合规版候选同死，而宿主管理器本身允许 scoped 目标。现抽出 `tarballPathnameOf`（取 basename），latest 与版本文档两处同一判据；同时按「同源 + 路径后缀」放行私有源的路径前缀（镜像把包挂在 `/mirror/…` 下也算合规）。
- **源地址漏结尾斜杠 / 带路径时取数必坏（B 线 R5）**：`registryUrl` 原来直接字符串拼接，漏斜杠会拼出 `registry.npmjs.orgdsh-plugin-update/latest`（报 `check-failed` 却没有状态码），带路径则 404。现取数前 `normalizeRegistry` 归一（trim + 补结尾斜杠、保留路径），latest 与时间表两条口同源。
- **全量包文档 256KB 墙打死真实包（B 线 R3）**：`fetchPackumentTimes` 单独抬到 4MB（真机 dsh-prompt 314,765B、`@xmanrui/dsh-im` 458,500B 原来直接 `ERR`）；latest / 版本文档仍守 256KB——两边防的不是同一类输入，不跟着放宽。
- **管理器失败丢退出码（A 线 R8）**：`packageResult.exitCode` 不再被丢弃，失败 exec 日志与详情能带上宿主给的退出码（探针给 137 仍记 null 的旧观感消失）。
- **stable 通道 + 远端 latest 是预发布 ⇒ 整次检查永久失败（B 线 R2 / #183）**：缺省 stable 下，远端 `latest` 是预发布时 `fetchNpmRelease` 以 `invalid-release(stage=channel)` 抛，检查整次 `check-failed`，面板连「通道不符」都说不出（默认目标 deck 的 `latest` 正是预发布，真机复现）。现在检查路径在「**已装版本本身也不在本通道**（或压根未装）」时容忍通道外 latest：快照如实报 `channel-mismatch`、`canInstall=false`、latest 回填，不再整次失败；「已装版本在通道内、只有远端最新是预发布」那一支**保持大声失败**——不取全量包文档就分不清「只有预发布更新」与「取数真坏了」，宁可失败也不悄悄画成「已是最新」（另开票做真修复）。

### Changed
- `docs/host-install-exits.md`：补 `saveExact?` 选项说明（本包不传；管理器默认就写精确版本，真机 specifier `0.3.67` 实证），并把「命令行在那台机器上」从待确认改为**实测可用**（官方桌面自带的载体 CLI 可执行 `add --save-exact`，详见审查报告 D 线）。
- 测试：新增 `tests/issue-183-prerelease-latest.test.mjs`（3 例：已装 beta 时不再整次失败 / 已装正式版+预发布 latest 仍大声失败 / prerelease 通道旧能力不变）、`tests/registry-fetch.test.mjs` 补 6 例（scoped 收与拒、源归一、镜像路径前缀、包文档字节墙、通道容忍）、`tests/desktop-manager.test.mjs` 补 3 例（退出码透传、拒绝码下一步、降级宿主给手工命令）。

门禁（**发版定格**）：`npm test` **1424 例：1423 过 / 0 失败 / 1 跳过**（干净发版树 `b91b4dc` + 本批 12 个文件上实测；本批新增 12 例，均先红后绿）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、349 个 key、16 错误码、19 diag 键，违规 0；本批新增冻结中文 12 条＝宿主拒绝码的下一步建议，`copy-baseline.json` 的 `src/store.ts` 白名单 +12（另 1 条因排序位移在 diff 里成对出现），diff 逐条可见）；`npm publish --dry-run` **95 文件**（`dsh-plugin-update@0.18.9`）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（349 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.8] - 2026-10-17

### Added
- **HMR 守卫的回归测试（#167）**：新增 `tests/desktop-manager-hmr.test.mjs`（15 例，黑箱走公开入口）：守卫命中后的按名移除、重试时的全新 `requestId`、移除被拒/抛错/超时、非 `already-installed` 不越权移除、移除后原文仍含 `already-installed` 如实报、宿主没有 `removeBundle` 时走原失败路、宿主回包里没有 `application` 时按 `install-failed` 收场、共享预算两次收场同钟。对上游有判别力：同一套用例指向**未修**的 `src/store.ts` 是 **10 红 / 5 绿**（红的正是新契约的正向要求，绿的正是「别回归」钉子），不是只会变绿的空测试。

### Changed
- **`installBundle` 的调用形状收紧（#167）**：把方法取成常量、显式写成 `installBundle.call(manager, …)`（闭包里的属性收窄会丢，`tsc` 会拦），不再依赖「调用点恰好写成 `manager.` 前缀」这件事。既有发货代码本来就是方法调用、`this` 一向正确，所以这是加固，**不是**修一个已经发生过的故障。

### Fixed
- **已装包更新不再必然被 `already-installed` 打死（#167）**：desktop-manager 路由下，只要目标在 profile 里已经装过（直接依赖，或 `dsh.profile.bundles` 里的名字），宿主的 HMR 守卫就在跑 pnpm **之前**以 `already-installed` 拒绝安装——真机表现是 `update.install.exec ok=false durationMs=4`（同步拒绝，pnpm 根本没起）。旧码把这个错误码当终局失败直接报出，重试也只会得到同一个拒绝，因为守卫只认名字、与版本无关，于是「更新一个已装插件」在这条路由上**永远**不通。现在按宿主自己文档的出路走「如实移除 → 再装」：从 spec 抠包名（`@scope/name@1.2.3` 只认首尾 `@`，抠不出即不越权）→ `removeBundle(包名)` 按名移除（宿主文档注释写的是「Installed dependency or selected bundle name」，所以同一个管理态里的包名也算数）→ 移除成功后再拉起安装；第二次**无论以什么理由失败都如实转述**（若仍是 `already-installed`，摘要里就还是它），第二次不再重调 `removeBundle`、也不与首次共用编号（每次调用各带一个新的 `requestId`）；宿主三态（`applied`／`restart-required`／`overridden`）之外的 `application` 一律按 `install-failed` 收场——`cancelled` 用既有的「安装已被取消」，其余保留宿主原话（认不出形态时写 `application: <原文>`），不编造成功。装、移除、重装三步共用配方里那**一个**默认 15 分钟额度（`INSTALL_TIMEOUT_MS`；调用方注入 `timeoutMs` 时以注入值为准，每步只领剩下的），多一步不放宽总上界；某一步到点（安装步先请宿主 `cancelInstall` 取消，移除步没有可取消的对象）再给 3 秒终止宽限期等它自己收尾（`TERMINATION_GRACE_MS`：额度 20000ms 时实测总时长 23016ms），所以「最坏结束时间 ≈ 额度 + 3 秒」。移除这一步撞上额度时出人话 `移除已装包超时，未继续安装`（不借用「安装超时」的说法，免得让人以为还在装）。**残留风险（未修，已记档 #168）**：移除成功、重装又失败时，详情只有第二次的宿主原话，**不会**告诉用户「目标包现在已经不在册」。

门禁（**发版定格**）：`npm test` **1412 例：1411 过 / 0 失败 / 1 跳过**（266 套；本批新增 1 个测试文件、15 例：HMR 更新的黑箱契约，同一套用例指向**未修**的 `src/store.ts` 是 10 红/ 5 绿，所以它不是只会在新码上变绿的陪跑）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、349 个 key、16 错误码、19 diag 键，违规 0；新增冻结中文只有一条，`copy-baseline.json` 的 `src/store.ts` 白名单 +1，diff 里逐字可见）；`npm publish --dry-run` **95 文件**（343.4–343.6 kB 压缩 / 1.2 MB 解包：两次独立运行同口径，tarball 体积随包内 mtime 微差）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（349 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.7] - 2026-10-17

### Added
- **批量面接上合规版降级（#156 场景三）**：`0.18.6` 只让单插件面板在“最新版被年龄门拦住”时有出路，批量面仍只剩一行失败。现在行级与批量级共用同一套兜底：自动出决议（合规版可用 → 点名版本的确认条，确认后才装，永不静默降级）、收尾给事实横幅、入口徽标同口径；总账把「等重启」与「已装合规版」从失败改记「待重启／已最新」（M1）。安装按钮失败页同样双出口［装合规版］［等新版］，与面板同一口径。

### Fixed
- **异步安装失败不再靠插件标识猜真凶（#156 第四轮 B1/B4）**：生产形状下宿主任务键是 `life-<key>`、与 npm 包名不同名，面板据此认因会认错。宿主新增 `failedJobDiagOf`：快照里任务已失败时，在**成功回包**上补一份机读 `diag`（带目标包名）；面板归因优先机器可读的 `fallbackCauseFromDiag`，成功回包里的 `diag` 也进失败锁存。`store` 三条宿主安装路都收 pnpm 原文并挑出「签名 + 错误码」行，`job.message` 从此带得动面板认得出的因。唯一契约扩展：快照带失败任务时成功回包可带可选 `diag`（回包形状约束 #21 的唯一例外；无失败任务时形状逐字不变）。
- **凭证与决议的时序（#156 第四轮 B2/M2/M3）**：凭证槽改模块级、跨读取器存活（同一轮检查里被多个读取器取用不再互相灭灯）；`ok-now` 结论也发凭证，不再出现「确认时才发现没据可依」；确认装合规版时重跑决议，结论已变则如实回 `check-expired`，不偷换点名版本。
- **诊断原因行不再被前缀污染（#154 续）**：`operation-error:` 之类前缀不再混进「原因行前置」的判定与输出（#154-5/6）。

门禁（**发版定格**）：`npm test` **1397 例：1396 过 / 0 失败 / 1 跳过**（265 套；本批新增 5 个测试文件、净增 104 例：批量面兜底与收尾事实、失败归因走机读 diag、凭证槽跨读取器存活、安装按钮双出口、pnpm 原文提取，均先红后绿；1 例跳过仍是 `DSH_UPDATE_CONSUMER_REPO` 缺席那条）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、349 个 key、16 错误码、19 diag 键，违规 0；新增 9 文案键已进字典+快照）；`npm publish --dry-run` **95 文件**（339.9 kB 压缩 / 1.2 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（349 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.6] - 2026-10-17

### Added
- **合规版降级（#156 场景一/二/四）**：年龄门拦住更新目标时，给“满门限的最新版”选择。新纯模块 `src/compliant-version.ts`（五值裁决 ok-now/wait-until/downgrade-available/no-compliant/abstain；时间只读 registry 完整包文档 time 表并认 5 分钟 CDN 延迟；窗口带出处，文案分“精确/约”；候选三锁；算不出即认怂）。新增 `updateCheckFallback` / `updateInstallCandidate` 两条电话（冻结名单同步；老宿主缺电话时自动退化“只呈现”，面板不碎）。失败页双按钮［装合规版］［等新版］＋决议确认流（确认按钮点名版本，永不静默装老版）。检查页记住窗口后换预判横幅（不再说“可安装”、主安装按钮置灰、给［装合规版］走同一决议流；记住过期/对不上版/时钟坏一律退回老样子；解封后点装合规版走 ok-now 直接装最新）。拦的是树里别家包时无按钮，但真凶/解封/证据三件套齐。

门禁（**发版定格**）：`npm test` **1293 例：1292 过 / 0 失败 / 1 跳过**（新增 46 例、四个新测试文件，均先红后绿；含对抗审查补洞：checkFallback 归因缺失/胡写改认怂 abstain 且零联网、跨挂载锁存补记）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（新增 8 文案键进字典+快照，340 key；diag 19 键、16 码×2 形态）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（字典 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.5] - 2026-10-16

### Added
- **安装失败翻译官（#155）**：已知签名识别 + 诚实归因 + 中文怎么办。新纯函数模块 `src/install-cause.ts`（签名表 + 三值归因 + 解封反推，零 I/O、时间为入参、无中文文案）：首期只认 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`（认方括号机器码 + 命名捕获抠包规格/发布时间/门限，抠不出即作废走通用老路）；归因三值（主包自己 / 非主包只摘嫌疑不断关系 / 未知），措辞只排除、不定罪；解封时刻优先取报文自述窗口（`publishedAt + N minutes`），无窗口才门限反推（`publishedAt + (now - cutoff)`），永不硬编码策略时长；原文照样保留可上诉；另有“未识别签名统计”口指导下一种签名先做哪个。`diag` 只增可选三键（`causeKind/causePackage/causeUnlockAt`，19 键，顶层码保持 `install-failed`，老面板逐字不变）；面板复制诊断的“怎么办”按结论换专项句（banner 与 04 章通用句不动，另票做）。

### Fixed
- **解封时间以报文自述窗口为准（#155 对抗审查）**：门限反推假设 `cutoff = 评估时刻 − 策略窗`，现场验算偏晚约 55 分钟（给 14:53，真值 13:58）。现优先 `publishedAt + 报文里的 N minutes`（安装器自己说的，最准；0 分钟/超十年当没说），无窗口才回退门限反推；算出来已过即省略，不叫人等过去的时间。

门禁（**发版定格**）：`npm test` **1247 例：1246 过 / 0 失败 / 1 跳过**（新增 `tests/install-cause.test.mjs` 31 例：签名正/对抗/降级、真值表三归因×时间可算/不可算、窗口优先恒等式、无窗口回退、离谱窗口回退、窗口已过省略、F2 无目标不谎称他包、F8 查侧不问，均先红后绿；含对抗审查补洞：token 位置无关、坏时间省略）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（新增 4 文案键进字典+快照，diag 19 键、16 码×2 形态）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（字典 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.4] - 2026-10-16

### Fixed
- **安装失败摘要原因行前置（#154）**：`install-failed` 的工具输出头重脚轻（进度头 + 中部真因 + 尾部噪音）而预算截断只保头，真因（如 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` + 包名）常掉在省略号后面。现把命中失败标记的行（✗/`ERR_`/`failed`/`error`/失败/错误等，含其缩进续行）按原相对顺序提到最前面，再走既有预算截断。纯重排、不增删一字，预算墙/白名单/脱敏不动；其它错误码一字不动。
- **未知源文案说人话（#154）**：无 `registryHost` 的诊断复制行由 `源=未知（非官方源时省略本身即信息）` 改为 `源=未声明`（en `Source=Undeclared`）。不编造来源（market 通道与默认源都不断言）。

门禁（**发版定格**）：`npm test` **1216 例：1215 过 / 0 失败 / 1 跳过**（新增 `tests/issue-154-install-diag.test.mjs` 4 例：长输出真因前置、非 install-failed 不动、无原因行不动、源=未声明，均先红后绿；`tests/panel-diag-22.test.mjs` #22 期望同步）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（本次无新增文案键，仅改一键中英文值 + 快照同步）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（字典 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.3] - 2026-10-16

### Added
- **开发态挂载独立码（#153）**：新增 `dev-source` 阻塞码（取值可增，向后兼容）。junction / 源码链接 / 显式外部目录（包定位到但反推不出使用范围）不再报 `unknown-profile`；包真找不到仍报 `unknown-profile`，行为一字不动。面板给 junction 口径文案（开发态挂载，更新中心不可用；改完仓库代码后重启宿主生效），且与源码安装同口径不提供手工命令。`codes / host / reader / panel / bilingual / diag / commands` 七处联动 + README §5.2（九种→十种）+ 码表测试与双语快照同步。

### Fixed
- **无快照失败页补回复制诊断（#153）**：`copy-diag` 门从 `if (snapshot)` 放宽为“有快照或失败横幅或失败引用即画”。首帧即失败（`unknown-profile` / `dev-source` 类不写快照的失败）时按钮不再缺席，与 04 章“请使用「复制诊断」整段粘贴”指引一致；首帧 loading（无快照、无失败）仍不画，不多按钮。

门禁（**发版定格**）：`npm test` **1212 例：1211 过 / 0 失败 / 1 跳过**（新增 `tests/issue-153-dev-source.test.mjs` 7 例：显式外部目录→`dev-source`、真找不到→`unknown-profile`、指错目录不谎称开发态、文案/手工命令/稳定码、无快照失败有按钮、loading 无按钮、真 junction 读者层，均先红后绿；含对抗审查补洞：host 判别式锚 `loaded`）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（新增 3 文案键进字典+快照，阻塞 10 + 电话 5 + internal = 16 码）；`npm publish --dry-run` 见演练记录；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（字典 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.2] - 2026-10-16

### Fixed
- **检查的后置条件（#152）**：`batchCheck`（含面板自动查）以前只写知识账本、不碰会话，会话进入终态后昨日的失败与陈旧目标永生——面板把昨天的 `targetVersion`（如远端曾是 `0.3.55`）配上今天的运行版（如 `0.3.60`）画成「有新版本」，降级当更新卖。现在成功查出的结论按与驱动预查同一口径收敛进会话（有新版 → `ready` + 目标置新；已是最新 → 清掉陈旧目标；检查失败 / 待重启 / 飞行中的行不动；驱动半路起跑跳过落盘；回包永远落盘后重读，端出去的和盘上是同一份）。渲染层再加一道数字守卫：目标版不比当前版新，永不画「→ 新版本」。

门禁（**发版定格**）：`npm test` **1205 例：1204 过 / 0 失败 / 1 跳过**（新增 `tests/issue-152-check-reconcile.test.mjs` 8 例：新鲜检查冲掉陈旧会话、倒挂目标永不画箭头，均先红后绿；含对抗审查补洞：飞行中行跳过、无条件 current 收敛、落盘后重读）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（本次未新增文案键）；`npm publish --dry-run` **81 文件**（302.2 kB 压缩 / 1.1 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（字典 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.1] - 2026-10-16

### Fixed
- **过期凭证自动续一次（#150）**：面板与安装按钮的安装动作被拒为 `check-expired` 时自动重查并用新凭证重装一次，仍败才展示失败；“重试安装”不再复用旧编号空转。查回 `ok:true` 却无收据时按快照真实故事展示（阻拦横幅 / 空闲态），不再本地伪造 `check-expired` 掩盖真正原因。
- **`host.call.fail` 日志行加 `error` 稳定码一格**：此前只有 `errorHash`（djb2），现场排错需手算反查；现与回包同一稳定码（闭合词汇，无自由文本），旧读数忽略未知格（#150 破冰，见该票进度区）。

## [0.18.0] - 2026-10-15

### Added
- **安装按钮控件**（新子路径 `dsh-plugin-update/install-button`）：`mountInstallButton(container, { pluginId, call, prefix })` 在任意卡片里原地装好一家插件。判定、文案、诊断、日志与面板同一口径（复用 `panelViewModel` 与既有文案键，只新增 `install-button.action.installed`「已安装」一键）；单按钮双角色（可装即装，否则退回检查）；点下先查后装、连点只认第一次；装中轮询有界（300 轮封顶）；失败给重试 + 复制诊断 + 手工命令 disclosure；待重启无安装动作；卸载只停轮询。唯一既有改动是 `messageCodeOf` 加 `export`（行为零变化）。详见 README 第 2.8 节。

## [0.17.1] - 2026-10-15

**失败态滚动归位**：更新失败后拖面板滚动条不再一松手就回顶部。两处病因同修：同语义失败的重复轮询不再重建锁存（“失败于”时刻冻结在首次失败，不再每秒漂移触发整树重绘）；重绘的滚动保持从内层滚动区扩大到外层面板根。语义真变（新失败、版本三元组变化、成功终态）仍即时重绘；成功态 / 忙态 / 诊断文案一字不动。

### Fixed
- **失败态每秒整树重绘（#143）**：只读轮询拿到同语义 `failed` / `interrupted` 快照时跳过重建（除 `atMs` 外逐字一致即同一失败），“失败于 HH:MM:SS”不再随轮询漂移。
- **外层面板根滚动保持（#143）**：重绘时在内层滚动区之外同时保存 / 恢复 dialog 外层面板根的滚动位置；焦点恢复语义不变，无 DOM 查询能力的容器与 embedded 走原分支。

门禁（**发版定格**）：`npm test` **1167 例：1166 过 / 0 失败 / 1 跳过**（新增 `tests/issue-143-failed-poll-stable.test.mjs` 与 `tests/issue-143-outer-scroll.test.mjs`，均先红后绿）；`node build.mjs`（含 `tsc --noEmit`）与 `npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（字典 322 个 key 0 违规，本次未新增文案键）；`npm publish --dry-run` **79 文件**（292.5 kB 压缩 / 1.0 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（322 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.17.0] - 2026-10-15

**未装也能装**：从没装过的插件不再被说成「装坏了」。读取器新增一等事实 `installed: boolean`（缺席的判据只有目标包那次读取的 `code === 'ENOENT'`；坏 JSON / 权限错误仍是 `invalid-installation`，洗不成未装）；缺席时判定提前返回、不算只对在场包有意义的指纹；查到远端发行版即可安装（动作词「安装」，不再与注入的运行版号比大小）；两个面板把该行说成「未安装 → 目标版本」，失败文案查装分家（查侧说「本次未能查询」，装侧才说「安装失败」）。消费方一行不改。

### Added
- **在场事实 `installed: boolean`**：`EnvironmentView` 与服务快照各加一字段（快照六字段 → 七字段）。缺席时 `installedVersion` 为 `null`、`blockedReason` 为 `null`、`eligible` 为真，不新增稳定码。
- **双语状态词「未安装 / Not installed」**（批量行 + 单插件横幅两处新键，进字典与快照）。
- **查侧失败判定 `isCheckSideFailureCode`**（`src/codes.ts` 派生，`check-failed` / `invalid-release` / `check-expired` 三码；面板失败行按它分家）。

### Changed
- **缺席可安装**：`canInstall` 按在场分叉——缺席分支只看「远端有合法版本 + 指纹一致（双方皆空的相等写死）」，不再看 `newer`；通道判定内联在场分支、Node 不兼容只记不拦（装到才失败）。
- **账本与行内快照同步在场事实**：`installed` / `installedVersion`（只取磁盘版，不回退注入的运行版号）进账本条目与批量行内快照；未装行不再落 `failed` 相位与 `error`。
- **版本号 `0.16.4` → `0.17.0`**（向后兼容的加法：只增字段与文案键，既有码含义一字不改）。

门禁（**发版定格**）：`npm test` **1165 例：1164 过 / 0 失败 / 1 跳过**（新增 `tests/issue-134-not-installed.test.mjs` 7 例钉读取与判定、`tests/issue-134-panel-not-installed.test.mjs` 16 例钉两面板渲染与批量真装；注：`tests/batch-host.test.mjs`「真路径两家批」在全量并行负载下偶发一红（500ms 定序的时序用例），单跑与重跑皆绿，与本次改动无关——该用例的 `readInstalled` 是假件，不走真读取器）；`node build.mjs`（含 `tsc --noEmit`）与 `npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（文案源 grep 扫描 36 个源文件 0 违规 / 字典快照 322 个 key 0 违规 / 15 码与诊断解析契约）；`npm publish --dry-run` **79 文件**（1.0 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（322 个 key 仍全是 `draft: true`，含本次新增 2 键，理由见 `0.16.0` 节末）。

## [0.16.4] - 2026-10-15

**宿主侧链 + 集成 `dsh-log` 0.3.4**：本包**自建落点**的行从此带上 `traceId`/`spanId`/`seq`（一次电话一条链），运行期依赖下限从 `^0.3.1` 抬到 `^0.3.4`，启动头补上「这个目录是哪一版写的」。行为面只增不改：没有链的场合（集成方注入的客户端实例、降级落点、面板 `logAppend`）一字不变。

**发布口径**：`0.16.3` 未单独发到 npm，其内容随本版首发（与 `0.14.0`/`0.15.0` 同例）。

### Added
- **宿主侧链上下文**（`src/log/trace.ts`，采纳 `dsh-log` 0.3.3 起的 `store.trace()`）：宿主侧的多步链（查 → 判 → 装 → 验）从此**一次电话一条链**——同一通电话里的多行共享一个 `traceId`，`seq` 从 0 递增；`withLogTraceStep` 换 `spanId`、`seq` 重新从 0 起，用来分步骤边界。三条纪律：**认源**（链只对建它的那个落点生效，A 插件的链绝不写进 B 插件的目录）、**没有链时一字不变**（集成方注入客户端实例、降级落点、面板侧的 `logAppend` 行照旧）、**永不外抛**（取链失败按「没有链」处理）。用 `AsyncLocalStorage` 而不是模块级变量：一个进程里可能同时跑着轮询与安装两条链、还可能有多个插件，模块级变量会让它们互相串味。
- **`ownPackageVersion()` 与 `packageRoot()`**（新模块 `src/log/own-version.ts`，从 `dsh-plugin-update/log` 导出）：读随包 `package.json` 的版本号，同步、进程内缓存、读不到回 `null` 绝不抛。启动头那一格用它。

### Changed
- **运行期依赖下限 `dsh-log` `^0.3.1` → `^0.3.4`**。链能力要 0.3.3 起才有（`store.trace()`）；0.3.1/0.3.2 上本包是**形状探测**（`src/log/sink.ts`：没有 `trace` 键就退回 `fire`），也就是**装上了也不会有链、还不报错**。抬到 `^0.3.4` 之后「装了就有链」才是保证，同时吃到 0.3.4 的引擎侧修复：启动头幂等（同一个实例只写一行 `host.start`）、启动头记 `os`、目录摘要不再把读不出来的文件当空文件、保留字影子计数只数真冲突。
- **启动头 `host.start` 写 `pluginVersion`**：登记表在建库配置里默认填本包版本（调用方可以用 `acquireOwnLog({ pluginVersion })` 覆盖成自己那一版）。**必须建库那一刻给**——0.3.4 起启动头幂等，晚一步传等于永远写不进去。
- **README 的追链口径翻转**（§10、§11）：原文写「`--trace <traceId>` 在本包自建落点的行上追不到链」，现在**追得到**（同一通电话的行共用一条链）。`--trace` 用法照旧，只是对本包的行也有效了；文档同时注明三件套由引擎注入、不在事件清单的字段白名单里，读侧要用 `stripReservedLogFields` 先摘掉。

### Fixed
- **启动头此前没有版本号那一格**：`OwnLogAcquireInput.pluginVersion` 声明了、注释也写了「不给就用本包自己的版本」，但建库调用从没把它传下去（`src/log/registry.ts`），`ownPackageVersion()` 也压根不存在——交日志时对方问「这堆行出自哪一版」只能靠猜。现在建库配置真的带上它，并有真引擎端到端用例钉住（启动头恰好一行、`pluginVersion` 等于本包版本、带 `os`）。

## [0.16.3] - 2026-10-15

**契约回填**：把随包事件清单从「意图稿」改成「实现真给的东西」，并清掉一条会误导使用者的命令。**事件名与字段名有删减（28 → 26）**，其余形状不动、行为不变、不加依赖（`dsh-log ^0.3.1` 仍是唯一运行期依赖）。

### Removed
- **`update.install.retry`（事件）**：从 `event-list.update.json` 删除。本包**没有自动重试** —— 面板上的重试按钮就是再发一次安装，落 `update.panel.action{action:'install'}`。原条目声明的 `attempt`/`of`（「第 N 次重试」）在本包里没有任何生产者，`src/` 全仓零发射点、`tests/` 零引用。
- **`update.restart.outcome`（事件）**：从 `event-list.update.json` 删除。**宿主没有重启自己的电话**（代码原话），本包只做入口（`update.panel.action{action:'restart-hint'}`），观测不到重启结局；原条目声明的 `outcome` 三值同样零生产者。
- **`update.registry.fetch.cacheHit`（字段名）**：从清单删除。缓存命中发生在取数之前（命中就根本不取数），到了取数点必未命中 —— 恒为 `false` 的格子只是噪声。该字段名**从未在任何落盘行里出现过**，删掉不影响已解析的行。

### Changed
- **事件清单计数**：**26 个事件**（常驻 18、按需 7、自监控 1）。README §10 与 `docs/maintainers.md` 同步。
- **事件目录契约回填**（`docs/research/20261014-log-event-catalog.md`，新增 §7）：除上面三条外，改正四处「本文件写错、随包清单本来就对」的地方 —— `update.panel.action.action` 是 **11 值**（`'copy-diag'` 不是 `'copy-diagnostics'`）；`update.changelog.parse.source` **恒 `'npm'`**；`update.check.fail.stage` 四个值合法但**可达三值**（`compare` 无生产者）；`update.lang.applied.source` 是**四值**（补 `'default'`）；`update.store.fail` 落点 **16 处**。§0 的「常驻必须边沿触发（铁律）」改述为「**不是机器规则**：全仓只有 `update.status.changed` 与 `update.queue.transition` 两条受指纹去重保护」。
- **面板日志路牌与 README 去掉 `tail`**：`dsh-log` 0.3.1 的 `USAGE` 写 `dsh-log tail <目录>`，但 `dist/cli.js` 没有子命令解析 —— `tail` 被当成一个不存在的路径，先往 stderr 吐一句「没找到日志目录：tail」（日志照常输出、退出码仍是 0）。本包所有面向使用者的命令改成 `npx dsh-log <目录>`，并在 README §11 写明为什么不要写 `tail`。

### Added
- **事件目录 §7「契约回填」**：逐条列出「本文件曾许过、实现没给」的四处（含上面三条 + 挂载点 `mode` 的可达四值），并把三条**记录但不修**的边界备案：① 丢弃计数不接（dsh-log 的 `getDroppedCount()`/`setOnDrop()` 本包没有接）；② trace 只有一半（`buildRowText` 与 `store.log` 都没有 trace 槽位，`traceId`/`spanId` 只由 dsh-log 客户端 SDK 的写入路径注入）；③ 上游 `USAGE` 与解析器不一致。另记三条**明确不做**：跨进程租约（实测两进程各 1200 行 × ~3 KB 共 2400 条一条不少）、清单合并上游化、开关热更新（引擎的开关是实例级闩锁，改 JSON 是重启级旋钮）。

门禁（**发版定格**）：`npm test` **1126 例：1125 过 / 0 失败 / 1 跳过**（`tests/gate.test.mjs` 新增三条契约回填负向断言：两个事件名与一个字段名不许再回到清单里）；`npm run build`（`node build.mjs`，产出 `dist/` 与 `.d.ts`）与 `npm run typecheck`（`tsc -p tsconfig.json`）过；`npm run gate:bilingual` **三道硬门禁过**；噪声预算装置 `node .tmp/log-verify/run.mjs budget` **8/8 过**（被测 `dist` 66 文件 / sha256 `b81e1a539f82e3d2…`，跑动期间 `dist` 未被改写）；`npm publish --dry-run` **73 文件**（281.3 kB 压缩 / 991.9 kB 解包）。`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（320 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.16.2] - 2026-10-15

对外「介绍面」统一补丁：npm 页、GitHub 仓库页、用户手册三处对同一件事的说法对齐，并清掉仓库树里混进来的会话垃圾。**不改行为、不改形状、不改落盘契约、不加依赖**（`dsh-log ^0.3.1` 仍是唯一运行期依赖）。

### Changed
- **`package.json` 元数据**：`description` 从「可复用的更新系统装成的 npm 包：…（地图 #579）」换成面向使用者的口径——旧句把内部地图号写上了 npm 页，而 npm 页的「About」与搜索结果都直接取这句。新增 `keywords`（`dsh` / `dsh-plugin` / `self-update` / `updater` / `plugin-update` / `changelog` / `typescript` / `dsh-log`）与 `homepage`（本仓 README）、`bugs`（本仓 Issues），npm 页从此有标签与可点的来源、问题入口。
- **README 的版本归属按「装得到的版本」说话**（`:13`、`:536`、`:604`、`:633`、`:635`、`:680`）：`0.14.0` / `0.15.0` 从未上过 npm，原先那几处「`0.15.0` 起有 dsh-log」「`0.15.0` 之前的旧名」会把集成方指到一个装不到的版本号（`0.16.1` 只改对了依赖与版本号两处，归属仍留在 `0.15.0`）。改齐为 `0.16.0` 起；旧名那处补明是「`0.13.0` 及更早已发布版本」的名字。**只动版本归属，能力描述一字未改。**

### Added
- `scripts/release-notes.mjs`：按版本号从 `CHANGELOG.md` 里取该节正文打印（`--title` 只打标题、`--check` 只校验该版本节在不在），GitHub Release 的说明直接用它生成——Release 与 CHANGELOG 同一份来源，不再手抄一遍。

### Fixed
- **仓库树里混进来的会话垃圾**：`.local/`（内票正文草稿、`state/gh/device-id`）、`.merge-backup/`（pre-merge 副本与验证页）、`.dsh-vision-router/`（整屏截图 12 张）、`.scratch/`（交接稿）、根上的 `.tmp-issue70-body.md` 与 `.tmp-probe-{before,after}.json`——共 **27 个文件约 1.9 MB**，全都只是本地会话产物，却跟着公开仓库一起 clone。从版本库移除（`git rm --cached`，本地文件原样保留，**未改写历史**），并把 `.local/`、`.merge-backup/`、`.tmp-*`、`.dsh-im/` 补进 `.gitignore`；`.dsh-vision-router/` 与 `.scratch/` 本就在忽略表里，只是先于规则入了库。

门禁（**发版定格**）：`npm test` **1126 例：1125 过 / 0 失败 / 1 跳过**（比 `0.16.0` 那行多 1 例：复核阶段补的挂载级路牌测试）；`npm run build`（含 `tsc --noEmit`）与 `npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（文案源 grep 扫描 33 个源文件 0 违规 / 字典快照 320 个 key 0 违规 / 15 码与诊断解析契约）；`npm publish --dry-run` **73 文件**（279.7 kB 压缩 / 987.5 kB 解包——`scripts/` 不在 `files` 白名单，新增的发布说明脚本不进包）。本版不碰发射侧与面板渲染，噪声预算装置没有重跑；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（320 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.16.1] - 2026-10-15

纯文档补丁：不改行为、不改形状、不改落盘契约、不加依赖。起因是对抗式复核（`docs/research/20261014-log-integration-review.md`）查出用户手册与实现不一致，而 `0.16.0` 的 tarball 已经带着这些错行上了 npm——所以补一版，让 npm 页跟着对（票 `#132`）。

### Fixed
- **README 第一屏**（`:13`）：原文「要求 Node 22 或更高，零运行时依赖。当前版本 `0.10.0`」两处都错——`0.15.0` 起 `dependencies` 里就有 `dsh-log ^0.3.1`（ADR-0005 明确破掉「零运行期依赖」，本包从此不是零依赖包），版本也早不是 `0.10.0`。改成「要求 Node 22 或更高。运行期依赖只有一个：`dsh-log ^0.3.1`（0.15.0 起，见第 10 节）。当前版本见上方徽章与 `package.json`」——**不再写死版本号**，免得下次发版又漂。
- **电话个数**（`:17`、`:570`）：`0.16.0` 已按 `#122` 追加第五个电话名 `logAppend`，第一屏与第 7 节自检清单仍写「四个电话」；改齐为五个（`:63`、`:80`、`:674` 本来就是五个）。
- **命名空间口径**（`:686`，同处 `:640`、`CONTEXT.md:26`、本文件 0.15.0 条目、`src/log/namespace.ts` 的不变量注释）：原文「去首尾 → 截 32 位」与「不同 `pluginId` 永不共目录」都不准。实现是：合法标识（1–32 位）原样通过；有损分支 slug 截 24 位再补 `-<sha256 原文前 6 位>`（合计 ≤31）。所以只有**无损分支**保证不共目录，有损分支是 24 位指纹的**概率性**隔离。
- **追链口径**（`:562`、`:703`，同处事件目录 §4 规则 2）：不再把 `npx dsh-log tail … --trace <traceId>` 当既有能力。`traceId`/`spanId` 只由 dsh-log **客户端 SDK** 的写入路径注入；本包自建落点走宿主 `store.log`，行里没有这三个字段（实测落盘行只有调用方给的 `fields`）。

## [0.16.0] - 2026-10-14

### Changed
- **破坏性（形状）**：`ChangelogEntry` 新增 `otherSections: Array<{ title: string; items: string[]; count: number }>`——**非六类小节名的整节内容不再被丢弃**，按作者原标题原样收进来（此前 `### Patch Changes` / `### 🚀 Enhancement` / 无小节名的裸条目全部静默消失）。只读 `sections` 的集成方零改动；想显示作者自定义小节的集成方读 `otherSections`（`renderChangelogHTML` 已经画）。
- **破坏性（诊断码）**：`E_CATEGORY` 下线——非六类小节名不再丢内容，改报 `W_CATEGORY_OTHER`（提示，不拦）；新增 `E_BULLET_ORPHAN`（版本节之外的条目，其内容确实进不了任何版本节，仍是 Error）。`E_VERSION_TITLE` 语义收窄为「像版本标题却取不出号」（`## 1`、`## 2026-10-14`）；`## 1.0` 这种两段版本号 0.16.0 起是合法版本节，内容照收。
- 版本标题识别放宽到 1–4 级任意标题 + setext（`===`/`---` 下划线）＋ 标题任意位置的版本号：`# v0.14.0 (Mon Jun 29 2020)`、`#### 🚀 Enhancement` 这类真实日志（jimp 形态）不再整节丢字。闸门仍是「看起来是版本节」：`# Changelog`、`## License`、`### 修复 1.2 的 bug` 不会被误当版本节（两段号必须标题里除它只剩装饰）。
- **顶格内容不再丢**：顶格段落、顶格引用（`>`）、顶格围栏代码块都收进条目（此前静默丢弃，围栏里的内容此前整段丢掉）；一律转义，永不直通 HTML。空行是段落边界——顶格块另起一条，缩进行照旧并进当前条目。
- 截断不再静默：文件超 64 KiB 时面板补一行说明，版本被截时再补一行（`changelog.truncated.file` / `changelog.truncated.versions`）——少了条目、为什么少，读者看得见。
- **冻结面追加第五个电话名 `logAppend`（`#122`，破冰结论见 issue）**：只在既有四个名字之后追加，`updateStatus` / `updateCheck` / `updateInstall` / `updateChangelog` 一字不动；`tests/{config,phones,queue,batch-host,gate}.test.mjs` 里「电话名一字不差」的断言同步扩到五个，HTTP 白名单放行 `logAppend`，批量宿主按目标自动带上（每个目标各自的 `<前缀>.logAppend`）。
- 随包事件清单的读取由**异步**改**同步**（`readFileSync`，进程内缓存一次）：字段白名单的判据必须当场就有——异步读会让同一行「先放行、后拒收」，行为随微任务时序漂移（`#122` 抓到的真实差异）。读不到清单时照旧放行 + 记一条 `update.log.degraded`。
- **轮询噪声在发射侧治掉（`#124`）**：`updateStatus` 的成功行**一条都不发**——判据是「上次算得出指纹、这次算得出、且与上次不同」才留一行；第一次轮询没有可比的上次，所以也不留（这就是「N ≥ 100 次连续轮询零常驻行」的字面口径，实测 600 次 → **0 行**）。`host.call` 的名字与五键形状**一字不动**，失败行 `host.call.fail` 不受影响；状态真变时另发一条 `update.status.changed` 供追溯。依据：`host.call` 在 dsh-log 内置常驻名单里（43 名之一），集成方清单改不动它，只能在发射侧治（治理前现场 600 次轮询即 600 行，外推 ≈86400 行/天）。
- **两个「只进日志」的可选入参（`#124` 破冰结论）**：检查电话多认 `trigger`、安装电话多认 `from`（缺省 `'panel'`，批量宿主传 `'batch'`）——不参与任何决策、不改回参形状、老调用一字不动。冻结面的这两处改动已同步 `docs/maintainers.md` 与 README 第 10 节。
- 口径按实现收紧：`update.registry.fetch` 的 `cacheHit` **不发**（本包缓存命中发生在取数之前，到了取数点必为未命中，恒 `false` 的格子只是噪声）；`update.store.fail` 的 `op` 收成 11 个稳定码、`reason` 用 errno 稳定码；`update.check.done` 的 `stage` 四值（`fetch`/`compare`/`channel`/`verify`）钉在实现上。

### Added
- `parseChangelogReport(markdown)`（新导出）返回 `{ entries, truncation }`，把「被截断」作为数据交出来（`truncation` 含 `chars`/`tailVersions`/`entries`/`sections`/`sectionItems`/`items`）；`parseChangelog` 仍是 `.entries` 的薄封装，老集成方零改动。
- 未知小节按作者原标题显示（`otherSections` + `.dsh-upd-changelog-cat[data-cat="other"]`）——六类之外的节不必再「要么改名、要么消失」。
- 双主题为块级与自定义小节补样式（默认主题直接生效，档案卷 `[data-theme="archive"]` 只换肤）。
- 分隔线 `---`／`***` 渲染成 `<hr class="dsh-upd-md-hr">`（不再以字面三个短横混在正文里）；setext 下划线标题（`标题` + `===`／`---`）先转 ATX 再走同一套判据，转换**保持行号不变**（`validateChangelog` 的诊断仍指向原文件行号）。
- 保真口径写成了可执行断言：`tests/changelog-fidelity-116.test.mjs`（22 例）——① 无未声明丢失：源文件里每条内容行的签名都要出现在渲染结果里，允许缺失的只有已声明的截断与 `E_BULLET_ORPHAN`；② 幻影版本 = 0：渲染出的每个版本节都能在源文件里找到版本号 token；③ 负例语料 `# Changelog`／`# 更新日志`／`# <插件名>` 不得成为版本节。认不出的块（HTML 注释、`<details>`、表格行）落进 `<div class="dsh-upd-md-para">` 按原文显示。
- **面板侧的日志通道（`#122`）**：面板跑在浏览器闭包里，落盘在宿主，中间隔着新电话 `….logAppend`。客户端侧 `createClientLogChannel`（`dsh-plugin-update/log` 导出，零 `node:` 依赖）做三件事：有界环形缓冲（缺省 200 行，满了挤掉最老的并计数）、按批投递（缺省 50 行 / 1 秒，页面切后台立即冲刷，失败退避重试 2 次后丢弃并计数）、**永不外抛**（没通道、电话没接上、回包形状不对都只计数）。宿主侧那一头是协议面：只收五个客户端事件（`update.panel.mount` / `update.panel.action` / `update.panel.render.fail` / `update.panel.state` / `update.lang.applied`），级别、字段、条数（一次 200 行）、新鲜度（10 分钟内）逐个把关，回 `{ accepted, dropped }` 且不给日志自己制造 `host.call` 行。
- 面板自动接上这条通道：`mountUpdatePanel` 默认按前缀自建（电话名 `<prefix>.logAppend`），`clientLog: { channel }` 注入自己的、`{ mount }` 改挂载点名字、`null` 明确关掉；入口件与 HTTP 直挂已传好挂载点。面板记五行：挂载、每个用户动作（复制诊断时带字节数与是否截断）、渲染兜底失败、状态变化、语言判定来源；状态与语言按指纹去重，轮询不会把它灌满。
- `event-list.update.json` 增五行客户端事件（`#122`），字段白名单与 `guard` 说明随表发布；`tests/client-log.test.mjs`（17 例）与 `tests/panel-log.test.mjs`（6 例）把缓冲、退避、丢弃计数、协议面收放与面板五行全钉住。
- **宿主侧环节全部接线（`#124`）**：19 环节里 Node／中立那批（③④⑤⑥⑦⑧⑨⑪⑫⑬⑭⑱，②另收一个宿主侧可选入参）逐个落到唯一发射口，逐环节的**权威落点（函数级）**与接线状态写进事件目录新增 §3.1。中立文件（`src/service.ts`、`src/changelog.ts`、`src/queue.ts`、`src/batch-run.ts`）不 import `node:`、也不认识插件标识——发射口一律由宿主侧**绑好标识**后注入（`src/host.ts` 的 `logPortFor()`）；队列与全局锁按**当次动作方**取口，行落动作方自己的目录，不会因为「谁先接线」而串台。
- 逐事件的负向断言：`tests/host-log.test.mjs`、`tests/store-log.test.mjs`、`tests/batch-log.test.mjs`。缝探针在**真** `homeDir`／真锁／真队列上（只假网络与子进程）跑一次完整安装，验到 `update.queue.transition` 三相位齐（`queued{position:1}` → `running{waitedMs:8}` → `done`），`update.install.request`、`update.install.verify`、`update.check.done`、`update.channel.decide`、`update.status.changed` 各就其位。
- **面板错误章路牌给出日志目录与现成命令（`#123`）**：原来那行只说「按插件标识筛选 `host.call` / `host.call.fail` / `update.install.exec`」，用户还得自己去 README 推目录名。现在路牌多给一份目录与命令：宿主/入口把新导出 `updateLogDirFor(pluginId, homeDir)`（`<homeDir>/logs/<派生命名空间>`，与落盘同一算式、同一派生规则）的结果传给面板挂载项的 `logDir`（`mountUpdatePanel` / `mountUpdatePanelHttp` / 入口件同名选项）时写**具体路径** + `npx dsh-log tail <该路径>`；没传则退回 `<DSH_HOME>/logs/<派生命名空间>` 的算式与命令模板——路牌宁可说「目录长这样、命令长这样」，也不指一个不存在的值。`showLogHint: false` 照旧把整条路牌（含新目录行）一起藏掉。**电话回包一字不动**：使用范围那栏仍然只回范围名与宿主种类，绝不回目录路径（日志行里目录也照旧只有 `logDirHash`），所以这处没动冻结面。

### Fixed
- 保真审计（`.tmp/audit-fidelity-v2.mjs`，本机 88 份 CHANGELOG；插件语料 = 8 份 DSH 插件**副本**）：**看不到的内容行从 26.7% 降到 1.5%**（覆盖率 73.3% → 98.5%），一份都显示不出的插件文件 0/8；**幻影版本 0**。残留 10 行 = 8 行文件前言（首个版本标题之前的体例说明）+ 2 条非版本节下的条目（`validateChangelog` 报 `E_BULLET_ORPHAN` 明说，不是静默丢）。
- 档案卷皮肤在整条是代码块/引用块时不再补一个孤零零的「Added ·」（`data-cat-block="1"`）。
- 顶格块与上一条之间隔了空行就另起一条：此前围栏代码块后面的顶格引用会被粘进同一条（空行在 Markdown 里就是段落边界）。
- 客户端日志行不再有「渠道没就绪就静默丢」的第三种状态（`#122`）：丢弃只有两个出口——缓冲挤掉或投递失败，都计入 `dropped()`；宿主回包里的 `dropped` 也照加，第三方看到的数字就是真丢了多少行。

门禁（**发版定格**）：`npm test` **1125 例：1124 过 / 0 失败 / 1 跳过**；`npm run build`（含 `tsc --noEmit`）与 `npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（文案源 grep 扫描 33 个源文件 0 违规 / 字典快照 320 个 key 0 违规 / 15 码与诊断解析契约）；`npm publish --dry-run` **73 文件**（276.6 kB 压缩 / 980.3 kB 解包）。噪声预算装置复跑 **8/8 过**（`node .tmp/log-verify/run.mjs budget`：内核边沿 86400 次 → 1 行；600 次真轮询 → **0 行**，治理前同口径是 600 行；稳态 24h 外推 0 行；安装/批量当天事件面 37 行 ≤ 500）。
（`gate:bilingual:release` 的**第四道「零 draft 放行」仍如实红，非阻断**：320 个 key 全部还是 `draft: true`——转正走的是「母语 + 域内双签」的独立流程（#53 立约、#57 规格），不是发版票能代签的。口径与 0.9.0–0.13.0 各版一致：那几版的门禁行同样记「`--release` 仍如实红，非阻断」。`docs/maintainers.md` 里「现在 7 个 entry key 仍是 draft」是旧数字，已按实测改成 320。）

## [0.15.0] - 2026-10-14

> 未单独发到 npm：这一节的内容随 `0.16.0` 首发。

### Changed
- **破坏性**：条目正文保留行边界（`#116` 返工的一半）——`ChangelogEntry.sections` 的**单个条目现在可能是多行字符串**（嵌套子条目、围栏代码块、引用块按行留在一起），旧版是「一切压成一行」。集成方若对条目做过 `\n` 假设或按整串做字符串比较，需要跟着改；只做展示的集成方（`renderChangelogHTML`）零改动。迁移说明见 README §5.8。
- **计数口径变化**：嵌套子条目不再各占一条，`sections` 数组长度与 `counts` 只按**父条目**算（同输入下 `Added: 6` 会变成 `Added: 3`）。理由：块级渲染要靠父子关系，子项各占一条时层次不可恢复。
- 缩进（≥2 空格或 1 个 tab）的围栏代码块与引用块现在归属所在条目：`` ```lang `` → `<pre class="dsh-upd-md-pre"><code>`，`>` → `<blockquote class="dsh-upd-md-quote">`；**顶格**围栏与顶格引用照旧不进条目（保持既有「顶格内容不当条目正文」的对抗口径）。
- 单条截断（500 字）改为**按行累加**：装不下的那一行不再硬塞碎屑，只给已收正文补 `…`，截断点之后的行整行丢弃。
- **事件清单与检查器迁到 `dsh-log` 0.3.1 形状**（`#120`）：清单不再要求自报计数（旧清单带着 `counts` 照收，只是不参与判断），条数由 `computeEventCounts` 现算；字段检查分两档（未知字段黄、未知事件红）；落盘行加 `v === 3` 断言。集成方已有的清单不用改。
- **运行期依赖从零变成一个**（`#121`，`ADR-0005`）：`dependencies` 加 `dsh-log@^0.3.1`。集成方零改动（传了 `logCtx` 照旧优先，本包绝不另建实例）；没传 `logCtx` 的插件从此有日志可交，拿不到 dsh-log 时降级成「没有落点」，主流程零影响。门禁的「零依赖」断言随之改成「唯一依赖是 dsh-log，且只有 `src/log/**` 能动态取它」，并改成递归扫 `src/` 全树。

### Added
- 块级渲染 `renderChangelogBlocks(lines)`（导出，纯函数、永不抛错）：条目第二行起按行分派成嵌套 `<ul>`／`<ol class="dsh-upd-md-list-ol">`、`<pre><code>`、`<blockquote>`、`<div class="dsh-upd-md-para">`；认不出的行当正文显示，不丢字。
- 双主题块级样式：默认主题加 `.dsh-upd-md-pre/.dsh-upd-md-precode/.dsh-upd-md-quote/.dsh-upd-md-list(+ -ol)/.dsh-upd-md-para`，档案卷同名规则加 `[data-theme="archive"]` 作用域只换肤（纸色代码底、左侧细线引用、朱红列表符号）；默认串仍不含 `data-theme` 字样（既有断言不变）。
- 子条目位置上的有序列表 `1. …` → `<ol>`（顶格编号行仍按段落忽略，免得正文里的编号行变成条目）。
- 随包事件清单 `event-list.update.json`（`#120`）：本包事件的全表，含字段白名单、级别、散列代号与守卫说明，是事件与字段的唯一事实源。**首发时是 28 个事件（常驻 20、按需 7、自监控 1）；`0.16.3` 契约回填后是 26 个（常驻 18、按需 7、自监控 1）**——删掉的两条见 `0.16.3` 节。
- `mergeUpdateEvents(myManifest, updateEvents)`（`#120`）：把本包事件表并进集成方的清单——本包有、对方没有的补进去，两边都有的字段取并集、级别与归类仍按对方声明，不一致的记进 `conflicts`。
- `lintEventList(manifest)`（`#120`）：整份清单过尺子，红＝结构或引用错（事件名不合契约、`codes`/`rules` 引用名不合法、自报计数对不上），黄＝可疑不拦（字段表为空、字段里出现自由文本键——`ADR-0006` 管这条）。
- `parseLogRow(row)` 与 `LOG_ROW_VERSION`（`#120`）：落盘行断言，五键 `v`/`ts`/`level`/`event`/`fields`，`v` 必须是 3，多键少键都报中文错。
- 日志内核 `dsh-plugin-update/log`（`#121`）：派生命名空间 `deriveLogNamespace`（合法标识原样通过；有损映射补 `-<sha256 原文前 6 位>`，空标识回退 `plugin-<hash6>`；无损分支下不同标识不共目录，有损分支为 24 位指纹的概率性隔离——原文写「不同标识永不共目录」，复核更正）、同进程登记表 `acquireOwnLog` / `releaseOwnLog`（`globalThis` 上按目录引用计数，同一目录只有一个 dsh-log 实例；撞租约退避重试后降级、绝不外抛、降级带冷却）、按插件标识的 O(1) 路由表 `createLogRouter`（取不到落点即丢弃计数，绝不回退到别人的 sink）、唯一发射口 `emitUpdateLog`（脱敏 + 字段白名单 + 准入短路 + 边沿预算守卫；落点抛错只计数不外抛）。宿主侧原来那个模块级共享落点（最后接线的插件收走所有行）就此消失，同进程多插件不再串台。
- 事件表的运行时读取 `loadUpdateEventTable` / `buildUpdateManifest(pluginId, 集成方清单)`（`#121`）：读随包 `event-list.update.json` 并换标识；集成方给了自己的清单就并进去（冲突如实回报）。读不到清单只少一层字段守卫，绝不静默不写日志。
- `tests/log-kernel.test.mjs`（`#121`）：26 例——派生映射表与两条不变量、路由 A/B 隔离、登记表引用计数与降级三态、发射口四条纪律，外加一条真引擎端到端（真装 dsh-log 0.3.1 → 真落一份文件 → 读回五键行）。

### Fixed
- 真实管线里缩进围栏内容此前**整段被丢弃**（`inFence` 直接 `continue`），现在收进所属条目的 `<pre><code>`；缩进引用块此前被并成上一行正文（`> ` 变普通字符），现在是 `<blockquote>`。
- 续行不再被 `replace(/\s+/g,' ')` 拍平（那是块级渲染分不出层次的主因）。
- 档案卷皮肤的类名前缀不再钻进新加的嵌套子列表：选择器从 `… ul li::before` 收紧为 `… > ul > li:not([data-cat-lead])::before`，子项不会再多出「Added ·」、有序子项不再显示成「1. Added · 先跑门禁」。
- 条目正文已经以类名开头时不再补前缀（`**Added** · …` / `Added: …` / `新增 · …` 会被 `renderChangelogItem` 标上 `data-cat-lead="1"`，档案卷皮肤据此跳过），消除面板上的「Added · Added · …」重复；`Addendum`／`新增功能` 这类不算类名开头，前缀照旧。

### Deprecated
- 门禁检查器的两个旧名 `checkEventFields`、`checkEventCounts`（`#120`）：保留一版、行为不变（`checkEventCounts` 在清单没写 `counts` 时直接算过），新代码用日志包 0.3.1 的名字 `lintEventFields` 与 `computeEventCounts`；下个大版本删旧名。

门禁：`npm test` 1016 例（1015 过 / 0 失败 / 1 跳过既有）；`npm run build`（含 `tsc --noEmit`）与 `npm run gate:bilingual` 均过。

## [0.14.0] - 2026-10-14

> 未单独发到 npm：这一节的内容随 `0.16.0` 首发。

### Added
- 更新日志行内 Markdown 渲染（#109 地图 / #115 落地）：条目正文不再原样显示语法符号——`` `行内代码` ``、`**粗体**`、`*斜体*`、`~~删除线~~`、`[文本](https://…)`、`<https://…>` 与裸 URL 都渲染成样式；图片 `![alt](url)` 只出占位（`data-src` + alt／地址），**永不产出 `<img>`、不发任何网络请求**。支持面按野外取样定（`docs/research/20261014-changelog-markdown-constructs.md`：行内代码 4914 处/81 份、粗体 4742/26、绝对链接 6286、裸 URL 6671、图片 8；表格/脚注/emoji 短码/`<details>` 野外 0 例，不做）。
- 导出行内渲染纯函数 `renderChangelogInline(text)` 与支持面常量 `CHANGELOG_MD_INLINE`（零依赖、纯函数、永不抛错）。
- 面板链接落地 `openLink?: (url: string) => void | Promise<void>`（#111 定稿）：不传即 `window.open(url, "_blank", "noopener,noreferrer")`——桌面宿主交系统浏览器、web 宿主开新标签页，面板正文永不被导航走；传了即交给集成方，抛错只吞。

### Changed
- 双主题同一份 DOM 只换 CSS：`UPDATE_PANEL_CSS` 加最小可用样式（代码底色、朱红链接、虚线图片占位），档案卷 `UPDATE_PANEL_ARCHIVE_CSS` 只换肤（纸色底、细底线链接）；两套都走现有 token，第三方 `themeTokens` 覆盖即生效。
- `renderChangelogItem` 改走行内渲染；公开解析形状零变化（`ChangelogEntry.sections` 仍是原文数组、截断仍在解析期按字符切、计数不变），集成方读 `parseChangelog` 的结果一字不改；截断悬空标记（截在 `` ` `` 或 `**` 中间）渲染期兜底剥掉，配平的照渲染。
- 预览件 `docs/research/20261014-changelog-md-preview.html`（#114）：真实日志 + 边界样本的双主题并排预览，由本包渲染器直接产出。

### Security
- HTML 永不直通：一切文本先转义再拼标签（野外真反例 `dsh-im<channel>` 当文本显示）；链接与图片只认 http/https，`javascript:`／`data:`／`file:`／相对路径一律按字面文本；未闭合标记按字面输出，输出永远标签配平。

门禁：`npm test` 1006 例（1005 过 / 0 失败 / 1 跳过既有）。

## [0.13.0] - 2026-10-11

### Added
- 面板字号参数化（#103）：`themeTokens` 新增 5 语义键——`panelFontSize`（正文基准，默认 `14px`）、`panelChapterFontSize`（章节标题，默认 `14px`／档案卷 `17px`，批量标题 `15px`／档案卷 `21px` 同键）、`panelBannerTitleFontSize`（横幅标题，默认继承正文／档案卷 `27px`、已最新 `24px`）、`panelLogFontSize`（日志，默认 `13px` 系）、`panelSmallFontSize`（小字副行/注脚，默认 `11px`–`12.5px` 按规则回退）；沿 `语义键 → --dsh-update-panel-* → 根内联，非法即抛` 同口径，CSS 全量走 `var(...,旧值)` 回退，不传零回归；被覆盖 token 即固定值（深色媒体不跟随，README 已注明）。
- 面板字号 README 键表（#103）：`themeTokens` 文档新增「面板字号」一行与固定值补注。

### Changed
- 尺寸用例同步回退断言（#103）：`panel-prototype-skeleton` 状态行 `27px`／已最新 `24px` 改断变量回退（原型值仍在回退里），行为零变更。

门禁：`npm test` 978 例（977 过 / 0 失败 / 1 跳过既有）+ `gate:bilingual` 四道硬门禁过（318 draft 未动；`--release` 仍如实红，非阻断）。

## [0.12.0] - 2026-10-11

### Added
- 中文分类（#102）：`### 新增/修复/变更/弃用预告/移除/安全` 与英文等价（精确匹配，子串不算），E 提示与 README 作者契约同步。
- 档案卷日志原型 UI（#102）：版本 mono 粗体加日期灰小字（日期独立 span，默认主题零变化），分类头隐藏改条目前缀红字。
- 横幅副行出框（#102）：行动句移出色框为独立兄弟节点，框下第二行居左。
- 宿主样式隔离（#102）：章节标题钉死颜色并清洗渐变三件套，防宿主全局样式染色。

### Changed
- 按钮照原型收紧（#102）：archive 下紧凑口径，复制类小按钮；放弃忙闲同宽预留，默认主题不动。
- 有文零解析改走"读不出来"（#102）：空文本仍"未提供"，区间外旧行为不动；不新增文案键。

门禁：`npm test` 956 例（955 过 / 1 跳过既有 / 0 失败）+ `gate:bilingual` 四道硬门禁过（318 draft 未动；`--release` 仍如实红，非阻断）。字号参数化另立 #103，本版不动代码只立票。

## [0.11.0] - 2026-10-10

### Added
- 通道错码独立化（#98）：新增 `channel-mismatch` 阻塞原因与中英双语文案，门禁 14→15 码；缺省 stable 下预发布已装版落到通道码，使用范围栏显示真实名，手工命令仅在安全可选项存在时给出。
- 档案卷横幅小印章行内化（#99）：印章由伪元素改真节点行内章（同行居左），框随文长（min-width＋自动伸展＋不换行），待重启档无章，`data-mini` 属性保留。

### Changed
- 手工命令无安全可选项回空（#98）：不再回退旧 picks[0]、不猜 latest；会降级、无候选、比不出时回空态。

### Fixed
- 预发布已装版误报 `unknown-profile`（#98）：运行推导去通道门，完好性判定去通道门，`registrySpec` 认精确预发布与预发布范围；`unknown-profile` 只留真定位不到与版本非法。

门禁：`npm test` 908 例（907 过 / 1 跳过既有 derive-client / 0 失败）+ `gate:bilingual` 四道硬门禁过（316 draft 未动；`--release` 仍如实红，非阻断）。

## [0.10.0] - 2026-10-09

### Added
- 待重启诚实化基线（#95 T0）：字典 4 键收敛为“请重启DSH”，基线与快照同步，bilingual-gate 同步放行。
- 续跑按钮后果悬停（#85 收尾）：新增 `batch.action.resume-title`“从上次没做完的地方接着安装，已完成的不重装”，grilling Q1-Q4 全认可。
- 弹窗高度量盒子探针（#93 附带）：`scripts/panel-layout-probe.mjs` 用系统 Chrome headless 量盒子（非滚动区不被压、副行不折列、矮窗整面板可滚），可选仪器、非发布门禁。

### Changed
- 待重启去 primary 保委托（#96 T1 单面板 + #97 T2 批量）：`restart-hint` 与批量横幅 `restart` 按钮摘 `data-primary`，不换文案不加键；批量顶部行对齐收敛；注释与单测同步。

### Fixed
- 弹窗高度让渡契约（#93）：带滚动区弹窗帧里只有滚动区让高度，其余各区 `flex:none`；档案卷横幅去 `flex-wrap` 布局语义；窗口矮到连框架都放不下时整面板自己滚，章节区留 8em 下限。
- 续跑 stalled 判据只认盘上会话（#85）：无会话一律按没有未终态处理，行相位不作判据；新增 `unfinishedCount` 与 `hasUnfinishedRows` 同口径，`rows` 参数仅兼容保留。

门禁：`npm test` 888 例（887 过 / 1 跳过既有 derive-client / 0 失败）+ `gate:bilingual` 四道硬门禁过（313 draft 未动；`--release` 仍如实红，非阻断）。

## [0.9.0] - 2026-10-08

### Added
- 批量详情独立动作矩阵（#84）：详情弹窗按单插件内核只读 + 批量自出动作行，支持单查 / 重试 / 复制诊断 / 复制手工 / 跳过，行单查透 `phoneNames`、诊断进 `diag/env/queue`；死按钮摘净、不嵌套滚动；文案零新增。
- 批量两段式决策 ADR-0004 proposed（#86）：先全查再串行装（生产者 `checkAll` + 消费者复用 `driveLocked/runBatch`）、查并发取 3、消费前重查（不做常驻 reader）、公平性有界与回退线；本版只落决策不改驱动。
- 主题新增 `newOkText`（#71 修订 Q1）：done 行新版走绿 `newOkText`，其余带箭头行走红 `newText`，相等无箭头；README 键表同步，深浅 / 档案 / forced-colors 回退。

### Changed
- 总账吃知识（#73 口径 = #82 推荐 A）+ 世界账与轮次账分家（#90）：无轮次 pending 行按知识四态（有新版进可更新 / 已是最新进已最新 / 无知识与查失败仍待查），有轮次与 checking 行恒走执行态；终态 current / 无重启 done 行被更新鲜知识推翻为可更新（`lastCheckedAt > 会话行 updatedAt` 且快照比对确有新版），陈旧知识与失败检查永不推翻；入口徽标 `batchEntrySummary` 同口径（含 openOn='has-update' 在轮不开面板）。
- 检查诚实语义（#90 R2/R5 + #73）：宿主 `defaultCheck` 回包成功却无版本永不判 current，改判 `check-failed`；知识“查过但无版本”判 never（回“还没查过”），不再坍缩为“已是最新”；知识查失败归待查，不冒充安装失败（顶部不再喊“N 家安装失败”）。
- 驱动进行中检查回忙（#90 R4）+ 装类在途轮询放行：`checkPhone` 在 `driveActive` 时回 `update-busy`，不用旧表冒充 fresh 结果；批量驱动收尾前可观测中间进度。
- 判定收敛（#73 code-review）：新增 `sessionEntriesOf/entryPhaseOf/isUnfinishedEntry` 与 `knowledgeVerdictOf` 唯一判定，总账与行共用“在轮 / 知识”两处判定，注释正错（首个匹配即返、任一条目非终态即在轮）。

### Fixed
- 明细行版本与对齐一致性（#83）：知识孤版红 + 入口吃知识，会话目标赢知识；三列网格（名 5em / 版 18ch / 态 1fr）与 #71 无回归。
- 单面板宏忙守卫与批量一致（#87）：installing / verifying 快照与 busyAct 在途时查 / 装两键同灰，只加 disabled，不换文案不加键。
- 详情 row-skip 非法版本与单面板同口径（#88）：不记不 toast 静默重绘；entry locale 注释正错。
- 重启后待重启自动回查清零（#91）：任务完成态换算落盘（restart-required→completed）， done + 待重启在快照已生效时清零、真未生效时保留；只读失败不展示陈旧待重启。
- 单面板安装门控稳定（#87 附带）：settled 等自动查回包；抖动预留与闪空行留存沿用既有载体（68 预留 + 焦点滚动 + 轮询让路，74 prefs-only）。

门禁：`npm test` 869 例（868 过 / 1 跳过既有 derive-client / 0 失败）+ `gate:bilingual` 四道硬门禁过（文案零新增，312 draft 未动；`--release` 仍如实红，非阻断）。

## [0.8.0] - 2026-10-07

### Added
- 入口件无新版摆法 `upToDateDisplay`（`note` / `button`（默认） / `tooltip`）：默认按钮本身即`已是最新 X.Y.Z`（单按钮不占宽，可点再查，hover 回`检查更新`暗示动作；无新版走中性弱边、hover 才走主色，复用既有 token，不新增文案与 token）；`tooltip` 按钮仍是`检查更新`、版本收进悬停；`note` 回右侧小字旧样子（显式传回）。入口 `label()` 与按钮正文同口径，`badge` 形态不受影响；README 2.5 节补自由度与参数说明，单测覆盖三摆法与非法校验。

### Fixed
- 查新版瞬时抖动补强（面板）：忙闲两帧同高（动作区按钮 nowrap + 最小宽预留、转圈槽常驻）+ 横幅／复制区最小高占位，查新版与轮询回包帧不再跳动。
- 入口件深色默认主题补 `text-muted`（`#9ca3af`），按钮直显弱边在深底可读。
- 批量 prefs-only 存偏好回归测试补齐（#74）：偏好保存不闪空行、失败保留行（测试覆盖，行为零变更）。

## [0.7.1] - 2026-10-06

### Fixed
- 批量行三列对齐 + pending 显示最新版 + 新版红（#71）：行主区改网格（名 5em／版 18ch／态 1fr，版 nowrap + tabular-nums，态换行同列起，失败跨整行）；版本三段式只红新版（老版本弱化／箭头中性／专用红 token `newText`，深浅主题与档案皮肤及 forced-colors 回退，加粗 + 箭头 + 状态词为非颜色信号）；版本会话优先、知识仅展示，无轮次无知识回还没查过（不再误 wait-turn），轮次中仍执行态；会话／安装语义未动。
- 默认弹窗 01~05 横滑消除 + 疏朗化（#72，A 方案落地）。

### Added
- 主题变量新增 `newText`（`--dsh-update-new-text`，有新版版本号专用红，可覆盖，非法即抛）。

## [0.7.0] - 2026-10-06

### Added
- 主题变量覆盖 `themeTokens`（第三方换肤一等口径）：单面板、批量面板、入口件、批量入口件四个挂载口同收同语义（35 个语义键对 `--dsh-update-*` 变量，颜色收 hex 或英文名，其余走注入检查，非法挂载即抛）；内联写根、变量继承，入口件打开的 dialog 同步透传，批量展开的详情行经继承生效；控制器同步新增 `setThemeTokens`（传 `undefined` 即清掉覆盖）；被覆盖的 token 不再跟随深色媒体查询。README 补换肤章节与键表。
## [0.6.0] - 2026-10-06

### Changed
- 主题 token 全系更名（breaking）：`--d5-*` 18 个全系删除，`--dsh-upd-*` 展开为 `--dsh-update-*`；补全状态字色／次级字／强边线／深主色／字体／阴影／圆角 token，两主题共用同一张词典，主题只换值；卷宗横幅边框改吃 `*-border`（值与旧字色相等，零视觉差）；默认主题按钮边框吃 `border-strong`、卡片与按钮圆角及字体栈走变量（值与旧硬编码相等）。

### Removed
- 主题取值 `'d5-paper'` 删除，仅剩 `'default' | 'archive'`（非法即抛）；常量 `UPDATE_PANEL_D5_CSS / UPDATE_BATCH_PANEL_D5_CSS` 更名为 `UPDATE_PANEL_ARCHIVE_CSS / UPDATE_BATCH_PANEL_ARCHIVE_CSS`；手写旧变量覆盖须迁移到新词典；`demo/d5-progress.*` 更名为 `demo/archive-progress.*`，`tests/panel-d5-theme.test.mjs` 更名为 `tests/panel-archive-theme.test.mjs`。

## [0.5.8] - 2026-10-06

### Added
- 语言底座 v2 按宿主语言单语渲染，入口两条链先生效（#60，地图 #51）：新增 `src/lang.ts` 信号层（显式 `locale` > `document.documentElement.lang` > `navigator.languages` > 中文兜底，非中文落英文；单例 `MutationObserver` + 服务订阅，切换即时重绘，`unmount` 停订，无 DOM 落中文）；`bilingual.ts` 新增 `copyHTML/copyText(key, lang, values)` 单语纯函数出口（一次一种语言，单 `span[lang]`），旧 `bilingualHTML/Text` 转为按当前语言包装，字典新增 `batch-entry.*` 6 键（13 键全 `draft`）；`entry/entry-batch` 新增 `locale` 选项全走字典单语块（含聚合口径与 `已是最新` 小字）；`panel/panel-batch` 仅加 `locale` 占位暂不消费（#61-#66 按面迁移）；双语门禁改断言单语（缺语言/混语言即红，冻结词元除外）；`build.mjs` 加 `lang.ts` 单元；README 补单语与窗口期说明。

## [0.5.7] - 2026-10-06

### Fixed
- 拆入口通道安装禁令（#58 真因）：入口件 HTTP 直挂不再源码级禁 updateInstall（入口件核心本就没有安装代码路径，禁令只连坐入口件打开的面板；真正门禁在宿主侧核心）；入口打开面板后安装电话端到端验证通过。

## [0.5.6] - 2026-10-06

### Added
- 弹窗分栏滚动、更新日志折叠与动效体系；双语防倒退门禁四道检查（文案源／快照／契约／零 draft）与自测（#56）。

### Fixed
- 用户路径抛错锁存非瞬态化（#58）：查／装动作的传输抛错改为非瞬态锁存（安装抛错码为 install-failed，不再冒充查失败），轮询不再洗掉；抛错原文脱敏后进复制摘要；安装内补查失败精确归因到查阶段；轮询抛错仍瞬态自愈。

## [0.5.5] - 2026-10-06

### Added
- 档案卷主题收敛 archive 与面板紧凑化：运行时 data-theme 统一为 archive，entry/entry-batch/panel-batch 输出与 CSS 选择器同步，panel-batch setTheme 补 archive 并归一存储；根／卷头／横幅／版本条／章节／章头／队列行／footer 间距收紧；删 changelog-wrap 与章节线重影内边框；页脚去技术词，批量关闭 title 同步。
- 双语底座 #54（先行）：bilingual 字典模块、entry key 映射链、noteVersion 运行时值；research/52-inventory 双语盘点与原型矩阵随附。

### Fixed
- 安装/查失败常驻与复制诊断锁定（#58）：失败横幅保留到下一次用户主动查/装的新结论、任务态或版本变化，只读轮询不再洗回可装页；「复制诊断」锁定致命那次回包（稳定码、摘要、版本、宿主、请求与检查编号冻结在失败时刻）；失败旁新增「知道了」可显式确认回到可装页；健康无失败时复制改为当前状态快照，不再伪造失败码；04 章失败时变为卷宗（真实稳定码、本次查询键与失败时刻、证据冻结声明、凭编号对日志的现成查询，平时为路牌＋中性行，可用 `showLogHint: false` 藏路牌）；日志事件名收归 `log-events.ts` 单源（宿主发射与面板路牌同源）；对抗审查补强：瞬态读失败不跨重挂、查锁存不再错配旧安装编号、瞬态失败换诚实文案、跨挂载表有界 100 家；`update-busy` 仍为瞬态不锁存；四电话形状与快照六字段零变更。

## [0.5.4] - 2026-10-06

### Added
- 批量感知入口件（#49）：新子路径 `dsh-plugin-update/entry-batch`，一颗按钮看 N 家聚合（button/badge/inline；openOn 缺省 always，autoCheck 缺省 mount；只调 batchStatus/batchCheck，绝不自动装；聚合与批量总账同一份数法，忙失败占位翻回可更新）。
- 批量 dialog 关闭落地与单面板同口径（#50）：`BatchPanelOptions` 新增可选 `onCloseRequested`，点关闭/Esc 先交调用方撤 DOM 再停轮询；入口件打开的 dialog 已内置；不传回退只停轮询；HTTP 直挂透传。

## [0.5.3] - 2026-10-06

### Added
- 进入面板自动查一次新版（#46 结论固化 #48）：首绘 loading 后先只读本地刷新，拿到活体快照后条件自动查一次；轮询心跳永远只读本地、不触发查新版；抑制谓词 `pendingAutoCheck` 为纯函数，仅快照任务态 installing/verifying 或已有查/装在途时不发起，同范围忙/凭证过期/各类阻拦一律不抑制，无活体快照不发起；复用手动查同一通路与“正在查新版…”提示；并发只信服务端真相源（面板 busyAct 互斥 + checking 在途复用 + 2s 复用窗口），卸载靠 mounted 丢弃；失败无退避，只渲染既有失败文案与复制诊断，手动查清日志退避、关闭重开立即重问；embedded/dialog 一致；pollMs 不影响时机；四电话形状与快照六字段零变更。
- 关闭按钮住右下角独立 footer 区（#47 定案 A）：第一章 actions 不再画 close-view，内核末尾 05 章之后新增 `.dsh-upd-footer`（dialog + 非只读渲染才有），按钮原 title/data-action 原样搬入；embedded 无面板自带关闭（宿主框架自带关）；默认 + 档案卷只换肤、DOM 同序；act/Esc/onCloseRequested 语义一字未动。

### Changed
- 入口件 direct 断言收紧：区分入口自身空参预查与面板挂载带 includeQueue 自查（面板挂载即自查归面板）。
- 面板安装复用断言更新：mount 自动查已拿凭证时安装直接复用，不另查（无 receipt 回退见 panel-auto-check 用例）。
- 测试：新增 tests/panel-auto-check.test.mjs 11 项（纯函数、正常/抑制/阻拦仍查、慢网单发、卸载丢弃、手动重问、轮询不查、失败无退避、安装复用凭证），tests/panel-close-footer-47.test.mjs 5 项随前一提交；全量 637 计、636 过、0 败、1 跳（既有 derive-client 跳过）。

## [0.5.2] - 2026-10-06

### Added
- Security 必显：`### Security` 与 `Added/Fixed/Changed` 同级展开（页面查找可命中）；单类超 200 条时前 200 条展开、其余收进该类内部折叠并标计数（64K/单条 500 字墙保留）。
- 诚实截断计数：超限类标题下加小字“共 M 条，仅显示前 N 条”（M 该版该类原始条数、N 实际渲染数，多版本各自标；未超限不打扰）。
- 撤回警告：目标版本标题含 `[YANKED]` 时第 02 章区间标题下方加警告横幅（`role=alert`）：“目标版本 X.Y.Z 已被作者撤回（yanked），安装不受影响，继续前请确认。”；中间版本只保留标题后缀，不挡安装、不碰快照门控。
- 破坏标记：条目开头 `BREAKING:`/`不兼容:`（大小写不敏感，中英文冒号皆可，匹配前剥行首加粗/引用装饰）行首挂徽标（`role=img`）+ 前缀加粗，正文一字不动；正文中间散文永不误标。
- `validateChangelog(markdown)` 纯函数（零导入、永不抛错，与 parse 共享扫描仪）：回 `{ ok, diagnostics: { line, code, hint }[] }`（line 原文件 1-based 行号，按行号排序）；码表 `E_VERSION_TITLE`/`E_CATEGORY`/`E_BULLET_ORPHAN`（Error，会丢内容）与 `W_BREAKING_MAYBE`/`W_YANKED`/`W_TRUNCATED`/`W_TRUNCATED_FILE`/`W_EMPTY`（Warning）；仅 CI/发布前用，运行时永不调用。
- 记住语义澄清：成功与取不到（null）按版本永久记（面板内存会话级 + 宿主进程级，不落盘；显式文本永不覆盖）；传输失败不进缓存，手动查/换版/重开立即重试，轮询按退避问（`shouldFetchChangelog` 纯策略三处共用）；`autoChangelog: false` 关闭整链。
- 文档：README §2.7/§5.8 同步必显/计数/横幅/标记/校验/记住的用户做法（只加 MUST/SHOULD，不放设计 rationale，详见 ADR-0002）。

## [0.5.1] - 2026-10-06

### Added
- 入口件 `openOn: 'direct'`：点开即弹窗、不预查（面板挂载即自查；徽标形态仍走回调口径）。

### Fixed
- 入口件小字对比度：原地提示与档案卷按钮脸自带底，深色宿主下也读得出。

## [0.5.0] - 2026-10-05

### Added
- 主题首选名 `archive`（档案卷纸面浅色）：`archive` 为唯一的档案卷取值；入口件与批量面板同一套取值。
- 弹窗关闭落地 `onCloseRequested`：dialog 下点「关闭」/按 Esc 先交调用方撤 DOM 再停轮询；入口件打开的 dialog 已内置（收 dialog + 还原按钮 + 重查一次）。

### Fixed
- 弹窗点「关闭」没反应：此前只停轮询不撤 DOM（入口件打开的 dialog 还会卡死），现走关闭落地。
- 悬停/聚焦闪烁：轮询每秒整树重写 innerHTML 打断 hover/focus，现输出逐字相同时不碰 DOM（状态变化仍即时重绘；单面板与批量面板同口径）。

## [0.4.0] - 2026-10-05

### Added
- 更新日志无脑接入（#38）：宿主新增 `updateChangelog` 电话（入参版本号，回该版 tarball 内全文，取不到回空；同源 + 精确路径 + `integrity` + 三墙复用，按版本记住结果）；面板 `autoChangelog` 默认自动展示（有新版调一次，显式文本仍赢，`false` 退回手动）；入口件透传跟上；批量详情行按行自动取（无新增批量电话，单行失败只影响该行）；HTTP 版白名单放行，老三电话形状不变。
- 按钮交互反馈：查新版/安装在途置忙（禁用 + 文案 + `aria-busy` + 纯 CSS 转圈，并发连点只认第一次）；默认主题补 hover / 按下下沉 / 过渡；busy 脉冲与 `prefers-reduced-motion` 关闭。
- 原生 `title` 说明：单面板全部动作按钮、批量宏按钮带悬停一句话（零成本 tooltip，不引入浮层组件）。
- Toast 语义：复制/重启类回执 5 秒后自动过期，不靠下次点击才消失。
- 首帧骨架：快照没到之前版本条画微光占位（`aria-hidden`，不进语义）。
- 批量「取消这一批」鼠标两步确认（第一次上膛红框，点别的自动卸膛；程序调 `act('cancel')` 仍一次即执行）。
- Esc 关弹窗：单面板 / 批量面板 dialog 与入口件 dialog 均支持（容器契约内，只用 innerHTML + 事件）。

## [0.3.1] - 2026-10-05

### Added
- 新增 `dsh-plugin-update/http`：`createHttpCall`（单三电话 + 批量五电话同一内核，`batchPrefix` 独立）+ `mountUpdatePanelHttp`/`mountUpdateEntryHttp`/`mountUpdateBatchPanelHttp`，只传 pluginId + prefix/batchPrefix + baseUrl/routes 即跑通检查/安装/待重启/失败与批量总账/明细/动作；queue/env/session/rows/progress/diag 全透传，传输失败走 `http-transport-failed` 异常通道，取消整批走 `batchCancel` 电话。

## [0.3.0] - 2026-10-04

### Added
- **多目标批量更新**（`dsh-plugin-update/batch` + `/panel-batch`）：一次接线管 N 个插件——五个批量电话（status/check/install/resume/cancel）＋ 总账/明细/动作三层面板；一家收尾才起下一家，失败一家继续下一家（可配停）。
- **耐久会话账本**：批量会话落盘 `update-queue/<使用范围短指纹>/batch.json`，断点续跑（进程重启/前端重载后 `batchResume` 接着走），幂等编号恒等（已完成不重装），`selfKey` 默认把自己排最后（自更新安全）。
- **排队语义**：忙时也能「加入队列」——`batchInstall` 在驱动进行中不再回 `update-busy`，改成并入会话 + 单飞推进；单插件回 `update-busy` 映射成 `queued`（相位退 `ready`，**不是失败**），排队行给「取消排队」（打该家自己的安装电话 `cancelQueued`）。
- **更新入口件**（`dsh-plugin-update/entry`）：`button`/`badge`/`inline` 三形态 ＋ 状态联动文案（检查更新/有新版 X.Y.Z/正在安装…/待重启/更新失败，点此查看）；`autoCheck` 与 `openOn` 两个策略。**铁律**：只做「查 + 打开面板」，任何路径都不自动安装。
- 只读渲染开关 `renderUpdatePanelHTML({ actions: 'none' })`：五章内容照画、动作按钮一个不画（给「调用方自己提供动作面」的场景）。
- 跨插件单队列串行：同范围 `queue.json` + `global.lock`，FIFO 取号、仅撤自己，`includeQueue/showOthers` 开关，默认只看自己。
- 跳过按插件+版本持久化：`skipped.json`（50 条封顶、坏文件自愈），同一横幅行「已跳过 X.Y.Z · 恢复」。
- 版本通道：`releaseChannel` 默认 `stable`，显式 `prerelease` 才收预发布，全通道精确版锁定。
- 现成整组件：`dsh-plugin-update/panel`（内嵌/弹窗一键切换，轮询/门控/中文一句话/待重启横幅/手工复制/排队开关/跳过/诊断复制全内置），完整类型定义随包分发，零运行依赖。
- 脱敏规则表：五条具名规则（绝对路径/URL 账号密码/令牌前缀/密码键值对/邮箱），顺序固定，两占位符 `<路径>`/`<脱敏>`，复制前收敛。
- 后台安装不中断：关面板不中断，重开读盘 1 秒内恢复，仅进程关判中断。
- 档案卷可选主题：`theme: 'archive'`（`mountUpdatePanel` + `setTheme`，默认不动），迷你印章 + profile 牌 + 待重启衬线横幅 + 手绘 SVG 标 + 窄屏印章固定 + 省略号逐字折叠 + 浅深双主题，DOM 冻结、复制诊断常在。

### Fixed
- **死按钮根治**：批量面板的详情曾把单插件内核 markup 原样搬入而不接管行为，里面 5 颗按钮可点却无反应。现在详情的内核走**只读渲染**（`actions:'none'`，连队列章的 `toggle-queue` 一起摘），动作行由批量面板自己提供（与行内同一 `act` 通道、同一忙守卫）。
- **后台失败行的诊断**：安装超时/后台收尾失败那种没有结构化 `diag` 的行，改用 `job.message` 正文并标注「来源：后台任务收尾记录」——拿真内容，不编造。
- **锁陈旧判据单源**：显式注入的抢锁口子现在也收到 `{ timeoutMs: installTimeoutMs }`，不再各自拍阈值（默认行为不变）。真卡死时队列按安装时限回收，不再白等 15 分钟。
- **账本事实优先**：账本记 `failed` 而实时快照显示该家已装到目标版时，相位纠成 `done`（`restartRequired` 按待重启判），`error` 留痕不抹——只在刷新路径、只纠 `failed`、版本精确匹配才动手。

### Changed
- 面板文案全称化：「安装这家」「安装 X.Y.Z」不再简写成「装这家」「装 X.Y.Z」（负向门禁锁死）。
- 批量面板详情里的动作**归属批量面板**：详情是只读视图，操作统一走行内与详情那排 `data-act` 按钮。
- 请求编号收紧为不透明串 `[A-Za-z0-9._~-]{1,128}` 且拒绝令牌前缀，`req-1`/`id-N`/UUID 不受影响（公开契约变更，用 UUID/不透明串，不要把秘密当编号传）。
- 失败详情 300 字落刀改空白边界（不断占位符），长度不变，切分位置可见变化。

## [0.2.0] - 2026-09-30

### Added
- 目标包按包名解析：普通依赖形态一键升级可用，显式 `targetPackageDir` 逃生口，定位不到诚实 `unknown-profile`。
- 三电话入参与回参补齐，ESM 说明与无出口时诚实失败。

### Fixed
- 按包名解析后普通形态恢复可用；vendor 在目标包内部仍定位自身。

## [0.1.2] - 2026-09-30

### Added
- 第三条安装路由 `desktop-manager`：官方桌面版进程内插件管理器，老两条路由行为不变。
- 桌面管理器探测/配方/执行器/端到端测试 15 条。

### Fixed
- 官方桌面版点「装上」不再只有一条不可诊断的 `install-failed`，按政策诚实失败并转手工命令。


