// src/bilingual.ts —— 集中文案底座与单语语义块渲染（#54 底座，#60 起改为单语出口）。
//
// 历史名说明（#60 执行约定命名收敛二选一之二）：文件名 src/bilingual.ts、导出名 BILINGUAL_*、
// 类名 dsh-upd-bi 均为历史名，v2 起为单语出口（一次只渲染一种语言），保留旧名以免门禁白名单与测试大改。
// 地位：唯一新接缝（#57 Testing Decisions 主接缝），最高处，一处覆盖全部消费方。
// 数据层永不拼串：调用方只传 key + 具名值（{version}/{count} 等运行时值），表现层按语义块拼装。
// 分支只认稳定码：本模块不做任何分支，调用方（entry/panel）只用快照 + 稳定码选 key，永不读文案做判断。
//
// 契约（#57 语言契约 v2，取代同显）：
// - 一次只渲染一种语言，语义块仍带 lang 属性（lang="en" 或 lang="zh"，只出现一个）。
// - 核心渲染吃显式 lang 入参、纯函数：copyHTML(key, lang, values) / copyText(key, lang, values)。
// - 变量与自由文本不译：{version}/{count} 等占位原样透传，冻结词元两语言逐字相同。
// - 占位为具名槽：英文语序可与中文不同（format 按名替换，不按位置拼）。
// - draft 诚实态（#53 Q3）：无母语评审即标 draft；底座钉住字典版本开发（BILINGUAL_DICT_VERSION），
//   draft 不卡 #54，转正只换文案不换 key；零 draft 放行由 #56 门禁执行，本模块只提供 draftKeys() 供门禁读。
//
// 范围（#60 两条入口链 + #61 panel 状态与动作 + #62 panel 内核 HTML §3.7 + #63 诊断复制 §3.3/3.4 + #64 panel-batch 聚合总账 §4.1/4.3/4.4/4.5 + #65 panel-batch 行详情回执 §4.2/4.6/4.7 + #66 changelog 运行时 §6.1/ diag 兜底 §7.1）：entry 7 键（#52 §1）+ batch-entry 6 键 + panel 75 键
// （#52 §3.1 16 + §3.2 14 + §3.5 16 + §3.6 18 + §3.8 11）+ diag 35 键（#52 §3.3 13 + §3.4 22（含 3 复用））+ batch-ledger 33 + batch-row 42 + changelog 9 + diag-fallback 16（§7.1 19 行含 3 复用电话表，逐条见 research/52-inventory.md）。
// panel-batch 剩余与验收矩阵由后续票展开，本文件不预占它们的 key（避免双源）。
// CHANGELOG 六类标题唯一源仍是 changelog.ts CATEGORY_ZH，本模块不另起第二套映射（#66 中文「新增（Added）」/英文「Added」由渲染层按 CATEGORY_ZH 现场组装，不进字典）。

import { normalizeLangTag, resolveLang, type AppLang } from './lang.js'

/** 字典版本钉（#53 Q3 解耦）：key 冻即解阻塞 #54，文案按词标 draft/locked；开发钉此版本，转正只换文案不换 key。 */
export const BILINGUAL_DICT_VERSION = '2026-10-06-pin53'

