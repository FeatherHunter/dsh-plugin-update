# #265 / T1：A 演示插件最小夹具骨架 + 官方桌面单包主链（真机）

- 票：#265（T1 实现）；上游已批准原型 #257 A 案、#258 S2 角色方案
- 日期：2026-11-01
- 工作树：`D:/dsh-plugin/_wt263/t1`，分支 `impl/263-t1`，基线 `0b782f4`
- 结论：**主链真机跑通（pass，退出码 0）**；宿主通道 = 官方桌面（通道 A）；can-red 真红并有失败证据；无产品 BUG、无 known-red。

## 1. 一句话结论

按 #258 已批准的 S2 夹具角色 A（批量集成方，`selfKey=a`、`selfOrder=first`、`targets=[a,b,c]`），
在**官方桌面版**（`D:/DeepseekHarness/DeepSeek Harness.exe`，隔离 `DSH_HOME` + 隔离 `--user-data-dir` + CDP）
完成：干净临时 profile 装 A@0.0.1 → 真 UI 面板断言旧版 → 发布 A@0.0.2（client/host/标题可见变化）
→ 真 UI 点「检查更新」→ 真 UI 点「安装更新」→ 官方桌面 **in-process** `removeBundle→installBundle`
→ 重启隔离 app → UI 新版 + 可见变化 + 磁盘/日志/台账三处一致 → 清理（进程/端口/registry）且维护者 profile 指纹不变。

主链证据：`selftest/evidence/runs/265-20261101T215128/`（run.json / index.md / 4 张真机截图 / raw）。
can-red 证据：`selftest/evidence/runs/265-20261101T214716/`（同场景注入 `stale-variant`，预期并实际 fail）。

## 2. 宿主选择（通道 A）与原始证据

**决策：主链用官方桌面（通道 A），不用回退通道 B。** 理由与实测：

1. T0（#264）宿主矩阵已证明通道 A 的隔离第二实例、CDP 连接、插件管理器 UI、出口二安装都能用，只差「更新面板」这一段没走到；
   本票把这一段补齐，就不需要退回通道 B。
2. 官方桌面三件套隔离实测成立：进程命令行含 `--user-data-dir=D:/dsh-plugin/_wt263/runtime/t1-265/<run>/user-data-dir`
   与宿主子进程 `DSH_HOME=<run>/home`；维护者实例（pid 39812 / 17020）全程存活且 profile 指纹前后一致（run.json.maintainerProfile.unchanged=true）。
3. 两个坑各用一次固定做法绕过（不是产品缺陷）：
   - **启动前必须清 `ELECTRON_RUN_AS_NODE`**（DSH 宿主会注入该变量，Electron 会退化成 Node CLI 解析参数）；`desktopLaunchEnv()` 里 `delete`。
   - **首次启动即引导**：先起一次 app 让 `<home>/profiles/desktop` 落地 → 关闭 → 用 CLI `dsh plugin --profile desktop add ...` 把夹具预装进 profile → 再启动 app（躲开「立即启用不即时生效」）。
   - **CDP 必须先开 Page 域**：官方桌面首启不 `Page.enable` 时 `Page.captureScreenshot` 不回包（实测 60s 超时）；`desktop-app.ts` 连接后即 `Page.enable`，`screenshot()` 另有一次重试兜底。
4. **官方桌面更新出口 = in-process 管理器，已用 SUT 自己的日志证明**：夹具宿主半日志
   `update.wire.ready` 的字段 `hostKind="desktop-manager"`，`host.call(fxa-a.updateInstall, ok:true)`；
   `src/host/environment.ts` 的 `detectEnvironmentKind` 在第三方插件上下文里拿到了 `pluginManager.installBundle`，
   即 `removeBundle→installBundle` 两步（#258 §10.3 出口二），**不是 CLI 兜底**。证据：
   `runs/265-20261101T215128/raw/log-fxa-a-2026-11-01.log`、断言 `32-assert`。

## 3. SUT 钉法（被测更新系统 = 当前工作树构建产物）

真机被测的不是 npm 上的 `dsh-plugin-update@0.18.39`，而是本工作树 `npm run build` 的产物：

