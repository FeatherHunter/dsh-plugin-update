/**
 * tests/paths.test.mjs —— 落盘目录派生、旧路径冻结、按插件标识隔离（#203）。
 *
 * 只测外部行为：在落盘层断言路径派生与读写边界。不测内部私有常量与函数名。
 * 文件读写走真实临时目录（前缀隔离），不碰生产路径；网络与子进程一律不用。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createUpdateDiskPorts, pathsForUpdate } from '../dist/core/disk.js'

function shortHash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 24)
}

let homeDir = ''
let profileDir = ''

before(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'dpu-home-'))
  profileDir = mkdtempSync(join(tmpdir(), 'dpu-profile-'))
})

after(() => {
  rmSync(homeDir, { recursive: true, force: true })
  rmSync(profileDir, { recursive: true, force: true })
})

describe('落盘执行器的目录派生与按标识隔离', () => {
  it('目录按标识派生，三文件名不变', () => {
    const paths = pathsForUpdate(homeDir, 'my-plugin', profileDir)
    assert.equal(paths.directory, join(homeDir, 'updates', 'my-plugin', shortHash(profileDir)))
    assert.equal(paths.state, join(paths.directory, 'state.json'))
    assert.equal(paths.lock, join(paths.directory, 'install.lock'))
    assert.equal(paths.backup, join(paths.directory, 'before.json'))
  })

  it('旧标识对应的旧路径一字不差（冻结验收项）', () => {
    const fresh = pathsForUpdate(homeDir, 'dsh-mattpocock-skills-deck', profileDir)
    // 旧原文：join(家目录, 'updates', 'dsh-mattpocock-skills-deck', 短指纹)。
    const legacyLiteral = join(homeDir, 'updates', 'dsh-mattpocock-skills-deck', shortHash(profileDir))
    assert.equal(fresh.directory, legacyLiteral)
  })

  it('写只写新路径：旧影子目录不产生文件', async () => {
    const ports = createUpdateDiskPorts(homeDir, 'my-plugin', profileDir)
    const job = { id: 'job-1', state: 'installing', targetVersion: '1.0.0', message: null, requestId: 'req-1' }
    await ports.writeJob(job)
    const readBack = await ports.readJob()
    assert.equal(readBack.id, 'job-1')
    assert.equal(readBack.targetVersion, '1.0.0')
    // 旧影子目录没有被写出。
    const legacyState = join(homeDir, 'updates', 'dsh-mattpocock-skills-deck', shortHash(profileDir), 'state.json')
    const { stat } = await import('node:fs/promises')
    await assert.rejects(() => stat(legacyState), /ENOENT/)
    await ports.writeJob(null)
    assert.equal(await ports.readJob(), null)
  })

  it('#203：旧字面目录里的任务不会被别的插件标识回退采信', async () => {
    // 旧字面目录恰好是默认标识自己的实时目录：里面放一份默认标识的任务。
    const defaultPorts = createUpdateDiskPorts(homeDir, 'dsh-mattpocock-skills-deck', profileDir)
    const defaultJob = { id: 'default-job', state: 'failed', targetVersion: '0.9.0', message: 'install-failed', requestId: null }
    await defaultPorts.writeJob(defaultJob)
    // 别家标识自己的新路径还没有文件时，不得回退读默认标识的目录（真机跨插件污染的来源）。
    const otherPorts = createUpdateDiskPorts(homeDir, 'brand-new-plugin', profileDir)
    assert.equal(await otherPorts.readJob(), null)
    // 自己的任务照常读写，且旧字面目录里的别家任务一字不动。
    const ownJob = { id: 'own-job', state: 'failed', targetVersion: '1.0.0', message: 'install-failed', requestId: null }
    await otherPorts.writeJob(ownJob)
    assert.equal((await otherPorts.readJob()).id, 'own-job')
    assert.equal((await defaultPorts.readJob()).id, 'default-job')
    await otherPorts.writeJob(null)
    await defaultPorts.writeJob(null)
  })

  it('默认标识自己的读写只认自己目录（旧字面即其新路径）', async () => {
    const ports = createUpdateDiskPorts(homeDir, 'dsh-mattpocock-skills-deck', profileDir)
    const job = { id: 'legacy-self', state: 'installing', targetVersion: '1.0.0', message: null, requestId: 'r' }
    await ports.writeJob(job)
    assert.equal((await ports.readJob()).id, 'legacy-self')
    await ports.writeJob(null)
  })
})
