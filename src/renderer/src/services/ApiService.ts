/**
 * 职责：提供原子化的、无状态的API调用函数
 */
import { loggerService } from '@logger'
import { buildStreamTextParams } from '@renderer/aiCore/prepareParams'
import type { AiSdkMiddlewareConfig } from '@renderer/aiCore/types/middlewareConfig'
import { buildProviderOptions } from '@renderer/aiCore/utils/options'
import { isDedicatedImageGenerationModel, isEmbeddingModel, isFunctionCallingModel, isTextChatModel } from '@renderer/config/models'
import { isGenerate3DModel } from '@renderer/config/models/vision'
import { getStoreSetting } from '@renderer/hooks/useSettings'
import i18n from '@renderer/i18n'
import store from '@renderer/store'
import { hubMCPServer } from '@renderer/store/mcp'
import type { Assistant, MCPServer, MCPTool, Model, Provider } from '@renderer/types'
import { type FetchChatCompletionParams, getEffectiveMcpMode, isSystemProvider } from '@renderer/types'
import type { StreamTextParams } from '@renderer/types/aiCoreTypes'
import { type Chunk, ChunkType } from '@renderer/types/chunk'
import type { Message, ResponseError } from '@renderer/types/newMessage'
import { removeSpecialCharactersForTopicName, uuid } from '@renderer/utils'
import { abortCompletion, readyToAbort } from '@renderer/utils/abortController'
import { trackTokenUsage } from '@renderer/utils/analytics'
import { isToolUseModeFunction } from '@renderer/utils/assistant'
import { getErrorMessage, isAbortError } from '@renderer/utils/error'
import { purifyMarkdownImages } from '@renderer/utils/markdown'
import { isPromptToolUse, isSupportedToolUse } from '@renderer/utils/mcp-tools'
import { findFileBlocks, findImageBlocks, getMainTextContent } from '@renderer/utils/messageUtils/find'
import { containsSupportedVariables, replacePromptVariables } from '@renderer/utils/prompt'
import { NOT_SUPPORT_API_KEY_PROVIDER_TYPES, NOT_SUPPORT_API_KEY_PROVIDERS } from '@renderer/utils/provider'
import { isEmpty, takeRight } from 'lodash'

import type { ModernAiProviderConfig } from '../aiCore/index_new'
import AiProviderNew from '../aiCore/index_new'
import {
  // getAssistantProvider,
  // getAssistantSettings,
  getDefaultAssistant,
  getDefaultModel,
  getProviderByModel,
  getQuickModel
} from './AssistantService'
import { ConversationService } from './ConversationService'
import { injectOrchestrationInstructions } from './OrchestrationPreprocessor'
import { generateUnifiedImage } from './ImageGenerationService'
import { getRotatedApiKey } from './providerKey'
import type { BlockManager } from './messageStreaming'
import type { StreamProcessorCallbacks } from './StreamProcessingService'
// import { processKnowledgeSearch } from './KnowledgeService'
// import {
//   filterContextMessages,
//   filterEmptyMessages,
//   filterUsefulMessages,
//   filterUserRoleStartMessages
// } from './MessagesService'
// import WebSearchService from './WebSearchService'

// FIXME: 这里太多重复逻辑，需要重构

const logger = loggerService.withContext('ApiService')

/**
 * Get the MCP servers to use based on the assistant's MCP mode.
 */
export function getMcpServersForAssistant(assistant: Assistant): MCPServer[] {
  const mode = getEffectiveMcpMode(assistant)
  const allMcpServers = store.getState().mcp.servers || []
  const activedMcpServers = allMcpServers.filter((s) => s.isActive)

  switch (mode) {
    case 'disabled':
      return []
    case 'auto':
      return [hubMCPServer]
    case 'manual': {
      const assistantMcpServers = assistant.mcpServers || []
      return activedMcpServers.filter((server) => assistantMcpServers.some((s) => s.id === server.id))
    }
    default:
      return []
  }
}

