import type { Model, ModelModality } from '@renderer/types'

import { isEmbeddingModel, isRerankModel } from './embedding'
import {
  isDedicatedImageGenerationModel,
  isGenerate3DModel,
  isGenerateVideoModel,
  isPureGenerateImageModel,
  isVisionModel
} from './vision'

/**
 * Centralized model modality classification with explicit-field priority.
 * Prefer model.modality from centralized config; fallback to existing detectors.
 */
export function getModelPrimaryModality(model?: Model): ModelModality {
  if (!model) return 'text'

  if (model.modality) {
    return model.modality
  }

  if (isEmbeddingModel(model)) return 'embedding'
  if (isRerankModel(model)) return 'rerank'

  if (isGenerateVideoModel(model)) return 'video'

  if (isGenerate3DModel(model)) return 'model_3d'

  // Dedicated/pure image models do not participate in text tool pipelines.
  if (isDedicatedImageGenerationModel(model) || isPureGenerateImageModel(model)) {
    return 'image'
  }

  if (isVisionModel(model)) return 'multimodal'
  return 'text'
}

export function isTextChatModel(model?: Model): boolean {
  const modality = getModelPrimaryModality(model)
  return modality === 'text' || modality === 'multimodal'
}
