import type OpenAI from '@cherrystudio/openai'
import { toFile } from '@cherrystudio/openai/uploads'
import { loggerService } from '@logger'
import { isDedicatedImageGenerationModel, isImageEnhancementModel } from '@renderer/config/models'
import {
  computeGptImageSize,
  getImageEditMaxInputImages,
  isGptImage2Model,
  isGptImageModel,
  validateGptImageSize
} from '@renderer/config/models/vision'
import type { FileMetadata, GptImageSettings, Model } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { ChunkType } from '@renderer/types/chunk'
import type { Message } from '@renderer/types/newMessage'
import { findFileBlocks, findImageBlocks, getMainTextContent } from '@renderer/utils/messageUtils/find'
import { ensureLocalImageUrl } from '@renderer/utils/proxyImage'

import type { BaseApiClient } from '../../clients/BaseApiClient'
import type { CompletionsParams, CompletionsResult, GenericChunk } from '../schemas'
import type { CompletionsContext, CompletionsMiddleware } from '../types'
import {
  buildImageEditInstruction,
  computeSourceImageSize,
  createImageEditFormData,
  type ImageDimensions,
  preferSourceImageSize,
  resolveGptImageOutputSize,
  selectPrimaryReference
} from './imageGenerationUtils'

const logger = loggerService.withContext('ImageGenerationMiddleware')
const IMAGE_GENERATION_TIMEOUT = 60 * 1000 * 60

/**
 * 把 assistant.settings.gptImage 转换成 OpenAI SDK `images.generate` / `images.edit` 的参数对象。
 *
 * 严格按 OpenAI gpt-image 系列官方文档过滤：
 *   - **`response_format`**：整个 gpt-image 家族都不接受，由调用方处理
 *   - **`size`**：由 `resolveGptImageOutputSize` 解析（比例 auto + 档位时按原图或 1:1 回落，
 *     避免上游缺省 1024x1024）；再用 `validateGptImageSize` 按子型号约束校验
 *     - gpt-image-2：≤ 3840 且 16 倍数、长短比 ≤ 3:1、总像素 [655360, 8294400]
 *     - gpt-image-1 / 1.5 / mini：必须是 `1024x1024 / 1024x1536 / 1536x1024 / auto` 之一
 *   - **`quality`**：`low / medium / high` 才发，`'auto'` 不发（让上游默认）
 *   - **`background`**：
 *     - gpt-image-2 **不接受 `'transparent'`**（官方明确），传了会触发 unsupported；这里只允许 `'opaque'` 透传
 *     - 其他 gpt-image 系列：`'opaque' / 'transparent'` 都允许
 *     - `'auto'` 一律不发
 *   - **`output_format`**：`png / jpeg / webp`
 *   - **`n`**：1 ~ 10，且 ≠ 1 才发（默认就是 1）；gpt-image-2 不发 `n`，只按单张请求
 *
 * SDK 类型对 `size` 限制为 enum，gpt-image-2 走自由 `WxH` 时调用方需要 cast 透传。
 */
type GptImageBody = {
  size?: 'auto' | '1024x1024' | '1024x1536' | '1536x1024' | (string & {})
  quality?: 'auto' | 'high' | 'medium' | 'low'
  background?: 'opaque' | 'transparent'
  output_format?: 'png' | 'jpeg' | 'webp'
  n?: number
  /** Nano Banana / Atlas */
  resolution?: string
  enable_web_search?: boolean
}

type BinaryImageResult = {
  mime?: string
  base64?: string
  data?: ArrayBuffer | Uint8Array | number[] | string | { type?: string; data?: number[] }
}

const SUPPORTED_EDIT_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
type ImageReferenceSource = 'user' | 'assistant'

type ImageReference = {
  file: File
  source: ImageReferenceSource
}