/** key 全集（entry 7 + batch-entry 6 + panel 75（#61）+ kernel 72（#62 §3.7）+ diag 35（#63 §3.3/3.4）+ batch-ledger 33（#64 §4.1/4.3/4.4/4.5）+ batch-row 42（#65 §4.2 13 + §4.6 15 + §4.7 14）+ changelog 9 + diag-fallback 15（#66 §6.1/§7.1），命名沿 #52 key 提案，area.group.name；既有 288 键 en/zh/draft 不动）。 */
export type BilingualKey =
  | 'entry.label.idle'
  | 'entry.label.failed'
  | 'entry.label.busy'
  | 'entry.label.restart'
  | 'entry.label.has-update'
  | 'entry.action.checking'
  | 'entry.note.up-to-date'
  | 'batch-entry.label.idle'
  | 'batch-entry.label.update'
  | 'batch-entry.label.busy'
  | 'batch-entry.label.restart'
  | 'batch-entry.label.failed'
  | 'batch-entry.action.checking'
  | 'panel.blocked.unknown-profile.title'
  | 'panel.blocked.unknown-profile.action'
  | 'panel.blocked.channel-mismatch.title'
  | 'panel.blocked.channel-mismatch.action'
  | 'panel.blocked.source-install.title'
  | 'panel.blocked.source-install.action'
  | 'panel.blocked.invalid-installation.title'
  | 'panel.blocked.invalid-installation.action'
  | 'panel.blocked.installation-changed.title'
  | 'panel.blocked.installation-changed.action'
  | 'panel.blocked.pending-restart.title'
  | 'panel.blocked.pending-restart.action'
  | 'panel.blocked.registry-conflict.title'
  | 'panel.blocked.registry-conflict.action'
  | 'panel.blocked.incompatible-node.title'
  | 'panel.blocked.incompatible-node.action'
  | 'panel.blocked.recovery-required.title'
  | 'panel.blocked.recovery-required.action'
  | 'panel.failure.check-failed.title'
  | 'panel.failure.check-failed.action'
  | 'panel.failure.invalid-release.title'
  | 'panel.failure.invalid-release.action'
  | 'panel.failure.check-expired.title'
  | 'panel.failure.check-expired.action'
  | 'panel.failure.update-busy.title'
  | 'panel.failure.update-busy.action'
  | 'panel.failure.install-failed.title'
  | 'panel.failure.install-failed.action'
  | 'panel.failure.internal.title'
  | 'panel.failure.internal.action'
  | 'panel.failure.unknown.title'
  | 'panel.failure.unknown.action'
  | 'panel.seal.loading.text'
  | 'panel.seal.loading.mini'
  | 'panel.seal.idle.text'
  | 'panel.seal.idle.mini'
  | 'panel.seal.update.text'
  | 'panel.seal.update.mini'
  | 'panel.seal.busy.text'
  | 'panel.seal.busy.mini'
  | 'panel.seal.restart.text'
  | 'panel.seal.restart.mini'
  | 'panel.seal.blocked.text'
  | 'panel.seal.blocked.mini'
  | 'panel.seal.failed.text'
  | 'panel.seal.failed.mini'
  | 'panel.seal.done.text'
  | 'panel.seal.done.mini'
  | 'panel.banner.error.title'
  | 'panel.banner.error.action-fallback'
  | 'panel.action.retry-install'
  | 'panel.banner.loading'
  | 'panel.action.install'
  | 'panel.queue.busy-self'
  | 'panel.queue.busy-queued'
  | 'panel.queue.busy-other'
  | 'panel.skip.skipped-title'
  | 'panel.skip.skipped-action'
  | 'panel.banner.restart-title'
  | 'panel.banner.installing-title'
  | 'panel.banner.installing-action'
  | 'panel.action.installing'
  | 'panel.banner.update-title'
  | 'panel.banner.update-action'
  | 'panel.action.install-version'
  | 'panel.banner.done'
  | 'panel.toast.checking'
  | 'panel.toast.installing'
  | 'panel.toast.copy-manual-ok'
  | 'panel.toast.copy-manual-fail'
  | 'panel.toast.copy-diag-ok'
  | 'panel.toast.copy-diag-fail'
  | 'panel.toast.restart-delegated'
  | 'panel.toast.restart-manual'
  | 'panel.toast.restart-failed'
  | 'panel.toast.copy-state-ok'
  | 'panel.toast.failure-dismissed'
  | 'panel.strip.running'
  | 'panel.strip.installed'
  | 'panel.strip.latest'
  | 'panel.meta.label'
  | 'panel.meta.unknown'
  | 'panel.masthead.kicker'
  | 'panel.masthead.title'
  | 'panel.masthead.volume'
  | 'panel.chapter.check'
  | 'panel.chapter.changelog'
  | 'panel.chapter.queue'
  | 'panel.chapter.error'
  | 'panel.chapter.manual'
  | 'panel.progress.installing'
  | 'panel.progress.verifying'
  | 'panel.action.check'
  | 'panel.action.check-title'
  | 'panel.action.checking-busy'
  | 'panel.action.checking-busy-title'
  | 'panel.action.installing-busy'
  | 'panel.action.installing-busy-title'
  | 'panel.action.install-title'
  | 'panel.action.skip'
  | 'panel.action.skip-title'
  | 'panel.action.unskip'
  | 'panel.action.unskip-title'
  | 'panel.action.copy-manual'
  | 'panel.action.copy-manual-title'
  | 'panel.action.restart-host'
  | 'panel.action.restart-host-title'
  | 'panel.action.dismiss'
  | 'panel.action.dismiss-title'
  | 'panel.action.copy-diag'
  | 'panel.action.copy-diag-title'
  | 'panel.skip.line-tag'
  | 'panel.skip.line-note'
  | 'panel.changelog.heading'
  | 'panel.changelog.heading-range'
  | 'panel.changelog.unavailable'
  | 'panel.changelog.unavailable-empty'
  | 'panel.changelog.toggle-title'
  | 'panel.changelog.expand'
  | 'panel.changelog.collapse'
  | 'panel.queue.state-idle'
  | 'panel.queue.other'
  | 'panel.queue.self'
  | 'panel.queue.pos-absent'
  | 'panel.queue.pos-n'
  | 'panel.queue.pos-next'
  | 'panel.queue.pos-ahead'
  | 'panel.queue.row-installing'
  | 'panel.queue.row-installing-note'
  | 'panel.queue.row-idle-note'
  | 'panel.queue.row-position'
  | 'panel.queue.row-order'
  | 'panel.queue.toggle-hide'
  | 'panel.queue.toggle-show'
  | 'panel.queue.empty'
  | 'panel.error.code-label'
  | 'panel.error.code-note'
  | 'panel.error.query-request'
  | 'panel.error.query-check'
  | 'panel.error.failed-at'
  | 'panel.error.query-keys'
  | 'panel.error.target-version'
  | 'panel.error.evidence-frozen'
  | 'panel.error.evidence-transient'
  | 'panel.error.no-failure'
  | 'panel.error.log-hint'
  | 'panel.error.log-follow'
  | 'panel.manual.heading'
  | 'panel.manual.absent'
  | 'panel.footer.note'
  | 'panel.footer.close'
  | 'panel.footer.close-title'
  | 'panel.diag.header'
  | 'panel.diag.label.human'
  | 'panel.diag.label.running'
  | 'panel.diag.label.installed'
  | 'panel.diag.label.latest'
  | 'panel.diag.queue.installing'
  | 'panel.diag.queue.position'
  | 'panel.diag.queue.absent'
  | 'panel.diag.label.host'
  | 'panel.diag.label.profile'
  | 'panel.diag.label.queue'
  | 'panel.diag.label.request'
  | 'panel.diag.label.manual'
  | 'panel.diag.copy.no-detail'
  | 'panel.diag.copy.unknown-package'
  | 'panel.diag.copy.unknown'
  | 'panel.diag.copy.field.plugin'
  | 'panel.diag.copy.field.version'
  | 'panel.diag.copy.field.host'
  | 'panel.diag.copy.field.profile'
  | 'panel.diag.copy.field.route'
  | 'panel.diag.copy.field.stage'
  | 'panel.diag.copy.field.method'
  | 'panel.diag.copy.field.latency'
  | 'panel.diag.copy.field.registry'
  | 'panel.diag.copy.field.registry-unknown'
  | 'panel.diag.copy.field.action'
  | 'panel.diag.copy.field.request'
  | 'panel.diag.copy.field.check'
  | 'panel.diag.copy.field.queue'
  | 'panel.diag.copy.field.target'
  | 'panel.diag.copy.line.summary'
  | 'panel.diag.copy.line.remedy'
  | 'panel.diag.copy.block.summary'
  | 'panel.diag.copy.block.source'
  | 'panel.diag.copy.block.remedy'
  | 'batch.action.resume'
  | 'batch.action.resume-title'
  | 'batch.action.discard'
  | 'batch.action.confirm-discard'
  | 'batch.fact.close-safe'
  | 'batch.setting.check-on-open'
  | 'batch.row.update'
  | 'batch.row.current'
  | 'batch.row.never'
  | 'batch.row.failed'
  | 'batch.notice.auto-resumed'
  | 'batch.notice.resumed'
  | 'batch.notice.no-resume'
  | 'batch.notice.discarded'
  | 'batch.notice.cancel-confirm'
  | 'batch.notice.busy-cancel'
  | 'batch.row.unfinished-tag'
  | 'batch.summary.updatable'
  | 'batch.summary.installing'
  | 'batch.summary.pending'
  | 'batch.summary.restart'
  | 'batch.summary.failed'
  | 'batch.summary.skipped'
  | 'batch.summary.settled'
  | 'batch.summary.empty'
  | 'batch.header.title'
  | 'batch.action.check'
  | 'batch.action.check-title'
  | 'batch.action.install-all'
  | 'batch.action.install-all-title'
  | 'batch.action.close'
  | 'batch.action.close-title'
  | 'batch.banner.loading'
  | 'batch.hint.error'
  | 'batch.hint.empty'
  | 'batch.hint.installing-queueable'
  | 'batch.hint.installing-auto'
  | 'batch.hint.failed'
  | 'batch.hint.updatable'
  | 'batch.hint.restart'
  | 'batch.hint.pending'
  | 'batch.hint.done'
  | 'batch.seal.ledger'
  | 'batch.banner.error-title'
  | 'batch.banner.error-action-fallback'
  | 'batch.banner.failed-title'
  | 'batch.banner.failed-action'
  | 'batch.banner.restart-title'
  | 'batch.banner.restart-action'
  | 'batch.banner.restart-button'
  | 'batch.row.queued-generic'
  | 'batch.row.queued-n'
  | 'batch.row.skipped'
  | 'batch.row.wait-turn'
  | 'batch.row.checking'
  | 'batch.row.cta-version'
  | 'batch.row.cta-generic'
  | 'batch.row.installing'
  | 'batch.row.done-restart'
  | 'batch.row.done'
  | 'batch.row.failed-retry'
  | 'batch.row.skipped-idle'
  | 'batch.row.unknown'
  | 'batch.row-action.installing'
  | 'batch.row-action.cancel-queue'
  | 'batch.row-action.queue'
  | 'batch.row-action.install-row'
  | 'batch.row-action.retry'
  | 'batch.row-action.install-version'
  | 'batch.row-action.install-generic'
  | 'batch.row-action.unskip'
  | 'batch.row-action.restart'
  | 'batch.row-action.show-detail'
  | 'batch.row-action.hide-detail'
  | 'batch.row-action.skip'
  | 'batch.row-action.copy-manual'
  | 'batch.row-action.copy-diag'
  | 'batch.row.error-label'
  | 'batch.diag.source-job'
  | 'batch.toast.copy-fail'
  | 'batch.toast.queue-missed'
  | 'batch.toast.skipped'
  | 'batch.toast.unskipped-version'
  | 'batch.toast.unskipped-all'
  | 'batch.toast.cancel-unavailable'
  | 'batch.toast.cancel-ok'
  | 'batch.toast.cancel-fail'
  | 'batch.toast.copy-manual-ok'
  | 'batch.toast.copy-diag-ok'
  | 'batch.toast.restart-delegated'
  | 'batch.toast.restart-manual'
  | 'batch.toast.restart-failed'
  | 'changelog.neutral.hint'
  | 'changelog.neutral.line'
  | 'changelog.breaking.badge'
  | 'changelog.breaking.aria'
  | 'changelog.truncated.count'
  | 'changelog.yanked.banner'
  | 'changelog.yanked.suffix'
  | 'changelog.security.summary'
  | 'changelog.security.note'
  | 'diag.fallback.generic'
  | 'diag.fallback.read-installed'
  | 'diag.fallback.revalidate-fetch'
  | 'diag.fallback.rate-limited'
  | 'diag.fallback.http-status'
  | 'diag.fallback.invalid-release'
  | 'diag.fallback.install-failed'
  | 'diag.fallback.unknown-profile'
  | 'diag.fallback.channel-mismatch'
  | 'diag.fallback.source-install'
  | 'diag.fallback.invalid-installation'
  | 'diag.fallback.installation-changed'
  | 'diag.fallback.pending-restart'
  | 'diag.fallback.incompatible-node'
  | 'diag.fallback.registry-conflict'
  | 'diag.fallback.recovery-required'

