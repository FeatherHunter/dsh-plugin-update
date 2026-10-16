# TypeScript 单包库 src 目录设计：业界做法调研

> 日期 2026-10-17；只读调研，未改任何源码、未跑构建。
> 方法：只采信一手来源——各仓库 GitHub 实际树（api.github.com contents）、官方文档原文（bulletproof-react 项目结构页、tRPC 文档、Vite 文档、eslint-plugin-import 规则文档）。web_search 当日不可用（缺 DEEPSEEK_API_KEY），故直接取已知官方 URL；每条结论后附依据链接。

## 本仓现状（实测，非转述）

- `src/*.ts` 31 个文件全铺一层；另有 `src/log/` 一棵子树（#121 起的先例）。
- `build.mjs`：esbuild 逐文件一对一转译，**递归扫 `src/`、相对路径原样映射到 `dist/`**（`src/log/registry.ts → dist/log/registry.js`），注释明说新增文件漏扫目录会丢产出。
- `package.json` exports 已是**深子路径契约**：10 个入口（`.`/`./panel`/`./client`/`./batch`/`./panel-batch`/`./entry`/`./entry-batch`/`./install-button`/`./http`/`./log`），各自钉死 `dist/*.js`。
- `tests/*.test.mjs` 有 **174 处** `from '../dist/<name>.js'` 深引用（含 `../dist/log/manifest.js` 这类子目录引用）——搬文件必同步改测试。
- `tsconfig.json`：`include: src/**/*.ts`，`noEmit` 只检查；`moduleResolution: Bundler`。

## 范式 1：monorepo `packages/*`（多发布单元时才用）

- 事实：Effect（`ai/atom/effect/opentelemetry/platform/sql/tools/vitest`）、tRPC（`client/next/openapi/react-query/server/…`）、Drizzle（`drizzle-orm/drizzle-kit/drizzle-seed/…`）、Vite（`create-vite/plugin-legacy/vite`）、TanStack Query（`query-core/react-query/vue-query/…` 近 30 个包）、NestJS（`common/core/microservices/…`）**全部**是顶层多包。
  - https://github.com/Effect-TS/effect/tree/main/packages · https://github.com/trpc/trpc/tree/main/packages · https://github.com/vitejs/vite/tree/main/packages · https://github.com/TanStack/query/tree/main/packages · https://github.com/nestjs/nest/tree/master/packages
- 适合：多个独立发布单元 / 多人多团队 / 需要按适配器分别打包。找文件：先定包（=发布边界），再进包内。
- 防循环：包依赖本身构成 DAG（pnpm workspace + turbo 任务图）；包的公开面由各包 `exports` 卡死。
- 对本仓结论：**不适用**——本仓是单 npm 包（单 `name/version/files: dist`），拆 `packages/` 只会增加发布复杂度，收益为零。

## 范式 2：按运行时/层分（Vite 式，适合"同逻辑跑多环境"的库）

- 事实：`packages/vite/src = {client, module-runner, node, shared, types}`；`src/node` 下再按子域 `{optimizer, plugins, server, ssr}` 展开，单文件仍可很大（`config.ts` 91KB、`build.ts` 60KB、`utils.ts` 59KB）但职责单一。
  - https://github.com/vitejs/vite/tree/main/packages/vite/src · https://github.com/vitejs/vite/tree/main/packages/vite/src/node
- 适合：同代码库产出 Node 端 / 浏览器端 / 共享内核多种产物；团队按"环境"分工。找文件：先定运行时（node 还是 client），再定子域。
- 防循环：`shared`/`types` 只被引用不反向引用 `node`；`node/index.ts`（8KB）是唯一的对外组装点，`internalIndex.ts` 仅 99 字节隔离内部入口。
- 对本仓结论：**部分适用**——本仓天然有"纯内核（Node+浏览器双跑）/ 面板渲染（浏览器）/ 宿主接线（Node）"三运行时，正好对应；但 Vite 容忍 60–90KB 大文件的前提是"目录+文件名已能定位"，本仓 3789 行 panel.ts 不满足该前提（见 §神文件）。

## 范式 3：按适配目标垂直分（Drizzle 式，适合矩阵式适配）

- 事实：`drizzle-orm/src` 下按方言/驱动一目标一目录（`pg-core/mysql-core/sqlite-core/…`、`node-postgres/postgres-js/neon/…-proxy` 等），通用概念沉顶层小文件（`column.ts/table.ts/relations.ts/logger.ts/version.ts`），根 `index.ts` 仅 435 字节。
  - https://github.com/drizzle-team/drizzle-orm/tree/main/drizzle-orm/src
