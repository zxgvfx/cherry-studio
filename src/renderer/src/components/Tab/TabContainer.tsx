import { PlusOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { Sortable, useDndReorder } from '@renderer/components/dnd'
import HorizontalScrollContainer from '@renderer/components/HorizontalScrollContainer'
import { isMac } from '@renderer/config/constant'
import { allMinApps } from '@renderer/config/minapps'
// import { useTheme } from '@renderer/context/ThemeProvider' // 已移除主题切换功能
import { useFullscreen } from '@renderer/hooks/useFullscreen'
import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
import { useMinapps } from '@renderer/hooks/useMinapps'
// import { useSettings } from '@renderer/hooks/useSettings'
import { getTitleLabel } from '@renderer/i18n/label'
import tabsService from '@renderer/services/TabsService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import type { Tab } from '@renderer/store/tabs'
import { addTab, removeTab, setActiveTab, setTabs, updateTab } from '@renderer/store/tabs'
import type { MinAppType } from '@renderer/types'
import { classNames } from '@renderer/utils'
import type { LRUCache } from 'lru-cache'
import {
  Box,
  FileSearch,
  Folder,
  Home,
  Languages,
  LayoutGrid,
  MousePointerClick,
  NotepadText,
  Palette,
  Settings,
  Sparkle,
  Terminal,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import MinAppIcon from '../Icons/MinAppIcon'
import { OpenClawIcon } from '../Icons/SVGIcon'
import MinAppTabsPool from '../MinApp/MinAppTabsPool'
import NewApiAccountBadge from '../NewApiAccountBadge'
import PluginTabsPool from '../plugins/PluginTabsPool'

interface TabsContainerProps {
  children: React.ReactNode
}

type GuiPluginManifest = {
  id: string
  name?: string
  launcher?: {
    label?: string
  }
}

const logger = loggerService.withContext('TabContainer')

const getTabIcon = (
  tabId: string,
  minapps: MinAppType[],
  minAppsCache?: LRUCache<string, MinAppType>
): React.ReactNode | undefined => {
  // Check if it's a minapp tab (format: apps:appId)
  if (tabId.startsWith('apps:')) {
    const appId = tabId.replace('apps:', '')
    let app = [...allMinApps, ...minapps].find((app) => app.id === appId)

    // If not found in permanent apps, search in temporary apps cache
    // The cache stores apps opened via openSmartMinapp() for top navbar mode
    // These are temporary MinApps that were opened but not yet saved to user's config
    // The cache is LRU (Least Recently Used) with max size from settings
    // Cache validity: Apps in cache are currently active/recently used, not outdated
    if (!app && minAppsCache) {
      app = minAppsCache.get(appId)

      // Defensive programming: If app not found in cache but tab exists,
      // the cache entry may have been evicted due to LRU policy
      // Log warning for debugging potential sync issues
      if (!app) {
        logger.warn(`MinApp ${appId} not found in cache, using fallback icon`)
      }
    }

    if (app) {
      return <MinAppIcon size={14} app={app} />
    }

    // Fallback: If no app found (cache evicted), show default icon
    return <LayoutGrid size={14} />
  }

  if (tabId.startsWith('plugins:')) {
    return <Box size={14} />
  }

  // TODO: Add TabId as type instead of string
  switch (tabId) {
    case 'home':
      return <Home size={14} />
    case 'agents':
      return <MousePointerClick size={14} />
    case 'store':
      return <Sparkle size={14} />
    case 'translate':
      return <Languages size={14} />
    case 'paintings':
      return <Palette size={14} />
    case 'apps':
      return <LayoutGrid size={14} />
    case 'notes':
      return <NotepadText size={14} />
    case 'knowledge':
      return <FileSearch size={14} />
    case 'files':
      return <Folder size={14} />
    case 'settings':
      return <Settings size={14} />
    case 'code':
      return <Terminal size={14} />
    case 'openclaw':
      return <OpenClawIcon style={{ width: 14, height: 14 }} />
    default:
      return null
  }
}

let lastSettingsPath = '/settings/provider'
const specialTabs = ['launchpad', 'settings']

const TabsContainer: React.FC<TabsContainerProps> = ({ children }) => {
  const location = useLocation()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const tabs = useAppSelector((state) => state.tabs.tabs)
  const activeTabId = useAppSelector((state) => state.tabs.activeTabId)
  const isFullscreen = useFullscreen()
  // const { settedTheme, toggleTheme } = useTheme() // 已移除主题切换功能
  const { hideMinappPopup, minAppsCache } = useMinappPopup()
  const { minapps } = useMinapps()
  const [guiPlugins, setGuiPlugins] = useState<GuiPluginManifest[]>([])
  // const { t } = useTranslation() // 已移除主题切换相关翻译

  const getTabId = (path: string): string => {
    const pathname = path.split('?')[0]
    if (pathname === '/') return 'home'
    const segments = pathname.split('/')
    // Handle minapp paths: /apps/appId -> apps:appId
    if (segments[1] === 'apps' && segments[2]) {
      return `apps:${segments[2]}`
    }
    if (segments[1] === 'plugins' && segments[2]) {
      return `plugins:${decodeURIComponent(segments[2])}`
    }
    return segments[1] // 获取第一个路径段作为 id
  }

  const getTabTitle = (tabId: string): string => {
    // Check if it's a minapp tab
    if (tabId.startsWith('apps:')) {
      const appId = tabId.replace('apps:', '')
      let app = [...allMinApps, ...minapps].find((app) => app.id === appId)

      // If not found in permanent apps, search in temporary apps cache
      // This ensures temporary MinApps display proper titles while being used
      // The LRU cache automatically manages app lifecycle and prevents memory leaks
      if (!app && minAppsCache) {
        app = minAppsCache.get(appId)

        // Defensive programming: If app not found in cache but tab exists,
        // the cache entry may have been evicted due to LRU policy
        if (!app) {
          logger.warn(`MinApp ${appId} not found in cache, using fallback title`)
        }
      }

      // Return app name if found, otherwise use fallback with appId
      return app ? app.name : `MinApp-${appId}`
    }
    if (tabId.startsWith('plugins:')) {
      const pluginId = tabId.replace('plugins:', '')
      const plugin = guiPlugins.find((plugin) => plugin.id === pluginId)
      return plugin?.launcher?.label || plugin?.name || pluginId
    }
    return getTitleLabel(tabId)
  }

  const shouldCreateTab = (path: string) => {
    if (path === '/') return false
    if (path === '/settings') return false
    return !tabs.some((tab) => tab.id === getTabId(path))
  }

  useEffect(() => {
    let cancelled = false

    const loadGuiPlugins = async () => {
      try {
        const response = await fetch('/api/v1/plugins/list')
        const result = await response.json()
        if (!response.ok) {
          throw new Error(result?.error || 'Failed to load plugins')
        }

        const plugins = Array.isArray(result?.plugins) ? result.plugins : []
        if (!cancelled) {
          setGuiPlugins(plugins)
        }
      } catch (error) {
        logger.warn(
          `Failed to load plugin manifests for tabs: ${error instanceof Error ? error.message : String(error)}`
        )
        if (!cancelled) {
          setGuiPlugins([])
        }
      }
    }

    loadGuiPlugins()

    return () => {
      cancelled = true
    }
  }, [])

  const removeSpecialTabs = useCallback(() => {
    specialTabs.forEach((tabId) => {
      if (activeTabId !== tabId) {
        dispatch(removeTab(tabId))
      }
    })
  }, [activeTabId, dispatch])

  useEffect(() => {
    const currentPath = `${location.pathname}${location.search}`
    const tabId = getTabId(currentPath)
    const currentTab = tabs.find((tab) => tab.id === tabId)

    if (!currentTab && shouldCreateTab(currentPath)) {
      dispatch(addTab({ id: tabId, path: currentPath }))
    } else if (currentTab) {
      if (currentTab.path !== currentPath) {
        dispatch(updateTab({ id: currentTab.id, updates: { path: currentPath } }))
      }
      dispatch(setActiveTab(currentTab.id))
    }

    // 当访问设置页面时，记录路径
    if (location.pathname.startsWith('/settings/')) {
      lastSettingsPath = location.pathname
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, location.pathname, location.search])

  useEffect(() => {
    removeSpecialTabs()
  }, [removeSpecialTabs])

  const closeTab = (tabId: string) => {
    tabsService.closeTab(tabId)
  }

  const handleAddTab = () => {
    hideMinappPopup()
    navigate('/launchpad')
  }

  const handleSettingsClick = () => {
    hideMinappPopup()
    navigate(lastSettingsPath)
  }

  const handleTabClick = (tab: Tab) => {
    hideMinappPopup()
    navigate(tab.path)
  }

  const visibleTabs = useMemo(() => tabs.filter((tab) => !specialTabs.includes(tab.id)), [tabs])

  const { onSortEnd } = useDndReorder<Tab>({
    originalList: tabs,
    filteredList: visibleTabs,
    onUpdate: (newTabs) => dispatch(setTabs(newTabs)),
    itemKey: 'id'
  })

  return (
    <Container>
      <TabsBar $isFullscreen={isFullscreen}>
        <HorizontalScrollContainer dependencies={[tabs]} gap="6px" className="tab-scroll-container">
          <Sortable
            items={visibleTabs}
            itemKey="id"
            layout="list"
            horizontal
            gap={'6px'}
            onSortEnd={onSortEnd}
            className="tabs-sortable"
            renderItem={(tab) => {
              const isClosable = tab.id !== 'home' && tab.id !== 'agents'
              return (
                <Tab
                  key={tab.id}
                  active={tab.id === activeTabId}
                  $closable={isClosable}
                  onClick={() => handleTabClick(tab)}
                  onAuxClick={(e) => {
                    if (e.button === 1 && isClosable) {
                      e.preventDefault()
                      e.stopPropagation()
                      closeTab(tab.id)
                    }
                  }}>
                  <TabHeader>
                    {tab.id && <TabIcon>{getTabIcon(tab.id, minapps, minAppsCache)}</TabIcon>}
                    <TabTitle>{getTabTitle(tab.id)}</TabTitle>
                  </TabHeader>
                  {isClosable && (
                    <CloseButton
                      className="close-button"
                      data-no-dnd
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(tab.id)
                      }}>
                      <X size={12} />
                    </CloseButton>
                  )}
                </Tab>
              )
            }}
          />
          <AddTabButton onClick={handleAddTab} className={classNames({ active: activeTabId === 'launchpad' })}>
            <PlusOutlined />
          </AddTabButton>
        </HorizontalScrollContainer>
        <RightButtonsContainer>
          <NewApiAccountBadge />
          {/* 主题切换按钮已移除 - 页面嵌入到 Qt 窗口中 */}
          <SettingsButton onClick={handleSettingsClick} $active={activeTabId === 'settings'}>
            <Settings size={16} />
          </SettingsButton>
        </RightButtonsContainer>
        {/* 窗口控制按钮已移除 - 页面嵌入到 Qt 窗口中 */}
        {/* <WindowControls /> */}
      </TabsBar>
      <TabContent>
        {/* MiniApp WebView 池（Tab 模式保活） */}
        <MinAppTabsPool />
        {/* 插件 iframe 池（Tab 模式保活，避免 AI Pipeline 等嵌套页状态丢失） */}
        <PluginTabsPool />
        {children}
      </TabContent>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
`

const TabsBar = styled.div<{ $isFullscreen: boolean }>`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 5px;
  padding-left: ${({ $isFullscreen }) => (!$isFullscreen && isMac ? 'calc(env(titlebar-area-x) + 4px)' : '15px')};
  padding-right: ${({ $isFullscreen }) => ($isFullscreen ? '12px' : '0')};
  height: var(--navbar-height);
  min-height: ${({ $isFullscreen }) => (!$isFullscreen && isMac ? 'env(titlebar-area-height)' : '')};
  position: relative;
  -webkit-app-region: drag;

  /* 确保交互元素在拖拽区域之上 */
  > * {
    position: relative;
    z-index: 1;
    -webkit-app-region: no-drag;
  }

  .tab-scroll-container {
    -webkit-app-region: drag;

    > * {
      -webkit-app-region: no-drag;
    }
  }
`

const Tab = styled.div<{ active?: boolean; $closable?: boolean }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  padding-right: 8px;
  background: ${(props) => (props.active ? 'var(--color-list-item)' : 'transparent')};
  transition: background 0.2s;
  border-radius: var(--list-item-border-radius);
  user-select: none;
  height: 30px;
  min-width: 90px;

  .close-button {
    opacity: ${(props) => (props.active && props.$closable ? 1 : 0)};
    transition: opacity 0.2s;
  }

  &:hover {
    background: ${(props) => (props.active ? 'var(--color-list-item)' : 'var(--color-list-item)')};
    .close-button {
      opacity: 1;
    }
  }
`

const TabHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
`

const TabIcon = styled.span`
  display: flex;
  align-items: center;
  color: var(--color-text-2);
  flex-shrink: 0;
`

const TabTitle = styled.span`
  color: var(--color-text);
  font-size: 13px;
  display: flex;
  align-items: center;
  margin-right: 4px;
  overflow: hidden;
  white-space: nowrap;
`

const CloseButton = styled.span`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
`

const AddTabButton = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  cursor: pointer;
  color: var(--color-text-2);
  border-radius: var(--list-item-border-radius);
  flex-shrink: 0;
  &.active {
    background: var(--color-list-item);
  }
  &:hover {
    background: var(--color-list-item);
  }
`

const RightButtonsContainer = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding-right: ${isMac ? '12px' : '0'};
  flex-shrink: 0;
`

// 主题按钮样式已移除 - 页面嵌入到 Qt 窗口中
// const ThemeButton = styled.div`
//   display: flex;
//   align-items: center;
//   justify-content: center;
//   width: 30px;
//   height: 30px;
//   cursor: pointer;
//   color: var(--color-text);
//
//   &:hover {
//     background: var(--color-list-item);
//     border-radius: 8px;
//   }
// `

const SettingsButton = styled.div<{ $active: boolean }>`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  cursor: pointer;
  color: var(--color-text);
  border-radius: 8px;
  background: ${(props) => (props.$active ? 'var(--color-list-item)' : 'transparent')};
  &:hover {
    background: var(--color-list-item);
  }
`

const TabContent = styled.div`
  display: flex;
  flex: 1;
  overflow: hidden;
  width: calc(100vw - 12px);
  margin: 6px;
  margin-top: 0;
  border-radius: 8px;
  overflow: hidden;
  position: relative; /* 约束 MinAppTabsPool 绝对定位范围 */
`

export default TabsContainer
