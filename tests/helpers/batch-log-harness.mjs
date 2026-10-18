/**
 * tests/helpers/batch-log-harness.mjs —— 批量日志测试共用的小件（#124 / #208 / #209）。
 *
 * 从 tests/batch-log.test.mjs 与 tests/batch-session.test.mjs 里抽出来的一份：
 *   - 落点收集：SILENT / bind / unbindAll / collector / rowsOf
 *   - 假传输与目标：fakeTransport / mkTarget / mkScope / phaseOf
 *   - 真路径假读侧与队列种子：installOverrides / seedQueue（批量日志与冒烟脚本共用）
 *
 * 只依赖 Node 内置 + dist 公共入口（落点路由与队列路径），不 import src/：
 * 测试与 scripts/log-smoke.mjs 拿到的行为与直接用 dist 一致。
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { updateLogRouter } from '../../dist/log/router.js'
import { queuePathsForUpdate } from '../../dist/store.js'

/** 构造期用的静默落点：真正要断言的落点在构造之后再按插件标识绑上。 */
export const SILENT = { fire: () => {} }

/** 本进程绑过的插件标识，收尾逐个解绑（路由表是进程级的，别漏给同进程的其它文件）。 */
const bound = []

/** 给某个插件标识绑一个落点（收尾用 unbindAll() 统一解绑）。 */
export function bind(pluginId, sink) {
  updateLogRouter.bind(pluginId, sink)
  bound.push(pluginId)
}

/** 解绑本进程绑过的所有插件标识（afterEach 用：路由表是进程级的）。 */
export function unbindAll() {
  while (bound.length > 0) updateLogRouter.unbind(bound.pop())
}

/** 一份行收集器：写下来的就是发射口真发出去、路由真送到的那些行。 */
export function collector() {
  const rows = []
  return { rows, sink: { fire: (level, event, fields) => rows.push({ level, event, fields }) } }
}

/** 按事件名过滤一个收集器里的行。 */
export function rowsOf(store, event) {
  return store.rows.filter((row) => row.event === event)
}

/** 假传输：按目标键给读数，顺带把每次调用报给 onCall（假时钟靠它走）。 */
export function fakeTransport(script, onCall) {
  return {
    check: async (key) => {
      onCall?.()
      return script[key]?.check ?? { kind: 'current' }
    },
    install: async (key) => {
      onCall?.()
      return script[key]?.install ?? { kind: 'done', restartRequired: false }
    },
  }
}

/** 一个批量目标：键是会话内稳定键，tag 只用来拼包名/前缀/插件标识（键可能是路径，不能当标识）。 */
export function mkTarget(key, tag = key) {
  return { key, title: key, packageName: 'pkg-' + tag, prefix: 'p-' + tag, pluginId: 'plugin-' + tag }
}

/** 真临时目录当使用范围：会话账本落这儿，不碰真机家目录。 */
export async function mkScope(prefix = 'batch-log-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return { dir, scope: { homeDir: dir, profileDir: dir } }
}

/** 会话账本里某一家当前的相位（没有这家即 null）。 */
export function phaseOf(session, key) {
  return session.entries.find((entry) => entry.key === key)?.phase ?? null
}

/**
 * 真路径假读侧：让一家真走到装（真查、真提交、真等收尾）。
 * `runInstall` 决定「装」的结局：挂起 = 等收尾超时；抛错 = 装到终态才失败。
 */
export function installOverrides(dir, targetName, runInstall) {
  const registry = 'https://registry.npmjs.org/'
  let installed = '1.0.0'
  let job = null
  let clock = 1000000
  return {
    runningVersion: '1.0.0',
    profileDir: dir,
    homeDir: dir,
    profileName: 'web',
    environmentKind: 'cli',
    nodeVersion: '22.0.0',
    targetPackageName: targetName,
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          name: targetName,
          version: '2.0.0',
          engines: { node: '>=22' },
          dist: {
            tarball: registry + targetName + '/-/' + targetName + '-2.0.0.tgz',
            integrity: 'sha512-' + 'A'.repeat(86) + '==',
          },
        }),
    }),
    now: () => (clock += 10),
    randomId: (() => {
      let n = 0
      return () => 'id-' + (n += 1)
    })(),
    readInstalled: async () => ({
      profileName: 'web',
      environmentKind: 'cli',
      homeDir: dir,
      profileDir: dir,
      installedVersion: installed,
      packageValid: true,
      sourceInstall: false,
      blockedReason: null,
      installationKey: 'key-1',
      eligible: true,
    }),
    readJob: async () => job,
    writeJob: async (value) => {
      job = value
    },
    tryAcquireLock: async () => true,
    releaseLock: async () => {},
    backupJob: async () => {},
    runInstall,
  }
}

/** 往真队列目录里手写一份排队状态（别家占着队首）：不注入 readQueue/writeQueue 才会走批量共享端口。 */
export async function seedQueue(dir, waiting) {
  const paths = queuePathsForUpdate(dir, dir)
  await mkdir(dirname(paths.file), { recursive: true })
  await writeFile(paths.file, JSON.stringify({ version: 1, owner: null, waiting }), 'utf8')
}
