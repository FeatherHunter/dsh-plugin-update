# 真机证据索引 · h1-queue-lock-concurrent

- runId：270-20261103T004915
- 票：#270
- 宿主通道：dsh-web
- 开始/结束：2026-11-02T16:49:15.503Z / 2026-11-02T16:49:40.636Z
- 总判定：**fail**（退出码 1）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:\dsh-plugin\_wt263\t6（分支 impl/263-t6，HEAD 025e50a2549a862bb1a197264529a02633f88031）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 80cbd584d05efe8dd1a14cfc01dcb9149a3bc29e0d8592cff33d8f5896436312
- SUT dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（208 个文件）
- 安装后 dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 80cbd584d05efe8d…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1 | **pass** |
| 08-assert | 隔离口径（两宿主同 home = 同一 USERPROFILE/.dsh） | 两个通道 B 宿主用同一个 USERPROFILE/osHomeDir 与同一个 homeDir（= osHomeDir/.dsh），profile 名不是 desktop（P1 探针证明 desktop 被官方桌面独占） | homeDir=D:\dsh-plugin\_wt263\runtime\t6-270\270-20261103T004915\os-home\.dsh；profileName=t6lock | osHomeDir=D:\dsh-plugin\_wt263\runtime\t6-270\270-20261103T004915\os-home；homeDir=D:\dsh-plugin\_wt263\runtime\t6-270\270-20261103T004915\os-home\.dsh；profileName=t6lock | **pass** |
| 10-assert | 建普通 profile（CLI 入口） | 用官方发行 CLI 在隔离 home 建普通 DSH 使用范围 t6lock；profileDir 决定 update-queue 的短哈希目录名 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t6-270\270-20261103T004915\os-home\.dsh\profiles\t6lock | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t6-270\270-20261103T004915\os-home\.dsh\profiles\t6lock | **pass** |
| 12-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 15-assert | 更新前基版在盘 | 隔离 profile 的 node_modules 里是场景声明的基版 0.0.1（更新前状态） | 磁盘版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 18-assert | 变体版发布（更新目标） | 按场景声明发布变体 dsh-plugin-update-fixture-a@0.0.2（UI/行为随版本变，重启后可自证） | 本地 registry 可见版本含 0.0.2 | registry 版本=["0.0.1","0.0.2"] | **pass** |
| 23-assert | 入口 a check 电话（发现新版） | 宿主里的电话入口 updateCheck 返回快照：运行版=0.0.1、最新版=0.0.2、可安装，并给候选凭证 checkId | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true；receipt.checkId 非空 | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true；checkId="c9d0b803-55f6-4a5d-84c4-8449d3e277fd" | **pass** |
| 25-assert | 入口 b check 电话（发现新版） | 宿主里的电话入口 updateCheck 返回快照：运行版=0.0.1、最新版=0.0.2、可安装，并给候选凭证 checkId | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true；receipt.checkId 非空 | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true；checkId="bf485f0c-55e9-4322-a2cb-46960f7573b3" | **pass** |
| 38-assert | can-red：删全局锁+自家锁后第二入口是否越过锁（预期红） | 入口 1 受理并持有 global.lock + install.lock 时，harness 删除两把锁并把 queue.json 置空（模拟锁与队列状态一起丢失），立刻让入口 2 对同一 target 发安装：若互斥依赖这些持久状态，第二入口会越过锁被受理或两 exec 窗口重叠（预期红） | can-red 预期红：入口 2 被受理（ok=true/job installing）或 update.install.exec ≥2 且窗口重叠 | admittedB=true；exec 行数=2；重叠=true；A=A: ok=true；job.state=installing；error=null；http=200；durationMs=82；B=B: ok=true；job.state=installing；error=null；http=200；durationMs=169 | **fail** |
| 41-assert | 收尾（无宿主残留、端口释放） | 两个入口宿主（以及重启校验宿主）都已停止，进程不存在、端口已释放 | 所有宿主 pid 不再存活；所有宿主端口空闲 | 进程=[{"label":"cli-host-a","pid":68072,"aliveAfterStop":false},{"label":"cli-host-b","pid":62536,"aliveAfterStop":false}]；端口=[{"label":"cli-host-a-port","port":61007,"free":true},{"label":"cli-host-b-port","port":49325,"free":true}] | **pass** |

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
- [queue-lock-paths](raw\16-queue-lock-paths.json)
- [fixture-published-variant](raw\17-fixture-published-variant.json)
- [cli-host-launch-a](raw\19-cli-host-launch-a.json)
- [cli-host-launch-b](raw\20-cli-host-launch-b.json)
- [two-hosts-same-profile](raw\21-two-hosts-same-profile.json)
- [phone-update-check-a](raw\22-phone-update-check-a.json)
- [phone-update-check-b](raw\24-phone-update-check-b.json)
- [phone-update-install-a](raw\26-phone-update-install-a.json)
- [can-red-locks-before-delete](raw\27-can-red-locks-before-delete.json)
- [can-red-locks-deleted](raw\28-can-red-locks-deleted.json)
- [phone-update-install-b](raw\29-phone-update-install-b.json)
- [can-red-admission](raw\30-can-red-admission.json)
- [can-red-terminals](raw\31-can-red-terminals.json)
- [log-fxa-a-2026-11-03](raw\32-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\33-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\34-log-fxa-c-2026-11-03.json)
- [logs-after-can-red](raw\35-logs-after-can-red.json)
- [lock-queue-timeline](raw\36-lock-queue-timeline.json)
- [can-red-exec-windows](raw\37-can-red-exec-windows.json)
- [can-red-disk-and-ledger](raw\39-can-red-disk-and-ledger.json)
- [cleanup-facts](raw\40-cleanup-facts.json)

## 清理

- 进程 cli-host-a（pid 68072）：停止后存活=false
- 进程 cli-host-b（pid 62536）：停止后存活=false
- 端口 cli-host-a-port（61007）：已释放=true
- 端口 cli-host-b-port（49325）：已释放=true
- 端口 registry（55469）：已释放=true
- 本地 registry：http://127.0.0.1:55469（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 两个宿主共享同一 home/profile 是为了共享同一把 global.lock；sessions/storages 等其它状态串台不在本组断言范围。
- 安装窗口用 update.install.exec 的 ts 与 durationMs 还原（[ts-durationMs, ts]），锁/队列用 10ms 轮询时间线判定，不用 UI。
- can-red：删除全局锁+自家锁后第二安装越过锁（预期红，run 判 fail/exit1）。

## 备注

- 本地 registry：http://127.0.0.1:55469（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 两个宿主共享同一 home/profile 是为了共享同一把 global.lock；sessions/storages 等其它状态串台不在本组断言范围。
- 安装窗口用 update.install.exec 的 ts 与 durationMs 还原（[ts-durationMs, ts]），锁/队列用 10ms 轮询时间线判定，不用 UI。
- can-red：删除全局锁+自家锁后第二安装越过锁（预期红，run 判 fail/exit1）。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
