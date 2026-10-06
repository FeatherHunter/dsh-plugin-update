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

import { buildChangelogPhoneName, buildPhoneNames, DEFAULT_PANEL_POLL_MS, MIN_PANEL_POLL_MS } from './config.js'
import { COPY_BUDGET_CHARS, sanitizeForCopy } from './redaction.js'
import { validReleaseVersion } from './service.js'
import {
  changelogForUpdate,
  parseChangelog,
  renderChangelogHTML,
  shouldFetchChangelog,
  yankedBannerHTML,
} from './changelog.js'
import { visibleQueueFor, type UpdateQueueState, type VisibleQueue } from './queue.js'
import { LOG_EVENT_CALL, LOG_EVENT_CALL_FAIL, LOG_EVENT_INSTALL_EXEC } from './log-events.js'
import type { BlockedReason, UpdateSnapshot } from './ports.js'

// ---------- 公开类型（完整类型定义：公开入口一律有类型，不做源码级复用） ----------

/** 摆放形态：默认内嵌，切弹窗走同一参数。 */
export type UpdatePanelMode = 'embedded' | 'dialog'

/** 面板主题：默认最小可用样式；`archive` 为档案卷纸面浅色（只换肤，不换 DOM 顺序；`d5-paper` 为旧别名）。 */
/**
 * 面板主题：`default` 最小可用深色；`archive` 档案卷纸面浅色（原型敲定的案卷风格，只换肤）。
 * `d5-paper` 是 archive 的旧别名（历史取值），仍可用，渲染逐字相同。
 */
export type UpdatePanelTheme = 'default' | 'archive' | 'd5-paper'

/**
 * 主题归一：archive 为首选名，旧别名 d5-paper 仍收并归到 archive（DOM 属性只出 archive）；
 * 其余一律回 default（纯渲染函数永不抛；挂载/setTheme 的非法值另行抛错）。
 */
export function normalizePanelTheme(value: unknown): 'default' | 'archive' {
  return value === 'archive' || value === 'd5-paper' ? 'archive' : 'default'
}

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
  | 'restart-hint'
  | 'close-view'
  | 'dismiss-failure'

export interface UpdatePanelOptions {
  /** 插件标识：必填，与宿主侧 createHostUpdate 传的 pluginId 一致。 */
  pluginId: string
  /** 电话名前缀：默认 wf，必须与宿主侧一致（取值只从这里算，不写字面量）。 */
  prefix?: string
  /** 摆放形态：默认内嵌。 */
  mode?: UpdatePanelMode
  /** 面板主题：默认 `default`（最小可用样式，一字不动）；传 `archive` 切档案卷（`d5-paper` 为旧别名）。 */
  theme?: UpdatePanelTheme
  /** 是否看他人排队明细：默认只看自己的（他人仅露正忙占位，位置照给）。 */
  showOthers?: boolean
  /** 是否显示深挖日志指引：默认显示；面向纯终端用户的嵌入可关（失败证据行不受影响）。 */
  showLogHint?: boolean
  /** 轮询间隔毫秒：默认 1000，不得小于 250。 */
  pollMs?: number
  /** 与宿主通话的函数（面板侧唯一的宿主接触面）。 */
  call: UpdatePanelCall
  copyText?: UpdatePanelCopyText
  skipStore?: PanelSkipStore
  /** 宿主种类（调用方知道就传进诊断文本；不传就用宿主 includeEnv 回的宿主种类，再没有显示“未知”）。 */
  hostKind?: string | null
  /**
   * 使用范围名（profile）：**装到哪个范围**的展示面。不传就用宿主 includeEnv 回的真值；
   * 两者都没有时显示“未知”，绝不猜（猜错会让人以为更新装到了别的范围）。
   */
  profileName?: string | null
  /**
   * 「重启宿主」按钮的落地（可选）：宿主没有重启自己的电话，默认点击只提示手动重启；
   * 调用方能把重启流程接进来（拉起自己的重启脚本/提示用户），按钮就交给它。
   */
  onRestartRequested?: () => void | Promise<void>
  diagCopyFormat?: DiagCopyFormat
  /**
   * 更新日志 Markdown（#23 包内 CHANGELOG 展示）：
   * 调用方按“已装版离线读、新版按需取 tarball”备好后传入（取不到传 null/空串即中性提示）；
   * 缺日志永不挡安装、不写 blockedReason。
   * 显式传入即赢：自动链路（见 autoChangelog）永不覆盖它。
   */
  changelogMarkdown?: string | null
  /**
   * 自动取日志（#38）：默认开。有新版时面板按 latestVersion 调一次宿主更新日志电话，
   * 回来经内部通道换日志节；显式传过 changelogMarkdown 或传 false 即退回手动模式。
   */
  autoChangelog?: boolean
  /**
   * 弹窗关闭的落地：只在 dialog 下点「关闭」/按 Esc 时调用；调用方在此撤掉弹窗 DOM。
   * 不传则回退为只停轮询（unmount），DOM 留给调用方处理。入口件打开的 dialog 已内置（收 dialog + 还原按钮）。
   */
  onCloseRequested?: () => void | Promise<void>
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
  /** 使用范围名：装到哪个 profile 是排错第一信息；旧复制不传则该段不出现，新复制块恒显（缺省为未知）。 */
  profileName?: string | null
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
  // 使用范围只在给了的时候出现：不给就与旧输出一字不差（诊断文本是给人粘工单的，不掺空字段）。
  const hostLine = [`宿主：${input.hostKind ?? '未知'}`]
  if (typeof input.profileName === 'string' && input.profileName) hostLine.push(`使用范围：${input.profileName}`)
  hostLine.push(`队列：${queue}`)
  lines.push(hostLine.join(' / ') + (input.requestId ? ` / 请求编号：${input.requestId}` : ''))
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
 * 插件/版本/宿主/使用范围/队列恒显（面板侧显式值兜底），摘要缺省给人话，源缺省给人话（省略本身即信息，人读不懂所以必须说）。
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
  // 来源顺序固定：插件 → 版本 → 宿主 → 使用范围 → 路由 → 阶段 → 方法 → HTTP/exit/耗时 → 源 → 建议 → 请求/检查 → 队列
  // 缺省即省略：路由/请求/检查等无值即不出现；插件/版本/宿主/使用范围/队列恒显；源缺省给人话。
  const prov: string[] = [`插件=${pluginName}`, `版本=${runVer}→${instVer}`, `宿主=${host}`]
  // #45：使用范围恒显（排错第一信息；未知也不猜，与表头口径一致，diag 无此键故只看显式值）。
  prov.push(`使用范围=${pickText((input as { profileName?: unknown }).profileName, '未知')}`)
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
  /** 大印章（状态词）与小印章（一字）：取值与原型 `d5-paper.html:431-432` 的状态映射一一对应。 */
  seal: PanelSeal
}

/** 印章色调：与原型 `seal-ink / seal-green / seal-yellow / seal-red` 四个类同名同义。 */
export type PanelSealTone = 'ink' | 'green' | 'yellow' | 'red'

export interface PanelSeal {
  /** 大印章文字：待查 / 可装 / 安装中 / 待重启 / 受阻 / 已最新。 */
  text: string
  /** 小印章文字：查 / 装 / 启 / 阻 / 定（一字，与原型 sealmini 同口径）。 */
  mini: string
  tone: PanelSealTone
}

/**
 * 状态 → 印章（原型映射表，逐条对齐 d5-paper.html:431-432）：
 * 待查=查/ink、可装=装/green、安装中=装/yellow、待重启=启/yellow、受阻=阻/red、已最新=定/green。
 * 主题无关：默认主题只把它当属性带着（不画），D5 用 CSS 读出来画成印章，DOM 两边仍同一份。
 */
const SEAL_BY_KIND: Record<PanelBanner['kind'], PanelSeal> = {
  loading: { text: '待查', mini: '查', tone: 'ink' },
  idle: { text: '待查', mini: '查', tone: 'ink' },
  update: { text: '可装', mini: '装', tone: 'green' },
  busy: { text: '安装中', mini: '装', tone: 'yellow' },
  restart: { text: '待重启', mini: '启', tone: 'yellow' },
  blocked: { text: '受阻', mini: '阻', tone: 'red' },
  failed: { text: '受阻', mini: '阻', tone: 'red' },
  done: { text: '已最新', mini: '定', tone: 'green' },
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
  const view = panelViewModelCore(input)
  return { ...view, seal: SEAL_BY_KIND[view.banner.kind] ?? SEAL_BY_KIND.idle }
}

