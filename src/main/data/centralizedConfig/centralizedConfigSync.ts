/**
 * Centralized config sync (Houdini/fork customization)
 *
 * Ports the pre-v2.0 `cherrystudio/core/config_manager.py` +
 * `newapi_provisioning.py` feature onto the v2.0 Provider/Model DB schema.
 *
 * Why this exists as main-process code (not a Python-side response patch):
 * v2.0 replaced the old flat `{id, apiHost, apiKey, models: []}` provider
 * blob + Redux/localStorage merge with a real SQLite-backed schema
 * (`user_provider` / `user_model`, see `data/db/schemas`). There is no
 * generic place to "inject a JSON blob" anymore — centrally-configured
 * providers/models must become real rows via `ProviderService`/`ModelService`
 * so every other v2.0 feature (model pickers, cost tracking, provider
 * settings UI) sees them exactly like a hand-added provider.
 *
 * Two data sources, deliberately split:
 * 1. `CHERRY_STUDIO_CENTRALIZED_CONFIG_PATH` (sync, local file) — provider/
 *    model *identity* (host, models, capabilities). Same env var and default
 *    resource path convention as the Python-side `config_manager.py`.
 * 2. `CHERRY_STUDIO_BACKEND_URL` + `/api/v1/config/merged` (async, HTTP) —
 *    the per-user *provisioned API key* for `apiKeyMode: "per-user-provisioned"`
 *    providers. Provisioning talks to NewAPI and needs the Houdini/OS user
 *    identity, which only the Python host process resolves — so the actual
 *    secret always comes from Python, never re-implemented here.
 *
 * Called once from `main.ts` after `application.bootstrap()` resolves (DB +
 * all core services ready). Never throws — a failure here must not prevent
 * the rest of the app (or the headless bridge) from starting.
 */
import { existsSync, readFileSync } from 'node:fs'

import { modelService } from '@data/services/ModelService'
import { providerService } from '@data/services/ProviderService'
import { loggerService } from '@logger'
import { DataApiError } from '@shared/data/api/errors'
import type { CreateModelDto, UpdateModelDto } from '@shared/data/api/schemas/models'
import type { CreateProviderDto, UpdateProviderDto } from '@shared/data/api/schemas/providers'
import {
  ENDPOINT_TYPE,
  type EndpointType,
  MODALITY,
  type Modality,
  MODEL_CAPABILITY,
  type ModelCapability
} from '@shared/data/types/model'
import type { EndpointConfigOverride, ProviderSettings } from '@shared/data/types/provider'

const logger = loggerService.withContext('CentralizedConfig')

// ─────────────────────────────────────────────────────────────────────────────
// Centralized config file shape (mirrors cherrystudio/resources/centralized-config.json)
// ─────────────────────────────────────────────────────────────────────────────

interface CentralizedModelDef {
  id: string
  name?: string
  modelId?: string
  modality?: string
  protocol?: string
  endpoint_type?: string
}

interface CentralizedProviderDef {
  id: string
  name: string
  type?: string
  apiHost: string
  apiKey?: string
  apiKeyMode?: string
  anthropicCacheControl?: {
    tokenThreshold?: number
    cacheSystemMessage?: boolean
    cacheLastNMessages?: number
  }
  models?: CentralizedModelDef[]
}

interface CentralizedConfigFile {
  providers?: CentralizedProviderDef[]
}

interface MergedConfigResponse {
  centralizedProviders?: Array<CentralizedProviderDef & { apiKey?: string }>
}

function readConfigFile(): CentralizedConfigFile | null {
  const path = process.env.CHERRY_STUDIO_CENTRALIZED_CONFIG_PATH
  if (!path) return null
  if (!existsSync(path)) {
    logger.warn('CHERRY_STUDIO_CENTRALIZED_CONFIG_PATH is set but file does not exist', { path })
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CentralizedConfigFile
  } catch (error) {
    logger.warn('Failed to parse centralized config file', { path, error })
    return null
  }
}

/**
 * Provider ids that are backed by a per-user-provisioned NewAPI account (see
 * `apiKeyMode` in `centralized-config.json` / `cherrystudio/core/newapi_provisioning.py`).
 * Only these providers have a real NewAPI account to query for actual spend —
 * used by `main/ai/utils/newApiCostLookup.ts` to decide whether it's worth
 * making the extra round trip back to Python after a completion, and by
 * `NewApiAccountBadge` (renderer) to pick a default `providerId` for the
 * account-summary query. Cached for the process lifetime: the config file is
 * static local data, not something that changes while the app is running.
 */
let cachedNewApiProviderIds: readonly string[] | null = null

export function getCentralizedNewApiProviderIds(): readonly string[] {
  if (cachedNewApiProviderIds) return cachedNewApiProviderIds
  const config = readConfigFile()
  cachedNewApiProviderIds = (config?.providers ?? [])
    .filter((provider) => provider.apiKeyMode === 'per-user-provisioned')
    .map((provider) => provider.id)
  return cachedNewApiProviderIds
}

