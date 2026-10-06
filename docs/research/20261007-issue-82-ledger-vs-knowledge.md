# #82 总账口径与自动查语义：ledger 只看相位 vs 行看知识的矛盾 — 研究报告

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-07（Asia/Shanghai） |
| 触发 | 父图 #81《批量更新全栈深查》决策依赖：#82 是 frontier，阻塞 #83 与 #85（https://github.com/FeatherHunter/dsh-plugin-update/issues/81 ；https://github.com/FeatherHunter/dsh-plugin-update/issues/82） |
| 方法 | 一手来源逐条核对行号并引用；二手转述标“转述自 triage”并回查一手；拿不准标“未证实”。只读研究，不改 src、不改票、不提交 |
| 工作区 | D:\\dsh-plugin\\dsh-plugin-update |
| 一手来源声明 | src/panel-batch.ts、src/host-batch.ts、src/store.ts、src/bilingual.ts、docs/adr/0003-batch-knowledge-vs-round.md（33 行）、CONTEXT.md、tests/panel-batch.test.mjs、tests/panel-auto-check.test.mjs、#73/#59/#81 票正文与评论 |

> 结论先行：采用推荐 A——无轮次时总账吃知识（pending 行若知识有新版计入可更新，hint 优先 updatable，ledger 同步）；有未做完轮次仍走执行态（inRound 不动）；安装决策仍以会话 targetVersion 为准、知识仅展示。batchCheck 永不建会话/轮次，只重写 inventory；checkOnOpen 缺省 true，三层为用户偏好 prefs.json ＞ 集成方选项 ＞ 缺省，60s 节流去重。最小改法是给 batchLedgerCounts 透传知识并复用现有 batch.hint.updatable / batch.summary.updatable 文案，加 4 例单测。详见 §6–§7。

## 1. 研究问题与决策依赖

- #82 原文问题（https://github.com/FeatherHunter/dsh-plugin-update/issues/82）：总账/提示只看会话相位（pending 即“还没查过”），行在无轮次时优先看知识（inventory latestVersion），同一屏两种事实源（#73 现形、#59 Q1 同源）。要定 ledger 是否吃知识、batchCheck 是否建会话/轮次、checkOnOpen 缺省语义与文案优先级。验收为唯一口径 + 最小改法；高优矛盾修 + 单测（pending + 知识有新版不再矛盾）。
- 决策依赖（https://github.com/FeatherHunter/dsh-plugin-update/issues/81）：#81 Destination 定为“批量更新全栈深度调查并修高优 Bug”，Notes 限定领域含 panel-batch 总账/明细/详情/宏行内动作/偏好/生命周期与 host-batch/batch-run/batch/queue 等（src/panel-batch.ts:1-34 头部归属与契约即此领域的面板侧表达）。
- #81 地图快照证实 #82 是 frontier，阻塞 #83 与 #85：deck_map_snapshot 回“子票 8 张、未关 8、可接 3、被阻塞 5”，blockedByKeys 中 83→82、85→82（工具回包实测 2026-10-07）；#82 票 relations 同样回 blocking ["85","83"]（https://github.com/FeatherHunter/dsh-plugin-update/issues/82）。结论决定后续两票修法：#83 明细行版本与对齐、#85 续跑/取消/关闭契约都依赖总账口径先定。
- #73 是现形 bug（https://github.com/FeatherHunter/dsh-plugin-update/issues/73）：正文“实际”节 7 家 pending 但行显示 0.3.44→0.3.46、总账 hint“还没查过”，底部计数“7 家待查”（票正文实测）。转述自 #73 triage 的 R1–R4（双口径/自动查只写知识/文案优先级/新鲜度不可见）已回查一手，见 §2–§5；Agent Brief 推荐 A（知识有新版计入可更新）见 #73 评论区 triage 记录；Q1/Q2 在本次 2026-10-07 读回中仍为非阻塞未答（Q2 为空），不作已拍板引用，本报告按推荐 A 推进，若终裁推翻仅改计数映射。
- #59 是同源（https://github.com/FeatherHunter/dsh-plugin-update/issues/59）：Q1 空账本 check 无效 + 行文案矛盾（票正文“三问” + triage D1–D5）；已定稿 checkOnOpen 缺省开、Q2=A 旧账本不接管（#59 正文进度节 2026-10-06 Q回复与定稿行，非评论时间戳引用）。转述自 #59 triage 的 D1–D5 已回查 ADR 与代码，见 §4。
- ADR-0003 已采纳（docs/adr/0003-batch-knowledge-vs-round.md:1-5，状态已采纳、日期 2026-10-06、关联 #59）：知识 inventory.json 只展示不参与安装决策、无轮次行待查按知识展示、打开即查默认开 + prefs.json、自动续与显式并存（docs/adr/0003-batch-knowledge-vs-round.md:15-25）。全文 33 行（实测 totalLines=33）。
- #81 OutOfScope 约束本票：四电话形状与快照六字段不做破坏性变更、不新增依赖与子路径、不抢 #51/#75 终裁（https://github.com/FeatherHunter/dsh-plugin-update/issues/81 正文 Out of scope 节）。故 §6–§7 只修渲染/语义，不改形状。

