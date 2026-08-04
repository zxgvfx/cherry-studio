import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveUsername: vi.fn(),
  getSecret: vi.fn(),
  saveSecret: vi.fn()
}))

vi.mock('./NewApiIdentityResolver', () => ({
  newApiIdentityResolver: {
    resolveUsername: mocks.resolveUsername
  }
}))

vi.mock('./NewApiSecretStorage', () => ({
  newApiSecretStorage: {
    get: mocks.getSecret,
    save: mocks.saveSecret
  }
}))

import { NewApiProvisioningService } from './NewApiProvisioningService'
import type { ProviderConfig } from './types'

const ENDPOINT = 'http://new-api.ccc.net:8080/provision'

const provider: ProviderConfig = {
  id: 'centralized-openai',
  name: 'Coco',
  type: 'openai',
  apiHost: 'http://new-api.ccc.net:3000',
  apiKeyMode: 'per-user-provisioned',
  provisioning: {
    provider: 'newapi',
    endpoint: ENDPOINT,
    secret: 'test-secret',
    tokenName: 'cherrystudio-default',
    group: 'default',
    unlimitedQuota: true,
    usernameSource: 'local-config'
  },
  models: []
}

function jsonResponse(data: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Error',
    json: async () => data
  } as Response
}

describe('NewApiProvisioningService', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.resolveUsername.mockResolvedValue('zhaopeng')
    mocks.getSecret.mockResolvedValue(null)
    mocks.saveSecret.mockResolvedValue(undefined)
  })

  it('reuses a locally stored key when it validates successfully', async () => {
    mocks.getSecret.mockResolvedValue({
      providerId: provider.id,
      username: 'zhaopeng',
      apiKey: 'sk-cached',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ data: [] }))

    const result = await new NewApiProvisioningService().provisionProvider(provider)

    expect(result.apiKey).toBe('sk-cached')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(mocks.saveSecret).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-cached' }))
  })

  it('provisions via the endpoint (with shared secret header) when cache is missing', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.href === ENDPOINT) {
        return jsonResponse({
          success: true,
          data: {
            userId: 42,
            tokenId: 7,
            tokenName: 'cherrystudio-default',
            apiKey: 'sk-provisioned'
          }
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const result = await new NewApiProvisioningService().provisionProvider(provider)

    expect(result.apiKey).toBe('sk-provisioned')

    const [, init] = (global.fetch as any).mock.calls[0]
    expect(init.method).toBe('POST')
    expect(init.headers['X-Provision-Secret']).toBe('test-secret')
    const sentBody = JSON.parse(init.body)
    expect(sentBody).toMatchObject({ username: 'zhaopeng', tokenName: 'cherrystudio-default', group: 'default' })

    expect(mocks.saveSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: provider.id,
        username: 'zhaopeng',
        userId: 42,
        tokenId: 7,
        tokenName: 'cherrystudio-default',
        apiKey: 'sk-provisioned'
      })
    )
  })
})
