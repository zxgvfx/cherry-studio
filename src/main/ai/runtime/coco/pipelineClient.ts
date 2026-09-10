import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { notifyDataApiDataChange } from '@data/dataApiDataChange'
import { agentService } from '@data/services/AgentService'
import { loggerService } from '@logger'
import { type AgentAttachmentFile, extractAttachmentFiles, extractMessageText } from '@main/ai/runtime/agentUserContent'
import { readCocoMode, readCocoPermission } from '@shared/ai/cocoAgent'
import {
  captionForCocoGenerated,
  captionForCocoUpload,
  type CocoSessionAsset,
  formatCocoAssetSize,
  guessCocoSessionAssetKind,
  mergeCocoSessionAssets,
  normalizeCocoSessionAsset
} from '@shared/ai/cocoSessionAssets'
import type { AgentEntity } from '@shared/data/api/schemas/agents'
import type { AgentSessionMessageEntity } from '@shared/data/api/schemas/agentSessionMessages'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import { parseUniqueModelId } from '@shared/data/types/model'
import { type PipelineAssetPartData, readCherryMeta } from '@shared/data/types/uiParts'
import { Agent } from 'undici'

const logger = loggerService.withContext('CocoPipelineClient')
const DEFAULT_API_BASE = 'http://192.168.21.225:9331'
const PIPELINE_BINDINGS_KEY = 'coco_pipeline_sessions'

/** submit.graph 最长等 3600s；undici 默认 bodyTimeout 是 300s，会把长排队误判成 terminated。 */
export const PIPELINE_STREAM_TIMEOUT_MS = 60 * 60 * 1000

const pipelineStreamDispatcher = new Agent({
  headersTimeout: PIPELINE_STREAM_TIMEOUT_MS,
  bodyTimeout: PIPELINE_STREAM_TIMEOUT_MS
})

export interface CocoPipelineBinding {
  id: string
  revision?: number
  assets?: CocoSessionAsset[]
}

export interface CocoPipelineAttachment {
  filename: string
  mediaType?: string
  assetId: string
  sizeBytes?: number
}

export interface CocoUserTurn {
  content: string
  /**
   * `content` plus the attachments' local paths — for the in-process model loop only.
   * `content` itself is posted to the pipeline server, which must never receive
   * workstation paths, so the path block cannot live there.
   */
  localContent: string
  attachments: CocoPipelineAttachment[]
  uploadedAssets: CocoSessionAsset[]
  /** This turn's attachments that resolved to a real on-disk file, current turn and history. */
  localPaths: CocoLocalAttachmentPath[]
}

export interface CocoLocalAttachmentPath {
  filename: string
  path: string
  assetId: string
}

interface CocoPastedPromptText {
  filename: string
  content: string
}

interface CocoSelectedPipelineNode {
  nodeId: string
  values: Record<string, unknown>
}

export function pipelineApiBase(): string {
  const env = process.env.PIPELINE_API_BASE?.trim()
  if (env) return env.replace(/\/+$/, '')
  const cfg = loadBridgeConfig()
  if (typeof cfg.api_base === 'string' && cfg.api_base.trim()) {
    return cfg.api_base.trim().replace(/\/+$/, '')
  }
  return DEFAULT_API_BASE
}

export function localUsername(): string {
  return process.env.USERNAME || process.env.USER || process.env.LOGNAME || os.userInfo().username || 'unknown'
}

function parseBindingAssets(value: unknown): CocoSessionAsset[] | undefined {
  if (!Array.isArray(value)) return undefined
  const assets = mergeCocoSessionAssets(value)
  return assets.length > 0 ? assets : undefined
}

