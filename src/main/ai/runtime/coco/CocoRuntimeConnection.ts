import { randomUUID } from 'node:crypto'

import { application } from '@application'
import { agentService } from '@data/services/AgentService'
import { agentSessionMessageService } from '@data/services/AgentSessionMessageService'
import { agentSessionService } from '@data/services/AgentSessionService'
import { loggerService } from '@logger'
import {
  type AgentAttachmentFile,
  collectAttachmentFilesFromMessages,
  extractMessageText
} from '@main/ai/runtime/agentUserContent'
import { getBackendUrl } from '@main/data/centralizedConfig/backendUrlRegistry'
import { AGENT_RUNTIME_CAPABILITIES } from '@shared/ai/agentRuntimeCapabilities'
import { readCocoMode, readCocoPermission } from '@shared/ai/cocoAgent'
import { mergeCocoSessionAssets } from '@shared/ai/cocoSessionAssets'
import type { AgentEntity } from '@shared/data/api/schemas/agents'
import type { AgentSessionMessageEntity } from '@shared/data/api/schemas/agentSessionMessages'
import type { UniqueModelId } from '@shared/data/types/model'
import type { PipelineAssetPartData } from '@shared/data/types/uiParts'

import { AsyncEventQueue } from '../AsyncEventQueue'
import { type DispatchDecision, toolApprovalRegistry } from '../toolApproval/ToolApprovalRegistry'
import type {
  AgentRuntimeConnectInput,
  AgentRuntimeConnection,
  AgentRuntimeEvent,
  AgentRuntimeReconcileResult,
  AgentRuntimeUserInput,
  AgentSessionUsageCapture
} from '../types'
import { prepareCocoCherryCapabilities } from './cocoCherryCapabilities'
import { type CherryChatCredentials, resolveCherryChatCredentials } from './cocoCherryProvider'
import { runCocoHermesLocal } from './cocoHermesLocal'
import { type CocoClientTurn, type InvokeToolOutcome, openaiHistoryFromSessionMessages } from './cocoLocalLoop'
import { ASK_USER_TOOL_NAME, type CocoAskUserRequest, CocoStreamAdapter } from './cocoStreamAdapter'
import {
  cachePipelineAssets,
  extractAssetIdsFromText,
  extractLatestRunAssetsFromEvents,
  hydrateToolResultEvent,
  isInlinePreviewRequest,
  selectPreviewableSessionAssets
} from './pipelineAssets'
import {
  buildCocoUserTurn,
  type CocoLocalAttachmentPath,
  ensurePipelineSession,
  filesFromSessionAssets,
  localUsername,
  persistPipelineBinding,
  pipelineApiBase,
  pipelineFetch,
  pipelineStreamFetch,
  pipelineTryFetch,
  readCocoDcc,
  readCocoSessionAssetsFromConfiguration,
  sessionAssetsFromPipelineMetadata,
  sessionAssetsFromPipelineParts,
  splitAgentModel,
  stripCocoContextBlocks
} from './pipelineClient'

const logger = loggerService.withContext('CocoRuntimeConnection')

export class CocoRuntimeConnection implements AgentRuntimeConnection {
  private readonly eventQueue = new AsyncEventQueue<AgentRuntimeEvent>()
  private readonly adapter = new CocoStreamAdapter({
    enqueue: (chunk) => this.eventQueue.push({ type: 'chunk', chunk })
  })
  private abort = new AbortController()
  private closed = false
  private sending = false
  private pipelineSessionId?: string
  private _usageCapture?: AgentSessionUsageCapture
  readonly events = this.eventQueue

  constructor(private readonly input: AgentRuntimeConnectInput) {}

  get usageCapture(): AgentSessionUsageCapture | undefined {
    return this._usageCapture
  }

