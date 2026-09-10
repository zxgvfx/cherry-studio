import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { AgentEntity } from '@shared/data/api/schemas/agents'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TO_MARKDOWN_RUNTIME_NAME = 'mcp__cherry-tools__to_markdown'
const VISION_RUNTIME_NAME = 'mcp__coco-vision__look_at_image'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  close: vi.fn(async () => undefined),
  getByKey: vi.fn(() => {
    throw new Error('catalog row missing')
  })
}))

vi.mock('@application', () => ({
  application: {
    getPath: () => '/mock/agents-data',
    get: () => ({})
  }
}))
vi.mock('@data/services/McpServerService', () => ({
  mcpServerService: { findByIdOrName: () => undefined }
}))
vi.mock('@data/services/ModelService', () => ({
  modelService: { getByKey: (...args: unknown[]) => (mocks.getByKey as (...inner: unknown[]) => unknown)(...args) }
}))
vi.mock('@main/ai/agents/agentDataDirectory', () => ({
  ensureAgentDataDirectory: async () => '/mock/agents-data/agent-1'
}))
vi.mock('@main/ai/skills/SkillService', () => ({
  skillService: { list: async () => [], readFile: async () => null }
}))
vi.mock('@main/ai/runtime/agentMcpServers', () => ({
  buildAgentMcpServers: () => ({})
}))
vi.mock('@main/ai/runtime/pi/piMcpToolAdapter', () => ({
  buildPiMcpToolName: (server: string, tool: string) => `mcp__${server}__${tool}`,
  warmMcpToolCatalogs: async () => undefined,
  buildMcpToolDefinitions: async () => ({
    tools: [
      {
        name: TO_MARKDOWN_RUNTIME_NAME,
        label: 'to_markdown',
        description: 'Convert one supported local document to Markdown.',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        execute: mocks.execute
      }
    ],
    close: mocks.close
  })
}))

import { prepareCocoCherryCapabilities } from '../cocoCherryCapabilities'

const agent = {
  id: 'agent-1',
  name: 'COCO',
  model: 'vapi::gpt-5.6-sol',
  mcps: []
} as Partial<AgentEntity> as AgentEntity
const session = { id: 'session-1', agentId: 'agent-1', workspace: { path: '/mock/workspace' } } as AgentSessionEntity

async function writeMarkdownFixture(markdown: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coco-to-markdown-'))
  const target = path.join(directory, 'converted.md')
  await writeFile(target, markdown, 'utf-8')
  return target
}

/** Mimic the MCP bridge: `to_markdown` reports `{ path, chars }` as JSON text, no structured content. */
function toMarkdownResult(markdownPath: string, chars: number) {
  return { content: [{ type: 'text', text: JSON.stringify({ path: markdownPath, chars }) }], details: undefined }
}

const credentials = {
  providerId: 'vapi',
  modelId: 'gemini-3.5-flash',
  apiKey: 'key',
  chatCompletionsUrl: 'https://gateway.test/v1/chat/completions',
  headers: {}
}

function prepare(overrides: Partial<Parameters<typeof prepareCocoCherryCapabilities>[0]> = {}) {
  return prepareCocoCherryCapabilities({
    agent,
    session,
    systemPrompt: 'BASE PROMPT',
    readOnly: false,
    credentials,
    attachmentPaths: [{ filename: 'shot.png', path: '/mock/workspace/shot.png', assetId: 'asset-1' }],
    ...overrides
  })
}

