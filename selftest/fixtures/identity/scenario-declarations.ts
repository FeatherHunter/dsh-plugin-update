/**
 * selftest/fixtures/identity/scenario-declarations.ts —— 版本化场景声明（#266 T2 单一真源）。
 *
 * 一条场景声明回答四件事：干净 profile 装什么（基版）、更新时发布什么（变体版）、
 * 变体改的是哪类东西（UI / 行为 / 元数据）、以及预期是什么。
 *
 * 谁读它：
 *   - 发布器（selftest/real-machine/runtime/scenario-runner.ts）按声明发夹具版本；
 *   - 场景 runner（scenarios/*.ts）按声明写断言与预期（不许在自己的文件里再写死版本号/效果）；
 *   - 夹具单测（generator/fixture-package-plan.test.ts）核对「声明里的每个版本都能生成、矩阵里有对应行」。
 *
 * 扩展方式（评审要的「可复用」）：加一个版本变体 = 在对应场景的 variants 里加一条
 * {slotKey, version, changeClasses, effect}；加一个场景 = 加一条 ScenarioDeclaration + coverage-matrix 一行。
 */
import type { FixtureChangeClass, FixtureSlot, FixtureSlotKey, FixtureVariantEffect, FixtureVersion } from './fixture-slots.ts'
import { FIXTURE_SLOT_A, FIXTURE_SLOT_B, FIXTURE_SLOT_C, fixtureSlotOf } from './fixture-slots.ts'

/** 干净 profile 预装的一步：装哪个席位、装哪个版本、用什么效果渲染。 */
export interface ScenarioInstallStep {
  readonly slotKey: FixtureSlotKey
  readonly version: FixtureVersion
  readonly effect: FixtureVariantEffect
}

/** 一个要发布并被装上的版本变体。 */
export interface FixtureVariantDeclaration {
  readonly slotKey: FixtureSlotKey
  readonly version: FixtureVersion
  /** 这个变体相对基版改了什么（UI / 行为 / 元数据）；证据与矩阵按它说明。 */
  readonly changeClasses: readonly FixtureChangeClass[]
  readonly effect: FixtureVariantEffect
}

/** 一条场景声明（id 必须等于 coverage-matrix 的行 id、也等于 evidence run 的 scenarioId）。 */
export interface ScenarioDeclaration {
  /** 矩阵行 id（evidence run.json 的 scenarioId 用它）。 */
  readonly id: string
  /** 证据 run 的 ticket 前缀（run 目录名 = ticket-stamp）。 */
  readonly ticket: string
  readonly hostChannel: 'desktop-official' | 'dsh-web'
  readonly summary: string
  readonly install: readonly ScenarioInstallStep[]
  readonly variants: readonly FixtureVariantDeclaration[]
  /** 场景的预期（矩阵「预期」列的机器可读版本；场景 runner 的断言必须覆盖它们）。 */
  readonly expected: readonly string[]
}

/** T1 的单面板效果（场景 A；兼容 T1 场景复跑）。 */
export function legacySingleEffectOf(version: FixtureVersion): FixtureVariantEffect {
  return {
    ui: 'single',
    titleSuffix: version === '0.0.2' ? '（新版）' : '',
    hubDock: false,
    hostBehavior: null,
    seatLine: '',
  }
}

/**
 * 批量集成方的效果（T2 b/c 场景）。
 * 基版：批量面板 + 批量入口（能发起批量），无中枢坞、host 桥无 behavior 字段。
 * 变体：多挂中枢进度坞（新 UI 元素 + 轮询 updateHubStatus 的行为）+ host 桥新增 behavior 字段
 *       （client 把真 host 回复渲染成 [data-fixture-behavior]，所以「行为变了」不是编译期文案）。
 */
export function batchEffectOf(slot: FixtureSlot, variant: boolean): FixtureVariantEffect {
  const seatLine =
    slot.batch === null
      ? ''
      : '批量席位 ' + slot.batch.prefix + ' · 自键 ' + slot.batch.selfKey + ' · 目标 ' + slot.batch.targets.map((target) => target.key).join('/')
  return {
    ui: 'batch',
    titleSuffix: variant ? '（批量新版）' : '',
    hubDock: variant,
    hostBehavior: variant ? 'seat-aware-v2' : null,
    seatLine,
  }
}

/** 纯目标的效果（模板里目标不挂任何更新 UI；effect 只影响构建标记/清单，不影响接线）。 */
export function targetEffectOf(version: FixtureVersion): FixtureVariantEffect {
  return {
    ui: 'batch',
    titleSuffix: version === '0.0.2' ? '（新版）' : '',
    hubDock: false,
    hostBehavior: null,
    seatLine: '',
  }
}

/** 场景 A（#265 T1，单包主链）：保留在声明里，矩阵/LEDGER 可一并对账；runner 仍是 T1 那份。 */
export const SCENARIO_A_SINGLE_PACKAGE: ScenarioDeclaration = {
  id: 'a-single-package-main-chain',
  ticket: '265',
  hostChannel: 'desktop-official',
  summary: '单包主链：A@0.0.1 → 真 UI 检查/安装 → A@0.0.2 重启后可见变化',
  install: [{ slotKey: 'a', version: '0.0.1', effect: legacySingleEffectOf('0.0.1') }],
  variants: [
    {
      slotKey: 'a',
      version: '0.0.2',
      changeClasses: ['ui', 'metadata'],
      effect: legacySingleEffectOf('0.0.2'),
    },
  ],
  expected: ['运行版/已安装 0.0.2', '卡片标题与 client/host 构建标记变成新版', '磁盘、日志、台账三处一致'],
}

