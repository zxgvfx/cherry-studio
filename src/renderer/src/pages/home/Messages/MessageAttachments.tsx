import { useAttachment } from '@renderer/hooks/useAttachment'
import { getFileIcon } from '@renderer/pages/home/Inputbar/AttachmentPreview'
import FileManager from '@renderer/services/FileManager'
import { FILE_TYPE } from '@renderer/types'
import type { FileMessageBlock } from '@renderer/types/newMessage'
import { formatFileSize, parseFileTypes } from '@renderer/utils'
import { videoExts } from '@shared/config/constant'
import { t } from 'i18next'
import type { FC } from 'react'
import styled from 'styled-components'

interface Props {
  block: FileMessageBlock
}

const MessageAttachments: FC<Props> = ({ block }) => {
  const { preview } = useAttachment()

  if (!block.file) {
    return null
  }

  const file = block.file
  const fileName = FileManager.formatFileName(file)

  const isVideo = file.type === FILE_TYPE.VIDEO || videoExts.includes(file.ext?.toLowerCase() ?? '')
  // 通过后端 HTTP 加载时才能用 serve/preview 端点内联播放（Houdini webview 场景）
  const canInlinePlay = isVideo && window.location.protocol.startsWith('http')

  const handleClick = () => {
    const path = FileManager.getSafePath(file)
    const fileType = parseFileTypes(file.type)
    if (fileType === null) {
      window.modal.error({ content: t('files.preview.error'), centered: true })
      return
    }
    preview(path, fileName, fileType, file.ext)
  }

  if (canInlinePlay) {
    // preview-video 端点会按需把 H.264 mp4 转码成 WebM（QtWebEngine 不带 H.264 解码器），
    // 结果有缓存；preload="none" 避免打开历史会话时批量触发转码
    const previewUrl = `/api/v1/files/preview-video?name=${encodeURIComponent(file.id + file.ext)}`
    return (
      <Container className="message-attachments">
        <VideoCard>
          <InlineVideo src={previewUrl} controls preload="none" />
          <VideoMeta title={fileName}>
            {fileName} · {formatFileSize(file.size)}
          </VideoMeta>
        </VideoCard>
      </Container>
    )
  }

  return (
    <Container className="message-attachments">
      <FileCard onClick={handleClick}>
        <IconWrapper>{getFileIcon(file.ext)}</IconWrapper>
        <FileInfo>
          <FileName title={fileName}>{fileName}</FileName>
          <FileMeta>{formatFileSize(file.size)}</FileMeta>
        </FileInfo>
      </FileCard>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
  margin-bottom: 8px;
`

const FileCard = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-background-soft);
  cursor: pointer;
  max-width: 320px;
  transition: all 0.2s ease;

  &:hover {
    border-color: var(--color-primary);
    background: var(--color-background-mute);
  }
`

const IconWrapper = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  color: var(--color-text-2);
  flex-shrink: 0;
`

const FileInfo = styled.div`
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
`

const FileName = styled.div`
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
`

const FileMeta = styled.div`
  font-size: 11px;
  color: var(--color-text-3);
`

const VideoCard = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 480px;
  width: 100%;
`

const InlineVideo = styled.video`
  width: 100%;
  max-height: 320px;
  border-radius: 8px;
  background: #000;
  object-fit: contain;
`

const VideoMeta = styled.div`
  font-size: 11px;
  color: var(--color-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

export default MessageAttachments
