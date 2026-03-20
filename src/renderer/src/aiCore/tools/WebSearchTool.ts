import { REFERENCE_PROMPT } from '@renderer/config/prompts'
import WebSearchService from '@renderer/services/WebSearchService'
import type { WebSearchProvider, WebSearchProviderResponse } from '@renderer/types'
import type { ExtractResults } from '@renderer/utils/extract'
import { type InferToolInput, type InferToolOutput, tool } from 'ai'
import * as z from 'zod'

import type { BuiltinTool, BuiltinToolContext } from './BuiltinToolRegistry'

/**
 * 使用预提取关键词的网络搜索工具
 * 这个工具直接使用插件阶段分析的搜索意图，避免重复分析
 */
export const webSearchToolWithPreExtractedKeywords = (
  webSearchProviderId: WebSearchProvider['id'],
  extractedKeywords: {
    question: string[]
    links?: string[]
  },
  requestId: string
) => {
  const webSearchProvider = WebSearchService.getWebSearchProvider(webSearchProviderId)

  return tool({
    description: `Web search tool for finding current information, news, and real-time data from the internet.

This tool has been configured with search parameters based on the conversation context:
- Prepared queries: ${extractedKeywords.question.map((q) => `"${q}"`).join(', ')}${
      extractedKeywords.links?.length
        ? `
- Relevant URLs: ${extractedKeywords.links.join(', ')}`
        : ''
    }

You can use this tool as-is to search with the prepared queries, or provide additionalContext to refine or replace the search terms.`,

    inputSchema: z.object({
      additionalContext: z
        .string()
        .optional()
        .describe('Optional additional context, keywords, or specific focus to enhance the search')
    }),

    execute: async ({ additionalContext }) => {
      let finalQueries = [...extractedKeywords.question]

      if (additionalContext?.trim()) {
        // 如果大模型提供了额外上下文，使用更具体的描述
        const cleanContext = additionalContext.trim()
        if (cleanContext) {
          finalQueries = [cleanContext]
        }
      }

      let searchResults: WebSearchProviderResponse = {
        query: '',
        results: []
      }
      // 检查是否需要搜索
      if (finalQueries[0] === 'not_needed') {
        return searchResults
      }

      // 构建 ExtractResults 结构用于 processWebsearch
      const extractResults: ExtractResults = {
        websearch: {
          question: finalQueries,
          links: extractedKeywords.links
        }
      }
      searchResults = await WebSearchService.processWebsearch(webSearchProvider!, extractResults, requestId)

      return searchResults
    },
    toModelOutput: ({ output: results }) => {
      let summary = 'No search needed based on the query analysis.'
      if (results.query && results.results.length > 0) {
        summary = `Found ${results.results.length} relevant sources. Use [number] format to cite specific information.`
      }

      const imageUrlPattern = /!\[.*?\]\((https?:\/\/[^)]+)\)/g
      const allImageUrls: string[] = []
      const citationData = results.results.map((result, index) => {
        const imgs: string[] = []
        let match: RegExpExecArray | null
        imageUrlPattern.lastIndex = 0
        while ((match = imageUrlPattern.exec(result.content || '')) !== null) {
          imgs.push(match[1])
        }
        allImageUrls.push(...imgs)
        return {
          number: index + 1,
          title: result.title,
          content: result.content,
          url: result.url,
          ...(imgs.length > 0 ? { images: imgs } : {})
        }
      })

      const hasImages = allImageUrls.length > 0

      const referenceContent = `\`\`\`json\n${JSON.stringify(citationData, null, 2)}\n\`\`\``
      const fullInstructions = REFERENCE_PROMPT.replace(
        '{question}',
        "Based on the search results, please answer the user's question with proper citations."
      ).replace('{references}', referenceContent)

      const value: Array<{ type: 'text'; text: string }> = [
        {
          type: 'text',
          text: 'This tool searches for relevant information and formats results for easy citation. The returned sources should be cited using [1], [2], etc. format in your response.'
        },
        {
          type: 'text',
          text: summary
        },
        {
          type: 'text',
          text: fullInstructions
        }
      ]

      if (hasImages) {
        value.push({
          type: 'text',
          text:
            'IMPORTANT: The search results contain real image URLs in the "images" field. ' +
            'When the user asks for reference images/photos/pictures, you MUST display them using markdown image syntax: ![description](url). ' +
            'Show the most relevant images directly in your response. Do NOT just provide text links — render images inline.'
        })
      }

      return {
        type: 'content',
        value
      }
    }
  })
}

// export const webSearchToolWithExtraction = (
//   webSearchProviderId: WebSearchProvider['id'],
//   requestId: string,
//   assistant: Assistant
// ) => {
//   const webSearchService = WebSearchService.getInstance(webSearchProviderId)

//   return tool({
//     name: 'web_search_with_extraction',
//     description: 'Search the web for information with automatic keyword extraction from user messages',
//     inputSchema: z.object({
//       userMessage: z.object({
//         content: z.string().describe('The main content of the message'),
//         role: z.enum(['user', 'assistant', 'system']).describe('Message role')
//       }),
//       lastAnswer: z.object({
//         content: z.string().describe('The main content of the message'),
//         role: z.enum(['user', 'assistant', 'system']).describe('Message role')
//       })
//     }),
//     outputSchema: z.object({
//       extractedKeywords: z.object({
//         question: z.array(z.string()),
//         links: z.array(z.string()).optional()
//       }),
//       searchResults: z.array(
//         z.object({
//           query: z.string(),
//           results: WebSearchProviderResult
//         })
//       )
//     }),
//     execute: async ({ userMessage, lastAnswer }) => {
//       const lastUserMessage: Message = {
//         id: requestId,
//         role: userMessage.role,
//         assistantId: assistant.id,
//         topicId: 'temp',
//         createdAt: new Date().toISOString(),
//         status: UserMessageStatus.SUCCESS,
//         blocks: []
//       }

