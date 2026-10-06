# 官方桌面版重启能力调查（issue #77）

> 调查时间：2026-10-07 ｜ 调查方式：只读（read / grep / asar 档案内只读 / web_fetch 一手文档，未改仓内任何文件，未解包写盘）
> 被调查仓 HEAD：`867b8ae03efb9eeb47fce35a2fe9a59c3036109e`（2026-10-06，包版本 `0.7.1`，来源：`package.json:3`）
> 被调查宿主：官方桌面版 `@deepseek-ai/dsh-desktop-host`，宿主内 DSH `0.2.0-rc.2`（来源：档案内 `dsh/package.json:4`，2026-10-07 现场读回，与 `docs/host-install-exits.md:12-14` 2026-09-30 取证一致，未变）
> 宿主档案：`D:\\DeepseekHarness\\resources\\app.asar`，121348951 字节单个档案文件（2026-10-07 经 bundled python `os.path.getsize` 读回；Node/Electron 侧 `fs.stat` 因 asar 补丁回 0，不可作数）
> 存放选址：`docs/research/` —— 本仓现行调研笔记惯例（`docs/research/20261004-*`、`20261005-*`，均为 `YYYYMMDD-<主题>.md`），故跟随该目录与日期前缀命名；仓根 `research/` 仅一篇旧取证，不是现行惯例。
> 地图：#75（重启宿主能力调查，先调查）；本票阻塞终裁 #80；研究问题与决策依赖见 #75 Destination/Notes。

## 0. 结论摘要

1. **Electron 有重启标准组合，但只能宿主 main 进程调，插件够不着**：`app.relaunch([options])` + `app.quit()`/`app.exit(0)`；`relaunch` 本身不退出，必须再调退出；多次调起多个实例；`exit` 不发 before-quit/will-quit，`quit` 走正常关闭保证 beforeunload/unload；页首 `Process: Main` 即 main-only。（来源：`https://raw.githubusercontent.com/electron/electron/main/docs/api/app.md` `app.relaunch`/`app.exit`/`app.quit` 三节，2026-10-07 web_fetch 复核原文见第 1 节；渲染页 `https://www.electronjs.org/docs/latest/api/app` 同页）
2. **官方桌面版 main 进程确实用了该组合，但三处全是宿主自有路径，无一暴露给插件**：崩溃恢复 `restart`（`asar:lib/main.js:10983-10985`）、开发菜单 `restartAppHostMenu`（`asar:lib/main.js:11906-11910`，`...development ? [...]` 包住，生产不可见）、自更新 `quitAndInstall(true,true)`（`asar:lib/main.js:7083`，`DesktopUpdateManager.install` 内 after `beforeRestart()`）。（来源：2026-10-07 档案内只读，Electron fs 补丁路径 `app.asar/dsh/…` 直读；复跑见第 5 节）
3. **`pluginManager` 没有重启电话：只有装/卸/开关/取消**：`@Remote` 共 12 个 Typert 端点（2026-10-07 对抗审查纠正：原“仅 4 个”不确切）——变更类 7 个 + 只读类 5 个，见 §2 全量表，**无一是 restart/relaunch**（`asar:dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:1193-1212` 装饰器注册，`:1290-1341` 落边，`:1670/1691/1827/1844` 实现；签名 `asar:…/lib/typert.host.js:795-796/809-810/816-817`，与 `docs/host-install-exits.md:30-33` 一字不差）。`ChangeResult.application` 的 `restart-required` 是状态宣告不是动作（`typert.host.js:836-837`；`index.js:1801/2042` 产出两处）。（来源：档案内只读 + `docs/host-install-exits.md:23-40` 转引一致）
4. **`pluginManager` 之外无公开重启服务（否定性结论，有 grep 思路）**：`dsh-desktop-host/lib` 仅 2 文件（`cli.js`+`index.js`），无服务声明；`index.js` 内命中 `restart|relaunch|pluginManager` 仅任务准入注释，无提供项；全 main 进程 IPC 句柄无 restart 通道（`DESKTOP_IPC` 仅 `updates-status/updates-open` 等状态查询，`lib/main.js:6193-6213/11652-11673`）；`preload-update-dialog.cjs` 28 行仅 status/respond/changed 三通道。档案二进制全文 `relaunch 13 / pluginManager 513 / onRestartRequested 0 / desktopPnpm 0 / desktopProfiles 0`（2026-10-07 python 二进制计数）。类比证据：第三方 Desktop 公开契约明确关门（不给 raw Electron APIs，`desktopRuntime` 标 Desktop-internal 禁止注入）。（来源：第 4 节；类比 `https://raw.githubusercontent.com/anywhere-labs/deepseek-harness-desktop/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/docs/plugin-services.md`，仅作 house pattern 类比，非官方桌面版契约）
5. **CLI 载体代码存在，可用性未证，不能当重启路径写进规格**：`asar:dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js:91-104` `runDesktopCli({manageDesktopProfile:true,…})` 是唯一豁免 `--profile desktop` 封禁的口子（2026-10-07 读回 116 行全文，行号与 `docs/host-install-exits.md:55-59` 一致）；但“能否现场当兜底执行”仍是待确认项（票 #1）。且 CLI 只有 `boot/dump/plugin`（`asar:dsh/node_modules/@deepseek-ai/dsh/lib/bin.js:105/116`），无 restart 子命令；`dsh` 普通入口默认 `manageDesktopProfile=false`（`bin.js:101`），`rejectElectronProfile` 在 `:35-36/:112/:119` 按名拒绝 `desktop`。（来源：档案内只读）
6. **本包现状锚点不变：面板只做入口**：`pending-restart` 是正常终态不是失败；“重启宿主”按钮只调 `onRestartRequested?`，没给就 toast 手动重启，不假装。（来源：`src/panel.ts:1457-1458` 注释、`:2560-2569` restart-hint 分支、`src/panel-batch.ts:1864-1869` 同口径、`src/panel.ts:216` 选项定义、`README.md:136-141`、`src/bilingual.ts:377-378`）
7. **没有电话时的手动路径（Windows，唯一可靠）**：存工作 → 关窗口（托盘如有则 Quit；语义等价 `app.quit` 走 beforeunload）→ 开始菜单/快捷方式重开 → 回面板复查 `installedVersion == runningVersion` 且 `blockedReason` 不再是 `pending-restart`。（来源：第 1 节 quit 语义 + `src/bilingual.ts:378` + `README.md:488-496` §5.4 三条）
8. **给 #80 终裁的输入**：写规格只能写“入口 + 手动指引”（`onRestartRequested` 透传 + 横幅口径），写不出一键重启；一键需向宿主提新电话（候选如 `pluginManager.relaunch(reason?)`），附 §1 标准组合 + §3 签名证据 + §4 无替代证据；CLI 载体确认前不进任何一版；先落规格，再带证据提案。（详见第 7 节）

