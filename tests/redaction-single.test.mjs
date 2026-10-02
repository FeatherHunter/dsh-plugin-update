/**
 * tests/redaction-single.test.mjs —— #24 脱敏单源收敛 + 1024 字节墙 enforcement。
 *
 * 只断外部行为：经包公开出口（dist/redaction.js、dist/panel.js、dist/host.js），
 * 不断内部函数名与调用次数。旧正则快照仅用于新旧穷举比对（断“新掩 ⊇ 旧掩”，不断实现）。
 * 不真联网、不真装。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COPY_BUDGET_CHARS,
  DETAIL_MAX_CHARS,
  DIAG_DROP_ORDER,
  DIAG_INLINE_BUDGET_BYTES,
  DIAG_NEVER_DROP_KEYS,
  KNOWN_GAP_FILE_URL_PREFIX,
  diagByteLength,
  enforceDiagBudget,
  sanitizeDetail,
  sanitizeForCopy,
} from '../dist/redaction.js'
import { PANEL_DIAG_MAX_CHARS, redactForCopy } from '../dist/panel.js'
import * as hostRoot from '../dist/host.js'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function bytesOf(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

/** 占位符完整性：每个 `<` 都属于完整的 `<路径>` 或 `<脱敏>`。 */
function assertPlaceholdersIntact(text) {
  const stripped = String(text).split('<路径>').join('').split('<脱敏>').join('')
  assert.ok(!stripped.includes('<'), `占位符被切开：${String(text).slice(-30)}`)
}

// ---------- 旧快照（收敛前核侧与面板侧的实际形态，仅用于新旧比对） ----------

const OLD_CORE_PATH = /[A-Za-z]:\\[^\s"']*|(^|[\s"'(\[=,])\\\\[^\s"'()\[\];\\]+(?:\\[^\s"'()\[\];]*)*|(^|[\s"'(\[=,])\/\/[^\s"'()\[\];]+|(^|[\s"'(\[=:,])\/(?!\/)[^\s"'()\[\];]+/g
const OLD_CORE_USERINFO = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/]*@/
const OLD_CORE_NPM = /\bnpm_[A-Za-z0-9_-]{8,}/g
const OLD_CORE_GH = /\b(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})/g
const OLD_CORE_SK = /\bsk-[A-Za-z0-9_-]{8,}/g
const OLD_CORE_BEARER = /(\b[Bb]earer\s+)[A-Za-z0-9._~+/-=]{6,}/g
const OLD_CORE_KV = /(\b(?:token|password|passwd|pwd|api[_-]?key|secret|cookie)\s*[:=]\s*['"]?)[^\s'";,)\]]+/gi
const OLD_CORE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

function oldCoreMasked(raw) {
  const flat = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return false
  OLD_CORE_USERINFO.lastIndex = 0
  if (OLD_CORE_USERINFO.test(flat)) return true // 旧核丢弃即“掩”
  let t = flat
  OLD_CORE_PATH.lastIndex = 0
  t = t.replace(OLD_CORE_PATH, '<路径>')
  OLD_CORE_NPM.lastIndex = 0
  OLD_CORE_GH.lastIndex = 0
  OLD_CORE_SK.lastIndex = 0
  OLD_CORE_BEARER.lastIndex = 0
  t = t.replace(OLD_CORE_NPM, '<脱敏>').replace(OLD_CORE_GH, '<脱敏>').replace(OLD_CORE_SK, '<脱敏>').replace(OLD_CORE_BEARER, '<脱敏>')
  OLD_CORE_KV.lastIndex = 0
  t = t.replace(OLD_CORE_KV, '<脱敏>')
  OLD_CORE_EMAIL.lastIndex = 0
  t = t.replace(OLD_CORE_EMAIL, '<脱敏>')
  return t.includes('<路径>') || t.includes('<脱敏>') || t === ''
}

const OLD_PANEL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/]*@[^\s]*/g
const OLD_PANEL_TOKEN =
  /\b(?:npm_[A-Za-z0-9_-]{6,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._~+/-]{6,})\b/g
const OLD_PANEL_KV =
  /\b(token|password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|cookie)\b(\s*[:=]\s*)("[^"]{1,200}"|'[^']{1,200}'|[^\s,;'"()[\]]{1,200})/gi
