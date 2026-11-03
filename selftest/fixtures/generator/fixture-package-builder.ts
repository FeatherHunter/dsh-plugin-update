/**
 * selftest/fixtures/generator/fixture-package-builder.ts —— 把「生成计划」落成可发布的夹具包目录。
 *
 * 职责边界：本文件只做 IO（写文件、建 junction、调 esbuild），不决定内容——内容全在 templates/。
 * 产物落仓库外（run 目录），不进仓；发布由 release/ 层从产物目录打 tarball 推本地 registry。
 *
 * 构建两条：
 *   host   src/index.ts → lib/index.js（ESM，'dsh-plugin-update/*' 保持 external，运行时由 profile 的
 *          node_modules 解析——这样被真机测的更新内核永远是「按版本装上的那份」，不是构建期快照）；
 *   client src/client.ts → lib/client.js（浏览器 CJS + window.__ModuleLoader__.load 包壳，react external）。
 */
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FixturePackagePlan } from './fixture-package-plan.ts'

/** 一次构建的入参。 */
export interface BuildFixturePackageInput {
  readonly plan: FixturePackagePlan
  /** 夹具包输出目录（不存在会自动建；已存在会被先清空——同名目录只允许一种内容）。 */
  readonly outDir: string
  /** esbuild 可执行文件路径（本仓 node_modules 里的平台二进制，不新增依赖）。 */
  readonly esbuildPath: string
  /** dsh-plugin-update 工作树根（client bundle 构建期解析 panel/entry 用）。 */
  readonly sutRoot: string
}

/** 构建产物描述（后续发布/证据核对用）。 */
export interface BuiltFixturePackage {
  readonly plan: FixturePackagePlan
  readonly dir: string
  /** 相对包目录的产物路径（已确认存在）。 */
  readonly artifacts: readonly string[]
  /** 已发布包目录（绝对路径）里的 package.json 清单（发布前自检用）。 */
  readonly manifest: FixturePackagePlan['manifest']
}

/** client bundle 的 loader 包壳（DSH Web 壳按 window.__ModuleLoader__.load 协议装载 client）。 */
export function clientLoaderBanner(bundleId: string): string {
  return (
    'window.__ModuleLoader__.load({ id: ' +
    JSON.stringify(bundleId) +
    ', factory: function (require) { var module = { exports: {} }; var exports = module.exports;'
  )
}

export const CLIENT_LOADER_FOOTER = 'return module.exports; } });'

/** client 构建命令（导出纯函数只为让单测/文档能核对参数，不重复写两份口径）。 */
export function clientBuildArgs(plan: FixturePackagePlan, outDir: string): string[] {
  return [
    join(outDir, 'src/client.ts'),
    '--bundle',
    '--platform=browser',
    '--format=cjs',
    '--target=es2020',
    '--external:react',
    '--external:react-dom',
    '--define:process.env.NODE_ENV="production"',
    '--banner:js=' + clientLoaderBanner(plan.buildSteps[1].bundleId || plan.slot.pluginId),
    '--footer:js=' + CLIENT_LOADER_FOOTER,
    '--outfile=' + join(outDir, 'lib/client.js'),
    // Windows 下 esbuild 需要实体工作目录来解析 junction 里的依赖；日志进 stderr，stdout 留空。
    '--log-level=warning',
  ]
}

/** host 构建命令：ESM、依赖全部 external（运行时按 profile 已装版本解析）。 */
export function hostBuildArgs(plan: FixturePackagePlan, outDir: string): string[] {
  return [
    join(outDir, 'src/index.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=es2020',
    '--packages=external',
    '--outfile=' + join(outDir, 'lib/index.js'),
    '--log-level=warning',
  ]
}

/** 把计划里的源文件写到 outDir（纯 IO；不构建）。 */
export async function writePlanSources(plan: FixturePackagePlan, outDir: string): Promise<void> {
  await rm(outDir, { recursive: true, force: true })
  for (const file of plan.sourceFiles) {
    const target = join(outDir, file.path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, file.content)
  }
}

/**
 * 建构建期的 node_modules junction：<outDir>/node_modules/dsh-plugin-update → sutRoot。
 * 为什么必须 junction 而不是 --alias：esbuild 的 alias 只替换裸包名，不管 'pkg/subpath' 子路径，
 * 而夹具 client 正是 require('dsh-plugin-update/panel') 这种子路径（exploration 笔记 §3.4 实测坑）。
 */
export async function linkSutForBuild(outDir: string, sutRoot: string): Promise<void> {
  const modulesDir = join(outDir, 'node_modules')
  await mkdir(modulesDir, { recursive: true })
  const linkPath = join(modulesDir, 'dsh-plugin-update')
  await rm(linkPath, { recursive: true, force: true })
  await symlink(sutRoot, linkPath, 'junction')
}

/** 跑一次 esbuild；失败时把原始命令 + 输出一起抛出（证据里要能复现）。 */
function runEsbuild(esbuildPath: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(esbuildPath, args, { cwd, windowsHide: true, stdio: 'pipe' })
  if (result.error) throw new Error('[fixtures] esbuild 启动失败：' + result.error.message)
  if (result.status !== 0) {
    throw new Error(
      '[fixtures] esbuild 失败（exit ' +
        String(result.status) +
        '）\n命令：' +
        esbuildPath +
        ' ' +
        args.join(' ') +
        '\nstdout：' +
        String(result.stdout) +
        '\nstderr：' +
        String(result.stderr)
    )
  }
}

/** 落盘 + 两条构建 + 产物自检；返回可发布的夹具包目录。 */
export async function buildFixturePackage(input: BuildFixturePackageInput): Promise<BuiltFixturePackage> {
  const { plan, outDir, esbuildPath, sutRoot } = input
  await writePlanSources(plan, outDir)
  await linkSutForBuild(outDir, sutRoot)
  runEsbuild(esbuildPath, hostBuildArgs(plan, outDir), outDir)
  runEsbuild(esbuildPath, clientBuildArgs(plan, outDir), outDir)
  const artifacts: string[] = []
  for (const artifact of plan.expectedArtifacts) {
    const absolute = join(outDir, artifact)
    try {
      await readFile(absolute)
    } catch {
      throw new Error('[fixtures] 构建产物缺失：' + absolute)
    }
    artifacts.push(artifact)
  }
  return { plan, dir: outDir, artifacts, manifest: plan.manifest }
}
