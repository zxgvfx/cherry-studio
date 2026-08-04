import { RedoOutlined } from '@ant-design/icons'
import { HStack } from '@renderer/components/Layout'
import ModelSelector from '@renderer/components/ModelSelector'
import { InfoTooltip } from '@renderer/components/TooltipIcons'
import { isEmbeddingModel, isRerankModel, isTextToImageModel } from '@renderer/config/models'
import { TRANSLATE_PROMPT } from '@renderer/config/prompts'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useDefaultModel } from '@renderer/hooks/useAssistant'
import { useProviders } from '@renderer/hooks/useProvider'
import { useSettings } from '@renderer/hooks/useSettings'
import { getModelUniqId } from '@renderer/services/ModelService'
import { useAppDispatch } from '@renderer/store'
import { setTranslateModelPrompt } from '@renderer/store/settings'
import type { Model } from '@renderer/types'
import { Button, Tooltip } from 'antd'
import { Languages, MessageSquareMore, Rocket, Settings2 } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingContainer, SettingDescription, SettingGroup, SettingTitle } from '..'
import TranslateSettingsPopup from '../TranslateSettingsPopup/TranslateSettingsPopup'
import DefaultAssistantSettings from './DefaultAssistantSettings'
import TopicNamingModalPopup from './QuickModelPopup'

const ModelSettings: FC = () => {
  const { defaultModel, quickModel, translateModel, setDefaultModel, setQuickModel, setTranslateModel } =
    useDefaultModel()
  const { providers } = useProviders()
  const allModels = useMemo(() => providers.map((p) => p.models).flat(), [providers])
  const { theme } = useTheme()
  const { t } = useTranslation()
  const { translateModelPrompt } = useSettings()

  const dispatch = useAppDispatch()

  const modelPredicate = useCallback(
    (m: Model) => !isEmbeddingModel(m) && !isRerankModel(m) && !isTextToImageModel(m),
    []
  )

  const defaultModelValue = useMemo(() => {
    const found =
      defaultModel && allModels.find((m) => m.id === defaultModel.id && m.provider === defaultModel.provider)
    return found ? getModelUniqId(found) : undefined
  }, [defaultModel, allModels])

  const defaultQuickModel = useMemo(() => {
    const found = quickModel && allModels.find((m) => m.id === quickModel.id && m.provider === quickModel.provider)
    return found ? getModelUniqId(found) : undefined
  }, [quickModel, allModels])

  const defaultTranslateModel = useMemo(() => {
    const found =
      translateModel && allModels.find((m) => m.id === translateModel.id && m.provider === translateModel.provider)
    return found ? getModelUniqId(found) : undefined
  }, [translateModel, allModels])

  const onResetTranslatePrompt = () => {
    dispatch(setTranslateModelPrompt(TRANSLATE_PROMPT))
  }

  return (
    <SettingContainer theme={theme}>
      <SettingGroup theme={theme}>
        <SettingTitle style={{ marginBottom: 12 }}>
          <HStack alignItems="center" gap={10}>
            <MessageSquareMore size={18} color="var(--color-text)" />
            {t('settings.models.default_assistant_model')}
          </HStack>
        </SettingTitle>
        <HStack alignItems="center">
          <ModelSelector
            providers={providers}
            predicate={modelPredicate}
            value={defaultModelValue}
            defaultValue={defaultModelValue}
            style={{ width: 360 }}
            onChange={(value) => {
              const target = JSON.parse(value)
              const model = allModels.find((m) => m.id === target.id && m.provider === target.provider)
              if (model) setDefaultModel(model)
            }}
            placeholder={t('settings.models.empty')}
          />
          <Button icon={<Settings2 size={16} />} style={{ marginLeft: 8 }} onClick={DefaultAssistantSettings.show} />
        </HStack>
        <SettingDescription>{t('settings.models.default_assistant_model_description')}</SettingDescription>
      </SettingGroup>
      <SettingGroup theme={theme}>
        <SettingTitle style={{ marginBottom: 12 }}>
          <HStack alignItems="center" gap={10}>
            <Rocket size={18} color="var(--color-text)" />
            {t('settings.models.quick_model.label')}
            <InfoTooltip title={t('settings.models.quick_model.tooltip')} />
          </HStack>
        </SettingTitle>
        <HStack alignItems="center">
          <ModelSelector
            providers={providers}
            predicate={modelPredicate}
            value={defaultQuickModel}
            defaultValue={defaultQuickModel}
            style={{ width: 360 }}
            onChange={(value) => {
              const target = JSON.parse(value)
              const model = allModels.find((m) => m.id === target.id && m.provider === target.provider)
              if (model) setQuickModel(model)
            }}
            placeholder={t('settings.models.empty')}
          />
          <Button icon={<Settings2 size={16} />} style={{ marginLeft: 8 }} onClick={TopicNamingModalPopup.show} />
        </HStack>
        <SettingDescription>{t('settings.models.quick_model.description')}</SettingDescription>
      </SettingGroup>
      <SettingGroup theme={theme}>
        <SettingTitle style={{ marginBottom: 12 }}>
          <HStack alignItems="center" gap={10}>
            <Languages size={18} color="var(--color-text)" />
            {t('settings.models.translate_model')}
          </HStack>
        </SettingTitle>
        <HStack alignItems="center">
          <ModelSelector
            providers={providers}
            predicate={modelPredicate}
            value={defaultTranslateModel}
            defaultValue={defaultTranslateModel}
            style={{ width: 360 }}
            onChange={(value) => {
              const target = JSON.parse(value)
              const model = allModels.find((m) => m.id === target.id && m.provider === target.provider)
              if (model) setTranslateModel(model)
            }}
            placeholder={t('settings.models.empty')}
          />
          <Button
            icon={<Settings2 size={16} />}
            style={{ marginLeft: 8 }}
            onClick={() => TranslateSettingsPopup.show()}
          />
          {translateModelPrompt !== TRANSLATE_PROMPT && (
            <Tooltip title={t('common.reset')}>
              <Button icon={<RedoOutlined />} style={{ marginLeft: 8 }} onClick={onResetTranslatePrompt}></Button>
            </Tooltip>
          )}
        </HStack>
        <SettingDescription>{t('settings.models.translate_model_description')}</SettingDescription>
      </SettingGroup>
    </SettingContainer>
  )
}

export default ModelSettings
