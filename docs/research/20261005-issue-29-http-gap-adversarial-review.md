# HTTP 缺口是否真实、纯加法是否成立：对抗式审查（#29）

> 日期：2026-10-05（Asia/Shanghai）｜触发：本票 #29 隶属父图 #28，为 #32（实现 HTTP helper）的前置阻塞。结论先行，证据在后；反方先立，再逐条反驳或接受。
> 方法：只认一手来源（本仓源码、规格注释、官方文档、第一方 API 形状）；拿不准写“未证实”，不行号编造。

## 结论摘要

- **Q1 缺口真实**：第三方插件在浏览器面板经 HTTP POST 环境下无法复用现有三件套直调链路，每家须自写约 10 行 phone→fetch 翻译层（dsh-prompt 的 bridge.ts 即唯一现形态证据），本包无任何 HTTP 传输 helper（src 全文、package.json 7 子路径、derive 工具三处互证）。
- **Q2 纯加法成立**：拟议落点 `dsh-plugin-update/http`（createHttpCall＋mount 薄封装，类型随包）只需新子路径＋新文件＋新导出＋README/CHANGELOG，不碰 src/config.ts 头注冻结项（电话名/入参回参/落盘/配方/事件基线/默认路径）中任何一条，有 maintainers “新开子路径”纪律背书。
- **Q3 无更小替代**：直复用 host.call、只用 derive、文本拼接、只加 mount 薄封装、只支持 baseUrl 五条替代逐一证伪或收敛——在“无 host.call 直调、只有 HTTP POST”约束下都不成立，唯有把 phone→path＋回包透传收进包内一处才是最小闭合。

---

## Q1 缺口是否真实

### 1.1 反方立论（缺口是假的）

反方主张三点：(a) 本包已给“整组件＋入口件＋派生”全套，第三方几行即跑，不存在缺口；(b) 面板经 `host.call` 直调是通用假设，HTTP 只是宿主实现细节，不该由本包管；(c) dsh-prompt 自写的 bridge 是个案设计选择，不能证明系统性缺口。

### 1.2 反驳证据链（逐件核对）

**（1）src/client.ts：只有名字＋轮询，无传输。** 文件头注自述“只装调用电话所需的最小形状（电话名拼法、轮询时间口径、手工兜底命令形状）”（src/client.ts:1-5），两种消费方式都是“取值”而非“传输”（src/client.ts:7-17）。实质导出只有三样：`CLIENT_POLL` 默认 1000/下限 250（src/client.ts:78-81）、`buildClientPhoneNames` 转调 `buildPhoneNames`（src/client.ts:84-86）、`assertPollInterval` 下限 250ms 越界抛错（src/client.ts:88-94）。其余转出口（queue/batch/changelog 纯函数，src/client.ts:27-76）均为“无 Node 专属能力、可进浏览器闭包”的**数据形状**，无任何 fetch/baseUrl/POST。`derive-client-values.mjs` 全文 174 行无传输实现，生成物固定五常量 `UPD_STATUS/UPD_CHECK/UPD_INSTALL/UPD_POLL/UPD_POLL_MIN`（derive-client-values.mjs:21-27，组装见 derive-client-values.mjs:150-160）——派生的是**常量**，不是**调用能力**。

**（2）src/panel.ts：签名假设面板能直调 host.call。** 传输类型钉死为 `UpdatePanelCall = (phoneName, args) => Promise<reply>`，“面板只认这个签名，不认任何宿主对象的具体形状”（src/panel.ts:39-43）；`UpdatePanelOptions.call` 是“面板侧唯一的宿主接触面”（src/panel.ts:60-96，call 见 src/panel.ts:74）。`mountUpdatePanel` 强制要求 `options.call` 为函数，否则抛错（src/panel.ts:1413，校验见 src/panel.ts:1424-1426），电话名“从前缀算出，不写字面量”（src/panel.ts:1427-1428）。四处真实调用点全是 `call(phoneNames.updateXxx, …)` 直调：状态查（src/panel.ts:1528）、查新版（src/panel.ts:1546）、安装前补查（src/panel.ts:1561）、安装提交（src/panel.ts:1574-1578）。**反方 (b) 在此被精确反驳**：HTTP 不是“宿主实现细节”，而是面板与宿主之间**调用方必须自备**的一整层；包内四处调用点没有任何分支处理“无直调函数”情形，抛错即停。

