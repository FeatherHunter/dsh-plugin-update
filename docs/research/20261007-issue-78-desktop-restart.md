# 第三方 Desktop 重启宿主／重启整个 DSH 调研（issue #78）

> 调查时间：2026-10-07 ｜ 调查方式：只读（read / grep / web_fetch，未改仓内任何实现文件；唯一写操作是本调研文件本身）
> 被调查仓：dsh-plugin-update，版本 `0.7.1`（来源：`package.json:3`）
> 被调查第三方宿主版本：deepseek-harness-desktop 固定 commit `4f68147091e585aaa1d815f99d30a657b3842d7c`（来源：票面指定的 plugin-services.md blob URL）
> 存放选址：`docs/research/` —— 跟随本仓现行惯例（`docs/research/20261005-changelog-third-party.md:5` 头部元信息写法：调查时间＋只读方式＋被调查仓版本来自 package.json:3＋存放选址说明；目录已有 `20261004-ilife-多插件更新调查.md`、`20261005-issue-29-http-gap-adversarial-review.md` 等 `YYYYMMDD-<主题>.md`；仓根 `research/` 仅有一篇旧取证不是现行惯例）

## 0. 结论摘要（可被 #80 直接引用）

1. **第三方 Desktop 公开契约里没有重启宿主／重启整个 DSH 的电话。**公开面只有两个服务 `desktopProfiles` 与 `desktopPnpm`（来源：`plugin-services.md` 全文 17225 字节，Public Cordis services 节只列这两个；Internal and launcher-private capabilities 表把 `desktopRuntime` 标为 Desktop-internal、`desktopPnpmBootstrap` 标为 Launcher-private）。能真正触发 Electron relaunch 的是内部链 `desktopProfiles.select → bootstrap.requestRestart → ElectronDesktopRuntime.requestRestart → app.relaunch` 与 `shutdown.ts` 的退出协调器，第三方插件按契约不得 inject `desktopRuntime`（来源见 §2.5、§6）。
2. **`desktopPnpm.runPlugin` 不能复用为重启命令。**其完整签名是 `runPlugin(args: readonly string[], invokingDir: string, signal?: AbortSignal): DesktopPnpmHandle`（来源：`plugin-services.md` 之 desktopPnpm 节；实现 `src/pnpm.ts:runPlugin`），语义固定为跑打包好的 `dsh plugin --profile <active> …`：args 是转交给 `dsh plugin` 的 pnpm 参数（如 `add/remove/update/install`），invokingDir 必须是绝对路径、只做 CLI cwd 以锚定相对 file:/link:，profile 名由 bootstrap 锁定的 active 值写死，调用方传不进去（来源同上；复跑见 §2.2）。本包调用形是 `runPlugin(参数数组, 使用范围目录, undefined)` → `{ done: Promise<{ exitCode }> }`（来源：`docs/host-install-exits.md:15`；`src/store.ts:949-960`），第三个 `undefined` 即不传 AbortSignal。
3. **本包在第三方 Desktop 路由上有激活范围校验，装错范围宁可诚实失败。**`runDesktopService` 要求 `desktopProfiles.current.dir` 与本插件所在 `profileDir` 经 `sameDir` 比对一致，否则抛 `install-failed` 转手工命令（来源：`src/store.ts:944-963`，其中校验在 `:954-956`）；且桌面服务每 generation 至多一个 package 操作，第二个同步抛错（来源：`plugin-services.md` 之 at most one package operation per generation；实现 `src/pnpm.ts:start` 门限）。
4. **本包面板当前的手动路径是只做入口，不假装能重启。**单面板与批量面板同一口径：有 `onRestartRequested` 就调它（成功 toast `restart-delegated`，抛错 toast `restart-failed`），没有就 toast `restart-manual`（请手动重启宿主）（来源：`src/panel.ts:1457-1461,2560-2575`；`src/panel-batch.ts:1864-1875`；文案 `src/bilingual.ts:439-441,472-473,641-643`；用户手册 `README.md:136-141`）。
5. **给 #80 终裁的输入：规格口径守住横幅＋手动，重启能力必须向宿主提新电话提案。**三个宿主各需一案：第三方 Desktop 申请公开重启入口（复用 `select(name)` 的 persist＋teardown＋relaunch 有序语义，或新增只重启不换 profile 的公开方法）；官方桌面版 `pluginManager.installBundle` 同样无重启出口（来源：`docs/host-install-exits.md:31-38` 只列 install/remove/cancel）；普通 DSH 宿主无退出后重拉起约定（来源：`docs/host-install-exits.md:63-68`）。在提案落地前，#80 应裁不承诺自重启（详见 §1 决策依赖表）。

