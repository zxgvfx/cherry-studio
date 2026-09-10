import { randomUUID } from 'node:crypto'

import { AGENT_RUNTIME_CAPABILITIES } from '@shared/ai/agentRuntimeCapabilities'
import { REPORT_ARTIFACTS_TOOL_NAME } from '@shared/ai/builtinTools'
import { pipelineAssetDisplayName } from '@shared/ai/pipelinePreview'
import type { CherryUIMessageChunk } from '@shared/data/types/message'
import type {
  PipelineAssetPartData,
  PipelineRunProgressPartData,
  PipelineRunStepProgress
} from '@shared/data/types/uiParts'

import { extractRunAssets } from './pipelineAssets'
import { pipelineApiBase } from './pipelineClient'

const COCO_TRANSPORT = AGENT_RUNTIME_CAPABILITIES.coco.transport
const PIPELINE_STATUS_PART_ID = 'coco-pipeline-status'
const CANVAS_TOOLS = new Set([
  'script.propose',
  'graph_proposal',
  'graph.diff',
  'graph.validate',
  'graph.to_script',
  'script.compile'
])

export interface CocoStreamSink {
  enqueue(chunk: CherryUIMessageChunk): void
}

export interface CocoTurnUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens?: number
  noCacheTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export const ASK_USER_TOOL_NAME = 'AskUserQuestion'
const ASK_USER_SKILL = 'interaction.ask_user'

export type CocoAskUserRequest = {
  toolCallId: string
  input: Record<string, unknown>
}

export type CocoPipelineHandleResult =
  | 'continue'
  | 'completed'
  | 'cancelled'
  | { error: string }
  | { awaitingUser: CocoAskUserRequest }

export class CocoStreamAdapter {
  private textId: string | null = null
  private readonly pending = new Map<string, string>()
  private readonly lastCallByName = new Map<string, string>()
  readonly emittedPipelineAssets: PipelineAssetPartData[] = []
  submittedGraphThisTurn = false
  lastRunId: string | null = null
  lastRunStatus = ''
  lastStillRunning = false
  private readonly emittedReviewRuns = new Set<string>()
  lastUsage: CocoTurnUsage | null = null

  constructor(private readonly sink: CocoStreamSink) {}

