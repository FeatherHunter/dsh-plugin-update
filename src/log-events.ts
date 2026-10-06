/**
 * src/log-events.ts —— 日志事件名（单源）。
 *
 * 宿主发射（host/store）、面板路牌（panel）、测试断言都从这里取：
 * 改名即全改，不存在“发射侧改了、路牌还是旧名”的静默分叉。
 * 本文件零导入，宿主/面板同缝（与 redaction 同口径）。
 */
export const LOG_EVENT_CALL = 'host.call'
export const LOG_EVENT_CALL_FAIL = 'host.call.fail'
export const LOG_EVENT_INSTALL_EXEC = 'update.install.exec'
