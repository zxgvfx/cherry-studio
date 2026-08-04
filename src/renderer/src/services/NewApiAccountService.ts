import { loggerService } from '@logger'

const logger = loggerService.withContext('NewApiAccountService')

const ACCOUNT_ENDPOINT = '/api/v1/newapi/account-summary'

export interface NewApiAccountSummary {
  username: string
  userId: number
  balance: number | null
  spent: number
  currency: string
  unlimitedQuota: boolean
  requestCount: number
  spendingScope: 'account'
  quotaPerUnit?: number
  cnyPerUsd?: number
}

interface AccountSummaryResponse extends Partial<NewApiAccountSummary> {
  ok?: boolean
  reason?: string
  error?: string
}

async function callBackend<T>(endpoint: string, body?: Record<string, unknown>): Promise<T | null> {
  const backend = (window as any).__cherryBackend
  const backendUrl = (window as any).__CHERRY_BACKEND_URL

  if (backend?.call) {
    return (await backend.call(endpoint, body ?? null)) as T
  }
  if (backendUrl) {
    const resp = await fetch(`${backendUrl}${endpoint}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': (window as any).__CHERRY_SESSION_ID || ''
      },
      body: body ? JSON.stringify(body) : undefined
    })
    return (await resp.json()) as T
  }
  if ((window as any).api?.config?.getNewApiAccountSummary) {
    return (await (window as any).api.config.getNewApiAccountSummary(body)) as T
  }
  return null
}

/** Primary NewAPI provider for account-level wallet summary (user quota is shared). */
export const NEWAPI_ACCOUNT_PROVIDER_ID = 'coco-vapi'

export async function fetchNewApiAccountSummary(
  providerId = NEWAPI_ACCOUNT_PROVIDER_ID
): Promise<NewApiAccountSummary | null> {
  try {
    const result = await callBackend<AccountSummaryResponse>(ACCOUNT_ENDPOINT, { providerId })
    if (result?.ok && typeof result.spent === 'number') {
      return {
        username: result.username || '',
        userId: result.userId || 0,
        balance: result.balance ?? null,
        spent: result.spent,
        currency: result.currency || '¥',
        unlimitedQuota: !!result.unlimitedQuota,
        requestCount: result.requestCount || 0,
        spendingScope: 'account',
        quotaPerUnit: result.quotaPerUnit,
        cnyPerUsd: result.cnyPerUsd
      }
    }
    logger.silly('Account summary unavailable', { reason: result?.reason || result?.error })
    return null
  } catch (error) {
    logger.warn('fetchNewApiAccountSummary failed', error as Error)
    return null
  }
}
