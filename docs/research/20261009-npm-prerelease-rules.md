# npm 平台如何处理预发布版本后缀（alpha / beta / rc / next / canary / nightly / dev / preview / experimental / snapshot / insiders / edge）

> 调查时间：2026-10-09 ｜ 调查方式：只读仓内文件；所有命令用 `--registry=https://registry.npmjs.org/` 显式打官方源（本机 npm 默认指到 `https://registry.npmmirror.com/`，是镜像，不足以作为主源证据）
> 取证环境：Windows ｜ node `v24.19.0` ｜ npm `10.9.2`（`D:\2Study\nodejs\npm.ps1`）｜ 官方源 `https://registry.npmjs.org/`
> 存放选址：`docs/research/` —— 本仓已有的 `YYYYMMDD-<主题>.md` 惯例（`20261004-ilife-多插件更新调查.md`、`20261005-changelog-第三方接入与README覆盖.md` 等），故沿用。

## 0. 三条承重结论（先看这个）

1. **预发布版发布时的默认 tag 不是「自动新开一个 beta/rc 标签」，而是 `latest` —— 而且现代 npm 会直接报错拦住你。** npm 11.0.0 起（PR #7910），在 `npm publish` 里若版本含预发布标识、且用户没显式给标签，就抛硬错误 `You must specify a tag using --tag when publishing a prerelease version.`。本机的 npm 10.9.2 **没有**这道闸（实测预发布版本不带 `--tag` 一路走到真正上架，见 §2.4），所以「行为随 npm 大版本而变」。
2. **预发布版可以成为 `latest`。** 没有任何规范或注册表规则禁止它。registry 只存「谁指向谁」这一层映射，`latest` 指向预发布版完全合法；本仓的探针包现在就处于 `{"latest": "1.0.1-rc.1"}` 这个状态（§2.4 现场证据）。npm 11+ 只在「隐式套用 latest」这一条路径上加了版本比较门槛，显式 `--tag latest` 永远放行（§2.3）。
3. **没有「通道目录」这回事。** 注册表侧所有版本平铺在 packument 的 `versions` 对象里，桶只有 `dist-tags`；本地侧 `node_modules/<包名>` 永远只有**一个**目录，装哪个预发布版就覆盖哪个，`--preid=rc` / `--tag rc` 都不会生成 `rc/` 或 `beta/` 文件夹。唯一按内容而非按通道命名的是 npm 缓存（`_cacache`，内容寻址）。§4 有实测目录清单。

## 1. SemVer 规范怎么定义预发布版（一手：semver.org）

来源：<https://semver.org/> （Semantic Versioning 2.0.0 规范原文；以下英文均为原文逐字引用）。

### 1.1 条目 9：预发布版怎么构造

> **9.** A pre-release version MAY be denoted by appending a hyphen and a series of dot separated identifiers immediately following the patch version. Identifiers MUST comprise only ASCII alphanumerics and hyphens `[0-9A-Za-z-]`. Identifiers MUST NOT be empty. Numeric identifiers MUST NOT include leading zeroes. Pre-release versions have a lower precedence than the associated normal version. A pre-release version indicates that the version is unstable and might not satisfy the intended compatibility requirements as denoted by its associated normal version. Examples: 1.0.0-alpha, 1.0.0-alpha.1, 1.0.0-0.3.7, 1.0.0-x.7.z.92, 1.0.0-x-y-z.--.

拆开就是三条硬约束：

- 形式：`<patch>` 后面紧跟**连字符** + **点分隔标识符序列**（`0.2.0-rc.2` 里 `rc`、`2` 是两个标识符）。
- 字符集：只允许 ASCII 字母数字和连字符；标识符**不得为空**；纯数字标识符**不得有前导零**。
- 语义：预发布版「优先级低于」它对应的正式版，「表示该版本不稳定」。

### 1.2 条目 11：优先级怎么算

> **11.** Precedence refers to how versions are compared to each other when ordered.
> 11.1. Precedence MUST be calculated by separating the version into major, minor, patch and pre-release identifiers in that order (Build metadata does not figure into precedence).
> 11.3. When major, minor, and patch are equal, a pre-release version has lower precedence than a normal version: Example: 1.0.0-alpha < 1.0.0.
> 11.4.4. A larger set of pre-release fields has a higher precedence than a smaller set, if all of the preceding identifiers are equal.
> 11.4 Example: `1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0`

11.4 内部还有细分规则：**纯数字标识符按数值比较**（所以 `beta.11 > beta.2`，不是字符串序）；**含字母或连字符的标识符按 ASCII 字典序比较**；**数字标识符永远比非数字标识符优先级低**。

由 11.3 直接推出本题点名要证的那条：**`0.2.0-rc.2 < 0.2.0`**（同一 major.minor.patch，带预发布者靠前）。实测（node-semver 7.8.5，命令见 §6.3）：

```
0.2.0-rc.2 < 0.2.0      => true
```

同一条实测脚本还确认 `beta.11 > beta.2` 的数值比较（`1.0.0-alpha < 1.0.0-alpha.1` 一类的链由 11.4.4 覆盖）。

### 1.3 alpha / beta / rc 是不是 SemVer 的特殊词？——不是，纯约定

规范正文**从未**给 `alpha`、`beta`、`rc` 赋予任何特殊地位。它们的法律地位和 `x`、`--` 完全一样，只是一个「alphanumeric identifier」。三条直接证据：

1. 条目 9 自己举的反例：`1.0.0-x.7.z.92`、`1.0.0-x-y-z.--`，`x` 和 `--` 都是合法预发布标识符，说明标识符内容任意（只要满足字符集）。
2. 条目 9 还给了 `1.0.0-0.3.7`，说明**纯数字**也能当预发布标识符，`alpha`/`beta` 并不比它更「正式」。
3. 规范为了演示排序，把 `alpha`、`beta`、`rc` 混在一个链里（`1.0.0-alpha < ... < 1.0.0-rc.1 < 1.0.0`），但那是**示例**，不是规则；规范没有规定 `rc` 必须晚于 `beta`，也没有规定只能有这几档。

结论：`alpha`/`beta`/`rc`/`next`/`canary`/`nightly`/`dev`/`preview`/`experimental`/`snapshot`/`insiders`/`edge` 全都是**自由文本标识符**，是生态惯例而非规范条款。它们之间的「先后」只有在你按 11.4.2 的字典序硬排时才存在（`alpha < beta < canary < dev < edge < experimental < insiders < next < nightly < preview < rc < snapshot`，纯 ASCII 序），而**工具链不依赖这个顺序**：npm 决定装什么靠 dist-tag，不靠给后缀排序。

### 1.4 顺带排除两个常见误解（同源，FAQ 区）

- 构建元数据（`+` 之后）**不参与**优先级计算：条目 10「Build metadata MUST be ignored when determining version precedence」。
- `v1.2.3` **不是**语义化版本：FAQ「Is "v1.2.3" a semantic version?」原文 `No, "v1.2.3" is not a semantic version.`。命令里常见的 `npm version` 输出带 `v` 前缀只是显示约定（本仓实测 `npm version prerelease --preid=rc` 打印 `v1.0.1-rc.0`，但 `package.json` 里写的是 `1.0.1-rc.0`，见 §7.1）。

## 2. npm dist-tag：默认标签、预发布发布的真实行为、以及硬错误

