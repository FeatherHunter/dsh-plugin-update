# 真机证据格式契约（selftest/evidence）

本目录定义「真机证据包」的格式与判定规矩。所有真机 run（官方桌面通道 A 或普通 DSH 通道 B）都按同一形状落盘，
读者不需要理解测试代码也能复核：看图、看 sidecar、看 raw，就能独立判断这条 run 是 pass / fail / known-red / unknown。

## 1. 目录与命名

```
selftest/evidence/
  README.md                 # 本文件：格式契约
  coverage-matrix.md        # 场景覆盖矩阵（每行 = 一个场景声明）
  known-red.md              # known-red 账本（每行 = 一条已确认、可复核的既有失败）
  runs/
    <ticket>-<YYYYMMDDTHHMMSS>/      # 一次真机 run，目录名 = runId
      run.json              # 机器可读总账（schema 见 §3）
      index.md              # 一页索引（人读；由 run.json 渲染）
      shots/                # 编号截图 + 同名 sidecar
        <id>.png
        <id>.json
      raw/                  # 原始证据：命令、stdout/stderr、关键文件副本
        <id>.json | <id>.txt | <id>.png
```

- runId 格式 `<ticket>-<YYYYMMDDTHHMMSS>`，时间取本机本地时区，精确到秒。
- 一次 run 只对应一个宿主通道（`hostChannel`），通道取值：`desktop-official`（通道 A）/ `dsh-web`（通道 B）。
- run 目录之外的一切（临时 profile、DSH_HOME、user-data-dir、registry storage、打包产物）都在
  `D:/dsh-plugin/_wt263/runtime/t1-265/<runId>/` 下，**不写维护者 profile**；run 结束后临时目录可整目录删除。

## 2. 四态判定（每一条断言必须落一个）

| 判定 | 含义 | 算通过吗 |
| --- | --- | --- |
| `pass` | 预期与实际逐字段相符，原始证据齐全 | 是 |
| `fail` | 预期与实际不符；这是 SUT 的失败证据，不许改写成 known-red | 否（run 出口 1） |
| `known-red` | 已登记在 `known-red.md` 的既有失败，本次再次复现（附原始证据与账本行号） | 否，但不算本次新发现 |
| `unknown` | 证据不足 / 观测被环境干扰 / 无法判定 | 否（run 出口 1） |

- 总判定 = 断言集合的最坏值，优先级 `fail > unknown > known-red > pass`。
- 退出码：`0` = 全部 pass（或只有 known-red）；`1` = 至少一条 fail/unknown；`2` = blocked / 工具错误（run 没跑完）。
- `unknown` 不许写成 pass，也不许省略：观测不到就是观测不到，写清楚卡在哪一步。

## 3. run.json schema（schemaVersion = 1）

```jsonc
{
  "schemaVersion": 1,
  "runId": "265-20261101T213500",
  "ticket": "265",
  "scenarioId": "a-single-package-main-chain",   // coverage-matrix.md 里的行 id
  "hostChannel": "desktop-official",              // desktop-official | dsh-web
  "startedAt": "2026-11-01T13:35:00.123Z",        // ISO（UTC）
  "finishedAt": "2026-11-01T13:41:12.456Z",
  "verdict": "pass",                              // pass | fail | known-red | unknown
  "exitCode": 0,
  "environment": {
    "node": "v24.19.0",
    "platform": "win32",
    "worktree": "D:/dsh-plugin/_wt263/t1",
    "branch": "impl/263-t1",
    "head": "<git commit>",
    "hostChannel": "desktop-official"
  },
  "sut": {                                        // SUT = 当前工作树构建产物（不是 npm 上的旧版）
    "name": "dsh-plugin-update",
    "version": "0.18.39",
    "tarball": "pack/dsh-plugin-update-0.18.39.tgz",
    "tarballSha256": "…",
    "distDigest": "…",                            // 工作树 dist/ 聚合指纹
    "distFiles": 208,
    "registryUrl": "http://127.0.0.1:65001/",
    "installedDistDigest": "…",                   // profile 里实际装上的 dist 指纹
    "installedDistMatch": true
  },
  "assertions": [
    {
      "id": "A-03",
      "step": "安装后磁盘版本",
      "what": "profile/node_modules/<pkg>/package.json 的 version 等于 0.0.1",
      "expected": "0.0.1",
      "actual": "0.0.1",
      "verdict": "pass",
      "note": "可选"
    }
  ],
  "shots": [
    {
      "id": "S-04",
      "png": "shots/S-04.png",
      "sidecar": "shots/S-04.json",
      "step": "旧版面板",
      "what": "面板条带显示 运行版/已安装/最新版 均为 0.0.1",
      "expected": "三个版本号都是 0.0.1",
      "actual": "运行版 0.0.1 / 已安装 0.0.1 / 最新版 0.0.1",
      "verdict": "pass"
    }
  ],
  "raw": [
    {
      "id": "R-02",
      "name": "安装命令输出",
      "file": "raw/R-02-install.json",
      "command": "dsh plugin --profile desktop add <pkg>@0.0.1 --registry=…",
      "exitCode": 0
    }
  ],
  "cleanup": {
    "processes": [{ "label": "desktop-app", "pid": 12345, "aliveAfterStop": false }],
    "ports": [{ "label": "cdp", "port": 65002, "released": true }],
    "notes": "本地 registry 已停止，端口已释放"
  },
  "maintainerProfile": {
    "homeDir": "C:/Users/<user>/.dsh",
    "before": { "packageJson": "…sha", "pnpmLock": "…sha", "bundles": [] },
    "after": { "packageJson": "…sha", "pnpmLock": "…sha", "bundles": [] },
    "unchanged": true
  },
  "notes": ["自由文本；can-red 注入点等也记这里"]
}
```

