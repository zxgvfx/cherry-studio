import type { AgentEntity } from '@shared/data/api/schemas/agents'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
  getById: vi.fn(),
  findByIdOrName: vi.fn(),
  listTools: vi.fn(),
  start: vi.fn()
}))

vi.mock('@data/services/AgentService', () => ({ agentService: { getAgent: mocks.getAgent } }))
vi.mock('@data/services/AgentSessionService', () => ({ agentSessionService: { getById: mocks.getById } }))
vi.mock('@data/services/McpServerService', () => ({
  mcpServerService: { findByIdOrName: mocks.findByIdOrName }
}))
vi.mock('@main/ai/mcp/servers/cherryBuiltinTools', () => ({
  listCherryBuiltinTools: () => [
    { name: 'web_search', description: 'Search the web' },
    { name: 'web_fetch', description: 'Fetch web pages' }
  ]
}))
vi.mock('@application', () => ({
  application: {
    get: (name: string) => {
      if (name === 'McpCatalogService') return { listTools: mocks.listTools }
      throw new Error(`unexpected service ${name}`)
    }
  }
}))
vi.mock('../CocoRuntimeConnection', () => ({
  CocoRuntimeConnection: class {
    start = mocks.start
  }
}))

const { CocoRuntimeDriver } = await import('../CocoRuntimeDriver')

const session = {
  id: 'session-1',
  agentId: 'agent-1',
  name: 'COCO',
  workspace: { path: '/tmp/coco', type: 'system' }
} as AgentSessionEntity

function agentStub(model: AgentEntity['model']): AgentEntity {
  return { id: 'agent-1', model } as Partial<AgentEntity> as AgentEntity
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listTools.mockReturnValue([])
  mocks.start.mockResolvedValue({})
})

describe('CocoRuntimeDriver', () => {
  it('validates that the bound agent has a model', async () => {
    mocks.getAgent.mockReturnValue(agentStub('vapi::gpt-5.6-sol'))
    await expect(new CocoRuntimeDriver().validateSession(session)).resolves.toBeUndefined()
  })

  it('rejects sessions whose agent has no model', async () => {
    mocks.getAgent.mockReturnValue(agentStub(null))
    await expect(new CocoRuntimeDriver().validateSession(session)).rejects.toThrow(/no model configured/)
  })

  it('exposes Cherry web tools and skips missing MCP servers', async () => {
    const tools = await new CocoRuntimeDriver().listAvailableTools(['mcp-1'])
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'mcp__cherry-tools__web_search', approval: 'auto' }),
        expect.objectContaining({ id: 'mcp__cherry-tools__web_fetch', approval: 'auto' })
      ])
    )
    expect(tools.every((tool) => tool.origin === 'builtin')).toBe(true)
  })

  it('connects through CocoRuntimeConnection', async () => {
    await new CocoRuntimeDriver().connect({
      sessionId: 'session-1',
      agentId: 'agent-1',
      modelId: 'vapi::gpt-5.6-sol'
    })
    expect(mocks.start).toHaveBeenCalled()
  })
})
