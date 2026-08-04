import { loggerService } from '@logger'
import type { WebSearchState } from '@renderer/store/websearch'
import type { WebSearchProvider, WebSearchProviderResponse } from '@renderer/types'

const logger = loggerService.withContext('BaseWebSearchProvider')

// Check if running in Qt environment
export const isQtEnvironment = (): boolean => {
  if (typeof window === 'undefined') return false
  const hasQtApi = !!(window as any).qt?.api
  const hasQtNetwork = !!(window as any).qt?.network
  const hasQtWebChannel = !!(window as any).qt?.webChannelTransport
  const isNotElectron = !(window as any).electron && !(window as any).require
  return hasQtApi || hasQtNetwork || hasQtWebChannel || isNotElectron
}

// HTTP proxy for Qt environment to bypass CORS
export const httpProxyFetch = async (
  url: string,
  options?: {
    method?: 'GET' | 'POST'
    headers?: Record<string, string>
    body?: any
    timeout?: number
    auth?: { username: string; password?: string }
  }
): Promise<{ success: boolean; data?: any; error?: string; status?: number }> => {
  const method = options?.method || 'GET'
  logger.info(`[httpProxyFetch] ${method} ${url}, isQt: ${isQtEnvironment()}`)

  const httpProxyApi = (window as any).api?.httpProxy
  if (httpProxyApi) {
    try {
      const config = {
        url,
        headers: options?.headers,
        timeout: options?.timeout || 30000,
        auth: options?.auth
      }

      let result
      if (method === 'POST') {
        result = await httpProxyApi.post({ ...config, body: options?.body })
      } else {
        result = await httpProxyApi.get(config)
      }

      logger.info(`[httpProxyFetch] Proxy result: success=${result?.success}`)
      return result || { success: false, error: 'HTTP proxy returned empty result' }
    } catch (err: any) {
      logger.error(`[httpProxyFetch] Proxy error:`, err)
      return { success: false, error: err.message }
    }
  }

  if (!isQtEnvironment()) {
    // Fallback for tests or environments without preload APIs
    try {
      const headers = { ...options?.headers }
      if (options?.auth?.username) {
        headers.Authorization = `Basic ${btoa(`${options.auth.username}:${options.auth.password || ''}`)}`
      }

      const fetchOptions: RequestInit = {
        method,
        headers
      }
      if (options?.body && method === 'POST') {
        fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      }
      const response = await fetch(url, fetchOptions)
      const data = await response.json().catch(() => response.text())
      return { success: response.ok, data, status: response.status }
    } catch (err: any) {
      logger.error(`[httpProxyFetch] Fetch error:`, err)
      return { success: false, error: err.message }
    }
  }

  if (!httpProxyApi) {
    logger.error(`[httpProxyFetch] HTTP proxy API not available!`)
    return { success: false, error: 'HTTP proxy API not available' }
  }

  try {
    const config = {
      url,
      headers: options?.headers,
      timeout: options?.timeout || 30000,
      auth: options?.auth
    }

    let result
    if (method === 'POST') {
      result = await httpProxyApi.post({ ...config, data: options?.body })
    } else {
      result = await httpProxyApi.get(config)
    }

    logger.info(`[httpProxyFetch] Qt proxy result: success=${result?.success}`)
    return result || { success: false, error: 'HTTP proxy returned empty result' }
  } catch (err: any) {
    logger.error(`[httpProxyFetch] Qt proxy error:`, err)
    return { success: false, error: err.message }
  }
}

export default abstract class BaseWebSearchProvider {
  // @ts-ignore this
  protected provider: WebSearchProvider
  protected apiHost?: string
  protected apiKey: string

  constructor(provider: WebSearchProvider) {
    this.provider = provider
    this.apiHost = this.getApiHost()
    this.apiKey = this.getApiKey()
  }

  abstract search(
    query: string,
    websearch: WebSearchState,
    httpOptions?: RequestInit
  ): Promise<WebSearchProviderResponse>

  public getApiHost() {
    return this.provider.apiHost
  }

  public defaultHeaders() {
    return {
      'HTTP-Referer': 'https://cherry-ai.com',
      'X-Title': 'Cherry Studio'
    }
  }

  public getApiKey() {
    const keys = this.provider.apiKey?.split(',').map((key) => key.trim()) || []
    const keyName = `web-search-provider:${this.provider.id}:last_used_key`

    if (keys.length === 1) {
      return keys[0]
    }

    const lastUsedKey = window.keyv.get(keyName)
    if (!lastUsedKey) {
      window.keyv.set(keyName, keys[0])
      return keys[0]
    }

    const currentIndex = keys.indexOf(lastUsedKey)
    const nextIndex = (currentIndex + 1) % keys.length
    const nextKey = keys[nextIndex]
    window.keyv.set(keyName, nextKey)

    return nextKey
  }

  // Helper to check if running in Qt
  protected isQt(): boolean {
    return isQtEnvironment()
  }

  // Helper for making HTTP requests with Qt proxy support
  protected async proxyFetch(
    url: string,
    options?: {
      method?: 'GET' | 'POST'
      headers?: Record<string, string>
      body?: any
      timeout?: number
    }
  ): Promise<{ success: boolean; data?: any; error?: string; status?: number }> {
    return httpProxyFetch(url, options)
  }
}
