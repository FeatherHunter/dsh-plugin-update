// src/panel.ts —— 现成整组件（#17 开放形式三件套之三）。
//
// 宿主构造器（src/host.ts：一次调用得电话名与处理器）与构建期派生
// （derive-client-values.mjs：电话名与轮询常量）之后，剩下的第三件就是这个文件：
// 框架无关的整组件。调用者只传标识与摆放参数（pluginId + prefix，另加 mode / showOthers /
// pollMs 可选），面板里放一个挂载点即跑。轮询调度、安装门控、中文一句话、待重启横幅、
// 手工命令展示与复制、排队可见开关、跳过读写承诺、诊断一键复制全在组件内部消化。
//
// 单组件单内核：内嵌与弹窗是同一套内核、同一套 HTML，只差最外层包裹（mode 参数切换），
// 不做两个组件。关闭面板/弹窗只停轮询、不停安装（安装在宿主进程内跑；重开面板立刻重查，
// 默认 1 秒轮询即恢复进度）。
//
// 本文件零 Node 专属能力（不读盘、不起进程、不拼 shell），Node 宿主与浏览器闭包两边都
// 跑得动；DOM 与剪贴板只在 mountUpdatePanel 被调用时经 globalThis 现取，模块顶层不碰。
// 样式隔离走 `dsh-upd` 前缀类 + 按需内联的最小默认样式（跟随系统主题、可被调用方覆盖）。
//
// 与错误架构子地图的分工：回包形状由子地图定，本组件只承诺“有、够、已脱敏”——
// 平时一句话、旁边常驻复制诊断；复制文本经 redactForCopy 收干净后再交出去。

import { buildPhoneNames, DEFAULT_PANEL_POLL_MS, MIN_PANEL_POLL_MS } from './config.js'
import { COPY_BUDGET_CHARS, sanitizeForCopy } from './redaction.js'
import { validReleaseVersion } from './service.js'
import {
  changelogForUpdate,
  parseChangelog,
  renderChangelogHTML,
} from './changelog.js'
import { visibleQueueFor, type UpdateQueueState, type VisibleQueue } from './queue.js'
import type { BlockedReason, UpdateSnapshot } from './ports.js'

// ---------- 公开类型（完整类型定义：公开入口一律有类型，不做源码级复用） ----------

/** 摆放形态：默认内嵌，切弹窗走同一参数。 */
export type UpdatePanelMode = 'embedded' | 'dialog'

/** 面板主题：默认最小可用样式；`d5-paper` 为可选 D5 档案卷专业主题（只换肤，不换 DOM 顺序）。 */
export type UpdatePanelTheme = 'default' | 'd5-paper'

