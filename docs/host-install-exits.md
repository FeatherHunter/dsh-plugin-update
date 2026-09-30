# 三条安装出口的宿主契约（只读抄件）

本包把「装更新」交给宿主自己拥有的出口，一共三条路由。这份文件是它们各自契约的**只读抄件**：
本包不 import 宿主任何东西，只按这里写的形状调用；形状对不上就诚实失败转手工命令，绝不猜。

> 取证方式：2026-09-30 对本机官方桌面版做了一次**只读**解析（`D:\DeepseekHarness\resources\app.asar`
> 是单个档案文件，不是解包目录；下面 `asar:` 开头的路径与其行号都是**档案内**文件的行号）。
> 当时宿主内部版本为 DSH `0.2.0-rc.2`，宿主包 `@deepseek-ai/dsh-desktop-host`。
> 官方桌面版**没有** `.d.ts`（整个 `dsh/` 树里 0 个），最精确的契约是生成物里的内嵌声明。

## 出口一：第三方 Desktop（`desktopProfiles` ＋ `desktopPnpm`）

- 信号：宿主在 Loader entry 挂载前注册 `desktopProfiles` 服务；取用 `desktopPnpm` 要经嵌套
  `ctx.inject(['desktopPnpm'], …)`。
- 调用形：`desktopPnpm.runPlugin(参数数组, 使用范围目录, undefined)` → `{ done: Promise<{ exitCode }> }`。
- 已公开文档（本包依的契约）：
  <https://github.com/anywhere-labs/deepseek-harness-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/docs/plugin-services.md>
- 本包政策：桌面服务固定装进「当前激活的使用范围」，激活范围与本插件所在范围对不上时宁可不装
  （诚实失败转手工命令）。

## 出口二：官方桌面版（宿主进程内的插件管理器）

- 服务名 `pluginManager`，是 **root 级 cordis 服务**：普通插件上下文直接 `ctx.get('pluginManager')`
  即可取到（服务 fiber 处于 ACTIVE 时），不需要 `inject`。
  出处：`asar:dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:1379-1380`（构造即注册）；
  官方同进程消费者 `…/lib/types/tools.js:38` 就是 `const manager = ctx.pluginManager`。
- 挂载条件：profile 组合里那一行 `disabled: !!js "!ctx.get('profileContext')"`
  （`asar:dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:22`）。
  **注意**：这意味着普通宿主也可能挂载这个服务，所以本包不拿「有服务」单独当宿主判据。
- 签名：`installBundle(spec: string, options?: { enabled?, requestId?, approvedBuilds?, registry? })`
  → `Promise<ChangeResult>`；另有 `removeBundle(spec)` 与 `cancelInstall(requestId)`。
  出处：`asar:…/dsh-plugin-manager/lib/typert.host.js:795-799`（signature）、`:848`（InstallBundleOptions）、
  `:810`（cancelInstall）、`:836`（ChangeResult）、`:860`（ManagementError）、`:864`（PackageResult）。
- 返回形状（只抄本包用到的格）：
  - `application`：`applied`｜`restart-required`｜`overridden`｜`failed`｜`cancelled`；
  - `error`：普通对象 `{ code, diagnostic?, incompatible? }`，不是 Error；
  - `packageResult`：`{ exitCode, output, truncated, logPath, kind?, timedOut? }`；
  - 其余：`changed`、`stage`、`target`、`bundle`、`pendingBuilds`、`registries`、`failedAt` 等。
- **预期失败不 reject**：`application:'failed'` 是 resolve 出来的（`…/lib/types/index.js:814-835` 折叠
  `catch`）。只看有没有抛异常会把失败当成功——本包只按 `application` 判成败。
- `overridden` 是「改动已被保留、只是被别的层盖住」，当失败会让上层回滚一次已经落地的改动，
  所以本包把它算成功。
- spec 形状：**一个字符串**，形如 `包名@x.y.z`；包名必须匹配
  `PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/`（全小写，可带作用域），
  以 `-` 开头的整串直接 `invalid-spec`（`…/lib/types/install-spec.js:18-19`、`:57-86`；
  `…/lib/index.js:1708`）。规格整串作为**单个** `pnpm add` 参数传入（`:1749-1753`），
  **不接受任何开关**——`--save-exact`、`--registry=` 这类开关在这条路上没有位置。
- 源：`registry` 是**选项**不是开关（`…/lib/index.js:1738` 的 `registryPlan`）。本包把注入的
  `registryUrl` 作为该选项传入；没注入就不传，由管理器用自己的源策略（宿主路径总会注入，默认即官方源）。
- 超时与取消：管理器自己有静默超时（默认 600000ms，到点杀整棵进程树）与 profile 写锁等待
  （默认 120000ms，**这条会 reject**），没有整体墙钟。`cancelInstall(requestId)`
  → `{ status: 'cancelled' | 'too-late' | 'not-running' }`：`cancelled` 会等进程退出并把
  `package.json` / `pnpm-lock.yaml` 还原，原 promise resolve 成 `application:'cancelled'`；
  `too-late` 表示已进入应用阶段、改不动了。出处：`…/lib/index.js:1827-1839`、`:1356-1359`。
- 命令行在那台机器上**不适用**：`dsh` 在 boot 与 `plugin` 子命令都按名字（大小写不敏感）拒绝
  `--profile desktop`，唯一豁免是桌面自带的 CLI 载体
  （`asar:dsh/node_modules/@deepseek-ai/dsh/lib/bin.js:35-37`、`:112`、`:119`；
  `asar:dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js:91-104`）。
  ⇒ 拿它当兜底命令的可用性仍需现场确认（见票 #1 的待验证项）。

## 出口三：普通 DSH 宿主（自己起命令行）

- 调用形：`[当前运行时, …运行时参数, CLI 的 JS 入口, 'plugin', '--profile', 使用范围名, …参数数组]`
  —— 一律参数数组，不经 shell、不用 `PATH` 上的 `dsh` 命令名、不按系统分支。
- CLI 入口靠**反查**而不是猜：从 `process.argv[1]` 逐级向上找名为 `@deepseek-ai/dsh` 的包，
  且该文件必须正好是包声明的可执行入口；对不上返回 null，诚实失败。
- 这个出口对使用范围名为 `desktop` 的情形**一定失败**（出处同上），所以本包不会把官方桌面版
  路由到这里。

## 不确定与待现场确认

- 上面所有 `asar:` 行号是档案内文件的行号，磁盘上没有可比对的同名文件。
- 官方桌面版这条路由**尚未在真机点过一次「装上」**（本次修复只到库内测试与本地提交）。
- 命令行兜底在官方桌面版下是否可执行，证据与现场记录不一致，待现场确认（票 #1 的待验证项）。
