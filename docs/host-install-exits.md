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
- 超时政策（`0.18.14` 起，票 #193）：`done` 只报退出事实、契约里没有取消/查询，所以本包自己设
  deadline（`installTimeoutMs`）；`done` 不带 `terminate` 时到点没有任何终止手段，人话格要如实写
  「宿主未提供终止能力，这次安装可能仍在后台继续」，不许谎称已请求终止；带了 `terminate` 则到点调一次，
  再给 3 秒终止宽限等它自己收尾——宽限内以 `exitCode 0` 收尾按成功算（不把已经落地的改动记成失败），
  否则按超时失败。`done` 直接 reject（服务崩了）立即失败并写「宿主安装服务异常退出」，不伪装成超时。

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
    其余失败一律不碰移除；拿不到包名或宿主没有 `removeBundle` 就照旧诚实失败；四条宿主调用
    （首装、启用、移除、重装）共用配方里那**一个**超时额度（每步只领剩下的），总上界不因多一步放宽。
    唯一例外是移除失败/超时后的在册补偿（#236，见下）：它只在失败路径上多一发 `setBundleEnabled`
    与至多三次带时限的 `listBundles`，恢复调用额度取 max(剩余配方额度, 终止宽限) 再给一次终止宽限，
    成功路径的调用次数与总上界不变。
  - **移除前先探拓扑（2026-10-18，#201）**：宿主 `removeBundle` 的拒绝次序是「先 `removable`、再
    `enabled ? deselect+reload : 什么都不做`、最后查活 fiber 是否还在用」。真机十一件里有六件
    （`dsh-chef` / `dsh-home-ilife` / `dsh-memo-ilife` / `dsh-schedule-ilife` / `dsh-calorie` /
    `dsh-im-companion`）装着、在跑、但不在 profile 的 `dsh.profile.bundles` 选中名单里 ⇒ `enabled=false`
    ⇒ 宿主不做卸载这一步 ⇒ 活 fiber 还在 ⇒ 2–3ms 撞 `bundle-in-use`。所以本包在两步配方前用
    `listBundles()` 探一次：`removable === false` 直接诚实失败（合成 `not-removable`，不白跑 remove）；
    `enabled === false` 就先 `setBundleEnabled(name, true)`（宿主官方通道，`selectBundle` + `publishAndReload`，
    会把该 bundle 追加到选中名单末尾）再 remove→install；宿主没有 `listBundles`/`setBundleEnabled`（旧版或降级
    宿主）就按老两步走，或诚实失败并给载体 CLI 命令。**不静默改写用户拓扑之外的东西**：这里恢复选中是
    宿主自己 `installBundle({enabled:true})` 的正常语义（每次安装都做），只是被拆分到移除之前。
  - **失败人话格加「换通道」命令（2026-10-18，#201）**：`already-installed` / `bundle-in-use` /
    `not-removable` 这三个码意味着「管理器这条路走不通」，细节尾部补
    ` (dsh plugin --profile <范围> add --save-exact <包名>@<版本> --registry=<源>)`——载体 CLI 在机器上可执行
    （见本节末），是用户侧唯一能原地换版的通道。命令是 ASCII，不加中文说明，避免与 300 字符人话上限抢位置。
    范围名与源取本次配方的真实值（`installRecipe` 的 `profileName` / 注入的 `registryUrl`，与安装同源），
    不是写死的 `desktop`，源未知时不附 `--registry=`。
  - **命令必须可执行，否则宁可不给（2026-10-18，#201 审查 HARD）**：手工命令与载体命令都是给人复制到
    终端执行的，而各平台 shell 的引号规则不同（`cmd` 不认单引号、PowerShell 反引号是转义符），
    `JSON.stringify` 不是 shell 引号——`$`、反引号仍会被展开/执行，含空格或 `&` 的源会被拆开截断。
    因此所有插值统一过保守白名单：使用范围名 / 源 / 规格里出现空白、`$`、反引号、引号、`&`、`;` 等
    无法确定安全的字符时就**整条命令省略**（只留原因与下一步文字），绝不编一条会执行别的东西或悄悄换源的假命令。
    `manualCommand` 同一政策，这类情形返回 `null`（不再用 JSON 引号拼形状）。
  - **启用步也补命令、无能力不冒充原因（2026-10-18，#201 Spec 轴跟进）**：恢复选中这一步不在上面三个
    宿主拒绝码里，但失败/超时/`permission` 同样是「管理器通道走不通」⇒ 一律追加同一条载体 CLI 命令。
    宿主没有 `setBundleEnabled` 时人话格写「宿主不支持恢复选中，无法安全更新已装包，请用载体 CLI 原地更新」，
    **不合成** `bundle-in-use`（真实原因是能力缺失，与活 fiber 无关）。命令本身超 300 字符预算时宁可只留
    截断原文，不越界输出。
  - **移除失败后的在册补偿（2026-10-20，#236）**：宿主 `removeBundle` 对在册的 bundle 是「先
    `selectBundle(name,false)`（立即写盘）再 reload 卸载」；卸载不掉抛 `bundle-in-use` 时，那次
    取消在册没有回滚（`change()` 只把结果标 `failed`），于是本包拿到失败时插件已经装着、却不在
    `dsh.profile.bundles` 里（插件页显示关闭、重启不加载；词义见 `CONTEXT.md` 的「在册」）。
    现在移除前留「是否在册」快照；移除失败/超时（含 `removeBundle` 同步抛错）后带时限复探一次，
    **确认已被移出**才用 `setBundleEnabled(name, true)` 尽力恢复，恢复后再带时限复探一次，只有明确
    回到在册才说「已恢复在册」；恢复被拒说「恢复在册未成功」；前置结论不明、恢复调用超时或宿主没有
    `setBundleEnabled` 时说「无法确认」——绝不把「可能」写成事实，也不宣称一次没发起的尝试。装前本来
    未在册（#201 先恢复在册再移除）的失败不恢复，回到用户原本状态。原失败码、`reason`/`hostCode`
    与详情语义不变，尾部追加 ≤300 字事实（原文超预算时按上限截断原文、优先保住这条事实）；更新
    本身仍是失败，不自动重试 remove→install。
    两次复探各有时限（≤5s），宿主被拖住也不能让失败详情上不了报。
  - **本包超时人话格（2026-10-18，#184）**：按能力分支，不许笼统。管理器没有 `cancelInstall` 时本包
    一次取消都没发过 ⇒ 不许写「已请求宿主取消」，写「宿主未提供取消能力，这次安装可能仍在后台继续」
    （这类宿主里超时的安装可能仍在后台跑完：被告知失败、实际装上）。移除步超时写「移除已装包超时，
    未继续安装；目标包可能已不在册，请重启宿主检查并按手工命令重装」——移除请求可能已经生效
    （包被摘掉却没重装）；且移除步刻意**不**请求取消。
  - **两步配方第二步失败的人话格（2026-10-18，#168）**：移除已成功、重装失败（含重装超时）时，人话格在
    第二次宿主原话之后补一句事实与下一步：「目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制
    手工命令重新安装 (`dsh plugin --profile desktop add --save-exact <包名>@<版本>`)」。这一步不能只说
    「装失败」：用户面对的是「什么都没装」而不是「装着旧版、可以重试」，处置完全不同；命令直接拼进
    人话格里，因为此刻目标包已不在 dependencies，面板的读取器会判成源码安装而给不出手工命令。
  - **需要批准的构建脚本（2026-10-18，#194）**：宿主 `installBundle` 在 pnpm 失败且输出里有被忽略的构建
    脚本时，会先 `recordPendingBuilds(profile.dir, run.output)` 把「等待构建决策」的**精确包名**写进
    `result.pendingBuilds`，再 throw；`change()` 把部分结果折进 `{application:'failed', error}` 的 resolve
    回包，所以这格能到本包手里（`…/lib/index.js:1121-1129`、`:2053-2061`、`:2373-2401`）。本包：
    ① 失败人话格在宿主原话之后点名「需要批准构建脚本：<包名…>；请先批准构建脚本（运行
    `dsh plugin --profile <范围> approve-builds`），再重试本次安装」，名单守 300 字上限（过长时逐级少点名、
    退成「首个 等 N 个」，但**批准命令始终保留**——`0.18.24` 起修正：宿主页的批准入口只在它自己的安装
    失败页出现，本包的 `updateInstall` 走不到，长名单不能退成一句走不通的「去宿主页批准」）；
    ② 名单按「npm 包名文法 + shell 安全」双重归一（非字符串、通配、`-` 开头、路径片段、`包@版本`、
    含 shell 元字符一律丢弃，去重保序、上限 32）；
    ③ 批准重试走 `updateInstall` 的可选入参 `approvedBuilds`（电话入口归一后原样进 `installBundle` 选项，
    宿主 `:1992-1995` 先 `approveBuilds()` 再跑 pnpm）；重试必须换**新的 `requestId`**（同一 requestId
    会被本包去重直接返回旧失败快照）；`approveBuilds` 对不在 pending 名单里的名字抛 `stale-approval`
    （`:1145-1151`）——那说明批准窗口已过，应**重新发起一次检查+安装且不带旧名单**，而不是拿旧名单再重试。
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
  实测：`dsh --version` = `0.2.1-rc.2`（2026-11-02 #267 采集机已是 `0.2.1-rc.5`：卸载表 `DisplayVersion` 与
  `dsh desktop-host` 载体版本随发行更新而漂移，只影响版本号、不影响本节契约；真机记录见文末「真机验证记录」）；
  `dsh plugin --profile desktop add --help` → 打印 pnpm 11.28.5 帮助、无拒绝；
  `dsh plugin --profile desktop list --depth 0` → 正确列出 profile 直接依赖。
  ⇒ 本包 `manualCommand`（`src/shared/commands.ts:256-288`）生成的那条
  `dsh plugin --profile desktop add --save-exact <包名>@<版本> --registry=…` 在这台机器上**可执行**；
  且该进程里**没有 HMR**（管理器的 `already-installed` 守卫不成立）⇒ 它是当前唯一能绕过
  「已装直接依赖」这条死路的用户侧通道。注意它是**裸 pnpm**（不经 `publishAndReload`、bundle 选择表与移除确认），
  只适合救急，不是本包路由。
  出处：`asar:dsh/node_modules/@deepseek-ai/dsh/lib/bin.js:35-37`、`:112`、`:119`；
  `asar:dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js:91-104`。

