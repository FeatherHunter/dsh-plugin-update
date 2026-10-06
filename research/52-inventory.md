# 52 盘点用户可见文案全量清单（渲染面唯一输入）

票：盘点用户可见文案全量清单（52） 父地图：更新系统双语化（51）
方法：grep 中文全量扫描 22 文件 2231 行，注释 1822，抛错 91，渲染候选 318，剔除开发者断言与 CSS 注释与 CI 校验后得 301 项。行号为 2026-10-06 现场值。
范围：只含渲染面。日志注释抛错只计数不改。
立约：只改用户可见与诊断人话行。注释日志抛错 README 稳定码快照六字段 diag 键名不动。detail 内容不翻译只标签双语。数据层永不拼串，表现层用语义块 lang，英文前中文后，窄处竖排。术语表需评审，无评审标 draft。

## 验收对照
- 清单无漏项：1-7 节共 301 项加第 8 节计数，覆盖七类：entry entry-batch panel panel-batch changelog 诊断复制 阻塞与失败一句话。
- CHANGELOG 六类映射复用说明：见 6.3 节。

命名约定：area.group.name，area 为 entry entry-batch panel panel-batch changelog diag service redaction。英文终稿由 53 术语表锁定，此处只定寻址。

## 1. entry（src/entry.ts，7 项，全双语）

| # | 文件行 | 原文 | key 提案 |
|---|---|---|---|
| E1 | src/entry.ts:109 | 检查更新 | entry.label.idle |
| E2 | src/entry.ts:110 | 更新失败，点此查看 | entry.label.failed |
| E3 | src/entry.ts:111 | 正在安装… | entry.label.busy |
| E4 | src/entry.ts:112 | 待重启 | entry.label.restart |
| E5 | src/entry.ts:151 | 有新版 {latest} | entry.label.has-update |
| E6 | src/entry.ts:313 | 正在查新版… | entry.action.checking |
| E7 | src/entry.ts:453 | 已是最新 {runningVersion} | entry.note.up-to-date |

## 2. entry-batch（src/entry-batch.ts，6 项，全双语）

| # | 文件行 | 原文 | key 提案 |
|---|---|---|---|
| EB1 | src/entry-batch.ts:143 | 检查更新 | entry-batch.label.idle |
| EB2 | src/entry-batch.ts:144 | 正在安装… | entry-batch.label.busy |
| EB3 | src/entry-batch.ts:199 | {n} 家失败，点此查看 / 更新失败，点此查看 | entry-batch.label.failed-count / .failed |
| EB4 | src/entry-batch.ts:202 | {n} 家待重启 | entry-batch.label.restart-count |
| EB5 | src/entry-batch.ts:205 | {n} 家可更新 | entry-batch.label.updatable-count |
| EB6 | src/entry-batch.ts:333 | 正在查新版… | entry-batch.action.checking |

## 3. panel 单插件面板（src/panel.ts，152 项）

### 3.1 阻塞 8 码一句话（167-196，16 条，全双语，README 5.2 为源）

| 码 | title 行 | action 行 | key |
|---|---|---|---|
| unknown-profile | 167 使用范围或插件位置认不出 | 168 重开宿主再查一次；一直这样就把版本号与日志交给插件作者；这种情形不给手工命令 | panel.blocked.unknown-profile.title/action |
| source-install | 171 当前是从源码装的，不是按版本号装的 | 172 这种情形不给手工命令；想走更新先按版本号重装一次 | panel.blocked.source-install.title/action |
| invalid-installation | 175 已装的包不完整（名字对不上、版本非法、入口文件缺失） | 176 重装当前版本，修好已装目录再查更新 | panel.blocked.invalid-installation.title/action |
| installation-changed | 179 安装位置在使用中途变了（换了目录或换了包） | 180 重新打开宿主再查一次；还出现就重装 | panel.blocked.installation-changed.title/action |
| pending-restart | 183 新版已装到磁盘，正在跑的还是旧版 | 184 重启宿主，让新版跑起来；这是正常终态，不是失败 | panel.blocked.pending-restart.title/action |
| registry-conflict | 187 本地声明的版本与磁盘实际版本互相矛盾 | 188 打开使用范围的清单文件，把目标包名那一行改成版本号再试 | panel.blocked.registry-conflict.title/action |
| incompatible-node | 191 新版要求的 Node 与当前运行的对不上 | 192 先升级 Node 到 22 或更高，再查更新 | panel.blocked.incompatible-node.title/action |
| recovery-required | 195 上次安装被打断，留下一个半截任务 | 196 重新点一次安装；一直出现就按第 6 节排错 | panel.blocked.recovery-required.title/action |

