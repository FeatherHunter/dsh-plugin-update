// src/entry-batch.ts —— 壳：批量感知的更新入口件（实现已搬进 panel/batch/entry-batch.ts）。
//
// `dist/entry-batch.js` 是冻结出口（package.json `./entry-batch`，map #220 §5），路径与导出集一字不动。
// 逐名转出、不 `export *`（#159 冻结）。

export {
  batchEntrySummary,
  batchEntryStateKind,
  batchEntryLabelFor,
  batchEntryBilingualKeyFor,
  batchEntryBilingualValuesFor,
  batchEntryBilingualHTMLFor,
  batchEntryBilingualTextFor,
  mountUpdateBatchEntry,
} from './panel/batch/entry-batch.js'

export type {
  BatchEntryVariant,
  BatchEntryAutoCheck,
  BatchEntryOpenOn,
  BatchEntryStateKind,
  UpdateBatchEntryState,
  BatchEntrySummary,
  UpdateBatchEntryOptions,
  UpdateBatchEntryController,
} from './panel/batch/entry-batch.js'
