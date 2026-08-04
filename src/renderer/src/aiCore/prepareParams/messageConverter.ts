/**
 * 消息转换模块
 * 将 Cherry Studio 消息格式转换为 AI SDK 消息格式
 */

import type { ReasoningPart } from '@ai-sdk/provider-utils'
import { loggerService } from '@logger'
import { getModelPrimaryModality, isImageEnhancementModel, isVisionModel } from '@renderer/config/models'
import type { ConversationSummary } from '@renderer/services/ConversationSummaryService'
import { formatImagePlaceholders } from '@renderer/services/ImageContextOffload'
import type { Message, Model } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type {
  FileMessageBlock,
  ImageMessageBlock,
  MainTextMessageBlock,
  ThinkingMessageBlock,
  ToolMessageBlock
} from '@renderer/types/newMessage'
import { MessageBlockStatus } from '@renderer/types/newMessage'
import {
  findFileBlocks,
  findImageBlocks,
  findMainTextBlocks,
  findThinkingBlocks,
  findToolBlocks,
  getMainTextContent
} from '@renderer/utils/messageUtils/find'
import { audioExts as AUDIO_EXTS_CONFIG, videoExts as VIDEO_EXTS_CONFIG } from '@shared/config/constant'
import { parseDataUrl } from '@shared/utils'
import type {
  AssistantModelMessage,
  FilePart,
  ImagePart,
  ModelMessage,
  SystemModelMessage,
  TextPart,
  ToolCallPart,
  ToolModelMessage,
  ToolResultPart,
  UserModelMessage
} from 'ai'

import { convertFileBlockToFilePart, convertFileBlockToTextPart } from './fileProcessor'

export interface SummaryOptions {
  summaryMap: Map<string, ConversationSummary | null>
  splitIndex: number
}

export interface MessageConversionOptions {
  /** When true, replace image pixels with lightweight text refs. */
  offloadImages?: boolean
}

export interface ConvertMessagesOptions extends Partial<SummaryOptions> {
  /** Message IDs whose image pixels should be replaced with refs. */
  offloadImageMessageIds?: Set<string>
}

const logger = loggerService.withContext('messageConverter')

/**
 * In-memory cache for decoded image files. File contents are content-addressed
 * (immutable per id), so caching by id+ext is safe and avoids re-reading the same
 * image from disk on every turn / re-send. Bounded by total base64 bytes with
 * FIFO eviction so long conversations with many images can't grow unbounded.
 */
const MAX_IMAGE_CACHE_BYTES = 64 * 1024 * 1024
const imageBase64Cache = new Map<string, { base64: string; mime: string }>()
let imageCacheBytes = 0

function setCachedImage(key: string, value: { base64: string; mime: string }): void {
  const size = value.base64.length
  // Skip caching images that exceed the whole budget on their own.
  if (size > MAX_IMAGE_CACHE_BYTES) return
  // Map preserves insertion order; evict oldest entries until there is room.
  while (imageCacheBytes + size > MAX_IMAGE_CACHE_BYTES && imageBase64Cache.size > 0) {
    const oldestKey = imageBase64Cache.keys().next().value as string
    const oldest = imageBase64Cache.get(oldestKey)
    if (oldest) imageCacheBytes -= oldest.base64.length
    imageBase64Cache.delete(oldestKey)
  }
  imageBase64Cache.set(key, value)
  imageCacheBytes += size
}

/**
 * 转换消息为 AI SDK 参数格式
 * 基于 OpenAI 格式的通用转换，支持文本、图片和文件
 */
export async function convertMessageToSdkParam(
  message: Message,
  isVisionModel = false,
  model?: Model,
  options?: MessageConversionOptions
): Promise<ModelMessage | ModelMessage[]> {
  const content = getMainTextContent(message)
  const fileBlocks = findFileBlocks(message)
  const imageBlocks = findImageBlocks(message)
  const reasoningBlocks = findThinkingBlocks(message)
  const mainTextBlocks = findMainTextBlocks(message)
  const toolBlocks = findToolBlocks(message)
  if (message.role === 'user' || message.role === 'system') {
    return convertMessageToUserModelMessage(
      content,
      fileBlocks,
      imageBlocks,
      isVisionModel,
      model,
      options?.offloadImages === true
    )
  } else {
    return convertAssistantWithToolBlocks(
      message,
      content,
      fileBlocks,
      imageBlocks,
      reasoningBlocks,
      mainTextBlocks,
      toolBlocks,
      model
    )
  }
}

