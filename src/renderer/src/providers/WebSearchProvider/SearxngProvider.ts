import { loggerService } from '@logger'
import type { WebSearchState } from '@renderer/store/websearch'
import type { WebSearchProvider, WebSearchProviderResponse } from '@renderer/types'
import { fetchWebContent, noContent } from '@renderer/utils/fetch'

import BaseWebSearchProvider, { httpProxyFetch, isQtEnvironment } from './BaseWebSearchProvider'

const logger = loggerService.withContext('SearxngProvider')

// HTTP proxy wrapper for SearxNG specific needs (with auth support)
const httpProxyGet = async (config: {
  url: string
  headers?: Record<string, string>
  timeout?: number
  auth?: { username: string; password?: string }
}): Promise<{ success: boolean; data?: any; error?: string; status?: number }> => {
  logger.info(`[httpProxyGet] Request: ${config.url}, isQt: ${isQtEnvironment()}`)
  return httpProxyFetch(config.url, {
    method: 'GET',
    headers: config.headers,
    timeout: config.timeout,
    auth: config.auth
  })
}

export default class SearxngProvider extends BaseWebSearchProvider {
  private engines: string[] = []
  private readonly basicAuthUsername?: string
  private readonly basicAuthPassword?: string
  private isInitialized = false
  private initFailed = false // Track if initialization has permanently failed
  private initPromise: Promise<void> | null = null // Prevent duplicate init calls

  constructor(provider: WebSearchProvider) {
    super(provider)
    if (!provider.apiHost) {
      throw new Error('API host is required for SearxNG provider')
    }

    this.apiHost = provider.apiHost
    this.basicAuthUsername = provider.basicAuthUsername
    this.basicAuthPassword = provider.basicAuthPassword ? provider.basicAuthPassword : ''
    // Don't block constructor, init in background
    this.initEngines().catch((err) => {
      logger.error('Failed to initialize SearxNG engines:', err)
      this.initFailed = true
    })
  }

  private async initEngines(): Promise<void> {
    // Prevent duplicate concurrent initialization
    if (this.initPromise) {
      return this.initPromise
    }

    // If already initialized or permanently failed, don't retry
    if (this.isInitialized) {
      return
    }

    this.initPromise = this._doInitEngines()
    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  private async _doInitEngines(): Promise<void> {
    try {
      logger.info(`Initializing SearxNG with API host: ${this.apiHost}`)
      const auth = this.basicAuthUsername
        ? {
            username: this.basicAuthUsername,
            password: this.basicAuthPassword ? this.basicAuthPassword : ''
          }
        : undefined

      // Use HTTP proxy to bypass CORS in Qt environment
      const response = await httpProxyGet({
        url: `${this.apiHost}/config`,
        timeout: 5000,
        auth
      })

      if (!response.success) {
        throw new Error(response.error || 'Failed to fetch SearxNG config')
      }

      if (!response.data) {
        throw new Error('Empty response from SearxNG config endpoint')
      }

      if (!Array.isArray(response.data.engines)) {
        throw new Error('Invalid response format: "engines" property not found or not an array')
      }

      const allEngines = response.data.engines
      logger.info(`Found ${allEngines.length} total engines in SearxNG`)

      // Log all engine categories for debugging
      const enabledEngines = allEngines.filter((e: any) => e.enabled)
      logger.info(
        `Enabled engines: ${enabledEngines.map((e: any) => `${e.name}(${e.categories?.join(',')})`).join(', ')}`
      )

      // Relaxed filter: accept engines that are enabled and have 'general' OR 'web' category
      // Or if no such engines found, accept any enabled engine
      let filteredEngines = allEngines.filter(
        (engine: { enabled: boolean; categories: string[]; name: string }) =>
          engine.enabled &&
          Array.isArray(engine.categories) &&
          (engine.categories.includes('general') || engine.categories.includes('web'))
      )

      // If no general/web engines found, try to use any enabled engine
      if (filteredEngines.length === 0) {
        logger.warn('No general/web engines found, falling back to all enabled engines')
        filteredEngines = allEngines.filter((engine: { enabled: boolean }) => engine.enabled)
      }

      this.engines = filteredEngines.map((engine: { name: string }) => engine.name)

      if (this.engines.length === 0) {
        throw new Error('No enabled search engines found in SearxNG configuration')
      }

      this.isInitialized = true
      this.initFailed = false
      logger.info(`SearxNG initialized successfully with ${this.engines.length} engines: ${this.engines.join(', ')}`)
    } catch (err) {
      this.isInitialized = false
      this.initFailed = true

      logger.error('Failed to fetch SearxNG engine configuration:', err as Error)
      throw new Error(`Failed to initialize SearxNG: ${err}`)
    }
  }

  /**
   * Perform search through backend HTTP proxy
   */
  private async doSearch(
    query: string
  ): Promise<{ results: Array<{ url: string; title?: string; content?: string }> }> {
    logger.info(`[doSearch] Starting search for query: "${query}", isQt: ${isQtEnvironment()}`)

    const searchUrl = `${this.apiHost}/search`
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      language: 'auto'
    })
    if (this.engines.length > 0) {
      params.append('engines', this.engines.join(','))
    }