### 3.2 电话 5 码加 internal 加未来兜底（218-245，12 条，全双语）

| 码 | zh | act | key |
|---|---|---|---|
| check-failed | 218 查新版没成功（联网、源、限流都可能） | 219 过一会儿再查一次；一直失败就把复制诊断交给插件作者 | panel.failure.check-failed.zh/act |
| invalid-release | 222 拿到的发布信息不合法（版本号非法或内容对不上） | 223 检查清单文件里的包名与版本写法，再查一次 | panel.failure.invalid-release.zh/act |
| check-expired | 226 凭证过期了，安装请求被拒 | 227 重新查一次新版再点安装，不要重试旧编号 | panel.failure.check-expired.zh/act |
| update-busy | 230 同一使用范围正在装另一个 | 231 等当前任务离开 installing/verifying 再点；排队中去查状态看位置 | panel.failure.update-busy.zh/act |
| install-failed | 234 装不上（详见诊断摘要） | 235 先看复制诊断；官方桌面版把这段交给插件作者 | panel.failure.install-failed.zh/act |
| internal | 238 出了点问题，认不出具体原因 | 239 先重试一次；一直这样就把复制诊断交给插件作者 | panel.failure.internal.zh/act |
| unknown 未来码 | 244 同 internal 中文 | 245 先重试一次；一直这样就把复制诊断交给插件作者（带上你看到的码） | panel.failure.unknown.zh/act |

注：8 阻塞行复用 BLOCKED_COPY 原文，底座不另起措辞。14 码判定见 isKnownFailureCode。

### 3.3 诊断复制旧块 buildDiagnosticText（330-351，13 项，标签双语变量不译）

| 文件行 | 原文 | key |
|---|---|---|
| 330 | [更新诊断] {pluginId} 稳定码：{code} | panel.diag.header |
| 332 | 人话：{detail} | panel.diag.label.human |
| 334 | 运行版：{v 或 未知} | panel.diag.label.running |
| 335 | 已装：{v 或 未知} | panel.diag.label.installed |
| 336 | 远端：{v 或 未查过} | panel.diag.label.latest |
| 341 | 正在安装 | panel.diag.queue.installing |
| 343 | 排队第 {n} 位 | panel.diag.queue.position |
| 344 | 不在队列里 | panel.diag.queue.absent |
| 346 | 宿主：{k 或 未知} | panel.diag.label.host |
| 347 | 使用范围：{profile} | panel.diag.label.profile |
| 348 | 队列：{queue} | panel.diag.label.queue |
| 349 | 请求编号：{id} 后缀 | panel.diag.label.request |
| 351 | 手工命令：{manual} | panel.diag.label.manual |

### 3.4 诊断复制新块 buildDiagCopyText（456-509，22 项）

