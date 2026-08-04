import { loggerService } from '@logger'
import db from '@renderer/databases'
import store from '@renderer/store'
import { formatCitationsFromBlock } from '@renderer/store/messageBlock'
import type { Message } from '@renderer/types'
import type { MainTextMessageBlock, ToolMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { findCitationBlocks, findFileBlocks, findImageBlocks } from '@renderer/utils/messageUtils/find'

import AiProviderNew from '../aiCore/index_new'
import { getDefaultAssistant, getProviderByModel, getQuickModel } from './AssistantService'
import { getRotatedApiKey } from './providerKey'

const logger = loggerService.withContext('ConversationSummaryService')

export interface ConversationSummary {
  userQuery: string
  assistantResult: string
  toolCalls: { toolName: string; resultSummary: string }[]
  generatedAt: string
  modelId: string
}

const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer. Summarize the given conversation turn concisely.
Return ONLY a valid JSON object with these fields (no markdown, no extra text):
{
  "userQuery": "one-sentence summary of what the user asked",
  "assistantResult": "one-paragraph summary of the assistant's answer, no tool details, no thinking",
  "toolCalls": [{ "toolName": "tool name", "resultSummary": "brief summary of tool result, max 100 chars" }]
}
If no tools were used, toolCalls should be an empty array [].`

export function getContextSummaryEnabled(): boolean {
  return store.getState().settings.contextSummaryEnabled ?? false
}

export function getContextSummaryFullTurns(): number {
  return store.getState().settings.contextSummaryFullTurns ?? 2
}

/**
 * Builds a compact note describing non-text signals of a turn (uploaded images,
 * cited/searched sources) so that this information survives summarization instead
 * of being silently dropped. Kept in English to match the other summary markers.
 */
function extractTurnSignals(userMessage: Message, assistantMessage: Message): string {
  const signals: string[] = []

  const imageCount = findImageBlocks(userMessage).length
  if (imageCount > 0) signals.push(`${imageCount} user image(s)`)

  const fileCount = findFileBlocks(userMessage).length
  if (fileCount > 0) signals.push(`${fileCount} attached file(s)`)

  const citationCount = findCitationBlocks(assistantMessage).reduce(
    (sum, block) => sum + formatCitationsFromBlock(block).length,
    0
  )
  if (citationCount > 0) signals.push(`${citationCount} cited source(s)`)

  return signals.length > 0 ? ` [turn included: ${signals.join(', ')}]` : ''
}

function extractToolInfo(message: Message): { toolName: string; resultSummary: string }[] {
  const state = store.getState()
  const blocks = Object.values(state.messageBlocks.entities).filter(
    (b): b is ToolMessageBlock => !!b && b.messageId === message.id && b.type === MessageBlockType.TOOL
  )
  return blocks.map((block) => {
    const raw = block.metadata?.rawMcpToolResponse
    const toolName = raw?.tool?.name ?? block.toolName ?? 'unknown'
    let resultSummary = ''
    try {
      const resp = raw?.response
      if (resp && Array.isArray(resp.content)) {
        resultSummary = resp.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => String(c.text))
          .join(' ')
          .slice(0, 150)
      }
    } catch {
      resultSummary = ''
    }
    return { toolName, resultSummary }
  })
}

export class ConversationSummaryService {
  /**
   * Decides whether it's worth spending a quick-model call to summarize a turn.
   * Skips entirely when the feature is off, and avoids summarizing short
   * conversations that are sent verbatim anyway (history below the always-kept
   * full window). Turns completed once this threshold is reached get summarized
   * as they complete; earlier (verbatim) turns simply fall back to full content.
   */
  static shouldGenerateSummary(topicMessageCount: number): boolean {
    if (!getContextSummaryEnabled()) return false
    return topicMessageCount >= getContextSummaryFullTurns() * 2
  }

  /**
   * Read a stored summary from the main text block metadata of an assistant message.
   */
  static getSummary(message: Message): ConversationSummary | null {
    const state = store.getState()
    const blocks = Object.values(state.messageBlocks.entities).filter(
      (b): b is MainTextMessageBlock => !!b && b.messageId === message.id && b.type === MessageBlockType.MAIN_TEXT
    )
    for (const block of blocks) {
      const summary = block.metadata?.conversationSummary as ConversationSummary | undefined
      if (summary) return summary
    }
    return null
  }

  /**
   * Persist a summary into the main text block's metadata in IndexedDB.
   */
  static async storeSummary(messageId: string, summary: ConversationSummary): Promise<void> {
    try {
      const blocks = await db.message_blocks.where('messageId').equals(messageId).toArray()
      const mainBlock = blocks.find((b) => b.type === MessageBlockType.MAIN_TEXT) as MainTextMessageBlock | undefined
      if (!mainBlock) {
        logger.warn(`No main text block found for message ${messageId}`)
        return
      }
      await db.message_blocks.update(mainBlock.id, {
        metadata: { ...(mainBlock.metadata ?? {}), conversationSummary: summary }
      })
    } catch (error) {
      logger.error('Failed to store summary:', error as Error)
    }
  }

  /**
   * Retrieve the full content of an assistant message from IndexedDB.
   * Returns combined text from MainText blocks and Tool blocks (no thinking).
   */
  static async getFullContent(messageId: string): Promise<string> {
    try {
      const blocks = await db.message_blocks.where('messageId').equals(messageId).toArray()
      const parts: string[] = []

      for (const block of blocks) {
        if (block.type === MessageBlockType.MAIN_TEXT) {
          const textBlock = block as MainTextMessageBlock
          if (textBlock.content) parts.push(textBlock.content)
        } else if (block.type === MessageBlockType.TOOL) {
          const toolBlock = block as ToolMessageBlock
          const raw = toolBlock.metadata?.rawMcpToolResponse
          if (raw) {
            const toolName = raw.tool?.name ?? 'unknown'
            let resultText = ''
            const resp = raw.response
            if (resp && Array.isArray(resp.content)) {
              resultText = resp.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text)
                .join('\n')
            }
            parts.push(`[Tool: ${toolName}]\n${resultText}`)
          }
        }
      }

      return parts.join('\n\n') || `(No content found for message ${messageId})`
    } catch (error) {
      logger.error('Failed to get full content:', error as Error)
      return `(Error retrieving content for message ${messageId})`
    }
  }

  /**
   * Generate a summary using the quick model.
   */
  static async generateSummary(userMessage: Message, assistantMessage: Message): Promise<ConversationSummary | null> {
    const model = getQuickModel()
    if (!model) {
      logger.warn('No quick model configured for summary generation')
      return null
    }

    const provider = getProviderByModel(model)
    if (!provider) {
      logger.warn('No provider found for quick model')
      return null
    }

    try {
      const state = store.getState()

      const userText =
        Object.values(state.messageBlocks.entities)
          .filter(
            (b): b is MainTextMessageBlock =>
              !!b && b.messageId === userMessage.id && b.type === MessageBlockType.MAIN_TEXT
          )
          .map((b) => b.content)
          .join(' ')
          .trim() || '(no content)'

      const assistantText =
        Object.values(state.messageBlocks.entities)
          .filter(
            (b): b is MainTextMessageBlock =>
              !!b && b.messageId === assistantMessage.id && b.type === MessageBlockType.MAIN_TEXT
          )
          .map((b) => b.content)
          .join(' ')
          .trim() || '(no content)'

      const toolCalls = extractToolInfo(assistantMessage)
      const toolSection =
        toolCalls.length > 0
          ? `\nTools used:\n${toolCalls.map((t) => `- ${t.toolName}: ${t.resultSummary}`).join('\n')}`
          : ''

      const conversation = `User: ${userText}\n\nAssistant: ${assistantText}${toolSection}`

      const providerWithRotatedKey = {
        ...provider,
        apiKey: getRotatedApiKey(provider)
      }
      const AI = new AiProviderNew(model, providerWithRotatedKey)

      const defaultAssistant = getDefaultAssistant()
      const summaryAssistant = {
        ...defaultAssistant,
        settings: {
          ...defaultAssistant.settings,
          reasoning_effort: 'default' as const,
          qwenThinkMode: false
        },
        prompt: SUMMARY_SYSTEM_PROMPT,
        model
      }

      const { getText } = await AI.completions(
        model.id,
        {
          system: SUMMARY_SYSTEM_PROMPT,
          prompt: conversation,
          maxOutputTokens: 600
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
          assistant: summaryAssistant,
          topicId: userMessage.topicId || '',
          callType: 'summary'
        }
      )

      const rawText = getText()?.trim() ?? ''
      if (!rawText) return null

      const jsonStr = rawText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim()
      const parsed = JSON.parse(jsonStr) as ConversationSummary

      // Preserve non-text signals (images / searched sources) that the text-only
      // summarizer would otherwise lose.
      const turnSignals = extractTurnSignals(userMessage, assistantMessage)

      return {
        userQuery: parsed.userQuery ?? '',
        assistantResult: (parsed.assistantResult ?? '') + turnSignals,
        toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [],
        generatedAt: new Date().toISOString(),
        modelId: model.id
      }
    } catch (error) {
      logger.error('Failed to generate summary:', error as Error)
      return null
    }
  }

  /**
   * Trigger summary generation in the background (fire-and-forget).
   */
  static generateAndStoreSummaryAsync(userMessage: Message, assistantMessage: Message): void {
    ConversationSummaryService.generateSummary(userMessage, assistantMessage)
      .then((summary) => {
        if (!summary) return undefined
        return ConversationSummaryService.storeSummary(assistantMessage.id, summary)
      })
      .catch((error) => {
        logger.error('Error in async summary generation:', error as Error)
      })
  }
}
