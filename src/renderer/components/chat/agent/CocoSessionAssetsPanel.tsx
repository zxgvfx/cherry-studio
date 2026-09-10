import { Button, ConfirmDialog } from '@cherrystudio/ui'
import PipelineAssetBlock from '@renderer/components/chat/messages/blocks/PipelineAssetBlock'
import { toast } from '@renderer/services/toast'
import {
  ACTIVE_MESSAGE_VIEWPORT_EVENT,
  type ActiveMessageViewportDetail,
  getActiveMessageViewport
} from '@renderer/utils/activeMessageViewport'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import {
  insertCocoSessionAssetIntoComposer,
  removeCocoSessionAssetFromComposer
} from '@renderer/utils/cocoSessionAssetEvents'
import { DEFAULT_PIPELINE_API_BASE, resolvePipelineApiBase } from '@renderer/utils/pipelineNodes'
import { type CocoSessionAsset, filterCocoSessionAssets, mergeCocoSessionAssets } from '@shared/ai/cocoSessionAssets'
import type { CherryMessagePart, CherryUIMessage } from '@shared/data/types/message'
import type { PipelineAssetPartData } from '@shared/data/types/uiParts'
import { Package, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface CocoSessionAssetsPanelProps {
  active: boolean
  sessionId: string
  pipelineSessionId?: string
  initialAssets?: readonly CocoSessionAsset[]
  liveUpdating?: boolean
  messages: readonly CherryUIMessage[]
  partsByMessageId: Record<string, CherryMessagePart[]>
}

type AssetFilter = 'all' | 'upload' | 'generated' | 'model'
type AssetScope = 'turn' | 'session'

const CARD_MIN = 110
const CARD_MAX = 220
const CARD_DEFAULT = 148
const CARD_SIZE_KEY = 'coco.sessionAssets.cardPx'

function readCardSize(): number {
  try {
    const raw = window.localStorage.getItem(CARD_SIZE_KEY)
    const n = raw ? Number(raw) : CARD_DEFAULT
    if (!Number.isFinite(n)) return CARD_DEFAULT
    return Math.min(CARD_MAX, Math.max(CARD_MIN, Math.round(n)))
  } catch {
    return CARD_DEFAULT
  }
}

export function turnForMessage(
  messages: readonly CherryUIMessage[],
  activeMessageId: string | null
): {
  messageIds: Set<string>
  number: number
} {
  const fallbackIndex = messages.length - 1
  const activeIndex = activeMessageId ? messages.findIndex((message) => message.id === activeMessageId) : fallbackIndex
  const index = activeIndex >= 0 ? activeIndex : fallbackIndex
  if (index < 0) return { messageIds: new Set(), number: 0 }
  // A turn starts at the user message that opened it, so both sides of an
  // exchange resolve to the same numbered turn.
  let start = index
  while (start > 0 && messages[start].role !== 'user') start -= 1
  let end = start + 1
  while (end < messages.length && messages[end].role !== 'user') end += 1
  const messageIds = new Set(messages.slice(start, end).map((message) => message.id))
  const number = messages.slice(0, start + 1).filter((message) => message.role === 'user').length
  return { messageIds, number }
}

export function assetsForTurn(
  partsByMessageId: Record<string, CherryMessagePart[]>,
  messageIds: ReadonlySet<string>
): { assetIds: Set<string>; runIds: Set<string> } {
  const assetIds = new Set<string>()
  const runIds = new Set<string>()
  for (const messageId of messageIds) {
    for (const part of partsByMessageId[messageId] ?? []) {
      if (part.type === 'data-pipeline-asset') {
        const data = (part as { data?: { assetId?: string; runId?: string } }).data
        if (data?.assetId) assetIds.add(data.assetId)
        if (data?.runId) runIds.add(data.runId)
      } else if (part.type === 'data-pipeline-run-progress' || part.type === 'data-pipeline-review') {
        const data = (part as { data?: { runId?: string } }).data
        if (data?.runId) runIds.add(data.runId)
      }
    }
  }
  return { assetIds, runIds }
}

function assetPart(asset: CocoSessionAsset, apiBase: string): PipelineAssetPartData {
  const root = apiBase.replace(/\/+$/, '')
  const fileUrl = `${root}/api/assets/${encodeURIComponent(asset.assetId)}/file`
  const assetType =
    asset.assetType ||
    (asset.kind === 'model'
      ? 'model/gltf-binary'
      : asset.kind === 'image'
        ? 'media/image'
        : asset.kind === 'video'
          ? 'media/video'
          : 'file')
  return {
    assetId: asset.assetId,
    name: asset.name,
    assetType,
    downloadUrl: fileUrl,
    previewUrl: asset.previewUrl || fileUrl,
    ...(asset.sizeBytes != null ? { sizeBytes: asset.sizeBytes } : {}),
    ...(asset.runId ? { runId: asset.runId } : {}),
    ...(asset.sourceNodeId ? { sourceNodeId: asset.sourceNodeId } : {})
  }
}

export function CocoSessionAssetsPanel({
  active,
  sessionId,
  pipelineSessionId,
  initialAssets = [],
  liveUpdating = false,
  messages,
  partsByMessageId
}: CocoSessionAssetsPanelProps) {
  const { t } = useTranslation()
  const [remoteAssets, setRemoteAssets] = useState<CocoSessionAsset[]>([])
  const [apiBase, setApiBase] = useState(DEFAULT_PIPELINE_API_BASE)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<AssetFilter>('all')
  const [scope, setScope] = useState<AssetScope>('turn')
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cardSize, setCardSize] = useState(CARD_DEFAULT)
  const [cardSizeReady, setCardSizeReady] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<CocoSessionAsset | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deletedAssetIds, setDeletedAssetIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    setCardSize(readCardSize())
    setCardSizeReady(true)
  }, [])

  useEffect(() => {
    if (!cardSizeReady) return
    try {
      window.localStorage.setItem(CARD_SIZE_KEY, String(cardSize))
    } catch {
      /* ignore */
    }
  }, [cardSize, cardSizeReady])

  const refresh = useCallback(async () => {
    if (!pipelineSessionId) return
    setLoading(true)
    try {
      const base = (await resolvePipelineApiBase()) || DEFAULT_PIPELINE_API_BASE
      setApiBase(base)
      const response = await fetch(`${base}/api/agents/sessions/${encodeURIComponent(pipelineSessionId)}`)
      if (!response.ok) throw new Error(`session assets ${response.status}`)
      const payload: unknown = await response.json()
      const metadata =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as { context?: { metadata?: { session_assets?: unknown } } }).context?.metadata
          : undefined
      setRemoteAssets(mergeCocoSessionAssets(metadata?.session_assets))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [pipelineSessionId])

  useEffect(() => {
    if (!active) return
    void refresh()
    if (!liveUpdating) return
    const timer = window.setInterval(() => void refresh(), 1200)
    return () => window.clearInterval(timer)
  }, [active, liveUpdating, refresh])

  useEffect(() => {
    const topicId = buildAgentSessionTopicId(sessionId)
    setActiveMessageId(getActiveMessageViewport(topicId))
    const handleActiveMessage = (event: Event) => {
      const detail = (event as CustomEvent<ActiveMessageViewportDetail>).detail
      if (detail?.topicId === topicId) setActiveMessageId(detail.messageId)
    }
    window.addEventListener(ACTIVE_MESSAGE_VIEWPORT_EVENT, handleActiveMessage)
    return () => window.removeEventListener(ACTIVE_MESSAGE_VIEWPORT_EVENT, handleActiveMessage)
  }, [sessionId])

  const assets = useMemo(
    () =>
      mergeCocoSessionAssets(initialAssets, remoteAssets)
        .sort((left, right) => {
          const leftTime =
            typeof left.createdAt === 'number' ? left.createdAt : Date.parse(String(left.createdAt || ''))
          const rightTime =
            typeof right.createdAt === 'number' ? right.createdAt : Date.parse(String(right.createdAt || ''))
          return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0)
        })
        .filter((asset) => !deletedAssetIds.has(asset.assetId)),
    [deletedAssetIds, initialAssets, remoteAssets]
  )
  const activeTurn = useMemo(() => turnForMessage(messages, activeMessageId), [activeMessageId, messages])
  const activeTurnAssets = useMemo(
    () => assetsForTurn(partsByMessageId, activeTurn.messageIds),
    [activeTurn.messageIds, partsByMessageId]
  )
  const visibleAssets = useMemo(() => {
    const scoped =
      scope === 'session'
        ? assets
        : assets.filter(
            (asset) =>
              activeTurnAssets.assetIds.has(asset.assetId) ||
              (Boolean(asset.runId) && activeTurnAssets.runIds.has(asset.runId!))
          )
    const searched = filterCocoSessionAssets(scoped, query)
    if (filter === 'upload') return searched.filter((asset) => asset.origin === 'upload')
    if (filter === 'generated') return searched.filter((asset) => asset.origin === 'generated')
    if (filter === 'model') return searched.filter((asset) => asset.kind === 'model')
    return searched
  }, [activeTurnAssets.assetIds, activeTurnAssets.runIds, assets, filter, query, scope])

  const handleDelete = useCallback(async () => {
    if (!pendingDelete || !pipelineSessionId) return
    setDeleting(true)
    try {
      const response = await fetch(
        `${apiBase.replace(/\/+$/, '')}/api/agents/sessions/${encodeURIComponent(pipelineSessionId)}/assets/${encodeURIComponent(pendingDelete.assetId)}`,
        { method: 'DELETE' }
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setDeletedAssetIds((current) => new Set(current).add(pendingDelete.assetId))
      setRemoteAssets((current) => current.filter((asset) => asset.assetId !== pendingDelete.assetId))
      removeCocoSessionAssetFromComposer({ sessionId, asset: pendingDelete })
      toast.success(t('agent.right_pane.assets.deleted', { name: pendingDelete.name }))
      setPendingDelete(null)
    } catch (cause) {
      toast.error(
        t('agent.right_pane.assets.delete_failed', { error: cause instanceof Error ? cause.message : String(cause) })
      )
    } finally {
      setDeleting(false)
    }
  }, [apiBase, pendingDelete, pipelineSessionId, sessionId, t])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-border border-b p-3">
        <div className="flex items-center gap-2">
          <Package className="size-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm">{t('agent.right_pane.assets.title')}</div>
            <div className="text-[11px] text-muted-foreground">
              {t('agent.right_pane.assets.count', { count: assets.length })}
            </div>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={!pipelineSessionId || loading}
            aria-label={t('agent.right_pane.assets.refresh')}
            onClick={() => void refresh()}>
            <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />
          </Button>
        </div>
        <div className="mt-3 grid grid-cols-2 rounded-md bg-muted p-0.5">
          <button
            type="button"
            className={
              scope === 'turn'
                ? 'rounded bg-background px-2 py-1.5 text-xs shadow-sm'
                : 'rounded px-2 py-1.5 text-muted-foreground text-xs'
            }
            onClick={() => setScope('turn')}>
            {t('agent.right_pane.assets.scope.turn', { number: activeTurn.number || 1 })}
          </button>
          <button
            type="button"
            className={
              scope === 'session'
                ? 'rounded bg-background px-2 py-1.5 text-xs shadow-sm'
                : 'rounded px-2 py-1.5 text-muted-foreground text-xs'
            }
            onClick={() => setScope('session')}>
            {t('agent.right_pane.assets.scope.session')}
          </button>
        </div>
        <label className="mt-3 flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('agent.right_pane.assets.search')}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </label>
        <div className="mt-2 flex flex-wrap gap-1">
          {(['all', 'generated', 'upload', 'model'] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? 'secondary' : 'ghost'}
              className="h-7 px-2 text-[11px]"
              onClick={() => setFilter(value)}>
              {t(`agent.right_pane.assets.filters.${value}`)}
            </Button>
          ))}
        </div>
        <label className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          {t('agent.right_pane.assets.zoom')}
          <input
            type="range"
            min={CARD_MIN}
            max={CARD_MAX}
            step={4}
            value={cardSize}
            onChange={(event) => setCardSize(Number(event.target.value))}
            className="h-1.5 min-w-0 flex-1 cursor-pointer accent-primary"
            aria-label={t('agent.right_pane.assets.zoom')}
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error ? (
          <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-destructive text-xs">
            {t('agent.right_pane.assets.load_failed')}: {error}
          </div>
        ) : null}
        {visibleAssets.length === 0 && !loading ? (
          <div className="grid h-full min-h-40 place-items-center text-center text-muted-foreground text-xs">
            {t('agent.right_pane.assets.empty')}
          </div>
        ) : (
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))` }}>
            {visibleAssets.map((asset) => (
              <PipelineAssetBlock
                key={asset.assetId}
                assets={[assetPart(asset, apiBase)]}
                variant="grid"
                onAddToComposer={() => insertCocoSessionAssetIntoComposer({ sessionId, asset })}
                onDelete={() => setPendingDelete(asset)}
              />
            ))}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null)
        }}
        title={t('agent.right_pane.assets.delete_confirm_title')}
        description={t('agent.right_pane.assets.delete_confirm_description', { name: pendingDelete?.name ?? '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        destructive
        confirmLoading={deleting}
        onConfirm={handleDelete}
      />
    </div>
  )
}
