// src/core/i18n/styles.ts —— 单语块最小样式（原 src/bilingual.ts 的样式段）。
/**
 * 单语块最小样式（与 UPDATE_ENTRY_CSS 同缝注入）：
 * v2 起窄处竖排退场（一次只一种语言，不断行压力消失，#55 横排/竖排结论作废，排版改由 #67 仲裁）；
 * 只保留 overflow-wrap，不断行不溢出；不管字重字号。
 */
export const BILINGUAL_CSS = [
  '.dsh-upd-bi{display:inline;overflow-wrap:anywhere}',
  '.dsh-upd-bi [lang]{overflow-wrap:anywhere}',
].join('\n')
