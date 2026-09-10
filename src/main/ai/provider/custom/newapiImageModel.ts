import type { ImageModelV3, ImageModelV3CallOptions } from '@ai-sdk/provider'
import type { FetchFunction } from '@ai-sdk/provider-utils'
import { loggerService } from '@logger'
import { downloadImageAsBase64 } from '@main/utils/downloadAsBase64'

import {
  buildNewApiGeminiImageOptions,
  isGeminiStyleImageModel,
  isOpenAiGptImageModel
} from '../../utils/geminiImageParams'

const logger = loggerService.withContext('NewApiImageModel')

type GoogleImageConfig = {
  aspectRatio?: string
  imageSize?: string
}

function requestUrlOf(input: Parameters<FetchFunction>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function isOpenAiImagesPath(url: string): boolean {
  try {
    return /\/images\/(generations|edits)(?:\/|\?|$)/.test(new URL(url).pathname)
  } catch {
    return /\/images\/(generations|edits)(?:\/|\?|$)/.test(url)
  }
}

function b64FromDataUrl(url: string): string | undefined {
  if (!url.startsWith('data:')) return undefined
  const comma = url.indexOf(',')
  return comma >= 0 ? url.slice(comma + 1) : undefined
}

function rebuildJsonResponse(response: Response, body: string): Response {
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.set('content-type', 'application/json')
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * New API / RightCode often ignore `response_format: b64_json` and return
 * `data[].url`. `@ai-sdk/openai-compatible` only accepts `data[].b64_json`,
 * which surfaces as `AI_APICallError: Invalid JSON response`. Download the
 * URL (or unwrap a data-URL) and stamp `b64_json` so the existing parser works.
 */
export async function hydrateOpenAiImagePayload(
  payload: unknown,
  download: (url: string) => Promise<string | null>
): Promise<unknown> {
  if (!payload || typeof payload !== 'object' || !('data' in payload)) return payload
  const data = (payload as { data: unknown }).data
  if (!Array.isArray(data)) return payload

  const next = await Promise.all(
    data.map(async (item) => {
      if (!item || typeof item !== 'object') return item
      const record = item as Record<string, unknown>
      if (typeof record.b64_json === 'string' && record.b64_json.length > 0) return record
      const url = record.url
      if (typeof url !== 'string' || url.length === 0) return record
      const fromDataUrl = b64FromDataUrl(url)
      const b64 = fromDataUrl ?? (await download(url))
      if (!b64) {
        throw new Error(`Image gateway returned a URL but the download failed: ${url}`)
      }
      return { ...record, b64_json: b64 }
    })
  )

  return { ...(payload as Record<string, unknown>), data: next }
}

async function defaultDownloadImage(url: string): Promise<string | null> {
  const fromDataUrl = b64FromDataUrl(url)
  if (fromDataUrl) return fromDataUrl
  const downloaded = await downloadImageAsBase64(url)
  return downloaded?.data ?? null
}

/** Intercept `/v1/images/{generations,edits}` JSON so URL-only replies become `b64_json`. */
const IMAGE_FIELD = /^(image|mask)(\[\])?$/i

function mimeToImageExt(mime: string): string {
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/gif') return 'gif'
  return 'png'
}

function imagePartFilename(field: string, value: Blob): string {
  const named = value instanceof File && value.name.trim() ? value.name : ''
  if (named.includes('.')) return named
  const base = field.replace(/\[\]$/, '') || 'image'
  return `${base}.${mimeToImageExt(value.type)}`
}

function formModelId(form: FormData): string | undefined {
  const model = form.get('model')
  return typeof model === 'string' ? model : undefined
}

function ensureGptImageSizeOnForm(form: FormData): void {
  const model = formModelId(form)
  if (!model || !isOpenAiGptImageModel(model)) return
  if (!form.has('size') || form.get('size') === '') {
    form.delete('size')
    form.append('size', 'auto')
  }
}

function ensureGptImageSizeOnJsonBody(body: unknown): unknown {
  if (!body || typeof body !== 'string') return body
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body
    if (typeof parsed.model !== 'string' || !isOpenAiGptImageModel(parsed.model)) return body
    if (parsed.size == null || parsed.size === '') {
      return JSON.stringify({ ...parsed, size: 'auto' })
    }
    return body
  } catch {
    return body
  }
}

/**
 * Higress / NewAPI reject `/images/edits` as `invalid_multipart` when the
 * image part has no filename, or when a leftover `Content-Type: application/json`
 * header (from provider extraHeaders) overrides the multipart boundary.
 *
 * gpt-image relays also 500 when `size` is missing (`请传递 size 参数`); the
 * painting UI sentinel `'auto'` is restored on the wire for those models.
 */
export function prepareOpenAiImageEditRequest(
  input: Parameters<FetchFunction>[0],
  init?: Parameters<FetchFunction>[1]
): { input: Parameters<FetchFunction>[0]; init?: Parameters<FetchFunction>[1] } {
  if (!init?.body || !isOpenAiImagesPath(requestUrlOf(input))) return { input, init }
  if (!(init.body instanceof FormData)) {
    const nextBody = ensureGptImageSizeOnJsonBody(init.body)
    return nextBody === init.body ? { input, init } : { input, init: { ...init, body: nextBody as typeof init.body } }
  }

  const form = new FormData()
  for (const [key, value] of init.body.entries()) {
    if (typeof value === 'string') {
      form.append(key, value)
      continue
    }
    if (IMAGE_FIELD.test(key)) {
      form.append(key, value, imagePartFilename(key, value))
      continue
    }
    form.append(key, value)
  }
  ensureGptImageSizeOnForm(form)

  const headers = new Headers(init.headers)
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase() === 'content-type') headers.delete(name)
  }

  return { input, init: { ...init, body: form, headers } }
}

