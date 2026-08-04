import { CloseOutlined } from '@ant-design/icons'
import { Button } from 'antd'
import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import SAM3ManualFlow from '../SAM3/SAM3ManualFlow'
import { TopView } from '../TopView'

const TopViewKey = 'SAM3ManualPopup'

interface PopupContainerProps {
  imagePath: string
  resolve: (value: any) => void
}

const PopupContainer: React.FC<PopupContainerProps> = ({ imagePath, resolve }) => {
  const { t } = useTranslation()
  const [resultFile, setResultFile] = useState<{
    id: string
    name: string
    path: string
    ext: string
    size: number
  } | null>(null)

  const handleComplete = useCallback(
    (modelFile: { id: string; name: string; path: string; ext: string; size: number }) => {
      setResultFile(modelFile)
      resolve(modelFile)
    },
    [resolve]
  )

  const handleCancel = useCallback(() => {
    resolve(null)
  }, [resolve])

  return (
    <Backdrop onClick={handleCancel}>
      <Container onClick={(e) => e.stopPropagation()}>
        <Header>
          <Title>{t('sam3.manual_mode', 'SAM3 Annotation')}</Title>
          <Button type="text" icon={<CloseOutlined />} onClick={handleCancel} style={{ color: '#999' }} />
        </Header>
        <Content>
          {resultFile ? (
            <DoneMessage>{t('sam3.complete', '3D model generation complete')}</DoneMessage>
          ) : (
            <SAM3ManualFlow imagePath={imagePath} onComplete={handleComplete} onCancel={handleCancel} />
          )}
        </Content>
      </Container>
    </Backdrop>
  )
}

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
`

const Container = styled.div`
  display: flex;
  flex-direction: column;
  width: 90vw;
  max-width: 1300px;
  height: 80vh;
  background: #0a0a0c;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
`

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(20, 22, 28, 0.95);
`

const Title = styled.span`
  font-size: 14px;
  font-weight: 600;
  color: #00ffb4;
  font-family: 'Segoe UI', sans-serif;
  letter-spacing: 0.5px;
`

const Content = styled.div`
  flex: 1;
  overflow: hidden;
`

const DoneMessage = styled.div`
  text-align: center;
  font-size: 14px;
  color: #00ffb4;
  padding: 24px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
`

export default class SAM3ManualPopup {
  static hide() {
    TopView.hide(TopViewKey)
  }
  static show(imagePath: string): Promise<any> {
    return new Promise<any>((resolve) => {
      TopView.show(
        <PopupContainer
          imagePath={imagePath}
          resolve={(v) => {
            resolve(v)
            TopView.hide(TopViewKey)
          }}
        />,
        TopViewKey
      )
    })
  }
}
