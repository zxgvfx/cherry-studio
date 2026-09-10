import type { ComposerQueuedMessagePayload } from '@shared/ai/transport'

const pendingBranchSends = new Map<string, ComposerQueuedMessagePayload>()

export function queuePendingAgentBranchSend(sessionId: string, payload: ComposerQueuedMessagePayload): void {
  pendingBranchSends.set(sessionId, payload)
}

export function takePendingAgentBranchSend(sessionId: string): ComposerQueuedMessagePayload | undefined {
  const payload = pendingBranchSends.get(sessionId)
  pendingBranchSends.delete(sessionId)
  return payload
}

export function discardPendingAgentBranchSend(sessionId: string): void {
  pendingBranchSends.delete(sessionId)
}
