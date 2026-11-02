# #263 真机验证集成：base `dsh-verify` 调研与实施笔记（2026-11-03）

> 结论摘要：本仓用**已发布 npm 包** `dsh-featherhunter-plugin-base@0.1.8` 的 real-machine-verification 能力做「真机预检」，
> 不复制它的源码，只做两件事：写一份本仓事实声明（`verify/profile.ts`）+ 一层可复用的黑盒适配层
> （`selftest/real-machine/base-verify/`，含 capability 门、typed runner、四态映射、证据身份链拷贝、纯 TS tgz 解包、预检编排）。
> 2026-11-03 01:02 在本机隔离 home 真跑通：self-check 5 pass / 3 skip / exit 0；single-instance 3 pass / 1 blocked（logs-readable）/
> exit 2，其中 instance-pages 经可选 playwright 适配器真渲染成功；teardown 0 残留。**blocked 映射成 unknown，不算通过**。
>
> 本文是「为什么这么接 + 能证明什么/不能证明什么 + 踩坑」的记录；调用方式见 [docs/maintainers.md](../maintainers.md) 的
> 「真机验证（base dsh-verify）预检」一节。

## 1. 为什么接 base，而不是自研一套

-T11（#275）门三是「真机签署门」：维护者要看真机证据才能签。[selftest-release-standard](20261101-selftest-release-standard.md)
  已经定下门三的形态（canary 预发布 → 六元组证据 → 人签 → promote），本仓的 A–J + K 场景矩阵负责业务覆盖，
  **但「候选包装得上、宿主起得来、页面渲染得出、单实例能收干净」这层环境事实，缺一个独立于本仓场景代码的复核者**。
- base 提供的正是这层：15 个命令（describe/self-check/launch/stop/isolation/model/install/skills/single-instance/concurrent/freeze/batch/evidence/run/cleanup），
  每条检查都是「pass / fail / skip / blocked」四态，blocked 表示前置缺失、本次什么都没证明——与本仓
  [证据格式契约](../../selftest/evidence/README.md)的四态语义天然对齐（blocked → 本仓 unknown，永不算 pass）。
- 它是**发布在 npm 上的独立包**（不是本仓源码），所以复用它的检查口径不需要把验证逻辑复制进本仓；
  代价是必须把「同名假包」风险挡在门外（见 §6 capability 门）。
- 不接它的 `install` 命令：base 的 install 带一条 **package-version-constant** 检查（要求 client entry 内嵌 `name@version` 常量），
  那是 base 自家插件的构建约定，本仓构建不满足，而且**不能为了它改本仓构建**（会改 dist 指纹、波及已入库的真机证据）。
  所以安装候选改成预检工具里的纯 TS extract（§3.4），并在 §7 记录这个差异。**不动产品构建**是硬约束。

## 2. 交付面（改了哪些文件、各自负责什么）

