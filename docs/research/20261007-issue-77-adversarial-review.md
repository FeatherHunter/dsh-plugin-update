# 官方桌面版重启结论对抗式审查（#77）

> 日期：2026-10-07（Asia/Shanghai）｜触发：#77 调查笔记已落盘待关票，用户要求从第一性原理对抗式审查后再定。
> 方法：只认一手来源（asar 档案内直读、bundled python 二进制计数、web_fetch 原文、仓内源码行号）；拿不准写“未证实”，不行号编造。结论先行，反方先立，再逐条反驳或接受。
> 第一性原理：重启 = 杀掉当前 OS 进程 + 拉起新进程。能力住在进程句柄持有者手里（Electron main 的 `app` 对象）。插件是 cordis profile 作用域里的非受信客人，跨信任边界拿能力必须有显式委托通道（Typert Remote / IPC handle / preload 桥 / CLI 信号）。无通道 = 机制存在也够不着。用户手动是带外 supervisor 路径，不算委托。

## 结论摘要

- **Q1 结论存活、前提纠正**：pluginManager 无 restart/relaunch 电话成立，但原笔记“仅 4 个”是错的，实为 **12 个 Typert 端点**（变更 7 + 只读 5），已全量列出，无一是重启动作。原笔记 §0/§2/§4 三处“四方法”措辞已同步修正。
- **Q2 由弱否定升级为强否定**：补全枚举后——desktop-host 无服务提供、main 全量 26 个 DESKTOP_IPC 无重启、5 个 preload 桥无 relaunch 暴露、Typert 12 端点无重启——否定性结论成立，且不再依赖二进制计数。
- **Q3 存活并加固**：三处 relaunch 全是 main 闭包自有路径；`development = !app.isPackaged` 双处确认生产不可见；updater 的 beforeRestart 是任务授权+用户确认+受控停机的重流程，不是通用重启原语，插件无入口。
- **Q4 存活并加固**：CLI 只有 `boot/dump/plugin`（`bin.js:105/116`），无 restart 子命令是铁证；豁免载体只能装插件不能发重启信号。
- **Q5 存活，版本 pin 已补**：运行期 `process.versions.electron=44.0.0`（2026-10-07 现场读回）；relaunch“调完须再调退出”语义十年稳定，main 最新文档可放心引用，局限收窄为一句。
- **Q6 部分接受，手动路径需补两条警告**：① 关窗口≠退出（Windows 关窗口进托盘，需显式 Quit）；② 有运行中任务时 quit 走确认框，不会自动退。原“存工作→关窗口→重开”四步须升级为六步。
- **Q7 存活，提案形状收紧**：先规格后提案不变；提案附件须带 12 端点清单，堵住宿主“已有 X 可用”的反驳。

---

## Q1 pluginManager 真的无重启电话吗

### 反方立论

原笔记只数了 4 个方法，藏了其余 8 个；`restart-required` 没准是动作不是状态；`waitForInstall/setVersionExemption/setPluginEnabled` 听起来像能触发重启；“全文 grep 仅命中 restart-required”没贴全量表，不可信。

### 反驳证据链（全量表，逐件核对）

**（1）Typert ID 全量 12 个，无 restart。** `asar:dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/typert.host.js:393-702`：cancelInstall(:393)、inspect(:418)、installBundle(:455)、listBundles(:491)、listPlugins(:506)、listVersionExemptions(:521)、registries(:536)、removeBundle(:551)、setBundleEnabled(:576)、setPluginEnabled(:611)、setVersionExemption(:646)、waitForInstall(:702)。grep `relaunch|restart` 在 ID 行零命中。

**（2）signature 全量 12 个，无 restart。** 同文件 `:740-817`：listVersionExemptions(:740)、setVersionExemption(:747 `Promise<ChangeResult>`)、listPlugins(:754)、listBundles(:761)、registries(:768)、inspect(:775)、setPluginEnabled(:782)、setBundleEnabled(:789)、installBundle(:796)、waitForInstall(:803)、cancelInstall(:810)、removeBundle(:817)。唯一含 restart 字样的是 `ChangeResult` 声明（:836-837 `application: 'applied'|'restart-required'|'overridden'|'failed'|'cancelled'`）——类型成员，不是方法。

**（3）类实现与装饰器对齐，无暗藏。** `index.js:1226-1341` 装饰器 7 个变更方法名全对上实现 `1418 setVersionExemption / 1651 setPluginEnabled / 1670 setBundleEnabled / 1691 installBundle / 1819 waitForInstall / 1827 cancelInstall / 1844 removeBundle` + 只读 `1404/1431/1456`。`relaunch|restart` 在实现文件仅命中 `restart-required` 字符串（:1416 注释 / :1801 / :2042 产出），无方法定义。`waitForInstall` 只是轮询（:1819），`setVersionExemption/setPluginEnabled` 回的仍是 `ChangeResult` 状态（:1418/:1651），调完还是要用户手动重启。

**接受项**：原“仅 4 个”确属漏数（把 5 个只读 + setVersionExemption/setPluginEnabled/waitForInstall 丢了），已修原笔记三处。结论本身（无重启动作）不受影响，反而因全量表更硬。

