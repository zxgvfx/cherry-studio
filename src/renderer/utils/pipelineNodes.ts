import { createComposerSecureRandomId } from '@renderer/utils/message/composerFileTokenSource'

export const DEFAULT_PIPELINE_API_BASE = 'http://192.168.21.225:9331'
export const PIPELINE_NODE_TOKEN_KIND = 'pipelineNode' as const
export const PIPELINE_NODE_TOKEN_ID_PREFIX = 'pipelineNode:'

export function pipelineAssetFileUrl(assetId: string, apiBase = DEFAULT_PIPELINE_API_BASE): string {
  return `${apiBase.replace(/\/+$/, '')}/api/assets/${encodeURIComponent(assetId)}/file`
}

const CATALOG_TTL_MS = 60_000

export interface PipelineNodePort {
  name: string
  direction: string
  asset_type: string
  required: boolean
  description: string
  tags: string[]
}

export interface PipelineNodeConfigParam {
  name: string
  type: string
  required: boolean
  default: unknown
  description: string
  label: string
  group: string
  placeholder: string
  secret: boolean
  multiline: boolean
  advanced: boolean
  options: string[]
  surface: boolean
}

export interface PipelineNodeCatalogItem {
  node_id: string
  name: string
  description: string
  tags: string[]
  input_ports: PipelineNodePort[]
  output_ports: PipelineNodePort[]
  config_schema: PipelineNodeConfigParam[]
}

export interface PipelineNodeTokenPayload {
  nodeId: string
  values: Record<string, unknown>
}

export interface PipelineNodeFormField {
  key: string
  kind: 'port' | 'config'
  label: string
  description: string
  required: boolean
  advanced: boolean
  type: string
  options: string[]
  placeholder: string
  secret: boolean
  multiline: boolean
}

let catalogCache: { at: number; nodes: PipelineNodeCatalogItem[] } | null = null
let catalogInFlight: Promise<PipelineNodeCatalogItem[]> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizePort(raw: unknown): PipelineNodePort | null {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !raw.name) return null
  return {
    name: raw.name,
    direction: readString(raw.direction, 'input'),
    asset_type: readString(raw.asset_type),
    required: readBoolean(raw.required),
    description: readString(raw.description),
    tags: readStringArray(raw.tags)
  }
}

function normalizeConfigParam(raw: unknown): PipelineNodeConfigParam | null {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !raw.name) return null
  return {
    name: raw.name,
    type: readString(raw.type, 'string'),
    required: readBoolean(raw.required),
    default: raw.default,
    description: readString(raw.description),
    label: readString(raw.label, raw.name),
    group: readString(raw.group, 'general'),
    placeholder: readString(raw.placeholder),
    secret: readBoolean(raw.secret),
    multiline: readBoolean(raw.multiline),
    advanced: readBoolean(raw.advanced),
    options: readStringArray(raw.options),
    surface: readBoolean(raw.surface)
  }
}

export function normalizePipelineNodeCatalogItem(raw: unknown): PipelineNodeCatalogItem | null {
  if (!isRecord(raw) || typeof raw.node_id !== 'string' || !raw.node_id) return null
  return {
    node_id: raw.node_id,
    name: readString(raw.name, raw.node_id),
    description: readString(raw.description),
    tags: readStringArray(raw.tags),
    input_ports: Array.isArray(raw.input_ports) ? raw.input_ports.flatMap((port) => normalizePort(port) ?? []) : [],
    output_ports: Array.isArray(raw.output_ports) ? raw.output_ports.flatMap((port) => normalizePort(port) ?? []) : [],
    config_schema: Array.isArray(raw.config_schema)
      ? raw.config_schema.flatMap((param) => normalizeConfigParam(param) ?? [])
      : []
  }
}

export async function resolvePipelineApiBase(): Promise<string> {
  try {
    const response = await fetch('/api/v1/plugins/ai-pipeline-bridge/health')
    if (response.ok) {
      const body: unknown = await response.json()
      if (isRecord(body) && typeof body.api_base === 'string' && body.api_base.trim()) {
        return body.api_base.trim().replace(/\/+$/, '')
      }
    }
  } catch {
    // Cherry / Coco 本地透传不一定存在；回落到默认 Pipeline 地址。
  }
  return DEFAULT_PIPELINE_API_BASE
}