export async function fetchAllActiveServerTools(): Promise<MCPTool[]> {
  const allMcpServers = store.getState().mcp.servers || []
  const activedMcpServers = allMcpServers.filter((s) => s.isActive)

  if (activedMcpServers.length === 0) {
    return []
  }

  try {
    const toolPromises = activedMcpServers.map(async (mcpServer: MCPServer) => {
      try {
        const tools = await window.api.mcp.listTools(mcpServer)
        return tools.filter((tool: any) => !mcpServer.disabledTools?.includes(tool.name))
      } catch (error) {
        logger.error(`Error fetching tools from MCP server ${mcpServer.name}:`, error as Error)
        return []
      }
    })
    const results = await Promise.allSettled(toolPromises)
    return results
      .filter((result): result is PromiseFulfilledResult<MCPTool[]> => result.status === 'fulfilled')
      .map((result) => result.value)
      .flat()
  } catch (toolError) {
    logger.error('Error fetching all active server tools:', toolError as Error)
    return []
  }
}

export async function fetchMcpTools(assistant: Assistant) {
  let mcpTools: MCPTool[] = []
  const enabledMCPs = getMcpServersForAssistant(assistant)

  if (enabledMCPs && enabledMCPs.length > 0) {
    try {
      const toolPromises = enabledMCPs.map(async (mcpServer: MCPServer) => {
        try {
          const tools = await window.api.mcp.listTools(mcpServer)
          return tools.filter((tool: any) => !mcpServer.disabledTools?.includes(tool.name))
        } catch (error) {
          logger.error(`Error fetching tools from MCP server ${mcpServer.name}:`, error as Error)
          return []
        }
      })
      const results = await Promise.allSettled(toolPromises)
      mcpTools = results
        .filter((result): result is PromiseFulfilledResult<MCPTool[]> => result.status === 'fulfilled')
        .map((result) => result.value)
        .flat()
    } catch (toolError) {
      logger.error('Error fetching MCP tools:', toolError as Error)
    }
  }

  // Auto 模式下确保 Hub 核心元工具存在（search/call_tool/get_tool_schema）
  const hasHub = enabledMCPs?.some((server) => server.id === hubMCPServer.id)
  if (hasHub) {
    const hasSearch = mcpTools.some((tool) => tool.name === 'search')
    const hasCallTool = mcpTools.some((tool) => tool.name === 'call_tool')
    const hasGetSchema = mcpTools.some((tool) => tool.name === 'get_tool_schema')

    if (!hasSearch) {
      mcpTools.push({
        id: 'search',
        name: 'search',
        description: 'Discover available tools by keyword. Use * to list all.',
        serverId: hubMCPServer.id,
        serverName: hubMCPServer.name,
        type: 'mcp',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search keywords, comma-separated.' }
          },
          required: ['query']
        }
      })
    }

    if (!hasCallTool) {
      mcpTools.push({
        id: 'call_tool',
        name: 'call_tool',
        description: 'Execute any available tool by name.',
        serverId: hubMCPServer.id,
        serverName: hubMCPServer.name,
        type: 'mcp',
        inputSchema: {
          type: 'object',
          properties: {
            tool_name: { type: 'string', description: 'The tool to execute' },
            arguments: { type: 'object', description: 'Tool arguments as key-value pairs' }
          },
          required: ['tool_name']
        }
      })
    }

    if (!hasGetSchema) {
      mcpTools.push({
        id: 'get_tool_schema',
        name: 'get_tool_schema',
        description: 'Get full parameter schema for a specific tool.',
        serverId: hubMCPServer.id,
        serverName: hubMCPServer.name,
        type: 'mcp',
        inputSchema: {
          type: 'object',
          properties: {
            tool_name: { type: 'string', description: 'The exact tool name' }
          },
          required: ['tool_name']
        }
      })
    }
  }

  return mcpTools
}

/**
 * 将用户消息转换为LLM可以理解的格式并发送请求
 * @param request - 包含消息内容和助手信息的请求对象
 * @param onChunkReceived - 接收流式响应数据的回调函数
 */
