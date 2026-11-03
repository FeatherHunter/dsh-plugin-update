# #274（K 组）UI 全状态真机证据（T10）

本笔记记录实施票 #274（parent #263，K 组）在真机上的落地方案、逐格证据、产品真相边界与试错记录。
基线：`integration/spec-263`（含 T0–T9，合并后本票工作树 `D:/dsh-plugin/_wt263/t10`，分支 `impl/263-t10`）。
SUT 钉版：`dsh-plugin-update@0.18.39`，dist 指纹 `e8cef960…`（208 文件，tarball sha256 `3502f4da…`）。
定稿 HEAD：`fb539ec`（`test(#274)` 干净 HEAD；四个定稿 run + can-red 的 `run.json.environment.head` 都等于它）。

## 1. 结论

- K 组四场景 + can-red 全部真机跑通，五个定稿 run 已入库 `selftest/evidence/runs`：
  - `274-20261103T085741` `k-single-panel-happy`：pass / 退出码 0 / 38 断言 / 7 图 / 19 raw。
  - `274-20261103T085842` `k-single-panel-failure`：pass / 0 / 23 断言 / 3 图 / 23 raw。
  - `274-20261103T090025` `k-batch-panel-states`：pass / 0 / 38 断言 / 6 图 / 32 raw。
  - `274-20261103T090421` `k-batch-resume`：pass / 0 / 24 断言 / 4 图 / 31 raw。
  - `274-20261103T090655` `k-single-panel-happy`（can-red）：fail / 退出码 1 / 9 断言 = 8 pass + 唯一红 `can-red-03-banner-exact` / 2 图。
- **产品 BUG：无**。本票没有需要改 `src/` 的缺陷；发现的两处产品语义（单包待重启态毫秒窗口、安装锁 15 分钟陈旧阈值）都按设计行为记录并转成可复核的断言口径，见 §4、§6。
- 未新增 known-red：不可稳定拍的单包「待重启」态用「落定终态」等价断言覆盖（§4.3），不伪造 DOM、不注入产品状态。
- 覆盖的 UI 状态格：未安装、可更新、更新中、已了结、失败、最后手段、手工命令、入口（badge 三态）、安装按钮（loading/update/busy/failed/done）、changelog（markdown/裸 URL/BREAKING/yanked/截断/折叠）、批量行相位、批量总账/台账、部分失败横幅、续跑入口（冻结）、重启后一致、can-red 注入。

## 2. 设计

### 2.1 四格分工

| 格 | 模式 | 取证对象 |
| --- | --- | --- |
| K1 `k-single-panel-happy` | `--mode k1` | 单包面板全状态链：未安装/可更新（长 changelog）/更新中/落定/重启后；入口徽标与安装按钮三态；C 额外面板未安装→首次安装 |
| K2 `k-single-panel-failure` | `--mode k2` | 单包失败链：改坏 tarball 字节 → 仍可 check → install 失败 → 失败横幅/最后手段/手工命令原文 → 真执行命令 → 重启了结（历史行保留） |
| K3 `k-batch-panel-states` | `--mode k3` | 批量面板矩阵：三行可更新/安装中/部分失败隔离（最后一行 C 坏 tarball）/失败横幅与行文案/复原+清 store/续跑/重启一致（三代宿主） |
| K4 `k-batch-resume` | `--mode k4` | 跨重启续跑：部分失败 → 杀宿主（落盘真相）→ 复原+清 store → gen2 续跑入口（双闸冻结，不自动推进）→ 真 UI 点续跑 → exactly-once → gen3 重启一致 |
| can-red | `--mode can-red`（复用 K1 前半） | 证明断言有牙齿：停宿主后改 run 私有已装包 `lib/client.js` 的横幅文案编码串 |

### 2.2 共用地基：TLS 夹具 registry（本票关键决策）

