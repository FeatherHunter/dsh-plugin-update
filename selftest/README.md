# 自测双目标（selftest/）

> 只测本包自己的升级链，不依赖任何外部业务插件。
> 两个测试包名：`dsh-plugin-update-selftest-target-a` / `-b`（与 `src/core/reader.ts` 的“目标包”同词）。

## 第一性原理：为什么是两个包名

- 更新 = 读本机（装了没/哪版/在册吗）→ 查远端（最新哪版）→ 判（换不换）→ 调宿主装 → 再读验证 → 讲清楚（面板/人话/日志）。
- 一个包名只能证 `N=1` 的正确；批量账本、队列互斥、中枢租约、日志按 `pluginId` 隔离、“坏了的是哪一份”这些都是 `N≥2` 才出现的相互作用。
- 两个是最小完备：`N=1`（单目标）+ `N=2`（批量/隔离）覆盖全部等价类；第三个包不增加新等价类，只加发布时间与 registry 噪音（规则 10：不发散）。

## 金字塔（B 档只做前两层，不真发 npm）

1. 纯单测（hermetic）：`target-scaffold` 的生成是纯函数，`update-verdict` 的版本比较是纯函数，不碰网络/磁盘。
2. 本地闭环（hermetic）：`scenario-harness` + `LocalDirectoryRegistry` + `FakeHostInstallPort` 跑单/批量两个场景，全在临时目录。
3. 真 registry e2e（未来 C 档）：才需要 `NpmRegistry` + token/2FA + 可见性轮询；不进每提交门禁，手动按需跑。

## 目录（只增 `selftest/`，不动存量 `.mjs`/`src/`/`package.json`）

```
selftest/
  README.md                        # 本文件：为什么两个包、跑哪几层、不做什么
  tsconfig.json                    # 独立类型检查（不并入根 tsconfig，不影响 npm run check）
  .gitignore                       # 只忽略 generated/（生成物不入库）
  target-definition/               # 数据：两个目标是谁（唯一真源，Factory）
    target-spec.ts
  target-scaffold/                 # 生成：规约 → 可发布包目录（纯函数 + 薄 IO，Builder）
    scaffold-target-package.ts
  scenario-harness/                # 驱动：端口 + 运行器 + 裁决（Strategy + Template Method，Ports & Adapters）
    registry-port.ts               # 查新版从哪来：本地目录（B 档）/ npm（C 档未来）
    host-port.ts                   # 安装谁来装：假宿主（B 档）/ 真宿主（C 档未来）
    scenario-runner.ts             # 场景生命周期：setup→check→install→verify（模板方法）
    update-verdict.ts              # 裁决：装上没、批量互不干扰没（判别联合 + 穷尽分支）
  scenarios/                       # 用例：数据，不写第二套逻辑（Builder 组装）
    single-target-update.ts        # N=1：a 从 0.0.1 到 0.0.2
    batch-two-targets.ts           # N=2：a/b 各自从 0.0.1 到 0.0.2，互不干扰
```

## 依赖规则

- `scenarios` → `scenario-harness` → `target-definition`；`target-scaffold` 只依赖 `target-definition`。
- `selftest/` 不在运行时 import `src/` 与 `dist/`（类型也不 import，保持零耦合；对照关系见各文件头注释）。
- 真实版本比较复用 `src/shared/compliant.ts` 与 `src/core/service.ts`；`update-verdict.ts` 里的三段式比较仅是骨架自检用，不替代核心判定。

## 运行（B 档）

```sh
npx tsc -p selftest/tsconfig.json --noEmit   # 独立检查，不碰根门禁
```

根门禁不受影响：根 `tsconfig.json` 的 `include` 仍只有 `src/**/*.ts`，`build.mjs` 只扫 `src/`，
`tests/gate.test.mjs` 只扫 `src/`，`files` 白名单不动（`selftest/` 永不发布）。

## 对抗式审查（先承认，再挡）

| 攻击 | 是否成立 | 挡法 |
| --- | --- | --- |
| 公开发布测试包会永久污染 npm，被误装 | 成立 | B 档不发布；C 档包名带 `selftest-target`、描述首句 `TEST ONLY`、版本 `0.0.x`、不带 `dsh` 关键字、不写 `dsh.plugin` 入口 |
| 两个包的版本号与主包版本耦合，发一次主包就要发两次夹具 | 不成立 | 夹具版本独立（`0.0.x` 自增）；被测的是本地 `dist/`，夹具只是靶子 |
| 自测 harness 重写 semver/判定，与核心判定分叉 | 成立一半 | harness 不判“该不该升”（那是 `src/core` 的事），只判“装到要的版没、两家串没串”；`compareVersions` 仅限 `0.0.x` 骨架，C 档前明确替换点 |
| 新增 TS 需要接根 `build`/`check`，会拖慢门禁 | 成立 | B 档不接：独立 `tsconfig`、独立命令；何时并入 `check` 另起票，不在本档顺手做 |
| 存量 `tests/helpers/*.mjs` 复用会触发“改 JS 即重构为 TS” | 成立 | B 档不复用、不改存量 JS；harness 自带最小假件，复用只在 C 档另起重构票 |

## 非目标（本档不做）

- 不真发 npm（无 token/2FA 动作，无 registry 可见性轮询）。
- 不改 `src/`、`tests/*.mjs`、`scripts/*.mjs`、`package.json`、`files` 白名单。
- 不引入新运行时依赖；`selftest/` 只用 Node 内置（`node:fs/promises`、`node:path`）。
