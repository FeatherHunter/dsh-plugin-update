# 第三方插件使用更新日志（changelog）功能调研

> 调查时间：2026-10-05 ｜ 调查方式：只读（read / grep / glob，未改仓内任何文件）
> 被调查仓：dsh-plugin-update，版本 `0.3.1`（来源：`package.json:3`）
> 存放选址：`docs/research/` —— 本仓已有同类调研笔记惯例（`docs/research/20261004-ilife-多插件更新调查.md`、`docs/research/20261005-issue-29-http-gap-adversarial-review.md`，均为 `YYYYMMDD-<主题>.md`），故跟随该目录与日期前缀命名；仓根 `research/` 仅有一篇旧取证（`research/changelog-optimal-form.md`，2026-10-01），不是现行惯例。

## 0. 结论摘要

1. **数据源唯一推荐：第三方插件包内的包根 `CHANGELOG.md`**（不要仓库 URL / GitHub Releases）。格式为 Keep-a-Changelog 子集，文件须进 `package.json` `files` 白名单，`description` 保持一句话简介不塞日志。（来源：`research/changelog-optimal-form.md:5-7,128-144`；`src/changelog.ts:1-20` 头注；`src/changelog-io.ts:1-12` 头注）
2. **作者侧要写什么**：包根 `CHANGELOG.md`（文件名大小写敏感，必须是全大写）；版本节 `## [x.y.z] - YYYY-MM-DD`（最新在前）；分类 `### Added/Fixed/Changed` 必写（面板展开），`### Deprecated/Removed/Security` 有则透传折叠；`Unreleased` 与空节面板忽略；禁止 git-log 直倒。**无 frontmatter、无专用版本约束字段、无 `getChangelog` 式 API**——解析只认 `##`/`###`/`-/\*/+` 列表。（来源：`src/changelog.ts:42-66,107-119,133-215,245-300,311-394`；`CHANGELOG.md:1-3` 自例；`research/changelog-optimal-form.md:67-88`）
3. **主机侧不自动读/不自动展示**：快照恒为六字段（`installedVersion/runningVersion/latestVersion/canInstall/blockedReason/job`），changelog 不进快照、不进 `blockedReason`、不影响 `canInstall`。（来源：`README.md:345-356`；`src/changelog.ts:12-19`；`src/panel.ts:1193-1223` 注释“缺日志不挡安装、不改门控”）
4. **集成方（第三方插件作者/宿主接线人）必须自己备文本再传入面板**：已装版用包根导出的 `readInstalledChangelogText(targetPackageDir)` 离线读本机 `node_modules/<目标包>/CHANGELOG.md`；新版用 `fetchReleaseChangelogText(fetchImpl, { tarball, integrity, version }, { targetPackageName, registryUrl })}` 按需取新版 tarball 内同名文件（复用官方源 + `integrity` 校验，任何失败回 `null`）；拿到 Markdown 后经 `mountUpdatePanel({ changelogMarkdown })` 传入或事后 `panel.setChangelogMarkdown(md)` 更新；面板第 02 章“更新日志”按“当前版 → 新版”区间渲染。（来源：`README.md:425-429`；`src/changelog-io.ts:65-89,260-346`；`src/host.ts:99-130` 转出口；`src/panel.ts:91-95,116-120,1117-1123,1193-1223,1452-1453,1721-1723`）
5. **版本口径与更新通道一致**：changelog 区间筛选只认发行版本号（`validReleaseVersion`：纯三段 `X.Y.Z` 或 `X.Y.Z-ids`，拒绝 `+build`；来源 `src/service.ts:89-99`）；默认 `stable` 通道只收纯三段，显式 `releaseChannel: 'prerelease'` 才收预发布（来源：`src/service.ts:65-110`；`README.md:318,413-417`）。区间为 `(fromExclusive, toInclusive]`，from 取运行版（回落已装版），to 取远端版；任一非法即无内容回中性提示。（来源：`src/changelog.ts:235-300`）
6. **README 有介绍（§5.8），但只算“及格线”**：位置/格式/缺日志行为/读取时机/API 名/传入点都点到了（三条 bullet，`README.md:425-429`），但缺少端到端代码示例、文件名大小写敏感、版本标题写法、解析边界（截断上限/围栏/YANKED）、entry/批量路径不支持的声明、第 8 节导出清单漏项。详见第 3 节；文档与实现不一致见第 5 节。

