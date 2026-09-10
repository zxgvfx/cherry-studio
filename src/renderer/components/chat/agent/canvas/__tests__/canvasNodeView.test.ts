import type { CanvasDag } from '@renderer/utils/cocoSessionCanvas'
import { normalizePipelineNodeCatalogItem } from '@renderer/utils/pipelineNodes'
import { Position } from '@xyflow/react'
import { describe, expect, it } from 'vitest'

import {
  buildCanvasFlowEdges,
  buildCanvasNodeViews,
  CANVAS_HANDLE_SIZE,
  CANVAS_NODE_HEADER_HEIGHT,
  CANVAS_NODE_WIDTH,
  canvasEdgeId,
  canvasHandleBox,
  canvasNodeHandles,
  canvasNodeHeight,
  canvasPortRowCenter,
  layoutCanvasNodeViews
} from '../canvasNodeView'
import { canvasPortTypesCompatible } from '../canvasTheme'

function port(name: string, assetType: string, required = false, direction = 'input') {
  return { asset_type: assetType, description: '', direction, name, required, tags: [] }
}

const textToImage = normalizePipelineNodeCatalogItem({
  config_schema: [
    { name: 'model', type: 'string', required: false, default: null, description: '', label: 'Model', group: 'general' }
  ],
  input_ports: [port('prompt', 'data/text', true), port('negative_prompt', 'data/text')],
  name: 'Text to Image',
  node_id: 'model.text-to-image',
  output_ports: [port('image_asset_id', 'asset/image', true, 'output')],
  tags: ['image']
})!

const tripo = normalizePipelineNodeCatalogItem({
  config_schema: [],
  input_ports: [port('image_asset_id', 'asset/image', true)],
  name: 'Tripo 3D',
  node_id: 'model.tripo3d',
  output_ports: [port('model_asset_id', 'asset/mesh', true, 'output')],
  tags: ['3d-generation']
})!

const catalog = [textToImage, tripo]

const graph: CanvasDag = {
  edges: [
    { source_port: 'image_asset_id', source_step: 'text2img', target_port: 'image_asset_id', target_step: 'tripo' },
    // The workflow output node is missing from the leaf-node catalog on purpose.
    { source_port: 'model_asset_id', source_step: 'tripo', target_port: 'model', target_step: 'out' }
  ],
  nodes: {
    out: { config: { asset: { name: 'model' } }, node_id: 'io.workflow-output', step_id: 'out' },
    text2img: {
      config: { model: 'nano-banana-pro', prompt: 'a red car' },
      node_id: 'model.text-to-image',
      step_id: 'text2img'
    },
    tripo: { config: {}, node_id: 'model.tripo3d', step_id: 'tripo' }
  }
}

function viewsFor(collapsed?: Set<string>) {
  const views = buildCanvasNodeViews({ catalog, collapsedStepIds: collapsed, graph })
  return { byStepId: new Map(views.map((view) => [view.stepId, view])), views }
}

describe('buildCanvasNodeViews', () => {
  it('resolves catalog ports, literal widgets and missing required inputs', () => {
    const { byStepId } = viewsFor()
    const text2img = byStepId.get('text2img')!

    expect(text2img.title).toBe('Text to Image')
    expect(text2img.category).toBe('image')
    expect(text2img.inputs.map((item) => item.name)).toEqual(['prompt', 'negative_prompt'])
    expect(text2img.outputs.map((item) => item.name)).toEqual(['image_asset_id'])
    // `prompt` holds a literal, so it renders as a widget and is not "missing".
    expect(text2img.widgets).toEqual([
      { key: 'prompt', kind: 'port', value: 'a red car' },
      { key: 'model', kind: 'config', value: 'nano-banana-pro' }
    ])
    expect(text2img.missingRequired).toEqual([])
    expect(text2img.unknownNode).toBe(false)

    // `image_asset_id` is wired, so the required input counts as satisfied.
    expect(byStepId.get('tripo')!.missingRequired).toEqual([])
  })

  it('reports a required input that is neither wired nor filled in', () => {
    const { byStepId } = viewsFor()
    const bare = buildCanvasNodeViews({
      catalog,
      graph: { edges: [], nodes: { solo: { config: {}, node_id: 'model.tripo3d', step_id: 'solo' } } }
    })
    expect(bare[0].missingRequired).toEqual(['image_asset_id'])
    expect(byStepId.get('tripo')!.inputs[0].connected).toBe(true)
  })

  it('materializes ports for nodes the catalog does not describe', () => {
    const { byStepId } = viewsFor()
    const out = byStepId.get('out')!

    expect(out.unknownNode).toBe(true)
    expect(out.inputs.map((item) => item.name)).toEqual(['model'])
    expect(out.inputs[0].synthetic).toBe(true)
    // A synthetic port name must not be duplicated as a config widget.
    expect(out.widgets.map((widget) => widget.key)).toEqual(['asset'])
  })
})