/** Fetch per-user provisioned API keys from the Python host (never re-implemented here). */
async function fetchProvisionedApiKeys(): Promise<Map<string, string>> {
  const backendUrl = process.env.CHERRY_STUDIO_BACKEND_URL?.replace(/\/$/, '')
  const map = new Map<string, string>()
  if (!backendUrl) return map

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    const response = await fetch(`${backendUrl}/api/v1/config/merged`, { signal: controller.signal })
    clearTimeout(timeout)
    if (!response.ok) {
      logger.warn('config/merged request failed', { status: response.status })
      return map
    }
    const body = (await response.json()) as MergedConfigResponse
    for (const provider of body.centralizedProviders ?? []) {
      if (provider.id && provider.apiKey) {
        map.set(provider.id, provider.apiKey)
      }
    }
  } catch (error) {
    logger.warn('Failed to fetch provisioned API keys from Python backend', { error })
  }
  return map
}

// ─────────────────────────────────────────────────────────────────────────────
// Old-format (modality/protocol) → v2.0 (capabilities/modalities/endpointType) mapping
// ─────────────────────────────────────────────────────────────────────────────

function endpointTypeForModel(model: CentralizedModelDef): EndpointType {
  switch (model.endpoint_type) {
    case 'anthropic':
      return ENDPOINT_TYPE.ANTHROPIC_MESSAGES
    case 'openai-response':
      return ENDPOINT_TYPE.OPENAI_RESPONSES
    default:
      break
  }
  if (model.protocol === 'image-generation') return ENDPOINT_TYPE.OPENAI_IMAGE_GENERATION
  if (model.modality === 'embedding') return ENDPOINT_TYPE.OPENAI_EMBEDDINGS
  return ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
}

interface CapabilityMapping {
  capabilities: ModelCapability[]
  inputModalities: Modality[]
  outputModalities: Modality[]
  supportsStreaming: boolean
}

function mapCapabilities(model: CentralizedModelDef): CapabilityMapping {
  if (model.protocol === 'image-generation' || model.modality === 'image') {
    return {
      capabilities: [MODEL_CAPABILITY.IMAGE_GENERATION],
      inputModalities: [MODALITY.TEXT],
      outputModalities: [MODALITY.IMAGE],
      supportsStreaming: false
    }
  }
  if (model.modality === 'embedding') {
    return {
      capabilities: [MODEL_CAPABILITY.EMBEDDING],
      inputModalities: [MODALITY.TEXT],
      outputModalities: [MODALITY.VECTOR],
      supportsStreaming: false
    }
  }
  if (model.modality === 'video' || model.modality === 'motion') {
    return {
      capabilities: [MODEL_CAPABILITY.VIDEO_GENERATION],
      inputModalities: [MODALITY.TEXT],
      outputModalities: [MODALITY.VIDEO],
      supportsStreaming: false
    }
  }
  if (model.modality === 'multimodal') {
    return {
      capabilities: [MODEL_CAPABILITY.IMAGE_RECOGNITION, MODEL_CAPABILITY.FUNCTION_CALL],
      inputModalities: [MODALITY.TEXT, MODALITY.IMAGE],
      outputModalities: [MODALITY.TEXT],
      supportsStreaming: true
    }
  }
  // Plain "text" (or unknown) modality: baseline chat model.
  return {
    capabilities: [MODEL_CAPABILITY.FUNCTION_CALL],
    inputModalities: [MODALITY.TEXT],
    outputModalities: [MODALITY.TEXT],
    supportsStreaming: true
  }
}

/**
 * v2.0's `endpointConfigs[type].baseUrl` is used VERBATIM as the AI SDK
 * `baseURL` (see `main/ai/utils/provider.ts#getBaseUrl` → straight passthrough,
 * no normalization) — unlike the old v1.x runtime, which appended `/v1` itself
 * when building the actual request URL for "openai"-type providers. Every
 * working v2.0 provider (seeded defaults, v1→v2 migrator output, see
 * `ProviderModelMappings.test.ts`) stores the FULL base including `/v1` for
 * the OpenAI-shaped endpoints. `centralized-config.json`'s `apiHost` follows
 * the old (bare-host) convention, so it must be normalized here or every
 * centralized OpenAI-compatible request 404s against the real relay
 * (`/chat/completions` instead of `/v1/chat/completions`) with the stream
 * dying silently before any chunk is emitted.
 *
 * Anthropic (and other non-OpenAI-shaped) endpoints take the bare host as-is
 * — the AI SDK's Anthropic client appends `/v1/messages` itself.
 */
const OPENAI_FAMILY_ENDPOINT_TYPES: ReadonlySet<EndpointType> = new Set([
  ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
  ENDPOINT_TYPE.OPENAI_RESPONSES,
  ENDPOINT_TYPE.OPENAI_EMBEDDINGS,
  ENDPOINT_TYPE.OPENAI_IMAGE_GENERATION
])

