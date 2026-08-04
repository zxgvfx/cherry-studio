import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { FILE_TYPE } from '@renderer/types'
import { MessageBlockStatus } from '@renderer/types/newMessage'
import { createImageBlock, createMainTextBlock, createMessage } from '@renderer/utils/messageUtils/create'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CONVERSATION_IMAGE_TOOL_NAME,
  DEFAULT_KEEP_FULL_IMAGE_USER_MESSAGES,
  formatImagePlaceholders,
  resolveImageOffloadMessageIds
} from '../ImageContextOffload'

const reducer = combineReducers({
  messageBlocks: messageBlocksSlice.reducer
})

const createMockStore = () =>
  configureStore({
    reducer,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
  })

let mockStore: ReturnType<typeof createMockStore>

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => mockStore.getState(),
    dispatch: (action: any) => mockStore.dispatch(action)
  }
}))

function makeImageFile(id: string, size = 200_000) {
  return {
    id,
    name: `${id}.png`,
    origin_name: `${id}.png`,
    path: `/tmp/${id}.png`,
    size,
    ext: '.png',
    type: FILE_TYPE.IMAGE,
    created_at: new Date().toISOString(),
    count: 1
  }
}

describe('resolveImageOffloadMessageIds', () => {
  beforeEach(() => {
    mockStore = createMockStore()
    vi.clearAllMocks()
  })

  it('keeps the most recent user messages and offloads older image-bearing ones', () => {
    const topicId = 'topic-1'
    const assistantId = 'assistant-1'

    const users = [1, 2, 3].map((n) => {
      const text = createMainTextBlock(`user-${n}`, `Question ${n}`, { status: MessageBlockStatus.SUCCESS })
      const image = createImageBlock(`user-${n}`, {
        status: MessageBlockStatus.SUCCESS,
        file: makeImageFile(`file-${n}`)
      })
      mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(text))
      mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(image))
      return createMessage('user', topicId, assistantId, {
        id: `user-${n}`,
        blocks: [text.id, image.id]
      })
    })

    const assistants = [1, 2].map((n) => {
      const text = createMainTextBlock(`assistant-${n}`, `Answer ${n}`, { status: MessageBlockStatus.SUCCESS })
      mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(text))
      return createMessage('assistant', topicId, assistantId, {
        id: `assistant-${n}`,
        askId: `user-${n}`,
        blocks: [text.id]
      })
    })

    const messages = [users[0], assistants[0], users[1], assistants[1], users[2]]
    const offloadIds = resolveImageOffloadMessageIds(messages)

    // Default keep window is 2 most recent user turns.
    expect(DEFAULT_KEEP_FULL_IMAGE_USER_MESSAGES).toBe(2)
    expect(offloadIds.has('user-1')).toBe(true)
    expect(offloadIds.has('user-2')).toBe(false)
    expect(offloadIds.has('user-3')).toBe(false)
  })
})

describe('formatImagePlaceholders', () => {
  it('includes fileId and the conversation image tool name', () => {
    const block = createImageBlock('user-1', {
      status: MessageBlockStatus.SUCCESS,
      file: makeImageFile('file-abc')
    })
    const text = formatImagePlaceholders([block])
    expect(text).toContain('fileId=file-abc')
    expect(text).toContain(CONVERSATION_IMAGE_TOOL_NAME)
  })

  it('includes stored imageCaption when present', () => {
    const block = createImageBlock('user-1', {
      status: MessageBlockStatus.SUCCESS,
      file: makeImageFile('file-abc'),
      metadata: { imageCaption: 'A red apple on a wooden table' }
    })
    const text = formatImagePlaceholders([block])
    expect(text).toContain('caption="A red apple on a wooden table"')
  })
})
