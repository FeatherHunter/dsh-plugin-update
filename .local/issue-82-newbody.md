<!-- DSH-IDEMPOTENCY-KEY: deck-plan-batch-deep-dive-20261007-child-t1-ledger -->
## Question

总账/提示只看会话相位（pending 即“还没查过”），行在无轮次时优先看知识（inventory latestVersion），同一屏两种事实源（#73 现形、#59 Q1 同源）。要定：ledger 是否吃知识、batchCheck 是否建会话/轮次、checkOnOpen 缺省语义与文案优先级。

输入：#73、#59 Q1、src/panel-batch.ts batchLedgerCounts/batchSummaryText/batchRowKnowledgeText、src/host-batch.ts checkPhone、docs/adr/0003。

验收：给出唯一口径+最小改法；高优矛盾修+单测（pending+知识有新版不再矛盾）。

## 进度

- 2026-10-07 /research 研究完成，未实施代码，未改 src/tests，本票仍 open：矛盾已按一手来源证实并复现，唯一口径（推荐 A）与最小改法已定，报告已落盘。
- 结论：空会话+7xpending+知识 0.3.44→0.3.46 必现矛盾（ledger pending:7 vs 行 7 处有新版，dist 实跑复现）；口径为无轮次总账吃知识（有新版进可更新、已最新进 settled、无知识仍待查），有轮次走执行态不动，安装决策只认会话 targetVersion；batchCheck 只写 inventory 不建会话（ADR-0003 第1节）；checkOnOpen 缺省开三层（偏好>选项>缺省）不重议；文案顺序不动，复用 batch.hint.updatable / batch.summary.updatable。
- 报告：docs/research/20261007-issue-82-ledger-vs-knowledge.md（终版 109 行，后台研究交付后由 Lead 校核 3 处引用：#73 Q1/Q2 按 2026-10-07 读回为非阻塞未答，不作已拍板引用；#59 定稿以正文进度节为准；#73 Q2 按未答暂不展示时间。结论与最小改法不变，含 C1-C7、改动 3 处+1 测试、风险与复跑）。
- 澄清：本票无需 grilling（口径有 #73 推荐 A 与 ADR-0003 背书，无新措辞选择；#85 文案 grilling 属下游）。
- 阻塞不变：#83、#85 仍被本票阻塞；#73、#59 为输入引用，不关闭不替代。下一步：确认推荐 A 后按报告第7节实施（batchLedgerCounts 知识感知 + render L539 透传 + 同 counts），新增 tests/issue-82-ledger-knowledge.test.mjs 四例，跑 npm test + gate:bilingual。


- 2026-10-07 实施核验（认领 FeatherHunter）：报告§7最小改法已由 #73 commit 38898f8 落地（batchLedgerCounts(rows, inventory?)+ledgerKnowledgeBucket 四态镜像 batchRowKnowledgeText+render 透传 input.inventory，文案零新增），本票无需重复改 src，不另建重复测试文件。
- 验收：#82 验收四例被 tests/issue-73-ledger-knowledge.test.mjs 7 例超集覆盖（7行pending+知识0.3.44→0.3.46→updatable:7/hint可更新/同屏无还没查过；已最新→settled；无知识→pending零回归；查失败→failed；checking不吃知识；有轮次走执行态；ledger文本同步），单跑 7/7 绿。
- 门禁：npm test 全量 806（805过1跳过0失败）+ gate:bilingual 过（仅零draft提示，非release拦），与 #73 落地时 803（802过1跳过）一致，零回归。
- 真实状态：研究真实完成、实施真实完成（载体为 #73，非本票号；属预期复用，#73/#59只作输入引用、不关闭不替代）。batchCheck 永不建会话/轮次只写 inventory；checkOnOpen 缺省 true 三层（偏好>选项>缺省）+60s节流；文案顺序不动复用 batch.hint.updatable/batch.summary.updatable；安装决策只认会话 targetVersion。口径按报告§6推荐 A 定稿。
- 阻塞解除：本票关闭即释放 #83（明细行版本与对齐）与 #85（续跑/取消/关闭契约）；#73、#59 仍为输入引用。
