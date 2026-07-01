import { loggerService } from '@logger'

import { newApiIdentityResolver } from './NewApiIdentityResolver'
import { newApiSecretStorage, type StoredNewApiKey } from './NewApiSecretStorage'
import type { NewApiProvisioningConfig, ProviderConfig } from './types'

const logger = loggerService.withContext('NewApiProvisioningService')

interface ProvisionedNewApiKey {
  apiKey: string
  userId?: number
  tokenId?: number
  tokenName?: string
  username: string
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
    const cached = await newApiSecretStorage.get(provider.id, username)
    if (cached?.apiKey && (await this.isApiKeyUsable(provider.apiHost, cached.apiKey))) {
      await newApiSecretStorage.save({
        ...cached,
        lastValidatedAt: new Date().toISOString()
      })
      return { ...provider, apiKey: cached.apiKey }
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
      createdAt: cached?.createdAt || now,
      lastValidatedAt: now
    }
    await newApiSecretStorage.save(secret)

    return { ...provider, apiKey: provisioned.apiKey }
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
      apiKey: data.apiKey
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
}

export const newApiProvisioningService = new NewApiProvisioningService()
