// src/gate.ts —— 更新包的门禁模板检查器（#584 落地门禁模板；#120 迁到日志包 0.3.1 形状）。
//
// 给第二个接入更新包的插件自查用：字段白名单检查与三类计数检查，配包内的空模板
// event-list.template.json 一起用。形状与日志包（dsh-log）0.3.1 的事件清单完全一致
// （版本号、插件标识、事件表），已经用过日志包的插件可以直接照抄写法。
//
// 全程用“更新系统”指更新功能本身，用“更新包”指装着更新系统的这个 npm 包。
// 电话指宿主对外提供的方法；落盘指宿主统一写本地文件的动作。
//
// 清单长这样（空模板见包内的 event-list.template.json）：
//
//   {
//     "version": 1,
//     "pluginId": "my-plugin",
//     "events": {
//       "host.call": {
//         "level": "info",
//         "kind": "resident",
//         "fields": ["method", "latencyMs", "ok", "kind", "pluginId"],
//         "codes": [],
//         "rules": []
//       }
//     }
//   }
//
// 每条事件四样东西：事件名（events 的键）、级别（level）、允许字段（fields，之外不记）、
// 脱敏引用（codes 是截断或散列代号、rules 是具名正则名，都是引用名，命中只记规则名不记原文）。
// rules 栏引用 src/shared/redaction.ts 的 REDACTION_RULE_NAMES（R_ABSOLUTE_PATH 等五条，顺序固定），
// 不必复述匹配形态；codes/rules 两栏是声明格式，rules 引用名由 lintEventList 逐条核对。
// kind 说明这条归哪类计数：resident 常驻（始终落盘的轻量轨迹）、ondemand 按需（只在调试开关
// 打开时记）、selfmon 自监控（日志管道自己的故障行，错误与告警级、始终落盘）。
// guard 可选，一句话写清守卫（如百分之一采样、节流），无特殊守卫不写。
//
// 0.3.1 的三处变化（#120）：
//   1) 清单里**不再写自报计数** counts——条数由 computeEventCounts 现算。旧清单若带着 counts，
//      本文件照收不误（收下但不参与判断），这样第二家不用为了升版改自己的清单；
//   2) 字段检查改两档：lintEventFields 给 severity（unknown 字段黄、unknown 事件红），
//      比旧 checkEventFields 的单一 ok 多一档“黄不拦上线”；
//   3) 落盘行的格式版本是 3（LOG_FORMAT_VERSION），parseLogRow 对它做 v === 3 断言。
// 旧名 checkEventFields / checkEventCounts 保留一版弃用壳，行为与旧版一致，下个大版本删。
//
// #210 的扩展是**顶层** `fieldEnums`（事件名 -> 字段名 -> 允许的稳定码枚举）：条目形状仍是
// 0.3.1 的六键，随包清单整份交给 dsh-log 时它只认顶层 version/pluginId/events/counts，
// 顶层多出来的键收下不用；条目里多键才会整份被拒（0.3.4 的 parseEventEntry 白名单）。
// 所以机器枚举只能放顶层，这样「本包自己的尺子」与「dsh-log 的清单校验」互不打架。
//
// 通用检查器只收对象，不读文件：lintEventFields 做字段白名单检查，computeEventCounts 做计数。
// 检查器是纯函数（不跨进程、不碰磁盘、无定时器、无新电话），不触发日志埋点纪律里的五种变动，
// 所以不新增日志点；也未新增日志事件，附录第 1 章对照表不用动。
// 本仓现有 55 事件对照仍以消费方的 research/489-appendix.md 与 tests/verify-log-*.js 为准，
// 本包只给格式与检查器，不复刻那张表，免得两处对照要双写同步。
//
// 冻结说明：清单格式版本现在只有 1；三个旧事件加完标识后的键集合为基线
// （成功事件 5 键、失败事件 4 键、执行事件 5 键，见规格 #591 第 8、13 条），
// 本文件不定基线，只给检查形状的尺子。
//
// 诚实边界（#19）：本文件是给第二个接入方自查用的尺子，不是门禁——
// lintEventFields 是纯函数（不抛错、不记日志、不被任何生产代码调用），
// 真正在守日志字段基线的是 tests/phones.test.mjs 与 tests/routes.test.mjs 里的逐字键集断言。

