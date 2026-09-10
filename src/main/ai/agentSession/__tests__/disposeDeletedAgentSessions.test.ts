import { beforeEach, describe, expect, it, vi } from 'vitest'

const { abortMock, closeSessionMock, approvalAbortMock } = vi.hoisted(() => ({
  abortMock: vi.fn(),
  closeSessionMock: vi.fn(),
  approvalAbortMock: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    })
  }
}))

vi.mock('@application', () => ({
  application: {
    get: (name: string) => {
      if (name === 'AiStreamManager') return { abort: abortMock }
      if (name === 'AgentSessionRuntimeService') return { closeSession: closeSessionMock }
      throw new Error(`unexpected service ${name}`)
    }
  }
}))

vi.mock('@main/ai/runtime/toolApproval/ToolApprovalRegistry', () => ({
  toolApprovalRegistry: { abort: approvalAbortMock }
}))

import { abortDeletedTopicStreams, disposeDeletedAgentSessions } from '../disposeDeletedAgentSessions'

describe('disposeDeletedAgentSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('aborts the stream, closes the runtime, and cancels approvals before the row is gone', () => {
    disposeDeletedAgentSessions(['session-a', 'session-b'])

    expect(abortMock).toHaveBeenCalledWith('agent-session:session-a', 'session-deleted')
    expect(abortMock).toHaveBeenCalledWith('agent-session:session-b', 'session-deleted')
    expect(closeSessionMock).toHaveBeenCalledWith('session-a')
    expect(closeSessionMock).toHaveBeenCalledWith('session-b')
    expect(approvalAbortMock).toHaveBeenCalledWith('session-a', 'session-deleted')
    expect(approvalAbortMock).toHaveBeenCalledWith('session-b', 'session-deleted')
  })

  it('is a no-op for an empty id list', () => {
    disposeDeletedAgentSessions([])
    expect(abortMock).not.toHaveBeenCalled()
    expect(closeSessionMock).not.toHaveBeenCalled()
  })

  it('keeps disposing later ids when one abort throws', () => {
    abortMock.mockImplementationOnce(() => {
      throw new Error('stream gone')
    })

    expect(() => disposeDeletedAgentSessions(['session-a', 'session-b'])).not.toThrow()
    expect(closeSessionMock).toHaveBeenCalledWith('session-a')
    expect(closeSessionMock).toHaveBeenCalledWith('session-b')
  })
})

describe('abortDeletedTopicStreams', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('aborts each chat topic stream', () => {
    abortDeletedTopicStreams(['topic-a', 'topic-b'])
    expect(abortMock).toHaveBeenCalledWith('topic-a', 'topic-deleted')
    expect(abortMock).toHaveBeenCalledWith('topic-b', 'topic-deleted')
    expect(closeSessionMock).not.toHaveBeenCalled()
  })
})
