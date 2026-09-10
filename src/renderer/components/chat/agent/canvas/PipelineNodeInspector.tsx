import { Button } from '@cherrystudio/ui'
import { usePipelineModelPresets } from '@renderer/components/composer/tokenView'
import type { CanvasDag, CanvasDagNode } from '@renderer/utils/cocoSessionCanvas'
import { incomingEdge } from '@renderer/utils/cocoSessionCanvas'
import type {
  PipelineImageModelChoice,
  PipelineNodeCatalogItem,
  PipelineNodeFormField
} from '@renderer/utils/pipelineNodes'
import {
  findPipelineImageModelChoice,
  getPipelineNodeFormFields,
  pipelineImageModelChoices,
  pipelineImageModelChoiceValue
} from '@renderer/utils/pipelineNodes'
import { cn } from '@renderer/utils/style'
import { ChevronDown, ChevronRight, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { canvasPortColor } from './canvasTheme'

export interface CanvasOutputOption {
  value: string
  sourceStep: string
  sourcePort: string
}

const CONTROL_CLASS_NAME =
  'h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:border-primary disabled:opacity-60'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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

function isNumericField(field: PipelineNodeFormField): boolean {
  return field.type === 'number' || field.type === 'float' || field.type === 'int' || field.type === 'integer'
}

export function parseFieldInput(field: PipelineNodeFormField, raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (isNumericField(field)) {
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : trimmed
  }
  if (field.type === 'boolean') {
    if (trimmed === 'true' || trimmed === '1') return true
    if (trimmed === 'false' || trimmed === '0') return false
  }
  return raw
}

function readPortValues(config: Record<string, unknown>): Record<string, unknown> {
  return isRecord(config._port_values) ? { ...config._port_values } : {}
}

export function fieldValue(node: CanvasDagNode, field: PipelineNodeFormField): unknown {
  if (field.kind === 'port') {
    // PipelineDAG stores literal input values directly in node.config (for
    // example config.prompt). Fall back to the legacy canvas-only _port_values
    // shape so previously saved manual edits stay readable.
    if (Object.prototype.hasOwnProperty.call(node.config, field.key)) return node.config[field.key]
    return readPortValues(node.config)[field.key]
  }
  return node.config[field.key]
}

export function withFieldValue(
  node: CanvasDagNode,
  field: PipelineNodeFormField,
  value: unknown
): Record<string, unknown> {
  const config = { ...node.config }
  if (value === undefined) delete config[field.key]
  else config[field.key] = value
  if (field.kind !== 'port') return config

  // Drop the obsolete canvas-only copy while preserving other legacy values
  // until those fields get edited too.
  const ports = readPortValues(config)
  delete ports[field.key]
  if (Object.keys(ports).length === 0) delete config._port_values
  else config._port_values = ports
  return config
}

function InspectorField({
  disabled,
  field,
  onChange,
  value,
  imageModelChoices,
  providerId
}: {
  disabled: boolean
  field: PipelineNodeFormField
  onChange: (value: unknown) => void
  value: unknown
  imageModelChoices?: readonly PipelineImageModelChoice[]
  providerId?: unknown
}) {
  const inputValue = fieldValueToInput(value)

  if (field.key === 'model' && imageModelChoices && imageModelChoices.length > 0) {
    const selected = findPipelineImageModelChoice(imageModelChoices, value, providerId)
    const selectValue = selected ? pipelineImageModelChoiceValue(selected) : inputValue
    return (
      <select
        className={CONTROL_CLASS_NAME}
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
        <option value="">{field.required ? '—' : ''}</option>
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
        className={CONTROL_CLASS_NAME}
        disabled={disabled}
        value={inputValue}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}>
        <option value="">{field.required ? '—' : ''}</option>
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
        className={cn(CONTROL_CLASS_NAME, 'min-h-16 resize-y py-1.5')}
        disabled={disabled}
        placeholder={field.placeholder}
        value={inputValue}
        onChange={(event) => onChange(parseFieldInput(field, event.target.value))}
      />
    )
  }

  return (
    <input
      className={CONTROL_CLASS_NAME}
      disabled={disabled}
      placeholder={field.placeholder}
      type={isNumericField(field) ? 'number' : 'text'}
      value={inputValue}
      onChange={(event) => onChange(parseFieldInput(field, event.target.value))}
    />
  )
}

function FieldLabel({ field }: { field: PipelineNodeFormField }) {
  return (
    <span className="text-[11px] text-muted-foreground" title={field.description}>
      {field.label}
      {field.required ? <span className="ml-1 text-warning">*</span> : null}
    </span>
  )
}

interface PipelineNodeInspectorProps {
  graph: CanvasDag
  node: CanvasDagNode | undefined
  onClose: () => void
  onConfigChange: (stepId: string, config: Record<string, unknown>) => void
  onConnect: (option: CanvasOutputOption, targetStep: string, targetPort: string) => void
  onDisconnect: (targetStep: string, targetPort: string) => void
  onRemove: (stepId: string) => void
  outputOptions: readonly CanvasOutputOption[]
  readOnly: boolean
  spec: PipelineNodeCatalogItem | null
}

