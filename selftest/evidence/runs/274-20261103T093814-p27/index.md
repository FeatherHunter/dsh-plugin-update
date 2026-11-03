# 真机证据索引 · k-single-panel-failure

- runId：274-20261103T093814-p27
- 票：#274
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T01:46:09.858Z / 2026-11-03T01:47:50.681Z
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
| 10-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 12-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 13-assert | setup-sut | 通道 B profile 里装的 SUT 与工作树构建一致 | installed distDigest === worktree distDigest | true | **pass** |
| 14-assert | setup-base-disk | 基版安装后磁盘版本与声明一致 | {"dsh-plugin-update-fixture-a":"0.0.1"} | dsh-plugin-update-fixture-a=0.0.1 | **pass** |
| 17-assert | k2-01-corrupt-tarball | 只改 registry 上已发布 tarball 的字节（中点起 64 字节 xor），版本元数据与 dist.integrity 一字不动 | versionDocUnchanged=true、sha256Before≠sha256After、改坏前后 tarball URL 都回 200 且响应字节数一致（存储文件字节数只是参考，HTTP 响应可能走压缩/包装） | {"versionDocUnchanged":true,"shaChanged":true,"servedBeforeStatus":200,"servedAfterStatus":200,"servedBeforeBytes":102504,"servedAfterBytes":102504,"sizeBytes":108345} | **pass** |
| 20-assert | k2-02-check-passes | 坏 tarball 不影响检查阶段（check 只读版本文档） | 可更新横幅原文精确匹配 | {"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"} | **pass** |
| 22-assert | k2-03-failure-banner | 失败横幅标题与错误码一致 | 标题以「更新失败（install-failed）」开头、errCode=install-failed | {"title":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者","errCode":"install-failed"} | **pass** |
| 23-assert | k2-04-last-resort | 最后手段条只在「无自动救援 + 命令当帧可信」时出现，原文三字段 | badge=最后手段、status=自动恢复不可用、reason=「没有可用的自动数据路径；复制这条命令是唯一出路。」 | {"present":true,"badge":"最后手段","status":"自动恢复不可用","reason":"没有可用的自动数据路径；复制这条命令是唯一出路。","copyText":"复制手工命令"} | **pass** |
| 24-assert | k2-05-manual-command | 手工备用命令原文（与命令形状对齐、registry 指向本 run） | 标题「手工备用命令（请复制整行执行）：」+ 命令行匹配 dsh plugin --profile t10ui add --save-exact <pkg>@0.0.2 --registry=https://127.0.0.1:<port> | {"heading":"手工备用命令（请复制整行执行）：","code":"dsh plugin --profile t10ui add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=https://127.0.0.1:57142","neutral":""} | **pass** |
| 25-assert | k2-06-entry-failed | 入口随安装失败落到失败档 | state=failed、aria-label「更新失败，请查看详情」 | {"present":true,"variant":"badge","state":"failed","text":"","note":"","ariaLabel":"更新失败，请查看详情","title":"更新失败，请查看详情"} | **pass** |
| 26-assert | k2-07-install-button-failed | 安装按钮切失败档 | kind=failed | failed | **pass** |
| 29-assert | k2-08-exec-failed | 安装执行阶段真的跑了 pnpm 且非零退出（不是 check 阶段失败） | update.install.exec 全部 ok=false（至少 1 条）、无成功 | exec=1 ok=0 exit=[1] | **pass** |
| 30-assert | k2-09-fail-fact | 失败事件的阶段/原因/码/退出码 | update.install.fail 恰 1 条、stage=exec、reason=nonzero-exit、code=install-failed、exitCode≠0 | {"stage":"exec","reason":"nonzero-exit","code":"install-failed","hostCodeHash":"none","check":"none","exitCode":1,"observedVersion":null,"intentHash":"3ca2813b","traceId":"bc6d964330ad969d","spanId":"8271fde4","seq":6} | **pass** |
| 31-assert | k2-10-disk-unchanged | 安装失败后磁盘保持旧版（无半装/假成功） | A 磁盘版本仍 0.0.1 | {"dsh-plugin-update-fixture-a":"0.0.1"} | **pass** |
| 32-assert | k2-11-ledger-failed | 台账逐行真相：失败行目标版本 0.0.2、状态 failed | state=failed、targetVersion=0.0.2 | {"state":"failed","targetVersion":"0.0.2"} | **pass** |
| 34-assert | k2-12-restore | 还原 tarball 字节（恢复后回包 sha 与原始一致、元数据未动） | shaMatches=true、versionDocUnchanged=true | {"restoredStatus":200,"restoredSha256":"dc0bb9bd54dcb2926d9fbe41d12e14b31dde541cc19e9076b40e5ef563d05d09","shaMatches":true,"versionDocUnchanged":true} | **pass** |
| 36-assert | k2-13-manual-exec | 停宿主后照面板给出的手工命令原文执行，exit=0 且磁盘装到 0.0.2 | exitCode=0 且 A 磁盘版本=0.0.2 | {"exitCode":0,"disk":{"dsh-plugin-update-fixture-a":"0.0.2"},"durationMs":1090} | **pass** |
| 39-assert | k2-14-settled-banner | 重启后面板了结（不把已修好的包继续报成当前失败） | 横幅 kind=done 且标题「已是最新，无需更新。」 | {"kind":"done","title":"已是最新，无需更新。","sub":""} | **pass** |
| 40-assert | k2-15-settled-history | 旧失败以中性历史行保留（失败事实仍可追溯） | settled 行含「上次尝试失败（install-failed）」与「0.0.2」 | 上次尝试失败（install-failed）；目标版本 0.0.2 或更新版本正在运行。 | **pass** |
| 41-assert | k2-16-build-tags | 重启后运行 0.0.2 构建 | clientTag=client v0.0.2、hostTag=host v0.0.2 | {"clientTag":"client v0.0.2","hostTag":"host v0.0.2"} | **pass** |
| 42-assert | k2-17-ledger-history | 台账保留失败历史（真相优先；不因手工修复而伪造成功） | state=failed、targetVersion=0.0.2 | {"state":"failed","targetVersion":"0.0.2"} | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 19-shot | k2-10-check-passes | tarball 字节已坏、元数据与完整性摘要未变：检查更新仍给出可更新（可证伪：若 check 读了 tarball 内容，这一格会失败） | 可更新横幅原文「有新版本 0.0.2 可安装（当前版本 0.0.1）。」 | {"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"} | **pass** | [shots\19-shot.png](shots\19-shot.png) |
| 21-shot | k2-20-failure-last-resort | 安装失败：失败横幅 + 最后手段条 + 手工备用命令（当帧可信）+ 入口/安装按钮失败档 | 横幅标题以「更新失败（install-failed）」开头、最后手段三字段原文、手工命令形状 --profile t10ui add --save-exact <pkg>@0.0.2 --registry=<本 run registry>、入口「更新失败，请查看详情」、按钮 kind=failed | {"banner":{"kind":"failed","title":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者"},"errCode":"install-failed","lastResort":{"present":true,"badge":"最后手段","status":"自动恢复不可用","reason":"没有可用的自动数据路径；复制这条命令是唯一出路。","copyText":"复制手工命令"},"manual":{"heading":"手工备用命令（请复制整行执行）：","code":"dsh plugin --profile t10ui add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=https://127.0.0.1:57142","neutral":""},"entry":{"state":"failed","ariaLabel":"更新失败，请查看详情"},"buttonKind":"failed"} | **pass** | [shots\21-shot.png](shots\21-shot.png) |
| 38-shot | k2-30-after-manual-fix | 手工命令修好后重启宿主：面板按磁盘真相了结，旧失败只留中性历史行 | 横幅「已是最新，无需更新。」、settled 历史行含「上次尝试失败（install-failed）」与 0.0.2、clientTag/hostTag=0.0.2 | {"banner":{"kind":"done","title":"已是最新，无需更新。","sub":""},"settled":"上次尝试失败（install-failed）；目标版本 0.0.2 或更新版本正在运行。","tags":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"}} | **pass** | [shots\38-shot.png](shots\38-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [tls-registry-front](raw\07-tls-registry-front.json)
- [isolation-facts](raw\08-isolation-facts.json)
- [install-baseline](raw\09-install-baseline.json)
- [sut-installed-dist](raw\11-sut-installed-dist.json)
- [fixture-publication](raw\15-fixture-publication.json)
- [k2-corrupt-tarball](raw\16-k2-corrupt-tarball.json)
- [host-launch-k2-gen1](raw\18-host-launch-k2-gen1.json)
- [host-stop-0](raw\27-host-stop-0.json)
- [k2-gen1-logs](raw\28-k2-gen1-logs.json)
- [k2-restore-tarball](raw\33-k2-restore-tarball.json)
- [k2-manual-command-exec](raw\35-k2-manual-command-exec.json)（命令 dsh plugin --profile t10ui add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=https://127.0.0.1:57142，exit 0）
- [host-launch-k2-gen2](raw\37-host-launch-k2-gen2.json)
- [host-stop-1](raw\43-host-stop-1.json)
- [log-fxa-a-2026-11-03](raw\44-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\45-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\46-log-fxa-c-2026-11-03.json)
- [cleanup-log-files](raw\47-cleanup-log-files.json)
- [tls-front-stop](raw\48-tls-front-stop.json)

## 清理

- 进程 k2-gen1-host（pid 66064）：停止后存活=false
- 进程 k2-gen2-host（pid 95984）：停止后存活=false
- 端口 tls-registry-front（57142）：已释放=false
- 端口 k2-gen1-host-port（55282）：已释放=false
- 端口 k2-gen2-host-port（49232）：已释放=false
- 端口 registry（60395）：已释放=true
- 本地 registry：http://127.0.0.1:60395（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 k2-gen1 已起：port=55282，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:57142）
- 宿主 k2-gen2 已起：port=49232，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:57142）

## 维护者 profile 未污染

- 目录：C:/Users/辰辰洋洋/.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:60395（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 k2-gen1 已起：port=55282，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:57142）
- 宿主 k2-gen2 已起：port=49232，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:57142）

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
