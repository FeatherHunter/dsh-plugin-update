// src/panel/archive-theme.ts —— Archive 档案卷可选主题样式（#20：只换肤，不换 DOM 顺序）。
//
// 从 src/panel.ts 拆出（#226，蓝图 §4：panel/archive-theme）。只是一个 CSS 常量：内核 DOM
// 冻结，主题不得改顺序、不得藏复制诊断。

// ---------- Archive 档案卷可选主题（#20：只换肤，不换 DOM 顺序） ----------
//
// 约束（验收线）：内核 DOM 冻结——主题只换颜色/字体/间距，不得改顺序、不得藏复制诊断。
// 要素映射（原型 `prototype/redesign/archive.html` → 现有内核类，逐条对齐原型行号）：
// 大印章 → 根元素 `::before` + `content:attr(data-seal)`（原型 :206 `.seal`，右上 88px 旋转 -7°，
//          外框 + 内细框用两条 inset 阴影合成，不加节点）；色调按 `data-seal-tone` 四档。
// 小印章 → `.dsh-upd-banner::before` + `content:attr(data-mini)`（原型 :215 `.sealmini`，30px 旋转 -5°）；
//          **待重启横幅不画印章**——那一档的标记是手绘 SVG（原型 :446 `.mark` 只有 SVG）。
// profile 牌 → `.dsh-upd-log code`（现有插件标识 code 穿上牌样式，不加节点）；
// 待重启衬线横幅 → `[data-kind="restart"]` 衬线字体 + 警告配色 + 标题行左侧 SVG 标；
// 横幅副行 → `.dsh-upd-banner-sub`（行动句住色框之外、框下第二行居左；色框只装标题 strong）；
// 动作行 → `.dsh-upd-actions` 照原型 `.btn` 收紧（13px、无最小宽、8px 间距；复制类小按钮 12px）；
// 日志 → `.dsh-upd-changelog` 照原型 `.logver`（版本 mono 粗体、分类头隐藏改条目前缀红字）；
// 窄屏印章固定 → 640px 下印章固定 24px、不被挤掉，操作区换行；
// 优先级逐字折叠 → CSS 省略号逐字折叠（标题行单行省略；JS 引擎不移植：它要 data-fold 标记，会动 DOM）；
// 浅深双主题 → 同一套变量，浅色默认 + `prefers-color-scheme: dark` 深色（跟随系统，与默认主题同口径）。
// 可访问性：焦点环永不去掉；forced-colors 走系统色；reduced-motion 关掉一切过渡动画。
// 复制诊断永不隐藏：本串任何选择器都不对 `[data-action="copy-diag"]` / `.dsh-upd-manual` 写 `display:none`。
export const UPDATE_PANEL_ARCHIVE_CSS = [
  '/* Archive 档案卷可选主题：只换颜色/字体/间距；内核 DOM 顺序一字不动，不断复制诊断。 */',
  '.dsh-upd[data-theme="archive"]{--dsh-update-bg-soft:#f7f3ea;--dsh-update-bg:#fffdf6;--dsh-update-text:#1a1a1a;--dsh-update-text-muted:#6f675a;',
  '--dsh-update-border:#e3d9c4;--dsh-update-border-strong:#c4b896;--dsh-update-primary:#c8402a;--dsh-update-primary-deep:#9c2e1d;',
  '--dsh-update-ok-text:#1a7f37;--dsh-update-ok-bg:#e9f4ea;--dsh-update-warn-text:#8a5a00;--dsh-update-warn-bg:#fbf0d0;',
  '--dsh-update-bad-text:#b3261e;--dsh-update-bad-bg:#fbe9e5;',
  '--dsh-update-font-serif:Georgia,"Songti SC","STSong","SimSun","Noto Serif CJK SC","Source Han Serif SC",serif;',
  '--dsh-update-font-sans:system-ui,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
  '--dsh-update-font-mono:ui-monospace,"SF Mono",SFMono-Regular,Consolas,"Noto Sans Mono",monospace;',
  '--dsh-update-shadow:0 1px 2px rgba(60,40,20,.08),0 12px 32px rgba(60,40,20,.10);',
  'font-family:var(--dsh-update-font-sans);color:var(--dsh-update-text);background:var(--dsh-update-bg);',
  'border:1px solid var(--dsh-update-border-strong);border-radius:var(--dsh-update-radius-panel,4px);box-shadow:var(--dsh-update-shadow)}',
  // 按钮脸自己不透明（宿主底色未知时也读得出；卡片上渲染与 transparent 逐字同色）。
  '.dsh-upd[data-theme="archive"] button{border-color:var(--dsh-update-border-strong);background:var(--dsh-update-button-bg);color:var(--dsh-update-text);border-radius:var(--dsh-update-radius-button,3px);font-family:var(--dsh-update-font-sans)}',
  '.dsh-upd[data-theme="archive"] button:hover:not(:disabled){border-color:var(--dsh-update-primary);color:var(--dsh-update-primary)}',
  '.dsh-upd[data-theme="archive"] button[data-primary="1"]{background:var(--dsh-update-primary);border-color:var(--dsh-update-primary);color:#fff}',
  '.dsh-upd[data-theme="archive"] button[data-primary="1"]:hover:not(:disabled){background:var(--dsh-update-primary-deep);color:#fff}',
  '.dsh-upd[data-theme="archive"] button:focus-visible{outline:2px solid var(--dsh-update-primary);outline-offset:2px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner{background:var(--dsh-update-bg-soft);border-color:var(--dsh-update-border-strong)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="update"]{border-color:var(--dsh-update-ok-border);background:var(--dsh-update-ok-bg)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="busy"]{border-color:var(--dsh-update-busy-border);background:var(--dsh-update-busy-bg)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]{border-color:var(--dsh-update-warn-border);background:var(--dsh-update-warn-bg);font-family:var(--dsh-update-font-serif);border-width:2px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="failed"],.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="blocked"]{border-color:var(--dsh-update-bad-border);background:var(--dsh-update-bad-bg)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="done"]{border-color:var(--dsh-update-ok-border);background:var(--dsh-update-ok-bg)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-yanked{border-color:var(--dsh-update-warn-text);background:var(--dsh-update-warn-bg);color:var(--dsh-update-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-breaking-badge{color:var(--dsh-update-primary);border-color:var(--dsh-update-primary)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-count{color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-more-note{color:var(--dsh-update-text-muted)}',
  // —— 大印章（原型 :206 `.seal`：右上 88px、旋转 -7°、双细框；内容与色调来自根属性，不加节点）——
  '.dsh-upd[data-theme="archive"]{position:relative;padding:16px 20px 14px}',
  '.dsh-upd[data-theme="archive"]::before{content:attr(data-seal);position:absolute;top:20px;right:24px;width:88px;height:88px;',
  'display:flex;align-items:center;justify-content:center;text-align:center;letter-spacing:.18em;text-indent:.18em;line-height:1.35;',
  'border:3px solid currentColor;border-radius:14px;transform:rotate(-7deg);font-family:var(--dsh-update-font-serif);font-weight:700;font-size:21px;',
  'background:color-mix(in srgb,currentColor 8%,transparent);user-select:none;pointer-events:none;',
  'box-shadow:inset 0 0 0 5px var(--dsh-update-bg),inset 0 0 0 6px currentColor,0 2px 6px rgba(0,0,0,.12)}',
  '.dsh-upd[data-theme="archive"][data-seal-tone="ink"]::before{color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"][data-seal-tone="green"]::before{color:var(--dsh-update-ok-text)}',
  '.dsh-upd[data-theme="archive"][data-seal-tone="yellow"]::before{color:var(--dsh-update-warn-text)}',
  '.dsh-upd[data-theme="archive"][data-seal-tone="red"]::before{color:var(--dsh-update-bad-text)}',
  // 印章占位：首行（横幅/状态行）右侧留出 120px，文字不许压到印章上（原型 .filehead padding-right:120px）
  // —— 卷宗抬头（原型 :195-203 的刊头，主题切换按钮按用户口径去掉）：只有 Archive 档案卷才显示 ——
  '.dsh-upd[data-theme="archive"] .dsh-upd-masthead{display:block;padding:0 0 8px;margin:0 0 8px;border-bottom:1px solid var(--dsh-update-border)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-masthead-kicker{display:block;font-size:var(--dsh-update-panel-small-font-size,11px);letter-spacing:.35em;color:var(--dsh-update-text-muted);margin-bottom:3px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-masthead-title{font-family:var(--dsh-update-font-serif);font-size:26px;font-weight:700;line-height:1.2}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-masthead-title i{color:var(--dsh-update-primary);font-style:normal}',
  // 横幅不再给大印章留 124px：实测（headless 量盒子）印章盒底边 y=109，横幅正文顶边 y=108、
  // 状态行那句在 y=159——印章只压到横幅顶部的留白带，压不到正文。留着反而把 27px 那句话挤成两行
  // （27px 单行需 428px，留白后只剩 366px）。档案头那 120px 保留：那里是真的重叠。
  // —— 更新队列（03 章）Archive 皮肤 ——
  '.dsh-upd[data-theme="archive"] .dsh-upd-qrow{padding:6px 0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-qk{width:66px;letter-spacing:.18em}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-qv{font-family:var(--dsh-update-font-serif);font-size:var(--dsh-update-panel-small-font-size,16px)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-qn{font-family:var(--dsh-update-font-mono);font-size:var(--dsh-update-panel-small-font-size,11.5px);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-qseq{color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-note{color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-body .dsh-upd-chap-head{background:var(--dsh-update-bg)}',
  '.dsh-upd-overlay .dsh-upd[data-theme="archive"] .dsh-upd-body{scrollbar-color:var(--dsh-update-border-strong) transparent}',
  '.dsh-upd-overlay .dsh-upd[data-theme="archive"] .dsh-upd-body::-webkit-scrollbar-thumb{background:var(--dsh-update-border-strong)}',
  // —— 小印章（原型 :215 `.sealmini`：30px、旋转 -5°、一字；#99：真节点行内章）——
  // 待重启横幅一律不画印章：那一档的标记是左侧手绘 SVG（原型 :446 的 .mark 只有 SVG）。
  // #99 注：印章曾是横幅的 ::before 伪元素，但内核横幅是纵向 flex（#93 契约冻结），伪元素只能独占一行；
  // 英文词撑宽后固定缩进又会与标题重叠——纯 CSS 走不通。改为横幅首行内的真实行内节点（aria-hidden，
  // 默认主题隐藏），与原型 `.sealmini + 文字` 同结构；data-mini 属性保留（取证与快照口径不变）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="loading"] .dsh-upd-sealmini,.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="idle"] .dsh-upd-sealmini,',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="update"] .dsh-upd-sealmini,.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="busy"] .dsh-upd-sealmini,',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="blocked"] .dsh-upd-sealmini,.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="failed"] .dsh-upd-sealmini,',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="done"] .dsh-upd-sealmini{display:inline-flex;align-items:center;justify-content:center;width:auto;min-width:34px;height:34px;padding:0 6px;box-sizing:border-box;white-space:nowrap;vertical-align:middle;margin-right:10px;',
  'border:2px solid currentColor;border-radius:7px;',
  'font-family:var(--dsh-update-font-serif);font-weight:700;font-size:16px;line-height:26px;transform:rotate(-5deg);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="update"] .dsh-upd-sealmini{color:var(--dsh-update-ok-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="busy"] .dsh-upd-sealmini{color:var(--dsh-update-warn-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="blocked"] .dsh-upd-sealmini,.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="failed"] .dsh-upd-sealmini{color:var(--dsh-update-bad-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="done"] .dsh-upd-sealmini{color:var(--dsh-update-ok-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-log code{font-family:var(--dsh-update-font-mono);font-size:var(--dsh-update-panel-log-font-size,11px);color:var(--dsh-update-text-muted);border:1px solid var(--dsh-update-border-strong);border-radius:3px;padding:0 6px;letter-spacing:.06em}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-manual code{display:block;background:var(--dsh-update-text);color:var(--dsh-update-bg-soft);font-family:var(--dsh-update-font-mono);font-size:var(--dsh-update-panel-log-font-size,12.5px);padding:12px 14px;border-radius:4px;white-space:pre-wrap;word-break:break-all}',
  // 待重启标记：手绘 SVG 当**独立 flex 标记**放在文字块左侧（原型 :446 `.mark` 是独立节点），
  // 不能用行内背景——那样换行时三角会落在句子中间把话劈开（现场回归）。
  // 标记贴首行居中：标题 27px×1.25 行高≈33.75px 行盒，标 20px，(33.75-20)/2≈7px；
  // 故意不用 align-items:center——标题换两行时标会飘到块中间，flex-start 永远贴首行。
  // 悬挂缩进：首行给图标让位（图标 20px＋间距 10px），换行顶格落到图标下方、整块居左；
  // 不是两行文字互相对齐——负 margin 把标题拉回行首，text-indent 只顶首行。
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child strong{margin-left:-30px;text-indent:30px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child{display:flex;gap:10px;align-items:flex-start}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child::before{content:"";flex:none;width:20px;height:20px;margin-top:7px;',
  'background:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2720%27 height=%2720%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%238a5a00%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z%27/%3E%3Cline x1=%2712%27 y1=%279%27 x2=%2712%27 y2=%2713%27/%3E%3Cline x1=%2712%27 y1=%2717%27 x2=%2712.01%27 y2=%2717%27/%3E%3C/svg%3E") no-repeat center/20px 20px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child{overflow:hidden;text-overflow:ellipsis}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions{flex-wrap:wrap}',
  // footer 只换肤（#47 定案 A + Archive 约束：不换 DOM 顺序；复制诊断永不隐藏，本串不动它）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-footer{margin-top:14px;padding-top:10px;border-top:1px solid var(--dsh-update-border)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-foot-note{color:var(--dsh-update-text-muted)}',
  // footer 关闭幽灵统一（#108：与 actions 非主按钮同口径——缺覆盖吃到底层 button-bg 灰填充；只给透明底，沿用 border-strong/text 纸墨，不独立设色；字号/内边距跟 footer 现状走）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-footer button{background:transparent}',
  // —— 档案头（原型 :208-211 `.filehead`：serif 插件名 22px + 使用范围 + profile 牌；右侧留章位）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-head{display:flex;gap:16px;align-items:baseline;flex-wrap:wrap;padding-right:120px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-name{font-family:var(--dsh-update-font-serif);font-size:22px;font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-meta{width:100%;font-size:var(--dsh-update-panel-small-font-size,12.5px);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-meta b{color:var(--dsh-update-text);font-weight:600}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-proftag{font-family:var(--dsh-update-font-mono);font-size:var(--dsh-update-panel-small-font-size,11px);color:var(--dsh-update-text-muted);border:1px solid var(--dsh-update-border-strong);border-radius:3px;padding:0 6px;margin-left:8px;letter-spacing:.06em}',
  // —— 版本条（原型 :216 `.strip`：三格，格间一线，左上小写标签 + 等宽值）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip{display:flex;flex-wrap:wrap;margin:8px 0 0;border:1px solid var(--dsh-update-border);border-radius:4px;overflow:hidden;font-size:var(--dsh-update-panel-small-font-size,12.5px)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip>div{flex:1 1 120px;padding:6px 10px;border-left:1px solid var(--dsh-update-border)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip>div:first-child{border-left:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip-k{display:block;font-size:var(--dsh-update-panel-small-font-size,11px);letter-spacing:.2em;color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip-v{font-family:var(--dsh-update-font-mono);font-size:var(--dsh-update-panel-small-font-size,13px)}',
  // —— 章节（原型 :218-245：01–05 编号 + 衬线标题 + 细线）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-chapter{margin-top:16px;padding-top:10px;border-top:1px solid var(--dsh-update-border)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-head{display:flex;align-items:baseline;gap:12px;margin-bottom:6px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-no{font-family:var(--dsh-update-font-serif);font-style:italic;font-size:var(--dsh-update-panel-chapter-font-size,15px);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-title{font-family:var(--dsh-update-font-serif);font-size:var(--dsh-update-panel-chapter-font-size,17px);margin:0;letter-spacing:.1em}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-rule{flex:1;border-top:1px solid var(--dsh-update-border);transform:translateY(-4px)}',
  // —— 横幅即状态行 / 待重启横幅（原型 :81-85 `.restart-banner`：2px 边框、圆角 4、内边距 12/16、衬线；右侧留章位）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner{border:2px solid var(--dsh-update-border-strong);border-radius:4px;padding:10px 12px;font-size:var(--dsh-update-panel-font-size,14.5px);font-family:var(--dsh-update-font-serif);gap:10px;align-items:center}',
  // #99 标题行拉满：纵向 flex + align-items:center 会把短标题收成窄块居中（章跟着偏右）；
  // 原型状态行是整行块居左，这里 stretch 回去（副行已移出框体为独立兄弟节点，不吃本条）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child{flex:1 1 auto;min-width:0;align-self:stretch}',
  // 状态行字号照原型 .status-line=27px（实测去掉横幅右侧占位后可写 486px > 428px，一行放得下）
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child strong{font-family:var(--dsh-update-font-serif);font-size:var(--dsh-update-panel-banner-title-font-size,27px);font-weight:700;line-height:1.25}',
  // 已是最新是落定态，标题收一号 24px（其余档位仍 27px；只动 done，不碰原型行）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="done"]>div:first-child strong{font-size:var(--dsh-update-panel-banner-title-font-size,24px)}',
  // —— 进度条 / 跳过行（原型 :132-133 `.prog`、:129-131 `.skipline .tag`）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-prog{height:8px;background:var(--dsh-update-border);border-radius:4px;overflow:hidden;margin:10px 0 4px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-prog-bar{display:block;height:100%;background:var(--dsh-update-primary);transition:width .3s}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-progtxt{font-size:var(--dsh-update-panel-small-font-size,12.5px);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-skipline{font-size:var(--dsh-update-panel-log-font-size,13px);margin-top:8px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-tag{display:inline-block;border:1px dashed var(--dsh-update-border-strong);border-radius:3px;padding:1px 8px;margin-right:8px;font-family:var(--dsh-update-font-mono);font-size:var(--dsh-update-panel-small-font-size,12px)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-err{font-size:var(--dsh-update-panel-log-font-size,13px);margin:0 0 6px;color:var(--dsh-update-text-muted)}',
  // —— 横幅副行（框外第二行居左小字；色框只装标题，原型状态行是裸文本）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner-sub{color:var(--dsh-update-text-muted);font-size:var(--dsh-update-panel-small-font-size,12.5px);text-align:left;margin:2px 0 8px}',
  // —— 动作行贴原型（d5-paper :119-125 `.btn`：13px 紧凑、无最小宽、8px 间距；复制类小按钮 12px）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions{gap:8px;min-height:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button{font-size:13px;line-height:1.45;padding:6px 12px;margin:0;min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button:first-child{min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button[data-primary="1"]{min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button:first-child:not([aria-busy="true"])::after{display:none}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button:not([data-primary="1"]){background:transparent}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button[data-action="copy-manual"],' +
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button[data-action="copy-diag"]{font-size:12px;padding:4px 10px}',
  // —— 章节标题行开关贴原型小按钮（收起/展开日志、队列开关与复制类同档 12px）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-note button{font-size:12px;line-height:1.45;padding:4px 10px;margin:0;min-width:0;background:transparent}',
  // —— 日志贴原型（d5-paper :137-144 `.logver`：版本 mono 粗体、分类头隐藏、条目前缀红字）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-version{margin:12px 0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-title{font-family:var(--dsh-update-font-mono);font-size:var(--dsh-update-panel-log-font-size,14px);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-date{font-weight:400;font-size:var(--dsh-update-panel-small-font-size,12px);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog ul{margin:6px 0 0 2px;padding-left:18px;font-size:var(--dsh-update-panel-log-font-size,13.5px)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog li{margin:3px 0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-catname{display:none}',
  // 作者自定义小节（data-cat="other"）：档案卷没有「类名前缀」可补，标题必须自己显示出来，
  // 否则整段内容会变成没有出处的一堆条目（六类之外唯一需要露出标题的分支）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-cat[data-cat="other"] .dsh-upd-changelog-catname{display:block;font-size:var(--dsh-update-panel-small-font-size,12.5px);color:var(--dsh-update-primary);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-truncnote{border-left-color:var(--dsh-update-border-strong);opacity:1;color:var(--dsh-update-text-muted)}',
  // 前缀只给「正文自己没写类名」的顶层**散文**条目：嵌套子列表（.dsh-upd-md-list）的 li 不是 cat 的直接子级，
  // 正文已写 `**Added** · …` 的条目标了 data-cat-lead、整条是代码块/引用块的标了 data-cat-block（见 renderChangelogItem）
  //——否则会出现「Added · Added · …」，或在代码块前挂一个孤零零的「Added ·」。
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-cat[data-cat="Added"]>ul>li:not([data-cat-lead]):not([data-cat-block])::before{content:"Added · ";color:var(--dsh-update-primary);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-cat[data-cat="Fixed"]>ul>li:not([data-cat-lead]):not([data-cat-block])::before{content:"Fixed · ";color:var(--dsh-update-primary);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-cat[data-cat="Changed"]>ul>li:not([data-cat-lead]):not([data-cat-block])::before{content:"Changed · ";color:var(--dsh-update-primary);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-cat[data-cat="Security"]>ul>li:not([data-cat-lead]):not([data-cat-block])::before{content:"Security · ";color:var(--dsh-update-primary);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-fold[data-cat="Deprecated"]>ul>li:not([data-cat-lead]):not([data-cat-block])::before{content:"Deprecated · ";color:var(--dsh-update-text-muted);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-fold[data-cat="Removed"]>ul>li:not([data-cat-lead]):not([data-cat-block])::before{content:"Removed · ";color:var(--dsh-update-text-muted);font-weight:700}',
  // —— 档案卷：行内 Markdown 只换肤（纸色底、朱红链接、去掉下划线改细底线，贴原型 .logver 的手记感）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-md-code{background:var(--dsh-update-bg-soft);border-color:var(--dsh-update-border);color:var(--dsh-update-primary-deep);border-radius:2px;padding:0 3px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-md-link{color:var(--dsh-update-primary);text-decoration:none;border-bottom:1px solid currentColor}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-md-img{border-color:var(--dsh-update-border-strong);color:var(--dsh-update-text-muted)}',
  // —— 档案卷：块级 Markdown 同样只换肤（纸色代码块、墨色引用边线、列表缩进收紧）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-md-pre{background:var(--dsh-update-bg-soft);border-color:var(--dsh-update-border);border-radius:2px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-md-quote{border-left-color:var(--dsh-update-border-strong);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-md-list,.dsh-upd[data-theme="archive"] .dsh-upd-md-list-ol{padding-left:16px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-md-hr{border-top-color:var(--dsh-update-border-strong)}',
  '@media (max-width:640px){.dsh-upd[data-theme="archive"]{padding:10px 12px}.dsh-upd[data-theme="archive"]::before{top:12px;right:12px;width:56px;height:56px;font-size:15px;box-shadow:inset 0 0 0 4px var(--dsh-update-bg),inset 0 0 0 5px currentColor}.dsh-upd[data-theme="archive"] .dsh-upd-masthead-title{font-size:19px}.dsh-upd[data-theme="archive"] .dsh-upd-banner{padding-right:16px}.dsh-upd[data-theme="archive"] .dsh-upd-banner .dsh-upd-sealmini{min-width:28px;height:28px;font-size:14px;line-height:20px}.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child{white-space:normal}}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"]{--dsh-update-bg-soft:#141210;--dsh-update-bg:#1e1a15;--dsh-update-text:#ece5d3;--dsh-update-text-muted:#a89c83;',
  '--dsh-update-border:#3a3226;--dsh-update-border-strong:#5c4e3b;--dsh-update-primary:#e0684e;--dsh-update-primary-deep:#f0866b;',
  '--dsh-update-ok-text:#8fd6a4;--dsh-update-ok-bg:rgba(80,180,120,.12);--dsh-update-warn-text:#e8c15a;--dsh-update-warn-bg:rgba(232,193,90,.12);',
  '--dsh-update-bad-text:#ef8a7d;--dsh-update-bad-bg:rgba(239,138,125,.12);--dsh-update-shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px rgba(0,0,0,.45)}}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"] button[data-primary="1"]{color:#141210}.dsh-upd[data-theme="archive"] button:focus-visible{outline-color:var(--dsh-update-primary-deep)}}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child::before{background-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2720%27 height=%2720%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23e8c15a%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z%27/%3E%3Cline x1=%2712%27 y1=%279%27 x2=%2712%27 y2=%2713%27/%3E%3Cline x1=%2712%27 y1=%2717%27 x2=%2712.01%27 y2=%2717%27/%3E%3C/svg%3E")}}',
  // —— 深色手工命令块去反白：亮底在深纸上太晃，改卡面微亮深底 + 浅字 + 细边框（浅色仍是原型深块，不动）——
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"] .dsh-upd-manual code{background:#26211a;color:#ece5d3;border:1px solid var(--dsh-update-border-strong)}}',
  '@media (forced-colors: active){.dsh-upd[data-theme="archive"]{box-shadow:none}.dsh-upd[data-theme="archive"]::before{background:none;box-shadow:none;border-color:CanvasText;color:CanvasText}.dsh-upd[data-theme="archive"] .dsh-upd-banner{border:1px solid CanvasText}.dsh-upd[data-theme="archive"] .dsh-upd-banner::before{border-color:CanvasText;color:CanvasText;background:Canvas}.dsh-upd[data-theme="archive"] button{border:1px solid ButtonText}.dsh-upd[data-theme="archive"] button[data-primary="1"]{background:ButtonFace;color:ButtonText;border-color:ButtonText}.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child::before{background-image:none;content:"⚠"}}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd[data-theme="archive"] *{transition:none !important;animation:none !important}}',
].join('\n')
