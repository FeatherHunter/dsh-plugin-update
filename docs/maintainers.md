# 维护者手册

写给**改这个包的人**。用这个包请看 [README.md](../README.md)。

## 发布流程

**发布用窗口**（推荐；入口在仓根，用户双击即可）：

```sh
publish.cmd
```

窗口分五段，每段停下等你确认：预检（工作区/Node/版本号未占用/npmjs 身份）→ 门禁（`npm test`）→ 发布演练（`--dry-run` 核对文件清单）→ 真发布（2FA）→ 发布后校验（npmjs 版本号 + 临时目录真装一次）。

窗口全程**没有 y/n**：前置条件不满足就自己停下并说明原因；人只需要在 npm 要一次性验证码时把 6 位码贴进去（没登录时走一次网页登录）。工作区有未提交改动默认停，要照样发就加 `-AllowDirty`。

- **预检多看一眼消费方声明范围**（`0.18.16` 起，#196 部署偏斜）：发布前核对已知消费方的 `dsh-plugin-update` 依赖范围（快照与建议见下「发布侧依赖治理」）——范围钉在旧 minor 的消费方永远吃不到这次发布。另：本包自更新走常规面板路径即可，它不在 profile `dependencies` 键里，宿主 `already-installed` 守卫不拦（2026-10-17 真机已证）。

**token 无人值守发布**（窗口之外的新通道；有写权限 token 时优先走这条，不用人贴码）：

```powershell
$env:NODE_AUTH_TOKEN='npm_...'  # Automation 或 Granular 写权限（须含 dsh-plugin-update）；只给变量，不贴全文
pwsh -NoProfile -File scripts\publish-token.ps1 -Probe    # 先探针（约 5 秒，无副作用），PROBE-OK 再往下
pwsh -NoProfile -File scripts\publish-token.ps1           # 门禁(build+test)→发布→一次采样；宣布前加 -FullPost 轮询到可见
```

快协议：publish exit 0 或 `E409 previously-staged` 即证明 registry 收下（受理≠可见，staged 要等几分钟才可见，属正常）；token 只走环境变量、不进仓库不打屏。发布侧到 registry 全绿即交付，安装一律用户侧做。

**发布后校验必须轮询，不能立刻下结论**（2026-09-30 实测）：npm 的网页 2FA 审批走完后，registry 常回 `PUT 202` 且 `npm publish` 退出码 0，但那只是**已受理**——`npm` 自己会打印 “may take a few minutes to become available”，本次实测约 5 分钟后 `0.1.2` 才在 registry 上可见。窗口因此最多轮询 10 分钟（每 15 秒、`--prefer-online`），只有真能查到这一版才做冒烟安装；状态文件里的 `visible` 字段把「已受理但未确认」与「成功」分开。

- npm 的 2FA 审批要**真实 TTY ＋ 用户本人**：Agent 的后台环境直接跑 `npm publish` 只会拿到 `EOTP`，隔空传一次性验证码必过期。所以发布必须在这个窗口里做。
- Agent 直接 `Start-Process` 开的窗口落在用户看不见的会话；要用 **schtasks 交互式任务**把窗口拉到用户桌面：

```sh
schtasks /create /tn "DSHPublishUpdate" /tr "\"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe\" -NoProfile -ExecutionPolicy Bypass -File \"<仓根>\scripts\publish-window.ps1\" -PackageDir \"<仓根>\"" /sc once /st 23:59 /it /f
schtasks /run /tn "DSHPublishUpdate"
schtasks /delete /tn "DSHPublishUpdate" /f
```

- 结果落盘（Agent 读文件，不必等用户复述）：`.tmp-publish-status.json` 是**权威判据**（退出码/版本/目录/时间），`.tmp-publish-<时间>.log` 是整窗转录。两者都已被 `.gitignore` 忽略。
- `scripts/publish-window.ps1 -Preview` 只做前三段（预检、门禁、演练），不发布、不暂停，用来验证脚本本身。
- 脚本必须存成 **UTF-8(BOM)**：Windows PowerShell 5.1 读没有 BOM 的 `.ps1` 会按 ANSI 解析，中文会乱码。

手动照做的话，按顺序两步（演练只跑 dry-run，不真发）：

```sh
node build.mjs
npm publish --dry-run
```

