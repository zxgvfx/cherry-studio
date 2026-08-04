import { loggerService } from '@logger'
import { isGenerateVideoModel } from '@renderer/config/models/vision'
import VideoGenSettingsButton from '@renderer/pages/home/Inputbar/tools/components/VideoGenSettingsButton'
import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'

const logger = loggerService.withContext('videoGenSettingsTool')

let lastEvaluatedModelId: string | null = null

/**
 * Atlas Seedance 等文生视频参数控制器。
 * 设置写入 assistant.settings.videoGen，由 ApiService.handleVideoGeneration 提交给本地 BE。
 */
const videoGenSettingsTool = defineTool({
  key: 'video_gen_settings',
  label: (t) => t('chat.input.video_gen.label', { defaultValue: '视频参数' }),
  visibleInScopes: [TopicType.Chat],
  condition: ({ model }) => {
    const matched = isGenerateVideoModel(model)
    if (model?.id !== lastEvaluatedModelId) {
      lastEvaluatedModelId = model?.id ?? null
      logger.info(`[condition] model.id=${model?.id ?? '<none>'} → ${matched ? 'SHOW video settings button' : 'hide'}`)
    }
    return matched
  },
  render: ({ assistant, quickPanel }) => <VideoGenSettingsButton quickPanel={quickPanel} assistantId={assistant.id} />
})

registerTool(videoGenSettingsTool)

export default videoGenSettingsTool
