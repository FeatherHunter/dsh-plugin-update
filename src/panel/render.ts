// src/panel/render.ts —— 面板渲染（同一视图 → 同一内核 HTML；内外摆放只差外层包裹）+ 默认样式表。
//
// 从 src/panel.ts 拆出（#226，蓝图 §4：panel/render）。纯函数 + 一个 CSS 常量：不碰 DOM、
// 不碰宿主；失败锁存只接只读快照 PanelFailureRef，归档主题样式在 panel/archive-theme，
// 视图判定与预判门在 panel/view-model（本文件只按视图画）。

import { CAUSE_KINDS, blameCausePackage, formatUnlockAt, interpretInstallCause } from '../core/cause.js'
import { changelogForUpdate, isChangelogStatus, parseChangelogReport, type ChangelogStatus } from '../core/changelog/parse.js'
import { renderChangelogHTML, truncationNoteHTML, yankedBannerHTML } from '../core/changelog/render-model.js'
import type { BilingualKey } from '../core/i18n/dictionary.js'
import { copyText } from '../core/i18n/text.js'
import type { UpdateLogHealth } from '../log/health.js'
import { logHealthText, updaterPartsOf, type UpdaterSelfView } from '../shared/copy.js'
import type { UpdatePanelMode, UpdatePanelTheme } from '../panel.js'
import { normalizeLangTag, type AppLang } from '../shared/lang.js'
import { lastResortVerdictOf, type LastResortVerdict, type ManualSource } from '../shared/last-resort.js'
import { LOG_EVENT_CALL, LOG_EVENT_CALL_FAIL, LOG_EVENT_INSTALL_EXEC } from '../shared/log-events.js'
import { manualAbsentReasonOf, manualAbsentTextOf, manualAppliesToBanner } from '../shared/manual-absent.js'
import type { UpdateSnapshot } from '../shared/ports.js'
import { UPDATE_PANEL_ARCHIVE_CSS } from './archive-theme.js'
import { formatLatchTime, type PanelFailureRef } from './failure-latch.js'
import { normalizePanelTheme, themeTokensStyleFor, type UpdateThemeTokens } from './theme.js'
import { checkPrejudgeOfView, panelViewModel, type CheckPrejudge, type PanelView, type PanelViewInput } from './view-model.js'

// ---------- 渲染（纯函数：同一视图 → 同一内核 HTML；内外摆放只差外层包裹） ----------