/** 与宿主通话的传输函数：面板只认这个签名，不认任何宿主对象的具体形状。 */
export type UpdatePanelCall = (
  phoneName: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>

/** 复制文本的出口：不传即尝试浏览器剪贴板，都没有则只留“已生成、请手动复制”提示。 */
export type UpdatePanelCopyText = (text: string) => void | Promise<void>

/** 面板可点的动作（与 HTML 里 data-action 一一对应，测试走同一条路）。 */
export type UpdatePanelActionKind =
  | 'check'
  | 'install'
  | 'skip'
  | 'reset-skip'
  | 'copy-manual'
  | 'copy-diag'
  | 'toggle-queue'
  | 'close-view'

export interface UpdatePanelOptions {
  /** 插件标识：必填，与宿主侧 createHostUpdate 传的 pluginId 一致。 */
  pluginId: string
  /** 电话名前缀：默认 wf，必须与宿主侧一致（取值只从这里算，不写字面量）。 */
  prefix?: string
  /** 摆放形态：默认内嵌。 */
  mode?: UpdatePanelMode
  /** 面板主题：默认 `default`（最小可用样式，一字不动）；传 `d5-paper` 切 D5 档案卷可选主题。 */
  theme?: UpdatePanelTheme
  /** 是否看他人排队明细：默认只看自己的（他人仅露正忙占位，位置照给）。 */
  showOthers?: boolean
  /** 轮询间隔毫秒：默认 1000，不得小于 250。 */
  pollMs?: number
  /** 与宿主通话的函数（面板侧唯一的宿主接触面）。 */
  call: UpdatePanelCall
  copyText?: UpdatePanelCopyText
  skipStore?: PanelSkipStore
  /** 宿主种类（调用方知道就传进诊断文本；不传显示“未知”，等 #18 回包契约补全来源）。 */
  hostKind?: string | null
  diagCopyFormat?: DiagCopyFormat
  /**
   * 更新日志 Markdown（#23 包内 CHANGELOG 展示）：
   * 调用方按“已装版离线读、新版按需取 tarball”备好后传入（取不到传 null/空串即中性提示）；
   * 面板只渲染不取数，缺日志永不挡安装、不写 blockedReason。
   */
  changelogMarkdown?: string | null
}

/** 挂载点：只要有 innerHTML 的容器即可（浏览器元素或测试替身都行）。 */
export interface UpdatePanelContainer {
  innerHTML: string
  addEventListener?: (type: string, listener: (ev: unknown) => void) => void
  removeEventListener?: (type: string, listener: (ev: unknown) => void) => void
}

export interface UpdatePanelController {
  /** 立刻重查一次并重绘（挂载时自动调一次，重开面板即恢复进度）。 */
  refresh(): Promise<void>
  /** 点一次按钮（DOM 监听只是它的薄适配，测试直接调它）。 */
  act(kind: UpdatePanelActionKind, arg?: string): Promise<void>
  /** 切换摆放（同一状态重绘同一内核，只换外层包裹）。 */
  setMode(mode: UpdatePanelMode): Promise<void>
  /** 切换主题（同一内核重绘，只换肤；默认主题输出与旧版一字不差）。 */
  setTheme(theme: UpdatePanelTheme): Promise<void>
  /** 切换排队可见性（重查一次，位置口径不变）。 */
  setShowOthers(show: boolean): Promise<void>
  /**
   * 换一版更新日志后重绘（#23：宿主侧备好新文本后调用；传 null/空串即回中性提示）。
   * 只换日志节，安装门控只跟快照，一字不动。
   */
  setChangelogMarkdown(markdown: string | null): void
  /** 卸载：只停轮询、只拆监听，绝不中断安装。 */
  unmount(): void
}

/** 面板本地的跳过读写承诺：按版本记、可重置（宿主侧 skipped.json 是另一套落盘，互不干扰）。 */
export interface PanelSkipStore {
  list(): string[]
  has(version: string): boolean
  skip(version: string): void
  reset(version?: string): void
}

// ---------- 中文一句话（README §5.2：面板只展示“用户该做什么”，不只展示英文原因） ----------

export interface BlockedCopy {
  title: string
  action: string
}

const BLOCKED_COPY: Record<BlockedReason, BlockedCopy> = {
  'unknown-profile': {
    title: '使用范围或插件位置认不出',
    action: '重开宿主再查一次；一直这样就把版本号与日志交给插件作者；这种情形不给手工命令',
  },
  'source-install': {
    title: '当前是从源码装的，不是按版本号装的',
    action: '这种情形不给手工命令；想走更新先按版本号重装一次',
  },
  'invalid-installation': {
    title: '已装的包不完整（名字对不上、版本非法、入口文件缺失）',
    action: '重装当前版本，修好已装目录再查更新',
  },
  'installation-changed': {
    title: '安装位置在使用中途变了（换了目录或换了包）',
    action: '重新打开宿主再查一次；还出现就重装',
  },
  'pending-restart': {
    title: '新版已装到磁盘，正在跑的还是旧版',
    action: '重启宿主，让新版跑起来；这是正常终态，不是失败',
  },
  'registry-conflict': {
    title: '本地声明的版本与磁盘实际版本互相矛盾',
    action: '打开使用范围的清单文件，把目标包名那一行改成版本号再试',
  },
  'incompatible-node': {
    title: '新版要求的 Node 与当前运行的对不上',
    action: '先升级 Node 到 22 或更高，再查更新',
  },
  'recovery-required': {
    title: '上次安装被打断，留下一个半截任务',
    action: '重新点一次安装；一直出现就按第 6 节排错',
  },
}

/** 装不了的原因 → 中文一句话（能装传 null 即回 null，不猜）。 */
export function blockedCopy(reason: BlockedReason | null): BlockedCopy | null {
  if (reason === null || reason === undefined) return null
  return BLOCKED_COPY[reason] ?? null
}

// ---------- 14 码中文文案（#22：8 行 + 5 电话专属 + internal + 未来兜底） ----------
//
// 8 行以 README §5.2 为准（手册是源，代码逐字跟手册，不自创措辞）；
// 5 电话专属 + internal 为本票新增（原型 panel-tolerated-reader 起草，措辞只给行动，不推导）；
// 未来码走兜底（ unknown ），面板只渲染不推导（分支只用稳定码，不碰 diag 明细）。
export interface FailureCopy {
  zh: string
  act: string
}

const PHONE_FAILURE_COPY: Record<string, FailureCopy> = {
  'check-failed': {
    zh: '查新版没成功（联网、源、限流都可能）',
    act: '过一会儿再查一次；一直失败就把复制诊断交给插件作者',
  },
  'invalid-release': {
    zh: '拿到的发布信息不合法（版本号非法或内容对不上）',
    act: '检查清单文件里的包名与版本写法，再查一次',
  },
  'check-expired': {
    zh: '凭证过期了，安装请求被拒',
    act: '重新查一次新版再点安装，不要重试旧编号',
  },
  'update-busy': {
    zh: '同一使用范围正在装另一个',
    act: '等当前任务离开 installing/verifying 再点；排队中去查状态看位置',
  },
  'install-failed': {
    zh: '装不上（详见诊断摘要）',
    act: '先看复制诊断；官方桌面版把这段交给插件作者',
  },
  internal: {
    zh: '出了点问题，认不出具体原因',
    act: '先重试一次；一直这样就把复制诊断交给插件作者',
  },
}

const UNKNOWN_FAILURE_COPY: FailureCopy = {
  zh: '出了点问题，认不出具体原因',
  act: '先重试一次；一直这样就把复制诊断交给插件作者（带上你看到的码）',
}

/** 14 码全表是否包含该码（8 阻塞 + 5 电话 + internal；未来码不在此列，走兜底）。 */
export function isKnownFailureCode(code: unknown): boolean {
  if (typeof code !== 'string' || !code) return false
  const c = code.trim()
  if (!c) return false
  return c in BLOCKED_COPY || c in PHONE_FAILURE_COPY
}

/**
 * 稳定码 → 中文一句话（14 码全覆盖；未知码回未来兜底，空码回 null）。
 * 8 阻塞行复用 BLOCKED_COPY 原文，不另起措辞；面板分支只认返回值，不碰 diag。
 */
export function failureCopy(code: unknown): FailureCopy | null {
  if (typeof code !== 'string') return null
  const c = code.trim()
  if (!c) return null
  const blocked = (BLOCKED_COPY as Record<string, BlockedCopy>)[c]
  if (blocked) return { zh: blocked.title, act: blocked.action }
  const phone = PHONE_FAILURE_COPY[c]
  if (phone) return phone
  return UNKNOWN_FAILURE_COPY
}

/**
 * 失败回包取稳定码：只认 errorKind，error 仅作回退（#22 验收：errorKind=internal 时
 * 不许误判为查新版失败；包内已把未知码收敛为 error=check-failed/errorKind=internal，
 * 此时 error 那格不可信）。缺省回 internal，不抛错。
 */
export function failureCodeOf(
  reply: { error?: unknown; errorKind?: unknown } | null | undefined,
  fallback?: unknown,
): string {
  const kind = reply && typeof reply.errorKind === 'string' ? reply.errorKind.trim() : ''
  if (kind) return kind
  const err = reply && typeof reply.error === 'string' ? reply.error.trim() : ''
  if (err) return err
  if (typeof fallback === 'string' && fallback.trim()) return fallback.trim()
  return 'internal'
}

// ---------- 复制前脱敏（#24 单源收敛：规则唯一源是 src/redaction.ts） ----------
//
// 面板不再自存一份 PANEL_* 镜像：脱敏五条规则、顺序、占位符、丢弃语义、落刀语义
// 全部由 redaction 纯核定义（零 Node 导入，宿主/面板同缝），此处只转调。
// 统一丢弃语义：URL 用户信息命中即整项丢弃（返空串），非遮蔽；
// file:/// 三斜杠缺口显式 known-gap（见 redaction.KNOWN_GAP_FILE_URL_PREFIX），原样放过不静默修。

/** 诊断复制预算（单源：值取 redaction.COPY_BUDGET_CHARS，此处只转出口，老名保留兼容）。 */
export const PANEL_DIAG_MAX_CHARS = COPY_BUDGET_CHARS

/** 复制前把一行文本收干净（确定性：同一输入两次运行逐字节相同；实现见 redaction.sanitizeForCopy）。 */
export function redactForCopy(text: unknown): string {
  return sanitizeForCopy(text)
}

// ---------- 诊断文本（自包含、可粘贴：稳定码 + 脱敏详情 + 版本 + 宿主 + 队列位置） ----------

export interface PanelDiagnosticInput {
  pluginId: string
  /** 稳定码（失败回包的 errorKind 优先，error 仅回退；任务 message 取前缀码）。 */
  code: string
  /** 脱敏前的详情（任务 message 去掉前缀码剩下的部分，可空）。 */
  detail?: string | null
  runningVersion?: string | null
  installedVersion?: string | null
  latestVersion?: string | null
  hostKind?: string | null
  queuePosition?: number | null
  requestId?: string | null
  manual?: string | null
  /** 电话侧 diag（#21 落定前多半没有；有则宽容读，无则走显式字段，缺省说人话）。 */
  diag?: unknown
  /** 显式来源（diag 没有时用；有 diag 时显式优先，缺省仍说人话，不留白）。 */
  route?: string | null
  checkId?: string | null
}

/** 组出一段自包含诊断（调用方直接拿去粘工单/issue；粘之前已脱敏，不必手检）。 */
export function buildDiagnosticText(input: PanelDiagnosticInput): string {
  const code = String(input.code || 'check-failed')
  const lines: string[] = [`[更新诊断] ${String(input.pluginId)} 稳定码：${code}`]
  const detail = redactForCopy(input.detail ?? '')
  lines.push(`人话：${detail || failureCopy(code)?.act || code}`)
  const versions = [
    `运行版：${input.runningVersion ?? '未知'}`,
    `已装：${input.installedVersion ?? '未知'}`,
    `远端：${input.latestVersion ?? '未查过'}`,
  ].join(' / ')
  lines.push(versions)
  const queue =
    input.queuePosition === 0
      ? '正在安装'
      : typeof input.queuePosition === 'number'
        ? `排队第 ${input.queuePosition} 位`
        : '不在队列里'
  lines.push(`宿主：${input.hostKind ?? '未知'} / 队列：${queue}${input.requestId ? ` / 请求编号：${input.requestId}` : ''}`)
  const manual = redactForCopy(input.manual ?? '')
  if (manual) lines.push(`手工命令：${manual}`)
  return redactForCopy(lines.join('\n'))
}

// ---------- 双形态复制块（#22：三行块默认 + 单行 [update-diag] 可选，顺序完全一致） ----------
//
// 顺序由包内定（码 → 摘要 → 来源），两种形态只是排版不同：
// - block：三段（首行码+中文、次行怎么办+摘要、末行来源），默认复制形态；
// - line：单行 `[update-diag] code=… · …`，方便粘进单行输入框。
// 内容顺序完全一致：同一输入先算出同一段数组，再按形态 join。
// 面板只渲染不推导：文案只取 failureCopy(稳定码)，摘要只取 diag.detail/显式 detail
//（脱敏后），来源只取 diag/显式字段，缺省一律说人话，不分支、不猜。

export type DiagCopyFormat = 'block' | 'line'

const DIAG_KNOWN_TYPES: Record<string, string> = {
  v: 'number',
  stage: 'string',
  route: 'string',
  method: 'string',
  httpStatus: 'number',
  exitCode: 'number',
  latencyMs: 'number',
  detail: 'string',
  targetPackageName: 'string',
  runningVersion: 'string',
  latestVersion: 'string',
  environmentKind: 'string',
  requestId: 'string',
  checkId: 'string',
  registryHost: 'string',
  action: 'string',
}

export interface TolerantDiag {
  stage: string | null
  route: string | null
  method: string | null
  httpStatus: number | null
  exitCode: number | null
  latencyMs: number | null
  detail: string | null
  targetPackageName: string | null
  runningVersion: string | null
  latestVersion: string | null
  environmentKind: string | null
  requestId: string | null
  checkId: string | null
  registryHost: string | null
  action: string | null
  /** 目录外的键（如 queuePos 转正前）一律忽略，记在这里仅供排错，不进渲染。 */
  unknownKeys: string[]
}

/** 宽容读 diag：未知键忽略、错类型忽略、缺省当正常（永不抛；面板分支永不用它）。 */
export function readDiagTolerant(diag: unknown): TolerantDiag {
  const empty: TolerantDiag = {
    stage: null,
    route: null,
    method: null,
    httpStatus: null,
    exitCode: null,
    latencyMs: null,
    detail: null,
    targetPackageName: null,
    runningVersion: null,
    latestVersion: null,
    environmentKind: null,
    requestId: null,
    checkId: null,
    registryHost: null,
    action: null,
    unknownKeys: [],
  }
  if (!diag || typeof diag !== 'object' || Array.isArray(diag)) return empty
  const raw = diag as Record<string, unknown>
  const out: TolerantDiag = { ...empty, unknownKeys: [] }
  for (const key of Object.keys(DIAG_KNOWN_TYPES)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    const v = raw[key]
    if (v === undefined || v === null) continue
    if (typeof v !== DIAG_KNOWN_TYPES[key]) continue
    ;(out as unknown as Record<string, unknown>)[key] = v
  }
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(DIAG_KNOWN_TYPES, key)) out.unknownKeys.push(key)
  }
  return out
}

