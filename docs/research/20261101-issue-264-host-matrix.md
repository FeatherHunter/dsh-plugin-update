# #264 T0：真机宿主矩阵与 UI 驱动可行性（spike 结论）

- 票：#264（T0 spike），规格 #263
- 分支：`impl/263-t0`（基线 `integration/spec-263` = master 0b782f4）
- 证据目录：`selftest/evidence/runs/264-20261101T194628/`（run.json / raw/ / shots/ / desktop-profile-before-after.json / desktop-profile-after.json）
- 临时脚本：`selftest/spike/264/`（**全部 .ts**，Node 24 直接 `node x.ts` 跑；throwaway，T1 会重写成正式 harness）
- 时间：2026-11-01 19:46–21:10 (+08)
- 本票不改产品代码；所有驱动脚本只读 UI、只点真实按钮；所有安装/写入只落在隔离 home，不写维护者 profile。

## 0. 一句话结论

| 通道 | 状态 | 一句话原因 |
| --- | --- | --- |
| A 官方桌面版（Electron + CDP） | **可用（深链 PASS）** | 隔离第二实例 → 向导两层关闭 → taskkill 自己进程树 → 同 udd/同 home 换端口重启 → `[data-dsh-prompt-entry]` 出现 → 悬停面板 →「模板管理」→ 设置页 → 更新入口 → `.dsh-upd[data-mode=dialog]` → 点「检查更新」→ 截图，13 步全过（raw/98a-result.json） |
| B 普通 DSH 宿主（临时 profile + 系统 Chrome） | **可用（全绿）** | 起宿主 → 装集成方 → 开集成方面板 → 进设置 → 点更新入口 → 弹出更新面板 → 点「检查更新」→ 截图，10 步全过（raw/98-result.json） |

选定 UI 驱动：**Node 内置 WebSocket 的裸 CDP**（通道 B 用系统 Chrome，通道 A 用 Electron 的 DevTools 端口），零新依赖，不引入 Playwright/Puppeteer。两条通道共用一套 `lib/cdp.ts` / `lib/proc.ts`。

## 1. 通道 B：普通 DSH 宿主（主通道，可用）

### 1.1 流程（全部真实命令，逐条落在 raw/）

1. `env-probe`（raw/01）：记录 node/npm/chrome/dsh CLI 版本。
2. `seed-web-profile`（raw/02）：`DSH_HOME=<tmp>\home dsh --profile s263 --from-default-profile web --dump-config` —— 只生成配置骨架，不启动服务（0.2.1-rc.3 认 `--dump-config`）。
3. `install-integrator`（raw/03）：`DSH_HOME=<tmp>\home dsh plugin --profile s263 add dsh-prompt@0.4.40`。真实 registry 安装，7.0s；装完该 profile 的 `dsh.profile.bundles` 只有 3 项（base / web-app / dsh-prompt），**证明写的是隔离 profile，不是维护者的 desktop profile**。
4. `start-server`（raw/04）：`DSH_HOME=<tmp>\home dsh --profile s263 --port 0 --no-open`，stdout 解析出 `http://127.0.0.1:61925/?token=…`（raw/host-url.txt，token 已打码）。
5. `launch-browser`（raw/05）：`chrome.exe --headless=new --remote-debugging-port=0 --user-data-dir=<tmp>\udd <url>`，从 `DevToolsActivePort` 解析真实 CDP 端口。
6. `attach-and-prepare-page`（raw/06）：CDP `Page.navigate` + 轮询页面文本，对启动遮罩/引导门用真实按钮关闭。
7. `open-prompt-panel`（raw/07，shots/b1）：悬停 `[data-dsh-prompt-entry]` → 等 `[data-dsh-prompt-panel-root]` → 点面板里 title 含「设置 → 模板管理」的按钮（集成方 `goSettings`：先 `settings.open`，再点侧栏「提示词模板」）。
8. `open-update-panel`（raw/08，shots/b2/b3/b3-crop）：等 `[data-dsh-prompt-update-entry]` → **必须先 `scrollIntoView`**（首次 rect 的 y=-193，在视口外）→ 点击 → 等 `.dsh-upd[data-mode="dialog"]`。
9. `click-panel-entry`（raw/09，shots/b4）：面板内 `button[data-action]` 轮询到 `check` 可用后点击。点击证据：`pick={action:"check", text:"检查更新", x:467, y:421.9}`，同帧 `immediate={checkText:"正在查询版本信息…", checkDisabled:true}` —— 真打中并触发产品逻辑。
10. `cleanup`（raw/99）：`taskkill /T /F` 杀宿主与浏览器进程树，等端口释放。

