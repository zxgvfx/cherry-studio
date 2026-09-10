import type { ImageModelV3, ImageModelV3CallOptions } from '@ai-sdk/provider'
import { describe, expect, it, vi } from 'vitest'

import {
  hydrateOpenAiImagePayload,
  prepareOpenAiImageEditRequest,
  wrapNewApiImageFetch,
  wrapNewApiImageModel
} from '../newapiImageModel'

function innerModel(doGenerate: ImageModelV3['doGenerate']): ImageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'newapi.image',
    modelId: 'inner',
    maxImagesPerCall: 10,
    doGenerate
  }
}

const baseOptions = {
  prompt: 'a cat',
  n: 1,
  seed: undefined,
  files: undefined,
  mask: undefined
} as ImageModelV3CallOptions

describe('wrapNewApiImageModel', () => {
  it('leaves gpt-image pixel sizes on the inner OpenAI-compatible path', async () => {
    const doGenerate = vi.fn().mockResolvedValue({ images: [], warnings: [], response: {} })
    const wrapped = wrapNewApiImageModel('gpt-image-2@vapi', innerModel(doGenerate))
    await wrapped.doGenerate({ ...baseOptions, size: '1792x1024' })
    expect(doGenerate).toHaveBeenCalledWith(expect.objectContaining({ size: '1792x1024' }))
  })

  it("defaults missing gpt-image size to 'auto' so Higress image edits do not 500", async () => {
    const doGenerate = vi.fn().mockResolvedValue({ images: [], warnings: [], response: {} })
    const wrapped = wrapNewApiImageModel('gpt-image-2@vapi', innerModel(doGenerate))
    await wrapped.doGenerate({ ...baseOptions, size: undefined })
    expect(doGenerate).toHaveBeenCalledWith(expect.objectContaining({ size: 'auto' }))
  })

  it('drops 1792x1024 for nano-banana-pro@vapi and forwards imageConfig via extra_body', async () => {
    const doGenerate = vi.fn().mockResolvedValue({ images: [], warnings: [], response: {} })
    const wrapped = wrapNewApiImageModel('nano-banana-pro@vapi', innerModel(doGenerate))
    await wrapped.doGenerate({
      ...baseOptions,
      size: '1792x1024',
      providerOptions: { google: { imageConfig: { imageSize: '1K' } } }
    })
    expect(doGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        size: undefined,
        aspectRatio: '16:9',
        providerOptions: expect.objectContaining({
          newapi: {
            extra_body: {
              generationConfig: { imageConfig: { aspectRatio: '16:9', imageSize: '1K' } }
            }
          }
        })
      })
    )
  })
})

describe('hydrateOpenAiImagePayload', () => {
  it('stamps b64_json from data[].url so the OpenAI-compatible parser can read it', async () => {
    const download = vi.fn().mockResolvedValue('QUJD')
    const hydrated = await hydrateOpenAiImagePayload(
      {
        created: 1,
        data: [{ url: 'https://file.example/a.png' }]
      },
      download
    )
    expect(download).toHaveBeenCalledWith('https://file.example/a.png')
    expect(hydrated).toEqual({
      created: 1,
      data: [{ url: 'https://file.example/a.png', b64_json: 'QUJD' }]
    })
  })

  it('unwraps data: URLs without downloading', async () => {
    const download = vi.fn()
    const hydrated = await hydrateOpenAiImagePayload({ data: [{ url: 'data:image/png;base64,QUJD' }] }, download)
    expect(download).not.toHaveBeenCalled()
    expect(hydrated).toEqual({ data: [{ url: 'data:image/png;base64,QUJD', b64_json: 'QUJD' }] })
  })

  it('leaves existing b64_json alone', async () => {
    const download = vi.fn()
    const payload = { data: [{ b64_json: 'already' }] }
    expect(await hydrateOpenAiImagePayload(payload, download)).toEqual(payload)
    expect(download).not.toHaveBeenCalled()
  })
})

describe('wrapNewApiImageFetch', () => {
  it('rewrites a URL-only /images/generations body before the SDK parses it', async () => {
    const inner = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: 'https://file.example/a.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    const fetch = wrapNewApiImageFetch(inner, async () => 'QUJD')
    const response = await fetch('http://new-api.example/v1/images/generations', { method: 'POST' })
    expect(await response.json()).toEqual({
      data: [{ url: 'https://file.example/a.png', b64_json: 'QUJD' }]
    })
  })

  it('gives image parts a filename and drops JSON content-type on /images/edits', async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
    const form = new FormData()
    form.append('model', 'gpt-image-2')
    form.append('prompt', 'edit')
    form.append('image', png)

    const prepared = prepareOpenAiImageEditRequest('http://new-api.example/v1/images/edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
      body: form
    })
    const next = prepared.init?.body as FormData
    const image = next.get('image')
    expect(image).toBeInstanceOf(File)
    expect((image as File).name).toBe('image.png')
    expect(new Headers(prepared.init?.headers).get('content-type')).toBeNull()
    expect(new Headers(prepared.init?.headers).get('authorization')).toBe('Bearer x')
    expect(next.get('size')).toBe('auto')
  })

  it('does not override an explicit gpt-image size on /images/edits', async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
    const form = new FormData()
    form.append('model', 'gpt-image-2@vapi')
    form.append('prompt', 'edit')
    form.append('size', '1024x1024')
    form.append('image', png)

    const prepared = prepareOpenAiImageEditRequest('http://new-api.example/v1/images/edits', {
      method: 'POST',
      body: form
    })
    expect((prepared.init?.body as FormData).get('size')).toBe('1024x1024')
  })

  it('injects size auto into gpt-image /images/generations JSON when size is missing', () => {
    const prepared = prepareOpenAiImageEditRequest('http://new-api.example/v1/images/generations', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-image-2@vapi', prompt: 'a cat', n: 1 })
    })
    expect(JSON.parse(String(prepared.init?.body))).toEqual({
      model: 'gpt-image-2@vapi',
      prompt: 'a cat',
      n: 1,
      size: 'auto'
    })
  })
})
