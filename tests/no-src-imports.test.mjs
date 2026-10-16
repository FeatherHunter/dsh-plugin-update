import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * 故事 11（#163）：测试禁引源码目录门禁。
 *
 * 只拦真正的引用行（import / export-from / require / 动态 import），
 * 注释里顺口提到 ../src/ 不算——门禁拦的是"伸手拿"，不是"张嘴说"。
 */
const REF_RE =
  /(?:^\s*(?:import|export)[^'"]*?from\s*['"]\.\.\/src\/|require\(\s*['"]\.\.\/src\/|import\(\s*['"]\.\.\/src\/)/

export function findSrcImports(root) {
  const violations = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(full)
        continue
      }
      if (!/\.(mjs|cjs|js)$/.test(entry.name)) continue
      // 先脱注释标记再拼换行：注释掉的 import 也是伸手（解开即生效），
      // 顺口提一句的纯散文注释没有 import 形状，自然放过。
      const flat = fs
        .readFileSync(full, 'utf8')
        .replace(/^[ \t]*\/\/[ \t]?/gm, '')
        .replace(/(\bfrom|import\()\s*\n\s*/g, '$1 ')
      flat.split('\n').forEach((text, i) => {
        if (REF_RE.test(text)) violations.push({ file: path.relative(root, full), line: i + 1, text: text.trim() })
      })
    }
  }
  walk(root)
  return violations
}

test('#163 故事 11：tests/ 下没有测试再伸手进源码目录（抓文件与行号）', () => {
  const got = findSrcImports(path.dirname(fileURLToPath(import.meta.url)))
  assert.equal(got.length, 0, got.map((v) => `${v.file}:${v.line}: ${v.text}`).join('\n'))
})

test('#163 故事 11：门禁真能抓到——import 行红，注释行放过', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-src-'))
  fs.writeFileSync(path.join(root, 'bad.test.mjs'), "import { x } from '../src/service.js'\n")
  fs.writeFileSync(path.join(root, 'ok.test.mjs'), "// 注释里提一句 ../src/service.js 不算伸手\nconst a = 1\n")
  fs.writeFileSync(
    path.join(root, 'sneaky.test.mjs'),
    "// import { x } from '../src/service.js'\nimport { y } from\n  '../src/other.js'\n",
  )
  const got = findSrcImports(root)
  assert.equal(got.length, 3, JSON.stringify(got))
  assert.ok(got.some((v) => v.file === 'bad.test.mjs'))
  // 注释掉的 import 也是伸手（解开注释即生效）；换行写的 from 也要抓
  assert.equal(got.filter((v) => v.file === 'sneaky.test.mjs').length, 2)
  fs.rmSync(root, { recursive: true, force: true })
})
