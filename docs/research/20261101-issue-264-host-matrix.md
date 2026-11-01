# #264 T0：真机宿主矩阵与 UI 驱动可行性（spike 结论）

- 票：#264（T0 spike），规格 #263
- 分支：`impl/263-t0`（基线 `integration/spec-263` = master 0b782f4）
- 证据目录：`selftest/evidence/runs/264-20261101T194628/`（run.json / raw/ / shots/ / desktop-profile-before-after.json）
- 临时脚本：`selftest/spike/264/`（throwaway，T1 会重写成正式 harness）
- 时间：2026-11-01 19:46–20:16 (+08)，约 30 分钟
- 本票不改产品代码；所有驱动脚本只读 UI、只点真实按钮。

## 0. 一句话结论

| 通道 | 状态 | 一句话原因 |
| --- | --- | --- |
| A 官方桌面版（Electron + CDP） | **部分可用** | 隔离第二实例、CDP 连接、插件管理器 UI、出口二 `installBundle` 安装都通了；但首启「准备可用额度」向导关不掉、装完点「立即启用」不即时生效，**没能走到更新面板** |
| B 普通 DSH 宿主（临时 profile + 系统 Chrome） | **可用（全绿）** | 起宿主 → 装集成方 → 开集成方面板 → 进设置 → 点更新入口 → 弹出更新面板 → 点「检查更新」→ 截图，9 步全过 |

选定 UI 驱动：**Node 内置 WebSocket 的裸 CDP**（通道 B 用系统 Chrome，通道 A 用 Electron 的 DevTools 端口），零新依赖，不引入 Playwright/Puppeteer。

## 1. 通道 B：普通 DSH 宿主（主通道，可用）

### 1.1 流程（全部真实命令，逐条落在 raw/）

1. `env-probe`（raw/01）：记录 node/npm/chrome/dsh CLI 版本。
2. `seed-web-profile`（raw/02）：`DSH_HOME=<tmp>\home dsh --profile s263 --from-default-profile web --dump-config` —— 只生成配置骨架，不启动服务（0.2.1-rc.3 认 `--dump-config`）。
3. `install-integrator`（raw/03）：`DSH_HOME=<tmp>\home dsh plugin --profile s263 add dsh-prompt@0.4.40`。真实 registry 安装，7.0s；装完该 profile 的 `dsh.profile.bundles` 只有 3 项（base / web-app / dsh-prompt），**证明写的是隔离 profile，不是维护者的 desktop profile**。
4. `start-server`（raw/04）：`DSH_HOME=<tmp>\home dsh --profile s263 --port 0 --no-open`，2.1s，stdout 解析出 `http://127.0.0.1:61925/?token=…`（raw/host-url.txt，token 已打码）。
5. `launch-browser`（raw/05）：`chrome.exe --headless=new --remote-debugging-port=0 --user-data-dir=<tmp>\udd <url>`，从 `DevToolsActivePort` 解析真实 CDP 端口（61945）。
6. `attach-and-prepare-page`（raw/06）：CDP `Page.navigate` + 轮询页面文本，确认宿主 UI 加载；对启动遮罩/引导门用真实按钮关闭（选择器：文本「开始使用」「继续」；本机一次即过）。
7. `open-prompt-panel`（raw/07，截图 shots/b1）：悬停 `[data-dsh-prompt-entry]` → 等 `[data-dsh-prompt-panel-root]` → 点底栏 `title` 含「设置」的按钮（实际命中「模板管理」，走集成方 `goSettings`）。
8. `open-update-panel`（raw/08，截图 shots/b2/b3/b3-crop）：等 `[data-dsh-prompt-update-entry]`（dsh-prompt 在设置页头行挂的更新入口）→ **必须先 `scrollIntoView`**（首次 rect 的 y=-193，在视口外）→ 点击 → 等 `.dsh-upd[data-mode="dialog"]` 出现。
9. `click-panel-entry`（raw/09，截图 shots/b4）：面板内 `button[data-action]` 轮询到 `check` 可用后点击。点击证据：`pick={action:"check", text:"检查更新", x:467, y:421.9}`，同帧 `immediate={checkText:"正在查询版本信息…", checkDisabled:true}` —— 说明这一下真的打中并触发了产品逻辑，不是空点。
10. `cleanup`（raw/99）：`taskkill /T /F` 杀宿主与浏览器进程树，等端口释放；server pid 58500 exited=true / portFree=true，browser pid 37068 exited=true / cdpPortFree=true。

### 1.2 面板态证据（raw/09 的 before/after 文本里可直接 grep）

