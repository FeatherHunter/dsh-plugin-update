// src/entry.ts —— 壳：更新入口件（实现已搬进 panel/entry.ts，蓝图 §4 panel 域）。
//
// `dist/entry.js` 是冻结出口（package.json `./entry`，map #220 §5），路径与导出集一字不动；
// 入口件的按钮 / 徽标 / 内嵌三态逻辑全在新位置。逐名转出、不 `export *`（#159 冻结）。

export {
  entryStateKind,
  entryBilingualKeyFor,
  entryBilingualValuesFor,
  entryBilingualHTMLFor,
  entryBilingualTextFor,
  entryLabelFor,
  entrySizingStyleFor,
  mountUpdateEntry,
  UPDATE_ENTRY_CSS,
} from './panel/entry.js'

export type {
  EntryVariant,
  EntryAutoCheck,
  EntryOpenOn,
  UpToDateDisplay,
  EntryTheme,
  EntryStateKind,
  UpdateEntryState,
  EntrySizing,
  UpdateEntryOptions,
  UpdateEntryController,
} from './panel/entry.js'