export async function fetchPipelineNodeCatalog(force = false): Promise<PipelineNodeCatalogItem[]> {
  const now = Date.now()
  if (!force && catalogCache && now - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.nodes
  }
  if (!force && catalogInFlight) return catalogInFlight

  catalogInFlight = (async () => {
    const base = await resolvePipelineApiBase()
    const response = await fetch(`${base}/api/nodes`)
    if (!response.ok) {
      throw new Error(`pipeline nodes ${response.status}`)
    }
    const body: unknown = await response.json()
    const nodes = Array.isArray(body) ? body.flatMap((item) => normalizePipelineNodeCatalogItem(item) ?? []) : []
    catalogCache = { at: Date.now(), nodes }
    return nodes
  })()

  try {
    return await catalogInFlight
  } finally {
    catalogInFlight = null
  }
}

export function findPipelineNode(nodes: readonly PipelineNodeCatalogItem[], nodeId: string) {
  return nodes.find((node) => node.node_id === nodeId)
}

function isLiteralPort(port: PipelineNodePort): boolean {
  if (port.direction !== 'input') return false
  const assetType = port.asset_type.toLowerCase()
  return (
    assetType.startsWith('data/text') ||
    assetType.startsWith('data/number') ||
    assetType.startsWith('data/boolean') ||
    assetType === 'data/json' ||
    port.tags.includes('prompt') ||
    port.tags.includes('primary')
  )
}

export function getPipelineNodeFormFields(node: PipelineNodeCatalogItem): PipelineNodeFormField[] {
  const ports = node.input_ports.filter(isLiteralPort).map((port) => ({
    key: port.name,
    kind: 'port' as const,
    label: port.name,
    description: port.description,
    required: port.required,
    advanced: false,
    type: port.asset_type.includes('number') ? 'number' : 'string',
    options: [] as string[],
    placeholder: port.required ? '必填；不填则由编排模型补全或提问' : '',
    secret: false,
    multiline: port.tags.includes('prompt') || port.name.toLowerCase().includes('prompt')
  }))

  const configs = node.config_schema
    .filter((param) => !param.secret)
    .map((param) => ({
      key: param.name,
      kind: 'config' as const,
      label: param.label || param.name,
      description: param.description,
      required: param.required,
      advanced: param.advanced || (!param.surface && !param.required),
      type: param.type || 'string',
      options: param.options,
      placeholder: param.placeholder,
      secret: param.secret,
      multiline: param.multiline
    }))

  return [...ports, ...configs]
}

export function serializePipelineNodePrompt(nodeId: string, values: Record<string, unknown>): string {
  const entries = Object.entries(values).filter(([, value]) => {
    if (value == null) return false
    if (typeof value === 'string') return value.trim() !== ''
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return false
    return true
  })
  if (entries.length === 0) return `/${nodeId}`
  return `/${nodeId}${JSON.stringify(Object.fromEntries(entries))}`
}

function replacePropertySeparatorsOutsideStrings(source: string): string {
  let result = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (const char of source) {
    if (quote) {
      result += char
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      result += char
      continue
    }
    result += char === ';' ? ',' : char
  }
  return result
}

