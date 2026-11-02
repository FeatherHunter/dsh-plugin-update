# 真机证据索引 · i3-topology-compensation

- runId：272-20261103T041348
- 票：#272
- 宿主通道：desktop-official
- 开始/结束：2026-11-02T20:13:48.650Z / 2026-11-02T20:16:04.403Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:\dsh-plugin\_wt263\t8（分支 impl/263-t8，HEAD 43f61497bd3cb94443d392d3cb3166e222163e66）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c24b0e67a15a3b8dd96584b24d8a68afbaa273c1681d201efc
- SUT dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（208 个文件）
- 安装后 dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c2…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1 | **pass** |
| 08-assert | 隔离口径 | 官方桌面实例使用仓库外隔离 home + 独立 --user-data-dir；安装预算压到 4000ms，便于在真机合格时间内制造 remove 超时 | homeDir=D:\dsh-plugin\_wt263\runtime\t8-272\272-20261103T041348\home；userDataDir=D:\dsh-plugin\_wt263\runtime\t8-272\272-20261103T041348\user-data-dir；profile=desktop | homeDir=D:\dsh-plugin\_wt263\runtime\t8-272\272-20261103T041348\home；userDataDir=D:\dsh-plugin\_wt263\runtime\t8-272\272-20261103T041348\user-data-dir；profile=desktop | **pass** |
| 12-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 16-assert | 更新前基版在盘且在册 | CLI 装 dsh-plugin-update-fixture-a@0.0.1 后读磁盘版本与 profile 清单 | 磁盘=0.0.1；dependencies 有该包=0.0.1；bundles 含该包 | 磁盘=0.0.1；dependencies={"dsh-plugin-update-fixture-a":"0.0.1"}；bundles=["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-plugin-update-fixture-a"] | **pass** |
| 18-assert | 变体版本已发布 | 本地 verdaccio 发布 dsh-plugin-update-fixture-a@0.0.2 | dsh-plugin-update-fixture-a@0.0.2 | dsh-plugin-update-fixture-a@0.0.2 | **pass** |
| 21-assert | 主实例面板加载基版 | 等夹具卡片 + 更新面板渲染 | present=true；clientTag=client v0.0.1；hostTag=host v0.0.1 | present=true；clientTag=client v0.0.1；hostTag=host v0.0.1 | **pass** |
| 23-assert | 真 UI 检查更新后安装可点 | 点面板「检查更新」并等版本条到 0.0.2、安装按钮可点 | versions[2]=0.0.2；install.disabled=false | 可安装 | **pass** |
| 25-assert | 注入：包内文件被独占锁住（remove 删不掉） | PowerShell 对 D:\dsh-plugin\_wt263\runtime\t8-272\272-20261103T041348\home\profiles\desktop\node_modules\dsh-plugin-update-fixture-a\lib\index.js 持有 FileShare.Read 锁，并用第二个进程 Probe 锁是否真的生效 | marker 写入；独占打开探针 exitCode=3（打不开） | lockPid=66800；exclusiveOpenExitCode=3 | **pass** |
| 38-assert | remove 超时：exec 行 route=desktop-manager / ok=false | 安装窗内 update.install.exec 行的执行出口与结果 | exec 行数>=1；route=desktop-manager；ok=false；exitCode 非 0 | exec=[{"route":"desktop-manager","ok":false,"exitCode":null,"durationMs":13124,"pluginId":"fxa-a","ts":1793650526293}] | **pass** |
| 39-assert | remove 超时：失败行 stage=exec / reason=timeout / code=install-failed | update.install.fail 行里与超时对应的失败点 | 存在 stage=exec、reason=timeout、code=install-failed 的行 | fail=[{"stage":"exec","reason":"timeout","code":"install-failed","ts":1793650526296}] | **pass** |
| 40-assert | remove 超时：台账进入 failed 且 message 带 remove 超时原文 | 读 updates/<pluginId>/<hash>/state.json 的 state 与 message | state=failed；message 含「移除已装包超时」 | state=failed；message=install-failed: 移除已装包超时，未继续安装；目标包可能已不在册，请重启宿主检查并按手工命令重装 (dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=http://127.0.0.1:63133)；无法确认宿主是否把该插件移出了在册名单，也未能恢复在册；若插件页显示关闭，请重新启用 | **pass** |
| 42-assert | 失败人话落在一个已知的补偿档位（三档之一） | 在失败 message 里找三档补偿文案（executor.ts:74-80） | 命中 restored / restore-failed / unverified 之一 | tier=unverified；message="install-failed: 移除已装包超时，未继续安装；目标包可能已不在册，请重启宿主检查并按手工命令重装 (dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=http://127.0.0.1:63133)；无法确认宿主是否把该插件移出了在册名单，也未能恢复在册；若插件页显示关闭，请重新启用" | **pass** |
| 43-assert | 文案与在册事实一致：说「已恢复」就必须真在册 | 把补偿档位与 profile 清单 dsh.profile.bundles 对照：restored 档必须包含该包 | tier=restored 时 bundles 含 dsh-plugin-update-fixture-a；tier 非 restored 时不得宣称「本次已恢复在册」 | tier=unverified；registeredAfter=false；bundles=["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"] | **pass** |
| 44-assert | 文案与磁盘事实一致：没装成就不许说已更新 | 失败后磁盘包版本、包目录存在性、清单依赖共同判断是否能被读成「更新成功」 | 磁盘版本 ≠ 0.0.2 或包目录已不存在；且 dependencies 不被写成变体版本作为「已完成」 | diskAfter=null；dependencies=null；packageDirExists=false | **pass** |
| 45-assert | 失败后面板不复述假成功（或面板随插件消失，如实记录） | 若面板仍可达，读横幅/错误文案；若随被移除插件消失则记录不可达 | 面板不可达；或可见文案里没有「已是最新」类假成功 | present=false；banner=null；error=null | **pass** |
| 49-assert | 按人话里的载体命令可重装（文案可操作） | 跑 message 里的 dsh plugin add 命令，等磁盘回到 0.0.2，再读清单 | 命令 exit=0；磁盘=0.0.2；dependencies 含 0.0.2；bundles 含该包 | exit=0；磁盘=0.0.2；dependencies={"dsh-plugin-update-fixture-a":"0.0.2"}；bundles=["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-plugin-update-fixture-a"] | **pass** |
| 51-assert | 收尾清理（进程/端口无残留） | 停掉本 run 起过的桌面/持锁进程后按 pid 复核存活、按端口复核已释放 | 存活 pid 数=0；主实例端口已释放 | alive=[]；ports=[{"label":"desktop-main-port","port":63101,"released":true}] | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 22-shot | panel-old | 安装前官方桌面夹具卡片与更新面板（基版 0.0.1） | 卡片 client/host = 0.0.1 | visible | **pass** | [shots\22-shot.png](shots\22-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [isolation-facts](raw\07-isolation-facts.json)
- [desktop-first-launch](raw\09-desktop-first-launch.json)
- [desktop-stop-bootstrap](raw\10-desktop-stop-bootstrap.json)
- [install-baseline](raw\11-install-baseline.json)
- [sut-installed-dist](raw\13-sut-installed-dist.json)
- [manifest-before](raw\15-manifest-before.json)
- [fixture-published-variant](raw\17-fixture-published-variant.json)
- [desktop-main-launch](raw\19-desktop-main-launch.json)
- [panel-old](raw\20-panel-old.json)
- [file-lock-acquired](raw\24-file-lock-acquired.json)
- [ledger-after-timeout](raw\26-ledger-after-timeout.json)
- [file-lock-release](raw\27-file-lock-release.json)
- [file-lock-released](raw\28-file-lock-released.json)
- [panel-after-remove-timeout](raw\29-panel-after-remove-timeout.json)
- [desktop-stop-main](raw\30-desktop-stop-main.json)
- [plugin-manager-operation-operation-rPXyB8](raw\31-plugin-manager-operation-operation-rPXyB8.json)
- [log-fxa-a-2026-11-03](raw\32-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\33-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\34-log-fxa-c-2026-11-03.json)
- [install-outcome-rows](raw\35-install-outcome-rows.json)
- [disk-after-remove-timeout](raw\36-disk-after-remove-timeout.json)
- [ledger-facts](raw\37-ledger-facts.json)
- [compensation-tier](raw\41-compensation-tier.json)
- [carrier-command](raw\46-carrier-command.json)
- [carrier-command-run](raw\47-carrier-command-run.json)
- [recovery-facts](raw\48-recovery-facts.json)
- [cleanup-verify](raw\50-cleanup-verify.json)

## 清理

- 进程 desktop-bootstrap（pid 76204）：停止后存活=false
- 进程 desktop-bootstrap（pid 76204）：停止后存活=false
- 进程 desktop-main（pid 52896）：停止后存活=false
- 进程 file-lock-i3（pid 66800）：停止后存活=false
- 进程 desktop-main（pid 52896）：停止后存活=false
- 端口 desktop-main-port（63101）：已释放=true
- 端口 registry（63133）：已释放=true
- 本地 registry：http://127.0.0.1:63133（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- i3 口径：remove 步用文件独占锁（PowerShell FileShare.Read 持锁）拖住包内 lib/index.js，产品安装预算 DSH_SELFTEST_INSTALL_TIMEOUT_MS=4000 让 remove 超时；断言重点不是「必须恢复成功」，而是产品文案与磁盘/在册事实一致（说恢复就必须真在册）。
- 失败画面截图不可用（桌面可能已退出）：[i3] 失败画面截图 超时 30000ms
- i3 失败档：探针 probe-i3c 实测落在 unverified 档（remove 超时后无法确认宿主是否把插件移出在册名单，也未能恢复）；本格逐条断言文案↔manifest↔磁盘一致，不是只截一张失败图。

## 备注

- 本地 registry：http://127.0.0.1:63133（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- i3 口径：remove 步用文件独占锁（PowerShell FileShare.Read 持锁）拖住包内 lib/index.js，产品安装预算 DSH_SELFTEST_INSTALL_TIMEOUT_MS=4000 让 remove 超时；断言重点不是「必须恢复成功」，而是产品文案与磁盘/在册事实一致（说恢复就必须真在册）。
- 失败画面截图不可用（桌面可能已退出）：[i3] 失败画面截图 超时 30000ms
- i3 失败档：探针 probe-i3c 实测落在 unverified 档（remove 超时后无法确认宿主是否把插件移出在册名单，也未能恢复）；本格逐条断言文案↔manifest↔磁盘一致，不是只截一张失败图。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