/** 场景 b（#266 T2）：两个批量集成方 + 一个纯目标同 profile，真 UI 批量更新。 */
export const SCENARIO_B_BATCH_TWO_INTEGRATORS: ScenarioDeclaration = {
  id: 'b-batch-two-integrators',
  ticket: '266',
  hostChannel: 'desktop-official',
  summary: 'A/B 两个批量集成方 + C 纯目标同装：A 发起批量更新，两席视图正确、三目标推到 0.0.2、无跨 scope 污染',
  install: [
    { slotKey: 'a', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_A, false) },
    { slotKey: 'b', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_B, false) },
    { slotKey: 'c', version: '0.0.1', effect: targetEffectOf('0.0.1') },
  ],
  variants: [
    { slotKey: 'a', version: '0.0.2', changeClasses: ['ui', 'behavior', 'metadata'], effect: batchEffectOf(FIXTURE_SLOT_A, true) },
    { slotKey: 'b', version: '0.0.2', changeClasses: ['ui', 'behavior', 'metadata'], effect: batchEffectOf(FIXTURE_SLOT_B, true) },
    { slotKey: 'c', version: '0.0.2', changeClasses: ['behavior', 'metadata'], effect: targetEffectOf('0.0.2') },
  ],
  expected: [
    'A 批量入口列出三个目标（a/b/c），B 批量入口列出两个目标（b/c）',
    'A 发起的批量更新把 a/b/c 的磁盘版本都推到 0.0.2',
    '两席各自面板行状态正确（A 三行、B 两行；互不串台）',
    '重启后 A/B 的 0.0.2 变体新 UI 元素与 host 行为字段出现，C 徽标 0.0.2',
    '批量账本/队列/中枢计划/日志按属主隔离，无跨 scope 污染',
  ],
}

/** 场景 c（#266 T2）：纯目标 C 被 A 批量推到 0.0.2，且 C 自己没有任何更新 UI/接线。 */
export const SCENARIO_C_PURE_TARGET: ScenarioDeclaration = {
  id: 'c-pure-target-no-wiring',
  ticket: '266',
  hostChannel: 'desktop-official',
  summary: 'A@0.0.1 + C（纯目标）@0.0.1：A 批量把 C 推到 0.0.2，C 页面没有 .dsh-upd 面板/入口',
  install: [
    { slotKey: 'a', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_A, false) },
    { slotKey: 'c', version: '0.0.1', effect: targetEffectOf('0.0.1') },
  ],
  variants: [{ slotKey: 'c', version: '0.0.2', changeClasses: ['behavior', 'metadata'], effect: targetEffectOf('0.0.2') }],
  expected: [
    'C 被 A 的批量动作推到 0.0.2（磁盘 + C 徽标 + A 面板行）',
    'C 的卡片/页面没有 .dsh-upd 面板、没有更新入口',
    'C 的包清单不依赖 dsh-plugin-update（无更新接线的最强证据）',
    'A 自己保持 0.0.1（只推纯目标，不把「顺序里没更新的行」也动掉）',
  ],
}

/**
 * T3（#267）三出口矩阵的六条声明。
 *
 * 命名：d*=出口二（官方桌面 in-process 插件管理器，通道 A），e*=出口三（普通 DSH 宿主 spawn CLI，
 * 通道 B），f*=出口一（第三方 Desktop，本机不可达，只做能力探测）。每条声明 = 矩阵一行；
 * 出口二/三的成功与失败格共用同一套基版/变体（A@0.0.1 → A@0.0.2，单面板效果），
 * 差别只在故障注入与断言组，这样两格之间的「变化」只有故障，不掺别的变量。
 */
const THREE_EXIT_INSTALL: readonly ScenarioInstallStep[] = [{ slotKey: 'a', version: '0.0.1', effect: legacySingleEffectOf('0.0.1') }]
const THREE_EXIT_VARIANTS: readonly FixtureVariantDeclaration[] = [
  { slotKey: 'a', version: '0.0.2', changeClasses: ['ui', 'metadata'], effect: legacySingleEffectOf('0.0.2') },
]

/** 出口二成功格：官方桌面插件管理器 remove→install 两步真机更新。 */
export const SCENARIO_D1_DESKTOP_MANAGER_SUCCESS: ScenarioDeclaration = {
  id: 'd1-desktop-manager-update-success',
  ticket: '267',
  hostChannel: 'desktop-official',
  summary: '出口二成功：官方桌面 in-process 插件管理器把 A@0.0.1 更新到 A@0.0.2（remove→install 两步）',
  install: THREE_EXIT_INSTALL,
  variants: THREE_EXIT_VARIANTS,
  expected: [
    'check 后目标版本 0.0.2 可安装（面板/电话一致）',
    '.plugin-manager/logs 时间窗内恰两次非空 operation：先移除 A@0.0.1、后安装 A@0.0.2',
    'update.install.exec route=desktop-manager ok=true，且无 update.install.fail',
    '磁盘 dependencies/包内版本与重启后 UI 都是 0.0.2',
  ],
}

/** 出口二失败格：check 后下架 0.0.2，安装以 install-failed 收局（诚实面）。 */
export const SCENARIO_D2_DESKTOP_MANAGER_FAILURE: ScenarioDeclaration = {
  id: 'd2-desktop-manager-update-failure',
  ticket: '267',
  hostChannel: 'desktop-official',
  summary: '出口二失败：check 正常；安装时 registry 里 0.0.2 的 tarball 被删（元数据/integrity 不动），管理器移除步成功、重装失败；产品稳定码 install-failed + 宿主原话 + 可执行手工命令',
  install: THREE_EXIT_INSTALL,
  variants: THREE_EXIT_VARIANTS,
  expected: [
    '安装电话先 ok:true 受理（异步）；失败落在后续快照任务 job.state=failed，message 以 install-failed 开头',
    'update.install.fail stage=exec reason=nonzero-exit，update.install.exec route=desktop-manager ok=false',
    'HMR 宿主的失败必然发生在第二步：人话格「目标包已被宿主移除，重装失败」+ 可执行载体命令',
    '磁盘保持 0.0.1（失败不假装成功）；首装 registry 类失败的「无载体命令」诚实面在 HMR 宿主不可达（库内覆盖）',
  ],
}

