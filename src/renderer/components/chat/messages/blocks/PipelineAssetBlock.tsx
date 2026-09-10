import { Button } from '@cherrystudio/ui'
import { CommandContextMenu, type CommandContextMenuExtraItem } from '@renderer/components/command'
import { toast } from '@renderer/services/toast'
import { RELEASE_INLINE_WEBGL_EVENT, releaseInlineWebGL } from '@renderer/utils/qtWebEngineStability'
import { pipelineAssetDisplayName, pipelineAssetFileName } from '@shared/ai/pipelinePreview'
import type { PipelineAssetPartData } from '@shared/data/types/uiParts'
import type { AbsoluteFilePath } from '@shared/types/file'
import { toFileUrl } from '@shared/utils/file'
import Box from 'lucide-react/dist/esm/icons/box'
import Download from 'lucide-react/dist/esm/icons/download'
import FileImage from 'lucide-react/dist/esm/icons/file-image'
import FileText from 'lucide-react/dist/esm/icons/file-text'
import FileVideo from 'lucide-react/dist/esm/icons/file-video'
import GripVertical from 'lucide-react/dist/esm/icons/grip-vertical'
import MessageSquarePlus from 'lucide-react/dist/esm/icons/message-square-plus'
import Trash2 from 'lucide-react/dist/esm/icons/trash-2'
import X from 'lucide-react/dist/esm/icons/x'
import ZoomIn from 'lucide-react/dist/esm/icons/zoom-in'
import ZoomOut from 'lucide-react/dist/esm/icons/zoom-out'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { useOptionalMessageListActions } from '../MessageListProvider'

// eslint-disable-next-line barrel/closed -- Lazy-load the GLB plugin without pulling the FilePreview barrel.
const GLBViewer = React.lazy(() => import('@renderer/components/FilePreview/plugins/model3d/GLBViewer'))

export { releaseInlineWebGL }

