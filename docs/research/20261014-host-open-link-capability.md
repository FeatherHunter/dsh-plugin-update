# 宿主外链能力：日志里的链接怎么真跳转（wayfinder #111）

> 调查时间：2026-10-14 ｜ 调查方式：只读解析宿主档案 + 只读本仓源码 + 只在 `docs/research/` 落这一个文件（未改 `src/`、`tests/`、未跑测试与构建、未装任何东西）
> 取证环境：Windows ｜ 宿主档案 `D:\DeepseekHarness\resources\app.asar`（121,348,951 字节，**单个档案文件，Test-Path 读不到内部路径，grep 工具也穿不进去**）
> 档案内版本：`asar:dsh/package.json` → `"@deepseek-ai/dsh-desktop-runtime"` `"version": "0.2.0-rc.2"`（与 `docs/host-install-exits.md:8` 抄件同一版）
> 本机 DSH 外壳版本：`D:\DeepseekHarness\version` = `44.0.0`；`app.asar.unpacked\dsh\node_modules` 里有 `@deepseek-ai/dsh-desktop-host`
> 证据等级标注：**【实测】**＝本次亲手读到原文 ｜ **【旁证】**＝别人（宿主自带件／友商插件）已这么写 ｜ **【未验证】**＝没读到或读不到
> 档案内路径一律写 `asar:` 前缀，行号是**档案内文件**的行号（磁盘上没有同名文件可对齐；沿用 `docs/host-install-exits.md:6-7` 的取证口径）

---

## 0. 三条承重结论（先看这个）

1. **宿主没有给插件开「打开外链」的 API，但宿主自己的接收端已经把这件事做完了。** 官方桌面版主窗口挂了一个全接收的 `setWindowOpenHandler`：任何 `target="_blank"` / `window.open` 的新窗口请求都被**拒开新窗**，但 http/https 的 URL 被转交 `shell.openExternal(url)` 真跳系统浏览器（`asar:lib/main.js:11109-11112`）。【实测】
2. **`<a href="https://…" target="_blank" rel="noopener noreferrer">` 在面板里就是「真跳转」，面板侧零 API 也能落地。** 面板不是 iframe／webview，是注入宿主 React 树的同 DOM 节点（`references/ui-plugin.md`【实测】）；且同仓生态里的真实插件 `dsh-life-pack` 已经这么写、这么发（`dsh-life-pack/dist/client.js:8431-8442`）【实测】。宿主官方件自己也用同一形态：`MarkdownAnchor` 给外链同时挂 `target="_blank" rel="noopener noreferrer"` **和** 一个 `onClick` → `openExternalLink`（`dsh-client-ui-primitives/lib/index.js:11456-11477`）【实测】。
3. **本包今天一个 `<a>` 都不发**：`src/` 全树 grep `<a `/`href=`/`target=`/`window.open` **零命中**；更新日志条目走 `escapeChangelogHtml` 落成纯文本 `<li>`（`src/changelog.ts:489`），所以日志里的 markdown 链接现在是**字面文本**。这不是「没接线」，是「还没渲染」。而这条被 ADR 明确列进过**非目标**：`docs/adr/0002-changelog-display-trust.md:54`「非目标：**裸 URL 可点**……明确不做」——本票等于要翻这条旧决议，落地时必须同步改 ADR，README 只收做法。

---

## 1. 宿主侧能力清单（问题 1）

下面每条都给了档案内出处，按「谁真的会把 URL 交出去」排序。

### 1.1 主窗口的新窗口请求：兜底全收，真跳系统浏览器【实测】

```js
// asar:lib/main.js:11074  createWindow(preload, show = false, primary = false)
window.webContents.setWindowOpenHandler(({ url }) => {
  if (["http:", "https:"].includes(new URL(url).protocol)) shell.openExternal(url);
  return { action: "deny" };
});                                                     // :11109-11112
```

