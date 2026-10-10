<!-- DSH-IDEMPOTENCY-KEY: archive-seal-en-overflow-position-20261010 -->
## 实际（现象；影响范围）

报告人截图：**英文渲染** + **更新档案·卷（archive）主题** + 载体 desktop，横幅为 update 档（卡片内容 `Update available: 0.4.11 (current: 0.4.10)`，即 dsh-prompt 的更新卡片）。两处不符：

1. **印章位置不符原型**：小印章（方框 + `Install`）渲染在标题**上方独占一行**、水平居中（并带约 10px 右偏），而原型里它是与状态文字**同一行、居左**的。
2. **英文文案越出印章框**：印章是写死 30×30 的方框（为「一字」设计），英文文案是一个词（`Install`），文字从方框**左右两侧**越出框线——截图里可清楚看到方框的两条竖线穿过 `Install` 这个词。

**影响范围**：

- 溢出这一条：archive 主题下凡带小印章的档位，英文渲染**全部命中**。英文 mini 文案 8 档里 6 档是词（`Check` / `Install` / `Install` / `Restart` / `Blocked` / `Failed` / `Done`），中文对应的是「查 / 装 / 装 / 启 / 阻 / 阻 / 定」单字——单字塞得进 30×30，词塞不进。
- 位置这一条：**中英都命中**（报告人前一张中文截图上「阻」同样独占一行在标题上方），不是英文独有；英文只是让印章框里多了一条溢出。
- 批量面板的详情复用同一内核与同一套主题 CSS，若成因在布局层，波及面不止单面板。

> 口径说明（本轮判断，未与报告人确认）：从截图几何看，越出的是**印章框**（词穿过方框竖线），横幅区块本身的文字未越出边框。若报告人说的「超出章的范围」指横幅区块，请按下方「附带观察」对照——两个读法都已写在票里。

## 期望（预期；与实际差异）

- **期望 1（位置）**：按原型 `prototype/redesign/d5-paper.html:215`，小印章与状态文字**同一行、居左**（`.sealmini` 是 `display:inline-block`，紧跟文字）；不应顶到标题上方。
- **期望 2（框内可读）**：英文 mini 要么放进框里（缩字号 / 加宽框 / 允许框内两行），要么换一个适合方框的短词；无论哪种，都不该让文字越出框线。
- 与实际差异：位置由「同行居左」变成「上方居中（右偏 10px）」；英文词宽 > 30px 时无任何约束，直接越框。

## 复现步骤（前置条件和场景 + 编号步骤；偶发写频率）

1. 宿主语言切到英文（截图即英文界面）。
2. 面板主题设为「更新档案·卷」（archive）；载体 desktop（scope 牌显示 `desktop [profile]`）。
3. 打开任一插件处于「有新版」档的更新卡片（截图：dsh-prompt，当前 0.4.10、远端 0.4.11）。
4. 看横幅顶部：印章在标题上方独占一行；印章方框内的英文词左右越出框线。

必现还是偶发：报告为必现（截图即此形态）。中文下位置同样独占一行（有中文截图对照）；英文下多出溢出这一条。

## 环境信息（OS 版本 + 软件版本 + 运行环境）

- OS：Windows（用户目录 `C:\Users\辰辰洋洋`）。
- 载体 / 使用范围：desktop（profile 牌）；面板主题：**更新档案·卷（archive）**；宿主语言：**英文**（截图为英文界面）。
- 截图卡片的目标包：`dsh-prompt`，当前 `0.4.10` → 远端 `0.4.11`（本机 `profiles/desktop` 现装 `dsh-prompt = 0.4.11`，见取证记录）。
- 更新器：`dsh-plugin-update@0.10.0`（`…\profiles\desktop\node_modules\dsh-plugin-update`）。
- 报告人未给：DSH 版本、宿主种类（第三方 Desktop / 官方桌面版 / 普通 DSH）、界面宽度与缩放。

## 历史核查结论

- 关键词：`溢出`、`超出`、`双语`、`英文`、`印章`、`副行`、`横幅`、`档案卷`、`换行`、`裁断`、`宽度`；按当前后端（GitHub）搜已打开与已关闭（97 张全量标题初筛 + 关键词命中正文）。
- 结论：**新增，不复用、不回归**。没有任何票提到「小印章位置」或「英文 mini 文案越出印章框」。
- 疑似点开正文后判定：
  - **#93**《更新档案·卷主题安装横幅的副行提示溢出被裁断，只显示「进度按轮询自」》（已关闭，`bug,ready-for-agent`，已修 `736c77b`）：**同一横幅、同族不同症状**。它修的是「弹窗 + archive + 内容高过 85vh 时副行折成第二列被裁」，修法为删掉 archive 横幅的 `display:flex`/`flex-wrap:wrap` + 加内核帧契约。本单是**印章**的位置与框宽，判定不重复；但同属「archive 横幅的 flex 布局」家族，诊断先核 #93 那次改动是否留下了本形态（它删了皮肤层的 `display:flex`，而内核的 `flex-direction:column` 仍在 → 印章仍是独占一行的 flex 项）。
  - #20《专业版：D5 档案卷主题进包》（已关闭）：本单引用的原型基准 `prototype/redesign/d5-paper.html` 出自它，非同题。
  - #67《跟随语言验收矩阵：中英×三载体×双主题×四态》/ #89《视觉语言矩阵与门禁：双载体双主题双语一次看全》（均已关闭）：本单正是矩阵该覆盖的一格（archive × 英文 × 横幅印章），可作为「残留」输入；但它们是验收/门禁票，不复用。
  - #72《default 主题弹窗 01~05 区域出现可横向滑动的列表，溢出未换行》（已关闭）：同「溢出」家族、不同元素（章节区与队列行），非同题。