export function readPipelineBindings(configuration: unknown): Record<string, CocoPipelineBinding> {
  if (!configuration || typeof configuration !== 'object') return {}
  const raw = (configuration as Record<string, unknown>)[PIPELINE_BINDINGS_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, CocoPipelineBinding> = {}
  for (const [sessionId, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const id = (value as { id?: unknown }).id
    if (typeof id !== 'string' || !id) continue
    const revision = (value as { revision?: unknown }).revision
    const assets = parseBindingAssets((value as { assets?: unknown }).assets)
    out[sessionId] = {
      id,
      ...(typeof revision === 'number' ? { revision } : {}),
      ...(assets ? { assets } : {})
    }
  }
  return out
}

export function readCocoDcc(configuration: unknown): { sessionId: string; dccType: string } {
  if (!configuration || typeof configuration !== 'object') return { sessionId: '', dccType: '' }
  const raw = (configuration as { coco_dcc?: unknown }).coco_dcc
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { sessionId: '', dccType: '' }
  const sessionId =
    typeof (raw as { sessionId?: unknown }).sessionId === 'string' ? (raw as { sessionId: string }).sessionId : ''
  const dccType = typeof (raw as { dccType?: unknown }).dccType === 'string' ? (raw as { dccType: string }).dccType : ''
  return { sessionId, dccType }
}

export function readCocoSessionAssetsFromConfiguration(configuration: unknown, sessionId: string): CocoSessionAsset[] {
  return readPipelineBindings(configuration)[sessionId]?.assets ?? []
}

export function sessionAssetsFromPipelineMetadata(metadata: unknown): CocoSessionAsset[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return []
  return mergeCocoSessionAssets((metadata as { session_assets?: unknown }).session_assets)
}

export function sessionAssetFromUpload(options: {
  assetId: string
  filename: string
  mediaType?: string
  previewUrl?: string
  sizeBytes?: number
}): CocoSessionAsset {
  const kind = guessCocoSessionAssetKind(options.filename, options.mediaType)
  return {
    assetId: options.assetId,
    name: options.filename,
    kind,
    origin: 'upload',
    caption: captionForCocoUpload(options.filename),
    createdAt: Date.now(),
    ...(options.previewUrl ? { previewUrl: options.previewUrl } : {}),
    ...(typeof options.sizeBytes === 'number' ? { sizeBytes: options.sizeBytes } : {}),
    ...(options.mediaType ? { assetType: options.mediaType } : {})
  }
}

export function sessionAssetsFromPipelineParts(
  assets: readonly PipelineAssetPartData[],
  options?: { parentAssetId?: string; parentName?: string; workflowId?: string }
): CocoSessionAsset[] {
  return assets.flatMap((asset) => {
    const kind = guessCocoSessionAssetKind(asset.name, asset.assetType)
    const previewUrl = asset.localPath ? pathToFileURL(asset.localPath).href : asset.previewUrl || asset.downloadUrl
    const entry = normalizeCocoSessionAsset({
      assetId: asset.assetId,
      name: asset.name,
      kind,
      origin: 'generated',
      caption: captionForCocoGenerated({
        name: asset.name,
        kind,
        workflowId: options?.workflowId,
        sourceName: options?.parentName
      }),
      runId: asset.runId,
      parentAssetId: options?.parentAssetId,
      previewUrl,
      createdAt: Date.now(),
      ...(typeof asset.sizeBytes === 'number' ? { sizeBytes: asset.sizeBytes } : {}),
      ...(asset.assetType ? { assetType: asset.assetType } : {})
    })
    return entry ? [entry] : []
  })
}

export async function pipelineFetch<T = unknown>(
  pathname: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal; accept?: string } = {}
): Promise<T> {
  const url = `${pipelineApiBase()}${pathname}`
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    signal: options.signal,
    headers: {
      'Content-Type': 'application/json',
      'X-User-Key': localUsername(),
      ...(options.accept ? { Accept: options.accept } : {})
    },
    body: options.body == null ? undefined : JSON.stringify(options.body)
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const message =
      (data && typeof data === 'object' && ('detail' in data || 'message' in data)
        ? String((data as { detail?: unknown; message?: unknown }).detail ?? (data as { message?: unknown }).message)
        : null) ||
      (typeof data === 'string' && data) ||
      `pipeline ${options.method ?? 'GET'} ${pathname} failed: ${res.status}`
    throw new Error(message)
  }
  return data as T
}

export async function pipelineTryFetch<T = unknown>(
  pathname: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {}
): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  const url = `${pipelineApiBase()}${pathname}`
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    signal: options.signal,
    headers: {
      'Content-Type': 'application/json',
      'X-User-Key': localUsername()
    },
    body: options.body == null ? undefined : JSON.stringify(options.body)
  })
  if (res.status === 404 || res.status === 405) return { ok: false, status: res.status }
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const message =
      (data && typeof data === 'object' && ('detail' in data || 'message' in data)
        ? String((data as { detail?: unknown; message?: unknown }).detail ?? (data as { message?: unknown }).message)
        : null) ||
      (typeof data === 'string' && data) ||
      `pipeline ${options.method ?? 'GET'} ${pathname} failed: ${res.status}`
    throw new Error(message)
  }
  return { ok: true, data: data as T }
}

export function pipelineStreamFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    dispatcher: pipelineStreamDispatcher
  } as RequestInit)
}

export async function ensurePipelineSession(
  agent: AgentEntity,
  session: AgentSessionEntity
): Promise<{ pipelineSessionId: string; revision?: number }> {
  const bindings = readPipelineBindings(agent.configuration)
  const existing = bindings[session.id]
  if (existing?.id) return { pipelineSessionId: existing.id, revision: existing.revision }

  const { providerId, modelId } = splitAgentModel(agent.model)
  const cocoDcc = readCocoDcc(agent.configuration)
  const created = await pipelineFetch<{ id: string; revision?: number }>('/api/agents/sessions', {
    method: 'POST',
    body: {
      context: {
        actor_id: localUsername(),
        provider_id: providerId,
        model: modelId,
        mode: readCocoMode(agent.configuration),
        permission_mode: readCocoPermission(agent.configuration),
        allow_write: readCocoPermission(agent.configuration) === 'auto',
        ...(cocoDcc.sessionId ? { dcc_session_id: cocoDcc.sessionId } : {}),
        metadata: {
          coco_owned_canvas: true,
          cherry_agent_id: agent.id,
          cherry_agent_name: agent.name || '',
          cherry_session_id: session.id,
          title: session.name || '',
          ...(cocoDcc.dccType ? { dcc_type: cocoDcc.dccType } : {}),
          provenance: {
            username: localUsername(),
            agent_name: agent.name || '-',
            agent_id: agent.id,
            title: session.name || '-'
          }
        }
      }
    }
  })

  persistPipelineBinding(agent.id, session.id, { id: created.id, revision: created.revision })
  return { pipelineSessionId: created.id, revision: created.revision }
}