export const UPDATE_PANEL_CSS = [
  '.dsh-upd{font:var(--dsh-update-panel-font-size,14px)/1.75 system-ui,"Microsoft YaHei",sans-serif;color:var(--dsh-update-text,#1f2937);',
  'background:var(--dsh-update-bg,#ffffff);border:1px solid var(--dsh-update-border,#e5e7eb);border-radius:8px;padding:12px 14px;max-width:560px;',
  // 横幅配色走变量（浅色默认 + 深色覆盖，见下方 dark 媒体块）：硬编码浅色会让深色下
  // 「浅底 + 浅字」读不出来（现场回归：默认主题深色模式更新横幅白底浅字）。
  '--dsh-update-ok-bg:#ecfdf5;--dsh-update-ok-border:#059669;--dsh-update-warn-bg:#fffbeb;--dsh-update-warn-border:#d97706;',
  '--dsh-update-bad-bg:#fef2f2;--dsh-update-bad-border:#dc2626;--dsh-update-busy-bg:#eff6ff;--dsh-update-busy-border:#2563eb}',
  '.dsh-upd *{box-sizing:border-box}',
  '.dsh-upd button{font:inherit;border:1px solid var(--dsh-update-border-strong,#d1d5db);border-radius:var(--dsh-update-radius-button,6px);background:var(--dsh-update-button-bg,#f9fafb);',
  'color:inherit;padding:7px 14px;cursor:pointer;margin:2px 6px 2px 0}',
  '.dsh-upd button:disabled{opacity:.45;cursor:not-allowed}',
  '.dsh-upd button:focus-visible{outline:2px solid var(--dsh-update-focus,#2563eb);outline-offset:1px}',
  '.dsh-upd button[data-primary="1"]{background:var(--dsh-update-primary,#2563eb);border-color:var(--dsh-update-primary,#2563eb);color:#fff}',
  '.dsh-upd-banner{border-left:4px solid var(--dsh-update-border,#9ca3af);padding:6px 10px;margin:0 0 8px;background:var(--dsh-update-bg-soft,#f3f4f6)}',
  '.dsh-upd-banner[data-kind="restart"]{border-color:var(--dsh-update-warn-border);background:var(--dsh-update-warn-bg)}',
  '.dsh-upd-banner[data-kind="failed"],.dsh-upd-banner[data-kind="blocked"]{border-color:var(--dsh-update-bad-border);background:var(--dsh-update-bad-bg)}',
  '.dsh-upd-banner[data-kind="update"]{border-color:var(--dsh-update-ok-border);background:var(--dsh-update-ok-bg)}',
  '.dsh-upd-banner[data-kind="busy"]{border-color:var(--dsh-update-busy-border);background:var(--dsh-update-busy-bg)}',
  // —— 最后手段条（#174 A′ 形态）——
  // 只有判定为 last-resort（无自动救援且命令当帧可信）才画；语义类 `.dsh-upd-lastresort` 也只在那一档出现，
  // 测试靠 data-last-resort 钩子与它区分「有高亮」和「只是样式表里恰好有这个名字」。
  '.dsh-upd-lastresort{display:flex;align-items:flex-start;gap:9px;flex-wrap:wrap;border:1px solid var(--dsh-update-bad-border,#dc2626);border-left:4px solid var(--dsh-update-bad-text,#b91c1c);background:var(--dsh-update-bad-bg,#fef2f2);padding:8px 10px;margin:0 0 8px}',
  '.dsh-upd-lr-ico{flex:none;width:18px;height:18px;color:var(--dsh-update-bad-border,#dc2626);margin-top:2px}',
  '.dsh-upd-lr-main{flex:1 1 220px;min-width:0}',
  '.dsh-upd-lr-line{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
  '.dsh-upd-lr-badge{display:inline-block;font-size:var(--dsh-update-panel-small-font-size,11px);font-weight:700;letter-spacing:.08em;border:1px solid currentColor;color:var(--dsh-update-bad-border,#dc2626);border-radius:3px;padding:0 5px}',
  '.dsh-upd-lr-status{font-weight:700}',
  '.dsh-upd-lr-reason{font-size:var(--dsh-update-panel-log-font-size,13px);opacity:.9;margin-top:2px;overflow-wrap:anywhere}',
  '.dsh-upd-lr-go{margin:0;padding:4px 10px;font-size:var(--dsh-update-panel-small-font-size,12.5px);align-self:center}',
  '.dsh-upd-lr-chap-badge{flex:none;display:inline-block;font-size:var(--dsh-update-panel-small-font-size,11px);font-weight:700;border:1px solid currentColor;color:var(--dsh-update-bad-border,#dc2626);border-radius:3px;padding:0 5px;margin-left:6px;vertical-align:baseline}',
  // 复制成功气泡（#173 v1.3）：fixed 定位，不挤压布局；角色 status 由标记带出，按钮文案/图标不变。
  '.dsh-upd-copy-bubble{position:fixed;z-index:10000;transform:translate(-50%,-100%);background:var(--dsh-update-text,#1f2937);color:var(--dsh-update-bg,#ffffff);border-radius:4px;padding:3px 9px;font-size:var(--dsh-update-panel-small-font-size,12px);line-height:1.5;pointer-events:none;animation:dsh-upd-fadein .12s ease}',
  '.dsh-upd code{font-family:Consolas,Menlo,monospace;font-size:var(--dsh-update-panel-log-font-size,12px);word-break:break-all}',
  '.dsh-upd-manual,.dsh-upd-queue,.dsh-upd-log{margin:4px 0;font-size:var(--dsh-update-panel-log-font-size,13px)}',
  '.dsh-upd-changelog-wrap{margin:4px 0 0;font-size:var(--dsh-update-panel-log-font-size,13px)}',
  '.dsh-upd-changelog-title{font-weight:700;margin:0 0 4px}',
  '.dsh-upd-changelog-version{margin:6px 0}',
  '.dsh-upd-changelog-catname{font-weight:600;margin:6px 0 2px}',
  '.dsh-upd-changelog ul{margin:2px 0 6px 20px;padding:0}',
  '.dsh-upd-changelog li{margin:2px 0}',
  '.dsh-upd-changelog-fold{margin:4px 0}',
  '.dsh-upd-changelog-fold>summary{cursor:pointer}',
  '.dsh-upd-changelog-count{font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.7;margin:2px 0 4px}',
  '.dsh-upd-changelog-yanked{border-left:4px solid var(--dsh-update-warn-border,#d97706);background:var(--dsh-update-warn-bg,#fffbeb);padding:6px 10px;margin:6px 0;font-size:var(--dsh-update-panel-log-font-size,13px)}',
  '.dsh-upd-breaking-badge{display:inline-block;font-size:var(--dsh-update-panel-small-font-size,11px);font-weight:700;border:1px solid currentColor;border-radius:3px;padding:0 5px;margin-right:6px;vertical-align:baseline}',
  '.dsh-upd-changelog-security-more{margin:4px 0 6px}',
  '.dsh-upd-changelog-security-more>summary{cursor:pointer;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.8}',
  '.dsh-upd-changelog-more-note{font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.7;margin:2px 0 4px}',
  // 文档级截断说明（0.16.0）：切掉多少写在日志块头上，不再静默丢字。
  '.dsh-upd-changelog-truncnote{font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.8;border-left:3px solid var(--dsh-update-border,#d1d5db);padding:2px 0 2px 8px;margin:4px 0 6px}',
  '.dsh-upd-changelog-neutral{color:inherit;opacity:.8}',
  // —— 日志行内 Markdown（#110 取样：行内代码 4914 处/81 份是主力，粗体 4742/26，链接 6286+裸 URL 6671）——
  // 只上最小可用样式：颜色/底色一律走现有 token（第三方 themeTokens 覆盖即生效），不新增配色体系。
  '.dsh-upd-md-code{font-family:var(--dsh-update-font-mono,Consolas,Menlo,monospace);font-size:.92em;background:var(--dsh-update-bg-soft,#f3f4f6);border:1px solid var(--dsh-update-border,#e5e7eb);border-radius:3px;padding:0 3px;word-break:break-word}',
  '.dsh-upd-md-link{color:var(--dsh-update-primary,#2563eb);text-decoration:underline;text-underline-offset:2px;cursor:pointer;word-break:break-all}',
  '.dsh-upd-md-del{opacity:.7}',
  '.dsh-upd-md-img{display:inline-block;max-width:100%;border:1px dashed var(--dsh-update-border,#d1d5db);border-radius:3px;padding:0 4px;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.85;word-break:break-all}',
  // —— 日志块级 Markdown（嵌套子条目 / 引用块 / 围栏代码块 / 续行段落，见 #116 返工后的解析层）——
  // 面板正文只有 400–460px 宽：代码块横向滚动而不是撑破面板，列表缩进收紧，引用块只留一条左边线。
  '.dsh-upd-md-pre{margin:6px 0;padding:7px 9px;max-width:100%;overflow-x:auto;background:var(--dsh-update-bg-soft,#f3f4f6);border:1px solid var(--dsh-update-border,#e5e7eb);border-radius:4px}',
  '.dsh-upd-md-precode{display:block;font-family:var(--dsh-update-font-mono,Consolas,Menlo,monospace);font-size:.9em;white-space:pre;background:none;border:0;padding:0}',
  '.dsh-upd-md-quote{margin:6px 0;padding:1px 0 1px 9px;border-left:3px solid var(--dsh-update-border,#d1d5db);color:var(--dsh-update-text-muted,#4b5563)}',
  '.dsh-upd-md-list{margin:4px 0;padding-left:18px;list-style:disc}',
  '.dsh-upd-md-list-ol{margin:4px 0;padding-left:20px;list-style:decimal}',
  '.dsh-upd-md-list li,.dsh-upd-md-list-ol li{margin:2px 0}',
  '.dsh-upd-md-para{margin:4px 0}',
  // 分隔线（`---`／`***`）：作者拿它切版本或小节，别让它以字面 `---` 混在正文里（jimp 类日志常见）。
  '.dsh-upd-md-hr{margin:8px 0;border:0;border-top:1px solid var(--dsh-update-border,#e5e7eb)}',
  '.dsh-upd-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:9999}',
  '.dsh-upd-overlay .dsh-upd{background:var(--dsh-update-bg,#ffffff);max-height:85vh;display:flex;flex-direction:column;overflow:hidden}',
  // —— 弹窗高度让渡契约（#93，headless 量盒子实测）——
  // 面板内容高过 85vh 时，纵向 flex 按比例压所有子项；唯独**显式写了 min-height 的区**会失去 CSS 的
  // 「内容最小尺寸」自动保护：横幅（3.4em）与版本条（48px）被压到地板，而没写 min-height 的抬头/
  // 档案头/页脚纹丝不动。档案卷皮肤又给横幅加了 flex-wrap:wrap——纵向 flex 上它不换行而换列，
  // 最后一项（副行）被甩到标题右侧、冲出横幅后被 .dsh-upd{overflow:hidden} 裁掉。
  // 契约：带滚动区的弹窗帧里，只有滚动区让高度，其余各区不得小于自己的内容高度。
  // :has(>.dsh-upd-body) 是刻意的边界——批量面板的弹窗帧没有滚动区，本契约不扩到它（属 #90/#91 域）。
  '.dsh-upd-overlay .dsh-upd:has(>.dsh-upd-body)>:not(.dsh-upd-body){flex:none}',
  // 兜底：窗口矮到连框架都放不下时，整面板自己滚（横向仍 hidden）；章节区留 8em 下限——
  // 别把章节区压成 0、更别把页脚顶出视野还滚不到（实测：可用高 ≤ 约 512 时接管，对应窗口高 ≤ 约 600）。
  '.dsh-upd-overlay .dsh-upd:has(>.dsh-upd-body){overflow-x:hidden;overflow-y:auto}',
  '.dsh-upd-overlay .dsh-upd:has(>.dsh-upd-body)>.dsh-upd-body{min-height:8em}',
  // —— 弹窗分栏滚动：头（抬头/档案头/横幅/版本条）与尾固定，只有 01–05 章节区滚动 ——
  '.dsh-upd-body{min-height:0}',
  '.dsh-upd-body *{min-width:0}',
  '.dsh-upd-overlay .dsh-upd-body{flex:1 1 auto;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--dsh-update-border,#e5e7eb) transparent}',
  '.dsh-upd-overlay .dsh-upd-body::-webkit-scrollbar{width:8px}',
  '.dsh-upd-overlay .dsh-upd-body::-webkit-scrollbar-thumb{background:var(--dsh-update-border,#e5e7eb);border-radius:4px}',
  '.dsh-upd-overlay .dsh-upd-body::-webkit-scrollbar-track{background:transparent}',
  // —— 章节标题磁吸：滚动时节标题贴顶（纯 CSS sticky；背景跟随主题，Archive 另覆）——
  '.dsh-upd-overlay .dsh-upd-body .dsh-upd-chap-head{position:sticky;top:0;z-index:1;background:var(--dsh-update-bg,#ffffff);padding-top:2px}',
  // —— 档案头 / 版本条 / 章节 / 进度条 / 跳过行（原型 :208-245 的新结构，默认主题给最小可用样式）——
  '.dsh-upd-head{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}',
  // 卷宗抬头「插件更新 / 更新档案 卷」：Archive 档案卷才画，默认（最小）主题不画。
  // 两个主题共用同一份内核 HTML（见 renderUpdatePanelHTML 的注释），画不画是皮肤决定的事。
  '.dsh-upd-masthead{display:none}',
  '.dsh-upd-name{font-weight:700}',
  '.dsh-upd-meta{font-size:var(--dsh-update-panel-small-font-size,12.5px);opacity:.75}',
  '.dsh-upd-proftag{font-family:Consolas,Menlo,monospace;font-size:var(--dsh-update-panel-small-font-size,11px);border:1px solid var(--dsh-update-border,#d1d5db);border-radius:3px;padding:0 5px;margin-left:6px;letter-spacing:.06em}',
  '.dsh-upd-strip{display:flex;flex-wrap:wrap;margin:8px 0 0;border:1px solid var(--dsh-update-border,#e5e7eb);border-radius:4px;overflow:hidden;font-size:var(--dsh-update-panel-small-font-size,12.5px)}',
  '.dsh-upd-strip>div{flex:1 1 110px;min-width:0;padding:6px 10px;border-left:1px solid var(--dsh-update-border,#e5e7eb)}',
  '.dsh-upd-strip>div:first-child{border-left:0}',
  '.dsh-upd-strip-k{display:block;font-size:var(--dsh-update-panel-small-font-size,11px);letter-spacing:.14em;opacity:.7}',
  '.dsh-upd-strip-v{font-family:Consolas,Menlo,monospace;font-size:var(--dsh-update-panel-small-font-size,12.5px);word-break:break-all}',
  '.dsh-upd-chapter{margin-top:18px;padding-top:14px;border-top:1px solid var(--dsh-update-border,#e5e7eb)}',
  // 右下角独立 footer 区（#47 定案 A）：与第一章 actions 脱钩，右对齐，一次找到。
  '.dsh-upd-footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:14px;padding-top:10px;border-top:1px solid var(--dsh-update-border,#e5e7eb)}',
  '.dsh-upd-foot-note{margin-right:auto;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.7}',
  // 更新器自检（#196）：页脚里一行机读事实（品牌名 + 版本 + 层级 token），字号更小、等宽、弱化。
  '.dsh-upd-updater-note{font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.55;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}',
  '.dsh-upd-updater-id{margin-top:8px;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.55;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-upd-updater-nested{margin-top:8px;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.8;line-height:1.5;word-break:break-word}',
  '.dsh-upd-footer button{margin:0}',
  '.dsh-upd-chap-head{display:flex;align-items:baseline;gap:10px;margin-bottom:6px}',
  '.dsh-upd-chap-no{font-size:var(--dsh-update-panel-chapter-font-size,13px);font-style:italic;opacity:.6}',
  '.dsh-upd-chap-title{font-size:var(--dsh-update-panel-chapter-font-size,14px);margin:0}',
  // —— 宿主样式隔离：章节标题是裸 h3，宿主全局 h3 规则（如渐变标题字）会直接命中它，
  // 而继承来的根颜色输给任何直接命中的规则。双 class 显式钉死颜色并洗掉背景裁剪，
  // 深色宿主下即回近白正文，档案卷下跟纸墨变量走（宿主 !important 另议，见测试）。
  '.dsh-upd .dsh-upd-chap-title{color:var(--dsh-update-text,#1f2937);background:none;-webkit-background-clip:border-box;-webkit-text-fill-color:currentColor}',
  '.dsh-upd-chap-rule{flex:1;border-top:1px solid var(--dsh-update-border,#e5e7eb);transform:translateY(-3px)}',
  // 03 章标题行右端的开关（问题 3 定案：按钮形态、挪到标题行）。
  '.dsh-upd-chap-note{flex:none;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.75}',
  '.dsh-upd-chap-note button{margin:0}',
  // 更新队列两行键值（用户定案的设计）：结构两主题共用，皮肤各自收敛。
  '.dsh-upd-qrow{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;padding:6px 0;min-width:0}',
  '.dsh-upd-qrow+.dsh-upd-qrow{border-top:1px solid var(--dsh-update-border,#e5e7eb)}',
  '.dsh-upd-qdot{width:8px;height:8px;border-radius:50%;flex:none;align-self:center;background:currentColor;opacity:.5}',
  '.dsh-upd-qdot[data-tone="busy"]{background:var(--dsh-update-warn-border,#d97706);opacity:1}',
  '.dsh-upd-qdot[data-tone="you"]{background:var(--dsh-update-primary,#2563eb);opacity:1}',
  '.dsh-upd-qk{flex:none;width:5.5em;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.7}',
  '.dsh-upd-qv{font-weight:600}',
  '.dsh-upd-qn{margin-left:auto;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.7}',
  '.dsh-upd-qseq{font-family:Consolas,Menlo,monospace;font-size:var(--dsh-update-panel-small-font-size,12px);word-break:break-all}',
  '.dsh-upd-prog{height:8px;background:var(--dsh-update-border,#e5e7eb);border-radius:4px;overflow:hidden;margin:10px 0 4px}',
  '.dsh-upd-prog-bar{display:block;height:100%;background:var(--dsh-update-primary,#2563eb);transition:width .3s}',
  '.dsh-upd-progtxt{font-size:var(--dsh-update-panel-small-font-size,12.5px);opacity:.75}',
  '.dsh-upd-skipline{font-size:var(--dsh-update-panel-log-font-size,13px);margin-top:8px}',
  // 骨架微光：只在首帧 loading 出现；reduced-motion 下静止占位，不断语义。
  '.dsh-upd-skv{display:inline-block;min-width:64px;border-radius:3px;color:transparent !important;user-select:none;',
  'background:linear-gradient(90deg,var(--dsh-update-border,#e5e7eb) 25%,var(--dsh-update-bg-soft,#f3f4f6) 50%,var(--dsh-update-border,#e5e7eb) 75%);',
  'background-size:200% 100%;animation:dsh-upd-shimmer 1.2s linear infinite}',
  '@keyframes dsh-upd-shimmer{to{background-position:-200% 0}}',
  '.dsh-upd-tag{display:inline-block;border:1px dashed currentColor;border-radius:3px;padding:1px 8px;margin-right:8px;font-family:Consolas,Menlo,monospace;font-size:var(--dsh-update-panel-small-font-size,12px)}',
  '.dsh-upd-err{font-size:var(--dsh-update-panel-log-font-size,13px);margin:0 0 6px}',
  // —— 04 错误信息长行换行（#199）：日志/错误行补换行契约，与版本号/状态列同风格；纵滚区横向裁断不动 ——
  '.dsh-upd-log,.dsh-upd-err{overflow-wrap:anywhere}',
  // —— 全按钮交互反馈（#36：悬停/按下/过渡/在途忙态；浅深双主题通用写法，不碰上面的既有串）——
  '.dsh-upd button{transition:background-color .15s ease,border-color .15s ease,color .15s ease,transform .06s ease,box-shadow .15s ease}',
  // #173 v1.3：hover 必须有明显边框变化（主色边框 + 外环），不能只靠 brightness。
  '.dsh-upd button:hover:not(:disabled){border-color:var(--dsh-update-primary,#2563eb);box-shadow:0 0 0 2px var(--dsh-update-primary,#2563eb)}',
  '.dsh-upd button[data-primary="1"]:hover:not(:disabled){border-color:var(--dsh-update-focus,#2563eb);box-shadow:0 0 0 2px var(--dsh-update-primary,#2563eb)}',
  '.dsh-upd button:active:not(:disabled){transform:translateY(1px)}',
  '.dsh-upd button[aria-busy="true"]{cursor:wait;animation:dsh-upd-pulse 1s ease-in-out infinite}',
  '@keyframes dsh-upd-pulse{0%,100%{opacity:1}50%{opacity:.55}}',
  // —— 状态横幅淡入 + 日志折叠格动画（纯 CSS；重绘只发生在真变时；reduced-motion 下静止）——
  '.dsh-upd-banner{animation:dsh-upd-fadein .22s ease}',
  '@keyframes dsh-upd-fadein{from{opacity:.35;transform:translateY(2px)}}',
  '.dsh-upd-changelog-foldbox{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows .22s ease,opacity .18s ease}',
  '.dsh-upd-changelog-foldbox-inner{min-height:0;overflow:hidden}',
  '.dsh-upd-changelog-foldbox[data-open="0"]{grid-template-rows:0fr;opacity:0}',
  // 在途转圈：纯 CSS ::after，不加 DOM 节点（内核 DOM 冻结）；转的是边框缺口，不是 emoji。
  '.dsh-upd button[aria-busy="true"]::after{content:"";display:inline-block;width:11px;height:11px;margin-left:8px;vertical-align:-1px;',
  'border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:dsh-upd-spin .8s linear infinite}',
  '@keyframes dsh-upd-spin{to{transform:rotate(360deg)}}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd button{transition:none}.dsh-upd button:active:not(:disabled){transform:none}.dsh-upd button[aria-busy="true"]{animation:none}.dsh-upd-skv{animation:none}.dsh-upd-banner{animation:none}.dsh-upd-changelog-foldbox{transition:none}.dsh-upd-copy-bubble{animation:none}}',
  '@media (forced-colors: active){.dsh-upd-overlay .dsh-upd-body .dsh-upd-chap-head{background:Canvas}.dsh-upd-lastresort{border-color:CanvasText}.dsh-upd-lr-badge,.dsh-upd-lr-chap-badge{border-color:CanvasText;color:CanvasText}.dsh-upd-copy-bubble{border:1px solid CanvasText;background:Canvas;color:CanvasText}}',
  // —— 查新版布局稳定：按钮预留宽度 + 动态区最小高度 + 锚定不漂（只稳布局，不改文案语义）——
  '.dsh-upd{overflow-anchor:none}',
  '.dsh-upd-body{overflow-anchor:none}',
  '.dsh-upd-actions{display:flex;flex-wrap:wrap;align-items:center;min-height:34px}',
  '.dsh-upd-actions button:first-child{min-width:8em;text-align:center}',
  '.dsh-upd-actions button[data-primary="1"]{min-width:7em;text-align:center}',
  '.dsh-upd-actions button:first-child:not([aria-busy="true"])::after{content:"";display:inline-block;width:11px;height:11px;margin-left:8px;visibility:hidden}',
  '.dsh-upd-banner{min-height:1.2em}',
  '.dsh-upd-strip{min-height:48px}',
  // —— 查新版瞬时抖动补强：忙闲两帧同高 + 横幅不动（只追加覆盖，不改上面既有串）——
  '.dsh-upd-actions{align-content:flex-start}',
  '.dsh-upd-actions button{white-space:nowrap}',
  '.dsh-upd-actions button:first-child{min-width:10em}',
  '.dsh-upd-actions button[data-primary="1"]{min-width:9em}',
  '.dsh-upd-banner{min-height:3.4em;display:flex;flex-direction:column;justify-content:center}',
  '.dsh-upd-banner{animation:none}',
  // —— 横幅副行：色框之外的第二行补充说明（居左小字；两主题共用结构，皮肤各自收敛）——
  '.dsh-upd-banner-sub{font-size:var(--dsh-update-panel-small-font-size,12.5px);opacity:.75;margin:2px 0 8px;text-align:left}',
  // —— 横幅标题字号参数化（#103）：默认跟随正文继承，传 panelBannerTitleFontSize 即固定值 ——
  '.dsh-upd-banner>div:first-child strong{font-size:var(--dsh-update-panel-banner-title-font-size,inherit)}',
  // #99 真节点行内章：默认主题不画（Archive 串里才显示）；节点常驻 DOM（双主题内核逐字同一份）。
  '.dsh-upd-banner>div:first-child>.dsh-upd-sealmini{display:none}',
  '.dsh-upd-copy{min-height:1.75em}',
  '.dsh-upd-copy--empty{visibility:hidden}',
  '@media (prefers-color-scheme: dark){.dsh-upd{--dsh-update-text:#e5e7eb;--dsh-update-bg:#111827;--dsh-update-border:#374151;',
  '--dsh-update-button-bg:#1f2937;--dsh-update-bg-soft:#1f2937;--dsh-update-primary:#3b82f6;--dsh-update-focus:#93c5fd;',
  // 横幅深色覆盖：底色用低透明度同色系（不是浅色原值），边线提亮，保证「深底浅字」可读。
  '--dsh-update-ok-bg:rgba(16,185,129,.14);--dsh-update-ok-border:#34d399;',
  '--dsh-update-warn-bg:rgba(245,158,11,.16);--dsh-update-warn-border:#fbbf24;',
  '--dsh-update-bad-bg:rgba(239,68,68,.16);--dsh-update-bad-border:#f87171;',
  '--dsh-update-busy-bg:rgba(59,130,246,.16);--dsh-update-busy-border:#60a5fa}}',
].join('\n')