describe('prepareCocoCherryCapabilities document reading', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // coco's MCP set has no `read_file`, so a converted document that only comes back as a path is
  // unreachable — the pdf/excel question the user asked can never be answered.
  it('inlines the converted document text instead of returning only a path', async () => {
    const markdown = '# 季度报表\n\n| 项目 | 金额 |\n| --- | --- |\n| 收入 | 100 |'
    const markdownPath = await writeMarkdownFixture(markdown)
    mocks.execute.mockResolvedValue(toMarkdownResult(markdownPath, markdown.length))

    const capabilities = await prepare()
    const result = (await capabilities.invoke(
      TO_MARKDOWN_RUNTIME_NAME,
      { path: '/mock/workspace/report.xlsx' },
      'call-1',
      new AbortController().signal
    )) as { path: string; text: string; truncated: boolean }

    expect(result.text).toBe(markdown)
    expect(result.truncated).toBe(false)
    expect(result.path).toBe(markdownPath)
  })

  it('reports truncation so the model does not present a partial document as complete', async () => {
    const markdown = 'x'.repeat(30_001)
    const markdownPath = await writeMarkdownFixture(markdown)
    mocks.execute.mockResolvedValue(toMarkdownResult(markdownPath, markdown.length))

    const capabilities = await prepare()
    const result = (await capabilities.invoke(
      TO_MARKDOWN_RUNTIME_NAME,
      { path: '/mock/workspace/long.pdf' },
      'call-2',
      new AbortController().signal
    )) as { text: string; truncated: boolean; note?: string }

    expect(result.text).toHaveLength(30_000)
    expect(result.truncated).toBe(true)
    expect(result.note).toBeTruthy()
  })

  it('passes an unreadable conversion result through untouched', async () => {
    mocks.execute.mockResolvedValue(toMarkdownResult(path.join(os.tmpdir(), 'coco-missing.md'), 10))

    const capabilities = await prepare()
    const result = await capabilities.invoke(
      TO_MARKDOWN_RUNTIME_NAME,
      { path: '/mock/workspace/report.pdf' },
      'call-3',
      new AbortController().signal
    )

    expect(result).toEqual(toMarkdownResult(path.join(os.tmpdir(), 'coco-missing.md'), 10).content)
  })

  // The pipeline server's prompt is canvas-only; without this the model has no way to learn it
  // never receives pixels, and answers image questions by running an image node.
  it('tells the model how attachments arrive and names the real document tool', async () => {
    const capabilities = await prepare()

    expect(capabilities.systemPrompt).toContain('BASE PROMPT')
    expect(capabilities.systemPrompt).toContain(TO_MARKDOWN_RUNTIME_NAME)
    expect(capabilities.systemPrompt).toContain('<coco_attachments>')
  })
})

describe('prepareCocoCherryCapabilities image understanding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Images cannot ride along with the Hermes turn, so looking at one has to be a tool the
  // model is told about — otherwise it reaches for an image-generation node instead.
  it('advertises the vision tool and auto-approves it', async () => {
    const capabilities = await prepare()
    const vision = capabilities.tools.find((tool) => tool.name === VISION_RUNTIME_NAME)

    expect(vision).toBeDefined()
    expect(vision?.description).toContain('does NOT generate or edit images')
    expect(capabilities.admission(VISION_RUNTIME_NAME)).toBe('auto')
    expect(capabilities.systemPrompt).toContain(VISION_RUNTIME_NAME)
  })

  it('stays usable in read-only sessions', async () => {
    const capabilities = await prepare({ readOnly: true })

    expect(capabilities.admission(VISION_RUNTIME_NAME)).toBe('auto')
  })

  // No local credentials means no model to ask; advertising the tool would guarantee a failed call.
  it('omits the vision tool when the model has no local credentials', async () => {
    const capabilities = await prepare({ credentials: undefined })

    expect(capabilities.tools.some((tool) => tool.name === VISION_RUNTIME_NAME)).toBe(false)
    expect(capabilities.systemPrompt).toContain('没有可用的图像识别工具')
  })

  // DeepSeek chat/reasoner rejects image_url. Advertising look_at_image made the
  // orchestrator POST a multimodal completion after canvas gen finished, which
  // new-api logged as Invalid request parameters.
  it('omits the vision tool when the composer model is DeepSeek', async () => {
    const capabilities = await prepare({
      credentials: { ...credentials, modelId: 'deepseek-v4-flash' }
    })

    expect(capabilities.tools.some((tool) => tool.name === VISION_RUNTIME_NAME)).toBe(false)
    expect(capabilities.systemPrompt).toContain('没有图像输入能力')
    expect(capabilities.systemPrompt).not.toContain(VISION_RUNTIME_NAME)
  })
})
