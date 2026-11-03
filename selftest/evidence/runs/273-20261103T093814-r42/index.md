# 真机证据索引 · j1-log-contract-coverage

- runId：273-20261103T093814-r42
- 票：#273
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T01:50:16.945Z / 2026-11-03T01:50:37.010Z
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
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1, dsh-plugin-update-fixture-b@0.0.1, dsh-plugin-update-fixture-c@0.0.1 | **pass** |
| 08-assert | 隔离口径（通道 B：普通 DSH web 宿主 + 非 desktop profile） | 每个 run 一个仓库外 home；日志根 = <home>/logs（产品自建落点），命名空间目录按插件身份派生 | homeDir=D:\dsh-plugin\_wt263\runtime\t11-275\273-20261103T093814-r42\os-home\.dsh；profile=t9j1c | osHomeDir=D:\dsh-plugin\_wt263\runtime\t11-275\273-20261103T093814-r42\os-home；homeDir=D:\dsh-plugin\_wt263\runtime\t11-275\273-20261103T093814-r42\os-home\.dsh；profile=t9j1c | **pass** |
| 10-assert | 建普通 profile（通道 B 宿主的使用范围） | 用官方发行 CLI 在隔离 home 建普通 DSH 使用范围 t9j1c | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t11-275\273-20261103T093814-r42\os-home\.dsh\profiles\t9j1c | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t11-275\273-20261103T093814-r42\os-home\.dsh\profiles\t9j1c | **pass** |
| 12-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | 干净 profile 装基版（c） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-c@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-c；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b, dsh-plugin-update-fixture-c]；磁盘版本=0.0.1；exit=0 | **pass** |
| 16-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 18-assert | 更新前基版在盘 | 隔离 profile 里装着场景声明的基版 0.0.1（日志命名空间随后由它派生） | node_modules/dsh-plugin-update-fixture-a 版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 20-assert | 变体版本已发布（更新目标） | 本地 verdaccio 发布 dsh-plugin-update-fixture-a@0.0.2；其余席位按场景声明一并发布 | dsh-plugin-update-fixture-a@0.0.2；variants=["a","b","c"] | dsh-plugin-update-fixture-a@0.0.2；injected=[] | **pass** |
| 24-assert | can-red 前置：真安装确实产生 exec 行（否则后面的红点不可归因） | can-red 要证明的是「删掉契约后真 exec 行被判未知」，前提是真机真发过这一行 | exec 行 ≥1（pluginId=fxa-a） | exec 行数=1；matched=true | **pass** |
| 26-assert | can-red 前置：真实事件契约下这批日志四关全过（红点后来才可归因到注入） | 同一批磁盘日志先对仓库里的 event-list.update.json 校验一遍，证明日志本身不脏 | unknownEvents=0；level/field/enum 违规=0；checkedRows>0 | {"checkedRows":15,"unknownEvents":[],"levelMismatches":[],"fieldViolations":[],"enumViolations":[]} | **pass** |
| 29-assert | can-red：删掉本 run 私有契约里的 update.install.exec → 真 exec 行必须被判成未知事件（本 run 必须红） | 注入点 = run 私有副本 D:\dsh-plugin\_wt263\runtime\t11-275\273-20261103T093814-r42\can-red-event-list.json（产品文件未动）；被破坏的检查 = 事件名覆盖关 | injectedReport.unknownEvents 含 update.install.exec；本 run verdict=fail / exitCode=1 | removedEvent=true；unknownEvents=["update.install.exec"]；exec 未知行数=1 | **fail** |
| 31-assert | 收尾：真 UI 页面与 CLI 宿主全部退出，无残留进程/端口 | 登记每个宿主的 pid/port 并核对退出；端口释放由 run.close 的 cleanup 复核 | 每个宿主 closed=true；pidAlive=false | [{"label":"can-red","pid":23976,"port":63833,"closed":true,"pidAlive":false}] | **pass** |

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
- [sut-installed-dist](raw\15-sut-installed-dist.json)
- [baseline-disk](raw\17-baseline-disk.json)
- [fixture-published-variants](raw\19-fixture-published-variants.json)
- [cli-host-launch-can-red](raw\21-cli-host-launch-can-red.json)
- [can-red-install-request](raw\22-can-red-install-request.json)
- [can-red-exec-rows](raw\23-can-red-exec-rows.json)
- [can-red-manifest-clean](raw\25-can-red-manifest-clean.json)
- [can-red-injection](raw\27-can-red-injection.json)
- [can-red-contract-report](raw\28-can-red-contract-report.json)
- [cli-host-close-can-red](raw\30-cli-host-close-can-red.json)

## 清理

- 进程 cli-host-can-red（pid 23976）：停止后存活=false
- 端口 cli-host-can-red-port（63833）：已释放=true
- 端口 registry（55747）：已释放=true
- 本地 registry：http://127.0.0.1:55747（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- J 组判读口径：web GUI 没有独立的插件日志查看器；面板面 = 更新面板第 4 章的日志路牌 + 日志健康读数（.dsh-upd-log），事件契约/噪声预算/命名空间都从 <home>/logs 磁盘原始行独立统计；UI 只作「面板看得见、读数与磁盘一致」的证据。

## 维护者 profile 未污染

- 目录：C:/Users/辰辰洋洋/.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:55747（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- J 组判读口径：web GUI 没有独立的插件日志查看器；面板面 = 更新面板第 4 章的日志路牌 + 日志健康读数（.dsh-upd-log），事件契约/噪声预算/命名空间都从 <home>/logs 磁盘原始行独立统计；UI 只作「面板看得见、读数与磁盘一致」的证据。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
