import type { FileMetadata, FileType } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { audioExts, documentExts, GB, imageExts, KB, MB, textExts, videoExts } from '@shared/config/constant'
import mime from 'mime-types'

/**
 * 从文件路径中提取目录路径。
 * @param {string} filePath 文件路径
 * @returns {string} 目录路径
 */
export function getFileDirectory(filePath: string): string {
  const parts = filePath.split('/')
  return parts.slice(0, -1).join('/')
}

/**
 * 从文件路径中提取文件扩展名。
 * @param {string} filePath 文件路径
 * @returns {string} 文件扩展名（小写），如果没有则返回 '.'
 */
export function getFileExtension(filePath: string): string {
  const parts = filePath.split('.')
  if (parts.length > 1) {
    const extension = parts.slice(-1)[0].toLowerCase()
    return '.' + extension
  }
  return '.'
}

/**
 * 从文件路径中移除文件扩展名。
 * @param {string} filePath 文件路径
 * @returns {string} 移除扩展名后的文件路径
 */
export function removeFileExtension(filePath: string): string {
  const parts = filePath.split('.')
  if (parts.length > 1) {
    return parts.slice(0, -1).join('.')
  }
  return filePath
}

/**
 * 格式化文件大小，根据大小返回以 MB 或 KB 为单位的字符串。
 * @param {number} size 文件大小（字节）
 * @returns {string} 格式化后的文件大小字符串
 */
export function formatFileSize(size: number | any): string {
  // 防御性处理：确保 size 是数字
  let normalizedSize: number
  
  if (typeof size === 'object' && size !== null) {
    // 如果是对象，尝试提取 size 属性
    normalizedSize = typeof size.size === 'number' ? size.size : 0
    console.warn('[formatFileSize] Received object instead of number:', size)
  } else if (typeof size === 'number') {
    normalizedSize = size
  } else {
    normalizedSize = 0
    console.warn('[formatFileSize] Received invalid type:', typeof size, size)
  }

  if (normalizedSize >= MB) {
    return (normalizedSize / MB).toFixed(1) + ' MB'
  }

  if (normalizedSize >= KB) {
    return (normalizedSize / KB).toFixed(0) + ' KB'
  }

  return (normalizedSize / KB).toFixed(2) + ' KB'
}

/**
 * 从文件名中移除特殊字符：
 * - 替换非法字符为下划线
 * - 替换换行符为空格。
 * @param {string} str 输入字符串
 * @returns {string} 处理后的文件名字符串
 */
export function removeSpecialCharactersForFileName(str: string): string {
  return str
    .replace(/[<>:"/\\|?*.]/g, '_')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

/**
 * 检查文件是否为支持的类型。
 * 支持的文件类型包括:
 * 1. 文件扩展名在supportExts集合中的文件
 * 2. 文本文件
 * @param {string} filePath 文件路径
 * @param {Set<string>} supportExts 支持的文件扩展名集合
 * @returns {Promise<boolean>} 如果文件类型受支持返回true，否则返回false
 */
export async function isSupportedFile(filePath: string, supportExts: Set<string>): Promise<boolean> {
  try {
    if (supportExts.has(getFileExtension(filePath))) {
      return true
    }

    if (await window.api.file.isTextFile(filePath)) {
      return true
    }

    return false
  } catch (error) {
    return false
  }
}

export async function isTextFile(filePath: string): Promise<boolean> {
  const set = new Set(textExts)
  return isSupportedFile(filePath, set)
}

export async function filterSupportedFiles(files: FileMetadata[], supportExts: string[]): Promise<FileMetadata[]> {
  const extensionSet = new Set(supportExts)
  const validationResults = await Promise.all(
    files.map(async (file) => ({
      file,
      isValid: await isSupportedFile(file.path, extensionSet)
    }))
  )
  return validationResults.filter((result) => result.isValid).map((result) => result.file)
}

export const mime2type = (mimeStr: string): FileType => {
  const mimeType = mimeStr.toLowerCase()
  const ext = mime.extension(mimeType)
  if (ext) {
    if (textExts.includes(ext)) {
      return FILE_TYPE.TEXT
    } else if (imageExts.includes(ext)) {
      return FILE_TYPE.IMAGE
    } else if (documentExts.includes(ext)) {
      return FILE_TYPE.DOCUMENT
    } else if (audioExts.includes(ext)) {
      return FILE_TYPE.AUDIO
    } else if (videoExts.includes(ext)) {
      return FILE_TYPE.VIDEO
    }
  }
  return FILE_TYPE.OTHER
}

export function parseFileTypes(str: string): FileType | null {
  if (Object.values(FILE_TYPE).some((type) => type === str)) {
    return str as FileType
  }
  return null
}