// 目前先按照函数来写,后续如果有需要到class的地方就改回来
export async function transformMessagesAndFetch(
  request: {
    messages: Message[]
    assistant: Assistant
    blockManager: BlockManager
    assistantMsgId: string
    callbacks: StreamProcessorCallbacks
    topicId?: string // 添加 topicId 用于 trace
    allowedTools?: string[]
    options: {
      signal?: AbortSignal
      timeout?: number
      headers?: Record<string, string>
    }
  },
  onChunkReceived: (chunk: Chunk) => void
) {
  const { messages, assistant } = request

  try {
    const { modelMessages, uiMessages } = await ConversationService.prepareMessagesForModel(messages, assistant)

    // replace prompt variables
    assistant.prompt = await replacePromptVariables(assistant.prompt, assistant.model?.name)

    // inject orchestration instructions for /tool triggers and @model mentions
    injectOrchestrationInstructions(modelMessages, uiMessages)

    await fetchChatCompletion({
      messages: modelMessages,
      assistant: assistant,
      topicId: request.topicId,
      allowedTools: request.allowedTools,
      requestOptions: request.options,
      uiMessages,
      onChunkReceived
    })
  } catch (error: any) {
    onChunkReceived({ type: ChunkType.ERROR, error })
  }
}

export async function fetchChatCompletion({
  messages,
  prompt,
  assistant,
  requestOptions,
  onChunkReceived,
  topicId,
  uiMessages,
  allowedTools
}: FetchChatCompletionParams) {
  logger.info('fetchChatCompletion called with detailed context', {
    messageCount: messages?.length || 0,
    prompt: prompt,
    assistantId: assistant.id,
    topicId,
    hasTopicId: !!topicId,
    modelId: assistant.model?.id,
    modelName: assistant.model?.name
  })

  if (isGenerate3DModel(assistant.model)) {
    await handle3DGeneration(assistant, onChunkReceived, requestOptions, uiMessages)
    return
  }

  // Get base provider and apply API key rotation
  // NOTE: Shallow copy is intentional. Provider objects are not mutated by downstream code.
  // Nested properties (if any) are never modified after creation.
  const baseProvider = getProviderByModel(assistant.model || getDefaultModel())
  const providerWithRotatedKey = {
    ...baseProvider,
    apiKey: getRotatedApiKey(baseProvider)
  }

  const AI = new AiProviderNew(assistant.model || getDefaultModel(), providerWithRotatedKey)
  const provider = AI.getActualProvider()

  const mcpTools: MCPTool[] = []
  onChunkReceived({ type: ChunkType.LLM_RESPONSE_CREATED })

  // 仅在当前助手/模型支持工具使用时才拉取 MCP 工具。
  // 图片模型等不支持工具使用的场景，不应触发 listTools。
  if ((isPromptToolUse(assistant) || isSupportedToolUse(assistant)) && isTextChatModel(assistant.model)) {
    mcpTools.push(...(await fetchMcpTools(assistant)))
  }
  if (prompt) {
    messages = [
      {
        role: 'user',
        content: prompt
      }
    ]
  }

  // 使用 transformParameters 模块构建参数
  const {
    params: aiSdkParams,
    modelId,
    capabilities,
    webSearchPluginConfig
  } = await buildStreamTextParams(messages, assistant, provider, {
    mcpTools: mcpTools,
    allowedTools,
    webSearchProviderId: assistant.webSearchProviderId,
    requestOptions
  })

  // Safely fallback to prompt tool use when function calling is not supported by model.
  const usePromptToolUse =
    isPromptToolUse(assistant) || (isToolUseModeFunction(assistant) && !isFunctionCallingModel(assistant.model))

  const mcpMode = getEffectiveMcpMode(assistant)
  const middlewareConfig: AiSdkMiddlewareConfig = {
    streamOutput: assistant.settings?.streamOutput ?? true,
    onChunk: onChunkReceived,
    enableReasoning: capabilities.enableReasoning,
    isPromptToolUse: usePromptToolUse,
    isSupportedToolUse: isSupportedToolUse(assistant),
    isImageGenerationEndpoint: isDedicatedImageGenerationModel(assistant.model || getDefaultModel())
      && (!assistant.model?.endpoint_type || assistant.model.endpoint_type === 'image-generation'),
    webSearchPluginConfig: webSearchPluginConfig,
    enableWebSearch: capabilities.enableWebSearch,
    enableGenerateImage: capabilities.enableGenerateImage,
    enableUrlContext: capabilities.enableUrlContext,
    mcpMode,
    mcpTools,
    uiMessages,
    knowledgeRecognition: assistant.knowledgeRecognition
  }

  // --- Call AI Completions ---
  // 设置全局变量，用于 Qt 环境下的 window.fetch 拦截器获取当前 assistant 配置
  // 这样可以将 webSearchProviderId 注入到请求体中
  ;(window as any).__CHERRY_CURRENT_ASSISTANT__ = {
    id: assistant.id,
    webSearchProviderId: assistant.webSearchProviderId,
    enableWebSearch: assistant.enableWebSearch
  }

  const imageActionHandler = async (prompt: string) =>
    generateUnifiedImage(prompt, {
      modelId: assistant.model?.id
    })

  try {
    await AI.completions(modelId, aiSdkParams, {
      ...middlewareConfig,
      assistant,
      topicId,
      callType: 'chat',
      uiMessages,
      imageActionHandler
    })
  } finally {
    // 清理全局变量
    ;(window as any).__CHERRY_CURRENT_ASSISTANT__ = undefined
  }
}