## 1. Electron 标准重启电话（一手文档，2026-10-07 复核原文）

**结论**：标准组合 `app.relaunch() + app.exit()/app.quit()`，main-process-only。

**出处**：`https://raw.githubusercontent.com/electron/electron/main/docs/api/app.md`（web_fetch 200，84769 字节，2026-10-07）：

> `### app.exit([exitCode])` —— "Exits immediately with exitCode… All windows will be closed immediately without asking the user, and the before-quit and will-quit events will not be emitted."
> `### app.relaunch([options])` —— "Relaunches the app when the current instance exits… Note that this method does not quit the app when executed. You have to call app.quit or app.exit after calling app.relaunch… When app.relaunch is called multiple times, multiple instances will be started…" + 示例 `app.relaunch({ args: process.argv.slice(1).concat(['--relaunch']) }); app.exit(0)`
> `app.quit()` —— "Try to close all windows… guarantees that all beforeunload and unload event handlers are correctly executed."

渲染页 `https://www.electronjs.org/docs/latest/api/app` 同页三节，页首 `Process: Main`。

**可复跑**：`curl -s https://raw.githubusercontent.com/electron/electron/main/docs/api/app.md | grep -n -A30 'app.relaunch'`；浏览器开渲染页搜 relaunch。

## 2. pluginManager：有 restart-required 状态，无 restart 动作（档案内只读，2026-10-07）

读法：Electron fs 补丁路径直读档案内文件（`app.asar/…` 拼进 `fs.readFile`，不解包不写盘；此前 `fs.stat(app.asar)` 回 0 是补丁行为，不可作数，改用 bundled python `os.path.getsize`）。

