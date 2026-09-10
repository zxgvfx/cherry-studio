import { describe, expect, it } from 'vitest'

import { dccToolAdmission } from '../dccToolApproval'

describe('dccToolAdmission', () => {
  it('auto-approves context and getters', () => {
    expect(dccToolAdmission('mcp__dcc-tools__dcc_get_context', false)).toBe('auto')
    expect(dccToolAdmission('mcp__dcc-tools__houdini_get_parm', false)).toBe('auto')
    expect(dccToolAdmission('mcp__dcc-tools__maya_list_nodes', false)).toBe('auto')
    expect(dccToolAdmission('mcp__dcc-tools__houdini_get_scene_info', false)).toBe('auto')
  })

  it('prompts for writes and blocks them in read_only', () => {
    expect(dccToolAdmission('mcp__dcc-tools__houdini_set_parm', false)).toBe('prompt')
    expect(dccToolAdmission('mcp__dcc-tools__import_scene_file', false)).toBe('prompt')
    expect(dccToolAdmission('mcp__dcc-tools__houdini_set_parm', true)).toBe('blocked')
    expect(dccToolAdmission('mcp__dcc-tools__dcc_get_context', true)).toBe('auto')
  })

  it('ignores non-dcc tools', () => {
    expect(dccToolAdmission('mcp__cherry-tools__web_search', false)).toBeNull()
  })
})
