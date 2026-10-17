# 三条安装出口的宿主契约（只读抄件）

本包把「装更新」交给宿主自己拥有的出口，一共三条路由。这份文件是它们各自契约的**只读抄件**：
本包不 import 宿主任何东西，只按这里写的形状调用；形状对不上就诚实失败转手工命令，绝不猜。

> 取证方式：2026-09-30 对本机官方桌面版做了一次**只读**解析（`D:\DeepseekHarness\resources\app.asar`
> 是单个档案文件，不是解包目录；下面 `asar:` 开头的路径与其行号都是**档案内**文件的行号）。
> 当时宿主内部版本为 DSH `0.2.0-rc.2`，宿主包 `@deepseek-ai/dsh-desktop-host`。
> 官方桌面版**没有** `.d.ts`（整个 `dsh/` 树里 0 个），最精确的契约是生成物里的内嵌声明。
>
> **2026-10-17 又做了一次同路径只读解析**（档案未变，内部版本升到 `@deepseek-ai/dsh-desktop 0.2.1-rc.2` /
> `@deepseek-ai/dsh-plugin-manager 0.2.1-rc.2`，档案 mtime `2026-10-17 17:20:50`）：新增下面出口二的
> 「HMR 与 already-installed」一条 —— 起因是真机一次 `install-failed（already-installed）`（票 #167）。

## 出口一：第三方 Desktop（`desktopProfiles` ＋ `desktopPnpm`）

- 信号：宿主在 Loader entry 挂载前注册 `desktopProfiles` 服务；取用 `desktopPnpm` 要经嵌套
  `ctx.inject(['desktopPnpm'], …)`。
- 调用形：`desktopPnpm.runPlugin(参数数组, 使用范围目录, undefined)` → `{ done: Promise<{ exitCode }> }`。
- 已公开文档（本包依的契约）：
  <https://github.com/anywhere-labs/deepseek-harness-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/docs/plugin-services.md>
- 本包政策：桌面服务固定装进「当前激活的使用范围」，激活范围与本插件所在范围对不上时宁可不装
  （诚实失败转手工命令）。

## 出口二：官方桌面版（宿主进程内的插件管理器）

- 服务名 `pluginManager`，是 **root 级 cordis 服务**：普通插件上下文直接 `ctx.get('pluginManager')`
  即可取到（服务 fiber 处于 ACTIVE 时），不需要 `inject`。
  出处：`asar:dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:1379-1380`（构造即注册）；
  官方同进程消费者 `…/lib/types/tools.js:38` 就是 `const manager = ctx.pluginManager`。
- 挂载条件：profile 组合里那一行 `disabled: !!js "!ctx.get('profileContext')"`
  （`asar:dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:22`）。
  **注意**：这意味着普通宿主也可能挂载这个服务，所以本包不拿「有服务」单独当宿主判据。
- 签名：`installBundle(spec: string, options?: { enabled?, requestId?, approvedBuilds?, registry?, saveExact? })`
  → `Promise<ChangeResult>`；另有 `removeBundle(spec)` 与 `cancelInstall(requestId)`。
  出处：`asar:…/dsh-plugin-manager/lib/typert.host.js:795-799`（signature）、`:848`（InstallBundleOptions）、
  `:810`（cancelInstall）、`:836`（ChangeResult）、`:860`（ManagementError）、`:864`（PackageResult）。
  注意 `saveExact` 是选项之一，但**本包不传**：管理器默认就写精确版本（2026-10-17 真机实证：面板更新
  之后 profile `package.json` 里的 specifier 是 `0.3.67`，不是 `^0.3.67`）——「不传 saveExact 会写成范围」
  是误报，已证伪。
- 返回形状（只抄本包用到的格）：
  - `application`：`applied`｜`restart-required`｜`overridden`｜`failed`｜`cancelled`；
  - `error`：普通对象 `{ code, diagnostic?, incompatible? }`，不是 Error；
  - `packageResult`：`{ exitCode, output, truncated, logPath, kind?, timedOut? }`；
  - 其余：`changed`、`stage`、`target`、`bundle`、`pendingBuilds`、`registries`、`failedAt` 等。
- **预期失败不 reject**：`application:'failed'` 是 resolve 出来的（`…/lib/types/index.js:814-835` 折叠
  `catch`）。只看有没有抛异常会把失败当成功——本包只按 `application` 判成败。
- `overridden` 是「改动已被保留、只是被别的层盖住」，当失败会让上层回滚一次已经落地的改动，
  所以本包把它算成功。