const OLD_PANEL_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const OLD_PANEL_PATH =
  /[A-Za-z]:\\[^\s"']*|\\\\[^\s"'()[\];]+|(^|[\s"'([=,])\/\/[^\s"'()[\];]+|(^|[\s"'([=:,])\/(?!\/)[^\s"'()[\];]+/g

function oldPanelMasked(raw) {
  const flat = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return false
  let t = flat.replace(OLD_PANEL_USERINFO, '<脱敏>')
  t = t.replace(OLD_PANEL_TOKEN, '<脱敏>').replace(OLD_PANEL_KV, '<脱敏>').replace(OLD_PANEL_EMAIL, '<脱敏>')
  t = t.replace(OLD_PANEL_PATH, '<路径>')
  return t.includes('<路径>') || t.includes('<脱敏>')
}

function newMasked(raw) {
  const out = sanitizeForCopy(raw)
  return out === '' || out.includes('<路径>') || out.includes('<脱敏>')
}

// ---------- 单源 ----------

describe('单源：面板只转调纯核，无镜像', () => {
  it('redactForCopy 与 sanitizeForCopy 逐字一致', () => {
    const samples = [
      "ENOENT: no such file or directory, open '/tmp/secret/data.json'",
      'see \\\\server\\share\\file.txt now',
      'GET https://user:s3cret@registry.example.com/pkg failed',
      'npm ERR! 401 - npm_abc123XYZ456token789',
      'auth failed token=abc123SECRETvalue mail user@example.com',
      'ratio 1/2 and/or from https://registry.npmjs.org/x kept',
      'open file:///tmp/x failed',
    ]
    for (const s of samples) assert.equal(redactForCopy(s), sanitizeForCopy(s), `分歧：${s}`)
  })
  it('面板 1500 常量单源：值相等且为 1500', () => {
    assert.equal(PANEL_DIAG_MAX_CHARS, COPY_BUDGET_CHARS)
    assert.equal(PANEL_DIAG_MAX_CHARS, 1500)
    assert.equal(COPY_BUDGET_CHARS, 1500)
  })
  it('零 Node 导入：redaction 与 panel 源码无 node: 导入', () => {
    for (const name of ['redaction.ts', 'panel.ts']) {
      const source = readFileSync(join(PKG_DIR, 'src', name), 'utf8')
      assert.ok(!/from 'node:/.test(source), `${name} 不得出现 node: 导入（浏览器闭包进不去）`)
    }
  })
  it('包根转出口可达：第二家经 host 拿到单源与墙', () => {
    assert.equal(hostRoot.COPY_BUDGET_CHARS, 1500)
    assert.equal(hostRoot.DIAG_INLINE_BUDGET_BYTES, 1024)
    assert.equal(typeof hostRoot.sanitizeForCopy, 'function')
    assert.equal(typeof hostRoot.enforceDiagBudget, 'function')
    assert.equal(typeof hostRoot.truncateToWordBoundary, 'function')
  })
})

// ---------- 统一丢弃语义 ----------

describe('统一丢弃语义：用户信息整项丢弃，非遮蔽', () => {
  const CASES = [
    'GET https://user:s3cret@registry.example.com/pkg failed',
    'GET https://user:p@ss@example.com/foo failed',
    'npm ERR! 401 https://admin:hunter2@mirror.corp.example.com/dsh-plugin-update',
  ]
  for (const raw of CASES) {
    it(`丢弃：${raw.slice(0, 32)}…`, () => {
      assert.equal(sanitizeDetail(raw), '', '核侧整项丢弃返空串')
      assert.equal(sanitizeForCopy(raw), '', '复制侧整项丢弃返空串')
      assert.equal(redactForCopy(raw), '', '面板侧整项丢弃返空串（非遮蔽）')
    })
  }
})

// ---------- 阈值与键集取严侧 ----------

describe('阈值取严侧但守住不误伤', () => {
  it('npm_ 守 8（面板侧 6 会吃掉 npm_install，不取）', () => {
    assert.ok(sanitizeForCopy('run npm_install script').includes('npm_install'), 'npm_install 必须保留')
    assert.match(sanitizeForCopy('leak npm_abc123XY here'), /<脱敏>/, '8 位后缀掩掉')
  })
  it('GitHub 取严侧 8（核侧 10 偏松）', () => {
    assert.match(sanitizeForCopy('key ghp_12345678 here'), /<脱敏>/, '8 位即掩')
  })
  it('sk- 取严侧 6（核侧 8 偏松）', () => {
    assert.match(sanitizeForCopy('key sk-123456 here'), /<脱敏>/, '6 位即掩')
  })
  it('Bearer 保留前缀可读（核侧写法）', () => {
    const out = sanitizeForCopy('auth Bearer abcdef123456 failed')
    assert.ok(out.includes('Bearer'), 'Bearer 前缀保留')
    assert.match(out, /<脱敏>/)
    assert.ok(!out.includes('abcdef123456'))
  })
})

describe('键集取严侧：面板超集并入纯核', () => {
  it('access_key / auth_token 现在掩掉（核侧旧无）', () => {
    assert.match(sanitizeDetail('bad access_key=XYZ-987-secret here'), /<脱敏>/)
    assert.match(sanitizeDetail('bad auth_token: abc123XYZ here'), /<脱敏>/)
    assert.match(sanitizeForCopy('bad access_key=XYZ-987-secret here'), /<脱敏>/)
  })
  it('引号包住含空格值整段掩掉（面板严侧 + 核无上限）', () => {
    const out = sanitizeDetail('login password="my secret pass" failed')
    assert.ok(!out.includes('my secret'), `引号内空格值须整段消失，实际：${out}`)
    assert.match(out, /<脱敏>/)
    assert.ok(out.includes('password'), '键名保留可读')
  })
  it('超长秘密无 200 封顶亦掩掉（去面板上限，取核无上限）', () => {
    const long = `token=${'x'.repeat(300)}`
    const out = sanitizeForCopy(`auth ${long} end`)
    assert.ok(!out.includes('x'.repeat(10)), '300 字秘密须消失')
    assert.match(out, /<脱敏>/)
  })
})

// ---------- file:/// 已知缺口显式 ----------

describe('file:/// 缺口显式 known-gap（原样放过，不静默修）', () => {
  it('常量存在且为 file:///', () => {
    assert.equal(KNOWN_GAP_FILE_URL_PREFIX, 'file:///')
  })
  it('三斜杠形状原样通过（记录在案，非泄漏无视）', () => {
    const raw = 'open file:///tmp/x failed'
    assert.ok(sanitizeDetail(raw).includes('file:///tmp/x'), `应原样放过，实际：${sanitizeDetail(raw)}`)
    assert.ok(sanitizeForCopy(raw).includes('file:///tmp/x'))
  })
})

// ---------- 双向语料 + 真实报错串（两缝同 verdict） ----------

describe('双向语料：每条规则必须掩掉 vs 不能误伤（核与复制同 verdict）', () => {
  const MUST_SCRUB = [
    ['POSIX 单引号', "ENOENT: no such file or directory, open '/tmp/secret/data.json'"],
    ['权限拒绝冒号后', 'EACCES: permission denied at path:/var/log/npm.log'],
    ['方括号内盘符', 'read [C:\\Users\\alice\\state.json] denied'],
    ['Windows 盘符', 'EACCES: permission denied C:\\Program Files\\dsh\\state.json'],
    ['UNC 斜杠', 'share //server/share/state.json gone'],
    ['UNC 反斜杠', 'share \\\\server\\share\\state.json gone'],
    ['引号盘符', 'open "D:\\data\\state.json" failed'],
    ['路径内逗号', 'open /tmp/a,b/state.json failed'],
    ['句中 UNC 反斜杠（严侧无前置亦掩）', 'foo\\\\server\\share\\x bar'],
    ['npm 令牌真实串', 'npm ERR! 401 Unauthorized - GET https://registry.npmjs.org/pkg - npm_abc123XYZ456token789'],
    ['GitHub 真实串', 'fatal: could not read Username: ghp_abc123DEF456ghi789jkl000'],
    ['sk 真实串', 'OpenAI error invalid key sk-abc123XYZ456789qwerty'],
    ['Bearer 真实串', 'GET failed 401 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'],
    ['Bearer 全大写（RFC 关键字大小写不敏感，对抗补）', 'GET failed 401 Authorization: BEARER eyJhbGciOiJIUzI1NiJ9.payload.sig'],
    ['密码键值对', 'auth failed token=abc123SECRETvalue'],
    ['api_key 引号', 'bad key api_key="XYZ-987-secret"'],
    ['邮箱真实串', 'npm ERR! 404 Not Found - user@example.com needs auth'],
  ]
  for (const [name, raw] of MUST_SCRUB) {
    it(`掩掉：${name}`, () => {
      // 新核必须掩（丢弃即掩：空串亦算掩，调用方回落稳定码，不静默）。
      assert.equal(newMasked(raw), true, `新核应掩：${raw}`)
      // 非丢弃形必须见占位（丢弃形返空串，见统一丢弃语料组，此处不断原文子串防用例间耦合）。
      for (const fn of [sanitizeDetail, sanitizeForCopy]) {
        const out = fn(raw)
        if (out !== '') assert.ok(out.includes('<路径>') || out.includes('<脱敏>'), `${name} 应见占位，实际=${out}`)
        assertPlaceholdersIntact(out || 'x')
      }
    })
  }
  const MUST_KEEP = [
    ['官方源 URL', 'from https://registry.npmjs.org/my-plugin failed'],
    ['URL 内多斜杠', 'path http://a.com/x//y kept'],
    ['散文斜杠', 'retry later please'],
    ['分数', '1/2 of packages done'],
    ['孤立斜杠', 'a / b compared'],
    ['无 TLD 非邮箱', 'contact user@example for help'],
    ['无值键名', 'token expired, try again'],
    ['npm_install', 'run npm_install script'],
  ]
  for (const [name, raw] of MUST_KEEP) {
    it(`保留：${name}`, () => {
      // 强断言：keeps 全部短于 300 字且无秘密，两缝必须原样返回（恒真式已删，对抗补）。
      const flat = String(raw).replace(/\s+/g, ' ').trim()
      assert.ok(flat.length < DETAIL_MAX_CHARS, `keep 语料须短于封顶，实际 ${flat.length}`)
      assert.equal(sanitizeDetail(raw), flat, `核侧应原样保留：${name}`)
      assert.equal(sanitizeForCopy(raw), flat, `复制侧应原样保留：${name}`)
    })
  }
})

// ---------- 新旧穷举比对 ----------

describe('新旧穷举比对：新掩 ⊇ 旧掩（零回归）', () => {
  const PREFIXES = ['', ' ', "' fears '", '("open" ', 'at path:', 'x=']
  const SHAPES = [
    '/tmp/secret/x',
    'C:\\secret\\x',
    '\\\\server\\share\\f',
    '//server/share/f',
    'https://registry.npmjs.org/x',
    'npm_abc123XY',
    'ghp_12345678',
    'sk-123456',
    'Bearer abcdef123456',
    'BEARER abcdef123456',
    'token=abc123',
    'access_key=zzz',
    'user@example.com',
    'https://u:p@h/x',
    'file:///tmp/x',
    '1/2',
    'and/or',
  ]
  const inputs = []
  for (const p of PREFIXES) for (const s of SHAPES) inputs.push(`${p}${s} tail`.trim())
  it(`穷举 ${inputs.length} 种组合：旧掩则新必掩`, () => {
    let checked = 0
    for (const raw of inputs) {
      if (raw.includes('file:///')) continue // 已知缺口不参与比对（另有显式断言）
      const coreOld = oldCoreMasked(raw)
      const panelOld = oldPanelMasked(raw)
      if (coreOld || panelOld) {
        assert.equal(newMasked(raw), true, `回归：旧掩而新不掩：${JSON.stringify(raw)}（核旧=${coreOld} 面旧=${panelOld} 新=${JSON.stringify(sanitizeForCopy(raw))}）`)
        checked++
      }
    }
    assert.ok(checked > 20, `应有足够多的旧掩样本，实际 ${checked}`)
  })
  it('file:/// 缺口不计入回归（显式除外）', () => {
    assert.equal(oldCoreMasked('open file:///tmp/x failed'), false)
  })
})

// ---------- 确定性属性 ----------

describe('确定性属性：同输入逐字节相同', () => {
  const SAMPLES = [
    "ENOENT '/tmp/a' token=zzz999 npm_abc123XYZ456token789 mail m@n.com https://registry.npmjs.org/x",
    'share \\\\server\\share\\f with password=hunter2 and a@b.com',
    '中'.repeat(100) + ' /tmp/secret/x ' + 'word '.repeat(50),
  ]
  for (const [i, raw] of SAMPLES.entries()) {
    it(`样本 ${i + 1} 两次一致`, () => {
      assert.equal(sanitizeDetail(raw), sanitizeDetail(raw))
      assert.equal(sanitizeForCopy(raw), sanitizeForCopy(raw))
      assert.equal(redactForCopy(raw), redactForCopy(raw))
      assert.equal(JSON.stringify(enforceDiagBudget({ v: 1, stage: 'exec', route: 'cli-process', requestId: 'r1', detail: raw })), JSON.stringify(enforceDiagBudget({ v: 1, stage: 'exec', route: 'cli-process', requestId: 'r1', detail: raw })))
    })
  }
})

// ---------- 1024 字节墙 ----------

describe('DIAG 1024 字节墙：运行时按序丢弃 + 显式 truncated 位', () => {
  function bigDiag() {
    return {
      v: 1,
      stage: 'fetch-release',
      route: 'registry',
      method: 'https',
      httpStatus: 429,
      exitCode: 1,
      latencyMs: 123,
      detail: '中'.repeat(400),
      targetPackageName: 'dsh-plugin-update',
      runningVersion: '1.0.0',
      latestVersion: '9.9.9',
      environmentKind: 'cli',
      requestId: 'req-1',
      checkId: 'id-2',
      registryHost: 'registry.npmjs.org',
      action: 'retry',
    }
  }
  it('小 diag 不动：truncated false，全键保留且在墙内', () => {
    const small = { v: 1, stage: 'exec', route: 'cli-process', requestId: 'req-1', detail: '安装失败' }
    const out = enforceDiagBudget(small)
    assert.equal(out.truncated, false)
    assert.equal(out.stage, 'exec')
    assert.ok(bytesOf(out) <= DIAG_INLINE_BUDGET_BYTES)
  })
  it('大 diag 压进墙内：永不丢键在，truncated true', () => {
    const out = enforceDiagBudget(bigDiag())
    assert.ok(bytesOf(out) <= DIAG_INLINE_BUDGET_BYTES, `超墙：${bytesOf(out)}`)
    assert.equal(out.truncated, true)
    for (const k of ['v', 'stage', 'route', 'method', 'requestId']) assert.ok(k in out, `${k} 永不丢`)
    assertPlaceholdersIntact(typeof out.detail === 'string' ? out.detail || 'x' : 'x')
  })
  it('路由方法原子：墙永不拆散该对（对抗实锤，#21 well-formed）', () => {
    const out = enforceDiagBudget(bigDiag())
    assert.equal('method' in out, 'route' in out, 'route/method 要么同有要么同省')
    const noroute = enforceDiagBudget({ v: 1, stage: 'exec', requestId: 'r1', detail: '中'.repeat(400) })
    assert.equal('method' in noroute, 'route' in noroute, '构造侧双省时墙侧亦双省')
  })
  it('按序省：registryHost 先于 action 先于版本', () => {
    const out = enforceDiagBudget(bigDiag())
    assert.ok(!('registryHost' in out), 'registryHost 应首省')
    // action 与版本至少其一被省（墙内 1024 下全保留不可能）
    assert.ok(!('action' in out) || !('latestVersion' in out) || !('runningVersion' in out), 'action/版本按序省其一')
  })
  it('diagByteLength 与常量一致：1024', () => {
    assert.equal(DIAG_INLINE_BUDGET_BYTES, 1024)
    assert.ok(diagByteLength({ a: 'x' }) > 0)
    assert.deepEqual([...DIAG_NEVER_DROP_KEYS].sort(), ['code', 'error', 'errorKind', 'method', 'requestId', 'route', 'stage', 'v'].sort())
    assert.equal(DIAG_DROP_ORDER[0], 'registryHost')
    assert.equal(DIAG_DROP_ORDER[1], 'action')
  })
})

// ---------- 复制预算统一 ----------

describe('复制预算统一：1500 同落刀语义', () => {
  it('超长复制在空白处落刀，不断占位符', () => {
    const out = sanitizeForCopy(`${'word '.repeat(400)}/tmp/secret/x ${'tail '.repeat(400)}`)
    assert.ok(out.length <= 1501, `复制封顶 1500 + 省略号，实际 ${out.length}`)
    assert.ok(out.endsWith('…'))
    assertPlaceholdersIntact(out)
  })
})
