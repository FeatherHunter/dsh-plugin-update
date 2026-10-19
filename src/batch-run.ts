// src/batch-run.ts —— 批量更新的串行驱动器（#25）。
//
// 第一性：批量更新是「一家收尾才起下一家」的串行过程，而每一步都可能被进程重启/页面重载打断。
// 所以驱动器只做两件事，且每一步都落盘：
//   1. 按会话顺序取下一家（顺序由 batch.ts 定：自己排最后）；
//   2. 查 → （有新版才）装 → 记相位 → **立刻保存**。
//   再重启时读回账本，已完成的不重装、没做完的接着走（幂等编号恒定，重复提交不重复装）。
//
// 传输（查/装）由调用方注入：宿主侧传真电话，单测给假件——所以「串行顺序」这件事能被门禁逮住。
// 日志落点（#124）同样是注入的（deps.logFor）：路由要的插件标识只有宿主知道，驱动器不猜。
// 本文件零 Node/浏览器专属能力（只 import batch.ts 的纯函数 + ports.ts 的类型），两边都跑得动。

import {
  batchProgress,
  isTerminalPhase,
  markBatchEntry,
  nextBatchKey,
  type BatchSession,
} from './batch.js'
import type { UpdateLogPort } from './ports.js'
import { hash8 } from './hash.js'

/** 失败发生在哪个阶段（#208）：查版本／提交安装／等安装收尾超时／读终态。 */
export type BatchFailStage = 'check' | 'install' | 'timeout' | 'settle'

/** 查一家的结果。 */
export type BatchCheckOutcome =
  /** 有新版可装。 */
  | { kind: 'update'; version: string }
  /** 已是最新，不需要动。 */
  | { kind: 'current' }
  /**
   * 已经装到目标版、只差宿主重启才生效（#216）：磁盘版==最新版，但任务/环境还标着待重启。
   * 这与「已是最新，无需操作」是两件事——前者要用户重启，后者什么都别做。
   */
  | { kind: 'done'; version: string; restartRequired: boolean }
  /** 这一版被用户跳过（不装，但也不算失败）。 */
  | { kind: 'skipped'; version: string | null }
  /** 查失败（稳定码）；stage 只在失败阶段不是「查」时才显式给（缺省按查算）。 */
  | { kind: 'failed'; error: string; stage?: BatchFailStage }

/** 装一家的结果。 */
export type BatchInstallOutcome =
  /** 装完；restartRequired 表示要重启宿主才生效。 */
  | { kind: 'done'; restartRequired: boolean }
  /**
   * 装失败（稳定码）。exitCode 只在**真拿到退出码**时才给（安装子进程真跑过并退出）；
   * 失败发生在执行之前（网络、锁、纯 JS 抛错）时它缺席——不拿 0 / -1 冒充「跑过」。
   * stage 标明失败阶段（提交安装／等收尾超时／收尾失败），缺省按「提交安装」算。
   */
  | { kind: 'failed'; error: string; exitCode?: number; stage?: BatchFailStage }
  /**
   * 已入队：全局锁被别家占着（宿主的 update-busy），本家排上了但还没轮到。
   * **不是失败**——这一行的相位回到 ready（远端版本留着），本轮推动到此为止，
   * 下次推动（或宿主 drain）会从它接着走。这是「一个一个加入队列」那条路的正解：
   * 用户点「加入队列」= 递一个意图进队列，而不是报一次错。
   */
  | { kind: 'queued'; position?: number | null }

/** 驱动器要用到的传输与落盘（调用方注入）。 */
export interface BatchRunDeps {
  /** 查这一家的远端版本。 */
  check: (key: string) => Promise<BatchCheckOutcome>
  /** 装这一家：**必须**带上会话给的幂等 requestId（重复提交由队列按它去重）。 */
  install: (key: string, requestId: string, version: string) => Promise<BatchInstallOutcome>
  /** 会话落盘（每一步之后都调一次：这就是「断点续跑」的全部秘密）。 */
  save: (session: BatchSession) => Promise<void> | void
  now: () => number
  /**
   * 一家失败的日志落点（#124，可选）。参数是**目标键**，返回该目标的发射口；
   * 返回 null（或干脆不注入）即「这一家没有已知落点」，一行不发——驱动器不认识插件标识，不猜。
   */
  logFor?: (key: string) => UpdateLogPort | null
  /**
   * 目标在**整批**里的序号（#208，可选）。调用方可能只推进被选中的几行（视图过滤），
   * 此时 `session.entries.findIndex` 给的是视图序号；不注入就退回会话账本序号。
   * 返回负数表示算不出，失败行里 index 字段整格不出（不拿 0 冒充第一家）。
   */
  indexOf?: (key: string) => number
}

/** 驱动器读数：给日志、面板与门禁用。 */
export interface BatchRunStep {
  key: string
  action: 'check' | 'install'
  /** 这一步把该行推到了哪个相位。 */
  phase: string
  /** 失败稳定码（成功为 null）。 */
  error: string | null
}

