import { cn } from '@cherrystudio/ui/lib/utils'
import { useModels } from '@renderer/hooks/useModel'
import { useProviders } from '@renderer/hooks/useProvider'
import { getRawModelId, isGenerateImageModel } from '@renderer/utils/model'
import type {
  PipelineImageModelChoice,
  PipelineNodeCatalogItem,
  PipelineNodeFormField
} from '@renderer/utils/pipelineNodes'
import {
  buildPipelineModelPresets,
  fetchPipelineNodeCatalog,
  findPipelineImageModelChoice,
  findPipelineNode,
  getPipelineNodeFormFields,
  groupCherryImageModelsForPipelinePresets,
  PIPELINE_IMAGE_TO_IMAGE_NODE_ID,
  PIPELINE_TEXT_TO_IMAGE_NODE_ID,
  pipelineImageModelChoices,
  pipelineImageModelChoiceValue,
  readPipelineNodeTokenPayload
} from '@renderer/utils/pipelineNodes'
import { MODEL_CAPABILITY } from '@shared/data/types/model'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ChatTokenView } from '../chatTokenView'

function fieldValueToInput(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function parseFieldInput(field: PipelineNodeFormField, raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (field.type === 'number' || field.type === 'float' || field.type === 'int' || field.type === 'integer') {
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : trimmed
  }
  if (field.type === 'boolean') {
    if (trimmed === 'true' || trimmed === '1') return true
    if (trimmed === 'false' || trimmed === '0') return false
  }
  if (field.type === 'json' || field.type === 'object') {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed
    }
  }
  return raw
}

function PipelineNodeFieldControl({
  field,
  value,
  disabled,
  onChange,
  imageModelChoices,
  providerId
}: {
  field: PipelineNodeFormField
  value: unknown
  disabled: boolean
  onChange: (value: unknown) => void
  imageModelChoices?: readonly PipelineImageModelChoice[]
  providerId?: unknown
}) {
  const inputValue = fieldValueToInput(value)
  const controlClassName =
    'h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:border-primary'

  if (field.key === 'model' && imageModelChoices && imageModelChoices.length > 0) {
    const selected = findPipelineImageModelChoice(imageModelChoices, value, providerId)
    const selectValue = selected ? pipelineImageModelChoiceValue(selected) : inputValue
    return (
      <select
        className={controlClassName}
        data-testid="pipeline-node-model-select"
        disabled={disabled}
        value={selectValue}
        onChange={(event) => {
          const next = event.target.value
          if (!next) {
            onChange(undefined)
            return
          }
          const choice = imageModelChoices.find((item) => pipelineImageModelChoiceValue(item) === next)
          onChange(choice ?? next)
        }}>
        <option value="">{field.required ? '—' : '（默认）'}</option>
        {inputValue && !selected ? <option value={inputValue}>{inputValue}</option> : null}
        {imageModelChoices.map((choice) => {
          const optionValue = pipelineImageModelChoiceValue(choice)
          return (
            <option key={optionValue} value={optionValue}>
              {choice.label}
            </option>
          )
        })}
      </select>
    )
  }

  if (field.options.length > 0) {
    return (
      <select
        className={controlClassName}
        disabled={disabled}
        value={inputValue}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}>
        <option value="">{field.required ? '—' : '（默认）'}</option>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    )
  }

  if (field.multiline) {
    return (
      <textarea
        className={cn(controlClassName, 'min-h-16 resize-y py-1.5')}
        disabled={disabled}
        placeholder={field.placeholder}
        value={inputValue}
        onChange={(event) => onChange(parseFieldInput(field, event.target.value))}
      />
    )
  }

  return (
    <input
      className={controlClassName}
      disabled={disabled}
      placeholder={field.placeholder}
      type={field.type === 'number' || field.type === 'float' || field.type === 'int' ? 'number' : 'text'}
      value={inputValue}
      onChange={(event) => onChange(parseFieldInput(field, event.target.value))}
    />
  )
}

