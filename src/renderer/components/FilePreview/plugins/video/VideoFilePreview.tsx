import { EmptyState } from '@cherrystudio/ui'
import { loggerService } from '@logger'
import { toFileUrl } from '@shared/utils/file'
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle'
import VideoOff from 'lucide-react/dist/esm/icons/video-off'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { FilePreviewLayout } from '../../FilePreviewLayout'
import type { FilePreviewPluginProps } from '../../types'

const logger = loggerService.withContext('VideoFilePreview')

export default function VideoFilePreview({ filePath, fileName, refreshKey }: FilePreviewPluginProps) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'error' | 'loading' | 'ready'>('loading')
  // `refreshKey` forces React to remount the <video> element (rather than just
  // changing `src`) so a re-generated file at the same path actually reloads —
  // browsers otherwise keep serving the old decoded frames from cache.
  const src = useMemo(() => toFileUrl(filePath), [filePath])

  if (status === 'error') {
    return (
      <FilePreviewLayout.Frame>
        <FilePreviewLayout.Content>
          <div role="alert" className="h-full">
            <EmptyState
              icon={VideoOff}
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
        <div className="relative flex h-full min-h-full min-w-full items-center justify-center bg-black/90 p-4">
          {status === 'loading' && (
            <div
              role="status"
              className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/80">
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              <span>{t('file_preview.loading')}</span>
            </div>
          )}
          {/* biome-ignore lint/a11y/mediaHasCaption: local file preview, no track source available */}
          <video
            key={`${filePath}:${refreshKey}`}
            src={src}
            title={fileName}
            controls
            autoPlay={false}
            className={`max-h-full max-w-full ${status === 'loading' ? 'opacity-0' : 'opacity-100'}`}
            onLoadedData={() => setStatus('ready')}
            onError={() => {
              const error = new Error(`Failed to load video preview: ${filePath}`)
              logger.error(`Failed to load video preview: ${filePath}`, error)
              setStatus('error')
            }}
          />
        </div>
      </FilePreviewLayout.Content>
    </FilePreviewLayout.Frame>
  )
}