`插件更新` / `更新档案 卷` / `dsh-prompt` / `使用范围 s263 profile` / `已是最新，无需更新` / `运行版 0.4.40` / `最新版 0.4.40`；最终动作集：`check`（重新启用）、`install`（disabled）、`copy-diag`、`close-view`。

### 1.3 截图（能定位到更新面板）

- `shots/b3-update-panel.png`：整窗，更新面板居中弹出，标题/卷/版本清晰。
- `shots/b3-update-panel-crop.png`：面板局部（截图时用 `Page.captureScreenshot` 的 clip 参数裁出 rect）。
- `shots/b4-after-panel-click.png`：点击后的查询态。
- 每张 png 旁边都有同名 `.json`，写「看什么 / expected / actual / 判定」四段（判定用符合预期 / 不符合预期 / 部分符合 / 不确定）。

## 2. 通道 A：官方桌面版（部分可用）

### 2.1 启动（踩了两个坑，都留了原文）

- 第一次（raw/11）：`DeepSeek Harness.exe --user-data-dir=<tmpA>\udd --remote-debugging-port=59333` 立即退出（exit 9），stderr 原文：
  ```
  D:\DeepseekHarness\DeepSeek Harness.exe: bad option: --user-data-dir=...
  D:\DeepseekHarness\DeepSeek Harness.exe: bad option: --remote-debugging-port=59333
  ```
- 根因（raw/12）：当前进程环境里有 `ELECTRON_RUN_AS_NODE=1`（由 DSH 宿主注入），Electron 退化成 Node CLI 去解析参数。**清掉这个变量后同一命令成功**。
- 成功证据（raw/12 的 `/json/version`）：`Browser Chrome/152.0.7977.130`、UA 含 `@deepseek-ai/dsh-desktop/0.2.1-rc.3`、`webSocketDebuggerUrl=ws://127.0.0.1:59333/devtools/browser/…`。
- 隔离证据（raw/12 / raw/22 的进程表）：主进程 pid 88256 带 `--user-data-dir=<tmpA>\udd2`；宿主子进程 pid 88984 的命令行里 profile 是 `D:\dsh-plugin\_wt263\runtime\t0-264-channelA\home\profiles\desktop`；维护者宿主 pid 17020（profile `C:\Users\辰辰洋洋\.dsh\profiles\desktop`）全程存活。

### 2.2 可用的部分

- CDP 连接与截图（shots/a0）：`/json/list` 只有 1 个 page target，URL `dsh-app://app/`，`Page.captureScreenshot` 正常返回整窗。
- 插件管理器 UI（出口二）可达：点侧栏「插件」后 DOM 文本出现「安装、启用和配置插件」「添加插件」「内置插件配置」（raw/23-channel-a-click-plugins.json）。**注意**：该步截图 shots/a1 与 a0 同哈希（都是欢迎页），说明截图早于渲染/截错窗口，不能当插件页的视觉证据；能看清插件页与安装结果的是 shots/a2（添加插件对话框，`role=dialog`，输入框 placeholder「例如 dsh-plugin-whale-pet」，安装源默认「中国大陆镜像源」，raw/23-channel-a-dump-dialogs.json 有 DOM 全文）与 shots/a5（安装成功弹窗）。
- **出口二真机安装成功**（raw/24-channel-a-install.json，shots/a5）：用原生 value setter 往输入框写 `dsh-prompt@0.4.40` + dispatch `input` → 点「安装」→ 文本先「插件安装中… dsh-prompt … 版本 0.4.40」，最终「已安装 dsh-prompt … 版本 0.4.40 查看安装详情 立即启用」。

### 2.3 阻塞点（known-red，需 T1 处理）

1. **首启「准备可用额度」向导**（shots/a0/a3/a11/a12）：按钮「继续 / 去充值 / 上一步 / 跳过」。本票先误判为「CDP 点不掉」，复核截图 a12 后修正：点「跳过」其实**弹出了二次确认「暂时跳过充值?」**（按钮「我知道了 / 前往充值」），脚本没接着点「我知道了」，所以向导一直留着；点「开始设置」则进入额度页。这条大概率**可以关掉**，只是要多点一层，T1 需把「跳过 → 我知道了」写进脚本再验一次。
2. **「立即启用」不即时生效**：点完列表仍显示「启用 dsh-prompt」，对话页 30s 内没有出现 `[data-dsh-prompt-entry]`（channel-a-panel.mjs 抛「等待超时(30000ms)：集成方输入框入口」，shots/a12）。推断需要重启桌面 app 或宿主才加载新插件客户端 bundle —— **未验证**，因为向导挡着、时间盒也到了。

结论：通道 A 目前能证明「官方桌面能被隔离启动 + CDP 可驱动 + 出口二安装可用」，但**不能证明**「更新面板深链可用」。这一条要 T1 继续。

