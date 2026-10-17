# Changelog

格式为 Keep-a-Changelog 子集：`Added/Fixed/Changed` 必写，`Deprecated/Removed/Security` 有则透传，`Unreleased` 面板忽略，禁止 git-log 直倒。面板缺日志时中性提示，不挡安装。

版本号按**已发布**口径读：`0.14.0` 与 `0.15.0` 没有单独发到 npm（registry 上从 `0.13.0` 直接到 `0.16.0`），那两节的内容随 `0.16.0` 首发；`0.16.1` 起是发布后的补丁。

## [Unreleased]

## [0.18.15] - 2026-10-18

### Fixed
- **两步配方第二步失败/超时：详情点明「目标包已被宿主摘掉」并给可重装命令（#168，S1，verify-hmr 独立验证）**：`desktop-manager` 路由更新已装包时，#167 的配方先 `removeBundle` 再 `installBundle`；移除成功、重装失败时，失败详情只有第二次的宿主原话，没有一句话告诉用户「目标包现在不在 profile 里」。用户看到的是「安装失败、可以重试」，实际状态是「什么都没装、必须先重装」——两者处置完全不同。现在（含重装**超时**）详情在第二次宿主原话之后补：「目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制手工命令重新安装 (`dsh plugin --profile desktop add --save-exact <包名>@<版本>`)」。宿主原话在前、本包补记在后，总长仍封顶 300 字。
  票面列过三个方向（补话术 / 结构化 diag / 回滚重装）：本版选①补话术——②要占公开形状并给面板新出口，③会引入「回滚本身也可能失败」的第二层状态；①能把状态与下一步一次说清且改动面最小，②留待面板需要「一键重装」出口时再提。

### Changed
- 测试：`tests/desktop-manager-hmr.test.mjs` 新增 2 例**先红后绿**（移除成功后重装失败：原文在前 + 点明不在册 + 可执行重装命令 + 300 字封顶；重装**超时**同样补事实与命令）。
- `tests/fixtures/bilingual/copy-baseline.json`：+1 条冻结抛错文案。
- `docs/host-install-exits.md` 出口二补「两步配方第二步失败的人话格（#168）」；末节「残留风险」改为已修记录。
- **发布口径提醒**：`0.18.8`～`0.18.15` 八段都还没发到 npm（registry 最新仍是 `0.18.7`），发版时以 `0.18.15` 一次带走即可。

门禁（**发版定格**）：`npm test` **1476 例：1475 过 / 0 失败 / 1 跳过**（干净发版树 `499b23d` + 本批 6 个文件上实测；本批新增 2 例，均先红后绿）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、351 个 key、16 错误码、19 diag 键，违规 0；本批零新增 key，`copy-baseline.json` +1 条冻结抛错文案）；`npm publish --dry-run` **95 文件**（`dsh-plugin-update@0.18.15`，359.9 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（351 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.14] - 2026-10-18

### Fixed
- **出口一（第三方 Desktop 的 `desktopPnpm` 服务）补上安装时限（#193，S1，审查 A 线 R3）**：原来 `runDesktopService` 只 `await handle.done`，配方里的 `timeoutMs` 只对另两条路由生效——宿主服务不收尾时作业永久停在 `installing`（审查探针：注入 300ms 额度、假服务永不落定，5 秒后仍未收场），之后所有动作 `update-busy`，用户只能重启宿主。现在照出口二（#184）的纪律补上 deadline + 终止 + 终止宽限：
  1. `done` 带 `terminate` ⇒ 到点调一次，人话格「安装超时，已请求宿主终止」；
  2. 不带 `terminate` ⇒ 一次终止都没发过，人话格「安装超时；宿主未提供终止能力，这次安装可能仍在后台继续」，不谎称已请求终止；
  3. 到点后再给 3 秒终止宽限，宽限内以 `exitCode 0` 收尾按成功算（不把已经落地的改动记成失败），非 0 按失败并带真实退码；
  4. `done` 直接 reject（宿主安装服务崩了）⇒ 立即失败并写「宿主安装服务异常退出」，不伪装成超时。
  失败详情都守「宿主原文在前、下一步在后」，总长仍封顶 300 字。

### Changed
- 测试：新增 `tests/issue-193-desktop-service-timeout.test.mjs`（5 例，先红后绿——未修树五条全红：无 `terminate` 时永久挂住、有 `terminate` 却从不调、宽限内成功被挂住、reject 被拖成超时且无详情、宿主机级作业 12 秒不收尾）。
- `tests/fixtures/bilingual/copy-baseline.json`：+3 条新冻结抛错文案（两条超时口径 + 服务异常退出）。
- `README.md` §5.2 时间口径补第三方 Desktop 的 terminate/宽限说明；`docs/host-install-exits.md` 出口一新增「超时政策」条目（含 `done` reject 口径）。
- **发布口径提醒**：`0.18.8`～`0.18.14` 七段都还没发到 npm（registry 最新仍是 `0.18.7`），发版时以 `0.18.14` 一次带走即可。

门禁（**发版定格**）：`npm test` **1474 例：1473 过 / 0 失败 / 1 跳过**（干净发版树 `58442a0` + 本批 6 个文件上实测；本批新增 1 个测试文件、5 例，均先红后绿）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、351 个 key、16 错误码、19 diag 键，违规 0；本批零新增 key，`copy-baseline.json` +3 条冻结抛错文案）；`npm publish --dry-run` **95 文件**（`dsh-plugin-update@0.18.14`，359.2 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（351 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.13] - 2026-10-18

### Fixed
- **超时语义诚实化（#184，S1，审查 A 线 R5）**：
  1. 安装步超时原来无条件写「安装超时，已请求宿主取消」。管理器**没有** `cancelInstall` 能力时，本包一次取消都没发过（审查探针：`cancelCalls: 0` 却自称已请求），且被判定「超时」的那次安装 20ms 后真的落地（`lateSettleLanded: true`）——用户被告知失败、实际装上了。现在按能力分支：有取消能力保持原文；没有则写「安装超时；宿主未提供取消能力，这次安装可能仍在后台继续」。
  2. 移除步超时原来只说「移除已装包超时，未继续安装」。移除请求可能已经生效：审查实测超时后清单 `dependencies: []`（包已被摘掉）却没有重装，用户以为包还在。现在超时的人话格写明「移除已装包超时，未继续安装；目标包可能已不在册，请重启宿主检查并按手工命令重装」。
  3. 移除超时后的环境读取能看出「已摘选中」（`env.registered === false`，磁盘还在），且 `includeEnv` 带回的使用范围视图也转发同一格（`registered: true|false|null`，旧覆盖实现不给按 `null` 未知）——集成方面板据此识别「包被摘下但没重装」，不再以为包还在（依赖 `0.18.12` 的 `env.registered`）。
- **04 错误信息长行换行（#199）**：单插件面板 04「错误信息」区的日志指引行（中文说明 + 日志路径占位符 + 查看命令 + 插件标识与事件名混排）超宽时被右边框硬裁。现在日志/错误行容器补 `overflow-wrap:anywhere`（与版本号行、批量状态列、安装按钮状态行同风格），内核层一次覆盖双主题；纵滚区横向裁断策略不动，不开横向滚动。只改显示不断数据，「复制诊断」文本逐字节不变。新增 `tests/panel-err-wrap-199.test.mjs`（3 例，先红后绿）。

### Changed
- 测试：新增 `tests/issue-184-timeout-honesty.test.mjs`（3 例，先红后绿——未修树三条全红：无取消能力却声称已请求取消、移除超时不点明包可能已不在册、`includeEnv` 回包不带 `registered`；「有取消能力时口径不变 / 移除超时后不许重装」已由既有 `tests/desktop-manager-hmr.test.mjs` 钉着，不重复）；`tests/panel-prototype-skeleton.test.mjs` 的 `includeEnv` 期望补 `registered: null`（旧覆盖实现不给这格 ⇒ 按未知转发）。
- `tests/fixtures/bilingual/copy-baseline.json`：+1 条新冻结抛错文案、1 条原位改写（散落中文基线「只许减不许增」，新增须在评审里看见）。
- `README.md` §9 补「`0.18.13` 起 `includeEnv` 带回的使用范围视图也带出 `registered`」；`docs/host-install-exits.md` 出口二契约里新增「本包超时人话格」条目（按能力分支 + 移除超时的「可能已不在册」提示 + 可执行重装命令）。
- **发布口径提醒**：`0.18.8`～`0.18.13` 六段都还没发到 npm（registry 最新仍是 `0.18.7`），发版时以 `0.18.13` 一次带走即可。

门禁（**发版定格**）：`npm test` **1469 例：1468 过 / 0 失败 / 1 跳过**（干净发版树 `d071a40` + 本批 9 个文件上实测；本批新增 1 个测试文件、3 例，均先红后绿；本版还带上 `d071a40` 的 #199 面板换行修复，其 3 例已含在总数里）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、351 个 key、16 错误码、19 diag 键，违规 0；本批零新增 key，`copy-baseline.json` +1/改 1 条冻结抛错文案）；`npm publish --dry-run` **95 文件**（`dsh-plugin-update@0.18.13`，358.1 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（351 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.12] - 2026-10-17

### Added
- **装后按「在册」核实（#180，S0）**：装后校验原来只比 `node_modules/<目标包>/package.json` 的版本——磁盘换到目标版本就报 `restart-required`。可「磁盘上有」不等于「重启后会加载」：官方桌面版 profile 的加载名单是清单里的 `dsh.profile.bundles`，宿主只把包体与依赖落盘、没把包重新登记回选中名单时（审查期 probe-b S2/S3 形态：`bundles=[]` + 磁盘已到目标版本；宿主 `removeBundle` 先摘选中、重装又失败），面板会拿到「待重启」的假成功，重启后插件直接消失。现在读取器把在册事实算进环境视图（`env.registered`）：清单有 `dsh.profile.bundles` 就以它为准（目标包名在不在选中名单里）；没有这一层概念的老/最小清单退回 `dependencies` 键。装后校验明确 `registered === false` 即走 `install-failed` 分支，细节写「装完校验没过：profile 未登记该插件（重启后不会加载）」；旧覆盖实现省略本格按未知，不据此判失败（向后兼容）。

### Changed
- 测试：新增 `tests/issue-180-registered.test.mjs`（6 例，先红后绿——未修树红在四种形态：①宿主 applied 但清单没登记（磁盘到目标版、`bundles` 里没有）②`dependencies` 更新了但 `bundles` 仍没有 ③`bundles` 层在但读不成数组（`null`，不退回 `dependencies` 洗成成功）④老/最小清单装后清单里没有该包（证明读的是装后清单）；修复后转绿，另两例钉正常形态与老/最小清单退回 `dependencies` 的成功路径）。`tests/fixtures/bilingual/copy-baseline.json` 只增 1 条新冻结抛错文案（散落中文基线「只许减不许增」，新增须在评审里看见）。
- `README.md`：§9 形状扩展按版本列新增 `0.18.12` 的 `env.registered`，并把「新增可选环境字段」列进向后兼容扩展；§5.4 补「失败优先于待重启」——装后校验失败时快照会同时带 `blockedReason: 'pending-restart'` 与 `job.state: 'failed'`，面板必须先展示失败横幅，不能按待重启说「重启后生效」（本包自己面板已是这个优先级）。
- **发布口径提醒**：`0.18.8`～`0.18.12` 五段都还没发到 npm（registry 最新仍是 `0.18.7`），发版时以 `0.18.12` 一次带走即可。

门禁（**发版定格**）：`npm test` **1463 例：1462 过 / 0 失败 / 1 跳过**（干净发版树 `d803ec9` + 本批 8 个文件上实测；本批新增 1 个测试文件、6 例，均先红后绿）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、351 个 key、16 错误码、19 diag 键，违规 0；本批零新增 key，`copy-baseline.json` +1 条冻结抛错文案）；`npm publish --dry-run` **95 文件**（`dsh-plugin-update@0.18.12`，356.4 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（351 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.11] - 2026-10-17

### Added
- **批量失败横幅两枚批量复制按钮（#176）**：多家安装失败时，失败名单下方多一行——`复制诊断`一次复制全部失败行的诊断文本（按面板顺序逐块 `diagTextOf` 拼接、块间空行，已脱敏），`复制手工命令`一次复制全部失败行的手工命令（有命令的原样一行，缺命令的用 `# <插件名>：无手工命令` 注释行占位，整段可安全粘终端）。集合单一真源 `batchFailedRows`（失败且非排队占位、非待重启、非已装合规版），横幅与两枚按钮永远同口径；一条可执行命令都没有时按钮置灰。新增 `batchFailedRows / batchFailedDiagText / batchFailedManualText` 三个纯函数与两枚 `data-act`（`copy-all-diag / copy-all-manual`），回执带 `{n}` 计数。