function panelViewModelCore(input: PanelViewInput): Omit<PanelView, 'seal'> {
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
        // 文案照原型（d5-paper.html:329）：不带 emoji——警示由横幅左侧的手绘 SVG 标承担，
        // 印章在状态一侧，两者各司其职，不再三重标记。
        title: `新版 ${latest} 已安装，重启宿主后生效。`,
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
  'background:var(--dsh-upd-bg,#ffffff);border:1px solid var(--dsh-upd-line,#e5e7eb);border-radius:8px;padding:12px 14px;max-width:560px;',
  // 横幅配色走变量（浅色默认 + 深色覆盖，见下方 dark 媒体块）：硬编码浅色会让深色下
  // 「浅底 + 浅字」读不出来（现场回归：默认主题深色模式更新横幅白底浅字）。
  '--dsh-upd-ok-bg:#ecfdf5;--dsh-upd-ok-line:#059669;--dsh-upd-warn-bg:#fffbeb;--dsh-upd-warn-line:#d97706;',
  '--dsh-upd-bad-bg:#fef2f2;--dsh-upd-bad-line:#dc2626;--dsh-upd-busy-bg:#eff6ff;--dsh-upd-busy-line:#2563eb}',
  '.dsh-upd *{box-sizing:border-box}',
  '.dsh-upd button{font:inherit;border:1px solid var(--dsh-upd-line,#d1d5db);border-radius:6px;background:var(--dsh-upd-btn,#f9fafb);',
  'color:inherit;padding:4px 12px;cursor:pointer;margin:2px 6px 2px 0}',
  '.dsh-upd button:disabled{opacity:.45;cursor:not-allowed}',
  '.dsh-upd button:focus-visible{outline:2px solid var(--dsh-upd-focus,#2563eb);outline-offset:1px}',
  '.dsh-upd button[data-primary="1"]{background:var(--dsh-upd-primary,#2563eb);border-color:var(--dsh-upd-primary,#2563eb);color:#fff}',
  '.dsh-upd-banner{border-left:4px solid var(--dsh-upd-line,#9ca3af);padding:6px 10px;margin:0 0 8px;background:var(--dsh-upd-soft,#f3f4f6)}',
  '.dsh-upd-banner[data-kind="restart"]{border-color:var(--dsh-upd-warn-line);background:var(--dsh-upd-warn-bg)}',
  '.dsh-upd-banner[data-kind="failed"],.dsh-upd-banner[data-kind="blocked"]{border-color:var(--dsh-upd-bad-line);background:var(--dsh-upd-bad-bg)}',
  '.dsh-upd-banner[data-kind="update"]{border-color:var(--dsh-upd-ok-line);background:var(--dsh-upd-ok-bg)}',
  '.dsh-upd-banner[data-kind="busy"]{border-color:var(--dsh-upd-busy-line);background:var(--dsh-upd-busy-bg)}',
  '.dsh-upd code{font-family:Consolas,Menlo,monospace;font-size:12px;word-break:break-all}',
  '.dsh-upd-manual,.dsh-upd-queue,.dsh-upd-log{margin:4px 0;font-size:13px}',
  '.dsh-upd-changelog-wrap{margin:4px 0 0;font-size:13px}',
  '.dsh-upd-changelog-title{font-weight:700;margin:0 0 4px}',
  '.dsh-upd-changelog-version{margin:6px 0}',
  '.dsh-upd-changelog-catname{font-weight:600;margin:6px 0 2px}',
  '.dsh-upd-changelog ul{margin:2px 0 6px 20px;padding:0}',
  '.dsh-upd-changelog li{margin:2px 0}',
  '.dsh-upd-changelog-fold{margin:4px 0}',
  '.dsh-upd-changelog-fold>summary{cursor:pointer}',
  '.dsh-upd-changelog-count{font-size:12px;opacity:.7;margin:2px 0 4px}',
  '.dsh-upd-changelog-yanked{border-left:4px solid var(--dsh-upd-warn-line,#d97706);background:var(--dsh-upd-warn-bg,#fffbeb);padding:6px 10px;margin:6px 0;font-size:13px}',
  '.dsh-upd-breaking-badge{display:inline-block;font-size:11px;font-weight:700;border:1px solid currentColor;border-radius:3px;padding:0 5px;margin-right:6px;vertical-align:baseline}',
  '.dsh-upd-changelog-security-more{margin:4px 0 6px}',
  '.dsh-upd-changelog-security-more>summary{cursor:pointer;font-size:12px;opacity:.8}',
  '.dsh-upd-changelog-more-note{font-size:12px;opacity:.7;margin:2px 0 4px}',
  '.dsh-upd-changelog-neutral{color:inherit;opacity:.8}',
  '.dsh-upd-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:9999}',
  '.dsh-upd-overlay .dsh-upd{background:var(--dsh-upd-bg,#ffffff);max-height:85vh;overflow:auto}',
  // —— 档案头 / 版本条 / 章节 / 进度条 / 跳过行（原型 :208-245 的新结构，默认主题给最小可用样式）——
  '.dsh-upd-head{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}',
  // 卷宗抬头「插件更新 / 更新档案 卷」：D5 档案卷才画，默认（最小）主题不画。
  // 两个主题共用同一份内核 HTML（见 renderUpdatePanelHTML 的注释），画不画是皮肤决定的事。
  '.dsh-upd-masthead{display:none}',
  '.dsh-upd-name{font-weight:700}',
  '.dsh-upd-meta{font-size:12.5px;opacity:.75}',
  '.dsh-upd-proftag{font-family:Consolas,Menlo,monospace;font-size:11px;border:1px solid var(--dsh-upd-line,#d1d5db);border-radius:3px;padding:0 5px;margin-left:6px;letter-spacing:.06em}',
  '.dsh-upd-strip{display:flex;flex-wrap:wrap;margin:8px 0 0;border:1px solid var(--dsh-upd-line,#e5e7eb);border-radius:4px;overflow:hidden;font-size:12.5px}',
  '.dsh-upd-strip>div{flex:1 1 110px;padding:6px 10px;border-left:1px solid var(--dsh-upd-line,#e5e7eb)}',
  '.dsh-upd-strip>div:first-child{border-left:0}',
  '.dsh-upd-strip-k{display:block;font-size:11px;letter-spacing:.14em;opacity:.7}',
  '.dsh-upd-strip-v{font-family:Consolas,Menlo,monospace;font-size:12.5px}',
  '.dsh-upd-chapter{margin-top:14px;padding-top:10px;border-top:1px solid var(--dsh-upd-line,#e5e7eb)}',
  // 右下角独立 footer 区（#47 定案 A）：与第一章 actions 脱钩，右对齐，一次找到。
  '.dsh-upd-footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:14px;padding-top:10px;border-top:1px solid var(--dsh-upd-line,#e5e7eb)}',
  '.dsh-upd-foot-note{margin-right:auto;font-size:12px;opacity:.7}',
  '.dsh-upd-footer button{margin:0}',
  '.dsh-upd-chap-head{display:flex;align-items:baseline;gap:10px;margin-bottom:6px}',
  '.dsh-upd-chap-no{font-size:13px;font-style:italic;opacity:.6}',
  '.dsh-upd-chap-title{font-size:14px;margin:0}',
  '.dsh-upd-chap-rule{flex:1;border-top:1px solid var(--dsh-upd-line,#e5e7eb);transform:translateY(-3px)}',
  // 03 章标题行右端的开关（问题 3 定案：按钮形态、挪到标题行）。
  '.dsh-upd-chap-note{flex:none;font-size:12px;opacity:.75}',
  '.dsh-upd-chap-note button{margin:0}',
  // 更新队列两行键值（用户定案的设计）：结构两主题共用，皮肤各自收敛。
  '.dsh-upd-qrow{display:flex;align-items:baseline;gap:10px;padding:6px 0}',
  '.dsh-upd-qrow+.dsh-upd-qrow{border-top:1px solid var(--dsh-upd-line,#e5e7eb)}',
  '.dsh-upd-qdot{width:8px;height:8px;border-radius:50%;flex:none;align-self:center;background:currentColor;opacity:.5}',
  '.dsh-upd-qdot[data-tone="busy"]{background:var(--dsh-upd-warn-line,#d97706);opacity:1}',
  '.dsh-upd-qdot[data-tone="you"]{background:var(--dsh-upd-primary,#2563eb);opacity:1}',
  '.dsh-upd-qk{flex:none;width:5.5em;font-size:12px;opacity:.7}',
  '.dsh-upd-qv{font-weight:600}',
  '.dsh-upd-qn{margin-left:auto;font-size:12px;opacity:.7}',
  '.dsh-upd-qseq{font-family:Consolas,Menlo,monospace;font-size:12px;word-break:break-all}',
  '.dsh-upd-prog{height:8px;background:var(--dsh-upd-line,#e5e7eb);border-radius:4px;overflow:hidden;margin:10px 0 4px}',
  '.dsh-upd-prog-bar{display:block;height:100%;background:var(--dsh-upd-primary,#2563eb);transition:width .3s}',
  '.dsh-upd-progtxt{font-size:12.5px;opacity:.75}',
  '.dsh-upd-skipline{font-size:13px;margin-top:8px}',
  // 骨架微光：只在首帧 loading 出现；reduced-motion 下静止占位，不断语义。
  '.dsh-upd-skv{display:inline-block;min-width:64px;border-radius:3px;color:transparent !important;user-select:none;',
  'background:linear-gradient(90deg,var(--dsh-upd-line,#e5e7eb) 25%,var(--dsh-upd-soft,#f3f4f6) 50%,var(--dsh-upd-line,#e5e7eb) 75%);',
  'background-size:200% 100%;animation:dsh-upd-shimmer 1.2s linear infinite}',
  '@keyframes dsh-upd-shimmer{to{background-position:-200% 0}}',
  '.dsh-upd-tag{display:inline-block;border:1px dashed currentColor;border-radius:3px;padding:1px 8px;margin-right:8px;font-family:Consolas,Menlo,monospace;font-size:12px}',
  '.dsh-upd-err{font-size:13px;margin:0 0 6px}',
  // —— 全按钮交互反馈（#36：悬停/按下/过渡/在途忙态；浅深双主题通用写法，不碰上面的既有串）——
  '.dsh-upd button{transition:background-color .15s ease,border-color .15s ease,color .15s ease,transform .06s ease}',
  '.dsh-upd button:hover:not(:disabled){border-color:var(--dsh-upd-focus,#2563eb)}',
  '.dsh-upd button[data-primary="1"]:hover:not(:disabled){filter:brightness(.93)}',
  '.dsh-upd button:active:not(:disabled){transform:translateY(1px)}',
  '.dsh-upd button[aria-busy="true"]{cursor:wait;animation:dsh-upd-pulse 1s ease-in-out infinite}',
  '@keyframes dsh-upd-pulse{0%,100%{opacity:1}50%{opacity:.55}}',
  // 在途转圈：纯 CSS ::after，不加 DOM 节点（内核 DOM 冻结）；转的是边框缺口，不是 emoji。
  '.dsh-upd button[aria-busy="true"]::after{content:"";display:inline-block;width:11px;height:11px;margin-left:8px;vertical-align:-1px;',
  'border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:dsh-upd-spin .8s linear infinite}',
  '@keyframes dsh-upd-spin{to{transform:rotate(360deg)}}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd button{transition:none}.dsh-upd button:active:not(:disabled){transform:none}.dsh-upd button[aria-busy="true"]{animation:none}.dsh-upd-skv{animation:none}}',
  '@media (prefers-color-scheme: dark){.dsh-upd{--dsh-upd-fg:#e5e7eb;--dsh-upd-bg:#111827;--dsh-upd-line:#374151;',
  '--dsh-upd-btn:#1f2937;--dsh-upd-soft:#1f2937;--dsh-upd-primary:#3b82f6;--dsh-upd-focus:#93c5fd;',
  // 横幅深色覆盖：底色用低透明度同色系（不是浅色原值），边线提亮，保证「深底浅字」可读。
  '--dsh-upd-ok-bg:rgba(16,185,129,.14);--dsh-upd-ok-line:#34d399;',
  '--dsh-upd-warn-bg:rgba(245,158,11,.16);--dsh-upd-warn-line:#fbbf24;',
  '--dsh-upd-bad-bg:rgba(239,68,68,.16);--dsh-upd-bad-line:#f87171;',
  '--dsh-upd-busy-bg:rgba(59,130,246,.16);--dsh-upd-busy-line:#60a5fa}}',
].join('\n')

