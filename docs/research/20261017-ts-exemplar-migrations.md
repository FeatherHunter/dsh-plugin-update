# TS 单包"扁平/巨型文件 → 分层分域"迁移实例（#158）

> 日期 2026-10-17；只做研究，未改 `src/`、未动票。
> 方法：一手来源——GitHub 实际树与 blob（api.github.com / raw.githubusercontent.com，tag 锚定）、仓库内官方文档原文、官方发布注记与官方博客。`web_search` 当日不可用（缺 `DEEPSEEK_API_KEY`），故直接取已知官方 URL。
> 对照的初版研究：`docs/research/20261017-ts-directory-design.md`（下称"初版"）。

## 案例 1：tRPC `@trpc/server` v9 → v10（巨型 router.ts 拆进 core/）

- 项目/规模：`trpc/trpc`（~40k stars），迁移主体是 monorepo 内单个包 `packages/server`。
- 迁移前（`v9.27.2`，`packages/server/src/`）：顶层巨文件 `router.ts` **21,402 字节**；散文件 `TRPCError.ts/assertNotBrowser.ts/subscription.ts/transformer.ts/types.ts`；`core/` 仅 4 个小文件（`callProcedure/errors/index/transformTRPCResponse`），基本是个空壳。
- 迁移后（`v10.0.0`，同目录）：顶层 `router.ts` **删除**；`core/` 展开为 `initTRPC.ts`(4700B)/`middleware.ts`(4201B)/`parser.ts`/`procedure.ts`/`router.ts`(8645B)/`types.ts`/`internals/`；另有 `error/`、`observable/`、`shared/`、`http/`、`rpc/`、`adapters/` 分域并列。旧实现退守 `deprecated/`，根 `index.ts`（190 字节）只留一句兼容：`export { router } from './deprecated/router'`。
- barrel 政策：根 `index.ts` 纯转出口（190B）；`package.json exports` **14 个精选子路径**（`.`/`adapters/*`/`http`/`rpc`/`observable`/`subscription`/`shared`）——`./core`、`./internals` **不在 exports 里**，内部域不对外部开放。`src` 内 ESLint 禁止自引包名（`no-restricted-imports: @trpc/server`），内部一律相对深引用；entrypoints 由 `entrypoints.script.ts` 代码生成（`codegen:entrypoints`）。
- 深引用处理：外部只能走 exports 入口；`internals.ts` + `internals/` 存在但无导出条目=事实内部。测试独立在 `packages/tests`，另有 `scripts/generateBigBoi.ts` 生成"3500 procedures + 1000 routers"的巨型回归夹具。
- 迁移节奏：**分支上增量、多 PR → 大版本一票发布 → 用户侧渐进**。主 PR #1777（`katt/v10 → next`，149 commits、+7264/−1106、322 文件，checklist 驱动，2022-04-12 开 → 2022-06-19 合）；`v10.0.0` 2022-11-21 从 `next` 分支发布（release 的 `target_commitish` 就是 `next`，间隔约 5 个月）。用户侧三件套：官方迁移指南 + `interop()` 兼容模式（v9 router 几乎零改跑在 v10 上）+ 官方 codemod（`sachinraja/trpc-v10-migrate-codemod`）。
- 事后复盘（官方博客，第一手）：
  - 动因：v9 大 router 已拖慢大用户的 IDE/类型检查（announcing-trpc-10："largest applications…suffer from decreased performance"）。
  - 手法复盘（Sachin《TypeScript performance lessons while refactoring for v10》）：用 `tsc --generateTrace` 在真实 T3 app 上抓瓶颈；PR #2716 把编译时间砍 **59%**（332ms→136ms）；核心教训——`OmitNeverKeys` 这类"全量求值"工具类型会杀死 TS 懒求值，解法是把 v9/v10 程序**预分类存不同字段**（`record` vs `legacy`），不再靠 tag 过滤；并承认"只测不挂、未测耗时"，开了 #2892 补编译耗时度量。
- 链接：
  - https://github.com/trpc/trpc/pull/1777 · commit https://github.com/trpc/trpc/commit/ad25239cefd972494bfff49a869b9432fd2f403f
  - https://github.com/trpc/trpc/releases/tag/v10.0.0 · https://github.com/trpc/trpc/compare/v9.26.0...v10.0.0
  - https://trpc.io/blog/announcing-trpc-10 · https://trpc.io/blog/typescript-performance-lessons · https://trpc.io/docs/v10/migrate-from-v9-to-v10
  - 树：https://github.com/trpc/trpc/tree/v9.27.2/packages/server/src · https://github.com/trpc/trpc/tree/v10.0.0/packages/server/src

## 案例 2：Zod v3 → v4（154KB types.ts 拆成 core/classic/mini 三层）

