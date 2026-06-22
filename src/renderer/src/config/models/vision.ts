import { getProviderByModel } from '@renderer/services/AssistantService'
import type { Model } from '@renderer/types'
import { getLowerBaseModelName, isUserSelectedModelType } from '@renderer/utils'

import { isEmbeddingModel, isRerankModel } from './embedding'
import { isFunctionCallingModel } from './tooluse'

export const GPT_IMAGE_MAX_INPUT_IMAGES = 4
export const NANO_BANANA_MAX_INPUT_IMAGES = 6
export const GPT_IMAGE_OUTPUT_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const

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
  // gpt-image 家族（gpt-image-1 / 1.5 / 1-mini / 2 及带后缀变种）
  // 都支持通过 /v1/images/edits 做图生图编辑。
  'gpt-image[\\w.-]+',
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
  // modality 优先判断
  if (model.modality === 'image') return true
  if (model.modality === 'text' || model.modality === 'multimodal') return false
  const modelId = getLowerBaseModelName(model.id)
  return DEDICATED_IMAGE_MODEL_REGEX.test(modelId)
}

// Backward compatible aliases
export const isDedicatedImageGenerationModel = isDedicatedImageModel

export const isAutoEnableImageGenerationModel = (model: Model): boolean => {
  if (!model) return false
  // 纯图片模型：始终自动启用图片生成
  if (model.modality === 'image') return true
  // 纯文本模型：不自动启用
  if (model.modality === 'text') return false
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

  // modality: "image" → 纯图片模型，一定支持图片生成
  if (model.modality === 'image') return true
  // modality: "text" → 纯文本模型，不支持图片生成
  if (model.modality === 'text') return false
  // modality: "multimodal" → 由 regex 判断是否支持图片生成（如 gemini-*-image-*）

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

/**
 * 判断模型是否是 gpt-image 家族（gpt-image-1 / gpt-image-1.5 / gpt-image-2 / gpt-image-1-mini，
 * 以及网关上可能出现的带 `-preview` / `-pro` 等后缀的变种）。
 *
 * 这一家族走 `/v1/images/generations` 或 `/v1/images/edits` 独立端点，
 * 通过 body 字段（size / quality / n / background / output_format）控制生图行为。
 *
 * 文档：
 *   - 文生图  https://api-gpt-ge.apifox.cn/288964677e0
 *   - 图生图  https://api-gpt-ge.apifox.cn/210463340e0
 *
 * 兼容多种 id 形态：
 *   - `gpt-image-1`、`gpt-image-1.5`、`gpt-image-2`、`gpt-image-1-mini`
 *   - `openai/gpt-image-1.5` 之类带 provider 前缀（`getLowerBaseModelName` 会先剥前缀）
 *   - `gpt-image-2-preview` / `gpt-image-pro` 等网关变种
 *   - 兜底：纯 `gpt-image`（不带版本号）
 */
export function isGptImageModel(model: Model): boolean {
  if (!model) return false
  const modelId = getLowerBaseModelName(model.id)
  // 主名以 `gpt-image` 开头即可。这种"前缀匹配"很激进，
  // 但 gpt-image 是 OpenAI 独有命名，几乎不会误伤其他厂商。
  return /^gpt-image(?:[-.]|$)/.test(modelId)
}

export function getImageEditMaxInputImages(model: Model | undefined): number {
  if (!model) return GPT_IMAGE_MAX_INPUT_IMAGES
  const modelId = getLowerBaseModelName(model.id)
  if (/^nano-banana(?:[-.]|$)/.test(modelId)) return NANO_BANANA_MAX_INPUT_IMAGES
  return GPT_IMAGE_MAX_INPUT_IMAGES
}

/**
 * 是否是 gpt-image-2 子型号（含 mini / preview 等变种）。
 * 主要用于 size/background/input_fidelity 等参数的差异化处理：
 *   - gpt-image-2 接受任意 16 倍数 ≤3840 的 size
 *   - gpt-image-2 不支持 `background: 'transparent'`
 *   - gpt-image-2 不支持 `input_fidelity`
 */
export function isGptImage2Model(model: Model | undefined): boolean {
  if (!model) return false
  const modelId = getLowerBaseModelName(model.id)
  return /^gpt-image-2(?:[-.]|$)/.test(modelId)
}

/**
 * 是否是 gpt-image-1 / 1.5 / 1-mini 系列（旧版）。
 * 这些子型号的 `size` 必须在固定 enum 内（`1024x1024` / `1024x1536` / `1536x1024` / `auto`）。
 */
export function isGptImage1FamilyModel(model: Model | undefined): boolean {
  if (!model) return false
  const modelId = getLowerBaseModelName(model.id)
  return /^gpt-image-1(?:\.\d+|-mini)?(?:[-.]|$)/.test(modelId)
}

/** gpt-image-1 / 1.5 / mini 允许的 size 枚举（OpenAI 官方）。 */
const GPT_IMAGE_1_FIXED_SIZES = ['auto', '1024x1024', '1024x1536', '1536x1024'] as const

/**
 * 校验并规范化 size，针对不同子型号有不同约束。
 *
 * gpt-image-2 约束（官方文档）：
 *   - 任意一条边 ≤ 3840
 *   - 两边都必须是 16 的倍数
 *   - 长短边比例 ≤ 3:1
 *   - 总像素 ∈ [655_360, 8_294_400]
 *
 * gpt-image-1 / 1.5 / mini：必须是固定 enum 之一。
 *
 * 返回值：
 *   - `{ ok: true, size }`：合法，可以直接发
 *   - `{ ok: false, size: 'auto' }`：不合法，建议 fallback 到 auto
 */
export function validateGptImageSize(
  model: Model | undefined,
  size: string | undefined
): { ok: boolean; size: string; reason?: string } {
  if (!size || size === 'auto') return { ok: true, size: 'auto' }

  if (isGptImage1FamilyModel(model)) {
    if ((GPT_IMAGE_1_FIXED_SIZES as readonly string[]).includes(size)) {
      return { ok: true, size }
    }
    return { ok: false, size: 'auto', reason: `gpt-image-1 family only accepts ${GPT_IMAGE_1_FIXED_SIZES.join(', ')}` }
  }

  if (isGptImage2Model(model)) {
    const m = /^(\d+)x(\d+)$/.exec(size)
    if (!m) return { ok: false, size: 'auto', reason: `size "${size}" is not "WxH"` }
    const w = Number(m[1])
    const h = Number(m[2])
    if (w > 3840 || h > 3840) return { ok: false, size: 'auto', reason: 'edge > 3840' }
    if (w % 16 !== 0 || h % 16 !== 0) return { ok: false, size: 'auto', reason: 'edges must be multiples of 16' }
    const long = Math.max(w, h)
    const short = Math.min(w, h)
    if (long / short > 3) return { ok: false, size: 'auto', reason: 'long:short ratio > 3:1' }
    const total = w * h
    if (total < 655_360 || total > 8_294_400) {
      return { ok: false, size: 'auto', reason: `total pixels ${total} not in [655360, 8294400]` }
    }
    return { ok: true, size }
  }

  // 其他 gpt-image 变种（gpt-image-pro 等未知子型号）：宽松透传
  return { ok: true, size }
}

/**
 * gpt-image 系列质量档位（gpt.ge 网关 body 字段 `quality`）。
 */
export const GPT_IMAGE_QUALITIES = ['auto', 'high', 'medium', 'low'] as const

/**
 * gpt-image-2 的 `size` 在 gpt.ge 网关下是自由格式（`WxH`，16 倍数，≤ 3840），
 * 因此 UI 拆成两个维度：**宽高比** + **长边档位**。
 *
 * 文档参考：https://api-gpt-ge.apifox.cn/288964677e0
 */
export const GPT_IMAGE_ASPECT_RATIOS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const
export const GPT_IMAGE_RESOLUTION_TIERS = ['auto', '1k', '2k', '3k', '4k'] as const

/**
 * 长边像素档位映射。
 * - `4k` 选取 3840，正好是 gpt-image-2 网关声明的上限（且 3840 = 240×16，满足 16 倍数）
 */
const GPT_IMAGE_TIER_LONG_EDGE: Record<Exclude<(typeof GPT_IMAGE_RESOLUTION_TIERS)[number], 'auto'>, number> = {
  '1k': 1024,
  '2k': 2048,
  '3k': 3072,
  '4k': 3840
}

const GPT_IMAGE_RATIO_FRAC: Record<Exclude<(typeof GPT_IMAGE_ASPECT_RATIOS)[number], 'auto'>, [number, number]> = {
  '1:1': [1, 1],
  '16:9': [16, 9],
  '9:16': [9, 16],
  '4:3': [4, 3],
  '3:4': [3, 4],
  '3:2': [3, 2],
  '2:3': [2, 3]
}

/**
 * 根据"宽高比 + 长边档位"计算 gpt-image-2 的 size 字符串。
 *
 * 规则：
 *   - 任一为 `auto` / `undefined` → 返回 `'auto'`，让模型/原图决定
 *   - 长边取档位像素，短边按比例算
 *   - 两边对齐到 16 的倍数（向下取整，确保不超过 3840）
 *
 * 例：
 *   - 1:1 + 1k → `1024x1024`
 *   - 16:9 + 2k → `2048x1152`
 *   - 9:16 + 4k → `2160x3840`
 *   - 3:2 + 3k → `3072x2048`
 */
export function computeGptImageSize(
  ratio: (typeof GPT_IMAGE_ASPECT_RATIOS)[number] | undefined,
  tier: (typeof GPT_IMAGE_RESOLUTION_TIERS)[number] | undefined
): string {
  if (!ratio || !tier || ratio === 'auto' || tier === 'auto') return 'auto'

  const long = GPT_IMAGE_TIER_LONG_EDGE[tier]
  const [a, b] = GPT_IMAGE_RATIO_FRAC[ratio]

  let w: number
  let h: number
  if (a >= b) {
    w = long
    h = (long * b) / a
  } else {
    h = long
    w = (long * a) / b
  }

  const align16 = (n: number) => Math.max(16, Math.floor(n / 16) * 16)
  w = Math.min(align16(w), 3840)
  h = Math.min(align16(h), 3840)

  return `${w}x${h}`
}

export function isVisionModel(model: Model): boolean {
  if (!model || isEmbeddingModel(model) || isRerankModel(model)) {
    return false
  }

  // modality 显式标注为 multimodal 或 image 的模型一定支持视觉输入
  if (model.modality === 'multimodal' || model.modality === 'image') return true
  if (model.modality === 'text') return false

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
  if (model.modality === 'model_3d') return true

  const modelId = getLowerBaseModelName(model.id)
  return GENERATE_3D_MODELS_REGEX.test(modelId)
}

const GENERATE_MOTION_MODELS_REGEX = /hy-motion|hymotion|prompt-?hmr|text-to-motion|motion-gen/i

export function isGenerateMotionModel(model?: Model | null): boolean {
  if (!model) return false
  if (model.modality === 'motion') return true
  const modelId = getLowerBaseModelName(model.id)
  return GENERATE_MOTION_MODELS_REGEX.test(modelId)
}

const GENERATE_VIDEO_MODELS_REGEX =
  /hailuo|minimax-video|\bt2v\b|\bi2v\b|text-to-video|image-to-video|video-?generation|video-?gen|cogvideo|\bsora\b|\bveo\b|\bkling\b/i

/**
 * 文生视频 / 图生视频模型（如 MiniMax-Hailuo 系列），通过异步 submit/poll 流程生成视频。
 */
export function isGenerateVideoModel(model?: Model | null): boolean {
  if (!model) return false
  if (model.modality === 'video') return true
  const modelId = getLowerBaseModelName(model.id)
  return GENERATE_VIDEO_MODELS_REGEX.test(modelId)
}
