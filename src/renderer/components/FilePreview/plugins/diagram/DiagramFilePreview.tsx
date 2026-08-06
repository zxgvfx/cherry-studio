import { EmptyState } from '@cherrystudio/ui'
import { loggerService } from '@logger'
import GraphvizPreview from '@renderer/components/Preview/GraphvizPreview'
import MermaidPreview from '@renderer/components/Preview/MermaidPreview'
import PlantUmlPreview from '@renderer/components/Preview/PlantUmlPreview'
import type { BasicPreviewProps } from '@renderer/components/Preview/types'
import FileWarning from 'lucide-react/dist/esm/icons/file-warning'
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle'
import Workflow from 'lucide-react/dist/esm/icons/workflow'
import { type ComponentType, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { FilePreviewLayout } from '../../FilePreviewLayout'
import type { FilePreviewPluginProps } from '../../types'

const logger = loggerService.withContext('DiagramFilePreview')
const DIAGRAM_PREVIEW_MAX_SIZE_MIB = 2
const DIAGRAM_PREVIEW_MAX_SIZE_BYTES = DIAGRAM_PREVIEW_MAX_SIZE_MIB * 1024 * 1024

type DiagramKind = 'graphviz' | 'mermaid' | 'plantuml'

type DiagramLoadState =
  | { status: 'empty' }
  | { status: 'error'; error: Error }
  | { status: 'loading' }
  | { status: 'ready'; content: string }
  | { status: 'too_large' }

const RENDERERS: Record<DiagramKind, ComponentType<BasicPreviewProps>> = {
  mermaid: MermaidPreview,
  graphviz: GraphvizPreview,
  plantuml: PlantUmlPreview
}

const EXTENSION_TO_KIND: Record<string, DiagramKind> = {
  mmd: 'mermaid',
  mermaid: 'mermaid',
  dot: 'graphviz',
  gv: 'graphviz',
  puml: 'plantuml',
  plantuml: 'plantuml',
  iuml: 'plantuml'
}

function getDiagramKind(fileName: string): DiagramKind {
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  return EXTENSION_TO_KIND[ext] ?? 'mermaid'
}

export default function DiagramFilePreview({ filePath, fileName, metadata, refreshKey }: FilePreviewPluginProps) {
  const { t } = useTranslation()
  const [loadState, setLoadState] = useState<DiagramLoadState>({ status: 'loading' })
  const kind = useMemo(() => getDiagramKind(fileName), [fileName])
  const Renderer = RENDERERS[kind]

  useEffect(() => {
    let cancelled = false
    setLoadState({ status: 'loading' })

    void (async () => {
      try {
        if (metadata.size === 0) {
          setLoadState({ status: 'empty' })
          return
        }

        if (metadata.size > DIAGRAM_PREVIEW_MAX_SIZE_BYTES) {
          setLoadState({ status: 'too_large' })
          return
        }

        const content = await window.api.fs.readText(filePath)
        if (!cancelled) setLoadState({ status: 'ready', content })
      } catch (error) {
        if (cancelled) return
        const normalized = error instanceof Error ? error : new Error(String(error))
        logger.error(`Failed to read diagram preview: ${filePath}`, normalized)
        setLoadState({ status: 'error', error: normalized })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [filePath, metadata.size, refreshKey])

  if (loadState.status === 'loading') {
    return (
      <FilePreviewLayout.Frame>
        <div role="status" className="flex h-full items-center justify-center gap-2 text-muted-foreground text-sm">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          <span>{t('file_preview.loading')}</span>
        </div>
      </FilePreviewLayout.Frame>
    )
  }

  if (loadState.status === 'empty') {
    return (
      <FilePreviewLayout.Frame>
        <div role="status" className="h-full">
          <EmptyState
            icon={Workflow}
            title={t('file_preview.text.empty.title')}
            description={t('file_preview.text.empty.description')}
            className="h-full"
          />
        </div>
      </FilePreviewLayout.Frame>
    )
  }

  if (loadState.status === 'too_large') {
    return (
      <FilePreviewLayout.Frame>
        <div role="alert" className="h-full">
          <EmptyState
            icon={FileWarning}
            title={t('file_preview.text.too_large.title')}
            description={t('file_preview.text.too_large.description', { limit: DIAGRAM_PREVIEW_MAX_SIZE_MIB })}
            className="h-full"
          />
        </div>
      </FilePreviewLayout.Frame>
    )
  }

  if (loadState.status === 'error') {
    return (
      <FilePreviewLayout.Frame>
        <div role="alert" className="h-full">
          <EmptyState
            icon={FileWarning}
            title={t('file_preview.text.read_error.title')}
            description={t('file_preview.load_error.description')}
            className="h-full"
          />
        </div>
      </FilePreviewLayout.Frame>
    )
  }

  return (
    <FilePreviewLayout.Frame>
      <FilePreviewLayout.Content>
        <div className="min-h-full w-full p-4">
          <Renderer enableToolbar>{loadState.content}</Renderer>
        </div>
      </FilePreviewLayout.Content>
    </FilePreviewLayout.Frame>
  )
}