### Fixed
- **安装锁自愈（#181）**：旧判据 `if (!current || (job && job.id === current.id)) return false` 拿 `state.json` 当「锁是不是同一任务的」证据，而 0.18.10 之前宿主从不写 `state.json`（#179）——`job` 恒 `null` ⇒ 判据退化成「锁文件能解析就抢」：①1 小时前的崩溃遗留锁会被下一次安装抢走；②别人 `startedAt=现在` 的活锁同样被抢，两进程并发写同一使用范围的 `node_modules`；③空文件/半截 JSON/`null` 锁反而永久 `update-busy`，无 TTL 无自愈，只能手删 `install.lock`（空文件正是 `open(wx)` 之后、写内容之前崩溃的形态）。现在判据只看**时间 + 可解析性**：锁里 `startedAt`（读不出就看文件 `mtime`）早于安装额度 ⇒ 回收并记 `stale-owner`；判不了年龄或未超龄 ⇒ 拒（`update-busy`，且不动别人的锁）。陈旧额度与 `installTimeoutMs` 同源（内置端口由宿主注入，默认 15 分钟），显式注入的 `tryAcquireLock` 保持单参（覆盖实现的旧口径不变）。
- **锁写入原子化（#181 同批）**：建锁改为「同目录写临时文件 → `link` 到锁位」——`link` 在目标已存在时回 `EEXIST`，天然互斥；锁位要么不存在、要么是完整内容，本包再不会留下空锁。不吃硬链接的盘（个别网络盘/FAT）退回 `open(wx)+write`，可用优先。回收与重建之间被别人抢先时直接认输（`update-busy`），不递归重抬。
- **坏锁不再堵死状态读取**：`readJob` 遇到不可解析的锁（空文件/半截 JSON）不再让整次读取失败，而是当「没有锁」继续，把「陈旧与否、要不要回收」留给抢锁那一步判——否则坏锁在快照层就永远 `update-busy`，永远走不到 TTL 回收。
- **锁判据单源化（#181 同批跟进）**：安装锁与跨插件全局锁共用同一套「时间 + 可解析性」实现（`probeLockFile / lockAgeOf / createLockAtomically` 三 helpers；全局锁旧的「读 `startedAt` 差值」分支并入同一判据）。回收动手前加「同代二次核对」（`mtime + size` 未变才删），缩小「判陈旧 → 删锁」之间被别人重建的竞态窗口；`QUEUE_LOCK_STALE_MS` 直接取安装时限默认值，两处额度单源。

### Changed
- 测试：新增 `tests/issue-176-batch-copy-all.test.mjs`（19 例，先红后绿——覆盖按钮出现/消失、失败集合三类排除、无命令置灰、两段聚合文本顺序与块间空行、点击复制回执、双主题成组）与 `tests/issue-181-lock-ttl.test.mjs`（11 例，先红后绿——未修树红在「空文件/非法 JSON/`null` 旧锁永久 `update-busy`」与「别人正在装的活锁被抢走」；覆盖陈旧可解析/空文件旧 mtime/非法 JSON 旧 mtime/`null` 旧 mtime 回收 + 新鲜可解析/新鲜空文件拒绝 + 可解析锁年龄口径（`startedAt` 优先、缺格退回 mtime）+ 坏锁不堵死只读读取 + 全局锁同判据，并断言成功路径放锁、不留 `*.tmp`；首例成功断言加锁释放轮询，消灭并行满载下落锁未放的偶发红）。`tests/store-log.test.mjs` 的锁断言按新判据更新（陈旧改由注入额度造；旧「任务不在而锁还在 ⇒ 立刻回收」的断言反转为「仍拒」——那正是 #181 要改的语义）。
- 验收证据：审查期探针 `.tmp/audit/state/probe-d.mjs` 的 T8 对当前 `dist` 复跑——「1 小时前崩溃遗留锁」被回收且装成（`restart-required`、锁已放）；「`startedAt=现在` 的活锁」被拒 `update-busy`（修复前会被抢走）。空文件/非法 JSON/`null` 三种**新鲜**形态仍按「判不了年龄」保守拒绝，但不再永久：超过 `installTimeoutMs` 后由 TTL 回收（新增测试用 `utimes` 造旧 mtime 覆盖该路径）。T8 探针里「堵死了」的旧提示文字指修复前形态，探针本体未改，以本节与测试为准。
- `README.md` §2.6：批量失败横幅补两枚批量复制按钮口径（与横幅同生灭、无命令置灰）；§3：落盘段补安装锁自愈口径（陈旧阈值 = `installTimeoutMs`；不再需要手工删 `install.lock`）。
- **发布口径提醒**：`0.18.8`～`0.18.11` 四段都还没发到 npm（registry 最新仍是 `0.18.7`），发版时以 `0.18.11` 一次带走即可。

门禁（**发版定格**）：`npm test` **1457 例：1456 过 / 0 失败 / 1 跳过**（干净发版树 `245be3a` + 本批 12 个文件上实测；本批新增 2 个测试文件、30 例，均先红后绿）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、351 个 key、16 错误码、19 diag 键，违规 0；本批新增 2 文案键已进字典+快照，`copy-baseline.json` 未动）；`npm publish --dry-run` **95 文件**（`dsh-plugin-update@0.18.11`，354.6 kB 压缩 / 1.3 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（351 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.10] - 2026-10-17

### Added
- **任务状态落盘、崩溃后可恢复（#179）**：宿主默认接线原来把任务读写接在**内存镜像**上（`mirroredReadJob/mirroredWriteJob`），`createUpdateDiskPorts` 的 `readJob/writeJob` 全仓无人消费——真机 `~/.dsh/updates/<插件>/<hash>/` 9/9 只有 `before.json`、没有 `state.json`。后果：①进程一崩任务即失，安装中的任务重启后变成「没有任务」，`recovery-required` 永不点亮，半装态（磁盘已换版、运行版未换）还会被环境比较画成 `pending-restart`，用户看到的是「待重启」而不是「上次安装没完成」；②失败原文与诊断跨进程即失；③`store` 里坏状态/双读/旧影子回退的既有语义全成死代码。现在写任务时**同时落盘**（显式注入照旧优先；写盘失败不挡安装，`store` 已记 `store.fail`），冷启动首次读任务从盘上取回初值，既有 `corrupt → interrupted`、`recovery-required` 换算接上。

### Fixed
- **前版本保真（#186，并入 #179 同批）**：安装开始时把「动手之前」磁盘上的版本记进任务（`previousVersion`；未安装或读不到即为 null，不拿运行版顶替），`before.json` 与 `state.json` 都带上；读回时保留这一格并把非字符串脏值归一为 null；老形状 `state.json` 缺这一格时，状态读取路径从**同一条任务**（`jobId` 对得上才采信）的 `before.json` 补读。两条安装入口共用同一个 `rememberPreviousVersion`，动作不分叉。

### Changed
- 测试：新增 `tests/issue-179-job-persistence.test.mjs`（3 例，先红后绿——未修树红在「安装中必须留下 state.json」「重启后任务必须还在」「before.json 必须记住前版本」）。用例只用公开电话 + 真实临时家目录/临时使用范围，**不注入** `readJob/writeJob`，强制走真实磁盘端口，否则测的又是内存镜像本身。
- `README.md`：§5.1 补任务形状新增的可选 `previousVersion`；§9 的「唯一形状扩展」改为按版本列出（`0.18.7` 的 `diag`、`0.18.10` 的 `job.previousVersion`），并把「新增可选任务字段」列进向后兼容扩展——公开形状变了，集成方手册必须同步，CHANGELOG 披露替不了。
- 验收证据：审查期探针 `.tmp/audit/state/probe-d.mjs` 的 T9 已对新代码复跑转绿——安装失败后磁盘 `state.json` 存在；「重启后」（新宿主实例）`job` 仍在（`failed`，`message` 带宿主原文）、`previousVersion=2.0.28`、`failedJobDiagOf` 仍取得到失败原文（复制诊断不再跨进程即失）。修复前同一探针红在「磁盘没有 state.json / 重启后 job=null」。T8（锁）与 T9 同文件但属 #181，本批未动，锁的语义仍按票面待修。
- **发布口径提醒**：`0.18.8`、`0.18.9`、`0.18.10` 三段都还没发到 npm（registry 最新仍是 `0.18.7`），发版时以 `0.18.10` 一次带走即可；本批不改变既有快照/电话/字段形状，`UpdateJob` 只增 `previousVersion?` 一格。

门禁（**发版定格**）：`npm test` **1427 例：1426 过 / 0 失败 / 1 跳过**（干净发版树 `b44d2c5` + 本批 8 个文件上实测；本批新增 1 个测试文件、3 例，均先红后绿）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、349 个 key、16 错误码、19 diag 键，违规 0；本批零新增冻结中文，`copy-baseline.json` 未动）；`npm publish --dry-run` **95 文件**（`dsh-plugin-update@0.18.10`，349.7 kB 压缩 / 1.2 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（349 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.9] - 2026-10-17

### Added
- **对抗式审查报告（#178）**：`docs/research/20261017-更新系统对抗审查.md`——按「副本 / 取数 / 决策 / 路由 / 宿主能力 / 状态诊断」六层列失效面，S0-S3 分级、可达性（已爆/可爆/不可达）、确定性分档（证实/推断/未证），并按票号挂到地图 #178 的 14 张子票上（#179-#197）。审查本身只写 `.tmp/audit/` 与报告，不改行为。
- **宿主管理器拒绝码的中文下一步（A 线 R1/R2）**：`already-installed` / `not-removable` / `management-required` / `not-bundle` / `bundle-in-use` / `stop-profile` / `stale-approval` / `incompatible-version` / `build-blocked` / `pnpm-missing` / `disk-full` / `permission` 十二个宿主码不再只回裸码——原文在前、一句「下一步」在后，总长仍守 300 字；未知码一字不加，不编造。

### Fixed
- **scoped 目标包永远 `invalid-release`（B 线 R1）**：发行包地址的形状校验原来拿**带 scope 的全名**拼 `/@scope/name/-/@scope/name-<ver>.tgz`，而真实 registry 对 scoped 包用的是 basename（`/@xmanrui/dsh-im/-/dsh-im-4.39.0.tgz`）——于是所有 scoped 目标（如 `@xmanrui/dsh-im`）在检查阶段就判「版本信息无效」，更新日志与合规版候选同死，而宿主管理器本身允许 scoped 目标。现抽出 `tarballPathnameOf`（取 basename），latest 与版本文档两处同一判据；同时按「同源 + 路径后缀」放行私有源的路径前缀（镜像把包挂在 `/mirror/…` 下也算合规）。
- **源地址漏结尾斜杠 / 带路径时取数必坏（B 线 R5）**：`registryUrl` 原来直接字符串拼接，漏斜杠会拼出 `registry.npmjs.orgdsh-plugin-update/latest`（报 `check-failed` 却没有状态码），带路径则 404。现取数前 `normalizeRegistry` 归一（trim + 补结尾斜杠、保留路径），latest 与时间表两条口同源。
- **全量包文档 256KB 墙打死真实包（B 线 R3）**：`fetchPackumentTimes` 单独抬到 4MB（真机 dsh-prompt 314,765B、`@xmanrui/dsh-im` 458,500B 原来直接 `ERR`）；latest / 版本文档仍守 256KB——两边防的不是同一类输入，不跟着放宽。
- **管理器失败丢退出码（A 线 R8）**：`packageResult.exitCode` 不再被丢弃，失败 exec 日志与详情能带上宿主给的退出码（探针给 137 仍记 null 的旧观感消失）。
- **stable 通道 + 远端 latest 是预发布 ⇒ 整次检查永久失败（B 线 R2 / #183）**：缺省 stable 下，远端 `latest` 是预发布时 `fetchNpmRelease` 以 `invalid-release(stage=channel)` 抛，检查整次 `check-failed`，面板连「通道不符」都说不出（默认目标 deck 的 `latest` 正是预发布，真机复现）。现在检查路径在「**已装版本本身也不在本通道**（或压根未装）」时容忍通道外 latest：快照如实报 `channel-mismatch`、`canInstall=false`、latest 回填，不再整次失败；「已装版本在通道内、只有远端最新是预发布」那一支**保持大声失败**——不取全量包文档就分不清「只有预发布更新」与「取数真坏了」，宁可失败也不悄悄画成「已是最新」（另开票做真修复）。

### Changed
- `docs/host-install-exits.md`：补 `saveExact?` 选项说明（本包不传；管理器默认就写精确版本，真机 specifier `0.3.67` 实证），并把「命令行在那台机器上」从待确认改为**实测可用**（官方桌面自带的载体 CLI 可执行 `add --save-exact`，详见审查报告 D 线）。
- 测试：新增 `tests/issue-183-prerelease-latest.test.mjs`（3 例：已装 beta 时不再整次失败 / 已装正式版+预发布 latest 仍大声失败 / prerelease 通道旧能力不变）、`tests/registry-fetch.test.mjs` 补 6 例（scoped 收与拒、源归一、镜像路径前缀、包文档字节墙、通道容忍）、`tests/desktop-manager.test.mjs` 补 3 例（退出码透传、拒绝码下一步、降级宿主给手工命令）。

门禁（**发版定格**）：`npm test` **1424 例：1423 过 / 0 失败 / 1 跳过**（干净发版树 `b91b4dc` + 本批 12 个文件上实测；本批新增 12 例，均先红后绿）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、349 个 key、16 错误码、19 diag 键，违规 0；本批新增冻结中文 12 条＝宿主拒绝码的下一步建议，`copy-baseline.json` 的 `src/store.ts` 白名单 +12（另 1 条因排序位移在 diff 里成对出现），diff 逐条可见）；`npm publish --dry-run` **95 文件**（`dsh-plugin-update@0.18.9`）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（349 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.8] - 2026-10-17

### Added
- **HMR 守卫的回归测试（#167）**：新增 `tests/desktop-manager-hmr.test.mjs`（15 例，黑箱走公开入口）：守卫命中后的按名移除、重试时的全新 `requestId`、移除被拒/抛错/超时、非 `already-installed` 不越权移除、移除后原文仍含 `already-installed` 如实报、宿主没有 `removeBundle` 时走原失败路、宿主回包里没有 `application` 时按 `install-failed` 收场、共享预算两次收场同钟。对上游有判别力：同一套用例指向**未修**的 `src/store.ts` 是 **10 红 / 5 绿**（红的正是新契约的正向要求，绿的正是「别回归」钉子），不是只会变绿的空测试。

### Changed
- **`installBundle` 的调用形状收紧（#167）**：把方法取成常量、显式写成 `installBundle.call(manager, …)`（闭包里的属性收窄会丢，`tsc` 会拦），不再依赖「调用点恰好写成 `manager.` 前缀」这件事。既有发货代码本来就是方法调用、`this` 一向正确，所以这是加固，**不是**修一个已经发生过的故障。

