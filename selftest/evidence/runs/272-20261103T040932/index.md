# 真机证据索引 · i2-unregistered-honesty

- runId：272-20261103T040932
- 票：#272
- 宿主通道：dsh-web
- 开始/结束：2026-11-02T20:09:33.110Z / 2026-11-02T20:10:13.149Z
- 总判定：**known-red**（退出码 0）

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
| 08-assert | 隔离口径（通道 B：普通 DSH web 宿主 + 非 desktop profile） | 本格只用普通 DSH web 宿主；官方桌面不参与（P1：dsh web --profile desktop 被拒「managed exclusively by the Electron application」） | homeDir=D:\dsh-plugin\_wt263\runtime\t8-272\272-20261103T040932\os-home\.dsh；profile=t8i2；homeDir=osHomeDir/.dsh | osHomeDir=D:\dsh-plugin\_wt263\runtime\t8-272\272-20261103T040932\os-home；homeDir=D:\dsh-plugin\_wt263\runtime\t8-272\272-20261103T040932\os-home\.dsh；profile=t8i2 | **pass** |
| 10-assert | 建普通 profile（通道 B 宿主的使用范围） | 用官方发行 CLI 在隔离 home 建普通 DSH 使用范围 t8i2 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t8-272\272-20261103T040932\os-home\.dsh\profiles\t8i2 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t8-272\272-20261103T040932\os-home\.dsh\profiles\t8i2 | **pass** |
| 12-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 16-assert | 更新前基版在盘且在册 | 隔离 profile 里装着场景声明的基版 0.0.1；profile 清单按产品口径（bundles 层优先、否则 dependencies）确认在册 | 磁盘=0.0.1；在册=true；清单依赖含该包 | 磁盘=0.0.1；在册=true；dependencies={"dsh-plugin-update-fixture-a":"0.0.1"}；bundles=["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-plugin-update-fixture-a"] | **pass** |
| 18-assert | 变体版本已发布（更新目标） | 本地 verdaccio 发布 dsh-plugin-update-fixture-a@0.0.2 | dsh-plugin-update-fixture-a@0.0.2 | dsh-plugin-update-fixture-a@0.0.2；injected=[] | **pass** |
| 21-assert | 通道 B 宿主能加载夹具并回答 updateStatus（基线快照） | 宿主 boot 后向夹具 bridge 发 updateStatus：运行版/已装版都应是基版 0.0.1 | ok=true；runningVersion=0.0.1；installedVersion=0.0.1 | runningVersion=0.0.1；installedVersion=0.0.1 | **pass** |
| 23-assert | 宿主进程里跑的是基版构建（buildTag 自证） | 夹具 host half 的 buildTag 电话返回编译期烧入的标记；更新前应是基版 | buildTag=host v0.0.1 | buildTag=host v0.0.1 | **pass** |
| 25-assert | 宿主电话入口 updateCheck：发现 0.0.2 可装 | 夹具 bridge 的真实电话 updateCheck 返回快照与候选凭证 checkId | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true；checkId 非空 | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true；checkId="201323b6-fafe-45fa-979d-a40104424c42" | **pass** |
| 27-assert | 安装电话被受理（快照仍是「安装中」，不是终态） | 产品 install() 先 saveJob(installing) 再立即返回快照（src/core/service.ts:1027-1120），所以回包只证明「受理」，终态要轮询 updateStatus/读 verify 行 | ok=true；job.state ∈ {installing, verifying}；runningVersion 仍 0.0.1 | install：ok=true；status=200；error=null；job={"id":"82c4e8e0-688a-405b-a5c0-b48945a9ba4d","state":"installing","targetVersion":"0.0.2","message":null,"requestId":"i2-install-1793650197346"}；installed=0.0.1；running=0.0.1 | **pass** |
| 29-assert | 安装作业走到终态 | 轮询同一宿主的 updateStatus，直到 job.state ∈ 终态集合 | timedOut=false；job.state ∈ 终态 | job.state=completed；samples=8；timedOut=false | **pass** |
| 31-assert | 恰一次真实安装（route=cli-process / ok=true / exit=0） | 日志 update.install.exec 行还原安装窗口 [ts-durationMs, ts]；通道 B 的安装出口是 cli-process | exec 行数=1；route=cli-process；ok=true；exitCode=0；durationMs>0；pluginId=fxa-a | exec=[{"start":1793650197393,"end":1793650199761,"ts":1793650199761,"durationMs":2368,"route":"cli-process","ok":true,"exitCode":0,"pluginId":"fxa-a","source":"fxa-a/2026-11-03.log","line":12}] | **pass** |
| 33-assert | 安装瞬间的真话：verify 行 = restart-required / pendingRestart=true | 产品 service.ts:862-866 在安装验证后落 update.install.verify；进程未重启时应报 restart-required 且 pendingRestart=true（不假称已生效） | 存在 verify 行：result=restart-required；pendingRestart=true | verify 行=[{"ts":1793650199772,"result":"restart-required","pendingRestart":true,"installedVersion":"0.0.2","targetVersion":null,"previousVersion":null,"source":"fxa-a/2026-11-03.log","line":14}] | **pass** |
| 35-assert | 未重启：磁盘已是 0.0.2，但宿主进程仍跑基版（不热换） | 安装完成后不重启，直接读磁盘版本与宿主内 host half 的 buildTag：磁盘应更新，运行标记应仍是基版 | 磁盘=0.0.2；buildTag=host v0.0.1 | 磁盘=0.0.2；buildTag=host v0.0.1 | **pass** |
| 37-assert | 未重启时 updateStatus 的运行版真话（产品真相边界） | 同宿主同进程装完后看 updateStatus：未重启不得宣称运行版已生效；restart-required + blockedReason=pending-restart 才是产品应有真话。completed 且 runningVersion=新版表示产品按磁盘解析了运行版（进程未重启） | 未重启不得宣称 runningVersion=0.0.2：job.state=restart-required 且 blockedReason=pending-restart（产品应有真话） | job.state=completed；blockedReason=null；runningVersion=0.0.2；buildTag=host v0.0.1 | **known-red** |
| 40-assert | 摘掉在册登记（等价注入；原始清单前后入 raw） | 把 dsh-plugin-update-fixture-a 移出 profile 使用范围清单（bundles 口径），模拟用户/宿主把插件移出使用范围；node_modules 磁盘包不动 | 清单在册口径不含该包；磁盘包仍在=0.0.2 | mode=bundles；changed=true；磁盘=0.0.2 | **pass** |
| 44-assert | 摘登记后真重启：夹具确实没加载（「重启也不会加载」不是空话） | 停宿主 → 摘登记 → 同 home/profile 起全新通道 B 宿主 → 向夹具 bridge 发 buildTag 电话；没加载时路由不存在（回包失败/无 buildTag） | 夹具电话不可达（ok=false 或 buildTag=null）；宿主页面仍能起来（正常 boot） | ok=false；buildTag=null；http=405；pageOk=true；pageStatus=303 | **pass** |
| 49-assert | 未加载的原始页面/日志已留档（辅助证据） | 摘登记重启后的宿主页面 HTTP 事实与日志行都进 raw；原始材料在，不用编 actual | 原始页面/日志已取证 | 页面HTTP=303；重启后日志行=0；加载标记行=0 | **pass** |
| 52-assert | 恢复在册登记（等价写回；理由入 raw） | 把 dsh-plugin-update-fixture-a 写回使用范围清单（bundles 口径），依赖版本钉到 0.0.2 | 清单在册口径含该包 | mode=bundles；bundles=["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-plugin-update-fixture-a"]；dependencies={"dsh-plugin-update-fixture-a":"0.0.2"} | **pass** |
| 55-assert | 恢复登记 + 真重启后真正加载 0.0.2（电话/磁盘/清单三面一致） | 写回在册后真重启通道 B 宿主：夹具 buildTag 电话必须回新版，运行版/磁盘/清单三面必须一致 | buildTag=host v0.0.2；磁盘=0.0.2；runningVersion=0.0.2 | buildTag=host v0.0.2；磁盘=0.0.2；runningVersion=0.0.2 | **pass** |
| 57-assert | 恢复后 fresh check：已是最新（canInstall=false） | 重启后的 fresh updateCheck 应报已装=最新=0.0.2、canInstall=false | ok=true；canInstall=false；installedVersion=0.0.2；latestVersion=0.0.2 | ok=true；canInstall=false；installedVersion=0.0.2；latestVersion=0.0.2 | **pass** |
| 59-assert | 台账恰一条成功终态（无重复/丢单） | 读 <home>/updates 下各级 state.json，按目标版本筛成功终态条目 | targetVersion=0.0.2 的成功终态条目恰 1 条；previousVersion=0.0.1 | 条目数=1；[{"requestId":"i2-install-1793650197346","message":null,"id":"82c4e8e0-688a-405b-a5c0-b48945a9ba4d","state":"completed","targetVersion":"0.0.2","previousVersion":"0.0.1"}] | **pass** |
| 62-assert | 收尾清理（进程/端口无残留） | 关掉本 run 起过的全部通道 B 宿主后按 pid 复核存活、按端口复核已释放 | 存活 pid 数=0；使用过的端口全部释放 | alive=[]；ports=[{"label":"cli-host-main-port","port":49490,"released":true},{"label":"cli-host-unregistered-port","port":59033,"released":true},{"label":"cli-host-registered-port","port":56592,"released":true}] | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [isolation-facts](raw\07-isolation-facts.json)
- [profile-create](raw\09-profile-create.json)
- [install-baseline](raw\11-install-baseline.json)
- [sut-installed-dist](raw\13-sut-installed-dist.json)
- [manifest-baseline](raw\15-manifest-baseline.json)
- [fixture-published-variant](raw\17-fixture-published-variant.json)
- [cli-host-launch-main](raw\19-cli-host-launch-main.json)
- [phone-status-baseline](raw\20-phone-status-baseline.json)
- [fixture-build-tag-baseline](raw\22-fixture-build-tag-baseline.json)
- [phone-update-check](raw\24-phone-update-check.json)
- [phone-update-install](raw\26-phone-update-install.json)
- [install-status-timeline](raw\28-install-status-timeline.json)
- [update-install-exec-rows](raw\30-update-install-exec-rows.json)
- [update-install-verify-rows](raw\32-update-install-verify-rows.json)
- [build-tag-after-install-before-restart](raw\34-build-tag-after-install-before-restart.json)
- [pre-restart-terminal-claim](raw\36-pre-restart-terminal-claim.json)
- [cli-host-close-before-unregister](raw\38-cli-host-close-before-unregister.json)
- [manifest-unregister](raw\39-manifest-unregister.json)
- [cli-host-launch-unregistered](raw\41-cli-host-launch-unregistered.json)
- [page-after-unregister-restart](raw\42-page-after-unregister-restart.json)
- [fixture-phone-after-unregister](raw\43-fixture-phone-after-unregister.json)
- [log-fxa-a-2026-11-03](raw\45-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\46-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\47-log-fxa-c-2026-11-03.json)
- [logs-after-unregister-restart](raw\48-logs-after-unregister-restart.json)
- [cli-host-close-before-restore](raw\50-cli-host-close-before-restore.json)
- [manifest-restore](raw\51-manifest-restore.json)
- [cli-host-launch-registered](raw\53-cli-host-launch-registered.json)
- [phone-after-restore-restart](raw\54-phone-after-restore-restart.json)
- [phone-check-after-restore-restart](raw\56-phone-check-after-restore-restart.json)
- [ledger-facts](raw\58-ledger-facts.json)
- [cli-host-close-cleanup](raw\60-cli-host-close-cleanup.json)
- [cleanup-verify](raw\61-cleanup-verify.json)