产品 `src/core/changelog/io.ts:347` 对 changelog 拉取有硬门槛：tarball URL 必须是 `https:`，且与 registry 同 origin、无 userinfo/search/hash、path 以 `.tgz` 结尾并等于 `/<包名>/-/<包名>-<版本>.tgz`。夹具的 verdaccio 是 http，因此 changelog 永远 `fetch-failed`——K1 的 changelog 断言一开始不可能绿，除非伪造 changelog（不可接受）。

实现：每 run 起一个常驻 TLS 前置（`selftest/fixtures/release/tls-registry-front.ts`），`node:https` 反代 verdaccio http；转发时保留客户端 `Host`、覆写 `x-forwarded-proto: https`。`@verdaccio/url` 的 `getPublicUrl` 会按请求 Host + 该头拼 `dist.tarball`，于是 metadata 里自然输出 `https://127.0.0.1:<front>/pkg/-/pkg-<ver>.tgz`，与宿主 registry origin 一致，能过产品同源检查。宿主/pnpm/dsh CLI 一律注入 `NODE_EXTRA_CA_CERTS=<自签证书>`；证书由 openssl 现场生成（SAN `IP:127.0.0.1,DNS:localhost`，候选顺序 `DSH_SELFTEST_OPENSSL` → Git 自带 openssl → PATH）。延迟行为收进该前置、按宿主代次配置（`setDelay({delayMs,match:'pnpm-user-agent'})`），既保持 registry URL 在三代宿主间稳定（K2 手工命令在宿主停后仍可执行），又能在安装窗制造可拍的时间。

被否方案：只让 changelog 走 https（同源检查不可能过）；发公共 npm（不可接受）。

### 2.3 宿主通道与隔离

- 通道：`dsh-web`（普通 DSH web 宿主，通道 B）+ Playwright 真页面（`DSH_VERIFY_PLAYWRIGHT=D:/dsh-plugin/dsh-mattpocock-skills-deck/node_modules/playwright`）；`page.goto(tokenUrl)` 过 auth。
- 每个 run：`osHomeDir=<run>/os-home`、`homeDir=<osHomeDir>/.dsh`、profile `t10ui`、run 私有 registry storage、run 私有 `pnpm-store`/`pnpm-cache`/`npm-cache`、独立端口；三代宿主串行起停（进程树 taskkill，停后读日志）。
- 纪律：官方桌面一次一实例，五个定稿 run 全部串行；试错 run 全部 `--no-evidence-sync` 只留 `runtime/t10-274`，仓库 `runs/` 只有五定稿 run。

### 2.4 UI 读数原则（收敛后的口径）

只截「截图 + 页面原文/数据属性」：面板文案逐字对齐 `dictionary.ts` 的 key；入口 badge 读 `aria-label`/`title`（不是 textContent）；安装按钮读 `.dsh-upd-ib-kind-*`；批量行读 `data-key` 与行内文本。不断整棵 DOM、不读内部 state、不在读不到时伪造 DOM。夹具 client 模板额外暴露 `globalThis.__fixtureRefresh={entry,button}`，让断言可以「驱动按钮自身的 poll/refresh」而不改产品轮询语义（夹具能力，不是产品功能）。

### 2.5 can-red

仓库 `src/` 与通知文案不动；停第一代宿主后对 run 私有已装包 `profiles/t10ui/node_modules/dsh-plugin-update-fixture-a/lib/client.js` 做字符串替换：把「已是最新，无需更新。」的 UTF-16 ascii 转义串（`\u5DF2\u662F\u6700\u65B0\uFF0C\u65E0\u9700\u66F4\u65B0\u3002`，occurrences=2）替换成同串+`RED`，raw 记 sha256 前后与原文。重启后横幅应渲染「已是最新，无需更新。RED」，而断言要求精确等于「已是最新，无需更新。」⇒ 唯一红点。

## 3. 逐格证据（定稿 run）

### 3.1 K1 `274-20261103T085741`（pass）