  async start(): Promise<this> {
    const agent = agentService.getAgent(this.input.agentId)
    if (!agent) throw new Error(`coco agent not found: ${this.input.agentId}`)
    const session = agentSessionService.getById(this.input.sessionId)
    const ensured = await ensurePipelineSession(agent, session)
    this.pipelineSessionId = ensured.pipelineSessionId
    this._usageCapture = cocoUsageCapture(agent, this.input.modelId || agent.model)
    return this
  }

  send(input: AgentRuntimeUserInput): void {
    if (this.closed) {
      this.eventQueue.push({ type: 'error', error: new Error('coco connection is closed') })
      return
    }
    if (this.sending) {
      this.eventQueue.push({ type: 'error', error: new Error('coco connection already has a live turn') })
      return
    }
    this.sending = true
    void this.runTurn(input).finally(() => {
      this.sending = false
    })
  }

  async reconcile(input: {
    modelId: UniqueModelId
    reasoningEffort?: unknown
    knowledgeBaseIds?: readonly string[]
    fastMode?: boolean
  }): Promise<AgentRuntimeReconcileResult> {
    if (input.modelId !== this.input.modelId) return 'rebuild'
    return 'current'
  }

  close(): void {
    this.closed = true
    this.abort.abort()
    this.eventQueue.close()
  }

  private async runTurn(input: AgentRuntimeUserInput): Promise<void> {
    try {
      const agent = agentService.getAgent(this.input.agentId)
      if (!agent) throw new Error(`coco agent not found: ${this.input.agentId}`)
      const session = agentSessionService.getById(this.input.sessionId)
      if (!this.pipelineSessionId) {
        const ensured = await ensurePipelineSession(agent, session)
        this.pipelineSessionId = ensured.pipelineSessionId
      }

      const pipelineSession = await pipelineFetch<{
        revision?: number
        context?: { metadata?: Record<string, unknown> }
      }>(`/api/agents/sessions/${encodeURIComponent(this.pipelineSessionId)}`)
      const canvasGraph = pipelineSession.context?.metadata?.graph_baseline
      const { providerId, modelId } = splitAgentModel(this.input.modelId || agent.model)
      this.adapter.lastUsage = null
      const sessionAssets = mergeCocoSessionAssets(
        sessionAssetsFromPipelineMetadata(pipelineSession.context?.metadata),
        readCocoSessionAssetsFromConfiguration(agent.configuration, session.id)
      )
      const dcc = readCocoDcc(agent.configuration)
      const dccContext = dcc.sessionId ? await fetchDccContext(dcc.sessionId, this.abort.signal) : undefined
      const history = loadRecentSessionMessages(session.id)
      const currentText = stripCocoContextBlocks(extractMessageText(input.message)).trim()
      const turn = await buildCocoUserTurn(input.message, this.abort.signal, {
        agentId: agent.id,
        sessionId: session.id,
        pipelineSessionId: this.pipelineSessionId,
        extraFiles: collectExtraTurnFiles(history, input.message.id, sessionAssets),
        sessionAssets,
        priorUserTexts: priorUserTextsFromMessages(history, input.message.id, currentText),
        canvasGraph,
        dccContext,
        resolveFileEntryPath: resolveManagedFilePath
      })
      if (!turn.content) throw new Error('coco turn has no user content')
      if (isInlinePreviewRequest(turn.content)) {
        await this.presentSessionAssetPreviews({
          agentId: agent.id,
          sessionId: session.id,
          userText: turn.content,
          parentAssetId: turn.attachments[0]?.assetId,
          parentName: turn.attachments[0]?.filename,
          force: true
        })
      }
      const turnBody = {
        content: turn.content,
        expected_revision: pipelineSession.revision || 0,
        provider_id: providerId,
        model: modelId,
        mode: readCocoMode(agent.configuration),
        permission_mode: readCocoPermission(agent.configuration),
        ...(turn.attachments.length > 0 ? { attachments: turn.attachments } : {})
      }
      const cherry = resolveCherryChatCredentials(this.input.modelId || agent.model)
      if (!cherry) {
        throw new Error('本地 Hermes SDK 无法读取当前模型 Provider/API Key。已禁止回退到 Pipeline 服务器运行 Agent。')
      }
      // The model runs locally, so it gets the attachments' local paths; `turnBody.content`
      // stays path-free because it is posted to the pipeline server.
      await this.tryLocalTurn(agent, cherry, turn.localContent, history, input.message.id, turnBody, turn.localPaths)

      await this.followInFlightRun()
      this.adapter.finishOpenParts()
      this.emitTurnUsage(modelId)
      await this.presentSessionAssetPreviews({
        agentId: agent.id,
        sessionId: session.id,
        userText: turn.content,
        parentAssetId: turn.attachments[0]?.assetId,
        parentName: turn.attachments[0]?.filename,
        force: isInlinePreviewRequest(turn.content)
      })
      if (!this.closed) this.eventQueue.push({ type: 'turn-complete' })
    } catch (error) {
      if (this.closed || isAbortError(error)) return
      logger.error('coco pipeline turn failed', error as Error)
      this.eventQueue.push({ type: 'error', error })
    }
  }