## 1. 第三方接入步骤（最小可用，一步一步）

> 约定：你的插件包名为 `my-notes-plugin`，电话前缀为 `notes`（与 `README.md:27-53` 三步接入同例）。

### 步骤 1：给自己的插件包写 `CHANGELOG.md`（包根）

按 Keep-a-Changelog 子集写（来源：`src/changelog.ts:42-66` 六类定义；`CHANGELOG.md:1-3` 本包自例即模板）：

```md
# Changelog

## [Unreleased]

## [1.2.0] - 2026-10-05

### Added
- 新增导出某某功能

### Fixed
- 修复某某闪退

### Changed
- 调整某某默认行为

### Security
- 收紧某某鉴权（有则写，没有可整节省略；面板折叠展示）
```

必须遵守（来源均为 `src/changelog.ts` 实现，括号内为行号）：

- 文件名必须是全大写 `CHANGELOG.md`，小写 `changelog.md` 等变体视为缺日志（来源：`src/changelog-io.ts:174-186` 大小写敏感判定）。
- 版本标题用 `##`（`###` 是分类标题）；版本号在标题任意位置出现即收，形如 `## [1.2.0] - 2026-10-05`、`## Version 1.1.0`、`##[1.1.0]`、可链接标题均可；日期取标题内 `YYYY-MM-DD`（来源：`src/changelog.ts:107-119,168-181`）。
- 分类标题 `### Added` 等六类大小写不敏感；其余三级标题直接无视；条目只认 `-`/`*`/`+` 开头；缩进续行拼入上一条，顶格段落忽略；围栏代码块内 `##` 不当标题（来源：`src/changelog.ts:182-209`）。
- `Unreleased` 节保留但渲染与区间筛选时忽略；六类全空的版本节直接丢弃（来源：`src/changelog.ts:144-159,235-274`）。
- `[YANKED]` 仅作“已撤回”文本提示，不做机器信号（来源：`src/changelog.ts:73-78,318`）。
- 上限（超限截断不断面板、不抛错）：输入 64KB（`CHANGELOG_MAX_CHARS`）、最多 100 节、每类最多 200 条、单条最多 500 字（来源：`src/changelog.ts:33-40`）；tarball 压缩态 8MB、解压后 32MB、防 gzip 炸弹（来源：`src/changelog-io.ts:21-31,341`）。
- **不需要** frontmatter，不需要声明版本约束字段：解析器是零依赖纯字符串切分（来源：`src/changelog.ts:1-20`“零导入”）。
- 版本号写法须过 `validReleaseVersion`（纯三段或 `X.Y.Z-ids`，`+build` 拒绝；来源 `src/service.ts:89-99`），否则区间筛选直接忽略该节（来源：`src/changelog.ts:258-262`）。

### 步骤 2：把日志文件发进 npm 包

`package.json` 的 `files` 白名单加 `CHANGELOG.md`（`description` 保持一句话简介，不要塞日志；来源：`research/changelog-optimal-form.md:61-65,136-138`），然后  deadpan `npm publish --dry-run` 核对文件数（来源：`docs/maintainers.md:57-62`）：

```json
{ "files": ["dist", "CHANGELOG.md", "README.md", "LICENSE"] }
```

> 本包自己就是这样发的：`package.json:47-53` `files` 6 项含 `CHANGELOG.md`，有测试锁死（来源：`tests/changelog.test.mjs:275-279`）。

### 步骤 3：宿主侧备好两份文本（已装版离线读 + 新版按需取）

这是最关键的一句：**更新包不会替你读，`updateStatus/updateCheck` 回包里也没有 changelog 字段**（来源：`README.md:72-86` 回包契约无 changelog；`README.md:429` “说明文本由集成方备好后传入”；`src/panel.ts:91-95` “面板只渲染不取数”）。集成方在宿主侧（Node 侧，面板浏览器闭包永不导入 `changelog-io`；来源 `src/changelog-io.ts:1-12`）这样备：

