# 耦合基线快照（#161，2026-10-17，v0.18.6 之后）

> 用途：拆分前后对比锚。数字全部由脚本实测（`src/**/*.ts` 静态 `from './x.js'` 解析 + tests `../dist|src/` 计数），方法见 §7。拆完任何一票，重跑同口径脚本即得新快照。

## 1. 体量一览

- `src/` 共 **39** 个 TS 源文件（顶层 31 + `src/log/` 8），**零 barrel**：除 `src/log/index.ts`（log 子域门面）外，无任何转出口文件。
- `tests/` 共 247 个 suite 引 `../dist/*.js` 深引用 **204** 处（44+ 个测试文件命中 `dist/panel.js` 一家），另有 **2** 处 `../src/` 源码直读（最高危，见 §5）。

## 2. 巨型文件 Top（行数 / 导出数 / 被引用数 indegree / 出度 outdegree）

| 文件 | 行 | 导出 named(+brace) | indegree（被几家引） | outdegree（引几家） | 身份 |
| --- | --- | --- | --- | --- | --- |
| panel.ts | 3904 | 64+5 | 5 | 11 | 神文件：渲染＋文案＋锁存＋失败页决议（#156 又加 remembered） |
| panel-batch.ts | 2377 | 26 | 2 | 7 | 第二神：批量面板全套 |
| changelog.ts | 1591 | 65 | 5 | 3 | 导出密度王：65 个具名导出，工具函数集 |
| host-batch.ts | 1572 | 10 | 0（src 内零引用；tests 8 文件直引 dist） | 9 | 批量宿主 |
| store.ts | 1481 | 47 | 2 | 7 | 磁盘端口＋执行器＋队列端口三合一 |
| host.ts | 1349 | 19+15 | 1（src 内仅 host-batch 引；tests 27 文件直引） | **23（出度王）** | 双重身份：宿主实现＋全仓转发表门面（61–231 行 `export…from` 转出 config/reader/diag/service/store 等 12 家） |
| service.ts | 1167 | 23 | 9 | 1 | 判定核：core/版本/registry 全押一文件 |
| install-button.ts | 1135 | 14 | 0（src 内零引用；tests 2 文件直引） | 5 | 控件：复用 panelViewModel，理应薄而不薄 |
| bilingual.ts | 806 | 12 | 7 | 1 | 文案源（门禁：中文只许存此） |
| entry.ts | 754 | 19 | 2 | 4 | 单插件入口 |
| entry-batch.ts | 686 | 16 | 0（src 内零引用；tests 6 文件直引） | 6 | 批量入口 |
| diag.ts | 472 | 15 | 2 | 5 | 诊断组装 |

口径（评审后收紧，全文统一为值边）：indegree/outdegree 只计值边（`import…from` 值导入＋`export{…}from` 值转出口）；`import type` / `export type…from` 型边不计（全量见 §8）。出度本就是 import 图顶点的度数，是 spec 要的图的属性，不是多加的列。

小门面（健康参照）：client.ts 95 行（7+5 导出，转发表＋断言）、config.ts 191 行 35 导出、ports.ts 318 行 24 导出。

## 3. 被依赖 Top（值边 indegree：谁是全仓公理）

config 12 ＞ service 9 ＞ lang 8 ＞ bilingual 7 ＝ redaction 7 ＞ batch/changelog/panel/log-sink 各 5 ＞ queue/log-client-queue 各 4 ＞ codes/install-cause 各 3（install-cause 另有 2 条型边）。

解读：配置底座（config，12 条值边）是真正的“牵一发动全身”点，拆什么都别先动它；ports 恰相反——值被引用仅 1、值出度 0，它是纯类型底座（11 条 `import/export type` 型边指向它，§8），只转类型不转值；文案链（lang→bilingual）是第二公理，目录移动时保持 `lang/bilingual` 同域。

## 4. 出度 Top（值边：谁最纠缠，host 23 一骑绝尘）

host 23 ＞ panel 11 ＞ log/index 10 ＞ host-batch 9 ＞ store/panel-batch/http 各 7 ＞ entry-batch 6 ＞ install-button/diag 各 5。

附带解读（非 spec 要求，供 g1 参考）：host.ts 的 23 个出度里约一半是转发表（替全仓转出口），一半是真实现。**第一刀建议先剥 host 的转发表**（零行为变化，纯搬 `export…from` 到新门面文件），出度立刻减半，风险最低。

## 5. tests 深引用清单（搬家三处必改之第三处）

- `../dist/*.js` 分两个口径（评审指正已收，此前混用“处/文件数”，现拆开）：① **出现次数 204** = `../dist/*.js` import 语句（含静态＋动态 `await import`）在全仓的出现总次数；② 下表是“**引用它的测试文件去重数**”（一文件多引只算一次），两数不可比大小：panel **44** ＞ host 27 ＞ panel-batch 22 ＞ store 13 ＞ entry 11 ＞ service/host-batch 8 ＞ commands/entry-batch 6 ＞ batch/changelog 5 ＞ config/queue/log-index 3 ＞ bilingual/redaction/install-button/http/log-client-queue 2 ＞ codes/changelog-io/gate/log-events/log-manifest/log-router/reader/compliant-version 1。
- `../src/` 源码直读 2 处（搬家即碎，优先级最高）：
  - tests/changelog.test.mjs:128 直读 `../src/changelog.ts`（源码含某文案断言）；
  - tests/changelog-md-render.test.mjs:162 直读 `../src/panel-batch.ts`。
