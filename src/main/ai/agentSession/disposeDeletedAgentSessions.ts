import { application } from '@application'
import { loggerService } from '@logger'
import { toolApprovalRegistry } from '@main/ai/runtime/toolApproval/ToolApprovalRegistry'

import { buildAgentSessionTopicId } from './topic'

const logger = loggerService.withContext('disposeDeletedAgentSessions')

function abortTopicStreams(topicIds: readonly string[], reason: string): void {
  if (topicIds.length === 0) return
  try {
    const streamManager = application.get('AiStreamManager')
    for (const topicId of topicIds) {
      try {
        streamManager.abort(topicId, reason)
      } catch (error) {
        logger.warn('Failed to abort stream for deleted conversation', { topicId, error })
      }
    }
  } catch (error) {
    logger.warn('Stream manager unavailable while disposing conversations', { error })
  }
}

/**
 * Stop live work for conversations that are about to be deleted.
 *
 * Deleting the SQLite row without this left the agent runtime / stream writing
 * into a gone session. In the Coco Qt host that raced WebGL/image teardown and
 * produced a restart loop: boot → resume last-used session → stream → crash.
 */
export function abortDeletedTopicStreams(topicIds: readonly string[]): void {
  abortTopicStreams(topicIds, 'topic-deleted')
}

export function disposeDeletedAgentSessions(sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return

  abortTopicStreams(
    sessionIds.map((sessionId) => buildAgentSessionTopicId(sessionId)),
    'session-deleted'
  )

  try {
    const runtime = application.get('AgentSessionRuntimeService')
    for (const sessionId of sessionIds) {
      try {
        void runtime.closeSession(sessionId)
      } catch (error) {
        logger.warn('Failed to close runtime for deleted session', { sessionId, error })
      }
    }
  } catch (error) {
    logger.warn('Agent runtime service unavailable while disposing sessions', { error })
  }

  for (const sessionId of sessionIds) {
    try {
      toolApprovalRegistry.abort(sessionId, 'session-deleted')
    } catch (error) {
      logger.warn('Failed to abort approvals for deleted session', { sessionId, error })
    }
  }
}
