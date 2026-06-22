import '@renderer/databases'

import type { FC } from 'react'
import { useMemo } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'

import Sidebar from './components/app/Sidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
import TabsContainer from './components/Tab/TabContainer'
import NavigationHandler from './handler/NavigationHandler'
import { useNavbarPosition } from './hooks/useSettings'
import AgentPage from './pages/agents/AgentPage'
import CodeToolsPage from './pages/code/CodeToolsPage'
import FilesPage from './pages/files/FilesPage'
import HomePage from './pages/home/HomePage'
import KnowledgePage from './pages/knowledge/KnowledgePage'
import LaunchpadPage from './pages/launchpad/LaunchpadPage'
import MinAppPage from './pages/minapps/MinAppPage'
import MinAppsPage from './pages/minapps/MinAppsPage'
import NotesPage from './pages/notes/NotesPage'
import OpenClawPage from './pages/openclaw/OpenClawPage'
import PaintingsRoutePage from './pages/paintings/PaintingsRoutePage'
import PluginEmbedPage from './pages/plugins/PluginEmbedPage'
import SettingsPage from './pages/settings/SettingsPage'
import AssistantPresetsPage from './pages/store/assistants/presets/AssistantPresetsPage'
import TranslatePage from './pages/translate/TranslatePage'
import { useAppSelector } from './store'

const Router: FC = () => {
  const { navbarPosition } = useNavbarPosition()
  const enableDeveloperMode = useAppSelector((state) => state.settings.enableDeveloperMode)

  const routes = useMemo(() => {
    return (
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/agents" element={<AgentPage />} />
          <Route path="/store" element={<AssistantPresetsPage />} />
          <Route path="/paintings/*" element={<PaintingsRoutePage />} />
          <Route path="/translate" element={<TranslatePage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/plugins/:pluginId" element={<PluginEmbedPage />} />
          <Route path="/plugins" element={<LaunchpadPage />} />
          <Route path="/apps/:appId" element={<MinAppPage />} />
          <Route path="/apps" element={<MinAppsPage />} />
          <Route path="/code" element={<CodeToolsPage />} />
          <Route path="/openclaw" element={enableDeveloperMode ? <OpenClawPage /> : <Navigate to="/" replace />} />
          <Route path="/settings/*" element={<SettingsPage />} />
          <Route path="/launchpad" element={<LaunchpadPage />} />
        </Routes>
      </ErrorBoundary>
    )
  }, [enableDeveloperMode])

  if (navbarPosition === 'left') {
    return (
      <HashRouter>
        <Sidebar />
        {routes}
        <NavigationHandler />
      </HashRouter>
    )
  }

  return (
    <HashRouter>
      <NavigationHandler />
      <TabsContainer>{routes}</TabsContainer>
    </HashRouter>
  )
}

export default Router
