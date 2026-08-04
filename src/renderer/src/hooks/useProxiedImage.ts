import { isExternalUrl, isLocalFileUrl, proxyImageUrl, proxyLocalFileUrl } from '@renderer/utils/proxyImage'
import { useEffect, useState } from 'react'

/**
 * React hook that proxies external and local file:// image URLs through the backend.
 * Returns { src, loading } where src is a displayable data URL.
 */
export function useProxiedImage(originalSrc: string): { src: string; loading: boolean } {
  const needsProxy = isExternalUrl(originalSrc) || isLocalFileUrl(originalSrc)
  // Never mount file:// / external http as <img src> first — Qt WebEngine blocks file://
  // and may race before the proxy resolves.
  const [proxiedSrc, setProxiedSrc] = useState<string>(needsProxy ? '' : originalSrc)
  const [loading, setLoading] = useState(needsProxy)

  useEffect(() => {
    const shouldProxy = isExternalUrl(originalSrc) || isLocalFileUrl(originalSrc)
    if (!shouldProxy) {
      setProxiedSrc(originalSrc)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setProxiedSrc('')

    const proxyFn = isLocalFileUrl(originalSrc) ? proxyLocalFileUrl : proxyImageUrl
    proxyFn(originalSrc).then((result) => {
      if (cancelled) return
      setProxiedSrc(result || '')
      setLoading(false)
      if (!result) {
        console.warn('[useProxiedImage] proxy failed for', originalSrc.slice(0, 120))
      }
    })

    return () => {
      cancelled = true
    }
  }, [originalSrc])

  return { src: proxiedSrc, loading }
}
