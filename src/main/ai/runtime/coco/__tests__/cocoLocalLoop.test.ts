import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CherryChatCredentials } from '../cocoCherryProvider'
import { normalizeOpenAIToolParameters, runCocoLocalLoop } from '../cocoLocalLoop'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }
}))
vi.mock('@data/services/AgentService', () => ({
  agentService: { getAgent: vi.fn(), updateAgent: vi.fn() }
}))
vi.mock('@data/dataApiDataChange', () => ({
  notifyDataApiDataChange: vi.fn()
}))

function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder()
  const payload = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload))
        controller.close()
      }
    }),
    { status: 200 }
  )
}

const credentials: CherryChatCredentials = {
  providerId: 'vapi',
  modelId: 'gpt-test',
  apiKey: 'sk-test',
  chatCompletionsUrl: 'https://new-api.example/v1/chat/completions',
  headers: { Authorization: 'Bearer sk-test', 'Content-Type': 'application/json' }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runCocoLocalLoop', () => {
  it('flattens top-level MCP schema unions for strict OpenAI-compatible gateways', () => {
    const normalized = normalizeOpenAIToolParameters({
      oneOf: [
        {
          type: 'object',
          properties: { action: { const: 'search' }, query: { type: 'string' } },
          required: ['action', 'query']
        },
        {
          type: 'object',
          properties: { action: { const: 'fetch' }, urls: { type: 'array', items: { type: 'string' } } },
          required: ['action', 'urls']
        }
      ]
    })

    expect(normalized).not.toHaveProperty('oneOf')
    expect(normalized).toMatchObject({
      type: 'object',
      properties: {
        action: { anyOf: [{ const: 'search' }, { const: 'fetch' }] },
        query: { type: 'string' },
        urls: { type: 'array', items: { type: 'string' } }
      },
      required: ['action']
    })
  })

  it('unions required fields when flattening a top-level allOf schema', () => {
    expect(
      normalizeOpenAIToolParameters({
        allOf: [
          { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          { type: 'object', properties: { limit: { type: 'integer' } }, required: ['limit'] }
        ]
      })
    ).toMatchObject({
      type: 'object',
      required: ['path', 'limit'],
      properties: { path: { type: 'string' }, limit: { type: 'integer' } }
    })
  })

  it('streams assistant text from Cherry chat completions without calling Pipeline Hermes', async () => {
    const posted: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        posted.push(init?.body ? JSON.parse(String(init.body)) : null)
        return sseResponse([
          { choices: [{ delta: { content: '你好画布' } }] },
          {
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
          }
        ])
      })
    )

    const events: unknown[] = []
    const invokeTool = vi.fn()
    const outcome = await runCocoLocalLoop({
      credentials,
      systemPrompt: 'you are coco',
      history: [],
      userContent: 'hello',
      tools: [{ name: 'nodes.list', description: 'list nodes', parameters: { type: 'object' } }],
      signal: new AbortController().signal,
      emit: async (event) => {
        events.push(event)
        return 'continue' as const
      },
      invokeTool,
      onAskUser: async () => ({ approved: true, answers: {} })
    })

    expect(invokeTool).not.toHaveBeenCalled()
    expect(outcome.assistantText).toBe('你好画布')
    expect(outcome.usage?.totalTokens).toBe(16)
    expect(events).toEqual([
      { type: 'delta', data: { text: '你好画布' } },
      { type: 'message', data: { role: 'assistant', content: '你好画布' } }
    ])
    const body = posted[0] as {
      model: string
      tools: { function: { name: string } }[]
      messages: { role: string }[]
    }
    expect(body.model).toBe('gpt-test')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'you are coco' })
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0].function.name).toBe('nodes_list')
    expect(body.tools[0].function.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/)
  })

  it('invokes Pipeline tools locally and feeds results back to the model', async () => {
    let round = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        round += 1
        if (round === 1) {
          return sseResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-nodes',
                        function: { name: 'nodes_list', arguments: '{}' }
                      }
                    ]
                  }
                }
              ]
            },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
          ])
        }
        return sseResponse([
          { choices: [{ delta: { content: '目录已就绪' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] }
        ])
      })
    )

    const invokeTool = vi.fn(async () => ({ result: { ok: true, nodes: ['io.load-image'] } }))
    const outcome = await runCocoLocalLoop({
      credentials,
      systemPrompt: 'prompt',
      history: [],
      userContent: '有哪些节点',
      tools: [{ name: 'nodes.list', parameters: { type: 'object' } }],
      signal: new AbortController().signal,
      emit: async () => 'continue' as const,
      invokeTool,
      onAskUser: async () => ({ approved: true })
    })

    expect(invokeTool).toHaveBeenCalledWith('nodes.list', {}, 'call-nodes')
    expect(outcome.assistantText).toBe('目录已就绪')
  })

  it('does not render provisional text from a tool-call round', async () => {
    let round = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        round += 1
        if (round === 1) {
          return sseResponse([
            { choices: [{ delta: { content: '这是调用工具前的临时技能清单' } }] },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-skills',
                        function: { name: 'search_skills', arguments: '{"query":"testing"}' }
                      }
                    ]
                  }
                }
              ]
            },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
          ])
        }
        return sseResponse([
          { choices: [{ delta: { content: '这是基于检索结果的最终技能清单' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] }
        ])
      })
    )

    const events: unknown[] = []
    const outcome = await runCocoLocalLoop({
      credentials,
      systemPrompt: 'prompt',
      history: [],
      userContent: '有哪些测试技能',
      tools: [{ name: 'search_skills', parameters: { type: 'object' } }],
      signal: new AbortController().signal,
      emit: async (event) => {
        events.push(event)
        return 'continue' as const
      },
      invokeTool: async () => ({ result: { ok: true, skills: ['webapp-testing'] } }),
      onAskUser: async () => ({ approved: true })
    })

    expect(outcome.assistantText).toBe('这是基于检索结果的最终技能清单')
    expect(JSON.stringify(events)).not.toContain('调用工具前的临时技能清单')
    expect(JSON.stringify(events)).toContain('基于检索结果的最终技能清单')
  })

  it('maps dotted Pipeline tool names to OpenAI-safe aliases and back', async () => {
    const posted: unknown[] = []
    let round = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        posted.push(init?.body ? JSON.parse(String(init.body)) : null)
        round += 1
        if (round === 1) {
          return sseResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-split',
                        function: { name: 'imgproc_split-three-view', arguments: '{}' }
                      }
                    ]
                  }
                }
              ]
            },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
          ])
        }
        return sseResponse([
          { choices: [{ delta: { content: 'ok' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] }
        ])
      })
    )

    const invokeTool = vi.fn(async () => ({ result: { ok: true } }))
    await runCocoLocalLoop({
      credentials,
      systemPrompt: 'prompt',
      history: [],
      userContent: '使用 /imgproc.split-three-view',
      tools: [{ name: 'imgproc.split-three-view', parameters: { type: 'object' } }],
      signal: new AbortController().signal,
      emit: async () => 'continue' as const,
      invokeTool,
      onAskUser: async () => ({ approved: true })
    })

    const first = posted[0] as { tools: { function: { name: string } }[] }
    expect(first.tools[0].function.name).toBe('imgproc_split-three-view')
    expect(first.tools[0].function.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/)
    expect(invokeTool).toHaveBeenCalledWith('imgproc.split-three-view', {}, 'call-split')
    const second = posted[1] as { messages: Array<{ tool_calls?: Array<{ function: { name: string } }> }> }
    const replayed = second.messages.find((message) => message.tool_calls)?.tool_calls?.[0]?.function.name
    expect(replayed).toBe('imgproc_split-three-view')
  })
})
