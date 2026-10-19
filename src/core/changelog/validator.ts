/**
 * src/core/changelog/validator.ts —— 包内 CHANGELOG.md 的结构校验与诊断（自旧 src/changelog.ts 拆出）。
 *
 * 一行一码，行号为原文件 1-based，诊断按行号排序；纯函数永不抛错。解析在 parse.ts。
 */

import {
  CHANGELOG_MAX_CHARS,
  CHANGELOG_MAX_BULLETS_PER_SECTION,
  normalizeCategoryMulti,
  isUnreleasedVersion,
  extractVersionDateAndYanked,
  isVersionIshWithoutNumber,
  normalizeSetextHeadings,
  looksLikeVersionHeading,
  matchAnyHeading,
  matchBulletBody,
  isFenceToggle,
  stripBreakingDecorations,
  isBreakingChangelogItem,
  parseChangelog,
  hasVisibleSections,
} from './parse.js'

/** 校验诊断（一行一码，行号为原文件 1-based，诊断按行号排序）。 */
export interface ChangelogDiagnostic {
  line: number;
  code: string;
  hint: string;
}

export interface ChangelogValidation {
  ok: boolean;
  diagnostics: ChangelogDiagnostic[];
}

/** 校验提示文（与终裁码表一字对应，仅 CI/发布前用，运行时永不调用）。 */
export const CHANGELOG_VALIDATE_HINTS: Record<string, string> = {
  E_VERSION_TITLE: '该标题不是合法版本号，其下条目已被忽略，请改成 ## [x.y.z] 形态',
  W_CATEGORY_OTHER: '非六类小节名（也不在别名表里），按作者原文标题原样显示、不丢内容；六类名：Added/Fixed/Changed/Deprecated/Removed/Security，亦收中文名（新增/修复/变更/弃用预告/移除/安全）与并列写法（Fixed / 修复）',
  E_BULLET_ORPHAN: '该条目不在任何版本节之下，已被忽略',
  W_BREAKING_MAYBE: '疑似破坏标记误写（缺冒号/拼写接近/位置疑似放错），请检查是否想写 BREAKING:/不兼容:',
  W_YANKED: '该版本已被标记撤回（yanked），安装不受影响，继续前请确认',
  W_TRUNCATED: '该类共 M 条，仅显示前 N 条',
  W_TRUNCATED_FILE: '文件超 64K，仅校验前 64K',
  W_EMPTY: '未解析到任何版本节，面板将显示中性提示',
};

/** 疑似破坏误写（仅行首可疑，不报正文中间散文）。 */
export function isMaybeBreakingMisuse(bulletBody: unknown): boolean {
  try {
    if (typeof bulletBody !== 'string') return false;
    const t = stripBreakingDecorations(bulletBody);
    if (!t) return false;
    if (isBreakingChangelogItem(bulletBody)) return false;
    if (/^breaking\s*$/i.test(t)) return true;
    if (/^breaking\s+[^:：]/i.test(t)) return true;
    if (/^breaking[^:：\s\w]/i.test(t)) return true;
    if (/^不兼容\s*$/i.test(t)) return true;
    if (/^不兼容\s*[^:：]/i.test(t)) return true;
    if (/^(braking|breking|breakign|brekaing|braeking|breakingg)\b/i.test(t)) return true;
    if (/^break[^i:：\s]/i.test(t)) return true;
    return false;
  } catch { return false; }
}

