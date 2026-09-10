import { loggerService } from '@logger'
import { extractMessageText } from '@main/ai/runtime/agentUserContent'
import type { AgentSessionMessageEntity } from '@shared/data/api/schemas/agentSessionMessages'

import type { CherryChatCredentials } from './cocoCherryProvider'
import type { CocoAskUserRequest, CocoPipelineHandleResult, CocoTurnUsage } from './cocoStreamAdapter'
import { stripCocoContextBlocks } from './pipelineClient'

const logger = loggerService.withContext('CocoLocalLoop')

export const COCO_LOCAL_LOOP_MAX_ROUNDS = 16
/** v_api / OpenAI: tools[].function.name 只允许 ^[a-zA-Z0-9_-]{1,128}$ */
const OPENAI_TOOL_NAME_RE = /[^a-zA-Z0-9_-]/g
const OPENAI_TOOL_NAME_MAX = 128

export interface PipelineToolDefinition {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface OpenAIToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type OpenAIChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls: OpenAIAssistantToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

interface OpenAIAssistantToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type LocalLoopChunk =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: CocoTurnUsage }
  | { type: 'tool_calls'; toolCalls: OpenAIToolCall[] }
  | { type: 'stop'; finishReason: string }

export interface CocoClientTurn {
  revision: number
  system_prompt: string
  tools: PipelineToolDefinition[]
}

export interface InvokeToolOutcome {
  awaitingUser?: CocoAskUserRequest
  result?: unknown
}

export async function runCocoLocalLoop(options: {
  credentials: CherryChatCredentials
  systemPrompt: string
  history: OpenAIChatMessage[]
  userContent: string
  tools: PipelineToolDefinition[]
  signal: AbortSignal
  emit: (event: unknown) => CocoPipelineHandleResult | Promise<CocoPipelineHandleResult>
  invokeTool: (name: string, args: Record<string, unknown>, toolCallId: string) => Promise<InvokeToolOutcome>
  onAskUser: (request: CocoAskUserRequest) => Promise<{ approved: boolean; answers?: Record<string, string> }>
  maxRounds?: number
}): Promise<{ assistantText: string; usage: CocoTurnUsage | null }> {
  const messages: OpenAIChatMessage[] = [
    { role: 'system', content: options.systemPrompt },
    ...options.history,
    { role: 'user', content: options.userContent }
  ]
  const { openaiTools, aliasToOriginal, originalToAlias } = buildOpenAIToolAliases(options.tools)
  const maxRounds = options.maxRounds ?? COCO_LOCAL_LOOP_MAX_ROUNDS
  let assistantText = ''
  let usage: CocoTurnUsage | null = null

  for (let round = 0; round <= maxRounds; round += 1) {
    if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const toolCalls: OpenAIToolCall[] = []
    let roundText = ''

    for await (const chunk of streamOpenAIChat({
      credentials: options.credentials,
      messages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      signal: options.signal
    })) {
      if (chunk.type === 'text' && chunk.text) {
        roundText += chunk.text
      } else if (chunk.type === 'usage') {
        usage = mergeUsage(usage, chunk.usage)
      } else if (chunk.type === 'tool_calls') {
        toolCalls.push(...chunk.toolCalls)
      }
    }

    if (toolCalls.length === 0) {
      assistantText += roundText
      if (roundText) {
        // Do not expose text until the round is known to be terminal. Some
        // OpenAI-compatible models emit a complete-looking answer and then a
        // tool call in the same round; rendering that provisional text makes
        // the post-tool answer appear twice.
        await options.emit({ type: 'delta', data: { text: roundText } })
        await options.emit({ type: 'message', data: { role: 'assistant', content: roundText } })
      }
      return { assistantText, usage }
    }

    if (round >= maxRounds) {
      throw new Error(`Coco local agent exceeded tool round limit (${maxRounds})`)
    }

    messages.push({
      role: 'assistant',
      content: roundText || null,
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: {
          name: toApiToolName(call.name, originalToAlias, aliasToOriginal),
          arguments: JSON.stringify(call.arguments)
        }
      }))
    })

    for (const call of toolCalls) {
      const originalName = resolvePipelineToolName(call.name, aliasToOriginal)
      const outcome = await options.invokeTool(originalName, call.arguments, call.id)
      let result = outcome.result
      if (outcome.awaitingUser) {
        const decision = await options.onAskUser(outcome.awaitingUser)
        result = {
          ok: decision.approved,
          answers: decision.answers ?? {},
          dismissed: !decision.approved
        }
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: stringifyToolResult(result)
      })
    }
  }

  throw new Error(`Coco local agent exceeded tool round limit (${maxRounds})`)
}