import { assertPluginId } from './shared/config.js'
import { REDACTION_RULE_NAMES } from './shared/redaction.js'

// 事件级别（沿用附录定版：错误与告警始终落盘，信息中常驻落盘，其余只在调试开关打开时落盘）。
export const EVENT_LEVELS = ['error', 'warn', 'info', 'debug'] as const
export type GateEventLevel = (typeof EVENT_LEVELS)[number]

// 事件归类（只为计数检查服务，与级别是两回事：级别管落不落盘，归类管数对不对）。
export const EVENT_KINDS = ['resident', 'ondemand', 'selfmon'] as const
export type GateEventKind = (typeof EVENT_KINDS)[number]

// 落盘行的格式版本（日志包 0.3.1 的 LOG_FORMAT_VERSION）：行恒五键 v/ts/level/event/fields。
export const LOG_ROW_VERSION = 3

// 事件名契约：小写点分（如 update.check.done、host.call）。
const EVENT_NAME_RE = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/
// 散列或截断代号契约：大写字母数字下划线（如 H_CWD、H_ERR、T120）。
const CODE_NAME_RE = /^[A-Z][A-Z0-9_]{1,15}$/
// 自由文本键黑名单（ADR-0006：日志行只承载稳定码，人话在渲染层）——出现即黄。
const FREE_TEXT_FIELD_NAMES = ['message', 'detail', 'text', 'raw', 'diagnostic', 'command', 'path', 'url']

/** 事件名是否合契约（小写点分）。发射口与门禁共用这一把尺子，别各写一份正则。 */
export function isEventName(value: unknown): boolean {
  return typeof value === 'string' && EVENT_NAME_RE.test(value)
}

/** 散列/截断代号是否合契约（如 H_CWD）。 */
export function isCodeName(value: unknown): boolean {
  return typeof value === 'string' && CODE_NAME_RE.test(value)
}

export interface GateEventEntry {
  // 级别：error、warn、info、debug 四选一。
  level: GateEventLevel
  // 归类：resident、ondemand、selfmon 三选一。
  kind: GateEventKind
  // 允许字段：该事件能记的全部字段键，之外的键一律不记。
  fields: string[]
  // 脱敏引用：截断或散列代号（如 H_CWD、T120），无则不写或空数组。
  codes?: string[]
  // 脱敏引用：具名正则名（取 src/shared/redaction.ts 的 REDACTION_RULE_NAMES，如 R_ABSOLUTE_PATH），该事件无自由文本则不写或空数组。声明格式，引用名由 lintEventList 核对。
  rules?: string[]
  // 守卫说明：一句话写清采样或节流，无特殊守卫不写。
  guard?: string
}

export interface GateEventCounts {
  resident: number
  ondemand: number
  selfmon: number
}

export interface GateEventList {
  // 清单格式版本：现在只有 1，收到别的数字直接报错。
  version: 1
  // 清单属于哪个插件：与建更新能力的插件标识同一约束（非空且不含路径分隔符）。
  pluginId: string
  // 事件表：键是事件名，值是该事件的级别、归类、允许字段与脱敏引用。
  events: Record<string, GateEventEntry>
  // 字段允许值（#210）：事件名 -> 字段名 -> 允许的稳定码枚举。
  // 没声明的字段不限制取值；声明了却写了枚举外的值，运行期只丢该字段（开发期直接抛）。
  //
  // 为什么放在清单顶层而不是事件条目里：随包清单会整份交给 dsh-log 建日志实例，
  // 条目里多一个键会被 0.3.4 的清单校验整份拒掉；顶层未知键它收下不用，所以放这里两不误。
  fieldEnums?: Record<string, Record<string, string[]>>
  // 旧版清单里的自报计数：0.3.1 起不再要求，收下也不参与判断（条数由 computeEventCounts 现算）。
  counts?: GateEventCounts
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value) && Math.floor(value) === value && value >= 0
}

function assertStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw new Error('[dsh-plugin-update] 事件清单 eventList 非法：' + what + ' 必须是字符串数组')
  const seen: string[] = []
  for (const item of value) {
    if (!isNonEmptyString(item)) throw new Error('[dsh-plugin-update] 事件清单 eventList 非法：' + what + ' 里有空字段名')
    if (seen.indexOf(item) >= 0) throw new Error('[dsh-plugin-update] 事件清单 eventList 非法：' + what + ' 里字段名重复：' + item)
    seen.push(item)
  }
  return seen
}

// 把调用方传进来的值验成可用的事件清单：错了直接报错，不静默修补。
// 字符串（路径）形式在这里就被拦下：调用方先把清单文件读成对象再传入，更新包不读盘。
export function parseEventListManifest(value: unknown): GateEventList {
  if (typeof value === 'string') {
    throw new Error('[dsh-plugin-update] 事件清单 eventList 非法：路径形式请调用方自己读成对象再传入，更新包不读盘')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[dsh-plugin-update] 事件清单 eventList 非法：只收对象形式（空模板见包内的 event-list.template.json）')
  }
  const input = value as Record<string, unknown>
  if (input['version'] !== 1) {
    throw new Error('[dsh-plugin-update] 事件清单 eventList 非法：version 现在只认 1（收到 ' + JSON.stringify(input['version']) + '）')
  }
  const pluginId = assertPluginId(input['pluginId'])
  const eventsRaw = input['events']
  if (!eventsRaw || typeof eventsRaw !== 'object' || Array.isArray(eventsRaw)) {
    throw new Error('[dsh-plugin-update] 事件清单 eventList 非法：events 必须是事件名到条目的对象')
  }
  const events: Record<string, GateEventEntry> = {}
  for (const name of Object.keys(eventsRaw as Record<string, unknown>)) {
    events[name] = parseEventEntry(name, (eventsRaw as Record<string, unknown>)[name])
  }
  const manifest: GateEventList = { version: 1, pluginId: pluginId, events: events }
  if (input['fieldEnums'] !== undefined) manifest.fieldEnums = assertFieldEnums(input['fieldEnums'], events)
  const declared = parseDeclaredCounts(input['counts'])
  if (declared) manifest.counts = declared
  return manifest
}

// 旧清单里的自报计数：三项都是非负整数才收下；形状不对就当没写（0.3.1 起它不再是必填）。
function parseDeclaredCounts(value: unknown): GateEventCounts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const counts: GateEventCounts = { resident: 0, ondemand: 0, selfmon: 0 }
  for (const kind of EVENT_KINDS) {
    if (!isCount(record[kind])) return null
    counts[kind] = record[kind] as number
  }
  return counts
}

// 验清单里的一条事件：级别与归类必须是枚举值，条目里不认多余的键（多半是拼写错误）。
function parseEventEntry(name: string, value: unknown): GateEventEntry {
  if (!isNonEmptyString(name)) throw new Error('[dsh-plugin-update] 事件清单 eventList 非法：事件名不能为空')
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[dsh-plugin-update] 事件清单 eventList 非法：事件 ' + name + ' 必须是对象')
  }
  const input = value as Record<string, unknown>
  if ((EVENT_LEVELS as readonly string[]).indexOf(input['level'] as string) < 0) {
    throw new Error('[dsh-plugin-update] 事件清单 eventList 非法：事件 ' + name + ' 的 level 只许 error、warn、info、debug')
  }
  if ((EVENT_KINDS as readonly string[]).indexOf(input['kind'] as string) < 0) {
    throw new Error('[dsh-plugin-update] 事件清单 eventList 非法：事件 ' + name + ' 的 kind 只许 resident、ondemand、selfmon')
  }
  for (const key of Object.keys(input)) {
    if (['level', 'kind', 'fields', 'codes', 'rules', 'guard'].indexOf(key) < 0) {
      throw new Error('[dsh-plugin-update] 事件清单 eventList 非法：事件 ' + name + ' 有不认识的键 ' + key)
    }
  }
  const entry: GateEventEntry = {
    level: input['level'] as GateEventLevel,
    kind: input['kind'] as GateEventKind,
    fields: assertStringArray(input['fields'], '事件 ' + name + ' 的 fields')
  }
  if (input['codes'] !== undefined) entry.codes = assertStringArray(input['codes'], '事件 ' + name + ' 的 codes')
  if (input['rules'] !== undefined) entry.rules = assertStringArray(input['rules'], '事件 ' + name + ' 的 rules')
  if (input['guard'] !== undefined) {
    if (typeof input['guard'] !== 'string') {
      throw new Error('[dsh-plugin-update] 事件清单 eventList 非法：事件 ' + name + ' 的 guard 必须是字符串')
    }
    entry.guard = input['guard'] as string
  }
  return entry
}

