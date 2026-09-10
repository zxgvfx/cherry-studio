import { spawn } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'

import { loggerService } from '@logger'
import { getBinaryPath } from '@main/utils/binaryResolver'
import { app } from 'electron'

import type { CherryChatCredentials } from './cocoCherryProvider'
import { ensureCocoHermesBundle } from './cocoHermesBundle'
import type { OpenAIChatMessage, PipelineToolDefinition } from './cocoLocalLoop'
import type { CocoTurnUsage } from './cocoStreamAdapter'

const logger = loggerService.withContext('CocoHermesLocal')

export interface CocoHermesLocalInput {
  credentials: CherryChatCredentials
  systemPrompt: string
  history: OpenAIChatMessage[]
  userMessage: string
  tools: PipelineToolDefinition[]
  sessionId: string
  signal: AbortSignal
  onEvent(event: unknown): unknown | Promise<unknown>
  invokeTool(name: string, arguments_: Record<string, unknown>, toolCallId: string): Promise<unknown>
}

export interface CocoHermesLocalResult {
  assistantText: string
  usage: CocoTurnUsage | null
}

type RunnerMessage =
  | { type: 'event'; event: unknown }
  | { type: 'tool_request'; id: string; name: string; arguments?: Record<string, unknown> }
  | { type: 'done'; assistant_text?: string; usage?: Record<string, unknown> }
  | { type: 'fatal'; error?: string; message?: string; traceback?: string }
  | { type: 'ready'; version?: string }

function int(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0
}

function toUsage(raw: Record<string, unknown> | undefined): CocoTurnUsage | null {
  if (!raw) return null
  const inputTokens = int(raw.prompt_tokens ?? raw.input_tokens)
  const outputTokens = int(raw.completion_tokens ?? raw.output_tokens)
  const cacheReadTokens = int(raw.cache_read_input_tokens ?? raw.cache_read_tokens)
  const cacheWriteTokens = int(raw.cache_write_input_tokens ?? raw.cache_write_tokens)
  if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens) return null
  return {
    inputTokens,
    outputTokens,
    totalTokens: int(raw.total_tokens) || inputTokens + outputTokens,
    reasoningTokens: int(raw.reasoning_tokens),
    noCacheTokens: Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens),
    cacheReadTokens,
    cacheWriteTokens
  }
}

function writeLine(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`)
}

/**
 * Runs the real vendored Hermes Python SDK as a child of Cherry's local
 * Electron main process. Pipeline is contacted only when Hermes requests a
 * tool; the model loop, history and provider credentials stay on this machine.
 */
export async function runCocoHermesLocal(input: CocoHermesLocalInput): Promise<CocoHermesLocalResult> {
  const uv = await getBinaryPath('uv')
  const bundle = await ensureCocoHermesBundle()
  const hermesHome = path.join(app.getPath('userData'), 'hermes-coco')
  const child = spawn(
    uv,
    [
      'run',
      '--quiet',
      '--no-progress',
      '--isolated',
      '--python',
      '3.12',
      '--with-requirements',
      bundle.requirements,
      '--no-project',
      'python',
      bundle.runner
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8'
      }
    }
  )
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })

  let stderr = ''
  let assistantText = ''
  let usage: CocoTurnUsage | null = null
  let fatal: Error | null = null
  child.stdin.on('error', (error) => {
    if (!input.signal.aborted) logger.warn('Local Hermes stdin closed', error)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_000)
  })

  const abort = () => child.kill()
  if (input.signal.aborted) abort()
  input.signal.addEventListener('abort', abort, { once: true })

  writeLine(child.stdin, {
    hermes_source: bundle.source,
    hermes_home: hermesHome,
    base_url: input.credentials.chatCompletionsUrl.replace(/\/chat\/completions\/?$/i, ''),
    api_key: input.credentials.apiKey,
    model: input.credentials.modelId,
    system_prompt: input.systemPrompt,
    history: input.history,
    user_message: input.userMessage,
    tools: input.tools,
    session_id: input.sessionId,
    max_iterations: 16
  })

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      let message: RunnerMessage
      try {
        message = JSON.parse(line) as RunnerMessage
      } catch {
        logger.warn('Ignoring non-protocol output from local Hermes', { line: line.slice(0, 500) })
        continue
      }
      if (message.type === 'event') {
        await input.onEvent(message.event)
        continue
      }
      if (message.type === 'tool_request') {
        try {
          const result = await input.invokeTool(message.name, message.arguments ?? {}, message.id)
          writeLine(child.stdin, { type: 'tool_response', id: message.id, ok: true, result })
        } catch (error) {
          writeLine(child.stdin, {
            type: 'tool_response',
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        }
        continue
      }
      if (message.type === 'done') {
        assistantText = String(message.assistant_text || '')
        usage = toUsage(message.usage)
        continue
      }
      if (message.type === 'fatal') {
        fatal = new Error(`${message.error || 'HermesError'}: ${message.message || 'local Hermes failed'}`)
        logger.error('Local Hermes runner failed', {
          error: message.error,
          message: message.message,
          traceback: message.traceback
        })
      }
    }

    const exitCode = await exitPromise
    if (input.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (fatal) throw fatal
    if (exitCode !== 0) {
      throw new Error(`Local Hermes exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
    }
    return { assistantText, usage }
  } finally {
    input.signal.removeEventListener('abort', abort)
    lines.close()
    if (!child.killed && child.exitCode == null) child.kill()
  }
}