function isModelAsset(asset: PipelineAssetPartData): boolean {
  const hint = `${asset.assetType} ${asset.name}`.toLowerCase()
  return (
    /\.(glb|gltf|fbx|obj|stl|usd|usda|usdc)(\?|#|$)/i.test(asset.name) ||
    hint.includes('gltf') ||
    hint.includes('glb') ||
    hint.includes('fbx') ||
    hint.includes('geometry') ||
    hint.includes('model/')
  )
}

function isImageAsset(asset: PipelineAssetPartData): boolean {
  return (
    /\.(png|jpe?g|webp|gif|bmp|tif|tiff|exr|hdr)(\?|#|$)/i.test(asset.name) || asset.assetType.startsWith('media/image')
  )
}

function isVideoAsset(asset: PipelineAssetPartData): boolean {
  return /\.(mp4|mov|webm|mkv)(\?|#|$)/i.test(asset.name) || asset.assetType.startsWith('media/video')
}

function isPdfAsset(asset: PipelineAssetPartData): boolean {
  return /\.pdf(\?|#|$)/i.test(asset.name) || asset.assetType.includes('pdf')
}

function isTextAsset(asset: PipelineAssetPartData): boolean {
  return (
    /\.(txt|md|json|csv|log|xml)(\?|#|$)/i.test(asset.name) ||
    asset.assetType.startsWith('text/') ||
    asset.assetType === 'data/json' ||
    asset.assetType === 'data/text'
  )
}

function localFileUrl(localPath: string): string {
  return toFileUrl(localPath.replace(/\\/g, '/') as AbsoluteFilePath)
}

function cherryFileServeUrl(localPath: string): string | null {
  const origin = (window as Window & { __CHERRY_BACKEND_URL?: string }).__CHERRY_BACKEND_URL?.replace(/\/$/, '')
  if (!origin) return null
  return `${origin}/api/v1/files/serve?path=${encodeURIComponent(localPath)}`
}

function previewSrc(asset: PipelineAssetPartData): string {
  if (asset.localPath && isModelAsset(asset) && /\.(glb|gltf)(\?|#|$)/i.test(asset.name)) {
    return cherryFileServeUrl(asset.localPath) || localFileUrl(asset.localPath)
  }
  if (asset.localPath && (isImageAsset(asset) || isVideoAsset(asset) || isPdfAsset(asset) || isTextAsset(asset))) {
    return cherryFileServeUrl(asset.localPath) || localFileUrl(asset.localPath)
  }
  return asset.previewUrl || asset.downloadUrl
}

async function fetchPipelineAssetBytes(asset: PipelineAssetPartData): Promise<Uint8Array> {
  const response = await fetch(asset.downloadUrl)
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  return new Uint8Array(await response.arrayBuffer())
}

type PipelineAssetFileApi = typeof window.api.file & { startDrag?: (path: string) => void | Promise<unknown> }

function isQtAssetRuntime(): boolean {
  const runtimeWindow = window as Window & { isQtRuntime?: boolean; __IS_QT?: boolean }
  return Boolean(runtimeWindow.isQtRuntime || runtimeWindow.__IS_QT)
}

export function pipelineAssetDownloadUrl(asset: PipelineAssetPartData): string {
  const url = new URL(asset.downloadUrl, window.location.href)
  url.searchParams.set('download', '1')
  return url.toString()
}

function startBrowserAssetDownload(asset: PipelineAssetPartData): string {
  const link = document.createElement('a')
  link.href = pipelineAssetDownloadUrl(asset)
  link.download = pipelineAssetFileName(asset)
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  return link.href
}

export async function savePipelineAssetToDisk(asset: PipelineAssetPartData): Promise<string | null> {
  if (isQtAssetRuntime()) return startBrowserAssetDownload(asset)
  return window.api.file.save(pipelineAssetFileName(asset), await fetchPipelineAssetBytes(asset))
}

export function pipelineAssetThumbnailUrl(asset: PipelineAssetPartData): string {
  const file = asset.downloadUrl || ''
  const match = file.match(/^((?:https?:\/\/[^?#]+)?\/api\/assets\/[^/]+)\/file\/?$/i)
  if (match) return `${match[1]}/thumbnail`
  return previewSrc(asset)
}

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const IMAGE_MIN_ZOOM = 1
const IMAGE_MAX_ZOOM = 8
const IMAGE_ZOOM_STEP = 0.25

function clampImageZoom(value: number): number {
  return Math.min(IMAGE_MAX_ZOOM, Math.max(IMAGE_MIN_ZOOM, value))
}

function KindIcon({ asset }: { asset: PipelineAssetPartData }) {
  const className = 'size-4 shrink-0 text-muted-foreground'
  if (isImageAsset(asset)) return <FileImage className={className} />
  if (isVideoAsset(asset)) return <FileVideo className={className} />
  if (isTextAsset(asset) || isPdfAsset(asset)) return <FileText className={className} />
  if (isModelAsset(asset)) return <Box className={className} />
  return <FileText className={className} />
}

function ZoomableImagePreview({ asset, src }: { asset: PipelineAssetPartData; src: string }) {
  const { t } = useTranslation()
  const viewportRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number
    originX: number
    originY: number
    startX: number
    startY: number
  } | null>(null)
  const [zoom, setZoom] = useState(IMAGE_MIN_ZOOM)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const canPan = zoom > IMAGE_MIN_ZOOM

  const zoomBy = useCallback((delta: number) => {
    setZoom((current) => clampImageZoom(Number((current + delta).toFixed(2))))
  }, [])

  useEffect(() => {
    if (zoom <= IMAGE_MIN_ZOOM) setOffset({ x: 0, y: 0 })
  }, [zoom])

  useEffect(() => {
    const node = viewportRef.current
    if (!node) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      setZoom((current) => clampImageZoom(current * Math.exp(-event.deltaY * 0.002)))
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  const stopDragging = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    dragRef.current = null
  }, [])

  return (
    <div className="flex h-[min(78vh,760px)] min-h-[280px] w-full flex-col">
      <div className="flex items-center justify-center gap-1 border-white/10 border-b bg-black/30 px-2 py-1.5">
        <button
          type="button"
          data-testid="asset-image-zoom-out"
          aria-label={t('preview.zoom_out')}
          disabled={zoom <= IMAGE_MIN_ZOOM}
          className="rounded-md p-1 text-zinc-200 hover:bg-white/10 disabled:opacity-40"
          onClick={() => zoomBy(-IMAGE_ZOOM_STEP)}>
          <ZoomOut className="size-4" />
        </button>
        <span
          data-testid="asset-image-zoom-value"
          className="min-w-12 text-center text-[11px] text-zinc-300 tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          data-testid="asset-image-zoom-in"
          aria-label={t('preview.zoom_in')}
          disabled={zoom >= IMAGE_MAX_ZOOM}
          className="rounded-md p-1 text-zinc-200 hover:bg-white/10 disabled:opacity-40"
          onClick={() => zoomBy(IMAGE_ZOOM_STEP)}>
          <ZoomIn className="size-4" />
        </button>
      </div>
      <div ref={viewportRef} data-testid="asset-image-preview" className="relative min-h-0 flex-1 overflow-hidden">
        <img
          src={src}
          alt={asset.name}
          draggable={false}
          className="absolute inset-0 m-auto max-h-full max-w-full select-none object-contain"
          style={{
            cursor: canPan ? 'grab' : 'zoom-in',
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transformOrigin: 'center center'
          }}
          onDoubleClick={() => setZoom((current) => (current > IMAGE_MIN_ZOOM ? IMAGE_MIN_ZOOM : 2))}
          onPointerDown={(event) => {
            if (event.button !== 0 || !canPan) return
            dragRef.current = {
              pointerId: event.pointerId,
              originX: offset.x,
              originY: offset.y,
              startX: event.clientX,
              startY: event.clientY
            }
            event.currentTarget.setPointerCapture(event.pointerId)
            event.preventDefault()
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current
            if (!drag || drag.pointerId !== event.pointerId) return
            setOffset({
              x: drag.originX + event.clientX - drag.startX,
              y: drag.originY + event.clientY - drag.startY
            })
            event.currentTarget.style.cursor = 'grabbing'
          }}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
        />
      </div>
    </div>
  )
}

function AssetPreviewBody({ asset, src }: { asset: PipelineAssetPartData; src: string }) {
  if (isImageAsset(asset)) {
    return <ZoomableImagePreview asset={asset} src={src} />
  }
  if (isVideoAsset(asset)) {
    return (
      <video src={src} controls playsInline preload="none" className="max-h-[70vh] w-full bg-black object-contain" />
    )
  }
  if (isPdfAsset(asset)) {
    return <iframe title={asset.name} src={src} className="h-[70vh] w-full border-0 bg-background" />
  }
  if (isModelAsset(asset)) {
    return (
      <div className="relative h-[min(70vh,520px)] w-full overflow-hidden bg-gradient-to-br from-[#1a1a2e] via-[#16213e] to-[#0f3460]">
        <React.Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-muted-foreground text-xs">加载 3D 预览…</div>
          }>
          <GLBViewer src={src} />
        </React.Suspense>
      </div>
    )
  }
  if (isTextAsset(asset)) {
    return <iframe title={asset.name} src={src} className="h-[min(70vh,480px)] w-full border-0 bg-background" />
  }
  return <p className="px-4 py-8 text-center text-muted-foreground text-xs">此类型请下载后查看，或拖到 DCC。</p>
}

function AssetPreviewModal({
  asset,
  src,
  onClose
}: {
  asset: PipelineAssetPartData
  src: string
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const onRelease = () => onClose()
    window.addEventListener(RELEASE_INLINE_WEBGL_EVENT, onRelease)
    return () => {
      window.removeEventListener(RELEASE_INLINE_WEBGL_EVENT, onRelease)
      releaseInlineWebGL()
    }
  }, [onClose])

  const image = isImageAsset(asset)

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className={
          image
            ? 'flex max-h-[92vh] w-full max-w-[min(96vw,1100px)] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#111214] shadow-2xl'
            : 'flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[#111214] shadow-2xl'
        }
        onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 border-white/10 border-b px-3 py-2">
          <span className="min-w-0 truncate font-medium text-sm text-zinc-50" title={pipelineAssetDisplayName(asset)}>
            {pipelineAssetDisplayName(asset)}
          </span>
          <button
            type="button"
            className="rounded-md p-1 text-zinc-400 hover:bg-white/10 hover:text-zinc-50"
            onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>
        <div className={image ? 'min-h-0 flex-1 overflow-hidden bg-black/40' : 'min-h-40 overflow-auto bg-black/40'}>
          <AssetPreviewBody asset={asset} src={src} />
        </div>
      </div>
    </div>,
    document.body
  )
}

function GridThumb({ asset, thumbSrc, preview }: { asset: PipelineAssetPartData; thumbSrc: string; preview: string }) {
  const [thumbBroken, setThumbBroken] = useState(false)
  const [stillSrc, setStillSrc] = useState<string | null>(null)
  const visual = isImageAsset(asset) || isVideoAsset(asset) || isModelAsset(asset)

  useEffect(() => {
    if (!thumbBroken || stillSrc) return
    if (!isModelAsset(asset) || !/\.(glb|gltf)(\?|#|$)/i.test(asset.name)) return
    let cancelled = false
    // eslint-disable-next-line barrel/closed -- Lazy-load still capture without pulling the FilePreview barrel.
    void import('@renderer/components/FilePreview/plugins/model3d/captureModelStill')
      .then((mod) => mod.captureModelStill(preview))
      .then((url) => {
        if (!cancelled) setStillSrc(url)
      })
      .catch(() => {
        /* keep the type icon */
      })
    return () => {
      cancelled = true
    }
  }, [asset, preview, stillSrc, thumbBroken])

  const src = stillSrc || (!thumbBroken ? thumbSrc : '')
  if (visual && src) {
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        loading="lazy"
        className="h-full w-full object-cover"
        onError={() => {
          if (!stillSrc) setThumbBroken(true)
        }}
      />
    )
  }
  return (
    <span className="flex h-full w-full flex-col items-center justify-center text-muted-foreground">
      <KindIcon asset={asset} />
    </span>
  )
}

function PipelineAssetCard({
  asset,
  variant = 'list',
  onAddToComposer,
  onDelete
}: {
  asset: PipelineAssetPartData
  variant?: 'list' | 'grid'
  onAddToComposer?: (asset: PipelineAssetPartData) => void
  onDelete?: (asset: PipelineAssetPartData) => void
}) {
  const { t } = useTranslation()
  const src = useMemo(() => previewSrc(asset), [asset])
  const thumbSrc = useMemo(() => pipelineAssetThumbnailUrl(asset), [asset])
  const sizeLabel = formatSize(asset.sizeBytes)
  const displayName = useMemo(() => pipelineAssetDisplayName(asset), [asset])
  const fileName = useMemo(() => pipelineAssetFileName(asset), [asset])
  const openArtifactFile = useOptionalMessageListActions()?.openArtifactFile
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const dragFilePromiseRef = useRef<Promise<string> | null>(null)
  const dragFilePathRef = useRef<string | null>(asset.localPath || null)

  useEffect(() => {
    dragFilePathRef.current = asset.localPath || null
    dragFilePromiseRef.current = null
  }, [asset.assetId, asset.localPath])

  const materializeDragFile = useCallback(() => {
    if (dragFilePathRef.current) return Promise.resolve(dragFilePathRef.current)
    if (!dragFilePromiseRef.current) {
      dragFilePromiseRef.current = (async () => {
        const tempPath = await window.api.file.createTempFile(fileName)
        await window.api.file.write(tempPath, await fetchPipelineAssetBytes(asset))
        dragFilePathRef.current = tempPath
        return tempPath
      })().catch((error) => {
        dragFilePromiseRef.current = null
        throw error
      })
    }
    return dragFilePromiseRef.current
  }, [asset, fileName])

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      event.stopPropagation()
      const dragUrl = pipelineAssetDownloadUrl(asset)
      if (isQtAssetRuntime()) {
        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData('DownloadURL', `application/octet-stream:${fileName}:${dragUrl}`)
        event.dataTransfer.setData('text/uri-list', dragUrl)
        return
      }
      const fileApi = window.api.file as PipelineAssetFileApi
      if (typeof fileApi.startDrag !== 'function') {
        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData('DownloadURL', `application/octet-stream:${fileName}:${dragUrl}`)
        event.dataTransfer.setData('text/uri-list', dragUrl)
        return
      }
      const localPath = dragFilePathRef.current
      if (localPath) {
        event.preventDefault()
        fileApi.startDrag(localPath)
        return
      }
      // Electron 原生 startDrag 必须在 dragstart 事件内同步触发。远端大模型文件
      // 尚未落盘时先交给 Chromium DownloadURL，同时继续预取供下一次原生拖拽。
      event.dataTransfer.effectAllowed = 'copy'
      event.dataTransfer.setData('DownloadURL', `application/octet-stream:${fileName}:${dragUrl}`)
      event.dataTransfer.setData('text/uri-list', dragUrl)
      void materializeDragFile().catch((error) => {
        toast.error(t('agent.right_pane.assets.drag_failed', { error: String(error) }))
      })
    },
    [asset, fileName, materializeDragFile, t]
  )

  const handleImportToDcc = useCallback(async () => {
    const win = window as Window & {
      __CHERRY_BACKEND_URL?: string
      __CHERRY_SESSION_ID?: string
      __CHERRY_DCC_TYPE?: string
    }
    const origin = win.__CHERRY_BACKEND_URL?.replace(/\/$/, '') || ''
    const sessionId = win.__CHERRY_SESSION_ID || ''
    if (!origin || !sessionId) {
      toast.error('当前窗口没有绑定 DCC 会话')
      return
    }
    try {
      const localPath = await materializeDragFile()
      const response = await fetch(`${origin}/api/v1/dcc/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
        body: JSON.stringify({ sessionId, localPath })
      })
      const data = (await response.json()) as { error?: string; ok?: boolean }
      if (data?.error) {
        toast.error(String(data.error))
        return
      }
      const dcc = win.__CHERRY_DCC_TYPE || 'DCC'
      toast.success(`已导入到 ${dcc}`)
    } catch (error) {
      toast.error(`导入失败：${String(error)}`)
    }
  }, [materializeDragFile])

  const dccImportLabel = (() => {
    const dcc = (window as Window & { __CHERRY_DCC_TYPE?: string }).__CHERRY_DCC_TYPE || ''
    if (!dcc || dcc === 'standalone') return ''
    return dcc === 'houdini' ? 'Houdini' : dcc === 'maya' ? 'Maya' : dcc
  })()

  const handleDownload = useCallback(async () => {
    try {
      const savedPath = await savePipelineAssetToDisk(asset)
      if (savedPath) toast.success(t('message.download.success'))
    } catch (error) {
      toast.error(t('agent.right_pane.assets.download_failed', { error: String(error) }))
    }
  }, [asset, t])

  const handleOpenPreview = useCallback(() => {
    if (asset.localPath && openArtifactFile) {
      void openArtifactFile(asset.localPath)
      return
    }
    setOpen(true)
  }, [asset.localPath, openArtifactFile])

  const contextMenuItems = useMemo<CommandContextMenuExtraItem[]>(() => {
    const items: CommandContextMenuExtraItem[] = []
    if (onAddToComposer) {
      items.push({
        type: 'item',
        id: `asset-add-to-composer:${asset.assetId}`,
        label: t('agent.right_pane.assets.add_to_composer'),
        icon: <MessageSquarePlus size={14} />,
        onSelect: () => onAddToComposer(asset)
      })
    }
    items.push({
      type: 'item',
      id: `asset-download:${asset.assetId}`,
      label: t('common.download'),
      icon: <Download size={14} />,
      onSelect: () => void handleDownload()
    })
    if (dccImportLabel && isModelAsset(asset)) {
      items.push({
        type: 'item',
        id: `asset-import-dcc:${asset.assetId}`,
        label: `导入到 ${dccImportLabel}`,
        onSelect: () => void handleImportToDcc()
      })
    }
    if (onDelete) {
      items.push(
        { type: 'separator' },
        {
          type: 'item',
          id: `asset-delete:${asset.assetId}`,
          label: t('common.delete'),
          icon: <Trash2 size={14} />,
          destructive: true,
          onSelect: () => onDelete(asset)
        }
      )
    }
    return items
  }, [asset, dccImportLabel, handleDownload, handleImportToDcc, onAddToComposer, onDelete, t])

  const withContextMenu = (content: React.ReactElement) => (
    <CommandContextMenu location="webcontents.context" extraItems={contextMenuItems}>
      {content}
    </CommandContextMenu>
  )

  if (variant === 'grid') {
    return withContextMenu(
      <div
        data-testid="asset-grid-card"
        className="relative aspect-square overflow-hidden rounded-xl border border-border bg-muted/40"
        draggable
        onDragStart={handleDragStart}
        onMouseEnter={() => {
          setHover(true)
          if (!isQtAssetRuntime()) void materializeDragFile().catch(() => undefined)
        }}
        onMouseLeave={() => setHover(false)}>
        <button type="button" className="absolute inset-0 z-0" onClick={handleOpenPreview} aria-label={displayName}>
          <GridThumb asset={asset} thumbSrc={thumbSrc} preview={src} />
        </button>
        <div
          data-testid="asset-grid-overlay"
          data-visible={hover ? 'true' : 'false'}
          className={
            hover
              ? 'pointer-events-none absolute inset-0 z-10 flex flex-col justify-between bg-gradient-to-t from-black/85 via-black/25 to-black/35 opacity-100'
              : 'pointer-events-none absolute inset-0 z-10 flex flex-col justify-between bg-gradient-to-t from-black/85 via-black/25 to-black/35 opacity-0'
          }>
          <div />
          <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1.5 px-1.5">
            <button
              type="button"
              draggable
              onPointerDown={() => {
                if (!isQtAssetRuntime()) void materializeDragFile().catch(() => undefined)
              }}
              onDragStart={handleDragStart}
              className="inline-flex h-7 cursor-grab items-center gap-1 rounded-full border border-white/20 bg-black/70 px-2 text-[10px] text-white active:cursor-grabbing"
              title="拖到 Houdini / 桌面">
              <GripVertical className="size-3" />
              拖到 DCC
            </button>
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-full border border-white/20 bg-black/70 px-2 text-[10px] text-white"
              onClick={() => void handleDownload()}>
              下载
            </button>
            {dccImportLabel ? (
              <button
                type="button"
                className="inline-flex h-7 items-center rounded-full border border-white/20 bg-black/70 px-2 text-[10px] text-white"
                onClick={() => void handleImportToDcc()}>
                导入到 {dccImportLabel}
              </button>
            ) : null}
          </div>
          <div className="px-2 pt-4 pb-2">
            <div className="truncate font-medium text-[12px] text-white">{displayName}</div>
            <div className="truncate text-[10px] text-white/70">
              {asset.assetType}
              {sizeLabel ? ` · ${sizeLabel}` : ''}
            </div>
          </div>
        </div>
        {open ? <AssetPreviewModal asset={asset} src={src} onClose={() => setOpen(false)} /> : null}
      </div>
    )
  }

  return withContextMenu(
    <div
      className="relative overflow-visible rounded-lg border border-border bg-muted/40"
      draggable
      onDragStart={handleDragStart}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
        onClick={handleOpenPreview}
        onMouseEnter={() => {
          setHover(true)
          if (!isQtAssetRuntime()) void materializeDragFile().catch(() => undefined)
        }}
        onMouseLeave={() => setHover(false)}>
        <KindIcon asset={asset} />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground text-xs" title={displayName}>
          {displayName}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {asset.assetType}
          {sizeLabel ? ` · ${sizeLabel}` : ''}
        </span>
      </button>
      {hover && isImageAsset(asset) ? (
        <div className="pointer-events-none absolute bottom-[calc(100%+6px)] left-2 z-20 overflow-hidden rounded-md border border-white/15 bg-[#111214] shadow-xl">
          <img src={thumbSrc} alt="" className="max-h-40 max-w-56 object-contain" />
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 border-border border-t px-2 py-1.5">
        <button
          type="button"
          draggable
          onPointerDown={() => {
            if (!isQtAssetRuntime()) void materializeDragFile().catch(() => undefined)
          }}
          onDragStart={handleDragStart}
          className="inline-flex h-7 flex-1 cursor-grab items-center justify-center gap-1 rounded-md border border-border bg-background px-2 text-foreground text-xs active:cursor-grabbing"
          title="拖到 Houdini / 桌面">
          <GripVertical className="size-3.5 text-muted-foreground" />
          拖到 DCC
        </button>
        <Button size="sm" variant="secondary" className="h-7" onClick={handleOpenPreview}>
          预览
        </Button>
        <Button size="sm" variant="secondary" className="h-7" onClick={() => void handleDownload()}>
          <Download className="size-3.5" />
          下载
        </Button>
        {dccImportLabel ? (
          <Button size="sm" variant="secondary" className="h-7" onClick={() => void handleImportToDcc()}>
            导入到 {dccImportLabel}
          </Button>
        ) : null}
      </div>
      {open ? <AssetPreviewModal asset={asset} src={src} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}

export default function PipelineAssetBlock({
  assets,
  variant = 'list',
  onAddToComposer,
  onDelete
}: {
  assets: PipelineAssetPartData[]
  variant?: 'list' | 'grid'
  onAddToComposer?: (asset: PipelineAssetPartData) => void
  onDelete?: (asset: PipelineAssetPartData) => void
}) {
  if (assets.length === 0) return null
  if (variant === 'grid') {
    return (
      <>
        {assets.map((asset) => (
          <PipelineAssetCard
            key={asset.assetId}
            asset={asset}
            variant="grid"
            onAddToComposer={onAddToComposer}
            onDelete={onDelete}
          />
        ))}
      </>
    )
  }
  return (
    <div className="mt-2 grid gap-2">
      {assets.map((asset) => (
        <PipelineAssetCard
          key={asset.assetId}
          asset={asset}
          variant="list"
          onAddToComposer={onAddToComposer}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}
