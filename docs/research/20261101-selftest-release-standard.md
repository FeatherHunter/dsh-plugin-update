# 自测放行标准 v2 —— 双台账闭合 + 两级可红 + 三道门

- 日期：2026-11-01
- 票据：#261（已解）；挂地图 #256；输入 #258 / #259 / #260 / #262
- 定位：本图（地图 #256）的规划验收标准。本图只交规划，不实现、不发布；门二/门三是下一程。

## 0. 地图目标与本文位置

地图 #256 Destination：产出一套独立源码目录下的源码规划，证明 2–3 个自测插件足以覆盖更新系统全功能全场景；只交规划，不实现、不发布（Out of scope：插件实现、真发 npm、真机验收属下一程）。

本文回答 #261：什么算「全量」、测到哪几道门、判据多硬。它要保证地图出口那句话可被机械审计：全量有分母（文档契约段 + 代码面项），每项归属到义务行或具名豁免，每行给出触发/观测/层与机制真实性/可红方式/夹具组合。地图的规划评审 = 本文的门一。

#258 已定 N=3（A/B 集成方 + C 纯目标，2 执行席，单模板 + 薄身份包装），因此覆盖矩阵的夹具组合列按此实例化；2 vs 3 的比较不再是本图待决项（只在门一附敏感性说明）。

## 1. 第一性原理

1) 覆盖率是义务集合到证据集合的满射，不是行覆盖率百分比。测 100% 的行不代表承诺都测到；测 60% 的行也可能承诺全测到。所以核心物是「义务 → 归属」台账，覆盖率数字只是台账的副产品。
2) 一条证据 = 触发真入口 × 观测外部结果 × 可红 × 机制真实性。缺一条只是冒烟，不是证据。
3) 「层」是机制真实性，不是难度排名。层由「承载该声明的机制」的真实度决定；一行依赖多个机制时，点名承载声明的那一个，fake 清单不得把它假掉。

## 2. 全量 = 双台账 + 矩阵 + 豁免 + 反例

### 2.1 台账甲：文档契约段（正向分母）

- 产出 doc-segments.json：README.md、docs/host-install-exits.md、docs/agents/architecture.md、CONTEXT.md 的每个契约段登记为段（id、path:行号区间、一句话摘要）。
- 每段必须映射到 ≥1 条义务行，或具名豁免（理由码见 2.4）。linter 断言：零未被引用的契约段。分母 = 段数，「覆盖 X/Y」才有基数。
- 关键承诺必须细到句级子段（红队点名）：README.md:79（五级范围解析）、README.md:110-133（derive-client-values CLI 契约）、README.md:150（重开面板 1 秒内恢复）、README.md:156（panelPollMs 下限 250 毫秒）、README.md:165（五章恒在、缺内容给中性提示、不跳号）。
- 判据是正向可查：未被任何行/豁免引用的段 = 漏。这是负向全称命题唯一可执行的补位（文档段是有限集合，可枚举）。

### 2.2 台账乙：代码面（生成式清单）

- exports 枚举到名字集合，不是子路径：11 个子路径（package.json:30-73）+ dist/client.js 的冻结导出名快照 diff（src/client.ts:1-4 声明「路径与导出集一字不动」，:6-49 约 40 个逐名转出；全仓无该集合的快照断言）+ ./log + ./http（HTTP_PHONE_ACTIONS 6 个动作 src/host/http.ts:30；批量 7 个动作 :33 起；三个超时常量 :25-27）。
- 运行期 handlers 对象枚举，不抄文档：
  - 单包 handlers：factory.ts:673 起（updateStatus / updateCheck / updateInstall / updateCheckFallback / updateChangelog / logAppend 六通 + hubStatus :662/:702 = 7 通）。文档 docs/agents/architecture.md:143 只写 6 通。
  - 批量 handlers：固定 7 通（fan-out.ts:1334-1340，电话名 :1303-1311）+ hubScope 条件 updateHubStatus（:1343-1346）+ 每目标单插件全表并入（:1349-1354，ΣN×6~7）+ 属主 logAppend 转发（:1358-1366）。公开面 = 7 + ΣN + 条件项。
