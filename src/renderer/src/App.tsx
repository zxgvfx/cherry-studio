import '@renderer/databases'

import { loggerService } from '@logger'
import store, { persistor } from '@renderer/store'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Component, ErrorInfo, ReactNode } from 'react'
import { Provider } from 'react-redux'
import { PersistGate } from 'redux-persist/integration/react'

import TopViewContainer from './components/TopView'
import AntdProvider from './context/AntdProvider'
import { CodeStyleProvider } from './context/CodeStyleProvider'
import { NotificationProvider } from './context/NotificationProvider'
import StyleSheetManager from './context/StyleSheetManager'
import { ThemeProvider } from './context/ThemeProvider'
import Router from './Router'

// 简单的错误边界用于调试
class AppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[AppErrorBoundary] Caught error:', error)
    console.error('[AppErrorBoundary] Error info:', errorInfo)
    console.error('[AppErrorBoundary] Component stack:', errorInfo.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '40px', maxWidth: '800px', margin: '40px auto' }}>
          <h2>⚠️ 渲染错误</h2>
          <pre style={{ background: '#f0f0f0', padding: '12px', borderRadius: '4px', overflow: 'auto' }}>
            {this.state.error?.toString()}
          </pre>
          <button onClick={() => window.location.reload()} style={{ marginTop: '20px', padding: '10px 20px' }}>
            刷新页面
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const logger = loggerService.withContext('App.tsx')

// 创建 React Query 客户端
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      refetchOnWindowFocus: false
    }
  }
})

function App(): React.ReactElement {
  logger.info('App initialized')

  return (
    <AppErrorBoundary>
      <Provider store={store}>
        <QueryClientProvider client={queryClient}>
          <StyleSheetManager>
            <ThemeProvider>
              <AntdProvider>
                <NotificationProvider>
                  <CodeStyleProvider>
                    <PersistGate loading={null} persistor={persistor}>
                      <TopViewContainer>
                        <Router />
                      </TopViewContainer>
                    </PersistGate>
                  </CodeStyleProvider>
                </NotificationProvider>
              </AntdProvider>
            </ThemeProvider>
          </StyleSheetManager>
        </QueryClientProvider>
      </Provider>
    </AppErrorBoundary>
  )
}

export default App
