import { ActionIconButton } from '@renderer/components/Buttons'
import {
  computeGptImageSize,
  getImageEditMaxInputImages,
  GPT_IMAGE_ASPECT_RATIOS,
  GPT_IMAGE_OUTPUT_COUNTS,
  GPT_IMAGE_QUALITIES,
  GPT_IMAGE_RESOLUTION_TIERS,
  isGptImage2Model,
  isGptImageModel,
  isNanoBananaModel
} from '@renderer/config/models/vision'
import { useAssistant } from '@renderer/hooks/useAssistant'
import type { ToolQuickPanelApi } from '@renderer/pages/home/Inputbar/types'
import type { GptImageAspectRatio, GptImageQuality, GptImageResolutionTier, Model } from '@renderer/types'
import { Popover, Switch, Tooltip } from 'antd'
import { Globe, Hash, Image as ImageIcon, Images, Maximize2, Ratio, Sparkles } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  /** 保留参数以兼容工具签名；本组件不再走 QuickPanel。 */
  quickPanel: ToolQuickPanelApi
  model: Model
  assistantId: string
}

/**
 * gpt-image 系列（gpt-image-1 / 1.5 / 2）的参数控制按钮。
 *
 * 文档：https://api-gpt-ge.apifox.cn/288964677e0
 *   - `gpt-image-2` 的 `size` 是自由 `"WxH"`：长宽 ≤ 3840 且必须是 16 的倍数
 *   - 也可填 `auto`
 *
 * 交互：
 *   - 单按钮点击 → 弹 Popover 设置面板（trigger='click'，连续操作不关闭）
 *   - 面板内分 **三组** chip 按钮：
 *       1. 宽高比 (1:1 / 16:9 / ... / auto)
 *       2. 分辨率档位 (1K / 2K / 3K / 4K / auto)
 *       3. 图片质量 (auto / high / medium / low)
 *   - 顶部实时预览即将发送的 size（由 `computeGptImageSize` 算出）
 *   - 选项点击不关闭面板，点面板外或主按钮才关闭
 */
