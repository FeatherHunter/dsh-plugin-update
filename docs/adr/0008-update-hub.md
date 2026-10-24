# 8. 更新中枢：自更新不断链 + 全局进度

- 状态：accepted（实现见 `src/core/hub/`、`src/host/hub/`、`src/panel/batch/dock.ts`；票 #246–#252）
- 日期：2026-10-24
- 关联：真机故障（爱生活 0.3.85 批量更新面板：`饼干记账` 正在安装、`卡路里/备忘录/作息管家/居家管家/私家大厨` 停在「已在队列」；盘上 `update-queue/<指纹>/life/batch.json` 停在 `life-pack: current`）· 研究 `docs/research/20261024-更新机制现状调查.md`（§3/§5/§10）· ADR-0003 · ADR-0004 · #219 · 宿主安装出口契约 `docs/host-install-exits.md`

## 背景

批量更新面板由 `dsh-life-pack`（爱生活）挂在设置页 `settings.section`，驱动器跑在它自己的宿主 fiber 里；`selfOrder: 'first'`（#219，用户要求本体作第一行）让「显示第一行」等于「第一个执行」。更新自己时，`src/core/executor.ts` 的 `runDesktopManager` 按宿主 two-step 配方先 `removeBundle` 再 `installBundle`：提供面板与驱动闭包的 bundle 被卸载，fiber 被销毁，`installPhone` 里那段 `driveLocked → runBatch` 循环随之中断，剩下 5–6 家停在 `pending`/`ready`。宿主侧没有自愈：`getBatchHost` 只在电话进来时懒创建、`drain` 默认关、`batchResume` 与 `autoResume` 只在客户端挂载时触发。于是用户必须重开爱生活面板再点一次「继续上次未完成的更新」。

第一性看，这不是「排序问题」，而是**执行者的生命周期被绑在了一个会被自己替换掉的插件实例上**。批量推进的本质是「持久会话 + 单步执行」的循环：只要会话在盘上、执行能力与宿主对象解绑，任何还活着的进程内持有者都能接着推。用户三个设想（DSH 级共享更新需求、常驻队列 UI、失败隔离）都指向同一件事：把「谁在推进」从插件实例上提到进程级。

## 决策

### 1. 进程级更新中枢（Hub）

- 引入 `Hub`：进程级单例，挂 `globalThis[Symbol.for('dsh-plugin-update:update-hub:registry')]`，按使用范围 `(homeDir, profileDir)` 分槽。`Symbol.for` 是 realm 级注册表，同一进程里本包的多份副本也能拿到同一对象。
- 中枢持有：驱动泵、定时器、订阅者、租约、方案登记表。插件 fiber 只做「提交任务 / 查询快照 / 取消」三件事，不再亲自跑循环；fiber 被销毁，泵照跑。
- 中枢不注册成宿主服务——不依赖「谁先注册、注册在哪」的鸡生蛋；也不要求 DSH 提供新 API。
- 协议版本写在对象上（`protocol: 1`）。版本不一致时后来者只观察、不接管，避免两代实现互踩。

### 2. 执行席（Seat）：闭包与 ctx 解绑

- 中枢续跑需要的一切宿主能力在**提交任务时**固化成普通闭包：插件管理器 / 子进程 / 桌面服务引用、使用范围身份、目标清单、执行器。宿主根服务不随某个 bundle 卸载而失效，所以 fiber 销毁后这些引用仍可调用。
- 席位由 `src/host/hub/protocol.ts` 的 `HubSeat` 定型，实际装配点在 `src/host/batch/fan-out.ts` 的 `hubSeatFor(session)`；批量面板路径与孤儿接管路径共用这一套装配，不写两份。
- `createHostUpdate` 在创建时就把 `ctx` 能取到的宿主服务引用塞进 `readerOverrides`，避免读取器在 fiber 死后才去 `ctxService` 现取。

### 3. 中枢方案（Plan）：可被任一存活集成方接手的持久任务书

- 路径：`<家目录>/update-queue/<使用范围短指纹>/hub/plans/<属主前缀>.json`（`hubPlanFileName(owner)`，属主即 ADR-0003 的批量前缀）；内容：`{version, sessionId, owner, selfKey, selfOrder, stopOnFailure, targets[{key,title,packageName,pluginId,prefix,homeDir?,profileDir?}], scope{homeDir,profileDir,profileName,environmentKind?,releaseChannel?,registryUrl?}, createdAt, updatedAt}`。
- 方案只说「装什么、装到哪、从哪个源查」，不记进度；进度唯一真相仍是各属主 `batch.json`（ADR-0003 不变）。
- 任一使用本包的插件在挂载时调用 `hub.activate()`（实现名 `adoptOrphanSessions()`，`createMultiHostUpdate` 装载末尾异步触发）：扫描方案，发现「会话未收尾 + 租约空闲/陈旧」就按通用席位接管续跑 → 覆盖进程重启、崩溃、换执行者三种断链。

### 4. 单写者：中枢租约 + 既有全局锁分工

- 中枢租约 `<queueDir>/hub/lease.json`：`{version, driverId, pluginId, pid, startedAt, heartbeatAt, generation}`。每推进一步心跳一次（`HUB_LEASE_HEARTBEAT_MS = 5s` 节流）；心跳陈旧（`HUB_LEASE_STALE_MS = 20s`）或同机 pid 已死则允许接管，接管者把 `generation + 1`；释放只认自己的 `driverId + generation`。
- 安装本身的互斥仍复用 `queue.json + global.lock`（同一使用范围一次只装一个，ADR-0003 §4 一个字不改）。两层职责不重叠：租约管「谁在推进会话」，全局锁管「谁在写盘装包」。
- 同一进程内中枢天然串行（单泵 + 单 Job 队列）。

