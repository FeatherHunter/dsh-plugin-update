# Changelog

格式为 Keep-a-Changelog 子集：`Added/Fixed/Changed` 必写，`Deprecated/Removed/Security` 有则透传，`Unreleased` 面板忽略，禁止 git-log 直倒。面板缺日志时中性提示，不挡安装。

## [Unreleased]

### Fixed
- 拆入口通道安装禁令（#58 真因）：入口件 HTTP 直挂不再源码级禁 updateInstall（入口件核心本就没有安装代码路径，禁令只连坐入口件打开的面板；真正门禁在宿主侧核心）；入口打开面板后安装电话端到端验证通过。

## [0.5.6] - 2026-10-06

### Added
- 弹窗分栏滚动、更新日志折叠与动效体系；双语防倒退门禁四道检查（文案源／快照／契约／零 draft）与自测（#56）。

### Fixed
- 用户路径抛错锁存非瞬态化（#58）：查／装动作的传输抛错改为非瞬态锁存（安装抛错码为 install-failed，不再冒充查失败），轮询不再洗掉；抛错原文脱敏后进复制摘要；安装内补查失败精确归因到查阶段；轮询抛错仍瞬态自愈。

## [0.5.5] - 2026-10-06

### Added
- 档案卷主题收敛 archive 与面板紧凑化：运行时 data-theme 统一为 archive（d5-paper 仅作输入旧别名归一），entry/entry-batch/panel-batch 输出与 CSS 选择器同步，panel-batch setTheme 补 archive 并归一存储；根／卷头／横幅／版本条／章节／章头／队列行／footer 间距收紧；删 changelog-wrap 与章节线重影内边框；页脚去技术词，批量关闭 title 同步。
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
- 关闭按钮住右下角独立 footer 区（#47 定案 A）：第一章 actions 不再画 close-view，内核末尾 05 章之后新增 `.dsh-upd-footer`（dialog + 非只读渲染才有），按钮原 title/data-action 原样搬入；embedded 无面板自带关闭（宿主框架自带关）；默认 + D5 只换肤、DOM 同序；act/Esc/onCloseRequested 语义一字未动。

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
- 主题首选名 `archive`（档案卷纸面浅色）：`d5-paper` 为旧别名仍可用，渲染逐字相同；入口件与批量面板同一套取值。
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
- D5 档案卷可选主题：`theme: 'd5-paper'`（`mountUpdatePanel` + `setTheme`，默认不动），迷你印章 + profile 牌 + 待重启衬线横幅 + 手绘 SVG 标 + 窄屏印章固定 + 省略号逐字折叠 + 浅深双主题，DOM 冻结、复制诊断常在。

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
