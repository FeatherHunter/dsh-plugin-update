# Issue #86 研究：内部队列与两段式（生产者消费者 + 先全查再串行装是否做）

- 日期：2026-10-07
- 票：#86（父图 #81，frontier 可接），输入票 #70（open，needs-triage）
- 性质：只决策不实现（实现另起票）；本文件为 research 落盘，结论可直接拆落地票
- 方法：只认一手来源（源码行号 / ADR 节 / 票原文），每个事实标注来源；“用户想要”只认 #70 对齐成果节（[目-n]/[约-n]/[决-n]/[待-n]/[雾-n]/[遗-n]），否则标假设待澄清

## 0. 终裁四答（结论先行）

| #86 问题 | 终裁 | 一句话理由 |
|---|---|---|
| 是否做两段式 | **做** | 用户方向已定（[目-1][决-9]），且与 ADR-0003 §4 不变量同构（检查结果本就不参与安装决策，一轮开始仍实时重查） |
| checkPhone 并发度 3–5 取几 | **取 3** | 一手来源无 3/4/5 区分证据（[待-2] 未定、[雾-2] 边界不清），取下限保守起步，命名常量 + 门禁锁死，实测后再调 |
| sharedReader 二选一 | **选 A：消费前重查（提交遇 check-expired 当场重查一次），不做 B** | A 不碰 host.ts 单例纪律（规格 #591 第 6 条冻结语），且 defaultInstall 已有半条路；B（Map<key,receipt> + 按目标常驻 reader）触冻结，回归面大 |
| ADR-0004 是否写 | **写** | 编号 ADR-0004（0001–0003 已占、0004 空缺已验），标题建议《批量两段式：先全查再串行装》 |

## 1. 研究目标与决策依赖

#86 Question 原文（deck_issue_get #86，2026-10-06T17:42:02Z）：当前查一个装一个交错（nextBatchKey→check→落盘→install→落盘→下一家），batchCheck 串行只写 inventory 不建会话；用户要先全查再串行装（#70 已验证可行：batch.json 当 durable 队列、queue.json 只当锁、消费前必重查、TTL 只当展示）。要定四件事：是否做两段式、checkPhone 受控并发度 3–5、单例 sharedReader 二选一修法、ADR-0004 是否写。验收：终裁做/不做 + 分步落地清单；本票只决策不实现。

决策依赖（不猜，全部有主）：

- 用户方向已定：安装串行是硬约束（[约-1]，全局锁 + 单槽缓存所致）；终态是“先 N 家全查完的总账，再一家一家装，装完一家总账跳一下”（[目-1]）；生产者-消费者模型成立、技术上能做（[目-2]）；定成深模块 batch.json 当 durable 工作队列、queue.json 只当锁（[目-3]）；用户只定方向、细节助理兜底（[约-2]）。以上用户已逐条认可、无修正。
- 技术可行性已验证：#70 方案节四条（见 §3，[决-3]/[决-4]/[决-9]）。
- 待拍板只剩“是否值得做、何时动手（含是否写 ADR-0004 并改两段式驱动）”（[待-1]），并发度未定（[待-2]），单例修法未定（[待-3]），#70 何时转入落地未定（[待-4]）——即本票四项。

## 2. 现状证据链（交错驱动，一手源码）

### 2.1 查一个装一个交错（install 路）

调用链（逐函数实测）：

