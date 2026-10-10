<!-- DSH-IDEMPOTENCY-KEY: prerelease-installed-unknown-profile-20261010 -->
## 实际（现象；影响范围）

- 在 DSH 桌面端使用范围里点开 `dsh-mattpocock-skills-deck` 的更新卡片（**档案卷**主题，报告人称「档案袋风格」），卡片直接判失败：

  > 更新失败（**unknown-profile**）：使用范围或插件位置认不出。
  > 重开宿主再查一次；一直这样就把版本号与日志交给插件作者；这种情形不给手工命令

- 同卡片头部「使用范围」一栏显示 **未知**，右侧宿主种类牌显示 `profile`。
- 该插件的已装版本号带预发布后缀：报告人现场为 `1.8.0-beta.3`；本机实测磁盘上是 `1.8.0-beta.1`。
- **影响范围**：凡是「已装的版本是预发布版（SemVer `X.Y.Z-ids`）」且集成方按缺省配置接入的插件，更新卡片会整体 blocked。不是偶发抖动、也不是这一个插件的毛病——缺省 `releaseChannel` 是 `stable`，任何预发布已装版都会命中同一条路。报告人描述为「点开更新按钮就是这个」。

## 期望（预期；与实际差异）

- 期望 1：更新系统应能识别 `1.8.0-beta.1` / `1.8.0-beta.3` 这类带 `beta.N` 后缀的当前版本（SemVer §9 预发布版），并据此给出「当前版本 / 是否有新版」。
- 期望 2：即使预发布版在缺省通道下不被接受，报出的码也应指向真正原因（版本通道），而不是 `unknown-profile`——后者的文案「使用范围或插件位置认不出」把用户引向使用范围与安装位置，而现场这两处其实都没问题（见「根因」第 4 条）。
- 与实际差异：**解析层其实认得 `beta.N`**（下方已实测），真正卡住的是「缺省 stable 通道不收预发布 → 推不出运行版本 → 建读取器时直接抛 `unknown-profile`」；面板又因为读取器没建出来而把「使用范围」显示成「未知」。

## 复现步骤（前置条件和场景 + 编号步骤；偶发写频率）

报告人填：打开更新按钮即见（档案卷主题），频率为必现。未给编号步骤。

机器侧已核实的现场（本会话实测）：

1. 使用范围：`C:\Users\辰辰洋洋\.dsh\profiles\desktop`（`package.json` 里 `dsh-mattpocock-skills-deck: 1.8.0-beta.1`）。
2. 目标包：`…\profiles\desktop\node_modules\dsh-mattpocock-skills-deck` = `1.8.0-beta.1`（hoisted，实体目录）。
3. 更新器：`…\profiles\desktop\node_modules\dsh-plugin-update` = `0.10.0`。
4. 集成方接线（本轮取证）：deck 的 `lib/updateFromPackage.js:122` 调 `createHostUpdate({ ctx, logCtx, readerOverrides: {} }, { pluginId, prefix })`；其调用方 `lib/index.js:323` 只传 `{ logCtx, ctx }`——**没有任何 readerOverrides**（无 `runningVersion`、无 `releaseChannel`、无 `profileName`、无 `profileDir`）。四个参数全部落到更新包的缺省。

编号步骤（待报告人确认是否即此路径）：打开更新面板 → 点该插件的更新卡片 → 卡片即显示上述失败。

## 环境信息（OS 版本 + 软件版本 + 运行环境）

- OS：Windows（用户目录 `C:\Users\辰辰洋洋`）。
- 运行环境：DSH desktop 使用范围 `profiles/desktop`（pnpm `nodeLinker: hoisted`，`node_modules/<pkg>` 单目录）。
- 更新器：`dsh-plugin-update@0.10.0`；集成方：`dsh-mattpocock-skills-deck`（1.8.0-beta.x）。
- 主题：档案卷（D5）。
- 报告人提到的 `1.8.0-beta.3` 与本机磁盘实测 `1.8.0-beta.1` 不一致，见「待补信息」第 4 条。

## 历史核查结论

- 关键词：`unknown-profile`、`使用范围`、`beta` / `预发布` / `prerelease`、`1.8.0`、`档案卷`；按当前后端（GitHub）搜已打开与已关闭（`gh issue list --state all`：97 张全量标题初筛 + 关键词命中正文）。
- 结论：**新增，不复用、不回归**。没有任何票提到「预发布已装版被 stable 通道挡在运行版本之外」，也没有票把 `unknown-profile` 归因到版本通道。
- 疑似点开正文后判定：
  - #3《自锚定导致「以 npm 依赖形态安装时，一键升级永久失效」：loaded 恒 null → 假的 installation-changed》（已关闭）：`unknown-profile` 这个码是它引入的**诚实失败**分支，但触发条件是「目标包定位不到」。本单实测**目标包按包名能定位到**（见「根因」第 4 条），故不是同一根因，属同码异因的第二次现场。
  - #92《更新面板05手工命令显示“当前没有可用的手工命令”，期望给出当前profile最新更新命令》（开放，`bug`+`needs-info`）：同属 `unknown-profile` 的下游（`src/commands.ts:189` 在该码下不给手工命令），但它问的是「为什么不给命令」，本单问的是「为什么成了 unknown-profile」。互为关联，不合并、不关闭；#92 正文里的 B 假设（`unknown-profile` 误判）正是本单要回答的。
  - #20《专业版：D5 档案卷主题进包》/#93《更新档案·卷主题安装横幅的副行提示溢出被裁断》（均已关闭）：只命中主题名，非同题。
