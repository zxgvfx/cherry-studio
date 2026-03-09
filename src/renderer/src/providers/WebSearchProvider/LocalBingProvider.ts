import { loggerService } from '@logger'

import type { SearchItem } from './LocalSearchProvider'
import LocalSearchProvider from './LocalSearchProvider'

const logger = loggerService.withContext('LocalBingProvider')

export default class LocalBingProvider extends LocalSearchProvider {
  protected parseValidUrls(htmlContent: string): SearchItem[] {
    const results: SearchItem[] = []
    const seen = new Set<string>()

    try {
      const parser = new DOMParser()
      const doc = parser.parseFromString(htmlContent, 'text/html')

      // Strategy 1: Standard Bing results
      doc.querySelectorAll('#b_results h2').forEach((item) => {
        const node = item.querySelector('a')
        if (node) {
          const decodedUrl = this.decodeBingUrl(node.href)
          this._addResult(results, seen, node.textContent || '', decodedUrl)
        }
      })

      // Strategy 2: Bing result items with <li class="b_algo">
      if (results.length === 0) {
        doc.querySelectorAll('li.b_algo').forEach((item) => {
          const link = item.querySelector('a[href^="http"]') as HTMLAnchorElement | null
          if (link) {
            const title = item.querySelector('h2')?.textContent || link.textContent || ''
            this._addResult(results, seen, title, this.decodeBingUrl(link.href))
          }
        })
      }

      // Strategy 3: Fallback — any link with title-like parent
      if (results.length === 0) {
        doc.querySelectorAll('a[href^="http"]').forEach((el) => {
          const link = el as HTMLAnchorElement
          const text = link.textContent?.trim() || ''
          if (text.length > 5 && link.href) {
            this._addResult(results, seen, text, this.decodeBingUrl(link.href))
          }
        })
      }

      logger.info(`[parseValidUrls] Parsed ${results.length} results from Bing HTML`)
    } catch (error) {
      logger.error('Failed to parse Bing search HTML:', error as Error)
    }
    return results
  }

  private _addResult(results: SearchItem[], seen: Set<string>, title: string, url: string): void {
    if (!url.startsWith('http') || seen.has(url)) return
    if (url.includes('bing.com/search') || url.includes('bing.com/ck/a') || url.includes('login.microsoftonline')) return
    seen.add(url)
    results.push({ title: title || url, url })
  }

  /**
   * Decode Bing redirect URL to get the actual URL
   * Bing URLs are in format: https://www.bing.com/ck/a?...&u=a1aHR0cHM6Ly93d3cudG91dGlhby5jb20...
   * The 'u' parameter contains Base64 encoded URL with 'a1' prefix
   */
  private decodeBingUrl(bingUrl: string): string {
    try {
      const url = new URL(bingUrl)
      const encodedUrl = url.searchParams.get('u')

      if (!encodedUrl) {
        return bingUrl // Return original if no 'u' parameter
      }

      // Remove the 'a1' prefix and decode Base64
      const base64Part = encodedUrl.substring(2)
      const decodedUrl = atob(base64Part)

      // Validate the decoded URL
      if (decodedUrl.startsWith('http')) {
        return decodedUrl
      }

      return bingUrl // Return original if decoded URL is invalid
    } catch (error) {
      logger.warn('Failed to decode Bing URL:', error as Error)
      return bingUrl // Return original URL if decoding fails
    }
  }
}
