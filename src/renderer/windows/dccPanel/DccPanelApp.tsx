import { CodeStyleProvider } from '@renderer/components/CodeStyleProvider'
import { CommandContextKeyProvider, CommandProvider } from '@renderer/components/command'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { PopupHost } from '@renderer/components/PopupHost'
import { ThemeProvider } from '@renderer/components/ThemeProvider'
import ToastHost from '@renderer/components/ToastHost'
import { WindowFatalFallback } from '@renderer/components/WindowFatalFallback'
import { useCustomCss } from '@renderer/hooks/useCustomCss'
import { useLanguageSync } from '@renderer/hooks/useLanguageSync'
import i18n from '@renderer/i18n/resolver'
import { type ReactElement, useEffect } from 'react'

import { DccPanel } from './DccPanel'

function DccPanelRuntime(): null {
  useLanguageSync()
  useCustomCss()
  useEffect(() => {
    document.getElementById('spinner')?.remove()
  }, [])
  return null
}

function DccPanelApp(): ReactElement | null {
  if (!i18n.isInitialized) {
    return null
  }

  return (
    <ErrorBoundary fallbackComponent={WindowFatalFallback}>
      <ThemeProvider>
        <CodeStyleProvider>
          <CommandContextKeyProvider>
            <CommandProvider>
              <>
                <DccPanelRuntime />
                <DccPanel />
                <PopupHost />
                <ToastHost />
              </>
            </CommandProvider>
          </CommandContextKeyProvider>
        </CodeStyleProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default DccPanelApp