1. `npm run build`（esbuild 转译 + `tsc --noEmit`）→ `dist/`；
2. `npm pack` 出 `dsh-plugin-update-0.18.39.tgz`（`fixtures/release/sut-pin.ts`，packDir=`<run>/pack`）；
3. 以**同版本号 0.18.39** 发到本 run 的本地 verdaccio；
4. 夹具 `package.json` 的 `dependencies["dsh-plugin-update"]="0.18.39"`，经 `--registry=<本地>` 装进隔离 profile；
   本地 registry 的 `dsh-plugin-update` 规则**不配 `proxy`**（否则同版本会被 npmjs 上游占用、发布回 E409），
   其余包（`dsh-log`、`@deepseek-ai/*`）仍走 npmjs uplink。
5. 装完后核对 `profile/node_modules/dsh-plugin-update/dist` 的**聚合指纹**（208 个文件逐文件 sha256）等于工作树 `dist/`：
   两边都是 `44ffc4bbde2f942dcaf3991a2be602f617814f88271db32b916b40df1cfaabb9`（断言 `09-assert`）。
   run.json 里同时记 `sut.tarballSha256=951c8dbd61a5165e…`、`sut.distDigest`、`sut.installedDistDigest`、`installedDistMatch=true`；
   raw：`runs/265-20261101T215128/raw/02-sut-pin.json`、`08-sut-installed-dist.json`。

## 4. 夹具层设计（selftest/fixtures）

一句话：**身份单源 + 两份模板 + 纯函数生成 + 仓库外发布**；生成产物不提交。

```
selftest/fixtures/
  identity/fixture-slots.ts            # 身份单源：A/B/C 三个 slot（角色/包名/pluginId/prefix/批量接线/版本序列/构建标记）
  templates/package/                   # package.json 三件套模板（manifest / cordis.patch.yml）
  templates/integrator/                # 集成方模板：host half（createMultiHostUpdate）+ client half（entry+panel 挂载）
  templates/target/target-*.ts         # 纯目标 C 模板：host half 空接线 + client 徽标
  generator/fixture-package-plan.ts    # 纯函数：identity×version → 文件清单/manifest/构建步骤
  generator/fixture-package-plan.test.ts # 纯函数单测（node 直跑，51 条断言）
  generator/fixture-package-builder.ts # IO：落盘源文件 + junction 依赖 + esbuild 两条构建 + 产物核对
  release/verdaccio-runtime.ts         # 仓库外 verdaccio 生命周期（config/启动/探活/停止/端口释放）
  release/registry-client.ts           # CouchDB 建号拿 token、npmrc、npm publish、可见性轮询
  release/fixture-publisher.ts         # 发布一个版本（含 can-red staleContentVersion 注入）
  release/sut-pin.ts                   # npm pack + 发 SUT + dist 指纹
  release/local-registry.ts            # 一次 run 的本地 registry（verdaccio+账号+npmrc）
```

- 身份单源（`identity/fixture-slots.ts`）：A = `dsh-plugin-update-fixture-a`，`batch{prefix:'fxa', selfKey:'a', selfOrder:'first', targets:[a,b,c]}`；
  B = 同角色但 `targets:[b,c]`、缺省 selfOrder；C = 纯目标（`batch:null`，无更新接线）。
  B/C 本轮只要求「声明 + 生成能力」（`planFixturePackage` 对三个 slot 都覆盖，单测断言 C 不含更新接线），真机留 T2。
- 模板：host half 是普通 cordis 插件（`inject:['webServer']`，HTTP 桥把 `{phone,args}` 分发给 `createMultiHostUpdate(...).handlers`）；
  client half 用 `window.__ModuleLoader__.load({id,factory})` 形状，`require('dsh-plugin-update/panel')` 与 `/entry` 挂载，
  `ctx.slots.inject('shell.overlay', ...)` 注册卡片；卡片带 `data-build-tag`（client vX）与 host 桥回来的 `host vX`，
  这就是「可见变化」的观测点。
- 生成：`planFixturePackage(slot, version, sut)` 是纯函数（单测 `node selftest/fixtures/generator/fixture-package-plan.test.ts`，
  51 条断言，全过）；`buildFixturePackage` 落盘到 **run 目录仓库外**（`runtime/t1-265/<run>/fixtures/...`）并跑 esbuild。