- 附带解读（非 spec 要求，供 g1/g2 参考）：tests 绑的是**编译产物路径**（`dist/` 与 `src/` 同构，tsc 1:1）。搬家＝三步原子操作：改 src 路径 → dist 同构改名（或冻结 exports 映射）→ tests 内 `../dist/X` 脚本当天全量替换＋立规则防回潮（numpy 式 `../src/` 直读两处顺手改掉，断“读源码断言”的坏习惯）。

## 6. 循环依赖：值图零环；静态类型环 1（#156 尾巴）

- 值边子图（只留 `import…from` 值导入＋`export{…}from` 值转出口；`import type` / `export type…from` 全部剔除）上 DFS 全遍历：**后向边 0，运行时环 0**。这是本节结论的唯一依据——评审指正已收：tsc 全绿只能证明无悬空引用/类型错，ESM 循环 import 照样编译通过，不能拿 tsc 证无环。
- 静态类型环 1：`ports ⇄ compliant-version`，双侧全是型边（ports 的 3 条出边全是 `export type…from`，值出度 0；compliant-version 的 2 条出边全是 `import type`，值出度 0）。运行时边 0，有害为 0。
- 附带解读（非 spec 要求，供 g1 参考）：把 `Compliant*` 类型搬进 ports（或独立小类型文件），静态环即清零；以本节“静态环”条目清零为解完标准。

## 7. 测量方法（重跑口径，拆后对比用同一套）

1. 行数：`src/**/*.ts`（不含 `.d.ts`）按 `\n` 切分计数；导出数：`^export` 具名声明＋`export{}` 花括号具名＋`export*` 计数。
2. 边：逐行正则 `from './x.js'`（含 `import` 与 `export…from`，`from` 独占续行亦命中）；值边/型边分流：行首 `import type` 或 `export type` 进型边，其余进值边；相对路径按所在目录归一化，自引剔除。indegree/outdegree 只用值边；环分开判：值图 DFS 无后向边＝运行时零环，型边另数。
3. 环：DFS 三色标记；类型环判定：环上每条边所在行均为 `import type`。
4. tests：正则 `\.\./(dist|src)/([\w/-]+)\.js?'` 全仓计数，按“命中测试文件去重数”排名；`../src/` 单独列出（直读源码§5）。
5. 锚定版本：v0.18.6（commit 66b537d）。门禁基线（附带，非 spec 要求：拆完对照看有没有跌）：npm test 1293（1292/0/1）、typecheck 绿、双语三硬门绿。

## 8. 邻接表（值边全量：§2–§4 的底账，按源字母序）

- batch-run → batch
- bilingual → lang
- changelog → bilingual, lang, service
- changelog-io → changelog, service
- client → batch, changelog, commands, config, queue
- diag → bilingual, install-cause, lang, redaction, service
- entry → bilingual, config, lang, panel
- entry-batch → bilingual, config, entry, lang, panel, panel-batch
- gate → config, redaction
- host → changelog, changelog-io, codes, commands, compliant-version, config, diag, gate, install-cause, log-events, log/client-queue, log/emit, log/manifest, log/namespace, log/registry, log/router, log/sink, log/trace, ports, queue, reader, redaction, service, store（其中 config/reader/diag/service/store 等多条是 `export…from` 值转出口＝门面转发，剥转发表即砍半）
- host-batch → batch, batch-run, codes, config, host, log/emit, reader, service, store
- http → client, config, diag, entry, panel, panel-batch, redaction
- install-button → bilingual, config, lang, log/client-queue, panel
- log/emit → log/manifest, log/router, log/sink, log/trace, redaction
- log/index → gate, log/client-queue, log/emit, log/manifest, log/namespace, log/own-version, log/registry, log/router, log/sink, log/trace
- log/manifest → gate, log/own-version
- log/registry → log/namespace, log/own-version, log/sink
- log/router → log/sink
- panel → bilingual, changelog, codes, config, install-cause, lang, log-events, log/client-queue, queue, redaction, service（11 条；另有 3 条 `export type…from` → ports 系型边，不计）
- panel-batch → batch, bilingual, changelog, config, lang, panel, service（7 条；另有 2 条型边 → ports/queue）
- ports → 值出度 0（3 条出边全是 `export type…from` → codes/install-cause/compliant-version）
- reader → compliant-version, config, service
- service → ports（混写 `import {…, type…}`，行首非 type，按值边计）
- store → batch, commands, config, log-events, queue, redaction, service（7 条；→ports 系 `import type`，不计）
- 零出度叶（值边 0，含纯类型引用）：batch, codes, config, install-cause, lang, log-events, log/client-queue, log/namespace, log/own-version, log/sink, queue, redaction
- 型边共 19 条，其中 11 条指向 ports（batch-run/commands/entry/host/host-batch/install-button/panel/panel-batch/reader/store/compliant-version 各以 `import type` 取类型）：搬家只动值边，型边随便指人不疼。