| 文件行 | 原文 | key |
|---|---|---|
| 456 | 正在安装（复用旧块） | 复用 panel.diag.queue.installing |
| 457 | 排队第 {n} 位（复用） | 复用 panel.diag.queue.position |
| 458 | 不在队列里（复用） | 复用 panel.diag.queue.absent |
| 472 | （本回包没有带诊断摘要，等电话侧 diag 落定后补齐） | panel.diag.copy.no-detail |
| 473 | （未知包） | panel.diag.copy.unknown-package |
| 476/485 | 未知（宿主与使用范围缺省共用） | panel.diag.copy.unknown |
| 483 | 插件={p} 版本={r}到{i} 宿主={h} | panel.diag.copy.field.plugin/version/host |
| 485 | 使用范围={p 或 未知} | panel.diag.copy.field.profile |
| 486 | 路由={r} | panel.diag.copy.field.route |
| 487 | 阶段={s} | panel.diag.copy.field.stage（值 6 枚举不译） |
| 488 | 方法={m} | panel.diag.copy.field.method（值 https/fs/phone/spawn/service 不译） |
| 491 | 耗时={n}ms | panel.diag.copy.field.latency |
| 492-493 | 源={h} / 源=未知（非官方源时省略本身即信息） | panel.diag.copy.field.registry / .registry-unknown |
| 494 | 建议={a} | panel.diag.copy.field.action（值 retry/manual/contact/restart 不译） |
| 495 | 请求={id} | panel.diag.copy.field.request |
| 496 | 检查={id} | panel.diag.copy.field.check |
| 497 | 队列={q} | panel.diag.copy.field.queue |
| 501 | [update-diag] code={c} · {zh} · 摘要={d} · {prov} · 怎么办={act} 单行骨架 | panel.diag.copy.line-template |
| 507-509 | 摘要：{d} / 来源：{prov} / 怎么办：{act} 三行块骨架 | panel.diag.copy.block.summary/source/remedy |

顺序码到摘要到来源冻结，怎么办放末尾。缺省即省略，插件版本宿主使用范围队列恒显。

### 3.5 印章 8 档（676-683，全双语，双主题复用）

| 行 | 大印章 | 小印章 | key |
|---|---|---|---|
| 676 loading | 待查 | 查 | panel.seal.loading.text/mini |
| 677 idle | 待查 | 查 | panel.seal.idle.text/mini |
| 678 update | 可装 | 装 | panel.seal.update.text/mini |
| 679 busy | 安装中 | 装 | panel.seal.busy.text/mini |
| 680 restart | 待重启 | 启 | panel.seal.restart.text/mini |
| 681 blocked | 受阻 | 阻 | panel.seal.blocked.text/mini |
| 682 failed | 受阻 | 阻 | panel.seal.failed.text/mini |
| 683 done | 已最新 | 定 | panel.seal.done.text/mini |

### 3.6 视图横幅与安装按钮（723-864，22 项）

| 文件行 | 原文 | key |
|---|---|---|
| 723 | 更新失败（{code}）：{zh}。 | panel.banner.error.title |
| 724/819 | 复制诊断发给插件作者；深挖看日志通道。（兜底 act） | panel.banner.error.action-fallback |
| 727/822 | 重试安装 | panel.action.retry-install |
| 735 | 正在读取更新状态… | panel.banner.loading |
| 737/763/782/839/864 | 安装更新（5 处复用） | panel.action.install |
| 749 | 正在安装（本插件在装）。 | panel.queue.busy-self |
| 751 | 前方有安装在进行，本插件排第 {n} 位，到队首再点安装。 | panel.queue.busy-queued |
| 752 | 前方有其他插件在安装，稍后重试。 | panel.queue.busy-other |
| 759 | 已跳过 {latest} | panel.skip.skipped-title |
| 760 | 点恢复可重新提醒该版本；有更新的新版本会照常提醒。 | panel.skip.skipped-action |
| 778 | 新版 {latest} 已安装，重启宿主后生效。 | panel.banner.restart-title |
| 794 | 正在安装{version}…关闭面板不会中断。 | panel.banner.installing-title |
| 795 | 进度按轮询自动刷新；重开面板 1 秒内恢复显示。 | panel.banner.installing-action |
| 798 | 安装中… | panel.action.installing |
| 850 | 有新版 {latest} 可装（当前 {running}）。 | panel.banner.update-title |
| 851 | 点安装即走精确版本安装；同一使用范围同时只装一个。 | panel.banner.update-action |
| 854 | 安装 {latest} | panel.action.install-version |
| 862 | 已是最新，无需更新。 | panel.banner.done |

### 3.7 内核 HTML（1142-1418，约 45 项）

章节 1142 检查与安装 更新日志 更新队列 错误信息 手工命令，对应 panel.chapter.1 到 5。