/** 出口三成功格：普通 DSH 宿主 spawn CLI 子进程把 A@0.0.1 更新到 A@0.0.2。 */
export const SCENARIO_E1_CLI_HOST_SUCCESS: ScenarioDeclaration = {
  id: 'e1-cli-host-update-success',
  ticket: '267',
  hostChannel: 'dsh-web',
  summary: '出口三成功：普通 DSH 宿主（非 desktop profile）spawn CLI 子进程更新 A@0.0.1→A@0.0.2',
  install: THREE_EXIT_INSTALL,
  variants: THREE_EXIT_VARIANTS,
  expected: [
    'update.install.exec route=cli-process ok=true exitCode=0',
    '磁盘 0.0.2、重启后 buildTag=host v0.0.2',
    '电话回包 ok=true 与日志/磁盘一致（电话先回、exec 后完，完成判据用磁盘+日志）',
  ],
}

/** 出口三失败格：check 后下架 0.0.2，CLI 子进程非零退出，产品记 install-failed。 */
export const SCENARIO_E2_CLI_HOST_FAILURE: ScenarioDeclaration = {
  id: 'e2-cli-host-update-failure',
  ticket: '267',
  hostChannel: 'dsh-web',
  summary: '出口三失败：check 正常；安装时删 registry 里 0.0.2 的 tarball（元数据不动），载体 CLI 子进程 pnpm 404 非零退出；稳定码 install-failed + 原话，磁盘不变',
  install: THREE_EXIT_INSTALL,
  variants: THREE_EXIT_VARIANTS,
  expected: [
    'update.install.exec route=cli-process ok=false exitCode 非空',
    'update.install.fail stage=exec reason=nonzero-exit code=install-failed',
    '失败人话格给出 detail 原话；registry 类失败不出现载体命令',
    '磁盘保持 0.0.1',
  ],
}

/** 出口三超时格：installTimeoutMs=4s，载体 CLI 子进程被终止。 */
export const SCENARIO_E3_CLI_HOST_TIMEOUT: ScenarioDeclaration = {
  id: 'e3-cli-host-install-timeout',
  ticket: '267',
  hostChannel: 'dsh-web',
  summary: '出口三超时：installTimeoutMs=4s，安装请求被挂起，产品超时终止 CLI 子进程并给超时原话',
  install: THREE_EXIT_INSTALL,
  variants: THREE_EXIT_VARIANTS,
  expected: [
    'update.install.exec route=cli-process ok=false，durationMs 落在 [4000, 4000+3000) 宽限内',
    'update.install.fail reason=timeout code=install-failed',
    '失败任务 message 的超时原话「安装超时，已终止子进程」（宿主未提供终止能力时为 no-terminate 变体）',
    '磁盘保持 0.0.1',
  ],
}

/** 出口一探测格：本机能力探测 + 官方桌面 hostKind 负向证据；真机更新记 known-red。 */
export const SCENARIO_F1_THIRD_PARTY_DESKTOP_PROBE: ScenarioDeclaration = {
  id: 'f1-third-party-desktop-probe',
  ticket: '267',
  hostChannel: 'desktop-official',
  summary: '出口一探测：本机只有官方桌面（无第三方 Desktop / desktopProfiles 服务），留原始探测证据并判 known-red',
  // 探测格也要装一份基版夹具：面板/日志只有插件在宿主里跑起来才有，hostKind 负向证据要靠它。
  install: THREE_EXIT_INSTALL,
  variants: [],
  expected: [
    '文件系统/卸载表/服务探测原始输出进 raw 证据',
    '官方桌面 hostKind=desktop-manager（desktopProfiles 为空）为出口一不可达的负向证据',
    '出口一真机更新（成功格与失败格）断言记 known-red，不伪造真机结果',
  ],
}

/**
 * T4（#268）组 D：超时、取消与已了结的失败。
 *
 * 拓扑固定为 A（批量集成方，常驻观察者，永不更新）+ B（批量集成方，被更新目标）+ C（纯目标，
 * 用来制造「第二个安装进队列」），三席基版同装。A 自己的面板在 B 被移除/失败/重启后仍在，
 * 是唯一能连续观察 B 行状态的真 UI；C 没有面板，只能从 A 的批量行观察。
 *
 * 四条真机格共用同一套基版/变体声明，差别只在故障注入（延迟代理 / 删 tarball / 队列占用），
 * 这样格与格之间的变量只有故障本身。G5 是能力探测格（官方宿主有 cancelInstall ⇒ 无能力宿主
 * 真机不可造），照 f1 先例记 known-red，不伪造真机结果。
 */
const SETTLEMENT_INSTALL: readonly ScenarioInstallStep[] = [
  { slotKey: 'a', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_A, false) },
  { slotKey: 'b', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_B, false) },
  { slotKey: 'c', version: '0.0.1', effect: targetEffectOf('0.0.1') },
]
/** 超时/失败/重试三格只发布 B（宏按钮只装 B），C 保持 0.0.1 作对照。 */
const SETTLEMENT_VARIANTS: readonly FixtureVariantDeclaration[] = [
  { slotKey: 'b', version: '0.0.2', changeClasses: ['ui', 'behavior', 'metadata'], effect: batchEffectOf(FIXTURE_SLOT_B, true) },
]
/** 取消格只发布 C：B 面板宏安装 C 的慢安装先占住执行锁；A 面板宏安装轮到 C 时被排队门挡下，进 waiting 后可取消。 */
const SETTLEMENT_VARIANTS_QUEUED: readonly FixtureVariantDeclaration[] = [
  { slotKey: 'c', version: '0.0.2', changeClasses: ['behavior', 'metadata'], effect: targetEffectOf('0.0.2') },
]