- 错误码全集 = 「任何公开回包 error / errorKind / detail 可能出现的码」，三源枚举：
  - codes.ts 四集合并集：BLOCKED_REASONS 11（:27-40）、PHONE_FAILURE_CODES 5（:44-50）、CHECK_SIDE_FAILURE_CODES 3（:58-62）、STABLE_CODES 17（:75）、CORE_ERROR_CODES 16（:78）、BATCH_REPLY_CODES 17（:85）、裸常量 internal（:66）/ unsupported（:69）/ cross-scope（:72）。
  - 宿主 5 个管理器码：not-removable / bundle-in-use / management-required / stale-approval / incompatible-version（出现在用户可见 detail/error.code，见 docs/host-install-exits.md:203-205），codes.ts 完全没有。
  - 合成码：如 already-installed 等由宿主原话进入用户可见面的码。
  - 每码标注「真实触发」或「不可达，证明在 file:line」；unsupported 在 UpdateErrorCode（:82）却不在 STABLE_CODES：面板 17 码分支缺它，归账时必须显式处理。
- 事件：event-list.update.json 29 事件（真源）；文档 docs/agents/architecture.md:109 写 27；目录生成器缺行只警告（scripts/gen-log-catalog.mjs:252-256）。
- 不变量：CONTEXT.md 的日噪声预算（≤50 行/天、≤500 行/操作日）等横切约束入账。

### 2.3 覆盖矩阵（每行）

义务 id | 来源（段 id / 代码项） | 触发真入口 | 外部观测 | 声明层 + 承载机制 + fake 清单 | falsifier 级别/机制/允许红集 id | 场景与夹具组合 | 承接门

### 2.4 豁免账本

理由码只有四类：打包面（package.json/files 与产物布局）、内部件（非公开 API 且无用户可见行为）、门三承接（真机项）、已知红（+票号+到期日）。无沉默豁免；豁免必须具名、写理由、写承接者，linter 校验字段齐。

### 2.5 反例审查

- 记录 schema：target / source / claim / verdict / ledger_action（补行或确认已覆盖）。
- 独立性：非作者评审（换 agent 或换 session，或人）；红队不得由矩阵作者兼任。
- 停止规则（门一冻结参数）：每评审者 ≥N 条攻击尝试（默认 N=20），且连续 M 条无新发现（默认 M=5）才可宣布闭合。
- 发现即补行：新义务先进台账再评审；举不出反例才放行。
- 本文 §6 就是一轮实例记录（12 条，全部进台账或改判据）。

## 3. 判据：两真 + 两级可红

### 3.1 三条真实性

- 触发真入口：宿主电话 / HTTP 入口 / 面板挂载 / CLI 手工命令；不直调内部函数。
- 观测外部结果：回包字段、盘面（queue.json / 在册 / 包目录）、日志行、DOM 渲染。
- 机制真实性：行内点名承载声明的机制，fake 清单不得假掉它；不满足就降层或转承接门。

### 3.2 四层定义（重定义，消除 L1/L2 重叠）

- L0 进程内纯逻辑：无 FS、无子进程、无宿主；可 import 真实模块。
- L1 本地闭环：真 FS + 临时 profile + 真 dist 产物；假宿主、假 registry 网络、假长钟（允许缩短阈值的真计时器）。
- L2 真宿主进程闭环：真 DSH 宿主进程 + 临时 profile + 断网 + 假 registry。仅当实现提供 harness 时可达；门一不假定它存在（现在没有：selftest 只有 tsc --noEmit，见 selftest/README.md:48）。
- L3 真环境外部性：真 registry 认证与可见性、真官方桌面管理器、真宿主重启、真时间尺度、真 OS。
- 定层规则：一行多机制时按「承载该声明的那一个」定层，行内点名；不允许用平均或最高档含糊过关。

### 3.3 两级可红

- 强可红 = SUT 变异测试：按文件/行为定义变异算子，变异后重建 dist，先断言「变异已生效」（哨兵），再跑场景；红集命中允许集才算过。成本 = 每强行一次重建+全量；预算门一给（单次上限、总次数、跑在发布/夜间，不进 check）。
- 弱可红 = 故障注入 / 已知坏样本：把依赖端口改成返回错、把 fixture 改成缺状态。它只证明「断言对输入敏感」，不证明「断言能抓住系统自身回归」；标 B 级，不计入强可红配额。
- 为什么不能全用注入：HostUpdate 的缝全是依赖/输入（src/host/factory.ts:274 的 deps：ctx / logCtx / logEventList / desktopPnpm / pluginManager / readerOverrides），改假 pluginManager 等于改输入，红不说明被测行为坏会红。

