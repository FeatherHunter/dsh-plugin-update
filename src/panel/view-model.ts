// src/panel/view-model.ts —— 面板视图模型（快照 → 面板该画什么；安装门控只跟快照，不另写规则）。
//
// 从 src/panel.ts 拆出（#226，蓝图 §4：panel/view-model）。纯函数，无 DOM、无宿主、无 I/O；
// 渲染层拿它算出的 PanelView 画 HTML。检查页预判门（CheckPrejudge/checkPrejudgeOfView）同属
// 视图判定，归在这里，渲染层只消费结果——避免 view-model ↔ render 的实现层值环（蓝图 R1）。

import { formatUnlockAt } from '../core/cause.js'
import type { ChangelogStatus } from '../core/changelog/parse.js'
import type { BilingualKey } from '../core/i18n/dictionary.js'
import { copyText } from '../core/i18n/text.js'
import type { VisibleQueue } from '../core/queue/model.js'
import { compareReleaseVersions } from '../core/service.js'
import { blockedCopy, failureCopy } from '../shared/copy.js'
import { isCheckSideFailureCode } from '../shared/codes.js'
import { failureSettledOf } from '../shared/failure-settled.js'
import { normalizeLangTag, type AppLang } from '../shared/lang.js'
import type { UpdateSnapshot } from '../shared/ports.js'

// ---------- 视图模型（纯函数：快照 → 面板该画什么；安装门控只跟快照，不另写规则） ----------

export interface PanelBanner {
  kind: 'loading' | 'restart' | 'blocked' | 'update' | 'busy' | 'failed' | 'done' | 'idle'
  title: string
  action: string
}

export interface PanelView {
  banner: PanelBanner
  installEnabled: boolean
  installLabel: string
  skippedLatest: boolean
  showManual: boolean
  showReset: boolean
  queueNote: string | null
  /** 大印章（状态词）与小印章（一字）：取值与原型 `archive.html:431-432` 的状态映射一一对应。 */
  seal: PanelSeal
}

/** 印章色调：与原型 `seal-ink / seal-green / seal-yellow / seal-red` 四个类同名同义。 */
export type PanelSealTone = 'ink' | 'green' | 'yellow' | 'red'

export interface PanelSeal {
  /** 大印章文字：待查 / 可装 / 安装中 / 待重启 / 受阻 / 已最新。 */
  text: string
  /** 小印章文字：查 / 装 / 启 / 阻 / 定（一字，与原型 sealmini 同口径）。 */
  mini: string
  tone: PanelSealTone
}

/**
 * 状态 → 印章（原型映射表，逐条对齐 archive.html:431-432，#61 入字典单语）：
 * 待查=查/ink、可装=装/green、安装中=装/yellow、待重启=启/yellow、受阻=阻/red、已最新=定/green。
 * 中文印章 blocked/failed 共用“受阻”，英文分流（Blocked — Action needed / Failed — Retry available，见 #53 Q4）。
 * 主题无关：默认主题只把它当属性带着（不画），Archive 用 CSS 读出来画成印章，DOM 两边仍同一份。
 */
const SEAL_KEYS: Record<PanelBanner['kind'], { text: BilingualKey; mini: BilingualKey; tone: PanelSealTone }> = {
  loading: { text: 'panel.seal.loading.text', mini: 'panel.seal.loading.mini', tone: 'ink' },
  idle: { text: 'panel.seal.idle.text', mini: 'panel.seal.idle.mini', tone: 'ink' },
  update: { text: 'panel.seal.update.text', mini: 'panel.seal.update.mini', tone: 'green' },
  busy: { text: 'panel.seal.busy.text', mini: 'panel.seal.busy.mini', tone: 'yellow' },
  restart: { text: 'panel.seal.restart.text', mini: 'panel.seal.restart.mini', tone: 'yellow' },
  blocked: { text: 'panel.seal.blocked.text', mini: 'panel.seal.blocked.mini', tone: 'red' },
  failed: { text: 'panel.seal.failed.text', mini: 'panel.seal.failed.mini', tone: 'red' },
  done: { text: 'panel.seal.done.text', mini: 'panel.seal.done.mini', tone: 'green' },
}

