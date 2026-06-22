/**
 * AI SDK 到 Cherry Studio Chunk 适配器
 * 用于将 AI SDK 的 fullStream 转换为 Cherry Studio 的 chunk 格式
 */

import { loggerService } from '@logger'
import type {
  AISDKWebSearchResult,
  GenerateImageResponse,
  MCPTool,
  WebSearchResults,
  WebSearchSource
} from '@renderer/types'
import { WEB_SEARCH_SOURCE } from '@renderer/types'
import type { Chunk, ProviderMetadata } from '@renderer/types/chunk'
import { ChunkType } from '@renderer/types/chunk'
import { ProviderSpecificError } from '@renderer/types/provider-specific-error'
import { formatErrorMessage, isAbortError } from '@renderer/utils/error'
import type { IdleTimeoutHandle } from '@renderer/utils/IdleTimeoutController'
import { convertLinks, flushLinkConverterBuffer } from '@renderer/utils/linkConverter'
import type { ClaudeCodeRawValue } from '@shared/agents/claudecode/types'
import { AISDKError, type TextStreamPart, type ToolSet } from 'ai'

import { ToolCallChunkHandler } from './handleToolCallChunk'

const logger = loggerService.withContext('AiSdkToChunkAdapter')

/**
 * AI SDK 到 Cherry Studio Chunk 适配器类
 * 处理 fullStream 到 Cherry Studio chunk 的转换
 */
export class AiSdkToChunkAdapter {
  toolCallHandler: ToolCallChunkHandler
  private accumulate: boolean | undefined
  private isFirstChunk = true
  private enableWebSearch: boolean = false
  private onSessionUpdate?: (sessionId: string) => void
  private responseStartTimestamp: number | null = null
  private firstTokenTimestamp: number | null = null
  private hasTextContent = false
  private getSessionWasCleared?: () => boolean
  private mcpToolMarkerBuffer = ''
  private responseTagBuffer = ''
  private pendingTextStart = false
  private actionBuffer: string | null = null
  private providerId?: string
  private idleTimeout?: IdleTimeoutHandle

  private static readonly MCP_TOOL_MARKER_START = '[MCP_TOOL_CHUNK]'
  private static readonly MCP_TOOL_MARKER_END = '[/MCP_TOOL_CHUNK]'

  constructor(
    private onChunk: (chunk: Chunk) => void,
    mcpTools: MCPTool[] = [],
    accumulate?: boolean,
    enableWebSearch?: boolean,
    onSessionUpdate?: (sessionId: string) => void,
    getSessionWasCleared?: () => boolean,
    private onImageAction?: (prompt: string) => Promise<GenerateImageResponse | null>,
    providerId?: string,
    idleTimeout?: IdleTimeoutHandle
  ) {
    this.toolCallHandler = new ToolCallChunkHandler(onChunk, mcpTools)
    this.accumulate = accumulate
    this.enableWebSearch = enableWebSearch || false
    this.onSessionUpdate = onSessionUpdate
    this.getSessionWasCleared = getSessionWasCleared
    this.providerId = providerId
    this.idleTimeout = idleTimeout
  }

  private markFirstTokenIfNeeded() {
    if (this.firstTokenTimestamp === null && this.responseStartTimestamp !== null) {
      this.firstTokenTimestamp = Date.now()
    }
  }

  private resetTimingState() {
    this.responseStartTimestamp = null
    this.firstTokenTimestamp = null
  }

  private emitTextStartIfNeeded() {
    if (!this.pendingTextStart) {
      return
    }
    this.pendingTextStart = false
    this.onChunk({
      type: ChunkType.TEXT_START
    })
  }

  private parseImageActionPayload(payloadText: string): { prompt: string } | null {
    const trimmed = payloadText.trim()
    if (!trimmed.startsWith('{')) {
      return null
    }

    let parsed: any
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return null
    }

    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const action = parsed.action || parsed.action_name || parsed.actionName
    if (action !== 'dalle.text2im') {
      return null
    }

