# #272 T8：在册/拓扑真话与两通道差异（i1 热换、i2 未登记诚实、i3 补偿）决策笔记

日期：2026-11-03。工作树：`D:/dsh-plugin/_wt263/t8`（分支 `impl/263-t8`，基线 `145cdd9` = `integration/spec-263` tip 合入 T0–T5、#264～#271）。定稿证据的 SUT commit：`43f6149`（先提交场景/工具，让 4 个定稿 run 都跑在干净 HEAD 上）。

## 1. 一句话结论

三格场景 + 一格 can-red 全部按预期收口：**i1 官方桌面 in-process 热换 pass**（装完同一宿主进程即 v0.0.2，面板「已是最新」不是写盘假绿；真重启不回退），**i2 通道 B 未登记诚实 known-red / 退出码 0**（真安装走 `cli-process`、安装瞬间 verify 行 `restart-required/pendingRestart=true`；未重启时磁盘 0.0.2 而宿主 `buildTag` 仍基版；摘在册真重启确实不加载、写回再重启才加载 0.0.2；37-assert 如实暴露「updateStatus 按磁盘宣称运行版」的产品真相边界），**i3 拓扑补偿 pass**（remove 步超时失败 + 三档补偿文案与 manifest 在册事实一致，载体命令可重装恢复），**can-red fail / 退出码 1**（stale-variant：面板说「已是最新」而卡片 client/host 仍 v0.0.1，恰 1 条红、可归因）。本票未发现需要修产品代码的 BUG；新增 2 条 known-red（均为「条件不可达/需集成方注入」型，不伪造真机结果）。

## 2. 设计与路线

### 2.1 为什么 i2 不能用官方桌面（A-prime 等价边界）

P1 探针（T6 `runtime/t6-270/probes/p1-raw.json` cases[0]，仓库外原始输出）证明产品 CLI 明确拒绝桌面 profile：

```
$ dsh web --profile desktop ...
error: profile "desktop" is managed exclusively by the Electron application
（exit 1）
```

而官方桌面只吃 `desktop` profile。因此「同一个宿主里先真安装、再把插件移出在册、再真重启」这一串在**同一个 profile** 上做不到跨通道。i2 采用 A-prime：**通道 B（普通 DSH web 宿主、非 desktop profile `t8i2`）做真安装/真重启/真未加载**，面板文案分支降 known-red。等价边界如实写清：

| 环节 | A-prime 做法 | 真机真值程度 |
| --- | --- | --- |
| 真安装 | 电话 `updateInstall` → `update.install.exec route=cli-process` 真 pnpm 安装 | 真（与用户点面板「安装」同一产品路径） |
| 安装瞬间真话 | `update.install.verify` 行 `restart-required/pendingRestart=true` | 真 |
| 未重启 | 磁盘 0.0.2、宿主进程 `buildTag=host v0.0.1`（不热换） | 真 |
| 摘在册 | web profile 无 `dsh.profile.bundles` 层 → 在册=`dependencies`；从清单删除夹具条目（raw 前后原文） | 语义等价（产品 `registered` 判定同源 `src/core/reader.ts:45-51,355-361`） |
| 真重启未加载 | 关宿主→同 home/profile 重开→夹具 `buildTag` 电话 405/不可达、宿主页面仍可用 | 真 |
| 恢复登记 | 写回 dependencies（raw 前后原文） | 语义等价 |
| 恢复后真加载 | 再重启 → `buildTag=host v0.0.2`、磁盘/运行/清单一致、fresh `canInstall=false` | 真 |
| 面板「未登记/重启也不会加载」文案 | 通道 B 无桌面面板；该文案分支不可达 | 降 known-red（见 §4 第一行） |

### 2.2 四个 mode → 三条声明

