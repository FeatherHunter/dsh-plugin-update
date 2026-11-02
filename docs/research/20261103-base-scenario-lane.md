# #263 真机快速通道：base `run` 场景与真机 UI driver（2026-11-03）

> 结论摘要：在既有 base 预检通道（self-check / single-instance）之外，本仓现在能把**自写场景**交给
> `dsh-featherhunter-plugin-base@0.1.8` 的 `run` 命令执行：隔离 home 里起一个真 web 宿主（约 4s ready），
> 场景用 `launch` / `custom` / `stop` 组合，配合自备 Playwright driver 用实例 `tokenUrl` 打开**真 UI**、
> 断言后截图并写六字段 sidecar。2026-11-03 01:41 在本机隔离 home 真跑通：verdict=pass / exit 0，
> base run 7095ms、实例 ready 3794ms、截图 104015 字节（1280×900，渲染出插件面板 + 夹具 A 卡），
> run.json 侧车 sha256 复核一致，stop 后实例清理干净。目标是给 T9/T10/T11 的 UI 验证一条「2~6 秒起宿主」的
> 快速通道，而不是每件事都跑 3~8 分钟的官方桌面矩阵。
>
> 调用方式见 [docs/maintainers.md](../maintainers.md) 的「真机快速通道：base `run` 场景（#263）」一节；
> base 接入的来龙去脉见 [20261103-base-real-machine-verification-integration.md](20261103-base-real-machine-verification-integration.md)。

## 1. 目标与边界

要解决的问题：官方桌面的 A–J 场景矩阵是**发布前**证据，单轮 3~8 分钟；T9（#273 日志面板）、T10（#274 UI 全状态）、
T11（#275 全量）需要反复看「真 UI 上这个状态渲染成什么样」。如果每次都用官方桌面，迭代成本不可接受；
如果只跑 jsdom/DOM 单测，又拿不到「真宿主 + 真机渲染」的证据。

所以做一条中间层：**base 的进程/宿主管理 + 本仓自写场景 + 自备 Playwright**。

- 覆盖：真宿主起停、真 UI 打开、页面文本/元素断言、截图与旁注、run.json 四态与证据身份链。
- 不覆盖：官方桌面独有的安装出口、面板桥、日志常驻事件（那些仍走 `selftest/real-machine/` 的 A–J 矩阵）；
  base 的 `install` 命令也仍不接（原因见集成笔记 §1 的 product-version-constant 差异）。
- 不改产品 `src/`：本通道只加工具/场景/文档，不动构建产物与 dist 指纹。

## 2. 交付面

| 路径 | 角色 |
| --- | --- |
| `selftest/real-machine/base-verify/scenario-run.ts` | 场景快速通道编排：隔离 home 复制 → base `run` → 收报告/证据 → 截图 sidecar 校验 → 汇总 |
| `selftest/real-machine/base-verify/web-ui.ts` | 真机 UI driver（可选 Playwright）：`openAuthenticatedPage` / `readBodyText` / `waitForBodyText` / `captureShot` |
| `verify/scenarios/web-ui-smoke.ts` | 证明场景（launch → 真 UI 断言 + 截图 → stop），也可作新场景的模板 |
| `selftest/real-machine/tools/run-base-verify.ts` | 入口扩展：`--scenario <path>` 场景模式；无该参数时保持原预检行为不变 |
| `tests/base-verify-scenario-lane.test.mjs` | hermetic 定向测试（11 例）：参数拼装/四态映射/脱敏/sidecar 校验/滚动判定/早退 summary |

配套小改：`selftest/real-machine/base-verify/runner.ts` 把私有 `classifyExit` 导出为四态映射唯一实现（行为不变）；
`selftest/tooling/node-ambient.d.ts` 补 `node:module`（driver 按目录 `createRequire`）；`verify/tsconfig.json`
允许场景 import 带扩展名的 .ts driver 并纳入 `scenarios/**/*.ts`。

## 3. 设计

### 3.1 一条 run 的固定顺序（scenario-run.ts）

1. **capability 门**：`--version` 第二行必须逐字是 `capability real-machine-verification (schema 1)`；不过则 blocked→unknown/2。
2. **隔离 home**：只把源 `home/profiles/<profile>` 复制到 `<out>/home/profiles/<profile>`，源 home 全程只读；
   然后清掉 `<out>/work|shots|raw`，避免上一轮实例/截图混进本次结论。
3. **base run**：`node <baseCli> run <scenario> --profile <p> --work-root <out>/work --json`，spawn 不走 shell；
   env 注入 `DSH_HOME=<out>/home`、`BASE_UI_SHOTS=<out>/shots`、可选 `DSH_VERIFY_PLAYWRIGHT`。
