# 真机证据索引 · i1-restart-enrollment-truth

- runId：272-20261103T093814-r40
- 票：#272
- 宿主通道：desktop-official
- 开始/结束：2026-11-03T03:09:51.721Z / 2026-11-03T03:12:24.303Z
- 总判定：**fail**（退出码 1）

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
| 08-assert | 隔离口径 | 官方桌面实例使用仓库外隔离 home + 独立 --user-data-dir；registry 为本 run 本地 verdaccio | homeDir=D:\dsh-plugin\_wt263\runtime\t11-275\272-20261103T093814-r40\home；userDataDir=D:\dsh-plugin\_wt263\runtime\t11-275\272-20261103T093814-r40\user-data-dir；profile=desktop | homeDir=D:\dsh-plugin\_wt263\runtime\t11-275\272-20261103T093814-r40\home；userDataDir=D:\dsh-plugin\_wt263\runtime\t11-275\272-20261103T093814-r40\user-data-dir；profile=desktop | **pass** |
| 10-assert | 首启桌面建隔离 profile | launchDesktopApp 起来后等 profiles/desktop 目录出现 | profiles/desktop 出现；实例 pid 可记 | profileDir=D:\dsh-plugin\_wt263\runtime\t11-275\272-20261103T093814-r40\home\profiles\desktop；pid=94756 | **pass** |
| 13-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 15-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 17-assert | 更新前基版在盘且在册 | CLI 装 dsh-plugin-update-fixture-a@0.0.1 后读磁盘版本与 profile 清单（dependencies + dsh.profile.bundles） | 磁盘=0.0.1；dependencies 有该包=0.0.1；bundles 含该包 | 磁盘=0.0.1；dependencies={"dsh-plugin-update-fixture-a":"0.0.1"}；bundles=["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-plugin-update-fixture-a"] | **pass** |
| 19-assert | 变体版本已发布 | 本地 verdaccio 发布 dsh-plugin-update-fixture-a@0.0.2（can-red：内容固化为基版） | dsh-plugin-update-fixture-a@0.0.2 | dsh-plugin-update-fixture-a@0.0.2；injected=[{"slotKey":"a","kind":"stale-variant","spec":"dsh-plugin-update-fixture-a@0.0.2"}] | **pass** |
| 22-assert | 主实例面板加载基版 | 等夹具卡片 + 更新面板从占位渲染成真实版本 | panel.present=true；card.clientTag=client v0.0.1；card.hostTag=host v0.0.1 | present=true；clientTag=client v0.0.1；hostTag=host v0.0.1 | **pass** |
| 25-assert | 真 UI 检查更新 | 点面板「检查更新」后等版本条到 0.0.2 且安装按钮可点 | versions[2]=0.0.2；install.disabled=false | versions=["0.0.1","0.0.1","0.0.2"]；install={"text":"安装版本 0.0.2","disabled":false} | **pass** |
| 28-assert | 安装完成（磁盘版本） | 点真 UI「安装」后只轮询磁盘 node_modules 版本（安装窗内不依赖 UI） | 磁盘版本=0.0.2 | 磁盘=0.0.2；耗时≈2043ms | **pass** |
| 31-assert | 安装完成后面板如实反映「已生效」（不是写盘假绿） | 桌面管理器装完但用户没有手动重启：面板说「已是最新」时，页面运行标记必须真的是 0.0.2（client+host 两半都换） | banner 含「已是最新」；card.clientTag=client v0.0.2；card.hostTag=host v0.0.2；versions[0]=0.0.2 | hit=已是最新；banner= 定已是最新，无需更新。 ；clientTag=client v0.0.1；hostTag=host v0.0.1；versions=["0.0.2","0.0.2","未知"] | **fail** |
| 34-assert | 安装完成后面板没有假的「等重启」文案 | 桌面管理器是 in-process 热换：装完后同一进程内已生效，横幅不应再说「重启宿主后生效」 | banner 不含「重启宿主后生效」 | banner= 定已是最新，无需更新。  | **pass** |
| 43-assert | 安装执行恰一次（desktop-manager / 成功 / exit0） | 安装窗内 update.install.exec 行数、route、退出码、目标插件 | exec 行数=1；route=desktop-manager；ok=true；exitCode=0；pluginId=fxa-a | exec=[{"route":"desktop-manager","ok":true,"exitCode":0,"durationMs":1721,"pluginId":"fxa-a","ts":1793675479737}] | **pass** |
| 44-assert | 安装窗内没有进程级重启（无 host.start） | 用法：若宿主在安装时自重启，安装窗内会出现新的 host.start 行；没有就是同一进程热换 | host.start 落在安装窗内的行数=0 | count=0；全部 host.start ts=[1793675411346,1793675411348,1793675411348] | **pass** |
| 46-assert | 台账恰一条成功终态（无重复/丢单） | 读 <home>/updates 下各级 state.json，按目标版本筛终态成功条目 | targetVersion=0.0.2 的成功终态条目恰 1 条；previousVersion=0.0.1 | 条目数=1；[{"requestId":"rmw042ghd4909c","message":null,"id":"98102e01-b7df-4e6f-b7d5-07a3530de1fa","state":"completed","targetVersion":"0.0.2","previousVersion":"0.0.1"}] | **pass** |
| 48-assert | 收尾清理（进程/端口无残留） | 停掉本 run 起过的桌面实例后按 pid 复核存活、按端口复核已释放 | 存活 pid 数=0；主实例端口已释放 | alive=[]；ports=[{"label":"desktop-main-port","port":62201,"released":true}] | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 23-shot | panel-old | 安装前官方桌面夹具卡片与更新面板（基版 0.0.1） | 卡片显示 client v0.0.1 / host v0.0.1 | visible | **pass** | [shots\23-shot.png](shots\23-shot.png) |
| 26-shot | panel-checked | 检查更新后的官方桌面面板（可安装 0.0.2） | 版本条显示 0.0.2 且安装按钮可点 | visible | **pass** | [shots\26-shot.png](shots\26-shot.png) |
| 32-shot | panel-after-install | 安装完成（未手动重启）时的官方桌面面板： 定已是最新，无需更新。  | 已是最新，且卡片运行标记 client/host = 0.0.2 | visible | **pass** | [shots\32-shot.png](shots\32-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [isolation-facts](raw\07-isolation-facts.json)
- [desktop-first-launch](raw\09-desktop-first-launch.json)
- [desktop-stop-bootstrap](raw\11-desktop-stop-bootstrap.json)
- [install-baseline](raw\12-install-baseline.json)
- [sut-installed-dist](raw\14-sut-installed-dist.json)
- [manifest-before](raw\16-manifest-before.json)
- [fixture-published-variant](raw\18-fixture-published-variant.json)
- [desktop-main-launch](raw\20-desktop-main-launch.json)
- [panel-old](raw\21-panel-old.json)
- [panel-after-check](raw\24-panel-after-check.json)
- [disk-after-install](raw\27-disk-after-install.json)
- [ledger-terminal](raw\29-ledger-terminal.json)
- [panel-banner-timeline](raw\30-panel-banner-timeline.json)
- [manifest-after-install](raw\33-manifest-after-install.json)
- [desktop-stop-main](raw\35-desktop-stop-main.json)
- [plugin-manager-operation-operation-yFsXJ3](raw\36-plugin-manager-operation-operation-yFsXJ3.json)
- [plugin-manager-operation-operation-emr17e](raw\37-plugin-manager-operation-operation-emr17e.json)
- [plugin-manager-operations](raw\38-plugin-manager-operations.json)
- [log-fxa-a-2026-11-03](raw\39-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\40-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\41-log-fxa-c-2026-11-03.json)
- [no-restart-proof](raw\42-no-restart-proof.json)
- [ledger-facts](raw\45-ledger-facts.json)
- [cleanup-verify](raw\47-cleanup-verify.json)

## 清理

- 进程 desktop-bootstrap（pid 94756）：停止后存活=false
- 进程 desktop-bootstrap-relaunched-94756（pid 94756）：停止后存活=false
- 进程 desktop-bootstrap-relaunched-9028（pid 9028）：停止后存活=false
- 进程 desktop-bootstrap-relaunched-51132（pid 51132）：停止后存活=false
- 进程 desktop-bootstrap-relaunched-67488（pid 67488）：停止后存活=false
- 进程 desktop-bootstrap-relaunched-26044（pid 26044）：停止后存活=false
- 进程 desktop-main（pid 66648）：停止后存活=false
- 进程 desktop-main（pid 66648）：停止后存活=false
- 端口 desktop-main-port（62201）：已释放=true
- 端口 registry（49550）：已释放=true
- 本地 registry：http://127.0.0.1:49550（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 本场景走官方桌面通道（in-process pluginManager）；面板/在册事实只有桌面宿主有。
- can-red 档到此为止：唯一红点是「安装后运行标记仍为基版内容却宣称已是最新」（step 5），不继续重启断言以免掩盖红点。
- i1 结论口径：desktop-manager 单插件安装是 in-process 热换（安装完成即同一宿主进程内 client+host 两半换到新版本，无 restart-required）；因此本格证明的是「面板说已是最新时运行标记真的是新版，且真重启后不回退」，不是「写盘等重启」。

## 维护者 profile 未污染

- 目录：C:/Users/辰辰洋洋/.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:49550（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 本场景走官方桌面通道（in-process pluginManager）；面板/在册事实只有桌面宿主有。
- can-red 档到此为止：唯一红点是「安装后运行标记仍为基版内容却宣称已是最新」（step 5），不继续重启断言以免掩盖红点。
- i1 结论口径：desktop-manager 单插件安装是 in-process 热换（安装完成即同一宿主进程内 client+host 两半换到新版本，无 restart-required）；因此本格证明的是「面板说已是最新时运行标记真的是新版，且真重启后不回退」，不是「写盘等重启」。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