function normalizeBaseUrl(apiHost: string, endpointType: EndpointType): string {
  const trimmed = apiHost.trim().replace(/\/+$/, '')
  if (!OPENAI_FAMILY_ENDPOINT_TYPES.has(endpointType)) return trimmed
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

function buildProviderSettings(provider: CentralizedProviderDef): Partial<ProviderSettings> | undefined {
  if (!provider.anthropicCacheControl) return undefined
  return {
    cacheControl: {
      enabled: true,
      tokenThreshold: provider.anthropicCacheControl.tokenThreshold,
      cacheSystemMessage: provider.anthropicCacheControl.cacheSystemMessage,
      cacheLastNMessages: provider.anthropicCacheControl.cacheLastNMessages
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Upsert
// ─────────────────────────────────────────────────────────────────────────────

function providerExists(providerId: string): boolean {
  try {
    providerService.getByProviderId(providerId)
    return true
  } catch (error) {
    if (error instanceof DataApiError && error.status === 404) return false
    throw error
  }
}

function modelExists(providerId: string, modelId: string): boolean {
  try {
    modelService.getByKey(providerId, modelId)
    return true
  } catch (error) {
    if (error instanceof DataApiError && error.status === 404) return false
    throw error
  }
}

function upsertProvider(provider: CentralizedProviderDef, apiKey: string | undefined): void {
  const models = provider.models ?? []
  const endpointTypes = new Set<EndpointType>(models.map(endpointTypeForModel))
  if (endpointTypes.size === 0) endpointTypes.add(ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS)

  const endpointConfigs: Partial<Record<EndpointType, EndpointConfigOverride>> = {}
  for (const endpointType of endpointTypes) {
    endpointConfigs[endpointType] = { baseUrl: normalizeBaseUrl(provider.apiHost, endpointType) }
  }
  const defaultChatEndpoint = endpointTypes.has(ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS)
    ? ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
    : (endpointTypes.values().next().value as EndpointType)

  const apiKeys = apiKey ? [{ id: 'centralized', key: apiKey, label: '中心化配置', isEnabled: true }] : []
  const providerSettings = buildProviderSettings(provider)

  if (!providerExists(provider.id)) {
    const dto: CreateProviderDto = {
      providerId: provider.id,
      name: provider.name,
      endpointConfigs,
      defaultChatEndpoint,
      apiKeys,
      authConfig: { type: 'api-key' },
      providerSettings
    }
    providerService.create(dto)
    // create() always persists isEnabled=false; a centralized provider should
    // be usable immediately without the user visiting settings.
    providerService.update(provider.id, { isEnabled: true })
    logger.info('Created centralized provider', { providerId: provider.id, hasApiKey: Boolean(apiKey) })
    return
  }

  const dto: UpdateProviderDto = {
    name: provider.name,
    endpointConfigs,
    defaultChatEndpoint,
    authConfig: { type: 'api-key' },
    providerSettings,
    isEnabled: true,
    ...(apiKey ? { apiKeys } : {})
  }
  providerService.update(provider.id, dto)
  logger.debug('Updated centralized provider', { providerId: provider.id, hasApiKey: Boolean(apiKey) })
}

function upsertModel(providerId: string, model: CentralizedModelDef): void {
  const modelId = model.modelId || model.id
  const mapping = mapCapabilities(model)
  const endpointTypes = [endpointTypeForModel(model)]

  if (!modelExists(providerId, modelId)) {
    const dto: CreateModelDto = {
      providerId,
      modelId,
      name: model.name || modelId,
      capabilities: mapping.capabilities,
      inputModalities: mapping.inputModalities,
      outputModalities: mapping.outputModalities,
      endpointTypes,
      supportsStreaming: mapping.supportsStreaming
    }
    modelService.create([{ dto }])
    return
  }

  const dto: UpdateModelDto = {
    name: model.name || modelId,
    capabilities: mapping.capabilities,
    inputModalities: mapping.inputModalities,
    outputModalities: mapping.outputModalities,
    endpointTypes,
    supportsStreaming: mapping.supportsStreaming,
    isEnabled: true
  }
  modelService.update(providerId, modelId, dto)
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sync centrally-configured providers/models into the v2.0 DB, refreshing the
 * per-user provisioned API key. Safe to call repeatedly (e.g. on every app
 * boot, or in response to a `config.reload` request) — never throws.
 */
export async function syncCentralizedConfig(): Promise<void> {
  const config = readConfigFile()
  if (!config || !config.providers || config.providers.length === 0) {
    logger.debug('No centralized config file configured; skipping sync')
    return
  }

  const apiKeys = await fetchProvisionedApiKeys()

  for (const provider of config.providers) {
    try {
      upsertProvider(provider, apiKeys.get(provider.id))
      for (const model of provider.models ?? []) {
        try {
          upsertModel(provider.id, model)
        } catch (error) {
          logger.error('Failed to sync centralized model', { providerId: provider.id, modelId: model.id, error })
        }
      }
    } catch (error) {
      logger.error('Failed to sync centralized provider', { providerId: provider.id, error })
    }
  }

  logger.info('Centralized config sync complete', {
    providers: config.providers.length,
    provisionedKeys: apiKeys.size
  })
}