### Fixed
- **已装包更新不再必然被 `already-installed` 打死（#167）**：desktop-manager 路由下，只要目标在 profile 里已经装过（直接依赖，或 `dsh.profile.bundles` 里的名字），宿主的 HMR 守卫就在跑 pnpm **之前**以 `already-installed` 拒绝安装——真机表现是 `update.install.exec ok=false durationMs=4`（同步拒绝，pnpm 根本没起）。旧码把这个错误码当终局失败直接报出，重试也只会得到同一个拒绝，因为守卫只认名字、与版本无关，于是「更新一个已装插件」在这条路由上**永远**不通。现在按宿主自己文档的出路走「如实移除 → 再装」：从 spec 抠包名（`@scope/name@1.2.3` 只认首尾 `@`，抠不出即不越权）→ `removeBundle(包名)` 按名移除（宿主文档注释写的是「Installed dependency or selected bundle name」，所以同一个管理态里的包名也算数）→ 移除成功后再拉起安装；第二次**无论以什么理由失败都如实转述**（若仍是 `already-installed`，摘要里就还是它），第二次不再重调 `removeBundle`、也不与首次共用编号（每次调用各带一个新的 `requestId`）；宿主三态（`applied`／`restart-required`／`overridden`）之外的 `application` 一律按 `install-failed` 收场——`cancelled` 用既有的「安装已被取消」，其余保留宿主原话（认不出形态时写 `application: <原文>`），不编造成功。装、移除、重装三步共用配方里那**一个**默认 15 分钟额度（`INSTALL_TIMEOUT_MS`；调用方注入 `timeoutMs` 时以注入值为准，每步只领剩下的），多一步不放宽总上界；某一步到点（安装步先请宿主 `cancelInstall` 取消，移除步没有可取消的对象）再给 3 秒终止宽限期等它自己收尾（`TERMINATION_GRACE_MS`：额度 20000ms 时实测总时长 23016ms），所以「最坏结束时间 ≈ 额度 + 3 秒」。移除这一步撞上额度时出人话 `移除已装包超时，未继续安装`（不借用「安装超时」的说法，免得让人以为还在装）。**残留风险（未修，已记档 #168）**：移除成功、重装又失败时，详情只有第二次的宿主原话，**不会**告诉用户「目标包现在已经不在册」。

门禁（**发版定格**）：`npm test` **1412 例：1411 过 / 0 失败 / 1 跳过**（266 套；本批新增 1 个测试文件、15 例：HMR 更新的黑箱契约，同一套用例指向**未修**的 `src/store.ts` 是 10 红/ 5 绿，所以它不是只会在新码上变绿的陪跑）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、349 个 key、16 错误码、19 diag 键，违规 0；新增冻结中文只有一条，`copy-baseline.json` 的 `src/store.ts` 白名单 +1，diff 里逐字可见）；`npm publish --dry-run` **95 文件**（343.4–343.6 kB 压缩 / 1.2 MB 解包：两次独立运行同口径，tarball 体积随包内 mtime 微差）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（349 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.7] - 2026-10-17

### Added
- **批量面接上合规版降级（#156 场景三）**：`0.18.6` 只让单插件面板在“最新版被年龄门拦住”时有出路，批量面仍只剩一行失败。现在行级与批量级共用同一套兜底：自动出决议（合规版可用 → 点名版本的确认条，确认后才装，永不静默降级）、收尾给事实横幅、入口徽标同口径；总账把「等重启」与「已装合规版」从失败改记「待重启／已最新」（M1）。安装按钮失败页同样双出口［装合规版］［等新版］，与面板同一口径。

### Fixed
- **异步安装失败不再靠插件标识猜真凶（#156 第四轮 B1/B4）**：生产形状下宿主任务键是 `life-<key>`、与 npm 包名不同名，面板据此认因会认错。宿主新增 `failedJobDiagOf`：快照里任务已失败时，在**成功回包**上补一份机读 `diag`（带目标包名）；面板归因优先机器可读的 `fallbackCauseFromDiag`，成功回包里的 `diag` 也进失败锁存。`store` 三条宿主安装路都收 pnpm 原文并挑出「签名 + 错误码」行，`job.message` 从此带得动面板认得出的因。唯一契约扩展：快照带失败任务时成功回包可带可选 `diag`（回包形状约束 #21 的唯一例外；无失败任务时形状逐字不变）。
- **凭证与决议的时序（#156 第四轮 B2/M2/M3）**：凭证槽改模块级、跨读取器存活（同一轮检查里被多个读取器取用不再互相灭灯）；`ok-now` 结论也发凭证，不再出现「确认时才发现没据可依」；确认装合规版时重跑决议，结论已变则如实回 `check-expired`，不偷换点名版本。
- **诊断原因行不再被前缀污染（#154 续）**：`operation-error:` 之类前缀不再混进「原因行前置」的判定与输出（#154-5/6）。

门禁（**发版定格**）：`npm test` **1397 例：1396 过 / 0 失败 / 1 跳过**（265 套；本批新增 5 个测试文件、净增 104 例：批量面兜底与收尾事实、失败归因走机读 diag、凭证槽跨读取器存活、安装按钮双出口、pnpm 原文提取，均先红后绿；1 例跳过仍是 `DSH_UPDATE_CONSUMER_REPO` 缺席那条）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（44 个 src 文件、349 个 key、16 错误码、19 diag 键，违规 0；新增 9 文案键已进字典+快照）；`npm publish --dry-run` **95 文件**（339.9 kB 压缩 / 1.2 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（349 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.6] - 2026-10-17

### Added
- **合规版降级（#156 场景一/二/四）**：年龄门拦住更新目标时，给“满门限的最新版”选择。新纯模块 `src/compliant-version.ts`（五值裁决 ok-now/wait-until/downgrade-available/no-compliant/abstain；时间只读 registry 完整包文档 time 表并认 5 分钟 CDN 延迟；窗口带出处，文案分“精确/约”；候选三锁；算不出即认怂）。新增 `updateCheckFallback` / `updateInstallCandidate` 两条电话（冻结名单同步；老宿主缺电话时自动退化“只呈现”，面板不碎）。失败页双按钮［装合规版］［等新版］＋决议确认流（确认按钮点名版本，永不静默装老版）。检查页记住窗口后换预判横幅（不再说“可安装”、主安装按钮置灰、给［装合规版］走同一决议流；记住过期/对不上版/时钟坏一律退回老样子；解封后点装合规版走 ok-now 直接装最新）。拦的是树里别家包时无按钮，但真凶/解封/证据三件套齐。

门禁（**发版定格**）：`npm test` **1293 例：1292 过 / 0 失败 / 1 跳过**（新增 46 例、四个新测试文件，均先红后绿；含对抗审查补洞：checkFallback 归因缺失/胡写改认怂 abstain 且零联网、跨挂载锁存补记）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（新增 8 文案键进字典+快照，340 key；diag 19 键、16 码×2 形态）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（字典 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.5] - 2026-10-16

### Added
- **安装失败翻译官（#155）**：已知签名识别 + 诚实归因 + 中文怎么办。新纯函数模块 `src/install-cause.ts`（签名表 + 三值归因 + 解封反推，零 I/O、时间为入参、无中文文案）：首期只认 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`（认方括号机器码 + 命名捕获抠包规格/发布时间/门限，抠不出即作废走通用老路）；归因三值（主包自己 / 非主包只摘嫌疑不断关系 / 未知），措辞只排除、不定罪；解封时刻优先取报文自述窗口（`publishedAt + N minutes`），无窗口才门限反推（`publishedAt + (now - cutoff)`），永不硬编码策略时长；原文照样保留可上诉；另有“未识别签名统计”口指导下一种签名先做哪个。`diag` 只增可选三键（`causeKind/causePackage/causeUnlockAt`，19 键，顶层码保持 `install-failed`，老面板逐字不变）；面板复制诊断的“怎么办”按结论换专项句（banner 与 04 章通用句不动，另票做）。

### Fixed
- **解封时间以报文自述窗口为准（#155 对抗审查）**：门限反推假设 `cutoff = 评估时刻 − 策略窗`，现场验算偏晚约 55 分钟（给 14:53，真值 13:58）。现优先 `publishedAt + 报文里的 N minutes`（安装器自己说的，最准；0 分钟/超十年当没说），无窗口才回退门限反推；算出来已过即省略，不叫人等过去的时间。

门禁（**发版定格**）：`npm test` **1247 例：1246 过 / 0 失败 / 1 跳过**（新增 `tests/install-cause.test.mjs` 31 例：签名正/对抗/降级、真值表三归因×时间可算/不可算、窗口优先恒等式、无窗口回退、离谱窗口回退、窗口已过省略、F2 无目标不谎称他包、F8 查侧不问，均先红后绿；含对抗审查补洞：token 位置无关、坏时间省略）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（新增 4 文案键进字典+快照，diag 19 键、16 码×2 形态）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（字典 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.4] - 2026-10-16

### Fixed
- **安装失败摘要原因行前置（#154）**：`install-failed` 的工具输出头重脚轻（进度头 + 中部真因 + 尾部噪音）而预算截断只保头，真因（如 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` + 包名）常掉在省略号后面。现把命中失败标记的行（✗/`ERR_`/`failed`/`error`/失败/错误等，含其缩进续行）按原相对顺序提到最前面，再走既有预算截断。纯重排、不增删一字，预算墙/白名单/脱敏不动；其它错误码一字不动。
- **未知源文案说人话（#154）**：无 `registryHost` 的诊断复制行由 `源=未知（非官方源时省略本身即信息）` 改为 `源=未声明`（en `Source=Undeclared`）。不编造来源（market 通道与默认源都不断言）。

门禁（**发版定格**）：`npm test` **1216 例：1215 过 / 0 失败 / 1 跳过**（新增 `tests/issue-154-install-diag.test.mjs` 4 例：长输出真因前置、非 install-failed 不动、无原因行不动、源=未声明，均先红后绿；`tests/panel-diag-22.test.mjs` #22 期望同步）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（本次无新增文案键，仅改一键中英文值 + 快照同步）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（字典 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.3] - 2026-10-16

### Added
- **开发态挂载独立码（#153）**：新增 `dev-source` 阻塞码（取值可增，向后兼容）。junction / 源码链接 / 显式外部目录（包定位到但反推不出使用范围）不再报 `unknown-profile`；包真找不到仍报 `unknown-profile`，行为一字不动。面板给 junction 口径文案（开发态挂载，更新中心不可用；改完仓库代码后重启宿主生效），且与源码安装同口径不提供手工命令。`codes / host / reader / panel / bilingual / diag / commands` 七处联动 + README §5.2（九种→十种）+ 码表测试与双语快照同步。

### Fixed
- **无快照失败页补回复制诊断（#153）**：`copy-diag` 门从 `if (snapshot)` 放宽为“有快照或失败横幅或失败引用即画”。首帧即失败（`unknown-profile` / `dev-source` 类不写快照的失败）时按钮不再缺席，与 04 章“请使用「复制诊断」整段粘贴”指引一致；首帧 loading（无快照、无失败）仍不画，不多按钮。

门禁（**发版定格**）：`npm test` **1212 例：1211 过 / 0 失败 / 1 跳过**（新增 `tests/issue-153-dev-source.test.mjs` 7 例：显式外部目录→`dev-source`、真找不到→`unknown-profile`、指错目录不谎称开发态、文案/手工命令/稳定码、无快照失败有按钮、loading 无按钮、真 junction 读者层，均先红后绿；含对抗审查补洞：host 判别式锚 `loaded`）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（新增 3 文案键进字典+快照，阻塞 10 + 电话 5 + internal = 16 码）；`npm publish --dry-run` 见演练记录；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（字典 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.2] - 2026-10-16

### Fixed
- **检查的后置条件（#152）**：`batchCheck`（含面板自动查）以前只写知识账本、不碰会话，会话进入终态后昨日的失败与陈旧目标永生——面板把昨天的 `targetVersion`（如远端曾是 `0.3.55`）配上今天的运行版（如 `0.3.60`）画成「有新版本」，降级当更新卖。现在成功查出的结论按与驱动预查同一口径收敛进会话（有新版 → `ready` + 目标置新；已是最新 → 清掉陈旧目标；检查失败 / 待重启 / 飞行中的行不动；驱动半路起跑跳过落盘；回包永远落盘后重读，端出去的和盘上是同一份）。渲染层再加一道数字守卫：目标版不比当前版新，永不画「→ 新版本」。

