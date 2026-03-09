import { TavilyClient } from '@agentic/tavily'
import { loggerService } from '@logger'
import type { WebSearchState } from '@renderer/store/websearch'
import type { WebSearchProvider, WebSearchProviderResponse } from '@renderer/types'

import BaseWebSearchProvider from './BaseWebSearchProvider'

const logger = loggerService.withContext('TavilyProvider')

export default class TavilyProvider extends BaseWebSearchProvider {
  private tvly: TavilyClient | null = null

  constructor(provider: WebSearchProvider) {
    super(provider)
    if (!this.apiKey) {
      throw new Error('API key is required for Tavily provider')
    }
    if (!this.apiHost) {
      throw new Error('API host is required for Tavily provider')
    }
    // Only create TavilyClient in non-Qt environment
    if (!this.isQt()) {
      this.tvly = new TavilyClient({ apiKey: this.apiKey, apiBaseUrl: this.apiHost })
    }
  }

  public async search(query: string, websearch: WebSearchState): Promise<WebSearchProviderResponse> {
    try {
      if (!query.trim()) {
        throw new Error('Search query cannot be empty')
      }

      // In Qt environment, use HTTP proxy
      if (this.isQt()) {
        return await this.searchViaProxy(query, websearch)
      }

      // In non-Qt environment, use TavilyClient directly
      const result = await this.tvly!.search({
        query,
        max_results: Math.max(1, websearch.maxResults)
      })
      return {
        query: result.query,
        results: result.results.slice(0, websearch.maxResults).map((result) => {
          return {
            title: result.title || 'No title',
            content: result.content || '',
            url: result.url || ''
          }
        })
      }
    } catch (error) {
      logger.error('Tavily search failed:', error as Error)
      throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  private async searchViaProxy(query: string, websearch: WebSearchState): Promise<WebSearchProviderResponse> {
    const response = await this.proxyFetch(`${this.apiHost}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.defaultHeaders()
      },
      body: {
        api_key: this.apiKey,
        query,
        max_results: Math.max(1, websearch.maxResults)
      },
      timeout: 30000
    })

    if (!response.success) {
      throw new Error(response.error || 'Tavily search failed')
    }

    const result = response.data
    return {
      query: result.query || query,
      results: (result.results || []).slice(0, websearch.maxResults).map((item: any) => ({
        title: item.title || 'No title',
        content: item.content || '',
        url: item.url || ''
      }))
    }
  }
}