/**
 * 验清单顶层的字段枚举声明（#210）：事件名必须已在 events 里声明，字段名必须在该事件的 fields 里声明过；
 * 值必须是非空字符串、不重复、数组非空。坏声明直接抛 —— 枚举是「允许值」的机器事实源，写错了比没写更危险。
 */
function assertFieldEnums(
  value: unknown,
  events: Record<string, GateEventEntry>
): Record<string, Record<string, string[]>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[dsh-plugin-update] eventList invalid: fieldEnums must be an object of event -> field -> allowed string[]')
  }
  const input = value as Record<string, unknown>
  const out: Record<string, Record<string, string[]>> = {}
  for (const eventName of Object.keys(input)) {
    const entry = events[eventName]
    if (!entry) {
      throw new Error('[dsh-plugin-update] eventList invalid: fieldEnums references an event not declared in events: ' + eventName)
    }
    const declared = input[eventName]
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
      throw new Error('[dsh-plugin-update] eventList invalid: event ' + eventName + ' fieldEnums must be an object of field -> allowed string[]')
    }
    const fields: Record<string, string[]> = {}
    for (const field of Object.keys(declared as Record<string, unknown>)) {
      if (entry.fields.indexOf(field) < 0) {
        throw new Error('[dsh-plugin-update] eventList invalid: event ' + eventName + ' fieldEnums references a field not declared in fields: ' + field)
      }
      const raw = (declared as Record<string, unknown>)[field]
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('[dsh-plugin-update] eventList invalid: event ' + eventName + ' fieldEnums.' + field + ' must be a non-empty string array')
      }
      const seen: string[] = []
      for (const item of raw) {
        if (!isNonEmptyString(item)) {
          throw new Error('[dsh-plugin-update] eventList invalid: event ' + eventName + ' fieldEnums.' + field + ' has empty or non-string values')
        }
        if (seen.indexOf(item) >= 0) {
          throw new Error('[dsh-plugin-update] eventList invalid: event ' + eventName + ' fieldEnums.' + field + ' has duplicate value: ' + item)
        }
        seen.push(item)
      }
      fields[field] = seen
    }
    out[eventName] = fields
  }
  return out
}

// 计数现算：按归类数实际条数（0.3.1 起清单不写自报计数，尺子自己数）。
export function computeEventCounts(manifest: GateEventList): GateEventCounts {
  const counts: GateEventCounts = { resident: 0, ondemand: 0, selfmon: 0 }
  for (const name of Object.keys(manifest.events)) {
    counts[manifest.events[name].kind] += 1
  }
  return counts
}

export interface GateFieldCheck {
  ok: boolean
  // 事件名根本不在清单里（调用方拼错名或清单漏登记）。
  unknownEvent: boolean
  // 在清单里但不在该事件允许字段里的键。
  unknownFields: string[]
}

export interface GateLintFieldsResult extends GateFieldCheck {
  // 两档：none 全清、warn 有未知字段（黄，不拦上线）、error 未知事件（红）。
  severity: 'none' | 'warn' | 'error'
}

// 引擎保留名：dsh-log 0.3.3 起，宿主侧写入路径会在**每一条链内行**的 fields 里追加这三个键
// （traceId / spanId / seq，见 dsh-log 的 src/core/trace.ts）。它们由引擎注入，不在任何事件的
// fields 声明里，也不该被要求声明 —— 所以「拿清单量一条**读回来的行**」之前先摘掉它们。
//
// 生产者侧不受影响：`emitUpdateLog` 的白名单在注入**之前**跑，那时这三个键还不存在，
// 所以清单仍然是「我们允许自己发什么」的唯一事实源；这里豁免的是读侧那把尺子。
export const RESERVED_LOG_FIELDS = ['traceId', 'spanId', 'seq'] as const

