import { QuestionCircleOutlined } from '@ant-design/icons'
import { ResetIcon } from '@renderer/components/Icons'
import { HStack } from '@renderer/components/Layout'
import { InfoTooltip } from '@renderer/components/TooltipIcons'
import { useSettings } from '@renderer/hooks/useSettings'
import { useAppDispatch } from '@renderer/store'
import {
  setContextSummaryEnabled,
  setContextSummaryFullTurns,
  setEnableTopicNaming,
  setImageCaptionEnabled,
  setImageContextKeepFullUserTurns,
  setTopicNamingPrompt
} from '@renderer/store/settings'
import { Button, Divider, Flex, Input, InputNumber, Modal, Popover, Switch } from 'antd'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { TopView } from '../../../components/TopView'
import { SettingSubtitle } from '..'

interface Props {
  resolve: (data: any) => void
}

const PopupContainer: React.FC<Props> = ({ resolve }) => {
  const [open, setOpen] = useState(true)
  const { t } = useTranslation()
  const {
    enableTopicNaming,
    topicNamingPrompt,
    contextSummaryEnabled,
    contextSummaryFullTurns,
    imageCaptionEnabled,
    imageContextKeepFullUserTurns
  } = useSettings()
  const dispatch = useAppDispatch()

  const onOk = () => {
    setOpen(false)
  }

  const onCancel = () => {
    setOpen(false)
  }

  const onClose = () => {
    resolve({})
  }

  const handleReset = useCallback(() => {
    dispatch(setTopicNamingPrompt(''))
  }, [dispatch])

  TopicNamingModalPopup.hide = onCancel

  const promptVarsContent = useMemo(() => <pre>{t('assistants.presets.add.prompt.variables.tip.content')}</pre>, [t])

  return (
    <Modal
      title={t('settings.models.quick_model.setting_title')}
      open={open}
      onOk={onOk}
      onCancel={onCancel}
      afterClose={onClose}
      maskClosable={false}
      transitionName="animation-move-down"
      centered
      style={{ padding: '24px' }}>
      <SettingSubtitle style={{ marginTop: 0, marginBottom: 8 }}>
        {t('settings.models.topic_naming.label')}
      </SettingSubtitle>
      <Flex vertical align="stretch" gap={8}>
        <HStack style={{ gap: 16 }} alignItems="center">
          <div>{t('settings.models.topic_naming.auto')}</div>
          <Switch checked={enableTopicNaming} onChange={(v) => dispatch(setEnableTopicNaming(v))} />
        </HStack>
        <Divider style={{ margin: 0 }} />
        <div>
          <Flex align="center" gap={4} style={{ marginBottom: 4, height: 30 }}>
            <div>{t('settings.models.topic_naming.prompt')}</div>
            <Popover title={t('assistants.presets.add.prompt.variables.tip.title')} content={promptVarsContent}>
              <QuestionCircleOutlined size={14} style={{ color: 'var(--color-text-2)' }} />
            </Popover>
            {topicNamingPrompt && <Button icon={<ResetIcon size={14} />} onClick={handleReset} type="text" />}
          </Flex>
          <Input.TextArea
            autoSize={{ minRows: 3, maxRows: 10 }}
            value={topicNamingPrompt || t('prompts.title')}
            onChange={(e) => dispatch(setTopicNamingPrompt(e.target.value))}
            placeholder={t('prompts.title')}
            style={{ width: '100%' }}
          />
        </div>
      </Flex>
      <Divider />
      <SettingSubtitle style={{ marginTop: 0, marginBottom: 8 }}>
        {t('settings.models.context_summary.label')}
      </SettingSubtitle>
      <Flex vertical align="stretch" gap={8}>
        <HStack style={{ gap: 16 }} alignItems="center">
          <HStack alignItems="center" gap={4}>
            <div>{t('settings.models.context_summary.enable')}</div>
            <InfoTooltip title={t('settings.models.context_summary.enable_tooltip')} />
          </HStack>
          <Switch checked={contextSummaryEnabled} onChange={(v) => dispatch(setContextSummaryEnabled(v))} />
        </HStack>
        {contextSummaryEnabled && (
          <>
            <Divider style={{ margin: 0 }} />
            <HStack style={{ gap: 16 }} alignItems="center">
              <HStack alignItems="center" gap={4}>
                <div>{t('settings.models.context_summary.full_turns')}</div>
                <InfoTooltip title={t('settings.models.context_summary.full_turns_tooltip')} />
              </HStack>
              <InputNumber
                min={1}
                max={20}
                value={contextSummaryFullTurns}
                onChange={(v) => v !== null && dispatch(setContextSummaryFullTurns(v))}
                style={{ width: 80 }}
              />
            </HStack>
          </>
        )}
      </Flex>
      <Divider />
      <SettingSubtitle style={{ marginTop: 0, marginBottom: 8 }}>
        {t('settings.models.image_context.label')}
      </SettingSubtitle>
      <Flex vertical align="stretch" gap={8}>
        <HStack style={{ gap: 16 }} alignItems="center">
          <HStack alignItems="center" gap={4}>
            <div>{t('settings.models.image_context.caption_enable')}</div>
            <InfoTooltip title={t('settings.models.image_context.caption_enable_tooltip')} />
          </HStack>
          <Switch checked={imageCaptionEnabled ?? true} onChange={(v) => dispatch(setImageCaptionEnabled(v))} />
        </HStack>
        <Divider style={{ margin: 0 }} />
        <HStack style={{ gap: 16 }} alignItems="center">
          <HStack alignItems="center" gap={4}>
            <div>{t('settings.models.image_context.keep_full_turns')}</div>
            <InfoTooltip title={t('settings.models.image_context.keep_full_turns_tooltip')} />
          </HStack>
          <InputNumber
            min={1}
            max={20}
            value={imageContextKeepFullUserTurns ?? 2}
            onChange={(v) => v !== null && dispatch(setImageContextKeepFullUserTurns(v))}
            style={{ width: 80 }}
          />
        </HStack>
      </Flex>
    </Modal>
  )
}

const TopViewKey = 'TopicNamingModalPopup'

export default class TopicNamingModalPopup {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  static show() {
    return new Promise<any>((resolve) => {
      TopView.show(
        <PopupContainer
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
