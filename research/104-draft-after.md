# 改造后草稿（只列有变化的 148 条，Q2/Q3 已计入）

> Q2（失败印章→“失败”）、Q3（版本条三词）已接受并计入下表。标 [Q1] 的 29 条含“家→个/项/此插件”，待你拍板；其余 119 条为去口语常规改法。与现状逐字相同的未列出（见全量表）。`en`/`key`/占位符不动。

## 入口按钮（3 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 1 | `entry.label.failed` | 更新失败，点此查看 | 更新失败，请查看详情 |
| 2 | `entry.label.has-update` | 有新版 {version} | 有新版本 {version} |
| 3 | `entry.action.checking` | 正在查新版… | 正在查询版本信息… |

## 批量入口（4 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 4 | `batch-entry.label.update` [Q1] | {count} 家可更新 | {count} 个可更新 |
| 5 | `batch-entry.label.restart` [Q1] | {count} 家待重启 | {count} 个待重启 |
| 6 | `batch-entry.label.failed` [Q1] | {count} 家失败，点此查看 | {count} 个失败，请查看详情 |
| 7 | `batch-entry.action.checking` | 正在查新版… | 正在查询版本信息… |

## 印章（3 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 8 | `panel.seal.update.text` | 可装 | 可更新 |
| 9 | `panel.seal.failed.text` | 受阻 | 失败 |
| 10 | `panel.seal.done.text` | 已最新 | 已是最新 |

## 顶部横幅（5 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 11 | `panel.banner.error.action-fallback` | 复制诊断发给插件作者；深挖看日志通道。 | 请复制诊断信息提交至插件作者；详情请查看日志通道。 |
| 12 | `panel.banner.restart-title` | 新版 {latest} 已安装，重启宿主后生效。 | 新版本 {latest} 已安装，重启宿主后生效。 |
| 13 | `panel.banner.installing-action` | 进度按轮询自动刷新；重开面板 1 秒内恢复显示。 | 进度将自动轮询刷新；重新打开面板将在 1 秒内恢复显示。 |
| 14 | `panel.banner.update-title` | 有新版 {latest} 可装（当前 {running}）。 | 有新版本 {latest} 可安装（当前版本 {running}）。 |
| 15 | `panel.banner.update-action` | 点安装即走精确版本安装；同一使用范围同时只装一个。 | 选择安装将按精确版本安装；同一使用范围同时仅安装一项。 |

## 操作按钮（15 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 16 | `panel.action.installing` | 安装中… | 正在安装… |
| 17 | `panel.action.install-version` | 安装 {latest} | 安装版本 {latest} |
| 18 | `panel.action.check` | 查新版 | 检查更新 |
| 19 | `panel.action.check-title` | 重新向官方源查一次新版（只读，不安装） | 重新向官方源查询版本信息（只读，不安装） |
| 20 | `panel.action.checking-busy` | 正在查新版… | 正在查询版本信息… |
| 21 | `panel.action.checking-busy-title` | 正在向官方源查询，请稍候 | 正在向官方源查询版本信息，请稍候 |
| 22 | `panel.action.install-title` | 用精确版本安装；同一使用范围同时只装一个 | 按精确版本安装；同一使用范围同时仅安装一项 |
| 23 | `panel.action.skip-title` | 该版本不再提醒；有更新的新版本照常提醒 | 该版本将不再提醒；更新的版本仍会正常提醒 |
| 24 | `panel.action.unskip` | 恢复（{version}） | 恢复提醒（{version}） |
| 25 | `panel.action.unskip-title` | 撤销跳过，该版本重新提醒 | 撤销跳过，该版本将重新提醒 |
| 26 | `panel.action.copy-manual-title` | 复制手工命令，粘到终端整行执行 | 复制手工命令，请粘贴至终端整行执行 |
| 27 | `panel.action.restart-host-title` | 点一下走调用方流程，没有就手动重启 DSH | 优先走调用方重启流程；若无，请手动重启 DSH |
| 28 | `panel.action.dismiss` | 知道了 | 已知晓 |
| 29 | `panel.action.dismiss-title` | 确认已知晓该失败：回到可装页，下次查/装将重新评估 | 确认已知晓该失败：返回可安装页，下次查询或安装将重新评估 |
| 30 | `panel.action.copy-diag-title` | 复制已脱敏诊断，直接粘给插件作者 | 复制已脱敏诊断，请提交至插件作者 |

