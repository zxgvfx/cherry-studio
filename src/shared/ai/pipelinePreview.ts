import type { PipelineAssetPartData } from '@shared/data/types/uiParts'

const MODEL_EXT = /\.(glb|gltf|fbx|obj|stl|usd|usda|usdc)(\?|#|$)/i
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tif|tiff|exr|hdr)(\?|#|$)/i
const PASSTHROUGH_NODE_ID = /^(data\.load-|io\.load-|human\.|io\.workflow-input)/i

function isPassthroughNodeId(nodeId: string): boolean {
  return PASSTHROUGH_NODE_ID.test(nodeId)
}

function isModelPipelineAsset(asset: Pick<PipelineAssetPartData, 'name' | 'assetType'>): boolean {
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

function isImagePipelineAsset(asset: Pick<PipelineAssetPartData, 'name' | 'assetType'>): boolean {
  return IMAGE_EXT.test(asset.name) || asset.assetType.toLowerCase().startsWith('media/image')
}

const GENERIC_MODEL_NAME = /^(model|asset|result|output)(\[\d+\])?\.(glb|gltf)$/i

const STAGE_DISPLAY: Record<'geometry' | 'textured' | 'segmented', string> = {
  geometry: '几何模型.glb',
  textured: '贴图模型.glb',
  segmented: '分割模型.glb'
}

function fileExtension(name: string, fallback = '.glb'): string {
  const match = name.match(/\.[a-z0-9]+$/i)
  return match ? match[0] : fallback
}

function pathTokens(...values: Array<string | undefined>): Set<string> {
  const tokens = new Set<string>()
  for (const value of values) {
    for (const token of (value || '')
      .toLowerCase()
      .split(/[/_.-]+/)
      .filter(Boolean)) {
      tokens.add(token)
    }
  }
  return tokens
}

function inferModelStage(asset: {
  name?: string
  sourceStepId?: string
  sourceNodeId?: string
  operation?: string
}): 'geometry' | 'textured' | 'segmented' | null {
  const tokens = pathTokens(asset.operation, asset.sourceStepId, asset.sourceNodeId, asset.name)
  if (tokens.has('segment') || tokens.has('seg') || tokens.has('segmented')) return 'segmented'
  if (tokens.has('texture') || tokens.has('tex') || tokens.has('textured')) return 'textured'
  if (
    tokens.has('gen3d') ||
    tokens.has('geometry') ||
    tokens.has('multiview') ||
    tokens.has('text_to_model') ||
    tokens.has('image_to_model') ||
    tokens.has('multiview_to_model')
  ) {
    return 'geometry'
  }
  return null
}

/** Filesystem-safe name so drag-to-DCC and cache files are distinguishable. */
export function pipelineAssetFileName(asset: {
  name: string
  sourceStepId?: string
  sourceNodeId?: string
  assetType?: string
  operation?: string
}): string {
  const original = asset.name.trim() || 'asset.bin'
  const stage = inferModelStage(asset)
  if (!stage) return original
  if (!GENERIC_MODEL_NAME.test(original) && !/^model\./i.test(original)) return original
  return `${stage}${fileExtension(original)}`
}

/** Chat/card label. Uses Chinese names for the three Tripo stages. */
export function pipelineAssetDisplayName(asset: {
  name: string
  sourceStepId?: string
  sourceNodeId?: string
  assetType?: string
  operation?: string
}): string {
  const stage = inferModelStage(asset)
  if (stage) return STAGE_DISPLAY[stage]
  return pipelineAssetFileName(asset)
}

/** Chat should only preview the last producing node's outputs for this run. */
export function selectTerminalRunAssets(assets: readonly PipelineAssetPartData[]): PipelineAssetPartData[] {
  if (assets.length <= 1) return [...assets]
  const generated = assets.filter((asset) => !isPassthroughNodeId(asset.sourceNodeId || ''))
  const pool = generated.length > 0 ? generated : [...assets]
  const last = pool[pool.length - 1]
  const lastKey = last.sourceStepId || last.sourceNodeId
  if (lastKey) {
    let start = pool.length - 1
    while (start > 0) {
      const previous = pool[start - 1]
      const previousKey = previous.sourceStepId || previous.sourceNodeId
      if (previousKey !== lastKey) break
      start--
    }
    return pool.slice(start)
  }

  const models = pool.filter(isModelPipelineAsset)
  if (models.length > 0) return [models[models.length - 1]]
  const images = pool.filter(isImagePipelineAsset)
  if (images.length > 0) return [images[images.length - 1]]
  return [pool[pool.length - 1]]
}
