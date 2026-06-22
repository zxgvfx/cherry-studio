/**
 * Fetch wrapper：把 OpenAI 兼容端点请求体中的 `input_audio` 改写成 `file` 格式
 *
 * 背景：
 * - 部分以 OpenAI 兼容协议接入的 Gemini 网关（如 gpt.ge / 自建 Higress + Gemini OpenAI 兼容）
 *   只接受 OpenAI 文件输入扩展格式：
 *     { type: 'file', file: { filename, file_data: 'data:<mime>;base64,<data>' } }
 *   而 AI SDK 的 @ai-sdk/openai-compatible 会把 audio file part 转成 OpenAI 官方的：
 *     { type: 'input_audio', input_audio: { data, format: 'mp3' | 'wav' } }
 *   两种格式不兼容，导致网关静默忽略音频，模型回复 "未收到音频"。
 *
 * - 该 wrapper 在请求送出前解析 JSON body，把所有 `input_audio` 内容重写为 `file` 格式。
 *
 * 仅在 fallback 到 openai-compatible 通道时启用，对官方 OpenAI 等接收原生 input_audio 的 provider
 * 不要使用此 wrapper，避免破坏正常流程。
 */
import { loggerService } from '@logger'

const logger = loggerService.withContext('audioCompatFetch')

const AUDIO_FORMAT_TO_MIME: Record<string, string> = {
  mp3: 'audio/mp3',
  wav: 'audio/wav'
}

type FetchFn = typeof fetch

function pickUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url ?? ''
}

function shouldHandleUrl(url: string): boolean {
  return url.includes('/chat/completions')
}

function rewriteInputAudio(body: string): { body: string; modified: boolean } {
  let json: any
  try {
    json = JSON.parse(body)
  } catch {
    return { body, modified: false }
  }
  if (!json || !Array.isArray(json.messages)) {
    return { body, modified: false }
  }

  let modified = false
  for (const msg of json.messages) {
    if (!Array.isArray(msg?.content)) continue
    for (let i = 0; i < msg.content.length; i++) {
      const item = msg.content[i]
      if (item?.type === 'input_audio' && item.input_audio?.data) {
        const format = item.input_audio.format ?? 'wav'
        const mime = AUDIO_FORMAT_TO_MIME[format] ?? 'audio/wav'
        const data = item.input_audio.data
        msg.content[i] = {
          type: 'file',
          file: {
            filename: `audio.${format}`,
            file_data: `data:${mime};base64,${data}`
          }
        }
        modified = true
      }
    }
  }

  if (!modified) return { body, modified: false }
  return { body: JSON.stringify(json), modified: true }
}

/**
 * 包装一个 fetch 函数，把发往 /chat/completions 的请求体内 `input_audio` 改写成 `file` 格式。
 * 同时打印请求体大小、响应状态等关键信息，便于诊断 4xx/5xx。
 */
export function createAudioCompatFetch(baseFetch: FetchFn): FetchFn {
  return async (input, init) => {
    let finalInit = init
    let url = ''
    let hasAudio = false
    try {
      if (init?.body && typeof init.body === 'string') {
        url = pickUrl(input)
        if (shouldHandleUrl(url)) {
          const { body, modified } = rewriteInputAudio(init.body)
          if (modified) {
            hasAudio = true
            const sizeKB = Math.round(body.length / 1024)
            logger.info(
              `Rewrote input_audio -> file; POST ${url} payload ~${sizeKB} KB ` +
                `(if this exceeds gateway client_max_body_size you'll get 413/connection reset)`
            )
            finalInit = { ...init, body }
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to rewrite request body for audio compat:', error as Error)
    }

    const t0 = performance.now()
    try {
      const response = await baseFetch(input, finalInit)
      if (hasAudio || !response.ok) {
        const elapsed = Math.round(performance.now() - t0)
        logger.info(
          `Audio request finished: status=${response.status} ${response.statusText} elapsed=${elapsed}ms url=${url}`
        )
        if (!response.ok && hasAudio) {
          // 克隆一份读 body 拿到错误详情，不影响上层使用 response
          response
            .clone()
            .text()
            .then((text) => {
              const preview = text.length > 800 ? text.slice(0, 800) + '...[truncated]' : text
              logger.warn(`Gateway returned ${response.status} body: ${preview}`)
            })
            .catch(() => {
              /* ignore */
            })
        }
      }
      return response
    } catch (err) {
      const elapsed = Math.round(performance.now() - t0)
      if (hasAudio) {
        logger.warn(
          `Audio request threw after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)} url=${url}`
        )
      }
      throw err
    }
  }
}