export async function branchPipelineSession(
  agent: AgentEntity,
  sourceSessionId: string,
  targetSession: AgentSessionEntity,
  priorUserTurns: number
): Promise<void> {
  const sourceBinding = readPipelineBindings(agent.configuration)[sourceSessionId]
  if (!sourceBinding?.id) return

  const source = await pipelineFetch<{
    context?: Record<string, unknown> & { metadata?: Record<string, unknown> }
  }>(`/api/agents/sessions/${encodeURIComponent(sourceBinding.id)}`)
  const sourceContext = source.context ?? {}
  const sourceMetadata = sourceContext.metadata ?? {}
  const metadata: Record<string, unknown> = {
    ...sourceMetadata,
    cherry_session_id: targetSession.id,
    title: targetSession.name || '',
    branch: {
      source_cherry_session_id: sourceSessionId,
      source_pipeline_session_id: sourceBinding.id
    },
    provenance: {
      ...(typeof sourceMetadata.provenance === 'object' && sourceMetadata.provenance ? sourceMetadata.provenance : {}),
      title: targetSession.name || '-'
    }
  }
  delete metadata.current_user_text
  delete metadata.canvas_working_change
  delete metadata.attachments

  const context = {
    ...sourceContext,
    run_id: null,
    metadata
  }
  let created: { id: string; revision?: number }
  try {
    created = await pipelineFetch<{ id: string; revision?: number }>(
      `/api/agents/sessions/${encodeURIComponent(sourceBinding.id)}/branches`,
      {
        method: 'POST',
        body: {
          user_turns: priorUserTurns,
          context
        }
      }
    )
  } catch (error) {
    if (!/(?:404|405|not found|method not allowed)/i.test(String(error))) throw error
    logger.warn('Pipeline branch endpoint unavailable; cloning canvas context without message history')
    created = await pipelineFetch<{ id: string; revision?: number }>('/api/agents/sessions', {
      method: 'POST',
      body: { context }
    })
  }
  persistPipelineBinding(agent.id, targetSession.id, {
    id: created.id,
    revision: created.revision,
    assets: sourceBinding.assets
  })
}

export function persistPipelineBinding(agentId: string, sessionId: string, binding: CocoPipelineBinding): void {
  const agent = agentService.getAgent(agentId)
  if (!agent) return
  const previous = readPipelineBindings(agent.configuration)
  const current = previous[sessionId]
  const mergedAssets = mergeCocoSessionAssets(current?.assets, binding.assets)
  const nextBinding: CocoPipelineBinding = {
    id: binding.id,
    revision: binding.revision ?? current?.revision,
    ...(mergedAssets.length > 0 ? { assets: mergedAssets } : {})
  }
  const next = { ...previous, [sessionId]: nextBinding }
  try {
    agentService.updateAgent(agentId, { configuration: { coco_pipeline_sessions: next } })
    notifyDataApiDataChange([{ endpoint: '/agents/:agentId', entityIds: [agentId], routeParams: { agentId } }])
  } catch (error) {
    logger.warn('Failed to persist coco pipeline session binding', error as Error)
  }
}

export function splitAgentModel(model: string | null | undefined): {
  providerId: string | null
  modelId: string | null
} {
  if (!model) return { providerId: null, modelId: null }
  if (!model.includes('::')) return { providerId: null, modelId: model }
  try {
    return parseUniqueModelId(model as `${string}::${string}`)
  } catch {
    return { providerId: null, modelId: model }
  }
}

