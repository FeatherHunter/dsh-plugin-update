import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as pc from '../dist/shared/copy.js'

// #166 切片 2：健康态复制文本是 panel.ts 里最后一块硬编码中文用户文案
//（有新版…可装／已是最新／插件=/宿主=/使用范围=/队列=/[update-diag] 当前无失败）。
// 本测试先红：buildHealthyDiagCopy 尚不存在；实现后必须与现状逐字一致。

test('#166 健康态复制：有新版分支（三行块，逐字冻结）', () => {
  assert.equal(typeof pc.buildHealthyDiagCopy, 'function', '先红：panel-copy 尚未导出健康态构造器')
  const text = pc.buildHealthyDiagCopy({
    canInstall: true,
    latestVersion: '1.2.3',
    installed: true,
    runningVersion: '1.2.2',
    installedVersion: '1.2.2',
    queuePosition: null,
    pluginId: 'demo',
    hostKind: 'desktop',
    profileName: 'dev',
    requestId: 'r1',
    checkId: 'c1',
    format: 'block',
    lang: 'zh',
  })
  assert.equal(
    text,
    '[update-diag] 当前无失败：有新版 1.2.3 可装（当前 1.2.2）\n' +
      '版本：运行 1.2.2／磁盘 1.2.2／远端 1.2.3\n' +
      '来源：插件=demo · 宿主=desktop · 使用范围=dev · 队列=未排队 · 请求=r1 · 检查=c1',
  )
})

test('#166 健康态复制：英文界面队列词跟随语言（旧内联漏传 lang 恒出中文，搬家即修正）', () => {
  const text = pc.buildHealthyDiagCopy({
    canInstall: true,
    latestVersion: '1.2.3',
    installed: true,
    runningVersion: '1.2.2',
    installedVersion: '1.2.2',
    queuePosition: null,
    pluginId: 'demo',
    hostKind: 'desktop',
    profileName: 'dev',
    requestId: null,
    checkId: null,
    format: 'block',
    lang: 'en',
  })
  assert.match(text, /Not queued/)
  assert.doesNotMatch(text, /未排队/)
})

test('#166 健康态复制：未安装无新版分支（单行，逐字冻结，运行未知不写成 null，#182）', () => {
  const text = pc.buildHealthyDiagCopy({
    canInstall: false,
    latestVersion: null,
    installed: false,
    runningVersion: null,
    installedVersion: null,
    queuePosition: 2,
    pluginId: 'demo',
    hostKind: null,
    profileName: null,
    requestId: null,
    checkId: null,
    format: 'line',
    lang: 'zh',
  })
  assert.equal(
    text,
    '[update-diag] 当前无失败：未安装 · 版本：运行 未知／磁盘 未知／远端 未查过 · 来源：插件=demo · 宿主=未知 · 使用范围=未知 · 队列=排队第 2 位',
  )
})