门禁（**发版定格**）：`npm test` **1205 例：1204 过 / 0 失败 / 1 跳过**（新增 `tests/issue-152-check-reconcile.test.mjs` 8 例：新鲜检查冲掉陈旧会话、倒挂目标永不画箭头，均先红后绿；含对抗审查补洞：飞行中行跳过、无条件 current 收敛、落盘后重读）；`npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（本次未新增文案键）；`npm publish --dry-run` **81 文件**（302.2 kB 压缩 / 1.1 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（字典 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.18.1] - 2026-10-16

### Fixed
- **过期凭证自动续一次（#150）**：面板与安装按钮的安装动作被拒为 `check-expired` 时自动重查并用新凭证重装一次，仍败才展示失败；“重试安装”不再复用旧编号空转。查回 `ok:true` 却无收据时按快照真实故事展示（阻拦横幅 / 空闲态），不再本地伪造 `check-expired` 掩盖真正原因。
- **`host.call.fail` 日志行加 `error` 稳定码一格**：此前只有 `errorHash`（djb2），现场排错需手算反查；现与回包同一稳定码（闭合词汇，无自由文本），旧读数忽略未知格（#150 破冰，见该票进度区）。

## [0.18.0] - 2026-10-15

### Added
- **安装按钮控件**（新子路径 `dsh-plugin-update/install-button`）：`mountInstallButton(container, { pluginId, call, prefix })` 在任意卡片里原地装好一家插件。判定、文案、诊断、日志与面板同一口径（复用 `panelViewModel` 与既有文案键，只新增 `install-button.action.installed`「已安装」一键）；单按钮双角色（可装即装，否则退回检查）；点下先查后装、连点只认第一次；装中轮询有界（300 轮封顶）；失败给重试 + 复制诊断 + 手工命令 disclosure；待重启无安装动作；卸载只停轮询。唯一既有改动是 `messageCodeOf` 加 `export`（行为零变化）。详见 README 第 2.8 节。

## [0.17.1] - 2026-10-15

**失败态滚动归位**：更新失败后拖面板滚动条不再一松手就回顶部。两处病因同修：同语义失败的重复轮询不再重建锁存（“失败于”时刻冻结在首次失败，不再每秒漂移触发整树重绘）；重绘的滚动保持从内层滚动区扩大到外层面板根。语义真变（新失败、版本三元组变化、成功终态）仍即时重绘；成功态 / 忙态 / 诊断文案一字不动。

### Fixed
- **失败态每秒整树重绘（#143）**：只读轮询拿到同语义 `failed` / `interrupted` 快照时跳过重建（除 `atMs` 外逐字一致即同一失败），“失败于 HH:MM:SS”不再随轮询漂移。
- **外层面板根滚动保持（#143）**：重绘时在内层滚动区之外同时保存 / 恢复 dialog 外层面板根的滚动位置；焦点恢复语义不变，无 DOM 查询能力的容器与 embedded 走原分支。

门禁（**发版定格**）：`npm test` **1167 例：1166 过 / 0 失败 / 1 跳过**（新增 `tests/issue-143-failed-poll-stable.test.mjs` 与 `tests/issue-143-outer-scroll.test.mjs`，均先红后绿）；`node build.mjs`（含 `tsc --noEmit`）与 `npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（字典 322 个 key 0 违规，本次未新增文案键）；`npm publish --dry-run` **79 文件**（292.5 kB 压缩 / 1.0 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（322 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.17.0] - 2026-10-15

**未装也能装**：从没装过的插件不再被说成「装坏了」。读取器新增一等事实 `installed: boolean`（缺席的判据只有目标包那次读取的 `code === 'ENOENT'`；坏 JSON / 权限错误仍是 `invalid-installation`，洗不成未装）；缺席时判定提前返回、不算只对在场包有意义的指纹；查到远端发行版即可安装（动作词「安装」，不再与注入的运行版号比大小）；两个面板把该行说成「未安装 → 目标版本」，失败文案查装分家（查侧说「本次未能查询」，装侧才说「安装失败」）。消费方一行不改。

### Added
- **在场事实 `installed: boolean`**：`EnvironmentView` 与服务快照各加一字段（快照六字段 → 七字段）。缺席时 `installedVersion` 为 `null`、`blockedReason` 为 `null`、`eligible` 为真，不新增稳定码。
- **双语状态词「未安装 / Not installed」**（批量行 + 单插件横幅两处新键，进字典与快照）。
- **查侧失败判定 `isCheckSideFailureCode`**（`src/codes.ts` 派生，`check-failed` / `invalid-release` / `check-expired` 三码；面板失败行按它分家）。

### Changed
- **缺席可安装**：`canInstall` 按在场分叉——缺席分支只看「远端有合法版本 + 指纹一致（双方皆空的相等写死）」，不再看 `newer`；通道判定内联在场分支、Node 不兼容只记不拦（装到才失败）。
- **账本与行内快照同步在场事实**：`installed` / `installedVersion`（只取磁盘版，不回退注入的运行版号）进账本条目与批量行内快照；未装行不再落 `failed` 相位与 `error`。
- **版本号 `0.16.4` → `0.17.0`**（向后兼容的加法：只增字段与文案键，既有码含义一字不改）。

门禁（**发版定格**）：`npm test` **1165 例：1164 过 / 0 失败 / 1 跳过**（新增 `tests/issue-134-not-installed.test.mjs` 7 例钉读取与判定、`tests/issue-134-panel-not-installed.test.mjs` 16 例钉两面板渲染与批量真装；注：`tests/batch-host.test.mjs`「真路径两家批」在全量并行负载下偶发一红（500ms 定序的时序用例），单跑与重跑皆绿，与本次改动无关——该用例的 `readInstalled` 是假件，不走真读取器）；`node build.mjs`（含 `tsc --noEmit`）与 `npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（文案源 grep 扫描 36 个源文件 0 违规 / 字典快照 322 个 key 0 违规 / 15 码与诊断解析契约）；`npm publish --dry-run` **79 文件**（1.0 MB 解包）；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（322 个 key 仍全是 `draft: true`，含本次新增 2 键，理由见 `0.16.0` 节末）。

## [0.16.4] - 2026-10-15

**宿主侧链 + 集成 `dsh-log` 0.3.4**：本包**自建落点**的行从此带上 `traceId`/`spanId`/`seq`（一次电话一条链），运行期依赖下限从 `^0.3.1` 抬到 `^0.3.4`，启动头补上「这个目录是哪一版写的」。行为面只增不改：没有链的场合（集成方注入的客户端实例、降级落点、面板 `logAppend`）一字不变。

**发布口径**：`0.16.3` 未单独发到 npm，其内容随本版首发（与 `0.14.0`/`0.15.0` 同例）。

### Added
- **宿主侧链上下文**（`src/log/trace.ts`，采纳 `dsh-log` 0.3.3 起的 `store.trace()`）：宿主侧的多步链（查 → 判 → 装 → 验）从此**一次电话一条链**——同一通电话里的多行共享一个 `traceId`，`seq` 从 0 递增；`withLogTraceStep` 换 `spanId`、`seq` 重新从 0 起，用来分步骤边界。三条纪律：**认源**（链只对建它的那个落点生效，A 插件的链绝不写进 B 插件的目录）、**没有链时一字不变**（集成方注入客户端实例、降级落点、面板侧的 `logAppend` 行照旧）、**永不外抛**（取链失败按「没有链」处理）。用 `AsyncLocalStorage` 而不是模块级变量：一个进程里可能同时跑着轮询与安装两条链、还可能有多个插件，模块级变量会让它们互相串味。
- **`ownPackageVersion()` 与 `packageRoot()`**（新模块 `src/log/own-version.ts`，从 `dsh-plugin-update/log` 导出）：读随包 `package.json` 的版本号，同步、进程内缓存、读不到回 `null` 绝不抛。启动头那一格用它。

### Changed
- **运行期依赖下限 `dsh-log` `^0.3.1` → `^0.3.4`**。链能力要 0.3.3 起才有（`store.trace()`）；0.3.1/0.3.2 上本包是**形状探测**（`src/log/sink.ts`：没有 `trace` 键就退回 `fire`），也就是**装上了也不会有链、还不报错**。抬到 `^0.3.4` 之后「装了就有链」才是保证，同时吃到 0.3.4 的引擎侧修复：启动头幂等（同一个实例只写一行 `host.start`）、启动头记 `os`、目录摘要不再把读不出来的文件当空文件、保留字影子计数只数真冲突。
- **启动头 `host.start` 写 `pluginVersion`**：登记表在建库配置里默认填本包版本（调用方可以用 `acquireOwnLog({ pluginVersion })` 覆盖成自己那一版）。**必须建库那一刻给**——0.3.4 起启动头幂等，晚一步传等于永远写不进去。
- **README 的追链口径翻转**（§10、§11）：原文写「`--trace <traceId>` 在本包自建落点的行上追不到链」，现在**追得到**（同一通电话的行共用一条链）。`--trace` 用法照旧，只是对本包的行也有效了；文档同时注明三件套由引擎注入、不在事件清单的字段白名单里，读侧要用 `stripReservedLogFields` 先摘掉。

### Fixed
- **启动头此前没有版本号那一格**：`OwnLogAcquireInput.pluginVersion` 声明了、注释也写了「不给就用本包自己的版本」，但建库调用从没把它传下去（`src/log/registry.ts`），`ownPackageVersion()` 也压根不存在——交日志时对方问「这堆行出自哪一版」只能靠猜。现在建库配置真的带上它，并有真引擎端到端用例钉住（启动头恰好一行、`pluginVersion` 等于本包版本、带 `os`）。

## [0.16.3] - 2026-10-15

**契约回填**：把随包事件清单从「意图稿」改成「实现真给的东西」，并清掉一条会误导使用者的命令。**事件名与字段名有删减（28 → 26）**，其余形状不动、行为不变、不加依赖（`dsh-log ^0.3.1` 仍是唯一运行期依赖）。

### Removed
- **`update.install.retry`（事件）**：从 `event-list.update.json` 删除。本包**没有自动重试** —— 面板上的重试按钮就是再发一次安装，落 `update.panel.action{action:'install'}`。原条目声明的 `attempt`/`of`（「第 N 次重试」）在本包里没有任何生产者，`src/` 全仓零发射点、`tests/` 零引用。
- **`update.restart.outcome`（事件）**：从 `event-list.update.json` 删除。**宿主没有重启自己的电话**（代码原话），本包只做入口（`update.panel.action{action:'restart-hint'}`），观测不到重启结局；原条目声明的 `outcome` 三值同样零生产者。
- **`update.registry.fetch.cacheHit`（字段名）**：从清单删除。缓存命中发生在取数之前（命中就根本不取数），到了取数点必未命中 —— 恒为 `false` 的格子只是噪声。该字段名**从未在任何落盘行里出现过**，删掉不影响已解析的行。

### Changed
- **事件清单计数**：**26 个事件**（常驻 18、按需 7、自监控 1）。README §10 与 `docs/maintainers.md` 同步。
- **事件目录契约回填**（`docs/research/20261014-log-event-catalog.md`，新增 §7）：除上面三条外，改正四处「本文件写错、随包清单本来就对」的地方 —— `update.panel.action.action` 是 **11 值**（`'copy-diag'` 不是 `'copy-diagnostics'`）；`update.changelog.parse.source` **恒 `'npm'`**；`update.check.fail.stage` 四个值合法但**可达三值**（`compare` 无生产者）；`update.lang.applied.source` 是**四值**（补 `'default'`）；`update.store.fail` 落点 **16 处**。§0 的「常驻必须边沿触发（铁律）」改述为「**不是机器规则**：全仓只有 `update.status.changed` 与 `update.queue.transition` 两条受指纹去重保护」。
- **面板日志路牌与 README 去掉 `tail`**：`dsh-log` 0.3.1 的 `USAGE` 写 `dsh-log tail <目录>`，但 `dist/cli.js` 没有子命令解析 —— `tail` 被当成一个不存在的路径，先往 stderr 吐一句「没找到日志目录：tail」（日志照常输出、退出码仍是 0）。本包所有面向使用者的命令改成 `npx dsh-log <目录>`，并在 README §11 写明为什么不要写 `tail`。

### Added
- **事件目录 §7「契约回填」**：逐条列出「本文件曾许过、实现没给」的四处（含上面三条 + 挂载点 `mode` 的可达四值），并把三条**记录但不修**的边界备案：① 丢弃计数不接（dsh-log 的 `getDroppedCount()`/`setOnDrop()` 本包没有接）；② trace 只有一半（`buildRowText` 与 `store.log` 都没有 trace 槽位，`traceId`/`spanId` 只由 dsh-log 客户端 SDK 的写入路径注入）；③ 上游 `USAGE` 与解析器不一致。另记三条**明确不做**：跨进程租约（实测两进程各 1200 行 × ~3 KB 共 2400 条一条不少）、清单合并上游化、开关热更新（引擎的开关是实例级闩锁，改 JSON 是重启级旋钮）。

门禁（**发版定格**）：`npm test` **1126 例：1125 过 / 0 失败 / 1 跳过**（`tests/gate.test.mjs` 新增三条契约回填负向断言：两个事件名与一个字段名不许再回到清单里）；`npm run build`（`node build.mjs`，产出 `dist/` 与 `.d.ts`）与 `npm run typecheck`（`tsc -p tsconfig.json`）过；`npm run gate:bilingual` **三道硬门禁过**；噪声预算装置 `node .tmp/log-verify/run.mjs budget` **8/8 过**（被测 `dist` 66 文件 / sha256 `b81e1a539f82e3d2…`，跑动期间 `dist` 未被改写）；`npm publish --dry-run` **73 文件**（281.3 kB 压缩 / 991.9 kB 解包）。`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（320 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.16.2] - 2026-10-15

对外「介绍面」统一补丁：npm 页、GitHub 仓库页、用户手册三处对同一件事的说法对齐，并清掉仓库树里混进来的会话垃圾。**不改行为、不改形状、不改落盘契约、不加依赖**（`dsh-log ^0.3.1` 仍是唯一运行期依赖）。

### Changed
- **`package.json` 元数据**：`description` 从「可复用的更新系统装成的 npm 包：…（地图 #579）」换成面向使用者的口径——旧句把内部地图号写上了 npm 页，而 npm 页的「About」与搜索结果都直接取这句。新增 `keywords`（`dsh` / `dsh-plugin` / `self-update` / `updater` / `plugin-update` / `changelog` / `typescript` / `dsh-log`）与 `homepage`（本仓 README）、`bugs`（本仓 Issues），npm 页从此有标签与可点的来源、问题入口。
- **README 的版本归属按「装得到的版本」说话**（`:13`、`:536`、`:604`、`:633`、`:635`、`:680`）：`0.14.0` / `0.15.0` 从未上过 npm，原先那几处「`0.15.0` 起有 dsh-log」「`0.15.0` 之前的旧名」会把集成方指到一个装不到的版本号（`0.16.1` 只改对了依赖与版本号两处，归属仍留在 `0.15.0`）。改齐为 `0.16.0` 起；旧名那处补明是「`0.13.0` 及更早已发布版本」的名字。**只动版本归属，能力描述一字未改。**

