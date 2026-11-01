# 本机升级日志抓取与预期核对（2026-10-20）

> 目的：按 m00001 的要求，先抓取本机各插件的「升级日志」，对照本仓契约/预期找不一致。**不涉及升级方案讨论。**
>
> 数据源：`C:\Users\辰辰洋洋\.dsh\logs\<命名空间>\2026-10-20.log`（dsh-log v3 JSONL）、`~/.dsh/updates/<pluginId>/7ece3b35.../state.json`、`~/.dsh/update-queue/.../queue.json`、`~/.dsh/profiles/desktop/package.json|pnpm-lock.yaml|node_modules`、`D:\dsh-plugin\dsh-plugin-update\event-list.update.json`（契约）。
> 全量审计明细：`prototype/audit-2026-10-20.md`（脚本 `prototype/audit-update-logs.mjs`）；本文件是人工复核后的结论。
> 时间均为 +08。

## 0. 抓取范围

- 日志命名空间 30 个，其中**真正的已装插件消费方 11 个**：life-bill / life-calorie / life-chef / life-home / life-life-pack / life-memo / life-schedule / dsh-opencode-palette / dsh-prompt / dsh-im-companion / dsh-mattpocock-skills-deck。
- 其余：18 个是测试夹具名（写进了真实 HOME，见第 13 条）；1 个是第三方的纯文本日志（vision-router）。
- 今日总量 113272 行（本包事件 97299 / 非本包事件 15973 / 非 JSON 行 3480）。

## 1. 今天实际发生的升级（可对上 state.json 的部分）

| 插件 | 日志链 | 最终状态 |
| --- | --- | --- |
| life-life-pack | 04:12:27 batch.resume → install.exec ok(7028ms) → verify restart-required | completed 04:13:42 |
| life-bill/calorie/chef/home/memo/schedule | 04:12:3x gate-refused(check-expired) → 重查 → request → exec → verify restart-required | restart-required，04:13:55–04:14:27 |
| dsh-opencode-palette | 04:10:27/04:10:41 两次 host-rejected → 04:15:49 exec ok(4245ms) → verify restart-required | completed 04:15:49 |
| dsh-prompt | 04:14:36 host.call updateInstall ok(565ms) → 04:14:41 install.exec ok(5759ms) | completed 04:14:41 |
| dsh-im-companion | 04:24:11 check 0.2.16→0.2.18 → install「成功」与 tap 转发 fail 同秒并存 | failed（bundle-in-use），04:24:36 |
| dsh-mattpocock-skills-deck | 无今日日志 | state 停在 10-19 的 interrupted（beta.3→beta.4），实装已是 beta.6 |

批量上下文：`life-life-pack` 命名空间（属主）04:12:27 `update.batch.run.start {trigger:"resume",resumed:true,total:7}` → 04:12:41 `batch.summary {total:7,ok:1,failed:6}`；04:13:48 第二轮 resume → 04:14:27 `batch.summary {total:7,ok:7,failed:0,stoppedBecause:"finished"}`。与契约「批量行落属主目录」一致。

## 2. 与预期不一致的清单（按严重度）

### P1-1 `update.status.changed` 边沿去重实际没生效

- 契约：真值元组（kind/latest/runningVersion/installedVersion/registered/identity/blockedReason/unknownCause）未变不发。
- 实际：相邻重复大量落盘。今天 7 个 life-*：status.changed 75–85 行/个，**相邻重复 37–49 条/个**；palette 9 行里 2 条重复。全量审计 real 违规 4202 条，其中 7 个 life-* 共 4144 条（582–609/个）。
- 直接证据（life-bill 04:15:04.206 / .733 / 05.733 / 07.208 / 08.709 / 09.405）：同一元组（kind=unknown、latest=null、running=0.3.76、installed=0.3.78、blockedReason=pending-restart、unknownCause=no-latest）约 1.5 s 一条、每行 traceId 不同。
- 关键旁证：04:15:03.979 的 `update.check` 已拿到 latest=0.3.78，0.2 s 后的 `update.status.changed` 里 latest 又回 null → 连 check 与 status 都不共享状态，**每条 updateStatus 电话像新起了一套 reader/core，去重记忆被清空**（`phones.ts` 轮询抑制只管 host.call，不管 status.changed）。
- 已排除「装的是没去重的旧版」：安装版 0.18.32 的 `dist/service.js` 里有 `lastStatusFingerprint` 去重；`b81c5d4`/`7c3a365` 引入的这段代码在 v0.18.32 就存在。→ 去重代码存在但运行时未生效，属实现/装配层问题。

