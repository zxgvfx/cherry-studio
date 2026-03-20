import { ConversationSummaryService, getContextSummaryEnabled } from '@renderer/services/ConversationSummaryService'
import { tool } from 'ai'
import * as z from 'zod'

import type { BuiltinTool } from './BuiltinToolRegistry'

/**
 * Built-in tool that allows the LLM to retrieve the full content
 * of a summarized conversation turn by its message ID.
 */
export function conversationDetailTool() {
  return tool({
    description:
      'Retrieve the full content of a summarized conversation turn. ' +
      'Use this when a conversation summary (marked with [Detail ID: ...]) does not contain enough detail to answer the current question.',
    inputSchema: z.object({
      messageId: z.string().describe('The Detail ID from the conversation summary (e.g. the value after "Detail ID: ")')
    }),
    execute: async ({ messageId }) => {
      const content = await ConversationSummaryService.getFullContent(messageId)
      return content
    }
  })
}

export const conversationDetailBuiltinTool: BuiltinTool = {
  name: 'builtin_conversation_detail',
  isEnabled: (_assistant) => getContextSummaryEnabled(),
  create: (_context) => conversationDetailTool()
}
