import { ExaClient } from '@agentic/exa'
import { loggerService } from '@logger'
import type { WebSearchState } from '@renderer/store/websearch'
import type { WebSearchProvider, WebSearchProviderResponse } from '@renderer/types'

import BaseWebSearchProvider from './BaseWebSearchProvider'

const logger = loggerService.withContext('ExaProvider')

export default class ExaProvider extends BaseWebSearchProvider {
  private exa: ExaClient | null = null

  constructor(provider: WebSearchProvider) {
    super(provider)
    if (!this.apiKey) {
      throw new Error('API key is required for Exa provider')
    }
    if (!this.apiHost) {
      throw new Error('API host is required for Exa provider')
    }
    // Only create ExaClient in non-Qt environment
    if (!this.isQt()) {
      this.exa = new ExaClient({ apiKey: this.apiKey, apiBaseUrl: this.apiHost })
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

      // In non-Qt environment, use ExaClient directly
      const response = await this.exa!.search({
        query,
        numResults: Math.max(1, websearch.maxResults),
        contents: {
          text: true
        }
      })

      return {
        query: response.autopromptString,
        results: response.results.slice(0, websearch.maxResults).map((result) => {
          return {
            title: result.title || 'No title',
            content: result.text || '',
            url: result.url || ''
          }
        })
      }
    } catch (error) {
      logger.error('Exa search failed:', error as Error)
      throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  private async searchViaProxy(query: string, websearch: WebSearchState): Promise<WebSearchProviderResponse> {
    const response = await this.proxyFetch(`${this.apiHost}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        ...this.defaultHeaders()
      },
      body: {
        query,
        numResults: Math.max(1, websearch.maxResults),
        contents: {
          text: true
        }
      },
      timeout: 30000
    })

    if (!response.success) {
      throw new Error(response.error || 'Exa search failed')
    }

    const result = response.data
    return {
      query: result.autopromptString || query,
      results: (result.results || []).slice(0, websearch.maxResults).map((item: any) => ({
        title: item.title || 'No title',
        content: item.text || '',
        url: item.url || ''
      }))
    }
  }
}
