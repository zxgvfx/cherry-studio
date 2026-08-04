import { describe, expect, it, vi } from 'vitest'

import { fetchNewApiDisplayRates, quotaToDisplayMoney } from './newApiStatus'

describe('newApiStatus', () => {
  it('parses usd_exchange_rate and quota_per_unit from /api/status', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { usd_exchange_rate: 1, quota_per_unit: 500000 }
      })
    }) as typeof fetch

    const rates = await fetchNewApiDisplayRates('http://new-api.example:3000/', { forceRefresh: true })
    expect(rates).toEqual({ quotaPerUnit: 500000, usdExchangeRate: 1 })
  })

  it('converts quota to CNY using site display rate only', () => {
    const cost = quotaToDisplayMoney(1_000_000, { quotaPerUnit: 500_000, usdExchangeRate: 1 }, '¥')
    expect(cost).toBe(2)
  })
})
