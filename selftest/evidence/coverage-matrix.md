# 真机场景覆盖矩阵

每行 = 一个真机场景声明。新增场景时先加行，再实现；证据 run 的 `run.json.scenarioId` 必须等于这里的场景 ID。

| 场景 ID | 宿主通道 | 夹具 / 初始版本 | 变体版本 | 变更类别 | 动作 | 预期 | 证据清单 | 判定标准 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a-single-package-main-chain | desktop-official（官方桌面） | A（批量集成方，selfOrder=first，targets=[a,b,c]）@0.0.1 | A@0.0.2 | UI + 行为（卡片标题变体、client/host 构建标记都变） | 干净 profile 装旧版 → 起官方桌面 → 点检查更新 → 点安装更新 → 必要时重启 | 旧版 → 新版真实更新；UI/磁盘/日志/台账四处版本一致；无虚假成功 | run.json（断言+截图索引）、shots/（每图 sidecar 四段）、raw/（安装命令、SUT dist 指纹、面板 DOM 快照、日志/台账副本）、index.md | 全部断言 pass；版本条带 0.0.1→0.0.2；重启后 client/host 构建标记为 v0.0.2；磁盘 dependencies 与 node_modules 包版本=0.0.2；日志含 0.0.2 安装事件且无 fail；台账含该作业 | ✅ 已跑：主链 runs/265-20261101T215128（pass）+ can-red runs/265-20261101T214716（fail，预期） |
| b-batch-two-integrators | desktop-official | A@0.0.1 + B@0.0.1（B 为批量集成方，targets=[b,c]） | A@0.0.2 + B@0.0.2，C 纯目标 0.0.1 | UI + 行为 | 同一 profile 装 A+B（C 作为目标）→ 真 UI 批量更新 → 核对两席各自视图与目标版本 | 两个集成方各自更新，目标 C 被推到达；互不串台 | 同上 + 两席面板/入口状态、批量台账 | 两席 run 断言全 pass；目标 C 版本按 plan 推进；无跨 scope 污染 | ✅ 已跑：主链 `runs/266-20261102T034002`（pass）+ can-red `runs/266-20261102T080334`（fail，预期） |
| c-pure-target-no-wiring | desktop-official | A@0.0.1 + C（纯目标，无更新接线）@0.0.1 | C@0.0.2（由 A 推） | 行为 | A 的批量更新把 C 推到 0.0.2 → 核对 C 无自己的更新入口/面板 | C 装得上、可被推、不出现自有更新 UI | run.json + 截图 + raw | C 版本到位；C 页面无 .dsh-upd 面板 | ✅ 已跑：主链 `runs/266-20261102T034912`（pass）+ can-red `runs/266-20261102T081101`（fail，预期） |

## 场景声明要点（新增行必须写清）

- **宿主通道**：`desktop-official`（官方桌面，通道 A）/ `dsh-web`（普通 DSH 宿主，通道 B，fallback）。
- **初始/变体版本**：夹具身份单源在 `selftest/fixtures/identity/fixture-slots.ts`；版本序列 0.0.1→0.0.2。
- **变更类别**：至少一种「人眼可见变化」（UI 文案/标题）或「行为变化」（host 桥返回、状态机），并在证据里给出可复核的 actual。
- **动作**：必须写清真 UI 动作（点哪个按钮），不是「调用 updateCheck 电话」。
- **证据清单**：断言（run.json.assertions）+ 截图（shots/）+ raw（命令/文件副本）。
- **判定标准**：可机械复核的字段（版本号相等、哈希相等、文本包含关系），不写「看起来正常」。

## can-red 记录（证明场景会红）

| 场景 ID | can-red 方法 | 失败表现 | 证据 |
| --- | --- | --- | --- |
| a-single-package-main-chain | 故障注入 `--fault stale-variant`：发布 0.0.2 但构建内容取自 0.0.1（版本号新、内容旧） | 同一场景整体 fail/退出码 1；失败点 `15-assert`（client/host 内容哈希未变）与 `26-assert`（重启后 client/host 构建标记仍是 v0.0.1）；其余断言（SUT 钉版/安装/检查/日志/台账/清理）仍 pass | `runs/265-20261101T214716/`（run.json + index.md + shots + raw/can-red-fault.json） |
| b-batch-two-integrators | 故障注入 `--fault skip-variant:c`：不发布 C@0.0.2（a/b 变体照常发布） | 整体 fail/退出码 1；恰好 4 条红：`47-assert`/`49-assert`（重启后 A/B 面板 C 行仍 `current[0.0.1]`）、`50-assert`（C 徽标仍旧版 `client v0.0.1`）、`59-assert`（日志 `installC=false`）；其余 34 条（三包基版安装、a/b 更新后新版 UI/行为、磁盘 a/b=0.0.2、批量账本/中枢、清理/维护者指纹）仍 pass | `runs/266-20261102T080334/`（run.json + index.md + shots + raw/22-can-red-fault.json） |
| c-pure-target-no-wiring | 故障注入 `--fault stale-variant:c`：发布 C@0.0.2 但构建内容取自 0.0.1（版本号新、内容旧） | 整体 fail/退出码 1；恰好 2 条红：`22-assert`（C 变体 client.js sha256 未变、无 `client v0.0.2` 标记）、`33-assert`（重启后 C 徽标仍是 `client v0.0.1`）；其余 22 条（SUT 钉版、A 批量把「0.0.2」推到位、C 无 `.dsh-upd` 面板/入口、磁盘/日志/清理）仍 pass | `runs/266-20261102T081101/`（run.json + index.md + shots + raw/20-can-red-fault.json） |