async function convertImageBlockToImagePart(imageBlocks: ImageMessageBlock[]): Promise<Array<ImagePart>> {
  const parts: Array<ImagePart> = []
  for (const imageBlock of imageBlocks) {
    if (imageBlock.file) {
      try {
        const cacheKey = imageBlock.file.id + imageBlock.file.ext
        let image = imageBase64Cache.get(cacheKey)
        if (!image) {
          const loaded = await window.api.file.base64Image(cacheKey)
          image = { base64: loaded.base64, mime: loaded.mime }
          setCachedImage(cacheKey, image)
        }
        parts.push({
          type: 'image',
          image: image.base64,
          mediaType: image.mime
        })
      } catch (error) {
        logger.error('Failed to load image file, image will be excluded from message:', {
          fileId: imageBlock.file.id,
          fileName: imageBlock.file.origin_name,
          error: error as Error
        })
      }
    } else if (imageBlock.url) {
      const url = imageBlock.url
      const parseResult = parseDataUrl(url)
      if (parseResult?.isBase64) {
        const { mediaType, data } = parseResult
        parts.push({ type: 'image', image: data, ...(mediaType ? { mediaType } : {}) })
      } else if (url.startsWith('data:')) {
        // Malformed data URL or non-base64 data URL
        logger.error('Malformed or non-base64 data URL detected, image will be excluded:', {
          urlPrefix: url.slice(0, 50) + '...'
        })
        continue
      } else {
        // For remote URLs we keep payload minimal to match existing expectations.
        parts.push({ type: 'image', image: url })
      }
    }
  }
  return parts
}

/**
 * 转换为用户模型消息
 */
