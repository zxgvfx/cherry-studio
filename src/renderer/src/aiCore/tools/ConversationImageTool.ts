import { loggerService } from '@logger'
import { CONVERSATION_IMAGE_TOOL_NAME } from '@renderer/services/ImageContextOffload'
import store from '@renderer/store'
import { messageBlocksSelectors } from '@renderer/store/messageBlock'
import { FILE_TYPE } from '@renderer/types'
import { MessageBlockType } from '@renderer/types/newMessage'
import { tool } from 'ai'
import * as z from 'zod'

import type { BuiltinTool } from './BuiltinToolRegistry'

const logger = loggerService.withContext('ConversationImageTool')

type LoadedImage = {
  name: string
  fileId?: string
  url?: string
  base64?: string
  mime?: string
  error?: string
}

async function loadImageByFileId(fileId: string): Promise<LoadedImage> {
  const state = store.getState()
  const blocks = messageBlocksSelectors.selectAll(state)

  for (const block of blocks) {
    if (block.type === MessageBlockType.IMAGE && block.file?.id === fileId) {
      try {
        const loaded = await window.api.file.base64Image(block.file.id + block.file.ext)
        return {
          name: block.file.origin_name || block.file.name || fileId,
          fileId,
          base64: loaded.base64,
          mime: loaded.mime || 'image/png'
        }
      } catch (error) {
        logger.error('Failed to load image by fileId from image block', { fileId, error: error as Error })
        return { name: fileId, fileId, error: `Failed to load image fileId=${fileId}` }
      }
    }

    if (block.type === MessageBlockType.FILE && block.file?.id === fileId && block.file.type === FILE_TYPE.IMAGE) {
      try {
        const loaded = await window.api.file.base64Image(block.file.id + block.file.ext)
        return {
          name: block.file.origin_name || block.file.name || fileId,
          fileId,
          base64: loaded.base64,
          mime: loaded.mime || 'image/png'
        }
      } catch (error) {
        logger.error('Failed to load image by fileId from file block', { fileId, error: error as Error })
        return { name: fileId, fileId, error: `Failed to load image fileId=${fileId}` }
      }
    }
  }

  return { name: fileId, fileId, error: `No image found for fileId=${fileId} in the current conversation` }
}

/**
 * Built-in tool that re-hydrates an offloaded conversation image for the model.
 * Prefer fileId from [Image ref ...] placeholders; url is supported for remote refs.
 */
export function conversationImageTool() {
  return tool({
    description:
      'Retrieve a conversation image that was offloaded from context as an [Image ref ...]. ' +
      'Use this when you need the actual visual content of a previously uploaded image. ' +
      'Prefer fileId from the placeholder; use url only for remote image refs.',
    inputSchema: z.object({
      fileId: z.string().optional().describe('fileId from an [Image ref fileId=...] placeholder'),
      url: z.string().optional().describe('Remote image URL from an [Image ref url=...] placeholder')
    }),
    execute: async ({ fileId, url }): Promise<LoadedImage> => {
      const trimmedFileId = fileId?.trim()
      const trimmedUrl = url?.trim()

      if (trimmedFileId) {
        return loadImageByFileId(trimmedFileId)
      }

      if (trimmedUrl) {
        if (trimmedUrl.startsWith('data:')) {
          return {
            name: 'inline-image',
            url: trimmedUrl,
            error: 'Inline data URLs are not re-fetched; the visual content is unavailable via this tool'
          }
        }
        return {
          name: trimmedUrl.split('/').pop() || 'remote-image',
          url: trimmedUrl
        }
      }

      return {
        name: 'unknown',
        error: 'Provide fileId or url from an [Image ref ...] placeholder'
      }
    },
    toModelOutput: ({ output }) => {
      if (output.error) {
        return { type: 'text' as const, value: output.error }
      }

      if (output.base64 && output.mime) {
        return {
          type: 'content' as const,
          value: [
            {
              type: 'text' as const,
              text: `Retrieved conversation image "${output.name}"${output.fileId ? ` (fileId=${output.fileId})` : ''}.`
            },
            {
              type: 'image-data' as const,
              data: output.base64,
              mediaType: output.mime
            }
          ]
        }
      }

      if (output.url) {
        return {
          type: 'content' as const,
          value: [
            {
              type: 'text' as const,
              text: `Retrieved conversation image "${output.name}" from URL.`
            },
            {
              type: 'image-url' as const,
              url: output.url
            }
          ]
        }
      }

      return { type: 'text' as const, value: `No visual content available for "${output.name}"` }
    }
  })
}

function topicHasAnyImage(): boolean {
  const state = store.getState()
  return messageBlocksSelectors.selectAll(state).some((block) => {
    if (block.type === MessageBlockType.IMAGE) return true
    if (block.type === MessageBlockType.FILE && block.file?.type === FILE_TYPE.IMAGE) return true
    return false
  })
}

export const conversationImageBuiltinTool: BuiltinTool = {
  name: CONVERSATION_IMAGE_TOOL_NAME,
  // Expose whenever the topic already has images, so the model can re-fetch offloaded refs.
  isEnabled: () => topicHasAnyImage(),
  create: () => conversationImageTool()
}
