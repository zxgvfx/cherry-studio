import { CheckOutlined, CloseOutlined, Loading3QuartersOutlined, ReloadOutlined } from '@ant-design/icons'
import { Button, Spin } from 'antd'
import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface MaskInfo {
  id: string
  name: string
  path: string
  ext: string
}

interface SAM3ConfirmCardProps {
  sessionId: string
  imagePath: string
  onConfirm: (masks: MaskInfo[]) => void
  onCancel: () => void
  onRetry: () => void
}

type SessionStatus = 'launched' | 'masks_received' | 'closed' | 'error'

function getBackendBaseUrl(): string {
  return window.location.origin
}

const SAM3ConfirmCard: React.FC<SAM3ConfirmCardProps> = ({ sessionId, imagePath: _imagePath, onConfirm, onCancel, onRetry }) => {
  const { t } = useTranslation()
  const [status, setStatus] = useState<SessionStatus>('launched')
  const [masks, setMasks] = useState<MaskInfo[]>([])
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pollSession = useCallback(async () => {
    try {
      const baseUrl = getBackendBaseUrl()
      const resp = await fetch(`${baseUrl}/api/v1/plugins/sam3-segmentation/session-status?session_id=${sessionId}`)
      if (!resp.ok) return

      const data = await resp.json()
      setStatus(data.status)

      if (data.masks && data.masks.length > 0) {
        setMasks(data.masks)
      }

      if (data.preview_id) {
        setPreviewUrl(`${baseUrl}/api/v1/files/serve?name=${data.preview_id}.png`)
      }

      if (data.status === 'error') {
        setError(data.error || 'Unknown error')
      }
    } catch (e) {
      console.error('[SAM3ConfirmCard] Poll error:', e)
    }
  }, [sessionId])

  useEffect(() => {
    if (status === 'masks_received' || status === 'error') return

    const interval = setInterval(pollSession, 2000)
    return () => clearInterval(interval)
  }, [pollSession, status])

  const handleConfirm = useCallback(() => {
    onConfirm(masks)
  }, [masks, onConfirm])

  const isWaiting = status === 'launched'
  const hasMasks = status === 'masks_received' && masks.length > 0
  const hasError = status === 'error' || status === 'closed'

  return (
    <CardContainer>
      <CardHeader>
        <Title>SAM3 {t('plugins.title', 'Segmentation')}</Title>
        <StatusBadge status={status}>{status === 'launched' ? 'Annotating...' : status}</StatusBadge>
      </CardHeader>

      <CardBody>
        {isWaiting && (
          <WaitingState>
            <Spin indicator={<Loading3QuartersOutlined spin style={{ fontSize: 24 }} />} />
            <WaitingText>{t('sam3.waiting_annotation', 'Waiting for annotation in SAM3 window...')}</WaitingText>
          </WaitingState>
        )}

        {hasMasks && (
          <>
            {previewUrl && <PreviewImage src={previewUrl} alt="Mask preview" />}
            <MaskList>
              {masks.map((mask) => (
                <MaskItem key={mask.id}>
                  <MaskName>{mask.name}</MaskName>
                </MaskItem>
              ))}
            </MaskList>
          </>
        )}

        {hasError && <ErrorText>{error || 'SAM3 窗口已关闭但未返回标注结果'}</ErrorText>}
      </CardBody>

      {hasMasks && (
        <CardFooter>
          <Button type="primary" icon={<CheckOutlined />} onClick={handleConfirm}>
            {t('sam3.confirm_generate', 'Generate 3D')}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={onRetry}>
            {t('sam3.retry', 'Retry')}
          </Button>
          <Button danger icon={<CloseOutlined />} onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </Button>
        </CardFooter>
      )}

      {(isWaiting || hasError) && (
        <CardFooter>
          {hasError && (
            <Button icon={<ReloadOutlined />} onClick={onRetry}>
              {t('sam3.retry', 'Retry')}
            </Button>
          )}
          <Button danger icon={<CloseOutlined />} onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </Button>
        </CardFooter>
      )}
    </CardContainer>
  )
}

const CardContainer = styled.div`
  border-radius: 12px;
  border: 1px solid var(--color-border);
  background: var(--color-background-soft);
  overflow: hidden;
  max-width: 450px;
  margin: 8px 0;
`

const CardHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
`

const Title = styled.span`
  font-weight: 600;
  font-size: 14px;
  color: var(--color-text-1);
`

const StatusBadge = styled.span<{ status: string }>`
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
  background: ${(p) =>
    p.status === 'masks_received'
      ? 'var(--color-success-bg, rgba(0, 200, 0, 0.1))'
      : p.status === 'error'
        ? 'var(--color-error-bg, rgba(255, 0, 0, 0.1))'
        : 'var(--color-warning-bg, rgba(255, 200, 0, 0.1))'};
  color: ${(p) =>
    p.status === 'masks_received'
      ? 'var(--color-success, #00c800)'
      : p.status === 'error'
        ? 'var(--color-error, #ff4444)'
        : 'var(--color-warning, #ffcc00)'};
`

const CardBody = styled.div`
  padding: 16px;
`

const WaitingState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px 0;
`

const WaitingText = styled.span`
  font-size: 13px;
  color: var(--color-text-2);
`

const PreviewImage = styled.img`
  width: 100%;
  border-radius: 8px;
  margin-bottom: 12px;
`

const MaskList = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`

const MaskItem = styled.div`
  padding: 4px 10px;
  background: var(--color-background-mute);
  border-radius: 6px;
  border: 1px solid var(--color-border);
`

const MaskName = styled.span`
  font-size: 12px;
  color: var(--color-text-2);
`

const ErrorText = styled.div`
  color: var(--color-error, #ff4444);
  font-size: 13px;
  padding: 8px;
  background: var(--color-error-bg, rgba(255, 0, 0, 0.05));
  border-radius: 6px;
`

const CardFooter = styled.div`
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--color-border);
  justify-content: flex-end;
`

export default React.memo(SAM3ConfirmCard)