- spec 形状：**一个字符串**，形如 `包名@x.y.z`；包名必须匹配
  `PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/`（全小写，可带作用域），
  以 `-` 开头的整串直接 `invalid-spec`（`…/lib/types/install-spec.js:18-19`、`:57-86`；
  `…/lib/index.js:1708`）。规格整串作为**单个** `pnpm add` 参数传入（`:1749-1753`），
  **不接受任何开关**——`--save-exact`、`--registry=` 这类开关在这条路上没有位置。
- **HMR 宿主上「已经装着的包」不许再 `add`**（2026-10-17 取证，票 #167）：`installBundle` 在起 pnpm
  **之前**有一道同步守卫 —— `asar:…/dsh-plugin-manager/lib/index.js:1991`
  `if (this.ownerContext.get("hmr") !== void 0 && known !== void 0 && Object.hasOwn(before, known)) throw new ManagementFailure("already-installed");`。
  命中即折成 `application:'failed'` + `error = { code: 'already-installed' }`（**没有 `diagnostic`**，`:1301-1310`），
  `pnpm add` 一次都没起（`:2033-2038` 走不到 —— 真机上就是毫秒级返回、宿主 operation 日志不新增）。
  `known` 是 `specPackageName(spec, dependencies, profileDir)`（`:1373-1375`）对 registry spec 取的**包名**，
  再在 profile manifest 的 `dependencies` 里查（`:1989-1990`）⇒ **与版本无关**：改发已装版本号一样被拒。
  - **更新一个已装的包，这条路由上只能走宿主自己的 two-step**：先移除再装。宿主自己的 next-step 表
    就是这么写的（`asar:…/dsh-plugin-manager/lib/types/tools.js` 的 `ERROR_STEPS['already-installed']`：
    `call remove_bundle first, then install_bundle again`）。
  - `removeBundle(name)` 收的是**名字**不是 spec：`@param name Installed dependency or selected bundle name.`
    （`asar:…/dsh-plugin-manager/lib/index.js:2137-2152`；内部 `listBundles().find((item) => item.name === name)`，
    找不到或 `removable === false` 抛 `ManagementFailure("not-removable")`）。它也走 `change()`，
    所以回包同样是 `ChangeResult`（`application` 三态判成败）。HMR 开着时它反而**不受**
    `startedBundles` 那圈限制（`:2142` 的守卫以 `hmr === void 0` 为前提）。
  - 本包政策（2026-10-17 起）：只在 `already-installed` 这个码上做「先移除、再用**新** `requestId` 装一次」，
    其余失败一律不碰移除；拿不到包名或宿主没有 `removeBundle` 就照旧诚实失败；三步共用配方里那**一个**
    超时额度（每步只领剩下的），总上界不因多一步放宽。
  - **本包超时人话格（2026-10-18，#184）**：按能力分支，不许笼统。管理器没有 `cancelInstall` 时本包
    一次取消都没发过 ⇒ 不许写「已请求宿主取消」，写「宿主未提供取消能力，这次安装可能仍在后台继续」
    （这类宿主里超时的安装可能仍在后台跑完：被告知失败、实际装上）。移除步超时写「移除已装包超时，
    未继续安装；目标包可能已不在册，请重启宿主检查并按手工命令重装」——移除请求可能已经生效
    （包被摘掉却没重装）；且移除步刻意**不**请求取消。
- 源：`registry` 是**选项**不是开关（`…/lib/index.js:1738` 的 `registryPlan`）。本包把注入的
  `registryUrl` 作为该选项传入；没注入就不传，由管理器用自己的源策略（宿主路径总会注入，默认即官方源）。
- 超时与取消：管理器自己有静默超时（默认 600000ms，到点杀整棵进程树）与 profile 写锁等待
  （默认 120000ms，**这条会 reject**），没有整体墙钟。`cancelInstall(requestId)`
  → `{ status: 'cancelled' | 'too-late' | 'not-running' }`：`cancelled` 会等进程退出并把
  `package.json` / `pnpm-lock.yaml` 还原，原 promise resolve 成 `application:'cancelled'`；
  `too-late` 表示已进入应用阶段、改不动了。出处：`…/lib/index.js:1827-1839`、`:1356-1359`。