- 适合：N 种后端 × M 种驱动的矩阵；加一种支持 = 加一个目录、不碰旧目录（开闭原则）。找文件：先定"方言/驱动"，目录即答案。
- 防循环：`*-core` 不依赖具体驱动目录；驱动目录只向上依赖 core；顶层通用文件零业务依赖。
- 对本仓结论：**思路可借、形状不照搬**——本仓的"矩阵"是 phone/host/panel/entry/batch 等多挂载形态，`host-batch/panel-batch/entry-batch` 已有垂直雏形；应把"一批挂载形态"收拢为一组目录，而不是继续在顶层加 `*-batch.ts` 扁平文件。

## 范式 4：一概念一文件 + 薄 index（query-core / NestJS common，适合中小单包）

- 事实：`query-core/src` 20+ 个扁平文件，一文件一概念（`query.ts/queryCache.ts/queryClient.ts/mutationCache.ts/focusManager.ts/…`），`index.ts` 仅 1971 字节纯转出口；`__tests__` 就放在 `src` 内。NestJS `packages/common = {decorators, enums, exceptions, interfaces, module-utils, pipes, serializer, services, utils}` + 1799 字节 `index.ts`。
  - https://github.com/TanStack/query/tree/main/packages/query-core/src · https://github.com/nestjs/nest/tree/master/packages/common
- 适合：30–100 文件规模、1–3 人维护的单包：文件名即概念，找文件靠"猜名 + 薄 index"。注意反例也在同一仓库：`types.ts` 75KB、`queryClient.ts` 40KB、`queryObserver.ts` 30KB——**业界也允许大文件，但只允许"一概念"的大，不允许"多职责"的大**。
- 防循环：`import/no-cycle` 规则（官方文档明说检测任意深度环、但"computationally expensive"、类型导入不计入）+ 薄 barrel 只做 `export *` 不放逻辑。
  - https://github.com/import-js/eslint-plugin-import/blob/main/docs/rules/no-cycle.md
- 对本仓结论：**最贴合的起点**——本仓 31 文件正处此范式上限；先做到"一文件≤一职责、超 1000 行必有拆分理由"，再谈目录。

## 范式 5：feature 纵切 + 单向依赖（bulletproof-react / tRPC，适合多人协作的应用层）

- 事实：bulletproof-react 规定 `src/features/<名>/{api,components,hooks,stores,types,utils}` 按需取用 + `shared → features → app` 单向，用 `import/no-restricted-paths` zones 逐 feature 禁掉横向引用、再禁掉反向引用。
  - https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md（raw）
- tRPC 官方文档原话："Writing all API-code in the same file can become unwieldy. It's easy to merge routers together in order to break them up." 做法是 `routers/user.ts + routers/post.ts` 各自成文件，再在 `_app.ts` merge，另有 `t.mergeRouters` 展平命名空间。
  - https://trpc.io/docs/server/routers · https://trpc.io/docs/server/merging-routers
- 适合：3 人以上、按业务域分工；找文件：先定 feature，再定层。防循环：lint zones（方向约束）+ app 层唯一组装点。
- 对本仓结论：取"单向依赖 + 组装点上移"的思想：`shared/内核` 不许引用 `host/panel`；`host.ts/panel.ts` 这类入口只做组装。今天本仓正好反过来（神文件既装配又实现），这是重构要纠正的方向。

## 专题 A：barrel（index.ts 转出口）利弊

- 利（薄且只做出口时）：query-core 2KB index、Nest common 1.8KB index、Drizzle 根 435 字节 index——给调用方一个稳定入口，内部随便搬。
- 弊（官方原话）：bulletproof-react 结构文档——"过去推荐 barrel，但它会干扰 Vite tree-shaking 并引发性能问题，因此建议直接导入文件。"另 `import/no-cycle` 文档提醒全量环检测很贵，barrel 会把依赖图连成一片、放大该成本。
- 最完整的" curated 公开面"样本是 Effect 的 `exports`：按域给 barrel（`./schema → ./dist/schema/index.js`…）+ 通配 `./* → ./dist/*.js` 深导入，同时把 `./*/index`、`./index`、`*/internal/*` 全部置 null——**公开 barrel 精选、内部路径封死**。
  - https://github.com/Effect-TS/effect/blob/main/packages/effect/package.json
