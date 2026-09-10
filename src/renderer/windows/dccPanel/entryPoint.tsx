import '@renderer/utils/abortSignalPolyfill'
import '@renderer/assets/styles/index.css'
import '@renderer/assets/styles/tailwind.css'

import { prepareWindow } from '@renderer/windows/prepareWindow'
import { createRoot } from 'react-dom/client'

import DccPanelApp from './DccPanelApp'

await prepareWindow({
  preference: ['app.language', 'ui.custom_css', 'ui.theme_mode', 'ui.theme_user.color_primary', 'ui.window_style'],
  preferenceTimeoutMs: 2500
})

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(<DccPanelApp />)
