# 维护者手册

写给**改这个包的人**。用这个包请看 [README.md](../README.md)。

## 发布流程

**发布用向导**（推荐，逐级确认、不带参数、跑一次走完全程）：

```sh
bash scripts/release-wizard.sh
```

它按下面七级走：预检（仓库/Node/版本号/npmjs 身份）→ 构建与门禁（`npm test`）→ 发布演练（`--dry-run` 核对文件清单）→ 真发布（含 2FA 验证码兜底）→ 发布后校验（npmjs 版本号 + 临时目录真装一次）→ 打 tag（可选）→ 交接提醒（消费方升级、现场验收）。

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

`package.json` 的 `files` 共 5 项：`dist`、`derive-client-values.mjs`、`event-list.template.json`、`README.md`、`LICENSE`（另加隐含的 `package.json`；`dist` 下 9 个 JS 全带上）。
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