export async function buildCocoUserTurn(
  message: AgentSessionMessageEntity,
  signal?: AbortSignal,
  options?: {
    agentId?: string
    sessionId?: string
    pipelineSessionId?: string
    extraFiles?: AgentAttachmentFile[]
    sessionAssets?: CocoSessionAsset[]
    priorUserTexts?: string[]
    canvasGraph?: unknown
    dccContext?: unknown
    resolveFileEntryPath?: (fileEntryId: string) => string
  }
): Promise<CocoUserTurn> {
  const text = extractMessageText(message).trim()
  const selectedPipelineNodes = extractSelectedPipelineNodes(message)
  const currentFiles = extractAttachmentFiles(message)
  if (currentFiles.length > 0 && isIncompleteCocoAttachmentInstruction(text)) {
    throw new Error('检测到附件后的任务指令未完整提交，请重新输入完整要求后再发送。画布和节点均未执行。')
  }
  const files = mergeAttachmentFiles(currentFiles, options?.extraFiles)
  const attachments: CocoPipelineAttachment[] = []
  const localPaths: CocoLocalAttachmentPath[] = []
  const uploadedAssets: CocoSessionAsset[] = []
  const pastedTexts: CocoPastedPromptText[] = []
  const currentPastedKeys = new Set(
    currentFiles.filter((file) => isPromptTextAttachment(file)).map((file) => file.filename.trim().toLowerCase())
  )
  for (const file of files) {
    const resolved = resolveAttachmentFile(file, options?.resolveFileEntryPath)
    if (isPromptTextAttachment(resolved)) {
      const onCurrentTurn = currentPastedKeys.has(resolved.filename.trim().toLowerCase())
      if (onCurrentTurn) {
        const content = await readPromptTextFile(resolved)
        if (content.trim()) pastedTexts.push({ filename: resolved.filename, content })
      }
      continue
    }
    const sizeBytes = attachmentSizeBytes(resolved, options?.sessionAssets)
    if (file.pipelineAssetId) {
      attachments.push({
        filename: resolved.filename,
        ...(resolved.mediaType ? { mediaType: resolved.mediaType } : {}),
        assetId: file.pipelineAssetId,
        ...(sizeBytes != null ? { sizeBytes } : {})
      })
      if (resolved.path) {
        localPaths.push({ filename: resolved.filename, path: resolved.path, assetId: file.pipelineAssetId })
      }
      continue
    }
    if (!resolved.path) continue
    const uploaded = await uploadPipelineAsset(resolved, signal, {
      pipelineSessionId: options?.pipelineSessionId,
      cherrySessionId: options?.sessionId
    })
    const uploadedSize = uploaded.sizeBytes ?? sizeBytes
    attachments.push({
      filename: resolved.filename,
      ...(resolved.mediaType ? { mediaType: resolved.mediaType } : {}),
      assetId: uploaded.id,
      ...(uploadedSize != null ? { sizeBytes: uploadedSize } : {})
    })
    localPaths.push({ filename: resolved.filename, path: resolved.path, assetId: uploaded.id })
    uploadedAssets.push(
      sessionAssetFromUpload({
        assetId: uploaded.id,
        filename: resolved.filename,
        mediaType: resolved.mediaType,
        previewUrl: pathToFileURL(resolved.path).href,
        sizeBytes: uploadedSize
      })
    )
  }
  if (options?.agentId && options.sessionId && options.pipelineSessionId && uploadedAssets.length > 0) {
    persistPipelineBinding(options.agentId, options.sessionId, {
      id: options.pipelineSessionId,
      assets: uploadedAssets
    })
  }
  const content = formatCocoUserContent(text, {
    attachments,
    sessionAssets: options?.sessionAssets,
    priorUserTexts: options?.priorUserTexts,
    selectedPipelineNodes,
    canvasGraph: options?.canvasGraph,
    dccContext: options?.dccContext,
    pastedTexts
  })
  const baseContent = content || (attachments.length > 0 ? ATTACHMENT_ONLY_TURN_PROMPT : '')
  const pathBlock = formatCocoLocalAttachmentPaths(localPaths)
  return {
    content: baseContent,
    localContent: pathBlock && baseContent ? `${baseContent}\n\n${pathBlock}` : baseContent,
    attachments,
    uploadedAssets,
    localPaths
  }
}

/**
 * Attachments with no instruction. "请处理本轮附件" used to stand here, which in
 * this prompt's vocabulary reads as "run a node", so a bare upload triggered a
 * generation run the user never asked for.
 */
const ATTACHMENT_ONLY_TURN_PROMPT =
  '用户只发了附件、没有写要求。先说明收到了哪些文件，再询问是要读文件内容，还是要用它产出素材。不要擅自建画布或跑节点。'

function formatCocoLocalAttachmentPaths(files: readonly CocoLocalAttachmentPath[]): string {
  if (files.length === 0) return ''
  return [
    '[本轮附件本地路径]',
    '这些路径是本机真实文件。读文档正文或看图片内容时把路径传给对应的读取/看图工具，不要把 asset_id 当路径传。',
    '路径仅供本地读取，禁止写进节点 config 或提交到画布 —— 节点输入只能用 asset_id。',
    ...files.map((file) => `- ${file.filename}: ${file.path} (asset_id=${file.assetId})`)
  ].join('\n')
}