export function PipelineNodeInspector({
  graph,
  node,
  onClose,
  onConfigChange,
  onConnect,
  onDisconnect,
  onRemove,
  outputOptions,
  readOnly,
  spec
}: PipelineNodeInspectorProps) {
  const { t } = useTranslation()
  const [showAdvanced, setShowAdvanced] = useState(false)
  const { presets } = usePipelineModelPresets(Boolean(spec))
  const imageModelChoices = spec ? pipelineImageModelChoices(presets, spec.node_id) : []
  const fields = useMemo(() => (spec ? getPipelineNodeFormFields(spec) : []), [spec])
  const visibleFields = useMemo(
    () => fields.filter((field) => !(field.key === 'provider_id' && imageModelChoices.length > 0)),
    [fields, imageModelChoices.length]
  )
  const literalPortKeys = useMemo(
    () => new Set(visibleFields.filter((field) => field.kind === 'port').map((field) => field.key)),
    [visibleFields]
  )
  const basicFields = visibleFields.filter((field) => !field.advanced)
  const advancedFields = visibleFields.filter((field) => field.advanced)

  const applyFieldValue = (field: PipelineNodeFormField, value: unknown) => {
    if (!node) return
    if (
      field.key === 'model' &&
      imageModelChoices.length > 0 &&
      value &&
      typeof value === 'object' &&
      'model' in value &&
      'providerId' in value
    ) {
      const choice = value as PipelineImageModelChoice
      const withModel = withFieldValue(node, field, choice.model)
      onConfigChange(node.step_id, {
        ...withModel,
        provider_id: choice.providerId
      })
      return
    }
    if (field.key === 'model' && imageModelChoices.length > 0 && (value === undefined || value === '')) {
      const config = withFieldValue(node, field, undefined)
      delete config.provider_id
      onConfigChange(node.step_id, config)
      return
    }
    onConfigChange(node.step_id, withFieldValue(node, field, value))
  }

  const renderFields = (list: readonly PipelineNodeFormField[]) =>
    list.map((field) => {
      if (!node) return null
      if (field.kind === 'port' && incomingEdge(graph, node.step_id, field.key)) return null
      return (
        <label key={`${field.kind}:${field.key}`} className="flex flex-col gap-1">
          <FieldLabel field={field} />
          <InspectorField
            disabled={readOnly}
            field={field}
            imageModelChoices={imageModelChoices}
            providerId={node.config.provider_id}
            value={fieldValue(node, field)}
            onChange={(value) => applyFieldValue(field, value)}
          />
        </label>
      )
    })

  return (
    <aside
      className="flex h-full min-h-0 w-64 shrink-0 flex-col border-border border-l bg-card/40"
      data-testid="canvas-inspector">
      <div className="flex min-h-9 shrink-0 items-center gap-1 border-border border-b px-2">
        <span className="min-w-0 flex-1 truncate font-medium text-xs">
          {t('library.config.agent.coco.canvas.inspector')}
        </span>
        {node && !readOnly ? (
          <Button
            aria-label={t('library.config.agent.coco.canvas.delete')}
            className="h-6 px-1.5 text-destructive"
            data-testid="canvas-inspector-delete"
            size="sm"
            title={t('library.config.agent.coco.canvas.delete')}
            variant="ghost"
            onClick={() => onRemove(node.step_id)}>
            <Trash2 size={13} />
          </Button>
        ) : null}
        <Button aria-label={t('common.close')} className="h-6 px-1.5" size="sm" variant="ghost" onClick={onClose}>
          <X size={13} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2.5">
        {!node ? (
          <p className="text-[11px] text-muted-foreground">{t('library.config.agent.coco.canvas.no_selection')}</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">{t('library.config.agent.coco.canvas.step_id')}</span>
              <input className={cn(CONTROL_CLASS_NAME, 'bg-muted/40')} disabled value={node.step_id} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">{t('library.config.agent.coco.canvas.node_id')}</span>
              <input className={cn(CONTROL_CLASS_NAME, 'bg-muted/40')} disabled value={node.node_id} />
            </label>

            {(spec?.input_ports ?? []).map((port) => {
              const wired = incomingEdge(graph, node.step_id, port.name)
              // A literal text/number port keeps its own editor below. Only swap
              // in the source selector once the port is actually wired.
              if (literalPortKeys.has(port.name) && !wired) return null
              return (
                <label key={port.name} className="flex flex-col gap-1">
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: canvasPortColor(port.asset_type) }}
                    />
                    <span className="min-w-0 truncate" title={port.asset_type}>
                      {port.name}
                    </span>
                    {port.required ? <span className="text-warning">*</span> : null}
                  </span>
                  <select
                    className={CONTROL_CLASS_NAME}
                    disabled={readOnly}
                    value={wired ? `${wired.source_step}.${wired.source_port}` : ''}
                    onChange={(event) => {
                      const value = event.target.value
                      if (!value) {
                        onDisconnect(node.step_id, port.name)
                        return
                      }
                      const option = outputOptions.find((item) => item.value === value)
                      if (option) onConnect(option, node.step_id, port.name)
                    }}>
                    <option value="">{t('library.config.agent.coco.canvas.literal')}</option>
                    {outputOptions
                      .filter((option) => option.sourceStep !== node.step_id)
                      .map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.value}
                        </option>
                      ))}
                  </select>
                </label>
              )
            })}

            {renderFields(basicFields)}

            {advancedFields.length > 0 ? (
              <div className="flex flex-col gap-2.5">
                <button
                  aria-expanded={showAdvanced}
                  className="-mx-1 flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-background/60"
                  type="button"
                  onClick={() => setShowAdvanced((current) => !current)}>
                  {showAdvanced ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  {t('chat.input.pipeline_nodes.advanced')}
                  <span className="text-[9px]">({advancedFields.length})</span>
                </button>
                {showAdvanced ? renderFields(advancedFields) : null}
              </div>
            ) : null}

            {!spec ? (
              <p className="text-[11px] text-muted-foreground">{t('library.config.agent.coco.canvas.unknown_node')}</p>
            ) : null}
            {readOnly ? (
              <p className="text-[11px] text-muted-foreground">{t('library.config.agent.coco.canvas.read_only')}</p>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  )
}