- 触发面：`createWindow()` 造出来的每个窗口都在 `webPreferences` 里 `sandbox: true, contextIsolation: true, webSecurity: true, nodeIntegration: false`（`asar:lib/main.js:11099-11107`），这段 `setWindowOpenHandler` 就挂在它的 `webContents` 上。
- 语义：**deny 一切新窗**（所以面板里点外链不会在应用里冒出个 Electron 窗口），但 http/https 一条不落地 `shell.openExternal` 出去。`shell` 来自 Electron 主进程，落点是系统默认浏览器。
- 只收 `http:` / `https:`：`mailto:`、`app:` 之类到这里既不跳也不报。
- 注意这里是**同步**调用、不看返回值，跟 `asar:lib/main.js:6063-6067`（平台账号内嵌页那条，只收 `https:` 且额外禁 `username/password`，还 `.catch(()=>{})`）**不是同一道门**，两个窗口各挂各的。

### 1.2 同窗导航兜底：`will-navigate` 也把 http/https 交出去【实测】

```js
// asar:lib/main.js:11171-11178（同一个主窗口）
window.webContents.on("will-navigate", (event, url) => {
  const destination = new URL(url);
  const current = new URL(window.webContents.getURL());
  if (destination.protocol !== `dsh-app:` && !(destination.protocol === "http:" && destination.origin === current.origin)) {
    event.preventDefault();
    if (["http:", "https:"].includes(destination.protocol)) shell.openExternal(url);
  }
});
```

这条是给「没有 `target="_blank"` 的普通 `<a href>`」兜的：跨源链接被拦下改走系统浏览器。**但它对同源 http 链接放行**——面板所在页面就是 `http://127.0.0.1:<port>`（本会话 GUI 就是 `http://127.0.0.1:19387`），所以同源链接会**在原窗口里导航走**，面板连同会话一起没。⇒ 面板只该发外链（https 或异源 http），且**必须**带 `target="_blank"`，不能指望这条兜底当主路。

### 1.3 渲染进程有没有现成的「打开外链」桥？没有【实测】

- `asar:lib/preload-app.cjs` 是主窗口 preload，`contextBridge.exposeInMainWorld` 只暴露了：目录选择器 `__DSH_DIRECTORY_PICKER__`（`:861`）、桌面窗口/快捷键/更新对话框（`:793-831`）、引导（`:846/864-865`）、平台账号 `open/setBounds/close`（`:868-870`，那是平台内嵌页的登录窗）、语言引导（`:878`）。
- `DESKTOP_IPC.browserOpenRequested = "dsh-desktop:browser-open-requested"`（`asar:lib/preload-app.cjs:19`、`asar:lib/main.js:6207`）唯一的发送点在宿主自己内部（`asar:lib/main.js:9733 owner.send(...)`），是「让应用内浏览器侧栏打开这个 URL」的宿主私有请求，**没有任何面向插件／页面的入口**。
- 结论：渲染进程**没有** `openExternal` 同义词可用；想开外链只能靠 1.1 这条窗口级接收端。

### 1.4 宿主 web 外壳自己怎么发外链（最权威的用法抄件）【实测】

| 宿主件 | 位置 | 写法 |
| --- | --- | --- |
| 聊天正文 | `asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js:12435-12438` | `openExternalLink: (url) => { if (linkOpening === "sidebar" && …browser tab 存在) ctx.sidebarRight.openTab("browser", {params:{url}}); else window.open(url, "_blank", "noopener,noreferrer") }` |
| Markdown 锚点 | `asar:…/dsh-client-ui-primitives/lib/index.js:11456-11477` | 外链：`<a href target="_blank" rel="noopener noreferrer">` **且** `onClick`（只在无修饰键的主键点击时 `preventDefault()` 后调 `openExternalLink`） |
| 侧栏浏览器 | `asar:…/dsh-client-ui-sidebar-browser/lib/client.js:262` | `window.open(externalUrl, "_blank", "noopener,noreferrer")` |
| 终端 | `asar:…/dsh-client-ui-sidebar-terminal/lib/client.terminal.js:7320-7321` | `mainWindow.open(e, "_blank", "noopener")` |

⇒ **`window.open(url,'_blank','noopener,noreferrer')` 就是宿主自认的外链出口**（桌面版靠 1.1 收，web 版靠浏览器自己收）。"sidebar" 那一支是宿主自己才有的特权（应用内浏览器页签），插件拿不到。

