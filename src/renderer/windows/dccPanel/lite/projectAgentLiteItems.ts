import { APPROVAL_REQUESTED, APPROVAL_RESPONDED } from '@renderer/components/chat/messages/tools/toolResponse'
import type { CherryMessagePart, CherryUIMessage } from '@shared/data/types/message'
import type { PipelineAssetPartData } from '@shared/data/types/uiParts'
import { getToolName, isToolUIPart } from 'ai'

import type { LiteApprovalStatus, LiteFileChip, LiteItem } from './agentChatLiteTypes'

function textFromParts(parts: CherryMessagePart[]): string {
  return parts
    .flatMap((part) => (part.type === 'text' && 'text' in part && part.text ? [part.text] : []))
    .join('')
    .trim()
}

function formatInput(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

function statusFromToolState(state: string | undefined): LiteApprovalStatus {
  switch (state) {
    case APPROVAL_REQUESTED:
      return 'pending'
    case 'output-denied':
    case 'cancelled':
      return 'denied'
    case APPROVAL_RESPONDED:
    case 'input-available':
    case 'input-streaming':
      return 'running'
    case 'output-error':
      return 'error'
    case 'output-available':
      return 'done'
    default:
      return 'allowed'
  }
}

function isFilePart(part: CherryMessagePart): part is CherryMessagePart & {
  type: 'file'
  url?: string
  filename?: string
  mediaType?: string
} {
  return part.type === 'file'
}

function isPipelineAssetPart(
  part: CherryMessagePart
): part is CherryMessagePart & { type: 'data-pipeline-asset'; data: PipelineAssetPartData } {
  return part.type === 'data-pipeline-asset' && 'data' in part && !!part.data
}

function fileChip(part: CherryMessagePart & { url?: string; filename?: string; mediaType?: string }): LiteFileChip {
  return {
    name: part.filename || '附件',
    mediaType: part.mediaType,
    previewUrl: part.url
  }
}

export function projectAgentLiteItems(
  messages: CherryUIMessage[],
  partsByMessageId: Record<string, CherryMessagePart[]>
): LiteItem[] {
  const items: LiteItem[] = []

  for (const message of messages) {
    const parts = partsByMessageId[message.id] ?? message.parts ?? []
    if (message.role === 'user') {
      const text = textFromParts(parts)
      const files = parts.filter(isFilePart).map(fileChip)
      if (text || files.length > 0) {
        items.push(
          files.length > 0 ? { kind: 'user', id: message.id, text, files } : { kind: 'user', id: message.id, text }
        )
      }
      continue
    }

    if (message.role !== 'assistant') continue

    const text = textFromParts(parts)
    if (text) items.push({ kind: 'agent', id: `${message.id}-text`, text })

    for (const [index, part] of parts.entries()) {
      if (isFilePart(part)) {
        items.push({
          kind: 'asset',
          id: `${message.id}-file-${index}`,
          asset: {
            assetId: `${message.id}-file-${index}`,
            name: part.filename || '生成文件',
            assetType: part.mediaType || 'file',
            previewUrl: part.url,
            downloadUrl: part.url
          }
        })
        continue
      }
      if (isPipelineAssetPart(part)) {
        items.push({
          kind: 'asset',
          id: `${message.id}-asset-${part.data.assetId || index}`,
          asset: {
            assetId: part.data.assetId,
            name: part.data.name,
            assetType: part.data.assetType,
            previewUrl: part.data.previewUrl,
            downloadUrl: part.data.downloadUrl,
            localPath: part.data.localPath
          }
        })
        continue
      }
      if (!isToolUIPart(part)) continue
      const toolName = getToolName(part) || 'tool'
      const approvalId = part.approval?.id
      const status = statusFromToolState(part.state)
      items.push({
        kind: 'approval',
        id: `${message.id}-tool-${part.toolCallId || index}`,
        toolName,
        description: `允许 Agent 执行 ${toolName}`,
        inputText: formatInput(part.input),
        status,
        match: approvalId
          ? {
              part,
              state: part.state ?? '',
              toolCallId: part.toolCallId,
              messageId: message.id,
              approvalId,
              input: part.input
            }
          : null
      })
    }
  }

  return items
}

export function lastAgentText(items: LiteItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind === 'agent') return item.text
  }
  return ''
}