function quoteBareKeys(source: string): string {
  return source.replace(/([,{]\s*)([A-Za-z_][\w.-]*)(\s*:)/g, '$1"$2"$3')
}

export function parseLooseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

  const normalized = quoteBareKeys(
    replacePropertySeparatorsOutsideStrings(trimmed.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/×/g, 'x'))
  )

  try {
    const parsed: unknown = JSON.parse(normalized)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function parsePipelineNodePrompt(text: string): { nodeId: string; values: Record<string, unknown> } | null {
  const trimmed = text.trim()
  const match = trimmed.match(/^\/?([A-Za-z][\w.-]*)\s*(\{[\s\S]*\})?\s*$/)
  if (!match) return null
  const nodeId = match[1]
  const objectLiteral = match[2]
  const values = objectLiteral ? (parseLooseJsonObject(objectLiteral) ?? {}) : {}
  return { nodeId, values }
}

export function parsePipelineNodeQuery(searchText: string, nodeId: string): Record<string, unknown> {
  const raw = searchText.trim().replace(/^\//, '')
  if (!raw.startsWith(nodeId)) return {}
  const rest = raw.slice(nodeId.length).trim()
  if (!rest.startsWith('{')) return {}
  return parseLooseJsonObject(rest) ?? {}
}

export function isPipelineNodeTokenPayload(value: unknown): value is PipelineNodeTokenPayload {
  return isRecord(value) && typeof value.nodeId === 'string' && value.nodeId.length > 0 && isRecord(value.values)
}

interface PipelineComposerTokenLike {
  id: string
  kind?: string
  label: string
  promptText?: string
  payload?: unknown
  description?: string
}

export function readPipelineNodeTokenPayload(
  token: Pick<PipelineComposerTokenLike, 'id' | 'label' | 'promptText' | 'payload'>
): PipelineNodeTokenPayload {
  if (isPipelineNodeTokenPayload(token.payload)) return token.payload
  const fromPrompt = token.promptText ? parsePipelineNodePrompt(token.promptText) : null
  if (fromPrompt) return { nodeId: fromPrompt.nodeId, values: fromPrompt.values }
  const fromLabel = parsePipelineNodePrompt(token.label)
  if (fromLabel) return { nodeId: fromLabel.nodeId, values: fromLabel.values }
  const idSuffix = token.id.startsWith(PIPELINE_NODE_TOKEN_ID_PREFIX)
    ? token.id.slice(PIPELINE_NODE_TOKEN_ID_PREFIX.length).split(':')[0]
    : ''
  return { nodeId: idSuffix || token.label.replace(/^\//, ''), values: {} }
}

export function pipelineNodeToComposerToken(
  node: Pick<PipelineNodeCatalogItem, 'node_id' | 'name' | 'description'>,
  values: Record<string, unknown> = {}
): PipelineComposerTokenLike & { kind: typeof PIPELINE_NODE_TOKEN_KIND } {
  const payload: PipelineNodeTokenPayload = { nodeId: node.node_id, values }
  return {
    id: `${PIPELINE_NODE_TOKEN_ID_PREFIX}${node.node_id}:${createComposerSecureRandomId('n')}`,
    kind: PIPELINE_NODE_TOKEN_KIND,
    label: `/${node.node_id}`,
    description: node.name || node.description || node.node_id,
    promptText: serializePipelineNodePrompt(node.node_id, values),
    payload
  }
}

/** Quick-panel row: Chinese title first, `/node.id` command on the right. */
export function pipelineSlashQuickPanelFields(
  node: Pick<PipelineNodeCatalogItem, 'node_id' | 'name' | 'description'>
): { description: string; label: string; slashId: string } {
  const slashId = `/${node.node_id}`
  const label = (node.name || node.description || node.node_id).trim() || node.node_id
  return { description: slashId, label, slashId }
}

export function withPipelineNodeValues(
  token: PipelineComposerTokenLike,
  values: Record<string, unknown>
): Pick<PipelineComposerTokenLike, 'payload' | 'promptText'> {
  const current = readPipelineNodeTokenPayload(token)
  const payload: PipelineNodeTokenPayload = { nodeId: current.nodeId, values }
  return {
    payload,
    promptText: serializePipelineNodePrompt(current.nodeId, values)
  }
}

export const PIPELINE_NODE_CATEGORY_ORDER = [
  'image',
  'video',
  '3d',
  'motion',
  'segmentation',
  'model',
  'workflow',
  'io',
  'interactive',
  'data',
  'other'
] as const

export type PipelineNodeCategoryId = (typeof PIPELINE_NODE_CATEGORY_ORDER)[number]

export interface PipelineNodeCategoryGroup {
  category: PipelineNodeCategoryId
  nodes: PipelineNodeCatalogItem[]
}

function hasAnyToken(haystack: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => haystack.includes(token))
}

export function classifyPipelineNode(
  node: Pick<PipelineNodeCatalogItem, 'node_id' | 'name' | 'tags'>
): PipelineNodeCategoryId {
  const nodeId = node.node_id.toLowerCase()
  const tags = new Set(node.tags.map((tag) => tag.toLowerCase()))
  const haystack = `${nodeId} ${node.name.toLowerCase()} ${[...tags].join(' ')}`

  if (tags.has('workflow') || nodeId.startsWith('workflow.')) return 'workflow'
  if (tags.has('video') || hasAnyToken(haystack, ['video', 'text-to-video', 'image-to-video'])) return 'video'
  if (tags.has('segmentation') || nodeId.includes('segment')) return 'segmentation'
  if (
    tags.has('3d-generation') ||
    tags.has('3d-reconstruction') ||
    tags.has('sam3d') ||
    hasAnyToken(haystack, ['3d', 'glb', 'usd', 'pixal', 'mesh'])
  ) {
    return '3d'
  }
  if (tags.has('kimodo') || tags.has('motion') || nodeId.startsWith('kimodo.') || haystack.includes('motion')) {
    return 'motion'
  }
  if (
    nodeId.startsWith('image.') ||
    hasAnyToken(haystack, ['text-to-image', 'image-to-image', 'image-gen', 'inpaint', 'outpaint'])
  ) {
    return 'image'
  }
  if (nodeId.startsWith('io.') || (tags.has('io') && !tags.has('image'))) return 'io'
  if (tags.has('image')) return 'image'
  if (nodeId.startsWith('model.') || tags.has('model')) return 'model'
  if (tags.has('human-in-the-loop') || nodeId.startsWith('human.') || haystack.includes('approve')) return 'interactive'
  if (tags.has('data') || nodeId.startsWith('data.')) return 'data'
  return 'other'
}

export function groupPipelineNodesByCategory(nodes: readonly PipelineNodeCatalogItem[]): PipelineNodeCategoryGroup[] {
  const buckets = new Map<PipelineNodeCategoryId, PipelineNodeCatalogItem[]>()
  for (const node of nodes) {
    const category = classifyPipelineNode(node)
    const group = buckets.get(category)
    if (group) group.push(node)
    else buckets.set(category, [node])
  }
  return PIPELINE_NODE_CATEGORY_ORDER.flatMap((category) => {
    const groupedNodes = buckets.get(category)
    return groupedNodes?.length ? [{ category, nodes: groupedNodes }] : []
  })
}

const HIDDEN_PIPELINE_NODE_FILTER_TAGS = new Set(['primary', 'secondary', 'prompt', 'advanced', 'file', 'asset', 'api'])

export interface PipelineNodeTagFilter {
  tag: string
  count: number
  nodes: PipelineNodeCatalogItem[]
}

export function isPipelineNodeFilterTag(tag: string): boolean {
  const normalized = tag.trim().toLowerCase()
  return Boolean(normalized) && !HIDDEN_PIPELINE_NODE_FILTER_TAGS.has(normalized) && !normalized.includes(':')
}

export function collectPipelineNodeFilterTags(nodes: readonly PipelineNodeCatalogItem[]): PipelineNodeTagFilter[] {
  const buckets = new Map<string, PipelineNodeCatalogItem[]>()
  for (const node of nodes) {
    const seen = new Set<string>()
    for (const raw of node.tags) {
      const tag = raw.trim().toLowerCase()
      if (!isPipelineNodeFilterTag(tag) || seen.has(tag)) continue
      seen.add(tag)
      const list = buckets.get(tag)
      if (list) list.push(node)
      else buckets.set(tag, [node])
    }
  }
  return [...buckets.entries()]
    .map(([tag, taggedNodes]) => ({ tag, count: taggedNodes.length, nodes: taggedNodes }))
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag))
}

export const PIPELINE_TEXT_TO_IMAGE_NODE_ID = 'model.text-to-image'
export const PIPELINE_IMAGE_TO_IMAGE_NODE_ID = 'model.image-to-image'

export function resolvePipelineNodeIdForAttachments(nodeId: string, hasImageAttachment: boolean): string {
  return hasImageAttachment && nodeId === PIPELINE_TEXT_TO_IMAGE_NODE_ID ? PIPELINE_IMAGE_TO_IMAGE_NODE_ID : nodeId
}

const FEATURED_PRESET_ALIASES = ['nano-banana-pro', 'gpt-image-2', 'nano-banana-2'] as const

export interface PipelineModelPreset {
  id: string
  nodeId: string
  alias: string
  slashId: string
  displayName: string
  model: string
  providerId: string
  providerName: string
  values?: Record<string, unknown>
  featured: boolean
}

export function pipelinePresetSlashQuickPanelFields(preset: Pick<PipelineModelPreset, 'displayName' | 'slashId'>): {
  description: string
  label: string
} {
  return {
    description: preset.slashId,
    label: preset.displayName.trim() || preset.slashId
  }
}

export interface PipelineProviderCatalog {
  id: string
  name: string
  enabled: boolean
  imageModels: string[]
}

export interface PipelinePresetProviderInput {
  id: string
  name: string
  enabled: boolean
}

export interface PipelinePresetModelInput {
  providerId: string
  modelId: string
}

let presetCache: { at: number; presets: PipelineModelPreset[] } | null = null
let presetInFlight: Promise<PipelineModelPreset[]> | null = null

function stripModelGatewaySuffix(modelId: string): string {
  return modelId.replace(/@[^@]+$/, '').trim()
}

export function slugifyPipelinePresetAlias(modelId: string): string {
  const base = stripModelGatewaySuffix(modelId).toLowerCase()
  return base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model'
}

export function displayNameForPipelineModel(modelId: string): string {
  return stripModelGatewaySuffix(modelId).replace(/[-_]+/g, ' ')
}

function uniquePresetAlias(base: string, providerId: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  const providerSlug = slugifyPipelinePresetAlias(providerId.replace(/^coco-/, ''))
  let alias = `${base}-${providerSlug}`
  let suffix = 2
  while (used.has(alias)) {
    alias = `${base}-${providerSlug}-${suffix}`
    suffix += 1
  }
  used.add(alias)
  return alias
}

export function pickFeaturedPipelinePresets(presets: readonly PipelineModelPreset[]): PipelineModelPreset[] {
  const featured: PipelineModelPreset[] = []
  const seenModels = new Set<string>()
  const consider = (preset: PipelineModelPreset) => {
    if (preset.nodeId !== PIPELINE_TEXT_TO_IMAGE_NODE_ID) return
    const modelKey = slugifyPipelinePresetAlias(preset.model)
    if (seenModels.has(modelKey)) return
    seenModels.add(modelKey)
    featured.push(preset)
  }

  for (const wanted of FEATURED_PRESET_ALIASES) {
    const wantedSlug = slugifyPipelinePresetAlias(wanted)
    const match = presets.find((preset) => slugifyPipelinePresetAlias(preset.model) === wantedSlug)
    if (match) consider(match)
  }
  for (const preset of presets) consider(preset)
  return featured
}

export interface PipelineImageModelChoice {
  model: string
  providerId: string
  providerName: string
  label: string
}

export function pipelineImageModelChoiceValue(choice: Pick<PipelineImageModelChoice, 'providerId' | 'model'>): string {
  return `${choice.providerId}::${choice.model}`
}

export function pipelineImageModelChoices(
  presets: readonly PipelineModelPreset[],
  nodeId: string
): PipelineImageModelChoice[] {
  const relevant = presets.filter((preset) => preset.nodeId === nodeId)
  const usage = new Map<string, number>()
  for (const preset of relevant) {
    const key = preset.model.toLowerCase()
    usage.set(key, (usage.get(key) ?? 0) + 1)
  }

  const seen = new Set<string>()
  const choices: PipelineImageModelChoice[] = []
  for (const preset of relevant) {
    const key = `${preset.providerId}:${preset.model}`
    if (seen.has(key)) continue
    seen.add(key)
    const duplicated = (usage.get(preset.model.toLowerCase()) ?? 0) > 1
    choices.push({
      model: preset.model,
      providerId: preset.providerId,
      providerName: preset.providerName,
      label: duplicated ? `${preset.model} · ${preset.providerName}` : preset.model
    })
  }
  return choices
}

export function findPipelineImageModelChoice(
  choices: readonly PipelineImageModelChoice[],
  model: unknown,
  providerId: unknown
): PipelineImageModelChoice | undefined {
  const modelId = typeof model === 'string' ? model : ''
  if (!modelId) return undefined
  const provider = typeof providerId === 'string' ? providerId : ''
  if (provider) {
    const exact = choices.find((choice) => choice.providerId === provider && choice.model === modelId)
    if (exact) return exact
  }
  return choices.find((choice) => choice.model === modelId)
}

export function groupCherryImageModelsForPipelinePresets(
  providers: readonly PipelinePresetProviderInput[],
  models: readonly PipelinePresetModelInput[]
): PipelineProviderCatalog[] {
  const imageModels = new Map<string, string[]>()
  for (const model of models) {
    const modelId = model.modelId.trim()
    if (!modelId) continue
    const list = imageModels.get(model.providerId)
    if (list) {
      if (!list.includes(modelId)) list.push(modelId)
    } else {
      imageModels.set(model.providerId, [modelId])
    }
  }

  return providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    enabled: provider.enabled,
    imageModels: imageModels.get(provider.id) ?? []
  }))
}

