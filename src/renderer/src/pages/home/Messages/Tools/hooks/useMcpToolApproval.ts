import { useActiveAgent } from '@renderer/hooks/agents/useActiveAgent'
import { useMCPServers } from '@renderer/hooks/useMCPServers'
import type { MCPServer, MCPToolResponse } from '@renderer/types'
import type { ToolMessageBlock } from '@renderer/types/newMessage'
import { isToolAutoApproved } from '@renderer/utils/mcp-tools'
import {
  cancelToolAction,
  confirmAllPendingTools,
  confirmToolAction,
  isSessionAutoApproveAll,
  isToolPending,
  onSessionAutoApproveChange,
  onToolPendingChange,
  setSessionAutoApproveAll
} from '@renderer/utils/userConfirmation'
import { useCallback, useEffect, useReducer, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ToolApprovalActions, ToolApprovalState } from './useToolApproval'

/**
 * Resolve a hub tool (invoke/exec) to the underlying server and tool name.
 * Returns null if the tool is not a hub tool or resolution fails.
 */
async function resolveHubToolServer(
  tool: { serverId: string; name: string },
  toolResponse: MCPToolResponse | undefined,
  mcpServers: MCPServer[]
): Promise<{ server: MCPServer; toolName: string } | null> {
  if (tool.serverId !== 'hub' || (tool.name !== 'invoke' && tool.name !== 'exec')) {
    return null
  }
  const toolArgs = toolResponse?.arguments as Record<string, unknown> | undefined
  const underlyingToolName = toolArgs?.name as string | undefined
  if (!underlyingToolName) return null

  try {
    const resolved = await window.api.mcp.resolveHubTool(underlyingToolName)
    if (!resolved) return null
    const server = mcpServers.find((s) => s.id === resolved.serverId)
    if (!server) return null
    return { server, toolName: resolved.toolName }
  } catch {
    return null
  }
}

/**
 * Hook for MCP tool approval logic
 * Extracts approval state management from MessageMcpTool
 */
export function useMcpToolApproval(block: ToolMessageBlock): ToolApprovalState & ToolApprovalActions {
  const { t } = useTranslation()
  const { mcpServers } = useMCPServers()
  const { agent } = useActiveAgent()

  const toolResponse = block.metadata?.rawMcpToolResponse as MCPToolResponse | undefined
  const tool = toolResponse?.tool
  const id = toolResponse?.id ?? ''
  const status = toolResponse?.status

  const [, forceUpdate] = useReducer((x: number) => x + 1, 0)

  // Re-render when requestToolConfirmation() is called for this tool
  useEffect(() => {
    if (!id) return
    return onToolPendingChange((toolId) => {
      if (toolId === id) forceUpdate()
    })
  }, [id])

  // Re-render when the session-level auto-approve flag changes
  useEffect(() => {
    return onSessionAutoApproveChange(() => forceUpdate())
  }, [])

  const isPending = status === 'pending' || (status === 'streaming' && !!id && isToolPending(id))

  // For hub invoke/exec tools, resolve the underlying server asynchronously
  const [hubResolvedAutoApproved, setHubResolvedAutoApproved] = useState(false)
  useEffect(() => {
    if (!tool || tool.serverId !== 'hub' || (tool.name !== 'invoke' && tool.name !== 'exec')) {
      setHubResolvedAutoApproved(false)
      return
    }
    let cancelled = false
    resolveHubToolServer(tool, toolResponse, mcpServers).then((result) => {
      if (cancelled) return
      if (result) {
        setHubResolvedAutoApproved(!result.server.disabledAutoApproveTools?.includes(result.toolName))
      } else {
        setHubResolvedAutoApproved(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [tool, toolResponse, mcpServers])

  const isAutoApproved = (() => {
    if (isSessionAutoApproveAll()) return true
    if (!tool) return false
    const basicApproved = isToolAutoApproved(
      tool,
      mcpServers.find((s) => s.id === tool.serverId),
      agent?.allowed_tools
    )
    if (basicApproved) return true
    return hubResolvedAutoApproved
  })()

  const [isConfirmed, setIsConfirmed] = useState(isAutoApproved)

  const isWaiting = isPending && !isAutoApproved && !isConfirmed
  const isExecuting = isPending && (isAutoApproved || isConfirmed)

  const confirm = useCallback(() => {
    setIsConfirmed(true)
    confirmToolAction(id)
  }, [id])

  const cancel = useCallback(() => {
    cancelToolAction(id)
  }, [id])

  const autoApprove = useCallback(() => {
    setSessionAutoApproveAll(true)
    setIsConfirmed(true)
    confirmToolAction(id)
    confirmAllPendingTools()
    window.toast.success(t('message.tools.autoApproveEnabled', 'Auto-approve enabled for this tool'))
  }, [id, t])

  return {
    isWaiting,
    isExecuting,
    isSubmitting: false,
    input: undefined,
    confirm,
    cancel,
    autoApprove: isWaiting ? autoApprove : undefined
  }
}