| 路径 | 角色 | 说明 |
| --- | --- | --- |
| `package.json` / `package-lock.json` | 依赖与脚本 | devDependency `dsh-featherhunter-plugin-base: 0.1.8`（**精确版本，不写 `^`**）；新增 `verify` / `verify:json` 两条脚本（只跑 self-check） |
| `verify/profile.ts` | 本仓事实声明 | 用包的 `defineVerificationProfile` 声明 id/packageName/defaultProfile/clientEntry/model/bundledSkills/workspaceBackends/browser；**只写本仓真实成立的事实** |
| `verify/browser.mjs` | 可选浏览器适配器 | base 的 BrowserProbeFactory 契约（`launch({headless}) → {ok,value:{newPage,close}}`）；playwright 只在运行时解析，**不进本仓依赖** |
| `verify/tsconfig.json` | 声明自检 | root tsconfig 不覆盖 `verify/`，这里单独 typecheck（`npx tsc -p verify/tsconfig.json`） |
| `selftest/real-machine/base-verify/types.ts` | 类型 | 四态 verdict、blockedReason、报告/命令记录、检查 tally |
| `selftest/real-machine/base-verify/capability.ts` | capability 门 | 跑 `node <pkg>/dist/real-machine-verification/cli/main.js --version`，**第二行必须逐字等于** `capability real-machine-verification (schema 1)`，否则 blocked（防 npm 上无关同名包 `dsh-verify@0.9.6`） |
| `selftest/real-machine/base-verify/runner.ts` | typed runner | `describe --json` 解析命令表/schemaVersion；spawn（args 数组、不用 shell）跑命令，带超时与 stdout/stderr/exit 捕获；把 base 的 exit 0/1/2 映射成本仓四态 |
| `selftest/real-machine/base-verify/artifacts.ts` | 证据身份链 | 把 base 的 run 目录（run.json + run.json.sha256 + evidence/）拷进调用方证据目录；**拷前用 sidecar 重算 sha256**，不一致按 fail 记 |
| `selftest/real-machine/base-verify/tarball.ts` | 纯 TS gzip+tar 读取器 | ~200 行、无新依赖、不 exec `tar`；校验每块 checksum、拒绝绝对路径/盘符/反斜杠/`..`、根必须是 `package/`、条目数与字节上限 |
| `selftest/real-machine/base-verify/install-tarball.ts` | 候选安装 | 解 tgz 到隔离 profile 的 `node_modules/dsh-plugin-update`，并把 profile `package.json` 的依赖写成 `file:<tgz 绝对路径>`（替代 base install 的 extract 路径） |
| `selftest/real-machine/base-verify/preflight.ts` | 预检编排 | capability 门 → 复制 profile 到自己的隔离 home → 可选装 tgz → self-check → single-instance → 逐命令落证据 → 写 `base-verify-summary.json`；退出码 0/1/2 |
| `selftest/real-machine/tools/run-base-verify.ts` | 预检 CLI | `--home --profile --out [--tarball] [--json]`；T9/T10 快速通道与 T11 门三预检直接调用 |
| `docs/research/20261103-base-real-machine-verification-integration.md` | 本文 | 为什么/怎么接/边界/踩坑 |
| `docs/maintainers.md` | 维护者手册 | 新增「真机验证（base dsh-verify）预检」一节（前置、命令、退出码、证据位置） |

`verify/` **不进 `package.json` 的 `files` 白名单**：它是开发期设施，npm 发布物不含它；`verify/profile.ts` 的自动发现依赖
「在仓根跑 base CLI」（base 的搜索路径是 `verify/profile.ts → .js → .mjs`），预检工具已把 `cwd` 固定为仓库根。
`browser.mjs` 同理只存在于开发工作树。

## 3. 接入方式细节

### 3.1 事实声明 `verify/profile.ts`

```ts
export default defineVerificationProfile({
  id: 'dsh-plugin-update',
  packageName: 'dsh-plugin-update',
  defaultProfile: 'web',
  clientEntry: 'dist/client.js',       // esbuild 产物；装上的包与仓库版本/入口 sha256 可对账
  model: false,
  bundledSkills: false,
  workspaceBackends: [],               // 本包不定义 workspace backend
  browser: { module: 'verify/browser.mjs' },
})
```

**刻意不声明 `pluginCacheDir` / `pluginSettingsDir`**：base 的 `logs-readable` / `isolation` 检查靠这两个字段定位
「插件自己的 cache / 设置目录」。本产品没有这种约定——运行日志由宿主写到 `<DSH_HOME>/logs/<pluginId>/`，
那是**宿主级日志**，不是 profile 内插件 cache 约定；本包也不写 `<userprofile>/.dsh/<dir>/settings.yaml`。
为了「看起来全绿」而声明一个不存在的目录，等于伪造通过；正确做法是让它保持 blocked，并把原因写进文档与报告
（本次 single-instance 的 `logs-readable` 就是这种 blocked：`prerequisite-missing`，原文见 §5）。

### 3.2 可选浏览器适配器 `verify/browser.mjs`