确认无误后真发（要人配合：交互窗口按回车 ＋ 浏览器 2FA）：

```sh
npm publish
```

`npm run build` 就是 `node build.mjs`；`npm test` 带 `pretest`，会先 build 再跑测试。

本包唯一的运行期依赖是 `dsh-log@^0.3.4`（决策见 `docs/adr/0005-dsh-log-as-first-runtime-dependency.md`）。下限跟着链上下文抬过一档：`store.trace()` 要 `0.3.3` 起，`0.3.4` 起启动头幂等且记 `os`（见 CHANGELOG 的 `0.16.4` 节）。纪律：**只有 `src/log/**` 能碰它**，而且是按需动态取（拿不到就降级，绝不外抛）；`tests/gate.test.mjs` 递归扫 `src/` 全树，别处出现 `dsh-log` 或任何别家外部包即红。

### 发布侧依赖治理（`0.18.16` 起，#196）

部署偏斜的根子在**消费方声明的范围**：同一台机器上会有使用范围级副本 + 各消费方 `node_modules` 里的嵌套副本；消费方把本包声明成 `^0.13.0` 这类旧 minor 时，`^0.13.0` 只允许 0.13.x，**我们发多少版它都不会加载**（面板里看到的故障来自那份旧副本，不是新发出去的版本）。发布前按 checklist 核一遍消费方声明：

- 已知消费方（2026-10-18 快照，随对方发版更新）：`dsh-opencode-palette@2.0.28 → ^0.13.0`（钉死 0.13.x，最危险）、`dsh-life-pack@0.3.66 → ^0.18.6`、`dsh-mattpocock-skills-deck@1.9.0-beta.2 → ^0.18.6`、`dsh-im-companion@0.2.12 → 精确 0.18.7`。
- 建议范围：`^0.18.0`（或更新 minor）——0.x 的 caret 只锁 minor，写 `^0.18.0` 才能吃到 0.18.x 后续修复。精确版本也能用，但每次我们发版都要他们跟着发版才能升级。
- 本包自己**不能**从面板里升级嵌套副本：先让消费方发版抬范围（或用户用载体 CLI 把本包装到使用范围级，见 README §9）。发布说明里点一句「嵌套副本的消费方需自行抬依赖范围」即可，不必逐家催。

## 发布面（npm 页 / GitHub 仓库页 / Release）

读者见到的是三张脸，同一件事得同一句话：**npm 页**（`description` + `keywords` + tarball 里的 README）、**GitHub 仓库页**（About 的 description / homepage / topics，以及 Releases 页）、**用户手册**（README）。发版时按这个顺序对齐：

1. **`package.json`**：`description` 用面向使用者的口径、**不写内部票号**（npm 页与搜索引擎都直接取这句）；`keywords` 与 GitHub 的 topics 用同一批词；`homepage` 指本仓 README、`bugs` 指本仓 Issues——npm 页据此出可点的「仓库 / 问题」入口。
2. **GitHub About**（`gh` 已登录同账号即可）：
   ```sh
   gh api -X PATCH repos/FeatherHunter/dsh-plugin-update -f description="…与 package.json 同一句…" -f homepage="https://www.npmjs.com/package/dsh-plugin-update"
   gh api -X PUT repos/FeatherHunter/dsh-plugin-update/topics -f 'names[]=dsh' -f 'names[]=dsh-plugin' -f 'names[]=self-update'
   ```
3. **tag + Release**：`v<版本>` 打在发版提交上（`git tag -a v0.16.2 -m "0.16.2"` 后 `git push origin v0.16.2`）；Release 说明**从 CHANGELOG 取**，别手抄：
   ```sh
   node scripts/release-notes.mjs 0.16.2 > .tmp-release-notes.md
   gh release create v0.16.2 --title "v0.16.2" --notes-file .tmp-release-notes.md
   ```
4. **复核**：`npm view dsh-plugin-update@<版本> description keywords homepage`、仓库页 About、Release 页各看一眼——三面一致才算齐。

两条已踩过的坑：

