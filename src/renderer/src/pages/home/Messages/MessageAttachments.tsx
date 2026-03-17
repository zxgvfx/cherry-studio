import { useAttachment } from '@renderer/hooks/useAttachment'
import { getFileIcon } from '@renderer/pages/home/Inputbar/AttachmentPreview'
import FileManager from '@renderer/services/FileManager'
import type { FileMessageBlock } from '@renderer/types/newMessage'
import { formatFileSize, parseFileTypes } from '@renderer/utils'
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

  const handleClick = () => {
    const path = FileManager.getSafePath(file)
    const fileType = parseFileTypes(file.type)
    if (fileType === null) {
      window.modal.error({ content: t('files.preview.error'), centered: true })
      return
    }
    preview(path, fileName, fileType, file.ext)
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

export default MessageAttachments