const GptImageSettingsButton: FC<Props> = ({ assistantId, model }) => {
  const { t } = useTranslation()
  const { assistant, updateAssistantSettings } = useAssistant(assistantId)
  const [open, setOpen] = useState(false)

  const currentAspectRatio: GptImageAspectRatio = assistant.settings?.gptImage?.aspectRatio ?? 'auto'
  const currentTier: GptImageResolutionTier = assistant.settings?.gptImage?.resolutionTier ?? 'auto'
  const currentQuality: GptImageQuality = assistant.settings?.gptImage?.quality ?? 'auto'
  // quality / n 仅 gpt-image 支持；nano-banana 等通用生图端点只用比例与分辨率
  const supportsAdvancedParams = isGptImageModel(model)
  const supportsNanoWebSearch = isNanoBananaModel(model)
  const supportsMultipleOutputs = supportsAdvancedParams && !isGptImage2Model(model)
  const currentOutputCount = supportsMultipleOutputs ? (assistant.settings?.gptImage?.n ?? 1) : 1
  const currentEnableWebSearch = Boolean(assistant.settings?.gptImage?.enableWebSearch)
  const maxInputImages = getImageEditMaxInputImages(model)

  const computedSize = useMemo(
    () => computeGptImageSize(currentAspectRatio, currentTier),
    [currentAspectRatio, currentTier]
  )

  const updateGptImage = useCallback(
    (
      patch: Partial<{
        aspectRatio: GptImageAspectRatio
        resolutionTier: GptImageResolutionTier
        quality: GptImageQuality
        n: number
        enableWebSearch: boolean
      }>
    ) => {
      const prev = assistant.settings?.gptImage ?? {}
      const nextAspectRatio =
        patch.aspectRatio ??
        (patch.resolutionTier && (!prev.aspectRatio || prev.aspectRatio === 'auto') ? '1:1' : prev.aspectRatio)
      const nextResolutionTier =
        patch.resolutionTier ??
        (patch.aspectRatio && (!prev.resolutionTier || prev.resolutionTier === 'auto') ? '1k' : prev.resolutionTier)
      const merged = {
        ...prev,
        ...patch,
        aspectRatio: nextAspectRatio,
        resolutionTier: nextResolutionTier
      }
      const nextSize = computeGptImageSize(nextAspectRatio, nextResolutionTier)
      updateAssistantSettings({ gptImage: { ...merged, size: nextSize } })
    },
    [assistant.settings?.gptImage, updateAssistantSettings]
  )

  const ratioLabel = useCallback(
    (ratio: GptImageAspectRatio): string =>
      ratio === 'auto' ? t('chat.input.gpt_image.aspect_ratio.auto', { defaultValue: '自动' }) : ratio,
    [t]
  )

  const tierLabel = useCallback(
    (tier: GptImageResolutionTier): string =>
      tier === 'auto'
        ? t('chat.input.gpt_image.resolution.auto', { defaultValue: '自动' })
        : t(`chat.input.gpt_image.resolution.${tier}`, { defaultValue: tier.toUpperCase() }),
    [t]
  )

  const qualityLabel = useCallback(
    (quality: GptImageQuality): string => t(`chat.input.gpt_image.quality.${quality}`, { defaultValue: quality }),
    [t]
  )

  // 顶部预览文本：将以 1024x1024 · high · 1张 生成 / 将以 原图比例·2K 生成
  const previewText = useMemo(() => {
    let sizePart: string
    if (computedSize !== 'auto') {
      sizePart = computedSize
    } else if (currentTier && currentTier !== 'auto') {
      // 比例 auto + 档位明确：请求时按原图比例（图生图）或 1:1（文生图）解析，这里提示用户。
      sizePart = t('chat.input.gpt_image.preview.follow_source_tier', {
        tier: tierLabel(currentTier),
        defaultValue: '原图比例 · {{tier}}'
      })
    } else {
      sizePart = t('chat.input.gpt_image.preview.auto', { defaultValue: '自动尺寸' })
    }
    const qualityPart =
      currentQuality === 'auto'
        ? t('chat.input.gpt_image.preview.auto_quality', { defaultValue: '自动质量' })
        : qualityLabel(currentQuality)
    const countPart = t('chat.input.gpt_image.output_count.value', {
      count: currentOutputCount,
      defaultValue: '{{count}} 张'
    })
    if (!supportsAdvancedParams) {
      return t('chat.input.gpt_image.preview.text', '将以 {{size}} 生成', {
        size: sizePart
      })
    }
    return t('chat.input.gpt_image.preview.text_with_count', '将以 {{size}} · {{quality}} · {{imageCount}} 生成', {
      size: sizePart,
      quality: qualityPart,
      imageCount: countPart
    })
  }, [
    computedSize,
    currentOutputCount,
    currentQuality,
    currentTier,
    qualityLabel,
    supportsAdvancedParams,
    t,
    tierLabel
  ])

  const popoverContent = (
    <PanelRoot>
      <PreviewBar>
        <PreviewIcon>
          <ImageIcon size={14} />
        </PreviewIcon>
        <PreviewText>{previewText}</PreviewText>
      </PreviewBar>

      <HintBar>
        <Images size={14} />
        <span>
          {t('chat.input.gpt_image.input_images.max', {
            count: maxInputImages,
            defaultValue: '图生图最多支持 {{count}} 张输入图片'
          })}
        </span>
      </HintBar>

      <Section>
        <SectionTitle>
          <Ratio size={14} />
          <span>{t('chat.input.gpt_image.aspect_ratio.label', { defaultValue: '宽高比' })}</span>
        </SectionTitle>
        <ChipGrid>
          {GPT_IMAGE_ASPECT_RATIOS.map((ratio) => (
            <Chip
              key={ratio}
              type="button"
              data-active={currentAspectRatio === ratio}
              onClick={() => updateGptImage({ aspectRatio: ratio })}>
              {ratioLabel(ratio)}
            </Chip>
          ))}
        </ChipGrid>
      </Section>

      <Section>
        <SectionTitle>
          <Maximize2 size={14} />
          <span>{t('chat.input.gpt_image.resolution.label', { defaultValue: '分辨率档位' })}</span>
        </SectionTitle>
        <ChipGrid>
          {GPT_IMAGE_RESOLUTION_TIERS.map((tier) => (
            <Chip
              key={tier}
              type="button"
              data-active={currentTier === tier}
              onClick={() => updateGptImage({ resolutionTier: tier })}>
              {tierLabel(tier)}
            </Chip>
          ))}
        </ChipGrid>
      </Section>

      {supportsNanoWebSearch && (
        <Section>
          <WebSearchRow>
            <SectionTitle>
              <Globe size={14} />
              <span>{t('chat.input.gpt_image.web_search.label', { defaultValue: '联网搜索' })}</span>
            </SectionTitle>
            <Switch
              size="small"
              checked={currentEnableWebSearch}
              onChange={(checked) => updateGptImage({ enableWebSearch: checked })}
            />
          </WebSearchRow>
          <WebSearchHint>
            {t('chat.input.gpt_image.web_search.hint', {
              defaultValue: '开启后按 Atlas 报价约 +$0.014 / 张'
            })}
          </WebSearchHint>
        </Section>
      )}

      {supportsAdvancedParams && (
        <>
          <Section>
            <SectionTitle>
              <Sparkles size={14} />
              <span>{t('chat.input.gpt_image.quality.label', { defaultValue: '图片质量' })}</span>
            </SectionTitle>
            <ChipGrid>
              {GPT_IMAGE_QUALITIES.map((quality) => (
                <Chip
                  key={quality}
                  type="button"
                  data-active={currentQuality === quality}
                  onClick={() => updateGptImage({ quality })}>
                  {qualityLabel(quality)}
                </Chip>
              ))}
            </ChipGrid>
          </Section>

          <Section>
            <SectionTitle>
              <Hash size={14} />
              <span>{t('chat.input.gpt_image.output_count.label', { defaultValue: '输出数量' })}</span>
            </SectionTitle>
            <ChipGrid>
              {(supportsMultipleOutputs ? GPT_IMAGE_OUTPUT_COUNTS : [1]).map((count) => (
                <Chip
                  key={count}
                  type="button"
                  data-active={currentOutputCount === count}
                  onClick={() => updateGptImage({ n: count })}>
                  {t('chat.input.gpt_image.output_count.value', { count, defaultValue: '{{count}} 张' })}
                </Chip>
              ))}
            </ChipGrid>
          </Section>
        </>
      )}
    </PanelRoot>
  )

  const ariaLabel = t('chat.input.gpt_image.label', { defaultValue: '生图参数' })
  const tooltipTitle = supportsAdvancedParams
    ? `${ariaLabel}  ${computedSize} · ${qualityLabel(currentQuality)} · ${currentOutputCount}`
    : `${ariaLabel}  ${computedSize}`
  const active =
    computedSize !== 'auto' ||
    (currentTier !== 'auto' && currentAspectRatio === 'auto') ||
    (supportsNanoWebSearch && currentEnableWebSearch) ||
    (supportsAdvancedParams && (currentQuality !== 'auto' || currentOutputCount !== 1))

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="top"
      arrow={false}
      destroyTooltipOnHide
      overlayClassName="gpt-image-settings-popover"
      content={popoverContent}>
      <Tooltip placement="top" title={open ? undefined : tooltipTitle} mouseLeaveDelay={0} arrow>
        <ActionIconButton active={active} aria-label={ariaLabel} aria-pressed={active}>
          <ImageIcon size={18} />
        </ActionIconButton>
      </Tooltip>
    </Popover>
  )
}

export default GptImageSettingsButton

const PanelRoot = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 280px;
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

const HintBar = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
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

const WebSearchRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`

const WebSearchHint = styled.div`
  font-size: 11px;
  color: var(--color-text-secondary);
  opacity: 0.85;
  line-height: 1.35;
  padding-left: 20px;
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
  user-select: none;

  &:hover {
    background: var(--color-background-mute, var(--color-background-soft));
    border-color: var(--color-primary, #6366f1);
  }

  &[data-active='true'] {
    color: #fff;
    background: var(--color-primary, #6366f1);
    border-color: var(--color-primary, #6366f1);
  }
`