function normalizeEditImageMime(mime: string | undefined, ext: string | undefined): string {
  const normalizedMime = mime?.split(';')[0]?.trim().toLowerCase()
  if (normalizedMime) {
    const safeMime = normalizedMime === 'image/jpg' ? 'image/jpeg' : normalizedMime
    if (SUPPORTED_EDIT_IMAGE_MIME_TYPES.has(safeMime)) {
      return safeMime
    }
  }

  const normalizedExt = ext?.trim().toLowerCase().replace(/^\./, '')
  if (normalizedExt === 'jpg' || normalizedExt === 'jpeg') return 'image/jpeg'
  if (normalizedExt === 'png') return 'image/png'
  if (normalizedExt === 'gif') return 'image/gif'
  if (normalizedExt === 'webp') return 'image/webp'

  throw new Error(
    `Unsupported image format for image editing: ${mime || ext || 'unknown'}. Supported formats: jpeg, png, gif, webp.`
  )
}

function parseDataUrl(dataUrl: string): { mime?: string; base64: string } | null {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0 || !dataUrl.slice(0, commaIndex).toLowerCase().includes(';base64')) {
    return null
  }

  const header = dataUrl.slice(0, commaIndex)
  const mime = header.match(/^data:([^;]+)/i)?.[1]
  return { mime, base64: dataUrl.slice(commaIndex + 1) }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function bytesFromBinaryImageResult(
  fileData: BinaryImageResult,
  file: FileMetadata
): { bytes: Uint8Array; mime: string } {
  const dataUrl = typeof fileData.data === 'string' ? parseDataUrl(fileData.data) : null
  const mime = normalizeEditImageMime(fileData.mime || dataUrl?.mime, file.ext)

  if (fileData.base64 || dataUrl?.base64) {
    return { bytes: base64ToBytes(fileData.base64 || dataUrl?.base64 || ''), mime }
  }

  const data = fileData.data
  if (data instanceof Uint8Array) {
    return { bytes: data.slice(), mime }
  }
  if (data instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(data), mime }
  }
  if (Array.isArray(data)) {
    return { bytes: new Uint8Array(data), mime }
  }
  if (data && typeof data === 'object' && Array.isArray(data.data)) {
    return { bytes: new Uint8Array(data.data), mime }
  }

  throw new Error(`Failed to read a valid image payload for ${file.origin_name || file.name || file.id}.`)
}

async function fileMetadataToUploadFile(file: FileMetadata): Promise<File> {
  const fileData = (await window.api.file.binaryImage(file.id + file.ext)) as BinaryImageResult | null
  if (!fileData) {
    throw new Error(`Failed to read image file: ${file.origin_name || file.name || file.id}`)
  }

  const { bytes, mime } = bytesFromBinaryImageResult(fileData, file)
  const name = file.origin_name || file.name || `image${file.ext || '.png'}`
  const imageBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return await toFile(new Blob([imageBuffer], { type: mime }), name, { type: mime })
}