- 契约（base 的浏览器适配器）：默认导出 `{ launch({ headless }) }`，成功返回 `{ ok: true, value: { newPage(), close() } }`；
  `page` 需实现 `url() / pageErrors()`（同步）与 `evaluate() / innerSize() / outerSize() / text() / screenshot() / close()`
  （异步，全部返回 `{ ok, value | error }`）。
- driver 解析顺序：`process.env.DSH_VERIFY_PLAYWRIGHT`（指向只读的 playwright 目录，本机是
  `D:/dsh-plugin/dsh-mattpocock-skills-deck/node_modules/playwright`）→ 裸 `require('playwright')`；
  **两者都没有就返回 `{ok:false, error:{code:'prerequisite', …}}`**——base 只会把 page 检查判 blocked，不会判 fail，更不会伪造 pass。
- playwright **不加入本仓任何依赖**：它只是开发机上可选的观测工具；离线 chromium 可用时 `instance-pages` 能真渲染。

### 3.3 四态映射（base exit code → 本仓 verdict）

| base 结果 | 本仓 verdict | 说明 |
| --- | --- | --- |
| exit 0（报告 state=passed） | `pass` | 允许 skip；skip 的检查在 tally 里如实计数 |
| exit 1（报告 state=failed） | `fail` | SUT 失败证据，不许改写成 known-red |
| exit 2（报告 state=blocked） | `unknown` | **不算通过、也不算 fail**；blockedReason{code,message,hint} 原文保留在 summary/证据里 |
| 超时/起不来/报告不可解析/命令不一致 | `unknown` + `toolError` | 工具错误，同样不算通过 |

没有报告但 exit 0 也按 `unknown` 处理（缺证据不能算 pass）。`describeBase` 负责先取命令表/schemaVersion，
调用方传入未声明的命令时直接按工具错误处理。

### 3.4 证据捕获与身份链

- 每条命令落 `<out>/raw/base-verify/<command>/`：`stdout.json`、`stderr.txt`、`invocation.json`（命令/args/cwd/exit/耗时/verdict/tally/blockedReason）。
- 若 base 报告带 `artifacts.report`：先读同目录 `run.json.sha256`（第一列 64 位小写 hex、第二列必须是 `run.json`），
  **重算 `run.json` 的 sha256 与侧车比对**，再与报告内 `artifacts.reportSha256` 比对；任一不一致 → 这次捕获按 `fail` 记，写明不一致的两侧哈希。
- 校验通过后把整个 run 目录（run.json + run.json.sha256 + evidence/）拷进证据目录，summary 里同时记 `reportPath` 与 `reportSha256`，
  T11 证据账本可以只引用这两个字段就完成「这页证据来自哪次 base run、有没有被改过」的对账。
- 侧车文件本身也随证据一起拷走，复核者可以脱离本仓代码独立重算。

### 3.5 预检 CLI

```powershell
node selftest/real-machine/tools/run-base-verify.ts `
  --home D:/dsh-plugin/_wt263/runtime/base-verify-integration/source-home `
  --profile web `
  --out D:/dsh-plugin/_wt263/runtime/base-verify-integration/run-1 `
  --tarball D:/dsh-plugin/_wt263/runtime/base-verify-integration/pack/dsh-plugin-update-0.18.39.tgz `
  --json
