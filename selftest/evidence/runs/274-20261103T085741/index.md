# 真机证据索引 · k-single-panel-happy

- runId：274-20261103T085741
- 票：#274
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T00:57:42.003Z / 2026-11-03T00:58:32.984Z
- 总判定：**pass**（退出码 0）

## 环境

- node：v24.19.0
- 平台：win32
- 工作树：D:/dsh-plugin/_wt263/t10（分支 impl/263-t10，HEAD fb539ecc68dd107ca052d726cb8064bbfadd42d0）
- SUT：dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c24b0e67a15a3b8dd96584b24d8a68afbaa273c1681d201efc
- SUT dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（208 个文件）
- 安装后 dist 指纹：e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（一致=true）

## 断言

| # | 步骤 | 看什么 | expected | actual | 判定 |
| --- | --- | --- | --- | --- | --- |
| 04-assert | SUT 钉版 | 被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本 | 本地 registry 可见 dsh-plugin-update@0.18.39，且 tarball sha256 落盘 | dsh-plugin-update@0.18.39，tarball sha256 3502f4da6b9116c2…，dist 208 文件 | **pass** |
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1 | **pass** |
| 10-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 12-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 13-assert | setup-sut | 通道 B profile 里装的 SUT 与工作树构建一致 | installed distDigest === worktree distDigest | true | **pass** |
| 14-assert | setup-base-disk | 基版安装后磁盘版本与声明一致 | {"dsh-plugin-update-fixture-a":"0.0.1"} | dsh-plugin-update-fixture-a=0.0.1 | **pass** |
| 18-assert | k1-11-panel-done | 已安装且未查更新时单包面板显示已了结 | banner.kind=done、标题「已是最新，无需更新。」 | {"kind":"done","title":"已是最新，无需更新。","sub":""} | **pass** |
| 19-assert | k1-12-c-not-installed | 额外面板指向未安装的 C：显示未安装与检查动作 | banner.kind=idle、标题「未安装」、有 check 动作 | {"kind":"idle","title":"未安装","sub":"检查更新"}；actions=["check","install","copy-diag"] | **pass** |
| 20-assert | k1-13-install-button-loading | 安装按钮挂载后（autoCheck=never）未查询时呈 loading 档，并给检查动作 | kind=loading、status「正在读取更新状态…」、buttons 含 action=check | {"kind":"loading","status":"正在读取更新状态…","buttons":["check"]} | **pass** |
| 21-assert | k1-14-entry-idle | 单包入口初始态为 badge + idle（aria-label 给「已是最新 0.0.1」，badge 无可见正文） | variant=badge、state=idle、aria-label=「已是最新 0.0.1」 | {"present":true,"variant":"badge","state":"idle","text":"","note":"","ariaLabel":"已是最新 0.0.1","title":"检查更新"} | **pass** |
| 23-assert | k1-21-update-banner | 可更新横幅原文与动作 | 标题精确等于「有新版本 0.0.2 可安装（当前版本 0.0.1）。」且含 install | {"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"}；actions=["check","install","skip","copy-manual","copy-diag","toggle-changelog"] | **pass** |
| 24-assert | k1-22-entry-update | 入口切到 update 档 | state=update 且 aria-label 含「有新版本 0.0.2」 | {"present":true,"variant":"badge","state":"update","text":"","note":"","ariaLabel":"有新版本 0.0.2","title":"有新版本 0.0.2"} | **pass** |
| 25-assert | k1-23-install-button-update | 安装按钮切到 update 档并给安装动作 | kind=update 且 buttons 含 action=install | {"kind":"update","buttons":["install","copy-manual"]} | **pass** |
| 27-assert | k1-26-changelog-heading | changelog 区间标题 | 「更新说明（0.0.1 → 0.0.2）：」 | 更新说明（0.0.1 → 0.0.2）： | **pass** |
| 28-assert | k1-27-yanked | yanked 版本标记：版本标题后缀 + 文档级横幅 | 版本节 0.0.2 标题含「已撤回」、yanked 横幅含「已被作者撤回（yanked）」 | {"versionTitle":"0.0.2 · 2026-11-03 · 已撤回\n\n新增（Added）\n\n**不兼容 BREAKING:** 旧的 updateCheck 电话返回结构改为新形状（面板按新字段渲染）。\n集成方面板新增 安装按钮 与 更新日志 折叠区，旧徽标 保留 已移除。\n产品主页 dsh-plugin-update 与裸链接 https://example.com/changelog 都可点。\n\n\n\n修复（Fixed）\n\n修复 check-expired 在宿主重载窗口内被误判为失败的问题。\n\n\n\n变更（Changed）\n\n批量行状态文案统一为「等待/安装中/已完成/失败」四态。\n\n\n\n安全（Security）\n\n安装命令不再拼接未转义的包名（防注入）。\n\n\n\n弃用预告（Deprecated）（1）\n\n旧的 updateEntry 徽标入口将在下个版本移除。\n\n\n移除（Removed）（1）\n\n移除未使用的 updateLegacyProbe 内部出口。","yanked":"目标版本 0.0.2 已被作者撤回（yanked），安装不受影响，继续前请确认。"} | **pass** |
| 29-assert | k1-28-truncnote | 版本节上限（100 条）触发的截断提示 | 截断提示含「仅显示前 100 条」 | 共 107 条，仅显示前 100 条 | **pass** |
| 30-assert | k1-29-cats | 六类小节（含折叠类）都在 DOM | 类别小节数 >= 6 | 6；cats=["Added","Fixed","Changed","Security"]；fold=["Deprecated","Removed"] | **pass** |
| 31-assert | k1-30-md-code | 行内 code 渲染 | md-code 含「updateCheck」 | ["updateCheck","check-expired","updateEntry","updateLegacyProbe"] | **pass** |
| 32-assert | k1-31-md-strong-em-del | 行内 strong/em/del 渲染 | strong 含「安装按钮」、em 含「更新日志」、del 含「保留」 | {"strong":["BREAKING:","安装按钮"],"em":["更新日志"],"del":["保留"]} | **pass** |
| 33-assert | k1-32-links | markdown 链接与裸 URL 都可点（http/https） | md-link 同时含 example.com/dsh-plugin-update 与 example.com/changelog | [{"text":"dsh-plugin-update","href":"https://example.com/dsh-plugin-update"},{"text":"https://example.com/changelog","href":"https://example.com/changelog"}] | **pass** |
| 34-assert | k1-33-no-html | changelog 不直通 HTML（无 script 注入） | changelog 内无 script 标签 | false | **pass** |
| 35-assert | k1-34-breaking | BREAKING 徽标 | breaking 徽标 >= 1 | ["不兼容"] | **pass** |
| 37-assert | k1-35-busy-banner | 安装中横幅原文 | 标题精确等于「正在安装 0.0.2…关闭面板不会中断。」 | {"kind":"busy","title":"正在安装 0.0.2…关闭面板不会中断。","sub":"进度将自动轮询刷新；重新打开面板将在 1 秒内恢复显示。"} | **pass** |
| 38-assert | k1-36-busy-entry | 入口切 busy 档 | state=busy、aria-label「正在安装…」 | {"present":true,"variant":"badge","state":"busy","text":"","note":"","ariaLabel":"正在安装…","title":"正在安装…"} | **pass** |
| 39-assert | k1-37-busy-install-button | 安装按钮切 busy 档 | kind=busy | busy | **pass** |
| 41-assert | k1-41-settled-banner | 安装落定后面板原文 | 标题精确等于「已是最新，无需更新。」 | {"kind":"done","title":"已是最新，无需更新。","sub":""} | **pass** |
| 42-assert | k1-42-settled-entry | 安装落定后入口读数（已是最新 0.0.2 或待重启） | state=idle 且 aria「已是最新 0.0.2」，或 state=restart 且 aria「待重启」 | {"present":true,"variant":"badge","state":"idle","text":"","note":"","ariaLabel":"已是最新 0.0.2","title":"检查更新"} | **pass** |
| 45-assert | k1-43-install-request-once | 单包安装只发起一次安装请求（UI 真实点击安装按钮触发） | A 的 update.install.request 恰 1 条、无 update.install.fail | requests=1 fails=0；request={"from":"entry","current":"0.0.1","latest":"0.0.2","checkAgeMs":782,"intentHash":"a99ca3c6","traceId":"0f89b7dffa8228e7","spanId":"729ce7eb","seq":1} | **pass** |
| 46-assert | k1-44-ledger-snapshot | 受保护安装：安装前快照 before.json 记录旧版 0.0.1 且 jobId 与台账一致 | before.previousVersion=0.0.1、before.jobId===state.id | {"previousVersion":"0.0.1","jobId":"3d071016-6b54-4746-acee-4ae850d023a6","files":["package.json","pnpm-lock.yaml","pnpm-workspace.yaml"]}；state.id=3d071016-6b54-4746-acee-4ae850d023a6 | **pass** |
| 47-assert | k1-45-ledger-settled | 台账逐行真相：目标 0.0.2、状态为落定档（completed 或 restart-required） | state∈{completed,restart-required}、targetVersion=0.0.2、previousVersion=0.0.1 | {"state":"completed","targetVersion":"0.0.2","previousVersion":"0.0.1"} | **pass** |
| 48-assert | k1-46-disk-after-install | 磁盘装到 0.0.2 | A 磁盘版本=0.0.2 | {"dsh-plugin-update-fixture-a":"0.0.2"} | **pass** |
| 51-assert | k1-51-done-banner | 重启后面板已了结原文 | 标题精确等于「已是最新，无需更新。」 | {"kind":"done","title":"已是最新，无需更新。","sub":""} | **pass** |
| 52-assert | k1-52-build-tags | 重启后运行的是 0.0.2 构建 | clientTag=client v0.0.2、hostTag=host v0.0.2 | {"clientTag":"client v0.0.2","hostTag":"host v0.0.2"} | **pass** |
| 53-assert | k1-53-install-button-done | 安装按钮回到 done 档 | kind=done | done | **pass** |
| 54-assert | k1-54-entry-done | 入口已是最新（aria-label） | state=idle、aria-label 含「已是最新 0.0.2」 | {"present":true,"variant":"badge","state":"idle","text":"","note":"","ariaLabel":"已是最新 0.0.2","title":"检查更新"} | **pass** |
| 55-assert | k1-55-ledger-completed | 重启后台账收敛为已完成 | state=completed | {"state":"completed","targetVersion":"0.0.2"} | **pass** |
| 57-assert | k1-61-first-install-banner | 首次安装横幅原文 | 标题精确等于「首次安装 0.0.2（新增依赖）。」 | {"kind":"update","title":"首次安装 0.0.2（新增依赖）。","sub":"装完需要重启宿主才会加载。"} | **pass** |
| 58-assert | k1-62-changelog-neutral | 无 changelog 时的中性提示（非取数失败） | changelog 区含「作者未提供更新说明」或「没有更新说明文件」 | 该版本包里没有更新说明文件，不是取数失败。  | **pass** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 17-shot | k1-10-initial | A 单包面板初始（未查更新）+ 额外面板绑未安装的 C + 安装按钮 + 入口 | A 横幅「已是最新，无需更新。」；C 横幅「未安装」+「检查更新」；安装按钮 loading 档（挂载未查、含检查动作）；入口 badge + aria「已是最新 0.0.1」 | A={"kind":"done","title":"已是最新，无需更新。","sub":""}；C={"kind":"idle","title":"未安装","sub":"检查更新"}；按钮 kind=loading；入口={"variant":"badge","state":"idle","ariaLabel":"已是最新 0.0.1"} | **pass** | [shots\17-shot.png](shots\17-shot.png) |
| 22-shot | k1-20-update | 点「检查更新」后：可更新横幅 + 安装动作 + 版本条 + 入口 | 横幅「有新版本 0.0.2 可安装（当前版本 0.0.1）。」、有 install 动作、入口 update 档 | {"kind":"update","title":"有新版本 0.0.2 可安装（当前版本 0.0.1）。","sub":"选择安装将按精确版本安装；同一使用范围同时仅安装一项。"}；strip=["0.0.1","0.0.1","0.0.2"]；actions=["check","install","skip","copy-manual","copy-diag","toggle-changelog"]；入口={"state":"update","ariaLabel":"有新版本 0.0.2"} | **pass** | [shots\22-shot.png](shots\22-shot.png) |
| 26-shot | k1-25-changelog | changelog：行内 markdown、裸 URL、BREAKING、yanked、六类与版本节上限截断提示 | 版本节含 0.0.2（标题带「已撤回」）、yanked 横幅、md-code/strong/em/del/link、breaking 徽标、截断提示「仅显示前 100 条」 | {"heading":"更新说明（0.0.1 → 0.0.2）：","yanked":"目标版本 0.0.2 已被作者撤回（yanked），安装不受影响，继续前请确认。","truncnote":"共 107 条，仅显示前 100 条","cats":["Added","Fixed","Changed","Security"],"foldCats":["Deprecated","Removed"]} | **pass** | [shots\26-shot.png](shots\26-shot.png) |
| 36-shot | k1-30-installing | 安装进行中：忙碌横幅 + 禁用动作 + 入口/安装按钮 busy 档 | 横幅「正在安装 0.0.2…关闭面板不会中断。」、安装动作禁用、入口「正在安装…」 | {"kind":"busy","title":"正在安装 0.0.2…关闭面板不会中断。","sub":"进度将自动轮询刷新；重新打开面板将在 1 秒内恢复显示。"}；actions=[{"action":"check","disabled":true},{"action":"install","disabled":true},{"action":"copy-diag","disabled":false},{"action":"toggle-changelog","disabled":false},{"action":"toggle-queue","disabled":false}]；入口={"state":"busy","ariaLabel":"正在安装…"} | **pass** | [shots\36-shot.png](shots\36-shot.png) |
| 40-shot | k1-40-settled | 安装完成落定：面板已了结 + 入口已是最新 0.0.2（换包后宿主半重载，运行版本=磁盘版本） | 横幅「已是最新，无需更新。」、入口 idle 且 note 含「已是最新 0.0.2」 | {"kind":"done","title":"已是最新，无需更新。","sub":""}；入口={"state":"idle","ariaLabel":"已是最新 0.0.2"} | **pass** | [shots\40-shot.png](shots\40-shot.png) |
| 50-shot | k1-50-after-restart | 重启后：面板已了结、卡片构建标记 v0.0.2、安装按钮 done、额外面板 C 仍未安装 | 横幅「已是最新，无需更新。」、clientTag/hostTag 均为 0.0.2、按钮 kind=done、C 横幅「未安装」 | {"kind":"done","title":"已是最新，无需更新。","sub":""}；tags={"clientTag":"client v0.0.2","hostTag":"host v0.0.2"}；按钮 kind=done；C={"kind":"idle","title":"未安装","sub":"检查更新"} | **pass** | [shots\50-shot.png](shots\50-shot.png) |
| 56-shot | k1-60-first-install | 未安装插件的首次安装态 + 无 changelog 的中性提示 | 横幅「首次安装 0.0.2（新增依赖）。」、changelog 区给出作者未提供/文件缺失的中性提示 | {"kind":"update","title":"首次安装 0.0.2（新增依赖）。","sub":"装完需要重启宿主才会加载。"}；changelog={"neutral":"该版本包里没有更新说明文件，不是取数失败。","text":""} | **pass** | [shots\56-shot.png](shots\56-shot.png) |

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
- [host-launch-k1-gen1](raw\16-host-launch-k1-gen1.json)
- [host-stop-0](raw\43-host-stop-0.json)
- [k1-gen1-logs](raw\44-k1-gen1-logs.json)
- [host-launch-k1-gen2](raw\49-host-launch-k1-gen2.json)
- [host-stop-1](raw\59-host-stop-1.json)
- [log-fxa-a-2026-11-03](raw\60-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\61-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\62-log-fxa-c-2026-11-03.json)
- [cleanup-log-files](raw\63-cleanup-log-files.json)
- [tls-front-stop](raw\64-tls-front-stop.json)

## 清理

- 进程 k1-gen1-host（pid 90548）：停止后存活=false
- 进程 k1-gen2-host（pid 27252）：停止后存活=false
- 端口 tls-registry-front（56345）：已释放=false
- 端口 k1-gen1-host-port（52437）：已释放=false
- 端口 k1-gen2-host-port（64638）：已释放=false
- 端口 registry（63860）：已释放=true
- 本地 registry：http://127.0.0.1:63860（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 k1-gen1 已起：port=52437，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:56345）
- 宿主 k1-gen2 已起：port=64638，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:56345）

## 备注

- 本地 registry：http://127.0.0.1:63860（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 k1-gen1 已起：port=52437，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:56345）
- 宿主 k1-gen2 已起：port=64638，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:56345）

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
