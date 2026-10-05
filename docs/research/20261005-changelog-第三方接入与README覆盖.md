# 第三方插件 changelog 接入链路与 README 覆盖调研

> 调研时间：2026-10-05 ｜ 方式：只读本仓库一手来源（README.md、CONTEXT.md、docs/、src/、package.json、tests/），未改代码。
> 选址说明：存放于 `docs/research/`。本仓有两个调研笔记位置：根下 `research/` 仅 1 份 2026-10-01 旧取证（`research/changelog-optimal-form.md`），而 `docs/research/` 有 2 份日期前缀新笔记（20261004、20261005），是当前沿用的惯例；本文件跟随后者命名（日期 + 主题）。

## 0. 结论摘要（先读这节）

1. **第三方插件用 changelog 分两个互不相干的角色**：(a) 当“被更新的目标包作者”——只写文件，零代码：包根放 `CHANGELOG.md`（大小写敏感）+ 进 `package.json` `files` 白名单，格式为 Keep-a-Changelog 子集；(b) 当“更新系统集成方”（依赖本包的插件）——宿主侧**零改动**（三个电话、快照六字段完全不变），面板侧**手动取数再传入**（`mountUpdatePanel({ changelogMarkdown })`，之后用 `setChangelogMarkdown` 更新）。**没有 `getChangelog` 之类的电话**；面板只渲染不取数，取数函数由包根导出、集成方自己调。
2. **README 只在 §5.8 用三条讲了该功能**，刚够知道“有这功能”，**不够照着接**：缺作者侧文件规范细节、缺 §8 导出清单、缺端到端接线示例，且漏掉了一个关键语义——面板要的是“含新版节的那份全文”（区间筛选在面板内做），只传已装版文本会恒显示中性提示，而 README 把两份文本并列一提、没讲传哪份。
3. **发现 3 处文档与实现不一致**（详见 §4）：批量面板详情第 02 章恒为中性提示（与 §2.6“一字不减”矛盾）；文件名大小写敏感实现严格、README 未说明；面板实际有三种中性文案、README 只提一种。

## 1. 完整使用链路

### 1.1 角色 A：目标包作者（被更新的那一方）——只写文件

| 要做的事 | 具体要求（来源） |
|---|---|
| 文件名与位置 | 包根 `CHANGELOG.md`，大小写敏感；`changelog.md` 等小写变体视为缺日志。来源：`src/changelog.ts:27`（`CHANGELOG_FILENAME`）、`src/changelog-io.ts:174-186`（`isChangelogEntryName` 注释明示“小写变体视为缺日志”）、`tests/changelog.test.mjs:435` 锁死该行为 |
| 进发布白名单 | `package.json` `files` 必须含 `CHANGELOG.md`，否则 tarball 里没有、面板永远读不到。本包自己就是这么做的（`package.json:43-50` 含 `CHANGELOG.md`，`tests/changelog.test.mjs:275-279` 断言白名单+包根文件双落地）。发布前跑 `npm publish --dry-run` 核对（惯例见 `docs/maintainers.md:59`） |
| 版本节格式 | `## [x.y.z] - YYYY-MM-DD`（方括号/链接可有可无，解析器按“标题中第一个三段形态”收；`##` 后空格都可省）。来源：`src/changelog.ts:96-114`（`extractVersionDateAndYanked`）。非法版本标题与其下条目一律丢弃；`Unreleased` 区保留解析但渲染与筛选恒忽略；空节版本直接丢弃。来源：`src/changelog.ts:146-152, 165-231`（`parseChangelog` 注释） |
| 分类格式 | `### Added/Fixed/Changed/Deprecated/Removed/Security`（大小写不敏感），条目用 `-/\*/+` 开头，续行只有缩进才拼入上一条，围栏代码块内一律忽略。来源：`src/changelog.ts:232-276`。`Added/Fixed/Changed` 展开，`Deprecated/Removed/Security` 折叠（`<details>`），来源：`src/changelog.ts:60-66, 323-348` |
| 不需要写的东西 | **无 frontmatter、无版本约束字段、无额外配置**：解析器只认 `##`/`###`/`-`，其余文本全部忽略（来源：`src/changelog.ts:165-231`）。`[YANKED]` 标记仅作“· 已撤回”文本后缀，不做机器信号（来源：`src/changelog.ts:96-114, 318`）。预发布节（`1.1.0-rc.1`）允许写、会被解析，但只在预发布通道下才可能进入展示区间（来源：`src/changelog.ts:249-279` 注释“通道门禁不在此做”＋ `src/service.ts:106-110` 通道定义） |
| 上限（作者无感，超了静默截断） | 全文 64KB、版本节 100、每类 200 条、单条 500 字。来源：`src/changelog.ts:43-56` |
| 缺日志后果 | 中性提示，不挡安装，不写 `blockedReason`，不动快照。来源：`src/changelog.ts:1-24` 头注、`src/panel.ts:91-95` 选项注释 |

