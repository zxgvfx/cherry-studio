import type { UniqueModelId } from '@shared/data/types/model'
import type { UIMessageChunk } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { StreamChunkCoalescer } from './StreamChunkCoalescer'

const modelId = 'provider::model' as UniqueModelId

describe('StreamChunkCoalescer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('merges rapid reasoning deltas into one renderer chunk', () => {
    vi.useFakeTimers()
    const emitted: Array<{ chunk: UIMessageChunk; model: UniqueModelId | undefined; anchor: string | undefined }> = []
    const coalescer = new StreamChunkCoalescer((chunk, model, anchor) => emitted.push({ chunk, model, anchor }))

    coalescer.push({ type: 'reasoning-delta', id: 'thought-1', delta: 'first ' }, modelId, 'assistant-1')
    coalescer.push({ type: 'reasoning-delta', id: 'thought-1', delta: 'second' }, modelId, 'assistant-1')

    expect(emitted).toEqual([])
    vi.advanceTimersByTime(16)

    expect(emitted).toEqual([
      {
        chunk: { type: 'reasoning-delta', id: 'thought-1', delta: 'first second' },
        model: modelId,
        anchor: 'assistant-1'
      }
    ])
  })

  it('flushes a pending delta before a different stream segment', () => {
    vi.useFakeTimers()
    const emitted: UIMessageChunk[] = []
    const coalescer = new StreamChunkCoalescer((chunk) => emitted.push(chunk))

    coalescer.push({ type: 'text-delta', id: 'text-1', delta: 'first' })
    coalescer.push({ type: 'text-delta', id: 'text-2', delta: 'second' })

    expect(emitted).toEqual([{ type: 'text-delta', id: 'text-1', delta: 'first' }])
    coalescer.flush()
    expect(emitted).toEqual([
      { type: 'text-delta', id: 'text-1', delta: 'first' },
      { type: 'text-delta', id: 'text-2', delta: 'second' }
    ])
  })

  it('drops pending chunks when the transport closes', () => {
    vi.useFakeTimers()
    const emitted: UIMessageChunk[] = []
    const coalescer = new StreamChunkCoalescer((chunk) => emitted.push(chunk))

    coalescer.push({ type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: '{"a":' })
    coalescer.discard()
    vi.advanceTimersByTime(16)

    expect(emitted).toEqual([])
  })
})
