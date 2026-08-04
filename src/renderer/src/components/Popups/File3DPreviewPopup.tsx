import { FileOutlined } from '@ant-design/icons'
import { Modal } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { TopView } from '../TopView'

export type Preview3DType = 'point_cloud' | 'model_3d'

interface Props {
  title: string
  previewType: Preview3DType
  resolve: (data: any) => void
}

const PopupContainer: React.FC<Props> = ({ title, previewType, resolve }) => {
  const [open, setOpen] = useState(true)
  const { t } = useTranslation()

  const onCancel = () => {
    setOpen(false)
  }

  const onClose = () => {
    resolve({})
  }

  File3DPreviewPopup.hide = onCancel

  const typeLabel =
    previewType === 'point_cloud' ? t('files.preview.point_cloud') : t('files.preview.model_3d')

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      afterClose={onClose}
      title={title}
      width={500}
      transitionName="animation-move-down"
      styles={{
        content: {
          borderRadius: 20,
          overflow: 'hidden'
        }
      }}
      centered
      closable={true}
      footer={null}>
      <PlaceholderContainer>
        <FileOutlined style={{ fontSize: 64, color: 'var(--color-text-3)' }} />
        <PlaceholderText>{t('files.preview.coming_soon', { type: typeLabel })}</PlaceholderText>
      </PlaceholderContainer>
    </Modal>
  )
}

const PlaceholderContainer = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  gap: 16px;
`

const PlaceholderText = styled.div`
  color: var(--color-text-3);
  font-size: 14px;
  text-align: center;
`

const TopViewKey = 'File3DPreviewPopup'

export default class File3DPreviewPopup {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  static show(title: string, previewType: Preview3DType) {
    return new Promise<any>((resolve) => {
      TopView.show(
        <PopupContainer
          title={title}
          previewType={previewType}
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