/** 一条双语：en/zh 模板 + 成熟度。模板内具名槽如 {version}/{count}，运行时值填入（值永不翻译）。 */
export interface BilingualEntry {
  en: string
  zh: string
  /** true=待母语+域内双签（#53 Q3），false=已双签转正。首批与新增全 draft（无评审不假锁）。 */
  draft: boolean
}

/**
 * 集中字典（机器源，类型锁死：Record<BilingualKey, BilingualEntry> 缺键即 tsc 报错）。
 * 人读源为 #57 规格 + #53 结论英文定调；英文终稿待母语评审，故全标 draft（#61/#62/#63 新增亦全 draft）。
 * zh 逐字等于 panel.ts / entry.ts 既有散落文案（兼容既有测试与接入方口径；#63 旧 13/新 22 的 zh 均逐字等于旧复制文本）。
 */
export const BILINGUAL_STRINGS: Record<BilingualKey, BilingualEntry> = {
  'entry.label.idle': { en: 'Check for updates', zh: '检查更新', draft: true },
  'entry.label.failed': { en: 'Update failed — View details', zh: '更新失败，点此查看', draft: true },
  'entry.label.busy': { en: 'Installing…', zh: '正在安装…', draft: true },
  'entry.label.restart': { en: 'Restart required', zh: '待重启', draft: true },
  'entry.label.has-update': { en: 'Update available {version}', zh: '有新版 {version}', draft: true },
  'entry.action.checking': { en: 'Checking for updates…', zh: '正在查新版…', draft: true },
  'entry.note.up-to-date': { en: 'Up to date {version}', zh: '已是最新 {version}', draft: true },
  'batch-entry.label.idle': { en: 'Check for updates', zh: '检查更新', draft: true },
  'batch-entry.label.update': { en: '{count} updates available', zh: '{count} 家可更新', draft: true },
  'batch-entry.label.busy': { en: 'Installing…', zh: '正在安装…', draft: true },
  'batch-entry.label.restart': { en: '{count} restarts required', zh: '{count} 家待重启', draft: true },
  'batch-entry.label.failed': { en: '{count} failed — View details', zh: '{count} 家失败，点此查看', draft: true },
  'batch-entry.action.checking': { en: 'Checking for updates…', zh: '正在查新版…', draft: true },
  'panel.blocked.unknown-profile.title': { en: 'Unrecognized scope or plugin location', zh: '无法识别使用范围或插件安装位置', draft: true },
  'panel.blocked.unknown-profile.action': { en: 'Reopen the host and check again; if it persists, send the version and logs to the plugin author; no manual command is provided for this case.', zh: '重启宿主后重新查询；若持续，请提交版本号与诊断信息至插件作者；此场景不提供手工命令', draft: true },
  'panel.blocked.channel-mismatch.title': { en: 'Installed version is not in the selected release channel', zh: '已安装版本与当前版本通道不符', draft: true },
  'panel.blocked.channel-mismatch.action': { en: 'Switch to the prerelease channel, or install the channel release, then check again.', zh: '切换至预发布通道，或重新安装本通道正式版本后查询', draft: true },
  'panel.blocked.source-install.title': { en: 'Installed from source, not by version', zh: '源码安装实例，不支持版本更新', draft: true },
  'panel.blocked.source-install.action': { en: 'No manual command is provided here; to update, reinstall by version first.', zh: '此场景不提供手工命令；如需更新，请按包名@版本号重新安装', draft: true },
  'panel.blocked.invalid-installation.title': { en: 'Installed package is incomplete (name mismatch, invalid version, or missing entry file)', zh: '已安装包结构不完整（包名 / 版本号 / 入口文件异常）', draft: true },
  'panel.blocked.invalid-installation.action': { en: 'Reinstall the current version to repair the install directory, then check again.', zh: '重新安装当前版本以修复安装目录，然后重新查询更新', draft: true },
  'panel.blocked.installation-changed.title': { en: 'Install location changed during use (directory or package changed)', zh: '安装位置发生变更（目录或包体不一致）', draft: true },
  'panel.blocked.installation-changed.action': { en: 'Reopen the host and check again; if it persists, reinstall.', zh: '重启宿主后重新查询；若持续，请重新安装', draft: true },
  'panel.blocked.pending-restart.title': { en: 'New version is on disk; the running instance is still the old version', zh: '新版本已写入磁盘，当前运行仍为旧版本', draft: true },
  'panel.blocked.pending-restart.action': { en: 'Restart the host to run the new version; this is a normal end state, not a failure.', zh: '重启宿主以加载新版本；此为正常状态，非安装失败', draft: true },
  'panel.blocked.registry-conflict.title': { en: 'Declared version conflicts with the version on disk', zh: '版本声明与磁盘实际版本冲突', draft: true },
  'panel.blocked.registry-conflict.action': { en: 'Open the scope manifest and set the target package line to the version number, then retry.', zh: '核对使用范围清单文件中目标包的版本声明，修正后重试', draft: true },
  'panel.blocked.incompatible-node.title': { en: 'Required Node version does not match the running Node', zh: 'Node 运行时版本不兼容', draft: true },
  'panel.blocked.incompatible-node.action': { en: 'Upgrade Node to 22 or later, then check again.', zh: '请升级 Node 至 22 或更高版本后重新查询', draft: true },
  'panel.blocked.recovery-required.title': { en: 'Last install was interrupted, leaving a partial task', zh: '上次安装异常中断，存在未完成任务', draft: true },
  'panel.blocked.recovery-required.action': { en: 'Run install once more; if it persists, follow section 6 to troubleshoot.', zh: '重新执行安装；若持续，请按第 6 节排错', draft: true },
  'panel.failure.check-failed.title': { en: 'Couldn’t check for updates (network, source, or rate limit)', zh: '版本信息查询失败（网络 / 数据源 / 限流）', draft: true },
  'panel.failure.check-failed.action': { en: 'Try checking again later; if it keeps failing, send the copied diagnostics to the plugin author.', zh: '稍后重新查询；若持续，请提交诊断信息至插件作者', draft: true },
  'panel.failure.invalid-release.title': { en: 'Release info is invalid (bad version or mismatched content)', zh: '发布版本信息无效（版本号非法或内容不一致）', draft: true },
  'panel.failure.invalid-release.action': { en: 'Check the package name and version in the manifest, then check again.', zh: '核对清单文件中的包名与版本声明后重新查询', draft: true },
  'panel.failure.check-expired.title': { en: 'Credentials expired; the install request was rejected', zh: '查询凭证过期，安装请求被拒绝', draft: true },
  'panel.failure.check-expired.action': { en: 'Check for updates again before installing; do not retry with the old ID.', zh: '请重新查询版本信息后安装；请勿复用过期请求编号', draft: true },
  'panel.failure.update-busy.title': { en: 'Another install is running in the same scope', zh: '同一使用范围内存在进行中的安装任务', draft: true },
  'panel.failure.update-busy.action': { en: 'Wait until the current task leaves installing/verifying, then try; check status for your queue position.', zh: '待当前任务退出 installing/verifying 状态后重试；排队期间可查询任务状态确认队列位置', draft: true },
  'panel.failure.install-failed.title': { en: 'Couldn’t install (see the diagnostic summary)', zh: '安装执行失败，详情见诊断摘要', draft: true },
  'panel.failure.install-failed.action': { en: 'Read the copied diagnostics first; on official desktop builds, send it to the plugin author.', zh: '请查阅诊断摘要；官方桌面版请提交该诊断信息至插件作者', draft: true },
  'panel.failure.internal.title': { en: 'Something went wrong; the cause is unknown', zh: '内部错误，原因未知', draft: true },
  'panel.failure.internal.action': { en: 'Retry once first; if it persists, send the copied diagnostics to the plugin author.', zh: '请重试一次；若持续，请提交诊断信息至插件作者', draft: true },
  'panel.failure.unknown.title': { en: 'Something went wrong; the cause is unknown', zh: '内部错误，原因未知', draft: true },
  'panel.failure.unknown.action': { en: 'Retry once first; if it persists, send the copied diagnostics to the plugin author (include the code you saw).', zh: '请重试一次；若持续，请提交诊断信息至插件作者（请一并提交所见错误码）', draft: true },
  'panel.seal.loading.text': { en: 'Not checked', zh: '待查', draft: true },
  'panel.seal.loading.mini': { en: 'Check', zh: '查', draft: true },
  'panel.seal.idle.text': { en: 'Not checked', zh: '待查', draft: true },
  'panel.seal.idle.mini': { en: 'Check', zh: '查', draft: true },
  'panel.seal.update.text': { en: 'Update available', zh: '可装', draft: true },
  'panel.seal.update.mini': { en: 'Install', zh: '装', draft: true },
  'panel.seal.busy.text': { en: 'Installing', zh: '安装中', draft: true },
  'panel.seal.busy.mini': { en: 'Install', zh: '装', draft: true },
  'panel.seal.restart.text': { en: 'Restart required', zh: '待重启', draft: true },
  'panel.seal.restart.mini': { en: 'Restart', zh: '启', draft: true },
  'panel.seal.blocked.text': { en: 'Blocked — Action needed', zh: '受阻', draft: true },
  'panel.seal.blocked.mini': { en: 'Blocked', zh: '阻', draft: true },
  'panel.seal.failed.text': { en: 'Failed — Retry available', zh: '受阻', draft: true },
  'panel.seal.failed.mini': { en: 'Failed', zh: '阻', draft: true },
  'panel.seal.done.text': { en: 'Up to date', zh: '已最新', draft: true },
  'panel.seal.done.mini': { en: 'Done', zh: '定', draft: true },
  'panel.banner.error.title': { en: 'Update failed ({code}): {detail}.', zh: '更新失败（{code}）：{detail}。', draft: true },
  'panel.banner.error.action-fallback': { en: 'Copy the diagnostics for the plugin author; see the log channel for details.', zh: '复制诊断发给插件作者；深挖看日志通道。', draft: true },
  'panel.action.retry-install': { en: 'Retry install', zh: '重试安装', draft: true },
  'panel.banner.loading': { en: 'Loading update status…', zh: '正在读取更新状态…', draft: true },
  'panel.action.install': { en: 'Install update', zh: '安装更新', draft: true },
  'panel.queue.busy-self': { en: 'Installing (this plugin is installing).', zh: '正在安装（本插件在装）。', draft: true },
  'panel.queue.busy-queued': { en: 'An install is running ahead; this plugin is #{n} in queue. Install when it reaches the front.', zh: '前方有安装在进行，本插件排第 {n} 位，到队首再点安装。', draft: true },
  'panel.queue.busy-other': { en: 'Another plugin is installing; retry later.', zh: '前方有其他插件在安装，稍后重试。', draft: true },
  'panel.skip.skipped-title': { en: 'Skipped {latest}', zh: '已跳过 {latest}', draft: true },
  'panel.skip.skipped-action': { en: 'Select “Restore” to be reminded of this version again; newer versions will still notify.', zh: '点“恢复”可重新提醒该版本；有更新的新版本会照常提醒。', draft: true },
  'panel.banner.restart-title': { en: 'Version {latest} is installed; restart the host to take effect.', zh: '新版 {latest} 已安装，重启宿主后生效。', draft: true },
  'panel.banner.installing-title': { en: 'Installing {version}… Closing the panel won’t interrupt it.', zh: '正在安装 {version}…关闭面板不会中断。', draft: true },
  'panel.banner.installing-action': { en: 'Progress refreshes automatically; reopening the panel restores the view within a second.', zh: '进度按轮询自动刷新；重开面板 1 秒内恢复显示。', draft: true },
  'panel.action.installing': { en: 'Installing…', zh: '安装中…', draft: true },
  'panel.banner.update-title': { en: 'Update available: {latest} (current: {running}).', zh: '有新版 {latest} 可装（当前 {running}）。', draft: true },
  'panel.banner.update-action': { en: 'Install runs the exact version; only one install runs per scope at a time.', zh: '点安装即走精确版本安装；同一使用范围同时只装一个。', draft: true },
  'panel.action.install-version': { en: 'Install {latest}', zh: '安装 {latest}', draft: true },
  'panel.banner.done': { en: 'Up to date. No update needed.', zh: '已是最新，无需更新。', draft: true },
  'panel.toast.checking': { en: 'Checking for updates…', zh: '正在查新版…', draft: true },
  'panel.toast.installing': { en: 'Installing…', zh: '正在安装…', draft: true },
  'panel.toast.copy-manual-ok': { en: 'Manual command copied; paste the full line into the terminal to run it.', zh: '手工命令已复制，粘到终端整行执行即可。', draft: true },
  'panel.toast.copy-manual-fail': { en: 'Copy failed; please select the command above manually.', zh: '复制失败，请手动选中上面的命令。', draft: true },
  'panel.toast.copy-diag-ok': { en: 'Diagnostics copied; paste it to the plugin author (already redacted).', zh: '诊断已复制，直接粘给插件作者即可（已脱敏）。', draft: true },
  'panel.toast.copy-diag-fail': { en: 'Copy failed; please select the info above manually.', zh: '复制失败，请手动选中上面的信息。', draft: true },
  'panel.toast.restart-delegated': { en: 'Handled by the caller’s restart flow; the new version takes effect after restart.', zh: '已按调用方的重启流程处理；重启后新版生效。', draft: true },
  'panel.toast.restart-manual': { en: 'This host provides no restart entry; please restart the host manually. The new version takes effect after restart.', zh: '本宿主未提供重启入口：请手动重启宿主，重启后新版生效。', draft: true },
  'panel.toast.restart-failed': { en: 'Restart entry failed; please restart the host manually. The new version takes effect after restart.', zh: '重启入口调用失败：请手动重启宿主，重启后新版生效。', draft: true },
  'panel.toast.copy-state-ok': { en: 'Current state copied (no failure); paste it to the plugin author (already redacted).', zh: '已复制当前状态（无失败），直接粘给插件作者即可（已脱敏）。', draft: true },
  'panel.toast.failure-dismissed': { en: 'Failure acknowledged; it will be re-evaluated on the next check or install.', zh: '已确认该失败提示；下次查新版或安装将重新评估。', draft: true },
  'panel.strip.running': { en: 'Running', zh: '运行', draft: true },
  'panel.strip.installed': { en: 'Installed', zh: '磁盘', draft: true },
  'panel.strip.latest': { en: 'Latest', zh: '远端', draft: true },
  'panel.meta.label': { en: 'Scope', zh: '使用范围', draft: true },
  'panel.meta.unknown': { en: 'Unknown', zh: '未知', draft: true },
  'panel.masthead.kicker': { en: 'Plugin update', zh: '插件更新', draft: true },
  'panel.masthead.title': { en: 'Update archive', zh: '更新档案', draft: true },
  'panel.masthead.volume': { en: 'Vol.', zh: '卷', draft: true },
  'panel.chapter.check': { en: 'Check and install', zh: '检查与安装', draft: true },
  'panel.chapter.changelog': { en: 'Changelog', zh: '更新日志', draft: true },
  'panel.chapter.queue': { en: 'Update queue', zh: '更新队列', draft: true },
  'panel.chapter.error': { en: 'Error details', zh: '错误信息', draft: true },
  'panel.chapter.manual': { en: 'Manual command', zh: '手工命令', draft: true },
  'panel.progress.installing': { en: 'Installing new version…', zh: '正在安装新版…', draft: true },
  'panel.progress.verifying': { en: 'Verifying install result…', zh: '正在校验安装结果…', draft: true },
  'panel.action.check': { en: 'Check for updates', zh: '查新版', draft: true },
  'panel.action.check-title': { en: 'Check the official source once more (read-only, never installs)', zh: '重新向官方源查一次新版（只读，不安装）', draft: true },
  'panel.action.checking-busy': { en: 'Checking for updates…', zh: '正在查新版…', draft: true },
  'panel.action.checking-busy-title': { en: 'Checking the official source; please wait', zh: '正在向官方源查询，请稍候', draft: true },
  'panel.action.installing-busy': { en: 'Installing…', zh: '正在安装…', draft: true },
  'panel.action.installing-busy-title': { en: 'Installing; please wait', zh: '正在安装，请稍候', draft: true },
  'panel.action.install-title': { en: 'Install the exact version; one install per scope at a time', zh: '用精确版本安装；同一使用范围同时只装一个', draft: true },
  'panel.action.skip': { en: 'Skip this version', zh: '跳过该版本', draft: true },
  'panel.action.skip-title': { en: 'This version will no longer notify; newer versions still will', zh: '该版本不再提醒；有更新的新版本照常提醒', draft: true },
  'panel.action.unskip': { en: 'Restore ({version})', zh: '恢复（{version}）', draft: true },
  'panel.action.unskip-title': { en: 'Undo skip; this version will remind again', zh: '撤销跳过，该版本重新提醒', draft: true },
  'panel.action.copy-manual': { en: 'Copy manual command', zh: '复制手工命令', draft: true },
  'panel.action.copy-manual-title': { en: 'Copy the manual command; paste the full line into the terminal', zh: '复制手工命令，粘到终端整行执行', draft: true },
  'panel.action.restart-host': { en: 'Please restart DSH', zh: '请重启DSH', draft: true },
  'panel.action.restart-host-title': { en: 'Run the caller restart flow if available, otherwise restart DSH manually', zh: '点一下走调用方流程，没有就手动重启 DSH', draft: true },
  'panel.action.dismiss': { en: 'Got it', zh: '知道了', draft: true },
  'panel.action.dismiss-title': { en: 'Acknowledge the failure and return; next check or install will re-evaluate', zh: '确认已知晓该失败：回到可装页，下次查/装将重新评估', draft: true },
  'panel.action.copy-diag': { en: 'Copy diagnostics', zh: '复制诊断', draft: true },
  'panel.action.copy-diag-title': { en: 'Copy redacted diagnostics for the plugin author', zh: '复制已脱敏诊断，直接粘给插件作者', draft: true },
  'panel.skip.line-tag': { en: 'Skipped {version}', zh: '已跳过 {version}', draft: true },
  'panel.skip.line-note': { en: 'Select \u201CRestore\u201D to undo; this version will remind again.', zh: '点「恢复」可撤销，之后这一版还会再提醒。', draft: true },
  'panel.changelog.heading': { en: 'Changelog:', zh: '更新说明：', draft: true },
  'panel.changelog.heading-range': { en: 'Changelog ({from} \u2192 {to}):', zh: '更新说明（{from} → {to}）：', draft: true },
  'panel.changelog.unavailable': { en: 'Could not read logs; install is unaffected.', zh: '日志读不出来，安装不受影响。', draft: true },
  'panel.changelog.unavailable-empty': { en: 'No release found yet; logs will show after a check.', zh: '还没查到新版；查到后再显示日志。', draft: true },
  'panel.changelog.toggle-title': { en: 'Expand or collapse changelog', zh: '展开或收起更新日志', draft: true },
  'panel.changelog.expand': { en: 'Expand changelog', zh: '展开更新日志', draft: true },
  'panel.changelog.collapse': { en: 'Collapse changelog', zh: '收起更新日志', draft: true },
  'panel.queue.state-idle': { en: 'Idle', zh: '空闲', draft: true },
  'panel.queue.other': { en: 'Other plugin', zh: '其他插件', draft: true },
  'panel.queue.self': { en: 'This plugin', zh: '本插件', draft: true },
  'panel.queue.pos-absent': { en: 'Not queued', zh: '未排队', draft: true },
  'panel.queue.pos-n': { en: 'Position {n}', zh: '第 {n} 位', draft: true },
  'panel.queue.pos-next': { en: 'You are next', zh: '下一个就是你', draft: true },
  'panel.queue.pos-ahead': { en: '{n} ahead', zh: '前方 {n} 个', draft: true },
  'panel.queue.row-installing': { en: 'Installing', zh: '正在安装', draft: true },
  'panel.queue.row-installing-note': { en: 'You are next when it finishes', zh: '装完自动轮到你', draft: true },
  'panel.queue.row-idle-note': { en: 'One install per scope at a time', zh: '同一使用范围一次只装一个', draft: true },
  'panel.queue.row-position': { en: 'Your position', zh: '你的顺位', draft: true },
  'panel.queue.row-order': { en: 'Queue order', zh: '排队顺序', draft: true },
  'panel.queue.toggle-hide': { en: 'Hide others', zh: '隐藏他人明细', draft: true },
  'panel.queue.toggle-show': { en: 'Show others', zh: '显示其他插件', draft: true },
  'panel.queue.empty': { en: 'No queued tasks; one install per scope at a time.', zh: '当前没有排队任务，同一使用范围一次只装一个。', draft: true },
  'panel.error.code-label': { en: 'Stable code', zh: '稳定码', draft: true },
  'panel.error.code-note': { en: 'The line above tells you what to do; to report upstream, paste \u201CCopy diagnostics\u201D as a whole (already redacted).', zh: '上一条中文说明就是要用户做的事；要往上游报，用「复制诊断」整段粘（已脱敏）。', draft: true },
  'panel.error.query-request': { en: 'Request', zh: '请求', draft: true },
  'panel.error.query-check': { en: 'Check', zh: '检查', draft: true },
  'panel.error.failed-at': { en: 'Failed at {time}', zh: '失败于 {time}', draft: true },
  'panel.error.query-keys': { en: 'Query keys: {keys} (use them to match in logs).', zh: '本次查询键：{keys}（拿着它们去日志里对）。', draft: true },
  'panel.error.target-version': { en: 'Failed target {version}', zh: '失败目标 {version}', draft: true },
  'panel.error.evidence-frozen': { en: 'Evidence frozen: the code, versions, and IDs in copied diagnostics are from the failure moment and do not refresh with polling; the next check or install will update them.', zh: '证据已冻结：复制诊断里的码、版本、编号都取自失败时刻，不随轮询刷新；下一次查新版或安装会更新它。', draft: true },
  'panel.error.evidence-transient': { en: 'Transient read failure: it clears on the next successful read; if it persists, troubleshoot by stable code.', zh: '读数瞬态失败：下一次成功读数会自动解除；一直出现再按稳定码排查。', draft: true },
  'panel.error.no-failure': { en: 'No failure: copying diagnostics gives the current state snapshot.', zh: '暂无失败：此时复制诊断给出的是当前状态快照。', draft: true },
  'panel.error.log-hint': { en: 'Check logs: filter by plugin ID {pluginId} for events {e1}, {e2}, {e3}.', zh: '深挖看日志：按插件标识 {pluginId} 过滤 {e1}、{e2}、{e3} 三个事件。', draft: true },
  'panel.error.log-follow': { en: 'Match the request/check IDs above in {eFail}; baseline timing in {eCall}, execution result in {eExec}.', zh: '凭上面的请求／检查编号在 {eFail} 里对上；基线耗时看 {eCall}，执行结果看 {eExec}。', draft: true },
  'panel.manual.heading': { en: 'Manual fallback command (copy the full line to run):', zh: '手工兜底命令（复制整行执行）：', draft: true },
  'panel.manual.absent': { en: 'No manual command available (unrecognized scope or source install).', zh: '当前没有可用的手工命令（使用范围无法识别或源码安装场景不提供）。', draft: true },
  'panel.footer.note': { en: 'Closing never interrupts updates; come back anytime', zh: '关闭不影响更新，可随时回来查看', draft: true },
  'panel.footer.close': { en: 'Close', zh: '关闭', draft: true },
  'panel.footer.close-title': { en: 'Close the window; updates keep running', zh: '关闭窗口，更新不受影响', draft: true },
  'panel.diag.header': { en: '[Update Diagnostics] {pluginId} Stable code: {code}', zh: '[更新诊断] {pluginId} 稳定码：{code}', draft: true },
  'panel.diag.label.human': { en: 'Detail: {detail}', zh: '人话：{detail}', draft: true },
  'panel.diag.label.running': { en: 'Running: {version}', zh: '运行版：{version}', draft: true },
  'panel.diag.label.installed': { en: 'Installed: {version}', zh: '已装：{version}', draft: true },
  'panel.diag.label.latest': { en: 'Latest: {version}', zh: '远端：{version}', draft: true },
  'panel.diag.queue.installing': { en: 'Installing', zh: '正在安装', draft: true },
  'panel.diag.queue.position': { en: 'Queued at position {n}', zh: '排队第 {n} 位', draft: true },
  'panel.diag.queue.absent': { en: 'Not queued', zh: '不在队列里', draft: true },
  'panel.diag.label.host': { en: 'Host: {host}', zh: '宿主：{host}', draft: true },
  'panel.diag.label.profile': { en: 'Scope: {profile}', zh: '使用范围：{profile}', draft: true },
  'panel.diag.label.queue': { en: 'Queue: {queue}', zh: '队列：{queue}', draft: true },
  'panel.diag.label.request': { en: 'Request ID: {requestId}', zh: '请求编号：{requestId}', draft: true },
  'panel.diag.label.manual': { en: 'Manual command: {manual}', zh: '手工命令：{manual}', draft: true },
  'panel.diag.copy.no-detail': { en: '(This response carries no diagnostic summary; it will be completed when phone-side diag lands)', zh: '（本回包没有带诊断摘要，等电话侧 diag 落定后补齐）', draft: true },
  'panel.diag.copy.unknown-package': { en: '(Unknown package)', zh: '(未知包)', draft: true },
  'panel.diag.copy.unknown': { en: 'Unknown', zh: '未知', draft: true },
  'panel.diag.copy.field.plugin': { en: 'Plugin={plugin}', zh: '插件={plugin}', draft: true },
  'panel.diag.copy.field.version': { en: 'Version={run}→{inst}', zh: '版本={run}→{inst}', draft: true },
  'panel.diag.copy.field.host': { en: 'Host={host}', zh: '宿主={host}', draft: true },
  'panel.diag.copy.field.profile': { en: 'Scope={profile}', zh: '使用范围={profile}', draft: true },
  'panel.diag.copy.field.route': { en: 'Route={route}', zh: '路由={route}', draft: true },
  'panel.diag.copy.field.stage': { en: 'Stage={stage}', zh: '阶段={stage}', draft: true },
  'panel.diag.copy.field.method': { en: 'Method={method}', zh: '方法={method}', draft: true },
  'panel.diag.copy.field.latency': { en: 'Latency={latency}', zh: '耗时={latency}', draft: true },
  'panel.diag.copy.field.registry': { en: 'Source={host}', zh: '源={host}', draft: true },
  'panel.diag.copy.field.registry-unknown': { en: 'Source=Unknown (Omitted for non-official sources, which is itself information)', zh: '源=未知（非官方源时省略本身即信息）', draft: true },
  'panel.diag.copy.field.action': { en: 'Suggestion={action}', zh: '建议={action}', draft: true },
  'panel.diag.copy.field.request': { en: 'Request={request}', zh: '请求={request}', draft: true },
  'panel.diag.copy.field.check': { en: 'Check={check}', zh: '检查={check}', draft: true },
  'panel.diag.copy.field.queue': { en: 'Queue={queue}', zh: '队列={queue}', draft: true },
  'panel.diag.copy.field.target': { en: 'Target={version}', zh: '目标={version}', draft: true },
  'panel.diag.copy.line.summary': { en: 'Summary={summary}', zh: '摘要={summary}', draft: true },
  'panel.diag.copy.line.remedy': { en: 'Remedy={remedy}', zh: '怎么办={remedy}', draft: true },
  'panel.diag.copy.block.summary': { en: 'Summary：{summary}', zh: '摘要：{summary}', draft: true },
  'panel.diag.copy.block.source': { en: 'Source：{source}', zh: '来源：{source}', draft: true },
  'panel.diag.copy.block.remedy': { en: 'Remedy：{remedy}', zh: '怎么办：{remedy}', draft: true },
  'batch.action.resume': { en: 'Continue the unfinished batch ({count} left)', zh: '继续上次未完成的更新（还剩 {count} 家）', draft: true },
  'batch.action.resume-title': { en: 'Continue from where it stopped; installed ones stay', zh: '从上次没做完的地方接着安装，已完成的不重装', draft: true },
  'batch.action.discard': { en: 'Discard this unfinished batch (installed ones stay)', zh: '丢弃这批未完成的更新（已完成的保留）', draft: true },
  'batch.action.confirm-discard': { en: 'Confirm discard', zh: '确认丢弃', draft: true },
  'batch.fact.close-safe': { en: 'Closing this panel won\'t stop it \u2014 progress is saved on disk.', zh: '关掉面板不会中断：进度已写盘，回来可继续。', draft: true },
  'batch.setting.check-on-open': { en: 'Check for updates when opening', zh: '打开面板时自动检查更新', draft: true },
  'batch.row.update': { en: 'Update available {version}', zh: '有新版 {version}', draft: true },
  'batch.row.current': { en: 'Up to date', zh: '已是最新，不用动', draft: true },
  'batch.row.never': { en: 'Not checked yet', zh: '还没查过', draft: true },
  'batch.row.failed': { en: 'Last check failed', zh: '这次没查到', draft: true },
  'batch.notice.auto-resumed': { en: 'Auto-continued the unfinished batch ({count} left).', zh: '已自动继续上次未完成的更新（还剩 {count} 家）。', draft: true },
  'batch.notice.resumed': { en: 'Continued the unfinished batch ({count} left).', zh: '已继续上次未完成的更新（还剩 {count} 家）。', draft: true },
  'batch.notice.no-resume': { en: 'Nothing to continue.', zh: '没有可继续的内容。', draft: true },
  'batch.notice.discarded': { en: 'Discarded this unfinished batch (installed ones stay).', zh: '已丢弃这批未完成的更新（已完成的保留）。', draft: true },
  'batch.notice.cancel-confirm': { en: 'Click again to confirm discard.', zh: '再点一次确认丢弃。', draft: true },
  'batch.notice.busy-cancel': { en: 'An install is running and cannot be stopped.', zh: '正在装的那一家停不了。', draft: true },
  'batch.row.unfinished-tag': { en: 'unfinished last time', zh: '上一批没做完', draft: true },
  'batch.summary.updatable': { en: '{n} updates available', zh: '{n} 家可更新', draft: true },
  'batch.summary.installing': { en: '{n} installing', zh: '{n} 家安装中', draft: true },
  'batch.summary.pending': { en: '{n} not checked', zh: '{n} 家待查', draft: true },
  'batch.summary.restart': { en: '{n} restart required', zh: '{n} 家待重启', draft: true },
  'batch.summary.failed': { en: '{n} failed', zh: '{n} 家失败', draft: true },
  'batch.summary.skipped': { en: '{n} skipped', zh: '{n} 家已跳过', draft: true },
  'batch.summary.settled': { en: '{n} up to date', zh: '{n} 家已最新', draft: true },
  'batch.summary.empty': { en: 'No targets yet', zh: '还没有目标', draft: true },
  'batch.header.title': { en: 'Update archive', zh: '更新档案', draft: true },
  'batch.action.check': { en: 'Check for updates', zh: '检查更新', draft: true },
  'batch.action.check-title': { en: 'Re-read batch status (read-only)', zh: '重新读取批量状态（只读）', draft: true },
  'batch.action.install-all': { en: 'Update all', zh: '全部更新', draft: true },
  'batch.action.install-all-title': { en: 'Submit all updatable plugins at once; one idempotency key per session', zh: '把有新版的几家一次提交；同一会话同一幂等编号', draft: true },
  'batch.action.close': { en: 'Close', zh: '关闭', draft: true },
  'batch.action.close-title': { en: 'Close the window; batch progress keeps running', zh: '关闭窗口，批量更新不受影响', draft: true },
  'batch.banner.loading': { en: 'Loading batch update status\u2026', zh: '正在读取批量更新状态…', draft: true },
  'batch.hint.error': { en: 'Last run failed: follow the red banner below.', zh: '刚才那次没成功：看下面的红条，照它说的做一次。', draft: true },
  'batch.hint.empty': { en: 'No targets yet: select \u201CCheck for updates\u201D to see which plugins have updates.', zh: '还没有目标：点「检查更新」看看哪几家有新版。', draft: true },
  'batch.hint.installing-queueable': { en: 'Installing {a}; {b} more can join the queue.', zh: '正在安装 {a} 家；还有 {b} 家可以点「加入队列」排队等。', draft: true },
  'batch.hint.installing-auto': { en: 'Installing {a}; the next starts automatically.', zh: '正在安装 {a} 家，安装完自动下一家。', draft: true },
  'batch.hint.failed': { en: '{n} failed to install; retry each one from the failure notes below.', zh: '{n} 家安装失败；照下面的失败提示逐家重试。', draft: true },
  'batch.hint.updatable': { en: '{n} updates available; select \u201CUpdate all\u201D to install at once, or install each one inline.', zh: '{n} 家可更新；点「全部更新」一次安装完，也可以逐家点「安装这家」。', draft: true },
  'batch.hint.restart': { en: '{n} installed; restart the host to take effect.', zh: '{n} 家已安装好，重启宿主后生效。', draft: true },
  'batch.hint.pending': { en: '{n} not checked yet; select \u201CCheck for updates\u201D for a round.', zh: '{n} 家还没查过；点「检查更新」查一轮。', draft: true },
  'batch.hint.done': { en: 'All up to date; nothing to do.', zh: '全部已最新，没有要做的。', draft: true },
  'batch.seal.ledger': { en: 'Ledger', zh: '总账', draft: true },
  'batch.banner.error-title': { en: 'Failed this time ({code}): {detail}.', zh: '这次没成功（{code}）：{detail}。', draft: true },
  'batch.banner.error-action-fallback': { en: 'Retry once first; if it persists, send the copied diagnostics to the plugin author.', zh: '请重试一次；若持续，请提交诊断信息至插件作者。', draft: true },
  'batch.banner.failed-title': { en: '{n} failed to install.', zh: '{n} 家安装失败。', draft: true },
  'batch.banner.failed-action': { en: 'Retry each one inline; if it keeps failing, send the copied diagnostics to the plugin author.', zh: '请逐家使用行内「重试」；若持续，请提交诊断信息至插件作者。', draft: true },
  'batch.banner.restart-title': { en: '{n} installed; restart the host to take effect.', zh: '{n} 家已安装好，重启宿主后生效。', draft: true },
  'batch.banner.restart-action': { en: 'Restart the host to run the new version; this is a normal end state, not a failure.', zh: '重启宿主以加载新版本；此为正常状态，非安装失败。', draft: true },
  'batch.banner.restart-button': { en: 'Please restart DSH', zh: '请重启DSH', draft: true },
  'batch.row.queued-generic': { en: 'Queued \u00b7 waiting for the running install to finish', zh: '已排队 \u00b7 等前面安装完', draft: true },
  'batch.row.queued-n': { en: 'Queued \u00b7 {n} ahead', zh: '已排队 \u00b7 前方 {n} 个', draft: true },
  'batch.row.skipped': { en: 'Skipped {version}', zh: '已跳过 {version}', draft: true },
  'batch.row.wait-turn': { en: 'Waiting for its turn; it will check automatically', zh: '等它，轮到就自动查新版', draft: true },
  'batch.row.checking': { en: 'Checking for updates; please wait', zh: '正在查新版，稍等', draft: true },
  'batch.row.cta-version': { en: 'Select \u201cInstall this plugin\u201d to install {version}', zh: '点\u300c安装这家\u300d安装 {version}', draft: true },
  'batch.row.cta-generic': { en: 'Select \u201cInstall this plugin\u201d to install the new version', zh: '点\u300c安装这家\u300d安装新版', draft: true },
  'batch.row.installing': { en: 'Installing; please wait', zh: '正在安装，别动', draft: true },
  'batch.row.done-restart': { en: 'Installed; restart the host to take effect', zh: '安装好了，重启宿主才生效', draft: true },
  'batch.row.done': { en: 'Installed; nothing to do', zh: '安装好了，不用动', draft: true },
  'batch.row.failed-retry': { en: 'Install failed; select \u201cRetry\u201d to try again', zh: '安装没成功，点\u300c重试\u300d再来一次', draft: true },
  'batch.row.skipped-idle': { en: 'This version is skipped; nothing to do', zh: '这一版已跳过，不用动', draft: true },
  'batch.row.unknown': { en: 'Unknown state; select \u201cCheck for updates\u201d to check again', zh: '状态认不出，点\u300c检查更新\u300d重查一次', draft: true },
  'batch.row-action.installing': { en: 'Installing\u2026', zh: '安装中\u2026', draft: true },
  'batch.row-action.cancel-queue': { en: 'Cancel queue', zh: '取消排队', draft: true },
  'batch.row-action.queue': { en: 'Join queue', zh: '加入队列', draft: true },
  'batch.row-action.install-row': { en: 'Install this plugin', zh: '安装这家', draft: true },
  'batch.row-action.retry': { en: 'Retry', zh: '重试', draft: true },
  'batch.row-action.install-version': { en: 'Install {version}', zh: '安装 {version}', draft: true },
  'batch.row-action.install-generic': { en: 'Install the new version', zh: '安装 新版', draft: true },
  'batch.row-action.unskip': { en: 'Restore ({version})', zh: '恢复（{version}）', draft: true },
  'batch.row-action.restart': { en: 'Please restart DSH', zh: '请重启DSH', draft: true },
  'batch.row-action.show-detail': { en: 'Details', zh: '详情', draft: true },
  'batch.row-action.hide-detail': { en: 'Collapse', zh: '收起', draft: true },
  'batch.row-action.skip': { en: 'Skip this version', zh: '跳过这一版', draft: true },
  'batch.row-action.copy-manual': { en: 'Copy manual command', zh: '复制手工命令', draft: true },
  'batch.row-action.copy-diag': { en: 'Copy diagnostics', zh: '复制诊断', draft: true },
  'batch.row.error-label': { en: 'Failed {code}: {detail}', zh: '失败 {code}：{detail}', draft: true },
  'batch.diag.source-job': { en: '(Source: background job record)', zh: '（来源：后台任务收尾记录）', draft: true },
  'batch.toast.copy-fail': { en: 'Copy failed; please select the info above manually.', zh: '复制失败，请手动选中上面的信息。', draft: true },
  'batch.toast.queue-missed': { en: 'Another install is running: this plugin is not queued yet; try again after it finishes.', zh: '前面还在装：这一家还没排上，等那家装完再点一次。', draft: true },
  'batch.toast.skipped': { en: 'Skipped {version}: no further reminders for this version; select \u201cRestore\u201d to undo.', zh: '已跳过 {version}：这一版不再提醒；点\u300c恢复\u300d可撤销。', draft: true },
  'batch.toast.unskipped-version': { en: 'Restored {version}: reminders for this version are back on.', zh: '已恢复 {version}：这一版会照常提醒。', draft: true },
  'batch.toast.unskipped-all': { en: 'Skip reminder restored.', zh: '已恢复跳过提醒。', draft: true },
  'batch.toast.cancel-unavailable': { en: 'This row carries no phone or ID to cancel the queue; try again after the next refresh.', zh: '这一行没带取消排队要用的电话名或编号，暂不能取消：等下一次刷新再看。', draft: true },
  'batch.toast.cancel-ok': { en: 'Queue cancelled: this plugin will not wait.', zh: '已取消排队：这一家不等了。', draft: true },
  'batch.toast.cancel-fail': { en: 'Could not cancel the queue (it may have started installing); see the latest state below.', zh: '取消排队没成功（可能已经开始装了）：看下面最新状态。', draft: true },
  'batch.toast.copy-manual-ok': { en: 'Manual command copied; paste the full line into the terminal to run it.', zh: '手工命令已复制，粘到终端整行执行即可。', draft: true },
  'batch.toast.copy-diag-ok': { en: 'Diagnostics copied; paste it to the plugin author (already redacted).', zh: '诊断已复制，直接粘给插件作者即可（已脱敏）。', draft: true },
  'batch.toast.restart-delegated': { en: 'Handled by the caller\u2019s restart flow; the new version takes effect after restart.', zh: '已按调用方的重启流程处理；重启后新版生效。', draft: true },
  'batch.toast.restart-manual': { en: 'This host provides no restart entry; please restart the host manually. The new version takes effect after restart.', zh: '本宿主未提供重启入口：请手动重启宿主，重启后新版生效。', draft: true },
  'batch.toast.restart-failed': { en: 'Restart entry failed; please restart the host manually. The new version takes effect after restart.', zh: '重启入口调用失败：请手动重启宿主，重启后新版生效。', draft: true },
  'changelog.neutral.hint': { en: 'No changelog provided', zh: '作者未提供更新说明', draft: true },
  'changelog.neutral.line': { en: 'No changelog provided. Install is not affected.', zh: '作者未提供更新说明，安装不受影响。', draft: true },
  'changelog.breaking.badge': { en: 'Breaking', zh: '不兼容', draft: true },
  'changelog.breaking.aria': { en: 'Breaking change', zh: '破坏性变更', draft: true },
  'changelog.truncated.count': { en: 'Showing {n} of {m} items', zh: '共 {m} 条，仅显示前 {n} 条', draft: true },
  'changelog.yanked.banner': { en: 'Version {version} was yanked by the author. Install is not affected. Please confirm before proceeding.', zh: '目标版本 {version} 已被作者撤回（yanked），安装不受影响，继续前请确认。', draft: true },
  'changelog.yanked.suffix': { en: ' · Yanked', zh: ' · 已撤回', draft: true },
  'changelog.security.summary': { en: '{n} more items', zh: '其余 {n} 条', draft: true },
  'changelog.security.note': { en: 'Remaining entries are collapsed to keep the panel fast. See the original text.', zh: '为保持面板性能，其余条目已折叠，可查看原文。', draft: true },
  'diag.fallback.generic': { en: 'Operation failed', zh: '操作失败', draft: true },
  'diag.fallback.read-installed': { en: 'Failed to read local state', zh: '读取本地状态失败', draft: true },
  'diag.fallback.revalidate-fetch': { en: 'Revalidation fetch failed before install', zh: '安装前复验失败，未能获取版本信息', draft: true },
  'diag.fallback.rate-limited': { en: 'Source returned 429. Too many requests this minute.', zh: '源返回 429，这一分钟请求太多', draft: true },
  'diag.fallback.http-status': { en: 'Source returned {status}. Retry still failed.', zh: '源返回 {status}，重试仍失败', draft: true },
  'diag.fallback.invalid-release': { en: 'Version in the manifest is not valid', zh: '清单文件中版本号非法', draft: true },
  'diag.fallback.install-failed': { en: 'Install failed', zh: '安装执行失败', draft: true },
  'diag.fallback.unknown-profile': { en: 'Scope or plugin location not recognized', zh: '无法识别使用范围或插件安装位置', draft: true },
  'diag.fallback.channel-mismatch': { en: 'Installed version is not in the selected release channel', zh: '已安装版本与当前版本通道不符', draft: true },
  'diag.fallback.source-install': { en: 'Installed from source, not by version', zh: '源码安装实例，不支持版本更新', draft: true },
  'diag.fallback.invalid-installation': { en: 'Installed package is incomplete', zh: '已安装包结构不完整', draft: true },
  'diag.fallback.installation-changed': { en: 'Install location changed during use', zh: '安装位置发生变更', draft: true },
  'diag.fallback.pending-restart': { en: 'New version is on disk. The running version is still the old one.', zh: '新版本已写入磁盘，当前运行仍为旧版本', draft: true },
  'diag.fallback.incompatible-node': { en: 'New version needs a different Node version than the running one', zh: 'Node 运行时版本不兼容', draft: true },
  'diag.fallback.registry-conflict': { en: 'Declared version conflicts with the on-disk version', zh: '版本声明与磁盘实际版本冲突', draft: true },
  'diag.fallback.recovery-required': { en: 'Last install was interrupted, leaving a partial task', zh: '上次安装异常中断，存在未完成任务', draft: true },
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 具名槽填充：{name} 按名替换（中英各自独立替换，语序可不同）；缺值填空串，永不把 {name} 漏到 UI。 */
function formatTemplate(template: string, values: Record<string, unknown> | null | undefined): string {
  const vals = values ?? {}
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_: string, name: string) => {
    const v = (vals as Record<string, unknown>)[name]
    if (v === null || v === undefined) return ''
    return String(v).trim()
  })
}

