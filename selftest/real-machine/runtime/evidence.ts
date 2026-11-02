/**
 * selftest/real-machine/runtime/evidence.ts —— 证据记录器 + 四态判定引擎（交付物 E 的实现）。
 *
 * 一条 run 的全部可复核材料都由这里落盘（目录布局见 run-layout.ts）：
 *   raw/   命令级原始记录（命令、cwd、exit、stdout/stderr、耗时）——「失败要留原始证据」就靠它
 *   shots/ 截图 png + 同名 .json（看什么/expected/actual/判定 四段）
 *   run.json 机器可读总账：环境、SUT 钉版、断言、截图索引、清理结论、维护者 profile 前后指纹
 *   index.md 一页人读索引
 *
 * 判定四态：pass / fail / known-red / unknown。unknown（没观测到、观测不了）不算通过。
 * 退出码：0=全 pass（known-red 视为已登记的红，不影响出口）；1=有 fail 或 unknown；2=blocked/tool error。
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunLayout } from './run-layout.ts'

/** 判定四态。 */
export type Verdict = 'pass' | 'fail' | 'known-red' | 'unknown'

/** 一条断言（不配图）。 */
export interface AssertionRecord {
  readonly id: string
  readonly step: string
  readonly what: string
  readonly expected: string
  readonly actual: string
  readonly verdict: Verdict
  readonly note?: string
}

/** 一张截图 + 四段 sidecar。 */
export interface ShotRecord extends AssertionRecord {
  readonly png: string
  readonly sidecar: string
}

/** raw/ 里一条原始记录。 */
export interface RawRecord {
  readonly id: string
  readonly name: string
  readonly file: string
  /** 若是一条命令：渲染后的命令行。 */
  command?: string
  exitCode?: number | null
  note?: string
}

/** run.json 里的环境事实。 */
export interface RunEnvironmentFacts {
  readonly node: string
  readonly platform: string
  readonly worktree: string
  readonly branch: string
  readonly head: string
  /** 主机通道：desktop（官方桌面，通道 A）/ dsh-web（普通 DSH 宿主，通道 B）。 */
  readonly hostChannel: string
}

/** SUT 钉版事实（写进 run.json）。 */
export interface SutFacts {
  readonly name: string
  readonly version: string
  readonly tarball: string
  readonly tarballSha256: string
  readonly distDigest: string
  readonly distFiles: number
  readonly registryUrl: string
  /** 安装进隔离 profile 后，磁盘上 dist 的聚合指纹（核对「装的就是本地构建」）。 */
  readonly installedDistDigest?: string
  readonly installedDistMatch?: boolean
}

/** 清理结论（进程/端口/临时 profile 的收尾证据）。 */
export interface CleanupFacts {
  readonly processes: { label: string; pid: number | null; aliveAfterStop: boolean }[]
  readonly ports: { label: string; port: number; released: boolean }[]
  readonly notes?: string[]
}

/** 维护者 profile 前后指纹（证明没污染维护者 DSH_HOME）。 */
export interface MaintainerProfileFacts {
  readonly homeDir: string
  readonly before: Record<string, string>
  readonly after: Record<string, string>
  readonly unchanged: boolean
}

/** run.json 全量结构（证据格式契约，README 里同构说明）。 */
export interface RunManifest {
  readonly schemaVersion: 1
  readonly runId: string
  readonly ticket: string
  readonly scenarioId: string
  readonly hostChannel: string
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly verdict: Verdict
  readonly exitCode: number
  readonly environment: RunEnvironmentFacts
  readonly sut: SutFacts | null
  readonly assertions: readonly AssertionRecord[]
  readonly shots: readonly ShotRecord[]
  readonly raw: readonly RawRecord[]
  readonly cleanup: CleanupFacts | null
  readonly maintainerProfile: MaintainerProfileFacts | null
  readonly notes: readonly string[]
}

/** 判定 → 退出码（0=全 pass；known-red 是已登记的红，不算回归；unknown 不算通过）。 */
export function exitCodeForVerdicts(verdicts: readonly Verdict[]): number {
  if (verdicts.some((verdict) => verdict === 'fail' || verdict === 'unknown')) return 1
  return 0
}

