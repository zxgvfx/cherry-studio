import { useAgents, useUpdateAgent } from '@renderer/hooks/agent/useAgent'
import AiPipelinePage from '@renderer/pages/aiPipeline/AiPipelinePage'
import { cn } from '@renderer/utils/style'
import { type ReactElement, useEffect, useRef, useState } from 'react'

import { DccAgentChat } from './lite/DccAgentChat'

type DccContext = {
  dcc?: string
  dccType?: string
  dccVersion?: string
  hipFile?: string
  scenePath?: string
  currentNetwork?: string
  selectedNodes?: Array<string | { path?: string; name?: string; type?: string }>
  available?: boolean
  error?: string
}

type PanelTab = 'chat' | 'canvas'

function runtimeInfo(): { backendUrl: string; sessionId: string; dccType: string } {
  const win = window as Window & {
    __CHERRY_BACKEND_URL?: string
    __CHERRY_SESSION_ID?: string
    __CHERRY_DCC_TYPE?: string
  }
  return {
    backendUrl: (win.__CHERRY_BACKEND_URL || '').replace(/\/$/, ''),
    sessionId: win.__CHERRY_SESSION_ID || '',
    dccType: win.__CHERRY_DCC_TYPE || 'dcc'
  }
}

function selectedLabel(node: string | { path?: string; name?: string; type?: string }): string {
  if (typeof node === 'string') return node
  return node.path || node.name || node.type || '?'
}

function readBoundDccSession(agent: { configuration?: unknown }): string {
  const configuration = agent.configuration as { coco_dcc?: { sessionId?: string } } | undefined
  return configuration?.coco_dcc?.sessionId || ''
}

/** This window is one Houdini/Maya session — stamp it onto agents so DCC tools keep routing. */
function useBindDccAgentSession(dccSessionId: string, dccType: string): void {
  const { agents, isLoading } = useAgents()
  const { updateAgent } = useUpdateAgent()
  const inflightRef = useRef<string | null>(null)

  useEffect(() => {
    if (!dccSessionId || isLoading) return
    const cocoAgents = agents.filter((agent) => agent.type === 'coco')
    const pool = cocoAgents.length > 0 ? cocoAgents : agents
    const next = pool.find((agent) => readBoundDccSession(agent) !== dccSessionId)
    if (!next || inflightRef.current === next.id) return
    inflightRef.current = next.id
    void updateAgent(
      { id: next.id, configuration: { coco_dcc: { sessionId: dccSessionId, dccType } } },
      { showSuccessToast: false }
    ).finally(() => {
      if (inflightRef.current === next.id) inflightRef.current = null
    })
  }, [agents, dccSessionId, dccType, isLoading, updateAgent])
}

export function DccPanel(): ReactElement {
  const { backendUrl, sessionId: dccSessionId, dccType } = runtimeInfo()
  const [tab, setTab] = useState<PanelTab>('chat')
  const [ctx, setCtx] = useState<DccContext | null>(null)
  useBindDccAgentSession(dccSessionId, dccType)

  useEffect(() => {
    if (!backendUrl || !dccSessionId) return
    let cancelled = false
    const pull = async () => {
      try {
        const response = await fetch(`${backendUrl}/api/v1/dcc/context?sessionId=${encodeURIComponent(dccSessionId)}`)
        const data = (await response.json()) as DccContext
        if (!cancelled) setCtx(data)
      } catch (error) {
        if (!cancelled) setCtx({ available: false, error: String(error), dccType })
      }
    }
    void pull()
    const timer = window.setInterval(() => void pull(), 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [backendUrl, dccSessionId, dccType])

  const fileLabel = ctx?.hipFile || ctx?.scenePath || '未打开文件'
  const selected = (ctx?.selectedNodes || []).slice(0, 4).map(selectedLabel)
  const displayDcc = ctx?.dccType || ctx?.dcc || dccType

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <nav className="flex shrink-0 gap-0.5">
          {(
            [
              ['chat', '对话'],
              ['canvas', '画布']
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cn(
                'rounded-md px-2.5 py-1 text-sm',
                tab === id ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60'
              )}
              onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {displayDcc}
          {ctx?.dccVersion ? ` ${ctx.dccVersion}` : ''}
          <span className="px-1">·</span>
          {fileLabel}
        </div>
        <div className="flex max-w-[40%] flex-wrap justify-end gap-1">
          {selected.map((label) => (
            <span key={label} className="rounded-full bg-muted px-2 py-0.5 text-[11px]">
              {label}
            </span>
          ))}
          {ctx?.available === false ? (
            <span className="text-[11px] text-destructive">{ctx.error || 'DCC 未连接'}</span>
          ) : null}
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className={cn('flex h-full min-h-0 min-w-0 flex-1', tab !== 'chat' && 'hidden')}>
          <DccAgentChat />
        </div>
        {tab === 'canvas' ? <AiPipelinePage /> : null}
      </div>
    </div>
  )
}
