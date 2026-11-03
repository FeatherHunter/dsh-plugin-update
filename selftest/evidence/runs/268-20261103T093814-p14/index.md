# 真机证据索引 · g5-desktop-manager-no-cancel-probe

- runId：268-20261103T093814-p14
- 票：#268
- 宿主通道：desktop-official
- 开始/结束：2026-11-03T02:22:42.703Z / 2026-11-03T02:25:13.572Z
- 总判定：**known-red**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:/dsh-plugin/_wt263/t11（分支 impl/263-t11，HEAD bd39b57baa10f3c9f128dfd05f66b286d8828045）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c24b0e67a15a3b8dd96584b24d8a68afbaa273c1681d201efc
- SUT dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（208 个文件）
- 安装后 dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c2…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1, dsh-plugin-update-fixture-b@0.0.1, dsh-plugin-update-fixture-c@0.0.1 | **pass** |
| 10-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 11-assert | 干净 profile 装基版（b） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-b@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-b；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b]；磁盘版本=0.0.1；exit=0 | **pass** |
| 12-assert | 干净 profile 装基版（c） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-c@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-c；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a, dsh-plugin-update-fixture-b, dsh-plugin-update-fixture-c]；磁盘版本=0.0.1；exit=0 | **pass** |
| 14-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 16-assert | 基版 UI | A 批量面板列出 a/b/c 三行，B/C 卡片是 0.0.1 | rows=a,b,c；B clientTag=client v0.0.1；C 徽标 0.0.1 | {"rows":"a,b,c","cardB":"client v0.0.1","cardC":{"present":true,"clientTag":"client v0.0.1","badge":"夹具 C · client v0.0.1"},"disk":{"versions":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":"0.0.1","dsh-plugin-update-fixture-c":"0.0.1"},"dependencies":{"dsh-plugin-update-fixture-a":"0.0.1","dsh-plugin-update-fixture-b":"0.0.1","dsh-plugin-update-fixture-c":"0.0.1"}}} | **pass** |
| 19-assert | D5 真机宿主 | 官方桌面真实启动并加载夹具页面（证明探测发生在真宿主上下文） | 页面文本非空且含夹具卡片 | pageText 长度 530；含 fixture 卡片=true | **pass** |
| 23-assert | D5 能力探测 | 官方宿主 asar 里有插件管理器符号（i.e. 探测对象是真实宿主二进制，不是推断） | pluginManager>0 且 installBundle>0 | {"asarPath":"D:/DeepseekHarness/resources/app.asar","asarBytes":182766714,"counts":{"pluginManager":724,"installBundle":98,"cancelInstall":66,"setBundleEnabled":95}} | **pass** |
| 24-assert | D5 能力探测 | 官方宿主是否提供 cancelInstall（决定超时人话格该走「已请求宿主取消」还是「宿主未提供取消能力」） | 命中数>0 ⇒ 宿主有取消能力 | cancelInstall 命中 66 处；片段="n...//#region ../../boot/plugin-manager/lib/typert.remote-client.js...let _deepseek_ai_dsh_plugin_manager_pluginManager_cancelInstall_parameter_0$schema$value;...const _deepseek_ai_dsh_plugin_manager_pluginManager_cancelInstall_parameter_0$schema = () => _deepseek_ai_dsh_plugin_manager_pluginManager" | **pass** |
| 26-assert | D5 库内诚实文案 | 产品在宿主无 cancelInstall 时的超时文案（L0 定向测试：detail 含「未提供取消能力/可能仍在后台继续」且不含「已请求宿主取消」） | node --test tests/issue-184-timeout-honesty.test.mjs 退出码 0 | exitCode=0；stdout 尾部=▶ issue #184：超时语义诚实化（不谎称已取消；移除超时点明包可能已不在册）   ✔ 宿主没有 cancelInstall：安装步超时人话格如实说「未提供取消能力」，不谎称已请求取消 (3059.8335ms)   ✔ 移除步超时：人话格点明「目标包可能已不在册」并给「重启宿主 + 手工命令」的下一步 (3059.4217ms)   ✔ 移除超时后，面板输入的环境视图读得到「已摘选中」（includeEnv 回包 registered=false） (3055.3466ms) ✔ issue #184：超时语义诚实化（不谎称已取消；移除超时点明包可能已不在册） (9176.0509ms) ℹ tests 3 ℹ suites 1 ℹ pass 3 ℹ fail 0 ℹ cancelled 0 ℹ skipped 0 ℹ todo 0 ℹ duration_ms 9275.9307  | **pass** |
| 27-assert | D5 真机无能力宿主 | 真机造出一个「宿主没有 cancelInstall」的官方桌面实例来跑无能力超时格（票面要求的真机形态） | 官方桌面宿主没有 cancelInstall 能力 | 官方宿主 D:/DeepseekHarness/resources/app.asar 命中 cancelInstall 66 处（@deepseek-ai/dsh-plugin-manager 0.2.1-rc.5）、installBundle 98 处 ⇒ 本机无法造出无能力宿主 | **known-red** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 17-shot | 基版 UI | A 批量面板与 B/C 卡片的初始形态 | 三行；B/C 0.0.1；面板可见 | rows=a,b,c；B=client v0.0.1；C=client v0.0.1 | **pass** | [shots\17-shot.png](shots\17-shot.png) |
| 20-shot | D5 真机宿主 | 官方桌面真实启动（能力探测的宿主上下文） | 窗口里有夹具卡片 | pageText 长度 530 | **pass** | [shots\20-shot.png](shots\20-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [desktop-first-launch](raw\07-desktop-first-launch.json)
- [desktop-stop-bootstrap](raw\08-desktop-stop-bootstrap.json)
- [install-baseline](raw\09-install-baseline.json)
- [sut-installed-dist](raw\13-sut-installed-dist.json)
- [batch-panel-initial](raw\15-batch-panel-initial.json)
- [probe-page-text](raw\18-probe-page-text.json)
- [desktop-stop-probe](raw\21-desktop-stop-probe.json)
- [host-asar-probe](raw\22-host-asar-probe.json)
- [l0-no-cancel-honesty](raw\25-l0-no-cancel-honesty.json)（命令 D:\2Study\nodejs\node.exe --test tests/issue-184-timeout-honesty.test.mjs，exit 0）

## 清理

- 进程 desktop-bootstrap（pid 76224）：停止后存活=false
- 进程 desktop-main（pid 99560）：停止后存活=false
- 端口 registry（65380）：已释放=true
- 本地 registry：http://127.0.0.1:65380（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- D5 结论：官方桌面 0.2.1-rc.5 有 cancelInstall；无能力真机格 known-red（条件已写清），库内诚实文案测试绿。

## 维护者 profile 未污染

- 目录：C:/Users/辰辰洋洋/.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:65380（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- D5 结论：官方桌面 0.2.1-rc.5 有 cancelInstall；无能力真机格 known-red（条件已写清），库内诚实文案测试绿。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