- 项目/规模：`colinhacks/zod`（生态级 schema 库，Hono/LangChain/RHF 等依赖）；迁移主体是单个 `zod` 包内部（repo 级虽已是 monorepo，`src` 平面→`packages/zod/src` 立体发生在同一迁移里）。
- 迁移前（`v3.23.8`，`src/`）：巨文件 `types.ts` **153,859 字节**；`external.ts` 把 `errors/helpers/parseUtil/helpers/typeAliases/helpers/util/types/ZodError` 全量 `export *`，根 `index.ts` 仅 93 字节（`import * as z from "./external"` + 转出口 + `export default z`）。
- 迁移后（`v4.1.0`，`packages/zod/src/`）：`v4/core/`（18 文件：`api.ts` 49KB、`schemas.ts` 133KB、`checks.ts` 37KB、`util.ts` 27KB、`to-json-schema.ts` 34KB……）、`v4/classic/`（`schemas.ts` 76KB + `parse/errors/iso/coerce/compat`……）、`v4/mini/`、`v4/locales/`；**`v3/` 旧版实现永久保留在包内**；根 `index.ts`（121 字节）与 v3 同构，只是把 `external` 换成 `./v4/classic/external.js`。
- barrel 政策：**精选 barrel + 受控深引用**。每层 `index.ts` 恰好是 exports 子路径的直接入口（一一对应）；`core/index.ts` 13 行：11 个 `export *` + 4 个 `export * as` 命名空间（`util/regexes/locales/JSONSchema`）。`package.json exports` 10 条：`.`/`./mini`/`./locales`/`./v3`/`./v4`/`./v4-mini`/`./v4/mini`/**`./v4/core`**/`./v4/locales` + locales 通配，另有 `@zod/source` 条件直指 `src`。注意 `./v4/core` 是**故意公开**的深路径——迁移指南原话："to facilitate code sharing between Zod and Zod Mini"，且 `zod`/`mini` 根下以 `z.core` 命名空间整体重出口。
- 深引用处理：版本即路径（`zod/v3` vs `zod/v4`）；`mini` 与 `classic` 共享 `core`，不各自复制；测试就近放在各层内（`core/tests`、`classic/tests`）。
- 迁移节奏：**同包双轨、root 最后切换**（Go 式主版本思路，官方自述类比 `go.dev/doc/modules/major-version`）。v4 先以子路径形态随 3.25 同包发布、root 仍是 v3；生态就绪后 `zod@4.0.0`（2025-07-08 备注）才把 root 切到 v4，`zod/v4` 等旧子路径**永久保留**。配套：官方迁移指南（`v4/changelog.mdx`，破 Recon 按影响排序）+ 社区 codemod（`nicoespeon/zod-v3-to-v4`，官方点名"unofficial"）。
- 事后复盘（仓库内 `v4/versioning.mdx`，第一手，原话摘录）：
  - "the subpath versioning scheme was a necessary evil to force the ecosystem to upgrade in a non-breaking way"；
  - "it seems like the 'version avalanche' I'd feared didn't happen…this approach worked great!"；
  - 鼓励同类生态位库照搬，但也明说 "Few other libraries are subject to the same constraints as Zod"。
- 链接：
  - https://github.com/colinhacks/zod/blob/v4.1.0/packages/docs/content/v4/versioning.mdx · https://github.com/colinhacks/zod/blob/v4.1.0/packages/docs/content/v4/changelog.mdx
  - https://github.com/colinhacks/zod/blob/v4.1.0/packages/zod/package.json
  - 树：https://github.com/colinhacks/zod/tree/v3.23.8/src · https://github.com/colinhacks/zod/tree/v4.1.0/packages/zod/src/v4

## 只有现状、无过程（排除项，如实标注）

- **Vitest**（`vitest-dev/vitest`）：`v0.34.6` 的 `packages/vitest/src` 已是 `{api,integrations,node,public,runtime,typecheck,types,utils}` 分层——**天生分层，无"扁平→分层"迁移过程**，排除。
- **tsup**（`egoist/tsup`）：`refactor` 检索只命中换依赖类 PR（globby→tinyglobby、execa→tinyexec 等），无目录/巨文件重组 PR，排除。
- **Vite / Effect / tsdown**：本轮只查到现状树符合某范式、未定位到承载"拆文件+建目录"的真实 PR/commit，按任务要求不列为案例、不编造。

## 给初版研究的三条修正/补充

1. 初版 §C"先拆文件、后搬目录"**成立且证据补强**：两案都是"新结构与旧入口并存 → 旧入口退为薄垫片（tRPC `deprecated/router` + `interop()` / Zod 包内永久 `v3/`）→ 大版本或 root 切换一票发布"。但 tRPC 的 dist 路径是靠 exports 重钉而非源码同构映射——本仓逐文件转译（`src/→dist/` 同构）是更顺的形态，**exports 重钉的手法不可照搬**，初版专题 B 的结论（同构映射+冻结 exports）反而因此更稳。
2. 初版推荐 3"子目录不加聚合 index.ts"需加一条例外：**目录 barrel 仅当它是 exports 子路径的直接入口时才加**——Zod 每层 `index.ts` 与 exports 条目一一对应、tRPC `adapters/*/index` 同理；纯转发的二级聚合仍禁止。另 `core` 这类"故意公开的内部"（供 mini 复用/库作者用）是受控例外：本仓若设 `shared/` 被多形态复用，应同样在 exports 显式开洞，而不是默许深引。
3. 初版推荐 5（codemod 同步 tests 深引用）建议区分内外：两案的 codemod 都是**给用户迁 API** 的（tRPC 官方、Zod 社区），内部搬文件改测试引用是作者侧一次性机械替换；本仓 174 处 `../dist/` 引用同理，**当天脚本全量替换、不要手改**，且可学 tRPC 立 `no-restricted-imports` 式规则防止搬完又长出新的深耦合。
