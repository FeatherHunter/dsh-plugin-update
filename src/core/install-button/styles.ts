/**
 * src/core/install-button/styles.ts —— 槽位级安装按钮的样式常量（#221 自旧 src/install-button.ts 拆出）。
 *
 * 纯 CSS 字符串，无任何依赖；按蓝图收口到 core/install-button/ 域。
 */

export const INSTALL_BUTTON_CSS = [
  '.dsh-upd-ib{display:flex;flex-direction:column;gap:8px;font:inherit}',
  '.dsh-upd-ib-status{font-weight:600;overflow-wrap:anywhere}',
  '.dsh-upd-ib-sub{opacity:.85;overflow-wrap:anywhere}',
  '.dsh-upd-ib-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
  '.dsh-upd-ib button{cursor:pointer;transition:border-color 120ms ease,box-shadow 120ms ease,transform 80ms ease}',
  '.dsh-upd-ib button[disabled]{cursor:default}',
  // #173 v1.3：按钮 hover 必须看得见边框变化（主色边框 + 2px 外环），不能只靠 brightness。
  '.dsh-upd-ib button:hover:not(:disabled){border-color:var(--dsh-update-primary,#2563eb);box-shadow:0 0 0 2px var(--dsh-update-primary,#2563eb)}',
  '.dsh-upd-ib button:active:not(:disabled){transform:translateY(1px)}',
  '.dsh-upd-ib button:focus-visible{outline:2px solid var(--dsh-update-primary,#2563eb);outline-offset:2px}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd-ib button{transition:none}}',
  '.dsh-upd-ib-manual summary{cursor:pointer}',
  '.dsh-upd-ib-manual code{display:block;white-space:pre-wrap;overflow-wrap:anywhere}',
  // #174：折叠细节里的最后手段条与 #177 的 stale 说明（主题令牌走既有变量；内联回退色与同文件既有变量写法一致）。
  '.dsh-upd-ib-manual .dsh-upd-lastresort{margin-top:6px}',
  '.dsh-upd-ib-manual .dsh-upd-lr-go{margin:0}',
  '.dsh-upd-ib-stale{color:var(--dsh-update-text-muted,inherit);font-size:var(--dsh-update-panel-small-font-size,12px)}',
  '.dsh-upd-ib-notice{opacity:.8}',
  // #173 v1.3：复制成功气泡（fixed 定位，不挤动布局；系统色/减弱动态下可用）。
  '.dsh-upd-ib .dsh-upd-copy-bubble{position:fixed;z-index:10000;transform:translate(-50%,-100%);background:var(--dsh-update-text,#1f2937);color:var(--dsh-update-bg,#ffffff);border-radius:4px;padding:3px 9px;font-size:var(--dsh-update-panel-small-font-size,12px);line-height:1.5;pointer-events:none}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd-ib .dsh-upd-copy-bubble{animation:none}}',
  '@media (forced-colors: active){.dsh-upd-ib .dsh-upd-copy-bubble{border:1px solid CanvasText;background:Canvas;color:CanvasText}}',
  '.dsh-upd-ib[data-theme="archive"] .dsh-upd-ib-status{font-family:serif}',
].join('\n')