export interface UpdateDiagCopyInput extends PanelDiagnosticInput {
  /** 复制形态：默认三行块；单行用于单行输入框，内容顺序与块完全一致。 */
  format?: DiagCopyFormat
}

function pickText(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return fallback
}

function queueTextOf(queuePosition: number | null | undefined, _diagQueuePos?: unknown): string {
  // 第一性：queuePos 未转正前面板必须忽略（#18 预留未来键，diag.ts 永不产出，原型按目录外键静默丢）。
  // 排队位置只看队列视图；转正后电话侧按目录给，届时再接线，本函数签名保留占位以免误用。
  void _diagQueuePos
  const pos = typeof queuePosition === 'number' ? queuePosition : null
  if (pos === 0) return '正在安装'
  if (typeof pos === 'number') return `排队第 ${pos} 位`
  return '不在队列里'
}

/**
 * 组出 [update-diag] 复制块（双形态同序；调用方直接拿去粘工单/issue，已脱敏）。
 * 第一性：顺序码→摘要→来源（#18 定），怎么办是面板页脚放最后，不插断三元组；
 * 缺省即省略（#18）：路由/请求/检查/阶段等缺失即不出现，不占位“未知”；
 * 插件/版本/宿主/队列恒显（面板侧显式值兜底），摘要缺省给人话，源缺省给人话（省略本身即信息，人读不懂所以必须说）。
 */
export function buildUpdateDiagCopy(input: UpdateDiagCopyInput): string {
  const rawCode = String((input as { code?: unknown }).code ?? '').trim() || 'internal'
  const copy = failureCopy(rawCode) ?? UNKNOWN_FAILURE_COPY
  const diag = readDiagTolerant((input as { diag?: unknown }).diag)
  const detailRaw = diag.detail ?? input.detail ?? ''
  const detail = redactForCopy(detailRaw) || '（本回包没有带诊断摘要，等电话侧 diag 落定后补齐）'
  const pluginName = pickText(diag.targetPackageName ?? input.pluginId, '(未知包)')
  const runVer = pickText(diag.runningVersion ?? input.runningVersion, '?')
  const instVer = pickText(input.installedVersion ?? diag.latestVersion, '?')
  const host = pickText(diag.environmentKind ?? input.hostKind, '未知')
  const routeRaw = (diag.route ?? (input as { route?: unknown }).route) as unknown
  const requestRaw = (diag.requestId ?? input.requestId) as unknown
  const checkRaw = (diag.checkId ?? (input as { checkId?: unknown }).checkId) as unknown
  const queue = queueTextOf(input.queuePosition ?? null)
  // 来源顺序固定：插件 → 版本 → 宿主 → 路由 → 阶段 → 方法 → HTTP/exit/耗时 → 源 → 建议 → 请求/检查 → 队列
  // 缺省即省略：路由/请求/检查等无值即不出现；插件/版本/宿主/队列恒显；源缺省给人话。
  const prov: string[] = [`插件=${pluginName}`, `版本=${runVer}→${instVer}`, `宿主=${host}`]
  if (typeof routeRaw === 'string' && routeRaw.trim()) prov.push(`路由=${routeRaw.trim()}`)
  if (diag.stage) prov.push(`阶段=${diag.stage}`)
  if (diag.method) prov.push(`方法=${diag.method}`)
  if (typeof diag.httpStatus === 'number') prov.push(`HTTP=${diag.httpStatus}`)
  if (typeof diag.exitCode === 'number') prov.push(`exit=${diag.exitCode}`)
  if (typeof diag.latencyMs === 'number') prov.push(`耗时=${diag.latencyMs}ms`)
  if (diag.registryHost) prov.push(`源=${diag.registryHost}`)
  else prov.push('源=未知（非官方源时省略本身即信息）')
  if (diag.action) prov.push(`建议=${diag.action}`)
  if (typeof requestRaw === 'string' && requestRaw.trim()) prov.push(`请求=${requestRaw.trim()}`)
  if (typeof checkRaw === 'string' && checkRaw.trim()) prov.push(`检查=${checkRaw.trim()}`)
  prov.push(`队列=${queue}`)
  const format: DiagCopyFormat = (input as { format?: unknown }).format === 'line' ? 'line' : 'block'
  const provLine = redactForCopy(prov.join(' · '))
  if (format === 'line') {
    const line = `[update-diag] code=${rawCode} · ${copy.zh} · 摘要=${detail} · ${provLine} · 怎么办=${copy.act}`
    return redactForCopy(line)
  }
  // 块形态保留换行：各段已脱敏，不再整块压平（压平会把三行块变成单行）。
  const block = [
    `[update-diag] ${rawCode} — ${copy.zh}`,
    `  摘要：${detail}`,
    `  来源：${provLine}`,
    `  怎么办：${copy.act}`,
  ].join('\n')
  return block
}

// ---------- 跳过存储（面板本地：localStorage 优先，无环境退内存；写坏吞掉不挡更新） ----------

const PANEL_SKIPPED_MAX = 50

function panelSkipKey(pluginId: string): string {
  return `dsh-upd-skipped/${String(pluginId)}`
}

function normalizePanelSkipped(raw: unknown): { version: string; skippedAt: number }[] {
  if (!raw || typeof raw !== 'object') return []
  const list = (raw as { skipped?: unknown }).skipped
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: { version: string; skippedAt: number }[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const version = (item as { version?: unknown }).version
    if (!validReleaseVersion(version) || seen.has(version as string)) continue
    seen.add(version as string)
    const at = (item as { skippedAt?: unknown }).skippedAt
    out.push({ version: version as string, skippedAt: typeof at === 'number' && Number.isFinite(at) ? at : 0 })
  }
  return out.slice(0, PANEL_SKIPPED_MAX)
}

export function createMemorySkipStore(now: () => number = Date.now): PanelSkipStore {
  let skipped: { version: string; skippedAt: number }[] = []
  function assertVersion(version: unknown): string {
    if (!validReleaseVersion(version)) {
      throw new Error(`[dsh-plugin-update] 跳过版本号非法：须为发行版本号（收到 ${JSON.stringify(version)}）`)
    }
    return version as string
  }
  return {
    list: () => skipped.map((e) => e.version),
    has: (version) => (validReleaseVersion(version) ? skipped.some((e) => e.version === version) : false),
    skip: (version) => {
      const v = assertVersion(version)
      const at = now()
      skipped = [{ version: v, skippedAt: typeof at === 'number' && Number.isFinite(at) ? at : 0 }]
        .concat(skipped.filter((e) => e.version !== v))
        .slice(0, PANEL_SKIPPED_MAX)
    },
    reset: (version) => {
      if (version === undefined) skipped = []
      else skipped = skipped.filter((e) => e.version !== version)
    },
  }
}

interface PanelStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function probeStorage(candidate: unknown): PanelStorageLike | null {
  try {
    if (!candidate || typeof candidate !== 'object') return null
    const s = candidate as PanelStorageLike
    if (typeof s.getItem !== 'function' || typeof s.setItem !== 'function' || typeof s.removeItem !== 'function') return null
    return s
  } catch {
    return null
  }
}

