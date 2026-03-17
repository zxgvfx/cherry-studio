import type { Model, ModelPrimaryModality } from '@renderer/types'

import { isEmbeddingModel, isRerankModel } from './embedding'
import { isDedicatedImageGenerationModel, isGenerate3DModel, isPureGenerateImageModel, isVisionModel } from './vision'

/**
 * Centralized model modality classification with explicit-field priority.
 * Prefer model.primaryModality from centralized config; fallback to existing detectors.
 */
export function getModelPrimaryModality(model?: Model): ModelPrimaryModality {
  if (!model) return 'text'

  if (model.primaryModality) {
    return model.primaryModality
  }

  if (isEmbeddingModel(model)) return 'embedding'
  if (isRerankModel(model)) return 'rerank'

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

