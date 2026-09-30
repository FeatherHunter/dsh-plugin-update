# dsh-plugin-update

给 DSH 插件加「检查更新 / 安装更新」能力的 npm 包。宿主侧一段接线，面板侧构建期派生取值，装不上时给用户一条可复制的手工命令。

要求 Node 22 或更高，零运行时依赖。当前版本 `0.2.0`。

装上它你会拿到三样东西：

- **三个电话**：查状态（只读本地）、查新版（用户点了才联网一次）、装更新（拿凭证提交）。电话指宿主对外提供的方法。
- **一套落盘**：任务状态、安装锁、回滚凭据，按「插件标识 + 使用范围」隔离，多插件互不干扰。
- **面板要的派生取值**：电话名与轮询间隔，构建期从本包生成，面板里不写死。

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
| `….updateStatus` | `{}` | `{ ok: true, snapshot, manual, receipt: null }` | `{ ok: false, error, errorKind }` |
| `….updateCheck` | `{}` | `{ ok: true, snapshot, manual, receipt }` | 同上 |
| `….updateInstall` | `{ checkId, requestId }` | `{ ok: true, snapshot, manual, receipt: null }` | 同上 |

- `snapshot` 恒为第 5.1 节那六个字段；`manual` 是第 5.3 节那条手工命令（能给则给，不能给为 `null`）。
- `receipt` 只有查新版给（`{ checkId, checkedAt, expiresAt }`）；装更新时把 `checkId` 原样带回来，`requestId` 由面板自己生成（同一个编号重复提交直接返回旧结果）。
- 失败一律 `ok: false`：`error` 是原因码（第 5.2 节那八种，另加 `check-failed` / `invalid-release` / `check-expired` / `update-busy` / `install-failed`），`errorKind` 认不出时是 `internal`。面板照第 5.2 节给文案。

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

## 6. 排错

按从常见到少见的顺序查，一次只动一处，动完重查一次状态。

1. `pluginId` 报必填或含路径分隔符：换成自己插件的标识，非空且不含 `/` `\`。
2. 电话名串台（两家插件收到对方的电话）：检查两家 `prefix` 是否相同，相同即改成不同的前缀；电话名永远从 `update.phoneNames` 读。
3. 面板轮询报错说小于 250 毫秒：把 `panelPollMs` 调到 250 或更大。
4. 查新版总超时：先调大 `checkTimeoutMs`，再检查源地址是否写错、网络是否通。
5. 点安装报 `check-expired`：凭证过期，重新查一次新版再点安装，不要重试旧编号。
6. 点安装报 `update-busy`：同一使用范围同时只装一个，等当前任务离开 `installing`/`verifying` 再点。
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
4. 第二家同机隔离：两家各传自己的插件标识与电话名前缀，电话名、落盘目录、锁文件逐个不同，各拿各的锁互不阻塞。

## 8. 包还导出什么

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

## 9. 兼容与稳定性

这些形状稳定，可以放心依赖：三个电话名与入参回参、快照六字段、任务公开形状、配置只经函数入参注入、安装配方五键、日志事件字段基线（三个事件各带必填 `pluginId`）、历史落盘路径。

向后兼容的扩展：新增可选配置键、新增可选 `readerOverrides`（如 `targetPackageDir`）、新增宿主种类与路由取值。调用方不认新取值时按普通宿主处理即可，不会因此报错。