- 服务名 root 级：`asar:dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:1379-1380` `constructor(ctx,config){ super(ctx,"pluginManager"); …}`（与 `docs/host-install-exits.md:23-26` 一字不差）；同进程消费者 `asar:…/lib/types/tools.js:38` `const manager = ctx.pluginManager`。
- 挂载条件：`asar:dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:20-22` `id: plugin-manager / disabled: !!js "!ctx.get('profileContext')"`（行号与旧抄件一致；故“有服务≠官方桌面版”，见抄件 :27-29）。
- `@Remote` 共 12 端点（对抗审查纠正后全量）：装饰器 `index.js:1226-1341`（setVersionExemption/setPluginEnabled/setBundleEnabled/installBundle/waitForInstall/cancelInstall/removeBundle + 只读 5 个），ID 全量 `typert.host.js:393-702`、signature 全量 `:740-817`，落边 `:1290-1341`，实现 `:1670 setVersionExemption（非 Remote 目标）/:1691 installBundle /:1827 cancelInstall /:1844 removeBundle`；全文 grep `relaunch|restart` 在该文件仅命中 `restart-required` 字符串（`:1416注释/:1801/:2042` 产出），无方法定义。
- 签名：`asar:…/lib/typert.host.js:795-796` `@Remote installBundle(spec:string,options?:InstallBundleOptions):Promise<ChangeResult>`、`:809-810 cancelInstall`、`:816-817 removeBundle`、`:836-837 ChangeResult`（application 五态）、`:848-849 InstallBundleOptions`、`:860-861 ManagementError`、`:864-865 PackageResult` —— 与抄件 :30-33/34-40 逐行对应。
- 预期失败不 reject：抄件引 `…/lib/types/index.js:814-835` 折叠 catch（本次未重读该分片，沿用抄件；本包 `src/store.ts` 只按 application 判成败即据此）。

## 3. 宿主 main 进程的三处 relaunch：全是自有路径（2026-10-07 新增取证）

档案二进制 `relaunch` 共 13 处，其中宿主自有 2 处（余 11 处为 electron-updater 内 `ElectronAppAdapter.relaunch(){this.app.relaunch()}` 等自更新适配器，与插件无关）：

- 崩溃恢复：`asar:lib/main.js:10961-10985` —— `function quitWithoutConfirmation(){skipQuitConfirmation=true;app.quit();}` + `DesktopFatalRecovery` `restart:()=>{app.relaunch();quitWithoutConfirmation();}`；调用点 `:7572 this.operations.restart()`（崩溃对话框“重启”按钮，见 `:7551-7556 buttons`）。
- 开发菜单：`asar:lib/main.js:11905-11912` —— `...development ? [{label:messages.restartAppHostMenu ("Restart App and Host"/"重启应用与 Host"，见 :6584/:6751), click:()=>{if(quitting)return;app.relaunch();quitWithoutConfirmation();}}] : []` —— 生产不可见。
- 自更新安装：`asar:lib/main.js:7069-7083` —— `DesktopUpdateManager.install(version)` 内 `if(!await this.beforeRestart())return…; this.updater.quitAndInstall(true,true)`（autoUpdater 通道，见 subagent §2；本机 `D:\\DeepseekHarness\\resources\\app-update.yml:1-6` provider generic/channel nightly 佐证宿主用 electron-updater 自更新，但与插件重启两回事）。

**无一是插件可调电话**：三处皆在 main 进程闭包（`app` 直接引用），无 Typert/Remote 包装，无 IPC 转发。

## 4. pluginManager 之外无公开重启服务（否定性结论 + 可复跑 grep）

- `asar:dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/` 仅 2 文件：`cli.js`、`index.js`（2026-10-07 `readdir`）。`index.js`（367 行）内搜 `provide|service|Remote|restart|relaunch|pluginManager` 仅命中任务准入注释（`:136 task services unavailable`、`:166 quit task services`），无服务提供。
- 全 main IPC 句柄扫（`lib/main.js` 12332 行）：`ipcMain.handle/on` 无任何 `restart|relaunch` 通道；`DESKTOP_IPC`（`:6193-6213`）中更新相关仅 `updates-status/updates-open`（`:11652-11673`，状态查询 + 打开更新弹窗），不是重启。`preload-update-dialog.cjs` 28 行仅三通道 status/respond/changed。
- 二进制计数（bundled python 全文件 `bytes.count`，121348951 字节）：`relaunch 13 / Restart 53 / restart 517 / pluginManager 513 / onRestartRequested 0 / desktopPnpm 0 / desktopProfiles 0` —— 后三者 0 说明官方 asar 内无本包术语、无第三方 Desktop 服务名（与抄件“第三方路由另属一条”一致）。
- 类比（非直接证据）：第三方 Desktop 公开契约 `plugin-services.md`（pin 4f68147）明确 “It does not grant third-party access to raw Electron APIs, the renderer, or launcher bootstrap state.”，`desktopRuntime` 标 Desktop-internal 禁止注入；其 house pattern 为 "requesting orderly Cordis teardown and Electron relaunch"（subagent §4）。官方桌面版无等价公开文档，默认结论是有能力也不暴露。

**可复跑 grep 思路（留给 #80/现场，stdout 管道，不写盘）**：`npx @electron/asar list asar | Select-String "dsh-desktop-host|dsh-plugin-manager|dsh-base"` 列名；档案内搜 `relaunch|app\.exit|app\.quit|quitAndInstall|desktopRuntime|pluginManager`，重点看 `dsh-desktop-host/lib/*.js` 与 `typert.host.js` 除十二端点外有无 relaunch/restart 导出（2026-10-07 对抗审查已穷举：无）。