async function assistantImageBlockToUploadFile(url: string | undefined): Promise<File | null> {
  if (!url) return null

  // Prefer a local/proxied data URL so Qt WebEngine / offline hosts can still edit.
  let resolved = url
  try {
    resolved = await ensureLocalImageUrl(url)
  } catch (error) {
    logger.warn(
      `[images.edit] ensureLocalImageUrl failed for ${url.slice(0, 80)}: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (resolved.startsWith('data:image/')) {
    const parsed = parseDataUrl(resolved)
    if (!parsed?.base64) return null
    const bytes = base64ToBytes(parsed.base64)
    const mime = normalizeEditImageMime(parsed.mime, '.png')
    const imageBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    return await toFile(new Blob([imageBuffer], { type: mime }), 'assistant_image.png', { type: mime })
  }

  // blob: / http(s) leftover — try fetch (works for blob: and same-origin proxy URLs)
  if (resolved.startsWith('blob:') || resolved.startsWith('http://') || resolved.startsWith('https://')) {
    try {
      const response = await fetch(resolved)
      if (!response.ok) {
        logger.warn(`[images.edit] fetch image failed status=${response.status} url=${resolved.slice(0, 80)}`)
        return null
      }
      const blob = await response.blob()
      const mime = normalizeEditImageMime(blob.type, '.png')
      return await toFile(blob, 'assistant_image.png', { type: mime })
    } catch (error) {
      logger.warn(`[images.edit] fetch image failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  return null
}

/**
 * 本轮用户上传图优先；只有没有用户图时才回退使用上一轮 assistant 图片。
 * 在选定的集合中，第一张始终是待修改主图，剩余图片按顺序作为参考图。
 */
async function collectImageReferences(
  lastUserMessage: Message,
  lastAssistantMessage: Message | undefined,
  maxInputImages: number
): Promise<ImageReference[]> {
  const userImageBlocks = findImageBlocks(lastUserMessage).filter((block) => !!block.file || !!block.url)
  // 部分粘贴/附件会落成 FILE 块而不是 IMAGE 块
  const userFileImageBlocks = findFileBlocks(lastUserMessage).filter(
    (block) => !!block.file && block.file.type === FILE_TYPE.IMAGE
  )
  const assistantImageBlocks = lastAssistantMessage
    ? findImageBlocks(lastAssistantMessage).filter((block) => !!block.url)
    : []
  const primary = selectPrimaryReference([...userImageBlocks, ...userFileImageBlocks], assistantImageBlocks)

  if (!primary) {
    logger.info(
      `[images.edit] no reference images found userImage=${userImageBlocks.length} userFileImage=${userFileImageBlocks.length} assistantImage=${assistantImageBlocks.length}`
    )
    return []
  }

  const selectedBlocks = primary.source === 'user' ? [...userImageBlocks, ...userFileImageBlocks] : assistantImageBlocks
  const references = await Promise.all(
    selectedBlocks.map(async (block): Promise<ImageReference | null> => {
      if (primary.source === 'user') {
        const fileMeta = 'file' in block ? block.file : undefined
        if (fileMeta) {
          return { file: await fileMetadataToUploadFile(fileMeta), source: 'user' }
        }
        const url = 'url' in block ? block.url : undefined
        const file = await assistantImageBlockToUploadFile(url)
        return file ? { file, source: 'user' } : null
      }

      const file = await assistantImageBlockToUploadFile('url' in block ? block.url : undefined)
      return file ? { file, source: 'assistant' } : null
    })
  )
  const validReferences = references.filter((reference): reference is ImageReference => reference !== null)

  if (validReferences.length === 0) {
    logger.warn(`[images.edit] reference blocks present but none convertible to upload File (source=${primary.source})`)
  }

  if (validReferences.length > maxInputImages) {
    logger.warn(
      `[images.edit] trimming input images from ${validReferences.length} to ${maxInputImages}; preserving target image first`
    )
  }

  return validReferences.slice(0, maxInputImages)
}

async function getImageDimensions(image: Blob): Promise<ImageDimensions> {
  const bitmap = await createImageBitmap(image)
  try {
    return { width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}

function pickGptImageBodyFields(
  model: Model | undefined,
  settings: GptImageSettings | undefined,
  sourceDimensions?: ImageDimensions
): GptImageBody {
  if (!settings) return {}
  const out: GptImageBody = {}

  const size = resolveGptImageOutputSize(settings, sourceDimensions)
  if (size) {
    const checked = validateGptImageSize(model, size)
    if (checked.ok && checked.size !== 'auto') {
      out.size = checked.size
    } else if (!checked.ok) {
      logger.warn(
        `[pickGptImageBodyFields] dropping invalid size="${size}" for model=${model?.id ?? '?'}: ${checked.reason}`
      )
    }
  } else if (settings.aspectRatio === 'auto' && settings.resolutionTier && settings.resolutionTier !== 'auto') {
    logger.warn(
      `[pickGptImageBodyFields] unable to resolve size for auto aspect + tier=${settings.resolutionTier}; upstream may default to 1024x1024`
    )
  }

  if (settings.quality && settings.quality !== 'auto') {
    out.quality = settings.quality
  }

  // background: gpt-image-2 不支持 transparent，需要过滤
  if (settings.background && settings.background !== 'auto') {
    if (settings.background === 'transparent' && isGptImage2Model(model)) {
      logger.warn(`[pickGptImageBodyFields] dropping background="transparent": gpt-image-2 doesn't support it`)
    } else {
      out.background = settings.background
    }
  }

  if (settings.outputFormat) {
    out.output_format = settings.outputFormat
  }

  if (typeof settings.n === 'number' && settings.n >= 1 && settings.n <= 10 && settings.n !== 1) {
    if (isGptImage2Model(model)) {
      logger.warn(`[pickGptImageBodyFields] dropping n=${settings.n}: gpt-image-2 only supports one image per request`)
      return out
    }
    out.n = settings.n
  }

  return out
}

function shouldUseGenericImageRequestParams(model: Model | undefined): boolean {
  // 非 gpt-image 的专用生图模型：透传 size 等通用参数（Seedream / Nano 等）。
  if (!model || isGptImageModel(model)) return false
  return model.endpoint_type === 'image-generation' || model.modality === 'image'
}

function pickGenericImageBodyFields(settings: GptImageSettings | undefined, sourceImageSize?: string): GptImageBody {
  if (!settings) return sourceImageSize ? { size: sourceImageSize } : {}
  const out: GptImageBody = {}
  const computed = computeGptImageSize(settings.aspectRatio, settings.resolutionTier)
  const configuredSize =
    computed && computed !== 'auto' ? computed : settings.size && settings.size !== 'auto' ? settings.size : undefined
  const size = preferSourceImageSize(sourceImageSize, configuredSize)

  if (size) {
    out.size = size
  }

  // Nano Banana 原生字段：显式 resolution 比仅靠 size 推断更稳；Seedream 会忽略多余字段。
  if (settings.resolutionTier && settings.resolutionTier !== 'auto') {
    out.resolution = settings.resolutionTier
  }
  if (settings.enableWebSearch) {
    out.enable_web_search = true
  }

  return out
}

export const MIDDLEWARE_NAME = 'ImageGenerationMiddleware'

export const ImageGenerationMiddleware: CompletionsMiddleware =
  () =>
  (next) =>
  async (context: CompletionsContext, params: CompletionsParams): Promise<CompletionsResult> => {
    const { assistant, messages } = params
    const client = context.apiClientInstance as BaseApiClient<OpenAI>
    const signal = context._internal?.flowControl?.abortSignal
    if (!assistant.model || !isDedicatedImageGenerationModel(assistant.model) || typeof messages === 'string') {
      return next(context, params)
    }

    const stream = new ReadableStream<GenericChunk>({
      async start(controller) {
        const enqueue = (chunk: GenericChunk) => controller.enqueue(chunk)

        try {
          if (!assistant.model) {
            throw new Error('Assistant model is not defined.')
          }

          const sdk = await client.getSdkInstance()
          const lastUserMessage = messages.findLast((m) => m.role === 'user')
          const lastAssistantMessage = messages.findLast((m) => m.role === 'assistant')

          if (!lastUserMessage) {
            throw new Error('No user message found for image generation.')
          }

          const prompt = getMainTextContent(lastUserMessage)
          const canEdit = isImageEnhancementModel(assistant.model)
          const imageReferences = canEdit
            ? await collectImageReferences(
                lastUserMessage,
                lastAssistantMessage,
                getImageEditMaxInputImages(assistant.model)
              )
            : []
          const imageFiles = imageReferences.map((reference) => reference.file)
          const primaryImage = imageReferences[0]

          if (!canEdit) {
            logger.info(`[images.route] model=${assistant.model.id} canEdit=false → generations`)
          } else if (imageFiles.length === 0) {
            logger.info(
              `[images.route] model=${assistant.model.id} canEdit=true but no images → generations (attach image to this user message or ensure previous assistant image is data/http url)`
            )
          } else {
            logger.info(
              `[images.route] model=${assistant.model.id} canEdit=true imageCount=${imageFiles.length} source=${primaryImage?.source} → edits`
            )
          }

          enqueue({ type: ChunkType.IMAGE_CREATED })

          const startTime = Date.now()
          let response: OpenAI.Images.ImagesResponse
          const options = { signal, timeout: IMAGE_GENERATION_TIMEOUT, maxRetries: 0 }

          const useGenericImageRequestParams = shouldUseGenericImageRequestParams(assistant.model)

          // OpenAI gpt-image 整个家族（gpt-image-1 / 1.5 / 2 / mini 等）**都不接受** `response_format`
          // 参数 —— 它们固定只能返回 b64_json。给 gpt-image-2 传 `response_format: 'b64_json'`
          // 会被上游回 `400 The requested operation is unsupported`。
          // 因此这里用 `isGptImageModel` 而不是 `id.includes('gpt-image-1')` 来豁免整个家族。
          const isGptImage = isGptImageModel(assistant.model)
          let sourceImageSize: string | undefined
          let sourceDimensions: ImageDimensions | undefined
          // 图生图：始终读取主图尺寸。gpt-image 在「比例 auto + 分辨率档位」时要用它解析具体 WxH；
          // 通用 image-generation 渠道则用它覆盖/补充 size。
          if (primaryImage && canEdit) {
            try {
              sourceDimensions = await getImageDimensions(primaryImage.file)
              if (useGenericImageRequestParams) {
                sourceImageSize = computeSourceImageSize(sourceDimensions, assistant.settings?.gptImage?.resolutionTier)
              }
            } catch (error) {
              logger.warn(
                `[images.edit] unable to read primary reference dimensions; using configured size: ${error instanceof Error ? error.message : String(error)}`
              )
            }
          }

          // 中心化 gpt-image 仍按 OpenAI 官方约束过滤；自定义 image-generation 渠道按网关文档透传通用参数。
          const gptImageBody =
            isGptImage && !useGenericImageRequestParams
              ? pickGptImageBodyFields(assistant.model, assistant.settings?.gptImage, sourceDimensions)
              : {}
          const genericImageBody = useGenericImageRequestParams
            ? pickGenericImageBodyFields(assistant.settings?.gptImage, sourceImageSize)
            : {}

          if (imageFiles.length > 0 && canEdit) {
            const model = assistant.model
            const provider = context.apiClientInstance.provider
            if (model.id.toLowerCase().includes('gpt-image-1-mini') && provider.type === 'azure-openai') {
              throw new Error('Azure OpenAI GPT-Image-1-Mini model does not support image editing.')
            }
            const editFields = {
              model: assistant.model.id,
              prompt: `${buildImageEditInstruction(imageFiles.length)}\n\n${prompt || ''}`,
              // size 在 gpt.ge 网关下接受 `WxH` 自由格式（gpt-image-2 文档），
              // 但 OpenAI SDK 类型把 size 限制为 enum。这里把 body 整体 cast 透传。
              ...(gptImageBody as Record<string, unknown>),
              ...(genericImageBody as Record<string, unknown>),
              // 必须放在 spread 之后：强制 b64，避免 url 模式在 Qt 中裂图。
              // gpt-image 家族不接受 response_format，保持省略。
              ...(isGptImage ? {} : { response_format: 'b64_json' as const })
            }
            const editFormData = createImageEditFormData(editFields, imageFiles)
            const imageMeta = imageFiles.map((image, index) => ({
              name: image instanceof File ? image.name : undefined,
              mime: image.type || undefined,
              size: image.size,
              source: imageReferences[index]?.source,
              role: index === 0 ? 'target' : 'reference',
              dimensions: index === 0 ? sourceDimensions : undefined
            }))
            const safeEditBody = JSON.stringify({ ...editFields, image: `<${imageFiles.length} blob(s)>`, imageMeta })
            logger.info(
              `[images.edit] model=${assistant.model.id}, imageCount=${imageFiles.length}, imageFieldName=image, body=${safeEditBody}`
            )
            try {
              // 不使用 sdk.images.edit：SDK 会将 File[] 序列化为 `image[]`，而 RightCode
              // 编辑接口只识别重复的 `image` 字段（Infinite Canvas 使用相同编码方式）。
              response = (await sdk.post('/images/edits', {
                body: editFormData,
                ...options
              })) as OpenAI.Images.ImagesResponse
            } catch (err) {
              // 把发送的 body 摘要直接挂在 error 上，方便用户在错误对话框看到。
              if (err instanceof Error) {
                err.message = `${err.message}\n\n[Cherry debug] sent body: ${safeEditBody}`
              }
              throw err
            }
          } else {
            const generateBody = {
              model: assistant.model.id,
              prompt: prompt || '',
              ...(gptImageBody as Record<string, unknown>),
              ...(genericImageBody as Record<string, unknown>),
              // gpt-image 家族不接受 response_format（只能返回 b64_json）；
              // 其余模型强制 b64_json（放在 spread 之后，避免被覆盖）。
              // Qt WebEngine 无法直接加载 Atlas 外链，url 模式会导致裂图。
              ...(isGptImage ? {} : { response_format: 'b64_json' as const })
            }
            logger.info(`[images.generate] model=${assistant.model.id}, body=${JSON.stringify(generateBody)}`)
            try {
              // 通用 image-generation（Seedream / Nano）可能带 resolution / enable_web_search 等
              // 非 OpenAI 官方字段；sdk.images.generate 会剥掉未知键，因此走 raw post。
              if (useGenericImageRequestParams) {
                response = (await sdk.post('/images/generations', {
                  body: generateBody,
                  ...options
                })) as OpenAI.Images.ImagesResponse
              } else {
                response = await sdk.images.generate(generateBody, options)
              }
            } catch (err) {
              // 在错误信息里嵌入实际发送的 body，方便用户在错误对话框中直接看到，
              // 不必去 DevTools Console / Network 翻日志。
              if (err instanceof Error) {
                const safeBody = JSON.stringify(generateBody)
                err.message = `${err.message}\n\n[Cherry debug] sent body: ${safeBody}`
              }
              throw err
            }
          }

          const imageList: string[] = []
          for (const image of response.data || []) {
            if (image.b64_json) {
              // 上游偶发直接返回完整 data URL；再套一层前缀会变成非法相对路径 → Backend 414。
              const b64 = image.b64_json.trim()
              imageList.push(b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`)
            } else if (image.url) {
              const localUrl = await ensureLocalImageUrl(image.url)
              imageList.push(localUrl)
            }
          }

          if (imageList.length === 0) {
            logger.warn(
              `[images.result] empty image list; dataCount=${response.data?.length ?? 0} keys=${JSON.stringify(
                (response.data || []).map((item) => Object.keys(item || {}))
              )}`
            )
          } else {
            logger.info(
              `[images.result] count=${imageList.length} firstPrefix=${imageList[0].slice(0, 48)} len=${imageList[0].length}`
            )
          }

          enqueue({
            type: ChunkType.IMAGE_COMPLETE,
            image: { type: 'base64', images: imageList }
          })

          const usage = (response as any).usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

          enqueue({
            type: ChunkType.LLM_RESPONSE_COMPLETE,
            response: {
              usage,
              metrics: {
                completion_tokens: usage.completion_tokens,
                time_first_token_millsec: 0,
                time_completion_millsec: Date.now() - startTime
              }
            }
          })
        } catch (error: any) {
          enqueue({ type: ChunkType.ERROR, error })
        } finally {
          controller.close()
        }
      }
    })

    return {
      stream,
      getText: () => ''
    }
  }
