/**
 * 职责：提供原子化的、无状态的API调用函数
 */
import { loggerService } from '@logger'
import { buildStreamTextParams } from '@renderer/aiCore/prepareParams'
import type { AiSdkMiddlewareConfig } from '@renderer/aiCore/types/middlewareConfig'
import { buildProviderOptions } from '@renderer/aiCore/utils/options'
import {
  isDedicatedImageGenerationModel,
  isEmbeddingModel,
  isFunctionCallingModel,
  isTextChatModel
} from '@renderer/config/models'
import { isGenerate3DModel, isGenerateMotionModel, isGenerateVideoModel } from '@renderer/config/models/vision'
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
import type { ModelMessage } from 'ai'
import { isEmpty, takeRight } from 'lodash'

import type { ModernAiProviderConfig } from '../aiCore/index_new'
import AiProviderNew from '../aiCore/index_new'
import {
  // getAssistantProvider,
  // getAssistantSettings,
  getDefaultAssistant,
  getDefaultModel,
  getLiveModel,
  getProviderByModel,
  getQuickModel
} from './AssistantService'
import { ConversationService } from './ConversationService'
import { generateUnifiedImage } from './ImageGenerationService'
import type { BlockManager } from './messageStreaming'
import { injectOrchestrationInstructions } from './OrchestrationPreprocessor'
import { getRotatedApiKey } from './providerKey'
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

// ─── 静态元工具定义（0 IPC 开销）────────────────────────────────────────────
// 这 4 个工具是 Hub 的核心能力，定义固定不变，无需每次从后端获取
const STATIC_HUB_META_TOOLS: MCPTool[] = [
  {
    id: 'mcp__CherryHub__discoverTools',
    name: 'discover_tools',
    description:
      'Discover available MCP tools by keyword (NOT for web search). Use * to list all. Use the dedicated web search tool for searching the internet.',
    serverId: hubMCPServer.id,
    serverName: hubMCPServer.name,
    type: 'mcp',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to find MCP tools (comma-separated). Use * to list all.' }
      },
      required: ['query']
    }
  },
  {
    id: 'mcp__CherryHub__callTool',
    name: 'call_tool',
    description: 'Execute any available MCP tool by name.',
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
  },
  {
    id: 'mcp__CherryHub__getToolSchema',
    name: 'get_tool_schema',
    description: 'Get full parameter schema for a specific MCP tool.',
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
  },
  {
    id: 'mcp__CherryHub__askModel',
    name: 'ask_model',
    description: 'Delegate a subtask to another model (routing decided by system).',
    serverId: hubMCPServer.id,
    serverName: hubMCPServer.name,
    type: 'mcp',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task prompt for the delegated model' },
        model: { type: 'string', description: 'Optional target model id/name' }
      },
      required: ['prompt']
    }
  }
]

// ─── 插件工具后台缓存（用于 /tool_name 斜杠命令匹配）─────────────────────────
// 注册插件（SAM3、Atlassian 等）的工具 schema 在会话期间不变，
// 后台异步预热，避免阻塞首字路径
let _pluginToolsCache: MCPTool[] | null = null
let _pluginCacheRefreshing = false

export function invalidateMcpToolsCache() {
  _pluginToolsCache = null
}

function refreshPluginToolsCacheInBackground(assistant: Assistant) {
  if (_pluginCacheRefreshing) return
  _pluginCacheRefreshing = true
  const enabledMCPs = getMcpServersForAssistant(assistant)
  if (!enabledMCPs?.length) {
    _pluginCacheRefreshing = false
    return
  }
  const t0 = performance.now()
  Promise.allSettled(
    enabledMCPs.map(async (mcpServer: MCPServer) => {
      try {
        const tools = await window.api.mcp.listTools(mcpServer)
        return tools.filter((tool: any) => !mcpServer.disabledTools?.includes(tool.name))
      } catch {
        return []
      }
    })
  )
    .then((results) => {
      const allTools = results
        .filter((r): r is PromiseFulfilledResult<MCPTool[]> => r.status === 'fulfilled')
        .flatMap((r) => r.value)
      // 只保留非元工具的插件工具
      _pluginToolsCache = allTools.filter((t) => !STATIC_HUB_META_TOOLS.some((m) => m.name === t.name))
      const elapsed = Math.round(performance.now() - t0)
      logger.info(`[pluginToolsCache] background refresh: ${_pluginToolsCache.length} plugin tools in ${elapsed}ms`)
    })
    .finally(() => {
      _pluginCacheRefreshing = false
    })
}

