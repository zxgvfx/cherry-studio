import type { Model } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { FileMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getProviderByModelMock, getAiSdkProviderIdMock } = vi.hoisted(() => ({
  getProviderByModelMock: vi.fn(),
  getAiSdkProviderIdMock: vi.fn()
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getProviderByModel: getProviderByModelMock,
  getDefaultAssistant: vi.fn(() => ({
    id: 'default-assistant',
    name: 'Default Assistant',
    model: undefined,
    prompt: '',
    topics: [],
    messages: [],
    settings: {}
  })),
  getDefaultModel: vi.fn(() => ({
    id: 'default-model',
    name: 'Default Model',
    provider: 'openai',
    group: 'openai'
  }))
}))

vi.mock('../../provider/factory', () => ({
  getAiSdkProviderId: getAiSdkProviderIdMock
}))

vi.mock('@renderer/utils/audioTranscode', () => ({
  transcodeAudioBase64: vi.fn()
}))

import { convertFileBlockToFilePart } from '../fileProcessor'

const createModel = (overrides: Partial<Model> = {}): Model => ({
  id: 'gemini-3.5-flash',
  name: 'gemini-3.5-flash',
  provider: 'gemini',
  group: 'gemini',
  ...overrides
})

const createVideoBlock = (
  overrides: Partial<FileMessageBlock['file']> = {},
  blockOverrides: Partial<FileMessageBlock> = {}
): FileMessageBlock =>
  ({
    id: 'video-block-1',
    messageId: 'message-1',
    type: MessageBlockType.FILE,
    createdAt: '2024-01-01T00:00:00.000Z',
    status: MessageBlockStatus.SUCCESS,
    file: {
      id: 'video-file',
      name: 'clip.mp4',
      origin_name: 'clip.mp4',
      path: '/tmp/clip.mp4',
      size: 1024,
      ext: '.mp4',
      type: FILE_TYPE.VIDEO,
      created_at: '2024-01-01T00:00:00.000Z',
      count: 1,
      ...overrides
    },
    ...blockOverrides
  }) as FileMessageBlock

describe('fileProcessor video support', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getProviderByModelMock.mockReturnValue({
      id: 'gemini',
      type: 'gemini',
      name: 'Gemini',
      apiKey: 'test-key',
      apiHost: 'https://generativelanguage.googleapis.com',
      models: []
    })
    getAiSdkProviderIdMock.mockReturnValue('google')
    ;(window as any).api = {
      file: {
        base64File: vi.fn().mockResolvedValue({ data: 'BASE64_VIDEO', mime: 'application/mp4' })
      }
    }
  })

  it('converts supported video files to AI SDK file parts', async () => {
    const result = await convertFileBlockToFilePart(createVideoBlock(), createModel())

    expect(window.api.file.base64File).toHaveBeenCalledWith('video-file.mp4')
    expect(result).toEqual({
      type: 'file',
      data: 'BASE64_VIDEO',
      mediaType: 'video/mp4',
      filename: 'clip.mp4'
    })
  })

  it('recognizes common video extensions even when metadata type is stale', async () => {
    const result = await convertFileBlockToFilePart(
      createVideoBlock({
        origin_name: 'clip.mkv',
        name: 'clip.mkv',
        ext: '.mkv',
        type: FILE_TYPE.OTHER
      }),
      createModel()
    )

    expect(window.api.file.base64File).toHaveBeenCalledWith('video-file.mkv')
    expect(result).toMatchObject({
      type: 'file',
      mediaType: 'video/x-matroska',
      filename: 'clip.mkv'
    })
  })

  it('does not read video data for unsupported providers', async () => {
    getProviderByModelMock.mockReturnValue({
      id: 'openai',
      type: 'openai',
      name: 'OpenAI',
      apiKey: 'test-key',
      apiHost: 'https://api.openai.com',
      models: []
    })
    getAiSdkProviderIdMock.mockReturnValue('openai')

    const result = await convertFileBlockToFilePart(createVideoBlock(), createModel({ provider: 'openai' }))

    expect(result).toBeNull()
    expect(window.api.file.base64File).not.toHaveBeenCalled()
  })

  it('converts video for centralized models routed through openai-compatible channel', async () => {
    getProviderByModelMock.mockReturnValue({
      id: 'centralized-openai',
      type: 'openai',
      name: 'Coco',
      apiKey: 'test-key',
      apiHost: 'http://new-api.ccc.net:3000',
      models: []
    })
    getAiSdkProviderIdMock.mockReturnValue('centralized-openai')

    const result = await convertFileBlockToFilePart(
      createVideoBlock(),
      createModel({ provider: 'centralized-openai', modality: 'multimodal' })
    )

    expect(window.api.file.base64File).toHaveBeenCalledWith('video-file.mp4')
    expect(result).toEqual({
      type: 'file',
      data: 'BASE64_VIDEO',
      mediaType: 'video/mp4',
      filename: 'clip.mp4'
    })
  })

  it('rejects video for openai-compatible models without video understanding', async () => {
    getProviderByModelMock.mockReturnValue({
      id: 'centralized-openai',
      type: 'openai',
      name: 'Coco',
      apiKey: 'test-key',
      apiHost: 'http://new-api.ccc.net:3000',
      models: []
    })
    getAiSdkProviderIdMock.mockReturnValue('centralized-openai')

    const result = await convertFileBlockToFilePart(
      createVideoBlock(),
      createModel({
        id: 'claude-opus-4-8',
        name: 'claude-opus-4-8',
        provider: 'centralized-openai',
        modality: 'multimodal'
      })
    )

    expect(result).toBeNull()
    expect(window.api.file.base64File).not.toHaveBeenCalled()
  })

  it('honors explicit supports_video_input flag from centralized config', async () => {
    getProviderByModelMock.mockReturnValue({
      id: 'centralized-openai',
      type: 'openai',
      name: 'Coco',
      apiKey: 'test-key',
      apiHost: 'http://new-api.ccc.net:3000',
      models: []
    })
    getAiSdkProviderIdMock.mockReturnValue('centralized-openai')

    // 显式开启：即使 id/name 不匹配已知视频模型特征也允许
    const allowed = await convertFileBlockToFilePart(
      createVideoBlock(),
      createModel({
        id: 'my-custom-video-model',
        name: 'My Custom Video Model',
        provider: 'centralized-openai',
        supports_video_input: true
      } as any)
    )
    expect(allowed).toMatchObject({ type: 'file', mediaType: 'video/mp4' })

    // 显式关闭：即使命中 gemini 特征也拒绝
    vi.clearAllMocks()
    getProviderByModelMock.mockReturnValue({
      id: 'centralized-openai',
      type: 'openai',
      name: 'Coco',
      apiKey: 'test-key',
      apiHost: 'http://new-api.ccc.net:3000',
      models: []
    })
    getAiSdkProviderIdMock.mockReturnValue('centralized-openai')
    ;(window as any).api = {
      file: { base64File: vi.fn().mockResolvedValue({ data: 'BASE64_VIDEO', mime: 'application/mp4' }) }
    }

    const denied = await convertFileBlockToFilePart(
      createVideoBlock(),
      createModel({
        provider: 'centralized-openai',
        modality: 'multimodal',
        supports_video_input: false
      } as any)
    )
    expect(denied).toBeNull()
  })

  it('rejects videos exceeding the inline size limit', async () => {
    const result = await convertFileBlockToFilePart(createVideoBlock({ size: 21 * 1024 * 1024 }), createModel())

    expect(result).toBeNull()
    expect(window.api.file.base64File).not.toHaveBeenCalled()
  })
})