```

- `--home` 是**只读源 home**：工具只 `cp` 它的 `profiles/<profile>` 到 `<out>/home`，之后所有写入都在 `<out>` 下。
- `--tarball` 可选：给了就用纯 TS extract 装进隔离 profile，并把依赖写成 `file:<绝对路径>`；没给则假定隔离 profile 里已有本包。
- 退出码：`0` = 全 pass（skip 允许）；`1` = 有 fail（含身份链不一致）；`2` = blocked/工具错误。不给 `--out` 里已有内容做清理；
  `<out>/home` 每次重建，`<out>/work` 由 base 自己管理 run 目录。
- 预检工具**不跑 `install` 命令**，也不改本仓构建；它只回答「候选装得上、宿主起得来、检查有什么结论」。

## 4. 真机跑通记录（2026-11-03 01:02，隔离 home）

| 项 | 值 |
| --- | --- |
| 工作树 / HEAD | `D:/dsh-plugin/_wt263/tbase`，`impl/263-base-verify` @ `9190365`（integration 后续已到 `04f9f9f`，本分支未 merge） |
| base 包 | `dsh-featherhunter-plugin-base@0.1.8`；capability 门输出 `0.1.8` + `capability real-machine-verification (schema 1)` |
| 候选 tgz | `_wt263/runtime/base-verify-integration/pack/dsh-plugin-update-0.18.39.tgz`，566853 字节，**sha256 `3502f4da6b9116c24b0e67a15a3b8dd96584b24d8a68afbaa273c1681d201efc`**，215 个文件 |
| 隔离 home | `_wt263/runtime/base-verify-integration/run-1/home`（源 home 只读复制 profile；真实 `~/.dsh` 未动） |
| 证据根 | `_wt263/runtime/base-verify-integration/run-1/`（**仓库外**，不进 `selftest/evidence/runs`） |
| self-check | exit 0，**pass 5 / fail 0 / skip 3 / blocked 0**，151ms；`run.json` sha256 `8686b1d982b073f0b68e4294ad5fd56abe6c340b71085e55ac48e90f9e27826e` |
| single-instance | exit 2（blocked），**pass 3 / fail 0 / skip 0 / blocked 1**，7445ms；`run.json` sha256 `22565ec828e7cc648a47e270f34685684cbc211cbda255befc7153a09488ed23` |
| 工具总判定 | `verdict=unknown, exitCode=2`；`base-verify-summary.json` 落 `run-1/` |
| 残留进程 | `teardown-clean`：stopped 1 instance(s); 0 residual process(es)（本会话另用 `Get-CimInstance` 复核，无本 run 留下的 node/web 宿主） |

self-check 逐项（原文摘要）：

- `pass profile-declaration`：loaded ts declaration `D:\dsh-plugin\_wt263\tbase\verify/profile.ts` (export default)
- `pass dsh-runtime`：found DSH at `D:/DeepseekHarness`（只读探测，app.asar 内 desktop-host cli.js）
- `pass node-version`：Node 24.19.0 satisfies the 22.6.0 floor for ts declarations
- `pass profile-present`：profile "web" is present under 隔离 home
- `pass package-installed`：`dsh-plugin-update 0.18.39` installed，clientEntry `dist/client.js` sha256 `1cdb3fba4bff218b4248419f8d221be990b77d9b50d7225205d1a9d48ca5f596`，与仓库版本对账一致
- `skip skills-set / model-configured / model-credential`：本包不随包发技能、不装模型（声明为 false 的如实 skip）

single-instance 逐项（原文摘要）：

- `pass instance-reachable`：instance `97b81a5cf0cfb954` is ready: pid 29996, port 54042, connect HTTP 302, 168/168 enabled plugin entries active
- `blocked logs-readable`（`prerequisite-missing`）："the profile does not declare a plugin cache directory, so the plugin log has no known location"；
  hint："declare pluginCacheDir in the profile declaration, then rerun; without it this check cannot observe the plugin"
- `pass instance-pages`：page at `http://127.0.0.1:54042/?token=…` rendered（innerSize=1280x720 outerSize=1280x720 screen=2194x1234 tolerance=2），no page errors；截图 `evidence/screenshots/instance-pages.png`
- `pass teardown-clean`：stopped 1 instance(s); 0 residual process(es); stopped.json was written for each

**instance-pages 的证据力要打折看**：base 的判据是「页面能导航、能测尺寸、无 page error」，本 run 抓到的 body 文本其实是
`dsh web authentication required; reopen the URL printed by dsh web.`——说明它证明的是「宿主 HTTP 服务起来 + headless 浏览器适配器真能渲染
+ 无 JS 崩」，**不证明 DSH web UI 的交互/状态正确**（那属于 T9/T10 的场景证据）。写报告时不要把这句升级成「面板渲染通过」。

