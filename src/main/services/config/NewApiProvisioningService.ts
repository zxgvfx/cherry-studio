import { loggerService } from '@logger'

import { newApiIdentityResolver } from './NewApiIdentityResolver'
import { newApiSecretStorage, type StoredNewApiKey } from './NewApiSecretStorage'
import {
  AccessTokenInvalidError,
  isAccessTokenInvalidMessage,
  loadSharedAccessToken,
  saveSharedAccessToken
} from './newApiSharedPat'
import { fetchNewApiDisplayRates, quotaToDisplayMoney } from './newApiStatus'
import type { NewApiProvisioningConfig, ProviderConfig } from './types'

const logger = loggerService.withContext('NewApiProvisioningService')

interface ProvisionedNewApiKey {
  apiKey: string
  accessToken?: string
  userId?: number
  tokenId?: number
  tokenName?: string
  username: string
}

export interface RequestCostResult {
  ok: boolean
  cost?: number
  usd?: number
  quota?: number
  currency?: string
  modelName?: string
  reason?: string
}

export class NewApiProvisioningService {
  private readonly inFlight = new Map<string, Promise<ProviderConfig>>()

  async provisionProvider(provider: ProviderConfig): Promise<ProviderConfig> {
    if (provider.apiKeyMode !== 'per-user-provisioned') {
      return provider
    }

    const provisioning = provider.provisioning || {}
    if ((provisioning.provider || 'newapi') !== 'newapi') {
      logger.warn(`Unsupported provisioning provider for ${provider.id}: ${provisioning.provider}`)
      return { ...provider, apiKey: '' }
    }

    const username = await newApiIdentityResolver.resolveUsername(provisioning.usernameSource)
    const cacheKey = `${provider.id}:${username}`
    const current = this.inFlight.get(cacheKey)
    if (current) {
      return current
    }

    const task = this.resolveProviderKey(provider, username, provisioning).finally(() => this.inFlight.delete(cacheKey))
    this.inFlight.set(cacheKey, task)
    return task
  }

  private async resolveProviderKey(
    provider: ProviderConfig,
    username: string,
    provisioning: NewApiProvisioningConfig
  ): Promise<ProviderConfig> {
    let cached = await newApiSecretStorage.get(provider.id, username)
    if (cached?.apiKey && (await this.isApiKeyUsable(provider.apiHost, cached.apiKey))) {
      const sharedPat = await loadSharedAccessToken(provider.apiHost, username)
      if (sharedPat) {
        cached = { ...cached, accessToken: sharedPat }
      } else if (provisioning.costTracking?.enabled && !cached.accessToken) {
        try {
          logger.info(`Refreshing accessToken for ${provider.id}/${username}`)
          const provisioned = await this.provisionNewApiKey(provider, username, provisioning)
          if (provisioned.accessToken) {
            cached = {
              ...cached,
              userId: provisioned.userId ?? cached.userId,
              tokenId: provisioned.tokenId ?? cached.tokenId,
              tokenName: provisioned.tokenName ?? cached.tokenName,
              accessToken: provisioned.accessToken
            }
            await saveSharedAccessToken(provider.apiHost, username, provisioned.accessToken, cached.userId)
            await newApiSecretStorage.save(cached)
          }
        } catch (error) {
          logger.warn(`Failed to refresh accessToken for ${provider.id}`, error as Error)
        }
      }

      await newApiSecretStorage.save({
        ...cached,
        lastValidatedAt: new Date().toISOString()
      })
      return this.withCostTracking({ ...provider, apiKey: cached.apiKey }, cached.accessToken)
    }

    const provisioned = await this.provisionNewApiKey(provider, username, provisioning)
    const now = new Date().toISOString()
    const secret: StoredNewApiKey = {
      providerId: provider.id,
      username,
      userId: provisioned.userId,
      tokenId: provisioned.tokenId,
      tokenName: provisioned.tokenName,
      apiKey: provisioned.apiKey,
      accessToken: provisioned.accessToken || cached?.accessToken,
      createdAt: cached?.createdAt || now,
      lastValidatedAt: now
    }
    if (provisioned.accessToken) {
      await saveSharedAccessToken(provider.apiHost, username, provisioned.accessToken, secret.userId)
    }
    await newApiSecretStorage.save(secret)

    return this.withCostTracking({ ...provider, apiKey: provisioned.apiKey }, secret.accessToken)
  }

