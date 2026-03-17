import { isExternalUrl, isLocalFileUrl, proxyImageUrl, proxyLocalFileUrl } from '@renderer/utils/proxyImage'
import { useEffect, useState } from 'react'

/**
 * React hook that proxies external and local file:// image URLs through the backend.
 * Returns { src, loading } where src is a displayable data URL.
 */
export function useProxiedImage(originalSrc: string): { src: string; loading: boolean } {
  const [proxiedSrc, setProxiedSrc] = useState<string>(originalSrc)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const needsProxy = isExternalUrl(originalSrc) || isLocalFileUrl(originalSrc)
    if (!needsProxy) {
      setProxiedSrc(originalSrc)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    const proxyFn = isLocalFileUrl(originalSrc) ? proxyLocalFileUrl : proxyImageUrl
    proxyFn(originalSrc).then((result) => {
      if (cancelled) return
      setProxiedSrc(result || originalSrc)
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [originalSrc])

  return { src: proxiedSrc, loading }
}