## 出口三：普通 DSH 宿主（自己起命令行）

- 调用形：`[当前运行时, …运行时参数, CLI 的 JS 入口, 'plugin', '--profile', 使用范围名, …参数数组]`
  —— 一律参数数组，不经 shell、不用 `PATH` 上的 `dsh` 命令名、不按系统分支。
- CLI 入口靠**反查**而不是猜：从 `process.argv[1]` 逐级向上找 CLI 包，入口必须正好是包里声明的
  入口——npm 布局认名为 `@deepseek-ai/dsh` 的包声明的 `bin.dsh`/`bin`；官方桌面运行时认
  `@deepseek-ai/dsh-desktop-host` 包里固定的 `lib/cli.js`（#237：`dsh web` 的 CLI 入口就是这份，
  该包没有 `bin` 字段，只认 npm 布局会 2ms 内 `spawn-failed`）。对不上返回 null，诚实失败。
- 这个出口对使用范围名为 `desktop` 的情形，**只对没有 CLI 载体的普通 `dsh` 一定失败**（出处同上）；
  官方桌面版发行包里的载体 CLI 不拒绝 `--profile desktop`（见出口二末条实测）。因此本包仍不把官方桌面版
  路由到这里（in-process 管理器能力最全），但兜底命令在有载体的机器上是可执行的。
