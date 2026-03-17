import { loggerService } from '@logger'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { CopyIcon } from '@renderer/components/Icons'
import { useCodeStyle } from '@renderer/context/CodeStyleProvider'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTimer } from '@renderer/hooks/useTimer'
import type { MCPToolResponse } from '@renderer/types'
import type { ToolMessageBlock } from '@renderer/types/newMessage'
import { isToolAutoApproved } from '@renderer/utils/mcp-tools'
import type { MCPProgressEvent } from '@shared/config/types'
import { IpcChannel } from '@shared/IpcChannel'
import { Collapse, type CollapseProps, ConfigProvider, Flex, Progress, Tooltip } from 'antd'
import { message } from 'antd'
import { Check, ChevronRight, ShieldCheck } from 'lucide-react'
// import { parse as parsePartialJson } from 'partial-json'
import type { FC } from 'react'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { useToolApproval } from './hooks/useToolApproval'
import {
  getEffectiveStatus,
  SkeletonSpan,
  ToolStatusIndicator,
  TruncatedIndicator
} from './MessageAgentTools/GenericTools'
import {
  ArgKey,
  ArgsSection,
  ArgsSectionTitle,
  ArgsTable,
  ArgValue,
  formatArgValue,
  ResponseSection
} from './shared/ArgsTable'
import { truncateOutput } from './shared/truncateOutput'
import ToolApprovalActionsComponent from './ToolApprovalActions'

interface Props {
  block: ToolMessageBlock
}

const logger = loggerService.withContext('MessageTools')

