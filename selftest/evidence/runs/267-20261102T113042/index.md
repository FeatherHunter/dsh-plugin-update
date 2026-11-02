# 真机证据索引 · f1-third-party-desktop-probe

- runId：267-20261102T113042
- 票：#267
- 宿主通道：desktop-official
- 开始/结束：2026-11-02T03:30:42.361Z / 2026-11-02T03:32:03.362Z
- 总判定：**known-red**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:/dsh-plugin/_wt263/t3（分支 impl/263-t3，HEAD cc140e7a90b552ae1dd59c06f44c9092204edf7f）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 d1ed0c40042770cc90f942210464e5d52dad077947354ab8c42ff0f926f4298b
- SUT dist 指纹：efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1（208 个文件）
- 安装后 dist 指纹：efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 03-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 d1ed0c40042770cc…，dist 208 文件 | **pass** |
| 05-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1 | **pass** |
| 07-assert | 出口一能力探测：官方桌面发行包路径 | 本机官方桌面（DeepSeek Harness.exe）与它的 CLI 入口是否在发行包默认位置（探测原始事实；cli.js 在 app.asar 内，用 Electron-as-node 读） | exe 是真实文件；cli.js 能被发行包自己的 exe 以 ELECTRON_RUN_AS_NODE=1 读到（exists=true 且 size>0） | exe=true（D:\DeepseekHarness\DeepSeek Harness.exe）；cli.js.exists=true；cli.js.size=5607；probe.exit=0 | **pass** |
| 11-assert | 出口一能力探测：三项探测都拿到原始结果 | 文件系统扫描 + 卸载表查询 + 服务表查询都执行完成（命令原文与完整输出在 raw，失败也保留） | 每个扫描根都扫到目录（readdir 有结果）；卸载表/服务表 PowerShell exit=0 且输出可解析 | 扫描根=6，共扫目录 1080，readdir 错误 4；卸载表 exit=0 条目 3；服务表 exit=0 条目 0 | **pass** |
| 13-assert | 出口一能力探测：本机没有第三方 Desktop 安装 | 文件系统扫描、卸载表、服务表三项都没有发现官方桌面以外的 DSH 桌面宿主（判据原文与 nearMiss 原文见 raw/capability-probe-classification） | 按结构判据，除官方安装根外没有第二份第三方 Desktop 发行目录/卸载条目/服务 | 同族目录命中 26（官方 1 / 第三方 0 / 非桌面宿主 nearMiss 25）；卸载表同族 3（第三方 0 / nearMiss 1）；服务同族 0 | **pass** |
| 15-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 17-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1 | efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1（文件数 208 / 工作树 208） | **pass** |
| 24-assert | 出口一不可达的活证据：唯一桌面宿主报 hostKind=desktop-manager | 官方桌面里插件发 update.wire.ready，hostKind 由产品环境判定给出；desktop-manager 意味着 desktopProfiles 服务不存在（出口一要求的能力） | hostKind='desktop-manager'（若为 'desktop' 则说明 desktopProfiles 存在、出口一可达） | hostKind="desktop-manager"；wire.ready 行数=3；日志文件 3 个 | **pass** |
| 25-assert | 出口一真机更新（成功格，不可达） | 在提供 desktopProfiles 服务的第三方 Desktop 宿主上，对已装 0.0.1 走一次更新到 0.0.2（由宿主 launcher 执行 pnpm） | 第三方 Desktop 宿主上 update.install.exec route=desktop ok=true；磁盘与重启后 UI 都到 0.0.2 | 本机没有第三方 Desktop 宿主（三项探测为空、唯一桌面宿主 hostKind=desktop-manager），没有可跑的真机；不伪造真机结果 | **known-red** |
| 26-assert | 出口一真机更新（失败格，不可达） | 在第三方 Desktop 宿主上制造一次更新失败（例如让宿主 pnpm 报错），核对产品失败码/人话格/手工命令的出口一语义 | 失败码 install-failed、detail 来自宿主原话、人话格与手工命令按出口一契约呈现 | 本机没有第三方 Desktop 宿主，出口一失败语义无法真机观测；库内契约测试见 tests/ 与 docs/host-install-exits.md，真机格记 known-red | **known-red** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 19-shot | 本机唯一桌面宿主里的更新面板 | 官方桌面（本机唯一桌面宿主）里装着夹具，更新面板真的渲染出来——出口二通道活着的证据 | 面板 present=true、seal=ready、卡片显示 client v0.0.1 | present=true；seal=已是最新；clientTag=client v0.0.1 | **pass** | [shots\19-shot.png](shots\19-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [fixture-published-baseline](raw\04-fixture-published-baseline.json)
- [capability-probe-official-desktop](raw\06-capability-probe-official-desktop.json)
- [capability-probe-filesystem](raw\08-capability-probe-filesystem.json)
- [capability-probe-uninstall-registry](raw\09-capability-probe-uninstall-registry.json)
- [capability-probe-services](raw\10-capability-probe-services.json)
- [capability-probe-classification](raw\12-capability-probe-classification.json)
- [install-baseline](raw\14-install-baseline.json)
- [sut-installed-dist](raw\16-sut-installed-dist.json)
- [panel-only-desktop](raw\18-panel-only-desktop.json)
- [log-fxa-a-2026-11-02](raw\20-log-fxa-a-2026-11-02.json)
- [log-fxa-b-2026-11-02](raw\21-log-fxa-b-2026-11-02.json)
- [log-fxa-c-2026-11-02](raw\22-log-fxa-c-2026-11-02.json)
- [desktop-host-kind-negative](raw\23-desktop-host-kind-negative.json)

## 清理

- 进程 desktop-app-bootstrap（pid 54424）：停止后存活=false
- 进程 desktop-app-main（pid 50656）：停止后存活=false
- 端口 registry（49959）：已释放=true
- 本地 registry：http://127.0.0.1:49959（仓库外 verdaccio，run 内独立 storage）
- 出口一 known-red：可复现条件：在一台装有第三方 Desktop 发行包（launcher 在 Loader entry 挂载前注册 desktopProfiles 服务）的机器上重跑本场景；探测到第三方宿主后，出口一真机更新应走 desktopProfiles.runPlugin(args, 使用范围目录, undefined) 完成一次已装更新。本机探测证据：raw/capability-probe-filesystem、raw/capability-probe-uninstall-registry、raw/capability-probe-services、raw/desktop-host-kind-negative。

## 备注

- 本地 registry：http://127.0.0.1:49959（仓库外 verdaccio，run 内独立 storage）
- 出口一 known-red：可复现条件：在一台装有第三方 Desktop 发行包（launcher 在 Loader entry 挂载前注册 desktopProfiles 服务）的机器上重跑本场景；探测到第三方宿主后，出口一真机更新应走 desktopProfiles.runPlugin(args, 使用范围目录, undefined) 完成一次已装更新。本机探测证据：raw/capability-probe-filesystem、raw/capability-probe-uninstall-registry、raw/capability-probe-services、raw/desktop-host-kind-negative。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
