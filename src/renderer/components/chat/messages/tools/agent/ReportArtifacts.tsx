import { Button } from '@cherrystudio/ui'
import { Icon } from '@iconify/react'
import { CommandContextMenu, type CommandContextMenuExtraItem, CommandPopupMenu } from '@renderer/components/command'
import { getEditorIcon } from '@renderer/components/icons/EditorIcon'
import { FinderIcon } from '@renderer/components/icons/SvgIcon'
import type { McpToolResponse, NormalToolResponse } from '@renderer/types/mcpTool'
import { getFileIconName } from '@renderer/utils/fileIconName'
import { normalizeInlineFilePath, resolveInlineFilePath } from '@renderer/utils/filePath'
import { isMac, isWin } from '@renderer/utils/platform'
import { RELEASE_INLINE_WEBGL_EVENT } from '@renderer/utils/qtWebEngineStability'
import { REPORT_ARTIFACTS_TOOL_NAME, reportArtifactsInputSchema } from '@shared/ai/builtinTools'
import type { ExternalAppInfo } from '@shared/types/externalApp'
import type { AbsoluteFilePath } from '@shared/types/file'
import { toFileUrl } from '@shared/utils/file'
import type { TFunction } from 'i18next'
import { ChevronDown, FolderOpen, GripVertical } from 'lucide-react'
import { type DragEvent, lazy, type MouseEvent, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useOptionalMessageListActions, useOptionalMessageListUi } from '../../MessageListProvider'

// eslint-disable-next-line barrel/closed -- Lazy-load the GLB plugin without pulling the FilePreview barrel.
const GLBViewer = lazy(() => import('@renderer/components/FilePreview/plugins/model3d/GLBViewer'))

export type ReportArtifactsToolResponse = McpToolResponse | NormalToolResponse

interface ReportArtifactView {
  path: string
  description?: string
}

interface ReportArtifactsViewModel {
  artifacts: ReportArtifactView[]
  summary?: string
}

export function isReportArtifactsToolResponse(toolResponse: ReportArtifactsToolResponse): boolean {
  const toolName = toolResponse.tool.name
  return toolName === REPORT_ARTIFACTS_TOOL_NAME || toolName.endsWith(`__${REPORT_ARTIFACTS_TOOL_NAME}`)
}

export function getReportArtifactsViewModel(
  toolResponses: readonly ReportArtifactsToolResponse[]
): ReportArtifactsViewModel | null {
  const artifactByPath = new Map<string, ReportArtifactView>()
  let summary: string | undefined

  for (const toolResponse of toolResponses) {
    if (!isReportArtifactsToolResponse(toolResponse)) continue

    const parsed = reportArtifactsInputSchema.safeParse(toolResponse.arguments)
    if (!parsed.success) continue

    if (parsed.data.summary) summary = parsed.data.summary
    for (const artifact of parsed.data.artifacts) {
      const path = artifact.path.trim()
      if (!path) continue
      artifactByPath.set(path, {
        path,
        description: artifact.description
      })
    }
  }

  const artifacts = disambiguateArtifactNames(Array.from(artifactByPath.values()))
  return artifacts.length > 0 ? { artifacts, summary } : null
}

function getArtifactFileName(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/g, '')
  const segments = normalized.split(/[\\/]+/).filter(Boolean)
  return segments.at(-1) ?? path
}

const GENERIC_MODEL_ARTIFACT = /^(model|asset|result|output)\.(glb|gltf)$/i
const TRIPO_STAGE_LABELS = ['几何模型.glb', '贴图模型.glb', '分割模型.glb']

function getArtifactDisplayName(artifact: ReportArtifactView, displayPath: string): string {
  const logicalName = artifact.description?.trim()
  if (logicalName && /\.[a-z0-9]{1,10}$/i.test(logicalName)) return logicalName
  return getArtifactFileName(displayPath)
}

