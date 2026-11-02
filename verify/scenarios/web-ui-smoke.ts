/**
 * verify/scenarios/web-ui-smoke.ts —— 「base run 场景快速通道」的证明场景（不是票场景）。
 *
 * 它证明三件事，缺一不可：
 * 1. launch 步起的隔离 web 宿主能在几秒内 ready，并把实例记录交给 custom 步；
 * 2. 用 instance.record.tokenUrl 真 goto 能渲染出真 UI——不是那张 'authentication required' 页；
 * 3. 截图能落成 PNG + 六字段 sidecar，供 scenario-run 的校验器独立复核。
 *
 * 断言写事实：body 是否含未认证标记、body 是否出现插件面板、截图是否非空且带旁注。
 * 为了让这条场景同时充当上游证明，它不假装产品功能通过——只证明「观测装置真的在观测」。
 */
import { defineScenario } from 'dsh-featherhunter-plugin-base/real-machine-verification'
import type { ScenarioContext, ScenarioObservation } from 'dsh-featherhunter-plugin-base/real-machine-verification'
import { join } from 'node:path'
import {
  captureShot,
  looksLikeAuthRequired,
  openAuthenticatedPage,
  readBodyText,
  waitForBodyText,
} from '../../selftest/real-machine/base-verify/web-ui.ts'

/** 截图目录：由 scenario-run 通过 BASE_UI_SHOTS 指定；手工直跑时退到 DSH_HOME 的兄弟目录。 */
function resolveShotsDir(): string {
  const fromEnv = process.env.BASE_UI_SHOTS
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(process.env.DSH_HOME ?? process.cwd(), '..', 'shots')
}

/** body 开头截断，证据里放全文会淹掉判定。 */
function headOf(text: string, limit = 160): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= limit ? compact : compact.slice(0, limit) + '…'
}

export default defineScenario<ScenarioContext>({
  id: 'web-ui-smoke',
  title: '真 UI 快速通道：隔离 web 宿主渲染 + 截图旁注',
  description:
    '起一个隔离 web 宿主，用实例记录的 tokenUrl 打开真 UI，断言不是未认证页并出现插件面板，截一张带六字段 sidecar 的图。',
  steps: [
    {
      id: 'launch-isolated-web',
      title: '起隔离 web 宿主',
      kind: 'launch',
      timeoutMs: 120000,
    },
    {
      id: 'open-real-ui',
      title: '用 tokenUrl 打开真 UI 并留证',
      kind: 'custom',
      timeoutMs: 120000,
      run: async (context: ScenarioContext): Promise<readonly ScenarioObservation[]> => {
        const observations: ScenarioObservation[] = []
        const shotsDir = resolveShotsDir()
        const instance = context.instance
        if (instance === null) {
          return [
            {
              checkId: 'ui-instance-present',
              title: 'launch 步留下了实例记录',
              ok: false,
              status: 'fail',
              detail: 'custom 步里 context.instance 为空，无法拿到 tokenUrl',
              expected: 'context.instance 非空且 record.tokenUrl 可用',
              actual: 'context.instance=null',
              hint: '检查 launch 步是否成功；失败时看 instance.stdout.log / stderr.log',
            },
          ]
        }
        const record = instance.record
        context.note('ui-smoke: instance ' + String(record.instanceId ?? '?') + ' ready in ' + String(record.readyMs) + 'ms')
        const opened = await openAuthenticatedPage(record.tokenUrl)
        if (!opened.ok) {
          return [
            {
              checkId: 'ui-driver',
              title: 'Playwright driver 可用',
              ok: false,
              status: 'blocked',
              detail: opened.problems.join('；'),
              expected: '能加载 playwright 并打开实例页面',
              actual: opened.problems.join('；'),
              hint: opened.hint,
            },
          ]
        }
        try {
          const page = opened.session.page
          const firstBody = await readBodyText(page)
          const authFailed = looksLikeAuthRequired(firstBody)
          observations.push({
            checkId: 'ui-auth-gate',
            title: '页面不是「需要认证」的空壳',
            ok: !authFailed && firstBody.trim() !== '',
            status: !authFailed && firstBody.trim() !== '' ? 'pass' : 'fail',
            detail: authFailed
              ? 'tokenUrl goto 后仍是未认证页：' + headOf(firstBody)
              : '真 UI 已渲染，body 前 160 字：' + headOf(firstBody),
            expected: 'body 非空且不含 authentication required',
            actual: 'body 长度 ' + String(firstBody.length) + '，未认证标记=' + String(authFailed),
            hint: '必须用 instance.record.tokenUrl 做一次 goto；token 缺失会停在 origin root',
          })
          const panel = await waitForBodyText(page, /插件/, { timeoutMs: 15000 })
          observations.push({
            checkId: 'ui-plugin-panel',
            title: '真 UI 出现插件面板',
            ok: panel.matched,
            status: panel.matched ? 'pass' : 'fail',
            detail: panel.matched
              ? 'body 在 ' + String(panel.elapsedMs) + 'ms 内出现「插件」，实际片段：' + headOf(panel.body)
              : '等了 ' + String(panel.elapsedMs) + 'ms 未见「插件」，body 前 160 字：' + headOf(panel.body),
            expected: '渲染后的 body 含插件入口（插件面板/插件列表）',
            actual: 'matched=' + String(panel.matched) + '，等待 ' + String(panel.elapsedMs) + 'ms',
            hint: '若 body 已渲染但无「插件」，以实际渲染文本为准调整断言，不要放宽到空断言',
          })
          const bodyForShot = await readBodyText(page)
          const shot = await captureShot(page, shotsDir, 'web-ui-smoke', {
            what: '真 UI 首屏：隔离 web 宿主用 tokenUrl 打开后的渲染结果',
            steps: 'launch 隔离 web 宿主 → 从 instance.record.tokenUrl goto → 等 body 非空并出现「插件」→ 截图',
            expected: '真 UI 渲染（非认证页），侧栏/面板含插件入口',
            actual: 'body 前 160 字：' + headOf(bodyForShot),
            verdict: !looksLikeAuthRequired(bodyForShot) && bodyForShot.trim() !== '' ? 'pass' : 'fail',
            note: '截图目录=' + shotsDir,
          })
          observations.push({
            checkId: 'ui-shot-sidecar',
            title: '截图与六字段 sidecar 已落盘',
            ok: shot.bytes > 0,
            status: shot.bytes > 0 ? 'pass' : 'fail',
            detail: 'png=' + shot.png + '（' + String(shot.bytes) + ' 字节），sidecar=' + shot.sidecar,
            expected: '非空 PNG + 同名 JSON（看什么/步骤/expected/actual/判定/备注）',
            actual: 'png ' + String(shot.bytes) + ' 字节',
            hint: 'sidecar 六字段缺一，scenario-run 会按 fail 记',
          })
          return observations
        } finally {
          await opened.session.close()
        }
      },
    },
    {
      id: 'stop-host',
      title: '停宿主并释放端口',
      kind: 'stop',
      timeoutMs: 60000,
    },
  ],
  notes: [
    '本场景只证明观测装置（launch/tokenUrl/截图/旁注）可用，不代表产品功能验收。',
    'base 的 PageHandle 没有 goto；必须从 instance.record.tokenUrl 自己开页，否则会停在 authentication required 页。',
  ],
})