//       const lastAnswerMessage: Message | undefined = lastAnswer
//         ? {
//             id: requestId + '_answer',
//             role: lastAnswer.role,
//             assistantId: assistant.id,
//             topicId: 'temp',
//             createdAt: new Date().toISOString(),
//             status: UserMessageStatus.SUCCESS,
//             blocks: []
//           }
//         : undefined

//       const extractResults = await extractSearchKeywords(lastUserMessage, assistant, {
//         shouldWebSearch: true,
//         shouldKnowledgeSearch: false,
//         lastAnswer: lastAnswerMessage
//       })

//       if (!extractResults?.websearch || extractResults.websearch.question[0] === 'not_needed') {
//         return 'No search needed or extraction failed'
//       }

//       const searchQueries = extractResults.websearch.question
//       const searchResults: Array<{ query: string; results: any }> = []

//       for (const query of searchQueries) {
//         // 构建单个查询的ExtractResults结构
//         const queryExtractResults: ExtractResults = {
//           websearch: {
//             question: [query],
//             links: extractResults.websearch.links
//           }
//         }
//         const response = await webSearchService.processWebsearch(queryExtractResults, requestId)
//         searchResults.push({
//           query,
//           results: response
//         })
//       }

//       return { extractedKeywords: extractResults.websearch, searchResults }
//     }
//   })
// }

/**
 * LLM 驱动的网络搜索工具
 * 无需预分析，由主 LLM 直接提供搜索查询
 */
export const webSearchToolDirect = (webSearchProviderId: WebSearchProvider['id'], requestId: string) => {
  const webSearchProvider = WebSearchService.getWebSearchProvider(webSearchProviderId)

  return tool({
    description:
      'Search the web for current information, news, and real-time data. ' +
      'Use this when you need up-to-date information or facts not in your training data. ' +
      'You can provide multiple search queries to get comprehensive results from different angles in a single call. ' +
      "Tips: use concise, keyword-rich queries; try both English and the user's language for better coverage.",

    inputSchema: z.object({
      queries: z
        .array(z.string())
        .min(1)
        .max(3)
        .describe(
          'Search queries to execute (1-3). Use multiple queries with different angles for better coverage. ' +
            'Example: ["GitHub most starred agent 2026", "AI agent framework GitHub stars ranking"]'
        ),
      urls: z.array(z.string()).optional().describe('Specific URLs to fetch and summarize')
    }),

    execute: async ({ queries, urls }) => {
      const extractResults: ExtractResults = {
        websearch: {
          question: queries,
          links: urls
        }
      }
      return await WebSearchService.processWebsearch(webSearchProvider!, extractResults, requestId)
    },
    toModelOutput: ({ output: results }) => {
      let summary = 'No results found.'
      if (results.query && results.results.length > 0) {
        summary = `Found ${results.results.length} relevant sources. Use [number] format to cite specific information.`
      }

      const imageUrlPattern = /!\[.*?\]\((https?:\/\/[^)]+)\)/g
      const allImageUrls: string[] = []
      const citationData = results.results.map((result, index) => {
        const imgs: string[] = []
        let match: RegExpExecArray | null
        imageUrlPattern.lastIndex = 0
        while ((match = imageUrlPattern.exec(result.content || '')) !== null) {
          imgs.push(match[1])
        }
        allImageUrls.push(...imgs)
        return {
          number: index + 1,
          title: result.title,
          content: result.content,
          url: result.url,
          ...(imgs.length > 0 ? { images: imgs } : {})
        }
      })

      const hasImages = allImageUrls.length > 0

      const referenceContent = `\`\`\`json\n${JSON.stringify(citationData, null, 2)}\n\`\`\``
      const fullInstructions = REFERENCE_PROMPT.replace(
        '{question}',
        "Based on the search results, please answer the user's question with proper citations."
      ).replace('{references}', referenceContent)

      const value: Array<{ type: 'text'; text: string }> = [
        { type: 'text', text: summary },
        { type: 'text', text: fullInstructions }
      ]

      if (hasImages) {
        value.push({
          type: 'text',
          text:
            'IMPORTANT: The search results contain real image URLs in the "images" field. ' +
            'When the user asks for reference images/photos/pictures, you MUST display them using markdown image syntax: ![description](url). ' +
            'Show the most relevant images directly in your response. Do NOT just provide text links — render images inline.'
        })
      }

      return { type: 'content', value }
    }
  })
}

export const webSearchBuiltinTool: BuiltinTool = {
  name: 'builtin_web_search',
  isEnabled: (assistant) => !!assistant.webSearchProviderId,
  create: (context: BuiltinToolContext) => {
    if (context.intentKeywords) {
      const keywords = { question: context.intentKeywords.question, links: context.intentKeywords.links }
      if (keywords.question[0] === 'not_needed') {
        keywords.question = [context.userContent]
      }
      return webSearchToolWithPreExtractedKeywords(context.assistant.webSearchProviderId!, keywords, context.requestId)
    }
    return webSearchToolDirect(context.assistant.webSearchProviderId!, context.requestId)
  }
}

export type WebSearchToolOutput = InferToolOutput<ReturnType<typeof webSearchToolDirect>>
export type WebSearchToolInput = InferToolInput<ReturnType<typeof webSearchToolDirect>>
