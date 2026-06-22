import {
  CheckCircleOutlined,
  CompressOutlined,
  DownloadOutlined,
  ExpandOutlined,
  ImportOutlined,
  Loading3QuartersOutlined
} from '@ant-design/icons'
import FileManager from '@renderer/services/FileManager'
import type { Model3DMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus } from '@renderer/types/newMessage'
import { message, Tooltip } from 'antd'
import React, { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled, { keyframes } from 'styled-components'

const GLBViewer = lazy(() => import('./GLBViewer'))
const FBXAnimationViewer = lazy(() => import('./FBXAnimationViewer'))

interface Props {
  block: Model3DMessageBlock
}

type DccToolPayload = {
  error?: string
  ok?: boolean
  newTopNodes?: string[]
  [key: string]: unknown
}

function unwrapDccToolResponse(raw: any): DccToolPayload {
  if (!raw || typeof raw !== 'object') {
    return { error: 'Invalid DCC response' }
  }

  if (typeof raw.error === 'string' && raw.error) {
    return { error: raw.error }
  }

  if (raw.isError) {
    const text = raw.content?.find?.((item: any) => item?.type === 'text')?.text
    return { error: text || 'DCC tool call failed' }
  }

  const text = raw.content?.find?.((item: any) => item?.type === 'text')?.text
  if (typeof text === 'string' && text.trim()) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        return parsed as DccToolPayload
      }
    } catch {
      return { error: text }
    }
  }

  return raw as DccToolPayload
}

const getDCCSessionId = (): string => (window as any).__CHERRY_SESSION_ID || ''
const getBackendUrl = (): string => (window as any).__CHERRY_BACKEND_URL || window.location.origin
const getDCCType = (): string => (window as any).__CHERRY_DCC_TYPE || 'standalone'