/** G1 出口二超时格：延迟代理挂住 pnpm 拉包，installTimeoutMs 到点收局。 */
export const SCENARIO_G1_DESKTOP_MANAGER_TIMEOUT: ScenarioDeclaration = {
  id: 'g1-desktop-manager-install-timeout',
  ticket: '268',
  hostChannel: 'desktop-official',
  summary: '出口二超时：延迟代理把 0.0.2 tarball 请求挂住，installTimeoutMs=12s；B 行安装以失败收局，超时人话格与宿主取消能力一致，日志/台账/磁盘自洽，重启后台账仍 failed 且 UI 不谎称更新中/成功',
  install: SETTLEMENT_INSTALL,
  variants: SETTLEMENT_VARIANTS,
  expected: [
    '安装电话先 ok:true 受理（异步）；最终 B 的 job.state=failed、targetVersion=0.0.2',
    'update.install.exec route=desktop-manager ok=false，durationMs 达到安装预算',
    '超时文案与宿主取消能力一致：有 cancelInstall 时不许出现「未提供取消能力」；取消成功/太晚按宿主真实结局记录',
    '磁盘保持 0.0.1（超时不假装成功）',
    '重启后台账仍 failed；UI 不谎称更新中/成功（管理器移除 B 后批量行按磁盘真相显示「未安装/可装 0.0.2」，属 #152 既有语义）',
  ],
}

/**
 * G2 批量取消格（真实语义：丢弃未完成项，不是终止在飞安装）。
 *
 * 真实产品语义（真机实测后修正）：同一个批量会话内部是**串行**的（runBatch 等到一家收尾才推下一家），
 * 所以「宏按钮一次提交两家」不会自然产生 waiting；waiting 只在「已经有别的安装占着执行锁时，
 * 另一个宿主再提交安装」时才出现。真机做法：B 运行时的单插件安装电话（夹具桥）先起 C 的慢安装
 * （queue owner=fxb-c），再在 A 面板点宏安装——轮到 C 时被公平门挡下（stage=gate/code=update-busy），
 * A 会话记 queued。产品唯一的终态取消入口是「丢弃本批未完成的更新」两步确认（confirmCancel）；
 * 行内「取消排队」只撤单次 waiting 占位、中枢 1s 退避还会重推，所以行取消只验证诚实文案，
 * 随后用「丢弃本批」收口。产品没有终止在飞安装的入口（渲染层明说「正在安装的项无法停止」），不谎称终止。
 */
export const SCENARIO_G2_BATCH_QUEUED_CANCEL: ScenarioDeclaration = {
  id: 'g2-batch-queued-cancel',
  ticket: '268',
  hostChannel: 'desktop-official',
  summary: '批量取消：B 运行时的慢安装（C@0.0.2，延迟代理挂 pnpm）先占住全局执行锁；A 面板点宏「全部更新」，轮到 C 时被公平门挡下进等待队列（不开始装）；行「取消排队」回执如实（只撤占位、本批仍会继续、不终止在飞），再用真 UI「丢弃本批」两步确认清掉会话；丢弃后不再排队、C 不被安装、无虚假终态',
  install: SETTLEMENT_INSTALL,
  variants: SETTLEMENT_VARIANTS_QUEUED,
  expected: [
    '前一个慢安装确实占住全局锁（queue.json 的 owner.pluginId=fxb-c，原始证据）；排队窗内它不被误判 interrupted',
    'A 面板宏安装让 C 进等待队列（data-queued=1、出现「取消排队」按钮、queue.json waiting 含 fxa-c 的 requestId）',
    '行取消排队回执诚实：含「已取消排队」+ 本批仍会继续尝试安装，不含「不再等待/已终止/已请求终止」；实测记录中枢重推时间线',
    '真 UI「丢弃本批未完成的更新」两步确认后：A 会话从磁盘清空、后续队列采样不再出现 fxa-c 占位、C 行不排队/不安装',
    'A 的 C 没有安装 exec、没有失败/成功台账、磁盘保持 0.0.1（丢弃既不假装成功也不假装失败，更不谎称终止在飞安装）',
  ],
}

/** G3 已失败不重试格：check 后删 tarball 让安装落定失败，静置观察无第二次尝试，重启后仍 failed。 */
export const SCENARIO_G3_DESKTOP_MANAGER_FAILED_NO_RETRY: ScenarioDeclaration = {
  id: 'g3-desktop-manager-failed-no-retry',
  ticket: '268',
  hostChannel: 'desktop-official',
  summary: '已了结的失败：check 后删 0.0.2 tarball（元数据不动），B 安装落定 failed；静置 ≥15s 无自动重试（exec/fail 计数不增），UI 如实显示失败，重启后台账仍 failed 且不谎称更新中',
  install: SETTLEMENT_INSTALL,
  variants: SETTLEMENT_VARIANTS,
  expected: [
    '失败落定：B 的 job.state=failed、message 以 install-failed 开头；update.install.fail stage=exec',
    '静置 ≥15s 后 update.install.exec / update.install.fail 计数不增，无第二次安装请求（已失败不自动重试）',
    'UI 如实显示失败（稳定码/宿主原话；手工命令按产品真实能力，不伪造 DOM）',
    '磁盘保持 0.0.1',
    '重启后台账仍 failed（重启不改写、不自动重试）；UI 不谎称「更新中」或成功（批量行按磁盘现状投影）',
  ],
}

