/**
 * selftest/fixtures/templates/package/cordis-patch-template.ts —— 可安装插件包 cordis.patch.yml 的模板。
 *
 * 形状是坑（exploration/T1-wiring-notes.md §2.3）：顶层必须是 YAML 数组，
 * 写成顶层 mapping 会被 dsh 拒绝并回滚整个安装。这里固定成数组，生成器只做落盘。
 */
import type { FixtureSlot } from '../../identity/fixture-slots.ts'

/** 渲染 cordis.patch.yml 文本（顶层数组 + insert 一条）。 */
export function renderCordisPatch(slot: FixtureSlot): string {
  return [
    '# [TEST ONLY] selftest fixture（#265）：顶层必须是数组，否则 dsh 安装会被拒并回滚。',
    '- insert:',
    '    - id: ' + slot.packageName,
    '      name: ' + slot.packageName,
    '      config: {}',
    '',
  ].join('\n')
}