const MessageMcpTool: FC<Props> = ({ block }) => {
  const [activeKeys, setActiveKeys] = useState<string[]>([])
  const [copiedMap, setCopiedMap] = useState<Record<string, boolean>>({})
  const { t } = useTranslation()
  const { messageFont, fontSize } = useSettings()
  const [progress, setProgress] = useState<number>(0)
  const { setTimeoutTimer } = useTimer()

  // Use the unified approval hook
  const approval = useToolApproval(block)

  const toolResponse = block.metadata?.rawMcpToolResponse as MCPToolResponse

  const { id, tool, status, response, partialArguments } = toolResponse as MCPToolResponse
  const isPending = status === 'pending'
  const isDone = status === 'done'
  const isError = status === 'error'
  const isStreaming = status === 'streaming'

  useEffect(() => {
    const removeListener = window.electron.ipcRenderer.on(
      IpcChannel.Mcp_Progress,
      (_event: Electron.IpcRendererEvent, data: MCPProgressEvent) => {
        // Only update progress if this event is for our specific tool call
        if (data.callId === id) {
          setProgress(data.progress)
        }
      }
    )
    return () => {
      setProgress(0)
      removeListener()
    }
  }, [id])

  // Auto-expand when streaming, auto-collapse when done
  useEffect(() => {
    if (isStreaming) {
      // Expand when streaming starts
      setActiveKeys((prev) => (prev.includes(id) ? prev : [...prev, id]))
    } else if (isDone || isError) {
      // Collapse when streaming ends
      setActiveKeys((prev) => prev.filter((key) => key !== id))
    }
  }, [isStreaming, isDone, isError, id])

  if (!toolResponse) {
    return null
  }

  const copyContent = (content: string, toolId: string) => {
    navigator.clipboard.writeText(content)
    window.toast.success({ title: t('message.copied'), key: 'copy-message' })
    setCopiedMap((prev) => ({ ...prev, [toolId]: true }))
    setTimeoutTimer('copyContent', () => setCopiedMap((prev) => ({ ...prev, [toolId]: false })), 2000)
  }

  const handleCollapseChange = (keys: string | string[]) => {
    setActiveKeys(Array.isArray(keys) ? keys : [keys])
  }

  const handleAbortTool = async () => {
    if (toolResponse?.id) {
      try {
        const success = await window.api.mcp.abortTool(toolResponse.id)
        if (success) {
          window.toast.success(t('message.tools.aborted'))
        } else {
          message.error({ content: t('message.tools.abort_failed'), key: 'abort-tool' })
        }
      } catch (error) {
        logger.error('Failed to abort tool:', error as Error)
        message.error({ content: t('message.tools.abort_failed'), key: 'abort-tool' })
      }
    }
  }

  // Format tool responses for collapse items
  const getCollapseItems = (): { key: string; label: React.ReactNode; children: React.ReactNode }[] => {
    const items: { key: string; label: React.ReactNode; children: React.ReactNode }[] = []
    const hasError = response?.isError === true
    const result = {
      params: toolResponse.arguments,
      response: toolResponse.response
    }
    items.push({
      key: id,
      label: (
        <MessageTitleLabel>
          <TitleContent>
            <ToolName align="center" gap={4}>
              {tool.serverName} : {tool.name}
              {isToolAutoApproved(tool) && (
                <Tooltip title={t('message.tools.autoApproveEnabled')} mouseLeaveDelay={0}>
                  <ShieldCheck size={14} color="var(--status-color-success)" />
                </Tooltip>
              )}
            </ToolName>
          </TitleContent>
          <ActionButtonsContainer>
            {progress > 0 ? (
              <Progress type="circle" size={14} percent={Number((progress * 100)?.toFixed(0))} />
            ) : (
              <ToolStatusIndicator status={getEffectiveStatus(status, approval.isWaiting)} hasError={hasError} />
            )}
            {!isPending && (
              <Tooltip title={t('common.copy')} mouseEnterDelay={0.5}>
                <ActionButton
                  className="message-action-button"
                  onClick={(e) => {
                    e.stopPropagation()
                    copyContent(JSON.stringify(result, null, 2), id)
                  }}
                  aria-label={t('common.copy')}>
                  {!copiedMap[id] && <CopyIcon size={14} />}
                  {copiedMap[id] && <Check size={14} color="var(--status-color-success)" />}
                </ActionButton>
              </Tooltip>
            )}
          </ActionButtonsContainer>
        </MessageTitleLabel>
      ),
      children: (
        <ToolResponseContainer
          style={{
            fontFamily: messageFont === 'serif' ? 'var(--font-family-serif)' : 'var(--font-family)',
            fontSize
          }}>
          <ToolResponseContent
            isExpanded={activeKeys.includes(id)}
            args={isStreaming ? partialArguments : toolResponse.arguments}
            isStreaming={!!isStreaming}
            response={isDone || isError ? toolResponse.response : undefined}
          />
        </ToolResponseContainer>
      )
    })

    return items
  }

  return (
    <>
      <ConfigProvider
        theme={{
          components: {
            Button: {
              borderRadiusSM: 6
            }
          }
        }}>
        <ToolContainer>
          <ToolContentWrapper className={isPending ? 'pending' : status}>
            <CollapseContainer
              ghost
              activeKey={activeKeys}
              size="small"
              onChange={handleCollapseChange}
              className="message-tools-container"
              items={getCollapseItems()}
              expandIconPosition="end"
              expandIcon={({ isActive }) => (
                <ExpandIcon $isActive={isActive} size={18} color="var(--color-text-3)" strokeWidth={1.5} />
              )}
            />
            {isPending && (
              <ActionsBar>
                <ActionLabel>
                  {approval.isWaiting
                    ? t('settings.mcp.tools.autoApprove.tooltip.confirm')
                    : t('message.tools.invoking')}
                </ActionLabel>

                <ToolApprovalActionsComponent
                  {...approval}
                  showAbort={approval.isExecuting && !!toolResponse?.id}
                  onAbort={handleAbortTool}
                />
              </ActionsBar>
            )}
          </ToolContentWrapper>
        </ToolContainer>
      </ConfigProvider>
    </>
  )
}

/**
 * Extract preview content from MCP tool response using SDK schema
 */
interface ExtractedContent {
  text: string
  images: Array<{ data: string; mimeType: string }>
}

const extractPreviewContent = (response: unknown): ExtractedContent => {
  const result_empty: ExtractedContent = { text: '', images: [] }
  if (!response) return result_empty

  const parsed = CallToolResultSchema.safeParse(response)
  if (parsed.success) {
    const contents = parsed.data.content
    if (contents.length === 0) return result_empty

    const textParts: string[] = []
    const images: Array<{ data: string; mimeType: string }> = []
    for (const content of contents) {
      switch (content.type) {
        case 'text':
          if (content.text) {
            try {
              const p = JSON.parse(content.text)
              textParts.push(JSON.stringify(p, null, 2))
            } catch {
              textParts.push(content.text)
            }
          }
          break
        case 'image':
          if (content.data) {
            images.push({ data: content.data, mimeType: content.mimeType ?? 'image/png' })
          }
          break
        case 'resource':
          textParts.push(`[Resource: ${content.resource?.uri ?? 'unknown'}]`)
          break
      }
    }
    return { text: textParts.join('\n\n'), images }
  }

  return { text: JSON.stringify(response, null, 2), images: [] }
}