## 2. 总账口径现状（ledger 只看相位）

- batchLedgerCounts 只吃 rows phase，不收 inventory（src/panel-batch.ts:233-255）。函数签名 batchLedgerCounts(rows)（src/panel-batch.ts:233），循环内按 asBatchPhase(row.phase) 落七档（src/panel-batch.ts:243-253），其中 pending/checking 归 pending 档（src/panel-batch.ts:249），ready 归 updatable（src/panel-batch.ts:248），注释明示“从行上数分类账”“其余按相位落档”（src/panel-batch.ts:228-229）。全库无知识感知的 ledger 实现——转述自 #73 triage R1，已回查证实：batchLedgerCounts 仅 panel-batch 一处定义 + tests/panel-batch.test.mjs:274 一处调用。
- 忙失败占位例外是唯一非相位分支：phase=failed 但 error=update-busy 翻回可更新（src/panel-batch.ts:230-231 注释，src/panel-batch.ts:245 代码 isQueueBusyRow）。与知识无关。
- batchLedgerText 只按 counts 渲染分类总账，顺序固定可更新·安装中·待查·待重启·失败·已跳过·已最新，零档不占位（src/panel-batch.ts:257-269，顺序见 src/panel-batch.ts:261-267）。空表回 batch.summary.empty（src/panel-batch.ts:268）。
- renderBatchPanelHTML 计数调用处不传 inventory（src/panel-batch.ts:529-631 范围；关键行 src/panel-batch.ts:539 counts=batchLedgerCounts(rows)）。同一函数内 inventory 只用于行知识注入（src/panel-batch.ts:621），不进总账。这是同一屏两种事实源的构造点。
- 表下分类总账直接用该 counts（src/panel-batch.ts:628-631）。顶部一句话总账同样用该 counts（src/panel-batch.ts:579-582 summary=batchSummaryText(counts,…)）。
- 现状后果：空会话 + 7 行 pending 时 counts={updatable:0,pending:7}，顶部 hint 必为 pending（见 §5），与行知识分支（§3）打架。转述自 #73 triage“实跑复现 LEDGER pending:7 vs ROW 7 处有新版”已回查代码成立；实跑 HTML 细节为转述，未在本轮重跑，标转述。

## 3. 行知识分支现状（无轮次优先知识）

