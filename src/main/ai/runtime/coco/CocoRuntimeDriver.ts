import { application } from '@application'
import { agentService } from '@data/services/AgentService'
import { mcpServerService } from '@data/services/McpServerService'
import { listCherryBuiltinTools } from '@main/ai/mcp/servers/cherryBuiltinTools'
import { buildPiMcpToolName } from '@main/ai/runtime/pi/piMcpToolAdapter'
import {
  CHERRY_BUILTIN_APPROVAL_REQUIRED_TOOL_NAMES,
  toCherryBuiltinRuntimeName
} from '@main/ai/runtime/toolApproval/cherryBuiltinApproval'
import type { Tool } from '@shared/ai/tool'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'

import type { AgentRuntimeConnectInput, AgentRuntimeConnection, AgentSessionRuntimeDriver } from '../types'
import { CocoRuntimeConnection } from './CocoRuntimeConnection'

export class CocoRuntimeDriver implements AgentSessionRuntimeDriver {
  readonly type = 'coco'
  readonly capabilities = ['agent-session'] as const

  async validateSession(session: AgentSessionEntity): Promise<void> {
    if (!session.agentId) {
      throw new Error(`coco agent session ${session.id} has no agent`)
    }
    const agent = agentService.getAgent(session.agentId)
    if (!agent) {
      throw new Error(`coco agent not found for session ${session.id}: ${session.agentId}`)
    }
    if (!agent.model) {
      throw new Error(`coco agent ${session.agentId} has no model configured`)
    }
  }

  async listAvailableTools(mcpIds: string[]): Promise<Tool[]> {
    const approvalRequired = new Set(CHERRY_BUILTIN_APPROVAL_REQUIRED_TOOL_NAMES)
    const builtins: Tool[] = listCherryBuiltinTools().map((tool) => ({
      id: toCherryBuiltinRuntimeName(tool.name),
      name: tool.name,
      description: tool.description,
      origin: 'builtin',
      approval: approvalRequired.has(tool.name) ? 'prompt' : 'auto',
      sourceId: 'cherry-tools',
      sourceName: 'Cherry Studio'
    }))
    const catalog = application.get('McpCatalogService')
    const mcpTools: Tool[] = mcpIds.flatMap((idOrName) => {
      const server = mcpServerService.findByIdOrName(idOrName)
      if (!server) return []
      return catalog.listTools(server.id, { includeDisabled: false }).map((tool) => ({
        id: buildPiMcpToolName(server.name, tool.name),
        name: tool.name,
        origin: 'mcp' as const,
        approval: 'prompt' as const,
        sourceId: server.id,
        sourceName: server.name
      }))
    })
    return [...builtins, ...mcpTools]
  }

  connect(input: AgentRuntimeConnectInput): Promise<AgentRuntimeConnection> {
    return new CocoRuntimeConnection(input).start()
  }
}