## 1. 研究问题与决策依赖

研究问题（票面转述）：第三方 Desktop（发布 `desktopProfiles`／`desktopPnpm` 的那一支）如何做到重启宿主／重启整个 DSH？查其公开契约与本包 `src/host.ts`／`src/store.ts` 路由：是否有重启电话、没有时 CLI 或手动路径是什么（来源：任务票面）。

决策依赖（本票阻塞 #80 重启方向终裁，下表可直接作为 #80 的输入）：

| #80 要裁的事 | 本票给出的可引用结论 | 出处 |
|---|---|---|
| 规格口径：更新后待重启是否承诺一键自重启 | 不承诺。本包 `pending-restart`／`restart-required` 只做待重启横幅＋`onRestartRequested` 入口，缺入口时诚实提示手动重启 | `src/panel.ts:1457-1461,2560-2575`；`src/bilingual.ts:439-441`；`README.md:136-141` |
| 是否向宿主提新电话提案 | 是。公开契约穷举后确认无重启电话；现有能力（`select` 换 profile 才重启、`runPlugin` 只跑 pnpm 参数、内部 `desktopRuntime.requestRestart` 不公开）都不能直接当重启当前宿主用 | `plugin-services.md` 全文；`src/runtime.ts:175-176`；`src/electron-runtime.ts:211-213` |
| 向第三方 Desktop 提什么 | 申请一个公开的重启当前 generation、不换 profile 的入口；或把 `desktopRuntime.requestRestart` 从 internal 升为公开。若复用 `select`，需明确同名 select 直接 resolve 不重启（实现见 `src/profile-service.ts:select`），即同 profile 下调 `select(当前名)` 触发不了重启 | `plugin-services.md` 之 desktopProfiles 节；对端实现 `dsh-plugin-desktop/src/profile-service.ts:select`；对端内部 `src/runtime.ts:175-176`、`src/electron-runtime.ts:211-213`、`src/main.ts` 装配链 |
| 向官方桌面版提什么 | `pluginManager.installBundle/removeBundle/cancelInstall` 之外的新重启出口；现有返回 `application: applied｜restart-required｜…` 只是状态申报，不是重启动作 | `docs/host-install-exits.md:31-38` |
| 向普通 DSH 宿主提什么 | CLI 自起进程路由（`cli-process`）无重拉起约定，需另定退出后谁拉起、退出码与参数约定；当前只能给手工命令 | `docs/host-install-exits.md:63-68`；`src/store.ts:1169-1176`；`src/commands.ts:127-139` |

## 2. 公开契约取证（plugin-services.md 逐项，固定 commit 4f68147）

> 取证对象：https://github.com/anywhere-labs/deepseek-harness-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/docs/plugin-services.md（来源：票面指定）。复跑：对该 blob 的 raw 地址做 web_fetch（raw：https://raw.githubusercontent.com/anywhere-labs/deepseek-harness-desktop/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/docs/plugin-services.md），本次抓包 status=200、truncated=false、len=17225（来源：本次抓包记录）。注意：api.github.com 对该仓库返回的规范名是 anywhere-labs/dsh-desktop（来源：本次 contents 与 git/trees 抓包回包中 url/html_url/download_url 字段），blob 内容一致，引用时以票面 URL 为准。

### 2.1 有无 restart／relaunch 电话：没有公开的；全文唯一的 restart operation 是换 profile 的 select