## 轻提示（10 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 31 | `panel.toast.checking` | 正在查新版… | 正在查询版本信息… |
| 32 | `panel.toast.copy-manual-ok` | 手工命令已复制，粘到终端整行执行即可。 | 手工命令已复制，请粘贴至终端整行执行。 |
| 33 | `panel.toast.copy-manual-fail` | 复制失败，请手动选中上面的命令。 | 复制失败，请手动选择上方命令。 |
| 34 | `panel.toast.copy-diag-ok` | 诊断已复制，直接粘给插件作者即可（已脱敏）。 | 诊断信息已复制，请提交至插件作者（已脱敏）。 |
| 35 | `panel.toast.copy-diag-fail` | 复制失败，请手动选中上面的信息。 | 复制失败，请手动选择上方信息。 |
| 36 | `panel.toast.restart-delegated` | 已按调用方的重启流程处理；重启后新版生效。 | 已按调用方重启流程处理；重启后新版本生效。 |
| 37 | `panel.toast.restart-manual` | 本宿主未提供重启入口：请手动重启宿主，重启后新版生效。 | 本宿主未提供重启入口，请手动重启宿主；重启后新版本生效。 |
| 38 | `panel.toast.restart-failed` | 重启入口调用失败：请手动重启宿主，重启后新版生效。 | 重启入口调用失败，请手动重启宿主；重启后新版本生效。 |
| 39 | `panel.toast.copy-state-ok` | 已复制当前状态（无失败），直接粘给插件作者即可（已脱敏）。 | 当前状态已复制（无失败），请提交至插件作者（已脱敏）。 |
| 40 | `panel.toast.failure-dismissed` | 已确认该失败提示；下次查新版或安装将重新评估。 | 已确认该失败提示；下次查询版本信息或安装将重新评估。 |

## 版本条（3 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 41 | `panel.strip.running` | 运行 | 运行版 |
| 42 | `panel.strip.installed` | 磁盘 | 已安装 |
| 43 | `panel.strip.latest` | 远端 | 最新版 |

## 进度（1 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 44 | `panel.progress.installing` | 正在安装新版… | 正在安装新版本… |

## 队列（11 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 45 | `panel.queue.busy-self` | 正在安装（本插件在装）。 | 本插件正在安装。 |
| 46 | `panel.queue.busy-queued` | 前方有安装在进行，本插件排第 {n} 位，到队首再点安装。 | 前方有安装正在进行，本插件排第 {n} 位；到队首后请选择安装。 |
| 47 | `panel.queue.busy-other` | 前方有其他插件在安装，稍后重试。 | 前方有其他插件正在安装，请稍后重试。 |
| 48 | `panel.queue.pos-n` | 第 {n} 位 | 排队第 {n} 位 |
| 49 | `panel.queue.pos-next` | 下一个就是你 | 下一位就是你 |
| 50 | `panel.queue.pos-ahead` | 前方 {n} 个 | 前方还有 {n} 项 |
| 51 | `panel.queue.row-installing-note` | 装完自动轮到你 | 安装完成后自动轮到你 |
| 52 | `panel.queue.row-idle-note` | 同一使用范围一次只装一个 | 同一使用范围同时仅安装一项 |
| 53 | `panel.queue.row-position` | 你的顺位 | 你的排队顺位 |
| 54 | `panel.queue.toggle-hide` | 隐藏他人明细 | 隐藏其他插件明细 |
| 55 | `panel.queue.empty` | 当前没有排队任务，同一使用范围一次只装一个。 | 当前无排队任务；同一使用范围同时仅安装一项。 |

## 错误详情卷宗（9 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 56 | `panel.error.code-note` | 上一条中文说明就是要用户做的事；要往上游报，用「复制诊断」整段粘（已脱敏）。 | 上方中文说明即需执行的操作；如需向上游反馈，请使用「复制诊断」整段粘贴（已脱敏）。 |
| 57 | `panel.error.failed-at` | 失败于 {time} | 失败时间 {time} |
| 58 | `panel.error.query-keys` | 本次查询键：{keys}（拿着它们去日志里对）。 | 本次查询键：{keys}（可凭此在日志中检索匹配）。 |
| 59 | `panel.error.target-version` | 失败目标 {version} | 失败目标版本 {version} |
| 60 | `panel.error.evidence-frozen` | 证据已冻结：复制诊断里的码、版本、编号都取自失败时刻，不随轮询刷新；下一次查新版或安装会更新它。 | 证据已冻结：复制诊断中的稳定码、版本与编号均取自失败时刻，不随轮询刷新；下次查询版本信息或安装将更新。 |
| 61 | `panel.error.evidence-transient` | 读数瞬态失败：下一次成功读数会自动解除；一直出现再按稳定码排查。 | 瞬态读取失败：下次成功读取将自动解除；若持续出现，请按稳定码排查。 |
| 62 | `panel.error.no-failure` | 暂无失败：此时复制诊断给出的是当前状态快照。 | 暂无失败：此时复制诊断提供的是当前状态快照。 |
| 63 | `panel.error.log-hint` | 深挖看日志：按插件标识 {pluginId} 过滤 {e1}、{e2}、{e3} 三个事件。 | 请查看日志：按插件标识 {pluginId} 筛选 {e1}、{e2}、{e3} 事件。 |
| 64 | `panel.error.log-follow` | 凭上面的请求／检查编号在 {eFail} 里对上；基线耗时看 {eCall}，执行结果看 {eExec}。 | 凭上方请求／检查编号在 {eFail} 中匹配；基线耗时请查看 {eCall}，执行结果请查看 {eExec}。 |

