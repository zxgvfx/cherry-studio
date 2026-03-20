/**
 * 参数构建模块
 * 构建AI SDK的流式和非流式参数
 */

import { anthropic } from '@ai-sdk/anthropic'
import { azure } from '@ai-sdk/azure'
import { google } from '@ai-sdk/google'
import { vertexAnthropic } from '@ai-sdk/google-vertex/anthropic/edge'
import { vertex } from '@ai-sdk/google-vertex/edge'
import { combineHeaders } from '@ai-sdk/provider-utils'
import type { AnthropicSearchConfig, WebSearchPluginConfig } from '@cherrystudio/ai-core/built-in/plugins'
import { isBaseProvider } from '@cherrystudio/ai-core/core/providers/schemas'
import type { BaseProviderId } from '@cherrystudio/ai-core/provider'
import { loggerService } from '@logger'
import { MAX_TOOL_CALLS, MIN_TOOL_CALLS } from '@renderer/config/constant'
import {
  isAnthropicModel,
  isFixedReasoningModel,
  isGeminiModel,
  isGenerateImageModel,
  isGrokModel,
  isOpenAIModel,
  isOpenRouterBuiltInWebSearchModel,
  isPureGenerateImageModel,
  isSupportedReasoningEffortModel,
  isSupportedThinkingTokenModel,
  isWebSearchModel
} from '@renderer/config/models'
import { getHubModeSystemPrompt } from '@renderer/config/prompts-code-mode'
import { DEFAULT_ASSISTANT_SETTINGS, getDefaultModel } from '@renderer/services/AssistantService'
import store from '@renderer/store'
import type { CherryWebSearchConfig } from '@renderer/store/websearch'
import type { Model } from '@renderer/types'
import { type Assistant, getEffectiveMcpMode, type MCPTool, type Provider, SystemProviderIds } from '@renderer/types'
import type { StreamTextParams } from '@renderer/types/aiCoreTypes'
import { mapRegexToPatterns } from '@renderer/utils/blacklistMatchPattern'
import { IdleTimeoutController, type IdleTimeoutHandle } from '@renderer/utils/IdleTimeoutController'
import { containsSupportedVariables, replacePromptVariables } from '@renderer/utils/prompt'
import { isAIGatewayProvider, isAwsBedrockProvider, isSupportUrlContextProvider } from '@renderer/utils/provider'
import { DEFAULT_TIMEOUT } from '@shared/config/constant'
import type { ModelMessage, Tool } from 'ai'
import { stepCountIs } from 'ai'

import { getAiSdkProviderId } from '../provider/factory'
import { setupToolsConfig } from '../utils/mcp'
import { buildProviderOptions } from '../utils/options'
import { buildProviderBuiltinWebSearchConfig } from '../utils/websearch'
import { addAnthropicHeaders } from './header'
import { getMaxTokens, getTemperature, getTopP } from './modelParameters'

const logger = loggerService.withContext('parameterBuilder')

/**
 * Validates and clamps maxToolCalls to valid range
 * Falls back to DEFAULT_ASSISTANT_SETTINGS.maxToolCalls if invalid
 * @param value - The maxToolCalls value from settings
 * @returns Validated maxToolCalls value
 */
function validateMaxToolCalls(value: number | undefined): number {
  if (value === undefined || value < MIN_TOOL_CALLS || value > MAX_TOOL_CALLS) {
    return DEFAULT_ASSISTANT_SETTINGS.maxToolCalls
  }
  return value
}

type ProviderDefinedTool = Extract<Tool<any, any>, { type: 'provider' }>

const SEARCH_IMAGE_INTENT_KEYWORDS = [
  '搜',
  '搜索',
  '查找',
  '查询',
  '找',
  '返回',
  '给我',
  '提供',
  '展示',
  '看看',
  '发我',
  'search',
  'find',
  'look up',
  'show',
  'return',
  'provide'
]
const REAL_IMAGE_TARGET_KEYWORDS = [
  '图',
  '图片',
  '照片',
  '相片',
  '原图',
  '原照片',
  '真实照片',
  '真实图片',
  '历史照片',
  'photo',
  'image',
  'picture',
  'original photo',
  'original image',
  'original picture',
  'real photo',
  'real image',
  'real picture',
  'authentic photo',
  'authentic image',
  'authentic picture'
]
const GENERATION_INTENT_KEYWORDS = [
  '生成',
  '画',
  '绘',
  '绘制',
  '创作',
  '制作',
  '做一张',
  'design',
  'generate',
  'draw',
  'paint',
  'illustrate',
  'create'
]
const DISABLE_GENERATION_HINT_KEYWORDS = [
  '不要生成',
  '别生成',
  '不要画',
  '别画',
  '不要绘制',
  'not generate',
  "don't generate",
  'do not generate',
  'no generation',
  '返回原图',
  '返回真实照片',
  '只要原图',
  '只要真实照片'
]
const REAL_IMAGE_SEARCH_OVERRIDE_INSTRUCTION = `请不要生成、绘制、编辑或合成新的图片。请优先返回网络搜索结果中真实存在的照片/原图，并给出对应来源链接。如果有多张结果，优先返回最可信、最接近原始来源的图片。

Do not generate, draw, edit, or synthesize a new image. Return real existing photos/images from web search results only, preferably the original image together with the source link.`
type StreamMessages = NonNullable<StreamTextParams['messages']>

function containsAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword))
}

function getLatestUserText(messages: StreamMessages): string {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user')
  if (!latestUserMessage) {
    return ''
  }

  const content = latestUserMessage.content
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map((part: any) => {
      if (!part || typeof part !== 'object') {
        return ''
      }
      if (typeof part.text === 'string') {
        return part.text
      }
      if (part.type === 'text' && typeof part.text === 'string') {
        return part.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function shouldTemporarilyDisableImageGeneration(
  model: Model,
  messages: StreamMessages,
  assistant: Assistant
): boolean {
  if (!isGenerateImageModel(model) || !assistant.enableGenerateImage) {
    return false
  }

  const latestUserText = getLatestUserText(messages).trim()
  if (!latestUserText) {
    return false
  }

  const normalizedText = latestUserText.toLowerCase()
  const hasImageTarget = containsAnyKeyword(normalizedText, REAL_IMAGE_TARGET_KEYWORDS)
  const hasSearchIntent = containsAnyKeyword(normalizedText, SEARCH_IMAGE_INTENT_KEYWORDS)
  const hasDisableHint = containsAnyKeyword(normalizedText, DISABLE_GENERATION_HINT_KEYWORDS)
  const hasGenerationIntent = containsAnyKeyword(normalizedText, GENERATION_INTENT_KEYWORDS) && !hasDisableHint

  return hasImageTarget && (hasDisableHint || (hasSearchIntent && !hasGenerationIntent))
}

function enhanceMessagesForRealImageSearch(messages: StreamMessages): StreamMessages {
  const nextMessages: StreamMessages = [...messages]

  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index]
    if (message.role !== 'user') {
      continue
    }

    if (typeof message.content === 'string') {
      if (message.content.includes(REAL_IMAGE_SEARCH_OVERRIDE_INSTRUCTION)) {
        return nextMessages
      }
      nextMessages[index] = {
        ...message,
        content: `${message.content}\n\n${REAL_IMAGE_SEARCH_OVERRIDE_INSTRUCTION}`
      }
      return nextMessages
    }

    if (Array.isArray(message.content)) {
      const alreadyEnhanced = message.content.some(
        (part: any) =>
          part?.type === 'text' &&
          typeof part.text === 'string' &&
          part.text.includes(REAL_IMAGE_SEARCH_OVERRIDE_INSTRUCTION)
      )
      if (alreadyEnhanced) {
        return nextMessages
      }

      nextMessages[index] = {
        ...message,
        content: [...message.content, { type: 'text', text: REAL_IMAGE_SEARCH_OVERRIDE_INSTRUCTION }] as any
      }
      return nextMessages
    }
  }

  return nextMessages
}

function mapVertexAIGatewayModelToProviderId(model: Model): BaseProviderId | undefined {
  if (isAnthropicModel(model)) {
    return 'anthropic'
  }
  if (isGeminiModel(model)) {
    return 'google'
  }
  if (isGrokModel(model)) {
    return 'xai'
  }
  if (isOpenAIModel(model)) {
    return 'openai'
  }
  logger.warn(`Unknown model type for AI Gateway: ${model.id}. Web search will not be enabled.`)
  return undefined
}

/**
 * 构建 AI SDK 流式参数
 * 这是主要的参数构建函数，整合所有转换逻辑
 */
export async function buildStreamTextParams(
  sdkMessages: StreamTextParams['messages'] = [],
  assistant: Assistant,
  provider: Provider,
  options: {
    mcpTools?: MCPTool[]
    allowedTools?: string[]
    webSearchProviderId?: string
    webSearchConfig?: CherryWebSearchConfig
    hasSummaries?: boolean
    requestOptions?: {
      signal?: AbortSignal
      timeout?: number
      headers?: Record<string, string | undefined>
    }
  }
): Promise<{
  params: StreamTextParams
  modelId: string
  capabilities: {
    enableReasoning: boolean
    enableWebSearch: boolean
    enableGenerateImage: boolean
    enableUrlContext: boolean
  }
  webSearchPluginConfig?: WebSearchPluginConfig
  idleTimeout: IdleTimeoutHandle
}> {
  const { mcpTools, requestOptions = {} } = options
  // No caller currently provides a custom timeout; defaultTimeout (10 min) is the fallback.
  const { signal: externalSignal, timeout = DEFAULT_TIMEOUT, headers: inputHeaders = {} } = requestOptions

  // Use an idle timeout that resets every time a stream chunk is received,
  // instead of a fixed total timeout that starts from the initial request.
  const idleTimeout = new IdleTimeoutController(timeout)
  const signals = [idleTimeout.signal]
  if (externalSignal) {
    signals.push(externalSignal)
  }
  const finalSignal = AbortSignal.any(signals)

  const baseSdkMessages: StreamMessages = sdkMessages || []

  const model = assistant.model || getDefaultModel()
  const aiSdkProviderId = getAiSdkProviderId(provider)

  // 这三个变量透传出来，交给下面启用插件/中间件
  // 也可以在外部构建好再传入buildStreamTextParams
  // FIXME: qwen3即使关闭思考仍然会导致enableReasoning的结果为true
  const enableReasoning =
    ((isSupportedThinkingTokenModel(model) || isSupportedReasoningEffortModel(model)) &&
      assistant.settings?.reasoning_effort !== undefined) ||
    isFixedReasoningModel(model)

  // 判断是否使用内置搜索
  // 条件：没有外部搜索提供商 && (用户开启了内置搜索 || 模型强制使用内置搜索)
  const hasExternalSearch = !!options.webSearchProviderId
  const enableWebSearch =
    !hasExternalSearch &&
    ((assistant.enableWebSearch && isWebSearchModel(model)) ||
      isOpenRouterBuiltInWebSearchModel(model) ||
      model.id.includes('sonar'))

  // Validate provider and model support to prevent stale state from triggering urlContext
  const enableUrlContext = !!(
    assistant.enableUrlContext &&
    isSupportUrlContextProvider(provider) &&
    !isPureGenerateImageModel(model) &&
    (isGeminiModel(model) || isAnthropicModel(model))
  )

  const disableGenerateImageForSearchIntent = shouldTemporarilyDisableImageGeneration(model, baseSdkMessages, assistant)
  const effectiveSdkMessages = disableGenerateImageForSearchIntent
    ? enhanceMessagesForRealImageSearch(baseSdkMessages)
    : baseSdkMessages
  const enableGenerateImage = !!(
    isGenerateImageModel(model) &&
    assistant.enableGenerateImage &&
    !disableGenerateImageForSearchIntent
  )

  if (disableGenerateImageForSearchIntent) {
    logger.info('[buildStreamTextParams] Temporarily disabled image generation for image-search intent', {
      modelId: model.id
    })
  }

  let tools = setupToolsConfig(mcpTools, options.allowedTools)

  // 构建真正的 providerOptions
  const webSearchConfig: CherryWebSearchConfig = {
    maxResults: store.getState().websearch.maxResults,
    excludeDomains: store.getState().websearch.excludeDomains,
    searchWithTime: store.getState().websearch.searchWithTime
  }

  const { providerOptions, standardParams } = buildProviderOptions(assistant, model, provider, {
    enableReasoning,
    enableWebSearch,
    enableGenerateImage
  })

  let webSearchPluginConfig: WebSearchPluginConfig | undefined = undefined
  if (enableWebSearch) {
    if (isBaseProvider(aiSdkProviderId)) {
      webSearchPluginConfig = buildProviderBuiltinWebSearchConfig(aiSdkProviderId, webSearchConfig, model)
    } else if (isAIGatewayProvider(provider) || SystemProviderIds.gateway === provider.id) {
      const aiSdkProviderId = mapVertexAIGatewayModelToProviderId(model)
      if (aiSdkProviderId) {
        webSearchPluginConfig = buildProviderBuiltinWebSearchConfig(aiSdkProviderId, webSearchConfig, model)
      }
    }
    if (!tools) {
      tools = {}
    }
    if (aiSdkProviderId === 'google-vertex') {
      tools.google_search = vertex.tools.googleSearch({}) as ProviderDefinedTool
    } else if (aiSdkProviderId === 'google-vertex-anthropic') {
      const blockedDomains = mapRegexToPatterns(webSearchConfig.excludeDomains)
      tools.web_search = vertexAnthropic.tools.webSearch_20250305({
        maxUses: webSearchConfig.maxResults,
        blockedDomains: blockedDomains.length > 0 ? blockedDomains : undefined
      }) as ProviderDefinedTool
    } else if (aiSdkProviderId === 'azure-responses') {
      tools.web_search_preview = azure.tools.webSearchPreview({
        searchContextSize: webSearchPluginConfig?.openai!.searchContextSize
      }) as ProviderDefinedTool
    } else if (aiSdkProviderId === 'azure-anthropic') {
      const blockedDomains = mapRegexToPatterns(webSearchConfig.excludeDomains)
      const anthropicSearchOptions: AnthropicSearchConfig = {
        maxUses: webSearchConfig.maxResults,
        blockedDomains: blockedDomains.length > 0 ? blockedDomains : undefined
      }
      tools.web_search = anthropic.tools.webSearch_20250305(anthropicSearchOptions) as ProviderDefinedTool
    }
  }

  if (enableUrlContext) {
    if (!tools) {
      tools = {}
    }
    const blockedDomains = mapRegexToPatterns(webSearchConfig.excludeDomains)

    switch (aiSdkProviderId) {
      case 'google-vertex':
        tools.url_context = vertex.tools.urlContext({}) as ProviderDefinedTool
        break
      case 'google':
        tools.url_context = google.tools.urlContext({}) as ProviderDefinedTool
        break
      case 'anthropic':
      case 'azure-anthropic':
      case 'google-vertex-anthropic':
        if (['anthropic', 'azure-anthropic'].includes(aiSdkProviderId)) {
          tools.web_fetch = anthropic.tools.webFetch_20250910({
            maxUses: webSearchConfig.maxResults,
            blockedDomains: blockedDomains.length > 0 ? blockedDomains : undefined
          }) as ProviderDefinedTool
        }
        break
    }
  }

  let headers = inputHeaders

  if (isAnthropicModel(model) && !isAwsBedrockProvider(provider)) {
    const betaHeaders = addAnthropicHeaders(assistant, model)
    // Only add the anthropic-beta header if there are actual beta headers to include
    if (betaHeaders.length > 0) {
      const newBetaHeaders = { 'anthropic-beta': betaHeaders.join(',') }
      headers = combineHeaders(headers, newBetaHeaders)
    }
  }

  // 构建基础参数
  // Note: standardParams (topK, frequencyPenalty, presencePenalty, stopSequences, seed)
  // are extracted from custom parameters and passed directly to streamText()
  // instead of being placed in providerOptions

  // Get max tool calls from assistant settings
  // When enabled, validate and use user-defined value (1-100)
  // When disabled, don't pass stopWhen - let AI SDK use its own default
  const enableMaxToolCalls = assistant.settings?.enableMaxToolCalls ?? DEFAULT_ASSISTANT_SETTINGS.enableMaxToolCalls

  const params: StreamTextParams = {
    messages: effectiveSdkMessages,
    maxOutputTokens: getMaxTokens(assistant, model),
    temperature: getTemperature(assistant, model),
    topP: getTopP(assistant, model),
    // Include AI SDK standard params extracted from custom parameters
    ...standardParams,
    abortSignal: finalSignal,
    headers,
    providerOptions,
    maxRetries: 0
  }

  // Only add stopWhen when explicitly enabled and validated
  if (enableMaxToolCalls) {
    const maxToolCalls = validateMaxToolCalls(assistant.settings?.maxToolCalls)
    params.stopWhen = stepCountIs(maxToolCalls)
  }
  // When disabled, don't pass stopWhen - let AI SDK use its own default

  if (tools) {
    params.tools = tools
  }

  let systemPrompt = assistant.prompt || ''
  if (systemPrompt && containsSupportedVariables(systemPrompt)) {
    systemPrompt = await replacePromptVariables(systemPrompt, model.name)
  }

  if (getEffectiveMcpMode(assistant) === 'auto' && (mcpTools?.length ?? 0) > 0) {
    const autoModePrompt = getHubModeSystemPrompt()
    if (autoModePrompt) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${autoModePrompt}` : autoModePrompt
    }
  }

  if (options.hasSummaries) {
    const summaryGuidance = [
      'Some earlier messages in this conversation are provided as summaries (marked with [Summary] and [Detail ID]).',
      'If you need the full content of a summarized message, use the builtin_conversation_detail tool with the Detail ID.',
      'Only request details when the summary is insufficient to answer the current question.'
    ].join(' ')
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${summaryGuidance}` : summaryGuidance
  }

  if (systemPrompt) {
    params.system = systemPrompt
  }

  logger.debug('params', params)

  return {
    params,
    modelId: model.id,
    capabilities: { enableReasoning, enableWebSearch, enableGenerateImage, enableUrlContext },
    webSearchPluginConfig,
    idleTimeout
  }
}

/**
 * 构建非流式的 generateText 参数
 */
export async function buildGenerateTextParams(
  messages: ModelMessage[],
  assistant: Assistant,
  provider: Provider,
  options: {
    mcpTools?: MCPTool[]
    allowedTools?: string[]
    enableTools?: boolean
  } = {}
): Promise<any> {
  // 复用流式参数的构建逻辑
  return await buildStreamTextParams(messages, assistant, provider, options)
}