/** 全部判定 → 总判定。 */
export function rollupVerdict(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.some((verdict) => verdict === 'fail')) return 'fail'
  if (verdicts.some((verdict) => verdict === 'unknown')) return 'unknown'
  if (verdicts.some((verdict) => verdict === 'known-red')) return 'known-red'
  return 'pass'
}

/** 记录器初始化入参。 */
export interface EvidenceRecorderInit {
  readonly layout: RunLayout
  readonly scenarioId: string
  readonly environment: RunEnvironmentFacts
}

/** 证据记录器：收集 + 落盘 + 生成索引。 */
export class EvidenceRecorder {
  readonly layout: RunLayout
  readonly scenarioId: string
  readonly startedAt: string
  private readonly environmentFacts: RunEnvironmentFacts
  private readonly assertions: AssertionRecord[] = []
  private readonly shots: ShotRecord[] = []
  private readonly rawRecords: RawRecord[] = []
  private readonly notes: string[] = []
  private sutFacts: SutFacts | null = null
  private cleanupFacts: CleanupFacts | null = null
  private maintainerFacts: MaintainerProfileFacts | null = null
  private sequence = 0

  constructor(init: EvidenceRecorderInit) {
    this.layout = init.layout
    this.scenarioId = init.scenarioId
    this.environmentFacts = init.environment
    this.startedAt = new Date().toISOString()
  }

  /** 下一个证据序号（raw/shots 共用一套序号，文件名按落盘顺序可读）。 */
  private nextId(prefix: string): string {
    this.sequence += 1
    const index = this.sequence < 10 ? '0' + this.sequence : String(this.sequence)
    return index + '-' + prefix
  }

  /** 把任意 JSON 写成一条 raw 记录；返回相对 run 根目录的路径。 */
  async raw(name: string, payload: unknown): Promise<string> {
    const id = this.nextId(name)
    const file = join('raw', id + '.json')
    const record: RawRecord = { id, name, file }
    const commandLike = payload as { command?: string; args?: readonly string[]; exitCode?: number | null }
    if (commandLike && typeof commandLike.command === 'string') {
      record.command = [commandLike.command, ...(commandLike.args || [])].join(' ')
      record.exitCode = commandLike.exitCode === undefined ? null : commandLike.exitCode
    }
    this.rawRecords.push(record)
    await mkdir(this.layout.rawDir, { recursive: true })
    await writeFile(join(this.layout.root, file), JSON.stringify(payload, null, 2) + '\n')
    return file
  }

  /** 记一条断言（不配图）。 */
  recordAssertion(meta: Omit<AssertionRecord, 'id'>): AssertionRecord {
    const record: AssertionRecord = { id: this.nextId('assert'), ...meta }
    this.assertions.push(record)
    return record
  }

  /** 落一张截图 + 同名 .json 四段；png 由调用方从真机 CDP 取回。 */
  async shot(name: string, png: Uint8Array, meta: Omit<ShotRecord, 'id' | 'png' | 'sidecar'>): Promise<ShotRecord> {
    const id = this.nextId(name)
    const pngPath = join(this.layout.shotsDir, id + '.png')
    const sidecarPath = join(this.layout.shotsDir, id + '.json')
    await mkdir(this.layout.shotsDir, { recursive: true })
    await writeFile(pngPath, png)
    const record: ShotRecord = {
      id,
      ...meta,
      png: join('shots', id + '.png'),
      sidecar: join('shots', id + '.json'),
    }
    await writeFile(
      sidecarPath,
      JSON.stringify(
        {
          看什么: meta.what,
          步骤: meta.step,
          expected: meta.expected,
          actual: meta.actual,
          判定: meta.verdict,
          备注: meta.note || null,
          截图: record.png,
        },
        null,
        2,
      ) + '\n',
    )
    this.shots.push(record)
    return record
  }

  setSut(facts: SutFacts): void {
    this.sutFacts = facts
  }