function disambiguateArtifactNames(artifacts: ReportArtifactView[]): ReportArtifactView[] {
  const labeled = artifacts.map((artifact) => ({
    artifact,
    name: getArtifactDisplayName(artifact, artifact.path)
  }))
  const generic = labeled.every((item) => GENERIC_MODEL_ARTIFACT.test(item.name))
  if (generic && labeled.length > 1 && labeled.length <= TRIPO_STAGE_LABELS.length) {
    return labeled.map((item, index) => ({
      ...item.artifact,
      description: TRIPO_STAGE_LABELS[index] || `模型${index + 1}.glb`
    }))
  }
  const counts = new Map<string, number>()
  for (const item of labeled) counts.set(item.name, (counts.get(item.name) || 0) + 1)
  const seen = new Map<string, number>()
  return labeled.map((item) => {
    const total = counts.get(item.name) || 1
    if (total <= 1) return item.artifact
    const index = (seen.get(item.name) || 0) + 1
    seen.set(item.name, index)
    const extMatch = item.name.match(/\.[a-z0-9]+$/i)
    const ext = extMatch ? extMatch[0] : ''
    const stem = ext ? item.name.slice(0, -ext.length) : item.name
    return { ...item.artifact, description: `${stem}-${index}${ext}` }
  })
}

function getFileManagerName(t: TFunction): string {
  if (isMac) return t('agent.session.file_manager.finder')
  if (isWin) return t('agent.session.file_manager.file_explorer')
  return t('agent.session.file_manager.files')
}

function isImageArtifact(fileName: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp|tif|tiff)$/i.test(fileName)
}

function isModelArtifact(fileName: string): boolean {
  return /\.(glb|gltf)$/i.test(fileName)
}

function isVideoArtifact(fileName: string): boolean {
  return /\.(mp4|webm|mov|mkv)$/i.test(fileName)
}

function artifactFileHref(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')) {
    return toFileUrl(normalized as AbsoluteFilePath)
  }
  return path
}

function artifactPreviewSrc(path: string): string {
  const origin = (window as Window & { __CHERRY_BACKEND_URL?: string }).__CHERRY_BACKEND_URL?.replace(/\/$/, '')
  if (origin) return `${origin}/api/v1/files/serve?path=${encodeURIComponent(path)}`
  return artifactFileHref(path)
}