| mode | 场景声明 id | 用途 |
| --- | --- | --- |
| `restart-truth` | `i1-restart-enrollment-truth` | 官方桌面热换真话 + 真重启不回退 + 在册/磁盘/DOM 一致 |
| `unregistered-honesty` | `i2-unregistered-honesty` | 通道 B 真安装 → 未重启不假称生效 → 摘在册真重启不加载 → 写回真加载 |
| `lock-remove-timeout` | `i3-topology-compensation` | 已装包文件独占锁 + 安装预算 4s → remove 超时 → 三档补偿文案与在册事实一致 → 载体命令恢复 |
| `can-red` | 复用 `i1-restart-enrollment-truth` | stale-variant：版本号新、内容旧 → 面板「已是最新」但卡片仍 v0.0.1，预期红 |

### 2.3 关键观测面

- **i1**：官方桌面真 UI（检查更新 → 安装更新）；安装窗内只轮询磁盘/台账；停宿主后读递归日志 `update.install.exec`、`host.start` 时间线、`capturePluginManagerOperations` 的 `.plugin-manager/logs/operation-*/pnpm.log`；再真重启同 profile 看面板卡片与版本条。
- **i2**：通道 B `startCliHost` + 电话 `updateCheck/updateInstall/updateStatus`；判安装窗口用 `update.install.exec`（route/ok/exitCode/durationMs/pluginId）+ `update.install.verify` 行；`buildTag` 电话自证宿主进程里跑的是哪版；摘/写登记用原始清单前后原文入 raw。
- **i3**：PowerShell 对 `node_modules/dsh-plugin-update-fixture-a/lib/index.js` 持独占句柄 240s（`[System.IO.File]::Open(...,"Open","Read","Read")`）+ `DSH_SELFTEST_INSTALL_TIMEOUT_MS=4000`；断言失败定局、补偿档位、文案↔manifest 一致性、载体命令可执行。
- **隔离**：每 run 独立 `DSH_HOME`、独立 `--user-data-dir`、独立端口、仓库外 verdaccio（run 内独立 storage）；官方桌面全局单实例，桌面场景之间串行。

## 3. 逐格做法与证据

四条定稿 run 的 `run.json.environment.head` 都是 `43f6149`，`sut.distDigest=e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc`、`tarballSha256=3502f4da6b9116c24b0e67a15a3b8dd96584b24d8a68afbaa273c1681d201efc`、`installedDistMatch=true`；`cleanup` 段所有进程 `aliveAfterStop=false`、端口 `released=true`。

### 3.1 i1：官方桌面热换与重启不回退（run `272-20261103T040926`，pass / 退出码 0 / 19 断言 / 4 图 / 32 raw）

动作：干净 `desktop` profile CLI 装 A@0.0.1 → 起官方桌面 → 真 UI「检查更新」→「安装更新」→ 轮询磁盘到 0.0.2 + 台账到终态 → 面板轮询到「已是最新」并截图 → 停宿主读日志/operations → 真重启同 profile 看卡片。

- `31-assert`（核心）：安装后同一进程内 `banner=「已是最新，无需更新。」`、`clientTag=client v0.0.2`、`hostTag=host v0.0.2`、`versions[0]=0.0.2`——**热换真生效，不是写盘假绿**。
- `43/44-assert`：`update.install.exec` 恰 1 行：`route=desktop-manager, ok=true, exitCode=0, durationMs=3433, pluginId=fxa-a`（ts=1793650281041）；同一安装窗（1793650276512–1793650286067）内 `host.start` 行数=0（`raw/42-no-restart-proof.json`：wire 行 6、原始行 27）。
- operations 时间线（`raw/38-plugin-manager-operations.json`）：`operation-kNd4kw` 先 remove A@0.0.1（pnpm.log 462B，`- dsh-plugin-update-fixture-a 0.0.1`）→ `operation-ROjbVE` 再 install A@0.0.2（873B，`+ dsh-plugin-update-fixture-a 0.0.2`）。
- `34-assert`：安装后 banner 不含「重启宿主后生效」——桌面热换不该说等重启。
- `46-assert`：台账恰 1 条成功终态 `completed / target=0.0.2 / previous=0.0.1`，无重复、无丢单。
- `49/52-assert`：真重启后（`raw/47-desktop-restart-launch.json`）面板仍 `client v0.0.2`/`host v0.0.2`/`0.0.2`；`raw/51-three-face-after-restart.json`：`dependencies={"dsh-plugin-update-fixture-a":"0.0.2"}`、`bundles=[base, web-app, fixture-a]`、`diskVersion=0.0.2`、`runningVersion=0.0.2`——四面对齐、不回退。
- `55-assert`：收尾全部桌面进程 `aliveAfterStop=false`、端口 released。
- 截图：`23-shot`（旧面板）、`26-shot`（检查后可更新）、`32-shot`（安装后已是最新）、`50-shot`（重启后仍新版）。

