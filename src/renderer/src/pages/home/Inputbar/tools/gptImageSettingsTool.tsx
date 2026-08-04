import { loggerService } from '@logger'
import { isGptImageModel } from '@renderer/config/models/vision'
import GptImageSettingsButton from '@renderer/pages/home/Inputbar/tools/components/GptImageSettingsButton'
import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'

const logger = loggerService.withContext('gptImageSettingsTool')

// 同一个 model id 只打一次，避免 condition 在 useMemo 里反复评估时刷屏
let lastEvaluatedModelId: string | null = null

/**
 * image-generation 端点参数控制器。
 *
 * gpt-image 与 image-generation 端点模型均显示（含中心化 nano-banana）。
 * 用户选择的 size / quality 等通过 `assistant.settings.gptImage` 持久化，
 * 实际请求由 `ImageGenerationMiddleware` 在调用 `sdk.images.generate` / `sdk.images.edit`
 * 时注入到请求体。
 *
 * 文档参考：
 *   - 文生图 https://api-gpt-ge.apifox.cn/288964677e0
 *   - 图生图 https://api-gpt-ge.apifox.cn/210463340e0
 */
const gptImageSettingsTool = defineTool({
  key: 'gpt_image_settings',
  label: (t) => t('chat.input.gpt_image.label', { defaultValue: '生图参数' }),
  visibleInScopes: [TopicType.Chat],
  condition: ({ model }) => {
    const matched = isGptImageModel(model) || (!!model && model.endpoint_type === 'image-generation')
    if (model?.id !== lastEvaluatedModelId) {
      lastEvaluatedModelId = model?.id ?? null
      logger.info(
        `[condition] model.id=${model?.id ?? '<none>'} → ${matched ? 'SHOW image settings button' : 'hide (not image-generation)'}`
      )
    }
    return matched
  },
  render: ({ assistant, model, quickPanel }) => (
    <GptImageSettingsButton quickPanel={quickPanel} model={model} assistantId={assistant.id} />
  )
})

registerTool(gptImageSettingsTool)

export default gptImageSettingsTool
