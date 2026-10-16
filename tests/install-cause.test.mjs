/**
 * tests/install-cause.test.mjs —— #155 安装失败翻译官：已知签名识别 + 诚实归因。
 *
 * 只走公开口（dist/host.js 的解释器 + buildDiag，dist/panel.js 的怎么办句与复制块）：
 * 不测内部实现。真值表：三归因（主包/他包/未知）× 时间可算/不可算 × 正/对抗/降级。
 * 时间断言只锁相对关系（窗口优先 unlock = published + N minutes；回退 unlock = published + (now - cutoff)），
 * 不锁墙钟（TZ 无关）；文案断言只锁关键句（拦截/另一包/放宽策略），不锁完整句子（防文案微调连坐）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  blameCausePackage,
  causePackageNameOf,
  createCauseInterpreter,
  formatUnlockAt,
  interpretInstallCause,
  buildDiag,
} from '../dist/host.js'
import { buildUpdateDiagCopy, causeRemedyText } from '../dist/panel.js'

// 现场实证形状（2026-10-16 四家连锁失败的安装器原话，已脱敏留结构）。
const AGE_DETAIL = [
  '✗ dshmarket@1.66.28: This version was published less than 1440 minutes ago (2026-10-16T05:58:34.000Z).',
  'The minimumReleaseAge cutoff for this version is 2026-10-15T07:34:55.413Z.',
  '',
  'Failed to install dshmarket@1.66.28.',
  'Command failed with exit code 1: pnpm add -g dshmarket@1.66.28',
  ' ELIFECYCLE  Command failed with exit code 1.',
  '',
  'Progress: resolved 1, reused 0, downloaded 0, added 0',
  '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION]',
].join('\n')

const PUBLISHED = Date.parse('2026-10-16T05:58:34.000Z')
const CUTOFF = Date.parse('2026-10-15T07:34:55.413Z')
const NOW = Date.parse('2026-10-16T08:30:00.000Z')
// 窗口恒等式（优先）：unlock = published + 报文自述的 1440 minutes。
// 现场验算：2026-10-16T05:58:34Z + 1440min = 10-17 05:58:34Z（= 北京 13:58），与票据验收一致。
// 门限反推（回退）：unlock = published + (now - cutoff)，仅无窗口时用。
const UNLOCK = PUBLISHED + 1440 * 60_000
const UNLOCK_FALLBACK = PUBLISHED + (NOW - CUTOFF)

function baseInput(over = {}) {
  return {
    errorCode: 'install-failed',
    stage: 'exec',
    detail: AGE_DETAIL,
    targetPackageName: 'dshmarket',
    nowMs: NOW,
    ...over,
  }
}

describe('认：签名表只认见过且有机器码的', () => {
  it('正样本命中：抠出包规格/版本/双时间/解封时刻', () => {
    const out = interpretInstallCause(baseInput())
    assert.ok(out, '应命中')
    assert.equal(out.kind, 'minimum-release-age')
    assert.equal(out.spec, 'dshmarket@1.66.28')
    assert.equal(out.packageName, 'dshmarket')
    assert.equal(out.packageVersion, '1.66.28')
    assert.equal(out.publishedAtMs, PUBLISHED)
    assert.equal(out.cutoffMs, CUTOFF)
    assert.equal(out.unlockAtMs, UNLOCK)
    assert.ok(UNLOCK > NOW, '反推的解封时刻应在调用之后')
  })

  it('错码不认：同样文本配 check-failed 即作废', () => {
    assert.equal(interpretInstallCause(baseInput({ errorCode: 'check-failed' })), null)
  })

  it('错阶段不认：fetch-release 即作废', () => {
    assert.equal(interpretInstallCause(baseInput({ stage: 'fetch-release' })), null)
  })

  it('形似但无机器码不认：只有 minimumReleaseAge 字样', () => {
    const lookalike = 'minimumReleaseAge policy blocked the install, please retry later'
    assert.equal(interpretInstallCause(baseInput({ detail: lookalike })), null)
  })

  it('有机器码无事实不认：光秃 token 即作废', () => {
    assert.equal(interpretInstallCause(baseInput({ detail: '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION]' })), null)
  })

  it('事实不全不认：缺发布时间与门限', () => {
    const partial = '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] blocked dshmarket@1.66.28, no timestamps here'
    assert.equal(interpretInstallCause(baseInput({ detail: partial })), null)
  })

  it('空输入永不抛：一律 null', () => {
    for (const bad of [null, undefined, {}, { errorCode: '' }, { errorCode: 'install-failed' }]) {
      assert.equal(interpretInstallCause(bad), null)
    }
  })
})

describe('判：三值归因只排除、不定罪', () => {
  it('主包自己：肇事包 == 目标包', () => {
    assert.equal(interpretInstallCause(baseInput()).blame, 'target')
  })

  it('非主包：肇事包 != 目标包，只摘嫌疑不断关系', () => {
    assert.equal(interpretInstallCause(baseInput({ targetPackageName: 'memo-plugin' })).blame, 'other-package')
  })

  it('未知：没有目标名即不排除，退回通用', () => {
    assert.equal(interpretInstallCause(baseInput({ targetPackageName: undefined })).blame, 'unknown')
    assert.equal(interpretInstallCause(baseInput({ targetPackageName: '' })).blame, 'unknown')
  })

  it('blame 大小写不敏感：注册表名全小写，目标大小写脏即容', () => {
    assert.equal(blameCausePackage('dshmarket@1.66.28', 'DSHMarket'), 'target')
  })

  it('剥版本认 scope 包：@scope/pkg@1.2.3 剥出 @scope/pkg', () => {
    assert.equal(causePackageNameOf('@scope/pkg@1.2.3'), '@scope/pkg')
    assert.equal(causePackageNameOf('dshmarket@1.66.28'), 'dshmarket')
    assert.equal(causePackageNameOf(''), '')
    assert.equal(blameCausePackage('@scope/pkg@1.2.3', '@scope/pkg'), 'target')
  })
})

describe('算：解封时间反推，不硬编码 24h', () => {
  it('窗口优先：报文自述 1440 minutes 即 published + 1440min（= 北京次日 13:58）', () => {
    const out = interpretInstallCause(baseInput())
    assert.ok(out, '应命中')
    assert.equal(out.windowMinutes, 1440)
    assert.equal(out.unlockAtMs, UNLOCK)
    assert.equal(UNLOCK, Date.parse('2026-10-17T05:58:34.000Z'))
  })

  it('无窗口回退门限反推：删掉自述句即用 published + (now - cutoff)', () => {
    const noWindow = AGE_DETAIL.replace(' less than 1440 minutes ago', '')
    const out = interpretInstallCause(baseInput({ detail: noWindow }))
    assert.ok(out, '签名仍认（机器码与双时间在）')
    assert.equal(out.windowMinutes, null)
    assert.equal(out.unlockAtMs, UNLOCK_FALLBACK)
  })

  it('窗口离谱回退：0 分钟与超十年都当没说', () => {
    for (const weird of [' less than 1440 minutes ago', ' less than 0 minutes ago', ' less than 9999999 minutes ago']) {
      const variant = weird === ' less than 1440 minutes ago'
        ? AGE_DETAIL
        : AGE_DETAIL.replace(' less than 1440 minutes ago', weird)
      const out = interpretInstallCause(baseInput({ detail: variant }))
      assert.ok(out, `应命中：${weird}`)
      if (weird === ' less than 1440 minutes ago') {
        assert.equal(out.unlockAtMs, UNLOCK)
      } else {
        assert.equal(out.windowMinutes, null, `离谱窗口应作废：${weird}`)
        assert.equal(out.unlockAtMs, UNLOCK_FALLBACK, '作废即回退门限反推')
      }
    }
  })

  it('窗口已过即省略：现在已过解封时刻，不叫人等过去的时间', () => {
    const out = interpretInstallCause(baseInput({ nowMs: UNLOCK + 3_600_000 }))
    assert.ok(out, '签名仍认')
    assert.ok(!('unlockAtMs' in out), '已解封就不给时间，文案只留"重试/找宿主"')
  })

  it('坏时间即省略时间：发布时间非法则无 unlock', () => {
    // ISO 形但不存在的日历时刻：形状门过、Date.parse 挂——认得出种类，算不出时间。
    const badTime = AGE_DETAIL.replace('2026-10-16T05:58:34.000Z', '2026-13-45T99:99:99.000Z')
    const out = interpretInstallCause(baseInput({ detail: badTime }))
    assert.ok(out, '签名仍认（机器码在）')
    assert.equal(out.publishedAtMs, null)
    assert.ok(!('unlockAtMs' in out), '算不出即省略，不给假时间')
  })

  it('解封已过即省略：撒谎数据（published < cutoff）不给过去的时间', () => {
    const lying = AGE_DETAIL.replace('2026-10-16T05:58:34.000Z', '2026-10-14T05:58:34.000Z')
    const out = interpretInstallCause(baseInput({ detail: lying }))
    assert.ok(out, '签名仍认')
    assert.ok(!('unlockAtMs' in out), '已过的解封时刻不如不说')
  })

  it('formatUnlockAt：非法回 null，合法给短时间（含时分）', () => {
    assert.equal(formatUnlockAt(null, 'zh'), null)
    assert.equal(formatUnlockAt(-1, 'zh'), null)
    const text = formatUnlockAt(UNLOCK, 'zh')
    assert.ok(text && /\d{1,2}:\d{2}/.test(text), `应含时分，实际 ${text}`)
    const en = formatUnlockAt(UNLOCK, 'en')
    assert.ok(en && /\d{1,2}:\d{2}/.test(en), `英文亦含时分，实际 ${en}`)
  })
})

describe('表达：四格怎么办句 + 降级', () => {
  const cause = { kind: 'minimum-release-age', package: 'dshmarket@1.66.28', unlockAtMs: UNLOCK, target: 'dshmarket' }

  it('主包 × 可算：点名本插件 + 给时间 + 指宿主', () => {
    const text = causeRemedyText(cause, 'zh')
    assert.ok(text.includes('本插件'), '应点名本插件')
    assert.ok(text.includes('dshmarket@1.66.28'), '应带肇事包规格')
    assert.ok(/\d{1,2}:\d{2}/.test(text), '应带解封时分')
    assert.ok(text.includes('宿主'), '应指宿主')
  })

  it('他包 × 可算：摘嫌疑 + 不说关系 + 给时间', () => {
    const text = causeRemedyText({ ...cause, target: 'memo-plugin' }, 'zh')
    assert.ok(text.includes('另一包'), '应说另一包')
    assert.ok(text.includes('不是本插件的直接问题'), '只摘嫌疑')
    assert.ok(!text.includes('传递依赖') && !text.includes('邻居'), '不断关系')
  })

  it('主包 × 不可算：无时间版只留动作', () => {
    const text = causeRemedyText({ ...cause, unlockAtMs: undefined }, 'zh')
    assert.ok(text.includes('稍后重试'), '应留动作')
    assert.ok(!/\d{1,2}:\d{2}/.test(text), '无时间即不给时分')
  })

  it('未知归因/未知签名/空包：回 null，调用方走通用', () => {
    assert.equal(causeRemedyText({ ...cause, target: '' }, 'zh'), null)
    assert.equal(causeRemedyText({ ...cause, kind: 'no-such-kind' }, 'zh'), null)
    assert.equal(causeRemedyText({ ...cause, package: '' }, 'zh'), null)
    assert.equal(causeRemedyText(null, 'zh'), null)
  })

  it('英文亦四格：same facts, English words', () => {
    const text = causeRemedyText(cause, 'en')
    assert.ok(text.includes('dshmarket@1.66.28') && text.includes('host'), '英文应带包与 host')
  })
})

describe('贯通：diag 落地 → 复制块换句，认不出则老路一字不动', () => {
  function diagFor(target, detail = AGE_DETAIL) {
    return buildDiag({
      errorCode: 'install-failed',
      phoneKind: 'update-install',
      error: { detail, exitCode: 1 },
      targetPackageName: target,
      nowMs: NOW,
    })
  }

  it('buildDiag 附机读结论三键', () => {
    const diag = diagFor('dshmarket')
    assert.equal(diag.causeKind, 'minimum-release-age')
    assert.equal(diag.causePackage, 'dshmarket@1.66.28')
    assert.equal(diag.causeUnlockAt, UNLOCK)
  })

  it('认不出即无 cause 键：通用 diag 一字不动', () => {
    const diag = buildDiag({
      errorCode: 'install-failed',
      phoneKind: 'update-install',
      error: { detail: 'plain old failure, nothing known', exitCode: 1 },
      targetPackageName: 'dshmarket',
      nowMs: NOW,
    })
    assert.ok(!('causeKind' in diag) && !('causePackage' in diag) && !('causeUnlockAt' in diag))
  })

  it('复制块怎么办换句：有结论即专项，无结论即通用', () => {
    const withCause = buildUpdateDiagCopy({ code: 'install-failed', pluginId: 'dshmarket', diag: diagFor('dshmarket') }, 'zh')
    assert.ok(withCause.includes('本插件'), '有结论应换专项句')
    assert.ok(!withCause.includes('请查阅诊断摘要'), '专项句应替换通用句')
    const generic = buildUpdateDiagCopy(
      { code: 'install-failed', pluginId: 'dshmarket', diag: diagFor('dshmarket', 'plain old failure') },
      'zh',
    )
    assert.ok(generic.includes('请查阅诊断摘要'), '无结论走通用老话')
  })

  it('超墙仍保结论：detail 再大也不丢 verdict', () => {
    const big = AGE_DETAIL + '\n' + 'x'.repeat(5000)
    const diag = diagFor('dshmarket', big)
    assert.equal(diag.causeKind, 'minimum-release-age')
    assert.equal(diag.causePackage, 'dshmarket@1.66.28')
  })

  it('F2 回归：有结论无目标包名即 unknown，不许谎称他包', () => {
    const full = diagFor('dshmarket')
    const { targetPackageName, ...noTarget } = full
    assert.ok(!('targetPackageName' in noTarget), '先确认目标包名确已拿掉')
    const text = buildUpdateDiagCopy({ code: 'install-failed', pluginId: 'dshmarket', diag: noTarget }, 'zh')
    assert.ok(!text.includes('另一包'), '未知归因不许说另一包')
    assert.ok(text.includes('请查阅诊断摘要'), '退回通用老话')
  })

  it('F8 回归：非 exec 阶段同样文本也不问（统计口只收安装尝试）', () => {
    const diag = buildDiag({
      errorCode: 'check-failed',
      phoneKind: 'update-check',
      error: { detail: AGE_DETAIL },
      targetPackageName: 'dshmarket',
      nowMs: NOW,
    })
    assert.ok(!('causeKind' in diag), '查侧不问翻译官')
  })
})

describe('统计口：指导下一种签名先做哪个', () => {
  it('隔离实例计数：命中记 kind，未中记 unrecognized', () => {
    const inst = createCauseInterpreter()
    assert.ok(inst.interpret(baseInput()), '应命中')
    assert.equal(inst.interpret(baseInput({ errorCode: 'check-failed' })), null)
    assert.deepEqual(inst.counts(), { recognized: { 'minimum-release-age': 1 }, unrecognized: 1 })
  })
})