最小作者侧示例（放到包根即可）：

```md
# Changelog
## [1.2.0] - 2026-10-01
### Added
- 新增导出 CSV
### Fixed
- 修复启动闪退
```

### 1.2 角色 B：更新系统集成方（依赖本包的插件）——宿主零改动，面板手动接线

**宿主侧：什么都不用加。** 三个电话入参与回参、快照六字段里没有任何 changelog 字段（来源：`README.md:72-86` 电话契约表；`src/service.ts` 全文 grep changelog 零命中；`CONTEXT.md` 只定义快照/错误码/诊断，无日志字段）。`createHostUpdate` 也无 changelog 相关配置（来源：`README.md:307-318` 配置表）。

**面板侧：三步。** 原理一句话：面板只渲染（`src/panel.ts:1194-1223` 内核第 02 章：`parseChangelog → changelogForUpdate(running→latest) → renderChangelogHTML`），文本由集成方备好传入（来源：`src/panel.ts:91-95`、`README.md:429`）。

1. 挂载时传入（可先 `null`，即中性提示）：

```js
import { mountUpdatePanel } from 'dsh-plugin-update/panel'
const panel = mountUpdatePanel(slot, {
  pluginId: 'my-notes-plugin', prefix: 'notes',
  call: (name, args) => host.call(name, args),
  changelogMarkdown: null, // 或已装版文本先顶上
})
```

2. 取已装版文本（离线读本机，零新增联网）：`readInstalledChangelogText(targetPackageDir)`（来源：`src/changelog-io.ts:65-89`，包根导出见 `src/host.ts:121-130`）。`targetPackageDir` 用 `resolveTargetPackage(targetPackageName)` 现算（来源：`src/reader.ts:92-99`，包根经 `README.md:495` 导出说明），或复用接线时那份 `readerOverrides.targetPackageDir`（来源：`README.md:60-68`）。
3. 查到新版后取新版文本并刷新面板：`fetchReleaseChangelogText(fetchImpl, { tarball, integrity, version }, { targetPackageName, registryUrl })`（来源：`src/changelog-io.ts:260-312`，包根导出见 `src/host.ts:121-130`）。其中 `tarball/integrity` 就是 `fetchNpmRelease` 回包里的同名字段、同一信任根（来源：`src/service.ts:304-327` 回 `{ version, nodeRange, integrity, tarball }`；`src/changelog-io.ts:2-12` 头注“复用官方源 + integrity 校验”）。拿到后调 `panel.setChangelogMarkdown(文本)`（来源：`src/panel.ts:116-120, 1721-1724`）；取不到传 `null` 即回中性提示。

**关键语义（README 没讲的）：面板要的是“含新版节的那份全文”。** 区间筛选 `changelogForUpdate(entries, runningVersion→latestVersion)` 取 `(from, to]`（from 取运行版、回退已装版；来源 `src/changelog.ts:280-300`）。若只传已装版文本（不含新版节），区间恒为空 → 恒中性提示。所以正确做法是传**新版 tarball 里那份全文**（天然含历史节），已装版文本只作“新版取不到时”的回退（此时大概率仍是中性提示，属正常回落）。