async function convertMessageToUserModelMessage(
  content: string,
  fileBlocks: FileMessageBlock[],
  imageBlocks: ImageMessageBlock[],
  isVisionModel = false,
  model?: Model,
  offloadImages = false
): Promise<UserModelMessage | (UserModelMessage | SystemModelMessage)[]> {
  const parts: Array<TextPart | FilePart | ImagePart> = []

  let textContent = content || ''
  if (offloadImages) {
    const placeholders = formatImagePlaceholders(imageBlocks, fileBlocks)
    if (placeholders) {
      textContent = textContent ? `${textContent}\n\n${placeholders}` : placeholders
    }
  }

  if (textContent) {
    parts.push({ type: 'text', text: textContent })
  }

  // 处理图片：只要用户附带了图片就发送给模型，
  // 不再仅限 vision 模型（由 API 端决定是否支持图片输入）
  // 历史轮次可 offload：只保留文本 ref，避免像素撑爆上下文。
  if (!offloadImages && imageBlocks.length > 0) {
    parts.push(...(await convertImageBlockToImagePart(imageBlocks)))
  }
  // 处理文件
  for (const fileBlock of fileBlocks) {
    const file = fileBlock.file
    if (offloadImages && file?.type === FILE_TYPE.IMAGE) {
      continue
    }
    let processed = false

    // 优先尝试原生文件支持（PDF、图片等）
    if (model) {
      const filePart = await convertFileBlockToFilePart(fileBlock, model)
      if (filePart) {
        // 判断filePart是否为string
        if (typeof filePart.data === 'string' && filePart.data.startsWith('fileid://')) {
          return [
            {
              role: 'system',
              content: filePart.data
            },
            {
              role: 'user',
              content: parts.length > 0 ? parts : ''
            }
          ]
        }
        parts.push(filePart)
        logger.debug(`File ${file.origin_name} processed as native file format`)
        processed = true
      }
    }

    // 原生文件支持失败 → 对 PDF 做特殊处理
    // 注意：AI SDK 的 OpenAI provider 校验 mediaType，拒绝 application/pdf，
    // 因此视觉模型需要将 PDF 渲染为 PNG 图片再发送（image/png 通过校验）。
    // Legacy 路径（OpenAIApiClient.ts）可以直接发送 data:application/pdf;base64,...
    if (!processed && file.type === FILE_TYPE.DOCUMENT && file.ext === '.pdf') {
      try {
        if (isVisionModel) {
          // 视觉/多模态模型：渲染 PDF 页面为图片，以 image/png 格式发送
          const fileApi = window.api.file as any
          if (fileApi.pdfToImages) {
            logger.info(`PDF ${file.origin_name}: rendering pages as images for vision model`)
            const result = await fileApi.pdfToImages(file.id + file.ext)
            if (result.images?.length > 0) {
              parts.push({ type: 'text', text: `[PDF: ${file.origin_name}, ${result.images.length} pages]` })
              for (const img of result.images) {
                parts.push({ type: 'image', image: img.data, mediaType: img.mime })
              }
              processed = true
            }
          }
        } else {
          // 纯文本模型：通过 pdfOcr 智能管线处理
          // 后端先提取文本，如果页均字符密度 < 200，自动调用视觉模型 OCR
          const fileApi = window.api.file as any
          if (fileApi.pdfOcr) {
            logger.info(`PDF ${file.origin_name}: routing through pdfOcr pipeline for text model`)
            const result = await fileApi.pdfOcr(file.id + file.ext)
            if (result.content?.trim()) {
              parts.push({ type: 'text', text: `${file.origin_name}\n${result.content}` })
              logger.debug(`PDF ${file.origin_name} processed via ${result.method} (${result.pages} pages)`)
              processed = true
            }
          }
          if (!processed) {
            const fileContent = await window.api.file.read(file.id + file.ext, true)
            const trimmed = fileContent.trim()
            if (trimmed.length > 0) {
              parts.push({ type: 'text', text: `${file.origin_name}\n${trimmed}` })
              processed = true
            }
          }
        }
      } catch (error) {
        logger.warn(`PDF ${file.origin_name} special processing failed:`, error as Error)
      }
    }

    // 非 PDF 文件，或 PDF 特殊处理未成功 → 通用文本提取（含 OCR 回退）
    if (!processed) {
      const lowerExt = file.ext?.toLowerCase() ?? ''
      const isAudio = file.type === FILE_TYPE.AUDIO || AUDIO_EXTS_CONFIG.includes(lowerExt)
      const isVideo = file.type === FILE_TYPE.VIDEO || VIDEO_EXTS_CONFIG.includes(lowerExt)

      if (isAudio) {
        // 音频文件无法做文本提取，跳过并提示（避免去 OCR）
        logger.warn(
          `Audio file ${file.origin_name} could not be sent natively to current model. ` +
            `Either the model is not vision-capable, the provider does not support audio, ` +
            `or the audio failed to transcode (see prior [audioTranscode]/[fileProcessor] logs).`
        )
        parts.push({
          type: 'text',
          text:
            `[音频文件 ${file.origin_name} 未能发送给当前模型。常见原因：` +
            `(1) 该文件编码不被 Electron 内置解码器支持（多见于 .m4a/AAC）；` +
            `(2) 当前模型/Provider 不支持音频输入。` +
            `建议将音频转换为 .mp3 或 .wav 后再上传。]`
        })
      } else if (isVideo) {
        logger.warn(
          `Video file ${file.origin_name} could not be sent natively to current model. ` +
            `Either the model/provider does not support video input, or the file exceeds the native send limit.`
        )
        parts.push({
          type: 'text',
          text:
            `[视频文件 ${file.origin_name} 未能发送给当前模型。常见原因：` +
            `(1) 当前模型/Provider 不支持视频输入；` +
            `(2) 文件超过该 Provider 的原生上传限制。` +
            `建议切换到支持视频理解的 Gemini/Google 模型，或压缩视频后重试。]`
        })
      } else {
        const textPart = await convertFileBlockToTextPart(fileBlock)
        if (textPart) {
          parts.push(textPart)
          logger.debug(`File ${file.origin_name} processed as text content`)
        } else {
          logger.warn(`File ${file.origin_name} could not be processed in any format`)
        }
      }
    }
  }

  return {
    role: 'user',
    content: parts
  }
}

