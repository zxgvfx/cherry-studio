import { Button } from '@cherrystudio/ui'
import { cn } from '@renderer/utils/style'
import {
  Focus,
  Grid3x3,
  History,
  LayoutGrid,
  type LucideIcon,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Redo2,
  Save,
  Undo2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface ToolbarButtonProps {
  active?: boolean
  disabled?: boolean
  icon: LucideIcon
  label: string
  testId: string
  onClick: () => void
}

function ToolbarButton({ active, disabled, icon: Icon, label, onClick, testId }: ToolbarButtonProps) {
  return (
    <Button
      aria-label={label}
      aria-pressed={active}
      className={cn('size-7 p-0', active && 'bg-accent text-accent-foreground')}
      data-testid={testId}
      disabled={disabled}
      size="sm"
      title={label}
      variant="ghost"
      onClick={onClick}>
      <Icon size={13} />
    </Button>
  )
}

const SEPARATOR = <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />

export interface PipelineCanvasToolbarProps {
  canRedo: boolean
  canRun: boolean
  canUndo: boolean
  dirty: boolean
  inspectorOpen: boolean
  onAutoLayout: () => void
  onFitView: () => void
  onRedo: () => void
  onRun: () => void
  onSave: () => void
  onToggleHistory: () => void
  onToggleInspector: () => void
  onTogglePalette: () => void
  onToggleSnap: () => void
  onUndo: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  paletteOpen: boolean
  historyOpen: boolean
  readOnly: boolean
  running: boolean
  saving: boolean
  snapToGrid: boolean
}

export function PipelineCanvasToolbar({
  canRedo,
  canRun,
  canUndo,
  dirty,
  inspectorOpen,
  onAutoLayout,
  onFitView,
  onRedo,
  onRun,
  onSave,
  onToggleHistory,
  onToggleInspector,
  onTogglePalette,
  onToggleSnap,
  onUndo,
  onZoomIn,
  onZoomOut,
  paletteOpen,
  historyOpen,
  readOnly,
  running,
  saving,
  snapToGrid
}: PipelineCanvasToolbarProps) {
  const { t } = useTranslation()
  const key = (suffix: string) => t(`library.config.agent.coco.canvas.${suffix}`)

  return (
    <div className="nodrag nopan absolute top-2 left-2 z-10 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-0.5 rounded-md border border-border bg-background/95 p-1 shadow-sm">
      <ToolbarButton
        active={paletteOpen}
        icon={paletteOpen ? PanelLeftClose : PanelLeftOpen}
        label={key('toggle_palette')}
        testId="canvas-toggle-palette"
        onClick={onTogglePalette}
      />
      {SEPARATOR}
      <Button
        className="h-7 gap-1 px-2 text-[11px]"
        data-testid="canvas-save"
        disabled={readOnly || saving || running || !dirty}
        size="sm"
        title={key('save')}
        variant="outline"
        onClick={onSave}>
        <Save size={12} />
        {saving ? key('saving') : key('save')}
      </Button>
      <Button
        className="h-7 gap-1 px-2 text-[11px]"
        data-testid="canvas-run"
        disabled={readOnly || saving || running || !canRun}
        size="sm"
        title={key('run')}
        onClick={onRun}>
        <Play size={12} />
        {running ? key('running') : key('run')}
      </Button>
      {SEPARATOR}
      <ToolbarButton icon={Minus} label={key('zoom_out')} testId="canvas-zoom-out" onClick={onZoomOut} />
      <ToolbarButton icon={Plus} label={key('zoom_in')} testId="canvas-zoom-in" onClick={onZoomIn} />
      <ToolbarButton icon={Focus} label={key('fit_view')} testId="canvas-fit-view" onClick={onFitView} />
      {SEPARATOR}
      <ToolbarButton
        disabled={readOnly}
        icon={LayoutGrid}
        label={key('auto_layout')}
        testId="canvas-auto-layout"
        onClick={onAutoLayout}
      />
      <ToolbarButton
        active={snapToGrid}
        disabled={readOnly}
        icon={Grid3x3}
        label={key('snap_to_grid')}
        testId="canvas-snap-to-grid"
        onClick={onToggleSnap}
      />
      {SEPARATOR}
      <ToolbarButton
        disabled={readOnly || !canUndo}
        icon={Undo2}
        label={key('undo')}
        testId="canvas-undo"
        onClick={onUndo}
      />
      <ToolbarButton
        disabled={readOnly || !canRedo}
        icon={Redo2}
        label={key('redo')}
        testId="canvas-redo"
        onClick={onRedo}
      />
      <ToolbarButton
        active={historyOpen}
        icon={History}
        label={key('history')}
        testId="canvas-history"
        onClick={onToggleHistory}
      />
      {SEPARATOR}
      <ToolbarButton
        active={inspectorOpen}
        icon={inspectorOpen ? PanelRightClose : PanelRightOpen}
        label={key('toggle_inspector')}
        testId="canvas-toggle-inspector"
        onClick={onToggleInspector}
      />
    </div>
  )
}
