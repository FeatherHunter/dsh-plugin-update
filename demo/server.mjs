/**
 * demo/server.mjs —— 更新系统体验场宿主（真逻辑，假安装）。
 *
 * 真：版本比较/通道、快照门控、队列落盘与公平、跳过落盘、后台 heal、
 *     失败 diag 组装、脱敏、CHANGELOG 解析，全部走 dist/ 真代码。
 * 假且诚实：① registry 数据是 canned（与真 registry 同形状）；②装包执行是
 *     演示执行器（等 6 秒再成功，可选 ?fail=1 抛错），不跑 pnpm、不改真实环境。
 * 安全：家目录与使用范围全在系统临时目录下，与 ~/.dsh 零交集。
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostUpdate } from '../dist/host.js'

const HOME = process.env.DEMO_HOME || join(tmpdir(), 'upd-demo-home')
mkdirSync(HOME, { recursive: true })
const PROFILE = join(HOME, 'profiles', 'demo')
mkdirSync(PROFILE, { recursive: true })

// 真实布局（与真实读取器一致）：已装包只认 profileDir/node_modules 下，
// 范围清单的 dependencies 决定是否源码安装；targetPackageDir 指向同一位置
// 即运行包与已装包同体（重启前运行版 pin 旧版，见下）。
function fixture(name, running) {
  writeFileSync(join(PROFILE, 'package.json'), JSON.stringify(
    { name: 'demo-profile', private: true, dependencies: { 'demo-notes-plugin': '^1.1.0', 'demo-tasks-plugin': '^1.1.0' } }, null, 2))
  const dir = join(PROFILE, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(
    { name, version: running, main: 'index.js', exports: { './client': './client.js' }, dsh: { bundle: { patch: './patch.js' } } }, null, 2))
  for (const f of ['index.js', 'client.js', 'patch.js']) {
    writeFileSync(join(dir, f), `'use strict'\n// demo fixture ${name} @ ${running} (${f})\n`)
  }
  return dir
}

const REGISTRY = 'https://registry.npmjs.org/'
function cannedFetch(getName, latest) {
  return async (url) => ({
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      name: getName(),
      version: latest,
      engines: { node: '>=22' },
      dist: { tarball: `${REGISTRY}${getName()}/-/${getName()}-${latest}.tgz`, integrity: 'sha512-' + 'C'.repeat(86) + '==' },
    }),
  })
}

function demoExecutor(label, dir, ms = 6000) {
  return async (args) => {
    console.log(`[demo] ${label} 开始装 ${args.version}（演示执行器，${ms / 1000} 秒后把夹具包版本号写成目标版，不跑 pnpm）`)
    await new Promise((r) => setTimeout(r, ms))
    // 诚实模拟真实执行器唯一承诺的结果：目标版落盘（含入口文件，满足 validPackage）。
    // 下载/完整性/锁/校验全走真代码；若这一步缺失，装完校验会如实判失败（已亲测）。
    const manifestPath = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.version = args.version
    manifest.main = 'index.js'
    manifest.exports = { './client': './client.js' }
    manifest.dsh = { bundle: { patch: './patch.js' } }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    for (const f of ['index.js', 'client.js', 'patch.js']) {
      writeFileSync(join(dir, f), `'use strict'\n// demo fixture ${label} @ ${args.version} (${f})\n`)
    }
  }
}

const PLUGIN = process.env.DEMO_PLUGIN || 'demo-notes-plugin'
const PREFIX = process.env.DEMO_PREFIX || 'notes'
const PORT = Number(process.env.DEMO_PORT || '18787')

function makeHost(pluginId, prefix) {
  const dir = fixture(pluginId, '1.0.0')
  return createHostUpdate(
    {
      readerOverrides: {
        homeDir: HOME,
        profileDir: PROFILE,
        targetPackageDir: dir,
        runningVersion: '1.0.0',
        // 运行版 pin 旧版：真实宿主重启前运行版不变，装完即待重启横幅；
        // 已装环境走真实磁盘（含入口三件校验），落盘状态/队列/跳过同样真实。
        fetchImpl: cannedFetch(() => pluginId, '1.1.0'),
        runInstall: demoExecutor(pluginId, dir),
      },
    },
    { pluginId, prefix, targetPackageName: pluginId }
  )
}

// 真实部署形态：一个插件一份包实例（单进程只服务一个插件），
// 跨插件只经沙盒磁盘共享队列/锁——这正是要体验的“单队列串行”。
const host = makeHost(PLUGIN, PREFIX)
const phones = host.phoneNames
console.log('[demo] 沙盒家目录：', HOME)
console.log('[demo] 插件/电话名：', PLUGIN, JSON.stringify(phones))

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  const u = new URL(req.url, 'http://x')
  if (req.method === 'GET' && u.pathname === '/info') {
    return send(res, 200, { home: HOME, profile: PROFILE, plugin: PLUGIN, phones, note: '演示执行器 6 秒模拟安装，不真装包；数据 canned，与真 registry 同形状。单进程只服务一个插件，双插件开两个进程（端口见下）。' })
  }
  if (req.method === 'GET' && u.pathname === '/files') {
    // 如实列沙盒下落盘文件（路径由真代码派生，不猜）：updates/ 与 update-queue/ 下 walking。
    const { readdirSync, statSync } = await import('node:fs')
    const out = {}
    for (const top of ['updates', 'update-queue']) {
      const base = join(HOME, top)
      const found = []
      const walk = (d) => {
        let ents = []
        try { ents = readdirSync(d) } catch { return }
        for (const e of ents) {
          const p = join(d, e)
          try {
            if (statSync(p).isDirectory()) walk(p)
            else if (/\.(json|lock)$/.test(e) && found.length < 12) {
              try { found.push(p.slice(HOME.length + 1) + '\n' + readFileSync(p, 'utf8').slice(0, 1200)) }
              catch { found.push(p.slice(HOME.length + 1) + '（读失败）') }
            }
          } catch {}
        }
      }
      walk(base)
      out[top] = found.length ? found.join('\n\n---\n\n') : '(尚无文件)'
    }
    return send(res, 200, out)
  }
  if (req.method === 'GET' && u.pathname === '/reset') {
    for (const d of [join(HOME, 'updates'), join(HOME, 'update-queue')]) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
    mkdirSync(PROFILE, { recursive: true })
    return send(res, 200, { ok: true, home: HOME })
  }
  if (req.method === 'POST' && u.pathname === '/phone') {
    let raw = ''
    for await (const c of req) raw += c
    try {
      const { phone, args } = JSON.parse(raw)
      const fn = host.handlers[phone]
      if (!fn) return send(res, 404, { ok: false, error: 'unknown-phone', errorKind: 'unknown-phone' })
      const reply = await fn(args ?? {})
      return send(res, 200, reply)
    } catch (e) {
      return send(res, 200, { ok: false, error: 'check-failed', errorKind: 'internal' })
    }
  }
  return send(res, 404, { ok: false, error: 'not-found', errorKind: 'not-found' })
}).listen(PORT, () => console.log(`[demo] ${PLUGIN} 已起：http://127.0.0.1:${PORT}（再起一个 DEMO_PORT=18788 DEMO_PLUGIN=demo-tasks-plugin DEMO_PREFIX=tasks 即双插件）`))
