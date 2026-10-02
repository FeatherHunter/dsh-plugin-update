# changelog 规则与展示最优形态取证（wayfinder #10 / 子票 #11）

- 取证方式：AFK research，只认一手来源；仓库本地只读核对，不改代码不改票。
- 取证日期：2026-10-01；仓库状态：`0.2.0`（`package.json`）。
- 结论先行：**插件作者提供方式选「包内 `CHANGELOG.md」**（不要仓库 URL）；格式用
  Keep-a-Changelog 子集；文件放**包根并进发布白名单**，`registry description`
  保持一句话简介不塞日志；缺日志时面板中性提示、**不挡安装**。

## 1. 仓库现状核对（只读）

1. `README.md` §5（§5.1–§5.5）只有快照六字段、八种 `blockedReason`、手工命令、
   待重启横幅、轮询与凭证——**没有任何 changelog / 更新说明字段与 UI 约定**。
   （来源：`README.md:177-233`）
2. `src/service.ts` `validVersion` 只认纯数字三段
   `/^\d+\.\d+\.\d+$/`，`compareVersions` 入参非三段即抛 `invalid-release`；
   `fetchNpmRelease` 只问 `${registry}${name}/latest`，只读
   `name/version/engines/dist` 四处，不读 `description`，更没有 changelog 字段面。
   （来源：`src/service.ts:46-48`、`65-74`、`170`、`180-186`）
3. `docs/host-install-exits.md` 三条安装出口契约无 changelog 相关形状；
   附带证据：取证时宿主自身版本为 DSH `0.2.0-rc.2`（预发布版本号在生态内真实存在）。
   （来源：`docs/host-install-exits.md:6-9`）
4. `docs/maintainers.md` 冻结项：默认电话名、入参回参形状、配置写法、配方五键、
   事件字段基线、默认旧路径；发布白名单 `files` 共 5 项
   （`dist`、`derive-client-values.mjs`、`event-list.template.json`、`README.md`、
   `LICENSE`），**无 `CHANGELOG.md`**；加文件进包须同步改 `files` 并重跑
   `npm publish --dry-run` 核对文件数。（来源：`docs/maintainers.md:49-50`、`80-81`）
5. 全仓 `grep (?i)changelog` 零命中；无 `research/` 惯例、无 `docs/adr/`、
   无 `CONTEXT.md`（`AGENTS.md` 提及但文件不存在）——本文件即新建
   `research/changelog-optimal-form.md` 首例。（来源：本机只读核对，2026-10-01）

## 2. 一手来源与每条结论的回链

### 2.1 npm registry 元数据没有 changelog 通道

- `GET https://registry.npmjs.org/dsh-plugin-update/latest` 实测返回含
  `name/version/description/engines/dist(tarball+integrity)/repository/homepage/bugs`，
  **无任何 changelog / release-notes 内容字段**。
  （来源：registry `/latest` 实测 JSON，2026-10-01）
- 同一实测中 `description` 是一句话简介
  （“可复用的更新系统装成的 npm 包…”），`dist.fileCount: 14` 说明 tarball 内容由
  包内文件清单决定。（来源：同上）
- `package.json` 的 `description` 字段定义为短简介（搜索页与列表页展示位），
  不是日志通道；`files` 数组决定进包文件。
  （来源：<https://docs.npmjs.com/cli/v11/configuring-npm/package-json/> `description` / `files` 节；
  本地 `package.json:19-25` 佐证白名单现状）
- 推论：凡走“仓库 URL”（GitHub Releases API / tag 包 raw 文件）取日志，
  都会新增一个信任根与网络面（认证、限流、可用性），而本包的联网政策是
  “只问官方源、官方源不可达时诚实失败不换源”（`README.md:167-168`）。
  包内文件则复用**已有信任根**（官方源 tarball＋`integrity` 校验，
  `src/service.ts:33`、`192-209`），不新增源。——这是“二选一选包内文件”的决定性理由。

### 2.2 文件名与位置惯例：包根 `CHANGELOG.md`

- “What should the changelog file be named?” 答：叫它 `CHANGELOG.md`；
  别用 `HISTORY/NEWS/RELEASES` 增加用户寻找成本。
  （来源：<https://keepachangelog.com/en/1.1.0/> `#filename` 节）
- 同一规范要求 changelog 面向人类、每版一条、最新在前、日期展示、版本可链接、
  顶部保留 `Unreleased` 区攒未发布改动。
  （来源：同上 `#how` / `#principles` / `#effort` 节）
- TS/npm 层面：包根 `CHANGELOG.md` 随 tarball 分发是事实标准做法；
  本包 `files` 白名单机制（`docs/maintainers.md:47-50`）就是为此准备的扩展点——
  加 `CHANGELOG.md` 进 `files` 即可随包分发，面板离线可读、与版本 pin 绑定。
- `registry description` 不塞日志：它是搜索展示位（见 2.1），且
  `fetchNpmRelease` 有 `MAX_METADATA_BYTES = 256 * 1024` 元数据上限
  （`src/service.ts:32`、`177-179`）——日志塞元数据与该上限精神相悖。

### 2.3 格式子集：Keep-a-Changelog 子集

采用子集（面板**必须渲染**三类＋**透传**三类＋忽略两类）：

- 必须渲染：`Added`（新功能）、`Fixed`（修 bug）、`Changed`（既有行为变更）。
  （来源：<https://keepachangelog.com/en/1.1.0/> `#types` 节——六类定义拥有者）
- 透传折叠（原样展示、不解析、不参与“有无新版”判断）：
  `Deprecated` / `Removed` / `Security`。（来源：同上 `#types` 节；
  另 `#ignoring-deprecations` 要求破坏性变更必须醒目，故透传而非丢弃）
