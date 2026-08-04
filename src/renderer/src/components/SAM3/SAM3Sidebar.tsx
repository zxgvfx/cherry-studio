import { DeleteOutlined, EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons'
import { Flex, Input } from 'antd'
import { PlusIcon } from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import type { MaskLayer } from './SAM3Canvas'

interface Props {
  layers: MaskLayer[]
  activeLayerId?: string
  clickMode: number
  loading: boolean
  statusText: string
  onSetMode: (mode: number) => void
  onAddLayer: () => void
  onSelectLayer: (id: string) => void
  onToggleLayer: (id: string) => void
  onDeleteLayer: (id: string) => void
  onRenameLayer: (id: string, name: string) => void
  onClearPoints: () => void
  onClearAll: () => void
  onGenerate3D: () => void
  onExportMasks: () => void
}

const SAM3Sidebar: React.FC<Props> = ({
  layers,
  activeLayerId,
  clickMode,
  loading,
  statusText,
  onSetMode,
  onAddLayer,
  onSelectLayer,
  onToggleLayer,
  onDeleteLayer,
  onRenameLayer,
  onClearPoints,
  onClearAll,
  onGenerate3D,
  onExportMasks
}) => {
  const { t } = useTranslation()

  return (
    <Container>
      <SectionLabel>CONTROLS</SectionLabel>
      <Flex gap={8}>
        <ModeButton $active={clickMode === 1} onClick={() => onSetMode(1)}>
          FOREGROUND
        </ModeButton>
        <ModeButton $active={clickMode === 0} $danger onClick={() => onSetMode(0)}>
          BACKGROUND
        </ModeButton>
      </Flex>
      <Flex gap={8}>
        <ActionButton onClick={onAddLayer} disabled={loading}>
          <PlusIcon size={12} /> NEW OBJ
        </ActionButton>
        <ActionButton onClick={onClearPoints} disabled={loading}>
          CLEAR PTS
        </ActionButton>
      </Flex>

      <SectionLabel style={{ marginTop: 16 }}>
        <span>DETECTED OBJECTS</span>
        <ResetButton onClick={onClearAll} disabled={loading}>
          RESET
        </ResetButton>
      </SectionLabel>

      <LayerList>
        {layers
          .slice()
          .reverse()
          .map((layer) => (
            <LayerCard
              key={layer.id}
              $active={layer.id === activeLayerId}
              $color={layer.color}
              onClick={() => onSelectLayer(layer.id)}>
              <LayerInfo>
                <Input
                  size="small"
                  variant="borderless"
                  value={layer.name}
                  onChange={(e) => onRenameLayer(layer.id, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: 13,
                    padding: '0 2px',
                    background: 'transparent'
                  }}
                />
                <PointCount>{layer.points.length} PTS</PointCount>
              </LayerInfo>
              <Flex gap={2}>
                <IconBtn
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleLayer(layer.id)
                  }}>
                  {layer.visible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                </IconBtn>
                <IconBtn
                  $danger
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteLayer(layer.id)
                  }}>
                  <DeleteOutlined />
                </IconBtn>
              </Flex>
            </LayerCard>
          ))}
        {layers.length === 0 && <EmptyHint>{t('sam3.no_objects', 'Click on the image to start annotating')}</EmptyHint>}
      </LayerList>

      <SectionLabel style={{ marginTop: 16 }}>3D RECONSTRUCTION</SectionLabel>
      <ActionButton $primary onClick={onGenerate3D} disabled={loading || layers.length === 0}>
        GENERATE MODEL
      </ActionButton>
      <ActionButton onClick={onExportMasks} disabled={loading || layers.length === 0}>
        EXPORT MASKS
      </ActionButton>

      <StatusBar>{statusText}</StatusBar>
    </Container>
  )
}

const Container = styled.div`
  width: 300px;
  min-width: 300px;
  background: rgba(20, 22, 28, 0.94);
  border-left: 1px solid rgba(255, 255, 255, 0.1);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
`

const SectionLabel = styled.div`
  color: #00ffb4;
  font-family: 'Segoe UI', sans-serif;
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.5px;
  display: flex;
  align-items: center;
  justify-content: space-between;
`

const ModeButton = styled.button<{ $active?: boolean; $danger?: boolean }>`
  flex: 1;
  height: 34px;
  border: 1px solid ${(p) => (p.$danger ? '#ff4444' : '#00ffb4')};
  border-radius: 6px;
  background: ${(p) =>
    p.$active ? (p.$danger ? 'rgba(255,68,68,0.4)' : 'rgba(0,255,180,0.4)') : 'rgba(255,255,255,0.05)'};
  color: ${(p) => (p.$danger ? '#ff4444' : p.$active ? '#00ffb4' : '#ccc')};
  font-weight: 700;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s;
  &:hover {
    background: ${(p) => (p.$danger ? 'rgba(255,68,68,0.3)' : 'rgba(0,255,180,0.3)')};
  }
`

const ActionButton = styled.button<{ $primary?: boolean }>`
  flex: 1;
  height: 34px;
  border: 1px solid ${(p) => (p.$primary ? '#00ffb4' : '#444')};
  border-radius: 6px;
  background: ${(p) => (p.$primary ? 'rgba(0,255,180,0.15)' : 'rgba(255,255,255,0.05)')};
  color: ${(p) => (p.$primary ? '#00ffb4' : '#ccc')};
  font-weight: 700;
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  &:hover {
    background: ${(p) => (p.$primary ? 'rgba(0,255,180,0.3)' : 'rgba(255,255,255,0.1)')};
  }
  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
`

const ResetButton = styled.button`
  background: none;
  border: none;
  color: #ff4444;
  font-weight: 700;
  font-size: 10px;
  cursor: pointer;
  &:hover {
    opacity: 0.8;
  }
  &:disabled {
    opacity: 0.3;
  }
`

const LayerList = styled.div`
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 80px;
`

const LayerCard = styled.div<{ $active?: boolean; $color: string }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 4px;
  border-left: 3px solid ${(p) => (p.$active ? '#00ffb4' : p.$color)};
  background: ${(p) => (p.$active ? 'rgba(50,52,60,0.8)' : 'rgba(30,32,40,0.6)')};
  cursor: pointer;
  transition: background 0.15s;
  &:hover {
    background: rgba(60, 62, 70, 0.9);
  }
`

const LayerInfo = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
`

const PointCount = styled.span`
  color: #666;
  font-family: 'Consolas', monospace;
  font-size: 10px;
  padding-left: 4px;
`

const IconBtn = styled.button<{ $danger?: boolean }>`
  background: none;
  border: none;
  color: ${(p) => (p.$danger ? '#ff4444' : '#555')};
  font-size: 14px;
  cursor: pointer;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  &:hover {
    color: #fff;
  }
`

const EmptyHint = styled.div`
  color: #555;
  font-size: 12px;
  text-align: center;
  padding: 20px 0;
`

const StatusBar = styled.div`
  color: #666;
  font-family: 'Consolas', monospace;
  font-size: 10px;
  margin-top: auto;
  padding-top: 8px;
`

export default React.memo(SAM3Sidebar)
