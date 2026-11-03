# 真机证据索引 · k-single-panel-happy

- runId：274-20261103T093814-r41
- 票：#274
- 宿主通道：dsh-web
- 开始/结束：2026-11-03T01:49:35.922Z / 2026-11-03T01:50:26.051Z
- 总判定：**fail**（退出码 1）

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
| 06-assert | 基版夹具发布 | 按场景声明把基版夹具发到本地 registry（版本/效果都来自声明，不在场景里写死） | 声明里的每个基版 spec 都在 registry 可见 | dsh-plugin-update-fixture-a@0.0.1 | **pass** |
| 10-assert | 干净 profile 装基版（a） | 隔离 home 的新 profile 里，dsh plugin add 装上 dsh-plugin-update-fixture-a@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致 | dependencies=0.0.1；bundles 含 dsh-plugin-update-fixture-a；node_modules 包版本=0.0.1 | dependencies=0.0.1；bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-plugin-update-fixture-a]；磁盘版本=0.0.1；exit=0 | **pass** |
| 12-assert | SUT 钉住核对 | 夹具装进 profile 后，profile 里的 dsh-plugin-update/dist 聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版） | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc | e8cef960ed4baca33e95515e9e1365eb9658151f7adacbe1129d0de0acc82dcc（文件数 208 / 工作树 208） | **pass** |
| 13-assert | setup-sut | 通道 B profile 里装的 SUT 与工作树构建一致 | installed distDigest === worktree distDigest | true | **pass** |
| 14-assert | setup-base-disk | 基版安装后磁盘版本与声明一致 | {"dsh-plugin-update-fixture-a":"0.0.1"} | dsh-plugin-update-fixture-a=0.0.1 | **pass** |
| 18-assert | can-red-01-before-patch | 注入前基线：横幅原文精确匹配（证明断言在未改动时是绿的） | 标题精确等于「已是最新，无需更新。」 | {"kind":"done","title":"已是最新，无需更新。","sub":""} | **pass** |
| 21-assert | can-red-02-patch-applied | 注入：run 私有 home 已装包 client bundle 的横幅文案被追加 RED（只动磁盘副本） | occurrences>=1、sha256 前后不同 | {"file":"D:\\dsh-plugin\\_wt263\\runtime\\t11-275\\274-20261103T093814-r41\\os-home\\.dsh\\profiles\\t10ui\\node_modules\\dsh-plugin-update-fixture-a\\lib\\client.js","occurrences":2,"escapedNeedle":"\\u5DF2\\u662F\\u6700\\u65B0\\uFF0C\\u65E0\\u9700\\u66F4\\u65B0\\u3002","charsBefore":435034,"charsAfter":435040,"sha256Before":"1a3a42bfe7d95a625765d290745aba39a1c511cf9f8089802526f03cc4545c1b","sha256After":"c7dc017cc9e4b814d95d9b2082586e4e36827c31a498eef049406f1ed38183f1","changed":true} | **pass** |
| 24-assert | can-red-03-banner-exact | 精确原文断言（真红点）：注入后实际渲染带 RED | 标题精确等于「已是最新，无需更新。」 | {"title":"已是最新，无需更新。RED"} | **fail** |

## 截图

| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 17-shot | can-red-10-before-patch | 注入前对照：真 UI 装完 0.0.2 后面板横幅原文 | 横幅标题精确等于「已是最新，无需更新。」 | {"kind":"done","title":"已是最新，无需更新。","sub":""} | **pass** | [shots\17-shot.png](shots\17-shot.png) |
| 23-shot | can-red-50-after-patch | 注入重启后：精确原文断言（可证伪点：若断言只做 includes 或没比对原文，这一格会假绿） | 横幅标题精确等于「已是最新，无需更新。」 | {"title":"已是最新，无需更新。RED","banner":{"kind":"done","title":"已是最新，无需更新。RED","sub":""}} | **fail** | [shots\23-shot.png](shots\23-shot.png) |

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
- [host-launch-can-red-gen1](raw\16-host-launch-can-red-gen1.json)
- [host-stop-0](raw\19-host-stop-0.json)
- [can-red-patch](raw\20-can-red-patch.json)
- [host-launch-can-red-gen2](raw\22-host-launch-can-red-gen2.json)
- [host-stop-1](raw\25-host-stop-1.json)
- [log-fxa-a-2026-11-03](raw\26-log-fxa-a-2026-11-03.json)
- [log-fxa-b-2026-11-03](raw\27-log-fxa-b-2026-11-03.json)
- [log-fxa-c-2026-11-03](raw\28-log-fxa-c-2026-11-03.json)
- [cleanup-log-files](raw\29-cleanup-log-files.json)
- [tls-front-stop](raw\30-tls-front-stop.json)

## 清理

- 进程 can-red-gen1-host（pid 40432）：停止后存活=false
- 进程 can-red-gen2-host（pid 65036）：停止后存活=false
- 端口 tls-registry-front（51693）：已释放=false
- 端口 can-red-gen1-host-port（56912）：已释放=false
- 端口 can-red-gen2-host-port（60212）：已释放=false
- 端口 registry（53302）：已释放=true
- 本地 registry：http://127.0.0.1:53302（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 can-red-gen1 已起：port=56912，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:51693）
- 宿主 can-red-gen2 已起：port=60212，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:51693）

## 维护者 profile 未污染

- 目录：C:/Users/辰辰洋洋/.dsh
- 前后一致：true

## 备注

- 本地 registry：http://127.0.0.1:53302（仓库外 verdaccio，run 内独立 storage）
- npmjs 依赖镜像：dsh-log@0.3.4（cache）；缓存 D:\dsh-plugin\_wt263\runtime\tools\npmjs-mirror
- 宿主 can-red-gen1 已起：port=56912，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:51693）
- 宿主 can-red-gen2 已起：port=60212，UI=DSH_VERIFY_PLAYWRIGHT=D:\dsh-plugin\dsh-mattpocock-skills-deck\node_modules\playwright（registry=https://127.0.0.1:51693）

## 从零复跑

命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。
