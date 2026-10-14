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

/** 查一家的结果。 */
export type BatchCheckOutcome =
  /** 有新版可装。 */
  | { kind: 'update'; version: string }
  /** 已是最新，不需要动。 */
  | { kind: 'current' }
  /** 这一版被用户跳过（不装，但也不算失败）。 */
  | { kind: 'skipped'; version: string | null }
  /** 查失败（稳定码）。 */
  | { kind: 'failed'; error: string }

/** 装一家的结果。 */
export type BatchInstallOutcome =
  /** 装完；restartRequired 表示要重启宿主才生效。 */
  | { kind: 'done'; restartRequired: boolean }
  /**
   * 装失败（稳定码）。exitCode 只在**真拿到退出码**时才给（安装子进程真跑过并退出）；
   * 失败发生在执行之前（网络、锁、纯 JS 抛错）时它缺席——不拿 0 / -1 冒充「跑过」。
   */
  | { kind: 'failed'; error: string; exitCode?: number }
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

export interface BatchRunResult {
  session: BatchSession
  steps: BatchRunStep[]
  /** 停下来的原因：做完了／按策略遇错停／步数用完／没活可干／**排上队但还没轮到**。 */
  stoppedBecause: 'finished' | 'stopped-after-failure' | 'max-steps' | 'empty' | 'queued'
}

/** 驱动器选项：`maxSteps` 给 1 就是「只推进一步」，便于宿主按自己的节奏推进（drain）。 */
export interface BatchRunOptions {
  maxSteps?: number
}

// ---------- 单项失败的日志接线（#124） ----------
//
// 只记「稳定短码 + 目标指纹」：目标键（可能是包名、路径或标识）与错误原话一个字都不入行（ADR-0006）。
// 行里只有枚举白名单值与导出量，所以这些函数只做两件事：算 hash8、把错误折成稳定码。

/** 内核 hash8 的同算法实现（djb2 → 8 位十六进制）：中立文件不许 import node，这里自带一份同方言口径。 */
function targetHash8(text: string): string {
  const t = String(text || '')
  let h = 5381
  for (let i = 0; i < t.length; i += 1) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0
  return ('0000000' + h.toString(16)).slice(-8)
}

/** 稳定错误码的形状（小写字母开头、短、无空白）：不像的一律折成 unknown——error.message 里可能有路径/URL。 */
const STABLE_ERROR_CODE = /^[a-z][a-z0-9-]{0,31}$/

/** 一家失败记一条：targetHash 只指纹目标，exitCode 只有真拿到才进字段（多一个键整行会被白名单丢掉）。 */
function noteEntryFail(deps: BatchRunDeps, key: string, error: string, exitCode?: number): void {
  const fields: Record<string, unknown> = {
    targetHash: targetHash8(key),
    errorKind: STABLE_ERROR_CODE.test(error) ? error : 'unknown',
  }
  if (typeof exitCode === 'number' && Number.isFinite(exitCode)) fields['exitCode'] = Math.trunc(exitCode)
  try {
    deps.logFor?.(key)?.('warn', 'update.batch.entry.fail', fields)
  } catch {
    // 记日志是旁路：端口抛错也不许改变推进、返回值与抛错（与「没有端口」一字不差）
  }
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
        noteEntryFail(deps, key, checked.error)
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
      noteEntryFail(deps, key, installed.error, installed.exitCode)
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

function stoppedBecause(session: BatchSession): 'finished' | 'empty' | 'stopped-after-failure' {
  if (session.entries.length === 0) return 'empty'
  if (session.entries.every((e) => isTerminalPhase(e.phase))) return 'finished'
  return 'stopped-after-failure'
}

/** 会话是否已收尾（面板与日志用同一口径）。 */
export function batchRunFinished(session: BatchSession): boolean {
  return batchProgress(session).finished
}
