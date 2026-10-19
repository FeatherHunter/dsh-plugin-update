/**
 * src/core/install-button/view.ts —— 纯函数视图（无计时器无 DOM；挂载与测试共用同一装配，#221 自旧 src/install-button.ts 拆出）。
 *
 * 判定一律调 panel 纯函数；对外只转出 installButtonViewModel，installButtonFallbackOf 仍是本文件私有。
 */
import type { InstallButtonView, InstallButtonViewInput } from '../../install-button.js'
import { normalizeLangTag } from '../../shared/lang.js'
import { copyText } from '../../core/i18n/text.js'
import type { BilingualKey } from '../../core/i18n/dictionary.js'
import {
  fallbackCauseFromDetail,
  fallbackCauseFromDiag,
  isCheckSideFailureCode,
  panelViewModel,
} from '../../panel.js'

// ---------- 纯函数视图（无计时器无 DOM；挂载与测试共用同一装配） ----------

/**
 * 合规版兜底资格（#156，纯函数）：失败原文经翻译官重认，拦的正是当前更新目标才给。
 * B 类（别家包）与认不出的失败回 null——调用方走通用老路，最坏情况就是现在。
 * 候选对不上当前目标即视为无候选（旧决议不指手画脚，由挂载侧清掉）。
 * #156 第四轮：先认机读诊断（宿主补的包名/归因）——真机上插件标识与 npm 包名不是一回事，
 * 只按标识认的话这支按钮在真机上永远不出现；诊断认不出才退回原文认。
 */
function installButtonFallbackOf(input: InstallButtonViewInput, bannerKind: string): {
  stage: 'offer' | 'confirm'
  candidate: string | null
} | null {
  try {
    if (bannerKind !== 'failed') return null
    if (input.busyAct === 'check' || input.busyAct === 'install') return null
    const code = typeof input.lastError === 'string' && input.lastError ? input.lastError : 'install-failed'
    const byDiag = fallbackCauseFromDiag(input.errorDiag, input.errorDetail ?? null, code, input.snapshot?.job?.targetVersion)
    const cause = byDiag ?? fallbackCauseFromDetail(input.errorDetail ?? null, code, input.pluginId ?? null)
    if (!cause) return null
    const latest = input.snapshot?.latestVersion ?? null
    if (typeof latest !== 'string' || !latest || cause.targetVersion !== latest) return null
    const offered = typeof input.fallbackOffer?.candidate === 'string' ? input.fallbackOffer.candidate.trim() : ''
    const offerTarget = typeof input.fallbackOffer?.targetVersion === 'string' ? input.fallbackOffer.targetVersion.trim() : ''
    if (offered && offerTarget === cause.targetVersion) return { stage: 'confirm', candidate: offered }
    return { stage: 'offer', candidate: null }
  } catch {
    return null
  }
}

export function installButtonViewModel(input: InstallButtonViewInput): InstallButtonView {
  const l = normalizeLangTag(input.lang ?? 'zh')
  const view = panelViewModel(
    {
      snapshot: input.snapshot,
      manual: input.manual,
      queue: input.queue,
      skippedLatest: false,
      lastError: input.lastError,
      errorKind: input.errorKind ?? null,
    },
    l,
  )
  const job = input.snapshot?.job ?? null
  const jobState = job?.state ?? null
  const jobActive = jobState === 'installing' || jobState === 'verifying'
  const fallback = installButtonFallbackOf(input, view.banner.kind)
  const fallbackBusy = input.busyAct === 'fallback'
  // 封顶转重查态：在途也不再显示忙，按钮退回检查（点查即刷新，不多一次自动调用）。
  if (input.pollCapped === true && jobActive && !input.busyAct) {
    return {
      role: 'check',
      buttonLabel: copyText('panel.action.check', l),
      buttonEnabled: true,
      buttonBusy: false,
      showButton: true,
      statusTitle: view.banner.title,
      statusAction: view.banner.action,
      showManual: view.showManual,
      queueNote: view.queueNote,
      bannerKind: view.banner.kind,
      fallbackStage: null,
      fallbackCandidate: null,
      fallbackBusy: false,
    }
  }
  if (input.busyAct === 'check' || input.busyAct === 'install' || input.busyAct === 'fallback' || jobActive) {
    const label =
      input.busyAct === 'check'
        ? copyText('panel.action.checking-busy', l)
        : input.busyAct === 'install'
          ? copyText('panel.action.installing-busy', l)
          : view.installLabel
    return {
      role: 'none',
      buttonLabel: label,
      buttonEnabled: false,
      buttonBusy: true,
      showButton: true,
      statusTitle: view.banner.title,
      statusAction: view.banner.action,
      showManual: view.showManual,
      queueNote: view.queueNote,
      bannerKind: view.banner.kind,
      fallbackStage: fallback?.stage ?? null,
      fallbackCandidate: fallback?.candidate ?? null,
      fallbackBusy,
    }
  }
  // 可安装（核心口径）：主按钮照旧，兜底是**加法**不是替代——与主面板同一摆放。
  // 关键：年龄门是 pnpm 在装的那一刻拦的，核心的 canInstall 根本不知道它，
  // 所以"装失败之后 canInstall 仍为真"才是生产真形状；此处若把兜底吞掉，
  // 主场景（最新版被拦）在槽位上就永远看不见［装合规版］（2026-10-17 对抗审查实测）。
  if (view.installEnabled) {
    return {
      role: 'install',
      buttonLabel: view.installLabel,
      buttonEnabled: true,
      buttonBusy: false,
      showButton: true,
      statusTitle: view.banner.title,
      statusAction: view.banner.action,
      showManual: view.showManual,
      queueNote: view.queueNote,
      bannerKind: view.banner.kind,
      fallbackStage: fallback?.stage ?? null,
      fallbackCandidate: fallback?.candidate ?? null,
      fallbackBusy,
    }
  }
  if (!input.snapshot || !input.snapshot.latestVersion) {
    return {
      role: 'check',
      buttonLabel: copyText('panel.action.check', l),
      buttonEnabled: true,
      buttonBusy: false,
      showButton: true,
      statusTitle: view.banner.title,
      statusAction: view.banner.action,
      showManual: view.showManual,
      queueNote: view.queueNote,
      bannerKind: view.banner.kind,
      fallbackStage: null,
      fallbackCandidate: null,
      fallbackBusy: false,
    }
  }
  if (input.lastError && isCheckSideFailureCode(input.lastError)) {
    return {
      role: 'check',
      buttonLabel: copyText('panel.action.check', l),
      buttonEnabled: true,
      buttonBusy: false,
      showButton: true,
      statusTitle: view.banner.title,
      statusAction: view.banner.action,
      showManual: view.showManual,
      queueNote: view.queueNote,
      bannerKind: view.banner.kind,
      fallbackStage: null,
      fallbackCandidate: null,
      fallbackBusy: false,
    }
  }
  const done = view.banner.kind === 'done'
  return {
    role: 'none',
    buttonLabel: done ? copyText('install-button.action.installed' as BilingualKey, l) : view.installLabel,
    buttonEnabled: false,
    buttonBusy: false,
    showButton: done,
    statusTitle: view.banner.title,
    statusAction: view.banner.action,
    showManual: view.showManual,
    queueNote: view.queueNote,
    bannerKind: view.banner.kind,
    fallbackStage: fallback?.stage ?? null,
    fallbackCandidate: fallback?.candidate ?? null,
    fallbackBusy,
  }
}
