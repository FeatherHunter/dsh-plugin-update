# dsh-plugin-update

给 DSH 插件加「检查更新 / 安装更新」能力的 npm 包。宿主侧一段接线，面板侧挂一个现成组件，装不上时给用户一条可复制的手工命令。

要求 Node 22 或更高，零运行时依赖。当前版本 `0.5.2`。

装上它你会拿到六样东西：

- **四个电话**：查状态（只读本地）、查新版（用户点了才联网一次）、装更新（拿凭证提交）、取日志（按版取更新日志，全文或空）。电话指宿主对外提供的方法。
- **一套落盘**：任务状态、安装锁、回滚凭据，按「插件标识 + 使用范围」隔离，多插件互不干扰。
- **面板要的派生取值**：电话名与轮询间隔，构建期从本包生成，面板里不写死。
- **一个现成整组件**：默认内嵌、可切弹窗，调用者传参指定；轮询、安装门控、中文一句话、待重启横幅、手工命令展示与复制、排队可见开关、跳过与恢复、诊断一键复制、**更新日志自动展示**全在组件内部消化。
- **一个更新入口件**：配置页一行挂上就是「检查更新」按钮（或只给状态点的徽标、或整块内嵌），按钮文案随状态自己变；见第 2.5 节。
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

这一步得到四个电话名：`notes.updateStatus`、`notes.updateCheck`、`notes.updateInstall`、`notes.updateChangelog`（取日志：给版本号，回该版 tarball 里的更新日志全文，取不到回空）。

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

本包是 ESM（`"type": "module"`）：ESM 插件直接 `import`；CJS 插件用 `await import('dsh-plugin-update')`。

### 四个电话的入参与回参

面板与宿主两侧共用这一份契约（`…` 是你的前缀）：

| 电话 | 入参 | 成功回包 | 失败回包 |
|---|---|---|---|
| `….updateStatus` | `{}` | `{ ok: true, snapshot, manual, receipt: null }` | `{ ok: false, error, errorKind, diag? }` |
| `….updateCheck` | `{}` | `{ ok: true, snapshot, manual, receipt }` | 同上 |
| `….updateInstall` | `{ checkId, requestId }` | `{ ok: true, snapshot, manual, receipt: null }` | 同上 |
| `….updateChangelog` | `{ version }` | `{ ok: true, version, markdown: string \| null }` | 同上 |

- `snapshot` 恒为第 5.1 节那六个字段；`manual` 是第 5.3 节那条手工命令（能给则给，不能给为 `null`）。
- `receipt` 只有查新版给（`{ checkId, checkedAt, expiresAt }`）；装更新时把 `checkId` 原样带回来，`requestId` 由面板自己生成（同一个编号重复提交直接返回旧结果）。
- 失败一律 `ok: false`：`error` 是原因码（第 5.2 节那八种，另加 `check-failed` / `invalid-release` / `check-expired` / `update-busy` / `install-failed`），`errorKind` 认不出时是 `internal`。面板按 14 码给中文文案（八种见第 5.2 节，另五种与 `internal` 见下表，未来码走兜底）；分支只认 `errorKind`，`error` 仅回退。
- 失败可能顺带回可选 `diag`（失败证据小对象：阶段、路由、耗时、人话摘要、版本、宿主、请求与检查编号、源主机、动作提示；缺省即省略，序列化恒在 1KB 内）。旧面板直接忽略它，行为逐字不变；新面板也只按稳定码分支，不拿它做分支。

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

组件内部消化的事（调用者不再写）：按 `panelPollMs` 轮询查状态（下限 250 毫秒）；安装按钮状态跟随快照的 `canInstall`，不另写门控规则；装不了的原因按第 5.2 节展示中文一句话；`pending-restart` 单独横幅加重启指引，不再给安装按钮；手工命令展示与复制；排队位置展示与 `showOthers` 开关；跳过按版本记（“已跳过 X.Y.Z · 恢复”在同一行，不藏进设置页）；失败时旁边的“复制诊断”一键给出脱敏后的自包含文本（稳定码、版本、宿主、队列位置），深挖仍看日志（组件里留着第 6 节第 11 条的过滤口径）。失败横幅常驻：查/装失败后保留到下一次用户主动查/装的新结论、任务态或版本变化，只读轮询不再洗掉；复制诊断锁定致命那次回包的证据（码、摘要、版本、宿主、编号冻结在失败时刻）；失败旁有「知道了」可显式确认回到可装页（只清面板提示，不调电话）。