/**
 * 转换为助手模型消息
 * 注意：当助手消息只包含图片（如图片生成模型的响应）而没有文本时，
 * 需要添加占位文本，因为某些 API（如 Gemini）不接受空的 assistant 消息
 */
async function convertMessageToAssistantModelMessage(
  content: string,
  fileBlocks: FileMessageBlock[],
  imageBlocks: ImageMessageBlock[],
  thinkingBlocks: ThinkingMessageBlock[],
  mainTextBlocks: MainTextMessageBlock[],
  model?: Model
): Promise<AssistantModelMessage> {
  const parts: Array<TextPart | ReasoningPart | FilePart> = []

  // Add reasoning blocks first (required by AWS Bedrock for Claude extended thinking)
  for (const thinkingBlock of thinkingBlocks) {
    parts.push({ type: 'reasoning', text: thinkingBlock.content })
  }

  // Add text content after reasoning blocks, only if non-empty after trimming
  // Also add thoughtSignature from MainTextBlock metadata for Gemini thought signature persistence
  const trimmedContent = content?.trim()
  if (trimmedContent) {
    // Find the first MainTextBlock with thoughtSignature
    const thoughtSignature = mainTextBlocks.find((block) => block.metadata?.thoughtSignature)?.metadata
      ?.thoughtSignature

    const textPart: TextPart = { type: 'text', text: trimmedContent }

    // Add providerOptions with thoughtSignature if available (for Gemini)
    if (thoughtSignature) {
      textPart.providerOptions = {
        google: {
          thoughtSignature
        }
      }
    }

    parts.push(textPart)
  }

  for (const fileBlock of fileBlocks) {
    // 优先尝试原生文件支持（PDF等）
    if (model) {
      const filePart = await convertFileBlockToFilePart(fileBlock, model)
      if (filePart) {
        parts.push(filePart)
        continue
      }
    }

    // 回退到文本处理
    const textPart = await convertFileBlockToTextPart(fileBlock)
    if (textPart) {
      parts.push(textPart)
    }
  }

  // 当 parts 为空但有图片时，添加占位文本
  // 这对于图片生成模型的继续对话很重要，因为助手消息可能只包含生成的图片
  if (parts.length === 0 && imageBlocks.length > 0) {
    parts.push({ type: 'text', text: '[Image]' })
  }

  return {
    role: 'assistant',
    content: parts
  }
}

/**
 * Splits MAIN_TEXT blocks into "before first tool block" vs "from first tool block onward"
 * using message.blocks order. This matches how the UI stores MCP flows: tool blocks then the
 * final assistant answer — replaying everything before tool-call parts would violate AI SDK
 * message ordering and trigger InvalidPromptError on the next user turn.
 */
function splitMainTextBlocksByToolRange(
  message: Message,
  mainTextBlocks: MainTextMessageBlock[],
  completedToolBlocks: ToolMessageBlock[]
): { pre: MainTextMessageBlock[]; post: MainTextMessageBlock[] } {
  if (completedToolBlocks.length === 0) {
    return { pre: mainTextBlocks, post: [] }
  }

  const toolIds = new Set(completedToolBlocks.map((b) => b.id))
  let firstToolIndex = -1
  for (let i = 0; i < message.blocks.length; i++) {
    if (toolIds.has(message.blocks[i])) {
      if (firstToolIndex === -1) {
        firstToolIndex = i
        break
      }
    }
  }

  if (firstToolIndex === -1) {
    logger.warn(
      'Tool blocks present but ids not found in message.blocks; using legacy ordering (all text before tool calls)'
    )
    return { pre: mainTextBlocks, post: [] }
  }

  const pre: MainTextMessageBlock[] = []
  const post: MainTextMessageBlock[] = []
  for (const block of mainTextBlocks) {
    const idx = message.blocks.indexOf(block.id)
    if (idx === -1) {
      post.push(block)
      continue
    }
    if (idx < firstToolIndex) {
      pre.push(block)
    } else {
      post.push(block)
    }
  }
  return { pre, post }
}

