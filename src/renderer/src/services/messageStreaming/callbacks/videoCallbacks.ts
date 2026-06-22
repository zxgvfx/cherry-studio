import { loggerService } from '@logger'
import type { VideoMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { createVideoBlock } from '@renderer/utils/messageUtils/create'

import type { BlockManager } from '../BlockManager'

const logger = loggerService.withContext('VideoCallbacks')

interface VideoCallbacksDependencies {
  blockManager: BlockManager
  assistantMsgId: string
}

export const createVideoCallbacks = (deps: VideoCallbacksDependencies) => {
  const { blockManager, assistantMsgId } = deps

  // 知识库检索视频时使用的块（onVideoSearched）
  const videoBlockId: string | null = null

  // 视频生成流程（submit/poll/complete）使用的块
  let videoGenBlockId: string | null = null

  return {
    onVideoSearched: async (video?: { type: 'url' | 'path'; content: string }, metadata?: Record<string, any>) => {
      if (!video) {
        logger.warn('onVideoSearched called without video data')
        return
      }

      logger.debug(`onVideoSearched video: ${JSON.stringify(video)}, metadata: ${JSON.stringify(metadata)}`)
      if (!videoBlockId) {
        const videoBlock = createVideoBlock(assistantMsgId, {
          status: MessageBlockStatus.SUCCESS,
          url: video.type === 'url' ? video.content : undefined,
          filePath: video.type === 'path' ? video.content : undefined,
          metadata: metadata || {}
        })
        await blockManager.handleBlockTransition(videoBlock, MessageBlockType.VIDEO)
      }
    },

    onVideoGenCreated: async () => {
      if (blockManager.hasInitialPlaceholder) {
        const initialChanges = {
          type: MessageBlockType.VIDEO,
          status: MessageBlockStatus.PENDING
        }
        videoGenBlockId = blockManager.initialPlaceholderBlockId!
        blockManager.smartBlockUpdate(videoGenBlockId, initialChanges, MessageBlockType.VIDEO)
      } else if (!videoGenBlockId) {
        const block = createVideoBlock(assistantMsgId, {
          status: MessageBlockStatus.PENDING
        })
        videoGenBlockId = block.id
        await blockManager.handleBlockTransition(block, MessageBlockType.VIDEO)
      }
    },

    onVideoGenProgress: (progressText: string) => {
      if (videoGenBlockId) {
        const changes: Partial<VideoMessageBlock> = {
          metadata: { progressText } as any,
          status: MessageBlockStatus.PROCESSING
        }
        blockManager.smartBlockUpdate(videoGenBlockId, changes, MessageBlockType.VIDEO)
      }
    },

    onVideoGenComplete: async (url: string, metadata?: Record<string, any>) => {
      if (videoGenBlockId) {
        const changes: Partial<VideoMessageBlock> = {
          url,
          metadata: { ...(metadata || {}) } as any,
          status: MessageBlockStatus.SUCCESS
        }
        blockManager.smartBlockUpdate(videoGenBlockId, changes, MessageBlockType.VIDEO, true)
        videoGenBlockId = null
      } else {
        const block = createVideoBlock(assistantMsgId, {
          url,
          metadata: (metadata || {}) as any,
          status: MessageBlockStatus.SUCCESS
        })
        await blockManager.handleBlockTransition(block, MessageBlockType.VIDEO)
      }
      logger.debug(`Video generation block completed: ${url}`)
    }
  }
}