// ---------- D5 档案卷可选主题（#20：只换肤，不换 DOM 顺序） ----------
//
// 约束（验收线）：内核 DOM 冻结——主题只换颜色/字体/间距，不得改顺序、不得藏复制诊断。
// 要素映射（原型 `prototype/redesign/d5-paper.html` → 现有内核类，逐条对齐原型行号）：
// 大印章 → 根元素 `::before` + `content:attr(data-seal)`（原型 :206 `.seal`，右上 88px 旋转 -7°，
//          外框 + 内细框用两条 inset 阴影合成，不加节点）；色调按 `data-seal-tone` 四档。
// 小印章 → `.dsh-upd-banner::before` + `content:attr(data-mini)`（原型 :215 `.sealmini`，30px 旋转 -5°）；
//          **待重启横幅不画印章**——那一档的标记是手绘 SVG（原型 :446 `.mark` 只有 SVG）。
// profile 牌 → `.dsh-upd-log code`（现有插件标识 code 穿上牌样式，不加节点）；
// 待重启衬线横幅 → `[data-kind="restart"]` 衬线字体 + 警告配色 + 标题行左侧 SVG 标；
// 窄屏印章固定 → 640px 下印章固定 24px、不被挤掉，操作区换行；
// 优先级逐字折叠 → CSS 省略号逐字折叠（标题行单行省略；JS 引擎不移植：它要 data-fold 标记，会动 DOM）；
// 浅深双主题 → 同一套变量，浅色默认 + `prefers-color-scheme: dark` 深色（跟随系统，与默认主题同口径）。
// 可访问性：焦点环永不去掉；forced-colors 走系统色；reduced-motion 关掉一切过渡动画。
// 复制诊断永不隐藏：本串任何选择器都不对 `[data-action="copy-diag"]` / `.dsh-upd-manual` 写 `display:none`。
export const UPDATE_PANEL_D5_CSS = [
  '/* D5 档案卷可选主题：只换颜色/字体/间距；内核 DOM 顺序一字不动，不断复制诊断。 */',
  '.dsh-upd[data-theme="archive"]{--d5-bg:#f7f3ea;--d5-card:#fffdf6;--d5-ink:#1a1a1a;--d5-muted:#6f675a;',
  '--d5-line:#e3d9c4;--d5-line-strong:#c4b896;--d5-accent:#c8402a;--d5-accent-deep:#9c2e1d;',
  '--d5-ok:#1a7f37;--d5-ok-bg:#e9f4ea;--d5-warn:#8a5a00;--d5-warn-bg:#fbf0d0;',
  '--d5-bad:#b3261e;--d5-bad-bg:#fbe9e5;',
  '--d5-serif:Georgia,"Songti SC","STSong","SimSun","Noto Serif CJK SC","Source Han Serif SC",serif;',
  '--d5-sans:system-ui,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
  '--d5-mono:ui-monospace,"SF Mono",SFMono-Regular,Consolas,"Noto Sans Mono",monospace;',
  '--d5-shadow:0 1px 2px rgba(60,40,20,.08),0 12px 32px rgba(60,40,20,.10);',
  'font-family:var(--d5-sans);color:var(--d5-ink);background:var(--d5-card);',
  'border:1px solid var(--d5-line-strong);border-radius:4px;box-shadow:var(--d5-shadow)}',
  // 按钮脸自己不透明（宿主底色未知时也读得出；卡片上渲染与 transparent 逐字同色）。
  '.dsh-upd[data-theme="archive"] button{border-color:var(--d5-line-strong);background:var(--d5-card);color:var(--d5-ink);border-radius:3px;font-family:var(--d5-sans)}',
  '.dsh-upd[data-theme="archive"] button:hover:not(:disabled){border-color:var(--d5-accent);color:var(--d5-accent)}',
  '.dsh-upd[data-theme="archive"] button[data-primary="1"]{background:var(--d5-accent);border-color:var(--d5-accent);color:#fff}',
  '.dsh-upd[data-theme="archive"] button[data-primary="1"]:hover:not(:disabled){background:var(--d5-accent-deep);color:#fff}',
  '.dsh-upd[data-theme="archive"] button:focus-visible{outline:2px solid var(--d5-accent);outline-offset:2px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner{background:var(--d5-bg);border-color:var(--d5-line-strong)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="update"]{border-color:var(--d5-ok);background:var(--d5-ok-bg)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="busy"]{border-color:var(--d5-warn);background:var(--d5-warn-bg)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]{border-color:var(--d5-warn);background:var(--d5-warn-bg);font-family:var(--d5-serif);border-width:2px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="failed"],.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="blocked"]{border-color:var(--d5-bad);background:var(--d5-bad-bg)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="done"]{border-color:var(--d5-ok);background:var(--d5-ok-bg)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-yanked{border-color:var(--d5-warn);background:var(--d5-warn-bg);color:var(--d5-ink)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-breaking-badge{color:var(--d5-accent);border-color:var(--d5-accent)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-count{color:var(--d5-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-more-note{color:var(--d5-muted)}',
  // —— 大印章（原型 :206 `.seal`：右上 88px、旋转 -7°、双细框；内容与色调来自根属性，不加节点）——
  '.dsh-upd[data-theme="archive"]{position:relative;padding:16px 20px 14px}',
  '.dsh-upd[data-theme="archive"]::before{content:attr(data-seal);position:absolute;top:20px;right:24px;width:88px;height:88px;',
  'display:flex;align-items:center;justify-content:center;text-align:center;letter-spacing:.18em;text-indent:.18em;line-height:1.35;',
  'border:3px solid currentColor;border-radius:14px;transform:rotate(-7deg);font-family:var(--d5-serif);font-weight:700;font-size:21px;',
  'background:color-mix(in srgb,currentColor 8%,transparent);user-select:none;pointer-events:none;',
  'box-shadow:inset 0 0 0 5px var(--d5-card),inset 0 0 0 6px currentColor,0 2px 6px rgba(0,0,0,.12)}',
  '.dsh-upd[data-theme="archive"][data-seal-tone="ink"]::before{color:var(--d5-muted)}',
  '.dsh-upd[data-theme="archive"][data-seal-tone="green"]::before{color:var(--d5-ok)}',
  '.dsh-upd[data-theme="archive"][data-seal-tone="yellow"]::before{color:var(--d5-warn)}',
  '.dsh-upd[data-theme="archive"][data-seal-tone="red"]::before{color:var(--d5-bad)}',
  // 印章占位：首行（横幅/状态行）右侧留出 120px，文字不许压到印章上（原型 .filehead padding-right:120px）
  // —— 卷宗抬头（原型 :195-203 的刊头，主题切换按钮按用户口径去掉）：只有 D5 档案卷才显示 ——
  '.dsh-upd[data-theme="archive"] .dsh-upd-masthead{display:block;padding:0 0 8px;margin:0 0 8px;border-bottom:1px solid var(--d5-line)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-masthead-kicker{display:block;font-size:11px;letter-spacing:.35em;color:var(--d5-muted);margin-bottom:3px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-masthead-title{font-family:var(--d5-serif);font-size:26px;font-weight:700;line-height:1.2}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-masthead-title i{color:var(--d5-accent);font-style:normal}',
  // 横幅不再给大印章留 124px：实测（headless 量盒子）印章盒底边 y=109，横幅正文顶边 y=108、
  // 状态行那句在 y=159——印章只压到横幅顶部的留白带，压不到正文。留着反而把 27px 那句话挤成两行
  // （27px 单行需 428px，留白后只剩 366px）。档案头那 120px 保留：那里是真的重叠。
  // —— 更新队列（03 章）D5 皮肤 ——
  '.dsh-upd[data-theme="archive"] .dsh-upd-qrow{padding:6px 0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-qk{width:66px;letter-spacing:.18em}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-qv{font-family:var(--d5-serif);font-size:16px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-qn{font-family:var(--d5-mono);font-size:11.5px;color:var(--d5-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-qseq{color:var(--d5-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-note{color:var(--d5-muted)}',
  // —— 小印章（原型 :215 `.sealmini`：30px、旋转 -5°、一字）——
  // 待重启横幅一律不画印章：那一档的标记是左侧手绘 SVG（原型 :446 的 .mark 只有 SVG）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="loading"]::before,.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="idle"]::before,',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="update"]::before,.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="busy"]::before,',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="blocked"]::before,.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="failed"]::before,',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="done"]::before{content:attr(data-mini);display:inline-flex;align-items:center;justify-content:center;',
  'width:30px;height:30px;margin-right:10px;vertical-align:middle;border:2px solid currentColor;border-radius:7px;',
  'font-family:var(--d5-serif);font-weight:700;font-size:16px;line-height:26px;transform:rotate(-5deg);flex:none;color:var(--d5-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="update"]::before{color:var(--d5-ok)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="busy"]::before{color:var(--d5-warn)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="blocked"]::before,.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="failed"]::before{color:var(--d5-bad)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="done"]::before{color:var(--d5-ok)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-log code{font-family:var(--d5-mono);font-size:11px;color:var(--d5-muted);border:1px solid var(--d5-line-strong);border-radius:3px;padding:0 6px;letter-spacing:.06em}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-manual code{display:block;background:var(--d5-ink);color:var(--d5-bg);font-family:var(--d5-mono);font-size:12.5px;padding:12px 14px;border-radius:4px;white-space:pre-wrap;word-break:break-all}',
  // 待重启标记：手绘 SVG 当**独立 flex 标记**放在文字块左侧（原型 :446 `.mark` 是独立节点），
  // 不能用行内背景——那样换行时三角会落在句子中间把话劈开（现场回归）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child{display:flex;gap:10px;align-items:flex-start}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child::before{content:"";flex:none;width:20px;height:20px;margin-top:3px;',
  'background:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2720%27 height=%2720%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%238a5a00%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z%27/%3E%3Cline x1=%2712%27 y1=%279%27 x2=%2712%27 y2=%2713%27/%3E%3Cline x1=%2712%27 y1=%2717%27 x2=%2712.01%27 y2=%2717%27/%3E%3C/svg%3E") no-repeat center/20px 20px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child{overflow:hidden;text-overflow:ellipsis}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions{flex-wrap:wrap}',
  // footer 只换肤（#47 定案 A + D5 约束：不换 DOM 顺序；复制诊断永不隐藏，本串不动它）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-footer{margin-top:14px;padding-top:10px;border-top:1px solid var(--d5-line)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-foot-note{color:var(--d5-muted)}',
  // —— 档案头（原型 :208-211 `.filehead`：serif 插件名 22px + 使用范围 + profile 牌；右侧留章位）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-head{display:flex;gap:16px;align-items:baseline;flex-wrap:wrap;padding-right:120px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-name{font-family:var(--d5-serif);font-size:22px;font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-meta{width:100%;font-size:12.5px;color:var(--d5-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-meta b{color:var(--d5-ink);font-weight:600}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-proftag{font-family:var(--d5-mono);font-size:11px;color:var(--d5-muted);border:1px solid var(--d5-line-strong);border-radius:3px;padding:0 6px;margin-left:8px;letter-spacing:.06em}',
  // —— 版本条（原型 :216 `.strip`：三格，格间一线，左上小写标签 + 等宽值）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip{display:flex;flex-wrap:wrap;margin:8px 0 0;border:1px solid var(--d5-line);border-radius:4px;overflow:hidden;font-size:12.5px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip>div{flex:1 1 120px;padding:6px 10px;border-left:1px solid var(--d5-line)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip>div:first-child{border-left:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip-k{display:block;font-size:11px;letter-spacing:.2em;color:var(--d5-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip-v{font-family:var(--d5-mono);font-size:13px}',
  // —— 章节（原型 :218-245：01–05 编号 + 衬线标题 + 细线）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-chapter{margin-top:16px;padding-top:10px;border-top:1px solid var(--d5-line)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-head{display:flex;align-items:baseline;gap:12px;margin-bottom:6px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-no{font-family:var(--d5-serif);font-style:italic;font-size:15px;color:var(--d5-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-title{font-family:var(--d5-serif);font-size:17px;margin:0;letter-spacing:.1em}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-rule{flex:1;border-top:1px solid var(--d5-line);transform:translateY(-4px)}',
  // —— 横幅即状态行 / 待重启横幅（原型 :81-85 `.restart-banner`：2px 边框、圆角 4、内边距 12/16、衬线；右侧留章位）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner{border:2px solid var(--d5-line-strong);border-radius:4px;padding:10px 12px;font-size:14.5px;font-family:var(--d5-serif);display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child{flex:1 1 auto;min-width:0}',
  // 状态行字号照原型 .status-line=27px（实测去掉横幅右侧占位后可写 486px > 428px，一行放得下）
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child strong{font-family:var(--d5-serif);font-size:27px;font-weight:700;line-height:1.25}',
  // —— 进度条 / 跳过行（原型 :132-133 `.prog`、:129-131 `.skipline .tag`）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-prog{height:8px;background:var(--d5-line);border-radius:4px;overflow:hidden;margin:10px 0 4px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-prog-bar{display:block;height:100%;background:var(--d5-accent);transition:width .3s}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-progtxt{font-size:12.5px;color:var(--d5-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-skipline{font-size:13px;margin-top:8px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-tag{display:inline-block;border:1px dashed var(--d5-line-strong);border-radius:3px;padding:1px 8px;margin-right:8px;font-family:var(--d5-mono);font-size:12px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-err{font-size:13px;margin:0 0 6px;color:var(--d5-muted)}',
  '@media (max-width:640px){.dsh-upd[data-theme="archive"]{padding:10px 12px}.dsh-upd[data-theme="archive"]::before{top:12px;right:12px;width:56px;height:56px;font-size:15px;box-shadow:inset 0 0 0 4px var(--d5-card),inset 0 0 0 5px currentColor}.dsh-upd[data-theme="archive"] .dsh-upd-masthead-title{font-size:19px}.dsh-upd[data-theme="archive"] .dsh-upd-banner{padding-right:16px}.dsh-upd[data-theme="archive"] .dsh-upd-banner::before{width:24px;height:24px;font-size:14px;line-height:20px;flex:none}.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child{white-space:normal}}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"]{--d5-bg:#141210;--d5-card:#1e1a15;--d5-ink:#ece5d3;--d5-muted:#a89c83;',
  '--d5-line:#3a3226;--d5-line-strong:#5c4e3b;--d5-accent:#e0684e;--d5-accent-deep:#f0866b;',
  '--d5-ok:#8fd6a4;--d5-ok-bg:rgba(80,180,120,.12);--d5-warn:#e8c15a;--d5-warn-bg:rgba(232,193,90,.12);',
  '--d5-bad:#ef8a7d;--d5-bad-bg:rgba(239,138,125,.12);--d5-shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px rgba(0,0,0,.45)}}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"] button[data-primary="1"]{color:#141210}.dsh-upd[data-theme="archive"] button:focus-visible{outline-color:var(--d5-accent-deep)}}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child::before{background-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2720%27 height=%2720%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23e8c15a%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z%27/%3E%3Cline x1=%2712%27 y1=%279%27 x2=%2712%27 y2=%2713%27/%3E%3Cline x1=%2712%27 y1=%2717%27 x2=%2712.01%27 y2=%2717%27/%3E%3C/svg%3E")}}',
  '@media (forced-colors: active){.dsh-upd[data-theme="archive"]{box-shadow:none}.dsh-upd[data-theme="archive"]::before{background:none;box-shadow:none;border-color:CanvasText;color:CanvasText}.dsh-upd[data-theme="archive"] .dsh-upd-banner{border:1px solid CanvasText}.dsh-upd[data-theme="archive"] .dsh-upd-banner::before{border-color:CanvasText;color:CanvasText;background:Canvas}.dsh-upd[data-theme="archive"] button{border:1px solid ButtonText}.dsh-upd[data-theme="archive"] button[data-primary="1"]{background:ButtonFace;color:ButtonText;border-color:ButtonText}.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child::before{background-image:none;content:"⚠"}}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd[data-theme="archive"] *{transition:none !important;animation:none !important}}',
].join('\n')