/** G4 补一次成功格：G3 失败后恢复 registry，再用真 UI 重试，成功终态只留一条。 */
export const SCENARIO_G4_DESKTOP_MANAGER_RETRY_SINGLE_SUCCESS: ScenarioDeclaration = {
  id: 'g4-desktop-manager-retry-single-success',
  ticket: '268',
  hostChannel: 'desktop-official',
  summary: '补一次成功：失败落定后恢复 registry tarball，用 A 面板真 UI 重试安装 B → 成功；重启后台账/历史对 B 恰一条成功终态、无重复成功记录，UI 与磁盘一致',
  install: SETTLEMENT_INSTALL,
  variants: SETTLEMENT_VARIANTS,
  expected: [
    '失败后重试安装成功（产品路径，非手工 CLI），B 的 job.state∈{completed,restart-required}、targetVersion=0.0.2',
    '台账/历史对 B 恰一条成功终态，没有第二条成功记录（失败记录可作为历史保留，但不得冒充成功）',
    '重启后 A 面板 B 行显示已更新，磁盘 dependencies/包内版本都是 0.0.2',
    '成功终态只有一个，目击证据要能排除「旧状态未刷新」/「重复成功」两种假象',
  ],
}

/** G5 能力探测格：官方桌面宿主是否提供取消能力 + 无能力措辞的库内证据。 */
export const SCENARIO_G5_DESKTOP_MANAGER_NO_CANCEL_PROBE: ScenarioDeclaration = {
  id: 'g5-desktop-manager-no-cancel-probe',
  ticket: '268',
  hostChannel: 'desktop-official',
  summary: '能力探测：官方桌面 0.2.1-rc.5 的 pluginManager 有 cancelInstall（运行时/asar 原始探测），「无终止能力」宿主真机不可造；库内无 cancel 措辞测试作 L0 证据，真机无能力断言记 known-red',
  install: SETTLEMENT_INSTALL,
  variants: [],
  expected: [
    '官方宿主 pluginManager 的 cancelInstall 能力有原始探测证据（运行时回包/asar 二进制命中）',
    '无取消能力时的诚实措辞由库内定向测试（tests/issue-184-timeout-honesty.test.mjs）原始输出钉住',
    '真机「无 cancel 宿主」断言记 known-red，写明可复现条件（换无 cancelInstall 的宿主版本），不伪造真机结果',
  ],
}

/**
 * T5（#269）组 E：三包批量更新 / 部分失败隔离 / 重试续跑。
 *
 * 拓扑沿用 b（同一个 profile：A/B 两个批量集成方 + C 纯目标），差别在验收面：
 *   - 三包**全部**被批量更新（A 自己也在批量范围内），UI/台账/磁盘/重启四处一致；
 *   - 部分失败隔离：只把 B@0.0.2 的 tarball 字节改坏（元数据/integrity 一字不动 ⇒ check 能过、
 *     install 必因 pnpm integrity 校验失败），A/C 照常完成；
 *   - 恢复后重试/续跑：A/C 不重复安装、B 恰一次成功、总账三条成功无重复/丢行。
 * 三条声明共用同一套基版/变体（唯一变量是故障注入与重试步骤）；can-red 复用 upgrade 声明
 * （stale-variant C：版本号新、内容旧，成功诚实性断言应真红）。
 */
const EBATCH_INSTALL: readonly ScenarioInstallStep[] = [
  { slotKey: 'a', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_A, false) },
  { slotKey: 'b', version: '0.0.1', effect: batchEffectOf(FIXTURE_SLOT_B, false) },
  { slotKey: 'c', version: '0.0.1', effect: targetEffectOf('0.0.1') },
]
/** 三包都更新到 0.0.2：A/B 走批量变体效果（新版 UI + 中枢坞 + host behavior），C 走目标效果。 */
const EBATCH_VARIANTS: readonly FixtureVariantDeclaration[] = [
  { slotKey: 'a', version: '0.0.2', changeClasses: ['ui', 'behavior', 'metadata'], effect: batchEffectOf(FIXTURE_SLOT_A, true) },
  { slotKey: 'b', version: '0.0.2', changeClasses: ['ui', 'behavior', 'metadata'], effect: batchEffectOf(FIXTURE_SLOT_B, true) },
  { slotKey: 'c', version: '0.0.2', changeClasses: ['behavior', 'metadata'], effect: targetEffectOf('0.0.2') },
]

/** E1 三包全成：A 面板真 UI 检查 → 宏「全部更新」→ A/B/C 全部 0.0.2，UI/台账/磁盘/重启一致。 */
export const SCENARIO_E_BATCH_THREE_PACKAGE_UPGRADE: ScenarioDeclaration = {
  id: 'e-batch-three-package-upgrade',
  ticket: '269',
  hostChannel: 'desktop-official',
  summary: '三包批量全成：A/B/C@0.0.1 同 profile，A 面板真 UI「检查更新」后宏「全部更新」，三包都被推到 0.0.2；面板三行、三个台账、磁盘三处、重启后三卡片一致，无全批假成功',
  install: EBATCH_INSTALL,
  variants: EBATCH_VARIANTS,
  expected: [
    'A 面板「检查更新」后三行都显示可更新 0.0.2（0.0.1→0.0.2）',
    '真 UI 宏「全部更新」后 A/B/C 三包都到 0.0.2：磁盘 dependencies/包内版本、台账、UI 行三处一致',
    '台账逐行真相：三个插件各恰一条成功终态（state∈{completed,restart-required}、target 0.0.2、previous 0.0.1），无失败/无丢行',
    '重启后三卡片 buildTag=新版（client/host v0.0.2）、A 批量面板三行 current，无假成功',
    '批量账本按属主 fxa 记三键；日志 install.request 覆盖 a/b/c，无意外失败',
  ],
}

