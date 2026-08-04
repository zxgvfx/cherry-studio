import OpenAI, { AzureOpenAI } from '@cherrystudio/openai'
import { loggerService } from '@logger'
import { COPILOT_DEFAULT_HEADERS } from '@renderer/aiCore/provider/constants'
import {
  isClaudeReasoningModel,
  isOpenAIReasoningModel,
  isSupportedModel,
  isSupportedReasoningEffortOpenAIModel
} from '@renderer/config/models'
import { getStoreSetting } from '@renderer/hooks/useSettings'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import store from '@renderer/store'
import type { SettingsState } from '@renderer/store/settings'
import { type Assistant, type GenerateImageParams, type Model, type Provider } from '@renderer/types'
import type {
  OpenAIResponseSdkMessageParam,
  OpenAIResponseSdkParams,
  OpenAIResponseSdkRawChunk,
  OpenAIResponseSdkRawOutput,
  OpenAIResponseSdkTool,
  OpenAIResponseSdkToolCall,
  OpenAISdkMessageParam,
  OpenAISdkParams,
  OpenAISdkRawChunk,
  OpenAISdkRawOutput,
  ReasoningEffortOptionalParams
} from '@renderer/types/sdk'
import { withoutTrailingSlash } from '@renderer/utils/api'
import { isOllamaProvider } from '@renderer/utils/provider'

import { BaseApiClient } from '../BaseApiClient'
import { normalizeAzureOpenAIEndpoint } from './azureOpenAIEndpoint'

const logger = loggerService.withContext('OpenAIBaseClient')

const QT_LOCALHOST_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1)(:?\d+)?/i

async function qtFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const globalObj = globalThis as any
  const nativeFetch: typeof fetch | undefined = globalObj.__qt_original_fetch
    ? globalObj.__qt_original_fetch.bind(globalObj)
    : globalObj.fetch?.bind(globalObj)

  try {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = request.url || ''
    if (!QT_LOCALHOST_REGEX.test(url) || !globalObj?.qt?.network?.fetchProxy) {
      if (nativeFetch) {
        return nativeFetch(input, init)
      }
      throw new Error('fetchProxy unavailable')
    }
    const headersRecord: Record<string, string> = {}
    try {
      request.headers.forEach((value, key) => {
        headersRecord[key] = value
      })
    } catch (error) {
      logger.debug('Failed to collect headers for qtFetch', error as Error)
    }
    let bodyText: string | undefined
    const method = (request.method || 'GET').toUpperCase()
    if (!['GET', 'HEAD'].includes(method)) {
      try {
        bodyText = await request.clone().text()
      } catch (error) {
        if (init && typeof init?.body === 'string') {
          bodyText = init.body
        }
      }
    }
    const payload = {
      url,
      method,
      headers: headersRecord,
      body: bodyText,
      timeout: 30
    }
    const raw = await globalObj.qt.network.fetchProxy(JSON.stringify(payload))
    const parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : raw
    if (!parsed) {
      throw new Error('Empty response from qt fetchProxy')
    }
    if (parsed.error && !parsed.status) {
      throw new Error(parsed.error)
    }
    return new Response(parsed.body ?? '', {
      status: parsed.status ?? 200,
      statusText: parsed.statusText ?? '',
      headers: parsed.headers ?? {}
    })
  } catch (error) {
    logger.warn('qtFetch fallback to native fetch', error as Error)
    if (nativeFetch) {
      return nativeFetch(input, init)
    }
    throw error
  }
}

/**
 * 抽象的OpenAI基础客户端类，包含两个OpenAI客户端之间的共享功能
 */
export abstract class OpenAIBaseClient<
  TSdkInstance extends OpenAI | AzureOpenAI,
  TSdkParams extends OpenAISdkParams | OpenAIResponseSdkParams,
  TRawOutput extends OpenAISdkRawOutput | OpenAIResponseSdkRawOutput,
  TRawChunk extends OpenAISdkRawChunk | OpenAIResponseSdkRawChunk,
  TMessageParam extends OpenAISdkMessageParam | OpenAIResponseSdkMessageParam,
  TToolCall extends OpenAI.Chat.Completions.ChatCompletionMessageToolCall | OpenAIResponseSdkToolCall,
  TSdkSpecificTool extends OpenAI.Chat.Completions.ChatCompletionTool | OpenAIResponseSdkTool
