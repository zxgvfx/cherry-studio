import { REFERENCE_PROMPT } from '@renderer/config/prompts'
import { processKnowledgeSearch } from '@renderer/services/KnowledgeService'
import type { Assistant, KnowledgeReference } from '@renderer/types'
import type { ExtractResults, KnowledgeExtractResults } from '@renderer/utils/extract'
import { type InferToolInput, type InferToolOutput, tool } from 'ai'
import { isEmpty } from 'lodash'
import * as z from 'zod'

import type { BuiltinTool, BuiltinToolContext } from './BuiltinToolRegistry'

/**
 * 知识库搜索工具
 * 使用预提取关键词，直接使用插件阶段分析的搜索意图，避免重复分析
 */
export const knowledgeSearchTool = (
  assistant: Assistant,
  extractedKeywords: KnowledgeExtractResults,
  topicId: string
) => {
  return tool({
    description: `Knowledge base search tool for retrieving information from user's private knowledge base. This searches your local collection of documents, web content, notes, and other materials you have stored.

This tool has been configured with search parameters based on the conversation context:
- Prepared queries: ${extractedKeywords.question.map((q) => `"${q}"`).join(', ')}
- Query rewrite: "${extractedKeywords.rewrite}"

You can use this tool as-is, or provide additionalContext to refine the search focus within the knowledge base.`,

    inputSchema: z.object({
      additionalContext: z
        .string()
        .optional()
        .describe('Optional additional context or specific focus to enhance the knowledge search')
    }),

    execute: async ({ additionalContext }) => {
      const knowledgeBaseIds = assistant.knowledge_bases?.map((base) => base.id)
      if (isEmpty(knowledgeBaseIds)) {
        return []
      }

      let finalQueries = [...extractedKeywords.question]
      let finalRewrite = extractedKeywords.rewrite

      if (additionalContext?.trim()) {
        finalQueries = [additionalContext.trim()]
        finalRewrite = additionalContext.trim()
      }

      if (finalQueries[0] === 'not_needed') {
        return []
      }

      const searchCriteria = {
        question: finalQueries,
        rewrite: finalRewrite
      }

      // 构建 ExtractResults 对象
      const extractResults: ExtractResults = {
        websearch: undefined,
        knowledge: searchCriteria
      }

      // 执行知识库搜索
      const knowledgeReferences = await processKnowledgeSearch(extractResults, knowledgeBaseIds, topicId)
      const knowledgeReferencesData = knowledgeReferences.map((ref: KnowledgeReference) => ({
        id: ref.id,
        content: ref.content,
        sourceUrl: ref.sourceUrl,
        type: ref.type,
        file: ref.file,
        metadata: ref.metadata
      }))

      // TODO 在工具函数中添加搜索缓存机制
      // const searchCacheKey = `${topicId}-${JSON.stringify(finalQueries)}`

      // 返回结果
      return knowledgeReferencesData
    },
    toModelOutput: ({ output: results }) => {
      let summary = 'No search needed based on the query analysis.'
      if (results.length > 0) {
        summary = `Found ${results.length} relevant sources. Use [number] format to cite specific information.`
      }
      const referenceContent = `\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\``
      const fullInstructions = REFERENCE_PROMPT.replace(
        '{question}',
        "Based on the knowledge references, please answer the user's question with proper citations."
      ).replace('{references}', referenceContent)

      return {
        type: 'content',
        value: [
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
      }
    }
  })
}

/**
 * LLM 驱动的知识库搜索工具
 * 无需预分析，由主 LLM 直接提供搜索查询
 * 工具描述中包含知识库大纲，帮助 LLM 判断是否需要搜索
 */
export const knowledgeSearchToolDirect = (assistant: Assistant, topicId: string) => {
  const kbOutline =
    assistant.knowledge_bases
      ?.map((kb) => `- ${kb.name}${kb.description ? `: ${kb.description}` : ''} (${kb.documentCount ?? '?'} docs)`)
      .join('\n') || ''

  return tool({
    description: `Search your private knowledge base for relevant documents and information.

Available knowledge bases:
${kbOutline}

Use this tool when the user's question may be answered by stored documents, notes, or web content in the knowledge base.`,

    inputSchema: z.object({
      query: z.string().describe('Search query for the knowledge base')
    }),

    execute: async ({ query }) => {
      const knowledgeBaseIds = assistant.knowledge_bases?.map((base) => base.id)
      if (isEmpty(knowledgeBaseIds)) {
        return []
      }

      const extractResults: ExtractResults = {
        websearch: undefined,
        knowledge: { question: [query], rewrite: query }
      }

      const knowledgeReferences = await processKnowledgeSearch(extractResults, knowledgeBaseIds, topicId)
      return knowledgeReferences.map((ref: KnowledgeReference) => ({
        id: ref.id,
        content: ref.content,
        sourceUrl: ref.sourceUrl,
        type: ref.type,
        file: ref.file,
        metadata: ref.metadata
      }))
    },
    toModelOutput: ({ output: results }) => {
      let summary = 'No relevant documents found.'
      if (results.length > 0) {
        summary = `Found ${results.length} relevant sources. Use [number] format to cite specific information.`
      }
      const referenceContent = `\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\``
      const fullInstructions = REFERENCE_PROMPT.replace(
        '{question}',
        "Based on the knowledge references, please answer the user's question with proper citations."
      ).replace('{references}', referenceContent)

      return {
        type: 'content',
        value: [
          { type: 'text', text: summary },
          { type: 'text', text: fullInstructions }
        ]
      }
    }
  })
}

export const knowledgeBuiltinTool: BuiltinTool = {
  name: 'builtin_knowledge_search',
  isEnabled: (assistant) => !isEmpty(assistant.knowledge_bases),
  create: (context: BuiltinToolContext) => {
    if (context.intentKeywords) {
      const keywords: KnowledgeExtractResults =
        context.intentKeywords.question && context.intentKeywords.question[0] !== 'not_needed'
          ? {
              question: context.intentKeywords.question,
              rewrite: context.intentKeywords.rewrite || context.userContent
            }
          : { question: [context.userContent], rewrite: context.userContent }
      return knowledgeSearchTool(context.assistant, keywords, context.topicId)
    }
    return knowledgeSearchToolDirect(context.assistant, context.topicId)
  }
}

export type KnowledgeSearchToolInput = InferToolInput<ReturnType<typeof knowledgeSearchToolDirect>>
export type KnowledgeSearchToolOutput = InferToolOutput<ReturnType<typeof knowledgeSearchToolDirect>>

export default knowledgeSearchTool