- 驱动入口 `driveLocked(session, selected, budget)` 在 src/host-batch.ts:878–928：while 循环内每次 `runBatch(view, {...}, { maxSteps: 1 })`（:897–912），一次只推一步（一步 = 一次传输调用，batch-run.ts:109–110 预算语义）；轮间 `mergeInto` 把忙时入队行并入（:887–888），落盘回调把视图合并回全量账本（:902–908）。
- 单步语义在 src/batch-run.ts:82–172：`nextBatchKey(current)` 取首个非终态行（:103，口径 batch.ts:232–239）；无 version 时先 `markBatchEntry(checking)` 落盘 → `deps.check(key)`（:118–119），failed / current / skipped 各自落盘继续（:122–136），有新版记 `ready + targetVersion` 落盘（:140–141）；随即同轮 `markBatchEntry(installing)` 落盘 → `deps.install(key, requestId, version)`（:148–150，编号恒用会话幂等号 batch.ts:122–125）；queued 退回 ready 并整轮停（:152–157）；failed 按 stopOnFailure 处置（:159–163）；done 记终态（:165–168）。每步后 `persist → deps.save`（:95–99），即“查→落盘→装→落盘→下一家”。
- 现成的两段式钩子：上一轮已查过（ready 且有版本）直接复用、不再重查（batch-run.ts:112–114 注释 + :146–150）——两段式的“装阶段”可零改动复用驱动器，只需在外层先把全员查成 ready。
- 装后收尾才起下一家：`defaultInstall → settleInstall` 在 src/host-batch.ts:505–517 轮询 `updateStatus` 到终态（restart-required / completed / failed / interrupted，见 `installOutcomeOf`:496–502），超 `installTimeoutMs` 按 install-failed 收（:508–510）；期间不打别家电话。第一性注释见 :29–31（单槽缓存换键丢活动任务编号，把“在装”误读成“中断”）与 :781–783（推进中一律用缓存，不打单插件电话）。
- installPhone 建/续会话语义（src/host-batch.ts:1029–1068）：忙时 `joinWhileBusy` 并进当前会话、不回 update-busy（:1004–1027）；盘上无会话或上一轮已收尾且为“全部提交”时开新会话（:1040–1054，行内 keys 复用旧账本、不抹别家 done/failed :1044）；失败/点到的跳过行复位 pending 再推（resetForRetry :860–871）；以 `+∞` 预算推完（:1060）。

### 2.2 batchCheck 串行、只写知识、不建会话

- `checkPhone()` 在 src/host-batch.ts:957–1001：`for (const rt of runtimes) { await rt.check(...) }` 串行查 N 家（:970–972）；结果只写 `inventory.entries[key] = { lastCheckedAt, installedVersion, latestVersion, canInstall, error }`（:978–986），经 `normalizeBatchInventory` 全量落盘（:995，落盘失败不挡回包 :996–998，逐家 try/catch :987–992）；回包 `table(session, false)` 账本不动（:1000）。串行是软选择（[决-2]）。
- 与 ADR-0003 §1 同构：知识只由查新全量重写、只做展示、永不参与安装决策。

### 2.3 两本账：batch.json 是 durable 工作队列，queue.json 只是互斥锁

- 会话账本 `BatchSession` 在 src/batch.ts:63–77（version/id/selfKey/stopOnFailure/order/entries）；落盘按属主隔离 `update-queue/<指纹>/<owner>/batch.json`（src/host-batch.ts:671–676），旧无属主 batch.json 永不读写（:671 注释，ADR-0003 §1 Q2=A）；读写口 `readSession/saveSession` :686–696。
- 幂等编号同一会话同一目标恒定（src/batch.ts:122–125 `batch:<会话>:<目标>`，电话侧洗形 phoneRequestIdOf :240–249）；重复提交由核心按 requestId 去重（service.ts:617 直接返旧结果）。
- 断点续跑 `resumeBatchSession`（src/batch.ts:293–304）：checking/installing 退回 pending，done/current/failed/skipped 终态保留——已完成的不重装。
- 自更新安全 `orderTargets` 把 selfKey 排最后（src/batch.ts:109–120；host-batch.ts:99, :570–572）。
- 队列 `UpdateQueueState { version:1, owner, waiting }` 在 src/queue.ts:46–50，纯决策零导入（:22–23）；意向过期只清 waiting、owner 由全局锁与安装时限看守（:110–121）；占位幂等 `enqueueInQueue`:128–146；队首判定 `isHeadOfQueue`:243–254，位置口径 `queuePositionOf`:230–241。
- 组合锁先抢全局后抢自家（src/host.ts:440–455）；公平门非队首直接 update-busy（:970–974）；批量遇 update-busy 映射成 queued、相位退回 ready（host-batch.ts:550–555），驱动器遇 queued 整轮停（batch-run.ts:152–157）。以上是 [决-7] 的源码落点。