### 1.5 插件能不能碰 `shell.openExternal`：不能【实测】

`asar:lib/main.js` 里 `shell.openExternal` 一共 5 处（`:6065`、`:9235`、`:11110`、`:11176`、`:11347`），**全部在主进程**，没有一处是通过 IPC 暴露给渲染进程的；`contextIsolation: true` + `sandbox: true` 也堵死了从页面侧够主进程的路。插件侧唯一合法形状就是「发一个会被 1.1 接住的请求」。

### 1.6 `pluginManager` 与本次问题无关【实测】

`@deepseek-ai/dsh-plugin-manager` 的公开面（`lib/typert.host.js` 的 `installBundle`／`removeBundle`／`cancelInstall`，抄件见 `docs/host-install-exits.md:30-33`）里没有任何打开 URL 的方法；它管装包。种票里提到的 `@deepseek-ai/dsh-client-ui-plugin-manager`（`lib/client.js`）是插件页 UI，同样只有 `PANEL_ID`／slot 注册，没有外链出口。

---

## 2. 面板发 `<a target="_blank">` 会怎样（问题 2）

### 2.1 面板在哪儿：同 DOM，不是 iframe／webview【实测＋旁证】

- 官方插件开发指引（宿主自带技能）原文：`"Do not replace the app root or append a second application to document.body."`、`"React comes from the browser module table"`、`"registers a lazy factory into conversation.composer.dock through ctx.slots.inject and ctx.slots.register"` —— 出处 `asar:dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/ui-plugin.md`（标题即「UI plugins in the Web page」）。文档标题与措辞都指明：**插件 UI 活在宿主那个 Web 页面里**。
- 生态旁证（更硬的现场证据）：`dsh-life-pack` 的 `package.json` 声明 `"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-slots"] } }`，`dist/client.js:8842-8852` 走 `ctx.slots.inject("settings.section", () => ctx.slots.register(...))` 注册成宿主设置页的一节；同一文件 `:8431-8442`、`:8450-8458` 直接 `react.createElement("a", { href, target: "_blank", rel: "noreferrer", … })`。
- `dsh-life-pack@0.3.54` 的 dependencies 里就有 `dsh-plugin-update: latest`（同仓主目录 `package.json`）——它是本包的现实消费方，它的外链写法就是本包可直接抄的成品。
- 其余 slot 型 UI（`settings.section`、`conversation.composer.dock`、`sidebar.panellist`…）都是宿主 React 树里的挂载点；`asar:…/dsh-client-ui-plugin-manager/README.md:100` 也把自家面板描述成「registers the plugins sidebar entry and its main panel through `ctx.slots.inject()`……follow late slot declaration, locale changes and teardown」，是同一套机制。

⇒ 面板用的 `window` 就是宿主页面的 `window`：1.1 的 `setWindowOpenHandler` 对它照常生效。

### 2.2 CSP：宿主 web 外壳自己没有 CSP，但服务端响应头未验证【实测＋未验证】

- `asar:dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html` 全文只有 9 行 meta（charset／viewport／manifest／icon×2／title），**没有 `Content-Security-Policy` meta**。【实测】
- 档案里所有 CSP 都属别的页：平台账号内嵌页（`default-src 'none'; frame-ancestors 'none'`，`dsh-deepseek-account-platform/lib/index.js:1115`）、会话媒体引用（`sandbox; default-src 'none'`，`dsh-api-session-controller/lib/index.js:2342`）、文档预览用的 Blob iframe（`dsh-client-ui-sidebar-documentpreview/lib/client.js:3846`）、桌面 welcome/update-dialog 等 `renderer/*.html`。**没有一条落在 web 外壳上**。【实测】
- 服务端响应头：本会话对 `http://127.0.0.1:19387/` 做了无凭据 GET，得 **401**，响应头只有 `Cache-Control / Vary / Date / Connection / Keep-Alive / Transfer-Encoding / Content-Type`——**401 响应上没有 CSP，但这不能证明认证后的外壳页也没有**。⇒ 记为【未验证】，见 §6 实验 E4（一条带凭据的 `curl -I` 就结案）。A（登出）不影响上面的结论。

