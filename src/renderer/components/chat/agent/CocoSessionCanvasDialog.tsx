import { PipelineCanvasEditor } from './canvas'

/**
 * The Agent right pane mounts the pipeline graph editor under this name. The
 * implementation lives in `./canvas`, which holds the node/edge components,
 * geometry and inspector.
 */
export const CocoSessionCanvasEditor = PipelineCanvasEditor

export function readPipelineSessionId(configuration: unknown, sessionId: string): string | undefined {
  if (!configuration || typeof configuration !== 'object' || !sessionId) return undefined
  const bindings = (configuration as { coco_pipeline_sessions?: unknown }).coco_pipeline_sessions
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return undefined
  const row = (bindings as Record<string, { id?: unknown }>)[sessionId]
  return typeof row?.id === 'string' && row.id ? row.id : undefined
}