function joinMainTextContents(blocks: MainTextMessageBlock[]): string {
  return blocks.map((b) => b.content).join('\n\n')
}

/**
 * Wraps assistant message conversion with tool block handling.
 * When an assistant message contains completed TOOL blocks, it produces:
 * 1. An AssistantModelMessage with ToolCallPart entries appended
 * 2. A ToolModelMessage with corresponding ToolResultPart entries
 * This preserves multi-turn tool-calling context for the LLM.
 */
async function convertAssistantWithToolBlocks(
  message: Message,
  content: string,
  fileBlocks: FileMessageBlock[],
  imageBlocks: ImageMessageBlock[],
  thinkingBlocks: ThinkingMessageBlock[],
  mainTextBlocks: MainTextMessageBlock[],
  toolBlocks: ToolMessageBlock[],
  model?: Model
): Promise<ModelMessage | ModelMessage[]> {
  const completedToolBlocks = toolBlocks.filter(
    (tb) => tb.status === MessageBlockStatus.SUCCESS || tb.status === MessageBlockStatus.ERROR
  )

  if (completedToolBlocks.length === 0) {
    return convertMessageToAssistantModelMessage(
      content,
      fileBlocks,
      imageBlocks,
      thinkingBlocks,
      mainTextBlocks,
      model
    )
  }

  const { pre: preMainTextBlocks, post: postMainTextBlocks } = splitMainTextBlocksByToolRange(
    message,
    mainTextBlocks,
    completedToolBlocks
  )
  const preContent = joinMainTextContents(preMainTextBlocks)
  const postContent = joinMainTextContents(postMainTextBlocks)

  const firstAssistantCore = await convertMessageToAssistantModelMessage(
    preContent,
    fileBlocks,
    imageBlocks,
    thinkingBlocks,
    preMainTextBlocks,
    model
  )

  const assistantParts = Array.isArray(firstAssistantCore.content)
    ? [...firstAssistantCore.content]
    : firstAssistantCore.content
      ? [{ type: 'text' as const, text: firstAssistantCore.content }]
      : []

  const toolResultParts: ToolResultPart[] = []

  for (const toolBlock of completedToolBlocks) {
    const toolCallId = toolBlock.toolId
    const rawResponse = toolBlock.metadata?.rawMcpToolResponse
    const toolName = toolBlock.toolName || rawResponse?.tool?.name || 'unknown_tool'
    const args = toolBlock.arguments ?? rawResponse?.arguments ?? {}

    const toolCallPart: ToolCallPart = {
      type: 'tool-call',
      toolCallId,
      toolName,
      input: args
    }
    assistantParts.push(toolCallPart)

    let resultValue: string
    const rawResult = toolBlock.content ?? rawResponse?.response
    if (rawResult === undefined || rawResult === null) {
      resultValue = ''
    } else if (typeof rawResult === 'string') {
      resultValue = rawResult
    } else {
      try {
        resultValue = JSON.stringify(rawResult)
      } catch {
        resultValue = String(rawResult)
      }
    }

    const toolResultPart: ToolResultPart = {
      type: 'tool-result',
      toolCallId,
      toolName,
      output: { type: 'text', value: resultValue }
    }
    toolResultParts.push(toolResultPart)
  }

  const enrichedAssistant: AssistantModelMessage = {
    role: 'assistant',
    content: assistantParts as AssistantModelMessage['content']
  }

  const toolMessage: ToolModelMessage = {
    role: 'tool',
    content: toolResultParts
  }

  logger.debug(`Converted ${completedToolBlocks.length} tool blocks for multi-turn context`)

  const postTrimmed = postContent.trim()
  if (!postTrimmed) {
    return [enrichedAssistant, toolMessage]
  }

  const postAssistant = await convertMessageToAssistantModelMessage(postTrimmed, [], [], [], postMainTextBlocks, model)

  return [enrichedAssistant, toolMessage, postAssistant]
}

