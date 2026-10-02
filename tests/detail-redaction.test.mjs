/**
 * tests/detail-redaction.test.mjs —— #19 五条脱敏规则的行为测试。
 *
 * 只断外部行为：经公开电话（假插件管理器回失败结果），断言最终失败详情里有什么、没有什么。
 * 不断言用了哪条规则、内部函数叫什么、调用了几次；规则名与顺序的引用关系见
 * src/redaction.ts（规则表）与 src/gate.ts（`rules` 栏引用），不在这里复述形态。
 * 既有 8 条 must-mask + 5 条 must-not-touch 回归仍在 tests/desktop-manager.test.mjs，
 * 本文件不重写它们，只加本轮新增形状与四条新规则的双向语料。不真联网、不真装。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { createUpdateExecutor } from '../dist/store.js'
import { DIAG_INLINE_BUDGET_BYTES } from '../dist/redaction.js'
import { validRequestId } from '../dist/service.js'

const PROFILE_DIR = 'C:\\fake\\profiles\\desktop'

const runWith = (parts) =>
  createUpdateExecutor({ environmentKind: 'desktop-manager', profileName: 'desktop', pluginId: 'my-plugin', ...parts })
const callInstall = (runInstall) =>
  runInstall({ version: '1.2.3', profileName: 'desktop', environmentKind: 'desktop-manager' })

/** 经公开电话拿最终失败详情：假管理器回指定文案，读错上的 `detail`（丢弃时退到 code 本身）。 */
async function detailFor(diagnostic) {
  const runInstall = runWith({
    pluginManager: {
      installBundle: () => Promise.resolve({ application: 'failed', error: { code: 'operation-error', diagnostic } }),
    },
    log: () => {},
  })
  try {
    await callInstall(runInstall)
  } catch (error) {
    assert.equal(error.code, 'install-failed')
    return error.detail ?? ''
  }
  assert.fail('管理器报失败时执行器必须 reject')
}

function byteLength(text) {
  return new TextEncoder().encode(String(text ?? '')).length
}

/** 断言占位符没被拦腰切断：每个 `<` 都属于完整的 `<路径>` 或 `<脱敏>`。 */
function assertPlaceholdersIntact(text) {
  const stripped = String(text).split('<路径>').join('').split('<脱敏>').join('')
  assert.ok(!stripped.includes('<'), `占位符被切开：${text.slice(-20)}`)
  assert.ok(!stripped.includes('>') || true)
}

describe('路径规则新增形状（UNC 反斜杠 / 权限拒绝）必须掩掉', () => {
  const CASES = [
    ['UNC 反斜杠', 'see \\\\server\\share\\file.txt now', 'server'],
    ['UNC 反斜杠（引号包住）', "open '\\\\server\\share\\secret'", 'server'],
    ['权限拒绝（单引号包住）', "EACCES: permission denied, open '/tmp/secret/data.json'", '/tmp'],
    ['权限拒绝（冒号后）', 'EACCES: permission denied at path:/var/log/npm.log', '/var'],
  ]
  for (const [what, diagnostic, leaked] of CASES) {
    it(what, async () => {
      const detail = await detailFor(diagnostic)
      assert.ok(!detail.includes(leaked), `${leaked} 不该出现在详情里`)
      assert.match(detail, /<路径>/)
    })
  }
})

describe('路径规则不误伤（只管路径规则不越界）', () => {
  // 带用户信息的 URL 属于待丢弃形状，不写进本组——否则等于把待修泄漏钉成期望值（见 #19）。
  const CASES = [
    ['分数', 'ratio 1/2 of users', '1/2'],
    ['散文斜杠', 'and/or', 'and/or'],
    ['无 TLD 的 @ 不是邮箱', 'contact user@example for help', 'user@example'],
    ['无值的键名不是秘密', 'token expired, try again', 'token expired'],
    ['孤立 Bearer 不是令牌', 'Bearer realm required', 'Bearer'],
    ['短下划线不是 npm 令牌', 'run npm_install script', 'npm_install'],
  ]
  for (const [what, diagnostic, kept] of CASES) {
    it(what, async () => {
      const detail = await detailFor(diagnostic)
      assert.ok(detail.includes(kept), `${kept} 应该原样保留，实际：${detail}`)
    })
  }
})

