# 已提交的真机 run 账本

本目录只放**已提交**的真机证据包（一次 run 一个目录，目录名 = run.json 的 `runId`）。
格式契约见 `../README.md`；场景声明见 `../coverage-matrix.md`。

| runId | 场景 | 宿主通道 | 总判定 | 退出码 | 用途 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 265-20261101T215128 | a-single-package-main-chain | desktop-official | pass | 0 | 主链正式证据（A@0.0.1 → A@0.0.2，官方桌面真机） | 13 条断言 / 4 张截图；in-process 安装出口由日志 `hostKind=desktop-manager` 证明；维护者 profile 指纹不变 |
| 265-20261101T214716 | a-single-package-main-chain | desktop-official | fail | 1 | can-red 故障注入（`--fault stale-variant`：发布 0.0.2 但内容是 0.0.1） | 预期失败；失败点 `15-assert`（内容哈希未变）与 `26-assert`（重启后 client/host 仍是 v0.0.1）；其余断言仍 pass，说明红的是被测断言本身 |

## 复核入口

- 先看每个 run 的 `index.md`（一页索引），再按需点开 `shots/<id>.json`（看什么/expected/actual/判定）与 `raw/`。
- `run.json` 是机器可读总账；其中 `sut` 段给出「被测系统 = 当前工作树构建产物」的 tarball sha256 与 dist 聚合指纹，
  `cleanup` 段给出进程/端口清理证据，`maintainerProfile` 段给出维护者 DSH_HOME 前后指纹。
- 证据里的绝对路径（`D:/dsh-plugin/_wt263/runtime/t1-265/<runId>/...`）是采集机原始路径，临时目录可删；
  本目录内是完整副本，复核只依赖本目录。
- can-red run 的 `notes` 与 `raw/can-red-fault.json` 写明注入点与预期失败点；与主链 run 对照看即知哪条断言真的会红。

## 复跑

见 `../README.md` §10（主链与 can-red 两条命令）与 `docs/research/20261101-issue-265-single-package-main-chain.md` §9。
