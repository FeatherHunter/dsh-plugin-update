# 真机证据索引 · j3-namespace-whitelist

- runId：273-20261103T054540
- 票：#273
- 宿主通道：dsh-web
- 开始/结束：2026-11-02T21:45:40.203Z / 2026-11-02T21:46:01.082Z
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
| 08-assert | 隔离口径（通道 B：普通 DSH web 宿主 + 非 desktop profile） | 每个 run 一个仓库外 home；日志根 = <home>/logs（产品自建落点），命名空间目录按插件身份派生 | homeDir=D:\dsh-plugin\_wt263\runtime\t9-273\273-20261103T054540\os-home\.dsh；profile=t9j3 | osHomeDir=D:\dsh-plugin\_wt263\runtime\t9-273\273-20261103T054540\os-home；homeDir=D:\dsh-plugin\_wt263\runtime\t9-273\273-20261103T054540\os-home\.dsh；profile=t9j3 | **pass** |
| 10-assert | 建普通 profile（通道 B 宿主的使用范围） | 用官方发行 CLI 在隔离 home 建普通 DSH 使用范围 t9j3 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t9-273\273-20261103T054540\os-home\.dsh\profiles\t9j3 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t9-273\273-20261103T054540\os-home\.dsh\profiles\t9j3 | **pass** |
| 12-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 16-assert | 更新前基版在盘 | 隔离 profile 里装着场景声明的基版 0.0.1（日志命名空间随后由它派生） | node_modules/dsh-plugin-update-fixture-a 版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 18-assert | 变体版本已发布（更新目标） | 本地 verdaccio 发布 dsh-plugin-update-fixture-a@0.0.2；其余席位按场景声明一并发布 | dsh-plugin-update-fixture-a@0.0.2；variants=["a"] | dsh-plugin-update-fixture-a@0.0.2；injected=[] | **pass** |
| 21-assert | 真 UI 面板挂载（namespace） | Playwright 打开 web 宿主页面：夹具卡片与更新面板真出现，面板开始轮询 updateStatus | .dsh-upd≥1；[data-fixture]≥1；面板开始轮询 updateStatus | counts={"dshUpd":1,"dshUpdLog":2,"fixture":1}；elapsedMs=1 | **pass** |
| 24-assert | 真 UI 动作与检查事件都落到属主命名空间（面板动作/检查结果各 ≥1 行） | 点「检查更新」= 面板动作（客户端白名单事件）+ 宿主检查完成（常驻事件），两者都只落 fxa-a | update.check.done ≥1（ns=fxa-a）；update.panel.action ≥1（ns=fxa-a）；check done ok=true | checkDone=1；actionRows=1；ok=true | **pass** |
| 26-assert | 面板渲染出日志健康读数（落点/目录指纹/按需开关/丢弃数/最近事件/契约） | 这是 web GUI 上面板能给出的「日志到底有没有、落点是谁」的唯一读数（src/panel/render.ts:1035-1067） | 面板文本含「事件契约=」行；六项读数都能解析 | 健康读数={"text":"日志：落点=self（本包自建落点）；目录指纹=150c0975；按需信息开关=关；启动以来丢弃 0 行；最近事件=11/3 05:45；事件契约=正常","sink":"self","dirHash":"150c0975","switchText":"关","dropped":0,"lastEventText":"11/3 05:45","contract":"正常"} | **pass** |
| 28-assert | 面板读数与磁盘日志同源：落点=self、目录指纹=update.wire.ready 的 logDirHash | UI 说的落点与指纹必须等于日志自己记的接线事实，不许各说各话 | health.sink=self；health.dirHash=150c0975；wire.logSink=self | sink=self；dirHash=150c0975；wire.logDirHash=150c0975；wire.logSink=self | **pass** |
| 30-assert | 按需开关=关、启动以来丢弃=0、事件契约=正常（与磁盘无降级行互证） | 面板读数是最坏情况的措辞源；磁盘侧对应不得出现 update.log.degraded / panel.render.fail | switch=关；dropped=0；contract=正常；degraded 行=0；render.fail 行=0 | switch=关；dropped=0；contract=正常；degraded=0；renderFail=0 | **pass** |
| 32-assert | 最近事件读数与磁盘最新日志行对得上（同一事实，不是缓存字样） | 面板读数是「最近一次把行交给落点的时间」；它应落在磁盘最新一行的同一分钟内 | deltaMs 可算出且 ≤120000（分钟精度） | lastEvent=11/3 05:45；parsedLast=1793655900000；newestTs=1793655956615；deltaMs=56615 | **pass** |
| 34-assert | 客户端事件只出现在属主命名空间、事件名全在白名单内 | 客户端日志走 logAppend 上浮，白名单限定 6 个客户端事件（src/log/client-queue.ts:105）；宿主事实不许由客户端冒充 | clientOutsideOwner=[]；clientEventNames ⊆ ["update.panel.mount","update.panel.action","update.panel.render.fail","update.panel.state","update.lang.applied","update.log.degraded"]；至少含 panel.mount 与 panel.action | names=["update.panel.mount","update.panel.action"]；outside=[] | **pass** |
| 36-assert | 客户端白名单负向真机：伪造 update.install.exec 被拒收、不落盘 | 直接向属主 logAppend 电话送一条「宿主事实」事件；客户端通道必须按协议拒收（只回 accepted/dropped，不抛） | accepted=0；dropped=1；磁盘伪造行=0；exec 行数不变（0） | accepted=0；dropped=1；伪造行=0；execBefore=0；execAfter=0 | **pass** |
| 40-assert | 收尾：真 UI 页面与 CLI 宿主全部退出，无残留进程/端口 | 登记每个宿主的 pid/port 并核对退出；端口释放由 run.close 的 cleanup 复核 | 每个宿主 closed=true；pidAlive=false | [{"label":"main","pid":55284,"port":57296,"closed":true,"pidAlive":false}] | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 37-panel-log-health | 装好 SUT + 夹具 A → 起通道 B 宿主 → Playwright 打开页面 → 点「检查更新」→ 截面板日志区 | web GUI 更新面板第 4 章的日志路牌 + 日志健康读数（落点=self / 目录指纹 / 丢弃数 / 最近事件 / 事件契约） | 面板出现日志健康行，读数与磁盘日志逐项一致 | 日志：落点=self（本包自建落点）；目录指纹=150c0975；按需信息开关=关；启动以来丢弃 0 行；最近事件=11/3 05:45；事件契约=正常 | **pass** | [shots\37-panel-log-health.png](shots\37-panel-log-health.png) |

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
- [panel-open-namespace](raw\20-panel-open-namespace.json)
- [panel-click-check](raw\22-panel-click-check.json)
- [panel-action-rows](raw\23-panel-action-rows.json)
- [panel-log-health](raw\25-panel-log-health.json)
- [wire-ready-vs-health](raw\27-wire-ready-vs-health.json)
- [health-degraded-rows](raw\29-health-degraded-rows.json)
- [health-last-event](raw\31-health-last-event.json)
- [client-event-whitelist](raw\33-client-event-whitelist.json)
- [log-append-forgery](raw\35-log-append-forgery.json)
- [panel-log-health-shot](raw\38-panel-log-health-shot.json)
- [cli-host-close-main](raw\39-cli-host-close-main.json)

## 清理

- 进程 cli-host-main（pid 55284）：停止后存活=false
- 端口 cli-host-main-port（57296）：已释放=true
- 端口 registry（49202）：已释放=true
- 本地 registry：http://127.0.0.1:49202（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- J 组判读口径：web GUI 没有独立的插件日志查看器；面板面 = 更新面板第 4 章的日志路牌 + 日志健康读数（.dsh-upd-log），事件契约/噪声预算/命名空间都从 <home>/logs 磁盘原始行独立统计；UI 只作「面板看得见、读数与磁盘一致」的证据。

## 备注

- 本地 registry：http://127.0.0.1:49202（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- J 组判读口径：web GUI 没有独立的插件日志查看器；面板面 = 更新面板第 4 章的日志路牌 + 日志健康读数（.dsh-upd-log），事件契约/噪声预算/命名空间都从 <home>/logs 磁盘原始行独立统计；UI 只作「面板看得见、读数与磁盘一致」的证据。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
