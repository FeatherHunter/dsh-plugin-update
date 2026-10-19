# 5. dsh-log 作为第一个运行期依赖：混合归属 + 每插件一棵日志目录

- 状态：accepted
- 日期：2026-10-14
- 关联：地图 [本包全面集成 dsh-log 0.3.1](https://github.com/FeatherHunter/dsh-plugin-update/issues/117) · 本票 [规格定稿](https://github.com/FeatherHunter/dsh-plugin-update/issues/119) · 调研 `docs/research/20261014-dsh-log-031-api.md` · `docs/research/20261014-update-logging-inventory.md` · `docs/research/20261014-dsh-host-logging-surface.md` · ADR-0001 · ADR-0003 · ADR-0006 · 事件目录 `docs/research/20261014-log-event-catalog.md`
- 决策来源：用户 2026-10-14 把本图的决策整体授权给执行会话（地图 #117 前提 1）

> 路径注：#220（2026-10-19）重构后 `src/` 已按域分目录、根只留入口壳；本 ADR 内 `src/...` 路径为决策当时位置，对照见 [ADR-0007](0007-src-directory-shape.md) 与[蓝图](../research/20261019-src-restructure-blueprint.md) §3。

## 背景

需求三条：每个环节的关键信息都要能打出来、第三方开发者能把日志交给我们、同一份 DSH 里多个使用本更新系统的插件日志不能相互覆盖。

三条硬事实决定了没有别的路可走：

1. **宿主不提供任何日志管道**（研究 R3）：asar 里 dsh-log 零命中；插件唯一官方 API 是 cordis `ctx.logger`，默认不输出到任何地方，只有 1000 条内存环形缓冲；插件 stdout 被丢（GUI 无控制台）；stderr 是一个 64 KiB 环形缓冲，全插件混流、无前缀，只在进程非 0 退出时才拼进错误消息；不存在 `DSH_LOG*`/`LOG_LEVEL` 开关。⇒ 想「借用宿主」落日志，没有可借的东西；多插件不覆盖也没有宿主保证。
2. **dsh-log 是官方既有引擎**（研究 R1）：五键行 `{v:3,ts,level,event,fields}`、按天文件 + 5 MB 封存 + 14 天保留、目录租约、`info` 准入、事件清单、读侧电话 + `dsh-log tail` 只读命令行、零运行期依赖。这些都自己写一遍是重复造轮子，而且读侧工具与别人的日志会分叉。
3. **0.3.x 与 0.2.x 断路**（研究 R1）：无 shim、无回退、旧行没有 `v` 键；而本机 profile 里唯一装着的 dsh-log 是 **0.2.2**（hoisted），别的插件（`dsh-opencode-palette` 装 0.2.2、`dsh-prompt` 装 `^0.2.1`）也还在 0.2.x 上。

本包此前的纪律是**运行期零依赖**（ADR-0003 以「运行期零依赖是本包纪律」为由否决引入 markdown-it）。那条纪律的动机是「集成方照文档装一个包就能用，不必替我解决依赖与版本」。接 dsh-log 会破掉它，所以本 ADR 把这件事显式立字：破的是形式，不是动机。

## 决策

### 1. 接 `dsh-log@^0.3.1`，进 `dependencies`（本包第一个运行期依赖）

- 取 `^0.3.1`：0.3.x 内部是兼容线，minor 可跟；不允许落到 0.4（那会是一次新的断路，另立决策）。
- 代价可控：dsh-log 自身零运行期依赖、`exports` 只有四个入口、`engines.node >= 22` 与本包一致（`package.json:11-13`）。
- 动机守住：集成方仍然只装本包一个包，dsh-log 由我们带进来，不需要他们做任何版本决策。

### 2. 落盘归属＝混合归属（外部实例优先，没有才自建）

| 情形 | 行为 |
| --- | --- |
| 集成方在 `createHostUpdate(deps)` 里传了 `logCtx` | **用它的实例**，本包绝不再对同一日志目录开第二个写者 |
| 没传 | 本包自建：`createNodeHostLog({ cacheDir: <homeDir>/logs }, { pluginId: 派生命名空间, prefix, logDirName: 派生命名空间, eventList })` |
| 建库失败（撞租约、拿不到 home） | 降级为 noop sink，记一条 `update.log.degraded`，**绝不外抛** |

判据一句话：**同一日志目录同时只许一个写者，本包永远只当第二个人的客人，不当第二个主人。**

### 3. 每插件一棵日志目录，落点与现场三家插件对齐

- 根：`<homeDir>/logs`（`homeDir` 沿用 `DSH_HOME` 环境变量优先、否则 `~/.dsh`，与 `src/config.ts:59` 同口径）。
- 日志目录：`<homeDir>/logs/<派生命名空间>/`；开关文件：`<homeDir>/logs/log-switch-<派生命名空间>.json`（把派生名当 `pluginId` 传给 dsh-log 即得）。
- 刻意**不用** dsh-log 的默认 `logs-<pluginId>`：现场已有 `logs/dsh-opencode-palette/`、`logs/dsh-prompt/` 两种惯例，本包跟随既有惯例，`dsh-log tail <DSH_HOME>/logs` 一条命令能横扫全部插件。
- 派生算法 `deriveLogNamespace(pluginId)`：小写 → 非 `[a-z0-9-]` 转 `-` → 折叠连续 `-` → 去首尾 → 截 32；**凡发生有损映射或截断，改为 `<slug 前 24>-<sha256(raw) 前 6 位十六进制>`**；空结果回退 `plugin-<hash6>`。
  - 为什么必须有损分支加 hash：`assertPluginId`（`src/config.ts:80-95` 区）允许大写与点，dsh-log 只收 `[a-z0-9-]{1,32}` 且**收到大写直接抛**；纯小写化会让 `My.Plugin` 与 `my-plugin` 撞成同一棵树，两个插件于是共享目录 → 触发「同一目录两个写者」，正是本需求要消灭的那件事。
  - 不变量：已经是 `[a-z0-9-]{1,32}` 的 id 原样通过；不同 raw id 永不映射到同一名字。
- `prefix` 默认仍是 `wf`（既有默认值，冻结面），但**不把 `wf` 用作 `pluginId`**：`wf` 是 dsh-log 的保留命名空间（`pluginId === 'wf'` 时目录退化成 `logs`，全家共用一棵树）。

### 4. 同进程多副本由登记表兜住，不由调用方自觉

dsh-log 的目录租约登记表是**模块副本级**的：同进程里两份 `dsh-log` 模块副本互相看不见，谁先建库谁就吃掉对方整份文件（实测：10 行剩 9 行）。本包被 hoist 成单副本是常态，但同进程已存在 `dsh-plugin-update@0.13.0`（顶层）与 `@0.12.0`（deck 嵌套）两份副本并存的现实。

所以本包在 `globalThis[Symbol.for('dsh-plugin-update.log.registry')]` 上放一张 `Map<日志目录 realpath, LogHandle>`，`acquire()/release()` 引用计数：**同一目录在本进程内只有一个 handle**，多副本拿到的是同一个；跨进程不做承诺（如实写进能力边界，不假装做到）。落点在实现票 W2。

## 被否方案（各一条理由）

| 方案 | 否决理由 |
| --- | --- |
| `peerDependencies`（让集成方自己装） | 0.3.x/0.2.x 断路而现场装的是 0.2.2 ⇒ 版本命中率靠运气；0.2.2 上本包的常驻事件与清单机制根本不存在，等于「装了但没日志」 |
| `optionalDependencies` / 动态 import + 静默降级 | 与 peer 同病，另外多一条「有的插件有日志、有的没有」的不可预测性；排查时最怕这种半有半无 |
| vendor 一份 dsh-log 进 `src/log/` | 与集成方实例、读侧工具、他人日志彻底脱节，还必然制造「同一目录两个写者」 |
| 自建落盘引擎（自己写 file sink） | 重复实现轮转/保留/租约/准入/清单/读侧工具；第三方拿到的日志格式与 dsh-log 分叉，`dsh-log tail` 用不上 |
| 只做注入（本包永不落盘，全靠集成方给 `logCtx`） | 大多数集成方不会给；且 W3 的常驻事件、W5 的清单、W4 的客户端通道全都落空 |
| 把 dsh-log 的读侧电话 `logQuery` 自动注册进宿主电话表 | 撞名会抛（`registerHostLogPhones` 撞名即错），且跨插件读默认 `denied`、要宿主显式授权——这不是本包该替集成方决定的事 |

## 反向范围

- 不自建引擎、不 fork、不 vendor、不写 0.2.x 兼容层。
- 不改宿主（GUI 日志面板、宿主日志开关都不在本图内，研究 R3 已证宿主没有这些面）。
- 不替集成方注册 dsh-log 的读侧电话；本包只发事件、只落自己的目录。
- 不动 `src/config.ts` 的冻结配置面（新增配置项另走破冰，见 W5）。

## 后果

- 正面：每个集成方自动获得「每插件一棵目录 + 独立开关 + 官方读侧工具」；第三方交日志只需一条 `npx dsh-log tail <DSH_HOME>/logs/<命名空间>`；多插件不覆盖有机制保证而非口头承诺。
- 代价：本包第一次带运行期依赖；`package.json files` 白名单与发布门禁要同步（W5/W7）。
- 已知风险（如实登记）：**跨进程**并发写同一日志目录（宿主与 sidecar 同时写同一插件）不在承诺内；dsh-log 自己的文档也把这条列为引擎边界。本包能做的只是在同进程内保证唯一写者，跨进程交给 dsh-log 的租约与 `log.persist.fail reason:'foreign-write'` 事后诊断。
- 回退线：若 0.3.x 出现断路级缺陷，本包可退回「只注入」形态（决策 2 的第一行本来就是常态路径），已落盘目录格式不变、无数据迁移。