待重启横幅上有个「重启宿主」入口。宿主没有“重启自己”的电话，所以默认点击只如实提示「请手动重启宿主」；想把重启流程接进来就传 `onRestartRequested`（面板调它，成败都回执）：

```js
mountUpdatePanel(slot, { pluginId: 'my-notes-plugin', prefix: 'notes', call: host.call,
  onRestartRequested: async () => { /* 拉起你自己的重启流程 */ } })
```

面板画成档案五章：**01 检查与安装、02 更新日志、03 更新队列、04 错误信息、05 手工命令**（五章恒在，缺内容给中性提示，不跳号）。档案头一行是「插件名 + 使用范围 + `profile` 牌」：使用范围由面板自动向宿主索取（电话入参 `includeEnv`，宿主只回**范围名与宿主种类**、不回任何路径），显示的就是更新要落到的那个 profile——`web` 与 `desktop` 各装一份，装错范围是严重故障，所以这一栏宁可显示“未知”也不猜。调用方知道得更准时可以用 `profileName` 显式覆盖。

可选档案卷主题（纸面浅色案卷风，不替换默认）：挂载时加 `theme: 'archive'` 即换肤（右上大印章「待查/可装/安装中/待重启/受阻/已最新」+ 横幅小印章一字 + profile 牌 + 待重启衬线横幅配手绘 SVG 标 + 窄屏印章固定 + 省略号逐字折叠 + 浅深双主题跟随系统），内核 DOM 顺序不动、复制诊断常在；不传即最小可用默认深色样式。运行时用 `panel.setTheme('archive' | 'default')` 可切。旧值 `theme: 'd5-paper'` 仍可用（同一套渲染）。入口件与批量面板是同一个 `theme` 参数，取值同一套。

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
| 点了做什么 | `has-update` / `always` / `manual` / `direct` | `has-update` | 有新版才开面板；检查完总是开；交给 `onActivate` 自己跳；点开即弹窗、不预查 |

按钮文案随状态自己变：`检查更新` / `有新版 1.1.0` / `正在安装…` / `待重启` / `更新失败，点此查看`。

无新版时原地那句小字（`已是最新 X.Y.Z`）只在 `has-update` 下出现：不想看它就用 `openOn: 'always'`（检查完总是开弹窗，无新版在弹窗里看“已是最新”）或 `openOn: 'direct'`（点开即弹窗，连预查都省了，面板挂载即自查；徽标形态仍走回调口径）。

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
  prefix: 'life',                              // 批量电话前缀（五个批量电话从它派生）
  call: (name, args) => host.call(name, args),
  theme: 'archive',                            // 与单入口/面板同一套皮肤
})
// 点击先调 `life.batchCheck` 查一次 N 家，再以 dialog 形态开批量面板；徽标即七家聚合。
// 下游删掉 `openOn: 'manual' + onActivate` 桥接即跑，总管单行不再当状态源。
```

聚合口径与批量面板总账同一份数法（含「忙失败占位翻回可更新」）：`忙 > 失败 > 待重启 > 可更新 > 待查`，
文案为 `检查更新` / `N 家可更新` / `正在安装…` / `N 家待重启` / `N 家失败，点此查看`。
三自由度与单入口同取值，缺省不同：`openOn` 缺省 `'always'`（查完总是开批量面板；`has-update` 下有事才开，否则原地给总账一句）。
`autoCheck` 缺省 `'mount'`（只调 `.batchStatus`，只读）；铁律同单入口：任何路径都不自动安装。

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

五个批量电话（`<prefix>` 即上面的 `life`）：`batchStatus` / `batchCheck` / `batchInstall` / `batchResume` / `batchCancel`；
每个目标的四个单插件电话照旧以**各自前缀**暴露（`ilife-bill.updateStatus` 等）。

回包形状（成功恰好四项，失败只有三项）：

```js
{ ok: true, session, rows, progress }      // rows 一行一家：key/title/phase/targetVersion/restartRequired/error/snapshot
{ ok: false, error, errorKind }            // 跨使用范围混目标会回 cross-scope，不抢锁、不写盘
```

面板侧：

```js
import { mountUpdateBatchPanel } from 'dsh-plugin-update/panel-batch'

