import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AgentSessionMessageEntity } from '@shared/data/api/schemas/agentSessionMessages'
import { readCherryMeta } from '@shared/data/types/uiParts'

/**
 * Build the user-turn content sent to an agent runtime. Agent runtimes are
 * filesystem agents (they have no native multimodal channel here), so attached
 * files are forwarded as their absolute paths appended to the text — the agent
 * reads them with its own tools. Driver-neutral: shared by the Claude Code and
 * pi drivers so they cannot drift on attachment handling.
 */
export function buildAgentUserContent(message: AgentSessionMessageEntity): string {
  const text = extractMessageText(message)
  const files = extractAttachmentFiles(message)
  if (files.length === 0) return text

  const list = files
    .filter((file) => file.path)
    .map((file) => `- ${file.path}`)
    .join('\n')
  if (!list) return text
  const section = `Attached files (read them with your tools using these absolute paths):\n${list}`
  return text.trim() ? `${text}\n\n${section}` : section
}

export function extractMessageText(message: AgentSessionMessageEntity): string {
  return (
    message.data?.parts
      ?.filter((part): part is { type: 'text'; text: string } => part.type === 'text' && 'text' in part)
      .map((part) => part.text)
      .join('\n') ?? ''
  )
}

export interface AgentAttachmentFile {
  path: string
  filename: string
  mediaType?: string
  pipelineAssetId?: string
  fileEntryId?: string
  sizeBytes?: number
  composerFileKind?: 'pasted-text'
}

/** Composer attachments: local `file://` paths, HTTP serve URLs, videos, and/or already-known pipeline asset UUIDs. */
export function extractAttachmentFiles(message: AgentSessionMessageEntity): AgentAttachmentFile[] {
  const files: AgentAttachmentFile[] = []
  for (const part of message.data?.parts ?? []) {
    if (part.type === 'data-video') {
      const data = 'data' in part ? part.data : undefined
      const filePath = typeof data?.filePath === 'string' ? data.filePath : pathFromServeUrl(data?.url)
      if (!filePath) continue
      files.push({
        path: filePath,
        filename: path.basename(filePath),
        mediaType: 'video/mp4'
      })
      continue
    }
    if (part.type !== 'file') continue
    const cherry = readCherryMeta(part)
    const pipelineAssetId = cherry?.pipelineAssetId?.trim() || pipelineAssetIdFromToken(cherry?.fileTokenSourceId)
    const fileEntryId = cherry?.fileEntryId?.trim() || undefined
    const hasFileUrl = typeof part.url === 'string' && part.url.startsWith('file://')
    const servedPath = pathFromServeUrl(part.url)
    const filePath = hasFileUrl ? fileURLToPath(part.url) : servedPath
    if (!pipelineAssetId && !fileEntryId && !filePath) continue
    files.push({
      path: filePath,
      filename: part.filename || (filePath ? path.basename(filePath) : 'file'),
      ...(part.mediaType ? { mediaType: part.mediaType } : {}),
      ...(pipelineAssetId ? { pipelineAssetId } : {}),
      ...(fileEntryId ? { fileEntryId } : {}),
      ...(cherry?.composerFileKind ? { composerFileKind: cherry.composerFileKind } : {})
    })
  }
  return files
}

export function collectAttachmentFilesFromMessages(
  messages: readonly AgentSessionMessageEntity[] | undefined
): AgentAttachmentFile[] {
  if (!messages?.length) return []
  const out: AgentAttachmentFile[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const file of extractAttachmentFiles(message)) {
      const key = file.pipelineAssetId || file.fileEntryId || file.path || file.filename
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(file)
    }
  }
  return out
}

function pipelineAssetIdFromToken(token?: string): string | undefined {
  if (!token?.startsWith('coco-asset-')) return undefined
  const id = token.slice('coco-asset-'.length).trim()
  return id || undefined
}

function pathFromServeUrl(url: unknown): string {
  if (typeof url !== 'string' || !url) return ''
  try {
    const parsed = url.includes('://') ? new URL(url) : new URL(url, 'http://local.invalid')
    if (!parsed.pathname.includes('/api/v1/files/serve') && !parsed.pathname.includes('/api/v1/files/preview-video')) {
      return ''
    }
    return parsed.searchParams.get('path')?.trim() || ''
  } catch {
    return ''
  }
}
