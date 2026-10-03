/** demo/static.mjs —— 体验场静态页（仅本机）。 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, normalize } from 'node:path'
const ROOT = process.cwd()
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }
createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://x')
    let p = normalize(join(ROOT, decodeURIComponent(u.pathname === '/' ? '/demo/index.html' : u.pathname)))
    if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden') }
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html')
    const body = readFileSync(p)
    const ext = p.slice(p.lastIndexOf('.'))
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' })
    res.end(body)
  } catch { res.writeHead(404); res.end('not found') }
}).listen(18789, () => console.log('[demo] 页面已起：http://127.0.0.1:18789/demo/index.html'))