### 2.4 TTL 只当展示（正确性不依赖 TTL）

- src/config.ts:42 `DEFAULT_CONFIRMATION_TTL_MS = 10*60_000`（凭证 10 分钟，#591 冻结）；src/queue.ts:26 `QUEUE_INTENT_TTL_MS = 10*60_000`（排队意向 10 分钟，#15）；src/config.ts:43 `DEFAULT_INSTALL_TIMEOUT_MS = 15*60_000`（安装时限 15 分钟/家；全局锁陈旧回收同口径 host.ts:493–497）。
- 批量串行 N 家必超 10 分钟是算术（[约-3][决-5]，用户已认可）；凭证 `expiresAt = now + TTL`（service.ts:548），过期提交即 check-expired（service.ts:621）。所以两段式下预查凭证在装到后面几家时必然过期——正确性只能靠消费前重查，不能靠 TTL。这就是 #70“TTL 只当展示/排号”的一手依据。
- 装前二次比对全证据（service.ts install :610–652）：checkId/requestId 形状不齐即 check-expired（:613）；凭证三条件（无/对不上/过期 → check-expired，:621）；`installationKey` 比对（:624，装前复核 :640）；**装前二次全文比对**：重取远端并 `JSON.stringify` 全等比较，不等即 check-expired（:637–638）；在装/待重启即 update-busy（:618–619）。

### 2.5 单例 sharedReader 挤占机制（逐行实锤）

- 单例宣言：src/host.ts:193–194 注释“单例让查状态看到查新版的结果；复用键强制含插件标识（规格 #591 第 6 条）”；单变量 :201–202。
- 复用键含 pluginId + prefix + runningVersion + profileDir + …（:395）；命中复用（:396），未命中重建并覆盖模块级单例（:538–570，`sharedReaderKey = key` :569）。
- 三电话每次现取单例：readStatus :901–902，readCheck :913–914，runInstall :938–941——全部经 `getSharedReader`（:359）。
- 凭证纯内存：`let checked: CheckedState | null = null`（src/service.ts:433–434）；发凭证 `checkId = randomId(), expiresAt = now + TTL`（:544–551）；只交编号与有效期（toReceipt :565–569）。
- 挤占后果链：批量各目标 pluginId 互异（host-batch.ts:366–375 按批量前缀+键派生，:20 注释“七个目标各有各的内存状态”）→ 查 B 即重建 reader 并覆盖单例 → A 的核心 `checked` 随旧 reader 对象被 orphan → 装 A 提交旧 checkId → service.ts:621 `!checked` → check-expired。host-batch 层的 `rt.receipt`（:415，:491 按目标隔离记忆）救不了核心侧已丢的 `checked`。
- 现状交错流天然免疫：check→install 同轮连续发生、中间无他家电话（§2.1 + :29–31）。所以挤占是两段式**新增**的风险，不是现状 bug（[决-6] 已确认现象，修法未定见 [待-3]）。定量推论（假设待实测确认频次，但机制确定）：全查 N 家后按会话顺序串行装，除恰为最后查到的那家外，每家首次提交必 check-expired → A 案下每家约 2 次 check 联网（见 §4.3 成本注）。

### 2.6 ADR-0003 的边界（为什么要写 ADR-0004）