  private async tryLocalTurn(
    agent: AgentEntity,
    cherry: CherryChatCredentials,
    userContent: string,
    history: AgentSessionMessageEntity[],
    currentMessageId: string,
    turnBody: Record<string, unknown>,
    attachmentPaths: readonly CocoLocalAttachmentPath[]
  ): Promise<boolean> {
    if (!this.pipelineSessionId) return false
    const pipelineSessionId = this.pipelineSessionId
    const prepared = await pipelineTryFetch<CocoClientTurn>(
      `/api/agents/sessions/${encodeURIComponent(pipelineSessionId)}/client-turn`,
      { method: 'POST', body: turnBody, signal: this.abort.signal }
    )
    if (!prepared.ok) {
      throw new Error(`Pipeline client-turn unavailable (${prepared.status}); remote Hermes fallback is disabled`)
    }

    const session = agentSessionService.getById(this.input.sessionId)
    if (!session) return false
    const cherryCapabilities = await prepareCocoCherryCapabilities({
      agent,
      session,
      systemPrompt: prepared.data.system_prompt,
      knowledgeBaseIds: this.input.knowledgeBaseIds,
      readOnly: readCocoPermission(agent.configuration) === 'read_only',
      credentials: cherry,
      attachmentPaths
    })
    const pipelineToolNames = new Set(prepared.data.tools.map((tool) => tool.name))
    const cherryTools = cherryCapabilities.tools.filter((tool) => !pipelineToolNames.has(tool.name))
    const cherryToolNames = new Set(cherryTools.map((tool) => tool.name))
    let assistantText = ''
    try {
      const outcome = await runCocoHermesLocal({
        credentials: cherry,
        systemPrompt: cherryCapabilities.systemPrompt,
        history: openaiHistoryFromSessionMessages(history, currentMessageId),
        userMessage: userContent,
        tools: [...prepared.data.tools, ...cherryTools],
        sessionId: pipelineSessionId,
        signal: this.abort.signal,
        onEvent: (event) => this.adapter.handleEvent(event),
        invokeTool: async (name, args, toolCallId) => {
          const invoked = cherryToolNames.has(name)
            ? await this.invokeCherryTool(cherryCapabilities, name, args, toolCallId)
            : await this.invokePipelineTool(agent, name, args, toolCallId)
          if (!invoked.awaitingUser) return invoked.result
          const request = invoked.awaitingUser
          const decision = await this.requestAskUser(request)
          const answers = asAskUserAnswers(decision.updatedInput)
          this.adapter.completeAskUser(request.toolCallId, {
            ...request.input,
            answers,
            dismissed: !decision.approved
          })
          return { ok: decision.approved, answers, dismissed: !decision.approved }
        }
      })
      assistantText = outcome.assistantText
      if (outcome.usage) this.adapter.lastUsage = outcome.usage
    } finally {
      await cherryCapabilities.close().catch((error) => {
        logger.warn('Failed to close Cherry capability bridge', error as Error)
      })
      try {
        await pipelineTryFetch(`/api/agents/sessions/${encodeURIComponent(pipelineSessionId)}/client-turn/complete`, {
          method: 'POST',
          body: { content: assistantText || null },
          signal: this.abort.signal
        })
      } catch (error) {
        logger.warn('Failed to complete coco client turn', error as Error)
      }
    }
    return true
  }