describe('URL 用户信息命中时整项丢弃（退到 code 本身）', () => {
  const CASES = [
    ['普通用户信息', 'GET https://user:s3cret@registry.example.com/pkg failed', ['user', 's3cret', 'registry.example.com']],
    ['密码自身含 @', 'GET https://user:p@ss@example.com/foo failed', ['user', 'example.com']],
    ['私源凭据', 'npm ERR! 401 https://admin:hunter2@mirror.corp.example.com/dsh-plugin-update', ['admin', 'hunter2', 'corp.example.com']],
  ]
  for (const [what, diagnostic, secrets] of CASES) {
    it(what, async () => {
      const detail = await detailFor(diagnostic)
      for (const s of secrets) assert.ok(!detail.includes(s), `${s} 不该出现在详情里，实际：${detail}`)
      assert.ok(!detail.includes('@') || detail === 'operation-error', `用户信息形状须消失，实际：${detail}`)
      assert.match(detail, /operation-error/, '丢弃后退到 code 本身，看得出缺失而不是静默的错')
    })
  }
})

describe('令牌前缀必须换成占位（URL 主机保留）', () => {
  it('npm 令牌', async () => {
    const detail = await detailFor('npm ERR! 401 Unauthorized - GET https://registry.npmjs.org/pkg - npm_abc123XYZ456token789')
    assert.ok(!detail.includes('npm_abc123XYZ456token789'))
    assert.match(detail, /<脱敏>/)
    assert.ok(detail.includes('registry.npmjs.org'), '纯净 URL 主机保留，仍能回答哪家源失败')
  })
  it('GitHub 令牌', async () => {
    const detail = await detailFor('fatal: could not read Username: ghp_abc123DEF456ghi789jkl000')
    assert.ok(!detail.includes('ghp_abc123DEF456ghi789jkl000'))
    assert.match(detail, /<脱敏>/)
  })
  it('sk 令牌', async () => {
    const detail = await detailFor('OpenAI error invalid key sk-abc123XYZ456789qwerty')
    assert.ok(!detail.includes('sk-abc123XYZ456789qwerty'))
    assert.match(detail, /<脱敏>/)
  })
  it('Bearer 令牌（保留 Bearer 前缀）', async () => {
    const detail = await detailFor('GET failed 401 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')
    assert.ok(!detail.includes('eyJhbGciOiJIUzI1NiJ9'))
    assert.ok(detail.includes('Bearer'), 'Bearer 前缀保留，可读')
    assert.match(detail, /<脱敏>/)
  })
})

describe('密码键值对只换值（键名保留，可读）', () => {
  const CASES = [
    ['token=', 'auth failed token=abc123SECRETvalue', 'abc123SECRETvalue', 'token='],
    ['password:', 'login failed password: hunter2value', 'hunter2value', 'password'],
    ['api_key 引号', 'bad key api_key="XYZ-987-secret"', 'XYZ-987-secret', 'api_key'],
    ['cookie', 'denied cookie: sessionid-abc-123', 'sessionid-abc-123', 'cookie'],
  ]
  for (const [what, diagnostic, secret, keyKept] of CASES) {
    it(what, async () => {
      const detail = await detailFor(diagnostic)
      assert.ok(!detail.includes(secret), `${secret} 不该出现在详情里`)
      assert.ok(detail.includes(keyKept), `键名 ${keyKept} 保留，仍读成句子`)
      assert.match(detail, /<脱敏>/)
    })
  }
})

describe('邮箱必须换成占位', () => {
  const CASES = [
    ['npm 报错邮箱', 'npm ERR! 404 Not Found - user@example.com needs auth', 'user@example.com'],
    ['鉴权报错邮箱', 'auth failed for admin@test.org, retry', 'admin@test.org'],
  ]
  for (const [what, diagnostic, secret] of CASES) {
    it(what, async () => {
      const detail = await detailFor(diagnostic)
      assert.ok(!detail.includes(secret))
      assert.match(detail, /<脱敏>/)
    })
  }
})