- docs/adr/0003-batch-knowledge-vs-round.md（已采纳，2026-10-06，关联 #59）：§1 知识/一轮/属主各回各家；§4 不变量 Archive 明文“检查结果不参与安装决策，一轮开始仍实时重查；幂等编号、每步落盘、一次只推一家、失败继续下一家、单队列串行（queue.json 仍单份共享，取消只清自己账本）——一个字不改”；反向范围“不动驱动语义”。
- 关系判定（本研究终裁）：两段式与 §4 不变量**同构兼容**（预查进 inventory 只展示、安装决策永远走装前实时重查，正是“检查结果不参与安装决策”的字面落实）；但它确实改了驱动语义（查→装交错 → 先全查再串行装），触碰反向范围“不动驱动语义”一句。为免后人把 0003 Archive 误读成两段式的禁令，必须另起 ADR 记录差分——这就是“ADR-0004 是否写”判为写的依据。

## 3. #70 方案复述（已验证可行，不重验只引用）

来源：deck_issue_get #70 全文（含 2026-10-06 对齐成果，用户已认可、无修正）。

- 深模块定形：batch.json 就是 durable 工作队列，queue.json 继续只当互斥锁，不二选一（#70 方案首句 + [决-3]）。
- 接口只留两个：生产者 `enqueueInstall(keys)` 幂等丢意图，消费者 `driveNext()` 单驱动一次拿一家（[决-9]；现状对应物为 addKeys :318–341 与 driveLocked :878–928，是否真收敛到这两个名字由实现票定，本票不断言）。
- 队列只存 key + 期望版本 + requestId，不存 checkId；消费前必重查/验凭证，过期只触发重查、不判失败（方案 + [决-4]）。
- 两段式：先选中 keys 全查成 ready 进会话，再循环 安装→settle 到终态→落盘→下一家；queued/check-expired 当场重查一次（方案 + 改动清单 2 + [目-1][决-1][决-9]）。
- TTL 只当展示/排号（方案 + [约-3][决-5]）。
- 单例二选一：消费前重查规避，或 host-batch 持 Map<key,receipt> + 按目标常驻 reader（方案 + [决-6] + [待-3]）。
- 不变量保留：selfKey 排最后、每步落盘断点续跑、driveActive 单驱动、失败继续/停下、跳过版本、跨 scope 拒绝、面板忙守卫（方案末段 + [遗-1]/[遗-3]）。
- 改动清单（#70 原文）：1) checkPhone 受控并发 3–5 全查写 inventory 不建会话；2) install 改两段式，check-expired 自动重查一次；3) settleInstall 轮询与面板忙守卫不动，单测用假 transport 断言顺序 + 重启恢复 + 过期重查。验收三条（先见总账再逐家装；重启续跑不重装；过期不误报失败）维持。

## 4. 四项终裁建议（每项 做/不做 + 理由 + 落地清单 + 风险）

> 本节是研究建议，最终拍板归用户（[待-1]）。凡“用户想要”均已标对齐条目；无标注入 tr 为本研究判断，属假设待澄清。

### 4.1 是否做两段式 → 做

- 理由：① 用户终态明确（[目-1] 先 N 家全查完的总账、再一家一家装）；② #70 已验证技术可行（§3）；③ 与 ADR-0003 §4 同构（§2.6），不是推翻而是落实；④ 现状交错下“点一次全部更新”看不到 N 家总账，与终态冲突。增量最小：装阶段复用现有 driveLocked/runBatch（ready 复用钩子 batch-run.ts:114 已有，驱动器零改）。
- 落地清单：① installPhone 改两段驱动：建/续会话后先对选中 keys 全查成 ready（把 checkPhone :970–993 循环体抽成 checkAll，只写 inventory + 置 ready，不装），再进现有 driveLocked 串行装；② check-expired 当场重查一次继续：把 defaultInstall :534–541 的“!receipt 重查”分支扩展为“无凭证或提交报 check-expired → 重查一次 → 再提交一次”，第二次仍过期才记 failed（现有 :555 落盘语义不变）；③ settleInstall（:505–517）与面板忙守卫（panel-batch.ts:25–26）不动。
- 风险：① 每家约 2 次 check 联网（§2.5 定量推论 + §4.3 成本注）；② 全查阶段某家失败不阻塞建会话（failed 行照常落盘，stopOnFailure batch.ts:231–233 不变）；③ 自更新仍排最后，全查不提前换掉自己（orderTargets 不动）。