## 手工命令（1 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 65 | `panel.manual.heading` | 手工兜底命令（复制整行执行）： | 手工备用命令（请复制整行执行）： |

## 底部（1 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 66 | `panel.footer.note` | 关闭不影响更新，可随时回来查看 | 关闭窗口，更新不受影响，可随时返回查看。 |

## 诊断复制（5 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 67 | `panel.diag.label.installed` | 已装：{version} | 已安装：{version} |
| 68 | `panel.diag.label.latest` | 远端：{version} | 最新版：{version} |
| 69 | `panel.diag.queue.absent` | 不在队列里 | 未排队 |
| 70 | `panel.diag.copy.no-detail` | （本回包没有带诊断摘要，等电话侧 diag 落定后补齐） | （本响应未携带诊断摘要，待诊断信息就绪后补全） |
| 71 | `panel.diag.copy.unknown-package` | (未知包) | （未知插件包） |

## 跳过（4 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 72 | `panel.skip.skipped-title` | 已跳过 {latest} | 已跳过版本 {latest} |
| 73 | `panel.skip.skipped-action` | 点“恢复”可重新提醒该版本；有更新的新版本会照常提醒。 | 选择「恢复提醒」可重新提醒该版本；更新的版本仍会正常提醒。 |
| 74 | `panel.skip.line-tag` | 已跳过 {version} | 已跳过版本 {version} |
| 75 | `panel.skip.line-note` | 点「恢复」可撤销，之后这一版还会再提醒。 | 选择「恢复提醒」可撤销，该版本此后仍会提醒。 |

## 更新日志（2 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 76 | `panel.changelog.unavailable` | 日志读不出来，安装不受影响。 | 更新日志无法读取，安装不受影响。 |
| 77 | `panel.changelog.unavailable-empty` | 还没查到新版；查到后再显示日志。 | 尚未查询到新版本；查询到后将显示更新日志。 |

## 批量操作（4 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 78 | `batch.action.resume` [Q1] | 继续上次未完成的更新（还剩 {count} 家） | 继续上次未完成的更新（剩余 {count} 个）。 |
| 79 | `batch.action.resume-title` | 从上次没做完的地方接着安装，已完成的不重装 | 从上次中断处继续安装，已完成的不会重复安装。 |
| 80 | `batch.action.discard` | 丢弃这批未完成的更新（已完成的保留） | 丢弃本批未完成的更新（已完成的将保留）。 |
| 81 | `batch.action.install-all-title` [Q1] | 把有新版的几家一次提交；同一会话同一幂等编号 | 将有更新的插件一次提交；同一会话使用同一幂等编号。 |

## 批量横幅（3 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 82 | `batch.banner.error-title` | 这次没成功（{code}）：{detail}。 | 本次执行失败（{code}）：{detail}。 |
| 83 | `batch.banner.failed-title` [Q1] | {n} 家安装失败。 | {n} 个插件安装失败。 |
| 84 | `batch.banner.restart-title` [Q1] | {n} 家已安装好，重启宿主后生效。 | {n} 个已安装完成，重启宿主后生效。 |

## 批量诊断（1 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 85 | `batch.diag.source-job` | （来源：后台任务收尾记录） | （来源：后台任务执行记录） |

## 批量事实提示（1 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 86 | `batch.fact.close-safe` | 关掉面板不会中断：进度已写盘，回来可继续。 | 关闭面板不会中断更新：进度已保存，可随时返回继续。 |