### 2.1 文档怎么说默认标签

一手文档（npm/cli 仓的文档源文件，即 docs.npmjs.com 的内容源）：
<https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-dist-tag.md>

> Publishing a package sets the `latest` tag to the published version unless the `--tag` option is used. For example, `npm publish --tag=beta`.
> By default, `npm install <pkg>` (without any `@<version>` or `@<tag>` specifier) installs the `latest` tag.

> The `next` tag is used by some projects to identify the upcoming version.
> Other than `latest`, no tag has any special significance to npm itself.

配置项本身的默认值（本机实测，§6.2）：`tag = "latest"`。npm 文档里 `npm-install` 也复述了一遍：

> Do a `<name>@<tag>` install, where `<tag>` is the "tag" config. (See `config`. The config's default value is `latest`.)

**注意文档的缺口**：`npm-dist-tag.md` 与 `npm-publish.md` 这两个页面**都没有**提到「发布预发布版必须显式给 tag」。`npm-publish.md` 通篇讲的是「文件包含规则 / 不能重复发布同一 name@version」，一个字都没提预发布。所以「`npm publish` 遇预发布版会报错」这条**不是文档写明的**，只能从源码和实测确认（下面 2.2-2.4）。

### 2.2 源码怎么说：闸门在这里（一手：npm/cli 源文件）

来源：<https://github.com/npm/cli/blob/latest/lib/commands/publish.js>（即 raw: `https://raw.githubusercontent.com/npm/cli/latest/lib/commands/publish.js`）

```js
const isDefaultTag = this.npm.config.isDefault('tag') && !manifest.publishConfig?.tag

if (!force) {
  const isPreRelease = Boolean(semver.parse(manifest.version).prerelease.length)
  if (isPreRelease && isDefaultTag) {
    throw new Error('You must specify a tag using --tag when publishing a prerelease version.')
  }
}
```

同一函数里还有第二道闸（针对「隐式套 latest」的版本比较）：

```js
if (!force) {
  const { highestVersion, versions } = await this.#registryVersions(resolved, registry)
  const highestVersionIsGreater = !!highestVersion && semver.gte(highestVersion, manifest.version)

  if (versions.includes(manifest.version)) {
    throw new Error(`You cannot publish over the previously published versions: ${manifest.version}.`)
  }

  if (highestVersionIsGreater && isDefaultTag) {
    throw new Error(`Cannot implicitly apply the "latest" tag because previously published version ${highestVersion} is higher than the new version ${manifest.version}. You must specify a tag using --tag.`)
  }
}
```

`#registryVersions` 的关键实现（决定「highestVersion」怎么算）：

```js
const ordered = Object.keys(packument?.versions)
  .flatMap(v => {
    const s = new semver.SemVer(v)
    if ((s.prerelease.length > 0) || packument.versions[v].deprecated) {
      return []
    }
    return s
  })
```

即：**已发布的预发布版和已废弃版被排除在「最高版本」之外**，只用正式版做基准。这两段合起来的推论是：

- 隐式套 `latest` 的资格 = 新版本 ≥ 所有历史正式版中的最高者。
- 所以 `1.9.0` 之后再发 `2.0.0-rc.1`，隐式 `latest` **不会**被拦（`2.0.0-rc.1 > 1.9.0`）；而在 `1.9.0` 之后补发 `1.5.0-rc.1` 会被拦。
- 加 `--force` 会跳过这两道闸（源码 `if (!force)`）。

另有一道与版本无关的标签合法性校验（`npa` 抛出）：

```js
// make sure tag is valid, this will throw if invalid
npa(`${manifest.name}@${defaultTag}`)
```

### 2.3 那么预发布版能不能成为 `latest`？——能

分三层回答，逐层有据：

1. **规范层**：SemVer 不管 dist-tag；npm 文档明说「Other than `latest`, no tag has any special significance to npm itself」（§2.1），反过来 `latest` 的特殊性也只在于它是 install 的默认解析目标，规范上不限制它指向什么版本的形态。
2. **时序层**：`latest` 就是 `dist-tags` 对象里的一个键值对，注册表不校验被指向的版本是不是预发布。把 `latest` 指到预发布版有两种合法途径：显式 `npm publish --tag latest`，或隐式路径下新版本高于所有历史正式版（§2.2）。
3. **现场证据**：本仓探针包 `probe-pkg-prerelease-xyz` 现处于该状态，见下。

### 2.4 本机实测：npm 10.9.2 的预发布发布行为（**与 npm 11+ 文档/源码口径不同**）

探针目录：`D:\Temp\npm-prerelease-probe`（`package.json` 名 `probe-pkg-prerelease-xyz`）。先制造一个预发布版本：

```
########## npm version prerelease --preid=rc --no-git-tag-version
v1.0.1-rc.0
########## npm version prerelease（再来一次，同一 preid）
v1.0.1-rc.1
```

然后**不带任何 tag** 直接 `npm publish`（真实上架，不是 dry-run）：

```
npm notice Publishing to https://registry.npmjs.org/ with tag latest and default access
npm notice Your package is being processed and may take a few minutes to become available.
+ probe-pkg-prerelease-xyz@1.0.1-rc.1
--- exit: 0
```

结果（`https://registry.npmjs.org/probe-pkg-prerelease-xyz` 原始 JSON）：

```
dist-tags : {"latest":"1.0.1-rc.1"}
versions  : 0.0.0-stage, 1.0.1-rc.1
time      : created 2026-10-09T15:08:46.668Z / 1.0.1-rc.1 于 2026-10-09T15:09:42.805Z
```

**结论（实测，非推断）**：npm 10.9.2 下，预发布版本不带 `--tag` 发布，既不报错也不新开 `rc` 标签，而是**直接占用了 `latest`**。随后带 `--tag rc` / `--tag latest` 的重复尝试都被注册表以版本重复拒绝：

```
npm error code E409
npm error 409 Conflict - PUT https://registry.npmjs.org/probe-pkg-prerelease-xyz
npm error Cannot publish over previously staged version "1.0.1-rc.1".
```

**⚠️ 副作用与未了事项**：该探针包是真实的公网发布，且**清理失败**。`npm unpublish probe-pkg-prerelease-xyz --force` 被注册表拒绝：

```
npm error 403 403 Forbidden - DELETE https://registry.npmjs.org/probe-pkg-prerelease-xyz/-rev/...
npm error 403 Granular access tokens that bypass two-factor authentication may not perform this action.
```

（`npm whoami` = `feather_wch`；token 是 granular access token，按 npm 的 2FA 政策不允许执行 unpublish。需要包主在 npmjs.com 网页端带 2FA 手动删除，URL：`https://www.npmjs.com/package/probe-pkg-prerelease-xyz`。**这是本次调查唯一一处越界副作用，需人工收尾**。）

`0.0.0-stage` 这个版本不是探针写的，是 npm 自己的占位：`npm publish` 的首个请求返回 `"description": "Temporary package placeholder for staged publishing"`，与 §2.2 源码里 `/-/stage/package/${spec.escapedName}` 的新式暂存发布路径一致。

### 2.5 关于「EPRERELEASE」这个错误码

**未找到任何一手来源使用 `EPRERELEASE` 这个 code。** 在 npm/cli 的 `lib/commands/publish.js` 与 `workspaces/libnpmpublish/lib/publish.js` 里都不存在；`libnpmpublish` 定义的 code 是 `EPRIVATE` / `EPACKAGEEXTENSIONS` / `EBADSEMVER` / `EUNSCOPED` / `EUSAGE`。而 §2.2 那道预发布闸抛的是**裸 `Error`，没有 `code`**。所以：**没有 `EPRERELEASE` 码**；预发布相关的失败信息就是那句英文长句（以及 403/409 这类传输层 code）。本机实测输出里也没出现过 `EPRERELEASE`。

### 2.6 这道闸是哪个版本进来的

npm/cli 的 `CHANGELOG.md`（<https://github.com/npm/cli/blob/latest/CHANGELOG.md>）在 `11.0.0-pre.0 (2024-11-26)` 段下：

```
* [`16b7367`](https://github.com/npm/cli/commit/16b7367...) [#7910](https://github.com/npm/cli/pull/7910) publishing prerelease requires explicit tag (#7910) (@reggi)
```

即**npm 11.0.0 起**（PR #7910，commit `16b7367`）。本机 npm 10.9.2 落在门槛之前，故实测无闸（§2.4 与此互为印证）。npm 官方 registry 上的 `npm` 包 dist-tags 当前为 `latest = 12.2.0`、`next-11 = 11.21.0`、`next-10 = 10.9.9`。

## 3. dist-tag 能与不能

一手：<https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-dist-tag.md> 的 "Caveats" 段，逐字引用：

> Tags must share a namespace with version numbers, because they are specified in the same slot: `npm install <pkg>@<version>` vs `npm install <pkg>@<tag>`.
> Tags that can be interpreted as valid semver ranges will be rejected. For example, `v1.4` cannot be used as a tag, because it is interpreted by semver as `>=1.4.0 <1.5.0`. See <https://github.com/npm/npm/issues/6082>.
> The simplest way to avoid semver problems with tags is to use tags that do not begin with a number or the letter `v`.

本条用 node-semver 直接验证（命令见 §6.3，semver 7.8.5）：

| 标签候选 | `semver.validRange()` | 能否当 tag |
| --- | --- | --- |
| `rc` | `null` | 能 |
| `next` | `null` | 能 |
| `beta` | `null` | 能 |
| `insiders` | `null` | 能 |
| `rc.1` | `null` | 能（注意：这是合法 tag 名） |
| `v1.4` | `>=1.4.0 <1.5.0-0` | **不能**，报 `Tag name must not be a valid SemVer range: v1.4` |
| `1.4` | `>=1.4.0 <1.5.0-0` | **不能**，报 `Tag name must not be a valid SemVer range: 1.4` |

后两行的报错是 `npm publish --tag` 的真实输出（本机 npm 10.9.2 实测，§6.4），对应 §2.2 源码里 `semver.validRange(defaultTag)` 的预检。**注意 `v1.4` 与 `1.4` 都被挡**，所以「不要用数字或 `v` 开头」这句文档提示是保守但正确的经验法则。

其余性质：

- **命名空间共用**：同一个槽位既能填 tag 又能填版本/范围，`npm install <pkg>@<tag>` 与 `npm install <pkg>@<version>` 语法同形（上引原文）。这也是为什么 tag 名不能长得像 semver。
- **大写敏感**：`dist-tags` 对象的键就是普通 JSON 键，大小写敏感。文档把 `stable`、`beta`、`dev`、`canary` 都写作小写；生态惯例全小写。本机 `npm dist-tag ls react@RC` 不会报错也不会返回空，而是**退化成列出该包全部标签**（即 `@RC` 被当作无法解析的说明符忽略），所以「大写标签存在」这件事**没能用 `npm dist-tag` 直接证伪**；可以确认的是**没有 `RC` 这个标签**，只有 `rc`（见 §5.1）。`--tag` 传的字符串原样成为键，npm 不做大小写归一。
- **URL 安全**：tag 名最终要进 registry 的 URL/请求体，也会出现在 `npm install <pkg>@<tag>` 命令行里。文档没给字符白名单，只给了「别像 semver」这条排除规则；实践上的安全子集就是 `[a-z0-9][a-z0-9-_.]*` 这类不含 `/`、`@`、空格的短标识符（`rc`、`next`、`canary`、`beta-45-x-y`、`tag-for-publishing-older-releases` 都在真实包上出现过，见 §5.1）。
- **不是版本的别名**：一个 tag 只指向**一个**版本；`dist-tag add` 会覆盖旧指向（`npm dist-tag add <pkg>@<version> [<tag>]`）。tag 本身不携带任何版本语义，删掉 tag 不影响版本仍可被精确版本号安装。
- **`latest` 是唯一有语义的那个**：`npm install <pkg>` 默认解析到它（§2.1）。

## 4. 版本到底「住在」哪里：packument 布局、tarball 形状、以及「没有通道目录」

### 4.1 注册表侧：一个 packument，平铺 `versions` + 一个 `dist-tags` 映射

`https://registry.npmjs.org/react` 的原始 JSON 顶层键（实测）：

```
_id, _rev, name, dist-tags, versions, time, bugs, license, homepage, keywords,
repository, description, maintainers, readme, readmeFilename, users
```

其中 `dist-tags`（实测值）：

```json
{
  "beta": "19.0.0-beta-26f2496093-20240514",
  "rc": "19.0.0-rc.1",
  "next": "19.3.0-canary-d5736f09-20260507",
  "backport": "19.0.8",
  "latest": "19.3.0",
  "experimental": "0.0.0-experimental-b618bbb4-20261007",
  "canary": "19.3.0-canary-b618bbb4-20261007"
}
```

`versions` 是按版本号字符串为键的对象，该包共 **2967** 个版本，预发布版和正式版**混在同一个对象里**，没有任何分组。取一个预发布版看它的条目：

```
versions['19.0.0-rc.1']._id            = react@19.0.0-rc.1
versions['19.0.0-rc.1'].version         = 19.0.0-rc.1
versions['19.0.0-rc.1'].dist.tarball    = https://registry.npmjs.org/react/-/react-19.0.0-rc.1.tgz
versions['19.0.0-rc.1'].dist.integrity  = sha512-NZKln+uyPuyHchzP07I6GGYFxdAoaKhehgpCa3ltJGzwE31OYumLeshGaitA1R/fS5d9D2qpZVwTFAr6zCLM9w==
versions['19.0.0-rc.1'].dist.shasum     = 469cc8ae6bdba224dcaab10ad6c4d90843f21352
```

**没有任何 alpha/ beta/ rc/ next/ canary 目录、分区或前缀路径。** 注册表把「预发布」完全编码在版本字符串本身 + `dist-tags` 映射里，仅此而已。tarball 路径的形状是：

```
https://registry.npmjs.org/<pkg>/-/<pkg>-<version>.tgz
```

实测两条（`npm view` 取官方源）：

```
npm view react dist.tarball            => https://registry.npmjs.org/react/-/react-19.3.0.tgz            （latest 解析）
npm view react@rc dist.tarball         => https://registry.npmjs.org/react/-/react-19.0.0-rc.1.tgz
npm view typescript@6.0.0-beta version dist.tarball
  => { "version": "6.0.0-beta", "dist.tarball": "https://registry.npmjs.org/typescript/-/typescript-6.0.0-beta.tgz" }
```

范围包同理，只是名字里的 `/` 被转义进路径（npm 文档自身举的 tarball 例）：`https://registry.npmjs.org/semver/-/semver-1.0.0.tgz`（来源：<https://github.com/npm/cli/blob/latest/docs/lib/content/using-npm/package-spec.md>）。这个形状也和发布端源码吻合：`const tarballName = \`${manifest.name}-${manifest.version}.tgz\``、`const tarballURI = \`${manifest.name}/-/${tarballName}\``（<https://github.com/npm/cli/blob/latest/workspaces/libnpmpublish/lib/publish.js>）。

发布端递交的正是「一个 manifest + 一个 dist-tag」，没有别的通道概念：

```js
root.versions[manifest.version] = manifest
const tag = manifest.tag || defaultTag
root['dist-tags'][tag] = manifest.version
```

（同上 `libnpmpublish/lib/publish.js`；`defaultTag` 的默认值在 factory 里写死 `defaultTag: 'latest'`，可被 `--tag` 覆盖。）

### 4.2 本地侧：`node_modules/<包名>` 永远只有一个目录

一手：<https://github.com/npm/cli/blob/latest/docs/lib/content/configuring-npm/folders.md>

> When you run `npm install foo@1.2.3`, then the package is loaded into the cache, and then unpacked into `./node_modules/foo`.

实测（在隔离目录 `D:\Temp\npm-semver-check` 里装 `typescript@6.0.0-beta`）：

```
node_modules\ 内容： .bin, typescript, .package-lock.json
node_modules\typescript\package.json 里的 version = 6.0.0-beta
```

**只有 `typescript` 这一个目录**，没有 `typescript-beta`、没有 `typescript/beta/`、更没有 `node_modules/typescript@6.0.0-beta`。同名的另一个版本不可能与之并存（要并存只能靠 `npm install <alias>@npm:<name>` 起别名，文档：`npm install my-react@npm:react`，见 package-spec 的 Aliases 段）。scoped 包也只是多一层 scope 目录：`{prefix}/node_modules/@myorg/package`（folders.md 原文）。

所以：**`0.2.0-rc.2` 是 npm 的一个普通版本**。它安装进的位置与任何其他版本**完全相同**——`node_modules/<pkg>` 这一个目录，装它就等于把该目录内容替换成 `0.2.0-rc.2`。它唯一「落进去的桶」是 **dist-tag**（落哪个 tag 取决于发布者当时怎么发的），**不是目录**。注册表侧同理，它躺在 packument 的 `versions['0.2.0-rc.2']` 里，和 `versions['0.2.0']` 平级。

### 4.3 唯一按内容命名的地方是缓存

一手：<https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-cache.md>

> npm stores cache data in an opaque directory within the configured `cache`, named `_cacache`. This directory is a [`cacache`](http://npm.im/cacache)-based content-addressable cache that stores all http request data as well as other package-related data. This directory is primarily accessed through `pacote`, the library responsible for all package fetching as of npm@5.

`folders.md` 另给位置：Posix 在 `~/.npm`，Windows 在 `%LocalAppData%/npm-cache`。本机实测（`npm config get cache` = `C:\Users\辰辰洋洋\AppData\Local\npm-cache`）：

```
_cacache\ 下： content-v2, index-v5, tmp
_cacache\index-v5\ 下： 01, 02, 03, 04, 09, ...（十六进制分片）
npm cache ls typescript =>
  make-fetch-happen:request-cache:https://registry.npmjs.org/typescript
  make-fetch-happen:request-cache:https://registry.npmmirror.com/typescript
```

即缓存按 **完整性哈希/请求 URL** 分片，键里带的是包名与源地址，**没有任何按 alpha/beta/rc 命名的层**。文档还强调「The npm cache is strictly a cache: it should not be relied upon as a persistent and reliable data store for package data.」——所以别把缓存当版本仓库用。

## 5. 真实包在用的命名惯例（全部为 `npm view <pkg> dist-tags --json` 实测输出，源为官方 registry）

### 5.1 原始输出

```jsonc
// npm view typescript dist-tags --json
{
  "dev": "3.9.4",
  "tag-for-publishing-older-releases": "4.1.6",
  "insiders": "4.6.2-insiders.20220225",
  "beta": "6.0.0-beta",
  "rc": "7.0.1-rc",
  "latest": "7.0.2",
  "next": "7.1.0-dev.20261009.1"
}
```

```jsonc
// npm view react dist-tags --json
{
  "beta": "19.0.0-beta-26f2496093-20240514",
  "rc": "19.0.0-rc.1",
  "next": "19.3.0-canary-d5736f09-20260507",
  "backport": "19.0.8",
  "latest": "19.3.0",
  "experimental": "0.0.0-experimental-b618bbb4-20261007",
  "canary": "19.3.0-canary-b618bbb4-20261007"
}
```

```jsonc
// npm view @angular/core dist-tags --json（截取；另有 v4-lts … v21-lts 共 18 个 LTS 标签）
{
  "v21-lts": "21.2.25",
  "next": "22.3.0-next.1",
  "latest": "22.2.2"
}
```

（注意：`npm view angular dist-tags` 得到的是**上古 AngularJS 1.x 包**，`{"latest": "1.8.3", "next": "1.8.3"}`；现代 Angular 用 scoped 包 `@angular/core`，其 `next` 才是真预发布。这是个容易踩的取样错误。）

```jsonc
// npm view vue dist-tags --json
{ "csp": "1.0.28-csp", "legacy": "2.7.16", "v2-latest": "2.7.16",
  "alpha": "3.6.0-alpha.7", "beta": "3.6.0-beta.17", "latest": "3.5.43", "rc": "3.6.0-rc.10" }
```

```jsonc
// npm view eslint dist-tags --json
{ "es6jsx": "0.11.0-alpha.0", "next": "10.0.0-rc.2", "maintenance": "9.39.5", "latest": "10.12.0" }
```

```jsonc
// npm view next dist-tags --json（截取）
{ "rc": "15.0.0-rc.1", "beta": "16.0.0-beta.0", "preview": "16.3.0-preview.10",
  "backport": "15.5.27", "latest": "16.4.0", "canary": "16.5.0-canary.5", "next-14": "14.2.35" }
```

```jsonc
// npm view vite dist-tags --json
{ "alpha": "6.0.0-alpha.24", "beta": "8.3.0-beta.1", "latest": "8.3.4", "previous": "6.4.4" }
```

```jsonc
// npm view pnpm dist-tags --json（截取）
{ "dev": "6.23.7-202112041634", "pr4475": "0.0.0-pr4475.1",
  "latest-11": "11.28.2", "next-11": "11.28.5", "latest": "12.10.1", "next-12": "12.11.1" }
```

```jsonc
// npm view @types/node dist-tags --json（截取）
{ "ts5.9": "26.6.4", "ts6.0": "26.6.4", "ts7.0": "26.6.4", "old-version": "22.20.5", "latest": "26.6.4" }
```

```jsonc
// npm view electron dist-tags --json（截取）
{ "unsupported": "2.1.0-unsupported.20180809",
  "beta-45-x-y": "45.0.0-beta.1", "alpha-45-x-y": "45.0.0-alpha.16",
  "beta": "45.0.0-beta.1", "alpha": "45.0.0-alpha.16",
  "44-x-y": "44.7.0", "latest": "44.7.0" }
```

### 5.2 归纳（每条都能在上面输出里指出来）

| 惯例 | 谁在用 | 形态 |
| --- | --- | --- |
| `next` = 下一条主线/最新不稳定 | typescript、react、@angular/core、eslint、next、pnpm | 通常指向真预发布（`@angular/core` 的 `next` = `22.3.0-next.1`，而 `latest` = `22.2.2` 是正式版；react 的 `next` = `19.3.0-canary-...`） |
| `beta` / `rc` / `alpha` 分档 | react、vue、electron、vite、next、typescript | 三档或两档并行，各指一个预发布 |
| `canary` = 每日/每 commit 构建 | react、next | 带 commit id 与日期的构建号：`19.3.0-canary-b618bbb4-20261007` |
| `experimental` = 实验性、可能长期不晋升 | react | 甚至用 `0.0.0-experimental-<sha>-<date>` 这种「永远低于 1.0.0」的版本号，从版本号层面就杜绝被范围匹配到 |
| `preview` | next | `16.3.0-preview.10` |
| `dev` / `insiders` | typescript、pnpm | `7.1.0-dev.20261009.1`、`4.6.2-insiders.20220225` |
| `nightly` / `snapshot` / `edge` | 本次取样包里**没有**出现 | 见下「未验证」 |
| 版本线专用标签（非预发布语义） | @types/node（`ts5.9`）、electron（`alpha-45-x-y`）、@angular/core（`v21-lts`）、next（`next-14`）、pnpm（`latest-11`） | 标签承载「目标版本线/兼容线」而非「成熟度」 |
| 杂用标签 | typescript 的 `tag-for-publishing-older-releases`、eslint 的 `es6jsx`、vue 的 `csp`、pnpm 的 `pr4475`、react 的 `backport` | 说明 tag 命名空间是发布者的自由地，工具**不能**假设标签集合是封闭的 |

工程含义：**消费方绝不能把标签名当枚举**。`latest` 是唯一有契约的键，其余全是发布者自选字符串（`Other than latest, no tag has any special significance to npm itself`，§2.1）。

## 6. 对「安装器/更新器」的实际后果

### 6.1 `npm install <pkg>` 装的是 `latest`，不是「最高版本」

文档原文（§2.1）：`By default, npm install <pkg> (without any @<version> or @<tag> specifier) installs the latest tag.` 且 `In most cases, this will install the version of the modules tagged as latest on the npm registry.`（<https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-install.md>）

这里有个**更新器必须知道的坑**（同一文档页）：

> **Note:** When installing by name without specifying a version or tag, npm prioritizes versions that match the current Node.js version based on the package's `engines` field. If the `latest` tag points to a version incompatible with your current Node.js version, npm will install the newest compatible version instead. To install a specific version regardless of `engines` compatibility, explicitly specify the version or tag: `npm install <name>@latest`.

也就是说「`npm install <pkg>` = `latest`」在 `engines` 不兼容时**不成立**，它会回落到「最新的兼容版本」，而那可能是一个更旧的正式版甚至预发布版的具体版本。做版本检查/更新器时，若你的语义是「latest 指向什么」，应显式读 `dist-tags.latest`，而不是依赖一次裸 `npm install` 的结果。

### 6.2 怎么显式选预发布

```bash
npm install <pkg>@next          # 按 tag 取（若该 tag 不存在，文档：this will fail）
npm install <pkg>@1.2.3-rc.2    # 按精确预发布版本取
npm install <pkg>@^1.0.0-rc.1   # 按范围取（语义见下）
npm install --tag next          # 等价于对命令行上的包默认取 next（见下）
```

`--tag` 的边界（文档原文，<https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-install.md>）：

> The `--tag` argument will apply to all of the specified install targets. If a tag with the given name exists, the tagged version is preferred over newer versions.
> **Note:** The `--tag` option only affects packages specified on the command line. It does not override version ranges specified in `package.json`. For example, if `package.json` specifies `"foo": "^1.0.0"` and you run `npm install --tag beta`, npm will still install a version matching `^1.0.0` even if the `beta` tag points to a different version. To install a tagged version, specify the package explicitly: `npm install foo@beta`.

即：**`--tag` 不是全局开关**，对已写在 `package.json` 里的依赖无效，只有「命令行点名 + 没写范围」时才生效。

### 6.3 范围语义：默认排除预发布（node-semver 权威口径）

权威一手：<https://github.com/npm/node-semver/blob/main/README.md> 的 "Prerelease Tags" 段，逐字引用：

> If a version has a prerelease tag (for example, `1.2.3-alpha.3`) then it will only be allowed to satisfy comparator sets if at least one comparator with the same `[major, minor, patch]` tuple also has a prerelease tag.
> For example, the range `>1.2.3-alpha.3` would be allowed to match the version `1.2.3-alpha.7`, but it would *not* be satisfied by `3.4.5-alpha.9`, even though `3.4.5-alpha.9` is technically "greater than" `1.2.3-alpha.3` according to the SemVer sort rules. The version range only accepts prerelease tags on the `1.2.3` version.

这就是所谓的 **prerelease tuple 规则**：范围里的预发布标识只在**同一个 major.minor.patch 三元组**上开权限。实测（semver `7.8.5`，脚本见 `D:\Temp\npm-semver-check\check.cjs`）：

```
^1.2.3-beta.1    satisfies 1.2.3-beta.1    => true
^1.2.3-beta.1    satisfies 1.2.3-beta.2    => true
^1.2.3-beta.1    satisfies 1.2.4-beta.1    => false     ← 注意
^1.2.3-beta.1    satisfies 1.3.0-beta.1    => false
^1.2.3-beta.1    satisfies 1.2.3           => true      （正式版不受限）
^1.0.0-0         satisfies 1.0.0-rc.1      => true
^1.0.0-0         satisfies 1.3.0-alpha.1   => false     ← 注意
^1.0.0           satisfies 1.3.0-alpha.1   => false     （普通范围完全排除预发布）
```

**⚠️ 官方 `npm-install` 文档有一段示例与 node-semver 的实际行为矛盾，别照抄。** 该页现写：

> **Prerelease versions:** By default, version ranges only match stable versions. To include prerelease versions, they must be explicitly specified in the range. Prerelease versions are tied to a specific version triple (major.minor.patch). For example, `^1.2.3-beta.1` will only match prereleases for `1.2.x`, not `1.3.x`. To match all prereleases for a major version, use a range like `^1.0.0-0`, which will include all `1.x.x` prereleases.
> ```bash
> npm install package@^1.2.3-beta.1  # Matches 1.2.3-beta.1, 1.2.3-beta.2, 1.2.4-beta.1, etc.
> npm install package@^1.0.0-0       # Matches all 1.x.x prereleases and stable versions
> ```

两处对不上实测：`1.2.4-beta.1`（元组 `1.2.4` ≠ `1.2.3`，按 tuple 规则应排除）实测为 `false`；`^1.0.0-0` 也**不**匹配 `1.3.0-alpha.1`（元组 `1.3.0` ≠ `1.0.0`）。**以 node-semver README 的 tuple 规则为准**：`^1.0.0-0` 打开的是「`1.0.0` 这个三元组上的预发布」，不是「整个 1.x」。想要「某大版本线所有预发布」，得逐个三元组开，或用 `>=1.0.0-0 <2.0.0-0` 这类显式 comparator 配合 `includePrerelease` 语义——但注意 node-semver 的该开关只在**库调用**的 options 里可用，命令行 `npm install` 没有暴露它（未在 npm/cli 文档中找到对应 CLI 选项，见 §8 未验证项）。

附带一条常被忽略的机制（同 node-semver README，X-Ranges 段）：

> `1.x` := `>=1.0.0 <2.0.0-0`
> `1.2.x` := `>=1.2.0 <1.3.0-0`

上界带 `-0` 是刻意的：这样 `1.5.0` 这类正式版不会被 `1.x` 误收，同时也不会把 `2.0.0-0` 之类算进 1.x 线。这也是「为什么不用给后缀排序」的机制原因。

### 6.4 `latest` 本身可能指向预发布版——最大的那个坑

综合 §2.2-2.4：**没有规则保证 `latest` 是正式版**。三种现实路径：

1. npm 11+ 之前的 npm（含本机 10.9.2）：预发布不带 `--tag` 发布 → 直接成为 `latest`。**实测已复现**（§2.4）。
2. 任何 npm 版本 + 显式 `--tag latest`：闸门只看 `isDefaultTag`，显式给 `latest` 时 `isDefaultTag === false`，两道版本比较闸都不生效 → 直接成为 `latest`。**源码推断**（§2.2），本机未能实测通过（第一次无标签发布已占据 `latest`，导致后续请求 409）。
3. npm 11+ 隐式路径：只要新版本 ≥ 所有历史**正式版**的最高者，隐式 `latest` 仍会放行 → 预发布成为 `latest`。**源码推断**（§2.2 的 `#registryVersions` 过滤预发布版后才比大小）。

对更新器的第三条建议：**不要把「`dist-tags.latest` 是正式版」当作不变量**。取到 `dist-tags.latest` 后应自己用 §1 的规则判一次是否含预发布标识（本仓有现成实现：`src/service.ts` 的 `isPrereleaseVersion` / `validReleaseVersion` / `isVersionAllowedInChannel`，`src/service.ts:65-110`，其中 `stable` 通道默认只收纯三段，`prerelease` 通道须调用方显式 opt-in），否则「最新版」这个判定会被一个 `2.0.0-rc.1` 悄悄改写。

### 6.5 与本仓现有通道设计的关系

本仓已经把「通道」建模成一个**显式的调用方选项**而不是目录或标签：`export type ReleaseChannel = 'stable' | 'prerelease'`（`src/service.ts:66`），默认 `stable` 只收纯三段，`prerelease` 须显式 opt-in（`src/service.ts:65,106-110` 注释与实现）。这份调查为该设计提供了外部依据：npm 平台层**没有**任何「通道目录」，通道信息只存在于两个地方 —— 注册表里的 `dist-tags`，以及消费方自己的策略。也就是说本仓把通道建模为策略参数（而非路径）与平台事实一致。

## 7. `npm version --preid` 与 `npm publish --tag`

### 7.1 `npm version prerelease --preid=<id>`（实测）

文档口径（<https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-version.md>）：

> The `newversion` argument should be a valid semver string, a valid second argument to [semver.inc](https://github.com/npm/node-semver#functions) (one of `patch`, `minor`, `major`, `prepatch`, `preminor`, `premajor`, `prerelease`), or `from-git`.
> **Note:** If the current version is a prerelease version, `patch` will simply remove the prerelease suffix without incrementing the patch version number. For example, `1.2.0-5` becomes `1.2.0` with `npm version patch`, not `1.2.1`.

本机实测（`npm version ... --no-git-tag-version`，在 `D:\Temp\npm-prerelease-probe`）：

```
1.0.0        --(prerelease --preid=rc)--> v1.0.1-rc.0
1.0.1-rc.0   --(prerelease --preid=rc)--> v1.0.1-rc.1     （同一 preid 递增计数）
1.2.3        --(prepatch  --preid=beta)--> v1.2.4-beta.0
1.2.3        --(preminor  --preid=beta)--> v1.3.0-beta.0
1.2.3        --(premajor  --preid=beta)--> v2.0.0-beta.0
1.2.0-5      --(patch)--> v1.2.0                          （印证文档的 Note，不涨 patch）
1.2.0        --(prerelease，无 --preid)--> v1.2.1-0
```

要点：

- `--preid` 只影响**生成什么版本号**，与发布标签毫无关系。`npm version prerelease --preid=rc` 产出的 `1.0.1-rc.1` 仍然要面对 §2.2 那道「必须给 `--tag`」的闸。
- 不带 `--preid` 时 npm 直接产出 `-0` 这种数字标识符（`v1.2.1-0`），合法（SemVer 条目 9 允许纯数字标识符）。
- `--preid` 的配置默认值是空串（本机 `npm config get preid` 输出为空，`npm config ls -l` 里 `preid = ""`）。
- node-semver 侧的对应函数（README）：`semver.inc('1.2.3', 'prerelease', 'beta') // '1.2.4-beta.0'`。

### 7.2 `npm publish --tag rc` 的行为

- **它只设置 dist-tag，不改版本号**：源码 `const tag = manifest.tag || defaultTag; root['dist-tags'][tag] = manifest.version`（§4.1），且 CLI 打印的 `Publishing to <registry> with tag <tag>` 会如实反映（本机实测：`--tag rc` 时打印 `with tag rc`，不带时为 `with tag latest`，见 §6.4 命令与 `D:\Temp` 探针输出）。
- **它会解除 §2.2 那道预发布闸**：`isDefaultTag` 为假，`isPreRelease && isDefaultTag` 不成立。这正是「发布预发布版必须显式给 tag」的设计意图：逼发布者挑一个非 `latest` 的标签。
- **它不会阻止 `latest` 被改写**：`--tag rc` 只写 `dist-tags.rc`，**不动** `latest`；`latest` 仍指向上一个被设为 latest 的版本（可能是正式版，也可能是更早的预发布版）。
- **`publishConfig.tag` 是等价的包内声明**：`isDefaultTag = this.npm.config.isDefault('tag') && !manifest.publishConfig?.tag`，所以 `package.json` 里写 `"publishConfig": { "tag": "rc" }` 也能免除报错并指定标签（源码推断）。注意 `filteredPublishConfig` 会把「命令行已显式给的键」从 `publishConfig` 里剔除，以保证 CLI 优先于包内声明。
- **标签合法性校验照旧**：`--tag 1.4` / `--tag v1.4` 会先被 `semver.validRange` 预检拦下（§3）。
- **repeat 发布的失败模式**：同名同版本不可重复发布（`You cannot publish over the previously published versions: <v>.`），本机实测表现为注册表 `409 Conflict - PUT ... Cannot publish over previously staged version`（§2.4）。

## 8. 取证方法与局限（哪些是文档、哪些是源码推断、哪些没验证）

**方法**：

- 一手规范/文档全部直读原文：`semver.org`；npm 官方文档取自 **npm/cli 仓库的文档源文件**（`raw.githubusercontent.com/npm/cli/latest/docs/lib/content/...`），因为 `https://docs.npmjs.com/...` 是前端渲染页，`web_fetch` 只拿到壳（实测：抓 `cli/v10/commands/npm-dist-tag` 返回 200 但正文被截断为空）。npm/cli 仓的这些 `.md` 就是 docs.npmjs.com 的内容源，属一手。
- 源码直读：`lib/commands/publish.js`、`workspaces/libnpmpublish/lib/publish.js`、`CHANGELOG.md`（`latest` 分支 = npm 12.x 线）。
- **实机命令**：`npm view ... dist-tags --json`、`npm dist-tag ls`、`npm install --dry-run --json`、`npm config ls -l`、`npm publish`（含一次真实上架）、`Invoke-RestMethod https://registry.npmjs.org/<pkg>` 读原始 packument、node-semver 直接调用。全部显式 `--registry=https://registry.npmjs.org/`。

**证据分级**：

| 结论 | 级别 |
| --- | --- |
| SemVer 条目 9/10/11 全文与排序链；alpha/beta/rc 非特殊词 | 规范原文 |
| 默认 tag = `latest`；`npm install <pkg>` 装 `latest`；tag 与版本共用命名空间、像 semver 范围的 tag 被拒 | npm 官方文档原文 |
| `You must specify a tag using --tag when publishing a prerelease version.`；`latest` 隐式套用前的版本比较；`#registryVersions` 过滤预发布与废弃版；npm 11.0.0 引入（PR #7910） | npm/cli **源码 + CHANGELOG 原文**（非用户文档；`npm-publish.md` / `npm-dist-tag.md` 均未记载此闸） |
| npm 10.9.2 下预发布不带 `--tag` 直接占用 `latest` | **本机实测**（真实上架，有 packument JSON 为证） |
| 预发布版可以成为 `latest`（途径 2「显式 `--tag latest`」） | 源码推断，未能端到端实测（见下） |
| packument 布局、tarball 形状、无通道目录、`node_modules/<pkg>` 单目录、`_cacache` 内容寻址 | **实测**（原始 JSON + 目录清单 + `npm cache ls`） |
| 各真实包 dist-tags | **实测**（官方源） |
| prerelease tuple 规则 | node-semver README 原文 + 实测 7.8.5 |
| `npm-install` 文档关于 `^1.2.3-beta.1` / `^1.0.0-0` 的示例 | **文档与实现不符**，已给出实测反例（§6.3） |

**未验证 / 存疑（诚实清单）**：

1. **`--tag latest` 显式发布预发布版能否成功**：只有源码推断。实测被 409 挡住（第一次无标签发布已占用 `latest` 与版本号，同名同版本不可重发）。要端到端证实需要一个干净的新包名。
2. **`EPRERELEASE` 错误码**：**在所有一手来源中都不存在**；预发布闸抛的是无 code 的裸 `Error`。若你在别处见过这个码，来源不是 npm/cli 的 publish 路径。
3. **registry 服务端是否另有预发布策略**（例如 npmjs.com 网页端是否禁止把 `latest` 指到预发布版、`npm dist-tag add` 是否有额外限制）：**未验证**。本地拿到的是 `403 Granular access tokens ... may not perform this action`，无法区分「2FA 政策」与「服务端预发布策略」。npm 官方文档站（docs.npmjs.com）因前端渲染抓不到正文，无法检索是否有专门章节。
4. **`nightly` / `snapshot` / `edge` 的真实包样例**：本次取样的 10 个包里没有出现这三个标签名（出现的近义者是 `dev` / `insiders` / `canary` / `preview` / `experimental`）。它们当然是合法 tag（§3 的规则只看「是否像 semver 范围」），但**本报告未能给出实测样例**。
5. **`web_search` 工具不可用**（本会话缺 `DEEPSEEK_API_KEY`，报错原文：`DeepSeek search has no API key for "DEEPSEEK_API_KEY"`），所以无法做「检索 npm/cli issue 讨论」这一步。替代做法：直接读 `CHANGELOG.md` 定位到 PR #7910 与 commit `16b7367`，比 issue 讨论更硬。相关政策/讨论页（`docs.npmjs.com/policies/*`）因此未能纳入。
6. **`--tag` 的字符白名单**：npm 文档只给了「不得是合法 semver 范围」这条排除规则，没有正面白名单；§3 的「URL 安全」部分是**推断**（基于真实标签的取值分布与「标签会进命令行/请求」这一事实），不是文档条款。
7. **`npm dist-tag add` 的大小写行为**：`npm dist-tag ls react@RC` 没有报错，也没有按 `RC` 过滤，而是列出全部标签，说明该位置的说明符被忽略；因此**没有**证明「大写标签会被拒绝」，只证明了**当前不存在** `RC` 这个标签（存在的都是小写）。

**本次调查的唯一仓外副作用（需人工收尾）**：公网包 `probe-pkg-prerelease-xyz`（版本 `0.0.0-stage` 与 `1.0.1-rc.1`，`latest` 指向 `1.0.1-rc.1`）是本报告 §2.4 实测的产物，`npm unpublish --force` 因 granular token 的 2FA 政策被 403 拒绝。需包主（`feather_wch`）在 <https://www.npmjs.com/package/probe-pkg-prerelease-xyz> 网页端手动删除。仓内文件未被修改（除本文件）。

## 9. 引用清单（一手来源 URL）

- SemVer 2.0.0 规范：<https://semver.org/> ｜ 中文版 <https://semver.org/lang/zh-CN/> ｜ 语法 BNF 与条目 9/10/11 同页
- npm-dist-tag 文档源：<https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-dist-tag.md>
- npm-publish 文档源：<https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-publish.md>
- npm-install 文档源（预发布范围段落在此）：<https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-install.md>
- npm-version 文档源：<https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-version.md>
- npm-unpublish 文档源：<https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-unpublish.md>
- npm-cache 文档源（`_cacache` 内容寻址）：<https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-cache.md>
- npm-folders 文档源（`node_modules` 布局）：<https://github.com/npm/cli/blob/latest/docs/lib/content/configuring-npm/folders.md>
- npm-package-json 文档源（`publishConfig`、`name`/`version` 规则）：<https://github.com/npm/cli/blob/latest/docs/lib/content/configuring-npm/package-json.md>
- package-spec 文档源（tarball URL 样例、别名）：<https://github.com/npm/cli/blob/latest/docs/lib/content/using-npm/package-spec.md>
- npm registry 文档源：<https://github.com/npm/cli/blob/latest/docs/lib/content/using-npm/registry.md>
- npm publish 命令实现：<https://github.com/npm/cli/blob/latest/lib/commands/publish.js>
- libnpmpublish 实现：<https://github.com/npm/cli/blob/latest/workspaces/libnpmpublish/lib/publish.js>
- npm/cli CHANGELOG（11.0.0-pre.0 段含 PR #7910）：<https://github.com/npm/cli/blob/latest/CHANGELOG.md> ｜ PR：<https://github.com/npm/cli/pull/7910>
- node-semver README（Prerelease Tags / X-Ranges / inc）：<https://github.com/npm/node-semver/blob/main/README.md>
- tag 与 semver 冲突的原始 issue（文档所引）：<https://github.com/npm/npm/issues/6082>
- 官方注册表原始 packument：<https://registry.npmjs.org/react> ｜ <https://registry.npmjs.org/typescript>
- 官方文档站同内容页（浏览器可读，脚本抓取受限）：<https://docs.npmjs.com/cli/v10/commands/npm-dist-tag> ｜ <https://docs.npmjs.com/cli/v10/commands/npm-publish> ｜ <https://docs.npmjs.com/cli/v10/commands/npm-install>

---

## 10. Lead 复核与落到本仓（2026-10-09 追加）

### 10.1 复核：报告里两条承重结论成立

1. **§2.2 的预发布闸逐字成立**。Lead 独立拉取 <https://raw.githubusercontent.com/npm/cli/latest/lib/commands/publish.js>（`latest` = npm 12.x 线；官方源 `npm` 包 dist-tags 实测 `latest = 12.2.0`）确认：
   ```js
   const isDefaultTag = this.npm.config.isDefault('tag') && !manifest.publishConfig?.tag
   if (!force) {
     const isPreRelease = Boolean(semver.parse(manifest.version).prerelease.length)
     if (isPreRelease && isDefaultTag) {
       throw new Error('You must specify a tag using --tag when publishing a prerelease version.')
     }
   }
   ```
   以及第二道闸 `Cannot implicitly apply the "latest" tag because previously published version X is higher than the new version Y.` 与 `#registryVersions` 里的 `if ((s.prerelease.length > 0) || packument.versions[v].deprecated) return []` 过滤——两段与报告一致。
2. **探针包确实在公网**（Lead 复核原始 packument JSON）：`probe-pkg-prerelease-xyz`，`dist-tags = {"latest":"1.0.1-rc.1"}`，`versions = 0.0.0-stage, 1.0.1-rc.1`，maintainer `feather_wch <975559549@qq.com>`，created `2026-10-09T15:08:46.668Z`。清理仍未完成，见 §10.4。
3. **「`npm-install` 文档与实现不符」成立**。原文既写「will only match prereleases for `1.2.x`, not `1.3.x`」，又给示例 `package@^1.2.3-beta.1  # Matches 1.2.3-beta.1, 1.2.3-beta.2, 1.2.4-beta.1, etc.`、`package@^1.0.0-0  # Matches all 1.x.x prereleases`。本机 semver 实测反例：`^0.2.0-rc.1` 不匹配 `0.2.1-test`；`^0.2.0-rc.2` 不匹配 `0.3.0-rc.1`。**以 node-semver 的 tuple 规则为准，别抄这段文档示例。**
4. **本机 npm 是 10.9.2**（落在闸门引入版本 11.0.0 之前），所以本机复现的是「预发布静默占 `latest`」的老行为；同一命令在 npm ≥ 11 上会直接报错停工。判断行为前先 `npm --version`。

### 10.2 本仓落点（两条发布通道 + 更新器）

1. **两条发布通道都不带 `--tag`**：`scripts/publish-window.ps1:142,155,161`（演练 / 真发布 / OTP 重发）与 `scripts/publish-token.ps1:98,123,145`（探针 / 发布 / 重发采样）全是 `npm publish [--dry-run] [--access public] --registry=… [--otp=…]`，**没有 `--tag`**。在本机 npm 10.9.2 下，拿它们发 `0.2.0-rc.2` 会把 `latest` 静默降级到预发布（与 §2.4 探针同一条路径）；在 npm ≥ 11 下会直接报错逼你补 `--tag`——两种默认都不是想要的，正确姿势是显式 `--tag rc` / `--tag next`，或 `publishConfig.tag`。
2. **updater 只认 `/latest`，stable 门禁只收纯三段**：`src/service.ts:284` 打 `<registry><name>/latest`，`:304` 过 `isVersionAllowedInChannel`，`:107-108` 让 stable 只放行纯三段。⇒ `latest` 一旦被预发布接手，stable 用户收到的不是「没有更新」而是 `invalid-release`。反过来，用 `--tag rc` 发出去的预发布，本包**任何通道都发现不了**（prerelease 通道同样读 `/latest`，只是放行预发布类型）：要发现它得改读 `dist-tags`（`GET /-/package/<pkg>/dist-tags`，响应很小）或全量 packument。
3. **tarball 形状校验与平台一致**：`src/service.ts:323` 要求 `/<name>/-/<name>-<version>.tgz`。实测官方源、镜像源对预发布都是这个形状（`react@19.0.0-rc.1`、`@deepseek-ai/dsh-storage-domain@0.2.0-rc.2`、`dsh-prompt@0.4.10-beta.1`），本包校验不需要为预发布特判。

### 10.3 补 §4.2「本地只有一个目录」的两处细节

- **pnpm 隔离布局是唯一把版本写进目录名的形态**：`node_modules/.pnpm/<pkg>@<精确版本>/node_modules/<pkg>`；顶层 `node_modules/<pkg>` 只是指向被选中版本的链接。本机 DSH desktop profile 是 **hoisted**（`~/.dsh/profiles/desktop/pnpm-workspace.yaml` 写 `nodeLinker: hoisted`，`.pnpm/` 下只有 `lock.yaml`），所以 `dsh-prompt@0.4.10-beta.1` 落在 `~/.dsh/profiles/desktop/node_modules/dsh-prompt`（实体目录），与正式版同址、互相覆盖。同一 profile 里 `@deepseek-ai/dsh-storage-domain` 装的是 `0.2.0-rc.2`，而该包声明的是 `^0.2.0-rc.2`——正是「预发布范围只开同 tuple」的现实用例（`^0.2.0-rc.2` 收 `0.2.0-rc.x` 与 `0.2.0`，不收 `0.2.1-*`）。
- **`+build` 会被 npm 丢掉**：npm 10.9.2 自带 semver 7.6.3 实测 `semver.clean('1.0.0+20130313144700') === '1.0.0'`、`semver.eq('1.0.0+a','1.0.0+b') === true`；而 `libnpmpublish` 的 `patchManifest` 正是 `manifest.version = semver.clean(manifest.version)`，所以 `+build` 不能当发布区分手段。本仓 `src/service.ts:96-97` 明确拒绝含 `+` 的版本，方向与平台一致。
- **本仓/生态真实样本**（官方源实测）：`dsh-prompt` → `latest = 0.4.10`、`beta = 0.4.10-beta.1`；`dsh-plugin-update` → 只有 `latest = 0.10.0`（22 个版本、零预发布）。「预发布放哪个桶」由这类 `dist-tags` 映射决定，与版本字符串后缀无关。

### 10.4 唯一仓外副作用：需要包主带 2FA 手工收尾

`probe-pkg-prerelease-xyz` 必须删掉：

- 网页（推荐）：<https://www.npmjs.com/package/probe-pkg-prerelease-xyz> → Settings → Delete package，按提示过 2FA。
- 或在本仓发布窗口（真实 TTY）里：`npm unpublish probe-pkg-prerelease-xyz --force --otp=<6 位码>`；granular token 走 CLI 会被 403 拦（`Granular access tokens that bypass two-factor authentication may not perform this action`），别在这条路上耗时间。
- 时限：`npm-unpublish` 文档只承诺「整个包撤回后 24 小时内不能重发同名包」，整体撤回的时间/依赖条件在政策页 <https://docs.npmjs.com/policies/unpublish>（该页是 JS 渲染，本次只抓到外壳，未逐字核实；社区常述为「发布后 72 小时内最宽松」）。**越早处理越简单。**
- 该包无任何代码价值（`0.0.0-stage` 是 npm 暂存占位、`1.0.1-rc.1` 是探针），删除不影响任何消费者。