### 2.3 宿主 Web GUI（127.0.0.1:19387）与桌面版是两条落地

- 本机 profile：`C:\Users\辰辰洋洋\.dsh\profiles\desktop\node_modules\dsh-plugin-update` 与 `…\profiles\web\node_modules\dsh-plugin-update` **都存在**（`web` 那份只跟 `dsh-mattpocock-skills-deck` 并列）。本包的宿主演进本来就承认两条：README 的宿主出口表列了「官方桌面版（宿主进程内的插件管理器）」「普通 DSH 宿主」，范围名 `web` 与 `desktop` 各装一份（`README.md:431-438`、`README.md:151`）。
- 因此外链必须**两条都成立**：
  - `desktop`：走 §1.1，`shell.openExternal` 真跳系统浏览器（**这条路是 `target="_blank"` 唯一的实现，也是本票的答案**）。
  - `web`（浏览器打开 `http://127.0.0.1:19387`）：没有 Electron 接收端，`window.open(...,"_blank","noopener,noreferrer")` 就是一个普通新标签页；因为是用户点击手势触发的，主流浏览器不拦，但**这属于浏览器行为，本仓管不到**。宿主自己走的就是这条（§1.4 的三处 `window.open`），可以认为宿主已接受该风险。
- 我**没有**在真机点过任何一次（约束禁止跑起来验证，且这属于宿主侧行为），所以「点一下真跳」这件事本身是【未验证】——见 §6 实验 E1/E2，都只要一次手动点击。

---

## 3. 路线表（每条：要什么／花什么／会怎么坏）

| 路线 | 形状 | 要什么 | 花什么 | 会怎么坏 |
| --- | --- | --- | --- | --- |
| **A. 面板直接发 `<a href target="_blank" rel="noopener noreferrer">`** | HTML 里多一个 `target`／`rel` | 什么也不要；桌面版靠 §1.1，web 版靠浏览器 | 面板改动最小；无新选项、无新电话 | ① web 版被浏览器弹窗拦截器挡 → 点了没反应；② 未来宿主若改 `setWindowOpenHandler` 成纯 `deny`，外链集体失效且**静默**；③ 无法做「应用内浏览器」这类宿主偏好（宿主自己的 `linkOpening === "sidebar"` 支路）；④ 忘写 `target="_blank"` 就退化成 §1.2 同源/跨源两套行为，同源会把面板导航掉 |
| **B. `mountUpdatePanel({ openLink })` 回调**（与本仓 `copyText` 同款可选落地） | 新增 `openLink?: (url: string) => void \| Promise<void>`，面板拦住锚点击后交给它 | 集成方给一个函数；不给便有默认实现 | 面板 `UpdatePanelOptions` +1 键、类型 +1、`UpdatePanelActionKind` 不变、测试 +N | ① 集成方忘了传 → 必须有一个不吵不闹的默认（用 A），否则「可点没反应」的死链；② 回调抛错要吞掉（同 `onCloseRequested` 的 try/catch 口径） |
| **C. 新宿主电话（`<prefix>.openLink`）** | `createHostUpdate` 注册第 5 个电话，面板经 `call` 调 | 集成方在宿主侧实现一个方法（宿主侧才知道的 UI 偏好、侧栏、日志） | 动「四电话」公开契约（README `:17`「**四个电话**」）、快照六字段冻结口径、宿主+面板双份改动、HTTP 直挂要另开路由 | ① 违反本包既有纪律：`README.md:639` 把「向后兼容的扩展」限定为**可选配置键／可选 readerOverrides／新增宿主种类与路由取值**，新增电话不在其中；② HTTP 直挂形态没有 `host.call`（`README.md:181`），该电话在浏览器直挂场景**不存在**，等于同一条产品决策要维护两套出口；③ 外链是**纯浏览器事件**，让宿主代办要多一跳网络往返，收益不明 |
| **D. 插件自己去够 `shell.openExternal`** | `ctx.get('shell')` / 新 IPC | —— | —— | **不存在这条路**：§1.5。【实测】 |
| **E. 「在应用内浏览器打开」** | 走宿主侧栏 browser 页签 | 宿主特权：`ctx.sidebarRight.openTab("browser", {params:{url}})` 只有宿主自家件在用（`chat/lib/client.js:12436`）；桌面版另有宿主私有 IPC（`main.js:9733`） | —— | 插件侧**没有**这个 API（§1.3／§1.4）【实测】；想用只能等宿主开放，不属于本包能决策的范围。可作为「未来增强」记一笔，不作推荐 |