### 1.2 面板态证据（raw/09 的 before/after 文本里可直接 grep）

`插件更新` / `更新档案 卷` / `dsh-prompt` / `使用范围 s263 profile` / `已是最新，无需更新` / `运行版 0.4.40` / `最新版 0.4.40` / `更新队列 当前无排队任务；同一使用范围同时仅安装一项` / `错误信息 暂无失败`；最终动作集：`check`（重新启用）、`install`（disabled）、`copy-diag`、`close-view`。

### 1.3 TS 化后重跑（行为不变）

`node channel-b.ts --run-dir … --workdir … --plugin dsh-prompt@0.4.40`：exit 0，10 步全 ok（env-probe 227ms / seed 205ms / install 6758ms / start-server 6141ms / launch-browser 434ms / attach 3244ms / open-prompt-panel 483ms / open-update-panel 2417ms / click-panel-entry 3255ms），cleanup server pid 52800 port 59079、browser pid 50332 cdpPort 62935 均 exited/portFree。证据：raw/50-channel-b-ts-smoke.txt、raw/51-channel-b-ts-smoke-result.json、raw/51b-channel-b-ts-smoke-cleanup.json。

### 1.4 截图

- `shots/b3-update-panel.png`（整窗）、`shots/b3-update-panel-crop.png`（`Page.captureScreenshot` 的 clip 裁面板 rect）、`shots/b4-after-panel-click.png`（点击后的查询态）。
- 每张 png 旁都有同名 `.json`，写「看什么 / expected / actual / 判定」四段。

## 2. 通道 A：官方桌面版（深链已打通，可用）

### 2.1 隔离启动（踩了三个坑，都留了原文）

- 坑 1（raw/11）：`DeepSeek Harness.exe --user-data-dir=… --remote-debugging-port=59333` 立即退出（exit 9），stderr 原文 `bad option: --user-data-dir=...`。根因：当前进程环境里有 `ELECTRON_RUN_AS_NODE=1`（DSH 宿主注入），Electron 退化成 Node CLI 解析参数。
- 坑 2：只删 `ELECTRON_RUN_AS_NODE` 还不够 —— 继承来的 `DSH_HOME` / `DSH_PROFILE` / `DSH_PROFILE_DIR` / `DSH_SESSION_ID` / `DSH_SHELL` / `DSH_WEB_URL` 会把实例连回维护者宿主。启动脚本 `launchEnv()` 把这些 **全部删除**，再显式设回隔离 `DSH_HOME`。
- 坑 3：必须**直连 spawn exe**（不经 `cmd`），否则拿不到干净 rootPid，进程树收不干净。
- 成功证据（raw/12、raw/31）：`/json/version` 返回 `Browser Chrome/152.0.7977.130`、`Electron/44.7.0`、UA 含 `@deepseek-ai/dsh-desktop/0.2.1-rc.3`（后期升到 rc.5）；隔离进程表里主进程带 `--user-data-dir=<tmpA>\udd2`，宿主子进程 profile 是 `…\t0-264-channelA\home\profiles\desktop`；维护者宿主 pid 17020/39812 全程存活（raw/42、raw/64）。

### 2.2 首启额度向导两层关闭（raw/63 + shots/a30–a32 + raw/65）

首启态是「欢迎页 → 开始设置 → 准备可用额度」：点「跳过」**不直接关**，会弹二次确认「暂时跳过充值？」（按钮「我知道了 / 前往充值」），再点「我知道了」才消失。逐轮原始记录 raw/63-channel-a-wizard-wizard-skip.json：

- `layer1Skip`：text=跳过，rect x=1140.8 y=726.7，`inViewport:true`、`inside:true`、`via:"cdp-mouse"`；
- `confirmDialog`：text=`暂时跳过充值？ 没有可用额度时，DeepSeek Harness 将无法开始新的任务。…我知道了 前往充值`，buttons=`["我知道了","前往充值"]`；
- `layer2Confirm`：text=我知道了，`via:"cdp-mouse"`；
- `wizardGone:true`、final `{wizard:false, dialogs:[], composer:true}`。