- 公开服务节标题即边界：Public Cordis services 下只列 `desktopProfiles` 与 `desktopPnpm` 两个；节首声明 covers the public desktopProfiles and desktopPnpm Cordis services（来源：`plugin-services.md` 首节＋Public Cordis services 节）。
- 全文检索 restart/relaunch/reboot/shutdown（复跑：对上段抓包文本做大小写不敏感检索）：命中全部落在三处——(a) `select(name)` 一句 is a restart operation, not an in-place mutation. It persists an accepted target before requesting orderly Cordis teardown and Electron relaunch.；(b) 世代模型 A profile or mode switch disposes the current generation and starts a new one 与 Treat `desktopProfiles.select()` as a restart boundary；(c) 内部表与注入示例。不存在第四个以 restart 命名的公开方法（来源：`plugin-services.md` 之 Layers 段、desktopProfiles 节、Failure checklist 第 10 条）。
- 穷举过程补充：对同一 commit 的 `dsh-plugin-desktop/src/` 树（复跑：web_fetch GitHub API git/trees/4f68147?recursive=1，回包 total entries=195）过滤出 `src/pnpm.ts, profile-service.ts, profile-manager.ts, runtime.ts, electron-runtime.ts, shutdown.ts, main.ts, index.ts, desktop-cli.ts`（来源：本次树抓包记录），逐个 web_fetch raw 核对：能 relaunch 的符号全部落在非公开侧（见 §2.5），公开的两个服务文件中无其它重启符号（来源：各文件抓包，行号见 §6）。

### 2.2 desktopPnpm.runPlugin 完整签名与语义

契约签名（来源：`plugin-services.md` 之 desktopPnpm 节）：

```ts
interface DesktopPnpm `run(args: readonly string[], signal?: AbortSignal): DesktopPnpmHandle; runPlugin(args: readonly string[], invokingDir: string, signal?: AbortSignal): DesktopPnpmHandle`
interface DesktopPnpmHandle `stdout/stderr/done/cancel`，其中 `done: Promise<{ exitCode: number | null; signal: Signals | null }>`
```

- `runPlugin` 跑的是打包好的 `dsh plugin --profile <active> …`，`args` 是 the pnpm arguments forwarded after dsh plugin --profile <active>（来源：同节）。值域是 pnpm 侧参数，不是 DSH 顶层子命令；文档示例全是 `add/remove/update/install` 四组（如 `['add', 'example-plugin']、['update']、['install', '--no-frozen-lockfile']`），无任何 restart／relaunch／reboot 示例（来源：同节）。
- `invokingDir` 是 absolute caller directory used to anchor relative package specifications；`run` 侧以 active profile 目录为 cwd，`runPlugin` 侧以调用方绝对目录为 CLI cwd 再由上游 DSH 切进 profile 跑 pnpm（来源：同节表格；实现 `dsh-plugin-desktop/src/pnpm.ts:runPlugin` 内 argv 为 appExecutable + dshBootstrapPath + plugin + --profile + activeProfileName + args，cwd 取 invokingDir）。
- 校验：两个方法都校验非空、无 NUL 的 argv；`runPlugin()` 额外要求 `invokingDir` 绝对且无 NUL（来源：同节 Both methods validate … 一句；实现 `src/pnpm.ts:validatedArgs/assertAbsolutePath`）。
- 方法区分：`run()` is not a shorter spelling of runPlugin()，直接跑打包 pnpm 入口（cwd=active profile dir），不承诺首次初始化、调用方相对 file:/link: 锚定与 dsh.profile.bundles 对账；凡改 DSH 插件或修依赖树一律用 `runPlugin()`（来源：同节 run() is not … 段＋ checklist 第 3 条）。
- 并发与生命周期：每 generation 至多一个 package 操作，第二个同步抛错；无内置超时，调用方自备 AbortSignal、读双流、调 `cancel()`、等 `done` 并同时看 `exitCode` 与 `signal`；spawn 层失败 reject done，命令正常失败 resolve 非零码；generation teardown 瞄准整棵进程树，done 要等后代退干净才 settle（来源：同节 The service starts at most one … 段；实现 `src/pnpm.ts:start/settle`）。
- 本包侧的形状收窄：`runPlugin(参数数组, 使用范围目录, undefined)` → `{ done: Promise<{ exitCode }> }`（来源：`docs/host-install-exits.md:15`；`src/store.ts:949-950` 类型断言），第三参固定 `undefined` 即本次不传 signal；只读 `exitCode`，不读 `signal`／双流（来源：`src/store.ts:957-961`），这是本包的收窄使用，不是契约缺字段。

### 2.3 desktopProfiles 的形状（current.dir 等）

