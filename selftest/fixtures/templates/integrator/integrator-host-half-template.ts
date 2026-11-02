/**
 * selftest/fixtures/templates/integrator/integrator-host-half-template.ts —— 批量集成方 host half 的 TS 源模板。
 *
 * 生成物落在夹具包的 src/index.ts，再由 esbuild 打成 lib/index.js（Node ESM，外部依赖走 profile 的 node_modules）。
 * 内容三件事（每件都对应 #258/#266 的一条验收）：
 *   1. createMultiHostUpdate：按身份单源接线批量电话 + 每个目标的单插件电话（批量面板/中枢靠它）；
 *   2. HTTP 桥：DSH 没有内建 host↔client 电话通道，client half 用同源 fetch 走这座桥；
 *   3. 构建标记电话：把 host 侧版本 + 行为字段回报给 client（重启后 UI 上能看出 host 代码真的换了）。
 */
import type { FixtureBuildTags, FixtureSlot, FixtureVariantEffect } from '../../identity/fixture-slots.ts'
import { FIXTURE_REGISTRY_ENV, fixtureBridgeRouteOf, fixtureBuildTagPhoneOf } from '../../identity/fixture-slots.ts'

/** 集成方 host half 的渲染入参。 */
export interface IntegratorHostHalfInputs {
  readonly slot: FixtureSlot
  /** 只是让调用方把版本显式带进来（可见变化在 buildTags 里）；渲染不直接用它。 */
  readonly version: string
  readonly buildTags: FixtureBuildTags
  /** 版本变体效果（缺省 = T1 单面板效果）。 */
  readonly effect?: FixtureVariantEffect
}

/** 单引号包一层（夹具身份值都是简单字面量，不含引号/反斜杠；不引第三方工具）。 */
function quote(value: string): string {
  return "'" + value + "'"
}

/** 渲染集成方 host half 的 TypeScript 源码。 */
export function renderIntegratorHostHalf(inputs: IntegratorHostHalfInputs): string {
  const { slot, buildTags } = inputs
  const batch = slot.batch
  if (slot.role !== 'integrator' || !batch || !slot.selfTargetPrefix) {
    throw new Error('[fixtures] 席位 ' + slot.key + ' 不是集成方，不能渲染集成方 host half')
  }
  const effect = inputs.effect ?? { ui: 'single' as const, titleSuffix: '', hubDock: false, hostBehavior: null, seatLine: '' }
  const targetLines = batch.targets
    .map(
      (target) =>
        '      { key: ' +
        quote(target.key) +
        ', title: ' +
        quote(target.title) +
        ', packageName: ' +
        quote(target.packageName) +
        ', prefix: ' +
        quote(target.prefix) +
        ' },',
    )
    .join('\n')
  const targetKeys = quote(batch.targets.map((target) => target.key).join('/'))
  const behaviorLiteral = effect.hostBehavior === null ? 'null' : quote(effect.hostBehavior)
  return [
    '// [TEST ONLY] 夹具 host half（#266 生成产物，勿手改；源模板 = selftest/fixtures/templates/integrator）',
    "import { createMultiHostUpdate } from 'dsh-plugin-update/batch'",
    '',
    'export const name = ' + quote(slot.packageName),
    "export const inject = ['webServer']",
    'export const BUILD_TAG = ' + quote(buildTags.hostTag),
    'export const ROUTE = ' + quote(fixtureBridgeRouteOf(slot)),
    'const BUILD_TAG_PHONE = ' + quote(fixtureBuildTagPhoneOf(slot)),
    // #266 场景 b 的「host 行为变化」机器可读证据：变体版回包多一个 behavior 字段（基版 null）。
    'export const HOST_BEHAVIOR = ' + behaviorLiteral,
    '// 批量席位声明（变体版的 host 侧也能自证：我这一席负责哪些目标）。',
    'export const TARGET_KEYS = ' + targetKeys,
    '',
    'type Json = Record<string, unknown>',
    'type PhoneHandler = (args?: Json) => Promise<unknown>',
    '',
    'function readJsonBody(req: any): Promise<unknown> {',
    '  return new Promise((resolve, reject) => {',
    "    let text = ''",
    "    req.on('data', (chunk: unknown) => { text += String(chunk) })",
    "    req.on('end', () => { try { resolve(text ? JSON.parse(text) : null) } catch (error) { reject(error) } })",
    "    req.on('error', (error: unknown) => { reject(error) })",
    '  })',
    '}',
    '',
    'function writeJson(res: any, status: number, body: Json): void {',
    '  res.statusCode = status',
    "  res.setHeader('content-type', 'application/json; charset=utf-8')",
    '  res.end(JSON.stringify(body))',
    '}',
    '',
    'function registryUrlOf(config: Json): string | undefined {',
    '  const configured = (config as { registryUrl?: unknown }).registryUrl',
    "  if (typeof configured === 'string' && configured.length > 0) return configured",
    '  const fromEnv = process.env[' + quote(FIXTURE_REGISTRY_ENV) + ']',
    "  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined",
    '}',
    '',
    'export function apply(ctx: any, config: Json = {}): void {',
    '  const registryUrl = registryUrlOf(config)',
    '  const deps: Json = { ctx, logCtx: null }',
    "  if (registryUrl) deps['config'] = { registryUrl }",
    '  const multi = createMultiHostUpdate(deps as any, {',
    '    prefix: ' + quote(batch.prefix) + ',',
    '    selfKey: ' + quote(batch.selfKey) + ',',
    '    selfOrder: ' + quote(batch.selfOrder) + ',',
    '    drain: false,',
    '    targets: [',
    targetLines,
    '    ],',
    '  })',
    '  const handlers: Record<string, PhoneHandler> = {}',
    '  for (const phone of Object.keys(multi.handlers)) {',
    '    handlers[phone] = multi.handlers[phone] as PhoneHandler',
    '  }',
    '  handlers[BUILD_TAG_PHONE] = async () => ({',
    '    buildTag: BUILD_TAG,',
    '    role: ' + quote(slot.role) + ',',
    '    packageName: name,',
    '    behavior: HOST_BEHAVIOR,',
    '    targetKeys: TARGET_KEYS,',
    '  })',
    '  const bridge = async (req: any, res: any): Promise<void> => {',
    "    if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }",
    '    let body: Json | null = null',
    "    try { body = (await readJsonBody(req)) as Json | null } catch (error) { writeJson(res, 400, { ok: false, error: 'bad-json' }); return }",
    "    const phone = body && typeof body['phone'] === 'string' ? String(body['phone']) : ''",
    '    const handler = handlers[phone]',
    "    if (typeof handler !== 'function') { writeJson(res, 404, { ok: false, error: 'unknown-phone' }); return }",
    "    const args = body && typeof body['args'] === 'object' && body['args'] !== null ? (body['args'] as Json) : {}",
    '    try { writeJson(res, 200, { ok: true, reply: await handler(args) }) }',
    '    catch (error) { writeJson(res, 200, { ok: false, error: String((error as any)?.message ?? error) }) }',
    '  }',
    "  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: bridge }), " + quote(slot.packageName + ': phone bridge') + ')',
    '}',
    '',
  ].join('\n')
}
