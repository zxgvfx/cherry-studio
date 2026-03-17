/**
 * Orchestration Preprocessor — Three-tier tool access
 *
 * Tier 0 (Direct):  Preprocessor detects /tool or @model → injects call_tool instructions
 * Tier 1 (By name): LLM knows tool name → call_tool(name, args)
 * Tier 2 (Discover): LLM unsure → search → get_tool_schema → call_tool
 *
 * Only Tier 0 adds system instructions. Tier 1-2 use the Hub's meta-tools.
 */
import { loggerService } from '@logger'
import store from '@renderer/store'
import type { Message } from '@renderer/types'
import type { MessageBlock } from '@renderer/types/newMessage'
import type { ModelMessage } from 'ai'

const logger = loggerService.withContext('OrchestrationPreprocessor')

const KNOWN_MODEL_ALIASES: Record<string, string> = {
  qwen: 'qwen3-vl-plus',
  qwen3: 'qwen3-vl-plus',
  'qwen-vl': 'qwen3-vl-plus',
  gpt: 'gpt-5.3-codex',
  gpt5: 'gpt-5.3-codex',
  codex: 'gpt-5.3-codex',
  deepseek: 'deepseek-v3.2-thinking',
  ds: 'deepseek-v3.2-thinking',
  claude: 'claude-haiku-4-5-20251001',
  gemini: 'gemini-3.1-pro-preview-thinking',
  doubao: 'doubao-seed-1-8-251228',
  'doubao-image': 'doubao-seedream-4-5-251128',
  'gpt-image': 'gpt-image-1.5'
}

const TOOL_TRIGGER_MAP: Record<string, string> = {
  sam3: 'sam3_launch_manual',
  'sam3-auto': 'sam3_auto_segment'
}

interface DetectedAction {
  type: 'tool' | 'model'
  name: string
}

function extractLastUserText(modelMessages: ModelMessage[]): string {
  for (let i = modelMessages.length - 1; i >= 0; i--) {
    const msg = modelMessages[i]
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') return msg.content
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join(' ')
      }
    }
  }
  return ''
}

function extractImagePathsFromMessages(uiMessages?: Message[]): string[] {
  if (!uiMessages || uiMessages.length === 0) return []

  const blockEntities = store.getState().messageBlocks.entities

  for (let i = uiMessages.length - 1; i >= 0; i--) {
    const msg = uiMessages[i]
    if (msg.role !== 'user') continue
    const paths: string[] = []
    for (const blockId of msg.blocks || []) {
      const block = blockEntities[blockId] as MessageBlock | undefined
      if (block && block.type === 'image' && (block as any).file?.path) {
        paths.push((block as any).file.path)
      }
    }
    if (paths.length > 0) return paths
  }
  return []
}

function detectActions(text: string): DetectedAction[] {
  const actions: DetectedAction[] = []

  const explicitMatch = text.match(/\[使用工具:\s*(\w+)\]/)
  if (explicitMatch) {
    actions.push({ type: 'tool', name: explicitMatch[1] })
  }

  const slashMatch = text.match(/\/(\w[\w-]*)/)
  if (slashMatch && !explicitMatch) {
    const mapped = TOOL_TRIGGER_MAP[slashMatch[1]]
    if (mapped) actions.push({ type: 'tool', name: mapped })
  }

  const modelRe = /@([\w.-]+)/g
  let m
  while ((m = modelRe.exec(text)) !== null) {
    const raw = m[1].toLowerCase()
    const resolved = KNOWN_MODEL_ALIASES[raw] || raw
    actions.push({ type: 'model', name: resolved })
  }

  return actions
}

export function injectOrchestrationInstructions(
  modelMessages: ModelMessage[],
  uiMessages?: Message[]
): void {
  if (!modelMessages || modelMessages.length === 0) return

  const userText = extractLastUserText(modelMessages)
  if (!userText) return

  const actions = detectActions(userText)
  if (actions.length === 0) return

  const imagePaths = extractImagePathsFromMessages(uiMessages)
  const imageNote = imagePaths.length > 0
    ? `\nAttached image file paths: ${imagePaths.map((p) => `"${p}"`).join(', ')}`
    : ''

  const parts: string[] = [
    '[Orchestration — You MUST use the call_tool meta-tool, NOT call tools directly]' + imageNote
  ]

  for (const action of actions) {
    if (action.type === 'tool') {
      const exampleArgs: Record<string, string> = {}
      if (imagePaths.length > 0 && action.name.includes('sam3')) {
        exampleArgs['image_path'] = imagePaths[0]
      }
      const argsStr = Object.keys(exampleArgs).length > 0
        ? JSON.stringify(exampleArgs)
        : '{...fill from user message}'

      parts.push(
        `→ Use: call_tool({"tool_name": "${action.name}", "arguments": ${argsStr}})`,
        `  Do NOT call "${action.name}" directly — it is not a registered tool.`,
        `  Only call_tool, get_tool_schema, search, and ask_model are available.`
      )
    } else {
      const imgArg = imagePaths.length > 0
        ? `, "images": ${JSON.stringify(imagePaths)}`
        : ''
      parts.push(
        `→ Use: ask_model({"model_id": "${action.name}", "prompt": "<task>"${imgArg}})`
      )
    }
  }

  parts.push('After receiving results, present the final answer to the user.')

  const systemMsg: ModelMessage = {
    role: 'system',
    content: parts.join('\n')
  }

  const firstNonSystem = modelMessages.findIndex((m) => m.role !== 'system')
  if (firstNonSystem > 0) {
    modelMessages.splice(firstNonSystem, 0, systemMsg)
  } else {
    modelMessages.unshift(systemMsg)
  }

  logger.info('Orchestration injected', {
    actions: actions.map((a) => `${a.type}:${a.name}`),
    imagePaths
  })
}
