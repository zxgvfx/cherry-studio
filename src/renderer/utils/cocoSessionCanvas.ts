import type { PipelineNodeCatalogItem } from '@renderer/utils/pipelineNodes'
import { DEFAULT_PIPELINE_API_BASE, resolvePipelineApiBase } from '@renderer/utils/pipelineNodes'

import { cocoAgentProxy } from './cocoAgentProxy'

export interface CanvasDagNode {
  step_id: string
  node_id: string
  config: Record<string, unknown>
}

export interface CanvasDagEdge {
  source_step: string
  source_port: string
  target_step: string
  target_port: string
}

export interface CanvasDag {
  nodes: Record<string, CanvasDagNode>
  edges: CanvasDagEdge[]
}

export interface CocoSessionCanvasSnapshot {
  pipeline_session_id: string
  revision: number
  script: string
  graph: CanvasDag
}

export interface CocoCanvasVersion {
  id: string
  userTurn: number
  revision: number
  createdAt: number
  source: string
  restoredFrom?: string
  graph: CanvasDag
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function emptyCanvasDag(): CanvasDag {
  return { nodes: {}, edges: [] }
}

export function cloneCanvasDag(graph: CanvasDag): CanvasDag {
  return JSON.parse(JSON.stringify(graph)) as CanvasDag
}

export function parseCanvasDag(raw: unknown): CanvasDag {
  if (!isRecord(raw)) return emptyCanvasDag()
  // Pipeline proposals may store a complete workflow ({ id, version, dag })
  // while manual canvas updates store the bare { nodes, edges } DAG.
  if (isRecord(raw.dag)) return parseCanvasDag(raw.dag)
  const nodes: Record<string, CanvasDagNode> = {}
  const rawNodes = raw.nodes
  if (isRecord(rawNodes)) {
    for (const [stepId, item] of Object.entries(rawNodes)) {
      if (!isRecord(item)) continue
      const config = isRecord(item.config) ? { ...item.config } : {}
      nodes[stepId] = {
        step_id: readString(item.step_id, stepId),
        node_id: readString(item.node_id),
        config
      }
    }
  }
  const edges: CanvasDagEdge[] = []
  if (Array.isArray(raw.edges)) {
    for (const item of raw.edges) {
      if (!isRecord(item)) continue
      const source_step = readString(item.source_step)
      const target_step = readString(item.target_step)
      if (!source_step || !target_step) continue
      edges.push({
        source_step,
        source_port: readString(item.source_port),
        target_step,
        target_port: readString(item.target_port)
      })
    }
  }
  return { nodes, edges }
}

export function parseCocoSessionCanvasSnapshot(raw: unknown): CocoSessionCanvasSnapshot | null {
  if (!isRecord(raw)) return null
  if (isRecord(raw.graph) || typeof raw.script === 'string' || typeof raw.pipeline_session_id === 'string') {
    return {
      pipeline_session_id: readString(raw.pipeline_session_id),
      revision: typeof raw.revision === 'number' ? raw.revision : 0,
      script: readString(raw.script),
      graph: parseCanvasDag(raw.graph)
    }
  }
  if (isRecord(raw.context)) {
    return parseCocoSessionCanvasSnapshot(canvasFromPipelineSession(raw, readString(raw.id)))
  }
  return null
}

export function canvasFromPipelineSession(snapshot: unknown, pipelineSessionId: string): CocoSessionCanvasSnapshot {
  if (!isRecord(snapshot)) {
    return { pipeline_session_id: pipelineSessionId, revision: 0, script: '', graph: emptyCanvasDag() }
  }
  const context = isRecord(snapshot.context) ? snapshot.context : {}
  const metadata = isRecord(context.metadata) ? context.metadata : {}
  const graphObj = isRecord(context.graph) ? context.graph : {}
  let script = ''
  if (graphObj.representation === 'pipeline_script') script = readString(graphObj.script)
  else script = readString(metadata.pipeline_script)
  return {
    pipeline_session_id: pipelineSessionId || readString(snapshot.id),
    revision: typeof snapshot.revision === 'number' ? snapshot.revision : 0,
    script,
    graph: parseCanvasDag(metadata.graph_baseline)
  }
}

export function makeCanvasStepId(nodeId: string, existing: ReadonlySet<string>): string {
  const base = nodeId.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'node'
  if (!existing.has(base)) return base
  let index = 2
  while (existing.has(`${base}_${index}`)) index += 1
  return `${base}_${index}`
}

export function addCanvasNode(graph: CanvasDag, nodeId: string): { graph: CanvasDag; stepId: string } {
  const next = cloneCanvasDag(graph)
  const stepId = makeCanvasStepId(nodeId, new Set(Object.keys(next.nodes)))
  next.nodes[stepId] = { step_id: stepId, node_id: nodeId, config: {} }
  return { graph: next, stepId }
}

export function removeCanvasNode(graph: CanvasDag, stepId: string): CanvasDag {
  const next = cloneCanvasDag(graph)
  delete next.nodes[stepId]
  next.edges = next.edges.filter((edge) => edge.source_step !== stepId && edge.target_step !== stepId)
  return next
}

export function updateCanvasNodeConfig(graph: CanvasDag, stepId: string, config: Record<string, unknown>): CanvasDag {
  const current = graph.nodes[stepId]
  if (!current) return graph
  const next = cloneCanvasDag(graph)
  next.nodes[stepId] = { ...current, config: { ...config } }
  return next
}

export function upsertCanvasEdge(graph: CanvasDag, edge: CanvasDagEdge): CanvasDag {
  const next = cloneCanvasDag(graph)
  next.edges = next.edges.filter(
    (item) => !(item.target_step === edge.target_step && item.target_port === edge.target_port)
  )
  next.edges.push({ ...edge })
  return next
}

export function removeCanvasEdge(
  graph: CanvasDag,
  edge: Pick<CanvasDagEdge, 'target_step' | 'target_port'>
): CanvasDag {
  const next = cloneCanvasDag(graph)
  next.edges = next.edges.filter(
    (item) => !(item.target_step === edge.target_step && item.target_port === edge.target_port)
  )
  return next
}

export function incomingEdge(graph: CanvasDag, stepId: string, port: string): CanvasDagEdge | undefined {
  return graph.edges.find((edge) => edge.target_step === stepId && edge.target_port === port)
}

export function defaultPortsForConnection(
  source: CanvasDagNode,
  target: CanvasDagNode,
  catalog: readonly PipelineNodeCatalogItem[],
  occupiedTargetPorts: ReadonlySet<string>
): { source_port: string; target_port: string } {
  const sourceSpec = catalog.find((item) => item.node_id === source.node_id)
  const targetSpec = catalog.find((item) => item.node_id === target.node_id)
  const sourcePort = sourceSpec?.output_ports[0]?.name || 'output'
  const targetPort =
    targetSpec?.input_ports.find((port) => !occupiedTargetPorts.has(port.name))?.name ||
    targetSpec?.input_ports[0]?.name ||
    'input'
  return { source_port: sourcePort, target_port: targetPort }
}

function canvasPath(agentId: string, sessionId: string): string {
  return `/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/coco/canvas`
}

async function fetchPipelineSession(pipelineSessionId: string): Promise<CocoSessionCanvasSnapshot> {
  const base = (await resolvePipelineApiBase()) || DEFAULT_PIPELINE_API_BASE
  const response = await fetch(`${base}/api/agents/sessions/${encodeURIComponent(pipelineSessionId)}`)
  if (!response.ok) throw new Error(`pipeline session ${response.status}`)
  return canvasFromPipelineSession(await response.json(), pipelineSessionId)
}

export async function fetchCocoSessionCanvas(
  agentId: string,
  sessionId: string,
  pipelineSessionId?: string
): Promise<CocoSessionCanvasSnapshot> {
  try {
    const snapshot = parseCocoSessionCanvasSnapshot(await cocoAgentProxy('GET', canvasPath(agentId, sessionId)))
    if (snapshot) return snapshot
  } catch {
    if (!pipelineSessionId) throw new Error('canvas load failed')
  }
  if (pipelineSessionId) return fetchPipelineSession(pipelineSessionId)
  throw new Error('canvas load failed')
}

export async function saveCocoSessionCanvas(
  agentId: string,
  sessionId: string,
  graph: CanvasDag,
  pipelineSessionId?: string
): Promise<CocoSessionCanvasSnapshot> {
  try {
    const snapshot = parseCocoSessionCanvasSnapshot(
      await cocoAgentProxy('POST', canvasPath(agentId, sessionId), { graph })
    )
    if (snapshot) return snapshot
  } catch {
    if (!pipelineSessionId) throw new Error('canvas save failed')
  }
  if (!pipelineSessionId) throw new Error('canvas save failed')
  const base = (await resolvePipelineApiBase()) || DEFAULT_PIPELINE_API_BASE
  const current = await fetchPipelineSession(pipelineSessionId)
  const response = await fetch(`${base}/api/agents/sessions/${encodeURIComponent(pipelineSessionId)}/canvas`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph, expected_revision: current.revision })
  })
  if (!response.ok) throw new Error(`pipeline canvas ${response.status}`)
  return canvasFromPipelineSession(await response.json(), pipelineSessionId)
}

