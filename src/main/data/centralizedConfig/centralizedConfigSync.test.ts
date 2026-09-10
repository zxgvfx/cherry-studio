import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  modelService: {
    delete: vi.fn(),
    list: vi.fn(),
    update: vi.fn()
  },
  providerService: {
    delete: vi.fn(),
    list: vi.fn(),
    update: vi.fn()
  }
}))

vi.mock('@data/services/ModelService', () => ({ modelService: mocks.modelService }))
vi.mock('@data/services/ProviderService', () => ({ providerService: mocks.providerService }))
vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    })
  }
}))
vi.mock('./backendUrlRegistry', () => ({ getBackendUrl: () => '' }))

import {
  isCentralizedEntryEnabled,
  reconcileCentralizedProviderModels,
  reconcileRemovedCentralizedProviders
} from './centralizedConfigSync'

describe('centralized config authoritative reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.modelService.delete.mockImplementation(() => undefined)
    mocks.modelService.update.mockImplementation(() => undefined)
    mocks.providerService.delete.mockImplementation(() => undefined)
    mocks.providerService.update.mockImplementation(() => undefined)
  })

  it('deletes models removed from a centralized provider catalog', () => {
    mocks.modelService.list.mockReturnValue([{ apiModelId: 'kept-model' }, { apiModelId: 'removed-model' }])

    reconcileCentralizedProviderModels({
      id: 'central-provider',
      name: 'Central',
      apiHost: 'https://example.test',
      models: [{ id: 'kept-model' }]
    })

    expect(mocks.modelService.delete).toHaveBeenCalledOnce()
    expect(mocks.modelService.delete).toHaveBeenCalledWith('central-provider', 'removed-model')
    expect(mocks.modelService.update).not.toHaveBeenCalled()
  })

  it('disables and hides a stale model when referential integrity blocks deletion', () => {
    mocks.modelService.list.mockReturnValue([{ apiModelId: 'referenced-model' }])
    mocks.modelService.delete.mockImplementation(() => {
      throw new Error('model is in use')
    })

    reconcileCentralizedProviderModels({
      id: 'central-provider',
      name: 'Central',
      apiHost: 'https://example.test',
      models: []
    })

    expect(mocks.modelService.update).toHaveBeenCalledWith('central-provider', 'referenced-model', {
      isEnabled: false,
      isHidden: true,
      isDeprecated: true
    })
  })

  it('removes only centrally managed providers missing from the config', () => {
    mocks.providerService.list.mockReturnValue([
      { id: 'central-kept', settings: { isCentralized: true } },
      { id: 'central-removed', settings: { isCentralized: true } },
      { id: 'user-provider', settings: {} }
    ])

    reconcileRemovedCentralizedProviders(new Set(['central-kept']))

    expect(mocks.providerService.delete).toHaveBeenCalledOnce()
    expect(mocks.providerService.delete).toHaveBeenCalledWith('central-removed')
  })

  it('treats explicit false as disabled and everything else as enabled', () => {
    expect(isCentralizedEntryEnabled(false)).toBe(false)
    expect(isCentralizedEntryEnabled(true)).toBe(true)
    expect(isCentralizedEntryEnabled(undefined)).toBe(true)
  })
})