  /**
   * Attach a frontend-visible costTracking flag when both an access token and a
   * costTracking config exist. The access token itself never leaves the main process.
   */
  private withCostTracking(provider: ProviderConfig, accessToken?: string): ProviderConfig {
    const cfg = provider.provisioning?.costTracking
    if (!accessToken || !cfg?.enabled) {
      return provider
    }
    return {
      ...provider,
      costTracking: {
        enabled: true,
        currency: cfg.currency || '$'
      }
    }
  }

  private async provisionNewApiKey(
    provider: ProviderConfig,
    username: string,
    provisioning: NewApiProvisioningConfig
  ): Promise<ProvisionedNewApiKey> {
    if (!provisioning.endpoint) {
      throw new Error('NewAPI provisioning endpoint is not configured')
    }
    return this.provisionViaEndpoint(provider, username, provisioning)
  }

  private async provisionViaEndpoint(
    provider: ProviderConfig,
    username: string,
    provisioning: NewApiProvisioningConfig
  ): Promise<ProvisionedNewApiKey> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const secret = (provisioning.secret || process.env.PROVISION_SHARED_SECRET || '').trim()
    if (secret) {
      headers['X-Provision-Secret'] = secret
    }

    const response = await fetch(provisioning.endpoint!, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        providerId: provider.id,
        apiHost: provider.apiHost,
        username,
        tokenName: provisioning.tokenName || 'cherrystudio-default',
        group: provisioning.group || 'default'
      }),
      signal: AbortSignal.timeout(30_000)
    })
    const body = await response.json()

    if (!response.ok || body?.success === false) {
      throw new Error(body?.message || `NewAPI provisioning endpoint failed: ${response.status}`)
    }

    const data = body?.data || body
    if (!data?.apiKey) {
      throw new Error('NewAPI provisioning endpoint response is missing apiKey')
    }

    return {
      username,
      userId: data.userId,
      tokenId: data.tokenId,
      tokenName: data.tokenName || provisioning.tokenName || 'cherrystudio-default',
      apiKey: data.apiKey,
      accessToken: data.accessToken
    }
  }

  private async isApiKeyUsable(apiHost: string, apiKey: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.normalizeBaseUrl(apiHost)}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5_000)
      })
      return response.ok
    } catch {
      return false
    }
  }

  private normalizeBaseUrl(apiHost: string): string {
    return apiHost.replace(/\/+$/, '')
  }

  /**
   * Query NewAPI's /api/log/self for the most recent request that matches the
   * given model/token counts and convert its internal quota into money.
   * The access token stays in the main process and is never exposed to the renderer.
   */
  async getLastRequestCost(
    provider: ProviderConfig,
    params: {
      modelName?: string
      promptTokens?: number
      completionTokens?: number
      sinceTs?: number
    },
    options: { retries?: number; retryDelayMs?: number } = {}
  ): Promise<RequestCostResult> {
    const cfg = provider.provisioning?.costTracking
    if (!cfg?.enabled) {
      return { ok: false, reason: 'cost-tracking-disabled' }
    }

    const username = await newApiIdentityResolver.resolveUsername(provider.provisioning?.usernameSource)
    let stored = await newApiSecretStorage.get(provider.id, username)
    if (!stored) {
      return { ok: false, reason: 'missing-secret' }
    }

    let accessToken = (await loadSharedAccessToken(provider.apiHost, username)) || stored.accessToken
    let userId = stored.userId
    if (!accessToken || !userId) {
      const refreshed = await this.refreshAccessToken(provider, username, stored)
      accessToken = refreshed?.accessToken
      userId = refreshed?.userId ?? userId
    }
    if (!accessToken || !userId) {
      return { ok: false, reason: 'missing-access-token' }
    }

    const currency = cfg.currency || '$'
    const rates = await fetchNewApiDisplayRates(provider.apiHost)

    const retries = options.retries ?? 6
    const retryDelayMs = options.retryDelayMs ?? 600

    let lastError: string | undefined
    let refreshedPat = false
    for (let attempt = 0; attempt < Math.max(1, retries); attempt++) {
      try {
        const item = await this.findMatchingLog(provider.apiHost, accessToken, userId, params)
        if (item) {
          const quota = Number(item.quota) || 0
          const usd = quota / rates.quotaPerUnit
          const cost = quotaToDisplayMoney(quota, rates, currency)
          return {
            ok: true,
            quota,
            usd: Number(usd.toFixed(6)),
            cost: Number(cost.toFixed(6)),
            currency,
            modelName: item.model_name
          }
        }
      } catch (error) {
        if (error instanceof AccessTokenInvalidError && !refreshedPat) {
          refreshedPat = true
          const refreshed = await this.refreshAccessToken(provider, username, stored)
          if (refreshed?.accessToken) {
            accessToken = refreshed.accessToken
            userId = refreshed.userId ?? userId
            stored = refreshed
            continue
          }
        }
        lastError = (error as Error).message
      }
      if (attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      }
    }
    return { ok: false, reason: lastError || 'not-found' }
  }

  private async refreshAccessToken(
    provider: ProviderConfig,
    username: string,
    stored: StoredNewApiKey
  ): Promise<StoredNewApiKey | null> {
    const provisioning = provider.provisioning
    if (!provisioning) {
      return null
    }
    const provisioned = await this.provisionNewApiKey(provider, username, provisioning)
    if (!provisioned.accessToken) {
      return null
    }
    const updated: StoredNewApiKey = {
      ...stored,
      userId: provisioned.userId ?? stored.userId,
      tokenId: provisioned.tokenId ?? stored.tokenId,
      tokenName: provisioned.tokenName ?? stored.tokenName,
      accessToken: provisioned.accessToken,
      lastValidatedAt: new Date().toISOString()
    }
    await saveSharedAccessToken(provider.apiHost, username, provisioned.accessToken, updated.userId)
    await newApiSecretStorage.save(updated)
    return updated
  }

  private async findMatchingLog(
    apiHost: string,
    accessToken: string,
    userId: number,
    params: { modelName?: string; promptTokens?: number; completionTokens?: number; sinceTs?: number }
  ): Promise<any | null> {
    const base = this.normalizeBaseUrl(apiHost)
    const url = new URL(`${base}/api/log/self`)
    url.searchParams.set('p', '1')
    url.searchParams.set('page_size', '20')
    url.searchParams.set('type', '2')
    if (params.sinceTs) {
      url.searchParams.set('start_timestamp', String(params.sinceTs - 30))
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'New-API-User': String(userId)
      },
      signal: AbortSignal.timeout(8_000)
    })
    if (!response.ok) {
      throw new Error(`/api/log/self failed: ${response.status}`)
    }
    const body = await response.json()
    if (body?.success === false && isAccessTokenInvalidMessage(body?.message)) {
      throw new AccessTokenInvalidError(String(body.message))
    }
    const items: any[] = body?.data?.items || body?.data || []
    if (!Array.isArray(items) || items.length === 0) {
      return null
    }

    const scored = items.filter((it) => {
      if (params.sinceTs && Number(it.created_at) < params.sinceTs - 30) return false
      return true
    })

    const exact = scored.find((it) => {
      const modelOk = !params.modelName || it.model_name === params.modelName
      const promptOk = params.promptTokens === undefined || Number(it.prompt_tokens) === params.promptTokens
      const completionOk =
        params.completionTokens === undefined || Number(it.completion_tokens) === params.completionTokens
      return modelOk && promptOk && completionOk
    })
    if (exact) return exact

    const byModel = scored.find((it) => !params.modelName || it.model_name === params.modelName)
    if (byModel) return byModel

    if (params.modelName) {
      const newestByModel = items.find((it) => it.model_name === params.modelName)
      if (newestByModel) return newestByModel
    }
    return items[0] || null
  }
}

export const newApiProvisioningService = new NewApiProvisioningService()
