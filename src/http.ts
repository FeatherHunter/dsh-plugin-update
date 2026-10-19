// src/http.ts —— 壳：HTTP 万能插头（实现已搬进 host/http.ts，蓝图 §4 host 域）。
//
// 本文件只做公开面转出口：`dist/http.js` 是冻结出口（package.json `./http`，map #220 §5），
// 路径与导出集一字不动。浏览器侧只经这里拿挂载函数与电话调用形状；逻辑全在新位置。
// 逐名转出、不 `export *`：实现模块内部新加的东西不能顺手变成公开 API（#159 冻结）。

export {
  assertHttpRoutes,
  resolveHttpPath,
  httpTransportFailed,
  pickHttpDiag,
  shapeHttpReply,
  createHttpCall,
  mountUpdatePanelHttp,
  mountUpdateEntryHttp,
  mountUpdateBatchPanelHttp,
  HTTP_TRANSPORT_FAILED,
  DEFAULT_HTTP_CHECK_TIMEOUT_MS,
  DEFAULT_HTTP_INSTALL_TIMEOUT_MS,
  DEFAULT_HTTP_STATUS_TIMEOUT_MS,
  HTTP_PHONE_ACTIONS,
  HTTP_BATCH_ACTIONS,
  assertPollInterval,
} from './host/http.js'

export type {
  HttpPhoneAction,
  HttpBatchAction,
  HttpRoutes,
  HttpFetch,
  HttpTimeouts,
  CreateHttpCallOptions,
  UpdatePanelHttpOptions,
  UpdateEntryHttpOptions,
  UpdateBatchPanelHttpOptions,
} from './host/http.js'