- 关联：#3、#92（默认关联不关闭）。

## 根因（本轮做到代码级并对已发布 0.10.0 产物验证；未做活宿主端到端复现）

**一句话：`beta.N` 后缀在解析层认得，但缺省 `stable` 通道不收预发布版本，于是「运行版本」推不出来，建读取器时直接抛 `unknown-profile`。**

证据链（每一环可复核）：

1. **解析层：认得预发布版。** `validReleaseVersion` 接受 `X.Y.Z-ids`、`isPrereleaseVersion` 专判预发布（`src/service.ts:89-104`）。对**已安装的 `dist/service.js`** 实测：

   | 版本 | `validReleaseVersion` | `isPrereleaseVersion` | `stable` 通道 | `prerelease` 通道 |
   | --- | --- | --- | --- | --- |
   | `1.8.0` | true | false | **true** | true |
   | `1.8.0-beta.1` | true | true | **false** | true |
   | `1.8.0-beta.3` | true | true | **false** | true |

2. **通道层：缺省 stable 只收纯三段。** `isVersionAllowedInChannel(v, 'stable')` 即 `validVersion(v)`（`src/service.ts:107-110`）；`releaseChannel` 缺省 `'stable'`（`src/config.ts:145`）。

3. **运行版本被通道门控——抛错点在这里。**

   ```js
   // 已发布产物 dist/host.js:230-231（源码 src/host.ts:371-376 同形）
   const runningVersion = overrides.runningVersion ?? (loaded && isVersionAllowedInChannel(loaded.manifest.version, releaseChannel) ? String(loaded.manifest.version) : null)
   if (!runningVersion) throw unknownProfile()
   ```

   集成方没传 `overrides.runningVersion`，装着的又是预发布版 → 该表达式为 `null` → **抛 `unknown-profile`**。注意同一个码也用于「目标包定位不到」（`src/host.ts:385`），本单命中的是前一条支路。

4. **目标包这一路其实没问题（已排除）。** 从已安装更新器的位置按包名解析目标包，实测命中：

   ```json
   {
     "found": true,
     "name": "dsh-mattpocock-skills-deck",
     "version": "1.8.0-beta.1",
     "directory": "C:\\Users\\辰辰洋洋\\.dsh\\profiles\\desktop\\node_modules\\dsh-mattpocock-skills-deck"
   }
   ```

   所以既不是「按包名找不到目标包」，也不是「使用范围目录不存在」。

5. **「使用范围 未知」是抛错的连带结果，不是第二个故障。** 读取器在建出来之前就抛了 → `readEnv()` 无从运行 → 面板拿到空 profileName → 按 `src/panel.ts:1424-1442` 回落显示「未知」（字典键 `panel.meta.unknown`）。

**次生问题（同根因，未单独验证）**：若把第 3 步的抛错放开，`readInstalledReal` 还会在 `validPackage(installed, target, 'stable')`（`src/reader.ts:169`）判 false，走到 `invalid-installation`（`src/reader.ts:327`）——预发布已装包在缺省通道下还有第二道门。

**待定（属 triage / 设计决断，本单不预设）**：缺省通道该不该自动识别「磁盘上装的是预发布版」？还是把「版本不在通道内」与「位置认不出」拆成两个诚实的码？还是要求集成方显式传 `releaseChannel: 'prerelease'` / `runningVersion`？三个方向代价不同，须维护者拍板。

## 待补信息（本次未取证 / 只能报告人提供）

1. 宿主种类（第三方 Desktop / 官方桌面版 / 普通 DSH）与 DSH 版本。
2. 编号复现步骤：从哪个入口点开（插件自己的卡片 / 批量面板 / 详情弹窗）、是否点过「查新版」、同面板其他行是否正常、重启宿主后是否变化。
3. 复制诊断全文或 04 章快照（含 `blockedReason / running / installed / latest / source`）——用来与上面的代码级结论对表。
4. 报告人说的 `1.8.0-beta.3` 是「磁盘上已装的版本」还是「远端期望更新的目标版本」（本机磁盘实测 `1.8.0-beta.1`，`profiles/desktop/package.json` 也锁在 `-beta.1`）。

## 备注（工具与标签）

- 建票通道：本轮 `deck_context` / `deck_issue_list` 均被闸推迟（返回 `gate-defer`：读额度读数取不到 → 读让路、写保留）。根因在本机代理：`HTTP_PROXY` / `HTTPS_PROXY` = `127.0.0.1:7890` 的 TLS 已坏（`schannel: failed to receive handshake`），而绕过代理直连 `api.github.com` 正常（HTTP 200），`gh auth status` 与 `gh api rate_limit` 也随之正常（额度 4980/5000）。与 #92「首轮建票时 deck_ 通道曾不可用故走 gh 直连兜底」同因，非令牌失效。
- 标签：`bug` + `needs-triage`（本轮给的是代码级根因，未做活宿主端到端复现，也未定分流，故按规则保留 `needs-triage`）。

## 进度

- 2026-10-10：建票（`bug` + `needs-triage`）。本轮只做现象采集、历史核查与只读取证，未改任何业务代码。根因做到代码级并对已发布 `0.10.0` 产物验证；等 triage 定分流。
<!-- 做到哪一步了，在这里一行一行记 -->