const Model3DBlock: React.FC<Props> = ({ block }) => {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [importState, setImportState] = useState<'idle' | 'importing' | 'done'>('idle')
  const containerRef = useRef<HTMLDivElement>(null)

  const dccSessionId = getDCCSessionId()
  const dccType = getDCCType()
  const isDCCEnvironment = !!dccSessionId && dccType !== 'standalone'

  const isLoading =
    block.status === MessageBlockStatus.PROCESSING ||
    block.status === MessageBlockStatus.PENDING ||
    block.status === MessageBlockStatus.STREAMING

  const modelUrl = useMemo(() => {
    if (!block.file?.id) return ''
    const fileName = `${block.file.id}${block.file.ext}`
    return `${window.location.origin}/api/v1/files/serve?name=${encodeURIComponent(fileName)}`
  }, [block.file])

  const formatLabel = block.metadata?.format?.toUpperCase() || block.file?.ext?.replace('.', '').toUpperCase() || '3D'

  const handleDownload = useCallback(() => {
    if (!modelUrl) return
    const a = document.createElement('a')
    a.href = modelUrl
    a.download = block.file?.origin_name || block.file?.name || `model${block.file?.ext || '.glb'}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [modelUrl, block.file])

  const handleImportToDCC = useCallback(async () => {
    if (!block.file?.path || !dccSessionId) return
    setImportState('importing')
    try {
      const backendUrl = getBackendUrl()
      const resp = await fetch(`${backendUrl}/api/v1/mcp/call-dcc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': dccSessionId
        },
        body: JSON.stringify({
          sessionId: dccSessionId,
          toolName: 'import_scene_file',
          arguments: {
            filePath: block.file.path,
            format: block.metadata?.format || block.file.ext?.replace('.', '') || 'unknown'
          }
        })
      })
      const rawResult = await resp.json()
      const result = unwrapDccToolResponse(rawResult)
      if (!resp.ok || result.error || result.ok === false) {
        message.error(result.error || t('model3d.import_failed', 'Import failed'))
        setImportState('idle')
      } else {
        setImportState('done')
        const importedCount = Array.isArray(result.newTopNodes) ? result.newTopNodes.length : 0
        message.success(
          importedCount > 0
            ? `${t('model3d.import_success', 'Imported to DCC')} (${importedCount})`
            : t('model3d.import_success', 'Imported to DCC')
        )
        setTimeout(() => setImportState('idle'), 3000)
      }
    } catch (e: any) {
      message.error(e.message || t('model3d.import_failed', 'Import failed'))
      setImportState('idle')
    }
  }, [block.file, block.metadata?.format, dccSessionId, t])

  const handleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev)
  }, [])

  const isFBX = block.metadata?.format === 'fbx' || block.file?.ext === '.fbx'

  const fbxUrls = useMemo(() => {
    if (!isFBX || !modelUrl) return []
    const urls = [modelUrl]
    const extraFiles = block.metadata?.extraFiles
    if (extraFiles && Array.isArray(extraFiles)) {
      for (const ef of extraFiles) {
        if (ef?.id && ef?.ext) {
          const name = `${ef.id}${ef.ext}`
          urls.push(`${window.location.origin}/api/v1/files/serve?name=${encodeURIComponent(name)}`)
        }
      }
    }
    return urls.filter(Boolean)
  }, [isFBX, modelUrl, block.metadata?.extraFiles])

  const progressText = block.metadata?.progressText

  if (isLoading) {
    return (
      <Container>
        <LoadingWrapper>
          <SpinIcon />
          <LoadingText>{t('model3d.generating', '3D model generating...')}</LoadingText>
          {progressText && <ProgressText>{progressText}</ProgressText>}
        </LoadingWrapper>
      </Container>
    )
  }

  if (error) {
    if (isDCCEnvironment) {
      const dccLabel = dccType === 'houdini' ? 'Houdini' : dccType === 'maya' ? 'Maya' : dccType
      return (
        <Container ref={containerRef} $isFullscreen={false}>
          <DCCPreviewPanel>
            <DCCIcon>📦</DCCIcon>
            <DCCTitle>
              {formatLabel} {t('model3d.ready', 'model ready')}
            </DCCTitle>
            <DCCDesc>{block.file?.origin_name || block.file?.name || `model${block.file?.ext || '.glb'}`}</DCCDesc>
            <DCCActions>
              <DCCButton onClick={handleImportToDCC} $primary disabled={importState === 'importing'}>
                {importState === 'done' ? (
                  <>
                    <CheckCircleOutlined /> {t('model3d.import_success', 'Imported')}
                  </>
                ) : importState === 'importing' ? (
                  <>
                    <Loading3QuartersOutlined spin /> {t('model3d.importing', 'Importing...')}
                  </>
                ) : (
                  <>
                    <ImportOutlined /> {t('model3d.import_to_dcc', 'Import to {{dcc}}', { dcc: dccLabel })}
                  </>
                )}
              </DCCButton>
              <DCCButton onClick={handleDownload}>
                <DownloadOutlined /> {t('model3d.download', 'Download')}
              </DCCButton>
            </DCCActions>
            <DCCHint>3D preview unavailable inside {dccLabel}</DCCHint>
          </DCCPreviewPanel>
          <InfoBar>
            <FormatBadge>{formatLabel}</FormatBadge>
            <FileName>{block.file?.origin_name || block.file?.name || ''}</FileName>
            {block.file?.size ? <FileSize>{formatFileSize(block.file.size)}</FileSize> : null}
          </InfoBar>
        </Container>
      )
    }
    return (
      <ErrorContainer>
        <span>
          {t('model3d.load_error', 'Failed to load 3D model')}: {error}
        </span>
      </ErrorContainer>
    )
  }

  if (!modelUrl) {
    return (
      <ErrorContainer>
        <span>{t('model3d.no_file', 'No 3D model file available')}</span>
      </ErrorContainer>
    )
  }

  if (isFBX) {
    const fileCount = fbxUrls.length
    return (
      <Container ref={containerRef} $isFullscreen={isFullscreen}>
        <Suspense
          fallback={
            <LoadingWrapper>
              <SpinIcon />
              <LoadingText>{t('motion.loading', 'Loading animation...')}</LoadingText>
            </LoadingWrapper>
          }>
          <FBXAnimationViewer
            urls={fbxUrls}
            width={isFullscreen ? window.innerWidth : undefined}
            height={isFullscreen ? window.innerHeight - 48 : undefined}
          />
        </Suspense>
        <InfoBar>
          <FormatBadge>{formatLabel}</FormatBadge>
          <FileName>
            {block.metadata?.prompt
              ? block.metadata.prompt.slice(0, 40) + (block.metadata.prompt.length > 40 ? '...' : '')
              : FileManager.formatFileName(block.file)}
          </FileName>
          {fileCount > 1 && <SeedBadge>{fileCount} variants</SeedBadge>}
          {block.metadata?.seed != null && <SeedBadge>seed: {block.metadata.seed}</SeedBadge>}
          <FbxToolbar>
            {isDCCEnvironment && (
              <Tooltip title={t('model3d.import_to_dcc', 'Import to DCC')}>
                <ToolButton onClick={handleImportToDCC} disabled={importState === 'importing'}>
                  {importState === 'done' ? <CheckCircleOutlined /> : <ImportOutlined />}
                </ToolButton>
              </Tooltip>
            )}
            <Tooltip
              title={
                isFullscreen ? t('model3d.exit_fullscreen', 'Exit fullscreen') : t('model3d.fullscreen', 'Fullscreen')
              }>
              <ToolButton onClick={handleFullscreen}>
                {isFullscreen ? <CompressOutlined /> : <ExpandOutlined />}
              </ToolButton>
            </Tooltip>
            <Tooltip title={t('model3d.download', 'Download model')}>
              <ToolButton onClick={handleDownload}>
                <DownloadOutlined />
              </ToolButton>
            </Tooltip>
          </FbxToolbar>
        </InfoBar>
      </Container>
    )
  }

  const glbToolbar = (
    <ToolbarOverlay>
      <Tooltip
        title={isFullscreen ? t('model3d.exit_fullscreen', 'Exit fullscreen') : t('model3d.fullscreen', 'Fullscreen')}>
        <ToolButton onClick={handleFullscreen}>{isFullscreen ? <CompressOutlined /> : <ExpandOutlined />}</ToolButton>
      </Tooltip>
      <Separator />
      <Tooltip title={t('model3d.download', 'Download model')}>
        <ToolButton onClick={handleDownload}>
          <DownloadOutlined />
        </ToolButton>
      </Tooltip>
      {isDCCEnvironment && (
        <>
          <Separator />
          <Tooltip title={t('model3d.import_to_dcc', 'Import to DCC')}>
            <ToolButton
              onClick={handleImportToDCC}
              $active={importState === 'done'}
              disabled={importState === 'importing'}>
              {importState === 'done' ? <CheckCircleOutlined /> : <ImportOutlined />}
            </ToolButton>
          </Tooltip>
        </>
      )}
    </ToolbarOverlay>
  )

  return (
    <Container ref={containerRef} $isFullscreen={isFullscreen}>
      <Suspense
        fallback={
          <LoadingWrapper>
            <SpinIcon />
            <LoadingText>{t('model3d.generating', '3D model generating...')}</LoadingText>
          </LoadingWrapper>
        }>
        <GLBViewer
          src={modelUrl}
          width={isFullscreen ? window.innerWidth : undefined}
          height={isFullscreen ? window.innerHeight - 48 : undefined}
          onError={(msg) => setError(msg)}>
          {glbToolbar}
          <HintOverlay>{t('model3d.hint', 'Drag to rotate · Scroll to zoom · Right-click to pan')}</HintOverlay>
        </GLBViewer>
      </Suspense>
      <InfoBar>
        <FormatBadge>{formatLabel}</FormatBadge>
        <FileName>{FileManager.formatFileName(block.file)}</FileName>
        {block.file?.size ? <FileSize>{formatFileSize(block.file.size)}</FileSize> : null}
        <DownloadLink onClick={handleDownload}>{t('model3d.download', 'Download model')}</DownloadLink>
        {isDCCEnvironment && (
          <ImportLink onClick={handleImportToDCC} $disabled={importState === 'importing'}>
            {importState === 'done'
              ? t('model3d.import_success', 'Imported to DCC')
              : importState === 'importing'
                ? t('model3d.importing', 'Importing...')
                : t('model3d.import_to_dcc', 'Import to DCC')}
          </ImportLink>
        )}
      </InfoBar>
    </Container>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`

const Container = styled.div<{ $isFullscreen?: boolean }>`
  border-radius: 8px;
  overflow: hidden;
  border: 0.5px solid var(--color-border);
  background: var(--color-background-soft);
  max-width: ${(props) => (props.$isFullscreen ? '100%' : '500px')};
  ${(props) =>
    props.$isFullscreen &&
    `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    max-width: 100%;
    z-index: 9999;
    border-radius: 0;
    border: none;
  `}
`

const ToolbarOverlay = styled.div`
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0.6;
  transition: opacity 0.2s ease;

  &:hover {
    opacity: 1;
  }
`

const ToolButton = styled.button<{ $active?: boolean }>`
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: none;
  background: ${(props) => (props.$active ? 'rgba(64, 150, 255, 0.7)' : 'rgba(0, 0, 0, 0.5)')};
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  backdrop-filter: blur(8px);
  transition: background 0.2s ease;

  &:hover {
    background: ${(props) => (props.$active ? 'rgba(64, 150, 255, 0.9)' : 'rgba(0, 0, 0, 0.7)')};
  }
`

const Separator = styled.div`
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.2);
  margin: 0 2px;