## Q2 pluginManager 之外真的无服务吗

### 反方立论

否定性结论是最难证明的。原 §4 只看了 desktop-host 目录名、IPC 名字、二进制计数三个弱信号：desktop-host/index.js 367 行没细读；main 进程 cordis 服务注册没查；IPC 只看名字没看 handler 实现，真有 restart 藏在 updatesOpen 里怎么办；二进制计数 517 个 restart 一个没看就判无罪。

### 反驳证据链（委托面穷举）

**（1）desktop-host 无服务提供。** `asar:dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/` `readdir` 仅 2 文件 `cli.js/index.js`；`index.js` 367 行搜 `provide|service|Remote|restart|relaunch|pluginManager` 仅命中任务准入注释（:136/:166 `task services are unavailable`），零 `provide` 零 `Remote`。该包是 profile 作用域插件，不是 main 服务提供者。

**（2）main IPC 通道全量 26 个，无重启。** `asar:lib/main.js:6193-6219` DESKTOP_IPC 对象全文：shortcuts 6、boot/enterWorkspace/onboarding 4、browser 3、directoryPick/deviceInfo/locale 4、updates 3（status/open/presentation)、nativeTheme/window/windows 4。更新相关仅 `updatesStatus(:11652)` 状态查询 + `updatesOpen(:11673)` 打开更新弹窗 + presentation 推送，无 relaunch。`ipcMain.handle/on` 全文搜 `restart|relaunch` 零命中（重启三处全是直接函数调用，不是 IPC handler）。

**（3）preload 桥 5 个，无 relaunch。** `preload-app.cjs` 884 行：dshDesktop 仅 `status/ open`（:830-831）、dshPlatform 仅 open/setBounds/close（:867-870 窗口管理非重启）、其余为 onboarding/directoryPicker/locale/boot（:845-880）；`preload-update-dialog.cjs` 28 行仅 status/respond/changed；mandatory/welcome/platform-account 均无 restart。`exposeInMainWorld` 在 main.js 零命中（桥全在分散 preload，不在主包）。

**（4）二进制计数退居旁证。** python 全文件 `bytes.count`：relaunch 13（11 updater 适配器 + 2 宿主自有）、pluginManager 513、onRestartRequested/desktopPnpm/desktopProfiles 0。后三者 0 只说明无本包术语串入、无第三方服务名，与“无委托”互洽但不单独证明；主证明是上面三组穷举。

**结论**：弱否定升级为强否定。委托面（Typert 12 + IPC 26 + preload 5 + desktop-host 0 提供）已全部列出，无一是重启动作。

## Q3 三处 relaunch 真的都不可达吗

### 反方立论

崩溃恢复对话框能不能被插件故意触发（装个坏包搞崩溃就有重启键了）？updater 通道插件能不能调（调 updatesOpen 打开弹窗算不算间接重启）？dev 菜单生产真的不可见（development 变量到底是什么）？

### 反驳证据链

**（1）崩溃恢复是被动路径。** `lib/main.js:7518-7580` DesktopFatalRecovery.report 只在 fatal error 时弹框，按钮 `restartApplication`（:7551-7556）调 `operations.restart()`（:7572）即 `app.relaunch+quitWithoutConfirmation`（:10983-10985）。插件要走这条等于先把宿主搞崩——不可作为更新流程的重启设计，且恢复动作含 `disableAllPlugins` 分支（:10973-10979），语义是救灾不是生效。

**（2）updater 是重流程 gate。** 构造点 `:11465 new DesktopUpdateCoordinator(publishUpdate, beforeRestart)`，beforeRestart 闭包 :11465-11500：commandManager.idle、workspaceRecovery、updateTasks inspect（:11471）、用户确认弹窗（:11473-11488）、telemetry（:11489）、updateTasks lock（:11492）、closeAndWait+backend.stop（:11495-11498）后才 `quitAndInstall(true,true)`（:7083）。插件侧 IPC 只有 `updatesStatus/updatesOpen`（打开弹窗），调 open 只是把弹窗摆出来，后续确认+停机全在 main 闭包，插件调不动 quitAndInstall。

**（3）dev 菜单生产不可见是铁证。** `development = !app.isPackaged` 双处（:11031/:11187），菜单项被 `...development ? [...restartAppHostMenu...] : []`（:11899-11913）包住。生产包 `isPackaged=true` 即无此项。quitWithoutConfirmation（:10962-10964）本身也只是 `skipQuitConfirmation=true;app.quit()`，无 relaunch，不单独构成重启。

## Q4 CLI 真的不能重启吗

### 反方立论

runDesktopCli 传了 `ELECTRON_RUN_AS_NODE` + 内置 pnpm + `manageDesktopProfile:true`，这就是桌面给的尚方宝剑；拿它起 `plugin --profile desktop add` 装完，进程不会自己重载吗？或者拿 CLI 发信号让运行中宿主重启？

### 反驳证据链