function escapeHtml(text: string): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export interface PanelRenderInput extends PanelViewInput {
  mode: UpdatePanelMode
  showOthers: boolean
  pluginId: string
  copyNotice: string | null
  /** 可选主题：不传即默认（输出与旧版一字不差）；`archive` 切档案卷（旧别名 `d5-paper` 仍收）。 */
  theme?: UpdatePanelTheme
  /** 使用范围名（profile）：面板「使用范围」一栏的唯一来源，缺省显示“未知”，不猜。 */
  profileName?: string | null
  /** 宿主种类：进诊断文本；缺省显示“未知”。 */
  hostKind?: string | null
  /**
   * 在途动作（仅挂载态内部用：点下查新版/安装到回包前的那一帧，按钮置忙）。
   * 缺省即静默（输出与旧版一字不差）；只在挂载器置忙的那次 render 里传。
   */
  busyAct?: 'check' | 'install' | null
  /** 失败引用（失败档案的查询键；缺省即无失败，不画卷宗）。 */
  failure?: PanelFailureRef | null
  /** 日志指引开关：false 即藏通用日志行（失败证据行不受影响）。 */
  showLogHint?: boolean
  /**
   * 动作面归谁：`default`（缺省）由内核画动作按钮；`none` 只画内容、不画按钮。
   * 给「调用方自己提供动作面」的场景（如批量面板的详情：动作由批量面板经自己的通道提供）。
   * 只读渲染下五章内容、进度条、「已跳过」提示一字不减，只是没有动作按钮。
   */
  actions?: 'default' | 'none'
}

/** 章节骨架（照原型 d5-paper.html:218-245 的 01–05 编号顺序）。 */
const CHAPTER_TITLES = ['检查与安装', '更新日志', '更新队列', '错误信息', '手工命令'] as const

/** 内核渲染用的失败引用（只读快照：证据仍在锁存里，这里只传展示键）。 */
export interface PanelFailureRef {
  requestId: string | null
  checkId: string | null
  atMs: number | null
  source: 'check' | 'install' | null
  volatile: boolean
}

/** 锁存时刻 → 本地 HH:MM:SS（失败档案“失败于”用；非法值回 null，不画时间）。 */
export function formatLatchTime(atMs: unknown): string | null {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs <= 0) return null
  try {
    const s = new Date(atMs).toLocaleTimeString('zh-CN', { hour12: false })
    return s ? s : null
  } catch {
    return null
  }
}

function chapterOf(index: 1 | 2 | 3 | 4 | 5, inner: string, note = ''): string {
  const no = String(index).padStart(2, '0')
  const title = CHAPTER_TITLES[index - 1]
  return (
    `<section class="dsh-upd-chapter" data-chapter="${no}">` +
    `<div class="dsh-upd-chap-head"><span class="dsh-upd-chap-no">${no}</span>` +
    `<h3 class="dsh-upd-chap-title">${escapeHtml(title)}</h3><span class="dsh-upd-chap-rule"></span>${note}</div>` +
    `${inner}</section>`
  )
}

/** 首帧骨架：快照没到之前占住版本条的位置，纯 CSS 微光（aria-hidden，不进语义）。 */
function skeletonStrip(loading: boolean): string {
  if (!loading) return ''
  const cell = (k: string): string =>
    `<div><span class="dsh-upd-strip-k">${escapeHtml(k)}</span>` +
    `<span class="dsh-upd-strip-v dsh-upd-skv" aria-hidden="true">…</span></div>`
  return `<div class="dsh-upd-strip" aria-hidden="true">` + cell('运行') + cell('磁盘') + cell('远端') + `</div>`
}

/** 版本条三格（照原型 :216 `.strip`：运行 / 磁盘 / 远端）。 */
function versionStrip(snapshot: UpdateSnapshot | null): string {
  const cell = (k: string, v: string | null): string =>
    `<div><span class="dsh-upd-strip-k">${escapeHtml(k)}</span><span class="dsh-upd-strip-v">${escapeHtml(v ?? '未知')}</span></div>`
  if (!snapshot) return ''
  return (
    `<div class="dsh-upd-strip">` +
    cell('运行', snapshot.runningVersion) +
    cell('磁盘', snapshot.installedVersion) +
    cell('远端', snapshot.latestVersion) +
    `</div>`
  )
}

/** 安装进度条（照原型 :221-222）：只在 installing / verifying 时出现，纯展示，不参与门控。 */
function progressBar(snapshot: UpdateSnapshot | null): string {
  const job = snapshot?.job
  if (!job) return ''
  const state = String(job.state)
  if (state !== 'installing' && state !== 'verifying') return ''
  const width = state === 'installing' ? 60 : 90
  const text = state === 'installing' ? '正在安装新版…' : '正在校验安装结果…'
  return (
    `<div class="dsh-upd-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width}">` +
    `<i class="dsh-upd-prog-bar" style="width:${width}%"></i></div>` +
    `<div class="dsh-upd-progtxt">${escapeHtml(text)}</div>`
  )
}

