# #284 B 组：用户可感知边界缺口的真机用例（决策笔记）

票：GitHub #284（规格 #263 收口补测），owner：t4-implementer；分片声明 `selftest/fixtures/identity/scenario-declarations-boundary-gaps.ts`；
场景驱动 `selftest/real-machine/scenarios/l-boundary-gaps.ts`，runner `selftest/real-machine/tools/run-l-boundary-gaps.ts`。
全部走**通道 B：普通 DSH web 宿主（CLI `dsh web`）+ Playwright 真页面 + base 库真装**，失败只用外部手段注入，
不改产品代码造假；唯一产品改动是发现的三处诚实性 BUG（Lead 逐项批准，见末节）。证据契约同 `selftest/evidence/README.md`。

## 场景与定稿 run

| 场景 id | 设计 | 定稿 run | 判定 | 断言/截图 |
| --- | --- | --- | --- | --- |
| `l1-same-process-two-plugins-concurrent` | 同一宿主进程两个集成方面板：A、B@0.0.1 → 发布 A/B@0.0.2 → 真 UI 近似同刻点安装；断言串行/诚实忙碌（不假「已更新」）、失败方重试后两包各 0.0.2、两包各恰一条成功终态、重启后如实 | `284-20261103T191200` | pass / 0 | 17 / 4 |
| `l2-registry-unreachable` | check 到 0.0.2 后杀本 run 私有 verdaccio（外部手段）→ 真 UI 安装失败诚实（stage=gate/check-failed、无 exec、无假成功、无重试风暴）；同 storage/同端口恢复 registry → 重启宿主先如实未知/失败历史 → 检查 → 重试真装成 | `284-20261103T191400` | pass / 0 | 21 / 6 |
| `l3-permission-denied` | icacls 对 profile 内 node_modules 加 `*SID:(OI)(CI)(AD,WD)` 拒绝项（读包/读清单 OK，建目录/写文件/append EPERM）→ 真 UI 安装 → pnpm `ERR_PNPM_EPERM` 真失败（failed 横幅、台账 failed、stage=exec/reason=nonzero-exit、磁盘仍 0.0.1、无自动重试）；撤 ACL 并探针复核 → 重启保留失败历史 → 检查拿凭证 → 点安装重试真装成 | `284-20261103T200100` | pass / 0 | 17 / 6 |
| `l4-page-close-mid-install` | 延迟代理把安装窗拉到 8s/请求 → 真 UI 点在飞后 `page.close()` + `browser.close()`；此后不看页面，仅用磁盘/台账/日志判定宿主侧完成（完成时刻晚于关页面）→ 重开页面如实、台账恰一条成功 | `284-20261103T201400` | pass / 0 | 13 / 4 |
| `l5-host-killed-mid-install-recovery` | L5a 默认阈值：慢窗内 `taskkill /T /F` 本 run 宿主 → 重启后如实（failed/recovery-required、台账 interrupted、磁盘基版、不谎称已最新）；L5b 短阈值 12s：杀后过阈值仍无假成功 → 重启先如实中断历史 → 检查后重试 → 陈旧锁自行回收、恰一次成功 → 再重启三面一致 | `284-20261103T203000` | pass / 0 | 20 / 5 |
| can-red（重跑 L2） | 见下「can-red」 | `284-20261103T205500` | fail / 1 | 22 / 6 |

## 断言语义（每条都写「可证伪的声称」）

- 每条断言 = 真 UI 读数 + 磁盘清单 + 台账 `state.json`/`before.json` + 宿主 NDJSON 日志 + raw 原文（命令/回包/ACL/锁文件）之一，actual 必带精确值；unknown 不当作通过。
- 「诚实」的机械口径：失败横幅 `kind=failed` 且标题含「更新失败」；「不假已最新」= banner kind≠done 且 title/sub 不含「已是最新/更新成功/无需更新」；「无假成功」= 磁盘版本未前进 + 台账无成功终态 + 无 ok 的 exec 事件。
- 「已失败不重试」= 失败后静置窗口内 `update.install.request/fail` 计数不增长，且日志无第二次 exec（L2/L3/L5 各一格）。
- 「恰一次成功」= 成功台账恰 1 份 + `before.json` 恰 1 份 + 至少一次 ok exec + 磁盘/筛选 tag 一致（L3/L5b）。
- 产品在 #284 后新增诚实档：新宿主首屏未查过最新版时显示「版本信息未知，请检查更新。」（不再兜底「已是最新」）；
  因此所有「重启后已了结」格子都先断言诚实未知（`*-restart-honest-unknown`）再真 UI 点检查，最后才允许 done——这不是放水，是把产品的新诚实行为钉住。