- knowledgeEntryOf 只从 inventory.entries 取该家条目并归一化（src/panel-batch.ts:292-307），字段为 lastCheckedAt/installedVersion/latestVersion/canInstall/error（src/panel-batch.ts:283-290 接口定义，注释“只做展示，不参与安装决策” src/panel-batch.ts:283）。
- batchRowKnowledgeText 是无轮次知识行（src/panel-batch.ts:391-409；注释“无轮次时的知识行（#59 D2）” src/panel-batch.ts:392）。守卫 pending + 有 entry 才展示（src/panel-batch.ts:396）；分支为 error→batch.row.failed（src/panel-batch.ts:397）、latest≠installed→batch.row.update（src/panel-batch.ts:398-400）、latest=installed→batch.row.current（src/panel-batch.ts:401-403）、仅 latest→batch.row.update（src/panel-batch.ts:404-406）、lastCheckedAt>0→batch.row.current（src/panel-batch.ts:407）、否则 batch.row.never（src/panel-batch.ts:408）。无知识回 null，调用方回退旧 pending 文案（注释 src/panel-batch.ts:393）。
- batchRowPendingStatus 是无轮次 pending 行状态词四态（src/panel-batch.ts:455-466；注释“有新版/已是最新/还没查过/查失败” src/panel-batch.ts:456）。逻辑为先走 batchRowKnowledgeText（src/panel-batch.ts:462），无 knowledge 回 batch.row.never“还没查过”（src/panel-batch.ts:464）。
- 知识注入点：仅 pending 且 !inRound 才取知识（src/panel-batch.ts:621 knowledge: asBatchPhase(row.phase)==='pending' && !inRound ? knowledgeEntryOf(input.inventory,row.key) : null）。inRound 判定为 session.entries 中该 key 的 entryPhase 非终态（src/panel-batch.ts:592-602 roundEntryPhase，src/panel-batch.ts:610-611 inRound）。
- rowSetHTML 行状态三岔（src/panel-batch.ts:774-785）：queued→排队词（src/panel-batch.ts:781-782）；inRound→batchRowKnowledgeText ?? batchRowStatus（src/panel-batch.ts:783-784，注释“有轮次未做完仍走执行态” src/panel-batch.ts:458）；非 inRound→batchRowPendingStatus ?? batchRowStatus（src/panel-batch.ts:785）。版本列同样知识感知但会话目标优先（src/panel-batch.ts:780 versionHTML，细节见 batchRowVersionParts src/panel-batch.ts:424-439：sessionTarget 优先，见 §6）。
- 现状后果：空会话（session 无 entries → inRound=false）+ inventory 有 0.3.44→0.3.46 时，行走知识分支显示“有新版”，而总账仍 pending。#73 截图即此态（https://github.com/FeatherHunter/dsh-plugin-update/issues/73 正文“实际”节）。

## 4. 自动查语义（batchCheck 只写知识不建轮次 + checkOnOpen 缺省 true 三层）