/** 内核 HTML（双形态行为等价的根：同一视图产出同一内核，只换外层）。 */
export function renderUpdatePanelKernel(input: PanelRenderInput, view: PanelView): string {
  const { snapshot, manual, queue, mode, showOthers, pluginId, copyNotice } = input
  const changelogMarkdown =
    (input as { changelogMarkdown?: unknown }).changelogMarkdown ?? null
  const profileName =
    typeof (input as { profileName?: unknown }).profileName === 'string' && (input as { profileName: string }).profileName
      ? (input as { profileName: string }).profileName
      : null
  const b = view.banner
  const seal = view.seal
  const parts: string[] = []
  // 卷宗抬头（原型 :195-203 的刊头；主题切换按钮按用户口径去掉——那排按钮不重要）。
  // 两个主题共用同一份内核 HTML：默认（最小）主题由 CSS 不显示，D5 档案卷才画。
  parts.push(
    '<div class="dsh-upd-masthead"><span class="dsh-upd-masthead-kicker">插件更新</span>' +
      '<span class="dsh-upd-masthead-title">更新档案 <i>卷</i></span></div>',
  )
  // 档案头（原型 :208-211 `.filehead`）：插件名 + 使用范围 + profile 牌。
  // 「使用范围」这一栏是更新落点的展示面：web / desktop 各装一份，装错范围是严重故障，
  // 所以这里宁可显示「未知」也不猜。
  parts.push(
    `<div class="dsh-upd-head"><span class="dsh-upd-name">${escapeHtml(pluginId)}</span>` +
      `<span class="dsh-upd-meta">使用范围 <b>${escapeHtml(profileName ?? '未知')}</b>` +
      `<span class="dsh-upd-proftag">profile</span></span></div>`,
  )
  // 横幅：状态行 / 待重启横幅（原型 :213-215 restartSlot + 状态行）。
  // 小印章一字挂在它上面；待重启档不挂印章——那一档的标记是手绘 SVG（原型 :446 只有 SVG）。
  parts.push(`<div class="dsh-upd-banner" data-kind="${b.kind}" data-mini="${escapeHtml(seal.mini)}" role="status" aria-live="polite">`)
  parts.push(`<div><strong>${escapeHtml(b.title)}</strong></div>`)
  if (b.action) parts.push(`<div>${escapeHtml(b.action)}</div>`)
  parts.push('</div>')
  // 版本条（原型 :216 `.strip`）：运行 / 磁盘 / 远端三格。
  // 首帧无快照：画骨架占位（纯 CSS 微光，不加语义节点；快照一到即换真格）。
  parts.push(snapshot ? versionStrip(snapshot) : skeletonStrip(view.banner.kind === 'loading'))
  // —— 01 检查与安装（原型 :218-224）：动作 + 进度条 + 跳过行 ——
  // 只读渲染（`actions: 'none'`）：调用方自己提供动作面时用（批量面板的详情就是这种）。
  // 五章内容、进度条、「已跳过」提示照画，唯独不画动作按钮——免得出现「可点却没人接」的死按钮。
  const showActions = input.actions !== 'none'
  const actions: string[] = []
  if (showActions) {
  const busyAct = (input as { busyAct?: unknown }).busyAct
  const checkBusy = busyAct === 'check'
  const installBusy = busyAct === 'install'
  actions.push('<div class="dsh-upd-actions">')
  // 在途那一帧：按钮禁用 + 文案切换 + aria-busy（静默时输出与旧版一字不差）。
  // title 是零成本原生 tooltip：不引入浮层组件，只给悬停一句话说明。
  actions.push(
    (checkBusy
      ? `<button type="button" data-action="check" disabled aria-busy="true" title="正在向官方源查询，请稍候">正在查新版…</button>`
      : `<button type="button" data-action="check" title="重新向官方源查一次新版（只读，不安装）">查新版</button>`) +
      (installBusy
        ? `<button type="button" data-action="install" data-primary="1" disabled aria-busy="true" title="正在安装，请稍候">正在安装…</button>`
        : `<button type="button" data-action="install" data-primary="1" title="用精确版本安装；同一使用范围同时只装一个"${view.installEnabled ? '' : ' disabled'}>${escapeHtml(view.installLabel)}</button>`),
  )
  if (snapshot?.latestVersion && !view.skippedLatest && view.banner.kind === 'update') {
    actions.push(`<button type="button" data-action="skip" title="该版本不再提醒；有更新的新版本照常提醒">跳过该版本</button>`)
  }
  if (view.showReset && snapshot?.latestVersion) {
    actions.push(`<button type="button" data-action="reset-skip" title="撤销跳过，该版本重新提醒">恢复（${escapeHtml(snapshot.latestVersion)}）</button>`)
  }
  if (view.showManual && manual) {
    actions.push(`<button type="button" data-action="copy-manual" title="复制手工命令，粘到终端整行执行">复制手工命令</button>`)
  }
  // 原型的待重启横幅右侧有个主动作「重启宿主」（d5-paper.html:448）。
  // 宿主没有「重启自己」的电话，所以这里只做入口：调用方给了 onRestartRequested 就交给它，
  // 没给就如实提示「请手动重启」——不假装能重启。
  if (b.kind === 'restart') {
    actions.push(`<button type="button" data-action="restart-hint" data-primary="1" title="宿主没有自重启电话：请手动重启宿主">重启宿主</button>`)
  }
  if (b.kind === 'failed') {
    actions.push(`<button type="button" data-action="dismiss-failure" title="确认已知晓该失败：回到可装页，下次查/装将重新评估">知道了</button>`)
  }
  if (snapshot) {
    actions.push(`<button type="button" data-action="copy-diag" title="复制已脱敏诊断，直接粘给插件作者">复制诊断</button>`)
  }
  // 关闭不住第一章（#47 定案 A）：dialog 的关闭住右下角独立 footer 区（见内核末尾）；
  // embedded 无面板自带关闭（宿主框架自带关），与 requestDialogClose 只认 dialog 同口径。
  actions.push('</div>')
  }
  actions.push(progressBar(snapshot))
  if (view.skippedLatest && snapshot?.latestVersion) {
    actions.push(
      `<div class="dsh-upd-skipline"><span class="dsh-upd-tag">已跳过 ${escapeHtml(snapshot.latestVersion)}</span>` +
        `点「恢复」可撤销，之后这一版还会再提醒。</div>`,
    )
  }
  parts.push(chapterOf(1, actions.join('')))
  // —— 02 更新日志（原型 :226-229）：章节恒在；缺日志给中性提示，不挡安装、不改门控 ——
  {
    let inner = ''
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
        let yankedBanner = ''
        try {
          const toEntry = Array.isArray(ranged) ? ranged.find(function(e) { try { return e && e.version === toText; } catch { return false; } }) : null
          if (toEntry && (toEntry as { yanked?: unknown }).yanked === true && toText) { yankedBanner = yankedBannerHTML(toText); }
        } catch { yankedBanner = ''; }
        inner = `<div class="dsh-upd-changelog-wrap"><div>${escapeHtml(rangeTitle)}</div>${yankedBanner}\n${changelogHTML}\n</div>`
      } catch {
        // 日志画坏了也不挡更新：退回中性提示，安装按钮状态不变。
        inner = ''
      }
    }
    if (!inner) {
      inner = `<div class="dsh-upd-changelog-wrap"><div class="dsh-upd-changelog-neutral">${escapeHtml(
        snapshot && snapshot.latestVersion ? '日志读不出来，安装不受影响。' : '还没查到新版；查到后再显示日志。',
      )}</div></div>`
    }
    parts.push(chapterOf(2, inner))
  }
  // —— 03 更新队列（原型 :231-235）：章节恒在（没排队也给一句话，编号不许跳）——
  // 设计定案（2026-10-04，见 03 章设计稿）：正文改成两行键值（正在安装 / 你的顺位），
  // 开关仍是**按钮**（不是原型的复选框），位置照原型挪到章节标题行右端。
  {
    const queued = !!queue && (queue.busy || queue.waiting.length > 0)
    if (queued && queue) {
      const busy = queue.busy
      const ownerRaw = queue.owner
      // 他人标识只在 showOthers 打开时才露：宿主默认已折过一道，这里再守一道
      // （调用方直接塞原始队列时，面板也不许把人家的插件名印出来）。
      const named =
        ownerRaw && 'pluginId' in ownerRaw && ownerRaw.pluginId ? String(ownerRaw.pluginId) : null
      const version =
        ownerRaw && 'targetVersion' in ownerRaw && ownerRaw.targetVersion
          ? `@${String(ownerRaw.targetVersion)}`
          : ''
      const aboutSelf = named !== null && named === pluginId
      const reveal = showOthers === true
      const ownerShown = !busy
        ? '空闲'
        : named === null
          ? '其他插件'
          : aboutSelf
            ? '本插件'
            : reveal
              ? named
              : '其他插件'
      const ownerVer = busy && named !== null && (aboutSelf || reveal) ? version : ''
      const pos = typeof queue.position === 'number' ? queue.position : null
      const posText = pos === null ? '未排队' : `第 ${pos} 位`
      const posNote = pos === null ? '' : pos === 1 ? '下一个就是你' : `前方 ${pos - 1} 个`
      const rows = [
        '<div class="dsh-upd-qrow">' +
          `<span class="dsh-upd-qdot" data-tone="${busy ? 'busy' : 'idle'}"></span>` +
          '<span class="dsh-upd-qk">正在安装</span>' +
          `<span class="dsh-upd-qv">${escapeHtml(ownerShown + ownerVer)}</span>` +
          `<span class="dsh-upd-qn">${busy ? '装完自动轮到你' : '同一使用范围一次只装一个'}</span></div>`,
        '<div class="dsh-upd-qrow">' +
          '<span class="dsh-upd-qdot" data-tone="you"></span>' +
          '<span class="dsh-upd-qk">你的顺位</span>' +
          `<span class="dsh-upd-qv">${escapeHtml(posText)}</span>` +
          `<span class="dsh-upd-qn">${escapeHtml(posNote)}</span></div>`,
      ]
      // 开关打开要有东西可看：给一条排队顺序（否则「显示其他插件」点了跟没点一样）。
      if (reveal && queue.waiting.length > 0) {
        const seq = queue.waiting
          .map((e) => `${e.pluginId}${e.targetVersion ? `@${e.targetVersion}` : ''}`)
          .join(' → ')
        rows.push(
          '<div class="dsh-upd-qrow"><span class="dsh-upd-qdot"></span>' +
            '<span class="dsh-upd-qk">排队顺序</span>' +
            `<span class="dsh-upd-qseq">${escapeHtml(seq)}</span></div>`,
        )
      }
      // 队列开关也是动作面：只读渲染（actions:'none'）下同样不画——
      // 否则「内核不画按钮」这条缝会漏掉 03 章这一颗（现场实测：忙队列时它照样渲染，成了新的死按钮）。
      // 只读渲染下队列内容照画，看不看他人明细由调用方传的 showOthers 决定。
      const note = showActions
        ? '<span class="dsh-upd-chap-note"><button type="button" data-action="toggle-queue">' +
          `${reveal ? '隐藏他人明细' : '显示其他插件'}</button></span>`
        : ''
      parts.push(chapterOf(3, `<div class="dsh-upd-queue">${rows.join('')}</div>`, note))
    } else {
      parts.push(
        chapterOf(
          3,
          `<div class="dsh-upd-queue"><div class="dsh-upd-changelog-neutral">${escapeHtml(
            view.queueNote ?? '当前没有排队任务，同一使用范围一次只装一个。',
          )}</div></div>`,
        ),
      )
    }
  }
  // —— 04 错误信息（原型 :237-240）：平时是路牌，失败时是带冻结证据与现成查询的卷宗 ——
  {
    const errLines: string[] = []
    const failedNow = b.kind === 'failed' || b.kind === 'blocked'
    const failRef = (input as { failure?: unknown }).failure as PanelFailureRef | null | undefined
    if (failedNow) {
      const shownCode =
        b.kind === 'blocked'
          ? (snapshot?.blockedReason ?? b.kind)
          : typeof (input as { lastError?: unknown }).lastError === 'string' && ((input as { lastError: string }).lastError).trim()
            ? (input as { lastError: string }).lastError
            : 'install-failed'
      errLines.push(
        `<div class="dsh-upd-err">稳定码 <code>${escapeHtml(String(shownCode))}</code>` +
          `：上一条中文说明就是要用户做的事；要往上游报，用「复制诊断」整段粘（已脱敏）。</div>`,
      )
      if (b.kind === 'failed' && failRef) {
        const keys: string[] = []
        if (typeof failRef.requestId === 'string' && failRef.requestId) keys.push(`请求 <code>${escapeHtml(failRef.requestId)}</code>`)
        if (typeof failRef.checkId === 'string' && failRef.checkId) keys.push(`检查 <code>${escapeHtml(failRef.checkId)}</code>`)
        const at = formatLatchTime(failRef.atMs)
        if (at) keys.push(`失败于 ${escapeHtml(at)}`)
        if (keys.length > 0) {
          errLines.push(`<div class="dsh-upd-err">本次查询键：${keys.join(' · ')}（拿着它们去日志里对）。</div>`)
        }
        if (!failRef.volatile) {
          errLines.push(
            `<div class="dsh-upd-err">证据已冻结：复制诊断里的码、版本、编号都取自失败时刻，不随轮询刷新；下一次查新版或安装会更新它。</div>`,
          )
        } else {
          errLines.push(
            `<div class="dsh-upd-err">读数瞬态失败：下一次成功读数会自动解除；一直出现再按稳定码排查。</div>`,
          )
        }
      }
    } else {
      errLines.push(`<div class="dsh-upd-changelog-neutral">暂无失败：此时复制诊断给出的是当前状态快照。</div>`)
    }
    if ((input as { showLogHint?: unknown }).showLogHint !== false) {
      errLines.push(
        `<div class="dsh-upd-log">深挖看日志：按插件标识 <code>${escapeHtml(pluginId)}</code> 过滤 ` +
          `<code>${LOG_EVENT_CALL}</code>、<code>${LOG_EVENT_CALL_FAIL}</code>、<code>${LOG_EVENT_INSTALL_EXEC}</code> 三个事件。</div>`,
      )
      if (b.kind === 'failed' && failRef && (failRef.requestId || failRef.checkId)) {
        errLines.push(
          `<div class="dsh-upd-log">凭上面的请求／检查编号在 <code>${LOG_EVENT_CALL_FAIL}</code> 里对上；基线耗时看 ` +
            `<code>${LOG_EVENT_CALL}</code>，执行结果看 <code>${LOG_EVENT_INSTALL_EXEC}</code>。</div>`,
        )
      }
    }
    if (copyNotice) errLines.push(`<div class="dsh-upd-copy" role="status">${escapeHtml(copyNotice)}</div>`)
    parts.push(chapterOf(4, errLines.join('')))
  }
  // —— 05 手工命令（原型 :242-245）：章节恒在；没有可给的手工命令就说清为什么 ——
  parts.push(
    chapterOf(
      5,
      view.showManual && manual
        ? `<div class="dsh-upd-manual"><div>手工兜底命令（复制整行执行）：</div><code>${escapeHtml(manual)}</code></div>`
        : `<div class="dsh-upd-manual"><div class="dsh-upd-changelog-neutral">当前没有可用的手工命令（认不出使用范围或属源码安装时不给）。</div></div>`,
    ),
  )
  // —— 右下角独立 footer 区（#47 定案 A：一次找到，脱离第一章 actions）——
  // dialog 才有，永远在 05 章之后；embedded 无（宿主框架自带关）；
  // 只读渲染（actions:'none'）下不画（动作面归调用方，免得出现可点却没人接的死按钮）。
  if (showActions && mode === 'dialog') {
    parts.push(
      '<div class="dsh-upd-footer"><span class="dsh-upd-foot-note">关闭不影响更新，可随时回来查看</span>' +
        `<button type="button" data-action="close-view" title="关闭窗口，更新不受影响">关闭</button></div>`,
    )
  }
  return parts.join('\n')
}

