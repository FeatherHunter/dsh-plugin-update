# 当前插件用户可见文本全量表格（集中字典中英对照，含 v4 草稿）

> 源：`src/bilingual.ts` `BILINGUAL_STRINGS`，共 318 键；`en`/`key` 不动，只改 `zh`。
> 标准：沿 #101 v4（真专业不堆砌）：用仓内既定叫法（使用范围/版本信息/清单文件/版本声明/诊断信息/插件作者/重启宿主/重新查询）＋标准 CS 术语；不引入载荷/落盘/槽/漂移/事务/执行阶段/作用域/元数据等自造名词；语气统一为“请/若持续/重新”。
> 状态：`已改造(#101)` 49 条保持现状；`待改造` 269 条给出 v4 草稿，待用户确认后落地（bilingual.ts＋快照＋测试）。
> 冻结说明：印章 mini 单字（30×30）不改；`panel.diag.copy.field.*`/`line.*`/`block.*` 复制字段键名冻结不改（机读）；卷首/章节/总账等主题用语不改；`人话`为 CONTEXT 既定术语不改。

统计：共 318 键，已改造(#101) 49，待改造 269。

> 落地记录（2026-10-11）：269 条待改造中 148 处已按终审拍板落地 `src/bilingual.ts`（只改 zh，`en`/`key`/draft 零触碰，程序校验；其中 cancel-unavailable 按用户终审用“所需的信息”版）。`node build.mjs`＋三道硬门禁绿＋`npm test` 965 通过 0 失败；release 门如实红（全 draft，无双签）；视觉矩阵（印章/按钮）无溢出，见 `artifacts/matrix104-seal.html`、`artifacts/matrix104-batch.html`。49 条 #101 ＋ 119 条 keeps 未动。


| # | key | 中文现状 | 英文（不动） | 状态 | v4 草稿中文 | 说明 |
|---:|---|---|---|---|---|---|
| 1 | `entry.label.idle` | 检查更新 | Check for updates | 待改造 | 检查更新 | 入口按钮；无占位符；与现状同（仅确认）；草稿同现状 |
| 2 | `entry.label.failed` | 更新失败，点此查看 | Update failed — View details | 待改造 | 更新失败，请查看详情 | 入口按钮；无占位符 |
| 3 | `entry.label.busy` | 正在安装… | Installing… | 待改造 | 正在安装… | 入口按钮；无占位符；与现状同（仅确认）；草稿同现状 |
| 4 | `entry.label.restart` | 待重启 | Restart required | 待改造 | 待重启 | 入口按钮；无占位符；与现状同（仅确认）；草稿同现状 |
| 5 | `entry.label.has-update` | 有新版 {version} | Update available {version} | 待改造 | 有新版本 {version} | 入口按钮；占位符 `{version}` |
| 6 | `entry.action.checking` | 正在查新版… | Checking for updates… | 待改造 | 正在查询版本信息… | 入口按钮；无占位符 |
| 7 | `entry.note.up-to-date` | 已是最新 {version} | Up to date {version} | 待改造 | 已是最新 {version} | 入口按钮；占位符 `{version}`；与现状同（仅确认）；草稿同现状 |
| 8 | `batch-entry.label.idle` | 检查更新 | Check for updates | 待改造 | 检查更新 | 批量入口；无占位符；与现状同（仅确认）；草稿同现状 |
| 9 | `batch-entry.label.update` | {count} 家可更新 | {count} updates available | 待改造 | {count} 个可更新 | 批量入口；占位符 `{count}` |
| 10 | `batch-entry.label.busy` | 正在安装… | Installing… | 待改造 | 正在安装… | 批量入口；无占位符；与现状同（仅确认）；草稿同现状 |
| 11 | `batch-entry.label.restart` | {count} 家待重启 | {count} restarts required | 待改造 | {count} 个待重启 | 批量入口；占位符 `{count}` |
| 12 | `batch-entry.label.failed` | {count} 家失败，点此查看 | {count} failed — View details | 待改造 | {count} 个失败，请查看详情 | 批量入口；占位符 `{count}` |
| 13 | `batch-entry.action.checking` | 正在查新版… | Checking for updates… | 待改造 | 正在查询版本信息… | 批量入口；无占位符 |
| 14 | `panel.blocked.unknown-profile.title` | 无法识别使用范围或插件安装位置 | Unrecognized scope or plugin location | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 15 | `panel.blocked.unknown-profile.action` | 重启宿主后重新查询；若持续，请提交版本号与诊断信息至插件作者；此场景不提供手工命令 | Reopen the host and check again; if it persists, send the version and logs to the plugin author; no manual command is provided for this case. | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 16 | `panel.blocked.channel-mismatch.title` | 已安装版本与当前版本通道不符 | Installed version is not in the selected release channel | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 17 | `panel.blocked.channel-mismatch.action` | 切换至预发布通道，或重新安装本通道正式版本后查询 | Switch to the prerelease channel, or install the channel release, then check again. | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 18 | `panel.blocked.source-install.title` | 源码安装实例，不支持版本更新 | Installed from source, not by version | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 19 | `panel.blocked.source-install.action` | 此场景不提供手工命令；如需更新，请按包名@版本号重新安装 | No manual command is provided here; to update, reinstall by version first. | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 20 | `panel.blocked.invalid-installation.title` | 已安装包结构不完整（包名 / 版本号 / 入口文件异常） | Installed package is incomplete (name mismatch, invalid version, or missing entry file) | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 21 | `panel.blocked.invalid-installation.action` | 重新安装当前版本以修复安装目录，然后重新查询更新 | Reinstall the current version to repair the install directory, then check again. | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 22 | `panel.blocked.installation-changed.title` | 安装位置发生变更（目录或包体不一致） | Install location changed during use (directory or package changed) | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 23 | `panel.blocked.installation-changed.action` | 重启宿主后重新查询；若持续，请重新安装 | Reopen the host and check again; if it persists, reinstall. | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 24 | `panel.blocked.pending-restart.title` | 新版本已写入磁盘，当前运行仍为旧版本 | New version is on disk; the running instance is still the old version | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 25 | `panel.blocked.pending-restart.action` | 重启宿主以加载新版本；此为正常状态，非安装失败 | Restart the host to run the new version; this is a normal end state, not a failure. | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 26 | `panel.blocked.registry-conflict.title` | 版本声明与磁盘实际版本冲突 | Declared version conflicts with the version on disk | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 27 | `panel.blocked.registry-conflict.action` | 核对使用范围清单文件中目标包的版本声明，修正后重试 | Open the scope manifest and set the target package line to the version number, then retry. | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 28 | `panel.blocked.incompatible-node.title` | Node 运行时版本不兼容 | Required Node version does not match the running Node | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 29 | `panel.blocked.incompatible-node.action` | 请升级 Node 至 22 或更高版本后重新查询 | Upgrade Node to 22 or later, then check again. | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 30 | `panel.blocked.recovery-required.title` | 上次安装异常中断，存在未完成任务 | Last install was interrupted, leaving a partial task | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 31 | `panel.blocked.recovery-required.action` | 重新执行安装；若持续，请按第 6 节排错 | Run install once more; if it persists, follow section 6 to troubleshoot. | 已改造(#101) | —（保持现状） | 阻塞码（#101已改）；无占位符 |
| 32 | `panel.failure.check-failed.title` | 版本信息查询失败（网络 / 数据源 / 限流） | Couldn’t check for updates (network, source, or rate limit) | 已改造(#101) | —（保持现状） | 失败码（#101已改）；无占位符 |
| 33 | `panel.failure.check-failed.action` | 稍后重新查询；若持续，请提交诊断信息至插件作者 | Try checking again later; if it keeps failing, send the copied diagnostics to the plugin author. | 已改造(#101) | —（保持现状） | 失败码（#101已改）；无占位符 |
| 34 | `panel.failure.invalid-release.title` | 发布版本信息无效（版本号非法或内容不一致） | Release info is invalid (bad version or mismatched content) | 已改造(#101) | —（保持现状） | 失败码（#101已改）；无占位符 |
| 35 | `panel.failure.invalid-release.action` | 核对清单文件中的包名与版本声明后重新查询 | Check the package name and version in the manifest, then check again. | 已改造(#101) | —（保持现状） | 失败码（#101已改）；无占位符 |
| 36 | `panel.failure.check-expired.title` | 查询凭证过期，安装请求被拒绝 | Credentials expired; the install request was rejected | 已改造(#101) | —（保持现状） | 失败码（#101已改）；无占位符 |
| 37 | `panel.failure.check-expired.action` | 请重新查询版本信息后安装；请勿复用过期请求编号 | Check for updates again before installing; do not retry with the old ID. | 已改造(#101) | —（保持现状） | 失败码（#101已改）；无占位符 |
| 38 | `panel.failure.update-busy.title` | 同一使用范围内存在进行中的安装任务 | Another install is running in the same scope | 已改造(#101) | —（保持现状） | 失败码（#101已改）；无占位符 |
| 39 | `panel.failure.update-busy.action` | 待当前任务退出 installing/verifying 状态后重试；排队期间可查询任务状态确认队列位置 | Wait until the current task leaves installing/verifying, then try; check status for your queue position. | 已改造(#101) | —（保持现状） | 失败码（#101已改）；无占位符 |
| 40 | `panel.failure.install-failed.title` | 安装执行失败，详情见诊断摘要 | Couldn’t install (see the diagnostic summary) | 已改造(#101) | —（保持现状） | 失败码（#101已改）；无占位符 |
| 41 | `panel.failure.install-failed.action` | 请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者 | Read the copied diagnostics first; on official desktop builds, send it to the plugin author. | 已改造(#101) | —（保持现状） | 失败码（#101已改）；无占位符 |
| 42 | `panel.failure.internal.title` | 内部错误，原因未知 | Something went wrong; the cause is unknown | 已改造(#101) | —（保持现状） | 失败码（#101已改）；无占位符 |
| 43 | `panel.failure.internal.action` | 请重试一次；若持续，请提交诊断信息至插件作者 | Retry once first; if it persists, send the copied diagnostics to the plugin author. | 已改造(#101) | —（保持现状） | 失败码（#101已改）；无占位符 |
| 44 | `panel.failure.unknown.title` | 内部错误，原因未知 | Something went wrong; the cause is unknown | 已改造(#101) | —（保持现状） | 失败码（#101已改）；无占位符 |
| 45 | `panel.failure.unknown.action` | 请重试一次；若持续，请提交诊断信息至插件作者（请一并提交所见错误码） | Retry once first; if it persists, send the copied diagnostics to the plugin author (include the code you saw). | 已改造(#101) | —（保持现状） | 失败码（#101已改）；无占位符 |
| 46 | `panel.seal.loading.text` | 待查 | Not checked | 待改造 | 待查 | 印章；无占位符；与现状同（仅确认）；草稿同现状 |
| 47 | `panel.seal.loading.mini` | 查 | Check | 待改造 | 查 | 印章；无占位符；印章mini单字冻结；与现状同（仅确认）；草稿同现状 |
| 48 | `panel.seal.idle.text` | 待查 | Not checked | 待改造 | 待查 | 印章；无占位符；与现状同（仅确认）；草稿同现状 |
| 49 | `panel.seal.idle.mini` | 查 | Check | 待改造 | 查 | 印章；无占位符；印章mini单字冻结；与现状同（仅确认）；草稿同现状 |
| 50 | `panel.seal.update.text` | 可装 | Update available | 待改造 | 可更新 | 印章；无占位符 |
| 51 | `panel.seal.update.mini` | 装 | Install | 待改造 | 装 | 印章；无占位符；印章mini单字冻结；与现状同（仅确认）；草稿同现状 |
| 52 | `panel.seal.busy.text` | 安装中 | Installing | 待改造 | 安装中 | 印章；无占位符；与现状同（仅确认）；草稿同现状 |
| 53 | `panel.seal.busy.mini` | 装 | Install | 待改造 | 装 | 印章；无占位符；印章mini单字冻结；与现状同（仅确认）；草稿同现状 |
| 54 | `panel.seal.restart.text` | 待重启 | Restart required | 待改造 | 待重启 | 印章；无占位符；与现状同（仅确认）；草稿同现状 |
| 55 | `panel.seal.restart.mini` | 启 | Restart | 待改造 | 启 | 印章；无占位符；印章mini单字冻结；与现状同（仅确认）；草稿同现状 |
| 56 | `panel.seal.blocked.text` | 受阻 | Blocked — Action needed | 待改造 | 受阻 | 印章；无占位符；与现状同（仅确认）；草稿同现状 |
| 57 | `panel.seal.blocked.mini` | 阻 | Blocked | 待改造 | 阻 | 印章；无占位符；印章mini单字冻结；与现状同（仅确认）；草稿同现状 |
| 58 | `panel.seal.failed.text` | 受阻 | Failed — Retry available | 待改造 | 失败 | 印章；无占位符 |
| 59 | `panel.seal.failed.mini` | 阻 | Failed | 待改造 | 阻 | 印章；无占位符；印章mini单字冻结；与现状同（仅确认）；草稿同现状 |
| 60 | `panel.seal.done.text` | 已最新 | Up to date | 待改造 | 已是最新 | 印章；无占位符 |
| 61 | `panel.seal.done.mini` | 定 | Done | 待改造 | 定 | 印章；无占位符；印章mini单字冻结；与现状同（仅确认）；草稿同现状 |
| 62 | `panel.banner.error.title` | 更新失败（{code}）：{detail}。 | Update failed ({code}): {detail}. | 待改造 | 更新失败（{code}）：{detail}。 | 顶部横幅；占位符 `{code}`,`{detail}`；与现状同（仅确认）；草稿同现状 |
| 63 | `panel.banner.error.action-fallback` | 复制诊断发给插件作者；深挖看日志通道。 | Copy the diagnostics for the plugin author; see the log channel for details. | 待改造 | 请复制诊断信息提交至插件作者；详情请查看日志通道。 | 顶部横幅；无占位符 |
| 64 | `panel.action.retry-install` | 重试安装 | Retry install | 待改造 | 重试安装 | 操作按钮；无占位符；与现状同（仅确认）；草稿同现状 |
| 65 | `panel.banner.loading` | 正在读取更新状态… | Loading update status… | 待改造 | 正在读取更新状态… | 顶部横幅；无占位符；与现状同（仅确认）；草稿同现状 |
| 66 | `panel.action.install` | 安装更新 | Install update | 待改造 | 安装更新 | 操作按钮；无占位符；与现状同（仅确认）；草稿同现状 |
| 67 | `panel.queue.busy-self` | 正在安装（本插件在装）。 | Installing (this plugin is installing). | 待改造 | 本插件正在安装。 | 队列；无占位符 |
| 68 | `panel.queue.busy-queued` | 前方有安装在进行，本插件排第 {n} 位，到队首再点安装。 | An install is running ahead; this plugin is #{n} in queue. Install when it reaches the front. | 待改造 | 前方有安装正在进行，本插件排第 {n} 位；到队首后请选择安装。 | 队列；占位符 `{n}` |
| 69 | `panel.queue.busy-other` | 前方有其他插件在安装，稍后重试。 | Another plugin is installing; retry later. | 待改造 | 前方有其他插件正在安装，请稍后重试。 | 队列；无占位符 |
| 70 | `panel.skip.skipped-title` | 已跳过 {latest} | Skipped {latest} | 待改造 | 已跳过版本 {latest} | 跳过；占位符 `{latest}` |
| 71 | `panel.skip.skipped-action` | 点“恢复”可重新提醒该版本；有更新的新版本会照常提醒。 | Select “Restore” to be reminded of this version again; newer versions will still notify. | 待改造 | 选择「恢复提醒」可重新提醒该版本；更新的版本仍会正常提醒。 | 跳过；无占位符 |
| 72 | `panel.banner.restart-title` | 新版 {latest} 已安装，重启宿主后生效。 | Version {latest} is installed; restart the host to take effect. | 待改造 | 新版本 {latest} 已安装，重启宿主后生效。 | 顶部横幅；占位符 `{latest}` |
| 73 | `panel.banner.installing-title` | 正在安装 {version}…关闭面板不会中断。 | Installing {version}… Closing the panel won’t interrupt it. | 待改造 | 正在安装 {version}…关闭面板不会中断。 | 顶部横幅；占位符 `{version}`；与现状同（仅确认）；草稿同现状 |
| 74 | `panel.banner.installing-action` | 进度按轮询自动刷新；重开面板 1 秒内恢复显示。 | Progress refreshes automatically; reopening the panel restores the view within a second. | 待改造 | 进度将自动轮询刷新；重新打开面板将在 1 秒内恢复显示。 | 顶部横幅；无占位符 |
| 75 | `panel.action.installing` | 安装中… | Installing… | 待改造 | 正在安装… | 操作按钮；无占位符 |
| 76 | `panel.banner.update-title` | 有新版 {latest} 可装（当前 {running}）。 | Update available: {latest} (current: {running}). | 待改造 | 有新版本 {latest} 可安装（当前版本 {running}）。 | 顶部横幅；占位符 `{latest}`,`{running}` |
| 77 | `panel.banner.update-action` | 点安装即走精确版本安装；同一使用范围同时只装一个。 | Install runs the exact version; only one install runs per scope at a time. | 待改造 | 选择安装将按精确版本安装；同一使用范围同时仅安装一项。 | 顶部横幅；无占位符 |
| 78 | `panel.action.install-version` | 安装 {latest} | Install {latest} | 待改造 | 安装版本 {latest} | 操作按钮；占位符 `{latest}` |
| 79 | `panel.banner.done` | 已是最新，无需更新。 | Up to date. No update needed. | 待改造 | 已是最新，无需更新。 | 顶部横幅；无占位符；与现状同（仅确认）；草稿同现状 |
| 80 | `panel.toast.checking` | 正在查新版… | Checking for updates… | 待改造 | 正在查询版本信息… | 轻提示；无占位符 |
| 81 | `panel.toast.installing` | 正在安装… | Installing… | 待改造 | 正在安装… | 轻提示；无占位符；与现状同（仅确认）；草稿同现状 |
| 82 | `panel.toast.copy-manual-ok` | 手工命令已复制，粘到终端整行执行即可。 | Manual command copied; paste the full line into the terminal to run it. | 待改造 | 手工命令已复制，请粘贴至终端整行执行。 | 轻提示；无占位符 |
| 83 | `panel.toast.copy-manual-fail` | 复制失败，请手动选中上面的命令。 | Copy failed; please select the command above manually. | 待改造 | 复制失败，请手动选择上方命令。 | 轻提示；无占位符 |
| 84 | `panel.toast.copy-diag-ok` | 诊断已复制，直接粘给插件作者即可（已脱敏）。 | Diagnostics copied; paste it to the plugin author (already redacted). | 待改造 | 诊断信息已复制，请提交至插件作者（已脱敏）。 | 轻提示；无占位符 |
| 85 | `panel.toast.copy-diag-fail` | 复制失败，请手动选中上面的信息。 | Copy failed; please select the info above manually. | 待改造 | 复制失败，请手动选择上方信息。 | 轻提示；无占位符 |
| 86 | `panel.toast.restart-delegated` | 已按调用方的重启流程处理；重启后新版生效。 | Handled by the caller’s restart flow; the new version takes effect after restart. | 待改造 | 已按调用方重启流程处理；重启后新版本生效。 | 轻提示；无占位符 |
| 87 | `panel.toast.restart-manual` | 本宿主未提供重启入口：请手动重启宿主，重启后新版生效。 | This host provides no restart entry; please restart the host manually. The new version takes effect after restart. | 待改造 | 本宿主未提供重启入口，请手动重启宿主；重启后新版本生效。 | 轻提示；无占位符 |
| 88 | `panel.toast.restart-failed` | 重启入口调用失败：请手动重启宿主，重启后新版生效。 | Restart entry failed; please restart the host manually. The new version takes effect after restart. | 待改造 | 重启入口调用失败，请手动重启宿主；重启后新版本生效。 | 轻提示；无占位符 |
| 89 | `panel.toast.copy-state-ok` | 已复制当前状态（无失败），直接粘给插件作者即可（已脱敏）。 | Current state copied (no failure); paste it to the plugin author (already redacted). | 待改造 | 当前状态已复制（无失败），请提交至插件作者（已脱敏）。 | 轻提示；无占位符 |
| 90 | `panel.toast.failure-dismissed` | 已确认该失败提示；下次查新版或安装将重新评估。 | Failure acknowledged; it will be re-evaluated on the next check or install. | 待改造 | 已确认该失败提示；下次查询版本信息或安装将重新评估。 | 轻提示；无占位符 |
| 91 | `panel.strip.running` | 运行 | Running | 待改造 | 运行版 | 版本条；无占位符 |
| 92 | `panel.strip.installed` | 磁盘 | Installed | 待改造 | 已安装 | 版本条；无占位符 |
| 93 | `panel.strip.latest` | 远端 | Latest | 待改造 | 最新版 | 版本条；无占位符 |
| 94 | `panel.meta.label` | 使用范围 | Scope | 待改造 | 使用范围 | 元信息；无占位符；与现状同（仅确认）；草稿同现状 |
| 95 | `panel.meta.unknown` | 未知 | Unknown | 待改造 | 未知 | 元信息；无占位符；与现状同（仅确认）；草稿同现状 |
| 96 | `panel.masthead.kicker` | 插件更新 | Plugin update | 待改造 | 插件更新 | 卷首；无占位符；主题用语；与现状同（仅确认）；草稿同现状 |
| 97 | `panel.masthead.title` | 更新档案 | Update archive | 待改造 | 更新档案 | 卷首；无占位符；主题用语；与现状同（仅确认）；草稿同现状 |
| 98 | `panel.masthead.volume` | 卷 | Vol. | 待改造 | 卷 | 卷首；无占位符；主题用语；与现状同（仅确认）；草稿同现状 |
| 99 | `panel.chapter.check` | 检查与安装 | Check and install | 待改造 | 检查与安装 | 章节标题；无占位符；主题用语；与现状同（仅确认）；草稿同现状 |
| 100 | `panel.chapter.changelog` | 更新日志 | Changelog | 待改造 | 更新日志 | 章节标题；无占位符；主题用语；与现状同（仅确认）；草稿同现状 |
| 101 | `panel.chapter.queue` | 更新队列 | Update queue | 待改造 | 更新队列 | 章节标题；无占位符；主题用语；与现状同（仅确认）；草稿同现状 |
| 102 | `panel.chapter.error` | 错误信息 | Error details | 待改造 | 错误信息 | 章节标题；无占位符；主题用语；与现状同（仅确认）；草稿同现状 |
| 103 | `panel.chapter.manual` | 手工命令 | Manual command | 待改造 | 手工命令 | 章节标题；无占位符；主题用语；与现状同（仅确认）；草稿同现状 |
| 104 | `panel.progress.installing` | 正在安装新版… | Installing new version… | 待改造 | 正在安装新版本… | 进度；无占位符 |
| 105 | `panel.progress.verifying` | 正在校验安装结果… | Verifying install result… | 待改造 | 正在校验安装结果… | 进度；无占位符；与现状同（仅确认）；草稿同现状 |
| 106 | `panel.action.check` | 查新版 | Check for updates | 待改造 | 检查更新 | 操作按钮；无占位符 |
| 107 | `panel.action.check-title` | 重新向官方源查一次新版（只读，不安装） | Check the official source once more (read-only, never installs) | 待改造 | 重新向官方源查询版本信息（只读，不安装） | 操作按钮；无占位符 |
| 108 | `panel.action.checking-busy` | 正在查新版… | Checking for updates… | 待改造 | 正在查询版本信息… | 操作按钮；无占位符 |
| 109 | `panel.action.checking-busy-title` | 正在向官方源查询，请稍候 | Checking the official source; please wait | 待改造 | 正在向官方源查询版本信息，请稍候 | 操作按钮；无占位符 |
| 110 | `panel.action.installing-busy` | 正在安装… | Installing… | 待改造 | 正在安装… | 操作按钮；无占位符；与现状同（仅确认）；草稿同现状 |
| 111 | `panel.action.installing-busy-title` | 正在安装，请稍候 | Installing; please wait | 待改造 | 正在安装，请稍候 | 操作按钮；无占位符；与现状同（仅确认）；草稿同现状 |
| 112 | `panel.action.install-title` | 用精确版本安装；同一使用范围同时只装一个 | Install the exact version; one install per scope at a time | 待改造 | 按精确版本安装；同一使用范围同时仅安装一项 | 操作按钮；无占位符 |
| 113 | `panel.action.skip` | 跳过该版本 | Skip this version | 待改造 | 跳过该版本 | 操作按钮；无占位符；与现状同（仅确认）；草稿同现状 |
| 114 | `panel.action.skip-title` | 该版本不再提醒；有更新的新版本照常提醒 | This version will no longer notify; newer versions still will | 待改造 | 该版本将不再提醒；更新的版本仍会正常提醒 | 操作按钮；无占位符 |
| 115 | `panel.action.unskip` | 恢复（{version}） | Restore ({version}) | 待改造 | 恢复提醒（{version}） | 操作按钮；占位符 `{version}` |
| 116 | `panel.action.unskip-title` | 撤销跳过，该版本重新提醒 | Undo skip; this version will remind again | 待改造 | 撤销跳过，该版本将重新提醒 | 操作按钮；无占位符 |
| 117 | `panel.action.copy-manual` | 复制手工命令 | Copy manual command | 待改造 | 复制手工命令 | 操作按钮；无占位符；与现状同（仅确认）；草稿同现状 |
| 118 | `panel.action.copy-manual-title` | 复制手工命令，粘到终端整行执行 | Copy the manual command; paste the full line into the terminal | 待改造 | 复制手工命令，请粘贴至终端整行执行 | 操作按钮；无占位符 |
| 119 | `panel.action.restart-host` | 请重启DSH | Please restart DSH | 待改造 | 请重启DSH | 操作按钮；无占位符；与现状同（仅确认）；草稿同现状 |
| 120 | `panel.action.restart-host-title` | 点一下走调用方流程，没有就手动重启 DSH | Run the caller restart flow if available, otherwise restart DSH manually | 待改造 | 优先走调用方重启流程；若无，请手动重启 DSH | 操作按钮；无占位符 |
| 121 | `panel.action.dismiss` | 知道了 | Got it | 待改造 | 已知晓 | 操作按钮；无占位符 |
| 122 | `panel.action.dismiss-title` | 确认已知晓该失败：回到可装页，下次查/装将重新评估 | Acknowledge the failure and return; next check or install will re-evaluate | 待改造 | 确认已知晓该失败：返回可安装页，下次查询或安装将重新评估 | 操作按钮；无占位符 |
| 123 | `panel.action.copy-diag` | 复制诊断 | Copy diagnostics | 待改造 | 复制诊断 | 操作按钮；无占位符；与现状同（仅确认）；草稿同现状 |
| 124 | `panel.action.copy-diag-title` | 复制已脱敏诊断，直接粘给插件作者 | Copy redacted diagnostics for the plugin author | 待改造 | 复制已脱敏诊断，请提交至插件作者 | 操作按钮；无占位符 |
| 125 | `panel.skip.line-tag` | 已跳过 {version} | Skipped {version} | 待改造 | 已跳过版本 {version} | 跳过；占位符 `{version}` |
| 126 | `panel.skip.line-note` | 点「恢复」可撤销，之后这一版还会再提醒。 | Select \u201CRestore\u201D to undo; this version will remind again. | 待改造 | 选择「恢复提醒」可撤销，该版本此后仍会提醒。 | 跳过；无占位符 |
| 127 | `panel.changelog.heading` | 更新说明： | Changelog: | 待改造 | 更新说明： | 更新日志；无占位符；与现状同（仅确认）；草稿同现状 |
| 128 | `panel.changelog.heading-range` | 更新说明（{from} → {to}）： | Changelog ({from} \u2192 {to}): | 待改造 | 更新说明（{from} → {to}）： | 更新日志；占位符 `{from}`,`{to}`；与现状同（仅确认）；草稿同现状 |
| 129 | `panel.changelog.unavailable` | 日志读不出来，安装不受影响。 | Could not read logs; install is unaffected. | 待改造 | 更新日志无法读取，安装不受影响。 | 更新日志；无占位符 |
| 130 | `panel.changelog.unavailable-empty` | 还没查到新版；查到后再显示日志。 | No release found yet; logs will show after a check. | 待改造 | 尚未查询到新版本；查询到后将显示更新日志。 | 更新日志；无占位符 |
| 131 | `panel.changelog.toggle-title` | 展开或收起更新日志 | Expand or collapse changelog | 待改造 | 展开或收起更新日志 | 更新日志；无占位符；与现状同（仅确认）；草稿同现状 |
| 132 | `panel.changelog.expand` | 展开更新日志 | Expand changelog | 待改造 | 展开更新日志 | 更新日志；无占位符；与现状同（仅确认）；草稿同现状 |
| 133 | `panel.changelog.collapse` | 收起更新日志 | Collapse changelog | 待改造 | 收起更新日志 | 更新日志；无占位符；与现状同（仅确认）；草稿同现状 |
| 134 | `panel.queue.state-idle` | 空闲 | Idle | 待改造 | 空闲 | 队列；无占位符；与现状同（仅确认）；草稿同现状 |
| 135 | `panel.queue.other` | 其他插件 | Other plugin | 待改造 | 其他插件 | 队列；无占位符；与现状同（仅确认）；草稿同现状 |
| 136 | `panel.queue.self` | 本插件 | This plugin | 待改造 | 本插件 | 队列；无占位符；与现状同（仅确认）；草稿同现状 |
| 137 | `panel.queue.pos-absent` | 未排队 | Not queued | 待改造 | 未排队 | 队列；无占位符；与现状同（仅确认）；草稿同现状 |
| 138 | `panel.queue.pos-n` | 第 {n} 位 | Position {n} | 待改造 | 排队第 {n} 位 | 队列；占位符 `{n}` |
| 139 | `panel.queue.pos-next` | 下一个就是你 | You are next | 待改造 | 下一位就是你 | 队列；无占位符 |
| 140 | `panel.queue.pos-ahead` | 前方 {n} 个 | {n} ahead | 待改造 | 前方还有 {n} 项 | 队列；占位符 `{n}` |
| 141 | `panel.queue.row-installing` | 正在安装 | Installing | 待改造 | 正在安装 | 队列；无占位符；与现状同（仅确认）；草稿同现状 |
| 142 | `panel.queue.row-installing-note` | 装完自动轮到你 | You are next when it finishes | 待改造 | 安装完成后自动轮到你 | 队列；无占位符 |
| 143 | `panel.queue.row-idle-note` | 同一使用范围一次只装一个 | One install per scope at a time | 待改造 | 同一使用范围同时仅安装一项 | 队列；无占位符 |
| 144 | `panel.queue.row-position` | 你的顺位 | Your position | 待改造 | 你的排队顺位 | 队列；无占位符 |
| 145 | `panel.queue.row-order` | 排队顺序 | Queue order | 待改造 | 排队顺序 | 队列；无占位符；与现状同（仅确认）；草稿同现状 |
| 146 | `panel.queue.toggle-hide` | 隐藏他人明细 | Hide others | 待改造 | 隐藏其他插件明细 | 队列；无占位符 |
| 147 | `panel.queue.toggle-show` | 显示其他插件 | Show others | 待改造 | 显示其他插件 | 队列；无占位符；与现状同（仅确认）；草稿同现状 |
| 148 | `panel.queue.empty` | 当前没有排队任务，同一使用范围一次只装一个。 | No queued tasks; one install per scope at a time. | 待改造 | 当前无排队任务；同一使用范围同时仅安装一项。 | 队列；无占位符 |
| 149 | `panel.error.code-label` | 稳定码 | Stable code | 待改造 | 稳定码 | 错误详情卷宗；无占位符；与现状同（仅确认）；草稿同现状 |
| 150 | `panel.error.code-note` | 上一条中文说明就是要用户做的事；要往上游报，用「复制诊断」整段粘（已脱敏）。 | The line above tells you what to do; to report upstream, paste \u201CCopy diagnostics\u201D as a whole (already redacted). | 待改造 | 上方中文说明即需执行的操作；如需向上游反馈，请使用「复制诊断」整段粘贴（已脱敏）。 | 错误详情卷宗；无占位符 |
| 151 | `panel.error.query-request` | 请求 | Request | 待改造 | 请求 | 错误详情卷宗；无占位符；与现状同（仅确认）；草稿同现状 |
| 152 | `panel.error.query-check` | 检查 | Check | 待改造 | 检查 | 错误详情卷宗；无占位符；与现状同（仅确认）；草稿同现状 |
| 153 | `panel.error.failed-at` | 失败于 {time} | Failed at {time} | 待改造 | 失败时间 {time} | 错误详情卷宗；占位符 `{time}` |
| 154 | `panel.error.query-keys` | 本次查询键：{keys}（拿着它们去日志里对）。 | Query keys: {keys} (use them to match in logs). | 待改造 | 本次查询键：{keys}（可凭此在日志中检索匹配）。 | 错误详情卷宗；占位符 `{keys}` |
| 155 | `panel.error.target-version` | 失败目标 {version} | Failed target {version} | 待改造 | 失败目标版本 {version} | 错误详情卷宗；占位符 `{version}` |
| 156 | `panel.error.evidence-frozen` | 证据已冻结：复制诊断里的码、版本、编号都取自失败时刻，不随轮询刷新；下一次查新版或安装会更新它。 | Evidence frozen: the code, versions, and IDs in copied diagnostics are from the failure moment and do not refresh with polling; the next check or install will update them. | 待改造 | 证据已冻结：复制诊断中的稳定码、版本与编号均取自失败时刻，不随轮询刷新；下次查询版本信息或安装将更新。 | 错误详情卷宗；无占位符 |
| 157 | `panel.error.evidence-transient` | 读数瞬态失败：下一次成功读数会自动解除；一直出现再按稳定码排查。 | Transient read failure: it clears on the next successful read; if it persists, troubleshoot by stable code. | 待改造 | 瞬态读取失败：下次成功读取将自动解除；若持续出现，请按稳定码排查。 | 错误详情卷宗；无占位符 |
| 158 | `panel.error.no-failure` | 暂无失败：此时复制诊断给出的是当前状态快照。 | No failure: copying diagnostics gives the current state snapshot. | 待改造 | 暂无失败：此时复制诊断提供的是当前状态快照。 | 错误详情卷宗；无占位符 |
| 159 | `panel.error.log-hint` | 深挖看日志：按插件标识 {pluginId} 过滤 {e1}、{e2}、{e3} 三个事件。 | Check logs: filter by plugin ID {pluginId} for events {e1}, {e2}, {e3}. | 待改造 | 请查看日志：按插件标识 {pluginId} 筛选 {e1}、{e2}、{e3} 事件。 | 错误详情卷宗；占位符 `{e1}`,`{e2}`,`{e3}`,`{pluginId}` |
| 160 | `panel.error.log-follow` | 凭上面的请求／检查编号在 {eFail} 里对上；基线耗时看 {eCall}，执行结果看 {eExec}。 | Match the request/check IDs above in {eFail}; baseline timing in {eCall}, execution result in {eExec}. | 待改造 | 凭上方请求／检查编号在 {eFail} 中匹配；基线耗时请查看 {eCall}，执行结果请查看 {eExec}。 | 错误详情卷宗；占位符 `{eCall}`,`{eExec}`,`{eFail}` |
| 161 | `panel.manual.heading` | 手工兜底命令（复制整行执行）： | Manual fallback command (copy the full line to run): | 待改造 | 手工备用命令（请复制整行执行）： | 手工命令；无占位符 |
| 162 | `panel.manual.absent` | 当前没有可用的手工命令（使用范围无法识别或源码安装场景不提供）。 | No manual command available (unrecognized scope or source install). | 已改造(#101) | —（保持现状） | 手工命令；无占位符 |
| 163 | `panel.footer.note` | 关闭不影响更新，可随时回来查看 | Closing never interrupts updates; come back anytime | 待改造 | 关闭窗口，更新不受影响，可随时返回查看。 | 底部；无占位符 |
| 164 | `panel.footer.close` | 关闭 | Close | 待改造 | 关闭 | 底部；无占位符；与现状同（仅确认）；草稿同现状 |
| 165 | `panel.footer.close-title` | 关闭窗口，更新不受影响 | Close the window; updates keep running | 待改造 | 关闭窗口，更新不受影响 | 底部；无占位符；与现状同（仅确认）；草稿同现状 |
| 166 | `panel.diag.header` | [更新诊断] {pluginId} 稳定码：{code} | [Update Diagnostics] {pluginId} Stable code: {code} | 待改造 | [更新诊断] {pluginId} 稳定码：{code} | 诊断复制；占位符 `{code}`,`{pluginId}`；与现状同（仅确认）；草稿同现状 |
| 167 | `panel.diag.label.human` | 人话：{detail} | Detail: {detail} | 待改造 | 人话：{detail} | 诊断复制；占位符 `{detail}`；“人话”为既定术语；与现状同（仅确认）；草稿同现状 |
| 168 | `panel.diag.label.running` | 运行版：{version} | Running: {version} | 待改造 | 运行版：{version} | 诊断复制；占位符 `{version}`；与现状同（仅确认）；草稿同现状 |
| 169 | `panel.diag.label.installed` | 已装：{version} | Installed: {version} | 待改造 | 已安装：{version} | 诊断复制；占位符 `{version}` |
| 170 | `panel.diag.label.latest` | 远端：{version} | Latest: {version} | 待改造 | 最新版：{version} | 诊断复制；占位符 `{version}` |
| 171 | `panel.diag.queue.installing` | 正在安装 | Installing | 待改造 | 正在安装 | 诊断复制；无占位符；与现状同（仅确认）；草稿同现状 |
| 172 | `panel.diag.queue.position` | 排队第 {n} 位 | Queued at position {n} | 待改造 | 排队第 {n} 位 | 诊断复制；占位符 `{n}`；与现状同（仅确认）；草稿同现状 |
| 173 | `panel.diag.queue.absent` | 不在队列里 | Not queued | 待改造 | 未排队 | 诊断复制；无占位符 |
| 174 | `panel.diag.label.host` | 宿主：{host} | Host: {host} | 待改造 | 宿主：{host} | 诊断复制；占位符 `{host}`；与现状同（仅确认）；草稿同现状 |
| 175 | `panel.diag.label.profile` | 使用范围：{profile} | Scope: {profile} | 待改造 | 使用范围：{profile} | 诊断复制；占位符 `{profile}`；与现状同（仅确认）；草稿同现状 |
| 176 | `panel.diag.label.queue` | 队列：{queue} | Queue: {queue} | 待改造 | 队列：{queue} | 诊断复制；占位符 `{queue}`；与现状同（仅确认）；草稿同现状 |
| 177 | `panel.diag.label.request` | 请求编号：{requestId} | Request ID: {requestId} | 待改造 | 请求编号：{requestId} | 诊断复制；占位符 `{requestId}`；与现状同（仅确认）；草稿同现状 |
| 178 | `panel.diag.label.manual` | 手工命令：{manual} | Manual command: {manual} | 待改造 | 手工命令：{manual} | 诊断复制；占位符 `{manual}`；与现状同（仅确认）；草稿同现状 |
| 179 | `panel.diag.copy.no-detail` | （本回包没有带诊断摘要，等电话侧 diag 落定后补齐） | (This response carries no diagnostic summary; it will be completed when phone-side diag lands) | 待改造 | （本响应未携带诊断摘要，待诊断信息就绪后补全） | 诊断复制；无占位符 |
| 180 | `panel.diag.copy.unknown-package` | (未知包) | (Unknown package) | 待改造 | （未知插件包） | 诊断复制；无占位符 |
| 181 | `panel.diag.copy.unknown` | 未知 | Unknown | 待改造 | 未知 | 诊断复制；无占位符；与现状同（仅确认）；草稿同现状 |
| 182 | `panel.diag.copy.field.plugin` | 插件={plugin} | Plugin={plugin} | 待改造 | 插件={plugin} | 诊断复制；占位符 `{plugin}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 183 | `panel.diag.copy.field.version` | 版本={run}→{inst} | Version={run}→{inst} | 待改造 | 版本={run}→{inst} | 诊断复制；占位符 `{inst}`,`{run}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 184 | `panel.diag.copy.field.host` | 宿主={host} | Host={host} | 待改造 | 宿主={host} | 诊断复制；占位符 `{host}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 185 | `panel.diag.copy.field.profile` | 使用范围={profile} | Scope={profile} | 待改造 | 使用范围={profile} | 诊断复制；占位符 `{profile}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 186 | `panel.diag.copy.field.route` | 路由={route} | Route={route} | 待改造 | 路由={route} | 诊断复制；占位符 `{route}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 187 | `panel.diag.copy.field.stage` | 阶段={stage} | Stage={stage} | 待改造 | 阶段={stage} | 诊断复制；占位符 `{stage}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 188 | `panel.diag.copy.field.method` | 方法={method} | Method={method} | 待改造 | 方法={method} | 诊断复制；占位符 `{method}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 189 | `panel.diag.copy.field.latency` | 耗时={latency} | Latency={latency} | 待改造 | 耗时={latency} | 诊断复制；占位符 `{latency}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 190 | `panel.diag.copy.field.registry` | 源={host} | Source={host} | 待改造 | 源={host} | 诊断复制；占位符 `{host}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 191 | `panel.diag.copy.field.registry-unknown` | 源=未知（非官方源时省略本身即信息） | Source=Unknown (Omitted for non-official sources, which is itself information) | 待改造 | 源=未知（非官方源时省略本身即信息） | 诊断复制；无占位符；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 192 | `panel.diag.copy.field.action` | 建议={action} | Suggestion={action} | 待改造 | 建议={action} | 诊断复制；占位符 `{action}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 193 | `panel.diag.copy.field.request` | 请求={request} | Request={request} | 待改造 | 请求={request} | 诊断复制；占位符 `{request}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 194 | `panel.diag.copy.field.check` | 检查={check} | Check={check} | 待改造 | 检查={check} | 诊断复制；占位符 `{check}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 195 | `panel.diag.copy.field.queue` | 队列={queue} | Queue={queue} | 待改造 | 队列={queue} | 诊断复制；占位符 `{queue}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 196 | `panel.diag.copy.field.target` | 目标={version} | Target={version} | 待改造 | 目标={version} | 诊断复制；占位符 `{version}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 197 | `panel.diag.copy.line.summary` | 摘要={summary} | Summary={summary} | 待改造 | 摘要={summary} | 诊断复制；占位符 `{summary}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 198 | `panel.diag.copy.line.remedy` | 怎么办={remedy} | Remedy={remedy} | 待改造 | 怎么办={remedy} | 诊断复制；占位符 `{remedy}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 199 | `panel.diag.copy.block.summary` | 摘要：{summary} | Summary：{summary} | 待改造 | 摘要：{summary} | 诊断复制；占位符 `{summary}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 200 | `panel.diag.copy.block.source` | 来源：{source} | Source：{source} | 待改造 | 来源：{source} | 诊断复制；占位符 `{source}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 201 | `panel.diag.copy.block.remedy` | 怎么办：{remedy} | Remedy：{remedy} | 待改造 | 怎么办：{remedy} | 诊断复制；占位符 `{remedy}`；复制字段键名冻结；与现状同（仅确认）；草稿同现状 |
| 202 | `batch.action.resume` | 继续上次未完成的更新（还剩 {count} 家） | Continue the unfinished batch ({count} left) | 待改造 | 继续上次未完成的更新（剩余 {count} 个）。 | 批量操作；占位符 `{count}` |
| 203 | `batch.action.resume-title` | 从上次没做完的地方接着安装，已完成的不重装 | Continue from where it stopped; installed ones stay | 待改造 | 从上次中断处继续安装，已完成的不会重复安装。 | 批量操作；无占位符 |
| 204 | `batch.action.discard` | 丢弃这批未完成的更新（已完成的保留） | Discard this unfinished batch (installed ones stay) | 待改造 | 丢弃本批未完成的更新（已完成的将保留）。 | 批量操作；无占位符 |
| 205 | `batch.action.confirm-discard` | 确认丢弃 | Confirm discard | 待改造 | 确认丢弃 | 批量操作；无占位符；与现状同（仅确认）；草稿同现状 |
| 206 | `batch.fact.close-safe` | 关掉面板不会中断：进度已写盘，回来可继续。 | Closing this panel won\'t stop it \u2014 progress is saved on disk. | 待改造 | 关闭面板不会中断更新：进度已保存，可随时返回继续。 | 批量事实提示；无占位符 |
| 207 | `batch.setting.check-on-open` | 打开面板时自动检查更新 | Check for updates when opening | 待改造 | 打开面板时自动检查更新 | 批量设置；无占位符；与现状同（仅确认）；草稿同现状 |
| 208 | `batch.row.update` | 有新版 {version} | Update available {version} | 待改造 | 有新版本 {version} | 批量行；占位符 `{version}` |
| 209 | `batch.row.current` | 已是最新，不用动 | Up to date | 待改造 | 已是最新，无需操作。 | 批量行；无占位符 |
| 210 | `batch.row.never` | 还没查过 | Not checked yet | 待改造 | 尚未查询 | 批量行；无占位符 |
| 211 | `batch.row.failed` | 这次没查到 | Last check failed | 待改造 | 本次未能查询 | 批量行；无占位符 |
| 212 | `batch.notice.auto-resumed` | 已自动继续上次未完成的更新（还剩 {count} 家）。 | Auto-continued the unfinished batch ({count} left). | 待改造 | 已自动继续上次未完成的更新（剩余 {count} 个）。 | 批量通知；占位符 `{count}` |
| 213 | `batch.notice.resumed` | 已继续上次未完成的更新（还剩 {count} 家）。 | Continued the unfinished batch ({count} left). | 待改造 | 已继续上次未完成的更新（剩余 {count} 个）。 | 批量通知；占位符 `{count}` |
| 214 | `batch.notice.no-resume` | 没有可继续的内容。 | Nothing to continue. | 待改造 | 暂无可继续的内容。 | 批量通知；无占位符 |
| 215 | `batch.notice.discarded` | 已丢弃这批未完成的更新（已完成的保留）。 | Discarded this unfinished batch (installed ones stay). | 待改造 | 已丢弃本批未完成的更新（已完成的将保留）。 | 批量通知；无占位符 |
| 216 | `batch.notice.cancel-confirm` | 再点一次确认丢弃。 | Click again to confirm discard. | 待改造 | 请再次选择以确认丢弃。 | 批量通知；无占位符 |
| 217 | `batch.notice.busy-cancel` | 正在装的那一家停不了。 | An install is running and cannot be stopped. | 待改造 | 正在安装的项无法停止。 | 批量通知；无占位符 |
| 218 | `batch.row.unfinished-tag` | 上一批没做完 | unfinished last time | 待改造 | 上次未完成 | 批量行；无占位符 |
| 219 | `batch.summary.updatable` | {n} 家可更新 | {n} updates available | 待改造 | {n} 个可更新 | 批量汇总；占位符 `{n}` |
| 220 | `batch.summary.installing` | {n} 家安装中 | {n} installing | 待改造 | {n} 个安装中 | 批量汇总；占位符 `{n}` |
| 221 | `batch.summary.pending` | {n} 家待查 | {n} not checked | 待改造 | {n} 个待查询 | 批量汇总；占位符 `{n}` |
| 222 | `batch.summary.restart` | {n} 家待重启 | {n} restart required | 待改造 | {n} 个待重启 | 批量汇总；占位符 `{n}` |
| 223 | `batch.summary.failed` | {n} 家失败 | {n} failed | 待改造 | {n} 个失败 | 批量汇总；占位符 `{n}` |
| 224 | `batch.summary.skipped` | {n} 家已跳过 | {n} skipped | 待改造 | {n} 个已跳过 | 批量汇总；占位符 `{n}` |
| 225 | `batch.summary.settled` | {n} 家已最新 | {n} up to date | 待改造 | {n} 个已是最新 | 批量汇总；占位符 `{n}` |
| 226 | `batch.summary.empty` | 还没有目标 | No targets yet | 待改造 | 暂无目标 | 批量汇总；无占位符 |
| 227 | `batch.header.title` | 更新档案 | Update archive | 待改造 | 更新档案 | 批量标题；无占位符；主题用语；与现状同（仅确认）；草稿同现状 |
| 228 | `batch.action.check` | 检查更新 | Check for updates | 待改造 | 检查更新 | 批量操作；无占位符；与现状同（仅确认）；草稿同现状 |
| 229 | `batch.action.check-title` | 重新读取批量状态（只读） | Re-read batch status (read-only) | 待改造 | 重新读取批量状态（只读） | 批量操作；无占位符；与现状同（仅确认）；草稿同现状 |
| 230 | `batch.action.install-all` | 全部更新 | Update all | 待改造 | 全部更新 | 批量操作；无占位符；与现状同（仅确认）；草稿同现状 |
| 231 | `batch.action.install-all-title` | 把有新版的几家一次提交；同一会话同一幂等编号 | Submit all updatable plugins at once; one idempotency key per session | 待改造 | 将有更新的插件一次提交；同一会话使用同一幂等编号。 | 批量操作；无占位符 |
| 232 | `batch.action.close` | 关闭 | Close | 待改造 | 关闭 | 批量操作；无占位符；与现状同（仅确认）；草稿同现状 |
| 233 | `batch.action.close-title` | 关闭窗口，批量更新不受影响 | Close the window; batch progress keeps running | 待改造 | 关闭窗口，批量更新不受影响 | 批量操作；无占位符；与现状同（仅确认）；草稿同现状 |
| 234 | `batch.banner.loading` | 正在读取批量更新状态… | Loading batch update status\u2026 | 待改造 | 正在读取批量更新状态… | 批量横幅；无占位符；与现状同（仅确认）；草稿同现状 |
| 235 | `batch.hint.error` | 刚才那次没成功：看下面的红条，照它说的做一次。 | Last run failed: follow the red banner below. | 待改造 | 上次执行失败：请按下方红色横幅提示操作。 | 批量提示；无占位符 |
| 236 | `batch.hint.empty` | 还没有目标：点「检查更新」看看哪几家有新版。 | No targets yet: select \u201CCheck for updates\u201D to see which plugins have updates. | 待改造 | 暂无目标：请选择「检查更新」查看哪些插件有更新。 | 批量提示；无占位符 |
| 237 | `batch.hint.installing-queueable` | 正在安装 {a} 家；还有 {b} 家可以点「加入队列」排队等。 | Installing {a}; {b} more can join the queue. | 待改造 | 正在安装 {a} 个；另有 {b} 个可选择「加入队列」等待。 | 批量提示；占位符 `{a}`,`{b}` |
| 238 | `batch.hint.installing-auto` | 正在安装 {a} 家，安装完自动下一家。 | Installing {a}; the next starts automatically. | 待改造 | 正在安装 {a} 个，完成后自动安装下一项。 | 批量提示；占位符 `{a}` |
| 239 | `batch.hint.failed` | {n} 家安装失败；照下面的失败提示逐家重试。 | {n} failed to install; retry each one from the failure notes below. | 待改造 | {n} 个插件安装失败；请按下方失败提示逐项重试。 | 批量提示；占位符 `{n}` |
| 240 | `batch.hint.updatable` | {n} 家可更新；点「全部更新」一次安装完，也可以逐家点「安装这家」。 | {n} updates available; select \u201CUpdate all\u201D to install at once, or install each one inline. | 待改造 | {n} 个可更新；请选择「全部更新」一次安装完成，也可逐项选择「安装此插件」。 | 批量提示；占位符 `{n}` |
| 241 | `batch.hint.restart` | {n} 家已安装好，重启宿主后生效。 | {n} installed; restart the host to take effect. | 待改造 | {n} 个已安装完成，重启宿主后生效。 | 批量提示；占位符 `{n}` |
| 242 | `batch.hint.pending` | {n} 家还没查过；点「检查更新」查一轮。 | {n} not checked yet; select \u201CCheck for updates\u201D for a round. | 待改造 | {n} 个尚未查询；请选择「检查更新」查询一轮。 | 批量提示；占位符 `{n}` |
| 243 | `batch.hint.done` | 全部已最新，没有要做的。 | All up to date; nothing to do. | 待改造 | 已全部为最新，无需操作。 | 批量提示；无占位符 |
| 244 | `batch.seal.ledger` | 总账 | Ledger | 待改造 | 总账 | 批量印章；无占位符；主题用语；与现状同（仅确认）；草稿同现状 |
| 245 | `batch.banner.error-title` | 这次没成功（{code}）：{detail}。 | Failed this time ({code}): {detail}. | 待改造 | 本次执行失败（{code}）：{detail}。 | 批量横幅；占位符 `{code}`,`{detail}` |
| 246 | `batch.banner.error-action-fallback` | 请重试一次；若持续，请提交诊断信息至插件作者。 | Retry once first; if it persists, send the copied diagnostics to the plugin author. | 已改造(#101) | —（保持现状） | 批量横幅；无占位符 |
| 247 | `batch.banner.failed-title` | {n} 家安装失败。 | {n} failed to install. | 待改造 | {n} 个插件安装失败。 | 批量横幅；占位符 `{n}` |
| 248 | `batch.banner.failed-action` | 请逐家使用行内「重试」；若持续，请提交诊断信息至插件作者。 | Retry each one inline; if it keeps failing, send the copied diagnostics to the plugin author. | 已改造(#101) | —（保持现状） | 批量横幅；无占位符 |
| 249 | `batch.banner.restart-title` | {n} 家已安装好，重启宿主后生效。 | {n} installed; restart the host to take effect. | 待改造 | {n} 个已安装完成，重启宿主后生效。 | 批量横幅；占位符 `{n}` |
| 250 | `batch.banner.restart-action` | 重启宿主以加载新版本；此为正常状态，非安装失败。 | Restart the host to run the new version; this is a normal end state, not a failure. | 已改造(#101) | —（保持现状） | 批量横幅；无占位符 |
| 251 | `batch.banner.restart-button` | 请重启DSH | Please restart DSH | 待改造 | 请重启DSH | 批量横幅；无占位符；与现状同（仅确认）；草稿同现状 |
| 252 | `batch.row.queued-generic` | 已排队 \u00b7 等前面安装完 | Queued \u00b7 waiting for the running install to finish | 待改造 | 已排队 · 等待前方安装完成 | 批量行；无占位符 |
| 253 | `batch.row.queued-n` | 已排队 \u00b7 前方 {n} 个 | Queued \u00b7 {n} ahead | 待改造 | 已排队 · 前方还有 {n} 项 | 批量行；占位符 `{n}` |
| 254 | `batch.row.skipped` | 已跳过 {version} | Skipped {version} | 待改造 | 已跳过版本 {version} | 批量行；占位符 `{version}` |
| 255 | `batch.row.wait-turn` | 等它，轮到就自动查新版 | Waiting for its turn; it will check automatically | 待改造 | 请等待，轮到将自动查询版本信息。 | 批量行；无占位符 |
| 256 | `batch.row.checking` | 正在查新版，稍等 | Checking for updates; please wait | 待改造 | 正在查询版本信息，请稍候。 | 批量行；无占位符 |
| 257 | `batch.row.cta-version` | 点\u300c安装这家\u300d安装 {version} | Select \u201cInstall this plugin\u201d to install {version} | 待改造 | 选择「安装此插件」安装 {version} | 批量行；占位符 `{version}` |
| 258 | `batch.row.cta-generic` | 点\u300c安装这家\u300d安装新版 | Select \u201cInstall this plugin\u201d to install the new version | 待改造 | 选择「安装此插件」安装新版本 | 批量行；无占位符 |
| 259 | `batch.row.installing` | 正在安装，别动 | Installing; please wait | 待改造 | 正在安装，请勿操作。 | 批量行；无占位符 |
| 260 | `batch.row.done-restart` | 安装好了，重启宿主才生效 | Installed; restart the host to take effect | 待改造 | 已安装完成，重启宿主后生效。 | 批量行；无占位符 |
| 261 | `batch.row.done` | 安装好了，不用动 | Installed; nothing to do | 待改造 | 已安装完成，无需操作。 | 批量行；无占位符 |
| 262 | `batch.row.failed-retry` | 安装没成功，点\u300c重试\u300d再来一次 | Install failed; select \u201cRetry\u201d to try again | 待改造 | 安装失败，请选择「重试」。 | 批量行；无占位符 |
| 263 | `batch.row.skipped-idle` | 这一版已跳过，不用动 | This version is skipped; nothing to do | 待改造 | 该版本已跳过，无需操作。 | 批量行；无占位符 |
| 264 | `batch.row.unknown` | 状态认不出，点\u300c检查更新\u300d重查一次 | Unknown state; select \u201cCheck for updates\u201d to check again | 待改造 | 状态无法识别，请选择「检查更新」重新查询。 | 批量行；无占位符 |
| 265 | `batch.row-action.installing` | 安装中\u2026 | Installing\u2026 | 待改造 | 正在安装… | 批量行动作；无占位符 |
| 266 | `batch.row-action.cancel-queue` | 取消排队 | Cancel queue | 待改造 | 取消排队 | 批量行动作；无占位符；与现状同（仅确认）；草稿同现状 |
| 267 | `batch.row-action.queue` | 加入队列 | Join queue | 待改造 | 加入队列 | 批量行动作；无占位符；与现状同（仅确认）；草稿同现状 |
| 268 | `batch.row-action.install-row` | 安装这家 | Install this plugin | 待改造 | 安装此插件 | 批量行动作；无占位符 |
| 269 | `batch.row-action.retry` | 重试 | Retry | 待改造 | 重试 | 批量行动作；无占位符；与现状同（仅确认）；草稿同现状 |
| 270 | `batch.row-action.install-version` | 安装 {version} | Install {version} | 待改造 | 安装版本 {version} | 批量行动作；占位符 `{version}` |
| 271 | `batch.row-action.install-generic` | 安装 新版 | Install the new version | 待改造 | 安装新版本 | 批量行动作；无占位符 |
| 272 | `batch.row-action.unskip` | 恢复（{version}） | Restore ({version}) | 待改造 | 恢复提醒（{version}） | 批量行动作；占位符 `{version}` |
| 273 | `batch.row-action.restart` | 请重启DSH | Please restart DSH | 待改造 | 请重启DSH | 批量行动作；无占位符；与现状同（仅确认）；草稿同现状 |
| 274 | `batch.row-action.show-detail` | 详情 | Details | 待改造 | 详情 | 批量行动作；无占位符；与现状同（仅确认）；草稿同现状 |
| 275 | `batch.row-action.hide-detail` | 收起 | Collapse | 待改造 | 收起 | 批量行动作；无占位符；与现状同（仅确认）；草稿同现状 |
| 276 | `batch.row-action.skip` | 跳过这一版 | Skip this version | 待改造 | 跳过该版本 | 批量行动作；无占位符 |
| 277 | `batch.row-action.copy-manual` | 复制手工命令 | Copy manual command | 待改造 | 复制手工命令 | 批量行动作；无占位符；与现状同（仅确认）；草稿同现状 |
| 278 | `batch.row-action.copy-diag` | 复制诊断 | Copy diagnostics | 待改造 | 复制诊断 | 批量行动作；无占位符；与现状同（仅确认）；草稿同现状 |
| 279 | `batch.row.error-label` | 失败 {code}：{detail} | Failed {code}: {detail} | 待改造 | 失败 {code}：{detail} | 批量行；占位符 `{code}`,`{detail}`；与现状同（仅确认）；草稿同现状 |
| 280 | `batch.diag.source-job` | （来源：后台任务收尾记录） | (Source: background job record) | 待改造 | （来源：后台任务执行记录） | 批量诊断；无占位符 |
| 281 | `batch.toast.copy-fail` | 复制失败，请手动选中上面的信息。 | Copy failed; please select the info above manually. | 待改造 | 复制失败，请手动选择上方信息。 | 批量轻提示；无占位符 |
| 282 | `batch.toast.queue-missed` | 前面还在装：这一家还没排上，等那家装完再点一次。 | Another install is running: this plugin is not queued yet; try again after it finishes. | 待改造 | 前方仍在安装：此插件尚未排队，请待前方安装完成后再次选择。 | 批量轻提示；无占位符 |
| 283 | `batch.toast.skipped` | 已跳过 {version}：这一版不再提醒；点\u300c恢复\u300d可撤销。 | Skipped {version}: no further reminders for this version; select \u201cRestore\u201d to undo. | 待改造 | 已跳过版本 {version}：该版本不再提醒；选择「恢复提醒」可撤销。 | 批量轻提示；占位符 `{version}` |
| 284 | `batch.toast.unskipped-version` | 已恢复 {version}：这一版会照常提醒。 | Restored {version}: reminders for this version are back on. | 待改造 | 已恢复 {version}：该版本将正常提醒。 | 批量轻提示；占位符 `{version}` |
| 285 | `batch.toast.unskipped-all` | 已恢复跳过提醒。 | Skip reminder restored. | 待改造 | 已恢复跳过提醒。 | 批量轻提示；无占位符；与现状同（仅确认）；草稿同现状 |
| 286 | `batch.toast.cancel-unavailable` | 这一行没带取消排队要用的电话名或编号，暂不能取消：等下一次刷新再看。 | This row carries no phone or ID to cancel the queue; try again after the next refresh. | 待改造 | 此行缺少取消排队所需的信息，暂无法取消；请待下次刷新后重试。 | 批量轻提示；无占位符 |
| 287 | `batch.toast.cancel-ok` | 已取消排队：这一家不等了。 | Queue cancelled: this plugin will not wait. | 待改造 | 已取消排队：此插件将不再等待。 | 批量轻提示；无占位符 |
| 288 | `batch.toast.cancel-fail` | 取消排队没成功（可能已经开始装了）：看下面最新状态。 | Could not cancel the queue (it may have started installing); see the latest state below. | 待改造 | 取消排队失败（可能已开始安装）：请查看下方最新状态。 | 批量轻提示；无占位符 |
| 289 | `batch.toast.copy-manual-ok` | 手工命令已复制，粘到终端整行执行即可。 | Manual command copied; paste the full line into the terminal to run it. | 待改造 | 手工命令已复制，请粘贴至终端整行执行。 | 批量轻提示；无占位符 |
| 290 | `batch.toast.copy-diag-ok` | 诊断已复制，直接粘给插件作者即可（已脱敏）。 | Diagnostics copied; paste it to the plugin author (already redacted). | 待改造 | 诊断信息已复制，请提交至插件作者（已脱敏）。 | 批量轻提示；无占位符 |
| 291 | `batch.toast.restart-delegated` | 已按调用方的重启流程处理；重启后新版生效。 | Handled by the caller\u2019s restart flow; the new version takes effect after restart. | 待改造 | 已按调用方重启流程处理；重启后新版本生效。 | 批量轻提示；无占位符 |
| 292 | `batch.toast.restart-manual` | 本宿主未提供重启入口：请手动重启宿主，重启后新版生效。 | This host provides no restart entry; please restart the host manually. The new version takes effect after restart. | 待改造 | 本宿主未提供重启入口，请手动重启宿主；重启后新版本生效。 | 批量轻提示；无占位符 |
| 293 | `batch.toast.restart-failed` | 重启入口调用失败：请手动重启宿主，重启后新版生效。 | Restart entry failed; please restart the host manually. The new version takes effect after restart. | 待改造 | 重启入口调用失败，请手动重启宿主；重启后新版本生效。 | 批量轻提示；无占位符 |
| 294 | `changelog.neutral.hint` | 作者未提供更新说明 | No changelog provided | 待改造 | 作者未提供更新说明 | 更新日志运行时；无占位符；与现状同（仅确认）；草稿同现状 |
| 295 | `changelog.neutral.line` | 作者未提供更新说明，安装不受影响。 | No changelog provided. Install is not affected. | 待改造 | 作者未提供更新说明，安装不受影响。 | 更新日志运行时；无占位符；与现状同（仅确认）；草稿同现状 |
| 296 | `changelog.breaking.badge` | 不兼容 | Breaking | 待改造 | 不兼容 | 更新日志运行时；无占位符；与现状同（仅确认）；草稿同现状 |
| 297 | `changelog.breaking.aria` | 破坏性变更 | Breaking change | 待改造 | 破坏性变更 | 更新日志运行时；无占位符；与现状同（仅确认）；草稿同现状 |
| 298 | `changelog.truncated.count` | 共 {m} 条，仅显示前 {n} 条 | Showing {n} of {m} items | 待改造 | 共 {m} 条，仅显示前 {n} 条 | 更新日志运行时；占位符 `{m}`,`{n}`；与现状同（仅确认）；草稿同现状 |
| 299 | `changelog.yanked.banner` | 目标版本 {version} 已被作者撤回（yanked），安装不受影响，继续前请确认。 | Version {version} was yanked by the author. Install is not affected. Please confirm before proceeding. | 待改造 | 目标版本 {version} 已被作者撤回（yanked），安装不受影响，继续前请确认。 | 更新日志运行时；占位符 `{version}`；与现状同（仅确认）；草稿同现状 |
| 300 | `changelog.yanked.suffix` |  · 已撤回 |  · Yanked | 待改造 |  · 已撤回 | 更新日志运行时；无占位符；与现状同（仅确认）；草稿同现状 |
| 301 | `changelog.security.summary` | 其余 {n} 条 | {n} more items | 待改造 | 其余 {n} 条 | 更新日志运行时；占位符 `{n}`；与现状同（仅确认）；草稿同现状 |
| 302 | `changelog.security.note` | 为保持面板性能，其余条目已折叠，可查看原文。 | Remaining entries are collapsed to keep the panel fast. See the original text. | 待改造 | 为保持面板性能，其余条目已折叠，请查看原文。 | 更新日志运行时；无占位符 |
| 303 | `diag.fallback.generic` | 操作失败 | Operation failed | 待改造 | 操作失败 | 诊断兜底短语；无占位符；与现状同（仅确认）；草稿同现状 |
| 304 | `diag.fallback.read-installed` | 读取本地状态失败 | Failed to read local state | 已改造(#101) | —（保持现状） | 诊断兜底短语；无占位符 |
| 305 | `diag.fallback.revalidate-fetch` | 安装前复验失败，未能获取版本信息 | Revalidation fetch failed before install | 已改造(#101) | —（保持现状） | 诊断兜底短语；无占位符 |
| 306 | `diag.fallback.rate-limited` | 源返回 429，这一分钟请求太多 | Source returned 429. Too many requests this minute. | 待改造 | 数据源返回 429，本分钟请求过于频繁。 | 诊断兜底短语；无占位符 |
| 307 | `diag.fallback.http-status` | 源返回 {status}，重试仍失败 | Source returned {status}. Retry still failed. | 待改造 | 数据源返回 {status}，重试后仍失败。 | 诊断兜底短语；占位符 `{status}` |
| 308 | `diag.fallback.invalid-release` | 清单文件中版本号非法 | Version in the manifest is not valid | 已改造(#101) | —（保持现状） | 诊断兜底短语；无占位符 |
| 309 | `diag.fallback.install-failed` | 安装执行失败 | Install failed | 已改造(#101) | —（保持现状） | 诊断兜底短语；无占位符 |
| 310 | `diag.fallback.unknown-profile` | 无法识别使用范围或插件安装位置 | Scope or plugin location not recognized | 已改造(#101) | —（保持现状） | 诊断兜底短语；无占位符 |
| 311 | `diag.fallback.channel-mismatch` | 已安装版本与当前版本通道不符 | Installed version is not in the selected release channel | 已改造(#101) | —（保持现状） | 诊断兜底短语；无占位符 |
| 312 | `diag.fallback.source-install` | 源码安装实例，不支持版本更新 | Installed from source, not by version | 已改造(#101) | —（保持现状） | 诊断兜底短语；无占位符 |
| 313 | `diag.fallback.invalid-installation` | 已安装包结构不完整 | Installed package is incomplete | 已改造(#101) | —（保持现状） | 诊断兜底短语；无占位符 |
| 314 | `diag.fallback.installation-changed` | 安装位置发生变更 | Install location changed during use | 已改造(#101) | —（保持现状） | 诊断兜底短语；无占位符 |
| 315 | `diag.fallback.pending-restart` | 新版本已写入磁盘，当前运行仍为旧版本 | New version is on disk. The running version is still the old one. | 已改造(#101) | —（保持现状） | 诊断兜底短语；无占位符 |
| 316 | `diag.fallback.incompatible-node` | Node 运行时版本不兼容 | New version needs a different Node version than the running one | 已改造(#101) | —（保持现状） | 诊断兜底短语；无占位符 |
| 317 | `diag.fallback.registry-conflict` | 版本声明与磁盘实际版本冲突 | Declared version conflicts with the on-disk version | 已改造(#101) | —（保持现状） | 诊断兜底短语；无占位符 |
| 318 | `diag.fallback.recovery-required` | 上次安装异常中断，存在未完成任务 | Last install was interrupted, leaving a partial task | 已改造(#101) | —（保持现状） | 诊断兜底短语；无占位符 |
