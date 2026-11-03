/**
 * selftest/real-machine/runtime/run-layout.ts —— 一次真机 run 的目录布局与命名（证据包的地基）。
 *
 * 全部落在仓库外：<baseDir>/<ticket>-<YYYYMMDDTHHMMSS>/。目录名自解释：
 *   raw/       每条命令的原始记录（命令、cwd、exit、stdout/stderr、耗时）
 *   shots/     截图 png + 同名 .json（看什么/expected/actual/判定）
 *   fixtures/  本次 run 生成的夹具包（构建产物，不进仓）
 *   home/      隔离 DSH_HOME（临时 profile、日志、台账都在里面）
 *   profiles/  隔离 profile 用户目录（桌面通道的 --user-data-dir）
 *   pack/      工作树 npm pack 出来的 SUT tarball
 *   registry/  本地 verdaccio（storage/config/npmrc）
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 一次 run 的目录布局。 */
export interface RunLayout {
  readonly ticket: string
  readonly stamp: string
  readonly runId: string
  readonly root: string
  readonly rawDir: string
  readonly shotsDir: string
  readonly fixturesDir: string
  readonly homeDir: string
  readonly profilesDir: string
  readonly userDataDir: string
  readonly packDir: string
  readonly registryDir: string
}

/** 时间戳（run 目录名用；本地时区，人读友好，跨机器不要求可比）。 */
export function formatRunStamp(date = new Date()): string {
  const pad = (value: number): string => (value < 10 ? '0' + value : String(value))
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    'T' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  )
}

/** 建一个 run 的全部子目录（已存在则复用；同一 stamp 重跑会落到同一目录，便于续跑）。 */
export async function createRunLayout(options: {
  baseDir: string
  ticket: string
  stamp?: string
}): Promise<RunLayout> {
  const stamp = options.stamp || formatRunStamp()
  const runId = options.ticket + '-' + stamp
  const root = join(options.baseDir, runId)
  const layout: RunLayout = {
    ticket: options.ticket,
    stamp,
    runId,
    root,
    rawDir: join(root, 'raw'),
    shotsDir: join(root, 'shots'),
    fixturesDir: join(root, 'fixtures'),
    homeDir: join(root, 'home'),
    profilesDir: join(root, 'profiles'),
    userDataDir: join(root, 'user-data-dir'),
    packDir: join(root, 'pack'),
    registryDir: join(root, 'registry'),
  }
  for (const dir of [layout.rawDir, layout.shotsDir, layout.fixturesDir, layout.homeDir, layout.profilesDir, layout.packDir, layout.registryDir]) {
    await mkdir(dir, { recursive: true })
  }
  return layout
}
