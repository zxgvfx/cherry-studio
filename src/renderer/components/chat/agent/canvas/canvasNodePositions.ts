export interface CanvasNodePosition {
  x: number
  y: number
}

/*
 * The Pipeline DAG has no place to store layout, and writing coordinates into
 * node.config would leak into the prompt the orchestration model reads. Keep
 * them local to this client instead, versioned so a schema change can't break
 * an old payload.
 */
const STORAGE_VERSION = 'v1'
const STORAGE_PREFIX = `cocoCanvasNodePositions:${STORAGE_VERSION}`

function storageKey(canvasId: string): string {
  return `${STORAGE_PREFIX}:${canvasId}`
}

function isPosition(value: unknown): value is CanvasNodePosition {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { x?: unknown; y?: unknown }
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y)
}

export function loadCanvasNodePositions(canvasId: string): Map<string, CanvasNodePosition> {
  const positions = new Map<string, CanvasNodePosition>()
  if (!canvasId) return positions
  try {
    const raw = window.localStorage.getItem(storageKey(canvasId))
    if (!raw) return positions
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return positions
    for (const [stepId, value] of Object.entries(parsed)) {
      if (isPosition(value)) positions.set(stepId, { x: value.x, y: value.y })
    }
  } catch {
    // Private browsing, a quota error or malformed data all mean "no layout".
  }
  return positions
}

export function saveCanvasNodePositions(canvasId: string, positions: ReadonlyMap<string, CanvasNodePosition>): void {
  if (!canvasId) return
  try {
    if (positions.size === 0) {
      window.localStorage.removeItem(storageKey(canvasId))
      return
    }
    window.localStorage.setItem(storageKey(canvasId), JSON.stringify(Object.fromEntries(positions)))
  } catch {
    // Layout persistence is best-effort; the canvas still lays out on demand.
  }
}