  handleEvent(event: unknown): CocoPipelineHandleResult {
    if (!event || typeof event !== 'object') return 'continue'
    const type = (event as { type?: unknown }).type
    const data =
      (event as { data?: unknown }).data && typeof (event as { data?: unknown }).data === 'object'
        ? ((event as { data: Record<string, unknown> }).data ?? {})
        : {}

    if (type === 'delta') {
      this.appendText(String(data.text || data.delta || data.content || ''))
      return 'continue'
    }

    if (type === 'message' && data.role === 'assistant') {
      // Pipeline often emits token `delta`s then a final `message` with the
      // full accumulated text. Re-appending that body duplicates the reply.
      if (!this.textId) this.appendText(String(data.content || ''))
      this.endText()
      return 'continue'
    }

    if (type === 'tool_started' || type === 'tool_started') {
      this.endText()
      const toolName = String(data.name || data.tool_name || 'tool')
      if (toolName === 'submit.graph') this.submittedGraphThisTurn = true
      const toolCallId = readString(data.tool_call_id, data.id) || randomUUID()
      this.pending.set(toolCallId, toolName)
      this.lastCallByName.set(toolName, toolCallId)
      const args = data.arguments ?? data.args ?? {}
      if (toolName === ASK_USER_SKILL) return 'continue'
      this.emitToolStart(toolCallId, toolName, args)
      this.emitToolPhaseCard(toolName, args)
      return 'continue'
    }

    if (type === 'run_progress' || type === 'run_progress') {
      this.emitRunProgress(data)
      return 'continue'
    }

    if (type === 'heartbeat') {
      return 'continue'
    }

    if (type === 'tool_result' || type === 'tool_result') {
      const named = String(data.name || data.tool_name || '')
      let toolCallId = readString(data.tool_call_id, data.id)
      if (!toolCallId || !this.pending.has(toolCallId)) {
        toolCallId = (named && this.lastCallByName.get(named)) || toolCallId || randomUUID()
      }
      const toolName = named || this.pending.get(toolCallId) || 'tool'
      if (toolName === 'submit.graph') this.submittedGraphThisTurn = true
      if (!this.pending.has(toolCallId) && toolName !== ASK_USER_SKILL) this.emitToolStart(toolCallId, toolName, {})
      this.pending.delete(toolCallId)
      const result = data.result != null ? data.result : data
      if (toolName === ASK_USER_SKILL) {
        const record = asRecord(result)
        if (record?.ok === false || !asRecord(record?.interaction)) {
          this.emitToolStart(toolCallId, toolName, {})
          this.sink.enqueue({
            type: 'tool-output-available',
            toolCallId,
            output: result,
            dynamic: true,
            providerExecuted: true,
            providerMetadata: toolProviderMetadata(toolName)
          })
          if (this.lastCallByName.get(toolName) === toolCallId) this.lastCallByName.delete(toolName)
        }
        return 'continue'
      }
      if (this.lastCallByName.get(toolName) === toolCallId) this.lastCallByName.delete(toolName)
      this.sink.enqueue({
        type: 'tool-output-available',
        toolCallId,
        output: result,
        dynamic: true,
        providerExecuted: true,
        providerMetadata: toolProviderMetadata(toolName)
      })
      this.emitToolResultProgress(toolName, result)
      this.emitPipelineAssets(extractRunAssets(result, { toolName }))
      return 'continue'
    }

    if (type === 'user_question') {
      this.endText()
      const input = pipelineQuestionToAskUserInput(data)
      const toolCallId = this.lastCallByName.get(ASK_USER_SKILL) || `coco-ask-${randomUUID()}`
      this.emitToolStart(toolCallId, ASK_USER_TOOL_NAME, input)
      return { awaitingUser: { toolCallId, input } }
    }

    if (type === 'graph_proposal') {
      this.endText()
      // script.propose/canvas.extend emit graph_proposal immediately before
      // their authoritative tool_result. Reusing both as independent tool
      // cards duplicates the proposal and can hide the actionable card in the
      // collapsed process trace. Let the following tool_result complete the
      // existing call; only synthesize a card for standalone proposals.
      const activeProposalCall = this.lastCallByName.get('script.propose') || this.lastCallByName.get('canvas.extend')
      if (activeProposalCall) {
        this.emitCanvasProgress('success', readString(data.description) || '画布模板已更新')
        return 'continue'
      }
      const toolCallId = randomUUID()
      const toolName = 'script.propose'
      this.emitToolStart(toolCallId, toolName, { description: data.description || 'pipeline script proposal' })
      this.sink.enqueue({
        type: 'tool-output-available',
        toolCallId,
        output: data,
        dynamic: true,
        providerExecuted: true,
        providerMetadata: toolProviderMetadata(toolName)
      })
      this.emitCanvasProgress('success', readString(data.description) || '画布模板已更新')
      return 'continue'
    }

    if (type === 'error') {
      return { error: String(data.message || data.error || 'COCO agent error') }
    }

    if (type === 'completed' || type === 'cancelled') {
      this.endText()
      this.lastUsage = readCocoTurnUsage(data) ?? readCocoTurnUsage(event)
      return type
    }

    return 'continue'
  }

  finishOpenParts(): void {
    this.endText()
  }

  presentPipelineAssets(assets: PipelineAssetPartData[]): void {
    const seen = new Set(this.emittedPipelineAssets.map((asset) => asset.assetId))
    this.emitPipelineAssets(assets.filter((asset) => asset.assetId && !seen.has(asset.assetId)))
  }

  completeAskUser(toolCallId: string, output: unknown): void {
    this.sink.enqueue({
      type: 'tool-output-available',
      toolCallId,
      output,
      dynamic: true,
      providerExecuted: true,
      providerMetadata: toolProviderMetadata(ASK_USER_TOOL_NAME)
    })
  }

  private appendText(text: string): void {
    if (!text) return
    if (!this.textId) {
      this.textId = `coco-text-${randomUUID()}`
      this.sink.enqueue({ type: 'text-start', id: this.textId })
    }
    this.sink.enqueue({ type: 'text-delta', id: this.textId, delta: text })
  }

  private endText(): void {
    if (!this.textId) return
    this.sink.enqueue({ type: 'text-end', id: this.textId })
    this.textId = null
  }

  private emitToolPhaseCard(toolName: string, args: unknown): void {
    if (isCanvasTool(toolName)) {
      this.emitCanvasProgress('running', canvasMessageFromArgs(args) || '正在改画布模板')
      return
    }
    if (isSubmitGraph(toolName)) {
      this.emitPipelineProgress({
        phase: 'run',
        runId: 'pending',
        status: 'pending',
        message: '正在提交并运行工作流…'
      })
    }
  }