## 清理

- 进程 cli-host-main（pid 47144）：停止后存活=false
- 进程 cli-host-unregistered（pid 45048）：停止后存活=false
- 进程 cli-host-registered（pid 53652）：停止后存活=false
- 端口 cli-host-main-port（49490）：已释放=true
- 端口 cli-host-unregistered-port（59033）：已释放=true
- 端口 cli-host-registered-port（56592）：已释放=true
- 端口 registry（52830）：已释放=true
- 本地 registry：http://127.0.0.1:52830（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- i2 口径（A-prime）：官方桌面只吃 desktop profile、通道 B 只吃非 desktop profile（P1 探针），二者不能共享同一 profile；本格因此用通道 B 把「真安装 → 未重启真话 → 摘登记后真不加载 → 恢复登记后真加载」整条链跑在真机上。
- i2 结论口径：通道 B 真机把「装完但没重启时运行标记仍是基版 → 摘出使用范围后真重启确实不加载 → 写回后真重启确实加载 0.0.2」整条链跑通；面板「pending-restart + 未登记」两句文案分支不在通道 B 渲染，走 known-red（需集成方注入 ReaderOverrides.runningVersion）。

## 备注

- 本地 registry：http://127.0.0.1:52830（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- i2 口径（A-prime）：官方桌面只吃 desktop profile、通道 B 只吃非 desktop profile（P1 探针），二者不能共享同一 profile；本格因此用通道 B 把「真安装 → 未重启真话 → 摘登记后真不加载 → 恢复登记后真加载」整条链跑在真机上。
- i2 结论口径：通道 B 真机把「装完但没重启时运行标记仍是基版 → 摘出使用范围后真重启确实不加载 → 写回后真重启确实加载 0.0.2」整条链跑通；面板「pending-restart + 未登记」两句文案分支不在通道 B 渲染，走 known-red（需集成方注入 ReaderOverrides.runningVersion）。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
