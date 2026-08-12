import type { UniqueModelId } from '@shared/data/types/model'
import type { UIMessageChunk } from 'ai'

const COALESCE_WINDOW_MS = 16
const MAX_COALESCE_AGE_MS = 16
const MAX_COALESCE_CHARS = 2048

interface PendingDelta {
  type: 'text-delta' | 'reasoning-delta' | 'tool-input-delta'
  identifier: string
  sourceModelId: UniqueModelId | undefined
  anchorMessageId: string | undefined
  text: string
}

type CoalescableChunk =
  | { type: 'text-delta'; id: string; delta: string; providerMetadata?: undefined }
  | { type: 'reasoning-delta'; id: string; delta: string; providerMetadata?: undefined }
  | { type: 'tool-input-delta'; toolCallId: string; inputTextDelta: string }

/**
 * Coalesces high-frequency model deltas before they cross the headless
 * Electron → Python → browser SSE boundary. This is intentionally equivalent
 * to WebContentsListener's renderer coalescing: preserving every individual
 * token is not observable to the UI, while forwarding all of them can starve
 * a Qt WebEngine renderer during long reasoning traces.
 */
export class StreamChunkCoalescer {
  private pending: PendingDelta | null = null
  private pendingStartedAt = 0
  private flushTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly emit: (
      chunk: UIMessageChunk,
      sourceModelId: UniqueModelId | undefined,
      anchorMessageId: string | undefined
    ) => void
  ) {}

  push(chunk: UIMessageChunk, sourceModelId?: UniqueModelId, anchorMessageId?: string): void {
    const coalescable = toCoalescable(chunk)
    if (!coalescable) {
      this.flush()
      this.emit(chunk, sourceModelId, anchorMessageId)
      return
    }

    const next = normalizePending(coalescable, sourceModelId, anchorMessageId)
    if (
      this.pending &&
      this.pending.type === next.type &&
      this.pending.identifier === next.identifier &&
      this.pending.sourceModelId === next.sourceModelId &&
      this.pending.anchorMessageId === next.anchorMessageId
    ) {
      this.pending.text += next.text
      if (
        performance.now() - this.pendingStartedAt >= MAX_COALESCE_AGE_MS ||
        this.pending.text.length >= MAX_COALESCE_CHARS
      ) {
        this.flush()
      }
      return
    }

    this.flush()
    this.pending = next
    this.pendingStartedAt = performance.now()
    this.flushTimer = setTimeout(() => this.flush(), COALESCE_WINDOW_MS)
  }

  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    const pending = this.pending
    if (!pending) return
    this.pending = null
    this.emit(rebuildChunk(pending), pending.sourceModelId, pending.anchorMessageId)
  }

  discard(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.pending = null
  }
}

function toCoalescable(chunk: UIMessageChunk): CoalescableChunk | null {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    if ('providerMetadata' in chunk && chunk.providerMetadata !== undefined) return null
    return chunk as CoalescableChunk
  }
  if (chunk.type === 'tool-input-delta') return chunk as CoalescableChunk
  return null
}

function normalizePending(
  chunk: CoalescableChunk,
  sourceModelId: UniqueModelId | undefined,
  anchorMessageId: string | undefined
): PendingDelta {
  if (chunk.type === 'tool-input-delta') {
    return {
      type: 'tool-input-delta',
      identifier: chunk.toolCallId,
      sourceModelId,
      anchorMessageId,
      text: chunk.inputTextDelta
    }
  }
  return {
    type: chunk.type,
    identifier: chunk.id,
    sourceModelId,
    anchorMessageId,
    text: chunk.delta
  }
}

function rebuildChunk(pending: PendingDelta): UIMessageChunk {
  if (pending.type === 'tool-input-delta') {
    return { type: 'tool-input-delta', toolCallId: pending.identifier, inputTextDelta: pending.text } as UIMessageChunk
  }
  return { type: pending.type, id: pending.identifier, delta: pending.text } as UIMessageChunk
}