### 3.2 i2：未登记诚实（run `272-20261103T040932`，known-red / 退出码 0 / 25 断言 = 24 pass + 1 known-red / 0 图 / 37 raw）

动作：建 web profile `t8i2` → 装 A@0.0.1 → 起通道 B 宿主 → 电话 check/install → 轮询 updateStatus 到终态 → 未重启读 buildTag/磁盘 → 摘 dependencies（raw 前后原文）→ 关宿主、真重启 → 夹具电话 + 页面 → 写回 dependencies → 再真重启 → 电话/磁盘/fresh check → 台账。

- `23/25-assert`：宿主进程 `buildTag=host v0.0.1`；`updateCheck` 发现 0.0.2、`canInstall=true`、checkId 非空。
- `27-assert`：`updateInstall` 回包是**受理快照**（`job.state=installing`、`blockedReason=null`），不是终态——这是产品设计（`src/core/service.ts:1027-1120` 先 saveJob(installing) 再 void runBackground）。
- `31-assert`：`update.install.exec` 恰 1 行：`route=cli-process, ok=true, exitCode=0, durationMs=2368, pluginId=fxa-a`（`raw/30-update-install-exec-rows.json`）——真安装、走 CLI 子进程出口。
- `33-assert`（安装瞬间真话）：`update.install.verify` 行 `result=restart-required, pendingRestart=true, installedVersion=0.0.2`（`raw/32-update-install-verify-rows.json`；产品 `src/core/service.ts:862-866`）。
- `35-assert`：未重启时磁盘 0.0.2，而宿主 `buildTag=host v0.0.1`——**通道 B 不热换**（与 i1 相反，正是 I 组要证的差别）。
- `37-assert`（known-red）：稍后 `updateStatus` 已把 job heal 成 `completed、runningVersion=0.0.2、blockedReason=null`，但 `buildTag=host v0.0.1`（`raw/36-pre-restart-terminal-claim.json`）。条件与后续见 §4 第二行。
- `40/44/49-assert`：摘登记 raw 记录清单前后原文；真重启后夹具 `buildTag` 电话 `405/null`（确实不加载），宿主页面 `303`（token 跳转、宿主仍正常）；页面/日志原文留档。
- `52/55/57-assert`：写回清单后再真重启 → `buildTag=host v0.0.2`、`runningVersion=0.0.2`、`installedVersion=0.0.2`、磁盘 0.0.2、fresh `canInstall=false`——「恢复登记后真加载」不是空话。
- `59-assert`：台账恰 1 条成功终态 `completed / target=0.0.2 / previous=0.0.1`。
- `62-assert`：三代 CLI 宿主进程（main/unregistered/registered）全部 `aliveAfterStop=false`、端口 released。

### 3.3 i3：拓扑补偿（run `272-20261103T041348`，pass / 退出码 0 / 19 断言 / 1 图 / 31 raw）

动作：装 A@0.0.1 → 起桌面（`DSH_SELFTEST_INSTALL_TIMEOUT_MS=4000`）→ 真 UI 检查更新 → PowerShell 独占打开已装包 `lib/index.js`（`raw/24-file-lock-acquired.json`：`targetPath=...\node_modules\dsh-plugin-update-fixture-a\lib\index.js`、`lockPid=66800`、持锁 240s）→ 点安装 → 轮询台账到 `failed` → 读文案/manifest/包目录/operations → 释放锁 → 按载体命令重装 → 重启看 0.0.2。

