import { graphlib, layout } from '@dagrejs/dagre'
import type { CanvasDag, CanvasDagEdge } from '@renderer/utils/cocoSessionCanvas'
import type { PipelineNodeCatalogItem, PipelineNodeCategoryId, PipelineNodePort } from '@renderer/utils/pipelineNodes'
import { classifyPipelineNode, findPipelineNode } from '@renderer/utils/pipelineNodes'
import { type Node as RfNode, Position } from '@xyflow/react'

import { canvasCategoryColor, canvasPortColor } from './canvasTheme'

/*
 * Node geometry is fixed and computed here instead of measured from the DOM.
 * React Flow drops an edge whenever either endpoint has no handle bounds, and
 * it clears those bounds every time a node object is recreated without a
 * `measured` field (see `parseHandles` in @xyflow/system). Publishing explicit
 * `handles` keeps edges visible across re-renders, and removes the dependency
 * on native measurement inside Qt WebEngine.
 */
export const CANVAS_NODE_WIDTH = 268
export const CANVAS_NODE_HEADER_HEIGHT = 40
export const CANVAS_NODE_BODY_PADDING = 6
export const CANVAS_PORT_ROW_HEIGHT = 22
export const CANVAS_WIDGET_ROW_HEIGHT = 18
export const CANVAS_WIDGET_SECTION_PADDING = 5
export const CANVAS_HANDLE_SIZE = 10
export const CANVAS_MAX_INLINE_WIDGETS = 4

export const CANVAS_NODE_TYPE = 'pipelineCanvasNode' as const
export const CANVAS_EDGE_TYPE = 'pipelineCanvasEdge' as const

export interface CanvasPortView {
  name: string
  assetType: string
  color: string
  required: boolean
  connected: boolean
  /** Declared only by an existing edge, not by the node catalog. */
  synthetic: boolean
  /** An unconnected input that carries a literal value in the node config. */
  hasLiteral: boolean
}

export interface CanvasWidgetView {
  key: string
  value: string
  /** Literal input-port values render like ComfyUI widgets, config does too. */
  kind: 'port' | 'config'
}

export interface CanvasNodeViewData extends Record<string, unknown> {
  stepId: string
  nodeId: string
  title: string
  category: PipelineNodeCategoryId
  accent: string
  inputs: CanvasPortView[]
  outputs: CanvasPortView[]
  widgets: CanvasWidgetView[]
  hiddenWidgetCount: number
  missingRequired: string[]
  collapsed: boolean
  /** The catalog has no entry for this node id (workflow or interface node). */
  unknownNode: boolean
}

export interface CanvasEdgeViewData extends Record<string, unknown> {
  sourcePort: string
  targetPort: string
  color: string
  /** One of the endpoints is not a real port on its node. */
  invalid: boolean
}

export type CanvasFlowNode = RfNode<CanvasNodeViewData, typeof CANVAS_NODE_TYPE>
type CanvasNodeHandle = NonNullable<CanvasFlowNode['handles']>[number]

export interface CanvasHandleBox {
  left: number
  top: number
  size: number
}

export function canvasNodePortRows(view: CanvasNodeViewData): number {
  return Math.max(view.inputs.length, view.outputs.length)
}

export function canvasNodeHeight(view: CanvasNodeViewData): number {
  if (view.collapsed) return CANVAS_NODE_HEADER_HEIGHT
  const widgetRows = view.widgets.length + (view.hiddenWidgetCount > 0 ? 1 : 0)
  const widgetsHeight =
    widgetRows > 0 ? CANVAS_WIDGET_SECTION_PADDING * 2 + 1 + widgetRows * CANVAS_WIDGET_ROW_HEIGHT : 0
  return (
    CANVAS_NODE_HEADER_HEIGHT +
    CANVAS_NODE_BODY_PADDING * 2 +
    Math.max(canvasNodePortRows(view), 1) * CANVAS_PORT_ROW_HEIGHT +
    widgetsHeight
  )
}

/** Vertical center of the port row at `index`, relative to the node top edge. */
export function canvasPortRowCenter(index: number): number {
  return (
    CANVAS_NODE_HEADER_HEIGHT + CANVAS_NODE_BODY_PADDING + index * CANVAS_PORT_ROW_HEIGHT + CANVAS_PORT_ROW_HEIGHT / 2
  )
}

/**
 * The exact handle box, shared by the published bounds and the rendered dot so
 * the two can never drift apart. `getHandlePosition` anchors a Left handle at
 * `x` and a Right handle at `x + width`, which puts both on the node border.
 */