截图：`a30-desktop-wizard-credit.png`（点跳过前的额度页）、`a31-desktop-wizard-confirm.png`（二次确认框）、`a32-desktop-wizard-closed.png`（关掉后回会话页，输入框左侧已有 Prompt 入口）。

**复现条件（T1 必读，raw/65-channel-a-wizard-repro.json）**：onboarding 可见条件是 `visible = !done && signedIn && !unavailable`（`ui-settings-account/lib/client.js` 的 `derive()`，signedIn = account.status === 'credential-stored'）。全新隔离 home 只会生成 `client-connection/browser-session` 凭据 → account 未 signed-in → **首启根本不弹向导**（3 次尝试均落空）；给全新 home 预置 account 凭据又会让 rc.5 渲染进程不响应 `Runtime.evaluate`（2 次 CDP 超时）。可行做法：用**已 signed-in 的隔离 home**（本票 home 在 11:58Z 由早前探索写入 `deepseek-account-platform/device + /default` 凭据），把 `ui-settings-account` 的 `step` 临时置回 `credit`、`completion: null`，配全新 `--user-data-dir` 起实例；关完后 app 自己写回 `step: done / completion: skipped`。

### 2.3 「立即启用」→ 重启后生效（H 组：在册沉降）

安装出口二装完 dsh-prompt@0.4.40 后点「立即启用」**不即时生效**（对话页 30s 内没有 `[data-dsh-prompt-entry]`，旧 raw/23 时代结论）。本票验证了正确恢复路径：**taskkill 自己那条隔离桌面实例的进程树 → 同一 `--user-data-dir` + 同一隔离 `DSH_HOME` + 新调试端口重启** → 等页面就绪 → `[data-dsh-prompt-entry]` 出现（raw/34，rect x=606.4 y=501.0，label=Prompt）。宿主日志 `home\logs\dsh-prompt\2026-11-01.log` 同时有 `app.boot hasReact:true entryCount:8`，说明插件客户端 bundle 在重启后 apply 了。

### 2.4 深链：入口 → 面板 → 设置页 → 更新面板 → 点「检查更新」

重启后（cdpPort 59344，rootPid 58804，raw/98a-result.json，2026-11-01T12:39:58.554Z–12:40:20.588Z，13 steps / 8 shots / blockers=[]）：

1. `attach`（raw/32，shots/a20）：等应用首屏就绪（`innerText` 不含 `Loading plugins`）再动，避免在插件加载完成前误判「无向导」。
2. `wizard-skip`（raw/33）：重启后向导已 done，记录 `rounds=[{action:"done"}]`、final `{wizard:false, dialogs:[], composer:true}`。
3. `entry`（raw/34，shots/a22）：`[data-dsh-prompt-entry]` 出现。
4. `prompt-panel`（raw/35，shots/a23）：`mouseMove(2,2)` → 移到入口中心 → 等 `[data-dsh-prompt-panel-root]`。面板按钮实测为：全部 / 自定义 / ＋新增 / 展示预制模板 / 当前：悬浮触发 / 模板管理（title=「设置 → 模板管理」）/ ×（关闭）——**没有叫「设置」的按钮**，点「设置」必然失败，正确入口是「模板管理」。
5. `settings-page`（raw/36）：点「模板管理」→ 集成方 `goSettings` 先 `settings.open`，再点侧栏「提示词模板」→ 设置页出现 `[data-dsh-prompt-update-entry]`（头行 UpdateEntryButton，variant=button、autoCheck=mount，所以挂载即自查，文案「已是最新 0.4.40」）。
6. `update-entry`（raw/37，shots/a24）：入口 rect 首次 y=-152.6（视口外）→ `scrollIntoView({block:'center'})` 后 y=120.0、`inViewport:true`、`inside:true` → 截图（**截图在点击之前**）。
7. `update-entry-click`（raw/38）：`clickVia:"cdp-mouse"`。
8. `update-panel`（raw/39，shots/a25 + crop）：`.dsh-upd[data-mode=dialog]` rect `{x:339.14,y:46.02,w:601.14,h:729.1}`，clip `{x:331.14,y:38.02,w:617.14,h:745.1}`；面板文案：插件更新 / 更新档案 卷 / dsh-prompt / 使用范围 desktop profile / 已是最新，无需更新 / 运行版 0.4.40 / 已安装 0.4.40 / 最新版 未知 / 检查更新（disabled，正在查询版本信息…）/ 安装更新（disabled）/ 复制诊断 / 02 更新日志 / 03 更新队列（当前无排队任务；同一使用范围同时仅安装一项）/ 04 错误信息（暂无失败）。
9. `click-check`（raw/40，shots/a26）：`pick={action:"check", text:"检查更新", disabled:false, x:398.29, y:421.54}` → 点击后 immediate `{checkText:"正在查询版本信息…", disabled:true}` → after 文本出现 `最新版 0.4.40`、`更新说明（0.4.40 → 0.4.40）：作者未提供更新说明，安装不受影响`。
10. `console`（raw/41）：收集到 0 console / 0 exception / 6 logEntries / 0 pageErrors；6 条都是 `dsh-prompt/update/prompt.logAppend` 的 404（dsh-prompt 自己的日志上报端点，不影响更新面板，记录备查）。
11. `cleanup`（raw/42）：隔离进程树 4 个（root 58804 + 51944/26816/45768）taskkill /T /F → exited=true、portFree=true、isolatedAfter=[]；维护者进程 17020/39812 存活、维护者 profile package.json SHA 前后均为 `aa45f522…`。