export function openaiHistoryFromSessionMessages(
  messages: readonly AgentSessionMessageEntity[],
  currentMessageId: string
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = []
  for (const message of messages) {
    if (message.id === currentMessageId) continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = stripCocoContextBlocks(extractMessageText(message)).trim()
    if (!text) continue
    out.push({ role: message.role, content: text })
  }
  return out.slice(-20)
}

export async function* streamOpenAIChat(options: {
  credentials: CherryChatCredentials
  messages: OpenAIChatMessage[]
  tools?: ReturnType<typeof toOpenAITool>[]
  signal: AbortSignal
}): AsyncGenerator<LocalLoopChunk> {
  const body: Record<string, unknown> = {
    model: options.credentials.modelId,
    messages: options.messages,
    stream: true,
    stream_options: { include_usage: true }
  }
  if (options.tools && options.tools.length > 0) body.tools = options.tools

  const response = await fetch(options.credentials.chatCompletionsUrl, {
    method: 'POST',
    signal: options.signal,
    headers: options.credentials.headers,
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `chat completions failed: ${response.status}`)
  }
  if (!response.body) throw new Error('chat completions returned an empty body')

  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
  for await (const payload of iterSSE(response.body, options.signal)) {
    const record = asRecord(payload)
    if (!record) continue
    const usage = readOpenAIUsage(record.usage)
    if (usage) yield { type: 'usage', usage }

    const choice = Array.isArray(record.choices) ? asRecord(record.choices[0]) : null
    if (!choice) continue
    const delta = asRecord(choice.delta) ?? asRecord(choice.message)
    if (delta) {
      const text = typeof delta.content === 'string' ? delta.content : ''
      if (text) yield { type: 'text', text }
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
      for (const raw of calls) {
        const item = asRecord(raw)
        if (!item) continue
        const index = typeof item.index === 'number' ? item.index : toolCalls.size
        const acc = toolCalls.get(index) ?? { id: '', name: '', arguments: '' }
        if (typeof item.id === 'string' && item.id) acc.id = item.id
        const fn = asRecord(item.function)
        if (typeof fn?.name === 'string') acc.name += fn.name
        if (typeof fn?.arguments === 'string') acc.arguments += fn.arguments
        toolCalls.set(index, acc)
      }
    }
    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : ''
    if (finishReason) {
      if (toolCalls.size > 0) {
        yield {
          type: 'tool_calls',
          toolCalls: [...toolCalls.values()].map((call, index) => ({
            id: call.id || `tool-call-${index + 1}`,
            name: call.name,
            arguments: parseToolArguments(call.arguments)
          }))
        }
        toolCalls.clear()
      }
      yield { type: 'stop', finishReason }
    }
  }
}

export function sanitizeOpenAIToolName(original: string, used: Set<string> = new Set()): string {
  let alias = original.replace(OPENAI_TOOL_NAME_RE, '_').slice(0, OPENAI_TOOL_NAME_MAX) || 'tool'
  if (used.has(alias)) {
    let suffix = 2
    while (used.has(`${alias.slice(0, OPENAI_TOOL_NAME_MAX - 4)}_${suffix}`)) suffix += 1
    alias = `${alias.slice(0, OPENAI_TOOL_NAME_MAX - 4)}_${suffix}`
  }
  used.add(alias)
  return alias
}

export function buildOpenAIToolAliases(tools: readonly PipelineToolDefinition[]): {
  openaiTools: ReturnType<typeof toOpenAITool>[]
  aliasToOriginal: Map<string, string>
  originalToAlias: Map<string, string>
} {
  const used = new Set<string>()
  const aliasToOriginal = new Map<string, string>()
  const originalToAlias = new Map<string, string>()
  const openaiTools = tools.map((tool) => {
    const alias = sanitizeOpenAIToolName(tool.name, used)
    aliasToOriginal.set(alias, tool.name)
    originalToAlias.set(tool.name, alias)
    return toOpenAITool(tool, alias)
  })
  return { openaiTools, aliasToOriginal, originalToAlias }
}

function resolvePipelineToolName(name: string, aliasToOriginal: Map<string, string>): string {
  return aliasToOriginal.get(name) || name
}

function toApiToolName(
  name: string,
  originalToAlias: Map<string, string>,
  aliasToOriginal: Map<string, string>
): string {
  if (originalToAlias.has(name)) return originalToAlias.get(name)!
  if (aliasToOriginal.has(name)) return name
  return sanitizeOpenAIToolName(name)
}