export async function uploadPipelineAsset(
  file: { path: string; filename: string; mediaType?: string },
  signal?: AbortSignal,
  meta?: { pipelineSessionId?: string; cherrySessionId?: string }
): Promise<{ id: string; sizeBytes?: number }> {
  const bytes = await fs.promises.readFile(file.path)
  const form = new FormData()
  const assetType = guessPipelineAssetType(file.mediaType, file.filename)
  if (assetType) form.append('asset_type', assetType)
  form.append('produced_by_tool', 'cherrystudio:coco-runtime')
  form.append('operator', localUsername())
  form.append('origin', 'upload')
  if (meta?.pipelineSessionId) form.append('agent_session_id', meta.pipelineSessionId)
  if (meta?.cherrySessionId) form.append('cherry_session_id', meta.cherrySessionId)
  form.append('file', new Blob([bytes], { type: file.mediaType || 'application/octet-stream' }), file.filename)

  const res = await fetch(`${pipelineApiBase()}/api/assets/upload`, {
    method: 'POST',
    signal,
    headers: { 'X-User-Key': localUsername() },
    body: form
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  const id =
    data && typeof data === 'object' && typeof (data as { id?: unknown }).id === 'string'
      ? (data as { id: string }).id
      : ''
  if (!res.ok || !id) {
    const detail =
      (data && typeof data === 'object' && ('detail' in data || 'message' in data)
        ? String((data as { detail?: unknown; message?: unknown }).detail ?? (data as { message?: unknown }).message)
        : null) ||
      (typeof data === 'string' && data) ||
      `pipeline upload failed: ${res.status}`
    throw new Error(`无法上传附件 ${file.filename}：${detail}`)
  }
  const sizeBytes =
    data && typeof data === 'object' && typeof (data as { size_bytes?: unknown }).size_bytes === 'number'
      ? (data as { size_bytes: number }).size_bytes
      : bytes.length
  return { id, sizeBytes }
}

export function guessPipelineAssetType(mediaType?: string, filename?: string): string | undefined {
  if (mediaType?.startsWith('image/')) return 'media/image'
  if (mediaType?.startsWith('video/')) return 'media/video'
  const ext = path.extname(filename || '').toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.exr'].includes(ext)) {
    return 'media/image'
  }
  if (['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.mpeg', '.mpg', '.wmv'].includes(ext)) {
    return 'media/video'
  }
  return undefined
}

const GENERIC_FOLLOWUP = /^(继续|重新生成|再试一次|重试|retry|continue|regen)$/iu

function namedPipelineNodesFromText(text: string): CocoSelectedPipelineNode[] {
  const prompt = stripCocoContextBlocks(text)
  const seen = new Set<string>()
  const nodes: CocoSelectedPipelineNode[] = []
  const pattern = /\/(workflow\.[A-Za-z][\w.-]+|[a-z][\w-]*\.[A-Za-z][\w.-]+)/g
  for (const match of prompt.matchAll(pattern)) {
    const nodeId = match[1]
    if (!nodeId || seen.has(nodeId)) continue
    seen.add(nodeId)
    nodes.push({ nodeId, values: {} })
  }
  return nodes
}

function mergeSelectedPipelineNodes(
  fromComposer: readonly CocoSelectedPipelineNode[],
  fromText: readonly CocoSelectedPipelineNode[]
): CocoSelectedPipelineNode[] {
  const seen = new Set(fromComposer.map((item) => item.nodeId))
  return [...fromComposer, ...fromText.filter((item) => !seen.has(item.nodeId))]
}

function extractSelectedPipelineNodes(message: AgentSessionMessageEntity): CocoSelectedPipelineNode[] {
  const selected: CocoSelectedPipelineNode[] = []
  const seen = new Set<string>()
  for (const part of message.data?.parts ?? []) {
    if (part.type !== 'text') continue
    for (const token of readCherryMeta(part)?.composer?.tokens ?? []) {
      if (token.kind !== 'pipelineNode') continue
      const payload = token.payload
      if (!payload || !('nodeId' in payload) || typeof payload.nodeId !== 'string' || !payload.nodeId) continue
      if (seen.has(payload.nodeId)) continue
      seen.add(payload.nodeId)
      selected.push({
        nodeId: payload.nodeId,
        values:
          'values' in payload && payload.values && typeof payload.values === 'object' && !Array.isArray(payload.values)
            ? payload.values
            : {}
      })
    }
  }
  return mergeSelectedPipelineNodes(selected, namedPipelineNodesFromText(extractMessageText(message)))
}

function canvasGraphForPrompt(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const graph = value as Record<string, unknown>
  return graph.dag && typeof graph.dag === 'object' && !Array.isArray(graph.dag)
    ? (graph.dag as Record<string, unknown>)
    : graph
}

const TRAILING_SENTENCE_PUNCTUATION = /[，,。.!！?？;；]+$/u
const INCOMPLETE_ATTACHMENT_LEAD =
  /^(?:请|麻烦|帮|帮我|请帮|请帮我|能否|可以|我要|我想|需要|将|把|用|使用|利用|对|给|让|基于|根据|按照|参考|结合|通过|从|在|向|为|关于|作为|please|can you|could you|use|using|with|based on)$/iu
const INCOMPLETE_ATTACHMENT_SUFFIX =
  /(?:并且|然后|以及|接着|之后|或者|同时|再然后|使用|利用|基于|根据|按照|结合|通过|关于|作为|转换为|修改为|改为|变成|改成|\b(?:and|then|with|to|as|using|based on|convert to|change to))$/iu
const EMPTY_ATTACHMENT_FIELD =
  /(?:提示词|要求|参数|格式|风格|输出|目标|内容|描述|指令|prompt|requirements?|parameters?|format|style|output|description)\s*[:：]\s*$/iu

export function isIncompleteCocoAttachmentInstruction(text: string): boolean {
  const prompt = stripCocoContextBlocks(text).trim()
  if (!prompt) return false
  if (EMPTY_ATTACHMENT_FIELD.test(prompt)) return true

  const withoutTerminalPunctuation = prompt.replace(TRAILING_SENTENCE_PUNCTUATION, '').trim()
  if (INCOMPLETE_ATTACHMENT_LEAD.test(withoutTerminalPunctuation)) return true
  return INCOMPLETE_ATTACHMENT_SUFFIX.test(withoutTerminalPunctuation)
}

const SKIP_CANVAS_NODE_IDS = new Set(['io.workflow-output', 'io.workflow-input'])

const CANVAS_NEW_TASK_RULES = [
  '先分辨本轮属于哪类：要产出或修改素材才走画布；只是读文件内容或问答（看/分析/总结/提取/校对）就不要建画布、不要 submit.graph，读完内容直接回答。',
  '属于产出类时，把用户任务做成可运行的画布：单步直接落地；有依赖的多步写进同一张图再一次跑完。',
  '先读当前画布脚本，再查 nodes.list 与 workflows.list，然后再理解用户这句话。',
  '用户点名了 /node.id 或 /workflow.xxx 时必须用它，禁止换成别的工具。',
  '用户只描述了能力、没有点名工具时：本轮必须先查 nodes.list 与 workflows.list，不能靠上一轮记忆或画布上已有的生图节点跳过。',
  '查完之前禁止改已有生成节点的 prompt，也禁止直接上通用生成/改图节点。目录里有对得上的专用节点或工作流就用它，从 step.output 接线。',
  '产出类任务里用户 @ 了文件或带了附件时，那就是节点输入，禁止再问连哪个文件或哪张参考图。',
  '唯一匹配就直接用，不要提问；多个能力重叠则 interaction.ask_user 列出候选项，禁止盲猜。',
  '本轮用户句子是新任务，不是重跑上一轮。',
  '禁止用与已有节点完全相同的 config 再跑一遍（会缓存命中、得到同一张图）。',
  '只有选定的节点确实有文本端口时才写提示词：原话已是完整提示词则原样用；原话只是增量约束且选中的是带文本端口的生成/编辑节点，才把上游主体与本轮约束合成。',
  '需要参考上一轮产物时，用目录里能吃上游产物的节点并从 step.output 连线，不要复制旧节点。',
  '文本类输入（prompt / negative_prompt 等）必须是自然语言正文。禁止把 asset_id、文件 UUID 或文件名填进这些字段。'
]

function canvasHasWorkNodes(canvasGraph: unknown): boolean {
  const graph = canvasGraphForPrompt(canvasGraph)
  const nodes = graph?.nodes && typeof graph.nodes === 'object' && !Array.isArray(graph.nodes) ? graph.nodes : {}
  return Object.values(nodes).some((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const nodeId = String((value as { node_id?: unknown }).node_id || '')
    return Boolean(nodeId) && !SKIP_CANVAS_NODE_IDS.has(nodeId)
  })
}

function formatCanvasEditRequirement(
  selectedPipelineNodes: readonly CocoSelectedPipelineNode[],
  canvasGraph: unknown,
  prompt: string
): string {
  const graph = canvasGraphForPrompt(canvasGraph)
  const nodes = graph?.nodes && typeof graph.nodes === 'object' && !Array.isArray(graph.nodes) ? graph.nodes : {}
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  if (selectedPipelineNodes.length > 0) {
    const policy = [
      '画布编辑策略：recompose_allowed。Agent 可以按本轮任务删除、替换或修改已有节点，并重新连接 edges。',
      '先识别本轮真正依赖的上游产物；保留仍然相关的节点，删除会冲突、重复执行或已经被新能力替代的旧分支。',
      '旧节点即使不再连接 out，仍会被整张 DAG 执行；失效、额度不足或已被替代的节点必须从脚本删除，不能只改 out。',
      '把 out 重连到本轮最终产物。修改范围必须服务于用户本轮任务，禁止清空整张画布或改动无关分支。',
      ...CANVAS_NEW_TASK_RULES
    ]
    return [
      '[本轮必须执行]',
      '输入框中选择的 Pipeline 节点表示“把该节点应用到当前会话画布，然后运行修改后的完整画布”，不是绕过画布直接运行单个节点。',
      `用户选择的节点：${JSON.stringify(selectedPipelineNodes)}`,
      '所选节点 values 中显式给出的 model、provider_id、size 等是用户锁定的预设，必须原样写入 config；禁止调用 models.list 换型号、禁止依次试跑其它 Provider。该预设失败时直接报告错误，只有用户明确要求换模型时才能更换。',
      `当前画布 graph_baseline：${JSON.stringify({ nodes, edges })}`,
      ...policy,
      '必须先生成符合上述策略的新画布：能力尚未出现用 canvas.extend；同一能力已有节点但本轮指定了新输入时用 canvas.rewire；要插审核闸门用 canvas.insert；只改参数用 canvas.update；只改出口用 canvas.set_output；删失效分支用 canvas.remove；没有 stepId 的上传文件用 canvas.bind_input；换节点类型用 canvas.replace；复杂重组或空画布用 script.propose。改图前可用 canvas.inspect 看结构。',
      '重新处理已有节点时，不能只替换一个相关输入。例如 Tripo 分割的模型文件与 source_task_id 必须来自同一上游纹理步骤；否则 task_id 会静默覆盖模型文件并处理错误版本。',
      '如果当前画布为空，也必须先创建画布。只有画布修改成功后才能调用 submit.graph 运行修改后的完整 DAG。',
      '禁止把所选节点直接作为独立单节点任务提交；禁止在没有修改 graph_baseline 的情况下声称画布已更新。'
    ].join('\n')
  }
  if (!prompt || !canvasHasWorkNodes(canvasGraph)) return ''
  return ['[本轮画布增量]', ...CANVAS_NEW_TASK_RULES, '先读当前画布脚本，缺的能力就加节点，然后 submit.graph。'].join(
    '\n'
  )
}

function formatDccContextBlock(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const ctx = value as Record<string, unknown>
  if (ctx.error && !ctx.hipFile && !ctx.scenePath && !ctx.dcc) return ''
  const lines: string[] = [
    '[DCC 当前场景]',
    '这是宿主 DCC 此刻的精简上下文。导入资产默认进当前网络/当前选中处；改参数前先读；写操作在 undo 组里。'
  ]
  const dcc = ctx.dccType || ctx.dcc
  if (typeof dcc === 'string' && dcc)
    lines.push(`dcc: ${dcc}${typeof ctx.dccVersion === 'string' && ctx.dccVersion ? ` ${ctx.dccVersion}` : ''}`)
  const file = ctx.hipFile || ctx.scenePath
  if (typeof file === 'string' && file) lines.push(`file: ${file}`)
  if (typeof ctx.currentNetwork === 'string' && ctx.currentNetwork) lines.push(`currentNetwork: ${ctx.currentNetwork}`)
  if (Array.isArray(ctx.selectedNodes) && ctx.selectedNodes.length > 0) {
    const names = ctx.selectedNodes.slice(0, 12).map((node) => {
      if (typeof node === 'string') return node
      if (node && typeof node === 'object' && 'path' in node) return String((node as { path?: unknown }).path || '')
      return JSON.stringify(node)
    })
    lines.push(`selected: ${names.filter(Boolean).join(', ')}`)
  }
  return lines.join('\n')
}

export function shouldInjectPriorUserTexts(text: string): boolean {
  const prompt = stripCocoContextBlocks(text).trim()
  if (!prompt) return true
  return GENERIC_FOLLOWUP.test(prompt)
}

export function formatCocoUserContent(
  text: string,
  options?: {
    attachments?: CocoPipelineAttachment[]
    sessionAssets?: CocoSessionAsset[]
    priorUserTexts?: string[]
    selectedPipelineNodes?: readonly CocoSelectedPipelineNode[]
    canvasGraph?: unknown
    dccContext?: unknown
    pastedTexts?: readonly CocoPastedPromptText[]
  }
): string {
  const sections: string[] = []
  const designatedAssetIds = new Set(
    Array.from(text.matchAll(/\[本轮用户附件[ \t]+[^\]\r\n]*?\basset_id=([^\s\]]+)[^\]\r\n]*\]/gu), (match) => match[1])
  )
  const prompt = stripCocoContextBlocks(text).trim()
  if (prompt) sections.push(prompt)

  if (options?.pastedTexts?.length) {
    sections.push(
      [
        '[本轮粘贴文本]',
        '这是用户本轮粘贴的长文本，当作提示词素材。',
        '仅当本轮任务就是用这段文字去生成时才原样填入 prompt。',
        '若本轮是在已有结果上的新任务，把这段文字当作主体描述，与本轮新指令合并；禁止原样重跑旧节点。',
        '禁止把 asset_id、文件 UUID 或文件名填进 prompt。',
        ...options.pastedTexts.flatMap((item) => [`--- ${item.filename} ---`, item.content.trim()])
      ].join('\n')
    )
  }

  const prior = shouldInjectPriorUserTexts(text)
    ? (options?.priorUserTexts ?? [])
        .map((item) => stripCocoContextBlocks(item).trim())
        .filter((item) => item && item !== prompt)
        .slice(-6)
    : []
  if (prior.length > 0) {
    sections.push(
      ['[历史背景，不是本轮指令]', ...prior.map((item, index) => `${index + 1}. ${item.slice(0, 400)}`)].join('\n')
    )
  }

  const designatedLines: string[] = []
  const catalogLines: string[] = []
  const seen = new Set<string>()
  for (const item of options?.attachments ?? []) {
    if (!item.assetId || seen.has(item.assetId)) continue
    if (isPromptTextAttachment({ filename: item.filename, mediaType: item.mediaType })) continue
    seen.add(item.assetId)
    designatedLines.push(
      formatCocoCatalogLine({
        name: item.filename,
        assetId: item.assetId,
        kind: guessCocoSessionAssetKind(item.filename, item.mediaType),
        sizeBytes: item.sizeBytes
      })
    )
  }
  for (const asset of options?.sessionAssets ?? []) {
    if (!asset.assetId || seen.has(asset.assetId)) continue
    if (isPromptTextAttachment({ filename: asset.name })) continue
    const mentioned =
      designatedAssetIds.has(asset.assetId) ||
      (Boolean(asset.name) &&
        (prompt.includes(`@${asset.name}`) || prompt.includes(`@${asset.name.replace(/\s+/g, '')}`)))
    if (mentioned && !seen.has(asset.assetId)) {
      seen.add(asset.assetId)
      designatedLines.push(
        formatCocoCatalogLine({
          name: asset.name,
          assetId: asset.assetId,
          kind: asset.kind,
          origin: asset.origin,
          sizeBytes: asset.sizeBytes
        })
      )
      continue
    }
    seen.add(asset.assetId)
    catalogLines.push(
      formatCocoCatalogLine({
        name: asset.name,
        assetId: asset.assetId,
        kind: asset.kind,
        origin: asset.origin,
        sizeBytes: asset.sizeBytes
      })
    )
  }
  if (designatedLines.length > 0) {
    sections.push(
      [
        '[本轮指定输入]',
        '用户本轮用 @ 或附件点选了这些文件。它们既可能是要接进节点的输入，也可能只是让你读内容后回答问题 —— 由用户这句话决定，不要预设。',
        '产出类任务（生成/改图/建模/转换素材）：画布已有对应步骤时从 step.output 接线，还没有时把 asset_id 填进新节点对应输入端口；此时禁止再问「用哪张图 / 连哪个文件 / 参考图是哪张 / 是路径还是 UUID」。',
        '读内容类任务（看/分析/总结/提取/校对/问文件里写了什么）：不要建画布、不要 submit.graph，先读文件正文再直接回答。',
        ...designatedLines
      ].join('\n')
    )
  }
  if (catalogLines.length > 0) {
    sections.push(
      [
        '[会话已有文件]',
        '下面这些文件已经在本会话里，用户说「这个视频/这张图」就是指它们。禁止让用户重新上传。',
        ...catalogLines
      ].join('\n')
    )
  }
  const canvasRequirement = formatCanvasEditRequirement(
    mergeSelectedPipelineNodes(options?.selectedPipelineNodes ?? [], namedPipelineNodesFromText(prompt)),
    options?.canvasGraph,
    prompt
  )
  if (canvasRequirement) sections.push(canvasRequirement)
  const dccBlock = formatDccContextBlock(options?.dccContext)
  if (dccBlock) sections.push(dccBlock)
  return sections.join('\n\n')
}