### P1-2 `update.changelog.parse` 在整机日志里从未落过盘

- 契约：resident/info，边沿触发（同 (version,status,cached) 每进程至多一行）；源码唯一发射点 `src/host/factory.ts:320`；安装版 0.18.32 的 `dist/host.js` 也有该发射点。
- 实际：全部日志目录搜 `update.changelog.parse` **0 行**；而 host.call 记录的 updateChangelog 电话共 **31 次**（palette 10、prompt 19、life-calorie 1、life-life-pack 1）。palette 自己的 `lib/event-list.json` 也把该事件声明为 resident/info，字段齐全。
- 结论：按预期每次解析应至少落一行，实际一行都没有。机制待复核（可能与本条 P1-3 的版本错位/外部落点闸门有关）。

### P1-3 升级器自己有「三处版本口径」+ 一处依赖 pin，运行时版本与声明不一致

- `~/.dsh/profiles/desktop/package.json` 声明 `dsh-plugin-update: 0.18.33`；
- `pnpm-lock.yaml` / `.modules.yaml` / `node_modules/dsh-plugin-update/package.json` 实为 **0.18.32**，`update.wire.ready` 自报 updaterVersion=0.18.32；
- registry 上 0.18.33 已发布（10-20 01:10 左右），所以不是「还没发包」；
- 消费方要求：life-pack `^0.18.33`、palette/im-companion 精确 `0.18.33`、dsh-prompt 内联 `INLINED_UPDATE_PKG_VERSION='0.18.33'` —— 四家都已按 0.18.33 写代码，但本机运行时加载的是 0.18.32（或内联副本）。
- 另：`pnpm-workspace.yaml` 里 `overrides: dsh-plugin-update: 0.18.32` 与 package.json 声明互相矛盾。

### P1-4 dsh-prompt 的「升级日志」几乎为空，且事件名/枚举被哈希化

- 今天该命名空间只有：6 条 host.call + 1 条 `update.install.exec`（level=**warn**，route=`3c34c487`）+ 2 条 `update.route.fail`。
- 无 wire.ready / install.request / install.verify / check.done / status.changed；升级成功只能靠 host.start 的 pluginVersion 从 0.4.35→0.4.37 推断。
- 原因（消费者侧实现差异）：它的内联 `lib/update.js` 桥只转发 host.call / host.call.fail / update.install.exec 三种事件，其它一律吞掉，每进程只落一条 `update.route.fail {reason:"unknown-event", errorHash:"a7f3cf72"}`。
- 哈希解码（djb2/hash8，与 dsh-prompt gate.hash8 同实现）：`a7f3cf72`=hash8("update.status.changed")；`3c34c487`=hash8("desktop-manager")（其 install.exec route ENUM 缺 desktop-manager）；host.call kind `b4ec06dd`=hash8("update-changelog")；host.call.fail errorHash `e5a47d01`=hash8("check-expired")。
- 其 `event-list.dsh-prompt.json` 把 install.exec 声明为 level=warn（为绕开默认关闭的 info 通道），与本仓契约 info 冲突。

### P1-5 dsh-im-companion 升级「三源不一致」