describe('canvas node geometry', () => {
  it('derives height from the port and widget rows it actually renders', () => {
    const { byStepId } = viewsFor()
    const text2img = byStepId.get('text2img')!
    // header + 2 * body padding + 2 port rows + (2 * padding + divider + 2 widget rows)
    expect(canvasNodeHeight(text2img)).toBe(40 + 12 + 44 + (10 + 1 + 36))
    expect(canvasNodeHeight({ ...text2img, collapsed: true })).toBe(CANVAS_NODE_HEADER_HEIGHT)
  })

  it('anchors handles on the node border at the matching port row', () => {
    const { byStepId } = viewsFor()
    const text2img = byStepId.get('text2img')!

    expect(canvasHandleBox(text2img, 1, 'target')).toEqual({
      left: 0,
      size: CANVAS_HANDLE_SIZE,
      top: canvasPortRowCenter(1) - CANVAS_HANDLE_SIZE / 2
    })
    expect(canvasHandleBox(text2img, 0, 'source').left).toBe(CANVAS_NODE_WIDTH - CANVAS_HANDLE_SIZE)
    // Collapsed nodes stack every handle on the header so edges stay attached.
    expect(canvasHandleBox({ ...text2img, collapsed: true }, 1, 'target').top).toBe(
      CANVAS_NODE_HEADER_HEIGHT / 2 - CANVAS_HANDLE_SIZE / 2
    )
  })

  it('publishes an unnamed fallback pair first so port-less edges still resolve', () => {
    const { byStepId } = viewsFor()
    const handles = canvasNodeHandles(byStepId.get('text2img')!)

    expect(handles.slice(0, 2)).toEqual([
      { height: 10, id: null, position: Position.Left, type: 'target', width: 10, x: 0, y: canvasPortRowCenter(0) - 5 },
      {
        height: 10,
        id: null,
        position: Position.Right,
        type: 'source',
        width: 10,
        x: CANVAS_NODE_WIDTH - CANVAS_HANDLE_SIZE,
        y: canvasPortRowCenter(0) - 5
      }
    ])
    expect(handles.filter((handle) => handle.type === 'target').map((handle) => handle.id)).toEqual([
      null,
      'prompt',
      'negative_prompt'
    ])
    expect(handles.filter((handle) => handle.type === 'source').map((handle) => handle.id)).toEqual([
      null,
      'image_asset_id'
    ])
  })
})

describe('layoutCanvasNodeViews', () => {
  it('orders nodes left to right along the dataflow without overlapping rows', () => {
    const { views } = viewsFor()
    const positions = layoutCanvasNodeViews(views, graph.edges)

    expect(positions.get('text2img')!.x).toBeLessThan(positions.get('tripo')!.x)
    expect(positions.get('tripo')!.x).toBeLessThan(positions.get('out')!.x)
  })

  it('returns an empty map for an empty graph', () => {
    expect(layoutCanvasNodeViews([], []).size).toBe(0)
  })
})

describe('buildCanvasFlowEdges', () => {
  it('keeps named handles and colors each edge by its source asset type', () => {
    const { byStepId } = viewsFor()
    const edges = buildCanvasFlowEdges({ graph, viewByStepId: byStepId })

    expect(edges.map((edge) => edge.id)).toEqual([
      'text2img.image_asset_id->tripo.image_asset_id',
      'tripo.model_asset_id->out.model'
    ])
    expect(edges[0]).toMatchObject({
      source: 'text2img',
      sourceHandle: 'image_asset_id',
      target: 'tripo',
      targetHandle: 'image_asset_id'
    })
    expect(edges[0].data.invalid).toBe(false)
    // asset/image and asset/mesh must not share a color.
    expect(edges[0].data.color).not.toBe(edges[1].data.color)
    expect(edges.every((edge) => edge.animated === false)).toBe(true)
  })

  it('flags an unnamed endpoint as invalid and drops edges pointing at missing nodes', () => {
    const broken: CanvasDag = {
      edges: [
        { source_port: '', source_step: 'text2img', target_port: 'prompt', target_step: 'text2img' },
        { source_port: 'image_asset_id', source_step: 'text2img', target_port: 'x', target_step: 'ghost' }
      ],
      nodes: { text2img: graph.nodes.text2img }
    }
    const views = buildCanvasNodeViews({ catalog, graph: broken })
    const edges = buildCanvasFlowEdges({
      animated: true,
      graph: broken,
      viewByStepId: new Map(views.map((view) => [view.stepId, view]))
    })

    expect(edges).toHaveLength(1)
    expect(edges[0].data.invalid).toBe(true)
    expect(edges[0].sourceHandle).toBeUndefined()
    expect(edges[0].animated).toBe(true)
    expect(canvasEdgeId(broken.edges[1])).toBe('text2img.image_asset_id->ghost.x')
  })
})

describe('canvasPortTypesCompatible', () => {
  it('matches on the asset-type hierarchy and stays permissive for unknowns', () => {
    expect(canvasPortTypesCompatible('asset/image', 'asset/image/png')).toBe(true)
    expect(canvasPortTypesCompatible('asset/image', 'asset/mesh')).toBe(false)
    expect(canvasPortTypesCompatible('data/text', 'data/number')).toBe(false)
    expect(canvasPortTypesCompatible('asset/any', 'asset/mesh')).toBe(true)
    expect(canvasPortTypesCompatible('', 'asset/mesh')).toBe(true)
  })
})
