import type { TopicMessageFlowGraph, TopicMessageFlowGraphNode } from '@renderer/components/chat/flow'
import type { AgentSessionMessageEntity } from '@shared/data/api/schemas/agentSessionMessages'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'

interface BuildAgentSessionBranchFlowInput {
  activeSessionId: string
  messagesBySession: ReadonlyMap<string, readonly AgentSessionMessageEntity[]>
  sessions: readonly AgentSessionEntity[]
}

function compareMessages(left: AgentSessionMessageEntity, right: AgentSessionMessageEntity): number {
  const createdAt = Date.parse(left.createdAt) - Date.parse(right.createdAt)
  return createdAt || left.id.localeCompare(right.id)
}

function countBranchPaths(nodes: readonly TopicMessageFlowGraphNode[]): number {
  if (nodes.length === 0) return 0
  const parentIds = new Set(nodes.flatMap((node) => (node.parentId ? [node.parentId] : [])))
  const leafCount = nodes.filter((node) => !parentIds.has(node.id)).length
  return leafCount > 1 ? leafCount : 0
}

export function buildAgentSessionBranchFlowGraph({
  activeSessionId,
  messagesBySession,
  sessions
}: BuildAgentSessionBranchFlowInput): TopicMessageFlowGraph {
  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  const sortedMessages = new Map(
    sessions.map((session) => [session.id, [...(messagesBySession.get(session.id) ?? [])].sort(compareMessages)])
  )
  const localToCanonicalBySession = new Map<string, Map<string, string>>()
  const nodes: TopicMessageFlowGraphNode[] = []
  const ownerByNodeId = new Map<string, string>()
  const processed = new Set<string>()

  const appendSession = (session: AgentSessionEntity): void => {
    if (processed.has(session.id)) return
    const parent = session.branchParentId ? sessionById.get(session.branchParentId) : undefined
    if (parent) appendSession(parent)

    const messages = sortedMessages.get(session.id) ?? []
    const localToCanonical = new Map<string, string>()
    let prefixLength = 0
    let parentNodeId: string | null = null

    if (parent) {
      const parentMessages = sortedMessages.get(parent.id) ?? []
      const parentMapping = localToCanonicalBySession.get(parent.id) ?? new Map<string, string>()
      const branchPointIndex = parentMessages.findIndex((message) => message.id === session.branchPointMessageId)
      prefixLength = branchPointIndex >= 0 ? branchPointIndex : 0

      for (let index = 0; index < Math.min(prefixLength, messages.length); index += 1) {
        const canonicalId = parentMapping.get(parentMessages[index]?.id ?? '')
        if (canonicalId) localToCanonical.set(messages[index].id, canonicalId)
      }
      if (prefixLength > 0) {
        parentNodeId = parentMapping.get(parentMessages[prefixLength - 1]?.id ?? '') ?? null
      }
    }

    for (const message of messages.slice(prefixLength)) {
      localToCanonical.set(message.id, message.id)
      ownerByNodeId.set(message.id, session.id)
      nodes.push({
        id: message.id,
        parentId: parentNodeId,
        data: {
          messageId: message.id,
          role: message.role,
          status: message.status,
          preview: message.searchableText,
          modelId: message.modelId,
          createdAt: message.createdAt,
          isActive: false,
          isOnActivePath: false,
          isInactiveBranch: false,
          agentSessionId: session.id,
          disablePreview: true
        }
      })
      parentNodeId = message.id
    }

    if (parent && messages.length === prefixLength) {
      const awaitingNodeId = `agent-branch:${session.id}`
      ownerByNodeId.set(awaitingNodeId, session.id)
      nodes.push({
        id: awaitingNodeId,
        parentId: parentNodeId,
        data: {
          messageId: awaitingNodeId,
          role: 'user',
          status: 'paused',
          preview: '',
          createdAt: session.createdAt,
          isActive: false,
          isOnActivePath: false,
          isInactiveBranch: false,
          isAwaitingInput: true,
          agentSessionId: session.id,
          disablePreview: true
        }
      })
      localToCanonical.set(awaitingNodeId, awaitingNodeId)
    }

    localToCanonicalBySession.set(session.id, localToCanonical)
    processed.add(session.id)
  }

  for (const session of [...sessions].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    appendSession(session)
  }

  const activeMessages = sortedMessages.get(activeSessionId) ?? []
  const activeMapping = localToCanonicalBySession.get(activeSessionId) ?? new Map<string, string>()
  const activePath = new Set(
    activeMessages.flatMap((message) => {
      const canonicalId = activeMapping.get(message.id)
      return canonicalId ? [canonicalId] : []
    })
  )
  const activeAwaitingNodeId = `agent-branch:${activeSessionId}`
  if (ownerByNodeId.has(activeAwaitingNodeId)) activePath.add(activeAwaitingNodeId)
  const activeNodeId = [...activePath].at(-1) ?? null
  const childCounts = new Map<string, number>()
  for (const node of nodes) {
    if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1)
    node.data.isActive = node.id === activeNodeId
    node.data.isOnActivePath = activePath.has(node.id)
    node.data.isInactiveBranch = activePath.size > 0 && !activePath.has(node.id)
  }

  const edges = nodes.flatMap((node) => {
    if (!node.parentId) return []
    const isActivePath = activePath.has(node.parentId) && activePath.has(node.id)
    return [
      {
        id: `edge:${node.parentId}:${node.id}`,
        source: node.parentId,
        target: node.id,
        data: {
          isActivePath,
          isSiblingBranch: (childCounts.get(node.parentId) ?? 0) > 1,
          isInactiveBranch: activePath.size > 0 && !activePath.has(node.id)
        }
      }
    ]
  })

  return {
    nodes,
    edges,
    activeNodeId,
    stats: {
      nodeCount: nodes.length,
      branchCount: countBranchPaths(nodes),
      activePathLength: activePath.size
    }
  }
}
