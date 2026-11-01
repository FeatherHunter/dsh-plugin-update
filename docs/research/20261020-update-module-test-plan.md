# 更新模块测试方案（2026-10-20）

> 问题：用哪个插件做 `dsh-plugin-update`「更新模块」的测试载体？以及整套测试方案。
> 结论先行：**主载体用 `dsh-opencode-palette`；批量场景才用 life-pack 六件套；失败注入用自建 fixture 消费者；dsh-prompt / dsh-im-companion / dsh-mattpocock-skills-deck 不适合当载体。**
> 依据来自本机实测（2026-10-20 日志审计）+ 各消费方源码/产物对照，见第 1 节。

---

## 1. 为什么是 dsh-opencode-palette

| 判据 | dsh-opencode-palette | life-pack 六件套 | dsh-prompt | dsh-im-companion | dsh-mattpocock-skills-deck |
| --- | --- | --- | --- | --- | --- |
| 集成方式 | `runtime/host.ts` 直接 `import { createHostUpdate } from 'dsh-plugin-update'`，标准宿主半 | `dsh-life-pack` 用 `createMultiHostUpdate`（批量专用），子插件本身不接更新 | **内联 vendor** `lib/update.js` + 自有桥/白名单，只转发 3 个事件 | 自有更新中心事件（`update.check`/`update.install`/`host.update.tap`），非本包事件表 | 是 `link:` 安装（dev/source 形态） |
| 日志可核对性 | 事件清单 = 上游 29 + 自有 5，`scripts/rebuild-event-list.ts` 从本包 `event-list.update.json` 自动重建；日志在 `<DSH_HOME>/logs/dsh-opencode-palette/` | 日志按 7 个命名空间分散，批量行落属主，噪声大 | 桥会吞事件、字段被哈希（route/kind），日志不还原 | 自有格式，无 wire.ready | 今日无本包事件 |
| 版本可控 | 本地有源码仓 `D:\dsh-plugin\dsh-opencode-palette`（v2.1.6，git/release 流程完整），可发 `2.1.7-test.x`；`deps:sync`/`check-deps` 管上游依赖 | 本地**找不到** ilife 源码仓，装好的包不能改/发测试版 | 本地仓可改，但改的是 vendored 副本 | 本地仓可改，但改的是自有更新中心 | link 到本地开发目录 |
| 已有测试底座 | `tests/update-panel.test.ts`（42KB）已做：假 connection 装配 `runtime/host.ts` → 注册 `/api/opencode-palette` → 电话分发 → 真日志落 `<DSH_HOME>/logs`；`apply(ctx, { readerOverrides })` 留了注入口；入口件五态/失败码文案/面板 SSR 都有门禁 | 仅批量测试（repo 的 batch-* 单测是假宿主） | 无 | 无 | 无 |
| 安装通道 | 本机实测通：2026-10-20 04:15:49 `install.exec ok / exitCode=0 / durationMs=4245` → `verify restart-required` → state completed | 通，但路径是 desktop-manager 批量 | 通但不可见 | 通（最终 0.2.18 装上）但 state 不一致 | 通不了：dev-source 被拦 |
| 安装 UI 面 | 入口件（`mode:"entry"`）+ 面板 + 4 个电话（status/check/install/changelog），日志里都实测过 | 批量面板 & 多目标 | 只有入口件？日志缺全链 | 自有 UI | 无 |

palette 的宿主集成代码就是本包 README 推荐的「三步接入」标准形态：

```ts
// D:\dsh-plugin\dsh-opencode-palette\runtime\host.ts:439
const update = createHostUpdate(
  { ctx, logCtx: { fire: (level, event, fields) => hostLog.store.log(level, event, fields) },
    readerOverrides: Object.assign({ runningVersion }, extraOverrides) },
  { pluginId: PLUGIN_ID, prefix: PHONE_PREFIX, targetPackageName: TARGET_PACKAGE_NAME },
)
```

→ 用它测，测到的就是本包行为；用 prompt/im-companion 测，测到的是它们各自的定制层。