- 对本仓结论：`package.json` 的 10 个 exports 条目就是本仓的"精选 barrel"，** intrinsic 已够用**。子目录内不要再加聚合 `index.ts`（会与 `exports` 的深路径打架，且本仓已有 `./log → dist/log/index.js` 靠的是真实文件而非转出口，不要混淆两种机制）。

## 专题 B：单包库拆目录后 dist 输出路径的常见处理

- 本仓现状已决定答案：`build.mjs` 是 src→dist 同构映射，拆目录 = dist 自动多一层，**零构建改动**（`collectUnits` 递归已支持子目录，`src/log/` 就是活先例）。
- 业界两种处理（本仓适用第一种）：
  1. **同构映射 + exports 补子路径**：Effect `publishConfig.exports` 把 `./schema` 钉到 `./dist/schema/index.js`；本仓 `./log → ./dist/log/index.js` 同理。内部搬家自由，公开 exports 冻结。
  2. **bundler 打包入口重映射**：Vite Library Mode `build.lib.entry + fileName`（单/多入口对象），产物名与源码树脱钩。——这是打包型库的做法，本仓是逐文件转译，不适用。
     - https://vite.dev/guide/build（Library Mode 节）
- 硬约束：tests 174 处深引 `../dist/*.js`，**搬一个文件就要同步改其测试引用**（或一次性 codemod 全量替换）；以及 `files: ["dist", …]` 只发 dist，目录重组不影响发布清单。

## 专题 C：神文件（3000+ 行）先拆文件还是先搬目录

- 业界答案一致：**先拆文件，后搬目录**。
  - tRPC 官方："同一文件写全部 API 会 unwieldy"→先拆 `user.ts/post.ts` 再 merge，顺序写死。
  - Vite：`config.ts` 91KB 照样留在 `node/`，靠"一文件一职责 + 下沉子目录（plugins/server/ssr）"管理——目录是拆分的结果，不是前提。
  - query-core：`queryClient.ts` 40KB 可以存在，因为它就是"client"一个概念；反例警示：概念混杂的大文件没有任何业界样本背书。
- 对 `panel.ts`（3789 行）结论：先在原地按渲染区块拆成 `panel/` 下多文件（view-model / css tokens / render / mount / archive… 每块独立可测），**保持 `dist/panel.js` 路径不变**（同名薄聚合），tests 零改动；拆完若 `panel/` 内聚成立，再考虑 `host/`、`core/` 等目录。搬目录解决"找得到"，只有拆文件解决"改得动"，顺序不可反。

## 一页：推荐做法 / 不推荐做法（针对本仓）

| # | 推荐 | 不推荐 | 依据 |
|---|------|--------|------|
| 1 | 先拆 `panel.ts` 等 8 个 1000+ 行文件，一文件一职责；`dist/<名>.js` 路径保持不变，tests 零改动 | 先建 `src/{core,panel,host}/` 空目录再搬神文件（问题跟着文件走，评审也看不出边界） | tRPC merge routers；Vite node/ 大文件管理 |
| 2 | 目录按"运行时×挂载形态"划：`core/`（纯判定/执行，双环境）`panel/` `host/` `shared/`（codes/lang/config/…），`*-batch` 收进各形态目录 | 按"技术层"划 `utils/types/lib` 大杂烩目录（本仓已有教训：顶层即杂烩） | Vite 环境分层；Drizzle 按目标垂直分 |
| 3 | 公开面冻结：10 个 exports 条目不动；内部深路径直引，不新增聚合 barrel | 子目录各加 `index.ts` 转出口（与 exports 深路径打架、放大环检测成本） | Effect exports（null 封内部）；bulletproof-react 反 barrel 原话 |
| 4 | 立两条例：① `core/shared` 禁止引用 `host/panel`（单向）；② 新增 `import/no-cycle`（先 warn，接受其 lint 成本提示） | 靠"自觉"维持方向；神文件继续既实现又组装 | bulletproof zones；no-cycle 规则文档 |
| 5 | 拆目录当天用 codemod 同步改 tests 的 `../dist/` 深引用；`src/log/` 当迁移模板（唯一已验证的子树先例） | 只搬 src 不改 tests（174 处引用会逐个爆炸；build 注释已预警"测试直接引用 dist 会过期"） | build.mjs 头注；package.json `pretest → build` |
| 6 | 不要拆 `packages/` monorepo（单发布单元，零收益） | 为"未来可能拆包"提前付 monorepo 成本 | 六家全用 monorepo 恰因多发布单元，本仓单 `name` |
