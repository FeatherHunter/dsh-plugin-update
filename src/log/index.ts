/**
 * src/log/index.ts —— 日志内核的公开出口（`dsh-plugin-update/log`）。
 *
 * 为什么单开一个子路径而不是全塞进主入口：主入口是「建宿主更新能力」的门面，浏览器侧也引它；
 * 把落盘、登记表、清单这些 Node 侧的东西挂在主入口上，等于逼每个打包器都去解析 `node:crypto`。
 * 子路径让「要自己接日志的人」显式进来（集成方自定义接线、诊断面读计数、第三方工具读行），
 * 也让 `docs/maintainers.md` 的「新增能力＝新增子路径」纪律保持成立。
 *
 * 浏览器侧只许引用这里的**类型**（`LogSink`）与 `router`：`namespace`/`emit`/`manifest`/`registry`
 * 都会拖进 Node 内建模块。
 */
export { deriveLogNamespace, logDirKey, logSwitchFileName, hashToken, LOG_NAMESPACE_MAX_CHARS } from './namespace.js'
export { createNoopSink, createPendingSink, isLogSinkLike, sinkFromLogCtx, sinkFromStore, NOOP_SINK, type LogSink, type LogTraceHandle, type PendingLogSink } from './sink.js'
export { createLogRouter, updateLogRouter, type LogRouter } from './router.js'
// 宿主侧链上下文（`0.16.4` 起，需要 dsh-log 0.3.3 的 `store.trace()`）：本文件会拖进 `node:async_hooks`，
// 浏览器侧不要引 —— 面板侧的链由 dsh-log 的客户端 SDK 管，不从这里走。
export { currentLogTraceFor, withLogTrace, withLogTraceStep } from './trace.js'
export {
  createLogEmitter,
  emitUpdateLog,
  logEmitterCounts,
  logEmitterCountsFor,
  sanitizeLogFields,
  fieldFingerprint,
  updateLogEmitter,
  type LogEmitter,
  type LogEmitterCounts,
  type LogEmitOptions,
  type LogDropReason,
  type LogPluginCounts,
} from './emit.js'
export {
  buildUpdateManifest,
  currentUpdateEventTable,
  isEdgeEvent,
  loadUpdateEventTable,
  mergeUpdateEvents,
  primeUpdateEventTable,
  updateContractStatus,
  UPDATE_EVENT_LIST_FILE,
  __resetUpdateEventTableForTests,
  type UpdateContractFailure,
  type UpdateContractStatus,
} from './manifest.js'
// 本包自己的版本号（`0.16.4` 起）：启动头 `host.start` 的 `pluginVersion` 那一格来自它；
// dsh-log 0.3.4 起启动头幂等，所以它只在建库那一刻有用。
export { ownPackageVersion, packageRoot, __resetOwnPackageVersionForTests } from './own-version.js'
// 引擎保留名与读侧豁免（0.16.4 起，需要 dsh-log 0.3.3 的宿主侧链）：拿清单量**落盘行**之前
// 先 `stripReservedLogFields`，否则每条带链的行都会因为 traceId/spanId/seq 被判黄。
export { RESERVED_LOG_FIELDS, stripReservedLogFields } from '../gate.js'
export {
  acquireOwnLog,
  describeOwnLogRegistry,
  DEFAULT_FLUSH_UPDATE_LOG_TIMEOUT_MS,
  flushUpdateLog,
  lastOwnLogDegraded,
  logDirHash,
  releaseOwnLog,
  OWN_LOG_REGISTRY_KEY,
  __resetOwnLogRegistryForTests,
  type FlushUpdateLogOptions,
  type FlushUpdateLogResult,
  type OwnLogAcquireInput,
  type OwnLogAcquireResult,
  type OwnLogDegradeReason,
  type OwnLogHandle,
} from './registry.js'
// 日志健康（#212）：对外只转出消费方要用的类型；映射函数、接线形状与测试注入点留在
// `./log/health.js` 内部（与 #210 的测试缝纪律一致：`__loadUpdateEventTableForTests`
// 同样只从内部模块导入，不上公共出口）。
export {
  type LogHealthContractState,
  type LogHealthExternalGate,
  type LogHealthOffReason,
  type LogHealthSink,
  type UpdateLogHealth,
} from './health.js'
// 客户端通道（#122）：浏览器安全的那个模块，面板侧与入口件都引它；本文件其余部分会拖进 node:，
// 所以第三方工具要单独用客户端队列时走 `dsh-plugin-update/log` 的类型面 + panel 的注入点即可。
export {
  createClientLogChannel,
  resolveClientLogTimer,
  resolveClientLogVisibility,
  CLIENT_LOG_BATCH_SIZE,
  CLIENT_LOG_FLUSH_MS,
  CLIENT_LOG_MAX_QUEUE,
  CLIENT_LOG_MAX_RETRIES,
  CLIENT_LOG_RETRY_DELAYS_MS,
  CLIENT_LOG_SEND_TIMEOUT_MS,
  type ClientLogChannel,
  type ClientLogChannelOptions,
  type ClientLogRow,
  type ClientLogTimer,
  type ClientLogVisibility,
} from './client-queue.js'
