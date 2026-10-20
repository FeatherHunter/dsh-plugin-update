// #237 CLI 路：官方桌面运行时的 CLI 入口解析。
// dsh web 的 CLI 入口是桌面运行时自带的 dsh-desktop-host/lib/cli.js——该包既不是
// @deepseek-ai/dsh，也没有 bin 字段，靠 npm 布局的旧反查永远解析不到，安装直接 spawn-failed。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, resolve } from 'node:path'
import { resolveCliEntry } from '../dist/core/executor.js'

const DESKTOP_HOST = '@deepseek-ai/dsh-desktop-host'

// 与 routes.test.mjs 同一口径：只注入清单读取与路径解析，期望地址不写死分隔符。
const cliFile = resolve('/fake/app.asar/dsh/node_modules', DESKTOP_HOST, 'lib', 'cli.js')
const packageDir = resolve('/fake/app.asar/dsh/node_modules', DESKTOP_HOST)

function fakeDeps(manifests) {
  return {
    realpath: async (p) => p,
    readManifest: async (directory) => {
      for (const [dir, manifest] of Object.entries(manifests)) {
        if (directory === dir) return manifest
      }
      return null
    },
  }
}

describe('#237 桌面运行时的 CLI 入口反查', () => {
  it('入口是桌面宿主包的 lib/cli.js 时返回该入口（无 bin 字段也认）', async () => {
    const entry = await resolveCliEntry(cliFile, fakeDeps({ [packageDir]: { name: DESKTOP_HOST, version: '0.2.1-rc.2' } }))
    assert.equal(entry, cliFile)
  })

  it('同包但入口不是 lib/cli.js 时返回 null，不猜', async () => {
    const other = resolve(packageDir, 'lib', 'index.js')
    const entry = await resolveCliEntry(other, fakeDeps({ [packageDir]: { name: DESKTOP_HOST } }))
    assert.equal(entry, null)
  })

  it('npm 布局（@deepseek-ai/dsh + bin.dsh）不回归', async () => {
    const npmCli = resolve('/fake/npm/node_modules/@deepseek-ai/dsh/bin/dsh.js')
    const npmDir = dirname(npmCli)
    const entry = await resolveCliEntry(npmCli, fakeDeps({ [npmDir]: { name: '@deepseek-ai/dsh', bin: { dsh: './dsh.js' } } }))
    assert.equal(entry, npmCli)
  })

  it('无关包布局仍返回 null', async () => {
    const entry = await resolveCliEntry('/fake/other/index.js', fakeDeps({ '/fake/other': { name: 'some-other-pkg' } }))
    assert.equal(entry, null)
  })
})
