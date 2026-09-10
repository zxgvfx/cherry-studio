/**
 * Image understanding for the coco canvas agent.
 *
 * The agent loop runs inside the vendored Hermes runner, whose protocol coerces
 * the user turn to a plain string (`coco_runtime/runner.py`), so image parts
 * cannot travel with the conversation. Instead the agent asks for a look, and
 * this tool performs one multimodal call against the model the user picked in
 * the composer — the same provider, key, and model id the turn already uses.
 *
 * Only files attached to this session are readable: the caller passes the
 * resolved attachment list, and a requested path must match one of them.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { modelService } from '@data/services/ModelService'
import { loggerService } from '@logger'
import { isVisionModel } from '@shared/utils/model'

import type { CherryChatCredentials } from './cocoCherryProvider'
import type { PipelineToolDefinition } from './cocoLocalLoop'
import type { CocoLocalAttachmentPath } from './pipelineClient'

const logger = loggerService.withContext('CocoVisionTool')

export const COCO_VISION_TOOL_LABEL = 'look_at_image'

/** Formats providers reliably accept as `image_url` data URLs. */
const VISION_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/** Well past any real screenshot; keeps a stray 100MB plate from being base64'd into a request. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024

const DEFAULT_QUESTION = '请详细描述这张图片的内容。'

/**
 * DeepSeek chat/reasoner (and v3/v4 text models) reject `image_url`. DeepSeek-VL
 * is a different family. Checked before the catalog because vapi aliases often
 * copy another model's capabilities.
 */
const TEXT_ONLY_DEEPSEEK_RE = /deepseek/i
const DEEPSEEK_VISION_RE = /vl|vision/i

/** Ids that are vision-capable even when the vapi catalog row forgot IMAGE_RECOGNITION. */
const VISION_MODEL_ID_RE =
  /gemini|gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5|claude|qwen[-_.]?vl|qwen[-_.]?omni|glm-4v|internvl|pixtral|llava|\bvl\b|vision|omni/i

export interface CocoVisionToolOptions {
  credentials: CherryChatCredentials
  /** Attachments resolved for this turn — the only files this tool may open. */
  sources: readonly CocoLocalAttachmentPath[]
}

function stripModelRouteAlias(modelId: string): string {
  return modelId.replace(/@[\w.-]+$/i, '')
}

/**
 * Whether the composer-selected model can accept an `image_url` part.
 * Sending pixels to DeepSeek is what produced new-api `Invalid request parameters`.
 */
export function composerModelSupportsVision(
  credentials: Pick<CherryChatCredentials, 'providerId' | 'modelId'>
): boolean {
  const modelId = credentials.modelId
  const stripped = stripModelRouteAlias(modelId)
  if (TEXT_ONLY_DEEPSEEK_RE.test(stripped) && !DEEPSEEK_VISION_RE.test(stripped)) return false
  try {
    if (isVisionModel(modelService.getByKey(credentials.providerId, modelId))) return true
  } catch {
    // Catalog row missing — fall through to id heuristics.
  }
  return VISION_MODEL_ID_RE.test(stripped)
}

export function cocoVisionToolDefinition(runtimeName: string): PipelineToolDefinition {
  return {
    name: runtimeName,
    description:
      'Look at an image attached to this session and answer a question about it. ' +
      'Use this whenever the user asks what an image contains, or asks you to read, analyze, ' +
      'compare, or check an attached picture. Pass the local path from the attachment list. ' +
      'This does NOT generate or edit images — never substitute an image-generation node for it.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Local path of an attached image, exactly as listed in the attachment paths block.'
        },
        question: {
          type: 'string',
          description: `What to answer about the image. Defaults to "${DEFAULT_QUESTION}".`
        }
      },
      required: ['path']
    }
  }
}

function isSameFsPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

/**
 * Map the requested path onto an attachment of this session. Falls back to a
 * unique filename match because models routinely echo the display name instead
 * of the full path.
 */
function resolveSource(sources: readonly CocoLocalAttachmentPath[], requested: string): CocoLocalAttachmentPath | null {
  const trimmed = requested.trim().replace(/^["']|["']$/g, '')
  if (!trimmed) return null
  const byPath = sources.find((source) => isSameFsPath(source.path, trimmed))
  if (byPath) return byPath

  const wanted = path.basename(trimmed).toLowerCase()
  const byName = sources.filter(
    (source) => source.filename.toLowerCase() === wanted || path.basename(source.path).toLowerCase() === wanted
  )
  return byName.length === 1 ? byName[0]! : null
}

function readAssistantText(payload: unknown): string {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  const choices = Array.isArray(record?.choices) ? record.choices : []
  const message = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : null
  const content =
    message?.message && typeof message.message === 'object'
      ? (message.message as Record<string, unknown>).content
      : undefined
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''
      )
      .filter(Boolean)
      .join('')
  }
  return ''
}

export async function invokeCocoVisionTool(
  options: CocoVisionToolOptions,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  if (!composerModelSupportsVision(options.credentials)) {
    return {
      ok: false,
      error: `当前对话模型 ${options.credentials.modelId} 不支持图像输入，不会把图片发给它。`,
      hint: '把编排模型改成支持识图的模型（例如 Gemini / GPT-4o / Claude），不要用生成节点替代看图。'
    }
  }

  const requested = typeof args.path === 'string' ? args.path : ''
  const source = resolveSource(options.sources, requested)
  if (!source) {
    return {
      ok: false,
      error: `无法在本会话的附件里找到这张图片：${requested || '(empty path)'}`,
      availableImages: options.sources
        .filter((item) => VISION_MIME_BY_EXTENSION[path.extname(item.filename).toLowerCase()])
        .map((item) => ({ filename: item.filename, path: item.path }))
    }
  }

  const mediaType = VISION_MIME_BY_EXTENSION[path.extname(source.path).toLowerCase()]
  if (!mediaType) {
    return {
      ok: false,
      error: `不是可识别的图片格式：${source.filename}。支持 ${Object.keys(VISION_MIME_BY_EXTENSION).join(' / ')}。`
    }
  }

  let bytes: Buffer
  try {
    bytes = await readFile(source.path)
  } catch (error) {
    return { ok: false, error: `读取图片失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `图片过大（${Math.round(bytes.byteLength / 1024 / 1024)} MB），超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB 上限。`
    }
  }

  const question = typeof args.question === 'string' && args.question.trim() ? args.question.trim() : DEFAULT_QUESTION
  const response = await fetch(options.credentials.chatCompletionsUrl, {
    method: 'POST',
    signal,
    headers: options.credentials.headers,
    body: JSON.stringify({
      model: options.credentials.modelId,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image_url', image_url: { url: `data:${mediaType};base64,${bytes.toString('base64')}` } }
          ]
        }
      ]
    })
  })

  const raw = await response.text()
  if (!response.ok) {
    logger.warn('coco vision call failed', { status: response.status, model: options.credentials.modelId })
    return {
      ok: false,
      error: `视觉调用失败（HTTP ${response.status}）：${raw.slice(0, 400)}`,
      hint: '当前对话选择的模型可能不支持图像输入。把这一点告诉用户，并建议改选支持图像识别的模型，不要用生成节点替代回答。'
    }
  }

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return { ok: false, error: `视觉调用返回了无法解析的响应：${raw.slice(0, 400)}` }
  }

  const text = readAssistantText(payload).trim()
  if (!text) return { ok: false, error: '视觉调用没有返回任何内容。' }
  return { ok: true, filename: source.filename, assetId: source.assetId, model: options.credentials.modelId, text }
}
