/**
 * selftest/fixtures/identity/scenario-declarations-boundary-gaps.ts —— B 组：用户可感知边界缺口声明（#284）
 *
 * owner：t4-implementer（票 #284，规格 #263 收口补充）。写入边界：只改本文件、本组场景文件与 runner；
 * 不改其他组的声明模块，不改 coverage-matrix / runs/README / known-red 等共享账本（由 Lead 串行落账），
 * 不改 src/ 产品代码（只有真 BUG 才允许修，且必须在报告里单独列出）。
 *
 * 五个场景全部走通道 B（普通 DSH web 宿主 + Playwright 真页面），用「base 库真机 + 外部手段」制造边界态：
 *   - 同一宿主进程里两个集成方并发安装 → 串行/忙碌诚实 + exactly-once；
 *   - 杀掉本 run 私有 verdaccio → registry 整体不可达的失败诚实性，恢复后重试成功；
 *   - 用 icacls 拒绝写本 run 隔离 profile 里的目标包目录 → 权限不足的失败诚实性，恢复后重试成功；
 *   - 延迟代理拉长安装窗，安装中关页面 → 页面生命周期不影响宿主侧真相；
 *   - 安装中 taskkill 本 run 宿主 → 重启后的残留锁态度与短阈值下的陈旧锁回收。
 *
 * 场景 id（必须与 coverage-matrix 行 id、evidence run.json 的 scenarioId 一致）：
 *   L1 l1-same-process-two-plugins-concurrent
 *   L2 l2-registry-unreachable
 *   L3 l3-permission-denied
 *   L4 l4-page-close-mid-install
 *   L5 l5-host-killed-mid-install-recovery
 */
import type { FixtureVariantDeclaration, ScenarioDeclaration, ScenarioInstallStep } from './scenario-declarations.ts'
import { legacySingleEffectOf } from './scenario-declarations.ts'

/** 单包 A：基版 0.0.1 在装，变体 0.0.2 待装（L2-L5 共用）。 */
const L_A_INSTALL: readonly ScenarioInstallStep[] = [{ slotKey: 'a', version: '0.0.1', effect: legacySingleEffectOf('0.0.1') }]
const L_A_VARIANTS: readonly FixtureVariantDeclaration[] = [
  { slotKey: 'a', version: '0.0.2', changeClasses: ['ui', 'metadata'], effect: legacySingleEffectOf('0.0.2') },
]

/** 两个集成方同进程：A、B 各自 0.0.1 在装，各自 0.0.2 待装（L1）。 */
const L_AB_INSTALL: readonly ScenarioInstallStep[] = [
  { slotKey: 'a', version: '0.0.1', effect: legacySingleEffectOf('0.0.1') },
  { slotKey: 'b', version: '0.0.1', effect: legacySingleEffectOf('0.0.1') },
]
const L_AB_VARIANTS: readonly FixtureVariantDeclaration[] = [
  { slotKey: 'a', version: '0.0.2', changeClasses: ['ui', 'metadata'], effect: legacySingleEffectOf('0.0.2') },
  { slotKey: 'b', version: '0.0.2', changeClasses: ['ui', 'metadata'], effect: legacySingleEffectOf('0.0.2') },
]

/** L1：同一宿主进程里 A、B 两个面板几乎同一刻点安装（同进程两插件并发）。 */
export const SCENARIO_L1_SAME_PROCESS_CONCURRENT: ScenarioDeclaration = {
  id: 'l1-same-process-two-plugins-concurrent',
  ticket: '284',
  hostChannel: 'dsh-web',
  summary:
    '通道 B 真页面：同一 DSH web 宿主进程里装 A、B 两个集成方（各 0.0.1），发布 A/B 0.0.2 后在同一页面两个单包面板上' +
    '几乎同一刻（同一 evaluate tick）点安装——断言安装串行落定或后到者诚实忙碌/排队（不谎称已更新），' +
    '两包各恰一次成功、安装窗不重叠、无跨目标污染；失败方重试可完成；磁盘/台账/UI 三面一致，重启后不回退',
  install: L_AB_INSTALL,
  variants: L_AB_VARIANTS,
  expected: [
    '同一宿主进程里两个面板都完成检查：A 面板、B 面板各自列出 0.0.2 可更新（两点击原始时刻与事件时间线入 raw）',
    '同时点安装后不得两个安装同时跑：恰一个 update.install.exec ok=true 先跑，另一个得到诚实忙碌/排队（update.install.fail stage=gate reason=gate-refused code=update-busy 或 lock.anomaly busy-owner），不谎称已更新',
    '后到者重试可完成（或产品自动续跑）：最终 A、B 磁盘都 0.0.2、两包各恰一次成功 exec、安装窗不重叠（exec 起止时间无交集），无跨目标污染（A 的作业不碰 B/C，反之亦然）',
    '台账两包各恰一条成功终态（target 0.0.2/previous 0.0.1），无重复成功、无第二条 0.0.2 记录；profile 清单可解析无半写',
    'UI 与磁盘/台账一致：两面板终态「已是最新」，无永远更新中/无假最新；重启宿主后仍一致',
  ],
}