- esbuild：host half `--bundle --platform=node --format=esm --packages=external`；client half
  `--bundle --platform=browser --format=cjs --external:react --external:react-dom` + loader banner/footer；
  依赖解析用 junction `<fixture>/node_modules/dsh-plugin-update → 工作树根`（`--alias` 对子路径无效）。
- 发布：只发本地 registry（无任何「默认 npmjs」分支）；verdaccio 装在仓库外
  `D:/dsh-plugin/_wt263/runtime/tools/verdaccio`，每个 run 独立 storage；发布后轮询 `/<pkg>` 元数据直到版本可见。

提交物里没有生成产物（`lib/*.js`、`package.json` 夹具包）——它们每次 run 现生成，路径在 run 目录。

## 5. 证据格式契约与本次证据

- 契约：`selftest/evidence/README.md`（run.json schema v1、shots sidecar 四段、raw、index.md、四态判定、退出码 0/1/2、can-red、known-red、与门禁分层）。
- 覆盖矩阵：`selftest/evidence/coverage-matrix.md`（A 行已落；B/C 行标 T2）。
- 本次提交的 run：
  - `selftest/evidence/runs/265-20261101T215128/` —— 主链全绿（13 条断言 + 4 张截图，退出码 0）。
  - `selftest/evidence/runs/265-20261101T214716/` —— can-red 故障注入（预期 fail，退出码 1；失败点 `15-assert`/`26-assert`）。
- 每张截图同名 `.json` 四段：看什么 / 步骤 / expected / actual / 判定；actual 来自同一次 DOM 快照。
- run.json 里 `cleanup`（进程停止后存活=false、CDP/registry 端口已释放）与 `maintainerProfile`（维护者 `C:/Users/<user>/.dsh` 前后指纹一致=true）。

## 6. can-red（证明场景会红）

实现：`--fault stale-variant` —— 发布 0.0.2，但构建内容取自 0.0.1（版本号新、内容旧）。同一场景、同一断言集，
预期结果写进了 raw（`raw/can-red-fault.json`）与 notes。实测结果（run `265-20261101T214716`）：

- `15-assert` fail：client/host 内容哈希没变（`d9db85a1…→d9db85a1…`、`9929c5155…→9929c5155…`）；
- `26-assert`（重启后新版 UI）fail：clientTag/hostTag 仍是 `client v0.0.1`/`host v0.0.1`，标题仍是旧标题；
- 截图 `shots/27-shot`（重启后新版面板）判定 fail；
- 其余断言（SUT 钉版、装旧版、registry 可见、检查更新、安装、磁盘一致、日志、台账、清理、维护者 profile）全部 pass。
  这说明红的是被测断言本身，不是环境坏了。

## 7. 产品 BUG / known-red

- 本场景发现的产品 BUG：**0 条**。主链全部断言首次修复后即通过；没有把任何失败改写成 known-red。
- 观察到的既知行为（不算 BUG，已在场景里规避）：
  1. 官方桌面「立即启用」不即时生效（T0 已记录）→ 采用「先 CLI 预装、再重启 app」。
  2. 面板挂载瞬间版本条带是占位 `…`、卡片 hostTag 是 `host ?`（异步自查）→ 断言前等待真实值（`waitForFixtureLoaded`）。
  3. 批量集成方日志里记的是目标 key/prefix（`fxa-a`），不是包名 → 日志断言按 JSON 事件与目标 key 核对，不按包名子串。

## 8. 门禁结果

```text
npx tsc -p selftest/tsconfig.json --noEmit            # hermetic 层（排除新工具层）
npx tsc -p selftest/tsconfig.tooling.json --noEmit    # 新增真机工具层类型检查
npm run check                                         # typecheck + build + 全量 test + gate:bilingual
node selftest/fixtures/generator/fixture-package-plan.test.ts   # 夹具生成纯函数单测（51 条断言）
node selftest/real-machine/tools/preflight-fixture-install.ts --run-base-dir <runtime 根>   # 假宿主预检（安装链路）
```

- `selftest/tsconfig.json` 只按 #258 批准加了一行 `exclude: ["./fixtures", "./real-machine", "./tooling"]`；
  工具层类型检查用新增 `selftest/tsconfig.tooling.json` + 最小 `selftest/tooling/node-ambient.d.ts`（未引入 `@types/node`、未改 package.json）。