契约形状（来源：`plugin-services.md` 之 desktopProfiles 节）：

```ts
interface DesktopProfiles `current: { name: string; dir: string }; list(): summaries[]; select(name: string): Promise<void>`
```

- `current` 一代内不可变：name 是 launcher 选中的 profile 名，dir 是其绝对 manifest 目录；禁止从 argv／baseUrl／settings／Loader 行／DSH_HOME 反推（来源：同节 current is immutable … 一句）。
- `list()` 只重读 manifests，不改 patches／deps／bundle 顺序；条目可能可见但不可选（来源：同节）。
- `select(name)` 是 restart 操作（见 §2.1 引文），有序语义：同 target 并发共享同一操作；一旦某 target 已 persist 为 pending，异 target 在重启前被拒绝；持久化失败释放选择槽，重启失败保留已提交 target 以便不覆写状态直接重试；经已 dispose 的旧引用调用一律失败，下一代重读 current（来源：同节 Concurrent calls… ＋ Calls through a retained reference…；实现 `dsh-plugin-desktop/src/profile-service.ts:select/runExclusive/committedSelectionError/assertActive`）。
- 同名 select 不重启：`if (name === current.name) return Promise.resolve()`（来源：对端实现 `src/profile-service.ts:select`），即重启当前 profile 不能靠 `select(当前名)` 触发——这是向宿主提案时必须写进理由的关键细节。

### 2.4 有无其它可用于重启的服务／CLI

- 公开面：无。稳定性边界节明示 The supported plugin-author surface is the desktopProfiles and desktopPnpm service contract… Launcher bootstrap values, native adapters, generated shims, state-file formats, Loader row ordering, and Electron implementation details may change without becoming third-party APIs.（来源：`plugin-services.md` 之 Stability boundary 节）。
- CLI 面：`runPlugin` 示例与 `desktop-cli.ts` 表明打包 CLI 的权威形态是 `dsh plugin --profile <active>` 加 pnpm 参数；`withDefaultDesktopProfile` 只处理默认 profile 注入与 `plugin` 首词改写，无 restart 子命令（来源：对端实现 `dsh-plugin-desktop/src/desktop-cli.ts:withDefaultDesktopProfile/runDesktopDshCli`）。未找到公开的 dsh 重启／relaunch CLI（来源：本次抓包范围内未找到；见 §5）。
- Current dshmarket boundary 节提到旧版 dshmarket 自拼 `dsh plugin --profile …` 的做法被明确判为前契约、不消费新服务（来源：`plugin-services.md` 同名节），旁证自拼 CLI 不是公开推荐路径。

### 2.5 真正能重启的那条链（内部，不公开）：select → requestRestart → app.relaunch

以下全部标为内部，第三方不得依赖；列出仅为证明能力存在但不在公开面，供 #80 写提案时指名道姓（来源均为固定 commit 一手文件，复跑：web_fetch raw …/dsh-plugin-desktop/src/对应文件）：

- `DesktopProfileServiceBootstrap.requestRestart`（来源：`src/profile-service.ts:DesktopProfileServiceBootstrap`），launcher 在 `main.ts` 装配为 `requestRestart: () => runtime.requestRestart()`（来源：`src/main.ts:hostCtx.plugin(DesktopProfileService …)` 段）。
- `DesktopRuntime.requestRestart(): Promise<void>`，注释 Request orderly Cordis teardown followed by an Electron relaunch.（来源：`src/runtime.ts:175-176`）；`ElectronDesktopRuntime.requestRestart` 转调构造器传入的 restart（来源：`src/electron-runtime.ts:89,211-213`），该 restart 在 `main.ts:start` 中定义为先 `nativeExit.requestRelaunch()` 再 `await shutdown.request(0)`（来源：`src/main.ts:runtime = new ElectronDesktopRuntime(…)` 段）。
- 最终原生动作：`createDesktopExitCoordinator({ prepareToQuit, relaunch: () => app.relaunch(), exit: code => app.exit(code) })`，仅当 relaunchRequested 且 code===0 才调 `app.relaunch()`（来源：`src/shutdown.ts:createDesktopExitCoordinator`；装配 `src/main.ts:nativeExit`）。
- 边界表定性：`desktopRuntime` 一行 Desktop-internal. Third-party plugins must not inject it or rely on its window/tray methods.；`desktopPnpmBootstrap` 一行 Launcher-private. Never read, provide, intercept, or declare it as a dependency.（来源：`plugin-services.md` 之 Internal and launcher-private capabilities 表）。另 `index.ts`（desktop-shell）演示了内部调用 `ctx.desktopRuntime.requestRestart()` 做 mode 切换后重启（来源：`src/index.ts:restart after mode change` 段），但该文件是 Desktop 自有插件，不是第三方契约。

