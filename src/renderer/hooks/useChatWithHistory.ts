import { Chat, useChat } from '@ai-sdk/react'
import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'
import { ipcChatTransport } from '@renderer/services/aiTransport'
import type { ActiveExecution } from '@shared/ai/transport'
import type { CherryUIMessage } from '@shared/data/types/message'
import type { ChatRequestOptions, FileUIPart } from 'ai'
import { useCallback, useEffect, useMemo, useRef } from 'react'

import { useTopicDbRefreshOnAwaitingApproval } from './useTopicStreamStatus'
import { useTopicStreamStatus } from './useTopicStreamStatus'

const logger = loggerService.withContext('useChatWithHistory')

const EMPTY_EXECUTIONS: readonly ActiveExecution[] = Object.freeze([])

// ── Return type ──

export interface UseChatWithHistoryResult {
  sendMessage: (message?: { text: string; files?: FileUIPart[] }, options?: ChatRequestOptions) => Promise<void>
  regenerate: (options?: ChatRequestOptions & { messageId?: string }) => Promise<void>
  stop: () => Promise<void>
  error: Error | undefined
  status: ReturnType<typeof useChat<CherryUIMessage>>['status']
  setMessages: (messages: CherryUIMessage[] | ((messages: CherryUIMessage[]) => CherryUIMessage[])) => void
  activeExecutions: readonly ActiveExecution[]
  chat: Chat<CherryUIMessage>
}

// ── Hook ──