  private emitToolResultProgress(toolName: string, result: unknown): void {
    const record = asRecord(result) ?? {}
    const run = asRecord(record.run)
    if (isSubmitGraph(toolName) || readString(run?.run_id, record.run_id)) {
      this.emitRunProgress(record)
      return
    }
    if (isCanvasTool(toolName)) {
      const ok = record.ok !== false && record.error == null
      this.emitCanvasProgress(
        ok ? 'success' : 'failed',
        canvasMessageFromArgs(record) || (ok ? '画布模板已更新' : '画布模板更新失败')
      )
    }
  }

  private emitCanvasProgress(status: string, message: string): void {
    this.emitPipelineProgress({
      phase: 'canvas',
      runId: 'canvas',
      status,
      message
    })
  }

  private emitRunProgress(data: Record<string, unknown>): void {
    const run = asRecord(data.run) ?? data
    const runId = readString(run.run_id, data.run_id)
    const eventPhase = readString(data.phase)
    const isRunEvent = eventPhase === 'run' || eventPhase === 'waiting' || eventPhase === 'finished'
    if (!runId && !isRunEvent && data.timed_out !== true && data.still_running !== true) return
    const status = readString(run.status, data.status) || (isRunEvent ? 'running' : '')
    if (!status && data.timed_out !== true && data.still_running !== true) return
    const current = asRecord(run.current_step) ?? {}
    const interactiveUrl = resolvePipelineUrl(
      readString(run.interactive_url, data.interactive_url, current.interactive_url)
    )
    const steps = mapRunSteps(run.steps)
    const queueItems = mapQueueItems(run.queue_status, steps)
    const queueLines = mapQueueLines(run.queue_lines, queueItems)
    const queue = queueLines.join(' · ') || formatQueue(run.queue_label ?? run.queue ?? data.queue)
    const elapsed = typeof run.elapsed_seconds === 'number' ? run.elapsed_seconds : undefined
    const progressValue = current.progress
    const progress = typeof progressValue === 'number' ? progressValue : undefined
    const message = readString(data.message, current.progress_message)
    const stepId = readString(current.step_id, run.awaiting_step)
    const stepLabel = readString(current.node_id, current.step_id, run.awaiting_step)
    const workflowId = readString(run.workflow_id, data.workflow_id)
    const summary = readString(run.summary)
    const queuedCount = typeof run.queued_count === 'number' ? run.queued_count : undefined
    this.emitPipelineProgress({
      phase: 'run',
      runId: runId || 'pending',
      status,
      ...(workflowId ? { workflowId } : {}),
      ...(message ? { message } : {}),
      ...(stepId ? { stepId } : {}),
      ...(stepLabel ? { stepLabel } : {}),
      ...(progress != null ? { progress } : {}),
      ...(queue ? { queue } : {}),
      ...(queueLines.length ? { queueLines } : {}),
      ...(queueItems.length ? { queueItems } : {}),
      ...(queuedCount != null ? { queuedCount } : {}),
      ...(summary ? { summary } : {}),
      ...(steps.length ? { steps } : {}),
      ...(elapsed != null ? { elapsedSeconds: elapsed } : {}),
      ...(interactiveUrl ? { interactiveUrl } : {}),
      ...(data.timed_out === true ? { timedOut: true } : {}),
      ...(data.still_running === true ? { stillRunning: true } : {})
    })
    if (runId && runId !== 'pending') this.lastRunId = runId
    this.lastRunStatus = status
    this.lastStillRunning = data.still_running === true || status === 'running' || status === 'pending'
    const reviewRunId = runId || 'pending'
    if (status === 'awaiting_human' && interactiveUrl) {
      this.emittedReviewRuns.add(reviewRunId)
      this.sink.enqueue({
        type: 'data-pipeline-review',
        id: `coco-run-review-${reviewRunId}`,
        data: {
          runId: reviewRunId,
          url: interactiveUrl,
          ...(stepId ? { stepId } : {}),
          title: '人工审核'
        }
      })
    } else if (
      reviewRunId &&
      this.emittedReviewRuns.has(reviewRunId) &&
      status !== 'awaiting_human' &&
      status !== 'awaiting_approval'
    ) {
      this.sink.enqueue({
        type: 'data-pipeline-review',
        id: `coco-run-review-${reviewRunId}`,
        data: {
          runId: reviewRunId,
          url: '',
          closed: true
        }
      })
    }
  }