/** 纯校验（零新增导入，与 parse 共享扫描仪，永不抛错，仅 CI/发布前用）。 */
export function validateChangelog(markdown: unknown): ChangelogValidation {
  try {
    if (typeof markdown !== 'string' || !markdown.trim()) {
      return { ok: true, diagnostics: [{ line: 1, code: 'W_EMPTY', hint: CHANGELOG_VALIDATE_HINTS.W_EMPTY }] };
    }
    let raw = String(markdown).replace(/\r\n/g, String.fromCharCode(10));
    let fileTruncated = false;
    if (raw.length > CHANGELOG_MAX_CHARS) { fileTruncated = true; raw = raw.slice(0, CHANGELOG_MAX_CHARS); }
    const lines = normalizeSetextHeadings(raw.split(String.fromCharCode(10)));
    const diags: ChangelogDiagnostic[] = [];
    let inFence = false;
    let curValid = false;
    let curCat: string | null = null;
    let catLineByCat: Record<string, number> = {};
    let countByCat: Record<string, number> = {};
    let hasVisibleVersion = false;
    const flushCounts = function(): void {
      try {
        for (const k of Object.keys(countByCat)) {
          const n = countByCat[k];
          if (n > CHANGELOG_MAX_BULLETS_PER_SECTION) {
            const lineNo = catLineByCat[k] ? catLineByCat[k] : lines.length;
            const hint = '分类 ' + k + ' 共 ' + String(n) + ' 条，仅显示前 ' + String(CHANGELOG_MAX_BULLETS_PER_SECTION) + ' 条';
            diags.push({ line: lineNo, code: 'W_TRUNCATED', hint: hint });
          }
        }
      } catch { }
    };
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = String(lines[i] !== undefined && lines[i] !== null ? lines[i] : '');
      if (isFenceToggle(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      // 标题：1–4 级且像版本号（含 `## 1.0` 两段形态）→ 版本节；像版本但取不出号（`## 1`、`## 2026-10-14`）
      // → 诚实报 E_VERSION_TITLE；其余标题 → 小节标题（六类/别名可归一的走分类，别的保留原文标题）。
      const head = matchAnyHeading(line);
      const versionIsh = head !== null && head.level <= 4 && (looksLikeVersionHeading(head.text) || isVersionIshWithoutNumber(head.text));
      const vTitle = versionIsh && head !== null ? head.text : null;
      if (vTitle !== null) {
        flushCounts();
        catLineByCat = {};
        countByCat = {};
        curValid = false;
        curCat = null;
        const info = extractVersionDateAndYanked(vTitle);
        if (!info.version) {
          diags.push({ line: lineNo, code: 'E_VERSION_TITLE', hint: CHANGELOG_VALIDATE_HINTS.E_VERSION_TITLE });
          continue;
        }
        if (isUnreleasedVersion(info.version)) {
          curValid = false;
          continue;
        }
        curValid = true;
        hasVisibleVersion = true;
        if (info.yanked) { diags.push({ line: lineNo, code: 'W_YANKED', hint: CHANGELOG_VALIDATE_HINTS.W_YANKED }); }
        continue;
      }
      if (head) {
        const cat = normalizeCategoryMulti(head.text);
        if (!cat) {
          // 0.16.0：非六类小节名不再丢内容（parse 按作者原文标题原样收），故降为提示而非错误。
          curCat = null;
          if (curValid) diags.push({ line: lineNo, code: 'W_CATEGORY_OTHER', hint: CHANGELOG_VALIDATE_HINTS.W_CATEGORY_OTHER });
          continue;
        }
        if (!curValid) { curCat = null; continue; }
        curCat = cat;
        catLineByCat[cat] = lineNo;
        if (countByCat[cat] === undefined) countByCat[cat] = 0;
        continue;
      }
      const body = matchBulletBody(line);
      if (body !== null) {
        // 孤儿只剩一种：压根不在版本节里（版本节内没有分类标题的裸条目 0.16.0 起照样渲染）。
        if (!curValid) {
          diags.push({ line: lineNo, code: 'E_BULLET_ORPHAN', hint: CHANGELOG_VALIDATE_HINTS.E_BULLET_ORPHAN });
          continue;
        }
        const bucketCat = curCat;
        if (!bucketCat) { continue; }
        countByCat[bucketCat] = (countByCat[bucketCat] ? countByCat[bucketCat] : 0) + 1;
        if (isMaybeBreakingMisuse(body)) {
          diags.push({ line: lineNo, code: 'W_BREAKING_MAYBE', hint: CHANGELOG_VALIDATE_HINTS.W_BREAKING_MAYBE });
        }
        continue;
      }
    }
    flushCounts();
    if (fileTruncated) { diags.push({ line: lines.length, code: 'W_TRUNCATED_FILE', hint: CHANGELOG_VALIDATE_HINTS.W_TRUNCATED_FILE }); }
    if (!hasVisibleVersion) {
      let anyVisible = false;
      try {
        const parsed = parseChangelog(markdown);
        for (const e of parsed) { if (e && !isUnreleasedVersion((e as { version?: unknown }).version) && hasVisibleSections(e)) { anyVisible = true; break; } }
      } catch { anyVisible = false; }
      if (!anyVisible) { diags.push({ line: lines.length, code: 'W_EMPTY', hint: CHANGELOG_VALIDATE_HINTS.W_EMPTY }); }
    }
    diags.sort(function(a, b) { return a.line - b.line; });
    let ok = true;
    for (const d of diags) { if (d.code.charAt(0) === 'E') { ok = false; break; } }
    return { ok: ok, diagnostics: diags };
  } catch {
    return { ok: false, diagnostics: [] };
  }
}
