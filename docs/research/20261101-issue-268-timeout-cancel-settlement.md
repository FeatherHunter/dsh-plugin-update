# #268 T4：超时、取消与已了结的失败（决策笔记）

- 票：#268（规格 #263 的实施票 T4，D 组）；日期：2026-11-02；工作树 `D:\dsh-plugin\_wt263\t4`（分支 `impl/263-t4`，基线 = `integration/spec-263` 的 43c5a2a）。
- 场景声明：`selftest/fixtures/identity/scenario-declarations.ts`（g1..g5 五条，矩阵行在 `selftest/evidence/coverage-matrix.md`）。
- 工具入口：`selftest/real-machine/tools/run-g-settlement.ts`（mode = timeout / queued-cancel / failed-no-retry / retry-single-success / retry-can-red / no-cancel-probe）。
- 证据包：`selftest/evidence/runs/268-*`（定稿 run，见 §3）；真机 runtime 全部在仓库外 `D:\dsh-plugin\_wt263\runtime\t4-268\`。

## 1. 一句话结论

本机唯一桌面宿主是官方 DeepSeek Harness（出口二 `desktop-manager`），组 D 在其上拿到四条真机绿：慢安装超时（D1）、批量取消（D2，产品真实语义 = **丢弃未完成批次**，不是在飞终止）、已失败不重试且重启后如实（D3）、补一次成功后台账恰一条成功终态（D4）。**D5「无终止能力宿主」本机不可造**：官方 plugin-manager 0.2.1-rc.5 的 asar 里 cancelInstall 命中 66 处，真机无能力断言登记 known-red，同时用库内 L0 测试把「未提供取消能力」的诚实措辞钉住。can-red 一条**真失败** run（退出码 1）：变体版本号新、内容旧，重启后运行代码 buildTag 仍旧版，而台账/磁盘说成功 ⇒ 成功诚实性断言真红。过程中发现并最小修复两个产品 BUG（§4、§5）。

## 2. 设计与路线

- **声明单源**：五条声明 `g1-desktop-manager-install-timeout` / `g2-batch-queued-cancel` / `g3-desktop-manager-failed-no-retry` / `g4-desktop-manager-retry-single-success` / `g5-desktop-manager-no-cancel-probe`，ticket=268、hostChannel=`desktop-official`；夹具版本/效果、矩阵行、`run.json.scenarioId` 都从声明来。`retry-can-red` 复用 g4 声明（与 T3 的 can-red 复用先例一致）。
- **通道**：`desktop-official` = CDP 起官方桌面（隔离 `DSH_HOME` + `--user-data-dir` + `DSH_PROFILE_DIR`），观察者恒为 A（批量集成方），被更新的目标是 B（超时/失败）或 C（排队取消）。A/B/C 三个 demo 插件装在同一 profile（`desktop`），基版 0.0.1、变体 0.0.2。
- **真机前置设施**（复用 T3）：`fixtureEnvironment`（verdaccio + 发布夹具）、`pinSutForRegistry`（把当前工作树的 SUT 钉成 tarball 并核对 profile 内 dist 指纹 = 工作树构建）、`startDelayingRegistryProxy`（延迟代理只挂住 pnpm tarball 请求 60s，保留 Host 头防 `tarball.origin` 校验失败）、`registry-faults.removePublishedTarball`（只删 tarball、版本文档一字不动，过候选门、pnpm 404 失败）、`captureLogFiles`（停宿主后递归读 `<home>/logs`）、`capturePluginManagerOperations`（管理器 operation 原文）。
- **超时透传链**（真机验证）：夹具 template `deps.config.installTimeoutMs`（env `DSH_SELFTEST_INSTALL_TIMEOUT_MS`）→ `src/host/capabilities.ts:191` → `src/core/executor.ts:1363` → recipe `timeoutMs`；D1 用 12s，D2 占锁方用 40s（排队窗要横跨多步真 UI 交互）。
- **装窗口只轮询磁盘**：desktop-manager 装/卸插件会 relaunch 宿主、旧 CDP 句柄失效；所有「安装过程中」的观察一律读 state.json / queue.json / batch.json，停完宿主才读日志。电话先回、exec 后完（T3 实测 42ms vs 979ms）。
- **四态与退出码**：pass/fail/known-red/unknown，总判定取最坏；全 pass 或仅 known-red 退出码 0，有 fail/unknown 退出码 1，blocked 退出码 2（`selftest/evidence/README.md`）。
- **D2 可达性三代演化**（真机试错结论）：
  1. v1「宏按钮一次提交两家」——同一批量会话内部串行（`src/core/batch/run.ts:267` 等一家收局才推下一家），C 等 B 失败后才开装，waiting 从未非空（run 152630）。
  2. v2「B 面板慢装 + A 面板排队」——两套批量面板的安装被产品中枢按 profile scope 串行（`src/host/batch/fan-out.ts:1111-1118`，ADR-0008），B 在跑时 A 只是提交任务等待，12s 内一次 install 电话都没发（run 155225）。
  3. v3 当前做法：**单插件安装电话**（夹具桥打 B 运行时 `fxb-c.updateCheck/updateInstall`，不走中枢）先起 C 的慢安装占住全局执行锁；A 面板宏「全部更新」轮到 C 时被公平门挡下（`stage=gate/code=update-busy`）→ A 会话记 queued；真 UI「行取消排队」验证文案诚实 → 真 UI「丢弃本批未完成的更新」两步确认收口。
- **can-red 注入**：`staleContentVersion: 0.0.1`（版本号 0.0.2、内容按 0.0.1 构建、运行期 buildTag 会是 v0.0.1）。can-red 还必须把 `pnpm_config_store_dir` 隔离到 run 私有目录且**从 CLI 基版安装起就生效**：stale 内容跨 run 字节完全相同，共享全局 pnpm store（`D:/.pnpm-store/v11`）会让「删 tarball」注入失效，而只给管理器私有 store 又会 `ERR_PNPM_UNEXPECTED_STORE`（第三轮试错 145812 实证）。

## 3. 逐格做法与证据

定稿 run 均在修复后的干净 HEAD `b57fd19` 上重跑：`run.json.sut.distDigest` 全为 `25f1970d…`（与提交后 HEAD 构建一致），`installedDistMatch=true`，`maintainerProfile.unchanged=true`。

### 3.1 D1 慢安装超时（g1，`--mode timeout`，run 268-20261102T181651，pass/退出码 0，19 断言，4 图 26 raw）

- 做法：干净 profile 用 CLI 装 a/b/c@0.0.1 → 起官方桌面 → 发布 B@0.0.2 → 真 UI 点「检查更新」→ 点宏「全部更新」→ 安装窗口只轮询磁盘。
- 关键断言：27 台账落 `failed/targetVersion=0.0.2`（observed=[missing,installing,failed]）；36 exec `route=desktop-manager ok=false durationMs=12439`；37 fail `stage=exec/reason=host-rejected/code=install-failed`（该条 fail 计数=2：1 条 exec + 1 条排队门 `check-expired`，execFailCount=1）；38 人话格与 cancel 能力一致（reason=host-rejected 时 hostCodeHash 非空且 message 含「安装已被取消」；不许出现「未提供取消能力」「已终止」）；42 管理器 operation 两个（先 remove 后 add，add 的 pnpm 失败）；43 磁盘无虚假成功（管理器移除后重装未成，B 不在磁盘）；46 重启后台账仍 failed；47 C 保持 0.0.1 对照。

### 3.2 D2 批量取消（g2，`--mode queued-cancel`，run 268-20261102T174922，pass/退出码 0，28 断言，6 图 36 raw）

- 做法见 §2 第 3 代路线；产品唯一的终态取消入口是「丢弃本批未完成的更新」两步确认（confirmCancel）。行内「取消排队」只撤单次 waiting 占位，中枢 1s 退避还会重推，所以它只验证文案诚实并记录 re-enqueue 时间线，随后立刻「丢弃本批」。
- 关键断言：27 占锁方 install 受理（attemptCount=1）；29 queue owner=fxb-c；31/34 A 面板 C 行 queued + row-cancel-queue + waiting 含 fxa-c；36 排队窗内占锁方台账仍 installing（sharedReader 修复回归）；38 行取消回执含「已取消排队」+「继续」，不含「不再等待/已终止/已请求终止」；43 丢弃两步确认回执「已丢弃本批未完成的更新（已完成的将保留）」；46 丢弃后 A 批量会话从磁盘清空、C 无终态；48 丢弃后 4s×8 次采样 waiting 不再出现 fxa-c；52 队列 owner=null/waiting=[]；60 A 的 C 无 update.install.exec；61 A 侧 fail 只允许排队门事件（stage=gate，code∈{check-expired,update-busy}）或空；62 A 的 C 无台账；63 磁盘 C≠0.0.2；65 占锁方自身 exec 跑满约 40s 预算（durationMs=40391）后 failed，且其收局 observed 不含 interrupted（丢弃没有终止在飞安装）；68 重启后 C 行不排队/不在安装、不谎称 0.0.2。

### 3.3 D3 已失败不重试（g3，`--mode failed-no-retry`，run 268-20261102T175424，pass/退出码 0，19 断言，4 图 26 raw）

- 做法：真 UI 检查更新后删 B@0.0.2 tarball（元数据不动）→ 宏「全部更新」→ 只轮询磁盘台账到 failed → 静置 15s → 停宿主读日志 → 重启看 UI。
- 关键断言：25 失败注入前后 served 200→404 且版本文档不变；27 台账 failed/target 0.0.2；29 A 面板 B 行失败；32 行详情/失败面诚实（失败码 + 手工命令或复制诊断 + 台账 message 里可执行命令）；34 台账 message 以 install-failed 开头且含 `dsh plugin --profile desktop add --save-exact …@0.0.2`；42 无自动重试（exec=1、exec 收场 fail=1、ok=0，其余 fail 只允许 gate/check-expired）；43 exec/fail 八格自洽（route=desktop-manager、ok=false、exitCode 非 0、stage=exec、reason=nonzero-exit、code=install-failed）；44 磁盘无虚假成功；47 重启后台账仍 failed 且 UI 不谎称更新中/成功。

### 3.4 D4 补一次成功只留一条成功终态（g4，`--mode retry-single-success`，run 268-20261102T175925，pass/退出码 0，25 断言，5 图 43 raw）

- 做法：D3 失败落定后恢复 registry tarball → 真 UI 点失败行「重试」（`data-act=row-install`）→ 等磁盘到 0.0.2 且台账收尾 → 重启看 UI 与磁盘。
- 关键断言：52 重试安装磁盘到 0.0.2；57 台账恰一条成功终态（`state ∈ {completed, restart-required}`、target 0.0.2、无第二条成功记录）；66 日志无重复成功、无第二次失败；70 重启后 A 面板 B 行显示已更新（先等面板 check 收尾再读卡片，避免「正在查询版本信息」抢拍）；71 成功诚实性（卡片 client/host 都是 v0.0.2，且与磁盘/台账一致）。
- 为什么删掉「成功 exec 日志行完整」known-red：见 §6。

### 3.5 D5 无终止能力不谎称终止（g5，`--mode no-cancel-probe`，run 268-20261102T181106，known-red/退出码 0，12 断言 = 11 pass + 1 known-red，2 图 12 raw）

- 做法：真机起官方桌面（证明宿主可用）→ 探 `D:\DeepseekHarness\resources\app.asar`（182,766,714 B）里 `pluginManager`/`installBundle`/`cancelInstall` 的字节命中数 → 跑库内 `tests/issue-184-timeout-honesty.test.mjs` 取原始 stdout。
- 关键断言：18 真机宿主 pageText 含夹具卡片（宿主真的起来了）；22/23 asar 探测 `cancelInstall` 66 处（含片段原文，证明本机官方宿主**有**取消能力）；25 库内 L0 测试 exit 0、stdout 含「未提供取消能力」；26 known-red：真机「无 cancelInstall 宿主」不可造，复现条件 = 换没有该能力的官方宿主版本或第三方 Desktop 宿主。
- 诚实边界：**没有伪造真机无能力结果**；无能力路径的诚实措辞由 L0 测试钉住，真机不可达部分登记 `known-red.md`（`t4-268-no-cancel-probe`）。

### 3.6 can-red（g4 的 `--mode retry-can-red`，run 268-20261102T180537，fail/退出码 1，25 断言 = 24 pass + 1 fail，5 图 44 raw）

- 注入：`staleContentVersion: 0.0.1` + 私有 pnpm store（见 §2）。本意是让 D3 失败格照常成立、D4 成功安装「版本号 0.0.2 但跑旧内容」，然后断言成功诚实性必须红。
- 回滚确认：注入是**run 内发布参数**（`--mode retry-can-red` 分支给 B 变体传 `staleContentVersion: 0.0.1`），只作用于本 run 的仓库外 verdaccio storage 与隔离 profile；不修改仓库文件、环境变量（`pnpm_config_store_dir` 仅在本 run 进程内临时指向 run 私有目录并在 finally 恢复）、维护者 `~/.dsh`。run 结束后 verdaccio 已停、storage 随 runtime 目录废弃，工作树 `git status` 无注入残留（只有本文档与证据），因此无需回滚动作。场景源码即注入 patch 原文（`selftest/real-machine/scenarios/g-timeout-cancel-settlement.ts` 的 `retry-can-red` 分支 + `publishB` 的 stale 参数）。
- 红点：成功终态后重启，B 卡片 `clientTag=hostTag=v0.0.1`（`ui=single` 旧内容单席位），而台账 `state=completed/targetVersion=0.0.2`、磁盘 B=0.0.2 ⇒ 断言 `71-assert`「D4 can-red 成功诚实性（预期红）」判 fail，run 退出码 1；其余 24 条（D3 失败格、D4 台账恰一条成功 `58-assert`、无重复 `67-assert`、磁盘 `72-assert`）仍 pass（证明红的是诚实性断言本身，不是场景坏掉）。

## 4. 产品 BUG 1：跨目标电话挤占 sharedReader 单例槽，在飞任务被误判 interrupted

- 现象（修复前真机 run 268-20261102T153751，只留仓库外作证据）：D2 排队窗内，A 面板宏安装的批量 check/status 电话把模块级单例槽 `sharedReader` 换成 A 目标的实例；B 运行时占锁的 fxb-c 在飞安装随后自己的 status 电话新建 reader（`activeJobId=null`），`healJob` 把仍在 installing 的任务合成 `interrupted/recovery-required` 并落盘，队列 owner 提前释放，A 的 C 永远排不上队（queue owner 在占锁方 exec 结束前消失）。
- 根因：`src/host/capabilities.ts:52` 单例槽只有一个；`src/core/service.ts:403-420`（`:406` 判 installing/verifying 且非 activeJobId → interrupted）把「实例换代」误当「进程换代」。中断语义属于进程世代，不属于实例。
- 修复：只改 `src/host/capabilities.ts`——新增 `recentReaders`（按「除运行版本外的身份」索引，与 #266 `sameReaderExceptRunningVersion` 同口径），取 sharedReader 时若最近实例仍在飞（status 为 installing/verifying）则复用它；收尾后照常换代；`resetSharedUpdateReaderState` 清空。回归测试 `tests/reader-rotation-inflight.test.mjs` 新增 #268 用例（别的目标挤槽后，在飞任务仍不得被判 interrupted）。
- 红绿证明：stash 修复 → build → 同测试 3 tests / 2 pass / 1 fail（新用例红），恢复修复 → build → 3 pass / 0 fail。
- 真机回归：g2 新增 36-assert「排队窗内占锁方未被误判中断」（占锁方台账仍 installing、无 interrupted）与 65-assert 收局 observed 不含 interrupted；修复后真机 run 268-20261102T174922（pass）两条均绿。

## 5. 产品 BUG 2：行内「取消排队」文案谎称「不再等待」

- 现象（修复前真机 run 268-20261102T162053）：点行内「取消排队」后回执写「已取消排队：此插件将不再等待。」，但产品中枢对未收尾会话按 1s 退避继续重推（`src/host/hub/registry.ts:222-249` + `src/core/hub/drive-policy.ts:64-65`），实测撤销后 **692ms 同一插件占位又入队**；行取消本来就不能停批次，旧文案是假话。
- 根因：`src/core/i18n/dictionary.ts:843`（`batch.toast.cancel-ok` 的 zh/en）语义与产品真实行为不符。
- 修复：只改文案，不动语义/契约——「已取消排队：本次等待占位已撤掉，本批仍会继续尝试安装（不会终止正在安装的项）。」/ en 对应；同步 `tests/fixtures/bilingual/strings.snapshot.json` 与 `tests/panel-batch.test.mjs` 断言（含 test-the-test：还原旧文案必红一次、恢复后绿）。
- 真机回归：g2 的 38-assert 断言新文案（含「继续」、不含「不再等待/已终止/已请求终止」），并记录 re-enqueue 时间线作边界证据。
- **未修的深层语义缺口**：行取消无法停止中枢批次（需要批量域新增「取消本批」动作/契约改造），本票按 Lead 裁决只修文案、不改契约；缺口写在本节，由 Lead 另开 bug 票。产品也**没有终止在飞安装的入口**（渲染层明说「正在安装的项无法停止」），D1/D2 的诚实性断言都只按这个真实能力写。

## 6. 为什么不把「成功 exec 日志行」当验收点（D4 决策）

- 票面 AC#3 只要求「补一次成功后台账只留一条成功终态」，没要求成功 exec 日志行。
- 真机事实：桌面管理器成功安装会 relaunch 宿主；旧进程写完 state.json `completed` 后被杀，`dsh-log` info 类日志有 1s 防抖（`node_modules/dsh-log/dist/engine/pipeline.js:341-358`），进程被 relaunch 时不等 beforeExit 冲刷；实证 D4 run 里 execCount=1/okCount=0 但台账 completed、重启后 jobState=completed 且磁盘 0.0.2。
- 结论：证实「日志未冲盘」需要 pid 级取证且非本包可修；半证据 known-red 不允许登记，故删掉该条断言，D4 由「台账恰一条成功终态 + 重启 UI + 磁盘」三条收口（§3.4）。

## 7. 试错 run 记录（全部仓库外，不入证据包）

全部试错 run、unknown run、修复前 run 与「维护者指纹乱码」整批 run 都在仓库外 `D:\dsh-plugin\_wt263\runtime\t4-268\evidence-quarantine\`（只用于审计，不复制进 `selftest/evidence/runs`）。关键几轮如下：

| runId | 目的 | 结果 / 留下的教训 |
| --- | --- | --- |
| 131137、132227、132628、133323、133817、134612、135150 | D1 迭代（入口从行内 `row-install` 改为宏「全部更新」；等待口径从「等安装窗口」改为「只轮询磁盘台账」） | 前几轮分别遇到 `row-install` 不存在、缺 C 变体、时点抢拍；教训写进 §2「装窗口只轮询磁盘」 |
| 140108、140615 | D3 失败格迭代（删 tarball 注入、静置窗口、重启观察） | 140108 起「只允许 exec 一次」口径稳定 |
| 142215 | D4 首版（含「成功 exec 日志行完整」known-red 断言） | 该断言在桌面管理器成功安装 relaunch 宿主时不可稳定取证，按 §6 删除重跑 |
| 142951、144222、145812、150837 | can-red 试错（stale 内容哈希口径、全局 pnpm store 缓存命中、`ERR_PNPM_UNEXPECTED_STORE`、重启 heal 竞态） | 定下「can-red 从 CLI 基版安装起隔离 `pnpm_config_store_dir`」与「重试后等台账终态再停宿主」两条硬约束（§2、§8） |
| 151706、152340 | can-red / D5 首份定稿（修复前） | 修复产品 BUG 后 SUT distDigest 变化，整批重跑；不进包 |
| 152630、155225 | D2 前两代设计（同批串行 / 中枢串行均不可达） | 见 §2「D2 可达性三代演化」；155225 证明同 profile 内两套批量面板被中枢串行 |
| 153751 | sharedReader 跨目标挤槽 BUG 的修复前真机证据 | 占锁方在飞任务被误判 `interrupted/recovery-required`、队列 owner 提前释放；修复见 §4 |
| 162053 | 行内「取消排队」文案假话的修复前真机证据 | 撤销后 692ms 同一插件占位又入队；修复见 §5 |
| 164541、165202 | D2 v4/v5（真 UI 排队 + 行取消 + 丢弃本批） | 164541 暴露两条断言口径问题（丢弃后 owner 可为 null、排队门允许 `check-expired`），经 Lead 裁决后改口径；165202 首次真机 pass（head 未提交，不入包） |
| 165846、170333、170730、171225、171837、172403 | 干净 HEAD（1519f41）后首轮六格定稿 | 170333 D2 因占锁方 check 凭证被别的目标电话换槽而 `check-expired`；占锁方加「最多 5 次 check→install 重试」并留完整回包后重跑（b57fd19），本批整体重跑 |
| 172721 | D2 修复后 pass | head=1519f41（未含后续提交），只作修复验证，不入包 |
| 173445、174410 | 维护者指纹 v2 批 | 脚本内中文路径被 Windows PowerShell 5.1 按 GBK 读坏，`homeDir` 记录成不存在的乱码路径（`unchanged=true` 属假证据）；整批隔离，改 ASCII-only 脚本重跑 |

## 8. 证据卫生与日志截断

- 证据包只收干净 HEAD 上跑出的定稿 run（`run.json.sut.distDigest` 必须等于提交后 HEAD 的构建）；试错/unknown/修复前 run 一律不入包。
- `selftest/real-machine/runtime/log-evidence.ts`：单文件超 50000 字符时除截断版外再落 `-tail` raw（最后 200 行），run.json/index.md 对 `truncated=true` 的 raw 标注原始字节数与截断量；日志断言的 counts 文件带 `source`+`line` 供核对。

## 9. 门禁

串行执行（脚本 `D:\dsh-plugin\_wt263\runtime\t4-268\gates.ps1`，日志与 `summary.json` 在 `D:\dsh-plugin\_wt263\runtime\t4-268\gates\`），全部退出码 0：

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| tsc（selftest） | `npx tsc -p selftest/tsconfig.json --noEmit` | exit 0（1.2s） |
| tsc（tooling） | `npx tsc -p selftest/tsconfig.tooling.json --noEmit` | exit 0（1.4s） |
| fixture 计划单测 | `node --test selftest/fixtures/generator/fixture-package-plan.test.ts` | 1 test / 1 pass / 0 fail（G1–G5 均已进 coverage-matrix） |
| build | `npm run build` | exit 0（3.2s） |
| 批量定向测试 | `npm run test:batch`（build 之后） | 189 pass / 0 fail（3.6s） |
| 聚合检查 | `npm run check` | exit 0（27.5s） |

本轮未复现 #267 记录的 E3b 偶发 flake。

## 10. 提交与合并

本分支（`impl/263-t4`）提交：

- `b68940c` `fix(#268): 跨目标电话不再挤掉在飞读取器`（`src/host/capabilities.ts` + `tests/reader-rotation-inflight.test.mjs`）。
- `3adbf51` `fix(#268): 行内取消排队文案不再谎称「不再等待」`（`src/core/i18n/dictionary.ts`、`tests/fixtures/bilingual/strings.snapshot.json`、`tests/panel-batch.test.mjs`）。
- `1519f41` `test(#268): 组 D 场景声明与 g 场景/工具`（scenario-declarations、g-timeout-cancel-settlement.ts、run-g-settlement.ts、t3-common ticket 参数、log-evidence 尾段）。
- `b57fd19` `test(#268): D2 占锁方 check→install 重试并留完整回包`。
- 本笔记与证据账本（coverage-matrix / runs/README / known-red / `selftest/evidence/runs/268-*`）随 docs+证据 commit 提交。

合并：`git merge --no-ff impl/263-t4` 进 `D:\dsh-plugin\_wt263\integration`（分支 `integration/spec-263`），未 push；合并 commit hash 见最终报告与 `git log -1`。
