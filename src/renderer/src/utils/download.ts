import { loggerService } from '@logger'
import i18n from '@renderer/i18n'

const logger = loggerService.withContext('Utils:download')

export const download = (url: string, filename?: string) => {
  if (canSaveImageByDialog() && isImageUrl(url, filename)) {
    saveImageByDialog(url, filename).catch((error) => {
      handleDownloadError(error)
    })
    return
  }

  // 处理可直接通过 <a> 标签下载的 URL:
  // - 本地文件 ( file:// )
  // - 对象 URL ( blob: )
  // - 相对安全的内联数据 ( data:image/png, data:image/jpeg )
  //   (注: 其他 data 类型，如 data:text/html 或 data:image/svg+xml，
  //    因其潜在安全风险，不在此处理，将由后续 fetch 逻辑处理或被 CSP 阻止。)
  const SUPPORTED_PREFIXES = ['file://', 'blob:', 'data:image/png', 'data:image/jpeg']
  if (SUPPORTED_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    const link = document.createElement('a')
    link.href = url

    let resolvedFilename = filename
    if (!resolvedFilename) {
      if (url.startsWith('file://')) {
        const pathname = new URL(url).pathname
        resolvedFilename = decodeURIComponent(pathname.substring(pathname.lastIndexOf('/') + 1))
      } else if (url.startsWith('blob:')) {
        resolvedFilename = `${Date.now()}_diagram.svg`
      } else if (url.startsWith('data:')) {
        const mimeMatch = url.match(/^data:([^;,]+)[;,]/)
        const mimeType = mimeMatch && mimeMatch[1]
        const extension = getExtensionFromMimeType(mimeType)
        resolvedFilename = `${Date.now()}_download${extension}`
      } else resolvedFilename = 'download'
    }
    link.download = resolvedFilename

    document.body.appendChild(link)
    link.click()
    link.remove()
    return
  }

  // 处理普通 URL
  fetch(url)
    .then((response) => {
      let finalFilename = filename || 'download'

      if (!filename) {
        // 尝试从Content-Disposition头获取文件名
        const contentDisposition = response.headers.get('Content-Disposition')
        if (contentDisposition) {
          const filenameMatch = contentDisposition.match(/filename="?(.+)"?/i)
          if (filenameMatch) {
            finalFilename = filenameMatch[1]
          }
        }

        // 如果URL中有文件名，使用URL中的文件名
        const urlFilename = url.split('/').pop()
        if (urlFilename && urlFilename.includes('.')) {
          finalFilename = urlFilename
        }

        // 如果文件名没有后缀，根据Content-Type添加后缀
        if (!finalFilename.includes('.')) {
          const contentType = response.headers.get('Content-Type')
          const extension = getExtensionFromMimeType(contentType)
          finalFilename += extension
        }

        // 添加时间戳以确保文件名唯一
        finalFilename = `${Date.now()}_${finalFilename}`
      }

      return response.blob().then((blob) => ({ blob, finalFilename }))
    })
    .then(({ blob, finalFilename }) => {
      const blobUrl = URL.createObjectURL(new Blob([blob]))
      const link = document.createElement('a')
      link.href = blobUrl
      link.download = finalFilename
      document.body.appendChild(link)
      link.click()
      URL.revokeObjectURL(blobUrl)
      link.remove()
    })
    .catch(handleDownloadError)
}

// 辅助函数：根据MIME类型获取文件扩展名
function getExtensionFromMimeType(mimeType: string | null): string {
  if (!mimeType) return '.bin' // 默认二进制文件扩展名

  const mimeToExtension: { [key: string]: string } = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
  }

  return mimeToExtension[mimeType] || '.bin'
}

function canSaveImageByDialog(): boolean {
  return typeof window !== 'undefined' && typeof window.api?.file?.saveImage === 'function'
}

function isImageUrl(url: string, filename?: string): boolean {
  if (url.startsWith('data:image/')) return true

  const candidate = (filename || url.split('?')[0]).toLowerCase()
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(candidate)
}

async function saveImageByDialog(url: string, filename?: string): Promise<void> {
  const { dataUrl, mimeType } = await resolveImageData(url)
  const resolvedFilename = resolveImageFilename(url, filename, mimeType)
  const baseName = removeExtension(resolvedFilename)
  await window.api.file.saveImage(baseName, dataUrl)
}

async function resolveImageData(url: string): Promise<{ dataUrl: string; mimeType: string | null }> {
  if (url.startsWith('data:image/')) {
    const mimeMatch = url.match(/^data:([^;,]+)[;,]/)
    return { dataUrl: url, mimeType: mimeMatch?.[1] ?? null }
  }

  const response = await fetch(url)
  const blob = await response.blob()
  const dataUrl = await blobToDataUrl(blob)
  return { dataUrl, mimeType: blob.type || response.headers.get('Content-Type') }
}

function resolveImageFilename(url: string, filename?: string, mimeType?: string | null): string {
  if (filename) return filename

  const fromUrl = url.split('/').pop()?.split('?')[0]
  if (fromUrl && fromUrl.includes('.')) return fromUrl

  const ext = getExtensionFromMimeType(mimeType || 'image/png')
  return `${Date.now()}_download${ext}`
}

function removeExtension(name: string): string {
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(0, index) : name
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob'))
    reader.readAsDataURL(blob)
  })
}

function handleDownloadError(error: any) {
  logger.error('Download failed:', error)
  if (error?.message) {
    window.toast?.error(`${i18n.t('message.download.failed')}：${error.message}`)
  } else {
    window.toast?.error(i18n.t('message.download.failed'))
  }
}