const panel = mountUpdateBatchPanel(el, {
  prefix: 'life',
  call: (name, args) => host.call(name, args),
  theme: 'archive',          // 与单插件面板同一套皮肤（archive = 档案卷，旧值 d5-paper 仍可用）
})
```
// 弹窗版与单面板同口径：传 `onCloseRequested`（点关闭/Esc 时先调它撤 DOM，再停轮询；入口件打开的 dialog 已内置；不传即只停轮询）。

批量面板 HTTP 版（无 `host.call` 环境即跑：同一传输内核，五电话走同一映射，取消走 `batchCancel`）：

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
`装 X.Y.Z / 重试`、`跳过这一版`（与单插件面板同语义：按插件+版本记，跳过后那家单独看也不再提醒）、
`复制手工命令`、`复制诊断`——全部走与行内**同一条** `act()` 通道、同一份忙守卫。
「复制诊断」需要宿主把失败诊断一并回出来：`batchStatus` 的每个 row 带可选 `diag` 与 `pluginId`。

> 自己写渲染时同理：`renderUpdatePanelHTML(input)` 少传 `actions` 即默认（画动作行）；
> 传 `actions: 'none'` 就是只读内容——**凡是要复用内核 HTML 的地方，都必须显式接管或摘掉它的动作面**。

**耐久（这是这套东西存在的理由）**：批量会话落在
`<家目录>/update-queue/<使用范围短指纹>/batch.json`，每一步都写盘。所以关面板、重载页面、
甚至进程重启都不怕——`batchResume` 读回来接着推：**已完成的不重装**（编号恒等、幂等），
没做完的重新查一次再装。这就是「更新自己时 UI 消失、剩下几家永不启动」那个病的正解。

**自更新安全**：`selfKey` 指定的那家默认排到最后。承载更新界面的那个包若第一个被替换掉，
界面与推进它的循环会一起消失——排最后则前面几家早已落盘收尾。

**跨使用范围如实拒绝**：`web` 与 `desktop` 各自排队（装的是不同落点），混在一起的目标会回
`cross-scope`，本包不会替你跨范围抢锁。

### 第 2.7 节：更新日志自动展示（告诉用户更新了什么）

任何插件的升级能力都是两件事：**① 给一套面板**（上面第 4 步 / 2.5 / 2.6，挂载一行即跑）；**② 告诉用户这次更新了什么**（本节，写 md 即显示，零新增代码）。

```js
import { mountUpdatePanel } from 'dsh-plugin-update/panel'

// 与第 4 步同一行，不用加任何参数：有新版时第 02 章“更新日志”自动出现
const panel = mountUpdatePanel(document.getElementById('update-slot'), {
  pluginId: 'my-notes-plugin',
  prefix: 'notes',
  call: (name, args) => host.call(name, args),
})
```

作者侧只写文件，不写代码（发布后用户自动看到）：

1. 包根放 `CHANGELOG.md`（文件名全大写，小写视为没有），版本节形如 `## [1.2.0] - 2026-10-05`（最新在前），分类用 `### Added/Fixed/Changed/Security`（面板必显展开；`Deprecated/Removed` 折叠；`Unreleased` 与空节忽略）。
2. `package.json` 的 `files` 白名单加上 `CHANGELOG.md`（否则发出去的包里没有它，面板永远读不到），发布前跑一次 `npm publish --dry-run` 核对。

行为：有新版时面板按新版号自动取一次该版 tarball 里的全文（复用官方源 + `integrity` 校验，同一版本只取一次）；删了文件或取不到即中性提示，**安装永远不受影响**。想自己接管就传 `autoChangelog: false` 退回手动（备好文本后 `mountUpdatePanel({ changelogMarkdown })` 或 `setChangelogMarkdown` 传入，显式文本永不被覆盖）。入口件与批量面板同样自动：前者透传，后者展开行按行取。细节与边界见第 5.8 节。