  private emitPipelineProgress(data: PipelineRunProgressPartData): void {
    this.endText()
    this.sink.enqueue({
      type: 'data-pipeline-run-progress',
      id: PIPELINE_STATUS_PART_ID,
      data
    })
  }

  private emitPipelineAssets(assets: PipelineAssetPartData[]): void {
    if (assets.length === 0) return
    this.emittedPipelineAssets.push(...assets)
    this.endText()
    for (const asset of assets) {
      this.sink.enqueue({
        type: 'data-pipeline-asset',
        id: `coco-asset-${asset.assetId}`,
        data: asset
      })
    }
    const files = assets.filter((asset) => asset.localPath)
    if (files.length === 0) return
    const toolCallId = `coco-artifacts-${randomUUID()}`
    this.emitToolStart(toolCallId, REPORT_ARTIFACTS_TOOL_NAME, {
      artifacts: files.map((asset) => ({
        path: asset.localPath,
        description: pipelineAssetDisplayName(asset)
      })),
      summary: files.map((asset) => pipelineAssetDisplayName(asset)).join('、')
    })
    this.sink.enqueue({
      type: 'tool-output-available',
      toolCallId,
      output: { ok: true },
      dynamic: true,
      providerExecuted: true,
      providerMetadata: toolProviderMetadata(REPORT_ARTIFACTS_TOOL_NAME)
    })
  }

  private emitToolStart(toolCallId: string, toolName: string, input: unknown): void {
    this.sink.enqueue({
      type: 'tool-input-start',
      toolCallId,
      toolName,
      providerExecuted: true,
      dynamic: true,
      providerMetadata: toolProviderMetadata(toolName)
    })
    this.sink.enqueue({
      type: 'tool-input-available',
      toolCallId,
      toolName,
      input: input ?? {},
      providerExecuted: true,
      dynamic: true,
      providerMetadata: toolProviderMetadata(toolName)
    })
  }
}

function toolProviderMetadata(toolName: string) {
  return {
    cherry: {
      transport: COCO_TRANSPORT,
      tool: { type: 'builtin', name: toolName }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function readString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function readNonNegInt(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value)
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed)
    }
  }
  return 0
}

export function readCocoTurnUsage(raw: unknown): CocoTurnUsage | null {
  const record = asRecord(raw)
  if (!record) return null
  const nested = asRecord(record.usage) ?? record
  const inputTokens = readNonNegInt(nested.inputTokens, nested.input_tokens, nested.prompt_tokens, nested.promptTokens)
  const outputTokens = readNonNegInt(
    nested.outputTokens,
    nested.output_tokens,
    nested.completion_tokens,
    nested.completionTokens
  )
  const cacheReadTokens = readNonNegInt(
    nested.cacheReadTokens,
    nested.cache_read_input_tokens,
    nested.cache_read_tokens
  )
  const cacheWriteTokens = readNonNegInt(
    nested.cacheWriteTokens,
    nested.cache_creation_input_tokens,
    nested.cache_write_tokens
  )
  const reasoningTokens = readNonNegInt(nested.reasoningTokens, nested.reasoning_tokens)
  const totalTokens = readNonNegInt(nested.totalTokens, nested.total_tokens, inputTokens + outputTokens)
  if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens) return null
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens || inputTokens + outputTokens,
    ...(reasoningTokens ? { reasoningTokens } : {}),
    noCacheTokens: Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens),
    cacheReadTokens,
    cacheWriteTokens
  }
}

function formatQueue(queue: unknown): string {
  if (typeof queue === 'string') return queue.trim()
  if (typeof queue === 'number') return String(queue)
  const record = asRecord(queue)
  if (!record) return ''
  const bits = [
    'message',
    'status',
    'phase',
    'stage',
    'queue',
    'position',
    'queue_position',
    'ahead_count',
    'pending',
    'running',
    'eta_seconds',
    'eta',
    'wait'
  ]
    .map((key) => record[key])
    .filter((value) => value != null && String(value).trim())
    .map((value) => String(value).trim())
  return bits.join(' · ')
}

function isCanvasTool(toolName: string): boolean {
  return CANVAS_TOOLS.has(toolName) || toolName.endsWith('script.propose')
}