/**
 * 同步获取当前可用的 MCP 工具（0 IPC 开销，不阻塞首字）
 * - 始终包含 4 个静态元工具
 * - 如果用户消息含 /tool_name，从后台缓存中匹配插件工具 schema
 * - 首次调用时触发后台预热缓存
 */
function getMcpToolsSync(assistant: Assistant, messages: ModelMessage[]): MCPTool[] {
  const enabledMCPs = getMcpServersForAssistant(assistant)
  const hasHub = enabledMCPs?.some((server) => server.id === hubMCPServer.id)
  if (!hasHub) return []

  // 触发后台缓存预热（非阻塞）
  if (_pluginToolsCache === null) {
    refreshPluginToolsCacheInBackground(assistant)
  }

  const allTools = [...STATIC_HUB_META_TOOLS, ...(_pluginToolsCache || [])]
  return filterToolsBySlashCommand(allTools, messages)
}

// 保留 fetchMcpTools 供其他场景（如非 auto 模式）使用
export async function fetchMcpTools(assistant: Assistant) {
  const enabledMCPs = getMcpServersForAssistant(assistant)
  if (!enabledMCPs?.length) return []

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
  return results.filter((r): r is PromiseFulfilledResult<MCPTool[]> => r.status === 'fulfilled').flatMap((r) => r.value)
}

/**
 * Auto 模式"经典+斜杠"策略：
 * - 默认只保留 Hub 元工具（discover_tools/call_tool/get_tool_schema/ask_model）→ 省 token
 * - 当用户消息中包含 /工具名 时，额外注入匹配的直接工具 schema → 无需 discover_tools 三步
 * - 直接工具仍可通过 call_tool 执行，只是不在 prompt 中占用 token
 */
function filterToolsBySlashCommand(allTools: MCPTool[], messages: ModelMessage[]): MCPTool[] {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
  const userText =
    typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg?.content)
        ? lastUserMsg.content
            .filter((p): p is { type: 'text'; text: string } => (p as any).type === 'text')
            .map((p) => p.text)
            .join(' ')
        : ''

  // 提取所有 /xxx 斜杠命令（支持 /sam3、/confluence_search 等格式）
  const slashMatches = userText.match(/\/([a-zA-Z0-9_-]+)/g) || []
  const slashNames = new Set(slashMatches.map((m) => m.slice(1).toLowerCase()))

  const HUB_PREFIX = 'mcp__CherryHub__'
  const metaTools: MCPTool[] = []
  const matchedDirectTools: MCPTool[] = []

  for (const tool of allTools) {
    if (
      tool.id.startsWith(HUB_PREFIX) ||
      tool.name === 'discover_tools' ||
      tool.name === 'call_tool' ||
      tool.name === 'get_tool_schema' ||
      tool.name === 'ask_model'
    ) {
      metaTools.push(tool)
      continue
    }

    // 非 Hub 元工具：检查是否被 /斜杠命令 选中
    if (slashNames.size > 0) {
      const toolNameLower = (tool.name || '').toLowerCase()
      const toolIdLower = (tool.id || '').toLowerCase()
      for (const slash of slashNames) {
        if (toolNameLower === slash || toolNameLower.includes(slash) || toolIdLower.includes(slash)) {
          matchedDirectTools.push(tool)
          break
        }
      }
    }
  }

  if (matchedDirectTools.length > 0) {
    logger.info(
      `[filterToolsBySlashCommand] Slash commands: [${[...slashNames].join(', ')}] → injected ${matchedDirectTools.length} direct tools`,
      {
        tools: matchedDirectTools.map((t) => t.name)
      }
    )
  }

  return [...metaTools, ...matchedDirectTools]
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
  const _t0 = performance.now()

  try {
    const { modelMessages, uiMessages, hasSummaries } = await ConversationService.prepareMessagesForModel(
      messages,
      assistant
    )
    const _t1 = performance.now()

    // inject orchestration instructions for /tool triggers and @model mentions
    injectOrchestrationInstructions(modelMessages, uiMessages)
    const _t2 = performance.now()
    logger.info(`[TTFT] prepareMessages=${Math.round(_t1 - _t0)}ms, orchestration=${Math.round(_t2 - _t1)}ms`)

    await fetchChatCompletion({
      messages: modelMessages,
      assistant: assistant,
      topicId: request.topicId,
      allowedTools: request.allowedTools,
      requestOptions: request.options,
      uiMessages,
      onChunkReceived,
      hasSummaries
    })
  } catch (error: any) {
    onChunkReceived({ type: ChunkType.ERROR, error })
  }
}

