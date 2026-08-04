const SOURCE_SIZE_LONG_EDGES = {
  '1k': 1024,
  '2k': 2048,
  '3k': 3072,
  '4k': 3840
} as const

const ASPECT_RATIO_FRAC: Record<string, [number, number]> = {
  '1:1': [1, 1],
  '16:9': [16, 9],
  '9:16': [9, 16],
  '4:3': [4, 3],
  '3:4': [3, 4],
  '3:2': [3, 2],
  '2:3': [2, 3]
}

type ResolutionTier = keyof typeof SOURCE_SIZE_LONG_EDGES | 'auto' | undefined

export type ImageDimensions = {
  width: number
  height: number
}

export type GptImageSizeSettings = {
  aspectRatio?: string
  resolutionTier?: string
  size?: string
}

export function selectPrimaryReference<T>(
  userReferences: readonly T[],
  assistantReferences: readonly T[]
): { reference: T; source: 'user' | 'assistant' } | null {
  if (userReferences[0]) {
    return { reference: userReferences[0], source: 'user' }
  }
  if (assistantReferences[0]) {
    return { reference: assistantReferences[0], source: 'assistant' }
  }
  return null
}

export function preferSourceImageSize(
  sourceImageSize: string | undefined,
  configuredSize: string | undefined
): string | undefined {
  return sourceImageSize ?? configuredSize
}

export function buildImageEditInstruction(imageCount: number): string {
  if (imageCount === 1) {
    return 'Input image 1 is the target image to edit. Preserve its composition, camera angle, and subject unless the request explicitly changes them.'
  }

  return `Input image 1 is the only target image to edit. Images 2-${imageCount} are reference images only; use them for requested style or details, but do not replace the target image's composition, camera angle, or subject.`
}

/**
 * RightCode 的编辑接口要求重复的 `image` multipart 字段，而不是 `image[]`。
 * OpenAI SDK 会把数组自动编码为 `image[]`，因此这里手动构建表单以与成功的
 * Infinite Canvas 请求保持一致。
 */
export function createImageEditFormData(fields: Record<string, unknown>, images: readonly File[]): FormData {
  const formData = new FormData()

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new TypeError(`Unsupported image edit field type for "${key}"`)
    }
    formData.append(key, String(value))
  }

  for (const image of images) {
    formData.append('image', image, image.name)
  }

  return formData
}

function align16(n: number): number {
  return Math.max(16, Math.floor(n / 16) * 16)
}

function computeFixedAspectSize(ratio: string, tier: keyof typeof SOURCE_SIZE_LONG_EDGES): string {
  const long = SOURCE_SIZE_LONG_EDGES[tier]
  const frac = ASPECT_RATIO_FRAC[ratio]
  if (!frac) return `${long}x${long}`
  const [a, b] = frac
  let w: number
  let h: number
  if (a >= b) {
    w = long
    h = (long * b) / a
  } else {
    h = long
    w = (long * a) / b
  }
  return `${Math.min(align16(w), 3840)}x${Math.min(align16(h), 3840)}`
}

/**
 * 根据主参考图比例和所选分辨率档位确定输出尺寸。
 * 上游要求 16 的倍数，因此短边向下对齐，长边保持档位定义的值。
 */
export function computeSourceImageSize(dimensions: ImageDimensions, resolutionTier: ResolutionTier): string {
  const tier = resolutionTier && resolutionTier !== 'auto' ? resolutionTier : '1k'
  const longEdge = SOURCE_SIZE_LONG_EDGES[tier]
  const ratio = dimensions.width / dimensions.height

  let width = ratio >= 1 ? longEdge : longEdge * ratio
  let height = ratio >= 1 ? longEdge / ratio : longEdge
  width = align16(width)
  height = align16(height)

  return `${width}x${height}`
}

/**
 * 解析最终要发给上游的 size（尚未做子型号校验）。
 *
 * - 比例 + 档位都明确 → 固定宽高比 × 档位长边
 * - 比例为 auto、档位明确、且有参考图 → 按原图比例 × 档位长边
 * - 比例为 auto、档位明确、无参考图（纯文生图）→ 回落 1:1 × 档位（避免上游默认 1024x1024）
 * - 都是 auto → undefined（由上游默认）
 *
 * Atlas / 多数网关在缺省 size 时固定 `1024x1024`，不会按「原图比例 + 2K」推断，
 * 所以客户端必须在发请求前把 auto 解析成具体 WxH。
 */
export function resolveGptImageOutputSize(
  settings: GptImageSizeSettings | undefined,
  sourceDimensions?: ImageDimensions
): string | undefined {
  if (!settings) return undefined

  const ratio = settings.aspectRatio
  const tier = settings.resolutionTier

  if (ratio && ratio !== 'auto' && tier && tier !== 'auto' && tier in SOURCE_SIZE_LONG_EDGES) {
    return computeFixedAspectSize(ratio, tier as keyof typeof SOURCE_SIZE_LONG_EDGES)
  }

  if (settings.size && settings.size !== 'auto') {
    return settings.size
  }

  if (tier && tier !== 'auto' && tier in SOURCE_SIZE_LONG_EDGES) {
    if (sourceDimensions) {
      return computeSourceImageSize(sourceDimensions, tier as ResolutionTier)
    }
    return computeFixedAspectSize('1:1', tier as keyof typeof SOURCE_SIZE_LONG_EDGES)
  }

  return undefined
}
