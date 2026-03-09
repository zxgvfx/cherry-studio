import { loggerService } from '@logger'
import { Readability } from '@mozilla/readability'
import { nanoid } from '@reduxjs/toolkit'
import type { WebSearchProviderResult } from '@renderer/types'
import { createAbortPromise } from '@renderer/utils/abortController'
import { isAbortError } from '@renderer/utils/error'
import TurndownService from 'turndown'

const logger = loggerService.withContext('Utils:fetch')

const turndownService = new TurndownService()
export const noContent = 'No content found'
const maxExtractedLinks = 20
const maxExtractedImages = 20

type ResponseFormat = 'markdown' | 'html' | 'text'

function toAbsoluteHttpUrl(rawUrl: string | null | undefined, baseUrl: string): string | null {
  if (!rawUrl) {
    return null
  }

  try {
    const absoluteUrl = new URL(rawUrl, baseUrl)
    if (absoluteUrl.protocol !== 'http:' && absoluteUrl.protocol !== 'https:') {
      return null
    }
    return absoluteUrl.toString()
  } catch {
    return null
  }
}

function dedupeUrls(urls: Array<string | null>, maxCount: number): string[] {
  const uniqueUrls = new Set<string>()
  for (const url of urls) {
    if (!url || uniqueUrls.has(url)) {
      continue
    }
    uniqueUrls.add(url)
    if (uniqueUrls.size >= maxCount) {
      break
    }
  }
  return Array.from(uniqueUrls)
}

function extractPageAssets(doc: Document, baseUrl: string) {
  const links = dedupeUrls(
    Array.from(doc.querySelectorAll('a[href]')).map((node) => toAbsoluteHttpUrl(node.getAttribute('href'), baseUrl)),
    maxExtractedLinks
  )

  const images = dedupeUrls(
    Array.from(doc.querySelectorAll('img')).flatMap((node) => {
      const candidates: Array<string | null | undefined> = [
        node.getAttribute('src'),
        node.getAttribute('data-src'),
        node.getAttribute('data-original'),
        node.getAttribute('data-lazy-src')
      ]

      const srcset = node.getAttribute('srcset') || node.getAttribute('data-srcset')
      if (srcset) {
        const firstSrcsetUrl = srcset
          .split(',')
          .map((entry) => entry.trim().split(/\s+/)[0])
          .find(Boolean)
        candidates.push(firstSrcsetUrl)
      }

      return candidates.map((candidate) => toAbsoluteHttpUrl(candidate, baseUrl))
    }),
    maxExtractedImages
  )

  return { links, images }
}

function appendPageAssetsMarkdown(content: string, links: string[], images: string[]): string {
  const sections: string[] = []

  if (links.length > 0) {
    sections.push(
      ['## Extracted Page Links', ...links.map((link, index) => `- [Link ${index + 1}](${link})`)].join('\n')
    )
  }

  if (images.length > 0) {
    sections.push(
      ['## Extracted Images', ...images.map((image, index) => `![Extracted image ${index + 1}](${image})`)].join('\n\n')
    )
  }

  if (sections.length === 0) {
    return content
  }

  return [content, ...sections].filter(Boolean).join('\n\n')
}

/**
 * Validates if the string is a properly formatted URL
 */
export function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch (e) {
    return false
  }
}

export async function fetchWebContents(
  urls: string[],
  format: ResponseFormat = 'markdown',
  usingBrowser: boolean = false,
  httpOptions: RequestInit = {}
): Promise<WebSearchProviderResult[]> {
  // parallel using fetchWebContent
  const results = await Promise.allSettled(urls.map((url) => fetchWebContent(url, format, usingBrowser, httpOptions)))
  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value
    } else {
      return {
        title: 'Error',
        content: noContent,
        url: urls[index]
      }
    }
  })
}

export async function fetchWebContent(
  url: string,
  format: ResponseFormat = 'markdown',
  usingBrowser: boolean = false,
  httpOptions: RequestInit = {},
  includePageAssets: boolean = false
): Promise<WebSearchProviderResult> {
  try {
    // Validate URL before attempting to fetch
    if (!isValidUrl(url)) {
      throw new Error(`Invalid URL format: ${url}`)
    }

    let html: string
    const networkApi = (window as any).api?.network
    const httpProxyApi = (window as any).api?.httpProxy

    const overallTimeoutMs = 25000
    const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timeout after ${overallTimeoutMs}ms`)), overallTimeoutMs)
        )
      ])
    }

    if (networkApi?.fetchProxy) {
      logger.info(`Fetching via backend network proxy: ${url}`)
      const proxyResult: any = await withTimeout(
        networkApi.fetchProxy({
          url,
          method: 'GET',
          timeout: 30000,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        }),
        'network.fetchProxy'
      )

      if (proxyResult?.error) {
        throw new Error(proxyResult.error)
      }
      if (proxyResult?.status && proxyResult.status >= 400) {
        throw new Error(`HTTP error: ${proxyResult.status}`)
      }

      html = proxyResult?.body || ''
    } else if (httpProxyApi?.get) {
      logger.info(`Fetching via backend httpProxy: ${url}`)
      const proxyResult: any = await withTimeout(
        httpProxyApi.get({
          url,
          timeout: 30000,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        }),
        'httpProxy.get'
      )

      if (!proxyResult?.success || !proxyResult.data) {
        throw new Error(proxyResult?.error || 'httpProxy failed to fetch content')
      }

      html = typeof proxyResult.data === 'string' ? proxyResult.data : JSON.stringify(proxyResult.data)
    } else if (usingBrowser) {
      logger.info(`Fetching via browser window: ${url}`)
      const windowApiPromise = window.api.searchService.openUrlInSearchWindow(`search-window-${nanoid()}`, url)

      const browserTimeoutMs = 30000
      const timeoutPromise = new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error(`Browser fetch timeout after ${browserTimeoutMs}ms`)), browserTimeoutMs)
      })

      const promisesToRace: Promise<string>[] = [windowApiPromise, timeoutPromise]

      if (httpOptions?.signal) {
        const signal = httpOptions.signal
        const abortPromise = createAbortPromise(signal, windowApiPromise)
        promisesToRace.push(abortPromise)
      }

      html = await withTimeout(Promise.race(promisesToRace), 'Browser fetch')
    } else {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        ...httpOptions,
        signal: httpOptions?.signal
          ? AbortSignal.any([httpOptions.signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000)
      })
      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`)
      }
      html = await response.text()
    }

    // clearTimeout(timeoutId) // Clear the timeout if fetch completes successfully
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    const article = new Readability(doc).parse()
    const { links, images } = includePageAssets ? extractPageAssets(doc, url) : { links: [], images: [] }
    // Logger.log('Parsed article:', article)

    switch (format) {
      case 'markdown': {
        const markdown = turndownService.turndown(article?.content || '')
        return {
          title: article?.title || url,
          url: url,
          content: appendPageAssetsMarkdown(markdown || noContent, links, images),
          links,
          images
        }
      }
      case 'html':
        return {
          title: article?.title || url,
          url: url,
          content: article?.content || noContent,
          links,
          images
        }
      case 'text':
        return {
          title: article?.title || url,
          url: url,
          content: article?.textContent || noContent,
          links,
          images
        }
    }
  } catch (e: unknown) {
    if (isAbortError(e)) {
      throw e
    }

    logger.error(`Failed to fetch ${url}`, e as Error)
    return {
      title: url,
      url: url,
      content: noContent
    }
  }
}

export async function fetchRedirectUrl(url: string) {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
    return response.url
  } catch (e) {
    logger.error('Failed to fetch redirect url', e as Error)
    return url
  }
}