- batchCheck 契约：查 N 家、重写知识账本后同形状（账本不动）（src/host-batch.ts:9-16，关键行 src/host-batch.ts:10）。同文件明确建/续会话的是 batchInstall（给 keys 只推几家），batchResume 读盘续推，batchCancel 只清会话知识不动（src/host-batch.ts:11-16）。
- checkPhone 实现（src/host-batch.ts:957-1001）：先读会话（src/host-batch.ts:960），仅当 !driveActive 才重写 inventory（src/host-batch.ts:961 分支；driveActive 定义 src/host-batch.ts:678，忙时含义见 src/host-batch.ts:932-937、1035-1037）。entries 逐家按 outcome 落盘：update→latestVersion=outcome.version（src/host-batch.ts:978-979）、current→latest=installed（src/host-batch.ts:980-981）、skipped→canInstall=false（src/host-batch.ts:982-983）、failed→记 error（src/host-batch.ts:984-986），异常同样记 error（src/host-batch.ts:987-992）；落盘 inventory.json（src/host-batch.ts:994-998，注释“知识落盘失败不挡检查回包（只做展示）” src/host-batch.ts:997）；最后 return table(session,false)（src/host-batch.ts:1000），传入的是开头读到的同一 session，未新建亦未改写 batch.json。故 batchCheck 永不建会话/轮次。忙时（driveActive=true）连 inventory 也不写，直接回旧表——此为“未证实对 UI 的影响”，因忙时面板置灰且行走执行态，未在本轮实测。
- table 回全表形状 rows+session+progress+inventory+prefs（src/host-batch.ts:814-829；回包行 src/host-batch.ts:828）。buildRows 相位来自账本、无 entry 即 pending（src/host-batch.ts:793），快照来自单插件电话（src/host-batch.ts:783-784，非驱动中才刷新）。这解释了为何 check 后 rows 仍 pending：知识进了 inventory，rows 相位不动。
- 存储：INVENTORY_FILE='inventory.json'（src/store.ts:479），PREFS_FILE='prefs.json'（src/store.ts:480），属主隔离注释“知识、一轮、属主各回各家”（src/store.ts:476-477），路径 batchPathsForOwner 按 owner 分目录（src/store.ts:498-505），BatchPrefs 仅 checkOnOpen 布尔（src/store.ts:562-575，归一化 src/store.ts:566-575）。
- checkOnOpen 缺省 true 三层（用户偏好＞集成方选项＞缺省）：
  - 缺省 true：BatchPanelOptions.checkOnOpen 注释“缺省 true”（src/panel-batch.ts:131-135），选项解析 !==false 即 true（src/panel-batch.ts:1401）。
  - 用户偏好优先：checkOnOpenEffective 先读 lastPrefs.checkOnOpen（src/panel-batch.ts:1719-1725），渲染侧 prefs null→null 否则 false 才 false（src/panel-batch.ts:590），底部勾选按钮走 batchPrefs/Save（src/panel-batch.ts:659-663 UI，src/panel-batch.ts:1782-1783 保存）。
  - 60s 节流去重：在途/刷新抑制 + stale 判定 lastCheckedAt≤0 或 now-lastCheckedAt≥60000（src/panel-batch.ts:1991-1992），hasUnfinishedRows 时不自动查（src/panel-batch.ts:1990），autoCheckDone 每挂载一次（src/panel-batch.ts:1987-1988），生效门 src/panel-batch.ts:1989 if(!checkOnOpenEffective())return。inventory.updatedAt 回填 lastCheckedAt（src/panel-batch.ts:1647-1651），lastCheckedAt 初始化 0（src/panel-batch.ts:1406）。
  - ADR 背书：面板偏好 prefs.json（用户偏好＞集成方选项＞缺省），60 秒节流 + 在途抑制 + 入口预查共用时间戳去重（一击只查一次）；自动查失败只标行不弹红条（docs/adr/0003-batch-knowledge-vs-round.md:23-25）。
- #59 定稿回查：Q1 认可缺省开、Q2=A 旧账本不接管、Q3 自动续与显式并存（https://github.com/FeatherHunter/dsh-plugin-update/issues/59 Brief v3 评论）。本节仅述自动查；自动续细节归 #85，本票不裁（#81 OutOfScope 约束）。
- tests/panel-auto-check.test.mjs 非本票直接证据：文件头明示“#48：进入面板自动查一次新版”且测的是单插件 mountUpdatePanel/pendingAutoCheck（tests/panel-auto-check.test.mjs:1-9），非批量 checkOnOpen。故批量自动查以 src/panel-batch.ts:1987-2008 为准，测试分组为“未证实”（批量侧尚无 checkOnOpen 分组）。

## 5. 文案优先级（batchSummaryText 顺序 + 双语键）