## 批量提示（9 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 87 | `batch.hint.error` | 刚才那次没成功：看下面的红条，照它说的做一次。 | 上次执行失败：请按下方红色横幅提示操作。 |
| 88 | `batch.hint.empty` [Q1] | 还没有目标：点「检查更新」看看哪几家有新版。 | 暂无目标：请选择「检查更新」查看哪些插件有更新。 |
| 89 | `batch.hint.installing-queueable` [Q1] | 正在安装 {a} 家；还有 {b} 家可以点「加入队列」排队等。 | 正在安装 {a} 个；另有 {b} 个可选择「加入队列」等待。 |
| 90 | `batch.hint.installing-auto` [Q1] | 正在安装 {a} 家，安装完自动下一家。 | 正在安装 {a} 个，完成后自动安装下一项。 |
| 91 | `batch.hint.failed` [Q1] | {n} 家安装失败；照下面的失败提示逐家重试。 | {n} 个插件安装失败；请按下方失败提示逐项重试。 |
| 92 | `batch.hint.updatable` [Q1] | {n} 家可更新；点「全部更新」一次安装完，也可以逐家点「安装这家」。 | {n} 个可更新；请选择「全部更新」一次安装完成，也可逐项选择「安装此插件」。 |
| 93 | `batch.hint.restart` [Q1] | {n} 家已安装好，重启宿主后生效。 | {n} 个已安装完成，重启宿主后生效。 |
| 94 | `batch.hint.pending` [Q1] | {n} 家还没查过；点「检查更新」查一轮。 | {n} 个尚未查询；请选择「检查更新」查询一轮。 |
| 95 | `batch.hint.done` | 全部已最新，没有要做的。 | 已全部为最新，无需操作。 |

## 批量通知（6 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 96 | `batch.notice.auto-resumed` [Q1] | 已自动继续上次未完成的更新（还剩 {count} 家）。 | 已自动继续上次未完成的更新（剩余 {count} 个）。 |
| 97 | `batch.notice.resumed` [Q1] | 已继续上次未完成的更新（还剩 {count} 家）。 | 已继续上次未完成的更新（剩余 {count} 个）。 |
| 98 | `batch.notice.no-resume` | 没有可继续的内容。 | 暂无可继续的内容。 |
| 99 | `batch.notice.discarded` | 已丢弃这批未完成的更新（已完成的保留）。 | 已丢弃本批未完成的更新（已完成的将保留）。 |
| 100 | `batch.notice.cancel-confirm` | 再点一次确认丢弃。 | 请再次选择以确认丢弃。 |
| 101 | `batch.notice.busy-cancel` [Q1] | 正在装的那一家停不了。 | 正在安装的项无法停止。 |

## 批量行动作（6 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 102 | `batch.row-action.installing` | 安装中\u2026 | 正在安装… |
| 103 | `batch.row-action.install-row` [Q1] | 安装这家 | 安装此插件 |
| 104 | `batch.row-action.install-version` | 安装 {version} | 安装版本 {version} |
| 105 | `batch.row-action.install-generic` | 安装 新版 | 安装新版本 |
| 106 | `batch.row-action.unskip` | 恢复（{version}） | 恢复提醒（{version}） |
| 107 | `batch.row-action.skip` | 跳过这一版 | 跳过该版本 |

## 批量行（18 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 108 | `batch.row.update` | 有新版 {version} | 有新版本 {version} |
| 109 | `batch.row.current` | 已是最新，不用动 | 已是最新，无需操作。 |
| 110 | `batch.row.never` | 还没查过 | 尚未查询 |
| 111 | `batch.row.failed` | 这次没查到 | 本次未能查询 |
| 112 | `batch.row.unfinished-tag` | 上一批没做完 | 上次未完成 |
| 113 | `batch.row.queued-generic` | 已排队 \u00b7 等前面安装完 | 已排队 · 等待前方安装完成 |
| 114 | `batch.row.queued-n` | 已排队 \u00b7 前方 {n} 个 | 已排队 · 前方还有 {n} 项 |
| 115 | `batch.row.skipped` | 已跳过 {version} | 已跳过版本 {version} |
| 116 | `batch.row.wait-turn` | 等它，轮到就自动查新版 | 请等待，轮到将自动查询版本信息。 |
| 117 | `batch.row.checking` | 正在查新版，稍等 | 正在查询版本信息，请稍候。 |
| 118 | `batch.row.cta-version` [Q1] | 点\u300c安装这家\u300d安装 {version} | 选择「安装此插件」安装 {version} |
| 119 | `batch.row.cta-generic` [Q1] | 点\u300c安装这家\u300d安装新版 | 选择「安装此插件」安装新版本 |
| 120 | `batch.row.installing` | 正在安装，别动 | 正在安装，请勿操作。 |
| 121 | `batch.row.done-restart` | 安装好了，重启宿主才生效 | 已安装完成，重启宿主后生效。 |
| 122 | `batch.row.done` | 安装好了，不用动 | 已安装完成，无需操作。 |
| 123 | `batch.row.failed-retry` | 安装没成功，点\u300c重试\u300d再来一次 | 安装失败，请选择「重试」。 |
| 124 | `batch.row.skipped-idle` | 这一版已跳过，不用动 | 该版本已跳过，无需操作。 |
| 125 | `batch.row.unknown` | 状态认不出，点\u300c检查更新\u300d重查一次 | 状态无法识别，请选择「检查更新」重新查询。 |