**排除理由**：
- `dsh-prompt`：内联 vendor + 自定义桥，今天日志里只有 6 条 host.call + 1 条 install.exec（warn）+ 2 条 route.fail，别的全被吞；拿它当载体等于测它的桥。
- `dsh-im-companion`：自有事件命名与日志格式，没有 `wire.ready`，升级失败细节只在 `host.update.tap` 的 JSON 字符串里；今天还出现同秒「成功/失败」并存、state 不更新。
- `dsh-mattpocock-skills-deck`：`link:D:/…` 安装形态，更新通道会被判 `dev-source`/`source-install` 直接拦，装不了。
- life-pack 六件套：批量路径专用，日常回归噪声太大（单插件单日 300+ 行日志、7 个命名空间），且本地无源码不能发测试版；**只用于批量场景的专项验证**。

---

## 2. 被测模块边界

被测对象是本包，不是 palette：

- 宿主：`createHostUpdate`（status/check/install/changelog 四电话 + logAppend）、`createMultiHostUpdate`（批量五电话）
- 核心：reader（环境/已装/在册/指纹）、judgment/conclusion、executor（三条安装出口）、queue/lock、disk/store、job 状态机
- 更新日志：`CHANGELOG.md` 解析/校验/区间/渲染
- 面板：`mountUpdatePanel` / `mountUpdateEntry` / 批量面板 / 槽位安装按钮
- 日志内核：事件契约、边沿、落点归属、噪声预算、脱敏

palette 只作为「宿主适配层 + 触发面」，不测它的主题引擎。

---

## 3. 分层测试结构

### L0 单测/契约（本仓，秒级，CI 必跑）

现有就用：`npm run typecheck`、`npm test`、`npm run test:batch`、`npm run check`、`npm run smoke:log`、`docs:log:check`、`gate:bilingual`。

**新增回归用例（对着 2026-10-20 审计发现的洞，先红后绿）**：

| 编号 | 用例 | 期望（目前会挂的点） |
| --- | --- | --- |
| R1 | 同一宿主实例连续 N 次 `updateStatus`（含「每电话新建 reader」与「共享 reader」两种装配）→ `update.status.changed` 相邻相同元组行数 | 0（今天 life-* 单日 37–49 条重复） |
| R2 | `readChangelog` 未命中 / 命中缓存 / 空文件 / 取数失败四条路径 | 各至少 1 行 `update.changelog.parse`（今天整机 0 行，31 次电话） |
| R3 | `update.install.retry` 行形状 | 必带 traceId/spanId/seq（今天 7 行缺） |
| R4 | `update.install.verify` 与 `install.exec` 因果关系 | 同 trace、verify 在 exec 后（今天出过 verify 早于 exec） |
| R5 | `batch.summary` 与 `pendingRestart` | 要么加字段要么 guard 文档化 ok 含 restart-required（今天 ok:7 掩盖 7 个待重启） |
| R6 | `selfCopyLevelOf()` 对 pnpm 虚拟店路径 `…/node_modules/.pnpm/x@v/node_modules/x` 的判定 | 判 profile（今天 life-*/palette 全天报 nested） |
| R7 | 版本一致性：pack 后 tarball 内 package.json、dist 常量、CHANGELOG 顶版一致；profile 声明/lock/实装三方一致 | 今天 `package.json 0.18.33 / lock 0.18.32 / 实装 0.18.32` |

### L1 消费者宿主进程内集成（palette 仓，秒级，CI）

基座直接复用 palette 的 `tests/update-panel.test.ts`「宿主半真机式冒烟」：`DSH_HOME` 指临时目录 → `apply(ctx, { readerOverrides })` 装配 → 假 connection 拿到注册的 route → 直接调 routeFetch。

新增 `tests/update-flow.test.ts`（palette 仓，消费方视角黑盒）：

