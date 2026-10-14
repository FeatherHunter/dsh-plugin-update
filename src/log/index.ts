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
export { createNoopSink, createPendingSink, isLogSinkLike, sinkFromLogCtx, sinkFromStore, NOOP_SINK, type LogSink, type PendingLogSink } from './sink.js'
export { createLogRouter, updateLogRouter, type LogRouter } from './router.js'
export {
  createLogEmitter,
  emitUpdateLog,
  logEmitterCounts,
  sanitizeLogFields,
  fieldFingerprint,
  updateLogEmitter,
  type LogEmitter,
  type LogEmitterCounts,
  type LogEmitOptions,
  type LogDropReason,
} from './emit.js'
export {
  buildUpdateManifest,
  currentUpdateEventTable,
  isEdgeEvent,
  loadUpdateEventTable,
  mergeUpdateEvents,
  primeUpdateEventTable,
  UPDATE_EVENT_LIST_FILE,
  __resetUpdateEventTableForTests,
} from './manifest.js'
export {
  acquireOwnLog,
  describeOwnLogRegistry,
  lastOwnLogDegraded,
  logDirHash,
  releaseOwnLog,
  OWN_LOG_REGISTRY_KEY,
  __resetOwnLogRegistryForTests,
  type OwnLogAcquireInput,
  type OwnLogAcquireResult,
  type OwnLogDegradeReason,
  type OwnLogHandle,
} from './registry.js'
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