- 超时政策（2026-10-18，票 #185）：`done` 只报退出事实、契约里没有取消/查询，所以本包自己设
  deadline（`installTimeoutMs`）；到点若 `handle` 提供 `terminate` 就真调一次（详情写「安装超时，
  已终止子进程」），没提供就如实写「宿主未提供终止能力，这次安装可能仍在后台继续」，不许谎称
  已终止；终止调用抛错同样不许说已终止，写「终止进程失败，这次安装可能仍在后台继续」。终止后
  再给 3 秒宽限：宽限内以 `exitCode 0` 收尾按成功算，否则一律按超时失败，并在抓取读数之后补
  超时口径（原文在前、口径在后）；出口一与出口三同一矩阵（有终止能力就点名「已请求宿主终止」，没有
  就如实说；宽限内自己收尾的写「任务随后退出，安装未完成」，不拿「可能仍在后台继续」凑口径）。
  `done` 直接 reject 是崩溃、不是超时，立即失败并写「宿主子进程能力异常，安装未完成」。

## 不确定与待现场确认

- 上面所有 `asar:` 行号是档案内文件的行号，磁盘上没有可比对的同名文件。
- 官方桌面版这条路由**已在真机走过「装上」**（2026-11-02，#267 T3，d1 run `267-20261102T094226`）：
  官方桌面（采集机 0.2.1-rc.5）把已装夹具 `dsh-plugin-update-fixture-a@0.0.1` 更新到 `0.0.2`，
  `update.install.exec` 记录 `route=desktop-manager ok=true exitCode=0 durationMs=2587`；重启后 client/host
  构建标记与磁盘版本都是 0.0.2，诊断摘要不再是 `already-installed`（17 条断言全 pass）。