/** L2：registry 整体不可达（杀本 run 私有 verdaccio）→ 失败诚实、无假成功；恢复后重试成功。 */
export const SCENARIO_L2_REGISTRY_UNREACHABLE: ScenarioDeclaration = {
  id: 'l2-registry-unreachable',
  ticket: '284',
  hostChannel: 'dsh-web',
  summary:
    '通道 B 真页面：A@0.0.1 在装、检查到 A@0.0.2 后杀掉本 run 私有 verdaccio（外部手段，registry 整体不可达），' +
    '真 UI 点安装 → 失败诚实（exec ok=false、台账 failed、detail 含真实网络错误原话、无重试风暴、无假更新/假最新）；' +
    '同 storage/同端口重启 verdaccio 后重试 → 真装成 0.0.2、台账恰一条成功终态、重启宿主后如实展示',
  install: L_A_INSTALL,
  variants: L_A_VARIANTS,
  expected: [
    // 按真机验收（预期未命中→按真实现象验收）：registry 在候选门复核版本文档时不可达，产品在 stage=gate 就拒绝，不进入 exec、不落台账。
    '检查完成后杀掉本 run 私有 verdaccio（杀进程命令/PID/前后 ping 与端口状态入 raw）：真 UI 点安装 → 候选门复核版本时失败诚实（面板 failed 面标题「更新失败（check-failed）：版本信息查询失败（网络 / 数据源 / 限流）。」、副文案「稍后重新查询；若持续，请提交诊断信息至插件作者」；update.install.fail stage=gate reason=gate-refused code=check-failed；exec 计数=0、台账无 state.json），detail 含真实网络原话/网络类文案，不是空泛未知错误',
    '无重试风暴：失败后静置窗口内 update.install.request / update.install.fail 计数不再增长（恰 1 次 request、1 次 fail、0 次 exec），无第二条台账记录、无第二条安装尝试',
    '无假成功：安装失败后磁盘仍 0.0.1、台账无 completed/无任何 state.json、面板不出现「已是最新」/更新成功，人话格不出现载体命令（dsh plugin … add --save-exact）',
    '#267 诚实面：registry/网络类失败不出现「载体命令」手工修复区（或出现时文案明确标注适用性、不谎称可修复）；与 src/shared/commands.ts 的生成条件一致',
    '同 storage/同端口重启 registry 后重试：真 UI 检查仍列出 0.0.2 → 点安装 → 真装成 0.0.2（exec ok=true exitCode=0），台账恰一条成功终态（completed，target=0.0.2、previous=0.0.1）',
    '重启宿主后如实展示：面板「已是最新，无需更新。」、磁盘 0.0.2、运行构建 tags=0.0.2、台账仍恰一条成功（无重复成功记录），页面无失败残留谎报',
  ],
}

/** L3：安装目录 ACL 拒绝写 → 权限不足的失败诚实；恢复 ACL 后重试成功。 */
export const SCENARIO_L3_PERMISSION_DENIED: ScenarioDeclaration = {
  id: 'l3-permission-denied',
  ticket: '284',
  hostChannel: 'dsh-web',
  summary:
    '通道 B 真页面：A@0.0.1 在装、检查到 0.0.2 后，用 icacls 对本 run 隔离 profile 里目标包目录加拒绝写/删 ACE（外部手段；' +
    '若提权可绕过则改用等价外部只读/独占手段并如实记录），真 UI 点安装 → 失败诚实（detail 含 EPERM/EACCES/access denied 类原话）、' +
    '无假成功、台账 failed 真实；finally 恢复 ACL 并复核，恢复后重试装成 0.0.2、台账恰一条成功终态',
  install: L_A_INSTALL,
  variants: L_A_VARIANTS,
  expected: [
    '安装前注入：icacls 对 run 隔离 profile 内目标包目录加拒绝写/删 ACE；whoami /groups 与 icacls 注入前后原文入 raw（提权可绕过则改用等价外部手段，如实记录并证明是「写不进去」类错误）',
    '真 UI 点安装 → 失败诚实：exec ok=false、台账 failed、detail 含权限类原话（EPERM/EACCES/access denied），stage 合理（exec/verify），不是空泛未知错误',
    '无假成功：磁盘仍 0.0.1、无 completed 台账、面板不出现已是最新/更新成功；无自动重试（exec 计数恰 1）',
    '恢复 ACL（icacls 移除拒绝项并复核输出）后重试装成 0.0.2：exec ok=true、台账恰一条成功终态、磁盘与面板一致',
    '原始证据：ACL 注入/恢复原文、失败面板 DOM、日志失败行、台账/磁盘快照、恢复后重试结果；finally 清理确认',
  ],
}

