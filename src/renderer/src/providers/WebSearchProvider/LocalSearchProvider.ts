import { loggerService } from '@logger'
import store from '@renderer/store'
import type { WebSearchState } from '@renderer/store/websearch'
import type { WebSearchProvider, WebSearchProviderResponse, WebSearchProviderResult } from '@renderer/types'
import { isAbortError } from '@renderer/utils/error'
import { fetchWebContent, noContent } from '@renderer/utils/fetch'

import BaseWebSearchProvider from './BaseWebSearchProvider'

const logger = loggerService.withContext('LocalSearchProvider')

export interface SearchItem {
  title: string
  url: string
}

export default class LocalSearchProvider extends BaseWebSearchProvider {
  constructor(provider: WebSearchProvider) {
    if (!provider || !provider.url) {
      throw new Error('Provider URL is required')
    }
    super(provider)
  }

  public async search(
    query: string,
    websearch: WebSearchState,
    httpOptions?: RequestInit
  ): Promise<WebSearchProviderResponse> {
    const language = store.getState().settings.language
    try {
      if (!query.trim()) {
        throw new Error('Search query cannot be empty')
      }
      if (!this.provider.url) {
        throw new Error('Provider URL is required')
      }

      const cleanedQuery = query.split('\r\n')[1] ?? query
      const url = this.provider.url.replace('%s', encodeURIComponent(cleanedQuery))

      logger.info(`[LocalSearchProvider] Using backend search for URL: ${url}`)
      const response = await (window as any).api?.network?.search?.({
        provider: this.provider.id as 'local-google' | 'local-bing' | 'local-baidu',
        url,
        language: language ? language.split('-')[0] : undefined,
        timeout: 30000
      })

      if (!response?.success) {
        throw new Error(`Failed to fetch search page: ${response?.error || 'Unknown error'}`)
      }

      const searchItems = (response.results || []).slice(0, websearch.maxResults)

      const validItems = searchItems
        .filter((item) => item.url.startsWith('http') || item.url.startsWith('https'))
        .slice(0, websearch.maxResults)

      logger.info(`[LocalSearchProvider] Found ${validItems.length} valid search items`)

      // Fetch content for each URL concurrently
      // fetchWebContent supports Qt environment via httpProxy.get
      const fetchPromises = validItems.map(async (item) => {
        return await fetchWebContent(item.url, 'markdown', this.provider.usingBrowser, httpOptions, true)
      })

      const results: WebSearchProviderResult[] = await Promise.all(fetchPromises)

      return {
        query: query,
        results: results.filter((result) => result.content != noContent)
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      logger.error('Local search failed:', error as Error)
      throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  protected applyLanguageFilter(query: string, _language: string): string {
    return query
  }

  // oxlint-disable-next-line @typescript-eslint/no-unused-vars
  protected parseValidUrls(_htmlContent: string): SearchItem[] {
    throw new Error('Not implemented')
  }
}