  setCleanup(facts: CleanupFacts): void {
    this.cleanupFacts = facts
  }

  setMaintainerProfile(facts: MaintainerProfileFacts): void {
    this.maintainerFacts = facts
  }

  addNote(note: string): void {
    this.notes.push(note)
  }

  /** 当前所有判定（断言 + 截图）。 */
  verdicts(): Verdict[] {
    return [...this.assertions.map((item) => item.verdict), ...this.shots.map((item) => item.verdict)]
  }

  /** 总判定 + 退出码。 */
  outcome(): { verdict: Verdict; exitCode: number } {
    const verdicts = this.verdicts()
    return { verdict: rollupVerdict(verdicts), exitCode: exitCodeForVerdicts(verdicts) }
  }

  /** 写 run.json + index.md；返回总账。可重复调用（后写覆盖前写，finishedAt 更新）。 */
  async finish(): Promise<RunManifest> {
    const outcome = this.outcome()
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId: this.layout.runId,
      ticket: this.layout.ticket,
      scenarioId: this.scenarioId,
      hostChannel: this.environmentFacts.hostChannel,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      verdict: outcome.verdict,
      exitCode: outcome.exitCode,
      environment: this.environmentFacts,
      sut: this.sutFacts,
      assertions: this.assertions,
      shots: this.shots,
      raw: this.rawRecords,
      cleanup: this.cleanupFacts,
      maintainerProfile: this.maintainerFacts,
      notes: this.notes,
    }
    await writeFile(join(this.layout.root, 'run.json'), JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(join(this.layout.root, 'index.md'), renderRunIndex(manifest))
    return manifest
  }
}