function escapeHtml(text: string): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export interface PanelRenderInput extends PanelViewInput {
  mode: UpdatePanelMode
  showOthers: boolean
  pluginId: string
  copyNotice: string | null
  /** 渲染语言（#61 单语：缺省 zh；挂载态传 currentLang，纯函数直调可显式传 en/zh）。 */
  lang?: AppLang | string | null
  /** 可选主题：不传即默认（输出与旧版一字不差）；`archive` 切档案卷。 */
  theme?: UpdatePanelTheme
  /** 主题变量覆盖：见 UpdateThemeTokens；写到面板根上，不传即无 style 属性。 */
  themeTokens?: UpdateThemeTokens
  /** 使用范围名（profile）：面板「使用范围」一栏的唯一来源，缺省显示“未知”，不猜。 */
  profileName?: string | null
  /** 宿主种类：进诊断文本；缺省显示“未知”。 */
  hostKind?: string | null
  /**
   * 在途动作（仅挂载态内部用：点下查新版/安装到回包前的那一帧，按钮置忙）。
   * 缺省即静默（输出与旧版一字不差）；只在挂载器置忙的那次 render 里传。
   */
  busyAct?: 'check' | 'install' | 'fallback' | null
  /** 失败引用（失败档案的查询键；缺省即无失败，不画卷宗）。 */
  failure?: PanelFailureRef | null
  /**
   * 合规版二次确认（#156：用户点了"装合规版"且决议出候选后，确认按钮才出现；
   * 缺省即无二次确认，只画"装合规版"。candidate 是决议点名的精确版本，按钮文案即它——
   * 用户永远先看见版本号再点确认，永不静默装旧版）。
   */
  fallbackOffer?: { candidate: string; targetVersion: string } | null
  /** 日志指引开关：false 即藏通用日志行（失败证据行不受影响）。 */
  showLogHint?: boolean
  /**
   * 本插件的日志目录（#123）：宿主经 includeEnv 回的真值，只在错误章路牌里露一行。
   * 没给（或不是字符串）= 退回「目录算式 + tail 命令模板」，路牌不指一个并不存在的值。
   */
  logDir?: string | null
  /**
   * 日志健康读数（#212）：宿主成功回包里的 logHealth，只在日志区露一行；缺省（老宿主）不出现，
   * 输出与旧版一字不差。面板不解释语义，措辞全部来自 shared/copy 的 logHealthText（单一措辞源）。
   */
  logHealth?: UpdateLogHealth | null
  /**
   * 动作面归谁：`default`（缺省）由内核画动作按钮；`none` 只画内容、不画按钮。
   * 给「调用方自己提供动作面」的场景（如批量面板的详情：动作由批量面板经自己的通道提供）。
   * 只读渲染下五章内容、进度条、「已跳过」提示一字不减，只是没有动作按钮。
   */
  actions?: 'default' | 'none'
  /**
   * 更新日志折叠（仅挂载态内部用：用户点了 02 章标题行的收起/展开）。
   * 缺省即展开（安全日志必显、可查找；只读渲染下恒展开）。
   */
  changelogCollapsed?: boolean
  /**
   * 更新器自检（#196 部署偏斜）：这块面板实际加载到的本包副本版本与层级。
   * 缺省即老输出一字不差；给了就在页脚恒显 `dsh-plugin-update@版本 (层级)`，
   * 嵌套副本另在 05 章给「先更新所属插件 / 或载体 CLI」的可执行指引。
   */
  updater?: UpdaterSelfView | null
  /**
   * 手工命令的可信来源（#177）：`frame` = 与当帧快照来自同一回包且回包带 `manual` 键；
   * `carried-over` = 失败回包沿用的旧值（fail-closed：不展示、不给复制、不高亮）；
   * `null` = 当帧确认没有命令。缺省（undefined）按 `frame` 处理，兼容纯渲染直调。
   */
  manualSource?: ManualSource | null
  /** 合规版通道是否可用（#174 判定输入之一；缺省由 `failure` 证据推导，不传即老口径）。 */
  fallbackAvailable?: boolean
  /**
   * 当前帧运行版读数是否已知（#174：`false` → 先判「可重查」而不是「无救」；
   * 缺省由 snapshot.runningVersion 推导，纯渲染要覆盖时显式给）。
   */
  runningVersionKnown?: boolean | null
  /** 复制成功气泡（#173 v1.3）：坐标由点击时的 getBoundingClientRect 算出；缺省即不画。 */
  copyBubble?: { text: string; left: number; top: number } | null
}

/** 章节骨架（照原型 archive.html:218-245 的 01–05 编号顺序；#62 入字典按 lang 单语）。 */
const CHAPTER_KEYS = [
  'panel.chapter.check',
  'panel.chapter.changelog',
  'panel.chapter.queue',
  'panel.chapter.error',
  'panel.chapter.manual',
] as const
function chapterTitle(index: 1 | 2 | 3 | 4 | 5, lang?: AppLang | string | null): string {
  const l = normalizeLangTag(lang ?? 'zh')
  return copyText(CHAPTER_KEYS[index - 1] as BilingualKey, l)
}

