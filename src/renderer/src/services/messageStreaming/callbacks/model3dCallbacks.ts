import { loggerService } from '@logger'
import type { Model3DMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { createModel3DBlock } from '@renderer/utils/messageUtils/create'

import type { BlockManager } from '../BlockManager'

const logger = loggerService.withContext('Model3DCallbacks')

interface Model3DCallbacksDependencies {
  blockManager: BlockManager
  assistantMsgId: string
}

function extractCleanFile(fileData: any) {
  const { extraFiles, prompt, seed, duration, ...cleanFile } = fileData || {}
  const metadata: Record<string, any> = {}
  if (extraFiles) metadata.extraFiles = extraFiles
  if (seed != null) metadata.seed = seed
  if (duration != null) metadata.duration = duration
  if (prompt) metadata.prompt = prompt
  return { cleanFile, extraMeta: metadata }
}

export const createModel3DCallbacks = (deps: Model3DCallbacksDependencies) => {
  const { blockManager, assistantMsgId } = deps

  let model3DBlockId: string | null = null

  return {
    onModel3DCreated: async () => {
      if (blockManager.hasInitialPlaceholder) {
        const initialChanges = {
          type: MessageBlockType.MODEL_3D,
          status: MessageBlockStatus.PENDING
        }
        model3DBlockId = blockManager.initialPlaceholderBlockId!
        blockManager.smartBlockUpdate(model3DBlockId, initialChanges, MessageBlockType.MODEL_3D)
      } else if (!model3DBlockId) {
        const block = createModel3DBlock(assistantMsgId, {
          status: MessageBlockStatus.PENDING
        } as any)
        model3DBlockId = block.id
        await blockManager.handleBlockTransition(block, MessageBlockType.MODEL_3D)
      }
    },

    onModel3DProgress: (progressText: string) => {
      if (model3DBlockId) {
        const changes: Partial<Model3DMessageBlock> = {
          metadata: { progressText } as any,
          status: MessageBlockStatus.PROCESSING
        }
        blockManager.smartBlockUpdate(model3DBlockId, changes, MessageBlockType.MODEL_3D)
      }
    },

    onModel3DComplete: async (fileData: any, format: string) => {
      const { cleanFile, extraMeta } = extractCleanFile(fileData)

      if (model3DBlockId) {
        const changes: Partial<Model3DMessageBlock> = {
          file: cleanFile,
          metadata: {
            format: format as any,
            ...extraMeta
          },
          status: MessageBlockStatus.SUCCESS
        }
        blockManager.smartBlockUpdate(model3DBlockId, changes, MessageBlockType.MODEL_3D, true)
        model3DBlockId = null
      } else {
        const block = createModel3DBlock(assistantMsgId, {
          file: cleanFile,
          metadata: {
            format: format as any,
            ...extraMeta
          },
          status: MessageBlockStatus.SUCCESS
        })
        await blockManager.handleBlockTransition(block, MessageBlockType.MODEL_3D)
      }
      logger.debug(`Model3D block completed with format: ${format}`)
    }
  }
}