/** 浏览器跳过存储（localStorage 形状即可；没有或写坏退内存，绝不因跳过挡住更新）。 */
export function createBrowserSkipStore(
  pluginId: string,
  storage?: unknown,
  now: () => number = Date.now,
): PanelSkipStore {
  const memory = createMemorySkipStore(now)
  const store =
    probeStorage(storage) ??
    probeStorage((globalThis as Record<string, unknown>)['localStorage'] ?? null) ??
    null
  if (!store) return memory
  const active: PanelStorageLike = store
  const key = panelSkipKey(pluginId)
  function read(): { version: string; skippedAt: number }[] {
    try {
      const raw = active.getItem(key)
      if (!raw) return []
      return normalizePanelSkipped(JSON.parse(raw))
    } catch {
      return []
    }
  }
  function write(entries: { version: string; skippedAt: number }[]): void {
    try {
      active.setItem(key, JSON.stringify({ skipped: entries }))
    } catch {
      // best-effort：跳过写不进去也不能挡更新。
    }
  }
  // 启动时把能读到的搬进内存镜像，之后走同一套语义。
  try {
    for (const e of read()) memory.skip(e.version)
  } catch {
    // 读坏自愈为空。
  }
  return {
    list: () => memory.list(),
    has: (version) => memory.has(version),
    skip: (version) => {
      memory.skip(version)
      write(normalizePanelSkipped({ skipped: memory.list().map((v) => ({ version: v, skippedAt: now() })) }))
    },
    reset: (version) => {
      memory.reset(version)
      if (version === undefined) {
        try {
          active.removeItem(key)
        } catch {
          // 删不掉也不挡更新。
        }
      } else {
        write(normalizePanelSkipped({ skipped: memory.list().map((v) => ({ version: v, skippedAt: now() })) }))
      }
    },
  }
}

// ---------- 视图模型（纯函数：快照 → 面板该画什么；安装门控只跟快照，不另写规则） ----------

export interface PanelBanner {
  kind: 'loading' | 'restart' | 'blocked' | 'update' | 'busy' | 'failed' | 'done' | 'idle'
  title: string
  action: string
}

export interface PanelView {
  banner: PanelBanner
  installEnabled: boolean
  installLabel: string
  skippedLatest: boolean
  showManual: boolean
  showReset: boolean
  queueNote: string | null
}

function messageCodeOf(message: unknown): string {
  if (typeof message !== 'string' || !message) return ''
  const at = message.indexOf(':')
  return (at < 0 ? message : message.slice(0, at)).trim()
}

export interface PanelViewInput {
  snapshot: UpdateSnapshot | null
  manual: string | null
  queue: VisibleQueue | null
  skippedLatest: boolean
  lastError: string | null
  /** 失败回包的 errorKind（有则优先于 lastError；internal 时不许误判为查新版失败）。 */
  errorKind?: string | null
  /**
   * 更新日志 Markdown（#23）：只影响日志节的渲染，不参与安装门控。
   * 缺省/空串即中性提示；快照六字段与 blockedReason 一字不动。
   */
  changelogMarkdown?: string | null
}

export function panelViewModel(input: PanelViewInput): PanelView {
  const { snapshot, manual, queue, skippedLatest, lastError } = input
  const errorKind = (input as { errorKind?: unknown }).errorKind
  if (!snapshot) {
    const earlyCode =
      (typeof errorKind === 'string' && errorKind.trim()) || lastError || ''
    if (earlyCode) {
      const copy = failureCopy(earlyCode)
      return {
        banner: {
          kind: 'failed',
          title: `更新失败（${earlyCode}）：${copy?.zh ?? earlyCode}。`,
          action: copy?.act || '复制诊断发给插件作者；深挖看日志通道。',
        },
        installEnabled: false,
        installLabel: '重试安装',
        skippedLatest: false,
        showManual: manual ? true : false,
        showReset: false,
        queueNote: null,
      }
    }
    return {
      banner: { kind: 'loading', title: '正在读取更新状态…', action: '' },
      installEnabled: false,
      installLabel: '安装更新',
      skippedLatest: false,
      showManual: false,
      showReset: false,
      queueNote: null,
    }
  }
  const job = snapshot.job ?? null
  const jobState = job?.state ?? null
  const queueNote =
    queue && queue.busy
      ? queue.position === 0
        ? '正在安装（本插件在装）。'
        : typeof queue.position === 'number'
          ? `前方有安装在进行，本插件排第 ${queue.position} 位，到队首再点安装。`
          : '前方有其他插件在安装，稍后重试。'
      : null
  // 跳过即免打扰：新版本恒重新提醒（跳过按版本记），同一行给恢复入口。
  if (skippedLatest && snapshot.latestVersion) {
    return {
      banner: {
        kind: 'idle',
        title: `已跳过 ${snapshot.latestVersion}`,
        action: '点“恢复”可重新提醒该版本；有更新的新版本会照常提醒。',
      },
      installEnabled: false,
      installLabel: '安装更新',
      skippedLatest: true,
      showManual: false,
      showReset: true,
      queueNote,
    }
  }
  // 待重启是正常终态：只给重启指引与手工命令入口，不再给安装按钮。
  if (snapshot.blockedReason === 'pending-restart') {
    const latest = snapshot.latestVersion ?? snapshot.installedVersion ?? ''
    return {
      banner: {
        kind: 'restart',
        title: `⚠️ 新版 ${latest} 已装好，正在跑的还是 ${snapshot.runningVersion}，重启宿主后生效。`,
        action: BLOCKED_COPY['pending-restart'].action,
      },
      installEnabled: false,
      installLabel: '安装更新',
      skippedLatest: false,
      showManual: manual ? true : false,
      showReset: false,
      queueNote,
    }
  }
  // 安装中：按钮置灰，进度靠轮询恢复（重开面板立刻重查即回进度）。
  if (jobState === 'installing' || jobState === 'verifying') {
    return {
      banner: {
        kind: 'busy',
        title: `正在安装${job?.targetVersion ? ` ${job.targetVersion}` : ''}…关闭面板不会中断。`,
        action: '进度按轮询自动刷新；重开面板 1 秒内恢复显示。',
      },
      installEnabled: false,
      installLabel: '安装中…',
      skippedLatest: false,
      showManual: false,
      showReset: false,
      queueNote,
    }
  }
  // 失败：稳定码 + 一句话 + 常驻复制诊断（分支只认 errorKind，error 仅回退）。
  const jobCode = jobState === 'failed' ? messageCodeOf(job?.message) || 'install-failed' : ''
  const failedCode =
    (typeof errorKind === 'string' && errorKind.trim()) ||
    lastError ||
    jobCode ||
    ''
  if (failedCode || jobState === 'failed' || jobState === 'interrupted') {
    const code = failedCode || 'install-failed'
    const copy = failureCopy(code)
    return {
      banner: {
        kind: 'failed',
        title: `更新失败（${code}）：${copy?.zh ?? code}。`,
        action: copy?.act || '复制诊断发给插件作者；深挖看日志通道。',
      },
      installEnabled: snapshot.canInstall,
      installLabel: '重试安装',
      skippedLatest: false,
      showManual: manual ? true : false,
      showReset: false,
      queueNote,
    }
  }
  // 装不了（除待重启外）：一句话原因。
  if (snapshot.blockedReason) {
    const copy = blockedCopy(snapshot.blockedReason)
    return {
      banner: {
        kind: 'blocked',
        title: copy ? `${copy.title}。` : `${snapshot.blockedReason}。`,
        action: copy?.action || '',
      },
      installEnabled: false,
      installLabel: '安装更新',
      skippedLatest: false,
      showManual: manual ? true : false,
      showReset: false,
      queueNote,
    }
  }
  if (snapshot.canInstall && snapshot.latestVersion) {
    return {
      banner: {
        kind: 'update',
        title: `有新版 ${snapshot.latestVersion} 可装（当前 ${snapshot.runningVersion}）。`,
        action: '点安装即走精确版本安装；同一使用范围同时只装一个。',
      },
      installEnabled: true,
      installLabel: `安装 ${snapshot.latestVersion}`,
      skippedLatest: false,
      showManual: manual ? true : false,
      showReset: false,
      queueNote,
    }
  }
  return {
    banner: { kind: 'done', title: '已是最新，无需更新。', action: '' },
    installEnabled: false,
    installLabel: '安装更新',
    skippedLatest: false,
    showManual: false,
    showReset: false,
    queueNote,
  }
}