## 3. UI 驱动选型

| 方案 | 本票结论 | 理由 |
| --- | --- | --- |
| **裸 CDP（Node 内置 WebSocket + 系统 Chrome / Electron DevTools 端口）** | **选它** | 零新依赖（Node ≥22 自带 `WebSocket`），两条通道共用一套 `lib/cdp.mjs`；能拿 DOM、能发真实鼠标事件、能裁图；进程/端口完全自己掌控，清理简单；失败时能看到原始协议错误 |
| Playwright / Puppeteer | 不用 | 违反本票硬边界（不加依赖）；且 Playwright 的 Electron 支持要额外装 `playwright-core` + 版本对齐 Electron 44，成本高于收益 |
| Windows UI Automation + 桌面截图 | 只在通道 A「向导关不掉」时作为 fallback | UIA 能点原生控件，但 Electron 自绘 UI 的 UIA 树往往拿不到内部按钮；桌面截图无法定位面板内部元素，证据力弱于 CDP DOM 断言。留作最后手段，不进 T1 主路径 |

补充：通道 A 的 CDP 走 Electron 的 `--remote-debugging-port`，协议与 Chrome 完全一致，所以 `lib/cdp.mjs` 直接复用；这是本票能 45 分钟打通两条通道的主要原因。

## 4. 宿主 × 场景覆盖矩阵

> 规格 #263 的 A–J 组清单 Lead 未在时间盒内回传，下表分组为**推定**（按插件更新面板的典型场景切分），**待 Lead 校准**；K 组为 UI 驱动专项。

| 组 | 场景（推定） | 建议宿主 | 理由 |
| --- | --- | --- | --- |
| A | 面板能否打开、能否定位（dialog 根、卷、插件名） | **通道 B** 为主，通道 A 补一次 | B 已全绿；A 受首启向导阻塞 |
| B | 检查更新（`check` 动作、查询态、结果态） | **通道 B** | 点击 + 同帧状态断言已打通（raw/09） |
| C | 有新版 → 安装 / 安装回退（`install` / `install-fallback`） | **通道 B**；需要 in-process 出口时用 **通道 A** | B 走真实 registry；A 的 installBundle 已验证可用 |
| D | 失败态 / 诊断复制（`copy-diag`、`dismiss-failure`） | **通道 B** | 纯 UI 断言，B 足够 |
| E | 安装出口一（第三方 Desktop `desktopPnpm.runPlugin`） | **未测**，T1 需第三方 Desktop 构建 | 本机没有第三方 Desktop 产物 |
| F | 安装出口二（官方桌面 in-process `pluginManager.installBundle`） | **通道 A** | 已在真机 UI 上装成功（raw/24） |
| G | 安装出口三（普通 DSH 自起 CLI） | **通道 B** | 已在隔离 profile 上 `dsh plugin add` 成功（raw/03） |
| H | 多插件 / 版本冲突 / `already-installed` 同步守卫 | **通道 A**（HMR 场景）+ **通道 B**（CLI 场景） | 守卫在 in-process 路径上，需 A |
| I | 重启提示（`restart-hint`）/ 启用后生效 | **通道 A** | 本票发现「启用不即时生效」，正是这一组要覆盖的 known-red |
| J | 日志 / 诊断 / 事件目录一致性 | **通道 B** | 能同时拿到浏览器 console 与宿主 stdout（raw/server.out.log） |
| K | UI 驱动专项（选择器稳定性、视口滚动、HMR 后重连） | **通道 B**，A 只做冒烟 | B 的 CDP 已封装 evaluate/click/screenshot，可直接断言 |

一句话：**B 做宽度（大部分场景），A 做深度（in-process / HMR / 重启类），E 待补。**

## 5. 三条安装出口可达性

| 出口 | 形态 | 本票结论 | 证据 |
| --- | --- | --- | --- |
| 出口一 第三方 Desktop | 第三方壳调 `desktopPnpm.runPlugin(参数数组, 范围目录, undefined)` | **不可达（本机无第三方 Desktop 构建）** | 未测；T1 需要先拿到一个第三方 Desktop 安装包 |
| 出口二 官方桌面 in-process | `pluginManager.installBundle(spec, opts)` → `ChangeResult` | **可达（真机成功）** | raw/24-channel-a-install.json、shots/a5：`dsh-prompt@0.4.40` 经 UI 装成功 |
| 出口三 普通 DSH spawn CLI | 普通 dsh 反查 `process.argv[1]` 起 CLI | **可达（真机成功）** | raw/03：隔离 profile 装成功，版本核对 0.4.40 |