// 从一批字段键里摘掉引擎保留名。量落盘行（`parseLogRow` 之后）时先过这一道，
// 再交给 `lintEventFields`，否则每条带链的行都会因为这三个键被判黄。
export function stripReservedLogFields(fieldNames: string[]): string[] {
  const reserved = new Set<string>(RESERVED_LOG_FIELDS)
  return (Array.isArray(fieldNames) ? fieldNames : []).filter((field) => !reserved.has(field))
}

// 字段白名单检查（0.3.1 名字）：拿插件自己的清单当尺子，量一批实际字段键。
// 未知事件名算红（拼错名或漏登记），未知字段键算黄（带回名单，不误伤已知字段）。
// 这把尺子是**字面**的：给它什么就量什么 —— 读落盘行请先 `stripReservedLogFields`。
export function lintEventFields(
  manifest: GateEventList,
  eventName: string,
  fieldNames: string[]
): GateLintFieldsResult {
  const entry = manifest.events[eventName]
  if (!entry) return { ok: false, severity: 'error', unknownEvent: true, unknownFields: [] }
  const allowed = new Set(entry.fields)
  const unknownFields = (Array.isArray(fieldNames) ? fieldNames : []).filter(
    (field) => !allowed.has(field)
  )
  if (unknownFields.length > 0) {
    return { ok: false, severity: 'warn', unknownEvent: false, unknownFields: unknownFields }
  }
  return { ok: true, severity: 'none', unknownEvent: false, unknownFields: [] }
}

export interface GatePrunedField {
  field: string
  // 字段被摘掉的原因：清单没声明这个键，或值不在声明的枚举里。
  reason: 'unknown-field' | 'invalid-enum'
}

export interface GateFieldPruneResult {
  ok: boolean
  // 事件名根本不在清单里：整行都不该落（与字段级裁剪是两回事）。
  unknownEvent: boolean
  // 通过校验、应当原样保留的字段（顺序与传入一致）。
  keptFields: Record<string, unknown>
  // 被摘掉的字段与原因（运行期只丢字段、整行其余字段照落）。
  prunedFields: GatePrunedField[]
}

/**
 * 字段级裁剪（#210）：按清单把不合规的**字段**摘掉，而不是把整行丢掉。
 *
 * 为什么是字段级：ADR-0006 的验收口径是「开发期未登记字段抛，运行期丢弃该字段并计数」——
 * 一个漂移字段不该毁掉整条证据行（故障现场最贵的就是那一行）。
 * 枚举校验对声明了 `enums[field]` 的字段生效；`null`/`undefined` 视为缺省（不写就是缺省，不参与枚举）。
 */
export function pruneEventFields(
  manifest: GateEventList,
  eventName: string,
  fields: Record<string, unknown>
): GateFieldPruneResult {
  const entry = manifest.events[eventName]
  if (!entry) return { ok: false, unknownEvent: true, keptFields: {}, prunedFields: [] }
  const allowed = new Set(entry.fields)
  const declaredEnums = manifest.fieldEnums ? manifest.fieldEnums[eventName] : undefined
  const keptFields: Record<string, unknown> = {}
  const prunedFields: GatePrunedField[] = []
  for (const field of Object.keys(fields)) {
    if (!allowed.has(field)) {
      prunedFields.push({ field: field, reason: 'unknown-field' })
      continue
    }
    const enums = declaredEnums ? declaredEnums[field] : undefined
    const value = fields[field]
    // 声明了枚举的字段：只收声明里的字符串（null/undefined 也算漂移——缺省应该整格不写，不该用 null 冒充）。
    if (enums && (typeof value !== 'string' || enums.indexOf(value) < 0)) {
      prunedFields.push({ field: field, reason: 'invalid-enum' })
      continue
    }
    keptFields[field] = value
  }
  return { ok: prunedFields.length === 0, unknownEvent: false, keptFields: keptFields, prunedFields: prunedFields }
}