- 面板忽略：`Unreleased` 区（未发布，不对应任何可装版本）与空节。
  （来源：同上 `#effort` 节；`#0.0.4` 条目“删掉空节”）
- 版本标题形如 `## [x.y.z] - YYYY-MM-DD`（ISO 8601，大到小排列），最新在前，
  标题可链接；`[YANKED]` 标记仅作**文本提示**，不做机器信号
  （本包通道表达不了 yanked，见 §3）。
  （来源：同上 `#confusing-dates` / `#yanked` 节）
- 禁止把 git log 直接倒进 changelog（噪声：合并提交、含糊标题、文档改动；
  changelog 条目面向人类、是对多提交的“值得注意的差异”的策展）。
  （来源：同上 `#log-diffs` / `#inconsistent-changes` 节）
- GitHub Releases 是“非便携 changelog，只能在 GitHub 上下文展示”
  （来源：同上 `#github-releases` 节）——这正是数据源不选仓库 URL 的第二理由；
  仓库 URL 可保留为作者主页链接，但不是 changelog 数据源。

### 2.4 缺日志：提示但不挡安装

- 本包既有政策是“诚实失败＋手工兜底”，失败形状不变、消费方匹配前缀码
  （`README.md:166-169`、`src/service.ts:388-392`）。缺 changelog 的严重性远低于
  装失败，故只能是**中性提示**（如“作者未提供更新说明”），不得进
  `blockedReason`、不得翻转 `canInstall`。
- 快照六字段与冻结项稳定（`README.md:293-296`、`docs/maintainers.md:80`），
  changelog 必须以**新增可选字段或独立纯函数**承载，不得改六字段形状。
  TS 层先例：`README.md` §8 的事件清单检查器就是“纯函数、不新增日志事件”的
  扩展范式；changelog 解析器应同为零依赖纯函数
  （如 `parseChangelog(markdown): entries`），与 `src/service.ts`“零导入”
  风格一致（`src/service.ts:7`）。

## 3. prerelease 通道对 changelog 规则的影响（支持与否＋如何影响）

**不支持预发布安装通道；changelog 规则必须与之同口径。**

- `validVersion` 拒绝一切预发布（`0.2.0-rc.2` 进去是 `false`），远端回包版本若为
  预发布即判 `invalid-release`；`compareVersions` 遇非三段直接抛错。
  （来源：`src/service.ts:46-48`、`65-74`、`186`）
- `buildSnapshot` 的 `canInstall` 要求 `validVersion(runningVersion)` 为真——
  运行中版本若是预发布，安装门恒为假（不崩溃，只关门）。
  （来源：`src/service.ts:301-310`）
- 联网只问 `/latest`，而 npm 的 `latest` dist-tag 默认不指向预发布版本
  （预发布须显式打 tag 才会成为 `latest`）。
  （来源：<https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/>；
  佐证：registry 实测 `latest = 0.2.0` 纯三段）
- SemVer 规定预发布（`-rc.1` 等）优先级低于其正式版、标识符有独立比较规则。
  （来源：<https://semver.org/spec/v2.0.0.html> 第 9、11 条）
- 因此 changelog 规则受三条硬约束：
  1. “两版之间有何新内容”的**机器计算只认纯三段标题**；`Unreleased` 与
     `x.y.z-rc.n` 等预发布节仅供人读，不参与版本比较（比较函数见 §2.4 引用，
     预发布标题传进去会抛 `invalid-release`）。
  2. 允许作者写预发布节（人读有益），但面板不得将其渲染成“可装新版”——
     否则与 `canInstall` 门矛盾。
  3. 将来若要开预发布通道，那是独立功能（新 dist-tag＋放宽 `validVersion`＋
     快照语义变更），须先走破冰讨论（冻结项纪律，`docs/maintainers.md:80`），
     不在本取证范围内默认开启。

## 4. 给插件作者的输出（#11 要求的二选一＋三要素）

1. **提供方式：包内 `CHANGELOG.md`（唯一推荐）。** 不选仓库 URL。
   理由回链：§2.1（registry 无 changelog 字段＋新信任根问题）、
   §2.2（Keep-a-Changelog 文件名规范）、`#github-releases` 非便携性。
2. **格式子集**：`## [x.y.z] - YYYY-MM-DD` ＋ `Added/Fixed/Changed` 必写，
   `Deprecated/Removed/Security` 有则透传，`Unreleased` 可留但面板忽略，
   禁止 git-log 直倒。理由回链：§2.3。
3. **位置**：包根 `CHANGELOG.md`，并进 `package.json` `files` 白名单
   （当前 5 项→6 项，按 `docs/maintainers.md:49-50` 同步改＋dry-run 核对）；
   `description` 保持一句话。理由回链：§2.1、§2.2。
4. **缺日志行为**：面板中性提示（“作者未提供更新说明”），安装按钮状态不变，
   不写 `blockedReason`，不动快照六字段。理由回链：§2.4。
5. **读取时机建议**：已装版的说明离线读
   `node_modules/<目标包>/CHANGELOG.md`（与版本 pin 绑定，零新增联网）；
   新版说明按需取新版 tarball 内同名文件（复用官方源＋`integrity` 校验），
   取不到即回落到第 4 条的中性提示。

## 5. 待验证／非结论

- `package.json` 文档页本次抓取被截断，`description`/`files` 定义以 npm 官方文档
  URL 为准，条文细节待实现票复核时再对一遍。
  （来源：<https://docs.npmjs.com/cli/v11/configuring-npm/package-json/>）
- GitHub Releases 说明页本次抓取被截断，本取证对其的引用仅限 Keep-a-Changelog
  `#github-releases` 节的转述，不做独立断言。
- `research/` 无前例，本文件为首例；后续取证沿用“结论＋逐 claim 回链”结构。
