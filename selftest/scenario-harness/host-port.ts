/**
 * selftest/scenario-harness/host-port.ts —— “安装谁来装”端口（Ports & Adapters）。
 *
 * 对照宿主契约（`docs/host-install-exits.md`）：真机上有三条出口
 * （desktopPnpm / pluginManager.installBundle / 自起 CLI），B 档一条都不碰。
 * 假宿主只记录 `spec`（`名@版` 整串）并回 `exitCode 0`；要演失败就预置 `failSpecs`。
 *
 * 封装：调用记录藏在闭包里，外部只能拿只读快照（防场景之间串记录——批量隔离要测的正是这个）。
 */

export interface HostInstallRequest {
  /** 安装规格整串，形如 `dsh-plugin-update-selftest-target-a@0.0.2`（与宿主 spec 同形）。 */
  readonly spec: string
}

export interface HostInstallResult {
  readonly exitCode: number
  readonly installedSpec: string
}

export interface HostInstallPort {
  readonly kind: string
  install(request: HostInstallRequest): Promise<HostInstallResult>
  recordedCalls(): readonly HostInstallRequest[]
}

export function createFakeHostInstallPort(options: {
  readonly failSpecs?: ReadonlySet<string>
} = {}): HostInstallPort {
  const calls: HostInstallRequest[] = []
  const failSpecs = options.failSpecs
  return {
    kind: 'fake-host',
    async install(request: HostInstallRequest): Promise<HostInstallResult> {
      calls.push({ spec: request.spec })
      if (failSpecs?.has(request.spec)) {
        return { exitCode: 1, installedSpec: request.spec }
      }
      return { exitCode: 0, installedSpec: request.spec }
    },
    recordedCalls(): readonly HostInstallRequest[] {
      return [...calls]
    },
  }
}