## 3. 本包路由取证（host／store／commands／ports／panel）

### 3.1 出口一即第三方 Desktop：信号、调用形、政策

- 只读抄件（来源：`docs/host-install-exits.md:11-19` 全文）：信号是宿主在 Loader entry 挂载前注册 `desktopProfiles` 服务；取用 `desktopPnpm` 要经嵌套 `ctx.inject(['desktopPnpm'], …)`；调用形 `desktopPnpm.runPlugin(参数数组, 使用范围目录, undefined)` → `{ done: Promise<{ exitCode }> }`；公开文档即票面 URL；政策为桌面服务固定装进当前激活的使用范围，激活范围与本插件所在范围对不上时宁可不装（诚实失败转手工命令）。复跑：`read docs/host-install-exits.md 全文 74 行`。
- 探测顺序（来源：`src/host.ts:215-233 detectEnvironmentKind`）：有 `desktopProfiles` 即 `desktop`（第三方 Desktop）；否则有 `pluginManager.installBundle` 且 profile 名恰为命令行封禁的 `desktop` 即 `desktop-manager`；其余 `cli`。复跑：`read src/host.ts:210-262`。
- 嵌套注入（来源：`src/host.ts:249-262 watchDesktopPnpm`）：不把桌面服务放进顶层依赖声明，普通 DSH 才能照常加载；仅当 `detectEnvironmentKind(ctx) === desktop` 才嵌套 inject 取 `sharedDesktopPnpm`。复跑同上。
- 零件透传（来源：`src/host.ts:348-349,526-527,853-859`）：desktopPnpm 取 overrides 或共享值，desktopProfiles 取 ctx 服务。复跑：`grep desktopPnpm|desktopProfiles in src`（来源：本次 grep 记录，命中 `src/store.ts:905-906,944-951,1173`、`src/ports.ts:15,112,141`、`src/commands.ts:130`、`src/host.ts:217-262,348-349,526-527,853-859` 等）。

### 3.2 执行器：runDesktopService 含激活范围校验（src/store.ts:944-963）

- 函数头注释即契约：桌面宿主：交给桌面端公开的 desktopPnpm 服务，由它用参数数组拉起打包好的 CLI（来源：`src/store.ts:944`）。复跑：`read src/store.ts:944-963`。
- 取服务与取当前范围（来源：`src/store.ts:949-953`）：`service.runPlugin` 须为函数否则抛安装失败；`profiles.current` 取 active，profileDir 取零件。
- 校验门（来源：`src/store.ts:954-956`）：桌面服务固定装进当前激活的使用范围，所以激活范围必须就是本插件所在的那个；对不上宁可不装。条件覆盖 active 缺失、dir 缺失、profileDir 缺失与 sameDir 比对失败，任一即抛。复跑同上。
- 执行与判码（来源：`src/store.ts:957-962`）：`service.runPlugin(recipe.pluginArgs, profileDir, undefined)`；handle 须有可 then 的 done 否则抛；await 取 exitCode，非 0 按带码安装失败抛，返回码。

### 3.3 三路由：INSTALL_RUNNERS 与 installRecipe 政策

- 三路由表（来源：`src/store.ts:1162-1176`）：`desktop-service → runDesktopService`、`desktop-manager → runDesktopManager`、`cli-process → runCliProcess`；注释路由只有三条，都由核心的 installRecipe 决定，本文件不按操作系统分支。复跑：`read src/store.ts:1162-1195`。
- 配方政策（来源：`src/commands.ts:127-180 installRecipe`）：desktop→desktop-service（参数数组拉起打包 CLI，不碰垫片、不经 shell）、desktop-manager→管理器（只收一个 spec 字符串、不接受任何开关、源走 registry 选项）、cli→自起进程（三系统同一形态）；前两条一律带官方源与 --save-exact；官方源不可达时由适配器诚实失败，不换源；未知 kind 或包名不合规格不给配方。复跑：`read src/commands.ts:127-180`。
- 配方形状实例：desktop 与 cli 共用 add + --save-exact + 包@版 + --registry=源 四元参数数组；desktop-manager 用 add + 包@精确版 两元（来源：`src/commands.ts:160-179`）。

