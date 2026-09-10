import '@renderer/assets/styles/vendor/xyflow.css'

import { Button } from '@cherrystudio/ui'
import { usePipelineNodeCatalog } from '@renderer/components/composer/tokenView'
import { toast } from '@renderer/services/toast'
import { CANVAS_SESSION_TRANSITION_EVENT } from '@renderer/utils/canvasSessionTransition'
import type { CanvasDag, CocoSessionCanvasSnapshot } from '@renderer/utils/cocoSessionCanvas'
import type { CocoCanvasVersion } from '@renderer/utils/cocoSessionCanvas'
import {
  cloneCanvasDag,
  defaultPortsForConnection,
  emptyCanvasDag,
  fetchCocoCanvasVersions,
  fetchCocoSessionCanvas,
  makeCanvasStepId,
  removeCanvasEdge,
  removeCanvasNode,
  restoreCocoCanvasVersion,
  runCocoSessionCanvas,
  saveCocoSessionCanvas,
  updateCanvasNodeConfig,
  upsertCanvasEdge
} from '@renderer/utils/cocoSessionCanvas'
import { findPipelineNode } from '@renderer/utils/pipelineNodes'
import {
  Background,
  BackgroundVariant,
  type Connection as RfConnection,
  type Edge as RfEdge,
  MarkerType,
  MiniMap,
  type NodeChange,
  ReactFlow,
  type ReactFlowInstance,
  SelectionMode
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type CanvasNodePosition, loadCanvasNodePositions, saveCanvasNodePositions } from './canvasNodePositions'
import {
  buildCanvasFlowEdges,
  buildCanvasNodeViews,
  CANVAS_EDGE_TYPE,
  CANVAS_NODE_TYPE,
  CANVAS_NODE_WIDTH,
  type CanvasEdgeViewData,
  type CanvasFlowNode,
  canvasNodeHandles,
  canvasNodeHeight,
  layoutCanvasNodeViews
} from './canvasNodeView'
import { canvasPortTypesCompatible } from './canvasTheme'
import { CanvasEdgeActionsProvider, PipelineCanvasEdge } from './PipelineCanvasEdge'
import { CanvasNodeActionsProvider, PipelineCanvasNode } from './PipelineCanvasNode'
import { PipelineCanvasToolbar } from './PipelineCanvasToolbar'
import { type CanvasOutputOption, PipelineNodeInspector } from './PipelineNodeInspector'
import { CANVAS_NODE_DRAG_MIME, PipelineNodePalette } from './PipelineNodePalette'
import { useCanvasHistory } from './useCanvasHistory'

const nodeTypes = { [CANVAS_NODE_TYPE]: PipelineCanvasNode }
const edgeTypes = { [CANVAS_EDGE_TYPE]: PipelineCanvasEdge }
const SNAP_GRID: [number, number] = [16, 16]
const NEW_NODE_GAP = 60
const LIVE_REFRESH_INTERVAL_MS = 800
// React Flow performs native-backed work as it mounts, and Qt WebEngine can
// crash if that overlaps the side-panel animation. Wait for both to settle.
const FLOW_MOUNT_DELAY_MS = 400

export interface PipelineCanvasEditorProps {
  active: boolean
  agentId: string
  liveUpdating?: boolean
  pipelineSessionId?: string
  readOnly: boolean
  sessionId: string
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

export function PipelineCanvasEditor({
  active,
  agentId,
  liveUpdating = false,
  pipelineSessionId,
  readOnly,
  sessionId
}: PipelineCanvasEditorProps) {
  const { t } = useTranslation()
  const { nodes: catalog } = usePipelineNodeCatalog(active)
  const history = useCanvasHistory()
  const { commit, graph, reset } = history

  const [baseline, setBaseline] = useState(() => JSON.stringify(emptyCanvasDag()))
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const [positions, setPositions] = useState<Record<string, CanvasNodePosition>>({})
  const [collapsedStepIds, setCollapsedStepIds] = useState<ReadonlySet<string>>(() => new Set())
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [snapToGrid, setSnapToGrid] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [canvasVersions, setCanvasVersions] = useState<CocoCanvasVersion[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flowMountReady, setFlowMountReady] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    flowPosition: CanvasNodePosition
    left: number
    top: number
  } | null>(null)