- 38 断言全 pass；7 张截图（初始 done + C 未安装、可更新+changelog、安装中、落定、重启后、C 首次安装）；19 raw。
- 初始：A 面板 `done` 精确「已是最新，无需更新。」；C 额外面板 `idle`「未安装」+ check 动作；安装按钮最终非 loading；入口 badge `state=idle`、aria-label「已是最新 0.0.1」。
- 可更新：横幅精确「有新版本 0.0.2 可安装（当前版本 0.0.1）。」；changelog 版本节含「0.0.2 · 2026-11-03 · 已撤回」、yanked 横幅、截断提示（107 条显示前 100）、六类分组、行内 `code/strong/em/del`、两条 `.dsh-upd-md-link[data-openlink=1]`（含裸 URL）、无 `script`、BREAKING 徽标「不兼容」。
- 安装中：横幅精确「正在安装 0.0.2…关闭面板不会中断。」；入口/按钮 busy。
- 落定：横幅「已是最新，无需更新。」；`update.install.request` 恰 1 条（from=entry）；台账 `before.previousVersion=0.0.1` 且 `before.jobId===state.id`，state `completed/target 0.0.2/previous 0.0.1`；磁盘 A=0.0.2。
- 重启后：横幅 done、面板 tags `client v0.0.2`/`host v0.0.2`、安装按钮 done、入口 aria「已是最新 0.0.2」、台账 completed。
- C 额外面板：点 check → 横幅精确「首次安装 0.0.2（新增依赖）。」+ 中性 changelog。

### 3.2 K2 `274-20261103T085842`（pass）

- 23 断言全 pass；3 张截图（可更新、失败现场+最后手段+手工命令、重启后）；23 raw。
- 注入：`sha256Before≠After`、`versionDocUnchanged=true`、改坏前后 tarball URL 都 200 且响应字节一致（`servedBeforeBytes===servedAfterBytes===102503`，存储文件 108345 只作参考）。
- check 仍可更新；install 失败：横幅「更新失败（install-failed）：安装执行失败，详情见诊断摘要。」；最后手段 badge「最后手段」/status「自动恢复不可用」/reason「没有可用的自动数据路径；复制这条命令是唯一出路。」；手工命令原文 `dsh plugin --profile t10ui add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=https://127.0.0.1:59110`。
- 后端：exec 1 条全 `ok=false`；`update.install.fail` 恰 1 条 `stage=exec/reason=nonzero-exit/code=install-failed/exitCode=1`；磁盘仍 0.0.1；台账 `failed/target 0.0.2`。
- 恢复：tarball sha 复原 `82891cb3…`、版本文档未动；真执行面板命令 exit 0（827ms）→ 磁盘 0.0.2。
- 重启后：横幅 done；settled 历史行含「上次尝试失败（install-failed）」与「目标版本 0.0.2 或更新版本正在运行。」；卡片 client/host v0.0.2；台账仍如实保留 failed/target 0.0.2（真相优先，不篡改历史）。

### 3.3 K3 `274-20261103T090025`（pass）