- `state.json`：failed，message=install-failed: bundle-in-use（mtime 04:24:36）。
- 它自己的日志：04:24:23.288 / 04:24:36.811 `update.install {ok:true, version:"0.2.18"}`；但同一毫秒 04:24:23.289 / 04:24:36.995 `host.update.tap {event:"update.install.fail", detail:{stage:"exec",reason:"host-rejected",code:"install-failed",hostCodeHash:"efd16f3d"}}` —— **同一秒「成功」和「失败」并存**。
- 盘上终态：`node_modules/dsh-im-companion`=0.2.18，04:25:00 `client.start {build:"v0.2.18@2026-10-19T17:10:06Z"}`（新版本已装上并加载），但 state.json 没更新，04:25 装配成功本身也没有任何 update.* 行。
- 另有 3 条 `log.persist.fail {op:"persistSwitch", reason:"dir-conflict", dirHash:"d6746c9c"}`（04:24:23/26/36）。
- 它不使用本包事件格式（自有 update.check/update.install/update.action/host.update.tap），没有 wire.ready，升级失败细节只能靠 tap 里的 JSON 字符串读。

### P2-1 `update.install.retry` 缺 traceId/spanId/seq

- v3 引擎会给每行自动注入 traceId/spanId/seq；今天 7 条 install.retry 行三个字段全无（其它事件都有）→ 该事件走了不经过日志引擎上下文的发射路径。

### P2-2 `install.verify` 与 `install.exec` 顺序/归属异常

- life-life-pack 01:39:05.304 `install.verify {result:"interrupted"}`（traceId=ab7d2904）出现在同请求 `install.exec` 行 01:39:05.911（traceId=4c3a9677）**之前**，且 interrupted 时段执行尚未结束。

### P2-3 `batch.summary` 的 ok 口径吞掉「待重启」

- 04:14:27 `batch.summary {total:7,ok:7,failed:0}`，但 7 个插件同批的 `install.verify` 全是 `result:"restart-required", pendingRestart:true`。摘要里没有 pendingRestart 维度，读日志像全成功。

### P2-4 `update.wire.ready.copyLevel` 一天内 nested→profile 翻转，盘上找不到对应副本

- 7 个 life-* 在 01:38:16 与 04:12:26 两次 wire 报 copyLevel=**nested**，04:13:42 起报 **profile**；palette 全天报 nested。
- 盘上找不到 0.18.32 的嵌套副本（`.ignored` 里只有 0.18.2 / 0.12.0 / 0.13.0 旧备份）→ 升级窗口里确实运行过不可追溯的嵌套副本。
- 另有判定口径问题：pnpm 虚拟店路径 `.../node_modules/.pnpm/<pkg>@ver/node_modules/<pkg>` 含 2 段 `/node_modules/`，`selfCopyLevelOf()` 会把它判成 nested 而不是 profile → pnpm 布局下 copyLevel 语义失真。

### P2-5 升级状态文件无时间戳 + 残留队列

- 所有 `state.json` 没有 startedAt/finishedAt，只能靠 mtime 推断哪次升级；`~/.dsh/update-queue/.../queue.json.bak-216-084920` 残留 `waiting=[life-bill, life-calorie]`（旧 requestId `batch-mve27obv…`），当前 queue 为空。
- mattpocock 的 state 是 10-19 的 interrupted（目标 beta.4），实装是 beta.6；今日命名空间只有一条 10-15 的全 null 字段 wire.ready + 1 条 host.call.fail → 状态与实装脱节。

### P2-6 客户端日志投递丢失（本包自己报的 degraded）

- 今天 23 条 `update.log.degraded`：`client-drop-send-failed`（update.panel.mount 丢）与 `client-drop-disposed`（update.panel.action 丢），涉及 life-bill / life-life-pack / palette → 契约里声明了、但实际没落盘的面板事件。

### P3-1 日志噪声（操作日未破总预算，但离稳态预算很远）

