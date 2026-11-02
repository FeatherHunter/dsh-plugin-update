# 真机证据索引 · j2-noise-budget

- runId：273-20261103T054531
- 票：#273
- 宿主通道：dsh-web
- 开始/结束：2026-11-02T21:45:31.167Z / 2026-11-02T21:50:54.448Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:\dsh-plugin\_wt263\t9（分支 impl/263-t9，HEAD cffcf3c37c5862921fa407bf65ffa11ef81147a2）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c24b0e67a15a3b8dd96584b24d8a68afbaa273c1681d201efc
- SUT dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（208 个文件）
- 安装后 dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c2…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1 | **pass** |
| 08-assert | 隔离口径（通道 B：普通 DSH web 宿主 + 非 desktop profile） | 每个 run 一个仓库外 home；日志根 = <home>/logs（产品自建落点），命名空间目录按插件身份派生 | homeDir=D:\dsh-plugin\_wt263\runtime\t9-273\273-20261103T054531\os-home\.dsh；profile=t9j2 | osHomeDir=D:\dsh-plugin\_wt263\runtime\t9-273\273-20261103T054531\os-home；homeDir=D:\dsh-plugin\_wt263\runtime\t9-273\273-20261103T054531\os-home\.dsh；profile=t9j2 | **pass** |
| 10-assert | 建普通 profile（通道 B 宿主的使用范围） | 用官方发行 CLI 在隔离 home 建普通 DSH 使用范围 t9j2 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t9-273\273-20261103T054531\os-home\.dsh\profiles\t9j2 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t9-273\273-20261103T054531\os-home\.dsh\profiles\t9j2 | **pass** |
| 12-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 16-assert | 更新前基版在盘 | 隔离 profile 里装着场景声明的基版 0.0.1（日志命名空间随后由它派生） | node_modules/dsh-plugin-update-fixture-a 版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 18-assert | 变体版本已发布（更新目标） | 本地 verdaccio 发布 dsh-plugin-update-fixture-a@0.0.2；其余席位按场景声明一并发布 | dsh-plugin-update-fixture-a@0.0.2；variants=["a"] | dsh-plugin-update-fixture-a@0.0.2；injected=[] | **pass** |
| 21-assert | 真 UI 面板挂载（noise-1） | Playwright 打开 web 宿主页面：夹具卡片与更新面板真出现，面板开始轮询 updateStatus | .dsh-upd≥1；[data-fixture]≥1；面板开始轮询 updateStatus | counts={"dshUpd":1,"dshUpdLog":2,"fixture":1}；elapsedMs=2 | **pass** |
| 23-assert | 真 UI 面板挂载（noise-2） | Playwright 打开 web 宿主页面：夹具卡片与更新面板真出现，面板开始轮询 updateStatus | .dsh-upd≥1；[data-fixture]≥1；面板开始轮询 updateStatus | counts={"dshUpd":1,"dshUpdLog":2,"fixture":1}；elapsedMs=1 | **pass** |
| 26-assert | 静置 ≥100 次真 UI 面板轮询：常驻日志零新增（轮询静默、不刷屏） | 两个 Playwright 页面同时开着真面板轮询 updateStatus；窗口内每新增一行都算噪声 | 窗口轮询数≥100；每页≥50；窗口内新增行=0（常驻行=0） | 窗口轮询数=100（每页 53/52）；新增行=0（常驻=0） | **pass** |
| 30-assert | 真 UI 点「检查更新」→ 状态真变化，恰一条 update.status.changed（update-available） | 面板点击发出 updateCheck；宿主侧状态从 unknown 变为 update-available 时才落一行边沿事件 | clicked=true；恰 1 行 kind=update-available；latest=0.0.2 | clicked=true；行数=1；kind=update-available；latest=0.0.2 | **pass** |
| 32-assert | 同一状态再等 ≥20 次轮询：同指纹事件不重复（边沿触发，不是每轮一行） | 状态不变时轮询不得再落 update.status.changed；指纹 = (kind, latest) | 状态变化后新增轮询≥20；update-available 行数仍=1 | 新增轮询=20；update-available 行数=1 | **pass** |
| 34-assert | 真 UI 面板如实显示「有新版本 0.0.2」 | 状态变化后面板下一次轮询把更新可用横幅渲染出来（UI 与日志同一事实） | 面板文本含「有新版本」与 0.0.2 | panelText 片段="dsh-plugin-update-fixture-a 使用范围 t9j2profile 有新版本 0.0.2 可安装（当前版本 0.0.1）。 选择安装将按精确版本安装；同一使用范围同时仅安装一项。 运行版 0.0.1 已安装 0.0.1 最新版 0.0.2 01 检查与安装 检查更新 安装版本 0.0.2 跳过该版本 复制手工命令 复制诊断 02 更新日志 更新说明没取到（网络或完整性校验失败）。 03 更新队列 当前无排队任务；同一使用范围同时仅安装一项。 04 错误信息 暂无失败：此时复制诊断提供的是当前状态快照。 请查看日志：<DSH_HOME>/logs/<derived>（一个插件一棵目录，互不覆盖）。一条命令看：npx dsh-log <log-dir>；按插件标识 dsh-plugin-update-fixture-a 筛选 host.call、host.call.fai" | **pass** |
| 37-assert | 全程日志行预算：每命名空间 ≤500 行，无解析失败行 | 日志是可长期常驻的产物，行预算与可解析性都属于噪声预算的一部分 | overBudget=[]；parseFailures=0 | nsCounts={"fxa-a":16,"fxa-b":2,"fxa-c":2}；totalRows=20；parseFailures=0 | **pass** |
| 39-assert | 收尾：真 UI 页面与 CLI 宿主全部退出，无残留进程/端口 | 登记每个宿主的 pid/port 并核对退出；端口释放由 run.close 的 cleanup 复核 | 每个宿主 closed=true；pidAlive=false | [{"label":"main","pid":40420,"port":57627,"closed":true,"pidAlive":false}] | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 27-panel-before-check | 起通道 B 宿主 → 两个 Playwright 页面打开真面板 → 静置 ≥100 次轮询 → 截 page1 面板 | 点「检查更新」前的真 UI 更新面板（状态未变、面板在每 5s 轮询；日志健康读数同在页面上） | 面板挂载且不含「有新版本」横幅；页面带日志路牌/健康读数 | {"counts":{"dshUpd":1,"dshUpdLog":2,"fixture":1},"panelText":"dsh-plugin-update-fixture-a 使用范围 t9j2profile 已是最新，无需更新。 运行版 0.0.1 已安装 0.0.1 最新版 未知 01 检查与安装 检查更新 安装更新 复制诊断 02 更新日志 尚未查询到新版本；查询到后将显示更新日志。 03 更新队列 当前无排队任务；同一使用范围同时仅安装一项。 04 错误信息 暂无失败：此时复制诊断提供的是当前状态快照。 请查看日志：<DSH_HOME>/logs/<derived>（一个插件一棵目录，互不覆盖）。一条命令看：npx dsh-log <log-dir>；按插件标识 dsh-plugin-update-fi","logTexts":["请查看日志：<DSH_HOME>/logs/<derived>（一个插件一棵目录，互不覆盖）。一条命令看：npx dsh-log <log-dir>；按插件标识 dsh-plugin-update-fixture-a 筛选 host.call、host.call.fail、update.install.exec 事件。","日志：落点=self（本包自建落点）；目录指纹=410b0aeb；按需信息开关=关；启动以来丢弃 0 行；最近事件=11/3 05:45；事件契约=正常"]} | **pass** | [shots\27-panel-before-check.png](shots\27-panel-before-check.png) |
| 35-panel-update-available | 真 UI 点「检查更新」→ 等状态落 update-available → 再等 ≥20 次轮询不重复 → 截 page1 面板 | 点「检查更新」后的真 UI 更新面板：有新版本横幅 + 日志健康读数（同一页） | 面板文本含「有新版本」与 0.0.2；日志健康读数仍在 | {"counts":{"dshUpd":1,"dshUpdLog":2,"fixture":1},"panelText":"dsh-plugin-update-fixture-a 使用范围 t9j2profile 有新版本 0.0.2 可安装（当前版本 0.0.1）。 选择安装将按精确版本安装；同一使用范围同时仅安装一项。 运行版 0.0.1 已安装 0.0.1 最新版 0.0.2 01 检查与安装 检查更新 安装版本 0.0.2 跳过该版本 复制手工命令 复制诊断 02 更新日志 更新说明没取到（网络或完整性校验失败）。 03 更新队列 当前无排队任务；同一使用范围同时仅安装一项。 04 错误信息 暂无失败：此时复制诊断提供的是当前状态快照。 请查看日志：<DSH_HOME>/logs/<derived>（一个插件一棵目录，互不覆盖）。一条命令看：npx dsh-log <log-dir>；按插件标识 dsh-plugin-update-fixture-a 筛选 host.call、host.call.fai","logTexts":["请查看日志：<DSH_HOME>/logs/<derived>（一个插件一棵目录，互不覆盖）。一条命令看：npx dsh-log <log-dir>；按插件标识 dsh-plugin-update-fixture-a 筛选 host.call、host.call.fail、update.install.exec 事件。","日志：落点=self（本包自建落点）；目录指纹=410b0aeb；按需信息开关=关；启动以来丢弃 0 行；最近事件=11/3 05:50；事件契约=正常"]} | **pass** | [shots\35-panel-update-available.png](shots\35-panel-update-available.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [isolation-facts](raw\07-isolation-facts.json)
- [profile-create](raw\09-profile-create.json)
- [install-baseline](raw\11-install-baseline.json)
- [sut-installed-dist](raw\13-sut-installed-dist.json)
- [baseline-disk](raw\15-baseline-disk.json)
- [fixture-published-variants](raw\17-fixture-published-variants.json)
- [cli-host-launch-main](raw\19-cli-host-launch-main.json)
- [panel-open-noise-1](raw\20-panel-open-noise-1.json)
- [panel-open-noise-2](raw\22-panel-open-noise-2.json)
- [noise-window-start](raw\24-noise-window-start.json)
- [noise-window-end](raw\25-noise-window-end.json)
- [panel-click-check](raw\28-panel-click-check.json)
- [panel-check-result](raw\29-panel-check-result.json)
- [noise-repeat-window](raw\31-noise-repeat-window.json)
- [panel-final-text](raw\33-panel-final-text.json)
- [noise-budget-final](raw\36-noise-budget-final.json)
- [cli-host-close-main](raw\38-cli-host-close-main.json)

## 清理

- 进程 cli-host-main（pid 40420）：停止后存活=false
- 端口 cli-host-main-port（57627）：已释放=true
- 端口 registry（63324）：已释放=true
- 本地 registry：http://127.0.0.1:63324（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- J 组判读口径：web GUI 没有独立的插件日志查看器；面板面 = 更新面板第 4 章的日志路牌 + 日志健康读数（.dsh-upd-log），事件契约/噪声预算/命名空间都从 <home>/logs 磁盘原始行独立统计；UI 只作「面板看得见、读数与磁盘一致」的证据。

## 备注

- 本地 registry：http://127.0.0.1:63324（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- J 组判读口径：web GUI 没有独立的插件日志查看器；面板面 = 更新面板第 4 章的日志路牌 + 日志健康读数（.dsh-upd-log），事件契约/噪声预算/命名空间都从 <home>/logs 磁盘原始行独立统计；UI 只作「面板看得见、读数与磁盘一致」的证据。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
