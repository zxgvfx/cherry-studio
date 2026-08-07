/**
 * Real NewAPI request-cost lookup (Houdini/fork customization).
 *
 * Ports the pre-v2.0 `fetchLastRequestCost` feature (see old
 * `cherrystudio/public/assets/store-*.js` bundle, `NewApiCostService`): after
 * a billable language completion finishes, ask the Python host to correlate
 * the request against NewAPI's own consumption log (`/api/log/self`) and
 * return the *actual* amount NewAPI charged — as opposed to
 * `AiUsageRecordService`'s locally-computed estimate from a static per-model
 * price table, which cannot reflect NewAPI-side markup, tiered pricing, or
 * quota packages.
 *
 * This is a best-effort correction applied *after* the invocation row is
 * already recorded with the local estimate (see `hooks/billingHook.ts`):
 * NewAPI's log endpoint has its own propagation delay and correlating by
 * token counts/timestamp is inherently approximate, so it must never block
 * or fail the primary usage-recording path.
 *
 * Only attempted for providers seeded by `centralizedConfigSync.ts` with
 * `apiKeyMode: "per-user-provisioned"` — hand-added providers have no
 * associated NewAPI account to query.
 */
import { loggerService } from '@logger'
import { CURRENCY, type Currency } from '@shared/data/types/model'

import { getBackendUrl } from '../../data/centralizedConfig/backendUrlRegistry'
import { getCentralizedNewApiProviderIds } from '../../data/centralizedConfig/centralizedConfigSync'

const logger = loggerService.withContext('NewApiCostLookup')

export function isNewApiBillableProvider(providerId: string | null | undefined): boolean {
  if (!providerId) return false
  return getCentralizedNewApiProviderIds().includes(providerId)
}

interface LastCostParams {
  providerId: string
  modelName?: string | null
  promptTokens?: number
  completionTokens?: number
  /** Unix seconds; narrows the NewAPI log correlation window. */
  sinceTs: number
}

interface LastCostResult {
  amount: number
  currency: Currency
}

function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (Object.values(CURRENCY) as string[]).includes(value)
}

/**
 * Resolves to `undefined` on any failure (network error, no matching log
 * entry yet, provider not billable, malformed response) — callers treat
 * "no correction" as the normal outcome, not an error.
 */
export async function fetchNewApiLastRequestCost(params: LastCostParams): Promise<LastCostResult | undefined> {
  const backendUrl = getBackendUrl()
  if (!backendUrl) return undefined

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    const response = await fetch(`${backendUrl}/api/v1/newapi/last-cost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: params.providerId,
        modelName: params.modelName ?? undefined,
        promptTokens: params.promptTokens,
        completionTokens: params.completionTokens,
        sinceTs: params.sinceTs
      }),
      signal: controller.signal
    })
    clearTimeout(timeout)
    if (!response.ok) {
      logger.debug('last-cost request failed', { status: response.status, providerId: params.providerId })
      return undefined
    }
    const body = (await response.json()) as { ok?: boolean; cost?: unknown; currency?: unknown; reason?: string }
    if (!body?.ok || typeof body.cost !== 'number' || !Number.isFinite(body.cost) || body.cost < 0) {
      logger.debug('No NewAPI cost resolved for request', { providerId: params.providerId, reason: body?.reason })
      return undefined
    }
    return { amount: body.cost, currency: isCurrency(body.currency) ? body.currency : CURRENCY.CNY }
  } catch (error) {
    logger.debug('fetchNewApiLastRequestCost failed', { error, providerId: params.providerId })
    return undefined
  }
}
