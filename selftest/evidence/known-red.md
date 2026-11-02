# known-red 账本（真机场景）

规则见 `README.md` §8：只登记**已确认、可稳定复现**的既有失败；产品修复后把「状态」改成已修复并保留历史（棘轮：只增不减）。

| 编号 | 首次发现 runId | SUT commit | 复现命令 | 原始证据 | 影响面 | 状态 | 后续 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| t3-267-exit-one | 267-20261102T113042 | cc140e7（impl/263-t3，SUT dsh-plugin-update@0.18.39） | `node selftest/real-machine/tools/run-f-desktop-probe.ts --run-base-dir <runtime> --worktree <t3 工作树> --verdaccio-install-dir <verdaccio> --esbuild <esbuild.exe>` | `runs/267-20261102T113042/`：`raw/capability-probe-filesystem.json`、`raw/capability-probe-uninstall-registry.json`、`raw/capability-probe-services.json`、`raw/capability-probe-classification.json`、`raw/desktop-host-kind-negative.json`、`run.json` 的 `25-assert`/`26-assert` | 出口一（第三方 Desktop：`desktopProfiles` 服务）真机更新；本机不可达（探测到第三方 Desktop 计数 0；本机唯一桌面宿主 `hostKind=desktop-manager`，即 `desktopProfiles` 为空的反证） | **不可达——需第三方 Desktop；本机探测证据在 `runs/267-20261102T113042/`**；非产品缺陷，不伪造真机结果 | 可复现条件：装一台提供 `desktopProfiles` 服务（launcher 在 Loader entry 挂载前注册）的第三方 Desktop 发行包后重跑 run-f；届时 `25-assert`（成功格：走 `desktopProfiles.runPlugin(args, 使用范围目录, undefined)` 更新并核对 UI/磁盘/日志）与 `26-assert`（失败格：宿主失败码/人话格/手工命令）应从 known-red 转为实测断言。当前 run 以 8 pass + 2 known-red、退出码 0 收尾 |