```js
import { readInstalledChangelogText, fetchReleaseChangelogText } from 'dsh-plugin-update'
// readInstalledChangelogText / fetchReleaseChangelogText 经包根转出口（来源：src/host.ts:121-130）

// 已装版：离线读本机 node_modules/<目标包>/CHANGELOG.md（与版本 pin 绑定，零新增联网）
const installedMd = await readInstalledChangelogText(targetPackageDir)
// targetPackageDir 即 createHostUpdate 定位到的目标包目录，
// 定位对不上时可用 readerOverrides.targetPackageDir 显式交（来源：README.md:60-68）

// 新版：按需取新版 tarball 内同名文件（复用官方源 + integrity 校验）
// release = { tarball, integrity, version }（service.fetchNpmRelease 回的发行信息原样），
// tarball 须是 https、同官方源 origin、无用户信息、无 search/hash、.tgz 结尾，
// 有包名+版本时还要求精确路径 /<包>/-/<包>-<版>.tgz，否则回 null（来源：src/changelog-io.ts:260-299）
const latestMd = await fetchReleaseChangelogText(fetch, release, { targetPackageName, registryUrl })

// 取不到一律回 null → 面板渲染中性提示，不挡安装（来源：src/changelog-io.ts:255-259）
```

展示用哪一份、如何合并，由集成方决定；面板只收**一份** Markdown 字符串并按“运行版 → 远端版”区间自行筛选（来源：`src/panel.ts:1196-1206`）。

### 步骤 4：把文本交给面板（单插件整组件路径）

```js
import { mountUpdatePanel } from 'dsh-plugin-update/panel'

const panel = mountUpdatePanel(document.getElementById('update-slot'), {
  pluginId: 'my-notes-plugin',
  prefix: 'notes',
  call: (name, args) => host.call(name, args),
  changelogMarkdown: installedMd ?? latestMd ?? null, // 取不到传 null/空串即中性提示
})

// 查到新版后换一版文本（只换日志节，安装门控只跟快照，一字不动）：
panel.setChangelogMarkdown(latestMd ?? null) // 来源：src/panel.ts:116-120,1721-1723
```

渲染规则（来源：`src/panel.ts:1193-1223`；`src/changelog.ts:322-394`）：第 02 章“更新日志”恒在；标题为“更新说明（当前版 → 新版）：”；`Added/Fixed/Changed` 展开，`Deprecated/Removed/Security` 以 `<details>` 折叠（含条数）；输出已转义可直接拼入面板。

HTTP 直挂同样可透传（`UpdatePanelHttpOptions extends Omit<UpdatePanelOptions,'call'|'prefix'>`，其余经 `...panelRest` 透给 `mountUpdatePanel`；来源 `src/http.ts:326-350`），即 `mountUpdatePanelHttp(el, { pluginId, prefix, baseUrl, changelogMarkdown })` 也成立（README 的 HTTP 示例未写这一项，见第 5 节）。

### 步骤 5：验证

1. 有新版时第 02 章出现区间内容（只含 `(运行版, 远端版]` 内的节；已是最新/版本非法即中性提示；来源 `src/changelog.ts:280-300`）。
2. 删掉/清空 `CHANGELOG.md` 后面板显示中性提示，且安装按钮状态不变（缺日志永不挡安装，不写 `blockedReason`；来源 `src/changelog.ts:12-19`、`src/panel.ts:1212-1222`）。
3. 用入口件（`mountUpdateEntry`）或批量面板打开时**看不到**真实日志——这是已知限制（见第 5 节），验收时以单插件整组件为准。

## 2. 主机侧如何读取 / 展示（含 API 清单）