### 2.5 通道 A 的 known-red（详见第 6 节）

- 预置 account 凭据的全新 home 在 rc.5 下渲染进程不响应 CDP（自动化「首启向导」的复现限制）；
- 入口深链依赖产品文案（「模板管理」而非「设置」）与头行入口（常在视口外）—— T1 换成稳定 `data-*` 选择器/等待条件，别按文案硬编码。

## 3. UI 驱动选型

| 方案 | 本票结论 | 理由 |
| --- | --- | --- |
| **裸 CDP（Node 内置 WebSocket + 系统 Chrome / Electron DevTools 端口）** | **选它** | 零新依赖（Node ≥22 自带 `WebSocket`），两条通道共用一套 `lib/cdp.ts`；能拿 DOM、能发真实鼠标事件、能裁图；进程/端口完全自己掌控，清理简单；失败时能看到原始协议错误 |
| Playwright / Puppeteer | 不用 | 违反本票硬边界（不加依赖）；Playwright 的 Electron 支持要额外装 `playwright-core` + 版本对齐 Electron 44，成本高于收益 |
| Windows UI Automation + 桌面截图 | 只在通道 A 完全连不上 CDP 时作 fallback | UIA 对 Electron 自绘 UI 的树往往拿不到内部按钮；桌面截图无法定位面板内部元素，证据力弱于 CDP DOM 断言 |

补充：通道 A 的 CDP 走 Electron `--remote-debugging-port`，协议与 Chrome 完全一致，所以 `lib/cdp.ts` 直接复用；这是本票能打通两条通道的主要原因。`connect({cdpPort, timeoutMs, onEvent})` 的 `onEvent` 会收集 `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` / `Log.entryAdded`，raw/41 即由此产出。

## 4. 宿主 × 场景覆盖矩阵（按 #263 权威 A–K 组名）

> 组名与语义取自规格 #263 原文：「既有 A–J 十组（单包主链、码面、三出口、超时取消、批量、队列锁、中枢、在册沉降、拓扑补偿、日志面板）加上新增的 UI 组 K」。
> 状态：**主宿主**（首选真机宿主）/ **备宿主**（能覆盖但非首选）/ **部分覆盖**（UI/证据只到一半）/ **不可达（known-red）**（本票无环境或未触发，给 T1 条件）。
> 初版「推定组」→ 权威字母的映射：原 A 面板打开→A；原 B 检查更新→A（主链）；原 C 安装/回退→C；原 D 失败态/诊断→B 码面 + C 失败码；原 E 出口一→C；原 F 出口二→C；原 G 出口三→C；原 H HMR/多插件守卫→I（拓扑补偿）；原 I 重启提示→H（在册沉降）；原 J 日志→J；原 K UI 专项→K。

