/**
 * selftest/real-machine/runtime/maintainer-profile.ts —— 维护者 DSH_HOME 的前后指纹（证明没污染）。
 *
 * 只读、不写维护者目录：抓 profile 清单、锁文件、cordis 补丁层与 bundle 列表的 sha256。
 * 目录不存在（例如换机器）时记 'absent'，不编造哈希。
 */
import { join } from 'node:path'
import type { MaintainerProfileFacts } from './evidence.ts'
import { fileExists, sha256File } from '../../tooling/fs-utils.ts'
import { readProfileManifest } from '../host/dsh-cli.ts'

/** 维护者 desktop profile 目录。 */
export function maintainerDesktopProfileDir(homeDir: string): string {
  return join(homeDir, 'profiles', 'desktop')
}

const WATCHED_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.yml', 'cordis.patch.yml']

/** 抓一次指纹（键 = 文件名；值 = sha256 或 'absent'）。 */
export async function captureMaintainerProfile(homeDir: string): Promise<Record<string, string>> {
  const profileDir = maintainerDesktopProfileDir(homeDir)
  const facts: Record<string, string> = {}
  for (const name of WATCHED_FILES) {
    const path = join(profileDir, name)
    facts[name] = (await fileExists(path)) ? await sha256File(path) : 'absent'
  }
  try {
    const manifest = await readProfileManifest(profileDir)
    const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []
    facts['bundles'] = bundles.join(',')
  } catch (error) {
    facts['bundles'] = 'absent'
  }
  return facts
}

/** 前后指纹对比（键集合相同且值全等才算一致）。 */
export function compareMaintainerProfile(homeDir: string, before: Record<string, string>, after: Record<string, string>): MaintainerProfileFacts {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  let unchanged = true
  for (const key of keys) {
    if (before[key] !== after[key]) unchanged = false
  }
  return { homeDir, before, after, unchanged }
}