---

## 4. 推荐路线与签名级形状（问题 3）

**推荐：A 做成默认行为，同时开 B 作为可选落地（＝A+B；C 否掉、D 不存在、E 记为未来项）。**
理由：A 是唯一零新增 API 就能真跳、且与宿主官方件同形的做法；B 用本包**已有的**注入惯例（`copyText`／`onRestartRequested`／`onCloseRequested`）把选择权交给集成方，不新增电话、不动四电话契约、HTTP 直挂场景同样成立（直挂时没人给回调用默认实现即可）。C 被否是因为它要动公开契约且直挂场景没有 `call`。

### 4.1 面板侧（`src/panel.ts`，形状照现有可选落地抄）

```ts
/** 打开外链的出口：不传即走默认实现（见 defaultOpenLink）。 */
export type UpdatePanelOpenLink = (url: string) => void | Promise<void>

export interface UpdatePanelOptions {
  // …现有键一字不动…
  /**
   * 外链落地（可选）：面板拦住日志里的外链点击后交给它（应用内浏览器／宿主日志／埋点都接在这）。
   * 不传走 defaultOpenLink：window.open(url, '_blank', 'noopener,noreferrer')。
   * 与 copyText 同款口径：回调抛错只吞不挡（不许因为一次点链失败影响更新流程）。
   */
  openLink?: UpdatePanelOpenLink
}
```

默认实现（与 `defaultCopyText`（`src/panel.ts:1923-1934`）同款「先探能力、失败静默」写法）：

```ts
async function defaultOpenLink(url: string): Promise<void> {
  try {
    const g = globalThis as Record<string, unknown>
    const open = (g['open'] ?? (g['window'] as { open?: unknown } | undefined)?.open) as
      | ((u: string, t: string, f: string) => unknown)
      | undefined
    if (typeof open === 'function') open.call(g['window'] ?? g, url, '_blank', 'noopener,noreferrer')
  } catch { /* 开不了也不挡更新 */ }
}
```

事件侧：在**现有那一个** `onClick` 委派里加一枝（`src/panel.ts:2776-2788` 现在是 `closest('[data-action]')` → `act(kind)`；`addEventListener('click', …)`／`removeEventListener` 分别在 `:2859`／`:2838`，**不新增监听器、不新增动作种类**）：

```ts
// onClick 内、data-action 判定之前：
const anchor = t?.target?.closest?.('a[data-openlink][href]') ?? null
if (anchor) {
  ev.preventDefault?.()                       // 单入口：只走下面这一条，避免 target="_blank" 再开一次
  const url = String(anchor.getAttribute('href') ?? '')
  if (isExternalHttpUrl(url)) {               // 只放 http/https，与 §1.1 的收口一致
    try { await (openLink ?? defaultOpenLink)(url) } catch { /* 吞掉 */ }
  }
  return
}
```

产出的锚（渲染处：`src/changelog.ts:583 renderChangelogHTML`，条目构造在 `:489-496`）：

```html
<a class="dsh-upd-link" data-openlink="1" href="https://…" target="_blank" rel="noopener noreferrer">文案</a>
```

- `data-openlink` 是面板自己的钩子（`#111` 内定，别跟 `data-action` 混）；
- `target="_blank" rel="noopener noreferrer"` 保留为**无 JS 降级**：没有委派时由 §1.1 直接接住；
- 有委派时**永远** `preventDefault()` 再走单一出口，避免「既 `window.open` 又被窗口 handler 收一次」的双开；
- 文案与 URL 出自 CHANGELOG 解析产物，渲染前一律 `escapeChangelogHtml`（`href` 也要过它，或只收 http/https 白名单）。

