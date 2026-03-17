import { getProviderByModel } from '@renderer/services/AssistantService'
import type { Model } from '@renderer/types'
import { getLowerBaseModelName, isUserSelectedModelType } from '@renderer/utils'

import { isEmbeddingModel, isRerankModel } from './embedding'
import { isFunctionCallingModel } from './tooluse'

// Vision models
const visionAllowedModels = [
  'llava',
  'moondream',
  'minicpm',
  'gemini-1\\.5',
  'gemini-2\\.0',
  'gemini-2\\.5',
  'gemini-3(?:\\.\\d+)?-(?:flash|pro)(?:-preview)?(?:-[\\w-]+)?',
  'gemini-(flash|pro|flash-lite)-latest',
  'gemini-exp',
  'claude-3',
  'claude-haiku-4',
  'claude-sonnet-4',
  'claude-opus-4',
  'vision',
  'glm-4(?:\\.\\d+)?v(?:-[\\w-]+)?',
  'qwen-vl',
  'qwen2-vl',
  'qwen2.5-vl',
  'qwen3-vl',
  'qwen3\\.5(?:-[\\w-]+)?',
  'qwen2.5-omni',
  'qwen3-omni(?:-[\\w-]+)?',
  'qvq',
  'internvl2',
  'grok-vision-beta',
  'grok-4(?:-[\\w-]+)?',
  'pixtral',
  'gpt-4(?:-[\\w-]+)',
  'gpt-4.1(?:-[\\w-]+)?',
  'gpt-4o(?:-[\\w-]+)?',
  'gpt-4.5(?:-[\\w-]+)',
  'gpt-5(?:-[\\w-]+)?',
  'chatgpt-4o(?:-[\\w-]+)?',
  'o1(?:-[\\w-]+)?',
  'o3(?:-[\\w-]+)?',
  'o4(?:-[\\w-]+)?',
  'deepseek-vl(?:[\\w-]+)?',
  'kimi-k2.5',
  'kimi-latest',
  'gemma-3(?:-[\\w-]+)',
  'doubao-seed-1[.-][68](?:-[\\w-]+)?',
  'doubao-seed-2[.-]0(?:-[\\w-]+)?',
  'doubao-seed-code(?:-[\\w-]+)?',
  'kimi-thinking-preview',
  `gemma3(?:[-:\\w]+)?`,
  'kimi-vl-a3b-thinking(?:-[\\w-]+)?',
  'llama-guard-4(?:-[\\w-]+)?',
  'llama-4(?:-[\\w-]+)?',
  'step-1o(?:.*vision)?',
  'step-1v(?:-[\\w-]+)?',
  'qwen-omni(?:-[\\w-]+)?',
  'mistral-large-(2512|latest)',
  'mistral-medium-(2508|latest)',
  'mistral-small-(2506|latest)'
]

const visionExcludedModels = [
  'gpt-4-\\d+-preview',
  'gpt-4-turbo-preview',
  'gpt-4-32k',
  'gpt-4-\\d+',
  'o1-mini',
  'o3-mini',
  'o1-preview',
  'AIDC-AI/Marco-o1'
]
const VISION_REGEX = new RegExp(
  `\\b(?!(?:${visionExcludedModels.join('|')})\\b)(${visionAllowedModels.join('|')})\\b`,
  'i'
)

// All dedicated image generation models (only generate images, no text chat capability)
// These models need:
// 1. Route to dedicated image generation API
// 2. Exclude from reasoning/websearch/tooluse selection
const DEDICATED_IMAGE_MODELS = [
  // OpenAI series
  'dall-e(?:-[\\w-]+)?',
  'gpt-image(?:-[\\w-]+)?',
  // xAI
  'grok-2-image(?:-[\\w-]+)?',
  // Google
  'imagen(?:-[\\w-]+)?',
  // Stable Diffusion series
  'flux(?:-[\\w-]+)?',
  'stable-?diffusion(?:-[\\w-]+)?',
  'stabilityai(?:-[\\w-]+)?',
  'sd-[\\w-]+',
  'sdxl(?:-[\\w-]+)?',
  // zhipu
  'cogview(?:-[\\w-]+)?',
  // Alibaba
  'qwen-image(?:-[\\w-]+)?',
  // Others
  'janus(?:-[\\w-]+)?',
  'midjourney(?:-[\\w-]+)?',
  'mj-[\\w-]+',
  'z-image(?:-[\\w-]+)?',
  'longcat-image(?:-[\\w-]+)?',
  'hunyuanimage(?:-[\\w-]+)?',
  'seedream(?:-[\\w-]+)?',
  'kandinsky(?:-[\\w-]+)?',
  'gemini-nano-blanan',
  'nano-banana(?:-[\\w-]+)?'
]