function isSubmitGraph(toolName: string): boolean {
  return toolName === 'submit.graph' || toolName.endsWith('submit.graph')
}

function canvasMessageFromArgs(args: unknown): string {
  const record = asRecord(args)
  if (!record) return ''
  return readString(record.description, record.message, asRecord(record.change_set)?.description)
}

function mapRunSteps(raw: unknown): PipelineRunStepProgress[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    const record = asRecord(item)
    if (!record) return []
    const stepId = readString(record.step_id)
    const nodeId = readString(record.node_id)
    const state = readString(record.state) || 'pending'
    const meta = asRecord(record.progress_meta)
    const queue = asRecord(record.service_queue) ?? asRecord(meta?.service_queue) ?? null
    return [
      {
        stepId,
        nodeId,
        state,
        ...(typeof record.progress === 'number' ? { progress: record.progress } : {}),
        ...(readString(record.progress_message) ? { message: readString(record.progress_message) } : {}),
        ...(queue ? { queue } : {})
      }
    ]
  })
}

function mapQueueItems(raw: unknown, steps: PipelineRunStepProgress[]): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => {
      const record = asRecord(item)
      return record ? [record] : []
    })
  }
  return steps.flatMap((step) => (step.queue ? [{ step_id: step.stepId, node_id: step.nodeId, ...step.queue }] : []))
}

function mapQueueLines(raw: unknown, items: Record<string, unknown>[]): string[] {
  if (Array.isArray(raw)) {
    return raw.map((line) => String(line ?? '').trim()).filter(Boolean)
  }
  return items.flatMap((item) => queueItemLines(item))
}

function queueItemLines(item: Record<string, unknown>): string[] {
  const labels: Array<[string, string]> = [
    ['step_id', '节点'],
    ['node_id', '节点类型'],
    ['phase', '阶段'],
    ['stage', '工序'],
    ['status', '状态'],
    ['message', '说明'],
    ['position', '排队位置'],
    ['ahead_count', '前方还有'],
    ['eta_seconds', '预计等待(秒)'],
    ['pending', '队列待处理'],
    ['running', '队列运行中'],
    ['worker_id', 'Worker'],
    ['online_workers', '在线 Worker'],
    ['active_workers', '忙碌 Worker'],
    ['capacity', '容量'],
    ['task_id', '任务 ID'],
    ['job_id', 'Job ID']
  ]
  const seen = new Set(['queue', 'workers'])
  const lines: string[] = []
  for (const [key, label] of labels) {
    const value = item[key]
    if (value == null || String(value).trim() === '') continue
    seen.add(key)
    lines.push(`${label}：${String(value).trim()}`)
  }
  for (const [key, value] of Object.entries(item)) {
    if (seen.has(key) || value == null || value === '') continue
    if (typeof value === 'object') {
      lines.push(`${key}：${JSON.stringify(value)}`)
      continue
    }
    lines.push(`${key}：${String(value)}`)
  }
  return lines
}

function resolvePipelineUrl(url: string): string {
  if (!url) return ''
  if (/^https?:\/\//i.test(url)) return url
  const base = pipelineApiBase().replace(/\/+$/, '')
  return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`
}

function isPipelineFreeTextOption(label: string): boolean {
  const normalized = label.trim().toLowerCase()
  return (
    normalized === '其他' ||
    normalized === '其它' ||
    normalized === 'other' ||
    normalized === 'custom' ||
    normalized === '自定义'
  )
}

export function pipelineQuestionToAskUserInput(data: Record<string, unknown>): Record<string, unknown> {
  const question = readString(data.question) || '请选择'
  const rawOptions = Array.isArray(data.options)
    ? data.options.map((item) => String(item ?? '').trim()).filter(Boolean)
    : []
  const options = [...rawOptions]
  if (options.length === 0) options.push('继续', '取消')
  if (!options.some(isPipelineFreeTextOption) && options.length < 8) options.push('其他')
  if (options.length > 8) options.length = 8
  return {
    questions: [
      {
        question,
        header: '请选择',
        options: options.map((label) => ({ label })),
        multiSelect: data.allow_multiple === true
      }
    ]
  }
}

export function formatAskUserAnswer(updatedInput: unknown): string {
  const record = asRecord(updatedInput)
  const answers = asRecord(record?.answers)
  if (!answers) return ''
  return Object.values(answers)
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join('；')
}