| 组 | 场景（#263 权威语义） | 主宿主 | 备宿主 | 本票实测状态 | 证据 |
| --- | --- | --- | --- | --- | --- |
| A 单包主链 | 单插件：面板打开 → 检查更新 → 结果态（dialog 根/卷/插件名/版本） | **B** | A | **可达**（B 10 步全绿；A 13 步全绿） | raw/07–09 + shots/b1–b4；raw/34–40 + shots/a22–a26 |
| B 码面 | 失败码 / 人话格 / 手工命令 / 诊断复制（copy-diag） | **B** | A | **部分覆盖**：面板 DOM 有「错误信息 暂无失败」「复制诊断」按钮与「请查看日志 <DSH_HOME>/logs/<derived>」；失败码注入未实测 | raw/09（before/after 文本）、raw/39、shots/a25 |
| C 三出口 | 出口一第三方 Desktop / 出口二官方桌面 in-process / 出口三普通 DSH spawn CLI；含 remove→install 两步、already-installed、失败码/人话格/手工命令 | **A（出口二）** / **B（出口三）** | A、B | **部分覆盖**：出口二真机装成功（A）、出口三真机 add 成功（B）；出口一不可达；remove→install / already-installed 幂等未测 | raw/24 + shots/a5（出口二）；raw/03（出口三）；第 5 节 |
| D 超时取消 | 检查更新超时、取消/中止、超时人话 | **B** | A | **不可达（known-red）**：本票 check 都是即时返回，未注入网络延迟/断网 | raw/09/raw/40 只有成功态；需 T1 造超时（见第 6 节 8） |
| E 批量 | 多插件批量检查/安装/队列 | **B** | A | **不可达（known-red）**：本票只装 1 个插件，无批量宿主 | raw/03 bundles 只有 3 项；需 T1 装 2+ 插件 |
| F 队列锁 | 同一使用范围单任务、排队、并发冲突 | **B** | A | **部分覆盖**：面板有「更新队列 当前无排队任务；同一使用范围同时仅安装一项」；锁行为未并发触发 | raw/09、raw/39、shots/a25 |
| G 中枢 | 中枢（多宿主/计划/租约）场景 | **B** | A | **不可达（known-red）**：本票无中枢环境 | 无；需 T1 按 #263 G 组搭中枢 |
| H 在册沉降 | 重启宿主后：插件是否注册 / 未注册 / 重启是否生效 | **A** | B | **可达（本票重点验证）**：启用后不即时生效 → 重启隔离实例后 `[data-dsh-prompt-entry]` 出现 + 宿主日志 `app.boot entryCount:8` | raw/23（旧：启用不生效）、raw/34 + a22（重启后入口）、home/logs/dsh-prompt/2026-11-01.log |
| I 拓扑补偿 | 拓扑变化/补偿（初版误归为「HMR/多插件守卫」） | **A**（候选） | B | **不可达（known-red）**：未做 HMR/多插件拓扑场景 | 初版只到「推测」；需 T1 用 A 的 CDP 在插件页 enable/disable 后看补偿 |
| J 日志面板 | 日志面板 / 事件目录一致性 / 诊断日志 | **B** | A | **部分覆盖**：能同时拿浏览器 console（raw/41，含 6 条 dsh-prompt 404）与宿主 stdout（raw/server.out.log）；产品「日志面板」UI 未打开 | raw/41、raw/10（通道 B 未装 exceptionThrown 收集器，T1 补）、raw/server.out.log |
| K UI 组 | UI 驱动专项：选择器稳定性、视口滚动、挂载即自查、HMR 后重连 | **B** | A | **可达**（本票核心产出）：两条通道同一套裸 CDP 驱动；scrollIntoView、elementFromPoint 覆盖校验、截图在动作之前、check 先 disabled 等坑全部固化进脚本 | lib/cdp.ts、lib/proc.ts、raw/33/37/39/40、raw/63 |

一句话：**A 组 B 主 A 备；C 组出口二用 A、出口三用 B；H 组用 A（重启类）；K 组以 B 为主；B/F/J 部分覆盖；D/E/G/I 不可达（known-red 条件见第 6 节）。**

## 5. 三条安装出口可达性

| 出口 | 形态 | 本票结论 | 证据 |
| --- | --- | --- | --- |
| 出口一 第三方 Desktop | 第三方壳调 `desktopPnpm.runPlugin(参数数组, 范围目录, undefined)` | **不可达（本机无第三方 Desktop 构建）** | 未测；T1 需先拿到一个第三方 Desktop 安装包 |
| 出口二 官方桌面 in-process | `pluginManager.installBundle(spec, opts)` → `ChangeResult` | **可达（真机成功）** | raw/24-channel-a-install.json、shots/a5：`dsh-prompt@0.4.40` 经插件管理器 UI 装成功，末态「已安装 dsh-prompt … 版本 0.4.40 查看安装详情 立即启用」 |
| 出口三 普通 DSH spawn CLI | 普通 dsh 反查 `process.argv[1]` 起 CLI | **可达（真机成功）** | raw/03：隔离 profile `dsh plugin add dsh-prompt@0.4.40` 成功，版本核对 0.4.40 |

