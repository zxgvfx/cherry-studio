import { proxyImageUrl } from '@renderer/utils/proxyImage'
import { useEffect, useState } from 'react'
import styled from 'styled-components'

interface FallbackFaviconProps {
  hostname: string
  alt: string
}

const FAVICON_SOURCES = [
  (h: string) => `https://icon.horse/icon/${h}`,
  (h: string) => `https://favicon.splitbee.io/?url=${h}`,
  (h: string) => `https://favicon.im/${h}`,
  (h: string) => `https://${h}/favicon.ico`
]

const FallbackFavicon: React.FC<FallbackFaviconProps> = ({ hostname, alt }) => {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setFailed(false)

    ;(async () => {
      for (const buildUrl of FAVICON_SOURCES) {
        if (cancelled) return
        const url = buildUrl(hostname)
        try {
          const proxied = await proxyImageUrl(url)
          if (cancelled) return
          if (proxied) {
            setSrc(proxied)
            return
          }
        } catch {
          /* try next source */
        }
      }
      if (!cancelled) setFailed(true)
    })()

    return () => {
      cancelled = true
    }
  }, [hostname])

  if (failed || (!src && failed)) {
    return <FaviconPlaceholder>{hostname.charAt(0).toUpperCase()}</FaviconPlaceholder>
  }

  if (!src) {
    return <FaviconLoading />
  }

  return <Favicon src={src} alt={alt} onError={() => setFailed(true)} />
}

const FaviconLoading = styled.div`
  width: 16px;
  height: 16px;
  border-radius: 4px;
  background-color: var(--color-background-mute);
`

const FaviconPlaceholder = styled.div`
  width: 16px;
  height: 16px;
  border-radius: 4px;
  background-color: var(--color-primary-1);
  color: var(--color-primary-6);
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
`

const Favicon = styled.img`
  width: 16px;
  height: 16px;
  border-radius: 4px;
  background-color: var(--color-background-mute);
`

export default FallbackFavicon
