import { loggerService } from '@logger'
import type {
  ExternalToolResult,
  GenerateImageResponse,
  MCPToolResponse,
  NormalToolResponse,
  WebSearchResponse
} from '@renderer/types'
import type { Chunk, ProviderMetadata } from '@renderer/types/chunk'
import { ChunkType } from '@renderer/types/chunk'
import type { Response } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'

const logger = loggerService.withContext('StreamProcessingService')

// Define the structure for the callbacks that the StreamProcessor will invoke
export interface StreamProcessorCallbacks {
  // LLM response created
  onLLMResponseCreated?: () => void
  // Text content start
  onTextStart?: () => void
  // Text content chunk received
  onTextChunk?: (text: string, providerMetadata?: ProviderMetadata) => void
  // Full text content received
  onTextComplete?: (text: string, providerMetadata?: ProviderMetadata) => void
  // thinking content start
  onThinkingStart?: () => void
  // Thinking/reasoning content chunk received (e.g., from Claude)
  onThinkingChunk?: (text: string, thinking_millsec?: number) => void
  onThinkingComplete?: (text: string, thinking_millsec?: number) => void
  // A tool call response chunk (from MCP)
  onToolCallPending?: (toolResponse: MCPToolResponse | NormalToolResponse) => void
  onToolCallInProgress?: (toolResponse: MCPToolResponse | NormalToolResponse) => void
  onToolCallComplete?: (toolResponse: MCPToolResponse | NormalToolResponse) => void
  // Tool argument streaming (partial arguments during streaming)
  onToolArgumentStreaming?: (toolResponse: MCPToolResponse | NormalToolResponse) => void
  // External tool call in progress
  onExternalToolInProgress?: () => void
  // Citation data received (e.g., from Internet and  Knowledge Base)
  onExternalToolComplete?: (externalToolResult: ExternalToolResult) => void | Promise<void>
  // LLM Web search in progress
  onLLMWebSearchInProgress?: () => void
  // LLM Web search complete
  onLLMWebSearchComplete?: (llmWebSearchResult: WebSearchResponse) => void
  // Get citation block ID
  getCitationBlockId?: () => string | null
  // Set citation block ID
  setCitationBlockId?: (blockId: string) => void
  // Image generation chunk received
  onImageCreated?: () => void
  onImageDelta?: (imageData: GenerateImageResponse) => void
  onImageGenerated?: (imageData?: GenerateImageResponse) => void
  onLLMResponseComplete?: (response?: Response) => void
  // Called when an error occurs during chunk processing
  onError?: (error: any) => void
  // Called when the entire stream processing is signaled as complete (success or failure)
  onComplete?: (status: AssistantMessageStatus, response?: Response) => void
  onVideoSearched?: (video?: { type: 'url' | 'path'; content: string }, metadata?: Record<string, any>) => void
  // Called when a block is created
  onBlockCreated?: () => void
  // Called when raw data is received (e.g., session_id updates from Agent SDK)
  onRawData?: (content: unknown, metadata?: Record<string, any>) => void
}