| 环节 | 函数 / 位置 | 说明与来源 |
|---|---|---|
| 常量与类型 | `CHANGELOG_FILENAME='CHANGELOG.md'`、`CHANGELOG_NEUTRAL_HINT/LINE`、`CHANGELOG_MAX_*`、`CHANGELOG_ALL_CATEGORIES/MUST_SHOW/FOLDED/CATEGORY_ZH`、`ChangelogCategory/ChangelogEntry`（来源：`src/changelog.ts:24-81`） | 面板双语标题如 `Added · 新增`（来源：`src/changelog.ts:58-66,326`） |
| 纯解析（零依赖，两边可进） | `parseChangelog(markdown): ChangelogEntry[]` 永不抛错（来源：`src/changelog.ts:133-215`） | 非字符串/空串回 `[]`；未知版本标题与其下条目丢弃 |
| 区间筛选 | `selectChangelogEntries(entries, fromExclusive, toInclusive)`、便捷口 `changelogForUpdate(entries, runningVersion, latestVersion, installedVersion?)`（来源：`src/changelog.ts:245-300`） | 只收发行合法版；预发布节在区间内一并收录、人读完整，但面板永不拿它做安装分支（来源：`src/changelog.ts:239-244`注释） |
| 渲染 | `renderChangelogSection/renderChangelogHTML/renderChangelogNeutral/hasVisibleSections/isUnreleasedVersion`（来源：`src/changelog.ts:311-394`） | 无内容一律回中性提示 |
| Node 侧 I/O（仅 Node 侧导入） | `readInstalledChangelogText(targetPackageDir, { maxBytes? })`（来源：`src/changelog-io.ts:65-89`）；`fetchReleaseChangelogText(fetchImpl, release, opts)` + `extractChangelogFromTar` + `ReleaseChangelogRef`（来源：`src/changelog-io.ts:91-99,192-346`） | 失败一律 `null`；`integrity` 须过 `INTEGRITY_PATTERN`（来源：`src/changelog-io.ts:276`）；同源 + tarball 路径精确校验 |
| 包根转出口 | `src/host.ts:99-130`（纯函数 + I/O + 类型全转出）；`src/panel.ts:1793-1814` 与 `src/client.ts:68-76` 转出纯函数子集 | **无 `getChangelog` 之名单一 API**：读取（I/O）与渲染（纯函数）是分开的两组，须集成方拼起来 |
| 面板接入点 | `UpdatePanelOptions.changelogMarkdown?`（来源：`src/panel.ts:91-95`）、`UpdatePanelController.setChangelogMarkdown`（来源：`src/panel.ts:116-120`）、内核 `renderUpdatePanelHTML(input)` 读 `input.changelogMarkdown`（来源：`src/panel.ts:1117-1123`） | 面板只渲染不取数 |

快照契约重申：`updateStatus/updateCheck/updateInstall` 成功回包为 `{ ok:true, snapshot, manual, receipt }` 形状（来源：`README.md:72-86`），changelog 不在其中；面板档案五章中第 02 章恒在（来源：`README.md:141` “面板画成档案五章”；`src/panel.ts:1193-1223`）。

## 3. README 覆盖情况（逐段检查）

- **§5.8 “更新说明”（`README.md:425-429`）——唯一正面介绍该功能的三条 bullet，原文**：
  > “有新版时面板在横幅下方展示‘更新说明（当前版 → 新版）：’，按目标包内 `CHANGELOG.md`（Keep-a-Changelog 子集）渲染：`Added/Fixed/Changed` 展开，`Deprecated/Removed/Security` 折叠，`Unreleased` 与空节不展示。”
  > “作者未提供说明时显示‘作者未提供更新说明，安装不受影响。’——缺日志永不挡安装，不改变 `canInstall` 与 `blockedReason`。”
  > “说明文本由集成方备好后传入：已装版离线读本机 `node_modules/<目标包>/CHANGELOG.md`，新版按需取新版 tarball 内同名文件（复用官方源与 `integrity` 校验，取不到即回落中性提示；参考包根导出的 `readInstalledChangelogText` / `fetchReleaseChangelogText`），经 `mountUpdatePanel({ changelogMarkdown })` 或 `setChangelogMarkdown` 交给面板。”
  评价：**方向全对**（数据源、格式子集、缺日志语义、读取时机、传入点五个要点与实现一致），但**只有“点名”没有“教会”**。