## 批量汇总（8 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 126 | `batch.summary.updatable` [Q1] | {n} 家可更新 | {n} 个可更新 |
| 127 | `batch.summary.installing` [Q1] | {n} 家安装中 | {n} 个安装中 |
| 128 | `batch.summary.pending` [Q1] | {n} 家待查 | {n} 个待查询 |
| 129 | `batch.summary.restart` [Q1] | {n} 家待重启 | {n} 个待重启 |
| 130 | `batch.summary.failed` [Q1] | {n} 家失败 | {n} 个失败 |
| 131 | `batch.summary.skipped` [Q1] | {n} 家已跳过 | {n} 个已跳过 |
| 132 | `batch.summary.settled` [Q1] | {n} 家已最新 | {n} 个已是最新 |
| 133 | `batch.summary.empty` | 还没有目标 | 暂无目标 |

## 批量轻提示（12 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 134 | `batch.toast.copy-fail` | 复制失败，请手动选中上面的信息。 | 复制失败，请手动选择上方信息。 |
| 135 | `batch.toast.queue-missed` [Q1] | 前面还在装：这一家还没排上，等那家装完再点一次。 | 前方仍在安装：此插件尚未排队，请待前方安装完成后再次选择。 |
| 136 | `batch.toast.skipped` | 已跳过 {version}：这一版不再提醒；点\u300c恢复\u300d可撤销。 | 已跳过版本 {version}：该版本不再提醒；选择「恢复提醒」可撤销。 |
| 137 | `batch.toast.unskipped-version` | 已恢复 {version}：这一版会照常提醒。 | 已恢复 {version}：该版本将正常提醒。 |
| 138 | `batch.toast.cancel-unavailable` | 这一行没带取消排队要用的电话名或编号，暂不能取消：等下一次刷新再看。 | 此行缺少取消排队所需的信息，暂无法取消；请待下次刷新后重试。 |
| 139 | `batch.toast.cancel-ok` [Q1] | 已取消排队：这一家不等了。 | 已取消排队：此插件将不再等待。 |
| 140 | `batch.toast.cancel-fail` | 取消排队没成功（可能已经开始装了）：看下面最新状态。 | 取消排队失败（可能已开始安装）：请查看下方最新状态。 |
| 141 | `batch.toast.copy-manual-ok` | 手工命令已复制，粘到终端整行执行即可。 | 手工命令已复制，请粘贴至终端整行执行。 |
| 142 | `batch.toast.copy-diag-ok` | 诊断已复制，直接粘给插件作者即可（已脱敏）。 | 诊断信息已复制，请提交至插件作者（已脱敏）。 |
| 143 | `batch.toast.restart-delegated` | 已按调用方的重启流程处理；重启后新版生效。 | 已按调用方重启流程处理；重启后新版本生效。 |
| 144 | `batch.toast.restart-manual` | 本宿主未提供重启入口：请手动重启宿主，重启后新版生效。 | 本宿主未提供重启入口，请手动重启宿主；重启后新版本生效。 |
| 145 | `batch.toast.restart-failed` | 重启入口调用失败：请手动重启宿主，重启后新版生效。 | 重启入口调用失败，请手动重启宿主；重启后新版本生效。 |

## 更新日志运行时（1 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 146 | `changelog.security.note` | 为保持面板性能，其余条目已折叠，可查看原文。 | 为保持面板性能，其余条目已折叠，请查看原文。 |

## 诊断兜底短语（2 条）

| # | key | 现状 | 改后草稿 |
|---:|---|---|---|
| 147 | `diag.fallback.rate-limited` | 源返回 429，这一分钟请求太多 | 数据源返回 429，本分钟请求过于频繁。 |
| 148 | `diag.fallback.http-status` | 源返回 {status}，重试仍失败 | 数据源返回 {status}，重试后仍失败。 |