/**
 * Converts a message in the summary zone to a compact SDK message.
 * For assistant messages with a summary, uses the summary text.
 * For user messages paired with a summarized assistant, uses the summary's userQuery.
 * Falls back to null (triggering normal full conversion) if no summary is available.
 */
function convertSummarizedMessage(
  message: Message,
  summaryMap: Map<string, ConversationSummary | null>,
  index: number,
  allMessages: Message[]
): ModelMessage | null {
  if (message.role === 'assistant') {
    const summary = summaryMap.get(message.id)
    if (!summary) return null

    let text = `[Summary] ${summary.assistantResult}`
    if (summary.toolCalls.length > 0) {
      const toolText = summary.toolCalls.map((t) => `${t.toolName}: ${t.resultSummary}`).join('; ')
      text += `\n[Tools used] ${toolText}`
    }
    text += `\n[Detail ID: ${message.id}]`

    return { role: 'assistant', content: text }
  }

  if (message.role === 'user') {
    const nextMsg = index + 1 < allMessages.length ? allMessages[index + 1] : null
    if (nextMsg?.role === 'assistant') {
      const summary = summaryMap.get(nextMsg.id)
      if (summary) {
        return { role: 'user', content: `[Historical summary] ${summary.userQuery}` }
      }
    }
    return null
  }

  return null
}

/**
 * Removes structurally-invalid messages/parts that would make AI SDK's
 * `standardizePrompt` reject the prompt (AI_InvalidPromptError). This can happen
 * when a conversation accumulates many tool calls (e.g. repeated web searches) or
 * when context filtering / truncation leaves a dangling tool result.
 *
 * Rules (conservative — only drops what is genuinely invalid):
 * - assistant: drop tool-call parts missing a non-empty `toolCallId`/`toolName`;
 *   drop the whole message if its content array ends up empty.
 * - tool: keep only tool-result parts whose `toolCallId` matches a tool-call from a
 *   preceding (kept) assistant message; drop the message if nothing valid remains.
 * - user/system: drop messages whose content is an empty array.
 */
export function sanitizeModelMessages(messages: ModelMessage[]): ModelMessage[] {
  const validToolCallIds = new Set<string>()
  const result: ModelMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        const parts = msg.content.filter(
          (part) =>
            part.type !== 'tool-call' ||
            (typeof part.toolCallId === 'string' &&
              part.toolCallId.length > 0 &&
              typeof part.toolName === 'string' &&
              part.toolName.length > 0)
        )
        if (parts.length === 0) continue
        for (const part of parts) {
          if (part.type === 'tool-call') validToolCallIds.add(part.toolCallId)
        }
        result.push({ ...msg, content: parts } as ModelMessage)
      } else {
        result.push(msg)
      }
    } else if (msg.role === 'tool') {
      const content = Array.isArray(msg.content) ? (msg.content as ToolResultPart[]) : []
      const parts = content.filter(
        (part) =>
          typeof part.toolCallId === 'string' && part.toolCallId.length > 0 && validToolCallIds.has(part.toolCallId)
      )
      if (parts.length === 0) continue
      result.push({ ...msg, content: parts } as ModelMessage)
    } else {
      // user / system
      if (Array.isArray(msg.content) && msg.content.length === 0) continue
      result.push(msg)
    }
  }

  return result
}