| 文件行 | 原文 | key |
|---|---|---|
| 1161/1171-1173 | 运行 磁盘 远端 三格 | panel.strip.running/installed/latest |
| 1167 | 未知（版本缺省） | 复用 unknown |
| 1185 | 正在安装新版… / 正在校验安装结果… | panel.progress.installing/verifying |
| 1208-1209 | 插件更新 / 更新档案 卷 | panel.masthead.kicker/title |
| 1216 | 使用范围 {p 或 未知} | panel.meta.profile |
| 1242 | 正在查新版… title 正在向官方源查询，请稍候 | panel.action.checking 加 title-checking |
| 1243 | 查新版 title 重新向官方源查一次新版（只读，不安装） | panel.action.check 加 title-check |
| 1245 | 正在安装… title 正在安装，请稍候 | 复用 installing |
| 1246 | 安装按钮 title 用精确版本安装；同一使用范围同时只装一个 | panel.action.install-title |
| 1249 | 跳过该版本 title 该版本不再提醒；有更新的新版本照常提醒 | panel.action.skip 加 title-skip |
| 1252 | 恢复（{v}） title 撤销跳过，该版本重新提醒 | panel.action.unskip 加 title-unskip |
| 1255 | 复制手工命令 title 复制手工命令，粘到终端整行执行 | panel.action.copy-manual 加 title-copy-manual |
| 1261 | 重启宿主 title 宿主没有自重启电话：请手动重启宿主 | panel.action.restart-host 加 title-restart-host |
| 1264 | 复制诊断 title 复制已脱敏诊断，直接粘给插件作者 | panel.action.copy-diag 加 title-copy-diag |
| 1273-1274 | 已跳过 {v} / 点恢复可撤销，之后这一版还会再提醒。 | panel.skip.line-tag/line-note |
| 1295 | 更新说明（{from} 到 {to}）：/ 更新说明： | panel.changelog.heading |
| 1309 | 日志读不出来，安装不受影响。/ 还没查到新版；查到后再显示日志。 | panel.changelog.unavailable |
| 1333 | 空闲 | panel.queue.state-idle |
| 1335/1340 | 其他插件 | panel.queue.other |
| 1337 | 本插件 | panel.queue.self |
| 1343 | 未排队 / 第 {n} 位 | panel.queue.pos-absent/pos-n |
| 1344 | 下一个就是你 / 前方 {n} 个 | panel.queue.pos-next/pos-ahead |
| 1348/1350 | 正在安装 / 装完自动轮到你 / 同一使用范围一次只装一个 | panel.queue.row-installing 加 note |
| 1353 | 你的顺位 | panel.queue.row-position |
| 1364 | 排队顺序 | panel.queue.row-order |
| 1373 | 隐藏他人明细 / 显示其他插件 | panel.queue.toggle-hide/show |
| 1381 | 当前没有排队任务，同一使用范围一次只装一个。 | panel.queue.empty |
| 1392-1393 | 稳定码 {code}：上一条中文说明就是要用户做的事；要往上游报，用复制诊断整段粘（已脱敏）。 | panel.error.code-label 加 note |
| 1397-1398 | 深挖看日志：按插件标识 {id} 过滤三个事件。 | panel.error.log-hint |
| 1408 | 手工兜底命令（复制整行执行）： | panel.manual.heading |
| 1409 | 当前没有可用的手工命令（认不出使用范围或属源码安装时不给）。 | panel.manual.absent |
| 1417-1418 | 安装在宿主侧继续跑，重开恢复显示 / 关闭 | panel.footer.note/close 加 title-close |

### 3.8 挂载态回执 toast（1773-1919，10 项）

| 文件行 | 原文 | key |
|---|---|---|
| 1773/1788 | 正在查新版…（置忙与清忙） | panel.toast.checking |
| 1797/1828 | 正在安装… | panel.toast.installing |
| 1859 | 手工命令已复制，粘到终端整行执行即可。 | panel.toast.copy-manual-ok |
| 1861 | 复制失败，请手动选中上面的命令。 | panel.toast.copy-manual-fail |
| 1896 | 诊断已复制，直接粘给插件作者即可（已脱敏）。 | panel.toast.copy-diag-ok |
| 1898 | 复制失败，请手动选中上面的信息。 | panel.toast.copy-diag-fail |
| 1914 | 已按调用方的重启流程处理；重启后新版生效。 | panel.toast.restart-delegated |
| 1916 | 本宿主未提供重启入口：请手动重启宿主，重启后新版生效。 | panel.toast.restart-manual |
| 1919 | 重启入口调用失败：请手动重启宿主，重启后新版生效。 | panel.toast.restart-failed |