function toOpenAITool(tool: PipelineToolDefinition, apiName = tool.name) {
  const description = tool.description || tool.name
  return {
    type: 'function' as const,
    function: {
      name: apiName,
      description: apiName === tool.name ? description : `${description} (Pipeline tool: ${tool.name})`,
      parameters: normalizeOpenAIToolParameters(tool.parameters)
    }
  }
}

/**
 * Some OpenAI-compatible gateways reject a function input schema whose root is
 * oneOf/anyOf/allOf. MCP and Zod legitimately emit those roots for discriminated
 * unions, so expose an equivalent permissive object at the wire boundary while
 * leaving nested unions intact.
 */
export function normalizeOpenAIToolParameters(
  parameters: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return { type: 'object' }
  const combinator = (['oneOf', 'anyOf', 'allOf'] as const).find((key) => Array.isArray(parameters[key]))
  if (!combinator) return parameters

  const branches = (parameters[combinator] as unknown[])
    .map((branch) => resolveLocalSchemaRef(branch, parameters))
    .filter((branch): branch is Record<string, unknown> => branch !== null)
  const mergedProperties: Record<string, unknown> = {}
  const requiredSets: Set<string>[] = []

  for (const branch of branches) {
    const properties = asSchemaRecord(branch.properties)
    for (const [name, schema] of Object.entries(properties ?? {})) {
      const previous = mergedProperties[name]
      if (previous === undefined || JSON.stringify(previous) === JSON.stringify(schema)) {
        mergedProperties[name] = schema
      } else {
        const priorAlternatives = asSchemaRecord(previous)?.anyOf
        mergedProperties[name] = {
          anyOf: [...(Array.isArray(priorAlternatives) ? priorAlternatives : [previous]), schema]
        }
      }
    }
    requiredSets.push(
      new Set(
        Array.isArray(branch.required) ? branch.required.filter((item): item is string => typeof item === 'string') : []
      )
    )
  }

  const required =
    combinator === 'allOf'
      ? [...new Set(requiredSets.flatMap((set) => [...set]))]
      : [...(requiredSets[0] ?? [])].filter((name) => requiredSets.every((set) => set.has(name)))
  const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...rest } = parameters
  return {
    ...rest,
    type: 'object',
    properties: mergedProperties,
    ...(required.length > 0 ? { required } : {})
  }
}

function resolveLocalSchemaRef(value: unknown, root: Record<string, unknown>): Record<string, unknown> | null {
  const schema = asSchemaRecord(value)
  if (!schema) return null
  if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) return schema
  let resolved: unknown = root
  for (const segment of schema.$ref.slice(2).split('/')) {
    resolved = asSchemaRecord(resolved)?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return asSchemaRecord(resolved)
}

function asSchemaRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function parseToolArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch (error) {
    logger.warn('Failed to parse tool arguments JSON', error as Error)
    return {}
  }
}

function stringifyToolResult(result: unknown): string {
  try {
    return JSON.stringify(result ?? {})
  } catch {
    return JSON.stringify({ ok: false, error: 'unserializable_tool_result' })
  }
}

function mergeUsage(left: CocoTurnUsage | null, right: CocoTurnUsage): CocoTurnUsage {
  if (!left) return right
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens || 0) + (right.reasoningTokens || 0) || undefined,
    noCacheTokens: left.noCacheTokens + right.noCacheTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens
  }
}

function readOpenAIUsage(raw: unknown): CocoTurnUsage | null {
  const record = asRecord(raw)
  if (!record) return null
  const inputTokens = readInt(record.prompt_tokens, record.input_tokens)
  const outputTokens = readInt(record.completion_tokens, record.output_tokens)
  const totalTokens = readInt(record.total_tokens) || inputTokens + outputTokens
  const details = asRecord(record.prompt_tokens_details)
  const cacheReadTokens = readInt(details?.cached_tokens, record.cache_read_input_tokens)
  if (!inputTokens && !outputTokens && !cacheReadTokens) return null
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    noCacheTokens: Math.max(0, inputTokens - cacheReadTokens),
    cacheReadTokens,
    cacheWriteTokens: 0
  }
}

async function* iterSSE(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') return
        try {
          yield JSON.parse(payload)
        } catch (error) {
          logger.debug('Skipping malformed chat SSE payload', error as Error)
        }
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* already closed */
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function readInt(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value)
  }
  return 0
}