/**
 * Converts an array of messages to SDK-compatible model messages.
 *
 * This function processes messages and transforms them into the format required by the SDK.
 * It handles special cases for vision models and image enhancement models.
 *
 * @param messages - Array of messages to convert.
 * @param model - The model configuration that determines conversion behavior
 *
 * @returns A promise that resolves to an array of SDK-compatible model messages
 *
 * @remarks
 * For image enhancement models:
 * - Collapses the conversation into [system?, user(image)] format
 * - Searches backwards through all messages to find the most recent assistant message with images
 * - Preserves all system messages (including ones generated from file uploads like 'fileid://...')
 * - Extracts the last user message content and merges images from the previous assistant message
 * - Returns only the collapsed messages: system messages (if any) followed by a single user message
 * - If no user message is found, returns only system messages
 * - Typical pattern: [system?, user, assistant(image), user] -> [system?, user(image)]
 *
 * For other models:
 * - Returns all converted messages in order without special image handling
 *
 * The function automatically detects vision model capabilities and adjusts conversion accordingly.
 */
export async function convertMessagesToSdkMessages(
  messages: Message[],
  model: Model,
  conversionOptions?: ConvertMessagesOptions | SummaryOptions
): Promise<ModelMessage[]> {
  const sdkMessages: ModelMessage[] = []
  const modality = getModelPrimaryModality(model)
  const isVision = isVisionModel(model) || modality === 'image'
  const options = conversionOptions as ConvertMessagesOptions | undefined
  const summaryMap = options?.summaryMap
  const splitIndex = options?.splitIndex
  const offloadImageMessageIds = options?.offloadImageMessageIds
  const hasSummaryZone = summaryMap !== undefined && splitIndex !== undefined && typeof splitIndex === 'number'

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]

    if (hasSummaryZone && summaryMap && i < splitIndex) {
      const converted = convertSummarizedMessage(message, summaryMap, i, messages)
      if (converted) {
        sdkMessages.push(converted)
        continue
      }
    }

    const sdkMessage = await convertMessageToSdkParam(message, isVision, model, {
      offloadImages: offloadImageMessageIds?.has(message.id)
    })
    sdkMessages.push(...(Array.isArray(sdkMessage) ? sdkMessage : [sdkMessage]))
  }
  // Special handling for image enhancement / image-generation models
  // These models support multi-turn conversations but need images from previous assistant messages
  // to be merged into the current user message for editing/enhancement operations.
  //
  // Key behaviors:
  // 1. Preserve all conversation history for context
  // 2. Find images from the previous assistant message and merge them into the last user message
  // 3. This allows users to switch from LLM conversations and use that context for image generation
  if (isImageEnhancementModel(model) || modality === 'image') {
    // Find the last user SDK message index
    const lastUserSdkIndex = (() => {
      for (let i = sdkMessages.length - 1; i >= 0; i--) {
        if (sdkMessages[i].role === 'user') return i
      }
      return -1
    })()

    // If no user message found, return messages as-is
    if (lastUserSdkIndex < 0) {
      return sdkMessages
    }

    // Find the nearest preceding assistant message in original messages
    let prevAssistant: Message | null = null
    for (let i = messages.length - 2; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        prevAssistant = messages[i]
        break
      }
    }

    // Check if there are images from the previous assistant message
    const imageBlocks = prevAssistant ? findImageBlocks(prevAssistant) : []
    const imageParts = await convertImageBlockToImagePart(imageBlocks)

    // If no images to merge, return messages as-is
    if (imageParts.length === 0) {
      return sanitizeModelMessages(sdkMessages)
    }

    // Build the new last user message with merged images
    const lastUserSdk = sdkMessages[lastUserSdkIndex] as UserModelMessage
    let finalUserParts: Array<TextPart | FilePart | ImagePart> = []

    if (typeof lastUserSdk.content === 'string') {
      finalUserParts.push({ type: 'text', text: lastUserSdk.content })
    } else if (Array.isArray(lastUserSdk.content)) {
      finalUserParts = [...lastUserSdk.content]
    }

    // Append images from the previous assistant message
    finalUserParts.push(...imageParts)

    // Replace the last user message with the merged version
    const result = [...sdkMessages]
    result[lastUserSdkIndex] = { role: 'user', content: finalUserParts }

    return sanitizeModelMessages(result)
  }

  return sanitizeModelMessages(sdkMessages)
}