**（3）src/entry.ts：只做查＋开面板，传输同样外包。** 头注铁律“入口件永远只做查＋打开面板”“源码里不出现安装电话”（src/entry.ts:9-12）；`UpdateEntryOptions.call` 同为“调宿主电话：(phoneName, args) => Promise<reply>”（src/entry.ts:58-76，call 见 src/entry.ts:63）。`mountUpdateEntry` 同样强制要求 call 为函数（src/entry.ts:196，校验见 src/entry.ts:207-209），电话名只从前缀派生（src/entry.ts:211-213）。行为上只调 `updateStatus` 只读（src/entry.ts:321-332，调用见 src/entry.ts:324）与 `updateCheck` 联网只读（src/entry.ts:335-344，调用见 src/entry.ts:337），面板复用经 `panelCall` 转发同一 call（src/entry.ts:347-359）。结论：入口件与整组件**同构缺口**——两者都把传输留给调用方。

**（4）src/host.ts：宿主侧只给电话表，注册由调用方完成。** 包根自述“三件事：建更新能力、拼电话名、给调用方回电话名与处理器（注册由调用方完成）”（src/host.ts:10-11）。`HostUpdate` 形状仅 `{ phoneNames, handlers }`（src/host.ts:738-741），`createHostUpdate` 一次调用得该插件的一组电话名与处理器（src/host.ts:747），三处理器经 `loggedPhone` 包装后按键注册（src/host.ts:848-861）。宿主侧**止于内存函数表**，没有任何 HTTP 路由、端口、路径概念——这是设计使然（通道无感，见下游 host/index.ts:4-8 引述），但也意味着浏览器→Node 之间那段路包内无件。

**（5）src/config.ts＋package.json：冻结项与出口清单互证“无 http”。** 冻结语“默认电话名、入参回参形状、配置写法、配方形状、事件字段基线、默认旧路径，动其中任何一条即走破冰”（src/config.ts:8-9）；冻结字面：默认前缀 `wf`（src/config.ts:12）、三动作名（src/config.ts:14）、目标包/官方源/旧标识（src/config.ts:18-25）、三落盘文件名＋跳过文件（src/config.ts:27-31）、时间口径及 250ms 下限（src/config.ts:36-44）、拼法函数（src/config.ts:149-162）。`package.json` 出口恰为 7 个子路径 `.`/`./panel`/`./client`/`./batch`/`./panel-batch`/`./entry`/`./package.json`（package.json:16-42），**无 `./http`**；`files` 白名单 6 项亦无 http 产物（package.json:43-50，转述见 docs/maintainers.md:59）。src 全文 grep `fetch|baseUrl|createHttpCall|mountUpdatePanelHttp`：命中仅 registry 取数（src/reader.ts:247-257、src/service.ts:256、src/changelog-io.ts:260-314）、diag 字段名（src/diag.ts:62-84、src/panel.ts:346-462 宽容读）与 SVG data-url（src/panel.ts:1007/1046），**面板/入口传输用 fetch 零命中**——反方 (a)“全套已给”不成立：给的是直调全套，不是 HTTP 全套。

**（6）README：三步接入处处以 host.call 直调为前提。** 宿主接线示例止于“把处理器按键注册进自己的电话表”（README.md:36-53，注册见 README.md:49-52）；电话契约表只定义入参回包（README.md:72-85）；面板派生示例三行全是 `host.call(UPD_STATUS, {})` 直调（README.md:87-103，调用见 README.md:99-102）；整组件示例 `call: (name, args) => host.call(name, args)`（README.md:114-130，见 README.md:122-128）；入口件示例同构（README.md:147-159，见 README.md:152-159）。**批量章节（README.md:179-248）handoff 已判 out of scope**，此处仅确认：批量同样经 `call` 直调（README.md:212-222），不提供 HTTP 形态。全书 483 行无一节讲“浏览器经 HTTP POST 调电话”，亦无 baseUrl/routes 参数——文档缺口与代码缺口同形。