/**
 * 一批停下来的原因（#208；#209 扩两值）：做完了／按策略遇错停／步数用完／没活可干／**排上队但还没轮到**，
 * 以及宿主侧才看得见的两种停止：**用户取消**与**驱动自己抛异常**。
 * 宿主侧 `update.batch.summary` 的 `stoppedBecause` 与 `MultiHostUpdate.lastRun` 共用这一个词汇。
 */
export type BatchStoppedByBecause =
  | 'finished'
  | 'stopped-after-failure'
  | 'max-steps'
  | 'empty'
  | 'queued'
  | 'user-cancel'
  | 'error'

export interface BatchRunResult {
  session: BatchSession
  steps: BatchRunStep[]
  /** 见 BatchStoppedByBecause。 */
  stoppedBecause: BatchStoppedByBecause
}

/** 驱动器选项：`maxSteps` 给 1 就是「只推进一步」，便于宿主按自己的节奏推进（drain）。 */
export interface BatchRunOptions {
  maxSteps?: number
}

// ---------- 单项失败的日志接线（#124 / #208） ----------
//
// 只记「稳定短码 + 指纹」：目标键（可能是包名、路径或标识）与错误原话一个字都不入行（ADR-0006）。
// 行里只有枚举白名单值与导出量，所以这些函数只做两件事：算 hash8、把错误折成稳定码。
// #208 起多三样：sessionHash（同一批的三条行靠它串起来）、stage（失败阶段）、index（批内序号）。

/** 稳定错误码的形状（小写字母开头、短、无空白）：不像的一律折成 unknown——error.message 里可能有路径/URL。 */
const STABLE_ERROR_CODE = /^[a-z][a-z0-9-]{0,31}$/

/** 一次失败的传输结果里驱动器要用的三格（outcome 已收窄到 failed 分支）。 */
interface EntryFailure {
  error: string
  exitCode?: number
  stage?: BatchFailStage
}

/** 一家失败行需要的批内上下文（#209）：会话/目标/动作/序号成组传，别让六个位置参数各自漂移。 */
interface EntryFailureContext {
  sessionId: string
  key: string
  action: 'check' | 'install'
  index: number
}

/**
 * 一家失败记一条（#124 / #208；#209 起对外开放给批量宿主的预查路径复用）。
 * 宿主预查失败与驱动失败必须同一行形状、同一个发射口——否则同一件事在日志里有两个说法。
 * errorKind 只收稳定短码，不像的一律折成 unknown（error.message 里可能有路径/URL）。
 */
export function noteBatchEntryFailure(
  logFor: ((key: string) => UpdateLogPort | null) | undefined,
  context: EntryFailureContext,
  failure: EntryFailure,
): void {
  const fields: Record<string, unknown> = {
    targetHash: hash8(context.key),
    sessionHash: hash8(context.sessionId),
    errorKind: STABLE_ERROR_CODE.test(failure.error) ? failure.error : 'unknown',
    stage: failure.stage ?? (context.action === 'check' ? 'check' : 'install'),
  }
  if (Number.isInteger(context.index) && context.index >= 0) fields['index'] = context.index
  if (typeof failure.exitCode === 'number' && Number.isFinite(failure.exitCode)) {
    fields['exitCode'] = Math.trunc(failure.exitCode)
  }
  try {
    logFor?.(context.key)?.('warn', 'update.batch.entry.fail', fields)
  } catch {
    // 记日志是旁路：端口抛错也不许改变推进、返回值与抛错（与「没有端口」一字不差）
  }
}

/** 一家失败记一条：targetHash/sessionHash 只指纹，exitCode 只有真拿到才进字段（多一个键整行会被白名单丢掉）。 */
function noteEntryFail(
  deps: BatchRunDeps,
  session: BatchSession,
  key: string,
  action: 'check' | 'install',
  failure: EntryFailure,
): void {
  const index = deps.indexOf?.(key) ?? session.entries.findIndex((e) => e.key === key)
  noteBatchEntryFailure(deps.logFor, { sessionId: session.id, key, action, index }, failure)
}

/**
 * 把会话往前推，直到：收尾／按 stopOnFailure 遇错停下／步数用完／没活可干。
 * 每一步都先落盘再继续——中途被打断也不会丢进度。
 */
