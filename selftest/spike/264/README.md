# selftest/spike/264 — 真机宿主 spike（throwaway）

> 一次性探针脚本，服务于 #264（T0）。**不保证维护**：T1 会把这些能力重写成正式 harness。
> 决策文档：`docs/research/20261101-issue-264-host-matrix.md`
> 证据样例：`selftest/evidence/runs/264-20261101T194628/`

## 依赖

- Node ≥ 22（本机 v24.19.0），使用内置 `WebSocket` / `fetch`，**不装任何 npm 包**。
- 系统 Chrome：`C:\Program Files\Google\Chrome\Application\chrome.exe`。
- DSH CLI：`D:\DeepseekHarness\resources\runtime\cli\bin\dsh.cmd`。
- 官方桌面：`D:\DeepseekHarness\DeepSeek Harness.exe`（通道 A 用）。

## 通道 B（推荐，已全绿）

```powershell
cd D:\dsh-plugin\_wt263\t0
node selftest\spike\264\channel-b.mjs `
  --run-dir  selftest\evidence\runs\264-<ts> `
  --workdir  D:\dsh-plugin\_wt263\runtime\t0-264 `
  --plugin   dsh-prompt@0.4.40
```

做的事：临时 `DSH_HOME` → 生成 web profile 骨架 → 装集成方 → 起 `dsh --port 0 --no-open` → 起 headless Chrome → CDP 连接 → 悬停集成方入口 → 点设置 → 滚到更新入口 → 点开更新面板 → 点「检查更新」→ 截图 → 清理进程树。

产物：`<run-dir>/raw/<NN>-<step>.json`（每步命令、stdout/stderr、耗时、退出码）+ `<run-dir>/shots/*.png`。
`--keep` 保留进程不清理（排障用，记得手动 taskkill）。

## 通道 A（部分可用）

```powershell
# 1) 启动隔离实例（务必先清 ELECTRON_RUN_AS_NODE，否则 exe 退化成 node CLI）
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:DSH_HOME = 'D:\dsh-plugin\_wt263\runtime\t0-264-channelA\home'
& 'D:\DeepseekHarness\DeepSeek Harness.exe' `
  --user-data-dir=D:\dsh-plugin\_wt263\runtime\t0-264-channelA\udd2 `
  --remote-debugging-port=59333

# 2) 连 CDP 截图 / 操作
node selftest\spike\264\channel-a.mjs        # 连接 + 截图 + targets 信息
node selftest\spike\264\channel-a-ui.mjs     # 侧栏 → 插件页 → 添加插件对话框
node selftest\spike\264\channel-a-install.mjs # 出口二：填 dsh-prompt@0.4.40 → 安装
node selftest\spike\264\channel-a-panel.mjs  # 深链尝试（当前 known-red：等不到集成方入口）
```

## 指纹工具

```powershell
node selftest\spike\264\profile-fingerprint.mjs "C:\Users\<你>\.dsh\profiles\desktop" out.json
```

输出 5 个关键文件 SHA256 + `.plugin-manager` / `node_modules` 顶层条目，用于「profile 未被改动」的前后对照。

## 已知坑（详见决策文档第 6、7 节）

- 生成脚本用模板字符串时，脚本内的反引号会截断模板 → 必须 `node --check`。
- 更新入口在设置页视口外，点击前要 `scrollIntoView`。
- 面板挂载即自查，`check` 按钮先 disabled；轮询要优先真实动作。
- 官方桌面首启向导关不掉、装完需重启，是通道 A 深链的两处阻塞。
