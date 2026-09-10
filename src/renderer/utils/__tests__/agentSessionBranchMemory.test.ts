import { describe, expect, it } from 'vitest'

import { resolveRememberedAgentSessionBranch } from '../agentSessionBranchMemory'

describe('agentSessionBranchMemory', () => {
  it('restores the last selected branch for a root session', () => {
    expect(resolveRememberedAgentSessionBranch('root', { root: 'branch-2' })).toBe('branch-2')
  })

  it('follows nested branch selections and stops safely on cycles', () => {
    expect(
      resolveRememberedAgentSessionBranch('root', {
        root: 'branch-1',
        'branch-1': 'branch-2'
      })
    ).toBe('branch-2')
    expect(resolveRememberedAgentSessionBranch('root', { root: 'branch-1', 'branch-1': 'root' })).toBe('root')
  })

  it('keeps the requested session when no branch was remembered', () => {
    expect(resolveRememberedAgentSessionBranch('root', {})).toBe('root')
  })
})