  const flowInstanceRef = useRef<ReactFlowInstance<CanvasFlowNode, RfEdge> | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const canvasRootRef = useRef<HTMLDivElement | null>(null)
  const revisionRef = useRef(-1)
  const canvasId = pipelineSessionId || sessionId
  const editorReadOnly = readOnly || liveUpdating
  const dirty = useMemo(() => JSON.stringify(graph) !== baseline, [baseline, graph])

  const views = useMemo(
    () => buildCanvasNodeViews({ catalog, collapsedStepIds, graph }),
    [catalog, collapsedStepIds, graph]
  )
  const viewByStepId = useMemo(() => new Map(views.map((view) => [view.stepId, view])), [views])
  const selectedNode = selectedStepId ? graph.nodes[selectedStepId] : undefined
  const selectedSpec = selectedNode ? (findPipelineNode(catalog, selectedNode.node_id) ?? null) : null

  const applySnapshot = useCallback(
    (snapshot: CocoSessionCanvasSnapshot, resetLayout: boolean) => {
      revisionRef.current = snapshot.revision
      const next = cloneCanvasDag(snapshot.graph)
      reset(next)
      setBaseline(JSON.stringify(snapshot.graph))
      setSelectedStepId((current) => (current && next.nodes[current] ? current : (Object.keys(next.nodes)[0] ?? null)))
      if (resetLayout) {
        const stored = loadCanvasNodePositions(canvasId)
        setPositions(Object.fromEntries([...stored].filter(([stepId]) => next.nodes[stepId])))
      }
    },
    [canvasId, reset]
  )

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void fetchCocoSessionCanvas(agentId, sessionId, pipelineSessionId)
      .then((snapshot) => {
        if (!cancelled) applySnapshot(snapshot, true)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
        reset(emptyCanvasDag())
        setBaseline(JSON.stringify(emptyCanvasDag()))
        setPositions({})
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [active, agentId, applySnapshot, pipelineSessionId, reset, sessionId])

  useEffect(() => {
    if (!active || !liveUpdating) return
    let cancelled = false
    let inFlight = false
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const snapshot = await fetchCocoSessionCanvas(agentId, sessionId, pipelineSessionId)
        if (!cancelled && snapshot.revision !== revisionRef.current) applySnapshot(snapshot, false)
      } catch {
        // Keep the last complete snapshot visible while a proposal commits.
      } finally {
        inFlight = false
      }
    }
    const timer = window.setInterval(() => void refresh(), LIVE_REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, agentId, applySnapshot, liveUpdating, pipelineSessionId, sessionId])