- batchSummaryText 优先级（src/panel-batch.ts:686-711，注释“一句话总账：先答有没有事” src/panel-batch.ts:686）：error（src/panel-batch.ts:696）＞ empty（src/panel-batch.ts:697）＞ installing（src/panel-batch.ts:698-704）＞ failed（src/panel-batch.ts:705）＞ updatable（src/panel-batch.ts:706-707）＞ restart（src/panel-batch.ts:708）＞ pending（src/panel-batch.ts:709）＞ done（src/panel-batch.ts:710）。故只要 updatable>0 即显示可更新，否则 pending 显示“还没查过”。当前 knowledge-pending 永不计入 updatable，所以空会话 pending hint 必赢——转述自 #73 triage R3（约 60% 规格选择非笔误），已回查代码成立。
- 双语键（src/bilingual.ts）：
  - hint 键类型 union（src/bilingual.ts:258-266）：batch.hint.error/empty/installing-queueable/installing-auto/failed/updatable/restart/pending/done。
  - summary 键类型 union（src/bilingual.ts:242-249）：batch.summary.updatable/installing/pending/restart/failed/skipped/settled/empty。
  - 行键类型 union（src/bilingual.ts:231-234）：batch.row.update/current/never/failed；轮次标记 batch.row.unfinished-tag（src/bilingual.ts:241）。
  - 中文文案：batch.hint.updatable“{n} 家可更新；点全部更新一次安装完，也可以逐家点安装这家。”（src/bilingual.ts:590）；batch.hint.pending“{n} 家还没查过；点检查更新查一轮。”（src/bilingual.ts:592）；batch.summary.updatable“{n} 家可更新”（src/bilingual.ts:569）；batch.summary.pending“{n} 家待查”（src/bilingual.ts:571）；batch.row.update“有新版 {version}”（src/bilingual.ts:558）；batch.row.current“已是最新，不用动”（src/bilingual.ts:559）；batch.row.never“还没查过”（src/bilingual.ts:560）；batch.row.failed“这次没查到”（src/bilingual.ts:561）。均为 draft（src/bilingual.ts:558-593 同列 draft:true）。
- 印章 tone 同样只看 counts：failed 红、installing/restart 黄、updatable 绿（src/panel-batch.ts:713-720）。ledger 吃知识后 tone 会同步变绿，此为预期副作用，需在 #83/#85 联调时声明。
- CONTEXT.md 无文案口径，仅收诊断术语（错误码/人话格/宿主原话）与待规格补入声明（CONTEXT.md:1-21）。故文案终裁以 bilingual.ts + ADR 为准。

## 6. 唯一口径提案（推荐 A：无轮次时知识有新版计入可更新）

- 推荐 A（一句话）：无轮次（!inRound）pending 行若知识判定为“有新版”，总账将其计入 updatable 而非 pending；hint 优先 updatable，ledger 同步；有轮次未做完仍走执行态（inRound 语义不动）；安装决策仍以会话 targetVersion 为准，知识仅展示。
- 与 ADR 一致：知识只展示不决策（docs/adr/0003-batch-knowledge-vs-round.md:15），行无轮次按知识展示四态（docs/adr/0003-batch-knowledge-vs-round.md:21），有没做完一轮按执行态 + “上一批没做完”标记不改写下一步（docs/adr/0003-batch-knowledge-vs-round.md:21）。#73 拍板 Q1=A（顶部看记忆）与此一致（https://github.com/FeatherHunter/dsh-plugin-update/issues/73 拍板评论）。
- 否决 B（行改回一律 pending）：等于回滚 #71 行知识展示（转述自 #73 triage Q1 重问评论，已回查 src/panel-batch.ts:392-409 行知识分支确为 #59 D2/#71 Q3 资产），不推荐。
- 口径细则：
  1. ledger 吃知识的条件：row.phase=pending（checking 待定，见 §8）且 !inRound（src/panel-batch.ts:610-611、621 同条件）且 knowledgeEntryOf 非空且 batchRowKnowledgeText 判定为 update 分支（src/panel-batch.ts:398-400 或 404-406）。仅此条件计 updatable；其余 pending 仍 pending。
  2. hint 优先 updatable：复用现有 batchSummaryText 顺序（src/panel-batch.ts:706-709），无需改顺序——只要 counts.updatable>0 即自动优先显示 batch.hint.updatable（src/bilingual.ts:590）。ledger 文案复用 batch.summary.updatable（src/bilingual.ts:569）。
  3. 有轮次未做完不动：inRound 行不吃知识进总账，仍按旧相位计数（执行态），行展示走 rowSetHTML inRound 分支（src/panel-batch.ts:783-784）。
  4. 安装决策不动：batchRowVersionParts 会话目标优先（src/panel-batch.ts:424-431），无目标才看知识 latest（src/panel-batch.ts:432-439）；ADR 不变量“一轮开始仍实时重查”（docs/adr/0003-batch-knowledge-vs-round.md:29）。总账变绿不等于可直接装，仍须走 batchInstall 建会话。
  5. batchCheck 语义不动：永不建会话/轮次（§4），checkOnOpen 缺省 true 三层不动（§4）。本票只修总账口径，不改自动查触发。
