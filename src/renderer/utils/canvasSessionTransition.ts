import { pauseQtCompositor, releaseInlineWebGL } from './qtWebEngineStability'

export const CANVAS_SESSION_TRANSITION_EVENT = 'cherry:canvas-session-transition'

/**
 * Gives native-backed canvas renderers a chance to unmount before the chat
 * swaps session identity. Qt WebEngine can otherwise crash in Qt6Gui while
 * ReactFlow tears down during the same frame as the surrounding pane.
 */
export function prepareCanvasSessionTransition(): void {
  pauseQtCompositor()
  releaseInlineWebGL()
  window.dispatchEvent(new Event(CANVAS_SESSION_TRANSITION_EVENT))
}