/** E2 部分失败隔离：只改坏 B 的 tarball 字节（元数据不动），A/C 完成、B 失败、无全批假成功。 */
export const SCENARIO_E_BATCH_PARTIAL_FAILURE: ScenarioDeclaration = {
  id: 'e-batch-partial-failure',
  ticket: '269',
  hostChannel: 'desktop-official',
  summary: '部分失败隔离：B@0.0.2 tarball 字节被改坏（元数据/integrity 不动，check 能过），宏批量后 A/C 照常完成 0.0.2、B 落定 install-failed；台账逐行真相、UI 如实、重启后按磁盘真相投影，坏行不拖垮好行',
  install: EBATCH_INSTALL,
  variants: EBATCH_VARIANTS,
  expected: [
    'B@0.0.2 tarball 字节被改坏但元数据/integrity 一字不动：check 仍列出 0.0.2（候选门能过），改坏前后 tarball 都是 200 且大小不变',
    '宏批量后 A/C 到 0.0.2、B 落定失败；坏行失败不拖垮好行（无全批假成功）',
    '台账逐行真相：fxa-b 恰一条 failed（install-failed），fxa-a/fxa-c 成功；磁盘 B 未到 0.0.2',
    'UI 行如实显示失败（不谎称更新中/成功），重启后台账仍 failed、UI 按磁盘真相投影',
    '日志 B 恰一次 exec 失败且无自动重试，A/C 无 exec 失败',
  ],
}

/** E3 恢复后重试/续跑：恢复 B tarball → 真 UI 重试 → B 成功；A/C 不重复、B 恰一次成功、总账三条无重复/丢行。 */
export const SCENARIO_E_BATCH_RESUME_RETRY: ScenarioDeclaration = {
  id: 'e-batch-resume-retry',
  ticket: '269',
  hostChannel: 'desktop-official',
  summary: '重试/续跑：部分失败后恢复 B@0.0.2 tarball（字节哈希复原、元数据不变），用 A 面板真 UI 重试 B；A/C 不重复安装、B 恰一次成功、总账三条成功无重复无丢行，重启后 UI/台账/磁盘一致',
  install: EBATCH_INSTALL,
  variants: EBATCH_VARIANTS,
  expected: [
    '恢复 B@0.0.2 tarball：GET 200、字节哈希复原、版本文档不变',
    '真 UI 重试后 B 到 0.0.2，B 恰一次成功（失败一次 + 重试成功一次，成功终态只有一条）',
    'A/C 不重复安装：重试前后 A/C 的安装请求/执行日志计数不变，台账各仍恰一条成功',
    '总账 3 条成功、无重复无丢行：三个插件各恰一条成功终态，target 0.0.2',
    '重启后三包 0.0.2、三卡片新版、行 current，UI/台账/磁盘一致',
  ],
}

/**
 * T6 / #270（F 组：队列与锁）：两个独立 DSH web 宿主进程共享同一 home + 同一 profile，
 * 两个入口（各自宿主里的电话入口）同时更新同一个 target —— 真跨进程抢同一把
 * <home>/update-queue/<profileDir 短哈希>/global.lock，并用 queue.json 观测排队/释放。
 *
 * 场景 id 用 h 前缀：矩阵里的 f1 已被 267 的 f1-third-party-desktop-probe 占用，
 * f2 也被历史票用掉，f1/f2 复名会撞矩阵行（fixture-package-plan.test 反向校验），
 * 故本票用 h1/h2（h = #270 的 F 组；研究笔记里写明理由）。
 * 三条声明共用同一套基版/变体（唯一变量是「两个入口的触发时序」与锁/队列观测）：h1 = 入口 1 先受理、
 * 锁出现后入口 2 立刻发（锁窗内到达）；h1b = 两入口几乎同一刻（Promise.all）发；h2 = 陈旧锁回收。
 * can-red 复用 h1（同一场景、同一组断言被破坏）。
 */
const QUEUE_LOCK_INSTALL: readonly ScenarioInstallStep[] = [
  { slotKey: 'a', version: '0.0.1', effect: legacySingleEffectOf('0.0.1') },
]
const QUEUE_LOCK_VARIANTS: readonly FixtureVariantDeclaration[] = [
  { slotKey: 'a', version: '0.0.2', changeClasses: ['ui', 'metadata'], effect: legacySingleEffectOf('0.0.2') },
]

/** H1 顺序抢锁：入口 1 先受理进入安装，锁窗内（global.lock 出现后）入口 2 立刻对同一 target 发安装电话。 */
export const SCENARIO_H1_QUEUE_LOCK_CONCURRENT: ScenarioDeclaration = {
  id: 'h1-queue-lock-concurrent',
  ticket: '270',
  hostChannel: 'dsh-web',
  summary:
    '两个独立 DSH web 宿主进程共享同一 home+profile（各自有电话入口）：入口 1 先受理安装、' +
    '轮询到 global.lock 出现后入口 2 在锁窗内对同一 target=A@0.0.2 发 updateInstall —— 恰一个 exec 真跑、' +
    '另一个被 update-busy 稳定拒绝，两安装窗不重叠、profile 不损坏、台账恰一条成功终态、失败方重试收敛，' +
    '队列 owner 任意时刻至多一个',
  install: QUEUE_LOCK_INSTALL,
  variants: QUEUE_LOCK_VARIANTS,
  expected: [
    '两个独立宿主进程解析到同一 profileDir，因而抢同一 <home>/update-queue/<shortHash(profileDir)>/global.lock（跨进程真锁竞争）',
    '恰一个 update.install.exec 真跑（route=cli-process、ok=true、exitCode=0）；两入口的安装窗不重叠（任一时刻至多一个 pnpm 安装）',
    '另一入口得到稳定拒绝/排队（update-busy；日志有 lock.anomaly busy-owner 或 fair-gate gate-refused），不得两个都跑',
    'profile 未损坏：package.json 可解析无半写、dependencies/node_modules=0.0.2 无双装；台账恰一条成功终态（target 0.0.2/previous 0.0.1）',
    '失败方重试收敛：fresh check 报已是最新；同名意图重试诚实拒绝且不产生第二次安装；期间队列 owner 任意时刻至多一个，收尾 owner=null（未消费的失败占位按 30s TTL 如实记录，不要求 waiting=[]）',
  ],
}