### Added
- `scripts/release-notes.mjs`：按版本号从 `CHANGELOG.md` 里取该节正文打印（`--title` 只打标题、`--check` 只校验该版本节在不在），GitHub Release 的说明直接用它生成——Release 与 CHANGELOG 同一份来源，不再手抄一遍。

### Fixed
- **仓库树里混进来的会话垃圾**：`.local/`（内票正文草稿、`state/gh/device-id`）、`.merge-backup/`（pre-merge 副本与验证页）、`.dsh-vision-router/`（整屏截图 12 张）、`.scratch/`（交接稿）、根上的 `.tmp-issue70-body.md` 与 `.tmp-probe-{before,after}.json`——共 **27 个文件约 1.9 MB**，全都只是本地会话产物，却跟着公开仓库一起 clone。从版本库移除（`git rm --cached`，本地文件原样保留，**未改写历史**），并把 `.local/`、`.merge-backup/`、`.tmp-*`、`.dsh-im/` 补进 `.gitignore`；`.dsh-vision-router/` 与 `.scratch/` 本就在忽略表里，只是先于规则入了库。

门禁（**发版定格**）：`npm test` **1126 例：1125 过 / 0 失败 / 1 跳过**（比 `0.16.0` 那行多 1 例：复核阶段补的挂载级路牌测试）；`npm run build`（含 `tsc --noEmit`）与 `npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（文案源 grep 扫描 33 个源文件 0 违规 / 字典快照 320 个 key 0 违规 / 15 码与诊断解析契约）；`npm publish --dry-run` **73 文件**（279.7 kB 压缩 / 987.5 kB 解包——`scripts/` 不在 `files` 白名单，新增的发布说明脚本不进包）。本版不碰发射侧与面板渲染，噪声预算装置没有重跑；`gate:bilingual:release` 的第四道照旧**如实红、非阻断**（320 个 key 仍全是 `draft: true`，理由见 `0.16.0` 节末）。

## [0.16.1] - 2026-10-15

纯文档补丁：不改行为、不改形状、不改落盘契约、不加依赖。起因是对抗式复核（`docs/research/20261014-log-integration-review.md`）查出用户手册与实现不一致，而 `0.16.0` 的 tarball 已经带着这些错行上了 npm——所以补一版，让 npm 页跟着对（票 `#132`）。

### Fixed
- **README 第一屏**（`:13`）：原文「要求 Node 22 或更高，零运行时依赖。当前版本 `0.10.0`」两处都错——`0.15.0` 起 `dependencies` 里就有 `dsh-log ^0.3.1`（ADR-0005 明确破掉「零运行期依赖」，本包从此不是零依赖包），版本也早不是 `0.10.0`。改成「要求 Node 22 或更高。运行期依赖只有一个：`dsh-log ^0.3.1`（0.15.0 起，见第 10 节）。当前版本见上方徽章与 `package.json`」——**不再写死版本号**，免得下次发版又漂。
- **电话个数**（`:17`、`:570`）：`0.16.0` 已按 `#122` 追加第五个电话名 `logAppend`，第一屏与第 7 节自检清单仍写「四个电话」；改齐为五个（`:63`、`:80`、`:674` 本来就是五个）。
- **命名空间口径**（`:686`，同处 `:640`、`CONTEXT.md:26`、本文件 0.15.0 条目、`src/log/namespace.ts` 的不变量注释）：原文「去首尾 → 截 32 位」与「不同 `pluginId` 永不共目录」都不准。实现是：合法标识（1–32 位）原样通过；有损分支 slug 截 24 位再补 `-<sha256 原文前 6 位>`（合计 ≤31）。所以只有**无损分支**保证不共目录，有损分支是 24 位指纹的**概率性**隔离。
- **追链口径**（`:562`、`:703`，同处事件目录 §4 规则 2）：不再把 `npx dsh-log tail … --trace <traceId>` 当既有能力。`traceId`/`spanId` 只由 dsh-log **客户端 SDK** 的写入路径注入；本包自建落点走宿主 `store.log`，行里没有这三个字段（实测落盘行只有调用方给的 `fields`）。

## [0.16.0] - 2026-10-14

### Changed
- **破坏性（形状）**：`ChangelogEntry` 新增 `otherSections: Array<{ title: string; items: string[]; count: number }>`——**非六类小节名的整节内容不再被丢弃**，按作者原标题原样收进来（此前 `### Patch Changes` / `### 🚀 Enhancement` / 无小节名的裸条目全部静默消失）。只读 `sections` 的集成方零改动；想显示作者自定义小节的集成方读 `otherSections`（`renderChangelogHTML` 已经画）。
- **破坏性（诊断码）**：`E_CATEGORY` 下线——非六类小节名不再丢内容，改报 `W_CATEGORY_OTHER`（提示，不拦）；新增 `E_BULLET_ORPHAN`（版本节之外的条目，其内容确实进不了任何版本节，仍是 Error）。`E_VERSION_TITLE` 语义收窄为「像版本标题却取不出号」（`## 1`、`## 2026-10-14`）；`## 1.0` 这种两段版本号 0.16.0 起是合法版本节，内容照收。
- 版本标题识别放宽到 1–4 级任意标题 + setext（`===`/`---` 下划线）＋ 标题任意位置的版本号：`# v0.14.0 (Mon Jun 29 2020)`、`#### 🚀 Enhancement` 这类真实日志（jimp 形态）不再整节丢字。闸门仍是「看起来是版本节」：`# Changelog`、`## License`、`### 修复 1.2 的 bug` 不会被误当版本节（两段号必须标题里除它只剩装饰）。
- **顶格内容不再丢**：顶格段落、顶格引用（`>`）、顶格围栏代码块都收进条目（此前静默丢弃，围栏里的内容此前整段丢掉）；一律转义，永不直通 HTML。空行是段落边界——顶格块另起一条，缩进行照旧并进当前条目。
- 截断不再静默：文件超 64 KiB 时面板补一行说明，版本被截时再补一行（`changelog.truncated.file` / `changelog.truncated.versions`）——少了条目、为什么少，读者看得见。
- **冻结面追加第五个电话名 `logAppend`（`#122`，破冰结论见 issue）**：只在既有四个名字之后追加，`updateStatus` / `updateCheck` / `updateInstall` / `updateChangelog` 一字不动；`tests/{config,phones,queue,batch-host,gate}.test.mjs` 里「电话名一字不差」的断言同步扩到五个，HTTP 白名单放行 `logAppend`，批量宿主按目标自动带上（每个目标各自的 `<前缀>.logAppend`）。
- 随包事件清单的读取由**异步**改**同步**（`readFileSync`，进程内缓存一次）：字段白名单的判据必须当场就有——异步读会让同一行「先放行、后拒收」，行为随微任务时序漂移（`#122` 抓到的真实差异）。读不到清单时照旧放行 + 记一条 `update.log.degraded`。
- **轮询噪声在发射侧治掉（`#124`）**：`updateStatus` 的成功行**一条都不发**——判据是「上次算得出指纹、这次算得出、且与上次不同」才留一行；第一次轮询没有可比的上次，所以也不留（这就是「N ≥ 100 次连续轮询零常驻行」的字面口径，实测 600 次 → **0 行**）。`host.call` 的名字与五键形状**一字不动**，失败行 `host.call.fail` 不受影响；状态真变时另发一条 `update.status.changed` 供追溯。依据：`host.call` 在 dsh-log 内置常驻名单里（43 名之一），集成方清单改不动它，只能在发射侧治（治理前现场 600 次轮询即 600 行，外推 ≈86400 行/天）。
- **两个「只进日志」的可选入参（`#124` 破冰结论）**：检查电话多认 `trigger`、安装电话多认 `from`（缺省 `'panel'`，批量宿主传 `'batch'`）——不参与任何决策、不改回参形状、老调用一字不动。冻结面的这两处改动已同步 `docs/maintainers.md` 与 README 第 10 节。
- 口径按实现收紧：`update.registry.fetch` 的 `cacheHit` **不发**（本包缓存命中发生在取数之前，到了取数点必为未命中，恒 `false` 的格子只是噪声）；`update.store.fail` 的 `op` 收成 11 个稳定码、`reason` 用 errno 稳定码；`update.check.done` 的 `stage` 四值（`fetch`/`compare`/`channel`/`verify`）钉在实现上。

### Added
- `parseChangelogReport(markdown)`（新导出）返回 `{ entries, truncation }`，把「被截断」作为数据交出来（`truncation` 含 `chars`/`tailVersions`/`entries`/`sections`/`sectionItems`/`items`）；`parseChangelog` 仍是 `.entries` 的薄封装，老集成方零改动。
- 未知小节按作者原标题显示（`otherSections` + `.dsh-upd-changelog-cat[data-cat="other"]`）——六类之外的节不必再「要么改名、要么消失」。
- 双主题为块级与自定义小节补样式（默认主题直接生效，档案卷 `[data-theme="archive"]` 只换肤）。
- 分隔线 `---`／`***` 渲染成 `<hr class="dsh-upd-md-hr">`（不再以字面三个短横混在正文里）；setext 下划线标题（`标题` + `===`／`---`）先转 ATX 再走同一套判据，转换**保持行号不变**（`validateChangelog` 的诊断仍指向原文件行号）。
- 保真口径写成了可执行断言：`tests/changelog-fidelity-116.test.mjs`（22 例）——① 无未声明丢失：源文件里每条内容行的签名都要出现在渲染结果里，允许缺失的只有已声明的截断与 `E_BULLET_ORPHAN`；② 幻影版本 = 0：渲染出的每个版本节都能在源文件里找到版本号 token；③ 负例语料 `# Changelog`／`# 更新日志`／`# <插件名>` 不得成为版本节。认不出的块（HTML 注释、`<details>`、表格行）落进 `<div class="dsh-upd-md-para">` 按原文显示。
- **面板侧的日志通道（`#122`）**：面板跑在浏览器闭包里，落盘在宿主，中间隔着新电话 `….logAppend`。客户端侧 `createClientLogChannel`（`dsh-plugin-update/log` 导出，零 `node:` 依赖）做三件事：有界环形缓冲（缺省 200 行，满了挤掉最老的并计数）、按批投递（缺省 50 行 / 1 秒，页面切后台立即冲刷，失败退避重试 2 次后丢弃并计数）、**永不外抛**（没通道、电话没接上、回包形状不对都只计数）。宿主侧那一头是协议面：只收五个客户端事件（`update.panel.mount` / `update.panel.action` / `update.panel.render.fail` / `update.panel.state` / `update.lang.applied`），级别、字段、条数（一次 200 行）、新鲜度（10 分钟内）逐个把关，回 `{ accepted, dropped }` 且不给日志自己制造 `host.call` 行。
- 面板自动接上这条通道：`mountUpdatePanel` 默认按前缀自建（电话名 `<prefix>.logAppend`），`clientLog: { channel }` 注入自己的、`{ mount }` 改挂载点名字、`null` 明确关掉；入口件与 HTTP 直挂已传好挂载点。面板记五行：挂载、每个用户动作（复制诊断时带字节数与是否截断）、渲染兜底失败、状态变化、语言判定来源；状态与语言按指纹去重，轮询不会把它灌满。
- `event-list.update.json` 增五行客户端事件（`#122`），字段白名单与 `guard` 说明随表发布；`tests/client-log.test.mjs`（17 例）与 `tests/panel-log.test.mjs`（6 例）把缓冲、退避、丢弃计数、协议面收放与面板五行全钉住。
- **宿主侧环节全部接线（`#124`）**：19 环节里 Node／中立那批（③④⑤⑥⑦⑧⑨⑪⑫⑬⑭⑱，②另收一个宿主侧可选入参）逐个落到唯一发射口，逐环节的**权威落点（函数级）**与接线状态写进事件目录新增 §3.1。中立文件（`src/service.ts`、`src/changelog.ts`、`src/queue.ts`、`src/batch-run.ts`）不 import `node:`、也不认识插件标识——发射口一律由宿主侧**绑好标识**后注入（`src/host.ts` 的 `logPortFor()`）；队列与全局锁按**当次动作方**取口，行落动作方自己的目录，不会因为「谁先接线」而串台。
- 逐事件的负向断言：`tests/host-log.test.mjs`、`tests/store-log.test.mjs`、`tests/batch-log.test.mjs`。缝探针在**真** `homeDir`／真锁／真队列上（只假网络与子进程）跑一次完整安装，验到 `update.queue.transition` 三相位齐（`queued{position:1}` → `running{waitedMs:8}` → `done`），`update.install.request`、`update.install.verify`、`update.check.done`、`update.channel.decide`、`update.status.changed` 各就其位。
- **面板错误章路牌给出日志目录与现成命令（`#123`）**：原来那行只说「按插件标识筛选 `host.call` / `host.call.fail` / `update.install.exec`」，用户还得自己去 README 推目录名。现在路牌多给一份目录与命令：宿主/入口把新导出 `updateLogDirFor(pluginId, homeDir)`（`<homeDir>/logs/<派生命名空间>`，与落盘同一算式、同一派生规则）的结果传给面板挂载项的 `logDir`（`mountUpdatePanel` / `mountUpdatePanelHttp` / 入口件同名选项）时写**具体路径** + `npx dsh-log tail <该路径>`；没传则退回 `<DSH_HOME>/logs/<派生命名空间>` 的算式与命令模板——路牌宁可说「目录长这样、命令长这样」，也不指一个不存在的值。`showLogHint: false` 照旧把整条路牌（含新目录行）一起藏掉。**电话回包一字不动**：使用范围那栏仍然只回范围名与宿主种类，绝不回目录路径（日志行里目录也照旧只有 `logDirHash`），所以这处没动冻结面。

