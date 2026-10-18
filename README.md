# dsh-plugin-update

[![版本](https://img.shields.io/npm/v/dsh-plugin-update?label=%E7%89%88%E6%9C%AC)](https://www.npmjs.com/package/dsh-plugin-update) [![下载次数](https://img.shields.io/npm/dm/dsh-plugin-update?label=%E4%B8%8B%E8%BD%BD%E6%AC%A1%E6%95%B0)](https://www.npmjs.com/package/dsh-plugin-update) [![Node](https://img.shields.io/node/v/dsh-plugin-update?label=Node)](https://nodejs.org/) [![License](https://img.shields.io/npm/l/dsh-plugin-update?label=License)](./LICENSE)

[![优秀示例-dsh-mattpocock-skills-deck](https://img.shields.io/badge/优秀示例-dsh--mattpocock--skills--deck-2563eb?logo=github)](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck) [![优秀示例-dsh-opencode-palette](https://img.shields.io/badge/优秀示例-dsh--opencode--palette-059669?logo=github)](https://github.com/FeatherHunter/dsh-opencode-palette) [![优秀示例-ilife](https://img.shields.io/badge/优秀示例-ilife-d97706?logo=github)](https://github.com/FeatherHunter/ilife)

> ✨ **本包为任何 DSH 插件提供开箱即用的自我更新能力**：宿主侧一段接线，面板侧挂一个现成组件，把「查新版 / 装更新 / 失败兜底 / 更新日志」一次性包掉，为开发者省下大量重复工作量与长期维护成本。**直接把本 README 丢给 AI 通读即可集成**：第 1–2 节是三步接入法，后续章节是全部 UI 控件（单面板 / 批量面板 / 入口件 / 批量入口件 / HTTP 直挂）与自定义 UI 参数，基本都支持按需覆盖。

> 📦 **优秀示例项目**：[dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck) · [dsh-opencode-palette](https://github.com/FeatherHunter/dsh-opencode-palette) · [ilife](https://github.com/FeatherHunter/ilife)

给 DSH 插件加「检查更新 / 安装更新」能力的 npm 包。宿主侧一段接线，面板侧挂一个现成组件，装不上时给用户一条可复制的手工命令。

要求 Node 22 或更高。运行期依赖只有一个：[`dsh-log`](https://www.npmjs.com/package/dsh-log) `^0.3.4`（`0.16.0` 起引入，`0.16.4` 起下限抬到 `0.3.4`，见第 10 节）。当前版本见上方徽章与 `package.json`（此处不写死版本号，免得跟着发布漂）。

装上它你会拿到七样东西：

- **六个电话**：查状态（只读本地）、查新版（用户点了才联网一次）、装更新（拿凭证提交）、取日志（按版取更新日志，全文或空）、交日志（面板把攒下的日志行交回宿主落盘，0.16.0 起）、查合规版（最新版还在年龄门内时，回「满门限的那个版本是哪个」与它的候选凭证，0.18.6 起）。电话指宿主对外提供的方法。
- **一套落盘**：任务状态、安装锁、回滚凭据，按「插件标识 + 使用范围」隔离，多插件互不干扰。
- **面板要的派生取值**：电话名与轮询间隔，构建期从本包生成，面板里不写死。
- **一个现成整组件**：默认内嵌、可切弹窗，调用者传参指定；轮询、安装门控、中文一句话、待重启横幅、手工命令展示与复制、排队可见开关、跳过与恢复、诊断一键复制、**更新日志自动展示**全在组件内部消化。
- **一个更新入口件**：配置页一行挂上就是「检查更新」按钮（或只给状态点的徽标、或整块内嵌），按钮文案随状态自己变；见第 2.5 节。
- **一个安装按钮控件**：任意卡片里原地装好一家插件（缺席可装：未装显示「未安装 → 目标版本」，点下先查后装）；判定、文案、诊断与面板同一口径，失败兜底手工命令；见第 2.8 节。
- **一套多目标批量更新**：一个插件管 N 个插件的更新（总账 + 明细 + 动作，一家收尾才起下一家，会话落盘可断点续跑）；见第 2.6 节。

## 1. 安装

```sh
npm install dsh-plugin-update
```

把本包装成**你自己插件的依赖**即可（推荐）；老式的「把本包 vendor 进插件目录」也照旧可用。
两种形态下，包都按**包名**在自己的 `node_modules` 链上找你的插件包——找到它，才能推出「插件装在哪、正在跑的是哪一版」。

包还没公开发布时先用本地路径代替（例如 `npm install ../dsh-plugin-update`）。

## 2. 三步接入

下面假设你的插件标识是 `my-notes-plugin`、电话名前缀是 `notes`、要查更新的包也是 `my-notes-plugin`。
三处名字都换成你自己的；`prefix` 不传即 `wf`（历史取值），新插件务必传自己的前缀，多插件靠它隔离。

### 第 1 步：装包

见第 1 节。

### 第 2 步：宿主侧接线

```js
import { createHostUpdate } from 'dsh-plugin-update'

const update = createHostUpdate(
  { ctx, logCtx },
  {
    pluginId: 'my-notes-plugin',
    prefix: 'notes',
    targetPackageName: 'my-notes-plugin',
  }
)
// 把处理器按键注册进自己的电话表；电话名从 update.phoneNames 读，不要自己拼字符串。
for (const [name, handler] of Object.entries(update.handlers)) {
  registry.set(name, handler)
}
```

这一步得到六个电话名：`notes.updateStatus`、`notes.updateCheck`、`notes.updateInstall`、`notes.updateChangelog`（取日志：给版本号，回该版 tarball 里的更新日志全文，取不到回空）、`notes.logAppend`（收面板侧的日志行，见第 10 节；`0.16.0` 起新增）、`notes.updateCheckFallback`（合规版决议：最新版还在年龄门内时装不上，问它「满门限的最新版是哪个」，`0.18.6` 起新增）。

`pluginId` 必填（非空字符串，不含路径分隔符）。单例复用键强制含插件标识，多插件不串内存状态与锁。
除 `pluginId` 之外的配置都可选并带默认值，不传即走默认（见第 3 节）。

接线的第二个参数除 `{ ctx, logCtx }` 外还能给 `pluginManager`（显式交宿主管理器实例）与 `readerOverrides`。
平时不用管；只有自动解析对不上目标包时（hoisted、多副本、开发态链接）才用得上它的 `targetPackageDir`：

```js
createHostUpdate(
  { ctx, logCtx, readerOverrides: { targetPackageDir: '/abs/path/to/node_modules/my-notes-plugin' } },
  { pluginId: 'my-notes-plugin', prefix: 'notes', targetPackageName: 'my-notes-plugin' }
)
```

**使用范围（profile）怎么定**：本包按下面的顺序解析，前一步拿到就不再往后走——① 调用方显式传的 `readerOverrides.profileDir` / `profileName`；② DSH 注入的 `ctx.profileContext`（profile 启动的宿主在插件挂载前提供，含 `name` 与 `dir`）；③ 第三方 Desktop 的 `ctx.desktopProfiles.current`（`{ name, dir }`）；④ 调用方显式传入的 `readerOverrides.env.DSH_PROFILE_DIR`（名字取 `DSH_PROFILE`）；⑤ 从已定位的目标包目录反推 `<使用范围>/node_modules/<目标包>`。所以在 DSH 里运行（普通 profile 启动或 Desktop）不会因为目标包不在预期位置而认不出使用范围；只有完全没有 profile 上下文、也没显式覆盖、又反推不到的嵌入方才会拿到 `unknown-profile`（这时传 `readerOverrides.profileDir` / `profileName`）。识别出的名字会用于面板横幅与手工命令里的 `--profile`。本包不读隐式 `process.env`；要传环境快照请走 `readerOverrides.env`。

本包是 ESM（`"type": "module"`）：ESM 插件直接 `import`；CJS 插件用 `await import('dsh-plugin-update')`。

### 六个电话的入参与回参

面板与宿主两侧共用这一份契约（`…` 是你的前缀）：

| 电话 | 入参 | 成功回包 | 失败回包 |
|---|---|---|---|
| `….updateStatus` | `{}` | `{ ok: true, snapshot, manual, receipt: null }` ※ | `{ ok: false, error, errorKind, diag? }` |
| `….updateCheck` | `{}` | `{ ok: true, snapshot, manual, receipt }` ※ | 同上 |
| `….updateInstall` | `{ checkId, requestId, version?, approvedBuilds? }` | `{ ok: true, snapshot, manual, receipt: null }` ※ | 同上 |
| `….updateChangelog` | `{ version }` | `{ ok: true, version, markdown: string \| null }` | 同上 |
| `….logAppend` | `{ rows: [{ level, event, fields, ts }] }` | `{ accepted, dropped }`（永不 `ok:false`、永不抛） | — |
| `….updateCheckFallback` | `{ kind, blame, targetVersion, windowMs, windowSource, publishedAtMs }` | `{ ok: true, snapshot: { verdict, candidate }, receipt }` ※ | 同上 |

※ 快照里带着失败任务时，成功回包另可带可选 `diag`（失败证据小对象，见下一条）；无失败任务时形状逐字不变（`0.18.7` 起）。

- `….updateInstall` 的 `version` 可选：给了就装这个精确版（「装合规版」这条候选路径用），不给仍装快照里的最新版。
- `….updateInstall` 的 `approvedBuilds` 可选（`0.18.23` 起）：宿主 pnpm 因「被忽略的构建脚本」失败时，失败详情会点名**需要批准的精确包名**（见 5.9）；调用方决定批准后，把这些包名原样带回来重试一次，宿主先登记批准再跑 pnpm。重试**必须换一个新的 `requestId`**——同一个 `requestId` 重复提交会被当成重复请求直接返回旧结果（含旧的失败快照），不会真的重试；若宿主回 `stale-approval`（名单已过期/不在待批列表），说明批准窗口已过，应**重新发起一次检查+安装、且不要带上次的 `approvedBuilds`**。形状归一在宿主侧电话入口完成（非字符串、通配、开关样式、路径片段、`包@版本` 一律丢弃，去重保序、最多 32 条），认不出的项不会交给宿主；不传即现状，老调用方一字不动。
- `snapshot` 恒为第 5.1 节那九个字段（七个核心 + `identity` + `registered`）；`manual` 是第 5.3 节那条手工命令（能给则给，不能给为 `null`）。
- `receipt` 查新版与合规版决议都给（`{ checkId, checkedAt, expiresAt }`）；装更新时把 `checkId` 原样带回来，`requestId` 由面板自己生成（同一个编号重复提交直接返回旧结果）。
- 失败一律 `ok: false`：`error` 是原因码（第 5.2 节那十种，另加 `check-failed` / `invalid-release` / `check-expired` / `update-busy` / `install-failed`），`errorKind` 认不出时是 `internal`。面板按 16 码给中文文案（十种见第 5.2 节，另五种与 `internal` 见下表，未来码走兜底）；分支只认 `errorKind`，`error` 仅回退。
- 失败可能顺带回可选 `diag`（失败证据小对象：阶段、路由、耗时、人话摘要、版本、宿主、请求与检查编号、源主机、动作提示；`0.18.5` 起另有归因三键 `causeKind` / `causePackage` / `causeUnlockAt`，共 19 键；缺省即省略，序列化恒在 1KB 内）。旧面板直接忽略它，行为逐字不变；新面板也只按稳定码分支，不拿它做分支。
- `0.18.7` 起，快照里带着失败任务时**成功回包**也可能带这份 `diag`（批量面板与安装按钮靠它认出「该装合规版」）；无失败任务时成功回包形状逐字不变。

### 第 3 步：面板侧接线（构建期派生）

目标只有一句：**面板里不要写死电话名与轮询间隔**。构建时用包内工具生成一个小文件：

```sh
node node_modules/dsh-plugin-update/derive-client-values.mjs --prefix notes --out scripts/generated/updateClient.derived.js
```

生成的常量直接在面板里用：

```js
// UPD_STATUS / UPD_CHECK / UPD_INSTALL / UPD_POLL 由上面那条命令生成
host.call(UPD_STATUS, {})                        // 查状态
host.call(UPD_CHECK, {})                         // 查新版
host.call(UPD_INSTALL, { checkId, requestId })   // 装更新
setInterval(readStatus, UPD_POLL)                // 轮询
```

派生工具的自定义项：

- `--prefix` 必填，必须与宿主侧 `createHostUpdate` 传的 `prefix` 一致，否则面板调的电话名与宿主注册的对不上。
- `--out` 必填，故意不给默认值：默认值会覆盖别人的文件。
- `--dry-run` 只打印生成内容、不写文件。
- 工具用 `esbuild` 打包一次（构建期使用，不引入运行期依赖）；找不到 esbuild 时打印安装提示，不静默失败。

以后换前缀或升级本包，重新跑一次这条命令即可。

### 第 4 步：面板侧挂载整组件（一个挂载点即跑）

前面三步是“自己拼面板”的走法；要整组件，把第 3 步的常量换成下面这一行（框架无关，任何面板直接嵌，样式隔离）：

```js
import { mountUpdatePanel } from 'dsh-plugin-update/panel'

// host.call 是你调宿主电话的函数：(phoneName, args) => Promise<reply>
const panel = mountUpdatePanel(document.getElementById('update-slot'), {
  pluginId: 'my-notes-plugin',
  prefix: 'notes',          // 与宿主侧一致；电话名从它算出，不写字面量
  mode: 'embedded',         // 默认内嵌；切弹窗传 'dialog'，同一套内核
  showOthers: false,        // 默认只看自己的排队，他人仅露“正忙”占位
  call: (name, args) => host.call(name, args),
})
// 离开时 panel.unmount()：只停轮询，安装在宿主侧继续跑；重开面板立刻重查，1 秒内恢复显示。
// 弹窗版想让「关闭」按钮真把弹窗撤掉：传 onCloseRequested（面板点关闭/Esc 时先调它撤 DOM，再停轮询；入口件打开的 dialog 已内置）。
```

组件内部消化的事（调用者不再写）：按 `panelPollMs` 轮询查状态（下限 250 毫秒）；安装按钮状态跟随快照的 `canInstall`，不另写门控规则；装不了的原因按第 5.2 节展示中文一句话；`pending-restart` 单独横幅加重启指引，不再给安装按钮；手工命令展示与复制；排队位置展示与 `showOthers` 开关；跳过按版本记（“已跳过 X.Y.Z · 恢复”在同一行，不藏进设置页）；失败时旁边的“复制诊断”一键给出脱敏后的自包含文本（稳定码、版本、宿主、队列位置），深挖仍看日志（组件里留着第 6 节第 11 条的过滤口径）。失败若归因指向本插件、且最新版被 24 小时年龄门挡住，旁边另给「装合规版」与「等新版」两个按钮（`0.18.6` 起；先决议、点名版本确认后才装，名词与整套流程见第 2.6 节）。失败横幅常驻：查/装失败后保留到下一次用户主动查/装的新结论、任务态或版本变化，只读轮询不再洗掉；复制诊断锁定致命那次回包的证据（码、摘要、版本、宿主、编号冻结在失败时刻）；失败旁有「知道了」可显式确认回到可装页（只清面板提示，不调电话）。无失败时复制诊断给当前状态快照（版本、宿主、范围、队列），不伪造失败码。04 章平时是路牌（中性行＋日志过滤口径，可用 `showLogHint: false` 隐藏）；失败时变为卷宗：真实稳定码、本次查询键（请求／检查编号＋失败时刻）、证据冻结声明、凭编号对日志的现成查询。日志事件名（`host.call`／`host.call.fail`／`update.install.exec`）由宿主与面板共用单源，改名即全改。

待重启横幅上有个「重启宿主」入口。宿主没有“重启自己”的电话，所以默认点击只如实提示「请手动重启宿主」；想把重启流程接进来就传 `onRestartRequested`（面板调它，成败都回执）：

```js
mountUpdatePanel(slot, { pluginId: 'my-notes-plugin', prefix: 'notes', call: host.call,
  onRestartRequested: async () => { /* 拉起你自己的重启流程 */ } })
```

面板画成档案五章：**01 检查与安装、02 更新日志、03 更新队列、04 错误信息、05 手工命令**（五章恒在，缺内容给中性提示，不跳号）。档案头一行是「插件名 + 使用范围 + `profile` 牌」：使用范围由面板自动向宿主索取（电话入参 `includeEnv`，宿主只回**范围名与宿主种类**、不回任何路径），显示的就是更新要落到的那个 profile——`web` 与 `desktop` 各装一份，装错范围是严重故障，所以这一栏宁可显示“未知”也不猜。调用方知道得更准时可以用 `profileName` 显式覆盖。

可选档案卷主题（纸面浅色案卷风，不替换默认）：挂载时加 `theme: 'archive'` 即换肤（右上大印章「待查/可装/安装中/待重启/受阻/已最新」+ 横幅小印章一字 + profile 牌 + 待重启衬线横幅配手绘 SVG 标 + 窄屏印章固定 + 省略号逐字折叠 + 浅深双主题跟随系统），内核 DOM 顺序不动、复制诊断常在；不传即最小可用默认深色样式。运行时用 `panel.setTheme('archive' | 'default')` 可切。入口件与批量面板是同一个 `theme` 参数，取值同一套。

主题变量覆盖（第三方换肤）：四个 UI 口（单面板、批量面板、入口件、批量入口件）都收 `themeTokens`，键为语义名，一次传入即换肤，不传即零回归。入口件打开的 dialog 面板同步透传；运行时用 `setThemeTokens({...})` 即时换肤，传 `undefined` 即清掉覆盖：

```js
mountUpdatePanel(el, { pluginId: 'p', prefix: 'notes', call,
  theme: 'archive',
  themeTokens: { primary: '#c8402a', bg: '#fffdf6', radiusButton: '3px' },
})
```

键与样式表里的 `--dsh-update-*` 变量一一对应（括号里是变量名），手写 CSS 变量等价生效：

| 组 | 键（变量） |
|---|---|
| 文字背景边线 | `text`、`textMuted`、`bg`、`bgSoft`、`border`、`borderStrong`、`buttonBg` |
| 主色焦点 | `primary`、`primaryDeep`、`focus` |
| 状态四组 | `okBg / okBorder / okText`、`warnBg / warnBorder / warnText`、`badBg / badBorder / badText`、`busyBg / busyBorder / busyText` |
| 批量新版 | `newText`（未装好红）、`newOkText`（已装好绿） |
| 字体阴影 | `fontSans`、`fontSerif`、`fontMono`、`shadow` |
| 圆角 | `radiusPanel`、`radiusButton`、`radiusBadge` |
| 入口件尺寸 | `entryFontSize`、`entryPadding`、`entryBorderRadius`、`entryScale`（数字，大于 0） |
| 面板字号（#103） | `panelFontSize`（正文基准，默认 `14px`）、`panelChapterFontSize`（章节标题，默认 `14px`／档案卷 `17px`，批量标题 `15px`／档案卷 `21px` 同键）、`panelBannerTitleFontSize`（横幅标题，默认继承正文／档案卷 `27px`、已最新 `24px`）、`panelLogFontSize`（日志，默认 `13px`系）、`panelSmallFontSize`（小字副行/注脚，默认 `11px`–`12.5px`按规则回退） |

三条约束：颜色只收 hex（`#rgb`／`#rrggbb`／`#rrggbbaa`）或英文名单词（含 `transparent`），`rgb()`／`color-mix()` 请自行换算成 hex；其余值走注入检查（分号引号括号等不许过，见 `sizing` 同口径）；未知键与非法值挂载即抛错，不静默吞掉。被覆盖的 token 不再跟随深色模式（内联值固定，调用方自己保证深浅可读，字号类同理：传了即固定值，不跟媒体查询走）。

类型定义随包分发（`dsh-plugin-update/panel` 的 `.d.ts`），不用自编译；面板离线可读，与包版本绑定。

整组件 HTTP 版（无 `host.call` 环境即跑：浏览器面板经 HTTP POST 直达宿主网关，只传三样）：

```js
import { mountUpdatePanelHttp } from 'dsh-plugin-update/http'

mountUpdatePanelHttp(document.querySelector('#upd'), {
  pluginId: 'my-plugin',
  prefix: 'myplug',
  baseUrl: 'https://host.local:3000/upd',
  showOthers: false,
  pollMs: 1000,
})
// 离开时 panel.unmount()：只停轮询，安装在宿主侧继续跑。
```

### 第 2.5 节：更新入口件（配置页上那一颗按钮）

目标只有一句：**让用户不用点开就知道有没有事。** 一行挂上：

```js
import { mountUpdateEntry } from 'dsh-plugin-update/entry'

const entry = mountUpdateEntry(document.getElementById('upd-entry'), {
  pluginId: 'my-notes-plugin',
  prefix: 'notes',
  call: (name, args) => host.call(name, args),
})
```

三个自由度，默认值都选好了：

| 自由度 | 取值 | 默认 | 说明 |
|---|---|---|---|
| 摆什么 | `button` / `badge` / `inline` | `button` | 按钮；只给一个状态点；面板本体直接嵌进来 |
| 什么时候查 | `mount` / `never` | `mount` | 进页面静默查一次（**只调 `.updateStatus`，只读**）；`never` 则只在点击时查 |
| 点了做什么 | `has-update` / `always` / `manual` / `direct` | `has-update` | 有新版本才开面板；检查完总是开；交给 `onActivate` 自己跳；点开即弹窗、不预查 |
| 无新版本摆哪 | `button` / `tooltip` / `note` | `button` | 版本即按钮本身；收进悬停；回右侧小字旧样子 |

按钮文案随状态自己变（按宿主语言单语渲染：中文界面纯中文、英文界面纯英文，一次只出现一种语言）：`检查更新`（尚未查询）/ `已是最新 X.Y.Z`（无新版本，默认即按钮本身）/ `有新版本 1.1.0` / `正在安装…` / `待重启` / `更新失败，请查看详情`（英文见集中字典同 key）。

语言跟随（单语）：入口件默认跟随 `document.documentElement.lang` > `navigator.languages` > 中文兜底；显式覆盖传 `locale: 'zh' | 'en' | { getActive(): string; subscribe?(cb): () => void }`（对象形态可接宿主语言服务，切换即时重绘，`unmount` 后停订；无 DOM 环境不抛，落中文）。

无新版本时版本号摆哪（`upToDateDisplay`，缺省 `'button'`）：`button` 即按钮本身就是`已是最新 X.Y.Z`（单按钮不占宽，可点再查，hover 回`检查更新`暗示动作；无新版本中性弱边，hover 才走主色）；`tooltip` 按钮还是`检查更新`、版本收进悬停；`note` 回旧样子（按钮旁右侧小字，只在 `openOn: 'has-update'` 下点击确认无新版本后出现）。旧版默认即 `note` 的样子，要回去就显式传 `upToDateDisplay: 'note'`。想连按钮都不留痕，就用 `openOn: 'always'`（检查完总是开弹窗，无新版本在弹窗里看“已是最新”）或 `openOn: 'direct'`（点开即弹窗，连预查都省了，面板挂载即自查；徽标形态仍走回调口径）。

按钮尺寸（跟头行其他控件同高/整体缩放）：传 `sizing` 只改按钮本体，不碰面板；不传即默认外观。`scale` 是整体缩放（默认 `1`，如 `1.2` 放大、`0.9` 缩小），原来写在容器上的 `zoom` 可整体搬进来：

```js
mountUpdateEntry(el, { pluginId: 'p', prefix: 'notes', call,
  sizing: { fontSize: '12px', padding: '2px 8px', borderRadius: '8px', scale: 1 },
})
```

等价的手写 CSS 变量（与现有 `--dsh-update-*` 颜色变量同口径，写在容器或祖先元素上即可）：`--dsh-update-entry-font-size`（默认 `13px`）、`--dsh-update-entry-padding`（默认 `4px 12px`）、`--dsh-update-entry-border-radius`（默认 `6px`，`archive` 主题下 `3px`）、`--dsh-update-entry-scale`（默认 `1`）。`badge` 圆点与 `inline` 内嵌不受影响。一点约束：`sizing` 与手写变量都不接 `!important`（变量本身已赢特异性）；确需 `!important` 请手写 CSS 覆盖。

**一条铁律：检查是只读、安装是写入，两者不许合并成一个动作。** 入口件永远只做「查 + 打开面板」，
任何路径都不自动安装；用户必须在面板里明确点「安装」。想让点击交给自己（例如你已有自己的更新页）：

```js
mountUpdateEntry(el, { pluginId: 'p', prefix: 'notes', call, variant: 'badge',
  onActivate: ({ hasUpdate, latestVersion }) => { /* 自己跳自己的页面 */ } })
```

#### 批量感知的入口件（一颗按钮看 N 家，点开即批量面板）

一个总管替 N 家管更新时，别再用单入口的 `manual` 桥接批量面板——徽标只反映总管自己一行，不是七家聚合。换这一颗：

```js
import { mountUpdateBatchEntry } from 'dsh-plugin-update/entry-batch'

const entry = mountUpdateBatchEntry(document.getElementById('upd-entry'), {
  prefix: 'life',                              // 批量电话前缀（七个批量电话从它派生）
  call: (name, args) => host.call(name, args),
  theme: 'archive',                            // 与单入口/面板同一套皮肤
})
// 点击先调 `life.batchCheck` 查一次 N 家，再以 dialog 形态开批量面板；徽标即七家聚合。
// 下游删掉 `openOn: 'manual' + onActivate` 桥接即跑，总管单行不再当状态源。
```

聚合口径与批量面板总账同一份数法（含「忙失败占位翻回可更新」）：`忙 > 失败 > 待重启 > 可更新 > 待查`，
一个收尾事实（`0.18.7` 起）：账本目标没装成、但这家实际已装上「能装的最新」（合规版，见第 2.6 节）的行，按要不要重启进「待重启 / 已最新」，不再报安装失败。
文案按宿主语言单语渲染（中文如左，英文见字典 `batch-entry.*` 同 key），`locale` 选项与单入口同形态，切换即时重绘。
三自由度与单入口同取值，缺省不同：`openOn` 缺省 `'always'`（查完总是开批量面板；`has-update` 下有事才开，否则原地给总账一句）。
`autoCheck` 缺省 `'mount'`（只调 `.batchStatus`，只读）；铁律同单入口：任何路径都不自动安装。

窗口期说明（必读）：`mountUpdatePanel` 与 `mountUpdateBatchPanel` 接受 `locale` 选项（与入口件同形态）；本包新增的文案（批量面板的合规版入口、安装按钮的兜底按钮等）已按它单语渲染，早期散落文案仍按基线中文渲染——按面迁移在后续版本继续落地，入口件两条链已全部生效。

### 第 2.6 节：多目标批量更新（一个插件管 N 个插件的更新）

一个插件替自己**和另外几个插件**管更新时，别把 N 个面板并排——用户在那块界面上只问三件事：
**有没有事 / 是哪几家 / 我要做什么**。所以这套东西是「总账 + 明细 + 动作」三层，一行只回答一个问题。

宿主侧：

```js
import { createMultiHostUpdate } from 'dsh-plugin-update/batch'

const multi = createMultiHostUpdate({ ctx, logCtx }, {
  prefix: 'life',                       // 批量电话前缀
  selfKey: 'life-pack',                 // 「自己」：排序时排最后（自更新安全）
  targets: [
    { key: 'bill',    title: '记账',   packageName: 'dsh-bill-ilife',    prefix: 'ilife-bill' },
    { key: 'calorie', title: '卡路里', packageName: 'dsh-calorie',       prefix: 'ilife-calorie' },
    { key: 'life-pack', title: '爱生活', packageName: 'dsh-life-pack',   prefix: 'ilife-life-pack' },
  ],
  // drain: true,                       // 宿主侧定时推进（默认关：自动装是行为跃迁，显式开）
})
for (const [name, handler] of Object.entries(multi.handlers)) registry.set(name, handler)
```

七个批量电话（`<prefix>` 即上面的 `life`，同时是账本属主身份）：`batchStatus` / `batchCheck` / `batchInstall` / `batchResume` / `batchCancel` / `batchPrefs` / `batchPrefsSave`；
每个目标的六个单插件电话照旧以**各自前缀**暴露（`ilife-bill.updateStatus`、`ilife-bill.updateCheckFallback` 等）；每行回包里的 `phoneNames` 带全这六个名字，合规版兜底与候选安装都按它点名（`0.18.7` 起）。

回包形状（成功六项，失败只有三项）：

```js
{ ok: true, session, rows, progress, inventory, prefs }  // rows 一行一家：key/title/phase/targetVersion/restartRequired/error/snapshot/phoneNames（本行那家的六个电话名）、可选 diag 与 pluginId
{ ok: false, error, errorKind }            // 跨使用范围混目标会回 cross-scope，不抢锁、不写盘
```

`batchResume` 无事可续时回 `resumed: false`（面板不再报空话成功）；`batchPrefsSave` 只收布尔 `checkOnOpen`。

面板侧：

```js
import { mountUpdateBatchPanel } from 'dsh-plugin-update/panel-batch'

const panel = mountUpdateBatchPanel(el, {
  prefix: 'life',
  call: (name, args) => host.call(name, args),
  theme: 'archive',          // 与单插件面板同一套皮肤（archive = 档案卷）
  autoCompliant: true,       // 缺省开：年龄门行自动决议（只打决议电话，绝不自动装）
})
```
// 弹窗版与单面板同口径：传 `onCloseRequested`（点关闭/Esc 时先调它撤 DOM，再停轮询；入口件打开的 dialog 已内置；不传即只停轮询）。

批量面板 HTTP 版（无 `host.call` 环境即跑：同一传输内核，七电话走同一映射，取消走 `batchCancel`）：

```js
import { mountUpdateBatchPanelHttp } from 'dsh-plugin-update/http'

mountUpdateBatchPanelHttp(document.querySelector('#batch'), {
  batchPrefix: 'life',
  baseUrl: 'https://host.local:3000/upd',
  pollMs: 1500,
})
// 取消整批走 batchCancel 电话；unmount 只停轮询，宿主侧照跑。
```

三条硬约束（都在实现里）：**一行只回答一个问题**（这家的下一步是什么，状态词全中文可执行）；
**行内动作只作用于该行**，「全部更新」是宏而不是第二个状态机；**待重启与失败常驻横幅**，不藏进展开里。

点任意一行展开该家详情：**内容是单插件那套五章内核的只读渲染，动作由批量面板自己提供**。第 02 章日志由批量面板按行自动取该行自己的 `updateChangelog` 电话（按行+版本记住结果，取不到即中性提示，不挡安装；`autoChangelog: false` 可关）。
内核渲染时传 `actions: 'none'`——五章内容、进度条、「已跳过」提示一字不减，**动作按钮一个都不画**
（内核里那些按钮带的是 `data-action`，批量面板只认 `data-act`；照搬 markup 而不接管行为，
就会得到「可点却没反应」的死按钮——这条缝现在由渲染开关焊死）。详情里的动作行是批量面板自己的：
`装 X.Y.Z / 重试`、`装合规版 / 等新版`（`0.18.7` 起：最新版被年龄门挡住时的两个出口，见下文）、`跳过这一版`（与单插件面板同语义：按插件+版本记，跳过后那家单独看也不再提醒）、
`复制手工命令`、`复制诊断`——全部走与行内**同一条** `act()` 通道、同一份忙守卫。
「复制诊断」需要宿主把失败诊断一并回出来：`batchStatus` 的每个 row 带可选 `diag` 与 `pluginId`；生产形状下宿主还会把目标包名与归因键补进这份 `diag`，兜底按钮才认得出该给哪一家装合规版。

失败横幅批量复制（`0.18.11` 起）：多家安装失败时，失败名单下方多一行两个批量按钮——`复制诊断`一次复制全部失败行的诊断文本（按面板顺序、块间空行，已脱敏），`复制手工命令`一次复制全部失败行的手工命令（有命令的原样一行，缺命令的用 `# <插件名>：无手工命令` 注释行占位，整段可安全粘终端）。两枚按钮与失败横幅同生灭，口径与横幅名单完全一致（排队占位、待重启、已装合规版的行不算失败）；一条可执行命令都没有时`复制手工命令`置灰。

> 自己写渲染时同理：`renderUpdatePanelHTML(input)` 少传 `actions` 即默认（画动作行）；
> 传 `actions: 'none'` 就是只读内容——**凡是要复用内核 HTML 的地方，都必须显式接管或摘掉它的动作面**。

**耐久（这是这套东西存在的理由）**：批量会话按属主落在
`<家目录>/update-queue/<使用范围短指纹>/<批量前缀>/batch.json`，每一步都写盘；检查知识（只做展示）落同目录 `inventory.json`，面板偏好落 `prefs.json`。所以关面板、重载页面、
甚至进程重启都不怕——`batchResume` 读回来接着推：**已完成的不重装**（编号恒等、幂等），
没做完的重新查一次再装。这就是「更新自己时 UI 消失、剩下几家永不启动」那个病的正解。
面板打开即按偏好自动查一轮（缺省开，底部可关；60 秒节流 + 在途抑制，入口预查与面板开查一击只查一次），有没做完的一轮自动续一次，显式按钮保留；面板常驻「关掉面板不会中断」一行事实。年龄门行另按 `autoCompliant` 自动决议（缺省开，只问不装；传 `false` 就只留手动入口，见下文）。

**合规版：最新版被 24 小时年龄门挡住时的出口（`0.18.7` 起）**。npm 的年龄门要求新版本发布满 24 小时（或源上配置的时长）才可安装，于是「最新版」暂时装不上，但**满门限的最近那个版本**装得上——本包把它叫**合规版**（不是随手挑的旧版，是唯一那个还没跨过门限之前的最新版本）。

行内因此多两个动作：`装合规版`（先打决议电话问出候选版本，再点名版本请你确认，点确认才装——**永不自动装**）、`等新版`（收起这一轮提示，等最新版自己满门限）。源上暂时没有可装的版本时显示「约 X 后可装」，不画一个点不动的按钮。

装完之后那一行给的是**实际安装结果**：「已装 1.8.0，不是最新 1.9.0（最新版这次没装上）」，按要不要重启进「待重启 / 已最新」；批量总账里也不再把这些家算作安装失败。批量级确认条会把所有「有候选待确认」的行收在一起，一次确认一批（`确认装这 N 个`）。

**检查的后置条件（`0.18.2` 起）**：一次检查（含自动查）之后，面板里不再出现上一次检查之前的数据。成功查出的结论会同步对账进会话——有新版的行置为可装并换上新目标版，已是最新则清掉陈旧目标；检查失败、待重启、正在装的行不受影响。另有一道渲染兜底：会话目标版不比当前版新时，只显示当前版，不画「→ 新版本」（旧版曾把陈旧目标如 `0.3.55` 配上当前 `0.3.60` 画成"有新版本"，现已修正）。

**升级说明**：旧版无属主 `batch.json`（根目录那份）不再被读取、不删除、不接管——没跑完的那批重打一次「全部更新」即可（幂等，已完成的秒过不重装）。单队列不变：四家单插件与批量仍共用同一份 `queue.json` + 全局锁，一次只装一个。

**自更新安全**：`selfKey` 指定的那家默认排到最后。承载更新界面的那个包若第一个被替换掉，
界面与推进它的循环会一起消失——排最后则前面几家早已落盘收尾。

**跨使用范围如实拒绝**：`web` 与 `desktop` 各自排队（装的是不同落点），混在一起的目标会回
`cross-scope`，本包不会替你跨范围抢锁。

### 第 2.7 节：更新日志自动展示（告诉用户更新了什么）

任何插件的升级能力都是两件事：**① 给一套面板**（上面第 4 步 / 2.5 / 2.6，挂载一行即跑）；**② 告诉用户这次更新了什么**（本节，写 md 即显示，零新增代码）。

```js
import { mountUpdatePanel } from 'dsh-plugin-update/panel'

// 与第 4 步同一行，不用加任何参数：有新版本时第 02 章“更新日志”自动出现
const panel = mountUpdatePanel(document.getElementById('update-slot'), {
  pluginId: 'my-notes-plugin',
  prefix: 'notes',
  call: (name, args) => host.call(name, args),
})
```

作者侧只写文件，不写代码（发布后用户自动看到）：

1. 包根放 `CHANGELOG.md`（文件名全大写，小写视为没有），版本节形如 `## [1.2.0] - 2026-10-05`（最新在前），分类用 `### Added/Fixed/Changed/Security`（亦收中文名 `新增/修复/变更/弃用预告/移除/安全`；面板必显展开；`Deprecated/Removed` 折叠；`Unreleased` 与空节忽略）。分类与条目必须挂在版本节下：裸条目（没有 `###` 分类行）会被忽略；全文一个版本节都读不出时面板如实说"读不出来"，不说"未提供"。
2. `package.json` 的 `files` 白名单加上 `CHANGELOG.md`（否则发出去的包里没有它，面板永远读不到），发布前跑一次 `npm publish --dry-run` 核对。

行为：有新版本时面板按新版号自动取一次该版 tarball 里的全文（复用官方源 + `integrity` 校验，同一版本只取一次）；删了文件或取不到即中性提示，**安装永远不受影响**。想自己接管就传 `autoChangelog: false` 退回手动（备好文本后 `mountUpdatePanel({ changelogMarkdown })` 或 `setChangelogMarkdown` 传入，显式文本永不被覆盖）。入口件与批量面板同样自动：前者透传，后者展开行按行取。细节与边界见第 5.8 节。

安全事项必显：`### Security` 与 `Added/Fixed/Changed` 同级展开。单类超 200 条时前 200 条展开、其余收进该类内部折叠并标计数。目标版本被撤回（标题含 `[YANKED]`）时，第 02 章顶部加一条警告横幅，安装不受影响。条目开头写 `BREAKING:` 或 `不兼容:`（大小写不敏感，中英文冒号皆可）即挂破坏标记，正文不动。同一版本日志只取一次；取不到显示中性提示，安装不受影响。

### 第 2.8 节：安装按钮（任意卡片里原地装好一家）

更新面板是整块五章，入口件只查不装。当缺的东西住在你自己的功能页里（例如某页签依赖的兄弟插件没装），就用这颗按钮，一行挂上：

```js
import { mountInstallButton } from 'dsh-plugin-update/install-button'

const button = mountInstallButton(document.getElementById('bill-install-slot'), {
  pluginId: 'my-pack-bill',
  prefix: 'mypack-bill',   // 与宿主侧这一家的前缀一致；电话名从它算出
  call: (name, args) => host.call(name, args),
})
// 离开时 button.unmount()：只停轮询，安装在宿主侧继续跑。
```

行为与面板里那颗安装按钮同一口径（同一份快照、同一句话）：未装显示「未安装 → 目标版本」，按钮是「安装版本 X.Y.Z」；点下后先查后装（一次点击内自动衔接，仍是明确的写意图，绝不自动装）；装中置忙，撞上别的安装显示排队位；失败给重试 + 复制诊断；失败若归因指向这张卡片这家、且最新版被 24 小时年龄门挡住，另出「装合规版」（决议出候选后变成「确认装 X.Y.Z」）与「等新版」两个按钮，点确认的前一刻会重新核对候选版本（`0.18.7` 起，与批量面板同一套决议电话与确认流程）；待重启只给重启指引；实在装不了才交出手工命令（`manual` 为空时该段隐藏）。还没查到远端版本时按钮退回「检查更新」。轮询只在装中进行且有界（约 5 分钟封顶转重查态），平时不 polling。

`theme` / `themeTokens` / `locale` / `showOthers` / `profileName` / `pollMs` / `autoCheck` 与面板同口径；`button.state()` 可读当前快照，`button.refresh()` 手动重查一次。自己渲染时：视图的 `busyAct` 多一档 `'fallback'`（决议与等待确认中），另带 `fallbackStage`（`'offer'` / `'confirm'`）、`fallbackCandidate`、`fallbackBusy`（`0.18.7` 起）。

### 升级本包（已经接入过的项目）

宿主种类与安装出口都由本包自己探测和选择，**升级依赖即可，宿主侧与面板侧都不用改代码**：

1. 依赖版本提到 `^0.5.2`。
2. 重新装 / 发一版你自己的插件，让新依赖进当前使用范围（运行时用的是 `node_modules` 里那份）。
3. 如果你自己接过一版宿主安装出口，把它删掉——它会挡在本包的路由前面。

两处例外必须动代码（它们把自动探测挡住了）：显式传了 `readerOverrides.environmentKind`；显式传了与真实使用范围不符的 `profileDir` / `profileName`。

`targetPackageName` 建议就是你自己的包名：使用范围目录按「装好的包住在 `<范围>/node_modules/<目标包名>`」反推（这是最后一步兜底；能拿到上面那几条权威身份时不用反推）。

`0.2.0` 起目标包**按包名解析**（清单直解 → 入口反查 → `node_modules` 步行 → 自锚定兜底），`exports` 没导出 `.` 与 `./package.json` 的包也能命中。
`0.1.x` 只能在本包被 vendor 进插件目录时找到目标包；以依赖形态安装时一键升级会永远不可用（面板显示假的 `installation-changed`）。

## 3. 配置

```js
const update = createHostUpdate(
  { ctx, logCtx },
  {
    pluginId: 'my-notes-plugin',
    prefix: 'notes',
    targetPackageName: 'my-notes-plugin',
    confirmationTtlMs: 20 * 60_000,   // 只调这两项，其余走默认
    panelPollMs: 2000,
  }
)
```

| 配置键 | 默认 | 说明 |
|---|---|---|
| `pluginId` | 必填，无默认 | 非空字符串，不含路径分隔符 |
| `prefix` | `wf` | 电话名前缀；电话名 = 前缀 + 点 + 动作名 |
| `targetPackageName` | `dsh-mattpocock-skills-deck` | 要检查更新的那个包是谁 |
| `registryUrl` | `https://registry.npmjs.org/` | 官方源 |
| `homeDir` | 现推导 | 环境变量 `DSH_HOME` 优先，否则家目录下 `.dsh` |
| `checkTimeoutMs` | `10000` | 联网超时，须为有限大于 0 的数 |
| `confirmationTtlMs` | `600000` | 凭证有效期，须为有限大于 0 的数 |
| `installTimeoutMs` | `900000` | 安装时限，须为有限大于 0 的数 |
| `panelPollMs` | `1000` | 面板轮询间隔，不得小于 250 毫秒 |
| `releaseChannel` | `stable` | 版本通道：默认只推稳定版；显式传 `prerelease` 才收预发布版（如 `0.2.0-rc.2`），安装仍只装精确版 |

配置只经函数入参注入，不读配置文件。越界直接抛错，不静默取整。

**运行版本未知**：宿主侧拿不到「正在跑的版本」时，`readerOverrides.runningVersion` 请传 `null`（或省略，由宿主清单推导），**不要伪造 `0.0.0` 之类的占位版号**——伪造值会进事件 `update.check.done.current` 并参与新旧比较。未知时快照 `runningVersion` 为 `null`：不宣称「有新版」、不判 `pending-restart`、`update.check.done` 不再落 `current`，面板显示「运行版本未知」而不是「已是最新」；安装路径不再拿未知去比大小（首次安装照常可装）。

**DSH 运行时版本（可选）**：`readerOverrides.dshVersion` 给了就按远端声明的 `engines.dsh` 提前判不兼容（`blockedReason: 'incompatible-dsh'`）；不给就不猜、不误拦。宿主真拒绝时把 `error.incompatible[]`（键是 `engines.dsh` 或 DSH peer 包名）翻成「要求 ≥X（当前 Y）」拼进失败详情，原文仍在前面。

落盘目录按标识派生：家目录下 `updates` 加插件标识加使用范围短指纹，三个文件名是 `state.json`、`install.lock`、`before.json`。只读自己的新路径，写也只写自己的（`0.18.22` 起，#203：旧字面目录恰好是默认标识自己的实时目录，跨标识回退读会把别家正在跑的任务读进来再回写，真机上把 deck 的任务写进了 life-pack/prompt/calorie 的目录）。
标识取历史值 `dsh-mattpocock-skills-deck` 时，路径与旧版一字不差（升级不丢状态）。
安装锁是自愈的（`0.18.11` 起）：锁位先生成完整内容再原子占位，所以在**支持硬链接的盘上**不存在「空锁」（不吃硬链接的盘退回「先写内容再放锁位」，仍有极短窗口，但坏锁不再堵死读取）；判陈旧只看时间——锁里 `startedAt`（读不出就看文件 mtime）超过 `installTimeoutMs` 才回收，否则一律按「别人正在装」回 `update-busy`。**同一使用范围内发现任意陈旧锁时不需要再手工删 `install.lock`。**

## 4. 安装是怎么执行的

你不需要按宿主分支：包探测当前宿主，选它自己的安装出口。

| 宿主 | 出口 | 说明 |
|---|---|---|
| 第三方 Desktop（发布 `desktopProfiles` / `desktopPnpm` 的那一支） | 桌面服务 `desktopPnpm.runPlugin` | 装进「当前激活的使用范围」；激活范围与本插件所在范围对不上时宁可不装 |
| 官方桌面版（宿主进程内的插件管理器） | `pluginManager.installBundle` | 只收 `包名@精确版本`，不接受任何开关 |
| 普通 DSH 宿主 | 自己起 `dsh plugin --profile <名> add …` | 参数数组直传；不经 shell、不用 `PATH` 上的命令名、不按系统分支 |

三种出口都只装**精确版本**。第三方 Desktop 与普通宿主把官方源写进参数（`--registry=`），官方桌面版走管理器的 `registry` 选项。
官方源不可达时诚实失败，不换源。三种出口都不成立（宿主既没有桌面服务、也没有插件管理器、命令行入口也认不出）时同样诚实失败，转第 5.3 节的手工命令。
装不上时宿主原话会写进任务说明 `job.message`，形如 `install-failed: <原话>`。三条宿主出口都收 pnpm 的原始输出（抓取上限 64 KiB），再从中挑出**错误码行**（`ERR_PNPM_*` / `ERR!`）与紧邻的签名行（`published` / `cutoff` / `minimumReleaseAge`）拼成原话，挑不到就取末段；`detail` 仍封顶 300 字、去掉绝对路径（`0.18.7` 起）。这样面板「复制诊断」里那句人话原因才认得出「是年龄门还是别的毛病」。

时间口径：查新版 2 秒内重复点击复用上次结果；安装按 `installTimeoutMs` 计时，到点终止（官方桌面版先请求宿主取消；第三方 Desktop 的 `done` 带 `terminate` 就调，没有就如实说明这次安装可能仍在后台继续；来不及收尾就等它一小段再定成败，`0.18.14` 起）；终止宽限 3 秒。普通 DSH 宿主自己起的子进程走同一套终止纪律：带 `terminate` 就调，没有就如实说明这次安装可能仍在后台继续。超时是独立结局：详情里会点名「安装超时」，不会退化成说不清原因的「装失败」。

要显式覆盖出口（例如自己把宿主管理器实例交进来）：`createHostUpdate({ ctx, pluginManager })`，不传就从 `ctx` 现取。

## 5. 用户会看到什么

### 5.1 快照九字段（`#190` 起加 `registered`；`#197` 起加 `identity`；`0.17.0` 起是七字段，之前六字段）

查状态与查新版都返回同一份快照：七个核心字段 + 一格安装身份（`identity`，`#197` 起）+ 一格在册事实（`registered`，`#190` 起）。

| 字段 | 含义 |
|---|---|
| `installed` | 在场事实：目标包在不在（`0.17.0` 起新增；缺席时 `installedVersion` 为 null） |
| `installedVersion` | 磁盘上装着的版本 |
| `runningVersion` | 正在跑的版本；拿不到为 `null`（未知不伪造、不参与比较） |
| `latestVersion` | 最近一次查新版带回来的版本（没查过为 null）；`stable` 通道且已装版本在通道内时是本通道最新发行版，不一定是注册表 `latest` 标签；未装或已装版本在通道外时仍可能是通道外 latest（此时 `blockedReason` 报 `channel-mismatch`） |
| `canInstall` | 现在能不能装 |
| `blockedReason` | 装不了的原因（能装为 null） |
| `job` | 当前任务（只读半程恒为 null） |
| `identity` | 安装身份（`#197` 起）：`update` / `first-install` / `up-to-date` / `null`（判定不了） |
| `registered` | 在册事实（`#190` 起加，可选格）：目标包是否登记在本使用范围的清单里（`dsh.profile.bundles` 选中名单；老/最小清单退回 `dependencies`）。`false`＝磁盘换版也不等于重启后会加载；读不到清单为 `null`（未知不冒充事实）；老读取器/旧快照可能没有这一格，与 `null` 同义 |

**安装身份（`#197` 起）**：同一个「安装」按钮背后其实是三种关系，面板不许再用一句话混着说——`update`＝磁盘装着旧版、清单在册的**换版**（官方桌面版走 remove→install，失败如实报）；`first-install`＝磁盘没有、清单也未登记的**新增依赖首次安装**（装完要重启宿主才会加载，不是换版）；`up-to-date`＝磁盘已是远端这一版（或更新），直接说「已是最新」，不要发起一次注定空转/被拒的安装。判定不了为 `null`（例如清单登记了但磁盘缺失——那是修复现场），**绝不冒充**「首次安装」。面板自己的文案按这四档走；不读这一格的集成方仍可只用 `canInstall`（行为不变）。

**未安装（`0.17.0` 起）**：`installed === false` 的行不是坏包——面板版本列写「未安装 → 目标版本」，按钮是「安装」（复用既有安装词条，不新增控件）；查到远端版本即可点装，装完走既有终态（待重启提示见 5.4）。集成方零改动：不用读这个字段也能用，但读了可以少猜（不要再拿 `installedVersion` 是否为 `0.0.0` 判断未装）。

**任务形状（`0.18.10` 起）**：`job` 除 `id` / `state` / `targetVersion` / `message` / `requestId` 外，多一格可选 `previousVersion`——这次安装动手之前磁盘上的版本（未安装或读不到为 null；老任务没有这一格时不补造）。字段只增不改，不读它也能用。

**在册事实（`#190` 起）**：`registered === true` 时「重启宿主后生效」成立；`false` 时是「装了但重启也不会加载」——面板与批量总账都不许再说满「重启后生效」，要改说未登记并给「先在宿主插件页选中/登记该插件」的下一步。`null`（未知）时不得当作 `false` 说空，也不得当作 `true` 说满，沿用原有「待重启」话术即可。

### 5.2 十一种装不了的原因

面板拿到非空 `blockedReason` 时，直接展示下表「用户该做什么」那一列的一句话，不要只展示英文原因本身。

| 原因 | 中文含义 | 用户该做什么 |
|---|---|---|
| `unknown-profile` | 无法识别使用范围或插件安装位置 | 重启宿主后重新查询；若持续，请提交版本号与诊断信息至插件作者；此场景不提供手工命令 |
| `source-install` | 源码安装实例，不支持版本更新 | 此场景不提供手工命令；如需更新，请按包名@版本号重新安装 |
| `dev-source` | 开发态挂载（源码链接），更新中心不可用 | 改完仓库代码后重启宿主生效；更新中心只服务按版本安装，此场景不提供手工命令 |
| `invalid-installation` | 已安装的包结构不完整（包名 / 版本号 / 入口文件异常；`0.17.0` 起只判在场但坏的包，从没装过的不再落此处） | 重新安装当前版本以修复安装目录，然后重新查询更新 |
| `installation-changed` | 安装位置发生变更（目录或包体不一致） | 重启宿主后重新查询；若持续，请重新安装 |
| `pending-restart` | 新版本已写入磁盘，当前运行仍为旧版本 | 重启宿主以加载新版本；此为正常状态，非安装失败 |
| `registry-conflict` | 版本声明与磁盘实际版本冲突 | 核对使用范围清单文件中目标包的版本声明，修正后重试 |
| `incompatible-node` | Node 运行时版本不兼容 | 请升级 Node 至 22 或更高版本后重新查询 |
| `incompatible-dsh` | 新版本要求更高的宿主运行时版本（只在集成方给了 `dshVersion` 时提前判） | 当前宿主运行时版本不满足新版本要求，请先升级宿主再更新 |
| `recovery-required` | 上次安装异常中断，存在未完成任务 | 重新执行安装；若持续，请按第 6 节排错 |
| `channel-mismatch` | 已安装版本与当前版本通道不符 | 切换至预发布通道，或重新安装本通道正式版本后查询 |

`installation-changed` 有一个常见子形态（`0.18.18` 起详情点明）：目标版本与磁盘已装版本相同（批量行或旧快照拿已装版当目标发起安装），此时详情写「目标版本与已装版本相同，无需安装」——处置是重新查一次新版再装，不要重试旧请求（见 5.9）。

电话专属码与 `internal`（面板同样给中文，不只给英文码；未来码走兜底并带上原码）：

| 原因 | 中文含义 | 用户该做什么 |
|---|---|---|
| `check-failed` | 版本信息查询失败（网络 / 数据源 / 限流） | 稍后重新查询；若持续，请提交诊断信息至插件作者 |
| `invalid-release` | 发布版本信息无效（版本号非法或内容不一致） | 核对清单文件中的包名与版本声明后重新查询 |
| `check-expired` | 查询凭证过期，安装请求被拒绝 | 请重新查询版本信息后安装；请勿复用过期请求编号 |
| `update-busy` | 同一使用范围内存在进行中的安装任务 | 待当前任务退出 installing/verifying 状态后重试；排队期间可查询任务状态确认队列位置 |
| `install-failed` | 安装执行失败，详情见诊断摘要 | 请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者 |
| `internal` | 内部错误，原因未知 | 请重试一次；若持续，请提交诊断信息至插件作者 |

### 5.3 手工兜底命令

每次查状态与查新版都会顺带回一条手工命令（字段名 `manual`），能给则给、不能给则为空。
为空是正常的三种情形：源码安装、开发态挂载、认不出使用范围（上表前三行），此时只展示原因。

```sh
dsh plugin --profile my-web add --save-exact my-notes-plugin@1.2.3 --registry=https://registry.npmjs.org/
```

使用范围名含空白或 `$`、反引号、引号、`&`、`;` 等 shell 元字符时**不会给出命令**（宁可省略，也不给一条会被展开/截断的假命令）——正常 ASCII 范围名直接可复制整行执行；网络受限时用户可以自行去掉 `--registry=` 走本地源。

面板每次拿到回包都刷新展示这条命令，不要缓存旧的。

### 5.4 ⚠️ 待重启提示（必须做）

`pending-restart` 不是失败，是「磁盘已是新版、正在跑的还是旧版」。面板必须满足三条：

1. 用显眼样式单独展示（例如顶部横幅加 ⚠️），不要只藏在日志或悬停提示里。
2. 文案说清两件事：新版号是多少、重启后才生效。例如：`⚠️ 新版 1.2.3 已装好，正在跑的还是 1.2.2，重启宿主后生效。`
3. 待重启期间不再提供安装按钮（快照里 `canInstall` 已为假），只给重启指引与手工命令入口。

判断只看快照：`blockedReason === 'pending-restart'` 即展示；`installedVersion !== runningVersion` 只作辅助校验——`runningVersion` 为 `null`（未知）时这条辅助校验不成立，不得据此判待重启。

**失败优先于待重启（`0.18.12` 起）**：装后校验失败（例如磁盘版本已到目标版、但 profile 清单没登记该插件）时，快照会同时带着 `blockedReason: 'pending-restart'`（磁盘与运行版确实不同）和 `job.state: 'failed'` —— 这是「装了但不会生效」，不是「待重启生效」。面板必须先判失败（`job.state === 'failed'` / `'interrupted'`，或面板自己的失败态），失败横幅优先展示，不要按本节展示待重启横幅、更不要把它说成「重启后生效」。本包自己的面板就是这个优先级（先失败、后待重启）。

**在册事实（`#190` 起）**：展示待重启前还要读 `snapshot.registered`——为 `false` 时重启宿主也不会加载该插件，文案不得再说「重启后生效」；应改说「新版本已写入磁盘，但该插件未登记，重启也不会加载」并给「先在宿主插件页选中该插件」的下一步（本包单插件横幅与批量总账都按这一格分行、分计数）。为 `null` 时按未知处理，沿用原文案，不得冒充未登记。

### 5.5 轮询与凭证

- 面板按 `panelPollMs` 轮询查状态；小于 250 毫秒直接抛错。
- 装更新要带查新版的凭证（`checkId`）与本次请求编号（`requestId`）。凭证有过期时间，过期后重新查一次新版再提交。
- 同一个 `requestId` 重复提交直接返回旧结果，不重装；同一使用范围同时只装一个，撞上会报 `update-busy`。
- 装合规版走同一条凭证链，但候选凭证按**安装位置标识**存活：面板重建、轮询、切页之后仍能确认，不会因为一次重渲染就问不到凭证；读不到时如实回过期，不猜版本（`0.18.7` 起）。
- 候选安装（装合规版）在**确认的那一刻**重跑一次决议：窗口过期、期间又发了新版、或源不可达，回 `check-expired` 并拒绝安装——绝不偷换用户点名的那个版本（`0.18.7` 起）。

### 5.6 跳过与版本通道

- 跳过按「插件标识 + 版本」持久化：用户点“跳过”后该版本不再提醒，新版本照常提醒（跳过是 dismissal，不是全局静音）。
- 重置入口与跳过发生在同一行：已跳过版本在更新横幅行展示为“已跳过 X.Y.Z · 恢复”，点恢复即清掉该版本的跳过并重查；不要藏进设置页。
- 版本通道默认 `stable`（与旧行为一字不差，预发布版按版本信息无效处理）；显式配 `releaseChannel: 'prerelease'` 才收预发布版。两个通道都只装精确版（`包名@精确版本`），范围写法一律不收。
- 远端 `dist-tags.latest` 指向预发布版本时（默认目标 deck 的真实形态），`stable` 通道不拿它当最新版：**已装版本在本通道时**，检查会再取一次全量包文档，在本通道允许的版本里挑最新发行版（坏条目与已标记弃用的版本跳过）。有更新的正式版就正常提示可装；本通道没有更新就按“已是最新”呈现，不再整次检查失败。全量包文档取不到则照旧报检查失败——不会悄悄画成“已是最新”。已装版本不在本通道或尚未安装时沿用原来的容忍分支（latest 原样回填、`blockedReason` 报通道不符）。`prerelease` 通道不受影响（直接收预发布）。

### 5.7 跨插件单队列

- 同一使用范围的全部插件共用一个队列（目录与按插件隔离的落盘树平级，任何插件标识都撞不上），一次只装一个；不同使用范围各用各的、可并行。
- 公平先进先出：非队首直接 `update-busy`（沿用旧码），忙时去查状态补看位置；取消只能撤自己的排队占位，装上了只能等收尾。
- 三个电话另收四个可选参数（不传即老样子）：`includeQueue: true` 顺带回队列视图，`showOthers: true` 才看他人明细（默认只看自己的，他人仅露“正忙”占位）；装更新另有 `enqueueOnly: true`（只取号不装）与 `cancelQueued: true`（撤自己的号），配 `requestId` 用。

### 5.8 更新说明

- 有新版本时面板在横幅下方展示“更新说明（当前版 → 新版）：”，按目标包内 `CHANGELOG.md`（Keep-a-Changelog 子集）渲染：`Added/Fixed/Changed/Security` 必显展开，`Deprecated/Removed` 折叠，`Unreleased` 与空节不展示。
- 条目正文按行内 Markdown 渲染（默认主题与档案卷是同一份 DOM，只换 CSS）：`` `行内代码` ``、`**粗体**`、`*斜体*`、`~~删除线~~`、`[文本](https://…)`、`<https://…>` 与裸 URL 都会成样式；`![alt](url)` 只出占位（显示 alt 与地址），**图片永不联网、永不产出 `<img>`**；表格／脚注／emoji 短码／`<details>` 不支持，按原样文本显示。HTML 永不直通：作者原文里的 `dsh-im<channel>` 这类尖括号文本照原样显示，不会被当标签吃掉。
- 条目第二行起按块级渲染：缩进子条目 → 嵌套 `<ul>`／`<ol>`，围栏代码块 `` ```lang `` → `<pre><code>`（语言标注只做识别、不进可见文本），引用块 `>` → `<blockquote>`，顶格段落 → `<div class="dsh-upd-md-para">`。单条超 500 字按行截断，截断处补 `…`、其后整行丢弃。
- **非六类小节名照收（0.16.0 起）**：`### Patch Changes`、`### 🚀 Enhancement`、`### 修复 1.2 的 bug` 这类作者自定小节名不再丢内容——标题原样显示、条目照收，进 `ChangelogEntry.otherSections`（`renderChangelogHTML` 直接画）。版本标题也放宽到 1–4 级任意标题、setext 下划线、两段版本号（`## 1.0`）与标题任意位置的版本号；`# Changelog`／`## License` 这类不会被误当版本节。
- **不会消失（0.16.0 起）**：认不出的块（HTML 注释、`<details>`、表格行、任务清单）按原文落进兜底段落显示；分隔线 `---`／`***` 画成横线；文件超 64 KiB 或版本被截时面板补一行说明。表格／任务清单暂时没有专有形态（表格不画成表格、任务清单不画复选框），但内容一定看得见——保真优先于花活。
- **集成方注意（0.16.0 起）**：`parseChangelog` 的 `ChangelogEntry.sections` 里**单个条目可能是多行字符串**（旧版一律压成一行），且嵌套子条目不再各占一条——`sections` 长度与 `counts` 只按父条目算。只走 `renderChangelogHTML` 的集成方零改动；自己解析 `sections` 的请改掉「一条一行」的假设。
- **集成方注意（0.16.0 起）**：`parseChangelog` 新增 `otherSections`（结构见 `ChangelogEntry`；不读它也不影响 `sections`）；`validateChangelog` 的 Code 表改了——`E_CATEGORY` 下线（非六类小节名不再丢内容），新增 `E_BULLET_ORPHAN`（版本节之外的条目，确实是 Error），`W_CATEGORY_OTHER` 替代前者作为提示。想区分「被截断」就改用 `parseChangelogReport(markdown)` 读 `truncation`（比 `parseChangelog` 多一层信息，形状不变）；面板在文件超 64 KiB 或版本被截时会补一行说明。
- 日志里的链接可点：默认开新窗口（桌面宿主交给系统浏览器，面板本身不会被导航走）；想自己接管就传 `mountUpdatePanel({ openLink })`（一次性替换缺省行为，抛错只吞）。只认 `http/https`，其余协议按纯文本渲染。
- 作者未提供说明时显示“作者未提供更新说明，安装不受影响。”——缺日志永不挡安装，不改变 `canInstall` 与 `blockedReason`。
- 默认自动：面板看到有新版本即按新版号调一次 `….updateChangelog`，回来自己填进第 02 章；同一版本只取一次，取不到即中性提示。作者侧只要写好包根 `CHANGELOG.md` 并随包发布，零新增代码。
- 手动模式（老用法照旧）：传 `autoChangelog: false` 即退回手动——已装版离线读本机 `node_modules/<目标包>/CHANGELOG.md`，新版按需取新版 tarball 内同名文件（复用官方源与 `integrity` 校验，取不到即回落中性提示；参考包根导出的 `readInstalledChangelogText` / `fetchReleaseChangelogText`），经 `mountUpdatePanel({ changelogMarkdown })` 或 `setChangelogMarkdown` 交给面板；显式传过的文本自动链路永不覆盖。
- Security 必显；超限进内折叠。截断计数按类标注“共 M 条，仅显示前 N 条”（M 原始条数、N 显示数）。
- to 版 yanked 时 02 章顶部横幅：“目标版本 X.Y.Z 已被作者撤回（yanked），安装不受影响，继续前请确认。”；中间版本只保留标题后缀。
- `BREAKING:`/`不兼容:` 只认条目开头，badge + 前缀加粗；疑似误写由 validate 报 warning。
- `validateChangelog(markdown)` 为纯函数（零导入、永不抛错），回 `{ ok, diagnostics: { line, code, hint }[] }`，line 为原文件行号；仅 CI/发布前用。
- memo：成功与取不到（null）按版本永久记；传输失败不记，手动查/换版/重开立即重试，轮询按退避问；`autoChangelog: false` 关闭整链。

### 5.9 桌面管理器路由的两步配方（`0.18.18` 起）

官方桌面版（`environmentKind: 'desktop-manager'`）的宿主管理器对「已经装着的包」不允许再 `add`（HMR 守卫，`already-installed`），所以更新已装包只能走宿主自己的「先移除、再装」两步。`0.18.18` 起这两步在移除前先探一次拓扑，并对失败人话格补上可复制的救急命令：

- **移除前先探拓扑**：用宿主 `listBundles()` 查目标包的 `removable` / `enabled`。
  - `removable === false`（宿主自带或受管理的包）⇒ 不尝试移除，直接诚实失败（人话格原因 `not-removable`，对外错误码仍是 `install-failed`）。
  - `enabled === false`（装着、在跑、但不在 `dsh.profile.bundles` 选中名单里——真机六件的形态）⇒ 先 `setBundleEnabled(name, true)` 恢复选中（宿主 `installBundle` 默认也做这一步，只是本包拆到移除之前），再 `removeBundle` → `installBundle`。
  - 旧宿主没有 `listBundles` ⇒ 退回老两步（会先盲删）；有 `listBundles` 但没有 `setBundleEnabled` 而目标又未选中 ⇒ 诚实失败（人话格说明「宿主不支持恢复选中，无法安全更新」）并给载体 CLI 命令。
- **救急命令**：`already-installed` / `bundle-in-use` / `not-removable` 三个码的失败详情尾部会补一条 ASCII 命令 ` (dsh plugin --profile <范围> add --save-exact <包名>@<版本> --registry=<源>)`——载体 CLI 在官方桌面版机器上可执行，是管理器外唯一能原地换版的通道。面板展示 `job.message` 时原样显示即可，不需要解析。使用范围名与源都取本次配方的真实值（不是写死的 `desktop`），源来自宿主注入或配置、与安装同源。
  - **恢复选中这一步的失败/超时也补同一条命令**；宿主没有 `setBundleEnabled` 时人话格说明「宿主不支持恢复选中，无法安全更新」（不再合成 `bundle-in-use` 冒充「还有别的层在用」）。
  - **宁可不给命令，也不给假命令**（`0.18.21` 起）：这条命令是给人复制到终端执行的，各平台 shell 的引号规则不同（cmd 不认单引号、PowerShell 的引号/反引号各有含义），所以使用范围名 / 源地址 / 规格里只要出现空白、`$`、反引号、引号、`&`、`;` 等任意一个无法确定安全的字符，就整条命令省略（只留原因与下一步文字）。`manualCommand`（手工兜底命令）同一政策：这类情况下返回 `null`，不再用 JSON 引号拼一条会被展开或截断的命令。
- **空更新哨兵**：安装请求的目标版本与磁盘已装版本相同 ⇒ 直接回 `installation-changed`（详情写「目标版本与已装版本相同，无需安装」），不建任务、不起安装；批量/旧快照拿已装版当目标时不再跑到装后校验才报错。
- **装后「在册」核实收窄为「登记不许倒退」**：新装必须进 `dsh.profile.bundles`（或老清单的 `dependencies`），否则失败（`0.18.12` 起的行为）；更新一个装前就未登记的包已经成功过的那次不因「仍未登记」判失败——否则真机那六件（装着、在跑、未选中）永远升不了级；装前登记过、装后清单里丢了（倒退）仍然失败。装前读取器没给出 `registered`（旧覆盖实现或清单读不到）而装后为 `false` 时仍判失败：无法证明不是新装，保守方向。
- **需要批准的构建脚本（`0.18.23` 起）**：宿主 pnpm 遇到被忽略的 `postinstall`/原生构建时，会先记住「等待批准」的**精确包名**再抛失败（宿主回包 `pendingBuilds`），过去这格被本包丢掉，用户只看到一句 `install-failed: <pnpm 原文>`。现在失败详情会点名「需要批准构建脚本：<包名…>；请先批准构建脚本（运行 `dsh plugin --profile <范围> approve-builds`），再重试本次安装」；用户批准后**用一个新的 `requestId` 带 `approvedBuilds` 重试一次**即可（`updateInstall` 的可选入参；同一 `requestId` 会被去重当旧结果返回）。名单与命令都守 300 字上限：名单太长时逐级少点名、退成「首个 等 N 个」，但**批准命令始终保留**（`0.18.24` 起；旧实现长名单会退到一句走不通的「去宿主插件页批准」——那个入口只出现在宿主自己的安装失败页，本包的 `updateInstall` 走不到）；`stale-approval` 表示名单已过期，应重新发起安装且不带旧名单。名单项按 npm 包名文法与 shell 安全双重过滤（非字符串、通配、`-` 开头、路径片段、`包@版本` 一律不点名），不会把开关样式或通配规则交回宿主。

## 6. 排错

按从常见到少见的顺序查，一次只动一处，动完重查一次状态。

1. `pluginId` 报必填或含路径分隔符：换成自己插件的标识，非空且不含 `/` `\`。
2. 电话名串台（两家插件收到对方的电话）：检查两家 `prefix` 是否相同，相同即改成不同的前缀；电话名永远从 `update.phoneNames` 读。
3. 面板轮询报错说小于 250 毫秒：把 `panelPollMs` 调到 250 或更大。
4. 查新版总超时：先调大 `checkTimeoutMs`，再检查源地址是否写错、网络是否通。
5. 点安装报 `check-expired`：凭证过期，重新查一次新版再点安装，不要重试旧编号。
6. 点安装报 `update-busy`：同一使用范围同时只装一个，等当前任务离开 `installing`/`verifying` 再点；跨插件排队时去查状态（`includeQueue: true`）看自己的位置，到队首再点，面板默认看不到他人明细。
7. 手工命令为空：对照第 5.2 节前两行（源码安装或认不出使用范围），先修好再要命令。
8. 装完版本号没变：先看是否 `pending-restart`（第 5.4 节），是则重启宿主；不是则按第 5.2 节的表查原因。
9. 第三方 Desktop 自动装失败但命令能装：检查桌面当前激活的使用范围是不是插件所在的那一个；对不上时自动装一定诚实失败，复制第 5.3 节的命令手工执行。
10. 官方桌面版（使用范围名 `desktop`）装不上：看任务里的 `message`，形如 `install-failed: <宿主原话>`，里面带着宿主的错误码（例如 `operation-error`）。`message` 可能带详情，**匹配请匹配前缀错误码，不要整串相等**；日志里这条路的路由是 `desktop-manager`。
11. 还定位不到：打开调试日志（第 10 节），用 `npx dsh-log <日志目录>` 看（`--since 2h`、`--level warn`、`--json` 都好用）。**命令里不要写 `tail`**：`dsh-log` 0.3.1 的解析器把非 `-` 开头的词一律当路径，写 `tail` 它会去找一个叫 `tail` 的目录并多吐一句「没找到日志目录：tail」（日志照常输出）。**`--trace <traceId>` 现在对本包自建落点的行也有效**（`0.16.4` 起）：一次电话一条链，同一通电话里的多行共享一个 `traceId`、`spanId` 分步骤边界（集成方注入客户端实例时照旧由 dsh-log 的客户端 SDK 建链）。按时间窗加事件名筛仍然好使。日志按插件标识分目录，同一台机器上多个用更新系统的插件**各写各的、不相互覆盖**；三个旧事件 `host.call`、`host.call.fail`、`update.install.exec` 照旧，`update.*` 是本包按环节新增的事件（全表见包内 `event-list.update.json`）。日志里不记命令与路径原文。
12. 以依赖形态接入后一直显示「安装位置在使用中途变了」（`installation-changed`）：`0.1.x` 的已知缺陷（拿「本包自己住在哪」推断目标包位置，依赖形态下恒失败）；升到 `0.2.0` 即修复。
13. 报 `unknown-profile` 但使用范围名与目录都没问题：先确认调用方传了 `ctx`（DSH 激活的插件自带 `ctx.profileContext`）；完全没有 profile 上下文的嵌入方请显式传 `readerOverrides.profileDir` / `profileName`。仍定位不到目标包时，让集成方传 `readerOverrides.targetPackageDir`，或把本包装成插件包的依赖（别装到别的 `node_modules` 树里）。

## 7. 接入自检清单

照第 2 节把名字换成自己的之后，逐条打勾：

1. 宿主启动不报错，`update.phoneNames` 读到自家前缀的六个电话名，查状态返回九字段快照。
2. 面板按间隔轮询到快照，能展示第 5.2 节的原因文案；有新版本时安装按钮可用，无新版本与待重启时按钮状态正确。
3. 模拟一次 `pending-restart` 能看到第 5.4 节的横幅，模拟一次自动装失败能看到第 5.3 节的命令可复制执行。
4. 第二家同机隔离与串行：两家各传自己的插件标识与电话名前缀，电话名、落盘目录、锁文件逐个不同；安装执行跨插件串行——同范围撞上时后到者报 `update-busy`，凭队列位置（第 5.7 节）重试。
5. 整组件（第 2 节第 4 步）：同一状态下内嵌与弹窗展示同一快照、同一按钮状态、同一复制内容；点“跳过”后该版本不再提醒，新版本照常提醒，“恢复”一击可达；复制出的诊断里没有绝对路径与个人标识。

## 8. 包还导出什么

**整组件**（`dsh-plugin-update/panel`，框架无关，样式隔离，类型定义随包分发）：

```js
import { mountUpdatePanel } from 'dsh-plugin-update/panel'

mountUpdatePanel(slot, { pluginId: 'notes', prefix: 'notes', call: host.call })
```

**更新日志自动**（#38：写 md 即显示，零新增代码）：

```js
// 宿主侧：createHostUpdate 把六个电话名全注册（本条讲第 4 个 updateChangelog；updateCheckFallback 与 logAppend 是后来加的），无新增配置
//   入参 { version }（发行版号，先验 validReleaseVersion + 通道门禁）
//   成功 { ok: true, version, markdown: string | null }（取不到即 null，中性提示）
//   失败复用 error / errorKind 体系；回包无路径、无快照；按版本记住结果
import { buildChangelogPhoneName } from 'dsh-plugin-update'

buildChangelogPhoneName('notes')  // 'notes.updateChangelog'，与宿主侧同一套拼法

// 面板侧：默认自动，有新版本调一次；显式文本仍赢，false 退回手动
mountUpdatePanel(slot, { pluginId: 'my-notes-plugin', prefix: 'notes', call: host.call })
// mountUpdatePanel(slot, { pluginId, prefix, call, autoChangelog: false })
// mountUpdatePanel(slot, { pluginId, prefix, call, changelogMarkdown })  // 手动模式
```

- 入口件（`dsh-plugin-update/entry`）把 `autoChangelog / changelogMarkdown` 透传给面板 dialog/inline；批量面板（`dsh-plugin-update/panel-batch`）展开行自动调该行自己的 `updateChangelog`（无新增批量电话，`autoChangelog: false` 可关整批）；HTTP 版（`dsh-plugin-update/http`）白名单已放行，默认路径即达。
- 面板侧日志（`0.16.0` 起，第 10 节）：`mountUpdatePanel` 默认按前缀自建客户端日志通道，电话名即 `<prefix>.logAppend`；`clientLog: { channel }` 换成你自己的通道、`{ mount: 'entry' }` 改挂载点名字、`null` 明确关掉。入口件（`entry`）与 HTTP 直挂（`http`）已经替你传好挂载点，HTTP 白名单也已放行 `logAppend`。

**客户端入口**（`dist/client.js`，构建期打包用）：

```js
buildClientPhoneNames('notes')  // 电话名拼法，与宿主侧同一套（前缀 + 点 + 动作名）
CLIENT_POLL.defaultMs           // 面板轮询默认值（1000）
CLIENT_POLL.minMs               // 轮询下限（250，低于它要报错而不是静默取整）
manualCommand({ ... })          // 手工兜底命令的形状，与宿主侧同一套政策
```

**事件清单检查器**（纯函数，不新增日志事件；形状对齐日志包 `dsh-log` 0.3.1）：

```js
import { parseEventListManifest, lintEventFields, computeEventCounts, lintEventList, mergeUpdateEvents, parseLogRow, stripReservedLogFields } from 'dsh-plugin-update'

const manifest = parseEventListManifest(myEventList)   // myEventList 是对象，先自己读盘
lintEventFields(manifest, 'host.call', ['method', 'pluginId'])   // { ok, severity: 'none' | 'warn' | 'error', ... }
computeEventCounts(manifest)                                      // { resident, ondemand, selfmon }：现算，清单不写 counts
lintEventList(manifest)                                           // 整份过尺子：{ ok, red, yellow, counts }
mergeUpdateEvents(myEventList, updateEvents)                      // 把本包的事件表并进你的清单

// 落盘行断言（0.3.1 的行格式恒五键 v/ts/level/event/fields，v 必须是 3；ts 是毫秒数 Date.now()）
parseLogRow({ v: 3, ts: 1792009014642, level: 'info', event: 'update.check.done', fields: {} })

// 拿清单量一条**读回来的行**之前，先摘掉引擎保留名（traceId/spanId/seq），否则带链的行会被判黄
lintEventFields(manifest, row.event, stripReservedLogFields(Object.keys(row.fields)))
```

事件清单的每条要写四样：事件名、级别（`error`/`warn`/`info`/`debug`）、允许字段（之外的键一律不记）、脱敏引用（`codes` 是截断或散列代号，`rules` 是具名正则名——都只记引用名，不记原文）。
`kind` 分三类只为计数服务：`resident` 常驻、`ondemand` 按需、`selfmon` 自监控。空模板见包内的 `event-list.template.json`；**本包自己的事件表见 `event-list.update.json`**（26 个事件：常驻 18、按需 7、自监控 1），第二家可以整份并进自己的清单（`mergeUpdateEvents`，字段取并集，级别与归类仍按你的声明）。
清单要以**对象**传入：字符串或数组会被拦下并给出中文说明，不静默修补。
`checkEventFields` 与 `checkEventCounts` 是 `0.16.0` 之前的旧名（`0.13.0` 及更早已发布版本里就是这两个名字），保留一版、行为不变，新代码用 `lintEventFields` 与 `computeEventCounts`。

**日志内核**（`dsh-plugin-update/log`，0.16.0 起；宿主侧零件，浏览器闭包别引它 —— 唯一例外是 `createClientLogChannel`，它零 `node:` 依赖，面板侧就是引它，见第 10 节）：

```js
import { deriveLogNamespace, acquireOwnLog, releaseOwnLog, emitUpdateLog, loadUpdateEventTable } from 'dsh-plugin-update/log'

deriveLogNamespace('My.Plugin')   // 'my-plugin-<hash6>'：有损派生必带 24 位指纹（同前缀下概率性区分）；合法标识原样通过
const got = await acquireOwnLog({ logsRoot, namespace, prefix: 'wf', eventList })
//   同目录复用同一个句柄（引用计数）；建不起来就降级：{ sink: null, reason: 'no-dsh-log' | 'lease-conflict' | 'write-fail' }
emitUpdateLog('info', 'host.call', fields, { pluginId })   // 唯一发射口：脱敏 + 字段白名单 + 准入短路 + 预算守卫
releaseOwnLog(namespace, logsRoot)   // 引用计数归零才真的释放引擎实例
```

集成方一般**不需要**直接用它：宿主侧 `createHostUpdate` 已经接好（传了 `logCtx` 就用你的实例，没传就用内核自建的那份）。只有自建宿主零件、或想把本包事件并进自己的日志实例时才用（`buildUpdateManifest(pluginId, 你的清单)` + `mergeUpdateEvents`）。

**宿主侧工具**：

```js
resolveTargetPackage(name, { targetPackageDir })  // 按包名解析你的插件包；找不到返回 null（自己搭读取器或写测试时用）

// 本插件日志目录（#123）：<homeDir>/logs/<派生命名空间>，与落盘同一个算式、同一套派生规则
import { updateLogDirFor } from 'dsh-plugin-update'

updateLogDirFor('notes', process.env.DSH_HOME)   // 家目录：显式入参 > DSH_HOME > ~/.dsh
```

把它传给面板挂载项的 `logDir`（`mountUpdatePanel` / `mountUpdatePanelHttp`，入口件同名选项），
错误章路牌就写出**具体路径**与现成的 `npx dsh-log <dir>` 命令；不传则退回目录算式与命令模板（第 11 节）。

**跨插件队列**（纯函数，面板侧同名函数见 `dist/client.js`，可进浏览器闭包）：

```js
import { visibleQueueFor, queuePositionOf } from 'dsh-plugin-update'

visibleQueueFor(queueState, 'my-plugin', false)  // 默认只看自己的，他人仅露正忙占位；传 true 看全量
queuePositionOf(queueState, 'my-plugin', requestId)  // 0 = 正在安装，1..n = 顺位，null = 未排队
```

## 9. 兼容与稳定性

这些形状稳定，可以放心依赖：六个电话名与入参回参（老三电话一字不动，`updateChangelog`、`logAppend`、`updateCheckFallback` 是后来加的；`updateInstall` 的 `version` 是可选参数）、快照七个核心字段 + `identity`（`#197` 起加：`update` / `first-install` / `up-to-date` / `null`，判定不了为 null；老调用方不读也能用）+ `registered`（`#190` 起加：在册事实，`false` 表示磁盘换版也不等于重启后会加载，未知为 null；老调用方不读也能用）、任务公开形状、配置只经函数入参注入、安装配方五键、日志事件字段基线（三个旧事件各带必填 `pluginId`）、历史落盘路径。形状扩展按版本列清楚：`0.18.7` 起，快照里带着失败任务时成功回包可带可选 `diag`；`0.18.10` 起，任务形状多一格可选 `previousVersion`；`0.18.12` 起，环境视图可带可选 `registered`（装后按「在册」核实；`0.18.18` 起语义收窄为「登记不许倒退」：新装必须登记，装前就未登记的包更新成功后不因仍未登记判失败，登记倒退仍失败——形状不变），`0.18.13` 起 `includeEnv` 带回的使用范围视图也带出同一格 `registered`（面板据此识别「被摘掉但没重装」）；`0.18.16` 起，`includeEnv` 视图再多两格可选自检事实 `updaterVersion` / `updaterCopyLevel`——**此刻在说话的是哪一份本包副本**：`profile` 使用范围级、`nested` 消费方 `node_modules` 里的嵌套副本、`repo` 开发仓库、`unknown`；面板页脚与「复制诊断」都显示同一事实，嵌套副本时 05 章直接给载体 CLI 升级命令；`0.18.23` 起，`updateInstall` 电话接受可选 `approvedBuilds`（构建脚本需要批准的包：批准后把宿主给过的精确包名原样带回重试，宿主先批准再跑 pnpm；不传即现状），响应形状与其余电话逐字不变。

向后兼容的扩展：新增可选配置键、新增可选面板选项（如 `autoCompliant`）、新增可选面板渲染选项（`updater`）、新增可选回包键（成功回包里的 `diag`）、新增可选任务字段（`job.previousVersion`）、新增可选环境字段（`env.registered`、`env.updaterVersion` / `env.updaterCopyLevel`）、新增可选快照字段（`snapshot.registered`，`#190` 起：在册事实，未知为 null）、新增可选 `readerOverrides`（如 `targetPackageDir`、`dshVersion`）、新增 `blockedReason` 取值（如 `incompatible-dsh`）、`snapshot.runningVersion` 增加 `null`（未知）语义、新增宿主种类与路由取值。调用方不认新取值时按普通宿主处理即可，不会因此报错。

**给消费方插件的依赖声明建议（`0.18.16` 起）**：把本包声明成 `^0.18.0`（或更新 minor）——0.x 的 caret 只锁 minor，`^0.13.0` 这类旧范围会把你钉死在 0.13.x，我们之后发多少修复都不会加载进你的嵌套副本。面板上的「更新器=版本（层级）」就是此刻在说话的那份副本；`nested` 意味着升级路径在声明它的插件那边（先更新它，或按 05 章的载体 CLI 命令操作）。

## 10. 日志（dsh-log 0.3.4）

`0.16.0` 起本包把 [`dsh-log`](https://www.npmjs.com/package/dsh-log) 作为**第一个运行期依赖**，`0.16.4` 起下限是 `^0.3.4`（决策与理由见 `docs/adr/0005-dsh-log-as-first-runtime-dependency.md`）。下限为什么跟着抬：链上下文（下一段）要 `0.3.3` 起才有，`0.3.1`/`0.3.2` 上本包只会**静默没有链**；`0.3.4` 另修了启动头幂等与目录摘要的诚实性。

**归属：谁建的实例谁说话。**集成方传了日志出口（宿主侧 `createHostUpdate({ logCtx })`），本包就用它的实例落盘，绝不另建第二个；没传，本包自建一份。两种情况下事件名、字段、级别完全一样。

**同进程同目录只有一个句柄。**本包在同进程内用一张挂在 `globalThis` 上的登记表按目录复用实例（引用计数到零才释放）：一个进程里出现两份本包副本（顶层一份、别的插件嵌套一份）时，第二份拿到的是**同一个**实例，不会出现谁把谁的日志吃掉。拿不到 `dsh-log`（没装、版本不对）或目录已被占用时**降级成「没有落点」**：事件照发、主流程零影响，并记一条 `update.log.degraded`（`reason` 是 `no-dsh-log` / `lease-conflict` / `write-fail`）。两个进程共用同一目录不在承诺内（dsh-log 只能事后诊断 `foreign-write`）。

**落点：一个插件一棵目录。**`<homeDir>/logs/<派生命名空间>/`，`homeDir` 默认取 `DSH_HOME`，没有则 `~/.dsh`。命名空间由 `pluginId` 派生：转小写 → 非 `[a-z0-9-]` 换 `-` → 折叠连续 `-` → 去首尾。**本身就是合法标识（小写字母数字连字符、1–32 位）的直接原样当目录名**；只有这一步有损（换过字符或被截断）才走有损分支：slug 截 24 位 + `-<sha256 原文前 6 位>`（合计 ≤31；slug 被吃光则回退 `plugin-<hash6>`）。两条不变量：合法标识原样通过；**无损分支下不同 `pluginId` 不共目录**（有损分支靠 24 位指纹区分，属概率性隔离——同一 24 位前缀的有损标识足够多时理论上可能撞名）。这就是「同一份 DSH 里多个用更新系统的插件日志不相互覆盖」的机制（开关文件同一套命名：`log-switch-<派生名>.json`）。

**启动头自述（`0.16.4` 起）。**建库时 dsh-log 会在目录里写一行 `host.start`（`0.3.4` 起幂等：同一个实例只写一行），本包在那一行填 `pluginVersion` —— 本包自己的版本号（`ownPackageVersion()` 读随包 `package.json`，可用 `acquireOwnLog({ pluginVersion })` 覆盖成你那一版），`os` 由引擎记。交日志时对方先看这一行，就知道「这堆行出自哪一版」。

**事件：三个旧事件形状冻结，`update.*` 按环节铺开。**`host.call`、`host.call.fail`、`update.install.exec` 的名字一字不动；字段只有一次破冰加格——`host.call.fail` 自 #150 起多一格 `error`（与回包同一稳定码，旧读数忽略未知格，余下两事件字段仍冻结）。新增事件按 19 个环节（检查、源查询、通道、安装、校验、重试、队列、批量、重启、面板…）命名，全表与字段白名单在包内 `event-list.update.json`，是实现的唯一事实源。日志行**只承载稳定码与参数**，人话留给面板与诊断渲染（ADR-0006）——所以日志里不会出现「安装失败：……」这类句子。

**噪声预算。**轮询看状态**一条常驻行都不落**——第一次也不算事件（它的第一次观测没有可比的上次），状态真变了才留一条 `update.status.changed` 供追溯；稳态一天不超过 50 行，一个操作日不超过 500 行。`info` 只在调试开关打开或事件是常驻时落盘；`warn`、`error` 始终落盘。检查电话与安装电话另各收一个**只进日志**的可选参数（`trigger`、`from`），不传即老样子。

**开关：默认关着，改了要重启。**`info` 的准入由 dsh-log 的开关文件决定：`<DSH_HOME>/logs/log-switch-<派生命名空间>.json`，内容就是 `{ "enabled": false }`，默认关。注意它在 `logs/` **根下**、与日志目录平级，不是目录里的文件（`pluginId` 恰为 `wf` 时文件名退化为 `log-switch.json`）。两件事要知道：① 它只管**按需**事件——`warn`/`error` 与常驻事件不受它影响（本包 26 条事件里 19 条恒落、7 条受它管）；② dsh-log 在实例启动时把开关读进内存后**永久缓存**，运行中改这个 JSON 对活着的实例无效，**要重启宿主**才生效。本包不注册 dsh-log 的宿主日志电话（`logGetSwitch`/`logSetSwitch` 等六个都不注册），所以没有「在面板里拧开关」这条路。

**面板侧的日志（`0.16.0` 起）。**面板跑在浏览器闭包里，落盘是宿主的事，中间隔着 `….logAppend` 电话：面板把行攒进一个有界环形缓冲（缺省 200 行，满了挤掉最老的并计数），按批交回宿主（缺省一批 50 行、间隔 1 秒；页面切到后台立即冲刷一次），失败退避重试 2 次后丢弃并计数 —— 整条路**永不外抛**，日志坏了不挡更新。宿主侧这一头是协议面：只收五个客户端事件（`update.panel.mount` / `update.panel.action` / `update.panel.render.fail` / `update.panel.state` / `update.lang.applied`），级别必须是 `debug`/`info`/`warn`/`error`，字段必须过本包事件清单，超量（一次 200 行以上）、过期（10 分钟以上的旧行）、形状不对一律计入回包的 `dropped`，**不产生 `host.call` 行**（不给日志自己制造噪声）。面板默认自建这条通道（电话名从前缀派生）；`mountUpdatePanel` 的 `clientLog` 选项可以换成你自己的通道或明确关掉：`{ channel }` 注入、`{ mount: 'entry' }` 记挂载点、`null` 关闭。入口件与 HTTP 直挂已经替你传好挂载点。

**不自动上报。**日志只落本地磁盘，本包不会替你把它发给任何人——什么时候交、交给谁由你决定（下一节给了现成命令）。

## 11. 把日志交给我们（`npx dsh-log <dir>`）

日志包自带只读命令行，不必装进项目（`npx` 临时取一次）：

```sh
npx dsh-log <DSH_HOME>/logs/<派生命名空间>              # 看某一个插件的日志
npx dsh-log <DSH_HOME>/logs --since 2h --level warn     # 所有插件、最近两小时的告警及以上
npx dsh-log <dir> --trace <traceId>                     # 追链：本包自建落点 0.16.4 起一次电话一条链（客户端 SDK 的行照旧）
npx dsh-log <dir> --json > update.log                   # 导出原始 JSON 行（给脚本或工单用）
```

**命令里不要写 `tail`。**`dsh-log` 自带文档写的是 `dsh-log tail <目录>`，但它 0.3.1 的解析器把非 `-` 开头的词一律当成路径 —— 写 `tail` 它会去找一个叫 `tail` 的目录，多吐一句「没找到日志目录：tail」（日志照常输出、退出码仍是 0）。上面四行是能直接抄的形式。

提 issue 或找我们时请一并给上四样：① 本包版本（`npm ls dsh-plugin-update`）；② 你的 `pluginId` 与日志目录名；③ 出问题的时间窗；④ 面板错误页的「复制诊断」文本（含稳定码与宿主原话）。有这四样，绝大多数问题不用来回问。

**面板已经把这条命令递到手上（`0.16.0` 起）。**错误章的日志路牌在面板里给出现成命令：宿主/入口把上一条的 `updateLogDirFor(...)` 结果传给面板挂载项的 `logDir` 时写**具体路径** + `npx dsh-log <该路径>`；没传（例如老宿主）则写 `<DSH_HOME>/logs/<派生命名空间>` 的算式与命令模板——路牌宁可说「目录长这样、命令长这样」，也不指一个不存在的值。「使用范围」那栏照旧只回范围名与宿主种类：**电话回包不带任何目录路径**（日志行里也只有一个 `logDirHash`）。

日志在写入前就脱敏（绝对路径、URL 里的账密、令牌、凭据、邮箱五类换成占位符，规则见 `src/redaction.ts`），可以放心贴；贴之前扫一眼仍是好习惯。

## 致谢

感谢每一位让这个包变好的人：

- [FeatherHunter](https://github.com/FeatherHunter) 🌹×198
