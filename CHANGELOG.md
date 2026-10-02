# Changelog

格式为 Keep-a-Changelog 子集：`Added/Fixed/Changed` 必写，`Deprecated/Removed/Security` 有则透传，`Unreleased` 面板忽略，禁止 git-log 直倒。面板缺日志时中性提示，不挡安装。

## [Unreleased]

### Added
- 跨插件单队列串行：同范围 `queue.json` + `global.lock`，FIFO 取号、仅撤自己，`includeQueue/showOthers` 开关，默认只看自己。
- 跳过按插件+版本持久化：`skipped.json`（50 条封顶、坏文件自愈），同一横幅行「已跳过 X.Y.Z · 恢复」。
- 版本通道：`releaseChannel` 默认 `stable`，显式 `prerelease` 才收预发布，全通道精确版锁定。
- 现成整组件：`dsh-plugin-update/panel`（内嵌/弹窗一键切换，轮询/门控/中文一句话/待重启横幅/手工复制/排队开关/跳过/诊断复制全内置），完整类型定义随包分发，零运行依赖。
- 脱敏规则表：五条具名规则（绝对路径/URL 账号密码/令牌前缀/密码键值对/邮箱），顺序固定，两占位符 `<路径>`/`<脱敏>`，复制前收敛。
- 后台安装不中断：关面板不中断，重开读盘 1 秒内恢复，仅进程关判中断。
- D5 档案卷可选主题：`theme: 'd5-paper'`（`mountUpdatePanel` + `setTheme`，默认不动），迷你印章 + profile 牌 + 待重启衬线横幅 + 手绘 SVG 标 + 窄屏印章固定 + 省略号逐字折叠 + 浅深双主题，DOM 冻结、复制诊断常在。

### Changed
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
