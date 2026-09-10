import { providerService } from '@data/services/ProviderService'
import { loggerService } from '@logger'
import { getBaseUrl, getExtraHeaders } from '@main/ai/utils/provider'
import { ENDPOINT_TYPE } from '@shared/data/types/model'
import { formatApiHost } from '@shared/utils/api'

import { splitAgentModel } from './pipelineClient'

const logger = loggerService.withContext('CocoCherryProvider')

export interface CherryChatCredentials {
  providerId: string
  modelId: string
  apiKey: string
  chatCompletionsUrl: string
  headers: Record<string, string>
}

function joinChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  return `${trimmed}/chat/completions`
}

/**
 * Resolve Cherry's stored provider + API key for a Coco agent model id
 * (`providerId::modelId`). Returns null when no local credentials are
 * available. COCO agent loops are client-only and never fall back to Pipeline.
 */
export function resolveCherryChatCredentials(uniqueModelId: string | null | undefined): CherryChatCredentials | null {
  const { providerId, modelId } = splitAgentModel(uniqueModelId)
  if (!providerId || !modelId) return null
  try {
    const provider = providerService.getByProviderId(providerId)
    const apiKey = providerService.resolveApiKey(providerId).value?.trim() || ''
    if (!apiKey && !provider.authOptional) return null
    const baseUrl = getBaseUrl(provider, ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS)
    if (!baseUrl.trim()) return null
    const host = formatApiHost(baseUrl, true)
    if (!host) return null
    return {
      providerId,
      modelId,
      apiKey,
      chatCompletionsUrl: joinChatCompletionsUrl(host),
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...getExtraHeaders(provider)
      }
    }
  } catch (error) {
    logger.debug('Cherry chat credentials unavailable for local Hermes', error as Error)
    return null
  }
}