安全事项必显：`### Security` 与 `Added/Fixed/Changed` 同级展开。单类超 200 条时前 200 条展开、其余收进该类内部折叠并标计数。目标版本被撤回（标题含 `[YANKED]`）时，第 02 章顶部加一条警告横幅，安装不受影响。条目开头写 `BREAKING:` 或 `不兼容:`（大小写不敏感，中英文冒号皆可）即挂破坏标记，正文不动。同一版本日志只取一次；取不到显示中性提示，安装不受影响。

### 升级本包（已经接入过的项目）

宿主种类与安装出口都由本包自己探测和选择，**升级依赖即可，宿主侧与面板侧都不用改代码**：

1. 依赖版本提到 `^0.5.2`。
2. 重新装 / 发一版你自己的插件，让新依赖进当前使用范围（运行时用的是 `node_modules` 里那份）。
3. 如果你自己接过一版宿主安装出口，把它删掉——它会挡在本包的路由前面。

两处例外必须动代码（它们把自动探测挡住了）：显式传了 `readerOverrides.environmentKind`；显式传了与真实使用范围不符的 `profileDir` / `profileName`。

`targetPackageName` 建议就是你自己的包名：使用范围目录按「装好的包住在 `<范围>/node_modules/<目标包名>`」反推。

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

落盘目录按标识派生：家目录下 `updates` 加插件标识加使用范围短指纹，三个文件名是 `state.json`、`install.lock`、`before.json`。读走双读（先新后旧），写只写新。
标识取历史值 `dsh-mattpocock-skills-deck` 时，路径与旧版一字不差（升级不丢状态）。

## 4. 安装是怎么执行的

你不需要按宿主分支：包探测当前宿主，选它自己的安装出口。

| 宿主 | 出口 | 说明 |
|---|---|---|
| 第三方 Desktop（发布 `desktopProfiles` / `desktopPnpm` 的那一支） | 桌面服务 `desktopPnpm.runPlugin` | 装进「当前激活的使用范围」；激活范围与本插件所在范围对不上时宁可不装 |
| 官方桌面版（宿主进程内的插件管理器） | `pluginManager.installBundle` | 只收 `包名@精确版本`，不接受任何开关 |
| 普通 DSH 宿主 | 自己起 `dsh plugin --profile <名> add …` | 参数数组直传；不经 shell、不用 `PATH` 上的命令名、不按系统分支 |

三种出口都只装**精确版本**。第三方 Desktop 与普通宿主把官方源写进参数（`--registry=`），官方桌面版走管理器的 `registry` 选项。
官方源不可达时诚实失败，不换源。三种出口都不成立（宿主既没有桌面服务、也没有插件管理器、命令行入口也认不出）时同样诚实失败，转第 5.3 节的手工命令。
装不上时宿主原话（截断到 300 字、去掉绝对路径）会写进任务说明 `job.message`，形如 `install-failed: <原话>`。

时间口径：查新版 2 秒内重复点击复用上次结果；安装按 `installTimeoutMs` 计时，到点终止（官方桌面版先请求宿主取消，来不及就等它收尾再定成败）；终止宽限 3 秒。

要显式覆盖出口（例如自己把宿主管理器实例交进来）：`createHostUpdate({ ctx, pluginManager })`，不传就从 `ctx` 现取。

## 5. 用户会看到什么

### 5.1 快照六字段

查状态与查新版都返回同一份快照，恰好六个字段：

| 字段 | 含义 |
|---|---|
| `installedVersion` | 磁盘上装着的版本 |
| `runningVersion` | 正在跑的版本 |
| `latestVersion` | 最近一次查新版带回来的版本（没查过为 null） |
| `canInstall` | 现在能不能装 |
| `blockedReason` | 装不了的原因（能装为 null） |
| `job` | 当前任务（只读半程恒为 null） |

### 5.2 八种装不了的原因

面板拿到非空 `blockedReason` 时，直接展示下表「用户该做什么」那一列的一句话，不要只展示英文原因本身。