  // Mount once the panel has settled and stay mounted afterwards. Unmounting on
  // every live update was both a crash risk and the reason the canvas could not
  // show the agent's edits as they happened.
  useEffect(() => {
    if (!active || loading) {
      setFlowMountReady(false)
      flowInstanceRef.current = null
      return
    }
    const timer = window.setTimeout(() => setFlowMountReady(true), FLOW_MOUNT_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [active, loading, pipelineSessionId, sessionId])

  useEffect(() => {
    const prepareForSessionTransition = () => {
      setFlowMountReady(false)
      flowInstanceRef.current = null
    }
    window.addEventListener(CANVAS_SESSION_TRANSITION_EVENT, prepareForSessionTransition)
    return () => window.removeEventListener(CANVAS_SESSION_TRANSITION_EVENT, prepareForSessionTransition)
  }, [])

  // Newly added or agent-created nodes get a slot from the dataflow layout;
  // everything the user already arranged keeps its coordinates.
  useEffect(() => {
    const missing = views.filter((view) => !positions[view.stepId])
    if (missing.length === 0) return
    const laidOut = layoutCanvasNodeViews(views, graph.edges)
    setPositions((current) => {
      const next = { ...current }
      for (const view of missing) next[view.stepId] = laidOut.get(view.stepId) ?? { x: 0, y: 0 }
      return next
    })
  }, [graph.edges, positions, views])

  useEffect(() => {
    if (!active || !canvasId) return
    const known = new Map(Object.entries(positions).filter(([stepId]) => graph.nodes[stepId]))
    saveCanvasNodePositions(canvasId, known)
  }, [active, canvasId, graph.nodes, positions])

  const flowNodes = useMemo<CanvasFlowNode[]>(
    () =>
      views.map((view) => {
        const height = canvasNodeHeight(view)
        return {
          connectable: !editorReadOnly,
          data: view,
          draggable: !editorReadOnly,
          // Publishing handles keeps every edge visible: React Flow discards an
          // edge whose endpoint has no handle bounds, and it drops those bounds
          // whenever a node object is recreated without `measured`.
          handles: canvasNodeHandles(view),
          height,
          id: view.stepId,
          initialHeight: height,
          initialWidth: CANVAS_NODE_WIDTH,
          position: positions[view.stepId] ?? { x: 0, y: 0 },
          selected: view.stepId === selectedStepId,
          style: { height, width: CANVAS_NODE_WIDTH },
          type: CANVAS_NODE_TYPE,
          width: CANVAS_NODE_WIDTH
        }
      }),
    [editorReadOnly, positions, selectedStepId, views]
  )

  const flowEdges = useMemo<RfEdge[]>(
    () =>
      buildCanvasFlowEdges({ animated: liveUpdating, graph, viewByStepId }).map((edge) => ({
        ...edge,
        markerEnd: { color: edge.data.color, height: 14, type: MarkerType.ArrowClosed, width: 14 },
        type: CANVAS_EDGE_TYPE
      })),
    [graph, liveUpdating, viewByStepId]
  )

  const outputOptions = useMemo<CanvasOutputOption[]>(
    () =>
      views.flatMap((view) => {
        const ports = view.outputs.length > 0 ? view.outputs.map((port) => port.name) : ['output']
        return ports.map((port) => ({
          sourcePort: port,
          sourceStep: view.stepId,
          value: `${view.stepId}.${port}`
        }))
      }),
    [views]
  )

  const nextFreePosition = useCallback((current: Record<string, CanvasNodePosition>): CanvasNodePosition => {
    const values = Object.values(current)
    if (values.length === 0) return { x: 0, y: 0 }
    const rightmost = values.reduce((best, item) => (item.x > best.x ? item : best), values[0])
    return { x: rightmost.x + CANVAS_NODE_WIDTH + NEW_NODE_GAP, y: rightmost.y }
  }, [])

  const addNode = useCallback(
    (nodeId: string, options: { chainFromSelection: boolean; position?: CanvasNodePosition }) => {
      if (editorReadOnly) return
      const stepId = makeCanvasStepId(nodeId, new Set(Object.keys(graph.nodes)))
      commit((current) => {
        const next = cloneCanvasDag(current)
        next.nodes[stepId] = { config: {}, node_id: nodeId, step_id: stepId }
        const source = options.chainFromSelection && selectedStepId ? next.nodes[selectedStepId] : undefined
        if (!source) return next
        const occupied = new Set(
          next.edges.filter((edge) => edge.target_step === stepId).map((edge) => edge.target_port)
        )
        const ports = defaultPortsForConnection(source, next.nodes[stepId], catalog, occupied)
        return upsertCanvasEdge(next, { source_step: source.step_id, target_step: stepId, ...ports })
      })
      setPositions((current) => ({ ...current, [stepId]: options.position ?? nextFreePosition(current) }))
      setSelectedStepId(stepId)
      setInspectorOpen(true)
    },
    [catalog, commit, editorReadOnly, graph.nodes, nextFreePosition, selectedStepId]
  )

  const handleNodesChange = useCallback((changes: NodeChange<CanvasFlowNode>[]) => {
    const moved: Record<string, CanvasNodePosition> = {}
    for (const change of changes) {
      if (change.type === 'position' && change.position) moved[change.id] = change.position
      else if (change.type === 'select' && change.selected) setSelectedStepId(change.id)
    }
    if (Object.keys(moved).length > 0) setPositions((current) => ({ ...current, ...moved }))
  }, [])

  const isValidConnection = useCallback(
    (connection: RfConnection | RfEdge) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return false
      const source = viewByStepId.get(connection.source)
      const target = viewByStepId.get(connection.target)
      if (!source || !target) return false
      const sourcePort = source.outputs.find((port) => port.name === connection.sourceHandle)
      const targetPort = target.inputs.find((port) => port.name === connection.targetHandle)
      if (!sourcePort || !targetPort) return true
      return canvasPortTypesCompatible(sourcePort.assetType, targetPort.assetType)
    },
    [viewByStepId]
  )

  const handleConnect = useCallback(
    (connection: RfConnection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return
      commit((current) => {
        const source = current.nodes[connection.source]
        const target = current.nodes[connection.target]
        if (!source || !target) return current
        if (connection.sourceHandle && connection.targetHandle) {
          return upsertCanvasEdge(current, {
            source_port: connection.sourceHandle,
            source_step: source.step_id,
            target_port: connection.targetHandle,
            target_step: target.step_id
          })
        }
        const occupied = new Set(
          current.edges.filter((edge) => edge.target_step === target.step_id).map((edge) => edge.target_port)
        )
        const ports = defaultPortsForConnection(source, target, catalog, occupied)
        return upsertCanvasEdge(current, { source_step: source.step_id, target_step: target.step_id, ...ports })
      })
    },
    [catalog, commit]
  )

  const removeEdgeByTarget = useCallback(
    (targetStep: string, targetPort: string) => {
      if (editorReadOnly) return
      commit((current) => removeCanvasEdge(current, { target_port: targetPort, target_step: targetStep }))
    },
    [commit, editorReadOnly]
  )

  const handleNodesDelete = useCallback(
    (deleted: { id: string }[]) => {
      if (editorReadOnly) return
      commit((current) => deleted.reduce((accumulator, node) => removeCanvasNode(accumulator, node.id), current))
      setSelectedStepId((current) => (current && deleted.some((node) => node.id === current) ? null : current))
    },
    [commit, editorReadOnly]
  )

  const handleEdgesDelete = useCallback(
    (deleted: RfEdge[]) => {
      if (editorReadOnly) return
      commit((current) =>
        deleted.reduce((accumulator, edge) => {
          const data = edge.data as CanvasEdgeViewData | undefined
          if (!data?.targetPort) return accumulator
          return removeCanvasEdge(accumulator, { target_port: data.targetPort, target_step: edge.target })
        }, current)
      )
    },
    [commit, editorReadOnly]
  )

  const toggleCollapse = useCallback((stepId: string) => {
    setCollapsedStepIds((current) => {
      const next = new Set(current)
      if (next.has(stepId)) next.delete(stepId)
      else next.add(stepId)
      return next
    })
  }, [])

  const fitCanvas = useCallback(() => {
    void flowInstanceRef.current?.fitView({ duration: 200, maxZoom: 1, padding: 0.18 })
  }, [])

  const handleAutoLayout = useCallback(() => {
    setPositions(Object.fromEntries(layoutCanvasNodeViews(views, graph.edges)))
    window.setTimeout(fitCanvas, 0)
  }, [fitCanvas, graph.edges, views])

  const persistCanvas = useCallback(
    async (notify: boolean): Promise<CanvasDag | null> => {
      setSaving(true)
      try {
        const snapshot = await saveCocoSessionCanvas(agentId, sessionId, graph, pipelineSessionId)
        revisionRef.current = snapshot.revision
        reset(cloneCanvasDag(snapshot.graph))
        setBaseline(JSON.stringify(snapshot.graph))
        if (historyOpen && pipelineSessionId) {
          setCanvasVersions((await fetchCocoCanvasVersions(pipelineSessionId)).toReversed())
        }
        if (notify) toast.success(t('library.config.agent.coco.canvas.saved'))
        return snapshot.graph
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : t('library.config.agent.coco.canvas.save_failed'))
        return null
      } finally {
        setSaving(false)
      }
    },
    [agentId, graph, historyOpen, pipelineSessionId, reset, sessionId, t]
  )

