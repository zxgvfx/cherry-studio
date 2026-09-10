import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  pauseQtCompositor,
  QT_COMPOSITOR_PAUSE_MS,
  RELEASE_INLINE_WEBGL_EVENT,
  releaseInlineWebGL
} from '../qtWebEngineStability'

describe('qtWebEngineStability', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    delete (window as Window & { __cocoPauseQtHeartbeat?: boolean }).__cocoPauseQtHeartbeat
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pauses the Qt compositor flag and clears it after the settle window', () => {
    pauseQtCompositor()
    expect((window as Window & { __cocoPauseQtHeartbeat?: boolean }).__cocoPauseQtHeartbeat).toBe(true)
    vi.advanceTimersByTime(QT_COMPOSITOR_PAUSE_MS)
    expect((window as Window & { __cocoPauseQtHeartbeat?: boolean }).__cocoPauseQtHeartbeat).toBe(false)
  })

  it('dispatches the WebGL release event while pausing compositing', () => {
    const onRelease = vi.fn()
    window.addEventListener(RELEASE_INLINE_WEBGL_EVENT, onRelease)
    releaseInlineWebGL()
    expect(onRelease).toHaveBeenCalledTimes(1)
    expect((window as Window & { __cocoPauseQtHeartbeat?: boolean }).__cocoPauseQtHeartbeat).toBe(true)
    window.removeEventListener(RELEASE_INLINE_WEBGL_EVENT, onRelease)
  })
})
