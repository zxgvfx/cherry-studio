import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@main/data/centralizedConfig/backendUrlRegistry', () => ({
  getBackendUrl: () => 'http://127.0.0.1:9876'
}))

vi.stubGlobal('fetch', fetchMock)

import DccToolsServer from '../dccTools'

describe('DccToolsServer', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('lists tools from the backend MCP endpoint', async () => {
    fetchMock.mockResolvedValue({
      text: async () =>
        JSON.stringify({
          tools: [{ name: 'dcc_get_context', description: 'scene', inputSchema: { type: 'object' } }]
        })
    })
    const server = new DccToolsServer('sess-1')
    const tools = await (server as unknown as { listTools: () => Promise<Array<{ name: string }>> }).listTools()
    expect(tools).toEqual([expect.objectContaining({ name: 'dcc_get_context' })])
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v1/mcp/list-dcc-tools?sessionId=sess-1')
  })

  it('calls a DCC tool through call-dcc', async () => {
    fetchMock.mockResolvedValue({
      text: async () => JSON.stringify({ ok: true, dcc: 'houdini' })
    })
    const server = new DccToolsServer('sess-1')
    const result = await (
      server as unknown as {
        callTool: (
          name: string,
          args: Record<string, unknown>
        ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
      }
    ).callTool('dcc_get_context', {})
    expect(result.isError).toBe(false)
    expect(result.content[0]?.text).toContain('houdini')
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v1/mcp/call-dcc')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      sessionId: 'sess-1',
      toolName: 'dcc_get_context'
    })
  })
})
