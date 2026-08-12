import AiPipelinePage from '@renderer/pages/aiPipeline/AiPipelinePage'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/app/ai-pipeline')({
  component: AiPipelinePage
})