- 真机 run 不进 `npm run check`（#258 分层）；证据包是「门三真机签署」的输入。
- **实测**（2026-11-01，merge integration tip 后）：上表四条全绿。`npx tsc` 两路 exit 0；
  夹具单测 `OK（51 条断言）`；`npm run check` exit 0（typecheck + build + 2083 条测试 + gate:bilingual）。
- **既知抖动（非本票引入）**：`npm run check` 的全量并行测试里 `tests/batch-e2e.test.mjs` 的
  `E3b 执行器真卡死…` 用例在机器高负载、并行度高时偶发失败（失败点分别见过 `restartRequired` 与 `install-failed`）。
  已用**基线 commit `0b782f4` 的独立 checkout** 跑同一全量命令复现（`D:/dsh-plugin/_wt263/runtime/t1-265/base-check/test1.log`），
  证明与 #265 改动无关；同一测试文件单独跑、或全量低并发（`node --test --test-concurrency=2 tests/*.test.mjs`）均 4/4、全绿。
  本票最终 `npm run check` 通过；若 CI 再遇 E3b 抖动，按基线抖动处理，不要归因到夹具层。

## 9. 从零复跑

```powershell
cd D:/dsh-plugin/_wt263/t1
npm run build        # 真机 SUT = 当前构建产物

# 主链（官方桌面通道 A）
node selftest/real-machine/tools/run-a-main-chain.ts `
  --worktree D:/dsh-plugin/_wt263/t1 `
  --run-base-dir D:/dsh-plugin/_wt263/runtime/t1-265 `
  --verdaccio-install-dir D:/dsh-plugin/_wt263/runtime/tools/verdaccio `
  --maintainer-home C:/Users/<维护者>/.dsh

# can-red（同场景注入故障，预期 fail/退出码 1）
node selftest/real-machine/tools/run-a-main-chain.ts `
  --worktree D:/dsh-plugin/_wt263/t1 `
  --run-base-dir D:/dsh-plugin/_wt263/runtime/t1-265 `
  --verdaccio-install-dir D:/dsh-plugin/_wt263/runtime/tools/verdaccio `
  --fault stale-variant
```

前置一次性：`npm ci`；verdaccio bootstrap 到 `D:/dsh-plugin/_wt263/runtime/tools/verdaccio`
（`npm i --prefix <dir> verdaccio@6`，只装一次，所有 run 共用，每个 run 独立 storage/端口）。

## 10. 给 T2 的复用入口

- **跑一个新场景**：`selftest/real-machine/scenarios/<id>.ts` 里组合
  `createRunLayout → EvidenceRecorder → createFixtureEnvironment → publishFixtureVersion → launchDesktopApp →
  installPluginIntoProfile → readPanelState/clickPanelAction → 断言 → recorder.finish()`；
  照抄 `a-single-package-main-chain.ts` 的骨架，把 `publish('a', …)` 换成 `publish('b', …)`/`publish('c', …)`。
- **要改的几处**：场景 id（`EvidenceRecorder`）、`coverage-matrix.md` 加行、`selftest/real-machine/tools/run-<id>.ts` 加 CLI 入口；
  宿主通道不用改（`launchDesktopApp`/`installPluginIntoProfile` 可复用）；run 根目录用同一个 `runtime/t1-265`，端口动态。
- **B/C 真机注意**：B 是批量集成方（`targets=[b,c]`），C 是纯目标；B 的更新面板会出现批量行，
  选择器 .`dsh-upd.dsh-upd-batch`、`[data-act]`、`[data-confirm]` 与单包面板不同（T1-wiring-notes §Q4 有表）。
- **别做的**：不要用 `file:` 安装夹具（会被判 source-install，永久挡更新）；不要坐标点击（用 `el.click()`）；
  `cordis.patch.yml` 顶层必须是 YAML 数组。

## 11. 未做 / 边界

- B/C 两个 slot 的真机 run 留 T2（本票只要求声明+生成能力）。
- 更新安装的「restart-required」分支：本 run 的 in-process 安装把磁盘改成 0.0.2，UI 重启后加载新版；
  若某次返回 restart-required，场景按同一路径重启隔离 app 后断言，逻辑已就位。
- 打包/构建产物不入库；本次证据 PNG 共 4 张/run（约 800KB/run），为可复核性保留原图。