### 3.4 类型冻结：ports.ts

- `EnvironmentKind` 三取值，desktop 即发布 desktopProfiles／desktopPnpm 的那一支（来源：`src/ports.ts:13-22`）。复跑：`read src/ports.ts:13-22`。
- `InstallRoute` 三取值（来源：`src/ports.ts:111-116`）；`InstallRecipe` 冻结五键，pluginArgs 含义随路由而定，desktop-service／cli-process 为 pnpm 形状，desktop-manager 为管理器形状（来源：`src/ports.ts:118-136`）。复跑：`read src/ports.ts:111-136`。
- `EnvironmentView` 探测顺序与 host.ts 同文（来源：`src/ports.ts:138-156`）。复跑：`read src/ports.ts:138-156`。

### 3.5 面板：宿主没有重启自己的电话，只做 onRestartRequested 入口

- 按钮装配（来源：`src/panel.ts:1457-1461`）：注释宿主没有重启自己的电话，所以这里只做入口：调用方给了 onRestartRequested 就交给它，没给就如实提示请手动重启——不假装能重启。复跑：`read src/panel.ts:1457-1461`。
- 点击处理（来源：`src/panel.ts:2560-2575 case restart-hint`）：有函数则 await 调用＋toast restart-delegated，无则 toast restart-manual，抛错则 toast restart-failed，随后 render。复跑：`read src/panel.ts:2560-2575`。
- 批量面板逐字同一口径（来源：`src/panel-batch.ts:1864-1875 case restart`）。复跑：`read src/panel-batch.ts:1864-1875`。
- 文案（来源：`src/bilingual.ts:439-441,472-473,641-643`，复跑 `grep restart-delegated|restart-manual|restart-failed|restart-host in src`）：restart-delegated 已按调用方的重启流程处理，重启后新版生效；restart-manual 本宿主未提供重启入口：请手动重启宿主，重启后新版生效；restart-failed 重启入口调用失败：请手动重启宿主；按钮 restart-host 重启宿主，title 宿主没有自重启电话：请手动重启宿主。
- 用户手册（来源：`README.md:136-141`）：待重启横幅上有个重启宿主入口；宿主没有重启自己的电话，所以默认点击只如实提示请手动重启宿主；想把重启流程接进来就传 onRestartRequested（面板调它，成败都回执）。复跑：`read README.md:136-141`。
- 本仓穷举无重启电话旁证：`grep restart|relaunch in src` 命中仅 restart-required 状态、pending-restart 原因、面板 restart-hint／横幅／toast 入口，无任何调用宿主重启电话的调用点（来源：本次 grep 记录）。

## 4. 重启路径判定（有无电话／CLI／手动）

### 4.1 有无重启电话：没有（公开契约内）

- 判定：无。第三方 Desktop 公开给第三方插件的重启电话不存在（来源：`plugin-services.md` 全文穷举，见 §2.1；稳定性边界节亲定公开面仅两服务）。
- 穷举过程（可复跑）：一是 web_fetch raw plugin-services.md 全文（len=17225）检索 restart 仅命中 select 语义与世代说明；二是稳定性边界节核对公开面；三是同 commit 树列文件（195 entries）并抓 §2 列出的一手源码文件，确认可 relaunch 符号全在 internal／launcher-private（来源：§2.5 行号链）。任一步均可独立重跑；任一处发现新增公开重启符号即推翻本结论。
- 易错点澄清：`desktopProfiles.select` 是换 profile 才重启，不是重启当前宿主；同名调用直接成功返回、不触发重启（来源：`src/profile-service.ts:select` 首行同名短路）。把它当通用重启电话是误用（来源：同文件注释 Selection is serialized… restart boundary）。

