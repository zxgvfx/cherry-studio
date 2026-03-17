import { loggerService } from '@logger'
import { formatAgentServerError } from '@renderer/utils/error'
import type {
  AddAgentForm,
  ApiModelsFilter,
  ApiModelsResponse,
  CreateAgentRequest,
  CreateAgentResponse,
  CreateAgentSessionResponse,
  CreateSessionForm,
  CreateSessionRequest,
  GetAgentResponse,
  GetAgentSessionResponse,
  ListAgentSessionsResponse,
  ListOptions,
  UpdateAgentForm,
  UpdateAgentRequest,
  UpdateAgentResponse,
  UpdateSessionForm,
  UpdateSessionRequest
} from '@types'
import {
  AgentServerErrorSchema,
  ApiModelsResponseSchema,
  CreateAgentResponseSchema,
  CreateAgentSessionResponseSchema,
  GetAgentResponseSchema,
  GetAgentSessionResponseSchema,
  ListAgentSessionsResponseSchema,
  type ListAgentsResponse,
  ListAgentsResponseSchema,
  objectEntries,
  objectKeys,
  UpdateAgentResponseSchema
} from '@types'
import type { Axios, AxiosRequestConfig } from 'axios'
import axios, { isAxiosError } from 'axios'
import { ZodError } from 'zod'

type ApiVersion = 'v1'

const logger = loggerService.withContext('AgentApiClient')

// const logger = loggerService.withContext('AgentClient')
const processError = (error: unknown, fallbackMessage: string) => {
  logger.error(fallbackMessage, error as Error)
  if (isAxiosError(error)) {
    const result = AgentServerErrorSchema.safeParse(error.response?.data)
    if (result.success) {
      return new Error(formatAgentServerError(result.data))
    }
  } else if (error instanceof ZodError) {
    return error
  }
  return new Error(fallbackMessage, { cause: error })
}

export const DEFAULT_SESSION_PAGE_SIZE = 20

export class AgentApiClient {
  private axios: Axios
  private apiVersion: ApiVersion = 'v1'
  constructor(config: AxiosRequestConfig, apiVersion?: ApiVersion) {
    if (!config.baseURL || !config.headers?.Authorization) {
      throw new Error('Please pass in baseUrl and Authroization header.')
    }
    if (config.baseURL.endsWith('/')) {
      throw new Error('baseURL should not end with /')
    }
    this.axios = axios.create(config)
    if (apiVersion) {
      this.apiVersion = apiVersion
    }
  }

  public agentPaths = {
    base: `/${this.apiVersion}/agents`,
    withId: (id: string) => `/${this.apiVersion}/agents/${id}`
  }

  public getSessionPaths = (agentId: string) => ({
    base: `/${this.apiVersion}/agents/${agentId}/sessions`,
    withId: (id: string) => `/${this.apiVersion}/agents/${agentId}/sessions/${id}`
  })

  public getSessionMessagesPaths = (agentId: string, sessionId: string) => ({
    base: `/${this.apiVersion}/agents/${agentId}/sessions/${sessionId}/messages`,
    withId: (id: number) => `/${this.apiVersion}/agents/${agentId}/sessions/${sessionId}/messages/${id}`
  })

  public getModelsPath = (props?: ApiModelsFilter) => {
    const base = `/${this.apiVersion}/models`
    if (!props) return base
    if (objectKeys(props).length > 0) {
      const params = objectEntries(props)
        .map(([key, value]) => `${key}=${value}`)
        .join('&')
      return `${base}?${params}`
    } else {
      return base
    }
  }

  public async reorderAgents(orderedIds: string[]): Promise<void> {
    const url = `${this.agentPaths.base}/reorder`
    try {
      await this.axios.put(url, { ordered_ids: orderedIds })
    } catch (error) {
      throw processError(error, 'Failed to reorder agents.')
    }
  }

  public async listAgents(options?: ListOptions): Promise<ListAgentsResponse> {
    const url = this.agentPaths.base
    try {
      const params = new URLSearchParams()
      if (options?.limit !== undefined) params.append('limit', String(options.limit))
      if (options?.offset !== undefined) params.append('offset', String(options.offset))
      if (options?.sortBy) params.append('sortBy', options.sortBy)
      if (options?.orderBy) params.append('orderBy', options.orderBy)

      const queryString = params.toString()
      const fullUrl = queryString ? `${url}?${queryString}` : url

      const response = await this.axios.get(fullUrl)
      const result = ListAgentsResponseSchema.safeParse(response.data)
      if (!result.success) {
        throw new Error('Not a valid Agents array.')
      }
      return result.data
    } catch (error) {
      throw processError(error, 'Failed to list agents.')
    }
  }

  public async createAgent(form: AddAgentForm): Promise<CreateAgentResponse> {
    const url = this.agentPaths.base
    try {
      const payload = form satisfies CreateAgentRequest
      const response = await this.axios.post(url, payload)
      const data = CreateAgentResponseSchema.parse(response.data)
      return data
    } catch (error) {
      throw processError(error, 'Failed to create agent.')
    }
  }

  public async getAgent(id: string): Promise<GetAgentResponse> {
    const url = this.agentPaths.withId(id)
    try {
      const response = await this.axios.get(url)
      const data = GetAgentResponseSchema.parse(response.data)
      if (data.id !== id) {
        throw new Error('Agent ID mismatch in response')
      }
      return data
    } catch (error) {
      throw processError(error, 'Failed to get agent.')
    }
  }

  public async deleteAgent(id: string): Promise<void> {
    const url = this.agentPaths.withId(id)
    try {
      await this.axios.delete(url)
    } catch (error) {
      throw processError(error, 'Failed to delete agent.')
    }
  }

