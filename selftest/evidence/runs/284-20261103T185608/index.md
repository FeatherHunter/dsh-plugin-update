# 真机证据索引 · g8-desktop-manager-no-cancel-timeout

- runId：284-20261103T185608
- 票：#284
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T10:56:08.145Z / 2026-11-03T10:56:35.075Z
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
| 09-assert | 建普通 web profile（等效宿主的宿主环境） | 在 run 私有 DSH_HOME 里建一个普通 web 使用范围，基版装进它；产品对宿主种类的判定由 readerOverrides.environmentKind 显式给 | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t12-284\284-20261103T185608\os-home\.dsh\profiles\t3eq | exit=0；profileDir=D:\dsh-plugin\_wt263\runtime\t12-284\284-20261103T185608\os-home\.dsh\profiles\t3eq | **pass** |
| 11-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 13-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 14-assert | setup-sut | profile 里装的 SUT 与工作树构建一致 | installed distDigest === worktree distDigest | true | **pass** |
| 15-assert | 基版在盘（更新前状态） | 更新前隔离 profile 的 node_modules 里装的是场景声明的基版 0.0.1 | 磁盘版本=0.0.1 | 磁盘版本=0.0.1 | **pass** |
| 22-assert | g8 安装作业终态（产品以为失败） | 等效桌面管理器无 cancelInstall、installBundle 迟迟不 resolve：产品按 deadline 判超时失败 | state=failed；code=install-failed | state=failed；code=install-failed；message=install-failed: 安装超时；宿主未提供取消能力，这次安装可能仍在后台继续 | **pass** |
| 23-assert | g8 超时文案逐字：未提供取消能力 | 产品管理器超时人话格按能力分支：无 cancelInstall 时必须用常量原文（src/core/executor.ts:48） | 含「安装超时；宿主未提供取消能力，这次安装可能仍在后台继续」 | install-failed: 安装超时；宿主未提供取消能力，这次安装可能仍在后台继续 | **pass** |
| 24-assert | g8 不谎称已取消/已终止 | 没有 cancelInstall 时不得出现「安装超时，已请求宿主取消/终止」等我们去做了的话术 | 不含「安装超时，已请求宿主取消」「安装超时，已请求宿主终止」 | install-failed: 安装超时；宿主未提供取消能力，这次安装可能仍在后台继续 | **pass** |
| 25-assert | g8 确实按 deadline+宽限收尾 | installTimeoutMs=3000ms + 3s 宽限；5000~25000ms | 5000 ≤ elapsedMs ≤ 25000 | elapsedMs=6057 | **pass** |
| 26-assert | g8 超时失败后面板不撒谎 | 管理器超时失败后面板显示失败横幅，不出现「已是最新 / 更新成功」（产品确实不知道后台会成功） | banner.kind=failed；不含「已是最新」「更新成功」 | banner={"kind":"failed","title":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者","action":""}；waitError=null；text=夹具 A · 更新演示（新版）client v0.0.2host v0.0.1单席位集成方（无批量席位行）宿主行为 无（v1）.dsh-upd-entry{display:inline-flex;align-items:center;gap:8px;font:13px/1.6 var(--dsh-update-font-sans,system-ui,"Microsoft YaHei",sans-serif);font-size:var(--dsh-update-entry-font-size,13px);color:var(--dsh-update-text,#1f2937)} .dsh-upd-entry-btn{font:inherit;border:1px solid var(--dsh-update-border,#d1d5db);border-radius:var(--dsh-update-entry-border-radius,6px); background:var(--dsh-update-button-bg,#f9fafb);color:inherit;padding:var(--dsh-update-entry-padding,4px 12px);zoom:var(--dsh-update-entry-scale,1);cursor:pointer} .dsh- | **pass** |
| 28-assert | g8 宿主仍活着、作业仍报失败 | 超时失败后宿主进程与产品服务仍可用（status 电话 200），作业状态仍 failed（产品不知道后台会成功） | status=200；job.state=failed | status=200；job.state=failed | **pass** |
| 29-assert | g8 超时失败但后台真把变体装上了 | installBundle 的 delay 结束后真跑 CLI：产品已判失败，磁盘 node_modules 却真的变成变体版 | dsh-plugin-update-fixture-a@0.0.2 | 0.0.2 | **pass** |
| 30-assert | g8 后台装完后产品仍报失败 | 磁盘已是变体版，但产品作业仍 failed（它真的不知道后台装完了；面板不谎称成功） | banner.kind=failed；不含「已是最新」 | banner={"kind":"failed","title":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者","action":""}；waitError=null；text=夹具 A · 更新演示（新版）client v0.0.2host v0.0.1单席位集成方（无批量席位行）宿主行为 无（v1）.dsh-upd-entry{display:inline-flex;align-items:center;gap:8px;font:13px/1.6 var(--dsh-update-font-sans,system-ui,"Microsoft YaHei",sans-serif);font-size:var(--dsh-update-entry-font-size,13px);color:var(--dsh-update-text,#1f2937)} .dsh-upd-entry-btn{font:inherit;border:1px solid var(--dsh-update-border,#d1d5db);border-radius:var(--dsh-update-entry-border-radius,6px); background:var(--dsh-update-button-bg,#f9fafb);color:inherit;padding:var(--dsh-update-entry-padding,4px 12px);zoom:var(--dsh-update-entry-scale,1);cursor:pointer} .dsh- | **pass** |
| 34-assert | g8 管理器侧收到真安装请求（带 registry 透传） | installBundle.request：packageSpec=包@变体；options.registry=本 run 的 https 源；无 cancel 调用 | packageSpec=dsh-plugin-update-fixture-a@0.0.2；registry=https://127.0.0.1:51172；hasCancel=false | packageSpec=dsh-plugin-update-fixture-a@0.0.2；registry=https://127.0.0.1:51172；hasCancel=false | **pass** |
| 35-assert | g8 后台 CLI 真跑且成功、installBundle 报 applied | delay 之后模板真 spawn CLI（exitCode=0），manager 回 application=applied（产品早已不等它） | cli.exitCode=0；result.application=applied；result.exitCode=0 | cliExit=0；result={"phase":"installBundle.result","packageSpec":"dsh-plugin-update-fixture-a@0.0.2","requestId":"28e7f5d1-d71e-401e-be18-4eec933be2da","application":"applied","exitCode":0} | **pass** |
| 41-assert | g8 产品失败日志：路线 desktop-manager + ok=false | update.install.exec 记录 route=desktop-manager、ok=false（超时失败） | route=desktop-manager；ok=false | route=desktop-manager；ok=false | **pass** |
| 42-assert | g8 产品失败日志：reason=timeout | update.install.fail：reason=timeout、code=install-failed（失败事件不带 detail，诚实文案在电话回包，已由上一条断言覆盖） | reason=timeout；code=install-failed | reason=timeout；code=install-failed；detail= | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 27-shot | g8-timeout-panel | 管理器超时失败后的面板（此刻后台其实还在装） | banner.kind=failed；卡片不出现「已是最新 / 更新成功」 | banner={"kind":"failed","title":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者","action":""}；text=夹具 A · 更新演示（新版）client v0.0.2host v0.0.1单席位集成方（无批量席位行）宿主行为 无（v1）.dsh-upd-entry{display:inline-flex;align-items:center;gap:8px;font:13px/1.6 var(--dsh-update-font-sans,system-ui,"Microsoft YaHei",sans-serif);font-size:var(--dsh-update-entry-font-size,13px);color:var(--dsh-update-text,#1f2937)} .dsh-upd-entry-btn{font:inherit;border:1px solid var(--dsh-update-border,#d1d5db);border-radius:var(--dsh-update-entry-border-radius,6px); background:var(--dsh-update-button-bg,#f9fafb);color:inherit;padding:var(--dsh-update-entry-padding,4px 12px);zoom:var(--dsh-update-entry-scale,1);cursor:pointer} .dsh-upd-entry-btn:hover{border-color:var(--dsh-update-primary,#2563eb)} .dsh-upd-entry-btn,.dsh-upd-entry-dot{transition:background-color .15s ease,border-color .15s ease,color .15s ease,transform .06s ease} .dsh-upd-entry-btn:active:not(:disabled){transform:translateY(1px)} .dsh-upd-entry-btn:disabled, | **pass** | [shots\27-shot.png](shots\27-shot.png) |
| 31-shot | g8-disk-updated-panel-still-failed | 磁盘已变体版但产品仍显示失败（「后台继续」的诚实文案与事实一致） | banner.kind=failed；卡片不出现「已是最新」（产品没刷新到成功） | banner={"kind":"failed","title":"更新失败（install-failed）：安装执行失败，详情见诊断摘要。","sub":"请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者","action":""}；text=夹具 A · 更新演示（新版）client v0.0.2host v0.0.1单席位集成方（无批量席位行）宿主行为 无（v1）.dsh-upd-entry{display:inline-flex;align-items:center;gap:8px;font:13px/1.6 var(--dsh-update-font-sans,system-ui,"Microsoft YaHei",sans-serif);font-size:var(--dsh-update-entry-font-size,13px);color:var(--dsh-update-text,#1f2937)} .dsh-upd-entry-btn{font:inherit;border:1px solid var(--dsh-update-border,#d1d5db);border-radius:var(--dsh-update-entry-border-radius,6px); background:var(--dsh-update-button-bg,#f9fafb);color:inherit;padding:var(--dsh-update-entry-padding,4px 12px);zoom:var(--dsh-update-entry-scale,1);cursor:pointer} .dsh-upd-entry-btn:hover{border-color:var(--dsh-update-primary,#2563eb)} .dsh-upd-entry-btn,.dsh-upd-entry-dot{transition:background-color .15s ease,border-color .15s ease,color .15s ease,transform .06s ease} .dsh-upd-entry-btn:active:not(:disabled){transform:translateY(1px)} .dsh-upd-entry-btn:disabled, | **pass** | [shots\31-shot.png](shots\31-shot.png) |
| 38-shot | g8-after-restart | 重启后构建标记：后台那次「产品以为失败」的安装确实换了运行代码 | client=client v0.0.2；host=host v0.0.2 | client=client v0.0.2；host=host v0.0.2；title=夹具 A · 更新演示（新版） | **pass** | [shots\38-shot.png](shots\38-shot.png) |

## raw 记录

- [registry-launch](raw\01-registry-launch.json)
- [sut-pin](raw\02-sut-pin.json)
- [dependency-mirror](raw\03-dependency-mirror.json)
- [fixture-published-baseline](raw\05-fixture-published-baseline.json)
- [isolation-facts](raw\07-isolation-facts.json)
- [profile-create](raw\08-profile-create.json)
- [install-baseline](raw\10-install-baseline.json)
- [sut-installed-dist](raw\12-sut-installed-dist.json)
- [fixture-published-variant](raw\16-fixture-published-variant.json)
- [equivalent-host-spec-manager-no-cancel](raw\17-equivalent-host-spec-manager-no-cancel.json)
- [host-launch-manager-no-cancel](raw\18-host-launch-manager-no-cancel.json)
- [equivalent-host-boundary-0](raw\19-equivalent-host-boundary-0.json)
- [g8-equivalent-manager-methods](raw\20-g8-equivalent-manager-methods.json)
- [g8-phone-status-terminal](raw\21-g8-phone-status-terminal.json)
- [host-stop-0](raw\32-host-stop-0.json)
- [g8-equivalent-host-captures](raw\33-g8-equivalent-host-captures.json)
- [equivalent-host-spec-manager-no-cancel-restarted](raw\36-equivalent-host-spec-manager-no-cancel-restarted.json)
- [host-launch-manager-no-cancel-restarted](raw\37-host-launch-manager-no-cancel-restarted.json)
- [host-stop-1](raw\39-host-stop-1.json)
- [g8-install-log-facts](raw\40-g8-install-log-facts.json)
- [log-fxa-a-2026-11-03](raw\43-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\44-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\45-log-fxa-c-2026-11-03.json)
- [cleanup-log-files](raw\46-cleanup-log-files.json)
- [tls-front-stop](raw\47-tls-front-stop.json)

## 清理

- 进程 manager-no-cancel-host（pid 57548）：停止后存活=false
- 进程 manager-no-cancel-restarted-host（pid 104812）：停止后存活=false
- 端口 manager-no-cancel-host-port（59386）：已释放=true
- 端口 manager-no-cancel-restarted-host-port（53141）：已释放=true
- 端口 tls-registry-front（51172）：已释放=true
- 端口 registry（58584）：已释放=true
- 本地 registry：http://127.0.0.1:58584（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 等效宿主（本机没有第三方 Desktop / 官方桌面）：用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入宿主能力；产品路由/执行器/电话/面板/日志全真实，安装由官方发行包 CLI 真跑 pnpm 落真磁盘。边界见 raw/equivalent-host-boundary-*。
- 宿主 manager-no-cancel 已起：kind=desktop-manager，port=59386，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright
- 等效宿主边界（0，kind=desktop-manager）：本机没有第三方 Desktop / 官方桌面；用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入等效宿主能力，产品走真实路由/executor/电话/面板；stub=宿主进程内的服务对象（desktopProfiles/desktopPnpm/pluginManager）由夹具模板提供，不是宿主发行包自带
- 宿主 manager-no-cancel-restarted 已起：kind=desktop-manager，port=53141，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright

## 备注

- 本地 registry：http://127.0.0.1:58584（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 等效宿主（本机没有第三方 Desktop / 官方桌面）：用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入宿主能力；产品路由/执行器/电话/面板/日志全真实，安装由官方发行包 CLI 真跑 pnpm 落真磁盘。边界见 raw/equivalent-host-boundary-*。
- 宿主 manager-no-cancel 已起：kind=desktop-manager，port=59386，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright
- 等效宿主边界（0，kind=desktop-manager）：本机没有第三方 Desktop / 官方桌面；用产品文档化入口 createMultiHostUpdate(deps.readerOverrides) 注入等效宿主能力，产品走真实路由/executor/电话/面板；stub=宿主进程内的服务对象（desktopProfiles/desktopPnpm/pluginManager）由夹具模板提供，不是宿主发行包自带
- 宿主 manager-no-cancel-restarted 已起：kind=desktop-manager，port=53141，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
