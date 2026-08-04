import { loggerService } from '@logger'
import { useNavbarPosition } from '@renderer/hooks/useSettings'
import { getPluginFrameSrc, parsePluginIdFromPath } from '@renderer/pages/plugins/pluginFrame'
import { useAppSelector } from '@renderer/store'
import type { Tab } from '@renderer/store/tabs'
import React, { useEffect, useMemo, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import styled from 'styled-components'

/**
 * 插件 iframe 池（顶部 Tab 导航模式）。
 *
 * 与 MinAppTabsPool 相同思路：已打开的插件标签对应 iframe 保留在 DOM 中，
 * 切换标签时仅切换 display，避免 AI Pipeline 等嵌套页面状态丢失。
 */
const logger = loggerService.withContext('PluginTabsPool')

function parsePluginTab(tab: Tab): { pluginId: string; queryString: string } | null {
  if (!tab.id.startsWith('plugins:')) return null
  const pluginId = tab.id.slice('plugins:'.length)
  if (!pluginId) return null
  const qIndex = tab.path.indexOf('?')
  const queryString = qIndex >= 0 ? tab.path.slice(qIndex + 1) : ''
  return { pluginId, queryString }
}

const PluginTabsPool: React.FC = () => {
  const { isTopNavbar } = useNavbarPosition()
  const location = useLocation()
  const tabs = useAppSelector((state) => state.tabs.tabs)
  const iframeRefs = useRef<Map<string, HTMLIFrameElement | null>>(new Map())

  const isPluginDetail = (() => {
    const pathname = location.pathname
    if (pathname === '/plugins') return false
    return pathname.startsWith('/plugins/')
  })()

  const shouldShow = isTopNavbar && isPluginDetail
  const currentPluginId = parsePluginIdFromPath(location.pathname)

  const pluginTabs = useMemo(
    () =>
      tabs
        .map((tab) => {
          const parsed = parsePluginTab(tab)
          if (!parsed) return null
          const src = getPluginFrameSrc(parsed.pluginId, parsed.queryString)
          if (!src) return null
          return { tabId: tab.id, pluginId: parsed.pluginId, src }
        })
        .filter((item): item is { tabId: string; pluginId: string; src: string } => item !== null),
    [tabs]
  )

  useEffect(() => {
    iframeRefs.current.forEach((frame, pluginId) => {
      if (!frame) return
      const active = pluginId === currentPluginId && shouldShow
      frame.style.display = active ? 'block' : 'none'
    })
  }, [currentPluginId, shouldShow, pluginTabs.length])

  useEffect(() => {
    const alive = new Set(pluginTabs.map((tab) => tab.pluginId))
    iframeRefs.current.forEach((_, pluginId) => {
      if (!alive.has(pluginId)) {
        iframeRefs.current.delete(pluginId)
        logger.debug(`Plugin iframe removed from pool: ${pluginId}`)
      }
    })
  }, [pluginTabs])

  const handleSetRef = (pluginId: string, el: HTMLIFrameElement | null) => {
    if (el) {
      iframeRefs.current.set(pluginId, el)
    } else {
      iframeRefs.current.delete(pluginId)
    }
  }

  if (!isTopNavbar || pluginTabs.length === 0) {
    return null
  }

  return (
    <PoolContainer
      style={shouldShow ? { visibility: 'visible' } : { visibility: 'hidden' }}
      data-plugin-tabs-pool
      aria-hidden={!shouldShow}>
      {pluginTabs.map((tab) => (
        <IframeWrapper key={tab.tabId} $active={tab.pluginId === currentPluginId && shouldShow}>
          <PluginIframe
            ref={(el) => handleSetRef(tab.pluginId, el)}
            src={tab.src}
            title={tab.pluginId}
            data-plugin-id={tab.pluginId}
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        </IframeWrapper>
      ))}
    </PoolContainer>
  )
}

const PoolContainer = styled.div`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: 0 0 8px 8px;
  z-index: 1;
  pointer-events: none;

  iframe {
    pointer-events: auto;
  }
`

const IframeWrapper = styled.div<{ $active: boolean }>`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: ${(props) => (props.$active ? 'auto' : 'none')};
`

const PluginIframe = styled.iframe`
  width: 100%;
  height: 100%;
  border: 0;
  background: var(--color-background);
`

export default PluginTabsPool
