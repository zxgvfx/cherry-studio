import type { PipelineNodeCategoryId } from '@renderer/utils/pipelineNodes'

/*
 * These are reviewed data-visualization colors for the pipeline graph. They
 * encode asset types and node categories the same way ComfyUI/LiteGraph do, so
 * they intentionally sit outside the semantic foreground/background hierarchy.
 */

const ASSET_TYPE_COLORS: readonly (readonly [string, string])[] = [
  ['image', 'oklch(0.63 0.23 304)'],
  ['video', 'oklch(0.63 0.22 25)'],
  ['audio', 'oklch(0.75 0.16 70)'],
  ['mesh', 'oklch(0.62 0.19 258)'],
  ['model', 'oklch(0.62 0.19 258)'],
  ['scene', 'oklch(0.60 0.14 232)'],
  ['boolean', 'oklch(0.80 0.16 92)'],
  ['number', 'oklch(0.72 0.14 205)'],
  ['json', 'oklch(0.66 0.19 292)'],
  ['text', 'oklch(0.72 0.18 145)']
]

const CATEGORY_COLORS: Record<PipelineNodeCategoryId, string> = {
  '3d': 'oklch(0.62 0.19 258)',
  data: 'oklch(0.72 0.14 205)',
  image: 'oklch(0.63 0.23 304)',
  interactive: 'oklch(0.70 0.16 162)',
  io: 'oklch(0.65 0.04 250)',
  model: 'oklch(0.60 0.19 277)',
  motion: 'oklch(0.68 0.21 350)',
  other: 'oklch(0.68 0.03 250)',
  segmentation: 'oklch(0.70 0.13 185)',
  video: 'oklch(0.63 0.22 25)',
  workflow: 'oklch(0.75 0.16 70)'
}

export const CANVAS_NEUTRAL_PORT_COLOR = 'oklch(0.68 0.03 250)'

/** Port dot / edge stroke color for an asset type such as `asset/image`. */
export function canvasPortColor(assetType: string): string {
  const type = assetType.toLowerCase()
  for (const [token, color] of ASSET_TYPE_COLORS) {
    if (type.includes(token)) return color
  }
  return CANVAS_NEUTRAL_PORT_COLOR
}

/** Accent color for a node header, keyed by the catalog category. */
export function canvasCategoryColor(category: PipelineNodeCategoryId): string {
  return CATEGORY_COLORS[category]
}

function normalizeAssetType(assetType: string): string[] {
  return assetType
    .trim()
    .toLowerCase()
    .split('/')
    .filter((segment) => segment.length > 0)
}

/**
 * Whether an output port may feed an input port. Unknown or `any` types stay
 * permissive because the catalog does not describe every workflow interface,
 * and the Pipeline backend performs the authoritative check.
 */
export function canvasPortTypesCompatible(sourceType: string, targetType: string): boolean {
  const source = normalizeAssetType(sourceType)
  const target = normalizeAssetType(targetType)
  if (source.length === 0 || target.length === 0) return true
  if (source.at(-1) === 'any' || target.at(-1) === 'any') return true
  const shared = Math.min(source.length, target.length)
  for (let index = 0; index < shared; index += 1) {
    if (source[index] !== target[index]) return false
  }
  return true
}
