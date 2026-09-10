import {
  discardPendingAgentBranchSend,
  queuePendingAgentBranchSend,
  takePendingAgentBranchSend
} from '@renderer/utils/pendingAgentBranchSend'
import type { ComposerQueuedMessagePayload } from '@shared/ai/transport'
import { describe, expect, it } from 'vitest'

const payload = {
  text: 'corrected request',
  userMessageParts: [{ type: 'text', text: 'corrected request' }],
  attachments: []
} as ComposerQueuedMessagePayload

describe('pendingAgentBranchSend', () => {
  it('hands an edited payload to the branched session exactly once', () => {
    queuePendingAgentBranchSend('branch-1', payload)

    expect(takePendingAgentBranchSend('branch-1')).toBe(payload)
    expect(takePendingAgentBranchSend('branch-1')).toBeUndefined()
  })

  it('discards a payload when branch navigation fails', () => {
    queuePendingAgentBranchSend('branch-2', payload)
    discardPendingAgentBranchSend('branch-2')

    expect(takePendingAgentBranchSend('branch-2')).toBeUndefined()
  })
})
