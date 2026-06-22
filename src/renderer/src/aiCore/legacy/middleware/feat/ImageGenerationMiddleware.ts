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
import { ChunkType } from '@renderer/types/chunk'
import { findImageBlocks, getMainTextContent } from '@renderer/utils/messageUtils/find'
import { ensureLocalImageUrl } from '@renderer/utils/proxyImage'

import type { BaseApiClient } from '../../clients/BaseApiClient'
import type { CompletionsParams, CompletionsResult, GenericChunk } from '../schemas'
import type { CompletionsContext, CompletionsMiddleware } from '../types'

const logger = loggerService.withContext('ImageGenerationMiddleware')
const IMAGE_GENERATION_TIMEOUT = 60 * 1000 * 60

/**
 * 把 assistant.settings.gptImage 转换成 OpenAI SDK `images.generate` / `images.edit` 的参数对象。
 *
 * 严格按 OpenAI gpt-image 系列官方文档过滤：
 *   - **`response_format`**：整个 gpt-image 家族都不接受，由调用方处理
 *   - **`size`**：先用 `computeGptImageSize(aspectRatio, resolutionTier)` 算，再用
 *     `validateGptImageSize(model, size)` 按子型号约束校验；不合法的直接 fallback 到 `'auto'`（不发字段）
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
}

type BinaryImageResult = {
  mime?: string
  base64?: string
  data?: ArrayBuffer | Uint8Array | number[] | string | { type?: string; data?: number[] }
}

const SUPPORTED_EDIT_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

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

function pickGptImageBodyFields(model: Model | undefined, settings: GptImageSettings | undefined): GptImageBody {
  if (!settings) return {}
  const out: GptImageBody = {}

  // size: 先算 WxH，再按 model 约束校验
  const computed = computeGptImageSize(settings.aspectRatio, settings.resolutionTier)
  const rawSize =
    computed && computed !== 'auto' ? computed : settings.size && settings.size !== 'auto' ? settings.size : undefined

  if (rawSize) {
    const checked = validateGptImageSize(model, rawSize)
    if (checked.ok && checked.size !== 'auto') {
      out.size = checked.size
    } else if (!checked.ok) {
      logger.warn(
        `[pickGptImageBodyFields] dropping invalid size="${rawSize}" for model=${model?.id ?? '?'}: ${checked.reason}`
      )
    }
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
          let imageFiles: Blob[] = []

          // Collect images from user message
          const userImageBlocks = findImageBlocks(lastUserMessage)
          const userImages = await Promise.all(
            userImageBlocks.map(async (block) => {
              if (!block.file) return null
              return await fileMetadataToUploadFile(block.file)
            })
          )
          imageFiles = imageFiles.concat(userImages.filter(Boolean) as Blob[])

          // Collect images from last assistant message
          if (lastAssistantMessage) {
            const assistantImageBlocks = findImageBlocks(lastAssistantMessage)
            const assistantImages = await Promise.all(
              assistantImageBlocks.map(async (block) => {
                const b64 = block.url?.replace(/^data:image\/\w+;base64,/, '')
                if (!b64) return null
                const binary = atob(b64)
                const bytes = new Uint8Array(binary.length)
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
                return await toFile(new Blob([bytes], { type: 'image/png' }), 'assistant_image.png', {
                  type: 'image/png'
                })
              })
            )
            imageFiles = imageFiles.concat(assistantImages.filter(Boolean) as Blob[])
          }

          const maxInputImages = getImageEditMaxInputImages(assistant.model)
          if (imageFiles.length > maxInputImages) {
            logger.warn(
              `[images.edit] trimming input images from ${imageFiles.length} to ${maxInputImages} for model=${assistant.model.id}`
            )
            imageFiles = imageFiles.slice(0, maxInputImages)
          }

          enqueue({ type: ChunkType.IMAGE_CREATED })

          const startTime = Date.now()
          let response: OpenAI.Images.ImagesResponse
          const options = { signal, timeout: IMAGE_GENERATION_TIMEOUT, maxRetries: 0 }

          const canEdit = isImageEnhancementModel(assistant.model)
          // 仅在 gpt-image 家族模型上注入用户设置的 size/quality 等参数；
          // 其他模型（dall-e-3 等）当前不暴露这些 UI，保持原有行为不变。
          const gptImageBody = isGptImageModel(assistant.model)
            ? pickGptImageBodyFields(assistant.model, assistant.settings?.gptImage)
            : {}

          // OpenAI gpt-image 整个家族（gpt-image-1 / 1.5 / 2 / mini 等）**都不接受** `response_format`
          // 参数 —— 它们固定只能返回 b64_json。给 gpt-image-2 传 `response_format: 'b64_json'`
          // 会被上游回 `400 The requested operation is unsupported`。
          // 因此这里用 `isGptImageModel` 而不是 `id.includes('gpt-image-1')` 来豁免整个家族。
          const isGptImage = isGptImageModel(assistant.model)

          if (imageFiles.length > 0 && canEdit) {
            const model = assistant.model
            const provider = context.apiClientInstance.provider
            if (model.id.toLowerCase().includes('gpt-image-1-mini') && provider.type === 'azure-openai') {
              throw new Error('Azure OpenAI GPT-Image-1-Mini model does not support image editing.')
            }
            const editBody = {
              model: assistant.model.id,
              image: imageFiles,
              prompt: prompt || '',
              // size 在 gpt.ge 网关下接受 `WxH` 自由格式（gpt-image-2 文档），
              // 但 OpenAI SDK 类型把 size 限制为 enum。这里把 body 整体 cast 透传。
              ...(gptImageBody as Record<string, unknown>)
            }
            const imageMeta = imageFiles.map((image) => ({
              name: image instanceof File ? image.name : undefined,
              mime: image.type || undefined,
              size: image.size
            }))
            const safeEditBody = JSON.stringify({ ...editBody, image: `<${imageFiles.length} blob(s)>`, imageMeta })
            logger.info(
              `[images.edit] model=${assistant.model.id}, imageCount=${imageFiles.length}, body=${safeEditBody}`
            )
            try {
              response = await sdk.images.edit(editBody, options)
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
              // gpt-image 家族不接受 response_format（只能返回 b64_json）；
              // 其余模型（dall-e-2 / 3）需要显式传 b64_json 以保证我们能拿到本地图片数据。
              response_format: isGptImage ? undefined : ('b64_json' as const),
              ...(gptImageBody as Record<string, unknown>)
            }
            logger.info(`[images.generate] model=${assistant.model.id}, body=${JSON.stringify(generateBody)}`)
            try {
              response = await sdk.images.generate(generateBody, options)
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
              imageList.push(`data:image/png;base64,${image.b64_json}`)
            } else if (image.url) {
              const localUrl = await ensureLocalImageUrl(image.url)
              imageList.push(localUrl)
            }
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