- **第 2 节三步接入（`README.md:27-199`）**：未提及 changelog。宿主接线、面板派生、整组件挂载示例均未带 `changelogMarkdown` 参数——按此节照抄的第三方面板第 02 章永远是中性提示。
- **第 2.5/2.6 节（入口件/批量，`README.md:162-276`）**：未提及 changelog，且未声明“入口件打开的面板 / 批量详情无日志”（实现确无转发，见第 5 节）。
- **第 3 节配置表（`README.md:292-323`）**：未提及（正确：changelog 无配置键，面板参数而非宿主配置；但无一句指引跳 §5.8）。
- **§5.1 快照六字段（`README.md:345-356`）**：未提及 changelog（正确：快照确实无该字段；但无一句“日志不进快照”易让读者翻找）。
- **第 8 节“包还导出什么”（`README.md:459-505`）**：未提及 changelog 相关导出（整组件/客户端入口/事件检查器/宿主工具/跨插件队列五组均无），而实现上包根实际导出了 11 个纯函数 + 类型 + 3 个 I/O + 1 类型（来源：`src/host.ts:99-130`）。**漏项**（见第 5 节）。
- **第 6 节排错、第 7 节自检清单**：未提及 changelog（如大小写写错文件名的排查条目缺失）。
- **充分性结论**：§5.8 让“知道有这个功能”成立；但“照着做出来”不成立——缺端到端代码（尤其 `fetchReleaseChangelogText` 的 `release { tarball, integrity }` 从哪来）、缺文件格式写法示例（版本标题形如 `## [x.y.z] - YYYY-MM-DD` 只在 `CHANGELOG.md:3` 与旧取证里有，README 正文中无）、缺边界声明（大小写敏感、截断上限、YANKED、无快照字段、entry/batch 限制）。

## 4. 来源引用（一手来源清单）

- `README.md:425-429`（§5.8 三条 changelog bullet）、`README.md:27-53`（三步接入假设）、`README.md:60-68`（`readerOverrides.targetPackageDir`）、`README.md:72-86`（三电话回包契约）、`README.md:345-356`（快照六字段）、`README.md:459-505`（第 8 节导出清单）
- `package.json:3`（版本 0.3.1）、`package.json:16-44`（8 个子路径出口）、`package.json:47-53`（files 6 项含 CHANGELOG.md）
- `CONTEXT.md:1-21`（仅诊断术语，无 changelog——反向证据：该功能未进 domain 上下文）
- `docs/maintainers.md:57-62`（发布白名单 6 项 + dry-run 纪律）、`docs/maintainers.md:61`（8 子路径 + 新开子路径纪律）
- `src/changelog.ts:1-20`（模块头注：取证承接 + 零依赖）、`:24-40`（文件名/中性提示/上限常量）、`:42-81`（六类 + 接口）、`:107-119`（版本日期提取）、`:133-215`（parse）、`:235-300`（区间筛选）、`:311-394`（渲染）
- `src/changelog-io.ts:1-12`（头注：I/O 仅 Node 侧）、`:21-31`（tarball/tar/文本上限与默认源）、`:65-89`（已装版离线读）、`:174-186`（文件名大小写敏感）、`:192-259`（tar 取同名文件）、`:260-346`（新版按需取 + 同源/integrity/路径校验）
- `src/host.ts:99-130`（包根转出口：纯函数 11 + I/O 3 + 类型 2）、`src/panel.ts:91-95,116-120,1117-1123,1193-1223,1452-1453,1721-1762,1793-1814`（面板接入/内核/挂载/set/转出口）、`src/client.ts:68-76`（客户端转出口纯函数）、`src/http.ts:326-350`（HTTP 面板透传 changelogMarkdown）
- `src/entry.ts:58-76`（入口件选项无 changelog）、`src/entry.ts:347-359`（打开面板不转发 changelog）、`src/panel-batch.ts:590-607`（批量详情 `renderUpdatePanelHTML` 不传 changelog）
- `src/service.ts:61-110`（validVersion/validReleaseVersion/通道）、`src/service.ts:145-157`（compareReleaseVersions）
- `CHANGELOG.md:1-8`（本包自例格式）、`research/changelog-optimal-form.md:5-7,67-144`（取证结论与作者三要素）、`tests/changelog.test.mjs:275-279`（files 白名单测试）