### Fixed
- 保真审计（`.tmp/audit-fidelity-v2.mjs`，本机 88 份 CHANGELOG；插件语料 = 8 份 DSH 插件**副本**）：**看不到的内容行从 26.7% 降到 1.5%**（覆盖率 73.3% → 98.5%），一份都显示不出的插件文件 0/8；**幻影版本 0**。残留 10 行 = 8 行文件前言（首个版本标题之前的体例说明）+ 2 条非版本节下的条目（`validateChangelog` 报 `E_BULLET_ORPHAN` 明说，不是静默丢）。
- 档案卷皮肤在整条是代码块/引用块时不再补一个孤零零的「Added ·」（`data-cat-block="1"`）。
- 顶格块与上一条之间隔了空行就另起一条：此前围栏代码块后面的顶格引用会被粘进同一条（空行在 Markdown 里就是段落边界）。
- 客户端日志行不再有「渠道没就绪就静默丢」的第三种状态（`#122`）：丢弃只有两个出口——缓冲挤掉或投递失败，都计入 `dropped()`；宿主回包里的 `dropped` 也照加，第三方看到的数字就是真丢了多少行。

门禁（**发版定格**）：`npm test` **1125 例：1124 过 / 0 失败 / 1 跳过**；`npm run build`（含 `tsc --noEmit`）与 `npm run typecheck` 过；`npm run gate:bilingual` **三道硬门禁过**（文案源 grep 扫描 33 个源文件 0 违规 / 字典快照 320 个 key 0 违规 / 15 码与诊断解析契约）；`npm publish --dry-run` **73 文件**（276.6 kB 压缩 / 980.3 kB 解包）。噪声预算装置复跑 **8/8 过**（`node .tmp/log-verify/run.mjs budget`：内核边沿 86400 次 → 1 行；600 次真轮询 → **0 行**，治理前同口径是 600 行；稳态 24h 外推 0 行；安装/批量当天事件面 37 行 ≤ 500）。
（`gate:bilingual:release` 的**第四道「零 draft 放行」仍如实红，非阻断**：320 个 key 全部还是 `draft: true`——转正走的是「母语 + 域内双签」的独立流程（#53 立约、#57 规格），不是发版票能代签的。口径与 0.9.0–0.13.0 各版一致：那几版的门禁行同样记「`--release` 仍如实红，非阻断」。`docs/maintainers.md` 里「现在 7 个 entry key 仍是 draft」是旧数字，已按实测改成 320。）

## [0.15.0] - 2026-10-14

> 未单独发到 npm：这一节的内容随 `0.16.0` 首发。

### Changed
- **破坏性**：条目正文保留行边界（`#116` 返工的一半）——`ChangelogEntry.sections` 的**单个条目现在可能是多行字符串**（嵌套子条目、围栏代码块、引用块按行留在一起），旧版是「一切压成一行」。集成方若对条目做过 `\n` 假设或按整串做字符串比较，需要跟着改；只做展示的集成方（`renderChangelogHTML`）零改动。迁移说明见 README §5.8。
- **计数口径变化**：嵌套子条目不再各占一条，`sections` 数组长度与 `counts` 只按**父条目**算（同输入下 `Added: 6` 会变成 `Added: 3`）。理由：块级渲染要靠父子关系，子项各占一条时层次不可恢复。
- 缩进（≥2 空格或 1 个 tab）的围栏代码块与引用块现在归属所在条目：`` ```lang `` → `<pre class="dsh-upd-md-pre"><code>`，`>` → `<blockquote class="dsh-upd-md-quote">`；**顶格**围栏与顶格引用照旧不进条目（保持既有「顶格内容不当条目正文」的对抗口径）。
- 单条截断（500 字）改为**按行累加**：装不下的那一行不再硬塞碎屑，只给已收正文补 `…`，截断点之后的行整行丢弃。
- **事件清单与检查器迁到 `dsh-log` 0.3.1 形状**（`#120`）：清单不再要求自报计数（旧清单带着 `counts` 照收，只是不参与判断），条数由 `computeEventCounts` 现算；字段检查分两档（未知字段黄、未知事件红）；落盘行加 `v === 3` 断言。集成方已有的清单不用改。
- **运行期依赖从零变成一个**（`#121`，`ADR-0005`）：`dependencies` 加 `dsh-log@^0.3.1`。集成方零改动（传了 `logCtx` 照旧优先，本包绝不另建实例）；没传 `logCtx` 的插件从此有日志可交，拿不到 dsh-log 时降级成「没有落点」，主流程零影响。门禁的「零依赖」断言随之改成「唯一依赖是 dsh-log，且只有 `src/log/**` 能动态取它」，并改成递归扫 `src/` 全树。

### Added
- 块级渲染 `renderChangelogBlocks(lines)`（导出，纯函数、永不抛错）：条目第二行起按行分派成嵌套 `<ul>`／`<ol class="dsh-upd-md-list-ol">`、`<pre><code>`、`<blockquote>`、`<div class="dsh-upd-md-para">`；认不出的行当正文显示，不丢字。
- 双主题块级样式：默认主题加 `.dsh-upd-md-pre/.dsh-upd-md-precode/.dsh-upd-md-quote/.dsh-upd-md-list(+ -ol)/.dsh-upd-md-para`，档案卷同名规则加 `[data-theme="archive"]` 作用域只换肤（纸色代码底、左侧细线引用、朱红列表符号）；默认串仍不含 `data-theme` 字样（既有断言不变）。
- 子条目位置上的有序列表 `1. …` → `<ol>`（顶格编号行仍按段落忽略，免得正文里的编号行变成条目）。
- 随包事件清单 `event-list.update.json`（`#120`）：本包事件的全表，含字段白名单、级别、散列代号与守卫说明，是事件与字段的唯一事实源。**首发时是 28 个事件（常驻 20、按需 7、自监控 1）；`0.16.3` 契约回填后是 26 个（常驻 18、按需 7、自监控 1）**——删掉的两条见 `0.16.3` 节。
- `mergeUpdateEvents(myManifest, updateEvents)`（`#120`）：把本包事件表并进集成方的清单——本包有、对方没有的补进去，两边都有的字段取并集、级别与归类仍按对方声明，不一致的记进 `conflicts`。
- `lintEventList(manifest)`（`#120`）：整份清单过尺子，红＝结构或引用错（事件名不合契约、`codes`/`rules` 引用名不合法、自报计数对不上），黄＝可疑不拦（字段表为空、字段里出现自由文本键——`ADR-0006` 管这条）。
- `parseLogRow(row)` 与 `LOG_ROW_VERSION`（`#120`）：落盘行断言，五键 `v`/`ts`/`level`/`event`/`fields`，`v` 必须是 3，多键少键都报中文错。
- 日志内核 `dsh-plugin-update/log`（`#121`）：派生命名空间 `deriveLogNamespace`（合法标识原样通过；有损映射补 `-<sha256 原文前 6 位>`，空标识回退 `plugin-<hash6>`；无损分支下不同标识不共目录，有损分支为 24 位指纹的概率性隔离——原文写「不同标识永不共目录」，复核更正）、同进程登记表 `acquireOwnLog` / `releaseOwnLog`（`globalThis` 上按目录引用计数，同一目录只有一个 dsh-log 实例；撞租约退避重试后降级、绝不外抛、降级带冷却）、按插件标识的 O(1) 路由表 `createLogRouter`（取不到落点即丢弃计数，绝不回退到别人的 sink）、唯一发射口 `emitUpdateLog`（脱敏 + 字段白名单 + 准入短路 + 边沿预算守卫；落点抛错只计数不外抛）。宿主侧原来那个模块级共享落点（最后接线的插件收走所有行）就此消失，同进程多插件不再串台。
- 事件表的运行时读取 `loadUpdateEventTable` / `buildUpdateManifest(pluginId, 集成方清单)`（`#121`）：读随包 `event-list.update.json` 并换标识；集成方给了自己的清单就并进去（冲突如实回报）。读不到清单只少一层字段守卫，绝不静默不写日志。
- `tests/log-kernel.test.mjs`（`#121`）：26 例——派生映射表与两条不变量、路由 A/B 隔离、登记表引用计数与降级三态、发射口四条纪律，外加一条真引擎端到端（真装 dsh-log 0.3.1 → 真落一份文件 → 读回五键行）。

### Fixed
- 真实管线里缩进围栏内容此前**整段被丢弃**（`inFence` 直接 `continue`），现在收进所属条目的 `<pre><code>`；缩进引用块此前被并成上一行正文（`> ` 变普通字符），现在是 `<blockquote>`。
- 续行不再被 `replace(/\s+/g,' ')` 拍平（那是块级渲染分不出层次的主因）。
- 档案卷皮肤的类名前缀不再钻进新加的嵌套子列表：选择器从 `… ul li::before` 收紧为 `… > ul > li:not([data-cat-lead])::before`，子项不会再多出「Added ·」、有序子项不再显示成「1. Added · 先跑门禁」。
- 条目正文已经以类名开头时不再补前缀（`**Added** · …` / `Added: …` / `新增 · …` 会被 `renderChangelogItem` 标上 `data-cat-lead="1"`，档案卷皮肤据此跳过），消除面板上的「Added · Added · …」重复；`Addendum`／`新增功能` 这类不算类名开头，前缀照旧。

### Deprecated
- 门禁检查器的两个旧名 `checkEventFields`、`checkEventCounts`（`#120`）：保留一版、行为不变（`checkEventCounts` 在清单没写 `counts` 时直接算过），新代码用日志包 0.3.1 的名字 `lintEventFields` 与 `computeEventCounts`；下个大版本删旧名。

门禁：`npm test` 1016 例（1015 过 / 0 失败 / 1 跳过既有）；`npm run build`（含 `tsc --noEmit`）与 `npm run gate:bilingual` 均过。

## [0.14.0] - 2026-10-14

> 未单独发到 npm：这一节的内容随 `0.16.0` 首发。

### Added
- 更新日志行内 Markdown 渲染（#109 地图 / #115 落地）：条目正文不再原样显示语法符号——`` `行内代码` ``、`**粗体**`、`*斜体*`、`~~删除线~~`、`[文本](https://…)`、`<https://…>` 与裸 URL 都渲染成样式；图片 `![alt](url)` 只出占位（`data-src` + alt／地址），**永不产出 `<img>`、不发任何网络请求**。支持面按野外取样定（`docs/research/20261014-changelog-markdown-constructs.md`：行内代码 4914 处/81 份、粗体 4742/26、绝对链接 6286、裸 URL 6671、图片 8；表格/脚注/emoji 短码/`<details>` 野外 0 例，不做）。
- 导出行内渲染纯函数 `renderChangelogInline(text)` 与支持面常量 `CHANGELOG_MD_INLINE`（零依赖、纯函数、永不抛错）。
- 面板链接落地 `openLink?: (url: string) => void | Promise<void>`（#111 定稿）：不传即 `window.open(url, "_blank", "noopener,noreferrer")`——桌面宿主交系统浏览器、web 宿主开新标签页，面板正文永不被导航走；传了即交给集成方，抛错只吞。

### Changed
- 双主题同一份 DOM 只换 CSS：`UPDATE_PANEL_CSS` 加最小可用样式（代码底色、朱红链接、虚线图片占位），档案卷 `UPDATE_PANEL_ARCHIVE_CSS` 只换肤（纸色底、细底线链接）；两套都走现有 token，第三方 `themeTokens` 覆盖即生效。
- `renderChangelogItem` 改走行内渲染；公开解析形状零变化（`ChangelogEntry.sections` 仍是原文数组、截断仍在解析期按字符切、计数不变），集成方读 `parseChangelog` 的结果一字不改；截断悬空标记（截在 `` ` `` 或 `**` 中间）渲染期兜底剥掉，配平的照渲染。
- 预览件 `docs/research/20261014-changelog-md-preview.html`（#114）：真实日志 + 边界样本的双主题并排预览，由本包渲染器直接产出。

### Security
- HTML 永不直通：一切文本先转义再拼标签（野外真反例 `dsh-im<channel>` 当文本显示）；链接与图片只认 http/https，`javascript:`／`data:`／`file:`／相对路径一律按字面文本；未闭合标记按字面输出，输出永远标签配平。

门禁：`npm test` 1006 例（1005 过 / 0 失败 / 1 跳过既有）。

## [0.13.0] - 2026-10-11

### Added
- 面板字号参数化（#103）：`themeTokens` 新增 5 语义键——`panelFontSize`（正文基准，默认 `14px`）、`panelChapterFontSize`（章节标题，默认 `14px`／档案卷 `17px`，批量标题 `15px`／档案卷 `21px` 同键）、`panelBannerTitleFontSize`（横幅标题，默认继承正文／档案卷 `27px`、已最新 `24px`）、`panelLogFontSize`（日志，默认 `13px` 系）、`panelSmallFontSize`（小字副行/注脚，默认 `11px`–`12.5px` 按规则回退）；沿 `语义键 → --dsh-update-panel-* → 根内联，非法即抛` 同口径，CSS 全量走 `var(...,旧值)` 回退，不传零回归；被覆盖 token 即固定值（深色媒体不跟随，README 已注明）。
- 面板字号 README 键表（#103）：`themeTokens` 文档新增「面板字号」一行与固定值补注。

### Changed
- 尺寸用例同步回退断言（#103）：`panel-prototype-skeleton` 状态行 `27px`／已最新 `24px` 改断变量回退（原型值仍在回退里），行为零变更。

门禁：`npm test` 978 例（977 过 / 0 失败 / 1 跳过既有）+ `gate:bilingual` 四道硬门禁过（318 draft 未动；`--release` 仍如实红，非阻断）。

## [0.12.0] - 2026-10-11

### Added
- 中文分类（#102）：`### 新增/修复/变更/弃用预告/移除/安全` 与英文等价（精确匹配，子串不算），E 提示与 README 作者契约同步。
- 档案卷日志原型 UI（#102）：版本 mono 粗体加日期灰小字（日期独立 span，默认主题零变化），分类头隐藏改条目前缀红字。
- 横幅副行出框（#102）：行动句移出色框为独立兄弟节点，框下第二行居左。
- 宿主样式隔离（#102）：章节标题钉死颜色并清洗渐变三件套，防宿主全局样式染色。