- 命令行在那台机器上**可用**（2026-10-17 21:0x 真机只读实测，订正本节旧假设）：官方桌面版发行包把 CLI 载体放在
  `D:\DeepseekHarness\resources\runtime\cli\bin\dsh.cmd`，它用 `ELECTRON_RUN_AS_NODE=1` 调
  `…\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`（`runDesktopCli`，
  内部 `runCli({ manageDesktopProfile: true, … })`），所以 `plugin` 子命令的 `rejectElectronProfile` 守卫**不触发**。
  实测：`dsh --version` = `0.2.1-rc.2`；`dsh plugin --profile desktop add --help` → 打印 pnpm 11.28.5 帮助、无拒绝；
  `dsh plugin --profile desktop list --depth 0` → 正确列出 profile 直接依赖。
  ⇒ 本包 `manualCommand`（`src/commands.ts:189-213`）生成的那条
  `dsh plugin --profile desktop add --save-exact <包名>@<版本> --registry=…` 在这台机器上**可执行**；
  且该进程里**没有 HMR**（管理器的 `already-installed` 守卫不成立）⇒ 它是当前唯一能绕过
  「已装直接依赖」这条死路的用户侧通道。注意它是**裸 pnpm**（不经 `publishAndReload`、bundle 选择表与移除确认），
  只适合救急，不是本包路由。
  出处：`asar:dsh/node_modules/@deepseek-ai/dsh/lib/bin.js:35-37`、`:112`、`:119`；
  `asar:dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js:91-104`。

## 出口三：普通 DSH 宿主（自己起命令行）

- 调用形：`[当前运行时, …运行时参数, CLI 的 JS 入口, 'plugin', '--profile', 使用范围名, …参数数组]`
  —— 一律参数数组，不经 shell、不用 `PATH` 上的 `dsh` 命令名、不按系统分支。
- CLI 入口靠**反查**而不是猜：从 `process.argv[1]` 逐级向上找名为 `@deepseek-ai/dsh` 的包，
  且该文件必须正好是包声明的可执行入口；对不上返回 null，诚实失败。
- 这个出口对使用范围名为 `desktop` 的情形，**只对没有 CLI 载体的普通 `dsh` 一定失败**（出处同上）；
  官方桌面版发行包里的载体 CLI 不拒绝 `--profile desktop`（见出口二末条实测）。因此本包仍不把官方桌面版
  路由到这里（in-process 管理器能力最全），但兜底命令在有载体的机器上是可执行的。

## 不确定与待现场确认

- 上面所有 `asar:` 行号是档案内文件的行号，磁盘上没有可比对的同名文件。
- 官方桌面版这条路由**尚未在真机点过一次「装上」**（本次修复只到库内测试与本地提交）。
- **2026-10-17 补**：「先移除再装」这两步同样**尚未在真机点过**——真机只观测到拒绝那一步（票 #167）。
  含本修复的版本发到真机后，验收点是：同一个 `dsh-opencode-palette` 2.0.28 → 2.1.0 的更新能走完，
  且诊断摘要不再是 `already-installed`。
- **2026-10-17 实测的残留风险（未修）**：移除成功、第二次装又失败时，抛出的详情只有第二次的宿主原话，
  **没有**「目标包现在已经不在 profile 里」这句话——用户可能以为只是版本没换成功，实际插件已被摘掉。
  要补这句话得动失败话术（新增冻结中文 + 契约），本版先如实记在这里（另开票 #168）；恢复办法是用面板把目标包重装一次。
- **推断（只有代码阅读依据，未实测）**：`removeBundle` 先 deselect + reload（`:2144-2146`）、`pnpm remove`
  之后还 `publishAndReload()`（`:2159`），`installBundle` 在 HMR 下同样以 `publishAndReload` 收尾
  （`:2094`）⇒「移除再装」之后 bundle 在选择表里的相对次序可能变化，配置优先级随之变化。
  发到真机后值得核一次 `dsh.profile.bundles` 的次序。
- 命令行兜底在官方桌面版下是否可执行：**2026-10-17 已现场实测，结论是可执行**（见出口二末条）；
  此前「待现场确认」的说法作废。仍未验证的是「用这条命令真的把某个已装包更新上去」这一步（只做了
  `--help`/`list` 只读探针，未写盘）。
- **2026-10-17 对抗式审查新增（未修，另见票）**：管理器路失败时详情常常只剩宿主裸码（
  `not-removable` / `bundle-in-use` / `management-required` / `stale-approval` / `incompatible-version` 等），
  宿主自己的 next-step 表（`lib/types/tools.js` 的 `ERROR_STEPS` / `FAILURE_STEPS`）没有转述；
  降级宿主（没有 `removeBundle`）上 `already-installed` 的观感与本轮修复前一致。
