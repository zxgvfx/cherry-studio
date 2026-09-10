export const ACTIVE_MESSAGE_VIEWPORT_EVENT = 'cherry:active-message-viewport'

export interface ActiveMessageViewportDetail {
  topicId: string
  messageId: string | null
}

const activeMessageByTopic = new Map<string, string | null>()

export function publishActiveMessageViewport(detail: ActiveMessageViewportDetail): void {
  if (detail.messageId) activeMessageByTopic.set(detail.topicId, detail.messageId)
  else activeMessageByTopic.delete(detail.topicId)
  window.dispatchEvent(new CustomEvent<ActiveMessageViewportDetail>(ACTIVE_MESSAGE_VIEWPORT_EVENT, { detail }))
}

export function getActiveMessageViewport(topicId: string): string | null {
  return activeMessageByTopic.get(topicId) ?? null
}