// ---------- 渲染（纯函数：同一视图 → 同一内核 HTML；内外摆放只差外层包裹） ----------

export const UPDATE_PANEL_CSS = [
  '.dsh-upd{font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:var(--dsh-upd-fg,#1f2937);',
  'background:var(--dsh-upd-bg,#ffffff);border:1px solid var(--dsh-upd-line,#e5e7eb);border-radius:8px;padding:12px 14px;max-width:560px}',
  '.dsh-upd *{box-sizing:border-box}',
  '.dsh-upd button{font:inherit;border:1px solid var(--dsh-upd-line,#d1d5db);border-radius:6px;background:var(--dsh-upd-btn,#f9fafb);',
  'color:inherit;padding:4px 12px;cursor:pointer;margin:2px 6px 2px 0}',
  '.dsh-upd button:disabled{opacity:.45;cursor:not-allowed}',
  '.dsh-upd button:focus-visible{outline:2px solid var(--dsh-upd-focus,#2563eb);outline-offset:1px}',
  '.dsh-upd button[data-primary="1"]{background:var(--dsh-upd-primary,#2563eb);border-color:var(--dsh-upd-primary,#2563eb);color:#fff}',
  '.dsh-upd-banner{border-left:4px solid var(--dsh-upd-line,#9ca3af);padding:6px 10px;margin:0 0 8px;background:var(--dsh-upd-soft,#f3f4f6)}',
  '.dsh-upd-banner[data-kind="restart"]{border-color:#d97706;background:#fffbeb}',
  '.dsh-upd-banner[data-kind="failed"],.dsh-upd-banner[data-kind="blocked"]{border-color:#dc2626;background:#fef2f2}',
  '.dsh-upd-banner[data-kind="update"]{border-color:#059669;background:#ecfdf5}',
  '.dsh-upd-banner[data-kind="busy"]{border-color:#2563eb;background:#eff6ff}',
  '.dsh-upd code{font-family:Consolas,Menlo,monospace;font-size:12px;word-break:break-all}',
  '.dsh-upd-manual,.dsh-upd-queue,.dsh-upd-log{margin:8px 0;font-size:13px}',
  '.dsh-upd-changelog-wrap{margin:8px 0;font-size:13px;border-top:1px solid var(--dsh-upd-line,#e5e7eb);padding-top:8px}',
  '.dsh-upd-changelog-title{font-weight:700;margin:0 0 4px}',
  '.dsh-upd-changelog-version{margin:6px 0}',
  '.dsh-upd-changelog-catname{font-weight:600;margin:6px 0 2px}',
  '.dsh-upd-changelog ul{margin:2px 0 6px 20px;padding:0}',
  '.dsh-upd-changelog li{margin:2px 0}',
  '.dsh-upd-changelog-fold{margin:4px 0}',
  '.dsh-upd-changelog-fold>summary{cursor:pointer}',
  '.dsh-upd-changelog-neutral{color:inherit;opacity:.8}',
  '.dsh-upd-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:9999}',
  '.dsh-upd-overlay .dsh-upd{background:var(--dsh-upd-bg,#ffffff);max-height:85vh;overflow:auto}',
  '@media (prefers-color-scheme: dark){.dsh-upd{--dsh-upd-fg:#e5e7eb;--dsh-upd-bg:#111827;--dsh-upd-line:#374151;',
  '--dsh-upd-btn:#1f2937;--dsh-upd-soft:#1f2937;--dsh-upd-primary:#3b82f6;--dsh-upd-focus:#93c5fd}}',
].join('\n')

// ---------- D5 档案卷可选主题（#20：只换肤，不换 DOM 顺序） ----------
//
// 约束（验收线）：内核 DOM 冻结——主题只换颜色/字体/间距，不得改顺序、不得藏复制诊断。
// 要素映射（原型 `prototype/redesign/d5-paper.html` → 现有内核类）：
// 迷你印章 → `.dsh-upd-banner::before`（按 data-kind 一字：查/装/启/阻/定；纯 CSS 内容，不加节点）；
// profile 牌 → `.dsh-upd-log code`（现有插件标识 code 穿上牌样式，不加节点）；
// 待重启衬线横幅 → `[data-kind="restart"]` 衬线字体 + 警告配色；
// 手绘 SVG 标 → 待重启标题行左侧背景 SVG（警告三角手绘形，浅深各一色；forced-colors 下自动降级为文字）；
// 窄屏印章固定 → 640px 下印章固定 24px、不被挤掉，操作区换行；
// 优先级逐字折叠 → CSS 省略号逐字折叠（标题行单行省略；JS 引擎不移植：它要 data-fold 标记，会动 DOM）；
// 浅深双主题 → 同一套变量，浅色默认 + `prefers-color-scheme: dark` 深色（跟随系统，与默认主题同口径）。
// 可访问性：焦点环永不去掉；forced-colors 走系统色；reduced-motion 关掉一切过渡动画。
// 复制诊断永不隐藏：本串任何选择器都不对 `[data-action="copy-diag"]` / `.dsh-upd-manual` 写 `display:none`。
export const UPDATE_PANEL_D5_CSS = [
  '/* D5 档案卷可选主题：只换颜色/字体/间距；内核 DOM 顺序一字不动，不断复制诊断。 */',
  '.dsh-upd[data-theme="d5-paper"]{--d5-bg:#f7f3ea;--d5-card:#fffdf6;--d5-ink:#1a1a1a;--d5-muted:#6f675a;',
  '--d5-line:#e3d9c4;--d5-line-strong:#c4b896;--d5-accent:#c8402a;--d5-accent-deep:#9c2e1d;',
  '--d5-ok:#1a7f37;--d5-ok-bg:#e9f4ea;--d5-warn:#8a5a00;--d5-warn-bg:#fbf0d0;',
  '--d5-bad:#b3261e;--d5-bad-bg:#fbe9e5;',
  '--d5-serif:Georgia,"Songti SC","STSong","SimSun","Noto Serif CJK SC","Source Han Serif SC",serif;',
  '--d5-sans:system-ui,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
  '--d5-mono:ui-monospace,"SF Mono",SFMono-Regular,Consolas,"Noto Sans Mono",monospace;',
  '--d5-shadow:0 1px 2px rgba(60,40,20,.08),0 12px 32px rgba(60,40,20,.10);',
  'font-family:var(--d5-sans);color:var(--d5-ink);background:var(--d5-card);',
  'border:1px solid var(--d5-line-strong);border-radius:4px;box-shadow:var(--d5-shadow)}',
  '.dsh-upd[data-theme="d5-paper"] button{border-color:var(--d5-line-strong);background:transparent;color:var(--d5-ink);border-radius:3px;font-family:var(--d5-sans)}',
  '.dsh-upd[data-theme="d5-paper"] button:hover:not(:disabled){border-color:var(--d5-accent);color:var(--d5-accent)}',
  '.dsh-upd[data-theme="d5-paper"] button[data-primary="1"]{background:var(--d5-accent);border-color:var(--d5-accent);color:#fff}',
  '.dsh-upd[data-theme="d5-paper"] button[data-primary="1"]:hover:not(:disabled){background:var(--d5-accent-deep);color:#fff}',
  '.dsh-upd[data-theme="d5-paper"] button:focus-visible{outline:2px solid var(--d5-accent);outline-offset:2px}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner{background:var(--d5-bg);border-color:var(--d5-line-strong)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="update"]{border-color:var(--d5-ok);background:var(--d5-ok-bg)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="busy"]{border-color:var(--d5-warn);background:var(--d5-warn-bg)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="restart"]{border-color:var(--d5-warn);background:var(--d5-warn-bg);font-family:var(--d5-serif);border-width:2px}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="failed"],.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="blocked"]{border-color:var(--d5-bad);background:var(--d5-bad-bg)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="done"]{border-color:var(--d5-ok);background:var(--d5-ok-bg)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner::before{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;margin-right:10px;vertical-align:middle;',
  'border:2px solid currentColor;border-radius:7px;font-family:var(--d5-serif);font-weight:700;font-size:16px;line-height:26px;transform:rotate(-5deg);flex:none}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="loading"]::before,.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="idle"]::before{content:"查";color:var(--d5-muted)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="update"]::before{content:"装";color:var(--d5-ok)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="busy"]::before{content:"装";color:var(--d5-warn)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="restart"]::before{content:"启";color:var(--d5-warn)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="blocked"]::before,.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="failed"]::before{content:"阻";color:var(--d5-bad)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="done"]::before{content:"定";color:var(--d5-ok)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-log code{font-family:var(--d5-mono);font-size:11px;color:var(--d5-muted);border:1px solid var(--d5-line-strong);border-radius:3px;padding:0 6px;letter-spacing:.06em}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-manual code{display:block;background:var(--d5-ink);color:var(--d5-bg);font-family:var(--d5-mono);font-size:12.5px;padding:12px 14px;border-radius:4px;white-space:pre-wrap;word-break:break-all}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="restart"]>div:first-child{background:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2720%27 height=%2720%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%238a5a00%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z%27/%3E%3Cline x1=%2712%27 y1=%279%27 x2=%2712%27 y2=%2713%27/%3E%3Cline x1=%2712%27 y1=%2717%27 x2=%2712.01%27 y2=%2717%27/%3E%3C/svg%3E") no-repeat left center;background-size:20px 20px;padding-left:28px}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner>div:first-child{overflow:hidden;text-overflow:ellipsis}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-actions{flex-wrap:wrap}',
  '@media (max-width:640px){.dsh-upd[data-theme="d5-paper"]{padding:10px 12px}.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner::before{width:24px;height:24px;font-size:14px;line-height:20px;flex:none}.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner>div:first-child{white-space:nowrap}}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="d5-paper"]{--d5-bg:#141210;--d5-card:#1e1a15;--d5-ink:#ece5d3;--d5-muted:#a89c83;',
  '--d5-line:#3a3226;--d5-line-strong:#5c4e3b;--d5-accent:#e0684e;--d5-accent-deep:#f0866b;',
  '--d5-ok:#8fd6a4;--d5-ok-bg:rgba(80,180,120,.12);--d5-warn:#e8c15a;--d5-warn-bg:rgba(232,193,90,.12);',
  '--d5-bad:#ef8a7d;--d5-bad-bg:rgba(239,138,125,.12);--d5-shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px rgba(0,0,0,.45)}}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="d5-paper"] button[data-primary="1"]{color:#141210}.dsh-upd[data-theme="d5-paper"] button:focus-visible{outline-color:var(--d5-accent-deep)}}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="restart"]>div:first-child{background-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2720%27 height=%2720%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23e8c15a%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z%27/%3E%3Cline x1=%2712%27 y1=%279%27 x2=%2712%27 y2=%2713%27/%3E%3Cline x1=%2712%27 y1=%2717%27 x2=%2712.01%27 y2=%2717%27/%3E%3C/svg%3E")}}',
  '@media (forced-colors: active){.dsh-upd[data-theme="d5-paper"]{box-shadow:none}.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner{border:1px solid CanvasText}.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner::before{border-color:CanvasText;color:CanvasText;background:Canvas}.dsh-upd[data-theme="d5-paper"] button{border:1px solid ButtonText}.dsh-upd[data-theme="d5-paper"] button[data-primary="1"]{background:ButtonFace;color:ButtonText;border-color:ButtonText}.dsh-upd[data-theme="d5-paper"] .dsh-upd-banner[data-kind="restart"]>div:first-child{background-image:none;padding-left:0}}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd[data-theme="d5-paper"] *{transition:none !important;animation:none !important}}',
].join('\n')