## 4. panel-batch 批量面板（src/panel-batch.ts，真渲染 87 项）

注：171 批量电话前缀断言与 1080 轮询校验为开发者抛错，已剔除计入第 8 节。

### 4.1 聚合摘要（233-240，8 项）

| 文件行 | 原文 | key |
|---|---|---|
| 233 | {n} 家可更新 | batch.summary.updatable |
| 234 | {n} 家安装中 | batch.summary.installing |
| 235 | {n} 家待查 | batch.summary.pending |
| 236 | {n} 家待重启 | batch.summary.restart |
| 237 | {n} 家失败 | batch.summary.failed |
| 238 | {n} 家已跳过 | batch.summary.skipped |
| 239 | {n} 家已最新 | batch.summary.settled |
| 240 | 还没有目标 | batch.summary.empty |

### 4.2 行状态一句话（250-281，12 项）

| 文件行 | 原文 | key |
|---|---|---|
| 250 | 已排队 · 等前面安装完 | batch.row.queued-generic |
| 251 | 已排队 · 前方 {n} 个 | batch.row.queued-n |
| 260 | 已跳过 {v} | batch.row.skipped |
| 263 | 等它，轮到就自动查新版 | batch.row.wait-turn |
| 265 | 正在查新版，稍等 | batch.row.checking |
| 268-269 | 点安装这家安装 {v} / 新版 | batch.row.cta-version/cta-generic |
| 271 | 正在安装，别动 | batch.row.installing |
| 273 | 已是最新，不用动 | batch.row.current |
| 275 | 安装好了，重启宿主才生效 / 安装好了，不用动 | batch.row.done-restart/done |
| 277 | 安装没成功，点重试再来一次 | batch.row.failed |
| 279 | 这一版已跳过，不用动 | batch.row.skipped-idle |
| 281 | 状态认不出，点检查更新重查一次 | batch.row.unknown |

### 4.3 总账头与宏按钮（372-425，8 项）

| 文件行 | 原文 | key |
|---|---|---|
| 372 | 更新档案 · 总账 | batch.header.title |
| 374 | 检查更新 title 重新读取批量状态（只读） | batch.action.check 加 title-check |
| 375 | 全部更新 title 把有新版的几家一次提交；同一会话同一幂等编号 | batch.action.install-all 加 title-install-all |
| 376 | 关闭 title 关闭面板（批量推进在宿主侧继续跑） | batch.action.close 加 title-close |
| 383 | 正在读取批量更新状态… | batch.banner.loading |
| 416 | 接着上次 | batch.action.resume |
| 423-425 | 再点一次确认取消 / 取消这一批要点两次确认防误触 / 确认取消这一批 / 取消这一批 | batch.action.cancel-confirm-title/cancel-title/cancel-confirm/cancel |

### 4.4 总账提示与印章（456-478，13 项）

| 文件行 | 原文 | key |
|---|---|---|
| 456 | 刚才那次没成功：看下面的红条，照它说的做一次。 | batch.hint.error |
| 457 | 还没有目标：点检查更新看看哪几家有新版。 | batch.hint.empty |
| 462 | 正在安装 {a} 家；还有 {b} 家可以点加入队列排队等。 | batch.hint.installing-queueable |
| 463 | 正在安装 {a} 家，安装完自动下一家。 | batch.hint.installing-auto |
| 465 | {n} 家安装失败；照下面的失败提示逐家重试。 | batch.hint.failed |
| 467 | {n} 家可更新；点全部更新一次安装完，也可以逐家点安装这家。 | batch.hint.updatable |
| 468 | {n} 家已安装好，重启宿主后生效。 | batch.hint.restart |
| 469 | {n} 家还没查过；点检查更新查一轮。 | batch.hint.pending |
| 470 | 全部已最新，没有要做的。 | batch.hint.done |
| 475-478 | 总账 四档 tone 按失败 安装重启 可更新 其他 | 同一 key batch.seal.ledger，tone 不入 key |