注意：`--profile desktop` 在**无载体的普通 dsh** 上必败（官方桌面载体 `D:\DeepseekHarness\resources\runtime\cli\bin\dsh.cmd` 不拒 `desktop`）——出口三的 T1 用例要覆盖这条负例。

## 6. known-red 清单

1. **`ELECTRON_RUN_AS_NODE=1` 会让 `DeepSeek Harness.exe` 退化成 Node CLI**（`bad option: --user-data-dir=...`）。起桌面实例的脚本必须显式删除该变量。
2. **继承的 `DSH_*` 环境变量会把隔离实例连回维护者宿主**。`launchEnv()` 删除 `DSH_HOME/DSH_PROFILE/DSH_PROFILE_DIR/DSH_SESSION_ID/DSH_SHELL/DSH_WEB_URL` 后再显式设回隔离 home（raw/31 记录 envRemoved 7 项）。
3. **首启额度向导是两层**：跳过 → 「暂时跳过充值？」→ 我知道了。已实测可关（raw/63 + shots/a30–a32），但**复现有前提**：onboarding 可见要求 account signed-in + `step !== done`；全新 home 不弹向导（raw/65 记录 3 种失败复现），预置 account 凭据的 rc.5 实例会 CDP 卡死（`Runtime.evaluate` 超时 ×2）。T1 若自动化首启向导，复用已 signed-in 的隔离 home。
4. **「立即启用」不即时生效**：需重启宿主/app。本票已验证重启后生效（H 组，raw/34 + a22 + `app.boot entryCount:8`）——从阻塞点降级为「场景 H 的注意点」。
5. **更新入口在设置页头行、常在视口外**（rect.y=-152.6）：点击前必须 `scrollIntoView({block:'center'})` + 重新取 rect + `elementFromPoint` 校验命中。
6. **面板挂载即自查**：`check` 会短暂 disabled、文案「正在查询版本信息…」；轮询动作按钮时先只认真动作（check/install/toggle-changelog/copy-manual/restart-hint/skip），约 18s 后才允许 fallback 到 copy-diag/close-view，否则会点到「复制诊断」误判。
7. **profile 归因**：维护者 desktop profile 的 `package.json` + `pnpm-lock.yaml` 在 11:53:56Z 被改写（billion-context 0.1.209 → 0.1.211）。**不是本票写的**：本票所有安装只写隔离 home（raw/03 bundles=3、raw/26/42/64 隔离进程证据）；同期运行中的官方桌面 app 在 11:53:06Z 写 `AppData\Roaming\@deepseek-ai\dsh-desktop\Local Storage\leveldb`，且 desktop profile 的 `.plugin-manager\logs` 在 11:45–12:10Z **无任何 operation-* 目录**（不是经官方插件管理器）。详见 raw/52-desktop-profile-attribution.json 与 desktop-profile-before-after.json（verdict=CLEAN-WITH-ATTRIBUTION）。
8. **通道 A 深链依赖产品文案**：面板里没有「设置」按钮，正确入口是 title 含「设置 → 模板管理」的按钮（集成方 `goSettings`）；T1 应换成 `data-*` 稳定选择器或等待条件，别按文案硬编码。
9. **不可达场景的 known-red 条件**：D 超时取消（需注入网络延迟/断网）、E 批量（需装 2+ 插件）、G 中枢（需中枢环境）、I 拓扑补偿（需 HMR/多插件拓扑）、出口一（需第三方 Desktop 构建）——这些在 T1 有环境后应各补一条真机用例。

## 7. 给 T1 的可复用命令 / 脚本 / 坑

可直接复用的脚本（`selftest/spike/264/`，throwaway，**全部 .ts**，Node 24 直接跑）：

```
lib/proc.ts             Windows 命令行引号、进程树 taskkill、端口占用/释放探测、startLongRunning/waitForExit
lib/cdp.ts              裸 CDP 最小客户端（evaluate / waitFor / mouseMove / click / screenshot / onEvent 事件收集）
profile-fingerprint.ts  profile 关键文件 SHA256 + 目录条目指纹（用于「未改动」AC）
channel-b.ts            通道 B 全流程编排（--run-dir / --workdir / --plugin / --keep）
channel-a-deeplink.ts   通道 A 深链全流程（--run-dir / --home / --user-data-dir / --cdp-port / --desktop-exe / --keep）
channel-a-wizard.ts     通道 A 首启向导两层关闭的取证脚本（同上参数）
channel-a.ts / channel-a-ui.ts / channel-a-install.ts / channel-a-panel.ts  探索期小工具（保留作参考）
```