export function wrapNewApiImageFetch(
  fetchImpl?: FetchFunction,
  download: (url: string) => Promise<string | null> = defaultDownloadImage
): FetchFunction {
  const inner: FetchFunction = fetchImpl ?? globalThis.fetch.bind(globalThis)
  return async (input, init) => {
    const prepared = prepareOpenAiImageEditRequest(input, init)
    const response = await inner(prepared.input, prepared.init)
    if (!response.ok) return response
    if (!isOpenAiImagesPath(requestUrlOf(prepared.input))) return response
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('json')) return response

    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return rebuildJsonResponse(response, text)
    }

    try {
      const hydrated = await hydrateOpenAiImagePayload(parsed, download)
      return rebuildJsonResponse(response, JSON.stringify(hydrated))
    } catch (error) {
      logger.error('Failed to hydrate image URL response', { error })
      throw error
    }
  }
}

/**
 * New API lists Nano Banana / Gemini chat-image under ids like
 * `nano-banana-pro@vapi` and still serves them through OpenAI
 * `/v1/images/generations`. The inner `OpenAICompatibleImageModel` forwards
 * DALL·E pixel `size` (e.g. leftover `1792x1024`) and ignores `aspectRatio`,
 * which the Gemini relay rejects as `unsupported size`.
 *
 * Keep the OpenAI images path (the `@vapi` channel suffix lives in the JSON
 * `model` field, not a `/v1beta/models/{id}` URL) but rewrite the call:
 * drop WxH `size`, and put aspect / 1K-4K in `extra_body` for New API to
 * merge into `generationConfig.imageConfig`.
 */
export function wrapNewApiImageModel(modelId: string, inner: ImageModelV3): ImageModelV3 {
  if (isGeminiStyleImageModel(modelId)) {
    return {
      specificationVersion: inner.specificationVersion,
      provider: inner.provider,
      modelId: inner.modelId,
      maxImagesPerCall: inner.maxImagesPerCall,
      async doGenerate(options: ImageModelV3CallOptions) {
        const googleImageConfig = (options.providerOptions?.google as { imageConfig?: GoogleImageConfig } | undefined)
          ?.imageConfig
        const rewritten = buildNewApiGeminiImageOptions({
          size: options.size,
          aspectRatio: options.aspectRatio ?? googleImageConfig?.aspectRatio,
          imageSize: googleImageConfig?.imageSize
        })
        const existing = (options.providerOptions?.newapi ?? {}) as Record<string, unknown>
        const existingExtra = (existing.extra_body as Record<string, unknown> | undefined) ?? {}

        return inner.doGenerate({
          ...options,
          size: rewritten.size,
          ...(rewritten.aspectRatio ? { aspectRatio: rewritten.aspectRatio } : {}),
          providerOptions: {
            ...options.providerOptions,
            newapi: {
              ...existing,
              ...(rewritten.extraBody ? { extra_body: { ...existingExtra, ...rewritten.extraBody } } : {})
            }
          }
        })
      }
    }
  }

  if (!isOpenAiGptImageModel(modelId)) return inner

  return {
    specificationVersion: inner.specificationVersion,
    provider: inner.provider,
    modelId: inner.modelId,
    maxImagesPerCall: inner.maxImagesPerCall,
    async doGenerate(options: ImageModelV3CallOptions) {
      const rawSize = options.size as string | undefined
      const size = !rawSize || rawSize === 'auto' ? 'auto' : rawSize
      return inner.doGenerate({ ...options, size: size as ImageModelV3CallOptions['size'] })
    }
  }
}