function escapeHtml(text: string): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export interface PanelRenderInput extends PanelViewInput {
  mode: UpdatePanelMode
  showOthers: boolean
  pluginId: string
  copyNotice: string | null
  /** 可选主题：不传即默认（输出与旧版一字不差）；`d5-paper` 切 D5 档案卷。 */
  theme?: UpdatePanelTheme
}

/** 内核 HTML（双形态行为等价的根：同一视图产出同一内核，只换外层）。 */
export function renderUpdatePanelKernel(input: PanelRenderInput, view: PanelView): string {
  const { snapshot, manual, queue, mode, showOthers, pluginId, copyNotice } = input
  const changelogMarkdown =
    (input as { changelogMarkdown?: unknown }).changelogMarkdown ?? null
  const b = view.banner
  const parts: string[] = []
  parts.push(`<div class="dsh-upd-banner" data-kind="${b.kind}" role="status" aria-live="polite">`)
  parts.push(`<div><strong>${escapeHtml(b.title)}</strong></div>`)
  if (b.action) parts.push(`<div>${escapeHtml(b.action)}</div>`)
  parts.push('</div>')
  parts.push('<div class="dsh-upd-actions">')
  parts.push(
    `<button type="button" data-action="check">查新版</button>` +
      `<button type="button" data-action="install" data-primary="1"${view.installEnabled ? '' : ' disabled'}>${escapeHtml(view.installLabel)}</button>`,
  )
  if (snapshot?.latestVersion && !view.skippedLatest && view.banner.kind === 'update') {
    parts.push(`<button type="button" data-action="skip">跳过该版本</button>`)
  }
  if (view.showReset && snapshot?.latestVersion) {
    parts.push(`<button type="button" data-action="reset-skip">恢复（${escapeHtml(snapshot.latestVersion)}）</button>`)
  }
  if (view.showManual && manual) {
    parts.push(`<button type="button" data-action="copy-manual">复制手工命令</button>`)
  }
  if (snapshot) {
    parts.push(`<button type="button" data-action="copy-diag">复制诊断</button>`)
  }
  if (mode === 'dialog') {
    parts.push(`<button type="button" data-action="close-view">关闭</button>`)
  }
  parts.push('</div>')
  if (view.showManual && manual) {
    parts.push(`<div class="dsh-upd-manual"><div>手工兜底命令（复制整行执行）：</div><code>${escapeHtml(manual)}</code></div>`)
  }
  if (queue && (queue.busy || queue.waiting.length > 0)) {
    const owner =
      queue.owner && 'pluginId' in queue.owner && queue.owner.pluginId
        ? `拥有者：${queue.owner.pluginId === pluginId ? '本插件' : '其他插件'}`
        : queue.owner
          ? '拥有者：其他插件（正忙）'
          : '空闲'
    const waiting = showOthers
      ? queue.waiting.map((e) => `${e.pluginId}${e.targetVersion ? `@${e.targetVersion}` : ''}`).join('、') || '无'
      : queue.waiting.length > 0
        ? `本插件占位 ${queue.waiting.length} 个`
        : '无'
    parts.push(
      `<div class="dsh-upd-queue"><div>排队：${escapeHtml(owner)}；等待：${escapeHtml(waiting)}。` +
        `<button type="button" data-action="toggle-queue">${showOthers ? '隐藏他人明细' : '查看全量排队'}</button></div>` +
        (view.queueNote ? `<div>${escapeHtml(view.queueNote)}</div>` : '') +
        '</div>',
    )
  } else if (view.queueNote) {
    parts.push(`<div class="dsh-upd-queue"><div>${escapeHtml(view.queueNote)}</div></div>`)
  }
  // 更新日志节（#23）：有远端版才画；缺日志中性提示，不挡安装、不写 blockedReason。
  // 安装门控只跟快照，本节只增 HTML，不碰 view.installEnabled 与 snapshot 形状。
  if (snapshot && snapshot.latestVersion) {
    try {
      const mdText = typeof changelogMarkdown === 'string' ? changelogMarkdown : ''
      const entries = parseChangelog(mdText)
      const ranged = changelogForUpdate(
        entries,
        snapshot.runningVersion,
        snapshot.latestVersion,
        snapshot.installedVersion,
      )
      const changelogHTML = renderChangelogHTML(ranged)
      const fromText = String(snapshot.runningVersion ?? '')
      const toText = String(snapshot.latestVersion ?? '')
      const rangeTitle =
        fromText && toText ? `更新说明（${fromText} → ${toText}）：` : '更新说明：'
      parts.push(
        `<div class="dsh-upd-changelog-wrap"><div>${escapeHtml(rangeTitle)}</div>\n${changelogHTML}\n</div>`,
      )
    } catch {
      // 日志画坏了也不挡更新：吞掉即可，安装按钮状态不变。
    }
  }
  parts.push(
    `<div class="dsh-upd-log">深挖看日志：按插件标识 <code>${escapeHtml(pluginId)}</code> 过滤 ` +
      `<code>host.call</code>、<code>host.call.fail</code>、<code>update.install.exec</code> 三个事件。</div>`,
  )
  if (copyNotice) parts.push(`<div class="dsh-upd-copy" role="status">${escapeHtml(copyNotice)}</div>`)
  return parts.join('\n')
}