export function buildPipelineModelPresets(
  providers: readonly PipelineProviderCatalog[],
  availableNodeIds?: ReadonlySet<string>
): PipelineModelPreset[] {
  const textToImageAvailable = !availableNodeIds || availableNodeIds.has(PIPELINE_TEXT_TO_IMAGE_NODE_ID)
  const imageToImageAvailable = !availableNodeIds || availableNodeIds.has(PIPELINE_IMAGE_TO_IMAGE_NODE_ID)
  if (!textToImageAvailable && !imageToImageAvailable) return []

  const modelUsage = new Map<string, number>()
  for (const provider of providers) {
    if (!provider.enabled) continue
    for (const model of provider.imageModels) {
      const key = stripModelGatewaySuffix(model).toLowerCase()
      modelUsage.set(key, (modelUsage.get(key) ?? 0) + 1)
    }
  }

  const presets: PipelineModelPreset[] = []

  const appendPresets = (nodeId: string, label: string, acceptsProvider: (providerId: string) => boolean) => {
    const usedAliases = new Set<string>()
    for (const provider of providers) {
      if (!provider.enabled || !acceptsProvider(provider.id)) continue
      for (const model of provider.imageModels) {
        if (!model.trim()) continue
        const alias = uniquePresetAlias(slugifyPipelinePresetAlias(model), provider.id, usedAliases)
        const duplicated = (modelUsage.get(stripModelGatewaySuffix(model).toLowerCase()) ?? 0) > 1
        const modelName = duplicated
          ? `${displayNameForPipelineModel(model)} · ${provider.name}`
          : displayNameForPipelineModel(model)
        presets.push({
          id: `${provider.id}:${model}:${nodeId}`,
          nodeId,
          alias,
          slashId: `/${nodeId}.${alias}`,
          displayName: `${label} · ${modelName}`,
          model,
          providerId: provider.id,
          providerName: provider.name,
          ...(nodeId === PIPELINE_IMAGE_TO_IMAGE_NODE_ID ? { values: { size: 'auto' } } : {}),
          featured: false
        })
      }
    }
  }

  if (textToImageAvailable) appendPresets(PIPELINE_TEXT_TO_IMAGE_NODE_ID, '文生图', () => true)
  if (imageToImageAvailable) {
    // 当前只有 VAPI 内建图片模型明确提供 /v1/images/edits；不要把欠费或仅
    // generations 可用的其它 Provider 自动伪装成图生图预设。
    appendPresets(PIPELINE_IMAGE_TO_IMAGE_NODE_ID, '图生图', (providerId) => providerId === 'coco-vapi')
  }

  const featuredIds = new Set(pickFeaturedPipelinePresets(presets).map((preset) => preset.id))
  return presets.map((preset) => ({ ...preset, featured: featuredIds.has(preset.id) }))
}