### 4.2 CLI 路径：能否复用 desktopPnpm.runPlugin 跑重启？不能；能否跑宿主重启命令？未找到

- 能否复用 `runPlugin` 跑 dsh plugin 安装命令：能，这正是本包 desktop-service 路由（来源：`src/store.ts:944-963`；`src/commands.ts:130-131`）。
- 能否用它跑重启命令：不能。限制三条（来源：`plugin-services.md` 之 desktopPnpm 节＋ `src/pnpm.ts:runPlugin/start`）：(a) 参数数组语义：args 转交 `dsh plugin --profile <active>` 之后的 pnpm 参数，文档值域无重启动词；(b) profile 锁定：--profile active 由 bootstrap 写死，调用方无法指定更无法借此触发重启；(c) 激活范围校验：本包侧 sameDir(active.dir, profileDir) 对不上即诚实失败，且每 generation 单操作门限挡住并发再跑一个重启。复跑：重读 §2.2 引文＋ `read src/store.ts:944-963`。
- 是否存在另一条宿主重启 CLI： 在本次抓包范围内未找到。`desktop-cli.ts` 仅做 RunAsNode 清理与默认 profile 注入（来源：`src/desktop-cli.ts:runDesktopDshCli/withDefaultDesktopProfile`）；`plugin-services.md` 无 CLI 重启记载；本包抄件亦只给三条安装出口、无重启 CLI（来源：`docs/host-install-exits.md` 全文 74 行）。需现场确认（见 §5）。

### 4.3 手动路径：本包面板当前行为（唯一可用路径）

- 判定：手动是当前唯一诚实路径，面板已实现三态（来源：`src/panel.ts:2560-2575`；`src/panel-batch.ts:1864-1875`）。
- 有 `onRestartRequested` 时：调调用方流程，toast 已按调用方的重启流程处理，重启后新版生效（来源：`src/bilingual.ts:439,641`）。这是宿主集成人（如 Desktop 壳作者）未来把内部 requestRestart 接进来时的预留钩子，不是本包自带的重启能力（来源：`README.md:138-141` 示例拉起你自己的重启流程）。
- 无时：toast 本宿主未提供重启入口：请手动重启宿主，重启后新版生效（来源：`src/bilingual.ts:440,642`），按钮 title 同口径（来源：`src/bilingual.ts:472-473`）。
- 调用失败时：toast 重启入口调用失败：请手动重启宿主（来源：`src/bilingual.ts:441,643`）。
- 复跑：`read src/panel.ts:1457-1461` 看按钮口径 → 点击重启宿主 → 对照有／无／抛错三态 toast；批量面板 `read src/panel-batch.ts:1864-1875` 同理。

## 5. 不确定与待现场确认

1. **web_search 不可用**：本次试图用 web_search 找该仓库 relaunch／restart 文档与源码时，工具直接报错 DeepSeek search has no API key（来源：本次工具错误记录）。替代做法是直接 web_fetch 固定 commit 文件与 GitHub API 树，未经全文搜索引擎补盲。若 #80 需要补盲，需在有 key 的环境重跑搜索（来源：本节记录）。
2. **固定 commit 之后的契约漂移未知**：全部结论锁定 4f68147；该 commit 之后是否新增公开重启服务未查（来源：票面只要求该 commit，超出即声明未查，不猜）。
3. **`desktopPnpm` 是否存在未文档化的隐藏方法**：按要求写未找到。穷举仅覆盖契约文档＋ §2 列出的一手源码文件；`pnpm.ts` 全长 10175 字节已整段核对 run/runPlugin/start/settle（来源：本次 `pnpm.ts` 抓包），未见隐藏重启方法；但不排除其它未抓文件藏有新符号，需现场以同 commit 树全量 grep 复核（来源：本节声明）。
4. **Electron 行为不展开**：`app.relaunch/app.exit` 的具体语义（如参数继承、仅 code===0 才 relaunch 的门限）只抄 `shutdown.ts` 与 `main.ts` 装配原样，不解释 Electron 官方行为（来源：`src/shutdown.ts:createDesktopExitCoordinator`；票面不编造 Electron 行为要求）。
5. **三条安装出口之外的宿主形态**：本包 `detectEnvironmentKind` 只认三取值，未知 kind 按诚实失败处理（来源：`src/commands.ts:153-155`；`src/host.ts:227-233`）。若现场出现第四种 Desktop 分支，本结论需重审（来源：同上）。

