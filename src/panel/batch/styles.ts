/**
 * src/panel/batch/styles.ts —— 批量面板样式（#229 自旧 src/panel-batch.ts 样式段拆出）。
 *
 * 两套皮肤：默认最小样式 + Archive 归档皮肤。纯字符串常量，无依赖。
 */

export const UPDATE_BATCH_PANEL_CSS = [
  '/* 批量面板（#25）：类名沿用 dsh-upd-* 前缀；默认（最小）主题，Archive 皮肤见 UPDATE_BATCH_PANEL_ARCHIVE_CSS。 */',
  // —— 弹窗帧高度契约（#240，headless 量盒子实测）——
  // 批量弹窗根（.dsh-upd.dsh-upd-batch）没有 .dsh-upd-body 滚动区，内核的 #93 契约（:has(>.dsh-upd-body)）
  // 刻意不覆盖它；于是内容高过 85vh 时纵向 flex 把所有子项按比例压，唯独显式 min-height:3.4em 的横幅
  // 先被压到地板：失败横幅只剩一个 3.4em 高的红框，名单行与「复制诊断/复制手工命令」越出框外
  // （实测窗口 CSS 高 ≤ 约 636 时必现；用户 876x1084@DPR2 截图即此形）。
  // 契约：批量弹窗里各 child 不许让高度（flex:none），放不下时整根自己滚。
  '.dsh-upd-overlay .dsh-upd.dsh-upd-batch{overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}',
  '.dsh-upd-overlay .dsh-upd.dsh-upd-batch>*{flex:none}',
  '.dsh-upd-batch-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}',
  '.dsh-upd-batch-title{font-weight:700;font-size:var(--dsh-update-panel-chapter-font-size,15px);letter-spacing:.06em}',
  '.dsh-upd-batch-title i{font-style:normal;color:var(--dsh-update-primary,#2563eb)}',
  '.dsh-upd-batch-macros{flex:none}',
  '.dsh-upd-batch-sum{margin:4px 0 8px;font-size:var(--dsh-update-panel-log-font-size,13.5px)}',
  '.dsh-upd-btable{margin-top:2px}',
  '.dsh-upd-brow-set{border-top:1px solid var(--dsh-update-border,#e5e7eb)}',
  '.dsh-upd-brow-set:first-child{border-top:0}',
  '.dsh-upd-brow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0}',
  '.dsh-upd .dsh-upd-brow-main{display:grid;grid-template-columns:auto minmax(5em,max-content) minmax(18ch,max-content) minmax(0,1fr);align-items:baseline;column-gap:8px;row-gap:2px;flex:1 1 260px;min-width:0;',
  'text-align:left;cursor:pointer;color:inherit;font:inherit;background:transparent;border:0;padding:2px 0;margin:0}',
  '.dsh-upd .dsh-upd-brow-main:hover{color:var(--dsh-update-primary,#2563eb)}',
  '.dsh-upd-brow-actions{flex:none;margin-left:auto}',
  '.dsh-upd-brow-actions button{font-size:12.5px}',
  '.dsh-upd-updot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsh-update-border,#9ca3af);opacity:.55}',
  '.dsh-upd-updot[data-tone="todo"]{background:var(--dsh-update-ok-border,#059669);opacity:1}',
  '.dsh-upd-updot[data-tone="ok"]{background:var(--dsh-update-ok-border,#059669);opacity:1}',
  '.dsh-upd-updot[data-tone="busy"]{background:var(--dsh-update-busy-border,#2563eb);opacity:1}',
  '.dsh-upd-updot[data-tone="warn"]{background:var(--dsh-update-warn-border,#d97706);opacity:1}',
  '.dsh-upd-updot[data-tone="bad"]{background:var(--dsh-update-bad-border,#dc2626);opacity:1}',
  '.dsh-upd-bname{font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-upd-bver{font-family:Consolas,Menlo,monospace;font-size:var(--dsh-update-panel-small-font-size,12px);white-space:nowrap;font-variant-numeric:tabular-nums;min-width:0}',
  '.dsh-upd-bver-cur{opacity:.65}',
  '.dsh-upd-bver-arrow{opacity:.6}',
  '.dsh-upd-bver-new{color:var(--dsh-update-new-text,#dc2626);font-weight:700}',
  '.dsh-upd-bver-new-ok{color:var(--dsh-update-new-ok-text,#047857);font-weight:700}',
  '.dsh-upd-bstat{font-size:var(--dsh-update-panel-small-font-size,12.5px);opacity:.9;min-width:0;overflow-wrap:anywhere}',
  // #174：行状态区的轻量标记（只有最后手段那档出现；不新增按钮）。
  '.dsh-upd-lr-rowbadge{display:inline-block;margin-right:5px;font-size:var(--dsh-update-panel-small-font-size,11px);font-weight:700;letter-spacing:.06em;border:1px solid currentColor;border-radius:3px;padding:0 4px;color:var(--dsh-update-bad-text,#b91c1c)}',
  // #174：展开详情复用单插件内核的最后手段条；大卡里 alert 图标放大到 22px（行内只留文字徽标）。
  '.dsh-upd-bdetail-dialog .dsh-upd-lr-ico{width:22px;height:22px}',
  '.dsh-upd-bfail{grid-column:1/-1;display:block;font-size:var(--dsh-update-panel-small-font-size,12.5px);color:var(--dsh-update-bad-border,#dc2626)}',
  '/* #156 finishing fact: ledger phase failed but the newest installable build did get installed — green, not red. */',
  '.dsh-upd-bdone{color:var(--dsh-update-ok-border,#059669)}',
  '.dsh-upd-batch{--dsh-update-new-text:#dc2626}',
  '.dsh-upd-batch{--dsh-update-new-ok-text:#047857}',
  '@media (prefers-color-scheme: dark){.dsh-upd-batch{--dsh-update-new-text:#f87171}}',
  '@media (prefers-color-scheme: dark){.dsh-upd-batch{--dsh-update-new-ok-text:#34d399}}',
  '@media (forced-colors: active){.dsh-upd-bver-new{color:CanvasText}}',
  '@media (forced-colors: active){.dsh-upd-bver-new-ok{color:CanvasText}}',
  '.dsh-upd-blist{font-size:var(--dsh-update-panel-small-font-size,12.5px);margin-top:2px}',
  // 名单按钮同行：名单居左占满，按钮居右不换行；窄屏换行时按钮仍靠右。
  '.dsh-upd-browline{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
  '.dsh-upd-browline>.dsh-upd-blist{flex:1 1 auto;min-width:0;text-align:left;margin:0}',
  '.dsh-upd-browline>button{flex:none;margin:0;margin-left:auto}',
  // #176：失败横幅里两枚复制按钮成组；不然每颗按钮各吃一份 margin-left:auto，会被拉开到两处。
  '.dsh-upd-browline>.dsh-upd-bcopy{display:inline-flex;align-items:center;gap:10px;flex:none;margin-left:auto}',
  '.dsh-upd-browline>.dsh-upd-bcopy>button{flex:none;margin:0}',
  '.dsh-upd-batch-ledger{margin:8px 0 0;font-size:var(--dsh-update-panel-log-font-size,13px);opacity:.85}',
  '.dsh-upd-batch-more{margin-top:6px}',
  '.dsh-upd-batch-more button{font-size:12px}',
  // 确认态：红框红字，与「关闭」等中性按钮一眼区分；disabled 照旧置灰。
  '.dsh-upd-batch-more button[data-confirm="1"]{border-color:var(--dsh-update-bad-border,#dc2626);color:var(--dsh-update-bad-border,#dc2626)}',
  '.dsh-upd-batch-notice{margin-top:6px;font-size:var(--dsh-update-panel-small-font-size,12.5px);opacity:.85}',
  '.dsh-upd-bdetail-actions{margin:0 0 6px}',
  '.dsh-upd .dsh-upd-bdetail-actions button{font-size:12.5px}',
  '.dsh-upd-bdetail-notice{margin:0 0 6px;font-size:var(--dsh-update-panel-small-font-size,12.5px);opacity:.85}',
  '/* Detail dialog (#108): reuse kernel dialog scroll (body scroll + sticky heads); batch actions as fixed bar; legacy inline overflow:visible retired with inline removal. */',
  '.dsh-upd-overlay.dsh-upd-bdetail-dialog{z-index:10000}',
  '.dsh-upd-bdetail-dialog-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 0;margin-bottom:8px;border-bottom:1px dashed var(--dsh-update-border,#e5e7eb)}',
  '.dsh-upd-bdetail-dialog-bar .dsh-upd-bdetail-actions{margin:0}',
  '@media (prefers-color-scheme: dark){.dsh-upd-batch-title i{color:var(--dsh-update-focus,#93c5fd)}}',
  // #216：正在安装＝醒目 + 动态（旋转描边 + 呼吸脉冲），让「在装」与「卡住」一眼可分；
  // reduced-motion 由下方既有规则关掉动画，配色与文字仍在。
  '.dsh-upd .dsh-upd-busy-btn:disabled{opacity:1;cursor:progress;font-weight:700;border-color:var(--dsh-update-busy-border,#2563eb);color:var(--dsh-update-busy-border,#2563eb);background:var(--dsh-update-busy-bg,#eff6ff)}',
  '.dsh-upd .dsh-upd-busy-btn:disabled::before{content:"";display:inline-block;width:9px;height:9px;margin-right:6px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;vertical-align:-1px;animation:dsh-upd-busy-spin .8s linear infinite}',
  // #219 双转条：单面板主题对 [aria-busy="true"] 按钮自带一枚 ::after 转圈，批量在装按钮自己还有一枚
  // ::before 转圈，两枚叠起来像两个转动条。在装按钮已用 ::before 表达忙碌，这里关掉主题那枚。
  '.dsh-upd .dsh-upd-busy-btn[aria-busy="true"]::after{content:none;display:none}',
  '.dsh-upd .dsh-upd-busy-btn[data-busy="1"]{animation:dsh-upd-busy-pulse 1.4s ease-in-out infinite}',
  '@keyframes dsh-upd-busy-spin{to{transform:rotate(360deg)}}',
  '@keyframes dsh-upd-busy-pulse{0%,100%{box-shadow:0 0 0 0 rgba(37,99,235,.35)}50%{box-shadow:0 0 0 4px rgba(37,99,235,0)}}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd-batch *{transition:none !important;animation:none !important}}',
  // Batch check layout stability: reserve macro width + rows/summary heights + no scroll anchoring jumps.
  '.dsh-upd-batch{overflow-anchor:none}',
  '.dsh-upd-btable{overflow-anchor:none}',
  '.dsh-upd-batch-macros{display:flex;flex-wrap:wrap;align-items:center;gap:0}',
  '.dsh-upd-batch-macros button:first-child,.dsh-upd-batch-macros button[data-primary="1"]{min-width:6em;text-align:center}',
  '.dsh-upd-batch-sum,.dsh-upd-batch-ledger{min-height:1.6em}',
  '.dsh-upd-brow{min-height:28px}',
].join(String.fromCharCode(10))