| 原因 | 中文含义 | 用户该做什么 |
|---|---|---|
| `unknown-profile` | 使用范围或插件位置认不出 | 重开宿主再查一次；一直这样就把版本号与日志交给插件作者；这种情形不给手工命令 |
| `source-install` | 当前是从源码装的，不是按版本号装的 | 这种情形不给手工命令；想走更新先按版本号重装一次 |
| `invalid-installation` | 已装的包不完整（名字对不上、版本非法、入口文件缺失） | 重装当前版本，修好已装目录再查更新 |
| `installation-changed` | 安装位置在使用中途变了（换了目录或换了包） | 重新打开宿主再查一次；还出现就重装 |
| `pending-restart` | 新版已装到磁盘，正在跑的还是旧版 | 重启宿主，让新版跑起来；这是正常终态，不是失败 |
| `registry-conflict` | 本地声明的版本与磁盘实际版本互相矛盾 | 打开使用范围的清单文件，把目标包名那一行改成版本号再试 |
| `incompatible-node` | 新版要求的 Node 与当前运行的对不上 | 先升级 Node 到 22 或更高，再查更新 |
| `recovery-required` | 上次安装被打断，留下一个半截任务 | 重新点一次安装；一直出现就按第 6 节排错 |

电话专属码与 `internal`（面板同样给中文，不只给英文码；未来码走兜底并带上原码）：

| 原因 | 中文含义 | 用户该做什么 |
|---|---|---|
| `check-failed` | 查新版没成功（联网、源、限流都可能） | 过一会儿再查一次；一直失败就把复制诊断交给插件作者 |
| `invalid-release` | 拿到的发布信息不合法（版本号非法或内容对不上） | 检查清单文件里的包名与版本写法，再查一次 |
| `check-expired` | 凭证过期了，安装请求被拒 | 重新查一次新版再点安装，不要重试旧编号 |
| `update-busy` | 同一使用范围正在装另一个 | 等当前任务离开 installing/verifying 再点；排队中去查状态看位置 |
| `install-failed` | 装不上（详见诊断摘要） | 先看复制诊断；官方桌面版把这段交给插件作者 |
| `internal` | 出了点问题，认不出具体原因 | 先重试一次；一直这样就把复制诊断交给插件作者 |

### 5.3 手工兜底命令

每次查状态与查新版都会顺带回一条手工命令（字段名 `manual`），能给则给、不能给则为空。
为空是正常的两种情形：源码安装、认不出使用范围（上表前两行），此时只展示原因。

```sh
dsh plugin --profile my-web add --save-exact my-notes-plugin@1.2.3 --registry=https://registry.npmjs.org/
```

使用范围名含空格或特殊字符时命令里会自动加引号，复制整行执行即可；网络受限时用户可以自行去掉 `--registry=` 走本地源。

面板每次拿到回包都刷新展示这条命令，不要缓存旧的。

### 5.4 ⚠️ 待重启提示（必须做）

`pending-restart` 不是失败，是「磁盘已是新版、正在跑的还是旧版」。面板必须满足三条：

1. 用显眼样式单独展示（例如顶部横幅加 ⚠️），不要只藏在日志或悬停提示里。
2. 文案说清两件事：新版号是多少、重启后才生效。例如：`⚠️ 新版 1.2.3 已装好，正在跑的还是 1.2.2，重启宿主后生效。`
3. 待重启期间不再提供安装按钮（快照里 `canInstall` 已为假），只给重启指引与手工命令入口。

判断只看快照：`blockedReason === 'pending-restart'` 即展示；`installedVersion !== runningVersion` 只作辅助校验。

### 5.5 轮询与凭证

- 面板按 `panelPollMs` 轮询查状态；小于 250 毫秒直接抛错。
- 装更新要带查新版的凭证（`checkId`）与本次请求编号（`requestId`）。凭证有过期时间，过期后重新查一次新版再提交。
- 同一个 `requestId` 重复提交直接返回旧结果，不重装；同一使用范围同时只装一个，撞上会报 `update-busy`。

### 5.6 跳过与版本通道