- 对 #83/#85 的传导（frontier 义务）：#83 行版本对齐需沿用“会话目标优先、知识仅补 latest”；#85 续跑/取消判据须用“盘上有未终态行”而非 ledger pending 数，避免把知识型 updatable 误当可续轮次。以上为本票结论对后续修法的约束，非本票实施。

## 7. 最小改法（改动点 + 测试 + 门禁）

- 改动点（均在 src/panel-batch.ts，不改形状、不改 host、不改 bilingual 新键）：
  1. batchLedgerCounts 知识感知（src/panel-batch.ts:233-255 现状）：新增可选第二参（inventory 或预计算 knowledge map），pending 分支内若满足 §6 条件则计 updatable。签名兼容旧调用（tests/panel-batch.test.mjs:274 batchLedgerCounts(rows) 须仍过）。
  2. render 调用处（src/panel-batch.ts:539）：counts=batchLedgerCounts(rows, input.inventory) 或透传按行算好的 knowledgeEntryOf 表；行循环的 knowledge 计算（src/panel-batch.ts:621）应与计数共用同一判定，避免两处分叉。
  3. 文案零新增：复用 batch.hint.updatable（src/bilingual.ts:590）与 batch.summary.updatable（src/bilingual.ts:569）；batchSummaryText 顺序不动（src/panel-batch.ts:706-709）。印章 tone 自动跟随（src/panel-batch.ts:713-720），需在 PR 描述声明。
- 测试（新增单测文件，建议 tests/issue-82-ledger-knowledge.test.mjs，纯函数 + render 断言；转述自 #73 Agent Brief 的测试清单，已回查 §2–§3 成立）：
  1. 空会话 + 知识有新版 → updatable=N、pending=0、hint 为 batch.hint.updatable、行仍“有新版”（#82 验收：pending+知识有新版不再矛盾）。
  2. 空会话 + 知识已最新（latest=installed）→ settled/行“已是最新”，hint 不报 pending（batchRowKnowledgeText src/panel-batch.ts:401-403 + batchRowPendingStatus src/panel-batch.ts:460-466）。
  3. 空会话 + 无知识（inventory 缺失/无条目）→ pending/行“还没查过”（src/panel-batch.ts:464 batch.row.never）。
  4. 有轮次 inRound（session.entries 该 key 非终态）→ 仍执行态，总账不吃知识（src/panel-batch.ts:610-611、783-784）。
  5. 回归：tests/panel-batch.test.mjs:260-285 旧断言（3 可更新/1 安装中/1 待重启/1 失败、七档之和=行数、零档不占位）仍绿。
- 门禁：npm test + gate:bilingual（转述自 #73 Agent Brief，已回查 #59 实施记录“全量 752 + 双语门禁过”为历史事实，非本票承诺；本票门禁以现仓为准）。bilingual 新增键为零，故门禁应零增量。
- 非目标（#81 OutOfScope 回查）：不改四电话形状与快照六字段（https://github.com/FeatherHunter/dsh-plugin-update/issues/81），不展示 lastCheckedAt（§8），不做 TTL/跨方共享/回滚。

## 8. 风险与未证实（置信度）