function normalizeProviderCatalog(raw: unknown): PipelineProviderCatalog | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null
  const models = isRecord(raw.models) ? raw.models : {}
  return {
    id: raw.id,
    name: readString(raw.name, raw.id),
    enabled: readBoolean(raw.enabled, true),
    imageModels: readStringArray(models.image)
  }
}

export async function fetchPipelineModelPresets(force = false): Promise<PipelineModelPreset[]> {
  const now = Date.now()
  if (!force && presetCache && now - presetCache.at < CATALOG_TTL_MS) {
    return presetCache.presets
  }
  if (!force && presetInFlight) return presetInFlight

  presetInFlight = (async () => {
    const base = await resolvePipelineApiBase()
    const response = await fetch(`${base}/api/model-providers`)
    if (!response.ok) {
      throw new Error(`pipeline providers ${response.status}`)
    }
    const body: unknown = await response.json()
    const providers = Array.isArray(body) ? body.flatMap((item) => normalizeProviderCatalog(item) ?? []) : []

    let nodeIds: ReadonlySet<string> | undefined
    try {
      const nodes = await fetchPipelineNodeCatalog()
      nodeIds = new Set(nodes.map((node) => node.node_id))
    } catch {
      nodeIds = undefined
    }

    const presets = buildPipelineModelPresets(providers, nodeIds)
    presetCache = { at: Date.now(), presets }
    return presets
  })()

  try {
    return await presetInFlight
  } finally {
    presetInFlight = null
  }
}