const IMAGE_ENHANCEMENT_MODELS = [
  'grok-2-image(?:-[\\w-]+)?',
  'qwen-image-edit',
  'gpt-image-1',
  'gemini-2.5-flash-image(?:-[\\w-]+)?',
  'gemini-2.0-flash-preview-image-generation',
  'gemini-3(?:\\.\\d+)?-(?:flash|pro)-image(?:-[\\w-]+)?',
  'nano-banana(?:-[\\w-]+)?'
]

const IMAGE_ENHANCEMENT_MODELS_REGEX = new RegExp(IMAGE_ENHANCEMENT_MODELS.join('|'), 'i')

const DEDICATED_IMAGE_MODEL_REGEX = new RegExp(DEDICATED_IMAGE_MODELS.join('|'), 'i')

// Models that should auto-enable image generation button when selected
const AUTO_ENABLE_IMAGE_MODELS = [
  'gemini-2.5-flash-image(?:-[\\w-]+)?',
  'gemini-3(?:\\.\\d+)?-(?:flash|pro)-image(?:-[\\w-]+)?',
  ...DEDICATED_IMAGE_MODELS
]

const AUTO_ENABLE_IMAGE_MODELS_REGEX = new RegExp(AUTO_ENABLE_IMAGE_MODELS.join('|'), 'i')

const OPENAI_TOOL_USE_IMAGE_GENERATION_MODELS = [
  'o3',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-5'
]

const OPENAI_IMAGE_GENERATION_MODELS = [...OPENAI_TOOL_USE_IMAGE_GENERATION_MODELS, 'gpt-image-1']

const MODERN_IMAGE_MODELS = ['gemini-3(?:\\.\\d+)?-(?:flash|pro)-image(?:-[\\w-]+)?']

const GENERATE_IMAGE_MODELS = [
  'gemini-2.0-flash-exp(?:-[\\w-]+)?',
  'gemini-2.5-flash-image(?:-[\\w-]+)?',
  'gemini-2.0-flash-preview-image-generation',
  'gemini-3(?:\\.\\d+)?-flash(?:-[\\w-]+)?',
  ...MODERN_IMAGE_MODELS,
  ...DEDICATED_IMAGE_MODELS
]

const OPENAI_IMAGE_GENERATION_MODELS_REGEX = new RegExp(OPENAI_IMAGE_GENERATION_MODELS.join('|'), 'i')

const GENERATE_IMAGE_MODELS_REGEX = new RegExp(GENERATE_IMAGE_MODELS.join('|'), 'i')

const MODERN_GENERATE_IMAGE_MODELS_REGEX = new RegExp(MODERN_IMAGE_MODELS.join('|'), 'i')

/**
 * Check if the model is a dedicated image generation model
 * Dedicated image generation models can only generate images, no text chat capability
 *
 * These models need:
 * 1. Route to dedicated image generation API
 * 2. Exclude from reasoning/websearch/tooluse selection
 */
export function isDedicatedImageModel(model: Model): boolean {
  if (!model) return false
  // primaryModality 优先判断
  if (model.primaryModality === 'image') return true
  if (model.primaryModality === 'text' || model.primaryModality === 'multimodal') return false
  const modelId = getLowerBaseModelName(model.id)
  return DEDICATED_IMAGE_MODEL_REGEX.test(modelId)
}