- `38/39/40-assert`：`update.install.exec` 行 `route=desktop-manager, ok=false`；失败行 `stage=exec / reason=timeout / code=install-failed`；台账 `state=failed`、message 含「移除已装包超时，未继续安装；目标包可能已不在册，请重启宿主检查并按手工命令重装 (dsh plugin --profile desktop add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=…)；无法确认宿主是否把该插件移出了在册名单，也未能恢复在册…」。
- `42/43/44-assert`：补偿文案恰命中三档之一（本 run = **unverified 档**，「无法确认…也未能恢复在册」），且「已恢复在册」⇔ manifest `dsh.profile.bundles` 实际含夹具（本 run `registeredAfter=false`、bundles 只有 base/web-app，文案没有假称已恢复）；没有装成就不许说已更新。
- `45-assert`：失败后面板不复述假成功（或面板随插件消失时如实记录页面原文/present=false）。
- `49-assert`：释放锁后按 message 里的载体命令真机重装 exit 0；`raw/48-recovery-facts.json`：`diskVersion=0.0.2`、`dependencies=0.0.2`、`bundles` 含夹具——恢复可用。
- `51-assert`：收尾无残留（含持锁 PowerShell 脚本进程）。

### 3.4 can-red（run `272-20261103T041611`，fail / 退出码 1 / 17 断言 = 16 pass + 1 fail / 3 图 / 28 raw）

stale-variant 注入（版本号 0.0.2、构建内容仍 0.0.1）。唯一红：

- `31-assert`（预期红）：`hit=已是最新`、`banner=「已是最新，无需更新。」`、`versions=["0.0.2","0.0.2","未知"]`，但 `clientTag=client v0.0.1`、`hostTag=host v0.0.1`——「写盘假绿」被抓住。

其余断言（SUT 钉版/隔离/基版/检查/磁盘/exec/台账/清理）仍 pass；can-red 在红点后停下、不继续重启断言以免掩盖红点。

## 4. 产品真相与 known-red

**install 回包语义**：`updateInstall` 回包是「installing 受理快照」不是终态，`blockedReason=null` 是产品设计；安装瞬间「重启后才生效」的真话在 `update.install.verify` 行（`result=restart-required / pendingRestart=true`）。i2 的 `27/33` 两条断言把这两个语义分开钉住。

**两个通道的差别（I 组要证的核心）**：
- 通道 A（官方桌面 `desktop-manager`，in-process）：安装完成即热换，同一宿主进程 client+host 两半都换到新版（i1 `31/44`：面板已是最新、安装窗 host.start=0）。
- 通道 B（普通 DSH web 宿主 `cli-process`）：安装只写盘，进程不热换（i2 `35`：磁盘 0.0.2 而 `buildTag=host v0.0.1`），必须真重启才加载；未重启时 updateStatus 的运行版需要集成方提供权威值，否则按磁盘解析（known-red）。

两条 known-red（`selftest/evidence/known-red.md`）：

1. `t8-272-panel-pending-restart-branch`——面板「pending-restart / 未登记」文案分支不可达：本机 desktop-manager 热换、通道 B 无桌面面板；条件=需集成方注入 `ReaderOverrides.runningVersion` 造出 pending-restart 态（`src/core/reader.ts:434`、`src/core/service.ts:437-444`、`src/host/capabilities.ts:154-168`）。证据 run `272-20261103T040926`（`31/34-assert` 证明热换）。
2. `t8-272-i2-runtime-version-not-authoritative`——条件=集成方不注入 `ReaderOverrides.runningVersion` 时 CLI 通道安装后 updateStatus 宣称运行版为盘上版本（`src/host/capabilities.ts:142-168`、`src/core/reader.ts:434`）；规避=以 `update.install.verify` 行 `pendingRestart=true` 为安装瞬间真话。证据 run `272-20261103T040932`（`33/35/37-assert`）。

**产品 BUG：无**。i3 的三档补偿文案与 manifest 事实一致、i2 的未登记/重启语义真实，均未暴露需要改 `src/` 的缺陷。

## 5. 试错 run 记录（全部仓库外，`--no-evidence-sync`，未入证据包）