类型检查：`selftest/spike/264/tsconfig.json` 是本目录自己的口径（`noCheck:true` + `node-shims.d.ts` 宽形状，只钉语法/模块/扩展名）；`selftest/tsconfig.json` 已 `exclude: ["spike/**"]`，所以 `npx tsc -p selftest/tsconfig.json --noEmit` 仍全绿（本票实测 exit 0），根 `npm run typecheck` 不受影响。

关键命令（照抄即可）：

```powershell
# 通道 B
$env:DSH_HOME = '<tmp>\home'
& '<dsh.cmd>' --profile s263 --from-default-profile web --dump-config
& '<dsh.cmd>' plugin --profile s263 add dsh-prompt@0.4.40
& '<dsh.cmd>' --profile s263 --port 0 --no-open      # stdout 里解析 http://127.0.0.1:<port>/?token=…
chrome.exe --headless=new --remote-debugging-port=0 --user-data-dir=<tmp>\udd <url>

# 通道 A（注意清变量；直连 spawn exe 拿 rootPid）
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:DSH_HOME,Env:DSH_PROFILE,Env:DSH_PROFILE_DIR,Env:DSH_SESSION_ID,Env:DSH_SHELL,Env:DSH_WEB_URL -ErrorAction SilentlyContinue
$env:DSH_HOME = '<tmpA>\home'
& 'D:\DeepseekHarness\DeepSeek Harness.exe' --user-data-dir=<tmpA>\udd2 --remote-debugging-port=59333
# 连接：GET http://127.0.0.1:59333/json/list → webSocketDebuggerUrl → Runtime.evaluate
# 重启：taskkill /PID <rootPid> /T /F → 同 udd2/同 home/新端口再起
```

坑清单（本票亲测）：

1. **用模板字符串生成脚本时，脚本里的反引号会提前结束模板**，写完必须 `node --check`。
2. CSS 属性选择器里的值不要加引号（`.dsh-upd[data-mode=dialog]`）。
3. 点击前校验 rect 在视口内（`scrollIntoView({block:'center'})` + 重新取 rect + `elementFromPoint` 命中校验，否则点击落在覆盖层上）。
4. Chrome 用 `--remote-debugging-port=0` + `DevToolsActivePort` 文件拿真实端口；桌面实例用显式端口并先探 `/json/version`。
5. 收尾必须 `taskkill /T /F` 杀进程树并轮询端口释放，否则下一轮会连到旧实例。
6. **截图必须在动作之前**（否则截图与文件名不符）；每张图配同名 json 四段判定。
7. 等应用首屏就绪（`innerText` 不含 `Loading plugins`）再判断/点击，否则会把「插件还没加载」误判成「无向导/无入口」。

## 8. AC 勾选

- [x] **至少一条通道完成点击 + 截图（截图能定位更新面板）**：通道 B raw/09 + shots/b3（整窗）/b3-crop（面板）；通道 A raw/40 + shots/a25/a26（深链 PASS，13 步）。
- [x] **另一条通道的可用/不可用有原始证据**：通道 A 有启动两坑原文（raw/11、12）、向导两层逐轮记录（raw/63）、重启后入口（raw/34）、深链 13 步（raw/98a-result.json）、失败探索（raw/23、shots/a12）；通道 B 有 10 步 raw/01–10。
- [x] **宿主矩阵决策（每条安装出口的真机宿主、不可达出口 known-red 条件）**：第 4 节 A–K 权威组名矩阵 + 第 5 节三出口 + 第 6 节 9 条 known-red。
- [x] **维护者 profile 未被本票写入（隔离证据 + 前后指纹；全局文件级差异已归因外部运行中的 DSH 桌面 app）**：before/after 指纹见 `desktop-profile-before-after.json`（含 after2 稳定采样）与 `desktop-profile-after.json`；归因见 raw/52；本票写入只在隔离 home（raw/03 bundles=3；raw/26/42/64 隔离进程与端口证据）。
- [x] **产出不进产品包、不改产品代码**：diff 只有 `docs/research/` 与 `selftest/`（spike 脚本 + 证据）；`package.json` 的 `files` 白名单未动，产品 `src/` 零改动。