- **npm 页只跟着新版本变**：改完 `package.json` 或 README 却不发版，npm 页一动不动（tarball 里的 README 也一样）。所以「统一介绍面」这类改动必须跟一次 patch 发布，改完就发。
- **`0.14.0` 与 `0.15.0` 没有单独发到 npm**（registry 上从 `0.13.0` 直接到 `0.16.0`，两节内容随 `0.16.0` 首发）：对外文字一律按**装得到的版本**说话。README 里原先几处「`0.15.0` 起」已改成 `0.16.0` 起；CHANGELOG 那两节保留原编号，但标题下带「未单独发到 npm」注记。
- **打 tag 与发 Release 从 `0.16.0` 起**：`v0.16.0`、`v0.16.1`、`v0.16.2` 都打了（annotated tag 指到各自的发版提交）；更早的版本只有 CHANGELOG 记录、没有 tag；`0.14.0` / `0.15.0` 从未发布，也没有 tag。

## 发布白名单

`package.json` 的 `files` 共 7 项：`dist`、`derive-client-values.mjs`、`event-list.template.json`、`event-list.update.json`、`README.md`、`CHANGELOG.md`、`LICENSE`（另加隐含的 `package.json`；`dist` 是目录，**src 下每个 TS 都会带上对应 JS 与 `.d.ts`**——加模块不必改白名单，但要跑一次 `npm publish --dry-run` 核对文件数）。

包出口共 11 个子路径：`.`（宿主侧）、`./log`（日志内核：派生命名空间 / 登记表 / 路由 / 唯一发射口 / 随包事件表 / 客户端通道）、`./panel`、`./client`、`./batch`（多目标批量宿主入口）、`./panel-batch`（批量面板）、`./entry`（更新入口件）、`./entry-batch`（批量感知入口件：一颗按钮看 N 家聚合，点开即批量面板）、`./install-button`（安装按钮控件：一颗按钮原地装好一家，判定文案与面板同一口径）、`./http`（HTTP 万能插头：createHttpCall 单五电话 + 批量五电话同一内核 + 面板/入口/批量面板直挂）、`./package.json`。新增能力一律**新开子路径**，不改既有入口的形状。
其中浏览器安全面只有 `src/log/client-queue.ts`（零 `node:` 依赖）与 `src/log/{sink,router}.ts`：`panel.ts` 只许运行期引 `./log/client-queue.js`，其余 `src/log/**` 只许 `import type`（`tests/log-kernel.test.mjs` 会红）。
加新文件进包时同步改 `files`，并重跑 `npm publish --dry-run` 确认文件数。

## 本包门禁

改包后必跑，退出码全 0 才算过：

```sh
node --test tests/*.test.mjs
```

### 双语门禁（#56）

用户可见文案的双语化（英文在前中文在后）另有一道防倒退门禁，**改文案、改面板/入口/诊断渲染时必跑**；
它不进发布产物（`scripts/` 不在 files 白名单），只在本仓用：

```sh
npm run gate:bilingual            # 三道硬门禁：文案源 grep + 字典快照 + 17 码与诊断解析契约
npm run gate:bilingual:release    # 再加第四道：零 draft 放行（合入主分支/发版条件，见 #57）
```

- **文案源 grep**：`src/` 里的中文字符串字面量只许出现在文案源 `src/bilingual.ts`；其余位置按冻结基线
  `tests/fixtures/bilingual/copy-baseline.json` 逐条放行——**只许减，不许增，而且要减干净**。日志/抛错等冻结中文要
  新增或改词，必须 `node scripts/bilingual-gate.mjs --update-baseline` 重算基线、并在评审 diff 里看见；
  源里已消失的条目（迁移删掉了）必须同一次改动里收紧，别留僵尸放行（`npm test` 会盯着，CLI 加 `--strict-baseline` 也拦）。
  注释与正则不入账：门禁只数字符串字面量。
- **字典快照**：每键 en/zh 非空、英文无汉字、中文有汉字、具名槽中英同名同数、渲染英文在前；
  全量快照在 `tests/fixtures/bilingual/strings.snapshot.json`，改文案必须同步快照（**改文案不换 key**）。
- **17 码与诊断解析契约**：11 阻塞 + 5 电话 + internal 各有文案且只按稳定码分支；诊断两种复制形态
  （三行块 / 单行）都能解析回同一组字段，顺序冻结（码 → 摘要 → 来源 → 怎么办）。