/**
 * 合规版双按钮门（#156，纯函数）：拦的正是更新目标本身才给"装合规版/等新版"。
 * 输入是失败引用里的机读结论 + 失败那次的目标版本；返回被拦住的版本号（无则 null，不画按钮）。
 * 归因只认 target（B 类 other-package/unknown 一律 null：降级装没被拦的包躲不掉别人的窗口）。
 */
export function fallbackBlockedVersionOf(
  failure: Pick<PanelFailureRef, 'targetVersion' | 'causeKind' | 'causePackage' | 'causeTarget'> | null | undefined,
  pluginId: unknown,
): string | null {
  try {
    return vetFailureRef(failure, pluginId)
  } catch {
    return null
  }
}

function vetFailureRef(
  failure: Pick<PanelFailureRef, 'targetVersion' | 'causeKind' | 'causePackage' | 'causeTarget'> | null | undefined,
  pluginId: unknown,
): string | null {
  const kind = typeof failure?.causeKind === 'string' ? failure.causeKind.trim() : ''
  if (!kind || !(CAUSE_KINDS as readonly string[]).includes(kind)) return null
  const spec = typeof failure?.causePackage === 'string' ? failure.causePackage.trim() : ''
  if (!spec) return null
  // 归因目标优先用机读包名（命名空间正确），缺省才退回插件标识——对不上即无按钮，不硬认。
  const target = typeof failure?.causeTarget === 'string' && failure.causeTarget.trim()
    ? failure.causeTarget.trim()
    : typeof pluginId === 'string' && pluginId.trim() ? pluginId.trim() : ''
  if (!target) return null
  if (blameCausePackage(spec, target) !== 'target') return null
  const direct = typeof failure?.targetVersion === 'string' ? failure.targetVersion.trim() : ''
  if (direct) return direct
  const at = spec.lastIndexOf('@')
  const ver = at > 0 ? spec.slice(at + 1).trim() : ''
  return ver || null
}

/**
 * 锁存证据 → 机读结论（#156，纯函数）：翻译官重认一次锁存里的失败原文，
 * 给出渲染门与电话入参要的全部事实；认不出即 null（调用方走通用老路）。
 * 窗口优先用报文自述分钟数，否则用门限反推（cutoff - published），都没有即 null——
 * 永不硬编码策略时长；归因非 target 即 null（与渲染门同口径）。
 */
export function fallbackCauseFromDetail(detail: unknown, errorCode: unknown, pluginId: unknown): {
  kind: string
  packageName: string
  targetVersion: string
  windowMs: number | null
  /** 窗口出处（报文自述分钟数即 message，门限反推即 unknown——只回传，不参与决议）。 */
  windowSource: 'message' | 'unknown'
  publishedAtMs: number | null
} | null {
  try {
    const facts = interpretInstallCause({
      errorCode: typeof errorCode === 'string' && errorCode ? errorCode : 'install-failed',
      detail,
      targetPackageName: typeof pluginId === 'string' ? pluginId : undefined,
    })
    if (!facts || facts.kind !== 'minimum-release-age' || facts.blame !== 'target') return null
    const targetVersion = typeof facts.packageVersion === 'string' && facts.packageVersion.trim()
      ? facts.packageVersion.trim()
      : null
    if (!targetVersion) return null
    let windowMs: number | null = null
    let windowSource: 'message' | 'unknown' = 'unknown'
    if (typeof facts.windowMinutes === 'number' && Number.isFinite(facts.windowMinutes) && facts.windowMinutes > 0) {
      windowMs = facts.windowMinutes * 60_000
      windowSource = 'message'
    } else if (
      typeof facts.cutoffMs === 'number' && typeof facts.publishedAtMs === 'number'
      && facts.cutoffMs > facts.publishedAtMs
    ) {
      windowMs = facts.cutoffMs - facts.publishedAtMs
    }
    return {
      kind: facts.kind,
      packageName: facts.packageName,
      targetVersion,
      windowMs,
      windowSource,
      publishedAtMs: typeof facts.publishedAtMs === 'number' ? facts.publishedAtMs : null,
    }
  } catch {
    return null
  }
}

/**
 * 机读诊断 → 兜底结论（#156 第四轮，纯函数，三个入口共用同一支）。
 *
 * 为什么必须有这一支：安装是异步的。年龄门拦在**安装那一刻**，回包照旧 ok:true，真正的失败
 * 落在之后的快照任务里，而任务里只剩「失败码 + 原文」。原文要认出因必须知道**包名**，可面板手里
 * 只有**插件标识**；真宿主（dsh-life-pack）给的标识是 `life-<key>` 这类派生值，与 npm 包名不同
 * ——于是「装合规版」在真机上永远说不出因（fail-closed 成一枚死按钮）。
 * 宿主已按同一套 buildDiag 把目标包名补回 diag（host.ts 的 failedJobDiagOf），这里就按机读格认，
 * 不再拿标识撞运气：包名与归因来自宿主事实，时间格仍从原文取（窗口/发布时间只在原文里）。
 * 原文认不出也照样回身份结论（窗口交决议侧反推）——只要 diag 说得清「拦的是这个包」。
 */
export function fallbackCauseFromDiag(
  diag: unknown,
  detail: unknown,
  errorCode: unknown,
  preferredTargetVersion?: unknown,
): {
  kind: string
  /** 诊断里的包规格原样（`pkg@0.4.2`）。 */
  spec: string
  /** 诊断里的目标包名（宿主事实，归因就按它判）。 */
  target: string
  /** 剥掉版本的包名（渲染/日志用）。 */
  packageName: string
  targetVersion: string
  windowMs: number | null
  windowSource: 'message' | 'unknown'
  publishedAtMs: number | null
} | null {
  try {
    const d = diag && typeof diag === 'object' && !Array.isArray(diag) ? (diag as Record<string, unknown>) : null
    if (!d) return null
    const dKind = typeof d['causeKind'] === 'string' ? d['causeKind'].trim() : ''
    const dSpec = typeof d['causePackage'] === 'string' ? d['causePackage'].trim() : ''
    const dTarget = typeof d['targetPackageName'] === 'string' ? d['targetPackageName'].trim() : ''
    if (!dKind || !(CAUSE_KINDS as readonly string[]).includes(dKind) || !dSpec || !dTarget) return null
    if (blameCausePackage(dSpec, dTarget) !== 'target') return null
    const timed = fallbackCauseFromDetail(detail, errorCode, dTarget)
    const preferred = typeof preferredTargetVersion === 'string' ? preferredTargetVersion.trim() : ''
    const at = dSpec.lastIndexOf('@')
    const specVer = at > 0 ? dSpec.slice(at + 1).trim() : ''
    const targetVersion = preferred || timed?.targetVersion || specVer
    if (!targetVersion) return null
    return {
      kind: dKind,
      spec: dSpec,
      target: dTarget,
      packageName: at > 0 && dSpec.slice(0, at).trim() ? dSpec.slice(0, at).trim() : dTarget,
      targetVersion,
      windowMs: timed?.windowMs ?? null,
      windowSource: timed?.windowSource ?? 'unknown',
      publishedAtMs: timed?.publishedAtMs ?? null,
    }
  } catch {
    return null
  }
}

function chapterOf(index: 1 | 2 | 3 | 4 | 5, inner: string, note = '', lang?: AppLang | string | null): string {
  const no = String(index).padStart(2, '0')
  const l = normalizeLangTag(lang ?? 'zh')
  const title = chapterTitle(index, l)
  return (
    `<section class="dsh-upd-chapter" data-chapter="${no}">` +
    `<div class="dsh-upd-chap-head"><span class="dsh-upd-chap-no">${no}</span>` +
    `<h3 class="dsh-upd-chap-title">${escapeHtml(title)}</h3><span class="dsh-upd-chap-rule"></span>${note}</div>` +
    `${inner}</section>`
  )
}

/** 首帧骨架：快照没到之前占住版本条的位置，纯 CSS 微光（aria-hidden，不进语义；#62 跟随 lang）。 */
function skeletonStrip(loading: boolean, lang?: AppLang | string | null): string {
  if (!loading) return ''
  const l = normalizeLangTag(lang ?? 'zh')
  const cell = (k: string): string =>
    `<div><span class="dsh-upd-strip-k">${escapeHtml(k)}</span>` +
    `<span class="dsh-upd-strip-v dsh-upd-skv" aria-hidden="true">…</span></div>`
  return `<div class="dsh-upd-strip" aria-hidden="true">` + cell(copyText('panel.strip.running', l)) + cell(copyText('panel.strip.installed', l)) + cell(copyText('panel.strip.latest', l)) + `</div>`
}

/** 版本条三格（照原型 :216 `.strip`：运行 / 磁盘 / 远端；#62 跟随 lang，未知走字典）。 */
function versionStrip(snapshot: UpdateSnapshot | null, lang?: AppLang | string | null): string {
  const l = normalizeLangTag(lang ?? 'zh')
  const unknown = copyText('panel.meta.unknown', l)
  const cell = (k: string, v: string | null): string =>
    `<div><span class="dsh-upd-strip-k">${escapeHtml(k)}</span><span class="dsh-upd-strip-v">${escapeHtml(v ?? unknown)}</span></div>`
  if (!snapshot) return ''
  return (
    `<div class="dsh-upd-strip">` +
    cell(copyText('panel.strip.running', l), snapshot.runningVersion) +
    // 磁盘格是单插件面板的版本槽状态词：缺席不说「未知」，说「未安装」（#134/US8）。
    cell(copyText('panel.strip.installed', l), snapshot.installed === false ? copyText('panel.banner.not-installed', l) : snapshot.installedVersion) +
    cell(copyText('panel.strip.latest', l), snapshot.latestVersion) +
    `</div>`
  )
}

/** 安装进度条（照原型 :221-222）：只在 installing / verifying 时出现，纯展示，不参与门控（#62 跟随 lang）。 */
function progressBar(snapshot: UpdateSnapshot | null, lang?: AppLang | string | null): string {
  const job = snapshot?.job
  if (!job) return ''
  const state = String(job.state)
  if (state !== 'installing' && state !== 'verifying') return ''
  const l = normalizeLangTag(lang ?? 'zh')
  const width = state === 'installing' ? 60 : 90
  const text = state === 'installing' ? copyText('panel.progress.installing', l) : copyText('panel.progress.verifying', l)
  return (
    `<div class="dsh-upd-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width}">` +
    `<i class="dsh-upd-prog-bar" style="width:${width}%"></i></div>` +
    `<div class="dsh-upd-progtxt">${escapeHtml(text)}</div>`
  )
}

/**
 * 更新器自检身份（#196 部署偏斜）：`dsh-plugin-update@版本 (层级)`。
 * 这是机读事实（品牌名 + 版本 + 层级 token），不进字典、不翻译；缺版本即不画（不编造）。
 */
function updaterIdentityOf(input: PanelRenderInput): string | null {
  const parts = updaterPartsOf((input as { updater?: UpdaterSelfView | null }).updater)
  return parts ? `dsh-plugin-update@${parts.version} (${parts.level})` : null
}