/** H1b 同时刻抢锁：两入口几乎同一刻（Promise.all、不 await 完成）对同一 target 发安装电话。 */
export const SCENARIO_H1B_QUEUE_LOCK_SIMULTANEOUS: ScenarioDeclaration = {
  id: 'h1b-queue-lock-simultaneous',
  ticket: '270',
  hostChannel: 'dsh-web',
  summary:
    '两个独立 DSH web 宿主进程共享同一 home+profile（各自有电话入口），几乎同一刻（Promise.all、不 await 完成）' +
    '对同一 target=A@0.0.2 各发一次 updateInstall：恰一个 exec 真跑、另一个被 update-busy 稳定拒绝，' +
    '两安装窗不重叠、profile 不损坏、台账恰一条成功终态、失败方重试收敛，队列 owner 任意时刻至多一个',
  install: QUEUE_LOCK_INSTALL,
  variants: QUEUE_LOCK_VARIANTS,
  expected: [
    '两个独立宿主进程解析到同一 profileDir，因而抢同一 <home>/update-queue/<shortHash(profileDir)>/global.lock（跨进程真锁竞争）',
    '同一时刻两入口都发出安装电话时恰一个 update.install.exec 真跑（route=cli-process、ok=true、exitCode=0）；两安装窗不重叠',
    '另一入口得到稳定拒绝/排队（update-busy；日志有 lock.anomaly busy-owner 或公平门 gate-refused），不得两个都跑',
    'profile 未损坏：package.json 可解析无半写、dependencies/node_modules=0.0.2 无双装；台账恰一条成功终态（target 0.0.2/previous 0.0.1）',
    '失败方重试收敛：fresh check 报已是最新；同名意图重试诚实拒绝且不产生第二次安装；期间队列 owner 任意时刻至多一个，收尾 owner=null（未消费的失败占位按 30s TTL 如实记录，不要求 waiting=[]）',
  ],
}

/** H2 陈旧锁回收：预写 pid 已死/startedAt 过期的 global.lock，触发更新看二阶核对后的回收与继续安装。 */
export const SCENARIO_H2_QUEUE_LOCK_STALE_RECLAIM: ScenarioDeclaration = {
  id: 'h2-queue-lock-stale-reclaim',
  ticket: '270',
  hostChannel: 'dsh-web',
  summary:
    '预写陈旧 global.lock（pid 已死、startedAt 60s 前）并把宿主安装预算压到 4s，再触发 A@0.0.2 更新：' +
    '抢锁路径经二次核对判定陈旧锁 → lock.anomaly(stale-owner) + queue.transition(reclaimed) → 继续安装成功，' +
    '锁最终释放、队列收尾干净，无 busy-owner 误判',
  install: QUEUE_LOCK_INSTALL,
  variants: QUEUE_LOCK_VARIANTS,
  expected: [
    '预写锁 payload 为 {id,pluginId,pid:死 pid,startedAt:60s 前}，旧 pid 真机核实已不存在；宿主安装预算=4000ms',
    '恰 1 条 update.lock.anomaly(kind=stale-owner)：ageMs≥60000、ownerHash 为 8 位十六进制；无 busy-owner（新鲜误判）',
    '恰 1 条 update.queue.transition(phase=reclaimed)（holderHash 8 位十六进制）后安装继续，无 reclaim 失败/重复回收',
    '安装成功：exec route=cli-process ok/exit0；磁盘 dependencies 与 node_modules=0.0.2；台账恰一条 completed/restart-required',
    '锁时间线：陈旧锁 id 不会被旧 id 释放，新锁 id 覆盖后最终释放（末次 absent）；queue.json 收尾 owner=null/waiting=[]',
  ],
}

/**
 * T7 / #271（G 组：更新中枢不断链）：通道 B（web 宿主）上同一 profile 的三包批量更新中，
 * A（批量发起者/中枢属主）自身先被替换——第一代宿主进程在 A 安装完成、B/C 尚未终态时被杀，
 * 第二代宿主以同一 home/profile 重新加载，从盘上的 hub plan / batch session 恢复并继续推进。
 *
 * 入口选择：web 宿主没有「应用自重启」，所以换手注入=杀第一代 + 起第二代（同 home/profile/版本），
 * 与官方桌面 relaunch 的等价性与差别写进研究笔记；断言只看「A 换了之后 B/C 是否无需人工继续完成」。
 * can-red 复用 g6（换手窗口删 hub plan 使中枢无方案可接管）。
 */
