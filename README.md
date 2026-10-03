# dsh-plugin-update

给 DSH 插件加「检查更新 / 安装更新」能力的 npm 包。宿主侧一段接线，面板侧挂一个现成组件，装不上时给用户一条可复制的手工命令。

要求 Node 22 或更高，零运行时依赖。当前版本 `0.2.0`。

装上它你会拿到四样东西：

- **三个电话**：查状态（只读本地）、查新版（用户点了才联网一次）、装更新（拿凭证提交）。电话指宿主对外提供的方法。
- **一套落盘**：任务状态、安装锁、回滚凭据，按「插件标识 + 使用范围」隔离，多插件互不干扰。
- **面板要的派生取值**：电话名与轮询间隔，构建期从本包生成，面板里不写死。
- **一个现成整组件**：默认内嵌、可切弹窗，调用者传参指定；轮询、安装门控、中文一句话、待重启横幅、手工命令展示与复制、排队可见开关、跳过与恢复、诊断一键复制全在组件内部消化。

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

这一步得到三个电话名：`notes.updateStatus`、`notes.updateCheck`、`notes.updateInstall`。

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

### 三个电话的入参与回参

面板与宿主两侧共用这一份契约（`…` 是你的前缀）：

| 电话 | 入参 | 成功回包 | 失败回包 |
|---|---|---|---|
| `….updateStatus` | `{}` | `{ ok: true, snapshot, manual, receipt: null }` | `{ ok: false, error, errorKind, diag? }` |
| `….updateCheck` | `{}` | `{ ok: true, snapshot, manual, receipt }` | 同上 |
| `….updateInstall` | `{ checkId, requestId }` | `{ ok: true, snapshot, manual, receipt: null }` | 同上 |

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
```

组件内部消化的事（调用者不再写）：按 `panelPollMs` 轮询查状态（下限 250 毫秒）；安装按钮状态跟随快照的 `canInstall`，不另写门控规则；装不了的原因按第 5.2 节展示中文一句话；`pending-restart` 单独横幅加重启指引，不再给安装按钮；手工命令展示与复制；排队位置展示与 `showOthers` 开关；跳过按版本记（“已跳过 X.Y.Z · 恢复”在同一行，不藏进设置页）；失败时旁边的“复制诊断”一键给出脱敏后的自包含文本（稳定码、版本、宿主、队列位置），深挖仍看日志（组件里留着第 6 节第 11 条的过滤口径）。

待重启横幅上有个「重启宿主」入口。宿主没有“重启自己”的电话，所以默认点击只如实提示「请手动重启宿主」；想把重启流程接进来就传 `onRestartRequested`（面板调它，成败都回执）：

```js
mountUpdatePanel(slot, { pluginId: 'my-notes-plugin', prefix: 'notes', call: host.call,
  onRestartRequested: async () => { /* 拉起你自己的重启流程 */ } })
```

面板画成档案五章：**01 检查与安装、02 更新日志、03 更新队列、04 错误信息、05 手工命令**（五章恒在，缺内容给中性提示，不跳号）。档案头一行是「插件名 + 使用范围 + `profile` 牌」：使用范围由面板自动向宿主索取（电话入参 `includeEnv`，宿主只回**范围名与宿主种类**、不回任何路径），显示的就是更新要落到的那个 profile——`web` 与 `desktop` 各装一份，装错范围是严重故障，所以这一栏宁可显示“未知”也不猜。调用方知道得更准时可以用 `profileName` 显式覆盖。

可选专业主题（D5 档案卷，不替换默认）：挂载时加 `theme: 'd5-paper'` 即换肤（右上大印章「待查/可装/安装中/待重启/受阻/已最新」+ 横幅小印章一字 + profile 牌 + 待重启衬线横幅配手绘 SVG 标 + 窄屏印章固定 + 省略号逐字折叠 + 浅深双主题跟随系统），内核 DOM 顺序不动、复制诊断常在；不传即最小可用默认样式。运行时用 `panel.setTheme('d5-paper' | 'default')` 可切。

类型定义随包分发（`dsh-plugin-update/panel` 的 `.d.ts`），不用自编译；面板离线可读，与包版本绑定。

### 升级本包（已经接入过的项目）

宿主种类与安装出口都由本包自己探测和选择，**升级依赖即可，宿主侧与面板侧都不用改代码**：

1. 依赖版本提到 `^0.2.0`。
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

- 有新版时面板在横幅下方展示“更新说明（当前版 → 新版）：”，按目标包内 `CHANGELOG.md`（Keep-a-Changelog 子集）渲染：`Added/Fixed/Changed` 展开，`Deprecated/Removed/Security` 折叠，`Unreleased` 与空节不展示。
- 作者未提供说明时显示“作者未提供更新说明，安装不受影响。”——缺日志永不挡安装，不改变 `canInstall` 与 `blockedReason`。
- 说明文本由集成方备好后传入：已装版离线读本机 `node_modules/<目标包>/CHANGELOG.md`，新版按需取新版 tarball 内同名文件（复用官方源与 `integrity` 校验，取不到即回落中性提示；参考包根导出的 `readInstalledChangelogText` / `fetchReleaseChangelogText`），经 `mountUpdatePanel({ changelogMarkdown })` 或 `setChangelogMarkdown` 交给面板。

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

1. 宿主启动不报错，`update.phoneNames` 读到自家前缀的三个电话名，查状态返回六字段快照。
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

这些形状稳定，可以放心依赖：三个电话名与入参回参、快照六字段、任务公开形状、配置只经函数入参注入、安装配方五键、日志事件字段基线（三个事件各带必填 `pluginId`）、历史落盘路径。

向后兼容的扩展：新增可选配置键、新增可选 `readerOverrides`（如 `targetPackageDir`）、新增宿主种类与路由取值。调用方不认新取值时按普通宿主处理即可，不会因此报错。