- **2026-10-17 补的「先移除再装」两步也已在真机点过**：同一 run 的 `.plugin-manager/logs` 在
  `update.install.request → update.install.exec` 窗口内**恰好 2 个非空 operation**——先 `pnpm remove`
  （日志含 `- dsh-plugin-update-fixture-a 0.0.1`）、后 `pnpm add`（含 `+ dsh-plugin-update-fixture-a 0.0.2`
  与 `Done in`），原文在 `selftest/evidence/runs/267-20261102T094226/raw/24-*`、`25-*`；
  `already-installed` 守卫把首次 `installBundle` 毫秒挡下后没有起第三次 pnpm（`27-assert`）。
  失败格同样真机走过：d2 run `267-20261102T110749` 在 check 后只删 registry tarball（元数据不动）→
  移除步成功、重装 pnpm 404 → `update.install.fail` = `stage:exec / reason:nonzero-exit / code:install-failed`；
  目标包已被宿主移除时面板随包消失（页面回桌面 home，不伪造 UI），台账 job.message 带「目标包已被宿主移除」
  与载体命令，恢复 tarball 后这条手工命令真机执行 exit 0 装回 0.0.2（见文末「真机验证记录」）。
- **2026-10-17 实测的残留风险（2026-10-18 已修，票 #168）**：移除成功、第二次装又失败时，抛出的详情曾在
  第二次宿主原话之外**没有**「目标包已经被摘掉」这句话。现在（`0.18.15` 起）详情会在原话之后补
  「目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制手工命令重新安装（附可执行的桌面 CLI
  重装命令）」；重装**超时**同样补这句。恢复办法仍是把目标包重装一次（人话格里已给命令）。
- **推断（只有代码阅读依据，未实测）**：`removeBundle` 先 deselect + reload（`:2144-2146`）、`pnpm remove`
  之后还 `publishAndReload()`（`:2159`），`installBundle` 在 HMR 下同样以 `publishAndReload` 收尾
  （`:2094`）⇒「移除再装」之后 bundle 在选择表里的相对次序可能变化，配置优先级随之变化。
  2026-11-02 d1 run 只记录了更新后的 `dsh.profile.bundles`（`[@deepseek-ai/dsh-base,
  @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]`，raw/34-profile-manifest-after-update），
  **没有与更新前逐位对比**；次序风险仍未实测验证。
- 命令行兜底在官方桌面版下是否可执行：**2026-10-17 已现场实测，结论是可执行**（见出口二末条）；
  「用这条命令真的把某个已装包更新上去」这一步 **2026-11-02 也已真机执行成功**：d2 失败格把面板
  `.dsh-upd-manual code` 给出的 `dsh plugin --profile desktop add --save-exact
  dsh-plugin-update-fixture-a@0.0.2 --registry=…` 原样执行，exit 0、磁盘 0.0.2、重启后 UI v0.0.2
  （d2 `41-assert`）；出口三 e2 对回包 `manual` 做同样执行（`42-assert`，exit 0 / 0.0.2 / 重启 buildTag
  v0.0.2）。注意：CLI 进程没有 HMR，写入后仍要重启宿主才生效。