export interface GateListLintResult {
  ok: boolean
  // 红：结构或引用错（事件名不合契约、级别/归类非法、codes/rules 引用名不合法、自报计数对不上）。
  red: string[]
  // 黄：可疑但不拦（字段表为空、guard 空串、字段里出现自由文本键——ADR-0006 管这条）。
  yellow: string[]
  // 现算出来的三类条数。
  counts: GateEventCounts
}

// 整份清单过一遍尺子：给包自己的 event-list.update.json 用，也给第二家自查用。
// 纯函数、永不抛错：坏形状经 parseEventListManifest 进不来，这里只做条目级的判断。
export function lintEventList(manifest: GateEventList): GateListLintResult {
  const red: string[] = []
  const yellow: string[] = []
  for (const name of Object.keys(manifest.events)) {
    const entry = manifest.events[name]
    if (!EVENT_NAME_RE.test(name)) {
      red.push('事件名 ' + name + ' 不合契约：只许小写点分（如 update.check.done）')
    }
    if (!entry.fields.length) yellow.push('事件 ' + name + ' 的字段表为空：确认它真的只带必要字段')
    for (const field of entry.fields) {
      if (FREE_TEXT_FIELD_NAMES.indexOf(field) >= 0) {
        yellow.push('事件 ' + name + ' 的字段 ' + field + ' 像自由文本：日志行只承载稳定码（见 ADR-0006）')
      }
    }
    for (const code of entry.codes ?? []) {
      if (!CODE_NAME_RE.test(code)) {
        red.push('事件 ' + name + ' 的 codes 里 ' + code + ' 不是合法的散列或截断代号（如 H_CWD）')
      }
    }
    for (const rule of entry.rules ?? []) {
      if ((REDACTION_RULE_NAMES as readonly string[]).indexOf(rule) < 0) {
        red.push('事件 ' + name + ' 的 rules 引用未登记规则名 ' + rule)
      }
    }
    if (entry.guard !== undefined && !entry.guard.length) {
      yellow.push('事件 ' + name + ' 的 guard 是空串：要么写清守卫，要么整条不写')
    }
  }
  // 字段枚举声明（#210）：只查结构；「字段名集合」的尺子仍是 lintEventFields。
  if (manifest.fieldEnums) {
    for (const eventName of Object.keys(manifest.fieldEnums)) {
      const entry = manifest.events[eventName]
      if (!entry) {
        red.push('eventList fieldEnums references unknown event ' + eventName)
        continue
      }
      const fields = manifest.fieldEnums[eventName]
      for (const field of Object.keys(fields)) {
        if (entry.fields.indexOf(field) < 0) {
          red.push('eventList fieldEnums for event ' + eventName + ' references undeclared field ' + field)
        }
        const values = fields[field]
        if (!Array.isArray(values) || values.length === 0) {
          red.push('eventList fieldEnums.' + eventName + '.' + field + ' must be a non-empty array')
          continue
        }
        const seen: string[] = []
        for (const value of values) {
          if (typeof value !== 'string' || value.length === 0) {
            red.push('eventList fieldEnums.' + eventName + '.' + field + ' contains empty or non-string value')
            continue
          }
          if (seen.indexOf(value) >= 0) {
            red.push('eventList fieldEnums.' + eventName + '.' + field + ' contains duplicate value ' + value)
          }
          seen.push(value)
        }
      }
    }
  }
  const counts = computeEventCounts(manifest)
  if (manifest.counts) {
    for (const kind of EVENT_KINDS) {
      if (manifest.counts[kind] !== counts[kind]) {
        red.push('清单自报 counts.' + kind + ' 为 ' + manifest.counts[kind] + '，实际 ' + counts[kind] + ' 条')
      }
    }
  }
  return { ok: red.length === 0, red: red, yellow: yellow, counts: counts }
}

export interface GateLogRow {
  v: 3
  // 毫秒时间戳（`Date.now()`）—— dsh-log 的行构造器 `core/row.js` 写的就是数，不是字符串。
  ts: number
  level: GateEventLevel
  event: string
  fields: Record<string, unknown>
}

