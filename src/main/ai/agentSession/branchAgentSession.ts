import { agentService } from '@data/services/AgentService'
import { agentSessionMessageService } from '@data/services/AgentSessionMessageService'
import { agentSessionService } from '@data/services/AgentSessionService'
import { branchPipelineSession } from '@main/ai/runtime/coco/pipelineClient'
import { AGENT_WORKSPACE_TYPE } from '@shared/data/api/schemas/agentWorkspaces'
import type { BranchAgentSessionCommand } from '@shared/ipc/schemas/ai'

export async function branchAgentSession(command: BranchAgentSessionCommand) {
  const source = agentSessionService.getById(command.sessionId)
  if (!source.agentId) throw new Error('Cannot branch a session whose agent was deleted')
  const agent = agentService.getAgent(source.agentId)
  if (!agent) throw new Error('Agent not found')

  const branched = agentSessionService.create({
    agentId: source.agentId,
    name: source.name,
    description: source.description,
    workspace:
      source.workspace.type === AGENT_WORKSPACE_TYPE.SYSTEM
        ? { type: AGENT_WORKSPACE_TYPE.SYSTEM }
        : { type: AGENT_WORKSPACE_TYPE.USER, workspaceId: source.workspaceId }
  })

  try {
    agentSessionService.markAsBranch(branched.id, source.id, command.messageId)
    const branchHistory = agentSessionMessageService.branchSessionMessages(source.id, command.messageId, branched.id)
    await branchPipelineSession(agent, source.id, branched, branchHistory.priorUserTurns)
    return agentSessionService.getById(branched.id)
  } catch (error) {
    agentSessionService.delete(branched.id)
    throw error
  }
}