/** 取一条双语原文（类型锁死：未知 key 在 tsc 即拦；运行时未知亦抛，不静默回退）。 */
export function bilingualEntry(key: BilingualKey): BilingualEntry {
  const hit = (BILINGUAL_STRINGS as Record<string, BilingualEntry>)[key]
  if (!hit) throw new Error('[dsh-plugin-update] 未知文案 key：' + String(key))
  return hit
}

/**
 * 单语纯文本（v2 主出口，纯函数）：只渲染 lang 那一种语言，不读全局信号。
 * lang 显式入参（'zh'/'en'/BCP47，缺省 zh）；返回原文（未转义），调用方按上下文转义后再拼入属性。
 */
export function copyText(key: BilingualKey, lang?: AppLang | string | null, values?: Record<string, unknown>): string {
  const l = normalizeLangTag(lang ?? 'zh')
  const e = bilingualEntry(key)
  return formatTemplate(l === 'en' ? e.en : e.zh, values)
}

/**
 * 单语语义块 HTML（v2 主出口，纯函数）：一次只出现一种语言，语义块仍带 lang 属性。
 * lang 显式入参（缺省 zh）；返回已转义可直接拼入 innerHTML 的片段；调用方不得再对整体转义，不得拆 span 重组。
 */
export function copyHTML(key: BilingualKey, lang?: AppLang | string | null, values?: Record<string, unknown>): string {
  const l = normalizeLangTag(lang ?? 'zh')
  const e = bilingualEntry(key)
  const text = escapeHtml(formatTemplate(l === 'en' ? e.en : e.zh, values))
  return '<span class="dsh-upd-bi"><span lang="' + l + '">' + text + '</span></span>'
}