`

const HintOverlay = styled.div`
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  background: rgba(0, 0, 0, 0.3);
  padding: 2px 10px;
  border-radius: 10px;
  pointer-events: none;
  white-space: nowrap;
`

const InfoBar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
`

const FormatBadge = styled.span`
  background: var(--color-primary);
  color: white;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
`

const FileName = styled.span`
  font-size: 12px;
  color: var(--color-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
`

const FileSize = styled.span`
  font-size: 11px;
  color: var(--color-text-3);
  white-space: nowrap;
`

const DownloadLink = styled.span`
  font-size: 11px;
  color: var(--color-primary);
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    text-decoration: underline;
  }
`

const ErrorContainer = styled.div`
  padding: 16px;
  border-radius: 8px;
  background: var(--color-error-bg, rgba(255, 0, 0, 0.1));
  color: var(--color-error, #ff4444);
  font-size: 13px;
`

const LoadingWrapper = styled.div`
  height: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  border-radius: 8px;
`

const SpinIcon = styled(Loading3QuartersOutlined)`
  font-size: 32px;
  color: var(--color-primary);
  animation: ${spin} 1s linear infinite;
`

const LoadingText = styled.span`
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
`

const ProgressText = styled.span`
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  margin-top: -4px;
`

const SeedBadge = styled.span`
  background: var(--color-background-mute);
  color: var(--color-text-3);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-family: monospace;
  white-space: nowrap;
`