export async function fetchMessagesSummary({
  messages,
  assistant
}: {
  messages: Message[]
  assistant: Assistant
}): Promise<{ text: string | null; error?: string }> {
  let prompt = (getStoreSetting('topicNamingPrompt') as string) || i18n.t('prompts.title')
  const model = getQuickModel() || assistant?.model || getDefaultModel()

  if (prompt && containsSupportedVariables(prompt)) {
    prompt = await replacePromptVariables(prompt, model.name)
  }

  // 总结上下文总是取最后5条消息
  const contextMessages = takeRight(messages, 5)
  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    return { text: null, error: i18n.t('error.no_api_key') }
  }

  // Apply API key rotation
  // NOTE: Shallow copy is intentional. Provider objects are not mutated by downstream code.
  // Nested properties (if any) are never modified after creation.
  const providerWithRotatedKey = {
    ...provider,
    apiKey: getRotatedApiKey(provider)
  }

  const AI = new AiProviderNew(model, providerWithRotatedKey)
  const actualProvider = AI.getActualProvider()

  const topicId = messages?.find((message) => message.topicId)?.topicId || ''

  // LLM对多条消息的总结有问题，用单条结构化的消息表示会话内容会更好
  const structredMessages = contextMessages.map((message) => {
    const structredMessage = {
      role: message.role,
      mainText: purifyMarkdownImages(getMainTextContent(message))
    }

    // 让LLM知道消息中包含的文件和图片，但只提供文件名
    const fileBlocks = findFileBlocks(message)
    const imageBlocks = findImageBlocks(message)
    let fileList: Array<string> = []
    if (fileBlocks.length > 0) {
      fileList = fileBlocks.map((fileBlock) => fileBlock.file.origin_name)
    }
    if (imageBlocks.length > 0) {
      fileList = [
        ...fileList,
        ...imageBlocks.filter((b) => b.file).map((b) => `[image] ${b.file!.origin_name || b.file!.name}`)
      ]
    }
    return {
      ...structredMessage,
      files: fileList.length > 0 ? fileList : undefined
    }
  })
  const conversation = JSON.stringify(structredMessages)

  // // 复制 assistant 对象，并强制关闭思考预算
  // const summaryAssistant = {
  //   ...assistant,
  //   settings: {
  //     ...assistant.settings,
  //     reasoning_effort: undefined,
  //     qwenThinkMode: false
  //   }
  // }
  const summaryAssistant = {
    ...assistant,
    settings: {
      ...assistant.settings,
      reasoning_effort: undefined,
      qwenThinkMode: false
    },
    prompt,
    model
  }

  const { providerOptions, standardParams } = buildProviderOptions(summaryAssistant, model, actualProvider, {
    enableReasoning: false,
    enableWebSearch: false,
    enableGenerateImage: false
  })

  const llmMessages = {
    system: prompt,
    prompt: conversation,
    providerOptions,
    ...standardParams
  }

  const middlewareConfig: AiSdkMiddlewareConfig = {
    streamOutput: false,
    enableReasoning: false,
    isPromptToolUse: false,
    isSupportedToolUse: false,
    isImageGenerationEndpoint: false,
    enableWebSearch: false,
    enableGenerateImage: false,
    enableUrlContext: false,
    mcpTools: []
  }
  try {
    // 从 messages 中找到有 traceId 的助手消息，用于绑定现有 trace
    const messageWithTrace = messages.find((m) => m.role === 'assistant' && m.traceId)

    if (messageWithTrace && messageWithTrace.traceId) {
      // 导入并调用 appendTrace 来绑定现有 trace，传入summary使用的模型名
      const { appendTrace } = await import('@renderer/services/SpanManagerService')
      await appendTrace({ topicId, traceId: messageWithTrace.traceId, model })
    }

    const { getText, usage } = await AI.completions(model.id, llmMessages, {
      ...middlewareConfig,
      assistant: summaryAssistant,
      topicId,
      callType: 'summary'
    })

    trackTokenUsage({ usage, model })

    const text = getText()
    const result = removeSpecialCharactersForTopicName(text)
    return result ? { text: result } : { text: null, error: i18n.t('error.no_response') }
  } catch (error: any) {
    return { text: null, error: getErrorMessage(error) }
  }
}

