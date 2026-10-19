# 7. src 目录形状：根只留入口壳，实现按域分目录

- 状态：接受
- 日期：2026-10-19
- 关联：地图 [#220](https://github.com/FeatherHunter/dsh-plugin-update/issues/220) · 蓝图 [docs/research/20261019-src-restructure-blueprint.md](../research/20261019-src-restructure-blueprint.md) · 前序地图 [#157](https://github.com/FeatherHunter/dsh-plugin-update/issues/157)（本 ADR 是其「阶段二：落定目录结构」的正式接续）· 执行票 #225 / #223 / #228 / #227 / #226 / #221 / #229 / #230 · 术语（入口壳 / 域目录 / 公开面）见 [CONTEXT.md](../../CONTEXT.md)

## 背景

`src/` 原来是 42 个平铺文件 + `src/log/`（共 54 个 TS）：最大的 `panel.ts` 4226 行、`panel-batch.ts` 3624 行、`store.ts` 2570 行。找文件靠记忆，找「改一处要动哪些文件」靠人传人；导航文档只能标「第几行」，文件一搬就失真。

公开面不在源码目录上，而在 dist 产物路径上：10 个 exports 子路径（`.`、`./panel`、`./client`、`./batch`、`./panel-batch`、`./entry`、`./entry-batch`、`./install-button`、`./http`、`./log`）指向固定的 `dist/*.js` / `.d.ts`。四家消费方（deck、life-pack、im-companion、palette）按子路径 import，宿主安装校验也认产物路径，tests / scripts 另有三百多处 `../dist/` 深引用。源码目录怎么挪，这些路径都不能变。

[#157](https://github.com/FeatherHunter/dsh-plugin-update/issues/157) 只做了阶段一（拆神文件、不动目录），「落定目录结构」留给阶段二；重议触发满足后由 #220 接续，#224 蓝图经用户终审，执行票分域落地。本 ADR 记录收口时（#230）的既定形状。

## 决策

1. **根目录只留 9 个入口壳**：`host.ts`、`panel.ts`、`client.ts`、`host-batch.ts`、`panel-batch.ts`、`entry.ts`、`entry-batch.ts`、`install-button.ts`、`http.ts`。每个壳只做该 exports 子路径的公开导出（curated re-export + 公开类型，不套二级 barrel），加一段头注说明；**不写逻辑、不做决策**。第 10 个入口 `src/log/index.ts`（`./log` 子路径，宿主侧消费）原位不动。
2. **实现进域目录**：`shared/`（跨域底座：命令/配置/脱敏/错误码/面板文案簇…）、`core/`（业务核心：批量模型、changelog、i18n（含文案字典）、判据、落盘…）、`host/`（宿主运行层与电话转发）、`panel/`（面板、入口件、安装按钮等应用侧）、`log/`（日志内核，不搬家）。域内再按调用链与概念分文件；依赖只向下，实现不反向值依赖入口壳（纯类型上行除外，见 `architecture.md` 入口壳纪律）。
3. **不留旧路径兼容壳**：搬完即旧路径不存在，不写「旧名 re-export」垫片——兼容壳会制造两套路径，让「文件在哪」重新变成两个答案。
4. **tests 维持深引用 dist**：不改成 import src，不新增源码直读；搬家由 codemod（`scripts/rewrite-dist-imports.mjs`，映射表唯一真源是蓝图 §3/§4）机械修复引用，每域票跑一次、当天全绿。codemod **不接入门禁**：地图 Out of scope 明确不加新门禁/CI，`--check` 只在收口前手动跑。
5. **公开面零变**：10 个 exports 子路径与 dist 产物路径一个不改；新能力才新开子路径（沿用既有「新增能力一律新开子路径」纪律）。

## 反向范围

- 不改行为、协议与文案（纯结构重构，行为零变化）。
- 不改 `package.json` 的 `exports` 与 `files` 白名单，不改 dist 产物路径。
- 不重命名任何方法、类型或导出名。
- 不加新门禁 / CI 检查，不把 codemod 接进 `npm run check`。
- 不借机改代码风格、类型或顺手整理既有实现。

## 后果

- 正面：目录自解释——按域找文件、按调用链读代码，不再靠记忆与整文件 grep；改动半径可解释；dist / exports / README / 宿主安装校验 / 四家消费方全部零改动，重构压缩成纯内部搬家。
- 代价：文件数 54 → 89——9 个入口壳背后的实现拆进域目录，文件按概念分而非按旧文件对齐；npm pack 文件数 111 → 181，每个非 ambient `.ts` 在 dist 下带 js + `.d.ts` 两个产物，发布白名单 `files` 不变。文件变多不是目标，是「按概念分文件」的代价。
- 代价：入口壳与实现分离多一层跳转——读代码要从壳跟进域目录；壳的 re-export 是公开面的第二份表达，收窄或改名导出时两边要同时守。
- 代价：域内文件按概念分，不按旧文件一对一对齐——一次拆分里的共享底座与常量会按「只向下依赖」改判归位（如 helpers、轮询常量随实现走），不能拿旧文件名反查新文件。

## 指针

- 蓝图：`docs/research/20261019-src-restructure-blueprint.md`（目标树 §2、全量文件映射 §3、方法职责表 §4、风险表 §6）
- 地图 #220；执行票 #225（tracer - codemod）、#223（shared）、#228（core）、#227（host）、#226（panel）、#221（install-button）、#229（panel-batch）、#230（收口）
- 版本号未递增（`0.18.25` 不动），发版由用户另行决定。
