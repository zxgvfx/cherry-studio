import '@google/model-viewer'

import {
  BorderOuterOutlined,
  CompressOutlined,
  DownloadOutlined,
  ExpandOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  Loading3QuartersOutlined,
  ReloadOutlined
} from '@ant-design/icons'
import { Tooltip } from 'antd'
import FileManager from '@renderer/services/FileManager'
import type { Model3DMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus } from '@renderer/types/newMessage'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled, { keyframes } from 'styled-components'

interface Props {
  block: Model3DMessageBlock
}

const Model3DBlock: React.FC<Props> = ({ block }) => {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showWireframe, setShowWireframe] = useState(false)
  const [showMaterial, setShowMaterial] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<any>(null)
  const originalMaterialsRef = useRef<Map<any, any>>(new Map())

  const isLoading = block.status === MessageBlockStatus.PROCESSING || block.status === MessageBlockStatus.PENDING

  const modelUrl = useMemo(() => {
    if (!block.file?.id) return ''
    const fileName = `${block.file.id}${block.file.ext}`
    return `${window.location.origin}/api/v1/files/serve?name=${encodeURIComponent(fileName)}`
  }, [block.file])

  const formatLabel =
    block.metadata?.format?.toUpperCase() || block.file?.ext?.replace('.', '').toUpperCase() || '3D'

  const handleDownload = useCallback(() => {
    if (!modelUrl) return
    const a = document.createElement('a')
    a.href = modelUrl
    a.download = block.file?.origin_name || block.file?.name || `model${block.file?.ext || '.glb'}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [modelUrl, block.file])

  const handleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev)
  }, [])

  const handleResetCamera = useCallback(() => {
    const viewer = viewerRef.current
    if (viewer) {
      try {
        viewer.cameraOrbit = 'auto auto auto'
        viewer.fieldOfView = 'auto'
        viewer.cameraTarget = 'auto auto auto'
      } catch {
        /* noop */
      }
    }
  }, [])

  const traverseMeshes = useCallback((callback: (mesh: any) => void) => {
    const viewer = viewerRef.current
    if (!viewer) return
    try {
      const model = (viewer as any).model
      if (!model) return
      model.traverse((node: any) => {
        if (node.isMesh) callback(node)
      })
    } catch {
      /* model-viewer internals may not be available */
    }
  }, [])

  const handleToggleWireframe = useCallback(() => {
    const next = !showWireframe
    setShowWireframe(next)
    traverseMeshes((mesh) => {
      if (mesh.material) {
        mesh.material.wireframe = next
        mesh.material.needsUpdate = true
      }
    })
  }, [showWireframe, traverseMeshes])

  const handleToggleMaterial = useCallback(() => {
    const next = !showMaterial
    setShowMaterial(next)
    traverseMeshes((mesh) => {
      if (!mesh.material) return
      if (next) {
        const orig = originalMaterialsRef.current.get(mesh)
        if (orig) {
          mesh.material.map = orig.map
          mesh.material.normalMap = orig.normalMap
          mesh.material.roughnessMap = orig.roughnessMap
          mesh.material.metalnessMap = orig.metalnessMap
          mesh.material.color?.copy(orig.color)
          mesh.material.needsUpdate = true
        }
      } else {
        if (!originalMaterialsRef.current.has(mesh)) {
          originalMaterialsRef.current.set(mesh, {
            map: mesh.material.map,
            normalMap: mesh.material.normalMap,
            roughnessMap: mesh.material.roughnessMap,
            metalnessMap: mesh.material.metalnessMap,
            color: mesh.material.color?.clone()
          })
        }
        mesh.material.map = null
        mesh.material.normalMap = null
        mesh.material.roughnessMap = null
        mesh.material.metalnessMap = null
        mesh.material.color?.set(0xcccccc)
        mesh.material.needsUpdate = true
      }
    })
  }, [showMaterial, traverseMeshes])

  useEffect(() => {
    return () => {
      originalMaterialsRef.current.clear()
    }
  }, [modelUrl])

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

  const toolbar = (
    <ToolbarOverlay>
      <Tooltip title={t('model3d.wireframe', 'Wireframe')}>
        <ToolButton onClick={handleToggleWireframe} $active={showWireframe}>
          <BorderOuterOutlined />
        </ToolButton>
      </Tooltip>
      <Tooltip title={t('model3d.toggle_material', 'Toggle material')}>
        <ToolButton onClick={handleToggleMaterial} $active={!showMaterial}>
          {showMaterial ? <EyeOutlined /> : <EyeInvisibleOutlined />}
        </ToolButton>
      </Tooltip>
      <Separator />
      <Tooltip title={t('model3d.reset_camera', 'Reset camera')}>
        <ToolButton onClick={handleResetCamera}>
          <ReloadOutlined />
        </ToolButton>
      </Tooltip>
      <Tooltip
        title={
          isFullscreen ? t('model3d.exit_fullscreen', 'Exit fullscreen') : t('model3d.fullscreen', 'Fullscreen')
        }>
        <ToolButton onClick={handleFullscreen}>
          {isFullscreen ? <CompressOutlined /> : <ExpandOutlined />}
        </ToolButton>
      </Tooltip>
      <Separator />
      <Tooltip title={t('model3d.download', 'Download model')}>
        <ToolButton onClick={handleDownload}>
          <DownloadOutlined />
        </ToolButton>
      </Tooltip>
    </ToolbarOverlay>
  )

  const hint = (
    <HintOverlay>{t('model3d.hint', 'Drag to rotate · Scroll to zoom · Right-click to pan')}</HintOverlay>
  )

  return (
    <Container ref={containerRef} $isFullscreen={isFullscreen}>
      <ViewerWrapper $isFullscreen={isFullscreen}>
        {React.createElement(
          'model-viewer',
          {
            ref: viewerRef,
            src: modelUrl,
            alt: FileManager.formatFileName(block.file),
            'camera-controls': true,
            'auto-rotate': true,
            'touch-action': 'pan-y',
            'shadow-intensity': '1',
            'environment-image': 'neutral',
            exposure: '1',
            loading: 'eager',
            style: { width: '100%', height: '100%' },
            onError: () => setError('Model loading failed')
          },
          toolbar,
          hint
        )}
      </ViewerWrapper>
      <InfoBar>
        <FormatBadge>{formatLabel}</FormatBadge>
        <FileName>{FileManager.formatFileName(block.file)}</FileName>
        {block.file?.size ? <FileSize>{formatFileSize(block.file.size)}</FileSize> : null}
        <DownloadLink onClick={handleDownload}>{t('model3d.download', 'Download model')}</DownloadLink>
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

const ViewerWrapper = styled.div<{ $isFullscreen?: boolean }>`
  width: 100%;
  height: ${(props) => (props.$isFullscreen ? 'calc(100vh - 48px)' : '350px')};
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  position: relative;
  overflow: hidden;
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

export default React.memo(Model3DBlock)