### 4.2 checkPhone 受控并发度 3–5 → 取 3，做

- 理由：① 一手来源无 3/4/5 的区分证据（[待-2] 未定案，[雾-2] 边界不清），只能取下限保守起步；② 3 已解决主要等待：7 家 × 10s 超时最坏 70s 串行 → 3 并发约 1/3，5 相对 3 再省约三成但把 registry 压力推入未知区；③ 并发安全与取值无关：checkPhone 只写版本串不读 receipt（:978–986），在途调用各持各的 reader 对象（§2.5），落盘单次全量写（:995），逐家 try/catch（:987–992）搬进 worker 即等价 allSettled 语义。所以取值只关乎“registry 礼貌”，取最小值最稳。
- 落地清单：① for-await 改受控池（手写约 20 行，不新增依赖——新增依赖违反 #81 地图 outOfScope）；② 保留“知识落盘失败不挡回包”（:996–998）；③ 单测用假 transport 断言最大在飞数 ≤ 3、乱序完成行版本正确、单家失败不染他家；④ 常量命名 `BATCH_CHECK_CONCURRENCY = 3` 并注释“待实测上调”。
- 风险与回退：registry 侧未知限流（[雾-2]）；回退线是并发度降到 1 即退回现状串行查，装阶段不受影响。4/5 待 §6 实测数据，另起调参票。

### 4.3 单例 sharedReader 二选一 → 选 A 做，不做 B

- 做 A（消费前重查）：提交时无 receipt 或遇 check-expired，当场重查一次再提交（即 §4.1 落地清单②）。理由：① 不碰 host.ts:201–202/396/538–570 单例纪律，而该纪律被规格 #591 第 6 条冻结（:193–194 注释，复位函数 :1019–1022 同条）；② defaultInstall :534–541 已有半条路，A 是顺势补全；③ 与 ADR-0003“检查结果不参与安装决策、一轮开始仍实时重查”同构。最小改动符合 #81 地图“高优直接修、低优只记清单”的执行约定。
- 不做 B（Map<key,receipt> + 按目标常驻 reader，列为可选跟进）：B 的唯一实在好处是省 N 次 check 联网（A 下约 2N 次，B 下 N 次）；但 check 只是轻量 registry GET，不省串行安装时间（硬约束 [约-1]），却要改 getSharedReader 单槽语义、处理常驻 reader 的内存与范围失效，触冻结、回归面大。**不断言 B 的收益值得触冻结——假设待澄清，需实测数据支撑才重开**。
- 落地清单（A）：改 defaultInstall（:534–556）一处：check-expired → rt.receipt = null → 重查一次 → 再提交一次；仍失败按 :555 落 failed；update-busy→queued 分支（:550–554）不动。单测断言“预查过期→自动重查→继续”（#70 验收 3）。
- 风险（已知成本）：① 每家多一次 check（约 2N 次联网）；② queue 占位抖动：runInstall 先占位（host.ts:967–969）、非 update-busy 失败撤占位（:982–988），check-expired 走撤占位分支，面板 queue 位置可能闪一下。实测若扰民，实现票内改“装前先重查”（跳过第一次注定过期的提交），不另起决策票。

### 4.4 ADR-0004 → 写

