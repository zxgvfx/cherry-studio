import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key })
}))

import { PipelineCanvasToolbar } from '../PipelineCanvasToolbar'

const noop = () => undefined

function renderToolbar(overrides: Partial<ComponentProps<typeof PipelineCanvasToolbar>> = {}) {
  return render(
    <PipelineCanvasToolbar
      canRedo={false}
      canRun
      canUndo={false}
      dirty
      historyOpen={false}
      inspectorOpen={false}
      onAutoLayout={noop}
      onFitView={noop}
      onRedo={noop}
      onRun={noop}
      onSave={noop}
      onToggleHistory={noop}
      onToggleInspector={noop}
      onTogglePalette={noop}
      onToggleSnap={noop}
      onUndo={noop}
      onZoomIn={noop}
      onZoomOut={noop}
      paletteOpen={false}
      readOnly={false}
      running={false}
      saving={false}
      snapToGrid={false}
      {...overrides}
    />
  )
}

describe('PipelineCanvasToolbar', () => {
  it('puts save and run in the top toolbar', () => {
    renderToolbar()
    expect(screen.getByTestId('canvas-save')).toBeEnabled()
    expect(screen.getByTestId('canvas-run')).toBeEnabled()
  })

  it('disables save when the canvas is clean and run when there is nothing to execute', () => {
    renderToolbar({ canRun: false, dirty: false })
    expect(screen.getByTestId('canvas-save')).toBeDisabled()
    expect(screen.getByTestId('canvas-run')).toBeDisabled()
  })

  it('invokes save and run handlers', () => {
    const onSave = vi.fn()
    const onRun = vi.fn()
    renderToolbar({ onRun, onSave })
    fireEvent.click(screen.getByTestId('canvas-save'))
    fireEvent.click(screen.getByTestId('canvas-run'))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onRun).toHaveBeenCalledTimes(1)
  })
})