/** 整面板 HTML（含样式；重绘即整体替换 innerHTML，故每次都带 style 也只留一份）。 */
export function renderUpdatePanelHTML(input: PanelRenderInput): string {
  const view = panelViewModel(input)
  const kernel = renderUpdatePanelKernel(input, view)
  // 主题只换肤：默认主题输出与旧版一字不差（无 data-theme、不带 D5 串）；
  // 档案卷（archive / 旧别名 d5-paper）才在根上挂 data-theme 并追加 D5 串；内核 HTML 两边同一份。
  const d5 = normalizePanelTheme(input.theme) === 'archive'
  const attr = d5 ? ' data-theme="archive"' : ''
  // 印章走属性带到根上：D5 用 CSS `content:attr(...)` 画成大印章，默认主题只当属性带着不画，
  // 两个主题的 DOM 仍逐字同一份（主题只换肤这条不变量不破）。
  const sealAttr = ` data-seal="${escapeHtml(view.seal.text)}" data-seal-tone="${view.seal.tone}"`
  const body =
    input.mode === 'dialog'
      ? `<div class="dsh-upd-overlay" data-mode="dialog"><div class="dsh-upd" data-mode="dialog" data-plugin="${escapeHtml(input.pluginId)}"${sealAttr}${attr}>\n${kernel}\n</div></div>`
      : `<div class="dsh-upd" data-mode="embedded" data-plugin="${escapeHtml(input.pluginId)}"${sealAttr}${attr}>\n${kernel}\n</div>`
  const css = d5 ? `${UPDATE_PANEL_CSS}\n${UPDATE_PANEL_D5_CSS}` : UPDATE_PANEL_CSS
  return `<style>${css}</style>\n${body}`
}

// ---------- 失败锁存（#58：安装/查失败常驻，复制诊断锁定致命回包） ----------
//
// 只读轮询（updateStatus）与用户主动动作（查/装）在失败证据上分权：
// - 用户动作的失败回包冻结成锁存；成功的状态轮询永不清除非瞬态锁存。
// - 瞬态（传输抛错）锁存记 volatile，下一次成功读数即清，不留死结。
// - update-busy 永不进锁存（排队态走队列视图实时渲染）。
// - 跨重挂按“插件 + 使用范围”在模块级存活（宿主进程内），进程重启即忘。
interface FailureLatch {
  code: string
  kind: string | null
  detail: string | null
  diag: unknown
  requestId: string | null
  checkId: string | null
  runningVersion: string | null
  installedVersion: string | null
  latestVersion: string | null
  hostKind: string | null
  profileName: string | null
  source: 'check' | 'install'
  volatile: boolean
  jobId: string | null
  atMs: number | null
}

const PANEL_FAILURE_LATCHES = new Map<string, FailureLatch>()

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
 * mount 自动查抑制谓词（#48：#46 结论固化，纯函数）：
 * 仅当快照任务态为 installing/verifying，或已有查/装在途动作时不发起；
 * 同范围忙、凭证过期、各类阻拦一律不抑制（前两者正是要刷新/重建凭证时）。
 * 无活体快照（null）也不发起：首个只读刷新没拿到快照时不猜。
 */