- 38 断言全 pass；6 张截图（三行可更新、安装中、部分失败现场、续跑后、重启后等）；32 raw。
- gen1：挂载即自动检查（summary「3 个可更新；请选择「全部更新」一次安装完成，也可逐项选择「安装此插件」。」、ledger「3 个可更新」；「尚未查询」只是首帧）；三行 `cur=0.0.1/new=0.0.2`。
- 注入 C tarball（sha `9aa0079c…→b2297d24…`、版本文档未动）→ 点「全部更新」→ 安装中相位（a installing/b/c ready；summary「正在安装 1 个；队列里还有 2 个，会自动依次安装。」）。
- 部分失败：summary「1 个插件安装失败；请按下方失败提示逐项重试。」、ledger「1 个失败 · 2 个已是最新」；失败横幅「1 个插件安装失败。」+ 名单「夹具 C：install-failed 安装执行失败，详情见诊断摘要」；C 行 `failed`、status「最后手段安装失败，请选择「重试」。」、versionCur 0.0.1/versionNew 0.0.2；A/B 磁盘 0.0.2、台账 completed（好行不受影响）。
- gen1 后端：A/B exec=1 且 ok=1、C exec=1 且 ok=0；stage=exec 失败恰 1 条 `install-failed/nonzero-exit/exitCode=1`；gate 失败只有 check-expired 重试（产品已知重载窗口行为，非安装失败）。
- 复原：tarball sha 还原、版本文档未动；清 run 私有 pnpm store 的坏缓存（filesBefore=343，环境修复不动已装包）。
- gen2：重启首帧 C 行未被标成 done/current（盘上 0.0.1 时仍 failed）；自动检查对账后出续跑入口，真 UI 点续跑（代码支持 autoResume 与行内重试两条路，本 run path=manual）→ C 磁盘 0.0.2、三行 current/done 0.0.2、summary「已全部为最新，无需操作。」、ledger「3 个已是最新」。
- 停 gen2 后端：A/B exec 仍 1、C exec=2（1 失败 1 成功）、stage=exec 失败恰 1、failCount=5/retryCount=5/nonCheckExpired=1/unretried=0；台账三包各恰 1 条 `state.json` completed target 0.0.2 previous 0.0.1（同一插件同一 profile 只有一份 state.json，重试覆盖不追加）。
- gen3 重启：三行 current 0.0.2、summary/ledger 全最新、卡片 client/host v0.0.2、台账三包 completed、磁盘三包 0.0.2（UI/台账/磁盘三处一致）。

### 3.4 K4 `274-20261103T090421`（pass）

- 24 断言全 pass；4 张截图（部分失败现场、续跑入口(冻结)、续跑完成、重启后）；31 raw。
- gen1：C 坏 tarball（同 K3 口径）→ 批量宏；部分失败隔离：a/b 磁盘 0.0.2、C 0.0.1、C 台账 failed、summary「1 个插件安装失败…」；等面板重排干净 → 杀宿主（真实 taskkill /T /F）→ 落盘真相：disk a/b=0.0.2、c=0.0.1，batch 行 a/b done、c failed target 0.0.2。
- 复原 C tarball（sha 还原、版本文档未动）+ 清 run 私有 store（filesBefore=343）。
- gen2 双闸：A@0.0.2 夹具带 `autoResume:false`（面板不自动续跑）+ host half `hub:false`（不做孤儿接管）。重启首帧 C 行不得 done/current（实测 failed）；自动检查把 failed 行对账成 ready 后出现续跑入口：「继续上次未完成的更新（剩余 1 个）。」+ title「从上次中断处继续安装，已完成的不会重复安装。」+「丢弃本批未完成的更新（已完成的将保留）。」。
- 冻结 8 秒：tarball 请求数 5→5、C 磁盘 0.0.1→0.0.1、batch 相位串「a:current|b:current|c:ready」不变 ⇒ 入口存在但不会自动推进（双闸生效）。
- 真 UI 点续跑：notice「已继续上次未完成的更新（剩余 0 个）。」；C 磁盘 0.0.2；三行 current/current/done 0.0.2；续跑区消失（more=null）。
- exactly-once：req a=1/b=1/c=2；B/C 各 1 次成功 exec、C stage=exec 失败恰 1 `install-failed`；A/B 台账 file/id/state/mtime 未变（`aLedgerUntouched/bLedgerUntouched=true`）；audit `nonCheckExpired=1`、`unretried=0`。note 说明：A 自更新期间插件宿主半重载可能吞 A 的 exec/verify 日志（本 run 未吞，但口径不依赖它），A 的「不重复安装」以 request 恰 1 + 台账未改写 + 行终态为证。
- 台账：三包各恰 1 条 `state.json` completed target 0.0.2 previous 0.0.1（`fxa-a/29f9a4c1…/state.json` 等）。
- gen3 重启：三行 current 0.0.2、summary「已全部为最新，无需操作。」、ledger「3 个已是最新」、卡片 client/host v0.0.2、台账 completed、磁盘三包 0.0.2。

### 3.5 can-red `274-20261103T090655`（fail / 退出码 1）

