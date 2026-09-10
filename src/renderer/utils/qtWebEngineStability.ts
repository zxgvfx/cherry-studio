export const RELEASE_INLINE_WEBGL_EVENT = 'coco:release-webgl'
export const QT_COMPOSITOR_PAUSE_MS = 1200

type QtHostWindow = Window & { __cocoPauseQtHeartbeat?: boolean }

let pauseGeneration = 0

function hostWindow(): QtHostWindow | null {
  if (typeof window === 'undefined') return null
  return window as QtHostWindow
}

/**
 * Ask the Qt host to skip WebEngine `update()` ticks. Compositing a tearing
 * WebGL/ReactFlow scene into QWidget is the Qt6Gui.dll 0xc0000005 path.
 */
export function pauseQtCompositor(ms = QT_COMPOSITOR_PAUSE_MS): void {
  const win = hostWindow()
  if (!win) return
  const token = ++pauseGeneration
  win.__cocoPauseQtHeartbeat = true
  window.setTimeout(() => {
    if (token !== pauseGeneration) return
    win.__cocoPauseQtHeartbeat = false
  }, ms)
}

export function releaseInlineWebGL(): void {
  const win = hostWindow()
  if (!win) return
  pauseQtCompositor()
  win.dispatchEvent(new Event(RELEASE_INLINE_WEBGL_EVENT))
}