export function stripCocoContextBlocks(text: string): string {
  return text
    .replace(/\s*\[本轮用户附件[ \t]+[^\]\r\n]+\]\s*/gu, ' ')
    .replace(
      /\n*\[(本轮指定输入|本轮用户附件|本轮附件本地路径|会话已有文件|此前用户说过|历史背景，不是本轮指令|本轮必须执行|本轮画布增量|本轮粘贴文本|DCC 当前场景)\]\s*\n[\s\S]*$/u,
      ''
    )
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function filesFromSessionAssets(assets: CocoSessionAsset[] | undefined): AgentAttachmentFile[] {
  if (!assets?.length) return []
  return assets.flatMap((asset) => {
    if (!asset.assetId) return []
    if (isPromptTextAttachment({ filename: asset.name })) return []
    return [
      {
        path: '',
        filename: asset.name,
        pipelineAssetId: asset.assetId,
        ...(typeof asset.sizeBytes === 'number' ? { sizeBytes: asset.sizeBytes } : {}),
        ...(asset.kind === 'video'
          ? { mediaType: 'video/mp4' }
          : asset.kind === 'image'
            ? { mediaType: 'image/png' }
            : {})
      }
    ]
  })
}

function mergeAttachmentFiles(current: AgentAttachmentFile[], extra?: AgentAttachmentFile[]): AgentAttachmentFile[] {
  const byName = new Map<string, AgentAttachmentFile>()
  const unnamed: AgentAttachmentFile[] = []
  const rank = (file: AgentAttachmentFile) => (file.pipelineAssetId ? 3 : file.fileEntryId ? 2 : file.path ? 1 : 0)
  for (const file of [...current, ...(extra ?? [])]) {
    const name = file.filename.trim().toLowerCase()
    if (!name) {
      unnamed.push(file)
      continue
    }
    const existing = byName.get(name)
    if (!existing) {
      byName.set(name, file)
      continue
    }
    const preferred = rank(file) > rank(existing) ? file : existing
    const other = preferred === file ? existing : file
    const sizeBytes = preferred.sizeBytes ?? other.sizeBytes
    const composerFileKind = preferred.composerFileKind ?? other.composerFileKind
    const mergedPath = preferred.path || other.path
    const mergedFileEntryId = preferred.fileEntryId || other.fileEntryId
    byName.set(name, {
      ...preferred,
      ...(mergedPath && !preferred.path ? { path: mergedPath } : {}),
      ...(mergedFileEntryId && !preferred.fileEntryId ? { fileEntryId: mergedFileEntryId } : {}),
      ...(sizeBytes != null && preferred.sizeBytes == null ? { sizeBytes } : {}),
      ...(composerFileKind && !preferred.composerFileKind ? { composerFileKind } : {})
    })
  }
  return [...byName.values(), ...unnamed]
}

