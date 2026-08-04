import type { Assistant } from '@renderer/types'

export interface BuiltinToolContext {
  assistant: Assistant
  topicId: string
  userContent: string
  intentKeywords?: { question: string[]; rewrite?: string; links?: string[] }
  requestId: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any

export interface BuiltinTool {
  readonly name: string
  isEnabled(assistant: Assistant): boolean
  create(context: BuiltinToolContext): AnyTool
}

export class BuiltinToolRegistry {
  private tools: BuiltinTool[] = []

  register(tool: BuiltinTool) {
    this.tools.push(tool)
  }

  registerAll(params: { tools?: Record<string, any> | undefined }, context: BuiltinToolContext) {
    if (!params.tools) {
      params.tools = {}
    }
    const tools = params.tools
    for (const t of this.tools) {
      if (t.isEnabled(context.assistant)) {
        tools[t.name] = t.create(context)
      }
    }
  }

  hasAnyEnabled(assistant: Assistant): boolean {
    return this.tools.some((t) => t.isEnabled(assistant))
  }
}
