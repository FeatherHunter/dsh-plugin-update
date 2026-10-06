/**
 * tests/entry-sizing.test.mjs —— 入口件按钮尺寸覆盖（#69）。
 *
 * 只测外部行为：缺省零回归、sizing 写变量、非法即抛、CSS 变量同口径、铁律（绝不自动装）。
 * 传输与容器全用假件（与 tests/entry.test.mjs 同口径），不碰真机、不真联网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UPDATE_ENTRY_CSS, entrySizingStyleFor, mountUpdateEntry } from '../dist/entry.js'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function baseSnapshot(overrides = {}) {
  return {
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.0.0',
    canInstall: false,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

function statusReply(snapshot) {
  return { ok: true, snapshot, manual: null, receipt: null, queue: { busy: false, owner: null, waiting: [], position: null } }
}

function checkReply(snapshot) {
  return {
    ok: true,
    snapshot,
    manual: null,
    receipt: { checkId: 'check-1', checkedAt: 1, expiresAt: 999 },
    queue: { busy: false, owner: null, waiting: [], position: null },
  }
}

const UP_TO_DATE = baseSnapshot()

function fakeCall(script = {}) {
  const log = []
  const call = async (name, args) => {
    log.push({ name, args })
    if (name.endsWith('.updateStatus')) return script.status ?? statusReply(UP_TO_DATE)
    if (name.endsWith('.updateCheck')) return script.check ?? checkReply(UP_TO_DATE)
    if (name.endsWith('.updateInstall')) return statusReply(UP_TO_DATE)
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

function fakeContainer() {
  const listeners = new Map()
  return {
    innerHTML: '',
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((fn) => fn !== listener))
    },
    click(attrs) {
      const matches = (sel) => {
        const m = /^\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]$/.exec(sel)
        if (!m) return false
        if (!Object.prototype.hasOwnProperty.call(attrs, m[1])) return false
        return m[2] === undefined || attrs[m[1]] === m[2]
      }
      const target = { closest: (sel) => (matches(sel) ? {} : null) }
      for (const listener of [...(listeners.get('click') ?? [])]) listener({ target })
    },
  }
}

const CLICK_ENTRY = { 'data-dsh-upd-entry': 'activate' }

async function settled() {
  await new Promise((r) => setTimeout(r, 10))
}

// ---------- 纯函数：entrySizingStyleFor ----------

test('缺省回空串：undefined / null / {} 都不写 style', () => {
  assert.equal(entrySizingStyleFor(undefined), '')
  assert.equal(entrySizingStyleFor(null), '')
  assert.equal(entrySizingStyleFor({}), '')
})

test('全量拼出四个变量（顺序固定：字号→内边距→圆角→缩放）', () => {
  assert.equal(
    entrySizingStyleFor({ fontSize: '12px', padding: '2px 8px', borderRadius: '8px', scale: 1.25 }),
    '--dsh-update-entry-font-size:12px;--dsh-update-entry-padding:2px 8px;--dsh-update-entry-border-radius:8px;--dsh-update-entry-scale:1.25',
  )
})

test('单字段只出一个变量', () => {
  assert.equal(entrySizingStyleFor({ fontSize: '14px' }), '--dsh-update-entry-font-size:14px')
  assert.equal(entrySizingStyleFor({ scale: 1 }), '--dsh-update-entry-scale:1')
})

test('非法即抛：未知键 / 非对象 / 空串 / 注入字符都不收', () => {
  assert.throws(() => entrySizingStyleFor('12px'), /sizing/)
  assert.throws(() => entrySizingStyleFor([]), /sizing/)
  assert.throws(() => entrySizingStyleFor({ fontsize: '12px' }), /sizing/, '键名大小写写错即抛（防拼错）')
  assert.throws(() => entrySizingStyleFor({ fontSize: '' }), /sizing/)
  assert.throws(() => entrySizingStyleFor({ fontSize: '   ' }), /sizing/)
  for (const bad of ['12px; color:red', '12px"', "12px'", '12px<', '12px>', '12px{', '12px}', '12px!important', '12px&x', 'url(x)', 'URL( x )', 'expression(x)', 'javascript:alert(1)']) {
    assert.throws(() => entrySizingStyleFor({ fontSize: bad }), /sizing/, JSON.stringify(bad))
  }
  assert.throws(() => entrySizingStyleFor({ padding: '4px;12px' }), /sizing/)
  assert.throws(() => entrySizingStyleFor({ borderRadius: '6px"' }), /sizing/)
  assert.throws(() => entrySizingStyleFor({ fontSize: 'x'.repeat(201) }), /sizing/, '超长不收')
})

test('scale 只收大于 0 的有限数', () => {
  for (const bad of [0, -1, NaN, Infinity, -Infinity, '1.2', null]) {
    assert.throws(() => entrySizingStyleFor({ scale: bad }), /sizing/, JSON.stringify(bad))
  }
  assert.equal(entrySizingStyleFor({ scale: 0.9 }), '--dsh-update-entry-scale:0.9')
})

// ---------- CSS 同口径：变量缺省即旧硬编码值 ----------

test('CSS 以变量读、缺省即旧值：字号 13px / 内边距 4px 12px / 圆角 6px / 缩放 1', () => {
  assert.match(UPDATE_ENTRY_CSS, /font-size:var\(--dsh-update-entry-font-size,13px\)/)
  assert.match(UPDATE_ENTRY_CSS, /padding:var\(--dsh-update-entry-padding,4px 12px\)/)
  assert.match(UPDATE_ENTRY_CSS, /border-radius:var\(--dsh-update-entry-border-radius,6px\)/)
  assert.match(UPDATE_ENTRY_CSS, /zoom:var\(--dsh-update-entry-scale,1\)/)
})

test('archive 主题圆角缺省仍是 3px，但变量可覆盖', () => {
  assert.match(
    UPDATE_ENTRY_CSS,
    /\.dsh-upd-entry\[data-theme="archive"\] \.dsh-upd-entry-btn\{[^}]*border-radius:var\(--dsh-update-entry-border-radius,3px\)/,
  )
})

// ---------- 挂载行为 ----------

test('缺省零回归：不传 sizing 就不写 style，DOM 与旧版一致', async () => {
  const { call } = fakeCall()
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, { pluginId: 'p', prefix: 'p', call, pollMs: 60000 })
  await settled()
  assert.ok(!/<span class="dsh-upd-entry"[^>]*style=/.test(box.innerHTML), '缺省不在容器 span 上加 style（<style> 里的变量定义不算）')
  assert.ok(!/style="[^"]*--dsh-update-entry/.test(box.innerHTML), '缺省不在行内 style 里写尺寸变量')
  assert.match(box.innerHTML, /dsh-upd-entry-btn/, '按钮照旧')
  entry.unmount()
})

test('sizing 全量：变量以内联方式写到容器上（与手写 CSS 变量等价）', async () => {
  const { call } = fakeCall()
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, {
    pluginId: 'p', prefix: 'p', call, pollMs: 60000,
    sizing: { fontSize: '12px', padding: '2px 8px', borderRadius: '8px', scale: 1.25 },
  })
  await settled()
  assert.match(box.innerHTML, /--dsh-update-entry-font-size:12px/)
  assert.match(box.innerHTML, /--dsh-update-entry-padding:2px 8px/)
  assert.match(box.innerHTML, /--dsh-update-entry-border-radius:8px/)
  assert.match(box.innerHTML, /--dsh-update-entry-scale:1\.25/)
  assert.match(box.innerHTML, /dsh-upd-entry-btn/, '按钮本体仍在')
  entry.unmount()
})

test('非法 sizing 挂载即抛（与 variant/theme 同口径）', () => {
  const call = async () => ({})
  assert.throws(() => mountUpdateEntry(fakeContainer(), { pluginId: 'p', prefix: 'p', call, sizing: { scale: 0 } }), /sizing/)
  assert.throws(() => mountUpdateEntry(fakeContainer(), { pluginId: 'p', prefix: 'p', call, sizing: { fontSize: '12px;evil' } }), /sizing/)
  assert.throws(() => mountUpdateEntry(fakeContainer(), { pluginId: 'p', prefix: 'p', call, sizing: { fontsize: '12px' } }), /sizing/)
})

test('archive 下 sizing 仍生效：变量照写，覆盖主题默认圆角', async () => {
  const { call } = fakeCall()
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, {
    pluginId: 'p', prefix: 'p', call, theme: 'archive', pollMs: 60000,
    sizing: { borderRadius: '10px', scale: 0.9 },
  })
  await settled()
  assert.match(box.innerHTML, /data-theme="archive"/)
  assert.match(box.innerHTML, /--dsh-update-entry-border-radius:10px/)
  assert.match(box.innerHTML, /--dsh-update-entry-scale:0\.9/)
  entry.unmount()
})

test('badge 形态传 sizing 不炸：圆点不读变量，天然只影响按钮本体', async () => {
  const { call } = fakeCall()
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, {
    pluginId: 'p', prefix: 'p', call, variant: 'badge', pollMs: 60000,
    sizing: { fontSize: '12px' }, onActivate: () => {},
  })
  await settled()
  assert.match(box.innerHTML, /dsh-upd-entry-dot/, '徽标仍是圆点')
  assert.ok(!/<button[^>]*class="dsh-upd-entry-btn"/.test(box.innerHTML), '徽标形态不画文字按钮')
  entry.unmount()
})

test('铁律：带 sizing 的完整生命周期里只打只读电话，绝不自动装', async () => {
  const { call, log } = fakeCall()
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, {
    pluginId: 'p', prefix: 'p', call, pollMs: 60000,
    sizing: { fontSize: '12px', scale: 1.1 },
  })
  await settled()
  box.click(CLICK_ENTRY)
  await settled()
  await entry.refresh()
  entry.unmount()
  const names = [...new Set(log.map((e) => e.name))]
  assert.ok(names.every((n) => n === 'p.updateStatus' || n === 'p.updateCheck'), '只许只读电话，实际=' + JSON.stringify(names))
  assert.ok(!log.some((e) => e.name.endsWith('.updateInstall')), '全程不许自动安装')
})

test('入口件源码仍不出现安装电话，类型随包分发', async () => {
  const source = readFileSync(join(PKG_DIR, 'src', 'entry.ts'), 'utf8')
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  assert.ok(!code.includes('updateInstall'), '入口件只许查：源码里不许出现安装电话')
  const dts = join(PKG_DIR, 'dist', 'entry.d.ts')
  assert.ok(existsSync(dts), 'dist/entry.d.ts 已产出')
  const text = readFileSync(dts, 'utf8')
  assert.match(text, /EntrySizing/, '尺寸类型随包分发')
  assert.match(text, /sizing\?: EntrySizing/, '挂载选项含 sizing')
  assert.match(text, /entrySizingStyleFor/, '纯函数出口随包分发')
})

test('sizing 在 setTheme 与 refresh 重绘后依然存在', async () => {
  const { call } = fakeCall()
  const box = fakeContainer()
  const entry = mountUpdateEntry(box, {
    pluginId: 'p', prefix: 'p', call, pollMs: 60000,
    sizing: { fontSize: '12px', scale: 1.1 },
  })
  await settled()
  const hasVars = () => /--dsh-update-entry-font-size:12px/.test(box.innerHTML) && /--dsh-update-entry-scale:1\.1/.test(box.innerHTML)
  assert.ok(hasVars(), '挂载即有变量')
  entry.setTheme('archive')
  assert.ok(hasVars(), '换肤后变量仍在')
  assert.match(box.innerHTML, /data-theme="archive"/)
  await entry.refresh()
  assert.ok(hasVars(), '重查重绘后变量仍在')
  entry.setTheme('default')
  assert.ok(hasVars(), '切回默认后变量仍在')
  entry.unmount()
})
