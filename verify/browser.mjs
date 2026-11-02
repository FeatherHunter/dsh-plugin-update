/**
 * verify/browser.mjs —— base dsh-verify 的可选浏览器适配器（本仓自备，不引第三方依赖）。
 *
 * 契约来自 base 的 adapters/browser：默认导出 { launch({ headless }) }，成功时给出
 * { newPage(), close() }；每一页要提供 url()/evaluate()/innerSize()/outerSize()/text()/
 * screenshot()/pageErrors()/close()。base 只把这些能力用于页面级检查，缺驱动时它会把检查判
 * blocked（不判 fail），所以这里解析不到 driver 时如实返回 { ok:false, error }，绝不返回假页面。
 *
 * driver 解析顺序（运行期，二选一）：
 *   1. 环境变量 DSH_VERIFY_PLAYWRIGHT 指向一个已安装 playwright 的目录（只读复用本机装置，不复制）；
 *   2. 裸包名 playwright（消费者自己装）。
 * 为什么不让本仓依赖 playwright：真机验证是开发期能力，不该让每个使用者为它装浏览器运行时。
 */
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { statSync } from 'node:fs'

const require = createRequire(import.meta.url)

/** 构造 base 契约里的 Failure 形状。 */
function failure(code, message, hint) {
  const error = { code, message }
  if (hint) error.hint = hint
  return { ok: false, error }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 从一个模块里挑出 playwright 的 chromium 门面（兼容 default 导出）。 */
function pickChromium(mod) {
  const candidate = mod && (mod.chromium || (mod.default && mod.default.chromium))
  if (candidate && typeof candidate.launch === 'function') return candidate
  return null
}

/** 按「目录 → 目录/index.js」加载一个已安装的包目录。 */
function requireDirectory(directory) {
  try {
    return require(directory)
  } catch (first) {
    try {
      return require(join(directory, 'index.js'))
    } catch (second) {
      throw first
    }
  }
}

/** 解析 driver；解析不到返回结构化 prerequisite 失败（base 会映射为 blocked）。 */
function loadChromium() {
  const candidates = []
  const override = process.env.DSH_VERIFY_PLAYWRIGHT
  if (typeof override === 'string' && override.trim() !== '') {
    candidates.push({ label: 'DSH_VERIFY_PLAYWRIGHT=' + override, load: () => requireDirectory(resolve(override)) })
  }
  candidates.push({ label: 'playwright', load: () => require('playwright') })
  const problems = []
  for (const candidate of candidates) {
    try {
      const chromium = pickChromium(candidate.load())
      if (chromium) return { ok: true, value: chromium }
      problems.push(candidate.label + '：模块里没有 chromium.launch')
    } catch (error) {
      problems.push(candidate.label + '：' + errorMessage(error))
    }
  }
  return failure(
    'prerequisite',
    '找不到可用的 playwright 驱动，页面级检查无法观测（这不是产品失败）',
    '设置 DSH_VERIFY_PLAYWRIGHT 指向已安装 playwright 的目录，或在验证环境里安装 playwright；' +
      '尝试过：' +
      problems.join('；'),
  )
}

/** 把一页包成 base 需要的 BrowserPageHandle（所有异步方法返回 Result）。 */
function wrapPage(page, pageErrors) {
  const evaluate = async (script) => {
    try {
      return { ok: true, value: await page.evaluate(script) }
    } catch (error) {
      return failure('io', 'page.evaluate 失败：' + errorMessage(error))
    }
  }
  const size = async (script) => evaluate(script)
  return {
    url: () => page.url(),
    pageErrors: () => pageErrors.slice(),
    evaluate,
    innerSize: () => size('({ width: window.innerWidth, height: window.innerHeight })'),
    outerSize: () => size('({ width: window.outerWidth, height: window.outerHeight })'),
    async text(selector) {
      try {
        const locator = page.locator(selector).first()
        return { ok: true, value: await locator.textContent() }
      } catch (error) {
        return failure('io', 'page.text(' + JSON.stringify(selector) + ') 失败：' + errorMessage(error))
      }
    },
    async screenshot(path, options) {
      try {
        await page.screenshot({ path, fullPage: Boolean(options && options.fullPage) })
        return { ok: true, value: { bytes: statSync(path).size } }
      } catch (error) {
        return failure('io', 'page.screenshot 写盘失败：' + errorMessage(error))
      }
    },
    async close() {
      try {
        await page.close()
      } catch (error) {
        // 页面已随浏览器关闭：close 是幂等收尾，不再对 base 报告错误。
      }
    },
  }
}

/** base 的 BrowserProbeFactory：launch({ headless }) → Result<BrowserSessionHandle>。 */
async function launch(options) {
  const chromium = loadChromium()
  if (!chromium.ok) return chromium
  let browser
  try {
    browser = await chromium.value.launch({ headless: options && options.headless !== false })
  } catch (error) {
    return failure('prerequisite', 'playwright chromium 启动失败：' + errorMessage(error))
  }
  return {
    ok: true,
    value: {
      async newPage() {
        try {
          const page = await browser.newPage()
          const pageErrors = []
          page.on('pageerror', (error) => pageErrors.push(errorMessage(error)))
          return { ok: true, value: wrapPage(page, pageErrors) }
        } catch (error) {
          return failure('io', 'playwright 打开新页面失败：' + errorMessage(error))
        }
      },
      async close() {
        try {
          await browser.close()
        } catch (error) {
          // 浏览器已退出：关停是幂等收尾。
        }
      },
    },
  }
}

export default { launch }