### 5. 推进算法：单泵、逐会话、每步落盘

- 中枢维护任务表 `HubTask[]`；任务状态 `queued | running | settled`，结果 `done | queued（让位，不算失败）| failed`；FIFO 取「最早入队且会话未收尾」者。
- 每个 tick：读最新会话 → `runBatch(maxSteps: 1)` → `save` → 按 `decideHubCycleVerdict` 决定「继续 / 让出并退避 / 收尾 / 置失败」。每步都落盘，全量复用既有驱动器与两段式语义（ADR-0004）。
- 失败隔离：单个任务抛错只把该任务置 `failed`（会话原样保留、可再次续跑），泵继续下一个；单目标失败仍走既有 `stopOnFailure = false`「继续下一家」；`queued` 不是失败，回 `ready` 让出队首并短退避，等待者拿到 `queued` 而不是挂死。
- 看门狗：每周期总步数上限 `HUB_MAX_STEPS_PER_CYCLE = 2000`、连续无进展步数上限 `HUB_MAX_IDLE_STEPS = 10`，超限置 `failed` 并留一行既有日志口径的失败证据，绝不空转。

### 6. 只读电话 `<prefix>.updateHubStatus`

- 每套集成更新系统都注册一通只读电话 `<prefix>.updateHubStatus`，回 `{ok: true, snapshot}`：批量宿主只要识别得出使用范围就登记（`hub: false` 也登记并从盘上答；识别不出范围才不登记）；单插件宿主始终登记（句柄 `HostUpdate.hubStatus`，与批量侧同语义）。快照由磁盘聚合（中枢方案 + 各属主 `batch.json` + `inventory.json` + 没写方案的旧批账本 + 活租约判定的正在安装者），纯函数生成；中枢不在也能如实回答，**任何还活着的集成插件都能回答「全部插件的更新进度」**。
- 单插件链路 Phase 1 不注册这通电话、也不迁入中枢；面板与常驻 UI 只读这通电话，不推导、不写账。

### 7. 常驻更新队列 UI（可选、位置由集成方决定）

- `mountHubProgressDock(container, { call, prefix?, phone?, title?, pollMs?, mountAs?: 'bottom-right' | 'bottom-bar' | 'inline', hideWhenIdle?, collapsed?, maxRows?, lang?, onOpen? })`：轮询自己前缀的 `updateHubStatus`（缺省 1s，最小 250ms，页面隐藏时暂停），渲染行级明细（标题、版本箭头、相位、失败码、待重启汇总）与聚合百分比；`hideWhenIdle: false` 留空壳；`collapsed` 起步只留一行计数；`maxRows` 缺省 3、最多 20，超出折 `+K`；控制器 `refresh()` 与 `update()` 同义。只挂到调用方给的容器，不写 `document.body`、不占宿主未分配的槽；`dispose()` 只停轮询。
- 位置由集成方宿主的槽位决定（`shell.overlay` / `shell.bottom` / 任意容器）；本包给 `bottom-right` 的 CSS 形态。插件方不采用不影响别的插件采用——任一集成插件挂上即看全量。

### 8. 自更新顺序语义一个字不改

- 爱生活仍是第一行、仍第一个执行（用户明确要求）。中枢不靠调序规避故障，而是靠接管兜住故障。

## 不变量

- `batch.json` 仍是会话唯一真相；每步落盘、幂等编号、一次只装一个、失败继续下一家、跨 scope 拒绝、面板只渲染不推导。
- 中枢一切 I/O best-effort：方案/租约坏文件自愈（读坏当没有，写坏吞掉留既有 `store.fail`），绝不挡安装。
- 单插件更新链路 Phase 1 不迁入中枢（`updateHubStatus` 仍会显示 `queue.json` owner 指向的进行中安装）；不新增运行时依赖、不新增 package 子路径。

## 反向范围

- 不接管单插件更新的驱动；不做「显示顺序 ≠ 执行顺序」；不改 `selfOrder` 默认值。
- 不做跨机器共享；不做宿主级插件注册；不改 `batch.json` schema（方案是新增文件）。
- 不新开日志事件目录（Phase 1 中枢沿用既有失败口径，宁缺勿错）。

## 后果

- 正面：自更新后剩余目标由中枢自动续完；任一集成插件挂上常驻 UI 即看全局进度；进程重启后任一插件激活可接管孤儿方案。
- 代价与风险：「跨 fiber 调用宿主对象」需要真机验证（桌面 `pluginManager` 引用在 bundle 卸载后仍可调用）；多副本并存的租约边界；UI 轮询成本（1s，仅面板可见时）。
- 回退线：集成方传 `hub: false` 即关闭中枢，行为退回 0.18.39；删掉 `hub/` 目录等于未启用。

## 拆票

1. 纯逻辑：`src/core/hub/{plan,snapshot,drive-policy,lease-policy}.ts` + 单测（#247，已完成）。
2. 宿主装配：`src/host/hub/{json-file,protocol,plan-store,lease-store,registry,aggregate}.ts`（#248/#250，已完成）。
3. 接线：`src/host/batch/fan-out.ts` 执行席 / 方案落盘 / 提交中枢 / 孤儿接管（#249，已完成）。
4. 常驻 UI：`src/panel/batch/dock.ts` + 渲染/轮询单测（#251，已完成）。
5. 文档与门禁：README/CONTEXT/CHANGELOG；`npm run check`、`npm run test:batch`（#252）。
6. 对抗式审查（独立 reviewer）并落实修复（独立审查票）。