### 3.4 允许红集冻结（修「恰好目标红」）

- E/F/G/D 共用全局锁与中枢租约：QUEUE_LOCK_STALE_MS = DEFAULT_INSTALL_TIMEOUT_MS（src/core/queue/ports.ts:42）；HUB_LEASE_HEARTBEAT_MS 5s / HUB_LEASE_STALE_MS 20s（src/core/hub/lease-policy.ts:16-19）。一个锁/租约变异会同时红 D/F/G。
- 因此判据改为允许集：「至少这些行红，集合外不得红」。门一冻结 break id → 允许红集 的 digest（含矩阵与 manifest）；门二只执行，不许改期望；新增 break 走门一复审。

### 3.5 配额与 SEAM-GAP 上限

- 每组 ≥2 条强可红，且必须含该组核心行为；其余行最低弱可红。
- SEAM-GAP（找不到公共注入缝）硬上限：P0 行 0 个、总数 ≤5；每个必须经红队复查确认无公共缝，记账并写明替代观测。
- B 码面：每码要么真实触发，要么「不可达」证明；不可达证明也算义务行。

## 4. 三道门

### 4.1 门一：纸面评审门（本图 #256 出口）——七件交付物，无运行代码要求

1. 双层台账草案：文档段清单 + 代码面枚举（生成器 schema 与真源清单）。
2. 覆盖矩阵静态填表（2.3 的列，全部行填满，并标注 layer 与承载机制）。
3. 豁免账本（2.4）。
4. 可红设计：变异算子表（按文件）、重建与生效哨兵方案、允许红集冻结与 digest 机制、每组配额与成本预算。
5. 门三 canary 清单 + known-red 基线（含 docs/host-install-exits.md:188-191 两条「真机没点过」、:203-206 未修用户可见缺口）。
6. 反例审查记录（2.5 schema、独立性、停止规则）+ 文档漂移报告草案（真源 vs 文档数字与行号，见 §9 已知项）。
7. 地图修订建议（§8，另行地图级决策，不写进本票正文）。

验收 = 独立评审 + 红队签字；判据是「零未引用契约段 / 零未归属代码面项 / 每行字段齐 / 每行有 falsifier 且配额满足 / 豁免具名」。

### 4.2 门二：实现执行门（下一程）

- 生成器 + linter 绿；台账/矩阵/红集 digest 与门一冻结值一致（防缩表）。
- hermetic 执行：egress 哨兵（preload 拦 fetch/socket/DNS，断言 0 次真网络）；N≥10 次逐场景判定向量一致，抖动即红；执行时限。
- 强可红按冻结集跑：变异 + 重建 + 生效哨兵，命中允许集。
- known-red 基线账本 + 棘轮：账本外零红，账本只减不增；「已知红未修」不得用绿跑掩盖。
- 精确 script 图与成本上限：check 只跑门二绿跑 + 静态检查；变异跑放发布/夜间。注意 test:batch 不 build（package.json:92，只有 pretest:90 才 build），批量入口必须显式 build 后置；现有 check（package.json:96）不含 smoke:log / probe:layout / selftest。

### 4.3 门三：真机签署门（发布出口）

- 时点必须可放置：canary 预发布（预发布版本，不占 latest）→ 真机证据六元组 → 人签 → promote 正式发布。理由：现有 release.mjs 是「先 publish 再 verify」（scripts/release.mjs:3 的顺序；verify 断言 :143-186 全在 publish 之后），真 registry 证据在正式发布前不存在。
- 若维护者拒绝 canary：显式降级为「发布后审计 + 下次发布前置阻断」，并接受发布不可回滚；不得仍叫「门」。
- 覆盖：C 真 pnpm / 真官方桌面管理器、H 真宿主重启、I 全拓扑、J 真外部 dsh-log 实例与日噪声预算、K2 真 Chrome 布局、known-red 清单。
- 证据六元组：环境 / 版本+commit / 步骤 / 断言 / 证据路径 / 签字。
- 原则：不由绿测试代签。

## 5. 每组默认期望层（门一逐行论证偏离）