export function useChatWithHistory(
  topicId: string,
  initialMessages: CherryUIMessage[],
  refresh: () => Promise<CherryUIMessage[]>
): UseChatWithHistoryResult {
  const enabled = Boolean(topicId)
  // The topic id is the Chat instance identity. Initial messages seed only a
  // newly selected topic; history updates flow through the explicit adapters.
  const chat = useMemo(
    () =>
      new Chat<CherryUIMessage>({
        id: topicId,
        transport: ipcChatTransport,
        messages: initialMessages,
        onError: (streamError) => {
          logger.error('AI stream error', { topicId, streamError })
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- topic identity alone owns the Chat lifecycle.
    [topicId]
  )

  const {
    setMessages,
    stop: sdkStop,
    status,
    error,
    sendMessage: sdkSendMessage,
    regenerate: sdkRegenerate,
    resumeStream
  } = useChat<CherryUIMessage>({
    chat,
    // Unthrottled (0) melts the renderer on long fast streams: every chunk re-notifies React
    // and re-renders/re-parses the growing message. 100ms keeps streaming visually smooth.
    experimental_throttle: 100
  })

  // Houdini/headless fork fix — see `selfInitiatedSendRef` below for why this
  // wrapping exists at all: `sendMessage`/`regenerate` must flip the ref
  // *synchronously*, before `ai.stream.open`'s own round trip even starts,
  // so it is already true by the time the "started-event" effect can
  // possibly observe the resulting `topicStreamStatus` flip to `pending`.
  const selfInitiatedSendRef = useRef(false)
  const sendMessage = useCallback<UseChatWithHistoryResult['sendMessage']>(
    (message, options) => {
      selfInitiatedSendRef.current = true
      return sdkSendMessage(message, options)
    },
    [sdkSendMessage]
  )
  const regenerate = useCallback<UseChatWithHistoryResult['regenerate']>(
    (options) => {
      selfInitiatedSendRef.current = true
      return sdkRegenerate(options)
    },
    [sdkRegenerate]
  )

  const stop = useCallback(async () => {
    if (enabled) {
      void ipcApi.request('ai.stream.abort', { topicId }).catch((err) => {
        logger.warn('streamAbort failed', { topicId, err })
      })
    }
    await sdkStop()
  }, [enabled, sdkStop, topicId])

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  const { status: topicStreamStatus, activeExecutions: liveExecutions } = useTopicStreamStatus(topicId)
  const activeExecutions = liveExecutions.length > 0 ? liveExecutions : EMPTY_EXECUTIONS

  const topicSelectionToken = useMemo(() => Symbol(topicId), [topicId])
  const currentTopicSelectionTokenRef = useRef(topicSelectionToken)
  currentTopicSelectionTokenRef.current = topicSelectionToken
  const resumeInFlightRef = useRef<{ ownerToken: symbol; token: symbol } | null>(null)

  // `status` and `resumeStream` are read through refs so `resumeActiveStream`
  // keeps one identity per topic. With them in the deps, the "mount" effect
  // below re-fired on every SDK status change; when a resumed stream
  // terminated (closed or errored) while main still reported the stream as
  // attachable, each ready/error edge immediately re-attached — a hot
  // resume loop (attach IPC + stream setup + status flap per cycle) that
  // pegged the CPU. The refs also make the post-refresh status re-check read
  // the current value instead of a stale closure.
  const statusRef = useRef(status)
  statusRef.current = status
  const resumeStreamRef = useRef(resumeStream)
  resumeStreamRef.current = resumeStream

  const resumeActiveStream = useCallback(
    (reason: 'mount' | 'started-event') => {
      if (!enabled) return
      if (reason === 'mount' && (statusRef.current === 'streaming' || statusRef.current === 'submitted')) return
      if (resumeInFlightRef.current?.ownerToken === topicSelectionToken) return

      const token = Symbol(topicId)
      resumeInFlightRef.current = { ownerToken: topicSelectionToken, token }
      void (async () => {
        if (reason === 'started-event') {
          try {
            await refreshRef.current()
          } catch (err) {
            logger.warn('Failed to refresh messages before resuming stream', { topicId, err })
          }
        }

        // A refresh started for topic A may settle after this hook has switched
        // to topic B. Do not let that stale task call B's latest resume callback.
        if (
          resumeInFlightRef.current?.token !== token ||
          currentTopicSelectionTokenRef.current !== topicSelectionToken
        ) {
          return
        }

        if (statusRef.current === 'streaming' || statusRef.current === 'submitted') {
          return
        }

        await resumeStreamRef.current()
      })()
        .catch((err) => {
          logger.warn('Failed to resume active stream', { topicId, reason, err })
        })
        .finally(() => {
          if (resumeInFlightRef.current?.token === token) resumeInFlightRef.current = null
        })
    },
    [enabled, topicId, topicSelectionToken]
  )

  // One attach attempt per topic selection — not per status change.
  useEffect(() => {
    resumeActiveStream('mount')
  }, [resumeActiveStream])

  // Approval pauses need the persisted row refreshed while the live card stays
  // visible. Final done/error/aborted refresh is handled by the page-level
  // overlay handoff so it can refresh before dropping live overlay parts.
  useTopicDbRefreshOnAwaitingApproval(topicId, refresh)

  // Resume-on-pending — distinct purpose from the invalidation signal: it
  // re-attaches a stream that started while this window was unmounted /
  // reloading. Stays here (it's tightly coupled to `resumeActiveStream` and
  // chat-specific) rather than mingling with the generic invalidation gate.
  const prevTopicStatusRef = useRef<{ status: typeof topicStreamStatus; topicId: string } | undefined>(undefined)
  useEffect(() => {
    const previous = prevTopicStatusRef.current
    const prev = previous?.topicId === topicId ? previous.status : undefined
    prevTopicStatusRef.current = { status: topicStreamStatus, topicId }
    if (!enabled) return
    if (topicStreamStatus === 'pending' && prev !== 'pending') {
      // Houdini/headless fork fix — over the headless HTTP/SSE relay,
      // `ai.stream.open`'s own ack takes an extra Python<->Electron hop and
      // can resolve (flipping the SDK's `status` to submitted/streaming)
      // *after* this window's shared-cache `topicStreamStatus` has already
      // flipped to `pending` from that same self-initiated send. That raced
      // this effect ahead of the `statusRef.current === 'streaming' |
      // 'submitted'` guard inside `resumeActiveStream`, so a genuinely new
      // `ai.stream.attach` fired for a topic that already had a live
      // listener from `ai.stream.open` — and `AiStreamManager.removeListener`
      // is a hard delete, so the *original* listener silently stopped
      // getting onChunk/onDone forever (the generation still finished and
      // persisted to DB via Main's own bookkeeping — just never told this
      // window). Symptom: chat looks stuck on "preparing reply" until
      // switching topics away and back forces a fresh DB read.
      // `selfInitiatedSendRef` is flipped synchronously inside our
      // `sendMessage`/`regenerate` wrappers before any round trip starts, so
      // it is already true here whenever this `pending` transition is the
      // direct result of a call this window itself just made — consume it
      // and skip the attach instead of racing it.
      if (selfInitiatedSendRef.current) {
        selfInitiatedSendRef.current = false
      } else {
        resumeActiveStream('started-event')
      }
    }
  }, [enabled, resumeActiveStream, topicId, topicStreamStatus])

  // PR 3: dropped the per-window `onStreamDone` / `onStreamError` IPC
  // listeners that previously called `refresh()` here. Final DB handoff now
  // belongs to the page-level overlay handoff; keeping it there avoids a
  // second producer of the same `mutate()` call.

  return {
    sendMessage,
    regenerate,
    stop,
    error,
    status,
    setMessages,
    activeExecutions,
    chat
  }
}