## 5. 能证明什么 / 不能证明什么

**能证明（可作为门三预检与 T9/T10 前置检查引用）：**

1. 本仓 `npm run build` + `npm pack` 的候选 tgz **装得上**：纯 TS extract 后 `node_modules/dsh-plugin-update` 内容完整、版本/入口能被 base 对账。
2. 隔离 `DSH_HOME` 下 **宿主起得来**：instance ready（HTTP 302 + 168/168 enabled plugin entries active），能监听端口、能 teardown 干净。
3. 真机检查表 **四态如实**：pass/fail/skip/blocked 都有 tally 与原文；blocked 的 code/message/hint 保留（本次 logs-readable）。
4. 证据 **身份链可复核**：run.json 侧车 sha256 与实算一致、reportSha256 与报告自述一致，证据整目录拷贝后仍可独立重算。
5. capability 门**挡假包**：npm 上同名无关的 `dsh-verify@0.9.6` 不可能蒙混过关（它没有这条 capability 行）。

**不能证明（必须留给 T11 门三的其他证据，或在报告里显式标注）：**

1. **不覆盖 A–J + K 的业务场景**：更新/批量/日志/UI 状态矩阵仍以 `selftest/real-machine/scenarios` + T9/T10 的截图证据为准；base 预检只是环境与装包事实的复核。
2. `logs-readable` 是 blocked 不是 pass：本产品日志落 `<DSH_HOME>/logs/<pluginId>/` 属宿主级日志，profile 没有「插件 cache 目录」可声明；
   要让这条变成 pass，需要产品侧新增 profile cache 约定——**那是产品决策，不是适配层能伪造的**。
3. `instance-pages` 只证明「页面渲染 + 无 page error」，不证明 UI 功能（本次还碰到 auth-required 文案，见 §4）。
4. 不证明 npm registry 发布正确性（那是 canary/发布后校验的事），也不证明官方桌面通道（A）的行为——本 run 是普通 DSH web 通道（B）。
5. 一次只跑一个实例：`single-instance` 会起 ~300MB 的 headless 宿主，并发跑会互相抢端口/内存，预检工具不提供并发编排。
6. 不替代 `npm run check` 与定向 node --test：那是根门禁，base 预检是**额外一层**。

## 6. 与 T11 门三 / T9·T10 快速通道的关系

- **T11（#275）门三预检**：正式证据轮开始前，用本工具在**候选 tgz** 上跑一遍 self-check + single-instance，
  把 `base-verify-summary.json` 与 `raw/base-verify/*/` 作为「环境前置已复核」的证据附在门三证据包里。
  门三签署仍然需要 A–J + K 的真机场景证据与维护者人签；base 预检**不能替代**场景证据，只是把「装不上/起不来/身份链断了」这类
  环境性失败提前暴露成 blocked/fail，避免把环境噪声写进业务场景的 unknown。
  - 建议口径：门三包里引用 `raw/base-verify/self-check/run.json` 与 `.../single-instance/run.json` 及其 sha256；
    `logs-readable` 的 blocked 原文照抄进 known-red/说明（这是声明缺口，不是 bug）。
- **T9/T10 快速通道**：拿到候选包后先跑本工具（尤其 `--tarball` 路径）→ exit 0 才说明「装得上、起得来」，
  再开始写/跑 UI 与日志场景；exit 2 时先修环境（DSH 安装、profile、playwright、DSH_HOME 隔离），不要先把场景失败当产品 BUG。
- **日常自检**：仓根 `npm run verify` / `npm run verify:json` 只跑 self-check（不写隔离 home 的做法由 base 自己的只读检查保证；
  需要起宿主的 single-instance 请走预检工具，别在真实 home 上跑）。

## 7. 踩坑与差异记录

