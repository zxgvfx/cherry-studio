import { isExternalUrl, proxyImageUrl } from '@renderer/utils/proxyImage'
import { useEffect, useState } from 'react'

/**
 * React hook that proxies external image URLs through the backend.
 * Returns { src, loading } where src is a local data URL for external images.
 */
export function useProxiedImage(originalSrc: string): { src: string; loading: boolean } {
  const [proxiedSrc, setProxiedSrc] = useState<string>(originalSrc)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!isExternalUrl(originalSrc)) {
      setProxiedSrc(originalSrc)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    proxyImageUrl(originalSrc).then((result) => {
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
