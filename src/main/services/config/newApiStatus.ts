/**
 * Public display rates from NewAPI GET /api/status.
 * Group ratios are already baked into log quota server-side; only use usd_exchange_rate here.
 */

const DEFAULT_QUOTA_PER_UNIT = 500_000
const DEFAULT_USD_EXCHANGE_RATE = 1
const CACHE_TTL_MS = 5 * 60 * 1000

export interface NewApiDisplayRates {
  quotaPerUnit: number
  usdExchangeRate: number
}

type CacheEntry = { expires: number; rates: NewApiDisplayRates }

const cache = new Map<string, CacheEntry>()

function parseStatusBody(body: unknown): NewApiDisplayRates {
  if (!body || typeof body !== 'object') {
    throw new Error('invalid status response')
  }
  const root = body as Record<string, unknown>
  const data = (root.data ?? root) as Record<string, unknown>

  let quotaPerUnit = Number(data.quota_per_unit ?? DEFAULT_QUOTA_PER_UNIT)
  let usdExchangeRate = Number(data.usd_exchange_rate ?? DEFAULT_USD_EXCHANGE_RATE)
  if (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) {
    quotaPerUnit = DEFAULT_QUOTA_PER_UNIT
  }
  if (!Number.isFinite(usdExchangeRate) || usdExchangeRate <= 0) {
    usdExchangeRate = DEFAULT_USD_EXCHANGE_RATE
  }
  return { quotaPerUnit, usdExchangeRate }
}

export async function fetchNewApiDisplayRates(
  apiHost: string,
  options: { timeoutMs?: number; forceRefresh?: boolean } = {}
): Promise<NewApiDisplayRates> {
  const base = apiHost.replace(/\/+$/, '')
  if (!base) {
    return { quotaPerUnit: DEFAULT_QUOTA_PER_UNIT, usdExchangeRate: DEFAULT_USD_EXCHANGE_RATE }
  }

  const now = Date.now()
  if (!options.forceRefresh) {
    const cached = cache.get(base)
    if (cached && cached.expires > now) {
      return cached.rates
    }
  }

  const timeoutMs = options.timeoutMs ?? 5_000
  try {
    const response = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) {
      throw new Error(`/api/status failed: ${response.status}`)
    }
    const body = await response.json()
    const rates = parseStatusBody(body)
    cache.set(base, { expires: now + CACHE_TTL_MS, rates })
    return rates
  } catch (error) {
    const stale = cache.get(base)
    if (stale) {
      return stale.rates
    }
    return { quotaPerUnit: DEFAULT_QUOTA_PER_UNIT, usdExchangeRate: DEFAULT_USD_EXCHANGE_RATE }
  }
}

export function quotaToDisplayMoney(quota: number, rates: NewApiDisplayRates, currency: string | undefined): number {
  const usd = quota / rates.quotaPerUnit
  const symbol = currency || '$'
  if (symbol === '¥' || symbol === 'CNY' || symbol.toLowerCase() === 'cny') {
    return Number((usd * rates.usdExchangeRate).toFixed(4))
  }
  return Number(usd.toFixed(4))
}