/** 状态 → 单语印章（lang 缺省 zh，零回归；tone 与原型同名同义，不入字典）。 */
export function panelSealFor(kind: PanelBanner['kind'], lang?: AppLang | string | null): PanelSeal {
  const keys = SEAL_KEYS[kind] ?? SEAL_KEYS.idle
  const l = normalizeLangTag(lang ?? 'zh')
  return { text: copyText(keys.text, l), mini: copyText(keys.mini, l), tone: keys.tone }
}

export function messageCodeOf(message: unknown): string {
  if (typeof message !== 'string' || !message) return ''
  const at = message.indexOf(':')
  return (at < 0 ? message : message.slice(0, at)).trim()
}

/**
 * #245：失败任务的稳定失败码——只有 failed 任务取 message 前缀，interrupted 与无码一律回到
 * install-failed（与失败横幅同口径）。失败横幅与历史行共用这一处，渲染层不再各推一遍语义。
 */
export function jobFailureCodeOf(job: UpdateSnapshot['job'] | null | undefined): string {
  return job && job.state === 'failed' ? messageCodeOf(job.message) || 'install-failed' : 'install-failed'
}

export interface PanelViewInput {
  snapshot: UpdateSnapshot | null
  manual: string | null
  queue: VisibleQueue | null
  skippedLatest: boolean
  lastError: string | null
  /** 失败回包的 errorKind（有则优先于 lastError；internal 时不许误判为查新版失败）。 */
  errorKind?: string | null
  /**
   * 检查页预判（#156 场景二）：内核记住的窗口（目标版 + 解封时刻 + 渲染时刻）。
   * 缺省即无预判（输出与旧版一字不差）；只在"已确认、无新鲜失败"时改变失败横幅与
   * 可装横幅的去向——锁存还在（有新鲜失败）时失败页优先，本输入不生效。
   */
  checkPrejudge?: CheckPrejudge | null
  /**
   * 更新日志 Markdown（#23）：只影响日志节的渲染，不参与安装门控。
   * 缺省/空串即中性提示；快照字段与 blockedReason 一字不动。
   */
  changelogMarkdown?: string | null
  /**
   * 更新日志分档（#213）：宿主判定的「为什么没有说明」（empty/missing/fetch-failed/parse-degraded）。
   * 只在日志节画不出内容时决定那句中性话术；有内容一律照旧（分档永不覆盖内容）。
   * 缺省/null/认不出的值/`ok`/`cache-hit` 即旧文案一字不差。
   */
  changelogStatus?: ChangelogStatus | null
}

export function panelViewModel(input: PanelViewInput, lang?: AppLang | string | null): PanelView {
  const l = normalizeLangTag(lang ?? (input as { lang?: unknown }).lang ?? 'zh')
  const view = panelViewModelCore(input, l)
  return { ...view, seal: panelSealFor(view.banner.kind, l) }
}