/** 从 includeEnv 回包两格取自检事实（#196）；本包版本读不到就 null（不编造）。 */
export function updaterSelfOfEnv(env: Record<string, unknown>): UpdaterSelfView | null {
  const uv = env['updaterVersion']
  const ul = env['updaterCopyLevel']
  if (typeof uv !== 'string' || !uv.trim()) return null
  return { version: uv.trim(), level: typeof ul === 'string' && ul.trim() ? ul.trim() : 'unknown' }
}

/**
 * 嵌套副本的载体 CLI 升级指引（#196）：把更新器装到使用范围级，让共用那一份的其他插件先换新。
 * 缺使用范围名就是假命令 ⇒ null（宁可只说明为什么升级不生效，也不画「或运行：」空着）。
 */
function selfUpgradeCommandOf(profileName: string | null | undefined): string | null {
  const profile = typeof profileName === 'string' ? profileName.trim() : ''
  if (!profile) return null
  return `dsh plugin --profile ${profile} add --save-exact dsh-plugin-update@latest`
}

/**
 * #177：渲染输入里的 manualSource 归一。
 * - `undefined` = 纯渲染直调（老调用方没这个概念）：按 `frame` 处理，保持既有输出；
 * - `null` = 当帧确认没有命令；
 * - `carried-over` = 失败回包沿用的旧值（不可信）。
 */
function manualSourceOfRender(input: { manualSource?: ManualSource | null }): ManualSource | null {
  const value = input.manualSource
  if (value === 'carried-over') return 'carried-over'
  if (value === null) return null
  return 'frame'
}

/** 命令是否可信（当帧且非空）——展示/复制/高亮三件事共用这一个判据。 */
function manualTrustedOf(manual: string | null, source: ManualSource | null): boolean {
  return typeof manual === 'string' && manual.trim() !== '' && source === 'frame'
}

/** 手绘 alert 图标（八角停形 + 惊叹号；#174：统一 16×16 viewBox，inline SVG，禁 emoji，不引外部图标）。 */
const LAST_RESORT_ALERT_SVG =
  '<svg class="dsh-upd-lr-ico" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">' +
  '<path d="M8 1.8 12.4 3.6 14.2 8 12.4 12.4 8 14.2 3.6 12.4 1.8 8 3.6 3.6Z"/><path d="M8 5.2v4"/>' +
  '<circle cx="8" cy="11.6" r="0.85" fill="currentColor" stroke="none"/></svg>'

/** 手绘 copy 图标（双页，16×16 viewBox）。复制按钮前后一字不变（v1.3：成功不改按钮文案/图标）。 */
const COPY_ICON_SVG =
  '<svg class="dsh-upd-copy-ico" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">' +
  '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1"/>' +
  '<path d="M10.5 5.5V4.2a1 1 0 0 0-1-1H4.2a1 1 0 0 0-1 1v5.3a1 1 0 0 0 1 1h1.3"/></svg>'

/**
 * A′ 最后手段条（#174）：左红轨 + alert SVG + 「最后手段」徽标 + 状态短语 + 归因句 + 紧凑主按钮。
 * 只有 `kind === 'last-resort'` 才输出；其它三态返回空串（不画空高亮）。按钮由调用方决定：
 * 有动作面的渲染点给 copy-manual，只读渲染（批量详情）不给按钮，沿用详情自己的动作行。
 */
export function lastResortBarHTML(opts: {
  verdict: LastResortVerdict | null
  lang: AppLang | string | null
  buttonHtml?: string
}): string {
  const verdict = opts.verdict
  if (!verdict || verdict.kind !== 'last-resort') return ''
  const l = normalizeLangTag(opts.lang ?? 'zh')
  const badge = escapeHtml(copyText('panel.lastresort.badge', l))
  return (
    '<div class="dsh-upd-lastresort" data-last-resort="last-resort">' +
    LAST_RESORT_ALERT_SVG +
    '<div class="dsh-upd-lr-main">' +
    '<div class="dsh-upd-lr-line"><span class="dsh-upd-lr-badge">' +
    badge +
    '</span><strong class="dsh-upd-lr-status">' +
    escapeHtml(copyText('panel.lastresort.status', l)) +
    '</strong></div>' +
    '<div class="dsh-upd-lr-reason">' + escapeHtml(copyText('panel.lastresort.reason', l)) + '</div>' +
    '</div>' +
    (opts.buttonHtml ?? '') +
    '</div>'
  )
}

/** 最后手段条里的紧凑主按钮（#174 A′：按钮在主位；文案/图标在复制前后不变，见 v1.3）。 */
export function lastResortCopyButtonHTML(lang: AppLang | string | null): string {
  const l = normalizeLangTag(lang ?? 'zh')
  return (
    '<button type="button" class="dsh-upd-lr-go primary" data-primary="1" data-action="copy-manual" data-copy-anchor="1" title="' +
    escapeHtml(copyText('panel.lastresort.copy', l)) +
    '">' + COPY_ICON_SVG + escapeHtml(copyText('panel.lastresort.copy', l)) + '</button>'
  )
}

/** 复制成功气泡（v1.3）：fixed 定位、role=status，约 1.4s 由挂载侧撤掉。 */
export function copyBubbleHTML(bubble: { text: string; left: number; top: number } | null | undefined): string {
  if (!bubble) return ''
  const left = Number.isFinite(bubble.left) ? Math.round(bubble.left) : 0
  const top = Number.isFinite(bubble.top) ? Math.round(bubble.top) : 0
  return (
    '<span class="dsh-upd-copy-bubble" role="status" style="position:fixed;left:' + left + 'px;top:' + top + 'px">' +
    escapeHtml(bubble.text) + '</span>'
  )
}

/**
 * #213：宿主判定的「为什么没有说明」→ 空白分支的话术。只认这四档（各自说清「不是什么」）；
 * `ok` 与 `cache-hit` 不入表：前者本就有内容要渲染，后者只是取数方式位，文案保持既有。
 */
const CHANGELOG_STATUS_KEYS: Partial<Record<ChangelogStatus, BilingualKey>> = {
  empty: 'panel.changelog.status.empty',
  missing: 'panel.changelog.status.missing',
  'fetch-failed': 'panel.changelog.status.fetch-failed',
  'parse-degraded': 'panel.changelog.status.parse-degraded',
}

/** 分档话术键（认不出/`ok`/`cache-hit` → null，即保持既有文案一字不动）。 */
function changelogStatusCopyKey(status: ChangelogStatus | null | undefined): BilingualKey | null {
  if (!status) return null
  return CHANGELOG_STATUS_KEYS[status] ?? null
}

