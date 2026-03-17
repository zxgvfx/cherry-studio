import { loggerService } from '@logger'
import type { FileMetadata } from '@renderer/types'
import type { Model3DMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { createModel3DBlock } from '@renderer/utils/messageUtils/create'

import type { BlockManager } from '../BlockManager'

const logger = loggerService.withContext('Model3DCallbacks')

interface Model3DCallbacksDependencies {
  blockManager: BlockManager
  assistantMsgId: string
}

export const createModel3DCallbacks = (deps: Model3DCallbacksDependencies) => {
  const { blockManager, assistantMsgId } = deps

  let model3dBlockId: string | null = null

  return {
    onModel3DCreated: async () => {
      logger.debug('onModel3DCreated')
      if (blockManager.hasInitialPlaceholder) {
        const initialChanges = {
          type: MessageBlockType.MODEL_3D,
          status: MessageBlockStatus.PROCESSING
        }
        model3dBlockId = blockManager.initialPlaceholderBlockId!
        blockManager.smartBlockUpdate(model3dBlockId, initialChanges, MessageBlockType.MODEL_3D)
      } else if (!model3dBlockId) {
        const block = createModel3DBlock(assistantMsgId, {
          status: MessageBlockStatus.PROCESSING,
          file: {} as FileMetadata
        })
        model3dBlockId = block.id
        await blockManager.handleBlockTransition(block, MessageBlockType.MODEL_3D)
      }
    },

    onModel3DProgress: (progressText: string) => {
      if (model3dBlockId) {
        const changes: Partial<Model3DMessageBlock> = {
          metadata: { progressText } as any
        }
        blockManager.smartBlockUpdate(model3dBlockId, changes, MessageBlockType.MODEL_3D)
      }
    },

    onModel3DComplete: async (fileData: {
      id: string
      name: string
      origin_name?: string
      path: string
      ext: string
      size: number
      type: string
      created_at?: string
    }, format: string) => {
      logger.debug('onModel3DComplete', { fileData, format })

      const fileMeta: FileMetadata = {
        id: fileData.id,
        name: fileData.name,
        origin_name: fileData.origin_name || fileData.name,
        path: fileData.path,
        ext: fileData.ext,
        size: fileData.size,
        type: 'other',
        created_at: fileData.created_at || new Date().toISOString(),
        count: 1
      }

      if (model3dBlockId) {
        const changes: Partial<Model3DMessageBlock> = {
          file: fileMeta,
          metadata: { format: format as any },
          status: MessageBlockStatus.SUCCESS
        }
        blockManager.smartBlockUpdate(model3dBlockId, changes, MessageBlockType.MODEL_3D, true)
        model3dBlockId = null
      } else {
        const block = createModel3DBlock(assistantMsgId, {
          status: MessageBlockStatus.SUCCESS,
          file: fileMeta,
          metadata: { format: format as any }
        })
        await blockManager.handleBlockTransition(block, MessageBlockType.MODEL_3D)
      }
    }
  }
}
