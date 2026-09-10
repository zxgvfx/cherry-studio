import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CocoSessionAsset } from '@shared/ai/cocoSessionAssets'
import { pipelineAssetFileName, selectTerminalRunAssets } from '@shared/ai/pipelinePreview'
import type { PipelineAssetPartData } from '@shared/data/types/uiParts'

import { localUsername, pipelineApiBase } from './pipelineClient'

const ASSET_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi

const MODEL_EXT = /\.(glb|gltf|fbx|obj|stl|usd|usda|usdc)(\?|#|$)/i
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tif|tiff|exr|hdr)(\?|#|$)/i
const VIDEO_EXT = /\.(mp4|mov|webm|mkv)(\?|#|$)/i

export function isModelPipelineAsset(asset: Pick<PipelineAssetPartData, 'name' | 'assetType'>): boolean {
  const hint = `${asset.assetType} ${asset.name}`.toLowerCase()
  return (
    MODEL_EXT.test(asset.name) ||
    hint.includes('gltf') ||
    hint.includes('glb') ||
    hint.includes('fbx') ||
    hint.includes('geometry') ||
    hint.includes('model/')
  )
}

export function isImagePipelineAsset(asset: Pick<PipelineAssetPartData, 'name' | 'assetType'>): boolean {
  return IMAGE_EXT.test(asset.name) || asset.assetType.toLowerCase().startsWith('media/image')
}

export function isVideoPipelineAsset(asset: Pick<PipelineAssetPartData, 'name' | 'assetType'>): boolean {
  return VIDEO_EXT.test(asset.name) || asset.assetType.toLowerCase().startsWith('media/video')
}

export function guessPipelineAssetMime(asset: Pick<PipelineAssetPartData, 'name' | 'assetType' | 'mimeType'>): string {
  if (asset.mimeType) return asset.mimeType
  if (isImagePipelineAsset(asset)) return 'image/png'
  if (isVideoPipelineAsset(asset)) return 'video/mp4'
  if (/\.glb(\?|#|$)/i.test(asset.name) || /gltf-binary/i.test(asset.assetType)) return 'model/gltf-binary'
  if (/\.gltf(\?|#|$)/i.test(asset.name)) return 'model/gltf+json'
  return 'application/octet-stream'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function coerceRunResult(result: unknown): Record<string, unknown> | null {
  let value: unknown = result
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
    try {
      value = JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  const record = asRecord(value)
  if (!record) return null
  const nested = asRecord(record.result)
  if (nested && (nested.run || nested.assets || nested.run_id)) return nested
  return record
}

function readString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function sanitizeAssetFilename(name: string): string {
  const trimmed = name.replace(/[<>:"/\\|?*\u0000]/g, '_').trim() || 'asset.bin'
  return trimmed.slice(0, 180)
}

export function isPreviewablePipelineAsset(asset: PipelineAssetPartData): boolean {
  if (!asset.assetId) return false
  return (
    isModelPipelineAsset(asset) ||
    isImagePipelineAsset(asset) ||
    isVideoPipelineAsset(asset) ||
    Boolean(asset.localPath) ||
    Boolean(asset.downloadUrl)
  )
}

export function isInlinePreviewRequest(text: string): boolean {
  return /预览|preview|看看|看一下|打开(一下)?(这个|刚才|刚刚)?(的)?(模型|文件|资产|预览)|显示(一下)?(模型|文件|预览)|show\s+(me\s+)?(the\s+)?(model|file|asset|preview)/i.test(
    text
  )
}

export function extractAssetIdsFromText(text: string): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(ASSET_UUID)) {
    const id = match[0].toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(match[0])
  }
  return ids
}

export function pipelinePartFromSessionAsset(asset: CocoSessionAsset): PipelineAssetPartData {
  const assetType =
    asset.kind === 'model'
      ? 'model/gltf-binary'
      : asset.kind === 'image'
        ? 'media/image'
        : asset.kind === 'video'
          ? 'media/video'
          : 'file'
  const downloadUrl = pipelineFileUrl(asset.assetId)
  const previewUrl = asset.previewUrl || pipelineModelPreviewUrl(asset.assetId, asset.name, assetType)
  let localPath: string | undefined
  if (asset.previewUrl?.startsWith('file:')) {
    try {
      const candidate = fileURLToPath(asset.previewUrl)
      if (fs.existsSync(candidate)) localPath = candidate
    } catch {
      // Invalid or stale file URL: keep the remote download fallback.
    }
  }
  return {
    assetId: asset.assetId,
    name: asset.name,
    assetType,
    downloadUrl,
    previewUrl,
    ...(localPath ? { localPath } : {}),
    mimeType: guessPipelineAssetMime({ name: asset.name, assetType }),
    ...(asset.runId ? { runId: asset.runId } : {})
  }
}

export function selectPreviewableSessionAssets(
  assets: readonly CocoSessionAsset[],
  options?: { mentionedIds?: readonly string[]; limit?: number; allowUploads?: boolean }
): PipelineAssetPartData[] {
  const limit = options?.limit ?? 2
  const previewable = assets.filter(
    (asset) => asset.kind === 'model' || asset.kind === 'image' || asset.kind === 'video'
  )
  const generated = previewable.filter((asset) => asset.origin === 'generated')
  const pool = options?.allowUploads ? previewable : generated
  const mentioned = options?.mentionedIds ?? []
  if (mentioned.length > 0) {
    const byId = new Map(pool.map((asset) => [asset.assetId.toLowerCase(), asset]))
    const hits = mentioned.flatMap((id) => {
      const asset = byId.get(id.toLowerCase())
      return asset ? [pipelinePartFromSessionAsset(asset)] : []
    })
    if (hits.length > 0) return hits
  }
  const generatedModels = generated.filter((asset) => asset.kind === 'model')
  const pick = generatedModels.length > 0 ? generatedModels.slice(-limit) : generated.slice(-limit)
  return pick.map(pipelinePartFromSessionAsset)
}

export function extractLatestRunAssetsFromEvents(events: unknown): PipelineAssetPartData[] {
  if (!Array.isArray(events)) return []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (!event || typeof event !== 'object') continue
    if ((event as { type?: unknown }).type !== 'tool_result') continue
    const data = asRecord((event as { data?: unknown }).data)
    if (!data) continue
    const toolName = readString(data.name, data.tool_name)
    const assets = extractRunAssets(data.result != null ? data.result : data, { toolName })
    if (assets.length > 0) return assets
  }
  return []
}

export function extractRunAssets(result: unknown, options?: { toolName?: string }): PipelineAssetPartData[] {
  const record = coerceRunResult(result)
  if (!record) return []
  const run = asRecord(record.run)
  const runId = readString(run?.run_id, run?.id, record.run_id)
  const fromSubmitGraph = options?.toolName === 'submit.graph' || record.timed_out === true || Boolean(run)
  if (!fromSubmitGraph) return []
  const rawAssets = Array.isArray(record.assets) ? record.assets : []
  if (rawAssets.length === 0) return []

  const status = readString(run?.status, record.status).toLowerCase()
  const failed = status === 'failed' || status === 'cancelled' || status === 'canceled'
  if (failed && !record.still_running && !record.timed_out) return []

  const assets: PipelineAssetPartData[] = []
  for (const item of rawAssets) {
    const row = asRecord(item)
    if (!row) continue
    const assetId = readString(row.id, row.asset_id, row.assetId)
    if (!assetId) continue
    const rawName = readString(row.name, row.filename) || `${assetId}.bin`
    const assetType = readString(row.asset_type, row.assetType) || 'file'
    const downloadUrl = readString(row.download_url, row.downloadUrl) || pipelineFileUrl(assetId)
    const localPath = readString(row.local_path, row.localPath) || undefined
    const sizeBytes = typeof row.size_bytes === 'number' ? row.size_bytes : undefined
    const sourceNodeId = readString(row.source_node_id, row.sourceNodeId) || undefined
    const meta = asRecord(row.metadata)
    const sourceStepId = readString(row.source_step_id, row.sourceStepId, meta?.step_id, meta?.source_step) || undefined
    const operation = readString(meta?.operation, row.operation)
    const name = pipelineAssetFileName({
      name: rawName,
      ...(sourceStepId ? { sourceStepId } : {}),
      ...(sourceNodeId ? { sourceNodeId } : {}),
      ...(operation ? { operation } : {}),
      assetType
    })
    const previewUrl = readString(row.preview_url, row.previewUrl) || pipelineModelPreviewUrl(assetId, name, assetType)
    assets.push({
      assetId,
      name,
      assetType,
      downloadUrl,
      previewUrl,
      ...(localPath ? { localPath } : {}),
      mimeType: guessPipelineAssetMime({
        name,
        assetType,
        mimeType: readString(row.mimeType, row.mediaType) || undefined
      }),
      ...(typeof sizeBytes === 'number' ? { sizeBytes } : {}),
      ...(runId ? { runId } : {}),
      ...(sourceNodeId ? { sourceNodeId } : {}),
      ...(sourceStepId ? { sourceStepId } : {})
    })
  }
  const previewable = assets.filter(isPreviewablePipelineAsset)
  const pool = previewable.length > 0 ? previewable : assets
  return selectTerminalRunAssets(pool)
}

function cocoAssetCacheDir(): string {
  const appdata = process.env.APPDATA
  if (process.platform === 'win32' && appdata) {
    return path.join(appdata, 'CherryStudioHoudiniHeadless', 'coco-assets')
  }
  return path.join(os.homedir(), '.cherrystudio', 'coco-assets')
}

export function pipelineFileUrl(assetId: string): string {
  return `${pipelineApiBase()}/api/assets/${encodeURIComponent(assetId)}/file`
}

export function pipelineModelPreviewUrl(assetId: string, name: string, assetType: string): string {
  if (isModelPipelineAsset({ name, assetType }) && !/\.(glb|gltf)(\?|#|$)/i.test(name)) {
    return `${pipelineApiBase()}/api/model-viewer/assets/${encodeURIComponent(assetId)}/preview.glb`
  }
  return pipelineFileUrl(assetId)
}

export async function cachePipelineAssets(
  assets: PipelineAssetPartData[],
  signal?: AbortSignal
): Promise<PipelineAssetPartData[]> {
  const dir = cocoAssetCacheDir()
  await fs.promises.mkdir(dir, { recursive: true })
  const cached: PipelineAssetPartData[] = []
  for (const asset of assets) {
    try {
      cached.push(await cacheOne(dir, asset, signal))
    } catch {
      cached.push(asset)
    }
  }
  return cached
}

async function cacheOne(
  dir: string,
  asset: PipelineAssetPartData,
  signal?: AbortSignal
): Promise<PipelineAssetPartData> {
  const localPath = path.join(dir, `${sanitizeAssetFilename(asset.assetId)}__${sanitizeAssetFilename(asset.name)}`)
  if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) {
    return { ...asset, localPath }
  }
  const res = await fetch(asset.downloadUrl, {
    signal,
    headers: { 'X-User-Key': localUsername() }
  })
  if (!res.ok) throw new Error(`download ${asset.assetId} failed: ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  await fs.promises.writeFile(localPath, bytes)
  return { ...asset, localPath, sizeBytes: asset.sizeBytes ?? bytes.length }
}

export async function hydrateToolResultEvent(event: unknown, signal?: AbortSignal): Promise<unknown> {
  if (!event || typeof event !== 'object') return event
  const type = (event as { type?: unknown }).type
  if (type !== 'tool_result') return event
  const data = asRecord((event as { data?: unknown }).data)
  if (!data) return event
  const result = data.result != null ? data.result : data
  const assets = extractRunAssets(result, { toolName: readString(data.name, data.tool_name) || undefined })
  if (assets.length === 0) return event
  const cached = await cachePipelineAssets(assets, signal)
  const resultRecord = coerceRunResult(result) ?? asRecord(result) ?? {}
  return {
    ...(event as Record<string, unknown>),
    data: {
      ...data,
      result: {
        ...resultRecord,
        assets: cached.map((asset) => ({
          id: asset.assetId,
          name: asset.name,
          asset_type: asset.assetType,
          download_url: asset.downloadUrl,
          local_path: asset.localPath,
          mimeType: asset.mimeType,
          size_bytes: asset.sizeBytes,
          ...(asset.sourceNodeId ? { source_node_id: asset.sourceNodeId } : {}),
          ...(asset.sourceStepId ? { source_step_id: asset.sourceStepId } : {})
        }))
      }
    }
  }
}