- **注入**（`readerOverrides` 是 palette `apply` 对测试开放的合法口）：`fetchImpl`（假 registry 响应）、`readInstalled`、`readJob`/`writeJob`、`tryAcquireLock`/`releaseLock`/`tryAcquireGlobalLock`、`runInstall`（成功/非零退出/超时/崩/抛错）、`now`、`randomId`
- **驱动**：`POST /api/opencode-palette`，body 形如 `{rpcId:"t1", type:"client-request", payload:{method:"palette.updateCheck", payload:{trigger:"panel"}}}`（phone 名从 `buildClientPhoneNames('palette')` 取，不写死）
- **断言**：
  - 电话回包（snapshot/receipt/diag）
  - `<临时 DSH_HOME>/logs/dsh-opencode-palette/<date>.log` 的行序列、字段、枚举、边沿、噪声
  - `<临时 DSH_HOME>/updates/dsh-opencode-palette/<hash>/state.json`
  - 面板 SSR（沿用 palette 的 renderPanel 手法）
- **覆盖**：H1–H4、F1–F3、F5、F7–F10、F12、F13 的大部分，不需要真 registry/真安装。

注意：palette 生产代码不传 `registryUrl`（走 npm 默认源）。L1 用假 `fetchImpl` 可以绕开；不修改 palette 生产代码。

### L2 真实宿主端到端（临时 DSH_HOME + 本地 mock registry + dsh CLI，分钟级，nightly）

> 先做一次可行性冒烟：`$env:DSH_HOME=D:\tmp\…; dsh plugin --profile web add …; dsh web --port <free>` 能无头启动且 `/api/opencode-palette` 可达。若 `dsh web` 不便无头驱动，本层降级为「CLI 宿主 + 直连电话」或归到 L3。

- **环境**：临时 `DSH_HOME`（每场景全新）、`dsh plugin --profile web add <target>@<old> --registry=<mock>`、`dsh web --port <free>`（临时 profile 没有 pluginManager → `hostKind=cli`，走 `cli-process` 安装路由，正好覆盖第三条出口）
- **mock registry**（`scripts/e2e/mock-registry.mjs`，~150 行 Node HTTP server）：
  - `GET /<pkg>/latest`、`GET /<pkg>/<version>`（packument）
  - `GET /<pkg>/-/<pkg>-<version>.tgz`（可带 integrity 校验）
  - 可按场景开关：5xx / 超时 / 坏 JSON / 超大 body / 版本不存在 / prerelease latest / engines 不满足 / integrity 被篡改
  - 契约提醒：check/install 只要求 tarball 与 registry 同 origin；**更新日志取 tarball 强制 https**，http 源会 `fetch-failed`（这本身是一条可断言用例）
- **驱动**：PowerShell/Node POST `/api/opencode-palette`；必要时直接 `dsh plugin add` 模拟宿主安装
- **覆盖**：H1、H2、F4（宿主拒绝）、F5（真实子进程非零退出/超时）、F6（安装中 kill 宿主）、F7、F8（TTL 调小）、F11 部分、重启后 up-to-date 闭环
- **palette 的 registryUrl 问题**：palette 生产代码没有 registryUrl 注入口。二选一：
  1. **推荐**：L2 用自建 fixture 消费者（复制 palette 的 `apply()` 最小接线 ~60 行，把 `registryUrl: process.env.DSH_UPDATE_TEST_REGISTRY` 传给 `createHostUpdate`，随包发 mock registry）；palette 不脏、只做 L1/L3。
  2. 或在 palette 测试分支加一行 env 注入（测试分支不发版）。
  批量场景：用 life-pack 六件套在真机手工走查（无源码，不能发测试版），或 L0/L1 的 batch harness。

### L3 真机演练（真实 desktop-manager，人工窗口，发版前 + 每周一次）

- 备份真实 profile（`package.json`、`pnpm-lock.yaml`、`node_modules/dsh-plugin-update`、`updates/`、`logs/`）
- 发布测试版到 npm `test` dist-tag（本包 `0.18.34-test.x` + palette `2.1.7-test.x`，或仅 palette 带新依赖）
- 真机面板点更新，观察：入口件五态 → check → install（desktop-manager 的 `already-installed`/`bundle-in-use`/两步移除重装）→ restart-required → 重启 → up-to-date
- 覆盖：真 `pluginManager` 出口、`restart-required`、批量面板（life-pack）、日志落点/噪声
- 测完回滚，并跑 audit 脚本对真实日志做一次契约巡检（应为 0 违规）

---

## 4. 场景矩阵

