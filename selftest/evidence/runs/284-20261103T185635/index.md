# 真机证据索引 · i4-pending-restart-panel-truth

- runId：284-20261103T185635
- 票：#284
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T10:56:35.342Z / 2026-11-03T10:57:08.609Z
- 总判定：**pass**（退出码 0）

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
| 09-assert | 建普通 web profile（等效宿主的宿主环境） | 在 run 私有 DSH_HOME 里建一个普通 web 使用范围，基版装进它；产品对宿主种类的判定由 readerOverrides.environmentKind 显式给 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t12-284\284-20261103T185635\os-home\.dsh\profiles\t3eq | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t12-284\284-20261103T185635\os-home\.dsh\profiles\t3eq | **pass** |
| 11-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 14-assert | setup-sut | profile 里装的 SUT 与工作树构建一致 | installed distDigest === worktree distDigest | true | **pass** |
| 15-assert | 基版在盘（更新前状态） | 更新前隔离 profile 的 node_modules 里装的是场景声明的基版 0.0.1 | 磁盘版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 23-assert | i4 安装作业终态 | cli 路由真 CLI 安装变体后产品给的作业终态 | completed 或 restart-required；code=null | state=restart-required；code=null；message= | **pass** |
| 24-assert | i4 磁盘版本（安装后、未重启） | 真 CLI 安装后 profile node_modules 里的实际版本 | 0.0.2 | 0.0.2 | **pass** |
| 27-assert | i4 status 电话：运行版 vs 磁盘版 = 待重启 | runner 不是「安装即成功」：runningVersion 仍基版、installedVersion 变体版、blockedReason=pending-restart | runningVersion=0.0.1；installedVersion=0.0.2；blockedReason=pending-restart | runningVersion=0.0.1；installedVersion=0.0.2；blockedReason=pending-restart | **pass** |
| 34-assert | i4 未登记 + 重启：插件不加载 | 重启后 10s 内卡片不出现（未被登记就不会被宿主加载），持卡插件电话桥不可用（404/405，不是 200） | cardSeen=false；电话桥 status=404 或 405（本机宿主对未匹配 POST 回 405） | cardSeen=false；bridgeStatus=405；bridgeError=null | **pass** |
| 41-assert | i4 重启后运行代码真换版 | 重启宿主后加载变体版：host half 构建标记换版（client+host 双标记） | client=client v0.0.2；host=host v0.0.2 | client=client v0.0.2；host=host v0.0.2；title=夹具 A · 更新演示（新版） | **pass** |
| 42-assert | i4 重启后运行版权威：runningVersion=installedVersion | 重启后 status 电话：runningVersion 跟磁盘一致、blockedReason 不再 pending-restart（不再谎称待重启） | runningVersion=0.0.2；installedVersion=0.0.2；blockedReason=null | runningVersion=0.0.2；installedVersion=0.0.2；blockedReason=null | **pass** |
| 46-assert | i4 产品路线：出口三 cli-process | 真实 web 宿主里产品日志 update.install.exec 的 route 必须是 cli-process、ok=true | route=cli-process；ok=true | route=cli-process；ok=true | **pass** |
| 47-assert | i4 成功格不该有失败行 | 产品日志 update.install.fail 里没有该包 | 0 条 | 0 条 | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 25-shot | i4-pending-restart-banner | 已写盘未重启的面板横幅（登记在册）：待重启文案 + 非安装失败 | banner.kind=restart；title=「新版本 0.0.2 已安装，重启宿主后生效。」；sub=「重启宿主以加载新版本；此为正常状态，非安装失败」（restart 横幅没有 seal 徽标，不能拿空 seal 判失败） | banner={"kind":"restart","title":"新版本 0.0.2 已安装，重启宿主后生效。","sub":"重启宿主以加载新版本；此为正常状态，非安装失败","action":""}；seal= | **pass** | [shots\25-shot.png](shots\25-shot.png) |
| 29-shot | i4-unregistered-banner | 同一宿主里把包从在册摘掉后面板：未登记分支（重启也不会加载） | banner.kind=restart；title 含「未登记在使用范围清单」与变体版；sub=「请先在宿主插件页选中该插件，再重启宿主以加载新版本。」（同样无 seal 徽标） | banner={"kind":"restart","title":"新版本 0.0.2 已写入磁盘，但该插件未登记在使用范围清单，重启宿主也不会加载。","sub":"请先在宿主插件页选中该插件，再重启宿主以加载新版本。","action":""}；seal= | **pass** | [shots\29-shot.png](shots\29-shot.png) |
| 35-shot | i4-unregistered-not-loaded | 未登记重启后的页面（没有插件卡片/更新面板） | 页面正常渲染、无夹具卡片 | cardSeen=false；bodyHead=新会话 Ctrl + Alt + N 插件 自动化任务 更多 工作区 默认工作区 新会话 更多 探索未至之境 预览版 默认工作区 标准模式 描述你想要构建的内容, / 调用指令, @ 文件或对话 工作区内修改 请选择模型 开始使用  登录 DeepSeek 账号，或添加 API Key，即可开始使用。你的项目和文件保存在本地。  添加 API Key 登录 | **pass** | [shots\35-shot.png](shots\35-shot.png) |
| 43-shot | i4-loaded-after-restart | 在册 + 重启后的面板：待重启/未登记话术消失 | banner.kind≠restart；卡片不含「待重启」「未登记」 | banner={"kind":"done","title":"已是最新，无需更新。","sub":"","action":""}；text=夹具 A · 更新演示（新版）client v0.0.2host v0.0.2单席位集成方（无批量席位行）宿主行为 无（v1）.dsh-upd-entry{display:inline-flex;align-items:center;gap:8px;font:13px/1.6 var(--dsh-update-font-sans,system-ui,"Microsoft YaHei",sans-serif);font-size:var(--dsh-update-entry-font-size,13px);color:var(--dsh-update-text,#1f2937)} .dsh-upd-entry-btn{font:inherit;border:1px solid var(--dsh-update-border,#d1d5db);border-radius:var(--dsh-update-entry-border-radius,6px); background:var(--dsh-update-button-bg,#f9fafb);color:inherit;padding:var(--dsh-update-entry-padding,4px 12px);zoom:var(--dsh-update-entry-scale,1);cursor:pointer} .dsh-upd-entry-btn:hover{border-color:var(--dsh-update-primary,#2563eb)} .dsh-upd-entry-btn,.dsh-upd-entry-dot{transition:background-color .15s ease,border-color .15s ease,color .15s ease,transform .06s ease} .dsh-upd-entry-btn:active:not(:disabled){transform:translateY(1px)} .dsh-upd-entry-btn:disabled, | **pass** | [shots\43-shot.png](shots\43-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [isolation-facts](raw\07-isolation-facts.json)
- [profile-create](raw\08-profile-create.json)
- [install-baseline](raw\10-install-baseline.json)
- [sut-installed-dist](raw\12-sut-installed-dist.json)
- [fixture-published-variant](raw\16-fixture-published-variant.json)
- [i4-hmr-disabled](raw\17-i4-hmr-disabled.json)
- [equivalent-host-spec-i4-pending-restart](raw\18-equivalent-host-spec-i4-pending-restart.json)
- [host-launch-i4-pending-restart](raw\19-host-launch-i4-pending-restart.json)
- [equivalent-host-boundary-0](raw\20-equivalent-host-boundary-0.json)
- [i4-status-before](raw\21-i4-status-before.json)
- [i4-install-job](raw\22-i4-install-job.json)
- [i4-status-after-install](raw\26-i4-status-after-install.json)
- [i4-enrollment-unregistered](raw\28-i4-enrollment-unregistered.json)
- [host-stop-0](raw\30-host-stop-0.json)
- [equivalent-host-spec-i4-unregistered-restart](raw\31-equivalent-host-spec-i4-unregistered-restart.json)
- [host-launch-i4-unregistered-restart](raw\32-host-launch-i4-unregistered-restart.json)
- [i4-unregistered-restart-probe](raw\33-i4-unregistered-restart-probe.json)
- [host-stop-1](raw\36-host-stop-1.json)
- [i4-enrollment-restored](raw\37-i4-enrollment-restored.json)
- [equivalent-host-spec-i4-loaded-variant](raw\38-equivalent-host-spec-i4-loaded-variant.json)
- [host-launch-i4-loaded-variant](raw\39-host-launch-i4-loaded-variant.json)
- [i4-status-after-restart](raw\40-i4-status-after-restart.json)
- [host-stop-2](raw\44-host-stop-2.json)
- [i4-install-log-facts](raw\45-i4-install-log-facts.json)
- [log-fxa-a-2026-11-03](raw\48-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\49-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\50-log-fxa-c-2026-11-03.json)
- [cleanup-log-files](raw\51-cleanup-log-files.json)
- [tls-front-stop](raw\52-tls-front-stop.json)

## 清理

- 进程 i4-pending-restart-host（pid 103964）：停止后存活=false
- 进程 i4-unregistered-restart-host（pid 77892）：停止后存活=false
- 进程 i4-loaded-variant-host（pid 105092）：停止后存活=false
- 端口 i4-pending-restart-host-port（59515）：已释放=true
- 端口 i4-unregistered-restart-host-port（62837）：已释放=true
- 端口 i4-loaded-variant-host-port（49979）：已释放=true
- 端口 tls-registry-front（59761）：已释放=true
- 端口 registry（53915）：已释放=true
- 本地 registry：http://127.0.0.1:53915（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 等效宿主（本机没有第三方 Desktop / 官方桌面）：用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入宿主能力；产品路由/执行器/电话/面板/日志全真实，安装由官方发行包 CLI 真跑 pnpm 落真磁盘。边界见 raw/equivalent-host-boundary-*。
- i4 宿主配置：profile patch 关闭 base 组合包的 hmr 条目（HMR 会在装盘后热重载插件，掩盖待重启状态）。patch 原文见 raw/i4-hmr-disabled。
- 宿主 i4-pending-restart 已起：kind=reader-version，port=59515，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright
- 等效宿主边界（0，kind=reader-version）：本机没有第三方 Desktop / 官方桌面；用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入等效宿主能力，产品走真实路由/executor/电话/面板；stub=宿主进程内的服务对象（desktopProfiles/desktopPnpm/pluginManager）由夹具模板提供，不是宿主发行包自带
- i4 注入：把包从 profile 的 dsh.profile.bundles 里摘掉（真实改 profile/package.json），模拟「未登记在使用范围清单」。
- 宿主 i4-unregistered-restart 已起：kind=reader-version，port=62837，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright
- 宿主 i4-loaded-variant 已起：kind=reader-version，port=49979，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright

## 备注

- 本地 registry：http://127.0.0.1:53915（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 等效宿主（本机没有第三方 Desktop / 官方桌面）：用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入宿主能力；产品路由/执行器/电话/面板/日志全真实，安装由官方发行包 CLI 真跑 pnpm 落真磁盘。边界见 raw/equivalent-host-boundary-*。
- i4 宿主配置：profile patch 关闭 base 组合包的 hmr 条目（HMR 会在装盘后热重载插件，掩盖待重启状态）。patch 原文见 raw/i4-hmr-disabled。
- 宿主 i4-pending-restart 已起：kind=reader-version，port=59515，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright
- 等效宿主边界（0，kind=reader-version）：本机没有第三方 Desktop / 官方桌面；用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入等效宿主能力，产品走真实路由/executor/电话/面板；stub=宿主进程内的服务对象（desktopProfiles/desktopPnpm/pluginManager）由夹具模板提供，不是宿主发行包自带
- i4 注入：把包从 profile 的 dsh.profile.bundles 里摘掉（真实改 profile/package.json），模拟「未登记在使用范围清单」。
- 宿主 i4-unregistered-restart 已起：kind=reader-version，port=62837，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright
- 宿主 i4-loaded-variant 已起：kind=reader-version，port=49979，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