    let actionInput = parsed.action_input ?? parsed.actionInput ?? parsed.input
    if (typeof actionInput === 'string') {
      try {
        actionInput = JSON.parse(actionInput)
      } catch {
        return null
      }
    }

    const prompt = actionInput?.prompt || parsed.prompt
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return null
    }

    return { prompt: prompt.trim() }
  }

  private async handleImageAction(buffer: string): Promise<boolean> {
    if (!this.onImageAction) {
      return false
    }

    const action = this.parseImageActionPayload(buffer)
    if (!action) {
      return false
    }

    logger.info('[ImageAction] Parsed dalle.text2im action', {
      promptLength: action.prompt.length,
      promptPreview: action.prompt.slice(0, 120),
      rawPayloadLength: buffer.length
    })
    this.onChunk({ type: ChunkType.IMAGE_CREATED })
    try {
      const imageResponse = await this.onImageAction(action.prompt)
      logger.info('[ImageAction] Image handler returned', {
        hasResponse: !!imageResponse,
        responseType: imageResponse?.type,
        imageCount: imageResponse?.images?.length || 0,
        sample: imageResponse?.images?.[0]?.slice(0, 80)
      })
      if (!imageResponse || !imageResponse.images?.length) {
        throw new Error('Image generation returned empty result.')
      }
      this.onChunk({
        type: ChunkType.IMAGE_COMPLETE,
        image: imageResponse
      })
    } catch (error) {
      logger.error('[ImageAction] Image generation failed', {
        errorMessage: formatErrorMessage(error),
        error
      })
      this.onChunk({
        type: ChunkType.ERROR,
        error: AISDKError.isInstance(error)
          ? error
          : new ProviderSpecificError({
              message: formatErrorMessage(error),
              provider: 'unknown',
              cause: error
            })
      })
    }
    return true
  }

  private stripResponseTags(text: string): string {
    const startTag = '<response>'
    const endTag = '</response>'
    let buffer = `${this.responseTagBuffer}${text}`
    this.responseTagBuffer = ''
    let output = ''

    while (buffer.length > 0) {
      const startIdx = buffer.indexOf(startTag)
      if (startIdx === -1) {
        output += buffer
        buffer = ''
        break
      }

      if (startIdx > 0) {
        output += buffer.slice(0, startIdx)
      }

      buffer = buffer.slice(startIdx + startTag.length)
      const endIdx = buffer.indexOf(endTag)
      if (endIdx === -1) {
        this.responseTagBuffer = `${startTag}${buffer}`
        buffer = ''
        break
      }

      output += buffer.slice(0, endIdx)
      buffer = buffer.slice(endIdx + endTag.length)
    }

    return output
  }

  private extractMcpToolChunks(text: string): { cleanText: string; toolChunks: Chunk[] } {
    const start = AiSdkToChunkAdapter.MCP_TOOL_MARKER_START
    const end = AiSdkToChunkAdapter.MCP_TOOL_MARKER_END
    let buffer = `${this.mcpToolMarkerBuffer}${text}`
    this.mcpToolMarkerBuffer = ''
    let cleanText = ''
    const toolChunks: Chunk[] = []

    while (buffer.length > 0) {
      const startIdx = buffer.indexOf(start)
      if (startIdx === -1) {
        cleanText += buffer
        buffer = ''
        break
      }

      if (startIdx > 0) {
        cleanText += buffer.slice(0, startIdx)
      }

      const endIdx = buffer.indexOf(end, startIdx + start.length)
      if (endIdx === -1) {
        this.mcpToolMarkerBuffer = buffer.slice(startIdx)
        buffer = ''
        break
      }

      const payload = buffer.slice(startIdx + start.length, endIdx)
      const toolChunk = this.parseMcpToolChunk(payload)
      if (toolChunk) {
        toolChunks.push(toolChunk)
      }
      buffer = buffer.slice(endIdx + end.length)
    }

    return { cleanText, toolChunks }
  }

  private parseMcpToolChunk(payload: string): Chunk | null {
    try {
      const parsed = JSON.parse(payload) as { type?: string; responses?: unknown }
      const normalizedType = typeof parsed.type === 'string' ? parsed.type.toLowerCase() : ''
      const allowedTypes = [
        ChunkType.MCP_TOOL_PENDING,
        ChunkType.MCP_TOOL_IN_PROGRESS,
        ChunkType.MCP_TOOL_COMPLETE,
        ChunkType.MCP_TOOL_STREAMING
      ]
      if (!allowedTypes.includes(normalizedType as ChunkType)) {
        return null
      }
      if (!Array.isArray(parsed.responses)) {
        return null
      }
      return {
        type: normalizedType as ChunkType,
        responses: parsed.responses
      } as Chunk
    } catch (error) {
      logger.warn('Failed to parse MCP tool chunk marker.', { error })
      return null
    }
  }

  /**
   * 处理 AI SDK 流结果
   * @param aiSdkResult AI SDK 的流结果对象
   * @returns 最终的文本内容
   */
  async processStream(aiSdkResult: any): Promise<string> {
    try {
      // 如果是流式且有 fullStream
      if (aiSdkResult.fullStream) {
        await this.readFullStream(aiSdkResult.fullStream)
      }

      // 使用 streamResult.text 获取最终结果
      return await aiSdkResult.text
    } catch (error: any) {
      // abort 时，AI SDK 通常会先通过流发送 'abort' chunk（在 readFullStream 中 convertAndEmitChunk
      // 转为 ERROR chunk 发出）。随后 aiSdkResult.text 会抛出 AbortError
      // 这里捕获它以避免 transformMessagesAndFetch 的 catch 再次发送重复的 ERROR chunk
      if (isAbortError(error)) {
        return ''
      }
      throw error
    }
  }

  /**
   * 读取 fullStream 并转换为 Cherry Studio chunks
   * @param fullStream AI SDK 的 fullStream (ReadableStream)
   */
  private async readFullStream(fullStream: ReadableStream<TextStreamPart<ToolSet>>) {
    const reader = fullStream.getReader()
    const final = {
      text: '',
      reasoningContent: '',
      webSearchResults: [],
      reasoningId: '',
      providerMetadata: undefined as ProviderMetadata | undefined
    }
    this.resetTimingState()
    this.responseStartTimestamp = Date.now()
    // Reset state at the start of stream
    this.isFirstChunk = true
    this.hasTextContent = false

    try {
      while (true) {
        const { done, value } = await reader.read()

        // Reset idle timeout on every chunk received from the stream
        this.idleTimeout?.reset()

        if (done) {
          // Flush any remaining content from link converter buffer if web search is enabled
          if (this.enableWebSearch) {
            const remainingText = flushLinkConverterBuffer()
            if (remainingText) {
              this.markFirstTokenIfNeeded()
              this.onChunk({
                type: ChunkType.TEXT_DELTA,
                text: remainingText
              })
            }
          }
          break
        }

        // 转换并发送 chunk
        await this.convertAndEmitChunk(value, final)
      }
    } finally {
      reader.releaseLock()
      this.resetTimingState()
      // Clean up the idle timeout timer when the stream ends
      this.idleTimeout?.cleanup()
    }
  }

  /**
   * 如果有累积的思考内容，发送 THINKING_COMPLETE chunk 并清空
   * @param final 包含 reasoningContent 的状态对象
   * @returns 是否发送了 THINKING_COMPLETE chunk
   */
  private emitThinkingCompleteIfNeeded(final: { reasoningContent: string; [key: string]: any }) {
    if (final.reasoningContent) {
      this.onChunk({
        type: ChunkType.THINKING_COMPLETE,
        text: final.reasoningContent
      })
      final.reasoningContent = ''
    }
  }

  /**
   * 转换 AI SDK chunk 为 Cherry Studio chunk 并调用回调
   * @param chunk AI SDK 的 chunk 数据
   */
  private async convertAndEmitChunk(
    chunk: TextStreamPart<any>,
    final: {
      text: string
      reasoningContent: string
      webSearchResults: AISDKWebSearchResult[]
      reasoningId: string
      providerMetadata: ProviderMetadata | undefined
    }
  ) {
    logger.silly(`AI SDK chunk type: ${chunk.type}`, chunk)
    switch (chunk.type) {
      case 'raw': {
        const agentRawMessage = chunk.rawValue as ClaudeCodeRawValue
        if (agentRawMessage.type === 'init' && agentRawMessage.session_id) {
          this.onSessionUpdate?.(agentRawMessage.session_id)
        } else if (agentRawMessage.type === 'compact' && agentRawMessage.session_id) {
          this.onSessionUpdate?.(agentRawMessage.session_id)
        }
        this.onChunk({
          type: ChunkType.RAW,
          content: agentRawMessage
        })
        break
      }
      // === 文本相关事件 ===
      case 'text-start':
        // 如果有未完成的思考内容，先生成 THINKING_COMPLETE
        // 这处理了某些提供商不发送 reasoning-end 事件的情况
        this.emitThinkingCompleteIfNeeded(final)
        this.pendingTextStart = true
        break
      case 'text-delta': {
        const rawText = chunk.text || ''
        const strippedText = this.stripResponseTags(rawText)
        if (this.actionBuffer !== null) {
          this.actionBuffer += strippedText
          break
        }
        if (this.pendingTextStart && strippedText.trimStart().startsWith('{')) {
          this.actionBuffer = strippedText
          break
        }
        const { cleanText, toolChunks } = this.extractMcpToolChunks(strippedText)
        if (cleanText || toolChunks.length > 0) {
          this.hasTextContent = true
        }
        toolChunks.forEach((toolChunk) => this.onChunk(toolChunk))
        const processedText = cleanText
        let finalText: string

        // Only apply link conversion if web search is enabled
        if (this.enableWebSearch) {
          const result = convertLinks(processedText, this.isFirstChunk)

          if (this.isFirstChunk) {
            this.isFirstChunk = false
          }

          // Handle buffered content
          if (result.hasBufferedContent) {
            finalText = result.text
          } else {
            finalText = result.text || processedText
          }
        } else {
          // Without web search, just use the original text
          finalText = processedText
        }

        if (this.accumulate) {
          final.text += finalText
        } else {
          final.text = finalText
        }

        // Extract thoughtSignature from providerMetadata.google and preserve it
        const newSignature = chunk.providerMetadata?.google?.thoughtSignature as string | undefined
        if (newSignature) {
          final.providerMetadata = {
            ...final.providerMetadata,
            google: {
              ...final.providerMetadata?.google,
              thoughtSignature: newSignature
            }
          }
        }

        // Only emit chunk if there's text to send
        if (finalText) {
          this.emitTextStartIfNeeded()
          this.markFirstTokenIfNeeded()
          this.onChunk({
            type: ChunkType.TEXT_DELTA,
            text: this.accumulate ? final.text : finalText,
            providerMetadata: final.providerMetadata
          })
        }
        break
      }
      case 'text-end': {
        if (this.actionBuffer !== null) {
          const bufferedText = this.actionBuffer
          this.actionBuffer = null
          const handled = await this.handleImageAction(bufferedText)
          if (handled) {
            this.pendingTextStart = false
            final.text = ''
            break
          }
          if (bufferedText) {
            this.emitTextStartIfNeeded()
            this.hasTextContent = true
            this.onChunk({
              type: ChunkType.TEXT_DELTA,
              text: bufferedText
            })
            this.onChunk({
              type: ChunkType.TEXT_COMPLETE,
              text: bufferedText
            })
            final.text = bufferedText
            break
          }
        }

        this.emitTextStartIfNeeded()
        this.onChunk({
          type: ChunkType.TEXT_COMPLETE,
          text: (chunk.providerMetadata?.text?.value as string) ?? final.text ?? '',
          providerMetadata: final.providerMetadata
        })
        final.text = ''
        // Clear providerMetadata for next text block
        final.providerMetadata = undefined
        break
      }
      case 'reasoning-start':
        // if (final.reasoningId !== chunk.id) {
        final.reasoningId = chunk.id
        this.onChunk({
          type: ChunkType.THINKING_START
        })
        // }
        break
      case 'reasoning-delta':
        final.reasoningContent += chunk.text || ''
        if (chunk.text) {
          this.markFirstTokenIfNeeded()
        }
        this.onChunk({
          type: ChunkType.THINKING_DELTA,
          text: final.reasoningContent || ''
        })
        break
      case 'reasoning-end':
        this.emitThinkingCompleteIfNeeded(final)
        break

      // === 工具调用相关事件（原始 AI SDK 事件，如果没有被中间件处理） ===

      case 'tool-input-start':
        this.toolCallHandler.handleToolInputStart(chunk)
        break
      case 'tool-input-delta':
        this.toolCallHandler.handleToolInputDelta(chunk)
        break
      case 'tool-input-end':
        this.toolCallHandler.handleToolInputEnd(chunk)
        break

      case 'tool-call':
        this.toolCallHandler.handleToolCall(chunk)
        break

      case 'tool-error':
        this.toolCallHandler.handleToolError(chunk)
        break

      case 'tool-result':
        this.toolCallHandler.handleToolResult(chunk)
        break

      // === 步骤相关事件 ===
      // case 'start':
      //   this.onChunk({
      //     type: ChunkType.LLM_RESPONSE_CREATED
      //   })
      //   break
      // case 'start-step':
      //   this.onChunk({
      //     type: ChunkType.BLOCK_CREATED
      //   })
      //   break
      // case 'step-finish':
      //   this.onChunk({
      //     type: ChunkType.TEXT_COMPLETE,
      //     text: final.text || '' // TEXT_COMPLETE 需要 text 字段
      //   })
      //   final.text = ''
      //   break

      case 'finish-step': {
        const { providerMetadata, finishReason } = chunk
        // googel web search
        if (providerMetadata?.google?.groundingMetadata) {
          this.onChunk({
            type: ChunkType.LLM_WEB_SEARCH_COMPLETE,
            llm_web_search: {
              results: providerMetadata.google?.groundingMetadata as WebSearchResults,
              source: WEB_SEARCH_SOURCE.GEMINI
            }
          })
        } else if (final.webSearchResults.length) {
          const providerName: string | undefined = Object.keys(providerMetadata || {})[0] || this.providerId
          const sourceMap: Record<string, WebSearchSource> = {
            [WEB_SEARCH_SOURCE.OPENAI]: WEB_SEARCH_SOURCE.OPENAI_RESPONSE,
            [WEB_SEARCH_SOURCE.ANTHROPIC]: WEB_SEARCH_SOURCE.ANTHROPIC,
            [WEB_SEARCH_SOURCE.OPENROUTER]: WEB_SEARCH_SOURCE.OPENROUTER,
            [WEB_SEARCH_SOURCE.GEMINI]: WEB_SEARCH_SOURCE.GEMINI,
            // [WebSearchSource.PERPLEXITY]: WebSearchSource.PERPLEXITY,
            [WEB_SEARCH_SOURCE.QWEN]: WEB_SEARCH_SOURCE.QWEN,
            [WEB_SEARCH_SOURCE.HUNYUAN]: WEB_SEARCH_SOURCE.HUNYUAN,
            [WEB_SEARCH_SOURCE.ZHIPU]: WEB_SEARCH_SOURCE.ZHIPU,
            [WEB_SEARCH_SOURCE.GROK]: WEB_SEARCH_SOURCE.GROK,
            xai: WEB_SEARCH_SOURCE.GROK,
            [WEB_SEARCH_SOURCE.WEBSEARCH]: WEB_SEARCH_SOURCE.WEBSEARCH
          }
          const source = (providerName && sourceMap[providerName]) || WEB_SEARCH_SOURCE.AISDK

          this.onChunk({
            type: ChunkType.LLM_WEB_SEARCH_COMPLETE,
            llm_web_search: {
              results: final.webSearchResults,
              source
            }
          })
        }
        if (finishReason === 'tool-calls') {
          this.onChunk({ type: ChunkType.LLM_RESPONSE_CREATED })
        }

        // Surface truncation for diagnosis: when a step ends due to the output
        // token cap (e.g. Gemini thinking budget consuming the answer), the user
        // sees a search/tool step but little or no final text.
        if (finishReason === 'length') {
          logger.warn('Step finished with finishReason "length" (output truncated by max tokens).', {
            providerId: this.providerId
          })
        }

        final.webSearchResults = []
        // final.reasoningId = ''
        break
      }

      case 'finish': {
        // Check if session was cleared (e.g., /clear command) and no text was output
        const sessionCleared = this.getSessionWasCleared?.() ?? false
        if (sessionCleared && !this.hasTextContent) {
          // Inject a "context cleared" message for the user
          const clearMessage = '✨ Context cleared. Starting fresh conversation.'
          this.onChunk({
            type: ChunkType.TEXT_START
          })
          this.onChunk({
            type: ChunkType.TEXT_DELTA,
            text: clearMessage
          })
          this.onChunk({
            type: ChunkType.TEXT_COMPLETE,
            text: clearMessage
          })
          final.text = clearMessage
        }

        const usage = {
          completion_tokens: chunk.totalUsage?.outputTokens || 0,
          prompt_tokens: chunk.totalUsage?.inputTokens || 0,
          total_tokens: chunk.totalUsage?.totalTokens || 0
        }
        const metrics = this.buildMetrics(chunk.totalUsage)
        const baseResponse = {
          text: final.text || '',
          reasoning_content: final.reasoningContent || ''
        }

        this.onChunk({
          type: ChunkType.BLOCK_COMPLETE,
          response: {
            ...baseResponse,
            usage: { ...usage },
            metrics: metrics ? { ...metrics } : undefined
          }
        })
        this.onChunk({
          type: ChunkType.LLM_RESPONSE_COMPLETE,
          response: {
            ...baseResponse,
            usage: { ...usage },
            metrics: metrics ? { ...metrics } : undefined
          }
        })
        this.resetTimingState()
        break
      }

      // === 源和文件相关事件 ===
      case 'source':
        if (chunk.sourceType === 'url') {
          // oxlint-disable-next-line @typescript-eslint/no-unused-vars
          const { sourceType: _, ...rest } = chunk
          final.webSearchResults.push(rest)
        }
        break
      case 'file':
        // 文件相关事件，可能是图片生成
        this.onChunk({
          type: ChunkType.IMAGE_COMPLETE,
          image: {
            type: 'base64',
            images: [`data:${chunk.file.mediaType};base64,${chunk.file.base64}`]
          }
        })
        break
      case 'abort':
        this.onChunk({
          type: ChunkType.ERROR,
          error: new DOMException('Request was aborted', 'AbortError')
        })
        break
      case 'error':
        this.onChunk({
          type: ChunkType.ERROR,
          error: AISDKError.isInstance(chunk.error)
            ? chunk.error
            : new ProviderSpecificError({
                message: formatErrorMessage(chunk.error),
                provider: 'unknown',
                cause: chunk.error
              })
        })
        break

      default:
    }
  }

  private buildMetrics(totalUsage?: {
    inputTokens?: number | null
    outputTokens?: number | null
    totalTokens?: number | null
  }) {
    if (!totalUsage) {
      return undefined
    }

    const completionTokens = totalUsage.outputTokens ?? 0
    const now = Date.now()
    const start = this.responseStartTimestamp ?? now
    const firstToken = this.firstTokenTimestamp
    const timeFirstToken = Math.max(firstToken != null ? firstToken - start : 0, 0)
    const baseForCompletion = firstToken ?? start
    let timeCompletion = Math.max(now - baseForCompletion, 0)

    if (timeCompletion === 0 && completionTokens > 0) {
      timeCompletion = 1
    }

    return {
      completion_tokens: completionTokens,
      time_first_token_millsec: timeFirstToken,
      time_completion_millsec: timeCompletion
    }
  }
}

export default AiSdkToChunkAdapter