### Changed
- 按钮照原型收紧（#102）：archive 下紧凑口径，复制类小按钮；放弃忙闲同宽预留，默认主题不动。
- 有文零解析改走"读不出来"（#102）：空文本仍"未提供"，区间外旧行为不动；不新增文案键。

门禁：`npm test` 956 例（955 过 / 1 跳过既有 / 0 失败）+ `gate:bilingual` 四道硬门禁过（318 draft 未动；`--release` 仍如实红，非阻断）。字号参数化另立 #103，本版不动代码只立票。

## [0.11.0] - 2026-10-10

### Added
- 通道错码独立化（#98）：新增 `channel-mismatch` 阻塞原因与中英双语文案，门禁 14→15 码；缺省 stable 下预发布已装版落到通道码，使用范围栏显示真实名，手工命令仅在安全可选项存在时给出。
- 档案卷横幅小印章行内化（#99）：印章由伪元素改真节点行内章（同行居左），框随文长（min-width＋自动伸展＋不换行），待重启档无章，`data-mini` 属性保留。

### Changed
- 手工命令无安全可选项回空（#98）：不再回退旧 picks[0]、不猜 latest；会降级、无候选、比不出时回空态。

### Fixed
- 预发布已装版误报 `unknown-profile`（#98）：运行推导去通道门，完好性判定去通道门，`registrySpec` 认精确预发布与预发布范围；`unknown-profile` 只留真定位不到与版本非法。

门禁：`npm test` 908 例（907 过 / 1 跳过既有 derive-client / 0 失败）+ `gate:bilingual` 四道硬门禁过（316 draft 未动；`--release` 仍如实红，非阻断）。

## [0.10.0] - 2026-10-09

### Added
- 待重启诚实化基线（#95 T0）：字典 4 键收敛为“请重启DSH”，基线与快照同步，bilingual-gate 同步放行。
- 续跑按钮后果悬停（#85 收尾）：新增 `batch.action.resume-title`“从上次没做完的地方接着安装，已完成的不重装”，grilling Q1-Q4 全认可。
- 弹窗高度量盒子探针（#93 附带）：`scripts/panel-layout-probe.mjs` 用系统 Chrome headless 量盒子（非滚动区不被压、副行不折列、矮窗整面板可滚），可选仪器、非发布门禁。

### Changed
- 待重启去 primary 保委托（#96 T1 单面板 + #97 T2 批量）：`restart-hint` 与批量横幅 `restart` 按钮摘 `data-primary`，不换文案不加键；批量顶部行对齐收敛；注释与单测同步。

### Fixed
- 弹窗高度让渡契约（#93）：带滚动区弹窗帧里只有滚动区让高度，其余各区 `flex:none`；档案卷横幅去 `flex-wrap` 布局语义；窗口矮到连框架都放不下时整面板自己滚，章节区留 8em 下限。
- 续跑 stalled 判据只认盘上会话（#85）：无会话一律按没有未终态处理，行相位不作判据；新增 `unfinishedCount` 与 `hasUnfinishedRows` 同口径，`rows` 参数仅兼容保留。

门禁：`npm test` 888 例（887 过 / 1 跳过既有 derive-client / 0 失败）+ `gate:bilingual` 四道硬门禁过（313 draft 未动；`--release` 仍如实红，非阻断）。

## [0.9.0] - 2026-10-08

### Added
- 批量详情独立动作矩阵（#84）：详情弹窗按单插件内核只读 + 批量自出动作行，支持单查 / 重试 / 复制诊断 / 复制手工 / 跳过，行单查透 `phoneNames`、诊断进 `diag/env/queue`；死按钮摘净、不嵌套滚动；文案零新增。
- 批量两段式决策 ADR-0004 proposed（#86）：先全查再串行装（生产者 `checkAll` + 消费者复用 `driveLocked/runBatch`）、查并发取 3、消费前重查（不做常驻 reader）、公平性有界与回退线；本版只落决策不改驱动。
- 主题新增 `newOkText`（#71 修订 Q1）：done 行新版走绿 `newOkText`，其余带箭头行走红 `newText`，相等无箭头；README 键表同步，深浅 / 档案 / forced-colors 回退。

### Changed
- 总账吃知识（#73 口径 = #82 推荐 A）+ 世界账与轮次账分家（#90）：无轮次 pending 行按知识四态（有新版进可更新 / 已是最新进已最新 / 无知识与查失败仍待查），有轮次与 checking 行恒走执行态；终态 current / 无重启 done 行被更新鲜知识推翻为可更新（`lastCheckedAt > 会话行 updatedAt` 且快照比对确有新版），陈旧知识与失败检查永不推翻；入口徽标 `batchEntrySummary` 同口径（含 openOn='has-update' 在轮不开面板）。
- 检查诚实语义（#90 R2/R5 + #73）：宿主 `defaultCheck` 回包成功却无版本永不判 current，改判 `check-failed`；知识“查过但无版本”判 never（回“还没查过”），不再坍缩为“已是最新”；知识查失败归待查，不冒充安装失败（顶部不再喊“N 家安装失败”）。
- 驱动进行中检查回忙（#90 R4）+ 装类在途轮询放行：`checkPhone` 在 `driveActive` 时回 `update-busy`，不用旧表冒充 fresh 结果；批量驱动收尾前可观测中间进度。
- 判定收敛（#73 code-review）：新增 `sessionEntriesOf/entryPhaseOf/isUnfinishedEntry` 与 `knowledgeVerdictOf` 唯一判定，总账与行共用“在轮 / 知识”两处判定，注释正错（首个匹配即返、任一条目非终态即在轮）。

### Fixed
- 明细行版本与对齐一致性（#83）：知识孤版红 + 入口吃知识，会话目标赢知识；三列网格（名 5em / 版 18ch / 态 1fr）与 #71 无回归。
- 单面板宏忙守卫与批量一致（#87）：installing / verifying 快照与 busyAct 在途时查 / 装两键同灰，只加 disabled，不换文案不加键。
- 详情 row-skip 非法版本与单面板同口径（#88）：不记不 toast 静默重绘；entry locale 注释正错。
- 重启后待重启自动回查清零（#91）：任务完成态换算落盘（restart-required→completed）， done + 待重启在快照已生效时清零、真未生效时保留；只读失败不展示陈旧待重启。
- 单面板安装门控稳定（#87 附带）：settled 等自动查回包；抖动预留与闪空行留存沿用既有载体（68 预留 + 焦点滚动 + 轮询让路，74 prefs-only）。

门禁：`npm test` 869 例（868 过 / 1 跳过既有 derive-client / 0 失败）+ `gate:bilingual` 四道硬门禁过（文案零新增，312 draft 未动；`--release` 仍如实红，非阻断）。

## [0.8.0] - 2026-10-07

### Added
- 入口件无新版摆法 `upToDateDisplay`（`note` / `button`（默认） / `tooltip`）：默认按钮本身即`已是最新 X.Y.Z`（单按钮不占宽，可点再查，hover 回`检查更新`暗示动作；无新版走中性弱边、hover 才走主色，复用既有 token，不新增文案与 token）；`tooltip` 按钮仍是`检查更新`、版本收进悬停；`note` 回右侧小字旧样子（显式传回）。入口 `label()` 与按钮正文同口径，`badge` 形态不受影响；README 2.5 节补自由度与参数说明，单测覆盖三摆法与非法校验。

### Fixed
- 查新版瞬时抖动补强（面板）：忙闲两帧同高（动作区按钮 nowrap + 最小宽预留、转圈槽常驻）+ 横幅／复制区最小高占位，查新版与轮询回包帧不再跳动。
- 入口件深色默认主题补 `text-muted`（`#9ca3af`），按钮直显弱边在深底可读。
- 批量 prefs-only 存偏好回归测试补齐（#74）：偏好保存不闪空行、失败保留行（测试覆盖，行为零变更）。

## [0.7.1] - 2026-10-06

### Fixed
- 批量行三列对齐 + pending 显示最新版 + 新版红（#71）：行主区改网格（名 5em／版 18ch／态 1fr，版 nowrap + tabular-nums，态换行同列起，失败跨整行）；版本三段式只红新版（老版本弱化／箭头中性／专用红 token `newText`，深浅主题与档案皮肤及 forced-colors 回退，加粗 + 箭头 + 状态词为非颜色信号）；版本会话优先、知识仅展示，无轮次无知识回还没查过（不再误 wait-turn），轮次中仍执行态；会话／安装语义未动。
- 默认弹窗 01~05 横滑消除 + 疏朗化（#72，A 方案落地）。

### Added
- 主题变量新增 `newText`（`--dsh-update-new-text`，有新版版本号专用红，可覆盖，非法即抛）。

## [0.7.0] - 2026-10-06

### Added
- 主题变量覆盖 `themeTokens`（第三方换肤一等口径）：单面板、批量面板、入口件、批量入口件四个挂载口同收同语义（35 个语义键对 `--dsh-update-*` 变量，颜色收 hex 或英文名，其余走注入检查，非法挂载即抛）；内联写根、变量继承，入口件打开的 dialog 同步透传，批量展开的详情行经继承生效；控制器同步新增 `setThemeTokens`（传 `undefined` 即清掉覆盖）；被覆盖的 token 不再跟随深色媒体查询。README 补换肤章节与键表。
## [0.6.0] - 2026-10-06

### Changed
- 主题 token 全系更名（breaking）：`--d5-*` 18 个全系删除，`--dsh-upd-*` 展开为 `--dsh-update-*`；补全状态字色／次级字／强边线／深主色／字体／阴影／圆角 token，两主题共用同一张词典，主题只换值；卷宗横幅边框改吃 `*-border`（值与旧字色相等，零视觉差）；默认主题按钮边框吃 `border-strong`、卡片与按钮圆角及字体栈走变量（值与旧硬编码相等）。

### Removed
- 主题取值 `'d5-paper'` 删除，仅剩 `'default' | 'archive'`（非法即抛）；常量 `UPDATE_PANEL_D5_CSS / UPDATE_BATCH_PANEL_D5_CSS` 更名为 `UPDATE_PANEL_ARCHIVE_CSS / UPDATE_BATCH_PANEL_ARCHIVE_CSS`；手写旧变量覆盖须迁移到新词典；`demo/d5-progress.*` 更名为 `demo/archive-progress.*`，`tests/panel-d5-theme.test.mjs` 更名为 `tests/panel-archive-theme.test.mjs`。

## [0.5.8] - 2026-10-06

### Added
- 语言底座 v2 按宿主语言单语渲染，入口两条链先生效（#60，地图 #51）：新增 `src/lang.ts` 信号层（显式 `locale` > `document.documentElement.lang` > `navigator.languages` > 中文兜底，非中文落英文；单例 `MutationObserver` + 服务订阅，切换即时重绘，`unmount` 停订，无 DOM 落中文）；`bilingual.ts` 新增 `copyHTML/copyText(key, lang, values)` 单语纯函数出口（一次一种语言，单 `span[lang]`），旧 `bilingualHTML/Text` 转为按当前语言包装，字典新增 `batch-entry.*` 6 键（13 键全 `draft`）；`entry/entry-batch` 新增 `locale` 选项全走字典单语块（含聚合口径与 `已是最新` 小字）；`panel/panel-batch` 仅加 `locale` 占位暂不消费（#61-#66 按面迁移）；双语门禁改断言单语（缺语言/混语言即红，冻结词元除外）；`build.mjs` 加 `lang.ts` 单元；README 补单语与窗口期说明。

## [0.5.7] - 2026-10-06

### Fixed
- 拆入口通道安装禁令（#58 真因）：入口件 HTTP 直挂不再源码级禁 updateInstall（入口件核心本就没有安装代码路径，禁令只连坐入口件打开的面板；真正门禁在宿主侧核心）；入口打开面板后安装电话端到端验证通过。

## [0.5.6] - 2026-10-06

### Added
- 弹窗分栏滚动、更新日志折叠与动效体系；双语防倒退门禁四道检查（文案源／快照／契约／零 draft）与自测（#56）。

### Fixed
- 用户路径抛错锁存非瞬态化（#58）：查／装动作的传输抛错改为非瞬态锁存（安装抛错码为 install-failed，不再冒充查失败），轮询不再洗掉；抛错原文脱敏后进复制摘要；安装内补查失败精确归因到查阶段；轮询抛错仍瞬态自愈。

## [0.5.5] - 2026-10-06

### Added
- 档案卷主题收敛 archive 与面板紧凑化：运行时 data-theme 统一为 archive，entry/entry-batch/panel-batch 输出与 CSS 选择器同步，panel-batch setTheme 补 archive 并归一存储；根／卷头／横幅／版本条／章节／章头／队列行／footer 间距收紧；删 changelog-wrap 与章节线重影内边框；页脚去技术词，批量关闭 title 同步。
- 双语底座 #54（先行）：bilingual 字典模块、entry key 映射链、noteVersion 运行时值；research/52-inventory 双语盘点与原型矩阵随附。

