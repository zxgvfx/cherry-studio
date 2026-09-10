import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getBezierPath } from '@xyflow/react'
import { X } from 'lucide-react'
import { createContext, memo, type MouseEvent, useState } from 'react'

import type { CanvasEdgeViewData } from './canvasNodeView'

export interface CanvasEdgeActions {
  removeEdge: (targetStepId: string, targetPort: string) => void
  readOnly: boolean
}

const CanvasEdgeActionsContext = createContext<CanvasEdgeActions | null>(null)
export const CanvasEdgeActionsProvider = CanvasEdgeActionsContext.Provider

const INVALID_EDGE_COLOR = 'var(--error)'

function PipelineCanvasEdgeComponent({
  data,
  id,
  markerEnd,
  selected,
  sourcePosition,
  sourceX,
  sourceY,
  target,
  targetPosition,
  targetX,
  targetY
}: EdgeProps & { data?: CanvasEdgeViewData }) {
  const actions = use(CanvasEdgeActionsContext)
  const [hovered, setHovered] = useState(false)
  const [path, labelX, labelY] = getBezierPath({
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY
  })

  const invalid = data?.invalid ?? false
  const color = invalid ? INVALID_EDGE_COLOR : (data?.color ?? 'var(--border)')
  const active = hovered || Boolean(selected)
  const label = [data?.sourcePort, data?.targetPort].filter(Boolean).join(' → ')

  return (
    <>
      <BaseEdge
        id={id}
        markerEnd={markerEnd}
        path={path}
        style={{
          opacity: 1,
          stroke: color,
          strokeDasharray: invalid ? '5 4' : undefined,
          strokeWidth: active ? 3 : 2
        }}
      />
      {/* Widened transparent copy so thin curves stay easy to hover and click. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        style={{ pointerEvents: 'stroke' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {active && label ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto flex items-center gap-1 rounded-md border border-border bg-background/95 px-1.5 py-0.5 text-[9px] shadow-sm"
            style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}>
            <span className="max-w-40 truncate" style={{ color }}>
              {label}
            </span>
            {actions && !actions.readOnly && data?.targetPort ? (
              <button
                aria-label={`${label} ×`}
                className="grid size-3.5 place-items-center rounded text-muted-foreground hover:bg-error-subtle hover:text-error"
                data-testid={`canvas-edge-remove-${id}`}
                type="button"
                onClick={(event: MouseEvent<HTMLButtonElement>) => {
                  event.stopPropagation()
                  actions.removeEdge(target, data.targetPort)
                }}>
                <X size={9} />
              </button>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

export const PipelineCanvasEdge = memo(PipelineCanvasEdgeComponent)
