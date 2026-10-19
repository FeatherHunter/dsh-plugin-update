import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildNameIndex, buildStatus, countRefs, rewriteText, srcFileOf } from '../scripts/rewrite-dist-imports.mjs'

/**
 * #225 tracer：搬家 codemod 的自检。
 *
 * 这文件测的是 scripts/rewrite-dist-imports.mjs 的纯函数（不碰真仓）：
 *   整搬 = 路径直改（静态 import / 动态 import / new URL / readFileSync / join 段）；
 *   拆分 = 具名 import 按「新 src 谁导出这个名字」分派；
 *   namespace / 读产物文本 / join 形态 = 无法分派 → 人工清单；
 *   判据与幂等：以源码树现状算「已搬」，重复跑零 diff。
 */

const STATUS_NONE = { single: {}, split: {} }
const STATUS_HASH = { single: { 'hash.js': 'moved' }, split: {} }

const STORE_INDEX = () =>
  new Map([
    ['addSkipped', 'core/disk.js'],
    ['pathsForUpdate', 'core/disk.js'],
    ['createUpdateExecutor', 'core/executor.js'],
    ['__executorInternals', 'core/executor.js'],
    ['QUEUE_FILE', 'core/queue/ports.js'],
    ['createUpdateQueuePorts', 'core/queue/ports.js'],
  ])
const STATUS_STORE = () => ({
  single: {},
  split: { 'store.js': { state: 'moved', nameIndex: STORE_INDEX() } },
})

test('#225 整搬：静态 import / 动态 import / new URL 三种形态都改到新路径', () => {
  const src = [
    "import { hash8 } from '../dist/hash.js'",
    "const { hash8: h2 } = await import('../dist/hash.js')",
    "const text = readFileSync(new URL('../dist/hash.js', import.meta.url), 'utf8')",
    '',
  ].join('\n')
  const got = rewriteText(src, STATUS_HASH)
  assert.ok(got.changed)
  assert.equal(got.manual.length, 0)
  assert.equal(got.text.split("'../dist/shared/hash.js'").length - 1, 3)
  assert.equal(got.text.split("'../dist/hash.js'").length - 1, 0)
})

test("#225 整搬：join(PKG_DIR, 'dist', 'hash.js') 拆成新路径的段", () => {
  const src = "await import(pathToFileURL(join(PKG_DIR, 'dist', 'hash.js')).href + '?x=1')\n"
  const got = rewriteText(src, STATUS_HASH)
  assert.ok(got.changed)
  assert.ok(got.text.includes("join(PKG_DIR, 'dist', 'shared', 'hash.js')"), got.text)
  assert.ok(!got.text.includes("'dist', 'hash.js'"))
})

test('#225 整搬：join 只认仓库根 base——测试造的假 dist 副本原样不动', () => {
  const src = [
    "mkdirSync(join(pkg, 'dist'), { recursive: true })",
    "writeFileSync(join(pkg, 'dist', 'hash.js'), '// fake copy\\n')",
    "await import(pathToFileURL(join(PKG_DIR, 'dist', 'hash.js')).href)",
    '',
  ].join('\n')
  const got = rewriteText(src, STATUS_HASH)
  assert.ok(got.changed)
  assert.ok(got.text.includes("join(pkg, 'dist', 'hash.js')"), got.text)
  assert.ok(!got.text.includes("join(pkg, 'dist', 'shared', 'hash.js')"), got.text)
  assert.ok(got.text.includes("join(PKG_DIR, 'dist', 'shared', 'hash.js')"), got.text)
  assert.equal(got.manual.length, 0)
  assert.equal(countRefs("join(pkg, 'dist', 'hash.js')", 'hash.js'), 0)
  assert.equal(countRefs("join(PKG_DIR, 'dist', 'hash.js')", 'hash.js'), 1)
})

test('#225 整搬：path.join(PKG_DIR, ...) 同样按新路径拆段', () => {
  const src = "await import(pathToFileURL(path.join(PKG_DIR, 'dist', 'hash.js')).href)\n"
  const got = rewriteText(src, STATUS_HASH)
  assert.ok(got.text.includes("path.join(PKG_DIR, 'dist', 'shared', 'hash.js')"), got.text)
})

test('#225 拆分：假 dist 副本的 join 不进人工清单', () => {
  const src = "writeFileSync(join(pkg, 'dist', 'store.js'), '// fake\\n')\n"
  const got = rewriteText(src, STATUS_STORE())
  assert.equal(got.changed, false)
  assert.equal(got.manual.length, 0)
})

test('#225 壳留根：公开入口的 dist 路径搬家后不变，深引用零改', () => {
  const src = [
    "import { mountUpdatePanel } from '../dist/panel.js'",
    "import { compute } from '../dist/log/index.js'",
    '',
  ].join('\n')
  const got = rewriteText(src, STATUS_HASH)
  assert.equal(got.changed, false)
  assert.equal(got.text, src)
  assert.equal(got.manual.length, 0)
})

test('#225 待搬模块：源码树还没搬，引用原样保留、不进人工清单', () => {
  const src = "import { updateError } from '../dist/version-judgment.js'\n"
  const got = rewriteText(src, STATUS_NONE)
  assert.equal(got.changed, false)
  assert.equal(got.text, src)
  assert.equal(got.manual.length, 0)
  assert.equal(countRefs(src, 'version-judgment.js'), 1)
})