**API 全表（包根 `dsh-plugin-update` 经 `src/host.ts:99-130` 转导出；纯函数另经 `src/client.ts:68-76` 进浏览器闭包）：**

| 函数 | 落点 | 说明 |
|---|---|---|
| `parseChangelog / changelogForUpdate / selectChangelogEntries / renderChangelogHTML / renderChangelogSection / renderChangelogNeutral / hasVisibleSections / isUnreleasedVersion` | `src/changelog.ts` | 零依赖纯函数，两边可进（来源：`src/changelog.ts:28-36`） |
| `readInstalledChangelogText / fetchReleaseChangelogText / extractChangelogFromTar` + 常量 `CHANGELOG_*_BYTES / CHANGELOG_DEFAULT_REGISTRY` | `src/changelog-io.ts` | 仅 Node 侧，面板永不导入（来源：`src/changelog-io.ts:2-12`） |
| `mountUpdatePanel({ changelogMarkdown }) / setChangelogMarkdown` | `src/panel.ts:95, 120` | 单插件面板；HTTP 版 `mountUpdatePanelHttp` 经 `Omit<UpdatePanelOptions,"call"|"prefix">` 全透传，同样可用（来源：`src/http.ts:326-349`) |
| 批量面板 | —— | **不支持**：`BatchRowView` 无 changelog 字段（`src/panel-batch.ts:61-82`），详情 `detailHTML` 未传入（`src/panel-batch.ts:590-609`），展开详情第 02 章恒中性提示 |

## 2. README 覆盖情况（逐段）

| README 位置 | 是否提及 | 原文/说明 | 评价 |
|---|---|---|---|
| §5.8 三条（`README.md:425-429`） | ✅ 唯一正式介绍 | “有新版时…按目标包内 CHANGELOG.md（Keep-a-Changelog 子集）渲染：Added/Fixed/Changed 展开，Deprecated/Removed/Security 折叠，Unreleased 与空节不展示。”＋“作者未提供…安装不受影响”＋“说明文本由集成方备好后传入…经 mountUpdatePanel({ changelogMarkdown }) 或 setChangelogMarkdown 交给面板” | 口径与实现基本对，但只有“是什么”，没有“怎么做”（无文件规范、无接线示例、无传哪份文本） |
| §2.6 批量详情（`README.md:255-261`） | ⚠️ 顺带一句 | “点任意一行展开该家详情：内容是单插件那套五章内核的只读渲染”＋“五章内容…一字不减” | 与实现矛盾（见 §4 第 1 条）：详情第 02 章实际恒中性提示 |
| §8 “包还导出什么”（`README.md:459-505`） | ❌ 未提及 | 整节无 changelog 字样：无 parse/render、无线上两 I/O 函数、无常量 | 漏了整套 API，集成方看 §8 会以为功能不存在 |
| 第 2 节三步接入（`README.md:27-160`） | ❌ 未提及 | 宿主接线/面板派生/整组件挂载示例均未出现 changelogMarkdown | 按第 2 节接完，更新日志恒中性提示，属“静默缺功能” |
| 第 7 节自检清单（`README.md:449-457`） | ❌ 未提及 | 5 条均无日志断言 | 建议加一条“有新版时第 02 章非中性提示” |
| 作者侧文件规范（应有位置：§5.8 或附录） | ❌ 未提及 | 无文件名大小写、无 files 白名单、无标题格式示例、无 Unreleased/空节/[YANKED]/截断上限 | 目标包作者看 README 不知道文件怎么写才会被认到 |

总体评价：**不充分**。§5.8 把“渲染口径、缺日志不挡安装、集成方传入”三句话说对了，但缺：作者文件规范、§8 导出登记、端到端示例、“传新版全文”关键语义、批量不支持声明。

## 3. 来源引用（关键结论→一手文件）