- 9 断言 = 8 pass + 唯一红 `can-red-03-banner-exact`；2 张截图；19 raw。
- `can-red-01-before-patch`：patch 前横幅精确「已是最新，无需更新。」（基线真绿）。
- `can-red-02-patch-applied`：注入生效（file=run 私有已装包 `lib/client.js`，occurrences=2，chars 435034→435040，sha256 `cd6194b0…→8312054a…`，changed=true）。
- `can-red-03-banner-exact`（预期红）：重启后 actual 标题「已是最新，无需更新。RED」≠ expected 精确原文 ⇒ 本 run 判 fail/退出码 1；其余 8 条（SUT 钉版、基版安装、setup 干净）仍 pass，红点可归因到断言本身。

## 4. 产品真相与实现约束（做 UI 状态证据必须知道）

### 4.1 入口三种形态的读法

`src/panel/entry.ts`：badge 形态只渲染 `<button class="dsh-upd-entry-dot">` 圆点，textContent 恒空；文案在 `aria-label`/`title`（idle=「检查更新」、update=「有新版本 {version}」、up-to-date=「已是最新 {version}」）。note 元素只在 `upToDateDisplay==='note'` 且 noteVersion 非空时渲染（`entry.ts:529-531`），夹具默认 button ⇒ note 恒空。K1/K2 的入口断言全部改读 aria-label。

### 4.2 install 按钮与入口的自动轮询

夹具模板用 `autoCheck:'never'`（不自动 check）与 `pollMs:5000`：状态不会自己回填，busy/failed 必须由按钮自身发起 install 才能出现。证据读取前一律先 `waitForPanel/waitForEntry/waitForInstallButton` 等目标档，不能立即读首帧（首帧 bannerKind=loading）。

### 4.3 单包「待重启」不可稳定拍（关键产品真相）

单包面板的待重启横幅只认 `snapshot.blockedReason=pending-restart`（`src/panel/view-model.ts:259`），而 `pending-restart` 要求 reader 运行版本 ≠ 磁盘版本（`src/core/reader.ts:434`）。换包后 `capabilities.ts:166-167` 直接读盘上 manifest，运行版本立即等于新版本 ⇒ 产品先报 `pending-restart`（实测 `install.verify restart-required` 后 5ms 内两次 status.changed），随即落定 `done`。因此「待重启」只在旧 reader 实例仍握在飞任务的毫秒级窗口，不能作为稳定单包 UI 证据；K1 改为断言落定终态（「已是最新，无需更新。」+ 入口「已是最新 0.0.2」），另外用重启后卡片/台账证明「真的生效」。批量面板的「待重启」来自 jobState 快照，K3 已覆盖。

### 4.4 台账布局与「不重复不丢行」

状态目录 = `updates/<插件标识>/<profile 目录短指纹>`（`src/core/disk.ts:60-65`）：同一插件同一 profile 只有一份 `state.json`，before.json/install.lock 同目录；重试/续跑覆盖同一条、不追加历史行。所以「台账不重复、不丢行」的正确口径 = 每包恰一条记录且终态成功；失败历史由日志 `update.install.fail` 计数承载（K3-23/24、K4-10/11）。

### 4.5 批量面板挂载即自动检查

批量面板 mount 时自动 check（夹具已证明），初始「尚未查询/待查询」只是首帧，不能当稳定态断言；K3 断言改为「挂载即自动检查（summary/ledger 报可更新）」。

### 4.6 续跑入口的渲染条件与对账路径

`.dsh-upd-batch-more` 渲染条件 = `total>0 && hasUnfinishedRows`（`src/panel/batch/ledger.ts:283-288`，只认盘上 session 非终态条目）。失效（failed）行在宿主重启后被 checkPhone 的成功检查对账成 `ready`（`src/host/batch/fan-out.ts:828-909`，`#152` 路径）⇒ 会话重新变成「未完成」⇒ 续跑按钮出现。这是产品支持的恢复路径（T5 #269 已用同一路径），不是测试伪造。点续跑的回执 = `batch.notice.resumed`「已继续上次未完成的更新（剩余 n 个）。」（`src/panel/batch/mount.ts:1033`）。