export function PipelineNodeParamForm({
  token,
  node,
  disabled,
  onValuesChange
}: {
  token: ChatTokenView
  node: PipelineNodeCatalogItem | null
  disabled?: boolean
  onValuesChange?: (values: Record<string, unknown>) => void
}) {
  const { t } = useTranslation()
  const wantsImageModels =
    node?.node_id === PIPELINE_TEXT_TO_IMAGE_NODE_ID || node?.node_id === PIPELINE_IMAGE_TO_IMAGE_NODE_ID
  const { presets } = usePipelineModelPresets(Boolean(wantsImageModels))
  const payload = readPipelineNodeTokenPayload(token)
  const imageModelChoices = node ? pipelineImageModelChoices(presets, node.node_id) : []
  const fields = (node ? getPipelineNodeFormFields(node) : []).filter(
    (field) => !(field.key === 'provider_id' && imageModelChoices.length > 0)
  )
  const primaryFields = fields.filter((field) => !field.advanced)
  const advancedFields = fields.filter((field) => field.advanced)

  const commit = (patch: Record<string, unknown>) => {
    const next = { ...payload.values }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    onValuesChange?.(next)
  }

  const commitField = (key: string, value: unknown) => {
    if (
      key === 'model' &&
      imageModelChoices.length > 0 &&
      value &&
      typeof value === 'object' &&
      'model' in value &&
      'providerId' in value
    ) {
      const choice = value as PipelineImageModelChoice
      commit({ model: choice.model, provider_id: choice.providerId })
      return
    }
    if (key === 'model' && imageModelChoices.length > 0 && (value === undefined || value === '')) {
      commit({ model: undefined, provider_id: undefined })
      return
    }
    commit({ [key]: value })
  }

  return (
    <div
      className="flex w-80 max-w-[calc(100vw-32px)] flex-col gap-2 p-3"
      data-pipeline-node-params=""
      onKeyDown={(event) => event.stopPropagation()}
      onKeyDownCapture={(event) => event.stopPropagation()}>
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground text-xs">{token.label}</div>
        <div className="truncate text-[11px] text-muted-foreground">{node?.name || token.description}</div>
      </div>
      {primaryFields.map((field) => (
        <label key={field.key} className="flex flex-col gap-1">
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {field.label}
            {field.required ? (
              <span className="text-destructive">{t('chat.input.pipeline_nodes.required')}</span>
            ) : null}
          </span>
          <PipelineNodeFieldControl
            disabled={Boolean(disabled)}
            field={field}
            imageModelChoices={imageModelChoices}
            providerId={payload.values.provider_id}
            value={payload.values[field.key]}
            onChange={(value) => commitField(field.key, value)}
          />
        </label>
      ))}
      {advancedFields.length > 0 ? (
        <details className="rounded-md border border-border-subtle px-2 py-1">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            {t('chat.input.pipeline_nodes.advanced')}
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {advancedFields.map((field) => (
              <label key={field.key} className="flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">{field.label}</span>
                <PipelineNodeFieldControl
                  disabled={Boolean(disabled)}
                  field={field}
                  imageModelChoices={imageModelChoices}
                  providerId={payload.values.provider_id}
                  value={payload.values[field.key]}
                  onChange={(value) => commitField(field.key, value)}
                />
              </label>
            ))}
          </div>
        </details>
      ) : null}
      <p className="m-0 text-[11px] leading-4 text-muted-foreground">{t('chat.input.pipeline_nodes.empty_hint')}</p>
    </div>
  )
}

export function usePipelineNodeCatalogItem(nodeId: string | undefined) {
  const [node, setNode] = useState<PipelineNodeCatalogItem | null>(null)

  useEffect(() => {
    if (!nodeId) return
    let cancelled = false
    void fetchPipelineNodeCatalog()
      .then((nodes) => {
        if (!cancelled) setNode(findPipelineNode(nodes, nodeId) ?? null)
      })
      .catch(() => {
        if (!cancelled) setNode(null)
      })
    return () => {
      cancelled = true
    }
  }, [nodeId])

  return node
}

export function usePipelineNodeCatalog(enabled: boolean) {
  const [nodes, setNodes] = useState<PipelineNodeCatalogItem[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void fetchPipelineNodeCatalog()
      .then((next) => {
        if (cancelled) return
        setNodes(next)
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        setNodes([])
        setError('load_failed')
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  return useMemo(() => ({ nodes, error }), [error, nodes])
}

export function usePipelineModelPresets(enabled: boolean) {
  const { nodes, error: nodesError } = usePipelineNodeCatalog(enabled)
  const { providers } = useProviders({ enabled: true }, { enabled })
  const { models } = useModels(
    { capability: MODEL_CAPABILITY.IMAGE_GENERATION, enabled: true },
    { fetchEnabled: enabled }
  )

  const presets = useMemo(() => {
    if (!enabled) return []
    const catalog = groupCherryImageModelsForPipelinePresets(
      providers.map((provider) => ({ id: provider.id, name: provider.name, enabled: provider.isEnabled })),
      models.flatMap((model) => {
        if (!model.isEnabled || model.isHidden || !isGenerateImageModel(model)) return []
        const modelId = getRawModelId(model).trim()
        return modelId ? [{ providerId: model.providerId, modelId }] : []
      })
    )
    const nodeIds = nodes.length > 0 ? new Set(nodes.map((node) => node.node_id)) : undefined
    return buildPipelineModelPresets(catalog, nodeIds)
  }, [enabled, models, nodes, providers])

  return useMemo(() => ({ presets, error: nodesError }), [nodesError, presets])
}
