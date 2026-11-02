/**
 * selftest/real-machine/base-verify/artifacts.ts —— 把 base 的 run 目录收进调用方证据目录，并校验身份链。
 *
 * base 每次跑盘会在 <work-root>/runs/<runId>/ 写 run.json + run.json.sha256 + evidence/。
 * 我们不复制「结论」，复制的是「原始观测」：run.json 全文字节、侧车、evidence 文件逐字节，
 * 目标是 <证据目录>/raw/base-verify/<command>/。复制前先用侧车重算 run.json 的 sha256：
 * 对不上就是身份链断了，按 fail 记（明确失败，而不是悄悄换一份报告）。
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { ensureDir, listFilesRecursive, sha256File } from '../../tooling/fs-utils.ts'
import { formatError } from '../../tooling/process.ts'

/** 一次证据捕获的入参。 */
export interface CaptureArtifactsRequest {
  /** base 打印版报告里的 artifacts.report（run.json 绝对路径）。 */
  readonly runtimeReportPath: string
  /** base 打印版报告里的 artifacts.reportSha256（可选，给了就双查）。 */
  readonly reportSha256?: string
  /** 拷进哪里：调用方给的证据目录，例如 <out>/raw/base-verify/self-check。 */
  readonly targetDir: string
}

/** 捕获成功的产物描述。 */
export interface CapturedArtifacts {
  readonly targetDir: string
  readonly reportPath: string
  readonly files: number
  readonly sha256: string
}

export type CaptureArtifactsOutcome =
  | { readonly ok: true; readonly value: CapturedArtifacts }
  | { readonly ok: false; readonly detail: string }

const SHA256_PATTERN = /^[0-9a-f]{64}$/

function fail(detail: string): CaptureArtifactsOutcome {
  return { ok: false, detail }
}

/** 校验 run.json 侧车 + 拷贝整个 run 目录（幂等：先清空目标目录）。 */
export async function captureBaseRunArtifacts(request: CaptureArtifactsRequest): Promise<CaptureArtifactsOutcome> {
  const reportPath = resolve(request.runtimeReportPath)
  const runDir = dirname(reportPath)
  const sidecarPath = join(runDir, 'run.json.sha256')
  let sidecarText: string
  try {
    sidecarText = await readFile(sidecarPath, 'utf8')
  } catch (error) {
    return fail('找不到身份链侧车 ' + sidecarPath + '：' + formatError(error))
  }
  const sidecarParts = sidecarText.trim().split(/\s+/)
  const claimed = (sidecarParts[0] || '').toLowerCase()
  const sidecarName = sidecarParts[1]
  if (!SHA256_PATTERN.test(claimed)) return fail('run.json.sha256 第一列不是 64 位小写 hex：' + JSON.stringify(sidecarParts[0] || ''))
  if (sidecarName && sidecarName !== 'run.json') return fail('run.json.sha256 第二列不是 run.json：' + JSON.stringify(sidecarName))
  let actual: string
  try {
    actual = await sha256File(reportPath)
  } catch (error) {
    return fail('读不到 run.json（' + reportPath + '）：' + formatError(error))
  }
  if (actual !== claimed) {
    return fail('身份链不一致：run.json 实算 sha256=' + actual + '，侧车声明=' + claimed)
  }
  if (request.reportSha256 && request.reportSha256.toLowerCase() !== actual) {
    return fail('报告自述 artifacts.reportSha256=' + request.reportSha256 + ' 与实算不一致：' + actual)
  }
  let files: string[]
  try {
    files = await listFilesRecursive(runDir)
  } catch (error) {
    return fail('列不出 run 目录（' + runDir + '）：' + formatError(error))
  }
  if (files.length === 0) return fail('run 目录为空：' + runDir)
  try {
    await rm(request.targetDir, { recursive: true, force: true })
    for (const relativePath of files) {
      const segments = relativePath.split('/')
      const source = join(runDir, ...segments)
      const target = join(request.targetDir, ...segments)
      await ensureDir(dirname(target))
      await writeFile(target, await readFile(source))
    }
  } catch (error) {
    return fail('拷贝 run 目录失败：' + formatError(error))
  }
  return {
    ok: true,
    value: {
      targetDir: request.targetDir,
      reportPath: join(request.targetDir, 'run.json'),
      files: files.length,
      sha256: actual,
    },
  }
}
