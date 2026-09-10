import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { AgentEntity } from '@shared/data/api/schemas/agents'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CocoTurnUsage } from '../cocoStreamAdapter'

const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
  getById: vi.fn(),
  listSessionMessages: vi.fn(),
  runHermes: vi.fn()
}))

vi.mock('@data/services/AgentService', () => ({
  agentService: { getAgent: mocks.getAgent, updateAgent: mocks.updateAgent }
}))
vi.mock('@data/services/AgentSessionService', () => ({
  agentSessionService: { getById: mocks.getById }
}))
vi.mock('@data/services/AgentSessionMessageService', () => ({
  agentSessionMessageService: { listSessionMessages: mocks.listSessionMessages }
}))
vi.mock('@data/dataApiDataChange', () => ({
  notifyDataApiDataChange: vi.fn()
}))
vi.mock('@application', () => ({
  application: {
    get: () => ({ getPhysicalPath: () => '' })
  }
}))
vi.mock('../cocoCherryProvider', () => ({
  resolveCherryChatCredentials: () => ({
    providerId: 'vapi',
    modelId: 'gpt-5.6-sol',
    apiKey: 'local-test-key',
    chatCompletionsUrl: 'https://example.test/v1/chat/completions',
    headers: {}
  })
}))
vi.mock('../cocoHermesLocal', () => ({
  runCocoHermesLocal: mocks.runHermes
}))
vi.mock('../cocoCherryCapabilities', () => ({
  prepareCocoCherryCapabilities: async (options: { systemPrompt: string }) => ({
    systemPrompt: options.systemPrompt,
    tools: [],
    admission: () => 'auto',
    invoke: async () => ({ ok: true }),
    close: async () => undefined
  })
}))

import { toolApprovalRegistry } from '../../toolApproval/ToolApprovalRegistry'
import type { AgentRuntimeEvent } from '../../types'
import { CocoRuntimeConnection } from '../CocoRuntimeConnection'

const agent = {
  id: 'agent-1',
  name: 'COCO',
  model: 'vapi::gpt-5.6-sol',
  configuration: { coco_mode: 'agent', coco_permission: 'ask' }
} as Partial<AgentEntity> as AgentEntity

const session = {
  id: 'session-1',
  agentId: 'agent-1',
  name: 'session'
} as AgentSessionEntity

const postedBodies: unknown[] = []
const localUserMessages: string[] = []
let sessionAssets: unknown[] = []
let graphBaseline: unknown = undefined
let pipelineEvents: unknown[] = []
let messageEvents: unknown[] = []
let followUpEvents: unknown[] = []

