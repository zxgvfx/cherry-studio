import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CherryChatCredentials } from '../cocoCherryProvider'
import { composerModelSupportsVision, invokeCocoVisionTool } from '../cocoVisionTool'

vi.mock('@data/services/ModelService', () => ({
  modelService: {
    getByKey: () => {
      throw new Error('catalog row missing')
    }
  }
}))

const credentials: CherryChatCredentials = {
  providerId: 'vapi',
  modelId: 'gemini-3.5-flash',
  apiKey: 'key',
  chatCompletionsUrl: 'https://gateway.test/v1/chat/completions',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key' }
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])

async function attachImage(filename = 'shot.png'): Promise<{ filename: string; path: string; assetId: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coco-vision-'))
  const target = path.join(directory, filename)
  await writeFile(target, PNG_BYTES)
  return { filename, path: target, assetId: 'asset-1' }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function answer(text: string) {
  return { choices: [{ message: { role: 'assistant', content: text } }] }
}

describe('invokeCocoVisionTool', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // The canvas agent cannot receive pixels in its conversation, so this call is the only
  // path from "user asked what is in the picture" to an actual answer.
  it('sends the image to the composer-selected model as a multimodal message', async () => {
    const source = await attachImage()
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(answer('图里是一只橙色的猫。')))
    vi.stubGlobal('fetch', fetchMock)

    const result = (await invokeCocoVisionTool(
      { credentials, sources: [source] },
      { path: source.path, question: '图里有什么？' },
      new AbortController().signal
    )) as { ok: boolean; text: string; model: string }

    expect(result.ok).toBe(true)
    expect(result.text).toBe('图里是一只橙色的猫。')
    expect(result.model).toBe('gemini-3.5-flash')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(credentials.chatCompletionsUrl)
    const body = JSON.parse((init as { body: string }).body)
    expect(body.model).toBe('gemini-3.5-flash')
    expect(body.stream).toBe(false)
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: '图里有什么？' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` } }
    ])
  })

  it('resolves an attachment referenced by filename alone', async () => {
    const source = await attachImage('reference.png')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(answer('ok')))
    vi.stubGlobal('fetch', fetchMock)

    const result = (await invokeCocoVisionTool(
      { credentials, sources: [source] },
      { path: 'reference.png' },
      new AbortController().signal
    )) as { ok: boolean }

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  // The model chooses the path, so an un-attached path must never be opened and shipped
  // to the provider.
  it('refuses a path that is not attached to this session', async () => {
    const source = await attachImage()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = (await invokeCocoVisionTool(
      { credentials, sources: [source] },
      { path: path.join(os.homedir(), '.ssh', 'id_rsa') },
      new AbortController().signal
    )) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toContain('无法在本会话的附件里找到')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a non-image attachment without calling the model', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'coco-vision-doc-'))
    const target = path.join(directory, 'report.pdf')
    await writeFile(target, 'not an image')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = (await invokeCocoVisionTool(
      { credentials, sources: [{ filename: 'report.pdf', path: target, assetId: 'asset-2' }] },
      { path: target },
      new AbortController().signal
    )) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toContain('不是可识别的图片格式')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // A non-vision model must surface as "this model cannot see images", not as a silent
  // fallback into running an image-generation node.
  it('returns a structured error with a model-capability hint when the provider rejects the call', async () => {
    const source = await attachImage()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('model does not support image input', { status: 400 }))
    )

    const result = (await invokeCocoVisionTool(
      { credentials, sources: [source] },
      { path: source.path },
      new AbortController().signal
    )) as { ok: boolean; error: string; hint: string }

    expect(result.ok).toBe(false)
    expect(result.error).toContain('HTTP 400')
    expect(result.hint).toContain('不支持图像输入')
  })

  it('never posts image_url when the composer model is DeepSeek', async () => {
    const source = await attachImage()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = (await invokeCocoVisionTool(
      { credentials: { ...credentials, modelId: 'deepseek-chat' }, sources: [source] },
      { path: source.path },
      new AbortController().signal
    )) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toContain('不支持图像输入')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('composerModelSupportsVision', () => {
  it('treats DeepSeek chat/reasoner as text-only even with a vapi route alias', () => {
    expect(composerModelSupportsVision({ providerId: 'vapi', modelId: 'deepseek-v4-flash' })).toBe(false)
    expect(composerModelSupportsVision({ providerId: 'vapi', modelId: 'deepseek-chat@vapi' })).toBe(false)
  })

  it('still recognizes known vision ids when the catalog row is missing', () => {
    expect(composerModelSupportsVision({ providerId: 'vapi', modelId: 'gemini-3.5-flash' })).toBe(true)
    expect(composerModelSupportsVision({ providerId: 'vapi', modelId: 'gpt-4o@vapi' })).toBe(true)
  })
})