### 4.2 宿主侧：**不要改**

`createHostUpdate` 的电话表（`src/host.ts:1003-1021`，四个 `phoneNames.*` → handler）**不动**；`HostUpdate`（`src/host.ts:855`）不动；`docs/host-install-exits.md` 不动（那份抄件管安装出口，不管 UI）。宿主侧零改动是本推荐的主要卖点：集成方连「打开外链」的回调都不给也能真跳。

### 4.3 日志渲染侧最小改动（链接从哪来）

- 现在：`renderChangelogSection` 把条目 `escapeChangelogHtml` 成 `<li>` 纯文本（`src/changelog.ts:489`，破折标记分支 `:496`），所以 `[发布说明](https://…)` 连方括号原样显示。
- 最小形状：解析时把 markdown 行内链接 `[text](url)` 与裸 URL 收成「片段数组」，渲染时只把 http/https 目标变成上面那个锚。**只认行首/条目内 URL，不改写作要求**（ADR-0002 的「宁可丢字不改写」仍然有效）。
- ADR 冲突必须同步处理：`docs/adr/0002-changelog-display-trust.md:54` 把「裸 URL 可点」写成了**非目标**。翻案就得改这条，并按 `AGENTS.md` 的分工：设计取舍进 ADR（或新增一篇），README 只加「怎么用」（如 `openLink` 选项一行）。

### 4.4 必须遵守的既有约定（问题 3 的「约束」部分）

| 约定 | 出处 | 对本票的含义 |
| --- | --- | --- |
| 更新日志四电话与快照六字段**冻结** | `README.md:17`（四个电话：查状态／查新版／装更新／取日志）、`docs/adr/0002-changelog-display-trust.md:9`「不动四电话形状与快照六字段」 | 别加第 5 个电话（否掉路线 C 的硬依据） |
| 向后兼容只限「可选配置键／可选 readerOverrides／新增宿主种类与路由取值」 | `README.md:639` | `openLink` 属于「新增可选配置键」，合规；新增电话不合规 |
| 面板侧对宿主只有一个接触面：`call` | `src/panel.ts:180-183`（`UpdatePanelCall`）、`:219-220`（「与宿主通话的函数（面板侧唯一的宿主接触面）」）、`:1974-1976`（缺 `call` 直接抛） | 外链**不要**伪装成电话；能力注入走 `options`（与 `copyText` 同意） |
| 可选落地一律「不传即默认、回调抛错只吞」 | `copyText`：`src/panel.ts:185-186`、`:1923-1934`、`:2028`；`onRestartRequested`：`:230-234`、`:2024`、`:2722-2727`；`onCloseRequested`：`:248-252`、`:2025`、`:2793-2799` | `openLink` 的语义照抄：不传 = 默认实现；抛错 = 吞掉，不许挡更新 |
| 一个 `onClick` 委派、动作 = `data-action`、测试走同一个 `act(kind)` | `src/panel.ts:188-200`（动作枚举）、`:2776-2788`、`:270`（“DOM 监听只是它的薄适配，测试直接调它”） | 外链**不是** `UpdatePanelActionKind`（它不是更新动作，不该进 `act`）；委派里加一枝、给「打开这条链」一个可单测的出口 |
| README 只收用户做法，不放设计与过程 | `AGENTS.md`（Maintainer docs 一条）、`docs/host-install-exits.md:3-4`（只读抄件、形状对不上就诚实失败绝不猜） | 本报告的设计理由不进 README；宿主能力抄件若将来要沉淀，另开一份抄件文件，别改 `host-install-exits.md` |

---

## 5. 结论一句话

**宿主没给插件 API，但宿主把「点外链 = 真跳系统浏览器」这条接收端做完了；本包只要把日志里的链接渲染成 `<a href target="_blank" rel="noopener noreferrer" data-openlink>`，再在现有 `onClick` 委派里加一枝交给 `options.openLink ?? defaultOpenLink`（默认 `window.open(url,'_blank','noopener,noreferrer')`）即可两端都成立，宿主侧零改动、四电话契约零改动。**

