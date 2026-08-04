import { loggerService } from '@logger'
import FileManager from '@renderer/services/FileManager'
import type { FileMetadata } from '@renderer/types'
import type { ImageMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { createImageBlock } from '@renderer/utils/messageUtils/create'
import { ensureLocalImageUrl, isExternalUrl } from '@renderer/utils/proxyImage'

import type { BlockManager } from '../BlockManager'

const logger = loggerService.withContext('ImageCallbacks')

interface ImageCallbacksDependencies {
  blockManager: BlockManager
  assistantMsgId: string
}

/**
 * Normalize / persist generated images so Qt WebEngine can display them:
 * - raw base64 → data URL (bare base64 as <img src> becomes a huge relative GET → 414)
 * - external http(s) → proxied data URL
 * - large data URLs → save to disk + file:// (useProxiedImage reads via binaryImage)
 */
async function materializeGeneratedImages(imageData: any): Promise<{
  imageData: any
  file?: FileMetadata
}> {
  if (!imageData?.images?.length) {
    return { imageData }
  }

  const outImages: string[] = []
  let primaryFile: FileMetadata | undefined

  for (const raw of imageData.images as string[]) {
    if (!raw || typeof raw !== 'string') continue

    let src = raw.trim()
    if (
      !src.startsWith('data:') &&
      !src.startsWith('http://') &&
      !src.startsWith('https://') &&
      !src.startsWith('file://') &&
      !src.startsWith('blob:')
    ) {
      src = `data:image/png;base64,${src}`
    }

    if (isExternalUrl(src)) {
      try {
        src = await ensureLocalImageUrl(src)
      } catch (error) {
        logger.warn(`ensureLocalImageUrl failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (src.startsWith('data:') && window.api?.file?.saveBase64Image) {
      try {
        const file = (await window.api.file.saveBase64Image(src)) as FileMetadata
        if (file?.id) {
          await FileManager.addFile(file)
          if (!primaryFile) primaryFile = file
          outImages.push(`file://${FileManager.getFilePath(file)}`)
          continue
        }
      } catch (error) {
        logger.warn(
          `saveBase64Image failed, keeping data URL: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    outImages.push(src)
  }

  return {
    imageData: { ...imageData, type: imageData.type || 'base64', images: outImages },
    file: primaryFile
  }
}

export const createImageCallbacks = (deps: ImageCallbacksDependencies) => {
  const { blockManager, assistantMsgId } = deps

  // 内部维护的状态
  let imageBlockId: string | null = null

  return {
    onImageCreated: async () => {
      if (blockManager.hasInitialPlaceholder) {
        const initialChanges = {
          type: MessageBlockType.IMAGE,
          status: MessageBlockStatus.PENDING
        }
        imageBlockId = blockManager.initialPlaceholderBlockId!
        blockManager.smartBlockUpdate(imageBlockId, initialChanges, MessageBlockType.IMAGE)
      } else if (!imageBlockId) {
        const imageBlock = createImageBlock(assistantMsgId, {
          status: MessageBlockStatus.PENDING
        })
        imageBlockId = imageBlock.id
        await blockManager.handleBlockTransition(imageBlock, MessageBlockType.IMAGE)
      }
    },

    onImageDelta: (imageData: any) => {
      const imageUrl = imageData.images?.[0] || 'placeholder_image_url'
      if (imageBlockId) {
        const changes: Partial<ImageMessageBlock> = {
          url: imageUrl,
          metadata: { generateImageResponse: imageData },
          status: MessageBlockStatus.STREAMING
        }
        blockManager.smartBlockUpdate(imageBlockId, changes, MessageBlockType.IMAGE, true)
      }
    },

    onImageGenerated: async (imageData: any) => {
      const materialized = imageData ? await materializeGeneratedImages(imageData) : undefined
      const finalData = materialized?.imageData
      const file = materialized?.file

      if (imageBlockId) {
        if (!finalData) {
          const changes: Partial<ImageMessageBlock> = {
            status: MessageBlockStatus.SUCCESS
          }
          blockManager.smartBlockUpdate(imageBlockId, changes, MessageBlockType.IMAGE)
        } else {
          const imageUrl = finalData.images?.[0] || 'placeholder_image_url'
          const changes: Partial<ImageMessageBlock> = {
            url: imageUrl,
            file,
            metadata: { generateImageResponse: finalData },
            status: MessageBlockStatus.SUCCESS
          }
          blockManager.smartBlockUpdate(imageBlockId, changes, MessageBlockType.IMAGE, true)
        }
        imageBlockId = null
      } else {
        if (finalData) {
          const imageBlock = createImageBlock(assistantMsgId, {
            status: MessageBlockStatus.SUCCESS,
            url: finalData.images?.[0] || 'placeholder_image_url',
            file,
            metadata: { generateImageResponse: finalData }
          })
          await blockManager.handleBlockTransition(imageBlock, MessageBlockType.IMAGE)
        } else {
          logger.error('[onImageGenerated] Last block was not an Image block or ID is missing.')
        }
      }
    },

    onImageSearched: async (content: string, metadata: Record<string, any>) => {
      if (!imageBlockId) {
        const imageBlock = createImageBlock(assistantMsgId, {
          status: MessageBlockStatus.SUCCESS,
          metadata: {
            generateImageResponse: {
              type: 'base64',
              images: [`data:${metadata.mime};base64,${content}`]
            }
          }
        })
        await blockManager.handleBlockTransition(imageBlock, MessageBlockType.IMAGE)
      }
    }
  }
}