**（7）下游唯一现形态证据：dsh-prompt 自写翻译层。** handoff“请你做什么”5 条（D:/temp/dsh-prompt-125-handoff-upstream.md:8-16）第 2 条指明 helper 内部干“经 prefix 算出三条路做 fetch，并拆成 { snapshot, manual, receipt, error }”；“为什么”一节直言“每家都要自写约 10 行 phoneName → fetch(path) 转接”（D:/temp/dsh-prompt-125-handoff-upstream.md:20-23）。现形态即 `D:/dsh-plugin/dsh-prompt/src/update/bridge.ts` 130 行（指针见 D:/temp/dsh-prompt-125-handoff-upstream.md:39）：三条路由路径常量（bridge.ts:20-24）、POST＋JSON 请求体＋按路由分流（bridge.ts:98-101，直言“宿主半按路由分流，不按请求体分流”）、`createUpdateBridge` 内 `fetch(pathOf(route), { method: 'POST', … body: JSON.stringify(args) })`（bridge.ts:102-118）与电话名→路由表（bridge.ts:119-123）。宿主装配侧 `createHostUpdate` 仅传 pluginId/prefix/targetPackageName、“其余全走包默认值”（D:/dsh-plugin/dsh-prompt/src/update/host/index.ts:130-138），路由→电话分流表（host/index.ts:151-155）与 `runRoute`（host/index.ts:179-195）——**反方 (c) 被反驳**：bridge 不是“个案选择”，而是在上游无件约束下的**被迫唯一形态**（头注自述“这个文件就是那张表在本插件里的唯一形态”，bridge.ts:1-15；电话名“只从派生文件读”，bridge.ts:10-12）。

**Q1 小结**：反方三点皆被一手来源反驳。缺口真实且可量化：约 10 行/家（handoff 结论，以 bridge.ts:102-123 实测约 20 行实现为准，上游 helper 应收敛至 3 行接入）。

---

## Q2 HTTP helper 是否为纯加法且不碰冻结项

### 2.1 反方立论（加法会碰冻结）

反方主张：(a) 新增 phone→path 映射必然引入“第二套电话名”，触冻结“默认电话名”；(b) 回包拆包/透传必然改入参回参形状；(c) 新增子路径改 `files`/exports 即改发布基线；(d) poll/失败语义复述必然漂移。

### 2.2 冻结项对照表（逐条过）

冻结清单以三处为准：src/config.ts 头注“规格 #591 第 9-14 条”（src/config.ts:8-9）、docs/maintainers.md 改动纪律（docs/maintainers.md:90-94）、兼容承诺（README.md:479-483）。对照如下：

