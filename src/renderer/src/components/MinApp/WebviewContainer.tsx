import { loggerService } from '@logger'
import { useSettings } from '@renderer/hooks/useSettings'
import type { WebviewTag } from 'electron'
import { memo, useEffect, useRef } from 'react'

const logger = loggerService.withContext('WebviewContainer')

const isQtRuntime = !!(window as any).__CHERRY_BACKEND_URL

/**
 * WebviewContainer is a component that renders a webview element.
 * In Qt/Houdini environment, falls back to iframe since webview is Electron-only.
 */
const WebviewContainer = memo(
  ({
    appid,
    url,
    onSetRefCallback,
    onLoadedCallback,
    onNavigateCallback
  }: {
    appid: string
    url: string
    onSetRefCallback: (appid: string, element: WebviewTag | null) => void
    onLoadedCallback: (appid: string) => void
    onNavigateCallback: (appid: string, url: string) => void
  }) => {
    const webviewRef = useRef<WebviewTag | null>(null)
    const iframeRef = useRef<HTMLIFrameElement | null>(null)
    const { enableSpellCheck, minappsOpenLinkExternal } = useSettings()

    // ─── Qt iframe mode ─────────────────────────────────────────────────
    useEffect(() => {
      if (!isQtRuntime || !iframeRef.current) return

      const iframe = iframeRef.current

      const handleLoad = () => {
        logger.debug(`[Qt] iframe loaded for app: ${appid}`)
        onLoadedCallback(appid)
        try {
          onNavigateCallback(appid, iframe.contentWindow?.location?.href || url)
        } catch {
          // cross-origin — ignore
        }
      }

      const handleError = () => {
        logger.debug(`[Qt] iframe load error for app: ${appid}`)
        onLoadedCallback(appid)
      }

      iframe.addEventListener('load', handleLoad)
      iframe.addEventListener('error', handleError)
      iframe.src = url

      return () => {
        iframe.removeEventListener('load', handleLoad)
        iframe.removeEventListener('error', handleError)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [appid, url])

    // ─── Electron webview mode ──────────────────────────────────────────
    const setRef = (appid: string) => {
      onSetRefCallback(appid, null)

      return (element: WebviewTag | null) => {
        onSetRefCallback(appid, element)
        if (element) {
          webviewRef.current = element
        } else {
          webviewRef.current = null
        }
      }
    }

    useEffect(() => {
      if (isQtRuntime) return
      if (!webviewRef.current) return

      let loadCallbackFired = false

      const handleLoaded = () => {
        logger.debug(`WebView did-finish-load for app: ${appid}`)
        if (!loadCallbackFired) {
          loadCallbackFired = true
          setTimeout(() => {
            logger.debug(`Calling onLoadedCallback for app: ${appid}`)
            onLoadedCallback(appid)
          }, 100)
        }
      }

      const handleLoadError = (event: any) => {
        if (event.isMainFrame) {
          logger.debug(`WebView did-fail-load for app: ${appid}, error: ${event.errorDescription}`)

          const errorDesc = event.errorDescription
          if (errorDesc && errorDesc !== 'ERR_ABORTED') {
            window.toast?.error?.(`Load failed: ${errorDesc}. Please check Network or Proxy settings.`)
          }

          if (!loadCallbackFired) {
            loadCallbackFired = true
            onLoadedCallback(appid)
          }
        }
      }

      const handleReadyToShow = () => {
        logger.debug(`WebView ready-to-show for app: ${appid}`)
        if (!loadCallbackFired) {
          loadCallbackFired = true
          logger.debug(`Calling onLoadedCallback from ready-to-show for app: ${appid}`)
          onLoadedCallback(appid)
        }
      }

      const handleNavigate = (event: any) => {
        onNavigateCallback(appid, event.url)
      }

      const handleDomReady = () => {
        const webviewId = webviewRef.current?.getWebContentsId()
        if (webviewId) {
          window.api?.webview?.setSpellCheckEnabled?.(webviewId, enableSpellCheck)
          window.api?.webview?.setOpenLinkExternal?.(webviewId, minappsOpenLinkExternal)
        }
      }

      const handleStartLoading = () => {
        loadCallbackFired = false
      }

      webviewRef.current.addEventListener('did-start-loading', handleStartLoading)
      webviewRef.current.addEventListener('dom-ready', handleDomReady)
      webviewRef.current.addEventListener('did-finish-load', handleLoaded)
      webviewRef.current.addEventListener('did-fail-load', handleLoadError)
      webviewRef.current.addEventListener('ready-to-show', handleReadyToShow)
      webviewRef.current.addEventListener('did-navigate-in-page', handleNavigate)

      webviewRef.current.src = url

      return () => {
        webviewRef.current?.removeEventListener('did-start-loading', handleStartLoading)
        webviewRef.current?.removeEventListener('dom-ready', handleDomReady)
        webviewRef.current?.removeEventListener('did-finish-load', handleLoaded)
        webviewRef.current?.removeEventListener('did-fail-load', handleLoadError)
        webviewRef.current?.removeEventListener('ready-to-show', handleReadyToShow)
        webviewRef.current?.removeEventListener('did-navigate-in-page', handleNavigate)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [appid, url])

    // Electron-only: keyboard shortcuts
    useEffect(() => {
      if (isQtRuntime) return
      if (!webviewRef.current) return

      const unsubscribe = window.api?.webview?.onFindShortcut?.(async (payload) => {
        const webviewId = webviewRef.current?.getWebContentsId()
        if (!webviewId || payload.webviewId !== webviewId) return

        const key = payload.key?.toLowerCase()
        const isModifier = payload.control || payload.meta
        if (!isModifier || !key) return

        try {
          if (key === 'p') {
            logger.info(`Printing webview ${appid} to PDF`)
            const filePath = await window.api.webview.printToPDF(webviewId)
            if (filePath) {
              window.toast?.success?.(`PDF saved to: ${filePath}`)
              logger.info(`PDF saved to: ${filePath}`)
            }
          } else if (key === 's') {
            logger.info(`Saving webview ${appid} as HTML`)
            const filePath = await window.api.webview.saveAsHTML(webviewId)
            if (filePath) {
              window.toast?.success?.(`HTML saved to: ${filePath}`)
              logger.info(`HTML saved to: ${filePath}`)
            }
          }
        } catch (error) {
          logger.error(`Failed to handle shortcut for webview ${appid}:`, error as Error)
          window.toast?.error?.(`Failed: ${(error as Error).message}`)
        }
      })

      return () => {
        unsubscribe?.()
      }
    }, [appid])

    // Electron-only: update webview settings
    useEffect(() => {
      if (isQtRuntime) return
      if (!webviewRef.current) return

      try {
        const webviewId = webviewRef.current.getWebContentsId()
        if (webviewId) {
          window.api?.webview?.setSpellCheckEnabled?.(webviewId, enableSpellCheck)
          window.api?.webview?.setOpenLinkExternal?.(webviewId, minappsOpenLinkExternal)
        }
      } catch (error) {
        logger.debug(`WebView ${appid} not ready for settings update`)
      }
    }, [appid, minappsOpenLinkExternal, enableSpellCheck])

    const commonStyle: React.CSSProperties = {
      width: '100%',
      height: '100%',
      backgroundColor: 'var(--color-background)',
      display: 'inline-flex',
      border: 'none'
    }

    if (isQtRuntime) {
      return (
        <iframe
          key={appid}
          ref={iframeRef}
          data-minapp-id={appid}
          style={commonStyle}
          allow="clipboard-write; clipboard-read"
        />
      )
    }

    return (
      <webview
        key={appid}
        ref={setRef(appid)}
        data-minapp-id={appid}
        style={commonStyle}
        allowpopups={'true' as any}
        partition="persist:webview"
        useragent={
          appid === 'google'
            ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)  Safari/537.36'
            : undefined
        }
      />
    )
  }
)

export default WebviewContainer
