import db from '@renderer/databases'
import type { FileMetadata } from '@renderer/types'

/**
 * 修复数据库中文件的 size 和 count 字段
 * 如果它们是对象 {size: number, count: number}，则提取实际值
 */
export async function fixFileDatabase(): Promise<{
  fixed: number
  total: number
  errors: string[]
}> {
  console.log('[fixFileDatabase] Starting database repair...')
  
  const errors: string[] = []
  let fixed = 0
  let total = 0

  try {
    // 获取所有文件
    const files = await db.files.toArray()
    total = files.length
    
    console.log(`[fixFileDatabase] Found ${total} files to check`)

    // 检查并修复每个文件
    for (const file of files) {
      let needsUpdate = false
      const updates: Partial<FileMetadata> = {}

      // 检查 size 字段
      if (typeof file.size === 'object' && file.size !== null) {
        console.warn(`[fixFileDatabase] File ${file.id} has object size:`, file.size)
        updates.size = (file.size as any).size || 0
        needsUpdate = true
      }

      // 检查 count 字段
      if (typeof file.count === 'object' && file.count !== null) {
        console.warn(`[fixFileDatabase] File ${file.id} has object count:`, file.count)
        updates.count = (file.count as any).count || 0
        needsUpdate = true
      }

      // 如果需要更新，则更新数据库
      if (needsUpdate) {
        try {
          await db.files.update(file.id, updates)
          fixed++
          console.log(`[fixFileDatabase] Fixed file ${file.id}:`, updates)
        } catch (error) {
          const errorMsg = `Failed to update file ${file.id}: ${error}`
          console.error(`[fixFileDatabase] ${errorMsg}`)
          errors.push(errorMsg)
        }
      }
    }

    console.log(`[fixFileDatabase] Repair complete: fixed ${fixed} out of ${total} files`)
    return { fixed, total, errors }
  } catch (error) {
    console.error('[fixFileDatabase] Error during database repair:', error)
    errors.push(`Database repair failed: ${error}`)
    return { fixed, total, errors }
  }
}

