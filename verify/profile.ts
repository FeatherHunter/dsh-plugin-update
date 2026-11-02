/**
 * verify/profile.ts —— 本仓的真机验证声明（base dsh-verify 的接入点）。
 *
 * base 的声明发现顺序固定是 verify/profile.ts → verify/profile.js → verify/profile.mjs，
 * 这里只陈述「事实」：包名、默认 profile、构建产物入口、有没有模型/技能/浏览器。
 * 声明写错会让 self-check 直接判 fail，所以每个字段都必须在本仓找得到对应实现。
 *
 * 刻意不声明的两个字段（base 会把对应检查保持 blocked，而不是被伪造成 pass）：
 * - pluginCacheDir：本产品没有「插件自己的 cache 目录」这一约定；运行日志由宿主写到
 *   <DSH_HOME>/logs/<pluginId>/，那是宿主级日志，不是 profile 内插件 cache 约定。
 * - pluginSettingsDir：本产品不写 <userprofile>/.dsh/<dir>/settings.yaml 这类插件设置。
 */
import { defineVerificationProfile } from 'dsh-featherhunter-plugin-base/real-machine-verification'

export default defineVerificationProfile({
  // 稳定 id：出现在 base 的 run 目录名与报告里。
  id: 'dsh-plugin-update',
  // npm 包名：profile 的 dependencies 与 node_modules 都必须装到这个名字上。
  packageName: 'dsh-plugin-update',
  // 本包发布物就是 DSH 的 web 面板 + 宿主接线，默认在 web profile 上验证。
  defaultProfile: 'web',
  // esbuild 产出的客户端闭包；装上的包里有这个文件、且版本对得上，才说明装的是本仓构建产物。
  clientEntry: 'dist/client.js',
  // 本包不安装模型、不随包发布技能、不实现 ticket-face、不定义 workspace backend。
  model: false,
  bundledSkills: false,
  workspaceBackends: [],
  // 页面级检查（instance-pages）走可选适配器：没有 playwright 时 base 判 blocked，绝不伪造通过。
  // 适配器只是开发期设施，不进 package.json dependencies，也不进 npm 发布物。
  browser: { module: 'verify/browser.mjs' },
})
