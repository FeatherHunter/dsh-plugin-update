# 真机证据索引 · d1-desktop-manager-update-success

- runId：267-20261102T113218
- 票：#267
- 宿主通道：desktop-official
- 开始/结束：2026-11-02T03:32:18.534Z / 2026-11-02T03:35:49.505Z
- 总判定：**fail**（退出码 1）

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
| 08-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 10-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1 | efddad08a87b049384552da9120af2628d192ede1053ce8b3e7790e9ae4c5cd1（文件数 208 / 工作树 208） | **pass** |
| 12-assert | 旧版面板（重启后） | 官方桌面里 A 的更新面板显示：运行版/已安装 0.0.1、夹具卡片 client v0.0.1 | 运行版=已安装=0.0.1；client 构建标记=client v0.0.1 | versions=[0.0.1, 0.0.1, 未知]；clientTag=client v0.0.1；seal=已是最新 | **pass** |
| 16-assert | 发布变体版（可见变化） | 同一包名发布 0.0.2；新版 client bundle 与 host half 的内容哈希都和 0.0.1 不同 | client 与 host 的 sha256 都变；registry 可见 0.0.2 | client 2134db6bd6e1→2134db6bd6e1；host bc5a002cfb4b→bc5a002cfb4b | **fail** |
| 18-assert | 变体版在 registry 可见 | 本地 registry 的 A 元数据包含基版与变体版（更新系统查到的 latest 就是它） | versions 含 0.0.1、0.0.2 | versions=[0.0.1, 0.0.2]；dist-tags={"latest":"0.0.2"} | **pass** |
| 20-assert | 真 UI 检查更新 | 点面板「检查更新」后，最新版变成 0.0.2，安装按钮可用（数据来自面板 DOM 快照） | 最新版=0.0.2；安装更新按钮 enabled | versions=[0.0.1, 0.0.1, 0.0.2]；install={"text":"安装版本 0.0.2","disabled":false}；seal=可更新 | **pass** |
| 23-assert | 真 UI 安装更新（in-process） | 点「安装更新」后，官方桌面通过 in-process remove→install 把 profile 磁盘版本换成 0.0.2 | 磁盘 node_modules/<pkg>/package.json version=0.0.2 | 磁盘版本=0.0.2；面板 seal=已是最新；进度=null | **pass** |
| 27-assert | 出口二两步配方（operation 日志硬证据） | 官方桌面 in-process 插件管理器对已装包先 removeBundle 再 installBundle：窗口内恰两次非空 operation，先移除旧版（pnpm 输出 - dsh-plugin-update-fixture-a 0.0.1）、后安装新版（+ dsh-plugin-update-fixture-a 0.0.2） | 窗口内 operation 恰 2 个且都非空；顺序 remove→add；移除行命中旧版、安装行命中新版 | count=2；nonEmpty=2；order=remove-then-add；操作=operation-rOubJ2(remove ) → operation-jfcGjQ(add) | **pass** |
| 28-assert | 出口二 already-installed 守卫处理 | HMR 宿主的首次 installBundle 对已装包在跑 pnpm 之前就同步拒绝 already-installed；本包据此改走 remove→install，所以窗口内只有两次 pnpm 运行（没有第三次失败的 add，也没有把 already-installed 当最终失败） | 窗口内非空 operation 恰 2 个（remove + add），且没有只失败一次就收场的第三次 pnpm | 窗口内 operation 共 2 个（非空 2） | **pass** |
| 32-assert | 出口二成功：exec 日志（route/ok/exitCode） | 产品日志 update.install.exec 记录本次更新走官方桌面插件管理器（route=desktop-manager），且以 0 收场 | route=desktop-manager；ok=true；exitCode=0 | {"route":"desktop-manager","ok":true,"exitCode":0,"durationMs":2572,"pluginId":"fxa-a","traceId":"884b55506b8a14ff","spanId":"7cd1324a","seq":4} | **pass** |
| 33-assert | 出口二成功：无安装失败事件 | 成功格的产品日志里不许出现 update.install.fail（成功就是成功，不靠失败事件收场） | update.install.fail 行数=0 | update.install.fail 行数=0 | **pass** |
| 34-assert | 出口二路由判定（hostKind=desktop-manager） | 日志 update.wire.ready 的 hostKind 证明本宿主走的是官方桌面内建插件管理器出口（desktopProfiles 服务缺失 → profileName=desktop 且 pluginManager.installBundle 存在 → desktop-manager） | hostKind=desktop-manager | hostKind=["desktop-manager","desktop-manager","desktop-manager","desktop-manager","desktop-manager","desktop-manager"] | **pass** |
| 37-assert | 重启后新版 UI + 可见变化 | 重启隔离桌面后重新加载的是 0.0.2 的 client/host：卡片标题相对旧版发生变化、client 构建标记、host 桥标记都变成新版 | client v0.0.2；host v0.0.2；标题从「夹具 A · 更新演示」变为另一个值且含「新版」；运行版/已安装=0.0.2 | clientTag=client v0.0.1；hostTag=host v0.0.1；title=夹具 A · 更新演示（旧：夹具 A · 更新演示）；versions=[0.0.2, 0.0.2, 未知] | **fail** |
| 40-assert | UI/磁盘一致（无虚假成功） | 重启后 UI 显示已安装 0.0.2，且磁盘 profile 的 dependencies 与 node_modules 包版本都是 0.0.2 | diskVersion=0.0.2；dependencies=0.0.2 | diskVersion=0.0.2；dependencies=0.0.2 | **pass** |
| 42-assert | 台账（作业状态） | 更新器落盘的作业状态记录本次更新：目标版本 0.0.2、前版本 0.0.1、状态为成功终态（completed 或 restart-required） | 存在 state.json 且 targetVersion=0.0.2、previousVersion=0.0.1、state∈{completed,restart-required} | {"requestId":"rmvypfcxx2oiik","message":null,"id":"0eeebbb3-add3-4cce-85e6-28c7409241f4","state":"completed","targetVersion":"0.0.2","previousVersion":"0.0.1"} | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 13-shot | 旧版面板 | 官方桌面窗口里的 A 面板：版本条带 0.0.1，夹具卡片显示 client v0.0.1 | 运行版=已安装=0.0.1，卡片 client v0.0.1 | versions=[0.0.1, 0.0.1, 未知]；clientTag=client v0.0.1 | **pass** | [shots\13-shot.png](shots\13-shot.png) |
| 21-shot | 检查更新后 | 点击「检查更新」后的面板：最新版显示 0.0.2，出现「安装更新」可用按钮 | 版本条带第三项=0.0.2，安装按钮可用 | versions=[0.0.1, 0.0.1, 0.0.2]；install.disabled=false | **pass** | [shots\21-shot.png](shots\21-shot.png) |
| 24-shot | 安装更新后（重启前） | 安装动作结束后的面板：出现安装结果/待重启状态（面板可能在安装后重挂载，故 clientTag 允许为空）；磁盘已是 0.0.2 | 安装动作结束；磁盘已是 0.0.2 | seal=已是最新；clientTag=client v0.0.1；磁盘=0.0.2 | **pass** | [shots\24-shot.png](shots\24-shot.png) |
| 38-shot | 重启后新版面板 | 重启后的官方桌面窗口：卡片标题变为新版变体，client/host 构建标记都是 v0.0.2 | client v0.0.2 / host v0.0.2 / 标题含「新版」 | clientTag=client v0.0.1；hostTag=host v0.0.1；title=夹具 A · 更新演示 | **fail** | [shots\38-shot.png](shots\38-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [fixture-published-baseline](raw\04-fixture-published-baseline.json)
- [desktop-first-launch](raw\06-desktop-first-launch.json)
- [install-baseline](raw\07-install-baseline.json)
- [sut-installed-dist](raw\09-sut-installed-dist.json)
- [panel-old](raw\11-panel-old.json)
- [can-red-fault](raw\14-can-red-fault.json)
- [fixture-published-new](raw\15-fixture-published-new.json)
- [registry-metadata-new](raw\17-registry-metadata-new.json)
- [panel-after-check](raw\19-panel-after-check.json)
- [panel-after-install](raw\22-panel-after-install.json)
- [plugin-manager-operation-operation-rOubJ2](raw\25-plugin-manager-operation-operation-rOubJ2.json)
- [plugin-manager-operation-operation-jfcGjQ](raw\26-plugin-manager-operation-operation-jfcGjQ.json)
- [log-fxa-a-2026-11-02](raw\29-log-fxa-a-2026-11-02.json)
- [log-fxa-b-2026-11-02](raw\30-log-fxa-b-2026-11-02.json)
- [log-fxa-c-2026-11-02](raw\31-log-fxa-c-2026-11-02.json)
- [profile-manifest-after-update](raw\35-profile-manifest-after-update.json)
- [panel-new](raw\36-panel-new.json)
- [final-disk-facts](raw\39-final-disk-facts.json)
- [ledger-states](raw\41-ledger-states.json)

## 清理

- 进程 desktop-app-bootstrap（pid 85812）：停止后存活=false
- 进程 desktop-app-main（pid 26428）：停止后存活=false
- 进程 desktop-app-restart（pid 70468）：停止后存活=false
- 端口 registry（51337）：已释放=true
- 本地 registry：http://127.0.0.1:51337（仓库外 verdaccio，run 内独立 storage）
- can-red 故障注入：stale-variant（can-red：发布 0.0.2 但构建内容仍是 0.0.1（client/host 构建标记不变），预期重启后「新版 UI」断言真红）；本 run 预期整体 fail，用来证明「重启后新版 UI」断言可红

## 备注

- 本地 registry：http://127.0.0.1:51337（仓库外 verdaccio，run 内独立 storage）
- can-red 故障注入：stale-variant（can-red：发布 0.0.2 但构建内容仍是 0.0.1（client/host 构建标记不变），预期重启后「新版 UI」断言真红）；本 run 预期整体 fail，用来证明「重启后新版 UI」断言可红

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
