import { loggerService } from '@logger'
import AiProviderNew from '@renderer/aiCore/index_new'
import type { GenerateImageResponse, Model, Provider } from '@renderer/types'

import { getProviderByModelId } from './AssistantService'
import { getRotatedApiKey } from './providerKey'

const logger = loggerService.withContext('ImageGenerationService')

export const DEFAULT_UNIFIED_IMAGE_MODEL_ID = 'nano-banana-pro'
const DEFAULT_IMAGE_SIZE = '1024x1024'
const DEFAULT_BATCH_SIZE = 1

type UnifiedImageOptions = {
  modelId?: string
  imageSize?: string
  batchSize?: number
  signal?: AbortSignal
}

function previewPrompt(prompt: string, limit = 120): string {
  const compact = prompt.replace(/\s+/g, ' ').trim()
  if (compact.length <= limit) return compact
  return `${compact.slice(0, limit)}...`
}

function summarizeImages(images: string[]): { count: number; sample: string; allDataUrl: boolean } {
  const validImages = images.filter(Boolean)
  const sample = validImages[0] ? validImages[0].slice(0, 80) : ''
  const allDataUrl = validImages.length > 0 && validImages.every((item) => item.startsWith('data:'))
  return {
    count: validImages.length,
    sample,
    allDataUrl
  }
}

function tryResolveModel(modelId: string): { provider: Provider; model: Model } | null {
  const provider = getProviderByModelId(modelId)
  if (!provider) {
    return null
  }
  const model = provider.models.find((item) => item.id === modelId)
  if (!model) {
    return null
  }
  return { provider, model }
}

function resolveModel(modelId: string): { provider: Provider; model: Model } {
  const resolved = tryResolveModel(modelId)
  if (!resolved) {
    throw new Error(`Image model not found: ${modelId}`)
  }
  return resolved
}

function normalizeImageResponse(images: string[]): GenerateImageResponse | null {
  const validImages = images.filter((image) => !!image)
  if (!validImages.length) {
    return null
  }

  const isBase64 = validImages.every((image) => image.startsWith('data:'))
  return {
    type: isBase64 ? 'base64' : 'url',
    images: validImages
  }
}

export async function generateUnifiedImage(
  prompt: string,
  options: UnifiedImageOptions = {}
): Promise<GenerateImageResponse | null> {
  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) {
    logger.warn('[UnifiedImage] Empty prompt received, skip generation.')
    return null
  }

  const modelId = options.modelId || DEFAULT_UNIFIED_IMAGE_MODEL_ID
  const { provider, model } = resolveModel(modelId)
  logger.info('[UnifiedImage] Start image generation request', {
    requestedModelId: modelId,
    providerId: provider.id,
    providerType: provider.type,
    imageSize: options.imageSize || DEFAULT_IMAGE_SIZE,
    batchSize: options.batchSize || DEFAULT_BATCH_SIZE,
    promptLength: trimmedPrompt.length,
    promptPreview: previewPrompt(trimmedPrompt),
    hasAbortSignal: !!options.signal
  })
  const providerWithRotatedKey = {
    ...provider,
    apiKey: getRotatedApiKey(provider)
  }

  try {
    logger.info('[UnifiedImage] Try fixed model', {
      modelId: model.id,
      providerId: provider.id,
      providerType: provider.type
    })
    const ai = new AiProviderNew(model, providerWithRotatedKey)
    const images = await ai.generateImage({
      model: model.id,
      prompt: trimmedPrompt,
      imageSize: options.imageSize || DEFAULT_IMAGE_SIZE,
      batchSize: options.batchSize || DEFAULT_BATCH_SIZE,
      signal: options.signal
    })
    logger.info('[UnifiedImage] Fixed model returned raw images', {
      modelId: model.id,
      providerId: provider.id,
      summary: summarizeImages(images)
    })

    const normalized = normalizeImageResponse(images)
    if (normalized) {
      logger.info('[UnifiedImage] Fixed model normalized success', {
        modelId: model.id,
        responseType: normalized.type,
        imageCount: normalized.images.length
      })
      return normalized
    }

    logger.warn('[UnifiedImage] Fixed model produced empty normalized result', {
      modelId: model.id,
      providerId: provider.id
    })
    throw new Error(`${model.id}: empty image result`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(
      '[UnifiedImage] Fixed model failed',
      {
        modelId: model.id,
        providerId: provider.id,
        errorMessage: message
      },
      error as Error
    )
    throw new Error(`Image generation failed. ${model.id}: ${message}`)
  }
}