/** 整面板 HTML（含样式；重绘即整体替换 innerHTML，故每次都带 style 也只留一份）。 */
export function renderUpdatePanelHTML(input: PanelRenderInput): string {
  const view = panelViewModel(input)
  const kernel = renderUpdatePanelKernel(input, view)
  // 主题只换肤：默认主题输出与旧版一字不差（无 data-theme、不带 D5 串）；
  // `d5-paper` 才在根上挂 data-theme 并追加 D5 串；内核 HTML 两边同一份。
  const d5 = input.theme === 'd5-paper'
  const attr = d5 ? ' data-theme="d5-paper"' : ''
  const body =
    input.mode === 'dialog'
      ? `<div class="dsh-upd-overlay" data-mode="dialog"><div class="dsh-upd" data-mode="dialog" data-plugin="${escapeHtml(input.pluginId)}"${attr}>\n${kernel}\n</div></div>`
      : `<div class="dsh-upd" data-mode="embedded" data-plugin="${escapeHtml(input.pluginId)}"${attr}>\n${kernel}\n</div>`
  const css = d5 ? `${UPDATE_PANEL_CSS}\n${UPDATE_PANEL_D5_CSS}` : UPDATE_PANEL_CSS
  return `<style>${css}</style>\n${body}`
}

// ---------- 挂载（单组件入口：调用者只传标识与摆放参数） ----------

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asSnapshot(value: unknown): UpdateSnapshot | null {
  if (!isObject(value)) return null
  const s = value as Partial<Record<keyof UpdateSnapshot, unknown>>
  if (typeof s['runningVersion'] !== 'string') return null
  if (typeof s['canInstall'] !== 'boolean') return null
  return value as unknown as UpdateSnapshot
}

function asQueue(value: unknown): VisibleQueue | null {
  if (!isObject(value) || typeof value['busy'] !== 'boolean') return null
  return value as unknown as VisibleQueue
}

function randomRequestId(): string {
  try {
    const rand = Math.floor(Math.random() * 0xffffff).toString(36)
    return `r${Date.now().toString(36)}${rand}`.slice(0, 64)
  } catch {
    return `r${Date.now()}`
  }
}

function getTimer(): { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void } {
  const g = globalThis as Record<string, unknown>
  const set = g['setInterval']
  const clear = g['clearInterval']
  if (typeof set === 'function' && typeof clear === 'function') {
    return {
      set: (fn, ms) => (set as (fn: () => void, ms: number) => unknown)(fn, ms),
      clear: (h) => (clear as (h: unknown) => void)(h),
    }
  }
  const setT = g['setTimeout']
  const clearT = g['clearTimeout']
  return {
    set: (fn, ms) => (setT as (fn: () => void, ms: number) => unknown)(fn, ms),
    clear: (h) => (clearT as (h: unknown) => void)(h),
  }
}

async function defaultCopyText(text: string): Promise<void> {
  try {
    const holder = (globalThis as Record<string, unknown>)['navigator'] as
      | { clipboard?: { writeText?: (t: string) => Promise<void> } }
      | undefined
    const clip = holder?.clipboard
    const write = clip?.writeText
    if (clip && typeof write === 'function') {
      await write.call(clip, text)
      return
    }
  } catch {
    // 剪贴板不可用即留提示，不抛错（复制失败不能挡更新）。
  }
}

/**
 * 挂载整组件（面板侧一行即跑）：
 * ```js
 * const panel = mountUpdatePanel(document.getElementById('upd'), { pluginId: 'my-plugin', prefix: 'notes', call: host.call })
 * // …离开时 panel.unmount()（只停轮询，安装在宿主侧继续跑）
 * ```
 */
