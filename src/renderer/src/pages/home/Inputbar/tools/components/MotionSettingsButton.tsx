import { ActionIconButton } from '@renderer/components/Buttons'
import type { Assistant } from '@renderer/types'
import { InputNumber, Popover, Slider } from 'antd'
import { Clapperboard } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  assistant: Assistant
  onUpdate: (values: { motionCount?: number; motionDuration?: number }) => void
}

const VARIANT_OPTIONS = [1, 2, 4, 8]

const MotionSettingsButton: FC<Props> = ({ assistant, onUpdate }) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const count = assistant.motionCount ?? 4
  const duration = assistant.motionDuration ?? 2.0

  const handleCountChange = useCallback(
    (n: number) => {
      onUpdate({ motionCount: n })
    },
    [onUpdate]
  )

  const handleDurationChange = useCallback(
    (val: number | null) => {
      if (val != null && val >= 0.5 && val <= 30) {
        onUpdate({ motionDuration: val })
      }
    },
    [onUpdate]
  )

  const content = (
    <PanelContainer>
      <SettingRow>
        <Label>{t('motion.settings.variant_count', 'Variants')}</Label>
        <SegmentedGroup>
          {VARIANT_OPTIONS.map((n) => (
            <SegmentedItem key={n} $active={count === n} onClick={() => handleCountChange(n)}>
              {n}
            </SegmentedItem>
          ))}
        </SegmentedGroup>
      </SettingRow>
      <SettingRow>
        <Label>{t('motion.settings.duration', 'Duration (s)')}</Label>
        <SliderWrapper>
          <Slider
            min={0.5}
            max={30}
            step={0.5}
            value={duration}
            onChange={handleDurationChange}
            tooltip={{ formatter: (v) => `${v}s` }}
          />
        </SliderWrapper>
        <InputNumber
          size="small"
          min={0.5}
          max={30}
          step={0.5}
          value={duration}
          onChange={handleDurationChange}
          style={{ width: 60 }}
          controls={false}
        />
      </SettingRow>
    </PanelContainer>
  )

  return (
    <Popover
      content={content}
      trigger="click"
      placement="topLeft"
      open={open}
      onOpenChange={setOpen}
      arrow={false}
      overlayInnerStyle={{ padding: 0 }}>
      <ActionIconButton
        active={open}
        aria-label={t('motion.settings.title', 'Motion settings')}
        title={t('motion.settings.title', 'Motion settings')}>
        <Clapperboard size={18} />
      </ActionIconButton>
    </Popover>
  )
}

const PanelContainer = styled.div`
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 240px;
`

const SettingRow = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
`

const Label = styled.span`
  font-size: 12px;
  color: var(--color-text-2);
  white-space: nowrap;
  min-width: 60px;
`

const SegmentedGroup = styled.div`
  display: flex;
  gap: 4px;
  flex: 1;
`

const SegmentedItem = styled.button<{ $active: boolean }>`
  flex: 1;
  height: 26px;
  border-radius: 6px;
  border: 1px solid ${(p) => (p.$active ? 'var(--color-primary)' : 'var(--color-border)')};
  background: ${(p) => (p.$active ? 'var(--color-primary)' : 'transparent')};
  color: ${(p) => (p.$active ? 'white' : 'var(--color-text)')};
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: all 0.15s;

  &:hover {
    border-color: var(--color-primary);
  }
`

const SliderWrapper = styled.div`
  flex: 1;
  min-width: 0;

  .ant-slider {
    margin: 0;
  }
`

export default MotionSettingsButton