  private async invokeCherryTool(
    capabilities: Awaited<ReturnType<typeof prepareCocoCherryCapabilities>>,
    name: string,
    args: Record<string, unknown>,
    toolCallId: string
  ): Promise<InvokeToolOutcome> {
    await this.adapter.handleEvent({
      type: 'tool_started',
      data: { name, arguments: args, tool_call_id: toolCallId }
    })
    const admission = capabilities.admission(name)
    let input = args
    if (admission === 'blocked') {
      const result = { ok: false, error: `Tool is disabled by the current COCO permission policy: ${name}` }
      await this.adapter.handleEvent({ type: 'tool_result', data: { name, tool_call_id: toolCallId, result } })
      return { result }
    }
    if (admission === 'prompt') {
      const decision = await this.requestToolApproval(name, toolCallId, args)
      if (!decision.approved) {
        const result = { ok: false, error: decision.reason || 'User denied this tool call.' }
        await this.adapter.handleEvent({ type: 'tool_result', data: { name, tool_call_id: toolCallId, result } })
        return { result }
      }
      input = decision.updatedInput ?? args
    }
    try {
      const result = await capabilities.invoke(name, input, toolCallId, this.abort.signal)
      await this.adapter.handleEvent({ type: 'tool_result', data: { name, tool_call_id: toolCallId, result } })
      return { result }
    } catch (error) {
      if (this.abort.signal.aborted) throw error
      const result = { ok: false, error: error instanceof Error ? error.message : String(error) }
      await this.adapter.handleEvent({ type: 'tool_result', data: { name, tool_call_id: toolCallId, result } })
      return { result }
    }
  }

  private async invokePipelineTool(
    agent: AgentEntity,
    name: string,
    args: Record<string, unknown>,
    toolCallId: string
  ): Promise<InvokeToolOutcome> {
    if (!this.pipelineSessionId) throw new Error('coco pipeline session is missing')
    const url = `${pipelineApiBase()}/api/agents/sessions/${encodeURIComponent(this.pipelineSessionId)}/tools/invoke`
    const res = await pipelineStreamFetch(url, {
      method: 'POST',
      signal: this.abort.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
        'X-User-Key': localUsername()
      },
      body: JSON.stringify({
        name,
        arguments: args,
        tool_call_id: toolCallId,
        allow_write: readCocoPermission(agent.configuration) !== 'read_only'
      })
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(text || `pipeline tool invoke failed: ${res.status}`)
    }
    if (!res.body) throw new Error('pipeline tool invoke returned an empty body')
    return this.consumeNdjson(res.body)
  }