## can-red（证明诚实性断言真会红）

注入：只改**本 run 私有 profile** 里已装产物两处——夹具集成方打包产物 `lib/client.js`（面板实际加载的字典副本）与 SUT `dist/core/i18n/dictionary.js`——把
`panel.banner.error.title` 的 zh 值从「更新失败（{code}）：{detail}。」替换为谎话「已是最新，无需更新。（{code}）：{detail}。」；不改工作树/产品源码。
注入前后 sha256 与替换值入 `raw/16-can-red-injection.json`，`finally` 逐字节恢复并核 sha 一致（`raw/49-can-red-restore.json`，两文件 ok=true）。
结果：`284-20261103T205500` verdict=fail / exitCode=1，22 条断言中**恰好 1 条红** `25-assert`（即 `l2-03-failure-banner`）：
actual 显示横幅标题已变成谎话「已是最新，无需更新。（check-failed）：…」而 kind 仍是 failed；其余断言仍 pass —— 红点可归因、不是整片塌。

## 产品 BUG 三处（均为「说了假话」，Lead 逐项批准后最小修 + 单测）

| commit | 现象 | 根因（file:line） | 修前 → 修后 run |
| --- | --- | --- | --- |
| `a587dad` fix(#284) | 新进程/跨目标轮询时 latest 未知，面板与诊断仍兜底「已是最新，无需更新。」 | `src/panel/view-model.ts:388` done 兜底、`src/shared/copy.ts:628-637` stateLine 兜底；服务层 `src/core/service.ts:512` latest=null 时 :534-551 已判 unknown | `284-20261103T151900`（L1 fail，两面板假最新）→ `284-20261103T191200` |
| `1dc4c77` fix(#284) | 同一宿主里轮询两个目标互相挤掉单例 reader，已查到的 latest 丢失（放大上一条） | `src/host/capabilities.ts:52-53,210,218-234` 单槽 sharedReader 仅在 busy 时复用 | 同 `151900` → `191200`（L1 两目标各自 latest 保留） |
| `b0e4565` fix(#284) | 检查后目标被他人改写（installationKey 变）→ canInstall=false 但 latest>running，面板落 done 假「已是最新」 | `src/panel/view-model.ts:409-417` done 兜底先于 latest/running 比较；诊断同病 `src/shared/copy.ts:637` | `284-20261103T180549`（L1 race 落败者 done 假最新）→ `284-20261103T191200` |

修法均为「增加诚实档」：latest 未知 → idle「版本信息未知，请检查更新。」；latest>running 但不可装 → idle「有新版本 X，但当前无法安装；请重新检查更新后重试。」，
action=检查更新、installEnabled=false（可自愈）；zh/en 双写并更新双语快照；单测 `tests/issue-284-*.test.mjs` 18 条正反，
相邻组合（latest==running / latest<running / blocked / job）逐字不变。读取器改为按完整缓存键 LRU（上限 16），保留 #268 busy-identity 复用。
因 reader 不再丢 check 结论，`tests/issue-216-batch-display-log.test.mjs` 的「两家凭证必过期」前提失效，随之改钉新行为（`96cf3a7`，retry 行契约仍由 `tests/batch-check-expired-backoff.test.mjs` 覆盖）。

## 边界与未覆盖

- **ACL 是真实 Windows 权限**，不是伪造：deny 项注入前后都有写/读探针（写 EPERM、读 OK、恢复后写 OK）与 `icacls` 原文入 raw；中途异常路径用 `try/finally` 紧急撤 ACL 并留 raw。`(W,D)` 会先打断产品读包（被误判 invalid-installation），故取 `(AD,WD)` 让失败发生在 pnpm staging 写目录，语义仍为「权限不足导致安装失败」。
- **无终止能力宿主**（规范组 D 的 D5）属出口二/桌面宿主范畴，本组通道 B 不覆盖（由 #268 的 g5 探测格 known-red 记录）；本组不伪造该结论。
- can-red 只改本 run 私有已装副本，不污染工作树；L5 的 taskkill 只打本 run 自己起的宿主进程树，pid/端口/退出码入 raw。
- 覆盖到的「页面生命周期」「宿主被杀」「registry/权限」均为外部注入；产品侧未新增任何测试钩子或公开子路径。