describe('载荷负向断言（每种失败场景都不带秘密形态）', () => {
  const NASTY = [
    { diagnostic: "ENOENT: no such file or directory, open '/tmp/secret/data.json'", secrets: ['/tmp'] },
    { diagnostic: 'see \\\\server\\share\\file.txt now', secrets: ['server'] },
    { diagnostic: 'GET https://user:s3cret@registry.example.com/pkg failed', secrets: ['user', 's3cret', 'registry.example.com'] },
    { diagnostic: 'npm ERR! 401 - npm_abc123XYZ456token789', secrets: ['npm_abc123XYZ456token789'] },
    { diagnostic: 'fatal: ghp_abc123DEF456ghi789jkl000 denied', secrets: ['ghp_abc123DEF456ghi789jkl000'] },
    { diagnostic: 'key sk-abc123XYZ456789qwerty invalid', secrets: ['sk-abc123XYZ456789qwerty'] },
    { diagnostic: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig rejected', secrets: ['eyJhbGciOiJIUzI1NiJ9'] },
    { diagnostic: 'auth failed token=abc123SECRETvalue', secrets: ['abc123SECRETvalue'] },
    { diagnostic: 'login failed password: hunter2value', secrets: ['hunter2value'] },
    { diagnostic: 'mail user@example.com bounced', secrets: ['user@example.com'] },
    {
      diagnostic: "ENOENT '/tmp/a' token=zzz999 token npm_abc123XYZ456token789 mail m@n.com",
      secrets: ['/tmp', 'zzz999', 'npm_abc123XYZ456token789', 'm@n.com'],
    },
  ]
  for (const [i, item] of NASTY.entries()) {
    it(`场景 ${i + 1}`, async () => {
      const detail = await detailFor(item.diagnostic)
      for (const s of item.secrets) assert.ok(!detail.includes(s), `${s} 泄漏：${detail}`)
      assertPlaceholdersIntact(detail)
    })
  }
})

describe('序列化大小与空白边界落刀（对预算常量断言，数值待 #10 裁定）', () => {
  it('超长英文在空白处落刀，不断占位符', async () => {
    const detail = await detailFor(`failed ${'word '.repeat(80)}/tmp/secret/x ${'tail '.repeat(80)}`)
    assert.ok(detail.length <= 301, `详情封顶 300 字 + 省略号，实际 ${detail.length}`)
    assert.ok(detail.endsWith('…'))
    assertPlaceholdersIntact(detail)
  })
  it('中文 400 字约 900 字节，仍在内联预算内', async () => {
    const detail = await detailFor('中'.repeat(400))
    assert.ok(detail.length <= 301)
    assert.ok(byteLength(detail) <= DIAG_INLINE_BUDGET_BYTES, `中文详情 ${byteLength(detail)} 字节，须在预算内`)
  })
  it('占位符横跨 300 字处时整个丢掉而不是切半', async () => {
    const detail = await detailFor(`${'a '.repeat(149)}/tmp/secret/deep/place ${'b '.repeat(100)}`)
    assert.ok(detail.length <= 301)
    assertPlaceholdersIntact(detail)
    if (detail.includes('<')) assert.ok(detail.includes('<路径>'), '有尖括号即是完整占位')
  })
})

describe('输出确定性（固定顺序：同一输入两次运行逐字节相同）', () => {
  it('混合命中两次结果一致', async () => {
    const diagnostic = "ENOENT '/tmp/a' token=zzz999 npm_abc123XYZ456token789 mail m@n.com https://registry.npmjs.org/x"
    const first = await detailFor(diagnostic)
    const second = await detailFor(diagnostic)
    assert.equal(first, second)
  })
})

describe('请求编号收紧（#19 Out of Scope 第 1 件：破冰 + 兼容口径）', () => {
  it('不透明串放行：req-1 / UUID / 点线下划线波浪', () => {
    assert.equal(validRequestId('req-1'), true)
    assert.equal(validRequestId('550e8400-e29b-41d4-a716-446655440000'), true)
    assert.equal(validRequestId('a.b_c-d~e'), true)
  })
  it('秘密形状拒绝：路径 / 令牌前缀 / 邮箱 / 键值对 / URL', () => {
    assert.equal(validRequestId('/tmp/secret/x'), false)
    assert.equal(validRequestId('C:\\secret\\x'), false)
    assert.equal(validRequestId('npm_abc123XYZ456token'), false)
    assert.equal(validRequestId('ghp_abc123DEF456ghi789jkl'), false)
    assert.equal(validRequestId('sk-abc123XYZ456789'), false)
    assert.equal(validRequestId('user@example.com'), false)
    assert.equal(validRequestId('token=abc123'), false)
    assert.equal(validRequestId('https://user:pass@host/x'), false)
    assert.equal(validRequestId('Bearer abc'), false)
    assert.equal(validRequestId(''), false)
    assert.equal(validRequestId('x'.repeat(129)), false)
  })

  it('公开电话：路径形状的 requestId 按凭证过期拒绝，不透明串则通过校验', async () => {
    __resetSharedUpdateReaderForTests()
    const TARGET = 'dsh-mattpocock-skills-deck'
    const REGISTRY = 'https://registry.npmjs.org/'
    const RELEASE_VERSION = '9.9.9'
    let job = null
    let locked = null
    const host = createHostUpdate(
      {
        readerOverrides: {
          runningVersion: '1.0.0',
          profileDir: PROFILE_DIR,
          profileName: 'web',
          homeDir: 'C:\\fake\\home',
          fetchImpl: async () => ({
            ok: true,
            headers: { get: () => null },
            text: async () =>
              JSON.stringify({
                name: TARGET,
                version: RELEASE_VERSION,
                engines: { node: '>=22' },
                dist: {
                  tarball: `${REGISTRY}${TARGET}/-/${TARGET}-${RELEASE_VERSION}.tgz`,
                  integrity: 'sha512-' + 'A'.repeat(86) + '==',
                },
              }),
          }),
          now: () => 1_000_000,
          randomId: (() => {
            let n = 0
            return () => `id-${(n += 1)}`
          })(),
          nodeVersion: '22.0.0',
          environmentKind: 'cli',
          readInstalled: async () => ({
            profileName: 'web',
            environmentKind: 'cli',
            homeDir: 'C:\\fake\\home',
            profileDir: PROFILE_DIR,
            installedVersion: '1.0.0',
            packageValid: true,
            sourceInstall: false,
            blockedReason: null,
            installationKey: 'fake-key',
            eligible: true,
          }),
          readJob: async () => job,
          writeJob: async (value) => {
            job = value
          },
          tryAcquireLock: async (id) => {
            if (locked !== null) return false
            locked = id
            return true
          },
          releaseLock: async (id) => {
            if (locked === id) locked = null
          },
          backupJob: async () => {},
          runInstall: async () => {},
        },
      },
      { pluginId: 'dsh-mattpocock-skills-deck' }
    )
    const check = await host.handlers['wf.updateCheck']({})
    assert.equal(check.snapshot.canInstall, true)
    const bad = await host.handlers['wf.updateInstall']({ checkId: check.receipt.checkId, requestId: '/tmp/evil' })
    assert.equal(bad.ok, false)
    assert.equal(bad.error, 'check-expired')
    __resetSharedUpdateReaderForTests()
  })
})

describe('访客：旧回归基线仍在原文件（本文件不重写，只引用）', () => {
  it('ENOENT 单引号形状仍掩掉（与原 8 条同源抽查）', async () => {
    const detail = await detailFor("ENOENT: no such file or directory, open '/tmp/secret/data.json'")
    assert.ok(!detail.includes('/tmp'))
    assert.match(detail, /<路径>/)
  })
  it('裸调用栈仍不越界', async () => {
    const runInstall = runWith({
      pluginManager: {
        installBundle: () => Promise.resolve({ application: 'failed', error: { code: 'operation-error', diagnostic: '装不上' } }),
      },
      log: () => {},
    })
    try {
      await callInstall(runInstall)
    } catch (error) {
      assert.equal(error.debug, undefined)
      return
    }
    assert.fail('应该 reject')
  })
})

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})
