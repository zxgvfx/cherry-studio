import { loggerService } from '@logger'
import { isVisionModel } from '@renderer/config/models'
import db from '@renderer/databases'
import store from '@renderer/store'
import { updateOneBlock } from '@renderer/store/messageBlock'
import type { ImageMessageBlock, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'

import AiProviderNew from '../aiCore/index_new'
import { getDefaultAssistant, getProviderByModel, getQuickModel } from './AssistantService'
import { getRotatedApiKey } from './providerKey'

const logger = loggerService.withContext('ImageCaptionService')

const CAPTION_SYSTEM_PROMPT = `You are an image captioner. Describe the image in one concise sentence (max 40 words).
Include any clearly readable text (OCR) if present. Reply with plain text only — no markdown, no labels.`

const inFlightBlockIds = new Set<string>()

function getImageCaptionEnabled(): boolean {
  return store.getState().settings?.imageCaptionEnabled ?? true
}

function truncateCaption(caption: string, maxLen = 200): string {
  const normalized = caption.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLen) return normalized
  return `${normalized.slice(0, maxLen - 1)}…`
}

export class ImageCaptionService {
  /**
   * Fire-and-forget caption generation for newly attached image blocks.
   * Skips when disabled, already captioned, or the quick model is not vision-capable.
   */
  static scheduleForBlocks(blocks: MessageBlock[]): void {
    if (!getImageCaptionEnabled()) return

    for (const block of blocks) {
      if (block.type !== MessageBlockType.IMAGE) continue
      ImageCaptionService.generateAndStoreAsync(block as ImageMessageBlock)
    }
  }

  static generateAndStoreAsync(block: ImageMessageBlock): void {
    if (!getImageCaptionEnabled()) return
    if (!block.file) return
    if (block.metadata?.imageCaption) return
    if (inFlightBlockIds.has(block.id)) return

    inFlightBlockIds.add(block.id)
    void ImageCaptionService.generateAndStore(block)
      .catch((error) => {
        logger.warn('Image caption generation failed', { blockId: block.id, error: error as Error })
      })
      .finally(() => {
        inFlightBlockIds.delete(block.id)
      })
  }

  static async generateAndStore(block: ImageMessageBlock): Promise<string | null> {
    if (!block.file) return null

    const model = getQuickModel()
    if (!model) {
      logger.debug('No quick model configured; skipping image caption')
      return null
    }
    if (!isVisionModel(model)) {
      logger.debug('Quick model is not vision-capable; skipping image caption', { modelId: model.id })
      return null
    }

    const provider = getProviderByModel(model)
    if (!provider) {
      logger.debug('No provider for quick model; skipping image caption')
      return null
    }

    try {
      const loaded = await window.api.file.base64Image(block.file.id + block.file.ext)
      const providerWithRotatedKey = {
        ...provider,
        apiKey: getRotatedApiKey(provider)
      }
      const AI = new AiProviderNew(model, providerWithRotatedKey)
      const defaultAssistant = getDefaultAssistant()
      const captionAssistant = {
        ...defaultAssistant,
        settings: {
          ...defaultAssistant.settings,
          reasoning_effort: 'default' as const,
          qwenThinkMode: false
        },
        prompt: CAPTION_SYSTEM_PROMPT,
        model
      }

      const { getText } = await AI.completions(
        model.id,
        {
          system: CAPTION_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Describe this image briefly for later conversation context.'
                },
                {
                  type: 'image',
                  image: loaded.base64,
                  mediaType: loaded.mime || 'image/png'
                }
              ]
            }
          ],
          maxOutputTokens: 120
        },
        {
          streamOutput: false,
          enableReasoning: false,
          isPromptToolUse: false,
          isSupportedToolUse: false,
          isImageGenerationEndpoint: false,
          enableWebSearch: false,
          enableGenerateImage: false,
          enableUrlContext: false,
          mcpTools: [],
          assistant: captionAssistant,
          topicId: '',
          callType: 'summary'
        }
      )

      const caption = truncateCaption(getText()?.trim() ?? '')
      if (!caption) return null

      await ImageCaptionService.persistCaption(block.id, caption)
      logger.info('Stored image caption', { blockId: block.id, fileId: block.file.id })
      return caption
    } catch (error) {
      logger.warn('Failed to generate image caption', { blockId: block.id, error: error as Error })
      return null
    }
  }

  static async persistCaption(blockId: string, caption: string): Promise<void> {
    const state = store.getState()
    const current = state.messageBlocks.entities[blockId] as ImageMessageBlock | undefined
    const nextMetadata = {
      ...(current?.metadata ?? {}),
      imageCaption: caption
    }

    store.dispatch(
      updateOneBlock({
        id: blockId,
        changes: { metadata: nextMetadata }
      })
    )

    try {
      await db.message_blocks.update(blockId, { metadata: nextMetadata })
    } catch (error) {
      logger.warn('Failed to persist image caption to DB', { blockId, error: error as Error })
    }
  }
}