/** 渲染 index.md（一页索引：环境 + 断言表 + 截图表 + 清理 + 总出口）。 */
export function renderRunIndex(manifest: RunManifest): string {
  const lines: string[] = []
  lines.push('# 真机证据索引 · ' + manifest.scenarioId)
  lines.push('')
  lines.push('- runId：' + manifest.runId)
  lines.push('- 票：#' + manifest.ticket.replace(/^#/, ''))
  lines.push('- 宿主通道：' + manifest.hostChannel)
  lines.push('- 开始/结束：' + manifest.startedAt + ' / ' + (manifest.finishedAt || '（未结束）'))
  lines.push('- 总判定：**' + manifest.verdict + '**（退出码 ' + manifest.exitCode + '）')
  lines.push('')
  lines.push('## 环境')
  lines.push('')
  lines.push('- node：' + manifest.environment.node)
  lines.push('- 平台：' + manifest.environment.platform)
  lines.push('- 工作树：' + manifest.environment.worktree + '（分支 ' + manifest.environment.branch + '，HEAD ' + manifest.environment.head + '）')
  if (manifest.sut) {
    lines.push('- SUT：' + manifest.sut.name + '@' + manifest.sut.version + '，tarball sha256 ' + manifest.sut.tarballSha256)
    lines.push('- SUT dist 指纹：' + manifest.sut.distDigest + '（' + manifest.sut.distFiles + ' 个文件）')
    if (manifest.sut.installedDistDigest) {
      lines.push('- 安装后 dist 指纹：' + manifest.sut.installedDistDigest + '（一致=' + String(manifest.sut.installedDistMatch) + '）')
    }
  }
  lines.push('')
  lines.push('## 断言')
  lines.push('')
  lines.push('| # | 步骤 | 看什么 | expected | actual | 判定 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const item of manifest.assertions) {
    lines.push('| ' + item.id + ' | ' + escapeCell(item.step) + ' | ' + escapeCell(item.what) + ' | ' + escapeCell(item.expected) + ' | ' + escapeCell(item.actual) + ' | **' + item.verdict + '** |')
  }
  lines.push('')
  lines.push('## 截图')
  lines.push('')
  lines.push('| # | 步骤 | 看什么 | expected | actual | 判定 | 文件 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const item of manifest.shots) {
    lines.push('| ' + item.id + ' | ' + escapeCell(item.step) + ' | ' + escapeCell(item.what) + ' | ' + escapeCell(item.expected) + ' | ' + escapeCell(item.actual) + ' | **' + item.verdict + '** | [' + item.png.split('/').pop() + '](' + item.png + ') |')
  }
  lines.push('')
  lines.push('## raw 记录')
  lines.push('')
  for (const item of manifest.raw) {
    const suffix = item.command ? '（命令 ' + item.command + '，exit ' + String(item.exitCode) + '）' : ''
    lines.push('- [' + item.name + '](' + item.file + ')' + suffix)
  }
  lines.push('')
  if (manifest.cleanup) {
    lines.push('## 清理')
    lines.push('')
    for (const item of manifest.cleanup.processes) {
      lines.push('- 进程 ' + item.label + '（pid ' + String(item.pid) + '）：停止后存活=' + String(item.aliveAfterStop))
    }
    for (const item of manifest.cleanup.ports) {
      lines.push('- 端口 ' + item.label + '（' + item.port + '）：已释放=' + String(item.released))
    }
    for (const note of manifest.cleanup.notes || []) lines.push('- ' + note)
    lines.push('')
  }
  if (manifest.maintainerProfile) {
    lines.push('## 维护者 profile 未污染')
    lines.push('')
    lines.push('- 目录：' + manifest.maintainerProfile.homeDir)
    lines.push('- 前后一致：' + String(manifest.maintainerProfile.unchanged))
    lines.push('')
  }
  if (manifest.notes.length > 0) {
    lines.push('## 备注')
    lines.push('')
    for (const note of manifest.notes) lines.push('- ' + note)
    lines.push('')
  }
  lines.push('## 从零复跑')
  lines.push('')
  lines.push('命令写在本场景的决策笔记（docs/research）与 selftest/evidence/README.md；本 run 的原始命令见 raw/。')
  lines.push('')
  return lines.join('\n')
}

/** 官方桌面插件管理器的一次 operation（.plugin-manager/logs/operation-* 目录）。 */
export interface PluginManagerOperationFacts {
  readonly dirName: string
  /** 目录创建时间（ISO；birthtime 不可用时退回 ctime）。 */
  readonly createdAt: string
  readonly modifiedAt: string
  readonly pnpmLogBytes: number
  /** pnpm.log 原文（可能为空；空文件是宿主建了 operation 但没起 pnpm 的证据）。 */
  readonly pnpmLog: string
  readonly removed: readonly { name: string; version: string }[]
  readonly added: readonly { name: string; version: string }[]
  readonly doneIn: string | null
  readonly empty: boolean
}

/** 时间窗内 .plugin-manager 的操作序列事实（出口二 remove→install 两步的硬证据）。 */
export interface PluginManagerOperationsFacts {
  readonly profileName: string
  readonly logsDir: string
  readonly window: { readonly fromIso: string; readonly toIso: string }
  readonly operations: readonly PluginManagerOperationFacts[]
  readonly count: number
  readonly nonEmptyCount: number
  readonly order: 'remove-then-add' | 'add-only' | 'remove-only' | 'other'
  readonly copiedFiles: readonly string[]
}

/** 抓一条 pnpm.log 里的依赖变更行（pnpm 输出形状：'- 包名 版本' / '+ 包名 版本'）。 */
function parsePnpmLog(text: string): { removed: { name: string; version: string }[]; added: { name: string; version: string }[]; doneIn: string | null } {
  const removed: { name: string; version: string }[] = []
  const added: { name: string; version: string }[] = []
  for (const match of text.matchAll(/^- (\S+) (\S+)$/gm)) removed.push({ name: match[1], version: match[2] })
  for (const match of text.matchAll(/^\+ (\S+) (\S+)$/gm)) added.push({ name: match[1], version: match[2] })
  const done = /Done in (.+)$/m.exec(text)
  return { removed, added, doneIn: done ? done[1].trim() : null }
}

/**
 * 抓官方桌面插件管理器在 [fromMs,toMs] 时间窗内落下的 operation-* 目录（每个目录一份 pnpm.log）。
 *
 * 判据（T1 真机实测）：成功更新 = 窗口内恰两个非空 operation，先 remove 命中旧版本、后 add 命中新版本；
 * 空 operation 目录是宿主建了 operation 但没起 pnpm（例如 CLI 装基版），窗口过滤后按 empty 记。
 * 每个 pnpm.log 原文经 recorder.raw 落盘，证据包自足。
 */
export async function capturePluginManagerOperations(options: {
  recorder: EvidenceRecorder
  homeDir: string
  profileName: string
  window: { fromMs: number; toMs: number }
}): Promise<PluginManagerOperationsFacts> {
  const logsDir = join(options.homeDir, 'profiles', options.profileName, '.plugin-manager', 'logs')
  const slackMs = 3000
  const entries: PluginManagerOperationFacts[] = []
  try {
    const dirEntries = await readdir(logsDir, { withFileTypes: true })
    for (const entry of dirEntries) {
      if (!entry.isDirectory() || !entry.name.startsWith('operation-')) continue
      const dir = join(logsDir, entry.name)
      let info
      try {
        info = await stat(dir)
      } catch (error) {
        continue
      }
      const createdMs = info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs
      const modifiedMs = info.mtimeMs
      if (createdMs > options.window.toMs + slackMs || modifiedMs < options.window.fromMs - slackMs) continue
      let pnpmLog = ''
      let pnpmLogBytes = 0
      try {
        const buffer = await readFile(join(dir, 'pnpm.log'))
        pnpmLogBytes = buffer.byteLength
        pnpmLog = Buffer.from(buffer).toString('utf8')
      } catch (error) {
        pnpmLog = ''
        pnpmLogBytes = 0
      }
      const parsed = parsePnpmLog(pnpmLog)
      entries.push({
        dirName: entry.name,
        createdAt: new Date(createdMs).toISOString(),
        modifiedAt: new Date(modifiedMs).toISOString(),
        pnpmLogBytes,
        pnpmLog,
        removed: parsed.removed,
        added: parsed.added,
        doneIn: parsed.doneIn,
        empty: pnpmLogBytes === 0,
      })
    }
  } catch (error) {
    // logs 目录不存在 = 该宿主没走插件管理器（例如 CLI 出口）；返回空事实，由场景断言判。
  }
  entries.sort((left, right) => (left.createdAt === right.createdAt ? left.dirName.localeCompare(right.dirName) : left.createdAt.localeCompare(right.createdAt)))
  const copiedFiles: string[] = []
  for (const operation of entries) {
    copiedFiles.push(
      await options.recorder.raw('plugin-manager-operation-' + operation.dirName, {
        dirName: operation.dirName,
        logsDir,
        pnpmLogFile: join(logsDir, operation.dirName, 'pnpm.log'),
        createdAt: operation.createdAt,
        modifiedAt: operation.modifiedAt,
        pnpmLogBytes: operation.pnpmLogBytes,
        pnpmLog: operation.pnpmLog,
        removed: operation.removed,
        added: operation.added,
        doneIn: operation.doneIn,
        empty: operation.empty,
      }),
    )
  }
  const nonEmpty = entries.filter((operation) => !operation.empty)
  const firstRemove = nonEmpty.findIndex((operation) => operation.removed.length > 0)
  const firstAdd = nonEmpty.findIndex((operation) => operation.added.length > 0)
  const order: PluginManagerOperationsFacts['order'] =
    firstRemove >= 0 && firstAdd >= 0
      ? firstRemove < firstAdd
        ? 'remove-then-add'
        : 'other'
      : firstAdd >= 0
        ? 'add-only'
        : firstRemove >= 0
          ? 'remove-only'
          : 'other'
  return {
    profileName: options.profileName,
    logsDir,
    window: { fromIso: new Date(options.window.fromMs).toISOString(), toIso: new Date(options.window.toMs).toISOString() },
    operations: entries,
    count: entries.length,
    nonEmptyCount: nonEmpty.length,
    order,
    copiedFiles,
  }
}

/** Markdown 表格单元格转义（管道符/换行）。 */
function escapeCell(value: string): string {
  return value.split('|').join('\\|').split('\n').join(' ')
}
