import { loggerService } from '@logger'
import { CHERRYAI_PROVIDER } from '@renderer/config/providers'
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
  // @ts-ignore
  private _isHoudini = typeof window !== 'undefined' && typeof window.api !== 'undefined'

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

  /**
   * In Houdini (QtWebEngine), XHR property overrides via Object.defineProperty
   * are unreliable on native XHR objects, causing Axios promises to never resolve.
   * This method bypasses Axios/XHR entirely and calls the Qt bridge directly.
   */
  private async houdiniRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    // @ts-ignore
    const proxy = window.qt?.api?.agentApiProxy
    if (!proxy) {
      throw new Error('Qt agent API bridge not available')
    }
    const responseStr: string = await proxy(JSON.stringify({ method, path, body: body ?? null }))
    const data = JSON.parse(responseStr)
    if (data && typeof data === 'object' && 'error' in data && data.error) {
      const msg = typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error)
      throw new Error(msg)
    }
    return data
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
      if (this._isHoudini) {
        await this.houdiniRequest('PUT', url, { ordered_ids: orderedIds })
        return
      }
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

      let responseData: unknown
      if (this._isHoudini) {
        responseData = await this.houdiniRequest('GET', fullUrl)
      } else {
        const response = await this.axios.get(fullUrl)
        responseData = response.data
      }
      const result = ListAgentsResponseSchema.safeParse(responseData)
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
      let responseData: unknown
      if (this._isHoudini) {
        responseData = await this.houdiniRequest('POST', url, payload)
      } else {
        const response = await this.axios.post(url, payload)
        responseData = response.data
      }
      return CreateAgentResponseSchema.parse(responseData)
    } catch (error) {
      throw processError(error, 'Failed to create agent.')
    }
  }

  public async getAgent(id: string): Promise<GetAgentResponse> {
    const url = this.agentPaths.withId(id)
    try {
      let responseData: unknown
      if (this._isHoudini) {
        responseData = await this.houdiniRequest('GET', url)
      } else {
        const response = await this.axios.get(url)
        responseData = response.data
      }
      const data = GetAgentResponseSchema.parse(responseData)
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
      if (this._isHoudini) {
        await this.houdiniRequest('DELETE', url)
        return
      }
      await this.axios.delete(url)
    } catch (error) {
      throw processError(error, 'Failed to delete agent.')
    }
  }

  public async updateAgent(form: UpdateAgentForm): Promise<UpdateAgentResponse> {
    const url = this.agentPaths.withId(form.id)
    try {
      const payload = form satisfies UpdateAgentRequest
      let responseData: unknown
      if (this._isHoudini) {
        responseData = await this.houdiniRequest('PATCH', url, payload)
      } else {
        const response = await this.axios.patch(url, payload)
        responseData = response.data
      }
      const data = UpdateAgentResponseSchema.parse(responseData)
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
      if (this._isHoudini) {
        await this.houdiniRequest('PUT', url, { ordered_ids: orderedIds })
        return
      }
      await this.axios.put(url, { ordered_ids: orderedIds })
    } catch (error) {
      throw processError(error, 'Failed to reorder sessions.')
    }
  }

  public async listSessions(agentId: string, options?: ListOptions): Promise<ListAgentSessionsResponse> {
    const url = this.getSessionPaths(agentId).base
    try {
      let responseData: unknown
      if (this._isHoudini) {
        const params = new URLSearchParams()
        if (options?.limit !== undefined) params.append('limit', String(options.limit))
        if (options?.offset !== undefined) params.append('offset', String(options.offset))
        if (options?.sortBy) params.append('sortBy', options.sortBy)
        if (options?.orderBy) params.append('orderBy', options.orderBy)
        const qs = params.toString()
        responseData = await this.houdiniRequest('GET', qs ? `${url}?${qs}` : url)
      } else {
        const response = await this.axios.get(url, { params: options })
        responseData = response.data
      }
      const result = ListAgentSessionsResponseSchema.safeParse(responseData)
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
      let responseData: unknown
      if (this._isHoudini) {
        responseData = await this.houdiniRequest('POST', url, payload)
      } else {
        const response = await this.axios.post(url, payload)
        responseData = response.data
      }
      return CreateAgentSessionResponseSchema.parse(responseData)
    } catch (error) {
      throw processError(error, 'Failed to add session.')
    }
  }

  public async getSession(agentId: string, sessionId: string): Promise<GetAgentSessionResponse> {
    const url = this.getSessionPaths(agentId).withId(sessionId)
    try {
      let data: any
      if (this._isHoudini) {
        data = await this.houdiniRequest('GET', url)
      } else {
        const response = await this.axios.get(url)
        data = response.data
      }
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
      if (this._isHoudini) {
        await this.houdiniRequest('DELETE', url)
        return
      }
      await this.axios.delete(url)
    } catch (error) {
      throw processError(error, 'Failed to delete session.')
    }
  }

  public async deleteSessionMessage(agentId: string, sessionId: string, messageId: number): Promise<void> {
    const url = this.getSessionMessagesPaths(agentId, sessionId).withId(messageId)
    try {
      if (this._isHoudini) {
        await this.houdiniRequest('DELETE', url)
        return
      }
      await this.axios.delete(url)
    } catch (error) {
      throw processError(error, 'Failed to delete session message.')
    }
  }

  public async updateSession(agentId: string, session: UpdateSessionForm): Promise<GetAgentSessionResponse> {
    const url = this.getSessionPaths(agentId).withId(session.id)
    try {
      const payload = session satisfies UpdateSessionRequest
      let responseData: unknown
      if (this._isHoudini) {
        responseData = await this.houdiniRequest('PATCH', url, payload)
      } else {
        const response = await this.axios.patch(url, payload)
        responseData = response.data
      }
      const data = GetAgentSessionResponseSchema.parse(responseData)
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
      if (!this._isHoudini || (data.data && data.data.length > 0)) {
        return data
      }
      logger.info('[Houdini] Backend returned empty model list, falling back to local Redux providers')
    } catch (error) {
      if (!this._isHoudini) {
        throw processError(error, 'Failed to get models.')
      }
      logger.warn(
        'AgentApiClient getModels failed (Houdini environment). Falling back to local providers.',
        error as Error
      )
    }

    try {
      // @ts-ignore
      const store = window.store
      if (store) {
        const state = store.getState()
        const providers = state?.llm?.providers || []

        const enabledProviders = providers.filter(
          (provider: any) => provider?.enabled && Array.isArray(provider.models) && provider.models.length > 0
        )
        const localProviders = enabledProviders.some((provider: any) => provider.id === CHERRYAI_PROVIDER.id)
          ? enabledProviders
          : enabledProviders.concat(CHERRYAI_PROVIDER)

        const filteredProviders = localProviders.filter((provider: any) => {
          if (!Array.isArray(provider.models) || provider.models.length === 0) {
            return false
          }

          if (!props?.providerType) {
            return true
          }

          if (props.providerType === 'anthropic') {
            return provider.type === 'anthropic' || !!provider.anthropicApiHost?.trim()
          }

          return provider.type === props.providerType
        })

        const uniqueModels = new Map<string, any>()
        for (const provider of filteredProviders) {
          for (const model of provider.models || []) {
            const fullModelId = `${provider.id}:${model.id}`
            if (uniqueModels.has(fullModelId)) {
              continue
            }

            uniqueModels.set(fullModelId, {
              id: fullModelId,
              name: model.name || model.id,
              provider: provider.id,
              provider_name: provider.name,
              provider_type: provider.type,
              provider_model_id: model.id,
              object: 'model' as const,
              created: Math.floor(Date.now() / 1000),
              owned_by: model.owned_by || provider.name || provider.id
            })
          }
        }

        const allModels = Array.from(uniqueModels.values())
        const offset = props?.offset || 0
        const total = allModels.length
        const data =
          props?.limit !== undefined ? allModels.slice(offset, offset + props.limit) : allModels.slice(offset)

        logger.info(
          `[Houdini] Returning ${data.length} models from ${filteredProviders.length} enabled local providers`
        )
        return {
          object: 'list',
          data,
          total,
          offset,
          limit: props?.limit
        }
      } else {
        logger.error('[Houdini] Redux store not found on window object')
      }
    } catch (localError) {
      logger.error('[Houdini] Failed to get models from local providers:', localError as Error)
    }

    return { object: 'list', data: [], total: 0 }
  }
}