## 4. 截图 sidecar（`shots/<id>.json`）

每张 png **必须**有同名 .json，四段固定键（中文键，人读优先）：

```json
{
  "看什么": "画面里应该看到什么（选择器/文案锚点，不是泛泛描述）",
  "步骤": "这一步在场景里的位置（与 run.json.assertions[].step 对齐）",
  "expected": "预期值（版本号/可见变化/状态）",
  "actual": "截图当时的实测值（DOM 抽出来的事实，不是猜）",
  "判定": "pass | fail | known-red | unknown",
  "备注": "可选：人为注入的故障、环境异常、复查线索"
}
```

硬要求：
- png 必须是真机截的（CDP `Page.captureScreenshot`），不许合成、不许用旧图。
- actual 必须来自截图同一次 DOM 快照（例如同时 evaluate 出的 `data-build-tag` / 版本号文本），不许拿「应该如此」当 actual。
- 判定与 run.json.assertions 中对应项一致；不一致视为证据包损坏。

## 5. raw/（原始证据）

- 每条命令一个 json：`{ command, args, cwd, exitCode, stdout, stderr, durationMs }`（工具层 CommandResult 原样落盘）。
- 关键文件副本：安装后的 profile `package.json`、`node_modules/<pkg>/package.json`、cordis 补丁层、日志摘录、台账文件。
- 失败时**不许删** raw：失败现场（stderr、退出码、页面文本）比结论更值钱。
- token 类信息（URL 上的 `?token=`）落盘前打码。

## 6. index.md（一页索引）

由 run.json 渲染，顺序固定：标题（runId + 场景 + 总判定/退出码）→ 环境与 SUT → 断言表 → 截图表（id | 看什么 | 预期 | 实际 | 判定）
→ raw 清单 → 清理与端口 → 维护者 profile 指纹 → can-red/备注 → 「从零复跑」命令。

## 7. can-red（证明场景会红）

- 每次实现真机场景后，必须至少跑一次 can-red，证明「同一个场景在 SUT 被改坏时会失败」。
- 方式（按强度从高到低）：
  1. **SUT 变异**：对当前工作树做一处最小、可回滚的变异（例如把 UI 里的版本号渲染改错），`npm run build` 重新钉 SUT，跑同一场景 → 必须 fail；随后回滚变异、重建、跑回绿。
  2. **故障注入**：在夹具/环境层注入可观测故障（例如暂停 registry、发布错误版本），同一场景必须 fail 或 unknown，且失败点可复核。
- 本树已实现的注入点（场景 A）：`--fault stale-variant` —— 发布 0.0.2 但构建内容取自 0.0.1（版本号新、内容旧），
  用来证明「重启后新版 UI + 可见变化」与「发布内容哈希变化」这两条断言真的会红，而不是只看版本号字符串。
  预期结果：run 总判定 `fail`、退出码 1，失败点落在 `14-assert`（内容哈希未变）与 `25-assert`（client/host 构建标记仍是旧版），
  `shots/26-shot` 判定 `fail`；其余断言（SUT 钉版、安装、日志、台账、清理）仍应 pass——这样才说明红的是被测断言本身，不是环境坏了。
- can-red 证据单独提交：小 run 目录 `runs/265-<stamp>-can-red/`，或同一 run 的 `notes` + `raw/` 段（必须写明变异 patch 原文与回滚确认）。
- 只写「我试过会红」不算证据；必须有失败 run 的 run.json/index.md/截图。

## 8. known-red 账本

- 文件：`selftest/evidence/known-red.md`。
- 每行必须含：编号、首次发现 runId、SUT commit、复现命令、原始证据路径（points to runs/…）、影响面、责任人/后续票。
- known-red 只记录**已确认、可稳定复现**的既有失败；一次偶然的环境问题不算 known-red，写 unknown 并重跑。
- 产品修复后必须把该行标注「已修复」并保留历史（棘轮：只增不减，状态可改）。

## 9. 与门禁的关系

- 真机 run 依赖官方桌面 / 本地 registry / 网络，**不进 `npm run check`**（#258 已批准的分层）。
- 门禁只保证：`npx tsc -p selftest/tsconfig.json --noEmit`（hermetic 层）、
  `npx tsc -p selftest/tsconfig.tooling.json --noEmit`（真机工具层类型）、根 `npm run check`。
- 证据包本身是「门三真机签署」的输入，不是自动门禁的替代品。

## 10. 从零复跑

```powershell
# 前置：node 24、node_modules 已装、工作树已 npm run build（真机 SUT = 当前构建产物）
cd D:/dsh-plugin/_wt263/t1

# 主链（官方桌面通道 A，全绿）
node selftest/real-machine/tools/run-a-main-chain.ts \
  --worktree D:/dsh-plugin/_wt263/t1 \
  --run-base-dir D:/dsh-plugin/_wt263/runtime/t1-265 \
  --verdaccio-install-dir D:/dsh-plugin/_wt263/runtime/tools/verdaccio \
  --maintainer-home C:/Users/<维护者>/.dsh

# can-red（同一场景注入故障，预期 fail/退出码 1）
node selftest/real-machine/tools/run-a-main-chain.ts \
  --worktree D:/dsh-plugin/_wt263/t1 \
  --run-base-dir D:/dsh-plugin/_wt263/runtime/t1-265 \
  --verdaccio-install-dir D:/dsh-plugin/_wt263/runtime/tools/verdaccio \
  --fault stale-variant
```

（端口动态选空闲端口，runId 自动取本地时间。每个 run 的 index.md 末尾也会打印它自己从零复跑的那一行。）
