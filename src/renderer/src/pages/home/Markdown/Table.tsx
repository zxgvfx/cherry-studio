import { loggerService } from '@logger'
import { CopyIcon } from '@renderer/components/Icons'
import { useTemporaryValue } from '@renderer/hooks/useTemporaryValue'
import store from '@renderer/store'
import { messageBlocksSelectors } from '@renderer/store/messageBlock'
import { exportTableToExcel } from '@renderer/utils/exportExcel'
import { Tooltip } from 'antd'
import { Check, Download, FileSpreadsheet } from 'lucide-react'
import MarkdownIt from 'markdown-it'
import React, { memo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import type { Node } from 'unist'

const logger = loggerService.withContext('Table')

interface Props {
  children: React.ReactNode
  node?: Omit<Node, 'type'>
  blockId?: string
}

/**
 * 自定义 Markdown 表格组件，提供 copy / download 功能。
 */
const Table: React.FC<Props> = ({ children, node, blockId }) => {
  const { t } = useTranslation()
  const [copied, setCopied] = useTemporaryValue(false, 2000)
  const [downloaded, setDownloaded] = useTemporaryValue(false, 2000)

  const handleCopyTable = useCallback(async () => {
    const tableMarkdown = extractTableMarkdown(blockId ?? '', node?.position)
    if (!tableMarkdown) {
      window.toast?.error(t('message.error.table.invalid'))
      return
    }

    try {
      const tableHtml = convertMarkdownTableToHtml(tableMarkdown)

      if (navigator.clipboard && window.ClipboardItem) {
        const clipboardItem = new ClipboardItem({
          'text/plain': new Blob([tableMarkdown], { type: 'text/plain' }),
          'text/html': new Blob([tableHtml], { type: 'text/html' })
        })
        await navigator.clipboard.write([clipboardItem])
      } else {
        await navigator.clipboard.writeText(tableMarkdown)
      }
      setCopied(true)
    } catch (error) {
      logger.error('Failed to copy table to clipboard', { error })
      window.toast?.error(t('message.copy.failed'))
    }
  }, [blockId, node?.position, setCopied, t])

  const handleDownloadCsv = useCallback(() => {
    const tableMarkdown = extractTableMarkdown(blockId ?? '', node?.position)
    if (!tableMarkdown) return

    const csv = convertMarkdownTableToCsv(tableMarkdown)
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `table-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
    setDownloaded(true)
  }, [blockId, node?.position, setDownloaded])

  const handleExportExcel = useCallback(async () => {
    const tableMarkdown = extractTableMarkdown(blockId ?? '', node?.position)
    if (!tableMarkdown) {
      window.toast?.error(t('message.error.table.invalid'))
      return
    }

    try {
      const result = await exportTableToExcel(tableMarkdown)
      if (result) {
        window.toast?.success(t('message.success.excel.export'))
      }
    } catch (error) {
      logger.error('Failed to export table to Excel', { error })
      window.toast?.error(t('message.error.excel.export'))
    }
  }, [blockId, node?.position, t])

  return (
    <TableWrapper className="table-wrapper">
      <table>{children}</table>
      <ToolbarWrapper className="table-toolbar">
        <Tooltip title={t('common.download') || 'Download CSV'} mouseEnterDelay={0.8}>
          <ToolButton role="button" aria-label="Download CSV" onClick={handleDownloadCsv}>
            {downloaded ? <Check size={14} color="var(--color-primary)" /> : <Download size={14} />}
          </ToolButton>
        </Tooltip>
        <Tooltip title={t('common.copy')} mouseEnterDelay={0.8}>
          <ToolButton role="button" aria-label={t('common.copy')} onClick={handleCopyTable}>
            {copied ? <Check size={14} color="var(--color-primary)" /> : <CopyIcon size={14} />}
          </ToolButton>
        </Tooltip>
        <Tooltip title={t('common.export.excel')} mouseEnterDelay={0.8}>
          <ToolButton role="button" aria-label={t('common.export.excel')} onClick={handleExportExcel}>
            <FileSpreadsheet size={14} />
          </ToolButton>
        </Tooltip>
      </ToolbarWrapper>
    </TableWrapper>
  )
}

/**
 * 从原始 Markdown 内容中提取表格源代码
 * @param blockId 消息块 ID
 * @param position 表格节点的位置信息
 * @returns 源代码
 */
export function extractTableMarkdown(blockId: string, position: any): string {
  if (!position || !blockId) return ''

  const block = messageBlocksSelectors.selectById(store.getState(), blockId)
  if (!block || !('content' in block) || typeof block.content !== 'string') return ''

  const { start, end } = position
  const lines = block.content.split('\n')

  // 提取表格对应的行（行号从1开始，数组索引从0开始）
  const tableLines = lines.slice(start.line - 1, end.line)
  return tableLines.join('\n').trim()
}

function convertMarkdownTableToHtml(markdownTable: string): string {
  const md = new MarkdownIt({
    html: true,
    breaks: false,
    linkify: false
  })

  return md.render(markdownTable)
}

function convertMarkdownTableToCsv(markdownTable: string): string {
  const lines = markdownTable.split('\n').filter((l) => l.trim())
  const rows: string[][] = []

  for (const line of lines) {
    if (/^\s*\|?[\s:-]+[\s|:-]*\|?\s*$/.test(line)) continue
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
    rows.push(cells)
  }

  return rows
    .map((row) =>
      row
        .map((cell) => {
          const escaped = cell.replace(/"/g, '""')
          return /[,"\n\r]/.test(escaped) ? `"${escaped}"` : escaped
        })
        .join(',')
    )
    .join('\r\n')
}

const TableWrapper = styled.div`
  position: relative;
  padding-top: 28px;

  .table-toolbar {
    border-radius: 4px;
    opacity: 1;
    transform: translateZ(0);
  }
`

const ToolbarWrapper = styled.div`
  position: absolute;
  top: 0;
  right: 0;
  z-index: 10;
  display: flex;
  flex-direction: row;
  gap: 4px;
`

const ToolButton = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  transition: all 0.2s ease;
  opacity: 1;
  color: var(--color-text-3);
  background-color: var(--color-background-mute);
  will-change: background-color, opacity;

  &:hover {
    background-color: var(--color-background-soft);
  }
`

export default memo(Table)