  private async consumeNdjson(
    body: ReadableStream<Uint8Array>
  ): Promise<{ awaitingUser?: CocoAskUserRequest; result?: unknown }> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let lastResult: unknown
    const finish = async (awaitingUser?: CocoAskUserRequest) => {
      try {
        await reader.cancel()
      } catch {
        /* already closed */
      }
      return { ...(awaitingUser ? { awaitingUser } : {}), ...(lastResult !== undefined ? { result: lastResult } : {}) }
    }
    while (!this.closed) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        lastResult = peekToolResult(line) ?? lastResult
        const result = await this.handleLine(line)
        if (result === 'completed' || result === 'cancelled') return finish()
        if (result && typeof result === 'object' && 'error' in result) {
          throw new Error(result.error)
        }
        if (result && typeof result === 'object' && 'awaitingUser' in result) {
          return finish(result.awaitingUser)
        }
      }
    }
    if (buffer.trim()) {
      lastResult = peekToolResult(buffer) ?? lastResult
      const result = await this.handleLine(buffer)
      if (result && typeof result === 'object' && 'error' in result) {
        throw new Error(result.error)
      }
      if (result && typeof result === 'object' && 'awaitingUser' in result) {
        return { awaitingUser: result.awaitingUser, ...(lastResult !== undefined ? { result: lastResult } : {}) }
      }
    }
    return lastResult !== undefined ? { result: lastResult } : {}
  }

  private requestAskUser(request: CocoAskUserRequest): Promise<DispatchDecision> {
    const approvalId = randomUUID()
    return new Promise((resolve) => {
      const pending = toolApprovalRegistry.register({
        approvalId,
        sessionId: this.input.sessionId,
        toolCallId: request.toolCallId,
        toolName: ASK_USER_TOOL_NAME,
        originalInput: request.input,
        presentation: 'stream',
        signal: this.abort.signal,
        resolve
      })
      if (!pending) return
      this.eventQueue.push({
        type: 'tool-approval-request',
        request: {
          approvalId,
          toolCallId: request.toolCallId,
          toolName: ASK_USER_TOOL_NAME,
          input: request.input,
          presentation: 'stream',
          providerMetadata: {
            cherry: {
              transport: AGENT_RUNTIME_CAPABILITIES.coco.transport,
              toolName: ASK_USER_TOOL_NAME
            }
          }
        }
      })
    })
  }

  private requestToolApproval(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>
  ): Promise<DispatchDecision> {
    const approvalId = randomUUID()
    return new Promise((resolve) => {
      const pending = toolApprovalRegistry.register({
        approvalId,
        sessionId: this.input.sessionId,
        toolCallId,
        toolName,
        originalInput: input,
        presentation: 'stream',
        signal: this.abort.signal,
        resolve
      })
      if (!pending) return
      this.eventQueue.push({
        type: 'tool-approval-request',
        request: {
          approvalId,
          toolCallId,
          toolName,
          input,
          presentation: 'stream',
          providerMetadata: {
            cherry: {
              transport: AGENT_RUNTIME_CAPABILITIES.coco.transport,
              toolName
            }
          }
        }
      })
    })
  }

  private async handleLine(line: string): Promise<ReturnType<CocoStreamAdapter['handleEvent']> | undefined> {
    const trimmed = line.trim()
    if (!trimmed) return
    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      return
    }
    const hydrated = await hydrateToolResultEvent(event, this.abort.signal)
    return this.adapter.handleEvent(hydrated)
  }

  private emitTurnUsage(modelId: string | null): void {
    if (this.closed) return
    const usage = this.adapter.lastUsage
    if (!usage) return

    // Emit context-usage event so the right-pane status and composer ring update
    this.eventQueue.push({
      type: 'context-usage',
      usage: {
        categories: [],
        totalTokens: usage.totalTokens,
        maxTokens: 0,
        percentage: 0,
        model: modelId || this.input.modelId
      }
    })

    if (this._usageCapture?.owner !== 'agent-sdk') return
    this.eventQueue.push({
      type: 'usage',
      invocation: {
        requestId: `coco-agent:${this.input.sessionId}:${randomUUID()}`,
        model: modelId || this.input.modelId,
        messageAssociation: 'current-turn',
        usage
      }
    })
  }

  private async presentSessionAssetPreviews(options: {
    agentId: string
    sessionId: string
    userText: string
    parentAssetId?: string
    parentName?: string
    force: boolean
  }): Promise<void> {
    if (!this.pipelineSessionId) return
    let revision: number | undefined
    let fromPipeline: ReturnType<typeof sessionAssetsFromPipelineMetadata> = []
    try {
      const updated = await pipelineFetch<{
        revision?: number
        context?: { metadata?: Record<string, unknown> }
      }>(`/api/agents/sessions/${encodeURIComponent(this.pipelineSessionId)}`)
      revision = updated.revision
      fromPipeline = sessionAssetsFromPipelineMetadata(updated.context?.metadata)
    } catch (error) {
      logger.warn('Failed to refresh coco pipeline session', error as Error)
    }

    const agent = agentService.getAgent(options.agentId)
    const fromBinding = agent ? readCocoSessionAssetsFromConfiguration(agent.configuration, options.sessionId) : []
    const sessionAssets = mergeCocoSessionAssets(fromPipeline, fromBinding)
    const shouldPresentUploads = options.force
    if (shouldPresentUploads) {
      let parts = selectPreviewableSessionAssets(sessionAssets, {
        mentionedIds: extractAssetIdsFromText(stripCocoContextBlocks(options.userText)),
        allowUploads: true
      })
      if (parts.length === 0) {
        try {
          parts = extractLatestRunAssetsFromEvents(
            await pipelineFetch(`/api/agents/sessions/${encodeURIComponent(this.pipelineSessionId)}/events`)
          )
        } catch (error) {
          logger.warn('Failed to load coco pipeline events for preview', error as Error)
        }
      }
      await this.emitFreshPipelineAssets(parts)
    } else if (this.adapter.emittedPipelineAssets.length === 0 && this.adapter.submittedGraphThisTurn) {
      try {
        const parts = extractLatestRunAssetsFromEvents(
          await pipelineFetch(`/api/agents/sessions/${encodeURIComponent(this.pipelineSessionId)}/events`)
        )
        await this.emitFreshPipelineAssets(parts)
      } catch (error) {
        logger.warn('Failed to load coco pipeline events for preview', error as Error)
      }
    }

    const fromEmit = sessionAssetsFromPipelineParts(this.adapter.emittedPipelineAssets, {
      parentAssetId: options.parentAssetId,
      parentName: options.parentName
    })
    persistPipelineBinding(options.agentId, options.sessionId, {
      id: this.pipelineSessionId,
      revision,
      assets: mergeCocoSessionAssets(fromPipeline, fromEmit)
    })
  }

  private async emitFreshPipelineAssets(parts: PipelineAssetPartData[]): Promise<void> {
    const seen = new Set(this.adapter.emittedPipelineAssets.map((asset) => asset.assetId))
    const fresh = parts.filter((asset) => asset.assetId && !seen.has(asset.assetId))
    if (fresh.length === 0) return
    const cached = await cachePipelineAssets(fresh, this.abort.signal)
    this.adapter.presentPipelineAssets(cached)
  }

  private async followInFlightRun(): Promise<void> {
    const runId = this.adapter.lastRunId
    if (!runId || runId === 'pending' || runId === 'canvas') return
    if (!this.adapter.submittedGraphThisTurn && !this.adapter.lastStillRunning) return
    const active = new Set(['pending', 'running'])
    if (!this.adapter.lastStillRunning && !active.has(this.adapter.lastRunStatus)) {
      if (this.adapter.emittedPipelineAssets.length > 0) return
    }
    const deadline = Date.now() + 60 * 60 * 1000
    let status = this.adapter.lastRunStatus
    while (!this.closed && Date.now() < deadline) {
      if (this.abort.signal.aborted) return
      let run: { status?: string; run_id?: string }
      try {
        run = await pipelineFetch(`/api/workflows/runs/${encodeURIComponent(runId)}`, {
          signal: this.abort.signal
        })
      } catch (error) {
        logger.warn('Failed to poll in-flight coco pipeline run', error as Error)
        return
      }
      status = String(run.status || '')
      this.adapter.handleEvent({
        type: 'run_progress',
        data: { phase: 'run', run: { run_id: runId, status }, status }
      })
      if (status === 'awaiting_human' || status === 'awaiting_approval') return
      if (!active.has(status)) break
      await sleepWithSignal(2000, this.abort.signal)
    }
    if (this.closed || this.abort.signal.aborted) return
    if (active.has(status)) return
    try {
      const artifacts = await pipelineFetch<Array<Record<string, unknown>>>(
        `/api/workflows/runs/${encodeURIComponent(runId)}/artifacts`,
        { signal: this.abort.signal }
      )
      await this.handleLine(
        JSON.stringify({
          type: 'tool_result',
          data: {
            name: 'submit.graph',
            result: {
              run: { run_id: runId, status },
              assets: artifacts
            }
          }
        })
      )
    } catch (error) {
      logger.warn('Failed to hydrate in-flight coco pipeline artifacts', error as Error)
    }
  }
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const GENERIC_FOLLOWUP = /^(继续|重新生成|再试一次|重试|retry|continue|regen)$/iu