- **2026-10-17 对抗式审查新增（未修，另见票）**：管理器路失败时详情常常只剩宿主裸码（
  `not-removable` / `bundle-in-use` / `management-required` / `stale-approval` / `incompatible-version` 等），
  宿主自己的 next-step 表（`lib/types/tools.js` 的 `ERROR_STEPS` / `FAILURE_STEPS`）没有转述；
  降级宿主（没有 `removeBundle`）上 `already-installed` 的观感与本轮修复前一致。

## 真机验证记录（#267 T3，2026-11-02）

采集机：Windows / node v24.19.0；官方桌面在 `D:\DeepseekHarness`（2026-11-02 卸载表 `DisplayVersion` 已是
`0.2.1-rc.5`；`dsh --version` 探针先后见 rc.2 / rc.3 / rc.5，随发行漂移，只影响版本号）。SUT = 工作树
`dsh-plugin-update@0.18.39` 的 `npm run build` 产物（dist 聚合指纹 `efddad08…`，`distFiles=208`）。
全部 run 在仓库外隔离 runtime 执行（隔离 `DSH_HOME` + `--user-data-dir` + run 内独立 verdaccio），
维护者真实 `~/.dsh` 前后指纹一致；证据包在 `selftest/evidence/runs/`。

路由判定回顾（`src/host/environment.ts:109-129`）：有 `desktopProfiles` 服务 → `desktop`（出口一）；
否则 `pluginManager.installBundle` 且使用范围名恰为 `desktop`（大小写不敏感）→ `desktop-manager`（出口二）；
其余 → `cli`（出口三）。真机观测与之一致：d1/d2 日志 `hostKind=desktop-manager`；e1/e2/e3
`hostKind=cli` 且 `update.install.exec route=cli-process`；f1 本机唯一桌面宿主 `hostKind=desktop-manager`。

### 出口一：第三方 Desktop（`desktopProfiles`）——本机不可达，登记 known-red

- 能力探测（f1 run `267-20261102T113042`，known-red / 退出码 0）：文件系统（Program Files / AppData /
  盘根，名字含 dsh|deepseek|harness）+ 注册表卸载表同族条目 + 服务同族条目，三份原始输出在 raw/；
  分类按「Electron 发行结构（`resources/app.asar` 或 `resources/app`）+ 同族 exe」结构判据，
  本机第三方 Desktop = **0**（25 个名字同族的 nearMiss 单列：用户数据目录、临时探针目录、单文件
  `dshvm-ui` 等，避免假阳性）。
- 负向证据：本机唯一桌面宿主启动后 `update.wire.ready hostKind=desktop-manager`（`24-assert`）——
  即 `desktopProfiles` 服务为空，路由不可能落出口一。
- 两格 released known-red：`25-assert`（出口一成功格：真机走 `desktopProfiles.runPlugin` 更新并核对
  UI/磁盘/日志）与 `26-assert`（失败格：宿主失败码/人话格/手工命令）均为 known-red，note 与
  `selftest/evidence/known-red.md` 的 `t3-267-exit-one` 写明可复现条件（需第三方 Desktop 宿主 +
  `desktopProfiles` 服务）。不伪造：没有第三方宿主就没有截图/日志，只记探测原文与条件。

### 出口二：官方桌面 in-process 插件管理器（`pluginManager`）

| 结果 | runId | 关键断言 | 真机事实 |
| --- | --- | --- | --- |
| 成功更新（0.0.1→0.0.2） | `runs/267-20261102T094226`（pass / 0） | `26/27/31/32/36/41-assert` | already-installed 守卫挡下首次 installBundle 后走 remove→install 两步：窗口内恰好 2 个非空 operation（先 `- … 0.0.1`、后 `+ … 0.0.2`）；exec `route=desktop-manager ok=true exitCode=0 durationMs=2587`；无 fail；重启后 client/host v0.0.2 |
| 失败（registry tarball 404） | `runs/267-20261102T110749`（pass / 0） | `25/29/30/33/35/37/41/43-assert` | check 后只删 tarball（元数据/integrity 不动）：移除步成功、重装 pnpm 404 → exec `route=desktop-manager ok=false exitCode=1`、fail `stage:exec/reason:nonzero-exit/code:install-failed`；目标包被移除后面板随包消失（页面回桌面 home，不伪造 DOM）；台账 message 带「目标包已被宿主移除」+ 载体命令；恢复 tarball 后手工命令真机 exit 0 装回 0.0.2 |
| can-red（stale-variant） | `runs/267-20261102T113218`（fail / 1，预期） | `16-assert`、`37-assert` 红 | 发 0.0.2 但构建内容仍是 0.0.1：重启后 clientTag/hostTag 仍 v0.0.1，证明「重启后新版 UI」断言非永真；其余 15 条（真 UI 安装、两步 operation、exec、磁盘、台账）仍 pass |