| 编号 | 场景 | 层 | 怎么造 | 关键断言 |
| --- | --- | --- | --- | --- |
| H1 | 未安装 → 首次安装 | L1/L2/L3 | temp profile 无目标包 | `install.exec ok` → `install.verify completed`；`identity`=first-install；state=completed |
| H2 | 已装旧版 → 安装新版 → 待重启 → 重启 → 最新 | L1/L2/L3 | mock registry old/new | restart-required → 重启后 `wire.ready` + `status.changed up-to-date` + `check.done jobState=completed` |
| H3 | 已是最新（no-op 点击） | L1/L2 | latest=current | 无 install.* 行；按钮禁用/文案；`check.done` ok |
| H4 | 更新日志四态（有/无/空/超大/坏格式/区间） | L1/L3 | 新版 tarball 换 CHANGELOG | `changelog.parse` 一定有行且 status 正确；面板渲染/中性提示；yanked 横幅 |
| H5 | 入口件/面板五态 + 失败文案 | L1/L3 | 注入各 snapshot | 活任务>待重启>失败>新版>空闲；全部 blocked/failure 码有中文 title+action |
| H6 | 批量：全部更新/失败继续/停/取消/续跑 | L1/L3 | batch harness / life-pack | batch.entry.request/run.start/summary + entry.fail 落点；`stoppedBecause` |
| F1 | check 网络失败/超时/5xx/坏 JSON/超大 | L1/L2 | mock registry 注入 | `check.fail.errorKind` ∈ 契约枚举；面板错误页/复制诊断 |
| F2 | 版本不存在/通道不符/prerelease latest | L1/L2 | mock latest 被撤/预发布 | `invalid-release`/`channel-mismatch`；stable 不收预发布 |
| F3 | engines 不满足（node/dsh） | L1/L2 | packument engines | `incompatible-node`/`incompatible-dsh` |
| F4 | 宿主拒绝：bundle-in-use / already-installed / not-removable | L2/L3 | 真 desktop-manager；包在跑 | `install.fail` stage/code；两步移除重装；手工命令可执行性 |
| F5 | 安装非零退出/进程崩/超时 | L1/L2 | 假 runInstall / fixture 包 postinstall 失败 | `reason`=nonzero-exit/crashed/timeout；verify failed；state failed |
| F6 | 安装中 kill 宿主 → 重开 | L2 | 安装时 kill | state=interrupted/recovery-required；重启后不误判 |
| F7 | pending-restart 状态下再点安装 | L1/L2 | H2 后不重启再点 | 被拦 + 原因；无重复 install 行 |
| F8 | check-expired（凭证过期） | L1/L2 | TTL 调小后点安装 | gate-refused → 自动重查重提（retry 行）；最终成功或诚实失败 |
| F9 | 并发：连点/多插件/队列/lock | L1 | 并发跑电话 + 跨插件队列 | `update-busy`；queue.transition 相位边沿；lock anomaly 不刷屏 |
| F10 | 降级/同版本/源安装（link） | L1/L2 | link 安装 target | `noop`/`dev-source`/`source-install` |
| F11 | 日志取数失败（tarball 404/integrity 不符/8MB/32MB 墙） | L1/L2 | mock 篡改 | `changelog.parse.status=fetch-failed`；不挡安装 |
| F12 | 落点异常（只读目录/switch off/多写者） | L1 | 权限/开关 | `update.log.degraded` reason 正确；`logHealth` 回包 |
| F13 | 本包自身升级（版本口径） | L2/L3 | palette 新依赖新 updater | 装后 `wire.ready.updaterVersion`=目标；profile 声明/lock/实装三方一致；重启后新副本生效 |

---

## 5. 日志契约门禁（每个场景跑完必过）

把现有审计脚本升级为断言库 `scripts/e2e/assert-logs.mjs`（复用 `event-list.update.json` 与 `src/core/gate.ts` 口径）：

