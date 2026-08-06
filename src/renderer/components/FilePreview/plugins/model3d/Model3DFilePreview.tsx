import { EmptyState } from '@cherrystudio/ui'
import { loggerService } from '@logger'
import { toFileUrl } from '@shared/utils/file'
import Box from 'lucide-react/dist/esm/icons/box'
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { FilePreviewLayout } from '../../FilePreviewLayout'
import type { FilePreviewPluginProps } from '../../types'
import FBXAnimationViewer from './FBXAnimationViewer'
import GLBViewer from './GLBViewer'

const logger = loggerService.withContext('Model3DFilePreview')

function isFbxFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.fbx')
}

export default function Model3DFilePreview({ filePath, fileName, refreshKey }: FilePreviewPluginProps) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'error' | 'loading' | 'ready'>('loading')

  // Raw file:// URL — resolved by the Model3DFilePreview's environment (in Electron
  // it loads directly; in the Houdini WebEngineView build it is transparently
  // redirected to the backend's /api/v1/files/serve, see
  // core/window_manager.py's _FileUrlRedirectInterceptor on the Python side).
  const url = useMemo(() => toFileUrl(filePath), [filePath])
  // Stable array identity: FBXAnimationViewer's effect depends on `urls` by
  // reference, so a fresh `[url]` literal on every render would tear down and
  // recreate the whole three.js scene even though the URL itself is unchanged.
  const urls = useMemo(() => [url], [url])
  const fbx = useMemo(() => isFbxFile(fileName), [fileName])
  // New key per (filePath, refreshKey) forces GLBViewer/FBXAnimationViewer to fully
  // remount instead of trying to diff a live three.js scene across file switches.
  const viewerKey = `${filePath}:${refreshKey}`

  const handleLoad = () => setStatus('ready')
  const handleError = (message: string) => {
    logger.error(`Failed to load 3D preview: ${filePath} (${message})`)
    setStatus('error')
  }

  if (status === 'error') {
    return (
      <FilePreviewLayout.Frame>
        <FilePreviewLayout.Content>
          <div role="alert" className="h-full">
            <EmptyState
              icon={Box}
              title={t('file_preview.load_error.title')}
              description={t('file_preview.load_error.description')}
              className="h-full"
            />
          </div>
        </FilePreviewLayout.Content>
      </FilePreviewLayout.Frame>
    )
  }

  return (
    <FilePreviewLayout.Frame>
      <FilePreviewLayout.Content>
        <div className="relative h-full min-h-full w-full">
          {status === 'loading' && (
            <div
              role="status"
              className="absolute inset-0 z-10 flex items-center justify-center gap-2 text-muted-foreground text-sm">
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              <span>{t('file_preview.loading')}</span>
            </div>
          )}
          {fbx ? (
            <FBXAnimationViewer key={viewerKey} urls={urls} onLoad={handleLoad} onError={handleError} />
          ) : (
            <GLBViewer key={viewerKey} src={url} onLoad={handleLoad} onError={handleError} />
          )}
        </div>
      </FilePreviewLayout.Content>
    </FilePreviewLayout.Frame>
  )
}
