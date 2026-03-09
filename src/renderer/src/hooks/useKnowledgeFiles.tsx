import FileManager from '@renderer/services/FileManager'
import type { FileMetadata } from '@renderer/types'
import { isEmpty } from 'lodash'
import { useEffect, useState } from 'react'

import { useKnowledgeBases } from './useKnowledge'

export const useKnowledgeFiles = () => {
  const [knowledgeFiles, setKnowledgeFiles] = useState<FileMetadata[]>([])
  const { bases, updateKnowledgeBases } = useKnowledgeBases()

  useEffect(() => {
    const items = bases.map((kb) => kb.items).flat()

    const fileItems = items
      .filter((item) => item.type === 'file')
      .filter((item) => item.processingStatus === 'completed')

    const files = fileItems.map((item) => item.content as FileMetadata)

    !isEmpty(files) && setKnowledgeFiles(files)
  }, [bases])

  const removeAllFiles = async () => {
    await FileManager.deleteFiles(knowledgeFiles)

    const newBases = bases.map((kb) => ({
      ...kb,
      items: kb.items.map((item) =>
        item.type === 'file'
          ? {
              ...item,
              content: {
                ...(item.content as FileMetadata),
                size: 0
              }
            }
          : item
      )
    }))
    updateKnowledgeBases(newBases)
  }

  const size = knowledgeFiles.reduce((acc, file) => {
    // 处理 size 可能是对象 {size: number, count: number} 的情况
    const fileSize = typeof file.size === 'object' && file.size !== null 
      ? (file.size as any).size || 0
      : typeof file.size === 'number' 
        ? file.size 
        : 0
    
    // 调试日志
    if (typeof file.size === 'object') {
      console.warn('[useKnowledgeFiles] Found file with object size:', file.id, file.size)
    }
    
    return acc + fileSize
  }, 0)

  console.log('[useKnowledgeFiles] Total size calculated:', size, 'type:', typeof size, 'from', knowledgeFiles.length, 'files')

  // 确保返回的 size 一定是数字
  const normalizedSize = typeof size === 'number' ? size : 0

  return { knowledgeFiles, size: normalizedSize, removeAllFiles }
}