test('#225 拆分：静态具名 import 按导出名分组成多条，顺序 = 首次出现', () => {
  const src = "import { addSkipped, createUpdateExecutor, QUEUE_FILE } from '../dist/store.js'\n"
  const got = rewriteText(src, STATUS_STORE())
  assert.equal(got.manual.length, 0)
  assert.equal(
    got.text,
    [
      "import { addSkipped } from '../dist/core/disk.js'",
      "import { createUpdateExecutor } from '../dist/core/executor.js'",
      "import { QUEUE_FILE } from '../dist/core/queue/ports.js'",
      '',
    ].join('\n'),
  )
})

test('#225 拆分：同一新模块的多个名字留在同一条 import 里，alias 原样保留', () => {
  const src = "import { createUpdateExecutor, __executorInternals, pathsForUpdate as p } from '../dist/store.js'\n"
  const got = rewriteText(src, STATUS_STORE())
  assert.equal(
    got.text,
    [
      "import { createUpdateExecutor, __executorInternals } from '../dist/core/executor.js'",
      "import { pathsForUpdate as p } from '../dist/core/disk.js'",
      '',
    ].join('\n'),
  )
})

test('#225 拆分：新模块里找不到的导出名 → 原文不动 + 人工清单', () => {
  const src = "import { mysteryThing } from '../dist/store.js'\n"
  const got = rewriteText(src, STATUS_STORE())
  assert.equal(got.text, src)
  assert.ok(got.manual.some((m) => m.kind === 'split-name' && m.name === 'mysteryThing'), JSON.stringify(got.manual))
})

test('#225 拆分：namespace / 动态 namespace / join 形态无法按名分派 → 人工清单', () => {
  const src = [
    "import * as store from '../dist/store.js'",
    "const mod = await import('../dist/store.js')",
    "const u = await import(pathToFileURL(join(PKG_DIR, 'dist', 'store.js')).href)",
    '',
  ].join('\n')
  const got = rewriteText(src, STATUS_STORE())
  assert.equal(got.changed, false)
  const kinds = got.manual.map((m) => m.kind).sort()
  assert.deepEqual(kinds, ['split-join', 'split-namespace-dynamic', 'split-namespace-static'])
})

test('#225 拆分：动态解构 import 按名拆成多条 const', () => {
  const src = "const { addSkipped, createUpdateExecutor } = await import('../dist/store.js')\n"
  const got = rewriteText(src, STATUS_STORE())
  assert.equal(got.manual.length, 0)
  assert.equal(
    got.text,
    [
      "const { addSkipped } = await import('../dist/core/disk.js')",
      "const { createUpdateExecutor } = await import('../dist/core/executor.js')",
      '',
    ].join('\n'),
  )
})

test('#225 幂等：对改写结果再跑一遍，零 diff', () => {
  const src = [
    "import { hash8 } from '../dist/hash.js'",
    "import { addSkipped } from '../dist/store.js'",
    '',
  ].join('\n')
  const first = rewriteText(src, { ...STATUS_HASH, split: STATUS_STORE().split })
  assert.ok(first.changed)
  const second = rewriteText(first.text, { ...STATUS_HASH, split: STATUS_STORE().split })
  assert.equal(second.changed, false)
  assert.equal(second.text, first.text)
})

test('#225 判据：buildStatus 只看源码树（旧 src 不在 + 新 src 在 = 已搬）；partial 不算已搬', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemod-status-'))
  try {
    fs.mkdirSync(path.join(root, 'src', 'shared'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'shared', 'hash.ts'), 'export function hash8() {}\n')
    // store 拆到一半：新文件缺一个 → partial，不能改引用
    fs.mkdirSync(path.join(root, 'src', 'core', 'queue'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'core', 'disk.ts'), 'export const addSkipped = 1\n')
    fs.writeFileSync(path.join(root, 'src', 'core', 'queue', 'ports.ts'), 'export const QUEUE_FILE = 1\n')
    const status = buildStatus(root)
    assert.equal(status.single['hash.js'], 'moved')
    assert.equal(status.single['panel-copy.js'], 'pending')
    assert.equal(status.split['store.js'].state, 'partial')
    assert.deepEqual(status.split['store.js'].missing, ['core/executor.js'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('#225 拆分导出表：从新 src 文件解析（export 声明 / export {} / export * 链）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemod-index-'))
  try {
    fs.mkdirSync(path.join(root, 'src', 'core', 'queue'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'core', 'disk.ts'), [
      'export function addSkipped() {}',
      'export interface UpdatePaths { a: string }',
      'export const sharedThing = 1',
      "export { normalizeSkipped as normalizeSkippedList } from './normalize.js'",
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(root, 'src', 'core', 'normalize.ts'), 'export function normalizeSkipped() {}\n')
    fs.writeFileSync(
      path.join(root, 'src', 'core', 'queue', 'ports.ts'),
      "export * from '../disk.js'\nexport const QUEUE_FILE = 'queue.json'\nexport const sharedThing = 2\n",
    )
    const index = buildNameIndex(root, ['core/disk.js', 'core/queue/ports.js'])
    assert.equal(index.get('addSkipped'), 'core/disk.js')
    assert.equal(index.get('UpdatePaths'), 'core/disk.js')
    assert.equal(index.get('normalizeSkippedList'), 'core/disk.js')
    assert.equal(index.get('QUEUE_FILE'), 'core/queue/ports.js')
    // 只作为别名导出过的原名不算导出
    assert.equal(index.get('normalizeSkipped'), undefined)
    // 同一名字两处直接导出 → 歧义（null），交给人工
    assert.equal(index.get('sharedThing'), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('#225 映射口径：srcFileOf 与 build.mjs 的 dist/src 同构一致', () => {
  assert.equal(srcFileOf('hash.js'), 'src/hash.ts')
  assert.equal(srcFileOf('core/queue/model.js'), 'src/core/queue/model.ts')
  assert.equal(srcFileOf('log/index.js'), 'src/log/index.ts')
})
