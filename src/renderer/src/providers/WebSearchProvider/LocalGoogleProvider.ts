import { loggerService } from '@logger'

import type { SearchItem } from './LocalSearchProvider'
import LocalSearchProvider from './LocalSearchProvider'

const logger = loggerService.withContext('LocalGoogleProvider')

export default class LocalGoogleProvider extends LocalSearchProvider {
  protected parseValidUrls(htmlContent: string): SearchItem[] {
    const results: SearchItem[] = []
    const seen = new Set<string>()

    try {
      const parser = new DOMParser()
      const doc = parser.parseFromString(htmlContent, 'text/html')

      // Strategy 1: JS-rendered page (Electron browser window)
      doc.querySelectorAll('#search .MjjYud').forEach((item) => {
        const title = item.querySelector('h3')
        const link = item.querySelector('a')
        if (title && link?.href) {
          this._addResult(results, seen, title.textContent || '', link.href)
        }
      })

      // Strategy 2: Raw HTML — Google wraps results in <div class="g"> or data-ved links
      if (results.length === 0) {
        doc.querySelectorAll('div.g, div[data-ved]').forEach((item) => {
          const title = item.querySelector('h3')
          const link = item.querySelector('a[href^="http"]') as HTMLAnchorElement | null
          if (title && link?.href) {
            this._addResult(results, seen, title.textContent || '', link.href)
          }
        })
      }

      // Strategy 3: Fallback — any <a> with h3 child anywhere on the page
      if (results.length === 0) {
        doc.querySelectorAll('a[href^="http"]').forEach((link) => {
          const h3 = link.querySelector('h3')
          if (h3 && (link as HTMLAnchorElement).href) {
            this._addResult(results, seen, h3.textContent || '', (link as HTMLAnchorElement).href)
          }
        })
      }

      logger.info(`[parseValidUrls] Parsed ${results.length} results from Google HTML`)
    } catch (error) {
      logger.error('Failed to parse Google search HTML:', error as Error)
    }
    return results
  }

  private _addResult(results: SearchItem[], seen: Set<string>, title: string, url: string): void {
    if (!url.startsWith('http') || seen.has(url)) return
    if (url.includes('google.com/search') || url.includes('accounts.google.com')) return
    seen.add(url)
    results.push({ title: title || url, url })
  }
}
