import { loggerService } from '@logger'
import { convertMessagesToSdkMessages } from '@renderer/aiCore/prepareParams'
import type { Assistant, Message } from '@renderer/types'
import { filterAdjacentUserMessaegs, filterLastAssistantMessage } from '@renderer/utils/messageUtils/filters'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import type { ModelMessage } from 'ai'
import { findLast, isEmpty, takeRight } from 'lodash'
import { approximateTokenSize } from 'tokenx'

import { getAssistantSettings, getDefaultModel } from './AssistantService'
import {
  type ConversationSummary,
  ConversationSummaryService,
  getContextSummaryEnabled,
  getContextSummaryFullTurns
} from './ConversationSummaryService'
import {
  filterAfterContextClearMessages,
  filterEmptyMessages,
  filterErrorOnlyMessagesWithRelated,
  filterUsefulMessages,
  filterUserRoleStartMessages
} from './MessagesService'

const logger = loggerService.withContext('ConversationService')

/**
 * Multiplier applied to contextCount when summary mode is enabled.
 * Summaries are compact, so we can safely include more history turns.
 */
const SUMMARY_CONTEXT_MULTIPLIER = 5

/**
 * Safety threshold for estimated context tokens.
 * Prevents sending excessively large contexts that would be rejected by most LLM providers.
 * 120K covers GPT-4 Turbo (128K), Claude (200K), Gemini (1M+), etc.
 * Models with smaller windows (e.g. 8K) should use a lower contextCount instead.
 */
const MAX_SAFE_CONTEXT_TOKENS = 120_000

export class ConversationService {
  /**
   * Applies the filtering pipeline that prepares UI messages for model consumption.
   * This keeps the logic testable and prevents future regressions when the pipeline changes.
   */
  static filterMessagesPipeline(messages: Message[], contextCount: number): Message[] {
    const messagesAfterContextClear = filterAfterContextClearMessages(messages)
    const usefulMessages = filterUsefulMessages(messagesAfterContextClear)
    // Run the error-only filter before trimming trailing assistant responses so the pair is removed together.
    const withoutErrorOnlyPairs = filterErrorOnlyMessagesWithRelated(usefulMessages)
    const withoutTrailingAssistant = filterLastAssistantMessage(withoutErrorOnlyPairs)
    const withoutAdjacentUsers = filterAdjacentUserMessaegs(withoutTrailingAssistant)
    const limitedByContext = takeRight(withoutAdjacentUsers, contextCount + 2)
    const contextClearFiltered = filterAfterContextClearMessages(limitedByContext)
    const nonEmptyMessages = filterEmptyMessages(contextClearFiltered)
    const userRoleStartMessages = filterUserRoleStartMessages(nonEmptyMessages)
    return userRoleStartMessages
  }

  /**
   * Drops the oldest messages when estimated token count exceeds MAX_SAFE_CONTEXT_TOKENS.
   * Always preserves at least the last user message to avoid empty payloads.
   */
  static truncateByTokenBudget(messages: Message[], systemPromptTokens = 0): Message[] {
    if (messages.length <= 1) return messages

    let totalTokens = systemPromptTokens
    const tokenPerMessage: number[] = messages.map((msg) => {
      const text = getMainTextContent(msg)
      return approximateTokenSize(text)
    })
    totalTokens += tokenPerMessage.reduce((sum, t) => sum + t, 0)

    if (totalTokens <= MAX_SAFE_CONTEXT_TOKENS) return messages

    const result = [...messages]
    const tokens = [...tokenPerMessage]
    let currentTotal = totalTokens

    while (currentTotal > MAX_SAFE_CONTEXT_TOKENS && result.length > 1) {
      currentTotal -= tokens[0]
      tokens.shift()
      result.shift()
    }

    if (result.length < messages.length) {
      const dropped = messages.length - result.length
      logger.warn(
        `Context token safety truncation: dropped ${dropped} oldest messages ` +
          `(estimated ${totalTokens} → ${currentTotal} tokens, limit ${MAX_SAFE_CONTEXT_TOKENS})`
      )
    }

    return result
  }

  static async prepareMessagesForModel(
    messages: Message[],
    assistant: Assistant
  ): Promise<{ modelMessages: ModelMessage[]; uiMessages: Message[]; hasSummaries?: boolean }> {
    const { contextCount } = getAssistantSettings(assistant)
    const lastUserMessage = findLast(messages, (m) => m.role === 'user')
    if (!lastUserMessage) {
      return { modelMessages: [], uiMessages: [] }
    }

    const summaryEnabled = getContextSummaryEnabled()
    const effectiveContextCount = summaryEnabled ? contextCount * SUMMARY_CONTEXT_MULTIPLIER : contextCount

    const pipelineMessages = ConversationService.filterMessagesPipeline(messages, effectiveContextCount)
    logger.debug('uiMessagesFromPipeline', pipelineMessages)

    const systemPromptTokens = assistant.prompt ? approximateTokenSize(assistant.prompt) : 0
    const truncatedMessages = ConversationService.truncateByTokenBudget(pipelineMessages, systemPromptTokens)

    let uiMessages = truncatedMessages
    if ((!uiMessages || uiMessages.length === 0) && lastUserMessage) {
      uiMessages = [lastUserMessage]
    }

    const model = assistant.model || getDefaultModel()

    if (!summaryEnabled || uiMessages.length <= 2) {
      return {
        modelMessages: await convertMessagesToSdkMessages(uiMessages, model),
        uiMessages
      }
    }

    const fullTurns = getContextSummaryFullTurns()
    const fullContentCount = fullTurns * 2
    const splitIndex = Math.max(0, uiMessages.length - fullContentCount)

    const summaryZone = uiMessages.slice(0, splitIndex)

    const summaryMap = new Map<string, ConversationSummary | null>()
    let hasSummaries = false
    for (const msg of summaryZone) {
      if (msg.role === 'assistant') {
        const summary = ConversationSummaryService.getSummary(msg)
        summaryMap.set(msg.id, summary)
        if (summary) hasSummaries = true
      }
    }

    const modelMessages = await convertMessagesToSdkMessages(uiMessages, model, { summaryMap, splitIndex })

    return { modelMessages, uiMessages, hasSummaries }
  }

  static needsWebSearch(assistant: Assistant): boolean {
    return !!assistant.webSearchProviderId
  }

  static needsKnowledgeSearch(assistant: Assistant): boolean {
    return !isEmpty(assistant.knowledge_bases)
  }
}