// 落盘行断言（0.3.1 的行格式版本是 3）：行恒五键，多一个少一个都报错。
// 给发射口与测试当尺子用；本包不落盘、不写日志，只验形状。
export function parseLogRow(value: unknown): GateLogRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[dsh-plugin-update] 日志行非法：只收对象（五键 v、ts、level、event、fields）')
  }
  const input = value as Record<string, unknown>
  if (input['v'] !== LOG_ROW_VERSION) {
    throw new Error('[dsh-plugin-update] 日志行非法：格式版本 v 只认 ' + LOG_ROW_VERSION + '（收到 ' + JSON.stringify(input['v']) + '）')
  }
  if (typeof input['ts'] !== 'number' || !Number.isFinite(input['ts'])) {
    throw new Error('[dsh-plugin-update] 日志行非法：ts 必须是有限数（dsh-log 落盘的是 Date.now() 毫秒数）')
  }
  if ((EVENT_LEVELS as readonly string[]).indexOf(input['level'] as string) < 0) {
    throw new Error('[dsh-plugin-update] 日志行非法：level 只许 error、warn、info、debug')
  }
  if (!isNonEmptyString(input['event'])) throw new Error('[dsh-plugin-update] 日志行非法：event 必须是非空字符串')
  const fields = input['fields']
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('[dsh-plugin-update] 日志行非法：fields 必须是对象（可为空对象）')
  }
  for (const key of Object.keys(input)) {
    if (['v', 'ts', 'level', 'event', 'fields'].indexOf(key) < 0) {
      throw new Error('[dsh-plugin-update] 日志行非法：有不认识的键 ' + key)
    }
  }
  return {
    v: LOG_ROW_VERSION,
    ts: input['ts'] as number,
    level: input['level'] as GateEventLevel,
    event: input['event'] as string,
    fields: fields as Record<string, unknown>
  }
}

export interface GateMergeResult {
  // 合并后的清单：以集成方那份为准，只把本包有、对方没有的事件补进去。
  manifest: GateEventList
  // 本包有、对方清单里没有的事件名（已补进去）。
  added: string[]
  // 两边都有的事件名（字段取并集，级别与归类仍按对方声明）。
  merged: string[]
  // 两边都有、但级别或归类不一致的事件名（以对方为准，这里只如实报出来）。
  conflicts: string[]
}

// 把更新包自己那份事件表并进集成方的清单（0.3.1 清单里没有合并 API，这里是一个纯函数）。
// 两份都必须是对象：调用方各自读盘后再传，更新包不读盘。本包事件表随包发布，见 event-list.update.json。
// 语义：对方没有的事件 → 原样补进去；两边都有 → 字段取并集（谁都不许因为合并丢掉自己的字段），
// 级别与归类仍按对方声明（那是对方实例的准入口径）；级别或归类不一致的记进 conflicts，调用方自行决定要不要处置。
export function mergeUpdateEvents(manifest: unknown, updateEvents: unknown): GateMergeResult {
  const base = parseEventListManifest(manifest)
  const incoming = parseEventListManifest(updateEvents)
  const events: Record<string, GateEventEntry> = {}
  for (const name of Object.keys(base.events)) events[name] = cloneEventEntry(base.events[name])
  const added: string[] = []
  const merged: string[] = []
  const conflicts: string[] = []
  for (const name of Object.keys(incoming.events)) {
    const mine = incoming.events[name]
    const theirs = events[name]
    if (!theirs) {
      events[name] = cloneEventEntry(mine)
      added.push(name)
      continue
    }
    const fields = theirs.fields.slice()
    for (const field of mine.fields) if (fields.indexOf(field) < 0) fields.push(field)
    const entry: GateEventEntry = { level: theirs.level, kind: theirs.kind, fields: fields }
    const codes = unionList(theirs.codes, mine.codes)
    const rules = unionList(theirs.rules, mine.rules)
    if (codes.length) entry.codes = codes
    if (rules.length) entry.rules = rules
    const guard = theirs.guard ?? mine.guard
    if (guard !== undefined) entry.guard = guard
    events[name] = entry
    merged.push(name)
    if (theirs.level !== mine.level || theirs.kind !== mine.kind) {
      conflicts.push(
        '事件 ' + name + ' 两边声明不一致：级别 ' + theirs.level + '/' + mine.level + '，归类 ' + theirs.kind + '/' + mine.kind
      )
    }
  }
  const result: GateEventList = { version: 1, pluginId: base.pluginId, events: events }
  const fieldEnums = unionFieldEnums(base.fieldEnums, incoming.fieldEnums)
  if (fieldEnums) result.fieldEnums = fieldEnums
  if (base.counts) result.counts = base.counts
  return { manifest: result, added: added, merged: merged, conflicts: conflicts }
}

