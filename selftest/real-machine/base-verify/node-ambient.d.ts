/**
 * selftest/real-machine/base-verify/node-ambient.d.ts —— 本适配层额外用到的 Node 内建能力。
 *
 * 规则与 selftest/tooling/node-ambient.d.ts 同口径：不为测试引入 @types/node 依赖。
 * 这里只补一个 zlib：tarball 读取器要用 gzip 解压，且必须是纯 TS、不 exec tar。
 * （TS 的 include 通配会把本文件带进 selftest/tsconfig.tooling.json 的编译范围。）
 */
declare module 'node:zlib' {
  export function gunzipSync(data: Uint8Array): Uint8Array
}