export async function runBatch(
  session: BatchSession,
  deps: BatchRunDeps,
  options: BatchRunOptions = {},
): Promise<BatchRunResult> {
  const maxSteps =
    typeof options.maxSteps === 'number' && Number.isFinite(options.maxSteps) && options.maxSteps > 0
      ? Math.floor(options.maxSteps)
      : Number.POSITIVE_INFINITY
  const steps: BatchRunStep[] = []
  let current = session
  let used = 0

  const persist = async (next: BatchSession): Promise<BatchSession> => {
    current = next
    await deps.save(next)
    return next
  }
  const budgetLeft = (): boolean => used < maxSteps

  while (true) {
    const key = nextBatchKey(current)
    if (key === null) {
      return { session: current, steps, stoppedBecause: stoppedBecause(current) }
    }
    const entry = current.entries.find((e) => e.key === key)
    if (!entry) return { session: current, steps, stoppedBecause: 'empty' }
    // 预算用完就停在当前相位，等下一轮接着推（drain 一次只做一次传输调用）。
    if (!budgetLeft()) return { session: current, steps, stoppedBecause: 'max-steps' }

    // 这一家的版本号：上一轮已经查过（ready 且有版本）就直接用，不再重查——
    // 这样预算恰好在「查完还没装」处用尽时，下一轮从这里接着装，而不是从头再查一遍。
    let version: string | null = entry.phase === 'ready' && entry.targetVersion ? entry.targetVersion : null

    if (version === null) {
      // 1) 查：先记 checking（落盘），这样重载后知道这一家没查完
      await persist(markBatchEntry(current, key, { phase: 'checking', error: null }, deps.now()).session)
      const checked = await deps.check(key)
      used += 1

      if (checked.kind === 'failed') {
        await persist(markBatchEntry(current, key, { phase: 'failed', error: checked.error }, deps.now()).session)
        steps.push({ key, action: 'check', phase: 'failed', error: checked.error })
        noteEntryFail(deps, current, key, 'check', checked)
        if (current.stopOnFailure) return { session: current, steps, stoppedBecause: 'stopped-after-failure' }
        continue
      }
      if (checked.kind === 'current') {
        await persist(markBatchEntry(current, key, { phase: 'current', targetVersion: null }, deps.now()).session)
        steps.push({ key, action: 'check', phase: 'current', error: null })
        continue
      }
      if (checked.kind === 'skipped') {
        await persist(markBatchEntry(current, key, { phase: 'skipped', targetVersion: checked.version }, deps.now()).session)
        steps.push({ key, action: 'check', phase: 'skipped', error: null })
        continue
      }
      if (checked.kind === 'done') {
        // #216：已经装好、只等重启——账本按 done + 待重启收尾，状态词说「重启宿主后生效」，
        // 不说「已是最新，无需操作」（后者会让用户以为没事了，其实新版还没加载）。
        await persist(
          markBatchEntry(
            current,
            key,
            { phase: 'done', targetVersion: checked.version, restartRequired: checked.restartRequired, error: null },
            deps.now(),
          ).session,
        )
        steps.push({ key, action: 'check', phase: 'done', error: null })
        continue
      }

      // 2) 有新版：记 ready + 远端版本（落盘），再提交安装
      await persist(markBatchEntry(current, key, { phase: 'ready', targetVersion: checked.version, error: null }, deps.now()).session)
      steps.push({ key, action: 'check', phase: 'ready', error: null })
      version = checked.version
      if (!budgetLeft()) return { session: current, steps, stoppedBecause: 'max-steps' }
    }

    // 3) 提交安装：编号用会话里那一份（恒等 ⇒ 幂等，重复提交不重复装）
    if (version === null) continue // 到不了：上面两条路都会给出版本；真到了就跳过这家，不猜版本
    await persist(markBatchEntry(current, key, { phase: 'installing' }, deps.now()).session)
    const installed = await deps.install(key, entry.requestId, version)
    used += 1

    if (installed.kind === 'queued') {
      // 入了队但没轮到：相位退回 ready（版本留着，别丢），本轮到此为止——
      // 不记 failed（它不是失败），也不继续推下一家（锁还在别人手里，推了也白推）。
      await persist(markBatchEntry(current, key, { phase: 'ready', error: null }, deps.now()).session)
      steps.push({ key, action: 'install', phase: 'queued', error: null })
      return { session: current, steps, stoppedBecause: 'queued' }
    }
    if (installed.kind === 'failed') {
      await persist(markBatchEntry(current, key, { phase: 'failed', error: installed.error }, deps.now()).session)
      steps.push({ key, action: 'install', phase: 'failed', error: installed.error })
      noteEntryFail(deps, current, key, 'install', installed)
      if (current.stopOnFailure) return { session: current, steps, stoppedBecause: 'stopped-after-failure' }
      continue
    }
    await persist(
      markBatchEntry(current, key, { phase: 'done', restartRequired: installed.restartRequired, error: null }, deps.now()).session,
    )
    steps.push({ key, action: 'install', phase: 'done', error: null })
  }

  return { session: current, steps, stoppedBecause: 'max-steps' }
}

function stoppedBecause(session: BatchSession): BatchStoppedByBecause {
  if (session.entries.length === 0) return 'empty'
  if (session.entries.every((e) => isTerminalPhase(e.phase))) return 'finished'
  return 'stopped-after-failure'
}

/** 会话是否已收尾（面板与日志用同一口径）。 */
export function batchRunFinished(session: BatchSession): boolean {
  return batchProgress(session).finished
}
