/**
 * 搜索编排插件
 *
 * 功能：
 * 1. onRequestStart: 记录用户消息
 * 2. transformParams: 注入内置工具（web search / KB / memory / skill），由主 LLM 决定是否调用
 * 3. onRequestEnd: 自动记忆存储
 */
import {
  type AiPlugin,
  type AiRequestContext,
  definePlugin,
  type StreamTextParams,
  type StreamTextResult
} from '@cherrystudio/ai-core'
import { loggerService } from '@logger'
import store from '@renderer/store'
import { selectCurrentUserId, selectGlobalMemoryEnabled, selectMemoryConfig } from '@renderer/store/memory'
import type { Assistant } from '@renderer/types'
import type { Chunk } from '@renderer/types/chunk'
import type { ModelMessage } from 'ai'

import { MemoryProcessor } from '../../services/MemoryProcessor'
import { BuiltinToolRegistry } from '../tools/BuiltinToolRegistry'
import { conversationDetailBuiltinTool } from '../tools/ConversationDetailTool'
import { conversationImageBuiltinTool } from '../tools/ConversationImageTool'
import { knowledgeBuiltinTool } from '../tools/KnowledgeSearchTool'
import { memoryBuiltinTool } from '../tools/MemorySearchTool'
import { skillBuiltinTool } from '../tools/SkillTool'
import { webSearchBuiltinTool } from '../tools/WebSearchTool'

const logger = loggerService.withContext('SearchOrchestrationPlugin')

export const getMessageContent = (message: ModelMessage) => {
  if (typeof message.content === 'string') return message.content
  return message.content.reduce((acc, part) => {
    if (part.type === 'text') {
      return acc + part.text + '\n'
    }
    return acc
  }, '')
}

/**
 * 🧠 记忆存储函数 - 基于注释代码中的 processConversationMemory
 */
async function storeConversationMemory(
  messages: ModelMessage[],
  assistant: Assistant,
  context: AiRequestContext
): Promise<void> {
  const globalMemoryEnabled = selectGlobalMemoryEnabled(store.getState())

  if (!globalMemoryEnabled || !assistant.enableMemory) {
    return
  }

  try {
    const memoryConfig = selectMemoryConfig(store.getState())

    // 转换消息为记忆处理器期望的格式
    const conversationMessages = messages
      .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
      .map((msg) => ({
        role: msg.role,
        content: getMessageContent(msg) || ''
      }))
      .filter((msg) => msg.content.trim().length > 0)
    logger.debug('conversationMessages', conversationMessages)
    if (conversationMessages.length < 2) {
      logger.info('Need at least a user message and assistant response for memory processing')
      return
    }

    const currentUserId = selectCurrentUserId(store.getState())
    // const lastUserMessage = messages.findLast((m) => m.role === 'user')

    const processorConfig = MemoryProcessor.getProcessorConfig(
      memoryConfig,
      assistant.id,
      currentUserId,
      context.requestId
    )

    logger.info('Processing conversation memory...', { messageCount: conversationMessages.length })

    // 后台处理对话记忆（不阻塞 UI）
    const memoryProcessor = new MemoryProcessor()
    memoryProcessor
      .processConversation(conversationMessages, processorConfig)
      .then((result) => {
        logger.info('Memory processing completed:', result)
        if (result.facts?.length > 0) {
          logger.info('Extracted facts from conversation:', result.facts)
          logger.info('Memory operations performed:', result.operations)
        } else {
          logger.info('No facts extracted from conversation')
        }
      })
      .catch((error) => {
        logger.error('Background memory processing failed:', error as Error)
      })
  } catch (error) {
    logger.error('Error in conversation memory processing:', error as Error)
    // 不抛出错误，避免影响主流程
  }
}

/**
 * 🎯 搜索编排插件
 */
export const searchOrchestrationPlugin = (
  assistant: Assistant,
  topicId: string,
  _onChunk?: (chunk: Chunk) => void
): AiPlugin<StreamTextParams, StreamTextResult> => {
  const userMessages: { [requestId: string]: ModelMessage } = {}

  return definePlugin<StreamTextParams, StreamTextResult>({
    name: 'search-orchestration',
    enforce: 'pre',

    onRequestStart: async (context) => {
      if (!(assistant.webSearchProviderId || assistant.knowledge_bases?.length || assistant.enableMemory)) return

      const messages = context.originalParams.messages
      if (!messages || messages.length === 0) return

      userMessages[context.requestId] = messages[messages.length - 1]
    },

    transformParams: async (params, context) => {
      try {
        if (!params.tools) {
          params.tools = {}
        }

        const userMessage = userMessages[context.requestId]
        let userContent = 'search'
        if (userMessage) {
          userContent = getMessageContent(userMessage) || 'search'
        } else {
          const msgs = context.originalParams.messages
          if (msgs && msgs.length > 0) {
            userContent = getMessageContent(msgs[msgs.length - 1]) || 'search'
          }
        }

        const registry = new BuiltinToolRegistry()
        registry.register(knowledgeBuiltinTool)
        registry.register(webSearchBuiltinTool)
        registry.register(memoryBuiltinTool)
        registry.register(skillBuiltinTool)
        registry.register(conversationDetailBuiltinTool)
        registry.register(conversationImageBuiltinTool)

        registry.registerAll(params as { tools?: Record<string, any> }, {
          assistant,
          topicId,
          userContent,
          intentKeywords: undefined,
          requestId: context.requestId
        })

        return params
      } catch (error) {
        logger.error('Tool configuration failed:', error as Error)
        return params
      }
    },

    onRequestEnd: async (context) => {
      try {
        const messages = context.originalParams.messages
        if (messages && assistant) {
          await storeConversationMemory(messages, assistant, context)
        }
        delete userMessages[context.requestId]
      } catch (error) {
        logger.error('Memory storage failed:', error as Error)
      }
    }
  })
}

export default searchOrchestrationPlugin