---

## 6. 我验证不了什么（以及最便宜的结案实验）

| # | 未验证项 | 为什么没验证 | 最便宜的实验（谁都能做，成本一次点击） |
| --- | --- | --- | --- |
| E1 | **桌面版点击面板里的外链，是否真的弹出系统浏览器**（§1.1 的链路端到端） | 需要真机交互；本次是只读取证。链条本身（handler 代码）是【实测】，但「点到」这一步没有现场记录（同 `docs/host-install-exits.md:73` 对桌面安装路由「尚未在真机点过一次装上」的诚实口径） | 在官方桌面版里用一个临时面板塞 `<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>`，点一下看有没有弹默认浏览器；同时在面板里塞 `console.log('still here')` 确认**没有**同窗导航 |
| E2 | **web profile（浏览器打开 `http://127.0.0.1:19387`）里点外链会不会被弹窗拦截器挡** | 浏览器行为，且依赖用户设置；宿主自己依赖同一条路（§1.4） | 同上，用浏览器打开 web 面板点一下；若被拦，就说明必须把 `openLink` 当成「建议实现」写进 README 而不是纯默认 |
| E3 | **`ctx.slots.inject` 挂出来的面板是否处于 iframe**（若是，1.1 的窗口 handler 依然生效但 `window` 语义不同） | 本次只读到官方文档与两个真实件的写法，没在运行中的应用里按 F12 数 `iframe` | 在应用里 F12 → 选中面板 DOM → 看 `Elements` 面板的祖先链有没有 `iframe`／`webview`；文档与旁证都指向「没有」，此项是低风险兜底 |
| E4 | **认证后的 web 外壳响应头是否带 CSP** | 无凭据 GET 只拿到 401，401 上没有 CSP（`Cache-Control/Vary/Date/Connection/Keep-Alive/Transfer-Encoding/Content-Type`），不能外推到外壳页 | `curl -I`（带上会话凭据）武装请求 `http://127.0.0.1:19387/` 看响应头；或 F12 → Network → 文档请求 → Response Headers 找 `content-security-policy` |
| E5 | **`shell.openExternal` 的失败模式**（默认浏览器缺失／URL 被系统拒绝时静默还是报错） | 主进程代码里这条是同步调用、不看返回值（`asar:lib/main.js:11110`），行为属 Electron／OS | 手动把默认浏览器关联改坏点一次；或查 Electron `shell.openExternal` 官方文档。对面板侧的影响仅是「点了没反应」，无需为它加 UI |
| E6 | **宿主 44.0.0 外壳与档案 0.2.0-rc.2 的对应关系**，以及未来宿主版本是否保持 §1.1 语义 | 档案里只有运行时的 `0.2.0-rc.2`，外层 `version` 写 `44.0.0`，两者关系本次没取证 | 宿主升级后再跑一次 §6-E1；若哪天外链静默失效，第一嫌疑就是 `setWindowOpenHandler` 改了（这就是 §3 路线 A 的已知风险③） |
| E7 | **`target="_blank"` 与 `window.open` 同时存在会不会双开** | 需要真机；本报告的推荐形状用「委派里无条件 `preventDefault()` + 单出口」规避了这个问题，但没实测 | 同 E1，点一次看是否只开一个新标签 |

### 取证方法备注（供复核）

- `D:\DeepseekHarness\resources\app.asar` 是档案文件：`Test-Path 'D:\…\app.asar\dsh\package.json'` 为 **False**，`read`／`grep` 工具都穿不进去。本次用一个临时 Node 脚本（`D:\Temp\asar-read.mjs`，只读、不写档案）解析档案头（16 字节 pickle 头 + JSON 清单）后按需列出／打印／正则搜索内部文件；`asar:` 行号即该输出里的行号。若复核者要用别的手段，注意**不要**把 121MB 全量解包（无必要）。
- 本仓侧全部为只读：`src/`、`tests/`、`docs/` 只读；本次只新建 `docs/research/20261014-host-open-link-capability.md` 一个文件。
- 未运行 `git commit`／`git add`／`git push`，未跑测试与构建，未安装任何依赖。