  const handleSave = useCallback(() => {
    void persistCanvas(true)
  }, [persistCanvas])

  const handleRun = useCallback(async () => {
    if (editorReadOnly || running || saving) return
    if (Object.keys(graph.nodes).length === 0) {
      toast.error(t('library.config.agent.coco.canvas.run_empty'))
      return
    }
    setRunning(true)
    try {
      let dag = graph
      if (dirty) {
        const saved = await persistCanvas(false)
        if (!saved) return
        dag = saved
      }
      const result = await runCocoSessionCanvas(dag, pipelineSessionId)
      toast.success(t('library.config.agent.coco.canvas.run_started', { runId: result.runId }))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t('library.config.agent.coco.canvas.run_failed'))
    } finally {
      setRunning(false)
    }
  }, [dirty, editorReadOnly, graph, persistCanvas, pipelineSessionId, running, saving, t])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const openContextMenu = useCallback(
    (event: { clientX: number; clientY: number; preventDefault: () => void }) => {
      if (editorReadOnly) return
      event.preventDefault()
      const flowPosition = flowInstanceRef.current?.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY
      }) ?? { x: 0, y: 0 }
      const bounds = canvasRootRef.current?.getBoundingClientRect()
      const width = 256
      const height = 320
      const localX = event.clientX - (bounds?.left ?? 0)
      const localY = event.clientY - (bounds?.top ?? 0)
      const maxX = Math.max(8, (bounds?.width ?? window.innerWidth) - width - 8)
      const maxY = Math.max(8, (bounds?.height ?? window.innerHeight) - height - 8)
      setContextMenu({
        flowPosition,
        left: Math.min(Math.max(8, localX), maxX),
        top: Math.min(Math.max(8, localY), maxY)
      })
    },
    [editorReadOnly]
  )

  useEffect(() => {
    if (!contextMenu) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeContextMenu()
    }
    const onMouseDown = (event: MouseEvent) => {
      const root = contextMenuRef.current
      if (root && !root.contains(event.target as Node)) closeContextMenu()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousedown', onMouseDown)
    }
  }, [closeContextMenu, contextMenu])

  const toggleCanvasHistory = useCallback(async () => {
    if (historyOpen) {
      setHistoryOpen(false)
      return
    }
    setHistoryOpen(true)
    if (!pipelineSessionId) return
    setHistoryLoading(true)
    try {
      setCanvasVersions((await fetchCocoCanvasVersions(pipelineSessionId)).toReversed())
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t('library.config.agent.coco.canvas.history_load_failed'))
    } finally {
      setHistoryLoading(false)
    }
  }, [historyOpen, pipelineSessionId, t])

  const restoreCanvasVersion = useCallback(
    async (version: CocoCanvasVersion) => {
      if (!pipelineSessionId || restoringVersionId) return
      setRestoringVersionId(version.id)
      try {
        const snapshot = await restoreCocoCanvasVersion(pipelineSessionId, version.id, revisionRef.current)
        applySnapshot(snapshot, true)
        setCanvasVersions((await fetchCocoCanvasVersions(pipelineSessionId)).toReversed())
        toast.success(t('library.config.agent.coco.canvas.history_restored'))
      } catch (cause) {
        toast.error(
          cause instanceof Error ? cause.message : t('library.config.agent.coco.canvas.history_restore_failed')
        )
      } finally {
        setRestoringVersionId(null)
      }
    },
    [applySnapshot, pipelineSessionId, restoringVersionId, t]
  )

  useEffect(() => {
    setHistoryOpen(false)
    setCanvasVersions([])
  }, [pipelineSessionId, sessionId])

  useEffect(() => {
    if (!contextMenu) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeContextMenu()
    }
    const onPointerDown = (event: PointerEvent) => {
      const root = contextMenuRef.current
      if (root && event.target instanceof Node && root.contains(event.target)) return
      closeContextMenu()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [closeContextMenu, contextMenu])

  useEffect(() => {
    if (!active || editorReadOnly) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      if (isEditableTarget(event.target)) return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        history.undo()
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault()
        history.redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, editorReadOnly, history])

  const nodeActions = useMemo(() => ({ toggleCollapse }), [toggleCollapse])
  const edgeActions = useMemo(
    () => ({ readOnly: editorReadOnly, removeEdge: removeEdgeByTarget }),
    [editorReadOnly, removeEdgeByTarget]
  )

  const nodeCount = views.length
  const issueCount = views.reduce((sum, view) => sum + (view.missingRequired.length > 0 ? 1 : 0), 0)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="coco-session-canvas-pane">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {paletteOpen ? (
          <PipelineNodePalette
            catalog={catalog}
            disabled={editorReadOnly}
            onAdd={(node) => addNode(node.node_id, { chainFromSelection: true })}
          />
        ) : null}
        <div
          ref={canvasRootRef}
          className="relative min-h-0 min-w-0 flex-1"
          onDragOver={(event) => {
            if (editorReadOnly) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={(event) => {
            if (editorReadOnly) return
            const nodeId = event.dataTransfer.getData(CANVAS_NODE_DRAG_MIME)
            if (!nodeId) return
            event.preventDefault()
            const point = flowInstanceRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY })
            addNode(nodeId, { chainFromSelection: false, position: point })
          }}>
          {loading ? (
            <div className="absolute inset-0 z-10 grid place-items-center bg-background text-muted-foreground text-xs">
              {t('common.loading')}
            </div>
          ) : error ? (
            <div className="absolute inset-0 z-10 grid place-items-center px-6 text-center text-destructive text-xs">
              {t('library.config.agent.coco.canvas.load_failed')}
            </div>
          ) : null}
          {!loading && !error && flowMountReady ? (
            <CanvasNodeActionsProvider value={nodeActions}>
              <CanvasEdgeActionsProvider value={edgeActions}>
                <ReactFlow<CanvasFlowNode, RfEdge>
                  colorMode="system"
                  defaultViewport={{ x: 40, y: 40, zoom: 0.85 }}
                  deleteKeyCode={editorReadOnly ? null : ['Delete', 'Backspace']}
                  edges={flowEdges}
                  edgeTypes={edgeTypes}
                  elementsSelectable
                  isValidConnection={isValidConnection}
                  maxZoom={1.75}
                  minZoom={0.15}
                  nodes={flowNodes}
                  nodesConnectable={!editorReadOnly}
                  nodesDraggable={!editorReadOnly}
                  nodeTypes={nodeTypes}
                  onConnect={handleConnect}
                  onEdgesDelete={handleEdgesDelete}
                  onInit={(instance) => {
                    flowInstanceRef.current = instance
                  }}
                  onNodeClick={(_event, node) => {
                    closeContextMenu()
                    setSelectedStepId(node.id)
                    setInspectorOpen(true)
                  }}
                  onNodeContextMenu={(event) => openContextMenu(event)}
                  onNodesChange={handleNodesChange}
                  onNodesDelete={handleNodesDelete}
                  onPaneClick={() => {
                    closeContextMenu()
                    setSelectedStepId(null)
                  }}
                  onPaneContextMenu={(event) => openContextMenu(event)}
                  panOnDrag={[1]}
                  panOnScroll
                  proOptions={{ hideAttribution: true }}
                  selectionMode={SelectionMode.Partial}
                  selectionOnDrag={!editorReadOnly}
                  snapGrid={SNAP_GRID}
                  snapToGrid={snapToGrid}>
                  <Background gap={18} size={1} variant={BackgroundVariant.Dots} />
                  <MiniMap<CanvasFlowNode>
                    bgColor="var(--card)"
                    className="overflow-hidden rounded-md border border-border shadow-sm"
                    maskColor="color-mix(in srgb, var(--background) 72%, transparent)"
                    nodeColor={(node) => node.data.accent}
                    pannable
                    position="bottom-right"
                    zoomable
                  />
                  <PipelineCanvasToolbar
                    canRedo={history.canRedo}
                    canRun={nodeCount > 0}
                    canUndo={history.canUndo}
                    dirty={dirty}
                    historyOpen={historyOpen}
                    inspectorOpen={inspectorOpen}
                    onAutoLayout={handleAutoLayout}
                    onFitView={fitCanvas}
                    onRedo={history.redo}
                    onRun={() => void handleRun()}
                    onSave={handleSave}
                    onToggleHistory={() => void toggleCanvasHistory()}
                    onToggleInspector={() => setInspectorOpen((current) => !current)}
                    onTogglePalette={() => setPaletteOpen((current) => !current)}
                    onToggleSnap={() => setSnapToGrid((current) => !current)}
                    onUndo={history.undo}
                    onZoomIn={() => void flowInstanceRef.current?.zoomIn({ duration: 150 })}
                    onZoomOut={() => void flowInstanceRef.current?.zoomOut({ duration: 150 })}
                    paletteOpen={paletteOpen}
                    readOnly={editorReadOnly}
                    running={running}
                    saving={saving}
                    snapToGrid={snapToGrid}
                  />
                </ReactFlow>
              </CanvasEdgeActionsProvider>
            </CanvasNodeActionsProvider>
          ) : null}
          {historyOpen ? (
            <div
              className="absolute top-12 left-2 z-20 flex max-h-[min(70vh,520px)] w-72 flex-col overflow-hidden rounded-lg border border-border bg-background/98 shadow-xl"
              data-testid="canvas-history-panel">
              <div className="border-border border-b px-3 py-2">
                <div className="font-medium text-xs">{t('library.config.agent.coco.canvas.history')}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {t('library.config.agent.coco.canvas.history_hint')}
                </div>
              </div>
              <div className="min-h-16 overflow-y-auto p-1.5">
                {historyLoading ? (
                  <div className="px-2 py-6 text-center text-muted-foreground text-xs">{t('common.loading')}</div>
                ) : canvasVersions.length === 0 ? (
                  <div className="px-2 py-6 text-center text-muted-foreground text-xs">
                    {t('library.config.agent.coco.canvas.history_empty')}
                  </div>
                ) : (
                  canvasVersions.map((version, index) => (
                    <div
                      className="mb-1 rounded-md border border-transparent px-2 py-2 hover:border-border hover:bg-muted/50"
                      key={version.id}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-xs">
                            {t('library.config.agent.coco.canvas.history_turn', { turn: version.userTurn })}
                            {index === 0 ? ` · ${t('library.config.agent.coco.canvas.history_current')}` : ''}
                          </div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
                            {t(`library.config.agent.coco.canvas.history_source.${version.source}`, {
                              defaultValue: version.source
                            })}
                            {' · '}
                            {Object.keys(version.graph.nodes).length} / {version.graph.edges.length}
                          </div>
                          <div className="mt-0.5 text-[10px] text-muted-foreground">
                            {new Date(version.createdAt * 1000).toLocaleString()}
                          </div>
                        </div>
                        <Button
                          className="h-6 shrink-0 px-2 text-[11px]"
                          disabled={editorReadOnly || index === 0 || restoringVersionId !== null}
                          size="sm"
                          variant="outline"
                          onClick={() => void restoreCanvasVersion(version)}>
                          {restoringVersionId === version.id
                            ? t('common.loading')
                            : t('library.config.agent.coco.canvas.history_restore')}
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : null}
          {contextMenu ? (
            <div
              ref={contextMenuRef}
              className="absolute z-30"
              data-testid="canvas-add-node-menu"
              style={{ left: contextMenu.left, top: contextMenu.top }}
              onContextMenu={(event) => event.preventDefault()}>
              <PipelineNodePalette
                catalog={catalog}
                disabled={editorReadOnly}
                variant="menu"
                onAdd={(node) => {
                  addNode(node.node_id, { chainFromSelection: false, position: contextMenu.flowPosition })
                  closeContextMenu()
                }}
              />
            </div>
          ) : null}
          {!loading && !error && nodeCount === 0 ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center px-8 text-center text-muted-foreground text-xs">
              {t('library.config.agent.coco.canvas.empty')}
            </div>
          ) : null}
        </div>
        {inspectorOpen ? (
          <PipelineNodeInspector
            graph={graph}
            node={selectedNode}
            outputOptions={outputOptions}
            readOnly={editorReadOnly}
            spec={selectedSpec}
            onClose={() => setInspectorOpen(false)}
            onConfigChange={(stepId, config) => commit((current) => updateCanvasNodeConfig(current, stepId, config))}
            onConnect={(option, targetStep, targetPort) =>
              commit((current: CanvasDag) =>
                upsertCanvasEdge(current, {
                  source_port: option.sourcePort,
                  source_step: option.sourceStep,
                  target_port: targetPort,
                  target_step: targetStep
                })
              )
            }
            onDisconnect={removeEdgeByTarget}
            onRemove={(stepId) => {
              commit((current) => removeCanvasNode(current, stepId))
              setSelectedStepId(null)
            }}
          />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-border border-t px-3 py-1.5">
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {t('library.config.agent.coco.canvas.graph_summary', { edges: graph.edges.length, nodes: nodeCount })}
        </span>
        {issueCount > 0 ? (
          <span className="shrink-0 text-[11px] text-warning">
            {t('library.config.agent.coco.canvas.issue_count', { count: issueCount })}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {liveUpdating
            ? t('library.config.agent.coco.canvas.live_updating_short')
            : running
              ? t('library.config.agent.coco.canvas.running')
              : dirty
                ? t('library.config.agent.coco.canvas.unsaved')
                : null}
        </span>
      </div>
    </div>
  )
}
