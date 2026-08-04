import type { FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { FileMessageBlock, ImageMessageBlock, Message } from '@renderer/types/newMessage'
import { findFileBlocks, findImageBlocks } from '@renderer/utils/messageUtils/find'

/**
 * Default: keep full image pixels for this many most-recent user messages.
 * Older turns replace pixels with lightweight refs so text history survives.
 */
export const DEFAULT_KEEP_FULL_IMAGE_USER_MESSAGES = 2

/** @deprecated Prefer {@link DEFAULT_KEEP_FULL_IMAGE_USER_MESSAGES} / settings. */
export const KEEP_FULL_IMAGE_USER_MESSAGES = DEFAULT_KEEP_FULL_IMAGE_USER_MESSAGES

/** Rough token cost of one offloaded image placeholder line (incl. optional caption). */
export const IMAGE_PLACEHOLDER_TOKEN_ESTIMATE = 72

export const CONVERSATION_IMAGE_TOOL_NAME = 'builtin_get_conversation_image'

export function messageHasOffloadableImages(message: Message): boolean {
  if (findImageBlocks(message).length > 0) return true
  return findFileBlocks(message).some((block) => block.file?.type === FILE_TYPE.IMAGE)
}

/**
 * Marks messages whose image pixels should be replaced with refs before send.
 * The last `keepFullUserMessages` user messages keep full images;
 * every earlier message that carries images is offloaded.
 */
export function resolveImageOffloadMessageIds(
  messages: Message[],
  keepFullUserMessages: number = DEFAULT_KEEP_FULL_IMAGE_USER_MESSAGES
): Set<string> {
  const keepCount = Math.min(20, Math.max(1, Math.floor(keepFullUserMessages)))
  const keepUserIds = new Set<string>()
  let kept = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    keepUserIds.add(messages[i].id)
    kept += 1
    if (kept >= keepCount) break
  }

  const offloadIds = new Set<string>()
  for (const message of messages) {
    if (keepUserIds.has(message.id)) continue
    if (messageHasOffloadableImages(message)) {
      offloadIds.add(message.id)
    }
  }
  return offloadIds
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "'").replace(/\s+/g, ' ').trim()
}

function formatFileRef(file: FileMetadata, caption?: string): string {
  const name = file.origin_name || file.name || file.id
  const captionPart = caption ? ` caption="${escapeAttr(caption)}"` : ''
  return (
    `[Image ref fileId=${file.id} name="${escapeAttr(name)}"${captionPart} — call ${CONVERSATION_IMAGE_TOOL_NAME} ` +
    `with this fileId if you need the visual content]`
  )
}

/**
 * Builds placeholder text that preserves image identity (and optional caption)
 * without base64 pixels.
 */
export function formatImagePlaceholders(imageBlocks: ImageMessageBlock[], fileBlocks: FileMessageBlock[] = []): string {
  const lines: string[] = []
  const seenFileIds = new Set<string>()

  for (const block of imageBlocks) {
    const caption = block.metadata?.imageCaption
    if (block.file) {
      seenFileIds.add(block.file.id)
      lines.push(formatFileRef(block.file, caption))
      continue
    }
    if (block.url) {
      if (block.url.startsWith('data:')) {
        const captionPart = caption ? ` caption="${escapeAttr(caption)}"` : ''
        lines.push(`[Image ref (inline data omitted)${captionPart} — visual content offloaded from context]`)
      } else {
        const captionPart = caption ? ` caption="${escapeAttr(caption)}"` : ''
        lines.push(
          `[Image ref url=${block.url}${captionPart} — call ${CONVERSATION_IMAGE_TOOL_NAME} ` +
            `with this url if you need the visual content]`
        )
      }
    }
  }

  for (const block of fileBlocks) {
    const file = block.file
    if (!file || file.type !== FILE_TYPE.IMAGE) continue
    if (seenFileIds.has(file.id)) continue
    seenFileIds.add(file.id)
    lines.push(formatFileRef(file))
  }

  return lines.join('\n')
}

export function countOffloadableImages(message: Message): number {
  const imageBlocks = findImageBlocks(message)
  const fileBlocks = findFileBlocks(message)
  const seen = new Set<string>()
  let count = 0

  for (const block of imageBlocks) {
    if (block.file) {
      if (seen.has(block.file.id)) continue
      seen.add(block.file.id)
      count += 1
    } else if (block.url) {
      count += 1
    }
  }

  for (const block of fileBlocks) {
    if (block.file?.type !== FILE_TYPE.IMAGE) continue
    if (seen.has(block.file.id)) continue
    seen.add(block.file.id)
    count += 1
  }

  return count
}