const escapeHtml = (value: string): string => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Unified tool response content component
const ToolResponseContent: FC<{
  isExpanded: boolean
  args: string | Record<string, unknown> | Record<string, unknown>[] | undefined
  isStreaming: boolean
  response?: unknown
}> = ({ isExpanded, args, isStreaming, response }) => {
  const { highlightCode } = useCodeStyle()
  const [highlightedResponse, setHighlightedResponse] = useState<string>('')
  const [isLinkified, setIsLinkified] = useState(false)
  const [isTruncated, setIsTruncated] = useState(false)
  const [originalLength, setOriginalLength] = useState(0)

  // Parse args if it's a string (streaming partial JSON)
  const parsedArgs = useMemo(() => {
    if (!args) return null
    if (typeof args === 'string') {
      try {
        // return parsePartialJson(args)
        return JSON.parse(args)
      } catch {
        return null
      }
    }
    return args
  }, [args])

  const [responseImages, setResponseImages] = useState<Array<{ data: string; mimeType: string }>>([])

  // Extract and highlight response when available
  useEffect(() => {
    if (!isExpanded || !response) return

    const highlight = async () => {
      const { text: previewContent, images } = extractPreviewContent(response)
      setResponseImages(images)
      const {
        data: truncatedContent,
        isTruncated: wasTruncated,
        originalLength: origLen
      } = truncateOutput(previewContent)
      setIsTruncated(wasTruncated)
      setOriginalLength(origLen)
      const urlRegex = /(https?:\/\/[^\s)'"<>]+)/g
      if (urlRegex.test(truncatedContent)) {
        const escaped = escapeHtml(truncatedContent)
        const linkified = escaped.replace(urlRegex, (url) => `<a href="${url}">${url}</a>`)
        setIsLinkified(true)
        setHighlightedResponse(`<pre>${linkified}</pre>`)
      } else {
        const result = await highlightCode(truncatedContent, 'json')
        setIsLinkified(false)
        setHighlightedResponse(result)
      }
    }

    const timer = setTimeout(highlight, 0)
    return () => clearTimeout(timer)
  }, [isExpanded, response, highlightCode])

  const handleLinkClick = useCallback((event: React.MouseEvent) => {
    const target = event.target as HTMLElement | null
    const anchor = target?.closest?.('a') as HTMLAnchorElement | null
    if (anchor?.href) {
      event.preventDefault()
      window.api.openWebsite(anchor.href)
    }
  }, [])

  if (!isExpanded) return null

  // Handle both object and array args - for arrays, show as single entry
  const getEntries = (): Array<[string, unknown]> => {
    if (!parsedArgs || typeof parsedArgs !== 'object') return []
    if (Array.isArray(parsedArgs)) {
      return [['arguments', parsedArgs]]
    }
    return Object.entries(parsedArgs)
  }
  const entries = getEntries()

  const renderArgsTable = (): React.ReactNode => {
    if (entries.length === 0) return null
    return (
      <ArgsSection>
        <ArgsTable>
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key}>
                <ArgKey>{key}</ArgKey>
                <ArgValue>{formatArgValue(value)}</ArgValue>
              </tr>
            ))}
            {isStreaming && (
              <tr>
                <ArgKey>
                  <SkeletonSpan width="60px" />
                </ArgKey>
                <ArgValue>
                  <SkeletonSpan width="120px" />
                </ArgValue>
              </tr>
            )}
          </tbody>
        </ArgsTable>
      </ArgsSection>
    )
  }

  const collapseItems: CollapseProps['items'] = []

  if (entries.length > 0) {
    collapseItems.push({
      key: 'args',
      label: <ArgsSectionTitle style={{ marginBottom: 0 }}>Arguments</ArgsSectionTitle>,
      children: renderArgsTable()
    })
  }

  const hasResponseContent = (response !== undefined && response !== null) && (highlightedResponse || responseImages.length > 0)
  if (hasResponseContent) {
    collapseItems.push({
      key: 'response',
      label: <ArgsSectionTitle style={{ marginBottom: 0 }}>Response</ArgsSectionTitle>,
      children: (
        <ResponseSection style={{ borderTop: 'none' }}>
          {responseImages.length > 0 && (
            <ImageGallery>
              {responseImages.map((img, i) => (
                <ImageWrapper key={i}>
                  <img src={`data:${img.mimeType};base64,${img.data}`} alt={`Generated image ${i + 1}`} />
                </ImageWrapper>
              ))}
            </ImageGallery>
          )}
          {highlightedResponse && (
            <MarkdownContainer
              className={`markdown ${isLinkified ? 'linkified' : ''}`}
              onClick={handleLinkClick}
              dangerouslySetInnerHTML={{ __html: highlightedResponse }}
            />
          )}
          {isTruncated && <TruncatedIndicator originalLength={originalLength} />}
        </ResponseSection>
      )
    })
  }

  return (
    <InnerCollapse
      ghost
      size="small"
      defaultActiveKey={['args', 'response']}
      items={collapseItems}
      expandIconPosition="end"
      expandIcon={({ isActive }) => (
        <ExpandIcon $isActive={isActive} size={16} color="var(--color-text-3)" strokeWidth={1.5} />
      )}
    />
  )
}

