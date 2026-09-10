import { Button } from '@cherrystudio/ui'
import { ToolHeader } from '@renderer/components/chat/messages/tools/shared/GenericTools'
import type { ToolDisclosureItem } from '@renderer/components/chat/messages/tools/shared/ToolDisclosure'
import { useAgent } from '@renderer/hooks/agent/useAgent'
import { useSession } from '@renderer/hooks/agent/useSession'
import { toast } from '@renderer/services/toast'
import { cocoAgentProxy } from '@renderer/utils/cocoAgentProxy'
import { readCocoPermission } from '@shared/ai/cocoAgent'
import { useSearch } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

const SCRIPT_PROPOSE_TOOLS = new Set(['script.propose', 'graph_proposal'])

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function extractProposal(
  input: unknown,
  output: unknown
): {
  unifiedDiff: string
  afterScript: string
  workflow: Record<string, unknown> | null
  applied: boolean
} {
  const outputRecord = asRecord(output)
  const result = asRecord(outputRecord?.result) ?? outputRecord
  const changeSet = asRecord(result?.change_set) ?? asRecord(outputRecord?.change_set)
  const inputRecord = asRecord(input)
  const unifiedDiff = String(changeSet?.unified_diff || result?.unified_diff || outputRecord?.unified_diff || '')
  const afterScript = String(
    changeSet?.after_script || result?.normalized_script || result?.after_script || inputRecord?.source || ''
  )
  const workflow = asRecord(result?.workflow) ?? asRecord(outputRecord?.workflow)
  return {
    unifiedDiff,
    afterScript,
    workflow,
    applied: Boolean(result?.applied ?? outputRecord?.applied)
  }
}

async function proxyAgentCall(method: string, path: string, body?: unknown): Promise<unknown> {
  return cocoAgentProxy(method, path, body)
}

export function isCocoScriptProposeTool(toolName: string | undefined): boolean {
  if (!toolName) return false
  return SCRIPT_PROPOSE_TOOLS.has(toolName) || toolName.endsWith('script.propose')
}

export function ScriptProposeTool({
  toolName,
  input,
  output
}: {
  toolName: string
  input?: unknown
  output?: unknown
}): ToolDisclosureItem {
  const { t } = useTranslation()
  const search = useSearch({ strict: false }) as { sessionId?: string }
  const sessionId = typeof search.sessionId === 'string' ? search.sessionId : ''
  const { session } = useSession(sessionId || null)
  const agentId = session?.agentId ?? ''
  const { agent } = useAgent(agentId)
  const [busy, setBusy] = useState(false)
  const [appliedLocal, setAppliedLocal] = useState(false)
  const proposal = useMemo(() => extractProposal(input, output), [input, output])
  const cocoPermission = readCocoPermission(agent?.configuration)
  const canApply =
    agent?.type === 'coco' &&
    cocoPermission === 'ask' &&
    Boolean(agentId && sessionId && (proposal.workflow || proposal.afterScript) && !proposal.applied && !appliedLocal)

  const handleApply = useCallback(async () => {
    if (!agentId || !sessionId) return
    setBusy(true)
    try {
      await proxyAgentCall(
        'POST',
        `/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/coco/apply`,
        { graph: proposal.workflow, after_script: proposal.afterScript }
      )
      setAppliedLocal(true)
      toast.success(t('library.config.agent.coco.proposal.applied', 'Canvas updated'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [agentId, proposal.afterScript, proposal.workflow, sessionId, t])

  const handleReject = useCallback(async () => {
    if (!agentId || !sessionId) return
    setBusy(true)
    try {
      await proxyAgentCall(
        'POST',
        `/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/coco/reject`,
        {}
      )
      toast.success(t('library.config.agent.coco.proposal.rejected', 'Proposal discarded'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [agentId, sessionId, t])

  return {
    key: toolName,
    label: (
      <ToolHeader
        label={t('library.config.agent.coco.proposal.label', 'Pipeline Script proposal')}
        toolName={toolName}
        variant="collapse-label"
        showStatus={false}
      />
    ),
    children: (
      <div className="flex flex-col gap-2 py-1">
        {proposal.unifiedDiff ? (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-4">
            {proposal.unifiedDiff}
          </pre>
        ) : (
          <p className="text-muted-foreground text-xs">
            {t('library.config.agent.coco.proposal.empty_diff', 'No script diff in this result.')}
          </p>
        )}
        {canApply ? (
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void handleApply()}>
              {t('library.config.agent.coco.proposal.apply', 'Apply to session canvas')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void handleReject()}>
              {t('library.config.agent.coco.proposal.reject', 'Reject')}
            </Button>
          </div>
        ) : null}
        {proposal.applied || appliedLocal ? (
          <p className="text-muted-foreground text-xs">
            {t('library.config.agent.coco.proposal.auto_applied', 'Applied to this COCO session canvas.')}
          </p>
        ) : null}
      </div>
    )
  }
}