function panelViewModelCore(input: PanelViewInput, lang: AppLang): Omit<PanelView, 'seal'> {
  const { snapshot, manual, queue, skippedLatest, lastError } = input
  const errorKind = (input as { errorKind?: unknown }).errorKind
  const l = normalizeLangTag(lang ?? 'zh')
  if (!snapshot) {
    const earlyCode =
      (typeof errorKind === 'string' && errorKind.trim()) || lastError || ''
    if (earlyCode) {
      const copy = failureCopy(earlyCode, l)
      return {
        banner: {
          kind: 'failed',
          title: copyText('panel.banner.error.title', l, { code: earlyCode, detail: copy?.zh ?? earlyCode }),
          action: copy?.act || copyText('panel.banner.error.action-fallback', l),
        },
        installEnabled: false,
        installLabel: copyText('panel.action.retry-install', l),
        skippedLatest: false,
        showManual: manual ? true : false,
        showReset: false,
        queueNote: null,
      }
    }
    return {
      banner: { kind: 'loading', title: copyText('panel.banner.loading', l), action: '' },
      installEnabled: false,
      installLabel: copyText('panel.action.install', l),
      skippedLatest: false,
      showManual: false,
      showReset: false,
      queueNote: null,
    }
  }
  const job = snapshot.job ?? null
  const jobState = job?.state ?? null
  // #245：失败任务已被版本证据结算（目标版本确在跑）→ 它只是历史账本，不再驱动当前失败面。
  const jobFailureSettled = failureSettledOf(snapshot)
  const queueNote =
    queue && queue.busy
      ? queue.position === 0
        ? copyText('panel.queue.busy-self', l)
        : typeof queue.position === 'number'
          ? copyText('panel.queue.busy-queued', l, { n: queue.position })
          : copyText('panel.queue.busy-other', l)
      : null
  // 跳过即免打扰：新版本恒重新提醒（跳过按版本记），同一行给恢复入口。
  if (skippedLatest && snapshot.latestVersion) {
    return {
      banner: {
        kind: 'idle',
        title: copyText('panel.skip.skipped-title', l, { latest: snapshot.latestVersion }),
        action: copyText('panel.skip.skipped-action', l),
      },
      installEnabled: false,
      installLabel: copyText('panel.action.install', l),
      skippedLatest: true,
      showManual: false,
      showReset: true,
      queueNote,
    }
  }
  // 顺序（#91）：在途任务与新失败是新证据，旧快照的待重启排在其后。
  // 待重启仍是正常终态，但只在无在途、无新失败时展示。
  // 安装中：按钮置灰，进度靠轮询恢复（重开面板立刻重查即回进度）。
  if (jobState === 'installing' || jobState === 'verifying') {
    const ver = typeof job?.targetVersion === 'string' && job.targetVersion.trim() ? job.targetVersion.trim() : ''
    let installingTitle = copyText('panel.banner.installing-title', l, { version: ver || ' ' })
    // 空版本时去多余空格，还原旧输出“正在安装…关闭面板不会中断。”（模板带空格是为了有版本号时不断词）
    if (!ver) installingTitle = installingTitle.replace(' …', '…').replace(' ...', '...')
    return {
      banner: {
        kind: 'busy',
        title: installingTitle,
        action: copyText('panel.banner.installing-action', l),
      },
      installEnabled: false,
      installLabel: copyText('panel.action.installing', l),
      skippedLatest: false,
      showManual: false,
      showReset: false,
      queueNote,
    }
  }
  // 失败：稳定码 + 一句话 + 常驻复制诊断（分支只认 errorKind，error 仅回退）。
  // #238/#245：盘上失败任务在两种情况下只是历史账本、不驱动当前失败面——目标从未装过（#238），
  // 或失败已被版本证据结算（#245）。本回包/本会话的新鲜失败（errorKind/lastError）是当下证据，不受此限。
  const failureJobState = jobState === 'failed' || jobState === 'interrupted'
  const freshFailure = (typeof errorKind === 'string' && errorKind.trim()) || lastError
  const jobFailureCurrent = failureJobState && !jobFailureSettled && !(snapshot.installed === false && !freshFailure)
  const jobCode = jobFailureCurrent ? jobFailureCodeOf(job) : ''
  const failedCode = freshFailure || jobCode || ''
  // #100：失败任务已是旧目标、远端已有新版 → 失败页让位给新信息（旧失败不挡新版）。
  // 只压任务自带的失败：另有新鲜的 errorKind/lastError 时仍按失败页（那是当下的证据）。
  // 让位只发生在有当下故事可讲时（可装 / 有阻拦原因）；否则退回失败页——撒谎说“已最新”比留旧失败更糟。
  // 比不出版本一律按旧失败页，不猜。
  let staleFailure = false
  try {
    const target = typeof job?.targetVersion === 'string' ? job.targetVersion.trim() : ''
    const latest = typeof snapshot.latestVersion === 'string' ? snapshot.latestVersion.trim() : ''
    const freshOther = (typeof errorKind === 'string' && errorKind.trim()) || lastError
    staleFailure =
      (jobState === 'failed' || jobState === 'interrupted') &&
      !!target && !!latest && !freshOther && (snapshot.canInstall || !!snapshot.blockedReason) &&
      compareReleaseVersions(latest, target) === 1
  } catch {
    staleFailure = false
  }
  // #156 场景二：已确认（errorKind/lastError 为空即锁存已清：用户点了等新版/已知晓）
  // + 记住的窗口正对当前新版 + 还没放行 → 失败横幅让位给检查页预判，不再拿旧失败挡路。
  // 记住的窗口仍是事实（这版现在装还是会被拦），且只在"无新鲜失败"时让位——
  // 锁存还在（errorKind/lastError 有值）时失败页优先，本门直接 null。
  const gated = freshFailure ? null : checkPrejudgeOfView(input.checkPrejudge, snapshot)
  if (!staleFailure && !gated && (failedCode || jobFailureCurrent)) {

    const code = failedCode || 'install-failed'
    const copy = failureCopy(code, l)
    // 未装 + 查侧失败（#134/US15）：未装状态词打头 + 查侧文案，不说安装失败。
    const checkDetail = copy?.zh ?? code
    const detail =
      snapshot?.installed === false && isCheckSideFailureCode(code)
        ? copyText('panel.banner.not-installed', l) + '：' + checkDetail
        : checkDetail
    return {
      banner: {
        kind: 'failed',
        title: copyText('panel.banner.error.title', l, { code, detail }),
        action: copy?.act || copyText('panel.banner.error.action-fallback', l),
      },
      installEnabled: snapshot.canInstall,
      installLabel: copyText('panel.action.retry-install', l),
      skippedLatest: false,
      showManual: manual ? true : false,
      showReset: false,
      queueNote,
    }
  }
  // 待重启是正常终态：只给重启指引与手工命令入口，不再给安装按钮。
  // 到这里已排除在途任务与新失败（见上），旧快照的待重启才可信（#91）。
  if (snapshot.blockedReason === 'pending-restart') {
    const latest = snapshot.latestVersion ?? snapshot.installedVersion ?? ''
    // #190：在册事实为 false 时「重启宿主后生效」是假话——重启也不会加载。改说未登记 + 下一步。
    const unregistered = snapshot.registered === false
    return {
      banner: {
        kind: 'restart',
        // 文案照原型（archive.html:329）：不带 emoji——警示由横幅左侧的手绘 SVG 标承担，
        // 印章在状态一侧，两者各司其职，不再三重标记。
        title: unregistered
          ? copyText('panel.banner.restart-unregistered-title', l, { latest })
          : copyText('panel.banner.restart-title', l, { latest }),
        action: unregistered
          ? copyText('panel.banner.restart-unregistered-action', l)
          : blockedCopy('pending-restart', l)?.action ?? '',
      },
      installEnabled: false,
      installLabel: copyText('panel.action.install', l),
      skippedLatest: false,
      showManual: manual ? true : false,
      showReset: false,
      queueNote,
    }
  }
  // 装不了（除待重启外）：一句话原因（句号跟随语言：zh 用。/ en 用.）。
  if (snapshot.blockedReason) {
    const copy = blockedCopy(snapshot.blockedReason, l)
    const stop = l === 'en' ? '.' : '。'
    return {
      banner: {
        kind: 'blocked',
        title: copy ? `${copy.title}${stop}` : `${snapshot.blockedReason}${stop}`,
        action: copy?.action || '',
      },
      installEnabled: false,
      installLabel: copyText('panel.action.install', l),
      skippedLatest: false,
      showManual: manual ? true : false,
      showReset: false,
      queueNote,
    }
  }
  // #182：磁盘在场但运行版本未知——不知道在跑哪版，既不宣称有新版、也不谎称已是最新。
  if (snapshot.installed !== false && snapshot.runningVersion === null) {
    return {
      banner: {
        kind: 'blocked',
        title: copyText('panel.banner.unknown-running-title', l),
        action: copyText('panel.banner.unknown-running-action', l),
      },
      installEnabled: false,
      installLabel: copyText('panel.action.install', l),
      skippedLatest: false,
      showManual: manual ? true : false,
      showReset: false,
      queueNote,
    }
  }
  if (snapshot.canInstall && snapshot.latestVersion) {
    // #197：首次安装（磁盘没有 + 清单未登记的新增依赖）与换版是两种身份，给两张脸。
    // 判不出身份（identity 为 null）时退回旧文案，绝不猜。
    if (snapshot.identity === 'first-install') {
      return {
        banner: {
          kind: 'update',
          title: copyText('panel.banner.first-install-title', l, { latest: snapshot.latestVersion }),
          action: copyText('panel.banner.first-install-action', l),
        },
        installEnabled: true,
        installLabel: copyText('panel.action.first-install-version', l, { latest: snapshot.latestVersion }),
        skippedLatest: false,
        showManual: manual ? true : false,
        showReset: false,
        queueNote,
      }
    }
    // 未装时标题的「当前版本」不许填注入的假版号（#134/US19）：填人话状态词。
    const running =
      snapshot.installed === false
        ? copyText('panel.banner.not-installed', l)
        : snapshot.runningVersion ?? copyText('panel.meta.unknown', l)
    // #156 场景二：记住的窗口正对当前新版——不说"可安装"骗点，主按钮置灰，
    // 横幅说清"哪一版、何时可装、先装合规版"；按钮由内核渲染按同一纯门补［装合规版］。
    if (gated) {
      const unlock = formatUnlockAt(gated.unlockAtMs, l) ?? ''
      return {
        banner: {
          kind: 'update',
          title: copyText('panel.banner.update-gated-title', l, { latest: snapshot.latestVersion, unlock }),
          action: copyText('panel.banner.update-action', l),
        },
        installEnabled: false,
        installLabel: copyText('panel.action.install-version', l, { latest: snapshot.latestVersion }),
        skippedLatest: false,
        showManual: manual ? true : false,
        showReset: false,
        queueNote,
      }
    }
    return {
      banner: {
        kind: 'update',
        title: copyText('panel.banner.update-title', l, { latest: snapshot.latestVersion, running }),
        action: copyText('panel.banner.update-action', l),
      },
      installEnabled: true,
      installLabel: copyText('panel.action.install-version', l, { latest: snapshot.latestVersion }),
      skippedLatest: false,
      showManual: manual ? true : false,
      showReset: false,
      queueNote,
    }
  }
  // 未装且没查到（#134/US16）：永不说「已是最新」；未装状态词 + 需先检查，按钮不可点。
  if (snapshot?.installed === false) {
    return {
      banner: {
        kind: 'idle',
        title: copyText('panel.banner.not-installed', l),
        action: copyText('panel.action.check', l),
      },
      installEnabled: false,
      installLabel: copyText('panel.action.install', l),
      skippedLatest: false,
      showManual: false,
      showReset: false,
      queueNote,
    }
  }
  return {
    banner: { kind: 'done', title: copyText('panel.banner.done', l), action: '' },
    installEnabled: false,
    installLabel: copyText('panel.action.install', l),
    skippedLatest: false,
    showManual: false,
    showReset: false,
    queueNote,
  }
}