/**
 * 批量面板的 Archive 皮肤（#20 同一套口径：只换颜色/字体/间距，不改顺序、不藏东西）。
 * 卷宗抬头右侧给大印章留 120px（与单插件面板档案头同一处理）。
 */
export const UPDATE_BATCH_PANEL_ARCHIVE_CSS = [
  '/* 批量面板的 Archive 皮肤：只换颜色/字体/间距；根上的大印章由 UPDATE_PANEL_ARCHIVE_CSS 负责。 */',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-head{padding-right:120px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-title{font-family:var(--dsh-update-font-serif);font-size:var(--dsh-update-panel-chapter-font-size,21px);letter-spacing:.04em}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-title i{color:var(--dsh-update-primary)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-brow-main{background:transparent;border:0;color:var(--dsh-update-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-brow-main:hover{color:var(--dsh-update-primary)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-bname{font-family:var(--dsh-update-font-serif)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-bver{font-family:var(--dsh-update-font-mono);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-bver-cur{opacity:.75}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-bver-new{color:var(--dsh-update-new-text,#b3261e)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-bver-new-ok{color:var(--dsh-update-new-ok-text,#1a7f37)}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"] .dsh-upd-batch{--dsh-update-new-ok-text:#8fd6a4}}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch{--dsh-update-new-text:#b3261e}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch{--dsh-update-new-ok-text:#1a7f37}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"] .dsh-upd-batch{--dsh-update-new-text:#ef8a7d}}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-ledger{color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-sum{color:var(--dsh-update-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-brow-set{border-top-color:var(--dsh-update-border)}',
  // 批量动作行贴原型（与单面板同口径：13px 紧凑、无最小宽、8px 间距；行内/详情/更多按钮小号 12px）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-macros{gap:8px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-macros button{font-size:13px;line-height:1.45;padding:6px 12px;margin:0;min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-macros button:first-child,.dsh-upd[data-theme="archive"] .dsh-upd-batch-macros button[data-primary="1"]{min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-macros button:not([data-primary="1"]){background:transparent}',
  // #216：透明底只给「次级」按钮；主按钮（data-primary）与正在安装（data-busy）必须保留实底，
  // 否则档案卷里白字落在透明/浅底上＝按钮文字看不见（真机截图：加入队列/正在安装整块隐形）。
  // 尺寸坚持小号 12px（贴原型），底色单独一条规则，免得把主按钮的实底一起盖掉。
  '.dsh-upd[data-theme="archive"] .dsh-upd-brow-actions button{font-size:12px;line-height:1.45;padding:4px 10px;margin:0;min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-brow-actions button:not([data-primary="1"]):not([data-busy="1"]){background:transparent}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-bdetail-actions button{font-size:12px;line-height:1.45;padding:4px 10px;margin:0;min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-bdetail-actions button:not([data-primary="1"]):not([data-busy="1"]){background:transparent}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-more button{font-size:12px;line-height:1.45;padding:4px 10px;margin:0;min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-more button:not([data-primary="1"]):not([data-busy="1"]){background:transparent}',
  // prefs 开关贴幽灵口径（#106：以请重启/详情为基准——此前无覆盖，吃到底层 archive button 填充；沿用 border-strong/text，不独立设键；13px 与宏/名单行同档）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-prefs button{font-size:13px;line-height:1.45;padding:6px 12px;margin:0;min-width:0;background:transparent}',
  // 黄框名单行（只收敛不对齐规则，不声明横幅盒体布局）：标题行拉满，名单居左，按钮同行居右。
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>.dsh-upd-browline{align-self:stretch;display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>.dsh-upd-browline .dsh-upd-blist{flex:1 1 auto;min-width:220px;text-align:left;margin:0;color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>.dsh-upd-browline button{flex:none;margin:0;margin-left:auto;font-size:13px;line-height:1.45;padding:6px 12px;min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>.dsh-upd-browline button:not([data-primary="1"]):not([data-busy="1"]){background:transparent}',
].join(String.fromCharCode(10))
