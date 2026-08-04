import { ActionIconButton } from '@renderer/components/Buttons'
import { useAssistant } from '@renderer/hooks/useAssistant'
import type { ToolQuickPanelApi } from '@renderer/pages/home/Inputbar/types'
import type { VideoGenBitrateMode, VideoGenDuration, VideoGenRatio, VideoGenResolution } from '@renderer/types'
import { Popover, Switch, Tooltip } from 'antd'
import { Clapperboard, Clock, Droplets, Gauge, ImagePlus, Maximize2, Ratio, Volume2 } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const VIDEO_DURATIONS: VideoGenDuration[] = [4, 5, 6, 8, 10, 12, 15]
const VIDEO_RESOLUTIONS: VideoGenResolution[] = ['480p', '720p']
const VIDEO_RATIOS: VideoGenRatio[] = ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
const VIDEO_BITRATES: VideoGenBitrateMode[] = ['standard', 'high']

interface Props {
  quickPanel: ToolQuickPanelApi
  assistantId: string
}

const VideoGenSettingsButton: FC<Props> = ({ assistantId }) => {
  const { t } = useTranslation()
  const { assistant, updateAssistantSettings } = useAssistant(assistantId)
  const [open, setOpen] = useState(false)

  const currentDuration: VideoGenDuration = assistant.settings?.videoGen?.duration ?? 5
  const currentResolution: VideoGenResolution = assistant.settings?.videoGen?.resolution ?? '720p'
  const currentRatio: VideoGenRatio = assistant.settings?.videoGen?.ratio ?? 'adaptive'
  const currentGenerateAudio = assistant.settings?.videoGen?.generateAudio ?? true
  const currentBitrate: VideoGenBitrateMode = assistant.settings?.videoGen?.bitrateMode ?? 'standard'
  const currentWatermark = assistant.settings?.videoGen?.watermark ?? false
  const currentReturnLastFrame = assistant.settings?.videoGen?.returnLastFrame ?? false

  const updateVideoGen = useCallback(
    (
      patch: Partial<{
        duration: VideoGenDuration
        resolution: VideoGenResolution
        ratio: VideoGenRatio
        generateAudio: boolean
        bitrateMode: VideoGenBitrateMode
        watermark: boolean
        returnLastFrame: boolean
      }>
    ) => {
      const prev = assistant.settings?.videoGen ?? {}
      updateAssistantSettings({
        videoGen: {
          ...prev,
          ...patch
        }
      })
    },
    [assistant.settings?.videoGen, updateAssistantSettings]
  )

  const ratioLabel = useCallback(
    (ratio: VideoGenRatio): string =>
      ratio === 'adaptive' ? t('chat.input.video_gen.ratio.adaptive', { defaultValue: '自适应' }) : ratio,
    [t]
  )

  const bitrateLabel = useCallback(
    (mode: VideoGenBitrateMode): string =>
      t(`chat.input.video_gen.bitrate.${mode}`, {
        defaultValue: mode === 'high' ? '高码率' : '标准'
      }),
    [t]
  )

  const previewText = useMemo(
    () =>
      t('chat.input.video_gen.preview', {
        defaultValue: '将以 {{duration}}s · {{resolution}} · {{ratio}} 生成',
        duration: currentDuration,
        resolution: currentResolution,
        ratio: ratioLabel(currentRatio)
      }),
    [currentDuration, currentRatio, currentResolution, ratioLabel, t]
  )

  const popoverContent = (
    <PanelRoot>
      <PreviewBar>
        <PreviewIcon>
          <Clapperboard size={14} />
        </PreviewIcon>
        <PreviewText>{previewText}</PreviewText>
      </PreviewBar>

      <Section>
        <SectionTitle>
          <Clock size={14} />
          <span>{t('chat.input.video_gen.duration.label', { defaultValue: '时长' })}</span>
        </SectionTitle>
        <ChipGrid>
          {VIDEO_DURATIONS.map((d) => (
            <Chip
              key={d}
              type="button"
              data-active={currentDuration === d}
              onClick={() => updateVideoGen({ duration: d })}>
              {d}s
            </Chip>
          ))}
        </ChipGrid>
      </Section>

      <Section>
        <SectionTitle>
          <Maximize2 size={14} />
          <span>{t('chat.input.video_gen.resolution.label', { defaultValue: '分辨率' })}</span>
        </SectionTitle>
        <ChipGrid>
          {VIDEO_RESOLUTIONS.map((r) => (
            <Chip
              key={r}
              type="button"
              data-active={currentResolution === r}
              onClick={() => updateVideoGen({ resolution: r })}>
              {r}
            </Chip>
          ))}
        </ChipGrid>
        <HintText>
          {t('chat.input.video_gen.resolution.hint', {
            defaultValue: '480p / 720p 按官网实测差价计费；SR 档位暂未接入'
          })}
        </HintText>
      </Section>

      <Section>
        <SectionTitle>
          <Ratio size={14} />
          <span>{t('chat.input.video_gen.ratio.label', { defaultValue: '画幅' })}</span>
        </SectionTitle>
        <ChipGrid>
          {VIDEO_RATIOS.map((r) => (
            <Chip key={r} type="button" data-active={currentRatio === r} onClick={() => updateVideoGen({ ratio: r })}>
              {ratioLabel(r)}
            </Chip>
          ))}
        </ChipGrid>
      </Section>

      <Section>
        <SectionTitle>
          <Gauge size={14} />
          <span>{t('chat.input.video_gen.bitrate.label', { defaultValue: '比特率模式' })}</span>
        </SectionTitle>
        <ChipGrid>
          {VIDEO_BITRATES.map((mode) => (
            <Chip
              key={mode}
              type="button"
              data-active={currentBitrate === mode}
              onClick={() => updateVideoGen({ bitrateMode: mode })}>
              {bitrateLabel(mode)}
            </Chip>
          ))}
        </ChipGrid>
        <HintText>
          {t('chat.input.video_gen.bitrate.hint', {
            defaultValue: '仅影响文件清晰度/体积，不影响计费'
          })}
        </HintText>
      </Section>

      <Section>
        <ToggleRow>
          <SectionTitle>
            <Volume2 size={14} />
            <span>{t('chat.input.video_gen.audio.label', { defaultValue: '生成音频' })}</span>
          </SectionTitle>
          <Switch
            size="small"
            checked={currentGenerateAudio}
            onChange={(checked) => updateVideoGen({ generateAudio: checked })}
          />
        </ToggleRow>
      </Section>

      <Section>
        <ToggleRow>
          <SectionTitle>
            <Droplets size={14} />
            <span>{t('chat.input.video_gen.watermark.label', { defaultValue: '水印' })}</span>
          </SectionTitle>
          <Switch
            size="small"
            checked={currentWatermark}
            onChange={(checked) => updateVideoGen({ watermark: checked })}
          />
        </ToggleRow>
        <HintText>{t('chat.input.video_gen.watermark.hint', { defaultValue: '是否加水印，一般不影响价格' })}</HintText>
      </Section>

      <Section>
        <ToggleRow>
          <SectionTitle>
            <ImagePlus size={14} />
            <span>{t('chat.input.video_gen.return_last_frame.label', { defaultValue: '返回尾帧' })}</span>
          </SectionTitle>
          <Switch
            size="small"
            checked={currentReturnLastFrame}
            onChange={(checked) => updateVideoGen({ returnLastFrame: checked })}
          />
        </ToggleRow>
        <HintText>
          {t('chat.input.video_gen.return_last_frame.hint', {
            defaultValue: '额外返回最后一帧图片，一般不影响视频时长计费'
          })}
        </HintText>
      </Section>
    </PanelRoot>
  )

  const ariaLabel = t('chat.input.video_gen.label', { defaultValue: '视频参数' })
  const tooltipTitle = `${ariaLabel}  ${currentDuration}s · ${currentResolution} · ${ratioLabel(currentRatio)}`
  const active =
    currentDuration !== 5 ||
    currentResolution !== '720p' ||
    currentRatio !== 'adaptive' ||
    !currentGenerateAudio ||
    currentBitrate !== 'standard' ||
    currentWatermark ||
    currentReturnLastFrame

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="top"
      arrow={false}
      destroyTooltipOnHide
      overlayClassName="video-gen-settings-popover"
      content={popoverContent}>
      <Tooltip placement="top" title={open ? undefined : tooltipTitle} mouseLeaveDelay={0} arrow>
        <ActionIconButton active={active} aria-label={ariaLabel} aria-pressed={active}>
          <Clapperboard size={18} />
        </ActionIconButton>
      </Tooltip>
    </Popover>
  )
}

export default VideoGenSettingsButton

const PanelRoot = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 300px;
  padding: 4px 2px;
`

const PreviewBar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--color-background-soft);
  border-radius: 8px;
`

const PreviewIcon = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--color-primary-soft, rgba(99, 102, 241, 0.12));
  color: var(--color-primary, #6366f1);
`

const PreviewText = styled.span`
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 1.4;
`

const Section = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`

const SectionTitle = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
  letter-spacing: 0.2px;

  svg {
    flex-shrink: 0;
    opacity: 0.7;
  }
`

const ToggleRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`

const HintText = styled.div`
  font-size: 11px;
  color: var(--color-text-secondary);
  opacity: 0.85;
  line-height: 1.35;
  padding-left: 2px;
`

const ChipGrid = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`

const Chip = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  color: var(--color-text);
  background: var(--color-background-soft);
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.08));
  border-radius: 999px;
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;

  &[data-active='true'] {
    color: var(--color-primary, #6366f1);
    background: var(--color-primary-soft, rgba(99, 102, 241, 0.12));
    border-color: var(--color-primary, #6366f1);
  }

  &:hover {
    border-color: var(--color-primary, #6366f1);
  }
`