/**
 * 历史名包装（v2 前叫双语，v2 起为单语，保留旧名见文件头说明）：
 * 无显式 lang 时按当前语言单语渲染（读全局信号），有覆盖需求请直接用 copyHTML/copyText。
 */
export function bilingualText(key: BilingualKey, values?: Record<string, unknown>): string {
  return copyText(key, resolveLang(), values)
}

/**
 * 历史名包装（见上）：无显式 lang 时按当前语言单语渲染；返回单语块（只含当前语言一个 span）。
 */
export function bilingualHTML(key: BilingualKey, values?: Record<string, unknown>): string {
  return copyHTML(key, resolveLang(), values)
}

/** 是否 draft（供 #56 门禁读零 draft 放行条件；#54 自身不断言零 draft）。 */
export function isDraft(key: BilingualKey): boolean {
  return bilingualEntry(key).draft
}

/** 全表 draft key 一览（#56 门禁：空数组才放行合入主分支）。 */
export function draftKeys(): BilingualKey[] {
  return (Object.keys(BILINGUAL_STRINGS) as BilingualKey[]).filter((k) => BILINGUAL_STRINGS[k].draft)
}

/**
 * 单语块最小样式（与 UPDATE_ENTRY_CSS 同缝注入）：
 * v2 起窄处竖排退场（一次只一种语言，不断行压力消失，#55 横排/竖排结论作废，排版改由 #67 仲裁）；
 * 只保留 overflow-wrap，不断行不溢出；不管字重字号。
 */
export const BILINGUAL_CSS = [
  '.dsh-upd-bi{display:inline;overflow-wrap:anywhere}',
  '.dsh-upd-bi [lang]{overflow-wrap:anywhere}',
].join('\n')