/**
 * 深拷贝一条事件条目（含字段/代号/规则数组与枚举声明）。合并与换名发布共用这一处，
 * 免得两份实现哪天对「哪些键算契约」理解不一。
 */
export function cloneEventEntry(entry: GateEventEntry): GateEventEntry {
  const copy: GateEventEntry = { level: entry.level, kind: entry.kind, fields: entry.fields.slice() }
  if (entry.codes) copy.codes = entry.codes.slice()
  if (entry.rules) copy.rules = entry.rules.slice()
  if (entry.guard !== undefined) copy.guard = entry.guard
  return copy
}

function unionList(first?: string[], second?: string[]): string[] {
  const out: string[] = []
  for (const item of [...(first ?? []), ...(second ?? [])]) if (out.indexOf(item) < 0) out.push(item)
  return out
}

// 枚举合并口径与字段一致：按事件、按字段取并集，谁都不许因为合并丢掉自己声明的允许值。
function unionFieldEnums(
  first?: Record<string, Record<string, string[]>>,
  second?: Record<string, Record<string, string[]>>
): Record<string, Record<string, string[]>> | undefined {
  if (!first && !second) return undefined
  const out: Record<string, Record<string, string[]>> = {}
  const events: string[] = []
  for (const source of [first, second]) {
    if (!source) continue
    for (const eventName of Object.keys(source)) if (events.indexOf(eventName) < 0) events.push(eventName)
  }
  for (const eventName of events) {
    const left = first ? first[eventName] : undefined
    const right = second ? second[eventName] : undefined
    const fields: string[] = []
    for (const source of [left, right]) {
      if (!source) continue
      for (const field of Object.keys(source)) if (fields.indexOf(field) < 0) fields.push(field)
    }
    const merged: Record<string, string[]> = {}
    for (const field of fields) merged[field] = unionList(left ? left[field] : undefined, right ? right[field] : undefined)
    out[eventName] = merged
  }
  return out
}

export interface GateCountCheck {
  ok: boolean
  // 每条问题都是完整的一句话，调用方直接打印即可。
  problems: string[]
}

// @deprecated 0.16.0 起改用 lintEventFields（日志包 0.3.1 的名字）；本名保留一版，下个大版本删。
// 行为与旧版一致：未知事件与未知字段都算不通过。
export function checkEventFields(
  manifest: GateEventList,
  eventName: string,
  fieldNames: string[]
): GateFieldCheck {
  const linted = lintEventFields(manifest, eventName, fieldNames)
  return { ok: linted.ok, unknownEvent: linted.unknownEvent, unknownFields: linted.unknownFields }
}

// @deprecated 0.16.0 起改用 computeEventCounts（现算条数）；本名保留一版，下个大版本删。
// 旧语义：拿清单里自报的 counts 与实际条数对账；清单没写 counts 就无账可对，直接算过（0.3.1 起不写 counts）。
export function checkEventCounts(manifest: GateEventList): GateCountCheck {
  const actual = computeEventCounts(manifest)
  const problems: string[] = []
  if (manifest.counts) {
    for (const kind of EVENT_KINDS) {
      if (actual[kind] !== manifest.counts[kind]) {
        problems.push(
          '[dsh-plugin-update] 事件清单计数对不上：' + kind + ' 类实际 ' + actual[kind] + ' 条，清单自报 ' + manifest.counts[kind] + ' 条'
        )
      }
    }
  }
  return { ok: problems.length === 0, problems: problems }
}