/**
 * Note: This path always uses AI SDK streaming under the hood via `streamText`.
 * There is no `generateText` (non-stream) branch inside this function.
 */
export async function fetchChatCompletion({
  messages,
  prompt,
  assistant,
  requestOptions,
  onChunkReceived,
  topicId,
  uiMessages,
  allowedTools,
  hasSummaries
}: FetchChatCompletionParams) {
  const _fc0 = performance.now()

  // Refresh the assistant's persisted model snapshot from the llm store so that
  // centralized-config fields (e.g. modality) stay authoritative for
  // routing. This lets new generative models be added via config alone, without
  // touching frontend detection code.
  const liveModel = getLiveModel(assistant.model)
  if (liveModel && liveModel !== assistant.model) {
    assistant = { ...assistant, model: liveModel }
  }

  logger.info('fetchChatCompletion called with detailed context', {
    messageCount: messages?.length || 0,
    prompt: prompt,
    assistantId: assistant.id,
    topicId,
    hasTopicId: !!topicId,
    modelId: assistant.model?.id,
    modelName: assistant.model?.name
  })

  if (isGenerateMotionModel(assistant.model)) {
    await handleMotionGeneration(assistant, onChunkReceived, requestOptions, uiMessages)
    return
  }

  if (isGenerate3DModel(assistant.model)) {
    await handle3DGeneration(assistant, onChunkReceived, requestOptions, uiMessages)
    return
  }

  if (isGenerateVideoModel(assistant.model)) {
    await handleVideoGeneration(assistant, onChunkReceived, requestOptions, uiMessages)
    return
  }

  // Get base provider and apply API key rotation
  const baseProvider = getProviderByModel(assistant.model || getDefaultModel())
  const providerWithRotatedKey = {
    ...baseProvider,
    apiKey: getRotatedApiKey(baseProvider)
  }

  const AI = new AiProviderNew(assistant.model || getDefaultModel(), providerWithRotatedKey)
  const provider = AI.getActualProvider()

  onChunkReceived({ type: ChunkType.LLM_RESPONSE_CREATED })

  if (prompt) {
    messages = [
      {
        role: 'user',
        content: prompt
      }
    ]
  }

  // Auto 模式：0 IPC 开销获取工具
  // - 静态元工具（discover_tools/call_tool/get_tool_schema/ask_model）直接使用常量
  // - /tool_name 匹配的插件工具从后台缓存获取
  // - 非 auto 模式仍使用异步 fetchMcpTools
  const mcpMode = getEffectiveMcpMode(assistant)
  let mcpTools: MCPTool[] = []
  const _fc1 = performance.now()

  if ((isPromptToolUse(assistant) || isSupportedToolUse(assistant)) && isTextChatModel(assistant.model)) {
    if (mcpMode === 'auto') {
      mcpTools = getMcpToolsSync(assistant, messages || [])
    } else {
      mcpTools = await fetchMcpTools(assistant)
    }
  }
  const _fc2 = performance.now()

  const {
    params: aiSdkParams,
    modelId,
    capabilities,
    webSearchPluginConfig,
    idleTimeout
  } = await buildStreamTextParams(messages, assistant, provider, {
    mcpTools: mcpTools,
    allowedTools,
    webSearchProviderId: assistant.webSearchProviderId,
    requestOptions,
    hasSummaries
  })
  const _fc3 = performance.now()
  logger.info(
    `[TTFT] providerSetup=${Math.round(_fc1 - _fc0)}ms, mcpTools=${Math.round(_fc2 - _fc1)}ms (${mcpMode}, ${mcpTools.length} tools), buildParams=${Math.round(_fc3 - _fc2)}ms, total=${Math.round(_fc3 - _fc0)}ms`
  )

  // Safely fallback to prompt tool use when function calling is not supported by model.
  const usePromptToolUse =
    isPromptToolUse(assistant) || (isToolUseModeFunction(assistant) && !isFunctionCallingModel(assistant.model))

  const middlewareConfig: AiSdkMiddlewareConfig = {
    // 单模型级别的流式开关优先级最高；未设置时回退到助手设置（默认开启）
    streamOutput: assistant.model?.streamOutput ?? assistant.settings?.streamOutput ?? true,
    onChunk: onChunkReceived,
    enableReasoning: capabilities.enableReasoning,
    isPromptToolUse: usePromptToolUse,
    isSupportedToolUse: isSupportedToolUse(assistant),
    isImageGenerationEndpoint:
      isDedicatedImageGenerationModel(assistant.model || getDefaultModel()) &&
      (!assistant.model?.endpoint_type || assistant.model.endpoint_type === 'image-generation'),
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
      imageActionHandler,
      idleTimeout
    })
  } finally {
    // 清理全局变量
    ;(window as any).__CHERRY_CURRENT_ASSISTANT__ = undefined
  }
}