function loadRecentSessionMessages(sessionId: string): AgentSessionMessageEntity[] {
  try {
    return agentSessionMessageService.listSessionMessages(sessionId, { limit: 30 }).items ?? []
  } catch (error) {
    logger.warn('Failed to load coco session history for turn context', error as Error)
    return []
  }
}

function collectExtraTurnFiles(
  history: AgentSessionMessageEntity[],
  currentMessageId: string,
  sessionAssets: ReturnType<typeof mergeCocoSessionAssets>
): AgentAttachmentFile[] {
  const fromHistory = collectAttachmentFilesFromMessages(history.filter((message) => message.id !== currentMessageId))
  return [...filesFromSessionAssets(sessionAssets), ...fromHistory]
}

function priorUserTextsFromMessages(
  history: AgentSessionMessageEntity[],
  currentMessageId: string,
  currentText: string
): string[] {
  const texts: string[] = []
  for (const message of [...history].reverse()) {
    if (message.role !== 'user' || message.id === currentMessageId) continue
    const text = stripCocoContextBlocks(extractMessageText(message)).trim()
    if (!text || GENERIC_FOLLOWUP.test(text) || text === currentText) continue
    texts.push(text)
  }
  return texts.slice(-6)
}

function resolveManagedFilePath(fileEntryId: string): string {
  try {
    return application.get('FileManager').getPhysicalPath(fileEntryId)?.trim() || ''
  } catch {
    return ''
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.includes('abort'))
}