/** G6 换手主格：A 自更新后第一代宿主被杀，第二代接管把 B/C 推完（无需人工续跑）。 */
export const SCENARIO_G6_HUB_SELF_REPLACEMENT: ScenarioDeclaration = {
  id: 'g6-hub-survives-self-replacement',
  ticket: '271',
  hostChannel: 'dsh-web',
  summary:
    '三包批量（A 自键排第一）在通道 B web 宿主上推进：A@0.0.2 装完、B/C 未终态时第一代宿主进程被杀，' +
    '第二代宿主同 home+profile 启动——从盘上的 hub plan / batch session 恢复，B/C 无需人工续跑自动完成 0.0.2；' +
    'batch 三行终态无 failed、hubStatus finished done3 failed0、台账三条成功、磁盘三包一致、租约始终单一属主',
  install: EBATCH_INSTALL,
  variants: EBATCH_VARIANTS,
  expected: [
    '基版 A/B/C@0.0.1 在盘；批量检查电话三行都列出可更新 0.0.2（A 自键排在第一位，先换 A）',
    '换手窗口成立：A 行已 done、B/C 尚未终态时第一代宿主进程被杀；hub lease/plan 与 batch.json 原文留证',
    'B/C 无需人工续跑即自动完成：第二代宿主启动后场景只发只读查询，B/C 的 update.install.exec 时间戳都晚于第二代 host.start',
    'batch 三行终态全 done、failed=0；hubStatus state=finished、progress done3 failed0、activeInstall=null；plan 仍是同一 sessionId',
    '台账三包各恰一条成功终态（completed/restart-required、target 0.0.2、previous 0.0.1），磁盘三包 0.0.2；收尾无进程/端口残留',
  ],
}

/** G7 页面重开恢复：换手完成后再关宿主、重新打开，面板数据与台账/磁盘一致，刷新不是断线或假绿。 */
export const SCENARIO_G7_HUB_HANDOFF_EVIDENCE: ScenarioDeclaration = {
  id: 'g7-hub-handoff-evidence',
  ticket: '271',
  hostChannel: 'dsh-web',
  summary:
    'g1 换手完成后关闭第二代宿主、以同一 home+profile 重新起宿主（= 关页面再重开），重新取面板批量状态/中枢状态/' +
    'A 自身状态：三行 current/done、中枢 finished done3 failed0、无进行中/失败残留；同一会话内再取一次（刷新）结果一致；' +
    '面板数据与台账、磁盘三包一致，不是断线或假绿',
  install: EBATCH_INSTALL,
  variants: EBATCH_VARIANTS,
  expected: [
    'g1 换手后 batch 三行 done、failed=0；台账三条成功；磁盘三包 0.0.2',
    '关闭第二代宿主、同 home+profile 重新打开：面板批量状态三行仍 done、progress finished、failed=0，无 installing/queued 残留',
    '面板中枢状态 state=finished、done3 failed0、activeInstall=null；plan 同一 sessionId 仍在盘上',
    'A 自身状态回包 installedVersion/runningVersion=0.0.2、canInstall=false；同一会话再取一次（刷新）面板数据与首次一致',
    '面板数据与台账/磁盘一致：台账仍三条成功（无重复无丢行）、磁盘三包 0.0.2；收尾无进程/端口残留',
  ],
}

/** 全部场景声明（矩阵行 id 一一对应）。 */
export const SCENARIOS: readonly ScenarioDeclaration[] = [
  SCENARIO_A_SINGLE_PACKAGE,
  SCENARIO_B_BATCH_TWO_INTEGRATORS,
  SCENARIO_C_PURE_TARGET,
  SCENARIO_D1_DESKTOP_MANAGER_SUCCESS,
  SCENARIO_D2_DESKTOP_MANAGER_FAILURE,
  SCENARIO_E1_CLI_HOST_SUCCESS,
  SCENARIO_E2_CLI_HOST_FAILURE,
  SCENARIO_E3_CLI_HOST_TIMEOUT,
  SCENARIO_F1_THIRD_PARTY_DESKTOP_PROBE,
  SCENARIO_G1_DESKTOP_MANAGER_TIMEOUT,
  SCENARIO_G2_BATCH_QUEUED_CANCEL,
  SCENARIO_G3_DESKTOP_MANAGER_FAILED_NO_RETRY,
  SCENARIO_G4_DESKTOP_MANAGER_RETRY_SINGLE_SUCCESS,
  SCENARIO_G5_DESKTOP_MANAGER_NO_CANCEL_PROBE,
  SCENARIO_E_BATCH_THREE_PACKAGE_UPGRADE,
  SCENARIO_E_BATCH_PARTIAL_FAILURE,
  SCENARIO_E_BATCH_RESUME_RETRY,
  SCENARIO_H1_QUEUE_LOCK_CONCURRENT,
  SCENARIO_H1B_QUEUE_LOCK_SIMULTANEOUS,
  SCENARIO_H2_QUEUE_LOCK_STALE_RECLAIM,
  SCENARIO_G6_HUB_SELF_REPLACEMENT,
  SCENARIO_G7_HUB_HANDOFF_EVIDENCE,
]

/** 按 id 取场景（未知 id 立刻抛，避免证据跑错场景却记为另一个）。 */
export function scenarioOf(id: string): ScenarioDeclaration {
  const found = SCENARIOS.find((scenario) => scenario.id === id)
  if (!found) throw new Error('[fixtures] 未知场景 id：' + JSON.stringify(id) + '（允许 ' + SCENARIOS.map((scenario) => scenario.id).join('/') + '）')
  return found
}

/** 场景的预装席位（去重、保持声明顺序；场景 runner 用它决定 CLI 装哪几个包）。 */
export function installSlotsOf(scenario: ScenarioDeclaration): FixtureSlot[] {
  const keys: FixtureSlotKey[] = []
  for (const step of scenario.install) if (keys.indexOf(step.slotKey) < 0) keys.push(step.slotKey)
  return keys.map((key) => fixtureSlotOf(key))
}