注意：`--profile desktop` 在**无载体的普通 dsh** 上必败（官方桌面载体 `D:\DeepseekHarness\resources\runtime\cli\bin\dsh.cmd` 不拒 `desktop`）——出口三的 T1 用例要覆盖这条负例。

## 6. known-red 清单

1. `ELECTRON_RUN_AS_NODE=1` 会让 `DeepSeek Harness.exe` 退化成 Node CLI（bad option 报错）。任何起桌面实例的脚本必须显式清掉。
2. 官方桌面首启「准备可用额度」向导：点「跳过」会先弹「暂时跳过充值?」二次确认，要再点「我知道了」才关得掉（shots/a12 为证）；本票脚本漏了这一步，导致误判为「关不掉」。
3. 插件安装完成后点「立即启用」不即时生效，需重启宿主/app（shots/a6/a11/a12，未验证重启后是否生效）。
4. 集成方更新入口常在设置页视口外（rect.y=-193），点击前必须 `scrollIntoView`。
5. 面板挂载即自查：`check` 会短暂 disabled、文案「正在查询版本信息…」；轮询动作按钮时要先只认真动作，约 18s 后才退到 `copy-diag`，否则会点到「复制诊断」误判。
6. 维护者 desktop profile 的 `package.json` + `pnpm-lock.yaml` 在 19:53:56 被改写，**未归因**（详见 `desktop-profile-before-after.json`）；本票写入都在隔离 home，但 AC 不能声称满足。

## 7. 给 T1 的可复用命令 / 脚本 / 坑

可直接复用的脚本（`selftest/spike/264/`，throwaway）：

```
lib/proc.mjs            Windows 命令行引号、进程树 taskkill、端口占用/释放探测
lib/cdp.mjs             裸 CDP 最小客户端（evaluate / waitFor / click / screenshot）
profile-fingerprint.mjs profile 关键文件 SHA256 + 目录条目指纹（用于「未改动」AC）
channel-b.mjs           通道 B 全流程编排（--run-dir / --workdir / --plugin / --keep）
channel-a.mjs           通道 A 启动 + CDP 连接 + 截图
channel-a-ui.mjs        通道 A 侧栏/插件页/对话框操作
channel-a-install.mjs   通道 A 出口二安装（填 input + 点安装 + 轮询结果）
channel-a-panel.mjs     通道 A 深链尝试（等 [data-dsh-prompt-entry]，当前超时）
```

关键命令（照抄即可）：

```powershell
# 通道 B
$env:DSH_HOME = '<tmp>\home'
& '<dsh.cmd>' --profile s263 --from-default-profile web --dump-config
& '<dsh.cmd>' plugin --profile s263 add dsh-prompt@0.4.40
& '<dsh.cmd>' --profile s263 --port 0 --no-open      # stdout 里解析 http://127.0.0.1:<port>/?token=…
chrome.exe --headless=new --remote-debugging-port=0 --user-data-dir=<tmp>\udd <url>
# 通道 A（注意清变量）
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:DSH_HOME = '<tmpA>\home'
& 'D:\DeepseekHarness\DeepSeek Harness.exe' --user-data-dir=<tmpA>\udd2 --remote-debugging-port=59333
# 连接：GET http://127.0.0.1:59333/json/list → webSocketDebuggerUrl → Runtime.evaluate
```

坑清单（本票亲测）：

1. **用模板字符串生成脚本时，脚本里的反引号会提前结束模板**，后续片段变未标记模板 → `\n` 变真换行、`\s` 变 `s`。写完必须 `node --check`。
2. CSS 属性选择器里的值不要加引号（`.dsh-upd[data-mode=dialog]`），否则 JS 字符串转义容易出错。
3. 点击前校验 rect 在视口内（`scrollIntoView({block:'center'})` + 重新取 rect）。
4. Chrome 用 `--remote-debugging-port=0` + `DevToolsActivePort` 文件拿真实端口，别写死。
5. 收尾必须 `taskkill /T /F` 杀进程树并轮询端口释放，否则下一轮会连到旧实例。
6. 面板动作按钮轮询要带「优先真实动作」的白名单，避免 18s 后点到 `copy-diag`。

## 8. 未达成的 AC

- [x] 至少一条通道完成点击 + 截图（通道 B：raw/09 + shots/b3/b4）
- [x] 另一条通道的可用/不可用有原始证据（通道 A：raw/11、12、22–26 + shots/a*）
- [x] 宿主矩阵决策与三出口可达性（本文第 4、5 节）
- [ ] **维护者 profile 未被改动**：前后对照不一致（package.json / pnpm-lock.yaml 被改写，未归因），**不能声称满足**，已升级给 Lead
- [x] 本票产出不进入产品包发布内容、不改产品代码（diff 只有 docs/ 与 selftest/）
