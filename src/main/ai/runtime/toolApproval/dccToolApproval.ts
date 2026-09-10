import { buildPiMcpToolName } from '@main/ai/runtime/pi/piMcpToolAdapter'

export const DCC_TOOLS_MCP_SERVER = 'dcc-tools'

export function toDccToolRuntimeName(toolName: string): string {
  return buildPiMcpToolName(DCC_TOOLS_MCP_SERVER, toolName)
}

const READ_NAME = /(?:^|_)(?:get|list|read|query|info|context|scene_info|snapshot)(?:_|$)/i

export type DccToolAdmission = 'auto' | 'prompt' | 'blocked'

/** Classify a Pi/Hermes runtime tool name that may belong to dcc-tools. */
export function dccToolAdmission(runtimeName: string, readOnly: boolean): DccToolAdmission | null {
  const marker = `mcp__${DCC_TOOLS_MCP_SERVER}__`
  if (!runtimeName.startsWith(marker) && !runtimeName.includes('dcc-tools')) {
    // Also accept unsanitized mcp__dcc-tools__* after camelCase fallback.
    if (!/mcp__dcc[-_]?tools__/i.test(runtimeName)) return null
  }
  const toolName = runtimeName.split('__').slice(2).join('__') || runtimeName
  const isRead =
    toolName === 'dcc_get_context' ||
    READ_NAME.test(toolName) ||
    /_get_scene_info$/.test(toolName) ||
    /_list_nodes$/.test(toolName) ||
    /_get_parm$/.test(toolName) ||
    /_get_attr$/.test(toolName)
  if (readOnly && !isRead) return 'blocked'
  return isRead ? 'auto' : 'prompt'
}