### 4.5 总账横幅（487-523，9 项，zh 与 act 复用 panel 电话表）

| 文件行 | 原文 | key |
|---|---|---|
| 487-490 | 这次没成功（{code}）：{zh}。加兜底先重试一次 | batch.banner.error-title 加 error-action-fallback |
| 503 | 认不出具体原因（兜底 zh） | 复用 unknown |
| 508-510 | {n} 家安装失败。加逐家点行内重试再来一次 | batch.banner.failed-title/action |
| 519/521/523 | {n} 家已安装好，重启宿主后生效。加重启宿主让新版跑起来这是正常终态不是失败。加重启宿主 | batch.banner.restart-title/action/button |

### 4.6 行内与详情动作（548-690，14 项，两处复用同一 key）

| 文件行 | 原文 | key |
|---|---|---|
| 548/656 | 安装中… | batch.row-action.installing |
| 554/660 | 取消排队 | batch.row-action.cancel-queue |
| 560/666 | 加入队列 / 安装这家 | batch.row-action.queue-or-install |
| 566/682 | 恢复（{v}） | batch.row-action.unskip |
| 571/666 | 加入队列 / 重试 | batch.row-action.queue-or-retry |
| 671 | 加入队列 / 安装 {v 或 新版} | batch.row-action.queue-or-install-version |
| 576 | 重启宿主 | batch.row-action.restart |
| 580 | 收起 / 详情 | batch.row-action.toggle-detail |
| 584-585 | 失败 {code}：{zh 或 认不出具体原因} | batch.row.error-label，zh 复用 panel 电话表 |
| 676 | 跳过这一版 | batch.row-action.skip |
| 687 | 复制手工命令 | batch.row-action.copy-manual |
| 690 | 复制诊断 | batch.row-action.copy-diag |

注：548-590 为总账区行内按钮，656-690 为详情区同一通道，逐字相同，底座同一 key 两处渲染。

### 4.7 诊断来源后缀与回执（963 加 1262-1521，16 项）

| 文件行 | 原文 | key |
|---|---|---|
| 963 | （来源：后台任务收尾记录） | batch.diag.source-job |
| 1262 | 复制失败，请手动选中上面的信息。 | batch.toast.copy-fail |
| 1318 | 前面还在装：这一家还没排上，等那家装完再点一次。 | batch.toast.queue-missed |
| 1355 | 已接着上次的会话推进一步。 | batch.toast.resumed |
| 1365 | 已取消这一批：剩下的不再推进；要重来点检查更新。 | batch.toast.cancelled |
| 1379 | 已跳过 {v}：这一版不再提醒；点恢复可撤销。 | batch.toast.skipped |
| 1392 | 已恢复 {v}：这一版会照常提醒。/ 已恢复跳过提醒。 | batch.toast.unskipped-version/unskipped-all |
| 1404 | 这一行没带取消排队要用的电话名或编号，暂不能取消：等下一次刷新再看。 | batch.toast.cancel-unavailable |
| 1415 | 已取消排队：这一家不等了。 | batch.toast.cancel-ok |
| 1417 | 取消排队没成功（可能已经开始装了）：看下面最新状态。 | batch.toast.cancel-fail |
| 1428 | 手工命令已复制，粘到终端整行执行即可。 | batch.toast.copy-manual-ok |
| 1434 | 诊断已复制，直接粘给插件作者即可（已脱敏）。 | batch.toast.copy-diag-ok |
| 1450 | 已按调用方的重启流程处理；重启后新版生效。 | batch.toast.restart-delegated |
| 1452 | 本宿主未提供重启入口：请手动重启宿主，重启后新版生效。 | batch.toast.restart-manual |
| 1455 | 重启入口调用失败：请手动重启宿主，重启后新版生效。 | batch.toast.restart-failed |
| 1521 | 再点一次确认取消这一批才真的取消；点别的按钮可撤销这次确认。 | batch.toast.cancel-arm |

## 5. 诊断复制与阻塞一句话已并入 3-4 节