function ndjsonStream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const payload = events.map((event) => `${JSON.stringify(event)}\n`).join('')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  postedBodies.length = 0
  localUserMessages.length = 0
  sessionAssets = []
  graphBaseline = undefined
  pipelineEvents = []
  messageEvents = []
  followUpEvents = []
  mocks.getAgent.mockReturnValue(agent)
  mocks.getById.mockReturnValue(session)
  mocks.updateAgent.mockReturnValue(agent)
  mocks.listSessionMessages.mockReturnValue({ items: [], nextCursor: undefined })
  mocks.runHermes.mockImplementation(async (input: { onEvent: (event: unknown) => unknown; userMessage?: string }) => {
    localUserMessages.push(String(input.userMessage ?? ''))
    const events =
      messageEvents.length > 0 ? messageEvents : [{ type: 'delta', data: { text: 'hi' } }, { type: 'completed' }]
    let assistantText = ''
    let usage: CocoTurnUsage | null = null
    for (const event of events) {
      await input.onEvent(event)
      const record = event as { type?: string; data?: { content?: string; usage?: unknown } }
      if (record.type === 'message') assistantText = String(record.data?.content || '')
      if (record.type === 'completed' && record.data?.usage) {
        const raw = record.data.usage as { prompt_tokens?: number; completion_tokens?: number }
        usage = {
          inputTokens: raw.prompt_tokens || 0,
          outputTokens: raw.completion_tokens || 0,
          totalTokens: (raw.prompt_tokens || 0) + (raw.completion_tokens || 0),
          reasoningTokens: 0,
          noCacheTokens: raw.prompt_tokens || 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        }
      }
    }
    return { assistantText, usage }
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/assets/upload') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'asset-uuid-1', name: 'shot.png', asset_type: 'media/image' }), {
          status: 201
        })
      }
      if (String(url).endsWith('/api/agents/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'pipe-1', revision: 1 }), { status: 200 })
      }
      if (String(url).includes('/events')) {
        return new Response(JSON.stringify(pipelineEvents), { status: 200 })
      }
      if (String(url).includes('/client-turn/complete') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'pipe-1', revision: 2, status: 'idle' }), { status: 200 })
      }
      if (String(url).includes('/client-turn') && init?.method === 'POST') {
        postedBodies.push(init?.body ? JSON.parse(String(init.body)) : null)
        return new Response(JSON.stringify({ revision: 2, system_prompt: 'You are COCO.', tools: [] }), { status: 200 })
      }
      if (String(url).includes('/tools/invoke') && init?.method === 'POST') {
        return new Response(ndjsonStream(messageEvents), { status: 200 })
      }
      if (String(url).includes('/api/agents/sessions/pipe-1') && !String(url).includes('/messages')) {
        return new Response(
          JSON.stringify({
            id: 'pipe-1',
            revision: 2,
            context: { metadata: { session_assets: sessionAssets, graph_baseline: graphBaseline } }
          }),
          { status: 200 }
        )
      }
      if (String(url).includes('/messages')) {
        postedBodies.push(init?.body ? JSON.parse(String(init.body)) : null)
        const events =
          postedBodies.length === 1
            ? messageEvents.length > 0
              ? messageEvents
              : [{ type: 'delta', data: { text: 'hi' } }, { type: 'completed' }]
            : followUpEvents.length > 0
              ? followUpEvents
              : [{ type: 'completed' }]
        return new Response(ndjsonStream(events), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CocoRuntimeConnection', () => {
  it('streams pipeline text then completes the host turn', async () => {
    const connection = await new CocoRuntimeConnection({
      sessionId: 'session-1',
      agentId: 'agent-1',
      modelId: 'vapi::gpt-5.6-sol'
    }).start()

    const eventsPromise = (async () => {
      const events: AgentRuntimeEvent[] = []
      for await (const event of connection.events) {
        events.push(event)
        if (event.type === 'turn-complete' || event.type === 'error') break
      }
      return events
    })()

    connection.send({
      message: {
        id: 'm1',
        sessionId: 'session-1',
        role: 'user',
        data: { parts: [{ type: 'text', text: 'hello canvas' }] },
        status: 'success',
        searchableText: '',
        modelId: null,
        messageSnapshot: null,
        stats: null,
        runtimeResumeToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    })

    const events = await eventsPromise
    connection.close()

    expect(events.map((event) => event.type)).toEqual(['chunk', 'chunk', 'chunk', 'turn-complete'])
    expect(events[1]).toMatchObject({ type: 'chunk', chunk: { type: 'text-delta', delta: 'hi' } })
    expect(mocks.updateAgent).toHaveBeenCalled()
    expect(connection.usageCapture).toMatchObject({
      owner: 'agent-sdk',
      providerId: 'vapi'
    })
    expect(mocks.runHermes).toHaveBeenCalledOnce()
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/messages'))).toBe(false)
  })

  it('emits a usage record when pipeline reports token usage', async () => {
    messageEvents = [
      { type: 'delta', data: { text: 'hi' } },
      { type: 'completed', data: { usage: { prompt_tokens: 20, completion_tokens: 5 } } }
    ]
    const connection = await new CocoRuntimeConnection({
      sessionId: 'session-1',
      agentId: 'agent-1',
      modelId: 'vapi::gpt-5.6-sol'
    }).start()

    const eventsPromise = (async () => {
      const events: AgentRuntimeEvent[] = []
      for await (const event of connection.events) {
        events.push(event)
        if (event.type === 'turn-complete' || event.type === 'error') break
      }
      return events
    })()

    connection.send({
      message: {
        id: 'm1',
        sessionId: 'session-1',
        role: 'user',
        data: { parts: [{ type: 'text', text: 'hello canvas' }] },
        status: 'success',
        searchableText: '',
        modelId: null,
        messageSnapshot: null,
        stats: null,
        runtimeResumeToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    })

    const events = await eventsPromise
    connection.close()
    expect(events.filter((event) => event.type === 'usage')).toEqual([
      expect.objectContaining({
        type: 'usage',
        invocation: expect.objectContaining({
          model: 'gpt-5.6-sol',
          messageAssociation: 'current-turn',
          usage: expect.objectContaining({ inputTokens: 20, outputTokens: 5, totalTokens: 25 })
        })
      })
    ])
  })

  it('uploads composer files as pipeline assets instead of sending workstation paths', async () => {
    const imagePath = path.join(os.tmpdir(), `coco-shot-${Date.now()}.png`)
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const connection = await new CocoRuntimeConnection({
      sessionId: 'session-1',
      agentId: 'agent-1',
      modelId: 'vapi::gpt-5.6-sol'
    }).start()

    const eventsPromise = (async () => {
      const events: AgentRuntimeEvent[] = []
      for await (const event of connection.events) {
        events.push(event)
        if (event.type === 'turn-complete' || event.type === 'error') break
      }
      return events
    })()

    connection.send({
      message: {
        id: 'm2',
        sessionId: 'session-1',
        role: 'user',
        data: {
          parts: [
            { type: 'text', text: '把这张图转成3d模型' },
            {
              type: 'file',
              url: pathToFileURL(imagePath).href,
              filename: 'shot.png',
              mediaType: 'image/png'
            }
          ]
        },
        status: 'success',
        searchableText: '',
        modelId: null,
        messageSnapshot: null,
        stats: null,
        runtimeResumeToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    })

    const events = await eventsPromise
    connection.close()
    fs.rmSync(imagePath, { force: true })

    expect(events.at(-1)).toMatchObject({ type: 'turn-complete' })
    expect(postedBodies[0]).toMatchObject({
      content: expect.stringContaining('把这张图转成3d模型'),
      attachments: [{ filename: 'shot.png', mediaType: 'image/png', assetId: 'asset-uuid-1' }]
    })
    expect(String((postedBodies[0] as { content: string }).content)).toContain('asset_id=asset-uuid-1')
    expect(String((postedBodies[0] as { content: string }).content)).toContain('本轮指定输入')
    expect(String((postedBodies[0] as { content: string }).content)).toContain('禁止再问')
    expect(JSON.stringify(postedBodies[0])).not.toContain('coco-shot-')
    // The local model needs the on-disk path to read a document; the pipeline server must not
    // receive workstation paths. Both halves of that split are load-bearing.
    expect(localUserMessages[0]).toContain(imagePath)
    expect(localUserMessages[0]).toContain('asset_id=asset-uuid-1')
  })

  it('reuses pipelineAssetId on file parts instead of uploading again', async () => {
    const connection = await new CocoRuntimeConnection({
      sessionId: 'session-1',
      agentId: 'agent-1',
      modelId: 'vapi::gpt-5.6-sol'
    }).start()

    const eventsPromise = (async () => {
      const events: AgentRuntimeEvent[] = []
      for await (const event of connection.events) {
        events.push(event)
        if (event.type === 'turn-complete' || event.type === 'error') break
      }
      return events
    })()

    connection.send({
      message: {
        id: 'm3',
        sessionId: 'session-1',
        role: 'user',
        data: {
          parts: [
            { type: 'text', text: '改这张图的风格' },
            {
              type: 'file',
              url: 'pipeline-asset://existing-uuid',
              filename: 'shot.png',
              mediaType: 'image/png',
              providerMetadata: {
                cherry: { pipelineAssetId: 'existing-uuid', fileTokenSourceId: 'coco-asset-existing-uuid' }
              }
            }
          ]
        },
        status: 'success',
        searchableText: '',
        modelId: null,
        messageSnapshot: null,
        stats: null,
        runtimeResumeToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    })

    const events = await eventsPromise
    connection.close()

    expect(events.at(-1)).toMatchObject({ type: 'turn-complete' })
    expect(postedBodies[0]).toMatchObject({
      content: expect.stringContaining('改这张图的风格'),
      attachments: [{ filename: 'shot.png', mediaType: 'image/png', assetId: 'existing-uuid' }]
    })
    expect(String((postedBodies[0] as { content: string }).content)).toContain('asset_id=existing-uuid')
    const uploadCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/api/assets/upload'))
    expect(uploadCalls).toHaveLength(0)
  })

  it('requires selected pipeline nodes to edit the current canvas before running', async () => {
    graphBaseline = {
      nodes: {
        generate: {
          step_id: 'generate',
          node_id: 'model.text-to-image',
          config: { model: 'gpt-image-2' }
        }
      },
      edges: []
    }
    const connection = await new CocoRuntimeConnection({
      sessionId: 'session-1',
      agentId: 'agent-1',
      modelId: 'vapi::gpt-5.6-sol'
    }).start()
    const eventsPromise = (async () => {
      const events: AgentRuntimeEvent[] = []
      for await (const event of connection.events) {
        events.push(event)
        if (event.type === 'turn-complete' || event.type === 'error') break
      }
      return events
    })()

    connection.send({
      message: {
        id: 'm-canvas-node',
        sessionId: 'session-1',
        role: 'user',
        data: {
          parts: [
            {
              type: 'text',
              text: '根据参考图生成角色三视图 /model.image-to-image',
              providerMetadata: {
                cherry: {
                  composer: {
                    version: 1,
                    tokens: [
                      {
                        id: 'pipelineNode:model.image-to-image:n1',
                        kind: 'pipelineNode',
                        label: '/model.image-to-image',
                        index: 0,
                        textOffset: 10,
                        promptText: '/model.image-to-image',
                        payload: { nodeId: 'model.image-to-image', values: { model: 'nano-banana-pro@rc' } }
                      }
                    ]
                  }
                }
              }
            }
          ]
        },
        status: 'success',
        searchableText: '',
        modelId: null,
        messageSnapshot: null,
        stats: null,
        runtimeResumeToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    })

    await eventsPromise
    connection.close()

    const content = String((postedBodies[0] as { content: string }).content)
    expect(content).toContain('[本轮必须执行]')
    expect(content).toContain('当前画布 graph_baseline')
    expect(content).toContain('model.text-to-image')
    expect(content).toContain('model.image-to-image')
    expect(content).toContain('画布编辑策略：recompose_allowed')
    expect(content).toContain('删除会冲突、重复执行或已经被新能力替代的旧分支')
    expect(content).toContain('失效、额度不足或已被替代的节点必须从脚本删除')
    expect(content).not.toContain('画布编辑策略：append_only（强制）')
    expect(content).toContain('禁止把所选节点直接作为独立单节点任务提交')
  })

  it('injects an inline 3D preview when the user asks to preview a session asset', async () => {
    sessionAssets = [
      {
        assetId: '23ef9791-063b-49aa-ad12-11a693e804c8',
        name: 'result_1787034237580.glb',
        kind: 'model',
        origin: 'generated',
        caption: '图生3D · pixal3d-image-to-3d'
      }
    ]
    const connection = await new CocoRuntimeConnection({
      sessionId: 'session-1',
      agentId: 'agent-1',
      modelId: 'vapi::gpt-5.6-sol'
    }).start()

    const eventsPromise = (async () => {
      const events: AgentRuntimeEvent[] = []
      for await (const event of connection.events) {
        events.push(event)
        if (event.type === 'turn-complete' || event.type === 'error') break
      }
      return events
    })()

    connection.send({
      message: {
        id: 'm4',
        sessionId: 'session-1',
        role: 'user',
        data: { parts: [{ type: 'text', text: '运行完成了，预览刚刚的文件' }] },
        status: 'success',
        searchableText: '',
        modelId: null,
        messageSnapshot: null,
        stats: null,
        runtimeResumeToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    })

    const events = await eventsPromise
    connection.close()

    expect(events.at(-1)).toMatchObject({ type: 'turn-complete' })
    const previewChunks = events.filter((event) => event.type === 'chunk' && event.chunk.type === 'data-pipeline-asset')
    expect(previewChunks).toEqual([
      expect.objectContaining({
        type: 'chunk',
        chunk: expect.objectContaining({
          type: 'data-pipeline-asset',
          data: expect.objectContaining({
            assetId: '23ef9791-063b-49aa-ad12-11a693e804c8',
            name: 'result_1787034237580.glb'
          })
        })
      })
    ])
    expect(previewChunks[0]).toEqual(
      expect.objectContaining({
        chunk: expect.objectContaining({
          data: expect.objectContaining({
            previewUrl: expect.stringContaining('/api/assets/23ef9791-063b-49aa-ad12-11a693e804c8/file')
          })
        })
      })
    )
  })

  it('carries previous video attachments and user goal when the follow-up is only 继续', async () => {
    const boundAgent = {
      ...agent,
      configuration: {
        coco_mode: 'agent',
        coco_permission: 'ask',
        coco_pipeline_sessions: {
          'session-1': {
            id: 'pipe-1',
            assets: [
              {
                assetId: 'vid-uuid-1',
                name: 'Download.mp4',
                kind: 'video',
                origin: 'upload',
                caption: '上传 · Download.mp4'
              }
            ]
          }
        }
      }
    } as AgentEntity
    mocks.getAgent.mockReturnValue(boundAgent)
    mocks.listSessionMessages.mockReturnValue({
      items: [
        {
          id: 'm-history',
          sessionId: 'session-1',
          role: 'user',
          data: {
            parts: [
              { type: 'text', text: '把这个视频转成动画fbx动画控制器' },
              {
                type: 'file',
                url: 'pipeline-asset://vid-uuid-1',
                filename: 'Download.mp4',
                mediaType: 'video/mp4',
                providerMetadata: { cherry: { pipelineAssetId: 'vid-uuid-1' } }
              }
            ]
          },
          status: 'success',
          searchableText: '',
          modelId: null,
          messageSnapshot: null,
          stats: null,
          runtimeResumeToken: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      nextCursor: undefined
    })

    const connection = await new CocoRuntimeConnection({
      sessionId: 'session-1',
      agentId: 'agent-1',
      modelId: 'vapi::gpt-5.6-sol'
    }).start()

    const eventsPromise = (async () => {
      const events: AgentRuntimeEvent[] = []
      for await (const event of connection.events) {
        events.push(event)
        if (event.type === 'turn-complete' || event.type === 'error') break
      }
      return events
    })()

    connection.send({
      message: {
        id: 'm-continue',
        sessionId: 'session-1',
        role: 'user',
        data: { parts: [{ type: 'text', text: '继续' }] },
        status: 'success',
        searchableText: '',
        modelId: null,
        messageSnapshot: null,
        stats: null,
        runtimeResumeToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    })

    const events = await eventsPromise
    connection.close()

    expect(events.at(-1)).toMatchObject({ type: 'turn-complete' })
    expect(postedBodies[0]).toMatchObject({
      attachments: [{ filename: 'Download.mp4', mediaType: 'video/mp4', assetId: 'vid-uuid-1' }]
    })
    const content = String((postedBodies[0] as { content: string }).content)
    expect(content).toContain('继续')
    expect(content).toContain('历史背景，不是本轮指令')
    expect(content).toContain('把这个视频转成动画fbx动画控制器')
    expect(content).toContain('Download.mp4')
    expect(content).toContain('asset_id=vid-uuid-1')
    const uploadCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/api/assets/upload'))
    expect(uploadCalls).toHaveLength(0)
    expect(events.filter((event) => event.type === 'chunk' && event.chunk.type === 'data-pipeline-asset')).toEqual([])
  })

  it('does not reattach the previous run image when the follow-up did not submit a graph', async () => {
    pipelineEvents = [
      {
        type: 'tool_result',
        data: {
          name: 'submit.graph',
          result: {
            run: { run_id: 'run-1', status: 'success' },
            assets: [
              {
                id: '2a6f2ead-5659-4322-b097-57bf5d640b74',
                name: 'model-img-l6pn61yp.png',
                asset_type: 'media/image'
              }
            ]
          }
        }
      }
    ]
    const connection = await new CocoRuntimeConnection({
      sessionId: 'session-1',
      agentId: 'agent-1',
      modelId: 'vapi::gpt-5.6-sol'
    }).start()

    const eventsPromise = (async () => {
      const events: AgentRuntimeEvent[] = []
      for await (const event of connection.events) {
        events.push(event)
        if (event.type === 'turn-complete' || event.type === 'error') break
      }
      return events
    })()

    connection.send({
      message: {
        id: 'm-followup',
        sessionId: 'session-1',
        role: 'user',
        data: { parts: [{ type: 'text', text: '使用这张图生成高质量的3d模型' }] },
        status: 'success',
        searchableText: '',
        modelId: null,
        messageSnapshot: null,
        stats: null,
        runtimeResumeToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    })

    const events = await eventsPromise
    connection.close()

    expect(events.at(-1)).toMatchObject({ type: 'turn-complete' })
    expect(events.filter((event) => event.type === 'chunk' && event.chunk.type === 'data-pipeline-asset')).toEqual([])
  })

  it('re-uploads a previous local video when the follow-up has no attachment', async () => {
    const videoPath = path.join(os.tmpdir(), `coco-download-${Date.now()}.mp4`)
    fs.writeFileSync(videoPath, Buffer.from([0x00, 0x00, 0x00, 0x18]))
    mocks.listSessionMessages.mockReturnValue({
      items: [
        {
          id: 'm-history',
          sessionId: 'session-1',
          role: 'user',
          data: {
            parts: [
              { type: 'text', text: '把这个视频转成动画fbx动画控制器' },
              {
                type: 'file',
                url: pathToFileURL(videoPath).href,
                filename: 'Download.mp4',
                mediaType: 'video/mp4'
              }
            ]
          },
          status: 'success',
          searchableText: '',
          modelId: null,
          messageSnapshot: null,
          stats: null,
          runtimeResumeToken: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      nextCursor: undefined
    })

    const connection = await new CocoRuntimeConnection({
      sessionId: 'session-1',
      agentId: 'agent-1',
      modelId: 'vapi::gpt-5.6-sol'
    }).start()

    const eventsPromise = (async () => {
      const events: AgentRuntimeEvent[] = []
      for await (const event of connection.events) {
        events.push(event)
        if (event.type === 'turn-complete' || event.type === 'error') break
      }
      return events
    })()

    connection.send({
      message: {
        id: 'm-continue',
        sessionId: 'session-1',
        role: 'user',
        data: { parts: [{ type: 'text', text: '继续' }] },
        status: 'success',
        searchableText: '',
        modelId: null,
        messageSnapshot: null,
        stats: null,
        runtimeResumeToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    })

    const events = await eventsPromise
    connection.close()
    fs.rmSync(videoPath, { force: true })

    expect(events.at(-1)).toMatchObject({ type: 'turn-complete' })
    expect(postedBodies[0]).toMatchObject({
      attachments: [{ filename: 'Download.mp4', mediaType: 'video/mp4', assetId: 'asset-uuid-1' }]
    })
    const content = String((postedBodies[0] as { content: string }).content)
    expect(content).toContain('历史背景，不是本轮指令')
    expect(content).toContain('把这个视频转成动画fbx动画控制器')
    expect(content).toContain('asset_id=asset-uuid-1')
    const uploadCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/api/assets/upload'))
    expect(uploadCalls).toHaveLength(1)
  })

  it('surfaces pipeline user_question as Cherry AskUserQuestion and resumes with the answer', async () => {
    messageEvents = [
      {
        type: 'tool_started',
        data: { name: 'interaction.ask_user', tool_call_id: 'ask-1', arguments: { question: '选一个方向' } }
      },
      {
        type: 'tool_result',
        data: {
          name: 'interaction.ask_user',
          tool_call_id: 'ask-1',
          result: { ok: true, interaction: { type: 'user_question' } }
        }
      },
      {
        type: 'user_question',
        data: { question: '选一个方向', options: ['三视图', '出模型'] }
      }
    ]
    followUpEvents = [{ type: 'delta', data: { text: '开始画三视图' } }, { type: 'completed' }]
    mocks.runHermes.mockImplementationOnce(
      async (input: {
        onEvent: (event: unknown) => unknown
        invokeTool: (name: string, args: Record<string, unknown>, id: string) => Promise<unknown>
      }) => {
        await input.invokeTool('interaction.ask_user', { question: '选一个方向' }, 'ask-1')
        for (const event of followUpEvents) await input.onEvent(event)
        return { assistantText: '开始画三视图', usage: null }
      }
    )

    const connection = await new CocoRuntimeConnection({
      sessionId: 'session-1',
      agentId: 'agent-1',
      modelId: 'vapi::gpt-5.6-sol'
    }).start()

    const eventsPromise = (async () => {
      const events: AgentRuntimeEvent[] = []
      for await (const event of connection.events) {
        events.push(event)
        if (event.type === 'tool-approval-request') {
          toolApprovalRegistry.dispatch(event.request.approvalId, {
            approved: true,
            updatedInput: {
              questions: event.request.input.questions,
              answers: { 选一个方向: '三视图' }
            }
          })
        }
        if (event.type === 'turn-complete' || event.type === 'error') break
      }
      return events
    })()

    connection.send({
      message: {
        id: 'm-ask',
        sessionId: 'session-1',
        role: 'user',
        data: { parts: [{ type: 'text', text: '把角色的三视图画出来' }] },
        status: 'success',
        searchableText: '',
        modelId: null,
        messageSnapshot: null,
        stats: null,
        runtimeResumeToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    })

    const events = await eventsPromise
    connection.close()

    expect(events.some((event) => event.type === 'tool-approval-request')).toBe(true)
    const askChunk = events.find((event) => event.type === 'chunk' && event.chunk.type === 'tool-input-available')
    expect(askChunk).toMatchObject({
      type: 'chunk',
      chunk: { type: 'tool-input-available', toolName: 'AskUserQuestion', toolCallId: 'ask-1' }
    })
    expect(events.at(-1)).toMatchObject({ type: 'turn-complete' })
    expect(postedBodies).toHaveLength(1)
  })
})
