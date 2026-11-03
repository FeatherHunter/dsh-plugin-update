# 真机证据索引 · l3-permission-denied

- runId：284-20261103T200100
- 票：#284
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T11:14:56.621Z / 2026-11-03T11:15:27.954Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:\dsh-plugin\_wt263\t13（分支 impl/284-boundary-gaps，HEAD 1734155b93395b81f27b23247513149f48f3e109）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 0261815ccdf01683e6194b0b53c70dac7a282bf001740b3242da55e8ae3b9755
- SUT dist 指纹：e280a81080925fdcc76eda4f9edf2559e8ae81b7fce01f326fe301220e119117（208 个文件）
- 安装后 dist 指纹：e280a81080925fdcc76eda4f9edf2559e8ae81b7fce01f326fe301220e119117（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 0261815ccdf01683…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1 | **pass** |
| 10-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 12-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e280a81080925fdcc76eda4f9edf2559e8ae81b7fce01f326fe301220e119117 | e280a81080925fdcc76eda4f9edf2559e8ae81b7fce01f326fe301220e119117（文件数 208 / 工作树 208） | **pass** |
| 13-assert | setup-sut | 通道 B profile 里装的 SUT 与工作树构建一致 | installed distDigest === worktree distDigest | true | **pass** |
| 14-assert | setup-base-disk | 基版安装后磁盘版本与声明一致 | {"dsh-plugin-update-fixture-a":"0.0.1"} | dsh-plugin-update-fixture-a=0.0.1 | **pass** |
| 18-assert | l3-00-check-before-inject | 权限注入前检查更新可用（失败可归因性依赖这一格） | 可更新横幅原文精确匹配 | {"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"} | **pass** |
| 21-assert | l3-01-acl-injected | 外部注入生效：ACL 拒绝写/加子目录 + 同用户写探针真失败、读包仍成功（失败可归因于安装写，不是包读坏） | deny exit=0、写探针 EPERM/EACCES、读 package.json ok | {"denyExit":0,"probe":{"ok":false,"code":"EPERM","message":"EPERM: operation not permitted, open 'D:\\dsh-plugin\\_wt263\\runtime\\t13-284\\runs\\284-20261103T200100\\os-home\\.dsh\\profiles\\t13b\\node_modules\\.l284-write-probe-1793704511674.txt'"},"readProbe":{"ok":true,"bytes":685,"code":null},"aclTail":["                                                                                                      BUILTIN\\Users:(I)(OI)(CI)(IO)(GR,GE)","","�ѳɹ����� 1 ���ļ�; ���� 0 ���ļ�ʱʧ��"]} | **pass** |
| 25-assert | l3-02-failure-honest | 权限不足的失败面诚实：失败横幅+错误码，台账 failed，stage=exec/verify | kind=failed、标题含「更新失败」、errCode 非空、台账 state=failed、stage∈{exec,verify} | {"bannerKind":"failed","errCode":"install-failed","ledgerState":"failed","failStage":"exec","failReason":"nonzero-exit","failCodeLogged":"install-failed"} | **pass** |
| 26-assert | l3-03-permission-original | 失败 detail 含真实权限错误原话（不是空泛未知错误） | 台账 message 或人话格出现 EPERM/EACCES/access denied/权限类原话 | {"permissionInHuman":true,"humanText":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。 \| 请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者 \| install-failed: Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt): [ERR_PNPM_EPERM] [importPackage <路径> EPERM: operation not permitted, mkdir '<路径>'"} | **pass** |
| 27-assert | l3-04-no-false-success-no-retry | 无假成功、无自动重试：磁盘仍基版、台账 failed、恰一次安装尝试 | 磁盘 A=0.0.1、台账非成功、exec 恰 1 且无 ok=true、request/fail 各恰 1 | {"disk":{"dsh-plugin-update-fixture-a":"0.0.1"},"ledgerState":"failed","execs":1,"okExecs":0,"requests":1,"fails":1} | **pass** |
| 29-assert | l3-05-acl-restored | 恢复 ACL 并复核：拒绝项移除、同用户写探针恢复成功 | icacls /remove:d exit=0 且写探针 ok=true | {"restoreExit":0,"probe":{"ok":true,"code":null,"message":null},"aclTail":["                                                                                                      BUILTIN\\Users:(I)(OI)(CI)(IO)(GR,GE)","","�ѳɹ����� 1 ���ļ�; ���� 0 ���ļ�ʱʧ��"]} | **pass** |
| 32-assert | l3-06a-failure-persisted | 失败后重启仍如实展示失败（不谎称更新中、不自动重试） | kind=failed 且标题含「更新失败」 | {"banner":{"kind":"failed","title":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者"}} | **pass** |
| 34-assert | l3-06-retry-success | ACL 恢复后重试真装成（不是假成功） | 磁盘 0.0.2、台账成功终态 target=0.0.2、面板已了结 | {"disk":{"dsh-plugin-update-fixture-a":"0.0.2"},"ledgerState":"completed","banner":{"kind":"done","title":"已是最新，无需更新。","sub":""}} | **pass** |
| 37-assert | l3-07-single-success-record | 重试成功后台账只留一条成功终态（旧失败记录被成功覆盖，不算重复成功） | A 的 state.json 恰 1 份且成功、before.json 恰 1 份 | {"ledgerJobs":["completed"],"beforeFiles":["fxa-a/0755149b625073aea804221c/before.json"]} | **pass** |
| 39-assert | l3-08a-restart-honest-unknown | L3 重启后 A 面板首屏：新进程首屏没查过最新版时不得谎称已是最新 | 横幅 kind=idle/unknown、文案含「版本信息未知」、不含「已是最新」，并提供检查更新动作 | {"kind":"idle","title":"版本信息未知，请检查更新。","sub":"检查更新"} | **pass** |
| 41-assert | l3-08-restart-truthful | 重启后不残留失败谎报、无重复成功记录 | 面板已了结、build tags=0.0.2、台账恰 1 份成功 | {"banner":{"kind":"done","title":"已是最新，无需更新。","sub":""},"tags":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"ledgerCount":1} | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 17-shot | l3-10-check-before-inject | 权限注入前对照：真 UI 点检查后列出 0.0.2 可更新 | 可更新横幅原文精确匹配 | {"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"} | **pass** | [shots\17-shot.png](shots\17-shot.png) |
| 20-shot | l3-15-acl-injected | icacls 注入后同用户写探针被拒（外部 ACL 真生效），页面仍是注入前状态 | icacls /deny exit=0；同用户 writeFile 探针 EPERM/EACCES（失败）、读包仍 OK，不是猜「应该会失败」 | {"denyExit":0,"probe":{"ok":false,"code":"EPERM","message":"EPERM: operation not permitted, open 'D:\\dsh-plugin\\_wt263\\runtime\\t13-284\\runs\\284-20261103T200100\\os-home\\.dsh\\profiles\\t13b\\node_modules\\.l284-write-probe-1793704511674.txt'"},"readProbe":{"ok":true,"bytes":685,"code":null}} | **pass** | [shots\20-shot.png](shots\20-shot.png) |
| 22-shot | l3-20-failure-panel | ACL 拒绝写下真 UI 点安装：失败横幅（人话格）+ 错误码 + 手工备用区；无假成功 | 横幅 kind=failed、标题含「更新失败」、errCode 非空；不得呈现「已是最新」/更新成功 | {"banner":{"kind":"failed","title":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者"},"errCode":"install-failed","manual":{"present":true,"heading":"手工备用命令（请复制整行执行）：","code":"dsh plugin --profile t13b add --save-exact dsh-plugin-update-fixture-a@0.0.2 --registry=https://127.0.0.1:65143","neutral":""},"lastResort":{"present":true,"badge":"最后手段","status":"自动恢复不可用","reason":"没有可用的自动数据路径；复制这条命令是唯一出路。","copyText":"复制手工命令"}} | **pass** | [shots\22-shot.png](shots\22-shot.png) |
| 31-shot | l3-30-restart-failure-honest | 失败后重启（ACL 已恢复、未重试）：新宿主首屏如实保留上次失败横幅，不谎称更新中/已最新 | 横幅 kind=failed、标题含「更新失败」；无更新中/已是最新字样 | {"banner":{"kind":"failed","title":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者"},"errCode":"install-failed"} | **pass** | [shots\31-shot.png](shots\31-shot.png) |
| 33-shot | l3-40-retry-success | ACL 恢复后重试安装真装成 0.0.2：面板已了结、磁盘 0.0.2、台账成功终态 | 横幅「已是最新，无需更新。」、磁盘 0.0.2、台账成功终态 target=0.0.2 | {"banner":{"kind":"done","title":"已是最新，无需更新。","sub":""},"disk":{"dsh-plugin-update-fixture-a":"0.0.2"},"ledger":{"state":"completed","targetVersion":"0.0.2"}} | **pass** | [shots\33-shot.png](shots\33-shot.png) |
| 40-shot | l3-50-restart-truthful | 重启后如实展示：首屏版本未知（见 l3-08a）→ 真 UI 检查更新后面板已了结、运行构建 0.0.2、台账仍恰一条成功终态 | 横幅「已是最新，无需更新。」、clientTag/hostTag=0.0.2、台账恰 1 份成功 | {"banner":{"kind":"done","title":"已是最新，无需更新。","sub":""},"tags":{"clientTag":"client v0.0.2","hostTag":"host v0.0.2"},"ledgerJobs":["completed"]} | **pass** | [shots\40-shot.png](shots\40-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [tls-registry-front](raw\07-tls-registry-front.json)
- [isolation-facts](raw\08-isolation-facts.json)
- [install-baseline](raw\09-install-baseline.json)
- [sut-installed-dist](raw\11-sut-installed-dist.json)
- [fixture-publication](raw\15-fixture-publication.json)
- [host-launch-l3-gen1](raw\16-host-launch-l3-gen1.json)
- [l3-acl-inject](raw\19-l3-acl-inject.json)
- [host-stop-0](raw\23-host-stop-0.json)
- [l3-failure-facts](raw\24-l3-failure-facts.json)
- [l3-acl-restore](raw\28-l3-acl-restore.json)
- [host-launch-l3-gen2](raw\30-host-launch-l3-gen2.json)
- [host-stop-1](raw\35-host-stop-1.json)
- [l3-success-facts](raw\36-l3-success-facts.json)
- [host-launch-l3-gen3](raw\38-host-launch-l3-gen3.json)
- [host-stop-2](raw\42-host-stop-2.json)
- [log-fxa-a-2026-11-03](raw\43-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\44-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\45-log-fxa-c-2026-11-03.json)
- [cleanup-log-files](raw\46-cleanup-log-files.json)
- [tls-front-stop](raw\47-tls-front-stop.json)

## 清理

- 进程 l3-gen1-host（pid 71692）：停止后存活=false
- 进程 l3-gen2-host（pid 78864）：停止后存活=false
- 进程 l3-gen3-host（pid 97912）：停止后存活=false
- 端口 tls-registry-front（65143）：已释放=false
- 端口 l3-gen1-host-port（53739）：已释放=false
- 端口 l3-gen2-host-port（61553）：已释放=false
- 端口 l3-gen3-host-port（64270）：已释放=false
- 端口 registry（58470）：已释放=true
- 本地 registry：http://127.0.0.1:58470（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 l3-gen1 已起：port=53739，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:65143）
- 宿主 l3-gen2 已起：port=61553，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:65143）
- 宿主 l3-gen3 已起：port=64270，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:65143）

## 备注

- 本地 registry：http://127.0.0.1:58470（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 l3-gen1 已起：port=53739，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:65143）
- 宿主 l3-gen2 已起：port=61553，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:65143）
- 宿主 l3-gen3 已起：port=64270，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:65143）

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