4. **收证据**：stdout/stderr/invocation 三件进 `raw/base-verify/run/`；有 run.json 时先重算侧车 sha256
   （`captureBaseRunArtifacts`，身份链不一致直接进 fail），再整目录拷贝；实例 `instance.json` 以 **tokenUrl 脱敏副本**留档。
5. **截图校验**：`<out>/shots` 下每张 png 必须同名 .json 且六键齐（看什么/步骤/expected/actual/判定/备注）；
   判定列只认 pass/fail/skip/blocked，备注允许 null。缺一张按 fail 记——截图没有旁注证明不了「看到了什么」。
6. **滚动判定**：证据问题/截图失败/无截图 → fail(1)；命令 fail → fail(1)；命令 undefined/unknown → unknown(2)；否则 pass(0)。
   写 `<out>/base-scenario-summary.json`，所有路径是采集机绝对路径。

### 3.2 tokenUrl 与「authentication required」坑（web-ui.ts）

base 的 `PageHandle` 没有 `goto`；`primitives.page()` 打开的是 origin root，没有 token cookie 握手，
body 是 `dsh web authentication required; reopen the URL printed by dsh web.`。**真 UI 必须从实例记录里的
`record.tokenUrl` 自己 `goto` 一次**。driver 的 `openAuthenticatedPage` 封装了：解析 playwright（`DSH_VERIFY_PLAYWRIGHT`
目录优先、裸包名兜底）→ launch headless chromium → `goto(tokenUrl)` → 轮询 body 非空才交还会话。
解析不到 driver 时返回结构化 blocked（装置缺失，不是产品失败）。

### 3.3 场景怎么拿实例

`launch` 步成功后，custom 步里 `context.instance.record` 就是 instance.json 的完整记录（pid/port/tokenUrl/
originUrl/readyMs/stdoutPath/...）。证明场景同时验证了：body 非空且不含未认证标记、body 出现「插件」入口、
截图非空且 sidecar 可被独立校验。

## 4. 真机跑通记录（2026-11-03 01:41，隔离 home）

命令（在 `D:/dsh-plugin/_wt263/lane`，证据在仓库外 `D:/dsh-plugin/_wt263/runtime/base-lane-proof`）：

```powershell
$env:DSH_VERIFY_PLAYWRIGHT='D:/dsh-plugin/dsh-mattpocock-skills-deck/node_modules/playwright'
node selftest/real-machine/tools/run-base-verify.ts `
  --home D:/dsh-plugin/_wt263/runtime/base-verify-integration/source-home `
  --profile web --out D:/dsh-plugin/_wt263/runtime/base-lane-proof `
  --scenario verify/scenarios/web-ui-smoke.ts --json
