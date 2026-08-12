import { useMemo } from 'react'

const PIPELINE_UI_PATH = '/plugins-ui/ai-pipeline-bridge/'

/**
 * Built-in AI Pipeline workspace.
 *
 * Workflow discovery, launch forms, HITL review, and delivery remain owned by
 * ai-pipeline. Cherry only provides the stable navigation surface and embeds
 * the same-origin bridge UI, so adding a workflow never requires another
 * sidebar icon or renderer release.
 */
export default function AiPipelinePage() {
  const src = useMemo(() => {
    const runtime = window as Window & { __CHERRY_BACKEND_URL?: string }
    const origin = runtime.__CHERRY_BACKEND_URL?.replace(/\/$/, '') || window.location.origin
    return `${origin}${PIPELINE_UI_PATH}`
  }, [])

  return (
    <div className="flex h-full min-h-0 w-full flex-1 bg-background">
      <iframe
        title="AI Pipeline"
        src={src}
        className="h-full min-h-0 w-full flex-1 border-0 bg-background"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </div>
  )
}
