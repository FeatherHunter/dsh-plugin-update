// src/host.ts —— 壳：更新包的宿主入口（包根，#581 双入口之一）。
//
// 3 步接入：装包、调用 createHostUpdate 并传入插件标识、用默认配置即跑。
// 当前插件传插件标识 dsh-mattpocock-skills-deck、电话名前缀 wf，拼出的 3 个电话名、
// 落盘目录、三个文件名与现状一字不差。第二个插件传自己的标识与前缀即隔离。
//
// 全程用“更新系统”指更新功能本身，用“更新包”指装着更新系统的这个 npm 包。
// 电话指宿主对外提供的方法；落盘指宿主统一写本地文件的动作。
//
// #227 起实现搬进 host/ 域目录，本文件只做公开面转出口（蓝图 §4/§5）：
// `dist/host.js` 是冻结出口（package.json `.`），运行期名字与改造前逐字相同（133 个）。
// 这里**必须逐名转出**、不能 `export *` 整个实现模块——否则 loggedPhone / queueArgsOf
// 这类内部接线会漏成新的公开 API，破坏 #159 的导出冻结。

// 宿主转发表（#162/#164）：跨域公开能力的第一手转出口，126 个名字。
export * from './host/forwarding.js'

// 宿主公开面（#227）：探测/日志目录/能力端口/装配入口，逐名转出。
export { detectEnvironmentKind, updateLogDirFor, type PhoneEnvView } from './host/environment.js'
export type { ReaderOverrides } from './host/capabilities.js'
export {
  __resetSharedUpdateReaderForTests,
  createHostUpdate,
  failedJobDiagOf,
  type HostUpdate,
} from './host/factory.js'

// 主入口再导出（#211 AC-4）：把「有界冲刷自建日志」交给宿主/集成方在 beforeExit 或短命 CLI 退出前挂。
export {
  DEFAULT_FLUSH_UPDATE_LOG_TIMEOUT_MS,
  flushUpdateLog,
  type FlushUpdateLogOptions,
  type FlushUpdateLogResult,
} from './log/registry.js'
// 日志健康读数（#212）：主入口的 d.ts 要把这格暴露给面板与集成方（浏览器侧只引类型，不拖 Node 侧实现）。
export type {
  LogHealthContractState,
  LogHealthExternalGate,
  LogHealthOffReason,
  LogHealthSink,
  UpdateLogHealth,
} from './log/health.js'
