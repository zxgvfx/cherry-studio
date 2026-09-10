export type CocoSessionAssetKind = 'image' | 'model' | 'video' | 'other'
export type CocoSessionAssetOrigin = 'upload' | 'generated'

export interface CocoSessionAsset {
  assetId: string
  name: string
  kind: CocoSessionAssetKind
  origin: CocoSessionAssetOrigin
  caption: string
  runId?: string
  workflowId?: string
  sourceNodeId?: string
  parentAssetId?: string
  previewUrl?: string
  createdAt?: string | number
  sizeBytes?: number
  assetType?: string
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tif|tiff|exr|hdr)(\?|#|$)/i
const MODEL_EXT = /\.(glb|gltf|fbx|obj|stl|usd|usda|usdc)(\?|#|$)/i
const VIDEO_EXT = /\.(mp4|mov|webm|mkv)(\?|#|$)/i

function readString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function guessCocoSessionAssetKind(name: string, assetType = ''): CocoSessionAssetKind {
  const hint = `${name} ${assetType}`.toLowerCase()
  if (MODEL_EXT.test(name) || hint.includes('gltf') || hint.includes('geometry') || hint.includes('model/')) {
    return 'model'
  }
  if (IMAGE_EXT.test(name) || hint.includes('media/image') || hint.includes('/image')) return 'image'
  if (VIDEO_EXT.test(name) || hint.includes('media/video')) return 'video'
  return 'other'
}

export function captionForCocoUpload(name: string): string {
  return `上传 · ${name}`
}

export function captionForCocoGenerated(options: {
  name: string
  kind: CocoSessionAssetKind
  workflowId?: string
  sourceName?: string
}): string {
  const workflow = options.workflowId || 'canvas'
  let kindLabel =
    options.kind === 'model' ? '3D' : options.kind === 'image' ? '生图' : options.kind === 'video' ? '视频' : '生成'
  if (options.kind === 'model' && /3d/i.test(workflow)) kindLabel = '图生3D'
  const parts = [kindLabel, workflow]
  if (options.sourceName) parts.push(`来源 ${options.sourceName}`)
  else if (options.name) parts.push(options.name)
  return parts.join(' · ')
}

export function normalizeCocoSessionAsset(raw: unknown): CocoSessionAsset | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const assetId = readString(row.assetId, row.asset_id, row.id)
  if (!assetId) return null
  const name = readString(row.name, row.filename) || assetId
  const kindRaw = readString(row.kind)
  const kind: CocoSessionAssetKind =
    kindRaw === 'image' || kindRaw === 'model' || kindRaw === 'video' || kindRaw === 'other'
      ? kindRaw
      : guessCocoSessionAssetKind(name, readString(row.assetType, row.asset_type))
  const origin: CocoSessionAssetOrigin = row.origin === 'upload' ? 'upload' : 'generated'
  const explicitCaption = readString(row.caption)
  const asset: CocoSessionAsset = {
    assetId,
    name,
    kind,
    origin,
    caption:
      explicitCaption ||
      (origin === 'upload'
        ? captionForCocoUpload(name)
        : captionForCocoGenerated({ name, kind, workflowId: readString(row.workflowId, row.workflow_id) }))
  }
  const runId = readString(row.runId, row.run_id)
  const workflowId = readString(row.workflowId, row.workflow_id)
  const sourceNodeId = readString(row.sourceNodeId, row.source_node_id)
  const parentAssetId = readString(row.parentAssetId, row.parent_id)
  const previewUrl = readString(row.previewUrl, row.preview_url)
  const createdAt = row.createdAt ?? row.created_at
  if (runId) asset.runId = runId
  if (workflowId) asset.workflowId = workflowId
  if (sourceNodeId) asset.sourceNodeId = sourceNodeId
  if (parentAssetId) asset.parentAssetId = parentAssetId
  if (previewUrl) asset.previewUrl = previewUrl
  if (typeof createdAt === 'string' || typeof createdAt === 'number') asset.createdAt = createdAt
  const sizeBytes = readSize(row.sizeBytes, row.size_bytes)
  if (sizeBytes != null) asset.sizeBytes = sizeBytes
  const assetType = readString(row.assetType, row.asset_type)
  if (assetType) asset.assetType = assetType
  return asset
}

function readSize(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value)
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  }
  return undefined
}

export function formatCocoAssetSize(sizeBytes?: number): string {
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) return ''
  if (sizeBytes < 1024) return `${Math.round(sizeBytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = sizeBytes
  for (const unit of units) {
    value /= 1024
    if (value < 1024) {
      const text = value >= 10 ? value.toFixed(0) : value.toFixed(1)
      return `${text.replace(/\.0$/, '')} ${unit}`
    }
  }
  return `${value.toFixed(1)} PB`
}

export function mergeCocoSessionAssets(...groups: Array<unknown>): CocoSessionAsset[] {
  const order: string[] = []
  const byId = new Map<string, CocoSessionAsset>()
  for (const group of groups) {
    if (!Array.isArray(group)) continue
    for (const item of group) {
      const entry = normalizeCocoSessionAsset(item)
      if (!entry) continue
      const existing = byId.get(entry.assetId)
      if (existing) {
        const row = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : {}
        const next = { ...existing, ...entry }
        if (!readString(row.caption)) next.caption = existing.caption
        if (!readString(row.workflowId, row.workflow_id) && existing.workflowId) next.workflowId = existing.workflowId
        if (!readString(row.parentAssetId, row.parent_id) && existing.parentAssetId)
          next.parentAssetId = existing.parentAssetId
        if (existing.sizeBytes != null && next.sizeBytes == null) next.sizeBytes = existing.sizeBytes
        byId.set(entry.assetId, next)
      } else {
        byId.set(entry.assetId, entry)
        order.push(entry.assetId)
      }
    }
  }
  return order.map((id) => byId.get(id)!).filter(Boolean)
}

export function cocoSessionAssetPromptText(asset: Pick<CocoSessionAsset, 'assetId' | 'name'>): string {
  return `[本轮用户附件 ${asset.name} asset_id=${asset.assetId}]`
}

export function filterCocoSessionAssets(assets: readonly CocoSessionAsset[], query: string): CocoSessionAsset[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...assets]
  return assets.filter((asset) =>
    `${asset.name} ${asset.caption} ${asset.assetId} ${asset.origin}`.toLowerCase().includes(needle)
  )
}

export function readCocoSessionAssets(configuration: unknown, sessionId: string): CocoSessionAsset[] {
  if (!configuration || typeof configuration !== 'object' || !sessionId) return []
  const bindings = (configuration as Record<string, unknown>).coco_pipeline_sessions
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return []
  const binding = (bindings as Record<string, unknown>)[sessionId]
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return []
  return mergeCocoSessionAssets((binding as { assets?: unknown }).assets)
}
