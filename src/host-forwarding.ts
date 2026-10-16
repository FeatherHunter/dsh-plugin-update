// src/host-forwarding.ts —— 宿主转发表门面（#162 首刀，#164 规格）。
//
// 身份：纯转发表，不含任何实现。本文件所有条目都是 `export…from` 搬运工：
// 把散在各模块的公开能力经包根（host.ts）一次转出口，第二家可达。
// 机制：搬家＋垫片 —— host.ts 用 `export * from './host-forwarding.js'` 原地垫片，
// 测试深引用（../dist/host.js）与包导出表零碰（#159 冻结决议的直接派生）。
// 判定核/渲染等后续拆分照抄本模式：函数搬新文件，老地方留垫片。

export { buildChangelogPhoneName, buildPhoneName, buildPhoneNames, resolveUpdateConfig } from './config.js'
export type { ChangelogPhoneAction, PhoneAction, UpdateConfigInput } from './config.js'
// 门禁模板检查器（#584 落地；#120 起形状对齐日志包 0.3.1：清单不写自报计数、字段检查分两档、
// 落盘行断言 v === 3。对象形式，更新包不读盘；经包根转出口，第二家可达）。
export {
  LOG_ROW_VERSION,
  computeEventCounts,
  lintEventFields,
  lintEventList,
  mergeUpdateEvents,
  parseEventListManifest,
  parseLogRow,
  checkEventFields,
  checkEventCounts
} from './gate.js'
export type {
  GateEventLevel,
  GateEventKind,
  GateEventEntry,
  GateEventCounts,
  GateEventList,
  GateFieldCheck,
  GateLintFieldsResult,
  GateListLintResult,
  GateLogRow,
  GateMergeResult,
  GateCountCheck
} from './gate.js'
export { containingPackage, defaultHomeDir, profileNameValid, registrySpec, resolveTargetPackage } from './reader.js'
// 脱敏词汇（#19：五条具名规则 + 两占位符 + 顺序 + 源主机名规则，经包根转出口，第二家可达）。
// #24 单源收敛 + 字节墙：复制预算 / known-gap / 按序丢弃 enforcement 同经此出口。
export {
  COPY_BUDGET_CHARS,
  DETAIL_MAX_CHARS,
  DIAG_DROP_ORDER,
  DIAG_INLINE_BUDGET_BYTES,
  DIAG_NEVER_DROP_KEYS,
  ENDORSED_REGISTRY_HOSTS,
  KNOWN_GAP_FILE_URL_PREFIX,
  REDACTED_PATH,
  REDACTED_SECRET,
  REDACTION_RULE_NAMES,
  diagByteLength,
  enforceDiagBudget,
  resolveRegistryHost,
  sanitizeDetail,
  sanitizeForCopy,
  truncateToWordBoundary,
} from './redaction.js';
export type { DiagDropKey, RedactionRuleName } from './redaction.js';
// 电话侧失败证据 diag（#21，承接 #18 契约：19 键目录 + 阶段六值 + 路由/方法正交 +
// 包内动作推导 + 缺省省略 + 1024 字节墙；queuePos 留空到队列转正，经包根转出口）。
export {
  DIAG_ACTIONS,
  DIAG_KEYS,
  DIAG_KNOWN_TYPES,
  DIAG_STAGE_EXPECT,
  DIAG_STAGES,
  DIAG_VERSION,
  buildDiag,
  deriveAction,
  deriveRouteMethod,
  deriveStage,
  enforceBudget as enforceDiagBudgetForPhone,
} from './diag.js';
export type { DiagAction, DiagInput, DiagObject, DiagStage } from './diag.js';
// 安装失败翻译官（#155：已知签名识别 + 诚实归因；纯函数 + 计数解释器，经包根转出口）。
export {
  blameCausePackage,
  CAUSE_KINDS,
  causeInterpreter,
  causeInterpreterCounts,
  causePackageNameOf,
  createCauseInterpreter,
  formatUnlockAt,
  interpretInstallCause,
} from './install-cause.js';
export type { CauseBlame, CauseFacts, CauseInterpreterCounts, CauseKind, CauseSignature, InterpretCauseInput } from './install-cause.js';
// 合规版决议（#156：年龄门拦住时找"满门限的最新版"；纯函数，经包根转出口）。
export { resolveCompliantVersion } from './compliant-version.js';
export type { CompliantVerdict, CompliantVersionInput, CompliantWindowSource } from './compliant-version.js';
// 更新日志（#23，承接 #11：包内 CHANGELOG.md 展示；纯函数两边可进，I/O 仅 Node 侧）。
export {
  CHANGELOG_ALL_CATEGORIES,
  CHANGELOG_FILENAME,
  CHANGELOG_FOLDED,
  CHANGELOG_MAX_BULLETS_PER_SECTION,
  CHANGELOG_MAX_BULLET_CHARS,
  CHANGELOG_MAX_CHARS,
  CHANGELOG_MAX_ENTRIES,
  CHANGELOG_MUST_SHOW,
  CHANGELOG_NEUTRAL_HINT,
  CHANGELOG_NEUTRAL_LINE,
  BREAKING_BADGE_TEXT,
  CHANGELOG_POLL_BACKOFF_MS,
  changelogForUpdate,
  countsOf,
  hasVisibleSections,
  isBreakingChangelogItem,
  isUnreleasedVersion,
  parseChangelog,
  parseChangelogReport,
  renderChangelogHTML,
  renderChangelogItem,
  renderChangelogNeutral,
  renderChangelogSection,
  selectChangelogEntries,
  shouldFetchChangelog,
  splitBreakingPrefix,
  truncatedNoteHTML,
  validateChangelog,
  yankedBannerHTML,
} from './changelog.js';
export type { ChangelogCategory, ChangelogDiagnostic, ChangelogEntry, ChangelogValidation } from './changelog.js';
export {
  CHANGELOG_DEFAULT_REGISTRY,
  CHANGELOG_FETCH_MAX_BYTES,
  CHANGELOG_TAR_MAX_BYTES,
  CHANGELOG_TARBALL_MAX_BYTES,
  extractChangelogFromTar,
  fetchReleaseChangelogText,
  readInstalledChangelogText,
} from './changelog-io.js';
export type { ReleaseChangelogRef } from './changelog-io.js';
export { createUpdateDiskPorts, createUpdateExecutor, pathsForUpdate, resolveCliEntry } from './store.js'
// 跳过与版本通道（#16：按插件 + 版本持久化跳过、stable 默认 / prerelease 开关、精确版锁定）。
export { SKIPPED_FILE } from './config.js'
export {
  addSkipped,
  clearSkipped,
  createSkipDiskPorts,
  isVersionSkipped,
  MAX_SKIPPED_ENTRIES,
  normalizeSkipped,
  skipKey,
  type SkippedVersionEntry,
} from './store.js'
export {
  compareReleaseVersions,
  isPrereleaseVersion,
  isVersionAllowedInChannel,
  validReleaseVersion,
  validVersion,
  compareVersions,
} from './service.js'
export type { ReleaseChannel } from './ports.js'
export type { CheckFallbackPhoneAction } from './config.js'
export type { FallbackCheckInput, FallbackCheckResult } from './ports.js'
// 跨插件单队列（#15）：纯决策经包根转出口，落盘与全局锁同上；面板展示过滤见 client.ts 同名转出口。
export {
  createUpdateQueuePorts,
  queuePathsForUpdate,
  QUEUE_DIR_SEGMENT,
  QUEUE_FILE,
  QUEUE_LOCK_FILE,
  QUEUE_LOCK_STALE_MS,
} from './store.js'
export {
  QUEUE_INTENT_TTL_MS,
  cancelEnqueuedInQueue,
  emptyQueueState,
  enqueueInQueue,
  isHeadOfQueue,
  normalizeQueueState,
  pruneExpiredIntents,
  queuePositionOf,
  releaseOwnerInQueue,
  setOwnerIfFree,
  visibleQueueFor,
} from './queue.js'
export type { QueuedEntry, QueueOwner, UpdateQueueState, VisibleQueue } from './queue.js'