const ImportLink = styled.span<{ $disabled?: boolean }>`
  font-size: 11px;
  color: ${(props) => (props.$disabled ? 'var(--color-text-3)' : 'var(--color-primary)')};
  cursor: ${(props) => (props.$disabled ? 'not-allowed' : 'pointer')};
  white-space: nowrap;
  opacity: ${(props) => (props.$disabled ? 0.6 : 1)};

  &:hover {
    text-decoration: ${(props) => (props.$disabled ? 'none' : 'underline')};
  }
`

const FbxToolbar = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
`

const DCCPreviewPanel = styled.div`
  height: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  border-radius: 8px 8px 0 0;
  padding: 24px;
`

const DCCIcon = styled.span`
  font-size: 36px;
  line-height: 1;
`

const DCCTitle = styled.span`
  font-size: 14px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
`

const DCCDesc = styled.span`
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const DCCActions = styled.div`
  display: flex;
  gap: 8px;
  margin-top: 4px;
`

const DCCButton = styled.button<{ $primary?: boolean }>`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid
    ${(props) => (props.$primary ? 'rgba(64, 150, 255, 0.8)' : 'rgba(255,255,255,0.2)')};
  background: ${(props) => (props.$primary ? 'rgba(64, 150, 255, 0.25)' : 'rgba(255, 255, 255, 0.06)')};
  color: ${(props) => (props.$primary ? 'rgba(100, 180, 255, 1)' : 'rgba(255,255,255,0.7)')};
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover:not(:disabled) {
    background: ${(props) => (props.$primary ? 'rgba(64, 150, 255, 0.45)' : 'rgba(255, 255, 255, 0.14)')};
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`

const DCCHint = styled.span`
  font-size: 10px;
  color: rgba(255, 255, 255, 0.22);
  text-align: center;
  margin-top: 2px;
`

export default React.memo(Model3DBlock)
