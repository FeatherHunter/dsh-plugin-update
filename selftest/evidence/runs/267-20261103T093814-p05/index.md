# 真机证据索引 · d2-desktop-manager-update-failure

- runId：267-20261103T093814-p05
- 票：#267
- 宿主通道：desktop-official
- 开始/结束：2026-11-03T01:59:42.730Z / 2026-11-03T02:02:18.777Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:/dsh-plugin/_wt263/t11（分支 impl/263-t11，HEAD bd39b57baa10f3c9f128dfd05f66b286d8828045）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c24b0e67a15a3b8dd96584b24d8a68afbaa273c1681d201efc
- SUT dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（208 个文件）
- 安装后 dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c2…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1 | **pass** |
| 09-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 11-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 13-assert | 旧版面板（重启后） | 官方桌面里 A 的更新面板显示：运行版/已安装 0.0.1、夹具卡片 client v0.0.1 | 运行版=已安装=0.0.1；client 构建标记=client v0.0.1 | versions=[0.0.1, 0.0.1, 未知]；clientTag=client v0.0.1；seal=已是最新 | **pass** |
| 17-assert | 发布变体版（可见变化） | 同一包名发布 0.0.2；新版 client bundle 与 host half 的内容哈希都和 0.0.1 不同 | client 与 host 的 sha256 都变；registry 可见 0.0.2 | client 862d65572817→2703eb98d64c；host bc5a002cfb4b→dfd2abbb77c0 | **pass** |
| 19-assert | 变体版在 registry 可见 | 本地 registry 的 A 元数据包含基版与变体版（更新系统查到的 latest 就是它） | versions 含 0.0.1、0.0.2 | versions=[0.0.1, 0.0.2]；dist-tags={"latest":"0.0.2"} | **pass** |
| 21-assert | 真 UI 检查更新 | 点面板「检查更新」后，最新版变成 0.0.2，安装按钮可用（数据来自面板 DOM 快照） | 最新版=0.0.2；安装更新按钮 enabled | versions=[0.0.1, 0.0.1, 0.0.2]；install={"text":"安装版本 0.0.2","disabled":false}；seal=可更新 | **pass** |
| 24-assert | 失败格故障注入 B（删 tarball、保元数据） | check 已经看到 0.0.2；随后把该版本的 tarball 从 registry storage 删掉（元数据与 integrity 一字不改）：安装前的候选门能过，pnpm 下载 tarball 时 404 非零退出 | 删前 GET tarball=200 且字节>0；删后=404；元数据版本文档一字不差；依赖 dsh-log@0.3.4 tarball 预热=200（避免依赖下载失败掩盖根因） | warm={"url":"http://127.0.0.1:57230/dsh-log/-/dsh-log-0.3.4.tgz","status":200,"bytes":161707}；删前=200/92559B；删后=404；版本文档不变=true | **pass** |
| 26-assert | 出口二失败：安装失败后的面板可达性（诚实记录） | remove→install 的移除步把「更新面板的提供者」（就是被更新的夹具自己）一起摘掉：面板仍挂载时收失败横幅；面板随提供者消失时页面回到桌面 home，把 present/pageText 原文与台账 failed 状态一并记下，不用伪造 DOM/截图顶替 | 面板仍挂载（present=true）→ banner 含「更新失败」且 error 含 install-failed；面板随目标包被移除（present=false）→ 页面回到桌面 home 且台账 state=failed | panelPresent=false；error=null；banner=null；panelReadError=null；ledger.state=failed | **pass** |
| 30-assert | 出口二失败：exec 日志（route/ok/exitCode） | 产品日志 update.install.exec 记录本次安装走的是官方桌面插件管理器（route=desktop-manager），且以非零退出收场（ok=false、exitCode 是真实退码，不是 null） | route=desktop-manager；ok=false；exitCode 为整数 | {"route":"desktop-manager","ok":false,"exitCode":1,"durationMs":2537,"pluginId":"fxa-a","traceId":"66bd3476a47d42a6","spanId":"6eaa0169","seq":4} | **pass** |
| 31-assert | 出口二失败：失败八格（stage/reason/code/exitCode） | update.install.fail 行把宿主侧失败收成稳定分类：stage=exec、reason=nonzero-exit、code=install-failed、exitCode=真实退码；宿主码只以 hostCodeHash 出现 | stage=exec；reason=nonzero-exit；code=install-failed；exitCode 为整数 | {"stage":"exec","reason":"nonzero-exit","code":"install-failed","hostCodeHash":"none","check":"none","exitCode":1,"observedVersion":null,"intentHash":"45b12047","traceId":"66bd3476a47d42a6","spanId":"6eaa0169","seq":6} | **pass** |
| 34-assert | 出口二失败：operation 日志（移除成功 + 重装失败两步都真的跑了） | 管理器窗口内至少两个非空 operation：一个 pnpm.log 命中「- dsh-plugin-update-fixture-a 0.0.1」证明移除步真的跑了；另一个含 ERR_PNPM/404 证明重装步是 pnpm 真失败（不是产品凭空报的） | 非空 operation≥2；含移除旧版的行；含 pnpm 404 错误 | count=2；nonEmpty=2；order=remove-only；各 op=[{"dir":"operation-efPXJN","empty":false,"removed":[{"name":"dsh-plugin-update-fixture-a","version":"0.0.1"}],"added":[],"hasFetch404":false},{"dir":"operation-a0VwIc","empty":false,"removed":[],"added":[],"hasFetch404":true}] | **pass** |
| 36-assert | 出口二失败：诚实人话格（移除事实 + 可执行命令 + 原话） | 宿主说包已被移除、重装失败时，人话格必须点明「目标包已被宿主移除」并给出能直接执行的重装命令；前半段保留 pnpm 原话（registry 下载失败） | job.message 以 install-failed 开头；含 pnpm 原话（ERR_PNPM/404/No matching version）；含「目标包已被宿主移除」；含 dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-a@0.0.2 | install-failed: Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt): [ERR_P；目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制手工命令重新安装 (dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=http://127.0.0.1:57230) | **pass** |
| 38-assert | 出口二失败：磁盘不许出现虚假成功 | 重装失败后磁盘上不许是 0.0.2：移除步已把旧版摘掉，失败要如实反映在磁盘（版本为空或不是目标版） | node_modules 包版本 ≠ 0.0.2；dependencies[dsh-plugin-update-fixture-a] ≠ 0.0.2 | node_modules 版本=null；dependencies=null | **pass** |
| 40-assert | 恢复 registry tarball（为执行人话格命令） | 把备份的 0.0.2 tarball 放回 verdaccio storage，让失败人话格里给出的重装命令能真跑（恢复后同一 URL 重新 200，元数据仍不变） | 恢复后 GET tarball=200；元数据版本文档仍不变 | restoredStatus=200；元数据不变=true | **pass** |
| 42-assert | 人话格手工命令真机执行（验收③） | 把失败人话格给出的命令原文切成 argv，用官方桌面 CLI 通道（同一入口）真跑一次：命令可执行、装回 0.0.2、退出码 0 | 命令存在；dsh plugin add --save-exact dsh-plugin-update-fixture-a@0.0.2 退出码=0；磁盘版本=0.0.2 | 命令=dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=http://127.0.0.1:57230；exit=0；磁盘=0.0.2；stdout 摘要=[WARN] The store at C:\Users\辰辰洋洋\AppData\Local\pnpm\store\v11 is not used because packages cannot be hard linked from it into this project. Using the store at D:\.pnpm-store\v11 instead. Set storeDir to choose the store. Progress: resolved 1, reused 0, downloaded 0, added 0 Packages: +3 +++ Packages are hard linked from the content-addressable store to the virtual store.   Content-addressable sto | **pass** |
| 44-assert | 失败格：手工命令后重启桌面（可见变化） | 用失败人话格里的命令装回新版后重启隔离桌面：卡片 client/host 构建标记都变成 v0.0.2，版本条带显示 0.0.2 | client v0.0.2；host v0.0.2；versions 含 0.0.2 | clientTag=client v0.0.2；hostTag=host v0.0.2；versions=[0.0.2, 0.0.2, 未知] | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 14-shot | 旧版面板 | 官方桌面窗口里的 A 面板：版本条带 0.0.1，夹具卡片显示 client v0.0.1 | 运行版=已安装=0.0.1，卡片 client v0.0.1 | versions=[0.0.1, 0.0.1, 未知]；clientTag=client v0.0.1 | **pass** | [shots\14-shot.png](shots\14-shot.png) |
| 22-shot | 检查更新后 | 点击「检查更新」后的面板：最新版显示 0.0.2，出现「安装更新」可用按钮 | 版本条带第三项=0.0.2，安装按钮可用 | versions=[0.0.1, 0.0.1, 0.0.2]；install.disabled=false | **pass** | [shots\22-shot.png](shots\22-shot.png) |
| 45-shot | 手工命令后重启的新版面板 | 执行人话格命令并重启后的面板：卡片 client/host 构建标记都是 v0.0.2 | client v0.0.2 / host v0.0.2 | clientTag=client v0.0.2；hostTag=host v0.0.2 | **pass** | [shots\45-shot.png](shots\45-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [desktop-first-launch](raw\07-desktop-first-launch.json)
- [install-baseline](raw\08-install-baseline.json)
- [sut-installed-dist](raw\10-sut-installed-dist.json)
- [panel-old](raw\12-panel-old.json)
- [failure-variant-injection](raw\15-failure-variant-injection.json)
- [fixture-published-new](raw\16-fixture-published-new.json)
- [registry-metadata-new](raw\18-registry-metadata-new.json)
- [panel-after-check](raw\20-panel-after-check.json)
- [registry-tarball-fault](raw\23-registry-tarball-fault.json)
- [panel-after-failure](raw\25-panel-after-failure.json)
- [log-fxa-a-2026-11-03](raw\27-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\28-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\29-log-fxa-c-2026-11-03.json)
- [plugin-manager-operation-operation-efPXJN](raw\32-plugin-manager-operation-operation-efPXJN.json)
- [plugin-manager-operation-operation-a0VwIc](raw\33-plugin-manager-operation-operation-a0VwIc.json)
- [ledger-state-after-failure](raw\35-ledger-state-after-failure.json)
- [disk-after-failure](raw\37-disk-after-failure.json)
- [registry-tarball-restored](raw\39-registry-tarball-restored.json)
- [manual-command-exec](raw\41-manual-command-exec.json)（命令 dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=http://127.0.0.1:57230 --expose-internals D:\DeepseekHarness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js plugin --profile desktop add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=http://127.0.0.1:57230，exit 0）
- [panel-after-manual](raw\43-panel-after-manual.json)

## 清理

- 进程 desktop-app-bootstrap（pid 70688）：停止后存活=false
- 进程 desktop-app-main（pid 48032）：停止后存活=false
- 进程 desktop-app-restart（pid 89360）：停止后存活=false
- 端口 registry（57230）：已释放=true
- 本地 registry：http://127.0.0.1:57230（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 失败格故障注入 A：变体版 0.0.2 内容带本 run 注入标记（seatLine/hostBehavior 含 stamp），使 tarball integrity 与历史 run 不同、pnpm store 必然 miss；构建标记仍为 v0.0.2
- 失败格故障注入 B：check 后只删 registry storage 里的 0.0.2 tarball（元数据不动），pnpm 重装时 404；备份在 run 内 registry-tarball-backup/，恢复后再执行人话格命令
- 出口二失败格：本场景的被更新夹具 A 自己就是更新面板的提供者，移除步成功后面板随目标包一起消失（present=false，产品行为正确）；失败面不伪造 DOM，硬证据取自台账 state.json 原文，页面文本/读取错误记为原始观测

## 维护者 profile 未污染

- 目录：C:/Users/辰辰洋洋/.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:57230（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 失败格故障注入 A：变体版 0.0.2 内容带本 run 注入标记（seatLine/hostBehavior 含 stamp），使 tarball integrity 与历史 run 不同、pnpm store 必然 miss；构建标记仍为 v0.0.2
- 失败格故障注入 B：check 后只删 registry storage 里的 0.0.2 tarball（元数据不动），pnpm 重装时 404；备份在 run 内 registry-tarball-backup/，恢复后再执行人话格命令
- 出口二失败格：本场景的被更新夹具 A 自己就是更新面板的提供者，移除步成功后面板随目标包一起消失（present=false，产品行为正确）；失败面不伪造 DOM，硬证据取自台账 state.json 原文，页面文本/读取错误记为原始观测

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