| run | mode | 结果 | 说明 |
| --- | --- | --- | --- |
| `272-20261103T033702` | `lock-remove-timeout` | pass / 19 断言 | i3 首次通过；此前两次 unknown 是 harness 小错（`i3-work` 目录未建、`ensureDir` 未 import，已修） |
| `272-20261103T035830` | `unregistered-honesty`（旧版：官方桌面等价注入） | known-red / 25 断言 | 论证官方桌面无法同一 profile 走「真安装→真重启不加载」，随后按 P1 改 A-prime；该 run 只作设计取舍记录 |
| `272-20261103T040000` | `restart-truth` | pass / 19 断言 / 4 图 | i1 首次通过 |
| `272-20261103T040435` | `can-red` | fail / 17 断言（31-assert 红） | can-red 首跑符合预期 |

另有一次 **run 目录撞车**：两进程同秒启动（stamp 精确到秒）共用 `272-20261103T040811` 目录，第二个 run 在 verdaccio 建号时报 `username is already registered`；已 kill 并删除该仓库外目录，定稿 run 改为错开 6s 启动（i1/i2 并行时分属 `…040926`/`…040932`）。教训：同一 runtime 根下并行启动 run 必须错开 ≥1s 或串行。

## 6. 证据卫生与运行环境确定性

- 定稿 run 全部带证据同步执行，仓库内只有 4 个定稿目录：`272-20261103T040926`（i1 pass）、`272-20261103T040932`（i2 known-red）、`272-20261103T041348`（i3 pass）、`272-20261103T041611`（i1 can-red fail）。试错 run 均未复制进仓库（已核对 `selftest/evidence/runs`）。
- 4 个 run 的 SUT 指纹一致（`distDigest=e8cef960…`、`tarballSha256=3502f4da…`、`installedDistMatch=true`），证明测的是同一构建。
- 并行度：i1 与 i2 定稿 run 并行（起跑错开 6s）；两者 home/profile/registry/端口互相隔离，i2 走通道 B、i1 走官方桌面，未观察到互扰（两者都得到各自预期判定）。i3 与 can-red 在 i1 结束后串行（官方桌面本机只能起一个实例）。
- 每 run `cleanup` 断言全 pass：桌面/CLI 宿主进程 `aliveAfterStop=false`、registry 端口 released；i3 额外核对持锁脚本进程已退出。
- E3b 等既有 flake 若在门禁出现，按仓库惯例重跑取绿并记录（见 §7）。

## 7. 门禁

在干净 HEAD `43f6149` + 证据/文档改动的工作树上串行跑（2026-11-03 04:19–04:20），整链 exit 0：

- `npm run test:batch`：`tests 192 / pass 192 / fail 0`（4.9s）；E3b「执行器真卡死：下一家靠锁陈旧窗口回收并装完」通过——既有 E3b flake 本**未出现**。
- `npx tsc -p selftest/tsconfig.json --noEmit`：exit 0（两套 tsc 都无输出、无错）。
- `npx tsc -p selftest/tsconfig.tooling.json --noEmit`：exit 0。
- `node --test selftest/fixtures/generator/fixture-package-plan.test.ts`：`fixture-package-plan.test: OK（428 条断言）`，tests 1 / pass 1 / fail 0——声明 ↔ 矩阵双向校验（含本票 3 条新行）通过。
- `npm run check`：`tests 2103 / pass 2102 / fail 0 / skipped 1`（该 skipped 为仓库既有跳过用例），四条契约门禁 `[通过]`：文案源 grep（104 个源文件、违规 0）、字典快照（416 个 key、违规 0）、错误码分支（17 码、违规 0）、诊断解析（20 键 ×17 码、违规 0）；`[提示]` 416 个 draft key 是既有非阻塞提示（加 `--release` 才拦），与本次改动无关。

## 8. 提交与合并

- `43f6149` `test(#272): add enrollment/topology scenarios (i1/i2/i3) and runners`（先把代码+声明+矩阵占位提交，让定稿 run 在干净 HEAD）。
- 定稿证据 4 个 run + 账本/矩阵/known-red/研究笔记随后以 `docs(#272)` 提交。
- 合并：`git merge --no-ff` 到 `integration/spec-263`（不 push）；合并 SHA 见交付报告。
