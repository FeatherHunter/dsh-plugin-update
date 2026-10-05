# 维护者手册

写给**改这个包的人**。用这个包请看 [README.md](../README.md)。

## 发布流程

**发布用窗口**（推荐；入口在仓根，用户双击即可）：

```sh
publish.cmd
```

窗口分五段，每段停下等你确认：预检（工作区/Node/版本号未占用/npmjs 身份）→ 门禁（`npm test`）→ 发布演练（`--dry-run` 核对文件清单）→ 真发布（2FA）→ 发布后校验（npmjs 版本号 + 临时目录真装一次）。

窗口全程**没有 y/n**：前置条件不满足就自己停下并说明原因；人只需要在 npm 要一次性验证码时把 6 位码贴进去（没登录时走一次网页登录）。工作区有未提交改动默认停，要照样发就加 `-AllowDirty`。

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

## 发布白名单

`package.json` 的 `files` 共 6 项：`dist`、`derive-client-values.mjs`、`event-list.template.json`、`README.md`、`CHANGELOG.md`、`LICENSE`（另加隐含的 `package.json`；`dist` 是目录，**src 下每个 TS 都会带上对应 JS 与 `.d.ts`**——加模块不必改白名单，但要跑一次 `npm publish --dry-run` 核对文件数）。

包出口共 8 个子路径：`.`（宿主侧）、`./panel`、`./client`、`./batch`（多目标批量宿主入口）、`./panel-batch`（批量面板）、`./entry`（更新入口件）、`./http`（HTTP 万能插头：createHttpCall 单三电话 + 批量五电话同一内核 + 面板/入口/批量面板直挂）、`./package.json`。新增能力一律**新开子路径**，不改既有入口的形状。
加新文件进包时同步改 `files`，并重跑 `npm publish --dry-run` 确认文件数。

## 本包门禁

改包后必跑，退出码全 0 才算过：

```sh
node --test tests/*.test.mjs
```

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

日志门禁的 55 事件对照仍以消费方的 `research/489-appendix.md` 与 `tests/verify-log-*.js` 为准；本包只给格式与检查器，不复刻那张表，免得两处对照要双写同步。

## 宿主契约

三条安装出口的契约出处、取证方式与尚未确认的项：`docs/host-install-exits.md`（只读抄件，不入发布白名单）。

## 改动纪律

- **冻结项**：默认电话名、入参回参形状、配置写法（只经函数入参注入）、配方五键形状、事件字段基线（三个事件各加必填 `pluginId`）、默认旧路径。动冻结项先走一次破冰讨论，结论写进对应 issue 并同步 README。
- **取值可增**：宿主种类与路由取值属向后兼容扩展；新增时同步改 README 与 `docs/host-install-exits.md`，调用方不认新值就当普通宿主处理。
- **提交**：只 `git add` 自己声明的路径；本仓可能同时有别的写者，提交前后各看一眼 `git log`。