## 6. 来源清单（每个 URL／commit／行号）

第三方宿主（commit 4f68147091e585aaa1d815f99d30a657b3842d7c，票面 URL 为准；API 规范名 anywhere-labs/dsh-desktop 为同一仓库，见 §2 头注）：

- 公开契约全文：https://github.com/anywhere-labs/deepseek-harness-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/docs/plugin-services.md（raw：https://raw.githubusercontent.com/anywhere-labs/deepseek-harness-desktop/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/docs/plugin-services.md；blob sha d82333e93e48d081341982e0af52b95c18ccbf58，来源：本次 contents API 抓包；len=17225）。
- `dsh-plugin-desktop/src/pnpm.ts`（DesktopPnpm 定义、run／runPlugin／start／settle；len=10175）：https://github.com/anywhere-labs/dsh-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/src/pnpm.ts
- `dsh-plugin-desktop/src/profile-service.ts`（DesktopProfiles／select 有序语义、同名短路；len=5853）：https://github.com/anywhere-labs/dsh-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/src/profile-service.ts
- `dsh-plugin-desktop/src/runtime.ts`（DesktopRuntime.requestRestart :175-176 为内部；len=7710）：https://github.com/anywhere-labs/dsh-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/src/runtime.ts
- `dsh-plugin-desktop/src/electron-runtime.ts`（ElectronDesktopRuntime :89 构造注入 restart、:211-213 requestRestart；len=19151）：https://github.com/anywhere-labs/dsh-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/src/electron-runtime.ts
- `dsh-plugin-desktop/src/shutdown.ts`（createDesktopExitCoordinator 仅 code===0 才 relaunch；len=4723）：https://github.com/anywhere-labs/dsh-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/src/shutdown.ts
- `dsh-plugin-desktop/src/main.ts`（Loader entry 前注册 desktopProfiles、装配 requestRestart、nativeExit 装配 app.relaunch；len=8430）：https://github.com/anywhere-labs/dsh-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/src/main.ts
- `dsh-plugin-desktop/src/index.ts`（desktop-shell 内部调用 requestRestart 做 mode 切换重启；len=5909）：https://github.com/anywhere-labs/dsh-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/src/index.ts
- `dsh-plugin-desktop/src/desktop-cli.ts`（withDefaultDesktopProfile／runDesktopDshCli，无重启子命令；len=3470）：https://github.com/anywhere-labs/dsh-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/src/desktop-cli.ts
- `dsh-plugin-desktop/src/profile-manager.ts`（selectDesktopProfile／assertDesktopProfileName；len=16158）：https://github.com/anywhere-labs/dsh-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/src/profile-manager.ts

本仓（dsh-plugin-update 0.7.1，来源 package.json:3）：

- `docs/host-install-exits.md:11-19`（出口一信号／调用形／政策）、`:31-59`（出口二签名与命令行封禁）、`:63-68`（出口三反查与 desktop 必败）
- `src/host.ts:215-233`（detectEnvironmentKind）、`:249-262`（watchDesktopPnpm 嵌套注入）、`:348-349,526-527,853-859`（零件透传）
- `src/store.ts:944-963`（runDesktopService 含 :954-956 激活范围校验）、`:1162-1176`（INSTALL_RUNNERS 三路由注释）、`:905-906,949-951`（零件与断言形状）
- `src/commands.ts:127-180`（installRecipe 三路由政策与配方实例）
- `src/ports.ts:13-22`（EnvironmentKind）、`:111-136`（InstallRoute／InstallRecipe 冻结五键）、`:138-156`（EnvironmentView）
- `src/panel.ts:1457-1461`（按钮口径）、`:2560-2575`（restart-hint 三态）、`:216,1882`（onRestartRequested 类型与取值）
- `src/panel-batch.ts:1864-1875`（批量三态）、`:113,1370`（类型与取值）
- `src/bilingual.ts:439-441,472-473,641-643`（三 toast＋按钮文案）
- `README.md:136-141`（用户手册重启入口口径）
- `docs/research/20261005-changelog-third-party.md:5`（本文件头部元信息与选址惯例来源）