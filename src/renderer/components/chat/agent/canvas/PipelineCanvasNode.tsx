import type { PipelineNodeCategoryId } from '@renderer/utils/pipelineNodes'
import { cn } from '@renderer/utils/style'
import { Handle, type NodeProps, Position } from '@xyflow/react'
import {
  Boxes,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Hand,
  HardDriveDownload,
  Image,
  type LucideIcon,
  Scissors,
  Sparkles,
  TriangleAlert,
  Video,
  Waves,
  Workflow
} from 'lucide-react'
import { createContext, memo, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'

import {
  CANVAS_NODE_BODY_PADDING,
  CANVAS_NODE_HEADER_HEIGHT,
  CANVAS_NODE_WIDTH,
  CANVAS_PORT_ROW_HEIGHT,
  CANVAS_WIDGET_ROW_HEIGHT,
  CANVAS_WIDGET_SECTION_PADDING,
  type CanvasFlowNode,
  canvasHandleBox,
  canvasNodeHeight,
  canvasNodePortRows,
  type CanvasNodeViewData,
  type CanvasPortView
} from './canvasNodeView'

export interface CanvasNodeActions {
  toggleCollapse: (stepId: string) => void
}

/*
 * React Flow only forwards `data` to a custom node, so node-level commands
 * travel through context. That keeps `data` serializable and lets the node stay
 * memoized while the editor owns the mutation logic.
 */
const CanvasNodeActionsContext = createContext<CanvasNodeActions | null>(null)
export const CanvasNodeActionsProvider = CanvasNodeActionsContext.Provider

const CATEGORY_ICONS: Record<PipelineNodeCategoryId, LucideIcon> = {
  '3d': Boxes,
  data: Braces,
  image: Image,
  interactive: Hand,
  io: HardDriveDownload,
  model: Sparkles,
  motion: Waves,
  other: CircleDashed,
  segmentation: Scissors,
  video: Video,
  workflow: Workflow
}

function PortDot({
  port,
  index,
  type,
  view,
  connectable
}: {
  port: CanvasPortView
  index: number
  type: 'source' | 'target'
  view: CanvasNodeViewData
  connectable: boolean
}) {
  const box = canvasHandleBox(view, index, type)
  const filled = type === 'source' || port.connected
  return (
    <Handle
      id={port.name}
      type={type}
      position={type === 'target' ? Position.Left : Position.Right}
      isConnectable={connectable}
      className="!min-h-0 !min-w-0 !transform-none !rounded-full !border-2"
      style={{
        backgroundColor: filled ? port.color : 'var(--card)',
        borderColor: port.color,
        borderStyle: port.synthetic ? 'dashed' : 'solid',
        height: box.size,
        left: box.left,
        opacity: view.collapsed ? 0 : 1,
        top: box.top,
        width: box.size
      }}
    />
  )
}

/**
 * Unnamed handles that let an edge without port names resolve: React Flow falls
 * back to the first handle of the matching type, and DOM order decides which
 * one that is once the node gets measured.
 */
function FallbackHandles({ view }: { view: CanvasNodeViewData }) {
  return (
    <>
      {(['target', 'source'] as const).map((type) => {
        const box = canvasHandleBox(view, 0, type)
        return (
          <Handle
            key={type}
            type={type}
            position={type === 'target' ? Position.Left : Position.Right}
            isConnectable={false}
            className="!min-h-0 !min-w-0 !transform-none !border-0 !bg-transparent"
            style={{ height: box.size, left: box.left, opacity: 0, top: box.top, width: box.size }}
          />
        )
      })}
    </>
  )
}

function PipelineCanvasNodeComponent({ data, selected }: NodeProps<CanvasFlowNode>) {
  const { t } = useTranslation()
  const actions = use(CanvasNodeActionsContext)
  const Icon = CATEGORY_ICONS[data.category] ?? CircleDashed
  const height = canvasNodeHeight(data)
  const portRows = canvasNodePortRows(data)
  const widgetRows = data.widgets.length + (data.hiddenWidgetCount > 0 ? 1 : 0)
  const hasIssue = data.missingRequired.length > 0

  return (
    <div
      className={cn(
        'relative rounded-lg border bg-card text-card-foreground shadow-md',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border'
      )}
      data-testid={`canvas-node-${data.stepId}`}
      style={{ height, width: CANVAS_NODE_WIDTH }}>
      <FallbackHandles view={data} />
      {data.inputs.map((port, index) => (
        <PortDot
          key={`in:${port.name}`}
          connectable={!data.collapsed}
          index={index}
          port={port}
          type="target"
          view={data}
        />
      ))}
      {data.outputs.map((port, index) => (
        <PortDot
          key={`out:${port.name}`}
          connectable={!data.collapsed}
          index={index}
          port={port}
          type="source"
          view={data}
        />
      ))}

      <div
        className={cn('flex items-center gap-1.5 overflow-hidden rounded-t-[7px]', data.collapsed && 'rounded-b-[7px]')}
        style={{
          backgroundColor: `color-mix(in srgb, ${data.accent} 20%, var(--card))`,
          boxShadow: `inset 0 2px 0 0 ${data.accent}`,
          height: CANVAS_NODE_HEADER_HEIGHT,
          paddingLeft: 8,
          paddingRight: 4
        }}>
        <Icon className="shrink-0" size={12} style={{ color: data.accent }} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-[11px] leading-[13px]">{data.title}</div>
          <div className="truncate text-[9px] text-muted-foreground leading-[11px]">
            {data.stepId}
            {data.nodeId ? ` · ${data.nodeId}` : ''}
          </div>
        </div>
        {hasIssue ? (
          <span
            className="shrink-0 text-warning"
            title={t('library.config.agent.coco.canvas.missing_required', { ports: data.missingRequired.join(', ') })}>
            <TriangleAlert size={12} />
          </span>
        ) : null}
        <button
          aria-label={t(data.collapsed ? 'common.expand' : 'common.collapse')}
          className="nodrag nopan grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background/60 hover:text-foreground"
          data-testid={`canvas-node-collapse-${data.stepId}`}
          type="button"
          onClick={(event: MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation()
            actions?.toggleCollapse(data.stepId)
          }}>
          {data.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>

      {data.collapsed ? null : (
        <div style={{ paddingBottom: CANVAS_NODE_BODY_PADDING, paddingTop: CANVAS_NODE_BODY_PADDING }}>
          {Array.from({ length: Math.max(portRows, 1) }, (_, index) => {
            const input = data.inputs[index]
            const output = data.outputs[index]
            return (
              <div
                key={index}
                className="flex items-center gap-2 text-[10px] leading-none"
                style={{ height: CANVAS_PORT_ROW_HEIGHT }}>
                <span
                  className="min-w-0 flex-1 truncate pl-3.5"
                  title={input ? `${input.name} · ${input.assetType}` : ''}>
                  {input?.name}
                  {input?.required ? <span className="text-warning"> *</span> : null}
                </span>
                <span
                  className="min-w-0 flex-1 truncate pr-3.5 text-right"
                  title={output ? `${output.name} · ${output.assetType}` : ''}>
                  {output?.name}
                </span>
              </div>
            )
          })}
          {widgetRows > 0 ? (
            <div
              className="border-border/70 border-t"
              style={{ marginTop: CANVAS_WIDGET_SECTION_PADDING, paddingTop: CANVAS_WIDGET_SECTION_PADDING }}>
              {data.widgets.map((widget) => (
                <div
                  key={`${widget.kind}:${widget.key}`}
                  className="flex items-center gap-1.5 px-2 text-[9px] leading-none"
                  style={{ height: CANVAS_WIDGET_ROW_HEIGHT }}>
                  <span className="max-w-24 shrink-0 truncate text-muted-foreground">{widget.key}</span>
                  <span
                    className="min-w-0 flex-1 truncate rounded bg-muted/60 px-1.5 py-0.5 text-right"
                    title={widget.value}>
                    {widget.value}
                  </span>
                </div>
              ))}
              {data.hiddenWidgetCount > 0 ? (
                <div
                  className="px-2 text-[9px] text-muted-foreground leading-none"
                  style={{ height: CANVAS_WIDGET_ROW_HEIGHT, lineHeight: `${CANVAS_WIDGET_ROW_HEIGHT}px` }}>
                  {t('library.config.agent.coco.canvas.more_params', { count: data.hiddenWidgetCount })}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

export const PipelineCanvasNode = memo(PipelineCanvasNodeComponent)
