import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lite/DccAgentChat', () => ({
  DccAgentChat: () => <div>chat-surface</div>
}))
vi.mock('@renderer/pages/aiPipeline/AiPipelinePage', () => ({
  default: () => <div>canvas-surface</div>
}))
vi.mock('@renderer/hooks/agent/useAgent', () => ({
  useAgents: () => ({ agents: [], isLoading: false }),
  useUpdateAgent: () => ({ updateAgent: vi.fn() })
}))

import { DccPanel } from '../DccPanel'

describe('DccPanel', () => {
  beforeEach(() => {
    Object.assign(window, {
      __CHERRY_BACKEND_URL: 'http://127.0.0.1:9876',
      __CHERRY_SESSION_ID: 'dcc-1',
      __CHERRY_DCC_TYPE: 'houdini'
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: async () => ({
          dcc: 'houdini',
          dccVersion: '20.5',
          hipFile: 'shot.hip',
          selectedNodes: [{ path: '/obj/geo1' }],
          available: true
        })
      })
    )
  })

  it('mounts the lite Agent conversation surface on the chat tab', async () => {
    render(<DccPanel />)
    expect(await screen.findByText('chat-surface')).toBeInTheDocument()
    expect(await screen.findByText(/houdini 20\.5/)).toBeInTheDocument()
    expect(screen.getByText(/shot\.hip/)).toBeInTheDocument()
  })

  it('switches between chat and canvas tabs', async () => {
    const user = userEvent.setup()
    render(<DccPanel />)
    expect(await screen.findByText('chat-surface')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '画布' }))
    expect(screen.getByText('canvas-surface')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '对话' }))
    expect(screen.getByText('chat-surface')).toBeInTheDocument()
  })
})