- **零 draft 放行**：字典里还有 `draft: true` 就红——母语 + 域内双签转正才放行合入/发版（#53 立约，见 #57）。
  截至 `0.16.2`，字典里 **320 个 key 全部仍是 `draft: true`**（`node scripts/bilingual-gate.mjs --release` 实测），所以 `--release` 是**如实红**，不是坏门禁；转正是逐键的母语评审 + 域内双签，属独立工作，不由发版票代签。历次发版（0.9.0–0.13.0）的门禁行同样记「`--release` 仍如实红，非阻断」。
- 失败可复现：`tests/bilingual-gate.test.mjs` 随 `npm test` 跑，它既断言本仓现在三道硬门禁全绿，
  也在临时目录里造违规，断言门禁红在哪一行（新散落中文、空英文、槽位不齐、顺序反了、解析不回字段都会红）。

下面这几道是**消费方仓库**（本包原来的家 `dsh-mattpocock-skills-deck`）里的门禁，不在本仓，要跑得切到那边：

```sh
node tests/verify-update-regression.js
node tests/verify-update-freshness.js
node tests/verify-update-install.js
node tests/verify-update-routes.js
node tests/verify-update-panel.js
node tests/verify-log-fields.js
node tests/verify-log-count.js
```

日志门禁的 55 事件对照仍以消费方的 `research/489-appendix.md` 与 `tests/verify-log-*.js` 为准；本包只给格式与检查器，不复刻那张表，免得两处对照要双写同步。本包自己的事件表是随包的 `event-list.update.json`（0.3.1 条目形状 + `#210` 起清单顶层的 `fieldEnums` 枚举声明，**26 事件：常驻 18、按需 7、自监控 1**；`0.16.3` 起，此前 28），新增/删除事件与字段要同步它，`npm test` 里的 `tests/gate.test.mjs` 会拿 `lintEventList` 整份过尺子（有红有黄即红）。条目里**只能有六个键**（`level`/`kind`/`fields`/`codes`/`rules`/`guard`）：dsh-log 0.3.4 对条目未知键整份拒收，枚举因此只放顶层 `fieldEnums`（引擎收下不用）。**清单是发布出去的契约**：声明一个永不出现的字段名会把第三方聚合器带偏，所以「规格里写了、实现没发」的条目要么补实现、要么从清单删掉（判据与逐条记录见 `docs/research/20261014-log-event-catalog.md` §7）。

## 宿主契约

三条安装出口的契约出处、取证方式与尚未确认的项：`docs/host-install-exits.md`（只读抄件，不入发布白名单）。

## 改动纪律

- **冻结项**：默认电话名、入参回参形状、配置写法（只经函数入参注入）、配方五键形状、事件字段基线（三个旧事件各加必填 `pluginId`）、默认旧路径。动冻结项先走一次破冰讨论，结论写进对应 issue 并同步 README。**至今只破冰一次**：`0.16.0` 追加第五个电话名 `logAppend`（`#122`，面板侧日志通道）——`updateChangelog` 是 `0.4.0` 起就有的第四个名字，不算破冰项。追加只在既有名字之后，老三电话与 `updateChangelog` 一字不动，`tests/{config,phones,queue,batch-host,gate}.test.mjs` 里「电话名一字不差」那几条断言同步扩到五个。
- **取值可增**：宿主种类与路由取值属向后兼容扩展；新增时同步改 README 与 `docs/host-install-exits.md`，调用方不认新值就当普通宿主处理。
- **`0.16.0` 的破冰（`#124` 日志接线）**：两处。(1) 检查电话多认一个可选入参 `trigger`、安装电话多认一个可选入参 `from`，两者**只进日志行**（`update.check.start.trigger`、`update.install.request.from`），不参与决策、不改回参形状，老调用一字不动（README 第 10 节已同步）。(2) `host.call` 的**发射政策**收紧：`updateStatus` 的成功行是每秒一次的轮询噪声，一条都不发（第一次也算「没有可比的上次」；只有状态真变了才留一行），`host.call` 的**名字与五键形状不变**，失败行 `host.call.fail` 不受影响。事件名、字段名与枚举值的事实源仍是 `event-list.update.json` 与 `docs/research/20261014-log-event-catalog.md`（§3.1 记了逐环节落点与实测证据）。
- **提交**：只 `git add` 自己声明的路径；本仓可能同时有别的写者，提交前后各看一眼 `git log`。