  public async updateAgent(form: UpdateAgentForm): Promise<UpdateAgentResponse> {
    const url = this.agentPaths.withId(form.id)
    try {
      const payload = form satisfies UpdateAgentRequest
      const response = await this.axios.patch(url, payload)
      const data = UpdateAgentResponseSchema.parse(response.data)
      if (data.id !== form.id) {
        throw new Error('Agent ID mismatch in response')
      }
      return data
    } catch (error) {
      throw processError(error, 'Failed to updateAgent.')
    }
  }

  public async reorderSessions(agentId: string, orderedIds: string[]): Promise<void> {
    const url = `${this.getSessionPaths(agentId).base}/reorder`
    try {
      await this.axios.put(url, { ordered_ids: orderedIds })
    } catch (error) {
      throw processError(error, 'Failed to reorder sessions.')
    }
  }

  public async listSessions(agentId: string, options?: ListOptions): Promise<ListAgentSessionsResponse> {
    const url = this.getSessionPaths(agentId).base
    try {
      const response = await this.axios.get(url, { params: options })
      const result = ListAgentSessionsResponseSchema.safeParse(response.data)
      if (!result.success) {
        throw new Error('Not a valid Sessions array.')
      }
      return result.data
    } catch (error) {
      throw processError(error, 'Failed to list sessions.')
    }
  }

  public async createSession(agentId: string, session: CreateSessionForm): Promise<CreateAgentSessionResponse> {
    const url = this.getSessionPaths(agentId).base
    try {
      const payload = session satisfies CreateSessionRequest
      const response = await this.axios.post(url, payload)
      const data = CreateAgentSessionResponseSchema.parse(response.data)
      return data
    } catch (error) {
      throw processError(error, 'Failed to add session.')
    }
  }

  public async getSession(agentId: string, sessionId: string): Promise<GetAgentSessionResponse> {
    const url = this.getSessionPaths(agentId).withId(sessionId)
    try {
      const response = await this.axios.get(url)
      // const data = GetAgentSessionResponseSchema.parse(response.data)
      // TODO: enable validation
      const data = response.data
      if (sessionId !== data.id) {
        throw new Error('Session ID mismatch in response')
      }
      return data
    } catch (error) {
      throw processError(error, 'Failed to get session.')
    }
  }

  public async deleteSession(agentId: string, sessionId: string): Promise<void> {
    const url = this.getSessionPaths(agentId).withId(sessionId)
    try {
      await this.axios.delete(url)
    } catch (error) {
      throw processError(error, 'Failed to delete session.')
    }
  }

  public async deleteSessionMessage(agentId: string, sessionId: string, messageId: number): Promise<void> {
    const url = this.getSessionMessagesPaths(agentId, sessionId).withId(messageId)
    try {
      await this.axios.delete(url)
    } catch (error) {
      throw processError(error, 'Failed to delete session message.')
    }
  }

  public async updateSession(agentId: string, session: UpdateSessionForm): Promise<GetAgentSessionResponse> {
    const url = this.getSessionPaths(agentId).withId(session.id)
    try {
      const payload = session satisfies UpdateSessionRequest
      const response = await this.axios.patch(url, payload)
      const data = GetAgentSessionResponseSchema.parse(response.data)
      if (session.id !== data.id) {
        throw new Error('Session ID mismatch in response')
      }
      return data
    } catch (error) {
      throw processError(error, 'Failed to update session.')
    }
  }

  public async getModels(props?: ApiModelsFilter): Promise<ApiModelsResponse> {
    const url = this.getModelsPath(props)
    try {
      const response = await this.axios.get(url)
      const data = ApiModelsResponseSchema.parse(response.data)
      return data
    } catch (error) {
      // Houdini environment fix: get models from local Redux store when agent server is not available
      // @ts-ignore
      if (window.api) {
        logger.warn('AgentApiClient getModels failed (Houdini environment). Falling back to local providers. Error details:', [JSON.stringify(error, Object.getOwnPropertyNames(error))])
        
        try {
          // Access Redux store from window (exposed in store/index.ts)
          // @ts-ignore
          const store = window.store
          if (store) {
            const state = store.getState()
            const providers = state?.llm?.providers || []
            
            // Filter out centralized providers and only use active providers with valid API keys
            const activeProviders = providers.filter((provider: any) => {
              // Check if provider has API key (for providers that need it)
              const needsApiKey = !['ollama', 'openrouter', 'copilot'].includes(provider.id)
              if (needsApiKey && !provider.apiKey) return false
              
              // Check if provider has models
              return provider.models && provider.models.length > 0
            })
            
            // Convert local providers/models to API format, avoiding duplicates
            const seenModelIds = new Set<string>()
            const apiModels = activeProviders.flatMap((provider: any) => {
              return (provider.models || [])
                .filter((model: any) => {
                  // Skip if we've already seen this model ID
                  if (seenModelIds.has(model.id)) return false
                  seenModelIds.add(model.id)
                  return true
                })
                .map((model: any) => ({
                  id: model.id,
                  name: model.name || model.id,
                  provider: provider.id,
                  provider_name: provider.name,
                  object: 'model' as const,
                  created: Math.floor(Date.now() / 1000),
                  owned_by: 'system'
                }))
            })
            
            logger.info(`[Houdini] Returning ${apiModels.length} models from ${activeProviders.length} active providers`)
            return { 
              object: 'list', 
              data: apiModels, 
              total: apiModels.length 
            }
          } else {
            logger.error('[Houdini] Redux store not found on window object')
          }
        } catch (localError) {
          logger.error('[Houdini] Failed to get models from local providers:', localError as Error)
        }
        
        return { object: 'list', data: [], total: 0 }
      }
      throw processError(error, 'Failed to get models.')
    }
  }
}