- 跳过按「插件标识 + 版本」持久化：用户点“跳过”后该版本不再提醒，新版本照常提醒（跳过是 dismissal，不是全局静音）。
- 重置入口与跳过发生在同一行：已跳过版本在更新横幅行展示为“已跳过 X.Y.Z · 恢复”，点恢复即清掉该版本的跳过并重查；不要藏进设置页。
- 版本通道默认 `stable`（与旧行为一字不差，预发布版按版本信息无效处理）；显式配 `releaseChannel: 'prerelease'` 才收预发布版。两个通道都只装精确版（`包名@精确版本`），范围写法一律不收。

### 5.7 跨插件单队列

- 同一使用范围的全部插件共用一个队列（目录与按插件隔离的落盘树平级，任何插件标识都撞不上），一次只装一个；不同使用范围各用各的、可并行。
- 公平先进先出：非队首直接 `update-busy`（沿用旧码），忙时去查状态补看位置；取消只能撤自己的排队占位，装上了只能等收尾。
- 三个电话另收四个可选参数（不传即老样子）：`includeQueue: true` 顺带回队列视图，`showOthers: true` 才看他人明细（默认只看自己的，他人仅露“正忙”占位）；装更新另有 `enqueueOnly: true`（只取号不装）与 `cancelQueued: true`（撤自己的号），配 `requestId` 用。

### 5.8 更新说明

- 有新版时面板在横幅下方展示“更新说明（当前版 → 新版）：”，按目标包内 `CHANGELOG.md`（Keep-a-Changelog 子集）渲染：`Added/Fixed/Changed/Security` 必显展开，`Deprecated/Removed` 折叠，`Unreleased` 与空节不展示。
- 作者未提供说明时显示“作者未提供更新说明，安装不受影响。”——缺日志永不挡安装，不改变 `canInstall` 与 `blockedReason`。
- 默认自动：面板看到有新版即按新版号调一次 `….updateChangelog`，回来自己填进第 02 章；同一版本只取一次，取不到即中性提示。作者侧只要写好包根 `CHANGELOG.md` 并随包发布，零新增代码。
- 手动模式（老用法照旧）：传 `autoChangelog: false` 即退回手动——已装版离线读本机 `node_modules/<目标包>/CHANGELOG.md`，新版按需取新版 tarball 内同名文件（复用官方源与 `integrity` 校验，取不到即回落中性提示；参考包根导出的 `readInstalledChangelogText` / `fetchReleaseChangelogText`），经 `mountUpdatePanel({ changelogMarkdown })` 或 `setChangelogMarkdown` 交给面板；显式传过的文本自动链路永不覆盖。
- Security 必显；超限进内折叠。截断计数按类标注“共 M 条，仅显示前 N 条”（M 原始条数、N 显示数）。
- to 版 yanked 时 02 章顶部横幅：“目标版本 X.Y.Z 已被作者撤回（yanked），安装不受影响，继续前请确认。”；中间版本只保留标题后缀。
- `BREAKING:`/`不兼容:` 只认条目开头，badge + 前缀加粗；疑似误写由 validate 报 warning。
- `validateChangelog(markdown)` 为纯函数（零导入、永不抛错），回 `{ ok, diagnostics: { line, code, hint }[] }`，line 为原文件行号；仅 CI/发布前用。
- memo：成功与取不到（null）按版本永久记；传输失败不记，手动查/换版/重开立即重试，轮询按退避问；`autoChangelog: false` 关闭整链。

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
11. 还定位不到：打开调试日志，按插件标识过滤 `host.call`、`host.call.fail`、`update.install.exec` 三个事件，看 `pluginId` 与 `route`、`exitCode` 字段；日志里不记命令与路径原文。
12. 以依赖形态接入后一直显示「安装位置在使用中途变了」（`installation-changed`）：`0.1.x` 的已知缺陷（拿「本包自己住在哪」推断目标包位置，依赖形态下恒失败）；升到 `0.2.0` 即修复。
13. 报 `unknown-profile` 但使用范围名与目录都没问题：本包按包名找不到你的插件包。让集成方传 `readerOverrides.targetPackageDir`，或把本包装成插件包的依赖（别装到别的 `node_modules` 树里）。

## 7. 接入自检清单

照第 2 节把名字换成自己的之后，逐条打勾：