/**
 * 检查页预判输入（#156 场景二）：内核把"记住的窗口"翻译成渲染能直接用的三件事——
 * 哪一版（记住的目标版）、何时放行（记住的发布时间 + 窗口）、现在何时（渲染时刻，
 * 纯函数可测）。窗口为 null 即不传本输入（规则三：没有窗口不预判）。
 */
export interface CheckPrejudge {
  targetVersion: string
  unlockAtMs: number
  nowMs: number | null
}

/**
 * 检查页预判门（#156 场景二，纯函数）：四道全过才预判——有输入、可装、有新版、
 * 记住的正是对当前这一版、时钟正常且还没放行。缺一律 null（调用方走正常检查页）。
 * 内核已按记住匹配过一次，这里再验一遍：渲染只信当下快照，不信调用方。
 */
export function checkPrejudgeOfView(
  pre: CheckPrejudge | null | undefined,
  snapshot: UpdateSnapshot | null | undefined,
): { targetVersion: string; unlockAtMs: number } | null {
  try {
    if (!pre || !snapshot?.canInstall) return null
    const latest = typeof snapshot.latestVersion === 'string' ? snapshot.latestVersion.trim() : ''
    const target = typeof pre.targetVersion === 'string' ? pre.targetVersion.trim() : ''
    if (!latest || !target || latest !== target) return null
    if (typeof pre.unlockAtMs !== 'number' || !Number.isFinite(pre.unlockAtMs)) return null
    if (typeof pre.nowMs !== 'number' || !Number.isFinite(pre.nowMs) || pre.nowMs >= pre.unlockAtMs) return null
    return { targetVersion: target, unlockAtMs: pre.unlockAtMs }
  } catch {
    return null
  }
}