## 5. 文档与实现不一致 / 边界缺口

1. **第 8 节导出清单漏 changelog**：README 第 8 节列 5 组导出、无 changelog；实现上包根转出口 11 纯函数 + 3 I/O（来源：`src/host.ts:99-130`），`panel`/`client` 亦有转出口（来源：`src/panel.ts:1793-1814`；`src/client.ts:68-76`）。建议在第 8 节补一组“更新日志（纯函数 + Node 侧读写）”。
2. **中性提示文案有三句，README 只写一句**：README 与 `CHANGELOG_NEUTRAL_LINE` 均为“作者未提供更新说明，安装不受影响。”（来源：`README.md:428`；`src/changelog.ts:31`）；但面板内核在“有快照无新版/日志读坏”时分别用“还没查到新版；查到后再显示日志。”与“日志读不出来，安装不受影响。”（来源：`src/panel.ts:1217-1221`）。三句语义都“不挡安装”，但文档只承诺一句，断言文案的测试应以实现为准。
3. **入口件路径无日志且未声明**：`UpdateEntryOptions` 无 `changelogMarkdown`（来源：`src/entry.ts:58-76`），`mountPanel` 转发 6 项无日志（来源：`src/entry.ts:347-359`)——经入口件打开的 dialog 面板永远中性提示。README 第 2.5 节未声明此限制。
4. **批量详情无日志且未声明**：批量详情 `detailHTML` 调 `renderUpdatePanelHTML` 传 11 项、无 `changelogMarkdown`（来源：`src/panel-batch.ts:590-607`）——批量面板展开的详情第 02 章永远回落。README 第 2.6 节只写“五章内容一字不减”（来源：`README.md:255-260`)，与此矛盾（日志章内容实为回落提示）。
5. **HTTP 示例未提透传**：`mountUpdatePanelHttp` 实际支持 `changelogMarkdown` 透传（来源：`src/http.ts:326-350`），README 的 HTTP 示例（`README.md:147-160,239-250`）未提，读者会误以为 HTTP 版无日志。
6. **旧取证现状描述已过期（非结论性）**：`research/changelog-optimal-form.md:22-29` 称“files 无 CHANGELOG.md、无 CONTEXT.md”；现 `package.json:47-53` files 已含 `CHANGELOG.md`（测试锁死 `tests/changelog.test.mjs:275-279`），`CONTEXT.md` 已存在（但仍只讲诊断、无 changelog）。取证结论本身（包内文件 + 子集 + 白名单 + 中性提示）已全部落地，无需推翻；仅现状核对段过期。
7. **README 缺关键边界**：文件名大小写敏感（来源：`src/changelog-io.ts:174-186`）、版本标题写法示例、截断上限（来源：`src/changelog.ts:33-40`）、`fetchReleaseChangelogText` 入参 `release{ tarball, integrity, version }` 的来源（快照不带该信息，集成方须另从发行信息取——README 无一句说明）。

## 6. 遗留问题 / 建议

1. README §5.8 补最小端到端示例：含 `CHANGELOG.md` 版本节样例 + 步骤 3 的两行 I/O（含 `release` 来源说明）+ 步骤 4 的 `mountUpdatePanel`/`setChangelogMarkdown`（当前只有函数名，抄不跑）。
2. README 第 8 节补 changelog 导出组；第 2 节挂载示例加 `changelogMarkdown` 一行并指回 §5.8。
3. 明确 entry/批量路径现状二选一：要么声明“这两条路径暂无日志”（文档补限制），要么给 `UpdateEntryOptions`/`detailHTML` 加上转发（实现补齐；注意 `AGENTS.md` 约束——README 只留开发者手册口径，过程与票号不入 README）。
4. 统一中性提示对外承诺：要么三句全写进 README，要么内核收敛到一句（建议后者，断言更稳）。
5. 注明文件名大小写敏感与版本标题格式；排错节加一条“写成小写 changelog.md 即无日志”。
6. 本笔记未覆盖：批量多目标下“每家一份日志”的产品语义（实现上详情无入口，语义待定）；tarball 取日志的缓存/刷新策略（实现按需取、无缓存约定）。
