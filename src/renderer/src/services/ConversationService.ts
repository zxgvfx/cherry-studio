import { loggerService } from '@logger'
import { convertMessagesToSdkMessages } from '@renderer/aiCore/prepareParams'
import store from '@renderer/store'
import type { Assistant, Message } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { applyContextFilters } from '@renderer/utils/messageUtils/filters'
import {
  findFileBlocks,
  findImageBlocks,
  findToolBlocks,
  getMainTextContent,
  getThinkingContent
} from '@renderer/utils/messageUtils/find'
import type { ModelMessage } from 'ai'
import { findLast, isEmpty } from 'lodash'
import { approximateTokenSize } from 'tokenx'

import { getAssistantSettings, getDefaultModel } from './AssistantService'
import {
  type ConversationSummary,
  ConversationSummaryService,
  getContextSummaryEnabled,
  getContextSummaryFullTurns
} from './ConversationSummaryService'
import {
  countOffloadableImages,
  DEFAULT_KEEP_FULL_IMAGE_USER_MESSAGES,
  IMAGE_PLACEHOLDER_TOKEN_ESTIMATE,
  resolveImageOffloadMessageIds
} from './ImageContextOffload'
import { estimateImageTokens } from './TokenService'

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

/**
 * Rough bytes-per-token ratio used to estimate the cost of attached text files
 * whose extracted content is not available synchronously.
 */
const TEXT_FILE_BYTES_PER_TOKEN = 4

export class ConversationService {
  /**
   * Estimates the token footprint of a full message, including every block that
   * actually reaches the model: main text, thinking, images, attached files and
   * tool-call results. The previous implementation only counted main text, which
   * made the budget blind to images / search results / tool outputs and routinely
   * under-estimated the real payload by a large margin.
   */
  static estimateMessageTokens(message: Message, options?: { offloadImages?: boolean }): number {
    let tokens = 0
    const offloadImages = options?.offloadImages === true

    const text = getMainTextContent(message)
    if (text) tokens += approximateTokenSize(text)

    const thinking = getThinkingContent(message)
    if (thinking) tokens += approximateTokenSize(thinking)

    if (offloadImages) {
      // Historical images are sent as short refs, not base64 pixels.
      tokens += countOffloadableImages(message) * IMAGE_PLACEHOLDER_TOKEN_ESTIMATE
    } else {
      // Inline images (vision input)
      for (const block of findImageBlocks(message)) {
        if (block.file) tokens += estimateImageTokens(block.file)
      }
    }

    // Attached files (text extraction / native file parts)
    for (const block of findFileBlocks(message)) {
      const file = block.file
      if (!file) continue
      if (file.type === FILE_TYPE.IMAGE) {
        // Image file blocks are already counted via countOffloadableImages / image blocks
        // when offloading; when keeping pixels, charge full estimate (skip if also
        // present as an image block to avoid double-counting).
        if (offloadImages) continue
        const duplicatedAsImageBlock = findImageBlocks(message).some((b) => b.file?.id === file.id)
        if (!duplicatedAsImageBlock) tokens += estimateImageTokens(file)
      } else if (file.type === FILE_TYPE.TEXT) {
        tokens += Math.floor((file.size ?? 0) / TEXT_FILE_BYTES_PER_TOKEN)
      } else {
        // PDFs / docs / audio etc. — rough heuristic, only to keep the budget honest.
        tokens += Math.floor((file.size ?? 0) / 100)
      }
    }

    // Tool-call results (web search / knowledge base JSON, etc.) — these can be
    // large and are otherwise invisible to the context budget.
    for (const block of findToolBlocks(message)) {
      const raw = block.metadata?.rawMcpToolResponse
      if (!raw) continue
      try {
        tokens += approximateTokenSize(JSON.stringify(raw.response ?? raw))
      } catch {
        // Non-serializable response; ignore for estimation purposes.
      }
    }

    return tokens
  }
  /**
   * Applies the filtering pipeline that prepares UI messages for model consumption.
   * This keeps the logic testable and prevents future regressions when the pipeline changes.
   */
  static filterMessagesPipeline(messages: Message[], contextCount: number): Message[] {
    // Delegates to the shared context filter (the same one backing the UI count)
    // with the send-only steps enabled: reserve 2 slots for the in-flight
    // user/assistant pair and drop the trailing assistant placeholder.
    return applyContextFilters(messages, contextCount, {
      reservedSlots: 2,
      dropTrailingAssistant: true,
      dropErrorOnlyPairs: true
    })
  }

  /**
   * Drops the oldest messages when estimated token count exceeds MAX_SAFE_CONTEXT_TOKENS.
   * Always preserves at least the last user message to avoid empty payloads.
   *
   * When `offloadImageMessageIds` is provided, those messages are estimated with
   * lightweight image placeholders so historical text is less likely to be discarded
   * solely because of attached image pixels.
   */
  static truncateByTokenBudget(
    messages: Message[],
    systemPromptTokens = 0,
    offloadImageMessageIds?: Set<string>
  ): Message[] {
    if (messages.length <= 1) return messages

    let totalTokens = systemPromptTokens
    const tokenPerMessage: number[] = messages.map((msg) =>
      ConversationService.estimateMessageTokens(msg, {
        offloadImages: offloadImageMessageIds?.has(msg.id)
      })
    )
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
    const keepFullImageUserTurns =
      store.getState().settings?.imageContextKeepFullUserTurns ?? DEFAULT_KEEP_FULL_IMAGE_USER_MESSAGES

    // Estimate with provisional offload so large historical images don't force
    // whole-turn drops; recompute after truncation so the keep-window stays correct.
    const provisionalOffloadIds = resolveImageOffloadMessageIds(pipelineMessages, keepFullImageUserTurns)
    const truncatedMessages = ConversationService.truncateByTokenBudget(
      pipelineMessages,
      systemPromptTokens,
      provisionalOffloadIds
    )

    let uiMessages = truncatedMessages
    if ((!uiMessages || uiMessages.length === 0) && lastUserMessage) {
      uiMessages = [lastUserMessage]
    }

    const offloadImageMessageIds = resolveImageOffloadMessageIds(uiMessages, keepFullImageUserTurns)
    if (offloadImageMessageIds.size > 0) {
      logger.info(
        `Offloading image pixels from ${offloadImageMessageIds.size} historical message(s); ` +
          `text and image refs are preserved`
      )
    }

    const model = assistant.model || getDefaultModel()

    if (!summaryEnabled || uiMessages.length <= 2) {
      return {
        modelMessages: await convertMessagesToSdkMessages(uiMessages, model, { offloadImageMessageIds }),
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

    const modelMessages = await convertMessagesToSdkMessages(uiMessages, model, {
      summaryMap,
      splitIndex,
      offloadImageMessageIds
    })

    return { modelMessages, uiMessages, hasSummaries }
  }

  static needsWebSearch(assistant: Assistant): boolean {
    return !!assistant.webSearchProviderId
  }

  static needsKnowledgeSearch(assistant: Assistant): boolean {
    return !isEmpty(assistant.knowledge_bases)
  }
}