- 关联：#93、#89（默认关联不关闭）。

## 线索（本轮只读取证，未做真机量盒子；诊断≠修复）

**设计基准（原型）**

- `prototype/redesign/d5-paper.html:90`：
  ```css
  .sealmini{ display:inline-block; width:30px; height:30px; line-height:26px; text-align:center; … }
  ```
- 同文件 `:215` 用法——印章与文字在**同一行**，印章居左：
  ```html
  <p class="status-line"><span class="sealmini seal-ink" id="sealMini">查</span><span id="oneLiner" class="foldwrap">当前版本 1.2.2，尚未检查更新。</span></p>
  ```

**实际实现（内核 + 皮肤）**

- DOM：印章不是节点，是横幅的 `::before` 伪元素——`src/panel.ts:1447` 渲染 `<div class="dsh-upd-banner" data-kind="…" data-mini="…">`，随后两个兄弟 div（标题 / 副行）。
- 皮肤（archive）给 `::before` 的样式，`src/panel.ts:1220-1222`：
  ```
  content:attr(data-mini); display:inline-flex; align-items:center; justify-content:center;
  width:30px; height:30px; margin-right:10px; vertical-align:middle; border:2px solid currentColor; border-radius:7px;
  font-family:serif; font-weight:700; font-size:16px; line-height:26px; transform:rotate(-5deg); flex:none; color:…
  ```
  这里 `display:inline-flex` + `vertical-align:middle` + `margin-right:10px` 三个声明都是**「同行、居左、文字在其右」**的写法，与原型一致。
- 但内核（无主题作用域）把横幅做成了**纵向 flex**，`src/panel.ts:1129`：
  ```
  .dsh-upd-banner{min-height:3.4em;display:flex;flex-direction:column;justify-content:center}
  ```
  → `::before` 变成**独占一行的 flex 项**（排在标题 div 之前），`vertical-align` 在 flex 项上无效、`margin-right:10px` 只造成 10px 右偏 → 位置从「同行居左」变成「上方居中且右偏」。
- 框宽：`width:30px;height:30px` 写死 + `flex:none`（不随内容伸缩），且**没有** `overflow` / `white-space` / `text-overflow` 任何约束 → 内容宽于 30px 时只能越出。
- 文案长度：`src/bilingual.ts:401-415` 英文 mini 全是词，中文全是单字——
  | key | EN | ZH |
  | --- | --- | --- |
  | `panel.seal.loading.mini` / `idle.mini` | `Check` | 查 |
  | `panel.seal.update.mini` / `busy.mini` | `Install` | 装 |
  | `panel.seal.restart.mini` | `Restart` | 启 |
  | `panel.seal.blocked.mini` / `failed.mini` | `Blocked` / `Failed` | 阻 |
  | `panel.seal.done.mini` | `Done` | 定 |
- 待诊断确认：①能否把印章从伪元素改为真节点（或改为横幅首子节点的行内标记）以恢复「同行居左」；②英文 mini 的取词/取框策略（缩字号、加宽框、允许框内两行、或换短词）；③中文下同样存在的「独占一行」是否一并按原型修（本单倾向一并，与 #93「同源同修」的口径一致）。

**附带观察（未定案，供对照）**

- 同横幅的英文文案明显长于中文：`panel.banner.update-title` = `Update available: {latest} (current: {running}).`、`panel.banner.update-action` = `Install runs the exact version; only one install runs per scope at a time.`（中文为「有新版 {latest} 可装（当前 {running}）。」/「点安装即走精确版本安装；同一使用范围同时只装一个。」）。若报告人所指是**横幅区块**的越界，请按本条另立或并入本单；本轮从截图几何读作**印章框**越界。

## 待补信息（本次未取证 / 只能报告人提供）

1. **设计基准确认**：位置期望是取 `prototype/redesign/d5-paper.html:215`（印章与状态文字同行居左）这一版，还是另有更新的设计口径？
2. **「章位置」所指**：是印章相对**标题行**的位置（本单按此理解），还是相对**横幅/卡片**的位置（例如右上角那一枚大印章 `src/panel.ts:1187` 的 `top:20px;right:24px`）？
3. DSH 版本、宿主种类、界面宽度与缩放（截图未含）。
4. 中英并列对照截图（中文那张「阻」可作对照，若手头还有更贴近同一档位的更好）。

## 备注（工具与标签）

- 建票通道：本轮先试 deck 工具，若仍为 `gate-defer` / `backend-threw` 则走 `gh` 直连兜底（与 #92、#98 同因：本机代理 `127.0.0.1:7890` 间歇不可用）。
- 标签：`bug` + `needs-triage`（本轮只做只读取证，未做真机量盒子复现，也未定分流）。

## 进度

- 2026-10-10：建票（`bug` + `needs-triage`）。本轮只做只读取证（原型基准、CSS 归属、文案表），未改任何业务代码。
<!-- 做到哪一步了，在这里一行一行记 -->