const ToolContentWrapper = styled.div`
  padding: 1px;
  border-radius: 8px;
  overflow: hidden;

  .ant-collapse {
    border: 1px solid var(--color-border);
  }

  &.pending {
    background-color: var(--color-background-soft);
    .ant-collapse {
      border: none;
    }
  }
`

const ActionsBar = styled.div`
  padding: 8px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
`

const ActionLabel = styled.div`
  flex: 1;
  font-size: 14px;
  color: var(--color-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const ExpandIcon = styled(ChevronRight)<{ $isActive?: boolean }>`
  transition: transform 0.2s;
  transform: ${({ $isActive }) => ($isActive ? 'rotate(90deg)' : 'rotate(0deg)')};
`

const CollapseContainer = styled(Collapse)`
  --status-color-warning: var(--color-status-warning, #faad14);
  --status-color-invoking: var(--color-primary);
  --status-color-error: var(--color-status-error, #ff4d4f);
  --status-color-success: var(--color-primary, green);
  border-radius: 7px;
  border: none;
  background-color: var(--color-background);
  overflow: hidden;

  .ant-collapse-header {
    padding: 8px 10px !important;
    align-items: center !important;
  }

  .ant-collapse-content-box {
    padding: 0 !important;
  }
`

const ToolContainer = styled.div`
  margin-top: 10px;
  margin-bottom: 10px;

  &:first-child {
    margin-top: 0;
    padding-top: 0;
  }
`

const MarkdownContainer = styled.div`
  & pre {
    background: transparent !important;
    span {
      white-space: pre-wrap;
    }
  }

  &.linkified a {
    color: var(--color-link);
    text-decoration: underline;
    cursor: pointer;
  }
`

const MessageTitleLabel = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 10px;
  padding: 0;
  margin-left: 4px;
`

const TitleContent = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
`

const ToolName = styled(Flex)`
  color: var(--color-text);
  font-weight: 500;
  font-size: 13px;
`

const ActionButtonsContainer = styled.div`
  display: flex;
  gap: 6px;
  margin-left: auto;
  align-items: center;
`

const ActionButton = styled.button`
  background: none;
  border: none;
  color: var(--color-text-2);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
  transition: all 0.2s;
  border-radius: 4px;
  gap: 4px;
  min-width: 28px;
  height: 28px;

  &:hover {
    opacity: 1;
    color: var(--color-text);
    background-color: var(--color-bg-3);
  }

  &.confirm-button {
    color: var(--color-primary);

    &:hover {
      background-color: var(--color-primary-bg);
      color: var(--color-primary);
    }
  }

  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    opacity: 1;
  }

  .iconfont {
    font-size: 14px;
  }
`

const ToolResponseContainer = styled.div`
  border-radius: 0 0 4px 4px;
  overflow: auto;
  max-height: 300px;
  border-top: none;
  position: relative;
`

const ImageGallery = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
`

const ImageWrapper = styled.div`
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  background: var(--color-background-soft);

  img {
    display: block;
    max-width: 100%;
    max-height: 400px;
    object-fit: contain;
    cursor: pointer;
  }
`

const InnerCollapse = styled(Collapse)`
  background: transparent;
  .ant-collapse-item {
    border-bottom: 1px solid var(--color-border);
    &:last-child {
      border-bottom: none;
    }
  }
  .ant-collapse-header {
    padding: 6px 12px !important;
    min-height: 32px;
    align-items: center !important;
    background: var(--color-background-soft) !important;
  }
  .ant-collapse-content-box {
    padding: 0 !important;
  }
`

export default memo(MessageMcpTool)