    const fullUrl = `${searchUrl}?${params.toString()}`
    logger.info(`[doSearch] Proxy request URL: ${fullUrl}`)

    try {
      const response = await httpProxyGet({
        url: fullUrl,
        timeout: 30000,
        auth: this.basicAuthUsername
          ? { username: this.basicAuthUsername, password: this.basicAuthPassword }
          : undefined
      })

      logger.info(`[doSearch] Proxy response: success=${response.success}, hasData=${!!response.data}`)

      if (!response.success) {
        throw new Error(response.error || 'Search request failed')
      }

      return response.data
    } catch (err) {
      logger.error(`[doSearch] Proxy search error:`, err as Error)
      throw err
    }
  }

  public async search(query: string, websearch: WebSearchState): Promise<WebSearchProviderResponse> {
    try {
      if (!query) {
        throw new Error('Search query cannot be empty')
      }

      // Check if initialization permanently failed
      if (this.initFailed && !this.isInitialized) {
        throw new Error(
          `SearxNG is not available. Please check if the SearxNG server at ${this.apiHost} is running and accessible.`
        )
      }

      // Wait for initialization if it's the first search (with timeout protection)
      if (!this.isInitialized && !this.initFailed) {
        try {
          // Add a timeout wrapper to prevent hanging
          const initTimeout = new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error('SearxNG initialization timeout')), 8000)
          })
          await Promise.race([this.initEngines(), initTimeout])
        } catch (initError) {
          this.initFailed = true
          throw new Error(
            `SearxNG initialization failed: ${initError instanceof Error ? initError.message : 'Unknown error'}. Please check if the server at ${this.apiHost} is running.`
          )
        }
      }

      const result = await this.doSearch(query)

      if (!result || !Array.isArray(result.results)) {
        throw new Error('Invalid search results from SearxNG')
      }

      const validItems = result.results
        .filter((item: any) => item.url?.startsWith('http') || item.url?.startsWith('https'))
        .slice(0, websearch.maxResults)

      const useFullContent = this.provider.contentFetchMode === 'full'

      logger.info(
        `[search] contentFetchMode=${this.provider.contentFetchMode}, fullContent=${useFullContent}, results=${validItems.length}`
      )

      if (!useFullContent) {
        // Snippet mode: use SearXNG snippets + include image URLs when available
        logger.info(`[search] Using SearxNG snippets for ${validItems.length} results`)
        const results = validItems.map((item: any) => {
          let content = item.content || item.snippet || item.description || ''
          // Append image URL from SearXNG result if available
          const imgUrl = item.img_src || item.thumbnail_src || item.thumbnail
          if (imgUrl) {
            content += `\n\n![${item.title || 'image'}](${imgUrl})`
          }
          return {
            title: item.title || item.url,
            url: item.url,
            content: content || noContent
          }
        })
        return {
          query: query,
          results: results.filter((r) => r.content !== noContent)
        }
      }

      // Full content mode: fetch full webpage content for each URL concurrently
      // fetchWebContent supports Qt environment via httpProxy.get
      logger.info(`[search] Fetching full content for ${validItems.length} URLs`)
      const fetchPromises = validItems.map(async (item: any) => {
        return await fetchWebContent(item.url, 'markdown', this.provider.usingBrowser, {}, true)
      })

      const results = await Promise.all(fetchPromises)

      return {
        query: query,
        results: results.filter((result) => result.content != noContent)
      }
    } catch (error) {
      logger.error('Searxng search failed:', error as Error)
      throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
}