- 理由：① [待-1] 明问“是否写 ADR-0004”；② ADR 目录只有 0001–0003（glob 实测），0004 空缺；③ §2.6 判定：驱动语义变更触碰 0003 反向范围，需新 ADR 钉死“什么变了、什么没变”，否则后人误读 Archive；④ 按 docs/maintainers.md:114–118 改动纪律，涉冻结语义的变更须留决策痕。
- 落地清单：新建 docs/adr/0004-batch-two-phase-check-then-install.md，标题“4. 批量两段式：先全查再串行装”；骨架：背景（#70 + 本研究链接）→ 决策（做两段式、并发 3、消费前重查 A 案、TTL 仅展示）→ 不变量重申（一次只推一家、queue.json 仍单份共享单队列串行、selfKey 最后、每步落盘、失败继续/停下、跨 scope 拒绝、面板忙守卫）→ 反向范围（不做常驻 reader B 案、不调 TTL、不改四电话形状与快照六字段——呼应 #81 地图 outOfScope）→ 观测附录（并发实测、重查计数）→ 回退线（并发降 1）。状态 proposed，用户拍板后转 accepted。
- 风险：无代码风险；唯一风险是不写——后人无法区分 0003 与新驱动。本项成本约半小时，必做。

## 5. 分步落地清单（实现另起票可直接拆票，TDD）

门禁口径见 docs/maintainers.md:64–94（`node --test tests/*.test.mjs` 全 0；改文案必跑 `npm run gate:bilingual`）。

- 票 A（check 并发 3）：checkPhone 抽 checkAll + 受控池（§4.2 落地清单）；单测：假 transport 断言全查写 inventory、不建会话、逐家错误隔离、落盘失败不挡回包、最大在飞 ≤ 3。
- 票 B（两段式驱动 + 装前重查）：installPhone 两段化 + defaultInstall check-expired 重查一次（§4.1/§4.3 落地清单）；复用 driveLocked/runBatch，settleInstall 不动；单测：假 transport 断言“先 N 个 check 再 N 个 install”顺序、重启恢复（resumeBatchSession 终态不重装）、过期重查继续（#70 验收 1–3）。
- 票 C（ADR-0004）：按 §4.4 落盘，状态 proposed → accepted，引用本文件与 #70 对齐成果。
- 票 D（可选跟进）：常驻 Map + 按目标常驻 reader，仅当实测证明 A 案联网/抖动不可接受才启动；先走 #591 破冰（复用键冻结），不与 A–C 并行。
- 每票守纪律：只 git add 声明路径；不新增依赖与子路径（#81 outOfScope）；改包跑全量门禁。

## 6. 雾区与待测数据（不猜，列出来等拍板/实测）

- [雾-1] 生产 N 家真实耗时分布、超 TTL 多少，无实测——并发 5 不可一次定；T1/T2 落地时顺手打点（每家 check/install 耗时）。
- [雾-2] 并行查对 registry 压力与单槽缓存收益/风险边界不清——先取 3 留观测口（每家 check 耗时 + 重查计数进 ADR-0004 附录）。
- [雾-3] 跳过版本 / selfKey 最后 / 失败继续与预查队列交互的边角——票 B 单测覆盖 skipped + selfKey + stopOnFailure=true 三组合。
- [雾-4] 非批量插件同抢一把锁时批量预占 N 席的公平性——queue.json 仍单份共享（ADR-0003 §4），两段式不改变该语义但须在 ADR-0004 重申；#86 输入未含该场景，不展开。
- [雾-5] 落盘颗粒度已澄清：成果归 ticket、不写 map 正文——本文件归 docs/research/，结论摘要回 #86 进度区（由 Lead 收尾）。
- U6（新增·假设待澄清）：并发 3 在 Windows 真机 + 官方源限流下的实际表现无数据；若 registry 429，allSettled 会把 429 记成行级 check-failed——是否需要退避重试，本票不断言，待实测。
- U7（新增·一手有据）：A 案 queue 占位抖动（host.ts:967–969 占位 / :982–988 撤占位）在批量路径的可感知程度无面板实测；T2 若闪位扰民，改“装前先重查”，不另起决策。

## 7. 来源索引（每个事实的主人）

