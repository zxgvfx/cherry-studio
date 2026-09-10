import { loggerService } from '@logger'
import { getBackendUrl } from '@main/data/centralizedConfig/backendUrlRegistry'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'

const logger = loggerService.withContext('McpServer:DccTools')
const REQUEST_TIMEOUT_MS = 30_000

function backendOrigin(): string {
  return getBackendUrl().replace(/\/$/, '')
}

async function backendFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const origin = backendOrigin()
  if (!origin) throw new Error('Cherry backend URL is not configured')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      signal: init.signal ?? controller.signal
    })
    const text = await response.text()
    try {
      return text ? JSON.parse(text) : null
    } catch {
      return text
    }
  } finally {
    clearTimeout(timer)
  }
}

export class DccToolsServer {
  public mcpServer: McpServer

  constructor(private readonly dccSessionId: string) {
    this.mcpServer = new McpServer({ name: 'dcc-tools', version: '1.0.0' }, { capabilities: { tools: {} } })
    this.mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: await this.listTools()
    }))
    this.mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this.callTool(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>)
    })
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Session-Id': this.dccSessionId
    }
  }

  private async listTools(): Promise<Tool[]> {
    try {
      const data = (await backendFetch(
        `/api/v1/mcp/list-dcc-tools?sessionId=${encodeURIComponent(this.dccSessionId)}`,
        { method: 'GET', headers: this.headers() }
      )) as { tools?: Tool[]; error?: string }
      if (data?.error) {
        logger.warn('list-dcc-tools failed', { error: data.error, sessionId: this.dccSessionId })
        return []
      }
      return Array.isArray(data?.tools) ? data.tools : []
    } catch (error) {
      logger.warn('list-dcc-tools unreachable', { error, sessionId: this.dccSessionId })
      return []
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const data = await backendFetch('/api/v1/mcp/call-dcc', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          sessionId: this.dccSessionId,
          toolName: name,
          arguments: args
        })
      })
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
      const isError = Boolean(
        data && typeof data === 'object' && 'error' in (data as object) && (data as { error?: unknown }).error
      )
      return { content: [{ type: 'text', text }], isError }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('call-dcc failed', { tool: name, error: message })
      if (error instanceof McpError) throw error
      throw new McpError(ErrorCode.InternalError, message)
    }
  }
}

export default DccToolsServer