## 5. CLI 载体：代码存在，可用性未证（行号 2026-10-07 复核未变）

- 豁免载体：`asar:dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js` 全 116 行，`:91-104` `runDesktopCli(runtimeDir,supportDir){…await runCli({manageDesktopProfile:true,packageManager:{command:process.execPath,…}})}`，`:106-112` main 入口。这是唯一豁免 `--profile desktop` 封禁的口子。
- 封禁：`asar:dsh/node_modules/@deepseek-ai/dsh/lib/bin.js:35-36` `rejectElectronProfile`、`:101 manageDesktopProfile=false` 默认、`:112 boot 拒绝`、`:115-123 plugin 子命令`（无 desktop 豁免即拒）。`plugin` 命令描述为 "manage a profile's plugins by forwarding the remaining arguments to pnpm"（`:116`）—— 无 restart 子命令。
- 结论：CLI 能装 desktop profile 的插件（豁免），但不能重启宿主；且“现场能否执行”仍待确认（票 #1），本票不算可用重启路径。

## 6. 本包现状锚点（未变，2026-10-07 复读）

- `src/panel.ts:1457-1458` “宿主没有「重启自己」的电话，所以这里只做入口”；`:2560-2569` `case 'restart-hint'`（有 `onRestartRequested` 即交出去 toast delegated，无则 toast manual，catch 则 failed）；`src/panel-batch.ts:1864-1869` 同口径 `case 'restart'`；选项定义 `src/panel.ts:216`、`src/panel-batch.ts:113`；`README.md:136-141` 约定；文案 `src/bilingual.ts:377-378` pending-restart 中英；§5.4 `README.md:488-496` 三条（显眼横幅/说清版本号/不再给安装按钮）。

## 7. 给 #80 终裁的输入（决策用，非实现）

- 写规格方向：只能写“入口 + 手动指引”规格（`onRestartRequested` 透传 + `pending-restart` 横幅口径 + §5.4 三条 + 诊断复制），写不出一键重启官方桌面版规格 —— 无被调电话（§2-§4）。
- 向宿主提案方向：如要一键，需新电话（候选形状如 `pluginManager.relaunch(reason?)` 或受限白名单），提案附 §1 标准组合 + §2 现有签名证据 + §4 无替代证据；第三方 `select(name)` 范式可作措辞参考，不可直接复用（另条路由）。
- 先提什么：先落规格（手动路径 + 回执契约），再带证据提案；CLI 载体确认前不进任何一版。
- 待澄清（grilling 视角，本票无需追问用户）：Q1 先只调查/Q2 三条全覆盖/Q3 纯规划执行另起（地图 #75 Notes 引 2026-10-07 grilling 已定）—— 本票恪守“先调查不实现”，未猜实现形状。

## 8. 局限与复跑合集

局限：未解包写盘（只读直读 + 二进制计数）；asar 内行号为 DSH 0.2.0-rc.2 现场值；Electron 文档取 main 最新，未锁定宿主内 Electron 版本；第三方 plugin-services pin 仅类比；普通 CLI 的 desktop 拒绝在官方桌面版内的实际表现仍待现场点一次（票 #1）。

```powershell
# 档案与自更新源（只读）
Get-Item D:\DeepseekHarness\resources\app.asar | Select-Object Length, LastWriteTime
Get-Content D:\DeepseekHarness\resources\app-update.yml
# 仓内抄件与现状锚点（只读）
Select-String -Path docs/host-install-exits.md -Pattern "cli.js|pluginManager|restart-required"
Select-String -Path src/panel.ts -Pattern "onRestartRequested|restart-hint"
Select-String -Path src/panel-batch.ts -Pattern "onRestartRequested"
# 档案二进制计数（bundled python，不经 Electron 补丁）
& 'C:\Users\辰辰洋洋\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe' -c "data=open(r'D:\DeepseekHarness\resources\app.asar','rb').read();print(len(data));[print(t,data.count(t)) for t in [b'relaunch',b'pluginManager',b'onRestartRequested',b'desktopPnpm',b'desktopProfiles']]"
```
```bash
curl -s https://raw.githubusercontent.com/electron/electron/main/docs/api/app.md | grep -n -A30 'app.relaunch'
curl -s https://raw.githubusercontent.com/electron/electron/main/docs/api/auto-updater.md | grep -n -B2 -A15 'quitAndInstall'
curl -s https://raw.githubusercontent.com/anywhere-labs/deepseek-harness-desktop/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/docs/plugin-services.md | grep -n -B2 -A8 'does not grant'
```