| 组 | 门二默认层 | 门三真机项 |
|---|---|---|
| A 单包主链 | L1 逻辑链 | 真宿主整链抽验（除非 L2 harness 立项） |
| B 码面 | L1：每码真实触发或不可达证明 | — |
| C 三出口 | L1 选择逻辑 | 真 pnpm 子进程、真官方桌面管理器 |
| D 超时取消 | L1 短阈值真时钟 | 15min / 16min 真等待 |
| E 批量 | L1 三包 | 真 registry 下载与失败矩阵 |
| F 队列锁 | L1 两包 | 跨进程真并发抢锁 |
| G 中枢 | L1 两包 | 真双进程、跨进程协议换代 |
| H 在册沉降 | L1 盘面 | 真宿主重启 false→true |
| I 拓扑补偿 | 不可自测 | 全程 |
| J 日志面板 | L1：真 dist + 假传输 | 真外部实例、日噪声预算 |
| K1 静态面 | L0/L1 机检（导出名快照、DOM 结构不变量、mount/derive 契约、http 动作表与超时常量） | — |
| K2 视觉布局 | — | 真 Chrome，六元组；probe 无 Chrome 必须 exit 1 或显式 --allow-skip 并记入清单 |

## 6. 对抗式审查记录（红队 12 条 → v2 处置）

| # | 攻击 | 处置 |
|---|---|---|
| P0-1 | 义务无分母，「未归属即不放行」不可机检；散文承诺生成器产不出 | 台账甲改为文档契约段（有限集合可枚举），linter 查零未引用段；分母=段数 |
| P0-2 | --break 的缝全是输入，红证明空；真要破坏 SUT 需变异测试（无工具，且与只交规划冲突） | 强可红=SUT 变异（算子+重建+生效哨兵+成本预算，门二执行）；弱可红=故障注入只标 B 级；SEAM-GAP 硬上限 |
| P0-3 | 「恰好目标红」在共享锁/租约下不可满足，且期望红集可事后填写 | 改允许红集；门一冻结 break→允许集 digest，门二只执行，新增走复审 |
| P0-4 | 门一要求生成器/linter 绿=实现，违背地图只交规划；夹具预算越权替 #258 | 门一降为纸面评审（七件文档交付物）；生成器/linter 移门二；N/模板粒度归 #258（已决 N=3/单模板，只实例化） |
| P0-5 | 门三没有可放置时点：release.mjs 先 publish 再 verify，真 registry 证据在发布前不存在 | 门三=canary 预发布→六元组证据→人签→promote；拒绝 canary 则显式降级为发布后审计 |
| P1-6 | L1/L2 重叠（真 dist 两边都有），A 的 L2 与门二 hermetic 冲突 | 四层重定义（L2=真宿主进程+临时 profile+断网，需 harness，门一不假定）；按承载机制定层 |
| P1-7 | O2 面账算错：批量面是 7+ΣN+条件项；11 exports 数的是子路径不是名字 | 代码面枚举到名字集合/运行期 handlers 对象/三张批量电话表/http 动作表与超时常量 |
| P1-8 | 错误码全集未定义：codes.ts 四套重叠集合；宿主 5 个管理器码不在 codes.ts | 全集=任何公开回包 error/errorKind/detail 可能出现的码，三源枚举，每码真实触发或不可达证明 |
| P1-9 | 门二质量条款可绕：无 known-red 政策、可缩表、无断网机制、两次一致不是防抖门 | baseline 账本+棘轮；manifest/矩阵/红集 digest 冻结；egress 哨兵；N≥10 判定向量 |
| P1-10 | K 组与 O2 重复、两种判据混组；probe 无 Chrome 静默跳过 | 拆 K1 静态面（L0/L1 机检）/ K2 视觉（门三）；probe 必须 exit 1 或显式 --allow-skip 并记账 |
| P2-11 | 改写地图声明=用下一程兑现本图承诺，并让 #258 失去判据 | 不在 #261 改原句；另附修订提案走地图级决策；修订前只声称覆盖可自测义务 |
| P2-12 | 计数修正只列三条且自身有错；编排与成本未与既有门禁对齐 | 漂移报告交门二生成器；门一记录已知项（§9）；给精确 script 图与运行预算 |

可保留不动：A–J 编号；门三「不由绿测试代签、证据留存 + 人签字」。

## 7. 决策记录（2026-11-01）

维护者 2026-11-01 确认「均按推荐执行」：

