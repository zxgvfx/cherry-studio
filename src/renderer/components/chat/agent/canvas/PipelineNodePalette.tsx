import type { PipelineNodeCatalogItem } from '@renderer/utils/pipelineNodes'
import { groupPipelineNodesByCategory } from '@renderer/utils/pipelineNodes'
import { cn } from '@renderer/utils/style'
import { ChevronDown, ChevronRight, Plus, Search } from 'lucide-react'
import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { canvasCategoryColor } from './canvasTheme'

export const CANVAS_NODE_DRAG_MIME = 'application/x-pipeline-node'

interface PipelineNodePaletteProps {
  catalog: readonly PipelineNodeCatalogItem[]
  disabled: boolean
  onAdd: (node: PipelineNodeCatalogItem) => void
  variant?: 'sidebar' | 'menu'
}

function matchesQuery(node: PipelineNodeCatalogItem, query: string): boolean {
  if (!query) return true
  return (
    node.node_id.toLowerCase().includes(query) ||
    node.name.toLowerCase().includes(query) ||
    node.description.toLowerCase().includes(query) ||
    node.tags.some((tag) => tag.toLowerCase().includes(query))
  )
}

export function PipelineNodePalette({ catalog, disabled, onAdd, variant = 'sidebar' }: PipelineNodePaletteProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  const isMenu = variant === 'menu'

  useEffect(() => {
    if (!isMenu) return
    searchRef.current?.focus()
  }, [isMenu])

  const normalizedQuery = query.trim().toLowerCase()
  const groups = useMemo(
    () => groupPipelineNodesByCategory(catalog.filter((node) => matchesQuery(node, normalizedQuery))),
    [catalog, normalizedQuery]
  )
  const total = useMemo(() => groups.reduce((sum, group) => sum + group.nodes.length, 0), [groups])

  const startDrag = (event: DragEvent<HTMLButtonElement>, node: PipelineNodeCatalogItem) => {
    if (disabled) return
    event.dataTransfer.setData(CANVAS_NODE_DRAG_MIME, node.node_id)
    event.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div
      className={cn(
        'flex min-h-0 flex-col bg-card/40',
        isMenu
          ? 'max-h-80 w-64 overflow-hidden rounded-lg border border-border bg-background shadow-xl'
          : 'h-full w-56 shrink-0 border-border border-r'
      )}>
      {isMenu ? (
        <div className="shrink-0 border-border border-b px-2.5 py-1.5 font-medium text-[11px]">
          {t('library.config.agent.coco.canvas.add_node')}
        </div>
      ) : null}
      <div className="relative shrink-0 border-border border-b p-2">
        <Search
          className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-4 text-muted-foreground"
          size={12}
        />
        <input
          ref={searchRef}
          className="h-7 w-full rounded-md border border-border bg-background pr-2 pl-7 text-xs outline-none focus-visible:border-primary"
          data-testid="canvas-palette-search"
          placeholder={t('library.config.agent.coco.canvas.add_placeholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {total === 0 ? (
          <p className="px-3 py-4 text-[11px] text-muted-foreground">
            {t('library.config.agent.coco.canvas.no_match')}
          </p>
        ) : (
          groups.map((group) => {
            // A search already narrows the list, so keep every result visible.
            const isCollapsed = !normalizedQuery && collapsed.has(group.category)
            const accent = canvasCategoryColor(group.category)
            return (
              <div key={group.category} className="mb-0.5">
                <button
                  aria-expanded={!isCollapsed}
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-background/60"
                  type="button"
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current)
                      if (next.has(group.category)) next.delete(group.category)
                      else next.add(group.category)
                      return next
                    })
                  }>
                  {isCollapsed ? (
                    <ChevronRight className="shrink-0 text-muted-foreground" size={11} />
                  ) : (
                    <ChevronDown className="shrink-0 text-muted-foreground" size={11} />
                  )}
                  <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
                  <span className="min-w-0 flex-1 truncate font-medium text-[11px]">
                    {t(`chat.input.pipeline_nodes.category.${group.category}`)}
                  </span>
                  <span className="shrink-0 text-[9px] text-muted-foreground">{group.nodes.length}</span>
                </button>
                {isCollapsed
                  ? null
                  : group.nodes.map((node) => (
                      <button
                        key={node.node_id}
                        className={cn(
                          'group flex w-full items-start gap-1.5 py-1 pr-2 pl-6 text-left',
                          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-grab hover:bg-background/70'
                        )}
                        data-testid={`canvas-palette-item-${node.node_id}`}
                        disabled={disabled}
                        draggable={!disabled}
                        title={`${node.node_id}\n${node.description}`}
                        type="button"
                        onClick={() => onAdd(node)}
                        onDragStart={(event) => startDrag(event, node)}>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px]">{node.name || node.node_id}</span>
                          <span className="block truncate text-[9px] text-muted-foreground">{node.node_id}</span>
                        </span>
                        <Plus
                          className="mt-0.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100"
                          size={11}
                        />
                      </button>
                    ))}
              </div>
            )
          })
        )}
      </div>
      <div className="shrink-0 border-border border-t px-2 py-1 text-[9px] text-muted-foreground">
        {t('chat.input.pipeline_nodes.category_count', { count: total })}
      </div>
    </div>
  )
}
