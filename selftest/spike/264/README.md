# #264 T0 spike：真机宿主矩阵与 UI 驱动可行性

一次性探索脚本（throwaway）。**结论见 `docs/research/20261101-issue-264-host-matrix.md`，证据见
`selftest/evidence/runs/264-20261101T194628/`。** T1 会把可复用部分重写成正式 harness，这里不追求工程质量。

## 依赖

- Node **≥ 22**（脚本是 `.ts`，用 Node 24 的 type-stripping 直接 `node x.ts` 跑，不编译、不 ts-node）
- 系统 Chrome（通道 B；`C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe`）
- DSH CLI（`D:\\DeepseekHarness\\runtime\\cli\\bin\\dsh.cmd`）
- 官方桌面版（通道 A；`D:\\DeepseekHarness\\DeepSeek Harness.exe`）
- 不需要 `@types/node`：本目录自带 `node-shims.d.ts` 宽形状声明；类型口径见 `tsconfig.json`（`noCheck:true`，只钉语法/模块/扩展名，行为靠真机验证）

## 脚本

| 文件 | 用途 |
| --- | --- |
| `channel-b.ts` | 通道 B 全流程：临时 DSH_HOME/profile → 装集成方 → 起宿主 → 系统 Chrome 裸 CDP → 开面板 → 更新入口 → 更新面板 → 点「检查更新」→ 截图 → 清理 |
| `channel-a-deeplink.ts` | 通道 A 深链全流程：隔离第二实例 → 向导两层 → taskkill 自己进程树 → 同 udd/同 home 换端口重启 → 入口 → 面板 →「模板管理」→ 设置页 → 更新入口 → 更新面板 → 点「检查更新」→ 截图 → 清理 |
| `channel-a-wizard.ts` | 通道 A 首启额度向导两层（跳过 →「暂时跳过充值？」→ 我知道了）取证；**复现条件见下方坑 6** |
| `profile-fingerprint.ts` | profile 关键文件 SHA256 + mtime + bytes、`.plugin-manager`/`node_modules` 顶层条目指纹（用于「未改动」AC） |
| `lib/cdp.ts` | 裸 CDP 最小客户端：`connect({cdpPort,timeoutMs,onEvent})` → `evaluate/waitFor/mouseMove/click/screenshot`，`onEvent` 收 console/exception/log 事件 |
| `lib/proc.ts` | Windows 命令行引号、`startLongRunning`/`waitForExit`/`killTree`（taskkill /T /F）、端口占用/释放探测 |
| `channel-a.ts` / `channel-a-ui.ts` / `channel-a-install.ts` / `channel-a-panel.ts` | 探索期小工具（连 CDP、按文本点按钮、装插件、开面板），保留作参考 |

每个 `channel-*.ts` 都是**独立入口**，用 `--run-dir` 指定证据目录；每一步写 `raw/NN-slug.json`，收尾写 `raw/98*-result.json`、`raw/99-cleanup.json`，截图写 `shots/`（每张 png 配同名 `.json` 四段判定：看什么 / expected / actual / 判定）。

## 通道 B（主通道，10 步全绿）

```powershell
cd selftest/spike/264
node channel-b.ts --run-dir D:\tmp\run264 --workdir D:\tmp\t0-264 --plugin dsh-prompt@0.4.40
```

- `--run-dir` 证据目录（必需，不存在会建）；`--workdir` 隔离 DSH_HOME/Chrome user-data-dir 的父目录；`--plugin` 要装的集成方（默认 `dsh-prompt@0.4.40`）；`--keep` 保留临时目录。
- 全部真实命令：`dsh --profile s263 --from-default-profile web --dump-config` → `dsh plugin --profile s263 add <plugin>` → `dsh --profile s263 --port 0 --no-open`（stdout 解析 `http://127.0.0.1:<port>/?token=…`）→ `chrome.exe --headless=new --remote-debugging-port=0 --user-data-dir=… <url>`（从 `DevToolsActivePort` 取真实 CDP 端口）。
- 收尾 `taskkill /T /F` 杀宿主与浏览器进程树并轮询端口释放。

## 通道 A 深链（已打通，13 步 PASS）

```powershell
cd selftest/spike/264
node channel-a-deeplink.ts --run-dir D:\tmp\run264 ^
  --home D:\dsh-plugin\_wt263\runtime\t0-264-channelA\home ^
  --user-data-dir D:\dsh-plugin\_wt263\runtime\t0-264-channelA\udd2 ^
  --cdp-port 59344
```