export async function fetchNoteSummary({ content, assistant }: { content: string; assistant?: Assistant }) {
  let prompt = (getStoreSetting('topicNamingPrompt') as string) || i18n.t('prompts.title')
  const resolvedAssistant = assistant || getDefaultAssistant()
  const model = getQuickModel() || resolvedAssistant.model || getDefaultModel()

  if (prompt && containsSupportedVariables(prompt)) {
    prompt = await replacePromptVariables(prompt, model.name)
  }

  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    return null
  }

  // Apply API key rotation
  // NOTE: Shallow copy is intentional. Provider objects are not mutated by downstream code.
  // Nested properties (if any) are never modified after creation.
  const providerWithRotatedKey = {
    ...provider,
    apiKey: getRotatedApiKey(provider)
  }

  const AI = new AiProviderNew(model, providerWithRotatedKey)

  // only 2000 char and no images
  const truncatedContent = content.substring(0, 2000)
  const purifiedContent = purifyMarkdownImages(truncatedContent)

  const summaryAssistant = {
    ...resolvedAssistant,
    settings: {
      ...resolvedAssistant.settings,
      reasoning_effort: undefined,
      qwenThinkMode: false
    },
    prompt,
    model
  }

  const llmMessages = {
    system: prompt,
    prompt: purifiedContent
  }

  const middlewareConfig: AiSdkMiddlewareConfig = {
    streamOutput: false,
    enableReasoning: false,
    isPromptToolUse: false,
    isSupportedToolUse: false,
    isImageGenerationEndpoint: false,
    enableWebSearch: false,
    enableGenerateImage: false,
    enableUrlContext: false,
    mcpTools: []
  }

  try {
    const { getText, usage } = await AI.completions(model.id, llmMessages, {
      ...middlewareConfig,
      assistant: summaryAssistant,
      callType: 'summary'
    })

    trackTokenUsage({ usage, model })

    const text = getText()
    return removeSpecialCharactersForTopicName(text) || null
  } catch (error: any) {
    return null
  }
}

// export async function fetchSearchSummary({ messages, assistant }: { messages: Message[]; assistant: Assistant }) {
//   const model = getQuickModel() || assistant.model || getDefaultModel()
//   const provider = getProviderByModel(model)

//   if (!hasApiKey(provider)) {
//     return null
//   }

//   const topicId = messages?.find((message) => message.topicId)?.topicId || undefined

//   const AI = new AiProvider(provider)

//   const params: CompletionsParams = {
//     callType: 'search',
//     messages: messages,
//     assistant,
//     streamOutput: false,
//     topicId
//   }