### 4.7 双闸（autoResume:false + hub:false）的意义与位置

产品有两处会让未完成批次自动推进：面板 `mount.ts:1563-1606` 的 autoResume（只跑一次）、宿主 `fan-out.ts:627-630/1162` 的 hub 接管（夹具 host deps={ctx} 时 hubEnabled 恒 true，只有夹具输出 `hub:false` 才关）。K4 用夹具双闸把「自动续跑」关掉，证明「续跑入口存在但静置 8s 不推进」，再由真人点续跑推进——这样「续跑按钮」与「自动推进」两条路径解耦，exactly-once 可归因。双闸是夹具能力，不是产品功能。

### 4.8 安装锁的 15 分钟陈旧阈值（为什么 K4 不在中途杀宿主后立刻续跑）

`tryAcquireLock`（`src/core/disk.ts:195-295`）只按年龄回收，无 pid 存活校验；`installTimeoutMs` 默认 15 分钟（`src/shared/config.ts:46`，队列锁同值 `src/core/queue/ports.ts:42`）。杀宿主后立刻重启/续跑会被上一代遗留 `install.lock/global.lock` 拒 `update-busy`（实测 run 082945：B 台账 interrupted recovery-required，batch 以 stoppedBecause=queued 停）。这是 CHANGELOG #181 与 README §3 明说的保守设计（陈旧阈值=安装预算），不是 BUG；K4 因此改为「部分失败 → 杀宿主（无在飞安装、锁已释放）→ 重启续跑」的真实用户路径。

### 4.9 A 自更新期间日志可能被吞

自身更新时插件宿主半重载，A 的 exec/verify 日志可能丢（T5 #269 已知，K1/K4 都观察过边界）。exactly-once 断言以 `update.install.request` 条数 + 台账文件未被改写 + 行终态为准，exec 只作辅助证据；K4 note 明确记录这个坑。

### 4.10 坏 tarball 注入口径与 store 清理

只改 tarball 字节，元数据/integrity/版本号一字不动 ⇒ check 能过、install 在执行阶段失败（比删 tarball 的 check-failed 更符合「部分失败」语义）。但坏 tarball 的失败尝试会在 run 私有 pnpm store 留下 integrity 不匹配缓存，恢复 tarball 后旧 store 仍会反复失败——所以 K2/K3/K4 都在恢复后清 run 私有 store（只清缓存、不动已装 node_modules；这是修环境不是修产品）。

### 4.11 K2 手工命令要异步执行

面板给出的手工命令形状由 `src/shared/commands.ts` 决定；执行时必须用异步 `spawn`（同步 `spawnSync` 会堵死 runner 事件循环，run 内 TLS 前置 HTTPS server 无人应答 → pnpm 报 `UND_ERR_CONNECT_TIMEOUT`）。另外 extraEnv 里 `npm_config_store_dir` 指到 run 私有空 store，绕开坏缓存。

### 4.12 元素不可达时的处理原则

「安装按钮/入口」的 autoCheck:never + 首帧竞态、批量宏在检查未完成时 disabled 等情况，统一处理为「等目标档再读/等可点再点」，而不是伪造 DOM 或注入产品状态。changelog 的行内 `strong/em` 产品没有专用 class（`render-model.ts:202` 输出裸标签，只有 del 有 `.dsh-upd-md-del`），读数脚本在 changelog 容器内查 `strong/em`。

## 5. 证据清单与复核入口

- 五个 run 目录都在 `selftest/evidence/runs/`：每个含 `run.json`（机器总账，含 assertions/shots/raw/cleanup/maintainerProfile）、`index.md`（一页索引：断言表 + 截图索引 + raw 清单 + 清理 + notes）、`shots/<id>.png` + 同名 `.json` sidecar（step/what/expected/actual/verdict）、`raw/`（面板 DOM、changelog DOM、tarball 改坏前后、pnpm store、日志、台账、磁盘、注入原件）。
- 全部 `run.json.environment.head = fb539ec…`、`sut.distDigest = e8cef960…`（与干净 HEAD 构建一致）。
- 复核顺序：先 `index.md` 断言表（红点/关键 actual）→ 再看 `shots/<id>.json` 与 png → 需要原文时看 `raw/`。
- 试错 run 全部隔离在仓库外 `D:/dsh-plugin/_wt263/runtime/t10-274/`（`--no-evidence-sync`），未入 `runs/`；unknown 试错也不入库。