export async function fetchMessagesSummary({
  messages
}: {
  messages: Message[]
}): Promise<{ text: string | null; error?: string }> {
  let prompt = (getStoreSetting('topicNamingPrompt') as string) || i18n.t('prompts.title')
  const model = getQuickModel()

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

  const defaultAssistant = getDefaultAssistant()
  const summaryAssistant = {
    ...defaultAssistant,
    settings: {
      ...defaultAssistant.settings,
      reasoning_effort: 'none',
      qwenThinkMode: false
    },
    prompt,
    model
  } satisfies Assistant

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
            model: assistant.model?.id || assistant.model?.name || 'MiniMax-Hailuo-2.3',
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

async function handleMotionGeneration(
  assistant: Assistant,
  onChunkReceived: (chunk: Chunk) => void,
  requestOptions?: { signal?: AbortSignal },
  uiMessages?: Message[]
) {
  const lastUserMsg = uiMessages ? [...uiMessages].reverse().find((m) => m.role === 'user') : undefined

  if (!lastUserMsg) {
    onChunkReceived({ type: ChunkType.ERROR, error: { message: 'No user message found for motion generation' } })
    return
  }

  const prompt = getMainTextContent(lastUserMsg)

  // 视频→动作（如 promptHMR）：取用户消息里的视频附件，以 base64 data URL 传给后端，
  // 后端再以 multipart 转发给上游。无视频则走文生动作（如 hy-motion）。
  const videoFiles = findFileBlocks(lastUserMsg)
    .filter((b) => b.file?.type === 'video')
    .map((b) => b.file!)
  let videoData = ''
  if (videoFiles.length > 0) {
    try {
      const v = await window.api.file.base64File(videoFiles[0].id + videoFiles[0].ext)
      if (v?.data) {
        videoData = v.mime ? `data:${v.mime};base64,${v.data}` : v.data
      }
    } catch (e) {
      logger.warn('Failed to read video for motion generation:', e as any)
    }
  }

  if ((!prompt || !prompt.trim()) && !videoData) {
    onChunkReceived({
      type: ChunkType.ERROR,
      error: {
        message: i18n.t('motion.no_input', 'Please enter a text description or upload a video to generate motion')
      }
    })
    return
  }

  onChunkReceived({ type: ChunkType.LLM_RESPONSE_CREATED })
  onChunkReceived({ type: ChunkType.MODEL_3D_CREATED } as any)
  onChunkReceived({
    type: ChunkType.MODEL_3D_PROGRESS,
    progressText: i18n.t('motion.submitted', 'Motion task submitted, waiting...')
  } as any)

  const provider = getProviderByModel(assistant.model || getDefaultModel())

  try {
    const submitResp = await fetch('/api/v1/generate-motion/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: (prompt || '').trim(),
        video_data: videoData || undefined,
        n: assistant.motionCount ?? 4,
        duration: assistant.motionDuration ?? 2.0,
        model: assistant.model?.id || assistant.model?.name || 'hy-motion-1.0',
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
      progressText: i18n.t('motion.processing', 'Generating motion animation...')
    } as any)

    const pollStart = Date.now()
    let pollInterval = 3000
    let consecutiveErrors = 0

    while (true) {
      if (requestOptions?.signal?.aborted) return

      await new Promise((resolve) => setTimeout(resolve, pollInterval))
      pollInterval = Math.min(pollInterval * 1.2, 10000)

      if (requestOptions?.signal?.aborted) return

      let pollResult: any
      try {
        const pollResp = await fetch('/api/v1/generate-motion/poll', {
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
          progressText: `${i18n.t('motion.processing', 'Generating motion animation...')} (${elapsed}s) — ${i18n.t('motion.retrying', 'retrying...')}`
        } as any)
        continue
      }

      if (pollResult.error) {
        consecutiveErrors++
        const elapsed = Math.round((Date.now() - pollStart) / 1000)
        onChunkReceived({
          type: ChunkType.MODEL_3D_PROGRESS,
          progressText: `${i18n.t('motion.processing', 'Generating motion animation...')} (${elapsed}s) — ${i18n.t('motion.retrying', 'retrying...')}`
        } as any)
        continue
      }

      const status = pollResult.status || 'pending'
      const elapsed = Math.round((Date.now() - pollStart) / 1000)

      if (status === 'completed') {
        const motionFiles: string[] = pollResult.files || []

        if (motionFiles.length === 0) {
          onChunkReceived({ type: ChunkType.ERROR, error: { message: 'No motion files generated' } })
          return
        }

        onChunkReceived({
          type: ChunkType.MODEL_3D_PROGRESS,
          progressText: i18n.t('motion.downloading', 'Downloading animation files...')
        } as any)

        const savedFiles: any[] = []
        for (let i = 0; i < motionFiles.length; i++) {
          if (requestOptions?.signal?.aborted) return

          const filename = motionFiles[i]
          onChunkReceived({
            type: ChunkType.MODEL_3D_PROGRESS,
            progressText: `${i18n.t('motion.downloading', 'Downloading animation files...')} (${i + 1}/${motionFiles.length})`
          } as any)

          const saveResp = await fetch('/api/v1/generate-motion/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              task_id: taskId,
              filename,
              apiHost: provider?.apiHost,
              apiKey: provider?.apiKey
            }),
            signal: requestOptions?.signal
          })

          const saveResult = await saveResp.json()

          if (saveResult.error) {
            logger.warn(`Failed to save motion file ${filename}:`, saveResult.error)
            continue
          }

          if (saveResult.ok && saveResult.file) {
            savedFiles.push(saveResult.file)
          }
        }

        if (savedFiles.length > 0) {
          const primaryFile = {
            ...savedFiles[0],
            extraFiles: savedFiles.length > 1 ? savedFiles.slice(1) : undefined,
            prompt: prompt.trim()
          }
          // Derive the real format from the saved file extension (fbx | glb).
          const primaryFormat = (primaryFile.ext || '').replace('.', '').toLowerCase() || 'fbx'
          onChunkReceived({
            type: ChunkType.MODEL_3D_COMPLETE,
            file: primaryFile,
            format: primaryFormat
          } as any)
        } else {
          onChunkReceived({ type: ChunkType.ERROR, error: { message: 'All motion file downloads failed' } })
          return
        }

        const modelName = assistant.model?.name || assistant.model?.id || 'hy-motion'
        onChunkReceived({
          type: ChunkType.BLOCK_COMPLETE,
          response: { text: `[Text-to-Motion] ${modelName}: ${prompt.slice(0, 60)}` }
        } as any)
        return
      }

      if (status === 'failed') {
        onChunkReceived({
          type: ChunkType.ERROR,
          error: { message: pollResult.error_message || 'Motion generation failed' }
        })
        return
      }

      let progressKey = 'motion.processing'
      if (status === 'pending') {
        progressKey = 'motion.submitted'
      }

      onChunkReceived({
        type: ChunkType.MODEL_3D_PROGRESS,
        progressText: `${i18n.t(progressKey, 'Generating motion animation...')} (${elapsed}s)`
      } as any)
    }
  } catch (error: any) {
    if (error?.name === 'AbortError') return
    onChunkReceived({
      type: ChunkType.ERROR,
      error: { message: error?.message || 'Unknown motion generation error' }
    })
  }
}