**（1）CLI 命令表无 restart 是铁证。** `bin.js:105/116`：launcher 只有 profile boot/dump + `program.command("plugin")`（“forwarding the remaining arguments to pnpm”，:116）。插件命令透传给 pnpm（装/卸），boot 是拉起新进程，不是给运行中进程发重启信号。`rejectElectronProfile`（:35-36/:112/:119）+ 默认 `manageDesktopProfile=false`（:101）说明普通 CLI 连 desktop 安装位都碰不得；豁免载体（cli.js:91-104）只补了安装位，没补重启命令。

**（2）混淆的是两个人。** CLI 是另起的短命子进程（`runCli`），运行中宿主是 Electron main 长进程；子进程退出不等于宿主重启，更不能让宿主执行 `app.relaunch`。拿 CLI 当重启载体属于 confused deputy，用错主体。现场可用性（票 #1）悬置的是“豁免安装位能否执行”，不是“能否重启”，本票不把它算路径是正确的，Q4 存活。

## Q5 Electron 文档版本对得上吗

### 反方立论

引的是 main 最新文档，宿主 Electron 不知什么版本，万一 44 的 relaunch 语义变了（比如自动退出了），“须再调退出”就错了。

### 反驳证据链

运行期 pin 已补：2026-10-07 现场 `process.versions.electron=44.0.0`（chrome 152/node 24.18.1 同源）。relaunch“不退出、须再调 quit/exit、多次调起多实例”语义从 Electron 1.x 至今未变（ breaking 级变更必进 major migration 注，本次 main 原文与 44 时代一致）；且宿主自己三处正是 `relaunch();quitWithoutConfirmation()` / `quitAndInstall` 标准组合（:10983-10985/:11909-11910/:7083），行为互证。原局限“未锁定版本”收窄为一句：文档取 main，运行 pin 44，语义差为零。

## Q6 手动路径真的可靠吗

### 反方立论（部分成立）

“关窗口重开”四步太顺了：Windows 关窗口是真退还是进托盘？有运行中任务时 quit 会不会被拦？托盘到底有没有？验证只看两个版本号够吗（profiling 错位、pendingBuilds 怎么办）？

### 接受 + 补强（两条警告必须进 #80 规格）

**（1）关窗口≠退出。** 宿主有托盘（`lib/types/tray.js`、`tray.ico`、:11939 DesktopTray；文案 `:6530 backgroundNoticeBody "reopen the window from the system tray"`；Windows 还有“最小化进托盘前确认” :10878）。所以“关窗口”可能只是 hide，进程还在跑，新版不生效。原笔记“托盘如有则 Quit”的 hedge 方向对但太弱，必须改成硬指令：**从托盘右键 Quit / 菜单 Quit，确认进程已退出再重开**。

**（2）quit 有确认 gate。** `DesktopQuitConfirmation`（:10757-10771）“仅当 Host 报告无事可中断才静默退”，否则弹 `quitActiveTasks`（:6527/6694 “Running tasks will be interrupted”）；`skipQuitConfirmation` 只有崩溃恢复/dev/更新等自有路径才设（:10963/:10981/:10985/:11910），用户手动无豁免。原“存好工作”须升级：**先停 agent/turn 审批/job（或在确认框明确选“中断并退出”），否则 quit 被拦**。

**（3）验证手段充分（存活）。** `src/reader.ts:329` `installedVersion !== runningVersion → pending-restart`（2026-10-07 复读 :324-331 判定链），+ `README §5.4` 三条（显眼横幅/说清版本号/不再给安装按钮）。复查看横幅消失 + 两版本号一致即可；profiling/pendingBuilds 属安装侧诊断，不属重启验证。

## Q7 给 #80 的输入站得住吗

### 反方立论

“先规格后提案”是不是拖延？relaunch 提案形状一句带过，宿主一句“已有 updatesOpen 可用”就挡回来了怎么办？

### 结论（存活，收紧一处）

顺序不变：无电话时只能先把“入口 + 手动指引 + 回执契约”写死（否则面板各写各的），再带证据提案。提案附件必须升级：附 Q1 全量 12 端点清单 + Q2 全量 26 IPC 清单，主动证明“updatesOpen 只是开弹窗（:11673），quitAndInstall 在 main 闭包（:7083），插件调不动”，把宿主最可能的反驳提前堵死。CLI 确认前不进任何一版不变。

---

## 补强清单（给 #80 直接用）

1. 原笔记三处“四方法”已修正为 12 端点（本审查 §Q1）；终裁引用时以 12 为准。
2. 手动路径升级为六步：停任务 → 存工作 → **托盘/菜单 Quit（非仅关窗口）** → 确认退出（被拦则在确认框选角度中断）→ 重开 → 复查横幅+双版本号（reader.ts:329）。
3. 提案附件带两张全量表（Typert 12 + IPC 26），update 通道说明精确到“open 只是开弹窗”。
4. 版本 pin：Electron 44.0.0（现场），文档 main 可引。
5. 未证实（诚实保留）：普通 CLI 在官方桌面版内的实际表现（票 #1）；`…/lib/types/index.js:814-835` 不 reject 折叠沿用抄件未重读；asar 行号绑定 DSH 0.2.0-rc.2，宿主升级须重对。
