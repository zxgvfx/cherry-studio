import { loggerService } from '@logger'
import { isSupportedModel } from '@renderer/config/models'
import { Model, Provider } from '@renderer/types'
import OpenAI from 'openai'

import { OpenAIAPIClient } from '../openai/OpenAIApiClient'

const logger = loggerService.withContext('PPIOAPIClient')
export class PPIOAPIClient extends OpenAIAPIClient {
  constructor(provider: Provider) {
    super(provider)
  }

  // oxlint-disable-next-line @typescript-eslint/no-unused-vars
  override getClientCompatibilityType(_model?: Model): string[] {
    return ['OpenAIAPIClient']
  }

  override async listModels(): Promise<OpenAI.Models.Model[]> {
    try {
      console.log('[PPIOAPIClient] listModels called for provider:', this.provider.id);
      
      // 在Houdini环境中，使用window.api.models.list
      const isHoudiniEnv = !!(globalThis as any)?.isHoudini || 
                           !!(globalThis as any)?.houdini || 
                           !!(globalThis as any)?.qt || 
                           !!(globalThis as any)?.QWebChannel ||
                           !!(globalThis as any)?.hostBridge;
      
      if (isHoudiniEnv) {
        console.log('[PPIOAPIClient] Using Houdini environment, calling window.api.models.list');
        const host = this.provider.apiHost || 'https://api.ppio.ai'
        const modelUrl = `${host.replace(/\/$/, '')}/v1/models`
        
        const response = await window.api?.models?.list?.({
          url: modelUrl,
          method: 'GET',
          apiKey: this.provider.apiKey,
          fallback: { object: 'list', data: [] }
        });
        
        const data = Array.isArray(response?.data) ? response.data : []
        const models: OpenAI.Models.Model[] = data.map((item: any) => ({
          id: item.id || item.name,
          object: 'model' as const,
          owned_by: item.owned_by || item.publisher || item.organization || 'ppio',
          created: item.created || Date.now()
        }));
        
        console.log('[PPIOAPIClient] Houdini models result:', models.length, 'models');
        return models.filter(isSupportedModel);
      }
      
      const sdk = await this.getSdkInstance()

      // PPIO requires three separate requests to get all model types
      const [chatModelsResponse, embeddingModelsResponse, rerankerModelsResponse] = await Promise.all([
        // Chat/completion models
        sdk.request({
          method: 'get',
          path: '/models'
        }),
        // Embedding models
        sdk.request({
          method: 'get',
          path: '/models?model_type=embedding'
        }),
        // Reranker models
        sdk.request({
          method: 'get',
          path: '/models?model_type=reranker'
        })
      ])

      // Extract models from all responses
      // @ts-ignore - PPIO response structure may not be typed
      const allModels = [
        ...((chatModelsResponse as any)?.data || []),
        ...((embeddingModelsResponse as any)?.data || []),
        ...((rerankerModelsResponse as any)?.data || [])
      ]

      // Process and standardize model data
      const processedModels = allModels.map((model: any) => ({
        id: model.id || model.name,
        description: model.description || model.display_name || model.summary,
        object: 'model' as const,
        owned_by: model.owned_by || model.publisher || model.organization || 'ppio',
        created: model.created || Date.now()
      }))

      // Clean up model IDs and filter supported models
      processedModels.forEach((model) => {
        if (model.id) {
          model.id = model.id.trim()
        }
      })

      return processedModels.filter(isSupportedModel)
    } catch (error) {
      logger.error('Error listing PPIO models:', error as Error)
      return []
    }
  }
}
