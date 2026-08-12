import { loggerService } from '@logger'
import type { FileMetadata } from '@renderer/types/file'
import { AbsoluteFilePathSchema, type FileUrlString } from '@shared/types/file'
import { toSafeFileUrl } from '@shared/utils/file'

const logger = loggerService.withContext('paintingFileUrl')

// `getPaintingFileUrl` runs on every painting render; dedupe the warn per
// offending path so a bad path can't flood the log across rerenders.
const warnedPaintingPaths = new Set<string>()

type PaintingFileUrlSource = Pick<FileMetadata, 'path' | 'ext'>

/**
 * Build a renderable URL for painting outputs while the painting state still
 * carries v1 `FileMetadata`. The path itself is resolved by main process via
 * `getPhysicalPath`; renderer only applies shared file-url formatting/safety.
 */
export function getPaintingFileUrl(file: PaintingFileUrlSource): FileUrlString | undefined {
  if (!file.path) return undefined
  const parsedPath = AbsoluteFilePathSchema.safeParse(file.path)
  if (!parsedPath.success) {
    if (!warnedPaintingPaths.has(file.path)) {
      warnedPaintingPaths.add(file.path)
      logger.warn('getPaintingFileUrl: non-canonical/invalid painting path', { path: file.path })
    }
    return undefined
  }
  // The Qt page is served from localhost, so Chromium/QWebEngine blocks
  // `http(s) -> file://` image loads. Stream the allowlisted headless output
  // through the local backend instead. Desktop Electron keeps its native
  // file URL path.
  const runtimeWindow = window as Window & { __CHERRY_BACKEND_URL?: string }
  // A backend URL is only injected by the Qt/Houdini host. Do not additionally
  // gate on __IS_QT: module/runtime ordering can leave that marker unavailable
  // even though this page is running under Qt, which falls through to a blocked
  // file:// URL.
  if (runtimeWindow.__CHERRY_BACKEND_URL) {
    const backendUrl = runtimeWindow.__CHERRY_BACKEND_URL.replace(/\/$/, '')
    return `${backendUrl}/api/v1/files/raw-image?path=${encodeURIComponent(parsedPath.data)}` as FileUrlString
  }
  return toSafeFileUrl(parsedPath.data, file.ext || null)
}