function asAskUserAnswers(updatedInput: unknown): Record<string, string> | undefined {
  if (!updatedInput || typeof updatedInput !== 'object' || Array.isArray(updatedInput)) return undefined
  const answers = (updatedInput as { answers?: unknown }).answers
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return undefined
  return Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, String(value ?? '')]))
}

function peekToolResult(line: string): unknown {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown; data?: { result?: unknown } }
    if (parsed.type !== 'tool_result') return undefined
    return parsed.data?.result ?? parsed.data
  } catch {
    return undefined
  }
}

async function fetchDccContext(sessionId: string, signal: AbortSignal): Promise<unknown> {
  const origin = getBackendUrl().replace(/\/$/, '')
  if (!origin || !sessionId) return undefined
  try {
    const response = await fetch(`${origin}/api/v1/dcc/context?sessionId=${encodeURIComponent(sessionId)}`, { signal })
    const data = await response.json()
    if (data && typeof data === 'object' && (data as { error?: unknown }).error && !(data as { dcc?: unknown }).dcc) {
      return undefined
    }
    return data
  } catch (error) {
    logger.warn('failed to fetch DCC context for coco turn', { error, sessionId })
    return undefined
  }
}

function cocoUsageCapture(agent: AgentEntity, uniqueModelId: string | null | undefined): AgentSessionUsageCapture {
  const { providerId, modelId } = splitAgentModel(uniqueModelId)
  const resolvedProvider = providerId || 'unknown'
  const resolvedModel = modelId || uniqueModelId || 'unknown'
  return {
    owner: 'agent-sdk',
    credentialReceipt: { attribution: 'unknown' },
    providerId: resolvedProvider,
    providerName: resolvedProvider,
    source: {
      type: 'agent',
      id: agent.id,
      name: agent.name || null,
      icon: null
    },
    frozenModels: [
      {
        modelId: resolvedModel,
        modelName: resolvedModel,
        aliases: [...new Set([resolvedModel, uniqueModelId || resolvedModel])],
        pricingSnapshot: null
      }
    ]
  }
}
