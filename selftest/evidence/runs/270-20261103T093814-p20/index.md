# 真机证据索引 · h2-queue-lock-stale-reclaim

- runId：270-20261103T093814-p20
- 票：#270
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T01:38:34.613Z / 2026-11-03T01:38:51.291Z
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
| 08-assert | 隔离口径（两宿主同 home = 同一 USERPROFILE/.dsh） | 两个通道 B 宿主用同一个 USERPROFILE/osHomeDir 与同一个 homeDir（= osHomeDir/.dsh），profile 名不是 desktop（P1 探针证明 desktop 被官方桌面独占） | homeDir=D:\dsh-plugin\_wt263\runtime\t11-275\270-20261103T093814-p20\os-home\.dsh；profileName=t6lock | osHomeDir=D:\dsh-plugin\_wt263\runtime\t11-275\270-20261103T093814-p20\os-home；homeDir=D:\dsh-plugin\_wt263\runtime\t11-275\270-20261103T093814-p20\os-home\.dsh；profileName=t6lock | **pass** |
| 10-assert | 建普通 profile（CLI 入口） | 用官方发行 CLI 在隔离 home 建普通 DSH 使用范围 t6lock；profileDir 决定 update-queue 的短哈希目录名 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t11-275\270-20261103T093814-p20\os-home\.dsh\profiles\t6lock | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t11-275\270-20261103T093814-p20\os-home\.dsh\profiles\t6lock | **pass** |
| 12-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 15-assert | 更新前基版在盘 | 隔离 profile 的 node_modules 里是场景声明的基版 0.0.1（更新前状态） | 磁盘版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 18-assert | 变体版发布（更新目标） | 按场景声明发布变体 dsh-plugin-update-fixture-a@0.0.2（UI/行为随版本变，重启后可自证） | 本地 registry 可见版本含 0.0.2 | registry 版本=["0.0.1","0.0.2"] | **pass** |
| 21-assert | 预写陈旧 global.lock | 按产品 payload 形状 {id,pluginId,pid,startedAt} 预写一把锁：pid 用必然不存在的 999999、startedAt 取 60s 前；宿主安装预算压到 4s | 锁文件存在且内容是合法 JSON；pid 不存活；age≈60000ms > 安装预算 4000ms | pidAlive=false；inspect={"id":"selftest-stale-20261103T093814-p20","pluginId":"fxa-a","pid":999999,"startedAt":1793669865600} | **pass** |
| 24-assert | 入口 a check 电话（发现新版） | 宿主里的电话入口 updateCheck 返回快照：运行版=0.0.1、最新版=0.0.2、可安装，并给候选凭证 checkId | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true；receipt.checkId 非空 | ok=true；runningVersion=0.0.1；latestVersion=0.0.2；canInstall=true；checkId="8effdd48-2913-4462-b364-e66dcae47056" | **pass** |
| 26-assert | 陈旧锁格安装受理 | 带候选凭证的 updateInstall 应受理（先回收陈旧锁再安装） | ok=true；job.state ∈ {installing, verifying} | install: ok=true；job.state=installing；error=null；http=200；durationMs=57 | **pass** |
| 28-assert | 陈旧锁回收后安装到终态 | 回收陈旧锁后继续安装，作业应进入成功终态（restart-required，进程未重启） | job.state ∈ {restart-required, completed} | job.state=completed；timedOut=false | **pass** |
| 37-assert | 陈旧锁判定：stale-owner 且 ownerHash/age 对得上 | 抢锁路径二次核对后判陈旧：应恰 1 条 lock.anomaly(kind=stale-owner)，ageMs≈60000、ownerHash 为预写锁 payload 的 hash8；不应出现 busy-owner（把陈旧锁误判为新鲜） | stale-owner=1；ageMs≥59000；ownerHash=a044b8e0；busy-owner=0 | stale-owner=1；ageMs=62629；ownerHash=a044b8e0；busy-owner=0 | **pass** |
| 38-assert | 队列跃迁 reclaimed 且回收后继续安装 | 回收成功应记 1 条 update.queue.transition(phase=reclaimed)，holderHash=hash8(pluginId)；随后安装照常完成 | reclaimed=1；holderHash=0f7833d2；exec=1 且 ok/exit0 | reclaimed=1；holderHash=0f7833d2；exec=1；execOk=true；exit=0 | **pass** |
| 39-assert | 锁时间线：旧 id 被换掉、最终释放 | 预写的陈旧锁 id 与安装期间的新锁 id 都应在时间线里出现（旧 id 不会被旧 id 释放，新锁覆盖后最终 absent） | 锁 id 数=2（selftest-stale-20261103T093814-p20 + 新 id）；末次采样 lockPresent=false | 锁 id=["selftest-stale-20261103T093814-p20","5114e4ea-f454-49dc-b6d7-add6d3e9d95b"]；区间数=1；末次 lockPresent=false | **pass** |
| 41-assert | 队列跃迁完整（queued/reclaimed/running/done） | 陈旧锁格应看到排队、回收、运行、完成四类跃迁，且 reclaimed 恰好一条 | queued≥1；reclaimed=1；running≥1；done≥1 | {"queued":1,"reclaimed":1,"running":1,"done":1} | **pass** |
| 43-assert | profile 未损坏（after-stale-reclaim） | 更新后 profile 的 package.json 可解析、dependencies 与 node_modules 磁盘版本都是 0.0.2、bundles 仍含该包（无半写/无双装） | dependencies=0.0.2；磁盘版本=0.0.2；bundles 含 dsh-plugin-update-fixture-a | dependencies=0.0.2；磁盘版本=0.0.2；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；package.json 可解析=true | **pass** |
| 45-assert | 台账恰一条成功终态（after-stale-reclaim） | 每个 profile 一份 update 台账（<home>/updates/<pluginId>/<shortHash(profileDir)>/state.json）：恰一条 targetVersion=0.0.2 的成功终态，无重复成功、无丢单 | target 台账=1 条；state ∈ {completed, restart-required}；requestId=h2-stale-1793669928205 | target 台账=1；成功终态=1；requestIds=["h2-stale-1793669928205"]；全部台账=[{"file":"D:\\dsh-plugin\\_wt263\\runtime\\t11-275\\270-20261103T093814-p20\\os-home\\.dsh\\updates\\fxa-a\\d2d597a0addf1c9e712e324b\\state.json","state":"completed","target":"0.0.2"}] | **pass** |
| 47-assert | 队列收尾：owner=null、无残留占位 | 单意图陈旧锁格：唯一意图被 owner 消费，完成后释放 owner；收尾 queue.json 应为空队列 | owner=null；waiting=[] | owner=null；waiting 条数=0 | **pass** |
| 49-assert | 收尾（无宿主残留、端口释放） | 两个入口宿主（以及重启校验宿主）都已停止，进程不存在、端口已释放 | 所有宿主 pid 不再存活；所有宿主端口空闲 | 进程=[{"label":"cli-host-a","pid":2792,"aliveAfterStop":false}]；端口=[{"label":"cli-host-a-port","port":64071,"free":true}] | **pass** |

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
- [stale-install-timeout-config](raw\19-stale-install-timeout-config.json)
- [stale-lock-precreated](raw\20-stale-lock-precreated.json)
- [cli-host-launch-a](raw\22-cli-host-launch-a.json)
- [phone-update-check-a](raw\23-phone-update-check-a.json)
- [phone-update-install-a](raw\25-phone-update-install-a.json)
- [phone-status-terminal](raw\27-phone-status-terminal.json)
- [lock-absent-after-install](raw\29-lock-absent-after-install.json)
- [log-fxa-a-2026-11-03](raw\30-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\31-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\32-log-fxa-c-2026-11-03.json)
- [logs-after-stale-reclaim](raw\33-logs-after-stale-reclaim.json)
- [lock-queue-timeline](raw\34-lock-queue-timeline.json)
- [exec-windows](raw\35-exec-windows.json)
- [stale-reclaim-events](raw\36-stale-reclaim-events.json)
- [queue-transitions](raw\40-queue-transitions.json)
- [disk-after-after-stale-reclaim](raw\42-disk-after-after-stale-reclaim.json)
- [ledger-states](raw\44-ledger-states.json)
- [queue-final](raw\46-queue-final.json)
- [cleanup-facts](raw\48-cleanup-facts.json)

## 清理

- 进程 cli-host-a（pid 2792）：停止后存活=false
- 端口 cli-host-a-port（64071）：已释放=true
- 端口 registry（57684）：已释放=true
- 本地 registry：http://127.0.0.1:57684（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 两个宿主共享同一 home/profile 是为了共享同一把 global.lock；sessions/storages 等其它状态串台不在本组断言范围。
- 安装窗口用 update.install.exec 的 ts 与 durationMs 还原（[ts-durationMs, ts]），锁/队列用 10ms 轮询时间线判定，不用 UI。

## 维护者 profile 未污染

- 目录：C:/Users/辰辰洋洋/.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:57684（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 两个宿主共享同一 home/profile 是为了共享同一把 global.lock；sessions/storages 等其它状态串台不在本组断言范围。
- 安装窗口用 update.install.exec 的 ts 与 durationMs 还原（[ts-durationMs, ts]），锁/队列用 10ms 轮询时间线判定，不用 UI。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