| # | 冻结项（一手来源） | 拟议 helper 的做法 | 是否触碰 |
|---|---|---|---|
| 1 | 默认电话名：前缀 `wf`＋三动作名，默认下与现状一字不差（src/config.ts:12-15；拼法见 src/config.ts:149-162） | helper 内部仍调 `buildPhoneNames(prefix)` 派生电话名，“不要写死”（handoff 第 3 条，D:/temp/dsh-prompt-125-handoff-upstream.md:12）；映射的是 phone→path，电话名本身不增不改 | 不碰 |
| 2 | 三电话入参回参形状（README.md:72-85；host 实现见 src/host.ts:757-847） | helper 是**调用方侧适配器**：入参原样转 JSON body（下游现行即 `body: JSON.stringify(args ?? {})`，bridge.ts:108-112），回包按既有契约字段拆分＋透传，不改宿主侧 handlers 形状 | 不碰 |
| 3 | 配置写法：只经函数入参注入（src/config.ts:8-9；纪律见 docs/maintainers.md:92） | helper 配置同样只经函数入参（`{ baseUrl \| routes }`＋既有 pluginId/prefix/pollMs），不读配置文件 | 不碰 |
| 4 | 配方五键形状（纪律见 docs/maintainers.md:92；手册见 README.md:356-367） | helper 不碰配方生成（`manualCommand` 仍由宿主侧经快照回，README.md:82），只透传 `manual` 字段 | 不碰 |
| 5 | 事件字段基线：三事件各加必填 `pluginId`（docs/maintainers.md:92；host 实现见 src/host.ts:705-709） | helper 不发新日志事件（对标 client.ts“未新增日志事件”，src/client.ts:19；panel 诊断只读快照，src/panel.ts:1497-1522）。若 helper 加调试日志，须走既有三事件＋白名单，否则另议——此为 #32 实现约束，非冻结触碰 | 不碰（附约束） |
| 6 | 默认旧路径：`updates`＋旧标识＋短指纹、三文件名（src/config.ts:21-31；手册见 README.md:292-295） | helper 无落盘（纯内存传输适配），路径逻辑零引用 | 不碰 |
| 7 | 新增能力纪律：**新开子路径，不改既有入口形状**（docs/maintainers.md:61）；发布白名单 `dist` 下“加模块不必改白名单，但要跑 dry-run 核对”（docs/maintainers.md:59） | 落点 `dsh-plugin-update/http` 即新子路径；老入口 `.`/panel/client/entry` 一字不动；package.json exports 加一项、files 沿用 `dist` 覆盖 | 不碰（反方 c 的“改发布基线”实为**允许的加法操作**，纪律原文即要求如此） |
| 8 | 宿主安装三出口契约（docs/host-install-exits.md:1-4 只读抄件；三出口见 docs/host-install-exits.md:11-68） | helper 不选出口、不调桌面服务/manager/CLI，只把已定好的电话调用搬运过 HTTP；出口选择仍在宿主进程内（src/host.ts:747-756） | 不碰 |
| 9 | 诊断边界：detail 唯一自由文本出口、人话格永为字符串、diagnostic 永不过边界（CONTEXT.md:5-17；ADR 见 docs/adr/0001-diagnostics-redaction-boundary.md:18-30） | helper 只透传 `diag` 对象（handoff 第 2 条要求“失败带 diag 时透传，不要丢键”，D:/temp/dsh-prompt-125-handoff-upstream.md:12），不解析、不改写、不经 `sanitizeDetail` 二次加工；1024 字节墙由电话侧 `enforceBudget` 已保证（host 转出口见 src/host.ts:83-98），helper 不另立预算 | 不碰（附约束：透传须字节透传，禁字段裁剪） |

### 2.3 四个“如何保证”的实现约束（给 #32，非冻结触碰而是验收口径）

1. **phone→path 映射**：以 `buildPhoneNames(prefix)` 三键为唯一键源（src/config.ts:149-157），禁止第二套字面量（对标 panel “取值只从这里算，不写字面量”，src/panel.ts:122-128；下游纪律“不许写死轮询数字/电话名字面量”，bridge.ts:10-12）。`routes` 显式传入时仍须校验三键齐全，缺键抛错而非回退猜测（对标 prefix 校验风格，src/config.ts:95-104）。
2. **回包透传 queue/env/diag 不丢键**：面板侧 `queueArgs` 已固定索取 `{ includeQueue: true, includeEnv: true, … }`（src/panel.ts:1469-1472），`applyStatusReply` 宽容读 `queue/env/diag`（src/panel.ts:1497-1522，diag 见 src/panel.ts:1517-1521）；宿主侧“没要时不带该键，老调用形状不变”（src/host.ts:700-704）。helper 须**原样转发 args→body、原样回传 reply→panel**（含可选键），拆分仅为 panel 既有字段名（snapshot/manual/receipt/error），不得过滤未知键（对标 `readDiagTolerant` 未知键忽略但记 `unknownKeys`，src/panel.ts:380-414——helper 侧应更严：未知键透传，面板侧再宽容读）。
3. **poll 下限 250ms**：三处同口径——常量（src/config.ts:43-44）、client 校验抛错（src/client.ts:88-94）、panel 挂载校验（src/panel.ts:1429-1433）、entry 挂载校验（src/entry.ts:231-234）。helper（mount 薄封装）须复用同一常量＋同一抛错文案，不得自立默认值（默认 1000 见 src/config.ts:41）。
4. **失败透传**：宿主失败形状 `{ ok: false, …payload, diag? }` 且 diag 组装失败时回落无 diag 旧形状（src/host.ts:705-734）；面板 `failureCodeOf` 只认 `errorKind`、`error` 仅回退（src/panel.ts:251-261）；entry 同理（src/entry.ts:310-319）。helper 须区分**传输失败**（fetch 不可用/非 envelope/坏 JSON——下游现行码 `no-fetch/bridge-bad-shape/bridge-bad-json/bridge-unreachable`，bridge.ts:63-77/102-118）与**电话失败**（ok:false 回包），前者合成 panel 可读的失败回包但码段不得与 14 码重名（面板 14 码见 src/panel.ts:191-229），后者字节透传。HTTP 状态非 2xx 时仍须读 body（下游现行 `readEnvelope` 不判 status，bridge.ts:71-77）——此为关键语义，#32 单测须锁死。

**Q2 小结**：反方四点中 (a)(b)(d) 被“映射≠改名、透传≠改形、复用常量≠复述口径”反驳；(c) 被纪律原文“新增能力一律新开子路径”（docs/maintainers.md:61）直接证伪——改 exports/files 正是规定的加法动作。纯加法成立，附三条实现约束（无新日志事件、diag 字节透传、传输失败码不占 14 码）。

---

## Q3 有无更小替代方案（证伪表）

约束前提（双方共认）：“无 host.call 直调环境（浏览器面板经 HTTP POST）”（handoff，D:/temp/dsh-prompt-125-handoff-upstream.md:20-23；桥 POST 现实见 bridge.ts:98-101）。

| # | 替代方案 | 反方主张 | 裁决 | 证据 |
|---|---|---|---|---|
| A | 直接复用 host.call 直调 | “把宿主 handlers 直接给面板，无需新件” | **证伪**：handlers 是 Node 侧内存函数表（src/host.ts:738-747），浏览器闭包拿不到函数引用；面板传输类型即函数（src/panel.ts:39-43），跨进程无载体。下游被迫走 HTTP POST 正是此路不通的实证（bridge.ts:102-118） | src/host.ts:747；src/panel.ts:39-43；bridge.ts:102-118 |
| B | 只用 derive-client-values | “派生常量＋自拼 fetch，三行即跑” | **证伪**：derive 输出止于常量（derive-client-values.mjs:150-160），每家仍须自写 fetch/信封/拆包约 10 行；“几行集成”不成立，且各家信封处理必分叉（下游 `asEnvelope/shape` 即个案实现，bridge.ts:63-96）。helper 正是要把这 10 行收敛一处 | derive-client-values.mjs:21-27；bridge.ts:63-96 |
| C | 文本拼接复用 client 入口 | “client.ts 方式 2：拼声明体进闭包” | **证伪**：该路“至今没有真实消费方用过…要用请先补一次真实验证”（src/client.ts:7-12）；且 client 入口无传输（§1.2(1)），拼进去仍缺 fetch。与其验证一条无传输的路，不如新写有传输的件 | src/client.ts:7-17 |
| D | 只加 mount 薄封装，不加 createHttpCall | “mountUpdatePanelHttp 内联 fetch 即可，少一个导出” | **部分成立、收敛**：mount 封装是必需的用户面（handoff 第 1 条“或等价”，D:/temp/dsh-prompt-125-handoff-upstream.md:10-12），但无独立 `createHttpCall` 则传输不可单测、不可复用于自拼面板（README 三步走法，README.md:87-103）与批量面板（README.md:212-222 同一 `call` 通道）。最小闭合＝传输函数＋两 mount 薄封装；砍掉任一则丢一条现有接入路。handoff 建议技能亦要求“先补单测（phone→path、回包透传、poll 下限）”（D:/temp/dsh-prompt-125-handoff-upstream.md:55-59），无独立函数则无测试缝 | README.md:87-130；handoff:55-59 |
| E | 只支持 baseUrl，不支持 routes | “约约定三条固定子路径，少一个参数” | **证伪**：下游三条路挂在既有桥 `/_dsh/dsh-prompt/update/*` 上（bridge.ts:20-24），宿主装配“路径取客户端半同一处定义”（host/index.ts:6-8）；dsh-prompt 头注明言“不另开 RPC 通道…就挂现有这条桥”（host/index.ts:4-8）。固定约定的 baseUrl 派生路径与既有桥路径未必同形，强行统一即逼下游改桥——违反“宿主不动”（handoff 用户口径 Q4，D:/temp/dsh-prompt-125-handoff-upstream.md:34）。routes 显式传入是**兼容既有桥**的必需，不是功能膨胀 | bridge.ts:20-24；host/index.ts:4-8；handoff:34 |

**Q3 小结**：A/B/C 被源码逐条证伪；E 被下游既有桥现实证伪；D 收敛为“传输＋双 mount 即最小闭合”，再小则丢接入路或丢测试缝。

---

## 残留不确定性（Fog，转 #30 跟踪）

1. **HTTP 线形未证实**：helper 经 POST 发出的 body／宿主 HTTP 桥回写的信封 `{ ok, value?, error? }`（bridge.ts:33-38）与电话回包 `{ ok, snapshot, manual, receipt, queue?, env?, diag? }` 之间的**装配位置**（宿主桥内拆 vs helper 内拆）在一手来源中无落定实现——本仓止于电话表（src/host.ts:738-747），下游 `runRoute` 回电话原形（host/index.ts:179-195），`writeJson` 信封装配在下游 `lib/index.js buildPromptRoute`（本次未读，handoff 指针 D:/temp/dsh-prompt-125-handoff-upstream.md:39 仅到 bridge/host 两文件）。helper 的拆包/透传语义须以该文件为准，#30 应先读后定。——未证实：缺 `lib/index.js` buildPromptRoute/isAllowed 一手行号。
2. **queue/env/diag 过桥存活未证实**：宿主侧“要了才带”（src/host.ts:700-704）与面板侧“宽容读”（src/panel.ts:1497-1522）皆为内存直调语义；经 JSON 桥一跳后未知键是否被下游信封 `value` 原样保留，仅见客户端 `shape` 取 snapshot/manual/receipt 三键（bridge.ts:79-96）——**queue/env/diag 在现行下游桥上疑似已丢**（shape 无此三键）。helper 若承诺透传，须先修桥或另定线形，不得默写“透传成立”。——未证实：缺桥端到端回包实测。
3. **传输失败码命名未定**：下游现行 `no-fetch/bridge-bad-shape/bridge-bad-json/bridge-unreachable`（bridge.ts:63-118）与本包 14 码（src/panel.ts:191-229）无冲突，但 helper 落定新码即新增面板文案分支义务（`failureCopy` 未知码走兜底，src/panel.ts:235-244）。#30 须定：新码进 14 码表（走破冰？ADR 称复制渲染义务记在 #9，docs/adr/0001-diagnostics-redaction-boundary.md:82）还是永久走未来兜底。
4. **ADR 已知缺口继承**：`file:///三斜杠放过`、UNC 反斜杠、`manualCommand registry 原样拼接`（docs/adr/0001-diagnostics-redaction-boundary.md:85-90）与 helper 无关但会被 helper 搬运（manual/diag 透传）。helper 不得扩大缺口（字节透传即不遮掩，符合 ADR“丢弃优于替换”，docs/adr/0001-diagnostics-redaction-boundary.md:32-43），修缺口另票，不在本图。
5. **dsh-prompt 目录可读性声明**：本次下游两文件均可读（bridge.ts 130 行、host/index.ts 221 行已逐行核对），handoff 兜底条款（“若不可读以 handoff＋本仓源码为准”）未触发。

---

## 来源清单（一手）

- 本仓源码：src/client.ts:1-94；src/panel.ts:39-96/251-261/380-485/1413-1433/1469-1472/1497-1589；src/entry.ts:9-12/58-76/196-234/310-359；src/host.ts:1-13/700-747/757-861；src/config.ts:1-162；derive-client-values.mjs:10-27/150-174；package.json:16-50；CHANGELOG.md:5-19（0.3.0 无 http 条目）。
- 本仓文档：README.md:27-159（三步/整组件/入口件）/179-248（批量）/264-295（配置）/479-483（兼容）；docs/maintainers.md:59-94；docs/host-install-exits.md:1-74；CONTEXT.md:1-23；docs/adr/0001-diagnostics-redaction-boundary.md:18-103。
- 下游一手：D:/temp/dsh-prompt-125-handoff-upstream.md:8-59；D:/dsh-plugin/dsh-prompt/src/update/bridge.ts:1-130；D:/dsh-plugin/dsh-prompt/src/update/host/index.ts:4-8/46-49/130-195。
- 未读（已声明为 Fog）：D:/dsh-plugin/dsh-prompt 的 lib/index.js（buildPromptRoute/isAllowed/writeJson 信封装配）。