export async function fetchCocoCanvasVersions(pipelineSessionId: string): Promise<CocoCanvasVersion[]> {
  const base = (await resolvePipelineApiBase()) || DEFAULT_PIPELINE_API_BASE
  const response = await fetch(`${base}/api/agents/sessions/${encodeURIComponent(pipelineSessionId)}/canvas/versions`)
  if (!response.ok) throw new Error(`pipeline canvas history ${response.status}`)
  const payload = await response.json()
  const raw = isRecord(payload) && Array.isArray(payload.versions) ? payload.versions : []
  return raw.flatMap((item): CocoCanvasVersion[] => {
    if (!isRecord(item) || typeof item.id !== 'string') return []
    return [
      {
        id: item.id,
        userTurn: typeof item.user_turn === 'number' ? item.user_turn : 0,
        revision: typeof item.revision === 'number' ? item.revision : 0,
        createdAt: typeof item.created_at === 'number' ? item.created_at : 0,
        source: readString(item.source),
        ...(typeof item.restored_from === 'string' ? { restoredFrom: item.restored_from } : {}),
        graph: parseCanvasDag(item.graph)
      }
    ]
  })
}

export async function restoreCocoCanvasVersion(
  pipelineSessionId: string,
  versionId: string,
  expectedRevision: number
): Promise<CocoSessionCanvasSnapshot> {
  const base = (await resolvePipelineApiBase()) || DEFAULT_PIPELINE_API_BASE
  const response = await fetch(`${base}/api/agents/sessions/${encodeURIComponent(pipelineSessionId)}/canvas/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version_id: versionId, expected_revision: expectedRevision })
  })
  if (!response.ok) throw new Error(`pipeline canvas restore ${response.status}`)
  return canvasFromPipelineSession(await response.json(), pipelineSessionId)
}

function readHttpError(text: string, status: number): string {
  const fallback = `pipeline run ${status}`
  if (!text.trim()) return fallback
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'string' && parsed.trim()) return parsed
    if (!isRecord(parsed)) return text
    const detail = parsed.detail
    if (typeof detail === 'string' && detail.trim()) return detail
    if (Array.isArray(detail)) {
      const messages = detail.flatMap((item) => {
        if (typeof item === 'string') return [item]
        if (isRecord(item) && typeof item.msg === 'string') return [item.msg]
        return []
      })
      if (messages.length > 0) return messages.join('; ')
    }
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error
  } catch {
    // Keep the raw response body when it is not JSON.
  }
  return text
}

export async function runCocoSessionCanvas(
  graph: CanvasDag,
  pipelineSessionId?: string
): Promise<{ runId: string; status: string }> {
  if (Object.keys(graph.nodes).length === 0) {
    throw new Error('empty canvas')
  }
  const base = (await resolvePipelineApiBase()) || DEFAULT_PIPELINE_API_BASE
  const body: Record<string, unknown> = {
    dag: graph,
    reuse_unchanged: true
  }
  if (pipelineSessionId) {
    body.inputs = { __agent_session_id: pipelineSessionId }
    body.tags = [`agent_session:${pipelineSessionId}`]
    body.workflow_id = pipelineSessionId
  }
  const response = await fetch(`${base}/api/workflows/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  if (!response.ok) throw new Error(readHttpError(text, response.status))
  let payload: unknown = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    throw new Error('pipeline run returned invalid json')
  }
  const runId = isRecord(payload) && typeof payload.run_id === 'string' ? payload.run_id : ''
  if (!runId) throw new Error('pipeline run missing run_id')
  return {
    runId,
    status: isRecord(payload) && typeof payload.status === 'string' ? payload.status : 'running'
  }
}
