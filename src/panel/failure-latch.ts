// src/panel/failure-latch.ts —— 失败锁存（#58：安装/查失败常驻，复制诊断锁定致命回包）与渲染用只读快照。
//
// 从 src/panel.ts 拆出（#226，蓝图 §4：panel/failure-latch）。锁存只读轮询与用户动作分权：
// 用户动作的失败回包冻结成锁存，瞬态锁存下一次成功读数即清，update-busy 永不进锁存；
// 跨重挂按「插件 + 使用范围」在模块级存活（宿主进程内），进程重启即忘。

import { normalizeLangTag, type AppLang } from '../shared/lang.js'

/** 内核渲染用的失败引用（只读快照：证据仍在锁存里，这里只传展示键）。 */
export interface PanelFailureRef {
  requestId: string | null
  checkId: string | null
  atMs: number | null
  source: 'check' | 'install' | null
  volatile: boolean
  /** 失败那次安装的目标版本（无则不画行）。 */
  targetVersion: string | null
  /**
   * 翻译官机读结论（#156：内核由锁存证据解析后填入；渲染只按它们分支，不读自由文本）。
   * causePackage 是带版本的规格（如 dshmarket@1.66.28）；窗口/发布时间缺省即 null（算不出）。
   * 全缺省即老行为（通用失败按钮），调用方不传与传 null 等价。
   */
  causeKind?: string | null
  causePackage?: string | null
  causeTarget?: string | null
  causeWindowMs?: number | null
  causePublishedAtMs?: number | null
}

/** 锁存时刻 → 本地 HH:MM:SS（失败档案“失败于”用；非法值回 null，不画时间；#62 跟随宿主 locale）。 */
export function formatLatchTime(atMs: unknown, lang?: AppLang | string | null): string | null {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs <= 0) return null
  const raw = typeof lang === 'string' ? lang.trim().replace(/_/g, '-') : ''
  const l = normalizeLangTag(lang ?? 'zh')
  const primary = l === 'en' ? 'en-US' : 'zh-CN'
  const fallback = l === 'en' ? 'zh-CN' : 'en-US'
  const candidates: string[] = []
  if (raw && raw !== primary && /^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/.test(raw)) candidates.push(raw)
  candidates.push(primary, fallback)
  for (const tag of candidates) {
    try {
      const s = new Date(atMs).toLocaleTimeString(tag, { hour12: false })
      if (s) return s
    } catch {
      // 非法标签即试下一个，保留既有 try/catch 不抛。
    }
  }
  return null
}

// ---------- 失败锁存（#58：安装/查失败常驻，复制诊断锁定致命回包） ----------
//
// 只读轮询（updateStatus）与用户主动动作（查/装）在失败证据上分权：
// - 用户动作的失败回包冻结成锁存；成功的状态轮询永不清除非瞬态锁存。
// - 瞬态（传输抛错）锁存记 volatile，下一次成功读数即清，不留死结。
// - update-busy 永不进锁存（排队态走队列视图实时渲染）。
// - 跨重挂按“插件 + 使用范围”在模块级存活（宿主进程内），进程重启即忘。
export interface FailureLatch {
  code: string
  kind: string | null
  detail: string | null
  diag: unknown
  requestId: string | null
  checkId: string | null
  runningVersion: string | null
  installedVersion: string | null
  latestVersion: string | null
  /** 失败那次安装的目标版本（任务自带；查失败与抛错无此上下文即 null）。 */
  targetVersion: string | null
  hostKind: string | null
  profileName: string | null
  source: 'check' | 'install'
  volatile: boolean
  jobId: string | null
  atMs: number | null
}

export const PANEL_FAILURE_LATCHES = new Map<string, FailureLatch>()
