/**
 * src/core/install-button/render.ts —— 纯渲染（view → HTML 字符串，#221 自旧 src/install-button.ts 拆出）。
 *
 * 无 DOM 无计时器；样式常量在 ./styles.ts，转义与兜底文案来自 ./widgets.ts 及 panel 既有键。
 */
import type { InstallButtonView } from '../../install-button.js'
import type { AppLang } from '../../shared/lang.js'
import { copyText } from '../../core/i18n/text.js'
import {
  copyBubbleHTML,
  lastResortBarHTML,
  lastResortCopyButtonHTML,
} from '../../panel.js'
import { lastResortVerdictOf, type ManualSource } from '../../shared/last-resort.js'
import { INSTALL_BUTTON_CSS } from './styles.js'
import { escapeHtml } from './widgets.js'

export function renderInstallButtonHTML(
  view: InstallButtonView,
  opts: {
    manual: string | null
    notice: string | null
    theme: 'default' | 'archive'
    lang: AppLang
    manualSource?: ManualSource | null
    /** 该帧失败码（给了才判最后手段；缺省按无码 → unknown，不误亮）。 */
    failureCode?: string | null
    /** 合规版救援证据（给了就把 install-failed 判成 salvageable）。 */
    fallbackAvailable?: boolean
    /** 待重启那档的在册事实（#190；false → 救援路径是「在宿主里选择」）。 */
    registered?: boolean | null
    /** 复制成功气泡（#173 v1.3）：缺省即不画。 */
    bubble?: { text: string; left: number; top: number } | null
  },
): string {
  const l = opts.lang
  // #177：命令可信来源（缺省按 frame，兼容老调用方）；carried-over 一律 fail-closed。
  const manualSource: ManualSource | null =
    opts.manualSource === 'carried-over' ? 'carried-over' : opts.manualSource === null ? null : 'frame'
  const manualTrusted =
    typeof opts.manual === 'string' && opts.manual.trim() !== '' && manualSource === 'frame'
  const lastResort = lastResortVerdictOf({
    code: opts.failureCode ?? null,
    blockedReason: null,
    manual: typeof opts.manual === 'string' ? opts.manual : null,
    manualSource,
    fallbackAvailable: opts.fallbackAvailable === true,
    registered: opts.registered ?? null,
  })
  const parts: string[] = []
  parts.push('<style>' + INSTALL_BUTTON_CSS + '</style>')
  parts.push('<div class="dsh-upd-ib" data-theme="' + opts.theme + '">')
  parts.push(
    '<div class="dsh-upd-ib-status dsh-upd-ib-kind-' +
      escapeHtml(view.bannerKind) +
      '">' +
      escapeHtml(view.statusTitle) +
      '</div>',
  )
  const sub = [view.statusAction, view.queueNote].filter((t) => typeof t === 'string' && t.trim())
  if (sub.length > 0) {
    parts.push('<div class="dsh-upd-ib-sub">' + escapeHtml(sub.join(' ')) + '</div>')
  }
  if (view.showButton) {
    // Actionable roles carry data-action; done/busy states render text only.
    const actionAttr = view.role === 'none' ? '' : ' data-action="' + (view.role === 'check' ? 'check' : 'install') + '"'
    const disabled = view.buttonEnabled ? '' : ' disabled'
    const busy = view.buttonBusy ? ' aria-busy="true"' : ''
    parts.push(
      '<div class="dsh-upd-ib-row"><button type="button"' +
        actionAttr +
        ' data-primary="1"' +
        disabled +
        busy +
        '>' +
        escapeHtml(view.buttonLabel) +
        '</button></div>',
    )
  }
  // 合规版兜底（#156）：失败且拦的正是更新目标时，与主面板同口径给双按钮；
  // B 类与认不出的失败一个字不动（通用老路）。复用 panel.action.* 既有键，零新增键。
  if (view.fallbackStage === 'confirm' && view.fallbackCandidate) {
    const busy = view.fallbackBusy || view.buttonBusy ? ' disabled aria-busy="true"' : ''
    parts.push(
      '<div class="dsh-upd-ib-row"><button type="button" data-action="install-fallback-confirm" data-primary="1" title="' +
        escapeHtml(copyText('panel.action.install-fallback-confirm-title', l)) +
        '"' +
        busy +
        '>' +
        escapeHtml(copyText('panel.action.install-fallback-confirm', l, { version: view.fallbackCandidate })) +
        '</button><button type="button" data-action="wait-latest" title="' +
        escapeHtml(copyText('panel.action.wait-latest-title', l)) +
        '"' +
        (view.fallbackBusy || view.buttonBusy ? ' disabled' : '') +
        '>' +
        escapeHtml(copyText('panel.action.wait-latest', l)) +
        '</button></div>',
    )
  } else if (view.fallbackStage === 'offer') {
    const busy = view.fallbackBusy || view.buttonBusy ? ' disabled aria-busy="true"' : ''
    parts.push(
      '<div class="dsh-upd-ib-row"><button type="button" data-action="install-fallback" data-primary="1" title="' +
        escapeHtml(copyText('panel.action.install-fallback-title', l)) +
        '"' +
        busy +
        '>' +
        escapeHtml(copyText('panel.action.install-fallback', l)) +
        '</button><button type="button" data-action="wait-latest" title="' +
        escapeHtml(copyText('panel.action.wait-latest-title', l)) +
        '"' +
        (view.fallbackBusy || view.buttonBusy ? ' disabled' : '') +
        '>' +
        escapeHtml(copyText('panel.action.wait-latest', l)) +
        '</button></div>',
    )
  }
  // 失败证据常驻：复制诊断不随主按钮同隐——无动作可点时（blocked/待重启后的失败）仍可取证。
  if (view.bannerKind === 'failed') {
    parts.push(
      '<div class="dsh-upd-ib-row"><button type="button" data-action="copy-diag" title="' +
        escapeHtml(copyText('panel.action.copy-diag-title', l)) +
        '">' +
        escapeHtml(copyText('panel.action.copy-diag', l)) +
        '</button></div>',
    )
  }
  // 手工命令折叠区（#174 A′）：只有最后手段那一档在折叠细节里插 A′ 条，按钮落在主位；
  // 其余档沿用原样。carried-over（#177）不给命令、不给复制、只说明未按当帧确认。
  if (view.showManual && manualTrusted) {
    const bar = lastResortBarHTML({
      verdict: lastResort,
      lang: l,
      buttonHtml: lastResortCopyButtonHTML(l),
    })
    parts.push(
      '<details class="dsh-upd-ib-manual"><summary>' +
        escapeHtml(copyText('panel.chapter.manual', l)) +
        '</summary>' +
        bar +
        '<code>' +
        escapeHtml(opts.manual ?? '') +
        '</code>' +
        (bar
          ? ''
          : '<button type="button" data-action="copy-manual" title="' +
            escapeHtml(copyText('panel.action.copy-manual-title', l)) +
            '">' +
            escapeHtml(copyText('panel.action.copy-manual', l)) +
            '</button>') +
        '</details>',
    )
  } else if (view.showManual && manualSource === 'carried-over' && opts.manual) {
    parts.push(
      '<details class="dsh-upd-ib-manual"><summary>' +
        escapeHtml(copyText('panel.chapter.manual', l)) +
        '</summary><div class="dsh-upd-ib-stale">' +
        escapeHtml(copyText('panel.manual.stale', l)) +
        '</div></details>',
    )
  }
  if (opts.notice) {
    parts.push('<div class="dsh-upd-ib-notice" role="status">' + escapeHtml(opts.notice) + '</div>')
  }
  // v1.3：复制成功气泡挂在槽位根部之内（CSS `.dsh-upd-ib .dsh-upd-copy-bubble` 才能管到定位/配色）；
  // fixed 定位不挤压布局，按钮文案/图标不变。
  parts.push(copyBubbleHTML(opts.bubble ?? null))
  parts.push('</div>')
  return parts.join('')
}