1. **base 的 `install` 不适用于本仓**：`package-version-constant` 要求构建产物内嵌 `name@version` 常量（base 自家插件约定）。
   本仓 esbuild 产物没有这个常量 → install 判 fail。**不修产品构建**（改 dist 会改指纹、波及已入库证据）；
   预检工具用自写 gzip+tar 读取器解包 + 写 `file:` 依赖，和 base 的 `--method extract` 等价但不跑那条检查。
   报告里要写明「安装路径=自写 extract，绕过 base install 的 package-version-constant」。
2. **npm 同名假包**：`npx dsh-verify` 会解析到无关包 `dsh-verify@0.9.6`。本仓**禁止裸 npx**，一律
   `node <repo>/node_modules/dsh-featherhunter-plugin-base/dist/real-machine-verification/cli/main.js …`；
   预检工具在第一步跑 capability 门，第二行不匹配就 blocked。
3. **声明自动发现依赖 cwd**：base 只在 cwd 下找 `verify/profile.ts|js|mjs`；预检工具固定 `cwd = repoRoot`，
   手工调用 base CLI 时也要在仓根跑，否则 `profile-declaration` 会 blocked。
4. **Node 版本**：ts 声明要求 Node ≥ 22.6（本机 24.19）。低于下限时 base 会 blocked 而不是 fail。
5. **playwright 是可选观测工具**：不装依赖、不进发布物；`DSH_VERIFY_PLAYWRIGHT` 指向只读路径，不可用时 page 检查 blocked——
   **blocked 不是产品失败**，不要为了绿去伪造 adapter 结果。
6. **单实例与资源**：`single-instance` 起 ~300MB headless web 宿主、6 秒级；一次只起一个，跑完确认 `teardown-clean` 与无残留进程；
   与官方桌面/别的会话宿主并存时先看内存再跑。
7. **证据放仓库外**：本任务的 run 目录在 `_wt263/runtime/base-verify-integration/`，不进 `selftest/evidence/runs/`（那是正式证据账本，
   由 T11 统一收口）。工具默认不写仓库内任何路径。
8. **profile 复制而不是共享**：预检工具只 `cp` 源 home 的 `profiles/<name>`，之后所有写入都在 `<out>/home`；真实 home 只读。
9. **agent shell 的 `node --test` 与 `npm run check` 不在本任务范围**：本任务门禁是两套 tsc + build + 定向 node --test；
   全量 `npm run check` 由 Lead 合入后跑。

## 8. 复跑清单

```powershell
cd D:/dsh-plugin/_wt263/tbase
npm ci                                   # devDependency 就位（0.1.8 已在 npm cache）
npx tsc -p selftest/tsconfig.json --noEmit
npx tsc -p selftest/tsconfig.tooling.json
npx tsc -p verify/tsconfig.json
npm run build
npm pack --pack-destination D:/dsh-plugin/_wt263/runtime/base-verify-integration/pack
node selftest/real-machine/tools/run-base-verify.ts `
  --home <隔离源 home> --profile web `
  --out <证据目录> --tarball <tgz 绝对路径> --json
```

## 9. 残余风险

- base 0.1.8 是本仓 devDependency 的**外部契约**：它升级（schema 2、命令表变化、检查 id 改名）需要同步适配层；
  capability 门只挡「不是它」，挡不住「是它但换了 schema」——`describe --json` 的 schemaVersion/命令表校验是第二道，遇到变化按 blocked 处理并升票。
- instance-pages 依赖本机 playwright 与离线 chromium；CI/别的机器没有时只会 blocked，不会假绿，但也就少一条环境证据。
- 单实例宿主在极端情况下可能残留（base 判 teardown-clean 但 OS 进程未退）：出现时先杀本 run 的 pid（evidence 里有），再重跑；不要动官方桌面。
- 预检工具写的是 `file:<tgz 绝对路径>` 依赖：tgz 文件移动后该 profile 的依赖会悬空；每次预检建议用新 `--out` 目录。
