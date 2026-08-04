import { ActionIconButton } from '@renderer/components/Buttons'
import { isDedicatedImageModel, isGenerateImageModel } from '@renderer/config/models'
import type { Assistant, Model } from '@renderer/types'
import { Tooltip } from 'antd'
import { Image } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  assistant: Assistant
  model: Model
  onEnableGenerateImage: () => void
}

const GenerateImageButton: FC<Props> = ({ model, assistant, onEnableGenerateImage }) => {
  const { t } = useTranslation()

  const dedicated = isDedicatedImageModel(model)
  const supported = isGenerateImageModel(model)

  const ariaLabel = supported ? t('chat.input.generate_image') : t('chat.input.generate_image_not_supported')

  return (
    <Tooltip placement="top" title={ariaLabel} mouseLeaveDelay={0} arrow>
      <ActionIconButton
        onClick={dedicated ? undefined : onEnableGenerateImage}
        active={dedicated || assistant.enableGenerateImage}
        disabled={!supported}
        aria-label={ariaLabel}
        aria-pressed={dedicated || assistant.enableGenerateImage}>
        <Image size={18} />
      </ActionIconButton>
    </Tooltip>
  )
}

export default GenerateImageButton
