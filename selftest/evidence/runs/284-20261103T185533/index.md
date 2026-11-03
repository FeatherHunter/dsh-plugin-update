# 真机证据索引 · f3-exit-one-third-party-failure

- runId：284-20261103T185533
- 票：#284
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T10:55:33.325Z / 2026-11-03T10:56:07.892Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:/dsh-plugin/_wt263/t12（分支 impl/284-known-red-recovery，HEAD 3c2997f7a73904165619412b8fcba6edb08f4171）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c24b0e67a15a3b8dd96584b24d8a68afbaa273c1681d201efc
- SUT dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（208 个文件）
- 安装后 dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c2…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1 | **pass** |
| 09-assert | 建普通 web profile（等效宿主的宿主环境） | 在 run 私有 DSH_HOME 里建一个普通 web 使用范围，基版装进它；产品对宿主种类的判定由 readerOverrides.environmentKind 显式给 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t12-284\284-20261103T185533\os-home\.dsh\profiles\t3eq | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t12-284\284-20261103T185533\os-home\.dsh\profiles\t3eq | **pass** |
| 11-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 14-assert | setup-sut | profile 里装的 SUT 与工作树构建一致 | installed distDigest === worktree distDigest | true | **pass** |
| 15-assert | 基版在盘（更新前状态） | 更新前隔离 profile 的 node_modules 里装的是场景声明的基版 0.0.1 | 磁盘版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 22-assert | f3a 故障注入：变体 tarball 下架 | check 通过后只删 tarball 文件（版本元数据与 integrity 不动）：删前 200 非空、删后 404 | servedBeforeStatus=200 且字节>0；servedAfterStatus=404；versionDocUnchanged=true | before=200/104489B；after=404；versionDocUnchanged=true | **pass** |
| 24-assert | f3a 安装作业终态 | 出口一 registry 类失败（tarball 404）下产品给用户的作业终态 | state=failed；code=install-failed（产品码不泄漏成 pnpm 原始码） | state=failed；code=install-failed；message=install-failed: Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt): [ERR_PNPM_FETCH_404] GET https://127.0.0.1:52814/dsh-plugin-update-fixture-a/-/dsh-plugin-update-fixture-a-0.0.2.tgz: Not Found - 404 No authorization header… | **pass** |
| 25-assert | f3a 失败发生在 install、不是超时兜底 | tarball 404 应立即失败（远小于 installTimeoutMs=300000ms） | elapsedMs < 60000 | elapsedMs=1017 | **pass** |
| 26-assert | f3a 人话格保留宿主原话（pnpm 404） | 失败 message/detail 里能读到 pnpm 的原始报错（ERR_PNPM_*/404/fetch），不是只剩裸码 | 含 ERR_PNPM 或 404 或 fetch（大小写不敏感） | install-failed: Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt): [ERR_PNPM_FETCH_404] GET https://127.0.0.1:52814/dsh-plugin-update-fixture-a/-/dsh-plugin-update-fixture-a-0.0.2.tgz: Not Found - 404 No authorization header… | **pass** |
| 27-assert | f3a registry 类失败不出现载体命令 | registry 类失败给不出可执行载体命令（契约：这类失败没有命令），诚实面不得出现 dsh plugin --profile/--registry= | 不含 dsh plugin --profile，不含 --registry= | carrier=false；message=install-failed: Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt): [ERR_PNPM_FETCH_404] GET https://127.0.0.1:52814/dsh-plugin-update-fixture-a/-/dsh-plugin-update-fixture-a-0.0.2.tgz: Not Found - 404 No authorization header… | **pass** |
| 28-assert | f3a 失败后面板不撒谎 | tarball 404 失败后面板（5s 轮询刷新后）显示失败横幅，且不出现「已是最新 / 更新成功」等成功话术 | banner.kind=failed；卡片不出现「已是最新 / 更新成功」 | banner={"kind":"failed","title":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者","action":""}；install={"present":true,"kind":null,"status":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者","manualSummary":"手工命令","buttons":[{"action":"copy-diag","text":"复制诊断","disabled":false},{"action":"copy-manual","text":"复制手工命令","disabled":false}]}；waitError=null；text=夹具 A · 更新演示client v0.0.1host v0.0.1单席位集成方（无批量席位行）宿主行为 无（v1）.dsh-upd-entry{display:inline-flex;align-items:center;gap:8px;font:13px/1.6 var(--dsh-update-font-sans,system-ui,"Microsoft YaHei",sans-serif);font-size:var(--dsh-update-entry-font-size,13px);color:var(--dsh-update-text,#1f2937)} .dsh-upd-entry-btn{font:inherit;border:1px solid var(--dsh-update-border,#d1d5db);border-radius:var(--dsh-update-entry-border-radius,6px); background:var(--dsh-update-button-bg,#f9fafb);color:inherit;padding:var(--dsh-update-entry-padding,4px 12px);zoom:var(--dsh-update-entry-scale,1);cursor:pointer} .dsh-upd- | **pass** |
| 30-assert | f3a 失败后磁盘仍是基版 | pnpm 取包 404 → node_modules 里夹具包版本不变 | 0.0.1 | 0.0.1 | **pass** |
| 32-assert | f3a 源恢复 | run 收尾前把下架的 tarball 放回：再取 200 且版本文档未变（不影响后续格） | restoredStatus=200；versionDocUnchanged=true | restore={"restoredStatus":200,"versionDocUnchanged":true}；error=null | **pass** |
| 35-assert | f3a 等效宿主真的跑了 CLI（不是假回包） | runPlugin 采集：mode=real-cli；参数含 plugin/add/包@变体/--registry；CLI 退出码非 0 且输出是 pnpm 原话 | mode=real-cli；args 含 add 与 dsh-plugin-update-fixture-a@0.0.2；exitCode≠0；输出含 ERR_PNPM/404/fetch | mode=real-cli；args=["--expose-internals","D:\\DeepseekHarness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js","plugin","--profile","t3eq","add","--save-exact","dsh-plugin-update-fixture-a@0.0.2","--registry=https://127.0.0.1:52814"]；exitCode=1；outputTail=st supply-chain policies (3 entries)... ✓ Lockfile passes supply-chain policies (3 entries in 2ms) Progress: resolved 1, reused 0, downloaded 0, added 0 Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt):   dsh-plugin-update-fixture-a@0.0.2 Packages: +1 + [ERR_PNPM_FETCH_404] GET https://127.0.0.1:52814/dsh-plugin-update-fixture-a/-/dsh-plugin-update-fixture-a-0.0.2.tgz: Not Found - 404  No authorization header was set for the request. dsh: plugin command failed; diagnostics: D:\dsh-plugin\_wt263\runtime\t12-284\284-20261103T185533\os-home\.dsh\profiles\t3eq\.plugin-manager\logs\operation-kjn4XS\pnpm.log  | **pass** |
| 37-assert | f3a：产品安装执行日志 | 真机产品日志里这次安装的 route/ok/exitCode（update.install.exec 事件） | route=desktop-service；ok=true；exitCode=0（成功格）或 ok=false + update.install.fail 一行（失败格） | route=desktop-service；ok=false；exitCode=1；exec 条数=1 | **pass** |
| 38-assert | f3a：产品失败日志（update.install.fail） | 失败格的产品失败事实：stage/reason/code/detail 原文 | stage=exec；code=install-failed；reason=nonzero-exit\|timeout；detail 为宿主原话 | stage=exec；reason=nonzero-exit；code=install-failed；detail= | **pass** |
| 39-assert | f3a 产品失败日志：路线/非零退出 | update.install.exec 记录 route=desktop-service、ok=false、exitCode 非 0（真 CLI 非零退出） | route=desktop-service；ok=false；exitCode 是数字且≠0 | route=desktop-service；ok=false；exitCode=1 | **pass** |
| 40-assert | f3a 产品失败日志：reason/code（宿主原话在电话回包，不在日志事件） | update.install.fail 一行：reason=nonzero-exit、code=install-failed、hostCodeHash=none；pnpm 原话在电话回包 message（前面已断言） | reason=nonzero-exit；code=install-failed；hostCodeHash=none | reason=nonzero-exit；code=install-failed；hostCodeHash=none | **pass** |
| 42-assert | f3b 前置：清掉上一格持久化失败状态（干净面板，不动磁盘安装） | 清 home/.dsh/updates 与 update-queue：F3-A 的失败作业状态会让面板横幅一直停在「更新失败」 | 清理前读到 state=failed（带 install-failed 原文）；清理后两个目录都不存在 | files=3；hadFailedState=true；absentAfter=true | **pass** |
| 48-assert | f3b 安装作业终态 | 出口一宿主无 terminate、runPlugin 挂死：产品按 deadline 判超时失败 | state=failed；code=install-failed | state=failed；code=install-failed；message=install-failed: 安装超时；宿主未提供终止能力，这次安装可能仍在后台继续 | **pass** |
| 49-assert | f3b 超时文案逐字：未提供终止能力 | 产品超时人话格按能力分支：无 terminate 时必须用常量原文（src/core/executor.ts:92） | 含「安装超时；宿主未提供终止能力，这次安装可能仍在后台继续」 | install-failed: 安装超时；宿主未提供终止能力，这次安装可能仍在后台继续 | **pass** |
| 50-assert | f3b 不谎称已取消/已终止 | 没有 terminate 能力时不得出现「已请求宿主取消/终止」「已终止子进程」等我们去做了的话术 | 不含「安装超时，已请求宿主取消」「安装超时，已请求宿主终止」「安装超时，已终止子进程」 | install-failed: 安装超时；宿主未提供终止能力，这次安装可能仍在后台继续 | **pass** |
| 51-assert | f3b 超时失败不出现载体命令 | 超时路径不补载体命令（契约） | 不含 dsh plugin --profile/--registry= | carrier=false | **pass** |
| 52-assert | f3b 确实按 deadline+宽限收尾 | installTimeoutMs=3000ms + 3s 宽限；不能秒回、也不能拖过 20000ms | 5000 ≤ elapsedMs ≤ 20000 | elapsedMs=6056 | **pass** |
| 53-assert | f3b 超时失败后面板不撒谎 | 超时失败后面板显示失败横幅；不出现「已是最新/更新成功」，也不谎称「已终止子进程」（无 terminate 能力） | banner.kind=failed；不含「已是最新」「更新成功」「已终止子进程」 | banner={"kind":"failed","title":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者","action":""}；install={"present":true,"kind":null,"status":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者","manualSummary":"手工命令","buttons":[{"action":"install","text":"重试安装","disabled":false},{"action":"copy-diag","text":"复制诊断","disabled":false},{"action":"copy-manual","text":"复制手工命令","disabled":false}]}；waitError=null；text=夹具 A · 更新演示client v0.0.1host v0.0.1单席位集成方（无批量席位行）宿主行为 无（v1）.dsh-upd-entry{display:inline-flex;align-items:center;gap:8px;font:13px/1.6 var(--dsh-update-font-sans,system-ui,"Microsoft YaHei",sans-serif);font-size:var(--dsh-update-entry-font-size,13px);color:var(--dsh-update-text,#1f2937)} .dsh-upd-entry-btn{font:inherit;border:1px solid var(--dsh-update-border,#d1d5db);border-radius:var(--dsh-update-entry-border-radius,6px); background:var(--dsh-update-button-bg,#f9fafb);color:inherit;padding:var(--dsh-update-entry-padding,4px 12px);zoom:var(--dsh-update-entry-scale,1);cursor:pointer} .dsh-upd- | **pass** |
| 55-assert | f3b 超时后磁盘仍是基版 | runPlugin 根本没跑（只是挂起），node_modules 版本不变 | 0.0.1 | 0.0.1 | **pass** |
| 58-assert | f3b 宿主侧确实是「挂起且无 terminate」形态 | runPlugin 采集 mode=hang-no-terminate，参数含 add/包@变体/--registry；且没有任何 cancel/terminate 采集 | mode=hang-no-terminate；args 含 add 与 dsh-plugin-update-fixture-a@0.0.2；无 cancel 采集 | mode=hang-no-terminate；args=["add","--save-exact","dsh-plugin-update-fixture-a@0.0.2","--registry=https://127.0.0.1:52814"]；hasCancel=false | **pass** |
| 60-assert | f3b：产品安装执行日志 | 真机产品日志里这次安装的 route/ok/exitCode（update.install.exec 事件） | route=desktop-service；ok=true；exitCode=0（成功格）或 ok=false + update.install.fail 一行（失败格） | route=desktop-service；ok=false；exitCode=null；exec 条数=2 | **pass** |
| 61-assert | f3b：产品失败日志（update.install.fail） | 失败格的产品失败事实：stage/reason/code/detail 原文 | stage=exec；code=install-failed；reason=nonzero-exit\|timeout；detail 为宿主原话 | stage=exec；reason=timeout；code=install-failed；detail= | **pass** |
| 62-assert | f3b 产品失败日志：路线与 ok | update.install.exec 记录 route=desktop-service、ok=false | route=desktop-service；ok=false | route=desktop-service；ok=false | **pass** |
| 63-assert | f3b 产品失败日志：reason=timeout（诚实文案在电话回包，不在日志事件） | update.install.fail 一行：reason=timeout、code=install-failed；「未提供终止能力」原文在作业 message（上一格已断言） | reason=timeout；code=install-failed | reason=timeout；code=install-failed | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 29-shot | f3a-failed-panel | tarball 404 失败后的面板：失败横幅与磁盘/版本读数 | banner.kind=failed；卡片不出现「已是最新 / 更新成功」等成功话术 | banner={"kind":"failed","title":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者","action":""}；install={"present":true,"kind":null,"status":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者","manualSummary":"手工命令","buttons":[{"action":"copy-diag","text":"复制诊断","disabled":false},{"action":"copy-manual","text":"复制手工命令","disabled":false}]}；text=夹具 A · 更新演示client v0.0.1host v0.0.1单席位集成方（无批量席位行）宿主行为 无（v1）.dsh-upd-entry{display:inline-flex;align-items:center;gap:8px;font:13px/1.6 var(--dsh-update-font-sans,system-ui,"Microsoft YaHei",sans-serif);font-size:var(--dsh-update-entry-font-size,13px);color:var(--dsh-update-text,#1f2937)} .dsh-upd-entry-btn{font:inherit;border:1px solid var(--dsh-update-border,#d1d5db);border-radius:var(--dsh-update-entry-border-radius,6px); background:var(--dsh-update-button-bg,#f9fafb);color:inherit;padding:var(--dsh-update-entry-padding,4px 12px);zoom:var(--dsh-update-entry-scale,1);cursor:pointer} .dsh-upd-entry-btn:hover{border-color:var(--dsh-update-primary,#2563eb)} .dsh-upd-entry-btn,.dsh-upd-entry-dot{transition:background-color .15s ease,border-color .15s ease,color .15s ease,transform .06s ease} .dsh-upd-entry-btn:active:not(:disabled){transform:translateY(1px)} .dsh-upd-entry-btn:disabled,.dsh | **pass** | [shots\29-shot.png](shots\29-shot.png) |
| 54-shot | f3b-timeout-panel | 超时失败后的面板：失败横幅 + 无「已终止」误导 | banner.kind=failed；不含「已是最新」「更新成功」「已终止子进程」 | banner={"kind":"failed","title":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者","action":""}；install={"present":true,"kind":null,"status":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者","manualSummary":"手工命令","buttons":[{"action":"install","text":"重试安装","disabled":false},{"action":"copy-diag","text":"复制诊断","disabled":false},{"action":"copy-manual","text":"复制手工命令","disabled":false}]}；text=夹具 A · 更新演示client v0.0.1host v0.0.1单席位集成方（无批量席位行）宿主行为 无（v1）.dsh-upd-entry{display:inline-flex;align-items:center;gap:8px;font:13px/1.6 var(--dsh-update-font-sans,system-ui,"Microsoft YaHei",sans-serif);font-size:var(--dsh-update-entry-font-size,13px);color:var(--dsh-update-text,#1f2937)} .dsh-upd-entry-btn{font:inherit;border:1px solid var(--dsh-update-border,#d1d5db);border-radius:var(--dsh-update-entry-border-radius,6px); background:var(--dsh-update-button-bg,#f9fafb);color:inherit;padding:var(--dsh-update-entry-padding,4px 12px);zoom:var(--dsh-update-entry-scale,1);cursor:pointer} .dsh-upd-entry-btn:hover{border-color:var(--dsh-update-primary,#2563eb)} .dsh-upd-entry-btn,.dsh-upd-entry-dot{transition:background-color .15s ease,border-color .15s ease,color .15s ease,transform .06s ease} .dsh-upd-entry-btn:active:not(:disabled){transform:translateY(1px)} .dsh-upd-entry-btn:disabled,.dsh | **pass** | [shots\54-shot.png](shots\54-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [isolation-facts](raw\07-isolation-facts.json)
- [profile-create](raw\08-profile-create.json)
- [install-baseline](raw\10-install-baseline.json)
- [sut-installed-dist](raw\12-sut-installed-dist.json)
- [failure-variant-injection](raw\16-failure-variant-injection.json)
- [fixture-published-variant](raw\17-fixture-published-variant.json)
- [equivalent-host-spec-exit-one-registry-fail](raw\18-equivalent-host-spec-exit-one-registry-fail.json)
- [host-launch-exit-one-registry-fail](raw\19-host-launch-exit-one-registry-fail.json)
- [equivalent-host-boundary-0](raw\20-equivalent-host-boundary-0.json)
- [f3a-registry-tarball-fault](raw\21-f3a-registry-tarball-fault.json)
- [f3a-phone-status-terminal](raw\23-f3a-phone-status-terminal.json)
- [f3a-registry-tarball-restore](raw\31-f3a-registry-tarball-restore.json)
- [host-stop-0](raw\33-host-stop-0.json)
- [f3a-equivalent-host-captures](raw\34-f3a-equivalent-host-captures.json)
- [f3a-install-log-facts](raw\36-f3a-install-log-facts.json)
- [f3b-panel-state-reset](raw\41-f3b-panel-state-reset.json)
- [equivalent-host-spec-exit-one-hang](raw\43-equivalent-host-spec-exit-one-hang.json)
- [host-launch-exit-one-hang](raw\44-host-launch-exit-one-hang.json)
- [equivalent-host-boundary-1](raw\45-equivalent-host-boundary-1.json)
- [f3b-hang-marker](raw\46-f3b-hang-marker.json)
- [f3b-phone-status-terminal](raw\47-f3b-phone-status-terminal.json)
- [host-stop-1](raw\56-host-stop-1.json)
- [f3b-equivalent-host-captures](raw\57-f3b-equivalent-host-captures.json)
- [f3b-install-log-facts](raw\59-f3b-install-log-facts.json)
- [log-fxa-a-2026-11-03](raw\64-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\65-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\66-log-fxa-c-2026-11-03.json)
- [cleanup-log-files](raw\67-cleanup-log-files.json)
- [tls-front-stop](raw\68-tls-front-stop.json)

## 清理

- 进程 exit-one-registry-fail-host（pid 64976）：停止后存活=false
- 进程 exit-one-hang-host（pid 80244）：停止后存活=false
- 端口 exit-one-registry-fail-host-port（57138）：已释放=true
- 端口 exit-one-hang-host-port（57221）：已释放=true
- 端口 tls-registry-front（52814）：已释放=true
- 端口 registry（57559）：已释放=true
- 本地 registry：http://127.0.0.1:57559（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 等效宿主（本机没有第三方 Desktop / 官方桌面）：用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入宿主能力；产品路由/执行器/电话/面板/日志全真实，安装由官方发行包 CLI 真跑 pnpm 落真磁盘。边界见 raw/equivalent-host-boundary-*。
- F3 故障注入：变体 0.0.2 内容带本 run 注入标记（seatLine/hostBehavior 含 stamp），使 tarball integrity 与历史 run 不同；构建标记仍 v0.0.2
- 宿主 exit-one-registry-fail 已起：kind=desktop，port=57138，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright
- 等效宿主边界（0，kind=desktop）：本机没有第三方 Desktop / 官方桌面；用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入等效宿主能力，产品走真实路由/executor/电话/面板；stub=宿主进程内的服务对象（desktopProfiles/desktopPnpm/pluginManager）由夹具模板提供，不是宿主发行包自带
- f3a 注入：check 通过后下架 dsh-plugin-update-fixture-a@0.0.2 的 tarball（元数据保留）→ 安装阶段应 404；本 run 结束前恢复。
- 宿主 exit-one-hang 已起：kind=desktop，port=57221，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright
- 等效宿主边界（1，kind=desktop）：本机没有第三方 Desktop / 官方桌面；用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入等效宿主能力，产品走真实路由/executor/电话/面板；stub=宿主进程内的服务对象（desktopProfiles/desktopPnpm/pluginManager）由夹具模板提供，不是宿主发行包自带
- f3b 注入：profile 目录放 .equiv-hang，夹具 runPlugin 返回永不 settle 的 done 且无 terminate。

## 备注

- 本地 registry：http://127.0.0.1:57559（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 等效宿主（本机没有第三方 Desktop / 官方桌面）：用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入宿主能力；产品路由/执行器/电话/面板/日志全真实，安装由官方发行包 CLI 真跑 pnpm 落真磁盘。边界见 raw/equivalent-host-boundary-*。
- F3 故障注入：变体 0.0.2 内容带本 run 注入标记（seatLine/hostBehavior 含 stamp），使 tarball integrity 与历史 run 不同；构建标记仍 v0.0.2
- 宿主 exit-one-registry-fail 已起：kind=desktop，port=57138，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright
- 等效宿主边界（0，kind=desktop）：本机没有第三方 Desktop / 官方桌面；用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入等效宿主能力，产品走真实路由/executor/电话/面板；stub=宿主进程内的服务对象（desktopProfiles/desktopPnpm/pluginManager）由夹具模板提供，不是宿主发行包自带
- f3a 注入：check 通过后下架 dsh-plugin-update-fixture-a@0.0.2 的 tarball（元数据保留）→ 安装阶段应 404；本 run 结束前恢复。
- 宿主 exit-one-hang 已起：kind=desktop，port=57221，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright
- 等效宿主边界（1，kind=desktop）：本机没有第三方 Desktop / 官方桌面；用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入等效宿主能力，产品走真实路由/executor/电话/面板；stub=宿主进程内的服务对象（desktopProfiles/desktopPnpm/pluginManager）由夹具模板提供，不是宿主发行包自带
- f3b 注入：profile 目录放 .equiv-hang，夹具 runPlugin 返回永不 settle 的 done 且无 terminate。

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