async function handleVideoGeneration(
  assistant: Assistant,
  onChunkReceived: (chunk: Chunk) => void,
  requestOptions?: { signal?: AbortSignal },
  uiMessages?: Message[]
) {
  const lastUserMsg = uiMessages ? [...uiMessages].reverse().find((m) => m.role === 'user') : undefined

  if (!lastUserMsg) {
    onChunkReceived({ type: ChunkType.ERROR, error: { message: 'No user message found for video generation' } })
    return
  }

  const prompt = getMainTextContent(lastUserMsg)

  if (!prompt || !prompt.trim()) {
    onChunkReceived({
      type: ChunkType.ERROR,
      error: { message: i18n.t('video.no_prompt', 'Please enter a text description to generate a video') }
    })
    return
  }

  const videoGen = assistant.settings?.videoGen
  const duration = videoGen?.duration ?? 5
  const resolution = videoGen?.resolution ?? '720p'
  const ratio = videoGen?.ratio ?? 'adaptive'
  const generateAudio = videoGen?.generateAudio ?? true
  const bitrateMode = videoGen?.bitrateMode ?? 'standard'
  const watermark = videoGen?.watermark ?? false
  const returnLastFrame = videoGen?.returnLastFrame ?? false
  // Atlas 官网实测 $/s：480p≈0.05648，720p≈0.11215
  const rate480 = 0.564805 / 10
  const rate720 = 1.121464 / 10
  const rate = resolution === '480p' ? rate480 : rate720

  onChunkReceived({ type: ChunkType.LLM_RESPONSE_CREATED })
  onChunkReceived({ type: ChunkType.VIDEO_GEN_CREATED } as any)
  onChunkReceived({
    type: ChunkType.VIDEO_GEN_PROGRESS,
    progressText: i18n.t('video.submitted', 'Video task submitted, waiting...')
  } as any)

  const provider = getProviderByModel(assistant.model || getDefaultModel())

  try {
    const submitResp = await fetch('/api/v1/generate-video/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: prompt.trim(),
        model: assistant.model?.id || assistant.model?.name || 'seedance-2.0-mini@atl',
        duration,
        resolution,
        ratio,
        generate_audio: generateAudio,
        bitrate_mode: bitrateMode,
        watermark,
        return_last_frame: returnLastFrame,
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
    // Synthetic usage for MessageTokens + NewAPI last-cost lookup (resolution-aware).
    const usageFromSubmit = submitResult.usage || {
      prompt_tokens: 0,
      completion_tokens: Math.max(1, Math.round(duration * 1000 * (rate / rate480))),
      total_tokens: 0
    }
    if (!usageFromSubmit.total_tokens) {
      usageFromSubmit.total_tokens = (usageFromSubmit.prompt_tokens || 0) + (usageFromSubmit.completion_tokens || 0)
    }
    onChunkReceived({
      type: ChunkType.VIDEO_GEN_PROGRESS,
      progressText: i18n.t('video.processing', 'Generating video...')
    } as any)

    const pollStart = Date.now()
    let pollInterval = 5000

    while (true) {
      if (requestOptions?.signal?.aborted) return

      await new Promise((resolve) => setTimeout(resolve, pollInterval))
      pollInterval = Math.min(pollInterval * 1.2, 15000)

      if (requestOptions?.signal?.aborted) return

      let pollResult: any
      try {
        const pollResp = await fetch('/api/v1/generate-video/poll', {
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
      } catch (fetchErr: any) {
        if (fetchErr?.name === 'AbortError') return
        const elapsed = Math.round((Date.now() - pollStart) / 1000)
        onChunkReceived({
          type: ChunkType.VIDEO_GEN_PROGRESS,
          progressText: `${i18n.t('video.processing', 'Generating video...')} (${elapsed}s) — ${i18n.t('video.retrying', 'retrying...')}`
        } as any)
        continue
      }

      if (pollResult.error) {
        const elapsed = Math.round((Date.now() - pollStart) / 1000)
        onChunkReceived({
          type: ChunkType.VIDEO_GEN_PROGRESS,
          progressText: `${i18n.t('video.processing', 'Generating video...')} (${elapsed}s) — ${i18n.t('video.retrying', 'retrying...')}`
        } as any)
        continue
      }

      const status = pollResult.status || 'processing'
      const elapsed = Math.round((Date.now() - pollStart) / 1000)

      if (status === 'completed') {
        const videoUrl: string = pollResult.video_url || ''
        if (!videoUrl) {
          onChunkReceived({ type: ChunkType.ERROR, error: { message: 'No video url in completed task' } })
          return
        }

        onChunkReceived({
          type: ChunkType.VIDEO_GEN_PROGRESS,
          progressText: i18n.t('video.downloading', 'Downloading video...')
        } as any)

        // 下载到本地并通过后端文件服务播放（更稳定、可下载）；失败时回退到远端直链
        let playableUrl = videoUrl
        let originName: string | undefined
        let downloadUrl: string | undefined
        try {
          const saveResp = await fetch('/api/v1/generate-video/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              video_url: videoUrl,
              apiHost: provider?.apiHost,
              apiKey: provider?.apiKey
            }),
            signal: requestOptions?.signal
          })
          const saveResult = await saveResp.json()
          if (saveResult.ok && saveResult.file?.name) {
            // 存相对路径而非带端口的绝对地址：后端端口每次启动可能变，
            // 浏览器会按当前 origin 解析相对路径，保证历史视频重启后仍可播放。
            // name 是预览用文件（QtWebEngine 不支持 H.264 mp4，后端会转成 webm）；
            // download_name 始终是原始 mp4，下载按钮用它。
            playableUrl = `/api/v1/files/serve?name=${encodeURIComponent(saveResult.file.name)}`
            const downloadName = saveResult.file.download_name || saveResult.file.name
            downloadUrl = `/api/v1/files/serve?name=${encodeURIComponent(downloadName)}`
            originName = downloadName
          } else {
            logger.warn('Failed to save generated video, falling back to remote url:', saveResult.error)
          }
        } catch (saveErr: any) {
          if (saveErr?.name === 'AbortError') return
          logger.warn('Save generated video failed, falling back to remote url:', saveErr)
        }

        onChunkReceived({
          type: ChunkType.VIDEO_GEN_COMPLETE,
          url: playableUrl,
          metadata: {
            prompt: prompt.trim(),
            origin_name: originName,
            download_url: downloadUrl,
            duration,
            resolution,
            billing_seconds: submitResult.billing_seconds
          }
        } as any)

        const modelName = assistant.model?.name || assistant.model?.id || 'video'
        onChunkReceived({
          type: ChunkType.BLOCK_COMPLETE,
          response: {
            text: `[Text-to-Video] ${modelName}: ${prompt.slice(0, 60)}`,
            usage: usageFromSubmit
          }
        } as any)
        return
      }

      if (status === 'failed') {
        onChunkReceived({
          type: ChunkType.ERROR,
          error: { message: pollResult.error_message || 'Video generation failed' }
        })
        return
      }

      onChunkReceived({
        type: ChunkType.VIDEO_GEN_PROGRESS,
        progressText: `${i18n.t('video.processing', 'Generating video...')} (${elapsed}s)`
      } as any)
    }
  } catch (error: any) {
    if (error?.name === 'AbortError') return
    onChunkReceived({
      type: ChunkType.ERROR,
      error: { message: error?.message || 'Unknown video generation error' }
    })
  }
}
