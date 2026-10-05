# Changelog

格式为 Keep-a-Changelog 子集：`Added/Fixed/Changed` 必写，`Deprecated/Removed/Security` 有则透传，`Unreleased` 面板忽略，禁止 git-log 直倒。面板缺日志时中性提示，不挡安装。

## [Unreleased]

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
