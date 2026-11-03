# 真机证据索引 · f2-exit-one-third-party-success

- runId：284-20261103T185708
- 票：#284
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T10:57:08.876Z / 2026-11-03T10:57:48.589Z
- 总判定：**fail**（退出码 1）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:/dsh-plugin/_wt263/t12（分支 impl/284-known-red-recovery，HEAD 3c2997f7a73904165619412b8fcba6edb08f4171）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c24b0e67a15a3b8dd96584b24d8a68afbaa273c1681d201efc
- SUT dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（208 个文件）
- 安装后 dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c2…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1 | **pass** |
| 09-assert | 建普通 web profile（等效宿主的宿主环境） | 在 run 私有 DSH_HOME 里建一个普通 web 使用范围，基版装进它；产品对宿主种类的判定由 readerOverrides.environmentKind 显式给 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t12-284\284-20261103T185708\os-home\.dsh\profiles\t3eq | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t12-284\284-20261103T185708\os-home\.dsh\profiles\t3eq | **pass** |
| 11-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 14-assert | setup-sut | profile 里装的 SUT 与工作树构建一致 | installed distDigest === worktree distDigest | true | **pass** |
| 15-assert | 基版在盘（更新前状态） | 更新前隔离 profile 的 node_modules 里装的是场景声明的基版 0.0.1 | 磁盘版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 23-assert | f2 安装作业终态 | 等效第三方 Desktop（desktopProfiles+desktopPnpm）里点「更新」后的产品作业终态 | completed 或 restart-required；product code=null；耗时 < 300000ms | state=completed；code=null；message=；elapsedMs=1021 | **pass** |
| 24-assert | f2 磁盘版本（安装后） | 作业报成功后磁盘 node_modules 里夹具包的实际版本 | dsh-plugin-update-fixture-a@0.0.2 | 0.0.2 | **pass** |
| 28-assert | f2 产品路线（真机日志） | 产品日志 update.install.exec 的 route 必须落在出口一 desktop-service | route=desktop-service；ok=true；exitCode=0 | route=desktop-service；ok=true；exitCode=0 | **pass** |
| 29-assert | f2 成功格不该有失败行 | 产品日志 update.install.fail 里没有该包 | 0 条 | 0 条 | **pass** |
| 33-assert | f2 重启后运行代码真换版 | 停宿主再起同构宿主：磁盘变体版里 host half 的构建标记必须变成 v0.0.2（不是只看清单/台账） | hostTag=host v0.0.2 | hostTag=host v0.0.1 | **fail** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 21-shot | f2-before | 更新前的夹具卡片（单面板：未安装/已安装版本 + 更新按钮档） | 卡片挂载、显示基版 0.0.1 | text=夹具 A · 更新演示client v0.0.1host v0.0.1单席位集成方（无批量席位行）宿主行为 无（v1）.dsh-upd-entry{display:inline-flex;align-items:center;gap:8px;font:13px/1.6 var(--dsh-update-font-sans,system-ui,"Microsoft YaHei",sans-serif);font-size:var(--dsh-update-entry-font-size,13px);color:var(--dsh-update-text,#1f2937)} .dsh-upd-entry-btn{font:inherit;border:1px solid var(--dsh-update-border,#d1d5db);border-radius:var(--dsh-update-entry-border-radius,6px); background:var(--dsh-update-button-bg,#f9fafb);color:inherit;padding:var(--dsh-update-entry-padding,4px 12px);zoom:var(--dsh-update-entry-scale,1);cursor:pointer} .dsh-upd- | **pass** | [shots\21-shot.png](shots\21-shot.png) |
| 22-shot | f2-after-install | 安装作业终态后的卡片（产品人话格 + 待重启语义） | 作业终态 completed\|restart-required；卡片显示待重启/已了结 | state=completed；code=null；text=夹具 A · 更新演示client v0.0.1host v0.0.1单席位集成方（无批量席位行）宿主行为 无（v1）.dsh-upd-entry{display:inline-flex;align-items:center;gap:8px;font:13px/1.6 var(--dsh-update-font-sans,system-ui,"Microsoft YaHei",sans-serif);font-size:var(--dsh-update-entry-font-size,13px);color:var(--dsh-update-text,#1f2937)} .dsh-upd-entry-btn{font:inherit;border:1px solid var(--dsh-update-border,#d1d5db);border-radius:var(--dsh-update-entry-border-radius,6px); background:var(--dsh-update-button-bg,#f9fafb);color:inherit;padding:var(--dsh-update-entry-padding,4px 12px);zoom:var(--dsh-update-entry-scale,1);cursor:pointer} .dsh-upd- | **pass** | [shots\22-shot.png](shots\22-shot.png) |
| 32-shot | f2-after-restart | 重启后卡片上的夹具构建标记（client/host tag）与标题 | client=client v0.0.2；host=host v0.0.2（运作代码来自变体版） | client=client v0.0.1；host=host v0.0.1；title=夹具 A · 更新演示 | **fail** | [shots\32-shot.png](shots\32-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [isolation-facts](raw\07-isolation-facts.json)
- [profile-create](raw\08-profile-create.json)
- [install-baseline](raw\10-install-baseline.json)
- [sut-installed-dist](raw\12-sut-installed-dist.json)
- [can-red-fault-injection](raw\16-can-red-fault-injection.json)
- [fixture-published-variant](raw\17-fixture-published-variant.json)
- [equivalent-host-spec-exit-one](raw\18-equivalent-host-spec-exit-one.json)
- [host-launch-exit-one](raw\19-host-launch-exit-one.json)
- [equivalent-host-boundary-0](raw\20-equivalent-host-boundary-0.json)
- [f2-exec-log-wait](raw\25-f2-exec-log-wait.json)
- [host-stop-0](raw\26-host-stop-0.json)
- [install-log-facts](raw\27-install-log-facts.json)
- [equivalent-host-spec-exit-one-restarted](raw\30-equivalent-host-spec-exit-one-restarted.json)
- [host-launch-exit-one-restarted](raw\31-host-launch-exit-one-restarted.json)
- [host-stop-1](raw\34-host-stop-1.json)
- [log-fxa-a-2026-11-03](raw\35-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\36-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\37-log-fxa-c-2026-11-03.json)
- [cleanup-log-files](raw\38-cleanup-log-files.json)
- [tls-front-stop](raw\39-tls-front-stop.json)

## 清理

- 进程 exit-one-host（pid 48424）：停止后存活=false
- 进程 exit-one-restarted-host（pid 4040）：停止后存活=false
- 端口 exit-one-host-port（59961）：已释放=true
- 端口 exit-one-restarted-host-port（62382）：已释放=true
- 端口 tls-registry-front（52645）：已释放=true
- 端口 registry（58119）：已释放=true
- 本地 registry：http://127.0.0.1:58119（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 等效宿主（本机没有第三方 Desktop / 官方桌面）：用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入宿主能力；产品路由/执行器/电话/面板/日志全真实，安装由官方发行包 CLI 真跑 pnpm 落真磁盘。边界见 raw/equivalent-host-boundary-*。
- can-red 故障注入：stale-variant——变体清单 0.0.2，构建内容仍是 0.0.1；预期 buildTag 断言真红
- 宿主 exit-one 已起：kind=desktop，port=59961，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright
- 等效宿主边界（0，kind=desktop）：本机没有第三方 Desktop / 官方桌面；用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入等效宿主能力，产品走真实路由/executor/电话/面板；stub=宿主进程内的服务对象（desktopProfiles/desktopPnpm/pluginManager）由夹具模板提供，不是宿主发行包自带
- 宿主 exit-one-restarted 已起：kind=desktop，port=62382，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright

## 备注

- 本地 registry：http://127.0.0.1:58119（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 等效宿主（本机没有第三方 Desktop / 官方桌面）：用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入宿主能力；产品路由/执行器/电话/面板/日志全真实，安装由官方发行包 CLI 真跑 pnpm 落真磁盘。边界见 raw/equivalent-host-boundary-*。
- can-red 故障注入：stale-variant——变体清单 0.0.2，构建内容仍是 0.0.1；预期 buildTag 断言真红
- 宿主 exit-one 已起：kind=desktop，port=59961，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright
- 等效宿主边界（0，kind=desktop）：本机没有第三方 Desktop / 官方桌面；用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入等效宿主能力，产品走真实路由/executor/电话/面板；stub=宿主进程内的服务对象（desktopProfiles/desktopPnpm/pluginManager）由夹具模板提供，不是宿主发行包自带
- 宿主 exit-one-restarted 已起：kind=desktop，port=62382，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