### Fixed
- 安装/查失败常驻与复制诊断锁定（#58）：失败横幅保留到下一次用户主动查/装的新结论、任务态或版本变化，只读轮询不再洗回可装页；「复制诊断」锁定致命那次回包（稳定码、摘要、版本、宿主、请求与检查编号冻结在失败时刻）；失败旁新增「知道了」可显式确认回到可装页；健康无失败时复制改为当前状态快照，不再伪造失败码；04 章失败时变为卷宗（真实稳定码、本次查询键与失败时刻、证据冻结声明、凭编号对日志的现成查询，平时为路牌＋中性行，可用 `showLogHint: false` 藏路牌）；日志事件名收归 `log-events.ts` 单源（宿主发射与面板路牌同源）；对抗审查补强：瞬态读失败不跨重挂、查锁存不再错配旧安装编号、瞬态失败换诚实文案、跨挂载表有界 100 家；`update-busy` 仍为瞬态不锁存；四电话形状与快照六字段零变更。

## [0.5.4] - 2026-10-06

### Added
- 批量感知入口件（#49）：新子路径 `dsh-plugin-update/entry-batch`，一颗按钮看 N 家聚合（button/badge/inline；openOn 缺省 always，autoCheck 缺省 mount；只调 batchStatus/batchCheck，绝不自动装；聚合与批量总账同一份数法，忙失败占位翻回可更新）。
- 批量 dialog 关闭落地与单面板同口径（#50）：`BatchPanelOptions` 新增可选 `onCloseRequested`，点关闭/Esc 先交调用方撤 DOM 再停轮询；入口件打开的 dialog 已内置；不传回退只停轮询；HTTP 直挂透传。

## [0.5.3] - 2026-10-06

### Added
- 进入面板自动查一次新版（#46 结论固化 #48）：首绘 loading 后先只读本地刷新，拿到活体快照后条件自动查一次；轮询心跳永远只读本地、不触发查新版；抑制谓词 `pendingAutoCheck` 为纯函数，仅快照任务态 installing/verifying 或已有查/装在途时不发起，同范围忙/凭证过期/各类阻拦一律不抑制，无活体快照不发起；复用手动查同一通路与“正在查新版…”提示；并发只信服务端真相源（面板 busyAct 互斥 + checking 在途复用 + 2s 复用窗口），卸载靠 mounted 丢弃；失败无退避，只渲染既有失败文案与复制诊断，手动查清日志退避、关闭重开立即重问；embedded/dialog 一致；pollMs 不影响时机；四电话形状与快照六字段零变更。
- 关闭按钮住右下角独立 footer 区（#47 定案 A）：第一章 actions 不再画 close-view，内核末尾 05 章之后新增 `.dsh-upd-footer`（dialog + 非只读渲染才有），按钮原 title/data-action 原样搬入；embedded 无面板自带关闭（宿主框架自带关）；默认 + 档案卷只换肤、DOM 同序；act/Esc/onCloseRequested 语义一字未动。

### Changed
- 入口件 direct 断言收紧：区分入口自身空参预查与面板挂载带 includeQueue 自查（面板挂载即自查归面板）。
- 面板安装复用断言更新：mount 自动查已拿凭证时安装直接复用，不另查（无 receipt 回退见 panel-auto-check 用例）。
- 测试：新增 tests/panel-auto-check.test.mjs 11 项（纯函数、正常/抑制/阻拦仍查、慢网单发、卸载丢弃、手动重问、轮询不查、失败无退避、安装复用凭证），tests/panel-close-footer-47.test.mjs 5 项随前一提交；全量 637 计、636 过、0 败、1 跳（既有 derive-client 跳过）。

## [0.5.2] - 2026-10-06

### Added
- Security 必显：`### Security` 与 `Added/Fixed/Changed` 同级展开（页面查找可命中）；单类超 200 条时前 200 条展开、其余收进该类内部折叠并标计数（64K/单条 500 字墙保留）。
- 诚实截断计数：超限类标题下加小字“共 M 条，仅显示前 N 条”（M 该版该类原始条数、N 实际渲染数，多版本各自标；未超限不打扰）。
- 撤回警告：目标版本标题含 `[YANKED]` 时第 02 章区间标题下方加警告横幅（`role=alert`）：“目标版本 X.Y.Z 已被作者撤回（yanked），安装不受影响，继续前请确认。”；中间版本只保留标题后缀，不挡安装、不碰快照门控。
- 破坏标记：条目开头 `BREAKING:`/`不兼容:`（大小写不敏感，中英文冒号皆可，匹配前剥行首加粗/引用装饰）行首挂徽标（`role=img`）+ 前缀加粗，正文一字不动；正文中间散文永不误标。
- `validateChangelog(markdown)` 纯函数（零导入、永不抛错，与 parse 共享扫描仪）：回 `{ ok, diagnostics: { line, code, hint }[] }`（line 原文件 1-based 行号，按行号排序）；码表 `E_VERSION_TITLE`/`E_CATEGORY`/`E_BULLET_ORPHAN`（Error，会丢内容）与 `W_BREAKING_MAYBE`/`W_YANKED`/`W_TRUNCATED`/`W_TRUNCATED_FILE`/`W_EMPTY`（Warning）；仅 CI/发布前用，运行时永不调用。
- 记住语义澄清：成功与取不到（null）按版本永久记（面板内存会话级 + 宿主进程级，不落盘；显式文本永不覆盖）；传输失败不进缓存，手动查/换版/重开立即重试，轮询按退避问（`shouldFetchChangelog` 纯策略三处共用）；`autoChangelog: false` 关闭整链。
- 文档：README §2.7/§5.8 同步必显/计数/横幅/标记/校验/记住的用户做法（只加 MUST/SHOULD，不放设计 rationale，详见 ADR-0002）。

## [0.5.1] - 2026-10-06

### Added
- 入口件 `openOn: 'direct'`：点开即弹窗、不预查（面板挂载即自查；徽标形态仍走回调口径）。

### Fixed
- 入口件小字对比度：原地提示与档案卷按钮脸自带底，深色宿主下也读得出。

## [0.5.0] - 2026-10-05

### Added
- 主题首选名 `archive`（档案卷纸面浅色）：`archive` 为唯一的档案卷取值；入口件与批量面板同一套取值。
- 弹窗关闭落地 `onCloseRequested`：dialog 下点「关闭」/按 Esc 先交调用方撤 DOM 再停轮询；入口件打开的 dialog 已内置（收 dialog + 还原按钮 + 重查一次）。

### Fixed
- 弹窗点「关闭」没反应：此前只停轮询不撤 DOM（入口件打开的 dialog 还会卡死），现走关闭落地。
- 悬停/聚焦闪烁：轮询每秒整树重写 innerHTML 打断 hover/focus，现输出逐字相同时不碰 DOM（状态变化仍即时重绘；单面板与批量面板同口径）。

## [0.4.0] - 2026-10-05

### Added
- 更新日志无脑接入（#38）：宿主新增 `updateChangelog` 电话（入参版本号，回该版 tarball 内全文，取不到回空；同源 + 精确路径 + `integrity` + 三墙复用，按版本记住结果）；面板 `autoChangelog` 默认自动展示（有新版调一次，显式文本仍赢，`false` 退回手动）；入口件透传跟上；批量详情行按行自动取（无新增批量电话，单行失败只影响该行）；HTTP 版白名单放行，老三电话形状不变。
- 按钮交互反馈：查新版/安装在途置忙（禁用 + 文案 + `aria-busy` + 纯 CSS 转圈，并发连点只认第一次）；默认主题补 hover / 按下下沉 / 过渡；busy 脉冲与 `prefers-reduced-motion` 关闭。
- 原生 `title` 说明：单面板全部动作按钮、批量宏按钮带悬停一句话（零成本 tooltip，不引入浮层组件）。
- Toast 语义：复制/重启类回执 5 秒后自动过期，不靠下次点击才消失。
- 首帧骨架：快照没到之前版本条画微光占位（`aria-hidden`，不进语义）。
- 批量「取消这一批」鼠标两步确认（第一次上膛红框，点别的自动卸膛；程序调 `act('cancel')` 仍一次即执行）。
- Esc 关弹窗：单面板 / 批量面板 dialog 与入口件 dialog 均支持（容器契约内，只用 innerHTML + 事件）。

## [0.3.1] - 2026-10-05

### Added
- 新增 `dsh-plugin-update/http`：`createHttpCall`（单三电话 + 批量五电话同一内核，`batchPrefix` 独立）+ `mountUpdatePanelHttp`/`mountUpdateEntryHttp`/`mountUpdateBatchPanelHttp`，只传 pluginId + prefix/batchPrefix + baseUrl/routes 即跑通检查/安装/待重启/失败与批量总账/明细/动作；queue/env/session/rows/progress/diag 全透传，传输失败走 `http-transport-failed` 异常通道，取消整批走 `batchCancel` 电话。

## [0.3.0] - 2026-10-04

### Added
- **多目标批量更新**（`dsh-plugin-update/batch` + `/panel-batch`）：一次接线管 N 个插件——五个批量电话（status/check/install/resume/cancel）＋ 总账/明细/动作三层面板；一家收尾才起下一家，失败一家继续下一家（可配停）。
- **耐久会话账本**：批量会话落盘 `update-queue/<使用范围短指纹>/batch.json`，断点续跑（进程重启/前端重载后 `batchResume` 接着走），幂等编号恒等（已完成不重装），`selfKey` 默认把自己排最后（自更新安全）。
- **排队语义**：忙时也能「加入队列」——`batchInstall` 在驱动进行中不再回 `update-busy`，改成并入会话 + 单飞推进；单插件回 `update-busy` 映射成 `queued`（相位退 `ready`，**不是失败**），排队行给「取消排队」（打该家自己的安装电话 `cancelQueued`）。
- **更新入口件**（`dsh-plugin-update/entry`）：`button`/`badge`/`inline` 三形态 ＋ 状态联动文案（检查更新/有新版 X.Y.Z/正在安装…/待重启/更新失败，点此查看）；`autoCheck` 与 `openOn` 两个策略。**铁律**：只做「查 + 打开面板」，任何路径都不自动安装。
- 只读渲染开关 `renderUpdatePanelHTML({ actions: 'none' })`：五章内容照画、动作按钮一个不画（给「调用方自己提供动作面」的场景）。
- 跨插件单队列串行：同范围 `queue.json` + `global.lock`，FIFO 取号、仅撤自己，`includeQueue/showOthers` 开关，默认只看自己。
- 跳过按插件+版本持久化：`skipped.json`（50 条封顶、坏文件自愈），同一横幅行「已跳过 X.Y.Z · 恢复」。
- 版本通道：`releaseChannel` 默认 `stable`，显式 `prerelease` 才收预发布，全通道精确版锁定。
- 现成整组件：`dsh-plugin-update/panel`（内嵌/弹窗一键切换，轮询/门控/中文一句话/待重启横幅/手工复制/排队开关/跳过/诊断复制全内置），完整类型定义随包分发，零运行依赖。
- 脱敏规则表：五条具名规则（绝对路径/URL 账号密码/令牌前缀/密码键值对/邮箱），顺序固定，两占位符 `<路径>`/`<脱敏>`，复制前收敛。
- 后台安装不中断：关面板不中断，重开读盘 1 秒内恢复，仅进程关判中断。
- 档案卷可选主题：`theme: 'archive'`（`mountUpdatePanel` + `setTheme`，默认不动），迷你印章 + profile 牌 + 待重启衬线横幅 + 手绘 SVG 标 + 窄屏印章固定 + 省略号逐字折叠 + 浅深双主题，DOM 冻结、复制诊断常在。

### Fixed
- **死按钮根治**：批量面板的详情曾把单插件内核 markup 原样搬入而不接管行为，里面 5 颗按钮可点却无反应。现在详情的内核走**只读渲染**（`actions:'none'`，连队列章的 `toggle-queue` 一起摘），动作行由批量面板自己提供（与行内同一 `act` 通道、同一忙守卫）。
- **后台失败行的诊断**：安装超时/后台收尾失败那种没有结构化 `diag` 的行，改用 `job.message` 正文并标注「来源：后台任务收尾记录」——拿真内容，不编造。
- **锁陈旧判据单源**：显式注入的抢锁口子现在也收到 `{ timeoutMs: installTimeoutMs }`，不再各自拍阈值（默认行为不变）。真卡死时队列按安装时限回收，不再白等 15 分钟。
- **账本事实优先**：账本记 `failed` 而实时快照显示该家已装到目标版时，相位纠成 `done`（`restartRequired` 按待重启判），`error` 留痕不抹——只在刷新路径、只纠 `failed`、版本精确匹配才动手。

### Changed
- 面板文案全称化：「安装这家」「安装 X.Y.Z」不再简写成「装这家」「装 X.Y.Z」（负向门禁锁死）。
- 批量面板详情里的动作**归属批量面板**：详情是只读视图，操作统一走行内与详情那排 `data-act` 按钮。
- 请求编号收紧为不透明串 `[A-Za-z0-9._~-]{1,128}` 且拒绝令牌前缀，`req-1`/`id-N`/UUID 不受影响（公开契约变更，用 UUID/不透明串，不要把秘密当编号传）。
- 失败详情 300 字落刀改空白边界（不断占位符），长度不变，切分位置可见变化。

## [0.2.0] - 2026-09-30

### Added
- 目标包按包名解析：普通依赖形态一键升级可用，显式 `targetPackageDir` 逃生口，定位不到诚实 `unknown-profile`。
- 三电话入参与回参补齐，ESM 说明与无出口时诚实失败。

### Fixed
- 按包名解析后普通形态恢复可用；vendor 在目标包内部仍定位自身。

## [0.1.2] - 2026-09-30

### Added
- 第三条安装路由 `desktop-manager`：官方桌面版进程内插件管理器，老两条路由行为不变。
- 桌面管理器探测/配方/执行器/端到端测试 15 条。

### Fixed
- 官方桌面版点「装上」不再只有一条不可诊断的 `install-failed`，按政策诚实失败并转手工命令。
