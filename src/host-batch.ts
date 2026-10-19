// src/host-batch.ts —— 壳：多目标批量更新的宿主入口（#25）。
//
// 归属：宿主（Node）侧。为 N 个目标各建一份现有 createHostUpdate 能力（前缀与插件标识隔离），
// 共享同一套队列端口（同一使用范围）；批量会话账本落盘（见 core/disk.ts 的 batch 路径），
// 让「关面板/重启进程」之后还能接着推进（resume）。
//
// 契约（面板侧按它写，见 src/panel-batch.ts）：
//   前缀由调用方给（batchPrefix，例 'life'；即属主身份），七个批量电话：
//     <p>.batchStatus  {}                -> 全表（rows + progress + session + inventory + prefs）
//     <p>.batchCheck   {}                -> 查 N 家、重写知识账本后同形状（成功结论同步对账进会话，见 checkPhone）
//     <p>.batchInstall { keys?: string[] }-> 建/续会话并推进：不给 keys 即「全部提交」；
//                                            给了 keys 只推那几家（行内「装这家」/「重试」用）
//     <p>.batchResume  {}                -> 读盘上会话，resume 后推进（含 resumed 事实）
//     <p>.batchCancel  {}                -> 只清本属主盘上会话，回空会话（知识不动）
//     <p>.batchPrefs   {}                -> 读本属主偏好
//     <p>.batchPrefsSave { checkOnOpen }  -> 写本属主偏好
//   每行的单插件三电话照旧各自前缀暴露（<target.prefix>.updateStatus 等）。
//
// #227 起实现搬进 host/batch/ 域目录（蓝图 §4/§5），本文件只保留公开面：
// `dist/host-batch.js` 是冻结出口（package.json `./batch`），运行期名字共 5 个
// （BATCH_CHECK_CONCURRENCY / createMultiHostUpdate / phoneRequestIdOf / staleIdempotentHit /
// attemptRequestId），导出类型逐名转出。
// 实现要点见 host/batch/fan-out.ts 头注释；电话外壳与目标零件见 host/batch/phones.ts。

import type { BatchCheckOutcome, BatchInstallOutcome, BatchRunStep, BatchStoppedByBecause } from './core/batch/run.js'
import type { BatchSelfOrder } from './core/batch/model.js'
import type { UpdateConfigInput } from './shared/config.js'
import type { ReaderOverrides } from './host/capabilities.js'
import type { BatchHostPhoneNames } from './host/batch/phones.js'

/** 一个批量目标：要更新的那个插件包 + 它在电话表里的前缀。 */
export interface MultiTargetSpec {
  /** 会话内稳定键（唯一）。 */
  key: string
  /** 中文名（面板行首用；缺省用 key）。 */
  title?: string
  /** 目标包名（createHostUpdate 的 targetPackageName）。 */
  packageName: string
  /** 该目标的单插件电话前缀（七个必须互不相同，否则串台）。 */
  prefix: string
  /** 宿主侧插件标识（缺省用 batchPrefix + '-' + key）。 */
  pluginId?: string
  /** 该目标的落盘使用范围（家目录）：缺省随批量范围；与批量不一致即如实拒绝（cross-scope）。 */
  homeDir?: string
  /** 该目标的落盘使用范围（使用范围目录）：缺省随批量范围；与批量不一致即如实拒绝。 */
  profileDir?: string
}

/** createMultiHostUpdate 的配置。 */
export interface MultiHostOptions {
  /** 批量电话前缀（例 'life'）。 */
  prefix: string
  /** 目标清单（顺序即会话顺序；selfKey 的位置由 selfOrder 决定，默认最后）。 */
  targets: MultiTargetSpec[]
  /** 「自己」的键：只作日志属主识别；排位由 selfOrder 决定。 */
  selfKey?: string | null
  /**
   * 「自己」在会话顺序里的排位（#219）：默认 'last'（自更新安全：先升别家、最后升自己）；
   * 'first' 让本体排第一行（爱生活本体诉求：爱生活应在批量面板第一行）。
   */
  selfOrder?: BatchSelfOrder
  /** 一家失败后是否停下（默认 false：继续下一家）。 */
  stopOnFailure?: boolean
  /** 宿主侧 drain：定时自动推进队列（**默认关**，显式 opt-in）。 */
  drain?: boolean
  /** drain 间隔（毫秒，缺省 5000，下限 1000）。 */
  drainIntervalMs?: number
}