//   return await AI.completionsForTrace(params)
// }

export async function fetchGenerate({
  prompt,
  content,
  model
}: {
  prompt: string
  content: string
  model?: Model
}): Promise<string> {
  if (!model) {
    model = getDefaultModel()
  }
  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    return ''
  }

  // Apply API key rotation
  // NOTE: Shallow copy is intentional. Provider objects are not mutated by downstream code.
  // Nested properties (if any) are never modified after creation.
  const providerWithRotatedKey = {
    ...provider,
    apiKey: getRotatedApiKey(provider)
  }

  const AI = new AiProviderNew(model, providerWithRotatedKey)

  const assistant = getDefaultAssistant()
  assistant.model = model
  assistant.prompt = prompt

  // const params: CompletionsParams = {
  //   callType: 'generate',
  //   messages: content,
  //   assistant,
  //   streamOutput: false
  // }

  const middlewareConfig: AiSdkMiddlewareConfig = {
    streamOutput: assistant.settings?.streamOutput ?? false,
    enableReasoning: false,
    isPromptToolUse: false,
    isSupportedToolUse: false,
    isImageGenerationEndpoint: false,
    enableWebSearch: false,
    enableGenerateImage: false,
    enableUrlContext: false
  }

  try {
    const result = await AI.completions(
      model.id,
      {
        system: prompt,
        prompt: content
      },
      {
        ...middlewareConfig,
        assistant,
        callType: 'generate'
      }
    )

    trackTokenUsage({ usage: result.usage, model })

    return result.getText() || ''
  } catch (error: any) {
    return ''
  }
}

export function hasApiKey(provider: Provider) {
  if (!provider) return false
  if (provider.id === 'cherryai') return true
  if (
    (isSystemProvider(provider) && NOT_SUPPORT_API_KEY_PROVIDERS.includes(provider.id)) ||
    NOT_SUPPORT_API_KEY_PROVIDER_TYPES.includes(provider.type)
  )
    return true
  return !isEmpty(provider.apiKey)
}

/**
 * Get rotated API key for providers that support multiple keys
 * Returns empty string for providers that don't require API keys
 */
export async function fetchModels(provider: Provider): Promise<Model[]> {
  // Apply API key rotation
  // NOTE: Shallow copy is intentional. Provider objects are not mutated by downstream code.
  // Nested properties (if any) are never modified after creation.
  const providerWithRotatedKey = {
    ...provider,
    apiKey: getRotatedApiKey(provider)
  }

  const AI = new AiProviderNew(providerWithRotatedKey)

  try {
    return await AI.models()
  } catch (error) {
    logger.error('Failed to fetch models from provider', {
      providerId: provider.id,
      providerName: provider.name,
      error: error as Error
    })
    return []
  }
}

export function checkApiProvider(provider: Provider): void {
  const isExcludedProvider =
    (isSystemProvider(provider) && NOT_SUPPORT_API_KEY_PROVIDERS.includes(provider.id)) ||
    NOT_SUPPORT_API_KEY_PROVIDER_TYPES.includes(provider.type)

  if (!isExcludedProvider) {
    if (!provider.apiKey) {
      window.toast.error(i18n.t('message.error.enter.api.label'))
      throw new Error(i18n.t('message.error.enter.api.label'))
    }
  }

  if (!provider.apiHost && provider.type !== 'vertexai') {
    window.toast.error(i18n.t('message.error.enter.api.host'))
    throw new Error(i18n.t('message.error.enter.api.host'))
  }

  if (isEmpty(provider.models)) {
    window.toast.error(i18n.t('message.error.enter.model'))
    throw new Error(i18n.t('message.error.enter.model'))
  }
}

/**
 * Validates that a provider/model pair is working by sending a minimal request.
 * @param provider - The provider configuration to test.
 * @param model - The model to use for the validation request (chat or embeddings).
 * @param timeout - Maximum time (ms) to wait for the request to complete. Defaults to 15000 ms.
 * @throws {Error} If the request fails or times out, indicating the API is not usable.
 */