1. 宿主启动不报错，`update.phoneNames` 读到自家前缀的四个电话名，查状态返回六字段快照。
2. 面板按间隔轮询到快照，能展示第 5.2 节的原因文案；有新版时安装按钮可用，无新版与待重启时按钮状态正确。
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
// 宿主侧：createHostUpdate 顺手注册第 4 个电话，无新增配置
//   入参 { version }（发行版号，先验 validReleaseVersion + 通道门禁）
//   成功 { ok: true, version, markdown: string | null }（取不到即 null，中性提示）
//   失败复用 error / errorKind 体系；回包无路径、无快照；按版本记住结果
import { buildChangelogPhoneName } from 'dsh-plugin-update'

buildChangelogPhoneName('notes')  // 'notes.updateChangelog'，与宿主侧同一套拼法

// 面板侧：默认自动，有新版调一次；显式文本仍赢，false 退回手动
mountUpdatePanel(slot, { pluginId: 'my-notes-plugin', prefix: 'notes', call: host.call })
// mountUpdatePanel(slot, { pluginId, prefix, call, autoChangelog: false })
// mountUpdatePanel(slot, { pluginId, prefix, call, changelogMarkdown })  // 手动模式
```

- 入口件（`dsh-plugin-update/entry`）把 `autoChangelog / changelogMarkdown` 透传给面板 dialog/inline；批量面板（`dsh-plugin-update/panel-batch`）展开行自动调该行自己的 `updateChangelog`（无新增批量电话，`autoChangelog: false` 可关整批）；HTTP 版（`dsh-plugin-update/http`）白名单已放行，默认路径即达。

**客户端入口**（`dist/client.js`，构建期打包用）：

```js
buildClientPhoneNames('notes')  // 电话名拼法，与宿主侧同一套（前缀 + 点 + 动作名）
CLIENT_POLL.defaultMs           // 面板轮询默认值（1000）
CLIENT_POLL.minMs               // 轮询下限（250，低于它要报错而不是静默取整）
manualCommand({ ... })          // 手工兜底命令的形状，与宿主侧同一套政策
```

**事件清单检查器**（纯函数，不新增日志事件）：

```js
import { parseEventListManifest, checkEventFields, checkEventCounts } from 'dsh-plugin-update'

const manifest = parseEventListManifest(myEventList)   // myEventList 是对象，先自己读盘
checkEventFields(manifest, 'host.call', ['method', 'pluginId'])   // 字段白名单
checkEventCounts(manifest)                                        // 计数与清单自报的 counts 对齐
```

事件清单的每条要写四样：事件名、级别（`error`/`warn`/`info`/`debug`）、允许字段（之外的键一律不记）、脱敏引用（`codes` 是截断或散列代号，`rules` 是具名正则名——都只记引用名，不记原文）。
`kind` 分三类只为计数检查服务：`resident` 常驻、`ondemand` 按需、`selfmon` 自监控。空模板见包内的 `event-list.template.json`。
清单要以**对象**传入：字符串或数组会被拦下并给出中文说明，不静默修补。

**宿主侧工具**：

```js
resolveTargetPackage(name, { targetPackageDir })  // 按包名解析你的插件包；找不到返回 null（自己搭读取器或写测试时用）
```

**跨插件队列**（纯函数，面板侧同名函数见 `dist/client.js`，可进浏览器闭包）：

```js
import { visibleQueueFor, queuePositionOf } from 'dsh-plugin-update'

visibleQueueFor(queueState, 'my-plugin', false)  // 默认只看自己的，他人仅露正忙占位；传 true 看全量
queuePositionOf(queueState, 'my-plugin', requestId)  // 0 = 在装，1..n = 顺位，null = 不在队里
```

## 9. 兼容与稳定性

这些形状稳定，可以放心依赖：四个电话名与入参回参（老三电话一字不动，`updateChangelog` 是新增）、快照六字段、任务公开形状、配置只经函数入参注入、安装配方五键、日志事件字段基线（三个事件各带必填 `pluginId`）、历史落盘路径。

向后兼容的扩展：新增可选配置键、新增可选 `readerOverrides`（如 `targetPackageDir`）、新增宿主种类与路由取值。调用方不认新取值时按普通宿主处理即可，不会因此报错。