## 6. known-red 与边界

- 无新增 known-red。两条「拍不到/不该拍」的情形：
  1. 单包「待重启」态：产品毫秒窗口（§4.3），用落定终态等价覆盖；不伪造。
  2. 无 cancelInstall 能力宿主（F 组 #267 探测域）不在 K 组范围。
- K4 冻结双闸是夹具能力（§4.7），不能读成「产品有 autoResume 开关」；产品真实能力是面板默认自动续跑 + hub 接管。
- Playwright headless 与真实桌面窗口仍有差异；本票 UI 证据以 DOM 文本/属性 + 截图为准，通道 B 不涉及桌面窗口。
- 维护者 profile 指纹：五个 run 的 `maintainerProfile` 前后一致（未污染维护者 home）。

## 7. 门禁（在干净 HEAD `fb539ec` + 证据/账本改动的工作树上串行跑）

六道门禁全部 exit 0：

- `npx tsc -p selftest/tsconfig.json --noEmit`：0。
- `npx tsc -p selftest/tsconfig.tooling.json --noEmit`：0。
- `node --test selftest/fixtures/generator/fixture-package-plan.test.ts`：0（`OK（568 条断言）`，含 K 组夹具产物守护断言与矩阵↔声明双向校验）。
- `npm run build`：0（dist 208 文件，distDigest `e8cef960…`）。
- `npm run test:batch`（build 后）：0（192 tests / 50 suites / 192 pass）。
- `npm run check`：0。

## 8. 提交与合并

- 代码提交链：`6414551` `test(#274): 组 K UI 全状态场景骨架与夹具扩展`（声明/夹具/矩阵骨架/`run-k-ui.ts`）→ `0670219` `merge(#274): integration/spec-263（T9 合并后）合入 T10 分支`（解冲突：K 块 + J 块、K 4 行 + J 3 行）→ `fb539ec` `test(#274): 组 K UI 全状态真机场景（K1/K2/K3/K4 + can-red 注入）与 TLS 夹具 registry`（7 files, +1029/−277：`k-ui-states.ts`、`scenario-declarations.ts`、`fixture-package-plan.test.ts`、`integrator-client-half-template.ts`、`coverage-matrix.md`、`node-ambient.d.ts`、`tls-registry-front.ts`）。五个定稿 run 都跑在 `fb539ec` 干净 HEAD 上。
- 定稿证据 5 个 run + 账本（`coverage-matrix.md` 状态列、`runs/README.md` 5 行、can-red 表 1 行）+ 本笔记随后以 `docs(#274)` 提交。
- 合并：`git merge --no-ff` 到 `integration/spec-263`（不 push）；合并 SHA 见交付报告。

## 9. 盲区与残余风险

- 本票按 recon 建议覆盖 4 场景而非 28 格逐一：单包独立「待重启」、取消/终止能力探测、第三方 Desktop 出口等属于其它组/不可达格，未在本票重复造证据。
- 冻结窗口 8s 只能证明「静置不自动推进」；更长时间的自动推进（如 hub 租约延迟接管）未在 K4 覆盖，由 F 组 h2 与 G 组 g6 覆盖。
- 单包面板 changelog 的截断阈值「前 100 条」是产品文案，测试声明造了 107 个版本节触发；若产品改阈值，声明侧 fixture 需同步。
- 安装窗内 UI 截图只能拍一瞬（面板会在安装完成后重排）；持续的相位证据以轮询磁盘/台账 + 停宿主后日志为准，截图仅作现场佐证。
