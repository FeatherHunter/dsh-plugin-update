# minimumReleaseAge：bypass（调低/豁免年龄门）vs fallback（装超 24h 最新版）一手来源调研

- 日期：2026-10-16
- 范围：只认一手来源（pnpm 官方文档、npm registry 官方 API 文档、deepseek-harness 官方仓库文档/源码、registry 线上实测）。每个关键结论后跟来源。
- 背景（已查实，本报告不再重查）：DSH 桌面宿主用 pnpm `minimumReleaseAge` 拦太新的包；宿主 profile 的 `pnpm-workspace.yaml` 里已有 `minimumReleaseAgeExclude` 白名单；安装执行方是宿主 plugin-manager（`@deepseek-ai/dsh-plugin-manager`，官方包），dsh-plugin-update（社区包）零安装执行代码，只做检查/面板/诊断。

## 1. pnpm `minimumReleaseAge` / `minimumReleaseAgeExclude` 准确语义

### 1.1 `minimumReleaseAge`：按分钟计的发布时间门，覆盖全部依赖（含传递依赖）

- `minimumReleaseAge` 定义"版本发布后必须经过的最少分钟数"，只有足够老的版本才会被安装；**适用于全部依赖，包括传递依赖**；不适用于以 `version+integrity` 锁定的 config dependency（来源：[pnpm 官方文档 dependency-resolution#minimumreleaseage](https://pnpm.io/settings/dependency-resolution#minimumreleaseage)）。
- 默认值 **1440（1 天，自 v11 起；v11 之前默认为 0）**，类型为分钟数，v10.16.0 引入（来源：[同上](https://pnpm.io/settings/dependency-resolution#minimumreleaseage)）。
- 官方给出的安全理由原文含义：为降低装到被投毒/缺陷包的风险；实践中恶意 release 通常一小时内被发现并从 registry 下架（来源：[同上](https://pnpm.io/settings/dependency-resolution#minimumreleaseage)；另见 [supply-chain-security#delay-dependency-updates](https://pnpm.io/supply-chain-security#delay-dependency-updates)，其中写"delaying updates by 24 hours will most likely prevent you from installing a bad version"，默认 1440 即 1 天）。

### 1.2 `minimumReleaseAgeExclude`：豁免粒度是"包名 → 该包全部版本"，另支持 scope 通配与精确到版本

- 基础粒度：**按包名**，列出的包"其全部版本"豁免年龄检查（来源：[dependency-resolution#minimumreleaseageexclude](https://pnpm.io/settings/dependency-resolution#minimumreleaseageexclude)，原文 "The exclusion works by package name and applies to all versions of that package"）。
- v10.17.0 起支持 scope/pattern（如 `'@myorg/*'`）（来源：[同上](https://pnpm.io/settings/dependency-resolution#minimumreleaseageexclude)）。
- v10.19.0 起支持**精确到版本**的豁免（`nx@21.6.5`、`webpack@4.47.0 || 5.102.1` 这类析取写法）（来源：[同上](https://pnpm.io/settings/dependency-resolution#minimumreleaseageexclude)）。——宿主现有"逐版本放行"白名单用的正是这一档能力。
- v11.22.0 起有 `minimumReleaseAgeExcludePrune`：为 `true` 时 install/add/update/remove/dedupe 会剪掉 lockfile 已不再解析的陈旧条目；name pattern（如 `@myorg/*`）永远保留；`sharedWorkspaceLockfile: false` 时跳过清理（来源：[dependency-resolution#minimumreleaseageexcludeprune](https://pnpm.io/settings/dependency-resolution#minimumreleaseageexcludeprune)）。

### 1.3 失败语义：`minimumReleaseAgeStrict`（显式配置即默认 fail-closed）

- 无满足年龄约束的版本时：`false` = 回退装一个"太新"的版本以保证安装成功；`true` = 直接 fail resolution（来源：[dependency-resolution#minimumreleaseagestrict](https://pnpm.io/settings/dependency-resolution#minimumreleaseagestrict)）。
- 默认值关键细节：**显式配置了 `minimumReleaseAge` 时默认为 `true`，否则为 `false`**（内置的 1440 默认值是非 strict 的，为向后兼容）（来源：[同上](https://pnpm.io/settings/dependency-resolution#minimumreleaseagestrict)）。——宿主 profile 显式配了该策略即处在 strict 档：太新的包不是"装旧版"，而是"装不上"。
- registry 元数据缺 `time` 字段时：`minimumReleaseAgeIgnoreMissingTime` 默认为 `true`（跳过检查；设 `false` 则 fail）；v11.23.0 起该开关同时管 `trustPolicy`（来源：[dependency-resolution#minimumreleaseageignoremissingtime](https://pnpm.io/settings/dependency-resolution#minimumreleaseageignoremissingtime)）。
- `trustLockfile: false`（默认）：每次 install 把 `minimumReleaseAge`/`trustPolicy` 重应用于 lockfile 全部条目做供应链复验；官方警告设为 `true` 后"被投毒的 lockfile 可能蒙混过关"，外部协作者能改 lockfile 时必须保持 `false`（来源：[dependency-resolution#trustlockfile](https://pnpm.io/settings/dependency-resolution#trustlockfile)）。

### 1.4 谁应该拥有/编辑这个配置

- pnpm 的配置来源只有三处：命令行、环境变量、`pnpm-workspace.yaml`（来源：[pnpm settings(pnpm-workspace.yaml) 页首](https://pnpm.io/settings)）。`minimumReleaseAge` 系是"做安装决议的那个项目"的配置——实际安装都**在 profile 目录里跑 pnpm**（`pnpm view`/`pnpm add` 均以 profile 目录为 cwd，以便复用同一代理与鉴权，来源：[deepseek-harness packages/boot/plugin-manager/README.md L48/L54](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)），因此该配置的拥有者是**宿主/profile 拥有方**，不是社区插件。
- profile 写入是被串行化的：CLI 与 service 共享同一 profile manifest writer lock，防止并发包管理/清单写入（来源：[plugin-manager README L98](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)）；外部手改会被 HMR watcher 注意到并生成 patch，但**不经过 manager 的锁、失败回滚与变更广播**（来源：[同上 L60/L98](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)）。

### 1.5 官方对"调低/绕过年龄门"的安全立场：给了逃生舱，但默认与推荐都是开着门

- 官方在供应链安全页**明文记录了退出办法**：`minimumReleaseAge: 0` 即退出；也可加到 `10080`（等一周）（来源：[supply-chain-security#delay-dependency-updates](https://pnpm.io/supply-chain-security)）。——调低到 0 是文档化行为，不是 hack；但同一页把它放在"缓解供应链攻击" checklist 里，含义是**降级安全水位**：24h 等待是推荐基线，因为"registry 通常几小时内下架受影响版本，但发布→检出之间总有一扇暴露窗口"（来源：[同上](https://pnpm.io/supply-chain-security)）。
- fail-closed 是显式配置下的默认（见 1.3 strict），`trustLockfile` 的警告同理（见 1.3）。综合立场：**官方允许你关，但默认帮你开；关了之后投毒窗口的责任回到配置者身上**。

**对本仓库的直接含义**：bypass 路线（调低年龄门/往宿主白名单里加条目）在语义上完全可行（exclude 支持精确到 `pkg@version`），但配置的所有权在宿主方；社区包自己改宿主 `pnpm-workspace.yaml` 属于越权写（依据见第 3 节）。

## 2. npm registry：查某包各版本发布时间的一手接口

### 2.1 官方端点与"版本→发布时间"元数据

- 包元文档（packument）端点：`GET https://registry.npmjs.org/:package`（来源：[npm/registry REGISTRY-API.md Package Endpoints](https://raw.githubusercontent.com/npm/registry/main/docs/REGISTRY-API.md)；版本端点 `GET /:package/:version` 与搜索端点 `GET /-/v1/search` 见同一文档）。
- 各版本发布时间字段：完整 packument 顶层 `time` 对象，**每个版本号映射其发布时间，另带 `created`/`modified`**（来源：[npm/registry REGISTRY-API.md Objects/Package](https://raw.githubusercontent.com/npm/registry/main/docs/REGISTRY-API.md)；完整格式定义：[package-metadata.md Full metadata format](https://raw.githubusercontent.com/npm/registry/main/docs/responses/package-metadata.md)，其中 `time: an object mapping versions to the time published, along with created and modified timestamps`）。
- 精度/时区（线上实测 2026-10-16，包 `dsh-plugin-update`）：`time["0.18.5"]` 原始字符串为 `2026-10-16T10:45:36.782Z`，即 **ISO-8601、UTC（Z 后缀）、毫秒精度**。比较时用 epoch 毫秒，24h = 86_400_000ms，建议用"严格大于 24h"对齐 pnpm"必须经过"的语义（实测方法：`Invoke-WebRequest https://registry.npmjs.org/dsh-plugin-update` 默认 Accept 取完整文档后解析 `.time`；文档依据：[package-metadata.md](https://raw.githubusercontent.com/npm/registry/main/docs/responses/package-metadata.md)）。

### 2.2 请求形状：要发布时间必须拿完整文档，abbreviated 版没有 `time`

- 不带 Accept 头 → 返回完整文档；`Accept: application/vnd.npm.install-v1+json` → 返回 abbreviated 精简版，其顶层 allow-list 只有 `name`、`modified`、`dist-tags`、`versions`（及版本内安装必需字段），**不含 `time`**（来源：[package-metadata.md Abbreviated metadata format](https://raw.githubusercontent.com/npm/registry/main/docs/responses/package-metadata.md)）。
- 线上实测（同一包、2026-10-16）：abbreviated 版 28,716 字节、顶层字段恰为 `name, dist-tags, versions, modified`、`time` 为空；完整版约 134–169KB（含 readme）、`time` 存在（实测）。——"给用户装超过 24 小时的最新版"必须请求完整 packument（默认 Accept 即可），不能用 abbreviated 版。
- 大包警告：官方明言某些包的完整元数据未压缩超 10MB，"需要的信息若在 abbreviated 版里有就优先用它"（来源：[package-metadata.md](https://raw.githubusercontent.com/npm/registry/main/docs/responses/package-metadata.md)）。但发布时间只在完整版里，所以实现时要接受这个体积现实：对目标明确的小包（插件包）直接拉完整版；只取 `.dist-tags` 与 `.time` 两个键后即丢弃正文，不要全量缓存。

### 2.3 "超过 24 小时的最新版"算法（只用官方字段）

1. `GET https://registry.npmjs.org/<name>`（默认 Accept，完整文档）。
2. 取 `dist-tags.latest` → L（注意：语义最大版本 ≠ latest 标签所指，以标签为准；`versions` 键全集另可作兜底枚举）。
3. 取 `time[L]` → 发布时间 T；若 `now - T > 24h` 则 L 即所求。
4. 否则按 `time` 值倒序往前找第一个 `now - T > 24h` 的版本（实现细节，非官方规定，不标来源）。
5. 无任何版本满足 → 如实报告"暂无超 24h 可装版本"，**不要**自动降级去调宿主年龄门（策略依据见 1.5 与第 3 节）。

### 2.4 注意事项：缓存、时区、精度

- 缓存（线上实测响应头，2026-10-16）：`Cache-Control: public, max-age=300` 且带 `ETag`。含义：CDN 侧 5 分钟缓存，刚发布的版本时间戳有最多约 5 分钟的可见延迟；实现侧两次检查至少间隔数分钟，或带 `If-None-Match` 做条件请求（观测到的头即依据；端点与文档依据：[REGISTRY-API.md](https://raw.githubusercontent.com/npm/registry/main/docs/REGISTRY-API.md)）。
- 时区：一律按 UTC 解析（`Z` 后缀），不要按本地时区解读（格式依据：[package-metadata.md 示例](https://raw.githubusercontent.com/npm/registry/main/docs/responses/package-metadata.md) + 上述实测）。
- 精度：毫秒级 ISO 字符串；字符串比较不可靠，转 epoch 毫秒再减（实测 `…36.782Z` 即依据）。
- pnpm 侧粒度是**分钟**（`minimumReleaseAge` 单位为分钟，来源：[dependency-resolution#minimumreleaseage](https://pnpm.io/settings/dependency-resolution#minimumreleaseage)），dsh-plugin-update 的"24h"判断用毫秒比较更保守，与宿主门只会"更严不会更松"，方向安全。

## 3. DSH 社区插件能否写宿主 profile 文件（如 `pnpm-workspace.yaml`）

结论先行：**没有官方授权路径；技术上有条件可写（非安全边界），制度上不允许——profile 变更的唯一官方通道是 plugin-manager（Web 页 / `plugin_manager` 工具 / `dsh plugin` CLI）。** 依据逐条如下。

### 3.1 安装执行方是官方 plugin-manager；白名单/年龄门对其安装同样生效，manager 不会自动豁免

- 官方包 `@deepseek-ai/dsh-plugin-manager` 存在于 npmjs 公共 registry（线上实测：`latest 0.1.6-alpha.2`，维护者 `imccyu`、`tianyicui-deepseek`，属 `@deepseek-ai` 官方 scope；端点依据：[REGISTRY-API.md](https://raw.githubusercontent.com/npm/registry/main/docs/REGISTRY-API.md)）。
- 仓库内实现为 `packages/boot/plugin-manager`，拥有核心能力 `ctx.pluginManager`（"Current-profile plugin and bundle management"），且"installation goes through the plugin manager"（来源：[docs/capability-seams.md 能力表](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/capability-seams.md)）。
- 年龄门对 manager 的安装**同样生效且不自动豁免**：README 明文记录"装上的版本可能与 inspect 读到的不同，例如 pnpm 的 `minimumReleaseAge` 按住了一个刚发布的版本"（来源：[plugin-manager README L60](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)）。——这正是 fallback 路线要解决的痛点的一手证据。

### 3.2 官方变更通道：Web 插件页 / `plugin_manager` 工具 / `dsh plugin` CLI，全部汇入同一加锁操作层

- "Manage the current profile's plugins **without editing configuration by hand**"（来源：[plugin-manager README L14](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)）。service 与 CLI 共享 `operations.ts` 与 profile manifest writer lock；失败/取消的安装恢复 `package.json` + `pnpm-lock.yaml`（注意：**刻意不恢复 `pnpm-workspace.yaml`**，见下）（来源：[同上 L98/L104](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)）。
- `plugin_manager` 工具默认只在 Creator mode 启用，其余 preset 默认关闭；**每个工具动作要求 `danger-full-access` 或当次审批**（来源：[同上 L31](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)）。
- manager 的能力也有明文上限：不能禁用自身管理组件、不能改另一个 profile、不能改 agent preset 的 composition（来源：[同上 L141–144](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)）。——连官方 manager 都是受限操作集，社区插件更无写 profile 的授权位。
- 能力表里 `ctx.pluginManager` 的 Direct consumers 为空（只有 manager 自己与 UI 盘点页消费结果），插件侧没有"改 profile"的公开 ctx 可声明；插件消费的是**自己那份 Config 引用**（来源：[capability-seams.md `ctx.pluginManager` 与 `ctx.settings` 行](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/capability-seams.md)）。

### 3.3 技术上"能写"不等于"被允许"：沙箱是策略围栏，不是内核边界

- 装好的 Host 代码**在进程内、workspace 沙箱之外**执行（来源：[plugin-manager README L31](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)，"installed Host code executes in-process outside the workspace sandbox"）。
- 动态 cordis host half 跑在 `node:vm`  realm 里，但官方明言"**The sandbox isolates globals but is not a security boundary**… Treat a dynamic package like bash access"，其声明的服务（`ctx.fs` 等）直达 live runtime（来源：[packages/extensions/cordis-host-runner/README.md L12/L62](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/extensions/cordis-host-runner/README.md)）。
- 模型侧文件围栏（`fs-sandbox`）：`read-only` 拒绝一切变更；`workspace-write` 只放行 session workspace 根与系统临时目录之下——**宿主 profile 目录在其外，写 `pnpm-workspace.yaml` 会得到 `FS_SANDBOX_DENIED`**；只有 `danger-full-access` 不设限（来源：[packages/fs/fs-sandbox/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/fs-sandbox/README.md)）。围栏是"可信代码里的策略检查，不是内核边界"（来源：[同上](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/fs-sandbox/README.md)）。
- 官方安全总立场：项目未经过安全审计、不得视为安全或生产就绪；"untrusted plugins may damage the host… modify or delete files"；要求运行前审查插件、配置与命令（来源：[SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)）。

### 3.4 直接写 `pnpm-workspace.yaml` 的三条具体反依据

1. 绕过串行化锁：与 manager/CLI 的并发写会竞争 profile manifest writer lock（来源：[plugin-manager README L98](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)）。
2. 绕过失败回滚：失败的安装恢复 manifest+lockfile 但**刻意不动 `pnpm-workspace.yaml`**（pnpm 只在可交互提示时才写 `allowBuilds`，manager 自己记录批准名），手改白名单不受这套保护（来源：[同上 L64/L104](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)）。
3. 旁路可观测性：HMR watcher 注意到的外部手改只生成 patch，不发布 `plugin-manager/changed` 事件，页面下次读取才知道（来源：[同上 L60](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)）。

### 3.5 给 dsh-plugin-update 的路线裁决（bypass vs fallback）

- **bypass（调低年龄门 / 代写宿主白名单）：否决。** pnpm 官方虽允许关门（1.5），但配置所有权在宿主（1.4），且社区插件无官方写 profile 通道（3.2–3.4）。dsh-plugin-update 自身定位（`package.json`：宿主接线 + 面板组件 + 检查/诊断，零安装执行）与该定位一致。
- **fallback（用 registry `time` 元数据给用户装超 24h 的最新版）：可行。** 所需元数据全部来自 npm 官方接口（第 2 节），不碰宿主配置；年龄门对 manager 安装生效是官方书面行为（3.1），fallback 正是对该行为的适配而非对抗。
- 白名单运维建议：逐版本 `pkg@version` 豁免应由**宿主发版/profile 拥有方**维护（支持精确到版本与 `||` 析取，见 1.2；支持自动剪陈旧条目，见 `…Prune`），更新插件的职责止于"检出超 24h 版本 + 呈现 por qué 装不上 + 指引宿主加白"，不代写。

## 来源清单（本报告引用的一手来源）

- pnpm：
  - <https://pnpm.io/settings/dependency-resolution#minimumreleaseage>
  - <https://pnpm.io/settings/dependency-resolution#minimumreleaseageexclude>
  - <https://pnpm.io/settings/dependency-resolution#minimumreleaseageexcludeprune>
  - <https://pnpm.io/settings/dependency-resolution#minimumreleaseagestrict>
  - <https://pnpm.io/settings/dependency-resolution#minimumreleaseageignoremissingtime>
  - <https://pnpm.io/settings/dependency-resolution#trustlockfile>
  - <https://pnpm.io/settings>（配置来源三处）
  - <https://pnpm.io/supply-chain-security>（官方安全立场与 `minimumReleaseAge: 0` 退出办法）
- npm registry：
  - <https://raw.githubusercontent.com/npm/registry/main/docs/REGISTRY-API.md>（端点与对象定义）
  - <https://raw.githubusercontent.com/npm/registry/main/docs/responses/package-metadata.md>（完整/abbreviated 格式、`time` 定义、10MB 警告）
  - 线上实测 `GET https://registry.npmjs.org/dsh-plugin-update`（默认 Accept 与 `Accept: application/vnd.npm.install-v1+json` 对照，2026-10-16；响应头 `Cache-Control: public, max-age=300` + `ETag`；`time["0.18.5"]="2026-10-16T10:45:36.782Z" preview）
- deepseek-harness（均为 `master` 分支当时内容）：
  - <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md>（L14 手改禁令、L31 权限/in-process、L60 年龄门行为与 HMR、L64/L98/L104 锁与回滚、L141–144 能力上限）
  - <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/capability-seams.md>（`ctx.pluginManager` / `ctx.settings` / `ctx.profileContext` 能力归属）
  - <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/extensions/cordis-host-runner/README.md>（vm 非安全边界）
  - <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/fs-sandbox/README.md>（三档模式围栏语义）
  - <https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md>（实验状态、无审计、untrusted 插件警告）
