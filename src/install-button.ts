/**
 * src/install-button.ts —— 槽位级“安装”按钮控件的公开入口（#148；#221 起退化为入口壳）。
 *
 * 一句话：在任意容器里挂一颗按钮，原地装好一家插件。开发者决定放哪、长什么样，
 * 装的正确性归本包；兜底保留手工命令；既有面板/入口/批量零改动。
 *
 * 不另起第二套口径：判定走 panelViewModel，失败判定走 failureCodeOf/failureCopy/blockedCopy，
 * 诊断走 buildUpdateDiagCopy，文案走 copyText 既有键（唯一新键见 bilingual），
 * 时序照抄 panel runAction 的 check/install 两案，日志沿用 update.panel.action。
 *
 * #221：实现已按蓝图拆入 core/install-button/（widgets/view/render/styles/mount），
 * 本文件只留对外类型 + curated re-export，公开导出集一个不少（冻结基线见 #221 票面）。
 * 实现模块一律不反向值依赖本壳。
 *
 * 浏览器安全：零 `node:` 导入。中文只许出现在 copyText 的 key 里，
 * 本文件字符串字面量一律英文（双语门禁基线不动）。
 */
import type { AppLang, LocaleOption } from './shared/lang.js'
import type { UpdatePanelClientLogOptions, UpdateThemeTokens } from './panel.js'
import type { InstallSource, UpdateSnapshot } from './shared/ports.js'
import type { VisibleQueue } from './core/queue/model.js'
// #174：last-resort 的类型经既有子路径转出，消费者无需新子路径即可命名（`ManualSource` 已出现在本模块导出签名里）。
export type { LastResortKind, RescueRouteKey, ManualSource, LastResortVerdict } from './shared/last-resort.js'

// ---------- 对外类型 ----------

export type InstallButtonCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>

export type InstallButtonCopyText = (text: string) => void | Promise<void>

export interface InstallButtonOptions {
  pluginId: string
  call: InstallButtonCall
  prefix?: string
  pollMs?: number
  autoCheck?: 'mount' | 'never'
  showOthers?: boolean
  profileName?: string | null
  locale?: LocaleOption
  theme?: 'default' | 'archive'
  themeTokens?: UpdateThemeTokens
  copyText?: InstallButtonCopyText
  /**
   * 安装意图来源（#207）：落进 update.install.request.from。缺省 `entry`——按钮是嵌在宿主界面里的
   * 入口，可嵌入任何页面；面板本体自己的调用显式传 `panel`，批量编排传 `batch`。
   */
  from?: InstallSource
  clientLog?: UpdatePanelClientLogOptions | null
}

export interface InstallButtonContainer {
  innerHTML: string
  addEventListener?: (type: string, listener: (ev: unknown) => void) => void
  removeEventListener?: (type: string, listener: (ev: unknown) => void) => void
}

export interface InstallButtonController {
  state(): {
    snapshot: UpdateSnapshot | null
    manual: string | null
    queue: VisibleQueue | null
    failedCode: string | null
    busy: boolean
  }
  refresh(): Promise<void>
  unmount(): void
}

export type InstallButtonRole = 'install' | 'check' | 'none'

export interface InstallButtonViewInput {
  snapshot: UpdateSnapshot | null
  manual: string | null
  queue: VisibleQueue | null
  lastError: string | null
  errorKind?: string | null
  /** 锁存里的失败原文（翻译官重认用；没有即不认，不猜）。 */
  errorDetail?: string | null
  /** 锁存里的机读诊断（#156 第四轮）：异步失败时宿主随成功回包补的包名/归因，认因优先用它。 */
  errorDiag?: unknown
  /** 归因用的插件标识（与 panel 锁存同口径）。 */
  pluginId?: string | null
  /** 决议已出的候选（有即二次确认态，无即首问态）。 */
  fallbackOffer?: { candidate: string; targetVersion: string } | null
  busyAct: 'check' | 'install' | 'fallback' | null
  /**轮询封顶后转重查态：在途也不再显示忙。请调用方（挂载）传入，纯函数不读计时器。*/
  pollCapped?: boolean | null
  lang?: AppLang | string | null
}

export interface InstallButtonView {
  role: InstallButtonRole
  buttonLabel: string
  buttonEnabled: boolean
  buttonBusy: boolean
  /** Whether to render the button element at all (restart/blocked/action-less failure show text only). */
  showButton: boolean
  statusTitle: string
  statusAction: string
  showManual: boolean
  queueNote: string | null
  bannerKind: string
  /** 合规版兜底（#156）：失败且拦的正是更新目标时非 null；复用 panel.action.* 既有键，零新增键。 */
  fallbackStage: 'offer' | 'confirm' | null
  fallbackCandidate: string | null
  fallbackBusy: boolean
}

// ---------- 装配（#221 起实现移至 core/install-button/，此处只转出） ----------

export { INSTALL_BUTTON_CSS } from './core/install-button/styles.js'
export {
  INSTALL_BUTTON_MAX_POLLS,
  INSTALL_BUTTON_POLL,
  mountInstallButton,
} from './core/install-button/mount.js'
export { renderInstallButtonHTML } from './core/install-button/render.js'
export { installButtonViewModel } from './core/install-button/view.js'