- #86 Question/验收：deck_issue_get #86（open，父票 81，labels wayfinder:research/task）。
- #81 地图 frontier（8 子票、#86 无阻塞边、可接）：deck_map_snapshot key=81。
- #70 想法/方案/改动清单/验收/对齐成果（[目-1]–[目-4]、[约-1]–[约-4]、[决-1]–[决-10]、[待-1]–[待-5]、[雾-1]–[雾-5]、[遗-1]–[遗-6]）：deck_issue_get #70 全文（用户已认可、无修正）。
- 交错驱动：src/host-batch.ts:878–928（driveLocked，:897–912 maxSteps:1）、src/batch-run.ts:82–172（:95–99 每步落盘，:112–114 ready 复用钩子，:118–168 查装同轮，:152–157 queued 整轮停）、src/host-batch.ts:505–517（settleInstall）、:496–502（installOutcomeOf）、:29–31（单槽第一性注释）。
- 建/续会话与忙时入队：src/host-batch.ts:1029–1068（installPhone）、:1004–1027（joinWhileBusy）、:860–871（resetForRetry）、:318–341（addKeys）、:902–908（视图合并落盘）。
- 串行查只写知识：src/host-batch.ts:957–1001（checkPhone，:970–972 串行，:978–986 写版本串，:987–992 逐家容错，:995 落盘，:1000 账本不动）。
- batch.json durable：src/batch.ts:63–77（BatchSession）、:122–125（幂等编号）、:109–120（orderTargets）、:232–239（nextBatchKey）、:293–304（resumeBatchSession）；src/host-batch.ts:671–696（ownerPorts/readSession/saveSession）。
- queue.json 锁：src/queue.ts:1–26（归属/TTL）、:46–50（形状）、:110–146（过期/占位）、:230–254（位置/队首）；src/host.ts:440–455（组合锁）、:967–974（占位 + 公平门）、:979–988（失败撤占位）。
- TTL 与冻结：src/config.ts:39–45（#591 第 5 条冻结语 + 三个值）；src/service.ts:548（expiresAt）、:613（形状检查）、:617（幂等返旧）、:618–619（busy）、:621（凭证三条件）、:624/:640（installationKey）、:637–638（装前二次全文比对）。
- 单例挤占：src/host.ts:193–202（宣言 + 单变量）、:359（getSharedReader）、:395–396（复用键 + 命中）、:538–570（重建覆盖）、:901–902/:913–914/:938–941（三电话现取）、:1019–1022（复位函数，#591 第 6 条）；src/service.ts:433–434（checked 纯内存）、:544–551/:565–569（发凭证）；src/host-batch.ts:415/:491（rt.receipt 隔离）、:534–556（defaultInstall）、:781–783（推进中缓存隔离）。
- 面板忙守卫：src/panel-batch.ts:25–26；回包形状 src/host-batch.ts:814–828（table：rows + progress + session + inventory + prefs）。
- ADR-0003：docs/adr/0003-batch-knowledge-vs-round.md（§1–§4、不变量 Archive、反向范围）。
- 门禁/纪律：docs/maintainers.md:64–94（门禁 + 双语门禁）、:114–118（冻结/破冰/提交）；CONTEXT.md（诊断术语边界，本研究未引用未定术语）；ADR 目录 glob（0001–0003 已占，0004 空缺）。

## 8. 给 #86 的收尾建议（Lead 执行，不在本文件决策）

- 本票真实状态：研究完成、待用户终裁（做/不做 + 何时动手），实现按 §5 拆票（A/B/C 必做，D 可选）。
- 本研究未改任何 issue 正文、未关闭任何票（Lead 收尾时：结论摘要回 #86 进度区；若用户拍“做”，#70 从 needs-triage 转入落地（[待-4]），ADR-0004 置 proposed；若拍“不做”，记录不做理由并关闭 #86，#70 保留为想法票维持 open + needs-triage，不删）。