export function mountUpdatePanel(container: UpdatePanelContainer, options: UpdatePanelOptions): UpdatePanelController {
  if (!container || typeof container.innerHTML !== 'string') {
    throw new Error('[dsh-plugin-update] 挂载面板需要一个有 innerHTML 的容器')
  }
  if (!options || typeof options !== 'object') {
    throw new Error('[dsh-plugin-update] 挂载面板缺少配置：插件标识 pluginId 必填')
  }
  const pluginId = options.pluginId
  if (typeof pluginId !== 'string' || !pluginId) {
    throw new Error(`[dsh-plugin-update] 插件标识 pluginId 必填：须为非空字符串（收到 ${JSON.stringify(pluginId)}）`)
  }
  if (typeof options.call !== 'function') {
    throw new Error('[dsh-plugin-update] 挂载面板需要传输函数 call（面板调宿主电话的唯一接触面）')
  }
  const prefix = options.prefix === undefined ? 'wf' : options.prefix
  const phoneNames = buildPhoneNames(prefix)
  const pollMs =
    options.pollMs === undefined ? DEFAULT_PANEL_POLL_MS : options.pollMs
  if (typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs < MIN_PANEL_POLL_MS) {
    throw new Error(`[dsh-plugin-update] 面板轮询间隔非法：不得小于 250 毫秒（收到 ${JSON.stringify(options.pollMs)}）`)
  }
  let mode: UpdatePanelMode = options.mode ?? 'embedded'
  if (mode !== 'embedded' && mode !== 'dialog') {
    throw new Error(`[dsh-plugin-update] 摆放形态非法：只收 embedded 或 dialog（收到 ${JSON.stringify(options.mode)}）`)
  }
  let theme: UpdatePanelTheme = options.theme ?? 'default'
  if (theme !== 'default' && theme !== 'd5-paper') {
    throw new Error(`[dsh-plugin-update] 主题非法：只收 default 或 d5-paper（收到 ${JSON.stringify(options.theme)}）`)
  }
  let showOthers = options.showOthers === true
  const call = options.call
  const copyText = options.copyText ?? defaultCopyText
  const skipStore = options.skipStore ?? createBrowserSkipStore(pluginId)
  const hostKind = typeof options.hostKind === 'string' && options.hostKind ? options.hostKind : null
  const diagCopyFormat: DiagCopyFormat = options.diagCopyFormat === 'line' ? 'line' : 'block'
  let changelogMarkdown: string | null =
    typeof options.changelogMarkdown === 'string' ? options.changelogMarkdown : null

  let snapshot: UpdateSnapshot | null = null
  let manual: string | null = null
  let queue: VisibleQueue | null = null
  let receipt: { checkId: string } | null = null
  let requestId: string | null = null
  let lastError: string | null = null
  let lastErrorKind: string | null = null
  let lastDiag: unknown = null
  let copyNotice: string | null = null
  let mounted = true

  function queueArgs(): Record<string, unknown> {
    return { includeQueue: true, showOthers, ...(requestId ? { requestId } : {}) }
  }

  function render(): void {
    if (!mounted) return
    const latest = snapshot?.latestVersion ?? null
    const skippedLatest = !!latest && validReleaseVersion(latest) && skipStore.has(latest)
    container.innerHTML = renderUpdatePanelHTML({
      snapshot,
      manual,
      queue,
      skippedLatest,
      lastError,
      errorKind: lastErrorKind,
      changelogMarkdown,
      mode,
      showOthers,
      pluginId,
      copyNotice,
      theme,
    })
  }

  function applyStatusReply(reply: Record<string, unknown>): void {
    if (!isObject(reply)) return
    if (reply['ok'] === true) {
      const s = asSnapshot(reply['snapshot'])
      if (s) snapshot = s
      manual = typeof reply['manual'] === 'string' ? (reply['manual'] as string) : null
      if (reply['receipt'] && isObject(reply['receipt']) && typeof reply['receipt']['checkId'] === 'string') {
        receipt = { checkId: reply['receipt']['checkId'] as string }
      }
      const q = asQueue(reply['queue'])
      if (q) queue = q
      lastError = null
      lastErrorKind = null
      lastDiag = Object.prototype.hasOwnProperty.call(reply, 'diag') ? (reply as Record<string, unknown>)['diag'] : null
    } else {
      lastError = typeof reply['error'] === 'string' ? (reply['error'] as string) : 'check-failed'
      lastErrorKind = typeof reply['errorKind'] === 'string' && (reply['errorKind'] as string).trim() ? ((reply['errorKind'] as string).trim()) : null
      lastDiag = Object.prototype.hasOwnProperty.call(reply, 'diag') ? (reply as Record<string, unknown>)['diag'] : null
    }
  }

  async function refresh(): Promise<void> {
    if (!mounted) return
    try {
      const reply = await call(phoneNames.updateStatus, queueArgs())
      if (!mounted) return
      applyStatusReply(reply)
    } catch {
      if (!mounted) return
      lastError = 'check-failed'
      lastErrorKind = null
      lastDiag = null
    }
    render()
  }

  async function act(kind: UpdatePanelActionKind, arg?: string): Promise<void> {
    if (!mounted) return
    copyNotice = null
    switch (kind) {
      case 'check': {
        try {
          const reply = await call(phoneNames.updateCheck, queueArgs())
          if (!mounted) return
          applyStatusReply(reply)
        } catch {
          if (!mounted) return
          lastError = 'check-failed'
          lastErrorKind = null
          lastDiag = null
        }
        render()
        return
      }
      case 'install': {
        try {
          if (!receipt) {
            const checked = await call(phoneNames.updateCheck, queueArgs())
            if (!mounted) return
            applyStatusReply(checked)
          }
          if (!mounted) return
          if (!receipt) {
            lastError = 'check-expired'
            lastErrorKind = 'check-expired'
            lastDiag = null
            render()
            return
          }
          requestId = randomRequestId()
          const reply = await call(phoneNames.updateInstall, {
            checkId: receipt.checkId,
            requestId,
            ...queueArgs(),
          })
          if (!mounted) return
          applyStatusReply(reply)
        } catch {
          if (!mounted) return
          lastError = 'check-failed'
          lastErrorKind = null
          lastDiag = null
        }
        render()
        return
      }
      case 'skip': {
        const v = snapshot?.latestVersion ?? null
        if (v && validReleaseVersion(v)) {
          try {
            skipStore.skip(v)
          } catch {
            // 跳记不进去也不挡更新，只是不免打扰。
          }
        }
        render()
        return
      }
      case 'reset-skip': {
        try {
          skipStore.reset(arg ?? snapshot?.latestVersion ?? undefined)
        } catch {
          // 同上。
        }
        await refresh()
        return
      }
      case 'copy-manual': {
        if (manual) {
          try {
            await copyText(manual)
            copyNotice = '手工命令已复制，粘到终端整行执行即可。'
          } catch {
            copyNotice = '复制失败，请手动选中上面的命令。'
          }
        }
        render()
        return
      }
      case 'copy-diag': {
        const jobCode = snapshot?.job?.state === 'failed' ? messageCodeOf(snapshot.job.message) || 'install-failed' : ''
        const code = failureCodeOf(
          { error: lastError, errorKind: lastErrorKind },
          jobCode || snapshot?.blockedReason || 'check-failed',
        )
        const detail =
          snapshot?.job?.message && snapshot.job.message.includes(':')
            ? snapshot.job.message.slice(snapshot.job.message.indexOf(':') + 1)
            : snapshot?.job?.message
        const text = buildUpdateDiagCopy({
          pluginId,
          code,
          detail,
          runningVersion: snapshot?.runningVersion ?? null,
          installedVersion: snapshot?.installedVersion ?? null,
          latestVersion: snapshot?.latestVersion ?? null,
          hostKind,
          queuePosition: queue?.position ?? null,
          requestId,
          checkId: receipt?.checkId ?? null,
          route: null,
          diag: lastDiag,
          manual,
          format: diagCopyFormat,
        })
        try {
          await copyText(text)
          copyNotice = '诊断已复制，直接粘给插件作者即可（已脱敏）。'
        } catch {
          copyNotice = '复制失败，请手动选中上面的信息。'
        }
        render()
        return
      }
      case 'toggle-queue': {
        showOthers = !showOthers
        await refresh()
        return
      }
      case 'close-view': {
        if (mode === 'dialog') unmount()
        return
      }
    }
  }

  async function setMode(next: UpdatePanelMode): Promise<void> {
    if (next !== 'embedded' && next !== 'dialog') {
      throw new Error(`[dsh-plugin-update] 摆放形态非法：只收 embedded 或 dialog（收到 ${JSON.stringify(next)}）`)
    }
    mode = next
    render()
  }

  async function setTheme(next: UpdatePanelTheme): Promise<void> {
    if (next !== 'default' && next !== 'd5-paper') {
      throw new Error(`[dsh-plugin-update] 主题非法：只收 default 或 d5-paper（收到 ${JSON.stringify(next)}）`)
    }
    theme = next
    render()
  }

  async function setShowOthers(show: boolean): Promise<void> {
    showOthers = show === true
    await refresh()
  }

  function onClick(ev: unknown): void {
    try {
      const t = ev as {
        target?: { closest?: (sel: string) => { getAttribute?: (n: string) => string | null } | null } | null
      }
      const btn = t?.target && typeof t.target.closest === 'function' ? t.target.closest('[data-action]') : null
      const kind = btn?.getAttribute ? btn.getAttribute('data-action') : null
      if (!kind) return
      void act(kind as UpdatePanelActionKind)
    } catch {
      // 点坏了也不挡更新。
    }
  }

  function setChangelogMarkdown(markdown: string | null): void {
    changelogMarkdown = typeof markdown === 'string' ? markdown : null
    render()
  }

  function unmount(): void {
    if (!mounted) return
    mounted = false
    try {
      timer.clear(handle)
    } catch {
      // 停不掉也无妨：安装在宿主侧跑，面板计时器只是轮询。
    }
    try {
      container.removeEventListener?.('click', onClick)
    } catch {
      // 拆不掉也不挡。
    }
    // 卸载只停轮询：绝不调安装/取消电话，安装在宿主进程内继续跑。
  }

  // 首绘即 loading，立刻重查一次（重开 1 秒内恢复进度），再按间隔轮询。
  render()
  try {
    container.addEventListener?.('click', onClick)
  } catch {
    // 没有事件能力的容器也能看（按钮调 controller.act）。
  }
  const timer = getTimer()
  const handle = timer.set(() => {
    void refresh()
  }, pollMs)
  try {
    // 轮询不占进程退出：安装在宿主侧跑，面板计时器只是视图刷新。
    const h = handle as { unref?: () => void } | null
    if (h && typeof h.unref === 'function') h.unref()
  } catch {
    // 无 unref 的环境（浏览器）忽略。
  }
  void refresh()

  return { refresh, act, setMode, setTheme, setShowOthers, setChangelogMarkdown, unmount }
}

// ---------- 面板侧电话名与轮询口径（与派生工具同一源，不写字面量） ----------

export { buildPhoneNames as buildPanelPhoneNames } from './config.js'
export type { PhoneAction as PanelPhoneAction } from './config.js'

/** 面板轮询口径（默认 1 秒、下限 250 毫秒，与宿主侧同一套）。 */
export const PANEL_POLL = {
  defaultMs: DEFAULT_PANEL_POLL_MS,
  minMs: MIN_PANEL_POLL_MS,
} as const

// 队列可见性开关的面板侧形状（转出口：面板凭电话可选参数拿视图，用这里再裁剪）。
export {
  QUEUE_INTENT_TTL_MS,
  emptyQueueState,
  normalizeQueueState,
  queuePositionOf,
  isHeadOfQueue,
  isQueueBusy,
  visibleQueueFor,
} from './queue.js'
export type { QueuedEntry, QueueOwner, UpdateQueueState, VisibleQueue as PanelVisibleQueue, VisibleQueueOwner } from './queue.js'

// 宿主种类（诊断文本用；取值可增，不认就当普通宿主展示）。
export type { EnvironmentKind as PanelEnvironmentKind } from './ports.js'
export type { UpdateSnapshot as PanelSnapshot } from './ports.js'
export type { BlockedReason as PanelBlockedReason } from './ports.js'

// 更新日志纯函数（#23：面板与浏览器闭包同缝，零依赖；I/O 在 changelog-io Node 侧）。
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
  changelogForUpdate,
  hasVisibleSections,
  isUnreleasedVersion,
  parseChangelog,
  renderChangelogHTML,
  renderChangelogNeutral,
  renderChangelogSection,
  selectChangelogEntries,
} from './changelog.js'
export type { ChangelogCategory, ChangelogEntry } from './changelog.js'