- 功能存在且仅 §5.8 介绍：`README.md:425-429`
- 电话/快照无日志字段：`README.md:72-86`、`src/service.ts`（grep changelog 零命中）、`CONTEXT.md`（无日志定义）
- 包根导出全部 changelog API：`src/host.ts:99-130`；浏览器闭包纯函数：`src/client.ts:68-76`；包出口含 `./panel` 等：`package.json:16-42`；白名单含 CHANGELOG.md：`package.json:43-50`
- 文件名/位置口径与取证：`src/changelog.ts:27`、`src/changelog-io.ts:2-12, 174-186`、`research/changelog-optimal-form.md`（§4 取证结论，包内文件唯一推荐源）
- 解析/渲染/区间/中性规则：`src/changelog.ts` 全文件（重点 43-66 常量、165-300 解析筛选、310-394 渲染）
- I/O 语义与上限：`src/changelog-io.ts:21-31`（三上限+默认源）、65-89（离线读）、260-312（按需取）
- 面板接线点：`src/panel.ts:91-95`（选项）、116-120（controller）、1194-1223（第 02 章内核）、1721-1724（set 实现）
- HTTP 透传：`src/http.ts:326-349`；批量不支持：`src/panel-batch.ts:61-82, 590-609`
- 行为锁死测试：`tests/changelog.test.mjs`（重点 :435 大小写、:275-279 白名单、:452-457 本包 CHANGELOG 自举渲染）
- 本包 CHANGELOG 即规范示例：`CHANGELOG.md`（头注子集声明 + `[x.y.z] - date` + Added/Fixed/Changed 节）
- 版本通道与预发布：`src/service.ts:85-110`、`README.md:413-417`
- 发布白名单惯例：`docs/maintainers.md:59`

## 4. 文档与实现不一致（3 条）

1. **批量详情“五章一字不减”不成立。** `README.md:255-261` 称详情复用单插件五章内核、内容一字不减；但 `detailHTML`（`src/panel-batch.ts:590-609`）根本不传 `changelogMarkdown`，且 `BatchRowView`（`src/panel-batch.ts:61-82`）无该字段，详情第 02 章恒为中性提示。要么补 plumbing，要么 README 加注“批量详情暂不展示更新日志”。
2. **文件名大小写实现严格、README 无声。** 实现仅认 `CHANGELOG.md` 精确大小写（含 tar 内 `package/CHANGELOG.md`），小写视为缺日志（`src/changelog-io.ts:174-186`，测试锁死 `tests/changelog.test.mjs:435`）；README §5.8 只写“目标包内 CHANGELOG.md”，作者写成小写会静默无日志。
3. **中性文案实际三种、README 只提一种。** README 只给“作者未提供更新说明，安装不受影响。”（== `CHANGELOG_NEUTRAL_LINE`，`src/changelog.ts:41`）；面板内核在无新版时显示“还没查到新版；查到后再显示日志。”（`src/panel.ts:1217-1221`），另有异常回退分支“日志读不出来，安装不受影响。”。后两者 README 均未说明（影响不大，但自检与测试应对三句都认）。

## 5. 遗留问题 / 建议

1. README §5.8 补“作者侧文件规范”小段（文件名大小写、files 白名单、最小示例、Unreleased/空节忽略），或链到 CHANGELOG.md 头注。
2. README §8 登记 changelog 导出（至少 `readInstalledChangelogText / fetchReleaseChangelogText / parseChangelog / renderChangelogHTML / changelogForUpdate`），并给“挂载→查新版→取新版文本→setChangelogMarkdown”五步示例，点明**传新版全文**。
3. 明确批量面板暂不支持日志（或补 plumbing：row 增可选 `changelogMarkdown` 并透传进 `detailHTML`）。
4. 第 7 节自检清单加日志断言；中性三文案在 README 或测试里一次写全。
5. 非阻塞确认：`fetchReleaseChangelogText` 要求调用方自备 `fetchImpl`（来源 `src/changelog-io.ts:270-272`）——浏览器面板环境需集成方从宿主侧取，README 示例应点明“该函数跑在 Node 侧（宿主/构建脚本），别打进浏览器束”。
