import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@cherrystudio/ui'
import {
  COCO_MODE_CARDS,
  COCO_PERMISSION_CARDS,
  type CocoAgentMode,
  type CocoAgentPermission
} from '@shared/ai/cocoAgent'
import { type Control, type FieldValues, type Path } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

type CocoSettingsFieldsProps<TFieldValues extends FieldValues> = {
  control: Control<TFieldValues>
  mode: CocoAgentMode
  permission: CocoAgentPermission
  onModeChange: (value: CocoAgentMode) => void
  onPermissionChange: (value: CocoAgentPermission) => void
  portalContainer?: HTMLElement | null
  layout?: 'stack' | 'row'
  labelClassName?: string
  rowClassName?: string
}

export function CocoSettingsFields<TFieldValues extends FieldValues>({
  control,
  mode,
  permission,
  onModeChange,
  onPermissionChange,
  portalContainer,
  layout = 'stack',
  labelClassName,
  rowClassName
}: CocoSettingsFieldsProps<TFieldValues>) {
  const { t } = useTranslation()
  const modeCard = COCO_MODE_CARDS.find((card) => card.value === mode) ?? COCO_MODE_CARDS[0]
  const permissionCard = COCO_PERMISSION_CARDS.find((card) => card.value === permission) ?? COCO_PERMISSION_CARDS[0]
  const itemClassName = layout === 'row' ? rowClassName : undefined

  return (
    <>
      <FormField
        control={control}
        name={'cocoMode' as Path<TFieldValues>}
        render={() => (
          <FormItem className={itemClassName}>
            <FormLabel className={labelClassName}>{t('library.config.agent.field.coco_mode.label', 'Mode')}</FormLabel>
            <Select value={mode} onValueChange={(value) => onModeChange(value as CocoAgentMode)}>
              <FormControl>
                <SelectTrigger
                  className="h-9 w-full rounded-md"
                  aria-label={t('library.config.agent.field.coco_mode.label', 'Mode')}>
                  <SelectValue>{t(modeCard.labelKey, modeCard.labelFallback)}</SelectValue>
                </SelectTrigger>
              </FormControl>
              <SelectContent portalContainer={portalContainer ?? undefined}>
                {COCO_MODE_CARDS.map((card) => (
                  <SelectItem key={card.value} value={card.value}>
                    {t(card.labelKey, card.labelFallback)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormDescription className="text-xs">
              {t(modeCard.descriptionKey, modeCard.descriptionFallback)}
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={control}
        name={'cocoPermission' as Path<TFieldValues>}
        render={() => (
          <FormItem className={itemClassName}>
            <FormLabel className={labelClassName}>
              {t('library.config.agent.field.coco_permission.label', 'Canvas permission')}
            </FormLabel>
            <Select value={permission} onValueChange={(value) => onPermissionChange(value as CocoAgentPermission)}>
              <FormControl>
                <SelectTrigger
                  className="h-9 w-full rounded-md"
                  aria-label={t('library.config.agent.field.coco_permission.label', 'Canvas permission')}>
                  <SelectValue>{t(permissionCard.labelKey, permissionCard.labelFallback)}</SelectValue>
                </SelectTrigger>
              </FormControl>
              <SelectContent portalContainer={portalContainer ?? undefined}>
                {COCO_PERMISSION_CARDS.map((card) => (
                  <SelectItem key={card.value} value={card.value}>
                    {t(card.labelKey, card.labelFallback)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormDescription className="text-xs">
              {t(permissionCard.descriptionKey, permissionCard.descriptionFallback)}
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  )
}