/** 内核 HTML（双形态行为等价的根：同一视图产出同一内核，只换外层；#62 按 lang 单语，缺省 zh 零回归）。 */
export function renderUpdatePanelKernel(input: PanelRenderInput, view: PanelView, lang?: AppLang | string | null): string {
  const { snapshot, manual, queue, mode, showOthers, pluginId, copyNotice } = input
  const l = normalizeLangTag(lang ?? (input as { lang?: unknown }).lang ?? 'zh')
  const changelogMarkdown =
    (input as { changelogMarkdown?: unknown }).changelogMarkdown ?? null
  // #213：宿主判定的日志分档（空文件 / 包里没有这个文件 / 取数失败 / 有文无结构）。
  // 认不出的值（老宿主、手搓回包、未来野值）一律当没有——文案与旧版一字不差。
  const rawChangelogStatus = (input as { changelogStatus?: unknown }).changelogStatus
  const changelogStatusValue = isChangelogStatus(rawChangelogStatus) ? rawChangelogStatus : null
  const changelogStatusKey = changelogStatusValue === null
    ? null
    : changelogStatusCopyKey(changelogStatusValue)
  const profileName =
    typeof (input as { profileName?: unknown }).profileName === 'string' && (input as { profileName: string }).profileName
      ? (input as { profileName: string }).profileName
      : null
  const b = view.banner
  const seal = view.seal
  const parts: string[] = []
  // #174：最后手段判定只算一次（纯函数是唯一真源，三处渲染点共用；渲染器不各自推导）。
  // manualSource 缺省按 frame（见 manualSourceOfRender）；只有 last-resort 这一档才落高亮。
  const manualSource = manualSourceOfRender(input)
  const manualTrusted = manualTrustedOf(manual, manualSource)
  // #174：失败码优先取 errorKind（与 viewModel 同口径；lastError 仅兜底），否则实际码会被上一帧的码盖住。
  const lastResortCode =
    (typeof (input as { errorKind?: unknown }).errorKind === 'string' && (input as { errorKind: string }).errorKind.trim()
      ? (input as { errorKind: string }).errorKind.trim()
      : '') ||
    (typeof (input as { lastError?: unknown }).lastError === 'string' ? (input as { lastError: string }).lastError.trim() : '')
  const lastResort = lastResortVerdictOf({
    code: lastResortCode || null,
    blockedReason: snapshot ? snapshot.blockedReason : null,
    manual,
    manualSource,
    // 合规版救援证据只认 #156 的正式渲染门（与 01 章双按钮同一判据），不凭 cause 字段猜。
    fallbackAvailable: input.fallbackAvailable === true || fallbackBlockedVersionOf(input.failure, pluginId) !== null,
    runningVersionKnown:
      typeof input.runningVersionKnown === 'boolean'
        ? input.runningVersionKnown
        : snapshot
          ? snapshot.runningVersion !== null
          : null,
    // #174：待重启救援按「在册」分叉（未登记 → 在宿主里先选中，重启也不会加载）。
    registered: snapshot ? snapshot.registered ?? null : null,
  })
  // 动作面开关要在横幅之前算：最后手段条的紧凑主按钮与 01 章按钮同权，只读渲染（批量详情）不给。
  const showActions = input.actions !== 'none'
  // 卷宗抬头（原型 :195-203 的刊头；主题切换按钮按用户口径去掉——那排按钮不重要）。
  // 两个主题共用同一份内核 HTML：默认（最小）主题由 CSS 不显示，Archive 档案卷才画。
  parts.push(
    '<div class="dsh-upd-masthead"><span class="dsh-upd-masthead-kicker">' + escapeHtml(copyText('panel.masthead.kicker', l)) + '</span>' +
      '<span class="dsh-upd-masthead-title">' + escapeHtml(copyText('panel.masthead.title', l)) + ' <i>' + escapeHtml(copyText('panel.masthead.volume', l)) + '</i></span></div>',
  )
  // 档案头（原型 :208-211 `.filehead`）：插件名 + 使用范围 + profile 牌。
  // 「使用范围」这一栏是更新落点的展示面：web / desktop 各装一份，装错范围是严重故障，
  // 所以这里宁可显示「未知」也不猜。
  parts.push(
    `<div class="dsh-upd-head"><span class="dsh-upd-name">${escapeHtml(pluginId)}</span>` +
      `<span class="dsh-upd-meta">${escapeHtml(copyText('panel.meta.label', l))} <b>${escapeHtml(profileName ?? copyText('panel.meta.unknown', l))}</b>` +
      `<span class="dsh-upd-proftag">profile</span></span></div>`,
  )
  // 横幅：状态行 / 待重启横幅（原型 :213-215 restartSlot + 状态行）。
  // 小印章是首行内的真实行内节点（#99；原型 :215 `.sealmini + 文字` 同结构）；待重启档不挂印章——
  // 那一档的标记是手绘 SVG（原型 :446 只有 SVG）。章对读屏隐藏（标题文本已含语义），默认主题由 CSS 隐藏。
  // #174 A′：失败 / 待重启 / 受阻帧的失败块第一行插最后手段条（只在判定为 last-resort 时真有内容，
  // 其余三态返回空串，不留空壳）。放在横幅之前 = 失败块第一行，也避开横幅的 role=status 活区。
  const lastResortBarHtml =
    b.kind === 'failed' || b.kind === 'restart' || b.kind === 'blocked'
      ? lastResortBarHTML({
          verdict: lastResort,
          lang: l,
          buttonHtml: showActions ? lastResortCopyButtonHTML(l) : '',
        })
      : ''
  if (lastResortBarHtml) parts.push(lastResortBarHtml)
  parts.push(`<div class="dsh-upd-banner" data-kind="${b.kind}" data-mini="${escapeHtml(seal.mini)}" role="status" aria-live="polite">`)
  parts.push(`<div>${b.kind === 'restart' ? '' : `<span class="dsh-upd-sealmini" aria-hidden="true">${escapeHtml(seal.mini)}</span>`}<strong>${escapeHtml(b.title)}</strong></div>`)
  parts.push('</div>')
  // 横幅副行（行动句）：放在色框之外、框下第二行居左（原型口径：状态行是裸文本，色框只装标题）。
  // 色框（绿/蓝/黄）只装标题 strong，副行是框外的补充说明，不进 role=status 的框体。
  if (b.action) parts.push(`<div class="dsh-upd-banner-sub">${escapeHtml(b.action)}</div>`)
  // 版本条（原型 :216 `.strip`）：运行 / 磁盘 / 远端三格。
  // 首帧无快照：画骨架占位（纯 CSS 微光，不加语义节点；快照一到即换真格）。
  parts.push(snapshot ? versionStrip(snapshot, l) : skeletonStrip(view.banner.kind === 'loading', l))
  // —— 01 检查与安装（原型 :218-224）：动作 + 进度条 + 跳过行 ——
  // 只读渲染（`actions: 'none'`）：调用方自己提供动作面时用（批量面板的详情就是这种）。
  // 五章内容、进度条、「已跳过」提示照画，唯独不画动作按钮——免得出现「可点却没人接」的死按钮。
  // showActions 已在横幅之前算过（最后手段条的按钮要先知道动作面开不开）。
  const actions: string[] = []
  if (showActions) {
  const busyAct = (input as { busyAct?: unknown }).busyAct
  const checkBusy = busyAct === 'check'
  const installBusy = busyAct === 'install'
  const fallbackBusy = busyAct === 'fallback'
  // #87 宏忙守卫（与批量 macroBusy 同口径）：快照 installing/verifying 或任一本地电话在飞，两键一起置灰。只渲染不推导：不改电话形状与快照字段，不新增文案键。
  // #156：合规版决议在途也算宏忙——查/装按钮一起置灰，防决议结论（第二槽）被并发检查洗掉。
  const jobState = (snapshot as unknown as { job?: { state?: unknown } } | null)?.job?.state
  const snapshotBusy = jobState === 'installing' || jobState === 'verifying'
  const macroBusy = busyAct === 'check' || busyAct === 'install' || fallbackBusy || snapshotBusy
  // #156 场景二：检查页预判与视图模型同一纯门（只信当下快照）——主安装按钮已按它置灰，
  // 这里只补按钮与悬停说明。决议凭证只认对当前这一版的：旧版决议不跨版复用。
  const gatePrejudge = b.kind === 'update' ? checkPrejudgeOfView(
    (input as { checkPrejudge?: CheckPrejudge | null }).checkPrejudge ?? null,
    snapshot,
  ) : null
  const gateOfferRaw = (input as { fallbackOffer?: { candidate?: unknown; targetVersion?: unknown } | null }).fallbackOffer ?? null
  const gateCandidate =
    gatePrejudge && typeof gateOfferRaw?.candidate === 'string' && gateOfferRaw.candidate.trim()
    && typeof gateOfferRaw?.targetVersion === 'string' && gateOfferRaw.targetVersion.trim() === gatePrejudge.targetVersion
      ? gateOfferRaw.candidate.trim()
      : null
  actions.push('<div class="dsh-upd-actions">')
  // 在途那一帧：按钮禁用 + 文案切换 + aria-busy（静默时输出与旧版一字不差）。
  // title 是零成本原生 tooltip：不引入浮层组件，只给悬停一句话说明。
  // 宏守卫只加 disabled，不换文案不加键：忙的不是本键时沿用闲态文案，仅置灰防并发。
  actions.push(
    (checkBusy
      ? `<button type="button" data-action="check" disabled aria-busy="true" title="${escapeHtml(copyText('panel.action.checking-busy-title', l))}">${escapeHtml(copyText('panel.action.checking-busy', l))}</button>`
      : `<button type="button" data-action="check" title="${escapeHtml(copyText('panel.action.check-title', l))}"${macroBusy ? ' disabled' : ''}>${escapeHtml(copyText('panel.action.check', l))}</button>`) +
      (installBusy
        ? `<button type="button" data-action="install" data-primary="1" disabled aria-busy="true" title="${escapeHtml(copyText('panel.action.installing-busy-title', l))}">${escapeHtml(copyText('panel.action.installing-busy', l))}</button>`
        : `<button type="button" data-action="install" data-primary="1" title="${escapeHtml(gatePrejudge ? copyText('panel.action.install-gated-title', l, { latest: snapshot?.latestVersion ?? '', unlock: formatUnlockAt(gatePrejudge.unlockAtMs, l) ?? '' }) : copyText('panel.action.install-title', l))}"${macroBusy || !view.installEnabled ? ' disabled' : ''}>${escapeHtml(view.installLabel)}</button>`),
  )
  if (snapshot?.latestVersion && !view.skippedLatest && view.banner.kind === 'update') {
    actions.push(`<button type="button" data-action="skip" title="${escapeHtml(copyText('panel.action.skip-title', l))}">${escapeHtml(copyText('panel.action.skip', l))}</button>`)
  }
  // #156 场景二：检查页预判生效 → 给［装合规版］（决议出候选后变"确认装 X"，
  // 与失败页同一对按钮的复刻；独缺"等新版"——检查页本就是等的地方，不需要再等一次）。
  if (gatePrejudge) {
    actions.push(
      gateCandidate
        ? `<button type="button" data-action="install-fallback-confirm" data-primary="1" title="${escapeHtml(copyText('panel.action.install-fallback-confirm-title', l))}"${macroBusy || fallbackBusy ? ' disabled' : ''}>${escapeHtml(copyText('panel.action.install-fallback-confirm', l, { version: gateCandidate }))}</button>`
        : fallbackBusy
          ? `<button type="button" data-action="install-fallback" data-primary="1" disabled aria-busy="true" title="${escapeHtml(copyText('panel.action.install-fallback-title', l))}">${escapeHtml(copyText('panel.action.install-fallback', l))}</button>`
          : `<button type="button" data-action="install-fallback" data-primary="1" title="${escapeHtml(copyText('panel.action.install-fallback-title', l))}"${macroBusy ? ' disabled' : ''}>${escapeHtml(copyText('panel.action.install-fallback', l))}</button>`,
    )
  }
  if (view.showReset && snapshot?.latestVersion) {
    actions.push(`<button type="button" data-action="reset-skip" title="${escapeHtml(copyText('panel.action.unskip-title', l))}">${escapeHtml(copyText('panel.action.unskip', l, { version: snapshot.latestVersion }))}</button>`)
  }
  // 最后手段条已经给了同一颗主按钮时，01 章不再画第二颗一模一样的「复制手工命令」。
  if (view.showManual && manualTrusted && !lastResortBarHtml) {
    actions.push(`<button type="button" data-action="copy-manual" title="${escapeHtml(copyText('panel.action.copy-manual-title', l))}">${escapeHtml(copyText('panel.action.copy-manual', l))}</button>`)
  }
  // 原型的待重启横幅右侧有个主动作「重启宿主」（archive.html:448）。
  // 宿主没有「重启自己」的电话，所以这里只做入口：调用方给了 onRestartRequested 就交给它，
  // 没给就如实提示「请手动重启」——不假装能重启。
  if (b.kind === 'restart') {
    actions.push(`<button type="button" data-action="restart-hint" title="${escapeHtml(copyText('panel.action.restart-host-title', l))}">${escapeHtml(copyText('panel.action.restart-host', l))}</button>`)
  }
  // #156：拦的正是更新目标本身，失败行给双按钮［装合规版］［等新版］替代"已知晓"——
  // B 类（拦的是别家包）与认不出的失败走通用老路，一个字不动。二次确认态（fallbackOffer）
  // 把"装合规版"换成点名版本的"确认装 X"：用户先看见版本号再点确认，永不静默装旧版。
  const failureForFallback = (input as { failure?: PanelFailureRef | null }).failure ?? null
  const fallbackBlocked = b.kind === 'failed' ? fallbackBlockedVersionOf(failureForFallback, pluginId) : null
  const fallbackOfferRaw = (input as { fallbackOffer?: { candidate?: unknown; targetVersion?: unknown } | null }).fallbackOffer ?? null
  const fallbackCandidate =
    fallbackBlocked && typeof fallbackOfferRaw?.candidate === 'string' && fallbackOfferRaw.candidate.trim()
      ? fallbackOfferRaw.candidate.trim()
      : null
  if (fallbackBlocked) {
    actions.push(
      fallbackCandidate
        ? `<button type="button" data-action="install-fallback-confirm" data-primary="1" title="${escapeHtml(copyText('panel.action.install-fallback-confirm-title', l))}"${macroBusy || fallbackBusy ? ' disabled' : ''}>${escapeHtml(copyText('panel.action.install-fallback-confirm', l, { version: fallbackCandidate }))}</button>`
        : fallbackBusy
          ? `<button type="button" data-action="install-fallback" data-primary="1" disabled aria-busy="true" title="${escapeHtml(copyText('panel.action.install-fallback-title', l))}">${escapeHtml(copyText('panel.action.install-fallback', l))}</button>`
          : `<button type="button" data-action="install-fallback" data-primary="1" title="${escapeHtml(copyText('panel.action.install-fallback-title', l))}"${macroBusy ? ' disabled' : ''}>${escapeHtml(copyText('panel.action.install-fallback', l))}</button>`,
    )
    actions.push(`<button type="button" data-action="wait-latest" title="${escapeHtml(copyText('panel.action.wait-latest-title', l))}"${macroBusy || fallbackBusy ? ' disabled' : ''}>${escapeHtml(copyText('panel.action.wait-latest', l))}</button>`)
  } else if (b.kind === 'failed') {
    actions.push(`<button type="button" data-action="dismiss-failure" title="${escapeHtml(copyText('panel.action.dismiss-title', l))}">${escapeHtml(copyText('panel.action.dismiss', l))}</button>`)
  }
  // #153-B：复制诊断在失败时常驻——无快照但有失败横幅/失败引用时也给按钮，
  // 修“失败旁没有复制诊断”。首帧 loading（无快照、无失败）仍不给，不多一个按钮。
  const failureRef = (input as { failure?: unknown }).failure
  if (snapshot || b.kind === 'failed' || !!failureRef) {
    actions.push(`<button type="button" data-action="copy-diag" title="${escapeHtml(copyText('panel.action.copy-diag-title', l))}">${escapeHtml(copyText('panel.action.copy-diag', l))}</button>`)
  }
  // 关闭不住第一章（#47 定案 A）：dialog 的关闭住右下角独立 footer 区（见内核末尾）；
  // embedded 无面板自带关闭（宿主框架自带关），与 requestDialogClose 只认 dialog 同口径。
  actions.push('</div>')
  }
  actions.push(progressBar(snapshot, l))
  if (view.skippedLatest && snapshot?.latestVersion) {
    actions.push(
      `<div class="dsh-upd-skipline"><span class="dsh-upd-tag">${escapeHtml(copyText('panel.skip.line-tag', l, { version: snapshot.latestVersion }))}</span>` +
        `${escapeHtml(copyText('panel.skip.line-note', l))}</div>`,
    )
  }
  // 章节滚动区：01–05 先收进同一组，再包一层可滚动体；头尾留在外面固定。
  const chapters: string[] = []
  chapters.push(chapterOf(1, actions.join(''), '', l))
  // —— 02 更新日志（原型 :226-229）：章节恒在；缺日志给中性提示，不挡安装、不改门控 ——
  // 折叠只影响展示：默认展开（安全日志必显、可查找）；开关在标题行右端，与 03 章开关同一位置语言。
  {
    let inner = ''
    let hasLog = false
    // #213：分档话术只在「本来就没有内容可渲染」时才顶替旧中性句（见下面两条分支与兜底）。
    const statusCopyText = changelogStatusKey === null ? '' : copyText(changelogStatusKey, l)
    if (snapshot && snapshot.latestVersion) {
      try {
        const mdText = typeof changelogMarkdown === 'string' ? changelogMarkdown : ''
        const report = parseChangelogReport(mdText)
        const entries = report.entries
        const ranged = changelogForUpdate(
          entries,
          snapshot.runningVersion,
          snapshot.latestVersion,
          snapshot.installedVersion,
        )
        // 有文本但一个版本节都读不出：诚实说读不出来，不说"未提供"。
        // 空文本仍走"未提供"；有解析节但区间外仍走旧中性（区间外是另一回事，不在此改）。
        if (ranged.length === 0 && mdText.trim() && entries.length === 0) {
          // #213：宿主判了 parse-degraded（有内容、没结构）就说「不是没有说明」；其余分档不在这插话。
          const degradedText = changelogStatusValue === 'parse-degraded' ? statusCopyText : ''
          inner = `<div class="dsh-upd-changelog-wrap"><div class="dsh-upd-changelog-neutral">${escapeHtml(degradedText || copyText('panel.changelog.unavailable', l))}</div>${truncationNoteHTML(report.truncation, l)}</div>`
          hasLog = false
        } else if (!mdText.trim() && statusCopyText) {
          // #213：文本为空但成因不同（空文件 / 包里没有 / 没取到）——空白分支改说实话，
          // 不再一律「未提供」；没有分档（老宿主/手搓回包）仍走下面的老分支，输出一字不差。
          inner = `<div class="dsh-upd-changelog-wrap"><div class="dsh-upd-changelog-neutral">${escapeHtml(statusCopyText)}</div></div>`
          hasLog = false
        } else {
          const changelogHTML = renderChangelogHTML(ranged, { lang: l, truncated: report.truncation })
          // 缺席时日志区间的左端不许写注入的假版号（#134/US19）：写人话状态词；运行版未知同样写「未知」（#182）。
          const fromText =
            snapshot.installed === false
              ? copyText('panel.banner.not-installed', l)
              : snapshot.runningVersion ?? copyText('panel.meta.unknown', l)
          const toText = String(snapshot.latestVersion ?? '')
          const rangeTitle =
            fromText && toText ? copyText('panel.changelog.heading-range', l, { from: fromText, to: toText }) : copyText('panel.changelog.heading', l)
          let yankedBanner = ''
          try {
            const toEntry = Array.isArray(ranged) ? ranged.find(function(e) { try { return e && e.version === toText; } catch { return false; } }) : null
            if (toEntry && (toEntry as { yanked?: unknown }).yanked === true && toText) { yankedBanner = yankedBannerHTML(toText, l); }
          } catch { yankedBanner = ''; }
          const logOpen = (input as { changelogCollapsed?: unknown }).changelogCollapsed !== true
          inner = `<div class="dsh-upd-changelog-wrap"><div>${escapeHtml(rangeTitle)}</div>` +
            `<div class="dsh-upd-changelog-foldbox" data-open="${logOpen ? '1' : '0'}"><div class="dsh-upd-changelog-foldbox-inner">${yankedBanner}\n${changelogHTML}\n</div></div></div>`
          hasLog = Array.isArray(ranged) && ranged.length > 0
        } // end else（正常渲染分支）
      } catch {
        // 日志画坏了也不挡更新：退回中性提示，安装按钮状态不变。
        inner = ''
      }
    }
    if (!inner) {
      // #213：这一档本该说「更新日志无法读取」——有分档就说清是哪一档；无新版仍走旧句。
      const blankText =
        snapshot && snapshot.latestVersion
          ? statusCopyText || copyText('panel.changelog.unavailable', l)
          : copyText('panel.changelog.unavailable-empty', l)
      inner = `<div class="dsh-upd-changelog-wrap"><div class="dsh-upd-changelog-neutral">${escapeHtml(blankText)}</div></div>`
    }
    const logCollapsed = (input as { changelogCollapsed?: unknown }).changelogCollapsed === true
    const logNote = showActions && hasLog
      ? '<span class="dsh-upd-chap-note"><button type="button" data-action="toggle-changelog" title="' + escapeHtml(copyText('panel.changelog.toggle-title', l)) + '">' +
        `${escapeHtml(logCollapsed ? copyText('panel.changelog.expand', l) : copyText('panel.changelog.collapse', l))}</button></span>`
      : ''
    chapters.push(chapterOf(2, inner, logNote, l))
  }
  // —— 03 更新队列（原型 :231-235）：章节恒在（没排队也给一句话，编号不许跳）——
  // 设计定案（2026-10-04，见 03 章设计稿）：正文改成两行键值（正在安装 / 你的顺位），
  // 开关仍是**按钮**（不是原型的复选框），位置照原型挪到章节标题行右端。
  {
    const queued = !!queue && (queue.busy || queue.waiting.length > 0)
    if (queued && queue) {
      const busy = queue.busy
      const ownerRaw = queue.owner
      // 他人标识只在 showOthers 打开时才露：宿主默认已折过一道，这里再守一道
      // （调用方直接塞原始队列时，面板也不许把人家的插件名印出来）。
      const named =
        ownerRaw && 'pluginId' in ownerRaw && ownerRaw.pluginId ? String(ownerRaw.pluginId) : null
      const version =
        ownerRaw && 'targetVersion' in ownerRaw && ownerRaw.targetVersion
          ? `@${String(ownerRaw.targetVersion)}`
          : ''
      const aboutSelf = named !== null && named === pluginId
      const reveal = showOthers === true
      const ownerShown = !busy
        ? copyText('panel.queue.state-idle', l)
        : named === null
          ? copyText('panel.queue.other', l)
          : aboutSelf
            ? copyText('panel.queue.self', l)
            : reveal
              ? named
              : copyText('panel.queue.other', l)
      const ownerVer = busy && named !== null && (aboutSelf || reveal) ? version : ''
      const pos = typeof queue.position === 'number' ? queue.position : null
      const posText = pos === null ? copyText('panel.queue.pos-absent', l) : copyText('panel.queue.pos-n', l, { n: pos })
      const posNote = pos === null ? '' : pos === 1 ? copyText('panel.queue.pos-next', l) : copyText('panel.queue.pos-ahead', l, { n: pos - 1 })
      const rows = [
        '<div class="dsh-upd-qrow">' +
          `<span class="dsh-upd-qdot" data-tone="${busy ? 'busy' : 'idle'}"></span>` +
          `<span class="dsh-upd-qk">${escapeHtml(copyText('panel.queue.row-installing', l))}</span>` +
          `<span class="dsh-upd-qv">${escapeHtml(ownerShown + ownerVer)}</span>` +
          `<span class="dsh-upd-qn">${escapeHtml(busy ? copyText('panel.queue.row-installing-note', l) : copyText('panel.queue.row-idle-note', l))}</span></div>`,
        '<div class="dsh-upd-qrow">' +
          '<span class="dsh-upd-qdot" data-tone="you"></span>' +
          `<span class="dsh-upd-qk">${escapeHtml(copyText('panel.queue.row-position', l))}</span>` +
          `<span class="dsh-upd-qv">${escapeHtml(posText)}</span>` +
          `<span class="dsh-upd-qn">${escapeHtml(posNote)}</span></div>`,
      ]
      // 开关打开要有东西可看：给一条排队顺序（否则「显示其他插件」点了跟没点一样）。
      if (reveal && queue.waiting.length > 0) {
        const seq = queue.waiting
          .map((e) => `${e.pluginId}${e.targetVersion ? `@${e.targetVersion}` : ''}`)
          .join(' → ')
        rows.push(
          '<div class="dsh-upd-qrow"><span class="dsh-upd-qdot"></span>' +
            `<span class="dsh-upd-qk">${escapeHtml(copyText('panel.queue.row-order', l))}</span>` +
            `<span class="dsh-upd-qseq">${escapeHtml(seq)}</span></div>`,
        )
      }
      // 队列开关也是动作面：只读渲染（actions:'none'）下同样不画——
      // 否则「内核不画按钮」这条缝会漏掉 03 章这一颗（现场实测：忙队列时它照样渲染，成了新的死按钮）。
      // 只读渲染下队列内容照画，看不看他人明细由调用方传的 showOthers 决定。
      const note = showActions
        ? '<span class="dsh-upd-chap-note"><button type="button" data-action="toggle-queue">' +
          `${escapeHtml(reveal ? copyText('panel.queue.toggle-hide', l) : copyText('panel.queue.toggle-show', l))}</button></span>`
        : ''
      chapters.push(chapterOf(3, `<div class="dsh-upd-queue">${rows.join('')}</div>`, note, l))
    } else {
      chapters.push(
        chapterOf(
          3,
          `<div class="dsh-upd-queue"><div class="dsh-upd-changelog-neutral">${escapeHtml(
            view.queueNote ?? copyText('panel.queue.empty', l),
          )}</div></div>`,
          '',
          l,
        ),
      )
    }
  }
  // —— 04 错误信息（原型 :237-240）：平时是路牌，失败时是带冻结证据与现成查询的卷宗 ——
  {
    const errLines: string[] = []
    const failedNow = b.kind === 'failed' || b.kind === 'blocked'
    const failRef = (input as { failure?: unknown }).failure as PanelFailureRef | null | undefined
    if (failedNow) {
      const shownCode =
        b.kind === 'blocked'
          ? (snapshot?.blockedReason ?? b.kind)
          : typeof (input as { lastError?: unknown }).lastError === 'string' && ((input as { lastError: string }).lastError).trim()
            ? (input as { lastError: string }).lastError
            : 'install-failed'
      errLines.push(
        `<div class="dsh-upd-err">${escapeHtml(copyText('panel.error.code-label', l))} <code>${escapeHtml(String(shownCode))}</code>${l === 'en' ? ':' : '：'}${escapeHtml(copyText('panel.error.code-note', l))}</div>`,
      )
      if (b.kind === 'failed' && failRef) {
        const keys: string[] = []
        if (typeof failRef.requestId === 'string' && failRef.requestId) keys.push(`${escapeHtml(copyText('panel.error.query-request', l))} <code>${escapeHtml(failRef.requestId)}</code>`)
        if (typeof failRef.checkId === 'string' && failRef.checkId) keys.push(`${escapeHtml(copyText('panel.error.query-check', l))} <code>${escapeHtml(failRef.checkId)}</code>`)
        const at = formatLatchTime(failRef.atMs, ((input as { lang?: unknown }).lang as AppLang | string | null) ?? l)
        if (at) keys.push(`${escapeHtml(copyText('panel.error.failed-at', l, { time: at }))}`)
        if (keys.length > 0) {
          errLines.push(`<div class="dsh-upd-err">${copyText('panel.error.query-keys', l, { keys: keys.join(' · ') })}</div>`)
        }
        if (typeof failRef.targetVersion === 'string' && failRef.targetVersion.trim()) {
          errLines.push(`<div class="dsh-upd-err">${escapeHtml(copyText('panel.error.target-version', l, { version: failRef.targetVersion.trim() }))}</div>`)
        }
        if (!failRef.volatile) {
          errLines.push(
            `<div class="dsh-upd-err">${escapeHtml(copyText('panel.error.evidence-frozen', l))}</div>`,
          )
        } else {
          errLines.push(
            `<div class="dsh-upd-err">${escapeHtml(copyText('panel.error.evidence-transient', l))}</div>`,
          )
        }
      }
    } else {
      errLines.push(`<div class="dsh-upd-changelog-neutral">${escapeHtml(copyText('panel.error.no-failure', l))}</div>`)
    }
    if ((input as { showLogHint?: unknown }).showLogHint !== false) {
      // 路牌里的日志目录（#123）：宿主 includeEnv 回了就写实路径，没回就写算式与命令模板
      // ——路牌宁可说「目录长这样、命令长这样」，也不指一个并不存在的值。
      const logDirInput = (input as { logDir?: unknown }).logDir
      const logDirKnown = typeof logDirInput === 'string' && logDirInput.trim() ? logDirInput.trim() : null
      // 占位符一律 ASCII：中文只许存文案源（src/core/i18n/dictionary.ts），路径与命令里的尖括号不译。
      const logDirShown = logDirKnown ?? '<DSH_HOME>/logs/<derived>'
      // 命令不带 `tail`：dsh-log 0.3.1 的解析器把非 `-` 开头的词一律当路径，
      // 而它的 USAGE 写着 `tail` —— 带上就会多吐一句「没找到日志目录：tail」。
      const logCmdShown = logDirKnown ? `npx dsh-log ${logDirKnown}` : 'npx dsh-log <log-dir>'
      errLines.push(
        `<div class="dsh-upd-log">${copyText('panel.error.log-hint', l, {
          dir: `<code>${escapeHtml(logDirShown)}</code>`,
          cmd: `<code>${escapeHtml(logCmdShown)}</code>`,
          pluginId: `<code>${escapeHtml(pluginId)}</code>`,
          e1: `<code>${LOG_EVENT_CALL}</code>`,
          e2: `<code>${LOG_EVENT_CALL_FAIL}</code>`,
          e3: `<code>${LOG_EVENT_INSTALL_EXEC}</code>`,
        })}</div>`,
      )
      // #212 日志健康：成功回包带了读数就多一行（这一帧日志到底有没有、落点是谁、为什么没有）；
      // 老宿主没有这个键 / 没读数即不出现（不占位），措辞全部来自 shared/copy.logHealthText。
      const healthLine = logHealthText(input.logHealth, l)
      if (healthLine) errLines.push(`<div class="dsh-upd-log">${escapeHtml(healthLine)}</div>`)
      if (b.kind === 'failed' && failRef && (failRef.requestId || failRef.checkId)) {
        errLines.push(
          `<div class="dsh-upd-log">${copyText('panel.error.log-follow', l, {
            eFail: `<code>${LOG_EVENT_CALL_FAIL}</code>`,
            eCall: `<code>${LOG_EVENT_CALL}</code>`,
            eExec: `<code>${LOG_EVENT_INSTALL_EXEC}</code>`,
          })}</div>`,
        )
      }
    }
    if (copyNotice) errLines.push(`<div class="dsh-upd-copy" role="status">${escapeHtml(copyNotice)}</div>`)
    else errLines.push('<div class="dsh-upd-copy dsh-upd-copy--empty" aria-hidden="true"></div>')
    chapters.push(chapterOf(4, errLines.join(''), '', l))
  }
  // —— 05 手工命令（原型 :242-245）：章节恒在；没有可给的手工命令就说清为什么 ——
  // #92：空态分原因说清（源码安装 / 开发态 / 范围认不出 / 运行版未知 / 没有安全候选）。
  // 只在「用户本该拿到命令」的横幅状态（失败 / 待重启 / 受阻 / 可更新）里套原因，判据与
  // 面板分支共用 manual-absent 的一张表；读取中、已最新这类状态不涉及命令，仍给中性兜底句。
  const manualAbsentReason =
    !manual && manualAppliesToBanner(b.kind) ? manualAbsentReasonOf(snapshot) : null
  // #177：失败回包沿用的旧命令不可信 —— fail-closed：不展示、不给复制、不高亮，只说明它还没按当帧读数确认。
  const manualStale = manualSource === 'carried-over' && Boolean(manual)
  let manualHtml =
    view.showManual && manualTrusted
      ? `<div class="dsh-upd-manual"><div>${escapeHtml(copyText('panel.manual.heading', l))}</div><code>${escapeHtml(manual ?? '')}</code></div>`
      : `<div class="dsh-upd-manual"><div class="dsh-upd-changelog-neutral">${
          manualStale
            ? escapeHtml(copyText('panel.manual.stale', l))
            : escapeHtml(manualAbsentTextOf(manualAbsentReason, l))
        }</div></div>`
  // #196 部署偏斜：嵌套副本（被消费方声明范围钉死）在这里给可执行的升级指引。
  // 缺使用范围名就不给命令（假命令比没有更糟），只说明为什么升级不生效。
  const selfParts = updaterPartsOf((input as { updater?: UpdaterSelfView | null }).updater)
  if (selfParts && selfParts.level === 'nested') {
    const command = selfUpgradeCommandOf(profileName)
    manualHtml +=
      `<div class="dsh-upd-updater-nested">` +
      escapeHtml(
        command
          ? copyText('panel.manual.updater-nested', l, { version: selfParts.version, command })
          : copyText('panel.manual.updater-nested-nocmd', l, { version: selfParts.version }),
      ) +
      `</div>`
  }
  // 身份兜底：footer 只在 dialog + 有动作面时画；embedded / 只读渲染由 05 章补一行，
  // 保证「任意宿主插件面板都能看到本面板跑的是哪一份副本」（#196 验收）。
  const updaterIdentity = updaterIdentityOf(input)
  const footerRendersIdentity = showActions && mode === 'dialog'
  if (updaterIdentity && !footerRendersIdentity) {
    manualHtml += `<div class="dsh-upd-updater-id">${escapeHtml(updaterIdentity)}</div>`
  }
  // #174：05 章命令块 title 旁的小徽标 —— 命令是唯一出路的提示，告诉读者 05 章这条就是最后手段。
  const manualChapNote =
    lastResortBarHtml && lastResort.kind === 'last-resort'
      ? `<span class="dsh-upd-lr-chap-badge">${escapeHtml(copyText('panel.lastresort.badge', l))}</span>`
      : ''
  chapters.push(chapterOf(5, manualHtml, manualChapNote, l))
  parts.push('<div class="dsh-upd-body">' + chapters.join('\n') + '</div>')
  // —— 右下角独立 footer 区（#47 定案 A：一次找到，脱离第一章 actions）——
  // dialog 才有，永远在 05 章之后；embedded 无（宿主框架自带关）；
  // 只读渲染（actions:'none'）下不画（动作面归调用方，免得出现可点却没人接的死按钮）。
  if (showActions && mode === 'dialog') {
    parts.push(
      '<div class="dsh-upd-footer"><span class="dsh-upd-foot-note">' + escapeHtml(copyText('panel.footer.note', l)) + '</span>' +
        (updaterIdentity ? `<span class="dsh-upd-updater-note">${escapeHtml(updaterIdentity)}</span>` : '') +
        `<button type="button" data-action="close-view" title="${escapeHtml(copyText('panel.footer.close-title', l))}">${escapeHtml(copyText('panel.footer.close', l))}</button></div>`,
    )
  }
  // v1.3：复制成功气泡是 fixed 定位的状态提示，画在卷宗根部（不挤压布局），约 1.4s 由挂载侧撤掉。
  if (input.copyBubble) parts.push(copyBubbleHTML(input.copyBubble))
  return parts.join('\n')
}