- life-* 今日 314–343 行/日（常驻 205–228），其中 status.changed 75–85 + poll 68–86；契约稳态 ≤50 行/日/插件、操作日 ≤500 —— 当日属操作日，未破总预算，但常驻行 200+/日远超稳态线（根因同 P1-1 的轮询/去重问题）。

### P3-2 测试夹具命名空间写进真实 HOME

- `~/.dsh/logs` 下 18 个夹具名：life-a…life-g、life-self、life-bad、custom-b、t-a、t-b、plugin-a/b/c/self、owner-a-a、owner-b-a。
- 规模：life-a 30736 本包行、life-b 19256、life-self 18474；10-15 至 10-20 每天仍在新增（今天 00:05–00:40 又写了一批 host.start/wire.ready，updaterVersion 混 0.18.25/0.18.32/0.18.33，hostKind=cli、copyLevel=repo，dir 明确指向真实 `C:\Users\辰辰洋洋\.dsh\logs`）。
- 判定：旧测试/开发进程没隔离 `DSH_HOME` 的残留（tests 用 mkdtemp，但历史上直跑过），不是已装插件的行为；它污染「日志系统自身可信度」的审计。

### P3-3 vision-router 目录混第三方纯文本日志

- `vision-router/vision-router.log`（818KB，3480 行）是第三方自有格式 `[ISO] [WARN] vision-router: ...`，不是 dsh-log v3 JSONL；审计时被算坏行。说明「logs 目录」不等于「只有 dsh-log 事件」。

### P3-4 重启后没有新的日志证据

- 04:15:19 应用重启；之后 life-* 最后一行 04:15:09、palette 最后 04:15:56，到本次审计（04:5x）无新行。wire.ready/host.start 是懒接线（打开更新面板才出现），所以「升级换了新版本、重启后是否正常」在日志里没有闭环证据。

### P3-5 「更新日志（CHANGELOG.md）」在 21 个已装插件里只有 5 个有

- 包根目录有 `CHANGELOG.md` 的：dsh-codinput、dsh-im-companion、dsh-mattpocock-skills-deck、dsh-plugin-update、dsh-prompt。
- 其余 16 个都没有，且它们 `package.json` 的 files 白名单里也没列 CHANGELOG → 更新面板只能显示「作者未提供更新说明」的中性提示；升级瞬间拿不到 0.3.76→0.3.78 这类的更新说明。
- 与本仓「更新日志」契约（`CHANGELOG.md` 精确文件名、从 tarball 取、取不到不挡安装）不冲突，但用户体验上 16/21 是空的。

## 3. 可解释、不算违规的项（避免误报）

- `update.install.exec` 在 dsh-prompt 里 level=warn、route 是哈希：消费者自有清单就这么声明的（warn 为绕开默认关闭的 info 通道；route ENUM 缺 desktop-manager 被 gate 散列）→ 消费者侧差异，非本包落盘错误。
- dsh-prompt 缺 install.request/verify/status.changed：其桥只转发 3 个事件（同上）。
- `host.call`、`host.call.fail`、`update.poll` 等按契约该出现的行都出现了；life-* 的批量链（entry → gate-refused → 重查 → request → exec → verify → state）与 state.json 对得上。
- 每行的 traceId/spanId/seq 是日志引擎保留字段（`RESERVED_LOG_FIELDS`），不算契约外字段。

## 4. 结论一句话

今天这轮批量升级在「装上了/state 对得上」层面基本成立（life-* 7 个、palette、prompt 成功；im-companion 失败但盘上已更新），但**日志侧有 5 个 P1 级不一致**：status.changed 去重实际失效（单插件单日 40+ 条重复）、changelog.parse 从未落盘、升级器自身 package.json/lock/实装三处版本口径不一致（声明 0.18.33、实跑 0.18.32）、dsh-prompt 升级日志被自家桥吞成近乎空、im-companion 同一秒成功/失败并存且 state 未更新。
