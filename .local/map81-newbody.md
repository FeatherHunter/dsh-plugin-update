<!-- DSH-IDEMPOTENCY-KEY: deck-plan-batch-deep-dive-20261007-map -->
## Destination

批量更新全栈深度调查并修高优Bug：总账/明细/详情/动作/偏好/生命周期与内部队列全覆盖（含单面板+入口一致性），输出分级清单并落地高优修复（TDD+门禁全绿）。

## Notes

领域：dsh-plugin-update 全栈（批量面板 panel-batch 总账+明细+详情+宏/行内动作+偏好+生命周期；内部 host-batch/batch-run/batch/queue/service/host 队列账本凭证锁；单面板 panel 内核复用与 entry/entry-batch 聚合）。每次先读 CONTEXT.md、docs/adr/（0001 脱敏边界、0003 知识vs轮次等）、src/panel-batch.ts、src/panel.ts、src/host-batch.ts、src/batch.ts、src/batch-run.ts、src/queue.ts、src/entry-batch.ts、src/entry.ts。中文讨论。TDD。面板只渲染不推导；脱敏是构造属性；缺省即省略但须说人话。

执行约定（本次覆盖 wayfinder 默认 Plan-dont-do）：本图携带执行——调查结论中高优Bug直接在子票内修+测（单测+全量门禁+bilingual gate），低优只记清单不修。

技能：每会话按需 consult grilling、domain-modeling、diagnosing-bugs、research、prototype；事实自己查代码/单测，不问用户要可查事实。

输入复用：存量 #71/#73/#74/#59/#68/#70 只作输入引用、不关闭不替代，新票链接它们，结论可反哺。

矩阵：embedded/dialog × default/dark × 中英（bilingual 门禁为准，不另扩全矩阵验收）。

## Decisions so far

<!-- 索引 — 每条已关闭票一行：只给结论 gist，细节看链接 -->

- [总账口径与自动查语义：ledger只看相位 vs 行看知识的矛盾](https://github.com/FeatherHunter/dsh-plugin-update/issues/82)：无轮次总账吃知识推荐A定稿（有新版进可更新/已最新进settled/失败进failed/无知识仍待查），实施载体为 #73 commit 38898f8，本票验证关闭（全量806+双语绿），#83/#85解阻。

## Not yet specified

- 各场景修法终裁细节（随 frontier 推进逐个定，不预切片）
- 低优清单是否另起规格图（待高优落地后看量级再定）
- 跨集成方账本互撞（batch.json 按 homeDir+profileDir 派生）是否在本图修还是另起图

## Out of scope

- 四电话形状与快照六字段的破坏性变更（只修渲染/语义，不改形状）
- 新增依赖与新增子路径
- 语言跟随图 #51 与重启图 #75 的独立终裁（只做一致性引用，不抢终裁）

## 进度

- 2026-10-07 charting：grilling Q1-Q5 已答（目的地=调查+顺手修高优Bug；范围=批量+单面板+入口全查；详情单独立票；存量引用不替代；矩阵=双载体双主题双语门禁），已建图。
- 快照：子票 8 张（#82-#89）、未关 8、frontier 3（#82/#86/#87）、被阻塞 5，blockedBy 与设计一致（83→82、84→83、85→82、88→84、89→87），closed/total=0/8（新图未开工，属预期；有子票故不为 0/0）。
- 边：plan_create 落 8 父子+5 阻塞原生边，快照读回 8 子+5 阻塞对得上；补调 deck_map_link 一次超时但快照仍 8/5 稳定，未退回正文降级写法。
- 下一步：按 frontier 顺序取 #82（总账口径）认领开工；research 票（#82/#86）可并行子代理；本图携带执行，高优在子票内修+测。

- 2026-10-07 #82关闭（推荐A定稿+验证）：research报告 docs/research/20261007-issue-82-ledger-vs-knowledge.md 定稿，代码已由 #73 commit 38898f8 落地（batchLedgerCounts 知识感知+render透传，文案零新增），本票不再重复改 src；验收被 tests/issue-73-ledger-knowledge.test.mjs 7例超集覆盖（单跑7/7绿），全量 806（805过1跳过0失败）+gate:bilingual过；closed/total=1/8，frontier释放 #83/#85，下一步按 frontier 取 #83 或 #87（#86只决策不实现、用户已拍做，待拆票时关闭）。

<!-- 做到哪一步了，在这里一行一行记 -->