1. **事件/字段/枚举/级别**：表外 → FAIL（含 unknown-field / invalid-enum）
2. **边沿**：`status.changed` 相邻相同元组=0；`queue.transition` 相邻同相位=0；`changelog.parse` 同 (version,status,cached) 相邻≤1
3. **噪声预算**：稳态 ≤50 行/天/插件、操作日 ≤500；`host.call.fail` 心跳 ≤12/h
4. **脱敏**：行里无盘符/绝对路径/命令原文/完整 URL（`registryHost` 白名单主机名允许）
5. **归属**：批量行→属主目录；`batch.entry.fail`→失败方目录；队列行→动作方目录
6. **自监控**：非注入场景 `update.log.degraded`=0
7. **三方一致**：`state.json` ↔ 磁盘 package.json ↔ 重启后运行版本
8. **面板快照**：入口件/面板 SSR 断言（沿用 palette `renderPanel` 手法），遮挡/折叠/五态

---

## 6. 环境与隔离规范（必须先立）

- 一切自动化测试只用**临时 `DSH_HOME`**；禁止写真实 `C:\Users\辰辰洋洋\.dsh\logs`（上一轮已发现 18 个夹具命名空间被写进真实家目录，life-a 累计 30736 行）。
- mock registry 端口随机、每场景重置；版本号带场景前缀（`0.0.0-<case>` 的稳定三段）。
- 真机演练前备份/演练后回滚；真实日志只读审计。
- 失败注入只对 fixture 包/ mock registry 做，不篡改真实插件包。

---

## 7. 执行节奏

| 时机 | 跑什么 |
| --- | --- |
| PR | L0：`npm run check` + `smoke:log` + R1–R7 |
| 每日/nightly | L1 全场景（palette 仓 `update-flow.test.ts`）+ L2 关键 8 场景（H1/H2/F1/F4/F5/F6/F8/F13） |
| 发版前 | `npm run check` + `smoke:log` + L2 全量 + L3 真机演练（palette 测试版 + 备份回滚）+ 人工面板走查 |
| 发版后 | audit 脚本对真实日志巡检一次（0 违规才算完） |
| 消费方发版前 | palette 仓 `npm test`（含 update-panel/update-flow）+ `scripts/rebuild-event-list.ts` 检查清单漂移 |

**验收标准（全绿口径）**：全部场景通过；日志契约 0 违规；state/磁盘/运行版三方一致；上一轮审计 5 个 P1 全部回归（P1-4 属消费者侧，以「消费方接入验收清单 + 文档」结案）；噪声预算达标。

---

## 8. 交付物（建议按顺序）

1. **本仓** `scripts/e2e/assert-logs.mjs`（日志断言库，先喂给 L0/L1）
2. **本仓** `tests/log-regression.test.mjs`（R1–R7，红→绿）
3. **palette 仓** `tests/update-flow.test.ts`（L1 黑盒，消费方视角）
4. **本仓** `scripts/e2e/mock-registry.mjs` + `tests/e2e/fixtures/consumer`（L2 fixture 消费者，`registryUrl` 走 env）
5. **本仓** `scripts/e2e/run-l2.mjs`（临时 DSH_HOME 编排：装旧版 → 起宿主 → 驱动 → 断言 → 重启 → 收 artifact）
6. CI nightly workflow + `npm run e2e:quick` / `e2e:full`
7. `docs/maintainers.md` 链接本方案；README 加「集成自测」一小节
8. 真机演练脚本/checklist（备份 → 发 test tag → 面板点 → 重启 → 回滚 → audit）

---

## 9. 风险与边界（如实登记）

- mock registry 是 http：更新日志 tarball 取数契约要求 https → 该场景在 L2 只能断言 `fetch-failed`；真 https 场景放 L1（假 fetchImpl）与 L3（真 npm）。
- 官方桌面版没有「重启」能力，只回 `restart-required`：L2/L3 用「重启宿主进程」模拟，别在测试里假装宿主会自己重启。
- `dsh web` 无头驱动需先冒烟验证；不行则 L2 降级为 CLI 宿主直连电话，或整体归 L3。
- palette 生产代码不注入 registryUrl：L2 用 fixture 消费者最干净；若坚持用 palette 做 L2，需加一行测试分支 env 注入。
- 临时 profile 是 `hostKind=cli`（无 pluginManager），desktop-manager 的 already-installed/bundle-in-use 两步通道只有 L3 真机覆盖。
