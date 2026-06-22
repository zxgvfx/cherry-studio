import { isGenerateMotionModel } from '@renderer/config/models/vision'
import { useAssistant } from '@renderer/hooks/useAssistant'
import MotionSettingsButton from '@renderer/pages/home/Inputbar/tools/components/MotionSettingsButton'
import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'
import { useCallback } from 'react'

const MotionSettingsTool = ({ context }) => {
  const { assistant } = context
  const { updateAssistant } = useAssistant(assistant.id)

  const handleUpdate = useCallback(
    (values: { motionCount?: number; motionDuration?: number }) => {
      updateAssistant({ ...assistant, ...values })
    },
    [assistant, updateAssistant]
  )

  return <MotionSettingsButton assistant={assistant} onUpdate={handleUpdate} />
}

const motionSettingsTool = defineTool({
  key: 'motion_settings',
  label: (t) => t('motion.settings.title', 'Motion Settings'),
  visibleInScopes: [TopicType.Chat],
  condition: ({ model }) => isGenerateMotionModel(model),
  render: (context) => <MotionSettingsTool context={context} />
})

registerTool(motionSettingsTool)

export default motionSettingsTool