export async function checkApi(provider: Provider, model: Model, timeout = 15000): Promise<void> {
  checkApiProvider(provider)

  const ai = new AiProviderNew(model, provider)

  const assistant = getDefaultAssistant()
  assistant.model = model
  assistant.prompt = 'test' // 避免部分 provider 空系统提示词会报错

  if (isEmbeddingModel(model)) {
    logger.silly("it's a embedding model")
    const timerPromise = new Promise((_, reject) => setTimeout(() => reject('Timeout'), timeout))
    await Promise.race([ai.getEmbeddingDimensions(model), timerPromise])
  } else {
    const abortId = uuid()
    const signal = readyToAbort(abortId)
    let streamError: ResponseError | undefined
    const params: StreamTextParams = {
      system: assistant.prompt,
      prompt: 'hi',
      abortSignal: signal
    }
    const config: ModernAiProviderConfig = {
      streamOutput: true,
      enableReasoning: false,
      isSupportedToolUse: false,
      isImageGenerationEndpoint: false,
      enableWebSearch: false,
      enableGenerateImage: false,
      isPromptToolUse: false,
      enableUrlContext: false,
      assistant,
      callType: 'check',
      onChunk: (chunk: Chunk) => {
        if (chunk.type === ChunkType.ERROR) {
          streamError = chunk.error
        } else {
          abortCompletion(abortId)
        }
      }
    }

    try {
      await ai.completions(model.id, params, config)
    } catch (e) {
      if (!isAbortError(e) && !isAbortError(streamError)) {
        throw streamError ?? e
      }
    }
  }
}

export async function checkModel(provider: Provider, model: Model, timeout = 15000): Promise<{ latency: number }> {
  const startTime = performance.now()
  await checkApi(provider, model, timeout)
  return { latency: performance.now() - startTime }
}