const PASTED_TEXT_FILENAMES = /^(pasted_text|pasted text|已粘贴的文本|已貼上的文字)\.txt$/iu

export function isPromptTextAttachment(
  file: Pick<AgentAttachmentFile, 'filename' | 'mediaType' | 'composerFileKind'>
): boolean {
  if (file.composerFileKind === 'pasted-text') return true
  return PASTED_TEXT_FILENAMES.test(file.filename.trim())
}

async function readPromptTextFile(file: AgentAttachmentFile): Promise<string> {
  if (!file.path) return ''
  try {
    return await fs.promises.readFile(file.path, 'utf8')
  } catch (error) {
    logger.warn('Failed to read pasted prompt text', error as Error)
    return ''
  }
}

function resolveAttachmentFile(
  file: AgentAttachmentFile,
  resolveFileEntryPath?: (fileEntryId: string) => string
): AgentAttachmentFile {
  if (file.path || !file.fileEntryId || !resolveFileEntryPath) return file
  try {
    const resolved = resolveFileEntryPath(file.fileEntryId)?.trim()
    return resolved ? { ...file, path: resolved } : file
  } catch {
    return file
  }
}

function formatCocoCatalogLine(options: {
  name: string
  assetId: string
  kind?: string
  origin?: string
  sizeBytes?: number
}): string {
  const bits = [options.kind, formatCocoAssetSize(options.sizeBytes) || undefined, options.origin].filter(Boolean)
  const meta = bits.length > 0 ? ` (${bits.join(' · ')})` : ''
  return `- ${options.name}${meta}: asset_id=${options.assetId}`
}

function attachmentSizeBytes(file: AgentAttachmentFile, sessionAssets?: CocoSessionAsset[]): number | undefined {
  if (typeof file.sizeBytes === 'number' && file.sizeBytes >= 0) return file.sizeBytes
  const fromSession = sessionAssets?.find((asset) => asset.assetId === file.pipelineAssetId)?.sizeBytes
  if (typeof fromSession === 'number') return fromSession
  if (!file.path) return undefined
  try {
    return fs.statSync(file.path).size
  } catch {
    return undefined
  }
}

function loadBridgeConfig(): Record<string, unknown> {
  const configPath = path.join(os.homedir(), '.cherrystudio', 'ai-pipeline-bridge.json')
  try {
    if (!fs.existsSync(configPath)) return {}
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