> extends BaseApiClient<TSdkInstance, TSdkParams, TRawOutput, TRawChunk, TMessageParam, TToolCall, TSdkSpecificTool> {
  constructor(provider: Provider) {
    super(provider)
  }

  // 仅适用于openai
  override getBaseURL(): string {
    // apiHost is formatted when called by AiProvider
    return this.provider.apiHost
  }

  override async generateImage({
    model,
    prompt,
    negativePrompt,
    imageSize,
    batchSize,
    seed,
    numInferenceSteps,
    guidanceScale,
    signal,
    promptEnhancement
  }: GenerateImageParams): Promise<string[]> {
    const sdk = await this.getSdkInstance()
    const baseURL = this.getBaseURL()
    const normalizedBaseURL = withoutTrailingSlash(baseURL || '')
    const path = /\/v1$/i.test(normalizedBaseURL) ? '/images/generations' : '/v1/images/generations'
    logger.info('[generateImage] Requesting image generation', {
      providerId: this.provider.id,
      providerType: this.provider.type,
      model,
      baseURL: normalizedBaseURL,
      path
    })
    const response = (await sdk.request({
      method: 'post',
      path,
      signal,
      body: {
        model,
        prompt,
        negative_prompt: negativePrompt,
        image_size: imageSize,
        batch_size: batchSize,
        seed: seed ? parseInt(seed) : undefined,
        num_inference_steps: numInferenceSteps,
        guidance_scale: guidanceScale,
        prompt_enhancement: promptEnhancement
      }
    })) as Record<string, any>

    const extractImageUrls = (payload: Record<string, any>): string[] => {
      const results: string[] = []
      const appendImage = (value: unknown, mimeType = 'image/png') => {
        if (typeof value !== 'string') return
        const trimmed = value.trim()
        if (!trimmed) return
        if (trimmed.startsWith('data:') || /^https?:\/\//i.test(trimmed) || trimmed.startsWith('blob:')) {
          results.push(trimmed)
          return
        }
        const cleaned = trimmed.replace(/\s+/g, '')
        const looksLikeBase64 = cleaned.length > 64 && /^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)
        if (looksLikeBase64) {
          results.push(`data:${mimeType};base64,${cleaned}`)
        }
      }

      const dataList = Array.isArray(payload.data) ? payload.data : []
      dataList.forEach((item: any) => {
        appendImage(item?.url)
        appendImage(item?.b64_json)
        appendImage(item?.base64, item?.mime_type || item?.mimeType || 'image/png')
      })

      const imageList = Array.isArray(payload.images) ? payload.images : []
      imageList.forEach((item: any) => {
        appendImage(item?.url || item?.image_url?.url)
        appendImage(item?.b64_json || item?.base64, item?.mime_type || item?.mimeType || 'image/png')
      })

      appendImage(payload.url)
      appendImage(payload.b64_json)
      appendImage(payload.base64, payload.mime_type || payload.mimeType || 'image/png')

      return results
    }

    const images = extractImageUrls(response)

    logger.info('[generateImage] Image generation response received', {
      providerId: this.provider.id,
      model,
      responseKeys: Object.keys(response || {}),
      imageCount: images.length,
      sample: images[0]?.slice(0, 120)
    })
    return images
  }

  override async getEmbeddingDimensions(model: Model): Promise<number> {
    let sdk: OpenAI = await this.getSdkInstance()
    if (isOllamaProvider(this.provider)) {
      const embedBaseUrl = `${this.provider.apiHost.replace(/(\/(api|v1))\/?$/, '')}/v1`
      sdk = sdk.withOptions({ baseURL: embedBaseUrl })
    }

    const data = await sdk.embeddings.create({
      model: model.id,
      input: model?.provider === 'baidu-cloud' ? ['hi'] : 'hi',
      encoding_format: this.provider.id === 'voyageai' ? undefined : 'float'
    })
    return data.data[0].embedding.length
  }

  override async listModels(): Promise<OpenAI.Models.Model[]> {
    try {
      console.log('[OpenAIBaseClient] 🚀 listModels called for provider:', this.provider.id);
      console.log('[OpenAIBaseClient] 🚀 Provider details:', {
        id: this.provider.id,
        name: this.provider.name,
        apiKey: this.provider.apiKey ? 'Yes' : 'No',
        apiHost: this.provider.apiHost
      });
      
      // 在Houdini环境中，为所有Provider使用window.api.models.list
      // 强制检测Houdini环境
      const isHoudiniEnv = !!(globalThis as any)?.isHoudini || 
                           !!(globalThis as any)?.houdini || 
                           !!(globalThis as any)?.qt || 
                           !!(globalThis as any)?.QWebChannel ||
                           !!(globalThis as any)?.hostBridge;
      
      // 调试信息
      console.log('[OpenAIBaseClient] 🚀 Houdini environment detection:', {
        isHoudini: !!(globalThis as any)?.isHoudini,
        houdini: !!(globalThis as any)?.houdini,
        qt: !!(globalThis as any)?.qt,
        QWebChannel: !!(globalThis as any)?.QWebChannel,
        hostBridge: !!(globalThis as any)?.hostBridge,
        isHoudiniEnv,
        providerId: this.provider.id
      });
      
      if (this.provider.id === 'ollama' || isHoudiniEnv) {
        console.log('[OpenAIBaseClient] 🚀 Using Houdini/Ollama path');
        const host = this.provider.apiHost || 'http://localhost:11434'
        const qtNetwork = (globalThis as any)?.qt?.network
        const qtFetch = (globalThis as any)?.qtFetch
        
        // 构建模型列表URL
        let modelUrl = host
        if (this.provider.id === 'ollama') {
          modelUrl = `${host.replace(/\/$/, '')}/v1/models`
        } else {
          // 对于其他Provider，使用标准的OpenAI兼容端点
          modelUrl = `${host.replace(/\/$/, '')}/v1/models`
        }
        
        console.log('[OpenAIBaseClient] 🚀 Model URL:', modelUrl);
        console.log('[OpenAIBaseClient] 🚀 API Key provided:', this.provider.apiKey ? 'Yes' : 'No');
        console.log('[OpenAIBaseClient] 🚀 window.api available:', !!window.api);
        console.log('[OpenAIBaseClient] 🚀 window.api.models available:', !!window.api?.models);
        console.log('[OpenAIBaseClient] 🚀 window.api.models.list available:', !!window.api?.models?.list);
        
        // 优先：对于 ollama，先调用专用接口，确保触发 Python 槽函数
        let data: any[] = []
        if (this.provider.id === 'ollama') {
          try {
            console.log('[OpenAIBaseClient] 🚀 Primary call: window.api.ollama.listModels');
            const raw = await (window as any)?.api?.ollama?.listModels?.({ host })
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {})
            data = Array.isArray(parsed?.data) ? parsed.data : []
            console.log('[OpenAIBaseClient] 🚀 Primary models count:', data.length)
          } catch (e) {
            console.warn('[OpenAIBaseClient] ⚠️ Primary ollama.listModels failed, will try models.list:', e)
          }
        }
        
        // 次选：Houdini 环境的通用列表接口
        if (!data.length) {
          logger.info('listModels fallback to window.api.models.list', { host: modelUrl, provider: this.provider.id })
          console.log('[OpenAIBaseClient] 🚀 Calling window.api.models.list...');
          const response = await window.api?.models?.list?.({
            url: modelUrl,
            method: 'GET',
            apiKey: this.provider.apiKey, // 传递API密钥
            fallback: { object: 'list', data: [] }
          })
          console.log('[OpenAIBaseClient] 🚀 window.api.models.list response:', response);
          data = Array.isArray(response?.data) ? response.data : []
        }
        if (data.length) {
          const mapped = data
            .map((item) => {
              const name = (item?.id || '').trim()
              if (!name) {
                return null
              }
              return {
                id: name,
                object: 'model',
                owned_by: this.provider.id === 'ollama' ? 'ollama' : (item?.owned_by || this.provider.id),
                description: item?.description || item?.owned_by || name
              }
            })
            .filter(Boolean) as OpenAI.Models.Model[]
          return mapped.filter(isSupportedModel)
        }
        logger.warn('listModels returned empty payload', response as unknown as Error)
        return []
      }

      const sdk = await this.getSdkInstance()
      if (this.provider.id === 'openrouter') {
        // https://openrouter.ai/docs/api/api-reference/embeddings/list-embeddings-models
        const embedBaseUrl = 'https://openrouter.ai/api/v1/embeddings'
        const embedSdk = sdk.withOptions({ baseURL: embedBaseUrl })
        const modelPromise = sdk.models.list()
        const embedModelPromise = embedSdk.models.list()
        const [modelResponse, embedModelResponse] = await Promise.all([modelPromise, embedModelPromise])
        const models = [...modelResponse.data, ...embedModelResponse.data]
        const uniqueModels = Array.from(new Map(models.map((model) => [model.id, model])).values())
        return uniqueModels.filter(isSupportedModel)
      }
      if (this.provider.id === 'github') {
        // GitHub Models 其 models 和 chat completions 两个接口的 baseUrl 不一样
        const baseUrl = 'https://models.github.ai/catalog/'
        const newSdk = sdk.withOptions({ baseURL: baseUrl })
        const response = await newSdk.models.list()

        // @ts-ignore key is not typed
        return response?.body
          .map((model) => ({
            id: model.id,
            description: model.summary,
            object: 'model',
            owned_by: model.publisher
          }))
          .filter(isSupportedModel)
      }

      if (isOllamaProvider(this.provider)) {
        const baseUrl = withoutTrailingSlash(this.getBaseURL())
          .replace(/\/v1$/, '')
          .replace(/\/api$/, '')

        // @ts-ignore - Houdini specific handling
        if (window.api?.ollama?.list) {
          try {
            // @ts-ignore
            const data = await window.api.ollama.list({ host: baseUrl })
            if (data?.models && Array.isArray(data.models)) {
              return data.models.map((model) => ({
                id: model.name,
                object: 'model',
                owned_by: 'ollama'
              }))
            }
          } catch (e) {
            logger.error('Failed to list ollama models via IPC', e as Error)
          }
        }

        const response = await fetch(`${baseUrl}/api/tags`, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...this.defaultHeaders(),
            ...this.provider.extra_headers
          }
        })

        if (!response.ok) {
          throw new Error(`Ollama server returned ${response.status} ${response.statusText}`)
        }

        const data = await response.json()
        if (!data?.models || !Array.isArray(data.models)) {
          throw new Error('Invalid response from Ollama API: missing models array')
        }

        return data.models.map((model) => ({
          id: model.name,
          object: 'model',
          owned_by: 'ollama'
        }))
      }
      const response = await sdk.models.list()
      if (this.provider.id === 'together') {
        // @ts-ignore key is not typed
        return response?.body.map((model) => ({
          id: model.id,
          description: model.display_name,
          object: 'model',
          owned_by: model.organization
        }))
      }
      const models = response.data || []
      models.forEach((model) => {
        model.id = model.id.trim()
      })

      return models.filter(isSupportedModel)
    } catch (error) {
      logger.error('Error listing models:', error as Error)
      // 强化兜底：针对 ollama 发生异常时，直接尝试本地专用接口
      try {
        if (this.provider.id === 'ollama') {
          const host = this.provider.apiHost || 'http://localhost:11434'
          console.warn('[OpenAIBaseClient] ⚠️ Error fallback to window.api.ollama.listModels with host:', host)
          const raw = await (window as any)?.api?.ollama?.listModels?.({ host })
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {})
          const data = Array.isArray(parsed?.data) ? parsed.data : []
          const mapped = data
            .map((item: any) => {
              const name = (item?.id || '').trim()
              if (!name) return null
              return {
                id: name,
                object: 'model',
                owned_by: 'ollama',
                description: item?.description || item?.owned_by || name
              }
            })
            .filter(Boolean)
          return mapped as OpenAI.Models.Model[]
        }
      } catch (e) {
        console.warn('[OpenAIBaseClient] ⚠️ Error fallback to ollama.listModels failed:', e)
      }
      return []
    }
  }

  override async getSdkInstance() {
    if (this.sdkInstance) {
      return this.sdkInstance
    }

    let apiKeyForSdkInstance = this.apiKey
    let baseURLForSdkInstance = this.getBaseURL()
    logger.debug('baseURLForSdkInstance', { baseURLForSdkInstance })
    let headersForSdkInstance = {
      ...this.defaultHeaders(),
      ...this.provider.extra_headers
    }

    if (this.provider.id === 'copilot') {
      const defaultHeaders = store.getState().copilot.defaultHeaders
      const { token } = await window.api.copilot.getToken(defaultHeaders)
      // this.provider.apiKey不允许修改
      // this.provider.apiKey = token
      apiKeyForSdkInstance = token
      baseURLForSdkInstance = this.getBaseURL()
      headersForSdkInstance = {
        ...headersForSdkInstance,
        ...COPILOT_DEFAULT_HEADERS
      }
    }

    if (this.provider.id === 'azure-openai' || this.provider.type === 'azure-openai') {
      this.sdkInstance = new AzureOpenAI({
        dangerouslyAllowBrowser: true,
        apiKey: apiKeyForSdkInstance,
        apiVersion: this.provider.apiVersion,
        endpoint: normalizeAzureOpenAIEndpoint(this.provider.apiHost)
      }) as TSdkInstance
    } else {
      this.sdkInstance = new OpenAI({
        dangerouslyAllowBrowser: true,
        apiKey: apiKeyForSdkInstance,
        baseURL: baseURLForSdkInstance,
        defaultHeaders: headersForSdkInstance
      }) as TSdkInstance
    }
    return this.sdkInstance
  }

  override getTemperature(assistant: Assistant, model: Model): number | undefined {
    if (assistant.settings?.reasoning_effort && isClaudeReasoningModel(model)) {
      return undefined
    }
    return super.getTemperature(assistant, model)
  }

  override getTopP(assistant: Assistant, model: Model): number | undefined {
    if (assistant.settings?.reasoning_effort && isClaudeReasoningModel(model)) {
      return undefined
    }
    return super.getTopP(assistant, model)
  }

  /**
   * Get the provider specific parameters for the assistant
   * @param assistant - The assistant
   * @param model - The model
   * @returns The provider specific parameters
   */
  protected getProviderSpecificParameters(assistant: Assistant, model: Model) {
    const { maxTokens } = getAssistantSettings(assistant)

    if (this.provider.id === 'openrouter') {
      if (model.id.includes('deepseek-r1')) {
        return {
          include_reasoning: true
        }
      }
    }

    if (isOpenAIReasoningModel(model)) {
      return {
        max_tokens: undefined,
        max_completion_tokens: maxTokens
      }
    }

    return {}
  }

  /**
   * Get the reasoning effort for the assistant
   * @param assistant - The assistant
   * @param model - The model
   * @returns The reasoning effort
   */
  protected getReasoningEffort(assistant: Assistant, model: Model): ReasoningEffortOptionalParams {
    if (!isSupportedReasoningEffortOpenAIModel(model)) {
      return {}
    }

    const openAI = getStoreSetting('openAI') as SettingsState['openAI']
    const summaryText = openAI?.summaryText || 'off'

    let summary: string | undefined = undefined

    if (summaryText === 'off' || model.id.includes('o1-pro')) {
      summary = undefined
    } else {
      summary = summaryText
    }

    const reasoningEffort = assistant?.settings?.reasoning_effort
    if (!reasoningEffort) {
      return {}
    }

    if (isSupportedReasoningEffortOpenAIModel(model)) {
      return {
        reasoning: {
          effort: reasoningEffort as OpenAI.ReasoningEffort,
          summary: summary
        } as OpenAI.Reasoning
      }
    }

    return {}
  }
}