async function handle3DGeneration(
  assistant: Assistant,
  onChunkReceived: (chunk: Chunk) => void,
  requestOptions?: { signal?: AbortSignal },
  uiMessages?: Message[]
) {
  const lastUserMsg = uiMessages ? [...uiMessages].reverse().find((m) => m.role === 'user') : undefined

  if (!lastUserMsg) {
    onChunkReceived({ type: ChunkType.ERROR, error: { message: 'No user message found for 3D generation' } })
    return
  }

  const imageBlocks = findImageBlocks(lastUserMsg)
  const fileBlocks = findFileBlocks(lastUserMsg)
  const imageFiles = [
    ...imageBlocks.filter((b) => b.file).map((b) => b.file!),
    ...fileBlocks.filter((b) => b.file?.type === 'image').map((b) => b.file!)
  ]

  if (imageFiles.length === 0) {
    onChunkReceived({
      type: ChunkType.ERROR,
      error: {
        message: i18n.t('model3d.no_image', 'Please upload an image to generate a 3D model')
      }
    })
    return
  }

  const imageFile = imageFiles[0]

  onChunkReceived({ type: ChunkType.LLM_RESPONSE_CREATED })
  onChunkReceived({ type: ChunkType.MODEL_3D_CREATED } as any)
  onChunkReceived({
    type: ChunkType.MODEL_3D_PROGRESS,
    progressText: i18n.t('model3d.progress_submitted', 'Task submitted, waiting...')
  } as any)

  const provider = getProviderByModel(assistant.model || getDefaultModel())

  try {
    const imageData = await window.api.file.base64Image(imageFile.id + imageFile.ext)
    if (!imageData?.data) {
      onChunkReceived({ type: ChunkType.ERROR, error: { message: 'Failed to read image file' } })
      return
    }

    // Step 1: Submit
    const submitResp = await fetch('/api/v1/generate-3d/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_data: imageData.data,
        model: assistant.model?.name || assistant.model?.id || 'Hunyuan3D-2',
        generate_type: 'Normal',
        enable_pbr: true,
        face_count: 500000,
        output_format: 'glb',
        seed: 1234,
        apiHost: provider?.apiHost,
        apiKey: provider?.apiKey
      }),
      signal: requestOptions?.signal
    })

    const submitResult = await submitResp.json()
    if (submitResult.error) {
      onChunkReceived({ type: ChunkType.ERROR, error: { message: submitResult.error } })
      return
    }

    const taskId = submitResult.task_id
    onChunkReceived({
      type: ChunkType.MODEL_3D_PROGRESS,
      progressText: i18n.t('model3d.progress_waiting', 'Queued, waiting...')
    } as any)

    // Step 2: Frontend polling loop — no timeout, only user abort stops it
    const pollStart = Date.now()
    let pollInterval = 3000
    let lastStatus = ''
    let consecutiveErrors = 0

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (requestOptions?.signal?.aborted) return

      await new Promise((resolve) => setTimeout(resolve, pollInterval))
      pollInterval = Math.min(pollInterval * 1.2, 10000)

      if (requestOptions?.signal?.aborted) return

      let pollResult: any
      try {
        const pollResp = await fetch('/api/v1/generate-3d/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task_id: taskId,
            apiHost: provider?.apiHost,
            apiKey: provider?.apiKey
          }),
          signal: requestOptions?.signal
        })
        pollResult = await pollResp.json()
        consecutiveErrors = 0
      } catch (fetchErr: any) {
        if (fetchErr?.name === 'AbortError') return
        consecutiveErrors++
        const elapsed = Math.round((Date.now() - pollStart) / 1000)
        onChunkReceived({
          type: ChunkType.MODEL_3D_PROGRESS,
          progressText: `${i18n.t('model3d.progress_processing')} (${elapsed}s) — ${i18n.t('model3d.progress_retry', 'retrying...')}`
        } as any)
        continue
      }

      if (pollResult.error) {
        consecutiveErrors++
        const elapsed = Math.round((Date.now() - pollStart) / 1000)
        onChunkReceived({
          type: ChunkType.MODEL_3D_PROGRESS,
          progressText: `${i18n.t('model3d.progress_processing')} (${elapsed}s) — ${i18n.t('model3d.progress_retry', 'retrying...')}`
        } as any)
        continue
      }

      const status = pollResult.status || 'waiting'
      const elapsed = Math.round((Date.now() - pollStart) / 1000)

      if (status !== lastStatus) {
        lastStatus = status
      }

      let progressKey = 'model3d.progress_waiting'
      if (status === 'in_progress' || status === 'processing') {
        progressKey = 'model3d.progress_processing'
      } else if (status === 'failure') {
        progressKey = 'model3d.progress_failed'
      }

      onChunkReceived({
        type: ChunkType.MODEL_3D_PROGRESS,
        progressText: `${i18n.t(progressKey)} (${elapsed}s)`
      } as any)

      if (status === 'success') {
        // Step 3: Download & save
        onChunkReceived({
          type: ChunkType.MODEL_3D_PROGRESS,
          progressText: i18n.t('model3d.progress_downloading', 'Downloading model file...')
        } as any)

        const saveResp = await fetch('/api/v1/generate-3d/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            download_url: pollResult.download_url,
            format: pollResult.format || 'glb',
            task_id: taskId
          }),
          signal: requestOptions?.signal
        })

        const saveResult = await saveResp.json()

        if (saveResult.error) {
          onChunkReceived({ type: ChunkType.ERROR, error: { message: saveResult.error } })
          return
        }

        if (saveResult.ok && saveResult.file) {
          onChunkReceived({
            type: ChunkType.MODEL_3D_COMPLETE,
            file: saveResult.file,
            format: saveResult.format || 'glb'
          } as any)
        }

        const imageName = imageFile.origin_name || imageFile.name || 'image'
        const modelName = assistant.model?.name || assistant.model?.id || '3D'
        onChunkReceived({
          type: ChunkType.BLOCK_COMPLETE,
          response: { text: `[Image-to-3D] ${modelName}: ${imageName}` }
        } as any)
        return
      }

      // failure 不终止，继续轮询等待可能的恢复
    }
  } catch (error: any) {
    if (error?.name === 'AbortError') return
    onChunkReceived({ type: ChunkType.ERROR, error: { message: error?.message || 'Unknown 3D generation error' } })
  }
}