```

观测（全部来自本次报告）：

| 项 | 值 |
| --- | --- |
| verdict / exitCode | pass / 0 |
| base 版本 | 0.1.8（capability 行逐字匹配） |
| Node | v24.19.0 |
| base run 命令耗时 | 7095ms（runId `run-2026-11-03T01-41-24-330-08-00`） |
| 实例 | id `70e80afa780a70ba`，pid 80564，port 58384，readyMs **3794** |
| run.json 状态 | state=passed，checks pass=5 / fail=0 / skip=0 / blocked=0 |
| run.json sha256 | `2ab75fdf7cd0860a7c8abf723f2aef2199bf357861c77a01066f09f3e4b6d6db`（与 raw 副本侧车复核一致） |
| 场景文件 sha256 | `1dc5f2dc57814ca52f10d511f9a2f379d4a8ec594ab0d7ac505751e5a34da9ff` |
| 截图 | `shots/web-ui-smoke.png`，104015 字节，1280×900；sidecar 六字段，判定 pass |
| 页面事实 | body 604 字：`新会话 … 插件 自动化任务 更多 工作区 暂无会话 … 夹具 A · 更新演示（新版） client v0.0.2 host v0.0.2 dsh-plugin-update-fixture-a 使用范围 webprofile 已是最新…` |
| 清理 | launch→ready 后 stop 步报 `stopped 1 instance(s)`；`stopped.json` 已落，无残留 |

三条 UI 断言（run.json checks 原文）：`ui-auth-gate`（未认证标记=false）、`ui-plugin-panel`（26ms 内出现「插件」）、
`ui-shot-sidecar`（png 104015 字节）。截图可见真 UI 的插件面板与夹具 A 卡「已是最新，无需更新」——
这就是「快速通道确实在看真界面」的直接证据。

## 5. 能证明什么 / 不能证明什么

能证明：

- 隔离 home 上能起真 web 宿主，实例记录、tokenUrl 握手、页面渲染、截图、宿主停止整条链路可用；
- 场景返回的每条 observation 会变成 run.json 的 check（id/status/detail/expected/actual 同构），可被独立复核；
- run.json 侧车 sha256 与拷贝后的证据一致；tokenUrl 在证据副本里已脱敏；
- 一次 UI 证据的墙钟成本：宿主 ready 约 4s、整条 run 约 7s（含 launch/断言/截图/stop）。

不能证明：

- 不替代 `selftest/evidence/runs/` 的正式证据账本（本通道证据在仓库外，不自动入账；正式 A–J + K 仍走官方桌面矩阵）；
- 不覆盖官方桌面独有行为（in-process 插件管理器、面板桥、update.exec 路由等）；
- 不验证「用户真实 `~/.dsh`」：所有写入都在隔离 home，源 home 只读复制；
- 截图只证明首屏渲染与文本存在，不包含交互点击后的状态（需要时在场景里继续加步骤，仍走同一套 sidecar 校验）。

## 6. 与 T9 / T10 / T11 的关系

- **T9（#273 日志面板）**：用该通道起 web 宿主，注入/触发日志事件后打开面板，断言行内容并截图；比官方桌面快一个量级。
- **T10（#274 UI 全状态）**：每个状态一条场景或一条场景内多步，截图 + sidecar 即「状态长什么样」的证据；
  `web-ui-smoke.ts` 可作模板。
- **T11（#275 全量）**：正式账本仍由官方桌面矩阵出；本通道适合预检/回归/挑红点，不改变门三签署口径。

## 7. 踩坑与差异记录

1. **base PageHandle 没有 goto**：照 spike 的 `location.href` 会在 origin root 停下并显示 authentication required；
   正确做法是用 `instance.record.tokenUrl` 自己 `newPage().goto()`（本仓 driver 已封装）。
2. **注释里的 `*/` 会提前结束块注释**：写「<workRoot>/instances/*/instance.json」时 `*/` 触发 TS1005，
   Node 侧报 `ERR_INVALID_TYPESCRIPT_SYNTAX`。路径通配尽量改成文字描述。
3. **模板字符串里的 `\\n`**：往文件写 `lines.join('\\n')` 时若少一层转义，落盘会变成真实换行导致语法错误；
   本仓工具文件已修正（证据里不需要这种诊断噪声，记一笔防再犯）。
4. **校验器是 async**：`validateShotSidecars` 读文件，测试必须 `await`；同步 helper 里包 async 回调会让 finally 早于
   回调结束执行（临时目录先被删）。测试用 async `withTempDir`。
5. **base 报告没有 reportSha256**：`--json` 报告只有 artifacts 指针；sha256 在 `run.json.sha256` 侧车与拷贝回执里，
   汇总工具以 `captureBaseRunArtifacts` 的返回值为准。
6. **只复制 profiles/<profile> 就够**：base 在隔离 home 上 launch 只需 profile 目录；不复制 home 级文件，
   避免把真实 home 的状态带进证据。
7. **playwright 是可选装置**：解析顺序 `DSH_VERIFY_PLAYWRIGHT` 目录 → 裸包名；都没有时场景判 blocked，
   run 的退出码是 2（unknown），不是产品红。

## 8. 复跑清单

1. 确认 `node_modules/dsh-featherhunter-plugin-base/dist/real-machine-verification/cli/main.js --version` 输出
   0.1.8 + capability 行（npm ci 后默认满足）。
2. 源 home 必须含 `profiles/web` 且已装本插件（可用 `D:/dsh-plugin/_wt263/runtime/base-verify-integration/source-home`，只读）。
3. 指向本机 playwright：`DSH_VERIFY_PLAYWRIGHT=<...>/node_modules/playwright`。
4. 跑 §4 的命令；看 `<out>/base-scenario-summary.json` 的 verdict/exitCode、`shots/` 的 png+sidecar、
   `raw/base-verify/run/run.json` 的 checks 与 sha256 侧车。
5. 复跑前确认没有残留宿主进程（stop 步正常时会自己收；异常时看 summary 的 instance pid/port 再清理）。

## 9. 残余风险

- **环境耦合**：base 0.1.8 的 run 命令面与 instance 记录字段是外部契约，base 升级可能改形状；适配层已在
  `types.ts` / `scenario-run.ts` 集中解析，升级时先跑定向测试与一次真机证明。
- **截图稳定性**：首屏渲染有动画/懒加载，恰好截到半渲染的概率低但非零；sidecar 的 actual 记录截图时的 body 文本，
  复核时能看出是否截早了。
- **证明场景依赖本机装置**（playwright 路径、已装宿主），所以只作为开发期快速通道，不是 CI 必跑门禁；
  `npm test` 里只有 hermetic 纯函数测试。