- checking 相位是否同 pending 吃知识：未证实。batchLedgerCounts 把 checking 归 pending（src/panel-batch.ts:249），但 batchRowKnowledgeText/batchRowPendingStatus 守卫仅 pending（src/panel-batch.ts:396、461）。checking 行极少见（在途查），提案暂限定 pending；checking 归属待 #87（宏动作与稳定性）定。置信度低。
- lastCheckedAt 不展示：ADR 反向范围无 TTL/过期（docs/adr/0003-batch-knowledge-vs-round.md:31-33）；#73 Q2 本次读回未答，按最小修暂不展示（https://github.com/FeatherHunter/dsh-plugin-update/issues/73）。7 家齐 0.3.44→0.3.46 是否残留知识无法自证——转述自 #73 triage R4（约 40%），回查证实 lastCheckedAt 确未进 UI（rowSetHTML 无时间分支 src/panel-batch.ts:774-785；版本/状态均无时间）。风险接受：下次打开自愈（docs/adr/0003-batch-knowledge-vs-round.md:25 去重语义）。置信度低，不阻塞。
- 跨集成方账本：store 已按 owner 分目录（src/store.ts:498-505），旧无属主不读写（src/host-batch.ts:671-672 注释）。但同前缀两家仍互撞（转述自 #59 D1/A5，已回查 src/store.ts:484-489 前缀即属主 + #59 评论 A5）。本票 ledger 改法按单属主 inventory 计，不放大互撞亦不修复，需 #81 Fog“跨集成方账本互撞是否另起图”另裁。置信度中。
- stalled/控制区判据：本票未重核 panel-batch 内 unfinishedCount/hasUnfinishedRows 实现行号（未在必查行号清单内），故“控制区是否会被知识型 updatable 误触发”为未证实。提案已约束 #85 用“盘上未终态”而非 ledger 数，待 #85 实查。置信度中。
- 忙时 checkPhone 跳过 inventory 写（src/host-batch.ts:961 if(!driveActive)）：忙时自动查与手动查均被抑制（src/panel-batch.ts:1991-1992 在途抑制），故影响面小；但“忙时点检查更新回旧表”是否为预期，标未证实，待 #87 定。
- canInstall=false 但 latest≠installed 的知识行：batchRowKnowledgeText 不看 canInstall（src/panel-batch.ts:395-409 全函数无 canInstall 分支），一律按版本差显示有新版。ledger 若同步计 updatable，是否高估“可装”——按 ADR“知识不决策”原则，安装时仍实时重查（docs/adr/0003-batch-knowledge-vs-round.md:29），风险可接受；是否要在 ledger 层加 canInstall 过滤，待 #83 定。置信度中。

## 9. 复跑步骤（纯函数最小复现三步，无需 7 家）

> 转述自 #73 triage 最小复现，已回查 §2–§3 代码成立；步骤中 render 入参形状以 src/panel-batch.ts:529-631 为准。

1. 构造 1 行（或 7 行）BatchRowView：{key:'a', phase:'pending', targetVersion:null, restartRequired:false, error:null, snapshot:{installedVersion:'0.3.44'}}，session 为空会话 {entries:[]}（buildRows 无 entry 即 pending src/host-batch.ts:793；inRound 判定 src/panel-batch.ts:610-611 为 false）。
2. 构造 inventory：{entries:{a:{lastCheckedAt:1, installedVersion:'0.3.44', latestVersion:'0.3.46', canInstall:true, error:null}}}（knowledgeEntryOf 归一化 src/panel-batch.ts:292-307）。
3. 调用 renderBatchPanelHTML({rows, session:空会话, inventory, lang:'zh'})：现状顶部含 batch.hint.pending“还没查过”（src/panel-batch.ts:709 + src/bilingual.ts:592）且 ledger 含 batch.summary.pending（src/panel-batch.ts:263 + src/bilingual.ts:571），行含 batch.row.update“有新版 0.3.46”（src/panel-batch.ts:398-400 + src/bilingual.ts:558）——即矛盾；修后顶部/ledger 应为 updatable（src/bilingual.ts:590/569），行不变。