export function canvasHandleBox(view: CanvasNodeViewData, index: number, type: 'source' | 'target'): CanvasHandleBox {
  const center = view.collapsed ? CANVAS_NODE_HEADER_HEIGHT / 2 : canvasPortRowCenter(index)
  return {
    left: type === 'target' ? 0 : CANVAS_NODE_WIDTH - CANVAS_HANDLE_SIZE,
    top: center - CANVAS_HANDLE_SIZE / 2,
    size: CANVAS_HANDLE_SIZE
  }
}

function handleFor(
  view: CanvasNodeViewData,
  index: number,
  type: 'source' | 'target',
  id: string | null
): CanvasNodeHandle {
  const box = canvasHandleBox(view, index, type)
  return {
    id,
    type,
    position: type === 'target' ? Position.Left : Position.Right,
    x: box.left,
    y: box.top,
    width: box.size,
    height: box.size
  }
}

/**
 * Handles for one node. The unnamed fallback pair comes first so an edge that
 * carries no port name still resolves — React Flow falls back to `bounds[0]`.
 */
export function canvasNodeHandles(view: CanvasNodeViewData): CanvasNodeHandle[] {
  const handles: CanvasNodeHandle[] = [handleFor(view, 0, 'target', null), handleFor(view, 0, 'source', null)]
  view.inputs.forEach((port, index) => handles.push(handleFor(view, index, 'target', port.name)))
  view.outputs.forEach((port, index) => handles.push(handleFor(view, index, 'source', port.name)))
  return handles
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

export function canvasValuePreview(value: unknown, limit = 30): string {
  if (value == null) return ''
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : safeStringify(value)
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed
}

function toPortView(
  port: Pick<PipelineNodePort, 'name' | 'asset_type' | 'required'>,
  options: { connected: boolean; synthetic: boolean; hasLiteral?: boolean }
): CanvasPortView {
  return {
    name: port.name,
    assetType: port.asset_type,
    color: canvasPortColor(port.asset_type),
    required: port.required,
    connected: options.connected,
    synthetic: options.synthetic,
    hasLiteral: options.hasLiteral ?? false
  }
}

interface BuildCanvasNodeViewsInput {
  graph: CanvasDag
  catalog: readonly PipelineNodeCatalogItem[]
  collapsedStepIds?: ReadonlySet<string>
}

export function buildCanvasNodeViews({
  graph,
  catalog,
  collapsedStepIds
}: BuildCanvasNodeViewsInput): CanvasNodeViewData[] {
  const connectedInputs = new Set(graph.edges.map((edge) => `${edge.target_step}\u0000${edge.target_port}`))

  return Object.values(graph.nodes).map((node) => {
    const spec = findPipelineNode(catalog, node.node_id)
    const legacyLiterals = isRecord(node.config._port_values) ? node.config._port_values : {}
    const readLiteral = (name: string) =>
      Object.prototype.hasOwnProperty.call(node.config, name) ? node.config[name] : legacyLiterals[name]

    const widgets: CanvasWidgetView[] = []
    const inputs = (spec?.input_ports ?? []).map((port) => {
      const connected = connectedInputs.has(`${node.step_id}\u0000${port.name}`)
      const preview = connected ? '' : canvasValuePreview(readLiteral(port.name), 24)
      if (preview) widgets.push({ key: port.name, value: preview, kind: 'port' })
      return toPortView(port, { connected, synthetic: false, hasLiteral: Boolean(preview) })
    })
    const outputs = (spec?.output_ports ?? []).map((port) => toPortView(port, { connected: true, synthetic: false }))

    // Workflow and interface nodes are absent from the leaf-node catalog, so
    // materialize whatever ports the saved DAG actually references.
    const inputNames = new Set(inputs.map((port) => port.name))
    const outputNames = new Set(outputs.map((port) => port.name))
    for (const edge of graph.edges) {
      if (edge.target_step === node.step_id && edge.target_port && !inputNames.has(edge.target_port)) {
        inputNames.add(edge.target_port)
        inputs.push(
          toPortView(
            { name: edge.target_port, asset_type: 'asset/any', required: false },
            { connected: true, synthetic: true }
          )
        )
      }
      if (edge.source_step === node.step_id && edge.source_port && !outputNames.has(edge.source_port)) {
        outputNames.add(edge.source_port)
        outputs.push(
          toPortView(
            { name: edge.source_port, asset_type: 'asset/any', required: false },
            { connected: true, synthetic: true }
          )
        )
      }
    }

    const portNames = new Set([...inputNames, ...outputNames])
    for (const [key, value] of Object.entries(node.config)) {
      if (key === '_port_values' || portNames.has(key) || value === undefined) continue
      const preview = canvasValuePreview(value, 24)
      if (preview) widgets.push({ key, value: preview, kind: 'config' })
    }

    const category = classifyPipelineNode(spec ?? { node_id: node.node_id, name: '', tags: [] })
    return {
      stepId: node.step_id,
      nodeId: node.node_id,
      title: spec?.name || node.step_id,
      category,
      accent: canvasCategoryColor(category),
      inputs,
      outputs,
      widgets: widgets.slice(0, CANVAS_MAX_INLINE_WIDGETS),
      hiddenWidgetCount: Math.max(widgets.length - CANVAS_MAX_INLINE_WIDGETS, 0),
      missingRequired: inputs
        .filter((port) => port.required && !port.connected && !port.hasLiteral)
        .map((port) => port.name),
      collapsed: collapsedStepIds?.has(node.step_id) ?? false,
      unknownNode: !spec
    }
  })
}

const LAYOUT_SPACING = {
  edgesep: 18,
  marginx: 32,
  marginy: 32,
  nodesep: 26,
  ranksep: 96
} as const

/** Left-to-right dataflow layout that accounts for each node's real height. */
export function layoutCanvasNodeViews(
  views: readonly CanvasNodeViewData[],
  edges: readonly CanvasDagEdge[]
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  if (views.length === 0) return positions

  const dagreGraph = new graphlib.Graph().setGraph({ rankdir: 'LR', ...LAYOUT_SPACING }).setDefaultEdgeLabel(() => ({}))
  const sizeByStepId = new Map(
    views.map((view) => [view.stepId, { width: CANVAS_NODE_WIDTH, height: canvasNodeHeight(view) }])
  )
  for (const view of views) dagreGraph.setNode(view.stepId, { ...sizeByStepId.get(view.stepId) })
  for (const edge of edges) {
    if (!sizeByStepId.has(edge.source_step) || !sizeByStepId.has(edge.target_step)) continue
    if (edge.source_step === edge.target_step) continue
    dagreGraph.setEdge(edge.source_step, edge.target_step)
  }
  layout(dagreGraph)

  for (const view of views) {
    const size = sizeByStepId.get(view.stepId)
    const positioned = dagreGraph.node(view.stepId) as { x?: number; y?: number } | undefined
    if (!size || positioned?.x === undefined || positioned.y === undefined) {
      positions.set(view.stepId, { x: 0, y: 0 })
      continue
    }
    positions.set(view.stepId, {
      x: Math.round(positioned.x - size.width / 2),
      y: Math.round(positioned.y - size.height / 2)
    })
  }
  return positions
}

export function canvasEdgeId(edge: CanvasDagEdge): string {
  return `${edge.source_step}.${edge.source_port}->${edge.target_step}.${edge.target_port}`
}

export interface CanvasFlowEdgeModel {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  data: CanvasEdgeViewData
  animated: boolean
}

export function buildCanvasFlowEdges({
  graph,
  viewByStepId,
  animated = false
}: {
  graph: CanvasDag
  viewByStepId: ReadonlyMap<string, CanvasNodeViewData>
  animated?: boolean
}): CanvasFlowEdgeModel[] {
  const seen = new Set<string>()
  const edges: CanvasFlowEdgeModel[] = []
  for (const edge of graph.edges) {
    const source = viewByStepId.get(edge.source_step)
    const target = viewByStepId.get(edge.target_step)
    if (!source || !target) continue
    const id = canvasEdgeId(edge)
    if (seen.has(id)) continue
    seen.add(id)
    const sourcePort = source.outputs.find((port) => port.name === edge.source_port)
    const targetPort = target.inputs.find((port) => port.name === edge.target_port)
    edges.push({
      id,
      source: edge.source_step,
      target: edge.target_step,
      // Collapsed nodes stack every handle on the header, so keeping the named
      // handle preserves the DAG while the edge visually snaps to the header.
      ...(edge.source_port ? { sourceHandle: edge.source_port } : {}),
      ...(edge.target_port ? { targetHandle: edge.target_port } : {}),
      data: {
        sourcePort: edge.source_port,
        targetPort: edge.target_port,
        color: sourcePort?.color ?? targetPort?.color ?? canvasPortColor(''),
        invalid: !sourcePort || !targetPort
      },
      animated
    })
  }
  return edges
}