export function pendingAutoCheck(
  snapshot: UpdateSnapshot | null,
  busyAct: 'check' | 'install' | null,
): boolean {
  if (busyAct === 'check' || busyAct === 'install') return false
  if (!snapshot) return false
  const st = (snapshot as UpdateSnapshot | null)?.job?.state
  if (st === 'installing' || st === 'verifying') return false
  return true
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
  const changelogPhone = buildChangelogPhoneName(prefix)
  // 自动日志（#38）：默认开；显式传过 changelogMarkdown 或显式关即退回手动。
  const autoChangelogEnabled = typeof options.changelogMarkdown !== 'string' && options.autoChangelog !== false
  let manualChangelogOverride = typeof options.changelogMarkdown === 'string'
  // 按版本记住结果（#41 终裁）：成功与取不到按版本永久记（面板内存会话级，不落盘，显式文本永不覆盖）；
  // 传输失败不进缓存，手动查新版/换版/重开立即重问，轮询按退避问（三处共用 shouldFetchChangelog，各存各的）。
  const changelogCache = new Map<string, string | null>()
  const changelogInflight = new Set<string>()
  // 失败退避时间戳（版本 -> 失败时刻毫秒）：轮询按退避问，手动/换版/重开立即忘，下次照常问。
  const changelogFailedAt = new Map<string, number>()
  let autoSeq = 0
  const pollMs =
    options.pollMs === undefined ? DEFAULT_PANEL_POLL_MS : options.pollMs
  if (typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs < MIN_PANEL_POLL_MS) {
    throw new Error(`[dsh-plugin-update] 面板轮询间隔非法：不得小于 250 毫秒（收到 ${JSON.stringify(options.pollMs)}）`)
  }
  let mode: UpdatePanelMode = options.mode ?? 'embedded'
  if (mode !== 'embedded' && mode !== 'dialog') {
    throw new Error(`[dsh-plugin-update] 摆放形态非法：只收 embedded 或 dialog（收到 ${JSON.stringify(options.mode)}）`)
  }
  if (options.theme !== undefined && options.theme !== 'default' && options.theme !== 'archive' && options.theme !== 'd5-paper') {
    throw new Error(`[dsh-plugin-update] 主题非法：只收 default 或 archive（d5-paper 为旧别名仍可用）（收到 ${JSON.stringify(options.theme)}）`)
  }
  let theme: UpdatePanelTheme = normalizePanelTheme(options.theme ?? 'default')
  let showOthers = options.showOthers === true
  const call = options.call
  const onRestartRequested = options.onRestartRequested
  const onCloseRequested = typeof options.onCloseRequested === 'function' ? options.onCloseRequested : null
  // 上次落盘的 HTML：逐字相同即跳过赋值（闪烁根治的比较基线）。
  let lastHTML = ''
  const copyText = options.copyText ?? defaultCopyText
  const skipStore = options.skipStore ?? createBrowserSkipStore(pluginId)
  const hostKind = typeof options.hostKind === 'string' && options.hostKind ? options.hostKind : null
  // 使用范围（profile）：宿主经 includeEnv 回真值，调用方也能显式覆盖。
  // 这一栏是「更新装到哪个范围」的唯一展示面——web / desktop 各装一份，必须让人看见自己点的是哪个。
  const profileNameOption = typeof options.profileName === 'string' && options.profileName ? options.profileName : null
  const showLogHintOption = options.showLogHint !== false
  const diagCopyFormat: DiagCopyFormat = options.diagCopyFormat === 'line' ? 'line' : 'block'
  let changelogMarkdown: string | null =
    typeof options.changelogMarkdown === 'string' ? options.changelogMarkdown : null

  let snapshot: UpdateSnapshot | null = null
  let manual: string | null = null
  let queue: VisibleQueue | null = null
  let receipt: { checkId: string } | null = null
  let requestId: string | null = null
  // 失败锁存（#58）：用户主动动作的失败证据在此冻结；只读轮询无权清除非瞬态锁存。
  const latchKey = `${pluginId}${profileNameOption ?? ''}`
  let latch: FailureLatch | null = null
  try {
    latch = PANEL_FAILURE_LATCHES.get(latchKey) ?? null
    // 瞬态不跨重挂：读数传输失败是上一挂载的事，重开即重新读数
    if (latch?.volatile) latch = null
  } catch {
    latch = null
  }
  function saveLatch(): void {
    try {
      // 瞬态只活在本挂载：不进跨挂载表；表有界（100 家），老的自然淘汰
      if (latch && !latch.volatile) {
        if (!PANEL_FAILURE_LATCHES.has(latchKey) && PANEL_FAILURE_LATCHES.size >= 100) {
          const oldest = PANEL_FAILURE_LATCHES.keys().next()
          if (!oldest.done) PANEL_FAILURE_LATCHES.delete(oldest.value)
        }
        PANEL_FAILURE_LATCHES.set(latchKey, latch)
      } else PANEL_FAILURE_LATCHES.delete(latchKey)
    } catch {
      // 锁存落盘失败不挡更新
    }
  }
  function latchNow(): number | null {
    try {
      const n = Date.now()
      return Number.isFinite(n) ? n : null
    } catch {
      return null
    }
  }
  function setLatch(next: FailureLatch): void {
    latch = next
    saveLatch()
  }
  function clearLatch(): void {
    if (!latch) return
    latch = null
    saveLatch()
  }
  function currentEnvPair(): { hostKind: string | null; profileName: string | null } {
    return { hostKind: hostKind ?? envHostKind, profileName: profileNameOption ?? envProfileName }
  }
  function latchFromReply(reply: Record<string, unknown>, source: 'check' | 'install'): FailureLatch {
    const env = currentEnvPair()
    return {
      code: failureCodeOf(
        { error: reply['error'], errorKind: reply['errorKind'] },
        source === 'install' ? 'install-failed' : 'check-failed',
      ),
      kind:
        typeof reply['errorKind'] === 'string' && (reply['errorKind'] as string).trim()
          ? (reply['errorKind'] as string).trim()
          : null,
      detail: null,
      diag: Object.prototype.hasOwnProperty.call(reply, 'diag') ? (reply as Record<string, unknown>)['diag'] : null,
      requestId: source === 'install' ? requestId : null,
      checkId: source === 'install' ? (receipt?.checkId ?? null) : null,
      runningVersion: snapshot?.runningVersion ?? null,
      installedVersion: snapshot?.installedVersion ?? null,
      latestVersion: snapshot?.latestVersion ?? null,
      hostKind: env.hostKind,
      profileName: env.profileName,
      source,
      volatile: false,
      jobId: null,
      atMs: latchNow(),
    }
  }
  function latchFromJob(job: NonNullable<UpdateSnapshot['job']>, snap: UpdateSnapshot | null): FailureLatch {
    const env = currentEnvPair()
    const message = typeof job.message === 'string' ? job.message : null
    const detail = message && message.includes(':') ? message.slice(message.indexOf(':') + 1).trim() || null : message
    return {
      code: messageCodeOf(message) || 'install-failed',
      kind: null,
      detail,
      // 快照里没有 diag：保留锁存里既有的（多半是致命安装回包自带的），没有即缺省说人话
      diag: latch?.diag ?? null,
      requestId: job.requestId ?? latch?.requestId ?? requestId,
      checkId: receipt?.checkId ?? latch?.checkId ?? null,
      runningVersion: snap?.runningVersion ?? snapshot?.runningVersion ?? null,
      installedVersion: snap?.installedVersion ?? snapshot?.installedVersion ?? null,
      latestVersion: snap?.latestVersion ?? snapshot?.latestVersion ?? null,
      hostKind: env.hostKind ?? latch?.hostKind ?? null,
      profileName: env.profileName ?? latch?.profileName ?? null,
      source: 'install',
      volatile: false,
      jobId: typeof job.id === 'string' ? job.id : null,
      atMs: latchNow(),
    }
  }
  function volatileLatch(source: 'check' | 'install'): FailureLatch {
    const env = currentEnvPair()
    return {
      code: 'check-failed',
      kind: null,
      detail: null,
      diag: null,
      requestId,
      checkId: receipt?.checkId ?? null,
      runningVersion: snapshot?.runningVersion ?? null,
      installedVersion: snapshot?.installedVersion ?? null,
      latestVersion: snapshot?.latestVersion ?? null,
      hostKind: env.hostKind,
      profileName: env.profileName,
      source,
      volatile: true,
      jobId: null,
      atMs: latchNow(),
    }
  }
  function backfillLatch(s: UpdateSnapshot): void {
    if (!latch) return
    let touched = false
    if (latch.runningVersion === null && s.runningVersion) {
      latch.runningVersion = s.runningVersion
      touched = true
    }
    if (latch.installedVersion === null && s.installedVersion) {
      latch.installedVersion = s.installedVersion
      touched = true
    }
    if (latch.latestVersion === null && s.latestVersion) {
      latch.latestVersion = s.latestVersion
      touched = true
    }
    if (touched) saveLatch()
  }
  function tripleChanged(s: UpdateSnapshot): boolean {
    if (!latch) return false
    backfillLatch(s)
    const pairs: [string | null, string | null][] = [
      [latch.runningVersion, s.runningVersion ?? null],
      [latch.installedVersion, s.installedVersion ?? null],
      [latch.latestVersion, s.latestVersion ?? null],
    ]
    return pairs.some(([a, b]) => a !== null && b !== null && a !== b)
  }
  let copyNotice: string | null = null
  let noticeExpiresAt = 0
  // 在途动作（#36）：点下查新版/安装到回包前的那一帧，按钮置忙 + 并发连点只认第一次。
  let busyAct: 'check' | 'install' | null = null
  let mounted = true
  // 宿主 includeEnv 回的使用范围与宿主种类（调用方显式传的优先，见 render）。
  let envProfileName: string | null = null
  let envHostKind: string | null = null

  /** 记一条 transient 回执：5 秒后过期（toast 语义），下次点击不清它、时间到才清。 */
  function sayCopy(text: string): void {
    copyNotice = text
    try {
      noticeExpiresAt = Date.now() + 5000
    } catch {
      noticeExpiresAt = 0
    }
  }

  function queueArgs(): Record<string, unknown> {
    // includeEnv：要宿主把「装到哪个使用范围」一并回给我们（老调用不带，回包形状不变）。
    return { includeQueue: true, includeEnv: true, showOthers, ...(requestId ? { requestId } : {}) }
  }

  function render(): void {
    if (!mounted) return
    // Toast 过期（#37）：transient 提示只活 5 秒；戳在赋值点打（sayCopy），轮询重绘不续命。
    // busy 在途提示由 finally 清，这里只管过期。
    if (!copyNotice) noticeExpiresAt = 0
    else if (noticeExpiresAt && Date.now() > noticeExpiresAt) {
      copyNotice = null
      noticeExpiresAt = 0
    }
    const latest = snapshot?.latestVersion ?? null
    const skippedLatest = !!latest && validReleaseVersion(latest) && skipStore.has(latest)
    // 渲染只在变化时落盘（闪烁根治）：轮询每秒重算，但输出逐字相同时不碰 DOM，
    // 悬停/focus 状态不再被整树替换打断；状态变化仍即时重绘。
    const nextHTML = renderUpdatePanelHTML({
      snapshot,
      manual,
      queue,
      busyAct,
      skippedLatest,
      lastError: latch?.code ?? null,
      errorKind: latch?.kind ?? null,
      failure: latch
        ? { requestId: latch.requestId, checkId: latch.checkId, atMs: latch.atMs, source: latch.source, volatile: latch.volatile }
        : null,
      showLogHint: showLogHintOption,
      changelogMarkdown,
      mode,
      showOthers,
      pluginId,
      copyNotice,
      theme,
      // 使用范围与宿主种类：调用方显式传的优先，否则用宿主回的真值。
      profileName: profileNameOption ?? envProfileName,
      hostKind: hostKind ?? envHostKind,
    })
    if (nextHTML !== lastHTML) {
      lastHTML = nextHTML
      container.innerHTML = nextHTML
    }
  }

  function applyStatusReply(reply: Record<string, unknown>, via: 'refresh' | 'check' | 'install'): void {
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
      const env = reply['env']
      if (isObject(env)) {
        const pn = env['profileName']
        const hk = env['environmentKind']
        if (typeof pn === 'string' && pn.trim()) envProfileName = pn.trim()
        if (typeof hk === 'string' && hk.trim()) envHostKind = hk.trim()
      }
      // 成功回包的锁存规则（#58）：只读轮询永不清除非瞬态锁存；diag 不覆写既有证据。
      const jobState = snapshot?.job?.state ?? null
      if (jobState === 'installing' || jobState === 'verifying') {
        // 新一轮在途：旧失败让位
        clearLatch()
      } else if (jobState === 'completed' || jobState === 'restart-required') {
        // 成功终态：旧失败已无意义
        clearLatch()
      } else if ((jobState === 'failed' || jobState === 'interrupted') && snapshot?.job) {
        // 后台结局到达：单调置入（只允许从无到有或同源更新，永不由轮询清除）
        setLatch(latchFromJob(snapshot.job, snapshot))
      } else if (via === 'install') {
        // 安装调用成功且无任务态：新一轮已被接受，旧失败让位
        clearLatch()
      } else if (snapshot && tripleChanged(snapshot)) {
        // 版本三元组变化：旧失败的上下文已被新信息替代
        clearLatch()
      } else if (via === 'check' && latch?.source === 'check') {
        // 用户主动查成功：查失败解除；装失败保留（查成功不证明装会成功）
        clearLatch()
      } else if (latch?.volatile) {
        // 瞬态读失败被一次成功读数治愈（用户查与轮询同权）
        clearLatch()
      }
    } else {
      const errText = typeof reply['error'] === 'string' ? reply['error'].trim() : ''
      const kindText = typeof reply['errorKind'] === 'string' ? reply['errorKind'].trim() : ''
      if ((kindText || errText) === 'update-busy') {
        // 忙是瞬态排队态：不锁存、不清除（位置走队列视图实时渲染）
      } else {
        setLatch(latchFromReply(reply, via === 'install' ? 'install' : 'check'))
      }
      // #45：失败也收使用范围与队列（快照/凭证不动；best-effort，形状不对即忽略）。
      try {
        const env = (reply as Record<string, unknown>)['env']
        if (isObject(env)) {
          const pn = env['profileName']
          const hk = env['environmentKind']
          if (typeof pn === 'string' && pn.trim()) envProfileName = pn.trim()
          if (typeof hk === 'string' && hk.trim()) envHostKind = hk.trim()
        }
      } catch {
        // 忽略：失败回包的环境栏是选填。
      }
      try {
        const q = asQueue((reply as Record<string, unknown>)['queue'])
        if (q) queue = q
      } catch {
        // 忽略：失败回包的队列视图是选填。
      }
    }
  }

  /** 自动取日志的触发条件（#41 终裁）：仅有新版可装、未跳过该版时按退避问一次。 */
  function pendingAutoChangelogVersion(): string | null {
    if (!autoChangelogEnabled || manualChangelogOverride || !mounted) return null
    const v = snapshot?.latestVersion ?? null
    if (typeof v !== 'string' || !validReleaseVersion(v)) return null
    if (!snapshot || snapshot.canInstall !== true) return null
    try {
      if (skipStore.has(v)) return null
    } catch {
      // 跳过存储读不到即当没跳过，不挡日志。
    }
    if (changelogInflight.has(v)) return null
    const hasCache = changelogCache.has(v)
    const failedAt = changelogFailedAt.has(v) ? (changelogFailedAt.get(v) as number) : null
    let nowMs = 0
    try { nowMs = Date.now(); } catch { nowMs = 0; }
    if (!shouldFetchChangelog({ hasCache: hasCache, failedAt: failedAt, now: nowMs, isManual: false })) return null
    return v
  }

  /** 有新版即按 latestVersion 调一次宿主电话，回来经内部通道换日志节；过期回包直接丢。 */
  function maybeAutoChangelog(): void {
    const v = pendingAutoChangelogVersion()
    if (v === null) return
    changelogInflight.add(v)
    const seq = autoSeq
    void Promise.resolve()
      .then(() => call(changelogPhone, { version: v }))
      .then(
        (reply) => {
          changelogInflight.delete(v)
          if (!mounted || seq !== autoSeq) return
          if (!reply || typeof reply !== 'object' || (reply as Record<string, unknown>)['ok'] !== true) {
            try { changelogFailedAt.set(v, Date.now()); } catch { try { changelogFailedAt.set(v, 0); } catch {} }
            return
          }
          const md = (reply as Record<string, unknown>)['markdown']
          changelogCache.set(v, typeof md === 'string' ? md : null)
          if (typeof md === 'string') {
            changelogMarkdown = md
            render()
          }
        },
        () => {
          changelogInflight.delete(v)
          if (mounted && seq === autoSeq) { try { changelogFailedAt.set(v, Date.now()); } catch { try { changelogFailedAt.set(v, 0); } catch {} } }
        },
      )
  }

  async function refresh(): Promise<void> {
    if (!mounted) return
    try {
      const reply = await call(phoneNames.updateStatus, queueArgs())
      if (!mounted) return
      applyStatusReply(reply, 'refresh')
    } catch {
      if (!mounted) return
      // 读数传输失败是瞬态：记 volatile 锁存，下一次成功读数即清，不留死结
      setLatch(volatileLatch('check'))
    }
    render()
    maybeAutoChangelog()
  }

  async function act(kind: UpdatePanelActionKind, arg?: string): Promise<void> {
    if (!mounted) return
    copyNotice = null
    switch (kind) {
      case 'check': {
        if (busyAct) return
        busyAct = 'check'
        copyNotice = '正在查新版…'
        render()
        try {
          const reply = await call(phoneNames.updateCheck, queueArgs())
          if (!mounted) return
          applyStatusReply(reply, 'check')
          // 手动查新版是明确意图：清掉失败退避，下面的自动链路可再问一次。
          changelogFailedAt.clear()
        } catch {
          if (!mounted) return
          setLatch(volatileLatch('check'))
        } finally {
          busyAct = null
          if (copyNotice === '正在查新版…') copyNotice = null
        }
        render()
        maybeAutoChangelog()
        return
      }
      case 'install': {
        if (busyAct) return
        busyAct = 'install'
        copyNotice = '正在安装…'
        render()
        try {
          if (!receipt) {
            const checked = await call(phoneNames.updateCheck, queueArgs())
            if (!mounted) return
            applyStatusReply(checked, 'check')
          }
          if (!mounted) return
          if (!receipt) {
            const expiredEnv = currentEnvPair()
            setLatch({
              code: 'check-expired',
              kind: 'check-expired',
              detail: null,
              diag: null,
              requestId,
              checkId: null,
              runningVersion: snapshot?.runningVersion ?? null,
              installedVersion: snapshot?.installedVersion ?? null,
              latestVersion: snapshot?.latestVersion ?? null,
              hostKind: expiredEnv.hostKind,
              profileName: expiredEnv.profileName,
              source: 'install',
              volatile: false,
              jobId: null,
              atMs: latchNow(),
            })
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
          applyStatusReply(reply, 'install')
        } catch {
          if (!mounted) return
          setLatch(volatileLatch('install'))
        } finally {
          busyAct = null
          if (copyNotice === '正在安装…') copyNotice = null
        }
        render()
        maybeAutoChangelog()
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
            sayCopy('手工命令已复制，粘到终端整行执行即可。')
          } catch {
            sayCopy('复制失败，请手动选中上面的命令。')
          }
        }
        render()
        return
      }
      case 'copy-diag': {
        const jobCode = snapshot?.job?.state === 'failed' ? messageCodeOf(snapshot.job.message) || 'install-failed' : ''
        // 健康态诚实复制（#58）：没有失败就不伪造失败码，只给当前状态快照。
        if (!latch && !jobCode && !snapshot?.blockedReason && snapshot) {
          const stateLine =
            snapshot.canInstall && snapshot.latestVersion
              ? `有新版 ${snapshot.latestVersion} 可装（当前 ${snapshot.runningVersion}）`
              : '已是最新，无需更新。'
          const queueName = queueTextOf(queue?.position ?? null)
          const envBits = [
            `插件=${pluginId}`,
            `宿主=${hostKind ?? envHostKind ?? '未知'}`,
            `使用范围=${profileNameOption ?? envProfileName ?? '未知'}`,
            `队列=${queueName}`,
          ]
          if (requestId) envBits.push(`请求=${requestId}`)
          if (receipt?.checkId) envBits.push(`检查=${receipt.checkId}`)
          const segs = [
            `[update-diag] 当前无失败：${stateLine}`,
            `版本：运行 ${snapshot.runningVersion}／磁盘 ${snapshot.installedVersion ?? '未知'}／远端 ${snapshot.latestVersion ?? '未查过'}`,
            `来源：${envBits.join(' · ')}`,
          ].map((s) => redactForCopy(s))
          const text = diagCopyFormat === 'line' ? segs.join(' · ') : segs.join('\n')
          try {
            await copyText(text)
            sayCopy('已复制当前状态（无失败），直接粘给插件作者即可（已脱敏）。')
          } catch {
            sayCopy('复制失败，请手动选中上面的信息。')
          }
          render()
          return
        }
        // #58：锁存存在即锁定致命回包的 frozen 证据；只有无锁存才走旧的实时回退链。
        const frozen = latch
        const code = frozen?.code ?? failureCodeOf({ error: null, errorKind: null }, jobCode || snapshot?.blockedReason || 'check-failed')
        const detail =
          frozen?.detail ??
          (snapshot?.job?.message && snapshot.job.message.includes(':')
            ? snapshot.job.message.slice(snapshot.job.message.indexOf(':') + 1)
            : snapshot?.job?.message)
        const text = buildUpdateDiagCopy({
          pluginId,
          code,
          detail,
          runningVersion: frozen?.runningVersion ?? snapshot?.runningVersion ?? null,
          installedVersion: frozen?.installedVersion ?? snapshot?.installedVersion ?? null,
          latestVersion: frozen?.latestVersion ?? snapshot?.latestVersion ?? null,
          hostKind: frozen?.hostKind ?? hostKind ?? envHostKind,
          profileName: frozen?.profileName ?? profileNameOption ?? envProfileName,
          queuePosition: queue?.position ?? null,
          requestId: frozen?.requestId ?? requestId,
          checkId: frozen?.checkId ?? receipt?.checkId ?? null,
          route: null,
          diag: frozen?.diag ?? null,
          manual,
          format: diagCopyFormat,
        })
        try {
          await copyText(text)
          sayCopy('诊断已复制，直接粘给插件作者即可（已脱敏）。')
        } catch {
          sayCopy('复制失败，请手动选中上面的信息。')
        }
        render()
        return
      }
      case 'dismiss-failure': {
        // 显式确认（#58）：只清面板锁存，不调电话、不写跳过；下次查/装将重新评估。
        clearLatch()
        sayCopy('已确认该失败提示；下次查新版或安装将重新评估。')
        render()
        return
      }
      case 'toggle-queue': {
        showOthers = !showOthers
        await refresh()
        return
      }
      // 「重启宿主」：宿主没有重启自己的电话，所以只做入口——
      // 调用方给了 onRestartRequested 就交给它；没给就如实说“请手动重启”，不假装。
      case 'restart-hint': {
        try {
          if (typeof onRestartRequested === 'function') {
            await onRestartRequested()
            sayCopy('已按调用方的重启流程处理；重启后新版生效。')
          } else {
            sayCopy('本宿主未提供重启入口：请手动重启宿主，重启后新版生效。')
          }
        } catch {
          sayCopy('重启入口调用失败：请手动重启宿主，重启后新版生效。')
        }
        render()
        return
      }
      case 'close-view': {
        await requestDialogClose()
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
    if (next !== 'default' && next !== 'archive' && next !== 'd5-paper') {
      throw new Error(`[dsh-plugin-update] 主题非法：只收 default 或 archive（d5-paper 为旧别名仍可用）（收到 ${JSON.stringify(next)}）`)
    }
    theme = normalizePanelTheme(next)
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

  /** 弹窗关闭：dialog 下点「关闭」/按 Esc 走这里；有落地回调先交调用方撤 DOM，再停轮询。 */
  async function requestDialogClose(): Promise<void> {
    if (!mounted || mode !== 'dialog') return
    if (onCloseRequested) {
      try {
        await onCloseRequested()
      } catch {
        // 调用方撤 DOM 失败也不挡停轮询。
      }
    }
    unmount()
  }

  function onKeyDown(ev: unknown): void {
    // Esc 关弹窗：焦点在面板内时按键冒泡到容器；与「关闭」按钮同口径（可配落地，不动宿主）。
    try {
      const e = ev as { key?: unknown } | null | undefined
      if (!mounted || mode !== 'dialog' || !e || e.key !== 'Escape') return
      void requestDialogClose()
    } catch {
      // 按坏了也不挡更新。
    }
  }

  function setChangelogMarkdown(markdown: string | null): void {
    changelogMarkdown = typeof markdown === 'string' ? markdown : null
    // 显式 wins（#38）：手动给过文本后自动链路不再覆盖（同版本只问一次，本来也不会再问）。
    if (typeof markdown === 'string') manualChangelogOverride = true
    render()
  }

  function unmount(): void {
    if (!mounted) return
    mounted = false
    // 过期回包丢弃（#38）：序号加一 + 在途集合清空，在飞的取数回来即丢，不写已拆的面板。
    autoSeq++
    changelogInflight.clear()
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
    try {
      container.removeEventListener?.('keydown', onKeyDown)
    } catch {
      // 拆不掉也不挡。
    }
    // 卸载只停轮询：绝不调安装/取消电话，安装在宿主进程内继续跑。
  }

  // 首绘即 loading：先做一次只读本地的状态刷新，拿到活体快照后再判定是否自动查一次（#48）。
  // 轮询心跳永远只做只读本地的状态刷新，不触发查新版；自动查复用手动查同一通路（act('check')），
  // 并发只信服务端真相源（busyAct 互斥 + checking 在途复用 + 2 秒复用窗口），卸载靠 mounted 丢弃。
  render()
  try {
    container.addEventListener?.('click', onClick)
  } catch {
    // 没有事件能力的容器也能看（按钮调 controller.act）。
  }
  try {
    container.addEventListener?.('keydown', onKeyDown)
  } catch {
    // 没有键盘事件能力的容器忽略（Esc 关弹窗是渐进增强）。
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
  // mount 串行：首绘 loading → await refresh（只读本地）→ 条件自动查一次；轮询永不查新版。
  void (async () => {
    await refresh()
    try {
      if (pendingAutoCheck(snapshot, busyAct)) void act('check')
    } catch {
      // 自动查失败已在 act 内渲染为既有失败文案，这里不另行处理。
    }
  })()

  return { refresh, act, setMode, setTheme, setShowOthers, setChangelogMarkdown, unmount }
}

// ---------- 面板侧电话名与轮询口径（与派生工具同一源，不写字面量） ----------

export { buildPhoneNames as buildPanelPhoneNames } from './config.js'
export type { PhoneAction as PanelPhoneAction } from './config.js'
export { buildChangelogPhoneName as buildPanelChangelogPhoneName } from './config.js'
export type { ChangelogPhoneAction as PanelChangelogPhoneAction } from './config.js'

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