真机不可控、仍未真机覆盖的失败码（按库内测试与 known-red 口径处理，不硬造）：`not-removable`、
`bundle-in-use`、`pendingBuilds` 批准流程、以及「移除步之后第二次安装失败」以外的管理器内部失败。
库内覆盖见 `tests/desktop-manager.test.mjs`、`tests/desktop-manager-hmr.test.mjs`、
`tests/issue-194-pending-builds.test.mjs`、`tests/issue-236-manager-remove-failure-restore.test.mjs`。

### 出口三：普通 DSH 宿主 spawn CLI 子进程

| 结果 | runId | 关键断言 | 真机事实 |
| --- | --- | --- | --- |
| 成功更新 | `runs/267-20261102T111047`（pass / 0） | `29/32/33/34/39-assert` | 宿主 `--profile t3cli --port 0 --no-open`（普通 DSH web，非 desktop）：exec `route=cli-process ok=true exitCode=0 durationMs=979`；磁盘 0.0.2；电话回包 42ms ≪ exec 979ms；重启后 buildTag=host v0.0.2 |
| 失败（tarball 404） | `runs/267-20261102T111127`（pass / 0） | `33/34/35/36/37/42/44-assert` | check 后删 tarball：CLI 子进程 pnpm 404 非零退出 → job.message 以 install-failed 开头且含 `ERR_PNPM_FETCH_404 … 404` 原话、**不含载体命令**；exec ok=false exitCode=1；fail `stage:exec/reason:nonzero-exit`；磁盘仍 0.0.1；回包 manual 真机执行 exit 0 装到 0.0.2；重启 buildTag=host v0.0.2 |
| 超时 | `runs/267-20261102T112503`（pass / 0） | `33/34/35/36/39/42-assert` | 宿主 registry 指向延迟代理挂住 pnpm + 夹具 `installTimeoutMs=4000`：到点终止 CLI 子进程，job.message=「安装超时，已终止子进程」，exec durationMs=4111（预算 + 3s 宽限内），fail `reason=timeout`；磁盘仍 0.0.1；重启仍 host v0.0.1；宿主/代理全停 |
| can-red（stale-variant） | `runs/267-20261102T113629`（fail / 1，预期） | `40-assert` 红 | 发 0.0.2 但内容仍是 0.0.1：重启后 buildTag=host v0.0.1，而 runningVersion 已是 0.0.2，证明「运行代码真的换了版」断言非永真；其余 21 条仍 pass |

出口三的隔离口径（真机关键事实，写测试的人必须知道）：产品 spawn 的 CLI 子进程走
`@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv()`，会剥掉全部 `DSH_*`（大小写不敏感）与匹配
`/KEY|PASSWORD|SECRET|TOKEN/i` 的环境名；子进程按 `homedir()/.dsh` 解析 home。⇒ 隔离宿主时
`DSH_HOME` 必须与 `USERPROFILE` 对齐（宿主 `homeDir = <run>/os-home/.dsh`，`USERPROFILE=<run>/os-home`），
否则 CLI 子进程会装到默认 home、产品 verify 报 version-mismatch。这是测试隔离口径，不是产品缺陷：
普通用户没有覆盖 home 时两者天然一致。

通道 B 是无窗口 CLI 宿主：e1/e2/e3 的 UI 证据是 DOM/pageText 原文（电话回包、页面状态、产品日志），
没有 PNG 截图；窗口截图证据由出口二的 d1/d2 与 T10 UI 组承担（三个 run 的 `index.md` 备注同样写明）。