/** 整面板 HTML（含样式；重绘即整体替换 innerHTML，故每次都带 style 也只留一份）。 */
export function renderUpdatePanelHTML(input: PanelRenderInput, lang?: AppLang | string | null): string {
  const l = normalizeLangTag(lang ?? (input as { lang?: unknown }).lang ?? 'zh')
  const view = panelViewModel(input, l)
  const kernel = renderUpdatePanelKernel(input, view, l)
  // 主题只换肤：默认主题输出与旧版一字不差（无 data-theme、不带 Archive 串）；
  // 档案卷才在根上挂 data-theme 并追加 Archive 串；内核 HTML 两边同一份。
  const archive = normalizePanelTheme(input.theme) === 'archive'
  const attr = archive ? ' data-theme="archive"' : ''
  const tokensStyle = themeTokensStyleFor((input as { themeTokens?: UpdateThemeTokens }).themeTokens ?? undefined)
  const tokensAttr = tokensStyle ? ` style="${tokensStyle}"` : ''
  // 印章走属性带到根上：Archive 用 CSS `content:attr(...)` 画成大印章，默认主题只当属性带着不画，
  // 两个主题的 DOM 仍逐字同一份（主题只换肤这条不变量不破）。
  const sealAttr = ` data-seal="${escapeHtml(view.seal.text)}" data-seal-tone="${view.seal.tone}"`
  const body =
    input.mode === 'dialog'
      ? `<div class="dsh-upd-overlay" data-mode="dialog"><div class="dsh-upd" data-mode="dialog" data-plugin="${escapeHtml(input.pluginId)}"${sealAttr}${attr}${tokensAttr}>\n${kernel}\n</div></div>`
      : `<div class="dsh-upd" data-mode="embedded" data-plugin="${escapeHtml(input.pluginId)}"${sealAttr}${attr}${tokensAttr}>\n${kernel}\n</div>`
  const css = archive ? `${UPDATE_PANEL_CSS}\n${UPDATE_PANEL_ARCHIVE_CSS}` : UPDATE_PANEL_CSS
  return `<style>${css}</style>\n${body}`
}
