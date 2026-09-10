import { cacheService } from '@data/CacheService'
import { dataApiService } from '@data/DataApiService'

/**
 * Entry-target resolution for the conversation routes (`/app/chat`, `/app/agents`),
 * called from their `beforeLoad` interceptors on a bare entry (no explicit
 * topicId / sessionId in the URL).
 *
 * Resolution order: the cross-window "last focused" id, validated by its by-id
 * endpoint, then the globally most-recently-active conversation. `null` means
 * nothing to resume — the route falls through bare and the page decides what to
 * show.
 *
 * `last_used_*` is only a hint. A remembered id may point at a deleted row, or
 * the Qt/headless bridge may return INTERNAL instead of NOT_FOUND while the
 * row is disappearing. Either way we drop the stale persist and fall through
 * to latest so a delete cannot crash the entry route in a reload loop.
 * These are one-shot reads rather than SWR preloads: the routes do not consume
 * the latest keys through hooks, so retaining a preload there would permanently
 * pin the first response.
 */

export function forgetLastUsedChatTopic(topicIds: readonly string[]): void {
  const lastUsed = cacheService.getPersist('ui.chat.last_used_topic_id')
  if (lastUsed && topicIds.includes(lastUsed)) {
    cacheService.setPersist('ui.chat.last_used_topic_id', null)
  }
}

export function forgetLastUsedAgentSession(sessionIds: readonly string[]): void {
  const lastUsed = cacheService.getPersist('ui.agent.last_used_session_id')
  if (lastUsed && sessionIds.includes(lastUsed)) {
    cacheService.setPersist('ui.agent.last_used_session_id', null)
  }
}

export async function resolveChatEntryTopicId(): Promise<string | null> {
  const lastUsedTopicId = cacheService.getPersist('ui.chat.last_used_topic_id')
  if (lastUsedTopicId) {
    try {
      await dataApiService.get(`/topics/${lastUsedTopicId}`)
      return lastUsedTopicId
    } catch {
      cacheService.setPersist('ui.chat.last_used_topic_id', null)
    }
  }

  const { topic } = await dataApiService.get('/topics/latest')
  return topic?.id ?? null
}

export async function resolveAgentEntrySessionId(): Promise<string | null> {
  const lastUsedSessionId = cacheService.getPersist('ui.agent.last_used_session_id')
  if (lastUsedSessionId) {
    try {
      await dataApiService.get(`/agent-sessions/${lastUsedSessionId}`)
      return lastUsedSessionId
    } catch {
      cacheService.setPersist('ui.agent.last_used_session_id', null)
    }
  }

  const { session } = await dataApiService.get('/agent-sessions/latest')
  return session?.id ?? null
}