// Function to create a stream processor instance
export function createStreamProcessor(callbacks: StreamProcessorCallbacks = {}) {
  const markerStart = '[MCP_TOOL_CHUNK]'
  const markerEnd = '[/MCP_TOOL_CHUNK]'
  let mcpToolMarkerBuffer = ''

  const parseMcpToolChunk = (payload: string): Chunk | null => {
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

  const extractMcpToolChunks = (text: string): { cleanText: string; toolChunks: Chunk[] } => {
    let buffer = `${mcpToolMarkerBuffer}${text}`
    mcpToolMarkerBuffer = ''
    let cleanText = ''
    const toolChunks: Chunk[] = []

    while (buffer.length > 0) {
      const startIdx = buffer.indexOf(markerStart)
      if (startIdx === -1) {
        cleanText += buffer
        buffer = ''
        break
      }
      if (startIdx > 0) {
        cleanText += buffer.slice(0, startIdx)
      }
      const endIdx = buffer.indexOf(markerEnd, startIdx + markerStart.length)
      if (endIdx === -1) {
        mcpToolMarkerBuffer = buffer.slice(startIdx)
        buffer = ''
        break
      }
      const payload = buffer.slice(startIdx + markerStart.length, endIdx)
      const toolChunk = parseMcpToolChunk(payload)
      if (toolChunk) {
        toolChunks.push(toolChunk)
      }
      buffer = buffer.slice(endIdx + markerEnd.length)
    }

    return { cleanText, toolChunks }
  }

  // The returned function processes a single chunk or a final signal
  return (chunk: Chunk) => {
    try {
      const data = chunk
      // logger.debug('data: ', data)
      switch (data.type) {
        case ChunkType.BLOCK_COMPLETE: {
          if (callbacks.onComplete) callbacks.onComplete(AssistantMessageStatus.SUCCESS, data?.response)
          break
        }
        case ChunkType.LLM_RESPONSE_CREATED: {
          if (callbacks.onLLMResponseCreated) callbacks.onLLMResponseCreated()
          break
        }
        case ChunkType.TEXT_START: {
          if (callbacks.onTextStart) callbacks.onTextStart()
          break
        }
        case ChunkType.TEXT_DELTA: {
          const { cleanText, toolChunks } = extractMcpToolChunks(data.text || '')
          for (const toolChunk of toolChunks) {
            if (toolChunk.type === ChunkType.MCP_TOOL_PENDING) {
              toolChunk.responses.forEach((toolResp: any) => callbacks.onToolCallPending?.(toolResp))
            } else if (toolChunk.type === ChunkType.MCP_TOOL_IN_PROGRESS) {
              toolChunk.responses.forEach((toolResp: any) => callbacks.onToolCallInProgress?.(toolResp))
            } else if (toolChunk.type === ChunkType.MCP_TOOL_COMPLETE) {
              toolChunk.responses.forEach((toolResp: any) => callbacks.onToolCallComplete?.(toolResp))
            } else if (toolChunk.type === ChunkType.MCP_TOOL_STREAMING) {
              toolChunk.responses.forEach((toolResp: any) => callbacks.onToolArgumentStreaming?.(toolResp))
            }
          }
          if (callbacks.onTextChunk && cleanText) callbacks.onTextChunk(cleanText, data.providerMetadata)
          break
        }
        case ChunkType.TEXT_COMPLETE: {
          if (callbacks.onTextComplete) callbacks.onTextComplete(data.text, data.providerMetadata)
          break
        }
        case ChunkType.THINKING_START: {
          if (callbacks.onThinkingStart) callbacks.onThinkingStart()
          break
        }
        case ChunkType.THINKING_DELTA: {
          if (callbacks.onThinkingChunk) callbacks.onThinkingChunk(data.text, data.thinking_millsec)
          break
        }
        case ChunkType.THINKING_COMPLETE: {
          if (callbacks.onThinkingComplete) callbacks.onThinkingComplete(data.text, data.thinking_millsec)
          break
        }
        case ChunkType.MCP_TOOL_PENDING: {
          if (callbacks.onToolCallPending) data.responses.forEach((toolResp) => callbacks.onToolCallPending!(toolResp))
          break
        }
        case ChunkType.MCP_TOOL_IN_PROGRESS: {
          if (callbacks.onToolCallInProgress)
            data.responses.forEach((toolResp) => callbacks.onToolCallInProgress!(toolResp))
          break
        }
        case ChunkType.MCP_TOOL_COMPLETE: {
          if (callbacks.onToolCallComplete && data.responses.length > 0) {
            data.responses.forEach((toolResp) => callbacks.onToolCallComplete!(toolResp))
          }
          break
        }
        case ChunkType.MCP_TOOL_STREAMING: {
          if (callbacks.onToolArgumentStreaming) {
            data.responses.forEach((toolResp) => callbacks.onToolArgumentStreaming!(toolResp))
          }
          break
        }
        case ChunkType.EXTERNEL_TOOL_IN_PROGRESS: {
          if (callbacks.onExternalToolInProgress) callbacks.onExternalToolInProgress()
          break
        }
        case ChunkType.EXTERNEL_TOOL_COMPLETE: {
          if (callbacks.onExternalToolComplete) callbacks.onExternalToolComplete(data.external_tool)
          break
        }
        case ChunkType.LLM_WEB_SEARCH_IN_PROGRESS: {
          if (callbacks.onLLMWebSearchInProgress) callbacks.onLLMWebSearchInProgress()
          break
        }
        case ChunkType.LLM_WEB_SEARCH_COMPLETE: {
          if (callbacks.onLLMWebSearchComplete) callbacks.onLLMWebSearchComplete(data.llm_web_search)
          break
        }
        case ChunkType.IMAGE_CREATED: {
          if (callbacks.onImageCreated) callbacks.onImageCreated()
          break
        }
        case ChunkType.IMAGE_DELTA: {
          if (callbacks.onImageDelta) callbacks.onImageDelta(data.image)
          break
        }
        case ChunkType.IMAGE_COMPLETE: {
          if (callbacks.onImageGenerated) callbacks.onImageGenerated(data.image)
          break
        }
        case ChunkType.LLM_RESPONSE_COMPLETE: {
          if (callbacks.onLLMResponseComplete) callbacks.onLLMResponseComplete(data.response)
          break
        }
        case ChunkType.ERROR: {
          if (callbacks.onError) callbacks.onError(data.error)
          break
        }
        case ChunkType.VIDEO_SEARCHED: {
          if (callbacks.onVideoSearched) callbacks.onVideoSearched(data.video, data.metadata)
          break
        }
        case ChunkType.BLOCK_CREATED: {
          if (callbacks.onBlockCreated) callbacks.onBlockCreated()
          break
        }
        case ChunkType.RAW: {
          if (callbacks.onRawData) callbacks.onRawData(data.content, data.metadata)
          break
        }
        default: {
          // Handle unknown chunk types or log an error
          logger.warn(`Unknown chunk type: ${data.type}`)
        }
      }
    } catch (error) {
      logger.error('Error processing stream chunk:', error as Error)
      callbacks.onError?.(error)
    }
  }
}