/** 查一家：真路径打该目标的 updateCheck 电话，单测给假件。 */
export type TargetCheckFn = (key: string, spec: MultiTargetSpec) => Promise<BatchCheckOutcome>
/** 装一家：requestId 是会话账本里的幂等编号（同一会话同一目标恒定）。 */
export type TargetInstallFn = (
  key: string,
  spec: MultiTargetSpec,
  requestId: string,
  version: string,
) => Promise<BatchInstallOutcome>

/** 定时器：drain 用；测试给假件即能确定性地断言「起没起、停没停」。 */
export interface MultiHostTimer {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

/**
 * createMultiHostUpdate 的宿主依赖（全部可选）。
 * ctx / logCtx / desktopPnpm / pluginManager / readerOverrides 原样透传给每个目标的 createHostUpdate；
 * 其余是本入口自己的口子（范围、传输、定时器、时钟、编号），生产可不传。
 */
export interface MultiHostDeps {
  ctx?: unknown
  logCtx?: { fire: (level: string, event: string, fields: Record<string, unknown>) => void } | null
  desktopPnpm?: unknown
  pluginManager?: unknown
  /** 逐目标共用的读侧覆盖（透传给每个目标）。 */
  readerOverrides?: ReaderOverrides
  /** 逐目标读侧覆盖（给了就按目标算；测试与异构目标用）。 */
  readerOverridesFor?: (spec: MultiTargetSpec) => ReaderOverrides | undefined
  /** 逐目标共用的配置覆盖（pluginId / prefix / targetPackageName 按目标算，不从这里来）。 */
  config?: Omit<UpdateConfigInput, 'pluginId' | 'prefix' | 'targetPackageName'>
  /** 批量使用范围（会话落盘与共享队列端口用；缺省取 readerOverrides 的同名项）。 */
  scope?: { homeDir?: string; profileDir?: string }
  /** 查/装传输：缺省走单插件电话；测试给假件。 */
  transport?: { check?: TargetCheckFn; install?: TargetInstallFn }
  /** drain 的定时器（缺省真 setTimeout / clearTimeout）。 */
  timers?: MultiHostTimer
  now?: () => number
  randomId?: () => string
  /** 装完之后轮询该家状态的间隔毫秒（缺省 500；后台安装收尾用）。 */
  installPollMs?: number
}

/** 批量宿主入口的返回面。 */
export interface MultiHostUpdate {
  /** 电话表：批量电话 + 每个目标的单插件电话，键即电话名。 */
  handlers: Record<string, (args?: Record<string, unknown>) => Promise<unknown>>
  /** 批量电话名（供接入方登记用，不写字面量）。 */
  phoneNames: BatchHostPhoneNames
  /** 目标清单（顺序与会话一致）。 */
  targets: readonly MultiTargetSpec[]
  /** 最近一次推进的读数（驱动器停下来的原因 + 步骤）：给日志与门禁用；没推过为 null。 */
  lastRun: { stoppedBecause: BatchStoppedByBecause; steps: BatchRunStep[] } | null
  /** 停掉 drain（接入方卸载时调）。 */
  dispose(): void
}

/**
 * 批量宿主侧电话名（供接入方登记用，不写字面量）。
 *
 * 与面板侧 `./panel-batch` 的 `BatchPhoneNames` **不同名**（两份同名导出会经不同子路径发布，
 * 消费者同时 import 会撞名）：面板那份只描述它实际打的七个电话；这份多登记一个 `logAppend`，
 * 因为宿主是唯一知道「属主插件日志口」的一侧。
 */
export type { BatchHostPhoneNames } from './host/batch/phones.js'

export { BATCH_CHECK_CONCURRENCY, createMultiHostUpdate } from './host/batch/fan-out.js'
export { attemptRequestId, phoneRequestIdOf, staleIdempotentHit } from './host/batch/resume.js'