// Backward compatible aliases
export const isDedicatedImageGenerationModel = isDedicatedImageModel

export const isAutoEnableImageGenerationModel = (model: Model): boolean => {
  if (!model) return false
  // 纯图片模型：始终自动启用图片生成
  if (model.primaryModality === 'image') return true
  // 纯文本模型：不自动启用
  if (model.primaryModality === 'text') return false
  // multimodal：由 regex 决定是否自动启用

  const modelId = getLowerBaseModelName(model.id)
  return AUTO_ENABLE_IMAGE_MODELS_REGEX.test(modelId)
}

/**
 * 判断模型是否支持对话式的图片生成
 * @param model
 * @returns
 */
export function isGenerateImageModel(model: Model): boolean {
  if (!model || isEmbeddingModel(model) || isRerankModel(model)) {
    return false
  }

  // primaryModality: "image" → 纯图片模型，一定支持图片生成
  if (model.primaryModality === 'image') return true
  // primaryModality: "text" → 纯文本模型，不支持图片生成
  if (model.primaryModality === 'text') return false
  // primaryModality: "multimodal" → 由 regex 判断是否支持图片生成（如 gemini-*-image-*）

  const provider = getProviderByModel(model)

  if (!provider) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id, '/')

  if (provider.type === 'openai-response') {
    return OPENAI_IMAGE_GENERATION_MODELS_REGEX.test(modelId) || GENERATE_IMAGE_MODELS_REGEX.test(modelId)
  }

  return GENERATE_IMAGE_MODELS_REGEX.test(modelId)
}

// TODO: refine the regex
/**
 * 判断模型是否支持纯图片生成（不支持通过工具调用）
 * @param model
 * @returns
 */
export function isPureGenerateImageModel(model: Model): boolean {
  if (!isGenerateImageModel(model) && !isTextToImageModel(model)) {
    return false
  }

  if (isFunctionCallingModel(model)) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id)
  if (GENERATE_IMAGE_MODELS_REGEX.test(modelId) && !MODERN_GENERATE_IMAGE_MODELS_REGEX.test(modelId)) {
    return true
  }

  return !OPENAI_TOOL_USE_IMAGE_GENERATION_MODELS.some((m) => modelId.includes(m))
}

// Backward compatible alias - now uses unified dedicated image model detection
export const isTextToImageModel = isDedicatedImageModel

/**
 * 判断模型是否支持图片增强（包括编辑、增强、修复等）
 * @param model
 */
export function isImageEnhancementModel(model: Model): boolean {
  const modelId = getLowerBaseModelName(model.id)
  return IMAGE_ENHANCEMENT_MODELS_REGEX.test(modelId)
}

export function isVisionModel(model: Model): boolean {
  if (!model || isEmbeddingModel(model) || isRerankModel(model)) {
    return false
  }

  // primaryModality 显式标注为 multimodal 或 image 的模型一定支持视觉输入
  if (model.primaryModality === 'multimodal' || model.primaryModality === 'image') return true
  if (model.primaryModality === 'text') return false

  if (isUserSelectedModelType(model, 'vision') !== undefined) {
    return isUserSelectedModelType(model, 'vision')!
  }

  const modelId = getLowerBaseModelName(model.id)
  if (model.provider === 'doubao' || modelId.includes('doubao')) {
    return VISION_REGEX.test(model.name) || VISION_REGEX.test(modelId) || false
  }

  return VISION_REGEX.test(modelId) || IMAGE_ENHANCEMENT_MODELS_REGEX.test(modelId) || false
}

const GENERATE_3D_MODELS_REGEX =
  /hunyuan3d|hunyuan-3d|hy3d|hi3dgen|step1x-3d|trellis|meshy|shap-?e|point-?e|3d-gen|text-to-3d|instant3d|triposr/i

export function isGenerate3DModel(model?: Model | null): boolean {
  if (!model) return false
  if (model.primaryModality === 'model_3d') return true

  const modelId = getLowerBaseModelName(model.id)
  return GENERATE_3D_MODELS_REGEX.test(modelId)
}