function ReportArtifactFileCard({ artifact }: { artifact: ReportArtifactView }) {
  const { t } = useTranslation()
  const ui = useOptionalMessageListUi()
  const actions = useOptionalMessageListActions()
  const openArtifactFile = actions?.openArtifactFile
  const openPath = actions?.openPath
  const showInFolder = actions?.showInFolder
  const openInExternalApp = actions?.openInExternalApp
  const copyText = actions?.copyText
  const notifyError = actions?.notifyError
  const availableEditors = useMemo(() => ui?.externalCodeEditors ?? [], [ui?.externalCodeEditors])
  const hasOpenActions = Boolean(
    openArtifactFile || openPath || showInFolder || (openInExternalApp && availableEditors.length > 0)
  )
  const displayPath = useMemo(() => normalizeInlineFilePath(artifact.path), [artifact.path])
  const targetPath = useMemo(() => resolveInlineFilePath(artifact.path), [artifact.path])
  const fileName = useMemo(() => getArtifactDisplayName(artifact, displayPath), [artifact, displayPath])
  const iconName = useMemo(() => getFileIconName(fileName), [fileName])
  const fileManagerName = useMemo(() => getFileManagerName(t), [t])
  const fileHref = useMemo(() => artifactFileHref(targetPath), [targetPath])
  const previewSrc = useMemo(() => artifactPreviewSrc(targetPath), [targetPath])
  const [hover, setHover] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [webglReady, setWebglReady] = useState(false)

  const handlePreview = useCallback(() => {
    setPreviewOpen((open) => {
      if (open) setWebglReady(false)
      return !open
    })
  }, [])

  useEffect(() => {
    const onRelease = () => {
      setWebglReady(false)
      if (isModelArtifact(fileName) || isVideoArtifact(fileName)) {
        setPreviewOpen(false)
      }
    }
    window.addEventListener(RELEASE_INLINE_WEBGL_EVENT, onRelease)
    return () => window.removeEventListener(RELEASE_INLINE_WEBGL_EVENT, onRelease)
  }, [fileName])

  const handleOpenInPane = useCallback(() => {
    if (!openArtifactFile) return
    Promise.resolve(openArtifactFile(targetPath)).catch(() => {
      notifyError?.(t('chat.input.tools.open_file_error', { path: targetPath }))
    })
  }, [notifyError, openArtifactFile, t, targetPath])

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.effectAllowed = 'copy'
      event.dataTransfer.setData('DownloadURL', `application/octet-stream:${fileName}:${fileHref}`)
      event.dataTransfer.setData('text/uri-list', fileHref)
      event.dataTransfer.setData('text/plain', targetPath)
    },
    [fileHref, fileName, targetPath]
  )

  const handleOpenExternal = useCallback(() => {
    if (!openPath) return
    Promise.resolve(openPath(targetPath)).catch(() => {
      notifyError?.(t('chat.input.tools.open_file_error', { path: targetPath }))
    })
  }, [notifyError, openPath, t, targetPath])

  const handleReveal = useCallback(() => {
    if (!showInFolder) return
    Promise.resolve(showInFolder(targetPath)).catch(() => {
      notifyError?.(t('chat.input.tools.file_not_found', { path: targetPath }))
    })
  }, [notifyError, showInFolder, t, targetPath])

  const handleCopyPath = useCallback(() => {
    if (!copyText) return
    Promise.resolve(copyText(displayPath, { successMessage: t('common.copied') })).catch(() => {
      notifyError?.(t('message.copy.failed'))
    })
  }, [copyText, displayPath, notifyError, t])

  const handleOpenInEditor = useCallback(
    (app: ExternalAppInfo) => {
      if (!openInExternalApp) return
      Promise.resolve(openInExternalApp(app, targetPath)).catch(() => {
        notifyError?.(t('chat.input.tools.open_file_error', { path: targetPath }))
      })
    },
    [notifyError, openInExternalApp, t, targetPath]
  )

  const contextMenuItems = useMemo<readonly CommandContextMenuExtraItem[]>(() => {
    const items: CommandContextMenuExtraItem[] = []
    items.push({
      type: 'item',
      id: 'artifact.preview',
      label: t('common.preview'),
      onSelect: handlePreview
    })
    if (openArtifactFile) {
      items.push({
        type: 'item',
        id: 'artifact.open-pane',
        label: t('agent.session.artifact.open_in_pane'),
        onSelect: handleOpenInPane
      })
    }
    if (openPath) {
      items.push({
        type: 'item',
        id: 'artifact.open',
        label: t('chat.input.tools.open_file'),
        onSelect: handleOpenExternal
      })
    }
    if (showInFolder) {
      items.push({
        type: 'item',
        id: 'artifact.reveal',
        label: fileManagerName,
        icon: <span aria-hidden="true">{isMac ? <FinderIcon className="size-4" /> : <FolderOpen size={16} />}</span>,
        onSelect: handleReveal
      })
    }
    if (openInExternalApp) {
      for (const app of availableEditors) {
        items.push({
          type: 'item',
          id: `artifact.open-editor.${app.id}`,
          label: app.name,
          icon: getEditorIcon(app),
          onSelect: () => handleOpenInEditor(app)
        })
      }
    }
    if (copyText) {
      if (items.length > 0) items.push({ type: 'separator' })
      items.push({
        type: 'item',
        id: 'artifact.copy-path',
        label: t('common.copy'),
        onSelect: handleCopyPath
      })
    }
    return items
  }, [
    availableEditors,
    copyText,
    fileManagerName,
    handleCopyPath,
    handleOpenExternal,
    handleOpenInEditor,
    handleOpenInPane,
    handlePreview,
    handleReveal,
    openArtifactFile,
    openInExternalApp,
    openPath,
    showInFolder,
    t
  ])

  const card = (
    <div className="group/artifact relative w-full max-w-xl overflow-visible rounded-lg border-[0.5px] border-border bg-background-subtle">
      <div className="flex items-center">
        <button
          type="button"
          onClick={handlePreview}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          title={displayPath}
          aria-label={`${t('common.preview')} ${fileName}`}
          aria-expanded={previewOpen}
          className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 border-0 bg-transparent px-2.5 py-2 text-left hover:bg-accent">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background">
            <Icon icon={`material-icon-theme:${iconName}`} className="text-[20px]" />
          </span>
          <span className="min-w-0 truncate font-medium text-[13px] text-foreground leading-5">{fileName}</span>
        </button>
        {hover && !previewOpen && isImageArtifact(fileName) ? (
          <div className="pointer-events-none absolute bottom-[calc(100%+6px)] left-2 z-20 overflow-hidden rounded-md border border-border bg-background shadow-xl">
            <img src={previewSrc} alt="" className="max-h-40 max-w-56 object-contain" />
          </div>
        ) : null}
        <button
          type="button"
          draggable
          onDragStart={handleDragStart}
          className="mr-1 inline-flex h-8 shrink-0 cursor-grab items-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-foreground active:cursor-grabbing"
          title={t('agent.session.artifact.drag_hint')}>
          <GripVertical className="size-3.5 text-muted-foreground" />
          {t('agent.session.artifact.drag_to_dcc')}
        </button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mr-1 h-8"
          data-testid="artifact-preview-toggle"
          aria-expanded={previewOpen}
          onClick={(event: MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation()
            handlePreview()
          }}>
          {previewOpen ? t('common.collapse') : t('common.preview')}
        </Button>
        {hasOpenActions && (
          <CommandPopupMenu
            location="webcontents.context"
            extraItems={contextMenuItems}
            align="end"
            side="bottom"
            sideOffset={6}
            contentClassName="min-w-44">
            <Button
              type="button"
              variant="outline"
              aria-label={`${t('chat.input.tools.open_with')} ${fileName}`}
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                event.stopPropagation()
              }}
              className="mr-2 rounded-lg data-[state=open]:bg-accent">
              {t('chat.input.tools.open_with')}
              <ChevronDown className="text-muted-foreground" size={14} />
            </Button>
          </CommandPopupMenu>
        )}
      </div>
      {previewOpen ? (
        <div
          data-testid="artifact-inline-preview"
          className="border-border border-t bg-[#111214]"
          draggable={false}
          onDragStart={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDown={(event) => event.stopPropagation()}>
          {isImageArtifact(fileName) ? (
            <img src={previewSrc} alt={fileName} className="max-h-80 w-full object-contain" />
          ) : isVideoArtifact(fileName) ? (
            <video src={previewSrc} controls playsInline preload="none" className="max-h-80 w-full bg-black" />
          ) : isModelArtifact(fileName) ? (
            <div className="relative h-[min(52vh,420px)] w-full">
              {webglReady ? (
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                      {t('common.loading')}
                    </div>
                  }>
                  <GLBViewer src={previewSrc} />
                </Suspense>
              ) : (
                <button
                  type="button"
                  className="flex h-full w-full items-center justify-center text-sm text-muted-foreground hover:bg-white/5 hover:text-foreground"
                  onClick={() => setWebglReady(true)}>
                  {t('agent.session.artifact.load_3d_preview')}
                </button>
              )}
            </div>
          ) : (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              {t('agent.session.artifact.preview_unsupported')}
            </p>
          )}
        </div>
      ) : null}
    </div>
  )

  if (contextMenuItems.length === 0) {
    return card
  }

  return (
    <CommandContextMenu location="webcontents.context" extraItems={contextMenuItems}>
      {card}
    </CommandContextMenu>
  )
}

/**
 * Message-level footer for `report_artifacts` declarations. The tool call itself is hidden from the
 * inline tool stream; this card is appended after the complete message content so deliverables stay
 * visually anchored to the final answer instead of the tool-call position.
 */
export const MessageReportArtifacts = ({
  toolResponses
}: {
  toolResponses: readonly ReportArtifactsToolResponse[]
}) => {
  // Memoised: `getReportArtifactsViewModel` zod-parses each response, and this
  // card re-renders on every streaming tick. `toolResponses` is already a stable
  // memoised ref from `MessagePartsRenderer`, so this skips re-parsing per tick.
  const viewModel = useMemo(() => getReportArtifactsViewModel(toolResponses), [toolResponses])
  if (!viewModel) return null

  return (
    <div className="my-1 flex w-full flex-col gap-1.5">
      {viewModel.artifacts.map((artifact) => (
        <ReportArtifactFileCard key={artifact.path} artifact={artifact} />
      ))}
    </div>
  )
}