- 默认参数即上面这套（隔离 home + udd2 + 59344）；`--desktop-exe` 换桌面 exe，`--keep` 保留进程（排障用）。
- 脚本内部顺序：preflight → launch → attach → wizard-skip → entry → prompt-panel → settings-page → update-entry → update-entry-click → update-panel → click-check → console → cleanup。
- **重启是脚本自己做的**：`taskkill /PID <rootPid> /T /F` 杀自己那条隔离实例的进程树 → 同一 `--user-data-dir` + 同一 `DSH_HOME` + 新调试端口重启 → 等页面就绪 → `[data-dsh-prompt-entry]` 出现。绝不能动维护者正在跑的 DSH 进程。
- 深链路径（实测）：入口 `[data-dsh-prompt-entry]` 悬停 → 面板 `[data-dsh-prompt-panel-root]`（按钮：全部/自定义/＋新增/展示预制模板/当前：悬浮触发/**模板管理**/×，**没有「设置」按钮**）→ 点「模板管理」→ 集成方 `goSettings`（`settings.open` + 点侧栏「提示词模板」）→ 设置页头行 `[data-dsh-prompt-update-entry]` → `scrollIntoView({block:'center'})` → 点击 → `.dsh-upd[data-mode=dialog]` → 面板里点「检查更新」→ 截图。

## 通道 A 首启向导取证

```powershell
cd selftest/spike/264
node channel-a-wizard.ts --run-dir D:\tmp\run264 ^
  --home D:\dsh-plugin\_wt263\runtime\t0-264-channelA\home ^
  --user-data-dir D:\dsh-plugin\_wt263\runtime\t0-264-wizard4\udd ^
  --cdp-port 59349
```

- 两层：点「跳过」→ 弹 `[role=dialog]`「暂时跳过充值？」→ 点「我知道了」→ 等向导消失；截 a30（额度页）/a31（二次确认）/a32（关掉后会话页）。
- **复现条件**（坑 6）：onboarding 可见 = `!done && signedIn && !unavailable`；必须用已 signed-in 的隔离 home，并把 `profiles/desktop/cordis.patch.yml` 的 `ui-settings-account` 置 `step: credit`、`completion: null`，配全新 `--user-data-dir`。跑完 app 会自己写回 `step: done / completion: skipped`（属正常）。

## profile 指纹

```powershell
cd selftest/spike/264
node profile-fingerprint.ts "C:\Users\<user>\.dsh\profiles\desktop" D:\tmp\profile.json
```

## 坑清单（亲测）

1. **用模板字符串生成脚本时，脚本里的反引号会提前结束模板**，写完必须 `node --check`（TS 用 `npx tsc -p tsconfig.json --noEmit`）。
2. CSS 属性选择器里的值不加引号：`.dsh-upd[data-mode=dialog]`。
3. 点击前 `scrollIntoView({block:'center'})` + 重新取 rect + `elementFromPoint` 校验命中；更新入口首测常在视口外（rect.y=-152）。
4. 截图**必须在动作之前**，否则图与文件名不符；每张图配同名 json 四段判定。
5. 面板挂载即自查：`check` 会短暂 disabled、文案「正在查询版本信息…」；轮询动作按钮先只认真动作（check/install/toggle-changelog/copy-manual/restart-hint/skip），约 18s 后才允许 fallback 到 copy-diag/close-view。
6. **通道 A 启动三坑**：① `ELECTRON_RUN_AS_NODE=1` 会让 exe 退化成 Node CLI（`bad option: --user-data-dir=...`）→ 必须删；② 继承的 `DSH_HOME/DSH_PROFILE/DSH_PROFILE_DIR/DSH_SESSION_ID/DSH_SHELL/DSH_WEB_URL` 会把实例连回维护者宿主 → 全删后显式设回隔离 home；③ 直连 spawn exe（不经 cmd）才拿得到干净 rootPid，进程树才收得干净。
7. Chrome 用 `--remote-debugging-port=0` + `DevToolsActivePort` 文件取真实端口；桌面实例用显式端口并先探 `/json/version`。
8. 收尾必须 `taskkill /T /F` 杀进程树并轮询端口释放，否则下一轮会连到旧实例。
9. 等应用首屏就绪（`innerText` 不含 `Loading plugins`）再判断/点击，否则会把「插件还没加载」误判成「无向导/无入口」。
10. 「立即启用」不即时生效：需重启宿主/app（重启后入口出现，宿主日志 `app.boot entryCount:8`）。

## 类型口径

`selftest/tsconfig.json` 已 `exclude: ["spike/**"]`；本目录用自己的 `tsconfig.json`（`noCheck:true` + `node-shims.d.ts`），只保证语法/模块/扩展名口径，不追求严格类型：

```powershell
npx tsc -p selftest/spike/264/tsconfig.json --noEmit   # exit 0
npx tsc -p selftest/tsconfig.json --noEmit             # exit 0（既有门禁不受影响）
```