/** L4：安装中关页面再打开 → 宿主侧真相不被页面生命周期左右。 */
export const SCENARIO_L4_PAGE_CLOSE_MID_INSTALL: ScenarioDeclaration = {
  id: 'l4-page-close-mid-install',
  ticket: '284',
  hostChannel: 'dsh-web',
  summary:
    '通道 B 真页面：延迟代理拉长安装窗，真 UI 点安装后在安装进行中关闭页面/浏览器上下文，宿主侧继续完成（只看磁盘/台账/日志），' +
    '再重开页面与重启宿主：断言安装不受页面关闭影响、最终真装成 0.0.2、台账/磁盘/UI 一致、exactly-once（无重复作业、无永远更新中）',
  install: L_A_INSTALL,
  variants: L_A_VARIANTS,
  expected: [
    '慢 registry（延迟代理）拉长安装窗：真 UI 点安装并在安装窗内关闭页面/浏览器上下文（点击/关闭时刻与已观测在飞事实入 raw）',
    '页面关闭不影响宿主侧安装：不看页面轮询到磁盘 0.0.2、台账恰一条成功终态、exec 恰 1 条 ok=true，安装完成时刻晚于关闭时刻',
    'exactly-once：关闭/重开期间不产生第二次安装请求（update.install.request/exec 各恰 1 次），无重复台账',
    '重开页面后与真相一致：面板终态「已是最新」、版本条 0.0.2、无永远更新中；重启宿主后 buildTag/clientTag=0.0.2 且台账仍一条成功',
    '原始证据：点击时刻、页面关闭时刻、宿主完成时刻（磁盘/台账/日志）、重开后面板 DOM 原文、重启后原文',
  ],
}

/** L5：安装中硬杀宿主 → 重启后的状态诚实、锁窗口行为与文案。 */
export const SCENARIO_L5_HOST_KILLED_MID_INSTALL: ScenarioDeclaration = {
  id: 'l5-host-killed-mid-install-recovery',
  ticket: '284',
  hostChannel: 'dsh-web',
  summary:
    '通道 B 真页面：慢安装窗内真 UI 点安装 → taskkill /T /F 只杀本 run web 宿主 → 同 home/profile 重启：' +
    'a) 默认超时下对残留锁态度诚实（update-busy/待恢复类文案+原因，绝不假称完成/最新，台账无假 completed）；' +
    'b) 短阈值格（DSH_SELFTEST_INSTALL_TIMEOUT_MS 压到 8-10s）杀宿主→等过阈值→重启→重试安装，陈旧锁被回收、' +
    '恰一次成功安装（无双重安装证据），台账/磁盘/UI 一致',
  install: L_A_INSTALL,
  variants: L_A_VARIANTS,
  expected: [
    '慢安装窗内真 UI 点安装 → taskkill /T /F 只杀本 run web 宿主 PID（PID/时刻/进程树入 raw），同 home+profile 重启',
    'a) 默认超时格：重启后对残留锁/队列态度诚实——呈现 update-busy/待恢复/已中断类文案与原因，绝不假称完成或最新；台账无假 completed（残留 lock 文件原文、mtime/pid/startedAt 入 raw）',
    'b) 短阈值格（DSH_SELFTEST_INSTALL_TIMEOUT_MS 压到 8-10s）：杀宿主→等过阈值→重启→重试安装，陈旧锁被回收（lock.anomaly stale-owner/queue.transition reclaimed），恰一次成功安装（无双重安装证据）',
    '两格收尾 UI/台账/磁盘一致：最终磁盘 0.0.2、台账恰一条成功终态、面板「已是最新」；无假完成、无重复成功记录',
    '原始证据：被杀 PID 与时刻、锁文件前后副本（mtime/pid/startedAt）、lock/queue 事件时间线、重启后面板与台账原文',
  ],
}

export const BOUNDARY_GAP_SCENARIOS: readonly ScenarioDeclaration[] = [
  SCENARIO_L1_SAME_PROCESS_CONCURRENT,
  SCENARIO_L2_REGISTRY_UNREACHABLE,
  SCENARIO_L3_PERMISSION_DENIED,
  SCENARIO_L4_PAGE_CLOSE_MID_INSTALL,
  SCENARIO_L5_HOST_KILLED_MID_INSTALL,
]
