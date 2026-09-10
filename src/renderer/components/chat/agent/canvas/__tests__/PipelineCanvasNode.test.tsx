import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key })
}))

import {
  CANVAS_NODE_HEADER_HEIGHT,
  CANVAS_NODE_WIDTH,
  canvasNodeHeight,
  type CanvasNodeViewData
} from '../canvasNodeView'
import { CanvasNodeActionsProvider, PipelineCanvasNode } from '../PipelineCanvasNode'

const view: CanvasNodeViewData = {
  accent: 'oklch(0.63 0.23 304)',
  category: 'image',
  collapsed: false,
  hiddenWidgetCount: 2,
  inputs: [
    {
      assetType: 'data/text',
      color: '#0f0',
      connected: false,
      hasLiteral: true,
      name: 'prompt',
      required: true,
      synthetic: false
    },
    {
      assetType: 'asset/image',
      color: '#f0f',
      connected: true,
      hasLiteral: false,
      name: 'image_asset_id',
      required: false,
      synthetic: false
    }
  ],
  missingRequired: [],
  nodeId: 'model.text-to-image',
  outputs: [
    {
      assetType: 'asset/image',
      color: '#f0f',
      connected: true,
      hasLiteral: false,
      name: 'result',
      required: true,
      synthetic: false
    }
  ],
  stepId: 'text2img',
  title: 'Text to Image',
  widgets: [{ key: 'model', kind: 'config', value: 'nano-banana-pro' }],
  unknownNode: false
}

function renderNode(data: CanvasNodeViewData, actions = { toggleCollapse: vi.fn() }) {
  const utils = render(
    <ReactFlowProvider>
      <CanvasNodeActionsProvider value={actions}>
        <PipelineCanvasNode
          data={data}
          dragging={false}
          id={data.stepId}
          isConnectable
          positionAbsoluteX={0}
          positionAbsoluteY={0}
          selectable
          selected={false}
          type="pipelineCanvasNode"
          zIndex={0}
          deletable
          draggable
        />
      </CanvasNodeActionsProvider>
    </ReactFlowProvider>
  )
  return { ...utils, actions }
}

describe('PipelineCanvasNode', () => {
  it('renders the ports, inline widgets and the hidden-parameter hint', () => {
    renderNode(view)

    expect(screen.getByText('Text to Image')).toBeInTheDocument()
    expect(screen.getByText('prompt')).toBeInTheDocument()
    expect(screen.getByText('image_asset_id')).toBeInTheDocument()
    expect(screen.getByText('result')).toBeInTheDocument()
    expect(screen.getByText('nano-banana-pro')).toBeInTheDocument()
    expect(screen.getByText('library.config.agent.coco.canvas.more_params')).toBeInTheDocument()
  })

  it('sizes itself from the computed geometry so handles match the rendered rows', () => {
    renderNode(view)
    const node = screen.getByTestId('canvas-node-text2img')

    expect(node.style.width).toBe(`${CANVAS_NODE_WIDTH}px`)
    expect(node.style.height).toBe(`${canvasNodeHeight(view)}px`)
  })

  it('publishes a handle per port plus the unnamed fallback pair', () => {
    const { container } = renderNode(view)

    expect(container.querySelectorAll('.react-flow__handle.target')).toHaveLength(3)
    expect(container.querySelectorAll('.react-flow__handle.source')).toHaveLength(2)
  })

  it('collapses to the header height and hides the body', () => {
    const collapsed = { ...view, collapsed: true }
    renderNode(collapsed)

    expect(screen.getByTestId('canvas-node-text2img').style.height).toBe(`${CANVAS_NODE_HEADER_HEIGHT}px`)
    expect(screen.queryByText('nano-banana-pro')).not.toBeInTheDocument()
    // Handles stay mounted so existing edges keep an anchor on the header.
    expect(screen.getByText('Text to Image')).toBeInTheDocument()
  })

  it('asks the editor to toggle collapse instead of mutating its own data', () => {
    const { actions } = renderNode(view)

    screen.getByTestId('canvas-node-collapse-text2img').click()

    expect(actions.toggleCollapse).toHaveBeenCalledWith('text2img')
  })

  it('warns about a required input that has neither an edge nor a literal', () => {
    renderNode({ ...view, missingRequired: ['prompt'] })

    expect(screen.getByTitle('library.config.agent.coco.canvas.missing_required')).toBeInTheDocument()
  })
})
