import type { ImageGenerationSupport } from '@shared/data/types/model'

import type { SplitImageParams } from './imageOptions'

/** DALL·E 3 pixel sizes that Gemini / Nano Banana relays reject as `unsupported size`. */
const DALLE_SIZE_TO_ASPECT: Record<string, `${number}:${number}`> = {
  '1024x1024': '1:1',
  '1792x1024': '16:9',
  '1024x1792': '9:16'
}

const GEMINI_ASPECT_OPTIONS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'] as const

/**
 * Catalog-shaped painting support for Gemini chat-image / Nano Banana models
 * that a New API gateway lists under a custom id (`nano-banana-pro@vapi`).
 * Pixel `size` is intentionally absent — those models take aspect ratio + 1K/2K/4K.
 */
export const GEMINI_STYLE_IMAGE_SUPPORT: ImageGenerationSupport = {
  modes: {
    generate: {
      supports: {
        aspectRatio: {
          default: '1:1',
          options: [...GEMINI_ASPECT_OPTIONS],
          render: 'chips',
          type: 'enum'
        },
        imageResolution: {
          default: '1K',
          options: ['1K', '2K', '4K'],
          render: 'chips',
          type: 'enum'
        }
      }
    },
    edit: {
      supports: {
        aspectRatio: {
          default: '1:1',
          options: [...GEMINI_ASPECT_OPTIONS],
          render: 'chips',
          type: 'enum'
        },
        imageResolution: {
          default: '1K',
          options: ['1K', '2K', '4K'],
          render: 'chips',
          type: 'enum'
        }
      }
    }
  }
}

/** Strip New API channel suffixes (`@vapi`, `@rc`) and vendor prefixes. */
export function stripImageModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/^[^/]+\//, '')
    .replace(/@[\w.-]+$/g, '')
}

/**
 * Gemini chat-image and Nano Banana SKUs. They speak aspect ratio / 1K-4K,
 * not OpenAI DALL·E pixel sizes like `1792x1024`.
 */
export function isGeminiStyleImageModel(modelId: string): boolean {
  const id = stripImageModelId(modelId)
  if (id.includes('nano-banana') || id.includes('nanobanana')) return true
  return id.startsWith('gemini-') && id.includes('image')
}

/** OpenAI `/v1/images/*` gpt-image family (`gpt-image-1`, `gpt-image-2@vapi`, …). */
export function isOpenAiGptImageModel(modelId: string): boolean {
  return stripImageModelId(modelId).startsWith('gpt-image')
}

export function dalleSizeToAspectRatio(size: string): `${number}:${number}` | undefined {
  return DALLE_SIZE_TO_ASPECT[size.toLowerCase()]
}

const PIXEL_SIZE_RE = /^\d+x\d+$/i
const ASPECT_SIZE_RE = /^\d+:\d+$/

function normalizeImageTier(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (value === '512') return '512'
  if (/^[124][kK]$/.test(value)) return value.toUpperCase()
  return undefined
}

/**
 * OpenAI `/images/generations` extras for a Gemini / Nano Banana relay.
 * Pixel `size` (e.g. DALL·E `1792x1024`) is dropped; aspect + 1K/2K/4K ride in
 * `extra_body.generationConfig.imageConfig`, which New API forwards upstream.
 */
export function buildNewApiGeminiImageOptions(input: { size?: string; aspectRatio?: string; imageSize?: string }): {
  size: undefined
  aspectRatio?: `${number}:${number}`
  extraBody?: { generationConfig: { imageConfig: Record<string, string> } }
} {
  const pixel = typeof input.size === 'string' && PIXEL_SIZE_RE.test(input.size)
  const sizeAsAspect = typeof input.size === 'string' && ASPECT_SIZE_RE.test(input.size) ? input.size : undefined
  const aspect = (input.aspectRatio ??
    (pixel && input.size ? dalleSizeToAspectRatio(input.size) : undefined) ??
    sizeAsAspect) as `${number}:${number}` | undefined
  const imageSize = normalizeImageTier(input.imageSize) ?? (pixel ? undefined : normalizeImageTier(input.size))

  const imageConfig: Record<string, string> = {}
  if (aspect) imageConfig.aspectRatio = aspect
  if (imageSize) imageConfig.imageSize = imageSize

  return {
    size: undefined,
    ...(aspect ? { aspectRatio: aspect } : {}),
    ...(Object.keys(imageConfig).length > 0 ? { extraBody: { generationConfig: { imageConfig } } } : {})
  }
}

/**
 * Drop pixel `size` that Gemini relays reject. Preserve landscape/portrait by
 * mapping well-known DALL·E sizes onto `aspectRatio` when the caller didn't set one.
 */
export function sanitizeGeminiImageParams(
  modelId: string,
  structured: SplitImageParams['structured']
): SplitImageParams['structured'] {
  if (!isGeminiStyleImageModel(modelId)) return structured
  const size = structured.size
  if (typeof size !== 'string' || !PIXEL_SIZE_RE.test(size)) return structured
  const next = { ...structured }
  delete next.size
  const aspect = dalleSizeToAspectRatio(size)
  if (aspect && !next.aspectRatio) next.aspectRatio = aspect
  return next
}