- 阻塞 8 码见 3.1，电话 5 加 internal 加兜底见 3.2，批量复用同一表（4.5 行内 zh 与 act 均调 failureCopy）。
- 诊断复制旧块见 3.3，新块见 3.4，批量来源后缀见 4.7 的 963。
- 动态 detail 内容不入 key，见第 7 节。

## 6. changelog（src/changelog.ts，27 行中运行时 13 加逻辑 4 加 CI 校验 10）

### 6.1 运行时渲染（13 项，全双语）

| 文件行 | 原文 | key |
|---|---|---|
| 30 | 作者未提供更新说明 | changelog.neutral-hint |
| 33 | 作者未提供更新说明，安装不受影响。 | changelog.neutral-line |
| 62 | 新增（Added） | changelog.category.added |
| 63 | 修复（Fixed） | changelog.category.fixed |
| 64 | 变更（Changed） | changelog.category.changed |
| 65 | 弃用预告（Deprecated） | changelog.category.deprecated |
| 66 | 移除（Removed） | changelog.category.removed |
| 67 | 安全（Security） | changelog.category.security |
| 184 | 不兼容（BREAKING 徽标，aria 465 破坏性变更） | changelog.breaking-badge 加 breaking-aria |
| 442 | 共 {m} 条，仅显示前 {n} 条 | changelog.truncated-count |
| 451 | 目标版本 {v} 已被作者撤回（yanked），安装不受影响，继续前请确认。 | changelog.yanked-banner |
| 480 | 已撤回（节标题后缀） | changelog.yanked-suffix |
| 504 | 其余 {n} 条 加 为保持面板性能，其余条目已折叠，可查看原文。 | changelog.security-more.summary/note |

### 6.2 作者原文识别逻辑（4 行，不翻译不入 key，冻结）

207 不兼容正则备选，215 同，605 不兼容整行判定，606 不兼容缺冒号判定。均为对作者 CHANGELOG 原文的识别（中英文冒号皆可），不是本包 UI 文案。底座原样保留，不做双语。

### 6.3 六类映射复用说明（验收项）

- 唯一源：CATEGORY_ZH（62-67）中英一一对应，顺序与英文全集同序。底座双语标题直接复用此表，不另起第二套映射。53 术语表锁定英文终稿后，此表即中英对照唯一输入。
- 必显折叠复用：Added Fixed Changed Security 必显展开，Deprecated Removed 透传折叠，Unreleased 与空节忽略。面板 02 章直接按此策略渲染，不重定策略。
- 截断复用：运行时 442 与校验 590 636 同口径（共 M 条仅显示前 N 条，分类 {k} 共 {n} 条仅显示前上限条），底座统一收敛为同一 key，数值插值不译。
- 撤回复用：运行时 451 与校验 W_YANKED（589）同文案，节后缀 480 已撤回为同一术语缩写，底座同一 key 族。
- 破坏标记复用：徽标 184 不兼容与识别 207 215 605-606 同词，校验 W_BREAKING_MAYBE（588）示例 BREAKING 与不兼容同词。英文 BREAKING 保留原文加粗，中文徽标只此一词，底座不另起同义词。
- 校验文案（585-592 加 636，共 10 行）为 CI 发布前用，运行时永不调用，不进运行时渲染，计数不改。

## 7. diag 人话兜底与动态来源

### 7.1 diag.ts fallback 18 行（266-283，全双语，待 53 锁英文）

| 文件行 | 原文 | key |
|---|---|---|
| 266 | 操作失败 | diag.fallback.generic |
| 267 | 读本地状态没成功 | diag.fallback.read-installed |
| 268 | 装前重验取数没成功 | diag.fallback.revalidate-fetch |
| 269 | 源返回 429，这一分钟请求太多 | diag.fallback.rate-limited |
| 270 | 源返回 {s}，重试仍失败 | diag.fallback.http-status |
| 271 | 查新版没成功（联网、源、限流都可能） | 复用 panel.failure.check-failed.zh |
| 272 | 清单里的版本号不是合法版本 | diag.fallback.invalid-release |
| 273 | 凭证过期了，安装请求被拒 | 复用 check-expired |
| 274 | 同一使用范围正在装另一个 | 复用 update-busy |
| 275 | 安装失败（短版，电话表为长版装不上详见诊断摘要） | diag.fallback.install-failed，底座分 key 待裁决是否合并 |
| 276-283 | 使用范围或插件位置认不出 等 8 行短版 | diag.fallback.短码-short，与 3.1 长版同义不同字，分 key 待 53 裁决 |