- 门三形态：canary 预发布 → 六元组证据 → 人签 → promote。
- known-red：docs/host-install-exits.md:203-206 未修缺口作为账本项接受；门二不阻断，门三必须列出。
- 可红配额：每组 ≥2 条强可红且含核心行为。
- 文档段粒度：标题级 + 5 处关键承诺句级（§2.1 列表）。
- 反例停止规则：N=20 / M=5。
- 边界：#258 已决 N=3 / 单模板，本票只按此实例化，不再比较；不实现、不发布；地图 Destination 原句不改写（§8）。

## 8. 地图 Destination 修订提案（待地图级决策）

现状：Destination 写「证明 2–3 个自测插件足以覆盖更新系统全功能全场景」，而 Out of scope 写「真机验收属下一程」。若 I 组（拓扑补偿）只能真机验，原句在「全场景」上永远不可证。

建议措辞：「产出一套独立源码目录下的源码规划，证明 2–3 个自测插件足以覆盖更新系统的全部可自测义务（双台账闭合口径），不可自测义务（真 registry / 真官方桌面管理器 / 真宿主重启 / 真拓扑）由门三真机签署清单承接；只交规划，不实现、不发布。」

影响：修订前标准只声称「覆盖可自测义务」；#258 的包数判据改为「能否实例化矩阵全部夹具组合」；门三清单成为地图出口的显式承诺，而不再藏在 Out of scope 里。

此提案由地图级决策（人）拍板，不在 #261 正文替换原句。

## 9. 已知漂移与下一步

已知漂移（门一记录、门二生成器复核）：

1. 事件 29（event-list.update.json）vs 文档 27（docs/agents/architecture.md:109）；目录缺行只警告（scripts/gen-log-catalog.mjs:252-256）。
2. 单包 handlers 7 通（factory.ts:673 起 + hubStatus :662/:702）vs 文档 6 通（architecture.md:143）。
3. 批量 handlers 文档行号漂移：architecture.md:151 写 fan-out.ts:1087–1094，实为 :1333-1340；:134 写 logAppend 转发 :1107–1111，实为 :1358-1366（:1087-1094 是推进流程，不是 handlers 表）。
4. exports 11 个子路径（package.json:30-73）；文档侧「10」的说法需生成器核实（取证笔记 §5）。
5. src/host/http.ts:21 注释「永不进面板 14 稳定码」vs STABLE_CODES 17（codes.ts:75）。
6. probe:layout 无 Chrome 时 exit 0（scripts/panel-layout-probe.mjs:19）；selftest 仅 tsc --noEmit、不在任何 npm script（selftest/README.md:48）。
7. test:batch 不 build（package.json:92）；check（:96）不含 smoke:log / probe:layout / selftest。

下一步：

1. #257 独立源码目录原型（地图唯一未关票、可接）→ 模板与薄包装布局定案。
2. 按本文产出规划并过门一（七件交付物）→ 地图 Destination 的出口。
3. 门二实现（生成器/linter/变异工具/egress 哨兵/known-red 账本）与门三 canary 管线改造 = 下一程（地图 Out of scope）。
4. #258 的 N=3 / 单模板 / 2 执行席已决，规划直接把矩阵夹具组合列实例化；2 vs 3 只在门一附敏感性说明。

## 10. 本文证据索引（逐条核对）

- package.json:30-73 exports 11；:88-99 scripts。
- README.md:79 / :110-133 / :150 / :156 / :165。
- src/client.ts:1-4 / :6-49。
- src/host/http.ts:21 / :25-27 / :30 / :33。
- src/host/batch/fan-out.ts:1303-1311 / :1334-1340 / :1343-1346 / :1349-1354 / :1358-1366。
- src/shared/codes.ts:27-40 / :44-50 / :58-62 / :66 / :69 / :72 / :75 / :78 / :82 / :85。
- src/host/factory.ts:274 / :662 / :673 / :702。
- docs/host-install-exits.md:188-191 / :203-206。
- scripts/release.mjs:3 / :143-186。
- scripts/gen-log-catalog.mjs:252-256。
- docs/agents/architecture.md:109 / :134 / :143 / :151。
- selftest/README.md:39-43 / :48。
- scripts/panel-layout-probe.mjs:19。
- src/core/queue/ports.ts:42。
- src/core/hub/lease-policy.ts:16-19。
- event-list.update.json（29 事件）。