注：271 273 274 与电话表同文复用电话表 key。其余短版与长版差括号解释从句，是否合并由术语表定，本清单分 key 保留差异。

### 7.2 service 动态 detail 2 项（内容冻结，只标签双语）

src/service.ts:582 装完校验没过：磁盘上是 {installed 或 未知}，目标是 {target 或 未知}。

src/service.ts:586 装完校验没过：环境报告 {blockedReason}。

经 job.message 的 code 加 detail 通道到 panel-batch jobFailureOf 再到 diagTextOf 加来源后缀到 buildDiagnosticText 摘要。按立约 detail 内容不翻译，底座不为其建 key。标签双语已在 3.4。列出即无漏项证明。

### 7.3 redaction 占位符 2 项（冻结）

src/redaction.ts:50 路径占位，51 脱敏占位。复制落刀与截断逻辑 300 1500 1024 同冻。列出即无漏项，不入双语 key。

## 8. 只计数不改（注释日志抛错开发者断言 CI 校验 CSS 注释）

- 注释 1822 行：全文件头分节冻结说明取证引用，不动。
- 抛错 91 行：throw new Error 的开发者接线错误（panel 10 行，entry 10 行，entry-batch 9 行，panel-batch 7 行含 1080 轮询校验，config 10 行，gate 15 行，http 18 行传输失败抛异常通道），面板永不渲染，只计数。
- 开发者断言 17 行（已从渲染候选剔除）：host-batch 349 560，config 122 134 138 140 141 154，http 413 414，gate 161 163 164 215，batch-run 147 实为行尾注释，panel-batch 171 1080。调用方传错即抛，不进 DOM 剪贴板。
- CI 校验 10 行：changelog 585-592 加 636，共 10 行，validate 仅 CI 发布前用，运行时永不调用。
- CSS 注释 3 串：panel 994，panel-batch 722 757 770，在 style 内不渲染，不入 key。
- 日志事件：包内事件字段无中文自由文本，日志中文 0 新增。store host service 日志只记枚举数字，不记中文。
- 快照六字段 diag 16 键稳定码英文码本身：冻结不译，本清单 key 只包中文标签，不包码值。
- 计数方法：grep 中文 2231 行，按注释行首斜杠星号，抛错 throw，CSS 串单引号斜杠星，四分，交叉核对 1-7 节行号无交集无遗漏。

## 9. 给 53 与 54 的唯一输入（下一步）

- 53 术语表：以 3-4 节 key 表为源，锁定英文终稿。使用范围 清单文件 重启宿主 已跳过等。diag 短版长版是否合并见 7.1。detail 模板见 7.2 是否双语抑或仅标签双语，立约字面即模板亦不译，保留分歧待评审，无评审标 draft。
- 54 底座：以本清单 key 表建集中字典与双语渲染（语义块 lang，英文前中文后，窄处竖排）。复用关系：电话表 6 key 被 diag fallback 3 处复用，阻塞 8 key 被 failureCopy 复用，印章 8 key 双主题复用，行内两处按钮复用同一 key，changelog 六类复用 CATEGORY_ZH 见 6.3。数据层永不拼串：家字句 第几位 前方几个 共几条等插值在表现层按语义块拼。
- 本票零代码改动：对照自查 git status 仅新增本文件加 issue 评论正文更新，无运行时变更。54 落地时跑全门禁。

对抗自查：逐节回查源文件行号。entry 7 项，entry-batch 6 项，panel 152 项含 toast 10 印章 8 章节 5，panel-batch 87 项已剔 171 1080，changelog 运行时 13 项，diag 18 项，redaction 2 项，service 2 项，均在表内。8 节计数与总数 2231 轧平（301 加 1930 等于 2231，其中 1930 为注释 1822 加抛错 91 加开发者断言 17，batch-run 行尾注释已归注释，CSS 已剔）。
